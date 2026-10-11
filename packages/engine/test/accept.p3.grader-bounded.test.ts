/**
 * P3 acceptance — the grader is bounded (ARCHITECTURE-P3 §10.1 row `accept.p3.grader-bounded`; §4.2's consequences,
 * §4.3, D5; §7 W5 sim). The row:
 *
 *   "For every CCNA 3 lab (the approved labs 10, 24, 25 and 33 and the approved tasks included): the unsolved, solved
 *    and each wrong-answer world reach idle under `runToIdle` within the clone's event cap; a world with a mismatched
 *    OSPF hello, a stuck ExStart, an NTP server that never answers (six fast retries, then only the periodic poll),
 *    [S19] a failed CHAP, [C1] an EIGRP K-value mismatch and [C13] a wrong IKE key or a silent IKE peer each returns in
 *    fewer than 5 000 events."
 *
 * Part 1 is GENERIC over `CCNA3_LABS` (read at run time: every lab that has landed). For each lab three kinds of world
 * are copied the way the grader copies them (sim/lab-checks.ts `settledClone`: the export loaded with the live seed and
 * catalog, the live cut cables and err-disabled ports re-applied at t = 0, `runToIdle(LAB_CLONE_BOOT_EVENTS)`), and the
 * copy must reach idle before that cap: the UNSOLVED world (booted, its scheduled faults landed), the SOLVED world (its
 * reference solution applied) and each WRONG-ANSWER world — the reference solution with one device's lines left out,
 * once per device the solution names (a learner who stopped one device short). The approved labs 10, 24, 25 and 33 and
 * the approved tasks of the MUST labs are among them, since every lab of `CCNA3_LABS` is. (The `traffic` kind runs
 * its flows under `runFor`, ruling R44, so a continuous flow never meets `runToIdle`.)
 *
 * Part 2 builds each named world in P3 profile on the real catalog (test/approved-kinds.world.ts) and runs it from the
 * load — the view a grader clone has of it — with `runToIdle(5000)`: it must return (not stop at the cap) after fewer
 * than 5 000 events, with the fault really in place (no Full adjacency, no synchronisation, CHAP failed, no EIGRP
 * neighbour, no IPsec SA).
 */
import { describe, expect, it } from 'vitest';
import type { DeviceId } from '../src/contracts/ids.js';
import type { ScenarioInfo } from '../src/contracts/scenario.js';
import type { RunStats, Simulation } from '../src/contracts/simulation.js';
import type { EigrpNeighborRow, IpsecSaRow, NtpPeerRow, OspfNeighborRow, PppRow } from '../src/contracts/tables.js';
import { SEC } from '../src/contracts/time.js';
import type { Topology } from '../src/contracts/topology.js';
import { LAB_CLONE_BOOT_EVENTS } from '../src/sim/lab-checks.js';
import { CCNA3_LABS } from '../src/sim/scenarios/ccna3/index.js';
import { createSimulation } from '../src/sim/simulation.js';
import { KEY, pairWorld, tunnelWorld } from './approved-kinds.world.js';

/** Long enough for every model of a lab to boot (the router takes 45 s). */
const BOOT_NS = 90 * SEC;

/** The bound of part 2 (§10.1). */
const BOUND = 5_000;

/** Wall-clock budget of one lab (its unsolved, solved and wrong-answer worlds, each copied once). */
const LAB_TIMEOUT_MS = 300_000;

/** The lab's world as `loadScenario` builds it: the lab seed and topology, its scheduled faults, booted and settled. */
function labWorld(lab: ScenarioInfo): Simulation {
  const sim = createSimulation({ seed: lab.seed ?? 1 });
  sim.loadTopology({ ...lab.build(), lab: { name: lab.name, version: lab.version ?? 1 } });
  for (const f of lab.faults ?? []) sim.injectFault(f.at, f.fault);
  sim.runFor(BOOT_NS);
  sim.runToIdle();
  return sim;
}

function idOf(sim: Simulation, name: string): DeviceId {
  for (const d of sim.devices()) if (d.spec.name === name) return d.id;
  throw new Error(`no device called ${name} in this lab`);
}

/** Configure the solution's lines for the devices named in `devices` (every line must be accepted). */
function configureSolution(sim: Simulation, lab: ScenarioInfo, devices: readonly string[]): void {
  for (const [name, lines] of Object.entries(lab.solution ?? {})) {
    if (!devices.includes(name)) continue;
    const r = sim.configure(idOf(sim, name), lines);
    expect(r.lines.filter((l) => !l.ok).map((l) => `${l.line}: ${l.error?.message ?? l.output}`), `${lab.name} solution for ${name}`).toEqual([]);
  }
}

/**
 * The grader's settle of a copy of `sim` (sim/lab-checks.ts `settledClone`): the export loaded with the live seed and
 * catalog, the live cut cables and err-disabled ports re-applied at t = 0, run to idle within the clone's event cap.
 */
function cloneSettle(sim: Simulation): RunStats {
  const topo: Topology = sim.exportTopology();
  const copy = createSimulation({ seed: sim.seed, catalog: sim.catalog, journal: false });
  copy.loadTopology(topo);
  for (const l of topo.links) {
    if (sim.link(l.id)?.downReason === 'cut') copy.injectFault(0, { id: `bounded-cut:${l.id}`, kind: 'cable-cut', target: { link: l.id } });
  }
  for (const d of sim.devices()) {
    for (const p of d.ports.values()) {
      if (p.errDisabled !== undefined) copy.injectFault(0, { id: `bounded-errdisable:${d.id}:${p.id}`, kind: 'err-disable', target: { device: d.id, port: p.id }, params: { cause: p.errDisabled } });
    }
  }
  return copy.runToIdle(LAB_CLONE_BOOT_EVENTS);
}

/** Load `t` and run it to idle from the load (the grader clone's view), within the bound. */
function fromLoad(t: Topology): { sim: Simulation; stats: RunStats } {
  const sim = createSimulation({ seed: t.seed });
  sim.loadTopology(t);
  return { sim, stats: sim.runToIdle(BOUND) };
}

const rows = <R,>(sim: Simulation, device: string, table: string): R[] =>
  (sim.device(device)?.tables.get(table)?.rows() ?? []) as unknown as R[];

describe('accept.p3.grader-bounded: every CCNA 3 lab settles in the grader clone', () => {
  it('has CCNA 3 labs to check', () => {
    expect(CCNA3_LABS.length).toBeGreaterThan(0);
  });

  for (const lab of CCNA3_LABS) {
    it(`${lab.name}: the unsolved, solved and every wrong-answer world reach idle within the clone's event cap`, () => {
      const devices = Object.keys(lab.solution ?? {});
      const unsolved = labWorld(lab);
      expect(cloneSettle(unsolved).stopped, `${lab.name} unsolved`).toBeUndefined();

      const solved = labWorld(lab);
      configureSolution(solved, lab, devices);
      expect(cloneSettle(solved).stopped, `${lab.name} solved`).toBeUndefined();

      // a learner who stopped one device short: the solution without that device's lines, once per device
      for (const left of devices) {
        const wrong = labWorld(lab);
        configureSolution(wrong, lab, devices.filter((d) => d !== left));
        expect(cloneSettle(wrong).stopped, `${lab.name} without ${left}'s lines`).toBeUndefined();
      }
    }, LAB_TIMEOUT_MS);
  }
});

describe('accept.p3.grader-bounded: worlds that never converge still return in fewer than 5 000 events', () => {
  const ospf: readonly string[] = ['router ospf 1', ' network 10.0.12.0 0.0.0.3 area 0'];

  it('a mismatched OSPF hello: no adjacency, and runToIdle returns', () => {
    const { sim, stats } = fromLoad(pairWorld(51, 'ethernet', { global: [ospf] }, { iface: ['ip ospf hello-interval 5'], global: [ospf] }));
    expect(stats.stopped).toBeUndefined();
    expect(stats.events).toBeLessThan(BOUND);
    expect(rows<OspfNeighborRow>(sim, 'r1', 'ospf-neighbors')).toEqual([]);
    expect(rows<OspfNeighborRow>(sim, 'r2', 'ospf-neighbors')).toEqual([]);
  });

  it('a stuck ExStart (R2 drops the unicast database descriptions R1 sends it): never Full, and runToIdle returns', () => {
    const acl: readonly string[] = ['access-list 101 deny ospf host 10.0.12.1 host 10.0.12.2', 'access-list 101 permit ip any any'];
    const { sim, stats } = fromLoad(pairWorld(52, 'ethernet', { global: [ospf] }, { iface: ['ip access-group 101 in'], global: [acl, ospf] }));
    expect(stats.stopped).toBeUndefined();
    expect(stats.events).toBeLessThan(BOUND);
    const states = [...rows<OspfNeighborRow>(sim, 'r1', 'ospf-neighbors'), ...rows<OspfNeighborRow>(sim, 'r2', 'ospf-neighbors')].map((r) => r.state);
    expect(states.length).toBeGreaterThan(0);
    expect(states).not.toContain('full');
    expect(states.some((s) => s === 'exstart' || s === 'exchange')).toBe(true);
  });

  it('an NTP server that never answers: six fast retries, then only the periodic poll; runToIdle returns', () => {
    const { sim, stats } = fromLoad(pairWorld(53, 'ethernet', { global: [['ntp server 10.0.12.2']] }, {}));
    expect(stats.stopped).toBeUndefined();
    expect(stats.events).toBeLessThan(BOUND);
    const peers = rows<NtpPeerRow>(sim, 'r1', 'ntp-peers');
    expect(peers.map((p) => p.address)).toEqual(['10.0.12.2']);
    expect(peers[0]?.selected).not.toBe('sys-peer');
  });

  it('[S19] a failed CHAP: authentication fails on both ends, and runToIdle returns', () => {
    const ppp = (peer: string, password: string): { iface: string[]; global: string[][] } => ({
      iface: ['encapsulation ppp', 'ppp authentication chap'],
      global: [[`username ${peer} password ${password}`]],
    });
    const { sim, stats } = fromLoad(pairWorld(54, 'serial', ppp('R2', 'NetF0rge'), ppp('R1', 'WRONG')));
    expect(stats.stopped).toBeUndefined();
    expect(stats.events).toBeLessThan(BOUND);
    const r1 = rows<PppRow>(sim, 'r1', 'ppp')[0];
    expect(r1).toBeDefined();
    expect(r1?.lcp).not.toBe('opened');
    expect([r1?.authLocalState, r1?.authPeerState]).toContain('failed');
  });

  it('[C1] an EIGRP K-value mismatch: no neighbour, and runToIdle returns', () => {
    const eigrp = (k?: string): string[] => ['router eigrp 100', ' network 10.0.12.0 0.0.0.3', ...(k === undefined ? [] : [` metric weights ${k}`])];
    const { sim, stats } = fromLoad(pairWorld(55, 'ethernet', { global: [eigrp()] }, { global: [eigrp('0 1 1 1 0 0')] }));
    expect(stats.stopped).toBeUndefined();
    expect(stats.events).toBeLessThan(BOUND);
    expect(rows<EigrpNeighborRow>(sim, 'r1', 'eigrp-neighbors').filter((r) => r.state === 'up')).toEqual([]);
    expect(rows<EigrpNeighborRow>(sim, 'r2', 'eigrp-neighbors').filter((r) => r.state === 'up')).toEqual([]);
  });

  it('[C13] a wrong IKE key: no SA, and runToIdle returns', () => {
    const { sim, stats } = fromLoad(tunnelWorld('ipsec', 'Nf-Other-Key-99'));
    expect(stats.stopped).toBeUndefined();
    expect(stats.events).toBeLessThan(BOUND);
    for (const d of ['r1', 'r2']) expect(rows<IpsecSaRow>(sim, d, 'ipsec-sa').map((r) => r.state)).not.toContain('established');
  });

  it('[C13] a silent IKE peer: three retransmissions, then only the periodic retry; runToIdle returns', () => {
    const { sim, stats } = fromLoad(tunnelWorld('ipsec', KEY, { silentPeer: true }));
    expect(stats.stopped).toBeUndefined();
    expect(stats.events).toBeLessThan(BOUND);
    expect(rows<IpsecSaRow>(sim, 'r1', 'ipsec-sa').map((r) => r.state)).not.toContain('established');
    expect(rows<IpsecSaRow>(sim, 'r2', 'ipsec-sa')).toEqual([]);
  });
});
