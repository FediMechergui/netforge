// [S1] The OSPF overlay layer's pure parts (ARCHITECTURE-P3 §6, §3.1, §3.2; W3 web-canvas): the adjacency underlay
// widths, badge and chip placement, the forming-chip pulse (static under reduced motion), the port badge text, the
// area-zone hulls and their labels, and the text forms (per port, device and link) the keyboard outline reads.
import { describe, expect, it } from 'vitest';
import type { DeviceSnapshot, OspfInterfaceRow, OspfNeighborRow, OspfNsmState, PortSnapshot } from '@netforge/engine';
import { straightGeometry } from '../src/canvas/cables.js';
import {
  ADJ_THICK_WIDTH,
  ADJ_THIN_WIDTH,
  OSPF_BADGE_INSET,
  OSPF_CHIP_PULSE_MS,
  OSPF_NBR_WORD,
  ZONE_PAD,
  adjacencyWidth,
  areaHue,
  convexHull,
  describeOspfLink,
  describeOspfPort,
  linkChipPoint,
  ospfBadgePoint,
  ospfChipPulseAlpha,
  ospfDeviceFacts,
  ospfLinkFacts,
  ospfModelNeedsClock,
  ospfPortBadge,
  ospfPortFacts,
  zoneShapes,
} from '../src/canvas/ospf.js';
import { buildOspfOverlay, type OspfLinkMark } from '../src/canvas/overlays/ospf-model.js';
import type { DeviceGeom } from '../src/canvas/ports.js';
import { TEST_THEME, device, link, port, snapshot } from './canvas-fixtures.js';

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

function nbrRow(portId: string, routerId: string, state: OspfNsmState): OspfNeighborRow {
  return {
    key: `${portId}|${routerId}`,
    port: portId,
    routerId,
    address: '10.0.0.9',
    priority: 1,
    state,
    role: 'none',
    dr: '0.0.0.0',
    bdr: '0.0.0.0',
    stateSince: U,
  } as OspfNeighborRow;
}

function routed(id: string, linkId: string): PortSnapshot {
  return port(id, { short: id, role: 'routed', operUp: true, link: linkId });
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

/**
 * Area 0: r1 Gi0/0 — r2 Gi0/0 (Full both ways), r1 Se0/0/0 — r3 Se0/0/0 (r1 at Init; r3 refuses r1's hellos), r1 Gi0/1 a
 * passive LAN with pc1 (r1 is its DR). Area 1: r2 Gi0/1 — r4 Gi0/0 (Exchange / ExStart), r4 Gi0/1 on sw1's LAN, Waiting,
 * at 2-Way with 5.5.5.5. `now` is the middle of r4's wait.
 */
function world(now = U + 20 * SEC) {
  const r1 = router(
    'r1',
    [routed('Gi0/0', 'l12'), routed('Se0/0/0', 'l13'), routed('Gi0/1', 'lan1')],
    [
      ifRow('Gi0/0', '1.1.1.1'),
      ifRow('Se0/0/0', '1.1.1.1', { cost: 64, adjacent: 0 }),
      ifRow('Gi0/1', '1.1.1.1', { networkType: 'broadcast', state: 'dr', passive: true, neighbors: 0, adjacent: 0 }),
    ],
    [nbrRow('Gi0/0', '2.2.2.2', 'full'), nbrRow('Se0/0/0', '3.3.3.3', 'init')],
  );
  const r2 = router(
    'r2',
    [routed('Gi0/0', 'l12'), routed('Gi0/1', 'l24')],
    [ifRow('Gi0/0', '2.2.2.2'), ifRow('Gi0/1', '2.2.2.2', { area: '0.0.0.1', cost: 10, adjacent: 0 })],
    [nbrRow('Gi0/0', '1.1.1.1', 'full'), nbrRow('Gi0/1', '4.4.4.4', 'exchange')],
  );
  const r3 = router(
    'r3',
    [routed('Se0/0/0', 'l13')],
    [
      ifRow('Se0/0/0', '3.3.3.3', {
        cost: 64,
        neighbors: 0,
        adjacent: 0,
        rejected: { from: '10.0.13.1', routerId: '1.1.1.1', reason: 'hello interval 5 does not match 10', at: U },
      }),
    ],
    [],
  );
  const r4 = router(
    'r4',
    [routed('Gi0/0', 'l24'), routed('Gi0/1', 'l5')],
    [
      ifRow('Gi0/0', '4.4.4.4', { area: '0.0.0.1', cost: 10, adjacent: 0 }),
      ifRow('Gi0/1', '4.4.4.4', { area: '0.0.0.1', networkType: 'broadcast', state: 'waiting', waitUntil: U + 40 * SEC, adjacent: 0 }),
    ],
    [nbrRow('Gi0/0', '2.2.2.2', 'exstart'), nbrRow('Gi0/1', '5.5.5.5', '2way')],
  );
  const pc1 = device('pc1', 0, 0, [routed('Gi0', 'lan1')]);
  const sw1 = device('sw1', 0, 0, [port('Fa0/1', { link: 'l5', operUp: true })], { type: 'switch.nfc2960', model: 'NF-C2960', kind: 'switch' });
  return snapshot(
    [r1, r2, r3, r4, pc1, sw1],
    [
      link('l12', ['r1', 'Gi0/0'], ['r2', 'Gi0/0']),
      link('l13', ['r1', 'Se0/0/0'], ['r3', 'Se0/0/0'], { media: 'serial-dce', resolvedMedia: 'serial-dce' }),
      link('l24', ['r2', 'Gi0/1'], ['r4', 'Gi0/0']),
      link('lan1', ['r1', 'Gi0/1'], ['pc1', 'Gi0']),
      link('l5', ['r4', 'Gi0/1'], ['sw1', 'Fa0/1']),
    ],
    { now },
  );
}

function geom(x: number, y: number, halfW = 20, halfH = 15): DeviceGeom {
  return { device: {} as DeviceSnapshot, x, y, halfW, halfH, visual: {} as DeviceGeom['visual'] };
}

describe('geometry', () => {
  it('weights the underlay: thick when Full, thin at 2-Way or while forming, nothing otherwise', () => {
    expect(adjacencyWidth('thick')).toBe(ADJ_THICK_WIDTH);
    expect(adjacencyWidth('thin')).toBe(ADJ_THIN_WIDTH);
    expect(adjacencyWidth('none')).toBe(0);
    expect(adjacencyWidth('thick', 0.5)).toBe(ADJ_THICK_WIDTH / 2);
    expect(ADJ_THICK_WIDTH).toBeGreaterThan(2 * ADJ_THIN_WIDTH);
  });

  it('puts the port badge out along the cable and the state chip at the cable middle', () => {
    expect(ospfBadgePoint({ x: 100, y: 50, nx: 1, ny: 0 })).toEqual({ x: 100 + OSPF_BADGE_INSET, y: 50 });
    expect(ospfBadgePoint({ x: 100, y: 50, nx: 0, ny: -1 }, 2)).toEqual({ x: 100, y: 50 - 2 * OSPF_BADGE_INSET });
    expect(linkChipPoint(straightGeometry({ x: 0, y: 0 }, { x: 120, y: 40 }))).toEqual({ x: 60, y: 20 });
  });

  it('breathes the forming chips between 0.35 and 1 over the period, and holds them at 1 under reduced motion', () => {
    expect(ospfChipPulseAlpha(0, false)).toBe(1);
    expect(ospfChipPulseAlpha(OSPF_CHIP_PULSE_MS / 2, false)).toBeCloseTo(0.35, 10);
    expect(ospfChipPulseAlpha(OSPF_CHIP_PULSE_MS, false)).toBe(1);
    for (let t = -OSPF_CHIP_PULSE_MS; t < 3 * OSPF_CHIP_PULSE_MS; t += 89) {
      const a = ospfChipPulseAlpha(t, false);
      expect(a).toBeGreaterThanOrEqual(0.35 - 1e-12);
      expect(a).toBeLessThanOrEqual(1 + 1e-12);
      expect(ospfChipPulseAlpha(t, true)).toBe(1);
    }
  });

  it('builds the convex hull of a point set, dropping inner and repeated points', () => {
    const square = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
      { x: 0, y: 10 },
      { x: 5, y: 5 },
      { x: 10, y: 10 },
    ];
    expect(convexHull(square)).toEqual([
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
      { x: 0, y: 10 },
    ]);
    expect(convexHull([{ x: 1, y: 1 }])).toEqual([{ x: 1, y: 1 }]);
    expect(convexHull([])).toEqual([]);
    expect(convexHull([{ x: 0, y: 0 }, { x: 5, y: 0 }, { x: 10, y: 0 }])).toEqual([
      { x: 0, y: 0 },
      { x: 10, y: 0 },
    ]);
  });

  it('wraps each area zone round its drawn devices and stacks a label that would land on an earlier one', () => {
    const layout = { devices: new Map([['r1', geom(0, 0)], ['r2', geom(200, 100)]]) };
    const zones = [
      { area: '0.0.0.0', label: 'Area 0', devices: ['r1', 'r2'] },
      { area: '0.0.0.1', label: 'Area 1', devices: ['r1', 'ghost'] },
      { area: '0.0.0.2', label: 'Area 2', devices: ['ghost'] },
    ];
    const shapes = zoneShapes(zones, layout);
    expect(shapes.map((s) => s.area)).toEqual(['0.0.0.0', '0.0.0.1']);
    // r1's box: body ±20 × (−15 − 3 antenna lift) … (15 + 36 − 4 name block), grown by the pad
    const top = -18 - ZONE_PAD;
    const left = -20 - ZONE_PAD;
    expect(shapes[0]!.bounds).toEqual({ minX: left, minY: top, maxX: 220 + ZONE_PAD, maxY: 147 + ZONE_PAD });
    expect(shapes[0]!.hull).toHaveLength(6);
    expect(shapes[0]!.labelAt).toEqual({ x: left + 4, y: top - 3 });
    expect(shapes[1]!.hull).toEqual([
      { x: left, y: top },
      { x: 20 + ZONE_PAD, y: top },
      { x: 20 + ZONE_PAD, y: 47 + ZONE_PAD },
      { x: left, y: 47 + ZONE_PAD },
    ]);
    expect(shapes[1]!.labelAt).toEqual({ x: left + 4, y: top - 3 - 14 });
  });

  it('tints each area from its place in the area list (the label is the non-colour channel)', () => {
    const areas = ['0.0.0.0', '0.0.0.1'];
    expect(areaHue('0.0.0.0', areas, TEST_THEME)).toBe(TEST_THEME.accent);
    expect(areaHue('0.0.0.1', areas, TEST_THEME)).toBe(TEST_THEME.purple);
    expect(areaHue('9.9.9.9', areas, TEST_THEME)).toBe(TEST_THEME.accent);
  });
});

describe('the badge and chip texts', () => {
  it('joins the role letters, the cost chip, P and ! in one badge', () => {
    expect(ospfPortBadge({ role: 'DR', costChip: 'c1', passiveGlyph: '', refused: undefined })).toBe('DR c1');
    expect(ospfPortBadge({ role: '', costChip: 'c64', passiveGlyph: '', refused: undefined })).toBe('c64');
    expect(ospfPortBadge({ role: '', costChip: 'c1', passiveGlyph: 'P', refused: undefined })).toBe('c1 P');
    expect(ospfPortBadge({ role: 'BDR', costChip: 'c10', passiveGlyph: '', refused: { glyph: '!', reason: 'x', from: '10.0.0.1', routerId: '1.1.1.1', at: 0 } })).toBe(
      'BDR c10 !',
    );
  });

  it('says every cable state in words', () => {
    const mark = (state: OspfLinkMark['state'], chip = ''): OspfLinkMark => ({ link: 'l', state, weight: 'thin', chip, pulse: false, ends: ['a'] });
    expect(describeOspfLink(mark('none'))).toEqual({ short: 'no adjacency', text: 'no OSPF adjacency: the cable is down' });
    expect(describeOspfLink(mark('down'))).toEqual({ short: 'no neighbour', text: 'no OSPF neighbour across this cable' });
    expect(describeOspfLink(mark('full'))).toEqual({ short: 'FULL', text: 'OSPF adjacency Full' });
    expect(describeOspfLink(mark('2way', '2W'))).toEqual({ short: '2W', text: 'OSPF neighbours at 2-Way, no adjacency (neither is the DR or the BDR)' });
    expect(describeOspfLink(mark('init', 'IN'))).toEqual({ short: 'IN', text: 'OSPF adjacency forming: Init' });
    expect(describeOspfLink(mark('loading', 'LD'))).toEqual({ short: 'LD', text: 'OSPF adjacency forming: Loading' });
    expect(Object.keys(OSPF_NBR_WORD)).toEqual(['down', 'attempt', 'init', '2way', 'exstart', 'exchange', 'loading', 'full']);
  });
});

describe('the text forms (keyboard outline)', () => {
  it('says each OSPF port: area, state, cost, passive, neighbours, the wait left and a refused hello', () => {
    const model = buildOspfOverlay(world(), { now: U + 20 * SEC });
    expect([...ospfPortFacts(model)]).toEqual([
      ['r1/Gi0/0', { short: 'c1', text: 'OSPF Area 0: point-to-point, cost 1, 1 neighbour, 1 adjacent' }],
      ['r1/Se0/0/0', { short: 'c64', text: 'OSPF Area 0: point-to-point, cost 64, 1 neighbour, 0 adjacent' }],
      ['r1/Gi0/1', { short: 'DR c1 P', text: 'OSPF Area 0: designated router (DR), cost 1, passive, 0 neighbours, 0 adjacent' }],
      ['r2/Gi0/0', { short: 'c1', text: 'OSPF Area 0: point-to-point, cost 1, 1 neighbour, 1 adjacent' }],
      ['r2/Gi0/1', { short: 'c10', text: 'OSPF Area 1: point-to-point, cost 10, 1 neighbour, 0 adjacent' }],
      [
        'r3/Se0/0/0',
        {
          short: 'c64 !',
          text: 'OSPF Area 0: point-to-point, cost 64, 0 neighbours, 0 adjacent; hello from 1.1.1.1 (10.0.13.1) refused: hello interval 5 does not match 10',
        },
      ],
      ['r4/Gi0/0', { short: 'c10', text: 'OSPF Area 1: point-to-point, cost 10, 1 neighbour, 0 adjacent' }],
      ['r4/Gi0/1', { short: 'c1', text: 'OSPF Area 1: waiting for the DR election, cost 1, 1 neighbour, 0 adjacent, 50% of the wait left' }],
    ]);
    const bdr = model.ports.find((p) => p.device === 'r1' && p.port === 'Gi0/0')!;
    expect(describeOspfPort({ ...bdr, state: 'backup', role: 'BDR' })).toBe('OSPF Area 0: backup designated router (BDR), cost 1, 1 neighbour, 1 adjacent');
  });

  it('says each device: its areas, an area border router, and refused hellos', () => {
    const model = buildOspfOverlay(world(), { now: U + 20 * SEC });
    expect([...ospfDeviceFacts(model)]).toEqual([
      ['r1', { short: 'Area 0', text: 'OSPF in Area 0' }],
      ['r2', { short: 'Area 0 · Area 1', text: 'OSPF in Area 0 and Area 1 (area border router)' }],
      ['r3', { short: 'Area 0 !', text: "OSPF in Area 0, 1 interface refuses a neighbour's hellos" }],
      ['r4', { short: 'Area 1', text: 'OSPF in Area 1' }],
    ]);
    const area1 = buildOspfOverlay(world(), { area: '0.0.0.1', now: U + 20 * SEC });
    expect([...ospfDeviceFacts(area1)]).toEqual([
      ['r2', { short: 'Area 1', text: 'OSPF in Area 1' }],
      ['r4', { short: 'Area 1', text: 'OSPF in Area 1' }],
    ]);
  });

  it('says each cable: Full, no neighbour, forming (the less advanced end), 2-Way on a LAN', () => {
    const model = buildOspfOverlay(world(), { now: U + 20 * SEC });
    expect([...ospfLinkFacts(model)]).toEqual([
      ['l12', { short: 'FULL', text: 'OSPF adjacency Full' }],
      ['l13', { short: 'no neighbour', text: 'no OSPF neighbour across this cable' }],
      ['l24', { short: 'XS', text: 'OSPF adjacency forming: ExStart' }],
      ['lan1', { short: 'no neighbour', text: 'no OSPF neighbour across this cable' }],
      ['l5', { short: '2W', text: 'OSPF neighbours at 2-Way, no adjacency (neither is the DR or the BDR)' }],
    ]);
    // a selected area keeps only its own cables
    expect([...ospfLinkFacts(buildOspfOverlay(world(), { area: '0.0.0.1', now: U + 20 * SEC })).keys()]).toEqual(['l24', 'l5']);
  });

  it('asks for the clock only while an interface is Waiting, and says nothing with the overlay off', () => {
    expect(ospfModelNeedsClock(buildOspfOverlay(world(), { now: U + 20 * SEC }))).toBe(true);
    expect(ospfModelNeedsClock(buildOspfOverlay(world(), { area: '0.0.0.0', now: U + 20 * SEC }))).toBe(false);
    expect(ospfModelNeedsClock(null)).toBe(false);
    expect(ospfPortFacts(null).size).toBe(0);
    expect(ospfDeviceFacts(null).size).toBe(0);
    expect(ospfLinkFacts(null).size).toBe(0);
  });
});
