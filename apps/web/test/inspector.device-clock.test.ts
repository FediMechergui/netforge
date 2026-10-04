// The device inspector's clock (ARCHITECTURE-P3 §5.9 "Device inspector overview": the clock — `*` when unset, source,
// stratum — extrapolated in the web from `DeviceSnapshot.clock` and `now`; D19, §3.7; §7 W3 web-inspector).
import { describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { NF_CLOCK_UNSET_UNIX_MS, NF_WORLD_EPOCH_UNIX_MS } from '@netforge/engine';
import type { DeviceClockSnapshot } from '@netforge/engine';

// DeviceInspector imports the desktop tab, whose terminal needs a browser; these tests never open that tab
vi.mock('../src/desktop/DesktopTab', () => ({ DesktopTab: () => null }));
vi.mock('../src/bridge/client', () => ({ engine: {}, fmtSimTime: (t: number) => `${t / 1_000_000_000} s` }));
vi.mock('../src/store/store', () => {
  const state: Record<string, unknown> = {
    catalog: [], snapshot: null, snapshotIndex: undefined, epoch: 0, events: [], now: 0, nowWall: 0, playing: false, effectiveRate: 1,
    inspectorTab: 'overview', timeline: { review: null, head: null, lanes: [], seeking: false, reviewEvents: [] },
  };
  const useStore = Object.assign((selector: (s: Record<string, unknown>) => unknown) => selector(state), {
    getState: () => state,
    setState: (patch: Record<string, unknown>) => Object.assign(state, patch),
    subscribe: () => () => undefined,
  });
  return { useStore, store: useStore };
});

import { store } from '../src/store/store';
import { DeviceInspector, clockSourceText, clockZoneName, deviceClockAt, deviceClockText } from '../src/inspector/DeviceInspector';
import { device, snapshot } from './canvas-fixtures';

const S = 1_000_000_000;
const MS = 1_000_000;

function text(html: string): string {
  return html.replace(/<[^>]+>/g, ' ').replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ');
}

/** §3.7 step 1: R1 boots at 45 s with an unset clock (2020-01-01 plus uptime). */
const UNSET: DeviceClockSnapshot = { source: 'unset', baseUnixMs: NF_CLOCK_UNSET_UNIX_MS, baseAt: 45 * S, tzOffsetMin: 0 };
/** §3.7 step 4: synchronised by NTP at stratum 2 from 10.0.0.10, reading true time (SimTime 0 = Mon Jan 6 2025 08:00). */
const SYNCED: DeviceClockSnapshot = {
  source: 'ntp',
  baseUnixMs: NF_WORLD_EPOCH_UNIX_MS + 300_000,
  baseAt: 300 * S,
  stratum: 2,
  reference: '10.0.0.10',
  tzOffsetMin: 0,
};

describe('the device clock, extrapolated from the snapshot', () => {
  it('an unset clock reads with a leading * (§3.7 step 1)', () => {
    expect(deviceClockText(UNSET, 57_500 * MS)).toBe('*00:00:12.500 UTC Wed Jan 1 2020');
    expect(deviceClockAt(UNSET, 57_500 * MS).authoritative).toBe(false);
  });

  it('a synchronised clock follows simulated time exactly (§3.7 step 4)', () => {
    expect(deviceClockText(SYNCED, 312_412 * MS)).toBe('08:05:12.412 UTC Mon Jan 6 2025');
    const v = deviceClockAt(SYNCED, 312_412 * MS + 750_000);
    expect([v.unixMs, v.subMsNs, v.stratum, v.reference, v.authoritative]).toEqual([NF_WORLD_EPOCH_UNIX_MS + 312_412, 750_000, 2, '10.0.0.10', true]);
    // the base instant itself, and a hair before it (the snapshot's baseAt lies up to 1 ms after the read)
    expect(deviceClockAt(SYNCED, 300 * S).unixMs).toBe(NF_WORLD_EPOCH_UNIX_MS + 300_000);
    const before = deviceClockAt(SYNCED, 300 * S - 400_000);
    expect([before.unixMs, before.subMsNs]).toEqual([NF_WORLD_EPOCH_UNIX_MS + 299_999, 600_000]);
  });

  it('a time zone offset shifts the reading and names the zone by its offset', () => {
    expect(clockZoneName(0)).toBe('UTC');
    expect(clockZoneName(60)).toBe('UTC+1');
    expect(clockZoneName(-210)).toBe('UTC-3:30');
    expect(deviceClockText({ ...SYNCED, tzOffsetMin: 60 }, 312_412 * MS)).toBe('09:05:12.412 UTC+1 Mon Jan 6 2025');
  });

  it('says where the time comes from, with the stratum', () => {
    expect(clockSourceText(UNSET)).toBe('not set: running from the boot default (shown with *)');
    expect(clockSourceText({ source: 'user' })).toBe('set by hand (clock set)');
    expect(clockSourceText(SYNCED)).toBe('synchronised by NTP, stratum 2, from 10.0.0.10');
    expect(clockSourceText({ source: 'master', stratum: 1 })).toBe('serves its own clock (ntp master), stratum 1');
    expect(clockSourceText({ source: 'host' })).toBe("the computer's own clock");
  });
});

describe('the Overview tab shows the clock', () => {
  function overview(clock: DeviceClockSnapshot | undefined, now: number): string {
    const r1 = device('r1', 0, 0, [], {
      name: 'R1',
      type: 'router.nf2911',
      model: 'NF-2911',
      capabilities: ['routing'],
      cli: { shell: 'nfos', grammar: 'nfos' },
      ...(clock !== undefined ? { clock } : {}),
    });
    store.setState({ snapshot: snapshot([r1], [], { now }), now, playing: false });
    return text(renderToStaticMarkup(createElement(DeviceInspector, { device: r1 })));
  }

  it('an NTP-synchronised router', () => {
    const t = overview(SYNCED, 312_412 * MS);
    expect(t).toContain('Clock 08:05:12.412 UTC Mon Jan 6 2025 synchronised by NTP, stratum 2, from 10.0.0.10');
  });

  it('an unset router clock keeps its *', () => {
    expect(overview(UNSET, 57_500 * MS)).toContain('Clock *00:00:12.500 UTC Wed Jan 1 2020 not set');
  });

  it('a snapshot without a clock (P1/P2 worlds) shows no clock line', () => {
    expect(overview(undefined, 0)).not.toContain('Clock');
  });
});
