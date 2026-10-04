/**
 * sim/lab-checks/acl.ts — the acl area's checker adapter: the typed kinds `acl` and `aclDecision`, and the approved
 * [S13] `vty.logins` fact (ARCHITECTURE-P3 D5, D12, D14, §2.6, §2.10, §3.3, §3.14, §5.2; §0 rules 12 and 20; §7 W3
 * "ospf, acl, l2, qos, disc, svc, http" and "Approved items in W3", acl). sim/lab-checks/registry.ts calls the two
 * checkers and sim/lab-checks/facts.ts wires the fact; nothing here is read at module scope (rule 12).
 *
 * `acl` — a configured list, read from the running configuration with `readAcls` (core/acl.ts: numbered and named,
 * standard and extended, a numbered section joining the global lines of its number) under the name `aclListName`
 * gives it (`'010'` → `'10'`). In this order, the first failing member decides the detail:
 *   exists   false → the list must not be configured (the other members are not read); default true → it must be;
 *   type     'standard' | 'extended' → the list's type;
 *   entries  the expected entries in canonical `aclEntryText` form without sequence numbers. Each expected text is
 *            canonicalised the same way (parsed for the list's type and printed again, so `eq 80` and `eq www`, or
 *            `host 10.0.0.1` and `10.0.0.1` in a standard list, compare equal; a leading sequence number is ignored);
 *            a text that does not parse is compared as written, spaces collapsed. `match` 'exactly' (the default):
 *            the list holds exactly these entries in this order (the evaluation order); 'includes': it holds each of
 *            them, anywhere. Remarks are not entries;
 *   applied  each binding must be configured: `{iface, dir}` → `ip access-group <list> <dir>` on that interface (long
 *            or short name), `{vty: true, dir: 'in'}` → `access-class <list> in` under `line vty` (vty lines bind
 *            inbound only). Other bindings of the list are allowed;
 *   entry    a sequence number → the list has that entry; 'implicit' → the implicit deny, which every list has;
 *   minMatches  the hit count from the `acl` table (rule 20; rows exist only for lists applied as filters, D12, so an
 *            unapplied list counts nothing): with `entry`, that entry's row (`seq`, or the `implicit` row); without
 *            it, the sum over the list's rows. At least `minMatches`.
 *
 * `aclDecision` — pure (§2.10): `evaluateAcl` over the CONFIGURED list, no traffic, no clone. The probe becomes the
 * tuple the acl daemon builds from a real packet (`tupleOf`): `src` / `dst` are addresses or device NAMES (a device
 * stands for its first IPv4 interface address in port order); `proto` 'tcp' and 'udp' carry `srcPort` (default the first
 * ephemeral port, 49152, as a client's first connection) and `dstPort`; a TCP probe is a SYN, or a segment with ACK when
 * `established`; 'icmp' is an echo request (type 8, code 0: a ping); 'ip' is a datagram of no particular upper protocol
 * (protocol 255, reserved), so it matches `ip` entries and no protocol-specific one. A list without any permit or deny
 * entry filters nothing on the device (acl daemon, D12), so it decides `permit` with no deciding entry. `expect` is the
 * action; `entry` (optional) the deciding entry: its sequence number, or 'implicit' for the implicit deny.
 *
 * Fact (rule 20): [S13] `vty.logins` number — vty-logins: the rows with result 'success' (the table keeps the newest 50
 * attempts); subject optional, 'telnet' or 'ssh', counts that protocol only. Not set on a device whose model keeps no
 * such table (it runs no vty daemon).
 *
 * Every detail is original wording. Nothing here draws randomness, advances time or emits trace.
 */
import { parseIpv4, u32ToIpv4, type Ipv4Address } from '../../contracts/addr.js';
import type { DeviceRuntime } from '../../contracts/device.js';
import { ICMP_ECHO_REQUEST, IPPROTO_ICMP, IPPROTO_TCP, IPPROTO_UDP } from '../../contracts/pdu.js';
import type { PacketTuple } from '../../contracts/process.js';
import type { LabAssertion, LabFactName, LabPacketProbe } from '../../contracts/scenario.js';
import type { Simulation } from '../../contracts/simulation.js';
import type { AclRow, VtyLoginRow } from '../../contracts/tables.js';
import { EPHEMERAL_PORT_MIN } from '../../contracts/transport.js';
import { aclEntryText, evaluateAcl, parseAclEntry, readAcls, type AclList, type AclListType } from '../../core/acl.js';
import { aclListName, readAccessGroups, readVtyAccessClasses } from '../../protocols/acl.js';
import { PASS, deviceNamed, fail, noDevice, noPort, portNamed, type Check } from './core.js';
import type { FactContext, FactReader, FactReading } from './facts.js';

/** @since P3 The protocol number of an `aclDecision` probe with `proto: 'ip'` (255, reserved: no upper protocol). */
export const LAB_PROBE_IP_PROTOCOL = 255;

/** TCP flag bits as `tupleOf` packs them. */
const TCP_SYN = 0x02;
const TCP_ACK = 0x10;

/** `1 match` / `n matches`. */
const matchesText = (n: number): string => `${n} ${n === 1 ? 'match' : 'matches'}`;

/** `1 entry` / `n entries`. */
const entriesText = (n: number): string => `${n} ${n === 1 ? 'entry' : 'entries'}`;

/** `a standard list` / `an extended list`. */
const typeText = (t: AclListType): string => (t === 'standard' ? 'a standard list' : 'an extended list');

/** The configured list `list` names on `dev` (file header), or undefined. */
function configuredList(dev: DeviceRuntime, list: string): AclList | undefined {
  return readAcls(dev.running).get(aclListName(list.trim()));
}

/** An expected entry in the canonical form of a list of `type` (file header). */
export function canonicalAclEntry(type: AclListType, text: string): string {
  let tokens = text.trim().split(/\s+/).filter((t) => t !== '');
  if (tokens[0] !== undefined && /^\d{1,10}$/.test(tokens[0])) tokens = tokens.slice(1);
  const entry = parseAclEntry(type, tokens);
  return entry === undefined ? tokens.join(' ') : aclEntryText(entry);
}

/** The `entries` member (file header): the first difference, or undefined when the entries meet it. */
function entriesProblem(a: Extract<LabAssertion, { kind: 'acl' }>, list: AclList): string | undefined {
  if (a.entries === undefined) return undefined;
  const actual = list.entries.map((e) => e.text);
  const wanted = a.entries.map((t) => canonicalAclEntry(list.type, t));
  const where = `access list ${a.list} on ${a.device}`;
  if (a.match === 'includes') {
    const missing = wanted.find((w) => !actual.includes(w));
    return missing === undefined ? undefined : `${upper(where)} has no entry "${missing}".`;
  }
  const n = Math.max(actual.length, wanted.length);
  for (let i = 0; i < n; i++) {
    const got = actual[i];
    const want = wanted[i];
    if (got === want) continue;
    if (got === undefined) return `${upper(where)} has ${entriesText(actual.length)}; entry ${i + 1} should be "${want}".`;
    if (want === undefined) return `${upper(where)} has an extra entry ${i + 1}, "${got}".`;
    return `Entry ${i + 1} of ${where} is "${got}", expected "${want}".`;
  }
  return undefined;
}

/** The text with its first letter upper-cased. */
function upper(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** The `applied` member (file header): the first binding that is missing, or undefined. */
function appliedProblem(a: Extract<LabAssertion, { kind: 'acl' }>, dev: DeviceRuntime, name: string): string | undefined {
  if (a.applied === undefined) return undefined;
  for (const b of a.applied) {
    if (b.vty === true) {
      if (b.dir === 'in' && readVtyAccessClasses(dev.running).includes(name)) continue;
      return b.dir === 'in'
        ? `${a.device} does not apply access list ${a.list} to its vty lines (access-class ${a.list} in).`
        : `The vty lines bind an access list inbound only (access-class ${a.list} in), not ${b.dir}.`;
    }
    if (b.iface === undefined) return `A binding of access list ${a.list} names neither an interface nor the vty lines.`;
    const port = portNamed(dev, b.iface);
    if (port === undefined) return noPort(a.device, b.iface).detail ?? '';
    const bound = readAccessGroups(dev.running).get(port.id)?.[b.dir];
    if (bound === name) continue;
    const other = bound === undefined ? '' : `; it applies ${bound} there`;
    return `${a.device} does not apply access list ${a.list} to ${b.iface} ${b.dir}${other}.`;
  }
  return undefined;
}

/** The `entry` and `minMatches` members (file header): the problem, or undefined. */
function matchesProblem(a: Extract<LabAssertion, { kind: 'acl' }>, dev: DeviceRuntime, list: AclList): string | undefined {
  const where = `access list ${a.list} on ${a.device}`;
  if (typeof a.entry === 'number' && !list.entries.some((e) => e.seq === a.entry)) return `${upper(where)} has no entry ${a.entry}.`;
  if (a.minMatches === undefined) return undefined;
  const rows = (dev.tables.get<AclRow>('acl')?.rows() ?? []).filter((r) => r.family === 4 && r.list === list.name);
  const notApplied = rows.length === 0 ? ' (the list is not applied as a filter, so nothing is counted)' : '';
  if (a.entry === undefined) {
    let n = 0;
    for (const r of rows) n += r.matches;
    return n >= a.minMatches ? undefined : `${upper(where)} has ${matchesText(n)}, expected at least ${a.minMatches}${notApplied}.`;
  }
  const row = a.entry === 'implicit' ? rows.find((r) => r.implicit === 'deny') : rows.find((r) => r.seq === a.entry);
  const n = row?.matches ?? 0;
  if (n >= a.minMatches) return undefined;
  const what = a.entry === 'implicit' ? `The implicit deny of ${where}` : `Entry ${a.entry} of ${where}`;
  return `${what} has ${matchesText(n)}, expected at least ${a.minMatches}${notApplied}.`;
}

/** @since P3 The `acl` kind (file header). */
export function checkAcl(sim: Simulation, a: Extract<LabAssertion, { kind: 'acl' }>): Check {
  const dev = deviceNamed(sim, a.device);
  if (dev === undefined) return noDevice(a.device);
  const list = configuredList(dev, a.list);
  if (a.exists === false) return list === undefined ? PASS : fail(`${a.device} still has access list ${a.list}.`);
  if (list === undefined) return fail(`${a.device} has no access list ${a.list}.`);
  if (a.type !== undefined && list.type !== a.type) return fail(`Access list ${a.list} on ${a.device} is ${typeText(list.type)}, expected ${typeText(a.type)}.`);
  const problem = entriesProblem(a, list) ?? appliedProblem(a, dev, list.name) ?? matchesProblem(a, dev, list);
  return problem === undefined ? PASS : fail(problem);
}

/** An address of a probe: a literal IPv4 address, or the first IPv4 interface address of the device it names. */
function probeAddress(sim: Simulation, text: string): { readonly address: Ipv4Address } | { readonly problem: Check } {
  const v = parseIpv4(text.trim());
  if (v !== null) return { address: u32ToIpv4(v) };
  const dev = deviceNamed(sim, text);
  if (dev === undefined) return { problem: noDevice(text) };
  for (const p of dev.ports.values()) if (p.l3.ipv4 !== undefined) return { address: p.l3.ipv4.address };
  return { problem: fail(`${text} has no IPv4 address.`) };
}

/** @since P3 The tuple of an `aclDecision` probe (file header), or the problem that fails the assertion. */
export function probeTuple(sim: Simulation, probe: LabPacketProbe): { readonly tuple: PacketTuple } | { readonly problem: Check } {
  const src = probeAddress(sim, probe.src);
  if ('problem' in src) return src;
  const dst = probeAddress(sim, probe.dst);
  if ('problem' in dst) return dst;
  const base = { family: 4 as const, src: src.address, dst: dst.address };
  switch (probe.proto) {
    case 'icmp':
      return { tuple: { ...base, proto: IPPROTO_ICMP, icmpType: ICMP_ECHO_REQUEST, icmpCode: 0 } };
    case 'tcp':
    case 'udp': {
      const ports = { srcPort: probe.srcPort ?? EPHEMERAL_PORT_MIN, ...(probe.dstPort === undefined ? {} : { dstPort: probe.dstPort }) };
      if (probe.proto === 'udp') return { tuple: { ...base, proto: IPPROTO_UDP, ...ports } };
      return { tuple: { ...base, proto: IPPROTO_TCP, ...ports, tcpFlags: probe.established === true ? TCP_ACK : TCP_SYN } };
    }
    case 'ip':
      return { tuple: { ...base, proto: LAB_PROBE_IP_PROTOCOL } };
    default:
      return { problem: fail(`"${String((probe as { proto: unknown }).proto)}" is not a probe protocol (ip, icmp, tcp or udp).`) };
  }
}

/** How a detail names a probe: `a TCP segment from 192.168.10.10 port 49152 to 192.168.20.100 port 80`. */
function probeText(probe: LabPacketProbe, t: PacketTuple): string {
  const from = `from ${t.src}${t.srcPort === undefined ? '' : ` port ${t.srcPort}`}`;
  const to = `to ${t.dst}${t.dstPort === undefined ? '' : ` port ${t.dstPort}`}`;
  switch (probe.proto) {
    case 'icmp':
      return `an ICMP echo request ${from} ${to}`;
    case 'tcp':
      return `a TCP segment${probe.established === true ? ' of an established connection' : ''} ${from} ${to}`;
    case 'udp':
      return `a UDP datagram ${from} ${to}`;
    default:
      return `an IP packet ${from} ${to}`;
  }
}

/** @since P3 The `aclDecision` kind (file header). */
export function checkAclDecision(sim: Simulation, a: Extract<LabAssertion, { kind: 'aclDecision' }>): Check {
  const dev = deviceNamed(sim, a.device);
  if (dev === undefined) return noDevice(a.device);
  const list = configuredList(dev, a.list);
  if (list === undefined) return fail(`${a.device} has no access list ${a.list}.`);
  const built = probeTuple(sim, a.packet);
  if ('problem' in built) return built.problem;
  const what = probeText(a.packet, built.tuple);
  const where = `Access list ${a.list} on ${a.device}`;
  if (list.entries.length === 0) {
    if (a.expect === 'permit' && a.entry === undefined) return PASS;
    return fail(`${where} has no permit or deny entry, so it filters nothing: it permits ${what}; expected ${a.expect}${a.entry === undefined ? '' : ` by ${entryName(a.entry)}`}.`);
  }
  const d = evaluateAcl(list, built.tuple);
  const decided: number | 'implicit' = d.seq ?? 'implicit';
  const deciding = d.seq === null ? 'its implicit deny' : `entry ${d.seq} (${d.trail[d.trail.length - 1]!.text})`;
  const actionOk = d.action === a.expect;
  const entryOk = a.entry === undefined || a.entry === decided;
  if (actionOk && entryOk) return PASS;
  const verb = d.action === 'permit' ? 'permits' : 'denies';
  const expected = actionOk ? `expected ${entryName(a.entry!)} to decide it` : `expected ${a.expect}${a.entry === undefined ? '' : ` by ${entryName(a.entry)}`}`;
  return fail(`${where} ${verb} ${what} by ${deciding}; ${expected}.`);
}

/** `entry 10` / `the implicit deny`. */
function entryName(entry: number | 'implicit'): string {
  return entry === 'implicit' ? 'the implicit deny' : `entry ${entry}`;
}

/** vty.logins (file header). */
function readVtyLogins(ctx: FactContext): FactReading {
  const proto = ctx.subject?.trim().toLowerCase();
  if (proto !== undefined && proto !== 'telnet' && proto !== 'ssh') return { problem: `vty.logins takes telnet or ssh as its subject, not "${ctx.subject}".` };
  const rows = ctx.dev.tables.get<VtyLoginRow>('vty-logins')?.rows();
  if (rows === undefined) return { value: undefined };
  return { value: rows.filter((r) => r.result === 'success' && (proto === undefined || r.proto === proto)).length };
}

/** FACT_READERS entries of the acl area. */
export const ACL_FACT_READERS: Partial<Record<LabFactName, FactReader>> = {
  'vty.logins': { type: 'number', source: "vty-logins (rows with result 'success')", read: readVtyLogins },
};
