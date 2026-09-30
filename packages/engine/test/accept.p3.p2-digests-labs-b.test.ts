/**
 * P3 acceptance — the P2-profile golden, shard 3 of 4: the other ten CCNA 2 labs and the P2 addDevice sandbox
 * (ARCHITECTURE-P3 §0 rule 5, D3, §9.4, §10.1 row `accept.p3.p2-digests-labs-b`; recorded in W0 from the unchanged
 * engine at 5263f16).
 *
 * Labs 11-20 of `CCNA2_LABS` (course order), loaded exactly as the worker's `loadScenario` loads them, and one P2
 * sandbox built through `addDevice` / `addLink` (NF-C2960, NF-C3650-24, NF-2911, NF-AP-1832, NF-WLC-9800, two PCs:
 * the new-world `profileConfig` path) run the fixed script of test/p2-digests.harness.ts and must equal
 * test/goldens/p2-profile-digests.json exactly; a mismatch names its world and window. §9.4 lists the only allowed
 * changes; only the architect re-records (`NF_RECORD_P2_DIGESTS=<world,…|all>`).
 */
import { describeP2DigestShard } from './p2-digests.harness.js';

describeP2DigestShard('labs-b', 'accept P3: the P2-profile digests of CCNA 2 labs 11-20 and the addDevice sandbox');
