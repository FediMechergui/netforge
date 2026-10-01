/**
 * protocols/ip-upper.ts — the static IP upper-layer table (ARCHITECTURE-P1 §2 "Demux", §4.2).
 *
 * Wire frames reach ipv4/ipv6 through demux selectors; everything above IP is reached through THIS table instead:
 * the IP daemon looks up the protocol number (IPv4 `protocol`, IPv6 `nextHeader` of the last header) and hands the
 * packet to the named daemon with a `deliver` action, provided the device actually runs that daemon
 * (`model.processes`). ICMP errors are fanned back the same way, keyed by the protocol of the QUOTED datagram
 * (quoted 17 → udp, quoted 6 → tcp), so the transport daemons can report `sock.error` to their sockets.
 *
 * IPv4 (RFC 791 / RFC 790 numbers):   1 → icmpv4, 6 → tcp, 17 → udp; P3 (ARCHITECTURE-P3 §2.3): 89 → ospf, and the
 *                                     approved items' rows [S18] 47 → gre, [C13] 50 → gre (the tunnel owner, D27),
 *                                     [C1] 88 → eigrp.
 * IPv6 (RFC 8200, RFC 4443, RFC 4861): 58 with type 133–137 → nd, other 58 → icmpv6, 6 → tcp, 17 → udp.
 *
 * Anything without a target is the caller's `unsupported-protocol` case: ICMP protocol unreachable (3/2) for IPv4,
 * parameter problem (4/1, pointer 6) for IPv6, never for broadcast or multicast destinations. A P3 row whose daemon a
 * device does not run (every P1/P2 world) is such a case, exactly as before the row existed.
 *
 * P3 D22, the dormant switch transport: `DORMANT_TRANSPORT_OWNERS` lists the configuration lines of the P3 services
 * that own a socket on a device. On a device whose `udp` / `tcp` come only from the `managed-switch` capability row,
 * ipv4 treats IP protocols 17 / 6 as having no listener (P2's path, byte for byte) until one of these is stored
 * (`dormantTransportEligible`, `transportWakeLine`; ipv4 keeps the result as internal state, read in its `onConfig`).
 *
 * Pure data and lookups: no state, no rng, no time.
 */
import { isIpv4 } from '../contracts/addr.js';
import { CAPABILITY_PROCESSES, type Capability } from '../contracts/catalog.js';
import type { ConfigNode } from '../contracts/config.js';
import type { DeviceModel } from '../contracts/device.js';
import type { ProcessName } from '../contracts/ids.js';
import {
  IPPROTO_EIGRP,
  IPPROTO_ESP,
  IPPROTO_GRE,
  IPPROTO_ICMP,
  IPPROTO_ICMPV6,
  IPPROTO_OSPF,
  IPPROTO_TCP,
  IPPROTO_UDP,
} from '../contracts/pdu.js';
import { configTextLinesOf } from '../cli/config-text.js';

/** One row of the upper-layer table. */
export interface IpUpperEntry {
  /** IP protocol number (IPv4 `protocol`, IPv6 `nextHeader`). */
  readonly protocol: number;
  /** Daemon that consumes packets of this protocol. */
  readonly process: ProcessName;
  /** Short protocol label used in debug lines and drop details. */
  readonly label: string;
}

/**
 * IPv4 upper-layer table, in protocol-number order. P3: 89 → ospf (M4); the approved items' rows [S18] 47 → gre,
 * [C13] 50 → gre (ESP goes to the tunnel owner, which finds the SA by SPI, D27) and [C1] 88 → eigrp.
 */
export const IPV4_UPPER: readonly IpUpperEntry[] = Object.freeze([
  Object.freeze({ protocol: IPPROTO_ICMP, process: 'icmpv4', label: 'icmp' }),
  Object.freeze({ protocol: IPPROTO_TCP, process: 'tcp', label: 'tcp' }),
  Object.freeze({ protocol: IPPROTO_UDP, process: 'udp', label: 'udp' }),
  // ── [S18] GRE (D17) ──
  Object.freeze({ protocol: IPPROTO_GRE, process: 'gre', label: 'gre' }),
  // ── end [S18] ──
  // ── [C13] ESP, handed to the tunnel owner (D27) ──
  Object.freeze({ protocol: IPPROTO_ESP, process: 'gre', label: 'esp' }),
  // ── end [C13] ──
  // ── [C1] EIGRP (D26) ──
  Object.freeze({ protocol: IPPROTO_EIGRP, process: 'eigrp', label: 'eigrp' }),
  // ── end [C1] ──
  Object.freeze({ protocol: IPPROTO_OSPF, process: 'ospf', label: 'ospf' }),
]);

/** IPv6 upper-layer table, in protocol-number order (ICMPv6 neighbour discovery types are split off to `nd`). */
export const IPV6_UPPER: readonly IpUpperEntry[] = Object.freeze([
  Object.freeze({ protocol: IPPROTO_TCP, process: 'tcp', label: 'tcp' }),
  Object.freeze({ protocol: IPPROTO_UDP, process: 'udp', label: 'udp' }),
  Object.freeze({ protocol: IPPROTO_ICMPV6, process: 'icmpv6', label: 'icmpv6' }),
]);

/** First ICMPv6 type handled by `nd` (router solicitation, RFC 4861 §4.1). */
export const ND_TYPE_MIN = 133;
/** Last ICMPv6 type handled by `nd` (redirect, RFC 4861 §4.5). */
export const ND_TYPE_MAX = 137;

/** True when the device model runs `process` (a daemon absent from the model never receives deliveries). */
export function runsProcess(model: Pick<DeviceModel, 'processes'>, process: ProcessName): boolean {
  return model.processes.includes(process);
}

/** The IPv4 table row for `protocol`, whether or not the device runs the daemon. */
export function ipv4UpperEntry(protocol: number): IpUpperEntry | undefined {
  for (const e of IPV4_UPPER) if (e.protocol === protocol) return e;
  return undefined;
}

/**
 * Daemon that receives an IPv4 packet of `protocol` addressed to this device, or undefined when the protocol is
 * unknown or the device does not run its daemon (→ `unsupported-protocol` + ICMP 3/2).
 */
export function ipv4UpperProcess(model: Pick<DeviceModel, 'processes'>, protocol: number): ProcessName | undefined {
  const e = ipv4UpperEntry(protocol);
  return e !== undefined && runsProcess(model, e.process) ? e.process : undefined;
}

/**
 * Daemon that receives an IPv6 packet whose last header is `nextHeader` (with `icmpType` for ICMPv6), or undefined
 * when there is none on this device. ICMPv6 types 133–137 go to `nd`, every other ICMPv6 type to `icmpv6`.
 */
export function ipv6UpperProcess(model: Pick<DeviceModel, 'processes'>, nextHeader: number, icmpType?: number): ProcessName | undefined {
  let process: ProcessName | undefined;
  if (nextHeader === IPPROTO_ICMPV6) {
    process = icmpType !== undefined && icmpType >= ND_TYPE_MIN && icmpType <= ND_TYPE_MAX ? 'nd' : 'icmpv6';
  } else {
    for (const e of IPV6_UPPER) if (e.protocol === nextHeader) process = e.process;
  }
  return process !== undefined && runsProcess(model, process) ? process : undefined;
}

/**
 * Transport daemon that owns the datagram quoted inside an ICMP error (quoted protocol 17 → udp, 6 → tcp), or
 * undefined for any other quoted protocol or when the device does not run that daemon. Quoted ICMP is handled by
 * the ICMP daemon itself (ping jobs and probes).
 */
export function icmpErrorTarget(model: Pick<DeviceModel, 'processes'>, quotedProtocol: number): ProcessName | undefined {
  if (quotedProtocol !== IPPROTO_TCP && quotedProtocol !== IPPROTO_UDP) return undefined;
  const process = quotedProtocol === IPPROTO_TCP ? 'tcp' : 'udp';
  return runsProcess(model, process) ? process : undefined;
}

// ── P3 D22: the dormant switch transport ─────────────────────────────────────

/**
 * @since P3 One P3 service that owns a socket on the device, as the configuration that starts it (D22). The
 * transport of a managed switch wakes while at least one entry is satisfied: every prefix of `lines` is the start of
 * a stored (non-negated) line in `context`. Every entry is a line the P1 and P2 grammars refused, which is what keeps
 * the rule byte-preserving for every P1/P2 world and every file saved before P3a.
 */
export interface DormantTransportOwner {
  /** The service the lines start (the wake-up itself reads only the configuration: the daemon need not run yet). */
  readonly service: ProcessName;
  /** Where the lines are stored: `[]` = global configuration; `['line', 'vty']` = inside any `line vty …` section. */
  readonly context: readonly string[];
  /** Line prefixes that must ALL be stored (RESTCONF needs `restconf` and `ip http secure-server`). */
  readonly lines: readonly (readonly string[])[];
  /** A stored line whose token right after its prefix is one of these does not count (`transport input none`). */
  readonly except?: readonly string[];
  /** The token right after the prefix must be an IPv4 address ([S25] `logging <addr>`, the alias of `logging host`). */
  readonly address?: true;
}

/**
 * @since P3 The configuration lines that wake a managed switch's dormant transport (D22), owner l3; each approved item
 * extends it in its W1 l3 change. MUST: `ntp server`, `ntp master`, `restconf` together with `ip http secure-server`.
 * [S13]: a `transport input` line other than `none` under `line vty`, or `crypto key generate rsa` (never `line vty`
 * alone, which P1 and P2 files hold, D14). [S25]: `logging host` (and its stored alias `logging <addr>`).
 */
export const DORMANT_TRANSPORT_OWNERS: readonly DormantTransportOwner[] = Object.freeze([
  Object.freeze({ service: 'ntp', context: Object.freeze([]), lines: Object.freeze([Object.freeze(['ntp', 'server'])]) }),
  Object.freeze({ service: 'ntp', context: Object.freeze([]), lines: Object.freeze([Object.freeze(['ntp', 'master'])]) }),
  Object.freeze({
    service: 'restconf',
    context: Object.freeze([]),
    lines: Object.freeze([Object.freeze(['restconf']), Object.freeze(['ip', 'http', 'secure-server'])]),
  }),
  // ── [S13] the remote terminal (D14) ──
  Object.freeze({
    service: 'vty',
    context: Object.freeze(['line', 'vty']),
    lines: Object.freeze([Object.freeze(['transport', 'input'])]),
    except: Object.freeze(['none']),
  }),
  Object.freeze({ service: 'vty', context: Object.freeze([]), lines: Object.freeze([Object.freeze(['crypto', 'key', 'generate', 'rsa'])]) }),
  // ── end [S13] ──
  // ── [S25] remote logging: `logging host <addr>` and its alias `logging <addr>` (§5.7) ──
  Object.freeze({ service: 'logger', context: Object.freeze([]), lines: Object.freeze([Object.freeze(['logging', 'host'])]) }),
  Object.freeze({ service: 'logger', context: Object.freeze([]), lines: Object.freeze([Object.freeze(['logging'])]), address: true }),
  // ── end [S25] ──
] as DormantTransportOwner[]);

/** The capability whose transport rows are dormant (D22). */
const DORMANT_CAPABILITY: Capability = 'managed-switch';

/**
 * @since P3 True when `process` ('udp' or 'tcp') runs on `model` only because of the `managed-switch` capability
 * (D22): the model runs it, has `managed-switch`, and no other capability of the model lists it in
 * `CAPABILITY_PROCESSES` (read at call time). A router or multilayer switch (`routing`), a host, a server, the
 * controller and the lightweight AP keep a live transport.
 */
export function dormantTransportEligible(model: Pick<DeviceModel, 'processes' | 'capabilities'>, process: ProcessName): boolean {
  const caps = model.capabilities ?? [];
  if (!caps.includes(DORMANT_CAPABILITY) || !model.processes.includes(process)) return false;
  for (const cap of caps) {
    if (cap === DORMANT_CAPABILITY) continue;
    const rows = CAPABILITY_PROCESSES[cap];
    if (rows !== undefined && rows.some((r) => r.process === process)) return false;
  }
  return true;
}

/** Does the stored line (context, tokens) start with `prefix` where `entry` looks for it? */
function lineMatches(entry: DormantTransportOwner, prefix: readonly string[], context: readonly (readonly string[])[], tokens: readonly string[]): boolean {
  if (entry.context.length === 0) {
    if (context.length !== 0) return false;
  } else {
    const ctx = context[0];
    if (context.length !== 1 || ctx === undefined || !entry.context.every((t, i) => ctx[i] === t)) return false;
  }
  if (tokens.length < prefix.length || !prefix.every((t, i) => tokens[i] === t)) return false;
  const next = tokens[prefix.length];
  if (entry.address === true && (next === undefined || !isIpv4(next))) return false;
  return !(entry.except !== undefined && next !== undefined && entry.except.includes(next));
}

/**
 * @since P3 The first `DORMANT_TRANSPORT_OWNERS` entry the stored configuration satisfies (D22), or undefined when the
 * transport stays dormant. Reads the stored lines (`configTextLinesOf`), so group-folded lines (`ip http …`) and lines
 * inside sections are seen exactly as stored; negated lines never count.
 */
export function transportWakeLine(root: ConfigNode): DormantTransportOwner | undefined {
  const lines = configTextLinesOf(root).filter((l) => !l.negate);
  for (const entry of DORMANT_TRANSPORT_OWNERS) {
    if (entry.lines.every((prefix) => lines.some((l) => lineMatches(entry, prefix, l.context, l.tokens)))) return entry;
  }
  return undefined;
}
