/**
 * Scenario templates and the CCNA1 lab catalogue (spec §12.1, §12.2 subset, §12.4 subset; ARCHITECTURE-P1 §4.13, §7).
 *
 * `ScenarioInfo` moved here from sim/scenarios.ts so the worker and the UI share one type
 * (`EngineApi.listScenarios` returns `ScenarioMeta[]`). Assertions evaluate engine-side against
 * STRUCTURED state (config AST paths, port state, tables, process StateViews, trace), never scraped text.
 * `connectivity` runs in a disposable clone (`createSimulation({seed}) + loadTopology(exportTopology())`) so
 * grading never perturbs the student's run.
 */
import type { FaultSpec } from './events.js';
import type { ProcessName } from './ids.js';
import type { MediaType } from './link.js';
import type { PortCounters, SwitchportMode } from './port.js';
import type { Simulation, TraceFilter } from './simulation.js';
import type { HsrpRow, PortSecurityRow, StpRole, StpState, TableName } from './tables.js';
import type { SimTime } from './time.js';
import type { Topology } from './topology.js';

/** 'ccna2-lab' @since P2 (profile P2 labs, ARCHITECTURE-P2 §11.2). */
export type ScenarioCategory = 'template' | 'ccna1-lab' | 'ccna2-lab' | (string & {});
/** §12.1 subset shipped in P1. */
export type LabType = 'guided' | 'build' | 'troubleshoot' | 'concept';

/** Structured-clone-safe metadata listed by EngineApi.listScenarios. */
export interface ScenarioMeta {
  /** Stable kebab-case id ('two-pcs-and-switch', 'ccna1-dhcpv4-server'). */
  name: string;
  title: string;
  description: string;
  category: ScenarioCategory;
  labType?: LabType;
  course?: string;
  /** Topic cluster from spec §2.1 ('Application layer'). */
  topic?: string;
  /** Paraphrased objectives (never copied from official blueprints, §1.6). */
  objectives?: readonly string[];
  tags?: readonly string[];
  difficulty?: 1 | 2 | 3;
  estimatedMinutes?: number;
  /** Catalog types the lab needs; unmet → listed as unavailable with the missing types. */
  requires?: readonly string[];
  /** @since P1 Set by the worker's listScenarios: catalog types from `requires` that this build lacks. Absent = available; loadScenario rejects with an original message when non-empty. */
  missingTypes?: readonly string[];
  /** Markdown subset (headings, lists, emphasis, code, links `concept:subnetting` / `concept:ipv6` / https). No raw HTML. */
  instructions?: string;
  /** Simulation seed the lab resets to. */
  seed?: number;
  /** Opens this concept view with the lab. */
  concept?: 'subnetting' | 'ipv6';
  version?: number;
  tasks?: readonly LabTaskMeta[];
}

export interface LabTaskMeta {
  id: string;
  title: string;
  description: string;
  points: number;
  hint?: string;
  dependsOn?: readonly string[];
}

/**
 * @since P2 A fault the grader applies inside its clone (`connectivity.after`). Devices and ports by NAME; port names
 * resolve like the 'port' kind.
 */
export type LabFault =
  | { cut: { a: string; b: string } }
  | { powerOff: string }
  | { shutdown: { device: string; port: string } };

/** Devices are referenced by topology NAME (stable in lab builds). */
export type LabAssertion =
  | { kind: 'config'; device: string; path: string; equals?: string | readonly string[]; exists?: boolean; contains?: string }
  /** `field` 'errDisabled' @since P2 (the cause string, e.g. 'psecure-violation'). */
  | { kind: 'port'; device: string; port: string; field: 'operUp' | 'adminUp' | 'ipv4' | 'ipv6' | 'duplex' | 'speedBps' | 'role' | 'errDisabled'; equals: string | number | boolean }
  | { kind: 'table'; device: string; table: TableName; where: Readonly<Record<string, string | number | boolean>>; exists: boolean }
  /**
   * A dotted path into `Process.stateSnapshot().state`. An array step is an index (`pages.0.path`) or a
   * `field=value` selector (`clients.iface=Wlan0.state`) matching the first element whose `field` compares equal as
   * text — prefer the selector when list order depends on what the student did. The value may not contain a dot.
   */
  | { kind: 'process'; device: string; process: ProcessName; path: string; equals: string | number | boolean }
  | { kind: 'link'; a: string; b: string; media?: MediaType; up?: boolean }
  | { kind: 'counter'; device: string; port: string; counter: keyof PortCounters; op: 'gt' | 'eq' | 'lt'; value: number }
  /**
   * Evaluated in a disposable clone with the lab seed; reads the icmpv4/icmpv6 job StateView counts.
   * @since P2 (all three optional by meaning) `after`: faults applied in the clone once it has settled, then the clone
   * runs `settleMs` (default 60 000) before the ping; `then`: static assertions evaluated in the same clone after the
   * ping (for example the NAT rows the ping created). One clone per distinct `after` set.
   */
  | {
      kind: 'connectivity';
      from: string;
      to: string;
      family?: 4 | 6;
      byName?: boolean;
      expect: 'success' | 'fail';
      timeoutMs?: number;
      after?: readonly LabFault[];
      settleMs?: number;
      then?: readonly LabAssertion[];
    }
  /** Something was observed in the retained trace. */
  | { kind: 'traceSeen'; filter: TraceFilter; min?: number }
  // ── P2 (ARCHITECTURE-P2 §2.10; devices and ports by NAME; port names resolve like the 'port' kind) ──
  /** @since P2 A VLAN exists (or not), with a name and access ports. */
  | { kind: 'vlan'; device: string; vlan: number; exists?: boolean; name?: string; accessPorts?: readonly string[]; match?: 'includes' | 'exactly' }
  /** @since P2 A switchport's operation and configuration; `allowedVlans` is set equality with the ACTIVE list. */
  | {
      kind: 'switchport';
      device: string;
      port: string;
      oper?: 'access' | 'trunk' | 'down';
      mode?: SwitchportMode;
      accessVlan?: number;
      voiceVlan?: number;
      nativeVlan?: number;
      allowedVlans?: readonly number[];
    }
  /** @since P2 Spanning tree of one VLAN: the root (by device name), and optionally one port's role, state and edge flag. */
  | {
      kind: 'stp';
      device: string;
      vlan: number;
      root?: boolean;
      rootBridge?: string;
      port?: string;
      role?: StpRole;
      state?: StpState;
      edge?: boolean;
      mode?: 'pvst' | 'rapid-pvst';
    }
  /** @since P2 A channel group: protocol, whether the bundle is up, and its bundled members. */
  | { kind: 'etherchannel'; device: string; group: number; protocol?: 'lacp' | 'pagp' | 'static'; up?: boolean; bundled?: readonly string[]; minBundled?: number }
  /** @since P2 Port security of one port. */
  | {
      kind: 'portSecurity';
      device: string;
      port: string;
      enabled?: boolean;
      status?: PortSecurityRow['status'];
      violation?: 'protect' | 'restrict' | 'shutdown';
      max?: number;
      stickyMac?: string;
      minViolations?: number;
    }
  /** @since P2 The longest-prefix winner for `destination` (an address), or `none`. */
  | {
      kind: 'route';
      device: string;
      family?: 4 | 6;
      destination: string;
      source?: string;
      network?: string;
      nextHop?: string;
      iface?: string;
      ad?: number;
      none?: boolean;
    }
  /** @since P2 A NAT translation row (or the count of matching rows). */
  | {
      kind: 'nat';
      device: string;
      insideLocal?: string;
      insideGlobal?: string;
      outsideGlobal?: string;
      proto?: 'icmp' | 'tcp' | 'udp';
      kindOf?: 'static' | 'dynamic' | 'overload';
      exists?: boolean;
      minCount?: number;
    }
  /** @since P2 [SHOULD S2] A standby group. */
  | { kind: 'fhrp'; device: string; iface: string; group: number; state?: HsrpRow['state']; virtualIp?: string; priority?: number; preempt?: boolean };

export interface LabTask extends LabTaskMeta {
  assertions: readonly LabAssertion[];
  feedbackOnFail?: string;
}

export interface LabCheckResult {
  task: string;
  pass: boolean;
  points: number;
  assertions: { index: number; pass: boolean; detail?: string }[];
}

export interface LabStatus {
  lab: string;
  checkedAt: SimTime;
  score: number;
  total: number;
  results: LabCheckResult[];
}

/** Engine-side entry (not structured-clone safe: has `build`). */
export interface ScenarioInfo extends ScenarioMeta {
  build(): Topology;
  tasks?: readonly LabTask[];
  /** Scheduled (usually hidden) faults applied after load. */
  faults?: readonly { at: SimTime; fault: FaultSpec }[];
  /** Reference solution: per device name, commands for `Simulation.configure` (labs.solutions test). */
  solution?: Readonly<Record<string, readonly string[]>>;
  /** Deterministic escape hatch for checks the declarative assertions cannot express. */
  customChecks?: readonly { id: string; evaluate(sim: Simulation): { pass: boolean; detail?: string } }[];
}

/**
 * @since P1 Implemented in sim/lab-checks.ts; called by the worker. Must not advance the live sim's time, emit
 * trace or draw its rng (connectivity uses a disposable clone).
 */
export type EvaluateLab = (sim: Simulation, lab: ScenarioInfo) => LabStatus;

/** Strip engine-only members (build, faults, solution, customChecks, assertions) for the UI. */
export function scenarioMeta(s: ScenarioInfo): ScenarioMeta {
  const { build: _build, faults: _faults, solution: _solution, customChecks: _checks, tasks, ...meta } = s;
  if (tasks === undefined) return meta;
  return { ...meta, tasks: tasks.map(({ assertions: _assertions, feedbackOnFail: _feedback, ...t }) => t) };
}
