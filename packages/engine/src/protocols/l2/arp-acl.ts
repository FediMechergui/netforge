/**
 * protocols/l2/arp-acl.ts — ARP access lists and `ip arp inspection validate` (ARCHITECTURE-P3C [S14], §3.7, §4.3, §5,
 * §2.6 `ArpInspectionRow`).
 *
 * Dynamic ARP inspection (`arp-inspection.ts`, step 7c) gains two checks between the trusted-port test and the
 * bindings. With them the IOS order is: (1) rate limit; (2) trusted port; (3) `validate`; (4) the VLAN's ARP ACL;
 * (5) bindings. W1a delivers the pure pieces of (3) and (4) only; the W2a l2 item puts them in that order inside
 * `decideArpInspection` (§7). With no ACL filter and no `validate` line `decideArpValidateAndAcl` returns `continue`
 * and writes nothing, so the no-ACL, no-validate path stays byte-identical (`l2.arp-inspection.test.ts` pins it).
 *
 *  • `readArpAcls(config)` — the sections `arp access-list <name>` (mode `config-arp-nacl`), each entry
 *    `{permit|deny} [request|response] ip <sender-ip> [<target-ip>] mac <sender-mac> [<target-mac>] [log]`, an address
 *    being `any`, `host <a>` or `<a> <wildcard>` (wildcard bits set = ignored, for IPv4 and MAC alike). A target is
 *    accepted only on a `response` entry. Entries keep their stored tokens and configuration order; a line that does
 *    not parse is skipped.
 *  • `readArpInspectionFilters(config)` — `ip arp inspection filter <name> vlan <list> [static]`; the last line naming a
 *    VLAN is that VLAN's filter.
 *  • `readArpValidate(config)` — `ip arp inspection validate {src-mac|dst-mac|ip}+`: one stored line whose keyword set
 *    is replaced (the last valid line wins).
 *  • `arpValidateFailure(validate, frame, arp)` — the checks, in the order src-mac, dst-mac, ip:
 *      src-mac: the Ethernet source ≠ the sender MAC;
 *      dst-mac: a reply whose Ethernet destination ≠ the target MAC;
 *      ip: the sender address (and, in a reply, the target address) is 0.0.0.0, 255.255.255.255 or multicast.
 *  • `matchArpAcl(entries, arp)` and `arpAclVerdict(...)` — an explicit permit forwards, an explicit deny drops; no match
 *    falls through to the bindings, unless the filter is `static`, in which case the implicit deny drops.
 *  • `decideArpValidateAndAcl(check)` — (3) then (4) for an ARP on an untrusted port of an inspected VLAN.
 *  • `applyArpValidateAclOutcome(prev, vlan, outcome, now)` — the VLAN's row after an outcome: the new counters
 *    `droppedSrcMac`, `droppedDstMac`, `droppedIp` and `aclPermitted` are optional by meaning and appear only once
 *    nonzero; an ACL drop counts in the existing `droppedAcl`.
 *
 * Wording is original. Integer only. Pure: no state, no I/O, no clock, no randomness.
 */
import { isIpv4, isIpv4Multicast, normalizeMac, parseIpv4 } from '../../contracts/addr.js';
import type { Ipv4Address, MacAddress } from '../../contracts/addr.js';
import type { ConfigAst } from '../../contracts/config.js';
import type { PortId } from '../../contracts/ids.js';
import { ARP_OP_REPLY, ARP_OP_REQUEST } from '../../contracts/pdu.js';
import type { PduView } from '../../contracts/pdu.js';
import type { DropRule } from '../../contracts/process.js';
import { vlanKey } from '../../contracts/tables.js';
import type { ArpInspectionRow } from '../../contracts/tables.js';
import type { SimTime } from '../../contracts/time.js';
import { configTextLinesOf } from '../../cli/config-text.js';
import type { VlanRange } from '../../core/vlan-list.js';
// Type-only: arp-inspection.ts will import this module when W2a wires steps (3) and (4), so no value import back.
import type { ArpInspectView } from './arp-inspection.js';
import { parseSnoopingVlanTokens } from './dhcp-snooping.js';

/** `request`, `reply`, or `op <n>` (the wording of `arp-inspection.ts`). */
function arpOpWord(op: number): string {
  if (op === ARP_OP_REQUEST) return 'request';
  if (op === ARP_OP_REPLY) return 'reply';
  return `op ${op}`;
}

// ── configuration ─────────────────────────────────────────────────────────────────────────────────────────────

/** An IPv4 address match: `value` compared under `wildcard` (bits set are ignored). `any` = wildcard 0xffffffff. */
export interface ArpAclIpMatch {
  readonly value: number;
  readonly wildcard: number;
}

/** A MAC match: six octets compared under six wildcard octets (bits set are ignored). */
export interface ArpAclMacMatch {
  readonly value: readonly number[];
  readonly wildcard: readonly number[];
}

/** One entry of an `arp access-list`. */
export interface ArpAclEntry {
  readonly action: 'permit' | 'deny';
  /** `request` or `response` limits the entry to that operation; `any` matches both. */
  readonly op: 'any' | 'request' | 'response';
  readonly senderIp: ArpAclIpMatch;
  /** A `response` entry's target address, when given. */
  readonly targetIp?: ArpAclIpMatch;
  readonly senderMac: ArpAclMacMatch;
  /** A `response` entry's target MAC, when given. */
  readonly targetMac?: ArpAclMacMatch;
  readonly log: boolean;
  /** The stored line's tokens. */
  readonly line: readonly string[];
}

/** One `arp access-list <name>`, its entries in configuration order. */
export interface ArpAcl {
  readonly name: string;
  readonly entries: readonly ArpAclEntry[];
}

/** Every ARP access list, by name. */
export type ArpAclConfig = ReadonlyMap<string, ArpAcl>;

/** One `ip arp inspection filter <name> vlan <list> [static]` line. */
export interface ArpInspectionFilter {
  readonly acl: string;
  readonly ranges: readonly VlanRange[];
  /** `static`: no match is an implicit deny instead of a fall-through to the bindings. */
  readonly static: boolean;
  readonly line: readonly string[];
}

/** `ip arp inspection validate …`: which checks run, and the stored line. */
export interface ArpValidateConfig {
  readonly srcMac: boolean;
  readonly dstMac: boolean;
  readonly ip: boolean;
  readonly line: readonly string[];
}

const ANY_IP: ArpAclIpMatch = Object.freeze({ value: 0, wildcard: 0xffffffff });
const ANY_MAC: ArpAclMacMatch = Object.freeze({ value: Object.freeze([0, 0, 0, 0, 0, 0]), wildcard: Object.freeze([255, 255, 255, 255, 255, 255]) });

function macOctets(t: string | undefined): number[] | undefined {
  const mac = t === undefined ? null : normalizeMac(t);
  return mac === null ? undefined : mac.split(':').map((h) => parseInt(h, 16));
}

/** An IPv4 address spec at `t[i]`: `any`, `host <a>` or `<a> <wildcard>`; returns the match and the next index. */
function ipSpec(t: readonly string[], i: number): [ArpAclIpMatch, number] | undefined {
  if (t[i] === 'any') return [ANY_IP, i + 1];
  if (t[i] === 'host') {
    const v = t[i + 1] === undefined ? null : parseIpv4(t[i + 1] as string);
    return v === null ? undefined : [Object.freeze({ value: v >>> 0, wildcard: 0 }), i + 2];
  }
  const v = t[i] === undefined ? null : parseIpv4(t[i] as string);
  const w = t[i + 1] === undefined ? null : parseIpv4(t[i + 1] as string);
  if (v === null || w === null) return undefined;
  return [Object.freeze({ value: (v & ~w) >>> 0, wildcard: w >>> 0 }), i + 2];
}

/** A MAC spec at `t[i]`: `any`, `host <mac>` or `<mac> <mac-wildcard>`; returns the match and the next index. */
function macSpec(t: readonly string[], i: number): [ArpAclMacMatch, number] | undefined {
  if (t[i] === 'any') return [ANY_MAC, i + 1];
  if (t[i] === 'host') {
    const v = macOctets(t[i + 1]);
    return v === undefined ? undefined : [Object.freeze({ value: Object.freeze(v), wildcard: Object.freeze([0, 0, 0, 0, 0, 0]) }), i + 2];
  }
  const v = macOctets(t[i]);
  const w = macOctets(t[i + 1]);
  if (v === undefined || w === undefined) return undefined;
  return [Object.freeze({ value: Object.freeze(v.map((o, k) => o & ~(w[k] as number) & 0xff)), wildcard: Object.freeze(w) }), i + 2];
}

/** An ARP ACL entry line (tokens inside the section), or undefined when it does not parse. */
export function parseArpAclEntry(t: readonly string[]): ArpAclEntry | undefined {
  const action = t[0];
  if (action !== 'permit' && action !== 'deny') return undefined;
  let i = 1;
  let op: ArpAclEntry['op'] = 'any';
  if (t[i] === 'request' || t[i] === 'response') {
    op = t[i] as 'request' | 'response';
    i++;
  }
  if (t[i] !== 'ip') return undefined;
  const sIp = ipSpec(t, i + 1);
  if (sIp === undefined) return undefined;
  i = sIp[1];
  let tIp: ArpAclIpMatch | undefined;
  if (t[i] !== 'mac') {
    if (op !== 'response') return undefined;
    const r = ipSpec(t, i);
    if (r === undefined) return undefined;
    tIp = r[0];
    i = r[1];
    if (t[i] !== 'mac') return undefined;
  }
  const sMac = macSpec(t, i + 1);
  if (sMac === undefined) return undefined;
  i = sMac[1];
  let tMac: ArpAclMacMatch | undefined;
  if (i < t.length && t[i] !== 'log') {
    if (op !== 'response') return undefined;
    const r = macSpec(t, i);
    if (r === undefined) return undefined;
    tMac = r[0];
    i = r[1];
  }
  let log = false;
  if (t[i] === 'log') {
    log = true;
    i++;
  }
  if (i !== t.length) return undefined;
  const e: {
    action: 'permit' | 'deny'; op: ArpAclEntry['op']; senderIp: ArpAclIpMatch; targetIp?: ArpAclIpMatch;
    senderMac: ArpAclMacMatch; targetMac?: ArpAclMacMatch; log: boolean; line: readonly string[];
  } = { action, op, senderIp: sIp[0], senderMac: sMac[0], log, line: Object.freeze(t.slice()) };
  if (tIp !== undefined) e.targetIp = tIp;
  if (tMac !== undefined) e.targetMac = tMac;
  return Object.freeze(e);
}

const isArpAclSection = (c: readonly string[] | undefined): c is readonly string[] =>
  c !== undefined && c[0] === 'arp' && c[1] === 'access-list' && c.length === 3;

/** The ARP access lists of a device (a list with no valid entry still exists: everything falls to its end). */
export function readArpAcls(config: ConfigAst): ArpAclConfig {
  const lists = new Map<string, ArpAclEntry[]>();
  for (const l of configTextLinesOf(config.root)) {
    if (l.negate) continue;
    if (l.context.length === 0 && isArpAclSection(l.tokens)) {
      const name = l.tokens[2] as string;
      if (!lists.has(name)) lists.set(name, []);
      continue;
    }
    const sec = l.context.length === 1 ? l.context[0] : undefined;
    if (!isArpAclSection(sec)) continue;
    const name = sec[2] as string;
    const e = parseArpAclEntry(l.tokens);
    if (e === undefined) continue;
    let list = lists.get(name);
    if (list === undefined) {
      list = [];
      lists.set(name, list);
    }
    list.push(e);
  }
  const out = new Map<string, ArpAcl>();
  for (const [name, entries] of lists) out.set(name, Object.freeze({ name, entries: Object.freeze(entries) }));
  return out;
}

const isDai = (t: readonly string[]): boolean => t[0] === 'ip' && t[1] === 'arp' && t[2] === 'inspection';

/** The `ip arp inspection filter …` lines, in configuration order. */
export function readArpInspectionFilters(config: ConfigAst): readonly ArpInspectionFilter[] {
  const out: ArpInspectionFilter[] = [];
  for (const l of configTextLinesOf(config.root)) {
    const t = l.tokens;
    if (l.negate || l.context.length !== 0 || !isDai(t) || t[3] !== 'filter' || t[4] === undefined || t[5] !== 'vlan') continue;
    const isStatic = t[t.length - 1] === 'static';
    const ranges = parseSnoopingVlanTokens(t.slice(6, isStatic ? -1 : undefined));
    if (ranges === undefined) continue;
    out.push(Object.freeze({ acl: t[4], ranges: Object.freeze(ranges), static: isStatic, line: Object.freeze(t.slice()) }));
  }
  return Object.freeze(out);
}

/** The filter of `vlan`: the last line naming it, or undefined. */
export function arpFilterFor(filters: readonly ArpInspectionFilter[], vlan: number): ArpInspectionFilter | undefined {
  for (let k = filters.length - 1; k >= 0; k--) {
    const f = filters[k] as ArpInspectionFilter;
    for (const [lo, hi] of f.ranges) if (vlan >= lo && vlan <= hi) return f;
  }
  return undefined;
}

/** The checks of a `validate` line (tokens without `no`), or undefined when it does not parse. */
export function parseArpValidateLine(t: readonly string[]): ArpValidateConfig | undefined {
  if (!isDai(t) || t[3] !== 'validate' || t.length < 5) return undefined;
  let srcMac = false;
  let dstMac = false;
  let ip = false;
  for (const k of t.slice(4)) {
    if (k === 'src-mac') srcMac = true;
    else if (k === 'dst-mac') dstMac = true;
    else if (k === 'ip') ip = true;
    else return undefined;
  }
  return Object.freeze({ srcMac, dstMac, ip, line: Object.freeze(t.slice()) });
}

/** The `validate` line of a device (the last valid one), or undefined (no check runs). */
export function readArpValidate(config: ConfigAst): ArpValidateConfig | undefined {
  let out: ArpValidateConfig | undefined;
  for (const l of configTextLinesOf(config.root)) {
    if (l.negate || l.context.length !== 0) continue;
    out = parseArpValidateLine(l.tokens) ?? out;
  }
  return out;
}

/** Everything steps (3) and (4) read from the running configuration. */
export interface ArpAclInspectionConfig {
  readonly acls: ArpAclConfig;
  readonly filters: readonly ArpInspectionFilter[];
  readonly validate?: ArpValidateConfig;
}

/** `readArpAcls`, `readArpInspectionFilters` and `readArpValidate` together. */
export function readArpAclInspection(config: ConfigAst): ArpAclInspectionConfig {
  const validate = readArpValidate(config);
  const out = { acls: readArpAcls(config), filters: readArpInspectionFilters(config) };
  return Object.freeze(validate === undefined ? out : { ...out, validate });
}

// ── the checks ────────────────────────────────────────────────────────────────────────────────────────────────

/** Which `validate` check failed. */
export type ArpValidateCheck = 'src-mac' | 'dst-mac' | 'ip';

/** True for an address `validate ip` refuses: 0.0.0.0, 255.255.255.255 or multicast. */
export function invalidArpAddress(ip: Ipv4Address): boolean {
  return !isIpv4(ip) || ip === '0.0.0.0' || ip === '255.255.255.255' || isIpv4Multicast(ip);
}

/** The first `validate` check the ARP fails (order src-mac, dst-mac, ip), or undefined. */
export function arpValidateFailure(
  validate: ArpValidateConfig | undefined,
  eth: { readonly src: MacAddress; readonly dst: MacAddress },
  arp: ArpInspectView,
): ArpValidateCheck | undefined {
  if (validate === undefined) return undefined;
  if (validate.srcMac && eth.src !== arp.sha) return 'src-mac';
  if (validate.dstMac && arp.op === ARP_OP_REPLY && eth.dst !== arp.tha) return 'dst-mac';
  if (validate.ip && (invalidArpAddress(arp.spa) || (arp.op === ARP_OP_REPLY && invalidArpAddress(arp.tpa)))) return 'ip';
  return undefined;
}

/** The Ethernet source and destination of `frame`, normalised, or undefined for a frame without an Ethernet header. */
export function arpEthernetOf(frame: Pick<PduView, 'layers'>): { readonly src: MacAddress; readonly dst: MacAddress } | undefined {
  const eth = frame.layers[0];
  if (eth === undefined || eth.proto !== 'ethernet') return undefined;
  const src = typeof eth.fields.src === 'string' ? normalizeMac(eth.fields.src) : null;
  const dst = typeof eth.fields.dst === 'string' ? normalizeMac(eth.fields.dst) : null;
  return src === null || dst === null ? undefined : { src, dst };
}

function ipMatches(m: ArpAclIpMatch, ip: Ipv4Address): boolean {
  const v = parseIpv4(ip);
  return v !== null && ((v & ~m.wildcard) >>> 0) === m.value;
}

function macMatches(m: ArpAclMacMatch, mac: MacAddress): boolean {
  const o = macOctets(mac);
  if (o === undefined) return false;
  for (let k = 0; k < 6; k++) if (((o[k] as number) & ~(m.wildcard[k] as number) & 0xff) !== m.value[k]) return false;
  return true;
}

/** True when `entry` matches the ARP. */
export function arpAclEntryMatches(entry: ArpAclEntry, arp: ArpInspectView): boolean {
  if (entry.op === 'request' && arp.op !== ARP_OP_REQUEST) return false;
  if (entry.op === 'response' && arp.op !== ARP_OP_REPLY) return false;
  if (!ipMatches(entry.senderIp, arp.spa) || !macMatches(entry.senderMac, arp.sha)) return false;
  if (entry.targetIp !== undefined && !ipMatches(entry.targetIp, arp.tpa)) return false;
  if (entry.targetMac !== undefined && !macMatches(entry.targetMac, arp.tha)) return false;
  return true;
}

/** The first entry of `acl` that matches, with its 0-based index, or undefined. */
export function matchArpAcl(acl: ArpAcl | undefined, arp: ArpInspectView): { readonly entry: ArpAclEntry; readonly index: number } | undefined {
  if (acl === undefined) return undefined;
  for (let i = 0; i < acl.entries.length; i++) {
    const entry = acl.entries[i] as ArpAclEntry;
    if (arpAclEntryMatches(entry, arp)) return { entry, index: i };
  }
  return undefined;
}

// ── the decision ──────────────────────────────────────────────────────────────────────────────────────────────

/** Inputs of steps (3) and (4) for an ARP on untrusted port L of inspected VLAN V. */
export interface ArpValidateAclCheck {
  readonly config: ArpAclInspectionConfig;
  readonly port: PortId;
  readonly vlan: number;
  readonly eth: { readonly src: MacAddress; readonly dst: MacAddress };
  readonly arp: ArpInspectView;
}

/** Outcome of steps (3) and (4). */
export type ArpValidateAclOutcome =
  /** No validate failure and no ACL decision: go on to the bindings (step 5). Nothing is counted. */
  | { readonly kind: 'continue' }
  /** An explicit ACL permit: forwarded without a binding (`forwarded + 1`, `aclPermitted + 1`). */
  | { readonly kind: 'permit'; readonly acl: string; readonly entry: ArpAclEntry; readonly debug: string }
  /** `Action drop {reason: 'arp-inspection', detail, rule}`. */
  | {
      readonly kind: 'drop';
      /** `validate` names the failed check; `acl-deny` an explicit deny; `acl-static` the implicit deny of `static`. */
      readonly cause: ArpValidateCheck | 'acl-deny' | 'acl-static';
      readonly reason: 'arp-inspection';
      readonly detail: string;
      readonly rule: DropRule;
      readonly debug: string;
    };

const VALIDATE_TEXT: Readonly<Record<ArpValidateCheck, string>> = {
  'src-mac': 'with "validate src-mac" an ARP whose sender MAC differs from its Ethernet source is dropped',
  'dst-mac': 'with "validate dst-mac" an ARP reply whose target MAC differs from its Ethernet destination is dropped',
  ip: 'with "validate ip" an ARP whose sender address (or, in a reply, target address) is 0.0.0.0, 255.255.255.255 or multicast is dropped',
};

function validateDetail(check: ArpValidateCheck, eth: { src: MacAddress; dst: MacAddress }, arp: ArpInspectView, port: PortId, vlan: number): string {
  const what = `ARP ${arpOpWord(arp.op)} on ${port} (vlan ${vlan})`;
  if (check === 'src-mac') return `${what}: sender MAC ${arp.sha} differs from the Ethernet source ${eth.src}`;
  if (check === 'dst-mac') return `${what}: target MAC ${arp.tha} differs from the Ethernet destination ${eth.dst}`;
  return `${what}: ${invalidArpAddress(arp.spa) ? `sender address ${arp.spa}` : `target address ${arp.tpa}`} is not a valid host address`;
}

/** Steps (3) `validate` and (4) the VLAN's ARP ACL (see the file header). */
export function decideArpValidateAndAcl(check: ArpValidateAclCheck): ArpValidateAclOutcome {
  const { config, port, vlan, eth, arp } = check;
  const failed = arpValidateFailure(config.validate, eth, arp);
  if (failed !== undefined) {
    const v = config.validate as ArpValidateConfig;
    return {
      kind: 'drop',
      cause: failed,
      reason: 'arp-inspection',
      detail: validateDetail(failed, eth, arp, port, vlan),
      rule: { kind: 'arp-inspection', text: VALIDATE_TEXT[failed], iface: port, config: { context: [], line: v.line } },
      debug: `dropped ARP ${arpOpWord(arp.op)} from ${arp.sha} on ${port} (vlan ${vlan}): validate ${failed} failed`,
    };
  }
  const filter = arpFilterFor(config.filters, vlan);
  if (filter === undefined) return { kind: 'continue' };
  const acl = config.acls.get(filter.acl);
  const hit = matchArpAcl(acl, arp);
  if (hit !== undefined && hit.entry.action === 'permit') {
    return { kind: 'permit', acl: filter.acl, entry: hit.entry, debug: `permitted ARP ${arpOpWord(arp.op)} from ${arp.sha} claiming ${arp.spa} on ${port} (vlan ${vlan}) by ARP access list ${filter.acl}` };
  }
  if (hit !== undefined) {
    return {
      kind: 'drop',
      cause: 'acl-deny',
      reason: 'arp-inspection',
      detail: `ARP ${arpOpWord(arp.op)} from ${arp.sha} claiming ${arp.spa} on ${port} (vlan ${vlan}) is denied by ARP access list ${filter.acl}`,
      rule: {
        kind: 'arp-inspection',
        text: `denied by ARP access list ${filter.acl} entry ${hit.index + 1} (${hit.entry.line.join(' ')}), applied to vlan ${vlan}`,
        iface: port,
        list: filter.acl,
        config: { context: [['arp', 'access-list', filter.acl]], line: hit.entry.line },
      },
      debug: `dropped ARP ${arpOpWord(arp.op)} from ${arp.sha} on ${port} (vlan ${vlan}): denied by ARP access list ${filter.acl}`,
    };
  }
  if (!filter.static) return { kind: 'continue' };
  return {
    kind: 'drop',
    cause: 'acl-static',
    reason: 'arp-inspection',
    detail: `ARP ${arpOpWord(arp.op)} from ${arp.sha} claiming ${arp.spa} on ${port} (vlan ${vlan}) matches no entry of ARP access list ${filter.acl}, which is applied as static`,
    rule: {
      kind: 'arp-inspection',
      text: `ARP access list ${filter.acl} is applied to vlan ${vlan} with "static": an ARP no entry permits is dropped, and DHCP snooping bindings are not consulted`,
      iface: port,
      list: filter.acl,
      config: { context: [], line: filter.line },
    },
    debug: `dropped ARP ${arpOpWord(arp.op)} from ${arp.sha} on ${port} (vlan ${vlan}): no entry of static ARP access list ${filter.acl} matches`,
  };
}

const VALIDATE_COUNTER: Readonly<Record<ArpValidateCheck, 'droppedSrcMac' | 'droppedDstMac' | 'droppedIp'>> = {
  'src-mac': 'droppedSrcMac',
  'dst-mac': 'droppedDstMac',
  ip: 'droppedIp',
};

/**
 * The VLAN's row after a step (3)/(4) outcome, or undefined for `continue` (step 5 writes as today). A permit counts
 * `forwarded` and `aclPermitted`; a validate drop counts `dropped` and its own counter; an ACL drop (explicit or the
 * implicit deny of `static`) counts `dropped` and `droppedAcl`. The optional counters appear only once nonzero.
 */
export function applyArpValidateAclOutcome(
  prev: ArpInspectionRow | undefined,
  vlan: number,
  outcome: ArpValidateAclOutcome,
  now: SimTime,
): ArpInspectionRow | undefined {
  if (outcome.kind === 'continue') return undefined;
  const row = prev ?? { key: vlanKey(vlan), vlan, forwarded: 0, dropped: 0, droppedNoBinding: 0, droppedAcl: 0, updatedAt: now };
  if (outcome.kind === 'permit') return { ...row, forwarded: row.forwarded + 1, aclPermitted: (row.aclPermitted ?? 0) + 1, updatedAt: now };
  if (outcome.cause === 'acl-deny' || outcome.cause === 'acl-static') return { ...row, dropped: row.dropped + 1, droppedAcl: row.droppedAcl + 1, updatedAt: now };
  const c = VALIDATE_COUNTER[outcome.cause];
  return { ...row, dropped: row.dropped + 1, [c]: (row[c] ?? 0) + 1, updatedAt: now };
}
