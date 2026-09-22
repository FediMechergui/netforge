/**
 * ip.ipv4.groups [S2] — joined IPv4 multicast groups (ARCHITECTURE-P2 D15, §2.4 `ipv4.group`): ipv4 merges
 * join/leave requests by (owner, group) per interface, writes `setPortL3 groups4` as the sorted unique list (`null`
 * when empty), and a packet to a group joined on its input port is for this device.
 */
import { describe, expect, it } from 'vitest';
import { createIpv4 } from '../src/protocols/ipv4.js';
import { echoRequest, framed, makeFake, makeSink } from './ip.fake-ctx.js';

const GI0 = 'GigabitEthernet0/0';
const GI1 = 'GigabitEthernet0/1';
const MAC_R0 = '00:1f:00:00:00:10';
const MAC_R1 = '00:1f:00:00:00:11';
const MAC_PC = '00:1f:00:00:00:01';
const HSRP_V2 = '224.0.0.102';
const HSRP_V1 = '224.0.0.2';
const MAC_GROUP = '01:00:5e:00:00:66';

function router() {
  const fake = makeFake({ kind: 'router', ports: [{ id: GI0, mac: MAC_R0, ipv4: { address: '10.0.0.1', prefixLen: 24 } }, { id: GI1, mac: MAC_R1, ipv4: { address: '10.0.1.1', prefixLen: 24 } }] });
  const ipv4 = createIpv4();
  const icmp = makeSink('icmpv4');
  const arp = makeSink('arp');
  fake.register(ipv4);
  fake.register(icmp);
  fake.register(arp);
  return { fake, ipv4, icmp, arp };
}

describe('ip.ipv4.groups [S2]', () => {
  it('join and leave write groups4 merged by (owner, group), sorted, unique, null when empty', () => {
    const { fake, ipv4 } = router();
    const join = (group: string, owner = 'hsrp', iface = GI0) => fake.run(ipv4.onRequest!(fake.ctx, { kind: 'ipv4.group', op: 'join', iface, group, owner }));
    const leave = (group: string, owner = 'hsrp', iface = GI0) => fake.run(ipv4.onRequest!(fake.ctx, { kind: 'ipv4.group', op: 'leave', iface, group, owner }));
    expect(join(HSRP_V2)).toEqual([{ type: 'setPortL3', port: GI0, groups4: [HSRP_V2] }]);
    expect(join(HSRP_V1)).toEqual([{ type: 'setPortL3', port: GI0, groups4: [HSRP_V1, HSRP_V2] }]);
    // a second owner of the same group: still one entry in the list
    expect(join(HSRP_V2, 'ext.other')).toEqual([{ type: 'setPortL3', port: GI0, groups4: [HSRP_V1, HSRP_V2] }]);
    expect(join(HSRP_V2)).toEqual([{ type: 'setPortL3', port: GI0, groups4: [HSRP_V1, HSRP_V2] }]);
    expect(ipv4.stateSnapshot().state).toMatchObject({ groups: { [GI0]: [{ owner: 'hsrp', group: HSRP_V1 }, { owner: 'ext.other', group: HSRP_V2 }, { owner: 'hsrp', group: HSRP_V2 }] } });
    // the group stays while another owner holds it
    expect(leave(HSRP_V2)).toEqual([{ type: 'setPortL3', port: GI0, groups4: [HSRP_V1, HSRP_V2] }]);
    expect(leave(HSRP_V2, 'ext.other')).toEqual([{ type: 'setPortL3', port: GI0, groups4: [HSRP_V1] }]);
    expect(leave(HSRP_V1)).toEqual([{ type: 'setPortL3', port: GI0, groups4: null }]);
    expect(ipv4.stateSnapshot().state).not.toHaveProperty('groups');
    // per interface
    expect(join(HSRP_V2, 'hsrp', GI1)).toEqual([{ type: 'setPortL3', port: GI1, groups4: [HSRP_V2] }]);
    // not a group, or an unknown interface: ignored
    expect(ipv4.onRequest!(fake.ctx, { kind: 'ipv4.group', op: 'join', iface: GI0, group: '10.0.0.9', owner: 'hsrp' })).toEqual([]);
    expect(ipv4.onRequest!(fake.ctx, { kind: 'ipv4.group', op: 'join', iface: 'Nope', group: HSRP_V2, owner: 'hsrp' })).toEqual([]);
  });

  it('a packet to a joined group is delivered locally on that port only; elsewhere multicast is dropped as before', () => {
    const { fake, ipv4, icmp } = router();
    fake.run(ipv4.onRequest!(fake.ctx, { kind: 'ipv4.group', op: 'join', iface: GI0, group: HSRP_V2, owner: 'hsrp' }));
    const hello = fake.build(framed(MAC_GROUP, MAC_PC, echoRequest('10.0.0.2', HSRP_V2, 1, 1, 1)));
    expect(fake.run(ipv4.onPdu(fake.ctx, hello, GI0))).toEqual([{ type: 'deliver', to: 'icmpv4', pdu: hello, port: GI0 }]);
    expect(icmp.pdus).toEqual([hello]);
    const elsewhere = fake.build(framed(MAC_GROUP, MAC_PC, echoRequest('10.0.1.2', HSRP_V2, 1, 1, 1)));
    expect(fake.run(ipv4.onPdu(fake.ctx, elsewhere, GI1))).toEqual([
      { type: 'drop', pdu: elsewhere, reason: 'not-for-me', detail: 'broadcast and multicast packets are never forwarded', port: GI1 },
    ]);
    fake.run(ipv4.onRequest!(fake.ctx, { kind: 'ipv4.group', op: 'leave', iface: GI0, group: HSRP_V2, owner: 'hsrp' }));
    const after = fake.build(framed(MAC_GROUP, MAC_PC, echoRequest('10.0.0.2', HSRP_V2, 1, 2, 1)));
    expect(fake.run(ipv4.onPdu(fake.ctx, after, GI0))[0]).toMatchObject({ type: 'drop', reason: 'not-for-me' });
    expect(ipv4.stateSnapshot().state).toMatchObject({ delivered: 1, dropped: 2 });
  });
});
