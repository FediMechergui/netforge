/**
 * P1 W6 sim: `evaluateLab` (ARCHITECTURE-P1 §4.13; contracts/scenario.ts `EvaluateLab`, `LabAssertion`).
 *
 * The labs graded here are built in the test, not imported from the catalogue, so each assertion kind is checked on
 * its own — passing, failing, and pointed at something that does not exist. The world is a real booted PC–router–PC
 * lab whose state came from real traffic. Checked: every assertion kind, the scoring of a partly solved lab, that
 * an unknown name fails instead of throwing, and that a `connectivity` check runs entirely in the disposable clone
 * (the live simulation's clock and trace head are the same before and after).
 */
import { describe, expect, it } from 'vitest';
import type { LabAssertion, LabTask, ScenarioInfo } from '../src/contracts/scenario.js';
import type { Simulation } from '../src/contracts/simulation.js';
import { LAB_PING_COUNT, evaluateLab } from '../src/sim/lab-checks.js';
import { pcRouterPc, twoPcsAndSwitch } from '../src/sim/scenarios.js';
import { booted, ping } from './sim.harness.js';

/** R1 as the lab's DHCP pool and name server (only the by-name check needs them). */
const ROUTER_SERVICES: readonly string[] = [
  'ip dhcp excluded-address 10.0.0.200 10.0.0.254',
  'ip dhcp pool LAN',
  'network 10.0.0.0 255.255.255.0',
  'default-router 10.0.0.254',
  'dns-server 10.0.0.254',
  'exit',
  'ip dns server',
  'ip host www.lab.nf 10.0.1.1',
];

function configured(sim: Simulation, device: string, lines: readonly string[]): void {
  const r = sim.configure(device, lines);
  if (!r.ok) throw new Error(`${device} setup failed: ${JSON.stringify(r.lines.filter((l) => !l.ok))}`);
}

/** A booted PC–router–PC lab that has already carried a ping, so counters, tables and trace are populated. */
function world(seed = 9): Simulation {
  const sim = booted(pcRouterPc(), seed);
  ping(sim, 'pc1', '10.0.1.1');
  return sim;
}

/** A lab whose single task carries `assertions`. */
function labWith(assertions: readonly LabAssertion[], points = 10): ScenarioInfo {
  const task: LabTask = { id: 'only', title: 'Only task', description: 'One task', points, assertions };
  return { name: 'check-demo', title: 'Check demo', description: 'A lab built by the test', category: 'ccna1-lab', build: pcRouterPc, tasks: [task] };
}

/** Evaluate one assertion against `sim`. */
function one(sim: Simulation, a: LabAssertion): { pass: boolean; detail?: string } {
  const status = evaluateLab(sim, labWith([a]));
  expect(status.lab).toBe('check-demo');
  expect(status.checkedAt).toBe(sim.now);
  return status.results[0]!.assertions[0]!;
}

describe('evaluateLab: static assertions', () => {
  it('config reads the running-config AST by dotted path', () => {
    const sim = world();
    expect(one(sim, { kind: 'config', device: 'PC1', path: 'interface.GigabitEthernet0.ip.address', equals: ['10.0.0.1', '255.255.255.0'] }).pass).toBe(true);
    expect(one(sim, { kind: 'config', device: 'PC1', path: 'ip.default-gateway', equals: '10.0.0.254' }).pass).toBe(true);
    expect(one(sim, { kind: 'config', device: 'R1', path: 'hostname', exists: true }).pass).toBe(true);
    expect(one(sim, { kind: 'config', device: 'R1', path: 'router.ospf', exists: false }).pass).toBe(true);
    expect(one(sim, { kind: 'config', device: 'R1', path: 'interface.GigabitEthernet0/0.ip.address', contains: '10.0.0.254' }).pass).toBe(true);

    const wrong = one(sim, { kind: 'config', device: 'PC1', path: 'ip.default-gateway', equals: '10.0.0.9' });
    expect(wrong.pass).toBe(false);
    expect(wrong.detail).toContain('10.0.0.254');
    expect(one(sim, { kind: 'config', device: 'PC1', path: 'router.ospf', exists: true }).pass).toBe(false);
    expect(one(sim, { kind: 'config', device: 'PC1', path: 'hostname', contains: 'R9' }).pass).toBe(false);
  });

  it('port reads the live port state', () => {
    const sim = world();
    expect(one(sim, { kind: 'port', device: 'PC1', port: 'GigabitEthernet0', field: 'operUp', equals: true }).pass).toBe(true);
    expect(one(sim, { kind: 'port', device: 'PC1', port: 'Gi0', field: 'adminUp', equals: true }).pass).toBe(true);
    expect(one(sim, { kind: 'port', device: 'PC1', port: 'Gi0', field: 'ipv4', equals: '10.0.0.1' }).pass).toBe(true);
    expect(one(sim, { kind: 'port', device: 'PC1', port: 'Gi0', field: 'ipv4', equals: '10.0.0.1/24' }).pass).toBe(true);
    expect(one(sim, { kind: 'port', device: 'PC1', port: 'Gi0', field: 'duplex', equals: 'full' }).pass).toBe(true);
    expect(one(sim, { kind: 'port', device: 'R1', port: 'Gi0/1', field: 'role', equals: 'routed' }).pass).toBe(true);

    const wrong = one(sim, { kind: 'port', device: 'PC1', port: 'Gi0', field: 'ipv4', equals: '10.9.9.9' });
    expect(wrong.pass).toBe(false);
    expect(wrong.detail).toContain('10.0.0.1/24');
    expect(one(sim, { kind: 'port', device: 'PC1', port: 'Gi0', field: 'ipv6', equals: '2001:db8::1' }).pass).toBe(false);
  });

  it('table filters the rows of a device table', () => {
    const sim = world();
    expect(one(sim, { kind: 'table', device: 'R1', table: 'rib', where: { network: '10.0.1.0', source: 'C' }, exists: true }).pass).toBe(true);
    expect(one(sim, { kind: 'table', device: 'PC1', table: 'arp', where: { ip: '10.0.0.254' }, exists: true }).pass).toBe(true);
    expect(one(sim, { kind: 'table', device: 'R1', table: 'rib', where: { network: '192.168.99.0' }, exists: false }).pass).toBe(true);

    const wrong = one(sim, { kind: 'table', device: 'R1', table: 'rib', where: { network: '192.168.99.0' }, exists: true });
    expect(wrong.pass).toBe(false);
    expect(wrong.detail).toContain('network=192.168.99.0');
  });

  it('process reads a daemon StateView by path', () => {
    const sim = world();
    expect(one(sim, { kind: 'process', device: 'PC2', process: 'icmpv4', path: 'repliesSent', equals: 5 }).pass).toBe(true);
    expect(one(sim, { kind: 'process', device: 'PC1', process: 'icmpv4', path: 'jobs.0.session', equals: 'gone' }).pass).toBe(false);
    const wrong = one(sim, { kind: 'process', device: 'PC2', process: 'icmpv4', path: 'repliesSent', equals: 99 });
    expect(wrong.pass).toBe(false);
    expect(wrong.detail).toContain('expected 99');
  });

  it('process addresses a list entry by field, not only by index', () => {
    // List order follows what the student did, so a lab names the entry it means.
    const sim = booted(pcRouterPc(), 9);
    configured(sim, 'r1', ROUTER_SERVICES);
    configured(sim, 'pc1', ['ip address dhcp']);
    sim.runToIdle();
    expect(one(sim, { kind: 'process', device: 'PC1', process: 'dhcp-client', path: 'clients.iface=GigabitEthernet0.state', equals: 'BOUND' }).pass).toBe(true);
    const absent = one(sim, { kind: 'process', device: 'PC1', process: 'dhcp-client', path: 'clients.iface=Wlan0.state', equals: 'BOUND' });
    expect(absent.pass).toBe(false);
    expect(absent.detail).toContain('not set');
  });

  it('link finds the cable between two devices', () => {
    const sim = world();
    expect(one(sim, { kind: 'link', a: 'PC1', b: 'R1', up: true }).pass).toBe(true);
    expect(one(sim, { kind: 'link', a: 'R1', b: 'PC1' }).pass).toBe(true);
    expect(one(sim, { kind: 'link', a: 'PC1', b: 'PC2' }).pass).toBe(false);

    sim.removeLink('l_pc1_r1');
    sim.runToIdle();
    const gone = one(sim, { kind: 'link', a: 'PC1', b: 'R1', up: true });
    expect(gone.pass).toBe(false);
    expect(gone.detail).toContain('not connected');
  });

  it('counter compares a port counter', () => {
    const sim = world();
    expect(one(sim, { kind: 'counter', device: 'PC1', port: 'Gi0', counter: 'outPackets', op: 'gt', value: 0 }).pass).toBe(true);
    expect(one(sim, { kind: 'counter', device: 'PC1', port: 'Gi0', counter: 'crcErrors', op: 'eq', value: 0 }).pass).toBe(true);
    // A P0.5 counter that was never created reads 0.
    expect(one(sim, { kind: 'counter', device: 'PC1', port: 'Gi0', counter: 'lateCollisions', op: 'lt', value: 1 }).pass).toBe(true);
    const wrong = one(sim, { kind: 'counter', device: 'PC1', port: 'Gi0', counter: 'outPackets', op: 'lt', value: 1 });
    expect(wrong.pass).toBe(false);
    expect(wrong.detail).toContain('fewer than 1');
  });

  it('traceSeen counts matching events in the retained ring', () => {
    const sim = world();
    expect(one(sim, { kind: 'traceSeen', filter: { kinds: ['frameTx'], protos: ['icmpv4'] }, min: 10 }).pass).toBe(true);
    const wrong = one(sim, { kind: 'traceSeen', filter: { kinds: ['frameTx'], protos: ['dhcp'] } });
    expect(wrong.pass).toBe(false);
    expect(wrong.detail).toContain('0 matching');
  });
});

describe('evaluateLab: unknown names never throw', () => {
  it('reports what could not be found', () => {
    const sim = world();
    const cases: LabAssertion[] = [
      { kind: 'config', device: 'NOPE', path: 'hostname', exists: true },
      { kind: 'port', device: 'PC1', port: 'GigabitEthernet9', field: 'operUp', equals: true },
      { kind: 'table', device: 'PC1', table: 'no-such-table', where: {}, exists: true },
      { kind: 'process', device: 'PC1', process: 'bgp', path: 'x', equals: 1 },
      { kind: 'link', a: 'PC1', b: 'NOPE' },
      { kind: 'counter', device: 'NOPE', port: 'Gi0', counter: 'inPackets', op: 'gt', value: 0 },
      { kind: 'connectivity', from: 'PC1', to: 'NOPE', expect: 'success' },
    ];
    for (const a of cases) {
      const r = one(sim, a);
      expect(r.pass).toBe(false);
      expect(r.detail).toBeTruthy();
    }
  });
});

describe('evaluateLab: connectivity', () => {
  it('pings in a disposable clone and leaves the live simulation untouched', () => {
    const sim = world();
    const now = sim.now;
    const head = sim.trace(0).next;
    const pdus = sim.snapshot().pduCount;

    expect(one(sim, { kind: 'connectivity', from: 'PC1', to: 'PC2', expect: 'success' }).pass).toBe(true);

    expect(sim.now).toBe(now);
    expect(sim.trace(0).next).toBe(head);
    expect(sim.snapshot().pduCount).toBe(pdus);
  });

  it('a broken path fails a success check and satisfies a fail check', () => {
    const sim = world();
    sim.removeLink('l_r1_pc2');
    sim.runToIdle();
    const failed = one(sim, { kind: 'connectivity', from: 'PC1', to: 'PC2', expect: 'success' });
    expect(failed.pass).toBe(false);
    expect(failed.detail).toContain('no reply');
    expect(one(sim, { kind: 'connectivity', from: 'PC1', to: 'PC2', expect: 'fail' }).pass).toBe(true);
  });

  it('byName pings a DNS name through the lab name server', () => {
    const sim = booted(pcRouterPc(), 9);
    configured(sim, 'r1', ROUTER_SERVICES);
    configured(sim, 'pc1', ['ip address dhcp']);
    sim.runToIdle();
    expect(one(sim, { kind: 'connectivity', from: 'PC1', to: 'www.lab.nf', byName: true, expect: 'success' }).pass).toBe(true);
    const unknown = one(sim, { kind: 'connectivity', from: 'PC1', to: 'nowhere.lab.nf', byName: true, expect: 'success' });
    expect(unknown.pass).toBe(false);
    expect(one(sim, { kind: 'connectivity', from: 'PC1', to: 'www.lab.nf', byName: true, family: 6, expect: 'success' }).detail).toContain('IPv4');
  });

  it('counts the reply that completes the job, not only the ones sampled before it', () => {
    // icmpv4 deletes a job in the same dispatch that receives its last reply, so sampling the StateView alone tops
    // out one reply short: with LAB_PING_COUNT = 2 a world that loses the first probe would read as unreachable.
    const sim = world();
    const detail = one(sim, { kind: 'connectivity', from: 'PC1', to: 'PC2', expect: 'fail' }).detail;
    expect(detail).toContain(`${LAB_PING_COUNT} of ${LAB_PING_COUNT} replied`);
  });

  it('grades a lossy path by whether anything replied at all', () => {
    // Seeds where the first echo is lost and only the second is answered (50 % loss on PC2's cable).
    for (const seed of [6, 7, 11, 12, 13, 22, 30]) {
      const sim = booted(twoPcsAndSwitch(), seed);
      sim.runToIdle();
      sim.setImpairments('l_pc2_sw1', { lossPct: 50 });
      expect(one(sim, { kind: 'connectivity', from: 'PC1', to: 'PC2', expect: 'success' }).pass, `seed ${seed}`).toBe(true);
    }
  });

  it('re-cuts the live world’s cut cables in the clone', () => {
    // A cut is runtime state that TopologyLink cannot carry, so an unrepaired copy would grade a broken world as
    // reachable — the clone has to re-apply it.
    const sim = world();
    sim.injectFault(sim.now, { id: 'cut-1', kind: 'cable-cut', target: { link: 'l_pc1_r1' } });
    sim.runToIdle();
    expect(sim.link('l_pc1_r1')?.downReason).toBe('cut');
    const failed = one(sim, { kind: 'connectivity', from: 'PC1', to: 'PC2', expect: 'success' });
    expect(failed.pass).toBe(false);
    expect(one(sim, { kind: 'connectivity', from: 'PC1', to: 'PC2', expect: 'fail' }).pass).toBe(true);
  });

  it('refuses a target that is the pinging device’s own address', () => {
    // A host always answers itself, so a duplicated address would otherwise score a task about reaching PC2.
    const sim = world();
    configured(sim, 'pc2', ['ip address 10.0.0.1 255.255.255.0']);
    sim.runToIdle();
    const r = one(sim, { kind: 'connectivity', from: 'PC1', to: 'PC2', expect: 'success' });
    expect(r.pass).toBe(false);
    expect(r.detail).toContain('10.0.0.1');
  });
});

describe('evaluateLab: scoring', () => {
  it('a partly solved lab keeps the points of the tasks that pass', () => {
    const sim = world();
    const lab: ScenarioInfo = {
      name: 'partial',
      title: 'Partly solved',
      description: 'Two tasks, one of them wrong',
      category: 'ccna1-lab',
      build: pcRouterPc,
      tasks: [
        { id: 'addressing', title: 'Addressing', description: 'PC1 carries its lab address', points: 6, assertions: [{ kind: 'port', device: 'PC1', port: 'Gi0', field: 'ipv4', equals: '10.0.0.1' }] },
        {
          id: 'routing',
          title: 'Routing',
          description: 'A route that was never configured',
          points: 4,
          assertions: [
            { kind: 'table', device: 'R1', table: 'rib', where: { network: '10.0.1.0' }, exists: true },
            { kind: 'table', device: 'R1', table: 'rib', where: { network: '172.16.0.0' }, exists: true },
          ],
        },
      ],
    };
    const status = evaluateLab(sim, lab);
    expect(status.total).toBe(10);
    expect(status.score).toBe(6);
    expect(status.results.map((r) => [r.task, r.pass, r.points])).toEqual([
      ['addressing', true, 6],
      ['routing', false, 0],
    ]);
    // Only the second assertion of the failing task is at fault, and it says why.
    expect(status.results[1]!.assertions.map((a) => a.pass)).toEqual([true, false]);
    expect(status.results[1]!.assertions[1]!.detail).toContain('172.16.0.0');
  });

  it('a lab without tasks scores nothing and reports nothing', () => {
    const sim = world();
    const status = evaluateLab(sim, { name: 'empty', title: 'Empty', description: 'No tasks', category: 'ccna1-lab', build: pcRouterPc });
    expect(status).toEqual({ lab: 'empty', checkedAt: sim.now, score: 0, total: 0, results: [] });
  });
});
