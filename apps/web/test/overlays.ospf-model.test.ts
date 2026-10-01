// [S1] The OSPF overlay model (ARCHITECTURE-P3 §6, §3.1, §3.2, §10.2 "overlays.ospf-model"): the adjacency underlay and
// its chips from both ends' rows, DR/BDR letters, cost chips, passive and refusal glyphs, the draining bar at 0.5 in the
// middle of Waiting, and the area zones.
import { describe, expect, it } from 'vitest';
import type { DeviceSnapshot, OspfInterfaceRow, OspfNeighborRow, OspfNsmState, PortSnapshot } from '@netforge/engine';
import {
  OSPF_NBR_CHIP,
  areaLabel,
  buildOspfOverlay,
  chooseOspfArea,
  costChip,
  deriveDeviceOspf,
  isTransientNbrState,
  nbrChip,
  ospfAreasOf,
  waitDrainFraction,
} from '../src/canvas/overlays/ospf-model.js';
import { device, link, port, snapshot } from './canvas-fixtures.js';

const SEC = 1_000_000_000;
const U = 100 * SEC;

function ifRow(portId: string, routerId: string, over: Partial<OspfInterfaceRow> = {}): OspfInterfaceRow {
  return {
    key: portId,
    port: portId,
    process: 1,
    routerId,
    area: '0.0.0.0',
    networkType: 'point-to-point',
    state: 'point-to-point',
    cost: 1,
    costSource: 'bandwidth',
    priority: 1,
    helloS: 10,
    deadS: 40,
    passive: false,
    neighbors: 1,
    adjacent: 1,
    stateSince: U,
    ...over,
  } as OspfInterfaceRow;
}

function nbrRow(portId: string, routerId: string, state: OspfNsmState, over: Partial<OspfNeighborRow> = {}): OspfNeighborRow {
  return {
    key: `${portId}|${routerId}`,
    port: portId,
    routerId,
    address: '10.0.12.2',
    priority: 1,
    state,
    role: 'none',
    dr: '0.0.0.0',
    bdr: '0.0.0.0',
    stateSince: U,
    ...over,
  } as OspfNeighborRow;
}

function routed(id: string, linkId?: string): PortSnapshot {
  return port(id, { short: id, role: 'routed', operUp: true, ...(linkId === undefined ? {} : { link: linkId }) });
}

function router(id: string, ports: PortSnapshot[], ifs: OspfInterfaceRow[], nbrs: OspfNeighborRow[]): DeviceSnapshot {
  return device(id, 0, 0, ports, {
    type: 'router.nf2911',
    model: 'NF-2911',
    kind: 'router',
    tables: {
      cam: [],
      arp: [],
      rib: [],
      extra: [
        { name: 'ospf-interfaces', title: 'OSPF interfaces', columns: [], rows: ifs as unknown as Record<string, unknown>[] },
        { name: 'ospf-neighbors', title: 'OSPF neighbours', columns: [], rows: nbrs as unknown as Record<string, unknown>[] },
      ],
    },
  });
}

/** §3.2: R1 Gi0/0 — R2 Gi0/0 point-to-point; R1 Se0/0/0 — R3 Se0/0/0 (cost 64); R1 Gi0/1 a passive LAN. */
function triangle(r1ToR2: OspfNsmState, r2ToR1: OspfNsmState, now = U) {
  const r1 = router(
    'r1',
    [routed('Gi0/0', 'l12'), routed('Se0/0/0', 'l13'), routed('Gi0/1', 'lan1')],
    [
      ifRow('Gi0/0', '1.1.1.1'),
      ifRow('Se0/0/0', '1.1.1.1', { cost: 64 }),
      ifRow('Gi0/1', '1.1.1.1', { networkType: 'broadcast', state: 'dr', passive: true, neighbors: 0, adjacent: 0 }),
    ],
    [nbrRow('Gi0/0', '2.2.2.2', r1ToR2), nbrRow('Se0/0/0', '3.3.3.3', 'full')],
  );
  const r2 = router('r2', [routed('Gi0/0', 'l12')], [ifRow('Gi0/0', '2.2.2.2')], [nbrRow('Gi0/0', '1.1.1.1', r2ToR1)]);
  const r3 = router('r3', [routed('Se0/0/0', 'l13')], [ifRow('Se0/0/0', '3.3.3.3', { cost: 64 })], [nbrRow('Se0/0/0', '1.1.1.1', 'full')]);
  const pc = device('pc1', 0, 0, [routed('Gi0', 'lan1')]);
  return snapshot([r1, r2, r3, pc], [
    link('l12', ['r1', 'Gi0/0'], ['r2', 'Gi0/0']),
    link('l13', ['r1', 'Se0/0/0'], ['r3', 'Se0/0/0'], { media: 'serial-dce', resolvedMedia: 'serial-dce' }),
    link('lan1', ['r1', 'Gi0/1'], ['pc1', 'Gi0']),
  ], { now });
}

/** §3.1: R1, R2, R3 on SW1's LAN 10.0.123.0/24. */
function lan(r1: { state: OspfInterfaceRow['state']; nbrs: OspfNeighborRow[]; waitUntil?: number }, now = U) {
  const bcast = (routerId: string, state: OspfInterfaceRow['state'], extra: Partial<OspfInterfaceRow> = {}) =>
    ifRow('Gi0/0', routerId, { networkType: 'broadcast', state, neighbors: 2, adjacent: 2, ...extra });
  const r1d = router('r1', [routed('Gi0/0', 'l1')], [bcast('1.1.1.1', r1.state, r1.waitUntil === undefined ? {} : { waitUntil: r1.waitUntil })], r1.nbrs);
  const r2d = router('r2', [routed('Gi0/0', 'l2')], [bcast('2.2.2.2', 'dr')], [nbrRow('Gi0/0', '1.1.1.1', 'full'), nbrRow('Gi0/0', '3.3.3.3', 'full')]);
  const r3d = router('r3', [routed('Gi0/0', 'l3')], [bcast('3.3.3.3', 'drother')], [nbrRow('Gi0/0', '2.2.2.2', 'full'), nbrRow('Gi0/0', '1.1.1.1', 'full')]);
  const sw1 = device('sw1', 0, 0, [port('Fa0/1', { link: 'l1', operUp: true }), port('Fa0/2', { link: 'l2', operUp: true }), port('Fa0/3', { link: 'l3', operUp: true })], {
    type: 'switch.nfc2960',
    model: 'NF-C2960',
    kind: 'switch',
  });
  return snapshot([sw1, r1d, r2d, r3d], [
    link('l1', ['r1', 'Gi0/0'], ['sw1', 'Fa0/1']),
    link('l2', ['r2', 'Gi0/0'], ['sw1', 'Fa0/2']),
    link('l3', ['sw1', 'Fa0/3'], ['r3', 'Gi0/0']),
  ], { now });
}

describe('chips and glyphs', () => {
  it('chips the neighbour states and pulses only the ones on the way to FULL', () => {
    expect(OSPF_NBR_CHIP).toMatchObject({ init: 'IN', '2way': '2W', exstart: 'XS', exchange: 'XC', loading: 'LD', full: '', down: '' });
    expect(nbrChip('mystery')).toBe('mystery');
    for (const s of ['init', 'exstart', 'exchange', 'loading'] as const) expect(isTransientNbrState(s), s).toBe(true);
    for (const s of ['down', '2way', 'full'] as const) expect(isTransientNbrState(s), s).toBe(false);
    expect(costChip(64)).toBe('c64');
    expect(costChip(1)).toBe('c1');
  });

  it('labels areas the way a learner typed them', () => {
    expect(areaLabel('0.0.0.0')).toBe('Area 0');
    expect(areaLabel('0.0.0.1')).toBe('Area 1');
    expect(areaLabel('0.0.0.255')).toBe('Area 255');
    expect(areaLabel('0.0.1.0')).toBe('Area 0.0.1.0');
    expect(areaLabel('10.0.0.0')).toBe('Area 10.0.0.0');
    expect(areaLabel('backbone')).toBe('Area backbone');
  });
});

describe('the adjacency underlay', () => {
  it('is thick with no chip when both ends are FULL, and chips the serial cost', () => {
    const model = buildOspfOverlay(triangle('full', 'full'), { now: U });
    expect(model.links.find((l) => l.link === 'l12')).toEqual({ link: 'l12', state: 'full', weight: 'thick', chip: '', pulse: false, ends: ['a', 'b'] });
    expect(model.links.find((l) => l.link === 'l13')).toMatchObject({ state: 'full', weight: 'thick' });
    const serial = model.ports.filter((p) => p.port === 'Se0/0/0');
    expect(serial.map((p) => [p.device, p.costChip])).toEqual([
      ['r1', 'c64'],
      ['r3', 'c64'],
    ]);
    expect(model.ports.find((p) => p.device === 'r1' && p.port === 'Gi0/0')?.costChip).toBe('c1');
  });

  it('shows each state of the building adjacency with its pulsing chip, static under reduced motion', () => {
    for (const [state, chip] of [['init', 'IN'], ['exstart', 'XS'], ['exchange', 'XC'], ['loading', 'LD']] as const) {
      const moving = buildOspfOverlay(triangle(state, state), { now: U }).links.find((l) => l.link === 'l12');
      expect(moving, state).toMatchObject({ state, weight: 'thin', chip, pulse: true });
      const still = buildOspfOverlay(triangle(state, state), { now: U, reducedMotion: true }).links.find((l) => l.link === 'l12');
      expect(still, state).toMatchObject({ state, weight: 'thin', chip, pulse: false });
    }
  });

  it('takes the less advanced of the two ends, and draws nothing while one end has no neighbour yet', () => {
    expect(buildOspfOverlay(triangle('full', 'loading'), { now: U }).links[0]).toMatchObject({ state: 'loading', chip: 'LD' });
    expect(buildOspfOverlay(triangle('exchange', 'full'), { now: U }).links[0]).toMatchObject({ state: 'exchange', chip: 'XC' });
    const snap = triangle('init', 'init');
    const r2 = snap.devices.find((d) => d.id === 'r2') as DeviceSnapshot;
    (r2.tables.extra?.[1] as { rows: unknown[] }).rows = []; // R2 has not heard R1 yet
    expect(buildOspfOverlay(snap, { now: U }).links[0]).toMatchObject({ state: 'down', weight: 'none', chip: '', pulse: false });
  });

  it('draws nothing on a cable that is down, and leaves out cables with no OSPF end', () => {
    const snap = triangle('full', 'full');
    const down = { ...snap, links: snap.links.map((l) => (l.id === 'l12' ? { ...l, up: false } : l)) };
    expect(buildOspfOverlay(down, { now: U }).links.find((l) => l.link === 'l12')).toMatchObject({ state: 'none', weight: 'none', chip: '' });
    // The passive LAN has one OSPF end (R1) and no neighbour: listed, nothing drawn.
    expect(buildOspfOverlay(snap, { now: U }).links.find((l) => l.link === 'lan1')).toMatchObject({ state: 'down', weight: 'none', ends: ['a'] });
    const plain = snapshot([device('pc1', 0, 0, [routed('Gi0', 'x')]), device('pc2', 0, 0, [routed('Gi0', 'x')])], [link('x', ['pc1', 'Gi0'], ['pc2', 'Gi0'])]);
    expect(buildOspfOverlay(plain, { now: 0 })).toEqual({ area: null, areas: [], zones: [], ports: [], links: [] });
  });

  it('on a LAN, shows the router’s most advanced neighbour on the switch cable, and 2W between two DROthers', () => {
    const full = buildOspfOverlay(lan({ state: 'backup', nbrs: [nbrRow('Gi0/0', '2.2.2.2', 'full'), nbrRow('Gi0/0', '3.3.3.3', 'full')] }), { now: U });
    expect(full.links.map((l) => [l.link, l.weight, l.ends])).toEqual([
      ['l1', 'thick', ['a']],
      ['l2', 'thick', ['a']],
      ['l3', 'thick', ['b']],
    ]);
    const twoWay = buildOspfOverlay(lan({ state: 'drother', nbrs: [nbrRow('Gi0/0', '3.3.3.3', '2way')] }), { now: U });
    expect(twoWay.links.find((l) => l.link === 'l1')).toMatchObject({ state: '2way', weight: 'thin', chip: '2W', pulse: false });
  });
});

describe('port anchors', () => {
  it('letters the DR and the BDR on the LAN and nothing on a DROther (§3.1 after step 7)', () => {
    const model = buildOspfOverlay(lan({ state: 'backup', nbrs: [nbrRow('Gi0/0', '2.2.2.2', 'full'), nbrRow('Gi0/0', '3.3.3.3', 'full')] }), { now: U });
    expect(model.ports.map((p) => [p.device, p.state, p.role])).toEqual([
      ['r1', 'backup', 'BDR'],
      ['r2', 'dr', 'DR'],
      ['r3', 'drother', ''],
    ]);
    expect(model.ports.every((p) => p.networkType === 'broadcast')).toBe(true);
    expect(model.ports.find((p) => p.device === 'r3')).toMatchObject({ link: 'l3', end: 'b', neighbors: 2, adjacent: 2 });
  });

  it('draws the draining bar at 0.5 in the middle of Waiting, and none after it', () => {
    expect(waitDrainFraction({ state: 'waiting', stateSince: U, waitUntil: U + 40 * SEC }, U + 20 * SEC)).toBe(0.5);
    expect(waitDrainFraction({ state: 'waiting', stateSince: U, waitUntil: U + 40 * SEC }, U)).toBe(1);
    expect(waitDrainFraction({ state: 'waiting', stateSince: U, waitUntil: U + 40 * SEC }, U + 50 * SEC)).toBe(0);
    expect(waitDrainFraction({ state: 'drother', stateSince: U, waitUntil: U + 40 * SEC }, U + 20 * SEC)).toBeUndefined();
    expect(waitDrainFraction({ state: 'waiting', stateSince: U }, U + 20 * SEC)).toBeUndefined();

    const waiting = lan({ state: 'waiting', nbrs: [nbrRow('Gi0/0', '2.2.2.2', '2way')], waitUntil: U + 40 * SEC }, U + 20 * SEC);
    const model = buildOspfOverlay(waiting, { now: U + 20 * SEC });
    expect(model.ports.find((p) => p.device === 'r1')).toMatchObject({ state: 'waiting', role: '', drain: 0.5 });
    expect('drain' in (model.ports.find((p) => p.device === 'r2') as object)).toBe(false);
  });

  it('marks a passive interface with P and a refused hello with ! and its reason', () => {
    const snap = triangle('full', 'full');
    const r2 = snap.devices.find((d) => d.id === 'r2') as DeviceSnapshot;
    const rows = r2.tables.extra?.[0]?.rows as unknown as OspfInterfaceRow[];
    rows[0] = ifRow('Gi0/0', '2.2.2.2', { rejected: { from: '10.0.12.1', routerId: '1.1.1.1', reason: 'hello interval 10 does not match 5', at: U } });
    const model = buildOspfOverlay(snap, { now: U });
    expect(model.ports.find((p) => p.device === 'r1' && p.port === 'Gi0/1')).toMatchObject({ passive: true, passiveGlyph: 'P', role: 'DR' });
    expect(model.ports.find((p) => p.device === 'r1' && p.port === 'Gi0/0')).toMatchObject({ passive: false, passiveGlyph: '' });
    expect(model.ports.find((p) => p.device === 'r2')?.refused).toEqual({
      glyph: '!',
      reason: 'hello interval 10 does not match 5',
      from: '10.0.12.1',
      routerId: '1.1.1.1',
      at: U,
    });
    expect(model.ports.find((p) => p.device === 'r1' && p.port === 'Gi0/0')?.refused).toBeUndefined();
  });

  it('keeps an interface without a cable (a loopback), with no link or end', () => {
    const r1 = router('r1', [routed('Lo0')], [ifRow('Lo0', '1.1.1.1', { networkType: 'loopback', state: 'loopback', neighbors: 0, adjacent: 0 })], []);
    const model = buildOspfOverlay(snapshot([r1]), { now: U });
    expect(model.ports).toHaveLength(1);
    expect('link' in (model.ports[0] as object)).toBe(false);
    expect(model.links).toEqual([]);
  });
});

describe('area zones', () => {
  it('zones every area with its routers and chips it Area 0', () => {
    const model = buildOspfOverlay(triangle('full', 'full'), { now: U });
    expect(model.areas).toEqual(['0.0.0.0']);
    expect(model.area).toBeNull();
    expect(model.zones).toEqual([{ area: '0.0.0.0', label: 'Area 0', devices: ['r1', 'r2', 'r3'] }]);
  });

  it('keeps only the chosen area when one is selected, and every area for an unknown choice', () => {
    const snap = triangle('full', 'full');
    const r3 = snap.devices.find((d) => d.id === 'r3') as DeviceSnapshot;
    const rows = r3.tables.extra?.[0]?.rows as unknown as OspfInterfaceRow[];
    rows[0] = ifRow('Se0/0/0', '3.3.3.3', { cost: 64, area: '0.0.0.1' });
    expect(ospfAreasOf(snap)).toEqual(['0.0.0.0', '0.0.0.1']);
    expect(chooseOspfArea(['0.0.0.0', '0.0.0.1'], '0.0.0.1')).toBe('0.0.0.1');
    expect(chooseOspfArea(['0.0.0.0'], '0.0.0.9')).toBeNull();
    const one = buildOspfOverlay(snap, { now: U, area: '0.0.0.1' });
    expect(one.area).toBe('0.0.0.1');
    expect(one.zones).toEqual([{ area: '0.0.0.1', label: 'Area 1', devices: ['r3'] }]);
    expect(one.ports.map((p) => p.device)).toEqual(['r3']);
    expect(one.links.map((l) => [l.link, l.ends])).toEqual([['l13', ['b']]]);
    const all = buildOspfOverlay(snap, { now: U, area: '0.0.0.9' });
    expect(all.area).toBeNull();
    expect(all.zones.map((z) => z.label)).toEqual(['Area 0', 'Area 1']);
  });

  it('derives a device once from its object and reads nothing from a device without OSPF', () => {
    expect(deriveDeviceOspf(device('pc1', 0, 0, [port('Gi0')])).interfaces.size).toBe(0);
    const r1 = triangle('full', 'full').devices[0] as DeviceSnapshot;
    const ospf = deriveDeviceOspf(r1);
    expect(ospf.routerId).toBe('1.1.1.1');
    expect([...ospf.interfaces.keys()]).toEqual(['Gi0/0', 'Se0/0/0', 'Gi0/1']);
    expect(ospf.neighbors.get('Gi0/0')?.map((n) => n.routerId)).toEqual(['2.2.2.2']);
    const snap = triangle('full', 'full');
    let calls = 0;
    buildOspfOverlay(snap, { now: U }, (d) => {
      calls++;
      return deriveDeviceOspf(d);
    });
    expect(calls).toBe(snap.devices.length);
  });
});
