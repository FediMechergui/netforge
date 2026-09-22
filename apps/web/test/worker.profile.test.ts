/**
 * The defaults profile through the worker (ARCHITECTURE-P2 D2, §2.14, §10.2; W2 web-shell).
 *
 * `init` and `reset` build the empty world with the profile the caller chose from the course context (absent =
 * the classic 'P1' defaults, as for every saved P1 file); the app-start choice (`startupProfile`) reads the store's
 * persisted `learn.lastCourse`; a loaded template is a classic world and shows the "Classic defaults" chip; File →
 * "Use current defaults" moves such a world to the current defaults in place — every device and its configuration
 * kept, a multilayer switch that routed keeps routing, the schema raised with the profile, the lab kept, a new
 * epoch — and the chip goes away.
 *
 * The worker module is imported with Comlink mocked and wall timers faked, as in worker.delta.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SCENARIOS, schemaIdFor } from '@netforge/engine';
import type { DeviceModel, SimSnapshot, Topology } from '@netforge/engine';
import { classicDefaultsChip } from '../src/app/StatusBar';
import { startupProfile } from '../src/bridge/client';
import type { EngineApi, EngineBatch } from '../src/bridge/protocol';
import { profileForCourse, profileOfSnapshot } from '../src/learn/course-profile';
import { store } from '../src/store/store';

let exposed: EngineApi | undefined;

vi.mock('comlink', () => ({
  expose: (api: EngineApi) => {
    exposed = api;
  },
  proxy: <T>(x: T) => x,
  wrap: () => {
    throw new Error('no worker in a test');
  },
}));

const WORKER = '../src/bridge/worker/index.ts';
type WorkerModule = { withCurrentDefaults(t: Topology, modelOf: (type: string) => Pick<DeviceModel, 'profileConfig'> | undefined): Topology };

async function freshWorker(init: { seed: number; profile?: 'P1' | 'P2' }): Promise<{ api: EngineApi; batches: EngineBatch[]; mod: WorkerModule }> {
  vi.resetModules();
  exposed = undefined;
  const mod = (await import(WORKER)) as unknown as WorkerModule;
  const api = exposed as unknown as EngineApi;
  const batches: EngineBatch[] = [];
  await api.subscribe((b) => {
    batches.push(b);
  });
  await api.init(init);
  return { api, batches, mod };
}

function last(batches: readonly EngineBatch[]): EngineBatch {
  const b = batches[batches.length - 1];
  if (b === undefined) throw new Error('no batch was posted');
  return b;
}

const configOf = (t: Topology, name: string): string => {
  const d = t.devices.find((x) => x.name === name);
  if (d === undefined) throw new Error(`no device ${name}`);
  return d.runningConfig ?? d.config ?? '';
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'performance'] });
});
afterEach(() => {
  vi.useRealTimers();
  store.getState().setLastCourse(null);
});

describe('init and reset take the profile the caller chose (D2)', () => {
  it('init without a profile builds a classic world: no profile in the snapshot, the chip shows', async () => {
    const { api } = await freshWorker({ seed: 7 });
    const snap = await api.snapshot();
    expect(snap.profile).toBeUndefined();
    expect(profileOfSnapshot(snap)).toBe('P1');
    expect(classicDefaultsChip(snap)?.label).toBe('Classic defaults');
  });

  it('init with the current profile builds a P2 world: the snapshot says so, no chip', async () => {
    const { api } = await freshWorker({ seed: 7, profile: 'P2' });
    const snap = await api.snapshot();
    expect(snap.profile).toBe('P2');
    expect(classicDefaultsChip(snap)).toBeNull();
  });

  it('reset takes the profile passed, and the classic one when none is', async () => {
    const { api, batches } = await freshWorker({ seed: 7, profile: 'P2' });
    expect((await api.reset(11, 'P1')).profile).toBeUndefined();
    expect(last(batches).snapshot?.profile).toBeUndefined();
    expect((await api.reset(12, 'P2')).profile).toBe('P2');
    expect(last(batches).snapshot?.profile).toBe('P2');
    expect((await api.reset(13)).profile).toBeUndefined();
    // Every reset is a new world: a new epoch, an empty one.
    const epochs = batches.map((b) => b.epoch);
    expect(new Set(epochs).size).toBe(epochs.length);
    expect((await api.snapshot()).devices).toEqual([]);
  });

  it('a device placed in a P2 world is built with the P2 defaults; in a classic world with the classic ones', async () => {
    const { api } = await freshWorker({ seed: 7, profile: 'P2' });
    await api.addDevice({ type: 'pc.nfpc', position: { x: 0, y: 0 } });
    const t = await api.exportTopology();
    expect(t.profile).toBe('P2');
    expect(t.devices).toHaveLength(1);
    await api.reset(8, 'P1');
    await api.addDevice({ type: 'pc.nfpc', position: { x: 0, y: 0 } });
    expect((await api.exportTopology()).profile).toBeUndefined();
  });
});

describe('app start and File → New read the course context', () => {
  it('startupProfile is the classic profile after a CCNA 1 lesson and the current one otherwise', () => {
    expect(startupProfile()).toBe('P2');
    store.getState().setLastCourse('ccna1');
    expect(startupProfile()).toBe('P1');
    store.getState().setLastCourse('ccna2');
    expect(startupProfile()).toBe('P2');
    store.getState().setLastCourse(null);
    expect(startupProfile()).toBe('P2');
    expect(startupProfile()).toBe(profileForCourse(store.getState().learn.lastCourse));
  });

  it('a world the worker builds from that choice matches it', async () => {
    store.getState().setLastCourse('ccna1');
    const { api } = await freshWorker({ seed: 3, profile: startupProfile() });
    expect(classicDefaultsChip(await api.snapshot())?.label).toBe('Classic defaults');
    await api.reset(4, profileForCourse('ccna2'));
    expect(classicDefaultsChip(await api.snapshot())).toBeNull();
  });
});

describe('a loaded template is a classic world', () => {
  it('shows the "Classic defaults" chip even in a P2 session', async () => {
    const { api } = await freshWorker({ seed: 7, profile: 'P2' });
    await api.loadScenario('two-pcs-and-switch');
    const snap = await api.snapshot();
    expect(snap.profile).toBeUndefined();
    expect(snap.devices.length).toBeGreaterThan(0);
    expect(classicDefaultsChip(snap)?.label).toBe('Classic defaults');
    expect(classicDefaultsChip(null)).toBeNull();
  });
});

describe('"Use current defaults" (EngineApi.useCurrentDefaults)', () => {
  it('moves a template world to the current defaults in place: devices, names and cables kept, a new epoch', async () => {
    const { api, batches } = await freshWorker({ seed: 7 });
    await api.loadScenario('two-pcs-and-switch');
    const before = await api.snapshot();
    const beforeTopo = await api.exportTopology();
    const epochBefore = last(batches).epoch;
    batches.length = 0;

    const after = await api.useCurrentDefaults();
    expect(after.profile).toBe('P2');
    expect(classicDefaultsChip(after)).toBeNull();
    expect(after.devices.map((d) => d.name).sort()).toEqual(before.devices.map((d) => d.name).sort());
    expect(after.links).toHaveLength(before.links.length);

    const posted = last(batches);
    expect(posted.snapshot?.profile).toBe('P2');
    expect(posted.epoch).not.toBe(epochBefore);

    const afterTopo = await api.exportTopology();
    expect(afterTopo.profile).toBe('P2');
    expect(afterTopo.schema).toBe(schemaIdFor(afterTopo));
    // Nothing in a plain PC-and-switch world needs a routing line: every configuration is byte-identical.
    for (const d of beforeTopo.devices) expect(configOf(afterTopo, d.name)).toBe(configOf(beforeTopo, d.name));
  });

  it('is a no-op on a world already at the current defaults', async () => {
    const { api } = await freshWorker({ seed: 7, profile: 'P2' });
    await api.addDevice({ type: 'pc.nfpc', position: { x: 0, y: 0 } });
    const before = await api.exportTopology();
    const snap = await api.useCurrentDefaults();
    expect(snap.profile).toBe('P2');
    const after = await api.exportTopology();
    expect(after.devices.map((d) => d.runningConfig ?? d.config)).toEqual(before.devices.map((d) => d.runningConfig ?? d.config));
  });

  it('keeps the lab of a CCNA 1 lab world', async () => {
    const meta = SCENARIOS.find((s) => s.name === 'ccna1-switched-lan');
    expect(meta).toBeDefined();
    const { api, batches } = await freshWorker({ seed: 7 });
    await api.loadScenario('ccna1-switched-lan');
    expect(classicDefaultsChip(await api.snapshot())?.label).toBe('Classic defaults');
    batches.length = 0;
    const snap = await api.useCurrentDefaults();
    expect(snap.profile).toBe('P2');
    const status = await api.checkLab();
    expect(status?.lab).toBe('ccna1-switched-lan');
    expect((await api.exportTopology()).lab?.name).toBe('ccna1-switched-lan');
  });
});

describe('withCurrentDefaults (the pure move)', () => {
  const model = (lines: string[]): Pick<DeviceModel, 'profileConfig'> => ({ profileConfig: { P2: lines } });
  const models: Record<string, Pick<DeviceModel, 'profileConfig'>> = {
    'switch.l3': model(['spanning-tree mode pvst', 'no ip routing']),
    'switch.l2': model(['spanning-tree mode pvst']),
    'router.r': model([]),
  };
  const modelOf = (type: string): Pick<DeviceModel, 'profileConfig'> | undefined => models[type];

  function topo(devices: { name: string; type: string; runningConfig?: string; config?: string }[]): Topology {
    return { schema: '1.1', seed: 1, devices: devices.map((d, i) => ({ id: `d${i}`, ...d })), links: [] } as unknown as Topology;
  }

  it('appends `ip routing` to a multilayer switch whose configuration says nothing about it', async () => {
    const { mod } = await freshWorker({ seed: 1 });
    const out = mod.withCurrentDefaults(
      topo([
        { name: 'MLS', type: 'switch.l3', runningConfig: 'hostname MLS\n' },
        { name: 'MLS2', type: 'switch.l3', runningConfig: 'hostname MLS2' },
        { name: 'MLS3', type: 'switch.l3' },
      ]),
      modelOf,
    );
    expect(configOf(out, 'MLS')).toBe('hostname MLS\nip routing\n');
    expect(configOf(out, 'MLS2')).toBe('hostname MLS2\nip routing\n');
    expect(configOf(out, 'MLS3')).toBe('ip routing\n');
    expect(out.profile).toBe('P2');
    expect(out.schema).toBe(schemaIdFor(out));
    expect(out.schema).not.toBe('1.1');
  });

  it('leaves a configuration that already decides the slot alone, either way', async () => {
    const { mod } = await freshWorker({ seed: 1 });
    const out = mod.withCurrentDefaults(
      topo([
        { name: 'ON', type: 'switch.l3', runningConfig: 'hostname ON\nip routing\n' },
        { name: 'OFF', type: 'switch.l3', runningConfig: 'hostname OFF\nno ip routing\n' },
        { name: 'IND', type: 'switch.l3', runningConfig: 'hostname IND\n  ip routing\n' },
      ]),
      modelOf,
    );
    expect(configOf(out, 'ON')).toBe('hostname ON\nip routing\n');
    expect(configOf(out, 'OFF')).toBe('hostname OFF\nno ip routing\n');
    expect(configOf(out, 'IND')).toBe('hostname IND\n  ip routing\n');
  });

  it('touches no device whose P2 defaults do not replay `no ip routing`, and none of an unknown type', async () => {
    const { mod } = await freshWorker({ seed: 1 });
    const input = topo([
      { name: 'SW', type: 'switch.l2', runningConfig: 'hostname SW\n' },
      { name: 'R1', type: 'router.r', config: 'hostname R1\n' },
      { name: 'X', type: 'gone.model', runningConfig: 'hostname X\n' },
    ]);
    const out = mod.withCurrentDefaults(input, modelOf);
    expect(out.devices.map((d) => d.runningConfig ?? d.config)).toEqual(input.devices.map((d) => d.runningConfig ?? d.config));
    expect(out.devices[0]).toBe(input.devices[0]);
    expect(out.profile).toBe('P2');
    // The input is not mutated.
    expect(input.profile).toBeUndefined();
    expect(input.schema).toBe('1.1');
  });

  it('reads the running configuration first and falls back to the startup one', async () => {
    const { mod } = await freshWorker({ seed: 1 });
    const out = mod.withCurrentDefaults(topo([{ name: 'A', type: 'switch.l3', config: 'hostname A\n', runningConfig: 'hostname A\nip routing\n' }]), modelOf);
    expect(out.devices[0]?.runningConfig).toBe('hostname A\nip routing\n');
    const out2 = mod.withCurrentDefaults(topo([{ name: 'B', type: 'switch.l3', config: 'hostname B\nip routing\n' }]), modelOf);
    expect(out2.devices[0]?.runningConfig).toBeUndefined();
    expect(out2.devices[0]?.config).toBe('hostname B\nip routing\n');
  });

  it('classicDefaultsChip reads the moved snapshot as current', () => {
    expect(classicDefaultsChip({ profile: 'P2' } as SimSnapshot)).toBeNull();
    expect(classicDefaultsChip({} as SimSnapshot)?.label).toBe('Classic defaults');
  });
});
