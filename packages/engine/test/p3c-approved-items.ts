import type { LabFactName, NeighborProtocol } from '../src/contracts/scenario.js';
/**
 * The approved ids of P3c and the wave the build has reached (ARCHITECTURE-P3C §0 rule 28, §7 W0, §8.5c).
 *
 * `P3C_APPROVED_ITEMS` is the exact array of the **Approved ids** row of §8.5c (the recommended plan, approved by the
 * product owner on 2026-10-14): every approved id, MUST and health items included, with the split ids `S17a`, `S36a`,
 * `S36b`, `R63d`, and `C8` meaning the OSPF scale gate only. `p3c-approved-items.test.ts` proves it equal to §8.5c, read
 * with the regex `\b(?:[SC]\d+[ab]?|R63d)\b` (P3a's `\b[SC]\d+\b` cannot read `S17a`, `S36a` or `R63d`).
 * `accept.p3c.coverage.test.ts` requires the §10.1 row of an item only when the item is in this list. Approving an item
 * later means, in one change: the §8.5c row, this list, the §10.1 row and the file.
 *
 * `P3C_CURRENT_WAVE` is the wave the build has reached: a §10.1 row whose **Arrives** wave is later is pending. The lead
 * advances it in each wave's integrate run (rule 28). P3a's `P3_APPROVED_ITEMS` (`p3-approved-items.ts`) is untouched.
 */

/** @since P3c The approved ids of §8.5c, in the order of its Approved ids row. */
export const P3C_APPROVED_ITEMS = [
  'S40', 'S39', 'C32', 'S4', 'S5', 'S6', 'C7', 'S11', 'S15', 'S16', 'S10', 'S17a', 'S22', 'S26', 'S35', 'S36a', 'S41', 'S28', 'S29',
  'S30', 'S31', 'S33', 'S34', 'S8', 'S7', 'C8', 'S23', 'S12', 'S14', 'S36b', 'C16', 'C17', 'C22', 'C23', 'S27', 'C26', 'S38', 'R63d',
] as const;

/** @since P3c One approved id. */
export type P3cApprovedItem = (typeof P3C_APPROVED_ITEMS)[number];

/** @since P3c The P3c waves in build order (§7); the **Arrives** column of §10.1 names one of them. */
export const P3C_WAVES = ['W0', 'W0h', 'W1a', 'W1b', 'W1c', 'W2a', 'W2b', 'W3a', 'W3b', 'W3c', 'W4a', 'W4b', 'W5a', 'W5b', 'W6', 'W7'] as const;

/** @since P3c One P3c wave. */
export type P3cWave = (typeof P3C_WAVES)[number];

/** @since P3c The wave the build has reached (advanced by the lead in each wave's integrate run). */
export const P3C_CURRENT_WAVE: P3cWave = 'W0';

/**
 * The P3c fact and neighbour entries that stay undefined until their adapter item lands (ARCHITECTURE-P3C RC1 (i)).
 * The item that fills one removes it from these lists in the same change.
 */
export const P3C_PENDING_PROTOCOLS: readonly NeighborProtocol[] = ['ospfv3'];
export const P3C_PENDING_FACTS: readonly LabFactName[] = [
  'ospf.abr',
  'ospf.asbr',
  'ospfv3.routerId',
  'ospfv3.ifaceArea',
  'ospfv3.ifaceCost',
  'ipsg.enabled',
  'storage.file',
  'device.imageVersion',
  'device.configRegister',
];
