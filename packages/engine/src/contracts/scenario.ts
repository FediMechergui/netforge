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
import type { DropReason, MediaType } from './link.js';
import type { TrafficFlowSpec } from './process.js';
import type { PortCounters, SwitchportMode } from './port.js';
import type { Simulation, TraceFilter } from './simulation.js';
import type { HsrpRow, PortSecurityRow, StpRole, StpState, TableName } from './tables.js';
import type { SimTime } from './time.js';
import type { Topology } from './topology.js';

/** 'ccna2-lab' @since P2 (profile P2 labs, ARCHITECTURE-P2 §11.2). 'ccna3-lab' @since P3 (profile P3 labs, ARCHITECTURE-P3 §11.2). */
export type ScenarioCategory = 'template' | 'ccna1-lab' | 'ccna2-lab' | 'ccna3-lab' | (string & {});

/**
 * @since P3 One list of concept tools (ARCHITECTURE-P3 D24): replaces the three copies of the union (this file's
 * `ScenarioMeta.concept`, the web store's `ConceptTool` and the markdown link allowlist). 'queueing' and
 * 'data-formats' are M13 / lesson 37's; 'wildcard' is [S9]'s (approved). ([S22] 'wan', [S28] 'yang' and [C26] 'sdn'
 * are not approved.)
 */
export type ConceptToolId = 'subnetting' | 'ipv6' | 'queueing' | 'data-formats' | 'wildcard';
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
  /** Opens this concept view with the lab. The union is ConceptToolId @since P3 (D24). */
  concept?: ConceptToolId;
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
  /**
   * `aPort`, `bPort` @since P3 (optional by meaning): cut only the cable on that port of `a` (or `b`); absent = every
   * cable between the two devices (P2).
   */
  | { cut: { a: string; b: string; aPort?: string; bPort?: string } }
  | { powerOff: string }
  | { shutdown: { device: string; port: string } }
  /** @since P3 A configuration fault: `lines` applied to `device` through `configure` in the clone. */
  | { config: { device: string; lines: readonly string[] } };

/** @since P3 (optional by meaning) On every assertion (spec §12.4): shown when the assertion fails. */
export interface LabAssertionNotes {
  feedback?: string;
  misconception?: string;
}

/**
 * @since P3 The protocols whose neighbour rows `neighbor` reads: 'ospf' (ospf-neighbors; state words 'full', '2way' …),
 * 'cdp' and 'lldp' (their neighbour tables), [S19] 'ppp' (the `ppp` rows; the state word is the LCP state, 'opened') and
 * [C1] 'eigrp' (eigrp-neighbors; 'up'). ([S6] 'ospfv3' is not approved.)
 */
export type NeighborProtocol = 'ospf' | 'cdp' | 'lldp' | 'ppp' | 'eigrp';

/**
 * @since P3 Facts are data: each name has a declared type, a reader (FACT_READERS, sim/lab-checks/facts.ts and the area
 * adapters) and a declared source, a table or the configuration (rule 20; the source is in the comment).
 * A fact of declared type 'address' compares against a device NAME through IDENTITY_SOURCES (hostname, any interface
 * address, base MAC, protocol router ids — OSPF's and [C1] EIGRP's). 'eigrp.successor' and 'eigrp.feasibleSuccessor'
 * are of type 'address' (the next hop of the first successor / feasible successor in path order; absent when none).
 * ([S4] 'ospf.abr' | 'ospf.asbr' are not approved.)
 */
export type LabFactName =
  /** ospf-interfaces.routerId (the id in use, not the configured one). */
  | 'ospf.routerId'
  /** Configuration; subject: none. */
  | 'ospf.referenceBandwidthMbps'
  | 'ospf.defaultOriginate'
  /** ospf-interfaces; subject: interface name. */
  | 'ospf.ifaceArea'
  | 'ospf.ifaceCost'
  | 'ospf.ifaceNetworkType'
  | 'ospf.ifaceState'
  | 'ospf.ifacePriority'
  | 'ospf.passive'
  /** ospf-lsdb; subject: area; every router of the area holds the same LSA headers. */
  | 'ospf.lsdbSynced'
  /** Configuration; subject: VLAN. */
  | 'snooping.enabled'
  | 'dai.enabled'
  /** arp-inspection; subject: VLAN. */
  | 'dai.dropped'
  /** Configuration; subject: port. */
  | 'snooping.trusted'
  | 'dai.trusted'
  /** dhcp-snooping; subject: host device name → the bound port. */
  | 'snooping.bindingPort'
  /** Configuration. */
  | 'ssh.enabled'
  | 'ssh.version'
  | 'ssh.keyBits'
  | 'vty.transport'
  | 'vty.loginLocal'
  | 'vty.accessClass'
  /** Configuration; subject: interface name. */
  | 'qos.inputPolicy'
  | 'qos.outputPolicy'
  /** Configuration + profile; subject: optional interface name. */
  | 'cdp.enabled'
  | 'lldp.enabled'
  /** ntp-peers (the sys-peer row). */
  | 'ntp.synced'
  | 'ntp.peer'
  /** The ntp daemon's `clock` row (absent → 'unset'). */
  | 'ntp.stratum'
  | 'clock.source'
  | 'clock.offsetMs'
  // the approved items' facts, each with its source:
  /** [S13] vty-logins: successful logins (count); subject: optional 'telnet' | 'ssh'. */
  | 'vty.logins'
  /** [S18] tunnels.state; subject: tunnel interface. */
  | 'tunnel.up'
  /** [S19] ppp rows; subject: serial interface. */
  | 'ppp.lcp'
  | 'ppp.ipcp'
  | 'ppp.auth'
  /** [S20] Configuration (the output policy passed admission); subject: interface. */
  | 'qos.admitted'
  /** [S24]/[S25] Configuration. */
  | 'logging.buffered'
  | 'logging.trap'
  /** [S32] script-runs: the state of the newest run; subject: optional file name. */
  | 'automation.lastRun'
  /** [C1] eigrp-topology; subject: prefix. */
  | 'eigrp.fd'
  | 'eigrp.successor'
  | 'eigrp.feasibleSuccessor'
  /** [C1] Configuration ('1 0 1 0 0'). */
  | 'eigrp.kValues'
  /** [C13] ipsec-sa.state; subject: tunnel interface. */
  | 'ipsec.sa';

/** @since P3 A packet the pure `aclDecision` kind evaluates against a configured list (no traffic, no clone). */
export interface LabPacketProbe {
  proto: 'ip' | 'icmp' | 'tcp' | 'udp';
  src: string;
  dst: string;
  srcPort?: number;
  dstPort?: number;
  established?: boolean;
}

/**
 * Devices are referenced by topology NAME (stable in lab builds).
 * @since P3 Every kind carries the optional-by-meaning LabAssertionNotes envelope (spec §12.4).
 */
export type LabAssertion = (
  | { kind: 'config'; device: string; path: string; equals?: string | readonly string[]; exists?: boolean; contains?: string }
  /** `field` 'errDisabled' @since P2 (the cause string, e.g. 'psecure-violation'). */
  | { kind: 'port'; device: string; port: string; field: 'operUp' | 'adminUp' | 'ipv4' | 'ipv6' | 'duplex' | 'speedBps' | 'role' | 'errDisabled'; equals: string | number | boolean }
  /**
   * `minCount`, `maxCount`, `whereOps` @since P3 (optional by meaning): bounds on the number of matching rows, and
   * per-column comparisons beyond `where`'s equality.
   */
  | {
      kind: 'table';
      device: string;
      table: TableName;
      where: Readonly<Record<string, string | number | boolean>>;
      exists: boolean;
      minCount?: number;
      maxCount?: number;
      whereOps?: Readonly<Record<string, { op: 'lt' | 'le' | 'gt' | 'ge' | 'ne' | 'contains'; value: string | number }>>;
    }
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
   * @since P3 (every member optional by meaning; absent = P2 behaviour) `proto` 'tcp' / 'udp' with `port` use the
   * tcp.probe / udp.probe process requests, applied in the clone exactly as icmp.ping is (TCP passes on SYN-ACK and fails
   * on RST, an ICMP unreachable or 3 s; UDP passes when the clone's trace shows the probe consumed by a socket on the
   * target). `toIface` / `toAddress` target an interface or an address (a loopback) of `to`; `source` is an interface
   * or address on `from`; `droppedAt` (a device NAME that must drop it, with expect 'fail') and `dropReason` are read
   * from the clone trace's `drop` event of the probe's PduId.
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
      proto?: 'icmp' | 'tcp' | 'udp';
      port?: number;
      toIface?: string;
      toAddress?: string;
      source?: string;
      droppedAt?: string;
      dropReason?: DropReason;
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
  /**
   * @since P2 The longest-prefix winner for `destination` (an address), or `none`.
   * `metric`, `routeType` and `minPaths` @since P3 (optional by meaning). ([S4] 'IA', [C6] 'E1', [C4] 'N1' | 'N2' are
   * not approved.)
   */
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
      metric?: number;
      routeType?: 'E2';
      minPaths?: number;
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
  | { kind: 'fhrp'; device: string; iface: string; group: number; state?: HsrpRow['state']; virtualIp?: string; priority?: number; preempt?: boolean }
  // ── P3 (ARCHITECTURE-P3 §2.10; all @since P3; devices, ports and hosts by NAME) ──
  /** @since P3 A neighbour row of `protocol` on `device` (NEIGHBOR_SOURCES); `neighbor` is a device NAME (IDENTITY_SOURCES). */
  | {
      kind: 'neighbor';
      device: string;
      protocol: NeighborProtocol;
      neighbor?: string;
      iface?: string;
      /** The protocol's own state word: 'full', '2way' … */
      state?: string;
      role?: 'dr' | 'bdr' | 'drother';
      exists?: boolean;
      count?: number;
      minCount?: number;
    }
  /** @since P3 A named fact of a device (FACT_READERS: a table or the configuration). */
  | { kind: 'fact'; device: string; fact: LabFactName; subject?: string; equals?: string | number | boolean; atLeast?: number; atMost?: number }
  /**
   * @since P3 A configured access list: its entries (canonical aclEntryText, no sequence), its bindings read from the
   * configuration, and the hit count of one entry. ([S11] would add `family` and type 'ipv6'.)
   */
  | {
      kind: 'acl';
      device: string;
      list: string;
      type?: 'standard' | 'extended';
      exists?: boolean;
      entries?: readonly string[];
      match?: 'exactly' | 'includes';
      applied?: readonly { iface?: string; vty?: true; dir: 'in' | 'out' }[];
      entry?: number | 'implicit';
      minMatches?: number;
    }
  /** @since P3 Pure: evaluates the CONFIGURED list with core/acl's evaluateAcl; no traffic, no clone. */
  | { kind: 'aclDecision'; device: string; list: string; packet: LabPacketProbe; expect: 'permit' | 'deny'; entry?: number | 'implicit' }
  // the approved items' kinds (W5 sim, clone checks):
  /**
   * @since P3 [S13] The clone opens a remote session from `from` (a vty-client) to `to` and reads the outcome from its
   * vty-logins row (success, failed) or the client's TCP refusal (refused: a RST, transport or access-class).
   */
  | {
      kind: 'service';
      from: string;
      to: string;
      service: 'telnet' | 'ssh';
      user?: string;
      password?: string;
      expect: 'success' | 'fail' | 'refused';
      timeoutMs?: number;
      after?: readonly LabFault[];
    }
  /**
   * @since P3 [S18] The path a probe takes in the clone. `tunnelAt` [C13] (optional by meaning): every frame of the probe
   * that `device` receives carries PduSummary.tunnel === tunnel (read from the clone trace's legs), so "only ESP
   * crosses the provider" is gradeable.
   */
  | {
      kind: 'path';
      from: string;
      to: string;
      toIface?: string;
      toAddress?: string;
      family?: 4 | 6;
      via?: readonly string[];
      notVia?: readonly string[];
      after?: readonly LabFault[];
      settleMs?: number;
      tunnelAt?: { device: string; tunnel: 'gre' | 'ipsec' };
    }
  /** @since P3 [S20] Generated flows run in the clone for `runMs`; each expectation reads the receiver's `flows` row. */
  | {
      kind: 'traffic';
      flows: readonly (TrafficFlowSpec & { from: string; to: string })[];
      runMs: number;
      expect: readonly { receiver: string; flow: string; maxLossPct?: number; maxDelayMs?: number; maxJitterMs?: number }[];
    }
) & LabAssertionNotes;

export interface LabTask extends LabTaskMeta {
  assertions: readonly LabAssertion[];
  feedbackOnFail?: string;
}

export interface LabCheckResult {
  task: string;
  pass: boolean;
  points: number;
  assertions: { index: number; pass: boolean; detail?: string }[];
  /**
   * @since P3 (optional by meaning; ruling R18, W2 sim) The analytics tag of the envelope (spec §12.4): the
   * `misconception` of the task's first failing assertion that carries one. Absent when the task passes or no failing
   * assertion carries one, so every P1 and P2 lab status keeps its bytes. Never shown to the learner.
   */
  misconception?: string;
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
  /**
   * Deterministic escape hatch for checks the declarative assertions cannot express.
   * @deprecated since P3 W0 (ARCHITECTURE-P3 D6): no lab or task uses it and the grader does not run it; removed at the
   * P3a exit gate (W8).
   */
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
