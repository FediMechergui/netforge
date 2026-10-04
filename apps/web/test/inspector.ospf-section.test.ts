// [S1] The port inspector's OSPF section (ARCHITECTURE-P3 §5.9 "Port inspector": area, type, cost and its source,
// state, DR/BDR, neighbours and their states, the last refused hello; §6, §3.1; §7 W3 web-inspector): read from the
// `ospf-interfaces` and `ospf-neighbors` rows only; nothing for a port without an interface row.
import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { DeviceSnapshot, OspfInterfaceRow, OspfNeighborRow, TableSnapshot } from '@netforge/engine';
import {
  OSPF_ISM_WORDS,
  OSPF_NSM_WORDS,
  OspfSection,
  ospfCostText,
  ospfPortFacts,
  ospfRefusalText,
  ospfRouterText,
  ospfStateText,
} from '../src/inspector/OspfSection';

const S = 1_000_000_000;

function text(html: string): string {
  return html.replace(/<[^>]+>/g, ' ').replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ');
}

function ifRow(over: Partial<OspfInterfaceRow> = {}): OspfInterfaceRow {
  return {
    key: 'GigabitEthernet0/0',
    updatedAt: 0,
    port: 'GigabitEthernet0/0',
    process: 1,
    routerId: '1.1.1.1',
    area: '0.0.0.0',
    networkType: 'broadcast',
    state: 'dr',
    address: '10.0.0.1',
    prefixLen: 24,
    cost: 1,
    costSource: 'bandwidth',
    priority: 1,
    helloS: 10,
    deadS: 40,
    passive: false,
    dr: '1.1.1.1',
    drAddress: '10.0.0.1',
    bdr: '2.2.2.2',
    bdrAddress: '10.0.0.2',
    neighbors: 2,
    adjacent: 2,
    stateSince: 40 * S,
    ...over,
  };
}

function nbr(routerId: string, address: string, over: Partial<OspfNeighborRow> = {}): OspfNeighborRow {
  return {
    key: `GigabitEthernet0/0|${routerId}`,
    updatedAt: 0,
    port: 'GigabitEthernet0/0',
    routerId,
    address,
    priority: 1,
    state: 'full',
    role: 'drother',
    dr: '10.0.0.1',
    bdr: '10.0.0.2',
    stateSince: 45 * S,
    ...over,
  };
}

function table(name: string, rows: object[]): TableSnapshot {
  return { name: name as TableSnapshot['name'], title: name, columns: [], rows: rows as Record<string, unknown>[] };
}

function router(ifs: OspfInterfaceRow[], nbrs: OspfNeighborRow[]): Pick<DeviceSnapshot, 'tables'> {
  return { tables: { cam: [], arp: [], rib: [], extra: [table('ospf-interfaces', ifs), table('ospf-neighbors', nbrs)] } };
}

describe('[S1] the OSPF section facts and words', () => {
  it('finds the interface row and the neighbours of this port only, by router id', () => {
    const d = router(
      [ifRow(), ifRow({ key: 'Serial0/0/0', port: 'Serial0/0/0', networkType: 'point-to-point', state: 'point-to-point' })],
      [nbr('3.3.3.3', '10.0.0.3'), nbr('2.2.2.2', '10.0.0.2', { role: 'bdr' }), nbr('4.4.4.4', '10.1.1.2', { key: 'Serial0/0/0|4.4.4.4', port: 'Serial0/0/0' })],
    );
    const f = ospfPortFacts(d, 'GigabitEthernet0/0');
    expect(f?.iface.port).toBe('GigabitEthernet0/0');
    expect(f?.neighbors.map((n) => n.routerId)).toEqual(['2.2.2.2', '3.3.3.3']);
    expect(ospfPortFacts(d, 'GigabitEthernet0/1')).toBeUndefined();
    expect(ospfPortFacts({ tables: { cam: [], arp: [], rib: [] } }, 'GigabitEthernet0/0')).toBeUndefined();
  });

  it('cost and its source, DR/BDR, state with the wait left, and a refusal', () => {
    expect(ospfCostText({ cost: 64, costSource: 'bandwidth' })).toBe('64 (from the interface bandwidth)');
    expect(ospfCostText({ cost: 10, costSource: 'configured' })).toBe('10 (configured with ip ospf cost)');
    expect(ospfRouterText('2.2.2.2', '10.0.0.2')).toBe('2.2.2.2 at 10.0.0.2');
    expect(ospfRouterText(undefined, undefined)).toBe('none');
    expect(ospfRouterText('0.0.0.0', undefined)).toBe('none');
    expect(ospfStateText({ state: 'waiting', stateSince: 40 * S, waitUntil: 80 * S }, 57 * S)).toBe(`${OSPF_ISM_WORDS.waiting}, 23 s left`);
    expect(ospfStateText({ state: 'dr', stateSince: 40 * S }, 90 * S)).toBe('DR (designated router)');
    expect(ospfRefusalText({ from: '10.0.0.9', routerId: '9.9.9.9', reason: 'hello interval 5 differs from 10', at: 61 * S })).toBe(
      'from 10.0.0.9 (router 9.9.9.9): hello interval 5 differs from 10, at 00:01:01.000000',
    );
    expect(OSPF_NSM_WORDS['2way'].text).toBe('2-Way (neighbours, not adjacent)');
  });
});

describe('[S1] the rendered OSPF section', () => {
  it('a DR on a LAN with two neighbours and a refused hello', () => {
    const d = router(
      [ifRow({ rejected: { from: '10.0.0.9', routerId: '9.9.9.9', reason: 'area 0.0.0.1 differs from 0.0.0.0', at: 61 * S } })],
      [nbr('2.2.2.2', '10.0.0.2', { role: 'bdr' }), nbr('3.3.3.3', '10.0.0.3', { state: '2way' })],
    );
    const html = renderToStaticMarkup(createElement(OspfSection, { device: d, port: { id: 'GigabitEthernet0/0' }, now: 90 * S }));
    const t = text(html);
    expect(html).toContain('aria-label="OSPF"');
    expect(t).toContain('Area Area 0 (0.0.0.0)');
    expect(t).toContain('process 1 · router id 1.1.1.1');
    expect(t).toContain('Network type broadcast (elects a DR and a BDR)');
    expect(t).toContain('Cost 1 (from the interface bandwidth)');
    expect(t).toContain('State DR (designated router)');
    expect(t).toContain('hello 10 s · dead 40 s');
    expect(t).toContain('DR 1.1.1.1 at 10.0.0.1');
    expect(t).toContain('BDR 2.2.2.2 at 10.0.0.2');
    expect(t).toContain('Last refused hello ! from 10.0.0.9 (router 9.9.9.9): area 0.0.0.1 differs from 0.0.0.0, at 00:01:01.000000');
    expect(t).toContain('Neighbours on this port: 2, adjacent (Full): 1');
    expect(t).toContain('2.2.2.2 10.0.0.2 ● Full (adjacent) BDR 1');
    expect(t).toContain('3.3.3.3 10.0.0.3 ◑ 2-Way (neighbours, not adjacent) DROTHER 1');
    expect(html).not.toContain('role="progressbar"');
  });

  it('a Waiting interface shows the time left and the draining bar (0.5 in the middle of the wait)', () => {
    const d = router([ifRow({ state: 'waiting', stateSince: 40 * S, waitUntil: 80 * S, dr: undefined, drAddress: undefined, bdr: undefined, bdrAddress: undefined, neighbors: 0, adjacent: 0 })], []);
    const html = renderToStaticMarkup(createElement(OspfSection, { device: d, port: { id: 'GigabitEthernet0/0' }, now: 60 * S }));
    const t = text(html);
    expect(t).toContain('waiting (listening for a DR before electing one), 20 s left');
    expect(html).toContain('role="progressbar" aria-label="Time left before the DR election" aria-valuemin="0" aria-valuemax="100" aria-valuenow="50"');
    expect(t).toContain('DR none');
    expect(t).toContain('No neighbour heard on this port yet.');
  });

  it('a passive point-to-point interface: no DR lines, the passive mark, no neighbours', () => {
    const d = router([ifRow({ networkType: 'point-to-point', state: 'point-to-point', passive: true, cost: 64, priority: 0 })], []);
    const t = text(renderToStaticMarkup(createElement(OspfSection, { device: d, port: { id: 'GigabitEthernet0/0' }, now: 0 })));
    expect(t).toContain('Passive P yes: the network is advertised, but no hello is sent or accepted here');
    expect(t).toContain('0 (never DR or BDR)');
    expect(t).not.toContain('BDR 2.2.2.2');
    expect(t).toContain('A passive interface forms no neighbours.');
  });

  it('renders nothing for a port without an OSPF row', () => {
    const d = router([ifRow()], []);
    expect(renderToStaticMarkup(createElement(OspfSection, { device: d, port: { id: 'GigabitEthernet0/1' }, now: 0 }))).toBe('');
  });
});
