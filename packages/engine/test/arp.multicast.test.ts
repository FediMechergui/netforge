/**
 * arp.multicast — the IPv4-multicast framing rule of `arp.sendVia` (ARCHITECTURE-P3 D7, §3.0 (a) step 8; §7 W1 l3):
 * an IPv4 multicast next hop is never resolved and is framed to `01:00:5e` plus the low 23 bits of the group
 * (RFC 1112 §6.4). It sits after the HDLC branch (serial links are unchanged) and before the broadcast rule and
 * resolution: no ARP request, no cache row, no queue.
 */
import { describe, expect, it } from 'vitest';
import { MAC_BROADCAST } from '../src/contracts/addr.js';
import { EIGRP_GROUP, ETHERTYPE_IPV4, HDLC_PROTO_IPV4, IPPROTO_OSPF, OSPF_ALL_DROUTERS, OSPF_ALL_ROUTERS } from '../src/contracts/pdu.js';
import type { Pdu } from '../src/contracts/pdu.js';
import { createArp } from '../src/protocols/arp.js';
import { drops, forwardedFrame, makeHarness, sends, timers, type Harness } from './arp.harness.js';

const GI0 = 'GigabitEthernet0/0';
const SE0 = 'Serial0/0/0';
const MAC_R = '00:1f:00:00:00:10';
const MAC_SE = '00:1f:00:00:00:20';

function router(): Harness {
  return makeHarness({
    kind: 'router',
    ports: [
      { id: GI0, mac: MAC_R, address: '10.0.12.1', prefixLen: 24 },
      { id: SE0, mac: MAC_SE, address: '10.0.13.1', prefixLen: 30, kind: 'serial' },
    ],
  });
}

/** A locally originated OSPF-shaped packet to `dst` (no framing yet). */
function packet(h: Harness, dst: string): Pdu {
  return h.build([
    { proto: 'ipv4', fields: { src: '10.0.12.1', dst, protocol: IPPROTO_OSPF, ttl: 1, dscp: 48 } },
    { proto: 'payload', fields: { data: new Uint8Array(24) } },
  ]);
}

describe('arp.multicast: the IPv4-multicast framing rule (D7)', () => {
  it('frames 224.0.0.5 and 224.0.0.6 to 01:00:5e + the low 23 bits, from the port MAC, with no resolution', () => {
    const h = router();
    const arp = createArp();
    for (const [group, mac] of [[OSPF_ALL_ROUTERS, '01:00:5e:00:00:05'], [OSPF_ALL_DROUTERS, '01:00:5e:00:00:06'], [EIGRP_GROUP, '01:00:5e:00:00:0a']] as const) {
      const pdu = packet(h, group);
      const actions = arp.onRequest!(h.ctx, { kind: 'arp.sendVia', pdu, nextHop: group, iface: GI0, cause: 'ospf hello' });
      expect(actions).toEqual([{ type: 'send', port: GI0, pdu }]);
      expect(pdu.layers[0]!.proto).toBe('ethernet');
      expect(pdu.layer('ethernet')!.fields).toMatchObject({ dst: mac, src: MAC_R, type: ETHERTYPE_IPV4 });
      expect(pdu.provenance.at(-1)).toMatchObject({ reason: 'Encapsulate', cause: 'ospf hello' });
      expect(h.debug.at(-1)!.message).toBe(`sending to multicast group ${group} on ${GI0} (${mac})`);
    }
    expect(h.tables.arp.size).toBe(0);
    expect(arp.stateSnapshot().state).toEqual({ pending: [], requestsSent: 0, repliesSent: 0, gratuitousSent: 0, resolved: 0, failed: 0 });
  });

  it('keeps only the low 23 bits of the group (RFC 1112): 239.129.1.1 and 224.1.1.1 share 01:00:5e:01:01:01', () => {
    const h = router();
    const arp = createArp();
    for (const group of ['239.129.1.1', '224.1.1.1']) {
      const pdu = packet(h, group);
      arp.onRequest!(h.ctx, { kind: 'arp.sendVia', pdu, nextHop: group, iface: GI0 });
      expect(pdu.get('ethernet.dst')).toBe('01:00:5e:01:01:01');
    }
    const top = packet(h, '239.255.255.250');
    arp.onRequest!(h.ctx, { kind: 'arp.sendVia', pdu: top, nextHop: '239.255.255.250', iface: GI0 });
    expect(top.get('ethernet.dst')).toBe('01:00:5e:7f:ff:fa');
  });

  it('rewrites the MAC pair of a packet that already carries Ethernet framing', () => {
    const h = router();
    const arp = createArp();
    const pdu = forwardedFrame(h, '10.9.0.1', OSPF_ALL_ROUTERS, '00:aa:00:00:00:01', MAC_R);
    const actions = arp.onRequest!(h.ctx, { kind: 'arp.sendVia', pdu, nextHop: OSPF_ALL_ROUTERS, iface: GI0 });
    expect(sends(actions)).toHaveLength(1);
    expect(pdu.layers.filter((l) => l.proto === 'ethernet')).toHaveLength(1);
    expect(pdu.layer('ethernet')!.fields).toMatchObject({ dst: '01:00:5e:00:00:05', src: MAC_R });
  });

  it('the HDLC branch runs first: a multicast next hop on a serial link is HDLC-framed as before', () => {
    const h = router();
    const arp = createArp();
    const pdu = packet(h, OSPF_ALL_ROUTERS);
    const actions = arp.onRequest!(h.ctx, { kind: 'arp.sendVia', pdu, nextHop: OSPF_ALL_ROUTERS, iface: SE0 });
    expect(actions).toEqual([{ type: 'send', port: SE0, pdu }]);
    expect(pdu.layers[0]!.proto).toBe('hdlc');
    expect(pdu.layer('hdlc')!.fields).toMatchObject({ protocol: HDLC_PROTO_IPV4 });
    expect(pdu.layer('ethernet')).toBeUndefined();
    expect(h.debug.at(-1)!.message).toBe(`framing for ${OSPF_ALL_ROUTERS} on ${SE0}: serial HDLC link, no address resolution`);
  });

  it('a down port drops link-down; broadcast and unicast next hops keep their P1 paths', () => {
    const h = router();
    const arp = createArp();
    h.ports.get(GI0)!.operUp = false;
    const pdu = packet(h, OSPF_ALL_ROUTERS);
    expect(drops(arp.onRequest!(h.ctx, { kind: 'arp.sendVia', pdu, nextHop: OSPF_ALL_ROUTERS, iface: GI0 }))).toEqual([
      { type: 'drop', pdu, reason: 'link-down', detail: `${GI0} is down`, port: GI0 },
    ]);
    h.ports.get(GI0)!.operUp = true;
    const bcast = packet(h, '255.255.255.255');
    arp.onRequest!(h.ctx, { kind: 'arp.sendVia', pdu: bcast, nextHop: '255.255.255.255', iface: GI0 });
    expect(bcast.get('ethernet.dst')).toBe(MAC_BROADCAST);
    const uni = packet(h, '10.0.12.2');
    const actions = arp.onRequest!(h.ctx, { kind: 'arp.sendVia', pdu: uni, nextHop: '10.0.12.2', iface: GI0 });
    expect(actions.map((a) => a.type)).toEqual(['send', 'timer']);
    expect(timers(actions)).toHaveLength(1);
    expect(h.tables.arp.get('10.0.12.2')?.incomplete).toBe(true);
  });
});
