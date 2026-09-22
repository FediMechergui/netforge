// The spanning-tree overlay model (ARCHITECTURE-P2 §6, §10.2 "overlays.stp-model"): the root crown, role letters and
// state glyphs, the active tree against blocked links, the draining bar and the topology-change wave.
import { describe, expect, it } from 'vitest';
import type { DeviceSnapshot, PortSnapshot, StpBridgeRow, StpPortRow } from '@netforge/engine';
import {
  buildStpOverlay,
  chooseStpVlan,
  deriveDeviceStp,
  drainFraction,
  isBlockedState,
  newTopologyChanges,
  roleLetter,
  rootLabel,
  stateGlyph,
  stpRowFor,
  stpVlansOf,
} from '../src/canvas/overlays/stp-model.js';
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

/** SW1 (root) — SW2 — SW3 — SW1: the triangle of §3.6 with SW3's Gi0/2 blocked. */
function triangle(now = 90 * SEC) {
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
    [portRow(1, 'Gi0/1', { role: 'root' }), portRow(1, 'Gi0/2')],
  );
  const sw3 = stpDevice(
    'sw3',
    [switched('Gi0/1', 'l13'), switched('Gi0/2', 'l23')],
    [bridgeRow(1, { rootPort: 'Gi0/1', bridgeId: '32769/00:1f:00:0c:00:00' })],
    [portRow(1, 'Gi0/1', { role: 'root' }), portRow(1, 'Gi0/2', { role: 'alternate', state: 'blocking' })],
  );
  return {
    snap: snapshot([sw1, sw2, sw3], [
      link('l12', ['sw1', 'Gi0/1'], ['sw2', 'Gi0/1']),
      link('l13', ['sw1', 'Gi0/2'], ['sw3', 'Gi0/1']),
      link('l23', ['sw2', 'Gi0/2'], ['sw3', 'Gi0/2']),
    ], { now }),
    now,
  };
}

describe('glyphs and labels', () => {
  it('letters the roles and glyphs the states', () => {
    expect(roleLetter('root')).toBe('R');
    expect(roleLetter('designated')).toBe('D');
    expect(roleLetter('alternate')).toBe('A');
    expect(roleLetter('backup')).toBe('B');
    expect(roleLetter('mystery')).toBe('mystery');
    expect(stateGlyph('forwarding')).toBe('');
    expect(stateGlyph('blocking')).toBe('✕');
    expect(stateGlyph('discarding')).toBe('✕');
    expect(stateGlyph('learning')).toBe('◐');
    expect(stateGlyph('listening')).toBe('○');
    expect(stateGlyph('mystery')).toBe('');
    expect(isBlockedState('blocking')).toBe(true);
    expect(isBlockedState('discarding')).toBe(true);
    expect(isBlockedState('learning')).toBe(false);
    expect(rootLabel(10)).toBe('ROOT v10');
  });
});

describe('the draining bar', () => {
  const row = { stateSince: 30 * SEC, nextTransitionAt: 45 * SEC };

  it('is 0.5 half way through a 15 s phase (§10.2)', () => {
    expect(drainFraction(row, 37.5 * SEC)).toBe(0.5);
    expect(drainFraction(row, 33.75 * SEC)).toBe(0.75);
    expect(drainFraction(row, 30 * SEC)).toBe(1);
    expect(drainFraction(row, 45 * SEC)).toBe(0);
    expect(drainFraction(row, 60 * SEC)).toBe(0);
  });

  it('is absent without a pending timed change', () => {
    expect(drainFraction({ stateSince: 30 * SEC }, 40 * SEC)).toBeUndefined();
    expect(drainFraction({ stateSince: 45 * SEC, nextTransitionAt: 45 * SEC }, 45 * SEC)).toBeUndefined();
  });
});

describe('the overlay model', () => {
  it('crowns the root only, and letters every port', () => {
    const { snap, now } = triangle();
    const model = buildStpOverlay(snap, { vlan: null, now });
    expect(model.vlan).toBe(1);
    expect(model.vlans).toEqual([1]);
    expect(model.roots).toEqual([{ device: 'sw1', vlan: 1, label: 'ROOT v1', bridgeId: '4097/00:1f:00:0a:00:00' }]);
    expect(model.ports).toHaveLength(6);
    expect(model.ports.filter((p) => p.letter === 'R').map((p) => p.device)).toEqual(['sw2', 'sw3']);
    expect(model.ports.filter((p) => p.letter === 'D')).toHaveLength(3);
  });

  it('puts an A and a cross on the alternate port and takes its link out of the tree (§10.2)', () => {
    const { snap, now } = triangle();
    const model = buildStpOverlay(snap, { vlan: 1, now });
    const alternate = model.ports.find((p) => p.role === 'alternate');
    expect(alternate).toMatchObject({ device: 'sw3', port: 'Gi0/2', letter: 'A', glyph: '✕', blocked: true, end: 'b' });
    const blocked = model.links.find((l) => l.link === 'l23');
    expect(blocked?.status).toBe('blocked');
    expect(blocked?.blockedEnds).toEqual(['b']);
    for (const id of ['l12', 'l13']) expect(model.links.find((l) => l.link === id)?.status).toBe('active');
  });

  it('calls a link converging while an end still listens, and none when it is down', () => {
    const { snap, now } = triangle();
    const sw2 = snap.devices.find((d) => d.id === 'sw2') as DeviceSnapshot;
    const rows = sw2.tables.extra?.[0]?.rows as unknown as StpPortRow[];
    rows[1] = portRow(1, 'Gi0/2', { state: 'listening', nextTransitionAt: 45 * SEC });
    const model = buildStpOverlay(snap, { vlan: 1, now: 37.5 * SEC });
    expect(model.links.find((l) => l.link === 'l23')?.status).toBe('blocked'); // the far end still blocks
    const listening = model.ports.find((p) => p.device === 'sw2' && p.port === 'Gi0/2');
    expect(listening?.glyph).toBe('○');
    expect(listening?.drain).toBe(0.5);

    const down = snapshot(snap.devices, snap.links.map((l) => (l.id === 'l12' ? { ...l, up: false } : l)), { now });
    expect(buildStpOverlay(down, { vlan: 1, now }).links.find((l) => l.link === 'l12')?.status).toBe('none');
  });

  it('chooses the VLAN: the wanted one, else the lowest, and draws nothing without an instance', () => {
    expect(chooseStpVlan([1, 10, 20], 10)).toBe(10);
    expect(chooseStpVlan([1, 10, 20], 30)).toBe(1);
    expect(chooseStpVlan([1, 10, 20], null)).toBe(1);
    expect(chooseStpVlan([], 10)).toBeNull();
    const empty = buildStpOverlay(snapshot([device('pc1', 0, 0, [port('Gi0')])], []), { vlan: null, now: 0 });
    expect(empty).toEqual({ vlan: null, vlans: [], roots: [], ports: [], links: [], changes: [] });
  });

  it('lists every VLAN with an instance, ascending', () => {
    const sw1 = stpDevice('sw1', [switched('Gi0/1', 'l1')], [bridgeRow(20), bridgeRow(1, { isRoot: true })], [portRow(1, 'Gi0/1'), portRow(20, 'Gi0/1')]);
    const sw2 = stpDevice('sw2', [switched('Gi0/1', 'l1')], [bridgeRow(10)], [portRow(10, 'Gi0/1')]);
    const snap = snapshot([sw1, sw2], [link('l1', ['sw1', 'Gi0/1'], ['sw2', 'Gi0/1'])]);
    expect(stpVlansOf(snap)).toEqual([1, 10, 20]);
    expect(buildStpOverlay(snap, { vlan: 10, now: 0 }).ports.map((p) => p.device)).toEqual(['sw2']);
  });

  it('shows a bundled member through its Port-channel row', () => {
    const member = port('Gi0/1', {
      short: 'Gi0/1',
      role: 'switched',
      operUp: true,
      link: 'l1',
      l2: { config: { mode: 'trunk', negotiate: true, accessVlan: 1, nativeVlan: 1, allowed: '1-4094' }, oper: 'trunk', channel: { group: 1, bundle: 'Port-channel1', state: 'bundled' } },
    });
    const sw1 = stpDevice('sw1', [member], [bridgeRow(1, { isRoot: true })], [portRow(1, 'Port-channel1', { cost: 3 })]);
    const stp = deriveDeviceStp(sw1);
    expect(stpRowFor(stp, 1, 'Gi0/1')).toMatchObject({ viaBundle: 'Port-channel1' });
    expect(stpRowFor(stp, 1, 'Gi0/9')).toBeUndefined();
    const sw2 = stpDevice('sw2', [switched('Gi0/1', 'l1')], [bridgeRow(1)], [portRow(1, 'Gi0/1', { role: 'root' })]);
    const model = buildStpOverlay(snapshot([sw1, sw2], [link('l1', ['sw1', 'Gi0/1'], ['sw2', 'Gi0/1'])]), { vlan: 1, now: 0 });
    expect(model.ports.find((p) => p.device === 'sw1')).toMatchObject({ port: 'Gi0/1', viaBundle: 'Port-channel1', letter: 'D' });
  });

  it('carries an inconsistency through', () => {
    const sw1 = stpDevice('sw1', [switched('Gi0/1', 'l1')], [bridgeRow(1, { isRoot: true })], [portRow(1, 'Gi0/1', { inconsistent: 'pvid', state: 'blocking' })]);
    const sw2 = stpDevice('sw2', [switched('Gi0/1', 'l1')], [bridgeRow(1)], [portRow(1, 'Gi0/1', { role: 'root' })]);
    const model = buildStpOverlay(snapshot([sw1, sw2], [link('l1', ['sw1', 'Gi0/1'], ['sw2', 'Gi0/1'])]), { vlan: 1, now: 0 });
    expect(model.ports.find((p) => p.device === 'sw1')?.inconsistent).toBe('pvid');
    expect(model.links[0]?.status).toBe('blocked');
  });
});

describe('the topology-change wave', () => {
  it('reports a bridge whose counter went up, with its last change port', () => {
    const { snap, now } = triangle();
    const before = buildStpOverlay(snap, { vlan: 1, now });
    expect(newTopologyChanges(null, before)).toEqual([]);
    expect(newTopologyChanges(before, before)).toEqual([]);

    const sw1 = snap.devices.find((d) => d.id === 'sw1') as DeviceSnapshot;
    const bridges = sw1.tables.extra?.[1]?.rows as unknown as StpBridgeRow[];
    bridges[0] = bridgeRow(1, { isRoot: true, topologyChanges: 3, lastChangeAt: 95 * SEC, lastChangePort: 'Gi0/2' });
    const after = buildStpOverlay(snap, { vlan: 1, now: 95 * SEC });
    expect(newTopologyChanges(before, after)).toEqual([{ device: 'sw1', vlan: 1, count: 3, at: 95 * SEC, port: 'Gi0/2' }]);
  });

  it('reports nothing when the selector moved to another VLAN', () => {
    const { snap, now } = triangle();
    const model = buildStpOverlay(snap, { vlan: 1, now });
    const other = { ...model, vlan: 10 };
    expect(newTopologyChanges(other, model)).toEqual([]);
  });
});
