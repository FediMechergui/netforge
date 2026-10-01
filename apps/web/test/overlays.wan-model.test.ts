// [S18]/[S19]/[C13] The WAN overlay model (ARCHITECTURE-P3 §6, §3.9, §3.10, §3.13, §10.2 "overlays.wan-model"): the
// D·E·A·N rail from `ppp` rows, the tube from `tunnels` rows, the IPsec label and SA state word, and the encrypted-leg
// pulse that is static under reduced motion.
import { describe, expect, it } from 'vitest';
import type { DeviceSnapshot, IpsecSaRow, PortSnapshot, PppRow, TunnelRow } from '@netforge/engine';
import {
  ENCRYPTED_PULSE_MS,
  GRE_LEG_BADGE,
  PPP_RAIL_STEPS,
  buildWanOverlay,
  deriveDeviceWan,
  encryptedPulseAlpha,
  pppRail,
  tunnelLabel,
  tunnelLegStyle,
  tunnelReasonText,
} from '../src/canvas/overlays/wan-model.js';
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

const states = (steps: readonly { letter: string; state: string }[]): string[] => steps.map((s) => `${s.letter}:${s.state}`);

describe('the PPP rail (D·E·A·N from ppp rows)', () => {
  it('has the four RFC 1661 steps in order', () => {
    expect(PPP_RAIL_STEPS.map((s) => s.letter).join('·')).toBe('D·E·A·N');
  });

  it('fills to N ✓ with the peer address once IPCP is open (§3.9 step 5)', () => {
    const model = buildWanOverlay(pppPair({}));
    expect(model.rails).toHaveLength(2);
    const r1 = model.rails[0]!;
    expect(r1).toMatchObject({ device: 'r1', port: 'Serial0/0/0', link: 's1', end: 'a', phase: 'network', open: true, authFailed: false, label: 'N ✓ 10.1.1.2' });
    expect(states(r1.steps)).toEqual(['D:done', 'E:done', 'A:done', 'N:done']);
    expect(r1.words).toBe('PPP open, peer 10.1.1.2');
    expect(model.rails[1]).toMatchObject({ device: 'r2', end: 'b', label: 'N ✓ 10.1.1.1' });
  });

  it('lights the current phase while the link comes up', () => {
    expect(states(pppRail(pppRow('S', { phase: 'dead', lcp: 'initial', ipcp: 'initial', authLocalState: undefined, authPeerState: undefined })).steps)).toEqual([
      'D:current', 'E:todo', 'A:todo', 'N:todo',
    ]);
    const establishing = pppRail(pppRow('S', { phase: 'establish', lcp: 'req-sent', ipcp: 'initial', authLocalState: undefined, authPeerState: undefined }));
    expect(states(establishing.steps)).toEqual(['D:done', 'E:current', 'A:todo', 'N:todo']);
    expect(establishing).toMatchObject({ label: '', open: false, words: 'PPP establishing the link' });
    const auth = pppRail(pppRow('S', { phase: 'authenticate', ipcp: 'initial', authLocalState: 'pending', authPeerState: 'pending' }));
    expect(states(auth.steps)).toEqual(['D:done', 'E:done', 'A:current', 'N:todo']);
    const ncp = pppRail(pppRow('S', { phase: 'network', ipcp: 'req-sent', peerAddress: undefined }));
    expect(states(ncp.steps)).toEqual(['D:done', 'E:done', 'A:done', 'N:current']);
    expect(ncp.label).toBe('');
  });

  it('crosses the A when authentication fails (§3.9 step 6), and lights D while terminating', () => {
    const snap = pppPair(
      { phase: 'terminate', lcp: 'stopping', ipcp: 'initial', authLocalState: 'failed', failures: 1, lastFailure: 'the response does not match' },
      { phase: 'dead', lcp: 'stopped', ipcp: 'initial', authPeerState: 'failed', failures: 1 },
    );
    const [r1, r2] = buildWanOverlay(snap).rails;
    expect(states(r1!.steps)).toEqual(['D:current', 'E:todo', 'A:failed', 'N:todo']);
    expect(r1).toMatchObject({ authFailed: true, open: false, label: '', lastFailure: 'the response does not match' });
    expect(r1!.words).toBe('PPP authentication failed, closing the link');
    expect(states(r2!.steps)).toEqual(['D:current', 'E:todo', 'A:failed', 'N:todo']);
  });

  it('skips the A when neither end asks for authentication', () => {
    const rail = pppRail(pppRow('S', { authLocal: 'none', authPeer: 'none', authLocalState: undefined, authPeerState: undefined }));
    expect(states(rail.steps)).toEqual(['D:done', 'E:done', 'A:skipped', 'N:done']);
    expect(rail.label).toBe('N ✓ 10.1.1.2');
  });
});

describe('the tunnel tube (tunnels rows)', () => {
  it('draws ONE tube between two routers whose GRE tunnels point at each other, labelled Tu0 GRE 172.16.0.0/30', () => {
    const model = buildWanOverlay(sites({}, {}));
    expect(model.tubes).toHaveLength(1);
    const tube = model.tubes[0]!;
    expect(tube).toMatchObject({ toward: 'r2', mode: 'gre', up: true, label: 'Tu0 GRE 172.16.0.0/30', lock: false, saWord: '', downText: '' });
    expect(tube.a).toMatchObject({ device: 'r1', port: 'Tunnel0', short: 'Tu0', subnet: '172.16.0.0/30', ipMtu: 1476, destination: '209.165.200.230' });
    expect(tube.b).toMatchObject({ device: 'r2', port: 'Tunnel0', destination: '209.165.200.225' });
    expect(tube.key).toBe('r1|Tunnel0~r2|Tunnel0');
    expect(tunnelLabel({ short: 'Tu1', mode: 'gre' })).toBe('Tu1 GRE');
  });

  it('says why a tube is down, and leaves the far end open when the peer has no tunnel', () => {
    const lone = buildWanOverlay(sites({ state: 'down', reason: 'no-route' }, null)).tubes;
    expect(lone).toHaveLength(1);
    expect(lone[0]).toMatchObject({ toward: 'r2', up: false, downText: 'no route to the tunnel destination' });
    expect(lone[0]?.b).toBeUndefined();
    const nowhere = buildWanOverlay(sites({ destination: '198.51.100.9', state: 'down', reason: 'no-route' }, null)).tubes[0]!;
    expect(nowhere.toward).toBeNull();
    const halfDown = buildWanOverlay(sites({}, { state: 'down', reason: 'no-destination' })).tubes[0]!;
    expect(halfDown).toMatchObject({ up: false, downText: 'no tunnel destination' });
    expect(tunnelReasonText(undefined)).toBe('');
    expect(tunnelReasonText('mystery')).toBe('mystery');
  });

  it('[C13] labels an ipsec-mode tube Tu0 IPsec with the padlock and the SA state word', () => {
    const up = buildWanOverlay(sites({ mode: 'ipsec', ipMtu: 1456 }, { mode: 'ipsec', ipMtu: 1456 }, { r1: {}, r2: {} })).tubes;
    expect(up).toHaveLength(1);
    expect(up[0]).toMatchObject({ mode: 'ipsec', label: 'Tu0 IPsec', lock: true, saWord: 'established', up: true });
    expect(up[0]?.a).toMatchObject({ sa: 'established', ipMtu: 1456 });

    const negotiating = buildWanOverlay(
      sites({ mode: 'ipsec', ipMtu: 1456, state: 'down', reason: 'ike-negotiating' }, { mode: 'ipsec', ipMtu: 1456, state: 'down', reason: 'ike-negotiating' }, {
        r1: { state: 'negotiating' },
      }),
    ).tubes[0]!;
    expect(negotiating).toMatchObject({ label: 'Tu0 IPsec', saWord: 'negotiating', up: false, downText: 'negotiating keys' });

    const failed = buildWanOverlay(
      sites({ mode: 'ipsec', state: 'down', reason: 'ike-failed' }, { mode: 'ipsec', state: 'down', reason: 'ike-failed' }, {
        r1: { state: 'failed', reason: 'ike-failed' },
        r2: { state: 'failed', reason: 'ike-failed' },
      }),
    ).tubes[0]!;
    expect(failed).toMatchObject({ saWord: 'failed', downText: 'key negotiation failed' });
    expect(failed.a).toMatchObject({ sa: 'failed', saReason: 'ike-failed' });
  });

  it('never pairs a GRE tunnel with an ipsec one, and reads no SA row for a GRE tunnel', () => {
    const tubes = buildWanOverlay(sites({ mode: 'gre' }, { mode: 'ipsec' }, { r1: {}, r2: {} })).tubes;
    expect(tubes.map((t) => [t.a.device, t.mode, t.b === undefined])).toEqual([
      ['r1', 'gre', true],
      ['r2', 'ipsec', true],
    ]);
    expect(tubes[0]?.a.sa).toBeUndefined();
  });
});

describe('legs through a tunnel', () => {
  it('badges a GRE leg with G and gives an IPsec leg the padlock and a pulse, static under reduced motion', () => {
    expect(GRE_LEG_BADGE).toBe('G');
    expect(tunnelLegStyle({ tunnel: 'gre' }, false)).toEqual({ badge: 'G', lock: false, pulse: false });
    expect(tunnelLegStyle({ tunnel: 'ipsec' }, false)).toEqual({ badge: '', lock: true, pulse: true });
    expect(tunnelLegStyle({ tunnel: 'ipsec' }, true)).toEqual({ badge: '', lock: true, pulse: false });
    expect(tunnelLegStyle({ tunnel: 'capwap' }, false)).toEqual({ badge: '', lock: false, pulse: false });
    expect(tunnelLegStyle({}, false)).toEqual({ badge: '', lock: false, pulse: false });
  });

  it('breathes between 0.55 and 1 over its period, and holds at 1 under reduced motion', () => {
    expect(encryptedPulseAlpha(0, false)).toBe(1);
    expect(encryptedPulseAlpha(ENCRYPTED_PULSE_MS / 2, false)).toBeCloseTo(0.55, 10);
    expect(encryptedPulseAlpha(ENCRYPTED_PULSE_MS, false)).toBe(1);
    for (let t = 0; t < 3 * ENCRYPTED_PULSE_MS; t += 97) {
      const a = encryptedPulseAlpha(t, false);
      expect(a).toBeGreaterThanOrEqual(0.55 - 1e-12);
      expect(a).toBeLessThanOrEqual(1 + 1e-12);
      expect(encryptedPulseAlpha(t, true)).toBe(1);
    }
  });
});

describe('per device', () => {
  it('reads nothing from a device without WAN rows, and derives each device once', () => {
    const pc = device('pc1', 0, 0, [port('Gi0')]);
    expect(deriveDeviceWan(pc)).toEqual({ ppp: [], tunnels: [], addresses: [] });
    expect(buildWanOverlay(snapshot([pc]))).toEqual({ rails: [], tubes: [] });
    const snap = sites({}, {});
    let calls = 0;
    buildWanOverlay(snap, (d) => {
      calls++;
      return deriveDeviceWan(d);
    });
    expect(calls).toBe(snap.devices.length);
  });
});
