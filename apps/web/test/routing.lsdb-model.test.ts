// [S2] The link-state browser's model (ARCHITECTURE-P3 §6, §2.6, §10.2 "routing.lsdb-model"): the router and area
// pickers, the LSA list (database order, live age, hex sequence, self and MaxAge marks as words), the LSA detail
// ("the same in every router of this area: yes/no" and the filter of the packets that carried it), and the LSDB graph
// (routers at canvas positions, transit networks at the centroid of their routers, one-way edges named).
import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { parseDisplayFilter } from '@netforge/engine/pure';
import type { DeviceSnapshot, OspfLsaRow } from '@netforge/engine';
import {
  GRAPH_UNPLACED_STEP,
  areasOfLsdb,
  buildLsdbGraph,
  buildLsdbView,
  checksumHex,
  chooseArea,
  chooseRouter,
  compareNames,
  deriveDeviceLsdb,
  duplicateRouterIds,
  fitGraph,
  lsaAgreement,
  lsaDetail,
  lsaDisplayFilter,
  lsaEntry,
  lsaRowKey,
  lsdbOf,
  lsdbRouters,
  routerDevices,
  runsOspf,
  seqHex,
} from '../src/routing/lsdb-model.js';
import { LsaDetail } from '../src/routing/LsaDetail.js';
import { LsaList } from '../src/routing/LsaList.js';
import { LsdbGraph } from '../src/routing/LsdbGraph.js';
import { device, port } from './canvas-fixtures.js';
import { AREA0, SEC, T0, externalLsa, heldBy, ospfRouter, routerLsa, world, worldLsas } from './routing-fixtures.js';

const NOW = T0 + 5 * SEC;

function dev(snap: ReturnType<typeof world>, id: string): DeviceSnapshot {
  const d = snap.devices.find((x) => x.id === id);
  if (d === undefined) throw new Error(`no device ${id}`);
  return d;
}

describe('per device: the rows of one router', () => {
  it('sorts the LSDB in database order and the interfaces in canonical port order', () => {
    const d = dev(world(), 'r1');
    const lsdb = deriveDeviceLsdb(d);
    expect(lsdb.lsas.map((r) => `${r.scope}|${r.type}|${r.lsid}|${r.advRouter}`)).toEqual([
      '0.0.0.0|1|1.1.1.1|1.1.1.1',
      '0.0.0.0|1|2.2.2.2|2.2.2.2',
      '0.0.0.0|1|3.3.3.3|3.3.3.3',
      '0.0.0.0|1|4.4.4.4|4.4.4.4',
      '0.0.0.0|2|10.0.123.2|2.2.2.2',
      'as|5|0.0.0.0|4.4.4.4',
    ]);
    expect(lsdb.interfaces.map((r) => r.port)).toEqual(['Gi0/0', 'Se0/0/0', 'Gi0/1']);
    expect(lsdb.routerId).toBe('1.1.1.1');
    expect([...lsdb.portLinks]).toEqual([
      ['Gi0/0', 'l1'],
      ['Se0/0/0', 'l5'],
    ]);
    expect(runsOspf(lsdb)).toBe(true);
  });

  it('a device without OSPF rows derives the empty value; the memo returns one object per device object', () => {
    const snap = world();
    const sw = dev(snap, 'sw1');
    expect(runsOspf(deriveDeviceLsdb(sw))).toBe(false);
    expect(deriveDeviceLsdb(sw).routerId).toBeUndefined();
    const r1 = dev(snap, 'r1');
    expect(lsdbOf(r1)).toBe(lsdbOf(r1));
    expect(lsdbOf({ ...r1 })).not.toBe(lsdbOf(r1));
  });

  it('skips rows that are not LSAs (defensive: a partial row never breaks the panel)', () => {
    const d = dev(world(), 'r2');
    const broken = { ...d, tables: { ...d.tables, extra: [{ name: 'ospf-lsdb' as const, title: '', columns: [], rows: [{ scope: '0.0.0.0', type: 1 }] }] } };
    expect(deriveDeviceLsdb(broken).lsas).toEqual([]);
  });

  it('areas: interface areas and LSA scopes, numeric order, the AS scope never an area', () => {
    const rows = [...worldLsas(), routerLsa('1.1.1.1', [], { scope: '0.0.0.10' }), routerLsa('1.1.1.1', [], { scope: '0.0.0.2' })];
    const d = ospfRouter({ id: 'r1', rid: '1.1.1.1', x: 0, y: 0, ports: [['Gi0/0', '10.0.0.1', undefined, '0.0.0.1']], lsas: rows });
    expect(areasOfLsdb(lsdbOf(d))).toEqual(['0.0.0.0', '0.0.0.1', '0.0.0.2', '0.0.0.10']);
  });
});

describe('the pickers', () => {
  it('lists every OSPF router in natural name order with its router id; switches are left out', () => {
    const extra = ospfRouter({ id: 'r10', rid: '10.10.10.10', x: 0, y: 0, ports: [['Gi0/0', '10.9.0.1', undefined]] });
    const routers = lsdbRouters(world({ extraDevices: [extra] }));
    expect(routers.map((r) => r.label)).toEqual(['R1 (1.1.1.1)', 'R2 (2.2.2.2)', 'R3 (3.3.3.3)', 'R4 (4.4.4.4)', 'R10 (10.10.10.10)']);
    expect(routers[0]?.areas).toEqual(['0.0.0.0']);
    expect(lsdbRouters(null)).toEqual([]);
    expect(compareNames('R2', 'R10')).toBeLessThan(0);
    expect(compareNames('Core-1', 'Core-1b')).toBeLessThan(0);
  });

  it('falls back to the first router and the router’s first area', () => {
    const routers = lsdbRouters(world());
    expect(chooseRouter(routers, 'r3')?.device).toBe('r3');
    expect(chooseRouter(routers, 'sw1')?.device).toBe('r1');
    expect(chooseRouter(routers, null)?.device).toBe('r1');
    expect(chooseRouter([], 'r1')).toBeUndefined();
    expect(chooseArea(['0.0.0.0', '0.0.0.1'], '0.0.0.1')).toBe('0.0.0.1');
    expect(chooseArea(['0.0.0.0', '0.0.0.1'], '0.0.0.9')).toBe('0.0.0.0');
    expect(chooseArea([], null)).toBeUndefined();
  });

  it('names a router id two devices use at once', () => {
    const twin = ospfRouter({ id: 'r9', rid: '2.2.2.2', x: 0, y: 0, ports: [['Gi0/0', '10.9.0.1', undefined]] });
    const snap = world({ extraDevices: [twin] });
    expect(duplicateRouterIds(snap)).toEqual(['2.2.2.2']);
    expect(duplicateRouterIds(world())).toEqual([]);
    expect(routerDevices(snap).get('2.2.2.2')?.id).toBe('r2');
  });
});

describe('the LSA list', () => {
  it('ages live, prints the sequence in hex and marks self and MaxAge in words', () => {
    const snap = world();
    const names = routerDevices(snap);
    const own = lsdbOf(dev(snap, 'r1')).lsas[0]!;
    const e = lsaEntry(own, NOW, names);
    expect(e).toMatchObject({ typeLabel: 'Router', lsid: '1.1.1.1', advName: 'R1 (1.1.1.1)', age: 15, seqHex: '0x80000003', self: true, maxAge: false, marks: 'self' });
    expect(lsaEntry(own, T0 + 65 * SEC + SEC / 2, names).age).toBe(75);
    const old = lsaEntry(own, T0 + 3600 * SEC, names);
    expect(old.age).toBe(3600);
    expect(old.maxAge).toBe(true);
    expect(old.marks).toBe('self · MaxAge');
    const flushed = lsaEntry({ ...own, self: false, maxAge: true }, NOW, names);
    expect(flushed.marks).toBe('MaxAge');
    expect(flushed.age).toBe(3600);
    expect(seqHex(0x80000001)).toBe('0x80000001');
    expect(seqHex(0x7fffffff)).toBe('0x7fffffff');
    expect(seqHex(5)).toBe('0x00000005');
    expect(checksumHex(0x3f1c)).toBe('0x3f1c');
    expect(checksumHex(0xa)).toBe('0x000a');
  });

  it('the view: the chosen router’s area LSAs, then the AS externals; the selected key kept only when held', () => {
    const snap = world();
    const v = buildLsdbView(snap, { device: 'r2', area: null, lsa: 'nope' }, NOW);
    expect(v.router?.device).toBe('r2');
    expect(v.area).toBe('0.0.0.0');
    expect(v.areas).toEqual(['0.0.0.0']);
    expect(v.lsas.map((e) => `${e.typeLabel}:${e.lsid}${e.self ? '*' : ''}`)).toEqual([
      'Router:1.1.1.1',
      'Router:2.2.2.2*',
      'Router:3.3.3.3',
      'Router:4.4.4.4',
      'Network:10.0.123.2*',
      'External:0.0.0.0',
    ]);
    expect(v.selected).toBeUndefined();
    const key = lsaRowKey(worldLsas()[0]!);
    expect(buildLsdbView(snap, { device: 'r2', area: AREA0, lsa: key }, NOW).selected).toBe(key);
    expect(buildLsdbView(null, { device: null, area: null, lsa: null }, NOW)).toEqual({ routers: [], areas: [], lsas: [], duplicates: [] });
  });

  it('renders each mark as a word chip and the selected row as current', () => {
    const snap = world();
    const v = buildLsdbView(snap, { device: 'r1', area: AREA0, lsa: null }, T0 + 3600 * SEC);
    const html = renderToStaticMarkup(createElement(LsaList, { entries: v.lsas, selected: v.lsas[1]!.key, onSelect: () => undefined }));
    expect(html).toContain('<span class="chip accent">self</span>');
    expect(html).toContain('<span class="chip warn">MaxAge</span>');
    expect(html).toContain('0x80000003');
    expect(html.match(/aria-current="true"/g)).toHaveLength(1);
    expect(html).toContain('External (AS)');
    expect(renderToStaticMarkup(createElement(LsaList, { entries: [], onSelect: () => undefined }))).toContain('holds no link-state advertisement');
  });
});

describe('the LSA detail', () => {
  it('a router LSA: header, links in words with router names, flags', () => {
    const snap = world();
    const d = lsaDetail(snap, 'r1', '0.0.0.0|1|4.4.4.4|4.4.4.4', NOW)!;
    expect(d.header).toEqual([
      ['Type', '1 (Router)'],
      ['Link-state id', '4.4.4.4'],
      ['Advertising router', 'R4 (4.4.4.4)'],
      ['Age', '15 s'],
      ['Sequence', '0x80000003'],
      ['Checksum', '0x1004'],
      ['Length', '84 bytes'],
      ['Scope', 'Area 0'],
    ]);
    expect(d.body.kind).toBe('router');
    if (d.body.kind !== 'router') return;
    expect(d.body.flags).toBe('E (AS boundary)');
    expect(d.body.links.map((l) => l.text)).toEqual([
      'point-to-point to R2 (2.2.2.2), local address 10.0.24.2, cost 1',
      'stub network 10.0.24.0/30, cost 1',
      'point-to-point to R3 (3.3.3.3), local address 10.0.34.2, cost 1',
      'stub network 10.0.34.0/30, cost 1',
      'stub network 4.4.4.4/32, cost 1',
    ]);
    expect(lsaDetail(snap, 'r1', 'no|such|key', NOW)).toBeUndefined();
    expect(lsaDetail(snap, 'zz', '0.0.0.0|1|4.4.4.4|4.4.4.4', NOW)).toBeUndefined();
  });

  it('a network LSA and an external LSA in words', () => {
    const snap = world();
    const n = lsaDetail(snap, 'r3', '0.0.0.0|2|10.0.123.2|2.2.2.2', NOW)!;
    expect(n.body).toEqual({
      kind: 'network',
      mask: '255.255.255.0',
      prefix: '10.0.123.0/24',
      attached: [
        { rid: '2.2.2.2', name: 'R2 (2.2.2.2)' },
        { rid: '1.1.1.1', name: 'R1 (1.1.1.1)' },
        { rid: '3.3.3.3', name: 'R3 (3.3.3.3)' },
      ],
    });
    const x = lsaDetail(snap, 'r3', 'as|5|0.0.0.0|4.4.4.4', NOW)!;
    expect(x.body).toEqual({ kind: 'external', mask: '0.0.0.0', prefix: '0.0.0.0/0', metric: 1, metricType: 'E2', forward: '0.0.0.0', tag: 1 });
    expect(x.agreementLabel).toBe('The same in every OSPF router');
    expect(n.agreementLabel).toBe('The same in every router of this area');
    expect(x.header.at(-1)).toEqual(['Scope', 'the whole AS']);
  });

  it('"the same in every router of this area": yes when every router holds the same instance', () => {
    const snap = world();
    const d = lsaDetail(snap, 'r1', '0.0.0.0|1|2.2.2.2|2.2.2.2', NOW)!;
    expect(d.agreement.word).toBe('yes');
    expect(d.agreement.routers.map((r) => [r.name, r.holding])).toEqual([
      ['R1', 'same'],
      ['R2', 'same'],
      ['R3', 'same'],
      ['R4', 'same'],
    ]);
  });

  it('no when a router holds an older or newer copy, or none', () => {
    const older = heldBy('3.3.3.3').map((r) => (r.advRouter === '2.2.2.2' && r.type === 1 ? { ...r, seq: 0x80000002 } : r));
    const missing = heldBy('4.4.4.4').filter((r) => !(r.advRouter === '2.2.2.2' && r.type === 1));
    const snap = world({ lsas: { '3.3.3.3': older, '4.4.4.4': missing } });
    const row = lsdbOf(dev(snap, 'r1')).lsas.find((r) => r.advRouter === '2.2.2.2' && r.type === 1)!;
    const a = lsaAgreement(snap, row, NOW);
    expect(a.same).toBe(false);
    expect(a.word).toBe('no');
    expect(a.routers.map((r) => [r.name, r.holding, r.seqHex])).toEqual([
      ['R1', 'same', '0x80000003'],
      ['R2', 'same', '0x80000003'],
      ['R3', 'older', '0x80000002'],
      ['R4', 'missing', undefined],
    ]);
    // seen from R3, the others hold a newer copy
    const fromR3 = lsaAgreement(snap, older.find((r) => r.advRouter === '2.2.2.2' && r.type === 1)!, NOW);
    expect(fromR3.routers.find((r) => r.name === 'R1')?.holding).toBe('newer');
  });

  it('a copy with another checksum, or one at MaxAge, is another instance (RFC 2328 §13.1)', () => {
    const cks = heldBy('3.3.3.3').map((r) => (r.advRouter === '2.2.2.2' && r.type === 1 ? { ...r, checksum: r.checksum + 1 } : r));
    const snap = world({ lsas: { '3.3.3.3': cks } });
    const row = lsdbOf(dev(snap, 'r1')).lsas.find((r) => r.advRouter === '2.2.2.2' && r.type === 1)!;
    expect(lsaAgreement(snap, row, NOW).routers.find((r) => r.name === 'R3')?.holding).toBe('newer');
    const flushing = heldBy('4.4.4.4').map((r) => (r.advRouter === '2.2.2.2' && r.type === 1 ? { ...r, maxAge: true as const } : r));
    const snap2 = world({ lsas: { '4.4.4.4': flushing } });
    const row2 = lsdbOf(dev(snap2, 'r1')).lsas.find((r) => r.advRouter === '2.2.2.2' && r.type === 1)!;
    expect(lsaAgreement(snap2, row2, NOW).routers.find((r) => r.name === 'R4')?.holding).toBe('newer');
  });

  it('the area scope counts the routers with an interface in the area; the AS scope every OSPF router', () => {
    const other = ospfRouter({ id: 'r5', rid: '5.5.5.5', x: 0, y: 0, ports: [['Gi0/0', '10.5.0.1', undefined, '0.0.0.1']], lsas: [] });
    const snap = world({ extraDevices: [other] });
    const r1 = lsdbOf(dev(snap, 'r1')).lsas;
    expect(lsaAgreement(snap, r1.find((r) => r.type === 1)!, NOW).routers.map((r) => r.name)).toEqual(['R1', 'R2', 'R3', 'R4']);
    const ext = lsaAgreement(snap, r1.find((r) => r.type === 5)!, NOW);
    expect(ext.routers.map((r) => [r.name, r.holding])).toEqual([
      ['R1', 'same'],
      ['R2', 'same'],
      ['R3', 'same'],
      ['R4', 'same'],
      ['R5', 'missing'],
    ]);
    expect(ext.word).toBe('no');
  });

  it('the packets that carried it: a display filter NetScope parses', () => {
    const f = lsaDisplayFilter({ type: 1, lsid: '2.2.2.2', advRouter: '2.2.2.2' });
    expect(f).toBe('ospf-lsa.lsType == 1 && ospf-lsa.lsid == 2.2.2.2 && ospf-lsa.advRouter == 2.2.2.2');
    const parsed = parseDisplayFilter(f);
    expect(parsed.ok).toBe(true);
    const ext = lsaDisplayFilter(externalLsa('0.0.0.0', '4.4.4.4', '0.0.0.0', 1));
    expect(parseDisplayFilter(ext).ok).toBe(true);
  });

  it('renders the verdict as a word, each router’s copy in words, and the packets button only with a handler', () => {
    const older = heldBy('3.3.3.3').map((r) => (r.advRouter === '2.2.2.2' && r.type === 1 ? { ...r, seq: 0x80000002 } : r));
    const snap = world({ lsas: { '3.3.3.3': older } });
    const d = lsaDetail(snap, 'r1', '0.0.0.0|1|2.2.2.2|2.2.2.2', NOW)!;
    const html = renderToStaticMarkup(createElement(LsaDetail, { detail: d, onShowPackets: () => undefined }));
    expect(html).toContain('The same in every router of this area:');
    expect(html).toContain('data-agreement="no"');
    expect(html).toContain('>no</strong>');
    expect(html).toContain('older copy');
    expect(html).toContain('Show the packets that carried it');
    expect(html).toContain(d.filter.replaceAll('&', '&amp;'));
    const plain = renderToStaticMarkup(createElement(LsaDetail, { detail: lsaDetail(world(), 'r1', '0.0.0.0|1|2.2.2.2|2.2.2.2', NOW)! }));
    expect(plain).toContain('>yes</strong>');
    expect(plain).not.toContain('Show the packets that carried it');
  });
});

describe('the LSDB graph', () => {
  it('routers at their canvas positions, the LAN at the centroid of its routers', () => {
    const g = buildLsdbGraph(world(), 'r1', AREA0, NOW);
    expect(g.nodes.map((n) => [n.key, n.label, n.x, n.y, n.placed, n.stubs])).toEqual([
      ['R:1.1.1.1', 'R1', 100, 100, true, 2],
      ['R:2.2.2.2', 'R2', 300, 100, true, 1],
      ['R:3.3.3.3', 'R3', 200, 300, true, 2],
      ['R:4.4.4.4', 'R4', 400, 300, true, 3],
      ['N:10.0.123.2', '10.0.123.0/24', 200, 500 / 3, true, 0],
    ]);
    expect(g.bounds).toEqual({ minX: 100, minY: 100, maxX: 400, maxY: 300 });
  });

  it('edges carry the cost each side advertises; a network’s side costs 0', () => {
    const g = buildLsdbGraph(world(), 'r1', AREA0, NOW);
    expect(g.edges.map((e) => [e.key, e.costFrom, e.costTo, e.twoWay])).toEqual([
      ['p2p:1.1.1.1|3.3.3.3', 64, 64, true],
      ['p2p:2.2.2.2|4.4.4.4', 1, 1, true],
      ['p2p:3.3.3.3|4.4.4.4', 1, 1, true],
      ['transit:10.0.123.2|1.1.1.1', 1, 0, true],
      ['transit:10.0.123.2|2.2.2.2', 1, 0, true],
      ['transit:10.0.123.2|3.3.3.3', 1, 0, true],
    ]);
  });

  it('an edge one side lists is one-way; a router no device uses is laid out below; MaxAge copies are left out', () => {
    const rows: OspfLsaRow[] = worldLsas().map((r) =>
      r.advRouter === '4.4.4.4' && r.type === 1 ? { ...r, links: [...(r.links ?? []), { kind: 'p2p' as const, id: '7.7.7.7', data: '10.0.47.1', metric: 10 }] } : r,
    );
    rows.push(routerLsa('7.7.7.7', [{ kind: 'stub', id: '10.7.0.0', data: '255.255.255.0', metric: 1 }]));
    rows.push(routerLsa('8.8.8.8', [], { maxAge: true }));
    const g = buildLsdbGraph(world({ lsas: { '1.1.1.1': rows } }), 'r1', AREA0, NOW);
    const ghost = g.nodes.find((n) => n.key === 'R:7.7.7.7')!;
    expect(ghost).toMatchObject({ label: '7.7.7.7', placed: false, x: 100, y: 300 + GRAPH_UNPLACED_STEP });
    expect(g.nodes.some((n) => n.key === 'R:8.8.8.8')).toBe(false);
    expect(g.edges.find((e) => e.key === 'p2p:4.4.4.4|7.7.7.7')).toEqual({ key: 'p2p:4.4.4.4|7.7.7.7', kind: 'p2p', from: 'R:4.4.4.4', to: 'R:7.7.7.7', costFrom: 10, twoWay: false });
    const html = renderToStaticMarkup(createElement(LsdbGraph, { graph: g, selected: ghost.lsaKey, onSelect: () => undefined, label: 'graph' }));
    expect(html).toContain('one-way');
    expect(html).toContain('not on the canvas');
    expect(html).toContain('aria-pressed="true"');
    expect(html.match(/role="button"/g)).toHaveLength(g.nodes.length);
  });

  it('a network whose LSA lists a router that does not link back is one-way too', () => {
    const rows = worldLsas().map((r) => (r.advRouter === '3.3.3.3' && r.type === 1 ? { ...r, links: (r.links ?? []).filter((l) => l.kind !== 'transit') } : r));
    const g = buildLsdbGraph(world({ lsas: { '1.1.1.1': rows } }), 'r1', AREA0, NOW);
    expect(g.edges.find((e) => e.key === 'transit:10.0.123.2|3.3.3.3')).toMatchObject({ costTo: 0, twoWay: false });
    expect(g.edges.find((e) => e.key === 'transit:10.0.123.2|3.3.3.3')?.costFrom).toBeUndefined();
  });

  it('fits into the drawing box keeping the aspect, centred', () => {
    const g = buildLsdbGraph(world(), 'r1', AREA0, NOW);
    const pos = fitGraph(g, 640, 260, 40);
    for (const p of pos.values()) {
      expect(p.x).toBeGreaterThanOrEqual(40 - 1e-9);
      expect(p.x).toBeLessThanOrEqual(600 + 1e-9);
      expect(p.y).toBeGreaterThanOrEqual(40 - 1e-9);
      expect(p.y).toBeLessThanOrEqual(220 + 1e-9);
    }
    const r1 = pos.get('R:1.1.1.1')!;
    const r4 = pos.get('R:4.4.4.4')!;
    expect((r4.x - r1.x) / (r4.y - r1.y)).toBeCloseTo(300 / 200, 9);
    const single = fitGraph({ nodes: [g.nodes[0]!], edges: [], bounds: { minX: 100, minY: 100, maxX: 100, maxY: 100 } }, 640, 260, 40);
    expect(single.get('R:1.1.1.1')).toEqual({ x: 320, y: 130 });
  });

  it('an empty area draws nothing, with a sentence', () => {
    const lonely = device('r9', 0, 0, [port('Gi0/0')]);
    const g = buildLsdbGraph(world({ extraDevices: [lonely] }), 'r9', AREA0, NOW);
    expect(g.nodes).toEqual([]);
    expect(renderToStaticMarkup(createElement(LsdbGraph, { graph: g, label: 'graph' }))).toContain('nothing to draw');
  });
});
