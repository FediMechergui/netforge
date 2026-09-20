/**
 * Review regression tests for apps/web/src/bridge/engine.worker.ts (clock slice algorithm).
 * The worker module is imported with Comlink mocked and wall timers faked.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type ApiMethod =
  | 'subscribe'
  | 'init'
  | 'loadScenario'
  | 'runToIdle'
  | 'setRate'
  | 'play'
  | 'pause'
  | 'stepTime'
  | 'cliOpen'
  | 'cliExec'
  | 'snapshot';
type AnyApi = Record<ApiMethod, (...args: any[]) => Promise<any>>;
let exposed: AnyApi | undefined;

vi.mock('comlink', () => ({
  expose: (api: AnyApi) => {
    exposed = api;
  },
  proxy: <T>(x: T) => x,
}));

const WORKER = '../src/bridge/engine.worker.ts';

interface Batch {
  now: number;
  events: any[];
  effectiveRate: number;
  playing: boolean;
  snapshot?: any;
}

async function freshWorker(): Promise<{ api: AnyApi; batches: Batch[] }> {
  vi.resetModules();
  exposed = undefined;
  await import(WORKER);
  const api = exposed!;
  const batches: Batch[] = [];
  await api.subscribe((b: Batch) => batches.push(b));
  await api.init({ seed: 7 });
  return { api, batches };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'performance'] });
});
afterEach(() => {
  vi.useRealTimers();
});

async function bootAndPing(api: AnyApi, batches: Batch[]): Promise<void> {
  await api.loadScenario('two-pcs-and-switch');
  await api.runToIdle(); // boot everything
  await api.setRate(1);
  await api.play();
  vi.advanceTimersByTime(100);
  const view = await api.cliOpen('pc1', 'console');
  batches.length = 0;
  await api.cliExec(view.id, 'ping 10.0.0.2');
}

describe('review: worker clock', () => {
  it('loading a topology while a frame is on a wire does not freeze the clock', async () => {
    const { api, batches } = await freshWorker();
    // Put the sim far into the future so stale flights have a large `arrive`.
    await api.loadScenario('two-pcs-and-switch');
    await api.stepTime(60 * 1_000_000_000);
    await bootAndPing(api, batches);
    vi.advanceTimersByTime(100); // the ARP request is now on a cable (400 ms slow motion)
    const snap = await api.snapshot();
    expect(snap.inflight.length).toBeGreaterThan(0);

    await api.pause();
    await api.loadScenario('two-pcs-and-switch'); // sim time returns to 0
    await api.play();
    vi.advanceTimersByTime(5_000); // 5 s of wall at rate 1
    const now = (await api.snapshot()).now;
    // At rate 1 about 5 s of sim time must have elapsed (idle topology).
    expect(now).toBeGreaterThan(1_000_000_000);
  });

  it('the batch that carries a frameTx reports an effectiveRate the canvas can extrapolate with', async () => {
    const { api, batches } = await freshWorker();
    await bootAndPing(api, batches);
    const withTx = batches.find((b) => b.events.some((e) => e.kind === 'frameTx'));
    expect(withTx).toBeDefined();
    const tx = withTx!.events.find((e) => e.kind === 'frameTx');
    const span = tx.arrive - tx.txStart;
    // Canvas: now(wall) = batch.now + effectiveRate * dtWall. 100 ms after the batch the capsule
    // must still be on the cable (policy: >= 400 ms of wall per transit).
    const extrapolated = withTx!.now + withTx!.effectiveRate * 100;
    expect(extrapolated).toBeLessThan(tx.arrive);
    expect(span).toBeGreaterThan(0);
  });
});
