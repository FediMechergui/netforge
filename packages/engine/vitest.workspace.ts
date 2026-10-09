/**
 * The engine's two test projects, `fast` and `slow` (the header of `vitest.config.ts` gives the commands).
 *
 * `SLOW_TESTS` are name globs, so shards added after they were written are caught with no edit here: the replay-exact
 * shards (`accept.p2.replay-exact-templates`, `-ccna1`, `-ccna2`) and every digest shard (`accept.p3.p2-digests-templates`,
 * `-labs-a`, `-labs-b`, `-guards`, and any later `accept.<stage>.<profile>-digests*`); plus, since the P3 W4 catalog flip
 * (ruling R47), `accept.p3.silence` and `accept.p3.ospf-scale` by name. `fast` is every test file minus exactly those
 * globs, so the two projects never overlap and together never drop a file.
 *
 * The projects are inline rather than `extends` of the root config: Vite's config merge concatenates arrays, so an
 * inherited `include` would put every file back into `slow`. Each project therefore states its root (a project does
 * not inherit `--root`) and the shared options.
 */
import { fileURLToPath } from 'node:url';
import { configDefaults, defineWorkspace } from 'vitest/config';

/** The engine package directory. */
const ENGINE_ROOT = fileURLToPath(new URL('.', import.meta.url));

/** Every engine test file. */
const ALL_TESTS = ['test/**/*.test.ts', 'src/**/*.test.ts'];

/**
 * The long-running proofs (ARCHITECTURE-P3 §7 W0), and since the W4 catalog flip (ruling R47) the flip's silence proof
 * over every template and lab (`accept.p3.silence`) and the 50-router OSPF scale row (`accept.p3.ospf-scale`).
 */
const SLOW_TESTS = [
  'test/accept.p2.loop-storm-bounded.test.ts',
  'test/accept.p2.replay-exact*.test.ts',
  'test/accept.*-digests*.test.ts',
  'test/accept.p3.silence.test.ts',
  'test/accept.p3.ospf-scale.test.ts',
];

/** The engine's test options since P0: node environment, 20 s per test. */
const SHARED = { environment: 'node', testTimeout: 20_000 } as const;

export default defineWorkspace([
  { root: ENGINE_ROOT, test: { ...SHARED, name: 'fast', include: ALL_TESTS, exclude: [...configDefaults.exclude, ...SLOW_TESTS] } },
  { root: ENGINE_ROOT, test: { ...SHARED, name: 'slow', include: SLOW_TESTS } },
]);
