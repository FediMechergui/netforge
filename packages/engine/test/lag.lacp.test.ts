/**
 * W3 lag (ARCHITECTURE-P2 D10, §2.6 EtherchannelRow, §3.7 steps 2–4 and 8, §4.2 timers, §4.3 silence, §5.1): the
 * etherchannel daemon's LACP path — rows, the LACPDU and its actor state, the fast burst and the 3 s wait, bundling on
 * a partner in sync, the steady timers and partner ageing, the `l2Changed` signal, the transitions — on a fake ctx,
 * and the real two-switch world (active–passive bundles within 3 s of link-up, Port-channel1 up, the frames are
 * background LACPDUs, a P1-profile world without lines is silent).
 */
import { describe, expect, it } from 'vitest';
import { SLOW_PROTOCOLS_MAC } from '../src/contracts/pdu.js';
import { SEC } from '../src/contracts/time.js';
import { LACP_STATE_ACTIVITY, LACP_STATE_AGGREGATION, LACP_STATE_COLLECTING, LACP_STATE_DEFAULTED, LACP_STATE_DISTRIBUTING, LACP_STATE_SYNC } from '../src/pdu/codecs/lacp.js';
import { ETHERCHANNEL_DEBUG_CATEGORY, ETHERCHANNEL_PROCESS, PARTNER_NOT_READY, createEtherchannel } from '../src/protocols/etherchannel.js';
import { NO_LACP_PARTNER } from '../src/protocols/etherchannel/compat.js';
import { lacpActorState, lacpSystemMac, lacpTimerKey, parseLacpTimerKey, partnerInSync, readLacpPartner } from '../src/protocols/etherchannel/lacp.js';
import { readChannelGroups } from '../src/protocols/etherchannel/static.js';
import { GI1, GI2, PEER_SYSTEM, PO1, cancelsOf, channelWrites, lagFake, lagWorld, sendsOf, signalsOf, timersOf, types } from './lag.harness.js';

describe('pure LACP pieces', () => {
  it('actor state bits and the sync test', () => {
    expect(lacpActorState({ active: true, sync: true, bundled: false, partnerKnown: false })).toBe(LACP_STATE_ACTIVITY | LACP_STATE_AGGREGATION | LACP_STATE_SYNC | LACP_STATE_DEFAULTED);
    expect(lacpActorState({ active: false, sync: true, bundled: true, partnerKnown: true })).toBe(LACP_STATE_AGGREGATION | LACP_STATE_SYNC | LACP_STATE_COLLECTING | LACP_STATE_DISTRIBUTING);
    expect(partnerInSync(LACP_STATE_SYNC)).toBe(true);
    expect(partnerInSync(LACP_STATE_ACTIVITY | LACP_STATE_AGGREGATION)).toBe(false);
  });

  it('timer keys round-trip and unknown keys are refused', () => {
    expect(lacpTimerKey('lacp-fast', GI1)).toBe('lacp-fast:GigabitEthernet0/1');
    expect(parseLacpTimerKey('lacp-age:GigabitEthernet0/2')).toEqual({ kind: 'lacp-age', port: GI2 });
    expect(parseLacpTimerKey('pagp-age:GigabitEthernet0/2')).toBeUndefined();
    expect(parseLacpTimerKey('lacp-tx:')).toBeUndefined();
    expect(parseLacpTimerKey('nonsense')).toBeUndefined();
  });

  it('the system id is the base MAC: a virtual port (ordinal 0), else a port MAC with the ordinal octet cleared', () => {
    const f = lagFake();
    expect(lacpSystemMac(f.h.ctx.ports)).toBe(f.h.ports.get(PO1)!.mac);
    const g = lagFake({ bundles: [] });
    expect(lacpSystemMac(g.h.ctx.ports)).toBe('00:1f:00:00:01:00');
  });

  it('readChannelGroups reads every member line, ignores bad ones and Port-channel sections', () => {
    const f = lagFake();
    f.h.config.set([['interface', GI1]], ['channel-group', '1', 'mode', 'active']);
    f.h.config.set([['interface', GI2]], ['channel-group', '49', 'mode', 'active']);
    f.h.config.set([['interface', 'FastEthernet0/1']], ['channel-group', '2', 'mode', 'sideways']);
    f.h.config.set([['interface', PO1]], ['channel-group', '3', 'mode', 'on']);
    expect(readChannelGroups(f.h.config)).toEqual([{ port: GI1, group: 1, bundle: PO1, mode: 'active', protocol: 'lacp' }]);
  });
});

describe('the daemon on a fake ctx: silence, rows and the active member', () => {
  it('is silent without a channel-group line: no row, no action, no timer, no debug', () => {
    const f = lagFake();
    expect(f.d.name).toBe(ETHERCHANNEL_PROCESS);
    expect(f.d.handles).toBeUndefined();
    expect(f.d.init!(f.h.ctx)).toEqual([]);
    expect(f.d.onTimer(f.h.ctx, 'lacp-tx:GigabitEthernet0/1')).toEqual([]);
    expect(f.d.onLinkChange!(f.h.ctx, GI1, false)).toEqual([]);
    expect(f.line(GI1, 'switchport mode trunk')).toEqual([]);
    expect(f.h.tables.get('etherchannel')!.size).toBe(0);
    expect(f.h.debug).toEqual([]);
    expect(f.d.stateSnapshot()).toEqual({ process: 'etherchannel', state: { loadBalance: 'src-mac', bundles: [] } });
  });

  it('`channel-group 1 mode active` on an up port: a waiting row, one LACPDU at once and the 1 s fast timer', () => {
    const f = lagFake();
    const actions = f.group(GI1, 1, 'active');
    expect(types(actions)).toEqual(['send', 'timer']);
    expect(sendsOf(actions)).toEqual([[GI1, 'lacp']]);
    expect(timersOf(actions)).toEqual([['lacp-fast:GigabitEthernet0/1', 1 * SEC, undefined]]);
    expect(f.row(GI1)).toEqual({ key: GI1, port: GI1, group: 1, bundle: PO1, protocol: 'lacp', mode: 'active', state: 'waiting', updatedAt: 0 });
    const send = actions[0]!;
    if (send.type !== 'send') throw new Error('send expected');
    expect(send.pdu.meta.background).toBe(true);
    expect(send.pdu.layers.map((l) => l.proto)).toEqual(['ethernet', 'lacp']);
    expect(send.pdu.layers[0]!.fields.dst).toBe(SLOW_PROTOCOLS_MAC);
    expect(send.pdu.layers[0]!.fields.src).toBe(f.h.ports.get(GI1)!.mac);
    const lacp = send.pdu.layers[1]!.fields;
    expect(lacp.actorSystem).toBe(f.h.ports.get(PO1)!.mac);
    expect(lacp.actorKey).toBe(1);
    expect(lacp.actorPort).toBe(f.h.ports.get(GI1)!.ordinal);
    expect(lacp.actorState).toBe(lacpActorState({ active: true, sync: true, bundled: false, partnerKnown: false }));
    expect(lacp.partnerSystem).toBe('00:00:00:00:00:00');
    // the transition and the debug lines carry the §5.4 category
    const fsm = f.h.debug.map((e) => e.data?.fsm).filter((x) => x !== undefined);
    expect(fsm).toEqual([{ machine: 'lacp', subject: `${PO1} ${GI1}`, port: GI1, instance: 1, from: 'down', to: 'waiting', cause: 'channel group configured' }]);
    expect(f.h.debug.every((e) => e.category === ETHERCHANNEL_DEBUG_CATEGORY)).toBe(true);
    expect(f.d.stateSnapshot().state).toEqual({ loadBalance: 'src-mac', bundles: [{ bundle: PO1, group: 1, protocol: 'lacp', members: [{ port: GI1, mode: 'active', state: 'waiting' }] }] });
  });

  it('the fast burst: three LACPDUs one second apart, then individual with `no LACP partner` and the 30 s steady timer', () => {
    const f = lagFake();
    f.group(GI1, 1, 'active');
    const key = 'lacp-fast:GigabitEthernet0/1';
    f.h.setNow(1 * SEC);
    expect(types(f.d.onTimer(f.h.ctx, key))).toEqual(['send', 'timer']);
    f.h.setNow(2 * SEC);
    expect(types(f.d.onTimer(f.h.ctx, key))).toEqual(['send', 'timer']);
    f.h.setNow(3 * SEC);
    const gaveUp = f.d.onTimer(f.h.ctx, key);
    expect(types(gaveUp)).toEqual(['l2Changed', 'timer']);
    expect(signalsOf(gaveUp)).toEqual([{ type: 'l2Changed', what: 'channel', port: GI1 }]);
    expect(timersOf(gaveUp)).toEqual([['lacp-tx:GigabitEthernet0/1', 30 * SEC, true]]);
    expect(f.row(GI1)).toMatchObject({ state: 'individual', reason: NO_LACP_PARTNER, updatedAt: 3 * SEC });
    // the steady timer keeps sending so a partner configured later is found
    f.h.setNow(33 * SEC);
    const tick = f.d.onTimer(f.h.ctx, 'lacp-tx:GigabitEthernet0/1');
    expect(sendsOf(tick)).toEqual([[GI1, 'lacp']]);
    expect(timersOf(tick)).toEqual([['lacp-tx:GigabitEthernet0/1', 30 * SEC, true]]);
  });

  it('a partner in sync bundles the member: ageing armed, fast cancelled, steady armed, the signal, one LACPDU telling the partner', () => {
    const f = lagFake();
    f.group(GI1, 1, 'active');
    f.h.setNow(200_000_000);
    const pdu = f.lacpdu({ port: 7 });
    const actions = f.d.onPdu(f.h.ctx, pdu, GI1);
    expect(types(actions)).toEqual(['timer', 'cancelTimer', 'timer', 'l2Changed', 'send', 'consume']);
    expect(timersOf(actions)).toEqual([['lacp-age:GigabitEthernet0/1', 90 * SEC, true], ['lacp-tx:GigabitEthernet0/1', 30 * SEC, true]]);
    expect(cancelsOf(actions)).toEqual(['lacp-fast:GigabitEthernet0/1']);
    expect(f.row(GI1)).toEqual({
      key: GI1, port: GI1, group: 1, bundle: PO1, protocol: 'lacp', mode: 'active', state: 'bundled',
      partnerSystem: PEER_SYSTEM, partnerKey: 1, partnerPort: 7, updatedAt: 200_000_000,
    });
    const told = actions[4]!;
    if (told.type !== 'send') throw new Error('send expected');
    const lacp = told.pdu.layers[1]!.fields;
    expect(lacp.actorState).toBe(lacpActorState({ active: true, sync: true, bundled: true, partnerKnown: true }));
    expect(lacp.partnerSystem).toBe(PEER_SYSTEM);
    expect(lacp.partnerPort).toBe(7);
    const fsm = f.h.debug.map((e) => e.data?.fsm).filter((x) => x !== undefined).at(-1);
    expect(fsm).toEqual({ machine: 'lacp', subject: `${PO1} ${GI1}`, port: GI1, instance: 1, from: 'waiting', to: 'bundled', cause: 'LACP partner heard', pdu: pdu.id });
    // the same partner again: nothing changes, the ageing timer is re-armed, no answer from an active member
    const again = f.d.onPdu(f.h.ctx, f.lacpdu({ port: 7 }), GI1);
    expect(types(again)).toEqual(['timer', 'consume']);
    expect(timersOf(again)).toEqual([['lacp-age:GigabitEthernet0/1', 90 * SEC, true]]);
  });

  it('a partner whose sync bit is clear keeps the member waiting; ageing turns a bundled member individual', () => {
    const f = lagFake();
    f.group(GI1, 1, 'active');
    const waiting = f.d.onPdu(f.h.ctx, f.lacpdu({ sync: false }), GI1);
    expect(f.row(GI1)).toMatchObject({ state: 'waiting', reason: PARTNER_NOT_READY, partnerSystem: PEER_SYSTEM });
    expect(signalsOf(waiting)).toEqual([{ type: 'l2Changed', what: 'channel', port: GI1 }]);
    f.d.onPdu(f.h.ctx, f.lacpdu({ sync: true }), GI1);
    expect(f.row(GI1)).toMatchObject({ state: 'bundled' });
    expect(f.row(GI1)!.reason).toBeUndefined();
    f.h.setNow(95 * SEC);
    const aged = f.d.onTimer(f.h.ctx, 'lacp-age:GigabitEthernet0/1');
    expect(types(aged)).toEqual(['l2Changed']);
    expect(f.row(GI1)).toMatchObject({ state: 'individual', reason: NO_LACP_PARTNER });
    expect(f.row(GI1)!.partnerSystem).toBeUndefined();
  });

  it('`no channel-group` deletes the row, cancels the timers and signals; a changed group re-creates the row', () => {
    const f = lagFake();
    f.group(GI1, 1, 'active');
    f.d.onPdu(f.h.ctx, f.lacpdu(), GI1);
    const removed = f.group(GI1, 1, 'active', true);
    expect(types(removed)).toEqual(['cancelTimer', 'cancelTimer', 'cancelTimer', 'cancelTimer', 'l2Changed']);
    expect(f.h.tables.get('etherchannel')!.size).toBe(0);
    expect(f.h.kinds('tableExpire').map((e) => [e.table, e.key, e.reason])).toEqual([['etherchannel', GI1, 'cleared']]);
    f.h.addPort('Port-channel2', 0, { kind: 'virtual', role: 'channel' });
    f.h.config.set([], ['interface', 'Port-channel2']);
    f.group(GI1, 2, 'on');
    expect(f.row(GI1)).toMatchObject({ group: 2, bundle: 'Port-channel2', protocol: 'static', mode: 'on', state: 'bundled' });
  });

  it('init reconciles lines replayed before the daemon existed; a member whose port is down has a `down` row and no timer', () => {
    const f = lagFake();
    f.h.setOper(GI2, false);
    f.h.config.set([['interface', GI1]], ['channel-group', '1', 'mode', 'passive']);
    f.h.config.set([['interface', GI2]], ['channel-group', '1', 'mode', 'passive']);
    const d = createEtherchannel();
    const actions = d.init!(f.h.ctx);
    expect(types(actions)).toEqual(['timer']);
    expect(timersOf(actions)).toEqual([['lacp-wait:GigabitEthernet0/1', 3 * SEC, undefined]]);
    expect(f.row(GI1)).toMatchObject({ state: 'waiting', mode: 'passive' });
    expect(f.row(GI2)).toMatchObject({ state: 'down', mode: 'passive' });
    expect(d.init!(f.h.ctx)).toEqual([]);
    // link-up starts the wait; link-down forgets everything and signals nothing
    const up = d.onLinkChange!(f.h.ctx, GI2, true);
    expect(timersOf(up)).toEqual([['lacp-wait:GigabitEthernet0/2', 3 * SEC, undefined]]);
    expect(signalsOf(up)).toEqual([]);
    const down = d.onLinkChange!(f.h.ctx, GI2, false);
    expect(types(down)).toEqual(['cancelTimer', 'cancelTimer', 'cancelTimer', 'cancelTimer']);
    expect(f.row(GI2)).toMatchObject({ state: 'down' });
  });
});

describe('the passive member', () => {
  it('answers only: waits 3 s, then individual; a partner heard makes it bundled and it replies to every LACPDU', () => {
    const f = lagFake();
    const start = f.group(GI1, 1, 'passive');
    expect(types(start)).toEqual(['timer']);
    expect(timersOf(start)).toEqual([['lacp-wait:GigabitEthernet0/1', 3 * SEC, undefined]]);
    f.h.setNow(3 * SEC);
    const gaveUp = f.d.onTimer(f.h.ctx, 'lacp-wait:GigabitEthernet0/1');
    expect(types(gaveUp)).toEqual(['l2Changed']);
    expect(f.row(GI1)).toMatchObject({ state: 'individual', reason: NO_LACP_PARTNER });
    // a partner configured later is heard: bundled, and the reply carries the partner block
    f.h.setNow(40 * SEC);
    const heard = f.d.onPdu(f.h.ctx, f.lacpdu(), GI1);
    expect(types(heard)).toEqual(['timer', 'cancelTimer', 'l2Changed', 'send', 'consume']);
    expect(cancelsOf(heard)).toEqual(['lacp-wait:GigabitEthernet0/1']);
    expect(f.row(GI1)).toMatchObject({ state: 'bundled', partnerSystem: PEER_SYSTEM });
    const reply = heard[3]!;
    if (reply.type !== 'send') throw new Error('send expected');
    expect(reply.pdu.layers[1]!.fields.actorState).toBe(lacpActorState({ active: false, sync: true, bundled: true, partnerKnown: true }));
    // steady state: one reply per LACPDU, never a periodic send of its own
    const again = f.d.onPdu(f.h.ctx, f.lacpdu(), GI1);
    expect(types(again)).toEqual(['timer', 'send', 'consume']);
    expect(f.d.onTimer(f.h.ctx, 'lacp-tx:GigabitEthernet0/1')).toEqual([]);
  });
});

describe('frames the daemon refuses', () => {
  it('drops an LACPDU on a port without a channel group, a malformed one, and a non-LACP frame; nothing is bridged', () => {
    const f = lagFake();
    const stray = f.d.onPdu(f.h.ctx, f.lacpdu(), GI2);
    expect(stray.map((a) => a.type)).toEqual(['drop']);
    expect(stray[0]).toMatchObject({ type: 'drop', reason: 'not-for-me', detail: `${GI2} has no channel group`, port: GI2 });
    const arp = f.h.frame('00:1f:00:00:00:0a', 'ff:ff:ff:ff:ff:ff');
    expect(f.d.onPdu(f.h.ctx, arp, GI1)).toEqual([expect.objectContaining({ type: 'drop', reason: 'unsupported-protocol' })]);
    expect(readLacpPartner({ layers: [] })).toBeUndefined();
  });
});

describe('the real two-switch world (createP2Simulation)', () => {
  it('active–passive: both members bundled within 3 s of link-up, Port-channel1 up on both ends, LACPDUs are background', () => {
    const w = lagWorld({
      sw1: { hostname: 'SW1', members: [[GI1, 'active'], [GI2, 'active']] },
      sw2: { hostname: 'SW2', members: [[GI1, 'passive'], [GI2, 'passive']] },
    });
    w.sim.runFor(60 * SEC);
    const up1 = w.linkUpAt('l1');
    const up2 = w.linkUpAt('l2');
    expect(up1).toBeDefined();
    expect(up2).toBeDefined();
    for (const dev of ['sw1', 'sw2']) {
      for (const port of [GI1, GI2]) expect(w.row(dev, port)).toMatchObject({ state: 'bundled', bundle: PO1, group: 1, protocol: 'lacp' });
      expect(w.sim.device(dev)!.port(PO1)?.operUp).toBe(true);
      const bundledAt = channelWrites(w.events(), dev).filter((x) => x[2] === 'bundled');
      expect(bundledAt.map((x) => x[1]).sort()).toEqual([GI1, GI2]);
      for (const [t, key] of bundledAt) expect(t - (key === GI1 ? up1! : up2!)).toBeLessThanOrEqual(3 * SEC);
    }
    expect(w.row('sw1', GI1)!.partnerSystem).toBe(w.sim.device('sw2')!.port(PO1)!.mac);
    expect(w.row('sw2', GI2)!.partnerSystem).toBe(w.sim.device('sw1')!.port(PO1)!.mac);
    const lacpFrames = w.events().filter((e) => e.kind === 'frameTx' && e.pdu.tag === 'lacp');
    expect(lacpFrames.length).toBeGreaterThan(0);
    expect(lacpFrames.every((e) => e.kind === 'frameTx' && e.background === true)).toBe(true);
    // no LACPDU is ever bridged: none leaves on a PC-facing port
    expect(w.events().some((e) => e.kind === 'frameTx' && e.pdu.tag === 'lacp' && e.from.port === 'FastEthernet0/1')).toBe(false);
    expect(w.events().some((e) => e.kind === 'log' && e.message.includes('is not available'))).toBe(false);
    // still bundled after the 90 s ageing window: the steady exchange keeps both ends alive
    w.sim.runFor(120 * SEC);
    for (const dev of ['sw1', 'sw2']) for (const port of [GI1, GI2]) expect(w.row(dev, port)!.state).toBe('bundled');
    const snap = w.sim.device('sw1')!.stateSnapshots().find((s) => s.process === 'etherchannel')!;
    expect(snap.state).toEqual({ loadBalance: 'src-mac', bundles: [{ bundle: PO1, group: 1, protocol: 'lacp', members: [{ port: GI1, mode: 'active', state: 'bundled' }, { port: GI2, mode: 'active', state: 'bundled' }] }] });
  });

  it('two runs with the same seed are byte-identical', () => {
    const build = (): string => {
      const w = lagWorld({ seed: 5, sw1: { hostname: 'SW1', members: [[GI1, 'active'], [GI2, 'active']] }, sw2: { hostname: 'SW2', members: [[GI1, 'active'], [GI2, 'active']] } });
      w.sim.runFor(50 * SEC);
      return JSON.stringify([w.events(), w.sim.snapshot()]);
    };
    expect(build()).toBe(build());
  });

  it('a P1-profile world with the daemon present and no channel-group line is silent', () => {
    const w = lagWorld({ profile: 'P1', sw1: { hostname: 'SW1', members: [] }, sw2: { hostname: 'SW2', members: [] }, links: [[GI1, GI1]] });
    w.sim.runFor(120 * SEC);
    const ev = w.events();
    expect(w.sim.device('sw1')!.processes.has('etherchannel')).toBe(true);
    expect(ev.filter((e) => e.kind === 'tableWrite' && e.table === 'etherchannel')).toEqual([]);
    expect(ev.filter((e) => e.kind === 'debug' && e.event.process === 'etherchannel')).toEqual([]);
    expect(ev.filter((e) => e.kind === 'pduCreated' && e.process === 'etherchannel')).toEqual([]);
    expect(ev.filter((e) => e.kind === 'frameTx' && e.pdu.tag === 'lacp')).toEqual([]);
    expect(ev.some((e) => e.kind === 'log' && e.message.includes('is not available'))).toBe(false);
  });
});
