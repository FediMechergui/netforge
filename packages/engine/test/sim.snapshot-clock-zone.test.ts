/**
 * sim.snapshot-clock-zone — `DeviceClockSnapshot.tzName` (ARCHITECTURE-P3 §9.2 ruling R42, deferred to the W4 web-shell
 * item; contracts/snapshot.ts, sim/snapshot-cache.ts `deviceClockSnapshot`).
 *
 * The snapshot clock names the zone of the device's `clock timezone` line (`DeviceClockView.tz.name`, what `show clock`
 * prints), so the device overview, which extrapolates the clock from the snapshot, names the zone exactly as the CLI
 * does — including a line whose name says nothing about its offset (`clock timezone UTC 1`). Without a line the zone is
 * UTC +0 and the member is absent, so every existing snapshot keeps its bytes (and a P1/P2 clock set by a user gains
 * nothing unless that device also has a `clock timezone` line).
 */
import { describe, expect, it } from 'vitest';
import { formatClock, type DeviceClockView } from '../src/contracts/clock.js';
import type { DeviceSnapshot } from '../src/contracts/snapshot.js';
import type { Simulation } from '../src/contracts/simulation.js';
import { SEC } from '../src/contracts/time.js';
import { deviceClockSnapshot } from '../src/sim/snapshot-cache.js';
import { P3_DEVICE, UNSET_CLOCK_VIEW } from './port.fixtures.js';
import { createStagedSimulation } from './staged.world.js';

const BOOT = 60 * SEC;

function p3Router(startupConfig?: string): Simulation {
  const sim = createStagedSimulation({ seed: 33, stage: 'P3' });
  sim.addDevice({ id: 'r1', type: 'router.nf2911', name: 'R1', ...(startupConfig === undefined ? {} : { startupConfig }) });
  sim.runFor(BOOT);
  return sim;
}

const clockOf = (sim: Simulation): NonNullable<DeviceSnapshot['clock']> => sim.snapshot().devices.find((d) => d.id === 'r1')!.clock!;

/** The zone word of a `show clock` line (`*01:00:12.500 CET Wed Jan 1 2020` → `CET`). */
const zoneWord = (line: string): string | undefined => line.split(' ')[1];

describe('DeviceClockSnapshot.tzName', () => {
  it('names the zone of the clock timezone line, as show clock prints it', () => {
    const sim = p3Router('hostname R1\nclock timezone CET 1\n');
    const clock = clockOf(sim);
    expect(clock).toMatchObject({ tzName: 'CET', tzOffsetMin: 60 });
    const s = sim.cli.open('r1', 'console');
    const shown = sim.cli.exec(s, 'show clock').output;
    expect(zoneWord(shown)).toBe('CET');
    expect(formatClock(sim.device('r1')!.clockView(sim.now), 'show-clock')).toContain(' CET ');
  });

  it('keeps a zone name that does not say its offset (clock timezone UTC 1), and a non-zero minute offset', () => {
    const utcPlusOne = clockOf(p3Router('hostname R1\nclock timezone UTC 1\n'));
    expect(utcPlusOne).toMatchObject({ tzName: 'UTC', tzOffsetMin: 60 });
    const nst = clockOf(p3Router('hostname R1\nclock timezone NST -3 30\n'));
    expect(nst).toMatchObject({ tzName: 'NST', tzOffsetMin: -210 });
    const zero = clockOf(p3Router('hostname R1\nclock timezone GMT 0\n'));
    expect(zero).toMatchObject({ tzName: 'GMT', tzOffsetMin: 0 });
  });

  it('is absent without a clock timezone line (UTC +0), so existing snapshots keep their bytes', () => {
    const clock = clockOf(p3Router());
    expect(clock).not.toHaveProperty('tzName');
    expect(clock.tzOffsetMin).toBe(0);
    expect(Object.keys(clock).sort()).toEqual(['baseAt', 'baseUnixMs', 'source', 'tzOffsetMin']);
  });

  it('follows the line: typed, then removed', () => {
    const sim = p3Router();
    const s = sim.cli.open('r1', 'console');
    for (const line of ['enable', 'configure terminal', 'clock timezone EET 2', 'end']) expect(sim.cli.exec(s, line).error, line).toBeUndefined();
    expect(clockOf(sim)).toMatchObject({ tzName: 'EET', tzOffsetMin: 120 });
    for (const line of ['configure terminal', 'no clock timezone', 'end']) expect(sim.cli.exec(s, line).error, line).toBeUndefined();
    expect(clockOf(sim)).not.toHaveProperty('tzName');
  });

  it('a P1/P2 clock set by a user gains no tzName without a line (the P2 snapshot shape is unchanged)', () => {
    const sim = createStagedSimulation({ seed: 33, stage: 'P2' });
    sim.addDevice({ id: 'r1', type: 'router.nf2911', name: 'R1' });
    sim.runFor(BOOT);
    sim.device('r1')!.setClock({ type: 'clock', op: 'set', unixMs: 1_736_150_400_000, source: 'user' }, sim.now);
    expect(Object.keys(clockOf(sim)).sort()).toEqual(['baseAt', 'baseUnixMs', 'source', 'tzOffsetMin']);
  });

  it('is read from the clock view: written exactly when the zone differs from UTC +0', () => {
    const at = (tz: DeviceClockView['tz']) => deviceClockSnapshot({ ...P3_DEVICE, bootedAt: 0, profile: 'P3', clockView: () => ({ ...UNSET_CLOCK_VIEW, tz }) }, 5);
    expect(at({ name: 'UTC', offsetMin: 0 })).not.toHaveProperty('tzName');
    expect(at({ name: 'UTC', offsetMin: 60 })?.tzName).toBe('UTC');
    expect(at({ name: 'PST', offsetMin: -480 })?.tzName).toBe('PST');
    expect(at({ name: 'WET', offsetMin: 0 })?.tzName).toBe('WET');
    // the member comes last, after every older one
    expect(Object.keys(at({ name: 'PST', offsetMin: -480 })!).at(-1)).toBe('tzName');
  });
});
