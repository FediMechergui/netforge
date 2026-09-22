/**
 * W3 lag (ARCHITECTURE-P2 D10, §3.6 "Identities and costs", §3.7 step 7, §13 #31): the Port-channel cost follows
 * the bandwidth of the currently bundled members — two 1 G members cost 3, one lost costs 4, none leaves no cost —
 * and losing a member is a cost update only: the member's row goes `down`, no `l2Changed` signal is issued (the
 * runtime's link-change path recomputes the bundle and the rows already show the new set when spanning tree is
 * told), the bundle stays up, no CAM row of the bundle is flushed and flows rehash onto the member left.
 */
import { describe, expect, it } from 'vitest';
import { SPEED_100M, SPEED_10G, SPEED_1G } from '../src/contracts/port.js';
import { SEC } from '../src/contracts/time.js';
import { bundledMemberSpeeds, bundledMembersOf, channelCostOf } from '../src/protocols/etherchannel.js';
import { channelPathCost } from '../src/protocols/stp/cost.js';
import { GI1, GI2, PING_COUNT, PO1, lagFake, lagWorld, ping, signalsOf, types } from './lag.harness.js';

describe('channel cost helpers over the rows (fake ctx)', () => {
  it('2 x 1 G = 3; one member lost = 4; none = undefined; a 100 M pair = 12; a 10 G member alone = 2', () => {
    const f = lagFake();
    expect(channelCostOf(f.h.tables, f.h.ports, PO1)).toBeUndefined();
    f.group(GI1, 1, 'on');
    expect(bundledMemberSpeeds(f.h.tables, f.h.ports, PO1)).toEqual([SPEED_1G]);
    expect(channelCostOf(f.h.tables, f.h.ports, PO1)).toBe(4);
    f.group(GI2, 1, 'on');
    expect(bundledMemberSpeeds(f.h.tables, f.h.ports, PO1)).toEqual([SPEED_1G, SPEED_1G]);
    expect(channelCostOf(f.h.tables, f.h.ports, PO1)).toBe(3);
    // the member goes down: the rows say so, the cost recomputes, no signal is issued
    const down = f.d.onLinkChange!(f.h.ctx, GI2, false);
    expect(signalsOf(down)).toEqual([]);
    expect(types(down).every((t) => t === 'cancelTimer')).toBe(true);
    expect(f.row(GI2)).toMatchObject({ state: 'down' });
    expect(bundledMembersOf(f.h.tables, f.h.ports, PO1)).toEqual([GI1]);
    expect(channelCostOf(f.h.tables, f.h.ports, PO1)).toBe(4);
    // and back: the signal returns with the member
    const up = f.d.onLinkChange!(f.h.ctx, GI2, true);
    expect(signalsOf(up)).toEqual([{ type: 'l2Changed', what: 'channel', port: GI2 }]);
    expect(channelCostOf(f.h.tables, f.h.ports, PO1)).toBe(3);
    f.d.onLinkChange!(f.h.ctx, GI1, false);
    f.d.onLinkChange!(f.h.ctx, GI2, false);
    expect(channelCostOf(f.h.tables, f.h.ports, PO1)).toBeUndefined();
    // the pure table agrees with the aggregate rule
    expect(channelPathCost([SPEED_100M, SPEED_100M])).toBe(12);
    expect(channelPathCost([SPEED_10G])).toBe(2);
  });

  it('a member that is `bundled` in the rows but oper down in the port view is not counted', () => {
    const f = lagFake();
    f.group(GI1, 1, 'on');
    f.group(GI2, 1, 'on');
    f.h.setOper(GI2, false);
    expect(bundledMembersOf(f.h.tables, f.h.ports, PO1)).toEqual([GI1]);
    expect(channelCostOf(f.h.tables, f.h.ports, PO1)).toBe(4);
  });
});

describe('losing a member in the real world (§3.7 step 7)', () => {
  it('cutting Gi0/2: its rows go down, the bundle stays up, cost 3 -> 4, no bundle CAM flush, the ping still crosses', () => {
    const w = lagWorld({ sw1: { hostname: 'SW1', members: [[GI1, 'active'], [GI2, 'active']] }, sw2: { hostname: 'SW2', members: [[GI1, 'active'], [GI2, 'active']] } });
    w.sim.runFor(40 * SEC);
    expect(ping(w, 'pc1', '10.0.0.2')).toBe(PING_COUNT);
    const sw1 = w.sim.device('sw1')!;
    const sw2 = w.sim.device('sw2')!;
    expect(channelCostOf(sw1.tables, sw1.ports, PO1)).toBe(3);
    expect(sw1.tables.cam.rows().filter((r) => r.port === PO1).map((r) => r.mac)).toEqual([w.pcMac('pc2')]);
    const cutAt = w.sim.now;
    const before = w.events().length;
    w.sim.removeLink('l2');
    w.sim.runFor(60 * SEC);
    const since = w.events().slice(before);
    for (const dev of [sw1, sw2]) {
      expect(dev.tables.get('etherchannel')!.get(GI2)).toMatchObject({ state: 'down' });
      expect(dev.tables.get('etherchannel')!.get(GI1)).toMatchObject({ state: 'bundled' });
      expect(dev.port(PO1)!.operUp).toBe(true);
      expect(channelCostOf(dev.tables, dev.ports, PO1)).toBe(4);
      expect(bundledMembersOf(dev.tables, dev.ports, PO1)).toEqual([GI1]);
    }
    // no Port-channel1 CAM row was flushed by the loss, and no `channel` signal was issued for it
    expect(since.filter((e) => e.kind === 'tableExpire' && e.table === 'cam' && e.row.port === PO1)).toEqual([]);
    expect(sw1.tables.cam.rows().filter((r) => r.port === PO1).map((r) => r.mac)).toEqual([w.pcMac('pc2')]);
    expect(since.filter((e) => e.kind === 'portState' && e.port === PO1)).toEqual([]);
    expect(since.some((e) => e.kind === 'debug' && e.event.process === 'etherchannel' && e.event.fsm?.to === 'down' && e.event.fsm.port === GI2 && e.t >= cutAt)).toBe(true);
    // flows rehash onto Gi0/1
    const after = w.events().length;
    expect(ping(w, 'pc1', '10.0.0.2')).toBe(PING_COUNT);
    const frames = w.events().slice(after).filter((e) => e.kind === 'frameTx' && (e.from.device === 'sw1' || e.from.device === 'sw2') && (e.from.port === GI1 || e.from.port === GI2) && e.pdu.tag !== 'lacp');
    expect(frames.length).toBeGreaterThan(0);
    expect(frames.every((e) => e.kind === 'frameTx' && e.from.port === GI1)).toBe(true);
  });
});
