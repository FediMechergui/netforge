// core/ospf-lsa (ARCHITECTURE-P3 D7, D9, §2.6; RFC 2328 §12.1, §13.1, A.4; §7 W1 core): sequence numbers, the live
// age, which instance is newer, the wire layout of router, network and AS-external LSAs, and the Fletcher checksum
// (checked against an independent brute-force definition: the two check octets that zero both sums).
import { describe, expect, it } from 'vitest';
import type { OspfLsaRow } from '../src/contracts/tables.js';
import { SEC } from '../src/contracts/time.js';
import {
  compareLsaInstances,
  compareLsaSeq,
  encodeLsaBytes,
  lsaAgeAt,
  lsaChecksumAndLength,
  lsaChecksumOf,
  lsaChecksumOk,
  lsaLength,
  lsaSeqSigned,
  LSA_INITIAL_SEQ,
  LSA_MAX_AGE_S,
  LSA_MAX_SEQ,
  nextLsaSeq,
  type LsaContent,
} from '../src/core/ospf-lsa.js';

const routerLsa: LsaContent = {
  type: 1,
  lsid: '1.1.1.1',
  advRouter: '1.1.1.1',
  seq: LSA_INITIAL_SEQ,
  options: 0x02,
  flags: { b: false, e: false, v: false },
  links: [
    { kind: 'transit', id: '10.0.123.2', data: '10.0.123.1', metric: 1 },
    { kind: 'p2p', id: '3.3.3.3', data: '10.0.13.1', metric: 64 },
    { kind: 'stub', id: '10.0.13.0', data: '255.255.255.252', metric: 64 },
  ],
};
const networkLsa: LsaContent = { type: 2, lsid: '10.0.123.2', advRouter: '2.2.2.2', seq: 0x80000003, options: 0x02, mask: '255.255.255.0', attached: ['2.2.2.2', '1.1.1.1', '3.3.3.3'] };
const externalLsa: LsaContent = {
  type: 5,
  lsid: '0.0.0.0',
  advRouter: '2.2.2.2',
  seq: 0x80000001,
  options: 0x02,
  mask: '0.0.0.0',
  metric: 1,
  external: { e2: true, forward: '0.0.0.0', tag: 1 },
};

/** Independent Fletcher definition: the unique check octets X, Y in 1..255 that make C0 = C1 = 0 (mod 255). */
function bruteForceChecksum(bytes: Uint8Array): number[] {
  const b = bytes.slice();
  const found: number[] = [];
  for (let x = 1; x <= 255; x++) {
    b[16] = x;
    // C0 and C1 are linear in Y: try each
    for (let y = 1; y <= 255; y++) {
      b[17] = y;
      let c0 = 0;
      let c1 = 0;
      for (let i = 2; i < b.length; i++) {
        c0 = (c0 + b[i]!) % 255;
        c1 = (c1 + c0) % 255;
      }
      if (c0 === 0 && c1 === 0) found.push((x << 8) | y);
    }
  }
  return found;
}

describe('core/ospf-lsa: sequence numbers', () => {
  it('are signed 32-bit values stored as u32', () => {
    expect(LSA_INITIAL_SEQ).toBe(0x80000001);
    expect(lsaSeqSigned(LSA_INITIAL_SEQ)).toBe(-0x7fffffff);
    expect(lsaSeqSigned(0xffffffff)).toBe(-1);
    expect(compareLsaSeq(0x80000001, 0x80000002)).toBeLessThan(0);
    expect(compareLsaSeq(0x80000002, 0x80000001)).toBeGreaterThan(0);
    expect(compareLsaSeq(0x7fffffff, 0x80000001)).toBeGreaterThan(0);
    expect(compareLsaSeq(0xffffffff, 0)).toBeLessThan(0);
    expect(compareLsaSeq(0, 1)).toBeLessThan(0);
    expect(compareLsaSeq(0x80000005, 0x80000005)).toBe(0);
  });

  it('the next number, and none after MaxSequenceNumber', () => {
    expect(nextLsaSeq(LSA_INITIAL_SEQ)).toBe(0x80000002);
    expect(nextLsaSeq(0xffffffff)).toBe(0);
    expect(nextLsaSeq(0)).toBe(1);
    expect(nextLsaSeq(0x7ffffffe)).toBe(LSA_MAX_SEQ);
    expect(nextLsaSeq(LSA_MAX_SEQ)).toBeUndefined();
  });
});

describe('core/ospf-lsa: age', () => {
  const row = { ageAtInstall: 1, installedAt: 10 * SEC };
  it('adds whole seconds since installation, capped at MaxAge', () => {
    expect(lsaAgeAt(row, 10 * SEC)).toBe(1);
    expect(lsaAgeAt(row, 10 * SEC + 999_999_999)).toBe(1);
    expect(lsaAgeAt(row, 15 * SEC + 900_000_000)).toBe(6);
    expect(lsaAgeAt(row, 5 * SEC)).toBe(1);
    expect(lsaAgeAt(row, 10_000 * SEC)).toBe(LSA_MAX_AGE_S);
    expect(lsaAgeAt({ ...row, maxAge: true }, 10 * SEC)).toBe(3600);
  });
});

describe('core/ospf-lsa: the newer instance (RFC 2328 §13.1)', () => {
  const base = { seq: 0x80000005, checksum: 0x1234, age: 100 };
  it('compares the sequence number, then the checksum, then MaxAge, then an age gap above MaxAgeDiff', () => {
    expect(compareLsaInstances({ ...base, seq: 0x80000006 }, base)).toBe(1);
    expect(compareLsaInstances(base, { ...base, seq: 0x80000006 })).toBe(-1);
    // a higher sequence wins over a higher checksum and over MaxAge
    expect(compareLsaInstances({ ...base, seq: 0x80000006, checksum: 1 }, { ...base, age: 3600 })).toBe(1);
    expect(compareLsaInstances({ ...base, checksum: 0x1235 }, base)).toBe(1);
    expect(compareLsaInstances(base, { ...base, checksum: 0x1235 })).toBe(-1);
    expect(compareLsaInstances({ ...base, age: 3600 }, base)).toBe(1);
    expect(compareLsaInstances(base, { ...base, age: 3600 })).toBe(-1);
    expect(compareLsaInstances({ ...base, age: 3600 }, { ...base, age: 3600 })).toBe(0);
    expect(compareLsaInstances({ ...base, age: 100 }, { ...base, age: 1001 })).toBe(1);
    expect(compareLsaInstances({ ...base, age: 1001 }, { ...base, age: 100 })).toBe(-1);
    expect(compareLsaInstances({ ...base, age: 100 }, { ...base, age: 1000 })).toBe(0);
    expect(compareLsaInstances(base, base)).toBe(0);
  });
});

describe('core/ospf-lsa: wire layout (RFC 2328 A.4)', () => {
  it('lays out a router LSA: header, flags, link count, 12 bytes per link', () => {
    const b = encodeLsaBytes(routerLsa, 7);
    expect(b.length).toBe(lsaLength(routerLsa));
    expect(b.length).toBe(20 + 4 + 3 * 12);
    expect([...b.slice(0, 20)].slice(0, 16)).toEqual([0, 7, 0x02, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0x80, 0, 0, 1]);
    expect((b[18]! << 8) | b[19]!).toBe(60);
    expect([...b.slice(20, 24)]).toEqual([0, 0, 0, 3]);
    // transit link, then the p2p link with metric 64, then the stub
    expect([...b.slice(24, 36)]).toEqual([10, 0, 123, 2, 10, 0, 123, 1, 2, 0, 0, 1]);
    expect([...b.slice(36, 48)]).toEqual([3, 3, 3, 3, 10, 0, 13, 1, 1, 0, 0, 64]);
    expect([...b.slice(48, 60)]).toEqual([10, 0, 13, 0, 255, 255, 255, 252, 3, 0, 0, 64]);
    const flagged = encodeLsaBytes({ ...routerLsa, flags: { b: true, e: true, v: true } });
    expect(flagged[20]).toBe(7);
  });

  it('lays out a network LSA and an AS-external LSA', () => {
    const n = encodeLsaBytes(networkLsa);
    expect(n.length).toBe(20 + 4 + 3 * 4);
    expect([...n.slice(20)]).toEqual([255, 255, 255, 0, 2, 2, 2, 2, 1, 1, 1, 1, 3, 3, 3, 3]);
    const e = encodeLsaBytes(externalLsa);
    expect(e.length).toBe(36);
    expect([...e.slice(20)]).toEqual([0, 0, 0, 0, 0x80, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 1]);
    const e1 = encodeLsaBytes({ ...externalLsa, metric: 0x123456, external: { e2: false, forward: '10.0.0.9', tag: 0xfffffffe } });
    expect([...e1.slice(24)]).toEqual([0x00, 0x12, 0x34, 0x56, 10, 0, 0, 9, 0xff, 0xff, 0xff, 0xfe]);
  });

  it('the age field is capped at MaxAge', () => {
    const b = encodeLsaBytes(routerLsa, 99_999);
    expect((b[0]! << 8) | b[1]!).toBe(3600);
  });
});

describe('core/ospf-lsa: Fletcher checksum (RFC 2328 §12.1.7)', () => {
  it('equals the brute-force definition for router, network and external LSAs', () => {
    for (const lsa of [routerLsa, networkLsa, externalLsa]) {
      const b = encodeLsaBytes(lsa);
      const sum = (b[16]! << 8) | b[17]!;
      expect(bruteForceChecksum(b)).toEqual([sum]);
      expect(lsaChecksumOf(b)).toBe(sum);
      expect(b[16]).not.toBe(0);
      expect(b[17]).not.toBe(0);
      expect(lsaChecksumOk(b)).toBe(true);
    }
  });

  it('excludes the age, ignores what the checksum field held, and detects a changed byte', () => {
    const a = encodeLsaBytes(routerLsa, 0);
    const b = encodeLsaBytes(routerLsa, 1234);
    expect(lsaChecksumOf(a)).toBe(lsaChecksumOf(b));
    expect([a[16], a[17]]).toEqual([b[16], b[17]]);
    expect(lsaChecksumOk(b)).toBe(true);
    const junk = a.slice();
    junk[16] = 0xaa;
    junk[17] = 0x55;
    expect(lsaChecksumOf(junk)).toBe(lsaChecksumOf(a));
    expect(lsaChecksumOk(junk)).toBe(false);
    for (let i = 2; i < a.length; i++) {
      const c = a.slice();
      c[i] = c[i]! ^ 0x01;
      expect(lsaChecksumOk(c), `byte ${i}`).toBe(false);
    }
    // the modulo-255 blind spot of every Fletcher checksum: 0x00 and 0xff are the same value
    const blind = a.slice();
    blind[52] = blind[52] === 0xff ? 0x00 : blind[52]!;
    expect(a[52]).toBe(0xff);
    expect(lsaChecksumOk(blind)).toBe(true);
    expect(lsaChecksumOk(a.slice(0, 19))).toBe(false);
  });

  it('a new sequence number changes the checksum; the row values come from the bytes', () => {
    const first = lsaChecksumAndLength(routerLsa);
    const second = lsaChecksumAndLength({ ...routerLsa, seq: nextLsaSeq(routerLsa.seq)! });
    expect(first.length).toBe(60);
    expect(second.length).toBe(60);
    expect(first.checksum).not.toBe(second.checksum);
    const b = encodeLsaBytes(networkLsa);
    expect(lsaChecksumAndLength(networkLsa)).toEqual({ checksum: (b[16]! << 8) | b[17]!, length: b.length });
    // an OspfLsaRow carries every field the bytes need
    const row: OspfLsaRow = {
      key: 'x', scope: '0.0.0.0', ...networkLsa, type: 2, ageAtInstall: 0, installedAt: 0, checksum: 0, length: 0, self: false,
    } as OspfLsaRow;
    expect(lsaChecksumAndLength(row)).toEqual(lsaChecksumAndLength(networkLsa));
  });
});
