/**
 * link.serial.transparent — [C16] the transparent serial access-line end (ARCHITECTURE-P3C §7 W1c media), pure
 * (link/serial.ts): an `accessLine` end (a CSU/DSU or provider cloud port) never reports `encapsulation-mismatch`, takes
 * the far end's encapsulation for every rule (so `serialLineReady` holds on a clocked line), runs no PPP of its own (up on
 * a clocked PPP line, its keepalive latch unread there; the link's PPP reason reads the terminating end only), leaves the
 * caller's input and the stored `encap` untouched, and evaluates every HDLC line exactly as without the flag.
 */
import { describe, expect, it } from 'vitest';
import {
  evaluateSerialLine,
  serialLineNotifies,
  serialLineReady,
  type SerialEndInput,
  type SerialLinkInput,
  type SerialPppEndState,
} from '../src/link/serial.js';

const CLOCKED = { speed: 'auto' as const, duplex: 'auto' as const, clockRateBps: 64_000 };
const UNCLOCKED = { speed: 'auto' as const, duplex: 'auto' as const };
const UP: SerialPppEndState = { up: true };
/** A router serial end (terminating). */
const router = (over: Partial<SerialEndInput> = {}): SerialEndInput => ({ speedBps: 2_000_000, encap: 'ppp', settings: UNCLOCKED, keepaliveLatched: false, ...over });
/** A CSU/DSU Serial0 end: an access line that supplies the clock, stored encapsulation hdlc. */
const unit = (over: Partial<SerialEndInput> = {}): SerialEndInput => ({ speedBps: 1_544_000, encap: 'hdlc', clockSource: true, keepaliveLatched: false, accessLine: true, ...over });

describe('the transparent access-line end ([C16])', () => {
  it('a ppp router to a unit: no mismatch, the line is ready, the unit end is up and the router negotiates', () => {
    const r = evaluateSerialLine({ a: router(), b: unit(), dceEnd: 'b' });
    expect(r).toEqual({
      up: false,
      a: { carrier: true, lineProtocol: false, dce: false, lineProtocolReason: 'ppp-negotiating' },
      b: { carrier: true, lineProtocol: true, dce: true },
      operUp: { a: false, b: true },
      dceEnd: 'b',
      downReason: 'ppp-negotiating',
      clockBps: 1_544_000,
      negotiatedBps: 1_544_000,
    });
    expect(serialLineReady(r)).toBe(true);
    expect(serialLineNotifies('ppp', 'hdlc')).toBe(true);
  });

  it('the link follows the router end only: up once its daemon reports up, its reason otherwise', () => {
    const up = evaluateSerialLine({ a: router({ ppp: UP }), b: unit(), dceEnd: 'b' });
    expect(up.up).toBe(true);
    expect(up.operUp).toEqual({ a: true, b: true });
    expect(up).not.toHaveProperty('downReason');
    const failed = evaluateSerialLine({ a: router({ ppp: { up: false, reason: 'ppp-auth-failed' } }), b: unit(), dceEnd: 'b' });
    expect(failed.downReason).toBe('ppp-auth-failed');
    expect(failed.operUp).toEqual({ a: false, b: true });
    expect(failed.b).toEqual({ carrier: true, lineProtocol: true, dce: true });
  });

  it('on a ppp line the unit ignores its own report and its keepalive latch (no PPP of its own)', () => {
    const r = evaluateSerialLine({ a: router({ ppp: UP }), b: unit({ keepaliveLatched: true, ppp: { up: false, reason: 'ppp-auth-failed' } }), dceEnd: 'b' });
    expect(r.up).toBe(true);
    expect(r.b).toEqual({ carrier: true, lineProtocol: true, dce: true });
  });

  it('either end order and either DCE end give the same answers', () => {
    const r = evaluateSerialLine({ a: unit({ clockSource: undefined, settings: CLOCKED }), b: router({ ppp: UP }), dceEnd: 'a' });
    expect(r.up).toBe(true);
    expect(r.downReason).toBeUndefined();
    expect(r.clockBps).toBe(64_000);
    expect(serialLineReady(r)).toBe(true);
  });

  it('no-clock still comes first: an unclocked unit line is down no-clock and not ready', () => {
    const r = evaluateSerialLine({ a: router(), b: unit({ clockSource: undefined, settings: UNCLOCKED }), dceEnd: 'b' });
    expect(r.downReason).toBe('no-clock');
    expect(r.a.lineProtocolReason).toBe('no-clock');
    expect(r.b.lineProtocolReason).toBe('no-clock');
    expect(serialLineReady(r)).toBe(false);
  });

  it('the input and its stored encapsulation are left untouched', () => {
    const b = unit();
    const input: SerialLinkInput = { a: router(), b, dceEnd: 'b' };
    evaluateSerialLine(input);
    expect(input.b).toBe(b);
    expect(b.encap).toBe('hdlc');
    expect(b).toEqual(unit());
  });

  it('without the flag the P3 rule stands: ppp against hdlc is an encapsulation mismatch', () => {
    const r = evaluateSerialLine({ a: router(), b: unit({ accessLine: undefined }), dceEnd: 'b' });
    expect(r.downReason).toBe('encapsulation-mismatch');
    expect(serialLineReady(r)).toBe(false);
  });

  it('an hdlc router to a unit evaluates exactly as without the flag (latches included)', () => {
    const cases: [Partial<SerialEndInput>, Partial<SerialEndInput>][] = [
      [{}, {}],
      [{ keepaliveLatched: true }, {}],
      [{}, { keepaliveLatched: true }],
      [{}, { clockSource: undefined, settings: UNCLOCKED }],
    ];
    for (const [ra, ub] of cases) {
      const flagged = evaluateSerialLine({ a: router({ encap: 'hdlc', ...ra }), b: unit(ub), dceEnd: 'b' });
      const plain = evaluateSerialLine({ a: router({ encap: 'hdlc', ...ra }), b: unit({ ...ub, accessLine: undefined }), dceEnd: 'b' });
      expect(flagged).toEqual(plain);
    }
  });

  it('two access lines (unit to cloud) keep their own encapsulations: the HDLC rules, latches included', () => {
    const cloud = unit({ clockSource: true });
    const u1 = unit({ clockSource: undefined, settings: UNCLOCKED });
    const r = evaluateSerialLine({ a: u1, b: cloud, dceEnd: 'b' });
    expect(r.up).toBe(true);
    const latched = evaluateSerialLine({ a: { ...u1, keepaliveLatched: true }, b: cloud, dceEnd: 'b' });
    expect(latched.downReason).toBe('keepalive-missed');
    expect(latched.operUp).toEqual({ a: false, b: true });
    expect(serialLineNotifies('hdlc', 'hdlc')).toBe(false);
  });
});
