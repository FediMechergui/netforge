/**
 * core/lpm.ts — longest-prefix match over a RIB table (spec §9.4 "longest-prefix-match explainer").
 *
 * Candidates are every route whose `network/prefixLen` contains `dst`, ordered by
 * `prefixLen` desc, then `ad` asc, then `metric` asc, then `key` asc (a stable, fully
 * deterministic order so the explainer can replay the elimination). The winner is the
 * first candidate. The candidate list is returned so the UI can animate the losers.
 */
import { ipv4ToU32, prefixLenToMaskU32, type Ipv4Address } from '../contracts/addr.js';
import type { LpmResult, RouteRow, Table } from '../contracts/tables.js';

/** Total order on matching routes: longest prefix, lowest AD, lowest metric, then key. */
function compareRoutes(a: RouteRow, b: RouteRow): number {
  if (a.prefixLen !== b.prefixLen) return b.prefixLen - a.prefixLen;
  if (a.ad !== b.ad) return a.ad - b.ad;
  if (a.metric !== b.metric) return a.metric - b.metric;
  return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
}

/** Longest-prefix match of `dst` against `rib`. Never throws on an empty table. */
export function lpm(rib: Table<RouteRow>, dst: Ipv4Address): LpmResult {
  const d = ipv4ToU32(dst);
  const candidates = rib.find((r) => {
    const m = prefixLenToMaskU32(r.prefixLen);
    return ((ipv4ToU32(r.network) & m) >>> 0) === ((d & m) >>> 0);
  });
  candidates.sort(compareRoutes);
  const winner = candidates[0];
  return winner === undefined ? { candidates } : { winner, candidates };
}
