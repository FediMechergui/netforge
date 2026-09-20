// Wireless overlays (ARCHITECTURE-P1 §7 "Wireless overlays"): range-ring geometry (radius = rangeM / metresPerUnit),
// ring culling and dashing, channel labels, association lines (arcs, phase badges, bar glyphs, dBm text) and PtP
// beams, checked on hand-built data and on the real home Wi-Fi, radio bridge and cellular templates.
import { describe, expect, it } from 'vitest';
import type { AssociationSnapshot, RfBand } from '@netforge/engine';
import {
  BAND_DASH,
  DEFAULT_METRES_PER_UNIT,
  MAX_RING_DASHES,
  bandLabel,
  channelLabel,
  distanceLabel,
  rangeRings,
  ringDashSpans,
  ringRadius,
  ringVisible,
} from '../src/canvas/rf.js';
import {
  CANVAS_OVERLAY_DEFAULTS,
  airArc,
  assocDash,
  assocEndpoints,
  beamGeometry,
  legGeometry,
  phaseBadge,
  signalBarRects,
  signalText,
} from '../src/canvas/air.js';
import { bezierAt } from '../src/canvas/cables.js';
import { computeLayout } from '../src/canvas/ports.js';
import { device, port, snapshot, templateSnapshot } from './canvas-fixtures.js';

const ALL_STATES: AssociationSnapshot['state'][] = [
  'idle', 'scanning', 'authenticating', 'associating', 'handshake', 'associated', 'failed',
  'searching', 'attaching', 'attached', 'detached',
];

describe('range rings', () => {
  it('converts the engine range to world units with the topology scale', () => {
    expect(ringRadius(40, 0.25)).toBe(160);
    expect(ringRadius(15_000, 0.25)).toBe(60_000);
    expect(ringRadius(100, 2)).toBe(50);
    expect(ringRadius(40, 0)).toBe(40 / DEFAULT_METRES_PER_UNIT);
    expect(ringRadius(40, Number.NaN)).toBe(160);
    expect(ringRadius(0, 0.25)).toBe(0);
    expect(ringRadius(-5, 0.25)).toBe(0);
  });

  it('rings access radios always and station radios only for the selected device', () => {
    const ap = device('ap', 100, 100, [
      port('Wlan0', { kind: 'wlan', radio: { mode: 'ap', band: '2.4', channel: 6, widthMhz: 20, txPowerDbm: 20, up: true, rangeM: 50 } }),
      port('Wlan1', { kind: 'wlan', radio: { mode: 'ap', band: '5', channel: 36, widthMhz: 20, txPowerDbm: 20, up: false, rangeM: 30 } }),
    ], { icon: 'ap' });
    const sta = device('sta', 0, 0, [
      port('Wlan0', { kind: 'wlan', operUp: true, radio: { mode: 'station', band: '2.4', channel: 6, widthMhz: 20, txPowerDbm: 15, up: true, rangeM: 20, state: 'associated' } }),
    ]);
    const layout = computeLayout(snapshot([ap, sta]), new Map());
    const rings = rangeRings(layout, 0.5);
    expect(rings.map((r) => [r.key, r.r, r.up, r.label])).toEqual([
      ['ap/Wlan0', 100, true, '2.4 GHz · 50 m'],
      ['ap/Wlan1', 60, false, '5 GHz · 30 m (idle)'],
    ]);
    expect(rings[0]).toMatchObject({ x: 100, y: 100, band: '2.4', mode: 'ap', device: 'ap', port: 'Wlan0' });
    const selected = rangeRings(layout, 0.5, 'sta');
    expect(selected.map((r) => r.key)).toEqual(['ap/Wlan0', 'ap/Wlan1', 'sta/Wlan0']);
    expect(selected[2]).toMatchObject({ r: 40, up: true });
    // a powered-off AP is idle whatever its radio says
    const off = computeLayout(snapshot([{ ...ap, power: false }]), new Map());
    expect(rangeRings(off, 0.5).every((r) => !r.up)).toBe(true);
  });

  it('draws the real home router and radio bridge rings from the snapshot', () => {
    const home = templateSnapshot('home-wifi');
    const mpu = home.media?.metresPerUnit ?? DEFAULT_METRES_PER_UNIT;
    const layout = computeLayout(home, new Map());
    const rings = rangeRings(layout, mpu);
    const wlan0 = home.devices.find((d) => d.id === 'home1')?.ports.find((p) => p.id === 'Wlan0');
    expect(wlan0?.radio).toBeDefined();
    const ring = rings.find((r) => r.key === 'home1/Wlan0');
    expect(ring?.r).toBe((wlan0?.radio?.rangeM ?? 0) / mpu);
    expect(ring?.up).toBe(true);
    // the laptop sits inside the 2.4 GHz ring (it associated)
    const laptop = layout.devices.get('laptop1');
    expect(Math.hypot((laptop?.x ?? 0) - (ring?.x ?? 0), (laptop?.y ?? 0) - (ring?.y ?? 0))).toBeLessThan(ring?.r ?? 0);
    expect(rings.some((r) => r.device === 'laptop1')).toBe(false);

    const bridge = templateSnapshot('radio-bridge');
    const beams = rangeRings(computeLayout(bridge, new Map()), bridge.media?.metresPerUnit ?? DEFAULT_METRES_PER_UNIT);
    expect(beams.map((r) => r.mode)).toEqual(['ptp', 'ptp']);

    const cell = templateSnapshot('cellular-phones');
    const towerRing = rangeRings(computeLayout(cell, new Map()), cell.media?.metresPerUnit ?? DEFAULT_METRES_PER_UNIT).find((r) => r.mode === 'tower');
    expect(towerRing?.label.startsWith('cellular · ')).toBe(true);
  });

  it('skips rings whose outline is off screen, including rings that enclose the whole view', () => {
    const view = { minX: 0, minY: 0, maxX: 100, maxY: 100 };
    expect(ringVisible(50, 50, 30, view)).toBe(true);
    expect(ringVisible(-50, 50, 60, view)).toBe(true);
    expect(ringVisible(-200, 50, 60, view)).toBe(false);
    expect(ringVisible(50, 50, 1000, view)).toBe(false);
    expect(ringVisible(50, 50, 70, view)).toBe(true);
  });

  it('dashes rings with a bounded number of pieces', () => {
    const small = ringDashSpans(10, [6, 5]);
    expect(small.length).toBeGreaterThan(0);
    expect(small[0]?.[0]).toBe(0);
    for (const [s, e] of small) {
      expect(e).toBeGreaterThan(s);
      expect(e).toBeLessThanOrEqual(Math.PI * 2 + 1e-9);
    }
    const huge = ringDashSpans(60_000, [6, 5]);
    expect(huge.length).toBeLessThanOrEqual(MAX_RING_DASHES);
    expect(huge.length).toBeGreaterThan(MAX_RING_DASHES / 2);
    expect(ringDashSpans(10, [])).toEqual([[0, Math.PI * 2]]);
    expect(ringDashSpans(0, [1, 1])).toEqual([]);
  });

  it('encodes the band by dash pattern and names it in text', () => {
    const bands = Object.keys(BAND_DASH) as RfBand[];
    expect(new Set(bands.map((b) => BAND_DASH[b].join(','))).size).toBe(bands.length);
    expect(bandLabel('cell')).toBe('cellular');
    expect(bandLabel('6')).toBe('6 GHz');
    expect(channelLabel({ band: '5', channel: 36, ssid: 'LAB', mode: 'ap' })).toBe('LAB · 5 GHz ch 36');
    expect(channelLabel({ band: '5', channel: 149, ssid: 'x', mode: 'ptp' })).toBe('5 GHz ch 149');
    expect(channelLabel({ band: 'cell', channel: 1, mode: 'tower' })).toBe('cellular');
    expect(distanceLabel(40.4)).toBe('40 m');
    expect(distanceLabel(1234)).toBe('1.2 km');
    expect(distanceLabel(15_000)).toBe('15 km');
  });
});

describe('association lines and beams', () => {
  it('bends air legs to the left of travel so the two directions never overlap', () => {
    const a = { x: 0, y: 0 };
    const b = { x: 100, y: 0 };
    const up = airArc(a, b);
    const down = airArc(b, a);
    expect(up.p0).toEqual(a);
    expect(up.p3).toEqual(b);
    const midUp = bezierAt(up, 0.5);
    const midDown = bezierAt(down, 0.5);
    expect(midUp.x).toBeCloseTo(50);
    expect(midUp.y).toBeCloseTo(-12);
    expect(midDown.y).toBeCloseTo(12);
    // the bulge is capped for long legs and absent for zero-length ones
    expect(bezierAt(airArc(a, { x: 10_000, y: 0 }), 0.5).y).toBeCloseTo(-60);
    expect(airArc(a, a).p1).toEqual(a);
  });

  it('gives every phase a badge and a line pattern, never colour alone', () => {
    const texts = ALL_STATES.map((s) => phaseBadge(s).text);
    expect(texts.every((t) => t.length > 0)).toBe(true);
    const inProgress = ALL_STATES.filter((s) => !phaseBadge(s).final && !phaseBadge(s).failed);
    expect(new Set(inProgress.map((s) => phaseBadge(s).text)).size).toBe(inProgress.length);
    expect(phaseBadge('associated')).toEqual({ text: '✓', final: true, failed: false });
    expect(phaseBadge('attached').final).toBe(true);
    expect(phaseBadge('failed').failed).toBe(true);
    expect(phaseBadge('detached').failed).toBe(true);
    const joined = assocDash('associated', true);
    const joining = assocDash('handshake', false);
    const failed = assocDash('failed', false);
    expect(new Set([joined, joining, failed].map((d) => d.join(','))).size).toBe(3);
    // associated but not yet authorised still draws as "in progress"
    expect(assocDash('associated', false)).toEqual(joining);
  });

  it('draws the bar glyph with rising hollow/filled bars and a dBm label', () => {
    const bars = signalBarRects(3);
    expect(bars.map((r) => r.filled)).toEqual([true, true, true, false]);
    expect(bars.every((r, i) => i === 0 || r.h > (bars[i - 1]?.h ?? 0))).toBe(true);
    expect(bars.every((r) => r.y === -r.h)).toBe(true);
    expect(signalBarRects(9).filter((r) => r.filled)).toHaveLength(4);
    expect(signalBarRects(-1).filter((r) => r.filled)).toHaveLength(0);
    expect(signalBarRects(2, 2)[1]?.x).toBe(6.8);
    expect(signalText(-66.4, false)).toBe('-66 dBm');
    expect(signalText(-85, true)).toBe('-85 dBm · hold');
  });

  it('joins the real laptop antenna to the home router antenna', () => {
    const home = templateSnapshot('home-wifi');
    const layout = computeLayout(home, new Map());
    const assoc = home.media?.associations[0];
    expect(assoc?.state).toBe('associated');
    if (!assoc) return;
    const ends = assocEndpoints(assoc, layout);
    expect(ends?.station).toEqual({ x: layout.antenna.get('laptop1/Wlan0')?.x, y: layout.antenna.get('laptop1/Wlan0')?.y });
    expect(ends?.ap).toEqual({ x: layout.antenna.get('home1/Wlan0')?.x, y: layout.antenna.get('home1/Wlan0')?.y });
    // an association without an AP end (still scanning) has no line
    const { ap: _ap, ...scanning } = assoc;
    expect(assocEndpoints({ ...scanning, state: 'scanning' }, layout)).toBeNull();
    // uplink and downlink legs are mirror arcs between the same antennas
    const upLeg = legGeometry(assoc.station, assoc.ap ?? assoc.station, layout);
    expect(upLeg?.p0).toEqual(ends?.station);
    expect(upLeg?.p3).toEqual(ends?.ap);
    // a device that is not on the canvas yields nothing
    expect(legGeometry({ device: 'ghost', port: 'Wlan0' }, assoc.station, layout)).toBeUndefined();
  });

  it('draws PtP beams between the two radio antennas', () => {
    const bridge = templateSnapshot('radio-bridge');
    const layout = computeLayout(bridge, new Map());
    const radioLink = bridge.links.find((l) => l.kind === 'radio');
    expect(radioLink?.radio?.bars).toBeGreaterThan(0);
    if (!radioLink) return;
    const beam = beamGeometry(radioLink, layout);
    expect(beam?.p0).toEqual({ x: layout.antenna.get('radio1/Radio0')?.x, y: layout.antenna.get('radio1/Radio0')?.y });
    expect(beam?.p3).toEqual({ x: layout.antenna.get('radio2/Radio0')?.x, y: layout.antenna.get('radio2/Radio0')?.y });
    // straight: the midpoint lies on the chord
    const mid = beam ? bezierAt(beam, 0.5) : undefined;
    expect(mid?.y).toBeCloseTo(((beam?.p0.y ?? 0) + (beam?.p3.y ?? 0)) / 2);
  });

  it('has overlay defaults for every toggle', () => {
    expect(Object.keys(CANVAS_OVERLAY_DEFAULTS).sort()).toEqual(['associationLines', 'backgroundFrames', 'channelLabels', 'radioBeams', 'rangeRings', 'signalBars']);
    expect(CANVAS_OVERLAY_DEFAULTS.associationLines).toBe(true);
  });
});
