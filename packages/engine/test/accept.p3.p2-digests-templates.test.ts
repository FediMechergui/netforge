/**
 * P3 acceptance — the P2-profile golden, shard 1 of 4: the templates (ARCHITECTURE-P3 §0 rule 5, D3, §9.4, §10.1 row
 * `accept.p3.p2-digests-templates`; recorded in W0 from the unchanged engine at 5263f16).
 *
 * The 9 "New from template" worlds, each loaded as a P2 world (`profile: 'P2'`, schema 1.2), run the fixed script of
 * test/p2-digests.harness.ts (boot 60 s → nothing to configure → 30 s → the P1 golden's ping → 20 s → its show →
 * runFor 600 s). The digest and per-kind counts over every event, the per-10-second-window digests, the stored
 * non-background event lines, the typed results and the normalised snapshot hash must equal
 * test/goldens/p2-profile-digests.json exactly; a mismatch names its world and window. §9.4 lists the only allowed
 * changes; only the architect re-records (`NF_RECORD_P2_DIGESTS=<world,…|all>`).
 */
import { describeP2DigestShard } from './p2-digests.harness.js';

describeP2DigestShard('templates', 'accept P3: the P2-profile digests of the templates');
