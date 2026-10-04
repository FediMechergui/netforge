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
 * P3 (ruling R18, W2 sim): a failed task's `LabCheckResult.misconception` is the analytics tag of its first failing
 * assertion that carries one (`misconceptionOf`); a passing task, and every task of a P1/P2 lab (no notes), has none.
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
 *   • P3 (§2.10, §7 W3 sim): a `config` fault runs its lines through the clone's `configure` (the CLI core's headless
 *     session at privilege 15, from global configuration, with pasted-configuration semantics: LAB_CONFIG_FAULT_OPTIONS;
 *     never journaled, the clone's journal is off) after the P2
 *     faults of its set, in the author's order; a refused line makes the clone an error whose detail names the line
 *     and the device's refusal. A `cut` with `aPort` / `bPort` cuts only that cable (resolved in core.ts). Fault clones
 *     also record every port's addresses just before the faults (`toIface`, `toAddress`).
 *
 * The clone memo (P3, D5, §7 W3 sim). Clone results are memoised by the canonical hash of the clone input — the
 * exported topology plus the runtime L1 state above, in canonical JSON (`canonicalJson`, sorted keys), hashed with
 * FNV-1a 64 and its length — so routine re-checks never rebuild clones. The memo belongs to the live world (a WeakMap
 * keyed by the Simulation, dropped with it; at most LAB_CLONE_MEMO_INPUTS inputs, the least recently used dropped
 * first). For each input it records, per clone (fault set), the checks run in it in order: their memo key (the
 * assertion's canonical JSON) and verdict. A check is answered from the memo only when its input, its clone, its
 * position in that clone and its key all match: nothing is built. The first check of a clone that does not match
 * builds the clone, replays on it this call's earlier checks of that clone (answered from the memo, so the clone
 * reaches the state they left), runs live, and replaces the recorded tail. Since a clone is a deterministic function
 * of its input (P2 guarantees) and each check sees exactly the clone its predecessors left — probe sessions are
 * numbered per clone, `lab-check:<n>` — a memoised verdict is the verdict a fresh evaluation gives, so the memo
 * changes no LabStatus. `labCloneMemoStats(sim)` reports the builds and hits (tests).
 *
 * ponytail: clones are built lazily and kept for the whole `evaluateLab` call (a lab rarely has more than two fault
 * sets). `ScenarioInfo.customChecks` is not run here: no LabTask references one and LabStatus has nowhere to report it.
 */
import type { ConfigureOptions } from '../contracts/cli.js';
import type { FaultSpec } from '../contracts/events.js';
import type { DeviceId, PortId } from '../contracts/ids.js';
import type { EvaluateLab, LabAssertion, LabCheckResult, LabStatus, ScenarioInfo } from '../contracts/scenario.js';
import type { Simulation } from '../contracts/simulation.js';
import type { SimTime } from '../contracts/time.js';
import type { Topology } from '../contracts/topology.js';
import {
  LAB_AFTER_SETTLE_EVENTS,
  LAB_CLONE_BOOT_EVENTS,
  canonicalJson,
  faultKey,
  pingAddressOf,
  portAddressMap,
  type Check,
  type CloneCheck,
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
  LAB_FLOOD_DROP_REASONS,
  LAB_PROBE_TIMEOUT_MS,
} from './lab-checks/core.js';

/**
 * @since P3 How a `config` fault's lines run in the clone (§2.10): pasted-configuration semantics (a line's leading
 * spaces select its context level, as in a startup configuration), stopping at the first refused line.
 */
export const LAB_CONFIG_FAULT_OPTIONS: Readonly<ConfigureOptions> = Object.freeze({ indentation: true });

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
 * run that follows. Returns why a shutdown was refused, if one was. P3: configuration faults (last, in the author's
 * order) at once through `configure`; returns why a line was refused, if one was.
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
      case 'config': {
        // P3 (§2.10): the lines through the clone's configure — the CLI core's headless session, from global config,
        // with pasted-configuration semantics (leading spaces select the context, as in a startup configuration)
        const name = clone.device(f.device)?.spec.name ?? f.device;
        const r = clone.configure(f.device, f.lines, LAB_CONFIG_FAULT_OPTIONS);
        if (!r.ok) {
          const bad = r.lines.find((l) => !l.ok && l.skipped !== true);
          const why = bad?.error === undefined ? '' : `: ${bad.error.message}`;
          return `${name} refused the configuration fault line "${bad?.line ?? ''}"${why}.`;
        }
        break;
      }
    }
  }
  return undefined;
}

// ── P3: the clone memo (D5, §7 W3 sim) ────────────────────────────────────────

/** @since P3 Clone inputs whose recorded runs the memo of one live world keeps (the most recently used are kept). */
export const LAB_CLONE_MEMO_INPUTS = 4;

/** @since P3 One recorded check of a clone: its memo key and its verdict. */
interface MemoRecord {
  readonly key: string;
  readonly result: Check;
}

/** @since P3 The clone memo of one live world: per clone-input hash, per clone (fault-set key), the checks run in order. */
interface CloneMemo {
  readonly inputs: Map<string, Map<string, MemoRecord[]>>;
  builds: number;
  hits: number;
}

/** @since P3 The memo of every live world graded so far (dropped with the world). It never changes a verdict (file header). */
const CLONE_MEMOS = new WeakMap<Simulation, CloneMemo>();

function memoOf(sim: Simulation): CloneMemo {
  let m = CLONE_MEMOS.get(sim);
  if (m === undefined) {
    m = { inputs: new Map(), builds: 0, hits: 0 };
    CLONE_MEMOS.set(sim, m);
  }
  return m;
}

/** @since P3 What the clone memo of one live world has done (tests and tooling). */
export interface LabCloneMemoStats {
  /** Clones built. */
  readonly builds: number;
  /** Checks answered from the memo. */
  readonly hits: number;
  /** Clone inputs currently remembered (at most LAB_CLONE_MEMO_INPUTS). */
  readonly inputs: number;
}

/** @since P3 The clone memo's counters for the live world `sim` (zeros before its first clone check). */
export function labCloneMemoStats(sim: Simulation): LabCloneMemoStats {
  const m = CLONE_MEMOS.get(sim);
  return m === undefined ? { builds: 0, hits: 0, inputs: 0 } : { builds: m.builds, hits: m.hits, inputs: m.inputs.size };
}

/** @since P3 FNV-1a 64 over the UTF-16 code units of `text` (low byte, then high byte), as 16 hex digits; integer maths. */
function fnv1a64Text(text: string): string {
  // offset basis 0xcbf29ce484222325, prime 0x100000001b3 = 2^40 + 0x1b3, kept as two 32-bit halves
  let hi = 0xcbf29ce4;
  let lo = 0x84222325;
  const mix = (byte: number): void => {
    lo = (lo ^ byte) >>> 0;
    const low = lo * 0x1b3; // < 2^41: exact
    const carry = Math.floor(low / 0x100000000);
    hi = (Math.imul(hi, 0x1b3) + carry + (lo << 8)) >>> 0;
    lo = low >>> 0;
  };
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    mix(c & 0xff);
    mix(c >>> 8);
  }
  return hi.toString(16).padStart(8, '0') + lo.toString(16).padStart(8, '0');
}

/**
 * @since P3 The canonical hash of the clone input (D5): the exported topology plus the runtime L1 state a clone
 * re-applies (the cut cables, the err-disabled ports with their causes), in canonical JSON. The seed travels in the
 * export; the catalog is the live world's own (the memo is kept per live world).
 */
function cloneInputHash(sim: Simulation, topo: Topology): string {
  const cut = topo.links.filter((l) => sim.link(l.id)?.downReason === 'cut').map((l) => l.id);
  const text = canonicalJson({ topology: topo, cut, errDisabled: errDisabledPorts(sim) });
  return `${fnv1a64Text(text)}:${text.length}`;
}

/** @since P3 Per call, per clone: the clone once built, the checks routed to it so far, the memo hits not replayed yet. */
interface CallClone {
  entry?: CloneEntry;
  /** Checks of this call routed to this clone so far (the position of the next one). */
  pos: number;
  /** Probe sessions handed out in this clone (`lab-check:<n>`). */
  sessions: number;
  /** This call's memo hits on this clone, in order, replayed if a later check of it misses. */
  pending: CloneCheck[];
}

/** A check result as a fresh plain object (the memo never shares one with a caller). */
function copyCheck(r: Check): Check {
  return r.detail === undefined ? { pass: r.pass } : { pass: r.pass, detail: r.detail };
}

/**
 * The clone host of one `evaluateLab` call (file header). P3 (D5): `run` answers a check from the live world's memo when
 * the clone input hash, the clone (its fault set), the check's position in it and its key all match a recorded run;
 * otherwise it builds the clone (once per call), first replays this call's memo hits on it (so the clone is exactly in
 * the state its earlier checks left it), then runs the check and records it in place of what followed. A recorded
 * verdict therefore equals what a fresh evaluation gives: a clone is a deterministic function of its input, and each
 * check of a clone sees the clone its predecessors left.
 */
function createCloneHost(sim: Simulation): CloneHost {
  const memo = memoOf(sim);
  const clones = new Map<string, CallClone>();
  let topo: Topology | undefined;
  let records: Map<string, MemoRecord[]> | undefined;

  /** This input's recorded runs (the export and its hash are taken once per call, at the first clone check). */
  function recorded(): { topo: Topology; seq: Map<string, MemoRecord[]> } {
    if (topo !== undefined && records !== undefined) return { topo, seq: records };
    const t = sim.exportTopology();
    const hash = cloneInputHash(sim, t);
    const known = memo.inputs.get(hash);
    if (known !== undefined) memo.inputs.delete(hash); // most recently used last
    const r = known ?? new Map<string, MemoRecord[]>();
    memo.inputs.set(hash, r);
    for (const oldest of [...memo.inputs.keys()]) {
      if (memo.inputs.size <= LAB_CLONE_MEMO_INPUTS) break;
      memo.inputs.delete(oldest);
    }
    topo = t;
    records = r;
    return { topo: t, seq: r };
  }

  function build(t: Topology, faults: readonly ResolvedFault[], settleNs: SimTime): CloneEntry {
    memo.builds++;
    try {
      const clone = settledClone(sim, t);
      if (faults.length === 0) return { clone };
      const before = pingAddresses(clone);
      const beforePorts = portAddressMap(clone);
      const refused = applyFaults(clone, faults);
      if (refused !== undefined) return { error: refused };
      clone.runFor(settleNs, { maxEvents: LAB_AFTER_SETTLE_EVENTS });
      return { clone, before, beforePorts };
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) };
    }
  }

  const sessionOf =
    (cc: CallClone) =>
    (): string => {
      cc.sessions++;
      return `lab-check:${cc.sessions}`;
    };

  return {
    run(faults: readonly ResolvedFault[], settleNs: SimTime, key: string, check: CloneCheck): Check {
      let input: { topo: Topology; seq: Map<string, MemoRecord[]> };
      try {
        input = recorded();
      } catch (e) {
        return { pass: false, detail: e instanceof Error ? e.message : String(e) };
      }
      const seq = input.seq;
      const cloneKey = faults.length === 0 ? '' : `${JSON.stringify(faults.map(faultKey))}@${settleNs}`;
      let cc = clones.get(cloneKey);
      if (cc === undefined) {
        cc = { pos: 0, sessions: 0, pending: [] };
        clones.set(cloneKey, cc);
      }
      const n = cc.pos++;
      let entry = cc.entry;
      if (entry === undefined) {
        const rec = seq.get(cloneKey)?.[n];
        if (rec !== undefined && rec.key === key) {
          memo.hits++;
          cc.pending.push(check);
          return copyCheck(rec.result);
        }
        // a miss: build the clone, bring it to where this call's earlier checks of it left it, then run live
        entry = build(input.topo, faults, settleNs);
        cc.entry = entry;
        const replaySession = sessionOf(cc);
        for (const replay of cc.pending) replay(entry, replaySession);
        cc.pending = [];
        seq.set(cloneKey, (seq.get(cloneKey) ?? []).slice(0, n));
      }
      const result = check(entry, sessionOf(cc));
      const list = seq.get(cloneKey) ?? [];
      list[n] = { key, result: copyCheck(result) };
      seq.set(cloneKey, list);
      return result;
    },
  };
}

// ── the grader ───────────────────────────────────────────────────────────────

/**
 * @since P3 (ruling R18) The envelope's analytics tag of a failed task: the trimmed `misconception` of its first failing
 * assertion that carries a non-empty one, else undefined.
 */
export function misconceptionOf(assertions: readonly LabAssertion[], results: readonly { readonly pass: boolean }[]): string | undefined {
  for (let i = 0; i < assertions.length; i++) {
    if (results[i]?.pass !== false) continue;
    const tag = assertions[i]?.misconception?.trim();
    if (tag !== undefined && tag !== '') return tag;
  }
  return undefined;
}

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
    const result: LabCheckResult = { task: task.id, pass, points: pass ? task.points : 0, assertions };
    // P3 (R18): the analytics tag of the first failing assertion that carries one (never on a passing task)
    const misconception = pass ? undefined : misconceptionOf(task.assertions, assertions);
    if (misconception !== undefined) result.misconception = misconception;
    results.push(result);
  }
  return { lab: lab.name, checkedAt: sim.now, score, total, results };
};
