/**
 * contracts/journal.ts — the input journal behind time travel (ARCHITECTURE-P2 D18, §2.13, §3.13) [SHOULD S1].
 *
 * The facade journals every OUTERMOST mutating call at its position (dispatched-event count, sim time). A replay
 * facade implementing `Simulation` re-applies the journal to reach any earlier position byte for byte; the worker
 * keeps a few replayers parked at fixed event lags behind the live head (§3.13).
 *
 * Journal rules (binding for S1): only outermost facade calls are recorded (never during dispatch; `handleFault`
 * config fragments and `userCommand` events are not recorded; `sim.configure` through the CLI wrapper records once);
 * ops are deep-copied with `structuredClone` at record time; `loadTopology` starts a new journal whose origin holds
 * the counters from BEFORE the load; reads (`snapshot`, `traceQuery`, `pdu`, captures, `cli.complete`/`help`/
 * `canOpen`, `validateLink`, `nextEventTime`, `evaluateLab`) are never recorded and must not change state (an
 * observation-purity test guards it). CLI debug flags are cleared on `loadTopology`.
 *
 * Everything here is structured-clone safe except the error class. All wording is original (§1.6).
 */
import type { DefaultsProfile, ModuleType, SlotId } from './catalog.js';
import type { ConfigureOptions } from './cli.js';
import type { FaultSpec } from './events.js';
import type { DeviceId, LinkId, SessionId } from './ids.js';
import type { Impairments } from './link.js';
import type { AddDeviceSpec, AddLinkSpec, FidelityMode, HostAppRequest } from './simulation.js';
import type { SimTime } from './time.js';
import type { Topology, TopologyDeviceUi } from './topology.js';

/** @since P2 [S1] Where a world is: scheduler events popped since it was built, and its sim time. Per world. */
export interface JournalPosition {
  readonly dispatched: number;
  readonly now: SimTime;
}

/** @since P2 [S1] Facade counters a replay must start from so ids and cursors match the live world. */
export interface FacadeCounters {
  readonly traceHead: number;
  readonly sessions: number;
  readonly headless: number;
  readonly requests: number;
  readonly topologyVersion: number;
}

/** @since P2 [S1] What a journal replays from: the world as it was when the journal started. */
export interface JournalOrigin {
  readonly seed: number;
  readonly mode: FidelityMode;
  readonly profile: DefaultsProfile;
  /** The loaded topology, or null for a world built from scratch. */
  readonly topology: Topology | null;
  readonly counters: FacadeCounters;
}

/** @since P2 [S1] One recorded mutating facade call. */
export type JournalOp =
  | { op: 'addDevice'; spec: AddDeviceSpec }
  | { op: 'removeDevice'; id: DeviceId }
  | { op: 'renameDevice'; id: DeviceId; name: string }
  | { op: 'moveDevice'; id: DeviceId; position: { x: number; y: number } }
  | { op: 'setPower'; id: DeviceId; on: boolean }
  | { op: 'addLink'; spec: AddLinkSpec }
  | { op: 'removeLink'; id: LinkId }
  | { op: 'setImpairments'; id: LinkId; imp: Partial<Impairments> }
  | { op: 'injectFault'; at: SimTime; fault: FaultSpec }
  | { op: 'configure'; device: DeviceId; commands: readonly string[]; opts?: ConfigureOptions }
  | { op: 'insertModule'; device: DeviceId; slot: SlotId; module: ModuleType }
  | { op: 'removeModule'; device: DeviceId; slot: SlotId }
  | { op: 'setDeviceUi'; device: DeviceId; ui: TopologyDeviceUi }
  | { op: 'setCanvasScale'; metresPerUnit: number }
  | { op: 'hostRequest'; device: DeviceId; req: HostAppRequest }
  | { op: 'cliOpen'; device: DeviceId; via: 'console' | 'vty' }
  | { op: 'cliExec'; session: SessionId; line: string }
  | { op: 'cliInterrupt'; session: SessionId }
  | { op: 'cliClose'; session: SessionId };

/** @since P2 [S1] A journal entry: the op, where it was applied, and the trace head right after it. */
export interface JournalEntry {
  readonly at: JournalPosition;
  readonly op: JournalOp;
  readonly traceHead: number;
  /** The live call threw (the replay expects it to throw too). */
  readonly threw?: true;
}

/** @since P2 [S1] A whole journal (`Simulation.journal()`). */
export interface SimJournal {
  readonly version: 1;
  readonly origin: JournalOrigin;
  readonly entries: readonly JournalEntry[];
}

/** @since P2 [S1] Where a seek goes: a sim time, a trace ring cursor, or an exact position. */
export type SeekTarget = { readonly time: SimTime } | { readonly cursor: number } | { readonly position: JournalPosition };

/** @since P2 [S1] A replay produced a different trace head than the live world at a journal entry (a determinism defect). */
export class ReplayDivergenceError extends Error {
  /** Index of the journal entry after which the heads differed. */
  readonly entry: number;
  readonly expectedHead: number;
  readonly actualHead: number;
  constructor(entry: number, expectedHead: number, actualHead: number) {
    super(`The replay went a different way at journal entry ${entry}: the trace head should be ${expectedHead} but is ${actualHead}.`);
    this.name = 'ReplayDivergenceError';
    this.entry = entry;
    this.expectedHead = expectedHead;
    this.actualHead = actualHead;
  }
}

/** @since P2 [S1] Rejection text of every mutating call while reviewing the past. */
export const REPLAY_READ_ONLY_MESSAGE = 'You are looking at the past. Return to the present to change the network.';
