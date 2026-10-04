/**
 * "Run to idle" warns only when the run stopped at its event cap (ARCHITECTURE-P3 §9.2 ruling R31; W3 web-shell).
 *
 * The warning "Stopped after 200 000 events; the queue is still busy." used to follow `pendingEvents > 0`, but a world
 * that reached idle keeps its periodic maintenance timers pending (D10), so any world with a router warned after a
 * normal run. The worker now says when the cap stopped the run (`RunToIdleSnapshot.runStopped`, from
 * `RunStats.stopped`), and the button warns on that alone.
 *
 * Under test, both cases twice: the real worker over a real world (idle with timers pending → no `runStopped`; a run
 * cut by a small cap → `runStopped: 'maxEvents'`, the posted batch's snapshot untouched; ruling R40, the engine half:
 * a run that reaches idle on exactly its last allowed event is not capped, one event short is), and the button's
 * handler over a mocked bridge (no toast after an idle run with pending events; exactly one warning after a capped run).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RunStats, SimSnapshot, Simulation, SimulationOptions } from '@netforge/engine';
import type { EngineApi, EngineBatch, RunToIdleSnapshot } from '../src/bridge/protocol';

/** The stats of the engine's last `runToIdle` inside the worker (ruling R40's boundary case reads them). */
const engineRuns = vi.hoisted(() => ({ last: undefined as RunStats | undefined }));
vi.mock('@netforge/engine', async (importOriginal) => {
  const m = await importOriginal<typeof import('@netforge/engine')>();
  return {
    ...m,
    createSimulation: (opts: SimulationOptions): Simulation => {
      const sim = m.createSimulation(opts);
      const run = sim.runToIdle.bind(sim);
      sim.runToIdle = (maxEvents?: number): RunStats => {
        const stats = run(maxEvents);
        engineRuns.last = stats;
        return stats;
      };
      return sim;
    },
  };
});

const bridge = vi.hoisted(() => ({ runToIdle: vi.fn() }));
const ui = vi.hoisted(() => ({ ready: true, toast: vi.fn() }));
let exposed: EngineApi | undefined;

vi.mock('comlink', () => ({
  expose: (api: EngineApi) => {
    exposed = api;
  },
  proxy: <T>(x: T) => x,
  transfer: <T>(x: T) => x,
}));
vi.mock('../src/bridge/client', () => ({ engine: bridge, fmtSimTime: (t: number) => String(t) }));
vi.mock('../src/store/store', () => {
  const useStore = Object.assign((selector: (s: typeof ui) => unknown) => selector(ui), {
    getState: () => ui,
    setState: (patch: Partial<typeof ui>) => Object.assign(ui, patch),
    subscribe: () => () => undefined,
  });
  return { useStore, store: useStore };
});

import { RUN_TO_IDLE_CAP_WARNING, RUN_TO_IDLE_MAX_EVENTS, runToIdle } from '../src/app/PlaybackControls';

const WORKER = '../src/bridge/worker/index.ts';

describe('the worker says when the cap stopped the run', () => {
  let api: EngineApi;
  const batches: EngineBatch[] = [];

  beforeAll(async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'performance'] });
    await import(WORKER);
    if (exposed === undefined) throw new Error('the worker module did not expose its API');
    api = exposed;
    await api.subscribe((b) => {
      batches.push(b);
    });
    await api.init({ seed: 7 });
  });
  afterAll(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('an idle run leaves the periodic maintenance timers pending, and is not a stop at the cap', async () => {
    await api.loadScenario('pc-router-pc');
    const idle: RunToIdleSnapshot = await api.runToIdle(RUN_TO_IDLE_MAX_EVENTS);
    expect(idle.pendingEvents).toBeGreaterThan(0);
    expect(idle.runStopped).toBeUndefined();
    expect(Object.keys(idle)).not.toContain('runStopped');
  });

  it('a run cut by its cap says so; the snapshot it posted is untouched', async () => {
    await api.loadScenario('pc-router-pc');
    batches.length = 0;
    const capped = await api.runToIdle(5);
    expect(capped.runStopped).toBe('maxEvents');
    expect(capped.pendingEvents).toBeGreaterThan(0);
    const posted = batches[batches.length - 1]?.snapshot as (SimSnapshot & { runStopped?: unknown }) | undefined;
    expect(posted).toBeDefined();
    expect(posted?.runStopped).toBeUndefined();
    const { runStopped, ...rest } = capped;
    expect(runStopped).toBe('maxEvents');
    expect(rest).toEqual(posted);
  });

  it('ruling R40: a run that reaches idle on exactly its last allowed event is not capped; one event short is', async () => {
    const capped = async (n: number): Promise<boolean> => {
      await api.loadScenario('pc-router-pc');
      return (await api.runToIdle(n)).runStopped === 'maxEvents';
    };
    // the smallest cap that reaches idle: every smaller cap stops with work pending (monotone in the cap)
    let lo = 1;
    let hi = 64;
    expect(await capped(lo)).toBe(true);
    while (await capped(hi)) {
      lo = hi;
      hi *= 2;
    }
    while (hi - lo > 1) {
      const mid = Math.floor((lo + hi) / 2);
      if (await capped(mid)) lo = mid;
      else hi = mid;
    }
    // at the boundary the engine reached idle on exactly its last allowed event, and the worker does not warn
    expect(await capped(hi)).toBe(false);
    expect(engineRuns.last).toMatchObject({ events: hi });
    expect(engineRuns.last?.stopped).toBeUndefined();
    // one event short, the engine stopped at its cap with work pending, and the worker says so
    expect(await capped(hi - 1)).toBe(true);
    expect(engineRuns.last).toMatchObject({ events: hi - 1, stopped: 'maxEvents' });
  });
});

describe('the Run to idle button', () => {
  const snap = (extra: Partial<RunToIdleSnapshot>): RunToIdleSnapshot => ({ pendingEvents: 4, ...extra }) as RunToIdleSnapshot;

  beforeEach(() => {
    bridge.runToIdle.mockReset();
    ui.toast.mockReset();
    ui.ready = true;
  });

  it('asks for at most 200 000 events and stays quiet after an idle run with timers pending', async () => {
    bridge.runToIdle.mockResolvedValue(snap({ pendingEvents: 7 }));
    await runToIdle();
    expect(bridge.runToIdle).toHaveBeenCalledTimes(1);
    expect(bridge.runToIdle).toHaveBeenCalledWith(200_000);
    expect(ui.toast).not.toHaveBeenCalled();
  });

  it('warns exactly once when the run stopped at the cap', async () => {
    bridge.runToIdle.mockResolvedValue(snap({ runStopped: 'maxEvents' }));
    await runToIdle();
    expect(RUN_TO_IDLE_CAP_WARNING).toBe('Stopped after 200 000 events; the queue is still busy.');
    expect(ui.toast).toHaveBeenCalledTimes(1);
    expect(ui.toast).toHaveBeenCalledWith(RUN_TO_IDLE_CAP_WARNING, 'warn');
  });

  it('does nothing before the engine is ready, and reports a failed run as an error', async () => {
    ui.ready = false;
    await runToIdle();
    expect(bridge.runToIdle).not.toHaveBeenCalled();
    ui.ready = true;
    bridge.runToIdle.mockRejectedValue(new Error('worker fault'));
    await runToIdle();
    expect(ui.toast).toHaveBeenCalledWith('worker fault', 'error');
  });
});
