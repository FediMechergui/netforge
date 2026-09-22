/**
 * W3 lag (ARCHITECTURE-P2 §3.7 steps 8–9, §13 #25 and #32, §3.0 step 4): members without a partner run `individual`
 * (passive–passive, active against `on`); incompatible members are `suspended` with a reason naming the difference
 * (switchport view, speed, negotiated trunking mode, a partner unlike the rest of the bundle); a `mode on` member
 * ignores LACP; the real worlds of misconfigurations A and B.
 */
import { describe, expect, it } from 'vitest';
import { SPEED_100M } from '../src/contracts/port.js';
import type { DtpRow } from '../src/contracts/tables.js';
import { SEC } from '../src/contracts/time.js';
import { NO_LACP_PARTNER, compatibility, configDiffersReason, partnerDiffersReason, speedText, switchportDifference, trunkNegotiationReason } from '../src/protocols/etherchannel/compat.js';
import { staticIgnoresDetail } from '../src/protocols/etherchannel/static.js';
import { DEFAULT_SWITCHPORT } from '../src/contracts/port.js';
import { FA1, GI1, GI2, OTHER_SYSTEM, PEER_SYSTEM, PING_COUNT, PO1, channelWrites, dropsOf, lagFake, lagWorld, ping, signalsOf, types } from './lag.harness.js';

const dtpRow = (port: string, oper: DtpRow['oper']): DtpRow => ({ key: port, port, admin: 'dynamic-auto', oper, status: 'negotiated', updatedAt: 0 });

describe('the compatibility check (compat.ts)', () => {
  it('names the first difference of the switchport view in a fixed order', () => {
    const trunk = { ...DEFAULT_SWITCHPORT, mode: 'trunk' as const };
    expect(switchportDifference(DEFAULT_SWITCHPORT, DEFAULT_SWITCHPORT)).toBeUndefined();
    expect(switchportDifference({ ...DEFAULT_SWITCHPORT, mode: 'access' }, trunk)).toBe('switchport mode access vs trunk');
    expect(switchportDifference({ ...trunk, negotiate: false }, trunk)).toBe('nonegotiate vs negotiate');
    expect(switchportDifference({ ...DEFAULT_SWITCHPORT, accessVlan: 20 }, { ...DEFAULT_SWITCHPORT, accessVlan: 10 })).toBe('access VLAN 20 vs 10');
    expect(switchportDifference({ ...trunk, nativeVlan: 99 }, trunk)).toBe('native VLAN 99 vs 1');
    expect(switchportDifference({ ...trunk, allowed: '10,20' }, trunk)).toBe('allowed VLANs 10,20 vs all');
    expect(switchportDifference({ ...DEFAULT_SWITCHPORT, voiceVlan: 150 }, DEFAULT_SWITCHPORT)).toBe('voice VLAN 150 vs none');
  });

  it('speed, duplex and the negotiated trunking mode are compared only against a bundle that has other members', () => {
    const member = { port: GI2, config: DEFAULT_SWITCHPORT, oper: 'access' as const, speedBps: SPEED_100M, duplex: 'full' as const };
    expect(compatibility(member, { bundle: PO1, config: DEFAULT_SWITCHPORT })).toEqual({ ok: true });
    expect(compatibility(member, { bundle: PO1, config: DEFAULT_SWITCHPORT, speedBps: 1_000_000_000, duplex: 'full', oper: 'access' })).toEqual({
      ok: false, reason: configDiffersReason(PO1, 'speed 100 Mb/s vs 1 Gb/s'),
    });
    expect(compatibility(member, { bundle: PO1, config: DEFAULT_SWITCHPORT, speedBps: SPEED_100M, duplex: 'half', oper: 'access' })).toEqual({
      ok: false, reason: configDiffersReason(PO1, 'duplex full vs half'),
    });
    expect(compatibility(member, { bundle: PO1, config: DEFAULT_SWITCHPORT, speedBps: SPEED_100M, duplex: 'full', oper: 'trunk' })).toEqual({
      ok: false, reason: trunkNegotiationReason(PO1),
    });
    expect(speedText(10_000_000)).toBe('10 Mb/s');
    expect(speedText(10_000_000_000)).toBe('10 Gb/s');
    expect(speedText(undefined)).toBe('unknown');
    expect(partnerDiffersReason(PO1)).toBe('partner differs from the rest of Port-channel1');
  });
});

describe('individual members (no partner)', () => {
  it('a `mode on` member bundles at link-up without a frame and ignores LACPDUs', () => {
    const f = lagFake();
    const actions = f.group(GI1, 1, 'on');
    expect(types(actions)).toEqual(['l2Changed']);
    expect(f.row(GI1)).toMatchObject({ state: 'bundled', protocol: 'static', mode: 'on' });
    expect(f.h.debug.some((e) => e.message.includes('LACPDU sent'))).toBe(false);
    const dropped = f.d.onPdu(f.h.ctx, f.lacpdu(), GI1);
    expect(dropsOf(dropped)).toEqual([['not-for-me', staticIgnoresDetail(GI1, 'LACP')]]);
    expect(f.h.debug.map((e) => e.data?.fsm).filter((x) => x !== undefined)).toEqual([expect.objectContaining({ machine: 'channel', from: 'down', to: 'bundled' })]);
  });

  it('real world, passive–passive over one link: both ends individual with `no LACP partner` at link-up + 3 s, and a ping still crosses the individual port', () => {
    const w = lagWorld({ sw1: { hostname: 'SW1', members: [[GI1, 'passive']] }, sw2: { hostname: 'SW2', members: [[GI1, 'passive']] }, links: [[GI1, GI1]] });
    w.sim.runFor(60 * SEC);
    const up = w.linkUpAt('l1')!;
    for (const dev of ['sw1', 'sw2']) {
      expect(w.row(dev, GI1)).toMatchObject({ state: 'individual', reason: NO_LACP_PARTNER });
      const at = channelWrites(w.events(), dev).find((x) => x[2] === 'individual')![0];
      expect(at - up).toBe(3 * SEC);
      expect(w.sim.device(dev)!.port(PO1)?.operUp).toBe(false);
    }
    expect(w.events().filter((e) => e.kind === 'frameTx' && e.pdu.tag === 'lacp')).toEqual([]);
    expect(ping(w, 'pc1', '10.0.0.2')).toBe(PING_COUNT);
  });

  it('real world, misconfiguration A (active against on): SW2 bundles at link-up, SW1 goes individual, no storm, the ping works', () => {
    const w = lagWorld({ sw1: { hostname: 'SW1', members: [[GI1, 'active'], [GI2, 'active']] }, sw2: { hostname: 'SW2', members: [[GI1, 'on'], [GI2, 'on']] } });
    w.sim.runFor(60 * SEC);
    for (const port of [GI1, GI2]) {
      expect(w.row('sw2', port)).toMatchObject({ state: 'bundled', protocol: 'static' });
      expect(w.row('sw1', port)).toMatchObject({ state: 'individual', reason: NO_LACP_PARTNER });
    }
    expect(w.sim.device('sw2')!.port(PO1)?.operUp).toBe(true);
    expect(w.sim.device('sw1')!.port(PO1)?.operUp).toBe(false);
    // SW2 drops every LACPDU on its static members and never answers
    const sw2Drops = w.events().filter((e) => e.kind === 'drop' && e.device === 'sw2' && e.pdu.tag === 'lacp');
    expect(sw2Drops.length).toBeGreaterThan(0);
    expect(sw2Drops.every((e) => e.kind === 'drop' && e.detail === staticIgnoresDetail(e.port!, 'LACP'))).toBe(true);
    expect(w.events().some((e) => e.kind === 'frameTx' && e.pdu.tag === 'lacp' && e.from.device === 'sw2')).toBe(false);
    const before = w.events().length;
    expect(ping(w, 'pc1', '10.0.0.2')).toBe(PING_COUNT);
    // no loop: the frames of the ping stay bounded (each echo crosses the two switches a few times at most)
    const frames = w.events().slice(before).filter((e) => e.kind === 'frameTx' && e.pdu.tag !== 'lacp');
    expect(frames.length).toBeLessThan(200);
  });
});

describe('suspended members (incompatible)', () => {
  it('fake: a member whose access VLAN differs from the Port-channel is suspended with the difference; fixing the line bundles it', () => {
    const f = lagFake();
    f.line(PO1, 'switchport mode access');
    f.line(PO1, 'switchport access vlan 10');
    f.line(GI1, 'switchport mode access');
    f.line(GI1, 'switchport access vlan 10');
    f.line(GI2, 'switchport mode access');
    f.line(GI2, 'switchport access vlan 20');
    f.group(GI1, 1, 'on');
    f.group(GI2, 1, 'on');
    expect(f.row(GI1)).toMatchObject({ state: 'bundled' });
    expect(f.row(GI2)).toMatchObject({ state: 'suspended', reason: configDiffersReason(PO1, 'access VLAN 20 vs 10') });
    const fixed = f.line(GI2, 'switchport access vlan 10');
    expect(signalsOf(fixed)).toEqual([{ type: 'l2Changed', what: 'channel', port: GI2 }]);
    expect(f.row(GI2)).toMatchObject({ state: 'bundled' });
    expect(f.row(GI2)!.reason).toBeUndefined();
    // a line under the Port-channel re-runs the check for every member
    f.line(PO1, 'switchport access vlan 30');
    expect(f.row(GI1)).toMatchObject({ state: 'suspended', reason: configDiffersReason(PO1, 'access VLAN 10 vs 30') });
    expect(f.row(GI2)).toMatchObject({ state: 'suspended', reason: configDiffersReason(PO1, 'access VLAN 10 vs 30') });
  });

  it('fake: a member slower than the rest of the bundle is suspended by speed', () => {
    const f = lagFake();
    f.speed(GI2, SPEED_100M);
    f.group(GI1, 1, 'on');
    f.group(GI2, 1, 'on');
    expect(f.row(GI2)).toMatchObject({ state: 'suspended', reason: configDiffersReason(PO1, 'speed 100 Mb/s vs 1 Gb/s') });
  });

  it('fake: a member whose negotiated trunking mode differs from the bundle is suspended on the dtp signal, and back', () => {
    const f = lagFake();
    f.h.tables.get<DtpRow>('dtp')!.set(dtpRow(GI1, 'trunk'));
    f.h.tables.get<DtpRow>('dtp')!.set(dtpRow(GI2, 'trunk'));
    f.group(GI1, 1, 'on');
    f.group(GI2, 1, 'on');
    expect(f.row(GI1)!.state).toBe('bundled');
    expect(f.row(GI2)!.state).toBe('bundled');
    f.h.tables.get<DtpRow>('dtp')!.set(dtpRow(GI2, 'access'));
    const out = f.d.onEvent!(f.h.ctx, { kind: 'l2.changed', what: 'trunk', port: GI2, from: 'dtp' });
    expect(signalsOf(out)).toEqual([{ type: 'l2Changed', what: 'channel', port: GI2 }]);
    expect(f.row(GI2)).toMatchObject({ state: 'suspended', reason: trunkNegotiationReason(PO1) });
    expect(f.row(GI1)!.state).toBe('bundled');
    f.h.tables.get<DtpRow>('dtp')!.set(dtpRow(GI2, 'trunk'));
    f.d.onEvent!(f.h.ctx, { kind: 'l2.changed', what: 'trunk', port: GI2, from: 'dtp' });
    expect(f.row(GI2)!.state).toBe('bundled');
    // other signals are ignored
    expect(f.d.onEvent!(f.h.ctx, { kind: 'l2.changed', what: 'vlans', vlan: 10, from: 'vlan' })).toEqual([]);
    expect(f.d.onEvent!(f.h.ctx, { kind: 'l2.changed', what: 'trunk', port: FA1, from: 'dtp' })).toEqual([]);
  });

  it('fake: a member whose LACP partner system differs from the rest of the bundle is suspended until it hears the same system', () => {
    const f = lagFake();
    f.group(GI1, 1, 'active');
    f.group(GI2, 1, 'active');
    f.d.onPdu(f.h.ctx, f.lacpdu({ system: PEER_SYSTEM, port: 1 }), GI1);
    f.d.onPdu(f.h.ctx, f.lacpdu({ system: OTHER_SYSTEM, port: 2 }), GI2);
    expect(f.row(GI1)!.state).toBe('bundled');
    expect(f.row(GI2)).toMatchObject({ state: 'suspended', reason: partnerDiffersReason(PO1), partnerSystem: OTHER_SYSTEM });
    // a partner with the same system but another key is also out
    f.d.onPdu(f.h.ctx, f.lacpdu({ system: PEER_SYSTEM, key: 2, port: 2 }), GI2);
    expect(f.row(GI2)).toMatchObject({ state: 'suspended', reason: partnerDiffersReason(PO1), partnerKey: 2 });
    f.d.onPdu(f.h.ctx, f.lacpdu({ system: PEER_SYSTEM, key: 1, port: 2 }), GI2);
    expect(f.row(GI2)).toMatchObject({ state: 'bundled', partnerPort: 2 });
  });

  it('real world, misconfiguration B: the member with another access VLAN is suspended with a reason naming it; the other member carries the ping', () => {
    const w = lagWorld({
      sw1: { hostname: 'SW1', members: [[GI1, 'active'], [GI2, 'active']], global: ['vlan 20'], extra: { [GI2]: ['switchport mode access', 'switchport access vlan 20'] } },
      sw2: { hostname: 'SW2', members: [[GI1, 'active'], [GI2, 'active']] },
    });
    w.sim.runFor(60 * SEC);
    expect(w.row('sw1', GI1)!.state).toBe('bundled');
    expect(w.row('sw1', GI2)).toMatchObject({ state: 'suspended', reason: configDiffersReason(PO1, 'switchport mode access vs dynamic auto') });
    expect(w.sim.device('sw1')!.port(PO1)?.operUp).toBe(true);
    expect(ping(w, 'pc1', '10.0.0.2')).toBe(PING_COUNT);
    // a suspended member carries no traffic: every frame of SW1 toward SW2 left on Gi0/1
    const toSw2 = w.events().filter((e) => e.kind === 'frameTx' && e.from.device === 'sw1' && e.pdu.tag !== 'lacp' && (e.from.port === GI1 || e.from.port === GI2));
    expect(toSw2.length).toBeGreaterThan(0);
    expect(toSw2.every((e) => e.kind === 'frameTx' && e.from.port === GI1)).toBe(true);
  });
});
