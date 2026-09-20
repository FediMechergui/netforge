import { describe, expect, it } from 'vitest';
import {
  MAX_CAPTURE_IMPORT_BYTES,
  MAX_CAPTURE_IMPORT_RECORDS,
  PCAP_MIXED_LINKTYPE_MESSAGE,
  type CaptureFile,
  type CaptureInterface,
  type CaptureRecord,
} from '../src/contracts/capture.js';
import { SEC } from '../src/contracts/time.js';
import { readCapture, writeCapture } from '../src/io/pcap.js';

// ── fixtures ──

function frame(len: number, seed: number): Uint8Array {
  const b = new Uint8Array(len);
  for (let i = 0; i < len; i++) b[i] = (seed * 31 + i * 7) & 0xff;
  return b;
}

const ETH0: CaptureInterface = { index: 0, name: 'PC1 Gi0', linkType: 'ethernet', fcsLen: 4 };
const ETH1: CaptureInterface = { index: 1, name: 'SW1 Fa0/1', linkType: 'ethernet', fcsLen: 4 };
const WLAN: CaptureInterface = { index: 2, name: 'AP1 Wl0', linkType: 'ieee802_11', fcsLen: 0 };

function sample(): CaptureFile {
  return {
    interfaces: [ETH0, ETH1],
    records: [
      { index: 0, t: 0, iface: 0, dir: 'tx', bytes: frame(64, 1), origLen: 64 },
      { index: 1, t: 1_500, iface: 1, dir: 'rx', bytes: frame(98, 2), origLen: 98 },
      { index: 2, t: 2 * SEC + 7, iface: 0, dir: 'rx', bytes: frame(65, 3), origLen: 65, corrupted: true },
      { index: 3, t: 5 * SEC, iface: 1, dir: 'unknown', bytes: frame(30, 4), origLen: 64 },
    ],
  };
}

/** Records without live-only members, for round-trip comparison. */
function plain(records: readonly CaptureRecord[]): CaptureRecord[] {
  return records.map(({ pdu: _pdu, ...rest }) => ({ ...rest, bytes: new Uint8Array(rest.bytes) }));
}

const le = (b: Uint8Array) => new DataView(b.buffer, b.byteOffset, b.byteLength);

/** Walk little-endian pcapng blocks: [type, offset, length]. */
function blocks(b: Uint8Array): [number, number, number][] {
  const v = le(b);
  const out: [number, number, number][] = [];
  for (let off = 0; off < b.length; ) {
    const len = v.getUint32(off + 4, true);
    out.push([v.getUint32(off, true), off, len]);
    off += len;
  }
  return out;
}

/** Test-side builder for hand-made files in either byte order. */
class Builder {
  parts: number[] = [];
  constructor(readonly little: boolean) {}
  u8(v: number): this {
    this.parts.push(v & 0xff);
    return this;
  }
  u16(v: number): this {
    const b = [v & 0xff, (v >>> 8) & 0xff];
    this.parts.push(...(this.little ? b : b.reverse()));
    return this;
  }
  u32(v: number): this {
    const b = [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff];
    this.parts.push(...(this.little ? b : b.reverse()));
    return this;
  }
  raw(bytes: ArrayLike<number>): this {
    for (let i = 0; i < bytes.length; i++) this.parts.push(bytes[i] as number);
    return this;
  }
  pad(): this {
    while (this.parts.length % 4 !== 0) this.parts.push(0);
    return this;
  }
  bytes(): Uint8Array {
    return Uint8Array.from(this.parts);
  }
}

/** One pcapng block in the given byte order. */
function ngBlock(little: boolean, type: number, body: (b: Builder) => void): number[] {
  const inner = new Builder(little);
  body(inner);
  inner.pad();
  const len = inner.parts.length + 12;
  return new Builder(little).u32(type).u32(len).raw(inner.parts).u32(len).parts;
}

function ngOption(b: Builder, code: number, value: number[]): void {
  b.u16(code).u16(value.length).raw(value).pad();
}

function shb(little: boolean): number[] {
  return ngBlock(little, 0x0a0d0d0a, (b) => {
    b.u32(0x1a2b3c4d).u16(1).u16(0).u32(0xffffffff).u32(0xffffffff);
  });
}

describe('pcapng export', () => {
  it('writes SHB, one IDB per interface and one EPB per record (pcapng block layout)', () => {
    const out = writeCapture(sample(), { format: 'pcapng' });
    const v = le(out);
    const bl = blocks(out);
    expect(bl.map(([t]) => t)).toEqual([0x0a0d0d0a, 1, 1, 6, 6, 6, 6]);
    // SHB: magic, BOM, version 1.0, section length -1.
    expect(v.getUint32(0, true)).toBe(0x0a0d0d0a);
    expect(v.getUint32(8, true)).toBe(0x1a2b3c4d);
    expect(v.getUint16(12, true)).toBe(1);
    expect(v.getUint16(14, true)).toBe(0);
    expect(v.getBigUint64(16, true)).toBe(0xffffffffffffffffn);
    for (const [, off, len] of bl) {
      expect(len % 4).toBe(0);
      expect(v.getUint32(off + len - 4, true)).toBe(len);
    }
    // IDB: linktype 1, snaplen 0, options if_name, if_tsresol 9, if_fcslen 4.
    const [, idb, idbLen] = bl[1] as [number, number, number];
    expect(v.getUint16(idb + 8, true)).toBe(1);
    expect(v.getUint32(idb + 12, true)).toBe(0);
    const opts: Record<number, number[]> = {};
    for (let o = idb + 16; o < idb + idbLen - 4; ) {
      const code = v.getUint16(o, true);
      const len = v.getUint16(o + 2, true);
      if (code === 0) break;
      opts[code] = [...out.subarray(o + 4, o + 4 + len)];
      o += 4 + ((len + 3) & ~3);
    }
    expect(new TextDecoder().decode(Uint8Array.from(opts[2] ?? []))).toBe('PC1 Gi0');
    expect(opts[9]).toEqual([9]);
    expect(opts[13]).toEqual([4]);
    // EPB of record 2: interface 0, ns timestamp, lengths, data, epb_flags inbound + CRC error.
    const [, epb] = bl[5] as [number, number, number];
    expect(v.getUint32(epb + 8, true)).toBe(0);
    const ts = (BigInt(v.getUint32(epb + 12, true)) << 32n) | BigInt(v.getUint32(epb + 16, true));
    expect(ts).toBe(2_000_000_007n);
    expect(v.getUint32(epb + 20, true)).toBe(65);
    expect(v.getUint32(epb + 24, true)).toBe(65);
    expect([...out.subarray(epb + 28, epb + 28 + 65)]).toEqual([...frame(65, 3)]);
    const optAt = epb + 28 + 68;
    expect(v.getUint16(optAt, true)).toBe(2);
    expect(v.getUint16(optAt + 2, true)).toBe(4);
    expect(v.getUint32(optAt + 4, true)).toBe((1 << 24) | 1);
    // EPB of the unknown-direction record carries no options.
    const [, epb4, epb4Len] = bl[6] as [number, number, number];
    expect(epb4Len).toBe(32 + 32);
    expect(v.getUint32(epb4 + 24, true)).toBe(64);
  });

  it('is byte-identical over repeated exports with baseWallNs 0 and shifts by baseWallNs', () => {
    const runs = [0, 1, 2].map(() => writeCapture(sample(), { format: 'pcapng', baseWallNs: 0n }));
    expect(runs[1]).toEqual(runs[0]);
    expect(runs[2]).toEqual(runs[0]);
    expect(writeCapture(sample(), { format: 'pcapng' })).toEqual(runs[0]);
    const wall = 1_700_000_000_123_456_789n;
    const shifted = writeCapture(sample(), { format: 'pcapng', baseWallNs: wall });
    const v = le(shifted);
    const [, epb] = blocks(shifted)[3] as [number, number, number];
    const ts = (BigInt(v.getUint32(epb + 12, true)) << 32n) | BigInt(v.getUint32(epb + 16, true));
    expect(ts).toBe(wall);
    // Re-import rebases wall-clock times onto the first record.
    const back = readCapture(shifted);
    expect(back.records.map((r) => r.t)).toEqual(sample().records.map((r) => r.t));
  });

  it('round-trips interfaces, records, direction, corruption and fcsLen exactly', () => {
    const file = sample();
    const back = readCapture(writeCapture(file, { format: 'pcapng' }));
    expect(back.interfaces).toEqual(file.interfaces);
    expect(plain(back.records)).toEqual(plain(file.records));
    const mixed: CaptureFile = {
      interfaces: [ETH0, { index: 1, name: 'R1 Se0/0/0', linkType: 'c_hdlc', fcsLen: 0 }, WLAN, { index: 3, name: 'raw', linkType: 'raw', fcsLen: 0 }],
      records: [
        { index: 0, t: 10, iface: 2, dir: 'tx', bytes: frame(40, 9), origLen: 40 },
        { index: 1, t: 20, iface: 1, dir: 'rx', bytes: frame(24, 8), origLen: 24 },
        { index: 2, t: 30, iface: 3, dir: 'tx', bytes: Uint8Array.of(0x60, 0, 0, 0), origLen: 4 },
      ],
    };
    const mixedBack = readCapture(writeCapture(mixed, { format: 'pcapng' }));
    expect(mixedBack.interfaces).toEqual(mixed.interfaces);
    expect(plain(mixedBack.records)).toEqual(plain(mixed.records));
  });

  it('refuses records whose interface is not listed and negative times', () => {
    const file = sample();
    const bad: CaptureFile = { ...file, records: [{ index: 0, t: 0, iface: 9, dir: 'tx', bytes: frame(10, 1), origLen: 10 }] };
    expect(() => writeCapture(bad, { format: 'pcapng' })).toThrow(/interface 9/);
    const neg: CaptureFile = { ...file, records: [{ index: 0, t: -1, iface: 0, dir: 'tx', bytes: frame(10, 1), origLen: 10 }] };
    expect(() => writeCapture(neg, { format: 'pcap' })).toThrow(/invalid time/);
  });
});

describe('classic pcap export', () => {
  it('writes the nanosecond magic, one link type, and strips the FCS', () => {
    const out = writeCapture(sample(), { format: 'pcap' });
    const v = le(out);
    expect(v.getUint32(0, true)).toBe(0xa1b23c4d);
    expect(v.getUint16(4, true)).toBe(2);
    expect(v.getUint16(6, true)).toBe(4);
    expect(v.getUint32(8, true)).toBe(0);
    expect(v.getUint32(12, true)).toBe(0);
    expect(v.getUint32(16, true)).toBe(262_144);
    expect(v.getUint32(20, true)).toBe(1);
    // record 0: 64 bytes → 60 captured, orig 60.
    expect(v.getUint32(24, true)).toBe(0);
    expect(v.getUint32(28, true)).toBe(0);
    expect(v.getUint32(32, true)).toBe(60);
    expect(v.getUint32(36, true)).toBe(60);
    expect([...out.subarray(40, 100)]).toEqual([...frame(64, 1).subarray(0, 60)]);
    // record 2 at 2 s + 7 ns
    let off = 40 + 60;
    off += 16 + 94;
    expect(v.getUint32(off, true)).toBe(2);
    expect(v.getUint32(off + 4, true)).toBe(7);
    expect(v.getUint32(off + 8, true)).toBe(61);
    off += 16 + 61;
    // record 3 was truncated (30 of 64): the FCS was never captured, nothing is stripped; orig 60.
    expect(v.getUint32(off + 8, true)).toBe(30);
    expect(v.getUint32(off + 12, true)).toBe(60);
    expect(off + 16 + 30).toBe(out.length);
  });

  it('strips only the captured part of a partially captured FCS', () => {
    const file: CaptureFile = { interfaces: [ETH0], records: [{ index: 0, t: 0, iface: 0, dir: 'tx', bytes: frame(62, 1), origLen: 64 }] };
    const back = readCapture(writeCapture(file, { format: 'pcap' }));
    expect(back.records[0]?.bytes).toEqual(frame(62, 1).subarray(0, 60));
    expect(back.records[0]?.origLen).toBe(60);
    expect(back.interfaces).toEqual([{ index: 0, name: 'Interface 0', linkType: 'ethernet', fcsLen: 0 }]);
  });

  it('refuses mixed link types with the original message', () => {
    const file: CaptureFile = { interfaces: [ETH0, WLAN], records: [] };
    expect(() => writeCapture(file, { format: 'pcap' })).toThrow(PCAP_MIXED_LINKTYPE_MESSAGE);
    expect(() => writeCapture(file, { format: 'pcapng' })).not.toThrow();
  });

  it('is deterministic and re-imports with the same times', () => {
    const a = writeCapture(sample(), { format: 'pcap' });
    expect(writeCapture(sample(), { format: 'pcap' })).toEqual(a);
    const back = readCapture(a);
    expect(back.records.map((r) => [r.t, r.iface, r.dir])).toEqual(sample().records.map((r) => [r.t, 0, 'unknown']));
  });

  it('refuses times beyond the 32-bit seconds field', () => {
    expect(() => writeCapture(sample(), { format: 'pcap', baseWallNs: 1n << 62n })).toThrow(/pcapng instead/);
  });
});

describe('capture import', () => {
  it('reads big-endian classic pcap with microsecond timestamps', () => {
    const b = new Builder(false).u32(0xa1b2c3d4).u16(2).u16(4).u32(0).u32(0).u32(65535).u32(105);
    b.u32(3).u32(250).u32(4).u32(10).raw([1, 2, 3, 4]);
    b.u32(3).u32(251).u32(2).u32(2).raw([9, 9]);
    const f = readCapture(b.bytes());
    expect(f.interfaces).toEqual([{ index: 0, name: 'Interface 0', linkType: 'ieee802_11', fcsLen: 0 }]);
    expect(f.records).toEqual([
      { index: 0, t: 3_000_250_000, iface: 0, dir: 'unknown', bytes: Uint8Array.of(1, 2, 3, 4), origLen: 10 },
      { index: 1, t: 3_000_251_000, iface: 0, dir: 'unknown', bytes: Uint8Array.of(9, 9), origLen: 2 },
    ]);
  });

  it('reads little-endian microsecond and big-endian nanosecond magics, and raw IP link types', () => {
    const us = new Builder(true).u32(0xa1b2c3d4).u16(2).u16(4).u32(0).u32(0).u32(65535).u32(228);
    us.u32(1).u32(1).u32(1).u32(1).raw([0x45]);
    expect(readCapture(us.bytes()).records[0]?.t).toBe(1_000_001_000);
    expect(readCapture(us.bytes()).interfaces[0]?.linkType).toBe('raw');
    const ns = new Builder(false).u32(0xa1b23c4d).u16(2).u16(4).u32(0).u32(0).u32(65535).u32(104);
    ns.u32(1).u32(1).u32(1).u32(1).raw([0x0f]);
    expect(readCapture(ns.bytes()).records[0]?.t).toBe(1_000_000_001);
    expect(readCapture(ns.bytes()).interfaces[0]?.linkType).toBe('c_hdlc');
  });

  it('reads big-endian pcapng with µs default resolution, tsoffset, SPB, obsolete PB and unknown blocks', () => {
    const idb = ngBlock(false, 1, (b) => {
      b.u16(1).u16(0).u32(96);
      ngOption(b, 2, [...new TextEncoder().encode('eth0')]);
      ngOption(b, 13, [4]);
      b.u32(0);
    });
    const idb2 = ngBlock(false, 1, (b) => {
      b.u16(1).u16(0).u32(0);
      ngOption(b, 9, [0x80 | 10]);
      ngOption(b, 14, [0, 0, 0, 0, 0, 0, 0, 2]);
      ngOption(b, 13, [3]);
      b.u32(0);
    });
    const epb = ngBlock(false, 6, (b) => {
      b.u32(0).u32(0).u32(1_000_000).u32(3).u32(3).raw([7, 8, 9]).pad();
      ngOption(b, 2, [0, 0, 0, 2]);
      b.u32(0);
    });
    const unknown = ngBlock(false, 0x0bad, (b) => b.u32(1).u32(2));
    const spb = ngBlock(false, 3, (b) => b.u32(5).raw([1, 2, 3, 4, 5]).pad());
    const pb = ngBlock(false, 2, (b) => b.u16(1).u16(0).u32(0).u32(1024).u32(2).u32(2).raw([5, 6]).pad().u32(0));
    const bytes = Uint8Array.from([...shb(false), ...idb, ...idb2, ...epb, ...unknown, ...spb, ...pb]);
    const f = readCapture(bytes);
    expect(f.interfaces).toEqual([
      { index: 0, name: 'eth0', linkType: 'ethernet', fcsLen: 4 },
      { index: 1, name: 'Interface 1', linkType: 'ethernet', fcsLen: 0 },
    ]);
    expect(f.records).toEqual([
      { index: 0, t: 1_000_000_000, iface: 0, dir: 'tx', bytes: Uint8Array.of(7, 8, 9), origLen: 3 },
      { index: 1, t: 1_000_000_000, iface: 0, dir: 'unknown', bytes: Uint8Array.of(1, 2, 3, 4, 5), origLen: 5 },
      // 1024 units of 2^-10 s = 1 s, plus a 2 s offset.
      { index: 2, t: 3_000_000_000, iface: 1, dir: 'unknown', bytes: Uint8Array.of(5, 6), origLen: 2 },
    ]);
  });

  it('resets interfaces per section and keeps a global interface index', () => {
    const idb = (name: string) => ngBlock(true, 1, (b) => {
      b.u16(1).u16(0).u32(0);
      ngOption(b, 2, [...new TextEncoder().encode(name)]);
      ngOption(b, 9, [9]);
      b.u32(0);
    });
    const epb = (ts: number) => ngBlock(true, 6, (b) => b.u32(0).u32(0).u32(ts).u32(1).u32(1).raw([ts]).pad());
    const bytes = Uint8Array.from([...shb(true), ...idb('a'), ...epb(1), ...shb(false), ...ngBlock(false, 1, (b) => b.u16(105).u16(0).u32(0).u32(0)), ...ngBlock(false, 6, (b) => b.u32(0).u32(0).u32(2_000_000).u32(1).u32(1).raw([2]).pad())]);
    const f = readCapture(bytes);
    expect(f.interfaces.map((i) => [i.index, i.name, i.linkType])).toEqual([[0, 'a', 'ethernet'], [1, 'Interface 1', 'ieee802_11']]);
    expect(f.records.map((r) => [r.iface, r.t])).toEqual([[0, 1], [1, 2_000_000_000]]);
  });

  it('rejects malformed input with original messages', () => {
    expect(() => readCapture(Uint8Array.of(1, 2))).toThrow('This file is neither a pcap nor a pcapng capture.');
    expect(() => readCapture(new TextEncoder().encode('hello world, not a capture'))).toThrow(/neither a pcap nor a pcapng/);
    const good = writeCapture(sample(), { format: 'pcapng' });
    expect(() => readCapture(good.subarray(0, good.length - 3))).toThrow(/cut short/);
    const badLen = new Uint8Array(good);
    le(badLen).setUint32(badLen.length - 4, 12, true);
    expect(() => readCapture(badLen)).toThrow(/mismatched length/);
    const badBom = new Uint8Array(good);
    le(badBom).setUint32(8, 0x11223344, true);
    expect(() => readCapture(badBom)).toThrow(/byte-order mark/);
    const classic = writeCapture(sample(), { format: 'pcap' });
    expect(() => readCapture(classic.subarray(0, 30))).toThrow(/cut short/);
    expect(() => readCapture(classic.subarray(0, 50))).toThrow(/cut short/);
    const unsupported = new Uint8Array(classic);
    le(unsupported).setUint32(20, 127, true);
    expect(() => readCapture(unsupported)).toThrow('NetScope cannot open link type 127; it reads Ethernet, 802.11, HDLC and raw IP captures.');
    const orphan = Uint8Array.from([...shb(true), ...ngBlock(true, 6, (b) => b.u32(3).u32(0).u32(0).u32(0).u32(0))]);
    expect(() => readCapture(orphan)).toThrow(/interface 3/);
    const overrun = Uint8Array.from([...shb(true), ...ngBlock(true, 1, (b) => b.u16(1).u16(0).u32(0)), ...ngBlock(true, 6, (b) => b.u32(0).u32(0).u32(0).u32(99).u32(99))]);
    expect(() => readCapture(overrun)).toThrow(/fewer bytes than it claims/);
    const badOpt = Uint8Array.from([...shb(true), ...ngBlock(true, 1, (b) => b.u16(1).u16(0).u32(0).u16(2).u16(40).u32(0))]);
    expect(() => readCapture(badOpt)).toThrow(/runs past its block/);
  });

  it('applies the import size and record limits', () => {
    expect(() => readCapture(new Uint8Array(MAX_CAPTURE_IMPORT_BYTES + 1))).toThrow(/larger than 64 MB/);
    const n = MAX_CAPTURE_IMPORT_RECORDS + 1;
    const big = new Uint8Array(24 + n * 16);
    const v = le(big);
    v.setUint32(0, 0xa1b23c4d, true);
    v.setUint16(4, 2, true);
    v.setUint16(6, 4, true);
    v.setUint32(16, 65535, true);
    v.setUint32(20, 1, true);
    expect(() => readCapture(big)).toThrow(`The capture holds more than ${MAX_CAPTURE_IMPORT_RECORDS} frames, the most NetScope imports.`);
    const ok = big.subarray(0, 24 + (n - 1) * 16);
    expect(readCapture(ok).records).toHaveLength(MAX_CAPTURE_IMPORT_RECORDS);
  });

  it('copies record bytes out of the input buffer', () => {
    const out = writeCapture(sample(), { format: 'pcapng' });
    const f = readCapture(out);
    out.fill(0);
    expect(f.records[0]?.bytes).toEqual(frame(64, 1));
  });
});
