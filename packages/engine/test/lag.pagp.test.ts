/**
 * W3 lag [S3] (ARCHITECTURE-P2 D8, §2.3 `pagp`, §2.4 control table, §3.7, §4.3): the NF-format PAgP codec (fixed
 * 20 bytes, the `nf.pid` 3 dispatch, the registry position after hsrp), the PAgP members of the etherchannel daemon
 * (desirable initiates, auto answers, bundling on the first message, `no PAgP partner`, the pagp-* timers, a partner
 * unlike the rest of the bundle), the protocol mismatch drops, and the real desirable–auto and auto–auto worlds.
 */
import { describe, expect, it } from 'vitest';
import { NF_L2_CONTROL_MAC, NF_OUI, NF_PID_PAGP } from '../src/contracts/pdu.js';
import type { LayerSpec } from '../src/contracts/pdu.js';
import { SEC } from '../src/contracts/time.js';
import { lookupNext } from '../src/pdu/codecs/dispatch.js';
import { PAGP_LENGTH, PAGP_MODE_AUTO, PAGP_MODE_DESIRABLE, pagpCodec, pagpModeText } from '../src/pdu/codecs/pagp.js';
import { CODECS, decodeLayers, encodeLayers, getCodec } from '../src/pdu/codecs/registry.js';
import { classifyControl, controlAction } from '../src/protocols/l2/control.js';
import { otherProtocolDetail } from '../src/protocols/etherchannel.js';
import { NO_PAGP_PARTNER, partnerDiffersReason } from '../src/protocols/etherchannel/compat.js';
import { pagpTimerKey, parsePagpTimerKey, readPagpPartner } from '../src/protocols/etherchannel/pagp.js';
import { staticIgnoresDetail } from '../src/protocols/etherchannel/static.js';
import { GI1, GI2, OTHER_SYSTEM, PEER_SYSTEM, PING_COUNT, PO1, cancelsOf, channelWrites, dropsOf, lagFake, lagWorld, ping, sendsOf, signalsOf, timersOf, types } from './lag.harness.js';

const MAC1 = '02:4e:00:00:00:01';
const DEV1 = '02:4e:00:00:00:00';

describe('pagp codec (NF format) [S3]', () => {
  const specs = (partner = false): LayerSpec[] => [
    { proto: 'ethernet', fields: { dst: NF_L2_CONTROL_MAC, src: MAC1 } },
    { proto: 'llc', fields: { oui: NF_OUI, type: NF_PID_PAGP } },
    { proto: 'pagp', fields: { mode: PAGP_MODE_DESIRABLE, device: DEV1, port: 25, group: 1, ...(partner ? { partnerDevice: PEER_SYSTEM, partnerPort: 7 } : {}) } },
  ];

  it('is registered after hsrp and dispatched by nf.pid 3', () => {
    expect(getCodec('pagp')).toBe(pagpCodec);
    expect([...CODECS.keys()].slice(-2)).toEqual(['hsrp', 'pagp']);
    expect(lookupNext('nf.pid', NF_PID_PAGP)).toBe('pagp');
  });

  it('encodes the fixed 20-byte layout under 802.3 + LLC/SNAP and decodes it back', () => {
    const bytes = encodeLayers(specs(true));
    // 14 (802.3 header) + 8 (SNAP) + 20, then the Ethernet minimum-size padding
    expect(bytes.length).toBeGreaterThanOrEqual(14 + 8 + PAGP_LENGTH);
    // 802.3 length = 8 (SNAP) + 20
    expect((bytes[12]! << 8) | bytes[13]!).toBe(28);
    const body = Array.from(bytes.subarray(22, 22 + PAGP_LENGTH));
    expect(body.slice(0, 2)).toEqual([1, PAGP_MODE_DESIRABLE]);
    expect(body.slice(8, 12)).toEqual([0, 25, 0, 1]);
    expect(body.slice(18, 20)).toEqual([0, 7]);
    const layers = decodeLayers(bytes, 'ethernet');
    expect(layers.map((l) => l.proto)).toEqual(['ethernet', 'llc', 'pagp']);
    const p = layers[2]!;
    expect(p.error).toBeUndefined();
    expect(p.fields).toEqual({ version: 1, mode: PAGP_MODE_DESIRABLE, device: DEV1, port: 25, group: 1, partnerDevice: PEER_SYSTEM, partnerPort: 7 });
    expect(p.length).toBe(PAGP_LENGTH);
    expect(pagpCodec.summarize!(p.fields)).toBe(`PAgP desirable from ${DEV1} port 25 group 1 partner ${PEER_SYSTEM} port 7`);
    const noPartner = decodeLayers(encodeLayers(specs()), 'ethernet')[2]!;
    expect(noPartner.fields.partnerDevice).toBe('00:00:00:00:00:00');
    expect(pagpCodec.summarize!(noPartner.fields)).toBe(`PAgP desirable from ${DEV1} port 25 group 1 no partner`);
    expect(pagpModeText(PAGP_MODE_AUTO)).toBe('auto');
    expect(pagpModeText(9)).toBe('mode 9');
  });

  it('refuses a bad mode, an inner payload and a truncated message', () => {
    expect(() => pagpCodec.encode({ mode: 3 }, new Uint8Array(0))).toThrow(/mode must be/);
    expect(() => pagpCodec.encode({ mode: 1 }, new Uint8Array(1))).toThrow(/no inner layer/);
    expect(pagpCodec.decode(new Uint8Array(5), 0, 5).error).toMatch(/truncated/);
    expect(readPagpPartner({ layers: [] })).toBeUndefined();
  });

  it('classifies as the `pagp` control class delivered to etherchannel on the physical port', () => {
    const layers = decodeLayers(encodeLayers(specs()), 'ethernet');
    expect(classifyControl({ layers })).toBe('pagp');
    expect(controlAction('pagp', { processes: ['eth-switch', 'vlan', 'etherchannel'] })).toEqual({ kind: 'deliver', to: 'etherchannel', port: 'physical' });
    expect(controlAction('pagp', { processes: ['eth-switch'] })).toMatchObject({ kind: 'drop', reason: 'unsupported-protocol' });
  });
});

describe('PAgP members on a fake ctx', () => {
  it('timer keys', () => {
    expect(pagpTimerKey('pagp-tx', GI1)).toBe('pagp-tx:GigabitEthernet0/1');
    expect(parsePagpTimerKey('pagp-wait:GigabitEthernet0/2')).toEqual({ kind: 'pagp-wait', port: GI2 });
    expect(parsePagpTimerKey('lacp-wait:GigabitEthernet0/2')).toBeUndefined();
  });

  it('desirable: a message at once and the burst, then individual with `no PAgP partner`; a partner heard bundles it', () => {
    const f = lagFake();
    const start = f.group(GI1, 1, 'desirable');
    expect(types(start)).toEqual(['send', 'timer']);
    expect(sendsOf(start)).toEqual([[GI1, 'pagp']]);
    expect(timersOf(start)).toEqual([['pagp-fast:GigabitEthernet0/1', 1 * SEC, undefined]]);
    expect(f.row(GI1)).toMatchObject({ state: 'waiting', protocol: 'pagp', mode: 'desirable' });
    const sent = start[0]!;
    if (sent.type !== 'send') throw new Error('send expected');
    expect(sent.pdu.layers.map((l) => l.proto)).toEqual(['ethernet', 'llc', 'pagp']);
    expect(sent.pdu.layers[0]!.fields.dst).toBe(NF_L2_CONTROL_MAC);
    expect(sent.pdu.layers[2]!.fields).toMatchObject({ mode: PAGP_MODE_DESIRABLE, device: f.h.ports.get(PO1)!.mac, port: f.h.ports.get(GI1)!.ordinal, group: 1 });
    expect(sent.pdu.meta.background).toBe(true);
    for (let i = 1; i <= 2; i++) {
      f.h.setNow(i * SEC);
      expect(types(f.d.onTimer(f.h.ctx, 'pagp-fast:GigabitEthernet0/1'))).toEqual(['send', 'timer']);
    }
    f.h.setNow(3 * SEC);
    const gaveUp = f.d.onTimer(f.h.ctx, 'pagp-fast:GigabitEthernet0/1');
    expect(types(gaveUp)).toEqual(['l2Changed', 'timer']);
    expect(timersOf(gaveUp)).toEqual([['pagp-tx:GigabitEthernet0/1', 30 * SEC, true]]);
    expect(f.row(GI1)).toMatchObject({ state: 'individual', reason: NO_PAGP_PARTNER });
    const fsm = f.h.debug.map((e) => e.data?.fsm).filter((x) => x !== undefined).at(-1);
    expect(fsm).toMatchObject({ machine: 'pagp', subject: `${PO1} ${GI1}`, from: 'waiting', to: 'individual' });
    f.h.setNow(10 * SEC);
    const pdu = f.pagp({ mode: 'auto', port: 3 });
    const heard = f.d.onPdu(f.h.ctx, pdu, GI1);
    expect(types(heard)).toEqual(['timer', 'cancelTimer', 'timer', 'l2Changed', 'send', 'consume']);
    expect(timersOf(heard)).toEqual([['pagp-age:GigabitEthernet0/1', 90 * SEC, true], ['pagp-tx:GigabitEthernet0/1', 30 * SEC, true]]);
    expect(f.row(GI1)).toMatchObject({ state: 'bundled', partnerSystem: PEER_SYSTEM, partnerKey: 1, partnerPort: 3 });
    const told = heard[4]!;
    if (told.type !== 'send') throw new Error('send expected');
    expect(told.pdu.layers[2]!.fields).toMatchObject({ partnerDevice: PEER_SYSTEM, partnerPort: 3 });
    f.h.setNow(100 * SEC);
    expect(types(f.d.onTimer(f.h.ctx, 'pagp-age:GigabitEthernet0/1'))).toEqual(['l2Changed']);
    expect(f.row(GI1)).toMatchObject({ state: 'individual', reason: NO_PAGP_PARTNER });
  });

  it('auto: waits 3 s, answers every message once heard; a partner unlike the rest of the bundle is suspended', () => {
    const f = lagFake();
    expect(timersOf(f.group(GI1, 1, 'auto'))).toEqual([['pagp-wait:GigabitEthernet0/1', 3 * SEC, undefined]]);
    expect(timersOf(f.group(GI2, 1, 'auto'))).toEqual([['pagp-wait:GigabitEthernet0/2', 3 * SEC, undefined]]);
    const heard = f.d.onPdu(f.h.ctx, f.pagp({ device: PEER_SYSTEM, port: 1 }), GI1);
    expect(cancelsOf(heard)).toEqual(['pagp-wait:GigabitEthernet0/1']);
    expect(sendsOf(heard)).toEqual([[GI1, 'pagp']]);
    expect(f.row(GI1)!.state).toBe('bundled');
    expect(signalsOf(f.d.onPdu(f.h.ctx, f.pagp({ device: OTHER_SYSTEM, port: 2 }), GI2))).toEqual([{ type: 'l2Changed', what: 'channel', port: GI2 }]);
    expect(f.row(GI2)).toMatchObject({ state: 'suspended', reason: partnerDiffersReason(PO1) });
    f.d.onPdu(f.h.ctx, f.pagp({ device: PEER_SYSTEM, port: 2 }), GI2);
    expect(f.row(GI2)!.state).toBe('bundled');
    // steady state: one reply per message, no periodic send of its own
    expect(types(f.d.onPdu(f.h.ctx, f.pagp({ device: PEER_SYSTEM, port: 1 }), GI1))).toEqual(['timer', 'send', 'consume']);
    expect(f.d.onTimer(f.h.ctx, 'pagp-tx:GigabitEthernet0/1')).toEqual([]);
    f.h.setNow(3 * SEC);
    expect(f.d.onTimer(f.h.ctx, 'pagp-wait:GigabitEthernet0/2')).toEqual([]); // a partner is known: the late wait changes nothing
  });

  it('the wrong protocol on a member is dropped, never bridged', () => {
    const f = lagFake();
    f.group(GI1, 1, 'desirable');
    f.group(GI2, 1, 'active');
    expect(dropsOf(f.d.onPdu(f.h.ctx, f.lacpdu(), GI1))).toEqual([['not-for-me', otherProtocolDetail(GI1, 'PAgP', 'LACP')]]);
    expect(dropsOf(f.d.onPdu(f.h.ctx, f.pagp(), GI2))).toEqual([['not-for-me', otherProtocolDetail(GI2, 'LACP', 'PAgP')]]);
    f.group(GI2, 1, 'on');
    expect(dropsOf(f.d.onPdu(f.h.ctx, f.pagp(), GI2))).toEqual([['not-for-me', staticIgnoresDetail(GI2, 'PAgP')]]);
  });
});

describe('PAgP in the real world', () => {
  it('desirable–auto: both members bundled within 3 s of link-up, the bundle carries the ping, messages are background', () => {
    const w = lagWorld({ sw1: { hostname: 'SW1', members: [[GI1, 'desirable'], [GI2, 'desirable']] }, sw2: { hostname: 'SW2', members: [[GI1, 'auto'], [GI2, 'auto']] } });
    w.sim.runFor(40 * SEC);
    for (const dev of ['sw1', 'sw2']) {
      for (const port of [GI1, GI2]) expect(w.row(dev, port)).toMatchObject({ state: 'bundled', protocol: 'pagp' });
      expect(w.sim.device(dev)!.port(PO1)?.operUp).toBe(true);
      for (const [t, key] of channelWrites(w.events(), dev).filter((x) => x[2] === 'bundled')) {
        expect(t - w.linkUpAt(key === GI1 ? 'l1' : 'l2')!).toBeLessThanOrEqual(3 * SEC);
      }
    }
    const msgs = w.events().filter((e) => e.kind === 'frameTx' && e.pdu.tag === 'pagp');
    expect(msgs.length).toBeGreaterThan(0);
    expect(msgs.every((e) => e.kind === 'frameTx' && e.background === true && e.from.port !== 'FastEthernet0/1')).toBe(true);
    expect(w.events().filter((e) => e.kind === 'frameTx' && e.pdu.tag === 'lacp')).toEqual([]);
    expect(ping(w, 'pc1', '10.0.0.2')).toBe(PING_COUNT);
    w.sim.runFor(120 * SEC);
    for (const dev of ['sw1', 'sw2']) for (const port of [GI1, GI2]) expect(w.row(dev, port)!.state).toBe('bundled');
  });

  it('auto–auto over one link: both ends individual with `no PAgP partner` at link-up + 3 s, nothing sent', () => {
    const w = lagWorld({ sw1: { hostname: 'SW1', members: [[GI1, 'auto']] }, sw2: { hostname: 'SW2', members: [[GI1, 'auto']] }, links: [[GI1, GI1]] });
    w.sim.runFor(40 * SEC);
    const up = w.linkUpAt('l1')!;
    for (const dev of ['sw1', 'sw2']) {
      expect(w.row(dev, GI1)).toMatchObject({ state: 'individual', reason: NO_PAGP_PARTNER });
      expect(channelWrites(w.events(), dev).find((x) => x[2] === 'individual')![0] - up).toBe(3 * SEC);
    }
    expect(w.events().filter((e) => e.kind === 'frameTx' && e.pdu.tag === 'pagp')).toEqual([]);
    expect(ping(w, 'pc1', '10.0.0.2')).toBe(PING_COUNT);
  });
});
