/**
 * bench/loop-storm.ts — the [S40] hot-path benchmark (ARCHITECTURE-P3C D11, §7 W0h, §10.1 `accept.p3c.hot-path`).
 *
 * Measures the wall time of the loop-storm 100 ms window that `test/goldens/p3c-storm-window.json` records: the
 * P1-profile storm world of `accept.p2.loop-storm-bounded` (two NF-C2960 on the stage-P2 catalog, a PC on each, seed 7,
 * booted to 40 s; three parallel FastEthernet cables at 40 s; PC1's `ping 10.0.0.2` at 41 s), then `runFor(100 ms)`.
 * The world is built exactly as `test/accept.p3c.hot-path.test.ts` builds it, and trace events are collected through
 * `onTrace` the same way, so the timed work is the work the golden proves byte-identical.
 *
 * Not a test: it lives outside `test/` and `src/`, so no vitest project (`fast`, `slow`, `gate`) includes it, and
 * outside the `include` of `tsconfig.json`. It asserts nothing about time; it prints. With `--check` it also compares
 * the run's scheduler-event and trace-event counts with the golden (the full digest is `accept.p3c.hot-path`'s job).
 *
 * Run from the repository root. Bundled (the figure the wave report records: the web app ships bundled code, and a
 * bundle has none of vite-node's per-import-call overhead), one process per run, median of three:
 *   npx esbuild packages/engine/bench/loop-storm.ts --bundle --platform=node --format=esm --outfile=<tmp>/loop-storm.mjs
 *   node <tmp>/loop-storm.mjs --runs 1 [--check]
 * Unbundled, as vitest runs the engine (vite-node resolves the sources' `.js` import specifiers to `.ts`):
 *   npx vite-node packages/engine/bench/loop-storm.ts -- --runs 1 [--check]
 * Profile: `node --cpu-prof --cpu-prof-dir=<dir> <tmp>/loop-storm.mjs --runs 1` (add `--no-turbo-inlining` to see
 * the frames V8 would inline). `--runs N` repeats the window in one process; runs after the first pay for the earlier
 * runs' garbage (each retains about 800 k trace events), so compare first runs of separate processes.
 */
import { readFileSync } from 'node:fs';
import type { PortId } from '../src/contracts/ids.js';
import type { Simulation } from '../src/contracts/simulation.js';
import { MS, SEC } from '../src/contracts/time.js';
import type { TraceEvent } from '../src/contracts/trace.js';
import { configText } from '../src/sim/scenarios/kit.js';
import { pcConfig } from '../src/sim/scenarios/templates.js';
import { createP2Simulation } from '../test/p2.world.js';

const SWITCH = 'switch.nfc2960';
const PC = 'pc.nfpc';
const FA1: PortId = 'FastEthernet0/1';
const PARALLEL: readonly PortId[] = ['FastEthernet0/22', 'FastEthernet0/23', 'FastEthernet0/24'];
const PARALLEL_LINKS = ['l_a', 'l_b', 'l_c'] as const;
const SEED = 7;
const CABLE_AT_NS = 40 * SEC;
const PING_AT_NS = 41 * SEC;
const WINDOW_NS = 100 * MS;

function stormWorld(): Simulation {
  const sim = createP2Simulation({ seed: SEED, profile: 'P1' });
  sim.addDevice({ id: 'sw1', type: SWITCH, name: 'SW1', startupConfig: configText([['hostname SW1']]) });
  sim.addDevice({ id: 'sw2', type: SWITCH, name: 'SW2', startupConfig: configText([['hostname SW2']]) });
  sim.addDevice({ id: 'pc1', type: PC, name: 'PC1', startupConfig: pcConfig('PC1', '10.0.0.1', '255.255.255.0') });
  sim.addDevice({ id: 'pc2', type: PC, name: 'PC2', startupConfig: pcConfig('PC2', '10.0.0.2', '255.255.255.0') });
  sim.addLink({ id: 'l_pc1', a: { device: 'pc1', port: 'GigabitEthernet0' }, b: { device: 'sw1', port: FA1 } });
  sim.addLink({ id: 'l_pc2', a: { device: 'pc2', port: 'GigabitEthernet0' }, b: { device: 'sw2', port: FA1 } });
  return sim;
}

interface Run {
  readonly setupMs: number;
  readonly windowMs: number;
  readonly dispatched: number;
  readonly eventCount: number;
}

function runOnce(): Run {
  const t0 = performance.now();
  const sim = stormWorld();
  sim.runUntil(CABLE_AT_NS);
  PARALLEL.forEach((port, i) => sim.addLink({ id: PARALLEL_LINKS[i]!, a: { device: 'sw1', port }, b: { device: 'sw2', port } }));
  sim.runUntil(PING_AT_NS);
  const events: TraceEvent[] = [];
  const off = sim.onTrace((ev) => events.push(ev));
  const session = sim.cli.open('pc1', 'console');
  const r = sim.cli.exec(session, 'ping 10.0.0.2');
  if (r.error !== undefined) throw new Error(`ping refused: ${String(r.error)}`);
  const start = performance.now();
  const stats = sim.runFor(WINDOW_NS);
  const windowMs = performance.now() - start;
  off();
  return { setupMs: start - t0, windowMs, dispatched: stats.events, eventCount: events.length };
}

function median(xs: readonly number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

const argv = process.argv.slice(2);
const runsAt = argv.indexOf('--runs');
const runs = runsAt >= 0 ? Number(argv[runsAt + 1]) : 3;
const check = argv.includes('--check');
const golden = check
  ? (JSON.parse(readFileSync(new URL('../test/goldens/p3c-storm-window.json', import.meta.url), 'utf8')) as { dispatched: number; eventCount: number })
  : { dispatched: -1, eventCount: -1 };

const times: number[] = [];
for (let i = 0; i < runs; i++) {
  const run = runOnce();
  times.push(run.windowMs);
  const same = run.dispatched === golden.dispatched && run.eventCount === golden.eventCount;
  console.log(`run ${i + 1}: window ${run.windowMs.toFixed(0)} ms (setup ${run.setupMs.toFixed(0)} ms), ${run.dispatched} dispatched, ${run.eventCount} trace events, heap ${(process.memoryUsage().heapUsed / 2 ** 20).toFixed(0)} MB${check ? (same ? ', counts = golden' : ', COUNTS DIFFER FROM GOLDEN') : ''}`);
  if (check && !same) process.exitCode = 1;
}
console.log(`storm window: median ${median(times).toFixed(0)} ms over ${runs} run(s)`);
