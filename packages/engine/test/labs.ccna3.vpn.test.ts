/**
 * P3 W5 wan: the CCNA 3 tunnel and VPN labs (ARCHITECTURE-P3 §7 W5, §11.1, §11.2, §3.10, §3.13; sim/scenarios/ccna3/
 * vpn.ts) — a local copy of the checks of `labs.ccna3.solutions.test.ts` (owned by sim), filtered to lab 24
 * `ccna3-gre-tunnel` [S18] and lab 25 `ccna3-ipsec-site-to-site` [C13], plus each lab's own proofs.
 *
 * For each lab:
 *   • metadata: category `ccna3-lab`, course `CCNA 3`, `topic` = the title of the module that holds its lesson in
 *     curriculum/ccna3/lessons.ts, the name §11.1 freezes, a fixed seed, the §11.2 timing sentence, structured-clone
 *     safe `scenarioMeta`, `requires` = exactly the catalog types the topology uses, tasks with unique ids, real points
 *     and existing dependencies, a solution for devices the topology has;
 *   • its world: a P3-profile topology whose schema is `schemaIdFor(t)` (1.3), loaded as a P3 world;
 *   • UNSOLVED (booted and settled): EVERY task fails, each on a failing assertion that says why;
 *   • SOLVED: `configure` accepts every line of the reference solution as written, the world runs to idle, and every
 *     task passes — full marks;
 *   • grading is read-only (same clock, trace head and PDU count) and repeatable (two evaluations are equal).
 *
 * The `path` kind ([S18], with [C13] `tunnelAt`) is the W5 sim item's checker (sim/lab-checks/path.ts). What its
 * `tunnelAt` member grades is also proved here independently, from the live trace: in the solved worlds every frame
 * the ISP sends or receives during a site-to-site ping is a GRE leg (lab 24) or an ESP leg (lab 25), never plain IPv4;
 * and the wrong answers below fail the `path` assertion with the reason the frames show.
 *
 * Other right answers: lab 24's routes written with Tunnel0 as the exit interface and its tunnel source written as
 * the public address; lab 25's keyring peer under another label and its remote identity without the host mask. Wrong
 * answers: a tunnel aimed at the provider (lab 24: it comes up, carries nothing across, and the destination check
 * names it); a tunnel sourced from the LAN interface (lab 24, W5 fix #14); private routes typed on the provider
 * instead of a tunnel (lab 24: the ping works, nothing earns marks); a different key on one end (lab 25: IKE fails,
 * the world still runs to idle, only the configuration tasks pass); R1 matching its own address, or a profile without
 * its authentication lines (lab 25, W5 fix #12); IKE configured but the tunnel left unprotected (lab 25: the ping
 * still works through plain GRE, which the ISP reads). And the timing the instructions promise: R2 configured seconds
 * after R1 still brings the SA up within about a second (W5 fix #13).
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { DeviceId } from '../src/contracts/ids.js';
import type { LabAssertion, ScenarioInfo } from '../src/contracts/scenario.js';
import { scenarioMeta } from '../src/contracts/scenario.js';
import type { Simulation } from '../src/contracts/simulation.js';
import type { IpsecSaRow } from '../src/contracts/tables.js';
import { SEC } from '../src/contracts/time.js';
import { TOPOLOGY_SCHEMA_ID_1_3, schemaIdFor, type Topology } from '../src/contracts/topology.js';
import type { TraceEvent } from '../src/contracts/trace.js';
import { CCNA3_MODULES } from '../src/curriculum/ccna3/lessons.js';
import { createCatalog } from '../src/device/catalog/index.js';
import { PROCESS_FACTORIES } from '../src/protocols/index.js';
import { evaluateLab } from '../src/sim/lab-checks.js';
import { createSimulation } from '../src/sim/simulation.js';
import {
  CCNA3_VPN_LABS,
  VPN_IPSEC_KEY,
  VPN_PC2,
  VPN_R1_PUBLIC,
  VPN_R2_PUBLIC,
  VPN_TUNNEL,
  ccna3GreTunnel,
  ccna3IpsecSiteToSite,
} from '../src/sim/scenarios/ccna3/vpn.js';
import { ping } from './sim.harness.js';

/** Long enough for every model of a lab to boot (the router takes 45 s); `runToIdle` then settles the rest. */
const BOOT_NS = 90 * SEC;

/** Wall-clock budget of one per-lab world test: a lab world plus its grading clone. */
const LAB_TEST_TIMEOUT_MS = 60_000;

const catalog = createCatalog(PROCESS_FACTORIES);

/** The lessons of the skeleton, with the title of the module that holds each. */
const LESSONS = CCNA3_MODULES.flatMap((m) => m.lessons.map((l) => ({ lesson: l, module: m.title })));

/** The names §11.1 freezes for this file, in course order. */
const VPN_NAMES = ['ccna3-gre-tunnel', 'ccna3-ipsec-site-to-site'];

type FrameTx = Extract<TraceEvent, { kind: 'frameTx' }>;

/** The lab's world as `loadScenario` builds it: the lab seed, the lab topology, booted and settled. */
function labWorld(lab: ScenarioInfo): Simulation {
  const sim = createSimulation({ seed: lab.seed ?? 1 });
  sim.loadTopology({ ...lab.build(), lab: { name: lab.name, version: lab.version ?? 1 } });
  for (const f of lab.faults ?? []) sim.injectFault(f.at, f.fault);
  sim.runFor(BOOT_NS);
  expect(sim.runToIdle().stopped).toBeUndefined();
  return sim;
}

/** Device id of a topology name (labs address devices by name, `configure` takes an id). */
function idOf(sim: Simulation, name: string): DeviceId {
  for (const d of sim.devices()) if (d.spec.name === name) return d.id;
  throw new Error(`no device called ${name} in this lab`);
}

/** Type `lines` on the device called `name`; every line must be accepted (a refused line is reported in full). */
function typeOn(sim: Simulation, name: string, lines: readonly string[], what = name): void {
  const r = sim.configure(idOf(sim, name), lines);
  expect(r.lines.filter((l) => !l.ok).map((l) => `${l.line}: ${l.error?.message ?? l.output}`), what).toEqual([]);
  expect(r.ok, what).toBe(true);
}

/** Apply the reference solution as written, then settle (which must return). */
function applySolution(sim: Simulation, lab: ScenarioInfo): void {
  for (const [name, lines] of Object.entries(lab.solution ?? {})) typeOn(sim, name, lines, `${lab.name} solution for ${name}`);
  expect(sim.runToIdle().stopped).toBeUndefined();
}

/** The catalog types a topology actually uses. */
function typesOf(topo: Topology): string[] {
  return [...new Set(topo.devices.map((d) => d.type))].sort();
}

/** Pass flag of each task, by id. */
function taskPasses(sim: Simulation, lab: ScenarioInfo): Record<string, boolean> {
  return Object.fromEntries(evaluateLab(sim, lab).results.map((r) => [r.task, r.pass]));
}

/** The index of the `path` assertion of task `task` (each lab's last task has exactly one). */
function pathIndexOf(lab: ScenarioInfo, task: string): number {
  const assertions: readonly LabAssertion[] = lab.tasks?.find((t) => t.id === task)?.assertions ?? [];
  const at = assertions.map((a, i) => (a.kind === 'path' ? i : -1)).filter((i) => i >= 0);
  expect(at, `${lab.name}/${task}`).toHaveLength(1);
  return at[0] ?? -1;
}

/** The detail of assertion `index` of task `task` in a fresh evaluation ('' when it passes). */
function detailOf(sim: Simulation, lab: ScenarioInfo, task: string, index: number): string {
  const a = evaluateLab(sim, lab).results.find((r) => r.task === task)?.assertions.find((x) => x.index === index);
  return a === undefined || a.pass ? '' : (a.detail ?? '(no detail)');
}

/** Every failing assertion of a status: task, index and detail. */
function failingAssertions(sim: Simulation, lab: ScenarioInfo): { task: string; index: number; detail: string }[] {
  return evaluateLab(sim, lab).results.flatMap((r) => r.assertions.filter((a) => !a.pass).map((a) => ({ task: r.task, index: a.index, detail: a.detail ?? '' })));
}

/** PC1 pings PC2 (5 echoes); the frames the ISP sent or received meanwhile (serial keepalives aside) and the output. */
function pingAcrossProvider(sim: Simulation): { text: string; atIsp: FrameTx[] } {
  const r = ping(sim, 'pc1', VPN_PC2);
  const atIsp = r.evs.filter((e): e is FrameTx => e.kind === 'frameTx' && e.background !== true && (e.from.device === 'isp' || e.to.device === 'isp'));
  return { text: r.text, atIsp };
}

/** The networks of the ISP's RIB that are private (RFC 1918 192.168/16 or 172.16/12). */
function privateRoutesAtIsp(sim: Simulation): string[] {
  return sim
    .device('isp')!
    .tables.rib.rows()
    .map((r) => r.network)
    .filter((n) => n.startsWith('192.168.') || /^172\.(1[6-9]|2\d|3[01])\./.test(n));
}

describe('CCNA3 VPN labs: the file', () => {
  it('holds labs 24 and 25 under the names §11.1 freezes, in course order, each the lab of its lesson', () => {
    expect(CCNA3_VPN_LABS.map((l) => l.name)).toEqual(VPN_NAMES);
    expect(CCNA3_VPN_LABS).toEqual([ccna3GreTunnel, ccna3IpsecSiteToSite]);
    expect(Object.isFrozen(CCNA3_VPN_LABS)).toBe(true);
    const lessonLabs = LESSONS.flatMap((l) => (l.lesson.lab === undefined ? [] : [l.lesson.lab]));
    for (const name of VPN_NAMES) expect(lessonLabs.filter((n) => n === name), name).toHaveLength(1);
    expect(lessonLabs.filter((n) => VPN_NAMES.includes(n))).toEqual(VPN_NAMES);
    expect(LESSONS.find((l) => l.lesson.lab === 'ccna3-gre-tunnel')?.lesson.id).toBe('ccna3-24-gre-tunnels');
    expect(LESSONS.find((l) => l.lesson.lab === 'ccna3-ipsec-site-to-site')?.lesson.id).toBe('ccna3-25-site-to-site-ipsec');
  });

  it('imports only the contracts, the kit and the templates (no cycle, rule 12)', () => {
    const file = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'sim', 'scenarios', 'ccna3', 'vpn.ts');
    const text = readFileSync(file, 'utf8');
    const imports = [...text.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1] ?? '');
    expect(imports.length).toBeGreaterThan(0);
    for (const spec of imports) expect(spec, `vpn.ts imports ${spec}`).toMatch(/^\.\.\/\.\.\/\.\.\/contracts\/[a-z-]+\.js$|^\.\.\/kit\.js$|^\.\.\/templates\.js$/);
  });
});

for (const lab of CCNA3_VPN_LABS) {
  describe(`CCNA3 lab: ${lab.name}`, () => {
    it('describes itself with structured-clone safe metadata, its module as topic and a catalog it really uses', () => {
      expect(lab.category).toBe('ccna3-lab');
      expect(lab.course).toBe('CCNA 3');
      expect(lab.name).toMatch(/^ccna3(-[a-z0-9]+)+$/);
      const home = LESSONS.find((l) => l.lesson.lab === lab.name);
      expect(home, `${lab.name} is the lab of a lesson`).toBeDefined();
      expect(lab.topic).toBe(home?.module);
      expect(lab.topic).toBe('Tunnels and VPNs');
      expect(lab.labType).toBeDefined();
      expect(lab.seed, lab.name).toBeTypeOf('number');
      // §11.2: the timing sentence (routers boot in 45 s; nothing else here waits on a protocol timer)
      expect(lab.instructions ?? '').toContain('about a minute');
      expect((lab.objectives ?? []).length, lab.name).toBeGreaterThan(0);
      expect((lab.tasks ?? []).length, lab.name).toBeGreaterThan(0);
      expect(Object.keys(lab.solution ?? {}).length, lab.name).toBeGreaterThan(0);

      const meta = scenarioMeta(lab);
      expect(structuredClone(meta)).toEqual(meta);
      expect(meta).not.toHaveProperty('build');
      expect(meta).not.toHaveProperty('solution');
      expect(meta).not.toHaveProperty('faults');
      for (const task of meta.tasks ?? []) expect(task).not.toHaveProperty('assertions');

      const topo = lab.build();
      expect([...(lab.requires ?? [])].sort()).toEqual(typesOf(topo));
      for (const type of lab.requires ?? []) expect(catalog.get(type), type).toBeDefined();

      const ids = (lab.tasks ?? []).map((t) => t.id);
      expect(new Set(ids).size).toBe(ids.length);
      for (const task of lab.tasks ?? []) {
        expect(task.points, `${lab.name}/${task.id}`).toBeGreaterThan(0);
        expect(task.assertions.length, `${lab.name}/${task.id}`).toBeGreaterThan(0);
        for (const dep of task.dependsOn ?? []) expect(ids, `${lab.name}/${task.id}`).toContain(dep);
      }
      const deviceNames = topo.devices.map((d) => d.name);
      for (const name of Object.keys(lab.solution ?? {})) expect(deviceNames).toContain(name);
      // the world has no switch, so no access port needs PortFast (§11.2)
      expect(topo.devices.every((d) => !d.type.startsWith('switch.') && !d.type.startsWith('mlswitch.'))).toBe(true);
    });

    it('builds a P3-profile world whose schema can express it', () => {
      const topo = lab.build();
      expect(topo.profile).toBe('P3');
      expect(topo.schema).toBe(TOPOLOGY_SCHEMA_ID_1_3);
      expect(topo.schema).toBe(schemaIdFor(topo));
      expect(topo.seed).toBe(lab.seed);
      expect(lab.build()).toEqual(topo);
      const sim = createSimulation({ seed: lab.seed ?? 1 });
      sim.loadTopology(topo);
      expect(sim.profile).toBe('P3');
    });

    it('fails every task before the student starts, and says why', () => {
      const sim = labWorld(lab);
      const status = evaluateLab(sim, lab);
      expect(status.lab).toBe(lab.name);
      expect(status.total).toBe((lab.tasks ?? []).reduce((n, t) => n + t.points, 0));
      expect(status.score).toBe(0);
      for (const r of status.results) {
        expect(r.pass, `${lab.name}/${r.task} unsolved`).toBe(false);
        expect(r.assertions.some((a) => !a.pass && (a.detail ?? '') !== ''), `${lab.name}/${r.task}`).toBe(true);
      }
    }, LAB_TEST_TIMEOUT_MS);

    it('scores full marks once the reference solution is applied as written', () => {
      const sim = labWorld(lab);
      applySolution(sim, lab);
      expect(failingAssertions(sim, lab), `${lab.name} solved`).toEqual([]);
      const status = evaluateLab(sim, lab);
      expect(status.score).toBe(status.total);
    }, LAB_TEST_TIMEOUT_MS);

    it('grades without touching the live simulation, and the same way twice', () => {
      const sim = labWorld(lab);
      applySolution(sim, lab);
      const now = sim.now;
      const head = sim.trace(0).next;
      const pdus = sim.snapshot().pduCount;

      const first = evaluateLab(sim, lab);
      const second = evaluateLab(sim, lab);

      expect(second).toEqual(first);
      expect(sim.now).toBe(now);
      expect(sim.trace(0).next).toBe(head);
      expect(sim.snapshot().pduCount).toBe(pdus);
    }, LAB_TEST_TIMEOUT_MS);
  });
}

describe('CCNA3 lab ccna3-gre-tunnel [S18]: what the tasks grade', () => {
  it('before the tunnel, PC1 cannot reach PC2: the ISP has no private route', () => {
    const sim = labWorld(ccna3GreTunnel);
    expect(privateRoutesAtIsp(sim)).toEqual([]);
    expect(pingAcrossProvider(sim).text).toContain('Sent 5, received 0');
  }, LAB_TEST_TIMEOUT_MS);

  it('solved: the tunnel is up, the ping succeeds and every frame the ISP handles is a GRE leg between the public ends', () => {
    const sim = labWorld(ccna3GreTunnel);
    applySolution(sim, ccna3GreTunnel);
    for (const name of ['R1', 'R2']) expect(sim.device(idOf(sim, name))!.port(VPN_TUNNEL)?.operUp, name).toBe(true);
    const { text, atIsp } = pingAcrossProvider(sim);
    expect(text).toContain('Sent 5, received 5, lost 0 (0% loss)');
    expect(atIsp.length).toBeGreaterThanOrEqual(20);
    for (const l of atIsp) expect(l.pdu.tunnel, `${l.from.device} → ${l.to.device} ${l.pdu.summary}`).toBe('gre');
    expect(privateRoutesAtIsp(sim)).toEqual([]);
  }, LAB_TEST_TIMEOUT_MS);

  it('routes written with Tunnel0 as the exit interface earn full marks too', () => {
    const sim = labWorld(ccna3GreTunnel);
    for (const [name, peer, lan] of [['R1', VPN_R2_PUBLIC, '192.168.2.0'], ['R2', VPN_R1_PUBLIC, '192.168.1.0']] as const) {
      const solution = ccna3GreTunnel.solution?.[name] ?? [];
      expect(solution).toContain(`tunnel destination ${peer}`);
      typeOn(sim, name, [...solution.filter((l) => !l.startsWith('ip route ')), `ip route ${lan} 255.255.255.0 ${VPN_TUNNEL}`]);
    }
    expect(sim.runToIdle().stopped).toBeUndefined();
    expect(failingAssertions(sim, ccna3GreTunnel)).toEqual([]);
  }, LAB_TEST_TIMEOUT_MS);

  it('wrong answer: a tunnel aimed at the provider comes up but earns nothing, and carries nothing across', () => {
    const sim = labWorld(ccna3GreTunnel);
    for (const name of ['R1', 'R2']) {
      const lines = (ccna3GreTunnel.solution?.[name] ?? []).map((l) => (l.startsWith('tunnel destination ') ? `tunnel destination ${name === 'R1' ? '209.165.200.226' : '209.165.200.229'}` : l));
      typeOn(sim, name, lines);
    }
    expect(sim.runToIdle().stopped).toBeUndefined();
    for (const name of ['R1', 'R2']) expect(sim.device(idOf(sim, name))!.port(VPN_TUNNEL)?.operUp, name).toBe(true);
    const status = evaluateLab(sim, ccna3GreTunnel);
    const build = status.results.find((r) => r.task === 'build-tunnel')!;
    expect(build.pass).toBe(false);
    expect(build.assertions.filter((a) => !a.pass).map((a) => a.detail)).toEqual([
      `R1 interface.Tunnel0.tunnel.destination is "destination 209.165.200.226", expected "destination ${VPN_R2_PUBLIC}".`,
      `R2 interface.Tunnel0.tunnel.destination is "destination 209.165.200.229", expected "destination ${VPN_R1_PUBLIC}".`,
      // W5 fix #14: the tunnels rows (source and destination as resolved) are graded too
      `The tunnels table of R1 has no row with port=Tunnel0 source=${VPN_R1_PUBLIC} destination=${VPN_R2_PUBLIC}. The tunnel must leave from the serial link to the provider and aim at the other router's public address.`,
      `The tunnels table of R2 has no row with port=Tunnel0 source=${VPN_R2_PUBLIC} destination=${VPN_R1_PUBLIC}. The tunnel must leave from the serial link to the provider and aim at the other router's public address.`,
    ]);
    expect(status.results.find((r) => r.task === 'site-to-site')?.pass).toBe(false);
    expect(detailOf(sim, ccna3GreTunnel, 'site-to-site', pathIndexOf(ccna3GreTunnel, 'site-to-site'))).toContain("PC1's probe to PC2 (192.168.2.10) never reached PC2");
    expect(pingAcrossProvider(sim).text).toContain('Sent 5, received 0');
  }, LAB_TEST_TIMEOUT_MS);

  it('wrong answer: a tunnel sourced from the LAN interface comes up but fails the build task (W5 fix #14)', () => {
    const sim = labWorld(ccna3GreTunnel);
    for (const name of ['R1', 'R2']) {
      const lines = (ccna3GreTunnel.solution?.[name] ?? []).map((l) => (l.startsWith('tunnel source ') ? 'tunnel source GigabitEthernet0/0' : l));
      expect(lines).toContain('tunnel source GigabitEthernet0/0');
      typeOn(sim, name, lines);
    }
    expect(sim.runToIdle().stopped).toBeUndefined();
    for (const name of ['R1', 'R2']) expect(sim.device(idOf(sim, name))!.port(VPN_TUNNEL)?.operUp, name).toBe(true);
    const build = evaluateLab(sim, ccna3GreTunnel).results.find((r) => r.task === 'build-tunnel')!;
    expect(build.pass).toBe(false);
    expect(build.assertions.filter((a) => !a.pass).map((a) => a.detail)).toEqual([
      `The tunnels table of R1 has no row with port=Tunnel0 source=${VPN_R1_PUBLIC} destination=${VPN_R2_PUBLIC}. The tunnel must leave from the serial link to the provider and aim at the other router's public address.`,
      `The tunnels table of R2 has no row with port=Tunnel0 source=${VPN_R2_PUBLIC} destination=${VPN_R1_PUBLIC}. The tunnel must leave from the serial link to the provider and aim at the other router's public address.`,
    ]);
  }, LAB_TEST_TIMEOUT_MS);

  it('the tunnel source written as the public address earns full marks too', () => {
    const sim = labWorld(ccna3GreTunnel);
    for (const name of ['R1', 'R2']) {
      const lines = (ccna3GreTunnel.solution?.[name] ?? []).map((l) => (l.startsWith('tunnel source ') ? `tunnel source ${name === 'R1' ? VPN_R1_PUBLIC : VPN_R2_PUBLIC}` : l));
      typeOn(sim, name, lines);
    }
    expect(sim.runToIdle().stopped).toBeUndefined();
    expect(failingAssertions(sim, ccna3GreTunnel)).toEqual([]);
  }, LAB_TEST_TIMEOUT_MS);

  it('wrong answer: private routes typed on the provider make the ping work, yet earn nothing', () => {
    const sim = labWorld(ccna3GreTunnel);
    typeOn(sim, 'ISP', ['ip route 192.168.1.0 255.255.255.0 209.165.200.225', 'ip route 192.168.2.0 255.255.255.0 209.165.200.230']);
    expect(sim.runToIdle().stopped).toBeUndefined();
    const status = evaluateLab(sim, ccna3GreTunnel);
    expect(status.score).toBe(0);
    const site = status.results.find((r) => r.task === 'site-to-site')!;
    expect(site.pass).toBe(false);
    // the ping itself passes; the provider check names the route that should not be there
    expect(site.assertions[0]?.pass).toBe(true);
    const details = site.assertions.filter((a) => !a.pass).map((a) => a.detail ?? '');
    expect(details.some((d) => d.startsWith('ISP still routes 192.168.1.10 through'))).toBe(true);
    expect(details.some((d) => d.startsWith('ISP still routes 192.168.2.10 through'))).toBe(true);
    expect(detailOf(sim, ccna3GreTunnel, 'site-to-site', pathIndexOf(ccna3GreTunnel, 'site-to-site'))).toContain('outside any tunnel, not inside a GRE tunnel.');
    // and the frames at the ISP are plain IPv4, not tunnel legs (what `path.tunnelAt` reads)
    const { text, atIsp } = pingAcrossProvider(sim);
    expect(text).toContain('Sent 5, received 5');
    expect(atIsp.length).toBeGreaterThan(0);
    for (const l of atIsp) expect(l.pdu.tunnel).toBeUndefined();
  }, LAB_TEST_TIMEOUT_MS);
});

describe('CCNA3 lab ccna3-ipsec-site-to-site [C13]: what the tasks grade', () => {
  it('starts from a working GRE tunnel the ISP can read', () => {
    const sim = labWorld(ccna3IpsecSiteToSite);
    for (const name of ['R1', 'R2']) expect(sim.device(idOf(sim, name))!.port(VPN_TUNNEL)?.operUp, name).toBe(true);
    const { text, atIsp } = pingAcrossProvider(sim);
    expect(text).toContain('Sent 5, received 5, lost 0 (0% loss)');
    expect(atIsp.length).toBeGreaterThan(0);
    for (const l of atIsp) expect(l.pdu.tunnel).toBe('gre');
    // the only-esp task fails although the ping works: the path check sees GRE legs at the ISP
    expect(taskPasses(sim, ccna3IpsecSiteToSite)['only-esp']).toBe(false);
    expect(detailOf(sim, ccna3IpsecSiteToSite, 'only-esp', 0)).toBe('');
    expect(detailOf(sim, ccna3IpsecSiteToSite, 'only-esp', pathIndexOf(ccna3IpsecSiteToSite, 'only-esp'))).toMatch(/^ISP received \d+ of \d+ frames? of PC1's probe to PC2 \(192\.168\.2\.10\) inside a GRE tunnel, not inside an IPsec \(ESP\) tunnel\./);
  }, LAB_TEST_TIMEOUT_MS);

  it('solved: both SAs established, the ping succeeds and only ESP crosses the provider; the key is in no frame', () => {
    const sim = labWorld(ccna3IpsecSiteToSite);
    applySolution(sim, ccna3IpsecSiteToSite);
    for (const [name, peer] of [['R1', VPN_R2_PUBLIC], ['R2', VPN_R1_PUBLIC]] as const) {
      const sa = sim.device(idOf(sim, name))!.tables.get<IpsecSaRow>('ipsec-sa')?.get(VPN_TUNNEL);
      expect(sa?.state, name).toBe('established');
      expect(sa?.peer, name).toBe(peer);
      expect(sim.device(idOf(sim, name))!.port(VPN_TUNNEL)?.operUp, name).toBe(true);
    }
    const { text, atIsp } = pingAcrossProvider(sim);
    expect(text).toContain('Sent 5, received 5, lost 0 (0% loss)');
    expect(atIsp.length).toBeGreaterThanOrEqual(20);
    for (const l of atIsp) expect(l.pdu.tunnel, `${l.from.device} → ${l.to.device} ${l.pdu.summary}`).toBe('ipsec');
    for (const l of atIsp) expect(l.pdu.summary).not.toContain(VPN_IPSEC_KEY);
    expect(privateRoutesAtIsp(sim)).toEqual([]);
  }, LAB_TEST_TIMEOUT_MS);

  it('names the keyring peer freely: only the names other sections refer to are graded', () => {
    const sim = labWorld(ccna3IpsecSiteToSite);
    for (const name of ['R1', 'R2']) {
      typeOn(sim, name, (ccna3IpsecSiteToSite.solution?.[name] ?? []).map((l) => (l.startsWith('peer ') ? 'peer FAR-SITE' : l)));
    }
    expect(sim.runToIdle().stopped).toBeUndefined();
    expect(sim.device(idOf(sim, 'R1'))!.running.render()).toContain(' peer FAR-SITE\n');
    const passes = taskPasses(sim, ccna3IpsecSiteToSite);
    expect([passes['ike-setup'], passes['protect-tunnel'], passes['sa-established']]).toEqual([true, true, true]);
  }, LAB_TEST_TIMEOUT_MS);

  it('wrong answer: a different key on R2 fails IKE on both ends; the world still runs to idle and only the configuration tasks pass', () => {
    const sim = labWorld(ccna3IpsecSiteToSite);
    const wrong = (ccna3IpsecSiteToSite.solution?.R2 ?? []).map((l) => (l === `pre-shared-key ${VPN_IPSEC_KEY}` ? 'pre-shared-key Other-Key-0000' : l));
    expect(wrong).toContain('pre-shared-key Other-Key-0000');
    typeOn(sim, 'R1', ccna3IpsecSiteToSite.solution?.R1 ?? []);
    typeOn(sim, 'R2', wrong);
    expect(sim.runToIdle().stopped).toBeUndefined();
    for (const name of ['R1', 'R2']) {
      expect(sim.device(idOf(sim, name))!.tables.get<IpsecSaRow>('ipsec-sa')?.get(VPN_TUNNEL)?.state, name).toBe('failed');
      expect(sim.device(idOf(sim, name))!.port(VPN_TUNNEL)?.operUp, name).toBe(false);
    }
    const status = evaluateLab(sim, ccna3IpsecSiteToSite);
    expect(Object.fromEntries(status.results.map((r) => [r.task, r.pass]))).toEqual({
      'ike-setup': true,
      'protect-tunnel': true,
      'sa-established': false,
      'only-esp': false,
    });
    expect(status.score).toBe(40);
    const sa = status.results.find((r) => r.task === 'sa-established')!;
    expect(sa.assertions[0]?.detail).toContain('failed');
    // the down tunnel's route is unusable, so the ping follows the default route and dies at the ISP (§3.13 step 10)
    const onlyEsp = status.results.find((r) => r.task === 'only-esp')!;
    expect(onlyEsp.assertions[0]?.pass).toBe(false);
    expect(detailOf(sim, ccna3IpsecSiteToSite, 'only-esp', pathIndexOf(ccna3IpsecSiteToSite, 'only-esp'))).toContain("PC1's probe to PC2 (192.168.2.10) never reached PC2");
    expect(pingAcrossProvider(sim).text).toContain('Sent 5, received 0');
  }, LAB_TEST_TIMEOUT_MS);

  it('wrong answer: R1 matching its own address as the remote identity fails the IKE setup task (W5 fix #12)', () => {
    const sim = labWorld(ccna3IpsecSiteToSite);
    const r1 = (ccna3IpsecSiteToSite.solution?.['R1'] ?? []).map((l) => (l.startsWith('match identity remote address ') ? `match identity remote address ${VPN_R1_PUBLIC} 255.255.255.255` : l));
    expect(r1).toContain(`match identity remote address ${VPN_R1_PUBLIC} 255.255.255.255`);
    typeOn(sim, 'R1', r1);
    typeOn(sim, 'R2', ccna3IpsecSiteToSite.solution?.['R2'] ?? []);
    expect(sim.runToIdle().stopped).toBeUndefined();
    const ike = evaluateLab(sim, ccna3IpsecSiteToSite).results.find((r) => r.task === 'ike-setup')!;
    expect(ike.pass).toBe(false);
    expect(ike.assertions.filter((a) => !a.pass).map((a) => a.detail)).toEqual([
      `No line at R1 crypto.ikev2.profile.SITE-IKE.match.identity.remote.address contains "address ${VPN_R2_PUBLIC}". R1's profile must match R2's public address as the remote identity.`,
    ]);
  }, LAB_TEST_TIMEOUT_MS);

  it('the remote identity written without its host mask passes the IKE setup task too (W5 fix #12)', () => {
    const sim = labWorld(ccna3IpsecSiteToSite);
    for (const [name, peer] of [['R1', VPN_R2_PUBLIC], ['R2', VPN_R1_PUBLIC]] as const) {
      const lines = (ccna3IpsecSiteToSite.solution?.[name] ?? []).map((l) => (l.startsWith('match identity remote address ') ? `match identity remote address ${peer}` : l));
      expect(lines).toContain(`match identity remote address ${peer}`);
      typeOn(sim, name, lines);
    }
    expect(sim.runToIdle().stopped).toBeUndefined();
    expect(failingAssertions(sim, ccna3IpsecSiteToSite)).toEqual([]);
  }, LAB_TEST_TIMEOUT_MS);

  it('wrong answer: a profile without its two authentication lines fails the IKE setup task (W5 fix #12)', () => {
    const sim = labWorld(ccna3IpsecSiteToSite);
    for (const name of ['R1', 'R2']) typeOn(sim, name, (ccna3IpsecSiteToSite.solution?.[name] ?? []).filter((l) => !l.startsWith('authentication ')));
    expect(sim.runToIdle().stopped).toBeUndefined();
    const ike = evaluateLab(sim, ccna3IpsecSiteToSite).results.find((r) => r.task === 'ike-setup')!;
    expect(ike.pass).toBe(false);
    expect(ike.assertions.filter((a) => !a.pass).length).toBe(4);
  }, LAB_TEST_TIMEOUT_MS);

  it('R1 configured first and R2 several seconds later: the SA comes up within about a second of R2 (W5 fix #13)', () => {
    for (const lagNs of [500 * 1_000_000, 2 * SEC, 7.5 * SEC, 10 * SEC]) {
      const sim = labWorld(ccna3IpsecSiteToSite);
      typeOn(sim, 'R1', ccna3IpsecSiteToSite.solution?.['R1'] ?? []);
      sim.runFor(lagNs);
      typeOn(sim, 'R2', ccna3IpsecSiteToSite.solution?.['R2'] ?? []);
      const landed = sim.now;
      let upAt: number | undefined;
      for (let i = 0; i < 400 && upAt === undefined; i++) {
        sim.runFor(50 * 1_000_000);
        const sa = (name: string) => sim.device(idOf(sim, name))!.tables.get<IpsecSaRow>('ipsec-sa')?.rows()[0]?.state;
        if (sa('R1') === 'established' && sa('R2') === 'established') upAt = sim.now;
      }
      expect(upAt, `R2 configured ${lagNs / SEC} s after R1`).toBeDefined();
      expect(upAt! - landed, `R2 configured ${lagNs / SEC} s after R1`).toBeLessThanOrEqual(1 * SEC);
    }
  }, LAB_TEST_TIMEOUT_MS * 2);

  it('wrong answer: IKE configured but the tunnel left unprotected still sends plain GRE through the ISP', () => {
    const sim = labWorld(ccna3IpsecSiteToSite);
    for (const name of ['R1', 'R2']) {
      const lines = (ccna3IpsecSiteToSite.solution?.[name] ?? []).filter((l) => !l.startsWith('tunnel '));
      typeOn(sim, name, lines);
    }
    expect(sim.runToIdle().stopped).toBeUndefined();
    const status = evaluateLab(sim, ccna3IpsecSiteToSite);
    expect(Object.fromEntries(status.results.map((r) => [r.task, r.pass]))).toEqual({
      'ike-setup': true,
      'protect-tunnel': false,
      'sa-established': false,
      'only-esp': false,
    });
    expect(detailOf(sim, ccna3IpsecSiteToSite, 'only-esp', 0)).toBe('');
    expect(detailOf(sim, ccna3IpsecSiteToSite, 'only-esp', pathIndexOf(ccna3IpsecSiteToSite, 'only-esp'))).toContain('inside a GRE tunnel, not inside a');
    const { text, atIsp } = pingAcrossProvider(sim);
    expect(text).toContain('Sent 5, received 5, lost 0 (0% loss)');
    for (const l of atIsp) expect(l.pdu.tunnel).toBe('gre');
  }, LAB_TEST_TIMEOUT_MS);
});
