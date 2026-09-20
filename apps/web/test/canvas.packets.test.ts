// Packet legs and markers (ARCHITECTURE-P1 §7 "Canvas core"): per-leg placement with abortAt, path resolution for
// cables, hub segments, radio beams and air legs, protocol glyphs from the vocabulary, drop-marker anchoring and
// collision-burst placement.
import { describe, expect, it } from 'vitest';
import type { InflightFrame, LinkSnapshot, PortRef, TraceEvent } from '@netforge/engine';
import {
  MAX_PACKET_VIEWS,
  displayProto,
  framePlacement,
  letterFor,
  packetRadius,
  packetScaleFor,
  protoColor,
  resolveLegPath,
  shapeFor,
  type LegGeometrySource,
} from '../src/canvas/packets.js';
import {
  COLLISION_BURST_MS,
  burstPoint,
  dropReasonText,
  indexAfter,
  markerAnchor,
  starburstPoints,
  type MarkerAnchorSource,
} from '../src/canvas/markers.js';
import { straightGeometry, type CableGeom } from '../src/canvas/cables.js';
import { computeLayout } from '../src/canvas/ports.js';
import { KNOWN_PROTOS, PROTOCOL_VOCAB } from '../src/vocab/protocols.js';
import { DROP_VOCAB } from '../src/vocab/drops.js';
import { TEST_THEME, device, link, port, snapshot } from './canvas-fixtures.js';

const summary = { id: 7, proto: 'icmpv4' as const, size: 98, summary: 'echo' };

function leg(extra: Partial<InflightFrame> = {}): InflightFrame {
  return {
    pdu: summary,
    link: 'l1',
    from: { device: 'a', port: 'p' },
    to: { device: 'b', port: 'p' },
    txStart: 100,
    txEnd: 200,
    arrive: 300,
    ...extra,
  };
}

describe('leg placement', () => {
  it('moves head and tail along the leg and hides it outside [txStart, arrive)', () => {
    const f = leg();
    expect(framePlacement(f, 99)).toBeUndefined();
    expect(framePlacement(f, 300)).toBeUndefined();
    expect(framePlacement(f, 100)).toEqual({ head: 0, tail: 0, aborted: false });
    expect(framePlacement(f, 200)).toEqual({ head: 0.5, tail: 0, aborted: false });
    expect(framePlacement(f, 250)).toEqual({ head: 0.75, tail: 0.25, aborted: false });
    expect(framePlacement(leg({ arrive: 100 }), 100)).toBeUndefined();
  });

  it('cuts the tail at abortAt so a collision fragment travels on short', () => {
    const cut = leg({ abortAt: 140 });
    expect(framePlacement(cut, 120)).toEqual({ head: 0.1, tail: 0, aborted: false });
    const p = framePlacement(cut, 250);
    expect(p?.aborted).toBe(true);
    expect(p?.head).toBeCloseTo(0.75);
    expect(p?.tail).toBeCloseTo(0.55);
    // an abort before the start or after the end is clamped
    expect(framePlacement(leg({ abortAt: 50 }), 150)?.tail).toBeCloseTo(0.25);
    expect(framePlacement(leg({ abortAt: 900 }), 250)).toEqual({ head: 0.75, tail: 0.25, aborted: false });
  });
});

describe('leg paths', () => {
  const cable: CableGeom = straightGeometry({ x: 0, y: 0 }, { x: 100, y: 0 });
  const beam: CableGeom = straightGeometry({ x: 0, y: -50 }, { x: 900, y: -50 });
  const arc: CableGeom = straightGeometry({ x: 1, y: 1 }, { x: 2, y: 2 });
  const links = new Map<string, LinkSnapshot>([
    ['l1', link('l1', ['a', 'p'], ['b', 'p'])],
    ['lr', link('lr', ['a', 'r'], ['c', 'r'], { kind: 'radio', media: 'radio', resolvedMedia: 'radio' })],
  ]);
  const calls: [PortRef, PortRef][] = [];
  const src: LegGeometrySource = {
    links,
    cable: (id) => (id === 'l1' ? cable : undefined),
    beam: (id) => (id === 'lr' ? beam : undefined),
    air: (from, to) => {
      calls.push([from, to]);
      return arc;
    },
  };

  it('follows the cable in the direction of travel (P2P and hub segment legs)', () => {
    expect(resolveLegPath(leg(), src)).toEqual({ geom: cable, forward: true });
    expect(resolveLegPath(leg({ from: { device: 'b', port: 'p' }, to: { device: 'a', port: 'p' } }), src)).toEqual({ geom: cable, forward: false });
    expect(resolveLegPath(leg({ medium: 'segment' }), src)?.forward).toBe(true);
  });

  it('follows the beam of a radio link and arcs air and cellular legs between antennas', () => {
    expect(resolveLegPath(leg({ link: 'lr', from: { device: 'c', port: 'r' }, to: { device: 'a', port: 'r' }, medium: 'radio' }), src)).toEqual({ geom: beam, forward: false });
    const air = leg({ link: 'bss:ap/Wlan0', medium: 'air', from: { device: 'ap', port: 'Wlan0' }, to: { device: 'sta', port: 'Wlan0' } });
    expect(resolveLegPath(air, src)).toEqual({ geom: arc, forward: true });
    expect(calls.at(-1)).toEqual([air.from, air.to]);
    expect(resolveLegPath(leg({ link: 'cell:t/Cellular0', medium: 'cell' }), src)?.geom).toBe(arc);
    // unknown cables (removed) are not drawn
    expect(resolveLegPath(leg({ link: 'gone' }), src)).toBeUndefined();
    expect(resolveLegPath(leg({ link: 'gone', medium: 'segment' }), src)).toBeUndefined();
  });
});

describe('protocol glyphs', () => {
  it('uses the vocabulary shape, letter and colour of the meaningful protocol', () => {
    for (const p of KNOWN_PROTOS) {
      expect(shapeFor(p)).toBe(PROTOCOL_VOCAB[p].shape);
      expect(letterFor(p)).toBe(PROTOCOL_VOCAB[p].letter);
      expect(protoColor(p, TEST_THEME)).toBe(TEST_THEME[PROTOCOL_VOCAB[p].color]);
    }
    expect(shapeFor('arp')).toBe('diamond');
    expect(shapeFor('icmpv4')).toBe('capsule');
    expect(shapeFor('tcp')).not.toBe(shapeFor('udp'));
    expect(shapeFor('mystery')).toBe('hexagon');
    expect(letterFor('mystery')).toBe('?');
  });

  it('looks through framing glue and raw data to the innermost meaningful layer', () => {
    expect(displayProto({ proto: 'icmpv4' })).toBe('icmpv4');
    expect(displayProto({ proto: 'payload', layers: ['ethernet', 'ipv4', 'udp', 'payload'] })).toBe('udp');
    expect(displayProto({ proto: 'llc', layers: ['dot11', 'llc'] })).toBe('dot11');
    expect(displayProto({ proto: 'payload' })).toBe('payload');
    expect(displayProto({ proto: 'eapol', layers: ['dot11', 'llc', 'eapol'] })).toBe('eapol');
  });

  it('sizes capsules by frame size and keeps them visible when zoomed out', () => {
    expect(packetRadius(64)).toBe(4.5);
    expect(packetRadius(10)).toBe(4.5);
    expect(packetRadius(128)).toBeCloseTo(6.1);
    expect(packetRadius(1_000_000)).toBe(11);
    expect(packetScaleFor(1)).toBe(1);
    expect(packetScaleFor(0.3)).toBeCloseTo(2);
    expect(packetScaleFor(0.01)).toBe(10);
    expect(MAX_PACKET_VIEWS).toBeGreaterThanOrEqual(500);
  });
});

describe('drop markers', () => {
  const a = device('a', 0, 0, [port('p', { link: 'l1' })]);
  const b = device('b', 200, 0, [port('p', { link: 'l1' })]);
  const lone = device('c', 500, 500, [port('p')]);
  const layout = computeLayout(snapshot([a, b, lone], [link('l1', ['a', 'p'], ['b', 'p'])]), new Map());
  const cableGeom = straightGeometry({ x: 0, y: 0 }, { x: 200, y: 0 });
  const assocGeom = straightGeometry({ x: 0, y: 100 }, { x: 100, y: 100 });
  const src: MarkerAnchorSource = {
    layout,
    linkGeometry: (id) => (id === 'l1' ? cableGeom : undefined),
    assocGeometry: (id) => (id === 'as1' ? assocGeom : undefined),
  };

  it('prefers the association line, then the cable, then the device', () => {
    expect(markerAnchor({ association: 'as1', link: 'l1', device: 'a' }, src)).toEqual({ x: 50, y: 90, key: 'a:as1' });
    expect(markerAnchor({ association: 'missing', link: 'l1' }, src)).toEqual({ x: 100, y: -10, key: 'l:l1' });
    const g = layout.devices.get('c');
    expect(markerAnchor({ link: 'nope', device: 'c' }, src)).toEqual({ x: 500, y: 500 - (g?.halfH ?? 0) - 10, key: 'd:c' });
    expect(markerAnchor({ device: 'ghost' }, src)).toBeUndefined();
  });

  it('words every reason from the drop vocabulary', () => {
    expect(dropReasonText('collision')).toEqual({ title: DROP_VOCAB.collision.tag, detail: '' });
    expect(dropReasonText('link-loss', 'loss 30%')).toEqual({ title: 'lost on the wire', detail: 'loss 30%' });
    expect(dropReasonText('other', 'port is not part of the bridge')).toEqual({ title: 'port is not part of the bridge', detail: '' });
    expect(dropReasonText('brand-new-code').title).toBe('brand-new-code');
  });

  it('places collision bursts on the station side of each cable, else above the device', () => {
    const ends = (id: string) => (id === 'l1' ? { a: { device: 'a', port: 'p' } } : undefined);
    const pa = burstPoint({ device: 'a', port: 'p' }, src, ends);
    const pb = burstPoint({ device: 'b', port: 'p' }, src, ends);
    expect(pa?.x).toBeCloseTo(80);
    expect(pa?.y).toBeCloseTo(0);
    expect(pb?.x).toBeCloseTo(120);
    const g = layout.devices.get('c');
    expect(burstPoint({ device: 'c', port: 'p' }, src, ends)).toEqual({ x: 500, y: 500 - (g?.halfH ?? 0) - 14 });
    expect(burstPoint({ device: 'ghost', port: 'p' }, src, ends)).toBeUndefined();
    expect(COLLISION_BURST_MS).toBeGreaterThan(0);
  });

  it('draws a spiky starburst', () => {
    const pts = starburstPoints(0, 0, 10, 4, 8);
    expect(pts).toHaveLength(32);
    expect(pts[0]).toBeCloseTo(0);
    expect(pts[1]).toBeCloseTo(-10);
    expect(Math.hypot(pts[2] ?? 0, pts[3] ?? 0)).toBeCloseTo(4);
  });

  it('finds where new events start in the store ring', () => {
    const e1: TraceEvent = { t: 1, kind: 'log', device: 'a', severity: 6, facility: 'X', message: 'one' };
    const e2: TraceEvent = { t: 2, kind: 'log', device: 'a', severity: 6, facility: 'X', message: 'two' };
    const e3: TraceEvent = { t: 3, kind: 'log', device: 'a', severity: 6, facility: 'X', message: 'three' };
    expect(indexAfter([e1, e2, e3], e2)).toBe(2);
    expect(indexAfter([e1, e2, e3], e3)).toBe(3);
    expect(indexAfter([e1, e2, e3], null)).toBe(0);
    // an equal-looking copy is not the same event (identity, not value)
    expect(indexAfter([e1, e2, e3], { ...e2 })).toBe(0);
  });
});
