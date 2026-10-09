/**
 * P3 acceptance — OSPF at scale (ARCHITECTURE-P3 D7, D8, D9, D10, §3.2, §4.2, §4.5, §7 W4 step 1, §12.2 R3,
 * §10.1 row `accept.p3.ospf-scale`).
 *
 * 50 NF-2911 routers in one area on the P3 catalog (`test/p3-flip.world.ts`: the real catalog since the W4 flip,
 * ruling R47), configured through their startup texts:
 *   - a ring of GigE point-to-point links (Ri Gi0/0 — Ri+1 Gi0/1, 10.1.i.0/30, `ip ospf network point-to-point`);
 *   - 25 serial chords across the ring (Ri Se0/0/0, the DCE end with `clock rate 64000` — Ri+25 Se0/0/1, 10.2.i.0/30);
 *   - Loopback0 10.255.0.i/32 on each, router id i.i.i.i, `network 10.0.0.0 0.255.255.255 area 0`.
 * 125 prefixes in all (50 ring, 25 chord, 50 loopback); each router owns 4 and learns the other 121 as `O` routes.
 *
 * Pinned:
 *   1. converged under the clone cap: `runToIdle(LAB_CLONE_BOOT_EVENTS)` from t = 0 returns (not `maxEvents`) — the
 *      grader clone settles this world — and every router then holds exactly the 121 `O` routes, its 4 connected
 *      prefixes completing the 125, its LSDB holding the 50 router-LSAs, every adjacency FULL;
 *   2. a converged minute under a fixed event bound (`CONVERGED_MINUTE_EVENT_BOUND`, derived below from the hello
 *      count) with no SPF run, no LSA origination and no route change in it;
 *   3. SPF runs per change bounded by the throttle (D9): after one ring cable is cut, every router's SPF runs come
 *      no sooner than `OSPF_SPF_DELAY_NS` after the cut and at least `OSPF_SPF_HOLD_NS` apart, at most
 *      `SPF_RUNS_PER_CHANGE` per router, and the area re-converges (the cut prefix gone, every loopback still routed);
 *   4. no `action-budget` drop anywhere, in the whole run.
 */
import { describe, expect, it } from 'vitest';
import type { DeviceId } from '../src/contracts/ids.js';
import type { Simulation } from '../src/contracts/simulation.js';
import type { OspfLsaRow, OspfNeighborRow, RouteRow } from '../src/contracts/tables.js';
import { SEC, type SimTime } from '../src/contracts/time.js';
import type { TraceEvent } from '../src/contracts/trace.js';
import { OSPF_SPF_DELAY_NS, OSPF_SPF_HOLD_NS } from '../src/protocols/ospf.js';
import { OSPF_HELLO_S_DEFAULT } from '../src/protocols/ospf/config.js';
import { LAB_CLONE_BOOT_EVENTS } from '../src/sim/lab-checks.js';
import { createP3Simulation, startupText } from './p3-flip.world.js';
import { ofKind } from './sim.harness.js';

const ROUTERS = 50;
const CHORDS = ROUTERS / 2;
const GI0 = 'GigabitEthernet0/0';
const GI1 = 'GigabitEthernet0/1';
const SE0 = 'Serial0/0/0';
const SE1 = 'Serial0/0/1';
const MASK30 = '255.255.255.252';

const rid = (i: number): DeviceId => `r${i}`;
/** The ring neighbour after / before router i (1-based, wrapping). */
const next = (i: number): number => (i === ROUTERS ? 1 : i + 1);
const prev = (i: number): number => (i === 1 ? ROUTERS : i - 1);

/** Every prefix of the area: 50 ring /30s, 25 chord /30s, 50 loopback /32s. */
const ALL_PREFIXES: readonly string[] = [
  ...Array.from({ length: ROUTERS }, (_, k) => `10.1.${k + 1}.0/30`),
  ...Array.from({ length: CHORDS }, (_, k) => `10.2.${k + 1}.0/30`),
  ...Array.from({ length: ROUTERS }, (_, k) => `10.255.0.${k + 1}/32`),
];
/** The prefixes router i is attached to (its own two ring links, its chord, its loopback). */
function ownPrefixes(i: number): string[] {
  const chord = i <= CHORDS ? i : i - CHORDS;
  return [`10.1.${i}.0/30`, `10.1.${prev(i)}.0/30`, `10.2.${chord}.0/30`, `10.255.0.${i}/32`];
}

/** Router i's startup configuration. */
function routerConfig(i: number): string {
  const p2p = ' ip ospf network point-to-point';
  const chord = i <= CHORDS
    ? [`interface ${SE0}`, ` ip address 10.2.${i}.1 ${MASK30}`, ' clock rate 64000', ' no shutdown']
    : [`interface ${SE1}`, ` ip address 10.2.${i - CHORDS}.2 ${MASK30}`, ' no shutdown'];
  return startupText([
    [`hostname R${i}`],
    ['interface Loopback0', ` ip address 10.255.0.${i} 255.255.255.255`],
    [`interface ${GI0}`, ` ip address 10.1.${i}.1 ${MASK30}`, p2p, ' no shutdown'],
    [`interface ${GI1}`, ` ip address 10.1.${prev(i)}.2 ${MASK30}`, p2p, ' no shutdown'],
    chord,
    ['router ospf 1', ` router-id ${i}.${i}.${i}.${i}`, ' network 10.0.0.0 0.255.255.255 area 0'],
  ]);
}

function scaleWorld(): { sim: Simulation; events: TraceEvent[] } {
  const sim = createP3Simulation({ seed: 50 });
  const events: TraceEvent[] = [];
  sim.onTrace((ev) => events.push(ev));
  for (let i = 1; i <= ROUTERS; i++) sim.addDevice({ id: rid(i), type: 'router.nf2911', name: `R${i}`, startupConfig: routerConfig(i) });
  for (let i = 1; i <= ROUTERS; i++) sim.addLink({ id: `ring_${i}`, a: { device: rid(i), port: GI0 }, b: { device: rid(next(i)), port: GI1 } });
  for (let i = 1; i <= CHORDS; i++) sim.addLink({ id: `chord_${i}`, a: { device: rid(i), port: SE0 }, b: { device: rid(i + CHORDS), port: SE1 }, media: 'serial-dce', dceEnd: 'a' });
  return { sim, events };
}

const oRoutes = (sim: Simulation, id: DeviceId): RouteRow[] => sim.device(id)!.tables.rib.rows().filter((r) => r.source === 'O');
const prefixOf = (r: RouteRow): string => `${r.network}/${r.prefixLen}`;

/** The SPF runs of `device` in `evs` (the `ip ospf spf` debug line every run emits), as times. */
function spfRuns(evs: readonly TraceEvent[], device: DeviceId): SimTime[] {
  return ofKind(evs, 'debug').filter((e) => e.event.device === device && e.event.category === 'ip ospf spf' && e.event.message.startsWith('SPF run ')).map((e) => e.t);
}

/**
 * A converged minute's event bound. Each of the 150 OSPF interfaces sends one hello per `OSPF_HELLO_S_DEFAULT` (6 a
 * minute: 900 hellos); with each hello's own timer, transmission and arrival dispatches, the 25 serial links' HDLC
 * keepalives (10 s) and the CDP frames of the 100 GigE ports (60 s), a quiet minute dispatches well under ten events
 * per hello. A converged area that re-floods, re-runs SPF or retransmits breaks it.
 */
const HELLOS_PER_MINUTE = (ROUTERS * 2 + CHORDS * 2) * (60 / OSPF_HELLO_S_DEFAULT);
const CONVERGED_MINUTE_EVENT_BOUND = HELLOS_PER_MINUTE * 10;
/**
 * One SPF run per router for one cut. Both endpoints see the link go down at the cut and re-originate their
 * router-LSAs at once (their last origination is long past MinLSInterval); the two LSAs cross the area in far less
 * than `OSPF_SPF_DELAY_NS` (at most 25 hops, the slowest a 64 kb/s chord at a few ms), so the first one arms the SPF
 * and the second one finds it already armed: the throttle folds the whole change into a single run.
 */
const SPF_RUNS_PER_CHANGE = 1;
/** Watched after the cut: longer than delay + hold + flooding, so every run the change causes is in it. */
const AFTER_CUT_NS: SimTime = 60 * SEC;

describe('accept P3 ospf-scale', () => {
  it('50 routers in one area: converged under the clone cap, a quiet converged minute, SPF throttled per change, no action-budget drop', () => {
    const { sim, events } = scaleWorld();

    // 1. converged under the clone cap
    const boot = sim.runToIdle(LAB_CLONE_BOOT_EVENTS);
    expect(boot.stopped, `runToIdle dispatched ${boot.events} events`).toBeUndefined();
    expect(boot.events).toBeLessThan(LAB_CLONE_BOOT_EVENTS);
    for (let i = 1; i <= ROUTERS; i++) {
      const id = rid(i);
      const learned = oRoutes(sim, id).map(prefixOf).sort();
      expect(learned.length, `${id} O routes`).toBe(ALL_PREFIXES.length - 4);
      expect([...learned, ...ownPrefixes(i)].sort(), id).toEqual([...ALL_PREFIXES].sort());
      const nbrs = sim.device(id)!.tables.get<OspfNeighborRow>('ospf-neighbors')!.rows();
      expect(nbrs.length, `${id} neighbours`).toBe(3);
      expect(nbrs.every((n) => n.state === 'full'), `${id}: ${nbrs.map((n) => `${n.routerId} ${n.state}`).join(', ')}`).toBe(true);
      const routerLsas = sim.device(id)!.tables.get<OspfLsaRow>('ospf-lsdb')!.rows().filter((r) => r.type === 1);
      expect(routerLsas.length, `${id} router-LSAs`).toBe(ROUTERS);
    }

    // 2. a converged minute under a fixed event bound, with no SPF, origination or route change in it
    const minuteFrom = events.length;
    const minute = sim.runFor(60 * SEC);
    expect(minute.stopped).toBeUndefined();
    expect(minute.events).toBeGreaterThan(HELLOS_PER_MINUTE);
    expect(minute.events).toBeLessThan(CONVERGED_MINUTE_EVENT_BOUND);
    const quiet = events.slice(minuteFrom);
    expect(ofKind(quiet, 'debug').filter((e) => e.event.category === 'ip ospf spf').map((e) => `${e.event.device}: ${e.event.message}`)).toEqual([]);
    expect(ofKind(quiet, 'tableWrite').filter((e) => e.table === 'rib' || (e.table === 'ospf-lsdb' && e.row['self'] === true)).map((e) => `${e.device} ${e.table} ${e.key}`)).toEqual([]);

    // 3. one change: a ring cable cut; SPF throttled on every router; the area re-converges
    const cutAt = sim.now;
    const cutFrom = events.length;
    sim.removeLink('ring_1');
    const after = sim.runFor(AFTER_CUT_NS);
    expect(after.stopped).toBeUndefined();
    const changed = events.slice(cutFrom);
    for (let i = 1; i <= ROUTERS; i++) {
      const id = rid(i);
      const runs = spfRuns(changed, id);
      expect(runs.length, `${id} ran SPF after the cut`).toBeGreaterThanOrEqual(1);
      expect(runs.length, `${id} SPF runs ${runs.map((t) => t - cutAt).join(', ')}`).toBeLessThanOrEqual(SPF_RUNS_PER_CHANGE);
      expect(runs[0]! - cutAt, `${id} first SPF`).toBeGreaterThanOrEqual(OSPF_SPF_DELAY_NS);
      for (let k = 1; k < runs.length; k++) expect(runs[k]! - runs[k - 1]!, `${id} SPF hold`).toBeGreaterThanOrEqual(OSPF_SPF_HOLD_NS);
      const learned = oRoutes(sim, id).map(prefixOf);
      expect(learned.includes('10.1.1.0/30'), `${id} still routes the cut link`).toBe(false);
      for (let k = 1; k <= ROUTERS; k++) if (k !== i) expect(learned.includes(`10.255.0.${k}/32`), `${id} → loopback ${k}`).toBe(true);
    }

    // 4. no daemon ran out of its action budget
    expect(ofKind(events, 'drop').filter((e) => e.detail === 'action-budget')).toEqual([]);
  }, 180_000);
});
