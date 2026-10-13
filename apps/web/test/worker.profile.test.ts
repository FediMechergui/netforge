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
 * P3 W7, the course and profile flip (ARCHITECTURE-P3 §8.5 P15, §9.2 item 42, §10.2): the current defaults are 'P3'.
 * "Use current defaults" gives P3 (and is a no-op on a P3 world); a P2 world is moved to P3 as well, every
 * configuration line kept; with no lesson the app starts a P3 world. The pure move's profile pins follow the same
 * ladder end (P3), and the CCNA 3 course gives P3.
 *
 * The worker module is imported with Comlink mocked and wall timers faked, as in worker.delta.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SCENARIOS, schemaIdFor } from '@netforge/engine';
import type { DefaultsProfile, DeviceModel, SimSnapshot, Topology } from '@netforge/engine';
import { classicDefaultsChip } from '../src/app/StatusBar';
import { startupProfile } from '../src/bridge/client';
import type { EngineApi, EngineBatch } from '../src/bridge/protocol';
import { CURRENT_DEFAULTS_IN_USE, currentDefaultsItem, profileForCourse, profileOfSnapshot } from '../src/learn/course-profile';
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
// ARCHITECTURE-P3 ruling R28: `vi.resetModules()` gives each test a fresh worker, but the engine behind it is pure,
// so it is evaluated once per file and kept: a manual mock that returns the real module is cached apart from the
// module registry, which `vi.resetModules()` leaves alone. Only the worker's own modules are evaluated again.
vi.mock('@netforge/engine', async (importOriginal) => await importOriginal());

const WORKER = '../src/bridge/worker/index.ts';
type WorkerModule = { withCurrentDefaults(t: Topology, modelOf: (type: string) => Pick<DeviceModel, 'profileConfig'> | undefined): Topology };

async function freshWorker(init: { seed: number; profile?: DefaultsProfile }): Promise<{ api: EngineApi; batches: EngineBatch[]; mod: WorkerModule }> {
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
  it('startupProfile follows the course of the last lesson, and is the latest profile with no lesson', () => {
    expect(startupProfile()).toBe('P3');
    store.getState().setLastCourse('ccna1');
    expect(startupProfile()).toBe('P1');
    store.getState().setLastCourse('ccna2');
    expect(startupProfile()).toBe('P2');
    store.getState().setLastCourse('ccna3');
    expect(startupProfile()).toBe('P3');
    store.getState().setLastCourse(null);
    expect(startupProfile()).toBe('P3');
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
    expect(after.profile).toBe('P3');
    expect(classicDefaultsChip(after)).toBeNull();
    expect(after.devices.map((d) => d.name).sort()).toEqual(before.devices.map((d) => d.name).sort());
    expect(after.links).toHaveLength(before.links.length);

    const posted = last(batches);
    expect(posted.snapshot?.profile).toBe('P3');
    expect(posted.epoch).not.toBe(epochBefore);

    const afterTopo = await api.exportTopology();
    expect(afterTopo.profile).toBe('P3');
    expect(afterTopo.schema).toBe(schemaIdFor(afterTopo));
    // Nothing in a plain PC-and-switch world needs a routing line: every configuration is byte-identical.
    for (const d of beforeTopo.devices) expect(configOf(afterTopo, d.name)).toBe(configOf(beforeTopo, d.name));
  });

  it('is a no-op on a world already at the current defaults', async () => {
    const { api } = await freshWorker({ seed: 7, profile: 'P3' });
    await api.addDevice({ type: 'pc.nfpc', position: { x: 0, y: 0 } });
    const before = await api.exportTopology();
    const snap = await api.useCurrentDefaults();
    expect(snap.profile).toBe('P3');
    const after = await api.exportTopology();
    expect(after.devices.map((d) => d.runningConfig ?? d.config)).toEqual(before.devices.map((d) => d.runningConfig ?? d.config));
  });

  // P3 W7 (§9.2 item 42): the current defaults are P3, so a P2 world (a saved P2 file, a CCNA 2 lesson's sandbox) is
  // offered the move too, and the move keeps every device and every configuration line (the P3 step rewrites none).
  it('moves a P2 world to P3 in place: devices and configurations kept, schema 1.3, a new epoch', async () => {
    const { api, batches } = await freshWorker({ seed: 7, profile: 'P2' });
    for (const [i, type] of ['router.nf2911', 'switch.nfc2960', 'pc.nfpc'].entries()) {
      await api.addDevice({ type, position: { x: 100 * i, y: 0 } });
    }
    const before = await api.snapshot();
    const beforeTopo = await api.exportTopology();
    expect(beforeTopo.profile).toBe('P2');
    expect(beforeTopo.schema).toBe('netforge.topology/1.2');
    expect(classicDefaultsChip(before)).toBeNull();
    expect(currentDefaultsItem(profileOfSnapshot(before)).enabled).toBe(true);
    const epochBefore = last(batches).epoch;
    batches.length = 0;

    const after = await api.useCurrentDefaults();
    expect(after.profile).toBe('P3');
    expect(classicDefaultsChip(after)).toBeNull();
    expect(currentDefaultsItem(profileOfSnapshot(after))).toEqual({ enabled: false, hint: CURRENT_DEFAULTS_IN_USE });
    expect(after.devices.map((d) => d.name)).toEqual(before.devices.map((d) => d.name));
    const posted = last(batches);
    expect(posted.snapshot?.profile).toBe('P3');
    expect(posted.epoch).not.toBe(epochBefore);

    const afterTopo = await api.exportTopology();
    expect(afterTopo.profile).toBe('P3');
    expect(afterTopo.schema).toBe('netforge.topology/1.3');
    expect(afterTopo.schema).toBe(schemaIdFor(afterTopo));
    expect(afterTopo.devices.map((d) => d.type)).toEqual(['router.nf2911', 'switch.nfc2960', 'pc.nfpc']);
    for (const d of beforeTopo.devices) expect(configOf(afterTopo, d.name)).toBe(configOf(beforeTopo, d.name));
  });

  it('keeps the lab of a CCNA 1 lab world', async () => {
    const meta = SCENARIOS.find((s) => s.name === 'ccna1-switched-lan');
    expect(meta).toBeDefined();
    const { api, batches } = await freshWorker({ seed: 7 });
    await api.loadScenario('ccna1-switched-lan');
    expect(classicDefaultsChip(await api.snapshot())?.label).toBe('Classic defaults');
    batches.length = 0;
    const snap = await api.useCurrentDefaults();
    expect(snap.profile).toBe('P3');
    const status = await api.checkLab();
    expect(status?.lab).toBe('ccna1-switched-lan');
    expect((await api.exportTopology()).lab?.name).toBe('ccna1-switched-lan');
  });
});

// W7 fix (review finding #0): since the flip the move is offered to P2 worlds, and a CCNA 2 troubleshooting lab is one.
// The move reloads the world, which drops the faults the lab scheduled (`applyFaults` runs on loadScenario only) and
// the ports they err-disabled, so a Check right after it gave full marks for troubleshooting nothing. The worker now
// refuses the move while the active lab schedules faults, and leaves the world, its epoch and its lab untouched.
describe('"Use current defaults" in a lab that schedules faults (W7 fix, review finding #0)', () => {
  const SEC = 1_000_000_000;
  type RefusalModule = WorkerModule & { CURRENT_DEFAULTS_LAB_FAULTS: string };
  const FAULT_LABS = ['ccna2-troubleshoot-routing', 'ccna2-troubleshoot-vlans', 'ccna2-stp-guards'] as const;

  it('names every P1 or P2 lab that schedules faults, so the cases below cover them all', () => {
    const below = SCENARIOS.filter((sc) => (sc.faults?.length ?? 0) > 0 && profileOfTopology(sc.build()) !== 'P3').map((sc) => sc.name);
    expect([...below].sort()).toEqual([...FAULT_LABS].sort());
  });

  for (const name of FAULT_LABS) {
    it(`refuses the move in ${name}: the world, its epoch, its profile and its lab are untouched`, async () => {
      const { api, batches, mod } = await freshWorker({ seed: 7 });
      await api.loadScenario(name);
      await api.stepTime(10 * SEC);
      const before = await api.exportTopology();
      expect(before.profile).toBe('P2');
      const epochBefore = last(batches).epoch;
      const posted = batches.length;

      await expect(api.useCurrentDefaults()).rejects.toThrow((mod as RefusalModule).CURRENT_DEFAULTS_LAB_FAULTS);
      expect((mod as RefusalModule).CURRENT_DEFAULTS_LAB_FAULTS).toMatch(/hidden faults/);
      expect(batches.length).toBe(posted);
      expect(last(batches).epoch).toBe(epochBefore);
      expect((await api.snapshot()).profile).toBe('P2');
      expect(await api.exportTopology()).toEqual(before);
      expect((await api.checkLab())?.lab).toBe(name);
    });
  }

  it('keeps the troubleshooting: the routing lab still has its faults and its err-disabled port after the refusal', async () => {
    const { api } = await freshWorker({ seed: 7 });
    await api.loadScenario('ccna2-troubleshoot-routing');
    await api.stepTime(10 * SEC);
    await expect(api.useCurrentDefaults()).rejects.toThrow();
    await api.stepTime(90 * SEC);
    const status = await api.checkLab();
    expect(status?.lab).toBe('ccna2-troubleshoot-routing');
    // Nothing was repaired, so no task passes (the move used to make all four pass).
    expect(status?.results.filter((r) => r.pass).map((r) => r.task)).toEqual([]);
    expect(status?.results.find((r) => r.task === 'server-port')?.pass).toBe(false);
  });
});

function profileOfTopology(t: Topology): DefaultsProfile {
  return t.profile ?? 'P1';
}

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
    expect(out.profile).toBe('P3');
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
    expect(out.profile).toBe('P3');
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
