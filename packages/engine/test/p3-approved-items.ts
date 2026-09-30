/**
 * The approved SHOULD and COULD items of P3a, as the exact array `accept.p3.coverage` carries (ARCHITECTURE-P3 §10.1,
 * §7 W0; the product owner's decision record §8.5 rows P1 and P2, 2026-09-29).
 *
 * `accept.p3.coverage.test.ts` (W7) reads the §10.1 table by the rule `accept.p2.coverage.test.ts` uses and requires a
 * row tagged `[Sn]` or `[Cn]` only when its item is in this list; the rows of every other bracketed item stay listed as
 * the designs of their stage and must not exist as files in P3a. The list is written in W0 so that no later wave can
 * widen the scope without the decision record changing first; `p3-approved-items.test.ts` proves it equals §8.5.
 */
export const P3_APPROVED_ITEMS = ['S1', 'S2', 'S3', 'S9', 'S13', 'S18', 'S19', 'S20', 'S21', 'S24', 'S25', 'S32', 'S37', 'C1', 'C13'] as const;

/** One approved item id. */
export type P3ApprovedItem = (typeof P3_APPROVED_ITEMS)[number];
