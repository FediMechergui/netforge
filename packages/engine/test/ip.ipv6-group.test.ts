/**
 * ip.ipv6-group — `ipv6.group` owner joins and the next-header-89 delivery OSPFv3 needs (ARCHITECTURE-P3C §2.4, §3.3
 * steps 2 and 8, §7 W2a l3): a join merges by (owner, group) into the port's `groups6` after the derived groups, so
 * ff02::5 / ff02::6 traffic is for this device; a leave restores the P1 list byte for byte; a join waits for IPv6 on
 * the port; next header 89 reaches ospfv3 through `IPV6_UPPER` only when the model runs it. Real device runtimes
 * (test/ip6.harness.ts); the ospfv3 daemon is a recorder appended to the router model.
 */
import { describe, expect, it } from 'vitest';
import { IPV6_ALL_NODES, IPV6_ALL_ROUTERS } from '../src/contracts/addr.js';
import type { Pdu } from '../src/contracts/pdu.js';
import type { ProcessRequest } from '../src/contracts/process.js';
import { MS, SEC } from '../src/contracts/time.js';
import { linkLocalFromMac, solicitedNodeMulticast } from '../src/core/addr6.js';
import { BOOT_NS, createWorld6, recorder, type Recorder, type World6 } from './ip6.harness.js';

const G0 = 'GigabitEthernet0/0';
const G1 = 'GigabitEthernet0/1';
const ALL_SPF = 'ff02::5';
const ALL_DR = 'ff02::6';

const ll = (w: World6, dev: string, port: string): string => linkLocalFromMac(w.dev(dev).port(port)!.mac);
const groups = (w: World6, dev: string, port: string): readonly string[] | undefined => w.dev(dev).port(port)!.l3.groups6;
const group = (op: 'join' | 'leave', iface: string, g: string, owner = 'ospfv3'): ProcessRequest => ({ kind: 'ipv6.group', op, iface, group: g, owner });

/** R1 Gi0/0 2001:db8:a::1 — R2 Gi0/0 2001:db8:a::2, both routing. `ospfv3` on R1's model when a recorder is given. */
function pair(ospfv3?: Recorder): World6 {
  const w = createWorld6(ospfv3 === undefined ? { seed: 4 } : { seed: 4, routerProcesses: ['ospfv3'], extra: { ospfv3: () => ospfv3 } });
  w.add('r1', 'router');
  w.add('r2', 'router');
  w.link({ device: 'r1', port: G0 }, { device: 'r2', port: G0 });
  w.runFor(BOOT_NS);
  w.global('r1', 'ipv6 unicast-routing');
  w.global('r2', 'ipv6 unicast-routing');
  w.iface('r1', G0, 'ipv6 address 2001:db8:a::1/64', 'no shutdown');
  w.iface('r2', G0, 'ipv6 address 2001:db8:a::2/64', 'no shutdown');
  w.runFor(3 * SEC);
  return w;
}

/** R2 sends a next-header-89 packet from its link-local address to `dst` out Gi0/0 (hop limit 1, as OSPFv3 does). */
function hello(w: World6, dst: string): Pdu {
  const pdu = w.build([
    { proto: 'ipv6', fields: { src: ll(w, 'r2', G0), dst, nextHeader: 89, hopLimit: 1 } },
    { proto: 'payload', fields: { data: new Uint8Array(16) } },
  ]);
  w.act('r2', 'ospfv3', [{ type: 'request', to: 'ipv6', req: { kind: 'ipv6.send', pdu, iface: G0 } }]);
  w.runFor(100 * MS);
  return pdu;
}

describe('ipv6.group: owner joins merged into groups6', () => {
  it('a join appends the group after the derived ones; the leave restores the P1 list exactly', () => {
    const w = pair();
    const before = groups(w, 'r1', G0);
    expect(before).toEqual([IPV6_ALL_NODES, IPV6_ALL_ROUTERS, solicitedNodeMulticast(ll(w, 'r1', G0)), solicitedNodeMulticast('2001:db8:a::1')]);
    w.request('r1', 'ipv6', group('join', G0, ALL_SPF));
    expect(groups(w, 'r1', G0)).toEqual([...before!, ALL_SPF]);
    // ff02::6 sorts after ff02::5 whatever the join order
    w.request('r1', 'ipv6', group('join', G0, ALL_DR));
    expect(groups(w, 'r1', G0)).toEqual([...before!, ALL_SPF, ALL_DR]);
    w.request('r1', 'ipv6', group('leave', G0, ALL_SPF));
    expect(groups(w, 'r1', G0)).toEqual([...before!, ALL_DR]);
    w.request('r1', 'ipv6', group('leave', G0, ALL_DR));
    expect(groups(w, 'r1', G0)).toEqual(before);
    // the other port and the peer are untouched
    expect(groups(w, 'r2', G0)).not.toContain(ALL_SPF);
  });

  it('merges by (owner, group): a group stays while any owner holds it; a repeated join or leave changes nothing', () => {
    const w = pair();
    const before = groups(w, 'r1', G0)!;
    w.request('r1', 'ipv6', group('join', G0, ALL_SPF, 'ospfv3'));
    w.request('r1', 'ipv6', group('join', G0, ALL_SPF, 'ospfv3'));
    w.request('r1', 'ipv6', group('join', G0, ALL_SPF, 'other'));
    expect(groups(w, 'r1', G0)).toEqual([...before, ALL_SPF]);
    w.request('r1', 'ipv6', group('leave', G0, ALL_SPF, 'ospfv3'));
    expect(groups(w, 'r1', G0)).toEqual([...before, ALL_SPF]);
    w.request('r1', 'ipv6', group('leave', G0, ALL_SPF, 'other'));
    w.request('r1', 'ipv6', group('leave', G0, ALL_SPF, 'other'));
    expect(groups(w, 'r1', G0)).toEqual(before);
  });

  it('a group already derived (ff02::1) is not listed twice; text is normalised', () => {
    const w = pair();
    const before = groups(w, 'r1', G0)!;
    w.request('r1', 'ipv6', group('join', G0, 'FF02::1'));
    expect(groups(w, 'r1', G0)).toEqual(before);
    w.request('r1', 'ipv6', group('join', G0, 'FF02:0::5'));
    expect(groups(w, 'r1', G0)).toEqual([...before, ALL_SPF]);
  });

  it('ignores a unicast group and an unknown interface', () => {
    const w = pair();
    const before = groups(w, 'r1', G0)!;
    w.request('r1', 'ipv6', group('join', G0, '2001:db8:a::9'));
    w.request('r1', 'ipv6', group('join', 'GigabitEthernet9/9', ALL_SPF));
    expect(groups(w, 'r1', G0)).toEqual(before);
    const lines = w.dev('r1').processes.get('ipv6')!.debugEvents().map((e) => e.message);
    expect(lines).toContain('ignored group 2001:db8:a::9 on GigabitEthernet0/0: not a multicast group');
    expect(lines).toContain('ignored group ff02::5 on GigabitEthernet9/9: unknown interface');
  });

  it('a join on a port without IPv6 waits, and applies when IPv6 starts there; it survives an address change', () => {
    const w = pair();
    w.request('r1', 'ipv6', group('join', G1, ALL_SPF));
    expect(groups(w, 'r1', G1)).toBeUndefined();
    w.iface('r1', G1, 'ipv6 address 2001:db8:b::1/64');
    expect(groups(w, 'r1', G1)).toContain(ALL_SPF);
    expect(groups(w, 'r1', G1)!.at(-1)).toBe(ALL_SPF);
    w.iface('r1', G1, 'ipv6 address 2001:db8:c::1/64');
    expect(groups(w, 'r1', G1)!.at(-1)).toBe(ALL_SPF);
  });
});

describe('next header 89 through IPV6_UPPER', () => {
  it('a joined ff02::5 packet reaches ospfv3 when the model runs it', () => {
    const rec = recorder('ospfv3');
    const w = pair(rec);
    w.request('r1', 'ipv6', group('join', G0, ALL_SPF));
    const pdu = hello(w, ALL_SPF);
    expect(rec.pdus.map((p) => p.id)).toEqual([pdu.id]);
    expect(w.kinds('drop').some((d) => d.pdu.id === pdu.id)).toBe(false);
    // a link-local unicast to R1 is delivered too
    const uni = hello(w, ll(w, 'r1', G0));
    expect(rec.pdus.map((p) => p.id)).toEqual([pdu.id, uni.id]);
  });

  it('without the join, ff02::5 is not for the router (multicast is never routed)', () => {
    const rec = recorder('ospfv3');
    const w = pair(rec);
    const pdu = hello(w, ALL_SPF);
    expect(rec.pdus).toEqual([]);
    expect(w.kinds('drop').find((d) => d.device === 'r1' && d.pdu.id === pdu.id)).toMatchObject({ reason: 'not-for-me' });
  });

  it('a device without ospfv3 keeps the P1 answer: unsupported-protocol', () => {
    const w = pair();
    const pdu = hello(w, ll(w, 'r1', G0));
    expect(w.kinds('drop').find((d) => d.device === 'r1' && d.pdu.id === pdu.id)).toMatchObject({
      reason: 'unsupported-protocol', detail: 'next header 89 has no listener',
    });
  });
});
