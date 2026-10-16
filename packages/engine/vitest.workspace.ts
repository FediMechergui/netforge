/**
 * The engine's three test projects, `fast`, `slow` and `gate` (the header of `vitest.config.ts` gives the commands).
 *
 * `SLOW_TESTS` are name globs, so shards added after they were written are caught with no edit here: the replay-exact
 * shards of every stage (`accept.p2.replay-exact-templates`, `-ccna1`, `-ccna2`, and since W5 the CCNA 3 shard
 * `accept.p3.replay-exact-ccna3`: the glob names any `accept.<stage>.replay-exact*`) and every digest shard (`accept.p3.p2-digests-templates`,
 * `-labs-a`, `-labs-b`, `-guards`, and any later `accept.<stage>.<profile>-digests*`, the P3c `accept.p3c.p3-digests-*`
 * shards included); plus, since the P3 W4 catalog flip (ruling R47), `accept.p3.silence` by name, and since P3c W0
 * `accept.p3c.silence` and the [S40] storm window `accept.p3c.hot-path`.
 *
 * `GATE_TESTS` (ARCHITECTURE-P3C §0 rule 25, §9.2 W0 item 5) is an EXPLICIT list of file names, never a glob and never
 * decided by wall time: `accept.p2.loop-storm-bounded` and `accept.p3.ospf-scale` (moved from `SLOW_TESTS`) and the
 * [C8] gate `accept.p3c.ospf-scale-multiarea` (written in W4a). A test seen above 60 s of wall time in a wave report is a
 * review trigger for the architect to add it here in a named change. The lead runs `gate` at gates and inside the
 * catalog flip only.
 *
 * `fast` is every test file minus exactly the slow and gate files, `slow` holds the slow globs minus the gate files,
 * and `gate` the gate files, so the three projects never overlap and together never drop a file.
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
 * over every template and lab (`accept.p3.silence`); since P3c W0 its P3c twin (`accept.p3c.silence`, written by the
 * W4b flip) and the [S40] storm window.
 */
const SLOW_TESTS = [
  'test/accept.*.replay-exact*.test.ts',
  'test/accept.*-digests*.test.ts',
  'test/accept.p3.silence.test.ts',
  // ARCHITECTURE-P3C W0 (D3): the loop-storm 100 ms window of [S40] (the P3c digest shards `accept.p3c.p3-digests-*`
  // are already caught by the digest glob above)
  'test/accept.p3c.hot-path.test.ts',
  // ARCHITECTURE-P3C §9.2 W0 item 5: the P3c silence proof over every template and lab (written by the W4b flip)
  'test/accept.p3c.silence.test.ts',
];

/**
 * @since P3c (ARCHITECTURE-P3C §0 rule 25, §9.2 W0 item 5) The `gate` project: exactly these files, by name. Membership
 * never depends on wall time; a file joins in a named change by the architect.
 */
const GATE_TESTS = [
  'test/accept.p2.loop-storm-bounded.test.ts',
  'test/accept.p3.ospf-scale.test.ts',
  'test/accept.p3c.ospf-scale-multiarea.test.ts',
];

/** The engine's test options since P0: node environment, 20 s per test. */
const SHARED = { environment: 'node', testTimeout: 20_000 } as const;

export default defineWorkspace([
  { root: ENGINE_ROOT, test: { ...SHARED, name: 'fast', include: ALL_TESTS, exclude: [...configDefaults.exclude, ...SLOW_TESTS, ...GATE_TESTS] } },
  { root: ENGINE_ROOT, test: { ...SHARED, name: 'slow', include: SLOW_TESTS, exclude: [...configDefaults.exclude, ...GATE_TESTS] } },
  { root: ENGINE_ROOT, test: { ...SHARED, name: 'gate', include: GATE_TESTS } },
]);
