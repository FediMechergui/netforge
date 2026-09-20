import { describe, expect, it } from 'vitest';
import type { LayerView } from '../src/contracts/pdu.js';
import { HDLC_PROTO_IPV4, HDLC_PROTO_KEEPALIVE } from '../src/contracts/pdu.js';
import type { PortPhy } from '../src/contracts/link.js';
import {
  SERIAL_DOWN_TEXT,
  createKeepaliveLatches,
  downOnlyByKeepalive,
  effectiveEncap,
  evaluateSerialLine,
  isKeepaliveFrame,
  isSerialMedia,
  keepaliveExempt,
  resolveDceEnd,
  serialCarrierDown,
  type SerialEndInput,
} from '../src/link/serial.js';
import { testPortSpec } from './port.fixtures.js';

const end = (over: Partial<SerialEndInput> = {}): SerialEndInput => ({
  speedBps: 2_000_000,
  encap: 'hdlc',
  settings: { speed: 'auto', duplex: 'auto' },
  keepaliveLatched: false,
  ...over,
});

const layer = (proto: string, fields: Record<string, number>): LayerView => ({ proto, offset: 0, length: 16, headerLength: 4, fields, fieldRanges: {} });
const keepalive = { layers: [layer('hdlc', { address: 0x8f, control: 0, protocol: HDLC_PROTO_KEEPALIVE })] };
const ipOverHdlc = { layers: [layer('hdlc', { address: 0x0f, control: 0, protocol: HDLC_PROTO_IPV4 }), layer('ipv4', {})] };

describe('link/serial DCE resolution', () => {
  it('dce_end override → media → legacy PortSpec.serial.dce → end a', () => {
    expect(resolveDceEnd({ dceEnd: 'b' }, 'serial-dce')).toBe('b');
    expect(resolveDceEnd({}, 'serial-dce')).toBe('a');
    expect(resolveDceEnd({}, 'serial-dte')).toBe('b');
    expect(resolveDceEnd({}, 'serial', { serial: {} }, { serial: { dce: true } })).toBe('b');
    expect(resolveDceEnd({}, 'serial', { serial: { dce: true } }, { serial: { dce: true } })).toBe('a');
    expect(resolveDceEnd({}, 'serial')).toBe('a');
    // the media rule wins over the deprecated port flag
    expect(resolveDceEnd({}, 'serial-dce', {}, { serial: { dce: true } })).toBe('a');
  });

  it('legacy serial media prefers the clockSource end (cable dragged FROM the router to a CSU/DSU or ISP port)', () => {
    expect(resolveDceEnd({}, 'serial', {}, { clockSource: true })).toBe('b');
    expect(resolveDceEnd({}, 'serial', { clockSource: true }, {})).toBe('a');
    expect(resolveDceEnd({}, 'serial', { serial: { dce: true } }, { clockSource: true })).toBe('b');
    // both or neither clock sources: fall through to the port flag, then end a
    expect(resolveDceEnd({}, 'serial', { clockSource: true }, { clockSource: true, serial: { dce: true } })).toBe('b');
    expect(resolveDceEnd({}, 'serial', { clockSource: true }, { clockSource: true })).toBe('a');
    // media rule and topology override still win
    expect(resolveDceEnd({}, 'serial-dce', {}, { clockSource: true })).toBe('a');
    expect(resolveDceEnd({ dceEnd: 'a' }, 'serial', {}, { clockSource: true })).toBe('a');
  });

  it('serial media class and effective encapsulation', () => {
    expect(isSerialMedia('serial')).toBe(true);
    expect(isSerialMedia('serial-dce')).toBe(true);
    expect(isSerialMedia('serial-dte')).toBe(true);
    expect(isSerialMedia('copper-straight')).toBe(false);
    expect(isSerialMedia('auto')).toBe(false);
    const spec = testPortSpec({ name: 'Serial0/0/0', short: 'Se0/0/0', kind: 'serial', speedBps: 2_000_000 });
    expect(spec.encap).toBe('hdlc');
    expect(effectiveEncap({ encap: spec.encap })).toBe('hdlc');
    expect(effectiveEncap({ encap: 'ppp' })).toBe('ppp');
  });
});

describe('link/serial clocking and encapsulation', () => {
  it('no clock rate on the DCE end: carrier up, line protocol down on both ends with no-clock', () => {
    const r = evaluateSerialLine({ a: end(), b: end(), dceEnd: 'a' });
    expect(r.up).toBe(false);
    expect(r.downReason).toBe('no-clock');
    expect(r.negotiatedBps).toBeUndefined();
    expect(r.a).toEqual({ carrier: true, lineProtocol: false, lineProtocolReason: 'no-clock', dce: true });
    expect(r.b).toEqual({ carrier: true, lineProtocol: false, lineProtocolReason: 'no-clock', dce: false });
    expect(r.operUp).toEqual({ a: false, b: false });
  });

  it('clock rate on the DCE end brings the line up at min(clock, port speeds)', () => {
    const r = evaluateSerialLine({ a: end(), b: end({ settings: { speed: 'auto', duplex: 'auto', clockRateBps: 64_000 } }), dceEnd: 'b' });
    expect(r.up).toBe(true);
    expect(r.downReason).toBeUndefined();
    expect(r.clockBps).toBe(64_000);
    expect(r.negotiatedBps).toBe(64_000);
    expect(r.a.dce).toBe(false);
    expect(r.b.dce).toBe(true);
    expect(r.operUp).toEqual({ a: true, b: true });
    // bandwidth cap applies below the clock
    expect(evaluateSerialLine({ a: end({ settings: { speed: 'auto', duplex: 'auto', clockRateBps: 64_000 } }), b: end(), dceEnd: 'a', bandwidthBps: 56_000 }).negotiatedBps).toBe(56_000);
    // a clock faster than the port is limited by the port
    expect(evaluateSerialLine({ a: end({ speedBps: 128_000, settings: { speed: 'auto', duplex: 'auto', clockRateBps: 2_000_000 } }), b: end(), dceEnd: 'a' }).negotiatedBps).toBe(128_000);
  });

  it('a clock rate on the DTE end does not clock the line', () => {
    const r = evaluateSerialLine({ a: end({ settings: { speed: 'auto', duplex: 'auto', clockRateBps: 64_000 } }), b: end(), dceEnd: 'b' });
    expect(r.downReason).toBe('no-clock');
  });

  it('a clock-source DCE port needs no clock rate', () => {
    const r = evaluateSerialLine({ a: end({ clockSource: true, speedBps: 1_544_000 }), b: end(), dceEnd: 'a' });
    expect(r.up).toBe(true);
    expect(r.clockBps).toBe(1_544_000);
    expect(r.negotiatedBps).toBe(1_544_000);
  });

  it('without a settings source (P0 link model) the clock rule is not applied', () => {
    const r = evaluateSerialLine({ a: end({ speedBps: 128_000, settings: undefined }), b: end({ speedBps: 128_000, settings: undefined }), dceEnd: 'a' });
    expect(r.up).toBe(true);
    expect(r.negotiatedBps).toBe(128_000);
    expect(r.clockBps).toBeUndefined();
  });

  it('different encapsulations bring both ends down', () => {
    const clocked = end({ settings: { speed: 'auto', duplex: 'auto', clockRateBps: 64_000 } });
    const r = evaluateSerialLine({ a: clocked, b: end({ encap: 'ppp' }), dceEnd: 'a' });
    expect(r.up).toBe(false);
    expect(r.downReason).toBe('encapsulation-mismatch');
    expect(r.a.lineProtocolReason).toBe('encapsulation-mismatch');
    expect(r.b.lineProtocolReason).toBe('encapsulation-mismatch');
    expect(r.negotiatedBps).toBe(64_000);
    // no-clock is checked first
    expect(evaluateSerialLine({ a: end(), b: end({ encap: 'ppp' }), dceEnd: 'a' }).downReason).toBe('no-clock');
  });

  it('carrier loss view keeps the DCE flag', () => {
    expect(serialCarrierDown('b')).toEqual({
      a: { carrier: false, lineProtocol: false, dce: false },
      b: { carrier: false, lineProtocol: false, dce: true },
    });
  });
});

describe('link/serial per-end keepalive latch', () => {
  const clocked = (over: Partial<SerialEndInput> = {}): SerialEndInput => end({ settings: { speed: 'auto', duplex: 'auto', clockRateBps: 64_000 }, ...over });

  it('a latch downs only the reporting end; the peer stays operUp; LinkState.up is false', () => {
    // R2 (end b) has keepalive 0 and never reports; R1 (end a) missed 3 keepalives and latched.
    const r = evaluateSerialLine({ a: clocked({ keepaliveLatched: true }), b: end(), dceEnd: 'a' });
    expect(r.a).toEqual({ carrier: true, lineProtocol: false, lineProtocolReason: 'keepalive-missed', dce: true });
    expect(r.b).toEqual({ carrier: true, lineProtocol: true, dce: false });
    expect(r.operUp).toEqual({ a: false, b: true });
    expect(r.up).toBe(false);
    expect(r.downReason).toBe('keepalive-missed');
    // the rate stays known so exempt keepalives can still be serialized
    expect(r.negotiatedBps).toBe(64_000);
  });

  it('clocking and encapsulation failures take precedence over a latch', () => {
    const noClock = evaluateSerialLine({ a: end({ keepaliveLatched: true }), b: end(), dceEnd: 'a' });
    expect(noClock.a.lineProtocolReason).toBe('no-clock');
    expect(noClock.b.lineProtocolReason).toBe('no-clock');
  });

  it('latches are set and cleared per port by line-protocol ops, only while carrier is up', () => {
    const latches = createKeepaliveLatches();
    const r1 = { device: 'd_r1', port: 'Serial0/0/0' };
    const r2 = { device: 'd_r2', port: 'Serial0/0/0' };
    expect(latches.apply(r1, { up: false }, false)).toBe(false);
    expect(latches.isLatched(r1)).toBe(false);
    expect(latches.apply(r1, { up: false }, true)).toBe(true);
    expect(latches.apply(r1, { up: false }, true)).toBe(false);
    expect(latches.isLatched(r1)).toBe(true);
    expect(latches.isLatched(r2)).toBe(false);
    // a keepalive received while latched → line-protocol up:true clears the latch
    expect(latches.apply(r1, { up: true }, true)).toBe(true);
    expect(latches.apply(r1, { up: true }, true)).toBe(false);
    expect(latches.isLatched(r1)).toBe(false);
  });

  it('carrier loss clears both ends latches', () => {
    const latches = createKeepaliveLatches();
    const r1 = { device: 'd_r1', port: 'Serial0/0/0' };
    const r2 = { device: 'd_r2', port: 'Serial0/0/0' };
    const other = { device: 'd_r3', port: 'Serial0/0/1' };
    latches.apply(r2, { up: false }, true);
    latches.apply(other, { up: false }, true);
    latches.apply(r1, { up: false }, true);
    expect(latches.latched()).toEqual([r2, other, r1]);
    expect(latches.clearLink(r1, r2)).toBe(true);
    expect(latches.isLatched(r1)).toBe(false);
    expect(latches.isLatched(r2)).toBe(false);
    expect(latches.latched()).toEqual([other]);
    expect(latches.clearLink(r1, r2)).toBe(false);
    expect(latches.clear(other)).toBe(true);
    expect(latches.latched()).toEqual([]);
  });
});

describe('link/serial keepalive exemption', () => {
  const kaDown: { phy: PortPhy } = { phy: { carrier: true, lineProtocol: false, lineProtocolReason: 'keepalive-missed', dce: false } };
  const noClock: { phy: PortPhy } = { phy: { carrier: true, lineProtocol: false, lineProtocolReason: 'no-clock', dce: true } };
  const noCarrier: { phy: PortPhy } = { phy: { carrier: false, lineProtocol: false } };

  it('keepalive frames pass an end that is down only by its keepalive latch', () => {
    expect(isKeepaliveFrame(keepalive)).toBe(true);
    expect(isKeepaliveFrame(ipOverHdlc)).toBe(false);
    expect(isKeepaliveFrame({ layers: [] })).toBe(false);
    expect(downOnlyByKeepalive(kaDown)).toBe(true);
    expect(keepaliveExempt(keepalive, kaDown)).toBe(true);
  });

  it('every other frame, and every other down reason, stays blocked', () => {
    expect(keepaliveExempt(ipOverHdlc, kaDown)).toBe(false);
    expect(keepaliveExempt(keepalive, noClock)).toBe(false);
    expect(keepaliveExempt(keepalive, noCarrier)).toBe(false);
    expect(keepaliveExempt(keepalive, {})).toBe(false);
    expect(keepaliveExempt({ layers: [layer('ethernet', { type: HDLC_PROTO_KEEPALIVE })] }, kaDown)).toBe(false);
  });

  it('explanations are original', () => {
    for (const text of Object.values(SERIAL_DOWN_TEXT)) {
      expect(text.length).toBeGreaterThan(20);
      expect(text).not.toMatch(/cisco|ios\b|slarp/i);
    }
  });
});
