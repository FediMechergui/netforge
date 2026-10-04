/**
 * sim/lab-checks/core.ts — the P1 checkers and the helpers every checker shares (ARCHITECTURE-P1 §4.13; ARCHITECTURE-P2
 * §2.10; ARCHITECTURE-P3 D5, §7 W1 sim: moved VERBATIM from sim/lab-checks.ts, proved by `accept.p3.lab-status`).
 *
 * Assertion kinds and what they read:
 *   config       → `DeviceRuntime.running.query(path)` (dotted ConfigAst path), then `exists` / `equals` / `contains`;
 *   port         → the live `PortState` (operUp, adminUp, ipv4, ipv6, duplex, speedBps, role; P2 errDisabled);
 *   table        → `DeviceRuntime.tables.get(name)`, rows filtered by `where` (field-by-field, text-compared; P2: a
 *                  value of a column whose TABLE_DESCRIPTORS format is 'port' is first resolved through the device's
 *                  port-name resolver, so `Gi0/1` matches `GigabitEthernet0/1`); P3 (ruling R18, W2 sim; every member
 *                  optional by meaning, absent = the P2 check and detail byte for byte): `whereOps` filters further, one
 *                  comparison per column (`lt` `le` `gt` `ge` numeric — a value that is not a number never matches —,
 *                  `ne` the negation of `where`'s equality, `contains` a substring of the text), port columns resolved
 *                  like `where`; `exists` keeps its P2 meaning and `minCount` / `maxCount` bound the number of matching
 *                  rows as well (all must hold);
 *   process      → `Process.stateSnapshot().state` addressed by a dotted path whose array step is an index
 *                  (`a.b.0.c`) or a `field=value` selector (`clients.iface=Wlan0.state`) picking the first matching
 *                  element — use the selector whenever list order depends on what the student did;
 *   link         → the link between two device NAMES, optionally its media and `up`;
 *   counter      → a `PortCounters` field compared with gt / eq / lt (an absent P0.5 counter reads 0);
 *   traceSeen    → `Simulation.traceQuery` over the retained ring with the assertion's TraceFilter;
 *   connectivity → a ping in a DISPOSABLE CLONE (the clone host lives in sim/lab-checks.ts; see its header).
 *
 * Connectivity. ONE clone per distinct `connectivity.after` fault set: the assertions without `after` share the base
 * clone; an `after` set (faults resolved by name in the live world to link / device / port ids, deduplicated and
 * sorted, with its `settleMs`) gets its own clone. `cut {a, b}` cuts every cable that joins the two devices; `powerOff`
 * powers the device off; `shutdown` shuts the port. A fault that names nothing in the live world fails the assertion
 * before any clone is built. `then`: static assertions evaluated in the SAME clone right after the ping (for example
 * the NAT rows the ping created), only when the ping met its expectation; the first failing one fails the
 * connectivity assertion with its detail. A connectivity assertion inside `then` is refused. The static checks of
 * `then` run through the registry's `checkStatic`, which the caller passes in (no import cycle with the registry).
 * Pings of one clone run one after another in assertion order, so a later ping starts where the earlier left it.
 * Job counts are sampled from the icmpv4 / icmpv6 StateView while the job runs AND reconciled afterwards with the
 * daemon's structured completion record, because the reply that completes a job arrives in the dispatch that deletes
 * it. `expect:'success'` needs at least one reply; `expect:'fail'` needs none. `byName` pings a DNS name, which the
 * icmpv4 job resolves through dns-client.
 *
 * The `to` of a connectivity check is matched by NAME in the live world but its address is read INSIDE the clone:
 * the clone replays DHCP from t=0, so a lease the live world gave one host can land on another there. In a fault
 * clone a target the faults left without an address (powered off) is pinged at the address it held just before
 * the faults. A target that turns out to be the pinging host's own address fails with an original detail instead of
 * counting its own reply.
 *
 * Devices, ports and tables are addressed by NAME. An unknown one never throws: the assertion fails with an original
 * detail saying what could not be found, and so does any error raised while reading state (the registry catches it).
 *
 * ponytail: `byName` is IPv4 only, because the icmpv6 job takes an address — a name check with `family: 6` fails with
 * an original detail instead of pretending to resolve.
 *
 * P3 (ARCHITECTURE-P3 D5, §2.10; §7 W3 sim — the grader clone features). Every member below is optional by meaning:
 * an assertion without them is graded exactly as in P2, detail for detail.
 *   • `proto: 'tcp' | 'udp'` with `port` sends ONE `tcp.probe` / `udp.probe` (§2.4) from `from` inside the clone,
 *     applied exactly as `icmp.ping` is (a `request` action of the sim pseudo-process), then steps the clone until the
 *     probe settles in the daemon's StateView `probes` (or its timeout plus LAB_PING_SETTLE_NS passes). The probe waits
 *     `timeoutMs` (default LAB_PROBE_TIMEOUT_MS, 3 s). TCP passes on 'open' (a SYN-ACK) and fails on 'refused' (a
 *     reset), 'unreachable' (an ICMP error, or no route) or 'timeout'. UDP passes when the clone's trace shows the
 *     probe datagram consumed (`pduConsumed`) on the target device — it reached a listener — and fails on an ICMP
 *     unreachable, a drop, or the timeout without either. `proto: 'icmp'` is the P2 ping. A port on an ICMP check, a
 *     TCP/UDP check without a port in 1-65535, or a TCP/UDP check `byName` fails with an original detail.
 *   • `toIface` targets that interface's address of `to` (IPv4, or the first non-link-local IPv6 address, preferred
 *     ones first); `toAddress` targets that address, which `to` must hold (with both, the address must be on that
 *     interface). Read inside the clone like the P2 target; in a fault clone, as held just before the faults.
 *   • `source` (an interface or an address on `from`) is the probe's source address: `source` of icmp.ping /
 *     icmp6.ping, `src` of the transport probes. An address must be one `from` holds in the clone; an interface must
 *     have an address of the family there.
 *   • `droppedAt` (a device NAME) and `dropReason` apply only with `expect: 'fail'` (otherwise the check fails with an
 *     original detail) and are read from the clone trace's `drop` events of the probe: the PDUs its process created
 *     on `from` with the probe's tag (`ping#`, `ping6#`, `tcp-probe`, `udp-probe`) and every copy made of them (a
 *     `parent` in that set: a switch's flooded copies). The check passes when one of those drops was at `droppedAt`
 *     (if given) with `dropReason` (if given). Without a `dropReason`, the drops a flooded copy meets at bystanders
 *     (LAB_FLOOD_DROP_REASONS) are not counted. A reply lost on its way back is not a drop of the probe.
 *   • `after` gains `cut {aPort, bPort}` (only the cable on that port of `a` / `b`; a named port that no cable between
 *     the two devices uses fails the check before any clone) and `config {device, lines}`: the lines run through the
 *     clone's `configure` (the CLI core's headless configure, privilege 15, from global configuration, written like a
 *     startup configuration: leading spaces select the context), after the P2 faults, in the author's order; a refused
 *     line fails the check with the device's refusal. P2 faults are still
 *     deduplicated and sorted, so their clone is the P2 clone; configuration faults keep their order (it can matter).
 * The clone host behind `CloneHost.run` (sim/lab-checks.ts) memoises results by the canonical hash of the clone
 * input; a check hands it its memo key (`canonicalJson` of the assertion) and the clone-side work as a closure, and
 * the probe session ids are numbered per clone (`lab-check:<n>`), so a check's result depends only on the clone input
 * and the checks run before it in that clone.
 */
import { isIpv4 } from '../../contracts/addr.js';
import type { ConfigNode } from '../../contracts/config.js';
import type { DeviceRuntime } from '../../contracts/device.js';
import type { DeviceId, LinkId, PduId, PortId } from '../../contracts/ids.js';
import type { DropReason } from '../../contracts/link.js';
import type { PortCounters, PortState } from '../../contracts/port.js';
import type { ProcessRequest } from '../../contracts/process.js';
import type { LabAssertion, LabFault } from '../../contracts/scenario.js';
import type { Simulation } from '../../contracts/simulation.js';
import type { TopologyLink } from '../../contracts/topology.js';
import { TABLE_DESCRIPTORS, type TableDescriptor, type TableName, type TableRow, type TransportProbeView } from '../../contracts/tables.js';
import { MS, SEC, type SimTime } from '../../contracts/time.js';
import type { TraceEvent } from '../../contracts/trace.js';
import { normalizeIpv6 } from '../../core/addr6.js';
import { dormantTransportEligible, transportHoldRequest } from '../../protocols/ip-upper.js';
import { SIM_PROCESS_NAME } from '../simulation.js';

/** Echo requests one connectivity check sends (two, so a single lost probe is not a verdict). */
export const LAB_PING_COUNT = 2;

/** Default per-echo timeout of a connectivity check in milliseconds (`LabAssertion.timeoutMs` overrides it). */
export const LAB_PING_TIMEOUT_MS = 2000;

/** Datagram size of a connectivity echo request, matching the CLI `ping`. */
export const LAB_PING_SIZE_BYTES = 100;

/** Events the disposable clone may dispatch while it boots and settles. */
export const LAB_CLONE_BOOT_EVENTS = 200_000;

/** Events one connectivity ping may dispatch in the clone. */
export const LAB_PING_MAX_EVENTS = 200_000;

/** Clone time a connectivity check allows on top of the ping's own timeouts (ARP, SLAAC, a name lookup). */
export const LAB_PING_SETTLE_NS: SimTime = 10 * SEC;

/** @since P2 Clone time after `connectivity.after` faults when the assertion gives no `settleMs` (§2.10). */
export const LAB_AFTER_SETTLE_MS = 60_000;

/** @since P2 Events a fault clone may dispatch while it runs `settleMs` after its faults. */
export const LAB_AFTER_SETTLE_EVENTS = 200_000;

/** @since P3 Default timeout of a TCP or UDP connectivity probe in milliseconds (§2.10: 3 s without an answer fails). */
export const LAB_PROBE_TIMEOUT_MS = 3000;

/**
 * @since P3 Drop reasons a flooded copy of a probe meets away from its path (a host's MAC filter, a blocked spanning-tree
 * port): never counted for `droppedAt` unless the assertion names that `dropReason` itself.
 */
export const LAB_FLOOD_DROP_REASONS: readonly DropReason[] = Object.freeze(['not-for-me', 'stp-discarding']);

/** Result of one assertion. */
export interface Check {
  pass: boolean;
  detail?: string;
}

export const PASS: Check = { pass: true };
export const fail = (detail: string): Check => ({ pass: false, detail });

/** A device by topology name. */
export function deviceNamed(sim: Simulation, name: string): DeviceRuntime | undefined {
  for (const d of sim.devices()) if (d.spec.name === name) return d;
  return undefined;
}

/** A port by long or short name. */
export function portNamed(dev: DeviceRuntime, name: string): PortState | undefined {
  const direct = dev.port(name);
  if (direct !== undefined) return direct;
  const r = dev.resolvePortName(name);
  return r.kind === 'existing' ? dev.port(r.port) : undefined;
}

/** Compare two values the way a lab author writes them: identical, or the same text. */
export function sameValue(actual: unknown, expected: unknown): boolean {
  return actual === expected || (actual !== undefined && actual !== null && String(actual) === String(expected));
}

/** `["10.0.0.1","255.255.255.0"]` rendered the way an author would type it. */
const nodeText = (n: ConfigNode): string => [n.key, ...n.args].join(' ');

export const noDevice = (name: string): Check => fail(`There is no device called ${name} in this topology.`);
export const noPort = (device: string, port: string): Check => fail(`${device} has no interface called ${port}.`);

/** Rows of an optional table, in insertion order (none when the device keeps no such table). */
export function rowsOf<R extends TableRow>(dev: DeviceRuntime, table: TableName): R[] {
  return dev.tables.get<R>(table)?.rows() ?? [];
}

/** One failure detail from the problems found for `subject` (joined in the order they were found). */
export function verdict(subject: string, problems: readonly string[]): Check {
  return problems.length === 0 ? PASS : fail(`${subject} ${problems.join('; ')}.`);
}

// ── static assertions ────────────────────────────────────────────────────────

export function checkConfig(sim: Simulation, a: Extract<LabAssertion, { kind: 'config' }>): Check {
  const dev = deviceNamed(sim, a.device);
  if (dev === undefined) return noDevice(a.device);
  const nodes = dev.running.query(a.path);
  if (a.exists !== undefined) {
    if (nodes.length > 0 === a.exists) return PASS;
    return fail(a.exists ? `${a.device} has no configuration line at ${a.path}.` : `${a.device} still has a configuration line at ${a.path}.`);
  }
  if (nodes.length === 0) return fail(`${a.device} has no configuration line at ${a.path}.`);
  if (a.equals !== undefined) {
    const want = typeof a.equals === 'string' ? a.equals : a.equals.join(' ');
    for (const n of nodes) if (n.args.join(' ') === want) return PASS;
    return fail(`${a.device} ${a.path} is "${nodes.map((n) => n.args.join(' ')).join('" / "')}", expected "${want}".`);
  }
  if (a.contains !== undefined) {
    for (const n of nodes) if (nodeText(n).includes(a.contains)) return PASS;
    return fail(`No line at ${a.device} ${a.path} contains "${a.contains}".`);
  }
  return PASS;
}

export function checkPort(sim: Simulation, a: Extract<LabAssertion, { kind: 'port' }>): Check {
  const dev = deviceNamed(sim, a.device);
  if (dev === undefined) return noDevice(a.device);
  const port = portNamed(dev, a.port);
  if (port === undefined) return noPort(a.device, a.port);
  switch (a.field) {
    case 'ipv4': {
      const v4 = port.l3.ipv4;
      if (v4 === undefined) return fail(`${a.device} ${a.port} has no IPv4 address.`);
      if (sameValue(v4.address, a.equals) || `${v4.address}/${v4.prefixLen}` === String(a.equals)) return PASS;
      return fail(`${a.device} ${a.port} has ${v4.address}/${v4.prefixLen}, expected ${String(a.equals)}.`);
    }
    case 'ipv6': {
      const list = port.l3.ipv6 ?? [];
      for (const v6 of list) if (sameValue(v6.address, a.equals) || `${v6.address}/${v6.prefixLen}` === String(a.equals)) return PASS;
      const have = list.length === 0 ? 'no IPv6 address' : list.map((v6) => `${v6.address}/${v6.prefixLen}`).join(', ');
      return fail(`${a.device} ${a.port} has ${have}, expected ${String(a.equals)}.`);
    }
    case 'errDisabled': {
      // P2: true = err-disabled for any cause, false = not err-disabled, a string = exactly that cause
      const cause = port.errDisabled;
      const pass = a.equals === true ? cause !== undefined : a.equals === false ? cause === undefined : cause !== undefined && String(cause) === String(a.equals);
      if (pass) return PASS;
      if (cause === undefined) {
        return fail(`${a.device} ${a.port} is not err-disabled, expected it to be${a.equals === true ? '' : ` (${String(a.equals)})`}.`);
      }
      return fail(`${a.device} ${a.port} is err-disabled (${cause}), expected ${a.equals === false ? 'it to be working' : String(a.equals)}.`);
    }
    default: {
      const actual = port[a.field];
      if (sameValue(actual, a.equals)) return PASS;
      return fail(`${a.device} ${a.port} ${a.field} is ${actual === undefined ? 'not set' : String(actual)}, expected ${String(a.equals)}.`);
    }
  }
}

/** Columns of `table` whose descriptor format is 'port' (P2 `where` normalisation). */
function portColumnsOf(table: TableName): ReadonlySet<string> {
  const descriptors = TABLE_DESCRIPTORS as Readonly<Record<string, TableDescriptor>>;
  const d = Object.prototype.hasOwnProperty.call(descriptors, table) ? descriptors[table] : undefined;
  return new Set((d?.columns ?? []).filter((c) => c.format === 'port').map((c) => c.key));
}

/** The canonical id a port name stands for on `dev` (an unknown name is kept as written, so it simply matches nothing). */
function canonicalPortName(dev: DeviceRuntime, name: string): string {
  if (dev.port(name) !== undefined) return name;
  const r = dev.resolvePortName(name);
  return r.kind === 'existing' || r.kind === 'virtual' ? r.port : name;
}

/** @since P3 (R18) The comparisons of `table.whereOps`. */
type WhereOp = NonNullable<Extract<LabAssertion, { kind: 'table' }>['whereOps']>[string]['op'];

/** @since P3 (R18) How a `whereOps` comparison reads in a detail. */
const WHERE_OP_TEXT: Readonly<Record<WhereOp, string>> = Object.freeze({ lt: '<', le: '<=', gt: '>', ge: '>=', ne: '!=', contains: 'contains' });

/** @since P3 (R18) A row value or an author's value as a number, or NaN when it is not one (text holding a number counts). */
function asNumber(v: unknown): number {
  if (typeof v === 'number') return v;
  if (typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v.trim())) return Number(v.trim());
  return Number.NaN;
}

/** @since P3 (R18) One `whereOps` comparison of a row value (file header). */
export function whereOpHolds(actual: unknown, op: WhereOp, value: string | number): boolean {
  switch (op) {
    case 'ne':
      return !sameValue(actual, value);
    case 'contains':
      return actual !== undefined && actual !== null && String(actual).includes(String(value));
    default: {
      const x = asNumber(actual);
      const y = asNumber(value);
      if (Number.isNaN(x) || Number.isNaN(y)) return false;
      return op === 'lt' ? x < y : op === 'le' ? x <= y : op === 'gt' ? x > y : x >= y;
    }
  }
}

export function checkTable(sim: Simulation, a: Extract<LabAssertion, { kind: 'table' }>): Check {
  const dev = deviceNamed(sim, a.device);
  if (dev === undefined) return noDevice(a.device);
  const table = dev.tables.get(a.table);
  if (table === undefined) return fail(`${a.device} keeps no ${a.table} table (it has ${dev.tables.names().join(', ')}).`);
  // P2 (§11.2): a value of a 'port' column is compared in its canonical form (Gi0/1 matches GigabitEthernet0/1)
  const ports = portColumnsOf(a.table);
  const where = Object.entries(a.where).map(([k, v]): [string, unknown] => [k, ports.has(k) && typeof v === 'string' ? canonicalPortName(dev, v) : v]);
  // P3 (R18): the per-column comparisons beyond equality, port columns resolved the same way
  const ops = Object.entries(a.whereOps ?? {}).map(
    ([k, o]): [string, WhereOp, string | number] => [k, o.op, ports.has(k) && typeof o.value === 'string' ? canonicalPortName(dev, o.value) : o.value],
  );
  const matches = table.find((row: TableRow) => {
    const r = row as unknown as Record<string, unknown>;
    for (const [k, v] of where) if (!sameValue(r[k], v)) return false;
    for (const [k, op, v] of ops) if (!whereOpHolds(r[k], op, v)) return false;
    return true;
  });
  const conditions = [
    ...Object.entries(a.where).map(([k, v]) => `${k}=${String(v)}`),
    ...Object.entries(a.whereOps ?? {}).map(([k, o]) => `${k} ${WHERE_OP_TEXT[o.op]} ${String(o.value)}`),
  ];
  const text = conditions.join(' ');
  const n = matches.length;
  if (n > 0 !== a.exists) {
    return fail(a.exists ? `The ${a.table} table of ${a.device} has no row with ${text}.` : `The ${a.table} table of ${a.device} still has a row with ${text}.`);
  }
  // P3 (R18): the bounds on the number of matching rows
  const rows = `${n} row${n === 1 ? '' : 's'}`;
  if (a.minCount !== undefined && n < a.minCount) return fail(`The ${a.table} table of ${a.device} has ${rows} with ${text}, expected at least ${a.minCount}.`);
  if (a.maxCount !== undefined && n > a.maxCount) return fail(`The ${a.table} table of ${a.device} has ${rows} with ${text}, expected at most ${a.maxCount}.`);
  return PASS;
}

/**
 * Walk a dotted path through a StateView's `state`. An array step is either an index (`a.b.0.c`) or a
 * `field=value` selector (`clients.iface=Wlan0.state`) picking the FIRST element whose `field` text-compares equal —
 * which is how a lab addresses one entry of a list whose order depends on what the student did. The value may not
 * contain a dot, because the path is split on dots.
 */
function readPath(root: unknown, path: string): unknown {
  let cur = root;
  for (const step of path.split('.')) {
    if (cur === null || cur === undefined) return undefined;
    if (Array.isArray(cur)) {
      const eq = step.indexOf('=');
      if (eq > 0) {
        const field = step.slice(0, eq);
        const want = step.slice(eq + 1);
        cur = (cur as unknown[]).find((e) => e !== null && typeof e === 'object' && sameValue((e as Record<string, unknown>)[field], want));
        continue;
      }
      const i = Number(step);
      cur = Number.isInteger(i) ? cur[i] : undefined;
      continue;
    }
    if (typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[step];
  }
  return cur;
}

export function checkProcess(sim: Simulation, a: Extract<LabAssertion, { kind: 'process' }>): Check {
  const dev = deviceNamed(sim, a.device);
  if (dev === undefined) return noDevice(a.device);
  const proc = dev.processes.get(a.process);
  if (proc === undefined) return fail(`${a.device} is not running its ${a.process} service.`);
  const actual = readPath(proc.stateSnapshot().state, a.path);
  if (sameValue(actual, a.equals)) return PASS;
  return fail(`${a.device} ${a.process} ${a.path} is ${actual === undefined ? 'not set' : String(actual)}, expected ${String(a.equals)}.`);
}

/** Ids of the links that join the devices `a` and `b` (topology order). */
export function linksBetween(sim: Simulation, a: DeviceId, b: DeviceId): LinkId[] {
  const ids = new Set<DeviceId>([a, b]);
  return sim
    .exportTopology()
    .links.filter((l) => ids.has(l.a.device) && ids.has(l.b.device) && l.a.device !== l.b.device)
    .map((l) => l.id);
}

export function checkLink(sim: Simulation, a: Extract<LabAssertion, { kind: 'link' }>): Check {
  const da = deviceNamed(sim, a.a);
  if (da === undefined) return noDevice(a.a);
  const db = deviceNamed(sim, a.b);
  if (db === undefined) return noDevice(a.b);
  const between = linksBetween(sim, da.id, db.id)
    .map((id) => sim.link(id))
    .filter((l): l is NonNullable<typeof l> => l !== undefined);
  if (between.length === 0) return fail(`${a.a} and ${a.b} are not connected.`);
  const matching = a.media === undefined ? between : between.filter((l) => l.media === a.media || l.resolvedMedia === a.media);
  if (matching.length === 0) {
    return fail(`The cable between ${a.a} and ${a.b} is ${between.map((l) => l.resolvedMedia).join('/')}, expected ${a.media ?? ''}.`);
  }
  if (a.up === undefined) return PASS;
  const up = matching.find((l) => l.up === a.up);
  if (up !== undefined) return PASS;
  const first = matching[0];
  return fail(`The link between ${a.a} and ${a.b} is ${a.up ? 'down' : 'up'}${first?.downReason === undefined ? '' : ` (${first.downReason})`}.`);
}

export function checkCounter(sim: Simulation, a: Extract<LabAssertion, { kind: 'counter' }>): Check {
  const dev = deviceNamed(sim, a.device);
  if (dev === undefined) return noDevice(a.device);
  const port = portNamed(dev, a.port);
  if (port === undefined) return noPort(a.device, a.port);
  const actual = (port.counters as Record<keyof PortCounters, number | undefined>)[a.counter] ?? 0;
  const pass = a.op === 'gt' ? actual > a.value : a.op === 'lt' ? actual < a.value : actual === a.value;
  if (pass) return PASS;
  const word = a.op === 'gt' ? 'more than' : a.op === 'lt' ? 'fewer than' : 'exactly';
  return fail(`${a.device} ${a.port} ${String(a.counter)} is ${actual}, expected ${word} ${a.value}.`);
}

export function checkTraceSeen(sim: Simulation, a: Extract<LabAssertion, { kind: 'traceSeen' }>): Check {
  const min = Math.max(1, Math.floor(a.min ?? 1));
  const found = sim.traceQuery({ from: 0, filter: a.filter, limit: min }).events.length;
  if (found >= min) return PASS;
  return fail(`The retained trace holds ${found} matching event${found === 1 ? '' : 's'}, expected at least ${min}.`);
}

// ── connectivity (disposable clones) ─────────────────────────────────────────

/** The sent/received counts of one ping job, read from the icmpv4 / icmpv6 StateView. */
function jobCounts(dev: DeviceRuntime, process: 'icmpv4' | 'icmpv6', session: string): { sent: number; received: number } | undefined {
  const proc = dev.processes.get(process);
  if (proc === undefined) return undefined;
  const jobs = proc.stateSnapshot().state['jobs'];
  if (!Array.isArray(jobs)) return undefined;
  for (const entry of jobs as Record<string, unknown>[]) {
    if (entry['session'] !== session) continue;
    return { sent: Number(entry['sent'] ?? 0), received: Number(entry['received'] ?? 0) };
  }
  return undefined;
}

/**
 * The final counts of a FINISHED echo job, taken from the daemon's own completion record. icmpv4 / icmpv6 delete a
 * job inside the dispatch that receives its last reply, so that reply can never be sampled from the StateView —
 * `finish()` emits it as structured debug data (`{ session, target, sent, received, lost }`) instead.
 */
function finishedCounts(dev: DeviceRuntime, process: 'icmpv4' | 'icmpv6', session: string): { sent: number; received: number } | undefined {
  const events = dev.processes.get(process)?.debugEvents() ?? [];
  for (let i = events.length - 1; i >= 0; i--) {
    const data = events[i]?.data;
    if (data === undefined) continue;
    const d = data as Record<string, unknown>;
    if (d['session'] !== session || d['received'] === undefined) continue;
    return { sent: Number(d['sent'] ?? 0), received: Number(d['received'] ?? 0) };
  }
  return undefined;
}

/** The address of `dev` a connectivity check pings (first port in port order that has one). */
export function pingAddressOf(dev: DeviceRuntime, family: 4 | 6): string | undefined {
  if (family === 4) {
    for (const p of dev.ports.values()) if (p.l3.ipv4 !== undefined) return p.l3.ipv4.address;
    return undefined;
  }
  const preferred: string[] = [];
  const other: string[] = [];
  for (const p of dev.ports.values()) {
    for (const v6 of p.l3.ipv6 ?? []) {
      if (v6.scope === 'link-local') continue;
      (v6.state === 'preferred' ? preferred : other).push(v6.address);
    }
  }
  return preferred[0] ?? other[0];
}

/** Does `dev` hold `address` on any of its ports? (A device pinging itself always gets a reply.) */
function ownsAddress(dev: DeviceRuntime, family: 4 | 6, address: string): boolean {
  for (const p of dev.ports.values()) {
    if (family === 4) {
      if (p.l3.ipv4?.address === address) return true;
      continue;
    }
    for (const v6 of p.l3.ipv6 ?? []) if (v6.address === address) return true;
  }
  return false;
}


/** @since P3 Does `dev` hold `address` (written in `family`'s canonical form) on any of its ports? */
function holdsAddress(dev: DeviceRuntime, family: 4 | 6, address: string): boolean {
  for (const p of dev.ports.values()) {
    if (family === 4) {
      if (p.l3.ipv4?.address === address) return true;
      continue;
    }
    for (const v6 of p.l3.ipv6 ?? []) if ((normalizeIpv6(v6.address) ?? v6.address) === address) return true;
  }
  return false;
}

/** @since P3 `text` as an address of `family` in its canonical written form, or undefined when it is not one. */
function addressOf(family: 4 | 6, text: string): string | undefined {
  const t = text.trim();
  if (family === 4) return isIpv4(t) ? t : undefined;
  return normalizeIpv6(t) ?? undefined;
}

/**
 * @since P3 The addresses of `port` in `family` a check can target or send from: its IPv4 address, or its IPv6 addresses
 * that are not link-local (preferred ones first), each in canonical form.
 */
export function portAddressesOf(port: PortState, family: 4 | 6): string[] {
  if (family === 4) return port.l3.ipv4 === undefined ? [] : [port.l3.ipv4.address];
  const preferred: string[] = [];
  const other: string[] = [];
  for (const v6 of port.l3.ipv6 ?? []) {
    if (v6.scope === 'link-local') continue;
    (v6.state === 'preferred' ? preferred : other).push(normalizeIpv6(v6.address) ?? v6.address);
  }
  return [...preferred, ...other];
}

/** @since P3 Each device's addresses per port and family (fault clones record them just before their faults). */
export function portAddressMap(clone: Simulation): Map<DeviceId, Map<PortId, Readonly<Record<4 | 6, readonly string[]>>>> {
  const out = new Map<DeviceId, Map<PortId, Readonly<Record<4 | 6, readonly string[]>>>>();
  for (const d of clone.devices()) {
    const ports = new Map<PortId, Readonly<Record<4 | 6, readonly string[]>>>();
    for (const p of d.ports.values()) ports.set(p.id, { 4: portAddressesOf(p, 4), 6: portAddressesOf(p, 6) });
    out.set(d.id, ports);
  }
  return out;
}

/**
 * Run one echo job in the clone and report its counts. The daemon forgets a finished job, so the StateView is
 * sampled before every step AND the daemon's completion record is read afterwards — the reply that completes a job
 * arrives in the same dispatch that deletes it, so sampling alone can never see the last reply.
 * P3: `source` (an address of the device; absent = the P2 request) is the echo requests' source address.
 */
function runPing(
  clone: Simulation,
  device: DeviceId,
  family: 4 | 6,
  session: string,
  target: string,
  byName: boolean,
  timeoutNs: SimTime,
  source?: string,
): { sent: number; received: number } {
  const dev = clone.device(device);
  const process = family === 4 ? 'icmpv4' : 'icmpv6';
  if (dev === undefined || !dev.processes.has(process)) return { sent: 0, received: 0 };
  const from = source === undefined ? {} : { source };
  const req: ProcessRequest =
    family === 4
      ? { kind: 'icmp.ping', session, target, count: LAB_PING_COUNT, timeoutNs, sizeBytes: LAB_PING_SIZE_BYTES, ...from }
      : { kind: 'icmp6.ping', session, target, count: LAB_PING_COUNT, timeoutNs, sizeBytes: LAB_PING_SIZE_BYTES, ...from };
  dev.applyActions(SIM_PROCESS_NAME, [{ type: 'request', to: process, req }], clone.now);

  let sent = 0;
  let received = 0;
  let seen = false;
  const deadline = clone.now + timeoutNs * (LAB_PING_COUNT + 2) + LAB_PING_SETTLE_NS;
  for (let i = 0; i < LAB_PING_MAX_EVENTS; i++) {
    const counts = jobCounts(dev, process, session);
    if (counts !== undefined) {
      seen = true;
      sent = Math.max(sent, counts.sent);
      received = Math.max(received, counts.received);
    } else if (seen) {
      break;
    } else if (i === 0 && !byName) {
      // A literal target creates its job inside the request; no job here means the device had no route at all.
      break;
    }
    const next = clone.nextEventTime();
    if (next === undefined || next > deadline) break;
    if (clone.step() === undefined) break;
  }
  const done = finishedCounts(dev, process, session);
  if (done !== undefined) {
    sent = Math.max(sent, done.sent);
    received = Math.max(received, done.received);
  }
  return { sent, received };
}

// ── P3: transport probes and what the clone trace shows of a probe (§2.10) ─────

/** @since P3 The newest outcome record of the transport probe `session` in `process`'s StateView `probes`. */
function probeViewOf(dev: DeviceRuntime, process: 'tcp' | 'udp', session: string): TransportProbeView | undefined {
  const probes = dev.processes.get(process)?.stateSnapshot().state['probes'];
  if (!Array.isArray(probes)) return undefined;
  for (let i = probes.length - 1; i >= 0; i--) {
    const v = probes[i] as TransportProbeView | undefined;
    if (v !== undefined && v.session === session) return v;
  }
  return undefined;
}

/**
 * @since P3 Send one `tcp.probe` / `udp.probe` from `device` in the clone (applied exactly as `icmp.ping` is) and step
 * the clone until the probe settles, its timeout plus LAB_PING_SETTLE_NS passes, or nothing is left to run. Returns
 * the probe's outcome record (undefined only when the device does not run that transport). On a managed switch whose
 * transport is dormant (D22), the probe holds it awake for its life, as an outbound session does (rulings R17/R27,
 * `ext.ipv4.transportHold`), so the reply is not dropped; the hold is released when the probe ends (clone only).
 */
function runTransportProbe(
  clone: Simulation,
  device: DeviceId,
  proto: 'tcp' | 'udp',
  session: string,
  target: string,
  port: number,
  src: string | undefined,
  timeoutNs: SimTime,
): TransportProbeView | undefined {
  const dev = clone.device(device);
  if (dev === undefined || !dev.processes.has(proto)) return undefined;
  const from = src === undefined ? {} : { src };
  const req: ProcessRequest =
    proto === 'tcp'
      ? { kind: 'tcp.probe', session, dst: target, port, timeoutNs, ...from }
      : { kind: 'udp.probe', session, dst: target, port, timeoutNs, ...from };
  const hold = dormantTransportEligible(dev.model, proto) && dev.processes.has('ipv4');
  const holdKey = `lab-probe:${session}`;
  if (hold) dev.applyActions(SIM_PROCESS_NAME, [{ type: 'request', to: 'ipv4', req: transportHoldRequest(proto, holdKey, true) }], clone.now);
  dev.applyActions(SIM_PROCESS_NAME, [{ type: 'request', to: proto, req }], clone.now);
  const deadline = clone.now + timeoutNs + LAB_PING_SETTLE_NS;
  for (let i = 0; i < LAB_PING_MAX_EVENTS; i++) {
    const view = probeViewOf(dev, proto, session);
    if (view === undefined || view.outcome !== 'pending') break;
    const next = clone.nextEventTime();
    if (next === undefined || next > deadline) break;
    if (clone.step() === undefined) break;
  }
  if (hold) dev.applyActions(SIM_PROCESS_NAME, [{ type: 'request', to: 'ipv4', req: transportHoldRequest(proto, holdKey, false) }], clone.now);
  return probeViewOf(dev, proto, session);
}

/** @since P3 One drop of a probe (or of a copy of it) in the clone trace; `device` is absent for a drop on a link. */
export interface ProbeDrop {
  readonly device?: DeviceId;
  readonly reason: DropReason;
}

/** @since P3 What the clone trace showed about one probe while it ran (file header). */
export interface ProbeTrail {
  /** The probe's PduIds: those its process created on `from` with the probe's tag, and every copy made of them. */
  readonly ids: ReadonlySet<PduId>;
  /** Its drops, in trace order. */
  readonly drops: readonly ProbeDrop[];
  /** The devices on which a PDU of the probe was consumed, in trace order. */
  readonly consumedAt: readonly DeviceId[];
}

/** @since P3 The processes that send a connectivity probe. */
type ProbeProcess = 'icmpv4' | 'icmpv6' | 'tcp' | 'udp';

/** @since P3 Is `tag` the tag of a probe PDU of `process` (the echo requests of a ping job, the transport probes)? */
function isProbeTag(process: ProbeProcess, tag: string | undefined): boolean {
  if (tag === undefined) return false;
  switch (process) {
    case 'icmpv4':
      return tag.startsWith('ping#');
    case 'icmpv6':
      return tag.startsWith('ping6#');
    case 'tcp':
      return tag === 'tcp-probe';
    case 'udp':
      return tag === 'udp-probe';
  }
}

/**
 * @since P3 Watch the clone trace for the probe `process` sends from `from`, through a synchronous trace listener (the
 * clone's ring capacity does not matter); `stop()` removes the listener.
 */
function watchProbe(clone: Simulation, from: DeviceId, process: ProbeProcess): { readonly trail: ProbeTrail; stop(): void } {
  const ids = new Set<PduId>();
  const drops: ProbeDrop[] = [];
  const consumedAt: DeviceId[] = [];
  const stop = clone.onTrace((ev: TraceEvent) => {
    if (ev.kind === 'pduCreated') {
      if (ev.device === from && ev.process === process && isProbeTag(process, ev.pdu.tag)) ids.add(ev.pdu.id);
      return;
    }
    if (ev.kind !== 'drop' && ev.kind !== 'pduConsumed' && ev.kind !== 'frameTx' && ev.kind !== 'frameRx' && ev.kind !== 'frameAbort' && ev.kind !== 'frameQueued') return;
    const pdu = ev.pdu;
    // a copy of a probe PDU (a switch's flooded copy, a fan-out leg) is the probe too
    if (pdu.parent !== undefined && ids.has(pdu.parent)) ids.add(pdu.id);
    if (!ids.has(pdu.id)) return;
    if (ev.kind === 'drop') drops.push(ev.device === undefined ? { reason: ev.reason } : { device: ev.device, reason: ev.reason });
    else if (ev.kind === 'pduConsumed') consumedAt.push(ev.device);
  });
  return { trail: { ids, drops, consumedAt }, stop };
}

/** A `connectivity.after` fault resolved against the live world to ids (the clone keeps every id). */
export type ResolvedFault =
  | { readonly kind: 'cut'; readonly link: LinkId }
  | { readonly kind: 'power'; readonly device: DeviceId }
  | { readonly kind: 'shutdown'; readonly device: DeviceId; readonly port: PortId }
  /** @since P3 A configuration fault: `lines` through the clone's `configure`, in the author's order. */
  | { readonly kind: 'config'; readonly device: DeviceId; readonly lines: readonly string[] };

/** Identity of a resolved fault (the fault set of a clone is the sorted set of these). */
export function faultKey(f: ResolvedFault): string {
  switch (f.kind) {
    case 'cut':
      return `cut:${f.link}`;
    case 'power':
      return `power:${f.device}`;
    case 'shutdown':
      return `shutdown:${f.device}|${f.port}`;
    case 'config':
      return `config:${f.device}|${JSON.stringify(f.lines)}`;
  }
}

/** @since P3 The cables between `a` and `b` that use port `aPort` of `a` and/or `bPort` of `b` (topology order). */
function cablesOnPorts(
  sim: Simulation,
  a: DeviceRuntime,
  b: DeviceRuntime,
  cut: Extract<LabFault, { cut: unknown }>['cut'],
): { ok: true; links: LinkId[] } | { ok: false; detail: string } {
  let pa: PortId | undefined;
  let pb: PortId | undefined;
  if (cut.aPort !== undefined) {
    const p = portNamed(a, cut.aPort);
    if (p === undefined) return { ok: false, detail: `${cut.a} has no interface called ${cut.aPort}.` };
    pa = p.id;
  }
  if (cut.bPort !== undefined) {
    const p = portNamed(b, cut.bPort);
    if (p === undefined) return { ok: false, detail: `${cut.b} has no interface called ${cut.bPort}.` };
    pb = p.id;
  }
  const joins = (l: TopologyLink): boolean => (l.a.device === a.id && l.b.device === b.id) || (l.a.device === b.id && l.b.device === a.id);
  const endOn = (l: TopologyLink, dev: DeviceId): PortId => (l.a.device === dev ? l.a.port : l.b.port);
  const links = sim
    .exportTopology()
    .links.filter((l) => a.id !== b.id && joins(l) && (pa === undefined || endOn(l, a.id) === pa) && (pb === undefined || endOn(l, b.id) === pb))
    .map((l) => l.id);
  if (links.length === 0) {
    const side = (name: string, port: string | undefined): string => (port === undefined ? name : `${name} ${port}`);
    return { ok: false, detail: `No cable joins ${side(cut.a, cut.aPort)} and ${side(cut.b, cut.bPort)}, so there is no cable to cut.` };
  }
  return { ok: true, links };
}

/**
 * Resolve `faults` by name in the live world: the P2 faults deduplicated and sorted by identity, then (P3) the
 * configuration faults in the author's order; or the detail of what is missing.
 */
export function resolveFaults(sim: Simulation, faults: readonly LabFault[]): { ok: true; faults: ResolvedFault[] } | { ok: false; detail: string } {
  const byKey = new Map<string, ResolvedFault>();
  const configs: ResolvedFault[] = [];
  const add = (f: ResolvedFault): void => {
    byKey.set(faultKey(f), f);
  };
  for (const f of faults) {
    if ('cut' in f) {
      const a = deviceNamed(sim, f.cut.a);
      if (a === undefined) return { ok: false, detail: `There is no device called ${f.cut.a} in this topology.` };
      const b = deviceNamed(sim, f.cut.b);
      if (b === undefined) return { ok: false, detail: `There is no device called ${f.cut.b} in this topology.` };
      let links = linksBetween(sim, a.id, b.id);
      if (links.length === 0) return { ok: false, detail: `${f.cut.a} and ${f.cut.b} are not connected, so there is no cable to cut.` };
      // P3 (§2.10): only the cable on the named port(s)
      if (f.cut.aPort !== undefined || f.cut.bPort !== undefined) {
        const on = cablesOnPorts(sim, a, b, f.cut);
        if (!on.ok) return on;
        links = on.links;
      }
      for (const link of links) add({ kind: 'cut', link });
    } else if ('powerOff' in f) {
      const d = deviceNamed(sim, f.powerOff);
      if (d === undefined) return { ok: false, detail: `There is no device called ${f.powerOff} in this topology.` };
      add({ kind: 'power', device: d.id });
    } else if ('shutdown' in f) {
      const d = deviceNamed(sim, f.shutdown.device);
      if (d === undefined) return { ok: false, detail: `There is no device called ${f.shutdown.device} in this topology.` };
      const p = portNamed(d, f.shutdown.port);
      if (p === undefined) return { ok: false, detail: `${f.shutdown.device} has no interface called ${f.shutdown.port}.` };
      add({ kind: 'shutdown', device: d.id, port: p.id });
    } else if ('config' in f) {
      // P3 (§2.10): applied through `configure` in the clone, after the P2 faults, in the author's order
      const d = deviceNamed(sim, f.config.device);
      if (d === undefined) return { ok: false, detail: `There is no device called ${f.config.device} in this topology.` };
      const lines: unknown = f.config.lines;
      if (!Array.isArray(lines) || lines.some((l) => typeof l !== 'string')) return { ok: false, detail: 'A configuration fault is a list of configuration lines.' };
      configs.push({ kind: 'config', device: d.id, lines: [...(lines as string[])] });
    } else {
      return { ok: false, detail: 'A fault for a connectivity check is a cut, a powerOff, a shutdown or a config.' };
    }
  }
  const keys = [...byKey.keys()].sort();
  return { ok: true, faults: [...keys.map((k) => byKey.get(k) as ResolvedFault), ...configs] };
}

/** One clone of the graded world, or why it could not be built. */
export interface CloneEntry {
  readonly clone?: Simulation;
  readonly error?: string;
  /** Fault clones: each device's ping address per family just before the faults (a powered-off target keeps one). */
  readonly before?: ReadonlyMap<DeviceId, Readonly<Partial<Record<4 | 6, string>>>>;
  /** @since P3 Fault clones: each device's addresses per port and family just before the faults (`toIface`, `toAddress`). */
  readonly beforePorts?: ReadonlyMap<DeviceId, ReadonlyMap<PortId, Readonly<Record<4 | 6, readonly string[]>>>>;
}

/**
 * @since P3 The clone-side work of one check: given its clone entry and the clone's session-id allocator (one id per
 * probe sent, `lab-check:<n>` numbered per clone), its verdict.
 */
export type CloneCheck = (entry: CloneEntry, session: () => string) => Check;

/** The disposable clones of a graded world, built on first use and kept for one `evaluateLab` call (sim/lab-checks.ts). */
export interface CloneHost {
  /**
   * @since P3 Run `check` in the clone for `faults` (none = the base clone, which a fault clone runs `settleNs` after its
   * faults), after the checks already run in that clone in this call — or answer from the clone memo when the clone
   * input, the fault set, the check's position in that clone and `key` all match a recorded run (no clone is built).
   */
  run(faults: readonly ResolvedFault[], settleNs: SimTime, key: string, check: CloneCheck): Check;
}

/** @since P3 A static check (every kind but `connectivity`) against `sim`: the registry's dispatch, for `then`. */
export type StaticCheck = (sim: Simulation, a: Exclude<LabAssertion, { kind: 'connectivity' }>) => Check;

/** `settleMs` in ns: the given whole milliseconds (≥ 0), else the default. */
export function settleNsOf(settleMs: number | undefined): SimTime {
  const ms = settleMs !== undefined && Number.isFinite(settleMs) && settleMs >= 0 ? Math.round(settleMs) : LAB_AFTER_SETTLE_MS;
  return ms * MS;
}

/**
 * @since P3 A canonical JSON text of `v` (object keys sorted, undefined members left out, byte arrays as number lists):
 * equal values give equal text. A memo key only, never parsed.
 */
export function canonicalJson(v: unknown): string {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return JSON.stringify(v);
  if (typeof v === 'bigint') return JSON.stringify(v.toString());
  if (typeof v !== 'object') return 'null';
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  if (ArrayBuffer.isView(v)) return `{"$bytes":[${Array.from(new Uint8Array(v.buffer, v.byteOffset, v.byteLength)).join(',')}]}`;
  const o = v as Readonly<Record<string, unknown>>;
  const parts: string[] = [];
  for (const k of Object.keys(o).sort()) {
    const x = o[k];
    if (x === undefined) continue;
    parts.push(`${JSON.stringify(k)}:${canonicalJson(x)}`);
  }
  return `{${parts.join(',')}}`;
}

/** @since P3 Display names of the probe protocols. */
const PROTO_NAME = Object.freeze({ icmp: 'ICMP', tcp: 'TCP', udp: 'UDP' } as const);

/** @since P3 What a connectivity check resolved in the live world for its widened members (all absent for a P2 check). */
interface ConnectivityPlan {
  readonly proto: 'icmp' | 'tcp' | 'udp';
  /** TCP/UDP: the destination port. */
  readonly port?: number;
  /** `toIface` resolved on the live `to`. */
  readonly toPort?: PortId;
  /** `toAddress` in canonical form. */
  readonly toAddress?: string;
  /** `source`: an address (canonical) or a port of `from`. */
  readonly source?: { readonly address: string } | { readonly port: PortId };
  /** `droppedAt` resolved to its device. */
  readonly dropAt?: DeviceId;
}

/** @since P3 Resolve the widened members of `a` in the live world (file header); a refusal is the check's failure. */
function planOf(
  sim: Simulation,
  a: Extract<LabAssertion, { kind: 'connectivity' }>,
  from: DeviceRuntime,
  to: DeviceRuntime | undefined,
  family: 4 | 6,
): { ok: true; plan: ConnectivityPlan } | { ok: false; check: Check } {
  const refuse = (detail: string): { ok: false; check: Check } => ({ ok: false, check: fail(detail) });
  const proto: unknown = a.proto ?? 'icmp';
  if (proto !== 'icmp' && proto !== 'tcp' && proto !== 'udp') return refuse(`"${String(proto)}" is not a protocol a connectivity check can use; use icmp, tcp or udp.`);
  const plan: { -readonly [K in keyof ConnectivityPlan]: ConnectivityPlan[K] } = { proto };
  if (proto === 'icmp') {
    if (a.port !== undefined) return refuse('A port belongs to a TCP or UDP connectivity check, not to a ping.');
  } else {
    if (a.byName === true) return refuse(`A ${PROTO_NAME[proto]} connectivity check needs an address; it cannot look a name up.`);
    if (a.port === undefined || !Number.isInteger(a.port) || a.port < 1 || a.port > 0xffff) return refuse(`A ${PROTO_NAME[proto]} connectivity check needs a port from 1 to 65535.`);
    plan.port = a.port;
  }
  if (a.droppedAt !== undefined || a.dropReason !== undefined) {
    if (a.expect !== 'fail') return refuse('Where or why a packet is dropped is checked only when the check expects it to fail.');
    if (a.droppedAt !== undefined) {
      const d = deviceNamed(sim, a.droppedAt);
      if (d === undefined) return { ok: false, check: noDevice(a.droppedAt) };
      plan.dropAt = d.id;
    }
  }
  if (a.toIface !== undefined || a.toAddress !== undefined) {
    if (to === undefined) return refuse('A connectivity check by name cannot also target an interface or an address.');
    if (a.toIface !== undefined) {
      const p = portNamed(to, a.toIface);
      if (p === undefined) return { ok: false, check: noPort(a.to, a.toIface) };
      plan.toPort = p.id;
    }
    if (a.toAddress !== undefined) {
      const address = addressOf(family, a.toAddress);
      if (address === undefined) return refuse(`${a.toAddress} is not an IPv${family} address.`);
      plan.toAddress = address;
    }
  }
  if (a.source !== undefined) {
    const address = addressOf(family, a.source);
    if (address !== undefined) {
      plan.source = { address };
    } else {
      const p = portNamed(from, a.source);
      if (p === undefined) return refuse(`${a.from} has no interface or IPv${family} address called ${a.source}.`);
      plan.source = { port: p.id };
    }
  }
  return { ok: true, plan };
}

/**
 * The address a check targets inside the clone: P2's first address of `to` (or, in a fault clone, the one it held just
 * before the faults); P3's `toIface` / `toAddress` the same way, per port.
 */
function targetIn(
  entry: CloneEntry,
  cloneTo: DeviceRuntime | undefined,
  toId: DeviceId,
  family: 4 | 6,
  a: Extract<LabAssertion, { kind: 'connectivity' }>,
  plan: ConnectivityPlan,
): { address: string } | { detail: string } {
  if (plan.toPort === undefined && plan.toAddress === undefined) {
    const address = (cloneTo === undefined ? undefined : pingAddressOf(cloneTo, family)) ?? entry.before?.get(toId)?.[family];
    return address === undefined ? { detail: `${a.to} has no IPv${family} address to be reached at.` } : { address };
  }
  const before = entry.beforePorts?.get(toId);
  const now = (port: PortId): readonly string[] => {
    const p = cloneTo?.port(port);
    return p === undefined ? [] : portAddressesOf(p, family);
  };
  const then = (port: PortId): readonly string[] => before?.get(port)?.[family] ?? [];
  if (plan.toPort !== undefined) {
    const port = plan.toPort;
    if (plan.toAddress === undefined) {
      const address = now(port)[0] ?? then(port)[0];
      return address === undefined ? { detail: `${a.to} ${a.toIface ?? port} has no IPv${family} address to be reached at.` } : { address };
    }
    const held = now(port).includes(plan.toAddress) || then(port).includes(plan.toAddress);
    return held ? { address: plan.toAddress } : { detail: `${a.to} ${a.toIface ?? port} does not hold ${plan.toAddress}.` };
  }
  const address = plan.toAddress as string;
  const ports = new Set<PortId>([...(cloneTo === undefined ? [] : [...cloneTo.ports.keys()]), ...(before === undefined ? [] : [...before.keys()])]);
  for (const port of ports) if (now(port).includes(address) || then(port).includes(address)) return { address };
  return { detail: `${a.to} does not hold ${address}.` };
}

/** The source address of a check inside the clone (P3 `source`). */
function sourceIn(
  cloneFrom: DeviceRuntime,
  family: 4 | 6,
  a: Extract<LabAssertion, { kind: 'connectivity' }>,
  source: NonNullable<ConnectivityPlan['source']>,
): { address: string } | { detail: string } {
  if ('address' in source) return holdsAddress(cloneFrom, family, source.address) ? { address: source.address } : { detail: `${a.from} does not hold ${source.address}.` };
  const p = cloneFrom.port(source.port);
  const address = p === undefined ? undefined : portAddressesOf(p, family)[0];
  return address === undefined ? { detail: `${a.from} ${a.source ?? source.port} has no IPv${family} address to send from.` } : { address };
}

/** Why a transport probe that should have passed did not, in words (the ICMP error first, then a drop, then the timeout). */
function transportWhy(clone: Simulation, a: Extract<LabAssertion, { kind: 'connectivity' }>, view: TransportProbeView, trail: ProbeTrail, timeoutMs: number): string {
  if (view.outcome === 'refused') return 'the port is closed (it answered with a reset)';
  if (view.outcome === 'unreachable') {
    if (view.icmp !== undefined) return `an ICMP unreachable came back (type ${view.icmp.type}, code ${view.icmp.code})`;
    return `it could not leave ${a.from} (no route or no source address)`;
  }
  const drop = shownDrop(trail);
  if (drop !== undefined) return `it was dropped ${dropPlace(clone, drop)} (${drop.reason})`;
  return `nothing answered within ${timeoutMs} ms`;
}

/** The drop a detail names: the first that is not a flooded copy's, else the first. */
function shownDrop(trail: ProbeTrail): ProbeDrop | undefined {
  return trail.drops.find((d) => !LAB_FLOOD_DROP_REASONS.includes(d.reason)) ?? trail.drops[0];
}

/** Where a drop happened, in words. */
function dropPlace(clone: Simulation, d: ProbeDrop): string {
  return d.device === undefined ? 'on a link' : `at ${clone.device(d.device)?.spec.name ?? d.device}`;
}

/** @since P3 The `droppedAt` / `dropReason` verdict over a failed probe's trail (file header). */
function dropVerdict(clone: Simulation, a: Extract<LabAssertion, { kind: 'connectivity' }>, plan: ConnectivityPlan, trail: ProbeTrail, target: string): Check {
  const counted = trail.drops.filter((d) => a.dropReason !== undefined || !LAB_FLOOD_DROP_REASONS.includes(d.reason));
  if (counted.some((d) => (plan.dropAt === undefined || d.device === plan.dropAt) && (a.dropReason === undefined || d.reason === a.dropReason))) return PASS;
  const reason = a.dropReason === undefined ? '' : ` (${a.dropReason})`;
  const want = a.droppedAt === undefined ? `a drop${reason}` : `a drop at ${a.droppedAt}${reason}`;
  const shown = shownDrop(trail);
  if (shown === undefined) return fail(`${a.from}'s probe to ${target} was not dropped by any device; expected ${want}.`);
  return fail(`${a.from}'s probe to ${target} was dropped ${dropPlace(clone, shown)} (${shown.reason}); expected ${want}.`);
}

export function checkConnectivity(sim: Simulation, host: CloneHost, a: Extract<LabAssertion, { kind: 'connectivity' }>, checkStatic: StaticCheck): Check {
  const family: 4 | 6 = a.family ?? 4;
  const from = deviceNamed(sim, a.from);
  if (from === undefined) return noDevice(a.from);
  const to = a.byName === true ? undefined : deviceNamed(sim, a.to);
  if (a.byName === true) {
    if (family === 6) return fail('A connectivity check by name needs IPv4; give an address for an IPv6 check.');
  } else if (to === undefined) {
    return noDevice(a.to);
  }
  // P3 (§2.10): the widened members, resolved in the live world before any clone is built
  const planned = planOf(sim, a, from, to, family);
  if (!planned.ok) return planned.check;
  const plan = planned.plan;
  const resolved = resolveFaults(sim, a.after ?? []);
  if (!resolved.ok) return fail(resolved.detail);
  const fromId = from.id;
  const toId = to?.id;
  return host.run(resolved.faults, settleNsOf(a.settleMs), canonicalJson(a), (entry, session) => connectivityInClone(entry, session, a, fromId, toId, plan, checkStatic));
}

/** The clone side of one connectivity check (the closure `CloneHost.run` runs, or replays). */
function connectivityInClone(
  entry: CloneEntry,
  session: () => string,
  a: Extract<LabAssertion, { kind: 'connectivity' }>,
  fromId: DeviceId,
  toId: DeviceId | undefined,
  plan: ConnectivityPlan,
  checkStatic: StaticCheck,
): Check {
  const family: 4 | 6 = a.family ?? 4;
  const clone = entry.clone;
  if (clone === undefined) return fail(entry.error ?? 'This world could not be copied for a connectivity check.');
  // Devices are matched by NAME in the live world but addressed INSIDE the clone: the clone replays DHCP from t=0,
  // so an address the live world gave one host can belong to another there. Resolving the target in the clone keeps
  // the check about the device, not about a string.
  const cloneFrom = clone.device(fromId);
  if (cloneFrom === undefined) return fail(`${a.from} could not be copied for a connectivity check.`);
  let target: string;
  if (toId === undefined) {
    target = a.to;
  } else {
    const t = targetIn(entry, clone.device(toId), toId, family, a, plan);
    if ('detail' in t) return fail(t.detail);
    const address = t.address;
    // A host that pings its own address always gets a reply, which would score a task whose point is that some
    // OTHER device answers.
    const own = plan.toPort === undefined && plan.toAddress === undefined ? ownsAddress(cloneFrom, family, address) : holdsAddress(cloneFrom, family, address);
    if (fromId !== toId && own) {
      return fail(`${a.from} already holds ${address} itself, so a reply from it would not show that ${a.to} answers.`);
    }
    target = address;
  }
  // P3: the source address
  let source: string | undefined;
  if (plan.source !== undefined) {
    const s = sourceIn(cloneFrom, family, a, plan.source);
    if ('detail' in s) return fail(s.detail);
    source = s.address;
  }
  let trail: ProbeTrail | undefined;
  let what = 'the ping';
  if (plan.proto === 'icmp') {
    const timeoutNs = Math.max(1, Math.round(a.timeoutMs ?? LAB_PING_TIMEOUT_MS)) * MS;
    // P3: the trace is watched only when a drop is graded, so a P2 check runs exactly as before
    const watch = plan.dropAt !== undefined || a.dropReason !== undefined ? watchProbe(clone, fromId, family === 4 ? 'icmpv4' : 'icmpv6') : undefined;
    let counts: { sent: number; received: number };
    try {
      counts = runPing(clone, fromId, family, session(), target, a.byName === true, timeoutNs, source);
    } finally {
      watch?.stop();
    }
    trail = watch?.trail;
    const { sent, received } = counts;
    const reachable = received > 0;
    if (reachable !== (a.expect === 'success')) {
      return fail(
        a.expect === 'success'
          ? `${a.from} got no reply from ${target} (${sent} echo request${sent === 1 ? '' : 's'} sent).`
          : `${a.from} reached ${target} (${received} of ${sent} replied), which this task expects to fail.`,
      );
    }
  } else {
    // P3 (§2.10): one transport probe, applied like the ping
    const proto = plan.proto;
    const port = plan.port as number;
    if (!cloneFrom.processes.has(proto)) return fail(`${a.from} does not run ${PROTO_NAME[proto]}, so it cannot send the probe.`);
    const timeoutMs = Math.max(1, Math.round(a.timeoutMs ?? LAB_PROBE_TIMEOUT_MS));
    const watch = watchProbe(clone, fromId, proto);
    let view: TransportProbeView | undefined;
    try {
      view = runTransportProbe(clone, fromId, proto, session(), target, port, source, timeoutMs * MS);
    } finally {
      watch.stop();
    }
    trail = watch.trail;
    if (view === undefined) return fail(`${a.from} does not run ${PROTO_NAME[proto]}, so it cannot send the probe.`);
    const reached = proto === 'tcp' ? view.outcome === 'open' : toId !== undefined && trail.consumedAt.includes(toId);
    if (reached !== (a.expect === 'success')) {
      if (proto === 'tcp') {
        return fail(
          a.expect === 'success'
            ? `${a.from} could not open TCP port ${port} on ${target}: ${transportWhy(clone, a, view, trail, timeoutMs)}.`
            : `${a.from} opened TCP port ${port} on ${target}, which this task expects to fail.`,
        );
      }
      return fail(
        a.expect === 'success'
          ? `${a.from}'s UDP datagram to ${target} port ${port} reached no listener: ${transportWhy(clone, a, view, trail, timeoutMs)}.`
          : `${a.from}'s UDP datagram reached a listener on port ${port} of ${target}, which this task expects to fail.`,
      );
    }
    what = `the ${PROTO_NAME[proto]} probe`;
  }
  // P3 (§2.10): where and why the probe was dropped (expect 'fail' only, checked by planOf)
  if (trail !== undefined && (plan.dropAt !== undefined || a.dropReason !== undefined)) {
    const r = dropVerdict(clone, a, plan, trail, target);
    if (!r.pass) return r;
  }
  // P2 (§2.10): follow-up static checks in the same clone, after the ping (the rows the ping created)
  for (const next of a.then ?? []) {
    const r = next.kind === 'connectivity' ? fail('A follow-up check reads state; it cannot ping again.') : checkStatic(clone, next);
    if (!r.pass) return fail(`After ${what} from ${a.from}: ${r.detail ?? 'a follow-up check failed.'}`);
  }
  return PASS;
}
