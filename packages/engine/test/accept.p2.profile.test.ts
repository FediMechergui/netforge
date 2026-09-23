/**
 * P2 acceptance — the defaults profile (ARCHITECTURE-P2 D2, §2.9, §4.4, §5, §10.1 row `accept.p2.profile`).
 *
 *  • `createSimulation({seed})` has profile P1; every template exported after load deep-equals its build output with
 *    schema 1.1 (the unchanged P1 guarantee), and its exported startup texts are byte for byte the pre-P2 engine's
 *    (`goldens/p1-template-exports.json`, so a store rule cannot move them unseen); a 1.1 document carrying
 *    `profile: 'P2'` loads as P1 and the same document with schema 1.2 loads as P2.
 *  • In a P2 world (`test/p2.world.ts`, §0 rule 13) the replayed profile lines are in the running configurations:
 *    NF-C2960 `spanning-tree mode pvst` + `spanning-tree extend system-id`; NF-C3650 also `no ip routing`; NF-C9300
 *    `spanning-tree mode rapid-pvst`; NF-2911 neither; NF-AP-1832 `capwap enable` and Vlan1 `ip address dhcp`.
 *    Export writes `profile: 'P2'` and schema 1.2, and a reload gives an identical snapshot.
 *  • Completeness: every profile line is reversed on a model that has it (`ip routing`, `no spanning-tree mode` on
 *    NF-C9300, `no ip address` and `no capwap enable` on NF-AP-1832); export, reload and a lab clone built the
 *    grader's way give the same running configuration, the same forwarding (a ping across the MLS) and the same
 *    daemon state; `no spanning-tree extend system-id` is refused with its message and stores nothing. (`no capwap
 *    enable` is a skipped case, deferred to W5 by §9.2b, until the §7 W5 cli item gives `capwap enable` its grammar.)
 *  • "Use current defaults" on a P1 world with two switches and a routing NF-C3650 (the worker's pure
 *    `withCurrentDefaults` step, replayed here on the engine API: export, `ip routing` written where the P2 profile
 *    would replay `no ip routing`, `profile: 'P2'` + `schemaIdFor`, reload) gives profile P2, schema 1.2, `stp-bridge`
 *    rows after boot, and the NF-C3650 still routes.
 *
 * Time-free comparison of daemon state across the live world, the reloaded world and the clone: the live world typed
 * its reversals at run time while the other two booted with them, so timestamps (`stateSince`, `updatedAt`) differ by
 * construction. The comparison therefore takes the state the reversals govern — the ipv4 `forwarding` flag, the
 * `stp-bridge` mode / root of every instance, the SVI address view — from all three, and the FULL `stateSnapshots()`
 * between the reloaded world and the clone, which share a construction.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseConfigText } from '../src/cli/config-ast.js';
import { CLI_MESSAGES } from '../src/contracts/cli.js';
import type { DeviceModel } from '../src/contracts/device.js';
import type { Simulation } from '../src/contracts/simulation.js';
import { vlanKey, type StpBridgeRow } from '../src/contracts/tables.js';
import { SEC } from '../src/contracts/time.js';
import { TOPOLOGY_SCHEMA_ID_1_1, TOPOLOGY_SCHEMA_ID_1_2, schemaIdFor, type Topology } from '../src/contracts/topology.js';
import { LAB_CLONE_BOOT_EVENTS } from '../src/sim/lab-checks.js';
import { SCENARIO_SEED, TEMPLATES, twoPcsAndSwitch } from '../src/sim/scenarios.js';
import { configText, device, link, section, topology } from '../src/sim/scenarios/kit.js';
import { pcConfig } from '../src/sim/scenarios/templates.js';
import { createSimulation } from '../src/sim/simulation.js';
import { createP2Simulation } from './p2.world.js';
import { ping } from './sim.harness.js';

const SWITCH = 'switch.nfc2960';
const MLS = 'mlswitch.nfc3650-24';
const C9300 = 'mlswitch.nfc9300-48';
const ROUTER = 'router.nf2911';
const AP = 'ap.nfap-lw';
const PC = 'pc.nfpc';
const MASK = '255.255.255.0';
const SEED = 7;

const running = (sim: Simulation, dev: string): string => sim.device(dev)!.running.render();
const has = (text: string, line: string): boolean => text.split('\n').some((l) => l.trim() === line);
const forwarding = (sim: Simulation, dev: string): unknown => sim.device(dev)!.processes.get('ipv4')!.stateSnapshot().state['forwarding'];
const bridges = (sim: Simulation, dev: string): { vlan: number; mode: string; isRoot: boolean; rootId: string }[] =>
  (sim.device(dev)!.tables.get<StpBridgeRow>('stp-bridge')?.rows() ?? []).map((r) => ({ vlan: r.vlan, mode: r.mode, isRoot: r.isRoot, rootId: r.rootId })).sort((a, b) => a.vlan - b.vlan);
const states = (sim: Simulation, dev: string): string => JSON.stringify(sim.device(dev)!.stateSnapshots());

/** A P2 document (schema 1.2) as every writer must write it: `profile` and `schemaIdFor` in one step. */
function p2Doc(devices: Topology['devices'], links: Topology['links']): Topology {
  const t: Topology = { ...topology(SEED, devices, links, [], ''), profile: 'P2' };
  return { ...t, schema: schemaIdFor(t) };
}

/**
 * A built topology as the P1 engine has always exported it (sim/simulation.ts `exportTopology`, unchanged by P2):
 * every device's startup text rendered by the configuration store (the NFOS header, canonical spacing), for a model
 * with module slots its (empty) `modules` list, and every link's `length_m` (the 3 m default when the build left
 * it out). Nothing else is touched, so the comparison stays a deep equality of the document's content.
 */
function asP1Export(built: Topology, sim: Simulation): Topology {
  return {
    ...built,
    devices: built.devices.map((d) => {
      const out = { ...d };
      if (d.config !== undefined) out.config = parseConfigText(d.config).render();
      if ((sim.catalog.get(d.type)?.slots ?? []).length > 0 && d.modules === undefined) out.modules = [];
      return out;
    }),
    links: built.links.map((l) => (l.length_m === undefined ? { ...l, length_m: 3 } : l)),
  };
}

/**
 * `test/goldens/p1-template-exports.json`: the startup text every template device exports after a load, per template
 * and device id, recorded from the pre-P2 engine (commit 7e623b9) and byte-identical to what this engine exports. A
 * renderer or config-rule change that moves a P1 export fails here; the file is never regenerated to make it pass.
 */
function p1TemplateExports(): Record<string, Record<string, string>> {
  return JSON.parse(readFileSync(new URL('./goldens/p1-template-exports.json', import.meta.url), 'utf8')) as Record<string, Record<string, string>>;
}

/** A fresh P2-stage world of `seed` (profile P1 until a document says otherwise). */
const fresh = (profile: 'P1' | 'P2' = 'P2'): Simulation => createP2Simulation({ seed: SEED, profile });

describe('accept P2 profile: the P1 guarantee and the loader', () => {
  it('createSimulation({seed}) is a P1 world', () => {
    expect(createSimulation({ seed: 1 }).profile).toBe('P1');
    expect(createP2Simulation({ seed: 1, profile: 'P1' }).profile).toBe('P1');
    expect(createP2Simulation({ seed: 1 }).profile).toBe('P2');
  });

  it('every template exported after load deep-equals its build output (as P1 has always exported it), schema 1.1', () => {
    expect(TEMPLATES.length).toBeGreaterThan(0);
    const golden = p1TemplateExports();
    expect(Object.keys(golden)).toEqual(TEMPLATES.map((sc) => sc.name));
    for (const sc of TEMPLATES) {
      const built = sc.build();
      expect(built.schema, sc.name).toBe(TOPOLOGY_SCHEMA_ID_1_1);
      expect('profile' in built, sc.name).toBe(false);
      const sim = createSimulation({ seed: sc.seed ?? SCENARIO_SEED });
      sim.loadTopology(built);
      expect(sim.profile, sc.name).toBe('P1');
      const out = sim.exportTopology();
      expect(out, sc.name).toEqual(asP1Export(built, sim));
      // renderer-independent: the exported startup texts are the P1 engine's bytes, not a re-render by the store under
      // test (`asP1Export` renders its expectation with the same rules, so it alone cannot see a rule change)
      const texts: Record<string, string> = {};
      for (const d of out.devices) if (d.config !== undefined) texts[d.id] = d.config;
      expect(texts, sc.name).toEqual(golden[sc.name]);
      expect(out.schema, sc.name).toBe(TOPOLOGY_SCHEMA_ID_1_1);
      expect('profile' in out, sc.name).toBe(false);
      // and the P1 export is a fixed point: loading it again exports the same bytes
      const again = createSimulation({ seed: sc.seed ?? SCENARIO_SEED });
      again.loadTopology(out);
      expect(again.profile, sc.name).toBe('P1');
      expect(again.exportTopology(), sc.name).toEqual(out);
    }
  });

  it('a 1.1 document carrying profile P2 loads as P1; the same document with schema 1.2 loads as P2', () => {
    const doc: Topology = { ...twoPcsAndSwitch(), schema: TOPOLOGY_SCHEMA_ID_1_1, profile: 'P2' };
    const p1 = createSimulation({ seed: 1 });
    p1.loadTopology(doc);
    expect(p1.profile).toBe('P1');
    expect(p1.exportTopology().schema).toBe(TOPOLOGY_SCHEMA_ID_1_1);
    expect('profile' in p1.exportTopology()).toBe(false);
    const p2 = createSimulation({ seed: 1 });
    p2.loadTopology({ ...doc, schema: TOPOLOGY_SCHEMA_ID_1_2 });
    expect(p2.profile).toBe('P2');
    for (const d of p2.devices()) expect(d.profile).toBe('P2');
    expect(p2.exportTopology().profile).toBe('P2');
    expect(p2.exportTopology().schema).toBe(TOPOLOGY_SCHEMA_ID_1_2);
  });
});

/** The five models of the §10.1 row in one P2 document (each with an up port so that spanning tree has an instance). */
function fiveModelsDoc(): Topology {
  return p2Doc(
    [
      device('sw', SWITCH, 'SW', 0, 0, configText([['hostname SW']])),
      device('mls', MLS, 'MLS', 0, 0, configText([['hostname MLS']])),
      device('c9300', C9300, 'C9300', 0, 0, configText([['hostname C9300']])),
      device('r1', ROUTER, 'R1', 0, 0, configText([['hostname R1']])),
      device('ap', AP, 'AP', 0, 0, configText([['hostname AP']])),
      device('pc1', PC, 'PC1', 0, 0, pcConfig('PC1', '10.0.0.1', MASK)),
      device('pc2', PC, 'PC2', 0, 0, pcConfig('PC2', '10.0.0.2', MASK)),
    ],
    [
      link('l1', 'sw', 'FastEthernet0/1', 'mls', 'GigabitEthernet1/0/1'),
      link('l2', 'sw', 'FastEthernet0/2', 'c9300', 'GigabitEthernet1/0/1'),
      link('l3', 'sw', 'FastEthernet0/3', 'ap', 'GigabitEthernet0'),
      link('l4', 'pc1', 'GigabitEthernet0', 'sw', 'FastEthernet0/4'),
      link('l5', 'pc2', 'GigabitEthernet0', 'mls', 'GigabitEthernet1/0/2'),
    ],
  );
}
/** Every model of the document has booted (the router takes 45 s). */
const ALL_BOOTED = 50 * SEC;

describe('accept P2 profile: the replayed lines of a P2 world, export and reload', () => {
  it('NF-C2960, NF-C3650 and NF-C9300 carry their spanning-tree and routing defaults; NF-2911 carries neither', () => {
    const sim = fresh();
    sim.loadTopology(fiveModelsDoc());
    sim.runUntil(ALL_BOOTED);
    const sw = running(sim, 'sw');
    expect(has(sw, 'spanning-tree mode pvst')).toBe(true);
    expect(has(sw, 'spanning-tree extend system-id')).toBe(true);
    expect(has(sw, 'no ip routing')).toBe(false);
    const mls = running(sim, 'mls');
    expect(has(mls, 'spanning-tree mode pvst')).toBe(true);
    expect(has(mls, 'spanning-tree extend system-id')).toBe(true);
    expect(has(mls, 'no ip routing')).toBe(true);
    expect(forwarding(sim, 'mls')).toBe(false);
    const c9300 = running(sim, 'c9300');
    expect(has(c9300, 'spanning-tree mode rapid-pvst')).toBe(true);
    expect(has(c9300, 'spanning-tree extend system-id')).toBe(true);
    expect(has(c9300, 'no ip routing')).toBe(true);
    const r1 = running(sim, 'r1');
    expect(r1.includes('spanning-tree')).toBe(false);
    expect(has(r1, 'no ip routing')).toBe(false);
    expect(forwarding(sim, 'r1')).toBe(true);
    // the profile is the P2 default: spanning tree runs on the three switches
    for (const dev of ['sw', 'mls', 'c9300']) expect(bridges(sim, dev).length, dev).toBeGreaterThan(0);
    expect(bridges(sim, 'c9300')[0]!.mode).toBe('rapid-pvst');
    expect(bridges(sim, 'sw')[0]!.mode).toBe('pvst');
  });

  it('NF-AP-1832 carries `capwap enable` and Vlan1 `ip address dhcp`', () => {
    const sim = fresh();
    sim.loadTopology(fiveModelsDoc());
    sim.runUntil(ALL_BOOTED);
    const ap = running(sim, 'ap');
    expect(has(ap, 'capwap enable')).toBe(true);
    expect(ap).toMatch(/\ninterface Vlan1\n(?: .*\n)*? ip address dhcp\n/);
  });

  it('export writes profile P2 and schema 1.2; a reload gives an identical snapshot and the same export', () => {
    const a = fresh();
    a.loadTopology(fiveModelsDoc());
    a.runUntil(ALL_BOOTED);
    const out = a.exportTopology();
    expect(out.profile).toBe('P2');
    expect(out.schema).toBe(TOPOLOGY_SCHEMA_ID_1_2);
    expect(Object.keys(out)[0]).toBe('schema');
    for (const d of out.devices) expect(d.runningConfig, d.id).toBeDefined();
    const b = fresh('P1');
    b.loadTopology(out);
    expect(b.profile).toBe('P2');
    b.runUntil(ALL_BOOTED);
    expect(JSON.stringify(b.snapshot())).toBe(JSON.stringify(a.snapshot()));
    expect(b.exportTopology()).toEqual(out);
    for (const d of out.devices) expect(running(b, d.id), d.id).toBe(running(a, d.id));
  });
});

/** The completeness world: PC1 (VLAN 10) and PC2 (VLAN 20) behind an NF-C3650 with SVIs; an NF-C9300 with PC3. */
function reversalDoc(): Topology {
  const access = (port: string, vlan: number): string[] => section(`interface ${port}`, ['switchport mode access', `switchport access vlan ${vlan}`]);
  return p2Doc(
    [
      device('mls', MLS, 'MLS', 0, 0, configText([
        ['hostname MLS'], ['vlan 10'], ['vlan 20'],
        access('GigabitEthernet1/0/1', 10), access('GigabitEthernet1/0/2', 20),
        section('interface Vlan10', ['ip address 192.168.10.1 255.255.255.0', 'no shutdown']),
        section('interface Vlan20', ['ip address 192.168.20.1 255.255.255.0', 'no shutdown']),
      ])),
      device('c9300', C9300, 'C9300', 0, 0, configText([['hostname C9300']])),
      device('pc1', PC, 'PC1', 0, 0, pcConfig('PC1', '192.168.10.10', MASK, '192.168.10.1')),
      device('pc2', PC, 'PC2', 0, 0, pcConfig('PC2', '192.168.20.10', MASK, '192.168.20.1')),
      device('pc3', PC, 'PC3', 0, 0, pcConfig('PC3', '10.0.0.3', MASK)),
    ],
    [
      link('l_pc1', 'pc1', 'GigabitEthernet0', 'mls', 'GigabitEthernet1/0/1'),
      link('l_pc2', 'pc2', 'GigabitEthernet0', 'mls', 'GigabitEthernet1/0/2'),
      link('l_pc3', 'pc3', 'GigabitEthernet0', 'c9300', 'GigabitEthernet1/0/1'),
    ],
  );
}
/** The multilayer switches boot at 40 s and their access ports forward at 70 s; the reversals are typed at T1. */
const T1 = 110 * SEC;
const T2 = 130 * SEC;

/** Live world, reloaded world and lab clone of one export, all at `T2`. */
function threeWorlds(live: Simulation): { reloaded: Simulation; clone: Simulation; out: Topology } {
  const out = live.exportTopology();
  expect(out.profile).toBe('P2');
  expect(out.schema).toBe(TOPOLOGY_SCHEMA_ID_1_2);
  const reloaded = fresh('P1');
  reloaded.loadTopology(out);
  expect(reloaded.profile).toBe('P2');
  reloaded.runUntil(T2);
  // the grader's technique (lab-checks.ts createCloneHost): a fresh world, the export loaded, run to idle
  const clone = fresh('P1');
  clone.loadTopology(out);
  const boot = clone.runToIdle(LAB_CLONE_BOOT_EVENTS);
  expect(boot.stopped).toBeUndefined();
  clone.runUntil(T2);
  return { reloaded, clone, out };
}

describe('accept P2 profile: completeness (D2) — every profile line reversed, exported, reloaded and cloned', () => {
  it('`ip routing` on the NF-C3650 and `no spanning-tree mode` on the NF-C9300 hold in the live world, the reload and the clone', () => {
    const live = fresh();
    live.loadTopology(reversalDoc());
    live.runUntil(T1);
    expect(has(running(live, 'mls'), 'no ip routing')).toBe(true);
    expect(ping(live, 'pc1', '192.168.20.10').text).not.toContain('received 5');
    expect(live.configure('mls', ['ip routing']).ok).toBe(true);
    expect(live.configure('c9300', ['no spanning-tree mode']).ok).toBe(true);
    live.runUntil(T2);
    const { reloaded, clone } = threeWorlds(live);
    const worlds: [string, Simulation][] = [['live', live], ['reloaded', reloaded], ['clone', clone]];
    for (const [name, sim] of worlds) {
      const mls = running(sim, 'mls');
      expect(has(mls, 'ip routing'), name).toBe(true);
      expect(has(mls, 'no ip routing'), name).toBe(false);
      expect(forwarding(sim, 'mls'), name).toBe(true);
      // `no spanning-tree mode` in a P2 world restores the MODEL default (rapid-pvst on the NF-C9300), not "off"
      const c9300 = running(sim, 'c9300');
      expect(has(c9300, 'spanning-tree mode rapid-pvst'), name).toBe(true);
      expect(has(c9300, 'no spanning-tree mode'), name).toBe(false);
      expect(bridges(sim, 'c9300').map((b) => b.mode), name).toEqual(['rapid-pvst']);
      expect(bridges(sim, 'c9300')[0]!.isRoot, name).toBe(true);
      expect(ping(sim, 'pc1', '192.168.20.10').text, name).toContain('Sent 5, received 5, lost 0');
    }
    for (const dev of ['mls', 'c9300']) {
      expect(running(reloaded, dev), dev).toBe(running(live, dev));
      expect(running(clone, dev), dev).toBe(running(live, dev));
      expect(bridges(reloaded, dev), dev).toEqual(bridges(live, dev));
      expect(bridges(clone, dev), dev).toEqual(bridges(live, dev));
    }
    // the reloaded world and the clone share a construction: their daemon states are byte-identical
    for (const d of reloaded.devices()) expect(states(clone, d.id), d.id).toBe(states(reloaded, d.id));
  });

  /** An NF-C2960 and an NF-AP-1832 (the lightweight AP of the W6 test-only delta) on one cable. */
  const apDoc = (): Topology => p2Doc(
    [device('sw', SWITCH, 'SW', 0, 0, configText([['hostname SW']])), device('ap', AP, 'AP', 0, 0, configText([['hostname AP']]))],
    [link('l1', 'sw', 'FastEthernet0/1', 'ap', 'GigabitEthernet0')],
  );
  /** The AP daemons whose state the Vlan1 address line governs (time-free: no counters, no timestamps). */
  const apGoverned = (sim: Simulation): string => JSON.stringify({
    vlan1: sim.device('ap')!.portView('Vlan1')!.l3 ?? null,
    ipv4: sim.device('ap')!.processes.get('ipv4')!.stateSnapshot().state['interfaces'],
    dhcp: sim.device('ap')!.processes.get('dhcp-client')!.stateSnapshot(),
  });

  it('`no ip address` on the NF-AP-1832 Vlan1 holds in the live world, the reload and the clone', () => {
    const live = fresh();
    live.loadTopology(apDoc());
    live.runUntil(T1);
    expect(has(running(live, 'ap'), 'capwap enable')).toBe(true);
    expect(running(live, 'ap')).toMatch(/\ninterface Vlan1\n ip address dhcp\n/);
    expect(live.configure('ap', ['interface Vlan1', 'no ip address']).ok).toBe(true);
    // completeness rule 1: the reversal of a default line is stored explicitly in its slot
    expect(running(live, 'ap')).toMatch(/\ninterface Vlan1\n no ip address\n/);
    live.runUntil(T2);
    const { reloaded, clone } = threeWorlds(live);
    const worlds: [string, Simulation][] = [['live', live], ['reloaded', reloaded], ['clone', clone]];
    for (const [name, sim] of worlds) {
      const ap = running(sim, 'ap');
      expect(ap, name).toMatch(/\ninterface Vlan1\n no ip address\n/);
      expect(has(ap, 'ip address dhcp'), name).toBe(false);
      expect(has(ap, 'capwap enable'), name).toBe(true);
      expect(sim.device('ap')!.portView('Vlan1')!.l3?.ipv4, name).toBeUndefined();
      expect(apGoverned(sim), name).toBe(apGoverned(live));
    }
    expect(running(reloaded, 'ap')).toBe(running(live, 'ap'));
    expect(running(clone, 'ap')).toBe(running(live, 'ap'));
    expect(states(clone, 'ap')).toBe(states(reloaded, 'ap'));
  });

  it.skip('`no capwap enable` on the NF-AP-1832 holds in the live world, the reload and the clone — deferred to W5 by §9.2b (row `accept.p2.profile`): a wave dependency, not an engine defect — `capwap enable` has no CLI grammar before W5 (in W4 only the config-store rule replays the P2 profile line at boot, so configure(ap, ["no capwap enable"]) is refused with "% Unrecognized input at the marked position."); un-skipped by §7 W5 cli (`cli/grammar/wlc.ts`) in the change that lands it', () => {
    const live = fresh();
    live.loadTopology(apDoc());
    live.runUntil(T1);
    expect(has(running(live, 'ap'), 'capwap enable')).toBe(true);
    expect(live.configure('ap', ['no capwap enable']).ok).toBe(true);
    live.runUntil(T2);
    const { reloaded, clone } = threeWorlds(live);
    const worlds: [string, Simulation][] = [['live', live], ['reloaded', reloaded], ['clone', clone]];
    for (const [name, sim] of worlds) {
      const ap = running(sim, 'ap');
      // completeness rule 1: `no capwap enable` is stored explicitly in the default slot
      expect(has(ap, 'no capwap enable'), name).toBe(true);
      expect(has(ap, 'capwap enable'), name).toBe(false);
      expect(sim.device('ap')!.tables.get('capwap')?.size ?? 0, name).toBe(0);
    }
    expect(running(reloaded, 'ap')).toBe(running(live, 'ap'));
    expect(running(clone, 'ap')).toBe(running(live, 'ap'));
    expect(states(clone, 'ap')).toBe(states(reloaded, 'ap'));
  });

  it('`no spanning-tree extend system-id` is refused with its message and stores nothing', () => {
    const sim = fresh();
    sim.loadTopology(fiveModelsDoc());
    sim.runUntil(ALL_BOOTED);
    for (const dev of ['sw', 'mls', 'c9300']) {
      const before = running(sim, dev);
      const r = sim.configure(dev, ['no spanning-tree extend system-id']);
      expect(r.ok, dev).toBe(false);
      expect(r.lines[0]!.error?.message, dev).toBe(CLI_MESSAGES.extendSystemIdFixed);
      expect(r.applied, dev).toBe(0);
      expect(running(sim, dev), dev).toBe(before);
      expect(has(running(sim, dev), 'spanning-tree extend system-id'), dev).toBe(true);
      expect(has(running(sim, dev), 'no spanning-tree extend system-id'), dev).toBe(false);
      expect(sim.exportTopology().devices.find((d) => d.id === dev)!.runningConfig!.includes('no spanning-tree extend')).toBe(false);
    }
  });
});

/** The worker's pure "Use current defaults" step (apps/web/src/bridge/worker/index.ts `withCurrentDefaults`), replayed on the engine API. */
function withCurrentDefaults(t: Topology, modelOf: (type: string) => Pick<DeviceModel, 'profileConfig'> | undefined): Topology {
  const decides = (text: string | undefined): boolean => (text ?? '').split('\n').some((l) => l.trim() === 'ip routing' || l.trim() === 'no ip routing');
  const devices = t.devices.map((d) => {
    const replayed = modelOf(d.type)?.profileConfig?.P2 ?? [];
    if (!replayed.some((line) => line.trim() === 'no ip routing')) return d;
    const current = d.runningConfig ?? d.config;
    if (decides(current)) return d;
    const base = current === undefined || current === '' ? '' : current.endsWith('\n') ? current : `${current}\n`;
    return { ...d, runningConfig: `${base}ip routing\n` };
  });
  const next: Topology = { ...t, devices, profile: 'P2' };
  return { ...next, schema: schemaIdFor(next) };
}

describe('accept P2 profile: "Use current defaults" on a classic world', () => {
  it('two switches and a routing NF-C3650: profile P2, schema 1.2, stp-bridge rows after boot, the NF-C3650 still routes', () => {
    // a P1 document: PC1 — SW1 — MLS1 (two routed ports) — SW2 — PC2
    const doc: Topology = topology(SEED, [
      device('sw1', SWITCH, 'SW1', 0, 0, configText([['hostname SW1']])),
      device('sw2', SWITCH, 'SW2', 0, 0, configText([['hostname SW2']])),
      device('mls1', MLS, 'MLS1', 0, 0, configText([
        ['hostname MLS1'],
        section('interface GigabitEthernet1/0/1', ['no switchport', 'ip address 10.1.0.1 255.255.255.0', 'no shutdown']),
        section('interface GigabitEthernet1/0/2', ['no switchport', 'ip address 10.2.0.1 255.255.255.0', 'no shutdown']),
      ])),
      device('pc1', PC, 'PC1', 0, 0, pcConfig('PC1', '10.1.0.10', MASK, '10.1.0.1')),
      device('pc2', PC, 'PC2', 0, 0, pcConfig('PC2', '10.2.0.10', MASK, '10.2.0.1')),
    ], [
      link('l_pc1', 'pc1', 'GigabitEthernet0', 'sw1', 'FastEthernet0/1'),
      link('l_sw1', 'sw1', 'GigabitEthernet0/1', 'mls1', 'GigabitEthernet1/0/1'),
      link('l_sw2', 'sw2', 'GigabitEthernet0/1', 'mls1', 'GigabitEthernet1/0/2'),
      link('l_pc2', 'pc2', 'GigabitEthernet0', 'sw2', 'FastEthernet0/1'),
    ], [], '');
    expect(doc.schema).toBe(TOPOLOGY_SCHEMA_ID_1_1);
    const sim = fresh('P1');
    sim.loadTopology(doc);
    expect(sim.profile).toBe('P1');
    sim.runUntil(60 * SEC);
    expect(has(running(sim, 'mls1'), 'ip routing')).toBe(false);
    expect(forwarding(sim, 'mls1')).toBe(true);
    expect(ping(sim, 'pc1', '10.2.0.10').text).toContain('Sent 5, received 5, lost 0');
    for (const dev of ['sw1', 'sw2', 'mls1']) expect(bridges(sim, dev), dev).toEqual([]);
    // File → "Use current defaults": export, the pure step, reload into the same world
    const classic = sim.exportTopology();
    expect(classic.schema).toBe(TOPOLOGY_SCHEMA_ID_1_1);
    const current = withCurrentDefaults(classic, (type) => sim.catalog.get(type));
    expect(current.profile).toBe('P2');
    expect(current.schema).toBe(TOPOLOGY_SCHEMA_ID_1_2);
    expect(current.devices.find((d) => d.id === 'mls1')!.runningConfig!.endsWith('ip routing\n')).toBe(true);
    expect(current.devices.filter((d) => d.id !== 'mls1').map((d) => d.runningConfig)).toEqual(classic.devices.filter((d) => d.id !== 'mls1').map((d) => d.runningConfig));
    sim.loadTopology(current);
    expect(sim.profile).toBe('P2');
    expect(sim.exportTopology().schema).toBe(TOPOLOGY_SCHEMA_ID_1_2);
    // after boot: spanning tree runs on the switches, and the multilayer switch keeps routing
    sim.runUntil(100 * SEC);
    for (const dev of ['sw1', 'sw2']) {
      expect(bridges(sim, dev).length, dev).toBeGreaterThan(0);
      expect(has(running(sim, dev), 'spanning-tree mode pvst'), dev).toBe(true);
    }
    const mls = running(sim, 'mls1');
    expect(has(mls, 'ip routing')).toBe(true);
    expect(has(mls, 'no ip routing')).toBe(false);
    expect(forwarding(sim, 'mls1')).toBe(true);
    expect(ping(sim, 'pc1', '10.2.0.10').text).toContain('Sent 5, received 5, lost 0');
  });
});
