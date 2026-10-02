/**
 * W2 l2 (ARCHITECTURE-P3 §4.3 row "eth-switch steps 7b/7c", §4.6, §9.1 `l2.eth-switch.test.ts`; §7 W2 l2): without
 * the snooping lines eth-switch takes the P2 path — traffic, trace, StateView and every debug line byte-identical.
 *  - the same world and workload (DHCP DORA, pings, a link-down, cam-sweeps, and injected DHCP server messages, a
 *    spoofing ARP burst and a client message whose chaddr is not its source: every frame 7b/7c would act on) runs on
 *    the P2-stage catalog (no snooping tables: the P2 code path) and on the P3-stage catalog (NF-C2960 declares
 *    `dhcp-snooping` and `arp-inspection`, the P3 daemons removed, profile P2): the whole trace, SW1's eth-switch
 *    StateView and its debug ring are identical, and nothing is written to the two tables;
 *  - on the P3-stage catalog, the lines for a VLAN that carries no traffic (`ip dhcp snooping`, `ip dhcp snooping vlan
 *    99`, `ip arp inspection vlan 99`, trust and limits on ports) change nothing but their own configChange events.
 */
import { describe, expect, it } from 'vitest';
import type { BuildStage, DefaultsProfile } from '../src/contracts/catalog.js';
import type { ProcessFactory } from '../src/contracts/process.js';
import type { Simulation } from '../src/contracts/simulation.js';
import { MS, SEC } from '../src/contracts/time.js';
import type { TraceEvent } from '../src/contracts/trace.js';
import { ETH_SWITCH_PROCESS } from '../src/protocols/eth-switch.js';
import { INJECTOR_HOST_TYPE, arpFrame, dhcpServerFrame, injectFrames, withInjector } from './inject.js';
import { ofKind } from './sim.harness.js';
import { P3_DAEMONS, createStagedSimulation, type StagedFactoryOverlay } from './staged.world.js';

const FA1 = 'FastEthernet0/1';
const FA2 = 'FastEthernet0/2';
const FA24 = 'FastEthernet0/24';
const GI1 = 'GigabitEthernet0/1';
const PC_PORT = 'GigabitEthernet0';
const INJ_PORT = 'GigabitEthernet0';
const ROGUE_MAC = '02:4e:77:00:00:24';
const BOOT = 120 * SEC;

function noP3(): StagedFactoryOverlay {
  const out: Record<string, ProcessFactory | undefined> = {};
  for (const p of P3_DAEMONS) out[p] = undefined;
  return out;
}

function configText(sections: readonly (readonly string[])[]): string {
  return [...sections.flatMap((s) => [...s, '!']), 'end', ''].join('\n');
}

/** The snooping and DAI lines for VLAN 99, which carries nothing in this world. */
const VLAN99_LINES: readonly (readonly string[])[] = [
  ['vlan 99'],
  ['ip dhcp snooping', 'ip dhcp snooping vlan 99', 'ip arp inspection vlan 99', `ip source binding 02:4e:66:00:00:05 vlan 99 192.168.99.12 interface ${FA2}`],
  [`interface ${FA24}`, ' ip dhcp snooping limit rate 1', ' ip arp inspection limit rate 1'],
  [`interface ${GI1}`, ' ip dhcp snooping trust', ' ip arp inspection trust'],
];

function sw1Config(extra: readonly (readonly string[])[] = []): string {
  return configText([['hostname SW1'], ...extra]);
}

function configured(sim: Simulation, dev: string, lines: readonly string[]): void {
  const r = sim.configure(dev, lines);
  if (!r.ok) throw new Error(`${dev} setup failed: ${JSON.stringify(r.lines.filter((l) => !l.ok))}`);
}

/** Build, boot and drive one world; returns it after the whole workload. */
function run(stage: BuildStage, profile: DefaultsProfile, sw: string, seed = 21): Simulation {
  const sim = createStagedSimulation({ seed, stage, profile, factories: withInjector(stage === 'P3' ? noP3() : {}) });
  sim.addDevice({ id: 'sw1', type: 'switch.nfc2960', name: 'SW1', startupConfig: sw });
  sim.addDevice({ id: 'r1', type: 'router.nf2911', name: 'R1' });
  sim.addDevice({ id: 'pc1', type: 'pc.nfpc', name: 'PC1' });
  sim.addDevice({
    id: 'pc2', type: 'pc.nfpc', name: 'PC2',
    startupConfig: configText([['hostname PC2'], ['interface GigabitEthernet0', ' ip address 192.168.1.50 255.255.255.0'], ['ip default-gateway 192.168.1.1']]),
  });
  sim.addDevice({ id: 'rogue', type: INJECTOR_HOST_TYPE, name: 'ROGUE' });
  sim.addLink({ id: 'l_pc1', a: { device: 'pc1', port: PC_PORT }, b: { device: 'sw1', port: FA1 } });
  sim.addLink({ id: 'l_pc2', a: { device: 'pc2', port: PC_PORT }, b: { device: 'sw1', port: FA2 } });
  sim.addLink({ id: 'l_rogue', a: { device: 'rogue', port: INJ_PORT }, b: { device: 'sw1', port: FA24 } });
  sim.addLink({ id: 'l_r1', a: { device: 'sw1', port: GI1 }, b: { device: 'r1', port: 'GigabitEthernet0/0' } });
  sim.runFor(BOOT);
  configured(sim, 'r1', [
    'interface GigabitEthernet0/0', 'ip address 192.168.1.1 255.255.255.0', 'no shutdown', 'exit',
    'ip dhcp excluded-address 192.168.1.1 192.168.1.10',
    'ip dhcp pool LAN', 'network 192.168.1.0 255.255.255.0', 'default-router 192.168.1.1', 'exit',
  ]);
  sim.runToIdle();
  configured(sim, 'pc1', ['ip address dhcp']);
  sim.runToIdle();
  for (const [dev, target] of [['pc1', '192.168.1.1'], ['pc2', '192.168.1.11'], ['pc2', '192.168.1.1']] as const) {
    const s = sim.cli.open(dev, 'console');
    sim.cli.exec(s, `ping ${target}`);
    sim.runToIdle();
  }
  const pc1 = sim.device('pc1')!.port(PC_PORT)!.mac;
  // every frame kind steps 7b/7c would act on: server messages (a burst over a limit of 1), a spoofing ARP burst,
  // a client message naming another client
  injectFrames(sim, {
    from: 'rogue', port: INJ_PORT, count: 11, spacingNs: 10 * MS,
    frames: [
      dhcpServerFrame({ srcMac: ROGUE_MAC, serverIp: '10.66.0.1', chaddr: pc1, yiaddr: '10.66.0.20' }),
      dhcpServerFrame({ srcMac: ROGUE_MAC, serverIp: '10.66.0.1', chaddr: pc1, yiaddr: '10.66.0.20', type: 'ACK' }),
    ],
  });
  sim.runToIdle();
  injectFrames(sim, { from: 'rogue', port: INJ_PORT, count: 20, spacingNs: 10 * MS, frames: [arpFrame({ sha: ROGUE_MAC, spa: '192.168.1.1' })] });
  sim.runToIdle();
  injectFrames(sim, {
    from: 'rogue', port: INJ_PORT, spacingNs: 0,
    frames: [[
      { proto: 'ethernet', fields: { dst: 'ff:ff:ff:ff:ff:ff', src: ROGUE_MAC, type: 0x0800 } },
      { proto: 'ipv4', fields: { src: '0.0.0.0', dst: '255.255.255.255', protocol: 17, ttl: 64 } },
      { proto: 'udp', fields: { srcPort: 68, dstPort: 67 } },
      { proto: 'dhcp', fields: { op: 1, xid: 9, broadcastFlag: true, chaddr: '02:4e:99:00:00:99', messageType: 'DISCOVER' } },
    ]],
  });
  sim.runToIdle();
  // PC2's link goes down (link-down flushes its fresh CAM row); the cam-sweep then ages the others
  sim.removeLink('l_pc2');
  sim.runFor(330 * SEC);
  return sim;
}

const swState = (sim: Simulation): string => {
  const p = sim.device('sw1')!.processes.get(ETH_SWITCH_PROCESS)!;
  return JSON.stringify([p.stateSnapshot(), p.debugEvents()]);
};
const newTables = (evs: readonly TraceEvent[]): TraceEvent[] =>
  evs.filter((e) => (e.kind === 'tableWrite' || e.kind === 'tableExpire') && (e.table === 'dhcp-snooping' || e.table === 'arp-inspection'));
const newDebug = (evs: readonly TraceEvent[]): TraceEvent[] =>
  ofKind(evs, 'debug').filter((e) => e.event.category === 'ip dhcp snooping' || e.event.category === 'ip arp inspection');

describe('eth-switch without the snooping lines takes the P2 path (§4.3)', () => {
  it('P2-stage and P3-stage catalogs: the whole trace, the StateView and the debug ring are byte-identical', () => {
    const p2 = run('P2', 'P2', sw1Config());
    const p3 = run('P3', 'P2', sw1Config());
    // the P3-stage switch declares the two tables (the stage-filtered derivation), the P2-stage one does not
    expect(p3.device('sw1')!.model.tables).toEqual(expect.arrayContaining(['dhcp-snooping', 'arp-inspection']));
    expect(p2.device('sw1')!.model.tables).not.toContain('dhcp-snooping');
    const t2 = p2.trace(0);
    const t3 = p3.trace(0);
    expect(t2.dropped).toBe(0);
    expect(t3.dropped).toBe(0);
    // the workload did exercise the path: DHCP, ARP, injected frames, a link-down and ageing
    expect(ofKind(t3.events, 'frameRx').some((e) => e.device === 'sw1' && e.pdu.tag === 'injected' && e.pdu.proto === 'dhcp')).toBe(true);
    expect(ofKind(t3.events, 'tableExpire').some((e) => e.device === 'sw1' && e.table === 'cam' && e.reason === 'link-down')).toBe(true);
    expect(ofKind(t3.events, 'tableExpire').some((e) => e.device === 'sw1' && e.table === 'cam' && e.reason === 'aged')).toBe(true);
    expect(JSON.stringify(t3.events)).toBe(JSON.stringify(t2.events));
    expect(swState(p3)).toBe(swState(p2));
    expect(newTables(t3.events)).toEqual([]);
    expect(newDebug(t3.events)).toEqual([]);
    expect(p3.device('sw1')!.tables.get('dhcp-snooping')!.size).toBe(0);
    expect(p3.device('sw1')!.tables.get('arp-inspection')!.size).toBe(0);
  });

  it('P3-stage catalog: lines for a VLAN without traffic change nothing but their own configChange events', () => {
    const plain = run('P3', 'P2', sw1Config());
    const lined = run('P3', 'P2', sw1Config(VLAN99_LINES));
    const isOwnLine = (e: TraceEvent): boolean => e.kind === 'configChange' && e.device === 'sw1'
      && (/snooping|inspection|source binding/.test(e.line) || e.line === 'vlan 99');
    const without = (evs: readonly TraceEvent[]): TraceEvent[] => evs.filter((e) => !isOwnLine(e));
    const lines = lined.trace(0).events.filter(isOwnLine);
    expect(lines.length).toBeGreaterThanOrEqual(9);
    // the VLAN 99 static binding is the only row (configuration, not traffic); its write is the one extra event
    const seen = new Set(plain.trace(0).events.map((e) => JSON.stringify(e)));
    const extra = lined.trace(0).events.filter((e) => !isOwnLine(e) && !seen.has(JSON.stringify(e)));
    const isStaticWrite = (e: TraceEvent): boolean => e.kind === 'tableWrite' && e.table === 'dhcp-snooping' && e.key === '99|02:4e:66:00:00:05';
    const isStaticDebug = (e: TraceEvent): boolean => e.kind === 'debug' && e.event.category === 'ip dhcp snooping' && e.event.message.startsWith('static binding 02:4e:66:00:00:05');
    const isVlanRow = (e: TraceEvent): boolean => (e.kind === 'tableWrite' && e.table === 'vlans' && e.key.endsWith('99')) || (e.kind === 'debug' && e.event.process === 'vlan');
    expect(extra.filter((e) => !isStaticWrite(e) && !isStaticDebug(e) && !isVlanRow(e))).toEqual([]);
    expect(extra.filter(isStaticWrite)).toHaveLength(1);
    const traffic = (evs: readonly TraceEvent[]): string => JSON.stringify(without(evs).filter((e) => !isStaticWrite(e) && !isStaticDebug(e) && !isVlanRow(e)));
    expect(traffic(lined.trace(0).events)).toBe(traffic(plain.trace(0).events));
    // the eth-switch StateView is identical; the debug ring differs only by the static binding's line
    const p = (sim: Simulation) => sim.device('sw1')!.processes.get(ETH_SWITCH_PROCESS)!;
    expect(JSON.stringify(p(lined).stateSnapshot())).toBe(JSON.stringify(p(plain).stateSnapshot()));
    expect(newTables(lined.trace(0).events).filter((e) => !isStaticWrite(e))).toEqual([]);
    expect(newDebug(lined.trace(0).events).filter((e) => !isStaticDebug(e))).toEqual([]);
    expect(lined.device('sw1')!.tables.get('arp-inspection')!.size).toBe(0);
  });
});
