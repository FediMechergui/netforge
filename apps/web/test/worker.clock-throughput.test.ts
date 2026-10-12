/**
 * The worker's reported rate under generated traffic (ARCHITECTURE-P3 §9.2 ruling R57(a); the W5 fix step, review
 * finding 1), through the real worker module (Comlink mocked, interval timers faked, the wall clock in the test's hands).
 *
 * With R57(a) a flow no longer holds the clock in slow motion, so at a high rate the engine can fall behind the chosen
 * rate: a slice ends on the sub-step bound, or a tick comes late and the worker caps its catch-up at
 * MAX_SLICE_WALL_MS. The batch's `effectiveRate` must then be the rate sim time really advances at: the canvas
 * extrapolates with it from one batch to the next (so it must land where the next batch is, not run ahead and be set
 * back), and the "slow-motion" chip shows the shortfall. Lab 27 (`ccna3-qos-voice-first`) with R57's own voice flow.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MS, SEC } from '@netforge/engine';

type ApiMethod = 'subscribe' | 'init' | 'loadScenario' | 'stepTime' | 'cliOpen' | 'cliExec' | 'setRate' | 'play';
type AnyApi = Record<ApiMethod, (...args: any[]) => Promise<any>>;
let exposed: AnyApi | undefined;

vi.mock('comlink', () => ({
  expose: (api: AnyApi) => {
    exposed = api;
  },
  proxy: <T>(x: T) => x,
}));
// ARCHITECTURE-P3 ruling R28: the engine is pure, evaluated once per file and kept across `vi.resetModules()`.
vi.mock('@netforge/engine', async (importOriginal) => await importOriginal());

const WORKER = '../src/bridge/engine.worker.ts';
/** The worker's tick (index.ts TICK_MS) and its catch-up cap (MAX_SLICE_WALL_MS). */
const TICK_MS = 16;
const MAX_SLICE_WALL_MS = 250;

interface Batch {
  now: number;
  rate: number;
  effectiveRate: number;
  playing: boolean;
  events: Array<{ kind: string; [k: string]: unknown }>;
}

let wall = 0;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'] });
  wall = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => wall);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** Lab 27 booted in a fresh worker, with a continuous flow from PC-V to PC-S. */
async function labWithFlow(flow: string): Promise<{ api: AnyApi; batches: Batch[] }> {
  vi.resetModules();
  exposed = undefined;
  await import(WORKER);
  const api = exposed!;
  const batches: Batch[] = [];
  await api.subscribe((b: Batch) => batches.push(b));
  await api.init({ seed: 7 });
  await api.loadScenario('ccna3-qos-voice-first');
  await api.stepTime(70 * SEC); // the routers boot in about 45 s
  const view = await api.cliOpen('pcv', 'console');
  // warm the ARP caches on the way, then start the flow under test
  await api.cliExec(view.id, 'flow start 192.168.2.10 pps 50 size 60 count 1');
  await api.stepTime(5 * SEC);
  const from = batches.length;
  await api.cliExec(view.id, flow);
  await api.stepTime(0); // the shell job prints its line at once
  const printed = batches
    .slice(from)
    .flatMap((b) => b.events)
    .filter((e) => e.kind === 'cliOutput')
    .map((e) => e.text as string)
    .join('');
  expect(printed).toMatch(/Flow f\d started: .*until stopped/);
  return { api, batches };
}

/** One worker tick, `passedMs` of wall after the previous one; returns the batch it posted. */
function tick(batches: Batch[], passedMs: number): Batch {
  const n = batches.length;
  wall += passedMs;
  vi.advanceTimersByTime(TICK_MS); // the interval fires exactly once
  expect(batches.length).toBe(n + 1);
  return batches[n]!;
}

/** Play `ticks` ticks of `passedMs` at `rate`; the batches the ticks posted. */
async function playTicks(api: AnyApi, batches: Batch[], rate: number, ticks: number, passedMs: number): Promise<Batch[]> {
  await api.setRate(rate);
  await api.play();
  const out: Batch[] = [];
  for (let i = 0; i < ticks; i++) out.push(tick(batches, passedMs));
  return out;
}

/** Every batch's extrapolation over the wall time to the next tick lands within 2 % of a tick's advance of it. */
function expectNoSawTooth(posted: Batch[], passedMs: number): void {
  for (let i = 1; i < posted.length; i++) {
    const prev = posted[i - 1]!;
    const cur = posted[i]!;
    const advanced = cur.now - prev.now;
    expect(advanced).toBeGreaterThan(0);
    expect(Math.abs(prev.now + prev.effectiveRate * passedMs - cur.now)).toBeLessThan(0.02 * advanced);
  }
}

describe('R57(a): the batches report the rate a running flow really plays at', () => {
  it('R57 voice flow, 10x: exactly the chosen rate, and the batches say so', async () => {
    const { api, batches } = await labWithFlow('flow start 192.168.2.10 pps 50 size 60 port 16384');
    const posted = await playTicks(api, batches, 10, 30, TICK_MS);
    for (let i = 1; i < posted.length; i++) expect(posted[i]!.now - posted[i - 1]!.now).toBe(10 * TICK_MS * MS);
    for (const b of posted) expect(b.effectiveRate).toBe(10 * MS);
  }, 60_000);

  it('R57 voice flow, 100x on an engine that cannot keep up (ticks 385 ms apart): effectiveRate is the achieved rate', async () => {
    const { api, batches } = await labWithFlow('flow start 192.168.2.10 pps 50 size 60 port 16384');
    const late = 385;
    const posted = await playTicks(api, batches, 100, 12, late);
    for (const b of posted) {
      expect(b.rate).toBe(100);
      // the slow-motion chip's factor: at least 385 / 250 behind the chosen rate
      expect(b.effectiveRate).toBeLessThanOrEqual(100 * MS * (MAX_SLICE_WALL_MS / late) + 1e-6);
    }
    expectNoSawTooth(posted, late);
  }, 60_000);

  it('a 1000 pps flow at 100x: the sub-step bound cuts every slice and effectiveRate says by how much', async () => {
    const { api, batches } = await labWithFlow('flow start 192.168.2.10 pps 1000 size 60');
    const posted = await playTicks(api, batches, 100, 12, TICK_MS);
    for (const b of posted.slice(1)) {
      expect(b.now - posted[0]!.now).toBeGreaterThan(0);
      expect(b.effectiveRate).toBeLessThan(0.8 * 100 * MS);
    }
    expectNoSawTooth(posted, TICK_MS);
  }, 60_000);
});
