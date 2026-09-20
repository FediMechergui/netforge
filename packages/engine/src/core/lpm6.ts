/**
 * core/lpm6.ts — IPv6 longest-prefix match over a rib6 table (P1, §4.6 / §4.8; `Lpm6Result`).
 *
 * Addresses are compared as four 32-bit words (RFC 4291 §2.5: the high `prefixLen` bits of the address
 * must equal the high bits of the route's network). Candidates are every rib6 row whose `network/prefixLen`
 * contains `dst`, ordered by `prefixLen` desc, then `ad` asc, then `metric` asc, then table insertion order
 * (the `Lpm6Result` contract). The sort is stable over `rows()`, which is insertion ordered, so the order is
 * fully deterministic. The winner is the first candidate; the full list is kept for the LPM explainer.
 *
 * Rows whose `network` does not parse as IPv6, or whose `prefixLen` is outside 0..128, never match. A `dst`
 * that does not parse returns no candidates. Nothing here throws on data read from a table.
 */
import { parseIpv6 } from './addr6.js';
import type { Ipv6Address } from '../contracts/addr.js';
import type { Lpm6Result, Route6Row, Table } from '../contracts/tables.js';

/** An IPv6 address as four big-endian unsigned 32-bit words (word 0 holds the most significant bits). */
export type Ipv6Words = readonly [number, number, number, number];

/** Four big-endian u32 words of `a`, or null when `a` is not valid IPv6 text. */
export function ipv6Words(a: Ipv6Address): Ipv6Words | null {
  const b = parseIpv6(a);
  if (b === null) return null;
  const w = (i: number): number => ((b[i]! << 24) | (b[i + 1]! << 16) | (b[i + 2]! << 8) | b[i + 3]!) >>> 0;
  return [w(0), w(4), w(8), w(12)];
}

/** Mask of the `bits` high bits of a 32-bit word (`bits` clamped to 0..32). */
function wordMask(bits: number): number {
  if (bits <= 0) return 0;
  if (bits >= 32) return 0xffffffff;
  return (0xffffffff << (32 - bits)) >>> 0;
}

/**
 * True when the first `prefixLen` bits of `addr` equal those of `network` (4×u32 compare).
 * `prefixLen` outside 0..128 (or non-integer) never matches.
 */
export function prefixMatches6(addr: Ipv6Words, network: Ipv6Words, prefixLen: number): boolean {
  if (!Number.isInteger(prefixLen) || prefixLen < 0 || prefixLen > 128) return false;
  for (let i = 0; i < 4; i++) {
    const m = wordMask(prefixLen - i * 32);
    if (m === 0) return true;
    if (((addr[i]! & m) >>> 0) !== ((network[i]! & m) >>> 0)) return false;
  }
  return true;
}

/** True when rib6 row `row` contains `dst`. Rows or destinations that do not parse never match. */
export function route6Contains(row: Route6Row, dst: Ipv6Address): boolean {
  const d = ipv6Words(dst);
  const n = ipv6Words(row.network);
  return d !== null && n !== null && prefixMatches6(d, n, row.prefixLen);
}

/** Total order on matching IPv6 routes: longest prefix, lowest AD, lowest metric (ties keep input order). */
function compareRoutes6(a: Route6Row, b: Route6Row): number {
  if (a.prefixLen !== b.prefixLen) return b.prefixLen - a.prefixLen;
  if (a.ad !== b.ad) return a.ad - b.ad;
  return a.metric - b.metric;
}

/**
 * Longest-prefix match of `dst` over `rows`, which must be in table insertion order (the final tie-break).
 * Returns the ordered candidates and the winner (the first candidate), as the `Lpm6Result` contract says.
 */
export function lpm6Rows(rows: readonly Route6Row[], dst: Ipv6Address): Lpm6Result {
  const d = ipv6Words(dst);
  if (d === null) return { candidates: [] };
  const candidates: Route6Row[] = [];
  for (const r of rows) {
    const n = ipv6Words(r.network);
    if (n !== null && prefixMatches6(d, n, r.prefixLen)) candidates.push(r);
  }
  // Array.prototype.sort is stable (ES2019), so equal keys keep insertion order.
  candidates.sort(compareRoutes6);
  const winner = candidates[0];
  return winner === undefined ? { candidates } : { winner, candidates };
}

/** Longest-prefix match of `dst` against the rib6 table. Never throws on an empty table. */
export function lpm6(rib6: Table<Route6Row>, dst: Ipv6Address): Lpm6Result {
  return lpm6Rows(rib6.rows(), dst);
}
