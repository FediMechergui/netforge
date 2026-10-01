/**
 * W1 qa (ARCHITECTURE-P3 §7 W1 qa, D13, §3.4 steps 5 and 7): the test frame injector.
 *  - `staged.world` adds the test-only NF-INJECTOR host exactly when the overlay registers the injector
 *    (`withInjector`); the host runs only the injector and sends nothing of its own;
 *  - `injectFrames` sends pre-built frames out of a port at a fixed spacing: a fresh PDU per frame (tag `injected`),
 *    frames cycled when the count exceeds them, the first after `startNs`, all on non-periodic timers so `runToIdle`
 *    waits for the last one; they cross real links and switches as real, decoded frames (DHCP server messages, ARPs);
 *  - two worlds with the same inputs inject byte-identically; bad specs are refused.
 */
import { describe, expect, it } from 'vitest';
import type { ProcessFactory } from '../src/contracts/process.js';
import type { Simulation } from '../src/contracts/simulation.js';
import { MS, SEC } from '../src/contracts/time.js';
import type { TraceEvent } from '../src/contracts/trace.js';
import { pcConfig } from '../src/sim/scenarios/templates.js';
import {
  INJECTED_TAG,
  INJECTOR_HOST_TYPE,
  INJECTOR_PROCESS,
  arpFrame,
  createInjector,
  dhcpServerFrame,
  injectFrames,
  withInjector,
} from './inject.js';
import { INJECTOR_HOST_PORTS, P3_DAEMONS, createStagedCatalog, createStagedSimulation, stagedModelInputs, type StagedFactoryOverlay } from './staged.world.js';

const INJ = 'inj';
const INJ_PORT = 'GigabitEthernet0';
const ROGUE_MAC = '02:4e:77:00:00:24';
const ATTACKER_MAC = '02:4e:66:00:00:05';
const PC1_MAC_UNKNOWN = '00:50:79:66:68:00';

/** No P3 daemon at all (before and after the W4 flip), so only the injector adds traffic. */
function noP3(): StagedFactoryOverlay {
  const out: Record<string, ProcessFactory | undefined> = {};
  for (const p of P3_DAEMONS) out[p] = undefined;
  return out;
}

/** SW1 (NF-C2960) with PC1 on Fa0/1, PC2 on Fa0/2 and the injector host on Fa0/24; booted and forwarding. */
function world(seed = 5): Simulation {
  const sim = createStagedSimulation({ seed, stage: 'P3', factories: withInjector(noP3()) });
  sim.addDevice({ id: 'sw1', type: 'switch.nfc2960', name: 'SW1' });
  sim.addDevice({ id: 'pc1', type: 'pc.nfpc', name: 'PC1', startupConfig: pcConfig('PC1', '10.0.0.1', '255.255.255.0') });
  sim.addDevice({ id: 'pc2', type: 'pc.nfpc', name: 'PC2', startupConfig: pcConfig('PC2', '10.0.0.2', '255.255.255.0') });
  sim.addDevice({ id: INJ, type: INJECTOR_HOST_TYPE, name: 'ROGUE' });
  sim.addLink({ id: 'l1', a: { device: 'pc1', port: 'GigabitEthernet0' }, b: { device: 'sw1', port: 'FastEthernet0/1' } });
  sim.addLink({ id: 'l2', a: { device: 'pc2', port: 'GigabitEthernet0' }, b: { device: 'sw1', port: 'FastEthernet0/2' } });
  sim.addLink({ id: 'l3', a: { device: INJ, port: INJ_PORT }, b: { device: 'sw1', port: 'FastEthernet0/24' } });
  sim.runFor(60 * SEC);
  return sim;
}

const created = (events: readonly TraceEvent[], device: string): Extract<TraceEvent, { kind: 'pduCreated' }>[] =>
  events.filter((e): e is Extract<TraceEvent, { kind: 'pduCreated' }> => e.kind === 'pduCreated' && e.device === device);
const received = (events: readonly TraceEvent[], device: string, port: string): Extract<TraceEvent, { kind: 'frameRx' }>[] =>
  events.filter((e): e is Extract<TraceEvent, { kind: 'frameRx' }> => e.kind === 'frameRx' && e.device === device && e.port === port);

describe('the injector host in staged.world', () => {
  it('exists only when the overlay registers the injector, last in the catalog, with the injector as its only daemon', () => {
    for (const stage of ['P2', 'P3'] as const) {
      const plain = createStagedCatalog({ stage });
      expect(plain.get(INJECTOR_HOST_TYPE)).toBeUndefined();
      expect(plain.list().length).toBe(stagedModelInputs(stage).length);
      const withInj = createStagedCatalog({ stage, factories: withInjector() });
      expect(withInj.list().length).toBe(stagedModelInputs(stage).length + 1);
      const host = withInj.list().at(-1)!;
      expect(host.type).toBe(INJECTOR_HOST_TYPE);
      expect(withInj.get(INJECTOR_HOST_TYPE)).toBe(host);
      expect(host.model).toBe('NF-INJECTOR');
      expect(host.capabilities).toEqual([]);
      expect(host.processes).toEqual([INJECTOR_PROCESS]);
      expect(host.tables).toEqual(['cam', 'arp', 'rib']);
      expect(host.ports.map((p) => p.name)).toEqual(INJECTOR_HOST_PORTS);
      expect(host.ports.every((p) => p.role === 'routed')).toBe(true);
      expect(host.portsDefaultUp).toBe(true);
      expect(host.cli.shell).toBe('none');
      expect(Object.isFrozen(host)).toBe(true);
      expect(withInj.process(INJECTOR_PROCESS)).toBeDefined();
      // the other models are the plain catalog's
      expect(JSON.stringify(withInj.list().slice(0, -1))).toBe(JSON.stringify(plain.list()));
    }
  });

  it('the host boots silent: no frame, no missing-daemon log', () => {
    const sim = world();
    const events = sim.trace(0).events;
    expect(created(events, INJ)).toEqual([]);
    expect(events.filter((e) => e.kind === 'frameTx' && e.from.device === INJ)).toEqual([]);
    expect(events.filter((e) => e.kind === 'log' && e.message.includes('is not available'))).toEqual([]);
    expect([...sim.device(INJ)!.processes.keys()]).toEqual([INJECTOR_PROCESS]);
    expect(sim.device(INJ)!.stateSnapshots()).toEqual([{ process: INJECTOR_PROCESS, state: { jobs: 0, framesSent: 0 } }]);
  });
});

describe('injectFrames', () => {
  it('sends eleven DHCP server messages 10 ms apart out of its port; the switch receives them decoded (§3.4 step 5)', () => {
    const sim = world();
    const from = sim.trace(0).next;
    const t0 = sim.now;
    const offer = dhcpServerFrame({ srcMac: ROGUE_MAC, serverIp: '10.66.0.1', chaddr: PC1_MAC_UNKNOWN, yiaddr: '10.66.0.20' });
    const ticket = injectFrames(sim, { from: INJ, port: INJ_PORT, frames: [offer], count: 11, spacingNs: 10 * MS });
    expect(ticket).toEqual({ key: 'inject:1', count: 11, firstAt: t0, lastAt: t0 + 100 * MS });
    sim.runToIdle();
    const events = sim.trace(from).events;
    const made = created(events, INJ);
    expect(made.map((e) => e.t)).toEqual(Array.from({ length: 11 }, (_, k) => t0 + k * 10 * MS));
    expect(made.every((e) => e.process === INJECTOR_PROCESS && e.pdu.tag === INJECTED_TAG)).toBe(true);
    expect(new Set(made.map((e) => e.pdu.id)).size).toBe(11);
    const atSwitch = received(events, 'sw1', 'FastEthernet0/24');
    expect(atSwitch.map((e) => e.pdu.id)).toEqual(made.map((e) => e.pdu.id));
    expect(atSwitch.every((e) => e.pdu.proto === 'dhcp')).toBe(true);
    const view = sim.pdu(made[0]!.pdu.id)!;
    expect(view.layers.map((l) => l.proto)).toEqual(['ethernet', 'ipv4', 'udp', 'dhcp']);
    const dhcp = view.layers.find((l) => l.proto === 'dhcp')!;
    expect(dhcp.fields).toMatchObject({ op: 2, messageType: 'OFFER', chaddr: PC1_MAC_UNKNOWN, yiaddr: '10.66.0.20', serverId: '10.66.0.1', leaseTimeS: 86400 });
    expect(view.layers[0]!.fields).toMatchObject({ src: ROGUE_MAC, dst: 'ff:ff:ff:ff:ff:ff' });
    // without snooping (a P2 path) the switch floods each broadcast to the PCs
    expect(received(events, 'pc1', 'GigabitEthernet0').filter((e) => e.pdu.tag === INJECTED_TAG)).toHaveLength(11);
    expect(sim.device(INJ)!.stateSnapshots()).toEqual([{ process: INJECTOR_PROCESS, state: { jobs: 0, framesSent: 11 } }]);
  });

  it('cycles the frames in order; startNs delays the first; runToIdle waits for the last', () => {
    const sim = world();
    const from = sim.trace(0).next;
    const t0 = sim.now;
    const a = arpFrame({ sha: ATTACKER_MAC, spa: '10.0.0.101' });
    const b = arpFrame({ sha: ATTACKER_MAC, spa: '10.0.0.102' });
    const ticket = injectFrames(sim, { from: INJ, port: INJ_PORT, frames: [a, b], count: 5, spacingNs: 3 * SEC, startNs: 2 * SEC });
    expect(ticket).toMatchObject({ count: 5, firstAt: t0 + 2 * SEC, lastAt: t0 + 14 * SEC });
    sim.runToIdle();
    expect(sim.now).toBeGreaterThanOrEqual(ticket.lastAt);
    const made = created(sim.trace(from).events, INJ);
    expect(made.map((e) => e.t - t0)).toEqual([2, 5, 8, 11, 14].map((s) => s * SEC));
    expect(made.map((e) => sim.pdu(e.pdu.id)!.layers.find((l) => l.proto === 'arp')!.fields.spa)).toEqual([
      '10.0.0.101', '10.0.0.102', '10.0.0.101', '10.0.0.102', '10.0.0.101',
    ]);
    // count defaults to the number of frames; spacing 0 sends a burst at one instant
    const t1 = sim.now;
    const burst = injectFrames(sim, { from: INJ, port: INJ_PORT, frames: [a, b, a], spacingNs: 0 });
    expect(burst).toMatchObject({ key: 'inject:2', count: 3, firstAt: t1, lastAt: t1 });
    sim.runToIdle();
    expect(created(sim.trace(from).events, INJ).slice(5).map((e) => e.t)).toEqual([t1, t1, t1]);
  });

  it('frames cross the switch as real ARPs: an injected gratuitous ARP rewrites PC1\'s row for PC2 (the poisoning demo, DAI off)', () => {
    const sim = world();
    const s = sim.cli.open('pc1', 'console');
    sim.cli.exec(s, 'ping 10.0.0.2');
    sim.runFor(10 * SEC);
    const row = (): { mac: string } | undefined => sim.device('pc1')!.tables.arp.find((r) => r.ip === '10.0.0.2')[0];
    const pc2Mac = row()!.mac;
    expect(pc2Mac).not.toBe(ATTACKER_MAC);
    injectFrames(sim, { from: INJ, port: INJ_PORT, frames: [arpFrame({ sha: ATTACKER_MAC, spa: '10.0.0.2' })], spacingNs: 0 });
    sim.runToIdle();
    expect(row()!.mac).toBe(ATTACKER_MAC);
  });

  it('builders: an 802.1Q tag for trunk ports, NAKs without a lease, replies with their target', () => {
    expect(dhcpServerFrame({ srcMac: ROGUE_MAC, serverIp: '10.66.0.1', chaddr: PC1_MAC_UNKNOWN, type: 'NAK', vlan: 10 }).map((l) => [l.proto, l.fields])).toEqual([
      ['ethernet', { dst: 'ff:ff:ff:ff:ff:ff', src: ROGUE_MAC, type: 0x8100 }],
      ['dot1q', { vid: 10, type: 0x0800 }],
      ['ipv4', { src: '10.66.0.1', dst: '255.255.255.255', protocol: 17, ttl: 255 }],
      ['udp', { srcPort: 67, dstPort: 68 }],
      ['dhcp', { op: 2, xid: 1, broadcastFlag: true, yiaddr: '0.0.0.0', chaddr: PC1_MAC_UNKNOWN, messageType: 'NAK', serverId: '10.66.0.1' }],
    ]);
    expect(arpFrame({ op: 2, sha: ATTACKER_MAC, spa: '10.0.0.1', tha: '00:50:79:66:68:02', tpa: '10.0.0.2', dstMac: '00:50:79:66:68:02' })).toEqual([
      { proto: 'ethernet', fields: { dst: '00:50:79:66:68:02', src: ATTACKER_MAC, type: 0x0806 } },
      { proto: 'arp', fields: { op: 2, sha: ATTACKER_MAC, spa: '10.0.0.1', tha: '00:50:79:66:68:02', tpa: '10.0.0.2' } },
    ]);
    // a tagged frame survives a real encode/decode through a world (the switch receives it on a trunk-less access port
    // and drops it vlan-filtered, which shows the tag arrived)
    const sim = world();
    const from = sim.trace(0).next;
    injectFrames(sim, { from: INJ, port: INJ_PORT, frames: [arpFrame({ sha: ATTACKER_MAC, spa: '10.0.0.9', vlan: 20 })], spacingNs: 0 });
    sim.runToIdle();
    const rx = received(sim.trace(from).events, 'sw1', 'FastEthernet0/24');
    expect(rx.map((e) => e.pdu.vlan)).toEqual([20]);
    expect(sim.trace(from).events.filter((e) => e.kind === 'drop' && e.device === 'sw1' && e.pdu.id === rx[0]!.pdu.id).map((e) => (e as { reason: string }).reason)).toEqual(['vlan-filtered']);
  });

  it('two worlds with the same inputs inject byte-identically', () => {
    const run = (): string => {
      const sim = world(9);
      injectFrames(sim, { from: INJ, port: INJ_PORT, frames: [arpFrame({ sha: ATTACKER_MAC, spa: '10.0.0.7' })], count: 16, spacingNs: 50 * MS });
      sim.runToIdle();
      return JSON.stringify([sim.trace(0).events, sim.snapshot()]);
    };
    expect(run()).toBe(run());
  });

  it('refuses bad specs and devices that run no injector', () => {
    const sim = world();
    const frames = [arpFrame({ sha: ATTACKER_MAC, spa: '10.0.0.7' })];
    expect(() => injectFrames(sim, { from: 'nope', port: INJ_PORT, frames, spacingNs: 0 })).toThrow('no device nope');
    expect(() => injectFrames(sim, { from: 'pc1', port: 'GigabitEthernet0', frames, spacingNs: 0 })).toThrow('pc1 runs no injector');
    expect(() => injectFrames(sim, { from: INJ, port: 'GigabitEthernet9', frames, spacingNs: 0 })).toThrow('has no port GigabitEthernet9');
    expect(() => injectFrames(sim, { from: INJ, port: INJ_PORT, frames, count: 0, spacingNs: 0 })).toThrow(RangeError);
    expect(() => injectFrames(sim, { from: INJ, port: INJ_PORT, frames, spacingNs: 1.5 })).toThrow(RangeError);
    expect(() => injectFrames(sim, { from: INJ, port: INJ_PORT, frames, spacingNs: -1 })).toThrow(RangeError);
    expect(() => injectFrames(sim, { from: INJ, port: INJ_PORT, frames, spacingNs: 0, startNs: -5 })).toThrow(RangeError);
    expect(() => injectFrames(sim, { from: INJ, port: INJ_PORT, frames: [], count: 1, spacingNs: 0 })).toThrow(RangeError);
    expect(() => createInjector().enqueue({ port: INJ_PORT, frames: [], count: 1, spacingNs: 0 })).toThrow(RangeError);
    // nothing was sent by the refused calls
    expect(sim.device(INJ)!.stateSnapshots()).toEqual([{ process: INJECTOR_PROCESS, state: { jobs: 0, framesSent: 0 } }]);
  });
});
