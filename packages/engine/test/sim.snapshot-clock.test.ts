/**
 * sim.snapshot-clock — `DeviceSnapshot.clock` (ARCHITECTURE-P3 D19, §2.8; §7 W2 sim; sim/snapshot-cache.ts
 * `deviceClockSnapshot`) and `SimSnapshot.profile` 'P3'.
 *
 * The member is the device clock as a line `{source, baseUnixMs, baseAt, stratum?, reference?, tzOffsetMin}`: the
 * clock reads `baseUnixMs + (t − baseAt) / 10⁶` ms at any t, exactly, with `baseAt` the first SimTime (below 1 ms) at
 * which it reads a whole millisecond, so the member is the SAME value at every snapshot until the clock is set or
 * synchronised (it never dirties a device per tick). Present for a booted device of a P3 world (routers unset, hosts on
 * true time), and in a P1/P2 world only once a user or a synchronisation set the clock; absent while a device is off or
 * booting. P1 and P2 worlds with untouched clocks carry none, so no golden moves.
 */
import { describe, expect, it } from 'vitest';
import { NF_CLOCK_UNSET_UNIX_MS, NF_WORLD_EPOCH_UNIX_MS, type DeviceClockView } from '../src/contracts/clock.js';
import type { DeviceRuntime } from '../src/contracts/device.js';
import type { DeviceSnapshot } from '../src/contracts/snapshot.js';
import type { Simulation } from '../src/contracts/simulation.js';
import { MS, SEC, type SimTime } from '../src/contracts/time.js';
import { CLOCK_SNAPSHOT_SOURCES, deviceClockSnapshot } from '../src/sim/snapshot-cache.js';
import { createSimulation } from '../src/sim/simulation.js';
import { P3_DEVICE, UNSET_CLOCK_VIEW } from './port.fixtures.js';
import { createStagedSimulation } from './staged.world.js';

const BOOT = 60 * SEC;

/** A router and a PC, booted, in a world of `profile` (P3 on staged.world at stage P3; P1/P2 on the real catalog). */
function world(profile: 'P1' | 'P2' | 'P3', routerConfig?: string): Simulation {
  const sim = profile === 'P3' ? createStagedSimulation({ seed: 21, stage: 'P3' }) : profile === 'P2' ? createStagedSimulation({ seed: 21, stage: 'P2' }) : createSimulation({ seed: 21 });
  sim.addDevice({ id: 'r1', type: 'router.nf2911', name: 'R1', ...(routerConfig === undefined ? {} : { startupConfig: routerConfig }) });
  sim.addDevice({ id: 'pc1', type: 'pc.nfpc', name: 'PC1' });
  sim.runFor(BOOT);
  return sim;
}

const deviceOf = (sim: Simulation, id: string): DeviceSnapshot => sim.snapshot().devices.find((d) => d.id === id)!;

/** The clock in whole ms and the sub-ms remainder, extrapolated from a snapshot member at `t`. */
function extrapolate(clock: NonNullable<DeviceSnapshot['clock']>, t: SimTime): { unixMs: number; subMsNs: number } {
  const elapsed = t - clock.baseAt;
  const sub = elapsed % 1_000_000;
  return { unixMs: clock.baseUnixMs + (elapsed - sub) / 1_000_000, subMsNs: sub };
}

describe('DeviceSnapshot.clock in a P3 world', () => {
  it('a booted router shows its unset clock, a host true time; the snapshot profile is P3', () => {
    const sim = world('P3');
    const snap = sim.snapshot();
    expect(snap.profile).toBe('P3');
    const r1 = snap.devices.find((d) => d.id === 'r1')!;
    const pc1 = snap.devices.find((d) => d.id === 'pc1')!;
    expect(r1.clock).toMatchObject({ source: 'unset', tzOffsetMin: 0 });
    expect(pc1.clock).toEqual({ source: 'host', baseUnixMs: NF_WORLD_EPOCH_UNIX_MS, baseAt: 0, tzOffsetMin: 0 });
    // the router's line starts at its boot: unset + uptime
    const booted = sim.device('r1')!.bootedAt!;
    expect(extrapolate(r1.clock!, booted)).toEqual({ unixMs: NF_CLOCK_UNSET_UNIX_MS, subMsNs: 0 });
    // the member is the last of the device (appended after every older member)
    expect(Object.keys(r1).at(-1)).toBe('clock');
  });

  it('is exact at any instant and the same value at every snapshot until the clock is set', () => {
    const sim = world('P3');
    const first = deviceOf(sim, 'r1').clock!;
    for (const dt of [1, 999_999, 1_234_567, 37 * SEC + 3]) {
      sim.runFor(dt);
      const dev = sim.device('r1')!;
      const view = dev.clockView(sim.now);
      expect(extrapolate(first, sim.now)).toEqual({ unixMs: view.unixMs, subMsNs: view.subMsNs });
      expect(deviceOf(sim, 'r1').clock).toEqual(first);
    }
    expect(first.baseAt).toBeGreaterThanOrEqual(0);
    expect(first.baseAt).toBeLessThan(1_000_000);
  });

  it('a set and a sync change the member once, with the source, stratum and reference; the zone comes from config', () => {
    const sim = world('P3', 'hostname R1\nclock timezone CET 1\n');
    const before = deviceOf(sim, 'r1').clock!;
    expect(before.tzOffsetMin).toBe(60);
    const dev = sim.device('r1')!;
    dev.setClock({ type: 'clock', op: 'step', offsetNs: '1500000123', source: 'ntp', stratum: 3, reference: '10.0.0.10' }, sim.now);
    const synced = deviceOf(sim, 'r1').clock!;
    expect(synced).toMatchObject({ source: 'ntp', stratum: 3, reference: '10.0.0.10', tzOffsetMin: 60 });
    expect(synced).not.toEqual(before);
    const view = dev.clockView(sim.now);
    expect(extrapolate(synced, sim.now)).toEqual({ unixMs: view.unixMs, subMsNs: view.subMsNs });
    sim.runFor(5 * SEC);
    expect(deviceOf(sim, 'r1').clock).toEqual(synced);
  });

  it('a device that is off or still booting shows none; power-off forgets the clock', () => {
    const sim = createStagedSimulation({ seed: 4, stage: 'P3' });
    sim.addDevice({ id: 'r1', type: 'router.nf2911', name: 'R1' });
    expect(deviceOf(sim, 'r1')).not.toHaveProperty('clock'); // booting
    sim.runFor(BOOT);
    expect(deviceOf(sim, 'r1').clock?.source).toBe('unset');
    sim.setPower('r1', false);
    expect(deviceOf(sim, 'r1')).not.toHaveProperty('clock');
  });
});

describe('DeviceSnapshot.clock in P1 and P2 worlds', () => {
  for (const profile of ['P1', 'P2'] as const) {
    it(`${profile}: untouched clocks show nothing; a user's set shows the clock from then on`, () => {
      const sim = world(profile);
      const snap = sim.snapshot();
      expect(snap.profile).toBe(profile === 'P1' ? undefined : 'P2');
      for (const d of snap.devices) expect(d, d.id).not.toHaveProperty('clock');
      const dev = sim.device('r1')!;
      dev.setClock({ type: 'clock', op: 'set', unixMs: NF_WORLD_EPOCH_UNIX_MS + 42 * SEC / MS, source: 'user' }, sim.now);
      const clock = deviceOf(sim, 'r1').clock!;
      expect(clock.source).toBe('user');
      expect(extrapolate(clock, sim.now)).toEqual({ unixMs: NF_WORLD_EPOCH_UNIX_MS + 42_000, subMsNs: 0 });
      expect(deviceOf(sim, 'pc1')).not.toHaveProperty('clock');
    });
  }

  it('the sources a P1/P2 world shows are exactly user, ntp and master', () => {
    expect(CLOCK_SNAPSHOT_SOURCES).toEqual(['user', 'ntp', 'master']);
    const fake = (view: DeviceClockView, profile: 'P1' | 'P3' = 'P1'): Pick<DeviceRuntime, 'bootedAt' | 'profile' | 'clockView'> => ({
      ...P3_DEVICE,
      bootedAt: 0,
      profile,
      clockView: () => view,
    });
    const at = (source: DeviceClockView['source']) => deviceClockSnapshot(fake({ ...UNSET_CLOCK_VIEW, source }), 5);
    expect(at('unset')).toBeUndefined();
    expect(at('host')).toBeUndefined();
    expect(at('user')).toBeDefined();
    expect(at('ntp')).toBeDefined();
    expect(at('master')).toBeDefined();
    expect(deviceClockSnapshot(fake({ ...UNSET_CLOCK_VIEW, source: 'unset' }, 'P3'), 5)).toBeDefined();
  });

  it('the line of a clock read mid-millisecond starts below 1 ms and reads the same at its start', () => {
    const view: DeviceClockView = { source: 'user', authoritative: true, unixMs: 1_000_000, subMsNs: 250_000, tz: { name: 'UTC', offsetMin: 0 } };
    const now = 10 * SEC + 700_000; // the clock is 0.25 ms past a whole millisecond here
    const clock = deviceClockSnapshot({ ...P3_DEVICE, bootedAt: 0, profile: 'P1', clockView: () => view }, now)!;
    // 10 000.45 ms of SimTime before `now` minus 0.25 ms: whole milliseconds at 450 000 ns, reading 1 000 000 − 10 000
    expect(clock).toEqual({ source: 'user', baseUnixMs: 990_000, baseAt: 450_000, tzOffsetMin: 0 });
    expect(extrapolate(clock, now)).toEqual({ unixMs: 1_000_000, subMsNs: 250_000 });
  });
});
