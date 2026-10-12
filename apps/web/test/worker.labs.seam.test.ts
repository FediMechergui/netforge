/**
 * The worker's own lab lookups go through the [S37] seam (ARCHITECTURE-P3 D6, §7 W6 web-shell; W6a integration of
 * review findings #2 and #7): reopening a saved lab (`loadTopology`), opening one from the Labs browser
 * (`loadScenario`) and "Use current defaults" each resolve the lab with `resolveLab(ref)` of bridge/worker/labs.ts, not
 * with `SCENARIOS.find`. So a lab that only the seam knows — what P3b's assessment engine will plug in there — is
 * activated and graded by all three, and a built-in lab behaves exactly as before.
 *
 * The labs module is wrapped: its real `resolveLab` answers, every call is recorded, and one extra name resolves to a
 * lab no build ships (a copy of a CCNA 1 lab under another name). The worker module is imported with Comlink mocked,
 * as worker.labs.test.ts does it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SCENARIOS } from '@netforge/engine';
import type { ScenarioInfo } from '@netforge/engine';
import type { EngineApi, EngineBatch } from '../src/bridge/protocol';

/** A small guided lab: two PCs and a switch the student has to address. */
const LAB = 'ccna1-switched-lan';
/** A lab only the seam resolves (no build ships it). */
const SEAM_ONLY = 'p3b-assessed-switched-lan';

const seam = vi.hoisted(() => ({ calls: [] as unknown[], extra: new Map<string, ScenarioInfo>() }));

let exposed: EngineApi | undefined;

vi.mock('comlink', () => ({
  expose: (api: EngineApi) => {
    exposed = api;
  },
  proxy: <T>(x: T) => x,
  transfer: <T>(x: T) => x,
}));
// ruling R28: the pure engine is evaluated once per file and kept across `vi.resetModules()`
vi.mock('@netforge/engine', async (importOriginal) => await importOriginal());
vi.mock('../src/bridge/worker/labs', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/bridge/worker/labs')>();
  return {
    ...real,
    resolveLab: (ref: Parameters<typeof real.resolveLab>[0]) => {
      seam.calls.push(ref);
      if (typeof ref === 'string' && seam.extra.has(ref)) return seam.extra.get(ref);
      return real.resolveLab(ref);
    },
  };
});

const WORKER = '../src/bridge/worker/index.ts';

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
  seam.calls.length = 0;
  return { api, batches };
}

const last = (batches: readonly EngineBatch[]): EngineBatch => {
  const b = batches[batches.length - 1];
  if (b === undefined) throw new Error('no batch was posted');
  return b;
};

function builtIn(name: string): ScenarioInfo {
  const s = SCENARIOS.find((x) => x.name === name);
  if (s === undefined) throw new Error(`this build has no scenario called ${name}`);
  return s;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'performance'] });
  seam.extra.clear();
  seam.extra.set(SEAM_ONLY, { ...builtIn(LAB), name: SEAM_ONLY });
});
afterEach(() => {
  vi.useRealTimers();
});

describe('worker: every lab lookup goes through resolveLab ([S37])', () => {
  it('loadScenario resolves the name through the seam, and still refuses a name nothing resolves', async () => {
    const { api, batches } = await freshWorker();
    expect(SCENARIOS.some((s) => s.name === SEAM_ONLY)).toBe(false);
    await api.loadScenario(SEAM_ONLY);
    expect(seam.calls).toEqual([SEAM_ONLY]);
    expect(last(batches).lab?.lab).toBe(SEAM_ONLY);
    expect(last(batches).lab?.total).toBeGreaterThan(0);

    seam.calls.length = 0;
    await expect(api.loadScenario('no-such-lab')).rejects.toThrow('There is no template called "no-such-lab".');
    expect(seam.calls).toEqual(['no-such-lab']);
  });

  it('reopening a saved lab (loadTopology) activates the lab the seam resolves from its lab section', async () => {
    const { api, batches } = await freshWorker();
    await api.loadScenario(SEAM_ONLY);
    const topo = await api.exportTopology();
    expect(topo.lab?.name).toBe(SEAM_ONLY);

    await api.reset(11);
    expect(await api.checkLab()).toBeNull();
    seam.calls.length = 0;
    batches.length = 0;
    await api.loadTopology(topo);
    expect(seam.calls).toEqual([SEAM_ONLY]);
    expect(last(batches).lab?.lab).toBe(SEAM_ONLY);
    expect((await api.checkLab())?.lab).toBe(SEAM_ONLY);

    // a world with no lab section resolves nothing and grades nothing
    seam.calls.length = 0;
    const { lab: _lab, ...plain } = topo;
    await api.loadTopology(plain);
    expect(seam.calls).toEqual([undefined]);
    expect(await api.checkLab()).toBeNull();
  });

  it('"Use current defaults" keeps the lab the seam resolves', async () => {
    const { api, batches } = await freshWorker();
    await api.loadScenario(SEAM_ONLY);
    seam.calls.length = 0;
    batches.length = 0;
    await api.useCurrentDefaults();
    expect(seam.calls).toEqual([SEAM_ONLY]);
    expect(last(batches).lab?.lab).toBe(SEAM_ONLY);
  });

  it('a built-in lab behaves as before: the same status as a lab of that name, through the same seam', async () => {
    const { api, batches } = await freshWorker();
    await api.loadScenario(LAB);
    expect(seam.calls).toEqual([LAB]);
    const first = last(batches).lab;
    expect(first?.lab).toBe(LAB);
    const topo = await api.exportTopology();
    await api.reset(11);
    seam.calls.length = 0;
    await api.loadTopology(topo);
    expect(seam.calls).toEqual([LAB]);
    expect((await api.checkLab())?.results.map((r) => [r.task, r.pass])).toEqual(first?.results.map((r) => [r.task, r.pass]));
  });
});
