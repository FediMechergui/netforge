/**
 * P3c acceptance [S40] — the loop-storm window is byte-identical (ARCHITECTURE-P3C D3, §7 W0 and W0h, §10.1 row
 * `accept.p3c.hot-path`; the golden recorded in W0 from the unchanged engine at cad4ac9).
 *
 * test/goldens/p3c-storm-window.json is the byte proof for the hot-path work of [S40]: every optimisation of the
 * dispatch path (simulation dispatch, `summarizePdu`, `pduSummary`, trace-ring writes, flood cloning, `portKey`
 * lookups, snapshot-cache dirty marking, pipeline spreads, summary caching) must leave this window exactly as cad4ac9
 * produced it. The world is the P1-profile storm of `accept.p2.loop-storm-bounded` (same models, seed, cables and
 * times): two NF-C2960 on the stage-P2 catalog (`createP2Simulation`), a PC on each, booted to 40 s; then THREE
 * parallel FastEthernet cables between the switches (no spanning tree in P1), run to 41 s; then PC1's `ping 10.0.0.2`,
 * whose ARP broadcast storms. The window is the 100 ms of sim time that follows the ping (`runFor(100 ms)`).
 *
 * Recorded and compared, all exact:
 *   • `dispatched` — the scheduler events the window's `runFor` reports (`RunStats.events`);
 *   • `eventCount` and `kinds` — the trace events the window emitted (collected through `onTrace`, so the ring's
 *     capacity plays no part), counted per kind;
 *   • `eventsDigest` — SHA-256 over every event's P1 line (`<t>|<kind>|<16 hex of the canonical JSON of the event,
 *     normalised by normalizeP0Event>`, test/profile-digests.harness.ts `eventLine`), joined by '\n';
 *   • `windows` — the same digest per 10 ms slice (`<count>:<16 hex>`), so a mismatch names where it starts.
 * The wall time of the window is recorded in the wave report (W0h: ≥ 3× faster), never asserted. The benchmark script
 * `packages/engine/bench/loop-storm.ts` arrived with [S40] at W0h; the last case checks that it exists and that no
 * vitest project and no tsconfig include reaches it (ARCHITECTURE-P3C RC3 (c)).
 *
 * Regenerating (the architect only; [S40] is byte-neutral by definition, so a moved window is a defect, not a
 * re-record): `NF_RECORD_P3C_STORM_WINDOW=1 npx vitest run --root packages/engine test/accept.p3c.hot-path.test.ts`.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import type { PortId } from '../src/contracts/ids.js';
import type { Simulation } from '../src/contracts/simulation.js';
import { MS, SEC } from '../src/contracts/time.js';
import type { TraceEvent } from '../src/contracts/trace.js';
import { configText } from '../src/sim/scenarios/kit.js';
import { pcConfig } from '../src/sim/scenarios/templates.js';
import { canonicalJson, macOwners } from './accept.p05.harness.js';
import { createP2Simulation } from './p2.world.js';
import { eventLine, sha256Hex } from './profile-digests.harness.js';

const SWITCH = 'switch.nfc2960';
const PC = 'pc.nfpc';
const FA1: PortId = 'FastEthernet0/1';
/** The three parallel cables: Fa0/22–24 on both switches (accept.p2.loop-storm-bounded). */
const PARALLEL: readonly PortId[] = ['FastEthernet0/22', 'FastEthernet0/23', 'FastEthernet0/24'];
const PARALLEL_LINKS = ['l_a', 'l_b', 'l_c'] as const;
/** The storm world's seed (accept.p2.loop-storm-bounded). */
const SEED = 7;
/** The switches boot with their PC links; the loop is cabled at 40 s and the links are up at 41 s. */
const CABLE_AT_NS = 40 * SEC;
const PING_AT_NS = 41 * SEC;
/** The window: 100 ms of sim time from the broadcast. */
const WINDOW_NS = 100 * MS;
/** The per-slice digests: 10 slices of 10 ms. */
const SLICE_NS = 10 * MS;

/** Contents of test/goldens/p3c-storm-window.json. */
interface StormGolden {
  readonly about: string;
  readonly world: { readonly seed: number; readonly profile: 'P1'; readonly stage: 'P2'; readonly cableAtS: number; readonly pingAtS: number; readonly windowMs: number; readonly sliceMs: number };
  readonly dispatched: number;
  readonly eventCount: number;
  readonly kinds: Readonly<Record<string, number>>;
  readonly eventsDigest: string;
  readonly windows: readonly string[];
}

const GOLDEN_URL = new URL('./goldens/p3c-storm-window.json', import.meta.url);

const ABOUT =
  'The loop-storm 100 ms window (ARCHITECTURE-P3C D3, §7 W0 and W0h, §10.1 accept.p3c.hot-path), recorded from the ' +
  'unchanged engine at commit cad4ac9 before any P3c code: the P1-profile storm world of accept.p2.loop-storm-bounded ' +
  '(two NF-C2960 on the stage-P2 catalog, three parallel cables at 40 s, PC1 pings at 41 s), runFor(100 ms) from the ' +
  'ping. The scheduler events dispatched, the trace events per kind, the SHA-256 of every event line and per-10 ms ' +
  'digests. The byte proof of [S40]: a hot-path change must leave it exactly. Re-record only with ' +
  'NF_RECORD_P3C_STORM_WINDOW=1 (the architect).';

const WORLD = { seed: SEED, profile: 'P1', stage: 'P2', cableAtS: CABLE_AT_NS / SEC, pingAtS: PING_AT_NS / SEC, windowMs: WINDOW_NS / MS, sliceMs: SLICE_NS / MS } as const;

/** Two switches with a PC each (accept.p2.loop-storm-bounded `stormWorld('P1', false)`). */
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

/** One measured window: what the golden records, plus its wall time (reported, never asserted). */
interface WindowRun {
  readonly record: Omit<StormGolden, 'about' | 'world'>;
  readonly wallMs: number;
  readonly pingError: unknown;
}

/** Build the storm, run the 100 ms window and digest it. */
function runWindow(): WindowRun {
  const sim = stormWorld();
  sim.runUntil(CABLE_AT_NS);
  PARALLEL.forEach((port, i) => sim.addLink({ id: PARALLEL_LINKS[i]!, a: { device: 'sw1', port }, b: { device: 'sw2', port } }));
  sim.runUntil(PING_AT_NS);
  const events: TraceEvent[] = [];
  const off = sim.onTrace((ev) => events.push(ev));
  const session = sim.cli.open('pc1', 'console');
  const r = sim.cli.exec(session, 'ping 10.0.0.2');
  const start = performance.now();
  const stats = sim.runFor(WINDOW_NS);
  const wallMs = Math.round(performance.now() - start);
  off();
  const owners = macOwners(sim.snapshot());
  const lines = events.map((ev) => eventLine(ev, owners));
  const kinds: Record<string, number> = {};
  for (const k of [...new Set(events.map((e) => e.kind))].sort()) kinds[k] = events.filter((e) => e.kind === k).length;
  const slices: string[][] = Array.from({ length: WINDOW_NS / SLICE_NS + 1 }, () => []);
  events.forEach((ev, i) => slices[Math.min(slices.length - 1, Math.floor((ev.t - PING_AT_NS) / SLICE_NS))]!.push(lines[i]!));
  return {
    record: {
      dispatched: stats.events,
      eventCount: events.length,
      kinds,
      eventsDigest: sha256Hex(lines.join('\n')),
      windows: slices.map((s) => `${s.length}:${sha256Hex(s.join('\n')).slice(0, 16)}`),
    },
    wallMs,
    pingError: r.error,
  };
}

let runCache: WindowRun | undefined;
function freshRun(): WindowRun {
  runCache ??= runWindow();
  return runCache;
}

function golden(): StormGolden {
  if (!existsSync(GOLDEN_URL)) throw new Error('test/goldens/p3c-storm-window.json is missing; it is recorded once, from the unchanged engine at cad4ac9 (P3C §7 W0).');
  return JSON.parse(readFileSync(GOLDEN_URL, 'utf8')) as StormGolden;
}

describe('accept P3c hot-path [S40]: the loop-storm 100 ms window equals the cad4ac9 golden', () => {
  beforeAll(() => {
    if ((process.env['NF_RECORD_P3C_STORM_WINDOW'] ?? '').trim() === '') return;
    const run = freshRun();
    const file: StormGolden = { about: ABOUT, world: WORLD, ...run.record };
    writeFileSync(GOLDEN_URL, `${JSON.stringify(file, null, 2)}\n`);
    console.log(`p3c-storm-window.json recorded: ${run.record.dispatched} dispatched, ${run.record.eventCount} trace events, ${run.wallMs} ms wall`);
  }, 900_000);

  it('the window: scheduler events dispatched, trace events per kind, the digest of every event and each 10 ms slice', () => {
    const g = golden();
    expect(g.about).toBe(ABOUT);
    expect(g.world).toEqual(WORLD);
    const run = freshRun();
    console.log(`storm window: ${run.record.eventCount} trace events, ${run.record.dispatched} dispatched, ${run.wallMs} ms wall (recorded, not asserted)`);
    expect(run.pingError).toBeUndefined();
    // the storm is real: the ARP request multiplied until the egress queues filled
    expect(run.record.kinds['drop'] ?? 0).toBeGreaterThan(0);
    expect(run.record.eventCount).toBeGreaterThan(1000);
    expect(run.record.kinds).toEqual(g.kinds);
    expect(run.record.eventCount).toBe(g.eventCount);
    expect(run.record.dispatched).toBe(g.dispatched);
    const slices = g.windows.map((w, k) => (w === run.record.windows[k] ? '' : `[${k * WORLD.sliceMs} ms, ${(k + 1) * WORLD.sliceMs} ms) ${w} → ${run.record.windows[k]}`)).filter((s) => s !== '');
    expect(slices, 'the 10 ms slices that differ (golden → run)').toEqual([]);
    expect(run.record.eventsDigest).toBe(g.eventsDigest);
    expect(canonicalJson(run.record)).toBe(canonicalJson({ dispatched: g.dispatched, eventCount: g.eventCount, kinds: g.kinds, eventsDigest: g.eventsDigest, windows: g.windows }));
    // Advisory timeout (P3 R61(c)): the body is synchronous, so vitest arms its timer only after it returns.
  }, 900_000);
});

describe('accept P3c [S40]: the benchmark lives outside every project (RC3 (c))', () => {
  it('bench/loop-storm.ts exists; no vitest project glob and no tsconfig include reaches it', () => {
    const root = new URL('..', import.meta.url);
    expect(existsSync(new URL('bench/loop-storm.ts', root))).toBe(true);
    const workspace = readFileSync(new URL('vitest.workspace.ts', root), 'utf8');
    expect(workspace).not.toMatch(/['"]bench\//);
    // every project includes only *.test.ts under test/ or src/ (ALL_TESTS), or named test/ files
    expect(workspace).toContain("const ALL_TESTS = ['test/**/*.test.ts', 'src/**/*.test.ts'];");
    const tsconfig = JSON.parse(readFileSync(new URL('tsconfig.json', root), 'utf8')) as { include?: string[] };
    for (const inc of tsconfig.include ?? []) expect(inc.startsWith('bench')).toBe(false);
  });
});
