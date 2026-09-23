/**
 * W1 device (ARCHITECTURE-P2 D2, §2.9, §4.4): the defaults profile of a device — `DeviceSpec.profile` (absent = P1),
 * `DeviceRuntime.profile`, `ProcessCtx.profile`, and the `profileConfig` replay at EVERY boot, after `defaultConfig`
 * and before the saved configuration. Hand-built models (no catalog model carries `profileConfig` before W4/W6).
 */
import { describe, expect, it } from 'vitest';
import { profileIncludes, type DefaultsProfile } from '../src/contracts/catalog.js';
import type { DeviceModel } from '../src/contracts/device.js';
import type { ProcessName } from '../src/contracts/ids.js';
import type { DebugEvent, Process, ProcessCtx, StateView } from '../src/contracts/process.js';
import { NF_C2960 } from '../src/device/catalog.js';
import { deviceDefaultLines, profileConfigLines } from '../src/device/device.js';
import { p2Harness } from './device.p2.harness.js';

const DEFAULT_LINE = 'ip domain-name defaults.example';
const P1_LINE = 'ip name-server 10.0.0.53';
const P2_LINES = ['spanning-tree mode pvst', 'spanning-tree extend system-id', 'ip domain-name profile.example', 'interface Vlan1', ' description managed by the profile'];

/** A switch whose model carries default lines and the profile lines of both keys. */
const PROFILE_MODEL: DeviceModel = {
  ...NF_C2960,
  processes: ['eth-switch'],
  defaultConfig: [DEFAULT_LINE],
  profileConfig: { P1: [P1_LINE], P2: P2_LINES },
};

/**
 * The same switch without any profile lines. Since the W4 flip the live NF-C2960 carries its own P2 profile lines
 * (and a model may carry a spanning-tree default mode), so both are taken out before the spread (§9.2 W4 fixture pins).
 */
const { profileConfig: _liveProfileConfig, stpDefaultMode: _liveStpDefaultMode, ...NF_C2960_WITHOUT_PROFILE } = NF_C2960;
const PLAIN_MODEL: DeviceModel = { ...NF_C2960_WITHOUT_PROFILE, processes: ['eth-switch'], defaultConfig: [DEFAULT_LINE] };

/** A fake eth-switch that only remembers its ctx. */
function ctxFake(name: ProcessName): { factory: () => Process; ctx: () => ProcessCtx | undefined } {
  let seen: ProcessCtx | undefined;
  const proc: Process = {
    name,
    init(ctx) {
      seen = ctx;
      return [];
    },
    onPdu: () => [],
    onTimer: () => [],
    onConfig(ctx) {
      seen = ctx;
      return [];
    },
    stateSnapshot: (): StateView => ({ process: name, state: {} }),
    debugEvents: (): readonly DebugEvent[] => [],
  };
  return { factory: () => proc, ctx: () => seen };
}

function boot(model: DeviceModel, profile?: DefaultsProfile, startupConfig?: string) {
  const fake = ctxFake('eth-switch');
  const h = p2Harness({
    model,
    processes: { 'eth-switch': fake.factory },
    ...(profile !== undefined ? { profile } : {}),
    ...(startupConfig !== undefined ? { startupConfig } : {}),
  });
  h.run();
  return { h, ctx: () => fake.ctx() };
}

/** The config lines a boot applied, in order, each with its context path. */
const applied = (h: ReturnType<typeof p2Harness>): string[] =>
  h.kinds('configChange').map((e) => (e.context.length === 0 ? e.line : `${e.context.map((c) => c.join(' ')).join('/')}: ${e.line}`));

describe('profileConfigLines / deviceDefaultLines (the default lines D of D2)', () => {
  it('takes every key the profile includes, in DEFAULTS_PROFILES order', () => {
    expect(profileConfigLines(PROFILE_MODEL, 'P1')).toEqual([[P1_LINE]]);
    expect(profileConfigLines(PROFILE_MODEL, 'P2')).toEqual([[P1_LINE], P2_LINES]);
    expect(profileConfigLines(PLAIN_MODEL, 'P2')).toEqual([]);
    expect(profileConfigLines({ profileConfig: { P2: [] } }, 'P2')).toEqual([]);
    expect(profileIncludes('P1', 'P2')).toBe(false);
    expect(profileIncludes('P2', 'P1')).toBe(true);
  });

  it('deviceDefaultLines is defaultConfig followed by the included profile lines', () => {
    expect(deviceDefaultLines(PROFILE_MODEL, 'P1')).toEqual([DEFAULT_LINE, P1_LINE]);
    expect(deviceDefaultLines(PROFILE_MODEL, 'P2')).toEqual([DEFAULT_LINE, P1_LINE, ...P2_LINES]);
    expect(deviceDefaultLines(PLAIN_MODEL, 'P1')).toEqual([DEFAULT_LINE]);
  });
});

describe('boot replay order (D2: defaultConfig, profileConfig, saved configuration)', () => {
  it('a P1 world replays only the P1 key: no P2 default reaches the running configuration', () => {
    const { h } = boot(PROFILE_MODEL);
    expect(h.device.profile).toBe('P1');
    expect(applied(h)).toEqual([DEFAULT_LINE, P1_LINE]);
    const text = h.device.running.render();
    expect(text).toContain(DEFAULT_LINE);
    expect(text).toContain(P1_LINE);
    expect(text).not.toContain('spanning-tree');
    expect(text).not.toContain('managed by the profile');
  });

  it('a P2 world replays both keys, in order, after the model defaults and before the saved configuration', () => {
    const { h } = boot(PROFILE_MODEL, 'P2', 'ip domain-name saved.example\ninterface FastEthernet0/1\n description saved line\n');
    expect(h.device.profile).toBe('P2');
    expect(applied(h)).toEqual([
      DEFAULT_LINE,
      P1_LINE,
      'spanning-tree mode pvst',
      'spanning-tree extend system-id',
      'ip domain-name profile.example',
      'interface Vlan1: description managed by the profile',
      'interface Vlan1: shutdown', // the section rule's implied default for an SVI (config-ast), applied like any replayed line
      'ip domain-name saved.example',
      'interface FastEthernet0/1: description saved line',
    ]);
    const text = h.device.running.render();
    expect(text).toContain('spanning-tree mode pvst');
    expect(text).toContain('spanning-tree extend system-id');
    // the saved line replaces the profile line in the same slot; the profile line before it is gone
    expect(text).toContain('ip domain-name saved.example');
    expect(text).not.toContain('ip domain-name profile.example');
    expect(text).toContain('description managed by the profile');
  });

  it('replays at EVERY boot: a reload rebuilds the profile lines the lost running configuration held', () => {
    const { h } = boot(PROFILE_MODEL, 'P2');
    expect(h.device.running.render()).toContain('spanning-tree mode pvst');
    h.events.length = 0;
    h.device.reload(1_000_000);
    h.run();
    expect(applied(h)).toEqual([
      DEFAULT_LINE,
      P1_LINE,
      'spanning-tree mode pvst',
      'spanning-tree extend system-id',
      'ip domain-name profile.example',
      'interface Vlan1: description managed by the profile',
      'interface Vlan1: shutdown', // the section rule's implied default for an SVI (config-ast), applied like any replayed line
    ]);
    expect(h.device.running.render()).toContain('spanning-tree mode pvst');
  });

  it('a model without profile lines boots identically in both profiles', () => {
    const p1 = boot(PLAIN_MODEL);
    const p2 = boot(PLAIN_MODEL, 'P2');
    expect(applied(p1.h)).toEqual([DEFAULT_LINE]);
    expect(applied(p2.h)).toEqual([DEFAULT_LINE]);
    expect(p1.h.device.running.render()).toBe(p2.h.device.running.render());
  });
});

describe('the profile reaches the daemons (D2: invisible defaults)', () => {
  it('ProcessCtx.profile is the world profile; absent on the spec means P1', () => {
    const p1 = boot(PLAIN_MODEL);
    expect(p1.ctx()?.profile).toBe('P1');
    const p2 = boot(PLAIN_MODEL, 'P2');
    expect(p2.ctx()?.profile).toBe('P2');
    expect(p2.h.device.profile).toBe('P2');
    // explicitly P1 is the same as absent
    expect(boot(PLAIN_MODEL, 'P1').h.device.profile).toBe('P1');
  });
});
