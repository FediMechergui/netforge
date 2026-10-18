/**
 * W2a l2 [S15] (ARCHITECTURE-P3C §3.7, §4.3, §7 W2a l2): eth-switch step 7d, IP source guard, on real worlds
 * (`staged.world` at stage P3c, every P3 daemon removed, the injector as ATTACKER on Fa0/5). SW1 is configured through
 * `startupConfig` (rule 13); R1 and the PCs through their P1 grammar.
 *  - PC1 leases through a guarded Fa0/1 (DHCP client messages are exempt), is bound, and pings (ARP is exempt, its
 *    bound source passes);
 *  - ATTACKER's IPv4 from its bound address passes; from any other address it drops `ip-source-guard` at step 7d with
 *    the exact detail, rule (pointing at the interface line) and debug line, and never reaches R1;
 *  - with `ip verify source port-security`, the bound address from another Ethernet source drops (the rule names the
 *    binding), the bound pair passes;
 *  - without snooping on the VLAN nothing is filtered and a debug line says why;
 *  - a guarded port with no line on any other port leaves every other port's traffic unchanged (no 7d debug);
 *  - two runs with one seed are byte-identical.
 */
import { describe, expect, it } from 'vitest';
import type { LayerSpec } from '../src/contracts/pdu.js';
import { ETHERTYPE_IPV4, IPPROTO_UDP } from '../src/contracts/pdu.js';
import type { ProcessFactory } from '../src/contracts/process.js';
import type { Simulation } from '../src/contracts/simulation.js';
import { SEC } from '../src/contracts/time.js';
import type { TraceEvent } from '../src/contracts/trace.js';
import { SOURCE_GUARD_DEBUG_CATEGORY } from '../src/protocols/l2/source-guard.js';
import { INJECTED_TAG, INJECTOR_HOST_TYPE, injectFrames, withInjector } from './inject.js';
import { ofKind, ping } from './sim.harness.js';
import { P3_DAEMONS, createStagedSimulation, type StagedFactoryOverlay } from './staged.world.js';

const FA1 = 'FastEthernet0/1';
const FA5 = 'FastEthernet0/5';
const GI1 = 'GigabitEthernet0/1';
const PC_PORT = 'GigabitEthernet0';
const INJ_PORT = 'GigabitEthernet0';
/** ATTACKER's MAC, bound to 192.168.10.12 on Fa0/5 by a static binding. */
const A = '02:4e:66:00:00:05';
/** Another Ethernet source. */
const B = '02:4e:66:00:00:0b';
const BOOT = 120 * SEC;

function noP3(): StagedFactoryOverlay {
  const out: Record<string, ProcessFactory | undefined> = {};
  for (const p of P3_DAEMONS) out[p] = undefined;
  return out;
}

function configText(sections: readonly (readonly string[])[]): string {
  return [...sections.flatMap((s) => [...s, '!']), 'end', ''].join('\n');
}

/** SW1: VLAN 10 on Fa0/1 and Fa0/5, the trunk trusted; `snooping` false drops `ip dhcp snooping vlan 10`. */
function sw1Config(o: { fa1?: readonly string[]; fa5?: readonly string[]; snooping?: boolean } = {}): string {
  const access = (port: string, more: readonly string[] = []): string[] => [
    `interface ${port}`, ' switchport mode access', ' switchport access vlan 10', ' spanning-tree portfast', ...more.map((l) => ` ${l}`),
  ];
  return configText([
    ['hostname SW1'],
    ['vlan 10'],
    access(FA1, o.fa1 ?? []),
    access(FA5, o.fa5 ?? []),
    [`interface ${GI1}`, ' switchport mode trunk', ' ip dhcp snooping trust'],
    ['ip dhcp snooping', ...(o.snooping === false ? [] : ['ip dhcp snooping vlan 10']), `ip source binding ${A} vlan 10 192.168.10.12 interface ${FA5}`],
  ]);
}

const R1_LINES: readonly string[] = [
  'interface GigabitEthernet0/0',
  'no shutdown',
  'exit',
  'interface GigabitEthernet0/0.10',
  'encapsulation dot1q 10',
  'ip address 192.168.10.1 255.255.255.0',
  'exit',
  'ip dhcp excluded-address 192.168.10.1 192.168.10.10',
  'ip dhcp pool V10',
  'network 192.168.10.0 255.255.255.0',
  'default-router 192.168.10.1',
  'exit',
];

function configured(sim: Simulation, dev: string, lines: readonly string[]): void {
  const r = sim.configure(dev, lines);
  if (!r.ok) throw new Error(`${dev} setup failed: ${JSON.stringify(r.lines.filter((l) => !l.ok))}`);
}

/** The world: booted, R1 serving the pool, PC1 leased on Fa0/1; ATTACKER on Fa0/5. */
function world(o: { seed?: number; sw?: string } = {}): Simulation {
  const sim = createStagedSimulation({ seed: o.seed ?? 5, stage: 'P3c', factories: withInjector(noP3()) });
  sim.addDevice({ id: 'sw1', type: 'switch.nfc2960', name: 'SW1', startupConfig: o.sw ?? sw1Config() });
  sim.addDevice({ id: 'r1', type: 'router.nf2911', name: 'R1' });
  sim.addDevice({ id: 'pc1', type: 'pc.nfpc', name: 'PC1' });
  sim.addDevice({ id: 'attacker', type: INJECTOR_HOST_TYPE, name: 'ATTACKER' });
  sim.addLink({ id: 'l_pc1', a: { device: 'pc1', port: PC_PORT }, b: { device: 'sw1', port: FA1 } });
  sim.addLink({ id: 'l_att', a: { device: 'attacker', port: INJ_PORT }, b: { device: 'sw1', port: FA5 } });
  sim.addLink({ id: 'l_r1', a: { device: 'sw1', port: GI1 }, b: { device: 'r1', port: 'GigabitEthernet0/0' } });
  sim.runFor(BOOT);
  configured(sim, 'r1', R1_LINES);
  sim.runToIdle();
  configured(sim, 'pc1', ['ip address dhcp']);
  sim.runToIdle();
  return sim;
}

/** A UDP datagram from `src`/`mac` to R1 (port 9), untagged. */
function udpFrame(src: string, mac: string = A): LayerSpec[] {
  return [
    { proto: 'ethernet', fields: { dst: 'ff:ff:ff:ff:ff:ff', src: mac, type: ETHERTYPE_IPV4 } },
    { proto: 'ipv4', fields: { src, dst: '192.168.10.1', protocol: IPPROTO_UDP, ttl: 64 } },
    { proto: 'udp', fields: { srcPort: 5000, dstPort: 9 } },
  ];
}

const guardDrops = (evs: readonly TraceEvent[]): Extract<TraceEvent, { kind: 'drop' }>[] => ofKind(evs, 'drop').filter((e) => e.reason === 'ip-source-guard');
const guardDebug = (evs: readonly TraceEvent[]): string[] =>
  ofKind(evs, 'debug').filter((e) => e.event.category === SOURCE_GUARD_DEBUG_CATEGORY).map((e) => e.event.message);
const injectedRxAt = (evs: readonly TraceEvent[], dev: string): number =>
  ofKind(evs, 'frameRx').filter((e) => e.device === dev && e.pdu.tag === INJECTED_TAG).length;

function inject(sim: Simulation, frames: readonly (readonly LayerSpec[])[]): TraceEvent[] {
  const t0 = sim.trace(0).next;
  injectFrames(sim, { from: 'attacker', port: INJ_PORT, frames, spacingNs: 0 });
  sim.runToIdle();
  return sim.trace(t0).events;
}

describe('step 7d: IP source guard (§3.7)', () => {
  it('a guarded port still leases (DHCP client messages exempt) and pings from its bound address (ARP exempt)', () => {
    const sim = world({ sw: sw1Config({ fa1: ['ip verify source'], fa5: ['ip verify source'] }) });
    expect(sim.device('pc1')!.port(PC_PORT)!.l3.ipv4).toMatchObject({ address: '192.168.10.11', origin: 'dhcp' });
    const t0 = sim.trace(0).next;
    expect(ping(sim, 'pc1', '192.168.10.1').text).toMatch(/!!!!!/);
    expect(guardDrops(sim.trace(0).events)).toEqual([]);
    expect(guardDebug(sim.trace(t0).events)).toEqual([]);
  });

  it('forwards the bound source and drops any other source with its detail, rule and debug line', () => {
    const sim = world({ sw: sw1Config({ fa5: ['ip verify source'] }) });
    const ok = inject(sim, [udpFrame('192.168.10.12')]);
    expect(guardDrops(ok)).toEqual([]);
    expect(injectedRxAt(ok, 'r1')).toBe(1);

    const bad = inject(sim, [udpFrame('192.168.10.99')]);
    const d = guardDrops(bad);
    expect(d).toHaveLength(1);
    expect(d[0]).toMatchObject({
      device: 'sw1', port: FA5,
      detail: `IPv4 source 192.168.10.99 (MAC ${A}) on ${FA5} (vlan 10) has no source binding on this port`,
    });
    expect(d[0]!.pdu.tag).toBe(INJECTED_TAG);
    expect(d[0]!.rule).toEqual({
      kind: 'ip-source-guard',
      text: 'with "ip verify source" a port forwards only IPv4 packets whose source address matches a DHCP snooping or static source binding on that port and VLAN',
      iface: FA5,
      config: { context: [['interface', FA5]], line: ['ip', 'verify', 'source'] },
    });
    expect(guardDebug(bad)).toEqual([`dropped IPv4 from 192.168.10.99 (${A}) on ${FA5} (vlan 10): no binding`]);
    expect(injectedRxAt(bad, 'r1')).toBe(0);
    // the dropped frame was not learned either (7d runs before step 8): only the static binding's MAC is known on Fa0/5
    expect(sim.device('sw1')!.tables.cam.find((r) => r.port === FA5).map((r) => r.mac)).toEqual([A]);
  });

  it('with "port-security" the bound address from another Ethernet source drops; the bound pair passes', () => {
    const sim = world({
      sw: sw1Config({ fa5: ['switchport port-security', 'switchport port-security maximum 2', 'ip verify source port-security'] }),
    });
    const evs = inject(sim, [udpFrame('192.168.10.12', B), udpFrame('192.168.10.12', A)]);
    const d = guardDrops(evs);
    expect(d).toHaveLength(1);
    expect(d[0]!.detail).toBe(`IPv4 source 192.168.10.12 on ${FA5} (vlan 10) is bound to another MAC address than ${B}; the port filters on address and MAC`);
    expect(d[0]!.rule).toEqual({
      kind: 'ip-source-guard',
      text: 'with "ip verify source port-security" a port forwards only IPv4 packets whose source address and Ethernet source match a DHCP snooping or static source binding on that port and VLAN',
      iface: FA5,
      config: { context: [['interface', FA5]], line: ['ip', 'verify', 'source', 'port-security'] },
      table: 'dhcp-snooping',
      key: `10|${A}`,
    });
    expect(guardDebug(evs)).toEqual([`dropped IPv4 from 192.168.10.12 (${B}) on ${FA5} (vlan 10): the binding names another MAC`]);
    expect(injectedRxAt(evs, 'r1')).toBe(1);
  });

  it('without snooping on the VLAN nothing is filtered, and a debug line says why', () => {
    const sim = createStagedSimulation({ seed: 5, stage: 'P3c', factories: withInjector(noP3()) });
    sim.addDevice({ id: 'sw1', type: 'switch.nfc2960', name: 'SW1', startupConfig: sw1Config({ fa5: ['ip verify source'], snooping: false }) });
    sim.addDevice({ id: 'r1', type: 'router.nf2911', name: 'R1' });
    sim.addDevice({ id: 'attacker', type: INJECTOR_HOST_TYPE, name: 'ATTACKER' });
    sim.addLink({ id: 'l_att', a: { device: 'attacker', port: INJ_PORT }, b: { device: 'sw1', port: FA5 } });
    sim.addLink({ id: 'l_r1', a: { device: 'sw1', port: GI1 }, b: { device: 'r1', port: 'GigabitEthernet0/0' } });
    sim.runFor(BOOT);
    configured(sim, 'r1', R1_LINES);
    sim.runToIdle();
    const evs = inject(sim, [udpFrame('192.168.10.99')]);
    expect(guardDrops(evs)).toEqual([]);
    expect(injectedRxAt(evs, 'r1')).toBe(1);
    expect(guardDebug(evs)).toEqual([`${FA5} (vlan 10): IP source guard is configured but DHCP snooping is off for vlan 10; nothing is filtered`]);
  });

  it('an unguarded port is not judged: no 7d drop or debug line for its spoofed source', () => {
    const sim = world({ sw: sw1Config({ fa1: ['ip verify source'] }) });
    const evs = inject(sim, [udpFrame('192.168.10.99')]);
    expect(guardDrops(evs)).toEqual([]);
    expect(guardDebug(evs)).toEqual([]);
    expect(injectedRxAt(evs, 'r1')).toBe(1);
  });
});

describe('determinism', () => {
  it('two runs with one seed (a guarded lease, a pass and a drop) are byte-identical', () => {
    const run = (): string => {
      const sim = world({ seed: 13, sw: sw1Config({ fa1: ['ip verify source'], fa5: ['ip verify source'] }) });
      ping(sim, 'pc1', '192.168.10.1');
      inject(sim, [udpFrame('192.168.10.12'), udpFrame('192.168.10.99')]);
      return JSON.stringify([sim.trace(0).events, sim.snapshot()]);
    };
    expect(run()).toBe(run());
  });
});
