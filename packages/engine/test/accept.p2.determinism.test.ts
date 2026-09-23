/**
 * P2 acceptance — determinism (ARCHITECTURE-P2 §10.1 `accept.p2.determinism`; §4, §7 W4 qa).
 *
 * A composite P2 world built with `createP2Simulation` (§0 rule 13) in the P2 profile, with every approved W1–W3
 * daemon factory laid over the registry — what the real catalog holds once the W4 flip has landed:
 *   • PVST+ on two NF-C2960 (the P2 default) with VLANs 10 and 20;
 *   • an LACP channel (Port-channel1, active/passive) between them, trunked;
 *   • a trunk from SW1 to R1 and router-on-a-stick subinterfaces Gi0/0.10 / Gi0/0.20;
 *   • port security with sticky learning on PC1's port;
 *   • PAT on R1's outside interface towards SRV;
 *   • stateful DHCPv6 served on Gi0/0.20 to PC2.
 * Boot and convergence, two pings at the same instant through PAT, an inter-VLAN ping over the channel, then
 * `runToIdle`: three runs with one seed give byte-identical trace and snapshot JSON, and `runToIdle` terminates.
 */
import { describe, expect, it } from 'vitest';
import type { ProcessFactory } from '../src/contracts/process.js';
import type { RunStats, Simulation } from '../src/contracts/simulation.js';
import type { SimSnapshot } from '../src/contracts/snapshot.js';
import type { EtherchannelRow, NatRow, StpBridgeRow } from '../src/contracts/tables.js';
import { SEC } from '../src/contracts/time.js';
import type { TraceEvent } from '../src/contracts/trace.js';
import { createDhcpv6Client } from '../src/protocols/dhcpv6-client.js';
import { createDhcpv6Server } from '../src/protocols/dhcpv6-server.js';
import { createDtp } from '../src/protocols/dtp.js';
import { createEtherchannel } from '../src/protocols/etherchannel.js';
import { createHsrp } from '../src/protocols/hsrp.js';
import { createNat } from '../src/protocols/nat.js';
import { createStp } from '../src/protocols/stp.js';
import { createVlan } from '../src/protocols/vlan.js';
import { configText, section } from '../src/sim/scenarios/kit.js';
import { pcConfig } from '../src/sim/scenarios/templates.js';
import { createP2Simulation, type P2FactoryOverlay } from './p2.world.js';
import { ofKind, output } from './sim.harness.js';

const SEED = 20_260_922;
const GI0 = 'GigabitEthernet0/0';
const GI1 = 'GigabitEthernet0/1';
const SW_GI1 = 'GigabitEthernet0/1';
const SW_GI2 = 'GigabitEthernet0/2';
const FA1 = 'FastEthernet0/1';
const FA24 = 'FastEthernet0/24';
const PC = 'GigabitEthernet0';
const PO1 = 'Port-channel1';
const MASK24 = '255.255.255.0';
const SRV = '203.0.113.10';
const PC2_V4 = '192.168.20.10';
const PAT_RULE = `ip nat inside source list 1 interface ${GI1} overload`;
/**
 * Switch boot, the 30 s PVST+ forward delay, the LACP bundle — and R1's next periodic router advertisement: PC2's
 * router solicitations at link-up are lost while its port and the channel are still in the forward delay (the P2
 * default has no PortFast, exactly as on real equipment), so the stateful DHCPv6 exchange starts on the periodic RA
 * (a fixed 200 s timer of nd) rather than on the solicited one.
 */
const BOOT = 260 * SEC;
const IDLE_CAP = 500_000;

/** Every approved W1–W3 daemon with its real factory (the W4 flip registers exactly these; capwap-* arrive in W5). */
function p2Daemons(): P2FactoryOverlay {
  const out: Record<string, ProcessFactory> = {
    vlan: createVlan,
    dtp: createDtp,
    etherchannel: createEtherchannel,
    stp: createStp,
    nat: createNat,
    hsrp: createHsrp,
    'dhcpv6-client': createDhcpv6Client,
    'dhcpv6-server': createDhcpv6Server,
  };
  return out;
}

/** A switch with VLANs 10 and 20, a trunked Port-channel1 of Gi0/1–2 (`mode`), and the given extra sections. */
function switchConfig(hostname: string, mode: 'active' | 'passive', extra: readonly (readonly string[])[]): string {
  return configText([
    [`hostname ${hostname}`],
    section('vlan 10', ['name STAFF']),
    section('vlan 20', ['name GUESTS']),
    section(`interface ${PO1}`, ['switchport mode trunk']),
    section(`interface ${SW_GI1}`, ['switchport mode trunk', `channel-group 1 mode ${mode}`]),
    section(`interface ${SW_GI2}`, ['switchport mode trunk', `channel-group 1 mode ${mode}`]),
    ...extra,
  ]);
}

const SW1_CONFIG = switchConfig('SW1', 'active', [
  section(`interface ${FA24}`, ['switchport mode trunk']),
  section(`interface ${FA1}`, ['switchport mode access', 'switchport access vlan 10', 'switchport port-security', 'switchport port-security mac-address sticky']),
]);
const SW2_CONFIG = switchConfig('SW2', 'passive', [section(`interface ${FA1}`, ['switchport mode access', 'switchport access vlan 20'])]);

const R1_CONFIG = configText([
  ['hostname R1', 'ipv6 unicast-routing', 'access-list 1 permit 192.168.0.0 0.0.255.255', PAT_RULE],
  section('ipv6 dhcp pool LAN6', ['address prefix 2001:db8:20::/64 lifetime 86400 3600', 'dns-server 2001:db8:20::53', 'domain-name lab.nf']),
  section(`interface ${GI0}`, ['no shutdown']),
  section(`interface ${GI0}.10`, ['encapsulation dot1Q 10', `ip address 192.168.10.1 ${MASK24}`, 'ip nat inside']),
  section(`interface ${GI0}.20`, ['encapsulation dot1Q 20', `ip address 192.168.20.1 ${MASK24}`, 'ip nat inside', 'ipv6 address 2001:db8:20::1/64', 'ipv6 dhcp server LAN6', 'ipv6 nd managed-config-flag']),
  section(`interface ${GI1}`, [`ip address 203.0.113.1 ${MASK24}`, 'ip nat outside', 'no shutdown']),
]);

const PC2_CONFIG = configText([['hostname PC2'], section(`interface ${PC}`, [`ip address ${PC2_V4} ${MASK24}`, 'ipv6 address autoconfig']), ['ip default-gateway 192.168.20.1']]);

/** The composite world, not yet run. */
function compositeWorld(): Simulation {
  const sim = createP2Simulation({ seed: SEED, factories: p2Daemons() });
  sim.addDevice({ id: 'sw1', type: 'switch.nfc2960', name: 'SW1', startupConfig: SW1_CONFIG });
  sim.addDevice({ id: 'sw2', type: 'switch.nfc2960', name: 'SW2', startupConfig: SW2_CONFIG });
  sim.addDevice({ id: 'r1', type: 'router.nf2911', name: 'R1', startupConfig: R1_CONFIG });
  sim.addDevice({ id: 'pc1', type: 'pc.nfpc', name: 'PC1', startupConfig: pcConfig('PC1', '192.168.10.10', MASK24, '192.168.10.1') });
  sim.addDevice({ id: 'pc2', type: 'pc.nfpc', name: 'PC2', startupConfig: PC2_CONFIG });
  sim.addDevice({ id: 'srv', type: 'pc.nfpc', name: 'SRV', startupConfig: pcConfig('SRV', SRV, MASK24, '203.0.113.1') });
  sim.addLink({ id: 'l_po_a', a: { device: 'sw1', port: SW_GI1 }, b: { device: 'sw2', port: SW_GI1 } });
  sim.addLink({ id: 'l_po_b', a: { device: 'sw1', port: SW_GI2 }, b: { device: 'sw2', port: SW_GI2 } });
  sim.addLink({ id: 'l_sw1_r1', a: { device: 'sw1', port: FA24 }, b: { device: 'r1', port: GI0 } });
  sim.addLink({ id: 'l_r1_srv', a: { device: 'r1', port: GI1 }, b: { device: 'srv', port: PC } });
  sim.addLink({ id: 'l_pc1', a: { device: 'pc1', port: PC }, b: { device: 'sw1', port: FA1 } });
  sim.addLink({ id: 'l_pc2', a: { device: 'pc2', port: PC }, b: { device: 'sw2', port: FA1 } });
  return sim;
}

interface CompositeRun {
  readonly sim: Simulation;
  readonly events: TraceEvent[];
  readonly trace: string;
  readonly snapshot: SimSnapshot;
  readonly snapshotJson: string;
  /** Outputs of the three pings: PC1 → SRV, PC2 → SRV (at the same instant), PC1 → PC2. */
  readonly outputs: string[];
  readonly idle: RunStats;
}

/** Boot and converge, two pings at once through PAT, one inter-VLAN ping over the channel, run until idle. */
function runComposite(): CompositeRun {
  const sim = compositeWorld();
  sim.runFor(BOOT);
  const exec = (device: string, line: string): string => {
    const session = sim.cli.open(device, 'console');
    const r = sim.cli.exec(session, line);
    if (r.error !== undefined) throw new Error(`"${line}" on ${device}: ${r.output}`);
    return session;
  };
  const s1 = exec('pc1', `ping ${SRV}`);
  const s2 = exec('pc2', `ping ${SRV}`);
  const first = sim.runToIdle(IDLE_CAP);
  const s3 = exec('pc1', `ping ${PC2_V4}`);
  const idle = sim.runToIdle(IDLE_CAP);
  const events = sim.trace(0).events;
  const snapshot = sim.snapshot();
  return {
    sim,
    events,
    trace: JSON.stringify(events),
    snapshot,
    snapshotJson: JSON.stringify(snapshot),
    outputs: [s1, s2, s3].map((s) => output(events, s)),
    idle: { ...idle, events: idle.events + first.events, stopped: idle.stopped ?? first.stopped },
  };
}

describe('accept P2: determinism', () => {
  it('a composite P2 world (PVST+, trunk, router-on-a-stick, LACP channel, port security, PAT, DHCPv6) is byte-identical over 3 runs and runToIdle terminates', () => {
    const runs = [runComposite(), runComposite(), runComposite()];
    const first = runs[0]!;
    expect(first.idle.stopped).toBeUndefined();
    expect(first.idle.events).toBeLessThan(IDLE_CAP);
    for (const text of first.outputs) expect(text).toContain('Sent 5, received 5, lost 0');
    expect(first.sim.trace(0).dropped).toBe(0);

    // every ingredient really took part
    const sim = first.sim;
    const evs = first.events;
    const bridge = (dev: string, vlan: number) => sim.device(dev)!.tables.get<StpBridgeRow>('stp-bridge')!.get(String(vlan));
    for (const dev of ['sw1', 'sw2']) for (const vlan of [1, 10, 20]) expect(bridge(dev, vlan)).toMatchObject({ vlan, mode: 'pvst' });
    expect(bridge('sw1', 10)!.rootId).toBe(bridge('sw2', 10)!.rootId);
    const channel = (dev: string, port: string) => sim.device(dev)!.tables.get<EtherchannelRow>('etherchannel')!.get(port);
    for (const dev of ['sw1', 'sw2']) for (const port of [SW_GI1, SW_GI2]) expect(channel(dev, port)).toMatchObject({ bundle: PO1, protocol: 'lacp', state: 'bundled' });
    expect(sim.device('sw1')!.port(PO1)!.operUp).toBe(true);
    expect(ofKind(evs, 'frameTx').filter((e) => e.pdu.tag === 'lacp').length).toBeGreaterThan(0);
    expect(ofKind(evs, 'frameTx').filter((e) => e.pdu.tag === 'bpdu').length).toBeGreaterThan(0);
    expect(sim.device('sw1')!.running.render()).toMatch(/switchport port-security mac-address sticky [0-9a-f:]{17}/);
    expect(sim.device('sw1')!.tables.cam.rows().some((r) => r.port === FA1 && r.secure === 'sticky')).toBe(true);
    expect(sim.device('r1')!.port(`${GI0}.10`)).toMatchObject({ operUp: true });
    expect(sim.device('r1')!.port(`${GI0}.20`)).toMatchObject({ operUp: true });
    const nat = sim.device('r1')!.tables.get<NatRow>('nat')!.rows();
    expect(nat.map((r) => [r.proto, r.insideLocal, r.insideGlobalPort, r.kind])).toEqual([
      ['icmp', '192.168.10.10', 1, 'overload'],
      ['icmp', PC2_V4, 2, 'overload'],
    ]);
    expect(nat.every((r) => r.rule === PAT_RULE)).toBe(true);
    const leased = (sim.device('pc2')!.port(PC)!.l3.ipv6 ?? []).find((a) => a.origin === 'dhcpv6');
    expect(leased).toMatchObject({ address: '2001:db8:20::2', prefixLen: 128, state: 'preferred' });
    expect(ofKind(evs, 'pduCreated').filter((e) => e.pdu.tag?.startsWith('dhcpv6-')).map((e) => e.pdu.tag)).toEqual(['dhcpv6-solicit', 'dhcpv6-advertise', 'dhcpv6-request', 'dhcpv6-reply']);
    // the inter-VLAN echo crossed the trunk tagged and was routed between the subinterfaces
    const interVlan = ofKind(evs, 'pduCreated').filter((e) => e.device === 'pc1' && (e.pdu.tag ?? '').startsWith('ping#') && sim.pdu(e.pdu.id)?.get('ipv4.dst') === PC2_V4);
    expect(interVlan).toHaveLength(5);
    const reasons = sim.pdu(interVlan[0]!.pdu.id)!.provenance.map((m) => `${m.device}:${m.reason}`);
    expect(reasons).toContain('sw1:VlanTagPush');
    expect(reasons).toContain('r1:VlanTagPop');
    expect(reasons).toContain('r1:VlanTagPush');
    expect(reasons).toContain('sw2:VlanTagPop');
    expect(ofKind(evs, 'log').filter((e) => e.message.includes('is not available'))).toEqual([]);

    for (const run of runs.slice(1)) {
      expect(run.outputs).toEqual(first.outputs);
      expect(run.trace).toBe(first.trace);
      expect(run.snapshotJson).toBe(first.snapshotJson);
    }
  });
});
