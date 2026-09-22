// The spanning-tree overlay layer's pure parts (ARCHITECTURE-P2 §6, §3.6, D20; W3 web-canvas): letter and cross
// placement, the crown, the draining bar, the tree underlay widths, the topology-change wave, and the text forms
// (per port, device and link) the keyboard outline reads.
import { describe, expect, it } from 'vitest';
import type { DeviceSnapshot, PortSnapshot, StpBridgeRow, StpPortRow } from '@netforge/engine';
import { buildStpOverlay, type StpPortMark } from '../src/canvas/overlays/stp-model.js';
import {
  CROSS_INSET,
  LETTER_INSET,
  MAX_CHANGE_WAVES,
  STP_CHANGE_WAVE_MS,
  changeWaveAlpha,
  changeWaveRadius,
  crossPoint,
  crownPoints,
  describeStpMark,
  drainBarRect,
  letterPoint,
  modelNeedsClock,
  shortStpMark,
  stpDeviceFacts,
  stpLinkFacts,
  stpPortFacts,
  treeWidth,
} from '../src/canvas/stp.js';
import { device, link, port, snapshot } from './canvas-fixtures.js';

const SEC = 1_000_000_000;

function portRow(vlan: number, id: string, over: Partial<StpPortRow> = {}): StpPortRow {
  return {
    key: `${vlan}|${id}`,
    vlan,
    port: id,
    role: 'designated',
    state: 'forwarding',
    protocol: 'stp',
    cost: 4,
    portId: '128.1',
    designatedBridge: '32769/00:1f:00:0a:00:00',
    designatedPort: '128.1',
    edge: false,
    stateSince: 30 * SEC,
    ...over,
  } as StpPortRow;
}

function bridgeRow(vlan: number, over: Partial<StpBridgeRow> = {}): StpBridgeRow {
  return {
    key: String(vlan),
    vlan,
    mode: 'pvst',
    bridgeId: '32769/00:1f:00:0a:00:00',
    rootId: '4097/00:1f:00:0a:00:00',
    isRoot: false,
    rootCost: 4,
    helloS: 2,
    maxAgeS: 20,
    forwardDelayS: 15,
    topologyChanges: 0,
    ...over,
  } as StpBridgeRow;
}

function stpDevice(id: string, ports: PortSnapshot[], bridges: StpBridgeRow[], rows: StpPortRow[]): DeviceSnapshot {
  return device(id, 0, 0, ports, {
    kind: 'switch',
    model: 'NF-C2960',
    tables: {
      cam: [],
      arp: [],
      rib: [],
      extra: [
        { name: 'stp', title: 'Spanning tree ports', columns: [], rows: rows as unknown as Record<string, unknown>[] },
        { name: 'stp-bridge', title: 'Spanning tree', columns: [], rows: bridges as unknown as Record<string, unknown>[] },
      ],
    },
  });
}

function switched(id: string, linkId: string): PortSnapshot {
  return port(id, { short: id, role: 'switched', operUp: true, link: linkId });
}

/** The §3.6 triangle: SW1 root, SW3's Gi0/2 alternate and blocking; SW2's Gi0/2 listening with 7.5 s of 15 s left. */
function triangle(now = 37.5 * SEC) {
  const sw1 = stpDevice(
    'sw1',
    [switched('Gi0/1', 'l12'), switched('Gi0/2', 'l13')],
    [bridgeRow(1, { isRoot: true, bridgeId: '4097/00:1f:00:0a:00:00', rootCost: 0, topologyChanges: 2, lastChangeAt: 60 * SEC, lastChangePort: 'Gi0/1' })],
    [portRow(1, 'Gi0/1'), portRow(1, 'Gi0/2')],
  );
  const sw2 = stpDevice(
    'sw2',
    [switched('Gi0/1', 'l12'), switched('Gi0/2', 'l23')],
    [bridgeRow(1, { rootPort: 'Gi0/1' })],
    [portRow(1, 'Gi0/1', { role: 'root' }), portRow(1, 'Gi0/2', { state: 'listening', nextTransitionAt: 45 * SEC })],
  );
  const sw3 = stpDevice(
    'sw3',
    [switched('Gi0/1', 'l13'), switched('Gi0/2', 'l23')],
    [bridgeRow(1, { rootPort: 'Gi0/1', bridgeId: '32769/00:1f:00:0c:00:00' })],
    [portRow(1, 'Gi0/1', { role: 'root' }), portRow(1, 'Gi0/2', { role: 'alternate', state: 'blocking', inconsistent: 'root' })],
  );
  return buildStpOverlay(
    snapshot([sw1, sw2, sw3], [
      link('l12', ['sw1', 'Gi0/1'], ['sw2', 'Gi0/1']),
      link('l13', ['sw1', 'Gi0/2'], ['sw3', 'Gi0/1']),
      link('l23', ['sw2', 'Gi0/2'], ['sw3', 'Gi0/2']),
    ], { now }),
    { vlan: null, now },
  );
}

describe('geometry', () => {
  it('sets the letter close to the port and the cross further out, both along the cable', () => {
    const a = { x: 100, y: 50, nx: 0, ny: 1 };
    expect(letterPoint(a)).toEqual({ x: 100, y: 50 + LETTER_INSET });
    expect(crossPoint(a)).toEqual({ x: 100, y: 50 + CROSS_INSET });
    expect(CROSS_INSET).toBeGreaterThan(LETTER_INSET);
    expect(letterPoint({ x: 0, y: 0, nx: -1, ny: 0 }, 2)).toEqual({ x: -2 * LETTER_INSET, y: 0 });
  });

  it('draws a three-peak crown of the asked size, base centred', () => {
    const pts = crownPoints(50, 100, 20, 10);
    expect(pts.length).toBe(14);
    const xs = pts.filter((_, i) => i % 2 === 0);
    const ys = pts.filter((_, i) => i % 2 === 1);
    expect(Math.min(...xs)).toBe(40);
    expect(Math.max(...xs)).toBe(60);
    expect(Math.max(...ys)).toBe(100);
    expect(Math.min(...ys)).toBeLessThan(90);
    // the centre peak is the tallest
    expect(pts[7]).toBe(Math.min(...ys));
    expect(pts[6]).toBe(50);
  });

  it('fills the draining bar by the fraction left, under the letter, clamped', () => {
    const half = drainBarRect({ x: 0, y: 0 }, 0.5);
    expect(half.fillW).toBe(half.w / 2);
    expect(half.y).toBeGreaterThan(0);
    expect(half.x).toBe(-half.w / 2);
    expect(drainBarRect({ x: 0, y: 0 }, 1).fillW).toBe(half.w);
    expect(drainBarRect({ x: 0, y: 0 }, 0).fillW).toBe(0);
    expect(drainBarRect({ x: 0, y: 0 }, 2).fillW).toBe(half.w);
    expect(drainBarRect({ x: 0, y: 0 }, -1).fillW).toBe(0);
    expect(drainBarRect({ x: 0, y: 0 }, 0.5, 2).w).toBe(half.w * 2);
  });

  it('underlays the active tree thick, a converging link thin, a blocked or absent link not at all', () => {
    expect(treeWidth('active')).toBeGreaterThan(treeWidth('converging'));
    expect(treeWidth('converging')).toBeGreaterThan(0);
    expect(treeWidth('blocked')).toBe(0);
    expect(treeWidth('none')).toBe(0);
    expect(treeWidth('active', 2)).toBe(treeWidth('active') * 2);
  });

  it('grows and fades the topology-change wave over its life', () => {
    expect(changeWaveRadius(0)).toBeLessThan(changeWaveRadius(0.5));
    expect(changeWaveRadius(0.5)).toBeLessThan(changeWaveRadius(1));
    expect(changeWaveRadius(2)).toBe(changeWaveRadius(1));
    expect(changeWaveAlpha(0)).toBe(1);
    expect(changeWaveAlpha(0.49)).toBe(1);
    expect(changeWaveAlpha(0.75)).toBeCloseTo(0.5, 5);
    expect(changeWaveAlpha(1)).toBe(0);
    expect(STP_CHANGE_WAVE_MS).toBeGreaterThan(1000);
    expect(MAX_CHANGE_WAVES).toBeGreaterThan(0);
  });
});

describe('the clock', () => {
  it('asks for a per-frame rebuild only while some port drains', () => {
    expect(modelNeedsClock(null)).toBe(false);
    expect(modelNeedsClock(triangle())).toBe(true);
    expect(modelNeedsClock(triangle(60 * SEC))).toBe(true); // the row still names its next transition
    const quiet = buildStpOverlay(
      snapshot([stpDevice('sw1', [switched('Gi0/1', 'l')], [bridgeRow(1, { isRoot: true })], [portRow(1, 'Gi0/1')]), stpDevice('sw2', [switched('Gi0/1', 'l')], [bridgeRow(1)], [portRow(1, 'Gi0/1', { role: 'root' })])], [link('l', ['sw1', 'Gi0/1'], ['sw2', 'Gi0/1'])]),
      { vlan: null, now: 0 },
    );
    expect(modelNeedsClock(quiet)).toBe(false);
  });
});

describe('text forms', () => {
  const base: StpPortMark = {
    device: 'sw3',
    port: 'Gi0/2',
    link: 'l23',
    end: 'b',
    vlan: 1,
    role: 'alternate',
    letter: 'A',
    state: 'blocking',
    glyph: '✕',
    blocked: true,
    edge: false,
    protocol: 'stp',
  };

  it('describes a port mark: role, state, the cross, guards, timers and bundles', () => {
    expect(describeStpMark(base)).toBe('spanning tree VLAN 1: alternate port, blocking (crossed), classic messages');
    expect(describeStpMark({ ...base, role: 'root', letter: 'R', state: 'forwarding', glyph: '', blocked: false, protocol: 'rstp' })).toBe('spanning tree VLAN 1: root port, forwarding');
    expect(describeStpMark({ ...base, inconsistent: 'root' })).toContain('inconsistent (root guard)');
    expect(describeStpMark({ ...base, inconsistent: 'type' })).toContain('inconsistent (a trunk faces this access port)');
    expect(describeStpMark({ ...base, state: 'listening', glyph: '○', blocked: false, drain: 0.5 })).toContain('listening, classic messages, 50% of the timer left');
    expect(describeStpMark({ ...base, edge: true, protocol: 'rstp', role: 'designated', letter: 'D', state: 'forwarding', glyph: '', blocked: false })).toBe('spanning tree VLAN 1: designated port, forwarding, edge port');
    expect(describeStpMark({ ...base, viaBundle: 'Port-channel1' })).toContain('through Port-channel1');
  });

  it('shortens a port mark to letter, glyph and state', () => {
    expect(shortStpMark(base)).toBe('A ✕ blocking');
    expect(shortStpMark({ ...base, role: 'designated', letter: 'D', state: 'forwarding', glyph: '', blocked: false })).toBe('D forwarding');
    expect(shortStpMark({ ...base, inconsistent: 'root' })).toBe('A ✕ blocking !');
  });

  it('gives every drawn port, the root and every link a fact from the §3.6 triangle', () => {
    const model = triangle();
    const ports = stpPortFacts(model);
    expect(ports.size).toBe(6);
    expect(ports.get('sw3/Gi0/2')).toEqual({ short: 'A ✕ blocking !', text: 'spanning tree VLAN 1: alternate port, blocking (crossed), classic messages, inconsistent (root guard)' });
    expect(ports.get('sw2/Gi0/1')?.short).toBe('R forwarding');
    expect(ports.get('sw2/Gi0/2')).toEqual({ short: 'D ○ listening', text: 'spanning tree VLAN 1: designated port, listening, classic messages, 50% of the timer left' });

    const devices = stpDeviceFacts(model);
    expect(devices.get('sw1')).toEqual({ short: 'ROOT v1 · TC 2', text: 'root bridge for VLAN 1, 2 topology changes, the last at Gi0/1' });
    expect(devices.has('sw2')).toBe(false);
    expect(devices.has('sw3')).toBe(false);

    const links = stpLinkFacts(model);
    expect(links.get('l13')).toEqual({ short: 'in the tree', text: 'in the spanning tree of VLAN 1' });
    expect(links.get('l23')).toEqual({ short: '✕ blocked', text: 'blocked by spanning tree at sw3 Gi0/2' });
    expect(links.get('l12')).toEqual({ short: 'in the tree', text: 'in the spanning tree of VLAN 1' });
  });

  it('says a single change in the singular and a converging link as joining', () => {
    const sw1 = stpDevice('sw1', [switched('Gi0/1', 'l')], [bridgeRow(1, { isRoot: true, topologyChanges: 1 })], [portRow(1, 'Gi0/1', { state: 'learning' })]);
    const sw2 = stpDevice('sw2', [switched('Gi0/1', 'l')], [bridgeRow(1, { topologyChanges: 3 })], [portRow(1, 'Gi0/1', { role: 'root' })]);
    const model = buildStpOverlay(snapshot([sw1, sw2], [link('l', ['sw1', 'Gi0/1'], ['sw2', 'Gi0/1'])]), { vlan: null, now: 0 });
    expect(stpDeviceFacts(model).get('sw1')?.text).toBe('root bridge for VLAN 1, 1 topology change');
    expect(stpDeviceFacts(model).get('sw2')).toEqual({ short: 'TC 3', text: '3 topology changes' });
    expect(stpLinkFacts(model).get('l')).toEqual({ short: 'converging', text: 'joining the spanning tree' });
  });

  it('has nothing to say without a model', () => {
    expect(stpPortFacts(null).size).toBe(0);
    expect(stpDeviceFacts(null).size).toBe(0);
    expect(stpLinkFacts(null).size).toBe(0);
  });
});
