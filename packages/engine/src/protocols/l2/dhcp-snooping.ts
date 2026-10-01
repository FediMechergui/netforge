/**
 * protocols/l2/dhcp-snooping.ts — the DHCP snooping decision (ARCHITECTURE-P3 D13, §3.0 (b) "eth-switch steps 7b/7c",
 * §3.4 steps 1–5, §4.3, §4.5, §5.3).
 *
 * eth-switch runs step 7b in its VLAN-aware per-frame path, after port security (step 7), for a DHCP message whose VLAN
 * has snooping on; it keeps the per-port rate windows and writes the `dhcp-snooping` table. This module holds the pure
 * pieces, in the port-security pattern (`protocols/l2/port-security.ts`):
 *
 *  • `readDhcpSnooping(config)` — the §5.3 lines: `ip dhcp snooping` (global switch), `ip dhcp snooping vlan <list>`
 *    (each stored line kept with its tokens, so a drop can point at it), `no ip dhcp snooping verify mac-address` (the
 *    MAC check is on by default), per interface `ip dhcp snooping trust` and `ip dhcp snooping limit rate <pps>`, and
 *    the static `ip source binding <mac> vlan <v> <ip> interface <if>` lines. `no ip dhcp snooping information option`
 *    is accepted and has no effect (option 82 is never inserted, a listed deviation). Lines are read from the stored
 *    tree through `configTextLinesOf`, so the reader does not depend on how the configuration rules store them.
 *  • `dhcpSnoopMessageOf(frame)` — the fields snooping reads from a decoded DHCP frame.
 *  • `decideDhcpSnooping(check)` — for a DHCP message arriving on logical port L in VLAN V with snooping on:
 *      1. a rate limit on L: count the message in L's one-second window; more than the limit → err-disable L
 *         (`dhcp-rate-limit`) and drop this message (§3.4 step 5), whatever else it is;
 *      2. untrusted L, a server message (OFFER, ACK, NAK) → drop `dhcp-snooping` (§3.4 step 2);
 *      3. untrusted L, a client message whose `chaddr` is not the Ethernet source while the MAC check is on → drop;
 *      4. an ACK (on a trusted port): a `learned` binding (V, chaddr) → yiaddr on the client's port, which the caller
 *         reads from the CAM row (V, chaddr); without that row no binding is written and a debug line says why (§3.4
 *         step 3); a NAK removes the learned binding of (V, chaddr);
 *      5. a RELEASE arriving on the port of the learned binding (V, chaddr) removes it (§3.4 step 4);
 *      6. otherwise the message goes on (step 8, learn, and forwarding).
 *    Static bindings are never replaced or removed by messages. Lease end is the caller's `cam-sweep`, link-down its
 *    link handler (`bindingsOnPort`).
 *  • `ackBinding` (also used for an ACK the switch's own SVI sends, in `onEgressVlanAware`), `staticBindingRows`,
 *    `dhcpSnoopingKey`.
 *
 * Wording is original. Debug lines use the category `ip dhcp snooping` (§5.8). Integer only. Pure: no state, no I/O,
 * no clock, no randomness.
 */
import { IPV4_ANY, isIpv4, normalizeMac } from '../../contracts/addr.js';
import type { Ipv4Address, MacAddress } from '../../contracts/addr.js';
import type { ConfigAst } from '../../contracts/config.js';
import type { PortId } from '../../contracts/ids.js';
import type { ErrDisableCause } from '../../contracts/port.js';
import type { LayerView, PduView } from '../../contracts/pdu.js';
import type { DropRule } from '../../contracts/process.js';
import type { DhcpSnoopingRow } from '../../contracts/tables.js';
import { SEC } from '../../contracts/time.js';
import type { SimTime } from '../../contracts/time.js';
import { configTextLinesOf } from '../../cli/config-text.js';
import { parseVlanRanges } from '../../core/vlan-list.js';
import type { VlanRange } from '../../core/vlan-list.js';
import { countInRateWindow, rateExceeded } from './rate-window.js';
import { interfaceOfContext } from './switchport-config.js';
import type { RateWindow } from './rate-window.js';

/** Debug category of snooping messages (§5.8: the `debug ip dhcp snooping` tokens). */
export const DHCP_SNOOPING_DEBUG_CATEGORY = 'ip dhcp snooping';
/** Highest accepted `ip dhcp snooping limit rate` (packets per second). */
export const DHCP_SNOOPING_RATE_MAX = 2048;
/** The err-disable cause of the rate limit (D13). */
export const DHCP_SNOOPING_ERR_DISABLE_CAUSE: ErrDisableCause = 'dhcp-rate-limit';
/** The DHCP message types a server sends. */
export const DHCP_SERVER_MESSAGE_TYPES: readonly string[] = Object.freeze(['OFFER', 'ACK', 'NAK']);
/** The DHCP message types a client sends (a relay forwards them unchanged); another type is a server's when BOOTP op is 2. */
export const DHCP_CLIENT_MESSAGE_TYPES: readonly string[] = Object.freeze(['DISCOVER', 'REQUEST', 'DECLINE', 'RELEASE', 'INFORM']);

/** `dhcp-snooping` row key: `${vlan}|${mac}` (§2.6). */
export function dhcpSnoopingKey(vlan: number, mac: MacAddress): string {
  return `${vlan}|${mac}`;
}

// ── configuration ─────────────────────────────────────────────────────────────────────────────────────────────

/** One stored `… vlan <list>` line: the VLANs it names and its tokens exactly as stored (for a drop's rule). */
export interface SnoopingVlanLine {
  readonly ranges: readonly VlanRange[];
  readonly line: readonly string[];
}

/** The snooping lines of one interface (only interfaces with at least one of them are listed). */
export interface DhcpSnoopingPortConfig {
  readonly port: PortId;
  /** `ip dhcp snooping trust`. */
  readonly trusted: boolean;
  /** `ip dhcp snooping limit rate <pps>`; absent = no limit. */
  readonly limitPps?: number;
  /** The stored limit line's tokens (with `limitPps`). */
  readonly limitLine?: readonly string[];
}

/** A static binding from `ip source binding <mac> vlan <v> <ip> interface <if>`. */
export interface StaticSnoopingBinding {
  readonly mac: MacAddress;
  readonly vlan: number;
  readonly ip: Ipv4Address;
  readonly port: PortId;
}

/** Everything step 7b reads from the running configuration. */
export interface DhcpSnoopingConfig {
  /** `ip dhcp snooping` (without it no VLAN is snooped). */
  readonly enabled: boolean;
  /** `ip dhcp snooping vlan <list>` lines, in configuration order (the union of their VLANs is snooped). */
  readonly vlanLines: readonly SnoopingVlanLine[];
  /** The MAC check (chaddr = Ethernet source on untrusted ports); off only with `no ip dhcp snooping verify mac-address`. */
  readonly verifyMac: boolean;
  /** Per-interface lines, in configuration order. */
  readonly ports: readonly DhcpSnoopingPortConfig[];
  /** Static bindings, in configuration order; a later line for the same (VLAN, MAC) replaces an earlier one. */
  readonly staticBindings: readonly StaticSnoopingBinding[];
}

/** The first stored line of `lines` that names `vlan`, or undefined. */
export function vlanLineFor(lines: readonly SnoopingVlanLine[], vlan: number): readonly string[] | undefined {
  for (const l of lines) {
    for (const [lo, hi] of l.ranges) if (vlan >= lo && vlan <= hi) return l.line;
  }
  return undefined;
}

/** A `… vlan <list…>` line's VLANs (the list may be split over several tokens), or undefined when it does not parse. */
export function parseSnoopingVlanTokens(tokens: readonly string[]): VlanRange[] | undefined {
  if (tokens.length === 0) return undefined;
  const ranges = parseVlanRanges(tokens.join(','));
  return ranges === undefined || ranges.length === 0 ? undefined : ranges;
}

/** A decimal integer token within [lo, hi], or undefined. */
function intToken(t: string | undefined, lo: number, hi: number): number | undefined {
  if (t === undefined || !/^\d{1,10}$/.test(t)) return undefined;
  const n = Number(t);
  return n >= lo && n <= hi ? n : undefined;
}

const isSnoop = (t: readonly string[]): boolean => t[0] === 'ip' && t[1] === 'dhcp' && t[2] === 'snooping';

/** The DHCP snooping configuration of a device. Lines that do not parse are ignored; stored negations other than the MAC check configure nothing. */
export function readDhcpSnooping(config: ConfigAst): DhcpSnoopingConfig {
  let enabled = false;
  let verifyMac = true;
  const vlanLines: SnoopingVlanLine[] = [];
  const ports = new Map<PortId, { trusted: boolean; limitPps?: number; limitLine?: readonly string[] }>();
  const statics = new Map<string, StaticSnoopingBinding>();
  const portEntry = (port: PortId): { trusted: boolean; limitPps?: number; limitLine?: readonly string[] } => {
    let e = ports.get(port);
    if (e === undefined) {
      e = { trusted: false };
      ports.set(port, e);
    }
    return e;
  };
  for (const l of configTextLinesOf(config.root)) {
    const t = l.tokens;
    if (l.context.length === 0) {
      if (l.negate) {
        if (isSnoop(t) && t[3] === 'verify' && t[4] === 'mac-address' && t.length === 5) verifyMac = false;
        continue;
      }
      if (isSnoop(t) && t.length === 3) enabled = true;
      else if (isSnoop(t) && t[3] === 'vlan') {
        const ranges = parseSnoopingVlanTokens(t.slice(4));
        if (ranges !== undefined) vlanLines.push(Object.freeze({ ranges: Object.freeze(ranges), line: Object.freeze(t.slice()) }));
      } else if (isSnoop(t) && t[3] === 'verify' && t[4] === 'mac-address' && t.length === 5) verifyMac = true;
      else if (t[0] === 'ip' && t[1] === 'source' && t[2] === 'binding' && t[4] === 'vlan' && t[7] === 'interface' && t.length === 9) {
        const mac = normalizeMac(t[3] as string);
        const vlan = intToken(t[5], 1, 4094);
        const ip = t[6] as string;
        const port = t[8] as string;
        if (mac !== null && vlan !== undefined && isIpv4(ip)) {
          const key = dhcpSnoopingKey(vlan, mac);
          statics.delete(key);
          statics.set(key, Object.freeze({ mac, vlan, ip, port }));
        }
      }
      continue;
    }
    const port = l.context.length === 1 ? interfaceOfContext(l.context) : undefined;
    if (port === undefined || l.negate || !isSnoop(t)) continue;
    if (t[3] === 'trust' && t.length === 4) portEntry(port).trusted = true;
    else if (t[3] === 'limit' && t[4] === 'rate' && t.length === 6) {
      const pps = intToken(t[5], 1, DHCP_SNOOPING_RATE_MAX);
      if (pps !== undefined) {
        const e = portEntry(port);
        e.limitPps = pps;
        e.limitLine = Object.freeze(t.slice());
      }
    }
  }
  const portList: DhcpSnoopingPortConfig[] = [];
  for (const [port, e] of ports) {
    portList.push(Object.freeze(e.limitPps === undefined ? { port, trusted: e.trusted } : { port, trusted: e.trusted, limitPps: e.limitPps, limitLine: e.limitLine }));
  }
  return Object.freeze({
    enabled,
    vlanLines: Object.freeze(vlanLines),
    verifyMac,
    ports: Object.freeze(portList),
    staticBindings: Object.freeze([...statics.values()]),
  });
}

/** True when snooping runs for `vlan`: `ip dhcp snooping` and a `vlan` line naming it (the §4.3 silence row). */
export function dhcpSnoopingActive(cfg: DhcpSnoopingConfig, vlan: number): boolean {
  return cfg.enabled && vlanLineFor(cfg.vlanLines, vlan) !== undefined;
}

/** The snooping lines of `port` (an untrusted port without a limit when it has none). */
export function dhcpSnoopingPort(cfg: DhcpSnoopingConfig, port: PortId): DhcpSnoopingPortConfig {
  return cfg.ports.find((p) => p.port === port) ?? { port, trusted: false };
}

/** The `dhcp-snooping` rows the static bindings install (kind 'static', no lease, no expiry), configuration order. */
export function staticBindingRows(cfg: DhcpSnoopingConfig, now: SimTime): DhcpSnoopingRow[] {
  return cfg.staticBindings.map((b) => ({
    key: dhcpSnoopingKey(b.vlan, b.mac),
    mac: b.mac,
    ip: b.ip,
    vlan: b.vlan,
    port: b.port,
    kind: 'static' as const,
    updatedAt: now,
  }));
}

/** Keys of the learned bindings on `port` among `rows` (link-down of the port removes them, D13; static ones stay). */
export function bindingsOnPort(rows: readonly DhcpSnoopingRow[], port: PortId): string[] {
  return rows.filter((r) => r.kind === 'learned' && r.port === port).map((r) => r.key);
}

// ── the message ───────────────────────────────────────────────────────────────────────────────────────────────

/** What snooping reads from a DHCP frame. */
export interface DhcpSnoopMessage {
  /** Option 53 (`DISCOVER`, `OFFER`, …), upper case. */
  readonly type: string;
  /** A server message: OFFER, ACK or NAK (or, for an unknown type, BOOTP op 2). */
  readonly server: boolean;
  readonly chaddr: MacAddress;
  /** The Ethernet source. */
  readonly srcMac: MacAddress;
  /** The IPv4 source, when the frame has an IPv4 header. */
  readonly srcIp?: Ipv4Address;
  readonly yiaddr: Ipv4Address;
  readonly ciaddr: Ipv4Address;
  /** Option 51, seconds. */
  readonly leaseS?: number;
}

function layerOf(frame: Pick<PduView, 'layers'>, proto: string): LayerView | undefined {
  for (const l of frame.layers) if (l.proto === proto) return l;
  return undefined;
}

/** The DHCP message of `frame` (an Ethernet frame carrying a decoded `dhcp` layer), or undefined for any other frame. */
export function dhcpSnoopMessageOf(frame: Pick<PduView, 'layers'>): DhcpSnoopMessage | undefined {
  const eth = frame.layers[0];
  if (eth === undefined || eth.proto !== 'ethernet') return undefined;
  const dhcp = layerOf(frame, 'dhcp');
  if (dhcp === undefined) return undefined;
  const f = dhcp.fields;
  const chaddr = typeof f.chaddr === 'string' ? normalizeMac(f.chaddr) : null;
  const srcMac = typeof eth.fields.src === 'string' ? normalizeMac(eth.fields.src) : null;
  if (chaddr === null || srcMac === null) return undefined;
  const type = typeof f.messageType === 'string' ? f.messageType.toUpperCase() : '';
  const server = DHCP_SERVER_MESSAGE_TYPES.includes(type) || (!DHCP_CLIENT_MESSAGE_TYPES.includes(type) && f.op === 2);
  const ip = layerOf(frame, 'ipv4');
  const srcIp = ip !== undefined && typeof ip.fields.src === 'string' ? ip.fields.src : undefined;
  const msg: {
    type: string; server: boolean; chaddr: MacAddress; srcMac: MacAddress; srcIp?: Ipv4Address;
    yiaddr: Ipv4Address; ciaddr: Ipv4Address; leaseS?: number;
  } = {
    type,
    server,
    chaddr,
    srcMac,
    yiaddr: typeof f.yiaddr === 'string' ? f.yiaddr : IPV4_ANY,
    ciaddr: typeof f.ciaddr === 'string' ? f.ciaddr : IPV4_ANY,
  };
  if (srcIp !== undefined) msg.srcIp = srcIp;
  if (typeof f.leaseTimeS === 'number' && Number.isInteger(f.leaseTimeS) && f.leaseTimeS >= 0) msg.leaseS = f.leaseTimeS;
  return msg;
}

// ── the decision ──────────────────────────────────────────────────────────────────────────────────────────────

/** Inputs of one step-7b decision. */
export interface DhcpSnoopingCheck {
  readonly config: DhcpSnoopingConfig;
  /** Logical port L the message arrived on (the Port-channel for a bundled member). */
  readonly port: PortId;
  /** The frame's classified VLAN. */
  readonly vlan: number;
  readonly msg: DhcpSnoopMessage;
  readonly now: SimTime;
  /** L's DHCP rate window so far (kept by the caller; read only when L has a limit). */
  readonly window?: RateWindow;
  /** The `dhcp-snooping` row of (vlan, chaddr), if any. */
  readonly binding?: DhcpSnoopingRow;
  /** For an ACK: the port of the CAM row (vlan, chaddr), if any — the client's port. */
  readonly clientPort?: PortId;
}

/** Outcome of one decision. `window`, when present, is L's new rate window for the caller to keep. */
export type DhcpSnoopingVerdict =
  /** Snooping is off for the VLAN: the frame takes the P2 path, nothing is counted or written. */
  | { readonly kind: 'skip' }
  /** The message goes on; `bind` is a row to write, `unbind` a learned row's key to delete (reason 'cleared'). */
  | {
      readonly kind: 'forward';
      readonly window?: RateWindow;
      readonly bind?: DhcpSnoopingRow;
      readonly unbind?: string;
      readonly debug?: string;
    }
  /** `Action drop {reason: 'dhcp-snooping', detail, rule}`. */
  | {
      readonly kind: 'drop';
      readonly window?: RateWindow;
      readonly reason: 'dhcp-snooping';
      readonly detail: string;
      readonly rule: DropRule;
      readonly debug: string;
    }
  /** The rate limit: `Action errDisable {port, cause: 'dhcp-rate-limit', detail: errDisable.detail}` and the drop. */
  | {
      readonly kind: 'err-disable';
      readonly window: RateWindow;
      readonly reason: 'dhcp-snooping';
      readonly detail: string;
      readonly rule: DropRule;
      readonly errDisable: { readonly cause: ErrDisableCause; readonly detail: string };
      readonly debug: string;
    };

/** Drop detail of a server message on an untrusted port (§3.4 step 2), e.g. `DHCP server message (OFFER) from 10.66.0.1 on untrusted port FastEthernet0/24 (vlan 10)`. */
export function snoopingUntrustedServerDetail(type: string, from: string, port: PortId, vlan: number): string {
  return `DHCP server message (${type}) from ${from} on untrusted port ${port} (vlan ${vlan})`;
}

/** Drop detail of the MAC check: the client hardware address is not the frame's source. */
export function snoopingMacMismatchDetail(type: string, chaddr: MacAddress, src: MacAddress, port: PortId, vlan: number): string {
  return `DHCP client message (${type}) on ${port} (vlan ${vlan}) names client ${chaddr} but comes from ${src}`;
}

/** Drop detail of the message that exceeds the rate limit. */
export function snoopingRateDetail(port: PortId, count: number, limit: number): string {
  return `DHCP rate limit exceeded on ${port}: ${count} packets in one second, the limit is ${limit}`;
}

/** Detail of the `errDisable` action (appended to the runtime's err-disable log line). */
export function snoopingErrDisableDetail(count: number, limit: number): string {
  return `${count} DHCP packets in one second, the limit is ${limit}`;
}

/**
 * The learned binding an ACK installs: (vlan, chaddr) → yiaddr on `clientPort`, lease from option 51 (expiresAt =
 * now + lease; none for an infinite lease or one beyond the safe-integer range of SimTime). Undefined for an ACK without
 * an offered address (an answer to INFORM) or without a client port.
 */
export function ackBinding(msg: DhcpSnoopMessage, vlan: number, clientPort: PortId | undefined, now: SimTime): DhcpSnoopingRow | undefined {
  if (clientPort === undefined || msg.yiaddr === IPV4_ANY || !isIpv4(msg.yiaddr)) return undefined;
  const row: DhcpSnoopingRow = {
    key: dhcpSnoopingKey(vlan, msg.chaddr),
    mac: msg.chaddr,
    ip: msg.yiaddr,
    vlan,
    port: clientPort,
    kind: 'learned',
    updatedAt: now,
  };
  if (msg.leaseS !== undefined) {
    row.leaseS = msg.leaseS;
    if (msg.leaseS <= Math.floor((Number.MAX_SAFE_INTEGER - now) / SEC) && msg.leaseS < 0xffffffff) row.expiresAt = now + msg.leaseS * SEC;
  }
  return row;
}

/** The step-7b decision for one DHCP message (see the file header for the order of the checks). */
export function decideDhcpSnooping(check: DhcpSnoopingCheck): DhcpSnoopingVerdict {
  const { config, port, vlan, msg, now } = check;
  const vlanLine = vlanLineFor(config.vlanLines, vlan);
  if (!config.enabled || vlanLine === undefined) return { kind: 'skip' };
  const pc = dhcpSnoopingPort(config, port);

  // 1. the rate limit counts every DHCP message on the port, whatever the rest of the decision
  let window: RateWindow | undefined;
  if (pc.limitPps !== undefined) {
    window = countInRateWindow(check.window, now);
    if (rateExceeded(window, pc.limitPps)) {
      const detail = snoopingRateDetail(port, window.count, pc.limitPps);
      return {
        kind: 'err-disable',
        window,
        reason: 'dhcp-snooping',
        detail,
        rule: {
          kind: 'dhcp-snooping',
          text: `${port} accepts at most ${pc.limitPps} DHCP packets per second; more than that shuts the port down (error-disabled) until it is recovered`,
          config: { context: [['interface', port]], line: pc.limitLine ?? ['ip', 'dhcp', 'snooping', 'limit', 'rate', String(pc.limitPps)] },
          iface: port,
        },
        errDisable: { cause: DHCP_SNOOPING_ERR_DISABLE_CAUSE, detail: snoopingErrDisableDetail(window.count, pc.limitPps) },
        debug: `${port} (vlan ${vlan}): ${window.count} DHCP packets in this second exceed the limit of ${pc.limitPps}; error-disabling the port`,
      };
    }
  }
  const counted = window === undefined ? {} : { window };

  // 2–3. untrusted ports: no server messages; client messages must come from their own hardware address
  if (!pc.trusted) {
    if (msg.server) {
      const from = msg.srcIp ?? msg.srcMac;
      const detail = snoopingUntrustedServerDetail(msg.type, from, port, vlan);
      return {
        ...counted,
        kind: 'drop',
        reason: 'dhcp-snooping',
        detail,
        rule: {
          kind: 'dhcp-snooping',
          text: `DHCP snooping on vlan ${vlan} accepts server messages only on trusted ports; if a legitimate server is reached through ${port}, mark the port with "ip dhcp snooping trust"`,
          config: { context: [], line: vlanLine },
          iface: port,
        },
        debug: `dropped ${msg.type} from ${from} on untrusted ${port} (vlan ${vlan})`,
      };
    }
    if (config.verifyMac && msg.chaddr !== msg.srcMac) {
      const detail = snoopingMacMismatchDetail(msg.type, msg.chaddr, msg.srcMac, port, vlan);
      return {
        ...counted,
        kind: 'drop',
        reason: 'dhcp-snooping',
        detail,
        rule: {
          kind: 'dhcp-snooping',
          text: `on untrusted ports DHCP snooping checks that the client hardware address of a message is its Ethernet source ("no ip dhcp snooping verify mac-address" turns the check off)`,
          config: { context: [], line: vlanLine },
          iface: port,
        },
        debug: `dropped ${msg.type} on ${port} (vlan ${vlan}): client ${msg.chaddr} is not the source ${msg.srcMac}`,
      };
    }
  }

  // 4. server messages on a trusted port: ACK binds, NAK unbinds
  const learned = check.binding !== undefined && check.binding.kind === 'learned' ? check.binding : undefined;
  if (msg.server && msg.type === 'ACK') {
    if (check.binding?.kind === 'static') {
      return { ...counted, kind: 'forward', debug: `ACK for ${msg.chaddr} (vlan ${vlan}) leaves its static binding unchanged` };
    }
    if (msg.yiaddr === IPV4_ANY) return { ...counted, kind: 'forward' };
    const bind = ackBinding(msg, vlan, check.clientPort, now);
    if (bind === undefined) {
      return {
        ...counted,
        kind: 'forward',
        debug: `ACK for ${msg.chaddr} (vlan ${vlan}) records no binding for ${msg.yiaddr}: the MAC address table has no entry for the client`,
      };
    }
    const lease = bind.leaseS === undefined ? 'no lease time' : `lease ${bind.leaseS} s`;
    return { ...counted, kind: 'forward', bind, debug: `binding ${bind.mac} ${bind.ip} on ${bind.port} (vlan ${vlan}), ${lease}` };
  }
  if (msg.server && msg.type === 'NAK') {
    if (learned === undefined) return { ...counted, kind: 'forward' };
    return { ...counted, kind: 'forward', unbind: learned.key, debug: `binding ${learned.mac} ${learned.ip} (vlan ${vlan}) removed: NAK` };
  }

  // 5. a RELEASE from the binding's own port removes it
  if (!msg.server && msg.type === 'RELEASE' && learned !== undefined) {
    if (learned.port !== port) {
      return { ...counted, kind: 'forward', debug: `RELEASE for ${msg.chaddr} on ${port} (vlan ${vlan}) keeps the binding on ${learned.port}` };
    }
    return { ...counted, kind: 'forward', unbind: learned.key, debug: `binding ${learned.mac} ${learned.ip} (vlan ${vlan}) removed: RELEASE on ${port}` };
  }
  return { ...counted, kind: 'forward' };
}
