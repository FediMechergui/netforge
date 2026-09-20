import { describe, expect, it } from 'vitest';
import {
  crc16X25,
  finishChecksum,
  foldOnes,
  internetChecksum,
  onesSum,
  pseudoHeaderSumV4,
  pseudoHeaderSumV6,
  readU16LE,
  writeU16,
  writeU16LE,
} from '../src/pdu/checksum.js';

const ascii = (s: string): Uint8Array => new Uint8Array([...s].map((c) => c.charCodeAt(0)));
const pattern = (n: number): Uint8Array => new Uint8Array(n).map((_, i) => (i * 37 + 11) & 0xff);

describe('pdu/checksum crc16X25 (HDLC FCS)', () => {
  it("crc16X25('123456789') === 0x906E and an empty range is 0", () => {
    expect(crc16X25(ascii('123456789'))).toBe(0x906e);
    expect(crc16X25(new Uint8Array(0))).toBe(0);
  });

  it('honours offset and length', () => {
    const b = new Uint8Array(13);
    b.set(ascii('123456789'), 3);
    expect(crc16X25(b, 3, 9)).toBe(0x906e);
  });

  it('little-endian u16 helpers round-trip', () => {
    const b = new Uint8Array(2);
    writeU16LE(b, 0, 0x906e);
    expect(Array.from(b)).toEqual([0x6e, 0x90]);
    expect(readU16LE(b, 0)).toBe(0x906e);
  });
});

describe('pdu/checksum one\'s-complement accumulators', () => {
  it('chained onesSum over split ranges equals internetChecksum over the whole buffer', () => {
    const even = pattern(64);
    expect(finishChecksum(onesSum(even, 20, 44, onesSum(even, 0, 20)))).toBe(internetChecksum(even));
    const odd = pattern(63);
    expect(finishChecksum(onesSum(odd, 20, 43, onesSum(odd, 0, 20)))).toBe(internetChecksum(odd));
  });

  it('folds carries', () => {
    expect(foldOnes(0x1fffe)).toBe(0xffff);
    expect(onesSum(new Uint8Array([0xff, 0xff]), 0, 2, 0xffff)).toBe(0xffff);
    expect(finishChecksum(0)).toBe(0xffff);
    expect(onesSum(new Uint8Array(100_000).fill(0xff))).toBe(0xffff);
  });

  it('pseudoHeaderSumV4 equals the sum over the explicit 12-byte pseudo-header, for strings and bytes', () => {
    const buf = new Uint8Array([192, 168, 0, 1, 192, 168, 0, 199, 0, 17, 0x00, 0x1c]);
    const expected = onesSum(buf);
    expect(pseudoHeaderSumV4('192.168.0.1', '192.168.0.199', 17, 0x1c)).toBe(expected);
    expect(pseudoHeaderSumV4(new Uint8Array([192, 168, 0, 1]), new Uint8Array([192, 168, 0, 199]), 17, 0x1c)).toBe(expected);
  });

  it('a transport checksum computed with the pseudo-header verifies to zero', () => {
    const udp = new Uint8Array(8 + 5);
    writeU16(udp, 0, 5000);
    writeU16(udp, 2, 53);
    writeU16(udp, 4, udp.length);
    udp.set(ascii('hello'), 8);
    const ph = pseudoHeaderSumV4('10.0.0.1', '10.0.0.2', 17, udp.length);
    writeU16(udp, 6, finishChecksum(onesSum(udp, 0, udp.length, ph)));
    expect(finishChecksum(onesSum(udp, 0, udp.length, ph))).toBe(0);
  });

  it('pseudoHeaderSumV6 equals the sum over the explicit 40-byte pseudo-header', () => {
    const src = pattern(16);
    const dst = pattern(32).subarray(16);
    for (const len of [0x40, 0x12345]) {
      const buf = new Uint8Array(40);
      buf.set(src, 0);
      buf.set(dst, 16);
      buf[32] = (len >>> 24) & 0xff;
      buf[33] = (len >>> 16) & 0xff;
      buf[34] = (len >>> 8) & 0xff;
      buf[35] = len & 0xff;
      buf[39] = 58;
      expect(pseudoHeaderSumV6(src, dst, 58, len)).toBe(onesSum(buf));
    }
    expect(() => pseudoHeaderSumV6(new Uint8Array(4), dst, 58, 8)).toThrow(RangeError);
  });
});
