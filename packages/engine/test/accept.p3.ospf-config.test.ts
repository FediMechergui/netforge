/**
 * P3 acceptance — OSPF configuration typed on real consoles (ARCHITECTURE-P3 §10.1 `accept.p3.ospf-config`; D7, §4.5,
 * §5.1, §5.8, §2.10; rule 20; §7 W4 qa).
 *
 * Every line below is typed in a console session (the real grammar and handlers), never stored behind the CLI's back.
 * Pinned:
 *   • passive interfaces send no hello but are advertised (`passive-interface <if>`, and `passive-interface default`
 *     with `no passive-interface <if>`);
 *   • a loopback is advertised as a /32 host route unless `ip ospf network point-to-point`;
 *   • `auto-cost reference-bandwidth 1000` gives GigE 1 and FastE (a port running at 100 Mb/s) 10, with its note;
 *   • `bandwidth` and `ip ospf cost` on a routed GigE port (the widened grammar): the cost, its source and the
 *     neighbour's route metric follow;
 *   • the router id order (`router-id` > the highest up loopback > the highest up interface address); a later
 *     `router-id` prints the "after clear" message, `show ip ospf` names the waiting id, and `fact ospf.routerId` reads
 *     the id in use until `clear ip ospf process` (confirmed) applies the new one;
 *   • `router ospf` refused under `no ip routing` (a router and a multilayer switch) with `ospfNeedsIpRouting`;
 *   • a second process refused with `ospfOneProcess`, nothing stored.
 * Worlds: `staged.world` at stage P3 with the flip's daemons (ospf.accept.harness.ts).
 */
import { describe, expect, it } from 'vitest';
import { CLI_MESSAGES, type CliResult } from '../src/contracts/cli.js';
import type { DeviceId } from '../src/contracts/ids.js';
import type { LabAssertion, LabCheckResult, ScenarioInfo } from '../src/contracts/scenario.js';
import type { Simulation } from '../src/contracts/simulation.js';
import { SEC } from '../src/contracts/time.js';
import { TOPOLOGY_SCHEMA_ID } from '../src/contracts/topology.js';
import type { TraceEvent } from '../src/contracts/trace.js';
import { MSG_REFERENCE_NOTE } from '../src/cli/handlers/ospf.js';
import { evaluateLab } from '../src/sim/lab-checks.js';
import { acceptWorld, showLines, traceSince, typed } from './ospf.accept.harness.js';
import { cursor, GI0, GI1, ifRow, lsdbRows, nbrRows, ospfRoutes, ospfView, ribRow } from './ospf.harness.js';

const MASK24 = '255.255.255.0';

/** A booted NF-2911 `name` with only a hostname (everything else is typed). */
function router(sim: Simulation, id: DeviceId, name: string): void {
  sim.addDevice({ id, type: 'router.nf2911', name, startupConfig: `hostname ${name}\n!\nend\n` });
}

/** Type `lines` in configuration mode on `device`; every line must be accepted (no error). Returns the results. */
function conf(sim: Simulation, device: DeviceId, lines: readonly string[]): CliResult[] {
  const res = typed(sim, device, ['configure terminal', ...lines, 'end']);
  res.forEach((r, k) => expect(r.error, `${device}: ${['configure terminal', ...lines, 'end'][k]} → ${r.output}`).toBeUndefined());
  return res.slice(1, -1);
}

/** An interface section typed as lines. */
const ifLines = (port: string, address: string, mask: string, extra: readonly string[] = []): string[] => [`interface ${port}`, `ip address ${address} ${mask}`, ...extra, 'no shutdown', 'exit'];

/** The running configuration's `router ospf 1` section. */
function ospfSection(sim: Simulation, d: DeviceId): string[] {
  const text = sim.device(d)!.running.render().split('\n');
  const at = text.indexOf('router ospf 1');
  if (at === -1) return [];
  const out = [text[at]!];
  for (let i = at + 1; i < text.length && text[i]!.startsWith(' '); i++) out.push(text[i]!);
  return out;
}

/** OSPF hellos that left `device` out of `port` (one per receiver leg). */
const hellosOut = (evs: readonly TraceEvent[], device: DeviceId, port: string) =>
  evs.filter((e) => e.kind === 'frameTx' && e.from.device === device && e.from.port === port && e.pdu.summary.startsWith('OSPF hello'));

/** Grade one `fact` assertion live (rule 20: tables only). */
function factPasses(sim: Simulation, a: Extract<LabAssertion, { kind: 'fact' }>): boolean {
  const lab: ScenarioInfo = {
    name: 'ospf-config-fact',
    title: 'Router id',
    description: 'A lab built by the test',
    category: 'ccna2-lab',
    build: () => ({ schema: TOPOLOGY_SCHEMA_ID, seed: 1, devices: [], links: [] }),
    tasks: [{ id: 'only', title: 'Only task', description: 'One task', points: 10, assertions: [a] }],
  };
  return evaluateLab(sim, lab).results[0]!.assertions.map((r: LabCheckResult['assertions'][number]) => r.pass)[0]!;
}

/** R1 Gi0/0 – R2 Gi0/0 (10.0.12.0/24), R1 Gi0/1 to PC1 (10.1.0.0/24); both routers booted, nothing of OSPF typed yet. */
function pair(seed: number): Simulation {
  const sim = acceptWorld(seed);
  router(sim, 'r1', 'R1');
  router(sim, 'r2', 'R2');
  sim.addDevice({ id: 'pc1', type: 'pc.nfpc', name: 'PC1', startupConfig: 'hostname PC1\n!\ninterface GigabitEthernet0\n ip address 10.1.0.10 255.255.255.0\n!\nip default-gateway 10.1.0.1\n!\nend\n' });
  sim.addLink({ a: { device: 'r1', port: GI0 }, b: { device: 'r2', port: GI0 } });
  sim.addLink({ a: { device: 'r1', port: GI1 }, b: { device: 'pc1', port: 'GigabitEthernet0' } });
  sim.runFor(90 * SEC);
  conf(sim, 'r1', [...ifLines(GI0, '10.0.12.1', MASK24), ...ifLines(GI1, '10.1.0.1', MASK24)]);
  conf(sim, 'r2', [...ifLines(GI0, '10.0.12.2', MASK24), 'router ospf 1', 'router-id 2.2.2.2', 'network 10.0.0.0 0.255.255.255 area 0']);
  return sim;
}

describe('accept.p3.ospf-config: passive interfaces and loopbacks', () => {
  it('a passive interface sends no hello but is advertised; `passive-interface default` with `no passive-interface`', () => {
    const sim = pair(71);
    conf(sim, 'r1', ['router ospf 1', 'router-id 1.1.1.1', 'passive-interface GigabitEthernet0/1', 'network 10.0.0.0 0.255.255.255 area 0']);
    const c = cursor(sim);
    expect(sim.runToIdle().stopped).toBeUndefined();
    sim.runFor(60 * SEC);
    let evs = traceSince(sim, c);
    expect(hellosOut(evs, 'r1', GI1)).toEqual([]);
    expect(hellosOut(evs, 'r1', GI0).length).toBeGreaterThan(0);
    expect(ifRow(sim, 'r1', GI1)).toMatchObject({ passive: true, neighbors: 0 });
    expect(sim.device('r1')!.portView(GI1)!.l3.groups4 ?? []).not.toContain('224.0.0.5');
    // advertised: a stub link in R1's router-LSA, and R2's route
    expect(lsdbRows(sim, 'r2').find((r) => r.key === '0.0.0.0|1|1.1.1.1|1.1.1.1')!.links).toContainEqual({ kind: 'stub', id: '10.1.0.0', data: MASK24, metric: 1 });
    expect(showLines(sim, 'r2', 'show ip route').find((l) => l.includes(' 10.1.0.0/24 '))).toBe('O    10.1.0.0/24  via 10.0.12.1 [110/2] GigabitEthernet0/0');
    // passive-interface default, with Gi0/0 taken out of it: the same outcome, stored as typed
    conf(sim, 'r1', ['router ospf 1', 'no passive-interface GigabitEthernet0/1', 'passive-interface default', 'no passive-interface GigabitEthernet0/0']);
    expect(ospfSection(sim, 'r1')).toEqual([
      'router ospf 1',
      ' router-id 1.1.1.1',
      ' passive-interface default',
      ' no passive-interface GigabitEthernet0/0',
      ' network 10.0.0.0 0.255.255.255 area 0',
    ]);
    const c2 = cursor(sim);
    sim.runFor(60 * SEC);
    evs = traceSince(sim, c2);
    expect(hellosOut(evs, 'r1', GI1)).toEqual([]);
    expect(hellosOut(evs, 'r1', GI0).length).toBeGreaterThan(0);
    expect(ifRow(sim, 'r1', GI1)!.passive).toBe(true);
    expect(ifRow(sim, 'r1', GI0)!.passive).toBe(false);
    expect(ribRow(sim, 'r2', '10.1.0.0/24')).toMatchObject({ source: 'O', metric: 2 });
  });

  it('a loopback is a /32 host route unless `ip ospf network point-to-point`', () => {
    const sim = pair(72);
    conf(sim, 'r1', [
      ...ifLines('Loopback0', '10.10.10.1', MASK24),
      ...ifLines('Loopback1', '10.20.20.1', MASK24, ['ip ospf network point-to-point']),
      'router ospf 1',
      'router-id 1.1.1.1',
      'network 10.0.0.0 0.255.255.255 area 0',
    ]);
    expect(sim.runToIdle().stopped).toBeUndefined();
    expect(ifRow(sim, 'r1', 'Loopback0')).toMatchObject({ networkType: 'loopback', state: 'loopback', cost: 1 });
    expect(ifRow(sim, 'r1', 'Loopback1')).toMatchObject({ networkType: 'point-to-point', state: 'point-to-point' });
    const out = showLines(sim, 'r2', 'show ip route');
    expect(out.find((l) => l.includes(' 10.10.10.'))).toBe('O    10.10.10.1/32  via 10.0.12.1 [110/2] GigabitEthernet0/0');
    expect(out.find((l) => l.includes(' 10.20.20.'))).toBe('O    10.20.20.0/24  via 10.0.12.1 [110/2] GigabitEthernet0/0');
    expect(ribRow(sim, 'r2', '10.10.10.0/24')).toBeUndefined();
  });
});

describe('accept.p3.ospf-config: costs', () => {
  it('`auto-cost reference-bandwidth 1000`: GigE 1, FastE (100 Mb/s) 10, with the note; the default reference gives both 1', () => {
    const sim = acceptWorld(73);
    router(sim, 'r1', 'R1');
    router(sim, 'r2', 'R2');
    sim.addDevice({ id: 'sw1', type: 'switch.nfc2960', name: 'SW1', startupConfig: 'hostname SW1\n!\ninterface FastEthernet0/1\n spanning-tree portfast\n!\nend\n' });
    sim.addLink({ a: { device: 'r1', port: GI0 }, b: { device: 'r2', port: GI0 } });
    sim.addLink({ a: { device: 'r1', port: GI1 }, b: { device: 'sw1', port: 'FastEthernet0/1' } });
    sim.runFor(90 * SEC);
    conf(sim, 'r1', [...ifLines(GI0, '10.0.12.1', MASK24), ...ifLines(GI1, '10.1.0.1', MASK24), 'router ospf 1', 'router-id 1.1.1.1', 'network 10.0.0.0 0.255.255.255 area 0']);
    expect(sim.runToIdle().stopped).toBeUndefined();
    expect(sim.device('r1')!.portView(GI1)!.speedBps).toBe(100_000_000);
    expect([ifRow(sim, 'r1', GI0)!.cost, ifRow(sim, 'r1', GI1)!.cost]).toEqual([1, 1]);
    const [, note] = conf(sim, 'r1', ['router ospf 1', 'auto-cost reference-bandwidth 1000']);
    expect(note!.output).toContain(MSG_REFERENCE_NOTE);
    sim.runFor(SEC);
    expect(ifRow(sim, 'r1', GI0)).toMatchObject({ cost: 1, costSource: 'bandwidth' });
    expect(ifRow(sim, 'r1', GI1)).toMatchObject({ cost: 10, costSource: 'bandwidth' });
    expect(ospfView(sim, 'r1').process!.referenceBandwidthMbps).toBe(1000);
    const brief = showLines(sim, 'r1', 'show ip ospf interface brief');
    expect(brief.find((l) => l.startsWith('Gi0/0 '))!.split(/ +/)[4]).toBe('1');
    expect(brief.find((l) => l.startsWith('Gi0/1 '))!.split(/ +/)[4]).toBe('10');
    expect(ospfSection(sim, 'r1')).toContain(' auto-cost reference-bandwidth 1000');
  });

  it('`bandwidth` and `ip ospf cost` on a routed GigE port: the cost, its source and the neighbour route metric', () => {
    const sim = pair(74);
    conf(sim, 'r2', [...ifLines('Loopback0', '10.2.0.1', MASK24, ['ip ospf network point-to-point'])]);
    conf(sim, 'r1', ['router ospf 1', 'router-id 1.1.1.1', 'network 10.0.0.0 0.255.255.255 area 0']);
    expect(sim.runToIdle().stopped).toBeUndefined();
    expect(ribRow(sim, 'r1', '10.2.0.0/24')).toMatchObject({ source: 'O', metric: 2 });
    // bandwidth 10000 kb/s on R1 Gi0/0 (the widened grammar): cost 100 000 / 10 000 = 10
    conf(sim, 'r1', ['interface GigabitEthernet0/0', 'bandwidth 10000']);
    sim.runFor(30 * SEC);
    expect(ifRow(sim, 'r1', GI0)).toMatchObject({ cost: 10, costSource: 'bandwidth' });
    expect(ribRow(sim, 'r1', '10.2.0.0/24')).toMatchObject({ source: 'O', metric: 11 });
    // ip ospf cost wins over the bandwidth
    conf(sim, 'r1', ['interface GigabitEthernet0/0', 'ip ospf cost 7']);
    sim.runFor(30 * SEC);
    expect(ifRow(sim, 'r1', GI0)).toMatchObject({ cost: 7, costSource: 'configured' });
    expect(showLines(sim, 'r1', 'show ip route').find((l) => l.includes(' 10.2.0.0/24 '))).toBe('O    10.2.0.0/24  via 10.0.12.2 [110/8] GigabitEthernet0/0');
    const run = sim.device('r1')!.running.render();
    expect(run).toContain('interface GigabitEthernet0/0\n');
    expect(run).toMatch(/interface GigabitEthernet0\/0\n(?: [^\n]*\n)* bandwidth 10000\n/);
    expect(run).toMatch(/interface GigabitEthernet0\/0\n(?: [^\n]*\n)* ip ospf cost 7\n/);
    // the line removed: the bandwidth cost again
    conf(sim, 'r1', ['interface GigabitEthernet0/0', 'no ip ospf cost']);
    sim.runFor(30 * SEC);
    expect(ifRow(sim, 'r1', GI0)).toMatchObject({ cost: 10, costSource: 'bandwidth' });
  });
});

describe('accept.p3.ospf-config: the router id', () => {
  it('the order: router-id > the highest up loopback > the highest up interface address', () => {
    const sim = acceptWorld(75);
    for (const [id, name] of [['r1', 'R1'], ['r2', 'R2'], ['r3', 'R3']] as const) router(sim, id, name);
    sim.addLink({ a: { device: 'r1', port: GI0 }, b: { device: 'r2', port: GI0 } });
    sim.addLink({ a: { device: 'r2', port: GI1 }, b: { device: 'r3', port: GI0 } });
    sim.runFor(90 * SEC);
    // R1: two loopbacks — the higher loopback wins, even over the numerically higher interface address 9.0.0.2
    conf(sim, 'r1', [...ifLines(GI0, '9.0.0.2', MASK24), ...ifLines('Loopback0', '3.3.3.3', '255.255.255.255'), ...ifLines('Loopback1', '8.8.8.8', '255.255.255.255'), 'router ospf 1', 'network 0.0.0.0 255.255.255.255 area 0']);
    // R2: no loopback — the highest up interface address as a number (10.0.0.1 over 9.0.0.1)
    conf(sim, 'r2', [...ifLines(GI0, '9.0.0.1', MASK24), ...ifLines(GI1, '10.0.0.1', MASK24), 'router ospf 1', 'network 0.0.0.0 255.255.255.255 area 0']);
    // R3: router-id over a higher loopback
    conf(sim, 'r3', [...ifLines('Loopback0', '99.99.99.99', '255.255.255.255'), ...ifLines(GI0, '10.0.0.3', MASK24), 'router ospf 1', 'router-id 1.1.1.1', 'network 0.0.0.0 255.255.255.255 area 0']);
    expect(sim.runToIdle().stopped).toBeUndefined();
    expect([ospfView(sim, 'r1').process!.routerId, ospfView(sim, 'r2').process!.routerId, ospfView(sim, 'r3').process!.routerId]).toEqual(['8.8.8.8', '10.0.0.1', '1.1.1.1']);
    expect(ifRow(sim, 'r1', GI0)!.routerId).toBe('8.8.8.8');
    // the ids on the wire: R2 is Full with both, under their ids
    expect(nbrRows(sim, 'r2').map((r) => [r.routerId, r.state]).sort()).toEqual([['1.1.1.1', 'full'], ['8.8.8.8', 'full']]);
  });

  it('a later router-id prints the "after clear" message; fact ospf.routerId reads the id in use until `clear ip ospf process`', () => {
    const sim = pair(76);
    conf(sim, 'r1', [...ifLines('Loopback0', '9.9.9.9', '255.255.255.255'), 'router ospf 1', 'network 10.0.0.0 0.255.255.255 area 0']);
    expect(sim.runToIdle().stopped).toBeUndefined();
    const fact = (equals: string) => factPasses(sim, { kind: 'fact', device: 'R1', fact: 'ospf.routerId', equals });
    expect(ospfView(sim, 'r1').process!.routerId).toBe('9.9.9.9');
    expect([fact('9.9.9.9'), fact('5.5.5.5')]).toEqual([true, false]);
    const [, later] = conf(sim, 'r1', ['router ospf 1', 'router-id 5.5.5.5']);
    expect(later!.output).toContain(CLI_MESSAGES.ospfRouterIdLater);
    sim.runFor(30 * SEC);
    // still the id in use: rows, fact, neighbours
    expect(ifRow(sim, 'r1', GI0)!.routerId).toBe('9.9.9.9');
    expect([fact('9.9.9.9'), fact('5.5.5.5')]).toEqual([true, false]);
    expect(ospfView(sim, 'r1').process).toMatchObject({ routerId: '9.9.9.9', configuredRouterId: '5.5.5.5' });
    expect(showLines(sim, 'r1', 'show ip ospf')).toContain('  Router ID 5.5.5.5 is configured; it is used after "clear ip ospf process" or a reload');
    expect(nbrRows(sim, 'r2').map((r) => r.routerId)).toEqual(['9.9.9.9']);
    // clear ip ospf process, confirmed: the new id applies
    const [ask, yes] = typed(sim, 'r1', ['clear ip ospf process', 'y']);
    expect(ask!.output).toBe('');
    expect(ask!.input).toMatchObject({ kind: 'confirm', prompt: CLI_MESSAGES.clearOspfConfirm });
    expect(yes!.error).toBeUndefined();
    expect(sim.runToIdle().stopped).toBeUndefined();
    expect(ifRow(sim, 'r1', GI0)!.routerId).toBe('5.5.5.5');
    expect([fact('9.9.9.9'), fact('5.5.5.5')]).toEqual([false, true]);
    expect(ospfView(sim, 'r1').process!.configuredRouterId).toBeUndefined();
    expect(nbrRows(sim, 'r2').map((r) => [r.routerId, r.state])).toEqual([['5.5.5.5', 'full']]);
    // a "no" answer restarts nothing
    const [, no] = typed(sim, 'r1', ['clear ip ospf process', 'n']);
    expect(no!.output).toContain('Nothing was restarted.');
    expect(ospfRoutes(sim, 'r2').length).toBeGreaterThan(0);
  });
});

describe('accept.p3.ospf-config: refusals', () => {
  it('`router ospf` is refused under `no ip routing`, on a router and on a multilayer switch (its default)', () => {
    const sim = acceptWorld(77);
    router(sim, 'r1', 'R1');
    sim.addDevice({ id: 'mls', type: 'mlswitch.nfc3650-24', name: 'MLS1', startupConfig: 'hostname MLS1\n!\nend\n' });
    sim.runFor(90 * SEC);
    for (const [d, pre] of [['r1', ['no ip routing']], ['mls', []]] as const) {
      const res = typed(sim, d, ['configure terminal', ...pre, 'router ospf 1']);
      const refused = res.at(-1)!;
      expect(refused.error, d).toBeDefined();
      expect(refused.output, d).toContain(CLI_MESSAGES.ospfNeedsIpRouting);
      expect(refused.mode, d).toBe('config');
      expect(sim.device(d)!.running.render(), d).not.toContain('router ospf');
      // with ip routing back, the same line is accepted
      const ok = typed(sim, d, ['configure terminal', 'ip routing', 'router ospf 1']).at(-1)!;
      expect(ok.error, d).toBeUndefined();
      expect(ok.mode, d).toBe('config-router');
    }
  });

  it('a second process is refused with ospfOneProcess, and nothing is stored', () => {
    const sim = pair(78);
    conf(sim, 'r1', ['router ospf 1', 'router-id 1.1.1.1', 'network 10.0.0.0 0.255.255.255 area 0']);
    expect(sim.runToIdle().stopped).toBeUndefined();
    for (const from of [['configure terminal'], ['configure terminal', 'router ospf 1']]) {
      const second = typed(sim, 'r1', [...from, 'router ospf 2']).at(-1)!;
      expect(second.output).toContain(CLI_MESSAGES.ospfOneProcess.replaceAll('{pid}', '1'));
    }
    const run = sim.device('r1')!.running.render();
    expect(run).not.toContain('router ospf 2');
    expect(run.match(/^router ospf /gm)).toEqual(['router ospf ']);
    expect(ospfView(sim, 'r1').process!.pid).toBe(1);
  });
});
