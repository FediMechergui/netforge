/**
 * P0.5 acceptance — multilayer switch routed port (ARCHITECTURE-P1 §10.1 `accept.p05.l3switch-routed-port`; D3,
 * §3.10, §9.3).
 *
 * A student builds MLS1 (`mlswitch.nfc3650-24`) with PC2 and PC3 on switchports and R1 on Gi1/0/24, then types
 * `no switchport` and an address on Gi1/0/24 and creates Loopback0. The router pings both addresses, and an ARP flood
 * from PC2 no longer reaches the routed port. `switchport` withdraws the connected and local routes with a
 * `role-change` port event and flooding resumes. An access switch refuses `no switchport` with the role-locked
 * message. `no switchport` survives save and reload and export and load; the built-in Vlan1 cannot be removed.
 */
import { describe, expect, it } from 'vitest';
import { CLI_MESSAGES } from '../src/contracts/cli.js';
import type { Simulation } from '../src/contracts/simulation.js';
import { SEC } from '../src/contracts/time.js';
import { VIRTUAL_PORT_MESSAGES } from '../src/device/ports.js';
import { pcConfig } from '../src/sim/scenarios.js';
import { createSimulation } from '../src/sim/simulation.js';
import { console, ofKind, ping } from './sim.harness.js';
import { MASK24, cable, device, topology, typeLines } from './accept.p05.harness.js';

const ROUTED = 'GigabitEthernet1/0/24';
const MLS_LINES = [
  'enable',
  'configure terminal',
  `interface ${ROUTED}`,
  'no switchport',
  'ip address 10.1.1.1 255.255.255.0',
  'exit',
  'interface Loopback0',
  'ip address 10.9.9.1 255.255.255.255',
  'end',
];
const R1_LINES = [
  'enable',
  'configure terminal',
  'interface GigabitEthernet0/0',
  'ip address 10.1.1.2 255.255.255.0',
  'no shutdown',
  'exit',
  'ip route 10.9.9.1 255.255.255.255 10.1.1.1',
  'end',
];

/** MLS1 with PC2 and PC3 on switchports and an unconfigured R1 cabled to Gi1/0/24, booted. */
function campus(seed = 3): Simulation {
  const sim = createSimulation({ seed });
  sim.loadTopology(
    topology(
      [
        device('mls1', 'mlswitch.nfc3650-24', 'MLS1', 300, 150),
        device('r1', 'router.nf2911', 'R1', 560, 150),
        device('pc2', 'pc.nfpc', 'PC2', 100, 320, pcConfig('PC2', '10.5.0.2', MASK24)),
        device('pc3', 'pc.nfpc', 'PC3', 260, 360, pcConfig('PC3', '10.5.0.3', MASK24)),
      ],
      [
        cable('l_pc2_mls1', 'pc2', 'GigabitEthernet0', 'mls1', 'GigabitEthernet1/0/1'),
        cable('l_pc3_mls1', 'pc3', 'GigabitEthernet0', 'mls1', 'GigabitEthernet1/0/2'),
        cable('l_mls1_r1', 'mls1', ROUTED, 'r1', 'GigabitEthernet0/0'),
      ],
    ),
  );
  sim.runFor(60 * SEC);
  return sim;
}

/** Ports of MLS1 that an ARP flood from PC2 (a ping to an absent host) went out of, in first-use order. */
function floodPorts(sim: Simulation): string[] {
  const flood = ping(sim, 'pc2', '10.5.0.99');
  expect(flood.text).toContain('received 0');
  return [...new Set(ofKind(flood.evs, 'frameTx').filter((e) => e.from.device === 'mls1').map((e) => e.from.port))];
}

describe('accept P0.5: multilayer switch routed port', () => {
  it('makes Gi1/0/24 a routed port that a router pings, and stops flooding onto it', () => {
    const sim = campus();
    console(sim, 'r1', R1_LINES);
    sim.runFor(5 * SEC);
    expect(floodPorts(sim)).toEqual(['GigabitEthernet1/0/2', ROUTED]);

    const cursor = sim.trace(0).next;
    console(sim, 'mls1', MLS_LINES);
    const port = sim.device('mls1')!.port(ROUTED)!;
    expect(port.role).toBe('routed');
    expect(port.l3.ipv4).toEqual({ address: '10.1.1.1', prefixLen: 24 });
    const changes = ofKind(sim.trace(cursor).events, 'portState').filter((e) => e.device === 'mls1' && e.port === ROUTED);
    expect(changes.map((e) => e.reason)).toContain('role-change');
    expect(sim.snapshot().devices.find((d) => d.id === 'mls1')!.ports.find((p) => p.id === ROUTED)).toMatchObject({
      role: 'routed',
      allowedRoles: ['switched', 'routed'],
    });
    expect(sim.device('mls1')!.port('Loopback0')).toMatchObject({ role: 'virtual', operUp: true, l3: { ipv4: { address: '10.9.9.1', prefixLen: 32 } } });

    expect(ping(sim, 'r1', '10.1.1.1').text).toContain('Sent 5, received 5, lost 0');
    expect(ping(sim, 'r1', '10.9.9.1').text).toContain('Sent 5, received 5, lost 0');
    const routes = console(sim, 'mls1', ['show ip route']).results[0]!.output;
    expect(routes).toMatch(/^C\s+10\.1\.1\.0\/24\s+connected\s+GigabitEthernet1\/0\/24$/m);
    expect(routes).toMatch(/^L\s+10\.1\.1\.1\/32\s+connected\s+GigabitEthernet1\/0\/24$/m);
    expect(routes).toMatch(/^L\s+10\.9\.9\.1\/32\s+connected\s+Loopback0$/m);

    expect(floodPorts(sim)).toEqual(['GigabitEthernet1/0/2']);
  });

  it('withdraws the connected and local routes with a role-change port event when the port switches again', () => {
    const sim = campus();
    console(sim, 'r1', R1_LINES);
    console(sim, 'mls1', MLS_LINES);
    sim.runFor(5 * SEC);
    expect(sim.device('mls1')!.tables.rib.rows().filter((r) => r.iface === ROUTED)).toHaveLength(2);

    const cursor = sim.trace(0).next;
    console(sim, 'mls1', ['enable', 'configure terminal', `interface ${ROUTED}`, 'switchport', 'end']);
    const evs = sim.trace(cursor).events;
    const expired = ofKind(evs, 'tableExpire').filter((e) => e.device === 'mls1' && e.table === 'rib');
    expect(expired.map((e) => e.key)).toEqual(['10.1.1.0/24', '10.1.1.1/32']);
    const roleChange = evs.findIndex((e) => e.kind === 'portState' && e.device === 'mls1' && e.port === ROUTED && e.reason === 'role-change');
    expect(roleChange).toBeGreaterThanOrEqual(0);
    for (const e of expired) expect(evs.indexOf(e)).toBeLessThan(roleChange);

    const mls = sim.device('mls1')!;
    expect(mls.port(ROUTED)!.role).toBe('switched');
    expect(mls.port(ROUTED)!.l3.ipv4).toBeUndefined();
    expect(mls.tables.rib.rows().map((r) => `${r.source} ${r.network}/${r.prefixLen}`)).toEqual(['L 10.9.9.1/32']);
    expect(console(sim, 'mls1', ['enable', `show running-config | section ${ROUTED}`]).results[1]!.output).toBe(`interface ${ROUTED}\n`);
    expect(floodPorts(sim)).toEqual(['GigabitEthernet1/0/2', ROUTED]);
  });

  it('refuses no switchport on an access switch port with the role-locked message', () => {
    const sim = createSimulation({ seed: 3 });
    sim.addDevice({ id: 'sw1', type: 'switch.nfc2960', name: 'SW1' });
    sim.runFor(60 * SEC);
    const typed = typeLines(sim, 'sw1', ['enable', 'configure terminal', 'interface FastEthernet0/1', 'no switchport']).results;
    expect(typed.slice(0, 3).map((r) => r.error)).toEqual([undefined, undefined, undefined]);
    expect(typed[3]!.error?.message).toBe(CLI_MESSAGES.roleLocked);
    expect(typed[3]!.output).toContain(CLI_MESSAGES.roleLocked);

    const headless = sim.configure('sw1', ['interface FastEthernet0/1', 'no switchport']);
    expect(headless.lines[1]).toMatchObject({ ok: false, error: { message: CLI_MESSAGES.roleLocked } });
    expect(sim.device('sw1')!.port('FastEthernet0/1')!.role).toBe('switched');
    expect(sim.device('sw1')!.running.render()).not.toContain('no switchport');
  });

  it('keeps no switchport across save and reload and across export and load, and refuses to remove the built-in Vlan1', () => {
    const sim = campus();
    console(sim, 'r1', R1_LINES);
    console(sim, 'mls1', MLS_LINES);
    const saved = console(sim, 'mls1', ['enable', 'copy running-config startup-config', `show startup-config | section ${ROUTED}`]).results;
    expect(saved[2]!.output).toBe(`interface ${ROUTED}\n no switchport\n ip address 10.1.1.1 255.255.255.0\n`);

    const vlan = typeLines(sim, 'mls1', ['enable', 'configure terminal', 'no interface Vlan1']).results;
    expect(vlan[2]!.error?.message).toContain(VIRTUAL_PORT_MESSAGES.builtIn);
    expect(sim.device('mls1')!.port('Vlan1')).toBeDefined();

    console(sim, 'mls1', ['enable', 'reload']);
    expect(sim.device('mls1')!.bootedAt).toBeUndefined();
    sim.runFor(60 * SEC);
    const mls = sim.device('mls1')!;
    expect(mls.bootedAt).toBeDefined();
    expect(mls.port(ROUTED)!.role).toBe('routed');
    expect(mls.running.render()).toContain(`interface ${ROUTED}\n no switchport\n ip address 10.1.1.1 255.255.255.0\n`);
    expect(mls.port('Loopback0')!.l3.ipv4).toEqual({ address: '10.9.9.1', prefixLen: 32 });
    expect(ping(sim, 'r1', '10.9.9.1').text).toContain('Sent 5, received 5, lost 0');

    const copy = createSimulation({ seed: 3 });
    copy.loadTopology(sim.exportTopology());
    copy.runFor(60 * SEC);
    expect(copy.device('mls1')!.port(ROUTED)!.role).toBe('routed');
    expect(copy.device('mls1')!.port('Loopback0')!.l3.ipv4).toEqual({ address: '10.9.9.1', prefixLen: 32 });
    expect(ping(copy, 'r1', '10.1.1.1').text).toContain('Sent 5, received 5, lost 0');
    expect(ping(copy, 'r1', '10.9.9.1').text).toContain('Sent 5, received 5, lost 0');
  });
});
