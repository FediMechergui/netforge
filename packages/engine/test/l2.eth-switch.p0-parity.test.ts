/**
 * W2 l2 (ARCHITECTURE-P2 §3.0 "Debug wording stays byte-identical", §0 rule 13, §9.1, §12.2 stage-flip risk): the
 * VLAN-aware eth-switch path on untagged VLAN-1 traffic produces EXACTLY the events of the transparent path.
 *
 * The two P0 golden scenarios (`two-pcs-and-switch`, `pc-router-pc`) are run twice with the same seed and the same
 * script as accept.p05.determinism: once on the transparent path and once on the VLAN-aware path. Before the W4
 * catalog flip the transparent path was the real catalog and the VLAN-aware one `test/p2.world.ts` with the real
 * `vlan` factory; since the flip (§7 W4 catalog) the real catalog IS the VLAN-aware path (NF-C2960 carries
 * `managed-switch` and runs `vlan`), so the transparent path is now `p2.world` in the P1 profile with the `vlan`
 * factory REMOVED (`factories: { vlan: undefined }`, the helper's documented way to model a daemon that is missing
 * even after the flip registered it): the same models, link timing and runtime, an eth-switch that is not VLAN-aware.
 * Every trace event of every kind — debug and log included, no tolerated additions — must match line for line, and
 * the snapshots must be equal once the P2 vocabulary the VLAN-aware model adds by construction (the `vlan`
 * StateView, the `vlans` and `port-security` tables, and any capability, GUI panel or port role the transparent
 * device lacks) is removed. The P0 golden itself (`goldens/accept.p05.p0-sequences.json`) is then contained in the
 * VLAN-aware run exactly as accept.p05.determinism checks it.
 *
 * Since the ARCHITECTURE-P3 W4 catalog flip the shipped catalog is derived at stage P3, and the VLAN-aware path stays
 * on it (ruling R51: the event parity holds there, so the P0 parity keeps exercising the shipped models). The models
 * then also carry the silent P3 vocabulary, which the strip removes by the rule of `normaliseSnapshot`
 * (p2-digests.harness.ts, §4.6 item 2): the StateViews of the P3 daemons and of every process the device derives only
 * through `since: 'P3'` capability rows (the managed switch's dormant `udp` and `tcp`, D22), the tables whose
 * descriptor is of stage P3 or that only those processes own, and the members of the model-derived lists the
 * transparent device lacks. The events stay exact.
 */
import { describe, expect, it } from 'vitest';
import { CAPABILITY_PROCESSES, type Capability } from '../src/contracts/catalog.js';
import type { Simulation } from '../src/contracts/simulation.js';
import type { SimSnapshot } from '../src/contracts/snapshot.js';
import { PROCESS_TABLES, TABLE_DESCRIPTORS } from '../src/contracts/tables.js';
import { SEC } from '../src/contracts/time.js';
import type { Topology } from '../src/contracts/topology.js';
import { createVlan } from '../src/protocols/vlan.js';
import { pcRouterPc, twoPcsAndSwitch } from '../src/sim/scenarios.js';
import { createSimulation } from '../src/sim/simulation.js';
import { canonicalJson, containmentProblems, macOwners, p0EventLine, readP0Reference, replaceMacs } from './accept.p05.harness.js';
import { P2_DAEMONS, createP2Simulation } from './p2.world.js';
import { P3_SILENCE_DAEMONS } from './p3-flip.world.js';

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

/** P2 daemons (the approved §2.1 names; `p2.world` filters exactly these when their factory is removed). */
const isP2Process = (name: string): boolean => P2_DAEMONS.includes(name);
/** P2 tables: descriptors `since: 'P2'`. */
const P2_TABLE_NAMES = new Set(Object.values(TABLE_DESCRIPTORS).filter((d) => d.since === 'P2').map((d) => d.name));
/** P3 tables: descriptors `since: 'P3'` (read at call time, rule 12). */
const p3TableNames = (): Set<string> => new Set(Object.values(TABLE_DESCRIPTORS).filter((d) => d.since === 'P3').map((d) => d.name as string));

/**
 * Processes a device derives only through `since: 'P3'` capability rows (a P3 daemon, or D22's dormant `udp` and
 * `tcp` of a managed switch): the `laterOnly` rule of `normaliseSnapshot` with P3 as the only later stage.
 */
function p3OnlyProcess(capabilities: readonly string[], process: string): boolean {
  const rows = capabilities.flatMap((c) => (CAPABILITY_PROCESSES[c as Capability] ?? []).filter((r) => r.process === process));
  return rows.length > 0 && rows.every((r) => r.since === 'P3');
}

/**
 * The VLAN-aware snapshot with the later vocabulary removed, and the list of what was removed (so the test can assert
 * that nothing but the expected P2 and P3 additions was there): the P2 StateViews and P2 extra tables the transparent
 * device does not have (since the P2 flip both run the silent dtp, etherchannel and stp daemons, so only `vlan` and
 * its tables differ); since the P3 flip (R51) the StateViews of the processes the device derives only through
 * `since: 'P3'` rows and the extra tables of stage P3 or owned only by those processes; and the members of the
 * model-derived lists (`capabilities`, `gui`, port `allowedRoles`) it lacks.
 */
function stripLater(snapshot: SimSnapshot, reference: SimSnapshot): { stripped: unknown; removed: string[] } {
  const removed: string[] = [];
  const p3Tables = p3TableNames();
  const copy = JSON.parse(JSON.stringify(snapshot)) as SimSnapshot;
  for (const d of copy.devices) {
    const ref = reference.devices.find((r) => r.id === d.id);
    if (ref === undefined) continue;
    const refProcesses = new Set<string>(ref.processes.map((p) => p.process));
    const dropped = new Set<string>();
    d.processes = d.processes.filter((p) => {
      if (refProcesses.has(p.process)) return true;
      if (isP2Process(p.process) || p3OnlyProcess(d.capabilities, p.process)) {
        dropped.add(p.process);
        removed.push(`${d.id}: process ${p.process}`);
        return false;
      }
      return true;
    });
    const keptTables = new Set<string>(d.processes.flatMap((p) => PROCESS_TABLES[p.process as keyof typeof PROCESS_TABLES] ?? []));
    const droppedTables = new Set<string>([...dropped].flatMap((p) => PROCESS_TABLES[p as keyof typeof PROCESS_TABLES] ?? []).filter((t) => !keptTables.has(t)));
    if (d.tables.extra !== undefined) {
      const refTables = new Set<string>((ref.tables.extra ?? []).map((t) => t.name));
      d.tables.extra = d.tables.extra.filter((t) => {
        if (!refTables.has(t.name) && (P2_TABLE_NAMES.has(t.name) || p3Tables.has(t.name) || droppedTables.has(t.name))) {
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
      // the transparent path: the same P2-stage models without the vlan daemon (eth-switch is not VLAN-aware, D5)
      const classic = run(createP2Simulation({ seed, profile: 'P1', factories: { vlan: undefined } }), s);
      // the VLAN-aware path: the real catalog since the W4 flip
      const p2 = run(createSimulation({ seed }), s);

      // the real switch really runs the VLAN-aware path, and the transparent one really does not
      const sw = p2.snapshot.devices.find((d) => d.type === 'switch.nfc2960');
      if (s.name === 'two-pcs-and-switch') {
        expect(sw).toBeDefined();
        expect(sw!.capabilities).toContain('managed-switch');
        expect(sw!.processes.map((p) => p.process)).toContain('vlan');
        const transparent = classic.snapshot.devices.find((d) => d.type === 'switch.nfc2960');
        expect(transparent!.processes.map((p) => p.process)).not.toContain('vlan');
        expect(transparent!.tables.extra?.map((t) => t.name) ?? []).not.toContain('vlans');
      }

      // events: no tolerated additions, none missing, same order
      expect(p2.count).toBe(classic.count);
      const firstDiff = p2.lines.findIndex((l, i) => l !== classic.lines[i]);
      expect(firstDiff, `first diverging event at index ${firstDiff}: classic ${classic.lines[firstDiff]} vs p2 ${p2.lines[firstDiff]}`).toBe(-1);
      expect(p2.lines).toEqual(classic.lines);

      // snapshot: equal once the P2 and P3 vocabulary is removed, and only that vocabulary was removed: the P2 names as
      // before, the fifteen P3 daemons, the dormant udp/tcp of the managed switch (D22) and their sockets table, and
      // the stage-P3 tables (R51)
      const { stripped, removed } = stripLater(p2.snapshot, classic.snapshot);
      expect(canonicalJson(stripped)).toBe(canonicalJson(classic.snapshot));
      const p3Processes = `${P3_SILENCE_DAEMONS.join('|')}`;
      const p3Tables = [...p3TableNames()].join('|');
      // the shipped models really carry the P3 vocabulary (every host runs traffic and vty-client since the flip)
      expect(removed).toEqual(expect.arrayContaining(['pc1: process traffic', 'pc1: process vty-client']));
      const managedSwitch = (r: string): boolean => p2.snapshot.devices.find((d) => r.startsWith(`${d.id}: `))?.capabilities.includes('managed-switch') === true;
      for (const r of removed) {
        if (managedSwitch(r) && /: (process (udp|tcp)|table sockets)$/.test(r)) continue;
        expect(r, r).toMatch(new RegExp(`: (process (vlan|${p3Processes})|table (vlans|port-security|${p3Tables})|capability managed-switch|panel .+|role .+)$`));
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
    // the explicit vlan factory is the registered one (a no-op overlay since the flip)
    const a = run(createP2Simulation({ seed, profile: 'P1', factories: { vlan: createVlan } }), s);
    const b = run(createP2Simulation({ seed, profile: 'P1', factories: { vlan: createVlan } }), s);
    expect(a.lines).toEqual(b.lines);
    expect(canonicalJson(a.snapshot)).toBe(canonicalJson(b.snapshot));
  });
});
