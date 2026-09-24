/**
 * P2 W5 sim: the CCNA 2 grader (ARCHITECTURE-P2 §2.10, §3.8 step 7, §11.2; sim/lab-checks.ts, contracts/scenario.ts).
 *
 * Every new `LabAssertion` kind and field is checked on REAL P2-profile worlds built from kit topologies
 * (`topology(…, { profile: 'P2' })`, the real catalog, `createSimulation`), each with at least one passing case and one
 * wrong answer: `vlan`, `switchport`, `stp`, `etherchannel`, `portSecurity`, `port.errDisabled`, `route` (IPv4 and
 * IPv6), `nat`, [S2] `fhrp`, and `connectivity` with `after`, `settleMs` and `then`. Then the grader changes:
 *   • the clone re-applies the live world's err-disabled ports (a port err-disabled by a fault the export cannot carry
 *     stays err-disabled in the clone; a Port-channel the boot creates is err-disabled after the first settle);
 *   • one clone per distinct `after` set (two checks with the same faults — even named differently — share a clone and
 *     see each other's translations; another fault set, or another `settleMs`, gets a fresh clone);
 *   • `then` is evaluated in that clone after the ping (the live world has no translation at all);
 *   • `table` `where` values of port columns match short names;
 *   • grading is read-only (snapshot, clock, trace head, PDU count unchanged) and deterministic (twice on one world,
 *     and on two worlds built alike, the statuses are equal).
 *
 * Worlds:
 *   SWITCHED — SW1 and SW2 (NF-C2960) joined by an LACP bundle (Gi0/1–2, SW1 active, SW2 passive) that trunks VLANs
 *     1, 10, 20, 99 with native 99; VLANs 10 Sales, 20 Staff, 99 Native (and 150 Voice on SW1); SW1 root of VLAN 10,
 *     SW2 root of VLAN 20; PC1 (VLAN 10, sticky port security) and PC3 (VLAN 20, voice 150, restrict port security
 *     that pins another address) on SW1, PC2 (VLAN 10) on SW2; host ports PortFast.
 *   ROUTED — PC1 and PC2 behind SW1 on 192.168.1.0/24 with gateway 192.168.1.254, the virtual address of standby
 *     group 1 on R1 (.2, priority 110, preempt) and R2 (.3); both routers PAT the LAN to their own outside address on
 *     203.0.113.0/24, where SRV (.10) sits behind SW2; R1 also holds 10.3.0.0/16 (distance 1) and 10.3.1.0/24
 *     (distance 7) toward SRV and 2001:db8:3::/64 via 2001:db8:12::10.
 */
import { describe, expect, it } from 'vitest';
import type { LabAssertion, LabCheckResult, LabStatus, ScenarioInfo } from '../src/contracts/scenario.js';
import type { Simulation } from '../src/contracts/simulation.js';
import { SEC } from '../src/contracts/time.js';
import { evaluateLab } from '../src/sim/lab-checks.js';
import { createSimulation } from '../src/sim/simulation.js';
import { PC, ROUTER, SWITCH, accessPort, configText, device, link, section, topology, trunkPort, vlanSections } from '../src/sim/scenarios/kit.js';
import { pcConfig } from '../src/sim/scenarios/templates.js';
import { ping } from './sim.harness.js';

const MASK24 = '255.255.255.0';
/** Long enough for the routers to boot (45 s); `runToIdle` then waits out spanning tree, LACP and the standby election. */
const BOOT = 60 * SEC;

/** Boot `t` as a P2 world and settle it. */
function boot(t: ReturnType<typeof topology>, seed: number): Simulation {
  const sim = createSimulation({ seed });
  sim.loadTopology(t);
  sim.runFor(BOOT);
  sim.runToIdle();
  return sim;
}

// ── the switched world ───────────────────────────────────────────────────────

const TRUNK = { native: 99, allowed: '1,10,20,99' } as const;

/** Port-channel1 and its two members, trunking as `TRUNK`, members in LACP `mode`. */
function bundle(mode: 'active' | 'passive'): string[][] {
  const member = (port: string): string[] => [...trunkPort(port, TRUNK), ` channel-group 1 mode ${mode}`];
  return [trunkPort('Port-channel1', TRUNK), member('GigabitEthernet0/1'), member('GigabitEthernet0/2')];
}

function switchedWorld(seed = 31): Simulation {
  const vlans = [{ id: 10, name: 'Sales' }, { id: 20, name: 'Staff' }, { id: 99, name: 'Native' }];
  const sw1 = configText([
    ['hostname SW1'],
    ...vlanSections([...vlans, { id: 150, name: 'Voice' }]),
    ['spanning-tree vlan 10 priority 4096'],
    ...bundle('active'),
    [...accessPort('FastEthernet0/1', 10, { portfast: true }), ' switchport port-security', ' switchport port-security mac-address sticky'],
    [
      ...accessPort('FastEthernet0/2', 20, { portfast: true }),
      ' switchport voice vlan 150',
      ' switchport port-security',
      ' switchport port-security violation restrict',
      ' switchport port-security mac-address 02:00:00:00:be:ef',
    ],
  ]);
  const sw2 = configText([['hostname SW2'], ...vlanSections(vlans), ['spanning-tree vlan 20 priority 4096'], ...bundle('passive'), accessPort('FastEthernet0/1', 10, { portfast: true })]);
  return boot(
    topology(
      seed,
      [
        device('sw1', SWITCH, 'SW1', 200, 100, sw1),
        device('sw2', SWITCH, 'SW2', 400, 100, sw2),
        device('pc1', PC, 'PC1', 100, 300, pcConfig('PC1', '192.168.10.11', MASK24)),
        device('pc2', PC, 'PC2', 500, 300, pcConfig('PC2', '192.168.10.12', MASK24)),
        device('pc3', PC, 'PC3', 200, 300, pcConfig('PC3', '192.168.20.13', MASK24)),
      ],
      [
        link('l1', 'sw1', 'GigabitEthernet0/1', 'sw2', 'GigabitEthernet0/1'),
        link('l2', 'sw1', 'GigabitEthernet0/2', 'sw2', 'GigabitEthernet0/2'),
        link('l_pc1', 'pc1', 'GigabitEthernet0', 'sw1', 'FastEthernet0/1'),
        link('l_pc2', 'pc2', 'GigabitEthernet0', 'sw2', 'FastEthernet0/1'),
        link('l_pc3', 'pc3', 'GigabitEthernet0', 'sw1', 'FastEthernet0/2'),
      ],
      ['Grade a switched world'],
      'Two switches, one LACP trunk, three VLANs.',
      { profile: 'P2' },
    ),
    seed,
  );
}

// ── the routed world ─────────────────────────────────────────────────────────

const VIP = '192.168.1.254';
const SRV = '203.0.113.10';
const PC1_IP = '192.168.1.10';
const PC2_IP = '192.168.1.11';

function routerConfig(name: string, lan: string, wan: string, standby: readonly string[], extraIf: readonly string[], globals: readonly string[]): string {
  return configText([
    [`hostname ${name}`, 'ipv6 unicast-routing'],
    section('interface GigabitEthernet0/0', [`ip address ${lan} ${MASK24}`, 'ip nat inside', 'standby version 2', `standby 1 ip ${VIP}`, ...standby, 'no shutdown']),
    section('interface GigabitEthernet0/1', [`ip address ${wan} ${MASK24}`, 'ip nat outside', ...extraIf, 'no shutdown']),
    ['access-list 1 permit 192.168.1.0 0.0.0.255', 'ip nat inside source list 1 interface GigabitEthernet0/1 overload', ...globals],
  ]);
}

/** A switch whose first `n` FastEthernet ports are PortFast edge ports. */
function edgeSwitch(name: string, n: number): string {
  const ports = Array.from({ length: n }, (_, i) => section(`interface FastEthernet0/${i + 1}`, ['spanning-tree portfast']));
  return configText([[`hostname ${name}`], ...ports]);
}

function routedWorld(seed = 41): Simulation {
  const r1 = routerConfig('R1', '192.168.1.2', '203.0.113.1', ['standby 1 priority 110', 'standby 1 preempt'], ['ipv6 address 2001:db8:12::1/64'], [
    `ip route 10.3.0.0 255.255.0.0 ${SRV}`,
    `ip route 10.3.1.0 255.255.255.0 ${SRV} 7`,
    'ipv6 route 2001:db8:3::/64 2001:db8:12::10',
  ]);
  const r2 = routerConfig('R2', '192.168.1.3', '203.0.113.2', [], [], []);
  return boot(
    topology(
      seed,
      [
        device('pc1', PC, 'PC1', 100, 300, pcConfig('PC1', PC1_IP, MASK24, VIP)),
        device('pc2', PC, 'PC2', 100, 400, pcConfig('PC2', PC2_IP, MASK24, VIP)),
        device('sw1', SWITCH, 'SW1', 250, 350, edgeSwitch('SW1', 4)),
        device('r1', ROUTER, 'R1', 400, 250, r1),
        device('r2', ROUTER, 'R2', 400, 450, r2),
        device('sw2', SWITCH, 'SW2', 550, 350, edgeSwitch('SW2', 3)),
        device('srv', PC, 'SRV', 700, 350, pcConfig('SRV', SRV, MASK24, '203.0.113.1')),
      ],
      [
        link('l_r1_lan', 'r1', 'GigabitEthernet0/0', 'sw1', 'FastEthernet0/1'),
        link('l_r2_lan', 'r2', 'GigabitEthernet0/0', 'sw1', 'FastEthernet0/2'),
        link('l_pc1', 'pc1', 'GigabitEthernet0', 'sw1', 'FastEthernet0/3'),
        link('l_pc2', 'pc2', 'GigabitEthernet0', 'sw1', 'FastEthernet0/4'),
        link('l_r1_wan', 'r1', 'GigabitEthernet0/1', 'sw2', 'FastEthernet0/1'),
        link('l_r2_wan', 'r2', 'GigabitEthernet0/1', 'sw2', 'FastEthernet0/2'),
        link('l_srv', 'srv', 'GigabitEthernet0', 'sw2', 'FastEthernet0/3'),
      ],
      ['Grade a routed world'],
      'Two routers share a standby gateway and translate the LAN.',
      { profile: 'P2' },
    ),
    seed,
  );
}

// ── helpers ──────────────────────────────────────────────────────────────────

/** A lab whose single task carries `assertions`. */
function labWith(assertions: readonly LabAssertion[]): ScenarioInfo {
  return {
    name: 'check-demo-p2',
    title: 'Check demo',
    description: 'A lab built by the test',
    category: 'ccna2-lab',
    build: () => topology(1, [], [], [], '', { profile: 'P2' }),
    tasks: [{ id: 'only', title: 'Only task', description: 'One task', points: 10, assertions }],
  };
}

/** Evaluate `assertions` in ONE evaluation (one clone host) and return each result. */
function each(sim: Simulation, assertions: readonly LabAssertion[]): LabCheckResult['assertions'] {
  return evaluateLab(sim, labWith(assertions)).results[0]!.assertions;
}

/** Evaluate one assertion. */
function one(sim: Simulation, a: LabAssertion): { pass: boolean; detail?: string } {
  return each(sim, [a])[0]!;
}

/** Expect `a` to pass (with its detail in the message when it does not). */
function passes(sim: Simulation, a: LabAssertion): void {
  const r = one(sim, a);
  expect(r.pass, `${JSON.stringify(a)}: ${r.detail ?? ''}`).toBe(true);
}

/** Expect `a` to fail, and return its detail. */
function fails(sim: Simulation, a: LabAssertion): string {
  const r = one(sim, a);
  expect(r.pass, JSON.stringify(a)).toBe(false);
  expect(r.detail ?? '').not.toBe('');
  return r.detail ?? '';
}

/** Everything grading must leave untouched. */
function fingerprint(sim: Simulation): unknown {
  return { now: sim.now, head: sim.trace(0).next, pdus: sim.snapshot().pduCount, snapshot: JSON.stringify(sim.snapshot()) };
}

// ── switching kinds ──────────────────────────────────────────────────────────

describe('evaluateLab P2: vlan', () => {
  it('checks existence, name and the access ports show vlan lists', () => {
    const sim = switchedWorld();
    passes(sim, { kind: 'vlan', device: 'SW1', vlan: 10 });
    passes(sim, { kind: 'vlan', device: 'SW1', vlan: 10, exists: true, name: 'Sales', accessPorts: ['Fa0/1'] });
    passes(sim, { kind: 'vlan', device: 'SW1', vlan: 10, accessPorts: ['FastEthernet0/1'], match: 'exactly' });
    passes(sim, { kind: 'vlan', device: 'SW1', vlan: 150, name: 'Voice', accessPorts: ['Fa0/2'], match: 'exactly' });
    passes(sim, { kind: 'vlan', device: 'SW1', vlan: 1, name: 'default', accessPorts: ['Fa0/3', 'Fa0/24'] });
    passes(sim, { kind: 'vlan', device: 'SW1', vlan: 1002, name: 'fddi-default' });
    passes(sim, { kind: 'vlan', device: 'SW2', vlan: 150, exists: false });
    passes(sim, { kind: 'vlan', device: 'SW2', vlan: 20, name: 'Staff', accessPorts: [], match: 'exactly' });

    expect(fails(sim, { kind: 'vlan', device: 'SW1', vlan: 10, name: 'Marketing' })).toContain('named Sales');
    expect(fails(sim, { kind: 'vlan', device: 'SW1', vlan: 10, accessPorts: ['Fa0/2'] })).toContain('Fa0/1');
    expect(fails(sim, { kind: 'vlan', device: 'SW1', vlan: 20, accessPorts: [], match: 'exactly' })).toContain('Fa0/2');
    expect(fails(sim, { kind: 'vlan', device: 'SW1', vlan: 10, exists: false })).toContain('still exists');
    expect(fails(sim, { kind: 'vlan', device: 'SW2', vlan: 150 })).toContain('does not exist');
    expect(fails(sim, { kind: 'vlan', device: 'SW1', vlan: 10, accessPorts: ['Fa9/9'] })).toContain('Fa9/9');
  });
});

describe('evaluateLab P2: switchport', () => {
  it('checks the operating mode, the configured mode and VLANs, and the active trunk list', () => {
    const sim = switchedWorld();
    passes(sim, { kind: 'switchport', device: 'SW1', port: 'Po1', oper: 'trunk', mode: 'trunk', nativeVlan: 99, allowedVlans: [99, 1, 20, 10] });
    passes(sim, { kind: 'switchport', device: 'SW2', port: 'GigabitEthernet0/1', oper: 'trunk', nativeVlan: 99 });
    passes(sim, { kind: 'switchport', device: 'SW1', port: 'Fa0/2', oper: 'access', mode: 'access', accessVlan: 20, voiceVlan: 150 });
    passes(sim, { kind: 'switchport', device: 'SW1', port: 'Fa0/3', oper: 'down', mode: 'dynamic-auto', accessVlan: 1 });

    expect(fails(sim, { kind: 'switchport', device: 'SW1', port: 'Po1', nativeVlan: 1 })).toContain('native VLAN 99');
    expect(fails(sim, { kind: 'switchport', device: 'SW1', port: 'Po1', allowedVlans: [10, 20] })).toContain('1,10,20,99');
    expect(fails(sim, { kind: 'switchport', device: 'SW1', port: 'Po1', mode: 'access' })).toContain('mode trunk');
    expect(fails(sim, { kind: 'switchport', device: 'SW1', port: 'Po1', oper: 'access' })).toContain('operates as trunk');
    expect(fails(sim, { kind: 'switchport', device: 'SW1', port: 'Fa0/2', accessVlan: 10 })).toContain('access VLAN 20');
    expect(fails(sim, { kind: 'switchport', device: 'SW1', port: 'Fa0/1', voiceVlan: 150 })).toContain('no voice VLAN');
    expect(fails(sim, { kind: 'switchport', device: 'SW1', port: 'Fa0/3', oper: 'access' })).toContain('is down');
    expect(fails(sim, { kind: 'switchport', device: 'SW1', port: 'Vlan1', mode: 'access' })).toContain('not a switch port');
    expect(fails(sim, { kind: 'switchport', device: 'PC1', port: 'Gi0', oper: 'access' })).toContain('not a switch port');
  });
});

describe('evaluateLab P2: stp', () => {
  it('checks the root per VLAN, the mode and one port\'s role, state and edge flag', () => {
    const sim = switchedWorld();
    passes(sim, { kind: 'stp', device: 'SW1', vlan: 10, root: true, rootBridge: 'SW1', mode: 'pvst' });
    passes(sim, { kind: 'stp', device: 'SW2', vlan: 10, root: false, rootBridge: 'SW1', port: 'Po1', role: 'root', state: 'forwarding', edge: false });
    passes(sim, { kind: 'stp', device: 'SW1', vlan: 20, root: false, rootBridge: 'SW2' });
    passes(sim, { kind: 'stp', device: 'SW1', vlan: 10, port: 'Fa0/1', role: 'designated', state: 'forwarding', edge: true });
    passes(sim, { kind: 'stp', device: 'SW1', vlan: 10, port: 'Port-channel1', role: 'designated' });

    expect(fails(sim, { kind: 'stp', device: 'SW2', vlan: 10, root: true })).toContain('the root is SW1');
    expect(fails(sim, { kind: 'stp', device: 'SW2', vlan: 20, rootBridge: 'SW1' })).toContain('sees SW2 as the root');
    expect(fails(sim, { kind: 'stp', device: 'SW1', vlan: 10, mode: 'rapid-pvst' })).toContain('runs pvst');
    expect(fails(sim, { kind: 'stp', device: 'SW2', vlan: 10, port: 'Po1', role: 'alternate' })).toContain('in role root');
    expect(fails(sim, { kind: 'stp', device: 'SW1', vlan: 10, port: 'Fa0/1', state: 'blocking' })).toContain('forwarding');
    expect(fails(sim, { kind: 'stp', device: 'SW1', vlan: 10, port: 'Fa0/1', edge: false })).toContain('edge');
    expect(fails(sim, { kind: 'stp', device: 'SW1', vlan: 10, port: 'Fa0/2', role: 'designated' })).toContain('no spanning-tree port');
    expect(fails(sim, { kind: 'stp', device: 'SW1', vlan: 30, root: true })).toContain('not running for VLAN 30');
    expect(fails(sim, { kind: 'stp', device: 'SW1', vlan: 10, role: 'root' })).toContain('needs the port');
    expect(fails(sim, { kind: 'stp', device: 'SW2', vlan: 150, rootBridge: 'SW1' })).toContain('not running');
  });
});

describe('evaluateLab P2: etherchannel', () => {
  it('checks the protocol, the bundle state and the bundled members', () => {
    const sim = switchedWorld();
    passes(sim, { kind: 'etherchannel', device: 'SW1', group: 1, protocol: 'lacp', up: true, bundled: ['Gi0/1', 'GigabitEthernet0/2'], minBundled: 2 });
    passes(sim, { kind: 'etherchannel', device: 'SW2', group: 1, bundled: ['Gi0/2'] });

    expect(fails(sim, { kind: 'etherchannel', device: 'SW1', group: 1, protocol: 'pagp' })).toContain('runs lacp');
    expect(fails(sim, { kind: 'etherchannel', device: 'SW1', group: 1, up: false })).toContain('Port-channel1 up');
    expect(fails(sim, { kind: 'etherchannel', device: 'SW1', group: 1, bundled: ['Fa0/1'] })).toContain('no member Fa0/1');
    expect(fails(sim, { kind: 'etherchannel', device: 'SW1', group: 1, minBundled: 3 })).toContain('2 bundled members');
    expect(fails(sim, { kind: 'etherchannel', device: 'SW1', group: 2 })).toContain('channel group 2');

    // a member shut down is no longer bundled; the bundle stays up on the other one
    expect(sim.configure('sw1', ['interface GigabitEthernet0/2', 'shutdown']).ok).toBe(true);
    sim.runToIdle();
    expect(fails(sim, { kind: 'etherchannel', device: 'SW1', group: 1, bundled: ['Gi0/1', 'Gi0/2'] })).toContain('Gi0/2');
    passes(sim, { kind: 'etherchannel', device: 'SW1', group: 1, up: true, bundled: ['Gi0/1'], minBundled: 1 });
  });
});

describe('evaluateLab P2: portSecurity and port.errDisabled', () => {
  it('checks the configured limits, the pinned address and the violation state', () => {
    const sim = switchedWorld();
    // PC3's frames violate its port (another address is pinned there)
    ping(sim, 'pc3', '192.168.20.14');
    const pc1Mac = sim.device('pc1')!.port('GigabitEthernet0')!.mac;
    const dotted = pc1Mac.replace(/:/g, '').replace(/(.{4})(.{4})(.{4})/, '$1.$2.$3');
    passes(sim, { kind: 'portSecurity', device: 'SW1', port: 'Fa0/1', enabled: true, status: 'secure-up', violation: 'shutdown', max: 1, stickyMac: 'PC1' });
    passes(sim, { kind: 'portSecurity', device: 'SW1', port: 'FastEthernet0/1', stickyMac: dotted });
    passes(sim, { kind: 'portSecurity', device: 'SW1', port: 'Fa0/2', violation: 'restrict', status: 'secure-up', minViolations: 1 });
    passes(sim, { kind: 'portSecurity', device: 'SW1', port: 'Fa0/3', enabled: false });

    expect(fails(sim, { kind: 'portSecurity', device: 'SW1', port: 'Fa0/1', stickyMac: 'PC2' })).toContain(pc1Mac);
    expect(fails(sim, { kind: 'portSecurity', device: 'SW1', port: 'Fa0/1', violation: 'protect' })).toContain('shutdown');
    expect(fails(sim, { kind: 'portSecurity', device: 'SW1', port: 'Fa0/1', max: 2 })).toContain('allows 1 address');
    expect(fails(sim, { kind: 'portSecurity', device: 'SW1', port: 'Fa0/1', status: 'secure-shutdown' })).toContain('secure-up');
    expect(fails(sim, { kind: 'portSecurity', device: 'SW1', port: 'Fa0/1', minViolations: 1 })).toContain('0 violations');
    expect(fails(sim, { kind: 'portSecurity', device: 'SW1', port: 'Fa0/2', minViolations: 1_000 })).toContain('violation');
    expect(fails(sim, { kind: 'portSecurity', device: 'SW1', port: 'Fa0/3', enabled: true })).toContain('off');
    expect(fails(sim, { kind: 'portSecurity', device: 'SW1', port: 'Fa0/3', status: 'secure-up' })).toContain('off');
    expect(fails(sim, { kind: 'portSecurity', device: 'SW1', port: 'Fa0/1', stickyMac: 'NOT-A-DEVICE' })).toContain('neither a MAC');
  });

  it('reads errDisabled as true (any cause), false, or the exact cause', () => {
    const sim = switchedWorld();
    passes(sim, { kind: 'port', device: 'SW2', port: 'Fa0/1', field: 'errDisabled', equals: false });
    expect(fails(sim, { kind: 'port', device: 'SW2', port: 'Fa0/1', field: 'errDisabled', equals: true })).toContain('not err-disabled');

    sim.injectFault(sim.now, { id: 'hidden', kind: 'err-disable', target: { device: 'sw2', port: 'FastEthernet0/1' }, params: { cause: 'bpduguard' } });
    sim.runToIdle();
    passes(sim, { kind: 'port', device: 'SW2', port: 'Fa0/1', field: 'errDisabled', equals: true });
    passes(sim, { kind: 'port', device: 'SW2', port: 'FastEthernet0/1', field: 'errDisabled', equals: 'bpduguard' });
    expect(fails(sim, { kind: 'port', device: 'SW2', port: 'Fa0/1', field: 'errDisabled', equals: 'psecure-violation' })).toContain('bpduguard');
    expect(fails(sim, { kind: 'port', device: 'SW2', port: 'Fa0/1', field: 'errDisabled', equals: false })).toContain('err-disabled (bpduguard)');
  });
});

describe('evaluateLab P2: table where values of port columns', () => {
  it('matches a short port name against the canonical name the rows hold', () => {
    const sim = switchedWorld();
    passes(sim, { kind: 'table', device: 'SW1', table: 'etherchannel', where: { port: 'Gi0/1', state: 'bundled', bundle: 'Po1' }, exists: true });
    passes(sim, { kind: 'table', device: 'SW2', table: 'stp', where: { port: 'Po1', vlan: 10, role: 'root' }, exists: true });
    passes(sim, { kind: 'table', device: 'SW1', table: 'cam', where: { port: 'Fa0/1', vlan: 10, secure: 'sticky' }, exists: true });
    passes(sim, { kind: 'table', device: 'SW1', table: 'port-security', where: { port: 'Fa0/2', violation: 'restrict' }, exists: true });
    passes(sim, { kind: 'table', device: 'SW2', table: 'stp-bridge', where: { vlan: 10, rootPort: 'Po1' }, exists: true });

    expect(fails(sim, { kind: 'table', device: 'SW1', table: 'etherchannel', where: { port: 'Gi0/1' }, exists: false })).toContain('port=Gi0/1');
    expect(fails(sim, { kind: 'table', device: 'SW1', table: 'etherchannel', where: { port: 'Gi0/1', state: 'suspended' }, exists: true })).toContain('state=suspended');
    fails(sim, { kind: 'table', device: 'SW1', table: 'etherchannel', where: { port: 'Gi0/9' }, exists: true });
  });
});

// ── routing kinds ────────────────────────────────────────────────────────────

describe('evaluateLab P2: route', () => {
  it('reports the longest-prefix winner and its fields, for IPv4 and IPv6', () => {
    const sim = routedWorld();
    passes(sim, { kind: 'route', device: 'R1', destination: '10.3.1.1', source: 'S', network: '10.3.1.0/24', nextHop: SRV, iface: 'Gi0/1', ad: 7 });
    passes(sim, { kind: 'route', device: 'R1', destination: '10.3.5.5', network: '10.3.0.0/16', ad: 1 });
    passes(sim, { kind: 'route', device: 'R1', destination: '10.3.5.5', network: '10.3.0.0' });
    passes(sim, { kind: 'route', device: 'R1', destination: PC1_IP, source: 'C', network: '192.168.1.0/24', iface: 'GigabitEthernet0/0' });
    passes(sim, { kind: 'route', device: 'R1', destination: '192.168.1.2', source: 'L' });
    passes(sim, { kind: 'route', device: 'R1', destination: '172.16.0.1', none: true });
    passes(sim, { kind: 'route', device: 'R1', destination: '10.3.1.1', none: false });
    passes(sim, { kind: 'route', device: 'PC1', destination: SRV, source: 'S', network: '0.0.0.0/0', nextHop: VIP });
    passes(sim, { kind: 'route', device: 'R1', family: 6, destination: '2001:db8:3::10', source: 'S', network: '2001:DB8:3:0::/64', nextHop: '2001:db8:12::10', iface: 'Gi0/1' });

    expect(fails(sim, { kind: 'route', device: 'R1', destination: '10.3.1.1', network: '10.3.0.0/16' })).toContain('10.3.1.0/24');
    expect(fails(sim, { kind: 'route', device: 'R1', destination: '10.3.1.1', ad: 1 })).toContain('distance 7');
    expect(fails(sim, { kind: 'route', device: 'R1', destination: '10.3.1.1', nextHop: '203.0.113.99' })).toContain('next hop 203.0.113.99');
    // a next-hop static leaves through the interface its next hop is reached on
    const wrongExit = fails(sim, { kind: 'route', device: 'R1', destination: '10.3.1.1', iface: 'Gi0/0' });
    expect(wrongExit).toContain('interface Gi0/0');
    expect(wrongExit).toContain('out GigabitEthernet0/1');
    expect(fails(sim, { kind: 'route', device: 'R1', family: 6, destination: '2001:db8:3::10', iface: 'Gi0/0' })).toContain('interface Gi0/0');
    expect(fails(sim, { kind: 'route', device: 'R1', destination: '10.3.1.1', source: 'C' })).toContain('source C');
    expect(fails(sim, { kind: 'route', device: 'R1', destination: '10.3.1.1', none: true })).toContain('still routes');
    expect(fails(sim, { kind: 'route', device: 'R1', destination: '172.16.0.1', none: false })).toContain('no route to 172.16.0.1');
    expect(fails(sim, { kind: 'route', device: 'R1', destination: '172.16.0.1', network: '172.16.0.0/16' })).toContain('no route');
    expect(fails(sim, { kind: 'route', device: 'R1', family: 6, destination: '2001:db8:3::10', nextHop: '2001:db8:12::99' })).toContain('next hop');
    expect(fails(sim, { kind: 'route', device: 'R1', destination: 'not-an-address' })).toContain('not an IPv4 address');
    expect(fails(sim, { kind: 'route', device: 'R1', family: 6, destination: '2001:db8:9::1' })).toContain('no route');
  });
});

describe('evaluateLab P2: nat', () => {
  it('matches translation rows by any of their fields, or counts them', () => {
    const sim = routedWorld();
    passes(sim, { kind: 'nat', device: 'R1', exists: false });
    expect(ping(sim, 'pc1', SRV).text).toContain('Sent 5, received 5');
    expect(ping(sim, 'pc2', SRV).text).toContain('Sent 5, received 5');
    passes(sim, { kind: 'nat', device: 'R1', insideLocal: PC1_IP, insideGlobal: '203.0.113.1', outsideGlobal: SRV, proto: 'icmp', kindOf: 'overload' });
    passes(sim, { kind: 'nat', device: 'R1', insideLocal: PC2_IP, exists: true });
    passes(sim, { kind: 'nat', device: 'R1', proto: 'icmp', minCount: 2 });
    passes(sim, { kind: 'nat', device: 'R1', insideLocal: '192.168.1.99', exists: false });
    passes(sim, { kind: 'nat', device: 'R2', exists: false });

    expect(fails(sim, { kind: 'nat', device: 'R1', insideLocal: PC1_IP, kindOf: 'static' })).toContain('kind static');
    expect(fails(sim, { kind: 'nat', device: 'R1', proto: 'udp' })).toContain('proto udp');
    expect(fails(sim, { kind: 'nat', device: 'R1', minCount: 3 })).toContain('at least 3');
    expect(fails(sim, { kind: 'nat', device: 'R1', insideLocal: PC1_IP, exists: false })).toContain('still holds');
    expect(fails(sim, { kind: 'nat', device: 'R2', insideLocal: PC1_IP })).toContain('holds no translations');
    expect(fails(sim, { kind: 'nat', device: 'PC1' })).toContain('does not translate');
  });
});

describe('evaluateLab P2: fhrp [S2]', () => {
  it('checks the state, virtual address, priority and preemption of a standby group', () => {
    const sim = routedWorld();
    passes(sim, { kind: 'fhrp', device: 'R1', iface: 'Gi0/0', group: 1, state: 'active', virtualIp: VIP, priority: 110, preempt: true });
    passes(sim, { kind: 'fhrp', device: 'R2', iface: 'GigabitEthernet0/0', group: 1, state: 'standby', priority: 100, preempt: false });

    expect(fails(sim, { kind: 'fhrp', device: 'R2', iface: 'Gi0/0', group: 1, state: 'active' })).toContain('is standby');
    expect(fails(sim, { kind: 'fhrp', device: 'R1', iface: 'Gi0/0', group: 1, virtualIp: '192.168.1.253' })).toContain(VIP);
    expect(fails(sim, { kind: 'fhrp', device: 'R1', iface: 'Gi0/0', group: 1, priority: 100 })).toContain('priority 110');
    expect(fails(sim, { kind: 'fhrp', device: 'R2', iface: 'Gi0/0', group: 1, preempt: true })).toContain('does not preempt');
    expect(fails(sim, { kind: 'fhrp', device: 'R1', iface: 'Gi0/0', group: 2 })).toContain('no standby group 2');
    expect(fails(sim, { kind: 'fhrp', device: 'R1', iface: 'Gi0/1', group: 1 })).toContain('no standby group 1');
    expect(fails(sim, { kind: 'fhrp', device: 'SW1', iface: 'Fa0/1', group: 1 })).toContain('standby');
  });
});

describe('evaluateLab P2: unknown names never throw', () => {
  it('fails every new kind with a detail when a device or port is missing', () => {
    const sim = switchedWorld();
    const cases: LabAssertion[] = [
      { kind: 'vlan', device: 'NOPE', vlan: 10 },
      { kind: 'switchport', device: 'SW1', port: 'Fa9/9', oper: 'access' },
      { kind: 'stp', device: 'NOPE', vlan: 1 },
      { kind: 'stp', device: 'SW1', vlan: 10, rootBridge: 'NOPE' },
      { kind: 'stp', device: 'SW1', vlan: 10, port: 'Fa9/9', role: 'root' },
      { kind: 'etherchannel', device: 'SW1', group: 1, bundled: ['Gi9/9'] },
      { kind: 'portSecurity', device: 'SW1', port: 'Fa9/9', enabled: true },
      { kind: 'route', device: 'NOPE', destination: '10.0.0.1' },
      { kind: 'route', device: 'SW1', family: 6, destination: '2001:db8::1' },
      { kind: 'nat', device: 'NOPE' },
      { kind: 'fhrp', device: 'NOPE', iface: 'Gi0/0', group: 1 },
      { kind: 'port', device: 'SW1', port: 'Fa9/9', field: 'errDisabled', equals: true },
      { kind: 'connectivity', from: 'PC1', to: 'PC2', expect: 'success', after: [{ powerOff: 'NOPE' }] },
      { kind: 'connectivity', from: 'PC1', to: 'PC2', expect: 'success', after: [{ cut: { a: 'PC1', b: 'PC2' } }] },
      { kind: 'connectivity', from: 'PC1', to: 'PC2', expect: 'success', after: [{ shutdown: { device: 'SW1', port: 'Fa9/9' } }] },
    ];
    for (const a of cases) {
      const r = one(sim, a);
      expect(r.pass, JSON.stringify(a)).toBe(false);
      expect(r.detail, JSON.stringify(a)).toBeTruthy();
    }
  });
});

// ── the grader's clones ──────────────────────────────────────────────────────

describe('evaluateLab P2: err-disabled ports in the clone (§3.8 step 7)', () => {
  it('keeps a port err-disabled by a fault the export cannot carry, until the student recovers it', () => {
    const sim = switchedWorld();
    const reach: LabAssertion = { kind: 'connectivity', from: 'PC1', to: 'PC2', expect: 'success' };
    passes(sim, reach);

    // a hidden fault err-disables PC2's port: nothing in the exported topology says so
    sim.injectFault(sim.now, { id: 'hidden', kind: 'err-disable', target: { device: 'sw2', port: 'FastEthernet0/1' }, params: { cause: 'psecure-violation' } });
    sim.runToIdle();
    expect(sim.device('sw2')!.port('FastEthernet0/1')!.errDisabled).toBe('psecure-violation');
    expect(sim.exportTopology().devices.find((d) => d.id === 'sw2')!.runningConfig ?? '').not.toContain('err');
    expect(fails(sim, reach)).toContain('no reply');
    passes(sim, { ...reach, expect: 'fail' });
    // the clone's copy of the port is err-disabled with the live cause
    passes(sim, {
      kind: 'connectivity',
      from: 'PC1',
      to: 'PC1',
      expect: 'success',
      then: [{ kind: 'port', device: 'SW2', port: 'Fa0/1', field: 'errDisabled', equals: 'psecure-violation' }],
    });

    // recovery by hand: shutdown clears the cause, no shutdown brings the port back
    expect(sim.configure('sw2', ['interface FastEthernet0/1', 'shutdown', 'no shutdown']).ok).toBe(true);
    sim.runToIdle();
    expect(sim.device('sw2')!.port('FastEthernet0/1')!.errDisabled).toBeUndefined();
    passes(sim, reach);
  });

  it('err-disables a port the clone creates at boot once the clone has settled', () => {
    const sim = switchedWorld();
    sim.injectFault(sim.now, { id: 'hidden-po', kind: 'err-disable', target: { device: 'sw1', port: 'Port-channel1' }, params: { cause: 'channel-misconfig' } });
    sim.runToIdle();
    expect(sim.device('sw1')!.port('Port-channel1')!.errDisabled).toBe('channel-misconfig');
    passes(sim, {
      kind: 'connectivity',
      from: 'PC1',
      to: 'PC1',
      expect: 'success',
      then: [{ kind: 'port', device: 'SW1', port: 'Po1', field: 'errDisabled', equals: 'channel-misconfig' }],
    });
  });
});

describe('evaluateLab P2: connectivity after faults and then', () => {
  it('evaluates then in the clone after the ping, and only when the ping met its expectation', () => {
    const sim = routedWorld();
    const translated: LabAssertion = { kind: 'nat', device: 'R1', insideLocal: PC1_IP, proto: 'icmp', kindOf: 'overload' };
    // the live world has translated nothing …
    expect(fails(sim, translated)).toContain('holds no translations');
    // … the clone has, right after its ping
    const [ok, wrong, refused] = each(sim, [
      { kind: 'connectivity', from: 'PC1', to: 'SRV', expect: 'success', then: [translated, { kind: 'fhrp', device: 'R1', iface: 'Gi0/0', group: 1, state: 'active' }] },
      { kind: 'connectivity', from: 'PC1', to: 'SRV', expect: 'success', then: [{ kind: 'nat', device: 'R1', insideLocal: '192.168.1.99' }] },
      { kind: 'connectivity', from: 'PC1', to: 'SRV', expect: 'success', then: [{ kind: 'connectivity', from: 'PC2', to: 'SRV', expect: 'success' }] },
    ]);
    expect(ok!.pass, ok!.detail).toBe(true);
    expect(wrong!.pass).toBe(false);
    expect(wrong!.detail).toContain('After the ping from PC1');
    expect(wrong!.detail).toContain('192.168.1.99');
    expect(refused!.pass).toBe(false);
    expect(refused!.detail).toContain('cannot ping again');
    // a ping that misses its expectation reports the ping, not the follow-up checks
    const missed = one(sim, { kind: 'connectivity', from: 'PC1', to: 'SRV', expect: 'fail', then: [translated] });
    expect(missed.pass).toBe(false);
    expect(missed.detail).toContain('expects to fail');
    expect(missed.detail).not.toContain('After the ping');
  });

  it('applies power-off, cut and shutdown faults in the clone, then waits settleMs before the ping', () => {
    const sim = routedWorld();
    const [failover, cut, shut, gone, goneFail] = each(sim, [
      // the active gateway loses power: the standby router takes over the virtual address and translates instead
      {
        kind: 'connectivity',
        from: 'PC1',
        to: 'SRV',
        expect: 'success',
        after: [{ powerOff: 'R1' }],
        settleMs: 15_000,
        then: [
          { kind: 'fhrp', device: 'R2', iface: 'Gi0/0', group: 1, state: 'active' },
          { kind: 'nat', device: 'R2', insideLocal: PC1_IP, insideGlobal: '203.0.113.2' },
        ],
      },
      { kind: 'connectivity', from: 'PC1', to: 'SRV', expect: 'fail', after: [{ cut: { a: 'SW2', b: 'SRV' } }], settleMs: 5_000 },
      { kind: 'connectivity', from: 'PC2', to: 'SRV', expect: 'fail', after: [{ shutdown: { device: 'SW2', port: 'Fa0/3' } }], settleMs: 5_000 },
      // a target the faults powered off is pinged at the address it held before them
      { kind: 'connectivity', from: 'PC1', to: 'SRV', expect: 'fail', after: [{ powerOff: 'SRV' }], settleMs: 5_000 },
      { kind: 'connectivity', from: 'PC1', to: 'SRV', expect: 'success', after: [{ powerOff: 'SRV' }], settleMs: 5_000 },
    ]);
    expect(failover!.pass, failover!.detail).toBe(true);
    expect(cut!.pass, cut!.detail).toBe(true);
    expect(shut!.pass, shut!.detail).toBe(true);
    expect(gone!.pass, gone!.detail).toBe(true);
    expect(goneFail!.pass).toBe(false);
    expect(goneFail!.detail).toContain(`no reply from ${SRV}`);
    // too short a wait: the standby router has not taken over yet (hold time 10 s)
    const early = one(sim, { kind: 'connectivity', from: 'PC1', to: 'SRV', expect: 'success', after: [{ powerOff: 'R1' }], settleMs: 1_000 });
    expect(early.pass).toBe(false);
    // the live world never lost R1
    expect(sim.device('r1')!.power).toBe(true);
  });

  it('builds one clone per distinct fault set: the same faults share it, other faults or another settleMs do not', () => {
    const sim = routedWorld();
    const offR1 = [{ powerOff: 'R1' }] as const;
    const results = each(sim, [
      // same fault set (a harmless shutdown of an unused port), named two ways: one clone, both translations in it
      { kind: 'connectivity', from: 'PC1', to: 'SRV', expect: 'success', after: [{ shutdown: { device: 'SW1', port: 'Fa0/24' } }], settleMs: 2_000, then: [{ kind: 'nat', device: 'R1', minCount: 1 }] },
      { kind: 'connectivity', from: 'PC2', to: 'SRV', expect: 'success', after: [{ shutdown: { device: 'SW1', port: 'FastEthernet0/24' } }], settleMs: 2_000, then: [{ kind: 'nat', device: 'R1', minCount: 2 }] },
      // another fault set: a fresh clone that has translated only this ping
      {
        kind: 'connectivity',
        from: 'PC2',
        to: 'SRV',
        expect: 'success',
        after: [{ shutdown: { device: 'SW1', port: 'Fa0/23' } }],
        settleMs: 2_000,
        then: [{ kind: 'nat', device: 'R1', minCount: 2 }],
      },
      { kind: 'connectivity', from: 'PC2', to: 'SRV', expect: 'success', after: [{ shutdown: { device: 'SW1', port: 'Fa0/22' } }], settleMs: 2_000, then: [{ kind: 'nat', device: 'R1', minCount: 1 }] },
      // the base clone (no faults) is yet another world: nothing translated before this ping
      { kind: 'connectivity', from: 'PC1', to: 'SRV', expect: 'success', then: [{ kind: 'nat', device: 'R1', minCount: 1 }, { kind: 'nat', device: 'R1', insideLocal: PC2_IP, exists: false }] },
      // the same faults with another settleMs: another clone
      { kind: 'connectivity', from: 'PC2', to: 'SRV', expect: 'success', after: offR1, settleMs: 15_000, then: [{ kind: 'nat', device: 'R2', minCount: 1 }] },
      { kind: 'connectivity', from: 'PC1', to: 'SRV', expect: 'success', after: offR1, settleMs: 15_000, then: [{ kind: 'nat', device: 'R2', minCount: 2 }] },
      { kind: 'connectivity', from: 'PC1', to: 'SRV', expect: 'success', after: offR1, settleMs: 16_000, then: [{ kind: 'nat', device: 'R2', minCount: 2 }] },
    ]);
    expect(results.map((r) => r.pass)).toEqual([true, true, false, true, true, true, true, false]);
    expect(results[2]!.detail).toContain('at least 2');
    expect(results[7]!.detail).toContain('at least 2');
  });
});

describe('evaluateLab P2: read-only and deterministic', () => {
  const lab = (): ScenarioInfo =>
    labWith([
      { kind: 'fhrp', device: 'R1', iface: 'Gi0/0', group: 1, state: 'active' },
      { kind: 'route', device: 'R1', destination: '10.3.1.1', network: '10.3.1.0/24' },
      { kind: 'connectivity', from: 'PC1', to: 'SRV', expect: 'success', then: [{ kind: 'nat', device: 'R1', insideLocal: PC1_IP }] },
      { kind: 'connectivity', from: 'PC2', to: 'SRV', expect: 'success', after: [{ powerOff: 'R1' }], settleMs: 15_000 },
      { kind: 'connectivity', from: 'PC2', to: 'SRV', expect: 'fail', after: [{ cut: { a: 'SW2', b: 'SRV' } }], settleMs: 2_000 },
    ]);

  it('leaves the live world exactly as it was, however many clones it builds', () => {
    const sim = routedWorld();
    const before = fingerprint(sim);
    const status = evaluateLab(sim, lab());
    expect(status.score, JSON.stringify(status.results)).toBe(status.total);
    expect(fingerprint(sim)).toEqual(before);
    expect(sim.device('r1')!.power).toBe(true);
    expect(sim.link('l_srv')!.up).toBe(true);
  });

  it('grades the same world the same way twice, and two worlds built alike the same way', () => {
    const a = routedWorld();
    const b = routedWorld();
    const first: LabStatus = evaluateLab(a, lab());
    expect(evaluateLab(a, lab())).toEqual(first);
    expect(evaluateLab(b, lab())).toEqual(first);
  });
});
