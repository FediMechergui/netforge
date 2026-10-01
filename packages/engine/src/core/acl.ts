/**
 * core/acl.ts — standard IPv4 access lists, matching only (ARCHITECTURE-P2 D14, §3.9 "Dynamic pool", §5.2).
 *
 * Pulled forward from CCNA 3 for NAT: `ip nat inside source list <acl> …` asks whether a source address is
 * permitted. Interface filtering (`ip access-group`) and extended lists stay in P3; hit counters are not kept.
 *
 * Lines (§5.2; the grammar and storage belong to the CLI, this module only reads them):
 *   numbered  `access-list <1-99|1300-1999> permit|deny <a> [<wildcard>] | host <a> | any`   (global, multi)
 *   named     `ip access-list standard <name>` (section, mode config-std-nacl) with `permit|deny …` children
 * `remark …` entries are skipped. Numbers outside the standard ranges and `ip access-list extended` sections are
 * not standard lists and are ignored here.
 *
 * Matching: an entry matches address x when every bit that is 0 in its wildcard is equal in x and in the entry's
 * address, i.e. `((x ^ address) & ~wildcard) === 0` (a wildcard need not be contiguous). Entries are tried in order;
 * the FIRST match decides (`permit` or `deny`); an address no entry matches is denied (the implicit deny at the end
 * of every list). A list that does not exist permits nothing (`aclPermits(undefined, x)` is false): NAT then leaves
 * the packet untranslated (§3.9 step 3).
 *
 * Canonical entry (`standardAclEntryTokens`), as the device's running configuration shows it: wildcard 0.0.0.0 →
 * the bare address (`permit 10.0.0.1`, also for `host 10.0.0.1`); wildcard 255.255.255.255 → `any`; otherwise the
 * address with its wildcard bits cleared, then the wildcard (`permit 192.168.1.0 0.0.0.255` for `192.168.1.5 0.0.0.255`).
 *
 * P3 (ARCHITECTURE-P3 D12, §3.3, §5.2; §7 W1 core) adds, below the P2 functions (which keep their behaviour; the one
 * change is that `readStandardAcls` ignores a trailing `log`, so a NAT list never silently loses a logged entry):
 *   • extended IPv4 lists: protocols by number or name, source and destination with wildcards, `eq|neq|lt|gt|range`
 *     ports with the named ports of TCP and UDP, ICMP types and names, `established`, `log`, remarks
 *     (`parseAclEntry`, canonical `aclEntryText`);
 *   • `readAcls`: every standard and extended list of a running configuration, numbered and named, each entry with its
 *     sequence number (D12: `ConfigNode.seq` when set, else the highest so far + 10; global `access-list N` lines are
 *     walked first, then the entries of a section of the same number), in sequence order;
 *   • `tupleOf` (the fields a list matches, from a PDU) and `evaluateAcl` (first match wins, implicit deny) with a
 *     `trail` of every entry examined and why it missed;
 *   • `wildcardMatches`, `rangeToAces` (the fewest address/wildcard pairs covering an address range) and `lintAcl`
 *     (entries that can never match, a wildcard that looks like a subnet mask, a list that permits nothing).
 * The acl daemon (W2), NAT (P2 reader), the QoS class reader, the grader (`aclDecision`) and the web tools all read
 * lists through these functions, so they cannot disagree.
 *
 * Pure: no module state, no randomness; lists keep configuration order.
 */
import { ipv4ToU32, parseIpv4, u32ToIpv4, type Ipv4Address } from '../contracts/addr.js';
import type { ConfigAst, ConfigNode } from '../contracts/config.js';
import type { PduView } from '../contracts/pdu.js';
import type { PacketTuple } from '../contracts/process.js';

/** What an entry does with the addresses it matches. */
export type AclAction = 'permit' | 'deny';

/** One entry of a standard list: an action for the addresses that `address`/`wildcard` match. */
export interface StandardAclEntry {
  readonly action: AclAction;
  /** Canonical: the bits the wildcard ignores are 0. */
  readonly address: Ipv4Address;
  /** Wildcard (inverse) mask: 1 bits are "don't care". 0.0.0.0 = one host, 255.255.255.255 = any. */
  readonly wildcard: Ipv4Address;
}

/** A standard list: numbered lists are named by their number (`'1'`), named lists by their name. */
export interface StandardAcl {
  readonly name: string;
  readonly entries: readonly StandardAclEntry[];
}

/** Result of matching one address against a list. */
export interface AclMatch {
  readonly action: AclAction;
  /** Index of the entry that decided; absent = no entry matched (implicit deny). */
  readonly index?: number;
}

/** Wildcard of `any`. */
export const ACL_WILDCARD_ANY: Ipv4Address = '255.255.255.255';
/** Wildcard of one host. */
export const ACL_WILDCARD_HOST: Ipv4Address = '0.0.0.0';

/** True for a standard numbered list: 1–99 or 1300–1999 (numbers given as text must be plain decimal). */
export function isStandardAclNumber(n: number | string): boolean {
  const v = typeof n === 'number' ? n : /^\d{1,4}$/.test(n) ? Number(n) : Number.NaN;
  return Number.isInteger(v) && ((v >= 1 && v <= 99) || (v >= 1300 && v <= 1999));
}

function entry(action: AclAction, address: number, wildcard: number): StandardAclEntry {
  return { action, address: u32ToIpv4((address & ~wildcard) >>> 0), wildcard: u32ToIpv4(wildcard) };
}

/**
 * Parse the tokens of one entry, starting at the action: `permit|deny any`, `permit|deny host <a>`,
 * `permit|deny <a>`, `permit|deny <a> <wildcard>`. Returns undefined for anything else (including `remark …`).
 */
export function parseStandardAclEntry(tokens: readonly string[]): StandardAclEntry | undefined {
  const [act, a, b, extra] = tokens;
  if ((act !== 'permit' && act !== 'deny') || a === undefined || extra !== undefined) return undefined;
  if (a === 'any') return b === undefined ? entry(act, 0, 0xffffffff) : undefined;
  if (a === 'host') {
    const h = b === undefined ? null : parseIpv4(b);
    return h === null ? undefined : entry(act, h, 0);
  }
  const addr = parseIpv4(a);
  if (addr === null) return undefined;
  if (b === undefined) return entry(act, addr, 0);
  const wild = parseIpv4(b);
  return wild === null ? undefined : entry(act, addr, wild);
}

/** The canonical tokens of an entry (see the module header), starting at the action. */
export function standardAclEntryTokens(e: StandardAclEntry): string[] {
  if (e.wildcard === ACL_WILDCARD_ANY) return [e.action, 'any'];
  if (e.wildcard === ACL_WILDCARD_HOST) return [e.action, e.address];
  return [e.action, e.address, e.wildcard];
}

/** True when the entry's address and wildcard match `address`. */
export function aclEntryMatches(e: StandardAclEntry, address: Ipv4Address): boolean {
  const wild = ipv4ToU32(e.wildcard);
  return ((ipv4ToU32(address) ^ ipv4ToU32(e.address)) & ~wild) >>> 0 === 0;
}

/** First match wins; no match = implicit deny (no `index`). */
export function matchStandardAcl(acl: StandardAcl, address: Ipv4Address): AclMatch {
  for (let i = 0; i < acl.entries.length; i++) {
    const e = acl.entries[i]!;
    if (aclEntryMatches(e, address)) return { action: e.action, index: i };
  }
  return { action: 'deny' };
}

/** True when the list permits `address`. A list that does not exist permits nothing. */
export function aclPermits(acl: StandardAcl | undefined, address: Ipv4Address): boolean {
  return acl !== undefined && matchStandardAcl(acl, address).action === 'permit';
}

/** Build a list from entry token lines (each starting at the action); lines that do not parse are skipped. */
export function standardAclFromLines(name: string, lines: Iterable<readonly string[]>): StandardAcl {
  const entries: StandardAclEntry[] = [];
  for (const line of lines) {
    const e = parseStandardAclEntry(line);
    if (e !== undefined) entries.push(e);
  }
  return { name, entries };
}

/**
 * Every standard list of a running configuration, keyed by name (a numbered list by its number text), in order of
 * first appearance; entries keep configuration order. A named section whose name is a standard number joins the
 * numbered list of that number (one list, as on the device). Pure: reads the tree, never changes it.
 */
export function readStandardAcls(config: Pick<ConfigAst, 'root'>): Map<string, StandardAcl> {
  const lists = new Map<string, StandardAclEntry[]>();
  const add = (name: string, tokens: readonly string[]): void => {
    let list = lists.get(name);
    if (list === undefined) {
      list = [];
      lists.set(name, list);
    }
    // P3 (D12): a trailing `log` is ignored here, so NAT keeps a logged entry (parseStandardAclEntry still refuses it).
    const e = parseStandardAclEntry(withoutTrailingLog(tokens));
    if (e !== undefined) list.push(e);
  };
  const named = (raw: string | undefined, children: readonly ConfigNode[]): void => {
    if (raw === undefined) return;
    const name = isStandardAclNumber(raw) ? String(Number(raw)) : raw;
    if (!lists.has(name)) lists.set(name, []);
    for (const c of children) add(name, [c.key, ...c.args]);
  };
  for (const node of config.root.children) {
    if (node.key === 'access-list') {
      const num = node.args[0];
      if (num !== undefined && isStandardAclNumber(num)) add(String(Number(num)), node.args.slice(1));
    } else if (node.key === 'ip' && node.args[0] === 'access-list' && node.args[1] === 'standard') {
      // the section node carries every token of its mode-entering line (contracts/config.ts)
      named(node.args[2], node.children);
    } else if (node.key === 'ip' && node.args.length === 0) {
      // defensive: a folded `ip` group never holds sections, but read one if a rule table ever stores it that way
      for (const leaf of node.children) {
        if (leaf.key === 'access-list' && leaf.args[0] === 'standard') named(leaf.args[1], leaf.children);
      }
    }
  }
  const out = new Map<string, StandardAcl>();
  for (const [name, entries] of lists) out.set(name, { name, entries });
  return out;
}

// ── P3: extended lists, the unified reader, evaluation with a trail, ranges and lint (ARCHITECTURE-P3 D12) ──────

/** `tokens` without one trailing `log` (an action, a source and `log` at least); otherwise `tokens` unchanged. */
function withoutTrailingLog(tokens: readonly string[]): readonly string[] {
  return tokens.length > 2 && tokens[tokens.length - 1] === 'log' ? tokens.slice(0, -1) : tokens;
}

/** @since P3 The two kinds of IPv4 list. ([S11] would add 'ipv6'.) */
export type AclListType = 'standard' | 'extended';

/** @since P3 True for an extended numbered list: 100–199 or 2000–2699 (numbers given as text must be plain decimal). */
export function isExtendedAclNumber(n: number | string): boolean {
  const v = typeof n === 'number' ? n : /^\d{1,4}$/.test(n) ? Number(n) : Number.NaN;
  return Number.isInteger(v) && ((v >= 100 && v <= 199) || (v >= 2000 && v <= 2699));
}

/** @since P3 The list type a number names, or undefined for a number outside the four ranges. */
export function aclTypeOfNumber(n: number | string): AclListType | undefined {
  if (isStandardAclNumber(n)) return 'standard';
  if (isExtendedAclNumber(n)) return 'extended';
  return undefined;
}

/** @since P3 An address and its wildcard (1 bits are "don't care"); canonical: the ignored bits of `address` are 0. */
export interface AclAddress {
  readonly address: Ipv4Address;
  readonly wildcard: Ipv4Address;
}

/** @since P3 A port condition of an extended TCP or UDP entry; `range` is inclusive. */
export type AclPortMatch =
  | { readonly op: 'eq' | 'neq' | 'lt' | 'gt'; readonly port: number }
  | { readonly op: 'range'; readonly low: number; readonly high: number };

/** @since P3 One entry of a standard list (the P3 form of `StandardAclEntry`, with `log`). */
export interface AclStandardEntry {
  readonly kind: 'standard';
  readonly action: AclAction;
  readonly source: AclAddress;
  readonly log?: true;
}

/** @since P3 One entry of an extended list. `protocol` 'ip' matches every IPv4 packet. */
export interface AclExtendedEntry {
  readonly kind: 'extended';
  readonly action: AclAction;
  readonly protocol: number | 'ip';
  readonly source: AclAddress;
  readonly sourcePort?: AclPortMatch;
  readonly destination: AclAddress;
  readonly destinationPort?: AclPortMatch;
  /** TCP only: the segment carries ACK or RST (stateless, D12). */
  readonly established?: true;
  /** ICMP only: the type, and the code when given. */
  readonly icmp?: { readonly type: number; readonly code?: number };
  readonly log?: true;
}

/** @since P3 A permit or deny entry of either list type. */
export type AclEntry = AclStandardEntry | AclExtendedEntry;

/** @since P3 An entry of a list as `readAcls` returns it: its sequence number and canonical text (`aclEntryText`). */
export interface AclListEntry {
  readonly seq: number;
  readonly entry: AclEntry;
  readonly text: string;
}

/** @since P3 One list of a running configuration. `remarks[i].before` = the index of the entry the remark precedes. */
export interface AclList {
  /** A numbered list by its number as plain decimal text (`'101'`), a named list by its name. */
  readonly name: string;
  readonly type: AclListType;
  readonly entries: readonly AclListEntry[];
  readonly remarks: readonly { readonly before: number; readonly text: string }[];
}

/** @since P3 The protocol names an extended entry accepts and shows (a number with a name is shown by its name). */
export const ACL_PROTOCOL_NAMES: readonly (readonly [string, number])[] = Object.freeze([
  ['icmp', 1],
  ['igmp', 2],
  ['tcp', 6],
  ['udp', 17],
  ['gre', 47],
  ['esp', 50],
  ['ahp', 51],
  ['eigrp', 88],
  ['ospf', 89],
  ['pim', 103],
]);

/** @since P3 The named TCP ports an extended entry accepts and shows (`eq www` for 80). */
export const ACL_TCP_PORT_NAMES: readonly (readonly [string, number])[] = Object.freeze([
  ['bgp', 179], ['chargen', 19], ['cmd', 514], ['daytime', 13], ['discard', 9], ['domain', 53], ['echo', 7],
  ['exec', 512], ['finger', 79], ['ftp', 21], ['ftp-data', 20], ['gopher', 70], ['hostname', 101], ['ident', 113],
  ['irc', 194], ['klogin', 543], ['kshell', 544], ['login', 513], ['lpd', 515], ['nntp', 119], ['pop2', 109],
  ['pop3', 110], ['smtp', 25], ['sunrpc', 111], ['tacacs', 49], ['talk', 517], ['telnet', 23], ['time', 37],
  ['uucp', 540], ['whois', 43], ['www', 80],
]);

/** @since P3 The named UDP ports an extended entry accepts and shows (`eq snmp` for 161). */
export const ACL_UDP_PORT_NAMES: readonly (readonly [string, number])[] = Object.freeze([
  ['biff', 512], ['bootpc', 68], ['bootps', 67], ['discard', 9], ['dnsix', 195], ['domain', 53], ['echo', 7],
  ['isakmp', 500], ['mobile-ip', 434], ['nameserver', 42], ['netbios-dgm', 138], ['netbios-ns', 137],
  ['netbios-ss', 139], ['non500-isakmp', 4500], ['ntp', 123], ['rip', 520], ['snmp', 161], ['snmptrap', 162],
  ['sunrpc', 111], ['syslog', 514], ['tacacs', 49], ['talk', 517], ['tftp', 69], ['time', 37], ['who', 513],
  ['xdmcp', 177],
]);

/**
 * @since P3 The ICMP message names an extended entry accepts and shows: [name, type, code] (no code = every code of
 * the type). A (type, code) pair with a name is shown by its name, and so is a type without a code.
 */
export const ACL_ICMP_NAMES: readonly (readonly [string, number, number?])[] = Object.freeze([
  ['echo-reply', 0],
  ['unreachable', 3],
  ['net-unreachable', 3, 0],
  ['host-unreachable', 3, 1],
  ['protocol-unreachable', 3, 2],
  ['port-unreachable', 3, 3],
  ['packet-too-big', 3, 4],
  ['source-route-failed', 3, 5],
  ['network-unknown', 3, 6],
  ['host-unknown', 3, 7],
  ['administratively-prohibited', 3, 13],
  ['source-quench', 4],
  ['redirect', 5],
  ['net-redirect', 5, 0],
  ['host-redirect', 5, 1],
  ['echo', 8],
  ['router-advertisement', 9],
  ['router-solicitation', 10],
  ['time-exceeded', 11],
  ['ttl-exceeded', 11, 0],
  ['reassembly-timeout', 11, 1],
  ['parameter-problem', 12],
  ['timestamp-request', 13],
  ['timestamp-reply', 14],
  ['information-request', 15],
  ['information-reply', 16],
  ['mask-request', 17],
  ['mask-reply', 18],
  ['traceroute', 30],
]);

const IPPROTO_ICMP = 1;
const IPPROTO_TCP = 6;
const IPPROTO_UDP = 17;
/** TCP flag bits as `tupleOf` packs them (the FSRPAUEC letters of the tcp codec, low bit first). */
const TCP_FLAG_BITS: Readonly<Record<string, number>> = Object.freeze({ F: 0x01, S: 0x02, R: 0x04, P: 0x08, A: 0x10, U: 0x20, E: 0x40, C: 0x80 });
const TCP_ACK = 0x10;
const TCP_RST = 0x04;

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

function parseProtocol(token: string | undefined): number | 'ip' | undefined {
  if (token === undefined) return undefined;
  if (token === 'ip') return 'ip';
  const named = lookupName(ACL_PROTOCOL_NAMES, token);
  if (named !== undefined) return named;
  const v = decimal(token, 255);
  if (v === undefined) return undefined;
  return v === 0 ? 'ip' : v;
}

function protocolText(p: number | 'ip'): string {
  return p === 'ip' ? 'ip' : (nameOf(ACL_PROTOCOL_NAMES, p) ?? String(p));
}

function portTable(protocol: number | 'ip'): readonly (readonly [string, number])[] {
  return protocol === IPPROTO_TCP ? ACL_TCP_PORT_NAMES : ACL_UDP_PORT_NAMES;
}

function parsePort(protocol: number | 'ip', token: string | undefined): number | undefined {
  if (token === undefined) return undefined;
  return lookupName(portTable(protocol), token) ?? decimal(token, 65535);
}

function portText(protocol: number | 'ip', port: number): string {
  return nameOf(portTable(protocol), port) ?? String(port);
}

function aclAddress(addressU32: number, wildcardU32: number): AclAddress {
  return { address: u32ToIpv4((addressU32 & ~wildcardU32) >>> 0), wildcard: u32ToIpv4(wildcardU32 >>> 0) };
}

/** Parse `any` | `host <a>` | `<a> <wildcard>` at `tokens[i]`; returns the address and the next index. */
function parseAclAddress(tokens: readonly string[], i: number): { value: AclAddress; next: number } | undefined {
  const t = tokens[i];
  if (t === 'any') return { value: aclAddress(0, 0xffffffff), next: i + 1 };
  if (t === 'host') {
    const h = tokens[i + 1] === undefined ? null : parseIpv4(tokens[i + 1]!);
    return h === null ? undefined : { value: aclAddress(h, 0), next: i + 2 };
  }
  const a = t === undefined ? null : parseIpv4(t);
  const w = tokens[i + 1] === undefined ? null : parseIpv4(tokens[i + 1]!);
  if (a === null || w === null) return undefined;
  return { value: aclAddress(a, w), next: i + 2 };
}

/** Parse a port condition at `tokens[i]` (TCP and UDP only); `value` absent when `tokens[i]` is not an operator. */
function parsePortMatch(protocol: number | 'ip', tokens: readonly string[], i: number): { value?: AclPortMatch; next: number } | undefined {
  const op = tokens[i];
  if (op !== 'eq' && op !== 'neq' && op !== 'lt' && op !== 'gt' && op !== 'range') return { next: i };
  if (protocol !== IPPROTO_TCP && protocol !== IPPROTO_UDP) return undefined;
  if (op === 'range') {
    const low = parsePort(protocol, tokens[i + 1]);
    const high = parsePort(protocol, tokens[i + 2]);
    if (low === undefined || high === undefined || low > high) return undefined;
    return { value: { op, low, high }, next: i + 3 };
  }
  const port = parsePort(protocol, tokens[i + 1]);
  // `lt 0` and `gt 65535` would match nothing
  if (port === undefined || (op === 'lt' && port === 0) || (op === 'gt' && port === 65535)) return undefined;
  return { value: { op, port }, next: i + 2 };
}

function parseIcmp(tokens: readonly string[], i: number): { value?: { type: number; code?: number }; next: number } {
  const t = tokens[i];
  if (t === undefined) return { next: i };
  for (const [name, type, code] of ACL_ICMP_NAMES) {
    if (name === t) return { value: code === undefined ? { type } : { type, code }, next: i + 1 };
  }
  const type = decimal(t, 255);
  if (type === undefined) return { next: i };
  const code = decimal(tokens[i + 1], 255);
  return code === undefined ? { value: { type }, next: i + 1 } : { value: { type, code }, next: i + 2 };
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

/**
 * @since P3 Parse one entry of a list of `type`, starting at the action: standard `permit|deny any | host <a> | <a>
 * [<wildcard>] [log]`; extended `permit|deny <protocol> <source> [<ports>] <destination> [<ports>] [established]
 * [<icmp-name> | <type> [<code>]] [log]` (ports on TCP and UDP only, `established` on TCP only, the ICMP part on
 * ICMP only; an address is `any`, `host <a>` or `<a> <wildcard>`; protocol 0 is `ip`). Undefined for anything else
 * (`remark …` included).
 */
export function parseAclEntry(type: AclListType, tokens: readonly string[]): AclEntry | undefined {
  const action = tokens[0];
  if (action !== 'permit' && action !== 'deny') return undefined;
  const hasLog = tokens.length > 2 && tokens[tokens.length - 1] === 'log';
  const body = hasLog ? tokens.slice(0, -1) : tokens;
  if (type === 'standard') {
    const e = parseStandardAclEntry(body);
    if (e === undefined) return undefined;
    const out: AclStandardEntry = { kind: 'standard', action, source: { address: e.address, wildcard: e.wildcard } };
    return hasLog ? { ...out, log: true } : out;
  }
  const protocol = parseProtocol(body[1]);
  if (protocol === undefined) return undefined;
  const src = parseAclAddress(body, 2);
  if (src === undefined) return undefined;
  const srcPort = parsePortMatch(protocol, body, src.next);
  if (srcPort === undefined) return undefined;
  const dst = parseAclAddress(body, srcPort.next);
  if (dst === undefined) return undefined;
  const dstPort = parsePortMatch(protocol, body, dst.next);
  if (dstPort === undefined) return undefined;
  let i = dstPort.next;
  let established = false;
  if (body[i] === 'established') {
    if (protocol !== IPPROTO_TCP) return undefined;
    established = true;
    i++;
  }
  let icmp: { type: number; code?: number } | undefined;
  if (protocol === IPPROTO_ICMP) {
    const r = parseIcmp(body, i);
    icmp = r.value;
    i = r.next;
  }
  if (i !== body.length) return undefined;
  const entry: Mutable<AclExtendedEntry> = { kind: 'extended', action, protocol, source: src.value, destination: dst.value };
  if (srcPort.value !== undefined) entry.sourcePort = srcPort.value;
  if (dstPort.value !== undefined) entry.destinationPort = dstPort.value;
  if (established) entry.established = true;
  if (icmp !== undefined) entry.icmp = icmp;
  if (hasLog) entry.log = true;
  return entry;
}

function standardAddressText(a: AclAddress): string {
  if (a.wildcard === ACL_WILDCARD_ANY) return 'any';
  if (a.wildcard === ACL_WILDCARD_HOST) return a.address;
  return `${a.address} ${a.wildcard}`;
}

function extendedAddressText(a: AclAddress): string {
  if (a.wildcard === ACL_WILDCARD_ANY) return 'any';
  if (a.wildcard === ACL_WILDCARD_HOST) return `host ${a.address}`;
  return `${a.address} ${a.wildcard}`;
}

function portMatchText(protocol: number | 'ip', m: AclPortMatch): string {
  return m.op === 'range' ? `range ${portText(protocol, m.low)} ${portText(protocol, m.high)}` : `${m.op} ${portText(protocol, m.port)}`;
}

function icmpText(icmp: { type: number; code?: number }): string {
  for (const [name, type, code] of ACL_ICMP_NAMES) {
    if (type === icmp.type && code === icmp.code) return name;
  }
  return icmp.code === undefined ? String(icmp.type) : `${icmp.type} ${icmp.code}`;
}

/**
 * @since P3 The canonical text of an entry, without a sequence number, as the running configuration and `show
 * access-lists` show it (and the `acl` row's `entry`): standard `permit 192.168.10.0 0.0.0.255` (a host as the bare
 * address, as P2's `standardAclEntryTokens`); extended `deny tcp host 192.168.10.10 host 192.168.20.100 eq www log`
 * (a host as `host <a>`; protocols, ports and ICMP messages by name when they have one).
 */
export function aclEntryText(e: AclEntry): string {
  const parts: string[] = [e.action];
  if (e.kind === 'standard') {
    parts.push(standardAddressText(e.source));
  } else {
    parts.push(protocolText(e.protocol), extendedAddressText(e.source));
    if (e.sourcePort !== undefined) parts.push(portMatchText(e.protocol, e.sourcePort));
    parts.push(extendedAddressText(e.destination));
    if (e.destinationPort !== undefined) parts.push(portMatchText(e.protocol, e.destinationPort));
    if (e.established === true) parts.push('established');
    if (e.icmp !== undefined) parts.push(icmpText(e.icmp));
  }
  if (e.log === true) parts.push('log');
  return parts.join(' ');
}

/** @since P3 The text of the implicit last entry of a list (never printed by `show access-lists`, D12). */
export function aclImplicitText(type: AclListType): string {
  return type === 'standard' ? 'deny any' : 'deny ip any any';
}

interface DraftLine {
  readonly tokens: readonly string[];
  readonly seq?: number;
}

interface ListDraft {
  readonly type: AclListType;
  readonly global: DraftLine[];
  readonly section: DraftLine[];
}

function draftLine(tokens: readonly string[], seq: number | undefined): DraftLine {
  return seq === undefined ? { tokens } : { tokens, seq };
}

/**
 * @since P3 Every standard and extended IPv4 list of a running configuration, keyed by name (a numbered list by its
 * number as plain decimal text), in order of first appearance.
 *   • Sources: global `access-list <n> …` lines (the number decides the type) and `ip access-list standard|extended
 *     <name>` sections. A section named by a number of its type joins the numbered list (P2's join rule); the global
 *     lines come first, then the section's entries (D12).
 *   • Sequence numbers: `ConfigNode.seq` (or a leading number token), the number the CLI gave the entry (W1 cli,
 *     `ConfigAst.apply`); a line without one, or with a number another entry of the list already took, gets the
 *     highest number so far + 10 (the first entry: 10). A list read after a reload is therefore numbered 10, 20, …
 *     like the device. Entries are returned in sequence order — the order the device evaluates them in, so an entry
 *     inserted into a numbered section below the global lines' numbers comes before them.
 *   • `remark …` lines are kept in `remarks` (a remark takes no number of its own unless it carries one); entries that
 *     do not parse for the list's type are skipped; a name used by both types keeps the type seen first and skips the
 *     other type's lines.
 * Pure: reads the tree, never changes it.
 */
export function readAcls(config: Pick<ConfigAst, 'root'>): Map<string, AclList> {
  const drafts = new Map<string, ListDraft>();
  const draft = (name: string, type: AclListType): ListDraft | undefined => {
    let d = drafts.get(name);
    if (d === undefined) {
      d = { type, global: [], section: [] };
      drafts.set(name, d);
    }
    return d.type === type ? d : undefined;
  };
  const section = (type: string | undefined, raw: string | undefined, children: readonly ConfigNode[]): void => {
    if ((type !== 'standard' && type !== 'extended') || raw === undefined) return;
    const numbered = type === 'standard' ? isStandardAclNumber(raw) : isExtendedAclNumber(raw);
    const d = draft(numbered ? String(Number(raw)) : raw, type);
    if (d === undefined) return;
    for (const c of children) d.section.push(draftLine([c.key, ...c.args], c.seq));
  };
  for (const node of config.root.children) {
    if (node.key === 'access-list') {
      const num = node.args[0];
      const type = num === undefined ? undefined : aclTypeOfNumber(num);
      if (num === undefined || type === undefined) continue;
      draft(String(Number(num)), type)?.global.push(draftLine(node.args.slice(1), node.seq));
    } else if (node.key === 'ip' && node.args[0] === 'access-list') {
      // the section node carries every token of its mode-entering line (contracts/config.ts)
      section(node.args[1], node.args[2], node.children);
    } else if (node.key === 'ip' && node.args.length === 0) {
      // defensive, as readStandardAcls: a section folded under an `ip` group node
      for (const leaf of node.children) {
        if (leaf.key === 'access-list') section(leaf.args[0], leaf.args[1], leaf.children);
      }
    }
  }
  const out = new Map<string, AclList>();
  for (const [name, d] of drafts) out.set(name, { name, type: d.type, ...sequenceList(d) });
  return out;
}

/** A sequence number a line gives: a positive safe integer. */
function validSeq(seq: number | undefined): seq is number {
  return seq !== undefined && Number.isSafeInteger(seq) && seq >= 1;
}

/**
 * The entries of one list in sequence order, and its remarks (see `readAcls`). Lines are walked global lines first,
 * then the section's; an entry keeps the number it gives unless another entry already took it, otherwise it gets the
 * highest number so far + 10 (the CLI's rule, so a list read after a reload is numbered 10, 20, …). The entries are
 * then ordered by number (the walk order among equal ones cannot occur: numbers are unique). A remark with a number
 * goes before the first entry above it; one without stays before the entry that followed it in the walk.
 */
function sequenceList(d: ListDraft): { entries: AclListEntry[]; remarks: { before: number; text: string }[] } {
  const walked: AclListEntry[] = [];
  const pending: { text: string; seq?: number; next: number }[] = [];
  const used = new Set<number>();
  let highest = 0;
  for (const line of [...d.global, ...d.section]) {
    let tokens = line.tokens;
    let seq = line.seq;
    if (tokens[0] !== undefined && /^\d{1,10}$/.test(tokens[0])) {
      seq ??= Number(tokens[0]);
      tokens = tokens.slice(1);
    }
    if (tokens[0] === 'remark') {
      const text = tokens.slice(1).join(' ');
      pending.push(validSeq(seq) ? { text, seq, next: walked.length } : { text, next: walked.length });
      continue;
    }
    const entry = parseAclEntry(d.type, tokens);
    if (entry === undefined) continue;
    const n = validSeq(seq) && !used.has(seq) ? seq : highest + 10;
    used.add(n);
    if (n > highest) highest = n;
    walked.push({ seq: n, entry, text: aclEntryText(entry) });
  }
  const entries = walked.slice().sort((a, b) => a.seq - b.seq);
  const finalIndex = new Map<AclListEntry, number>(entries.map((e, i) => [e, i]));
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

/** @since P3 True when `addr` falls in the set `base`/`wildcard` describe: `((addr ^ base) & ~wildcard) === 0`. */
export function wildcardMatches(addr: Ipv4Address, base: Ipv4Address, wildcard: Ipv4Address): boolean {
  return ((ipv4ToU32(addr) ^ ipv4ToU32(base)) & ~ipv4ToU32(wildcard)) >>> 0 === 0;
}

function intField(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isInteger(v) ? v : undefined;
}

/**
 * @since P3 The fields an access list matches (contracts `PacketTuple`), from the first IPv4 layer of a PDU and the
 * layer right after it: the TCP and UDP ports, the TCP flags packed as bits (FIN 0x01, SYN 0x02, RST 0x04, PSH 0x08,
 * ACK 0x10, URG 0x20, ECE 0x40, CWR 0x80), the ICMP type and code (an ICMP error's quoted datagram is never read). A
 * non-initial fragment carries no transport fields. Undefined without an IPv4 layer.
 */
export function tupleOf(pdu: Pick<PduView, 'layers'>): PacketTuple | undefined {
  const i = pdu.layers.findIndex((l) => l.proto === 'ipv4');
  if (i < 0) return undefined;
  const ip = pdu.layers[i]!.fields;
  const proto = intField(ip['protocol']);
  const src = ip['src'];
  const dst = ip['dst'];
  if (proto === undefined || typeof src !== 'string' || typeof dst !== 'string') return undefined;
  const tuple: Mutable<PacketTuple> = { family: 4, proto, src, dst };
  const up = pdu.layers[i + 1];
  if (up === undefined || (intField(ip['fragOffset']) ?? 0) !== 0) return tuple;
  const f = up.fields;
  if ((up.proto === 'tcp' && proto === IPPROTO_TCP) || (up.proto === 'udp' && proto === IPPROTO_UDP)) {
    const sp = intField(f['srcPort']);
    const dp = intField(f['dstPort']);
    if (sp !== undefined) tuple.srcPort = sp;
    if (dp !== undefined) tuple.dstPort = dp;
    if (up.proto === 'tcp') {
      let bits = 0;
      const letters = f['flags'];
      if (typeof letters === 'string') for (const ch of letters) bits |= TCP_FLAG_BITS[ch] ?? 0;
      tuple.tcpFlags = bits;
    }
  } else if (up.proto === 'icmpv4' && proto === IPPROTO_ICMP) {
    const type = intField(f['type']);
    const code = intField(f['code']);
    if (type !== undefined) tuple.icmpType = type;
    if (code !== undefined) tuple.icmpCode = code;
  }
  return tuple;
}

/** @since P3 The part of an entry a packet failed first (the trail's reason). */
export type AclMatchField = 'protocol' | 'source' | 'source-port' | 'destination' | 'destination-port' | 'established' | 'icmp';

/** @since P3 One entry examined by `evaluateAcl`, in order; the implicit entry has `seq: 'implicit'`. */
export interface AclTrailStep {
  readonly seq: number | 'implicit';
  readonly text: string;
  readonly result: 'match' | 'miss';
  /** Why it missed (absent on a match). */
  readonly failed?: AclMatchField;
}

/** @since P3 The decision of a list for one packet (D12): the deciding entry, or the implicit deny. */
export interface AclDecision {
  readonly action: AclAction;
  /** The deciding entry's sequence number; null for the implicit deny (the `acl` row's `seq`). */
  readonly seq: number | null;
  readonly implicit?: 'deny';
  /** Index of the deciding entry in `list.entries`; absent for the implicit deny. */
  readonly index?: number;
  /** Every entry examined, in order, ending with the deciding one (or the implicit entry). */
  readonly trail: readonly AclTrailStep[];
}

function portMatches(m: AclPortMatch, port: number | undefined): boolean {
  if (port === undefined) return false;
  switch (m.op) {
    case 'eq':
      return port === m.port;
    case 'neq':
      return port !== m.port;
    case 'lt':
      return port < m.port;
    case 'gt':
      return port > m.port;
    case 'range':
      return port >= m.low && port <= m.high;
  }
}

/**
 * @since P3 The first part of `e` that the packet fails, in the order protocol, source, source port, destination,
 * destination port, established, ICMP; undefined when the entry matches. A standard entry reads the source only.
 */
export function aclEntryMiss(e: AclEntry, t: PacketTuple): AclMatchField | undefined {
  if (e.kind === 'standard') return wildcardMatches(t.src, e.source.address, e.source.wildcard) ? undefined : 'source';
  if (e.protocol !== 'ip' && e.protocol !== t.proto) return 'protocol';
  if (!wildcardMatches(t.src, e.source.address, e.source.wildcard)) return 'source';
  if (e.sourcePort !== undefined && !portMatches(e.sourcePort, t.srcPort)) return 'source-port';
  if (!wildcardMatches(t.dst, e.destination.address, e.destination.wildcard)) return 'destination';
  if (e.destinationPort !== undefined && !portMatches(e.destinationPort, t.dstPort)) return 'destination-port';
  if (e.established === true && ((t.tcpFlags ?? 0) & (TCP_ACK | TCP_RST)) === 0) return 'established';
  if (e.icmp !== undefined) {
    if (t.icmpType !== e.icmp.type) return 'icmp';
    if (e.icmp.code !== undefined && t.icmpCode !== e.icmp.code) return 'icmp';
  }
  return undefined;
}

/**
 * @since P3 Evaluate a list for one packet: entries in sequence order, the first match decides; a packet no entry
 * matches is denied by the implicit entry (D12). The trail lists every entry examined. (An undefined list bound to an
 * interface permits everything, and NAT's undefined list permits nothing: those rules belong to the callers.)
 */
export function evaluateAcl(list: Pick<AclList, 'type' | 'entries'>, tuple: PacketTuple): AclDecision {
  const trail: AclTrailStep[] = [];
  for (let i = 0; i < list.entries.length; i++) {
    const { seq, entry, text } = list.entries[i]!;
    const failed = aclEntryMiss(entry, tuple);
    if (failed === undefined) {
      trail.push({ seq, text, result: 'match' });
      return { action: entry.action, seq, index: i, trail };
    }
    trail.push({ seq, text, result: 'miss', failed });
  }
  trail.push({ seq: 'implicit', text: aclImplicitText(list.type), result: 'match' });
  return { action: 'deny', seq: null, implicit: 'deny', trail };
}

/**
 * @since P3 The fewest address/wildcard pairs whose union is exactly the addresses from `first` to `last` inclusive
 * ([S9] "build from a range"): aligned power-of-two blocks, each as large as fits, in address order. Empty when
 * `first` is above `last` or either is not an address.
 */
export function rangeToAces(first: Ipv4Address, last: Ipv4Address): AclAddress[] {
  const lo = parseIpv4(first);
  const hi = parseIpv4(last);
  if (lo === null || hi === null || lo > hi) return [];
  const out: AclAddress[] = [];
  let cur = lo;
  while (cur <= hi) {
    // grow the block while it stays aligned on `cur` and inside the range (sizes up to 2^32, as plain numbers)
    let size = 1;
    while (size < 0x100000000 && cur % (size * 2) === 0 && cur + size * 2 - 1 <= hi) size *= 2;
    out.push({ address: u32ToIpv4(cur), wildcard: u32ToIpv4(size - 1) });
    cur += size;
  }
  return out;
}

/** @since P3 The findings `lintAcl` reports. */
export type AclLintCode = 'unreachable' | 'mask-as-wildcard' | 'no-permit';

/** @since P3 One finding of `lintAcl` (original wording). */
export interface AclLintFinding {
  readonly code: AclLintCode;
  readonly severity: 'warning' | 'info';
  /** The entry concerned (absent for a finding about the whole list). */
  readonly seq?: number;
  /** 'unreachable': the earlier entry that already matches every packet this one matches. */
  readonly coveredBy?: number;
  readonly text: string;
}

function addressCovers(outer: AclAddress, inner: AclAddress): boolean {
  const ow = ipv4ToU32(outer.wildcard);
  const iw = ipv4ToU32(inner.wildcard);
  // every bit the inner set leaves free is free in the outer set, and the bits the outer set fixes agree
  return (iw & ~ow) >>> 0 === 0 && ((ipv4ToU32(outer.address) ^ ipv4ToU32(inner.address)) & ~ow) >>> 0 === 0;
}

/** The ports a condition accepts, as inclusive intervals (absent = every port). */
function portIntervals(m: AclPortMatch | undefined): (readonly [number, number])[] {
  if (m === undefined) return [[0, 65535]];
  switch (m.op) {
    case 'eq':
      return [[m.port, m.port]];
    case 'neq': {
      const out: (readonly [number, number])[] = [];
      if (m.port > 0) out.push([0, m.port - 1]);
      if (m.port < 65535) out.push([m.port + 1, 65535]);
      return out;
    }
    case 'lt':
      return [[0, m.port - 1]];
    case 'gt':
      return [[m.port + 1, 65535]];
    case 'range':
      return [[m.low, m.high]];
  }
}

function portsCover(outer: AclPortMatch | undefined, inner: AclPortMatch | undefined): boolean {
  const out = portIntervals(outer);
  return portIntervals(inner).every(([a, b]) => out.some(([c, d]) => c <= a && b <= d));
}

/** True when every packet `inner` matches is also matched by `outer`. */
function entryCovers(outer: AclEntry, inner: AclEntry): boolean {
  if (outer.kind === 'standard' || inner.kind === 'standard') {
    return outer.kind === 'standard' && inner.kind === 'standard' && addressCovers(outer.source, inner.source);
  }
  if (outer.protocol !== 'ip' && outer.protocol !== inner.protocol) return false;
  if (!addressCovers(outer.source, inner.source) || !addressCovers(outer.destination, inner.destination)) return false;
  if (!portsCover(outer.sourcePort, inner.sourcePort) || !portsCover(outer.destinationPort, inner.destinationPort)) return false;
  if (outer.established === true && inner.established !== true) return false;
  if (outer.icmp !== undefined) {
    if (inner.icmp === undefined || inner.icmp.type !== outer.icmp.type) return false;
    if (outer.icmp.code !== undefined && inner.icmp.code !== outer.icmp.code) return false;
  }
  return true;
}

/** A wildcard written like a subnet mask: leading one bits then trailing zero bits, neither all zeros nor all ones. */
function looksLikeMask(wildcard: Ipv4Address): boolean {
  const w = ipv4ToU32(wildcard);
  if (w === 0 || w === 0xffffffff) return false;
  const inv = ~w >>> 0; // 0…01…1 when `w` is 1…10…0
  return ((inv & (inv + 1)) >>> 0) === 0;
}

/**
 * @since P3 Findings about a list, in sequence order, then the list-wide one:
 *   • 'unreachable' (warning): an entry no packet can reach, because an earlier entry matches every packet it
 *     matches (whatever the two actions are);
 *   • 'mask-as-wildcard' (info): a wildcard shaped like a subnet mask (255.255.255.0 matches one address in every
 *     256, where 0.0.0.255 was probably meant);
 *   • 'no-permit' (warning): a list without a permit entry denies every packet (the implicit deny).
 */
export function lintAcl(list: Pick<AclList, 'type' | 'entries'>): AclLintFinding[] {
  const out: AclLintFinding[] = [];
  const entries = list.entries;
  for (let i = 0; i < entries.length; i++) {
    const { seq, entry } = entries[i]!;
    for (let j = 0; j < i; j++) {
      const earlier = entries[j]!;
      if (entryCovers(earlier.entry, entry)) {
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
    const wildcards = entry.kind === 'standard' ? [entry.source.wildcard] : [entry.source.wildcard, entry.destination.wildcard];
    for (const w of wildcards) {
      if (looksLikeMask(w)) {
        out.push({
          code: 'mask-as-wildcard',
          severity: 'info',
          seq,
          text: `Entry ${seq} uses ${w} as a wildcard. It is shaped like a subnet mask; the wildcard for that mask is ${u32ToIpv4(~ipv4ToU32(w) >>> 0)}.`,
        });
        break;
      }
    }
  }
  if (!entries.some((e) => e.entry.action === 'permit')) {
    out.push({ code: 'no-permit', severity: 'warning', text: 'This list permits nothing: every packet reaches the implicit deny.' });
  }
  return out;
}
