/**
 * arp.virtual — virtual IPv4 addresses (ARCHITECTURE-P2 D15, §2.4 `ipv4.virtual`, §7 W2 l3): ipv4 merges
 * `ipv4.virtual` requests by (owner, address), writes `setPortL3 virtual4` and announces a LOCAL address with the
 * widened gratuitous ARP; arp answers requests for a port's virtual addresses with the virtual MAC and sends the
 * widened announcement from that MAC; a packet to a local virtual address is for this device (ipv4 and the icmpv4
 * echo responder); `dot1q` counts as link framing.
 */
import { describe, expect, it } from 'vitest';
import { MAC_BROADCAST, MAC_ZERO } from '../src/contracts/addr.js';
import { ARP_OP_REPLY, ARP_OP_REQUEST } from '../src/contracts/pdu.js';
import type { PortL3 } from '../src/contracts/port.js';
import { LINK_FRAMING_PROTOS, createArp, leadingFramingLayers } from '../src/protocols/arp.js';
import { createIcmpv4 } from '../src/protocols/icmpv4.js';
import { createIpv4, virtualMacFor } from '../src/protocols/ipv4.js';
import { arpFrame, drops, makeHarness, sends } from './arp.harness.js';
import { echoRequest, framed, makeFake, makeSink } from './ip.fake-ctx.js';

const GI0 = 'GigabitEthernet0/0';
const GI1 = 'GigabitEthernet0/1';
const MAC_R0 = '00:1f:00:00:00:10';
const MAC_R1 = '00:1f:00:00:00:11';
const MAC_PC = '00:1f:00:00:00:01';
const VMAC = '00:00:0c:9f:f0:01';
const VIP = '10.0.0.100';

describe('arp.virtual answering (D15)', () => {
  it('answers a request for a virtual address of the port with the virtual MAC as sha and Ethernet source', () => {
    const h = makeHarness({ kind: 'router', ports: [{ id: GI0, mac: MAC_R0, address: '10.0.0.1' }] });
    h.ports.get(GI0)!.l3.virtual4 = [{ address: VIP, mac: VMAC, owner: 'hsrp', local: true }];
    const arp = createArp();
    arp.init!(h.ctx);
    const req = arpFrame(h, { op: 'request', sha: MAC_PC, spa: '10.0.0.5', tha: MAC_ZERO, tpa: VIP });
    const actions = arp.onPdu(h.ctx, req, GI0);
    const out = sends(actions);
    expect(out).toHaveLength(1);
    const reply = out[0]!.pdu;
    expect(reply.get('ethernet.src')).toBe(VMAC);
    expect(reply.get('ethernet.dst')).toBe(MAC_PC);
    expect(reply.layer('arp')!.fields).toMatchObject({ op: ARP_OP_REPLY, sha: VMAC, spa: VIP, tha: MAC_PC, tpa: '10.0.0.5' });
    expect(reply.meta.triggeredBy).toBe(req.id);
    expect(actions.some((a) => a.type === 'consume')).toBe(true);
    // the requester is learned, exactly as for the interface address
    expect(h.tables.arp.get('10.0.0.5')).toMatchObject({ mac: MAC_PC, iface: GI0 });
    expect(arp.stateSnapshot().state.repliesSent).toBe(1);
    expect(h.debug.some((d) => d.message === `request for virtual address ${VIP} from 10.0.0.5 (${MAC_PC}) on ${GI0}: replying from ${VMAC}`)).toBe(true);
    // the interface address still answers from the port MAC, and an unknown target is for another host
    const own = sends(arp.onPdu(h.ctx, arpFrame(h, { op: 'request', sha: MAC_PC, spa: '10.0.0.5', tha: MAC_ZERO, tpa: '10.0.0.1' }), GI0));
    expect(own[0]!.pdu.layer('arp')!.fields).toMatchObject({ sha: MAC_R0, spa: '10.0.0.1' });
    const other = arp.onPdu(h.ctx, arpFrame(h, { op: 'request', sha: MAC_PC, spa: '10.0.0.5', tha: MAC_ZERO, tpa: '10.0.0.200' }), GI0);
    expect(sends(other)).toEqual([]);
    expect(drops(other)).toEqual([]);
  });

  it('answers a non-local virtual address (a NAT pool address) too, and only on the port that carries it', () => {
    const h = makeHarness({ kind: 'router', ports: [{ id: GI0, mac: MAC_R0, address: '10.0.0.1' }, { id: GI1, mac: MAC_R1, address: '203.0.113.1' }] });
    h.ports.get(GI1)!.l3.virtual4 = [{ address: '203.0.113.5', mac: MAC_R1, owner: 'nat', local: false }];
    const arp = createArp();
    const yes = sends(arp.onPdu(h.ctx, arpFrame(h, { op: 'request', sha: MAC_PC, spa: '203.0.113.10', tha: MAC_ZERO, tpa: '203.0.113.5' }), GI1));
    expect(yes).toHaveLength(1);
    expect(yes[0]!.pdu.layer('arp')!.fields).toMatchObject({ sha: MAC_R1, spa: '203.0.113.5' });
    const no = sends(arp.onPdu(h.ctx, arpFrame(h, { op: 'request', sha: MAC_PC, spa: '10.0.0.5', tha: MAC_ZERO, tpa: '203.0.113.5' }), GI0));
    expect(no).toEqual([]);
    expect(virtualMacFor(h.ports.get(GI1), '203.0.113.5')).toBe(MAC_R1);
    expect(virtualMacFor(h.ports.get(GI0), '203.0.113.5')).toBeUndefined();
  });
});

describe('arp.virtual widened gratuitous ARP', () => {
  it('announces address/mac from the virtual MAC, keeps the interface announcement unchanged, and deduplicates per address', () => {
    const h = makeHarness({ kind: 'router', ports: [{ id: GI0, mac: MAC_R0, address: '10.0.0.1' }] });
    const arp = createArp();
    const virtual = sends(arp.onRequest!(h.ctx, { kind: 'arp.gratuitous', iface: GI0, address: VIP, mac: VMAC }));
    expect(virtual).toHaveLength(1);
    expect(virtual[0]!.port).toBe(GI0);
    expect(virtual[0]!.pdu.get('ethernet.src')).toBe(VMAC);
    expect(virtual[0]!.pdu.get('ethernet.dst')).toBe(MAC_BROADCAST);
    expect(virtual[0]!.pdu.layer('arp')!.fields).toMatchObject({ op: ARP_OP_REQUEST, sha: VMAC, spa: VIP, tha: MAC_ZERO, tpa: VIP });
    expect(virtual[0]!.pdu.meta.tag).toBe('arp-gratuitous');
    // the same instant: the virtual announcement is not repeated, the interface one is separate
    expect(sends(arp.onRequest!(h.ctx, { kind: 'arp.gratuitous', iface: GI0, address: VIP, mac: VMAC }))).toEqual([]);
    const plain = sends(arp.onRequest!(h.ctx, { kind: 'arp.gratuitous', iface: GI0 }));
    expect(plain).toHaveLength(1);
    expect(plain[0]!.pdu.layer('arp')!.fields).toMatchObject({ sha: MAC_R0, spa: '10.0.0.1', tpa: '10.0.0.1' });
    expect(arp.stateSnapshot().state.gratuitousSent).toBe(2);
    // with an address and no mac the port MAC is used
    h.setNow(1_000);
    const pool = sends(arp.onRequest!(h.ctx, { kind: 'arp.gratuitous', iface: GI0, address: '10.0.0.77' }));
    expect(pool[0]!.pdu.layer('arp')!.fields).toMatchObject({ sha: MAC_R0, spa: '10.0.0.77' });
    expect(h.debug.some((d) => d.message === `announcing ${VIP} is at ${VMAC} on ${GI0} (virtual address)`)).toBe(true);
  });

  it('dot1q is link framing: a tagged Ethernet frame has two framing layers', () => {
    expect(LINK_FRAMING_PROTOS).toContain('dot1q');
    expect(leadingFramingLayers({ layers: [{ proto: 'ethernet' }, { proto: 'dot1q' }, { proto: 'ipv4' }] } as never)).toBe(2);
    expect(leadingFramingLayers({ layers: [{ proto: 'ethernet' }, { proto: 'ipv4' }] } as never)).toBe(1);
  });
});

describe('arp.virtual ipv4.virtual requests (ipv4 is the single writer of virtual4)', () => {
  function router() {
    const fake = makeFake({ kind: 'router', ports: [{ id: GI0, mac: MAC_R0 }, { id: GI1, mac: MAC_R1 }] });
    const ipv4 = createIpv4();
    const arp = makeSink('arp');
    const icmp = makeSink('icmpv4');
    fake.register(ipv4);
    fake.register(arp);
    fake.register(icmp);
    fake.run(ipv4.onConfig(fake.ctx, { op: 'set', context: [['interface', GI0]], line: ['ip', 'address', '10.0.0.1', '255.255.255.0'] }));
    fake.run(ipv4.onConfig(fake.ctx, { op: 'set', context: [['interface', GI1]], line: ['ip', 'address', '10.0.1.1', '255.255.255.0'] }));
    arp.requests.length = 0;
    return { fake, ipv4, arp, icmp };
  }

  it('merges by (owner, address), orders by owner then address, announces local adds, and clears with null', () => {
    const { fake, ipv4, arp } = router();
    const add = (owner: string, address: string, mac: string, local: boolean) =>
      fake.run(ipv4.onRequest!(fake.ctx, { kind: 'ipv4.virtual', op: 'add', iface: GI0, address, mac, local, owner }));
    expect(add('nat', '10.0.0.50', MAC_R0, false)).toEqual([
      { type: 'setPortL3', port: GI0, virtual4: [{ address: '10.0.0.50', mac: MAC_R0, owner: 'nat', local: false }] },
    ]);
    expect(arp.requests).toEqual([]);
    expect(add('hsrp', VIP, VMAC, true)).toEqual([
      { type: 'setPortL3', port: GI0, virtual4: [{ address: VIP, mac: VMAC, owner: 'hsrp', local: true }, { address: '10.0.0.50', mac: MAC_R0, owner: 'nat', local: false }] },
      { type: 'request', to: 'arp', req: { kind: 'arp.gratuitous', iface: GI0, address: VIP, mac: VMAC } },
    ]);
    // the same (owner, address) again replaces the entry (a MAC change), never duplicates it
    expect(add('nat', '10.0.0.50', MAC_R1, false)[0]).toEqual({
      type: 'setPortL3', port: GI0, virtual4: [{ address: VIP, mac: VMAC, owner: 'hsrp', local: true }, { address: '10.0.0.50', mac: MAC_R1, owner: 'nat', local: false }],
    });
    // numeric address order inside one owner
    add('nat', '10.0.0.9', MAC_R0, false);
    expect(ipv4.stateSnapshot().state).toMatchObject({ virtual: { [GI0]: [{ address: VIP }, { address: '10.0.0.9' }, { address: '10.0.0.50' }] } });
    expect(fake.run(ipv4.onRequest!(fake.ctx, { kind: 'ipv4.virtual', op: 'remove', iface: GI0, address: '10.0.0.9', mac: MAC_R0, local: false, owner: 'nat' }))).toEqual([
      { type: 'setPortL3', port: GI0, virtual4: [{ address: VIP, mac: VMAC, owner: 'hsrp', local: true }, { address: '10.0.0.50', mac: MAC_R1, owner: 'nat', local: false }] },
    ]);
    fake.run(ipv4.onRequest!(fake.ctx, { kind: 'ipv4.virtual', op: 'remove', iface: GI0, address: '10.0.0.50', mac: MAC_R1, local: false, owner: 'nat' }));
    expect(fake.run(ipv4.onRequest!(fake.ctx, { kind: 'ipv4.virtual', op: 'remove', iface: GI0, address: VIP, mac: VMAC, local: true, owner: 'hsrp' }))).toEqual([
      { type: 'setPortL3', port: GI0, virtual4: null },
    ]);
    expect(ipv4.stateSnapshot().state).not.toHaveProperty('virtual');
    // unknown interface or address: ignored
    expect(ipv4.onRequest!(fake.ctx, { kind: 'ipv4.virtual', op: 'add', iface: 'Nope', address: VIP, mac: VMAC, local: true, owner: 'hsrp' })).toEqual([]);
    expect(ipv4.onRequest!(fake.ctx, { kind: 'ipv4.virtual', op: 'add', iface: GI0, address: 'x', mac: VMAC, local: true, owner: 'hsrp' })).toEqual([]);
  });

  it('a packet to a local virtual address is delivered locally and answered from it; a non-local one is routed as before', () => {
    const { fake, ipv4, arp, icmp } = router();
    fake.run(ipv4.onRequest!(fake.ctx, { kind: 'ipv4.virtual', op: 'add', iface: GI0, address: VIP, mac: VMAC, local: true, owner: 'hsrp' }));
    fake.run(ipv4.onRequest!(fake.ctx, { kind: 'ipv4.virtual', op: 'add', iface: GI1, address: '10.0.1.50', mac: MAC_R1, local: false, owner: 'nat' }));
    const toVip = fake.build(framed(VMAC, MAC_PC, echoRequest('10.0.0.5', VIP, 1, 1, 128)));
    expect(fake.run(ipv4.onPdu(fake.ctx, toVip, GI0))).toEqual([{ type: 'deliver', to: 'icmpv4', pdu: toVip, port: GI0 }]);
    expect(icmp.pdus).toEqual([toVip]);
    arp.requests.length = 0; // forget the announcement of the local virtual address
    // a non-local virtual address is not ours: it is routed (here: back out its connected interface)
    const toPool = fake.build(framed(MAC_R0, MAC_PC, echoRequest('10.0.0.5', '10.0.1.50', 1, 1, 128)));
    fake.run(ipv4.onPdu(fake.ctx, toPool, GI0));
    expect(arp.requests).toEqual([{ kind: 'arp.sendVia', pdu: toPool, nextHop: '10.0.1.50', iface: GI1, cause: `connected via ${GI1}` }]);
    // a local virtual address on a DOWN port is not ours
    fake.setOper(GI0, false);
    const down = fake.build(framed(VMAC, MAC_PC, echoRequest('10.0.0.5', VIP, 1, 2, 128)));
    expect(fake.run(ipv4.onPdu(fake.ctx, down, GI0))[0]).toMatchObject({ type: 'request', to: 'arp' });

    // the icmpv4 responder answers from the virtual address when the port view carries it
    fake.setOper(GI0, true);
    (fake.ctx.ports.get(GI0)!.l3 as PortL3).virtual4 = [{ address: VIP, mac: VMAC, owner: 'hsrp', local: true }];
    const responder = createIcmpv4();
    const echo = fake.build(framed(VMAC, MAC_PC, echoRequest('10.0.0.5', VIP, 3, 1, 128)));
    const actions = responder.onPdu(fake.ctx, echo, GI0);
    const send = actions.find((a) => a.type === 'request' && a.to === 'ipv4');
    expect(send).toBeDefined();
    const reply = (send as Extract<typeof actions[number], { type: 'request' }>).req as { kind: string; pdu: { get(f: string): unknown } };
    expect(reply.kind).toBe('ipv4.send');
    expect(reply.pdu.get('ipv4.src')).toBe(VIP);
    expect(reply.pdu.get('ipv4.dst')).toBe('10.0.0.5');
  });
});
