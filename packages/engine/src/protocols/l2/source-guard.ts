/**
 * protocols/l2/source-guard.ts — the IP source guard decision (ARCHITECTURE-P3C D8 [S15], §3.7, §4.3, §5).
 *
 * eth-switch runs step **7d** in its VLAN-aware per-frame path, after port security (7), DHCP snooping (7b) and DAI
 * (7c), on a port with `ip verify source [port-security]`. W1a delivers the pure pieces only; the W2a l2 item wires them
 * into eth-switch (§7). In the port-security / snooping pattern:
 *
 *  • `readSourceGuard(config)` — the interface lines `ip verify source` (filter type `ip`) and `ip verify source
 *    port-security` (filter type `ip-mac`), each kept with its stored tokens so a drop can point at it. Stored
 *    negations and lines that do not parse configure nothing. A port with no line is absent from the map, so the
 *    per-frame cost with no line anywhere is one Map lookup.
 *  • `sourceGuardViewOf(frame)` — what step 7d reads from a frame: the class (IPv4, ARP, other), the Ethernet source,
 *    the IPv4 source and whether the datagram is a DHCP client message (UDP 68 → 67).
 *  • `decideSourceGuard(check)` — for a frame arriving on logical port L in VLAN V:
 *      1. no `ip verify source` on L → `skip` (the P3a path, nothing evaluated);
 *      2. DHCP snooping is not on for V → `unfiltered`, with a debug line saying why (the guard needs bindings);
 *      3. ARP (DAI's job), non-IPv4 frames and DHCP client messages (any source address) → `exempt`;
 *      4. an IPv4 frame whose source address equals the address of an unexpired `dhcp-snooping` binding of (V, L) —
 *         and, with `port-security`, whose Ethernet source equals that binding's MAC — → `forward`;
 *      5. everything else → `drop` `ip-source-guard`, with a `DropRule` pointing at the interface line.
 *  • `ipsgNeedsPortSecurity(line, hasPortSecurity)` — the `port-security` option is refused on a port without
 *    `switchport port-security` (the W3a CLI refusal reads it).
 *  • `sourceGuardFilters(...)` — the entries `show ip verify source` prints (interface, filter type, state, address,
 *    MAC, VLAN), as data; the CLI handler owns the layout.
 *
 * IPv4 only. Wording is original. Integer only. Pure: no state, no I/O, no clock, no randomness.
 */
import { normalizeMac } from '../../contracts/addr.js';
import type { Ipv4Address, MacAddress } from '../../contracts/addr.js';
import type { ConfigAst } from '../../contracts/config.js';
import type { PortId } from '../../contracts/ids.js';
import type { LayerView, PduView } from '../../contracts/pdu.js';
import type { DropRule } from '../../contracts/process.js';
import type { DhcpSnoopingRow } from '../../contracts/tables.js';
import type { SimTime } from '../../contracts/time.js';
import { configTextLinesOf } from '../../cli/config-text.js';
import { dhcpSnoopingKey } from './dhcp-snooping.js';
import { interfaceOfContext } from './switchport-config.js';

/** Debug category of step-7d messages (the `debug ip verify source` tokens). */
export const SOURCE_GUARD_DEBUG_CATEGORY = 'ip verify source';
/** UDP port of a DHCP client (the exempt source port). */
export const DHCP_CLIENT_UDP_PORT = 68;
/** UDP port of a DHCP server (the exempt destination port). */
export const DHCP_SERVER_UDP_PORT = 67;

// ── configuration ─────────────────────────────────────────────────────────────────────────────────────────────

/** `ip` for `ip verify source`; `ip-mac` for `ip verify source port-security`. */
export type SourceGuardFilterType = 'ip' | 'ip-mac';

/** The guard line of one interface. */
export interface SourceGuardPortConfig {
  readonly port: PortId;
  readonly filter: SourceGuardFilterType;
  /** The stored line's tokens (`ip verify source [port-security]`). */
  readonly line: readonly string[];
}

/** Every port with a guard line; a port without one is absent. */
export type SourceGuardConfig = ReadonlyMap<PortId, SourceGuardPortConfig>;

/** The filter type of an `ip verify source …` line (tokens without `no`), or undefined when it is not one. */
export function parseSourceGuardLine(tokens: readonly string[]): SourceGuardFilterType | undefined {
  if (tokens[0] !== 'ip' || tokens[1] !== 'verify' || tokens[2] !== 'source') return undefined;
  if (tokens.length === 3) return 'ip';
  if (tokens.length === 4 && tokens[3] === 'port-security') return 'ip-mac';
  return undefined;
}

/** The IP source guard lines of a device (the last valid line of an interface wins). */
export function readSourceGuard(config: ConfigAst): SourceGuardConfig {
  const out = new Map<PortId, SourceGuardPortConfig>();
  for (const l of configTextLinesOf(config.root)) {
    if (l.negate || l.context.length !== 1) continue;
    const filter = parseSourceGuardLine(l.tokens);
    if (filter === undefined) continue;
    const port = interfaceOfContext(l.context);
    if (port === undefined) continue;
    out.set(port, Object.freeze({ port, filter, line: Object.freeze(l.tokens.slice()) }));
  }
  return out;
}

/**
 * True when the line must be refused: `ip verify source port-security` on a port without `switchport port-security`
 * (`ipsgNeedsPortSecurity`). `ip verify source` alone never needs it.
 */
export function ipsgNeedsPortSecurity(tokens: readonly string[], hasPortSecurity: boolean): boolean {
  return parseSourceGuardLine(tokens) === 'ip-mac' && !hasPortSecurity;
}

// ── the frame ─────────────────────────────────────────────────────────────────────────────────────────────────

/** What step 7d reads from a frame. */
export type SourceGuardView =
  | {
      readonly kind: 'ipv4';
      readonly srcMac: MacAddress;
      readonly srcIp: Ipv4Address;
      /** UDP 68 → 67: a DHCP client message, exempt whatever its source address. */
      readonly dhcpClient: boolean;
    }
  | { readonly kind: 'arp' }
  | { readonly kind: 'other' };

function u16(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isInteger(v) ? v : undefined;
}

/**
 * The step-7d view of `frame` (an Ethernet frame). The first layer after the Ethernet header (and any 802.1Q tag)
 * decides the class: `ipv4`, `arp`, or `other` (IPv6, LLC, an undecoded payload, …).
 */
export function sourceGuardViewOf(frame: Pick<PduView, 'layers'>): SourceGuardView {
  const eth = frame.layers[0];
  if (eth === undefined || eth.proto !== 'ethernet') return { kind: 'other' };
  let i = 1;
  while (frame.layers[i]?.proto === 'dot1q') i++;
  const l3: LayerView | undefined = frame.layers[i];
  if (l3 === undefined) return { kind: 'other' };
  if (l3.proto === 'arp') return { kind: 'arp' };
  if (l3.proto !== 'ipv4') return { kind: 'other' };
  const srcMac = typeof eth.fields.src === 'string' ? normalizeMac(eth.fields.src) : null;
  const srcIp = l3.fields.src;
  if (srcMac === null || typeof srcIp !== 'string') return { kind: 'other' };
  const l4 = frame.layers[i + 1];
  const dhcpClient =
    l4 !== undefined && l4.proto === 'udp' && u16(l4.fields.srcPort) === DHCP_CLIENT_UDP_PORT && u16(l4.fields.dstPort) === DHCP_SERVER_UDP_PORT;
  return { kind: 'ipv4', srcMac, srcIp, dhcpClient };
}

// ── the decision ──────────────────────────────────────────────────────────────────────────────────────────────

/** Inputs of one step-7d decision. */
export interface SourceGuardCheck {
  readonly config: SourceGuardConfig;
  /** Logical port L the frame arrived on (the Port-channel for a bundled member). */
  readonly port: PortId;
  /** The frame's classified VLAN. */
  readonly vlan: number;
  /** DHCP snooping runs for `vlan` (`dhcpSnoopingActive`). */
  readonly snooping: boolean;
  readonly view: SourceGuardView;
  /** `dhcp-snooping` rows to search (any superset of the rows of (vlan, port); others are ignored). */
  readonly bindings: Iterable<DhcpSnoopingRow>;
  readonly now: SimTime;
}

/** Outcome of one decision. */
export type SourceGuardVerdict =
  /** No guard on the port: the P3a path, nothing evaluated. */
  | { readonly kind: 'skip' }
  /** A guard line, but snooping is off for the VLAN: nothing is filtered. */
  | { readonly kind: 'unfiltered'; readonly debug: string }
  /** ARP, non-IPv4 or a DHCP client message: not the guard's to judge. */
  | { readonly kind: 'exempt' }
  /** A binding admits the source. */
  | { readonly kind: 'forward'; readonly binding: DhcpSnoopingRow }
  /** `Action drop {reason: 'ip-source-guard', detail, rule}`. */
  | {
      readonly kind: 'drop';
      readonly reason: 'ip-source-guard';
      readonly detail: string;
      readonly rule: DropRule;
      readonly debug: string;
    };

/** True when `row` is an unexpired binding of (vlan, port). */
export function bindingOnPort(row: DhcpSnoopingRow, vlan: number, port: PortId, now: SimTime): boolean {
  if (row.expiresAt !== undefined && row.expiresAt <= now) return false;
  return row.vlan === vlan && row.port === port;
}

/** Drop detail, e.g. `IPv4 source 192.168.10.99 (MAC 00:…:05) on FastEthernet0/5 (vlan 10) has no source binding`. */
export function sourceGuardDropDetail(
  srcIp: Ipv4Address,
  srcMac: MacAddress,
  port: PortId,
  vlan: number,
  macMismatch: boolean,
): string {
  if (macMismatch) {
    return `IPv4 source ${srcIp} on ${port} (vlan ${vlan}) is bound to another MAC address than ${srcMac}; the port filters on address and MAC`;
  }
  return `IPv4 source ${srcIp} (MAC ${srcMac}) on ${port} (vlan ${vlan}) has no source binding on this port`;
}

/** The rule text of a step-7d drop. */
function ruleText(filter: SourceGuardFilterType): string {
  return filter === 'ip-mac'
    ? 'with "ip verify source port-security" a port forwards only IPv4 packets whose source address and Ethernet source match a DHCP snooping or static source binding on that port and VLAN'
    : 'with "ip verify source" a port forwards only IPv4 packets whose source address matches a DHCP snooping or static source binding on that port and VLAN';
}

/** The step-7d decision for one frame (see the file header for the order of the checks). */
export function decideSourceGuard(check: SourceGuardCheck): SourceGuardVerdict {
  const pc = check.config.get(check.port);
  if (pc === undefined) return { kind: 'skip' };
  const { port, vlan, view, now } = check;
  if (!check.snooping) {
    return { kind: 'unfiltered', debug: `${port} (vlan ${vlan}): IP source guard is configured but DHCP snooping is off for vlan ${vlan}; nothing is filtered` };
  }
  if (view.kind !== 'ipv4' || view.dhcpClient) return { kind: 'exempt' };
  let ipMatch: DhcpSnoopingRow | undefined;
  for (const b of check.bindings) {
    if (b.ip !== view.srcIp || !bindingOnPort(b, vlan, port, now)) continue;
    if (pc.filter === 'ip' || b.mac === view.srcMac) return { kind: 'forward', binding: b };
    ipMatch ??= b;
  }
  const macMismatch = ipMatch !== undefined;
  const rule: DropRule = {
    kind: 'ip-source-guard',
    text: ruleText(pc.filter),
    iface: port,
    config: { context: [['interface', port]], line: pc.line },
    ...(ipMatch === undefined ? {} : { table: 'dhcp-snooping' as const, key: dhcpSnoopingKey(vlan, ipMatch.mac) }),
  };
  return {
    kind: 'drop',
    reason: 'ip-source-guard',
    detail: sourceGuardDropDetail(view.srcIp, view.srcMac, port, vlan, macMismatch),
    rule,
    debug: `dropped IPv4 from ${view.srcIp} (${view.srcMac}) on ${port} (vlan ${vlan}): ${macMismatch ? 'the binding names another MAC' : 'no binding'}`,
  };
}

// ── show ip verify source ─────────────────────────────────────────────────────────────────────────────────────

/** One entry of `show ip verify source` (data; the CLI owns the layout). */
export interface SourceGuardFilterEntry {
  readonly port: PortId;
  readonly filter: SourceGuardFilterType;
  /** `active` with snooping on the VLAN, else `inactive-no-snooping`. */
  readonly state: 'active' | 'inactive-no-snooping';
  /** The bound address, or undefined for the port's deny-all entry (no binding). */
  readonly ip?: Ipv4Address;
  /** The bound MAC (filter `ip-mac` only). */
  readonly mac?: MacAddress;
  readonly vlan?: number;
}

/**
 * The entries of `show ip verify source [interface <if>]`: per guarded port (config order, or `only`), one entry per
 * unexpired binding on the port (binding order), or one entry with no address when it has none. `snoopingOn(vlan)`
 * says whether snooping runs for a VLAN; `portVlan(port)` gives the access VLAN of a port without bindings.
 */
export function sourceGuardFilters(
  config: SourceGuardConfig,
  bindings: readonly DhcpSnoopingRow[],
  snoopingOn: (vlan: number) => boolean,
  portVlan: (port: PortId) => number | undefined,
  now: SimTime,
  only?: PortId,
): SourceGuardFilterEntry[] {
  const out: SourceGuardFilterEntry[] = [];
  for (const pc of config.values()) {
    if (only !== undefined && pc.port !== only) continue;
    const mine = bindings.filter((b) => b.port === pc.port && (b.expiresAt === undefined || b.expiresAt > now));
    if (mine.length === 0) {
      const vlan = portVlan(pc.port);
      const state = vlan !== undefined && snoopingOn(vlan) ? 'active' : 'inactive-no-snooping';
      out.push(vlan === undefined ? { port: pc.port, filter: pc.filter, state } : { port: pc.port, filter: pc.filter, state, vlan });
      continue;
    }
    for (const b of mine) {
      const state = snoopingOn(b.vlan) ? 'active' : 'inactive-no-snooping';
      out.push(pc.filter === 'ip-mac'
        ? { port: pc.port, filter: pc.filter, state, ip: b.ip, mac: b.mac, vlan: b.vlan }
        : { port: pc.port, filter: pc.filter, state, ip: b.ip, vlan: b.vlan });
    }
  }
  return out;
}
