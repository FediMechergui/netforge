// [S26] The neighbours overlay's pure model (ARCHITECTURE-P3C §6, §7 W1c web-canvas, §10.2; lesson 28): a chip per
// CDP/LLDP entry at its cable end (`R1 · Gi0/0 · R`) with the holdtime ring, a hollow glyph where a device listens and
// hears nobody, the protocol selector, and "map from here" dimming what the neighbour tables cannot reach — from the
// snapshot's `cdp-neighbours` / `lldp-neighbours` rows and process views only.
import { describe, expect, it } from 'vitest';
import type { CdpNeighbourRow, DeviceSnapshot, LldpNeighbourRow, PortSnapshot, StateView } from '@netforge/engine';
import { SEC } from '@netforge/engine/contracts';
import {
  NEIGHBOUR_RING_STEPS,
  buildNeighboursOverlay,
  deriveDeviceNeighbours,
  neighboursModelNeedsClock,
  protocolsOf,
  ringShare,
} from '../src/canvas/overlays/neighbours-model';
import { NEIGHBOURS_OVERLAY, TOPO_OVERLAY_DEFAULTS } from '../src/canvas/overlays/registry';
import { neighbourLinks, neighboursDeviceFacts, neighboursPortFacts } from '../src/canvas/neighbours';
import { device, link, port, snapshot } from './canvas-fixtures';

const G0 = 'GigabitEthernet0/0';
const G1 = 'GigabitEthernet0/1';
const NOW = 30 * SEC;

function up(id: string, short: string): PortSnapshot {
  return port(id, { short, operUp: true });
}

function cdp(localPort: string, deviceId: string, remotePort: string, capabilities: string, leftS = 150, holdtimeS = 180): CdpNeighbourRow {
  return {
    key: `${localPort}|${deviceId}`,
    updatedAt: 0,
    expiresAt: NOW + leftS * SEC,
    localPort,
    deviceId,
    remotePort,
    platform: 'NF',
    capabilities,
    addresses: '',
    version: '',
    holdtimeS,
    cdpVersion: 2,
  };
}

function lldp(localPort: string, systemName: string, portId: string, leftS = 120, ttlS = 120): LldpNeighbourRow {
  return { key: `${localPort}|${systemName}|${portId}`, updatedAt: 0, expiresAt: NOW + leftS * SEC, localPort, chassisId: `chassis-${systemName}`, portId, ttlS, systemName, enabled: 'B,R' };
}

function views(cdpOn: boolean, lldpOn: boolean, extra: { disabled?: string[]; noReceive?: string[] } = {}): StateView[] {
  const out: StateView[] = [];
  if (cdpOn) out.push({ process: 'cdp', state: { running: true, disabled: extra.disabled ?? [] } });
  if (lldpOn) out.push({ process: 'lldp', state: { running: true, noReceive: extra.noReceive ?? [], noTransmit: [] } });
  return out;
}

function withRows(d: DeviceSnapshot, cdpRows: CdpNeighbourRow[], lldpRows: LldpNeighbourRow[] = []): DeviceSnapshot {
  return {
    ...d,
    tables: {
      ...d.tables,
      extra: [
        { name: 'cdp-neighbours', title: 'CDP neighbours', columns: [], rows: cdpRows as unknown as Record<string, unknown>[] },
        { name: 'lldp-neighbours', title: 'LLDP neighbours', columns: [], rows: lldpRows as unknown as Record<string, unknown>[] },
      ],
    },
  };
}

/** r1 Gi0/0 — sw1 Fa0/1; sw1 Fa0/2 — r2 Gi0/0; r2 Gi0/1 — pc eth0 (the pc runs nothing). */
function world(opts: { r2Lldp?: boolean } = {}) {
  const r1 = withRows(
    device('r1', 0, 0, [up(G0, 'Gi0/0')], { kind: 'router', name: 'R1', processes: views(true, true) }),
    [cdp(G0, 'SW1', 'FastEthernet0/1', 'S I')],
    [lldp(G0, 'SW1', 'FastEthernet0/1', 60)],
  );
  const sw1 = withRows(
    device('sw1', 0, 0, [up('FastEthernet0/1', 'Fa0/1'), up('FastEthernet0/2', 'Fa0/2')], { kind: 'switch', name: 'SW1', processes: views(true, false) }),
    [cdp('FastEthernet0/1', 'R1', G0, 'R'), cdp('FastEthernet0/2', 'R2', G0, 'R', 15)],
  );
  const r2 = withRows(
    device('r2', 0, 0, [up(G0, 'Gi0/0'), up(G1, 'Gi0/1')], { kind: 'router', name: 'R2', processes: views(true, opts.r2Lldp ?? false) }),
    [cdp(G0, 'SW1', 'FastEthernet0/2', 'S I')],
  );
  const pc = device('pc', 0, 0, [up('eth0', 'eth0')]);
  return snapshot(
    [r1, sw1, r2, pc],
    [link('a', ['r1', G0], ['sw1', 'FastEthernet0/1']), link('b', ['sw1', 'FastEthernet0/2'], ['r2', G0]), link('c', ['r2', G1], ['pc', 'eth0'])],
    { now: NOW },
  );
}

describe('the neighbour chips', () => {
  it('puts a chip at each cable end with an entry: name · its port (short) · capability letters', () => {
    const model = buildNeighboursOverlay(world(), { protocol: 'cdp' });
    expect(model.chips.map((c) => [c.device, c.port, c.text, c.peer, c.link, c.end])).toEqual([
      ['r1', G0, 'SW1 · Fa0/1 · S I', 'sw1', 'a', 'a'],
      ['sw1', 'FastEthernet0/1', 'R1 · Gi0/0 · R', 'r1', 'a', 'b'],
      ['sw1', 'FastEthernet0/2', 'R2 · Gi0/0 · R', 'r2', 'b', 'a'],
      ['r2', G0, 'SW1 · Fa0/2 · S I', 'sw1', 'b', 'b'],
    ]);
    expect(model.protocol).toBe('cdp');
    expect(model.devices.map((d) => [d.device, d.protocols, d.entries])).toEqual([
      ['r1', ['cdp'], 1],
      ['sw1', ['cdp'], 2],
      ['r2', ['cdp'], 1],
    ]);
  });

  it('draws the holdtime ring as the share still to run, in 1/24 steps, with the seconds left', () => {
    const model = buildNeighboursOverlay(world(), { protocol: 'cdp', now: NOW });
    const r1 = model.chips[0]!;
    expect(r1.ring).toBe(Math.round((150 / 180) * NEIGHBOUR_RING_STEPS) / NEIGHBOUR_RING_STEPS);
    expect(r1.remainingS).toBe(150);
    expect(r1.holdS).toBe(180);
    const r2 = model.chips[2]!;
    expect(r2.ring).toBe(Math.round((15 / 180) * NEIGHBOUR_RING_STEPS) / NEIGHBOUR_RING_STEPS);
    expect(ringShare(undefined, 180, NOW)).toBe(1);
    expect(ringShare(NOW - SEC, 180, NOW)).toBe(0);
    expect(ringShare(NOW + 500 * SEC, 180, NOW)).toBe(1);
    expect(neighboursModelNeedsClock(model)).toBe(true);
    expect(neighboursModelNeedsClock(null)).toBe(false);
  });

  it('with both protocols, one chip carries a neighbour both report on a port, with the shorter ring', () => {
    const model = buildNeighboursOverlay(world(), { protocol: 'both' });
    const r1 = model.chips.filter((c) => c.device === 'r1');
    expect(r1).toHaveLength(1);
    expect(r1[0]).toMatchObject({ protocols: ['cdp', 'lldp'], ring: Math.round((60 / 120) * NEIGHBOUR_RING_STEPS) / NEIGHBOUR_RING_STEPS, remainingS: 60, holdS: 120 });
    const lldpOnly = buildNeighboursOverlay(world(), { protocol: 'lldp' });
    expect(lldpOnly.chips.map((c) => [c.device, c.text, c.protocols])).toEqual([['r1', 'SW1 · Fa0/1 · B R', ['lldp']]]);
    expect(protocolsOf('both')).toEqual(['cdp', 'lldp']);
    expect(protocolsOf(undefined)).toEqual(['cdp', 'lldp']);
  });
});

describe('the hollow glyph', () => {
  it('marks an up, cabled port where the device runs the protocol and hears nobody', () => {
    const model = buildNeighboursOverlay(world(), { protocol: 'cdp' });
    expect(model.hollows).toEqual([{ device: 'r2', port: G1, link: 'c', end: 'a', protocols: ['cdp'] }]);
    // the pc runs nothing: no glyph and no device mark of its own
    expect(model.devices.some((d) => d.device === 'pc')).toBe(false);
    // with LLDP shown too, r2 listens with both
    const both = buildNeighboursOverlay(world({ r2Lldp: true }), { protocol: 'both' });
    expect(both.hollows.find((h) => h.device === 'r2' && h.port === G1)?.protocols).toEqual(['cdp', 'lldp']);
  });

  it('is not drawn on a port where the protocol does not listen, or that is down', () => {
    const snap = world();
    const deaf = { ...snap, devices: snap.devices.map((d) => (d.id === 'r2' ? { ...d, processes: views(true, false, { disabled: [G1] }) } : d)) };
    expect(buildNeighboursOverlay(deaf, { protocol: 'cdp' }).hollows).toEqual([]);
    const down = { ...snap, links: snap.links.map((l) => (l.id === 'c' ? { ...l, up: false } : l)) };
    expect(buildNeighboursOverlay(down, { protocol: 'cdp' }).hollows).toEqual([]);
  });
});

describe('map from here', () => {
  it('reaches what the neighbour tables reach, hop by hop, and dims the rest', () => {
    const model = buildNeighboursOverlay(world(), { protocol: 'cdp', from: 'r1' });
    expect(model.from).toBe('r1');
    expect(model.reachable).toEqual(['r1', 'sw1', 'r2']);
    expect(model.dimmed).toEqual(['pc']);
    // LLDP alone: r1 hears sw1, and sw1 runs no LLDP, so the map stops there
    const lldpOnly = buildNeighboursOverlay(world(), { protocol: 'lldp', from: 'r1' });
    expect(lldpOnly.reachable).toEqual(['r1', 'sw1']);
    expect(lldpOnly.dimmed).toEqual(['r2', 'pc']);
  });

  it('is off without a selected device, or with one the world does not have', () => {
    for (const from of [undefined, null, 'gone']) {
      const model = buildNeighboursOverlay(world(), from === undefined ? {} : { from });
      expect(model.from).toBeNull();
      expect(model.reachable).toEqual([]);
      expect(model.dimmed).toEqual([]);
    }
  });

  it('names a neighbour by its hostname when its port has no cable', () => {
    const lone = withRows(device('r9', 0, 0, [up(G0, 'Gi0/0')], { kind: 'router', processes: views(true, false) }), [cdp(G0, 'core-1', G1, 'R')]);
    const core = device('core', 0, 0, [up(G1, 'Gi0/1')], { kind: 'router', name: 'Core', runningConfig: 'hostname core-1\n!' });
    const model = buildNeighboursOverlay(snapshot([lone, core], [], { now: NOW }), { from: 'r9' });
    expect(model.chips[0]).toMatchObject({ peer: 'core', text: 'core-1 · Gi0/1 · R' });
    expect(model.reachable).toEqual(['r9', 'core']);
    expect(deriveDeviceNeighbours(core).hostname).toBe('core-1');
  });
});

describe('the registry entry and the text forms', () => {
  it('is synced only while the overlay is on, with the slice protocol, the clock and the selected device', () => {
    const snap = world();
    expect(NEIGHBOURS_OVERLAY.sync({ state: TOPO_OVERLAY_DEFAULTS, snapshot: snap, now: NOW })).toBeNull();
    const state = { ...TOPO_OVERLAY_DEFAULTS, neighbours: true, neighbourProtocol: 'cdp' as const };
    expect(NEIGHBOURS_OVERLAY.sync({ state, snapshot: null, now: NOW })).toBeNull();
    expect(NEIGHBOURS_OVERLAY.sync({ state, snapshot: snap, now: NOW, from: 'r1' })).toEqual(buildNeighboursOverlay(snap, { protocol: 'cdp', now: NOW, from: 'r1' }));
    expect(NEIGHBOURS_OVERLAY.sync({ state, snapshot: snap, now: NOW })?.from).toBeNull();
  });

  it('says the chips, the hollow glyphs and the map in text, and marks the cables heard', () => {
    const model = buildNeighboursOverlay(world(), { protocol: 'cdp', from: 'r1' });
    const ports = neighboursPortFacts(model);
    expect(ports.get(`r1/${G0}`)).toEqual({ short: 'SW1 · Fa0/1 · S I', text: 'CDP neighbour SW1 on its FastEthernet0/1, capabilities S I, holdtime 180 s, 150 s left' });
    expect(ports.get(`r2/${G1}`)).toEqual({ short: '○', text: 'CDP listening, no neighbour heard' });
    const devices = neighboursDeviceFacts(model);
    expect(devices.get('sw1')).toEqual({ short: '2 nbr', text: 'CDP: 2 neighbour entries' });
    expect(devices.get('pc')).toEqual({ short: 'unmapped', text: 'not reachable from the selected device through neighbour tables' });
    expect([...neighbourLinks(model)]).toEqual([
      ['a', 'both'],
      ['b', 'both'],
    ]);
    expect(neighboursPortFacts(null).size).toBe(0);
  });
});
