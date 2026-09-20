/**
 * Simulation mode in the worker (ARCHITECTURE-P1 §4.11, §8.2 W7 web-shell; §10.2 accept.p1.sim-mode-dhcp-offer,
 * worker half: "the batch carries `stopped {reason 'breakpoint'}` and a snapshot").
 *
 * Comlink is mocked and the wall clock faked, as in worker.delta.test.ts. The breakpoint filter here is
 * `{kinds:['frameTx']}` rather than the DHCP one of the acceptance test: this file proves the WIRING (pause, batch,
 * snapshot, step), and a frame is the shortest deterministic way to reach it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RunStats, TraceEvent } from '@netforge/engine';
import { DEFAULT_SIM_FILTERS, SIM_STEP_HORIZON_NS, SIM_STEP_MAX_EVENTS, type EngineApi, type EngineBatch } from '../src/bridge/protocol';
import { createWorkerClock } from '../src/bridge/worker/clock';
import { createSimMode, endedOf, stepOptions, stopInfoOf } from '../src/bridge/worker/sim-mode';

let exposed: EngineApi | undefined;

vi.mock('comlink', () => ({
  expose: (api: EngineApi) => {
    exposed = api;
  },
  proxy: <T>(x: T) => x,
  transfer: <T>(x: T) => x,
}));

const WORKER = '../src/bridge/worker/index.ts';
const SEC = 1_000_000_000;

async function booted(scenario: string): Promise<{ api: EngineApi; batches: EngineBatch[] }> {
  vi.resetModules();
  exposed = undefined;
  await import(WORKER);
  const api = exposed as unknown as EngineApi;
  const batches: EngineBatch[] = [];
  await api.subscribe((b) => {
    batches.push(b);
  });
  await api.init({ seed: 7 });
  await api.loadScenario(scenario);
  await api.runToIdle();
  batches.length = 0;
  return { api, batches };
}

const last = (batches: readonly EngineBatch[]): EngineBatch => {
  const b = batches[batches.length - 1];
  if (b === undefined) throw new Error('no batch was posted');
  return b;
};

/** Start a ping on PC1 so the next events are frames. */
async function pinging(api: EngineApi): Promise<void> {
  const view = await api.cliOpen('pc1', 'console');
  await api.cliExec(view.id, 'ping 10.0.0.2');
}

const stats = (p: Partial<RunStats>): RunStats => ({ events: 1, from: 0, to: 0, ...p });
const frameEvent = { t: 42, kind: 'frameTx' } as TraceEvent;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'performance'] });
});
afterEach(() => {
  vi.useRealTimers();
});

describe('simulation-mode state (pure)', () => {
  it('starts in real time, with the default list filter and no breakpoint', () => {
    const m = createSimMode();
    expect(m.mode).toBe('realtime');
    expect(DEFAULT_SIM_FILTERS.list.kinds).toEqual(['frameTx', 'drop', 'tableWrite']);
    expect(DEFAULT_SIM_FILTERS.list.includeBackground).toBe(false);
    expect(m.filters.breakOn).toBeNull();
    expect(m.runOptions()).toBeUndefined();
    expect(m.clampFilter()).toBeNull();
  });

  it('only stops on a breakpoint while in simulation mode, and clears it on the way back', () => {
    const m = createSimMode();
    m.setFilters({ list: { kinds: ['frameTx'] }, breakOn: { kinds: ['drop'] } });
    expect(m.runOptions()).toBeUndefined(); // still real time
    expect(m.setMode('simulation')).toBe(true);
    expect(m.setMode('simulation')).toBe(false);
    expect(m.runOptions()).toEqual({ stopOn: { kinds: ['drop'] } });
    expect(m.clampFilter()).toEqual({ kinds: ['frameTx'] });
    m.setMode('realtime');
    expect(m.filters.breakOn).toBeNull();
    expect(m.runOptions()).toBeUndefined();
  });

  it('matches events against the list filter and rejects an unknown mode', () => {
    const m = createSimMode();
    m.setFilters({ list: { kinds: ['drop'] }, breakOn: null });
    expect(m.matchesList({ t: 0, kind: 'drop' } as TraceEvent)).toBe(true);
    expect(m.matchesList(frameEvent)).toBe(false);
    expect(() => m.setMode('slow' as never)).toThrow(RangeError);
  });

  it('reads the outcome of a run: the stop, or why there was none', () => {
    expect(stepOptions(5 * SEC)).toEqual({ until: 5 * SEC + SIM_STEP_HORIZON_NS, maxEvents: SIM_STEP_MAX_EVENTS });
    expect(stopInfoOf(stats({ stopped: 'breakpoint', stopEvent: frameEvent, stopCursor: 9 }), 'step')).toEqual({ cursor: 9, event: frameEvent, reason: 'step' });
    expect(stopInfoOf(stats({ stopped: 'maxEvents' }), 'breakpoint')).toBeNull();
    expect(stopInfoOf(stats({}), 'breakpoint')).toBeNull();
    expect(endedOf(stats({ stopped: 'maxEvents' }), 100)).toBe('maxEvents');
    expect(endedOf(stats({}), undefined)).toBe('idle');
    expect(endedOf(stats({}), 100)).toBe('horizon');
  });

  it('the clock keeps slow motion only for frames the list filter shows (§4.11 item 2)', () => {
    const clock = createWorkerClock({ minTransitWallMs: 400 });
    clock.setPlaying(true);
    const frame = (proto: string): TraceEvent =>
      ({
        t: 0,
        kind: 'frameTx',
        pdu: { id: `p_${proto}`, proto, layers: [proto], bytes: 64 },
        link: 'l1',
        from: { device: 'a', port: 'p' },
        to: { device: 'b', port: 'p' },
        txStart: 0,
        txEnd: 500,
        arrive: 1_000,
      }) as unknown as TraceEvent;

    clock.observe(frame('arp'));
    expect(clock.clampingFlights).toBe(1);
    clock.setClampFilter({ kinds: ['frameTx'], protos: ['icmpv4'] });
    expect(clock.clampingFlights).toBe(0);
    clock.setClampFilter({ kinds: ['frameTx'], protos: ['arp'] });
    expect(clock.clampingFlights).toBe(1);
    clock.setClampFilter(null);
    expect(clock.clampingFlights).toBe(1);
  });
});

describe('worker: breakpoints and stepping', () => {
  it('entering simulation mode pauses and tells the UI which mode it is in', async () => {
    const { api, batches } = await booted('two-pcs-and-switch');
    await api.play();
    batches.length = 0;

    await api.setPlaybackMode('simulation');
    const batch = last(batches);
    expect(batch.playbackMode).toBe('simulation');
    expect(batch.playing).toBe(false);

    await api.setPlaybackMode('realtime');
    expect(last(batches).playbackMode).toBe('realtime');
  });

  it('a breakpoint stops the playing clock and posts a snapshot with the event (§10.2 sim-mode)', async () => {
    const { api, batches } = await booted('two-pcs-and-switch');
    await api.setPlaybackMode('simulation');
    await api.setSimFilters({ list: DEFAULT_SIM_FILTERS.list, breakOn: { kinds: ['frameTx'] } });
    await pinging(api);
    batches.length = 0;

    await api.play();
    vi.advanceTimersByTime(1_000);

    const stop = batches.find((b) => b.stopped !== undefined);
    expect(stop).toBeDefined();
    expect(stop!.stopped!.reason).toBe('breakpoint');
    expect(stop!.stopped!.event.kind).toBe('frameTx');
    expect(stop!.snapshot).toBeDefined();
    expect(stop!.playing).toBe(false);
    expect(stop!.snapshot!.now).toBe(stop!.stopped!.event.t);
    // The clock really stopped: nothing after the stop batch moves time on.
    const after = batches.slice(batches.indexOf(stop!) + 1);
    for (const b of after) expect(b.now).toBe(stop!.now);
  });

  it('runUntilStop stops at the first match and reports it to the caller and to the bridge', async () => {
    const { api, batches } = await booted('two-pcs-and-switch');
    await pinging(api);
    const from = (await api.snapshot()).now;
    batches.length = 0;

    const result = await api.runUntilStop(from + 5 * SEC, { kinds: ['frameTx'] });
    expect(result.stopped).not.toBeNull();
    expect(result.stopped!.reason).toBe('breakpoint');
    expect(result.snapshot.now).toBe(result.stopped!.event.t);
    expect(result.snapshot.now).toBeLessThan(from + 5 * SEC);
    expect(result.ended).toBeUndefined();

    const batch = last(batches);
    expect(batch.snapshot).toBeDefined();
    expect(batch.stopped).toEqual(result.stopped);
  });

  it('stepToNext walks match by match', async () => {
    const { api } = await booted('two-pcs-and-switch');
    await pinging(api);

    const first = await api.stepToNext({ kinds: ['frameTx'] });
    expect(first.stopped!.reason).toBe('step');
    const second = await api.stepToNext({ kinds: ['frameTx'] });
    expect(second.stopped!.reason).toBe('step');
    expect(second.snapshot.now).toBeGreaterThan(first.snapshot.now);
    expect(second.stopped!.cursor).toBeGreaterThan(first.stopped!.cursor);
  });

  it('a quiet world reports why there was no match instead of jumping minutes ahead', async () => {
    const { api } = await booted('two-pcs-and-switch');
    const before = (await api.snapshot()).now;

    const result = await api.stepToNext({ kinds: ['frameTx'] });
    expect(result.stopped).toBeNull();
    expect(result.ended).toBe('horizon');
    expect(result.snapshot.now).toBeLessThanOrEqual(before + SIM_STEP_HORIZON_NS);
  });

  it('with nothing scheduled at all, the step reports an idle world', async () => {
    vi.resetModules();
    exposed = undefined;
    await import(WORKER);
    const api = exposed as unknown as EngineApi;
    await api.init({ seed: 5 });

    const result = await api.stepToNext({ kinds: ['frameTx'] });
    expect(result.stopped).toBeNull();
    expect(result.ended).toBe('idle');
  });

  it('traceQuery pages the ring with the list filter, for the sim-events panel', async () => {
    const { api, batches } = await booted('two-pcs-and-switch');
    await pinging(api);
    await api.runToIdle();
    const head = last(batches).traceHead;
    expect(head).toBeGreaterThan(0);

    const page = await api.traceQuery({ from: 0, limit: 5, filter: { kinds: ['frameTx'] } });
    expect(page.events.length).toBeGreaterThan(0);
    expect(page.events.length).toBeLessThanOrEqual(5);
    for (const row of page.events) expect(row.event.kind).toBe('frameTx');
    expect(page.head).toBeGreaterThanOrEqual(page.next);
  });
});
