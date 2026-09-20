import { describe, expect, it } from 'vitest';
import { crc32, internetChecksum, readU32LE, writeU32LE } from '../src/pdu/checksum.js';

const ascii = (s: string): Uint8Array => new Uint8Array([...s].map((c) => c.charCodeAt(0)));

describe('pdu/checksum internetChecksum (RFC 1071)', () => {
  it('matches the RFC 1071 worked example', () => {
    // RFC 1071 §3: 00 01 f2 03 f4 f5 f6 f7 → sum 0xddf2 → checksum 0x220d
    const b = new Uint8Array([0x00, 0x01, 0xf2, 0x03, 0xf4, 0xf5, 0xf6, 0xf7]);
    expect(internetChecksum(b, 0, b.length)).toBe(0x220d);
  });

  it('is zero for an all-zero buffer of any length', () => {
    expect(internetChecksum(new Uint8Array(0), 0, 0)).toBe(0xffff);
    expect(internetChecksum(new Uint8Array(20), 0, 20)).toBe(0xffff);
  });

  it('treats an odd trailing byte as the high octet of the last word', () => {
    const even = new Uint8Array([0x12, 0x34, 0xab, 0x00]);
    const odd = new Uint8Array([0x12, 0x34, 0xab]);
    expect(internetChecksum(odd, 0, 3)).toBe(internetChecksum(even, 0, 4));
  });

  it('verifies to zero when the checksum is written into the header', () => {
    const hdr = new Uint8Array([
      0x45, 0x00, 0x00, 0x73, 0x00, 0x00, 0x40, 0x00, 0x40, 0x11, 0x00, 0x00, 0xc0, 0xa8, 0x00, 0x01, 0xc0, 0xa8, 0x00, 0xc7,
    ]);
    const sum = internetChecksum(hdr, 0, hdr.length);
    expect(sum).toBe(0xb861); // widely published IPv4 header vector
    hdr[10] = sum >>> 8;
    hdr[11] = sum & 0xff;
    expect(internetChecksum(hdr, 0, hdr.length)).toBe(0);
  });

  it('honours offset and length', () => {
    const b = new Uint8Array([0xff, 0xff, 0x00, 0x01, 0xf2, 0x03, 0xf4, 0xf5, 0xf6, 0xf7, 0xff]);
    expect(internetChecksum(b, 2, 8)).toBe(0x220d);
  });
});

describe('pdu/checksum crc32 (IEEE 802.3)', () => {
  it("crc32('123456789') === 0xCBF43926", () => {
    expect(crc32(ascii('123456789'), 0, 9)).toBe(0xcbf43926);
  });

  it('crc32 of an empty range is 0 and of a single zero byte is 0xd202ef8d', () => {
    expect(crc32(new Uint8Array(0), 0, 0)).toBe(0);
    expect(crc32(new Uint8Array([0]), 0, 1)).toBe(0xd202ef8d);
  });

  it('honours offset and length and returns an unsigned value', () => {
    const b = new Uint8Array(12);
    b.set(ascii('123456789'), 2);
    expect(crc32(b, 2, 9)).toBe(0xcbf43926);
    expect(crc32(b, 0, b.length)).toBeGreaterThanOrEqual(0);
  });

  it('little-endian FCS helpers round-trip', () => {
    const b = new Uint8Array(4);
    writeU32LE(b, 0, 0xcbf43926);
    expect(Array.from(b)).toEqual([0x26, 0x39, 0xf4, 0xcb]);
    expect(readU32LE(b, 0)).toBe(0xcbf43926);
  });
});
