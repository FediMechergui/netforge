/**
 * protocols/acl.ts — the access-list daemon (ARCHITECTURE-P3 D12, §2.4 `acl.filter` / `acl.clear`, §2.6 `AclRow`,
 * §3.0 (a) steps 2, 6 and 7, §3.3, §4.2, §4.3, §4.5; [S13] `acl.check` / `acl.verdict`, §3.14; ARCHITECTURE-P3C §3.6
 * [S11] IPv6 lists and §7 W2a acl [S11] [S12], rulings RC5 (c) and RC6 (e)).
 *
 * The daemon owns the `acl` table (single writer), the compiled lists, the log aggregation, the ICMP rate limits and
 * `clear access-list counters`. It has no wire selector and never originates a packet except ICMP 3/13 (IPv4) or
 * ICMPv6 1/1 (IPv6) for a packet it denies; it is reached only through requests:
 *  • `acl.filter {family 4, dir, iface, inPort?, natted?, pdu, onPermit}` — from ipv4 (inbound right after the header
 *    checksum; outbound after routing and the TTL decrement) and from nat on its `filterOut` path (outbound, after the
 *    translation). The list is the one bound by `ip access-group <list> in|out` on `iface`. The answer is EXACTLY ONE
 *    of: `[onPermit]`; or a drop `{reason 'acl-deny', port: iface, detail, rule}` plus, when the rate gate is open and
 *    the packet is neither `natted` nor ineligible (below), a request icmpv4 `icmp.error {3, 13, inPort: dir 'in' ?
 *    iface : inPort}`. A `log` or [S12] `log-input` entry adds its log line (and arms `acl-log`) after the answer.
 *  • [S11] `acl.filter {family 6, …}` — from ipv6 (the W2b traffic-filter hooks): the list bound by `ipv6
 *    traffic-filter <name> in|out` on `iface` (`readTrafficFilters`), evaluated by `evaluateAcl6` with the implicit ND
 *    tail; a deny answers the drop (a family-6 `DropRule`) plus, when the family-6 gate is open, a request icmpv6
 *    `icmp6.error {1, 1, inPort}` (administratively prohibited, sourced by icmpv6 from the ingress interface).
 *  • `acl.clear {list?, family?}` — `clear access-list counters [<list>]` (family absent or 4) or [S11] `clear ipv6
 *    access-list [<name>]` (family 6): every row of that family's list (or of every list of that family) back to 0
 *    matches, without its last-match columns.
 *  • [S13] `acl.check {family 4|6, list, tuple, token, owner}` — the vty `access-class` check of a login ([S11] family
 *    6: `ipv6 access-class`): answered with ProcessEvent `acl.verdict {token, action, seq}` to `owner`, counted on the
 *    matched row with `lastIface 'vty'`.
 *
 * Family-keyed state ([S11]): each family has its own lists, bindings, applied text and ICMP gate; an IPv4 list and an
 * IPv6 list of the same name are different lists (the CLI refuses the collision, RC6 (e)). Family-4 rows, keys, drops,
 * logs and the family-4 StateView keep their P3 bytes; family-6 members are added only once a family-6 list is applied
 * or has drawn an unreachable.
 *
 * Semantics (D12): entries in sequence order, the first match decides, an implicit deny at the end (`evaluateAcl`,
 * core/acl.ts; for IPv6 `evaluateAcl6`, core/acl6.ts, whose tail is `permit icmp any any nd-na`, `permit icmp any any
 * nd-ns`, `deny ipv6 any any`). A list bound to an interface but not defined permits everything (and counts nothing);
 * so does a list without any permit or deny entry (a section just entered, or remarks only), as on real devices, where
 * the implicit deny exists only below a first entry — which also keeps a boot replay from writing a lone implicit row.
 * NAT's use of a list is never counted. The lists are read with `readAcls` / `readAcls6` and re-read on every
 * configuration delta that can change a list, a binding or `ip unreachables` (the compiled-list cache). [S12] (RC5 (c))
 * the IPv4 tuple carries the DSCP (`tupleOf(pdu, { dscp: true })`) so `dscp` / `precedence` terms match.
 *
 * Rows (`acl` table, key `aclKey(family, list, seq | 'implicit' | 'nd-na' | 'nd-ns')`): one per entry plus the
 * implicit row(s), ONLY for lists applied as filters — `ip access-group` on an interface, [S13] `access-class <list>
 * in` under `line vty` when the device runs the vty daemon (the one that enforces it), and [S11] `ipv6 traffic-filter`
 * / `ipv6 access-class` likewise. An IPv4 list has one implicit row (`implicit 'deny'`); an IPv6 list has three, in
 * evaluation order (`nd-na`, `nd-ns`, `deny`, keys `aclKey(6, list, 'nd-na' | 'nd-ns' | 'implicit')`). `applied` lists
 * every binding of the list in its family: the interfaces in canonical port order (`in` before `out`), then `vty in`
 * (e.g. 'GigabitEthernet0/0 in, vty in'). A row is rewritten only when a column changes (rule 20): a configuration
 * change that leaves an entry's text and action alone keeps its counters; each hit is one tableWrite carrying
 * `matches + 1`, `lastPdu` (absent for a vty check), `lastAt`, `lastIface` and `lastDir`. Rows are written in
 * evaluation order (family-4 lists in configuration order, then family-6 lists; entries by sequence, the implicit rows
 * last); rows of lists no longer applied are deleted ('cleared').
 *
 * Logging (`log` entries, and [S12] `log-input`, which also names the input interface and the source MAC): the first
 * packet of a flow (family, list, line, action, protocol, addresses, ports or ICMP type and code, and for `log-input`
 * the input) is logged at once, severity 6, facility `ACL`; further packets of the flow are counted, and the periodic
 * `acl-log` timer (300 s, armed when the first flow is logged and only while flows are pending) logs one aggregated
 * line per flow with packets in first-seen order, then forgets the flows that saw none.
 *
 * ICMP (D12): at most one 3/13 per `ACL_UNREACH_RATE_NS` (500 ms) per device, a SimTime comparison (no randomness);
 * none for a `natted` packet (its source is now the router's own address — a listed deviation), and none for a packet
 * icmpv4 would refuse to answer (a broadcast, multicast or 0.0.0.0 address, an ICMP message other than an echo), so
 * such a packet never closes the gate. [S12] `no ip unreachables` on the interface the error would leave by (the
 * request's `inPort`: `iface` inbound, the packet's ingress outbound, else `iface`) suppresses it without closing the
 * gate. [S11] ICMPv6 1/1 has its own gate (`ACL6_UNREACH_RATE_NS`, 500 ms; real devices limit the families
 * separately, map 02 Q2) and the same eligibility rules (no error for an unspecified or multicast source, a multicast
 * destination, or an ICMPv6 message other than an echo); `no ip unreachables` is IPv4 only.
 *
 * Silence (§4.3): with no binding the daemon writes no row, arms no timer and emits no debug line or log; a P1/P2
 * world (NAT lists included) never binds a list. Determinism: no randomness; flows and rows in fixed orders (§4.5).
 * Debug category `ip access-list` (§5.8). No module-level mutable state (§4.5): every registry here is built per call.
 *
 * stateSnapshot(): `{ process: 'acl', state: { applied: [{ list, applied }], permitted, denied, unreachablesSent,
 *   unreachablesLimited, logFlows } }` (display only; the counters a lab grades are the rows); [S11] once a family-6
 *   list is applied or an ICMPv6 1/1 was considered, also `applied6: [{ list, applied }]`, `unreachables6Sent` and
 *   `unreachables6Limited` (absent before, so a family-4 world keeps its snapshot bytes).
 */
import { isIpv4Broadcast, isIpv4Multicast, macToDotted, normalizeMac } from '../contracts/addr.js';
import type { ConfigAst, ConfigDelta, ConfigNode } from '../contracts/config.js';
import type { PortId, ProcessName } from '../contracts/ids.js';
import {
  ICMP_DEST_UNREACHABLE,
  ICMP_ECHO_REPLY,
  ICMP_ECHO_REQUEST,
  ICMP_UNREACH_ADMIN,
  ICMPV6_DEST_UNREACHABLE,
  ICMPV6_ECHO_REPLY,
  ICMPV6_ECHO_REQUEST,
  IPPROTO_ICMP,
  IPPROTO_TCP,
  IPPROTO_UDP,
} from '../contracts/pdu.js';
import type { Pdu } from '../contracts/pdu.js';
import type { Action, DebugEvent, DropRule, PacketTuple, PacketTuple6, Process, ProcessCtx, ProcessRequest, Severity, StateView } from '../contracts/process.js';
import { aclKey, type AclRow, type Table } from '../contracts/tables.js';
import { SEC, type SimTime } from '../contracts/time.js';
import type { AclVerdictEvent } from '../contracts/transport.js';
import {
  ACL_PROTOCOL_NAMES,
  aclEntryText,
  aclImplicitText,
  aclTypeOfNumber,
  evaluateAcl,
  parseAclEntry,
  readAcls,
  tupleOf,
  type AclDecision,
  type AclList,
} from '../core/acl.js';
import {
  ACL6_IMPLICIT_TAIL,
  ACL6_PROTOCOL_NAMES,
  acl6EntryText,
  evaluateAcl6,
  parseAcl6Entry,
  readAcls6,
  tupleOf6,
  type Acl6Decision,
  type Acl6List,
} from '../core/acl6.js';
import { parseIpv6 } from '../core/addr6.js';
import { vtyLineRanges } from './vty.js';

/** @since P3 Process name (`PROCESS_ORDER`: after `nat`, before `gre`, §2.1). */
export const ACL_PROCESS: ProcessName = 'acl';
/** @since P3 Debug category (`debug ip access-list`, §5.8). */
export const ACL_DEBUG_CATEGORY = 'ip access-list';
/** @since P3 Facility of the ACL log lines (D12). */
export const ACL_LOG_FACILITY = 'ACL';
/** @since P3 Severity of the ACL log lines (6, informational; D12). */
export const ACL_LOG_SEVERITY: Severity = 6;
/** @since P3 The periodic aggregation timer (§4.2). */
export const ACL_LOG_TIMER = 'acl-log';
/** @since P3 Aggregation period: one line per flow every 5 minutes (D12). */
export const ACL_LOG_INTERVAL_NS: SimTime = 300 * SEC;
/** @since P3 At most one ICMP 3/13 per device per this interval (D12, §4.1: an integer SimTime comparison). */
export const ACL_UNREACH_RATE_NS: SimTime = 500_000_000;
/**
 * @since P3c [S11] At most one ICMPv6 1/1 per device per this interval: a gate of its own, beside the IPv4 one
 * (ARCHITECTURE-P3C §3.6; real devices limit the two families separately).
 */
export const ACL6_UNREACH_RATE_NS: SimTime = 500_000_000;
/** @since P3c [S11] ICMPv6 destination-unreachable code 1, "communication administratively prohibited" (RFC 4443). */
export const ICMPV6_UNREACH_ADMIN = 1;
/** @since P3 [S13] The `lastIface` of a row counted by a vty `access-class` check. */
export const ACL_VTY_IFACE = 'vty';
/** Capacity of the per-process DebugEvent ring. */
const DEBUG_RING = 256;
const IPPROTO_ICMPV6 = 58;

/** @since P3 The lists one interface binds with `ip access-group` (D12: one per direction). */
export interface AclInterfaceGroups {
  readonly in?: string;
  readonly out?: string;
}

/**
 * @since P3 The name a list is known by in `readAcls`: a number of one of the four list ranges as plain decimal text
 * (`'010'` → `'10'`), any other name unchanged.
 */
export function aclListName(raw: string): string {
  return aclTypeOfNumber(raw) !== undefined ? String(Number(raw)) : raw;
}

/** The `<group> …` lines of a section as token lists without the group word (a group node unfolded). */
function groupLines(section: ConfigNode, group: 'ip' | 'ipv6'): string[][] {
  const out: string[][] = [];
  for (const child of section.children) {
    if (child.key !== group) continue;
    if (child.args.length === 0) for (const leaf of child.children) out.push([leaf.key, ...leaf.args]);
    else out.push(child.args.slice());
  }
  return out;
}

/** The `<keyword> <list> in|out` bindings of the interface sections, one list per direction (the later line wins). */
function readInterfaceBindings(config: Pick<ConfigAst, 'root'>, group: 'ip' | 'ipv6', keyword: string, norm: (raw: string) => string): Map<string, AclInterfaceGroups> {
  const out = new Map<string, AclInterfaceGroups>();
  for (const section of config.root.children) {
    if (section.key !== 'interface') continue;
    const name = section.args[0];
    if (name === undefined) continue;
    let groups: { in?: string; out?: string } | undefined;
    for (const l of groupLines(section, group)) {
      if (l[0] !== keyword || l[1] === undefined || (l[2] !== 'in' && l[2] !== 'out') || l.length !== 3) continue;
      groups ??= {};
      groups[l[2]] = norm(l[1]);
    }
    if (groups !== undefined) out.set(name, groups);
  }
  return out;
}

/**
 * @since P3 The `ip access-group <list> in|out` lines of a running configuration (D12): interface name as stored →
 * the list per direction (normalised by `aclListName`). The CLI keeps one line per direction; if two were stored, the
 * later one in the tree wins. Interfaces without a binding are absent. Pure.
 */
export function readAccessGroups(config: Pick<ConfigAst, 'root'>): Map<string, AclInterfaceGroups> {
  return readInterfaceBindings(config, 'ip', 'access-group', aclListName);
}

/**
 * @since P3c [S11] The `ipv6 traffic-filter <name> in|out` lines of a running configuration (§3.6): interface name as
 * stored → the IPv6 list per direction (names as typed: IPv6 lists are named only). One line per direction; if two
 * were stored, the later one in the tree wins. Interfaces without a filter are absent. Pure.
 */
export function readTrafficFilters(config: Pick<ConfigAst, 'root'>): Map<string, AclInterfaceGroups> {
  return readInterfaceBindings(config, 'ipv6', 'traffic-filter', (raw) => raw);
}

/**
 * @since P3c [S12] The interfaces (names as stored) whose section holds `no ip unreachables` (a `bothForms` slot: the
 * negation is stored as typed, as a `no ip unreachables` node of the interface section). Pure.
 */
export function readNoIpUnreachables(config: Pick<ConfigAst, 'root'>): Set<string> {
  const out = new Set<string>();
  for (const section of config.root.children) {
    if (section.key !== 'interface' || section.args[0] === undefined) continue;
    if (section.children.some((c) => c.key === 'no' && c.args.length === 2 && c.args[0] === 'ip' && c.args[1] === 'unreachables')) out.add(section.args[0]);
  }
  return out;
}

// ── [S13] the vty access-class bindings (D14) ──

/**
 * @since P3 [S13] The lists bound by `access-class <list> in` on the vty lines, each once (normalised by
 * `aclListName`), in ascending line order. Read per line through `vtyLineRanges` (W5 fix #11, applied here by the W5
 * integration step): a later, wider `line vty` section that binds another list on the same lines replaces the earlier
 * binding there, so a list no line uses any more is not reported as bound. With one section, or sections that do not
 * overlap, the result is every section's list, as before. Pure.
 */
export function readVtyAccessClasses(config: Pick<ConfigAst, 'root'>): string[] {
  const out: string[] = [];
  for (const range of vtyLineRanges(config.root)) {
    if (range.accessClass === undefined) continue;
    const name = aclListName(range.accessClass);
    if (!out.includes(name)) out.push(name);
  }
  return out;
}

// ── end [S13] ──

/** The highest vty line number read (as protocols/vty.ts: a larger stored number is clamped, never iterated). */
const VTY_LINE_NUMBER_CAP = 1023;

/**
 * @since P3c [S11] The IPv6 lists bound by `ipv6 access-class <name> in` on the vty lines, each once, in ascending
 * line order. Resolved per line as `readVtyAccessClasses` does: a later `line vty` section that binds another IPv6
 * list on the same lines replaces the earlier binding there. Pure.
 */
export function readVtyAccessClasses6(config: Pick<ConfigAst, 'root'>): string[] {
  const perLine = new Map<number, string>();
  for (const section of config.root.children) {
    if (section.key !== 'line' || section.args[0] !== 'vty') continue;
    const a = Number(section.args[1]);
    const b = section.args[2] === undefined ? a : Number(section.args[2]);
    if (!Number.isInteger(a) || !Number.isInteger(b) || a < 0 || b < 0) continue;
    const first = Math.min(a, b, VTY_LINE_NUMBER_CAP);
    const last = Math.min(Math.max(a, b), VTY_LINE_NUMBER_CAP);
    let list: string | undefined;
    for (const l of groupLines(section, 'ipv6')) {
      if (l[0] === 'access-class' && l[1] !== undefined && l[2] === 'in' && l.length === 3) list = l[1];
    }
    if (list === undefined) continue;
    for (let n = first; n <= last; n++) perLine.set(n, list);
  }
  const out: string[] = [];
  for (const n of [...perLine.keys()].sort((x, y) => x - y)) {
    const name = perLine.get(n)!;
    if (!out.includes(name)) out.push(name);
  }
  return out;
}

/** Does a configuration delta concern a list, a binding, `ip unreachables`, or a section a binding lives in? */
function isAclDelta(delta: Pick<ConfigDelta, 'op' | 'context' | 'line'>): boolean {
  const { context, line } = delta;
  if (context.length === 0) {
    if (line[0] === 'access-list') return true;
    if (line[0] === 'ip' && line[1] === 'access-list') return true;
    if (line[0] === 'ipv6' && line[1] === 'access-list') return true; // [S11]
    // the removal of an interface or a `line` section takes its bindings with it
    return delta.op === 'unset' && (line[0] === 'interface' || line[0] === 'line');
  }
  const head = context[0];
  if (head === undefined) return false;
  if (head[0] === 'ip' && head[1] === 'access-list') return true;
  if (head[0] === 'ipv6' && head[1] === 'access-list') return true; // [S11]
  if (head[0] === 'interface') {
    if (line[0] === 'ip' && (line[1] === 'access-group' || line[1] === 'unreachables')) return true; // [S12] unreachables
    return line[0] === 'ipv6' && line[1] === 'traffic-filter'; // [S11]
  }
  if (head[0] === 'line') return line[0] === 'access-class' || (line[0] === 'ipv6' && line[1] === 'access-class');
  return false;
}

/** Protocol name of a number as an extended entry shows it (`tcp`, `ospf`, else the number). */
function protocolName(proto: number, names: readonly (readonly [string, number])[] = ACL_PROTOCOL_NAMES): string {
  for (const [n, v] of names) if (v === proto) return n;
  return String(proto);
}

/**
 * `tcp 192.168.10.10(49152) -> 192.168.20.100(80)`, `icmp 10.0.0.1 -> 10.0.0.2 (8/0)`, `ospf 10.0.0.1 -> 224.0.0.5`;
 * [S11] the same shape for an IPv6 tuple (ICMPv6 shown as `icmp`). [S12] `input` (a `log-input` line) follows the
 * source: `tcp 192.168.10.10(49152) (GigabitEthernet0/0 0050.7966.6800) -> …`.
 */
function packetText(t: PacketTuple | PacketTuple6, input?: string): string {
  const v6 = t.family === 6;
  const name = protocolName(t.proto, v6 ? ACL6_PROTOCOL_NAMES : ACL_PROTOCOL_NAMES);
  const inp = input === undefined ? '' : ` (${input})`;
  if ((t.proto === IPPROTO_TCP || t.proto === IPPROTO_UDP) && t.srcPort !== undefined && t.dstPort !== undefined) {
    return `${name} ${t.src}(${t.srcPort})${inp} -> ${t.dst}(${t.dstPort})`;
  }
  if (t.proto === (v6 ? IPPROTO_ICMPV6 : IPPROTO_ICMP) && t.icmpType !== undefined) return `${name} ${t.src}${inp} -> ${t.dst} (${t.icmpType}/${t.icmpCode ?? 0})`;
  return `${name} ${t.src}${inp} -> ${t.dst}`;
}

/** `list 101 line 10` or `list 101 implicit deny`. */
function lineText(list: string, d: Pick<AclDecision, 'seq'>): string {
  return d.seq === null ? `list ${list} implicit deny` : `list ${list} line ${d.seq}`;
}

/** [S11] `ipv6 list NO-WEB6 line 10`, `ipv6 list NO-WEB6 implicit deny`, `ipv6 list NO-WEB6 implicit nd-ns`. */
function lineText6(list: string, d: Pick<Acl6Decision, 'seq' | 'implicit'>): string {
  if (d.seq !== null) return `ipv6 list ${list} line ${d.seq}`;
  return `ipv6 list ${list} implicit ${d.implicit ?? 'deny'}`;
}

/** [S11] The row key part of an IPv6 decision: the entry's number, or the implicit row that decided. */
function seqKey6(d: Pick<Acl6Decision, 'seq' | 'implicit'>): number | 'implicit' | 'nd-na' | 'nd-ns' {
  if (d.seq !== null) return d.seq;
  return d.implicit === 'nd-na' || d.implicit === 'nd-ns' ? d.implicit : 'implicit';
}

/** [S11] True for a unicast IPv6 source an error may answer (not `::`, not multicast, valid text). */
function answerable6(src: string): boolean {
  const b = parseIpv6(src);
  return b !== null && b[0] !== 0xff && !b.every((x) => x === 0);
}

/** [S11] True for ff00::/8. */
function multicast6(a: string): boolean {
  const b = parseIpv6(a);
  return b !== null && b[0] === 0xff;
}

/** [S12] `GigabitEthernet0/0 0050.7966.6800` (the input interface and the frame's source MAC), for `log-input`. */
function inputText(pdu: Pdu, iface: PortId | undefined): string | undefined {
  if (iface === undefined) return undefined;
  const link = pdu.layers[0];
  const raw = link !== undefined && link.proto === 'ethernet' && typeof link.fields['src'] === 'string' ? normalizeMac(link.fields['src']) : null;
  return raw === null ? iface : `${iface} ${macToDotted(raw)}`;
}

/** One logged flow (D12): the line it was first logged with, and the packets counted since the last line. */
interface LogFlow {
  /** `list X line N denied <packet>` (the part before the packet count). */
  readonly text: string;
  pending: number;
}

/** A row's displayed columns, for the "rewrite only when a column changes" test (rule 20). */
function sameRow(a: AclRow, b: AclRow): boolean {
  return (
    a.family === b.family && a.list === b.list && a.type === b.type && a.seq === b.seq && a.implicit === b.implicit && a.entry === b.entry
    && a.action === b.action && a.matches === b.matches && a.lastPdu === b.lastPdu && a.lastAt === b.lastAt && a.lastIface === b.lastIface
    && a.lastDir === b.lastDir && a.applied === b.applied
  );
}

/** `row` without the last-match columns (a fresh or cleared counter). */
function withoutLast(row: AclRow): AclRow {
  const out: AclRow = { ...row };
  delete out.lastPdu;
  delete out.lastAt;
  delete out.lastIface;
  delete out.lastDir;
  return out;
}

/** [S11] One family's compiled lists, bindings and ICMP gate (family-keyed state). */
interface FamilyState<L> {
  /** The compiled lists (`readAcls` / `readAcls6`), re-read on every list or binding delta. */
  lists: ReadonlyMap<string, L>;
  /** `ip access-group` / `ipv6 traffic-filter` bindings by port id (resolved against the device's ports). */
  groups: ReadonlyMap<PortId, AclInterfaceGroups>;
  /** [S13] Lists enforced by `access-class … in` / `ipv6 access-class … in` on the vty lines (only when vty runs). */
  vtyLists: readonly string[];
  /** Applied lists → their `applied` text, in configuration order (the StateView). */
  applied: ReadonlyMap<string, string>;
  /** When the last ICMP error of this family was requested (the family's rate gate). */
  lastUnreachAt: SimTime | undefined;
  unreachablesSent: number;
  unreachablesLimited: number;
}

function familyState<L>(): FamilyState<L> {
  return { lists: new Map(), groups: new Map(), vtyLists: [], applied: new Map(), lastUnreachAt: undefined, unreachablesSent: 0, unreachablesLimited: 0 };
}

class AclDaemon implements Process {
  readonly name = ACL_PROCESS;

  private readonly ring: DebugEvent[] = [];
  /** Family 4: `ip access-group`, `access-class`, ICMP 3/13. */
  private readonly v4: FamilyState<AclList> = familyState<AclList>();
  /** [S11] Family 6: `ipv6 traffic-filter`, `ipv6 access-class`, ICMPv6 1/1. */
  private readonly v6: FamilyState<Acl6List> = familyState<Acl6List>();
  /** [S12] Ports whose section stores `no ip unreachables`. */
  private noUnreachables: ReadonlySet<PortId> = new Set();
  /** Logged flows in first-seen order (D12, §4.5). */
  private readonly flows = new Map<string, LogFlow>();
  private logArmed = false;
  private permitted = 0;
  private denied = 0;

  // ── Process ──────────────────────────────────────────────────────────────

  init(ctx: ProcessCtx): Action[] {
    this.reconcile(ctx);
    return [];
  }

  onPdu(_ctx: ProcessCtx, pdu: Pdu, port: PortId): Action[] {
    // acl has no selectors and is never a deliver target: it works only through requests.
    return [{ type: 'drop', pdu, reason: 'unsupported-protocol', detail: `${ACL_PROCESS} handles no frames`, port }];
  }

  onTimer(ctx: ProcessCtx, key: string): Action[] {
    if (key !== ACL_LOG_TIMER) return [];
    const out: Action[] = [];
    for (const [k, flow] of this.flows) {
      if (flow.pending === 0) {
        this.flows.delete(k);
        continue;
      }
      out.push(this.logLine(flow.text, flow.pending));
      flow.pending = 0;
    }
    if (this.flows.size === 0) {
      this.logArmed = false;
      return out;
    }
    out.push({ type: 'timer', key: ACL_LOG_TIMER, delay: ACL_LOG_INTERVAL_NS, periodic: true });
    return out;
  }

  onConfig(ctx: ProcessCtx, delta: ConfigDelta): Action[] {
    if (!isAclDelta(delta)) return [];
    this.reconcile(ctx);
    return [];
  }

  onRequest(ctx: ProcessCtx, req: ProcessRequest): Action[] {
    switch (req.kind) {
      case 'acl.filter':
        return req.family === 6 ? this.filter6(ctx, req) : this.filter(ctx, req);
      case 'acl.clear':
        return this.clear(ctx, req.list, req.family ?? 4);
      // ── [S13] the vty access-class check (D14) ──
      case 'acl.check':
        return this.check(ctx, req);
      // ── end [S13] ──
      default:
        return [];
    }
  }

  stateSnapshot(): StateView {
    const state: Record<string, unknown> = {
      applied: Array.from(this.v4.applied, ([list, applied]) => ({ list, applied })),
      permitted: this.permitted,
      denied: this.denied,
      unreachablesSent: this.v4.unreachablesSent,
      unreachablesLimited: this.v4.unreachablesLimited,
      logFlows: this.flows.size,
    };
    // [S11] family-6 members only once there is something to show (a family-4 world keeps its snapshot bytes)
    if (this.v6.applied.size > 0 || this.v6.unreachablesSent > 0 || this.v6.unreachablesLimited > 0) {
      state['applied6'] = Array.from(this.v6.applied, ([list, applied]) => ({ list, applied }));
      state['unreachables6Sent'] = this.v6.unreachablesSent;
      state['unreachables6Limited'] = this.v6.unreachablesLimited;
    }
    return { process: ACL_PROCESS, state } as StateView;
  }

  debugEvents(): readonly DebugEvent[] {
    return this.ring;
  }

  // ── configuration and rows ───────────────────────────────────────────────

  private table(ctx: ProcessCtx): Table<AclRow> | undefined {
    return ctx.tables.get<AclRow>('acl');
  }

  /** The port a configured interface name designates (canonical id first, then case-insensitively). */
  private findPort(ctx: ProcessCtx, name: string): PortId | undefined {
    if (ctx.ports.has(name)) return name;
    const lower = name.toLowerCase();
    for (const id of ctx.ports.keys()) if (id.toLowerCase() === lower) return id;
    return undefined;
  }

  /** Interface-name bindings resolved against the device's ports. */
  private resolveGroups(ctx: ProcessCtx, byName: ReadonlyMap<string, AclInterfaceGroups>): Map<PortId, AclInterfaceGroups> {
    const groups = new Map<PortId, AclInterfaceGroups>();
    for (const [name, g] of byName) {
      const port = this.findPort(ctx, name);
      if (port !== undefined) groups.set(port, g);
    }
    return groups;
  }

  /**
   * The `applied` text of every list of `fam` that is bound and defined: interfaces in canonical port order (in before
   * out), then the vty lines; lists in configuration order.
   */
  private appliedOf<L>(ctx: ProcessCtx, fam: FamilyState<L>, defined: (name: string) => boolean): Map<string, string> {
    const bindings = new Map<string, string[]>();
    const bind = (list: string, where: string): void => {
      const have = bindings.get(list);
      if (have === undefined) bindings.set(list, [where]);
      else have.push(where);
    };
    for (const port of ctx.ports.keys()) {
      const g = fam.groups.get(port);
      if (g?.in !== undefined) bind(g.in, `${port} in`);
      if (g?.out !== undefined) bind(g.out, `${port} out`);
    }
    for (const list of fam.vtyLists) bind(list, `${ACL_VTY_IFACE} in`); // [S13]
    const applied = new Map<string, string>();
    for (const name of fam.lists.keys()) {
      const where = bindings.get(name);
      if (where !== undefined && defined(name)) applied.set(name, where.join(', '));
    }
    return applied;
  }

  /**
   * Re-read the lists and the bindings of both families (and [S12] `no ip unreachables`), then bring the rows in
   * line: one row per entry plus the implicit row(s) for every applied list that is defined, in evaluation order
   * (family 4 first); a row is written only when a column changes; rows of anything else are deleted. Idempotent;
   * nothing is written in a world without a binding.
   */
  private reconcile(ctx: ProcessCtx): void {
    const runsVty = ctx.model.processes.includes('vty');
    this.v4.lists = readAcls(ctx.config);
    this.v4.groups = this.resolveGroups(ctx, readAccessGroups(ctx.config));
    // [S13] the access-class lists are filters only where the vty daemon enforces them
    this.v4.vtyLists = runsVty ? readVtyAccessClasses(ctx.config) : [];
    this.v4.applied = this.appliedOf(ctx, this.v4, (n) => this.definedList(n) !== undefined);
    // [S11] family 6
    this.v6.lists = readAcls6(ctx.config);
    this.v6.groups = this.resolveGroups(ctx, readTrafficFilters(ctx.config));
    this.v6.vtyLists = runsVty ? readVtyAccessClasses6(ctx.config) : [];
    this.v6.applied = this.appliedOf(ctx, this.v6, (n) => this.definedList6(n) !== undefined);
    // [S12]
    const noUnreach = new Set<PortId>();
    for (const name of readNoIpUnreachables(ctx.config)) {
      const port = this.findPort(ctx, name);
      if (port !== undefined) noUnreach.add(port);
    }
    this.noUnreachables = noUnreach;

    const table = this.table(ctx);
    if (table === undefined) return;
    const wanted = new Set<string>();
    for (const [name, text] of this.v4.applied) {
      const list = this.v4.lists.get(name)!;
      const rows: AclRow[] = list.entries.map((e) => ({
        key: aclKey(4, name, e.seq), family: 4, list: name, type: list.type, seq: e.seq, entry: e.text, action: e.entry.action,
        matches: 0, applied: text, updatedAt: ctx.now,
      }));
      rows.push({
        key: aclKey(4, name, 'implicit'), family: 4, list: name, type: list.type, seq: null, implicit: 'deny', entry: aclImplicitText(list.type),
        action: 'deny', matches: 0, applied: text, updatedAt: ctx.now,
      });
      this.writeRows(ctx, table, rows, wanted);
    }
    // [S11] an IPv6 list: its entries, then the implicit tail (nd-na, nd-ns, deny)
    for (const [name, text] of this.v6.applied) {
      const list = this.v6.lists.get(name)!;
      const rows: AclRow[] = list.entries.map((e) => ({
        key: aclKey(6, name, e.seq), family: 6, list: name, type: 'ipv6', seq: e.seq, entry: e.text, action: e.entry.action,
        matches: 0, applied: text, updatedAt: ctx.now,
      }));
      for (const tail of ACL6_IMPLICIT_TAIL) {
        rows.push({
          key: aclKey(6, name, tail.seq), family: 6, list: name, type: 'ipv6', seq: null, implicit: tail.implicit, entry: tail.text,
          action: tail.entry.action, matches: 0, applied: text, updatedAt: ctx.now,
        });
      }
      this.writeRows(ctx, table, rows, wanted);
    }
    for (const row of table.rows()) if (!wanted.has(row.key)) table.delete(row.key, 'cleared');
  }

  /** Write the fresh rows of one list: an unchanged entry keeps its counters and last match; a changed one restarts. */
  private writeRows(ctx: ProcessCtx, table: Table<AclRow>, rows: readonly AclRow[], wanted: Set<string>): void {
    for (const fresh of rows) {
      wanted.add(fresh.key);
      const old = table.get(fresh.key);
      const next: AclRow =
        old !== undefined && old.entry === fresh.entry && old.action === fresh.action && old.type === fresh.type
          ? { ...old, applied: fresh.applied, updatedAt: ctx.now }
          : fresh;
      if (old !== undefined && sameRow(old, next)) continue;
      table.set(next);
    }
  }

  /** The list `name` when it filters: defined, with at least one entry (else it permits everything, D12). */
  private definedList(name: string): AclList | undefined {
    const list = this.v4.lists.get(name);
    return list !== undefined && list.entries.length > 0 ? list : undefined;
  }

  /** [S11] The IPv6 list `name` when it filters (the same rule as `definedList`). */
  private definedList6(name: string): Acl6List | undefined {
    const list = this.v6.lists.get(name);
    return list !== undefined && list.entries.length > 0 ? list : undefined;
  }

  /** Count a decision on its row (when the list is applied): one tableWrite carrying the last match. */
  private count(
    ctx: ProcessCtx,
    family: 4 | 6,
    list: string,
    seq: number | 'implicit' | 'nd-na' | 'nd-ns',
    iface: PortId | typeof ACL_VTY_IFACE,
    dir: 'in' | 'out',
    pduId: number | undefined,
  ): void {
    const table = this.table(ctx);
    if (table === undefined) return;
    const row = table.get(aclKey(family, list, seq));
    if (row === undefined) return;
    const next: AclRow = { ...withoutLast(row), matches: row.matches + 1, lastAt: ctx.now, lastIface: iface, lastDir: dir, updatedAt: ctx.now };
    if (pduId !== undefined) next.lastPdu = pduId;
    table.set(next);
  }

  // ── acl.filter ───────────────────────────────────────────────────────────

  private filter(ctx: ProcessCtx, req: Extract<ProcessRequest, { kind: 'acl.filter' }>): Action[] {
    const name = this.v4.groups.get(req.iface)?.[req.dir];
    // no binding (ipv4 and acl read the same lines, so only a fixture gets here): the packet goes on untouched
    if (name === undefined) return [req.onPermit];
    const dirWord = req.dir === 'in' ? 'inbound' : 'outbound';
    // [S12] (RC5 (c)) the DSCP rides along so `dscp` / `precedence` terms match
    const tuple = tupleOf(req.pdu, { dscp: true });
    // a PDU without an IPv4 header cannot be matched (ipv4 never hands one over)
    if (tuple === undefined) return [req.onPermit];
    const list = this.definedList(name);
    if (list === undefined) {
      // D12: a list bound to an interface but not defined (or without an entry) permits everything (nothing to count)
      this.permitted++;
      this.debug(ctx, `list ${name} is not defined: permitted ${packetText(tuple)} ${dirWord} on ${req.iface}`, {
        pdu: req.pdu.id, list: name, iface: req.iface, dir: req.dir, action: 'permit',
      });
      return [req.onPermit];
    }
    const d = evaluateAcl(list, tuple);
    this.count(ctx, 4, name, d.seq ?? 'implicit', req.iface, req.dir, req.pdu.id);
    const verb = d.action === 'permit' ? 'permitted' : 'denied';
    this.debug(ctx, `${lineText(name, d)} ${verb} ${packetText(tuple)} ${dirWord} on ${req.iface}`, {
      pdu: req.pdu.id, list: name, seq: d.seq ?? 'implicit', action: d.action, iface: req.iface, dir: req.dir,
    });
    const logs = this.logActions(name, list, d, tuple, () => inputText(req.pdu, req.dir === 'in' ? req.iface : req.inPort));
    if (d.action === 'permit') {
      this.permitted++;
      return [req.onPermit, ...logs];
    }
    this.denied++;
    const out: Action[] = [
      { type: 'drop', pdu: req.pdu, reason: 'acl-deny', detail: d.seq === null ? `ACL ${name} implicit deny` : `ACL ${name} #${d.seq}`, port: req.iface, rule: this.dropRule(ctx, name, list, d, req.iface, req.dir) },
    ];
    const icmp = this.unreachable(ctx, req, tuple);
    if (icmp !== undefined) out.push(icmp);
    return [...out, ...logs];
  }

  /**
   * The ICMP 3/13 for a denied packet, when it is due: not for a `natted` packet, not for a packet icmpv4 refuses to
   * answer (which then leaves the gate open), [S12] not when the interface the error would leave by stores `no ip
   * unreachables` (the gate stays open too), and at most one per `ACL_UNREACH_RATE_NS` per device.
   */
  private unreachable(ctx: ProcessCtx, req: Extract<ProcessRequest, { kind: 'acl.filter' }>, t: PacketTuple): Action | undefined {
    if (req.natted === true) return undefined;
    if (isIpv4Broadcast(t.dst) || isIpv4Multicast(t.dst) || isIpv4Broadcast(t.src) || isIpv4Multicast(t.src) || t.src === '0.0.0.0') return undefined;
    if (t.proto === IPPROTO_ICMP && t.icmpType !== ICMP_ECHO_REQUEST && t.icmpType !== ICMP_ECHO_REPLY) return undefined;
    const inPort = req.dir === 'in' ? req.iface : req.inPort;
    const via = inPort ?? req.iface;
    if (this.noUnreachables.has(via)) {
      this.debug(ctx, `no unreachable for ${packetText(t)}: no ip unreachables on ${via}`, { pdu: req.pdu.id, iface: via });
      return undefined;
    }
    const fam = this.v4;
    if (fam.lastUnreachAt !== undefined && ctx.now - fam.lastUnreachAt < ACL_UNREACH_RATE_NS) {
      fam.unreachablesLimited++;
      this.debug(ctx, `no unreachable for ${packetText(t)}: one was sent less than ${ACL_UNREACH_RATE_NS / 1_000_000} ms ago`, { pdu: req.pdu.id });
      return undefined;
    }
    fam.lastUnreachAt = ctx.now;
    fam.unreachablesSent++;
    return {
      type: 'request',
      to: 'icmpv4',
      req: inPort === undefined
        ? { kind: 'icmp.error', original: req.pdu, type: ICMP_DEST_UNREACHABLE, code: ICMP_UNREACH_ADMIN }
        : { kind: 'icmp.error', original: req.pdu, type: ICMP_DEST_UNREACHABLE, code: ICMP_UNREACH_ADMIN, inPort },
    };
  }

  // ── [S11] acl.filter, family 6 ───────────────────────────────────────────

  private filter6(ctx: ProcessCtx, req: Extract<ProcessRequest, { kind: 'acl.filter' }>): Action[] {
    const name = this.v6.groups.get(req.iface)?.[req.dir];
    if (name === undefined) return [req.onPermit];
    const dirWord = req.dir === 'in' ? 'inbound' : 'outbound';
    const tuple = tupleOf6(req.pdu);
    // a PDU without an IPv6 header cannot be matched (ipv6 never hands one over)
    if (tuple === undefined) return [req.onPermit];
    const list = this.definedList6(name);
    if (list === undefined) {
      this.permitted++;
      this.debug(ctx, `ipv6 list ${name} is not defined: permitted ${packetText(tuple)} ${dirWord} on ${req.iface}`, {
        pdu: req.pdu.id, family: 6, list: name, iface: req.iface, dir: req.dir, action: 'permit',
      });
      return [req.onPermit];
    }
    const d = evaluateAcl6(list, tuple);
    const seq = seqKey6(d);
    this.count(ctx, 6, name, seq, req.iface, req.dir, req.pdu.id);
    const verb = d.action === 'permit' ? 'permitted' : 'denied';
    this.debug(ctx, `${lineText6(name, d)} ${verb} ${packetText(tuple)} ${dirWord} on ${req.iface}`, {
      pdu: req.pdu.id, family: 6, list: name, seq, action: d.action, iface: req.iface, dir: req.dir,
    });
    const logs = this.logActions6(name, list, d, tuple);
    if (d.action === 'permit') {
      this.permitted++;
      return [req.onPermit, ...logs];
    }
    this.denied++;
    const out: Action[] = [
      {
        type: 'drop', pdu: req.pdu, reason: 'acl-deny', detail: d.seq === null ? `IPv6 ACL ${name} implicit deny` : `IPv6 ACL ${name} #${d.seq}`,
        port: req.iface, rule: this.dropRule6(ctx, name, list, d, req.iface, req.dir),
      },
    ];
    const icmp = this.unreachable6(ctx, req, tuple);
    if (icmp !== undefined) out.push(icmp);
    return [...out, ...logs];
  }

  /**
   * [S11] The ICMPv6 1/1 for a denied packet, when it is due: not for a source an error cannot answer (`::`, multicast)
   * or a multicast destination, not for an ICMPv6 message other than an echo (neighbour discovery included), each of
   * which leaves the gate open; at most one per `ACL6_UNREACH_RATE_NS` per device, a gate of its own.
   */
  private unreachable6(ctx: ProcessCtx, req: Extract<ProcessRequest, { kind: 'acl.filter' }>, t: PacketTuple6): Action | undefined {
    if (!answerable6(t.src) || multicast6(t.dst)) return undefined;
    if (t.proto === IPPROTO_ICMPV6 && t.icmpType !== ICMPV6_ECHO_REQUEST && t.icmpType !== ICMPV6_ECHO_REPLY) return undefined;
    const fam = this.v6;
    if (fam.lastUnreachAt !== undefined && ctx.now - fam.lastUnreachAt < ACL6_UNREACH_RATE_NS) {
      fam.unreachablesLimited++;
      this.debug(ctx, `no ICMPv6 unreachable for ${packetText(t)}: one was sent less than ${ACL6_UNREACH_RATE_NS / 1_000_000} ms ago`, { pdu: req.pdu.id, family: 6 });
      return undefined;
    }
    fam.lastUnreachAt = ctx.now;
    fam.unreachablesSent++;
    const inPort = req.dir === 'in' ? req.iface : req.inPort;
    return {
      type: 'request',
      to: 'icmpv6',
      req: inPort === undefined
        ? { kind: 'icmp6.error', original: req.pdu, type: ICMPV6_DEST_UNREACHABLE, code: ICMPV6_UNREACH_ADMIN }
        : { kind: 'icmp6.error', original: req.pdu, type: ICMPV6_DEST_UNREACHABLE, code: ICMPV6_UNREACH_ADMIN, inPort },
    };
  }

  /**
   * Where entry `seq` (canonical text `text`) of `list` lives in the running configuration: a global `access-list N …`
   * line or a child of an `ip access-list standard|extended <name>` section, found by its `ConfigNode.seq`, else by its
   * text. Undefined when neither finds it.
   */
  private entryLocation(ctx: ProcessCtx, list: string, type: AclList['type'], seq: number, text: string): DropRule['config'] {
    const candidates: { context: string[][]; line: string[]; seq: number | undefined; tokens: readonly string[] }[] = [];
    for (const node of ctx.config.root.children) {
      if (node.key === 'access-list' && node.args[0] !== undefined && aclTypeOfNumber(node.args[0]) === type && aclListName(node.args[0]) === list) {
        candidates.push({ context: [], line: [node.key, ...node.args], seq: node.seq, tokens: node.args.slice(1) });
      } else if (node.key === 'ip' && node.args[0] === 'access-list' && node.args[1] === type && node.args[2] !== undefined && aclListName(node.args[2]) === list) {
        for (const c of node.children) {
          const tokens = /^\d{1,10}$/.test(c.key) ? c.args : [c.key, ...c.args];
          candidates.push({ context: [[node.key, ...node.args]], line: [c.key, ...c.args], seq: c.seq, tokens });
        }
      }
    }
    const hit = candidates.find((c) => c.seq === seq) ?? candidates.find((c) => {
      const e = parseAclEntry(type, c.tokens);
      return e !== undefined && aclEntryText(e) === text;
    });
    return hit === undefined ? undefined : { context: hit.context, line: hit.line };
  }

  /**
   * [S11] Where entry `seq` (canonical text `text`) of IPv6 list `list` lives: a child of an `ipv6 access-list <name>`
   * section, found by its `ConfigNode.seq`, else by its text (the `sequence <n>` words stripped). Undefined when
   * neither finds it.
   */
  private entryLocation6(ctx: ProcessCtx, list: string, seq: number, text: string): DropRule['config'] {
    const candidates: { context: string[][]; line: string[]; seq: number | undefined; tokens: readonly string[] }[] = [];
    for (const node of ctx.config.root.children) {
      if (node.key !== 'ipv6' || node.args[0] !== 'access-list' || node.args[1] !== list || node.args.length !== 2) continue;
      for (const c of node.children) {
        let tokens: readonly string[] = [c.key, ...c.args];
        if (tokens[0] === 'sequence') tokens = tokens.slice(2);
        else if (/^\d{1,10}$/.test(c.key)) tokens = c.args;
        const n = tokens.length;
        if (n >= 2 && tokens[n - 2] === 'sequence') tokens = tokens.slice(0, -2);
        candidates.push({ context: [[node.key, ...node.args]], line: [c.key, ...c.args], seq: c.seq, tokens });
      }
    }
    const hit = candidates.find((c) => c.seq === seq) ?? candidates.find((c) => {
      const e = parseAcl6Entry(c.tokens);
      return e !== undefined && acl6EntryText(e) === text;
    });
    return hit === undefined ? undefined : { context: hit.context, line: hit.line };
  }

  /** The structured "why was this dropped" of a deny (D12, §2.4 DropRule). */
  private dropRule(ctx: ProcessCtx, name: string, list: AclList, d: AclDecision, iface: PortId, dir: 'in' | 'out'): DropRule {
    const dirWord = dir === 'in' ? 'inbound' : 'outbound';
    const seq = d.seq ?? 'implicit';
    const key = aclKey(4, name, seq);
    if (d.seq === null) {
      return {
        kind: 'acl', text: `denied by the implicit deny at the end of access list ${name}, ${dirWord} on ${iface}`, table: 'acl', key,
        config: { context: [['interface', iface]], line: ['ip', 'access-group', name, dir] }, iface, dir, list: name, seq, family: 4,
      };
    }
    const entry = d.index === undefined ? undefined : list.entries[d.index];
    const config = this.entryLocation(ctx, name, list.type, d.seq, entry?.text ?? '');
    const rule: DropRule = {
      kind: 'acl', text: `denied by access list ${name} line ${d.seq} (${entry?.text ?? ''}), ${dirWord} on ${iface}`, table: 'acl', key,
      iface, dir, list: name, seq, family: 4,
    };
    return config === undefined ? rule : { ...rule, config };
  }

  /** [S11] The family-6 DropRule of a deny (§3.6: rule key `aclKey(6, list, seq)`). */
  private dropRule6(ctx: ProcessCtx, name: string, list: Acl6List, d: Acl6Decision, iface: PortId, dir: 'in' | 'out'): DropRule {
    const dirWord = dir === 'in' ? 'inbound' : 'outbound';
    const seq = seqKey6(d);
    const key = aclKey(6, name, seq);
    if (d.seq === null) {
      return {
        kind: 'acl', text: `denied by the implicit deny at the end of IPv6 access list ${name}, ${dirWord} on ${iface}`, table: 'acl', key,
        config: { context: [['interface', iface]], line: ['ipv6', 'traffic-filter', name, dir] }, iface, dir, list: name, seq, family: 6,
      };
    }
    const entry = d.index === undefined ? undefined : list.entries[d.index];
    const config = this.entryLocation6(ctx, name, d.seq, entry?.text ?? '');
    const rule: DropRule = {
      kind: 'acl', text: `denied by IPv6 access list ${name} line ${d.seq} (${entry?.text ?? ''}), ${dirWord} on ${iface}`, table: 'acl', key,
      iface, dir, list: name, seq, family: 6,
    };
    return config === undefined ? rule : { ...rule, config };
  }

  // ── logging ──────────────────────────────────────────────────────────────

  private logLine(text: string, packets: number): Action {
    return { type: 'log', severity: ACL_LOG_SEVERITY, facility: ACL_LOG_FACILITY, message: `${text}, ${packets} packet${packets === 1 ? '' : 's'}` };
  }

  /** The first-packet log line of a flow, or only its count (D12); arms `acl-log` when it is not armed. */
  private flowLog(key: string, text: string): Action[] {
    const known = this.flows.get(key);
    if (known !== undefined) {
      known.pending++;
      return [];
    }
    this.flows.set(key, { text, pending: 0 });
    const out: Action[] = [this.logLine(text, 1)];
    if (!this.logArmed) {
      this.logArmed = true;
      out.push({ type: 'timer', key: ACL_LOG_TIMER, delay: ACL_LOG_INTERVAL_NS, periodic: true });
    }
    return out;
  }

  /**
   * A `log` entry's actions for one packet (D12): the first packet of a flow is logged at once and arms `acl-log`
   * when it is not armed; a later packet of a known flow is only counted for the next aggregated line. [S12] A
   * `log-input` entry logs the same way, with `input()` (the input interface and source MAC) after the source, and
   * its flows are told apart by that input too (RC5 (c)).
   */
  private logActions(name: string, list: AclList, d: AclDecision, t: PacketTuple, input?: () => string | undefined): Action[] {
    const entry = d.index === undefined ? undefined : list.entries[d.index]?.entry;
    if (entry === undefined || d.seq === null) return [];
    const logInput = entry.kind === 'extended' && entry.logInput === true;
    if (entry.log !== true && !logInput) return [];
    const verb = d.action === 'permit' ? 'permitted' : 'denied';
    const inp = logInput ? input?.() : undefined;
    const what = list.type === 'standard' ? t.src : packetText(t, inp);
    let key = list.type === 'standard'
      ? `${name}|${d.seq}|${d.action}|${t.src}`
      : `${name}|${d.seq}|${d.action}|${t.proto}|${t.src}|${t.srcPort ?? ''}|${t.dst}|${t.dstPort ?? ''}|${t.icmpType ?? ''}|${t.icmpCode ?? ''}`;
    if (logInput) key += `|${inp ?? ''}`;
    return this.flowLog(key, `list ${name} line ${d.seq} ${verb} ${what}`);
  }

  /** [S11] A `log` entry of an IPv6 list: as `logActions`, its flows keyed apart from the IPv4 ones. */
  private logActions6(name: string, list: Acl6List, d: Acl6Decision, t: PacketTuple6): Action[] {
    if (d.index === undefined || list.entries[d.index]?.entry.log !== true || d.seq === null) return [];
    const verb = d.action === 'permit' ? 'permitted' : 'denied';
    const key = `6|${name}|${d.seq}|${d.action}|${t.proto}|${t.src}|${t.srcPort ?? ''}|${t.dst}|${t.dstPort ?? ''}|${t.icmpType ?? ''}|${t.icmpCode ?? ''}`;
    return this.flowLog(key, `ipv6 list ${name} line ${d.seq} ${verb} ${packetText(t)}`);
  }

  // ── acl.clear ────────────────────────────────────────────────────────────

  /** `clear access-list counters [<list>]` (family 4) or [S11] `clear ipv6 access-list [<name>]` (family 6). */
  private clear(ctx: ProcessCtx, raw: string | undefined, family: 4 | 6): Action[] {
    const list = raw === undefined ? undefined : family === 4 ? aclListName(raw) : raw;
    const table = this.table(ctx);
    if (table === undefined) return [];
    for (const row of table.rows()) {
      if (row.family !== family) continue;
      if (list !== undefined && row.list !== list) continue;
      const next: AclRow = { ...withoutLast(row), matches: 0, updatedAt: ctx.now };
      if (sameRow(row, next)) continue;
      table.set(next);
    }
    if (family === 6) {
      this.debug(ctx, list === undefined ? 'counters cleared on every IPv6 access list' : `counters cleared on IPv6 access list ${list}`, list === undefined ? { family: 6 } : { family: 6, list });
      return [];
    }
    this.debug(ctx, list === undefined ? 'counters cleared on every access list' : `counters cleared on access list ${list}`, list === undefined ? {} : { list });
    return [];
  }

  // ── [S13] acl.check (the vty access-class, D14) ──────────────────────────

  private check(ctx: ProcessCtx, req: Extract<ProcessRequest, { kind: 'acl.check' }>): Action[] {
    const verdict = (action: 'permit' | 'deny', seq: number | 'implicit'): Action => {
      const ev: AclVerdictEvent = { kind: 'acl.verdict', token: req.token, action, seq };
      return { type: 'event', to: req.owner, ev };
    };
    const tuple = req.tuple;
    // [S11] `ipv6 access-class`: an IPv6 login is checked against the IPv6 list of that name
    if (tuple.family === 6) return this.check6(ctx, req, tuple, verdict);
    const name = aclListName(req.list);
    const list = this.definedList(name);
    if (list === undefined) {
      // an undefined list admits every login (as an undefined list bound to an interface); no entry decided
      this.permitted++;
      this.debug(ctx, `list ${name} is not defined: permitted ${packetText(tuple)} inbound on the vty lines`, { list: name, token: req.token, action: 'permit' });
      return [verdict('permit', 'implicit')];
    }
    const d = evaluateAcl(list, tuple);
    this.count(ctx, 4, name, d.seq ?? 'implicit', ACL_VTY_IFACE, 'in', undefined);
    if (d.action === 'permit') this.permitted++;
    else this.denied++;
    this.debug(ctx, `${lineText(name, d)} ${d.action === 'permit' ? 'permitted' : 'denied'} ${packetText(tuple)} inbound on the vty lines`, {
      list: name, seq: d.seq ?? 'implicit', action: d.action, token: req.token,
    });
    return [verdict(d.action, d.seq ?? 'implicit'), ...this.logActions(name, list, d, tuple)];
  }

  /**
   * [S11] The family-6 vty check: the IPv6 list `req.list` (names as typed), counted on its row with `lastIface
   * 'vty'`; a decision by an implicit row answers `seq 'implicit'` (the verdict's `seq` names no ND row).
   */
  private check6(
    ctx: ProcessCtx,
    req: Extract<ProcessRequest, { kind: 'acl.check' }>,
    tuple: PacketTuple6,
    verdict: (action: 'permit' | 'deny', seq: number | 'implicit') => Action,
  ): Action[] {
    const name = req.list;
    const list = this.definedList6(name);
    if (list === undefined) {
      this.permitted++;
      this.debug(ctx, `ipv6 list ${name} is not defined: permitted ${packetText(tuple)} inbound on the vty lines`, { family: 6, list: name, token: req.token, action: 'permit' });
      return [verdict('permit', 'implicit')];
    }
    const d = evaluateAcl6(list, tuple);
    const seq = seqKey6(d);
    this.count(ctx, 6, name, seq, ACL_VTY_IFACE, 'in', undefined);
    if (d.action === 'permit') this.permitted++;
    else this.denied++;
    this.debug(ctx, `${lineText6(name, d)} ${d.action === 'permit' ? 'permitted' : 'denied'} ${packetText(tuple)} inbound on the vty lines`, {
      family: 6, list: name, seq, action: d.action, token: req.token,
    });
    return [verdict(d.action, d.seq ?? 'implicit'), ...this.logActions6(name, list, d, tuple)];
  }
  // ── end [S13] ──

  // ── debug ────────────────────────────────────────────────────────────────

  private debug(ctx: ProcessCtx, message: string, data: Record<string, unknown>): void {
    ctx.debug(ACL_DEBUG_CATEGORY, message, data);
    this.ring.push({ at: ctx.now, device: ctx.deviceId, process: ACL_PROCESS, category: ACL_DEBUG_CATEGORY, message, data });
    if (this.ring.length > DEBUG_RING) this.ring.splice(0, this.ring.length - DEBUG_RING);
  }
}

/** @since P3 Create the access-list daemon (`name: 'acl'`, no frame selectors; D12). One instance per device. */
export function createAcl(): Process {
  return new AclDaemon();
}
