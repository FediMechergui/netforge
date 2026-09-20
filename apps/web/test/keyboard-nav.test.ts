// Keyboard canvas model (ARCHITECTURE-P1 §7 "Keyboard canvas", §8.1 W6 web-canvas): spatial arrow navigation,
// reading order, cable-graph traversal, the DOM outline model, keyboard cabling candidates and the live-region
// announcer wording and throttling.
import { describe, expect, it } from 'vitest';
import { defineModel, emptyCounters } from '@netforge/engine';
import type {
  AssociationSnapshot,
  DeviceModel,
  DeviceSnapshot,
  LinkSnapshot,
  PortSnapshot,
  PortSpec,
  SimSnapshot,
  TraceEvent,
} from '@netforge/engine';
import { buildCableLookup } from '../src/app/cable/cable-compat.js';
import { dropLabel } from '../src/vocab/drops.js';
import { linkDownText } from '../src/vocab/media.js';
import {
  associationStateText,
  barsText,
  buildOutline,
  cabledPeers,
  cablingSources,
  cablingTargets,
  deviceById,
  deviceOfItem,
  directionForKey,
  filterCandidates,
  firstDevice,
  lastDevice,
  linkById,
  linkStateText,
  nameBook,
  navPoints,
  nextPeerDevice,
  portStatusText,
  rateText,
  readingOrder,
  screenPointOf,
  spatialNeighbour,
  stepInOrder,
  visibleItems,
  type NavPoint,
} from '../src/canvas/a11y/keyboard-nav.js';
import {
  createAnnouncer,
  describeEvent,
  joinWords,
  mergeAnnouncements,
  newEventsSince,
  summarizeEvents,
} from '../src/canvas/a11y/announcer.js';

const GIG = 1_000_000_000;

const PC = defineModel({
  type: 'pc.nfpc', model: 'NF-PC', description: 'Workstation', category: 'computers', icon: 'pc', capabilities: ['host'],
  ports: [{ name: 'GigabitEthernet0', kind: 'ethernet', speedBps: GIG, autoMdix: false }],
}, 'P0.5');
const SWITCH = defineModel({
  type: 'switch.nfsw', model: 'NF-SW', description: 'Switch', category: 'switches', icon: 'switch', capabilities: ['switching'],
  ports: [
    { name: 'FastEthernet0/1', kind: 'ethernet', speedBps: 100_000_000, autoMdix: false },
    { name: 'FastEthernet0/2', kind: 'ethernet', speedBps: 100_000_000, autoMdix: false },
    { name: 'FastEthernet0/3', kind: 'ethernet', speedBps: 100_000_000, autoMdix: false },
  ],
}, 'P0.5');
const ROUTER = defineModel({
  type: 'router.nfr', model: 'NF-R', description: 'Router', category: 'routers', icon: 'router', capabilities: ['routing'],
  ports: [
    { name: 'GigabitEthernet0/0', kind: 'ethernet', speedBps: GIG, autoMdix: false },
    { name: 'Serial0/0/0', kind: 'serial', speedBps: 2_000_000 },
  ],
}, 'P0.5');
const AP = defineModel({
  type: 'ap.nfap', model: 'NF-AP', description: 'Access point', category: 'wireless', icon: 'ap', capabilities: ['wifi-ap'],
  ports: [
    { name: 'GigabitEthernet0', kind: 'ethernet', speedBps: GIG, autoMdix: true },
    {
      name: 'Wlan0', kind: 'wlan', speedBps: 300_000_000,
      radio: { bands: ['2.4'], generations: ['n'], defaultBand: '2.4', defaultChannel: 1, maxTxPowerDbm: 20, antennaGainDbi: 2, streams: 2, maxWidthMhz: 40, maxRangeM: 300 },
    },
  ],
}, 'P0.5');
const LOOKUP = buildCableLookup([PC, SWITCH, ROUTER, AP]);

function snapPort(spec: PortSpec, extra: Partial<PortSnapshot> = {}): PortSnapshot {
  const base: PortSnapshot = {
    id: spec.name, short: spec.short, kind: spec.kind, mac: '02:00:00:00:00:01', adminUp: true, operUp: false, mtu: 1500,
    counters: emptyCounters(), l3: {}, txQueue: 0,
  };
  if (spec.role !== undefined) base.role = spec.role;
  if (spec.connector !== undefined) base.connector = spec.connector;
  if (spec.wiring !== undefined) base.wiring = spec.wiring;
  if (spec.autoMdix !== undefined) base.autoMdix = spec.autoMdix;
  return { ...base, ...extra };
}

function snapDevice(
  id: string,
  name: string,
  model: DeviceModel,
  position: { x: number; y: number },
  extra: Record<string, Partial<PortSnapshot>> = {},
  device: Partial<DeviceSnapshot> = {},
): DeviceSnapshot {
  return {
    id, type: model.type, model: model.model, kind: model.kind, name, position, power: true, booted: true, uptimeNs: 0,
    ports: model.ports.map((p) => snapPort(p, extra[p.name] ?? {})), tables: { cam: [], arp: [], rib: [] }, processes: [],
    runningConfig: '', hasStartupConfig: false, ...device,
  };
}

function link(id: string, a: [string, string], b: [string, string], extra: Partial<LinkSnapshot> = {}): LinkSnapshot {
  return {
    id, a: { device: a[0], port: a[1] }, b: { device: b[0], port: b[1] }, media: 'auto', lengthM: 3,
    impairments: { lossPct: 0, corruptPct: 0, extraDelayNs: 0, jitterNs: 0, bandwidthBps: 0, cut: false },
    up: true, resolvedMedia: 'copper-straight', ...extra,
  } as LinkSnapshot;
}

// PC1 (0,0)   SW1 (200,10)   PC2 (400,0)
//             R1  (200,200)
const PC1 = snapDevice('pc1', 'PC1', PC, { x: 0, y: 0 }, { GigabitEthernet0: { link: 'l_1', operUp: true } });
const SW1 = snapDevice('sw1', 'SW1', SWITCH, { x: 200, y: 10 }, {
  'FastEthernet0/1': { link: 'l_1', operUp: true },
  'FastEthernet0/2': { link: 'l_2', operUp: true },
});
const PC2 = snapDevice('pc2', 'PC2', PC, { x: 400, y: 0 }, { GigabitEthernet0: { link: 'l_2', operUp: true } });
const R1 = snapDevice('r1', 'R1', ROUTER, { x: 200, y: 200 }, { 'Serial0/0/0': { adminUp: false } });
const AP1 = snapDevice('ap1', 'AP1', AP, { x: 600, y: 220 });
const L1 = link('l_1', ['pc1', 'GigabitEthernet0'], ['sw1', 'FastEthernet0/1'], { negotiatedBps: 100_000_000 });
const L2 = link('l_2', ['sw1', 'FastEthernet0/2'], ['pc2', 'GigabitEthernet0'], { up: false, downReason: 'admin-down:b' });

const ASSOC: AssociationSnapshot = {
  id: 'air1|lap1/Wlan0', tech: 'wifi', medium: 'air1', ap: { device: 'ap1', port: 'Wlan0' }, station: { device: 'lap1', port: 'Wlan0' },
  ssid: 'LAB', band: '2.4', channel: 1, state: 'associated', authorized: true, rssiDbm: -58, snrDb: 30, rateBps: 54_000_000,
  bars: 3, distanceM: 40, since: 0,
};

const SNAP = {
  now: 0, seed: 1, topologyVersion: 4, devices: [PC1, SW1, PC2, R1, AP1], links: [L1, L2], inflight: [], sessions: [],
  pduCount: 0, pendingEvents: 0,
  media: { metresPerUnit: 0.25, segments: [], bss: [], cells: [], associations: [ASSOC] },
} as SimSnapshot;

const POINTS: NavPoint[] = navPoints(SNAP.devices);

describe('spatial navigation', () => {
  it('maps only the arrow keys', () => {
    expect(directionForKey('ArrowUp')).toBe('up');
    expect(directionForKey('ArrowDown')).toBe('down');
    expect(directionForKey('ArrowLeft')).toBe('left');
    expect(directionForKey('ArrowRight')).toBe('right');
    expect(directionForKey('Enter')).toBeNull();
    expect(directionForKey('h')).toBeNull();
  });

  it('moves to the nearest device inside the direction cone', () => {
    expect(spatialNeighbour(POINTS, 'pc1', 'right')).toBe('sw1');
    expect(spatialNeighbour(POINTS, 'sw1', 'right')).toBe('pc2');
    expect(spatialNeighbour(POINTS, 'sw1', 'left')).toBe('pc1');
    expect(spatialNeighbour(POINTS, 'sw1', 'down')).toBe('r1');
    expect(spatialNeighbour(POINTS, 'r1', 'up')).toBe('sw1');
    // R1 (forward 200, sideways 200) scores 600 and beats AP1 (forward 220, sideways 200) at 620.
    expect(spatialNeighbour(POINTS, 'pc2', 'down')).toBe('r1');
  });

  it('falls back to the half-plane and returns null at the edges', () => {
    // Nothing lies in R1's right cone except AP1 (dx 400, dy 20).
    expect(spatialNeighbour(POINTS, 'r1', 'right')).toBe('ap1');
    // PC1 → down: R1 sits on the cone edge (sideways 200 = forward 200), which counts as inside.
    expect(spatialNeighbour(POINTS, 'pc1', 'down')).toBe('r1');
    const off: NavPoint[] = [{ id: 'a', x: 0, y: 0 }, { id: 'b', x: 300, y: 10 }];
    expect(spatialNeighbour(off, 'a', 'down')).toBe('b');
    expect(spatialNeighbour(POINTS, 'pc1', 'left')).toBeNull();
    expect(spatialNeighbour(POINTS, 'pc1', 'up')).toBeNull();
    expect(spatialNeighbour(POINTS, 'ghost', 'up')).toBeNull();
  });

  it('prefers the cone over a nearer off-axis device and breaks ties by offset then id', () => {
    const pts: NavPoint[] = [
      { id: 'o', x: 0, y: 0 },
      { id: 'near-off-axis', x: 30, y: 60 },
      { id: 'far-ahead', x: 150, y: 0 },
    ];
    expect(spatialNeighbour(pts, 'o', 'right')).toBe('far-ahead');
    const ties: NavPoint[] = [
      { id: 'o', x: 0, y: 0 },
      { id: 'b', x: 100, y: 0 },
      { id: 'a', x: 100, y: 0 },
      { id: 'same-spot', x: 0, y: 0 },
    ];
    expect(spatialNeighbour(ties, 'o', 'right')).toBe('a');
    expect(spatialNeighbour(ties, 'o', 'left')).toBeNull();
  });

  it('uses the local position overrides of a dragged device', () => {
    const moved = navPoints(SNAP.devices, new Map([['r1', { x: -300, y: 0 }]]));
    expect(spatialNeighbour(moved, 'pc1', 'left')).toBe('r1');
  });
});

describe('reading order and stepping', () => {
  it('reads rows of 40 units left to right', () => {
    expect(readingOrder(POINTS).map((p) => p.id)).toEqual(['pc1', 'sw1', 'pc2', 'r1', 'ap1']);
    expect(firstDevice(POINTS)).toBe('pc1');
    expect(lastDevice(POINTS)).toBe('ap1');
    expect(firstDevice([])).toBeNull();
    expect(lastDevice([])).toBeNull();
  });

  it('steps, clamps and wraps', () => {
    const ids = ['a', 'b', 'c'];
    expect(stepInOrder(ids, 'a', 1)).toBe('b');
    expect(stepInOrder(ids, 'c', 1)).toBe('c');
    expect(stepInOrder(ids, 'a', -1)).toBe('a');
    expect(stepInOrder(ids, 'c', 1, true)).toBe('a');
    expect(stepInOrder(ids, 'a', -1, true)).toBe('c');
    expect(stepInOrder(ids, null, 1)).toBe('a');
    expect(stepInOrder(ids, 'zz', -1)).toBe('c');
    expect(stepInOrder([], 'a', 1)).toBeNull();
  });
});

describe('cable graph', () => {
  it('lists the cables of a device from its side', () => {
    expect(cabledPeers(SNAP.links, 'sw1')).toEqual([
      { link: 'l_1', local: { device: 'sw1', port: 'FastEthernet0/1' }, peer: { device: 'pc1', port: 'GigabitEthernet0' } },
      { link: 'l_2', local: { device: 'sw1', port: 'FastEthernet0/2' }, peer: { device: 'pc2', port: 'GigabitEthernet0' } },
    ]);
    expect(cabledPeers(SNAP.links, 'r1')).toEqual([]);
  });

  it('walks cabled neighbours in link order, wrapping', () => {
    expect(nextPeerDevice(SNAP.links, 'sw1', null)).toBe('pc1');
    expect(nextPeerDevice(SNAP.links, 'sw1', 'pc1')).toBe('pc2');
    expect(nextPeerDevice(SNAP.links, 'sw1', 'pc2')).toBe('pc1');
    expect(nextPeerDevice(SNAP.links, 'pc1', 'sw1')).toBe('sw1');
    expect(nextPeerDevice(SNAP.links, 'r1', null)).toBeNull();
  });
});

describe('lookups and projection', () => {
  const index = { topologyVersion: 4, devices: { pc1: 0, sw1: 1, pc2: 2, r1: 3, ap1: 4 }, links: { l_1: 0, l_2: 1 } };

  it('finds by index and falls back to a scan when the index is stale', () => {
    expect(deviceById(SNAP, index, 'r1')).toBe(R1);
    expect(linkById(SNAP, index, 'l_2')).toBe(L2);
    const stale = { topologyVersion: 3, devices: { r1: 0 }, links: { l_2: 0 } };
    expect(deviceById(SNAP, stale, 'r1')).toBe(R1);
    expect(linkById(SNAP, stale, 'l_2')).toBe(L2);
    const wrong = { topologyVersion: 4, devices: { r1: 0 }, links: {} };
    expect(deviceById(SNAP, wrong, 'r1')).toBe(R1);
    expect(deviceById(SNAP, undefined, 'nope')).toBeUndefined();
    expect(deviceById(null, index, 'r1')).toBeUndefined();
    expect(linkById(null, index, 'l_1')).toBeUndefined();
  });

  it('projects world positions through the camera', () => {
    expect(screenPointOf({ x: 100, y: 50 }, { x: 10, y: -20, zoom: 2 })).toEqual({ x: 210, y: 80 });
    expect(screenPointOf({ x: 1, y: 1 }, { x: 0, y: 0, zoom: 0.5 })).toEqual({ x: 1, y: 1 });
  });
});

describe('wording', () => {
  it('describes port state with a glyph and words', () => {
    const p = SW1.ports[0]!;
    expect(portStatusText(p, true)).toBe('● up');
    expect(portStatusText(p, false)).toBe('■ device off');
    expect(portStatusText({ ...p, operUp: false }, true)).toBe('○ down');
    expect(portStatusText({ ...p, adminUp: false, operUp: false }, true)).toBe('■ shut down');
    expect(portStatusText({ ...p, errDisabled: 'bpdu' }, true)).toBe('✖ error-disabled');
    expect(portStatusText({ ...p, operUp: false, phy: { carrier: true } as PortSnapshot['phy'] }, true)).toBe('▲ up, line protocol down');
  });

  it('formats rates, bars and states', () => {
    expect(rateText(GIG)).toBe('1 Gb/s');
    expect(rateText(54_000_000)).toBe('54 Mb/s');
    expect(rateText(1_500_000)).toBe('1.5 Mb/s');
    expect(rateText(64_000)).toBe('64 kb/s');
    expect(rateText(300)).toBe('300 b/s');
    expect(barsText(1)).toBe('1 of 4 bar');
    expect(barsText(3)).toBe('3 of 4 bars');
    expect(associationStateText('handshake')).toBe('exchanging keys');
    expect(associationStateText('searching')).toBe('searching for a cell');
  });

  it('names devices and ports and explains link state', () => {
    const names = nameBook(SNAP);
    expect(names.device('sw1')).toBe('SW1');
    expect(names.device('ghost')).toBe('ghost');
    expect(names.port({ device: 'pc1', port: 'GigabitEthernet0' })).toBe('PC1 GigabitEthernet0');
    expect(linkStateText(L1, names)).toBe('up at 100 Mb/s');
    expect(linkStateText({ ...L1, negotiatedBps: undefined }, names)).toBe('up');
    const expected = linkDownText('admin-down:b', { deviceA: 'SW1', deviceB: 'PC2', endA: 'SW1 FastEthernet0/2', endB: 'PC2 GigabitEthernet0' }).short;
    expect(linkStateText(L2, names)).toBe(`down: ${expected}`);
    expect(expected).toContain('PC2');
  });
});

describe('outline model', () => {
  const model = buildOutline(SNAP);

  it('lists devices in reading order with port rows', () => {
    expect(model.devices.map((d) => d.id)).toEqual(['pc1', 'sw1', 'pc2', 'r1', 'ap1']);
    const sw = model.devices[1]!;
    expect(sw.label).toBe('SW1, NF-SW');
    expect(sw.description).toBe('SW1, NF-SW, power on, 3 ports, 2 connected.');
    const fa1 = sw.ports[0]!;
    expect(fa1.key).toBe('sw1/FastEthernet0/1');
    expect(fa1.status).toBe('● up');
    expect(fa1.link).toBe('l_1');
    expect(fa1.peer).toEqual({ device: 'pc1', port: 'GigabitEthernet0' });
    expect(fa1.description).toMatch(/^FastEthernet0\/1, .+ port, up, connected to PC1 GigabitEthernet0 by .+\.$/);
    const fa3 = sw.ports[2]!;
    expect(fa3.link).toBeUndefined();
    expect(fa3.description).toMatch(/down, not connected\.$/);
    const serial = model.devices[3]!.ports[1]!;
    expect(serial.status).toBe('■ shut down');
    expect(model.devices[0]!.description).toBe('PC1, NF-PC, power on, 1 port, 1 connected.');
  });

  it('describes a powered-off or starting device', () => {
    const off = buildOutline({ ...SNAP, devices: [{ ...R1, power: false }, { ...PC1, booted: false }] });
    expect(off.devices.find((d) => d.id === 'r1')?.description).toContain('power off');
    expect(off.devices.find((d) => d.id === 'r1')?.ports[0]?.status).toBe('■ device off');
    expect(off.devices.find((d) => d.id === 'pc1')?.description).toContain('power starting');
  });

  it('describes cables with glyph, ends, media and state', () => {
    expect(model.links[0]!.label).toBe('● PC1 GigabitEthernet0 to SW1 FastEthernet0/1');
    expect(model.links[0]!.description).toMatch(/^Cable from PC1 GigabitEthernet0 to SW1 FastEthernet0\/1, .+, up at 100 Mb\/s\.$/);
    expect(model.links[1]!.label.startsWith('○ ')).toBe(true);
    expect(model.links[1]!.up).toBe(false);
    expect(model.links[1]!.description).toContain('down: ');
  });

  it('describes wireless associations without colour', () => {
    expect(model.associations).toHaveLength(1);
    const a = model.associations[0]!;
    expect(a.label).toBe('lap1 Wlan0 → AP1 Wlan0');
    expect(a.description).toBe('Wi-Fi "LAB": lap1 Wlan0 to AP1 Wlan0, associated, 3 of 4 bars, -58 dBm, 54 Mb/s.');
    const cell = buildOutline({
      ...SNAP,
      media: { ...SNAP.media!, associations: [{ ...ASSOC, id: 'c1|ph/Ce0', tech: 'cellular', ap: undefined, ssid: undefined, state: 'searching', rateBps: 0, bars: 0 }] },
    });
    expect(cell.associations[0]!.description).toBe('Cellular: lap1 Wlan0 to the cell, searching for a cell, 0 of 4 bars, -58 dBm.');
  });

  it('is empty without a snapshot and skips the associations group when there are none', () => {
    const empty = buildOutline(null);
    expect(empty.devices).toEqual([]);
    const items = visibleItems(empty, { groups: new Set(['devices', 'links']), devices: new Set() });
    expect(items.map((i) => i.key)).toEqual(['g:devices', 'g:links']);
  });

  it('flattens the visible tree in document order', () => {
    const collapsed = visibleItems(model, { groups: new Set(), devices: new Set() });
    expect(collapsed.map((i) => i.key)).toEqual(['g:devices', 'g:links', 'g:associations']);
    const open = visibleItems(model, { groups: new Set(['devices', 'links', 'associations']), devices: new Set(['sw1']) });
    expect(open.map((i) => i.key)).toEqual([
      'g:devices',
      'd:pc1',
      'd:sw1',
      'p:sw1/FastEthernet0/1',
      'p:sw1/FastEthernet0/2',
      'p:sw1/FastEthernet0/3',
      'd:pc2',
      'd:r1',
      'd:ap1',
      'g:links',
      'l:l_1',
      'l:l_2',
      'g:associations',
      'a:air1|lap1/Wlan0',
    ]);
    const port = open[3]!;
    expect(deviceOfItem(port)).toBe('sw1');
    expect(deviceOfItem(open[1]!)).toBe('pc1');
    expect(deviceOfItem(open[10]!)).toBeNull();
    expect(deviceOfItem(open[0]!)).toBeNull();
  });
});

describe('keyboard cabling candidates', () => {
  it('offers free cable ports of a device, fitting ones first', () => {
    const r1 = cablingSources(SNAP, LOOKUP, 'copper-straight', R1);
    expect(r1.map((c) => [c.label, c.compat.status])).toEqual([
      ['R1 GigabitEthernet0/0', 'eligible'],
      ['R1 Serial0/0/0', 'incompatible'],
    ]);
    expect(r1[0]!.verdict).toBe('✓ works');
    expect(r1[1]!.verdict.startsWith('✕ ')).toBe(true);
    // Occupied ports and radios are never offered.
    expect(cablingSources(SNAP, LOOKUP, 'auto', SW1).map((c) => c.ref.port)).toEqual(['FastEthernet0/3']);
    expect(cablingSources(SNAP, LOOKUP, 'auto', AP1).map((c) => c.ref.port)).toEqual(['GigabitEthernet0']);
  });

  it('splits target ports by the engine validator verdict', () => {
    const t = cablingTargets(SNAP, LOOKUP, { device: 'r1', port: 'GigabitEthernet0/0' }, 'copper-straight');
    const ok = t.compatible.map((c) => c.key);
    const bad = t.incompatible.map((c) => c.key);
    expect(ok).toContain('sw1/FastEthernet0/3');
    expect(ok).toContain('ap1/GigabitEthernet0');
    // Same-device, occupied and radio ports are left out entirely.
    for (const k of [...ok, ...bad]) {
      expect(k.startsWith('r1/')).toBe(false);
      expect(k).not.toBe('sw1/FastEthernet0/1');
      expect(k).not.toBe('ap1/Wlan0');
    }
    for (const c of t.compatible) expect(c.verdict.startsWith('✓ works')).toBe(true);
    for (const c of t.incompatible) expect(c.verdict.startsWith('✕ ')).toBe(true);
    // Automatic media names the cable it would pick.
    const auto = cablingTargets(SNAP, LOOKUP, { device: 'r1', port: 'GigabitEthernet0/0' }, 'auto');
    const toSwitch = auto.compatible.find((c) => c.key === 'sw1/FastEthernet0/3');
    expect(toSwitch?.verdict).toMatch(/^✓ works with /);
  });

  it('filters by every typed word', () => {
    const t = cablingTargets(SNAP, LOOKUP, { device: 'r1', port: 'GigabitEthernet0/0' }, 'auto');
    const all = [...t.compatible, ...t.incompatible];
    expect(filterCandidates(all, '')).toHaveLength(all.length);
    expect(filterCandidates(all, '  sw1   fast ').map((c) => c.key)).toEqual(['sw1/FastEthernet0/3']);
    expect(filterCandidates(all, 'AP1 gig').map((c) => c.key)).toEqual(['ap1/GigabitEthernet0']);
    expect(filterCandidates(all, 'nothing-here')).toEqual([]);
  });
});

describe('announcer wording', () => {
  const names = nameBook(SNAP);
  const ends = (id: string) => {
    const l = SNAP.links.find((x) => x.id === id);
    return l === undefined ? undefined : { a: l.a, b: l.b };
  };
  const pdu = (id: number) => ({ id, proto: 'ethernet' as const, size: 64, summary: 'frame' });

  it('announces association and attach changes', () => {
    const base = { t: 1, kind: 'assocState' as const, tech: 'wifi' as const, medium: 'air1', station: { device: 'pc1', port: 'Wlan0' }, ap: { device: 'ap1', port: 'Wlan0' } };
    expect(describeEvent({ ...base, state: 'associated', prev: 'handshake', rssiDbm: -60 }, names)).toBe('PC1 Wlan0 joined Wi-Fi on AP1 Wlan0 at -60 dBm.');
    expect(describeEvent({ ...base, state: 'failed', prev: 'handshake', reason: 'wrong-key' }, names)).toBe('PC1 Wlan0 could not join Wi-Fi: wrong key.');
    expect(describeEvent({ ...base, state: 'scanning', prev: 'associated', reason: 'out-of-range' }, names)).toBe('PC1 Wlan0 lost its Wi-Fi association: out of range.');
    expect(describeEvent({ ...base, state: 'authenticating', prev: 'scanning' }, names)).toBeNull();
    const cell = { ...base, tech: 'cellular' as const, ap: { device: 'ap1', port: 'Ce0' } };
    expect(describeEvent({ ...cell, state: 'attached', prev: 'attaching' }, names)).toBe('PC1 Wlan0 attached to the cell on AP1 Ce0.');
    expect(describeEvent({ ...cell, state: 'detached', prev: 'attached', reason: 'out-of-range' }, names)).toBe('PC1 Wlan0 detached from the cell: out of range.');
    expect(describeEvent({ ...cell, state: 'searching', prev: 'attached' }, names)).toBe('PC1 Wlan0 lost the cell and is searching for a cell.');
    expect(describeEvent({ ...cell, state: 'attaching', prev: 'searching' }, names)).toBeNull();
  });

  it('announces link, topology and collision events', () => {
    expect(describeEvent({ t: 1, kind: 'linkState', link: 'l_1', up: true }, names, ends)).toBe('Cable PC1 GigabitEthernet0 to SW1 FastEthernet0/1 is up.');
    expect(describeEvent({ t: 1, kind: 'linkState', link: 'l_2', up: false, reason: 'admin-down:b' }, names, ends)).toBe(
      `Cable SW1 FastEthernet0/2 to PC2 GigabitEthernet0 is down: ${linkDownText('admin-down:b', { deviceB: 'PC2', endB: 'PC2 GigabitEthernet0' }).short}.`,
    );
    expect(describeEvent({ t: 1, kind: 'linkState', link: 'gone', up: false }, names, ends)).toBe('A cable went down.');
    expect(describeEvent({ t: 1, kind: 'topologyChanged', what: 'device', id: 'r1', op: 'add' }, names)).toBe('R1 added to the workspace.');
    expect(describeEvent({ t: 1, kind: 'topologyChanged', what: 'device', id: 'r9', op: 'remove' }, names)).toBe('A device was removed from the workspace.');
    expect(describeEvent({ t: 1, kind: 'topologyChanged', what: 'link', id: 'l_1', op: 'add' }, names, ends)).toBe('Cable PC1 GigabitEthernet0 to SW1 FastEthernet0/1 added.');
    expect(describeEvent({ t: 1, kind: 'topologyChanged', what: 'link', id: 'l_9', op: 'remove' }, names, ends)).toBe('Cable removed.');
    expect(describeEvent({ t: 1, kind: 'topologyChanged', what: 'module', id: 'r1/0', op: 'add' }, names)).toBe('Module added.');
    expect(describeEvent({ t: 1, kind: 'topologyChanged', what: 'device', id: 'r1', op: 'move' }, names)).toBeNull();
    const collision: TraceEvent = {
      t: 1, kind: 'collision', segment: 'seg1', stations: [{ device: 'pc1', port: 'GigabitEthernet0' }, { device: 'pc2', port: 'GigabitEthernet0' }, { device: 'pc1', port: 'GigabitEthernet0' }],
      pdus: [1, 2], detectAt: 1, jamUntil: 2, late: false,
    };
    expect(describeEvent(collision, names)).toBe('Collision on a shared segment between PC1 and PC2.');
    expect(describeEvent({ ...collision, late: true } as TraceEvent, names)).toBe('Late collision on a shared segment between PC1 and PC2.');
    expect(describeEvent({ t: 1, kind: 'frameRx', pdu: pdu(1), device: 'pc1', port: 'x' }, names)).toBeNull();
    expect(joinWords([])).toBe('');
    expect(joinWords(['A'])).toBe('A');
    expect(joinWords(['A', 'B', 'C'])).toBe('A, B and C');
  });

  it('folds drops into one summary and skips background frames and repeats', () => {
    const events: TraceEvent[] = [
      { t: 1, kind: 'linkState', link: 'l_1', up: true },
      { t: 2, kind: 'linkState', link: 'l_1', up: true },
      { t: 3, kind: 'drop', pdu: pdu(1), reason: 'not-for-me' },
      { t: 3, kind: 'drop', pdu: pdu(2), reason: 'not-for-me' },
      { t: 3, kind: 'drop', pdu: pdu(3), reason: 'no-route' },
      {
        t: 4, kind: 'frameTx', pdu: pdu(9), link: 'l_1', from: { device: 'pc1', port: 'a' }, to: { device: 'sw1', port: 'b' },
        txStart: 4, txEnd: 5, arrive: 6, background: true,
      },
      { t: 6, kind: 'drop', pdu: pdu(9), reason: 'link-down' },
    ];
    expect(summarizeEvents(events, names, ends)).toEqual([
      'Cable PC1 GigabitEthernet0 to SW1 FastEthernet0/1 is up.',
      `3 packets dropped: ${dropLabel('not-for-me')} (2), ${dropLabel('no-route')} (1).`,
    ]);
    const many: TraceEvent[] = (['not-for-me', 'no-route', 'ttl-expired', 'link-down', 'link-loss'] as const).map((reason, i) => ({ t: i, kind: 'drop', pdu: pdu(i), reason }));
    const text = summarizeEvents(many, names)[0]!;
    expect(text.startsWith('5 packets dropped: ')).toBe(true);
    expect(text.endsWith(' and 2 other reasons.')).toBe(true);
    expect(summarizeEvents([{ t: 1, kind: 'drop', pdu: pdu(1), reason: 'no-route' }], names)).toEqual([`1 packet dropped: ${dropLabel('no-route')} (1).`]);
  });

  it('reads only events appended after the last one seen', () => {
    const a: TraceEvent = { t: 1, kind: 'linkState', link: 'l_1', up: true };
    const b: TraceEvent = { t: 2, kind: 'linkState', link: 'l_1', up: false };
    const c: TraceEvent = { t: 3, kind: 'linkState', link: 'l_1', up: true };
    expect(newEventsSince([a, b, c], null)).toEqual([]);
    expect(newEventsSince([a, b, c], a)).toEqual([b, c]);
    expect(newEventsSince([a, b, c], c)).toEqual([]);
    // `a` left the ring: fall back to sim time.
    expect(newEventsSince([b, c], a)).toEqual([b, c]);
  });
});

describe('throttled announcer', () => {
  it('merges long queues with a counted tail', () => {
    expect(mergeAnnouncements(['One.', 'Two.'])).toBe('One. Two.');
    expect(mergeAnnouncements(['aaaa.', 'bbbb.', 'cccc.'], 11)).toBe('aaaa. bbbb. And 1 more update.');
    expect(mergeAnnouncements(['x'.repeat(30), 'y.', 'z.'], 10)).toBe(`${'x'.repeat(30)} And 2 more updates.`);
  });

  it('emits at once, then at most once per gap', () => {
    let now = 0;
    const emitted: string[] = [];
    const timers: { fn: () => void; at: number; id: number }[] = [];
    let nextId = 0;
    const a = createAnnouncer({
      emit: (t) => emitted.push(t),
      now: () => now,
      minGapMs: 1000,
      setTimer: (fn, ms) => {
        nextId += 1;
        timers.push({ fn, at: now + ms, id: nextId });
        return nextId;
      },
      clearTimer: (h) => {
        const i = timers.findIndex((x) => x.id === h);
        if (i >= 0) timers.splice(i, 1);
      },
    });
    const fire = (): void => {
      const due = timers.filter((x) => x.at <= now);
      for (const d of due) {
        timers.splice(timers.indexOf(d), 1);
        d.fn();
      }
    };

    a.push('First.');
    expect(emitted).toEqual(['First.']);
    now = 200;
    a.push('Second.');
    a.push('  ', 'Third.');
    expect(emitted).toHaveLength(1);
    expect(timers).toHaveLength(1);
    expect(timers[0]!.at).toBe(1000);
    now = 1000;
    fire();
    expect(emitted).toEqual(['First.', 'Second. Third.']);
    now = 1500;
    a.push('Fourth.');
    a.flush();
    expect(emitted[2]).toBe('Fourth.');
    a.push('');
    expect(emitted).toHaveLength(3);
    now = 1600;
    a.push('Fifth.');
    expect(timers).toHaveLength(1);
    a.dispose();
    expect(timers).toHaveLength(0);
    now = 5000;
    a.push('Ignored.');
    a.flush();
    expect(emitted).toHaveLength(3);
  });
});
