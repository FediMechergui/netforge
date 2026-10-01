// core/md5.ts (ARCHITECTURE-P3 D17, §7 W1 wan [S19]): the RFC 1321 appendix A.5 test suite, every padding boundary
// against an independent implementation, and the RFC 1994 CHAP response value MD5(id ‖ secret ‖ challenge).
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { MD5_DIGEST_BYTES, chapMd5Response, md5, md5Hex, md5HexOf } from '../src/core/md5.js';

const ascii = (s: string): Uint8Array => new TextEncoder().encode(s);
const reference = (b: Uint8Array): string => createHash('md5').update(b).digest('hex');

describe('md5 (RFC 1321)', () => {
  it('matches the appendix A.5 test suite exactly', () => {
    const suite: readonly (readonly [string, string])[] = [
      ['', 'd41d8cd98f00b204e9800998ecf8427e'],
      ['a', '0cc175b9c0f1b6a831c399e269772661'],
      ['abc', '900150983cd24fb0d6963f7d28e17f72'],
      ['message digest', 'f96b697d7cb7938d525a2f31aaf161d0'],
      ['abcdefghijklmnopqrstuvwxyz', 'c3fcd3d76192e4007dfb496cca67e13b'],
      ['ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789', 'd174ab98d277d9f5a5611c2c9f419d9f'],
      ['12345678901234567890123456789012345678901234567890123456789012345678901234567890', '57edf4a22be3c955ac49da2e2107b67a'],
    ];
    for (const [input, digest] of suite) {
      expect(md5Hex(input), JSON.stringify(input)).toBe(digest);
      expect(md5HexOf(md5(ascii(input)))).toBe(digest);
    }
  });

  it('returns 16 bytes, little-endian words of the final state', () => {
    const d = md5(ascii('abc'));
    expect(d).toBeInstanceOf(Uint8Array);
    expect(d.length).toBe(MD5_DIGEST_BYTES);
    expect(Array.from(d.slice(0, 4))).toEqual([0x90, 0x01, 0x50, 0x98]);
  });

  it('agrees with an independent MD5 at every length from 0 to 300 bytes (every padding boundary)', () => {
    for (let len = 0; len <= 300; len++) {
      const b = new Uint8Array(len);
      for (let i = 0; i < len; i++) b[i] = (i * 131 + len * 7 + 13) & 0xff;
      expect(md5HexOf(md5(b)), `length ${len}`).toBe(reference(b));
    }
  });

  it('agrees on a multi-block message of 100 000 bytes', () => {
    const b = new Uint8Array(100_000);
    for (let i = 0; i < b.length; i++) b[i] = (i ^ (i >>> 8)) & 0xff;
    expect(md5HexOf(md5(b))).toBe(reference(b));
  });

  it('hashes a string as its UTF-8 bytes', () => {
    expect(md5Hex('Mot de passe é')).toBe(reference(ascii('Mot de passe é')));
  });

  it('does not modify its input', () => {
    const b = ascii('NetF0rge');
    const copy = b.slice();
    md5(b);
    expect(b).toEqual(copy);
  });
});

describe('chapMd5Response (RFC 1994 §4.1)', () => {
  it('is MD5 over the identifier byte, the secret and the challenge, in that order', () => {
    const challenge = new Uint8Array([0x5f, 0x10, 0x2c, 0x99, 0x00, 0xff, 0x01, 0x80, 0x7e, 0x33, 0x42, 0xa5, 0x0c, 0xd1, 0x68, 0xe4]);
    const expected = createHash('md5')
      .update(new Uint8Array([0x01]))
      .update(ascii('NetF0rge'))
      .update(challenge)
      .digest('hex');
    const r = chapMd5Response(1, 'NetF0rge', challenge);
    expect(r.length).toBe(16);
    expect(md5HexOf(r)).toBe(expected);
  });

  it('changes with the identifier, the secret and the challenge; the secret is not in the value', () => {
    const challenge = new Uint8Array(16).fill(7);
    const base = md5HexOf(chapMd5Response(1, 'NetF0rge', challenge));
    expect(md5HexOf(chapMd5Response(2, 'NetF0rge', challenge))).not.toBe(base);
    expect(md5HexOf(chapMd5Response(1, 'WRONG', challenge))).not.toBe(base);
    expect(md5HexOf(chapMd5Response(1, 'NetF0rge', new Uint8Array(16).fill(8)))).not.toBe(base);
    // The identifier is one byte on the wire: only its low 8 bits enter the hash.
    expect(md5HexOf(chapMd5Response(0x101, 'NetF0rge', challenge))).toBe(base);
    const text = new TextDecoder('latin1').decode(chapMd5Response(1, 'NetF0rge', challenge));
    expect(text.includes('NetF0rge')).toBe(false);
  });
});
