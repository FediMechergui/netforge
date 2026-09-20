/**
 * Lab activation and grading in the worker (ARCHITECTURE-P1 §4.13, §8.2 W7 web-shell; protocol.ts `checkLab`,
 * `loadScenario`, `EngineBatch.lab`).
 *
 * The worker module is imported with Comlink mocked, exactly as worker.delta.test.ts does it. The pure decisions
 * (which events are worth a re-check, the name lookup, the throttle) are exercised directly.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TraceEvent } from '@netforge/engine';
import type { EngineApi, EngineBatch } from '../src/bridge/protocol';
import { LAB_CHECK_EVERY_MS, LAB_RELEVANT_KINDS, createWorkerLabs, labRelevant, scenarioByName } from '../src/bridge/worker/labs';

let exposed: EngineApi | undefined;

vi.mock('comlink', () => ({
  expose: (api: EngineApi) => {
    exposed = api;
  },
  proxy: <T>(x: T) => x,
  transfer: <T>(x: T) => x,
}));

const WORKER = '../src/bridge/worker/index.ts';
/** A small guided lab: two PCs and a switch the student has to address (§8.2 W6 ccna1). */
const LAB = 'ccna1-switched-lan';

async function freshWorker(): Promise<{ api: EngineApi; batches: EngineBatch[] }> {
  vi.resetModules();
  exposed = undefined;
  await import(WORKER);
  const api = exposed as unknown as EngineApi;
  const batches: EngineBatch[] = [];
  await api.subscribe((b) => {
    batches.push(b);
  });
  await api.init({ seed: 7 });
  batches.length = 0;
  return { api, batches };
}

const last = (batches: readonly EngineBatch[]): EngineBatch => {
  const b = batches[batches.length - 1];
  if (b === undefined) throw new Error('no batch was posted');
  return b;
};

const ev = (kind: TraceEvent['kind']): TraceEvent => ({ t: 0, kind }) as TraceEvent;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'performance'] });
});
afterEach(() => {
  vi.useRealTimers();
});

describe('lab bookkeeping (pure)', () => {
  it('re-checks only after events that can change an answer', () => {
    expect(LAB_RELEVANT_KINDS).toContain('configChange');
    expect(labRelevant([ev('configChange')])).toBe(true);
    expect(labRelevant([ev('tableWrite')])).toBe(true);
    expect(labRelevant([ev('portState')])).toBe(true);
    expect(labRelevant([ev('assocState')])).toBe(true);
    expect(labRelevant([ev('frameTx'), ev('pduCreated')])).toBe(false);
    expect(labRelevant([])).toBe(false);
  });

  it('looks a lab up by the name a saved document carries', () => {
    expect(scenarioByName(LAB)?.name).toBe(LAB);
    expect(scenarioByName('two-pcs-and-switch')?.tasks).toBeUndefined();
    expect(scenarioByName('no-such-lab')).toBeUndefined();
  });

  it('grades nothing while no lab is active', () => {
    const labs = createWorkerLabs();
    expect(labs.active).toBeUndefined();
    expect(labs.check(undefined as never)).toBeNull();
    expect(labs.maybeCheck(undefined as never, [ev('configChange')], 10_000)).toBeNull();
  });

  it('activates only scenarios that have tasks', () => {
    const labs = createWorkerLabs();
    labs.activate(scenarioByName('two-pcs-and-switch'));
    expect(labs.active).toBeUndefined();
    labs.activateByName(LAB);
    expect(labs.active?.name).toBe(LAB);
    labs.activateByName(undefined);
    expect(labs.active).toBeUndefined();
  });
});

describe('worker: loading and grading a lab', () => {
  it('loadScenario activates the lab and posts its first status with a snapshot', async () => {
    const { api, batches } = await freshWorker();
    await api.loadScenario(LAB);
    const batch = last(batches);
    expect(batch.snapshot).toBeDefined();
    expect(batch.lab).not.toBeNull();
    expect(batch.lab?.lab).toBe(LAB);
    expect(batch.lab?.total).toBeGreaterThan(0);
    // Nothing has been configured yet, so the tasks do not pass.
    expect(batch.lab?.score).toBeLessThan(batch.lab?.total ?? 0);
    expect(batch.lab?.results.some((r) => !r.pass)).toBe(true);
  });

  it('the lab section is exported with the topology, so reopening the file activates it again', async () => {
    const { api, batches } = await freshWorker();
    await api.loadScenario(LAB);
    const topo = await api.exportTopology();
    expect(topo.lab?.name).toBe(LAB);

    await api.reset(11);
    expect(await api.checkLab()).toBeNull();

    batches.length = 0;
    await api.loadTopology(topo);
    expect(last(batches).lab?.lab).toBe(LAB);
    expect((await api.checkLab())?.lab).toBe(LAB);
  });

  it('checkLab evaluates on demand and posts a batch carrying the status', async () => {
    const { api, batches } = await freshWorker();
    await api.loadScenario(LAB);
    batches.length = 0;

    const status = await api.checkLab();
    expect(status?.lab).toBe(LAB);
    expect(batches).toHaveLength(1);
    expect(last(batches).lab).toEqual(status);
  });

  it('grading leaves the clock and the trace head where they were', async () => {
    const { api } = await freshWorker();
    await api.loadScenario(LAB);
    const before = await api.snapshot();
    const head = (await api.traceQuery({ from: 0, limit: 1 })).head;

    await api.checkLab();

    const after = await api.snapshot();
    expect(after.now).toBe(before.now);
    expect((await api.traceQuery({ from: 0, limit: 1 })).head).toBe(head);
  });

  it('a plain template clears the lab, and so does a reset', async () => {
    const { api, batches } = await freshWorker();
    await api.loadScenario(LAB);
    batches.length = 0;

    await api.loadScenario('two-pcs-and-switch');
    expect(last(batches).lab).toBeNull();
    expect(await api.checkLab()).toBeNull();

    await api.loadScenario(LAB);
    batches.length = 0;
    await api.reset(3);
    expect(last(batches).lab).toBeNull();
  });

  it('re-checks after a relevant change, at most every LAB_CHECK_EVERY_MS, and only posts news', async () => {
    const { api, batches } = await freshWorker();
    await api.loadScenario(LAB);
    const loaded = last(batches).lab;
    expect(loaded?.results.find((r) => r.task === 'switch-name')?.pass).toBe(false);
    await api.runToIdle(); // the devices boot, so configuration is accepted
    batches.length = 0;

    // Solving a task within the throttle window: the answer is held back, not lost.
    const solve = await api.configure('sw1', ['hostname LAB-SW1']);
    expect(solve.ok).toBe(true);
    expect(last(batches).events.some((e) => e.kind === 'configChange')).toBe(true);
    expect(last(batches).lab).toBeUndefined();

    // The window passes, the next relevant event carries the new score.
    vi.advanceTimersByTime(LAB_CHECK_EVERY_MS + 1);
    await api.configure('pc1', ['ip address 192.168.10.11 255.255.255.0']);
    const graded = last(batches).lab;
    expect(graded?.lab).toBe(LAB);
    expect(graded?.results.find((r) => r.task === 'switch-name')?.pass).toBe(true);
    expect(graded?.score).toBeGreaterThan(loaded?.score ?? 0);

    // A relevant event that changes no answer keeps the bridge quiet.
    vi.advanceTimersByTime(LAB_CHECK_EVERY_MS + 1);
    await api.configure('sw1', ['hostname LAB-SW1']);
    expect(last(batches).lab).toBeUndefined();
  });
});
