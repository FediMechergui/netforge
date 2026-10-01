/**
 * sim — "Use current defaults" as a ladder in the engine (ARCHITECTURE-P3 D2, §2.14, §7 W1 sim; sim/defaults-upgrade.ts).
 *
 * The first block carries the cases of the worker's pure `withCurrentDefaults` suite (apps/web
 * `worker.profile.test.ts:195-264`) as engine cases, with the same inputs and assertions (the worker delegates to this
 * file from W2, §9.2 item 25; the suite's `classicDefaultsChip` case is a web component's and stays there). The second
 * block pins the ladder: the step to P2 keeps P2's `ip routing` preservation, the step to P3 rewrites no line, every
 * step sets the profile and `schemaIdFor`'s schema in the same step, the input is never mutated, the ladder never
 * lowers a profile, and an unknown profile is refused.
 */
import { describe, expect, it } from 'vitest';
import { DEFAULTS_PROFILES, LATEST_DEFAULTS_PROFILE, type DefaultsProfile } from '../src/contracts/catalog.js';
import type { DeviceModel } from '../src/contracts/device.js';
import { SEC } from '../src/contracts/time.js';
import { TOPOLOGY_SCHEMA_ID_1_2, TOPOLOGY_SCHEMA_ID_1_3, schemaIdFor, type Topology } from '../src/contracts/topology.js';
import { createCatalog } from '../src/device/catalog.js';
import { PROCESS_FACTORIES } from '../src/protocols/index.js';
import { DEFAULTS_UPGRADE_STEPS, upgradeDefaults, withCurrentDefaults, type ProfileConfigOf } from '../src/sim/defaults-upgrade.js';
import { createSimulation } from '../src/sim/simulation.js';

const configOf = (t: Topology, name: string): string => {
  const d = t.devices.find((x) => x.name === name);
  if (d === undefined) throw new Error(`no device ${name}`);
  return d.runningConfig ?? d.config ?? '';
};

describe('withCurrentDefaults (the pure move; the worker suite as engine cases)', () => {
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

  it('appends `ip routing` to a multilayer switch whose configuration says nothing about it', () => {
    const out = withCurrentDefaults(
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

  it('leaves a configuration that already decides the slot alone, either way', () => {
    const out = withCurrentDefaults(
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

  it('touches no device whose P2 defaults do not replay `no ip routing`, and none of an unknown type', () => {
    const input = topo([
      { name: 'SW', type: 'switch.l2', runningConfig: 'hostname SW\n' },
      { name: 'R1', type: 'router.r', config: 'hostname R1\n' },
      { name: 'X', type: 'gone.model', runningConfig: 'hostname X\n' },
    ]);
    const out = withCurrentDefaults(input, modelOf);
    expect(out.devices.map((d) => d.runningConfig ?? d.config)).toEqual(input.devices.map((d) => d.runningConfig ?? d.config));
    expect(out.devices[0]).toBe(input.devices[0]);
    expect(out.profile).toBe('P2');
    // The input is not mutated.
    expect(input.profile).toBeUndefined();
    expect(input.schema).toBe('1.1');
  });

  it('reads the running configuration first and falls back to the startup one', () => {
    const out = withCurrentDefaults(topo([{ name: 'A', type: 'switch.l3', config: 'hostname A\n', runningConfig: 'hostname A\nip routing\n' }]), modelOf);
    expect(out.devices[0]?.runningConfig).toBe('hostname A\nip routing\n');
    const out2 = withCurrentDefaults(topo([{ name: 'B', type: 'switch.l3', config: 'hostname B\nip routing\n' }]), modelOf);
    expect(out2.devices[0]?.runningConfig).toBeUndefined();
    expect(out2.devices[0]?.config).toBe('hostname B\nip routing\n');
  });
});

describe('upgradeDefaults (the ladder)', () => {
  const modelOf: ProfileConfigOf = (type) =>
    type === 'switch.l3' ? { profileConfig: { P2: ['no ip routing'], P3: ['service timestamps log datetime msec'] } } : undefined;
  const at = (profile: 'P2' | 'P3' | undefined, devices: { name: string; type: string; runningConfig?: string }[]): Topology => {
    const t = { schema: 'netforge.topology/1.1', seed: 1, devices: devices.map((d, i) => ({ id: `d${i}`, ...d })), links: [] } as unknown as Topology;
    if (profile === undefined) return t;
    const withProfile: Topology = { ...t, profile };
    return { ...withProfile, schema: schemaIdFor(withProfile) };
  };
  const mls = { name: 'MLS', type: 'switch.l3', runningConfig: 'hostname MLS\n' };

  it('has one step per profile after P1, in profile order', () => {
    expect(DEFAULTS_UPGRADE_STEPS.map((s) => s.to)).toEqual(DEFAULTS_PROFILES.slice(1));
    expect(DEFAULTS_UPGRADE_STEPS.map((s) => s.to)).toEqual(['P2', 'P3']);
    expect(DEFAULTS_UPGRADE_STEPS[1]?.device).toBeUndefined();
  });

  it('defaults to LATEST_DEFAULTS_PROFILE, and withCurrentDefaults is that ladder', () => {
    const input = at(undefined, [mls]);
    expect(upgradeDefaults(input, modelOf)).toEqual(upgradeDefaults(input, modelOf, LATEST_DEFAULTS_PROFILE));
    expect(withCurrentDefaults(input, modelOf)).toEqual(upgradeDefaults(input, modelOf, LATEST_DEFAULTS_PROFILE));
    expect(withCurrentDefaults(input, modelOf).profile).toBe(LATEST_DEFAULTS_PROFILE);
  });

  it('the step to P3 rewrites no line: only the profile and the schema change', () => {
    const p2 = at('P2', [mls, { name: 'SW', type: 'switch.l2', runningConfig: 'hostname SW\n' }]);
    const out = upgradeDefaults(p2, modelOf, 'P3');
    expect(out.profile).toBe('P3');
    expect(out.schema).toBe(TOPOLOGY_SCHEMA_ID_1_3);
    expect(out.schema).toBe(schemaIdFor(out));
    expect(out.devices).toBe(p2.devices);
    expect({ ...out, profile: undefined, schema: undefined }).toEqual({ ...p2, profile: undefined, schema: undefined });
    expect(p2.profile).toBe('P2');
  });

  it('a P1 world taken to P3 climbs both steps: `ip routing` kept, then profile P3', () => {
    const input = at(undefined, [mls]);
    const out = upgradeDefaults(input, modelOf, 'P3');
    expect(configOf(out, 'MLS')).toBe('hostname MLS\nip routing\n');
    expect(out.profile).toBe('P3');
    expect(out.schema).toBe(TOPOLOGY_SCHEMA_ID_1_3);
    expect(upgradeDefaults(input, modelOf, 'P2').schema).toBe(TOPOLOGY_SCHEMA_ID_1_2);
    expect(out.schema).toBe(schemaIdFor(out));
    expect(out).toEqual({ ...upgradeDefaults(input, modelOf, 'P2'), profile: 'P3', schema: schemaIdFor(out) });
    expect(input.profile).toBeUndefined();
    expect(configOf(input, 'MLS')).toBe('hostname MLS\n');
  });

  it('never lowers a profile and never repeats a step: a world at or above the target is returned as it is', () => {
    const p2 = at('P2', [mls]);
    expect(upgradeDefaults(p2, modelOf, 'P2')).toBe(p2);
    expect(upgradeDefaults(p2, modelOf, 'P1')).toBe(p2);
    const p3 = at('P3', [mls]);
    expect(upgradeDefaults(p3, modelOf, 'P2')).toBe(p3);
    expect(upgradeDefaults(p3, modelOf, 'P3')).toBe(p3);
    const p1 = at(undefined, [mls]);
    expect(upgradeDefaults(p1, modelOf, 'P1')).toBe(p1);
  });

  it('refuses an unknown target or document profile before anything is copied', () => {
    const input = at(undefined, [mls]);
    expect(() => upgradeDefaults(input, modelOf, 'P4' as DefaultsProfile)).toThrow(new RangeError('profile must be one of P1, P2, P3, got P4'));
    const odd = { ...input, profile: 'P9' } as unknown as Topology;
    expect(() => upgradeDefaults(odd, modelOf, 'P3')).toThrow(new RangeError('the document profile must be one of P1, P2, P3, got P9'));
  });

  it('on a real classic world with the real catalog: the multilayer switch keeps routing, P3 adds nothing more', () => {
    const sim = createSimulation({ seed: 7 });
    const catalog = createCatalog(PROCESS_FACTORIES);
    const modelOfReal: ProfileConfigOf = (type) => catalog.get(type);
    const mlsId = sim.addDevice({ type: 'mlswitch.nfc3650-24', name: 'MLS1' });
    sim.addDevice({ type: 'switch.nfc2960', name: 'SW1' });
    sim.addDevice({ type: 'router.nf2911', name: 'R1' });
    sim.addDevice({ type: 'pc.nfpc', name: 'PC1' });
    sim.runFor(120 * SEC);
    const exported = sim.exportTopology();
    expect(exported.profile).toBeUndefined();
    expect(catalog.get('mlswitch.nfc3650-24')?.profileConfig?.P2).toContain('no ip routing');
    const p2 = upgradeDefaults(exported, modelOfReal, 'P2');
    const p3 = upgradeDefaults(exported, modelOfReal, 'P3');
    expect(p2.profile).toBe('P2');
    expect(p3.profile).toBe('P3');
    expect(p3.devices).toEqual(p2.devices);
    const before = configOf(exported, 'MLS1');
    expect(configOf(p2, 'MLS1')).toBe(`${before.endsWith('\n') || before === '' ? before : `${before}\n`}ip routing\n`);
    expect(p2.devices.find((d) => d.id === mlsId)?.runningConfig).toBe(configOf(p2, 'MLS1'));
    for (const d of exported.devices) {
      if (d.id !== mlsId) expect(p2.devices.find((x) => x.id === d.id)).toBe(d);
    }
  });
});
