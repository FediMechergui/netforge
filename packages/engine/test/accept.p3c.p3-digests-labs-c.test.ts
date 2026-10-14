/**
 * P3c acceptance — the P3-profile golden, shard 4 of 5: CCNA 3 labs, shard c (ARCHITECTURE-P3C §0 rules 5 and 9, D3,
 * §9.5, §10.1 row `accept.p3c.p3-digests-labs-c`; recorded in W0 from the unchanged engine at cad4ac9).
 *
 * The 7 lab ids frozen in the golden's `shards['labs-c']` (names 15–21 of `CCNA3_LAB_ORDER` at cad4ac9,
 * `ccna3-discover-neighbours` … `ccna3-script-inventory`; the shard never reads the live order), loaded as the
 * worker's `loadScenario` loads them, run the fixed script of test/profile-digests.harness.ts and must equal
 * test/goldens/p3-profile-digests.json exactly; a mismatch names its world and window. ARCHITECTURE-P3C §9.5 lists the
 * only allowed changes; only the architect re-records, entry by entry:
 * `NF_RECORD_P3_DIGESTS=<world id> npx vitest run --root packages/engine test/accept.p3c.p3-digests-labs-c.test.ts`.
 */
import { describeProfileDigestShard } from './profile-digests.harness.js';

describeProfileDigestShard('P3', 'labs-c', 'accept P3c: the P3-profile digests of CCNA 3 labs, shard c (frozen ids)');
