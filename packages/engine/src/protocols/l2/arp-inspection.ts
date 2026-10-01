/**
 * protocols/l2/arp-inspection.ts — the dynamic ARP inspection decision (ARCHITECTURE-P3 D13, §3.0 (b) "eth-switch
 * steps 7b/7c", §3.4 steps 6–8, §4.3, §4.5, §5.3).
 *
 * eth-switch runs step 7c in its VLAN-aware per-frame path, after port security (step 7) and step 7b, for an ARP whose
 * VLAN is inspected; it keeps the per-port rate windows and the per-VLAN log windows, and writes the `arp-inspection`
 * table. This module holds the pure pieces, in the port-security pattern:
 *
 *  • `readArpInspection(config)` — the §5.3 lines: `ip arp inspection vlan <list>` (each stored line kept with its
 *    tokens) and per interface `ip arp inspection trust` and `ip arp inspection limit rate <pps> [burst interval <s>]`
 *    or `ip arp inspection limit none`. ([S14] ARP ACLs and `validate` are not approved, so `droppedAcl` stays 0.)
 *  • `arpInspectionLimit(cfg, port)` — the effective limit: the configured one; else 15 packets per second on an
 *    untrusted port and none on a trusted one. A limit of N pps with a burst interval of S s allows N·S packets in
 *    windows of S seconds aligned to sim time (`rate-window.ts`).
 *  • `decideArpInspection(check)` — for an ARP arriving on logical port L in inspected VLAN V:
 *      1. a limit on L: count the ARP in L's window; more than allowed → err-disable L (`arp-inspection`) and drop it;
 *      2. a trusted L → forwarded, not inspected (no row write);
 *      3. an untrusted L → valid when a `dhcp-snooping` binding (V, sender MAC) exists, unexpired, with IP = sender IP
 *         and port = L (requiring the port to match is a listed deviation) → forwarded (`forwarded + 1`); otherwise
 *         dropped `arp-inspection` (`dropped + 1`, `droppedNoBinding + 1`), with a severity-4 log (facility `DAI`) while
 *         V's log window holds at most 5 lines in its second (§3.4 step 6).
 *  • `applyArpInspectionVerdict(prev, vlan, verdict, now)` — the VLAN's row after a verdict: one write per ARP inspected
 *    on an untrusted port; undefined (no write) otherwise.
 *
 * Wording is original. Debug lines use the category `ip arp inspection` (§5.8). Integer only. Pure: no state, no I/O,
 * no clock, no randomness.
 */
import { normalizeMac } from '../../contracts/addr.js';
import type { Ipv4Address, MacAddress } from '../../contracts/addr.js';
import type { ConfigAst } from '../../contracts/config.js';
import type { PortId } from '../../contracts/ids.js';
import type { ErrDisableCause } from '../../contracts/port.js';
import { ARP_OP_REPLY, ARP_OP_REQUEST } from '../../contracts/pdu.js';
import type { LayerView, PduView } from '../../contracts/pdu.js';
import type { DropRule, Severity } from '../../contracts/process.js';
import { vlanKey } from '../../contracts/tables.js';
import type { ArpInspectionRow, DhcpSnoopingRow } from '../../contracts/tables.js';
import { SEC } from '../../contracts/time.js';
import type { SimTime } from '../../contracts/time.js';
import { configTextLinesOf } from '../../cli/config-text.js';
import { dhcpSnoopingKey, parseSnoopingVlanTokens, vlanLineFor } from './dhcp-snooping.js';
import type { SnoopingVlanLine } from './dhcp-snooping.js';
import { countInRateWindow, rateExceeded } from './rate-window.js';
import type { RateWindow } from './rate-window.js';
import { interfaceOfContext } from './switchport-config.js';

/** Debug category of DAI messages (§5.8: the `debug ip arp inspection` tokens). */
export const ARP_INSPECTION_DEBUG_CATEGORY = 'ip arp inspection';
/** Syslog facility of DAI messages (§3.4 step 6). */
export const ARP_INSPECTION_LOG_FACILITY = 'DAI';
/** Severity of the invalid-ARP log (§3.4 step 6). */
export const ARP_INSPECTION_LOG_SEVERITY: Severity = 4;
/** At most this many invalid-ARP log lines per VLAN per second (D13). */
export const ARP_INSPECTION_LOG_LINES_PER_SECOND = 5;
/** The default limit of an untrusted port, packets per second (D13). */
export const ARP_INSPECTION_DEFAULT_RATE_PPS = 15;
/** Highest accepted `ip arp inspection limit rate` (packets per second). */
export const ARP_INSPECTION_RATE_MAX = 2048;
/** Highest accepted `burst interval` (seconds). */
export const ARP_INSPECTION_BURST_MAX_S = 15;
/** The err-disable cause of the rate limit (D13). */
export const ARP_INSPECTION_ERR_DISABLE_CAUSE: ErrDisableCause = 'arp-inspection';

// ── configuration ─────────────────────────────────────────────────────────────────────────────────────────────

/** A configured limit: `limit rate <pps> [burst interval <s>]` (burstS 1 when omitted) or `limit none`. */
export type ArpInspectionLimitSetting = { readonly pps: number; readonly burstS: number } | 'none';

/** The DAI lines of one interface (only interfaces with at least one of them are listed). */
export interface ArpInspectionPortConfig {
  readonly port: PortId;
  /** `ip arp inspection trust`. */
  readonly trusted: boolean;
  /** `ip arp inspection limit …`; absent = the default (15 pps untrusted, none trusted). */
  readonly limit?: ArpInspectionLimitSetting;
  /** The stored limit line's tokens (with `limit`). */
  readonly limitLine?: readonly string[];
}

/** Everything step 7c reads from the running configuration. */
export interface ArpInspectionConfig {
  /** `ip arp inspection vlan <list>` lines, in configuration order (the union of their VLANs is inspected). */
  readonly vlanLines: readonly SnoopingVlanLine[];
  /** Per-interface lines, in configuration order. */
  readonly ports: readonly ArpInspectionPortConfig[];
}

/** A decimal integer token within [lo, hi], or undefined. */
function intToken(t: string | undefined, lo: number, hi: number): number | undefined {
  if (t === undefined || !/^\d{1,10}$/.test(t)) return undefined;
  const n = Number(t);
  return n >= lo && n <= hi ? n : undefined;
}

const isDai = (t: readonly string[]): boolean => t[0] === 'ip' && t[1] === 'arp' && t[2] === 'inspection';

/** A `limit …` line's setting (tokens after `ip arp inspection`), or undefined when it does not parse. */
function limitSetting(rest: readonly string[]): ArpInspectionLimitSetting | undefined {
  if (rest[0] !== 'limit') return undefined;
  if (rest[1] === 'none' && rest.length === 2) return 'none';
  if (rest[1] !== 'rate') return undefined;
  const pps = intToken(rest[2], 0, ARP_INSPECTION_RATE_MAX);
  if (pps === undefined) return undefined;
  if (rest.length === 3) return { pps, burstS: 1 };
  if (rest[3] === 'burst' && rest[4] === 'interval' && rest.length === 6) {
    const burstS = intToken(rest[5], 1, ARP_INSPECTION_BURST_MAX_S);
    return burstS === undefined ? undefined : { pps, burstS };
  }
  return undefined;
}

/** The DAI configuration of a device. Lines that do not parse, and stored negations, configure nothing. */
export function readArpInspection(config: ConfigAst): ArpInspectionConfig {
  const vlanLines: SnoopingVlanLine[] = [];
  const ports = new Map<PortId, { trusted: boolean; limit?: ArpInspectionLimitSetting; limitLine?: readonly string[] }>();
  for (const l of configTextLinesOf(config.root)) {
    const t = l.tokens;
    if (l.negate || !isDai(t)) continue;
    if (l.context.length === 0) {
      if (t[3] === 'vlan') {
        const ranges = parseSnoopingVlanTokens(t.slice(4));
        if (ranges !== undefined) vlanLines.push(Object.freeze({ ranges: Object.freeze(ranges), line: Object.freeze(t.slice()) }));
      }
      continue;
    }
    const port = l.context.length === 1 ? interfaceOfContext(l.context) : undefined;
    if (port === undefined) continue;
    const e = ports.get(port) ?? { trusted: false };
    if (t[3] === 'trust' && t.length === 4) {
      e.trusted = true;
    } else {
      const limit = limitSetting(t.slice(3));
      if (limit === undefined) continue;
      e.limit = typeof limit === 'string' ? limit : Object.freeze(limit);
      e.limitLine = Object.freeze(t.slice());
    }
    ports.set(port, e);
  }
  const portList: ArpInspectionPortConfig[] = [];
  for (const [port, e] of ports) {
    portList.push(Object.freeze(e.limit === undefined ? { port, trusted: e.trusted } : { port, trusted: e.trusted, limit: e.limit, limitLine: e.limitLine }));
  }
  return Object.freeze({ vlanLines: Object.freeze(vlanLines), ports: Object.freeze(portList) });
}

/** True when `vlan` is inspected (the §4.3 silence row: `ip arp inspection vlan <v>`). */
export function arpInspectionActive(cfg: ArpInspectionConfig, vlan: number): boolean {
  return vlanLineFor(cfg.vlanLines, vlan) !== undefined;
}

/** The DAI lines of `port` (an untrusted port with the default limit when it has none). */
export function arpInspectionPort(cfg: ArpInspectionConfig, port: PortId): ArpInspectionPortConfig {
  return cfg.ports.find((p) => p.port === port) ?? { port, trusted: false };
}

/** The effective limit of a port: packets allowed per window, the window length, and the configured line if any. */
export interface ArpInspectionEffectiveLimit {
  /** Packets allowed per window: pps × burstS. */
  readonly allowed: number;
  readonly pps: number;
  readonly burstS: number;
  /** burstS seconds of sim time. */
  readonly windowNs: SimTime;
  /** The stored limit line, when the limit is configured (absent for the default). */
  readonly line?: readonly string[];
}

/** The limit that applies to `port`, or undefined for none (a trusted port by default, or `limit none`). */
export function arpInspectionLimit(cfg: ArpInspectionConfig, port: PortId): ArpInspectionEffectiveLimit | undefined {
  const pc = arpInspectionPort(cfg, port);
  const set = pc.limit ?? (pc.trusted ? 'none' : { pps: ARP_INSPECTION_DEFAULT_RATE_PPS, burstS: 1 });
  if (set === 'none') return undefined;
  const out = { allowed: set.pps * set.burstS, pps: set.pps, burstS: set.burstS, windowNs: set.burstS * SEC };
  return pc.limitLine === undefined ? out : { ...out, line: pc.limitLine };
}

// ── the packet ────────────────────────────────────────────────────────────────────────────────────────────────

/** What DAI reads from an ARP frame. */
export interface ArpInspectView {
  readonly op: number;
  /** Sender hardware address. */
  readonly sha: MacAddress;
  /** Sender protocol address. */
  readonly spa: Ipv4Address;
  readonly tha: MacAddress;
  readonly tpa: Ipv4Address;
}

/** The ARP of `frame` (an Ethernet frame carrying a decoded `arp` layer), or undefined for any other frame. */
export function arpInspectViewOf(frame: Pick<PduView, 'layers'>): ArpInspectView | undefined {
  const eth = frame.layers[0];
  if (eth === undefined || eth.proto !== 'ethernet') return undefined;
  let arp: LayerView | undefined;
  for (const l of frame.layers) {
    if (l.proto === 'arp') {
      arp = l;
      break;
    }
  }
  if (arp === undefined) return undefined;
  const f = arp.fields;
  const sha = typeof f.sha === 'string' ? normalizeMac(f.sha) : null;
  const tha = typeof f.tha === 'string' ? normalizeMac(f.tha) : null;
  if (sha === null || tha === null || typeof f.spa !== 'string' || typeof f.tpa !== 'string' || typeof f.op !== 'number') return undefined;
  return { op: f.op, sha, spa: f.spa, tha, tpa: f.tpa };
}

/** `request`, `reply`, or `op <n>` for another ARP operation. */
export function arpOpWord(op: number): string {
  if (op === ARP_OP_REQUEST) return 'request';
  if (op === ARP_OP_REPLY) return 'reply';
  return `op ${op}`;
}

// ── the decision ──────────────────────────────────────────────────────────────────────────────────────────────

/** Inputs of one step-7c decision. */
export interface ArpInspectionCheck {
  readonly config: ArpInspectionConfig;
  /** Logical port L the ARP arrived on (the Port-channel for a bundled member). */
  readonly port: PortId;
  /** The frame's classified VLAN. */
  readonly vlan: number;
  readonly arp: ArpInspectView;
  readonly now: SimTime;
  /** L's ARP rate window so far (kept by the caller). */
  readonly window?: RateWindow;
  /** The `dhcp-snooping` row of (vlan, sender MAC), if any. */
  readonly binding?: DhcpSnoopingRow;
  /** The VLAN's log window so far (kept by the caller). */
  readonly logWindow?: RateWindow;
}

/** A log line to emit: `Action log {severity, facility, message}`. */
export interface ArpInspectionLog {
  readonly severity: Severity;
  readonly facility: string;
  readonly message: string;
}

/** Outcome of one decision. `window` / `logWindow`, when present, are the new windows for the caller to keep. */
export type ArpInspectionVerdict =
  /** The VLAN is not inspected: the frame takes the P2 path, nothing is counted or written. */
  | { readonly kind: 'skip' }
  /** The ARP goes on; `inspected` (an untrusted port) makes the VLAN row count it as forwarded. */
  | { readonly kind: 'forward'; readonly window?: RateWindow; readonly inspected: boolean }
  /** `Action drop {reason: 'arp-inspection', detail, rule}`; `log` only while the VLAN's log window allows it. */
  | {
      readonly kind: 'drop';
      readonly window?: RateWindow;
      readonly reason: 'arp-inspection';
      readonly detail: string;
      readonly rule: DropRule;
      readonly noBinding: true;
      readonly logWindow: RateWindow;
      readonly log?: ArpInspectionLog;
      readonly debug: string;
    }
  /** The rate limit: `Action errDisable {port, cause: 'arp-inspection', detail: errDisable.detail}` and the drop. */
  | {
      readonly kind: 'err-disable';
      readonly window: RateWindow;
      readonly inspected: boolean;
      readonly reason: 'arp-inspection';
      readonly detail: string;
      readonly rule: DropRule;
      readonly errDisable: { readonly cause: ErrDisableCause; readonly detail: string };
      readonly debug: string;
    };

/**
 * Drop detail of an ARP no binding confirms (§3.4 step 6), e.g. `ARP request from 02:…:05 claiming 192.168.10.1 on
 * FastEthernet0/5 (vlan 10) matches no DHCP snooping binding`.
 */
export function daiNoBindingDetail(op: number, sha: MacAddress, spa: Ipv4Address, port: PortId, vlan: number): string {
  return `ARP ${arpOpWord(op)} from ${sha} claiming ${spa} on ${port} (vlan ${vlan}) matches no DHCP snooping binding`;
}

/** The log line of an invalid ARP (severity 4, facility DAI). */
export function daiInvalidLogMessage(op: number, sha: MacAddress, spa: Ipv4Address, port: PortId, vlan: number): string {
  return `Refused an ARP ${arpOpWord(op)} on ${port}, vlan ${vlan}: ${sha} claims ${spa}, which no DHCP snooping binding confirms.`;
}

/** `one second` / `N seconds`. */
function seconds(n: number): string {
  return n === 1 ? 'one second' : `${n} seconds`;
}

/** Drop detail of the ARP that exceeds the rate limit. */
export function daiRateDetail(port: PortId, count: number, limit: ArpInspectionEffectiveLimit): string {
  return `ARP rate limit exceeded on ${port}: ${count} packets in ${seconds(limit.burstS)}, the limit is ${limit.allowed}`;
}

/** Detail of the `errDisable` action (appended to the runtime's err-disable log line). */
export function daiErrDisableDetail(count: number, limit: ArpInspectionEffectiveLimit): string {
  return `${count} ARP packets in ${seconds(limit.burstS)}, the limit is ${limit.allowed}`;
}

/** True when `binding` confirms the ARP: unexpired, same VLAN, sender MAC, sender IP and port (D13). */
export function bindingConfirms(binding: DhcpSnoopingRow | undefined, arp: ArpInspectView, vlan: number, port: PortId, now: SimTime): boolean {
  if (binding === undefined) return false;
  if (binding.expiresAt !== undefined && binding.expiresAt <= now) return false;
  return binding.vlan === vlan && binding.mac === arp.sha && binding.ip === arp.spa && binding.port === port;
}

/** The step-7c decision for one ARP (see the file header for the order of the checks). */
export function decideArpInspection(check: ArpInspectionCheck): ArpInspectionVerdict {
  const { config, port, vlan, arp, now } = check;
  if (!arpInspectionActive(config, vlan)) return { kind: 'skip' };
  const pc = arpInspectionPort(config, port);
  const inspected = !pc.trusted;

  // 1. the rate limit counts every ARP of an inspected VLAN on the port
  const limit = arpInspectionLimit(config, port);
  let window: RateWindow | undefined;
  if (limit !== undefined) {
    window = countInRateWindow(check.window, now, limit.windowNs);
    if (rateExceeded(window, limit.allowed)) {
      const rule: DropRule = {
        kind: 'arp-inspection',
        text: limit.line === undefined
          ? `an untrusted port accepts at most ${ARP_INSPECTION_DEFAULT_RATE_PPS} ARP packets per second by default; more than that shuts the port down (error-disabled) until it is recovered`
          : `${port} accepts at most ${limit.allowed} ARP packets in ${seconds(limit.burstS)}; more than that shuts the port down (error-disabled) until it is recovered`,
        iface: port,
        ...(limit.line === undefined ? {} : { config: { context: [['interface', port]], line: limit.line } }),
      };
      return {
        kind: 'err-disable',
        window,
        inspected,
        reason: 'arp-inspection',
        detail: daiRateDetail(port, window.count, limit),
        rule,
        errDisable: { cause: ARP_INSPECTION_ERR_DISABLE_CAUSE, detail: daiErrDisableDetail(window.count, limit) },
        debug: `${port} (vlan ${vlan}): ${window.count} ARP packets in ${seconds(limit.burstS)} exceed the limit of ${limit.allowed}; error-disabling the port`,
      };
    }
  }
  const counted = window === undefined ? {} : { window };

  // 2. trusted ports are not inspected
  if (!inspected) return { ...counted, kind: 'forward', inspected: false };

  // 3. untrusted: a binding must confirm the sender
  if (bindingConfirms(check.binding, arp, vlan, port, now)) return { ...counted, kind: 'forward', inspected: true };
  const logWindow = countInRateWindow(check.logWindow, now);
  const verdict = {
    ...counted,
    kind: 'drop' as const,
    reason: 'arp-inspection' as const,
    detail: daiNoBindingDetail(arp.op, arp.sha, arp.spa, port, vlan),
    rule: {
      kind: 'arp-inspection' as const,
      text: `on an untrusted port of an inspected VLAN an ARP needs a DHCP snooping binding for its sender (MAC ${arp.sha}, address ${arp.spa}, this port); a host with a static address needs "ip source binding", or the port needs "ip arp inspection trust"`,
      table: 'dhcp-snooping' as const,
      key: dhcpSnoopingKey(vlan, arp.sha),
      iface: port,
    },
    noBinding: true as const,
    logWindow,
    debug: `dropped ARP ${arpOpWord(arp.op)} from ${arp.sha} claiming ${arp.spa} on ${port} (vlan ${vlan}): no matching binding`,
  };
  if (rateExceeded(logWindow, ARP_INSPECTION_LOG_LINES_PER_SECOND)) return verdict;
  return {
    ...verdict,
    log: { severity: ARP_INSPECTION_LOG_SEVERITY, facility: ARP_INSPECTION_LOG_FACILITY, message: daiInvalidLogMessage(arp.op, arp.sha, arp.spa, port, vlan) },
  };
}

/** A zeroed row for `vlan` (key = vlanKey(vlan)). */
export function arpInspectionRowOf(vlan: number, now: SimTime): ArpInspectionRow {
  return { key: vlanKey(vlan), vlan, forwarded: 0, dropped: 0, droppedNoBinding: 0, droppedAcl: 0, updatedAt: now };
}

/**
 * The VLAN's row after `verdict` (one write per ARP inspected on an untrusted port): forwarded + 1; a drop: dropped + 1
 * and droppedNoBinding + 1; a rate-limit drop on an untrusted port: dropped + 1. Undefined when nothing is written
 * (skip, a trusted port).
 */
export function applyArpInspectionVerdict(
  prev: ArpInspectionRow | undefined,
  vlan: number,
  verdict: ArpInspectionVerdict,
  now: SimTime,
): ArpInspectionRow | undefined {
  if (verdict.kind === 'skip') return undefined;
  if (verdict.kind !== 'drop' && !verdict.inspected) return undefined;
  const row = prev ?? arpInspectionRowOf(vlan, now);
  if (verdict.kind === 'forward') return { ...row, forwarded: row.forwarded + 1, updatedAt: now };
  if (verdict.kind === 'drop') return { ...row, dropped: row.dropped + 1, droppedNoBinding: row.droppedNoBinding + 1, updatedAt: now };
  return { ...row, dropped: row.dropped + 1, updatedAt: now };
}
