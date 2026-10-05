/**
 * P3 acceptance — the 'P3' defaults profile (ARCHITECTURE-P3 D2, §2.9, §4.3, §4.4, §5 (`cdp run` / `cdp enable` are
 * `bothForms`), §7 W4 step 1, §9.2 item 16, §10.1 row `accept.p3.profile`).
 *
 * Worlds are built by `test/p3-flip.world.ts` (`staged.world` at stage P3 with the approved P3 daemons until the W4
 * flip, the real catalog after it).
 *
 *  • `createSimulation({seed, profile: 'P3'})` has profile P3. A P3 world exports `profile: 'P3'` and schema 1.3 and
 *    reloads to an identical snapshot (and the same export); every CCNA 2 lab loaded on the P3 catalog still exports
 *    schema 1.2 / `profile: 'P2'` byte for byte as `goldens/p2-lab-exports.json` (recorded from the P2 engine).
 *  • CDP runs on every `cdpDefault` model (NF-2911, NF-C2960, NF-C3650-24, NF-WLC-9800) in a P3 world and on none in
 *    the same world in profile P2; a home router (NF-HOMEROUTER) and NF-AP-1832 never run it.
 *  • Completeness: `no cdp run` and `no cdp enable` typed in a P3 world, and `cdp run` typed in a P2 world, survive
 *    export, reload and a lab clone (the grader's construction: the export loaded with the live seed and catalog, run to
 *    idle) — the running configuration, the CDP rows (every column but the times) and the CDP frames of one 60 s period
 *    are identical in all three; the reloaded world and the clone, which share a construction, hold byte-identical
 *    rows.
 *  • Proxy ARP is still on for a routed interface of a P3 router (the `arp.ts:178` trap: "P2 or later"), and off in a
 *    P1 world on the same catalog.
 *  • The pure ladder `sim/defaults-upgrade.ts` taken to P3 on a P2 world gives profile P3 and schema 1.3 and rewrites
 *    no configuration line; loaded, the world has CDP rows after boot. (`useCurrentDefaults` reaches P3 only after the
 *    W7 flip, §10.2; `LATEST_DEFAULTS_PROFILE` is still 'P2'.)
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { LATEST_DEFAULTS_PROFILE, type DefaultsProfile } from '../src/contracts/catalog.js';
import type { DeviceId } from '../src/contracts/ids.js';
import type { Simulation } from '../src/contracts/simulation.js';
import type { CdpNeighbourRow } from '../src/contracts/tables.js';
import { SEC, type SimTime } from '../src/contracts/time.js';
import { TOPOLOGY_SCHEMA_ID_1_2, TOPOLOGY_SCHEMA_ID_1_3, type Topology } from '../src/contracts/topology.js';
import type { TraceEvent } from '../src/contracts/trace.js';
import { upgradeDefaults } from '../src/sim/defaults-upgrade.js';
import { LAB_CLONE_BOOT_EVENTS } from '../src/sim/lab-checks.js';
import { CCNA2_LABS } from '../src/sim/scenarios.js';
import { configText, device, link, section, topology } from '../src/sim/scenarios/kit.js';
import { pcConfig } from '../src/sim/scenarios/templates.js';
import { createSimulation } from '../src/sim/simulation.js';
import { createP3Simulation, loadScenarioP3, p3WorldSource } from './p3-flip.world.js';
import { ofKind, ping } from './sim.harness.js';

const ROUTER = 'router.nf2911';
const SWITCH = 'switch.nfc2960';
const MLS = 'mlswitch.nfc3650-24';
const WLC = 'wlc.nfwlc9800';
const HOME = 'wrouter.nfhome';
const AP = 'ap.nfap-lw';
const PC = 'pc.nfpc';
const MASK = '255.255.255.0';
const SEED = 9;

/** The `cdpDefault` models of the row, and the two models that never run CDP. */
const CDP_DEFAULT_TYPES: readonly string[] = [ROUTER, SWITCH, MLS, WLC];
const NEVER_CDP_TYPES: readonly string[] = [HOME, AP];

const running = (sim: Simulation, dev: string): string => sim.device(dev)!.running.render();
const lines = (text: string): string[] => text.split('\n');

/** A document of `profile` (P1: schema 1.1 without a profile; P2: 1.2; P3: 1.3) — kit `topology`, as every writer writes it. */
function doc(profile: DefaultsProfile, devices: Topology['devices'], links: Topology['links']): Topology {
  return topology(SEED, devices, links, [], '', { profile });
}

/** A fresh P3-catalog world (profile P1 until a document says otherwise, so the loader alone sets it). */
const fresh = (): Simulation => createP3Simulation({ seed: SEED, profile: 'P1' });

/**
 * Every model of the row on one NF-C2960: NF-2911 (Gi0/0 up), NF-C3650-24, NF-WLC-9800, NF-HOMEROUTER (LAN port),
 * NF-AP-1832 and a PC.
 */
function modelsDoc(profile: DefaultsProfile): Topology {
  return doc(
    profile,
    [
      device('sw', SWITCH, 'SW', 300, 200, configText([['hostname SW']])),
      device('r1', ROUTER, 'R1', 300, 50, configText([['hostname R1'], section('interface GigabitEthernet0/0', ['no shutdown'])])),
      device('mls', MLS, 'MLS', 500, 50, configText([['hostname MLS']])),
      device('wlc', WLC, 'WLC', 500, 200, configText([['hostname WLC']])),
      device('home', HOME, 'HOME', 100, 50),
      device('ap', AP, 'AP', 100, 200, configText([['hostname AP']])),
      device('pc1', PC, 'PC1', 300, 350, pcConfig('PC1', '10.0.0.1', MASK)),
    ],
    [
      link('l_r1', 'r1', 'GigabitEthernet0/0', 'sw', 'GigabitEthernet0/1'),
      link('l_mls', 'mls', 'GigabitEthernet1/0/1', 'sw', 'GigabitEthernet0/2'),
      link('l_wlc', 'wlc', 'GigabitEthernet0/1', 'sw', 'FastEthernet0/1'),
      link('l_home', 'home', 'GigabitEthernet1', 'sw', 'FastEthernet0/2'),
      link('l_ap', 'ap', 'GigabitEthernet0', 'sw', 'FastEthernet0/3'),
      link('l_pc1', 'pc1', 'GigabitEthernet0', 'sw', 'FastEthernet0/4'),
    ],
  );
}
/** Every model of the documents here has booted and exchanged its first CDP frames by then (the router boots at 45 s). */
const ALL_BOOTED: SimTime = 70 * SEC;

/** Devices that created a CDP frame in `evs`. */
const cdpSenders = (evs: readonly TraceEvent[]): string[] =>
  [...new Set(ofKind(evs, 'pduCreated').filter((e) => e.process === 'cdp' && e.pdu.tag === 'cdp').map((e) => e.device))].sort();

/** The cdp daemon's StateView `running` flag (undefined when the device runs no cdp daemon). */
const cdpRunningFlag = (sim: Simulation, dev: string): unknown => sim.device(dev)!.processes.get('cdp')?.stateSnapshot().state['running'];

describe('accept P3 profile: the profile and the P3 document', () => {
  it('createSimulation({seed, profile: P3}) is a P3 world; createSimulation({seed}) stays P1', () => {
    expect(createSimulation({ seed: 1, profile: 'P3' }).profile).toBe('P3');
    expect(createSimulation({ seed: 1 }).profile).toBe('P1');
    expect(createP3Simulation({ seed: 1 }).profile).toBe('P3');
    // the course and "Use current defaults" still default to P2 until the W7 flip
    expect(LATEST_DEFAULTS_PROFILE).toBe('P2');
  });

  it(`a P3 world exports profile P3 and schema 1.3, and reloads to an identical snapshot (source: ${p3WorldSource()})`, () => {
    const a = fresh();
    a.loadTopology(modelsDoc('P3'));
    expect(a.profile).toBe('P3');
    for (const d of a.devices()) expect(d.profile, d.id).toBe('P3');
    a.runUntil(ALL_BOOTED);
    const out = a.exportTopology();
    expect(out.profile).toBe('P3');
    expect(out.schema).toBe(TOPOLOGY_SCHEMA_ID_1_3);
    expect(Object.keys(out)[0]).toBe('schema');
    const b = fresh();
    b.loadTopology(out);
    expect(b.profile).toBe('P3');
    b.runUntil(ALL_BOOTED);
    expect(JSON.stringify(b.snapshot())).toBe(JSON.stringify(a.snapshot()));
    expect(b.exportTopology()).toEqual(out);
    for (const d of out.devices) expect(running(b, d.id), d.id).toBe(running(a, d.id));
    // the running configuration of a default P3 world shows no CDP line (D2)
    for (const d of out.devices) expect(lines(running(a, d.id)).filter((l) => l.trim().includes('cdp ')), d.id).toEqual([]);
  });

  it('every CCNA 2 lab loaded on the P3 catalog still exports schema 1.2 byte for byte as the P2 golden', () => {
    const golden = (JSON.parse(readFileSync(new URL('./goldens/p2-lab-exports.json', import.meta.url), 'utf8')) as { labs: Record<string, Topology> }).labs;
    expect(Object.keys(golden)).toEqual(CCNA2_LABS.map((l) => l.name));
    for (const lab of CCNA2_LABS) {
      const sim = loadScenarioP3(lab);
      expect(sim.profile, lab.name).toBe('P2');
      const out = sim.exportTopology();
      expect(out.schema, lab.name).toBe(TOPOLOGY_SCHEMA_ID_1_2);
      expect(out.profile, lab.name).toBe('P2');
      expect(JSON.stringify(out), lab.name).toBe(JSON.stringify(golden[lab.name]));
    }
  });
});

describe('accept P3 profile: who runs CDP', () => {
  it('the catalog marks exactly NF-2911, NF-C2960, NF-C3650-24 and NF-WLC-9800 cdpDefault, never the home router or NF-AP-1832', () => {
    const sim = fresh();
    for (const t of CDP_DEFAULT_TYPES) expect(sim.catalog.get(t)?.cdpDefault, t).toBe(true);
    for (const t of NEVER_CDP_TYPES) expect(sim.catalog.get(t)?.cdpDefault, t).toBeUndefined();
    // the lightweight AP has no cdp daemon at all; the home router derives one through `routing` but never runs it
    expect(sim.catalog.get(AP)!.processes.includes('cdp')).toBe(false);
  });

  it('in a P3 world every cdpDefault model sends CDP and the home router and the AP never do; in P2 nobody does', () => {
    for (const profile of ['P3', 'P2'] as const) {
      const sim = fresh();
      const events: TraceEvent[] = [];
      sim.onTrace((ev) => events.push(ev));
      sim.loadTopology(modelsDoc(profile));
      sim.runUntil(ALL_BOOTED + 60 * SEC);
      expect(sim.profile).toBe(profile);
      if (profile === 'P3') {
        expect(cdpSenders(events), profile).toEqual(['mls', 'r1', 'sw', 'wlc']);
        for (const dev of ['r1', 'sw', 'mls', 'wlc']) expect(cdpRunningFlag(sim, dev), `${profile} ${dev}`).toBe(true);
        // the switch hears every cdpDefault neighbour, and nobody else
        const heard = (sim.device('sw')!.tables.get<CdpNeighbourRow>('cdp-neighbours')?.rows() ?? []).map((r) => r.deviceId).sort();
        expect(heard).toEqual(['MLS', 'R1', 'WLC']);
      } else {
        expect(cdpSenders(events), profile).toEqual([]);
        for (const dev of ['r1', 'sw', 'mls', 'wlc']) expect(cdpRunningFlag(sim, dev), `${profile} ${dev}`).toBe(false);
        for (const d of sim.devices()) expect(sim.device(d.id)!.tables.get('cdp-neighbours')?.size ?? 0, `${profile} ${d.id}`).toBe(0);
      }
      expect(cdpRunningFlag(sim, 'home'), `${profile} home`).toBe(false);
      expect(cdpRunningFlag(sim, 'ap'), `${profile} ap`).toBeUndefined();
    }
  });
});

// ── completeness ────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * R1 (Gi0/0 → SW1 Gi0/1, Gi0/1 → SW3 Gi0/1), SW1 — SW2 on Fa0/24, SW1 — SW3 on Fa0/23, PC1 on SW1 Fa0/1. With CDP
 * on everywhere R1 hears SW1 and SW3, SW1 hears R1, SW2 and SW3, SW2 hears SW1 and SW3 hears R1 and SW1.
 */
function completenessDoc(profile: 'P2' | 'P3'): Topology {
  const r1 = configText([
    ['hostname R1'],
    section('interface GigabitEthernet0/0', ['ip address 10.0.0.1 255.255.255.0', 'no shutdown']),
    section('interface GigabitEthernet0/1', ['ip address 10.0.1.1 255.255.255.0', 'no shutdown']),
  ]);
  return doc(
    profile,
    [
      device('r1', ROUTER, 'R1', 300, 50, r1),
      device('sw1', SWITCH, 'SW1', 200, 200, configText([['hostname SW1']])),
      device('sw2', SWITCH, 'SW2', 50, 300, configText([['hostname SW2']])),
      device('sw3', SWITCH, 'SW3', 400, 200, configText([['hostname SW3']])),
      device('pc1', PC, 'PC1', 200, 400, pcConfig('PC1', '10.0.0.10', MASK, '10.0.0.1')),
    ],
    [
      link('l_r1_sw1', 'r1', 'GigabitEthernet0/0', 'sw1', 'GigabitEthernet0/1'),
      link('l_r1_sw3', 'r1', 'GigabitEthernet0/1', 'sw3', 'GigabitEthernet0/1'),
      link('l_sw1_sw2', 'sw1', 'FastEthernet0/24', 'sw2', 'FastEthernet0/24'),
      link('l_sw1_sw3', 'sw1', 'FastEthernet0/23', 'sw3', 'FastEthernet0/23'),
      link('l_pc1', 'pc1', 'GigabitEthernet0', 'sw1', 'FastEthernet0/1'),
    ],
  );
}

/** The lines are typed at T1; by T2 every row the change ends has aged out (holdtime 180 s) or been cleared. */
const T1: SimTime = 100 * SEC;
const T2: SimTime = T1 + 200 * SEC;
/** One CDP period: every enabled up port sends exactly once in any half-open window this long. */
const CDP_PERIOD: SimTime = 60 * SEC;

/** A device's CDP rows without their times, key order. */
function cdpRows(sim: Simulation, id: DeviceId): Record<string, unknown>[] {
  const rows = sim.device(id)!.tables.get<CdpNeighbourRow>('cdp-neighbours')?.rows() ?? [];
  return rows
    .map((r) => {
      const { updatedAt: _u, expiresAt: _e, ...rest } = r as CdpNeighbourRow & Record<string, unknown>;
      return rest;
    })
    .sort((a, b) => String(a['key']).localeCompare(String(b['key'])));
}
/** Every device's CDP rows, with their times (the reloaded world and the clone share a construction). */
const cdpRowsTimed = (sim: Simulation): string => JSON.stringify(sim.devices().map((d) => [d.id, d.tables.get('cdp-neighbours')?.rows() ?? []]));

/** The CDP frames sent in (now, now + one period], time-free and sorted: `from port > to port size summary`. */
function cdpPeriodFrames(sim: Simulation): string[] {
  const cursor = sim.trace(0).next;
  sim.runFor(CDP_PERIOD);
  return ofKind(sim.trace(cursor).events, 'frameTx')
    .filter((e) => e.pdu.tag === 'cdp')
    .map((e) => `${e.from.device} ${e.from.port} > ${e.to.device} ${e.to.port} ${e.pdu.size} ${e.pdu.summary}`)
    .sort();
}

/** The live world (lines typed at T1, run to T2), the reloaded export and the grader's clone, all at T2. */
function threeWorlds(profile: 'P2' | 'P3', typed: Readonly<Record<string, readonly string[]>>): { live: Simulation; reloaded: Simulation; clone: Simulation } {
  const live = fresh();
  live.loadTopology(completenessDoc(profile));
  live.runUntil(T1);
  for (const [dev, ls] of Object.entries(typed)) {
    const r = live.configure(dev, ls);
    expect(r.lines.filter((l) => !l.ok).map((l) => `${l.line}: ${l.error?.message ?? l.output}`), dev).toEqual([]);
  }
  live.runUntil(T2);
  const out = live.exportTopology();
  expect(out.profile).toBe(profile);
  expect(out.schema).toBe(profile === 'P3' ? TOPOLOGY_SCHEMA_ID_1_3 : TOPOLOGY_SCHEMA_ID_1_2);
  const reloaded = fresh();
  reloaded.loadTopology(out);
  expect(reloaded.profile).toBe(profile);
  reloaded.runUntil(T2);
  // the grader's construction (sim/lab-checks.ts settledClone): the export loaded with the live seed and catalog
  const clone = createSimulation({ seed: live.seed, catalog: live.catalog, journal: false });
  clone.loadTopology(out);
  expect(clone.profile).toBe(profile);
  expect(clone.runToIdle(LAB_CLONE_BOOT_EVENTS).stopped).toBeUndefined();
  clone.runUntil(T2);
  return { live, reloaded, clone };
}

/** Running configuration, CDP rows and one period of CDP frames identical in the three worlds; returns the live rows. */
function expectSameInAllThree(w: { live: Simulation; reloaded: Simulation; clone: Simulation }): Record<string, Record<string, unknown>[]> {
  const ids = w.live.devices().map((d) => d.id);
  const rows: Record<string, Record<string, unknown>[]> = {};
  for (const id of ids) {
    rows[id] = cdpRows(w.live, id);
    for (const [name, sim] of [['reloaded', w.reloaded], ['clone', w.clone]] as const) {
      expect(running(sim, id), `${name} ${id} running configuration`).toBe(running(w.live, id));
      expect(cdpRows(sim, id), `${name} ${id} CDP rows`).toEqual(rows[id]);
    }
  }
  expect(cdpRowsTimed(w.clone)).toBe(cdpRowsTimed(w.reloaded));
  const frames = cdpPeriodFrames(w.live);
  expect(cdpPeriodFrames(w.reloaded), 'reloaded CDP frames').toEqual(frames);
  expect(cdpPeriodFrames(w.clone), 'clone CDP frames').toEqual(frames);
  return rows;
}

const neighbours = (rows: Record<string, Record<string, unknown>[]>): Record<string, string[]> =>
  Object.fromEntries(Object.entries(rows).map(([id, rs]) => [id, rs.map((r) => `${String(r['localPort'])}|${String(r['deviceId'])}`)]));

describe('accept P3 profile: completeness (D2) — the CDP lines survive export, reload and the lab clone', () => {
  it('`no cdp run` and `no cdp enable` typed in a P3 world', () => {
    const w = threeWorlds('P3', { sw2: ['no cdp run'], sw1: ['interface GigabitEthernet0/1', 'no cdp enable'] });
    // completeness rule 1: the reversal of a default is stored explicitly in its slot
    expect(lines(running(w.live, 'sw2'))).toContain('no cdp run');
    expect(running(w.live, 'sw1')).toMatch(/\ninterface GigabitEthernet0\/1\n(?: .*\n)*? no cdp enable\n/);
    const rows = expectSameInAllThree(w);
    expect(neighbours(rows)).toEqual({
      r1: ['GigabitEthernet0/1|SW3'],
      sw1: ['FastEthernet0/23|SW3'],
      sw2: [],
      sw3: ['FastEthernet0/23|SW1', 'GigabitEthernet0/1|R1'],
      pc1: [],
    });
  }, 60_000);

  it('`cdp run` typed in a P2 world', () => {
    const w = threeWorlds('P2', { r1: ['cdp run'], sw1: ['cdp run'] });
    for (const id of ['r1', 'sw1']) expect(lines(running(w.live, id)), id).toContain('cdp run');
    const rows = expectSameInAllThree(w);
    expect(neighbours(rows)).toEqual({
      r1: ['GigabitEthernet0/0|SW1'],
      sw1: ['GigabitEthernet0/1|R1'],
      sw2: [],
      sw3: [],
      pc1: [],
    });
  }, 60_000);
});

// ── proxy ARP and the defaults ladder ───────────────────────────────────────────────────────────────────────────

/** R1 routes 10.0.1.0/24 (Gi0/0) and 10.0.2.0/24 (Gi0/1); PC1 believes 10.0.0.0/16 is on its link and has no gateway. */
function proxyArpDoc(profile: DefaultsProfile): Topology {
  return doc(
    profile,
    [
      device('r1', ROUTER, 'R1', 300, 100, configText([
        ['hostname R1'],
        section('interface GigabitEthernet0/0', ['ip address 10.0.1.1 255.255.255.0', 'no shutdown']),
        section('interface GigabitEthernet0/1', ['ip address 10.0.2.1 255.255.255.0', 'no shutdown']),
      ])),
      device('pc1', PC, 'PC1', 100, 250, pcConfig('PC1', '10.0.1.10', '255.255.0.0')),
      device('pc2', PC, 'PC2', 500, 250, pcConfig('PC2', '10.0.2.10', MASK, '10.0.2.1')),
    ],
    [link('l1', 'pc1', 'GigabitEthernet0', 'r1', 'GigabitEthernet0/0'), link('l2', 'pc2', 'GigabitEthernet0', 'r1', 'GigabitEthernet0/1')],
  );
}

describe('accept P3 profile: proxy ARP and the defaults ladder', () => {
  it('proxy ARP is still on for a routed interface of a P3 router (and off in a P1 world)', () => {
    for (const profile of ['P3', 'P1'] as const) {
      const sim = fresh();
      sim.loadTopology(proxyArpDoc(profile));
      expect(sim.profile).toBe(profile);
      sim.runUntil(ALL_BOOTED);
      const { text } = ping(sim, 'pc1', '10.0.2.10');
      const proxied = sim.device('r1')!.processes.get('arp')!.stateSnapshot().state['proxyRepliesSent'];
      if (profile === 'P3') {
        expect(text, profile).toContain('Sent 5, received 5, lost 0');
        expect(proxied, profile).toBeGreaterThanOrEqual(1);
      } else {
        expect(text, profile).not.toContain('received 5');
        expect(proxied, profile).toBeUndefined();
      }
    }
  });

  it('upgradeDefaults to P3 on a P2 world: profile P3, schema 1.3, no line rewritten, CDP rows after boot', () => {
    const p2 = fresh();
    p2.loadTopology(completenessDoc('P2'));
    p2.runUntil(ALL_BOOTED);
    for (const d of p2.devices()) expect(p2.device(d.id)!.tables.get('cdp-neighbours')?.size ?? 0, d.id).toBe(0);
    const before = p2.exportTopology();
    expect(before.schema).toBe(TOPOLOGY_SCHEMA_ID_1_2);
    const after = upgradeDefaults(before, (type) => p2.catalog.get(type), 'P3');
    expect(after.profile).toBe('P3');
    expect(after.schema).toBe(TOPOLOGY_SCHEMA_ID_1_3);
    // no configuration line rewritten: every device keeps its startup and running texts (and the document its devices)
    expect(after.devices).toEqual(before.devices);
    expect(after.links).toEqual(before.links);
    // the input is never mutated
    expect(before.profile).toBe('P2');
    const sim = fresh();
    sim.loadTopology(after);
    expect(sim.profile).toBe('P3');
    sim.runUntil(ALL_BOOTED);
    expect(cdpRows(sim, 'sw1').map((r) => r['deviceId']).sort()).toEqual(['R1', 'SW2', 'SW3']);
    expect(cdpRows(sim, 'r1').map((r) => r['deviceId']).sort()).toEqual(['SW1', 'SW3']);
  });
});
