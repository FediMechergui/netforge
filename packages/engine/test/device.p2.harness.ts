/**
 * Shared helper of the W1 device P2 tests (device.l2-actions, device.profile, device.pipeline.hsrp): a device runtime
 * over HAND-BUILT models (a plain `DeviceCatalog`, no catalog validation, so a model may list daemons whose factories
 * are fakes, e.g. the L2 control daemons that no catalog model runs before the W4 flip), with the same recording fake
 * dependencies as `device.harness.ts`. Not a test file itself.
 */
import { createDevice } from '../src/device/device.js';
import { resolvePortName } from '../src/device/catalog/names.js';
import { createRng } from '../src/core/prng.js';
import { createScheduler } from '../src/core/scheduler.js';
import { createTable } from '../src/core/table.js';
import { createPduFactory } from '../src/pdu/factory.js';
import type { DefaultsProfile } from '../src/contracts/catalog.js';
import type { DeviceCatalog, DeviceModel, DeviceRuntime, DeviceSpec } from '../src/contracts/device.js';
import type { PortRef, ProcessName } from '../src/contracts/ids.js';
import type { Pdu } from '../src/contracts/pdu.js';
import type { Process } from '../src/contracts/process.js';
import type { SimTime } from '../src/contracts/time.js';
import type { TraceEvent } from '../src/contracts/trace.js';

/** A catalog of exactly `models` and `processes` (no validation, no modules). */
export function handCatalog(models: readonly DeviceModel[], processes: Record<ProcessName, () => Process>): DeviceCatalog {
  return {
    get: (type) => models.find((m) => m.type === type),
    list: () => models,
    process: (name) => processes[name],
    module: () => undefined,
    modules: () => [],
    resolvePort: (source, name) => resolvePortName(source, name),
  };
}

export interface P2Harness {
  readonly device: DeviceRuntime;
  readonly events: TraceEvent[];
  readonly adminCalls: { ref: PortRef; adminUp: boolean; now: SimTime }[];
  /** @since W2 Every `deps.transmit` call (the port a frame left on, and the frame as handed over). */
  readonly transmits: { from: PortRef; pdu: Pdu; now: SimTime }[];
  readonly scheduler: ReturnType<typeof createScheduler>;
  readonly pdus: ReturnType<typeof createPduFactory>;
  kinds<K extends TraceEvent['kind']>(kind: K): Extract<TraceEvent, { kind: K }>[];
  /** Dispatch boot/timer events up to `until` (default: everything). */
  run(until?: SimTime): void;
}

export interface P2HarnessOptions {
  readonly model: DeviceModel;
  readonly processes?: Record<ProcessName, () => Process>;
  readonly profile?: DefaultsProfile;
  readonly startupConfig?: string;
  /** @since W2 `DeviceSpec.runningConfig`: a saved running configuration consumed by the first boot. */
  readonly runningConfig?: string;
  readonly name?: string;
}

/** Build a powered device of `opts.model` (boot pending; call `run()` to boot it). */
export function p2Harness(opts: P2HarnessOptions): P2Harness {
  const events: TraceEvent[] = [];
  const adminCalls: P2Harness['adminCalls'] = [];
  const transmits: P2Harness['transmits'] = [];
  const scheduler = createScheduler();
  const pdus = createPduFactory();
  const spec: DeviceSpec = {
    id: 'd_1',
    type: opts.model.type,
    name: opts.name ?? 'SW1',
    position: { x: 0, y: 0 },
    power: true,
    modules: [],
    macSalt: 0,
    ...(opts.startupConfig !== undefined ? { startupConfig: opts.startupConfig } : {}),
    ...(opts.runningConfig !== undefined ? { runningConfig: opts.runningConfig } : {}),
    ...(opts.profile !== undefined ? { profile: opts.profile } : {}),
  };
  const device = createDevice(
    spec,
    {
      scheduler,
      trace: { emit: (ev) => events.push(ev) },
      rng: createRng(42).split(`device:${spec.id}`),
      pdus,
      catalog: handCatalog([opts.model], opts.processes ?? {}),
      tables: createTable,
      transmit: (from, pdu, now) => {
        transmits.push({ from, pdu, now });
        return { ok: true, link: 'l_1', txStart: now, txEnd: now + 1000, arrive: now + 2000 };
      },
      onPortAdmin: (ref, adminUp, now) => adminCalls.push({ ref, adminUp, now }),
      onPortPhyConfig: () => undefined,
      mediumOp: () => undefined,
      airView: () => ({ visibleBss: () => [], link: () => undefined }),
      cliSink: { output: () => undefined, done: () => undefined },
    },
    0,
  );
  return {
    device,
    events,
    adminCalls,
    transmits,
    scheduler,
    pdus,
    kinds<K extends TraceEvent['kind']>(kind: K): Extract<TraceEvent, { kind: K }>[] {
      return events.filter((e): e is Extract<TraceEvent, { kind: K }> => e.kind === kind);
    },
    run(until = Number.MAX_SAFE_INTEGER): void {
      for (;;) {
        const t = scheduler.peekTime();
        if (t === undefined || t > until) return;
        const ev = scheduler.next();
        if (ev === undefined) return;
        if (ev.kind === 'boot') device.onBoot(ev.at);
        else if (ev.kind === 'timer') device.onTimer(ev.process, ev.key, ev.at);
      }
    },
  };
}
