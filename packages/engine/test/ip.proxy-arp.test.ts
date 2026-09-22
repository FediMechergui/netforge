/**
 * ip.proxy-arp [S7] — proxy ARP in protocols/arp.ts (ARCHITECTURE-P2 §5.2, D2, §7 W2 l3 [S7]): a routing device
 * answers a request on an L3 port for a target that is not on that port's subnet but reachable through another
 * interface, with the port's own MAC. The two-state read: a stored `no ip proxy-arp` on the interface means off; an
 * empty slot means the profile default (on in P2 for a routed interface of a routing device, off in P1). A typed
 * `ip proxy-arp` stores nothing, so in a P1 world it is a no-op. Routing switched off (`no ip routing`) stops it.
 */
import { describe, expect, it } from 'vitest';
import { MAC_ZERO } from '../src/contracts/addr.js';
import type { DefaultsProfile } from '../src/contracts/catalog.js';
import { ARP_OP_REPLY } from '../src/contracts/pdu.js';
import type { ProcessCtx } from '../src/contracts/process.js';
import { SEC } from '../src/contracts/time.js';
import { createArp, proxyArpEnabled } from '../src/protocols/arp.js';
import { pcConfig, routerConfig } from '../src/sim/scenarios/templates.js';
import { arpFrame, drops, makeHarness, sends, type Harness } from './arp.harness.js';
import { createP2Simulation } from './p2.world.js';
import { ofKind, ping } from './sim.harness.js';

const GI0 = 'GigabitEthernet0/0';
const GI1 = 'GigabitEthernet0/1';
const MAC_R0 = '00:1f:00:00:00:10';
const MAC_R1 = '00:1f:00:00:00:11';
const MAC_PC = '00:1f:00:00:00:01';

/** A ctx of `h` in the given profile (the harness itself spreads the P1 default). */
function inProfile(h: Harness, profile: DefaultsProfile): ProcessCtx {
  return Object.create(h.ctx, { profile: { value: profile, enumerable: true } }) as ProcessCtx;
}

/** A router with GI0 10.0.0.1/24 and GI1 10.0.1.1/24 (both connected in the RIB). */
function router(kind: 'router' | 'pc' = 'router') {
  const h = makeHarness({ kind, ports: [{ id: GI0, mac: MAC_R0, address: '10.0.0.1' }, { id: GI1, mac: MAC_R1, address: '10.0.1.1' }] });
  for (const [net, port] of [['10.0.0.0', GI0], ['10.0.1.0', GI1]] as const) {
    h.tables.rib.set({ key: `${net}/24`, network: net, prefixLen: 24, source: 'C', iface: port, ad: 0, metric: 0, updatedAt: 0 });
  }
  return h;
}

const request = (h: Harness, tpa: string) => arpFrame(h, { op: 'request', sha: MAC_PC, spa: '10.0.0.5', tha: MAC_ZERO, tpa });

describe('ip.proxy-arp [S7] two-state read', () => {
  it('reads: stored no ip proxy-arp → off; empty slot → the profile default for a routed interface of a routing device', () => {
    const h = router();
    expect(proxyArpEnabled(inProfile(h, 'P1'), GI0)).toBe(false);
    expect(proxyArpEnabled(inProfile(h, 'P2'), GI0)).toBe(true);
    expect(proxyArpEnabled(inProfile(h, 'P2'), GI1)).toBe(true);
    h.ctx.config.unset([['interface', GI0]], ['ip', 'proxy-arp']);
    expect(h.ctx.config.query(`interface.${GI0}.no`)[0]?.args).toEqual(['ip', 'proxy-arp']);
    expect(proxyArpEnabled(inProfile(h, 'P2'), GI0)).toBe(false);
    expect(proxyArpEnabled(inProfile(h, 'P2'), GI1)).toBe(true);
    // `ip proxy-arp` clears the slot and stores nothing: back to the profile default
    h.ctx.config.set([['interface', GI0]], ['ip', 'proxy-arp']);
    expect(h.ctx.config.query(`interface.${GI0}.no`)).toEqual([]);
    expect(h.ctx.config.get(`interface.${GI0}.ip.proxy-arp`)).toBeUndefined();
    expect(proxyArpEnabled(inProfile(h, 'P2'), GI0)).toBe(true);
    expect(proxyArpEnabled(inProfile(h, 'P1'), GI0)).toBe(false);
    // a device that does not route never proxies; an unknown interface neither
    expect(proxyArpEnabled(inProfile(router('pc'), 'P2'), GI0)).toBe(false);
    expect(proxyArpEnabled(inProfile(h, 'P2'), 'Nope')).toBe(false);
  });
});

describe('ip.proxy-arp [S7] answering', () => {
  it('P2 profile: answers for a target reachable through another interface with the port MAC and learns the requester', () => {
    const h = router();
    const ctx = inProfile(h, 'P2');
    const arp = createArp();
    const req = request(h, '10.0.1.7');
    const actions = arp.onPdu(ctx, req, GI0);
    const out = sends(actions);
    expect(out).toHaveLength(1);
    expect(out[0]!.port).toBe(GI0);
    expect(out[0]!.pdu.get('ethernet.src')).toBe(MAC_R0);
    expect(out[0]!.pdu.get('ethernet.dst')).toBe(MAC_PC);
    expect(out[0]!.pdu.layer('arp')!.fields).toMatchObject({ op: ARP_OP_REPLY, sha: MAC_R0, spa: '10.0.1.7', tha: MAC_PC, tpa: '10.0.0.5' });
    expect(out[0]!.pdu.meta).toMatchObject({ tag: 'arp-reply', triggeredBy: req.id });
    expect(actions.some((a) => a.type === 'consume')).toBe(true);
    expect(h.tables.arp.get('10.0.0.5')).toMatchObject({ mac: MAC_PC, iface: GI0 });
    expect(arp.stateSnapshot().state).toMatchObject({ repliesSent: 1, proxyRepliesSent: 1 });
    expect(h.debug.some((d) => d.message === `proxy reply to 10.0.0.5 for 10.0.1.7 on ${GI0}: reachable through ${GI1}`)).toBe(true);
    // a target on the requester's own subnet is never proxied, nor an unreachable one
    expect(sends(arp.onPdu(ctx, request(h, '10.0.0.7'), GI0))).toEqual([]);
    expect(sends(arp.onPdu(ctx, request(h, '192.168.9.9'), GI0))).toEqual([]);
    expect(drops(arp.onPdu(ctx, request(h, '192.168.9.9'), GI0))).toEqual([]);
    // a static route makes a remote target reachable through the other interface
    h.tables.rib.set({ key: '192.168.9.0/24', network: '192.168.9.0', prefixLen: 24, source: 'S', nextHop: '10.0.1.2', ad: 1, metric: 0, updatedAt: 0 });
    expect(sends(arp.onPdu(ctx, request(h, '192.168.9.9'), GI0))).toHaveLength(1);
    // a target reachable back through the same interface is not proxied
    h.tables.rib.set({ key: '192.168.8.0/24', network: '192.168.8.0', prefixLen: 24, source: 'S', nextHop: '10.0.0.2', ad: 1, metric: 0, updatedAt: 0 });
    expect(sends(arp.onPdu(ctx, request(h, '192.168.8.8'), GI0))).toEqual([]);
    expect(arp.stateSnapshot().state.proxyRepliesSent).toBe(2);
  });

  it('P1 profile: silent, and a typed ip proxy-arp changes nothing; the snapshot shows no proxy counter', () => {
    const h = router();
    const arp = createArp();
    expect(sends(arp.onPdu(h.ctx, request(h, '10.0.1.7'), GI0))).toEqual([]);
    expect(h.debug.at(-1)!.message).toBe(`request for 10.0.1.7 from 10.0.0.5 on ${GI0} is for another host`);
    h.ctx.config.set([['interface', GI0]], ['ip', 'proxy-arp']);
    expect(sends(arp.onPdu(h.ctx, request(h, '10.0.1.7'), GI0))).toEqual([]);
    expect(arp.stateSnapshot().state).toEqual({ pending: [], requestsSent: 0, repliesSent: 0, gratuitousSent: 0, resolved: 0, failed: 0 });
  });

  it('P2 profile: a stored no ip proxy-arp on the interface, or routing switched off, stops the proxy', () => {
    const h = router();
    const ctx = inProfile(h, 'P2');
    const arp = createArp();
    h.ctx.config.unset([['interface', GI0]], ['ip', 'proxy-arp']);
    expect(sends(arp.onPdu(ctx, request(h, '10.0.1.7'), GI0))).toEqual([]);
    h.ctx.config.set([['interface', GI0]], ['ip', 'proxy-arp']);
    expect(sends(arp.onPdu(ctx, request(h, '10.0.1.7'), GI0))).toHaveLength(1);
    h.ctx.config.unset([], ['ip', 'routing']);
    expect(sends(arp.onPdu(ctx, request(h, '10.0.1.7'), GI0))).toEqual([]);
    h.ctx.config.set([], ['ip', 'routing']);
    expect(sends(arp.onPdu(ctx, request(h, '10.0.1.7'), GI0))).toHaveLength(1);
    // a device that does not route (a PC) never proxies, whatever the profile
    const pc = router('pc');
    expect(sends(createArp().onPdu(inProfile(pc, 'P2'), request(pc, '10.0.1.7'), GI0))).toEqual([]);
  });
});

// ── a real world (test/p2.world.ts): a proxy reply for a target behind a recursive static ───────────────────────

describe('ip.proxy-arp [S7] on a real world', () => {
  it('answers for a target whose route resolves through another static line (the recursive D13 case)', () => {
    // PC1 (10.1.0.10/8, no gateway: it resolves every 10.x address itself) — R1 — R2 — PC2 (10.2.0.10/24).
    // R1 reaches 10.2.0.10 through a host route whose next hop 10.2.0.1 lies behind the /24 line.
    const sim = createP2Simulation({ seed: 9 });
    sim.addDevice({ id: 'pc1', type: 'pc.nfpc', name: 'PC1', startupConfig: pcConfig('PC1', '10.1.0.10', '255.0.0.0') });
    sim.addDevice({ id: 'pc2', type: 'pc.nfpc', name: 'PC2', startupConfig: pcConfig('PC2', '10.2.0.10', '255.255.255.0', '10.2.0.1') });
    sim.addDevice({
      id: 'r1', type: 'router.nf2911', name: 'R1',
      startupConfig: routerConfig(
        'R1',
        [{ port: GI0, address: '10.1.0.1', mask: '255.255.255.0' }, { port: GI1, address: '10.9.0.1', mask: '255.255.255.252' }],
        ['10.2.0.0 255.255.255.0 10.9.0.2', '10.2.0.10 255.255.255.255 10.2.0.1'],
      ),
    });
    sim.addDevice({
      id: 'r2', type: 'router.nf2911', name: 'R2',
      startupConfig: routerConfig(
        'R2',
        [{ port: GI0, address: '10.9.0.2', mask: '255.255.255.252' }, { port: GI1, address: '10.2.0.1', mask: '255.255.255.0' }],
        ['10.1.0.0 255.255.255.0 10.9.0.1'],
      ),
    });
    sim.addLink({ a: { device: 'pc1', port: 'GigabitEthernet0' }, b: { device: 'r1', port: GI0 } });
    sim.addLink({ a: { device: 'r1', port: GI1 }, b: { device: 'r2', port: GI0 } });
    sim.addLink({ a: { device: 'r2', port: GI1 }, b: { device: 'pc2', port: 'GigabitEthernet0' } });
    sim.runFor(90 * SEC);
    const r1 = sim.device('r1')!;
    expect(r1.tables.rib.get('10.2.0.10/32')).toMatchObject({ source: 'S', nextHop: '10.2.0.1' });

    const p = ping(sim, 'pc1', '10.2.0.10');
    expect(p.text).toContain('Sent 5, received 5, lost 0');
    // PC1 asked for 10.2.0.10 itself and R1 answered with the MAC of GI0
    expect(sim.device('pc1')!.tables.arp.get('10.2.0.10')).toMatchObject({ mac: r1.port(GI0)!.mac });
    const proxied = ofKind(p.evs, 'debug').filter((e) => e.event.device === 'r1' && e.event.message === `proxy reply to 10.1.0.10 for 10.2.0.10 on ${GI0}: reachable through ${GI1}`);
    expect(proxied).toHaveLength(1);
  });
});
