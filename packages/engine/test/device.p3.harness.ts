/**
 * Shared harness of the P3 device runtime tests (ARCHITECTURE-P3 §7 W1 device and catalog): a device built on ANY
 * `DeviceCatalog` (the real one, a stage catalog of `test/staged.world.ts`, or a hand-made list of models), with the
 * fake dependencies of `test/device.harness.ts`, a real scheduler, and a run loop that dispatches `boot` and `timer`
 * events to the device and keeps every other popped event (the P3 `deviceConfigure` and `remoteCli` events, which the
 * Simulation dispatches) in `other`. Plus a small scriptable daemon with `onEvent` and `onEgress`. Not a test file.
 */
import { ALL_MODULES } from '../src/device/catalog.js';
import { resolvePortName } from '../src/device/catalog/names.js';
import { createDevice } from '../src/device/device.js';
import { createRng } from '../src/core/prng.js';
import { createScheduler } from '../src/core/scheduler.js';
import { createTable } from '../src/core/table.js';
import { createPduFactory } from '../src/pdu/factory.js';
import type { DefaultsProfile } from '../src/contracts/catalog.js';
import type { DeviceCatalog, DeviceModel, DeviceRuntime, DeviceSpec, PortNameSource } from '../src/contracts/device.js';
import type { SimEvent } from '../src/contracts/events.js';
import type { PortId, PortRef, ProcessName, SessionId } from '../src/contracts/ids.js';
import type { Pdu } from '../src/contracts/pdu.js';
import type { Action, DebugEvent, Process, ProcessCtx, ProcessFactory, ProcessRequest, StateView } from '../src/contracts/process.js';
import type { SimTime } from '../src/contracts/time.js';
import type { TraceEvent } from '../src/contracts/trace.js';
import type { ProcessEvent } from '../src/contracts/transport.js';

/** A catalog over `models` (looked up by type) whose daemon factories are `factories`; the real module list. */
export function modelCatalog(models: readonly DeviceModel[], factories: Readonly<Record<ProcessName, ProcessFactory>> = {}): DeviceCatalog {
  const byType = new Map(models.map((m) => [m.type, m] as const));
  const moduleByType = new Map(ALL_MODULES.map((m) => [m.type, m] as const));
  return {
    get: (type) => byType.get(type),
    list: () => models,
    process: (name) => factories[name],
    module: (type) => moduleByType.get(type),
    modules: () => ALL_MODULES,
    resolvePort: (source: PortNameSource, name: string) => resolvePortName(source, name),
  };
}

export interface P3Harness {
  readonly device: DeviceRuntime;
  readonly events: TraceEvent[];
  readonly scheduler: ReturnType<typeof createScheduler>;
  readonly pdus: ReturnType<typeof createPduFactory>;
  readonly transmits: { from: PortRef; pdu: Pdu; now: SimTime }[];
  readonly cli: { output: { session: SessionId; text: string }[]; done: SessionId[] };
  /** Popped events other than `boot` and `timer` (the Simulation's to dispatch). */
  readonly other: SimEvent[];
  kinds<K extends TraceEvent['kind']>(kind: K): Extract<TraceEvent, { kind: K }>[];
  /** Pop events up to `until` (default: all), dispatching `boot` / `timer` to the device; returns the number popped. */
  run(until?: SimTime): number;
}

export interface P3HarnessOptions {
  readonly catalog: DeviceCatalog;
  readonly type: string;
  readonly id?: string;
  readonly name?: string;
  readonly power?: boolean;
  readonly profile?: DefaultsProfile;
  readonly startupConfig?: string;
  readonly now?: SimTime;
}

/** A device of `type` from `catalog` with fake dependencies (transmit always ok, no radio, no medium). */
export function p3Harness(opts: P3HarnessOptions): P3Harness {
  const events: TraceEvent[] = [];
  const scheduler = createScheduler();
  const pdus = createPduFactory();
  const transmits: P3Harness['transmits'] = [];
  const cli: P3Harness['cli'] = { output: [], done: [] };
  const other: SimEvent[] = [];
  const spec: DeviceSpec = {
    id: opts.id ?? 'd_1',
    type: opts.type,
    name: opts.name ?? 'R1',
    position: { x: 0, y: 0 },
    power: opts.power ?? true,
    ...(opts.startupConfig !== undefined ? { startupConfig: opts.startupConfig } : {}),
    ...(opts.profile !== undefined ? { profile: opts.profile } : {}),
    modules: [],
    macSalt: 0,
  };
  const device = createDevice(
    spec,
    {
      scheduler,
      trace: { emit: (ev) => events.push(ev) },
      rng: createRng(42).split(`device:${spec.id}`),
      pdus,
      catalog: opts.catalog,
      tables: createTable,
      transmit: (from, pdu, now) => {
        transmits.push({ from, pdu, now });
        return { ok: true, link: 'l_1', txStart: now, txEnd: now + 1000, arrive: now + 2000 };
      },
      onPortAdmin: () => undefined,
      onPortPhyConfig: () => undefined,
      mediumOp: () => undefined,
      airView: () => ({ visibleBss: () => [], link: () => undefined }),
      cliSink: {
        output: (session, text) => cli.output.push({ session, text }),
        done: (session) => cli.done.push(session),
      },
    },
    opts.now ?? 0,
  );
  return {
    device,
    events,
    scheduler,
    pdus,
    transmits,
    cli,
    other,
    kinds<K extends TraceEvent['kind']>(kind: K) {
      return events.filter((e): e is Extract<TraceEvent, { kind: K }> => e.kind === kind);
    },
    run(until = Number.MAX_SAFE_INTEGER) {
      let n = 0;
      for (;;) {
        const t = scheduler.peekTime();
        if (t === undefined || t > until) break;
        const ev = scheduler.next();
        if (ev === undefined) break;
        n++;
        if (ev.kind === 'boot') device.onBoot(ev.at);
        else if (ev.kind === 'timer') device.onTimer(ev.process, ev.key, ev.at);
        else other.push(ev);
      }
      return n;
    },
  };
}

/** Boot a powered device: dispatch its pending `boot` event (and nothing later). */
export function bootP3(h: P3Harness): SimTime {
  const t = h.scheduler.peekTime();
  if (t === undefined) throw new Error('nothing to boot');
  h.run(t);
  return t;
}

/** What a stub daemon records and returns. */
export interface StubScript {
  onEvent?: (ctx: ProcessCtx, ev: ProcessEvent) => Action[];
  onEgress?: (ctx: ProcessCtx, pdu: Pdu, port: PortId) => Action[];
  onRequest?: (ctx: ProcessCtx, req: ProcessRequest) => Action[];
  onLinkChange?: (ctx: ProcessCtx, port: PortId, up: boolean) => Action[];
}

/** A scriptable stub daemon: records its ctx, events, egress and link changes; `factory` hands out this one object. */
export interface StubDaemon extends Process {
  ctx?: ProcessCtx;
  readonly received: ProcessEvent[];
  readonly egress: { pdu: Pdu; port: PortId }[];
  readonly links: { port: PortId; up: boolean; at: SimTime }[];
  readonly factory: ProcessFactory;
}

export function stubDaemon(name: ProcessName, script: StubScript = {}): StubDaemon {
  const stub: StubDaemon = {
    name,
    received: [],
    egress: [],
    links: [],
    factory: () => stub,
    init(ctx) {
      stub.ctx = ctx;
      return [];
    },
    onPdu(ctx) {
      stub.ctx = ctx;
      return [];
    },
    onTimer(ctx) {
      stub.ctx = ctx;
      return [];
    },
    onConfig(ctx) {
      stub.ctx = ctx;
      return [];
    },
    onLinkChange(ctx, port, up) {
      stub.ctx = ctx;
      stub.links.push({ port, up, at: ctx.now });
      return script.onLinkChange ? script.onLinkChange(ctx, port, up) : [];
    },
    onRequest(ctx, req) {
      stub.ctx = ctx;
      return script.onRequest ? script.onRequest(ctx, req) : [];
    },
    onEvent(ctx, ev) {
      stub.ctx = ctx;
      stub.received.push(ev);
      return script.onEvent ? script.onEvent(ctx, ev) : [];
    },
    onEgress(ctx, pdu, port) {
      stub.ctx = ctx;
      stub.egress.push({ pdu, port });
      return script.onEgress ? script.onEgress(ctx, pdu, port) : [];
    },
    stateSnapshot(): StateView {
      return { process: name, state: {} };
    },
    debugEvents(): readonly DebugEvent[] {
      return [];
    },
  };
  return stub;
}
