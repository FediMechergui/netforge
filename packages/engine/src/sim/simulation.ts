/**
 * sim/simulation.ts — the Simulation facade (spec §4.1 discrete-event core, §4.2 time model, §4.3 fidelity modes,
 * §4.11 fault injection, §12.5 deterministic grading; ARCHITECTURE "Run loop"; ARCHITECTURE-P1 D7–D12, §3.3,
 * §3.6, §3.11, §3.12, §3.14).
 *
 * One object wires the whole engine together:
 *   scheduler (heap on (at, seq), tracked for idleness: sim/run-control.ts) · root rng (`createRng(seed)`,
 *   sub-streams split by stable labels) · trace ring (+ synchronous listeners, `debug` events forwarded to the CLI,
 *   config events feeding the snapshot render cache) · PDU factory with a bounded id → Pdu registry · device
 *   catalog · link model and media wiring (sim/media-wiring.ts) · devices (a Map in creation order) · CLI runtime.
 *
 * Run loop (sim/run-control.ts; P1 breakpoints `runUntil(t, {stopOn})`, `stepToNext` and `traceQuery` run there over
 * the ring and a trace listener): `step()` pops ONE event and dispatches it by kind:
 *   frameArrival → LinkModel.admit, then DeviceRuntime.onFrameArrival when delivered   (media-wiring)
 *   txComplete   → LinkModel.onTxComplete                                             (media-wiring)
 *   mediumTimer  → LinkModel.onMediumTimer + OperChanges fan-out                       (media-wiring)
 *   deviceMoved  → LinkModel.onDevicesMoved + fan-out                                  (media-wiring)
 *   timer        → DeviceRuntime.onTimer
 *   boot         → DeviceRuntime.onBoot
 *   linkState    → LinkModelImpl.cut(link, !up) + onPortOper fan-out
 *   userCommand  → cli.exec
 *   fault        → the fault handler (cable-cut, port-flap, power-loss, link-impairment, config-fragment)
 * Events addressed to a device that no longer exists are ignored.
 *
 * Devices (§3.3): `addDevice` validates the type and the module installs (the spec's list, else the model's default
 * modules) BEFORE any state changes, rounds the position, resolves the MAC salt — the preferred salt is bumped while
 * `deviceMacBase(id, salt)` is already registered by another device, in world-insertion order — and builds the
 * `DeviceSpec` with modules (slot order), macSalt and ui. MACs therefore depend on the device id only (D8), never on
 * the seed or the creation order. `removeDevice` unregisters the base.
 *
 * Topology (§3.14): `loadTopology` is ATOMIC. `prepareTopologyLoad` parses any accepted schema id, migrates and
 * validates types, modules and port names against the catalog; problems throw a `TopologyLoadError` before anything
 * changes. The new world is then built aside and swapped in only when it is complete: sim time returns to 0, the
 * scheduler, rng streams, PDU ids, id generators, MAC registry and link model are recreated from the SIMULATION's
 * seed (the topology's `seed` field is informational), every CLI session is closed, and `canvas`, `objectives`,
 * `notes` and `lab` are retained for export. Links get `kind = linkKindOf(resolvedMedia)` when omitted, `dce_end` →
 * `dceEnd` and `distance_m` → `distanceOverrideM`. The trace ring is kept (its cursor stays monotonic).
 *
 * `exportTopology` writes TOPOLOGY_SCHEMA_ID (1.1). It keeps NVRAM and RAM apart: `config` is the device's
 * startup-config (`startup.render()`; absent after `erase startup-config`; for a never-booted device the spec's
 * startup text), and a booted device also gets `runningConfig = running.render()`. It writes `modules` only for
 * models with slots, `hardware.macSalt` only when > 0, `ui` when set, link `kind` only for radio links, `dce_end` and
 * `distance_m` when set, `canvas` only when the scale is not the default, and the retained objectives, notes and lab.
 *
 * User and GUI actions (cli.exec, configure, module changes, moves) are applied between scheduler events at the
 * synced device clock. `moveDevice` rounds the position and, for a device with radio ports, schedules one coalesced
 * `deviceMoved` event at `now`; a paused caller runs `runUntil(now)` to dispatch it.
 *
 * P1 (§4.4 step 0, §4.12, §4.13): `hostRequest(device, req)` is an ALLOWLIST (HOST_APP_PROCESS) that turns a GUI app
 * action into one ProcessRequest applied at the synced device clock — http.get → http-client `http.fetch
 * {owner:'gui', token}`, wifi.scan → wlan-client `wlan.scan`, dhcp.renew/release → dhcp-client `dhcp.client`. The
 * ticket id is `r_<n>` from a plain counter (never the rng). It is the daemon's StateView key only for `http.get`
 * (the http-client tab token); a `wifi.scan` result is keyed by port and a dhcp one by interface, so there the
 * ticket is only a handle on the call. An unknown device, an unknown port, a malformed payload or a device not
 * running that daemon throws an original error and changes nothing. Captures (`c_<n>`) live in one `CaptureHub` installed as the link model's tap: the facade only
 * resolves capture points against the live world (ports ∪ link ends ∪ medium members) and forwards query / record /
 * follow / stats / export to capture/store.ts, so exports stay byte-deterministic for a given `baseWallNs`. Captures
 * die with the world (`loadTopology` clears the hub); the id counter keeps counting. Labs need no setter: the
 * retained `lab` section round-trips through `loadTopology`/`exportTopology` and sim/lab-checks.ts grades a
 * Simulation from the outside.
 *
 * ponytail (P1): a refused `hostRequest` spends no ticket number — the payload is validated before the counter
 * moves — so a GUI that retries after a readable error still sees `r_1`; `wifi.scan` without a port takes the
 * device's FIRST wireless interface (no model has two); http-client forgets finished tabs past
 * HTTP_CLIENT_RETAINED_TABS, so a long browsing session does not grow every snapshot; and
 * `loadTopology` drops every capture but keeps the `c_<n>` counter, so an id never names two different captures in
 * one session.
 *
 * P2 (ARCHITECTURE-P2 D2, §2.9, §0 rule 13; W1 sim): a world has a defaults profile. `SimulationOptions.profile`
 * (default 'P1') is the profile of the initial world; `Simulation.profile` reads the current world's, and every device
 * the world builds gets it as `DeviceSpec.profile` — written only when it is not 'P1' (absent means 'P1', so a P1
 * device spec keeps its P1 shape). `SimulationOptions.catalog` (tests and tooling only; never passed by apps/web)
 * replaces `createCatalog(PROCESS_FACTORIES)` everywhere the facade needs a catalog: device creation, media wiring,
 * the CLI runtime and the load gate. test/p2.world.ts builds P2-stage worlds through it before the catalog flips.
 *
 * P2 W2 sim (§2.9, §3.8 step 7): `loadTopology` gives the new world the profile of the document, `t.profile ?? 'P1'`
 * (a 1.1 document never carries one: io/schema.ts strips the 1.2 key, so it loads as P1). `exportTopology` writes
 * `profile: 'P2'` only for a P2 world and then `schema = schemaIdFor(t)` (1.2) in the same step; a P1 world exports
 * byte-identically as 1.1. The `err-disable` fault (target device + port, `params.cause` one of ERR_DISABLE_CAUSES,
 * default 'fault') goes through `DeviceRuntime.errDisablePort` — the lab-check clone re-applies err-disabled ports
 * with it. The snapshot carries `profile: 'P2'` for a P2 world and nothing for a P1 one (sim/snapshot-cache.ts).
 *
 * [S1] Time travel (D18, §2.13, §3.13; the `// [S1]` block below): the facade journals every OUTERMOST mutating call
 * through sim/journal.ts — `{at: position(), op, traceHead}`, the op deep-copied at record time — and nothing reached
 * from inside another facade call or a dispatch (the run methods run nested). `position()` is the world's
 * `(dispatched, now)`; `journal()` a structured-clone copy. `loadTopology` starts a new journal whose origin holds the
 * facade counters from BEFORE the load. `SimulationOptions.resume` (a replay) starts the trace ring at
 * `counters.traceHead` (trace/ring.ts `startHead`), `topologyVersion` and the `r_<n>` request counter at their values,
 * and carries `sessions` / `headless` as the counts the journal reports; `journal: false` records no entry;
 * `pduRegistryLimit` bounds the id → PDU registry (replayers run with a small one). Reads never record and never
 * change state (`sim.observation-purity.test.ts`).
 *
 * Determinism: no wall clock and no Math.random anywhere; every iteration that affects behaviour is over arrays or
 * insertion-ordered Maps.
 */
import { deviceMacBase } from '../contracts/addr.js';
import type {
  CaptureExportOptions,
  CaptureId,
  CaptureInfo,
  CaptureQuery,
  CaptureQueryResult,
  CaptureRecordDetail,
  CaptureSpec,
  CaptureStatistics,
  FollowStreamResult,
} from '../contracts/capture.js';
import {
  DEFAULTS_PROFILES,
  HARDWARE_MESSAGES,
  SLOT_ACCEPTS,
  type DefaultsProfile,
  type HardwareResult,
  type ModuleInstall,
  type ModuleType,
  type PortEncap,
  type SlotId,
} from '../contracts/catalog.js';
import type { CliRuntime, ConfigureOptions, ConfigureResult } from '../contracts/cli.js';
import type { DeviceCatalog, DeviceModel, DeviceRuntime, DeviceRuntimeDeps, DeviceSpec } from '../contracts/device.js';
import type { FaultSpec, SimEvent } from '../contracts/events.js';
import type { DeviceId, LinkId, PduId, PortId, PortRef, ProcessName } from '../contracts/ids.js';
import type { FacadeCounters, JournalOp, JournalOrigin, JournalPosition, SimJournal } from '../contracts/journal.js';
import { NO_IMPAIRMENTS, linkKindOf, type CableValidation, type Impairments, type LinkKind, type LinkState } from '../contracts/link.js';
import type { Pdu, PduView } from '../contracts/pdu.js';
import { ERR_DISABLE_CAUSES, type ErrDisableCause } from '../contracts/port.js';
import type { Rng } from '../contracts/rng.js';
import type { SimSnapshot } from '../contracts/snapshot.js';
import type { Action, ProcessRequest } from '../contracts/process.js';
import {
  TopologyLoadError,
  type AddDeviceSpec,
  type AddLinkSpec,
  type FidelityMode,
  type HostAppRequest,
  type HostAppTicket,
  type RunOptions,
  type RunStats,
  type Simulation,
  type SimulationOptions,
  type SnapshotOptions,
} from '../contracts/simulation.js';
import { SEC, assertSimTime, type SimTime } from '../contracts/time.js';
import {
  DEFAULT_METRES_PER_UNIT,
  TOPOLOGY_SCHEMA_ID,
  schemaIdFor,
  type Topology,
  type TopologyDevice,
  type TopologyDeviceUi,
  type TopologyLink,
} from '../contracts/topology.js';
import type { TraceEvent, TraceSink } from '../contracts/trace.js';
import { createRng } from '../core/prng.js';
import { createTable } from '../core/table.js';
import { createTraceRing } from '../trace/ring.js';
import { createPduFactory, type PduFactoryImpl } from '../pdu/factory.js';
import { createCatalog } from '../device/catalog.js';
import { createDevice } from '../device/device.js';
import type { LinkModelImpl } from '../link/link.js';
import { PROCESS_FACTORIES } from '../protocols/index.js';
import { createCliRuntime } from '../cli/runtime.js';
import { MAX_METRES_PER_UNIT, deviceUiSchema, formatIssues, prepareTopologyLoad, topologyLoadError } from '../io/schema.js';
import { createCaptureHub, resolveCapturePoints, type CapturePointResolver } from '../capture/tap.js';
import type { CaptureStoreImpl } from '../capture/store.js';
import { createIdGen, type IdGen } from './ids.js';
import { createRunControl, createTrackedScheduler, type TrackedScheduler } from './run-control.js';
import { createMediaWiring, type MediaWiring } from './media-wiring.js';
import {
  configFragmentCommands,
  configureDevice,
  insertModule as insertModuleOp,
  removeModule as removeModuleOp,
  CONFIG_FRAGMENT_OPTIONS,
  unknownDeviceError,
  type ConfigureEnv,
} from './configure.js';
import { buildSimSnapshot, createRenderCache } from './snapshot-cache.js';
import { createJournalRecorder } from './journal.js';

/** Trace ring capacity when `SimulationOptions.traceCapacity` is not given (turbo mode: 0). */
export const DEFAULT_TRACE_CAPACITY = 200_000;

/** Number of most recent PDUs kept for `Simulation.pdu(id)`. */
export const PDU_REGISTRY_LIMIT = 50_000;

/** Default cable length in metres for `addLink`. */
export const DEFAULT_LINK_LENGTH_M = 3;

/** Default `runToIdle` event cap. */
export const DEFAULT_MAX_IDLE_EVENTS = 1_000_000;

/** Process name the facade uses when it calls `DeviceRuntime.applyActions` itself. */
export const SIM_PROCESS_NAME = 'sim';

/** Default number of admin toggles of a `port-flap` fault (down, then up). */
export const DEFAULT_FLAP_COUNT = 2;

/** @since P2 Cause of an `err-disable` fault whose `params.cause` is absent or not an `ErrDisableCause`. */
export const DEFAULT_ERR_DISABLE_CAUSE: ErrDisableCause = 'fault';

/** @since P2 True when `v` names an err-disable cause (`ERR_DISABLE_CAUSES`). */
export function isErrDisableCause(v: unknown): v is ErrDisableCause {
  return typeof v === 'string' && (ERR_DISABLE_CAUSES as readonly string[]).includes(v);
}

/** @since P2 [S1] The facade counters of a world built from nothing (`FacadeCounters`, all zero). */
export const ZERO_FACADE_COUNTERS: FacadeCounters = Object.freeze({ traceHead: 0, sessions: 0, headless: 0, requests: 0, topologyVersion: 0 });

/** @since P2 [S1] Validated copy of `SimulationOptions.resume`; throws a RangeError for a counter that is not a non-negative safe integer. */
export function checkedFacadeCounters(c: FacadeCounters): FacadeCounters {
  const keys = ['traceHead', 'sessions', 'headless', 'requests', 'topologyVersion'] as const;
  for (const k of keys) {
    const v = c[k];
    if (!Number.isSafeInteger(v) || v < 0) throw new RangeError(`resume.${k} must be a non-negative integer, got ${String(v)}`);
  }
  return { traceHead: c.traceHead, sessions: c.sessions, headless: c.headless, requests: c.requests, topologyVersion: c.topologyVersion };
}

/**
 * @since P1 The allowlist behind `hostRequest` (§4.4 step 0): the daemon each GUI app request is mapped onto.
 * A request for anything else, or to a device that is not running that daemon, is refused with an original error.
 */
export const HOST_APP_PROCESS: Readonly<Record<HostAppRequest['app'], ProcessName>> = Object.freeze({
  'http.get': 'http-client',
  'wifi.scan': 'wlan-client',
  'dhcp.renew': 'dhcp-client',
  'dhcp.release': 'dhcp-client',
});

/** Default spacing between `port-flap` toggles. */
export const DEFAULT_FLAP_PERIOD_NS: SimTime = SEC;

/** Topology sections a loaded document keeps for export (no other setter exists). */
interface RetainedSections {
  objectives?: string[];
  notes?: string;
  lab?: { name: string; version: number };
}

/** Everything that is recreated by `loadTopology`. */
interface World {
  readonly scheduler: TrackedScheduler;
  readonly rng: Rng;
  readonly pdus: PduFactoryImpl;
  readonly registry: Map<PduId, Pdu>;
  readonly devices: Map<DeviceId, DeviceRuntime>;
  /** Device ids in creation order (the link model's device order). */
  readonly deviceOrder: DeviceId[];
  readonly media: MediaWiring;
  readonly deviceIds: IdGen;
  readonly linkIds: IdGen;
  /** hostname prefix → last number used for a generated name. */
  readonly nameCounters: Map<string, number>;
  /** Registered MAC bases → owning device (D8 collision detection). Lookup only; never iterated. */
  readonly macBases: Map<number, DeviceId>;
  /** Metres per canvas unit. */
  metresPerUnit: number;
  retained: RetainedSections;
  /** Topology-version bumps made while the world was built aside (applied when it is swapped in). */
  pendingVersionBumps: number;
  /** @since P2 The world's defaults profile (D2); every device built into this world gets it as `DeviceSpec.profile`. */
  readonly profile: DefaultsProfile;
}

/** Read a finite number parameter. */
function numParam(params: Record<string, unknown> | undefined, key: string): number | undefined {
  const v = params?.[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/** Keep only the impairment fields of an untyped record. */
function impairmentsFrom(src: unknown): Partial<Impairments> {
  const out: Partial<Impairments> = {};
  if (src === null || typeof src !== 'object') return out;
  const r = src as Record<string, unknown>;
  for (const k of ['lossPct', 'latencyNs', 'jitterNs', 'corruptPct', 'bandwidthBps'] as const) {
    const v = r[k];
    if (typeof v === 'number') out[k] = v;
  }
  return out;
}

/** Impairment fields that differ from `NO_IMPAIRMENTS` (for compact topology export). */
function nonDefaultImpairments(imp: Impairments): Partial<Impairments> | undefined {
  const out: Partial<Impairments> = {};
  if (imp.lossPct !== NO_IMPAIRMENTS.lossPct) out.lossPct = imp.lossPct;
  if (imp.latencyNs !== NO_IMPAIRMENTS.latencyNs) out.latencyNs = imp.latencyNs;
  if (imp.jitterNs !== NO_IMPAIRMENTS.jitterNs) out.jitterNs = imp.jitterNs;
  if (imp.corruptPct !== NO_IMPAIRMENTS.corruptPct) out.corruptPct = imp.corruptPct;
  if (imp.bandwidthBps !== undefined) out.bandwidthBps = imp.bandwidthBps;
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Integer canvas position (Math.round, no negative zero); throws for non-finite coordinates. */
export function roundPosition(position: { x: number; y: number }): { x: number; y: number } {
  if (!Number.isFinite(position.x) || !Number.isFinite(position.y)) {
    throw new RangeError(`A device position needs finite coordinates, got (${position.x}, ${position.y}).`);
  }
  return { x: Math.round(position.x) + 0, y: Math.round(position.y) + 0 };
}

/** Substitute the `{key}` fields of a HARDWARE_MESSAGES template. */
function fillHardware(template: string, values: Readonly<Record<string, string>>): string {
  return template.replace(/\{(\w+)\}/g, (whole, key: string) => values[key] ?? whole);
}

/** @since P2 The initial world's profile: `opts.profile`, default 'P1'; throws a RangeError for anything else. */
function initialProfile(profile: DefaultsProfile | undefined): DefaultsProfile {
  if (profile === undefined) return 'P1';
  if (!DEFAULTS_PROFILES.includes(profile)) {
    throw new RangeError(`profile must be one of ${DEFAULTS_PROFILES.join(', ')}, got ${String(profile)}`);
  }
  return profile;
}

/** Validated and deep-copied GUI state; throws a readable error for an invalid value. */
function checkedUi(ui: TopologyDeviceUi): TopologyDeviceUi {
  const r = deviceUiSchema.safeParse(ui);
  if (!r.success) throw new Error(`Invalid device ui state: ${formatIssues(r.error).join('; ')}`);
  return JSON.parse(JSON.stringify(r.data)) as TopologyDeviceUi;
}

/**
 * Create a simulation. See the file header for wiring, run-loop, load and export semantics. `opts.seed` drives every
 * random decision; the same seed and the same inputs give byte-identical traces and snapshots.
 */
export function createSimulation(opts: SimulationOptions): Simulation {
  const seed = opts.seed;
  if (!Number.isSafeInteger(seed)) throw new RangeError(`seed must be a safe integer, got ${seed}`);
  const mode: FidelityMode = opts.mode ?? 'simulation';
  const capacity = opts.traceCapacity ?? (mode === 'turbo' ? 0 : DEFAULT_TRACE_CAPACITY);
  // [S1] a replay resumes the facade counters of its origin (§2.13): the ring starts at the live trace head.
  const resume: FacadeCounters = opts.resume === undefined ? ZERO_FACADE_COUNTERS : checkedFacadeCounters(opts.resume);
  const pduRegistryLimit = opts.pduRegistryLimit ?? PDU_REGISTRY_LIMIT;
  if (!Number.isSafeInteger(pduRegistryLimit) || pduRegistryLimit < 0) {
    throw new RangeError(`pduRegistryLimit must be a non-negative integer, got ${String(pduRegistryLimit)}`);
  }
  const ring = createTraceRing(capacity, resume.traceHead);
  const listeners: ((ev: TraceEvent) => void)[] = [];
  /** P2 §0 rule 13: `opts.catalog` (tests and tooling only) replaces the built-in catalog everywhere. */
  const catalog: DeviceCatalog = opts.catalog ?? createCatalog(PROCESS_FACTORIES);
  const profile0 = initialProfile(opts.profile);
  const renderCache = createRenderCache();
  /** P1 live captures (`c_<n>`); also the link model's tap. Cleared by `loadTopology` (captures die with the world). */
  const hub = createCaptureHub();
  let topologyVersion = resume.topologyVersion;
  let cliRef: CliRuntime | undefined;
  /** `hostRequest` ticket counter (`r_<n>`, never the rng); it keeps counting across `loadTopology`. */
  let requestCounter = resume.requests;
  /** The trace sink every module writes to: ring, listeners, debug → CLI, config events → render cache. */
  const sink: TraceSink = {
    emit(ev: TraceEvent): void {
      ring.emit(ev);
      if (listeners.length > 0) {
        const ls = listeners.length === 1 ? listeners : listeners.slice();
        for (const l of ls) l(ev);
      }
      if (ev.kind === 'debug' && cliRef !== undefined) cliRef.onDebugEvent(ev.event);
      renderCache.observe(ev);
    },
  };

  let world: World = makeWorld(DEFAULT_METRES_PER_UNIT, profile0);

  /** The CLI core counts the console/vty sessions (`s_<n>`) and headless runs (`h_<n>`), seeded from `resume` ([S1]). */
  const cliCore = createCliRuntime({
    device: (id) => world.devices.get(id),
    catalog,
    trace: sink,
    now: () => world.scheduler.now,
    radioView: (ref) => world.media.links.radioPortView(ref),
    airView: (device) => world.media.links.airView(device),
    resume: { sessions: resume.sessions, headless: resume.headless },
  });

  // [S1] ── facade counters and the input journal (file header; sim/journal.ts) ──────────────────────────────────
  /** The world's position: events popped by its scheduler, and its sim time (§2.13 `JournalPosition`). */
  const position = (): JournalPosition => ({ dispatched: world.scheduler.dispatched, now: world.scheduler.now });
  /** The counters a replay must start from so ids and cursors match this world. */
  const counters = (): FacadeCounters => {
    const cli = cliCore.counters();
    return { traceHead: ring.head, sessions: cli.sessions, headless: cli.headless, requests: requestCounter, topologyVersion };
  };
  const journalOrigin = (profile: DefaultsProfile, topology: Topology | null): JournalOrigin => ({ seed, mode, profile, topology, counters: counters() });
  const recorder = createJournalRecorder({ position, traceHead: () => ring.head }, journalOrigin(profile0, null), opts.journal ?? true);
  /** Run a mutating facade call: recorded as `op` when outermost (sim/journal.ts). */
  const apply = <T>(op: JournalOp, fn: () => T): T => recorder.apply(op, fn);
  // [S1] ── end ───────────────────────────────────────────────────────────────────────────────────────────────────

  /**
   * Device operations without a time argument (`applyConfigLine`, table clears) stamp the device's last dispatched
   * time. Between events that time can lag `now`, so sync it first through the contract entry point `applyActions`
   * (an empty action list only sets the clock).
   */
  function syncClock(dev: DeviceRuntime | undefined): void {
    if (dev !== undefined) dev.applyActions(SIM_PROCESS_NAME, [], world.scheduler.now);
  }

  /**
   * The CLI runtime as exposed by the facade: calls that act on a device first sync that device's clock. [S1] The
   * mutating calls (open, close, exec, interrupt, configure) are journaled when outermost; a `userCommand` dispatch
   * or `sim.configure` reaches them nested and records nothing more.
   */
  const cli: CliRuntime = {
    onOutput: (session, text, now) => cliCore.onOutput(session, text, now),
    onDone: (session, now) => cliCore.onDone(session, now),
    onDebugEvent: (ev) => cliCore.onDebugEvent(ev),
    open: (device, via) =>
      apply({ op: 'cliOpen', device, via }, () => cliCore.open(device, via)),
    close: (id) => apply({ op: 'cliClose', session: id }, () => cliCore.close(id)),
    exec: (id, line) =>
      apply({ op: 'cliExec', session: id, line }, () => {
        const s = cliCore.session(id);
        if (s !== undefined) syncClock(world.devices.get(s.device));
        return cliCore.exec(id, line);
      }),
    complete: (id, partial) => cliCore.complete(id, partial),
    help: (id, partial) => cliCore.help(id, partial),
    interrupt: (id) =>
      apply({ op: 'cliInterrupt', session: id }, () => {
        const s = cliCore.session(id);
        if (s !== undefined) syncClock(world.devices.get(s.device));
        cliCore.interrupt(id);
      }),
    session: (id) => cliCore.session(id),
    sessions: () => cliCore.sessions(),
    canOpen: (device, via) => cliCore.canOpen(device, via),
    configure: (device, commands, options) =>
      apply(options === undefined ? { op: 'configure', device, commands } : { op: 'configure', device, commands, opts: options }, () => {
        syncClock(world.devices.get(device));
        try {
          return cliCore.configure(device, commands, options);
        } finally {
          renderCache.invalidate(device);
        }
      }),
    onPortsRemoved: (device, ports) => cliCore.onPortsRemoved(device, ports),
    counters: () => cliCore.counters(),
  };
  cliRef = cli;

  // ── world construction ────────────────────────────────────────────────────

  function makeWorld(metresPerUnit: number, profile: DefaultsProfile): World {
    const scheduler = createTrackedScheduler();
    const rng = createRng(seed);
    const registry = new Map<PduId, Pdu>();
    const pdus = createPduFactory({
      onCreate: (pdu) => {
        registry.set(pdu.id, pdu);
        if (registry.size > pduRegistryLimit) {
          // ids are monotonic, so the first key in insertion order is the oldest
          const oldest = registry.keys().next();
          if (oldest.done !== true) registry.delete(oldest.value);
        }
      },
    });
    const devices = new Map<DeviceId, DeviceRuntime>();
    const deviceOrder: DeviceId[] = [];
    const media = createMediaWiring({ scheduler, rng, pdus, devices, deviceOrder }, { trace: sink, catalog, metresPerUnit, capture: hub });
    return {
      scheduler,
      rng,
      pdus,
      registry,
      devices,
      deviceOrder,
      media,
      deviceIds: createIdGen('d'),
      linkIds: createIdGen('l'),
      nameCounters: new Map(),
      macBases: new Map(),
      metresPerUnit,
      retained: {},
      pendingVersionBumps: 0,
      profile,
    };
  }

  function deviceDeps(w: World, id: DeviceId): DeviceRuntimeDeps {
    return {
      scheduler: w.scheduler,
      trace: sink,
      rng: w.rng.split(`device:${id}`),
      pdus: w.pdus,
      catalog,
      tables: createTable,
      transmit: w.media.transmit,
      onPortAdmin: (ref, adminUp, now) => w.media.onPortAdmin(ref, adminUp, now),
      onPortPhyConfig: (ref, now) => w.media.onPortPhyConfig(ref, now),
      airView: (device) => w.media.airView(device),
      mediumOp: (from, op, now) => w.media.mediumOp(from, op, now),
      cliSink: {
        output: (session, text, now) => cli.onOutput(session, text, now),
        done: (session, now) => cli.onDone(session, now),
      },
    };
  }

  // ── helpers ───────────────────────────────────────────────────────────────

  function requireDevice(id: DeviceId): DeviceRuntime {
    const d = world.devices.get(id);
    if (d === undefined) throw unknownDeviceError(id);
    return d;
  }

  function nextName(w: World, model: DeviceModel): string {
    const prefix = model.hostnamePrefix;
    const inUse = (name: string): boolean => {
      for (const d of w.devices.values()) if (d.spec.name === name) return true;
      return false;
    };
    let n = w.nameCounters.get(prefix) ?? 0;
    let name: string;
    do {
      n++;
      name = `${prefix}${n}`;
    } while (inUse(name));
    w.nameCounters.set(prefix, n);
    return name;
  }

  /** Resolve a PortRef whose port may be a short name against the live device; returns an explanation on failure. */
  function resolvePortRef(w: World, ref: PortRef): { ok: true; ref: PortRef } | { ok: false; reason: string } {
    const d = w.devices.get(ref.device);
    if (d === undefined) return { ok: false, reason: `No device with id "${ref.device}" exists.` };
    let port: string | undefined;
    if (d.ports.has(ref.port)) port = ref.port;
    else {
      const r = d.resolvePortName(ref.port);
      port = r.kind === 'existing' ? r.port : undefined;
    }
    if (port === undefined || !d.ports.has(port)) {
      return { ok: false, reason: `${d.spec.name} has no port called "${ref.port}".` };
    }
    return { ok: true, ref: { device: ref.device, port } };
  }

  /** Emit a structural `topologyChanged` event and bump the version (deferred while a world is built aside). */
  function bumpTopology(w: World, what: 'device' | 'link' | 'module', id: string, op: 'add' | 'remove'): void {
    if (w === world) topologyVersion++;
    else w.pendingVersionBumps++;
    sink.emit({ t: w.scheduler.now, kind: 'topologyChanged', what, id, op });
  }

  function closeSessionsOf(device: DeviceId): void {
    for (const s of cli.sessions()) if (s.device === device) cli.close(s.id);
  }

  /** Module installs of a new device (the spec's list, else the model's default modules), validated and in slot order. */
  function checkedInstalls(model: DeviceModel, requested: readonly ModuleInstall[] | undefined): ModuleInstall[] {
    const slots = model.slots ?? [];
    const installs: ModuleInstall[] =
      requested !== undefined
        ? requested.map((i) => ({ slot: i.slot, module: i.module }))
        : slots.filter((s) => s.defaultModule !== undefined).map((s) => ({ slot: s.id, module: s.defaultModule as ModuleType }));
    const seen: SlotId[] = [];
    for (const install of installs) {
      const slot = slots.find((s) => s.id === install.slot);
      if (slot === undefined) throw new Error(fillHardware(HARDWARE_MESSAGES['no-such-slot'], { model: model.model, slot: install.slot }));
      const mod = catalog.module?.(install.module);
      if (mod === undefined) throw new Error(fillHardware(HARDWARE_MESSAGES['unknown-module'], { module: install.module }));
      if (!SLOT_ACCEPTS[slot.type].includes(mod.fits)) {
        throw new Error(fillHardware(HARDWARE_MESSAGES['does-not-fit'], { module: mod.model, slotType: slot.type }));
      }
      if (seen.includes(slot.id)) {
        const previous = installs.find((i) => i.slot === slot.id) as ModuleInstall;
        throw new Error(fillHardware(HARDWARE_MESSAGES['slot-occupied'], { slot: slot.id, module: catalog.module?.(previous.module)?.model ?? previous.module }));
      }
      seen.push(slot.id);
    }
    const rank = (id: SlotId): number => slots.findIndex((s) => s.id === id);
    return installs.map((install, i) => ({ install, i })).sort((a, b) => rank(a.install.slot) - rank(b.install.slot) || a.i - b.i).map((e) => e.install);
  }

  // ── topology operations ───────────────────────────────────────────────────

  function addDeviceTo(w: World, spec: AddDeviceSpec): DeviceId {
    const model = catalog.get(spec.type);
    if (model === undefined) throw new Error(`Unknown device type "${spec.type}".`);
    const position = spec.position === undefined ? { x: 0, y: 0 } : roundPosition(spec.position);
    const modules = checkedInstalls(model, spec.modules);
    const preferredSalt = spec.macSalt ?? 0;
    if (!Number.isSafeInteger(preferredSalt) || preferredSalt < 0) throw new RangeError(`macSalt must be a non-negative integer, got ${preferredSalt}`);
    const ui = spec.ui === undefined ? undefined : checkedUi(spec.ui);

    let id = spec.id;
    if (id !== undefined) {
      if (id === '') throw new Error('A device id must not be empty.');
      if (w.devices.has(id)) throw new Error(`A device with id "${id}" already exists.`);
    } else {
      do id = w.deviceIds.next();
      while (w.devices.has(id));
    }
    let macSalt = preferredSalt;
    while (w.macBases.has(deviceMacBase(id, macSalt))) macSalt++;

    const dspec: DeviceSpec = {
      id,
      type: model.type,
      name: spec.name ?? nextName(w, model),
      position,
      power: spec.power ?? true,
      modules,
      macSalt,
    };
    if (spec.startupConfig !== undefined) dspec.startupConfig = spec.startupConfig;
    if (spec.runningConfig !== undefined) dspec.runningConfig = spec.runningConfig;
    if (ui !== undefined) dspec.ui = ui;
    // P2 (D2): the world's profile, written only when it is not the default 'P1' (optional by meaning).
    if (w.profile !== 'P1') dspec.profile = w.profile;
    const dev = createDevice(dspec, deviceDeps(w, id), w.scheduler.now);
    w.macBases.set(deviceMacBase(id, macSalt), id);
    w.devices.set(id, dev);
    w.deviceOrder.push(id);
    bumpTopology(w, 'device', id, 'add');
    return id;
  }

  function removeLinkIn(w: World, id: LinkId): void {
    if (w.media.links.get(id) === undefined) throw new Error(`No link with id "${id}" exists in this simulation.`);
    const now = w.scheduler.now;
    w.media.fanOut(w.media.links.remove(id, now), now);
    bumpTopology(w, 'link', id, 'remove');
  }

  function removeDevice(id: DeviceId): void {
    const dev = requireDevice(id);
    const w = world;
    const now = w.scheduler.now;
    for (const l of w.media.links.linksOfDevice(id)) removeLinkIn(w, l);
    dev.setPower(false, now);
    closeSessionsOf(id);
    w.devices.delete(id);
    const at = w.deviceOrder.indexOf(id);
    if (at >= 0) w.deviceOrder.splice(at, 1);
    const base = deviceMacBase(id, dev.spec.macSalt ?? 0);
    if (w.macBases.get(base) === id) w.macBases.delete(base);
    renderCache.forget(id);
    w.media.forgetDevice(id, now);
    bumpTopology(w, 'device', id, 'remove');
  }

  function addLinkTo(w: World, spec: AddLinkSpec): LinkId {
    const a = resolvePortRef(w, spec.a);
    if (!a.ok) throw new Error(a.reason);
    const b = resolvePortRef(w, spec.b);
    if (!b.ok) throw new Error(b.reason);
    let id = spec.id;
    if (id !== undefined) {
      if (id === '') throw new Error('A link id must not be empty.');
      if (w.media.links.get(id) !== undefined) throw new Error(`A link with id "${id}" already exists.`);
    } else {
      do id = w.linkIds.next();
      while (w.media.links.get(id) !== undefined);
    }
    const now = w.scheduler.now;
    const media = spec.media ?? 'auto';
    const lengthM = spec.lengthM ?? DEFAULT_LINK_LENGTH_M;
    let kind: LinkKind;
    if (spec.kind !== undefined) kind = spec.kind;
    else if (media !== 'auto') kind = linkKindOf(media);
    else kind = linkKindOf(w.media.links.validate(a.ref, b.ref, media, lengthM).resolvedMedia ?? 'copper-straight');
    const linkSpec: Parameters<LinkModelImpl['add']>[0] = {
      id,
      a: a.ref,
      b: b.ref,
      media,
      lengthM,
      impairments: { ...NO_IMPAIRMENTS, ...(spec.impairments ?? {}) },
      kind,
    };
    if (spec.dceEnd !== undefined) linkSpec.dceEnd = spec.dceEnd;
    if (spec.distanceOverrideM !== undefined) linkSpec.distanceOverrideM = spec.distanceOverrideM;
    w.media.links.add(linkSpec, now);
    // A port without a link is never oper-up, so any end that is up now just came up.
    for (const ref of [a.ref, b.ref]) {
      const dev = w.devices.get(ref.device);
      if (dev?.port(ref.port)?.operUp === true) dev.onPortOper(ref.port, true, now);
    }
    bumpTopology(w, 'link', id, 'add');
    return id;
  }

  function setImpairments(id: LinkId, imp: Partial<Impairments>): void {
    const w = world;
    if (w.media.links.setImpairments(id, imp, w.scheduler.now) === undefined) {
      throw new Error(`No link with id "${id}" exists in this simulation.`);
    }
  }

  /** Build a validated topology into `w` (a world that is not live yet). */
  function populate(w: World, topo: Topology): void {
    for (const d of topo.devices) {
      const spec: AddDeviceSpec = {
        id: d.id,
        type: d.type,
        name: d.name,
        position: { x: d.position.logical[0], y: d.position.logical[1] },
        power: d.power ?? true,
      };
      if (d.config !== undefined) spec.startupConfig = d.config;
      if (d.runningConfig !== undefined) spec.runningConfig = d.runningConfig;
      if (d.modules !== undefined) spec.modules = d.modules;
      if (d.hardware?.macSalt !== undefined) spec.macSalt = d.hardware.macSalt;
      if (d.ui !== undefined) spec.ui = d.ui;
      addDeviceTo(w, spec);
    }
    for (const l of topo.links) {
      const spec: AddLinkSpec = { id: l.id, a: l.a, b: l.b, media: l.media, lengthM: l.length_m ?? DEFAULT_LINK_LENGTH_M };
      if (l.impairments !== undefined) spec.impairments = l.impairments;
      if (l.kind !== undefined) spec.kind = l.kind;
      if (l.dce_end !== undefined) spec.dceEnd = l.dce_end;
      if (l.distance_m !== undefined) spec.distanceOverrideM = l.distance_m;
      addLinkTo(w, spec);
    }
    const retained: RetainedSections = {};
    if (topo.objectives !== undefined) retained.objectives = [...topo.objectives];
    if (topo.notes !== undefined) retained.notes = topo.notes;
    if (topo.lab !== undefined) retained.lab = { name: topo.lab.name, version: topo.lab.version };
    w.retained = retained;
  }

  function loadTopology(t: Topology): void {
    const topo = prepareTopologyLoad(t, catalog);
    // [S1] the new journal's origin holds the document as given and the counters from BEFORE the load (§2.13);
    // nothing inside records.
    const origin = journalOrigin(topo.profile ?? 'P1', structuredClone(t));
    recorder.nested(() => {
      // D2: the world takes the document's profile; a 1.1 document never carries one (io/schema.ts strips it).
      const next = makeWorld(topo.canvas?.metresPerUnit ?? DEFAULT_METRES_PER_UNIT, topo.profile ?? 'P1');
      try {
        populate(next, topo);
      } catch (e) {
        if (e instanceof TopologyLoadError) throw e;
        throw topologyLoadError([{ message: e instanceof Error ? e.message : String(e) }]);
      }
      for (const s of cli.sessions()) cli.close(s.id);
      world = next;
      hub.clear();
      renderCache.clear();
      topologyVersion += 1 + next.pendingVersionBumps;
      next.pendingVersionBumps = 0;
    });
    recorder.reset(origin);
  }

  function exportTopology(): Topology {
    const w = world;
    const devices: TopologyDevice[] = [];
    for (const dev of w.devices.values()) {
      const d: TopologyDevice = {
        id: dev.id,
        type: dev.spec.type,
        name: dev.spec.name,
        position: { logical: [dev.spec.position.x, dev.spec.position.y] },
        power: dev.power,
      };
      // A booted device's NVRAM is authoritative (erase leaves it undefined → no config written);
      // an off/booting device has not diverged from its spec, so fall back to the spec text.
      const startup = dev.bootedAt !== undefined ? dev.startup?.render() : (dev.startup?.render() ?? dev.spec.startupConfig);
      if (startup !== undefined) d.config = startup;
      if (dev.bootedAt !== undefined) d.runningConfig = dev.running.render();
      if ((dev.model.slots ?? []).length > 0) {
        const installed: ModuleInstall[] = [];
        for (const [slot, module] of dev.modules) installed.push({ slot, module });
        d.modules = installed;
      }
      const salt = dev.spec.macSalt ?? 0;
      if (salt > 0) d.hardware = { macSalt: salt };
      if (dev.spec.ui !== undefined) d.ui = JSON.parse(JSON.stringify(dev.spec.ui)) as TopologyDeviceUi;
      devices.push(d);
    }
    const links: TopologyLink[] = [];
    for (const l of w.media.links.list()) {
      const out: TopologyLink = {
        id: l.id,
        a: { device: l.a.device, port: l.a.port },
        b: { device: l.b.device, port: l.b.port },
        media: l.media,
        length_m: l.lengthM,
      };
      const imp = nonDefaultImpairments(l.impairments);
      if (imp !== undefined) out.impairments = imp;
      if (l.kind === 'radio') out.kind = 'radio';
      if (l.dceEnd !== undefined) out.dce_end = l.dceEnd;
      if (l.distanceOverrideM !== undefined) out.distance_m = l.distanceOverrideM;
      links.push(out);
    }
    const topo: Topology = { schema: TOPOLOGY_SCHEMA_ID, seed, devices, links };
    if (w.retained.objectives !== undefined) topo.objectives = [...w.retained.objectives];
    if (w.retained.notes !== undefined) topo.notes = w.retained.notes;
    if (w.metresPerUnit !== DEFAULT_METRES_PER_UNIT) topo.canvas = { metresPerUnit: w.metresPerUnit };
    if (w.retained.lab !== undefined) topo.lab = { ...w.retained.lab };
    // P2 (D2, §2.9): `profile` only for a P2 world, and then the schema that can express it (1.2), in the same step.
    if (w.profile === 'P2') {
      topo.profile = 'P2';
      topo.schema = schemaIdFor(topo);
    }
    return topo;
  }

  // ── configuration and hardware ────────────────────────────────────────────

  const configureEnv: ConfigureEnv = {
    device: (id) => world.devices.get(id),
    cli,
    now: () => world.scheduler.now,
    syncClock,
    invalidate: (id) => renderCache.invalidate(id),
    removeLink: (id) => removeLinkIn(world, id),
    moduleChanged: (id, op) => bumpTopology(world, 'module', id, op),
  };

  // ── faults ────────────────────────────────────────────────────────────────

  function followUp(fault: FaultSpec, at: SimTime, params: Record<string, unknown>): void {
    world.scheduler.schedule(at, { kind: 'fault', fault: { ...fault, params: { ...(fault.params ?? {}), ...params } } });
  }

  function faultLink(w: World, fault: FaultSpec): LinkId | undefined {
    const target = fault.target;
    if (target.link !== undefined) return w.media.links.get(target.link) === undefined ? undefined : target.link;
    if (target.device === undefined || target.port === undefined) return undefined;
    const r = resolvePortRef(w, { device: target.device, port: target.port });
    if (!r.ok) return undefined;
    return w.devices.get(r.ref.device)?.port(r.ref.port)?.link ?? w.media.links.linkOf(r.ref)?.id;
  }

  function handleFault(fault: FaultSpec, now: SimTime): void {
    const w = world;
    const params = fault.params;
    const restore = params?.['restore'] === true;
    const duration = numParam(params, 'durationNs');
    switch (fault.kind) {
      case 'cable-cut': {
        const id = faultLink(w, fault);
        if (id === undefined) return;
        w.media.fanOut(w.media.links.cut(id, !restore, now), now);
        if (!restore && duration !== undefined && duration >= 0) followUp(fault, now + Math.round(duration), { restore: true });
        return;
      }
      case 'port-flap': {
        const { device, port } = fault.target;
        if (device === undefined || port === undefined) return;
        const dev = w.devices.get(device);
        if (dev === undefined) return;
        const r = resolvePortRef(w, { device, port });
        if (!r.ok) return;
        const state = dev.port(r.ref.port);
        if (state === undefined) return;
        const remaining = numParam(params, 'remaining') ?? numParam(params, 'count') ?? DEFAULT_FLAP_COUNT;
        if (remaining <= 0) return;
        dev.setPortAdmin(r.ref.port, !state.adminUp, now);
        if (remaining > 1) {
          const period = Math.max(0, Math.round(numParam(params, 'periodNs') ?? DEFAULT_FLAP_PERIOD_NS));
          followUp(fault, now + period, { remaining: remaining - 1 });
        }
        return;
      }
      case 'power-loss': {
        const device = fault.target.device;
        const dev = device === undefined ? undefined : w.devices.get(device);
        if (dev === undefined) return;
        dev.setPower(restore, now);
        if (!restore && duration !== undefined && duration >= 0) followUp(fault, now + Math.round(duration), { restore: true });
        return;
      }
      case 'link-impairment': {
        const id = faultLink(w, fault);
        if (id === undefined) return;
        const before = w.media.links.get(id)?.impairments;
        const imp = impairmentsFrom(params?.['impairments'] ?? params);
        w.media.links.setImpairments(id, imp, now);
        if (!restore && duration !== undefined && duration >= 0 && before !== undefined) {
          followUp(fault, now + Math.round(duration), { restore: true, impairments: { ...before } });
        }
        return;
      }
      case 'config-fragment': {
        const device = fault.target.device;
        const dev = device === undefined ? undefined : w.devices.get(device);
        if (device === undefined || dev === undefined || dev.bootedAt === undefined) return;
        const commands = configFragmentCommands(params);
        if (commands !== undefined) configureDevice(configureEnv, device, commands, CONFIG_FRAGMENT_OPTIONS);
        return;
      }
      case 'err-disable': {
        // P2 §3.8 step 7: the same effects as an `errDisable` action, through the runtime's fault path.
        const { device, port } = fault.target;
        if (device === undefined || port === undefined) return;
        const dev = w.devices.get(device);
        if (dev === undefined) return;
        const r = resolvePortRef(w, { device, port });
        if (!r.ok) return;
        const cause = params?.['cause'];
        dev.errDisablePort(r.ref.port, isErrDisableCause(cause) ? cause : DEFAULT_ERR_DISABLE_CAUSE, now);
        return;
      }
      default:
        return;
    }
  }

  // ── P1: GUI app requests (§4.4 step 0) ────────────────────────────────────

  /** Resolve a port name (long or short) against a live device; throws with an original explanation. */
  function checkedPort(dev: DeviceRuntime, port: PortId): PortId {
    // hostRequest is an untyped runtime boundary (the worker forwards the UI's message as it arrives), so the
    // payload is checked here rather than letting a missing field surface as a TypeError from a daemon.
    if (typeof port !== 'string' || port.trim() === '') throw new Error(`${dev.spec.name} needs the name of the interface to use.`);
    const r = resolvePortRef(world, { device: dev.id, port });
    if (!r.ok) throw new Error(r.reason);
    return r.ref.port;
  }

  /** The port a Wi-Fi scan runs on: the one asked for, else this device's first wireless interface. */
  function scanPort(dev: DeviceRuntime, port: PortId | undefined): PortId {
    if (port !== undefined && port !== null) return checkedPort(dev, port);
    for (const p of dev.ports.values()) if (p.spec.kind === 'wlan') return p.id;
    throw new Error(`${dev.spec.name} has no wireless interface to scan with.`);
  }

  /**
   * Map a GUI app action onto the daemon that performs it (HOST_APP_PROCESS) and apply it as a ProcessRequest at
   * the synced device clock. The ticket id `r_<n>` is the http-client tab token (§4.4 step 0); the counter is never
   * the rng, so two runs of the same script hand out the same ids.
   */
  function hostRequest(device: DeviceId, req: HostAppRequest): HostAppTicket {
    const dev = requireDevice(device);
    const app = req.app;
    const process: ProcessName | undefined = Object.prototype.hasOwnProperty.call(HOST_APP_PROCESS, app) ? HOST_APP_PROCESS[app] : undefined;
    if (process === undefined) throw new Error(`"${String(app)}" is not an application request this simulation can run.`);
    if (!dev.processes.has(process)) {
      throw new Error(`${dev.spec.name} is not running its ${process} service, so it cannot handle a ${app} request.`);
    }
    const token = `r_${requestCounter + 1}`;
    let body: ProcessRequest;
    switch (req.app) {
      case 'http.get':
        if (typeof req.url !== 'string' || req.url.trim() === '') throw new Error('A page request needs a web address.');
        body = { kind: 'http.fetch', owner: 'gui', token, url: req.url };
        break;
      case 'wifi.scan':
        body = { kind: 'wlan.scan', port: scanPort(dev, req.port) };
        break;
      default:
        body = { kind: 'dhcp.client', iface: checkedPort(dev, req.port), op: req.app === 'dhcp.renew' ? 'renew' : 'release' };
        break;
    }
    requestCounter++;
    syncClock(dev);
    const action: Action = { type: 'request', to: process, req: body };
    dev.applyActions(SIM_PROCESS_NAME, [action], world.scheduler.now);
    return { requestId: token, process };
  }

  // ── P1: captures (§4.12; the hub is the link model's tap) ─────────────────

  /** What `resolveCapturePoints` needs to know about the live world. */
  const captureResolver: CapturePointResolver = {
    allPorts(): readonly PortRef[] {
      const out: PortRef[] = [];
      for (const id of world.deviceOrder) {
        const dev = world.devices.get(id);
        if (dev === undefined) continue;
        for (const port of dev.ports.keys()) out.push({ device: id, port });
      }
      return out;
    },
    linkPorts(id: string): readonly PortRef[] | undefined {
      const w = world;
      const link = w.media.links.get(id);
      if (link !== undefined) return [link.a, link.b];
      const media = w.media.links.media(w.scheduler.now);
      const segment = media.segments.find((s) => s.id === id);
      if (segment !== undefined) return segment.members.map((m) => m.port);
      const stations = media.associations.filter((a) => a.medium === id).map((a) => a.station);
      const bss = media.bss.find((b) => b.id === id);
      if (bss !== undefined) return [bss.ap, ...stations];
      const cell = media.cells.find((c) => c.id === id);
      if (cell !== undefined) return [cell.tower, ...stations];
      return undefined;
    },
    portName(ref: PortRef): string | undefined {
      const dev = world.devices.get(ref.device);
      const port = dev?.port(ref.port);
      return dev === undefined || port === undefined ? undefined : `${dev.spec.name} ${port.spec.short}`;
    },
    encap(ref: PortRef): PortEncap | undefined {
      return world.devices.get(ref.device)?.port(ref.port)?.encap;
    },
  };

  function requireCapture(id: CaptureId): CaptureStoreImpl {
    const store = hub.get(id);
    if (store === undefined) throw new Error(`There is no capture "${id}" in this simulation.`);
    return store;
  }

  // ── run loop ──────────────────────────────────────────────────────────────

  function dispatch(ev: SimEvent): void {
    const w = world;
    if (w.media.dispatch(ev)) return;
    const at = ev.at;
    switch (ev.kind) {
      case 'timer':
        w.devices.get(ev.device)?.onTimer(ev.process, ev.key, at);
        return;
      case 'boot':
        w.devices.get(ev.device)?.onBoot(at);
        return;
      case 'linkState':
        w.media.fanOut(w.media.links.cut(ev.link, !ev.up, at), at);
        return;
      case 'userCommand':
        cli.exec(ev.session, ev.line);
        return;
      case 'fault':
        handleFault(ev.fault, at);
        return;
      default:
        return;
    }
  }

  /** Add a synchronous trace listener (called after the ring stored the event); returns the unsubscribe function. */
  function addListener(cb: (ev: TraceEvent) => void): () => void {
    listeners.push(cb);
    return () => {
      const i = listeners.indexOf(cb);
      if (i >= 0) listeners.splice(i, 1);
    };
  }

  const run = createRunControl({ scheduler: () => world.scheduler, dispatch, trace: ring, tap: addListener });

  // ── the facade ────────────────────────────────────────────────────────────

  const sim: Simulation = {
    get seed(): number {
      return seed;
    },
    get now(): SimTime {
      return world.scheduler.now;
    },
    get mode(): FidelityMode {
      return mode;
    },
    get cli(): CliRuntime {
      return cli;
    },
    get catalog(): DeviceCatalog {
      return catalog;
    },
    get profile(): DefaultsProfile {
      return world.profile;
    },
    // [S1] ── position and journal (structured-clone copies; sim/journal.ts) ──
    position,
    journal: (): SimJournal => recorder.journal(),
    // [S1] ── end ──
    device: (id) => world.devices.get(id),
    devices: () => Array.from(world.devices.values()),

    loadTopology,
    exportTopology,
    addDevice: (spec) => apply({ op: 'addDevice', spec }, () => addDeviceTo(world, spec)),
    removeDevice: (id) => apply({ op: 'removeDevice', id }, () => removeDevice(id)),
    renameDevice: (id: DeviceId, name: string): void =>
      apply({ op: 'renameDevice', id, name }, () => {
        const dev = requireDevice(id);
        const clean = name.trim();
        if (clean === '' || /\s/.test(clean)) throw new Error('A device name must be a single word.');
        dev.spec.name = clean;
        syncClock(dev);
        const r = dev.applyConfigLine([], ['hostname', clean], false);
        renderCache.invalidate(id);
        if (!r.ok) throw new Error(r.error ?? 'The new name was rejected.');
      }),
    moveDevice: (id: DeviceId, to: { x: number; y: number }): void =>
      apply({ op: 'moveDevice', id, position: to }, () => {
        const dev = requireDevice(id);
        const w = world;
        dev.spec.position = roundPosition(to);
        sink.emit({ t: w.scheduler.now, kind: 'topologyChanged', what: 'device', id, op: 'move' });
        w.media.scheduleMove(id, w.scheduler.now);
      }),
    setPower: (id: DeviceId, on: boolean): void =>
      apply({ op: 'setPower', id, on }, () => {
        requireDevice(id).setPower(on, world.scheduler.now);
      }),
    validateLink(spec: AddLinkSpec): CableValidation {
      const w = world;
      const a = resolvePortRef(w, spec.a);
      if (!a.ok) return { ok: false, reason: a.reason };
      const b = resolvePortRef(w, spec.b);
      if (!b.ok) return { ok: false, reason: b.reason };
      return w.media.links.validate(a.ref, b.ref, spec.media ?? 'auto', spec.lengthM ?? DEFAULT_LINK_LENGTH_M);
    },
    addLink: (spec) => apply({ op: 'addLink', spec }, () => addLinkTo(world, spec)),
    removeLink: (id) => apply({ op: 'removeLink', id }, () => removeLinkIn(world, id)),
    setImpairments: (id, imp) => apply({ op: 'setImpairments', id, imp }, () => setImpairments(id, imp)),
    link: (id: LinkId): LinkState | undefined => world.media.links.get(id),
    injectFault: (at: SimTime, fault: FaultSpec): void =>
      apply({ op: 'injectFault', at, fault }, () => {
        assertSimTime(at, 'injectFault(at)');
        world.scheduler.schedule(at, { kind: 'fault', fault });
      }),

    // time: never journaled (a replay reaches positions by event count), but nested so no dispatch records
    runUntil: (t: SimTime, options?: RunOptions) => recorder.nested(() => run.runUntil(t, options)),
    runFor: (dt: SimTime, options?: RunOptions) => recorder.nested(() => run.runFor(dt, options)),
    step: () => recorder.nested(() => run.step()),
    runToIdle: (maxEvents: number = DEFAULT_MAX_IDLE_EVENTS): RunStats => recorder.nested(() => run.runToIdle(maxEvents)),
    nextEventTime: () => run.nextEventTime(),
    stepToNext: (filter, options) => recorder.nested(() => run.stepToNext(filter, options)),

    snapshot(options?: SnapshotOptions): SimSnapshot {
      const w = world;
      const input: Parameters<typeof buildSimSnapshot>[0] = {
        now: w.scheduler.now,
        seed,
        topologyVersion,
        devices: w.devices.values(),
        links: w.media.links,
        cache: renderCache,
        sessions: cli.sessions(),
        pduCount: w.pdus.created,
        pendingEvents: w.scheduler.size,
        profile: w.profile,
      };
      return buildSimSnapshot(options?.devices === undefined ? input : { ...input, subset: options.devices });
    },
    pdu: (id: PduId): PduView | undefined => world.registry.get(id),
    trace: (cursor: number) => ring.since(cursor),
    onTrace: addListener,
    traceQuery: (q) => run.traceQuery(q),

    configure: (device: DeviceId, commands: readonly string[], options?: ConfigureOptions): ConfigureResult =>
      apply(options === undefined ? { op: 'configure', device, commands } : { op: 'configure', device, commands, opts: options }, () =>
        configureDevice(configureEnv, device, commands, options),
      ),
    insertModule: (device: DeviceId, slot: SlotId, module: ModuleType): HardwareResult =>
      apply({ op: 'insertModule', device, slot, module }, () => insertModuleOp(configureEnv, device, slot, module)),
    removeModule: (device: DeviceId, slot: SlotId): HardwareResult =>
      apply({ op: 'removeModule', device, slot }, () => removeModuleOp(configureEnv, device, slot)),
    setDeviceUi: (device: DeviceId, ui: TopologyDeviceUi): void =>
      apply({ op: 'setDeviceUi', device, ui }, () => {
        requireDevice(device).spec.ui = checkedUi(ui);
      }),
    setCanvasScale: (metresPerUnit: number): void =>
      apply({ op: 'setCanvasScale', metresPerUnit }, () => {
        if (typeof metresPerUnit !== 'number' || !Number.isFinite(metresPerUnit) || metresPerUnit <= 0 || metresPerUnit > MAX_METRES_PER_UNIT) {
          throw new RangeError(`metresPerUnit must be greater than 0 and at most ${MAX_METRES_PER_UNIT}, got ${metresPerUnit}`);
        }
        const w = world;
        w.metresPerUnit = metresPerUnit;
        w.media.setScale(metresPerUnit, w.scheduler.now);
      }),
    hostRequest: (device, req) => apply({ op: 'hostRequest', device, req }, () => hostRequest(device, req)),

    startCapture: (spec: CaptureSpec): CaptureId => hub.start(spec, resolveCapturePoints(spec, captureResolver)).id,
    stopCapture(id: CaptureId): void {
      if (!hub.stop(id)) throw new Error(`There is no capture "${id}" in this simulation.`);
    },
    removeCapture(id: CaptureId): void {
      if (!hub.remove(id)) throw new Error(`There is no capture "${id}" in this simulation.`);
    },
    captures: (): CaptureInfo[] => hub.list(),
    queryCapture: (id: CaptureId, q: CaptureQuery): CaptureQueryResult => requireCapture(id).query(q),
    captureRecord: (id: CaptureId, index: number): CaptureRecordDetail | undefined => requireCapture(id).record(index),
    followStream: (id: CaptureId, key: string): FollowStreamResult => requireCapture(id).follow(key),
    captureStats: (id: CaptureId, filter?: string): CaptureStatistics => requireCapture(id).stats(filter),
    exportCapture: (id: CaptureId, opts: CaptureExportOptions): Uint8Array => requireCapture(id).export(opts),
  };

  return sim;
}
