/**
 * Engine test configuration (ARCHITECTURE-P3 §0 rules 4, 9 and 15; §7 W0 "architect (health, P2 §14)"; §9.2 W0
 * item 8).
 *
 * The tests are split into two projects, defined in `vitest.workspace.ts` (next to this file, found automatically):
 *   fast  every engine test file except the slow ones: check 2 of the six checks;
 *   slow  the long-running proofs: `accept.p2.loop-storm-bounded`, the replay-exact shards
 *         (`accept.p2.replay-exact-templates`, `-ccna1`, `-ccna2`), and the digest goldens (`accept.p2.p1-digests`,
 *         `accept.p3.p2-digests-*`).
 * The two projects are disjoint and together hold every test file, so no test is skipped.
 *
 * Commands, from the repository root:
 *   npx vitest run --root packages/engine                   every test (both projects)
 *   npx vitest run --root packages/engine --project fast    fast only (check 2)
 *   npx vitest run --root packages/engine --project slow    slow only (the lead: once per wave and at every gate)
 *   npx vitest run --root packages/engine <name filter>     one's own files (rule 9), in whichever project holds them
 *   npx vitest list --root packages/engine --filesOnly [--project fast|slow]   which files a project collects
 *
 * The worker count is fixed here, never by CLI flags (rule 15), so no run depends on the machine or on its load;
 * vitest 2.1 needs both bounds when the maximum is below its default minimum.
 */
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    minWorkers: 1,
    maxWorkers: 6,
  },
});
