// The device overview names the clock's zone as `show clock` does (ARCHITECTURE-P3 §9.2 ruling R42, deferred to W4
// web-shell; §5.9 "Device inspector overview"): the snapshot clock carries the `clock timezone` line's name
// (`DeviceClockSnapshot.tzName`), the overview prints it, and only a clock without one (UTC +0, no line) falls back to the
// zone label of its offset — which is then `UTC`, as the CLI prints too.
import { describe, expect, it, vi } from 'vitest';
import { NF_WORLD_EPOCH_UNIX_MS, formatClock } from '@netforge/engine';
import type { DeviceClockSnapshot, DeviceClockView } from '@netforge/engine';

// DeviceInspector imports the desktop tab, whose terminal needs a browser; these tests never open that tab
vi.mock('../src/desktop/DesktopTab', () => ({ DesktopTab: () => null }));
vi.mock('../src/bridge/client', () => ({ engine: {}, fmtSimTime: (t: number) => `${t / 1_000_000_000} s` }));

import { clockZoneName, deviceClockAt, deviceClockText } from '../src/inspector/DeviceInspector';

const S = 1_000_000_000;
const MS = 1_000_000;

/** Synchronised at 300 s, reading true time (SimTime 0 = Mon Jan 6 2025 08:00 UTC). */
const SYNCED: DeviceClockSnapshot = { source: 'ntp', baseUnixMs: NF_WORLD_EPOCH_UNIX_MS + 300_000, baseAt: 300 * S, stratum: 2, reference: '10.0.0.10', tzOffsetMin: 0 };

/** What `show clock` prints for the device's own clock view (the CLI side of the comparison). */
function showClock(clock: DeviceClockSnapshot, zone: DeviceClockView['tz'], now: number): string {
  const v = deviceClockAt(clock, now);
  return formatClock({ ...v, tz: zone }, 'show-clock');
}

describe('the overview names the zone of the clock timezone line', () => {
  it('prints the line’s name, not a label derived from the offset', () => {
    const cet: DeviceClockSnapshot = { ...SYNCED, tzOffsetMin: 60, tzName: 'CET' };
    expect(deviceClockText(cet, 312_412 * MS)).toBe('09:05:12.412 CET Mon Jan 6 2025');
    expect(deviceClockAt(cet, 312_412 * MS).tz).toEqual({ name: 'CET', offsetMin: 60 });
    expect(deviceClockText(cet, 312_412 * MS)).toBe(showClock(cet, { name: 'CET', offsetMin: 60 }, 312_412 * MS));
  });

  it('matches show clock for a name that hides its offset (clock timezone UTC 1) and for a zero-offset zone', () => {
    const utc1: DeviceClockSnapshot = { ...SYNCED, tzOffsetMin: 60, tzName: 'UTC' };
    expect(deviceClockText(utc1, 312_412 * MS)).toBe('09:05:12.412 UTC Mon Jan 6 2025');
    expect(deviceClockText(utc1, 312_412 * MS)).toBe(showClock(utc1, { name: 'UTC', offsetMin: 60 }, 312_412 * MS));
    const gmt: DeviceClockSnapshot = { ...SYNCED, tzName: 'GMT' };
    expect(deviceClockText(gmt, 312_412 * MS)).toBe('08:05:12.412 GMT Mon Jan 6 2025');
  });

  it('falls back to the offset label without a name: UTC for the default zone, as the CLI prints', () => {
    expect(clockZoneName(0)).toBe('UTC');
    expect(deviceClockText(SYNCED, 312_412 * MS)).toBe('08:05:12.412 UTC Mon Jan 6 2025');
    expect(deviceClockText(SYNCED, 312_412 * MS)).toBe(showClock(SYNCED, { name: 'UTC', offsetMin: 0 }, 312_412 * MS));
    // an older snapshot with an offset but no name still reads (the W3 label)
    expect(deviceClockText({ ...SYNCED, tzOffsetMin: -210 }, 312_412 * MS)).toBe('04:35:12.412 UTC-3:30 Mon Jan 6 2025');
  });
});
