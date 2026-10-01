/**
 * core/md5.ts — the MD5 message digest, RFC 1321 (ARCHITECTURE-P3 D17, §7 W1 wan [S19]).
 *
 * PPP CHAP (RFC 1994) uses real MD5: a responder answers a challenge with MD5(identifier ‖ secret ‖ challenge), and
 * the authenticator recomputes the same value from its own `username <peer> password <pw>` entry (§3.9 step 4). The
 * secret itself never travels. Nothing else in the engine hashes with MD5 ([S5]'s OSPF digest is simulated and not
 * approved; IPsec proofs are FNV-1a, D27).
 *
 * The implementation follows RFC 1321 §3 literally: pad with 0x80 and zeros to 56 mod 64 bytes, append the message
 * length in bits as a 64-bit little-endian value, then run the four rounds of 16 operations per 64-byte block over
 * the state (A, B, C, D) = (0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476). The sine table T[1..64] is written out
 * (RFC 1321 §3.4), never computed, so the digest involves no floating-point maths. All arithmetic is 32-bit integer
 * (`| 0`, `>>> 0`, rotations by shifts); the RFC appendix A.5 vectors are pinned by `core.md5.test.ts`.
 *
 * Pure: no module state, no randomness, no I/O.
 */

/** Digest length in bytes. */
export const MD5_DIGEST_BYTES = 16;

/** RFC 1321 §3.4 T[i] = floor(2^32 · |sin(i)|), i = 1..64, in operation order. */
const T: readonly number[] = Object.freeze([
  0xd76aa478, 0xe8c7b756, 0x242070db, 0xc1bdceee, 0xf57c0faf, 0x4787c62a, 0xa8304613, 0xfd469501,
  0x698098d8, 0x8b44f7af, 0xffff5bb1, 0x895cd7be, 0x6b901122, 0xfd987193, 0xa679438e, 0x49b40821,
  0xf61e2562, 0xc040b340, 0x265e5a51, 0xe9b6c7aa, 0xd62f105d, 0x02441453, 0xd8a1e681, 0xe7d3fbc8,
  0x21e1cde6, 0xc33707d6, 0xf4d50d87, 0x455a14ed, 0xa9e3e905, 0xfcefa3f8, 0x676f02d9, 0x8d2a4c8a,
  0xfffa3942, 0x8771f681, 0x6d9d6122, 0xfde5380c, 0xa4beea44, 0x4bdecfa9, 0xf6bb4b60, 0xbebfbc70,
  0x289b7ec6, 0xeaa127fa, 0xd4ef3085, 0x04881d05, 0xd9d4d039, 0xe6db99e5, 0x1fa27cf8, 0xc4ac5665,
  0xf4292244, 0x432aff97, 0xab9423a7, 0xfc93a039, 0x655b59c3, 0x8f0ccc92, 0xffeff47d, 0x85845dd1,
  0x6fa87e4f, 0xfe2ce6e0, 0xa3014314, 0x4e0811a1, 0xf7537e82, 0xbd3af235, 0x2ad7d2bb, 0xeb86d391,
]);

/** Per-operation left-rotation amounts (RFC 1321 §3.4: rounds 1–4, four amounts each, repeated four times). */
const S: readonly number[] = Object.freeze([
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
  5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
  4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
  6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
]);

/** Word index X[k] used by operation i (RFC 1321 §3.4). */
function wordIndex(i: number): number {
  if (i < 16) return i;
  if (i < 32) return (5 * i + 1) & 15;
  if (i < 48) return (3 * i + 5) & 15;
  return (7 * i) & 15;
}

function rotl(x: number, n: number): number {
  return (x << n) | (x >>> (32 - n));
}

/** The RFC 1321 message padding: `data` ‖ 0x80 ‖ zeros ‖ bit length (64-bit little-endian), a multiple of 64 bytes. */
function padded(data: Uint8Array): Uint8Array {
  const len = data.length;
  const total = (((len + 8) >>> 6) + 1) << 6;
  const out = new Uint8Array(total);
  out.set(data);
  out[len] = 0x80;
  // Bit length = 8 · len, split into low and high 32-bit words without overflow (len < 2^53 / 8).
  const bitsLow = (len << 3) >>> 0;
  const bitsHigh = Math.floor(len / 0x2000_0000) >>> 0;
  for (let i = 0; i < 4; i++) {
    out[total - 8 + i] = (bitsLow >>> (8 * i)) & 0xff;
    out[total - 4 + i] = (bitsHigh >>> (8 * i)) & 0xff;
  }
  return out;
}

/** MD5 of `data` (RFC 1321): 16 bytes. */
export function md5(data: Uint8Array): Uint8Array {
  const m = padded(data);
  let a0 = 0x67452301;
  let b0 = 0xefcdab89;
  let c0 = 0x98badcfe;
  let d0 = 0x10325476;
  const x = new Array<number>(16);
  for (let off = 0; off < m.length; off += 64) {
    for (let k = 0; k < 16; k++) {
      const p = off + 4 * k;
      x[k] = m[p]! | (m[p + 1]! << 8) | (m[p + 2]! << 16) | (m[p + 3]! << 24);
    }
    let a = a0;
    let b = b0;
    let c = c0;
    let d = d0;
    for (let i = 0; i < 64; i++) {
      let f: number;
      if (i < 16) f = (b & c) | (~b & d);
      else if (i < 32) f = (b & d) | (c & ~d);
      else if (i < 48) f = b ^ c ^ d;
      else f = c ^ (b | ~d);
      const sum = (a + f + T[i]! + x[wordIndex(i)]!) | 0;
      a = d;
      d = c;
      c = b;
      b = (b + rotl(sum, S[i]!)) | 0;
    }
    a0 = (a0 + a) | 0;
    b0 = (b0 + b) | 0;
    c0 = (c0 + c) | 0;
    d0 = (d0 + d) | 0;
  }
  const out = new Uint8Array(MD5_DIGEST_BYTES);
  const words = [a0, b0, c0, d0];
  for (let w = 0; w < 4; w++) {
    for (let i = 0; i < 4; i++) out[4 * w + i] = (words[w]! >>> (8 * i)) & 0xff;
  }
  return out;
}

/** Lower-case hex of `bytes`. */
export function md5HexOf(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += b.toString(16).padStart(2, '0');
  return s;
}

/** MD5 of `data` as 32 lower-case hex digits; a string is hashed as its UTF-8 bytes. */
export function md5Hex(data: Uint8Array | string): string {
  return md5HexOf(md5(typeof data === 'string' ? new TextEncoder().encode(data) : data));
}

/**
 * The CHAP MD5 response value (RFC 1994 §4.1, algorithm 5): MD5 over the one-byte identifier, the secret's UTF-8
 * bytes and the challenge value, in that order. The responder sends it; the authenticator recomputes and compares.
 */
export function chapMd5Response(id: number, secret: string, challenge: Uint8Array): Uint8Array {
  const s = new TextEncoder().encode(secret);
  const input = new Uint8Array(1 + s.length + challenge.length);
  input[0] = id & 0xff;
  input.set(s, 1);
  input.set(challenge, 1 + s.length);
  return md5(input);
}
