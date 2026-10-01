/**
 * link.serial.ppp — [S19] per-end PPP line-protocol rules and the serial control exemption (ARCHITECTURE-P3 D17, §2.7,
 * §3.9; §7 W1 media), all pure (link/serial.ts): on a clocked link with both ends `ppp`, each end's line protocol is its
 * ppp daemon's last report (negotiating until `up`, then the reported reason); clock and encapsulation checks come
 * first; the link reason is the most telling PPP reason; `serialLineReady` / `serialLineNotifies` give the
 * `serial-line` event; `serialControlExempt` lets PPP control frames through a PPP-only outage and answers every
 * non-PPP frame exactly as `keepaliveExempt`. Every HDLC evaluation is unchanged.
 */
import { describe, expect, it } from 'vitest';
import type { PortPhy } from '../src/contracts/link.js';
import { HDLC_PROTO_KEEPALIVE, PPP_PROTO } from '../src/contracts/pdu.js';
import {
  SERIAL_PPP_CONTROL_PROTOCOLS,
  SERIAL_PPP_REASON_ORDER,
  SERIAL_DOWN_TEXT,
  downOnlyBySerialPpp,
  evaluateSerialLine,
  isSerialPppControlFrame,
  keepaliveExempt,
  serialPppEndDownReason,
  serialControlExempt,
  serialLineNotifies,
  serialLineReady,
  type SerialPppEndState,
  type SerialEndInput,
} from '../src/link/serial.js';

const CLOCKED = { speed: 'auto' as const, duplex: 'auto' as const, clockRateBps: 64_000 };
const end = (over: Partial<SerialEndInput> = {}): SerialEndInput => ({ speedBps: 2_000_000, encap: 'ppp', settings: { speed: 'auto', duplex: 'auto' }, keepaliveLatched: false, ...over });
const link = (a: Partial<SerialEndInput>, b: Partial<SerialEndInput>) =>
  evaluateSerialLine({ a: end({ settings: CLOCKED, ...a }), b: end(b), dceEnd: 'a' });
const UP: SerialPppEndState = { up: true };

describe('per-end PPP line protocol ([S19])', () => {
  it('both ends ppp and clocked, no report yet: both negotiating, the link down negotiating, clocked at the line rate', () => {
    const r = link({}, {});
    expect(r).toEqual({
      up: false,
      a: { carrier: true, lineProtocol: false, dce: true, lineProtocolReason: 'ppp-negotiating' },
      b: { carrier: true, lineProtocol: false, dce: false, lineProtocolReason: 'ppp-negotiating' },
      operUp: { a: false, b: false },
      dceEnd: 'a',
      downReason: 'ppp-negotiating',
      clockBps: 64_000,
      negotiatedBps: 64_000,
    });
    expect(serialLineReady(r)).toBe(true);
  });

  it('each end follows its own report: one end up is up alone; both up is up', () => {
    const one = link({ ppp: UP }, {});
    expect(one.operUp).toEqual({ a: true, b: false });
    expect(one.a).toEqual({ carrier: true, lineProtocol: true, dce: true });
    expect(one.up).toBe(false);
    expect(one.downReason).toBe('ppp-negotiating');
    const both = link({ ppp: UP }, { ppp: UP });
    expect(both.up).toBe(true);
    expect(both.operUp).toEqual({ a: true, b: true });
    expect(both).not.toHaveProperty('downReason');
    expect(both.b).toEqual({ carrier: true, lineProtocol: true, dce: false });
  });

  it('a down report carries its reason (default negotiating); the link takes the most telling one', () => {
    expect(link({ ppp: { up: false, reason: 'ppp-auth-failed' } }, { ppp: { up: false, reason: 'ppp-auth-failed' } }).downReason).toBe('ppp-auth-failed');
    const mixed = link({ ppp: { up: false } }, { ppp: { up: false, reason: 'ppp-auth-failed' } });
    expect([mixed.a.lineProtocolReason, mixed.b.lineProtocolReason, mixed.downReason]).toEqual(['ppp-negotiating', 'ppp-auth-failed', 'ppp-auth-failed']);
    const echo = link({ ppp: { up: false, reason: 'keepalive-missed' } }, { ppp: UP });
    expect([echo.a.lineProtocolReason, echo.operUp.b, echo.downReason]).toEqual(['keepalive-missed', true, 'keepalive-missed']);
    expect(link({ ppp: { up: false, reason: 'keepalive-missed' } }, {}).downReason).toBe('keepalive-missed');
    expect(SERIAL_PPP_REASON_ORDER).toEqual(['ppp-auth-failed', 'keepalive-missed', 'ppp-negotiating']);
    expect(serialPppEndDownReason(undefined)).toBe('ppp-negotiating');
    expect(serialPppEndDownReason({ up: false })).toBe('ppp-negotiating');
    expect(serialPppEndDownReason({ up: true, reason: 'ppp-auth-failed' })).toBeUndefined();
  });

  it('the HDLC keepalive latch is not read on a PPP end', () => {
    const r = link({ ppp: UP, keepaliveLatched: true }, { ppp: UP, keepaliveLatched: true });
    expect(r.up).toBe(true);
    expect(r).not.toHaveProperty('downReason');
  });

  it('no clock and a mismatch come first, whatever PPP reported; the line is then not ready', () => {
    const noClock = evaluateSerialLine({ a: end({ ppp: UP }), b: end({ ppp: UP }), dceEnd: 'a' });
    expect([noClock.a.lineProtocolReason, noClock.b.lineProtocolReason, noClock.downReason]).toEqual(['no-clock', 'no-clock', 'no-clock']);
    expect(serialLineReady(noClock)).toBe(false);
    const mismatch = link({ ppp: UP }, { encap: 'hdlc' });
    expect([mismatch.a.lineProtocolReason, mismatch.b.lineProtocolReason, mismatch.downReason]).toEqual(['encapsulation-mismatch', 'encapsulation-mismatch', 'encapsulation-mismatch']);
    expect(serialLineReady(mismatch)).toBe(false);
    expect(serialLineReady(undefined)).toBe(false); // no carrier
    expect(serialLineNotifies('ppp', 'hdlc')).toBe(true);
    expect(serialLineNotifies('hdlc', 'ppp')).toBe(true);
    expect(serialLineNotifies('hdlc', 'hdlc')).toBe(false);
  });

  it('HDLC links evaluate exactly as before (a report on an HDLC end is ignored)', () => {
    const hdlc = (a: Partial<SerialEndInput>, b: Partial<SerialEndInput>) => link({ encap: 'hdlc', ...a }, { encap: 'hdlc', ...b });
    expect(hdlc({}, {})).toEqual({
      up: true,
      a: { carrier: true, lineProtocol: true, dce: true },
      b: { carrier: true, lineProtocol: true, dce: false },
      operUp: { a: true, b: true },
      dceEnd: 'a',
      clockBps: 64_000,
      negotiatedBps: 64_000,
    });
    const latched = hdlc({ keepaliveLatched: true, ppp: UP }, { ppp: { up: false, reason: 'ppp-auth-failed' } });
    expect(latched.operUp).toEqual({ a: false, b: true });
    expect(latched.a.lineProtocolReason).toBe('keepalive-missed');
    expect(latched.downReason).toBe('keepalive-missed');
    expect(serialLineReady(hdlc({}, {}))).toBe(true);
  });

  it('the PPP reasons have original explanations', () => {
    expect(Object.keys(SERIAL_DOWN_TEXT)).toEqual(['no-clock', 'encapsulation-mismatch', 'keepalive-missed', 'ppp-negotiating', 'ppp-auth-failed']);
    for (const text of Object.values(SERIAL_DOWN_TEXT)) expect(text.length).toBeGreaterThan(20);
  });
});

describe('serialControlExempt ([S19])', () => {
  const frame = (proto: string, fields: Record<string, unknown>) => ({ layers: [{ proto, fields }] }) as unknown as Parameters<typeof keepaliveExempt>[0];
  const ppp = (protocol: number) => frame('ppp', { address: 0xff, control: 0x03, protocol });
  const keepalive = frame('hdlc', { protocol: HDLC_PROTO_KEEPALIVE });
  const phy = (lineProtocol: boolean, reason?: string, carrier = true): PortPhy => (reason === undefined ? { carrier, lineProtocol } : { carrier, lineProtocol, lineProtocolReason: reason });

  it('PPP control frames flow on a ppp port down only by PPP; data frames and other outages stay blocked', () => {
    expect(SERIAL_PPP_CONTROL_PROTOCOLS).toEqual([PPP_PROTO.lcp, PPP_PROTO.pap, PPP_PROTO.chap, PPP_PROTO.ipcp, PPP_PROTO.ipv6cp]);
    for (const reason of ['ppp-negotiating', 'ppp-auth-failed', 'keepalive-missed']) {
      for (const protocol of SERIAL_PPP_CONTROL_PROTOCOLS) {
        expect([reason, protocol, serialControlExempt(ppp(protocol), { encap: 'ppp', phy: phy(false, reason) })]).toEqual([reason, protocol, true]);
      }
      expect(serialControlExempt(ppp(PPP_PROTO.ipv4), { encap: 'ppp', phy: phy(false, reason) })).toBe(false);
      expect(serialControlExempt(ppp(PPP_PROTO.ipv6), { encap: 'ppp', phy: phy(false, reason) })).toBe(false);
    }
    for (const reason of ['no-clock', 'encapsulation-mismatch', undefined]) {
      expect(serialControlExempt(ppp(PPP_PROTO.lcp), { encap: 'ppp', phy: phy(false, reason) })).toBe(false);
    }
    expect(serialControlExempt(ppp(PPP_PROTO.lcp), { encap: 'ppp', phy: phy(false, 'ppp-negotiating', false) })).toBe(false); // no carrier
    expect(serialControlExempt(ppp(PPP_PROTO.lcp), { encap: 'hdlc', phy: phy(false, 'keepalive-missed') })).toBe(false); // not a ppp port
    expect(serialControlExempt(ppp(PPP_PROTO.lcp), { phy: phy(false, 'ppp-negotiating') })).toBe(false);
    expect(serialControlExempt(ppp(PPP_PROTO.lcp), { encap: 'ppp' })).toBe(false);
    expect(downOnlyBySerialPpp({ encap: 'ppp', phy: phy(true) })).toBe(false); // up: nothing to exempt
  });

  it('isSerialPppControlFrame reads the outermost layer only', () => {
    expect(isSerialPppControlFrame(ppp(PPP_PROTO.chap))).toBe(true);
    expect(isSerialPppControlFrame(ppp(PPP_PROTO.ipv4))).toBe(false);
    expect(isSerialPppControlFrame(frame('hdlc', { protocol: PPP_PROTO.lcp }))).toBe(false);
    expect(isSerialPppControlFrame(frame('ppp', { protocol: 'lcp' }))).toBe(false);
    expect(isSerialPppControlFrame({ layers: [] } as unknown as Parameters<typeof keepaliveExempt>[0])).toBe(false);
  });

  it('every non-PPP frame gets exactly the keepaliveExempt answer', () => {
    const ports = [
      { phy: phy(false, 'keepalive-missed') },
      { phy: phy(false, 'keepalive-missed', false) },
      { phy: phy(false, 'no-clock') },
      { phy: phy(false, 'ppp-negotiating') },
      { phy: phy(true) },
      {},
      { encap: 'hdlc' as const, phy: phy(false, 'keepalive-missed') },
      { encap: 'ppp' as const, phy: phy(false, 'keepalive-missed') },
    ];
    const frames = [keepalive, frame('hdlc', { protocol: 0x0800 }), frame('ethernet', { type: 0x0800 }), { layers: [] } as unknown as Parameters<typeof keepaliveExempt>[0]];
    for (const p of ports) for (const f of frames) expect(serialControlExempt(f, p)).toBe(keepaliveExempt(f, p));
    expect(serialControlExempt(keepalive, { phy: phy(false, 'keepalive-missed') })).toBe(true);
  });
});
