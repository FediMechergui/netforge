/**
 * W3 lag (ARCHITECTURE-P2 D10, §3.7 steps 5–6, §4.5): egress over the Port-channel — `onEgress` picks one bundled,
 * link-up member by the W1 lag hash (`hash(method, frame) mod n` over the members in canonical port order), obeys
 * `port-channel load-balance`, drops with `Port-channel1 has no active member` when nothing is bundled; a member's
 * frames enter through the bundle; in the real world a PC's frames leave on the member `fold(mac) mod 2` and the
 * ping crosses the bundle.
 */
import { describe, expect, it } from 'vitest';
import { MAC_BROADCAST } from '../src/contracts/addr.js';
import type { MacAddress } from '../src/contracts/addr.js';
import type { PortId } from '../src/contracts/ids.js';
import { SEC } from '../src/contracts/time.js';
import { stpKey } from '../src/contracts/tables.js';
import type { StpPortRow } from '../src/contracts/tables.js';
import { bundledMembersOf, createEtherchannel } from '../src/protocols/etherchannel.js';
import { macFold, noActiveMemberDetail } from '../src/protocols/l2/lag-hash.js';
import { createStp } from '../src/protocols/stp.js';
import { FA1, GI1, GI2, PING_COUNT, PO1, dropsOf, lagFake, lagWorld, ping, sendsOf } from './lag.harness.js';

/** Two source MACs whose folds have different parity (checked by the test itself). */
const EVEN: MacAddress = '00:1f:00:00:00:0a'; // fold = 0x1f ^ 0x0a = 0x15 (21, odd) -> see the assertions
const ODD: MacAddress = '00:1f:00:00:00:0b';

describe('onEgress on a fake ctx', () => {
  it('hashes over the bundled members in canonical order, honours the load-balance line, drops with no member', () => {
    const f = lagFake();
    const pduA = f.h.frame(EVEN, MAC_BROADCAST);
    // nothing bundled yet: drop `other` with the §3.7 detail
    expect(dropsOf(f.d.onEgress!(f.h.ctx, pduA, PO1))).toEqual([['other', noActiveMemberDetail(PO1)]]);
    f.group(GI2, 1, 'on'); // configured first, but Gi0/1 sorts first (canonical port order)
    f.group(GI1, 1, 'on');
    expect(bundledMembersOf(f.h.tables, f.h.ports, PO1)).toEqual([GI1, GI2]);
    const pick = (src: MacAddress, dst: MacAddress = MAC_BROADCAST): PortId[] => sendsOf(f.d.onEgress!(f.h.ctx, f.h.frame(src, dst), PO1)).map((s) => s[0]);
    const members: PortId[] = [GI1, GI2];
    expect(macFold(EVEN) % 2).not.toBe(macFold(ODD) % 2);
    expect(pick(EVEN)).toEqual([members[macFold(EVEN) % 2]!]);
    expect(pick(ODD)).toEqual([members[macFold(ODD) % 2]!]);
    // dst-mac: the destination decides
    f.h.config.set([], ['port-channel', 'load-balance', 'dst-mac']);
    expect(pick(EVEN, ODD)).toEqual([members[macFold(ODD) % 2]!]);
    expect(pick(ODD, EVEN)).toEqual([members[macFold(EVEN) % 2]!]);
    // one member down: everything leaves on the other
    f.d.onLinkChange!(f.h.ctx, GI1, false);
    expect(bundledMembersOf(f.h.tables, f.h.ports, PO1)).toEqual([GI2]); // Gi0/1's row says down
    expect(pick(EVEN)).toEqual([GI2]);
    expect(pick(ODD)).toEqual([GI2]);
    f.d.onLinkChange!(f.h.ctx, GI2, false);
    expect(dropsOf(f.d.onEgress!(f.h.ctx, f.h.frame(EVEN, MAC_BROADCAST), PO1))).toEqual([['other', noActiveMemberDetail(PO1)]]);
    // a suspended member never carries traffic
    f.d.onLinkChange!(f.h.ctx, GI1, true);
    f.d.onLinkChange!(f.h.ctx, GI2, true);
    f.line(GI2, 'switchport access vlan 20');
    expect(f.row(GI2)!.state).toBe('suspended');
    expect(pick(EVEN)).toEqual([GI1]);
    expect(pick(ODD)).toEqual([GI1]);
    // the send action carries the very same PDU (no clone, no mutation)
    const pdu = f.h.frame(EVEN, MAC_BROADCAST);
    const out = f.d.onEgress!(f.h.ctx, pdu, PO1);
    expect(out).toEqual([{ type: 'send', port: GI1, pdu }]);
  });

  it('a second bundle hashes over its own members only', () => {
    const f = lagFake({ ports: [GI1, GI2, 'FastEthernet0/1', 'FastEthernet0/2'], bundles: [PO1, 'Port-channel2'] });
    f.group(GI1, 1, 'on');
    f.group('FastEthernet0/1', 2, 'on');
    f.group('FastEthernet0/2', 2, 'on');
    expect(bundledMembersOf(f.h.tables, f.h.ports, 'Port-channel2')).toEqual(['FastEthernet0/1', 'FastEthernet0/2']);
    expect(sendsOf(f.d.onEgress!(f.h.ctx, f.h.frame(EVEN, MAC_BROADCAST), PO1))).toEqual([[GI1, undefined]]);
    const po2 = sendsOf(f.d.onEgress!(f.h.ctx, f.h.frame(ODD, MAC_BROADCAST), 'Port-channel2'));
    expect(po2).toHaveLength(1);
    expect(po2[0]![0]).toMatch(/^FastEthernet0\/[12]$/);
    expect(createEtherchannel().stateSnapshot().state).toEqual({ loadBalance: 'src-mac', bundles: [] });
  });
});

describe('the real world: traffic over an LACP bundle', () => {
  it('a ping crosses the bundle; every frame of a PC leaves SW1 on the member fold(mac) mod 2; the bundle learns and forwards', () => {
    const w = lagWorld({ sw1: { hostname: 'SW1', members: [[GI1, 'active'], [GI2, 'active']] }, sw2: { hostname: 'SW2', members: [[GI1, 'passive'], [GI2, 'passive']] } });
    w.sim.runFor(40 * SEC);
    expect(w.row('sw1', GI1)!.state).toBe('bundled');
    expect(w.row('sw1', GI2)!.state).toBe('bundled');
    // the product path: a Port-channel carries Ethernet (device/ports.ts derives it from the bridged role trait)
    expect(w.sim.device('sw1')!.port(PO1)!.encap).toBe('ethernet');
    expect(w.sim.device('sw1')!.port(PO1)!.operUp).toBe(true);
    expect(ping(w, 'pc1', '10.0.0.2')).toBe(PING_COUNT);
    const members: PortId[] = [GI1, GI2];
    const pc1 = w.pcMac('pc1');
    const pc2 = w.pcMac('pc2');
    const expect1 = members[macFold(pc1) % 2]!;
    const expect2 = members[macFold(pc2) % 2]!;
    const fromPc1 = w.events().filter((e) => e.kind === 'frameTx' && e.from.device === 'sw1' && members.includes(e.from.port) && e.pdu.tag !== 'lacp');
    const fromPc2 = w.events().filter((e) => e.kind === 'frameTx' && e.from.device === 'sw2' && members.includes(e.from.port) && e.pdu.tag !== 'lacp');
    expect(fromPc1.length).toBeGreaterThan(0);
    expect(fromPc2.length).toBeGreaterThan(0);
    expect(fromPc1.every((e) => e.kind === 'frameTx' && e.from.port === expect1)).toBe(true);
    expect(fromPc2.every((e) => e.kind === 'frameTx' && e.from.port === expect2)).toBe(true);
    // both switches learned the far PC on the bundle, never on a member
    for (const [dev, mac] of [['sw1', pc2], ['sw2', pc1]] as const) {
      const rows = w.sim.device(dev)!.tables.cam.rows().filter((r) => r.mac === mac);
      expect(rows.map((r) => r.port)).toEqual([PO1]);
    }
    // a frame arriving on a member counts on the member and is bridged out of the far PC port
    expect(w.events().some((e) => e.kind === 'frameTx' && e.from.device === 'sw2' && e.from.port === 'FastEthernet0/1' && e.pdu.summary.includes('echo request'))).toBe(true);
  });

  it('`port-channel load-balance dst-mac` moves the choice to the destination', () => {
    const w = lagWorld({
      sw1: { hostname: 'SW1', members: [[GI1, 'active'], [GI2, 'active']], global: ['port-channel load-balance dst-mac'] },
      sw2: { hostname: 'SW2', members: [[GI1, 'active'], [GI2, 'active']] },
    });
    w.sim.runFor(40 * SEC);
    expect(ping(w, 'pc1', '10.0.0.2')).toBe(PING_COUNT);
    const members: PortId[] = [GI1, GI2];
    const pc2 = w.pcMac('pc2');
    const unicast = w.events().filter((e) => e.kind === 'frameTx' && e.from.device === 'sw1' && members.includes(e.from.port) && e.pdu.summary.includes('echo request'));
    expect(unicast.length).toBe(PING_COUNT);
    expect(unicast.every((e) => e.kind === 'frameTx' && e.from.port === members[macFold(pc2) % 2])).toBe(true);
    const snap = w.sim.device('sw1')!.stateSnapshots().find((s) => s.process === 'etherchannel')!;
    expect(snap.state).toMatchObject({ loadBalance: 'dst-mac' });
  });
});

describe('the real world: spanning tree over an LACP bundle (§3.7 steps 4–5)', () => {
  it('the stp table of a bundled switch lists Port-channel1 and not its members, and the ping still crosses', () => {
    const w = lagWorld({
      sw1: { hostname: 'SW1', members: [[GI1, 'active'], [GI2, 'active']] },
      sw2: { hostname: 'SW2', members: [[GI1, 'passive'], [GI2, 'passive']] },
      factories: { stp: createStp },
    });
    w.sim.runFor(120 * SEC);
    expect(w.row('sw1', GI1)!.state).toBe('bundled');
    expect(w.row('sw1', GI2)!.state).toBe('bundled');
    for (const dev of ['sw1', 'sw2']) {
      const stp = w.sim.device(dev)!.tables.get<StpPortRow>('stp')!;
      const ports = stp.rows().map((r) => r.port).sort();
      expect(ports, dev).toEqual([FA1, PO1]);
      expect(stp.get(stpKey(1, PO1))!.state).toBe('forwarding');
      expect(stp.get(stpKey(1, GI1))).toBeUndefined();
      expect(stp.get(stpKey(1, GI2))).toBeUndefined();
    }
    expect(ping(w, 'pc1', '10.0.0.2')).toBe(PING_COUNT);
  });
});
