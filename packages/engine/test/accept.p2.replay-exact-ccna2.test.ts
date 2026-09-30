/**
 * P2 acceptance [SHOULD S1] — exact replay of the input journal (ARCHITECTURE-P2 D18, §2.13, §3.13 steps 1–4, §10.1
 * row `accept.p2.replay-exact`): the shard of the CCNA 2 labs, category `ccna2-lab`
 * (ARCHITECTURE-P3 §7 W0 qa, §9.2 W0 item 8).
 *
 * The script, the checks and the shard map are in `replay-exact.harness.ts`, moved there unchanged from the unsplit
 * file; this shard runs the unsplit file's catalogue case, the partition case (the three shards together replay every
 * `SCENARIOS` entry exactly once) and the per-scenario case for every CCNA 2 lab (read at run time). It belongs to the
 * engine's `slow` project (`vitest.workspace.ts`: `test/accept.p2.replay-exact*.test.ts`).
 */
import { describe, it } from 'vitest';
import { SCENARIO_TIMEOUT_MS, expectCatalogueCovered, expectShardPartition, replayExactCase, scenariosOfShard } from './replay-exact.harness.js';

/** This shard's file name (its value in `REPLAY_EXACT_SHARD_OF_CATEGORY`). */
const SHARD = 'accept.p2.replay-exact-ccna2.test.ts';

describe('accept.p2.replay-exact-ccna2: every CCNA 2 lab, replayed from its journal', () => {
  it('covers every scenario of the catalogue (templates, CCNA 1 labs, CCNA 2 labs)', () => {
    expectCatalogueCovered();
  });

  it('replays exactly the CCNA 2 labs here, and the three shards together replay every scenario once', () => {
    expectShardPartition(SHARD);
  });

  for (const sc of scenariosOfShard(SHARD)) {
    it(
      `${sc.name}: to position(), to every entry, and interleaved`,
      () => {
        replayExactCase(sc);
      },
      SCENARIO_TIMEOUT_MS,
    );
  }
});
