// NAT quadrant visualizer (ARCHITECTURE-P2 §6 "NAT quadrant visualizer", §3.9; W3 web-inspector): the four address
// names filled from the `nat` rows, the selected packet's NatTranslate provenance marking the two cells it moved
// between (with the rule as cause and PAT id changes), and the rendered quadrant.
import { describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { TABLE_DESCRIPTORS, emptyCounters } from '@netforge/engine';
import type { DeviceSnapshot, Mutation, PduJson, TableSnapshot } from '@netforge/engine';

vi.mock('../src/bridge/client', () => ({ engine: {}, fmtSimTime: (t: number) => `${t / 1_000_000_000} s` }));
vi.mock('../src/store/store', () => {
  const state: Record<string, unknown> = { catalog: [], snapshot: null, snapshotIndex: undefined, epoch: 0, selection: null, tableFlashes: [] };
  const useStore = Object.assign((selector: (s: Record<string, unknown>) => unknown) => selector(state), {
    getState: () => state,
    setState: (patch: Record<string, unknown>) => Object.assign(state, patch),
    subscribe: () => () => undefined,
  });
  return { useStore, store: useStore };
});

import { TablesTab } from '../src/inspector/TablesTab';
import {
  NAT_CELLS,
  NAT_CELL_TEXT,
  NatQuadrant,
  NatQuadrantForDevice,
  endpointText,
  hasNatTable,
  natMatchText,
  natPacketMatch,
  natQuadrantModel,
  natRowsOf,
} from '../src/inspector/NatQuadrant';

const STATIC_RULE = 'ip nat inside source static 192.168.1.10 203.0.113.5';
const PAT_RULE = 'ip nat inside source list 1 interface GigabitEthernet0/1 overload';

const NAT_TABLE: TableSnapshot = {
  name: 'nat',
  title: TABLE_DESCRIPTORS.nat.title,
  columns: [...TABLE_DESCRIPTORS.nat.columns],
  rows: [
    { key: 'any|203.0.113.5|*', proto: 'any', insideLocal: '192.168.1.10', insideGlobal: '203.0.113.5', kind: 'static', rule: STATIC_RULE, updatedAt: 0 },
    {
      key: 'icmp|203.0.113.1|1', proto: 'icmp', insideLocal: '192.168.1.10', insideLocalPort: 1, insideGlobal: '203.0.113.1', insideGlobalPort: 1,
      outsideLocal: '203.0.113.10', outsideGlobal: '203.0.113.10', kind: 'overload', rule: PAT_RULE, updatedAt: 10, expiresAt: 70_000_000_000,
    },
    {
      key: 'icmp|203.0.113.1|2', proto: 'icmp', insideLocal: '192.168.1.11', insideLocalPort: 1, insideGlobal: '203.0.113.1', insideGlobalPort: 2,
      outsideLocal: '203.0.113.10', outsideGlobal: '203.0.113.10', kind: 'overload', rule: PAT_RULE, updatedAt: 12, expiresAt: 72_000_000_000,
    },
    { key: 'broken', proto: 'any', kind: 'dynamic', updatedAt: 0 },
  ],
};

function router(extra: TableSnapshot[] | undefined, more: Partial<DeviceSnapshot> = {}): DeviceSnapshot {
  return {
    id: 'r1', type: 'router.nf2911', model: 'NF-2911', kind: 'router', name: 'R1', position: { x: 0, y: 0 }, power: true, booted: true, uptimeNs: 0,
    ports: [], tables: { cam: [], arp: [], rib: [], ...(extra === undefined ? {} : { extra }) }, processes: [], runningConfig: '', hasStartupConfig: false,
    category: 'routers', family: 'NF-2911', variant: '', icon: 'router', capabilities: ['routing'], cli: { shell: 'nfos', grammar: 'nfos' }, gui: ['physical'],
    hostPorts: [], baseMac: '02:00:00:00:00:00', ...more,
  };
}

function mutation(device: string, field: string, before: unknown, after: unknown, cause?: string, reason: Mutation['reason'] = 'NatTranslate'): Mutation {
  return { at: 1, device, reason, field, before: before as Mutation['before'], after: after as Mutation['after'], ...(cause !== undefined ? { cause } : {}) };
}

function pdu(provenance: Mutation[]): PduJson {
  return { id: 'p1', bytes: new Uint8Array(), layers: [], meta: { born: 0, origin: 'pc1' }, provenance, summary: '', topProto: 'ethernet' };
}

function text(html: string): string {
  return html.replace(/<[^>]+>/g, ' ').replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ');
}

const R1 = router([NAT_TABLE]);
const ROWS = natRowsOf(R1);

describe('nat rows', () => {
  it('types the generic rows and skips rows without both inside addresses', () => {
    expect(hasNatTable(R1)).toBe(true);
    expect(hasNatTable(router(undefined))).toBe(false);
    expect(natRowsOf(router(undefined))).toEqual([]);
    expect(ROWS.map((r) => r.key)).toEqual(['any|203.0.113.5|*', 'icmp|203.0.113.1|1', 'icmp|203.0.113.1|2']);
    expect(ROWS[1]).toMatchObject({ proto: 'icmp', insideLocalPort: 1, insideGlobalPort: 1, outsideGlobal: '203.0.113.10', kind: 'overload', rule: PAT_RULE, expiresAt: 70_000_000_000 });
    expect(endpointText('10.0.0.1', undefined, 'any')).toBe('10.0.0.1');
    expect(endpointText('10.0.0.1', 53, 'udp')).toBe('10.0.0.1:53');
    expect(endpointText('10.0.0.1', 7, 'icmp')).toBe('10.0.0.1 id 7');
  });
});

describe('the selected packet', () => {
  it('finds an outbound static translation by its rule and marks inside local → inside global', () => {
    const p = pdu([
      mutation('r1', 'ipv4.ttl', 128, 127, 'ip route 0.0.0.0 0.0.0.0 203.0.113.2', 'TtlDecrement'),
      mutation('r1', 'ipv4.src', '192.168.1.10', '203.0.113.5', STATIC_RULE),
      mutation('r1', 'ipv4.checksum', 1, 2, undefined, 'ChecksumRecompute'),
      mutation('r1', 'ethernet.src', 'a', 'b', undefined, 'MacRewrite'),
    ]);
    const m = natPacketMatch(ROWS, p, 'r1')!;
    expect(m).toEqual({
      direction: 'outbound', from: '192.168.1.10', to: '203.0.113.5', rule: STATIC_RULE, rowKey: 'any|203.0.113.5|*', portChanges: [], cells: ['insideLocal', 'insideGlobal'],
    });
    expect(natMatchText(m)).toBe(`Outbound: the source address 192.168.1.10 became 203.0.113.5 because of "${STATIC_RULE}".`);
    expect(natPacketMatch(ROWS, p, 'r2')).toBeUndefined();
    expect(natPacketMatch(ROWS, undefined, 'r1')).toBeUndefined();
  });

  it('finds an inbound PAT reply with its id change and marks inside global → inside local', () => {
    const p = pdu([
      mutation('r1', 'icmpv4.id', 2, 1, PAT_RULE),
      mutation('r1', 'icmpv4.checksum', 1, 2, undefined, 'ChecksumRecompute'),
      mutation('r1', 'ipv4.dst', '203.0.113.1', '192.168.1.11', PAT_RULE),
    ]);
    const m = natPacketMatch(ROWS, p, 'r1')!;
    expect(m).toMatchObject({ direction: 'inbound', from: '203.0.113.1', to: '192.168.1.11', rowKey: 'icmp|203.0.113.1|2', cells: ['insideGlobal', 'insideLocal'] });
    expect(m.portChanges).toEqual([{ field: 'icmpv4.id', from: '2', to: '1' }]);
    expect(natMatchText(m)).toContain('(with icmpv4.id 2 → 1)');
    expect(natMatchText(m)).toContain('Inbound: the destination address 203.0.113.1 became 192.168.1.11');
  });

  it('keeps the packet when its row is gone', () => {
    const p = pdu([mutation('r1', 'ipv4.src', '192.168.1.12', '203.0.113.20', 'ip nat inside source list 1 pool P')]);
    const m = natPacketMatch(ROWS, p, 'r1')!;
    expect(m.rowKey).toBeNull();
    expect(m.direction).toBe('outbound');
  });
});

describe('the quadrant model', () => {
  it('fills the four cells without duplicates and marks the packet row hot', () => {
    const p = pdu([mutation('r1', 'ipv4.src', '192.168.1.10', '203.0.113.1', PAT_RULE)]);
    const model = natQuadrantModel(ROWS, natPacketMatch(ROWS, p, 'r1'));
    expect(model.rowCount).toBe(3);
    expect(model.cells.insideLocal.map((e) => [e.text, e.hot])).toEqual([
      ['192.168.1.10', false],
      ['192.168.1.10 id 1', true],
      ['192.168.1.11 id 1', false],
    ]);
    expect(model.cells.insideGlobal.map((e) => [e.text, e.hot])).toEqual([
      ['203.0.113.5', false],
      ['203.0.113.1 id 1', true],
      ['203.0.113.1 id 2', false],
    ]);
    expect(model.cells.outsideLocal.map((e) => e.text)).toEqual(['203.0.113.10']);
    expect(model.cells.outsideGlobal.map((e) => [e.text, e.hot])).toEqual([['203.0.113.10', false]]);
    expect(NAT_CELLS).toEqual(['insideLocal', 'insideGlobal', 'outsideLocal', 'outsideGlobal']);
    expect(Object.keys(NAT_CELL_TEXT)).toEqual([...NAT_CELLS]);
  });

  it('keeps every cell empty without rows', () => {
    const model = natQuadrantModel([], undefined);
    expect(model.cells).toEqual({ insideLocal: [], insideGlobal: [], outsideLocal: [], outsideGlobal: [] });
    expect(model.rowCount).toBe(0);
  });
});

describe('NatQuadrant rendering', () => {
  it('renders the titles, the entries and the packet sentence', () => {
    const p = pdu([mutation('r1', 'ipv4.src', '192.168.1.10', '203.0.113.5', STATIC_RULE)]);
    const t = text(renderToStaticMarkup(createElement(NatQuadrant, { device: R1, pdu: p })));
    expect(t).toContain('Address translation (3 translations)');
    expect(t).toContain('Inside local');
    expect(t).toContain('Outside global');
    expect(t).toContain('▶ 203.0.113.5 static (this packet)');
    expect(t).toContain('the source address 192.168.1.10 became 203.0.113.5');
    expect(t).toContain(NAT_CELL_TEXT.insideGlobal.meaning);
  });

  it('explains the empty, unselected, powered-off and no-table states', () => {
    expect(text(renderToStaticMarkup(createElement(NatQuadrant, { device: router([{ ...NAT_TABLE, rows: [] }]) })))).toContain('No translation yet.');
    const unselected = text(renderToStaticMarkup(createElement(NatQuadrant, { device: R1, now: 20_000_000_000 })));
    expect(unselected).toContain('Select a packet that crossed this device');
    expect(unselected).toContain('Next expiry at 70 s');
    expect(text(renderToStaticMarkup(createElement(NatQuadrant, { device: router([NAT_TABLE], { power: false }) })))).toContain('powered off');
    expect(text(renderToStaticMarkup(createElement(NatQuadrant, { device: router(undefined) })))).toContain('does not translate addresses');
    expect(text(renderToStaticMarkup(createElement(NatQuadrantForDevice, { device: R1 })))).toContain('Select a packet');
  });
});

describe('the device inspector mounts the quadrant', () => {
  it('the Tables tab of a router with a `nat` table heads with the Address translation section; a device without it shows none', () => {
    const withNat = text(renderToStaticMarkup(createElement(TablesTab, { device: R1 })));
    expect(withNat).toContain('Address translation');
    expect(withNat).toContain('Inside local');
    const without = text(renderToStaticMarkup(createElement(TablesTab, { device: router(undefined, { id: 'sw1', type: 'switch.nfc2960', model: 'NF-C2960', kind: 'switch', name: 'SW1', capabilities: ['switching'] }) })));
    expect(without).not.toContain('Address translation');
  });
});
