/**
 * test/p2-digests.harness.ts — the P2-profile golden (ARCHITECTURE-P3 §0 rules 5, 9, 14; D3; §4.6; §7 W0; §9.2 W0
 * item 6; §9.4; §10.1 rows `accept.p3.p2-digests-templates`, `-labs-a`, `-labs-b`, `-guards`). Not a test file: the
 * four shard files call `describeP2DigestShard` with their shard name.
 *
 * Since ARCHITECTURE-P3C W0 (D3) a thin wrapper of test/profile-digests.harness.ts, the same harness generalised to a
 * profile parameter: everything below is that harness at profile 'P2' — the same 32 worlds, the same fixed script, the
 * same golden file test/goldens/p2-profile-digests.json (recorded from the unchanged engine at commit 5263f16), the
 * same case titles and reports, and the same recording switch `NF_RECORD_P2_DIGESTS=<world,world,…|all>` (the
 * architect only, and only for a P3 §9.4 change). The four P2 shards pass unchanged against the unchanged golden,
 * which is the proof that the generalisation moved no byte. The worlds, the script, the normalisation and the
 * recording rules are described in the header of test/profile-digests.harness.ts.
 */
import {
  describeProfileDigestShard,
  profileFreshRun,
  profileShardWorlds,
  type P2DigestShard,
  type P2World,
  type WorldRun,
} from './profile-digests.harness.js';

export {
  GUARD_SVI,
  GUARD_WORLDS,
  SANDBOX_WORLD,
  WINDOW_NS,
  backgroundFlags,
  currentVocabulary,
  eventLine,
  guardProblems,
  normaliseSnapshot,
  p2Worlds,
  referencedPdus,
  sha256Hex,
} from './profile-digests.harness.js';
export type { NormalisationContracts, P2DigestShard, P2Vocabulary, P2World, Probe, Typed, TypedResult, WorldEntry, WorldRun } from './profile-digests.harness.js';

/** The worlds of one P2 shard, in golden order. */
export function shardWorlds(shard: P2DigestShard): readonly P2World[] {
  return profileShardWorlds('P2', shard) as readonly P2World[];
}

/** The scripted run of a P2 world (once per test file run: the script is deterministic). */
export function freshRun(w: P2World): WorldRun {
  return profileFreshRun('P2', w);
}

/** The suite of one P2 shard (test/profile-digests.harness.ts `describeProfileDigestShard` at profile 'P2'). */
export function describeP2DigestShard(shard: P2DigestShard, title: string): void {
  describeProfileDigestShard('P2', shard, title);
}
