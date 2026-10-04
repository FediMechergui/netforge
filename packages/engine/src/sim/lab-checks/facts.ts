/**
 * sim/lab-checks/facts.ts — the data-driven P3 grader frameworks the protocol areas plug into (ARCHITECTURE-P3 D5,
 * §2.10, §0 rules 12 and 20; §7 W1 sim): identities, neighbours and facts.
 *
 * Identities (IDENTITY_SOURCES). A device NAME in an assertion stands for every identity of that device: its topology
 * name and hostname, every interface address, its base MAC and port MACs, and the protocol router ids an area adds
 * (OSPF's and [C1] EIGRP's, W3). Identities compare as keys (`identityKey`): a MAC in any notation, an IPv4 or IPv6
 * address in any valid form, else the text itself. `identityTarget` turns what an author wrote into the keys it
 * stands for: a device name (its identities), else a literal address or MAC; anything else names no device.
 *
 * Neighbours (`neighbor` kind, NEIGHBOR_SOURCES). Each protocol's source reads its own table (rule 20) and returns the
 * rows as NeighborViews: the local interface, the identities the row names, the protocol's own state word and, for
 * OSPF, the neighbour's role. The checker filters by interface and by neighbour identity (the "who"), then by state and
 * role (the "how"):
 *   count     → exactly that many rows match every given field;
 *   minCount  → at least that many;
 *   otherwise `exists` (default true) → some row matches (none, when false). A device whose source finds no table does
 *   not run the protocol: it has no neighbours.
 * A failing `exists` names the first neighbour found in the wrong state or role, so the learner sees what is there.
 *
 * Facts (`fact` kind, FACT_READERS). Each fact name has a reader with a declared value type ('string', 'number',
 * 'boolean', 'address' or 'port') and the table or configuration it reads (rule 20). `equals` compares by text for
 * strings, numbers and booleans (`true` matches 'true', 10 matches '10'); an 'address' fact compares against a device
 * NAME through the identities, or against a literal address; a 'port' fact (an interface of the graded device, read as
 * its canonical name) compares against an interface name the device resolves in either form (`Fa0/1` matches
 * `FastEthernet0/1`, as the `table` kind compares port columns), and a name the device does not have fails with the
 * usual detail. `atLeast` / `atMost` bound a 'number' fact. With none of the three the fact must simply be present.
 *
 * The area adapters (W3, §7; rule 18: each `sim/lab-checks/<area>.ts` is owned by the area that knows the feature)
 * export their entries as `<AREA>_FACT_READERS`, `<AREA>_NEIGHBOR_SOURCES` and `<AREA>_IDENTITY_SOURCES`
 * (Partial records): ospf.ts, acl.ts, hardening.ts, qos.ts and [C1] eigrp.ts (grader part A); discovery.ts, time.ts,
 * automation.ts and wan.ts (grader part B). FACT_AREAS, NEIGHBOR_AREAS and the two router-id rows of IDENTITY_SOURCES
 * say, exhaustively by type, which adapter holds each entry. The registries are built of getters that read the adapter
 * module only when an entry is read (`lazyEntries`), so no adapter module is read while this module evaluates (rule
 * 12), whatever order the modules load in; an adapter imports only types from here. An entry its adapter leaves out
 * reads `undefined` and fails with the "not available in this build" detail.
 *
 * Nothing here draws randomness, advances time or emits trace: readers are plain reads of tables and configuration.
 */
import { normalizeMac, parseIpv4, portMac, u32ToIpv4 } from '../../contracts/addr.js';
import type { DeviceRuntime } from '../../contracts/device.js';
import type { PortId } from '../../contracts/ids.js';
import type { PortState } from '../../contracts/port.js';
import type { LabAssertion, LabFactName, NeighborProtocol } from '../../contracts/scenario.js';
import type { Simulation } from '../../contracts/simulation.js';
import type { TableName } from '../../contracts/tables.js';
import { normalizeIpv6 } from '../../core/addr6.js';
import { PASS, deviceNamed, fail, noDevice, noPort, portNamed, sameValue, type Check } from './core.js';
import { ACL_FACT_READERS } from './acl.js';
import { AUTOMATION_FACT_READERS } from './automation.js';
import { DISCOVERY_FACT_READERS, DISCOVERY_NEIGHBOR_SOURCES } from './discovery.js';
import { EIGRP_FACT_READERS, EIGRP_IDENTITY_SOURCES, EIGRP_NEIGHBOR_SOURCES } from './eigrp.js';
import { HARDENING_FACT_READERS } from './hardening.js';
import { OSPF_FACT_READERS, OSPF_IDENTITY_SOURCES, OSPF_NEIGHBOR_SOURCES } from './ospf.js';
import { QOS_FACT_READERS } from './qos.js';
import { TIME_FACT_READERS } from './time.js';
import { WAN_FACT_READERS, WAN_NEIGHBOR_SOURCES } from './wan.js';

const hasOwn = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);

/**
 * A frozen record whose every key reads its value from the adapter table `areas[key]()` returns, at the moment the key
 * is read (file header: rule 12). Building it calls no thunk.
 */
function lazyEntries<K extends string, V>(areas: { readonly [k in K]: () => Partial<Record<K, V>> }): { readonly [k in K]: V | undefined } {
  const out = {} as { [k in K]: V | undefined };
  for (const key of Object.keys(areas) as K[]) {
    Object.defineProperty(out, key, { enumerable: true, get: () => areas[key]()[key] });
  }
  return Object.freeze(out);
}

// ── identities ───────────────────────────────────────────────────────────────

/** @since P3 The identity sources: the three every device has, and the router ids the W3 area adapters add. */
export type IdentitySourceName = 'name' | 'address' | 'mac' | 'ospf' | 'eigrp';

/** @since P3 One kind of identity a device has (rule 20: `source` says where it is read). */
export interface IdentitySource {
  readonly source: string;
  read(dev: DeviceRuntime): readonly string[];
}

/** Every interface address of `dev` (IPv4, then IPv6, in port order). */
function addressesOf(dev: DeviceRuntime): string[] {
  const out: string[] = [];
  for (const p of dev.ports.values()) {
    if (p.l3.ipv4 !== undefined) out.push(p.l3.ipv4.address);
    for (const v6 of p.l3.ipv6 ?? []) out.push(v6.address);
  }
  return out;
}

/** The base MAC of `dev` and every port MAC. */
function macsOf(dev: DeviceRuntime): string[] {
  return [portMac(dev.macBase, 0), ...[...dev.ports.values()].map((p) => p.mac)];
}

/**
 * @since P3 D5 IDENTITY_SOURCES: the three every device has, and the router ids of the W3 adapters, read at call time
 * (file header): `ospf` the `routerId` column of the device's ospf-interfaces rows (sim/lab-checks/ospf.ts), [C1]
 * `eigrp` the configured `eigrp router-id` (sim/lab-checks/eigrp.ts).
 */
export const IDENTITY_SOURCES: { readonly [N in IdentitySourceName]: IdentitySource | undefined } = Object.freeze({
  name: { source: 'the topology name and the configured hostname', read: (dev: DeviceRuntime) => [dev.spec.name, dev.hostname] },
  address: { source: 'the interface addresses', read: addressesOf },
  mac: { source: 'the base MAC and the port MACs', read: macsOf },
  get ospf(): IdentitySource | undefined {
    return OSPF_IDENTITY_SOURCES.ospf;
  },
  get eigrp(): IdentitySource | undefined {
    return EIGRP_IDENTITY_SOURCES.eigrp;
  },
});

/** @since P3 The comparison key of an identity: `mac:…`, `ip:…` (IPv4), `ip6:…` (IPv6) in canonical form, else `name:…`. */
export function identityKey(text: string): string {
  const t = text.trim();
  const mac = normalizeMac(t);
  if (mac !== null) return `mac:${mac}`;
  const v4 = parseIpv4(t);
  if (v4 !== null) return `ip:${u32ToIpv4(v4)}`;
  if (t.includes(':')) {
    const v6 = normalizeIpv6(t);
    if (v6 !== null && v6 !== undefined) return `ip6:${v6}`;
  }
  return `name:${t}`;
}

/** @since P3 Every identity key of `dev`, over the available sources. */
export function identitiesOf(dev: DeviceRuntime, sources: { readonly [N in IdentitySourceName]: IdentitySource | undefined } = IDENTITY_SOURCES): ReadonlySet<string> {
  const out = new Set<string>();
  for (const name of Object.keys(sources) as IdentitySourceName[]) {
    const source = sources[name];
    if (source === undefined) continue;
    for (const id of source.read(dev)) if (id !== '') out.add(identityKey(id));
  }
  return out;
}

/**
 * @since P3 What an author's text stands for: a device NAME (every identity of that device), else a literal address or
 * MAC (its one key). Any other text names no device and fails with the usual detail.
 */
export function identityTarget(
  sim: Simulation,
  text: string,
  sources: { readonly [N in IdentitySourceName]: IdentitySource | undefined } = IDENTITY_SOURCES,
): { readonly keys: ReadonlySet<string> } | { readonly problem: Check } {
  const dev = deviceNamed(sim, text);
  if (dev !== undefined) return { keys: identitiesOf(dev, sources) };
  const key = identityKey(text);
  if (!key.startsWith('name:')) return { keys: new Set([key]) };
  return { problem: noDevice(text) };
}

// ── neighbours ───────────────────────────────────────────────────────────────

/** @since P3 One neighbour row of a protocol, as its source presents it to the `neighbor` checker. */
export interface NeighborView {
  /** The local interface (canonical port id) the neighbour is seen on. */
  readonly iface: PortId;
  /** Every identity the row names (router id, interface address, device id, chassis id, system name …), as written. */
  readonly peer: readonly string[];
  /** How a detail names the neighbour ('2.2.2.2', 'R2'). */
  readonly label: string;
  /** The protocol's own state word ('full', '2way', 'opened', 'up'); absent for protocols without one (CDP, LLDP). */
  readonly state?: string;
  /** OSPF: the neighbour's role on the segment. */
  readonly role?: 'dr' | 'bdr' | 'drother' | 'none';
}

/** @since P3 A protocol's neighbour rows (rule 20: `table` is where they are read). */
export interface NeighborSource {
  readonly table: TableName;
  /** The neighbours `dev` holds, in table order; undefined when the device keeps no such table (the protocol does not run). */
  read(dev: DeviceRuntime): readonly NeighborView[] | undefined;
}

/** @since P3 How details name each neighbour protocol (CDP is a name only, D23). */
export const NEIGHBOR_PROTOCOL_LABELS: { readonly [P in NeighborProtocol]: string } = {
  ospf: 'OSPF',
  cdp: 'CDP',
  lldp: 'LLDP',
  ppp: 'PPP',
  eigrp: 'EIGRP',
};

/**
 * @since P3 Which adapter holds each neighbour protocol's source (file header): ospf (`ospf-neighbors`), disc (`cdp` and
 * `lldp`: `cdp-neighbours`, `lldp-neighbours`), wan [S19] (`ppp`: the `ppp` rows, state = the LCP state) and eigrp [C1]
 * (`eigrp-neighbors`, state 'up').
 */
export const NEIGHBOR_AREAS: { readonly [P in NeighborProtocol]: () => Partial<Record<NeighborProtocol, NeighborSource>> } = Object.freeze({
  ospf: () => OSPF_NEIGHBOR_SOURCES,
  cdp: () => DISCOVERY_NEIGHBOR_SOURCES,
  lldp: () => DISCOVERY_NEIGHBOR_SOURCES,
  ppp: () => WAN_NEIGHBOR_SOURCES,
  eigrp: () => EIGRP_NEIGHBOR_SOURCES,
});

/** @since P3 D5 NEIGHBOR_SOURCES, exhaustive over NeighborProtocol, each entry read from its adapter at call time. */
export const NEIGHBOR_SOURCES: { readonly [P in NeighborProtocol]: NeighborSource | undefined } = lazyEntries(NEIGHBOR_AREAS);

/** The detail of a neighbour protocol whose source a later wave item brings. */
export function neighborUnavailableDetail(protocol: NeighborProtocol): string {
  return `${NEIGHBOR_PROTOCOL_LABELS[protocol]} neighbour checks are not available in this build.`;
}

/** `in state full, role drother` for a detail (only the parts the assertion asks about). */
function neighborStateText(r: NeighborView, a: { state?: string; role?: string }): string {
  const parts: string[] = [];
  if (a.state !== undefined) parts.push(`in state ${r.state ?? 'none'}`);
  if (a.role !== undefined) parts.push(`as ${r.role ?? 'none'}`);
  return parts.join(', ');
}

/** `in state full, as dr` for what the assertion expects. */
function wantedStateText(a: { state?: string; role?: string }): string {
  const parts: string[] = [];
  if (a.state !== undefined) parts.push(`in state ${a.state}`);
  if (a.role !== undefined) parts.push(`as ${a.role}`);
  return parts.join(', ');
}

/** `neighbour` / `neighbours`. */
const neighbourWord = (n: number): string => (n === 1 ? 'neighbour' : 'neighbours');

/**
 * @since P3 The `neighbor` kind (file header). `sources` and `identities` default to the registry's; tests pass fakes.
 */
export function checkNeighbor(
  sim: Simulation,
  a: Extract<LabAssertion, { kind: 'neighbor' }>,
  sources: { readonly [P in NeighborProtocol]: NeighborSource | undefined } = NEIGHBOR_SOURCES,
  identities: { readonly [N in IdentitySourceName]: IdentitySource | undefined } = IDENTITY_SOURCES,
): Check {
  if (!hasOwn(NEIGHBOR_PROTOCOL_LABELS, a.protocol)) return fail(`"${String(a.protocol)}" is not a neighbour protocol this grader knows.`);
  const label = NEIGHBOR_PROTOCOL_LABELS[a.protocol];
  const source = hasOwn(sources, a.protocol) ? sources[a.protocol] : undefined;
  if (source === undefined) return fail(neighborUnavailableDetail(a.protocol));
  const dev = deviceNamed(sim, a.device);
  if (dev === undefined) return noDevice(a.device);
  let port: PortState | undefined;
  if (a.iface !== undefined) {
    port = portNamed(dev, a.iface);
    if (port === undefined) return noPort(a.device, a.iface);
  }
  let keys: ReadonlySet<string> | undefined;
  if (a.neighbor !== undefined) {
    const target = identityTarget(sim, a.neighbor, identities);
    if ('problem' in target) return target.problem;
    keys = target.keys;
  }
  const rows = source.read(dev);
  const who = (rows ?? []).filter(
    (r) => (port === undefined || r.iface === port.id) && (keys === undefined || r.peer.some((p) => (keys as ReadonlySet<string>).has(identityKey(p)))),
  );
  const wantState = a.state?.toLowerCase();
  const matching = who.filter((r) => (wantState === undefined || r.state?.toLowerCase() === wantState) && (a.role === undefined || r.role === a.role));
  const shortOf = (id: PortId): string => dev.port(id)?.spec.short ?? id;
  const whoText = `${label} ${a.neighbor === undefined ? 'neighbour' : `neighbour ${a.neighbor}`}${a.iface === undefined ? '' : ` on ${a.iface}`}`;
  const howText = wantedStateText(a);
  const qualified = howText === '' ? whoText : `${whoText} ${howText}`;
  if (a.count !== undefined || a.minCount !== undefined) {
    const n = matching.length;
    const plural = `${label} ${neighbourWord(n)}${a.neighbor === undefined ? '' : ` that ${a.neighbor} answers for`}${a.iface === undefined ? '' : ` on ${a.iface}`}${howText === '' ? '' : ` ${howText}`}`;
    if (a.count !== undefined && n !== a.count) return fail(`${a.device} has ${n} ${plural}, expected exactly ${a.count}.`);
    if (a.minCount !== undefined && n < a.minCount) return fail(`${a.device} has ${n} ${plural}, expected at least ${a.minCount}.`);
    return PASS;
  }
  if (a.exists === false) {
    const first = matching[0];
    if (first === undefined) return PASS;
    return fail(`${a.device} still has ${qualified} (${first.label} on ${shortOf(first.iface)}).`);
  }
  if (matching.length > 0) return PASS;
  if (rows === undefined) return fail(`${a.device} does not run ${label}.`);
  const seen = who[0];
  if (seen === undefined) return fail(`${a.device} has no ${qualified}.`);
  return fail(`${a.device} sees ${label} neighbour ${seen.label} on ${shortOf(seen.iface)} ${neighborStateText(seen, a)}, expected ${howText}.`);
}

// ── facts ────────────────────────────────────────────────────────────────────

/**
 * @since P3 The declared value type of a fact (a lint can check every lab's `equals` against it). 'port' (W3): an
 * interface of the graded device, compared through its port names (file header).
 */
export type FactType = 'string' | 'number' | 'boolean' | 'address' | 'port';

/** @since P3 A fact's value. */
export type FactValue = string | number | boolean;

/** @since P3 What a fact reader is given: the graded world, the device and the assertion's subject. */
export interface FactContext {
  readonly sim: Simulation;
  readonly dev: DeviceRuntime;
  readonly subject: string | undefined;
}

/**
 * @since P3 What a reader found: a value, `undefined` (the fact is absent), or a problem that fails the assertion with
 * its original detail (an unknown subject, a missing subject).
 */
export type FactReading = { readonly value: FactValue | undefined } | { readonly problem: string };

/** @since P3 A fact reader: its declared type, its source (rule 20: a table column or 'configuration'), and the read. */
export interface FactReader {
  readonly type: FactType;
  readonly source: string;
  read(ctx: FactContext): FactReading;
}

/**
 * @since P3 Which adapter holds each fact's reader, exhaustive by type (file header; the sources are named in
 * contracts/scenario.ts `LabFactName` and in each adapter's header).
 */
export const FACT_AREAS: { readonly [F in LabFactName]: () => Partial<Record<LabFactName, FactReader>> } = Object.freeze({
  'ospf.routerId': () => OSPF_FACT_READERS,
  'ospf.referenceBandwidthMbps': () => OSPF_FACT_READERS,
  'ospf.defaultOriginate': () => OSPF_FACT_READERS,
  'ospf.ifaceArea': () => OSPF_FACT_READERS,
  'ospf.ifaceCost': () => OSPF_FACT_READERS,
  'ospf.ifaceNetworkType': () => OSPF_FACT_READERS,
  'ospf.ifaceState': () => OSPF_FACT_READERS,
  'ospf.ifacePriority': () => OSPF_FACT_READERS,
  'ospf.passive': () => OSPF_FACT_READERS,
  'ospf.lsdbSynced': () => OSPF_FACT_READERS,
  'snooping.enabled': () => HARDENING_FACT_READERS,
  'dai.enabled': () => HARDENING_FACT_READERS,
  'dai.dropped': () => HARDENING_FACT_READERS,
  'snooping.trusted': () => HARDENING_FACT_READERS,
  'dai.trusted': () => HARDENING_FACT_READERS,
  'snooping.bindingPort': () => HARDENING_FACT_READERS,
  'ssh.enabled': () => HARDENING_FACT_READERS,
  'ssh.version': () => HARDENING_FACT_READERS,
  'ssh.keyBits': () => HARDENING_FACT_READERS,
  'vty.transport': () => HARDENING_FACT_READERS,
  'vty.loginLocal': () => HARDENING_FACT_READERS,
  'vty.accessClass': () => HARDENING_FACT_READERS,
  'qos.inputPolicy': () => QOS_FACT_READERS,
  'qos.outputPolicy': () => QOS_FACT_READERS,
  'cdp.enabled': () => DISCOVERY_FACT_READERS,
  'lldp.enabled': () => DISCOVERY_FACT_READERS,
  'ntp.synced': () => TIME_FACT_READERS,
  'ntp.peer': () => TIME_FACT_READERS,
  'ntp.stratum': () => TIME_FACT_READERS,
  'clock.source': () => TIME_FACT_READERS,
  'clock.offsetMs': () => TIME_FACT_READERS,
  'vty.logins': () => ACL_FACT_READERS,
  'tunnel.up': () => WAN_FACT_READERS,
  'ppp.lcp': () => WAN_FACT_READERS,
  'ppp.ipcp': () => WAN_FACT_READERS,
  'ppp.auth': () => WAN_FACT_READERS,
  'qos.admitted': () => QOS_FACT_READERS,
  'logging.buffered': () => TIME_FACT_READERS,
  'logging.trap': () => TIME_FACT_READERS,
  'automation.lastRun': () => AUTOMATION_FACT_READERS,
  'eigrp.fd': () => EIGRP_FACT_READERS,
  'eigrp.successor': () => EIGRP_FACT_READERS,
  'eigrp.feasibleSuccessor': () => EIGRP_FACT_READERS,
  'eigrp.kValues': () => EIGRP_FACT_READERS,
  'ipsec.sa': () => WAN_FACT_READERS,
});

/** @since P3 D5 FACT_READERS, exhaustive over LabFactName, each entry read from its adapter at call time. */
export const FACT_READERS: { readonly [F in LabFactName]: FactReader | undefined } = lazyEntries(FACT_AREAS);

/** The detail of a fact whose reader a later wave item brings. */
export function factUnavailableDetail(fact: LabFactName): string {
  return `The ${fact} fact is not available in this build.`;
}

/** A value for a detail: `not set` when absent. */
const valueText = (v: FactValue | undefined): string => (v === undefined ? 'not set' : String(v));

/**
 * Does `value` (of `type`) equal what the author wrote? An 'address' compares through the identities, a 'port' through
 * the port names of `dev`.
 */
function factEquals(
  sim: Simulation,
  dev: DeviceRuntime,
  type: FactType,
  value: FactValue | undefined,
  want: FactValue,
  identities: { readonly [N in IdentitySourceName]: IdentitySource | undefined },
): { readonly pass: boolean } | { readonly problem: Check } {
  if (type === 'port') {
    const port = portNamed(dev, String(want).trim());
    if (port === undefined) return { problem: noPort(dev.spec.name, String(want)) };
    return { pass: value !== undefined && port.id === String(value) };
  }
  if (value === undefined) return { pass: false };
  if (type !== 'address') return { pass: sameValue(value, want) };
  const target = identityTarget(sim, String(want), identities);
  if ('problem' in target) return target;
  return { pass: target.keys.has(identityKey(String(value))) };
}

/**
 * @since P3 The `fact` kind (file header). `readers` and `identities` default to the registry's; tests pass fakes.
 */
export function checkFact(
  sim: Simulation,
  a: Extract<LabAssertion, { kind: 'fact' }>,
  readers: { readonly [F in LabFactName]: FactReader | undefined } = FACT_READERS,
  identities: { readonly [N in IdentitySourceName]: IdentitySource | undefined } = IDENTITY_SOURCES,
): Check {
  if (!hasOwn(readers, a.fact)) return fail(`"${String(a.fact)}" is not a fact this grader knows.`);
  const reader = readers[a.fact];
  if (reader === undefined) return fail(factUnavailableDetail(a.fact));
  const dev = deviceNamed(sim, a.device);
  if (dev === undefined) return noDevice(a.device);
  const reading = reader.read({ sim, dev, subject: a.subject });
  if ('problem' in reading) return fail(reading.problem);
  const value = reading.value;
  const what = `${a.device} ${a.fact}${a.subject === undefined ? '' : ` of ${a.subject}`}`;
  if (a.equals === undefined && a.atLeast === undefined && a.atMost === undefined) {
    return value === undefined ? fail(`${what} is not set.`) : PASS;
  }
  if ((a.atLeast !== undefined || a.atMost !== undefined) && reader.type !== 'number') {
    return fail(`${a.fact} is not a number, so it cannot be bounded with atLeast or atMost.`);
  }
  const expected: string[] = [];
  let pass = true;
  if (a.equals !== undefined) {
    const r = factEquals(sim, dev, reader.type, value, a.equals, identities);
    if ('problem' in r) return r.problem;
    if (!r.pass) pass = false;
    expected.push(String(a.equals));
  }
  const n = typeof value === 'number' ? value : undefined;
  if (a.atLeast !== undefined) {
    if (n === undefined || n < a.atLeast) pass = false;
    expected.push(`at least ${a.atLeast}`);
  }
  if (a.atMost !== undefined) {
    if (n === undefined || n > a.atMost) pass = false;
    expected.push(`at most ${a.atMost}`);
  }
  return pass ? PASS : fail(`${what} is ${valueText(value)}, expected ${expected.join(' and ')}.`);
}
