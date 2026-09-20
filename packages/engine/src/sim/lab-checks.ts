/**
 * sim/lab-checks.ts — the lab grader (ARCHITECTURE-P1 §4.13; contracts/scenario.ts `EvaluateLab`, `LabAssertion`).
 *
 * `evaluateLab(sim, lab)` scores every task of a `ScenarioInfo` against STRUCTURED state — never scraped console
 * text. One task passes when every one of its assertions passes; a task that passes earns its points, a task that
 * fails earns none.
 *
 * Assertion kinds and what they read:
 *   config       → `DeviceRuntime.running.query(path)` (dotted ConfigAst path), then `exists` / `equals` / `contains`;
 *   port         → the live `PortState` (operUp, adminUp, ipv4, ipv6, duplex, speedBps, role);
 *   table        → `DeviceRuntime.tables.get(name)`, rows filtered by `where` (field-by-field, text-compared);
 *   process      → `Process.stateSnapshot().state` addressed by a dotted path whose array step is an index
 *                  (`a.b.0.c`) or a `field=value` selector (`clients.iface=Wlan0.state`) picking the first matching
 *                  element — use the selector whenever list order depends on what the student did;
 *   link         → the link between two device NAMES, optionally its media and `up`;
 *   counter      → a `PortCounters` field compared with gt / eq / lt (an absent P0.5 counter reads 0);
 *   traceSeen    → `Simulation.traceQuery` over the retained ring with the assertion's TraceFilter;
 *   connectivity → a ping in a DISPOSABLE CLONE (see below).
 *
 * The live simulation is never disturbed: nothing here advances its clock, emits trace or draws its rng. Reads are
 * plain property reads and `traceQuery` (which only pages the ring). `connectivity` therefore builds ONE clone per
 * `evaluateLab` call — `createSimulation({ seed: sim.seed })` + `loadTopology(sim.exportTopology())` + the live
 * world's cut cables re-cut (a cut is runtime state `TopologyLink` cannot carry, and a repaired copy would grade a
 * broken world as reachable) — lets it boot to idle and then issues `icmp.ping` / `icmp6.ping` there. Job counts are
 * sampled from the icmpv4 / icmpv6 StateView while the job runs AND reconciled afterwards with the daemon's
 * structured completion record, because the reply that completes a job arrives in the dispatch that deletes it.
 * `expect:'success'` needs at least one reply; `expect:'fail'` needs none. `byName` pings a DNS name, which the
 * icmpv4 job resolves through dns-client.
 *
 * The `to` of a connectivity check is matched by NAME in the live world but its address is read INSIDE the clone:
 * the clone replays DHCP from t=0, so a lease the live world gave one host can land on another there. A target that
 * turns out to be the pinging host's own address fails with an original detail instead of counting its own reply.
 *
 * Devices, ports and tables are addressed by NAME. An unknown one never throws: the assertion fails with an original
 * detail saying what could not be found, and so does any error raised while reading state.
 *
 * ponytail: one clone per evaluation, reused by every connectivity assertion in that call (cheaper than one clone
 * each, and each ping still starts from the same graded world); only `cable-cut` link state is replayed onto it,
 * because that is the one runtime L1 state a graded world reaches today — an err-disabled port (`downReason`
 * `err-disabled:a`/`:b`) would need the same treatment if a lab ever produces one. `byName` is IPv4 only, because the icmpv6 job takes
 * an address — a name check with `family: 6` fails with an original detail instead of pretending to resolve.
 * `ScenarioInfo.customChecks` is not run here: no LabTask references one and LabStatus has nowhere to report it.
 */
import type { ConfigNode } from '../contracts/config.js';
import type { DeviceRuntime } from '../contracts/device.js';
import type { DeviceId } from '../contracts/ids.js';
import type { PortCounters, PortState } from '../contracts/port.js';
import type { EvaluateLab, LabAssertion, LabCheckResult, LabStatus, ScenarioInfo } from '../contracts/scenario.js';
import type { Simulation } from '../contracts/simulation.js';
import type { TableRow } from '../contracts/tables.js';
import { MS, SEC, type SimTime } from '../contracts/time.js';
import { SIM_PROCESS_NAME, createSimulation } from './simulation.js';

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

/** Result of one assertion. */
interface Check {
  pass: boolean;
  detail?: string;
}

const PASS: Check = { pass: true };
const fail = (detail: string): Check => ({ pass: false, detail });

/** A device by topology name. */
function deviceNamed(sim: Simulation, name: string): DeviceRuntime | undefined {
  for (const d of sim.devices()) if (d.spec.name === name) return d;
  return undefined;
}

/** A port by long or short name. */
function portNamed(dev: DeviceRuntime, name: string): PortState | undefined {
  const direct = dev.port(name);
  if (direct !== undefined) return direct;
  const r = dev.resolvePortName(name);
  return r.kind === 'existing' ? dev.port(r.port) : undefined;
}

/** Compare two values the way a lab author writes them: identical, or the same text. */
function sameValue(actual: unknown, expected: unknown): boolean {
  return actual === expected || (actual !== undefined && actual !== null && String(actual) === String(expected));
}

/** `["10.0.0.1","255.255.255.0"]` rendered the way an author would type it. */
const nodeText = (n: ConfigNode): string => [n.key, ...n.args].join(' ');

// ── static assertions ────────────────────────────────────────────────────────

function checkConfig(sim: Simulation, a: Extract<LabAssertion, { kind: 'config' }>): Check {
  const dev = deviceNamed(sim, a.device);
  if (dev === undefined) return fail(`There is no device called ${a.device} in this topology.`);
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

function checkPort(sim: Simulation, a: Extract<LabAssertion, { kind: 'port' }>): Check {
  const dev = deviceNamed(sim, a.device);
  if (dev === undefined) return fail(`There is no device called ${a.device} in this topology.`);
  const port = portNamed(dev, a.port);
  if (port === undefined) return fail(`${a.device} has no interface called ${a.port}.`);
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
    default: {
      const actual = port[a.field];
      if (sameValue(actual, a.equals)) return PASS;
      return fail(`${a.device} ${a.port} ${a.field} is ${actual === undefined ? 'not set' : String(actual)}, expected ${String(a.equals)}.`);
    }
  }
}

function checkTable(sim: Simulation, a: Extract<LabAssertion, { kind: 'table' }>): Check {
  const dev = deviceNamed(sim, a.device);
  if (dev === undefined) return fail(`There is no device called ${a.device} in this topology.`);
  const table = dev.tables.get(a.table);
  if (table === undefined) return fail(`${a.device} keeps no ${a.table} table (it has ${dev.tables.names().join(', ')}).`);
  const matches = table.find((row: TableRow) => {
    const r = row as unknown as Record<string, unknown>;
    for (const [k, v] of Object.entries(a.where)) if (!sameValue(r[k], v)) return false;
    return true;
  });
  const where = Object.entries(a.where).map(([k, v]) => `${k}=${String(v)}`).join(' ');
  if (matches.length > 0 === a.exists) return PASS;
  return fail(a.exists ? `The ${a.table} table of ${a.device} has no row with ${where}.` : `The ${a.table} table of ${a.device} still has a row with ${where}.`);
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

function checkProcess(sim: Simulation, a: Extract<LabAssertion, { kind: 'process' }>): Check {
  const dev = deviceNamed(sim, a.device);
  if (dev === undefined) return fail(`There is no device called ${a.device} in this topology.`);
  const proc = dev.processes.get(a.process);
  if (proc === undefined) return fail(`${a.device} is not running its ${a.process} service.`);
  const actual = readPath(proc.stateSnapshot().state, a.path);
  if (sameValue(actual, a.equals)) return PASS;
  return fail(`${a.device} ${a.process} ${a.path} is ${actual === undefined ? 'not set' : String(actual)}, expected ${String(a.equals)}.`);
}

function checkLink(sim: Simulation, a: Extract<LabAssertion, { kind: 'link' }>): Check {
  const da = deviceNamed(sim, a.a);
  if (da === undefined) return fail(`There is no device called ${a.a} in this topology.`);
  const db = deviceNamed(sim, a.b);
  if (db === undefined) return fail(`There is no device called ${a.b} in this topology.`);
  const ids = new Set<DeviceId>([da.id, db.id]);
  const between = sim
    .exportTopology()
    .links.filter((l) => ids.has(l.a.device) && ids.has(l.b.device) && l.a.device !== l.b.device)
    .map((l) => sim.link(l.id))
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

function checkCounter(sim: Simulation, a: Extract<LabAssertion, { kind: 'counter' }>): Check {
  const dev = deviceNamed(sim, a.device);
  if (dev === undefined) return fail(`There is no device called ${a.device} in this topology.`);
  const port = portNamed(dev, a.port);
  if (port === undefined) return fail(`${a.device} has no interface called ${a.port}.`);
  const actual = (port.counters as Record<keyof PortCounters, number | undefined>)[a.counter] ?? 0;
  const pass = a.op === 'gt' ? actual > a.value : a.op === 'lt' ? actual < a.value : actual === a.value;
  if (pass) return PASS;
  const word = a.op === 'gt' ? 'more than' : a.op === 'lt' ? 'fewer than' : 'exactly';
  return fail(`${a.device} ${a.port} ${String(a.counter)} is ${actual}, expected ${word} ${a.value}.`);
}

function checkTraceSeen(sim: Simulation, a: Extract<LabAssertion, { kind: 'traceSeen' }>): Check {
  const min = Math.max(1, Math.floor(a.min ?? 1));
  const found = sim.traceQuery({ from: 0, filter: a.filter, limit: min }).events.length;
  if (found >= min) return PASS;
  return fail(`The retained trace holds ${found} matching event${found === 1 ? '' : 's'}, expected at least ${min}.`);
}

// ── connectivity (disposable clone) ──────────────────────────────────────────

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
function pingAddressOf(dev: DeviceRuntime, family: 4 | 6): string | undefined {
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

/** The disposable clone of a graded world, built once per `evaluateLab` call. */
interface CloneHost {
  get(): Simulation | undefined;
  nextSession(): string;
}

function createCloneHost(sim: Simulation): CloneHost {
  let clone: Simulation | undefined;
  let built = false;
  let sessions = 0;
  return {
    get(): Simulation | undefined {
      if (!built) {
        built = true;
        const fresh = createSimulation({ seed: sim.seed });
        const topo = sim.exportTopology();
        fresh.loadTopology(topo);
        // A cut cable is runtime state that TopologyLink cannot carry, so the copy would silently repair it and
        // grade a broken world as reachable. Re-cut those links before the clone settles.
        for (const l of topo.links) {
          if (sim.link(l.id)?.downReason === 'cut') {
            fresh.injectFault(0, { id: `lab-clone-cut:${l.id}`, kind: 'cable-cut', target: { link: l.id } });
          }
        }
        fresh.runToIdle(LAB_CLONE_BOOT_EVENTS);
        clone = fresh;
      }
      return clone;
    },
    nextSession(): string {
      sessions++;
      return `lab-check:${sessions}`;
    },
  };
}

function checkConnectivity(sim: Simulation, host: CloneHost, a: Extract<LabAssertion, { kind: 'connectivity' }>): Check {
  const family: 4 | 6 = a.family ?? 4;
  const from = deviceNamed(sim, a.from);
  if (from === undefined) return fail(`There is no device called ${a.from} in this topology.`);
  const clone = host.get();
  if (clone === undefined) return fail('This world could not be copied for a connectivity check.');
  // Devices are matched by NAME in the live world but addressed INSIDE the clone: the clone replays DHCP from t=0,
  // so an address the live world gave one host can belong to another there. Resolving the target in the clone keeps
  // the check about the device, not about a string.
  const cloneFrom = clone.device(from.id);
  if (cloneFrom === undefined) return fail(`${a.from} could not be copied for a connectivity check.`);
  let target: string;
  if (a.byName === true) {
    if (family === 6) return fail('A connectivity check by name needs IPv4; give an address for an IPv6 check.');
    target = a.to;
  } else {
    const to = deviceNamed(sim, a.to);
    if (to === undefined) return fail(`There is no device called ${a.to} in this topology.`);
    const cloneTo = clone.device(to.id);
    const address = cloneTo === undefined ? undefined : pingAddressOf(cloneTo, family);
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
  if (reachable === (a.expect === 'success')) return PASS;
  return fail(
    a.expect === 'success'
      ? `${a.from} got no reply from ${target} (${sent} echo request${sent === 1 ? '' : 's'} sent).`
      : `${a.from} reached ${target} (${received} of ${sent} replied), which this task expects to fail.`,
  );
}

// ── the grader ───────────────────────────────────────────────────────────────

function checkOne(sim: Simulation, host: CloneHost, a: LabAssertion): Check {
  try {
    switch (a.kind) {
      case 'config':
        return checkConfig(sim, a);
      case 'port':
        return checkPort(sim, a);
      case 'table':
        return checkTable(sim, a);
      case 'process':
        return checkProcess(sim, a);
      case 'link':
        return checkLink(sim, a);
      case 'counter':
        return checkCounter(sim, a);
      case 'connectivity':
        return checkConnectivity(sim, host, a);
      case 'traceSeen':
        return checkTraceSeen(sim, a);
      default:
        return fail(`"${String((a as { kind: string }).kind)}" is not a check this grader knows.`);
    }
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }
}

/**
 * Score every task of `lab` against `sim` (contracts/scenario.ts `EvaluateLab`). The live simulation's clock, trace
 * and rng are untouched; `connectivity` assertions run in a disposable clone built on first use.
 */
export const evaluateLab: EvaluateLab = (sim: Simulation, lab: ScenarioInfo): LabStatus => {
  const host = createCloneHost(sim);
  const results: LabCheckResult[] = [];
  let score = 0;
  let total = 0;
  for (const task of lab.tasks ?? []) {
    const assertions = task.assertions.map((a, index) => {
      const r = checkOne(sim, host, a);
      return r.detail === undefined ? { index, pass: r.pass } : { index, pass: r.pass, detail: r.detail };
    });
    const pass = assertions.every((r) => r.pass);
    total += task.points;
    if (pass) score += task.points;
    results.push({ task: task.id, pass, points: pass ? task.points : 0, assertions });
  }
  return { lab: lab.name, checkedAt: sim.now, score, total, results };
};
