# Engine benchmarks

Scripts here are measurements, not tests: no vitest project (`fast`, `slow`, `gate`) includes `bench/`, and
`tsconfig.json` does not either. They print wall times and assert nothing about them.

## `loop-storm.ts` ([S40], ARCHITECTURE-P3C §7 W0h)

The loop-storm 100 ms window that `test/goldens/p3c-storm-window.json` records and `test/accept.p3c.hot-path.test.ts`
proves byte-identical: two NF-C2960 joined by three parallel cables (P1 profile, no spanning tree, seed 7), PC1 pings at
41 s, then `runFor(100 ms)`. The world is built exactly as the acceptance test builds it.

From the repository root, one process per run, median of three:

```sh
npx esbuild packages/engine/bench/loop-storm.ts --bundle --platform=node --format=esm --outfile=<tmp>/loop-storm.mjs
node <tmp>/loop-storm.mjs --runs 1 --check     # bundled: the recorded figure
npx vite-node packages/engine/bench/loop-storm.ts -- --runs 1 --check   # unbundled, as vitest runs it
```

`--check` compares the scheduler-event and trace-event counts with the golden (the digest is the acceptance test's job).
Profile with `node --cpu-prof --cpu-prof-dir=<dir> <tmp>/loop-storm.mjs --runs 1`.

Under vite-node (and vitest) every call to an imported function goes through a getter on a dictionary-mode export
object, so the unbundled window is several times slower than the bundled one and gains less from hot-path work.
