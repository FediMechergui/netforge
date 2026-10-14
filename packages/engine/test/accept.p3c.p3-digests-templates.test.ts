/**
 * P3c acceptance — the P3-profile golden, shard 1 of 5: the templates (ARCHITECTURE-P3C §0 rules 5 and 9, D3, §9.5,
 * §10.1 row `accept.p3c.p3-digests-templates`; recorded in W0 from the unchanged engine at cad4ac9).
 *
 * The 9 "New from template" worlds frozen in the golden's `shards.templates`, each loaded as a P3 world
 * (`profile: 'P3'`, schema 1.3), run the fixed script of test/profile-digests.harness.ts (boot 60 s → nothing to
 * configure → 30 s → the P1 golden's ping → 20 s → its show → runFor 600 s). The digest and per-kind counts over every
 * event, the per-10-second-window digests, the stored non-background event lines, the typed results and the normalised
 * snapshot hash must equal test/goldens/p3-profile-digests.json exactly; a mismatch names its world and window.
 * ARCHITECTURE-P3C §9.5 lists the only allowed changes (none for a template); only the architect re-records, entry by
 * entry: `NF_RECORD_P3_DIGESTS=<world id> npx vitest run --root packages/engine test/accept.p3c.p3-digests-templates.test.ts`.
 */
import { describeProfileDigestShard } from './profile-digests.harness.js';

describeProfileDigestShard('P3', 'templates', 'accept P3c: the P3-profile digests of the templates');
