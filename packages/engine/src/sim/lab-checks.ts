/**
 * sim/lab-checks.ts — the lab grader (ARCHITECTURE-P1 §4.13; ARCHITECTURE-P2 §2.10, §3.8 step 7, §11.2;
 * ARCHITECTURE-P3 D5, §2.10; contracts/scenario.ts `EvaluateLab`, `LabAssertion`).
 *
 * `evaluateLab(sim, lab)` scores every task of a `ScenarioInfo` against STRUCTURED state — never scraped console
 * text. One task passes when every one of its assertions passes; a task that passes earns its points, a task that
 * fails earns none.
 *
 * P3 (D5, §7 W1 sim): the grader is a registry. This file keeps `evaluateLab` and the clone host; each assertion is
 * graded by `runCheck` (sim/lab-checks/registry.ts), whose CHECKERS map every kind to its checker: the P1 kinds and
 * `connectivity` in sim/lab-checks/core.ts, the P2 switching kinds in switching.ts, the P2 routing, NAT and standby
 * kinds in routing.ts (all moved verbatim, proved by `accept.p3.lab-status`), the data-driven `neighbor` and `fact`
 * kinds and the identities in facts.ts, and the P3 area adapters (sim/lab-checks/<area>.ts, W3). Each file documents
 * its kinds. A failing assertion that carries `feedback` shows it after its detail (the envelope, registry.ts).
 *
 * The live simulation is never disturbed: nothing here advances its clock, emits trace or draws its rng. Reads are
 * plain property reads, pure readers and `traceQuery` (which only pages the ring).
 *
 * Scheduled faults (P2 §11.2, W5 fix). While a fault of `lab.faults` is still ahead of the live clock (`at > now`: the
 * worker's activation check at t = 0, an automatic check in the minute before a hidden change lands, a time-machine
 * seek back before it), the world is the healthy one the faults are about to break, and grading it would award marks
 * nobody earned. Every task then fails with the one detail LAB_PREPARING_DETAIL (on its first assertion; the others
 * fail without a detail, so a panel lists the reason once), and nothing is read or cloned.
 *
 * Connectivity clones. A clone is `createSimulation({seed: sim.seed, catalog: sim.catalog})` +
 * `loadTopology(sim.exportTopology())` with the live world's RUNTIME L1 state re-applied as faults at t = 0 — every
 * cut cable (`cable-cut`) and every err-disabled port (`err-disable` with the live cause, §3.8 step 7) — then settled
 * with `runToIdle`, which waits for boots, forward delay, TC windows, LACP and HSRP elections (§4.2). A port that
 * does not exist at t = 0 (a virtual port the boot creates) is err-disabled right after that first settle, and the
 * clone settles again. The clone takes the live world's catalog, so a world built on a test catalog is copied
 * faithfully; its journal is off (a clone is never replayed).
 *   • ONE clone per distinct `connectivity.after` fault set: the assertions without `after` share the base clone; an
 *     `after` set (faults resolved by name in the live world to link / device / port ids, deduplicated and sorted,
 *     with its `settleMs`) gets its own clone: settled, the faults applied at the settled instant (a `shutdown` as
 *     the `shutdown` line through the device's config path; a cut and a power-off as `cable-cut` / `power-loss`
 *     faults), then run for `settleMs` (default 60 000 ms) before the ping. `settleMs` only applies with faults.
 *
 * ponytail: clones are built lazily and kept for the whole `evaluateLab` call (a lab rarely has more than two fault
 * sets). `ScenarioInfo.customChecks` is not run here: no LabTask references one and LabStatus has nowhere to report it.
 */
import type { FaultSpec } from '../contracts/events.js';
import type { DeviceId, PortId } from '../contracts/ids.js';
import type { EvaluateLab, LabCheckResult, LabStatus, ScenarioInfo } from '../contracts/scenario.js';
import type { Simulation } from '../contracts/simulation.js';
import type { SimTime } from '../contracts/time.js';
import type { Topology } from '../contracts/topology.js';
import {
  LAB_AFTER_SETTLE_EVENTS,
  LAB_CLONE_BOOT_EVENTS,
  faultKey,
  pingAddressOf,
  type CloneEntry,
  type CloneHost,
  type ResolvedFault,
} from './lab-checks/core.js';
import { runCheck } from './lab-checks/registry.js';
import { SIM_PROCESS_NAME, createSimulation } from './simulation.js';

export {
  LAB_AFTER_SETTLE_EVENTS,
  LAB_AFTER_SETTLE_MS,
  LAB_CLONE_BOOT_EVENTS,
  LAB_PING_COUNT,
  LAB_PING_MAX_EVENTS,
  LAB_PING_SETTLE_NS,
  LAB_PING_SIZE_BYTES,
  LAB_PING_TIMEOUT_MS,
} from './lab-checks/core.js';

/** @since P2 The detail of every task while a scheduled fault of the lab has not landed yet (file header). */
export const LAB_PREPARING_DETAIL = 'This lab is still being prepared; check again in a moment.';

// ── the clone host ───────────────────────────────────────────────────────────

/** Every live port with an err-disable cause: [device, port, cause], in device then port order. */
function errDisabledPorts(sim: Simulation): [DeviceId, PortId, string][] {
  const out: [DeviceId, PortId, string][] = [];
  for (const d of sim.devices()) for (const p of d.ports.values()) if (p.errDisabled !== undefined) out.push([d.id, p.id, p.errDisabled]);
  return out;
}

/** An `err-disable` fault for the clone (§3.8 step 7). */
function errDisableFault(device: DeviceId, port: PortId, cause: string): FaultSpec {
  return { id: `lab-clone-errdisable:${device}:${port}`, kind: 'err-disable', target: { device, port }, params: { cause } };
}

/**
 * A settled copy of `sim` (file header): the export loaded with the live seed and catalog, the live cut cables and
 * err-disabled ports re-applied at t = 0, run to idle; a port the boot created is err-disabled after that settle.
 */
function settledClone(sim: Simulation, topo: Topology): Simulation {
  const fresh = createSimulation({ seed: sim.seed, catalog: sim.catalog, journal: false });
  fresh.loadTopology(topo);
  // A cut cable is runtime state that TopologyLink cannot carry, so the copy would silently repair it and grade a
  // broken world as reachable. Re-cut those links before the clone settles.
  for (const l of topo.links) {
    if (sim.link(l.id)?.downReason === 'cut') {
      fresh.injectFault(0, { id: `lab-clone-cut:${l.id}`, kind: 'cable-cut', target: { link: l.id } });
    }
  }
  // An err-disabled port is runtime state too (P2 §3.8 step 7): re-apply it the same way, with the live cause.
  const disabled = errDisabledPorts(sim);
  for (const [device, port, cause] of disabled) fresh.injectFault(0, errDisableFault(device, port, cause));
  fresh.runToIdle(LAB_CLONE_BOOT_EVENTS);
  // A port that did not exist at t = 0 (a virtual port the boot creates) is err-disabled now, and the clone settles.
  const late = disabled.filter(([device, port]) => {
    const p = fresh.device(device)?.port(port);
    return p !== undefined && p.errDisabled === undefined;
  });
  if (late.length > 0) {
    for (const [device, port, cause] of late) fresh.injectFault(fresh.now, errDisableFault(device, port, cause));
    fresh.runToIdle(LAB_CLONE_BOOT_EVENTS);
  }
  return fresh;
}

/** Each device's ping address per family (fault clones record it just before their faults). */
function pingAddresses(clone: Simulation): Map<DeviceId, Partial<Record<4 | 6, string>>> {
  const out = new Map<DeviceId, Partial<Record<4 | 6, string>>>();
  for (const d of clone.devices()) {
    const v4 = pingAddressOf(d, 4);
    const v6 = pingAddressOf(d, 6);
    out.set(d.id, { ...(v4 === undefined ? {} : { 4: v4 }), ...(v6 === undefined ? {} : { 6: v6 }) });
  }
  return out;
}

/**
 * Apply `faults` to the settled `clone` at its current instant: shutdowns at once through the device's config path
 * (the `shutdown` line, as typed), cuts and power-offs as `cable-cut` / `power-loss` faults dispatched by the settle
 * run that follows. Returns why a shutdown was refused, if one was.
 */
function applyFaults(clone: Simulation, faults: readonly ResolvedFault[]): string | undefined {
  for (const f of faults) {
    switch (f.kind) {
      case 'cut':
        clone.injectFault(clone.now, { id: `lab-after-cut:${f.link}`, kind: 'cable-cut', target: { link: f.link } });
        break;
      case 'power':
        clone.injectFault(clone.now, { id: `lab-after-power:${f.device}`, kind: 'power-loss', target: { device: f.device } });
        break;
      case 'shutdown': {
        const dev = clone.device(f.device);
        if (dev === undefined || !dev.power || dev.bootedAt === undefined) break;
        dev.applyActions(SIM_PROCESS_NAME, [], clone.now);
        const r = dev.applyConfigLine([['interface', f.port]], ['shutdown'], false);
        if (!r.ok) return `${dev.spec.name} refused to shut ${f.port}${r.error === undefined ? '' : `: ${r.error}`}.`;
        break;
      }
    }
  }
  return undefined;
}

function createCloneHost(sim: Simulation): CloneHost {
  const entries = new Map<string, CloneEntry>();
  let topo: Topology | undefined;
  let sessions = 0;

  function build(faults: readonly ResolvedFault[], settleNs: SimTime): CloneEntry {
    try {
      topo ??= sim.exportTopology();
      const clone = settledClone(sim, topo);
      if (faults.length === 0) return { clone };
      const before = pingAddresses(clone);
      const refused = applyFaults(clone, faults);
      if (refused !== undefined) return { error: refused };
      clone.runFor(settleNs, { maxEvents: LAB_AFTER_SETTLE_EVENTS });
      return { clone, before };
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) };
    }
  }

  return {
    get(faults: readonly ResolvedFault[], settleNs: SimTime): CloneEntry {
      const key = faults.length === 0 ? '' : `${faults.map(faultKey).join(',')}@${settleNs}`;
      let entry = entries.get(key);
      if (entry === undefined) {
        entry = build(faults, settleNs);
        entries.set(key, entry);
      }
      return entry;
    },
    nextSession(): string {
      sessions++;
      return `lab-check:${sessions}`;
    },
  };
}

// ── the grader ───────────────────────────────────────────────────────────────

/**
 * Score every task of `lab` against `sim` (contracts/scenario.ts `EvaluateLab`). The live simulation's clock, trace
 * and rng are untouched; `connectivity` assertions run in disposable clones built on first use (one per fault set).
 */
export const evaluateLab: EvaluateLab = (sim: Simulation, lab: ScenarioInfo): LabStatus => {
  const host = createCloneHost(sim);
  const results: LabCheckResult[] = [];
  let score = 0;
  let total = 0;
  const preparing = (lab.faults ?? []).some((f) => f.at > sim.now);
  for (const task of lab.tasks ?? []) {
    if (preparing) {
      total += task.points;
      const assertions = task.assertions.map((_, index) => (index === 0 ? { index, pass: false, detail: LAB_PREPARING_DETAIL } : { index, pass: false }));
      results.push({ task: task.id, pass: false, points: 0, assertions });
      continue;
    }
    const assertions = task.assertions.map((a, index) => {
      const r = runCheck({ sim, host }, a);
      return r.detail === undefined ? { index, pass: r.pass } : { index, pass: r.pass, detail: r.detail };
    });
    const pass = assertions.every((r) => r.pass);
    total += task.points;
    if (pass) score += task.points;
    results.push({ task: task.id, pass, points: pass ? task.points : 0, assertions });
  }
  return { lab: lab.name, checkedAt: sim.now, score, total, results };
};
