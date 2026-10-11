/**
 * sim/lab-checks/traffic.ts — [S20] the `traffic` kind: generated flows run in the grader clone and graded from the
 * receivers' `flows` rows (ARCHITECTURE-P3 §2.10, §3.5, §3.11, D16; §7 W5 sim; ruling R44).
 *
 * `{kind: 'traffic', flows: (TrafficFlowSpec & {from, to})[], runMs, expect: {receiver, flow, maxLossPct?,
 * maxDelayMs?, maxJitterMs?}[]}`. Devices by NAME. The check runs through `CloneHost.run` (the clone memo, D5) in the
 * base clone (the kind has no `after`). Inside the clone:
 *   • every flow starts in the same instant, in the order given, with `traffic.start {flow}` to `from`'s traffic
 *     daemon — applied exactly as `icmp.ping` is (a `request` action of the sim pseudo-process). A flow's `dst` is the
 *     address it is sent to (`to`'s first IPv4 address when the spec carries none). A flow without an `id` is named
 *     by its position in `flows`, `f1` for the first (so in §2.10's example `{flows: [voice, bulk], expect: [{flow:
 *     'f1', …}]}` names the voice flow, whichever device sends the bulk one). A flow the daemon refuses (its caps, a
 *     destination it has no route to) fails the check with the daemon's own reason (`planTrafficFlow`);
 *   • ruling R44: a flow with neither `count` nor `durationMs` is continuous, and a continuous flow never lets
 *     `runToIdle` return, so the clone runs under `runFor`: `runMs` (1 … TRAFFIC_MAX_DURATION_MS) of flows, then every
 *     flow still running is stopped (`traffic.stop`) and the clone drains: it runs on in steps of LAB_TRAFFIC_STEP_NS
 *     until LAB_TRAFFIC_QUIET_NS pass in which no datagram of a flow moved (a trace event of a PDU tagged 'traffic') and
 *     no `flows` row was written — so the datagrams still queued have arrived and each receiver has written its final
 *     row (`flow-flush`, 1 s after the last datagram) — or LAB_TRAFFIC_DRAIN_NS at most. The run and the drain share
 *     LAB_TRAFFIC_MAX_EVENTS; reaching it fails the check;
 *   • every failing exit once a flow has started (a later flow refused or unable to start, the event limit of the run
 *     or of the drain, a throw) stops the started flows and drains the clone as above with a FRESH budget of
 *     LAB_TRAFFIC_MAX_EVENTS (the flows are stopped, so LAB_TRAFFIC_DRAIN_NS bounds it), so a later check of the same
 *     clone is never graded against this check's leftover traffic (W5 fix #25; W5 integration: the limit exits used to
 *     drain with the exhausted remainder of the run's budget, that is, not at all);
 *   • each expectation reads, on `receiver`, the `flows` row of each flow of the check with that id — the row whose key
 *     is that flow's sender's address and the id (`${src}|${flow}`, §2.6; so two senders' `f1` never mix) and whose
 *     `firstAt` is not before the check started its flows (a row an earlier check of the same clone left is another
 *     instance of the flow, never this one's) — and compares: loss `lost / (received + lost)` with `maxLossPct`
 *     (percent), the largest one-way delay `delayMaxNs` with `maxDelayMs`, and the RFC 3550 jitter `jitterNs` with
 *     `maxJitterMs`. A flow none of whose datagrams reached the receiver fails the expectation. Every problem found is
 *     listed in the one detail.
 * A stopped continuous flow sends no final datagram, so its `lost` counts the gaps up to the highest datagram received
 * (§2.6): datagrams dropped after it are not losses the row can see.
 *
 * A `traffic` assertion inside `connectivity.then` is refused (the registry): a follow-up check reads state.
 *
 * Nothing here touches the live world: it is read by name and every action happens in the clone.
 */
import { isIpv4 } from '../../contracts/addr.js';
import type { DeviceRuntime } from '../../contracts/device.js';
import type { DeviceId } from '../../contracts/ids.js';
import { TRAFFIC_MAX_DURATION_MS, type TrafficFlowSpec } from '../../contracts/process.js';
import type { LabAssertion } from '../../contracts/scenario.js';
import type { Simulation } from '../../contracts/simulation.js';
import type { FlowRow } from '../../contracts/tables.js';
import { MS, SEC, type SimTime } from '../../contracts/time.js';
import type { TraceEvent } from '../../contracts/trace.js';
import { planTrafficFlow } from '../../protocols/traffic.js';
import { SIM_PROCESS_NAME } from '../simulation.js';
import { PASS, canonicalJson, deviceNamed, fail, noDevice, pingAddressOf, rowsOf, type Check, type CloneEntry, type CloneHost } from './core.js';

/** @since P3 [S20] The assertion this file grades. */
export type TrafficAssertion = Extract<LabAssertion, { kind: 'traffic' }>;

/** @since P3 [S20] The longest drain after the flows stop: a full FIFO of 1500-byte frames on a 128 kb/s line drains in it. */
export const LAB_TRAFFIC_DRAIN_NS: SimTime = 30 * SEC;

/** @since P3 [S20] Quiet clone time that ends the drain early (no datagram of a flow moved, no `flows` row written). */
export const LAB_TRAFFIC_QUIET_NS: SimTime = 2 * SEC;

/** @since P3 [S20] The step in which the drain watches for quiet. */
export const LAB_TRAFFIC_STEP_NS: SimTime = 500 * MS;

/** @since P3 [S20] Events the clone may dispatch for the flows' run and their drain together. */
export const LAB_TRAFFIC_MAX_EVENTS = 2_000_000;

/** The daemon that sends and receives the flows. */
const TRAFFIC = 'traffic';

/** One flow of the check, resolved in the live world. */
interface PlannedFlow {
  readonly index: number;
  readonly id: string;
  readonly from: string;
  readonly fromId: DeviceId;
  readonly to: string;
  readonly toId: DeviceId;
  /** The spec without `from`/`to`, its id filled in. */
  readonly spec: Omit<TrafficFlowSpec, 'dst'> & { readonly dst?: string };
}

/** One expectation, resolved in the live world. */
interface PlannedExpect {
  readonly receiver: string;
  readonly receiverId: DeviceId;
  readonly flow: string;
  readonly maxLossPct?: number;
  readonly maxDelayMs?: number;
  readonly maxJitterMs?: number;
}

/** A bound is a finite number ≥ 0. */
const isBound = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;

/**
 * @since P3 [S20] Grade one `traffic` assertion (file header). `maxEvents` is the run-and-drain limit: the registry
 * always grades with LAB_TRAFFIC_MAX_EVENTS; a test passes a smaller one to reach the limit's exit cheaply (the
 * clean-up drain of a failing exit keeps its own fresh LAB_TRAFFIC_MAX_EVENTS).
 */
export function checkTraffic(sim: Simulation, host: CloneHost, a: TrafficAssertion, maxEvents: number = LAB_TRAFFIC_MAX_EVENTS): Check {
  const runMs: unknown = a.runMs;
  if (typeof runMs !== 'number' || !Number.isInteger(runMs) || runMs < 1 || runMs > TRAFFIC_MAX_DURATION_MS) {
    return fail(`A traffic check runs its flows for 1 to ${TRAFFIC_MAX_DURATION_MS} ms; ${String(runMs)} is not in that range.`);
  }
  const flowList: unknown = a.flows;
  if (!Array.isArray(flowList) || flowList.length === 0) return fail('A traffic check needs at least one flow.');
  const expectList: unknown = a.expect;
  if (!Array.isArray(expectList) || expectList.length === 0) return fail('A traffic check needs at least one expectation to grade.');
  const flows: PlannedFlow[] = [];
  for (let index = 0; index < a.flows.length; index++) {
    const f = a.flows[index] as TrafficFlowSpec & { from: string; to: string };
    const from = deviceNamed(sim, f.from);
    if (from === undefined) return noDevice(f.from);
    const to = deviceNamed(sim, f.to);
    if (to === undefined) return noDevice(f.to);
    const { from: _from, to: _to, ...rest } = f;
    const id = f.id ?? `f${index + 1}`;
    flows.push({ index, id, from: f.from, fromId: from.id, to: f.to, toId: to.id, spec: { ...rest, id } });
  }
  const expectations: PlannedExpect[] = [];
  for (const e of a.expect) {
    const receiver = deviceNamed(sim, e.receiver);
    if (receiver === undefined) return noDevice(e.receiver);
    if (!flows.some((f) => f.id === e.flow)) return fail(`This traffic check starts no flow called ${e.flow}.`);
    for (const [member, v] of [['maxLossPct', e.maxLossPct], ['maxDelayMs', e.maxDelayMs], ['maxJitterMs', e.maxJitterMs]] as const) {
      if (v !== undefined && !isBound(v)) return fail(`${member} of flow ${e.flow} must be a number of at least 0.`);
    }
    expectations.push({ ...e, receiverId: receiver.id });
  }
  return host.run([], 0, canonicalJson(a), (entry) => trafficInClone(entry, runMs, flows, expectations, maxEvents));
}

/** Every IPv4 address `dev` holds, in port order. */
function ipv4Of(dev: DeviceRuntime): string[] {
  const out: string[] = [];
  for (const p of dev.ports.values()) if (p.l3.ipv4 !== undefined) out.push(p.l3.ipv4.address);
  return out;
}

/** The sender's view of its flows (the traffic StateView `flows`: running ones, then the last finished ones). */
function senderFlows(dev: DeviceRuntime): { readonly id: string; readonly state: string; readonly startedAt: number }[] {
  const flows = dev.processes.get(TRAFFIC)?.stateSnapshot().state['flows'];
  return Array.isArray(flows) ? (flows as { id: string; state: string; startedAt: number }[]) : [];
}

/** Is flow `id` running (or starting) on `dev`? */
const running = (dev: DeviceRuntime, id: string): boolean => senderFlows(dev).some((f) => f.id === id && (f.state === 'running' || f.state === 'starting'));

/** The newest debug line of the traffic daemon on `dev` (its refusals are written there). */
const lastDebug = (dev: DeviceRuntime): unknown => dev.processes.get(TRAFFIC)?.debugEvents().at(-1);

/** Does `ev` show a datagram of a flow moving, or a receiver writing a `flows` row? */
function trafficActivity(ev: TraceEvent): boolean {
  if (ev.kind === 'tableWrite') return ev.table === 'flows';
  if (ev.kind === 'frameTx' || ev.kind === 'frameRx' || ev.kind === 'frameQueued' || ev.kind === 'drop' || ev.kind === 'pduConsumed') return ev.pdu.tag === 'traffic';
  return false;
}

/** The drain of the file header; false when it reached its share of the event limit. */
function drain(clone: Simulation, budget: number): boolean {
  let active = false;
  const stop = clone.onTrace((ev) => {
    if (!active && trafficActivity(ev)) active = true;
  });
  try {
    const end = clone.now + LAB_TRAFFIC_DRAIN_NS;
    let quietSince = clone.now;
    let left = budget;
    while (clone.now < end) {
      active = false;
      const r = clone.runFor(Math.min(LAB_TRAFFIC_STEP_NS, end - clone.now), { maxEvents: Math.max(1, left) });
      left -= r.events;
      if (r.stopped === 'maxEvents' || left <= 0) return false;
      if (active) quietSince = clone.now;
      else if (clone.now - quietSince >= LAB_TRAFFIC_QUIET_NS) break;
    }
    return true;
  } finally {
    stop();
  }
}

/** A duration in ns as milliseconds with one decimal. */
const msText = (ns: number): string => `${Math.round(ns / 100_000) / 10}`;

/** The clone side of one `traffic` check (the closure `CloneHost.run` runs, or replays). */
function trafficInClone(entry: CloneEntry, runMs: number, flows: readonly PlannedFlow[], expectations: readonly PlannedExpect[], maxEvents: number): Check {
  const clone = entry.clone;
  if (clone === undefined) return fail(entry.error ?? 'This world could not be copied for a traffic check.');
  // start every flow in this instant, in the order given
  const startedAt = clone.now;
  const started: PlannedFlow[] = [];
  /** Stop every flow of this check that still runs (the clone is shared by the later checks of the same evaluation). */
  const stopStarted = (): void => {
    for (const f of started) {
      const dev = clone.device(f.fromId);
      if (dev !== undefined && running(dev, f.id)) dev.applyActions(SIM_PROCESS_NAME, [{ type: 'request', to: TRAFFIC, req: { kind: 'traffic.stop', id: f.id } }], clone.now);
    }
  };
  /**
   * The clean-up of every failing exit once a flow has started (file header): stop the started flows and drain the
   * clone with a FRESH budget — not what the run left, which at the event limit is nothing — so no later check of the
   * same clone is graded against this check's leftover traffic.
   */
  const cleanUp = (): void => {
    if (started.length === 0) return;
    stopStarted();
    drain(clone, LAB_TRAFFIC_MAX_EVENTS);
  };
  /** A failure once a flow may have started: clean up first (W5 fix #25; a throw cleans up too, below). */
  const abandon = (detail: string): Check => {
    cleanUp();
    return fail(detail);
  };
  try {
    for (const f of flows) {
      const dev = clone.device(f.fromId);
      if (dev === undefined || !dev.processes.has(TRAFFIC)) return abandon(`${f.from} cannot generate traffic.`);
      let dst = f.spec.dst;
      if (dst === undefined || dst === '') {
        const to = clone.device(f.toId);
        dst = to === undefined ? undefined : pingAddressOf(to, 4);
        if (dst === undefined || !isIpv4(dst)) return abandon(`${f.to} has no IPv4 address for flow ${f.id} to reach.`);
      }
      const spec: TrafficFlowSpec = { ...f.spec, dst };
      const busy = new Set(senderFlows(dev).filter((x) => x.state === 'running' || x.state === 'starting').map((x) => x.id));
      const plan = planTrafficFlow(spec, busy);
      if (!plan.ok) return abandon(`${f.from} refused flow ${f.id}: ${plan.error.replace(/^% /, '')}`);
      const before = lastDebug(dev);
      dev.applyActions(SIM_PROCESS_NAME, [{ type: 'request', to: TRAFFIC, req: { kind: 'traffic.start', flow: spec } }], clone.now);
      // a started flow is on record with this instant as its start (it may already have ended: a count of 1)
      if (!senderFlows(dev).some((x) => x.id === f.id && x.startedAt === clone.now)) {
        const after = lastDebug(dev) as { message?: unknown } | undefined;
        const why = after !== before && typeof after?.message === 'string' ? `: ${after.message}` : ` to ${dst} (it is one of its own addresses, or it has no route there)`;
        return abandon(`${f.from} could not start flow ${f.id}${why}.`);
      }
      started.push(f);
    }
    // R44: the flows run under runFor, then stop; the queues drain and the receivers write their last rows
    const ran = clone.runFor(runMs * MS, { maxEvents });
    if (ran.stopped === 'maxEvents') return abandon(`The flows of this traffic check stopped at the grader's limit of ${maxEvents} events before ${runMs} ms had passed.`);
    stopStarted();
    if (!drain(clone, maxEvents - ran.events)) return abandon(`The flows of this traffic check did not drain within the grader's limit of ${maxEvents} events.`);
  } catch (e) {
    // a throw is an exit too (the registry turns it into the detail): the clean-up runs first, and an error while
    // cleaning up never hides the first one
    try {
      cleanUp();
    } catch {
      // the first error is the one reported
    }
    throw e;
  }

  const problems: string[] = [];
  for (const e of expectations) {
    const receiver = clone.device(e.receiverId);
    const rows = receiver === undefined ? [] : rowsOf<FlowRow>(receiver, 'flows');
    for (const f of started) {
      if (f.id !== e.flow) continue;
      const sender = clone.device(f.fromId);
      const sources = sender === undefined ? [] : ipv4Of(sender);
      const row = rows.find((r) => r.flow === f.id && sources.includes(r.src) && r.firstAt >= startedAt);
      if (row === undefined) {
        problems.push(`no datagram of flow ${f.id} from ${f.from} reached ${e.receiver}`);
        continue;
      }
      const total = row.received + row.lost;
      if (e.maxLossPct !== undefined && row.lost * 100 > e.maxLossPct * total) {
        problems.push(`${e.receiver} lost ${row.lost} of ${total} datagrams of flow ${f.id} from ${f.from} (${Math.round((row.lost * 1000) / total) / 10} %), more than ${e.maxLossPct} %`);
      }
      if (e.maxDelayMs !== undefined && row.delayMaxNs > e.maxDelayMs * MS) {
        problems.push(`flow ${f.id} from ${f.from} took up to ${msText(row.delayMaxNs)} ms to reach ${e.receiver}, more than ${e.maxDelayMs} ms`);
      }
      if (e.maxJitterMs !== undefined && row.jitterNs > e.maxJitterMs * MS) {
        problems.push(`flow ${f.id} from ${f.from} reached ${e.receiver} with ${msText(row.jitterNs)} ms of jitter, more than ${e.maxJitterMs} ms`);
      }
    }
  }
  if (problems.length === 0) return PASS;
  const text = problems.join('; ');
  return fail(`${text.charAt(0).toUpperCase()}${text.slice(1)}.`);
}
