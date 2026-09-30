/**
 * P3 acceptance — the P2-profile golden, shard 2 of 4: the first ten CCNA 2 labs (ARCHITECTURE-P3 §0 rule 5, D3,
 * §9.4, §10.1 row `accept.p3.p2-digests-labs-a`; recorded in W0 from the unchanged engine at 5263f16).
 *
 * The first ten labs of `CCNA2_LABS` (course order), each loaded exactly as the worker's `loadScenario` loads it (the
 * lab seed, the lab stamp, the scheduled faults), run the fixed script of test/p2-digests.harness.ts (boot 60 s → the
 * reference solution → 30 s → the lab's own ping → 20 s → a show → runFor 600 s) and must equal
 * test/goldens/p2-profile-digests.json exactly (every digest, count, window, stored line, typed result and the
 * normalised snapshot); a mismatch names its world and window. §9.4 lists the only allowed changes; only the architect
 * re-records (`NF_RECORD_P2_DIGESTS=<world,…|all>`).
 */
import { describeP2DigestShard } from './p2-digests.harness.js';

describeP2DigestShard('labs-a', 'accept P3: the P2-profile digests of CCNA 2 labs 1-10');
