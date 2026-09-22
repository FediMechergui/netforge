/**
 * ip.ipv4.nat-hooks — the two NAT hooks of protocols/ipv4.ts (ARCHITECTURE-P2 D14, §3.9 "Hooks (ipv4 side)") against
 * a FAKE nat daemon: `ip nat inside|outside` read from config deltas and at boot; a packet arriving on an outside
 * port goes to nat (`nat.inbound`) BEFORE the for-me test and continues at that test on `ipv4.resume`; a forwarded
 * packet from an inside port to an outside egress goes to nat (`nat.outbound`) after the TTL decrement instead of to
 * arp; every other path is exactly P1's, and so is everything when the model does not run nat. The last case runs a
 * real world (`test/p2.world.ts`) with the fake nat translating a ping.
 */
import { describe, expect, it } from 'vitest';
import type { ConfigDelta } from '../src/contracts/config.js';
import type { ProcessName } from '../src/contracts/ids.js';
import type { Pdu } from '../src/contracts/pdu.js';
import type { Action, Process, ProcessCtx, ProcessFactory, ProcessRequest } from '../src/contracts/process.js';
import { SEC } from '../src/contracts/time.js';
import { configText, section } from '../src/sim/scenarios/kit.js';
import { pcConfig } from '../src/sim/scenarios/templates.js';
import { createIpv4 } from '../src/protocols/ipv4.js';
import { echoRequest, framed, makeFake, makeSink } from './ip.fake-ctx.js';
import { P2_DAEMONS, createP2Simulation, type P2FactoryOverlay } from './p2.world.js';
import { ofKind, output } from './sim.harness.js';

const GI0 = 'GigabitEthernet0/0';
const GI1 = 'GigabitEthernet0/1';
const MAC_R0 = '00:1f:00:00:00:10';
const MAC_R1 = '00:1f:00:00:00:11';
const MAC_PC = '00:1f:00:00:00:01';
const MAC_SRV = '00:1f:00:00:00:02';
const MASK24 = '255.255.255.0';

const setAddr = (port: string, a: string, m: string): ConfigDelta => ({ op: 'set', context: [['interface', port]], line: ['ip', 'address', a, m] });
const natLine = (port: string, side: string, op: 'set' | 'unset' = 'set'): ConfigDelta => ({ op, context: [['interface', port]], line: ['ip', 'nat', side] });

/** A ctx whose model also runs `nat` (the fake's model is frozen; the prototype chain keeps its live getters). */
function withNat(ctx: ProcessCtx): ProcessCtx {
  const model = { ...ctx.model, processes: [...ctx.model.processes, 'nat' as ProcessName] };
  return Object.create(ctx, { model: { value: model, enumerable: true } }) as ProcessCtx;
}

/** Router: GI0 10.0.0.1/24 (inside), GI1 203.0.113.1/24 (outside). */
function natRouter(natInModel = true) {
  const fake = makeFake({ kind: 'router', ports: [{ id: GI0, mac: MAC_R0 }, { id: GI1, mac: MAC_R1 }] });
  const ctx = natInModel ? withNat(fake.ctx) : fake.ctx;
  const ipv4 = createIpv4();
  const arp = makeSink('arp');
  const nat = makeSink('nat');
  const icmp = makeSink('icmpv4');
  fake.register(ipv4);
  fake.register(arp);
  fake.register(nat);
  fake.register(icmp);
  fake.run(ipv4.onConfig(ctx, setAddr(GI0, '10.0.0.1', MASK24)));
  fake.run(ipv4.onConfig(ctx, setAddr(GI1, '203.0.113.1', MASK24)));
  arp.requests.length = 0;
  return { fake, ctx, ipv4, arp, nat, icmp };
}

describe('ip.ipv4.nat-hooks (D14)', () => {
  it('reads ip nat inside|outside from config deltas and shows the roles in its snapshot', () => {
    const { fake, ctx, ipv4 } = natRouter();
    expect(ipv4.onConfig(ctx, natLine(GI0, 'inside'))).toEqual([]);
    expect(ipv4.onConfig(ctx, natLine(GI1, 'outside'))).toEqual([]);
    expect(ipv4.stateSnapshot().state).toMatchObject({ nat: { [GI0]: 'inside', [GI1]: 'outside' } });
    expect(fake.debug.at(-1)!.message).toBe(`interface ${GI1} is a NAT outside interface`);
    ipv4.onConfig(ctx, natLine(GI1, 'outside', 'unset'));
    expect(ipv4.stateSnapshot().state).toMatchObject({ nat: { [GI0]: 'inside' } });
    ipv4.onConfig(ctx, natLine(GI0, 'inside', 'unset'));
    expect(ipv4.stateSnapshot().state).not.toHaveProperty('nat');
  });

  it('outbound: an inside → outside transit packet goes to nat after the TTL decrement, not to arp', () => {
    const { fake, ctx, ipv4, arp, nat } = natRouter();
    ipv4.onConfig(ctx, natLine(GI0, 'inside'));
    ipv4.onConfig(ctx, natLine(GI1, 'outside'));
    const pdu = fake.build(framed(MAC_R0, MAC_PC, echoRequest('10.0.0.10', '203.0.113.10', 1, 1, 128)));
    const actions = fake.run(ipv4.onPdu(ctx, pdu, GI0));
    expect(actions).toEqual([{ type: 'request', to: 'nat', req: { kind: 'nat.outbound', pdu, inPort: GI0, iface: GI1, nextHop: '203.0.113.10', cause: `connected via ${GI1}` } }]);
    expect(nat.requests).toHaveLength(1);
    expect(arp.requests).toEqual([]);
    expect(pdu.get('ipv4.ttl')).toBe(127);
    expect(pdu.provenance.map((m) => m.reason)).toEqual(['TtlDecrement', 'ChecksumRecompute', 'FcsRecompute']);
    expect(ipv4.stateSnapshot().state).toMatchObject({ forwarded: 1 });
    // inside → inside stays on the P1 path
    const local = fake.build(framed(MAC_R0, MAC_PC, echoRequest('10.0.0.10', '10.0.0.20', 1, 2, 128)));
    fake.run(ipv4.onPdu(ctx, local, GI0));
    expect(arp.requests).toEqual([{ kind: 'arp.sendVia', pdu: local, nextHop: '10.0.0.20', iface: GI0, cause: `connected via ${GI0}` }]);
    expect(nat.requests).toHaveLength(1);
  });

  it('inbound: a packet on an outside port goes to nat BEFORE the for-me test; ipv4.resume continues there and is never handed to nat again', () => {
    const { fake, ctx, ipv4, arp, nat, icmp } = natRouter();
    ipv4.onConfig(ctx, natLine(GI0, 'inside'));
    ipv4.onConfig(ctx, natLine(GI1, 'outside'));
    // addressed to the router's own outside address (PAT on the interface): still nat first
    const own = fake.build(framed(MAC_R1, MAC_SRV, echoRequest('203.0.113.10', '203.0.113.1', 7, 1, 64)));
    const first = fake.run(ipv4.onPdu(ctx, own, GI1));
    expect(first).toEqual([{ type: 'request', to: 'nat', req: { kind: 'nat.inbound', pdu: own, inPort: GI1 } }]);
    expect(icmp.pdus).toEqual([]);
    // nat answers with the packet untranslated: delivered locally
    const resumed = fake.run(ipv4.onRequest!(ctx, { kind: 'ipv4.resume', pdu: own, inPort: GI1 }));
    expect(resumed).toEqual([{ type: 'deliver', to: 'icmpv4', pdu: own, port: GI1 }]);
    expect(nat.requests).toHaveLength(1);
    expect(ipv4.stateSnapshot().state).toMatchObject({ delivered: 1 });
    // nat translated the destination to an inside host: resumed and forwarded to the inside port through arp
    const back = fake.build(framed(MAC_R1, MAC_SRV, echoRequest('203.0.113.10', '203.0.113.1', 7, 2, 64)));
    fake.run(ipv4.onPdu(ctx, back, GI1));
    ctx.mutate(back, 'ipv4.dst', '10.0.0.10', 'NatTranslate', 'ip nat inside source list 1 interface GigabitEthernet0/1 overload');
    const forwarded = fake.run(ipv4.onRequest!(ctx, { kind: 'ipv4.resume', pdu: back, inPort: GI1 }));
    expect(forwarded).toEqual([{ type: 'request', to: 'arp', req: { kind: 'arp.sendVia', pdu: back, nextHop: '10.0.0.10', iface: GI0, cause: `connected via ${GI0}` } }]);
    expect(back.get('ipv4.ttl')).toBe(63);
    expect(nat.requests.filter((r) => r.kind === 'nat.inbound')).toHaveLength(2);
    expect(nat.requests.filter((r) => r.kind === 'nat.outbound')).toHaveLength(0);
    expect(arp.requests).toHaveLength(1);
    const msgs = fake.debug.filter((d) => d.category === 'ip packet').map((d) => d.message);
    expect(msgs.some((m) => m.startsWith('resume 203.0.113.10 > 10.0.0.10'))).toBe(true);
  });

  it('without the nat daemon in the model the lines are stored but every path is P1: no request ever reaches nat', () => {
    const { fake, ctx, ipv4, arp, nat, icmp } = natRouter(false);
    ipv4.onConfig(ctx, natLine(GI0, 'inside'));
    ipv4.onConfig(ctx, natLine(GI1, 'outside'));
    expect(ipv4.stateSnapshot().state).toMatchObject({ nat: { [GI0]: 'inside', [GI1]: 'outside' } });
    const out = fake.build(framed(MAC_R0, MAC_PC, echoRequest('10.0.0.10', '203.0.113.10', 1, 1, 128)));
    fake.run(ipv4.onPdu(ctx, out, GI0));
    expect(arp.requests).toEqual([{ kind: 'arp.sendVia', pdu: out, nextHop: '203.0.113.10', iface: GI1, cause: `connected via ${GI1}` }]);
    const inn = fake.build(framed(MAC_R1, MAC_SRV, echoRequest('203.0.113.10', '203.0.113.1', 7, 1, 64)));
    fake.run(ipv4.onPdu(ctx, inn, GI1));
    expect(icmp.pdus).toEqual([inn]);
    expect(nat.requests).toEqual([]);
  });

  it('boot replay picks the roles up from the running config', () => {
    const fake = makeFake({ kind: 'router', ports: [{ id: GI0, mac: MAC_R0 }, { id: GI1, mac: MAC_R1 }] });
    fake.ctx.config.set([['interface', GI0]], ['ip', 'nat', 'inside']);
    fake.ctx.config.set([['interface', GI0]], ['ip', 'address', '10.0.0.1', MASK24]);
    fake.ctx.config.set([['interface', GI1]], ['ip', 'nat', 'outside']);
    fake.ctx.config.set([['interface', GI1]], ['ip', 'address', '203.0.113.1', MASK24]);
    const ctx = withNat(fake.ctx);
    const ipv4 = createIpv4();
    fake.register(ipv4);
    fake.register(makeSink('arp'));
    const nat = makeSink('nat');
    fake.register(nat);
    fake.run(ipv4.init!(ctx));
    expect(ipv4.stateSnapshot().state).toMatchObject({ nat: { [GI0]: 'inside', [GI1]: 'outside' }, interfaces: [{ port: GI0 }, { port: GI1 }] });
    const pdu = fake.build(framed(MAC_R0, MAC_PC, echoRequest('10.0.0.10', '203.0.113.10', 1, 1, 128)));
    fake.run(ipv4.onPdu(ctx, pdu, GI0));
    expect(nat.requests).toEqual([{ kind: 'nat.outbound', pdu, inPort: GI0, iface: GI1, nextHop: '203.0.113.10', cause: `connected via ${GI1}` }]);
  });
});

// ── a real world with a fake nat that translates a ping ─────────────────────

/** A tiny nat: rewrites the source of every outbound packet to the outside address and undoes it on the way back. */
function fakeNat(outside: string, insideHost: string): ProcessFactory {
  return (): Process => ({
    name: 'nat',
    onPdu: () => [],
    onTimer: () => [],
    onConfig: () => [],
    onRequest(ctx: ProcessCtx, req: ProcessRequest): Action[] {
      if (req.kind === 'nat.outbound') {
        ctx.mutate(req.pdu, 'ipv4.src', outside, 'NatTranslate', 'ip nat inside source list 1 interface GigabitEthernet0/1 overload');
        return [{ type: 'request', to: 'arp', req: { kind: 'arp.sendVia', pdu: req.pdu, nextHop: req.nextHop, iface: req.iface, cause: req.cause ?? 'nat' } }];
      }
      if (req.kind === 'nat.inbound') {
        const pdu: Pdu = req.pdu;
        if (pdu.get('ipv4.dst') === outside && pdu.layer('icmpv4')?.fields.type === 0) {
          ctx.mutate(pdu, 'ipv4.dst', insideHost, 'NatTranslate', 'ip nat inside source list 1 interface GigabitEthernet0/1 overload');
        }
        return [{ type: 'request', to: 'ipv4', req: { kind: 'ipv4.resume', pdu, inPort: req.inPort } }];
      }
      return [];
    },
    stateSnapshot: () => ({ process: 'nat', state: {} }),
    debugEvents: () => [],
  });
}

function overlay(nat: ProcessFactory | undefined): P2FactoryOverlay {
  const out: Record<ProcessName, ProcessFactory | undefined> = {};
  for (const p of P2_DAEMONS) out[p] = undefined;
  out['nat'] = nat;
  return out;
}

/** PC1 10.0.0.10 — R1 (Gi0/0 10.0.0.1 inside, Gi0/1 203.0.113.1 outside) — SRV 203.0.113.10. */
function natWorld(nat: ProcessFactory | undefined) {
  const sim = createP2Simulation({ seed: 5, profile: 'P1', factories: overlay(nat) });
  sim.addDevice({ id: 'pc1', type: 'pc.nfpc', name: 'PC1', startupConfig: pcConfig('PC1', '10.0.0.10', MASK24, '10.0.0.1') });
  sim.addDevice({ id: 'srv', type: 'pc.nfpc', name: 'SRV', startupConfig: pcConfig('SRV', '203.0.113.10', MASK24, '203.0.113.1') });
  sim.addDevice({
    id: 'r1', type: 'router.nf2911', name: 'R1',
    startupConfig: configText([
      ['hostname R1'],
      section(`interface ${GI0}`, [`ip address 10.0.0.1 ${MASK24}`, 'ip nat inside', 'no shutdown']),
      section(`interface ${GI1}`, [`ip address 203.0.113.1 ${MASK24}`, 'ip nat outside', 'no shutdown']),
    ]),
  });
  sim.addLink({ id: 'l1', a: { device: 'pc1', port: 'GigabitEthernet0' }, b: { device: 'r1', port: GI0 } });
  sim.addLink({ id: 'l2', a: { device: 'r1', port: GI1 }, b: { device: 'srv', port: 'GigabitEthernet0' } });
  sim.runFor(60 * SEC);
  const cursor = sim.trace(0).next;
  const session = sim.cli.open('pc1', 'console');
  sim.cli.exec(session, 'ping 203.0.113.10');
  sim.runToIdle();
  const evs = sim.trace(cursor).events;
  return { sim, text: output(evs, session), evs };
}

describe('ip.ipv4.nat-hooks on a real world', () => {
  it('translates a ping through the fake nat: the server sees the outside address and the replies come back to PC1', () => {
    const { sim, text, evs } = natWorld(fakeNat('203.0.113.1', '10.0.0.10'));
    expect(sim.device('r1')!.processes.has('nat')).toBe(true);
    expect(text).toContain('Sent 5, received 5, lost 0');
    const requests = ofKind(evs, 'pduCreated').filter((e) => e.device === 'pc1' && e.pdu.tag?.startsWith('ping#'));
    expect(requests).toHaveLength(5);
    const first = sim.pdu(requests[0]!.pdu.id)!;
    expect(first.provenance.filter((m) => m.reason === 'NatTranslate').map((m) => [m.device, m.field, m.before, m.after])).toEqual([
      ['r1', 'ipv4.src', '10.0.0.10', '203.0.113.1'],
    ]);
    // at R1: the TTL decrement (with its derived records), then the translation, then the MAC rewrites of the send
    expect(first.provenance.filter((m) => m.device === 'r1').map((m) => m.reason)).toEqual([
      'TtlDecrement', 'ChecksumRecompute', 'FcsRecompute', 'NatTranslate', 'ChecksumRecompute', 'FcsRecompute', 'MacRewrite', 'FcsRecompute', 'MacRewrite', 'FcsRecompute',
    ]);
    const replies = ofKind(evs, 'pduCreated').filter((e) => e.device === 'srv' && e.pdu.tag === 'echo-reply');
    expect(replies).toHaveLength(5);
    const reply = sim.pdu(replies[0]!.pdu.id)!;
    expect(reply.provenance.filter((m) => m.reason === 'NatTranslate').map((m) => [m.field, m.before, m.after])).toEqual([['ipv4.dst', '203.0.113.1', '10.0.0.10']]);
    expect(reply.get('ipv4.dst')).toBe('10.0.0.10');
    // the server answered 203.0.113.1: no inside address ever reached it
    expect(sim.device('srv')!.tables.arp.rows().map((r) => r.ip)).toEqual(['203.0.113.1']);
  });

  it('with the same lines and no nat daemon the ping still works, untranslated (the P1 path)', () => {
    const { sim, text, evs } = natWorld(undefined);
    expect(sim.device('r1')!.processes.has('nat')).toBe(false);
    expect(text).toContain('Sent 5, received 5, lost 0');
    const requests = ofKind(evs, 'pduCreated').filter((e) => e.device === 'pc1' && e.pdu.tag?.startsWith('ping#'));
    expect(sim.pdu(requests[0]!.pdu.id)!.provenance.some((m) => m.reason === 'NatTranslate')).toBe(false);
  });
});
