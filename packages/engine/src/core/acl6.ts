/**
 * core/acl6.ts — IPv6 access lists, matching only (ARCHITECTURE-P3C D8, §3.6; §7 W1a core) [S11].
 *
 * Lines (the grammar and storage belong to the CLI, W3a1; this module only reads them):
 *   `ipv6 access-list <name>` (section, mode config-ipv6-acl, named only) with children
 *   `[sequence <n>] permit|deny <proto> <src> [<ports>] <dst> [<ports>] [established] [<icmp6-name>|<type> [<code>]]
 *   [log] [sequence <n>]`, `remark …`. `<proto>` is `ipv6` (every packet), a name (`tcp`, `udp`, `icmp` = ICMPv6 58,
 *   `esp`, `ahp`, `sctp`, `pcp`, `hbh`) or a number 0–255; `<src>`/`<dst>` is `any`, `host <a>` or `<prefix>/<len>`.
 *   Ports on TCP and UDP only (the IPv4 named ports), `established` on TCP only, the ICMPv6 part on `icmp` only.
 *
 * Sequence numbers: `ConfigNode.seq`, else a `sequence <n>` (leading or trailing) or a leading number, else the
 * highest so far + 10 (the first entry: 10); entries are returned in sequence order (as `readAcls`).
 *
 * The implicit tail (§3.6), after the last explicit entry and in this order: `permit icmp any any nd-na`, `permit icmp
 * any any nd-ns`, `deny ipv6 any any` (`implicit: 'nd-na' | 'nd-ns' | 'deny'`). RS and RA are not in the tail, so an
 * explicit `deny ipv6 any any` breaks neighbour discovery — `lintAcl6` reports it as `nd-blocked`.
 *
 * Matching: an address matches when its first `prefixLen` bits equal the entry's network; first match wins. The
 * [S17a] fragment rule applies as in IPv4: for a non-initial fragment (no L4 fields) an entry with L4 conditions
 * matches on its L3 part when it permits and is skipped (`failed: 'fragment'`) when it denies.
 *
 * Canonical text (`acl6EntryText`): `any`, `host <a>` for a /128, else `<network>/<len>` with the host bits cleared
 * (RFC 5952 text); protocols, ports and ICMPv6 messages by name when they have one.
 *
 * Pure: no module state, no randomness.
 */
import type { Ipv6Address } from '../contracts/addr.js';
import type { ConfigAst, ConfigNode } from '../contracts/config.js';
import type { PduView } from '../contracts/pdu.js';
import type { PacketTuple6 } from '../contracts/process.js';
import {
  aclPortMatchText,
  aclPortMatches,
  aclPortsCover,
  parseAclPortMatch,
  type AclAction,
  type AclMatchField,
  type AclPortMatch,
} from './acl.js';
import { normalizeIpv6, parseCidr6, parseIpv6 } from './addr6.js';
import { ipv6Words, prefixMatches6 } from './lpm6.js';

/** @since P3c [S11] An IPv6 address set: a network and its prefix length (`any` = ::/0, `host` = /128). */
export interface Acl6Address {
  readonly network: Ipv6Address;
  readonly prefixLen: number;
}

/** @since P3c [S11] One entry of an IPv6 list. `protocol` 'ipv6' matches every IPv6 packet. */
export interface Acl6Entry {
  readonly kind: 'ipv6';
  readonly action: AclAction;
  readonly protocol: number | 'ipv6';
  readonly source: Acl6Address;
  readonly sourcePort?: AclPortMatch;
  readonly destination: Acl6Address;
  readonly destinationPort?: AclPortMatch;
  /** TCP only: the segment carries ACK or RST (stateless). */
  readonly established?: true;
  /** ICMPv6 only: the type, and the code when given. */
  readonly icmp?: { readonly type: number; readonly code?: number };
  readonly log?: true;
}

/** @since P3c [S11] An entry as `readAcls6` returns it: its sequence number and canonical text. */
export interface Acl6ListEntry {
  readonly seq: number;
  readonly entry: Acl6Entry;
  readonly text: string;
}

/** @since P3c [S11] One IPv6 list of a running configuration (named only). */
export interface Acl6List {
  readonly name: string;
  readonly type: 'ipv6';
  readonly entries: readonly Acl6ListEntry[];
  readonly remarks: readonly { readonly before: number; readonly text: string }[];
}

/** @since P3c [S11] The implicit rows of an IPv6 list, in evaluation order. */
export type Acl6Implicit = 'nd-na' | 'nd-ns' | 'deny';

/** @since P3c [S11] One entry examined by `evaluateAcl6`; the implicit rows have seq 'nd-na', 'nd-ns' or 'implicit'. */
export interface Acl6TrailStep {
  readonly seq: number | 'nd-na' | 'nd-ns' | 'implicit';
  readonly text: string;
  readonly result: 'match' | 'miss';
  readonly failed?: AclMatchField;
}

/** @since P3c [S11] The decision of an IPv6 list for one packet. */
export interface Acl6Decision {
  readonly action: AclAction;
  /** The deciding entry's sequence number; null for an implicit row (the `acl` row's `seq`). */
  readonly seq: number | null;
  /** Which implicit row decided (the `acl` row's `implicit`); absent for an explicit entry. */
  readonly implicit?: Acl6Implicit;
  /** Index of the deciding entry in `list.entries`; absent for an implicit row. */
  readonly index?: number;
  readonly trail: readonly Acl6TrailStep[];
}

/** @since P3c [S11] The protocol names an IPv6 entry accepts and shows. */
export const ACL6_PROTOCOL_NAMES: readonly (readonly [string, number])[] = Object.freeze([
  ['hbh', 0],
  ['tcp', 6],
  ['udp', 17],
  ['esp', 50],
  ['ahp', 51],
  ['icmp', 58],
  ['pcp', 108],
  ['sctp', 132],
]);

/** @since P3c [S11] The ICMPv6 message names an IPv6 entry accepts and shows: [name, type, code?]. */
export const ACL6_ICMP_NAMES: readonly (readonly [string, number, number?])[] = Object.freeze([
  ['unreachable', 1],
  ['no-route', 1, 0],
  ['no-admin', 1, 1],
  ['beyond-scope', 1, 2],
  ['address-unreachable', 1, 3],
  ['port-unreachable', 1, 4],
  ['packet-too-big', 2],
  ['time-exceeded', 3],
  ['hop-limit', 3, 0],
  ['reassembly-timeout', 3, 1],
  ['parameter-problem', 4],
  ['header', 4, 0],
  ['next-header', 4, 1],
  ['parameter-option', 4, 2],
  ['echo-request', 128],
  ['echo-reply', 129],
  ['mld-query', 130],
  ['mld-report', 131],
  ['mld-reduction', 132],
  ['router-solicitation', 133],
  ['router-advertisement', 134],
  ['nd-ns', 135],
  ['nd-na', 136],
  ['redirect', 137],
]);

const IPPROTO_TCP = 6;
const IPPROTO_UDP = 17;
const IPPROTO_ICMPV6 = 58;
const ICMPV6_NS = 135;
const ICMPV6_NA = 136;
const TCP_ACK = 0x10;
const TCP_RST = 0x04;
const TCP_FLAG_BITS: Readonly<Record<string, number>> = Object.freeze({ F: 0x01, S: 0x02, R: 0x04, P: 0x08, A: 0x10, U: 0x20, E: 0x40, C: 0x80 });
const ANY6: Acl6Address = Object.freeze({ network: '::', prefixLen: 0 });

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

function lookupName(table: readonly (readonly [string, number])[], name: string): number | undefined {
  for (const [n, v] of table) if (n === name) return v;
  return undefined;
}
function nameOf(table: readonly (readonly [string, number])[], value: number): string | undefined {
  for (const [n, v] of table) if (v === value) return n;
  return undefined;
}
function decimal(token: string | undefined, max: number): number | undefined {
  if (token === undefined || !/^\d{1,10}$/.test(token)) return undefined;
  const v = Number(token);
  return v <= max ? v : undefined;
}

function parseProtocol6(token: string | undefined): number | 'ipv6' | undefined {
  if (token === undefined) return undefined;
  if (token === 'ipv6') return 'ipv6';
  return lookupName(ACL6_PROTOCOL_NAMES, token) ?? decimal(token, 255);
}

function protocol6Text(p: number | 'ipv6'): string {
  return p === 'ipv6' ? 'ipv6' : (nameOf(ACL6_PROTOCOL_NAMES, p) ?? String(p));
}

/** Parse `any` | `host <a>` | `<prefix>/<len>` at `tokens[i]`. */
function parseAddress6(tokens: readonly string[], i: number): { value: Acl6Address; next: number } | undefined {
  const t = tokens[i];
  if (t === undefined) return undefined;
  if (t === 'any') return { value: ANY6, next: i + 1 };
  if (t === 'host') {
    const h = tokens[i + 1] === undefined ? null : normalizeIpv6(tokens[i + 1]!);
    return h === null ? undefined : { value: { network: h, prefixLen: 128 }, next: i + 2 };
  }
  if (!t.includes('/')) return undefined;
  const c = parseCidr6(t);
  return c === null ? undefined : { value: { network: c.network, prefixLen: c.prefixLen }, next: i + 1 };
}

function address6Text(a: Acl6Address): string {
  if (a.prefixLen === 0) return 'any';
  if (a.prefixLen === 128) return `host ${a.network}`;
  return `${a.network}/${a.prefixLen}`;
}

function parseIcmp6(tokens: readonly string[], i: number): { value?: { type: number; code?: number }; next: number } {
  const t = tokens[i];
  if (t === undefined) return { next: i };
  for (const [name, type, code] of ACL6_ICMP_NAMES) {
    if (name === t) return { value: code === undefined ? { type } : { type, code }, next: i + 1 };
  }
  const type = decimal(t, 255);
  if (type === undefined) return { next: i };
  const code = decimal(tokens[i + 1], 255);
  return code === undefined ? { value: { type }, next: i + 1 } : { value: { type, code }, next: i + 2 };
}

function icmp6Text(icmp: { type: number; code?: number }): string {
  for (const [name, type, code] of ACL6_ICMP_NAMES) {
    if (type === icmp.type && code === icmp.code) return name;
  }
  return icmp.code === undefined ? String(icmp.type) : `${icmp.type} ${icmp.code}`;
}

/**
 * @since P3c [S11] Parse one IPv6 entry, starting at the action (no `sequence` tokens; `readAcls6` strips them).
 * Undefined for anything else (`remark …` included).
 */
export function parseAcl6Entry(tokens: readonly string[]): Acl6Entry | undefined {
  const action = tokens[0];
  if (action !== 'permit' && action !== 'deny') return undefined;
  const hasLog = tokens.length > 2 && tokens[tokens.length - 1] === 'log';
  const body = hasLog ? tokens.slice(0, -1) : tokens;
  const protocol = parseProtocol6(body[1]);
  if (protocol === undefined) return undefined;
  const portProto = protocol === 'ipv6' ? 'ip' : protocol;
  const src = parseAddress6(body, 2);
  if (src === undefined) return undefined;
  const srcPort = parseAclPortMatch(portProto, body, src.next);
  if (srcPort === undefined) return undefined;
  const dst = parseAddress6(body, srcPort.next);
  if (dst === undefined) return undefined;
  const dstPort = parseAclPortMatch(portProto, body, dst.next);
  if (dstPort === undefined) return undefined;
  let i = dstPort.next;
  let established = false;
  if (body[i] === 'established') {
    if (protocol !== IPPROTO_TCP) return undefined;
    established = true;
    i++;
  }
  let icmp: { type: number; code?: number } | undefined;
  if (protocol === IPPROTO_ICMPV6) {
    const r = parseIcmp6(body, i);
    icmp = r.value;
    i = r.next;
  }
  if (i !== body.length) return undefined;
  const entry: Mutable<Acl6Entry> = { kind: 'ipv6', action, protocol, source: src.value, destination: dst.value };
  if (srcPort.value !== undefined) entry.sourcePort = srcPort.value;
  if (dstPort.value !== undefined) entry.destinationPort = dstPort.value;
  if (established) entry.established = true;
  if (icmp !== undefined) entry.icmp = icmp;
  if (hasLog) entry.log = true;
  return entry;
}

/** @since P3c [S11] The canonical text of an IPv6 entry, without a sequence number (the `acl` row's `entry`). */
export function acl6EntryText(e: Acl6Entry): string {
  const parts: string[] = [e.action, protocol6Text(e.protocol), address6Text(e.source)];
  const portProto = e.protocol === 'ipv6' ? 0 : e.protocol;
  if (e.sourcePort !== undefined) parts.push(aclPortMatchText(portProto, e.sourcePort));
  parts.push(address6Text(e.destination));
  if (e.destinationPort !== undefined) parts.push(aclPortMatchText(portProto, e.destinationPort));
  if (e.established === true) parts.push('established');
  if (e.icmp !== undefined) parts.push(icmp6Text(e.icmp));
  if (e.log === true) parts.push('log');
  return parts.join(' ');
}

/** @since P3c [S11] The implicit tail of every IPv6 list, in evaluation order: [implicit, seq, text, entry]. */
export const ACL6_IMPLICIT_TAIL: readonly {
  readonly implicit: Acl6Implicit;
  readonly seq: 'nd-na' | 'nd-ns' | 'implicit';
  readonly text: string;
  readonly entry: Acl6Entry;
}[] = Object.freeze([
  Object.freeze({
    implicit: 'nd-na' as const, seq: 'nd-na' as const, text: 'permit icmp any any nd-na',
    entry: Object.freeze({ kind: 'ipv6' as const, action: 'permit' as const, protocol: IPPROTO_ICMPV6, source: ANY6, destination: ANY6, icmp: Object.freeze({ type: ICMPV6_NA }) }),
  }),
  Object.freeze({
    implicit: 'nd-ns' as const, seq: 'nd-ns' as const, text: 'permit icmp any any nd-ns',
    entry: Object.freeze({ kind: 'ipv6' as const, action: 'permit' as const, protocol: IPPROTO_ICMPV6, source: ANY6, destination: ANY6, icmp: Object.freeze({ type: ICMPV6_NS }) }),
  }),
  Object.freeze({
    implicit: 'deny' as const, seq: 'implicit' as const, text: 'deny ipv6 any any',
    entry: Object.freeze({ kind: 'ipv6' as const, action: 'deny' as const, protocol: 'ipv6' as const, source: ANY6, destination: ANY6 }),
  }),
]);

interface DraftLine6 {
  readonly tokens: readonly string[];
  readonly seq?: number;
}

function validSeq(seq: number | undefined): seq is number {
  return seq !== undefined && Number.isSafeInteger(seq) && seq >= 1;
}

/** A line's own sequence number (leading `sequence <n>` or number, or trailing `sequence <n>`) and its body. */
function splitSequence(tokens: readonly string[]): { tokens: readonly string[]; seq?: number } {
  let t = tokens;
  let seq: number | undefined;
  if (t[0] === 'sequence' && t[1] !== undefined && /^\d{1,10}$/.test(t[1])) {
    seq = Number(t[1]);
    t = t.slice(2);
  } else if (t[0] !== undefined && /^\d{1,10}$/.test(t[0])) {
    seq = Number(t[0]);
    t = t.slice(1);
  }
  const n = t.length;
  if (n >= 2 && t[n - 2] === 'sequence' && /^\d{1,10}$/.test(t[n - 1]!)) {
    seq ??= Number(t[n - 1]);
    t = t.slice(0, -2);
  }
  return seq === undefined ? { tokens: t } : { tokens: t, seq };
}

function sequenceList6(lines: readonly DraftLine6[]): { entries: Acl6ListEntry[]; remarks: { before: number; text: string }[] } {
  const walked: Acl6ListEntry[] = [];
  const pending: { text: string; seq?: number; next: number }[] = [];
  const used = new Set<number>();
  let highest = 0;
  for (const line of lines) {
    const split = splitSequence(line.tokens);
    const tokens = split.tokens;
    const seq = line.seq ?? split.seq;
    if (tokens[0] === 'remark') {
      const text = tokens.slice(1).join(' ');
      pending.push(validSeq(seq) ? { text, seq, next: walked.length } : { text, next: walked.length });
      continue;
    }
    const entry = parseAcl6Entry(tokens);
    if (entry === undefined) continue;
    const n = validSeq(seq) && !used.has(seq) ? seq : highest + 10;
    used.add(n);
    if (n > highest) highest = n;
    walked.push({ seq: n, entry, text: acl6EntryText(entry) });
  }
  const entries = walked.slice().sort((a, b) => a.seq - b.seq);
  const finalIndex = new Map<Acl6ListEntry, number>(entries.map((e, i) => [e, i]));
  const remarks = pending
    .map((r, i) => {
      const before =
        r.seq !== undefined
          ? entries.filter((e) => e.seq < r.seq!).length
          : r.next < walked.length
            ? finalIndex.get(walked[r.next]!)!
            : entries.length;
      return { before, text: r.text, i };
    })
    .sort((a, b) => a.before - b.before || a.i - b.i)
    .map(({ before, text }) => ({ before, text }));
  return { entries, remarks };
}

/**
 * @since P3c [S11] Every IPv6 list of a running configuration (`ipv6 access-list <name>` sections), keyed by name, in
 * order of first appearance; entries in sequence order (see the module header). Two sections of one name are one list.
 * Pure: reads the tree, never changes it.
 */
export function readAcls6(config: Pick<ConfigAst, 'root'>): Map<string, Acl6List> {
  const drafts = new Map<string, DraftLine6[]>();
  const section = (name: string | undefined, children: readonly ConfigNode[]): void => {
    if (name === undefined) return;
    let d = drafts.get(name);
    if (d === undefined) {
      d = [];
      drafts.set(name, d);
    }
    for (const c of children) d.push(c.seq === undefined ? { tokens: [c.key, ...c.args] } : { tokens: [c.key, ...c.args], seq: c.seq });
  };
  for (const node of config.root.children) {
    if (node.key !== 'ipv6') continue;
    if (node.args[0] === 'access-list' && node.args.length === 2) section(node.args[1], node.children);
    else if (node.args.length === 0) {
      // defensive, as readAcls: a section folded under an `ipv6` group node
      for (const leaf of node.children) if (leaf.key === 'access-list' && leaf.args.length === 1) section(leaf.args[0], leaf.children);
    }
  }
  const out = new Map<string, Acl6List>();
  for (const [name, lines] of drafts) out.set(name, { name, type: 'ipv6', ...sequenceList6(lines) });
  return out;
}

/**
 * @since P3c [S11] The fields an IPv6 list matches, from the first IPv6 layer of a PDU: the extension headers are
 * walked as ip-upper does (hop-by-hop, routing, destination options, fragment), `proto` is the last next header; a
 * non-initial fragment (offset > 0) is marked `fragment: 'non-initial'` and carries no L4 fields; an initial fragment
 * that is not atomic carries none either (its payload is not decoded). Then the TCP/UDP ports, the TCP flags (packed
 * as `tupleOf` does) and the ICMPv6 type and code. Undefined without an IPv6 layer.
 */
export function tupleOf6(pdu: Pick<PduView, 'layers'>): PacketTuple6 | undefined {
  const idx = pdu.layers.findIndex((l) => l.proto === 'ipv6');
  if (idx < 0) return undefined;
  const ip = pdu.layers[idx]!.fields;
  const src = ip['src'];
  const dst = ip['dst'];
  let proto = intField(ip['nextHeader']);
  if (proto === undefined || typeof src !== 'string' || typeof dst !== 'string') return undefined;
  const tuple: Mutable<PacketTuple6> = { family: 6, proto, src, dst };
  for (let i = idx + 1; i < pdu.layers.length; i++) {
    const l = pdu.layers[i]!;
    const f = l.fields;
    if (l.proto === 'ipv6-hopopts' || l.proto === 'ipv6-dstopts' || l.proto === 'ipv6-route' || l.proto === 'ipv6-frag') {
      const nh = intField(f['nextHeader']);
      if (nh === undefined) break;
      proto = nh;
      tuple.proto = nh;
      if (l.proto === 'ipv6-frag' && (intField(f['offset']) ?? 0) !== 0) {
        tuple.fragment = 'non-initial';
        break;
      }
      continue;
    }
    if ((l.proto === 'tcp' && proto === IPPROTO_TCP) || (l.proto === 'udp' && proto === IPPROTO_UDP)) {
      const sp = intField(f['srcPort']);
      const dp = intField(f['dstPort']);
      if (sp !== undefined) tuple.srcPort = sp;
      if (dp !== undefined) tuple.dstPort = dp;
      if (l.proto === 'tcp') {
        let bits = 0;
        const letters = f['flags'];
        if (typeof letters === 'string') for (const ch of letters) bits |= TCP_FLAG_BITS[ch] ?? 0;
        tuple.tcpFlags = bits;
      }
    } else if (l.proto === 'icmpv6' && proto === IPPROTO_ICMPV6) {
      const type = intField(f['type']);
      const code = intField(f['code']);
      if (type !== undefined) tuple.icmpType = type;
      if (code !== undefined) tuple.icmpCode = code;
    }
    break;
  }
  return tuple;
}

function intField(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isInteger(v) ? v : undefined;
}

function addressMatches6(addr: Ipv6Address, a: Acl6Address): boolean {
  if (a.prefixLen === 0) return parseIpv6(addr) !== null;
  const w = ipv6Words(addr);
  const n = ipv6Words(a.network);
  return w !== null && n !== null && prefixMatches6(w, n, a.prefixLen);
}

function hasL4Conditions6(e: Acl6Entry): boolean {
  return e.sourcePort !== undefined || e.destinationPort !== undefined || e.established === true || e.icmp !== undefined;
}

/**
 * @since P3c [S11] The first part of `e` the packet fails (protocol, source, source port, destination, destination
 * port, established, ICMP, then the [S17a] fragment rule), or undefined when the entry matches.
 */
export function acl6EntryMiss(e: Acl6Entry, t: PacketTuple6): AclMatchField | undefined {
  const nonInitial = t.fragment === 'non-initial';
  if (e.protocol !== 'ipv6' && e.protocol !== t.proto) return 'protocol';
  if (!addressMatches6(t.src, e.source)) return 'source';
  if (!nonInitial && e.sourcePort !== undefined && !aclPortMatches(e.sourcePort, t.srcPort)) return 'source-port';
  if (!addressMatches6(t.dst, e.destination)) return 'destination';
  if (!nonInitial) {
    if (e.destinationPort !== undefined && !aclPortMatches(e.destinationPort, t.dstPort)) return 'destination-port';
    if (e.established === true && ((t.tcpFlags ?? 0) & (TCP_ACK | TCP_RST)) === 0) return 'established';
    if (e.icmp !== undefined) {
      if (t.icmpType !== e.icmp.type) return 'icmp';
      if (e.icmp.code !== undefined && t.icmpCode !== e.icmp.code) return 'icmp';
    }
  }
  if (nonInitial && e.action === 'deny' && hasL4Conditions6(e)) return 'fragment';
  return undefined;
}

/**
 * @since P3c [S11] Evaluate an IPv6 list for one packet: explicit entries in sequence order, then the implicit tail
 * (`nd-na`, `nd-ns`, `deny`); the first match decides. The trail lists every entry examined. (An undefined list bound
 * to an interface permits everything: that rule belongs to the callers, as in IPv4.)
 */
export function evaluateAcl6(list: Pick<Acl6List, 'entries'>, tuple: PacketTuple6): Acl6Decision {
  const trail: Acl6TrailStep[] = [];
  for (let i = 0; i < list.entries.length; i++) {
    const { seq, entry, text } = list.entries[i]!;
    const failed = acl6EntryMiss(entry, tuple);
    if (failed === undefined) {
      trail.push({ seq, text, result: 'match' });
      return { action: entry.action, seq, index: i, trail };
    }
    trail.push({ seq, text, result: 'miss', failed });
  }
  for (const row of ACL6_IMPLICIT_TAIL) {
    const failed = acl6EntryMiss(row.entry, tuple);
    if (failed === undefined) {
      trail.push({ seq: row.seq, text: row.text, result: 'match' });
      return { action: row.entry.action, seq: null, implicit: row.implicit, trail };
    }
    trail.push({ seq: row.seq, text: row.text, result: 'miss', failed });
  }
  // unreachable: the last tail row matches every packet
  return { action: 'deny', seq: null, implicit: 'deny', trail };
}

/** @since P3c [S11] The findings `lintAcl6` reports. */
export type Acl6LintCode = 'unreachable' | 'no-permit' | 'nd-blocked';

/** @since P3c [S11] One finding of `lintAcl6` (original wording). */
export interface Acl6LintFinding {
  readonly code: Acl6LintCode;
  readonly severity: 'warning' | 'info';
  readonly seq?: number;
  /** 'unreachable': the earlier entry that already matches every packet this one matches. */
  readonly coveredBy?: number;
  /** 'nd-blocked': the neighbour discovery messages the entry drops (135 = nd-ns, 136 = nd-na). */
  readonly ndTypes?: readonly number[];
  readonly text: string;
}

function addressCovers6(outer: Acl6Address, inner: Acl6Address): boolean {
  if (outer.prefixLen > inner.prefixLen) return false;
  if (outer.prefixLen === 0) return true;
  const o = ipv6Words(outer.network);
  const i = ipv6Words(inner.network);
  return o !== null && i !== null && prefixMatches6(i, o, outer.prefixLen);
}

function entryCovers6(outer: Acl6Entry, inner: Acl6Entry): boolean {
  if (outer.protocol !== 'ipv6' && outer.protocol !== inner.protocol) return false;
  if (!addressCovers6(outer.source, inner.source) || !addressCovers6(outer.destination, inner.destination)) return false;
  if (outer.action === 'deny' && hasL4Conditions6(outer) && !hasL4Conditions6(inner)) return false;
  if (!aclPortsCover(outer.sourcePort, inner.sourcePort) || !aclPortsCover(outer.destinationPort, inner.destinationPort)) return false;
  if (outer.established === true && inner.established !== true) return false;
  if (outer.icmp !== undefined) {
    if (inner.icmp === undefined || inner.icmp.type !== outer.icmp.type) return false;
    if (outer.icmp.code !== undefined && inner.icmp.code !== outer.icmp.code) return false;
  }
  return true;
}

/** True when `e` can match some ICMPv6 message of `type` (any addresses, code 0). */
function canMatchNd(e: Acl6Entry, type: number): boolean {
  if (e.protocol !== 'ipv6' && e.protocol !== IPPROTO_ICMPV6) return false;
  if (e.sourcePort !== undefined || e.destinationPort !== undefined || e.established === true) return false;
  if (e.icmp === undefined) return true;
  return e.icmp.type === type && (e.icmp.code === undefined || e.icmp.code === 0);
}

/** True when `e` matches every ICMPv6 message of `type` from any address to any address. */
function matchesAllNd(e: Acl6Entry, type: number): boolean {
  return canMatchNd(e, type) && e.source.prefixLen === 0 && e.destination.prefixLen === 0 && (e.icmp === undefined || e.icmp.code === undefined);
}

/**
 * @since P3c [S11] Findings about an IPv6 list, in sequence order, then the list-wide one:
 *   • 'unreachable' (warning): an entry an earlier entry already shadows completely;
 *   • 'nd-blocked' (warning): an explicit deny that matches neighbour solicitations (135) or advertisements (136)
 *     before any permit that admits them all, so the implicit ND permits are never reached (§3.6);
 *   • 'no-permit' (warning): no explicit permit: only neighbour discovery passes.
 */
export function lintAcl6(list: Pick<Acl6List, 'entries'>): Acl6LintFinding[] {
  const out: Acl6LintFinding[] = [];
  const entries = list.entries;
  const ndOpen = new Map<number, boolean>([[ICMPV6_NS, true], [ICMPV6_NA, true]]);
  for (let i = 0; i < entries.length; i++) {
    const { seq, entry } = entries[i]!;
    for (let j = 0; j < i; j++) {
      const earlier = entries[j]!;
      if (entryCovers6(earlier.entry, entry)) {
        out.push({
          code: 'unreachable',
          severity: 'warning',
          seq,
          coveredBy: earlier.seq,
          text: `Entry ${seq} is never used: entry ${earlier.seq} (${earlier.text}) already matches every packet it matches.`,
        });
        break;
      }
    }
    const blocked: number[] = [];
    for (const type of [ICMPV6_NS, ICMPV6_NA]) {
      if (ndOpen.get(type) !== true || !canMatchNd(entry, type)) continue;
      if (entry.action === 'deny') blocked.push(type);
      else if (matchesAllNd(entry, type)) ndOpen.set(type, false);
    }
    if (blocked.length > 0) {
      const names = blocked.map((t) => (t === ICMPV6_NS ? 'neighbour solicitations (nd-ns)' : 'neighbour advertisements (nd-na)')).join(' and ');
      out.push({
        code: 'nd-blocked',
        severity: 'warning',
        seq,
        ndTypes: blocked,
        text: `Entry ${seq} denies ${names} before any entry permits them, so the implicit neighbour-discovery permits at the end of the list are never reached and neighbours on this interface go stale. Permit icmp any any nd-ns and nd-na above it.`,
      });
      for (const t of blocked) ndOpen.set(t, false);
    }
  }
  if (!entries.some((e) => e.entry.action === 'permit')) {
    out.push({ code: 'no-permit', severity: 'warning', text: 'This list permits nothing but neighbour discovery: every other packet reaches the implicit deny.' });
  }
  return out;
}
