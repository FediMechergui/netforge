/**
 * W2 l2 (ARCHITECTURE-P2 §3.0 "Debug wording stays byte-identical", §0 rule 13, §9.1, §12.2 stage-flip risk): the
 * VLAN-aware eth-switch path on untagged VLAN-1 traffic produces EXACTLY the events of the transparent path.
 *
 * The two P0 golden scenarios (`two-pcs-and-switch`, `pc-router-pc`) are run twice with the same seed and the same
 * script as accept.p05.determinism: once on the real catalog (the transparent path — the P1 engine of today) and once
 * on `test/p2.world.ts` in the P1 profile with the real `vlan` factory (the P2-stage NF-C2960 carries
 * `managed-switch`, so its eth-switch runs the VLAN-aware path). Every trace event of every kind — debug and log
 * included, no tolerated additions — must match line for line, and the snapshots must be equal once the P2 vocabulary
 * the P2-stage model adds by construction (the `vlan` StateView, the `vlans` and `port-security` tables, the
 * `managed-switch` capability, P2 GUI panels and port roles) is removed. The P0 golden itself (`goldens/
 * accept.p05.p0-sequences.json`) is then contained in the p2.world run exactly as accept.p05.determinism checks it.
 */
import { describe, expect, it } from 'vitest';
import { PROCESS_ORDER } from '../src/contracts/catalog.js';
import type { Simulation } from '../src/contracts/simulation.js';
import type { SimSnapshot } from '../src/contracts/snapshot.js';
import { TABLE_DESCRIPTORS } from '../src/contracts/tables.js';
import { SEC } from '../src/contracts/time.js';
import type { Topology } from '../src/contracts/topology.js';
import { createVlan } from '../src/protocols/vlan.js';
import { pcRouterPc, twoPcsAndSwitch } from '../src/sim/scenarios.js';
import { createSimulation } from '../src/sim/simulation.js';
import { canonicalJson, containmentProblems, macOwners, p0EventLine, readP0Reference, replaceMacs } from './accept.p05.harness.js';
import { createP2Simulation } from './p2.world.js';

interface Scenario {
  readonly name: string;
  readonly build: () => Topology;
  readonly bootNs: number;
  readonly target: string;
}

const SCENARIOS: readonly Scenario[] = [
  { name: 'two-pcs-and-switch', build: twoPcsAndSwitch, bootNs: 40 * SEC, target: '10.0.0.2' },
  { name: 'pc-router-pc', build: pcRouterPc, bootNs: 60 * SEC, target: '10.0.1.1' },
];

/** The script of accept.p05.determinism: boot, one ping from PC1, run to idle. */
function run(sim: Simulation, s: Scenario): { lines: string[]; snapshot: SimSnapshot; count: number } {
  sim.loadTopology(s.build());
  sim.runFor(s.bootNs);
  const session = sim.cli.open('pc1', 'console');
  sim.cli.exec(session, `ping ${s.target}`);
  sim.runToIdle();
  const snapshot = sim.snapshot();
  const owners = macOwners(snapshot);
  const events = sim.trace(0).events;
  return { lines: events.map((e) => p0EventLine(e, owners)), snapshot, count: events.length };
}

/** P2 daemons: names the contract PROCESS_ORDER does not list yet (their factories register in W4/W6, §0 rule 3). */
const isP2Process = (name: string): boolean => !PROCESS_ORDER.includes(name);
/** P2 tables: descriptors `since: 'P2'`. */
const P2_TABLE_NAMES = new Set(Object.values(TABLE_DESCRIPTORS).filter((d) => d.since === 'P2').map((d) => d.name));

/**
 * The p2.world snapshot with the P2 vocabulary removed, and the list of what was removed (so the test can assert that
 * nothing but the expected P2 additions was there): P2 StateViews, P2 extra tables, and the members of the
 * model-derived lists (`capabilities`, `gui`, port `allowedRoles`) that the transparent-path snapshot does not have.
 */
function stripP2(snapshot: SimSnapshot, reference: SimSnapshot): { stripped: unknown; removed: string[] } {
  const removed: string[] = [];
  const copy = JSON.parse(JSON.stringify(snapshot)) as SimSnapshot;
  for (const d of copy.devices) {
    const ref = reference.devices.find((r) => r.id === d.id);
    if (ref === undefined) continue;
    d.processes = d.processes.filter((p) => {
      if (isP2Process(p.process)) {
        removed.push(`${d.id}: process ${p.process}`);
        return false;
      }
      return true;
    });
    if (d.tables.extra !== undefined) {
      d.tables.extra = d.tables.extra.filter((t) => {
        if (P2_TABLE_NAMES.has(t.name)) {
          removed.push(`${d.id}: table ${t.name}`);
          return false;
        }
        return true;
      });
      if (d.tables.extra.length === 0 && ref.tables.extra === undefined) delete d.tables.extra;
    }
    const refCaps = new Set<string>(ref.capabilities);
    d.capabilities = d.capabilities.filter((c) => {
      if (refCaps.has(c)) return true;
      removed.push(`${d.id}: capability ${c}`);
      return false;
    });
    const refGui = new Set<string>(ref.gui);
    d.gui = d.gui.filter((g) => {
      if (refGui.has(g)) return true;
      removed.push(`${d.id}: panel ${g}`);
      return false;
    });
    for (const port of d.ports) {
      const refPort = ref.ports.find((p) => p.id === port.id);
      const roles = new Set<string>(refPort?.allowedRoles ?? []);
      port.allowedRoles = port.allowedRoles.filter((r) => {
        if (roles.has(r)) return true;
        removed.push(`${d.id}/${port.id}: role ${r}`);
        return false;
      });
    }
  }
  return { stripped: copy, removed };
}

describe('eth-switch P0 parity on p2.world (VLAN-aware path, P1 profile)', () => {
  const reference = readP0Reference();

  for (const s of SCENARIOS) {
    it(`${s.name}: every event of every kind is identical to the transparent path, and the snapshot equal modulo the P2 vocabulary`, () => {
      const seed = reference.scenarios[s.name]!.seed;
      const classic = run(createSimulation({ seed }), s);
      const p2 = run(createP2Simulation({ seed, profile: 'P1', factories: { vlan: createVlan } }), s);

      // the P2-stage switch really runs the VLAN-aware path
      const sw = p2.snapshot.devices.find((d) => d.type === 'switch.nfc2960');
      if (s.name === 'two-pcs-and-switch') {
        expect(sw).toBeDefined();
        expect(sw!.capabilities).toContain('managed-switch');
        expect(sw!.processes.map((p) => p.process)).toContain('vlan');
      }

      // events: no tolerated additions, none missing, same order
      expect(p2.count).toBe(classic.count);
      const firstDiff = p2.lines.findIndex((l, i) => l !== classic.lines[i]);
      expect(firstDiff, `first diverging event at index ${firstDiff}: classic ${classic.lines[firstDiff]} vs p2 ${p2.lines[firstDiff]}`).toBe(-1);
      expect(p2.lines).toEqual(classic.lines);

      // snapshot: equal once the P2 vocabulary is removed, and only P2 vocabulary was removed
      const { stripped, removed } = stripP2(p2.snapshot, classic.snapshot);
      expect(canonicalJson(stripped)).toBe(canonicalJson(classic.snapshot));
      for (const r of removed) {
        expect(r, r).toMatch(/: (process vlan|table vlans|table port-security|capability managed-switch|panel |role )/);
      }

      // and the P0 golden is contained in the p2.world run exactly as accept.p05.determinism checks it
      const ref = reference.scenarios[s.name]!;
      const owners = macOwners(p2.snapshot);
      const traffic = (lines: readonly string[]): string[] => lines.filter((l) => !l.includes('|debug|'));
      expect(traffic(p2.lines)).toEqual(traffic(ref.events));
      expect(containmentProblems(ref.snapshot, replaceMacs(stripped, owners))).toEqual([]);
    });
  }

  it('the two runs of the VLAN-aware path with one seed are byte-identical', () => {
    const s = SCENARIOS[0]!;
    const seed = reference.scenarios[s.name]!.seed;
    const a = run(createP2Simulation({ seed, profile: 'P1', factories: { vlan: createVlan } }), s);
    const b = run(createP2Simulation({ seed, profile: 'P1', factories: { vlan: createVlan } }), s);
    expect(a.lines).toEqual(b.lines);
    expect(canonicalJson(a.snapshot)).toBe(canonicalJson(b.snapshot));
  });
});
