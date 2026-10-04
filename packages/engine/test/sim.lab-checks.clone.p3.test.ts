/**
 * sim.lab-checks.clone.p3 — the grader clone features of ARCHITECTURE-P3 §2.10 and D5 (§7 W3 sim, moved from W5 so the
 * W4 acceptance rows can use them), on `staged.world` (stage P3, the real acl daemon) with the W2 transport probes:
 *   • `proto: 'tcp' | 'udp'` with `port`: tcp passes on 'open' and fails on a reset, an ICMP unreachable or the timeout;
 *     udp passes when the clone trace shows the datagram consumed on the target and fails on an ICMP unreachable, a
 *     drop or the timeout;
 *   • `droppedAt` / `dropReason` from the clone trace's drops of the probe (expect 'fail' only);
 *   • `toAddress` / `toIface` (a loopback of the target), `source` (an interface or address of `from`);
 *   • `LabFault` `config` (an extended ACL applied in the clone through `configure`) and `cut` by port;
 *   • the clone memo: a memo hit builds no clone and gives the same status; a changed L1 state (a live cut cable, the
 *     export unchanged) misses it; a check that differs from the recorded run rebuilds the clone and replays the earlier
 *     checks first, so the status equals a fresh world's.
 * Each widened member has its right answer and at least one wrong answer with its exact original detail; authoring
 * mistakes fail before any clone is built.
 *
 * World (P3 profile): PC1 192.168.10.10/24 (gateway .1) and PC2 192.168.10.20/24 (NO gateway) on SW1 Fa0/1, Fa0/2
 * (VLAN 1); SRV 192.168.20.100/24 (gateway .1; `ip http server` on TCP 80, `ip dns server` on UDP 53) on SW1 Fa0/3
 * (VLAN 20). R1 Gi0/0 192.168.10.1 to SW1 Gi0/1 (VLAN 1) and R1 Gi0/1 192.168.20.1 to SW1 Gi0/2 (VLAN 20): two cables
 * between SW1 and R1. R1 Loopback0 1.1.1.1/32.
 */
import { describe, expect, it } from 'vitest';
import type { LabAssertion, LabCheckResult, LabStatus, ScenarioInfo } from '../src/contracts/scenario.js';
import type { Simulation } from '../src/contracts/simulation.js';
import { SEC } from '../src/contracts/time.js';
import { TOPOLOGY_SCHEMA_ID } from '../src/contracts/topology.js';
import { createAcl } from '../src/protocols/acl.js';
import { canonicalJson } from '../src/sim/lab-checks/core.js';
import { LAB_CONFIG_FAULT_OPTIONS, LAB_FLOOD_DROP_REASONS, LAB_PROBE_TIMEOUT_MS, evaluateLab, labCloneMemoStats } from '../src/sim/lab-checks.js';
import { accessPort, configText, section, vlanSections } from '../src/sim/scenarios/kit.js';
import { createStagedSimulation } from './staged.world.js';

const SRV = '192.168.20.100';
const MASK24 = '255.255.255.0';

/** The world of the file header, booted and settled. */
function world(seed = 61): Simulation {
  const sim = createStagedSimulation({ seed, stage: 'P3', factories: { acl: createAcl } });
  const host = (name: string, address: string, gateway?: string, extra: readonly string[] = []): string =>
    configText([[`hostname ${name}`], section('interface GigabitEthernet0', [`ip address ${address} ${MASK24}`]), [...(gateway === undefined ? [] : [`ip default-gateway ${gateway}`]), ...extra]]);
  sim.addDevice({ id: 'pc1', type: 'pc.nfpc', name: 'PC1', startupConfig: host('PC1', '192.168.10.10', '192.168.10.1') });
  sim.addDevice({ id: 'pc2', type: 'pc.nfpc', name: 'PC2', startupConfig: host('PC2', '192.168.10.20') });
  sim.addDevice({ id: 'srv', type: 'server.nfserver', name: 'SRV', startupConfig: host('SRV', SRV, '192.168.20.1', ['ip http server', 'ip dns server']) });
  sim.addDevice({
    id: 'sw1',
    type: 'switch.nfc2960',
    name: 'SW1',
    startupConfig: configText([
      ['hostname SW1'],
      ...vlanSections([{ id: 20 }]),
      accessPort('FastEthernet0/1', 1, { portfast: true }),
      accessPort('FastEthernet0/2', 1, { portfast: true }),
      accessPort('FastEthernet0/3', 20, { portfast: true }),
      accessPort('GigabitEthernet0/1', 1, { portfast: true }),
      accessPort('GigabitEthernet0/2', 20, { portfast: true }),
    ]),
  });
  sim.addDevice({
    id: 'r1',
    type: 'router.nf2911',
    name: 'R1',
    startupConfig: configText([
      ['hostname R1'],
      section('interface GigabitEthernet0/0', [`ip address 192.168.10.1 ${MASK24}`, 'no shutdown']),
      section('interface GigabitEthernet0/1', [`ip address 192.168.20.1 ${MASK24}`, 'no shutdown']),
      section('interface Loopback0', ['ip address 1.1.1.1 255.255.255.255']),
    ]),
  });
  sim.addLink({ a: { device: 'pc1', port: 'GigabitEthernet0' }, b: { device: 'sw1', port: 'FastEthernet0/1' } });
  sim.addLink({ a: { device: 'pc2', port: 'GigabitEthernet0' }, b: { device: 'sw1', port: 'FastEthernet0/2' } });
  sim.addLink({ a: { device: 'srv', port: 'GigabitEthernet0' }, b: { device: 'sw1', port: 'FastEthernet0/3' } });
  sim.addLink({ a: { device: 'r1', port: 'GigabitEthernet0/0' }, b: { device: 'sw1', port: 'GigabitEthernet0/1' } });
  sim.addLink({ a: { device: 'r1', port: 'GigabitEthernet0/1' }, b: { device: 'sw1', port: 'GigabitEthernet0/2' } });
  sim.runFor(60 * SEC);
  sim.runToIdle();
  return sim;
}

/** A lab whose single task carries `assertions`. */
function labWith(assertions: readonly LabAssertion[], name = 'clone-demo-p3'): ScenarioInfo {
  return {
    name,
    title: 'Clone demo',
    description: 'A lab built by the test',
    category: 'ccna2-lab',
    build: () => ({ schema: TOPOLOGY_SCHEMA_ID, seed: 1, devices: [], links: [] }),
    tasks: [{ id: 'only', title: 'Only task', description: 'One task', points: 10, assertions }],
  };
}

/** Grade `assertions` in ONE evaluation (one clone host): each verdict, `undefined` for a pass, else its detail. */
function verdicts(sim: Simulation, assertions: readonly LabAssertion[]): (string | undefined)[] {
  return evaluateLab(sim, labWith(assertions)).results[0]!.assertions.map((r: LabCheckResult['assertions'][number]) => (r.pass ? undefined : (r.detail ?? '(no detail)')));
}

/** Everything grading must leave untouched in the live world. */
function fingerprint(sim: Simulation): string {
  return JSON.stringify({ now: sim.now, head: sim.trace(0).next, topo: sim.exportTopology(), snapshot: sim.snapshot() });
}

type Conn = Extract<LabAssertion, { kind: 'connectivity' }>;
const conn = (over: Partial<Conn>): Conn => ({ kind: 'connectivity', from: 'PC1', to: 'SRV', expect: 'success', ...over });

/** The extended list of the config fault: no web from PC1 to SRV, everything else allowed, inbound on R1 Gi0/0. */
const ACL_LINES: readonly string[] = [
  'ip access-list extended NO-WEB',
  ' deny tcp host 192.168.10.10 host 192.168.20.100 eq www',
  ' permit ip any any',
  'interface GigabitEthernet0/0',
  ' ip access-group NO-WEB in',
];

describe('connectivity: tcp and udp probes, droppedAt, dropReason, toAddress, toIface, source (one clone)', () => {
  it('right answers pass and every wrong answer fails with its own detail', () => {
    const sim = world();
    const before = fingerprint(sim);
    const got = verdicts(sim, [
      /* 0 */ conn({ proto: 'tcp', port: 80 }),
      /* 1 */ conn({ proto: 'tcp', port: 80, expect: 'fail' }),
      /* 2 */ conn({ proto: 'tcp', port: 81 }),
      /* 3 */ conn({ proto: 'tcp', port: 81, expect: 'fail' }),
      /* 4 */ conn({ proto: 'udp', port: 53 }),
      /* 5 */ conn({ proto: 'udp', port: 53, expect: 'fail' }),
      /* 6 */ conn({ proto: 'udp', port: 54 }),
      /* 7 */ conn({ proto: 'udp', port: 54, expect: 'fail', droppedAt: 'SRV', dropReason: 'unsupported-protocol' }),
      /* 8 */ conn({ proto: 'udp', port: 54, expect: 'fail', droppedAt: 'R1' }),
      /* 9 */ conn({ proto: 'udp', port: 54, expect: 'fail', dropReason: 'acl-deny' }),
      /* 10 */ conn({ to: 'R1', toAddress: '1.1.1.1' }),
      /* 11 */ conn({ to: 'R1', toIface: 'Loopback0' }),
      /* 12 */ conn({ to: 'R1', toAddress: '9.9.9.9' }),
      /* 13 */ conn({ to: 'R1', toIface: 'Gi0/1', toAddress: '192.168.10.1' }),
      /* 14 */ conn({ to: 'R1', toIface: 'Serial0/0/0' }),
      /* 15 */ conn({ from: 'R1', to: 'PC2', source: 'Loopback0' }),
      /* 16 */ conn({ from: 'R1', to: 'PC2', source: 'Loopback0', expect: 'fail' }),
      /* 17 */ conn({ from: 'R1', to: 'PC2', source: 'GigabitEthernet0/0' }),
      /* 18 */ conn({ from: 'R1', to: 'PC2', source: '1.1.1.1', expect: 'fail' }),
      /* 19 */ conn({ from: 'R1', to: 'PC2', source: '9.9.9.9' }),
      /* 20 */ conn({ from: 'R1', to: 'PC2', source: 'Serial0/0/0' }),
      /* 21 */ conn({ expect: 'fail', droppedAt: 'R1' }),
      /* 22 */ conn({ proto: 'tcp', port: 80, toAddress: SRV, source: '192.168.10.10' }),
      /* 23 */ conn({ proto: 'icmp' }),
    ]);
    expect(got).toEqual([
      undefined,
      `PC1 opened TCP port 80 on ${SRV}, which this task expects to fail.`,
      `PC1 could not open TCP port 81 on ${SRV}: the port is closed (it answered with a reset).`,
      undefined,
      undefined,
      `PC1's UDP datagram reached a listener on port 53 of ${SRV}, which this task expects to fail.`,
      `PC1's UDP datagram to ${SRV} port 54 reached no listener: an ICMP unreachable came back (type 3, code 3).`,
      undefined,
      `PC1's probe to ${SRV} was dropped at SRV (unsupported-protocol); expected a drop at R1.`,
      `PC1's probe to ${SRV} was dropped at SRV (unsupported-protocol); expected a drop (acl-deny).`,
      undefined,
      undefined,
      'R1 does not hold 9.9.9.9.',
      'R1 Gi0/1 does not hold 192.168.10.1.',
      'R1 Serial0/0/0 has no IPv4 address to be reached at.',
      // PC2 has no gateway, so it cannot answer the loopback source; from Gi0/0's own subnet it can
      'R1 got no reply from 192.168.10.20 (2 echo requests sent).',
      undefined,
      undefined,
      undefined,
      'R1 does not hold 9.9.9.9.',
      'R1 Serial0/0/0 has no IPv4 address to send from.',
      // a drop is graded only for a probe that failed: the ping answered
      `PC1 reached ${SRV} (2 of 2 replied), which this task expects to fail.`,
      undefined,
      undefined,
    ]);
    // grading is read-only
    expect(fingerprint(sim)).toBe(before);
    expect(LAB_PROBE_TIMEOUT_MS).toBe(3000);
    expect(LAB_FLOOD_DROP_REASONS).toEqual(['not-for-me', 'stp-discarding']);
  });

  it('authoring mistakes fail in the live world before any clone is built', () => {
    const sim = world();
    const got = verdicts(sim, [
      conn({ proto: 'tcp' }),
      conn({ proto: 'udp', port: 70_000 }),
      conn({ port: 80 }),
      conn({ proto: 'tcp', port: 80, to: 'srv.lab', byName: true }),
      conn({ dropReason: 'acl-deny' }),
      conn({ expect: 'fail', droppedAt: 'R9' }),
      conn({ to: 'R1', toIface: 'Gi9/9' }),
      conn({ to: 'R1', toAddress: 'banana' }),
      conn({ to: 'srv.lab', byName: true, toAddress: SRV }),
      conn({ source: 'Gi9/9' }),
      conn({ proto: 'quic' as 'tcp', port: 443 }),
      conn({ after: [{ cut: { a: 'SW1', b: 'R1', aPort: 'Gi9/9' } }] }),
      conn({ after: [{ cut: { a: 'SW1', b: 'R1', aPort: 'Fa0/1' } }] }),
      conn({ after: [{ config: { device: 'R9', lines: ['no ip routing'] } }] }),
      conn({ after: [{ config: { device: 'R1', lines: 'no ip routing' as unknown as string[] } }] }),
    ]);
    expect(got).toEqual([
      'A TCP connectivity check needs a port from 1 to 65535.',
      'A UDP connectivity check needs a port from 1 to 65535.',
      'A port belongs to a TCP or UDP connectivity check, not to a ping.',
      'A TCP connectivity check needs an address; it cannot look a name up.',
      'Where or why a packet is dropped is checked only when the check expects it to fail.',
      'There is no device called R9 in this topology.',
      'R1 has no interface called Gi9/9.',
      'banana is not an IPv4 address.',
      'A connectivity check by name cannot also target an interface or an address.',
      'PC1 has no interface or IPv4 address called Gi9/9.',
      '"quic" is not a protocol a connectivity check can use; use icmp, tcp or udp.',
      'SW1 has no interface called Gi9/9.',
      'No cable joins SW1 Fa0/1 and R1, so there is no cable to cut.',
      'There is no device called R9 in this topology.',
      'A configuration fault is a list of configuration lines.',
    ]);
    expect(labCloneMemoStats(sim).builds).toBe(0);
  });
});

describe('connectivity.after: a configuration fault and a cut by port', () => {
  it('an extended ACL applied in the clone drops the web probe at R1 (acl-deny) and lets the ping through', () => {
    const sim = world();
    const before = fingerprint(sim);
    const acl = { after: [{ config: { device: 'R1', lines: ACL_LINES } }], settleMs: 2000 } as const;
    const got = verdicts(sim, [
      conn({ ...acl, proto: 'tcp', port: 80, expect: 'fail', droppedAt: 'R1', dropReason: 'acl-deny' }),
      conn({ ...acl, proto: 'tcp', port: 80, expect: 'fail', dropReason: 'acl-deny' }),
      conn({ ...acl, proto: 'tcp', port: 80, expect: 'fail', droppedAt: 'R1', dropReason: 'no-route' }),
      conn({ ...acl, proto: 'tcp', port: 80, expect: 'fail', droppedAt: 'SRV' }),
      conn({ ...acl, proto: 'tcp', port: 80 }),
      conn({ ...acl }),
      conn({ ...acl, proto: 'udp', port: 53 }),
      // without the fault the web works (the base clone)
      conn({ proto: 'tcp', port: 80 }),
      conn({ proto: 'tcp', port: 80, expect: 'fail', droppedAt: 'R1', dropReason: 'acl-deny' }),
    ]);
    expect(got).toEqual([
      undefined,
      undefined,
      `PC1's probe to ${SRV} was dropped at R1 (acl-deny); expected a drop at R1 (no-route).`,
      `PC1's probe to ${SRV} was dropped at R1 (acl-deny); expected a drop at SRV.`,
      `PC1 could not open TCP port 80 on ${SRV}: an ICMP unreachable came back (type 3, code 13).`,
      undefined,
      undefined,
      undefined,
      `PC1 opened TCP port 80 on ${SRV}, which this task expects to fail.`,
    ]);
    // the live R1 never saw the lines
    expect(fingerprint(sim)).toBe(before);
    expect(sim.device('r1')!.running.render()).not.toContain('NO-WEB');
    expect(LAB_CONFIG_FAULT_OPTIONS).toEqual({ indentation: true });
  });

  it('a refused fault line fails the check with the device refusal', () => {
    const sim = world();
    const [refused] = verdicts(sim, [conn({ after: [{ config: { device: 'R1', lines: ['interface GigabitEthernet0/1', ' no such line'] } }] })]);
    expect(refused).toMatch(/^R1 refused the configuration fault line " no such line": .+\.$/);
  });

  it('cut by port cuts only that cable; without ports every cable between the two devices (P2)', () => {
    const sim = world();
    const serverSide = { after: [{ cut: { a: 'SW1', b: 'R1', bPort: 'Gi0/1' } }], settleMs: 1000 } as const;
    const sameCable = { after: [{ cut: { a: 'R1', b: 'SW1', aPort: 'GigabitEthernet0/1', bPort: 'Gi0/2' } }], settleMs: 1000 } as const;
    const lanSide = { after: [{ cut: { a: 'SW1', b: 'R1', aPort: 'Gi0/1' } }], settleMs: 1000 } as const;
    const both = { after: [{ cut: { a: 'SW1', b: 'R1' } }], settleMs: 1000 } as const;
    const got = verdicts(sim, [
      conn({ ...serverSide, to: 'R1', toIface: 'Gi0/0' }),
      conn({ ...serverSide }),
      conn({ ...serverSide, expect: 'fail' }),
      conn({ ...sameCable, to: 'R1', toIface: 'Gi0/0' }),
      conn({ ...lanSide, to: 'R1', toIface: 'Gi0/0' }),
      conn({ ...both, to: 'R1', toIface: 'Gi0/0' }),
      conn({ ...both, to: 'R1', toIface: 'Gi0/0', expect: 'fail' }),
    ]);
    expect(got).toEqual([
      undefined,
      `PC1 got no reply from ${SRV} (2 echo requests sent).`,
      undefined,
      undefined,
      'PC1 got no reply from 192.168.10.1 (2 echo requests sent).',
      'PC1 got no reply from 192.168.10.1 (2 echo requests sent).',
      undefined,
    ]);
    // the two spellings of the server-side cable share one clone: three fault sets, three clones, no base clone
    expect(labCloneMemoStats(sim).builds).toBe(3);
  });
});

describe('the clone memo (D5)', () => {
  const LAB: readonly LabAssertion[] = [
    conn({ proto: 'tcp', port: 80 }),
    conn({ proto: 'udp', port: 53 }),
    conn({ to: 'R1', toIface: 'Gi0/0', after: [{ cut: { a: 'SW1', b: 'R1', bPort: 'Gi0/1' } }], settleMs: 1000 }),
  ];

  it('a memo hit builds no clone and gives the same status', () => {
    const sim = world();
    const first = evaluateLab(sim, labWith(LAB));
    expect(first.results[0]!.pass).toBe(true);
    expect(labCloneMemoStats(sim)).toEqual({ builds: 2, hits: 0, inputs: 1 });
    sim.runFor(5 * SEC); // time passes, nothing the clone input holds changes
    const again = evaluateLab(sim, labWith(LAB));
    expect(labCloneMemoStats(sim)).toEqual({ builds: 2, hits: 3, inputs: 1 });
    expect({ ...again, checkedAt: 0 }).toEqual({ ...first, checkedAt: 0 });
  });

  it('a changed L1 state misses the memo (the export is unchanged) and grades the new world', () => {
    const sim = world();
    expect(evaluateLab(sim, labWith(LAB)).score).toBe(10);
    const exported = JSON.stringify(sim.exportTopology());
    const link = sim.exportTopology().links.find((l) => l.a.device === 'srv' || l.b.device === 'srv')!.id;
    sim.injectFault(sim.now, { id: 'live-cut', kind: 'cable-cut', target: { link } });
    sim.runFor(1 * SEC);
    expect(JSON.stringify(sim.exportTopology())).toBe(exported);
    const cut = evaluateLab(sim, labWith(LAB));
    expect(labCloneMemoStats(sim)).toEqual({ builds: 4, hits: 0, inputs: 2 });
    expect(cut.results[0]!.assertions.map((r) => r.pass)).toEqual([false, false, true]);
    // a configuration change misses it too
    sim.configure('r1', ['interface Loopback1', ' ip address 2.2.2.2 255.255.255.255'], { indentation: true });
    evaluateLab(sim, labWith(LAB));
    expect(labCloneMemoStats(sim)).toMatchObject({ builds: 6, hits: 0, inputs: 3 });
  });

  it('a check that differs from the recorded run rebuilds the clone after replaying the earlier ones (= a fresh world)', () => {
    // each probe records its session in the udp StateView, so a check's `then` sees how many ran before it
    const probe = (then: readonly LabAssertion[]): Conn => conn({ proto: 'udp', port: 53, then });
    const session = (i: number, n: number): LabAssertion => ({ kind: 'process', device: 'PC1', process: 'udp', path: `probes.${i}.session`, equals: `lab-check:${n}` });
    const x = [probe([]), probe([session(1, 2)])];
    const y = [...x, probe([session(2, 3)])];
    const z = [probe([]), probe([session(0, 1), session(1, 2)])];
    const sim = world();
    const sx = evaluateLab(sim, labWith(x, 'x'));
    expect(sx.score).toBe(10);
    expect(labCloneMemoStats(sim)).toEqual({ builds: 1, hits: 0, inputs: 1 });
    // y = x + one: two hits, then a miss that builds, replays both, then runs the third on the clone they left
    const sy = evaluateLab(sim, labWith(y, 'y'));
    expect(labCloneMemoStats(sim)).toEqual({ builds: 2, hits: 2, inputs: 1 });
    expect(sy).toEqual(evaluateLab(world(), labWith(y, 'y')));
    expect(sy.score).toBe(10);
    // z differs at its second check: one hit, one rebuild
    const sz = evaluateLab(sim, labWith(z, 'z'));
    expect(labCloneMemoStats(sim)).toEqual({ builds: 3, hits: 3, inputs: 1 });
    expect(sz).toEqual(evaluateLab(world(), labWith(z, 'z')));
    expect(sz.score).toBe(10);
    // and the memo now answers z whole
    expect(evaluateLab(sim, labWith(z, 'z'))).toEqual(sz);
    expect(labCloneMemoStats(sim)).toEqual({ builds: 3, hits: 5, inputs: 1 });
    // the memo key is the assertion's canonical JSON: key order does not matter
    expect(canonicalJson({ b: 1, a: [2, { d: undefined, c: 3 }] })).toBe('{"a":[2,{"c":3}],"b":1}');
  });
});

describe('W3 fix (finding 2): a transport probe from a managed switch whose transport is dormant (D22)', () => {
  it('holds the transport awake for the probe, so an open port passes and a closed one reports the reset', () => {
    const sim = world();
    // SW1 gets a management address and gateway, and no P3 service line: its udp and tcp stay dormant (D22)
    const r = sim.configure('sw1', ['interface Vlan1', ' ip address 192.168.10.2 255.255.255.0', ' no shutdown', 'ip default-gateway 192.168.10.1'], { indentation: true });
    expect(r.ok).toBe(true);
    sim.runFor(5 * SEC);
    sim.runToIdle();
    const before = fingerprint(sim);
    const got = verdicts(sim, [
      /* 0 */ conn({ from: 'SW1', proto: 'tcp', port: 80 }),
      /* 1 */ conn({ from: 'SW1', proto: 'tcp', port: 81 }),
      /* 2 */ conn({ from: 'SW1', to: 'R1', proto: 'tcp', port: 23, expect: 'fail' }),
      /* 3 */ conn({ from: 'PC1', to: 'R1', proto: 'tcp', port: 23 }),
      /* 4 */ conn({ from: 'SW1', to: 'R1', proto: 'tcp', port: 23 }),
    ]);
    expect(got).toEqual([
      undefined,
      `SW1 could not open TCP port 81 on ${SRV}: the port is closed (it answered with a reset).`,
      undefined,
      'PC1 could not open TCP port 23 on 192.168.10.1: the port is closed (it answered with a reset).',
      'SW1 could not open TCP port 23 on 192.168.10.1: the port is closed (it answered with a reset).',
    ]);
    // grading touched nothing live, and the live switch's transport is still dormant
    expect(fingerprint(sim)).toBe(before);
  });
});
