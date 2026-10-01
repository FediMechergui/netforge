/**
 * sim/lab-checks/core.ts — the P1 checkers and the helpers every checker shares (ARCHITECTURE-P1 §4.13; ARCHITECTURE-P2
 * §2.10; ARCHITECTURE-P3 D5, §7 W1 sim: moved VERBATIM from sim/lab-checks.ts, proved by `accept.p3.lab-status`).
 *
 * Assertion kinds and what they read:
 *   config       → `DeviceRuntime.running.query(path)` (dotted ConfigAst path), then `exists` / `equals` / `contains`;
 *   port         → the live `PortState` (operUp, adminUp, ipv4, ipv6, duplex, speedBps, role; P2 errDisabled);
 *   table        → `DeviceRuntime.tables.get(name)`, rows filtered by `where` (field-by-field, text-compared; P2: a
 *                  value of a column whose TABLE_DESCRIPTORS format is 'port' is first resolved through the device's
 *                  port-name resolver, so `Gi0/1` matches `GigabitEthernet0/1`);
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
 */
import type { ConfigNode } from '../../contracts/config.js';
import type { DeviceRuntime } from '../../contracts/device.js';
import type { DeviceId, LinkId, PortId } from '../../contracts/ids.js';
import type { PortCounters, PortState } from '../../contracts/port.js';
import type { LabAssertion, LabFault } from '../../contracts/scenario.js';
import type { Simulation } from '../../contracts/simulation.js';
import { TABLE_DESCRIPTORS, type TableDescriptor, type TableName, type TableRow } from '../../contracts/tables.js';
import { MS, SEC, type SimTime } from '../../contracts/time.js';
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

export function checkTable(sim: Simulation, a: Extract<LabAssertion, { kind: 'table' }>): Check {
  const dev = deviceNamed(sim, a.device);
  if (dev === undefined) return noDevice(a.device);
  const table = dev.tables.get(a.table);
  if (table === undefined) return fail(`${a.device} keeps no ${a.table} table (it has ${dev.tables.names().join(', ')}).`);
  // P2 (§11.2): a value of a 'port' column is compared in its canonical form (Gi0/1 matches GigabitEthernet0/1)
  const ports = portColumnsOf(a.table);
  const where = Object.entries(a.where).map(([k, v]): [string, unknown] => [k, ports.has(k) && typeof v === 'string' ? canonicalPortName(dev, v) : v]);
  const matches = table.find((row: TableRow) => {
    const r = row as unknown as Record<string, unknown>;
    for (const [k, v] of where) if (!sameValue(r[k], v)) return false;
    return true;
  });
  const text = Object.entries(a.where).map(([k, v]) => `${k}=${String(v)}`).join(' ');
  if (matches.length > 0 === a.exists) return PASS;
  return fail(a.exists ? `The ${a.table} table of ${a.device} has no row with ${text}.` : `The ${a.table} table of ${a.device} still has a row with ${text}.`);
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

/**
 * Run one echo job in the clone and report its counts. The daemon forgets a finished job, so the StateView is
 * sampled before every step AND the daemon's completion record is read afterwards — the reply that completes a job
 * arrives in the same dispatch that deletes it, so sampling alone can never see the last reply.
 */
function runPing(
  clone: Simulation,
  device: DeviceId,
  family: 4 | 6,
  session: string,
  target: string,
  byName: boolean,
  timeoutNs: SimTime,
): { sent: number; received: number } {
  const dev = clone.device(device);
  const process = family === 4 ? 'icmpv4' : 'icmpv6';
  if (dev === undefined || !dev.processes.has(process)) return { sent: 0, received: 0 };
  const req =
    family === 4
      ? ({ kind: 'icmp.ping', session, target, count: LAB_PING_COUNT, timeoutNs, sizeBytes: LAB_PING_SIZE_BYTES } as const)
      : ({ kind: 'icmp6.ping', session, target, count: LAB_PING_COUNT, timeoutNs, sizeBytes: LAB_PING_SIZE_BYTES } as const);
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

/** A `connectivity.after` fault resolved against the live world to ids (the clone keeps every id). */
export type ResolvedFault =
  | { readonly kind: 'cut'; readonly link: LinkId }
  | { readonly kind: 'power'; readonly device: DeviceId }
  | { readonly kind: 'shutdown'; readonly device: DeviceId; readonly port: PortId };

/** Identity of a resolved fault (the fault set of a clone is the sorted set of these). */
export function faultKey(f: ResolvedFault): string {
  switch (f.kind) {
    case 'cut':
      return `cut:${f.link}`;
    case 'power':
      return `power:${f.device}`;
    case 'shutdown':
      return `shutdown:${f.device}|${f.port}`;
  }
}

/** Resolve `faults` by name in the live world: deduplicated, sorted by identity; or the detail of what is missing. */
function resolveFaults(sim: Simulation, faults: readonly LabFault[]): { ok: true; faults: ResolvedFault[] } | { ok: false; detail: string } {
  const byKey = new Map<string, ResolvedFault>();
  const add = (f: ResolvedFault): void => {
    byKey.set(faultKey(f), f);
  };
  for (const f of faults) {
    if ('cut' in f) {
      const a = deviceNamed(sim, f.cut.a);
      if (a === undefined) return { ok: false, detail: `There is no device called ${f.cut.a} in this topology.` };
      const b = deviceNamed(sim, f.cut.b);
      if (b === undefined) return { ok: false, detail: `There is no device called ${f.cut.b} in this topology.` };
      const links = linksBetween(sim, a.id, b.id);
      if (links.length === 0) return { ok: false, detail: `${f.cut.a} and ${f.cut.b} are not connected, so there is no cable to cut.` };
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
    } else {
      return { ok: false, detail: 'A fault for a connectivity check is a cut, a powerOff or a shutdown.' };
    }
  }
  const keys = [...byKey.keys()].sort();
  return { ok: true, faults: keys.map((k) => byKey.get(k) as ResolvedFault) };
}

/** One clone of the graded world, or why it could not be built. */
export interface CloneEntry {
  readonly clone?: Simulation;
  readonly error?: string;
  /** Fault clones: each device's ping address per family just before the faults (a powered-off target keeps one). */
  readonly before?: ReadonlyMap<DeviceId, Readonly<Partial<Record<4 | 6, string>>>>;
}

/** The disposable clones of a graded world, built on first use and kept for one `evaluateLab` call. */
export interface CloneHost {
  /** The clone for `faults` (none = the base clone), which runs `settleNs` after its faults. */
  get(faults: readonly ResolvedFault[], settleNs: SimTime): CloneEntry;
  nextSession(): string;
}


/** @since P3 A static check (every kind but `connectivity`) against `sim`: the registry's dispatch, for `then`. */
export type StaticCheck = (sim: Simulation, a: Exclude<LabAssertion, { kind: 'connectivity' }>) => Check;

/** `settleMs` in ns: the given whole milliseconds (≥ 0), else the default. */
function settleNsOf(settleMs: number | undefined): SimTime {
  const ms = settleMs !== undefined && Number.isFinite(settleMs) && settleMs >= 0 ? Math.round(settleMs) : LAB_AFTER_SETTLE_MS;
  return ms * MS;
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
  const resolved = resolveFaults(sim, a.after ?? []);
  if (!resolved.ok) return fail(resolved.detail);
  const entry = host.get(resolved.faults, settleNsOf(a.settleMs));
  const clone = entry.clone;
  if (clone === undefined) return fail(entry.error ?? 'This world could not be copied for a connectivity check.');
  // Devices are matched by NAME in the live world but addressed INSIDE the clone: the clone replays DHCP from t=0,
  // so an address the live world gave one host can belong to another there. Resolving the target in the clone keeps
  // the check about the device, not about a string.
  const cloneFrom = clone.device(from.id);
  if (cloneFrom === undefined) return fail(`${a.from} could not be copied for a connectivity check.`);
  let target: string;
  if (to === undefined) {
    target = a.to;
  } else {
    const cloneTo = clone.device(to.id);
    const address = (cloneTo === undefined ? undefined : pingAddressOf(cloneTo, family)) ?? entry.before?.get(to.id)?.[family];
    if (address === undefined) return fail(`${a.to} has no IPv${family} address to be reached at.`);
    // A host that pings its own address always gets a reply, which would score a task whose point is that some
    // OTHER device answers.
    if (from.id !== to.id && ownsAddress(cloneFrom, family, address)) {
      return fail(`${a.from} already holds ${address} itself, so a reply from it would not show that ${a.to} answers.`);
    }
    target = address;
  }
  const timeoutNs = Math.max(1, Math.round(a.timeoutMs ?? LAB_PING_TIMEOUT_MS)) * MS;
  const { sent, received } = runPing(clone, from.id, family, host.nextSession(), target, a.byName === true, timeoutNs);
  const reachable = received > 0;
  if (reachable !== (a.expect === 'success')) {
    return fail(
      a.expect === 'success'
        ? `${a.from} got no reply from ${target} (${sent} echo request${sent === 1 ? '' : 's'} sent).`
        : `${a.from} reached ${target} (${received} of ${sent} replied), which this task expects to fail.`,
    );
  }
  // P2 (§2.10): follow-up static checks in the same clone, after the ping (the rows the ping created)
  for (const next of a.then ?? []) {
    const r = next.kind === 'connectivity' ? fail('A follow-up check reads state; it cannot ping again.') : checkStatic(clone, next);
    if (!r.pass) return fail(`After the ping from ${a.from}: ${r.detail ?? 'a follow-up check failed.'}`);
  }
  return PASS;
}
