// [S18]/[S19]/[C13] The WAN overlay layer's pure parts (ARCHITECTURE-P3 §6, §3.9, §3.10, §3.13; W3 web-canvas): the
// D·E·A·N rail's cells (style per step, the `N ✓ 10.1.1.2` cell, placement), the tunnel tubes on `airArc` (one per
// pair, a second bulging to the other side, a stub when the far end is no drawn device), the tube captions (`Tu0 GRE
// 172.16.0.0/30`, `Tu0 IPsec · established`, `✗` when down) and the text forms the keyboard outline reads.
import { describe, expect, it } from 'vitest';
import type { DeviceSnapshot, IpsecSaRow, PortSnapshot, PppRow, TunnelRow } from '@netforge/engine';
import { buildWanOverlay, pppRail, type TunnelTubeMark } from '../src/canvas/overlays/wan-model.js';
import type { DeviceGeom } from '../src/canvas/ports.js';
import {
  RAIL_CELL_H,
  RAIL_GAP,
  RAIL_INSET,
  WAN_STUB_LEN,
  describePppRail,
  describeTunnelEnd,
  railCellRects,
  railCellStyle,
  railCellTexts,
  railCenter,
  railWidth,
  shortPppRail,
  tubeCaption,
  tubeShapes,
  wanDeviceFacts,
  wanLinkFacts,
  wanPortFacts,
} from '../src/canvas/wan.js';
import { device, link, port, snapshot } from './canvas-fixtures.js';

const SEC = 1_000_000_000;

function pppRow(portId: string, over: Partial<PppRow> = {}): PppRow {
  return {
    key: portId,
    port: portId,
    phase: 'network',
    lcp: 'opened',
    authLocal: 'chap',
    authLocalState: 'success',
    authPeer: 'chap',
    authPeerState: 'success',
    peerName: 'R2',
    ipcp: 'opened',
    peerAddress: '10.1.1.2',
    magic: 0x1234,
    failures: 0,
    since: 5 * SEC,
    ...over,
  } as PppRow;
}

function tunnelRow(portId: string, over: Partial<TunnelRow> = {}): TunnelRow {
  return {
    key: portId,
    port: portId,
    mode: 'gre',
    source: '209.165.200.225',
    sourceIface: 'Serial0/0/0',
    destination: '209.165.200.230',
    state: 'up',
    transportMtu: 1500,
    ipMtu: 1476,
    since: 2 * SEC,
    ...over,
  } as TunnelRow;
}

function saRow(portId: string, over: Partial<IpsecSaRow> = {}): IpsecSaRow {
  return {
    key: portId,
    port: portId,
    local: '209.165.200.225',
    peer: '209.165.200.230',
    profile: 'VPN',
    role: 'initiator',
    state: 'established',
    since: 3 * SEC,
    ...over,
  } as IpsecSaRow;
}

type Tables = { ppp?: PppRow[]; tunnels?: TunnelRow[]; sa?: IpsecSaRow[] };

function router(id: string, ports: PortSnapshot[], t: Tables): DeviceSnapshot {
  const extra = [
    ...(t.ppp === undefined ? [] : [{ name: 'ppp' as const, title: 'PPP links', columns: [], rows: t.ppp as unknown as Record<string, unknown>[] }]),
    ...(t.tunnels === undefined ? [] : [{ name: 'tunnels' as const, title: 'Tunnels', columns: [], rows: t.tunnels as unknown as Record<string, unknown>[] }]),
    ...(t.sa === undefined ? [] : [{ name: 'ipsec-sa' as const, title: 'IPsec SAs', columns: [], rows: t.sa as unknown as Record<string, unknown>[] }]),
  ];
  return device(id, 0, 0, ports, { type: 'router.nf2911', model: 'NF-2911', kind: 'router', tables: { cam: [], arp: [], rib: [], extra } });
}

function addressed(id: string, address: string, prefixLen: number, extra: Partial<PortSnapshot> = {}): PortSnapshot {
  return port(id, { short: id, role: 'routed', operUp: true, l3: { ipv4: { address, prefixLen } }, ...extra });
}

function tunnelPort(address: string): PortSnapshot {
  return addressed('Tunnel0', address, 30, { short: 'Tu0', kind: 'virtual', role: 'tunnel', encap: 'tunnel', virtual: true, linkable: false });
}

/** §3.9: R1 Se0/0/0 ↔ R2 Se0/0/0 with PPP. */
function pppPair(r1: Partial<PppRow>, r2: Partial<PppRow> = {}) {
  const a = router('r1', [addressed('Serial0/0/0', '10.1.1.1', 30, { link: 's1', kind: 'serial', encap: 'hdlc' })], { ppp: [pppRow('Serial0/0/0', r1)] });
  const b = router('r2', [addressed('Serial0/0/0', '10.1.1.2', 30, { link: 's1', kind: 'serial', encap: 'hdlc' })], {
    ppp: [pppRow('Serial0/0/0', { peerName: 'R1', peerAddress: '10.1.1.1', ...r2 })],
  });
  return snapshot([a, b], [link('s1', ['r1', 'Serial0/0/0'], ['r2', 'Serial0/0/0'], { media: 'serial-dce', resolvedMedia: 'serial-dce' })]);
}

/** §3.10 / §3.13: R1 — ISP — R2 with Tunnel0 on each router. */
function sites(r1: Partial<TunnelRow>, r2: Partial<TunnelRow> | null, sa?: { r1?: Partial<IpsecSaRow>; r2?: Partial<IpsecSaRow> }) {
  const r1d = router('r1', [addressed('Serial0/0/0', '209.165.200.225', 30, { link: 'w1', kind: 'serial' }), tunnelPort('172.16.0.1')], {
    tunnels: [tunnelRow('Tunnel0', r1)],
    ...(sa?.r1 === undefined ? {} : { sa: [saRow('Tunnel0', sa.r1)] }),
  });
  const r2d = router('r2', [addressed('Serial0/0/0', '209.165.200.230', 30, { link: 'w2', kind: 'serial' }), tunnelPort('172.16.0.2')], {
    ...(r2 === null ? {} : { tunnels: [tunnelRow('Tunnel0', { source: '209.165.200.230', destination: '209.165.200.225', ...r2 })] }),
    ...(sa?.r2 === undefined ? {} : { sa: [saRow('Tunnel0', { local: '209.165.200.230', peer: '209.165.200.225', role: 'responder', ...sa.r2 })] }),
  });
  const isp = device('isp', 0, 0, [addressed('Serial0/0/0', '209.165.200.226', 30, { link: 'w1' }), addressed('Serial0/0/1', '209.165.200.229', 30, { link: 'w2' })], {
    type: 'router.nf2911',
    model: 'NF-2911',
    kind: 'router',
  });
  return snapshot([r1d, isp, r2d], [link('w1', ['r1', 'Serial0/0/0'], ['isp', 'Serial0/0/0']), link('w2', ['isp', 'Serial0/0/1'], ['r2', 'Serial0/0/0'])]);
}

function geom(x: number, y: number, halfW = 20, halfH = 15): DeviceGeom {
  return { device: {} as DeviceSnapshot, x, y, halfW, halfH, visual: {} as DeviceGeom['visual'] };
}

const UNSET = { authLocalState: undefined, authPeerState: undefined } as const;

describe('the rail cells', () => {
  it('draws every step state with its own shape, not only a colour', () => {
    expect(railCellStyle('done')).toEqual({ filled: true, strong: false, faint: false, cross: false, strike: false });
    expect(railCellStyle('current')).toEqual({ filled: false, strong: true, faint: false, cross: false, strike: false });
    expect(railCellStyle('todo')).toEqual({ filled: false, strong: false, faint: true, cross: false, strike: false });
    expect(railCellStyle('failed')).toEqual({ filled: false, strong: true, faint: false, cross: true, strike: false });
    expect(railCellStyle('skipped')).toEqual({ filled: false, strong: false, faint: true, cross: false, strike: true });
  });

  it('writes the letters, and N ✓ 10.1.1.2 in the last cell once IPCP is open', () => {
    expect(railCellTexts(pppRail(pppRow('S')))).toEqual(['D', 'E', 'A', 'N ✓ 10.1.1.2']);
    expect(railCellTexts(pppRail(pppRow('S', { phase: 'establish', lcp: 'req-sent', ipcp: 'initial', ...UNSET })))).toEqual(['D', 'E', 'A', 'N']);
  });

  it('lays the cells out left to right, centred, with a gap between them', () => {
    expect(railWidth([11, 11, 11, 11])).toBe(44 + 3 * RAIL_GAP);
    expect(railWidth([11, 11, 11, 11], 0.5)).toBe((44 + 3 * RAIL_GAP) / 2);
    expect(railWidth([])).toBe(0);
    const rects = railCellRects({ x: 100, y: 50 }, [11, 11, 11, 30]);
    const total = 63 + 3 * RAIL_GAP;
    expect(rects.map((r) => [r.minX, r.maxX])).toEqual([
      [100 - total / 2, 100 - total / 2 + 11],
      [100 - total / 2 + 11 + RAIL_GAP, 100 - total / 2 + 22 + RAIL_GAP],
      [100 - total / 2 + 22 + 2 * RAIL_GAP, 100 - total / 2 + 33 + 2 * RAIL_GAP],
      [100 - total / 2 + 33 + 3 * RAIL_GAP, 100 + total / 2],
    ]);
    expect(rects.every((r) => r.minY === 50 - RAIL_CELL_H / 2 && r.maxY === 50 + RAIL_CELL_H / 2)).toBe(true);
  });

  it('sits out of the port along the cable, clear of the body when the cable leaves sideways', () => {
    expect(railCenter({ x: 0, y: 0, nx: 0, ny: 1 }, 56)).toEqual({ x: 0, y: RAIL_INSET + RAIL_CELL_H / 2 });
    expect(railCenter({ x: 0, y: 0, nx: 1, ny: 0 }, 56)).toEqual({ x: RAIL_INSET + 28, y: 0 });
    expect(railCenter({ x: 10, y: 0, nx: -1, ny: 0 }, 56)).toEqual({ x: 10 - RAIL_INSET - 28, y: 0 });
  });
});

describe('the rail in text', () => {
  it('brackets the current step, crosses a failed A, dashes a skipped one and ends with N ✓ and the peer', () => {
    expect(shortPppRail(pppRail(pppRow('S')))).toBe('D·E·A·N ✓ 10.1.1.2');
    expect(shortPppRail(pppRail(pppRow('S', { phase: 'dead', lcp: 'initial', ipcp: 'initial', ...UNSET })))).toBe('[D]·E·A·N');
    expect(shortPppRail(pppRail(pppRow('S', { phase: 'establish', lcp: 'req-sent', ipcp: 'initial', ...UNSET })))).toBe('D·[E]·A·N');
    expect(shortPppRail(pppRail(pppRow('S', { phase: 'authenticate', ipcp: 'initial', authLocalState: 'pending', authPeerState: 'pending' })))).toBe('D·E·[A]·N');
    expect(shortPppRail(pppRail(pppRow('S', { phase: 'network', ipcp: 'req-sent', peerAddress: undefined })))).toBe('D·E·A·[N]');
    expect(shortPppRail(pppRail(pppRow('S', { phase: 'terminate', ipcp: 'initial', authLocalState: 'failed' })))).toBe('[D]·E·A✗·N');
    expect(shortPppRail(pppRail(pppRow('S', { authLocal: 'none', authPeer: 'none', ...UNSET })))).toBe('D·E·–·N ✓ 10.1.1.2');
  });

  it('says the phase in words with the last failure', () => {
    expect(describePppRail({ words: 'PPP open, peer 10.1.1.2' })).toBe('PPP open, peer 10.1.1.2');
    expect(describePppRail({ words: 'PPP authentication failed, closing the link', lastFailure: 'the response does not match' })).toBe(
      'PPP authentication failed, closing the link; last failure: the response does not match',
    );
  });
});

describe('the tubes', () => {
  const pairLayout = { devices: new Map([['r1', geom(0, 0)], ['r2', geom(400, 0)]]) };

  it('arcs one tube between the two routers, its label at the middle of the arc', () => {
    const tube = buildWanOverlay(sites({}, {})).tubes[0]!;
    const shape = tubeShapes([tube], pairLayout).get(tube.key)!;
    expect(shape.stub).toBe(false);
    // from r1's clearance box (body ±20, grown by 6) to r2's, bulging 60 units left of travel (up)
    expect(shape.geom.p0).toEqual({ x: 26, y: 0 });
    expect(shape.geom.p3).toEqual({ x: 374, y: 0 });
    expect(shape.labelAt.x).toBeCloseTo(200, 9);
    expect(shape.labelAt.y).toBeCloseTo(-60, 9);
    // the side does not depend on which router owns the row
    const flipped: TunnelTubeMark = { ...tube, a: { ...tube.a, device: 'r2' }, toward: 'r1' };
    expect(tubeShapes([flipped], pairLayout).get(tube.key)!.labelAt.y).toBeCloseTo(-60, 9);
  });

  it('bulges a second tube between the same routers to the other side', () => {
    const tube = buildWanOverlay(sites({}, {})).tubes[0]!;
    const second: TunnelTubeMark = { ...tube, key: 'r1|Tunnel1~r2|Tunnel1' };
    const shapes = tubeShapes([tube, second], pairLayout);
    expect(shapes.get(tube.key)!.labelAt.y).toBeCloseTo(-60, 9);
    expect(shapes.get(second.key)!.labelAt.y).toBeCloseTo(60, 9);
  });

  it('leaves a stub with an open end when no drawn device holds the destination, and skips undrawn routers', () => {
    const nowhere = buildWanOverlay(sites({ destination: '198.51.100.9', state: 'down', reason: 'no-route' }, null)).tubes[0]!;
    expect(nowhere.toward).toBeNull();
    const stub = tubeShapes([nowhere], pairLayout).get(nowhere.key)!;
    expect(stub.stub).toBe(true);
    // up and to the right, from r1's clearance box (its top edge at −18 − 6)
    expect(stub.geom.p0.x).toBeCloseTo(24, 9);
    expect(stub.geom.p0.y).toBeCloseTo(-24, 9);
    const d = WAN_STUB_LEN / Math.SQRT2;
    expect(stub.geom.p3.x).toBeCloseTo(24 + d, 9);
    expect(stub.geom.p3.y).toBeCloseTo(-24 - d, 9);
    expect(stub.labelAt.x).toBeGreaterThan(stub.geom.p3.x);
    // the far router is not drawn: a stub too; the own router not drawn: no shape
    const tube = buildWanOverlay(sites({}, {})).tubes[0]!;
    expect(tubeShapes([tube], { devices: new Map([['r1', geom(0, 0)]]) }).get(tube.key)!.stub).toBe(true);
    expect(tubeShapes([tube], { devices: new Map([['r2', geom(0, 0)]]) }).size).toBe(0);
  });

  it('captions a tube with its label, the SA word for IPsec and ✗ when it is down', () => {
    expect(tubeCaption({ label: 'Tu0 GRE 172.16.0.0/30', lock: false, saWord: '', up: true })).toBe('Tu0 GRE 172.16.0.0/30');
    expect(tubeCaption({ label: 'Tu0 GRE 172.16.0.0/30', lock: false, saWord: '', up: false })).toBe('Tu0 GRE 172.16.0.0/30 ✗');
    expect(tubeCaption({ label: 'Tu0 IPsec', lock: true, saWord: 'established', up: true })).toBe('Tu0 IPsec · established');
    expect(tubeCaption({ label: 'Tu0 IPsec', lock: true, saWord: 'negotiating', up: false })).toBe('Tu0 IPsec · negotiating ✗');
    expect(tubeCaption({ label: 'Tu0 IPsec', lock: true, saWord: '', up: false })).toBe('Tu0 IPsec ✗');
  });
});

describe('the text forms (keyboard outline)', () => {
  it('says each serial end and each link of an open PPP pair', () => {
    const model = buildWanOverlay(pppPair({}));
    expect([...wanPortFacts(model)]).toEqual([
      ['r1/Serial0/0/0', { short: 'D·E·A·N ✓ 10.1.1.2', text: 'PPP open, peer 10.1.1.2' }],
      ['r2/Serial0/0/0', { short: 'D·E·A·N ✓ 10.1.1.1', text: 'PPP open, peer 10.1.1.1' }],
    ]);
    expect([...wanLinkFacts(model, (id) => id.toUpperCase())]).toEqual([
      ['s1', { short: 'PPP open', text: 'R1 Serial0/0/0: PPP open, peer 10.1.1.2; R2 Serial0/0/0: PPP open, peer 10.1.1.1' }],
    ]);
    expect(wanDeviceFacts(model).size).toBe(0);
  });

  it('says a failed authentication at both ends, and a link still coming up', () => {
    const failed = buildWanOverlay(
      pppPair(
        { phase: 'terminate', lcp: 'stopping', ipcp: 'initial', authLocalState: 'failed', failures: 1, lastFailure: 'the response does not match' },
        { phase: 'dead', lcp: 'stopped', ipcp: 'initial', authPeerState: 'failed', failures: 1 },
      ),
    );
    expect([...wanPortFacts(failed)]).toEqual([
      ['r1/Serial0/0/0', { short: '[D]·E·A✗·N', text: 'PPP authentication failed, closing the link; last failure: the response does not match' }],
      ['r2/Serial0/0/0', { short: '[D]·E·A✗·N', text: 'PPP authentication failed, link dead' }],
    ]);
    expect(wanLinkFacts(failed).get('s1')?.short).toBe('PPP A✗');
    const coming = buildWanOverlay(pppPair({ phase: 'establish', lcp: 'req-sent', ipcp: 'initial', ...UNSET }, { phase: 'establish', lcp: 'ack-sent', ipcp: 'initial', ...UNSET }));
    expect(wanLinkFacts(coming).get('s1')).toEqual({ short: 'PPP D·[E]·A·N', text: 'r1 Serial0/0/0: PPP establishing the link; r2 Serial0/0/0: PPP establishing the link' });
  });

  it('says each GRE tunnel end and each router with a tunnel', () => {
    const model = buildWanOverlay(sites({}, {}));
    const name = (id: string): string => id.toUpperCase();
    expect([...wanPortFacts(model, name)]).toEqual([
      ['r1/Tunnel0', { short: 'Tu0 GRE 172.16.0.0/30', text: 'GRE tunnel Tu0 to 209.165.200.230 (R2), up, IP MTU 1476, subnet 172.16.0.0/30' }],
      ['r2/Tunnel0', { short: 'Tu0 GRE 172.16.0.0/30', text: 'GRE tunnel Tu0 to 209.165.200.225 (R1), up, IP MTU 1476, subnet 172.16.0.0/30' }],
    ]);
    expect([...wanDeviceFacts(model, name)]).toEqual([
      ['r1', { short: 'Tu0 GRE', text: 'GRE tunnel Tu0 toward R2, up' }],
      ['r2', { short: 'Tu0 GRE', text: 'GRE tunnel Tu0 toward R1, up' }],
    ]);
    expect(wanLinkFacts(model).size).toBe(0);
  });

  it('says why a tunnel is down, toward a device or an address no device holds', () => {
    const lone = buildWanOverlay(sites({ state: 'down', reason: 'no-route' }, null));
    expect([...wanPortFacts(lone)]).toEqual([
      ['r1/Tunnel0', { short: 'Tu0 GRE 172.16.0.0/30 ✗', text: 'GRE tunnel Tu0 to 209.165.200.230 (r2), down: no route to the tunnel destination, IP MTU 1476, subnet 172.16.0.0/30' }],
    ]);
    expect([...wanDeviceFacts(lone)]).toEqual([['r1', { short: 'Tu0 GRE ✗', text: 'GRE tunnel Tu0 toward r2, down' }]]);
    const nowhere = buildWanOverlay(sites({ destination: '198.51.100.9', state: 'down', reason: 'no-route' }, null));
    expect(wanPortFacts(nowhere).get('r1/Tunnel0')?.text).toBe('GRE tunnel Tu0 to 198.51.100.9, down: no route to the tunnel destination, IP MTU 1476, subnet 172.16.0.0/30');
    expect(wanDeviceFacts(nowhere).get('r1')).toEqual({ short: 'Tu0 GRE ✗', text: 'GRE tunnel Tu0 toward 198.51.100.9, down' });
    // the far end down while this end is up: the far end says its own reason
    const half = buildWanOverlay(sites({}, { state: 'down', reason: 'no-destination' }));
    const tube = half.tubes[0]!;
    expect(describeTunnelEnd(tube.b!, tube)).toBe('GRE tunnel Tu0 to 209.165.200.225 (r1), down: no tunnel destination, IP MTU 1476, subnet 172.16.0.0/30');
  });

  it('[C13] says an IPsec tunnel with its security association', () => {
    const up = buildWanOverlay(sites({ mode: 'ipsec', ipMtu: 1456 }, { mode: 'ipsec', ipMtu: 1456 }, { r1: {}, r2: {} }));
    expect([...wanPortFacts(up)]).toEqual([
      ['r1/Tunnel0', { short: 'Tu0 IPsec · established', text: 'IPsec tunnel Tu0 to 209.165.200.230 (r2), up, IP MTU 1456, subnet 172.16.0.0/30, security association established' }],
      ['r2/Tunnel0', { short: 'Tu0 IPsec · established', text: 'IPsec tunnel Tu0 to 209.165.200.225 (r1), up, IP MTU 1456, subnet 172.16.0.0/30, security association established' }],
    ]);
    expect(wanDeviceFacts(up).get('r1')).toEqual({ short: 'Tu0 IPsec', text: 'IPsec tunnel Tu0 toward r2, up' });
    const negotiating = buildWanOverlay(
      sites({ mode: 'ipsec', ipMtu: 1456, state: 'down', reason: 'ike-negotiating' }, { mode: 'ipsec', ipMtu: 1456, state: 'down', reason: 'ike-negotiating' }, {
        r1: { state: 'negotiating' },
      }),
    );
    expect(wanPortFacts(negotiating).get('r1/Tunnel0')).toEqual({
      short: 'Tu0 IPsec · negotiating ✗',
      text: 'IPsec tunnel Tu0 to 209.165.200.230 (r2), down: negotiating keys, IP MTU 1456, subnet 172.16.0.0/30, security association negotiating',
    });
    expect(wanPortFacts(negotiating).get('r2/Tunnel0')?.text).toBe(
      'IPsec tunnel Tu0 to 209.165.200.225 (r1), down: negotiating keys, IP MTU 1456, subnet 172.16.0.0/30, no security association yet',
    );
  });

  it('says nothing with the overlay off', () => {
    expect(wanPortFacts(null).size).toBe(0);
    expect(wanDeviceFacts(null).size).toBe(0);
    expect(wanLinkFacts(null).size).toBe(0);
  });
});
