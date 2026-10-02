/**
 * W2 l2 (ARCHITECTURE-P3 D13, §3.0 (b), §3.4 steps 6–8, §4.2, §4.3, §5.3; §7 W2 l2): eth-switch step 7c, dynamic ARP
 * inspection, on real worlds (`staged.world` at stage P3, every P3 daemon removed, the W1 injector as ATTACKER on
 * Fa0/5). SW1 is configured through `startupConfig` and `applyConfigLine` (rule 13); R1 and the PCs through their
 * P1 grammar.
 *  - §3.4 steps 6–7: PC1's ARPs (its binding on Fa0/1) are forwarded and counted; R1's replies on the trusted trunk are
 *    not inspected; ATTACKER's gratuitous ARP claiming the gateway is dropped `arp-inspection` with the exact detail,
 *    its rule (table `dhcp-snooping`, key `10|<A>`), the row counters and a severity-4 DAI log, and PC1 keeps R1's MAC;
 *    with DAI off the same ARP poisons PC1's cache;
 *  - the log bound (five invalid-ARP lines per VLAN per second) under `ip arp inspection limit none`;
 *  - the rate limits proved with `test/inject.ts`: 15 ARPs in one second pass the default limit, 16 err-disable the
 *    port (`arp-inspection`); a configured `limit rate 5 burst interval 2` allows 10 per 2-second window; recovery by
 *    `errdisable recovery cause arp-inspection`;
 *  - §3.4 step 8, the gotcha: a static-address host is refused until `ip source binding` names it;
 *  - two runs with one seed are byte-identical.
 */
import { describe, expect, it } from 'vitest';
import type { ProcessFactory } from '../src/contracts/process.js';
import type { Simulation } from '../src/contracts/simulation.js';
import type { ArpInspectionRow } from '../src/contracts/tables.js';
import { MS, SEC } from '../src/contracts/time.js';
import type { TraceEvent } from '../src/contracts/trace.js';
import { ARP_INSPECTION_DEBUG_CATEGORY } from '../src/protocols/l2/arp-inspection.js';
import { INJECTED_TAG, INJECTOR_HOST_TYPE, arpFrame, injectFrames, withInjector } from './inject.js';
import { ofKind, ping } from './sim.harness.js';
import { P3_DAEMONS, createStagedSimulation, type StagedFactoryOverlay } from './staged.world.js';

const FA1 = 'FastEthernet0/1';
const FA2 = 'FastEthernet0/2';
const FA5 = 'FastEthernet0/5';
const GI1 = 'GigabitEthernet0/1';
const PC_PORT = 'GigabitEthernet0';
const INJ_PORT = 'GigabitEthernet0';
/** ATTACKER's MAC (A of §3.4). */
const A = '02:4e:66:00:00:05';
const BOOT = 120 * SEC;

function noP3(): StagedFactoryOverlay {
  const out: Record<string, ProcessFactory | undefined> = {};
  for (const p of P3_DAEMONS) out[p] = undefined;
  return out;
}

function configText(sections: readonly (readonly string[])[]): string {
  return [...sections.flatMap((s) => [...s, '!']), 'end', ''].join('\n');
}

/**
 * SW1 of §3.4 step 6: snooping and DAI on VLAN 10, the trunk trusted for both; ATTACKER holds the binding (Fa0/5, .12)
 * as a static binding (the injector does not run DHCP). `fa5` adds lines to Fa0/5; `dai` false leaves DAI off.
 */
function sw1Config(o: { dai?: boolean; fa5?: readonly string[]; extra?: readonly (readonly string[])[] } = {}): string {
  const dai = o.dai ?? true;
  const access = (port: string, more: readonly string[] = []): string[] => [
    `interface ${port}`, ' switchport mode access', ' switchport access vlan 10', ' spanning-tree portfast', ...more.map((l) => ` ${l}`),
  ];
  return configText([
    ['hostname SW1'],
    ['vlan 10'],
    access(FA1),
    access(FA2),
    access(FA5, o.fa5 ?? []),
    [`interface ${GI1}`, ' switchport mode trunk', ' ip dhcp snooping trust', ...(dai ? [' ip arp inspection trust'] : [])],
    ['ip dhcp snooping', 'ip dhcp snooping vlan 10', `ip source binding ${A} vlan 10 192.168.10.12 interface ${FA5}`, ...(dai ? ['ip arp inspection vlan 10'] : [])],
    ...(o.extra ?? []),
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

/** The §3.4 world: booted, R1 serving the pool, PC1 leased (bound on Fa0/1); PC2 (static .50) on Fa0/2. */
function world(o: { seed?: number; sw?: string } = {}): Simulation {
  const sim = createStagedSimulation({ seed: o.seed ?? 5, stage: 'P3', factories: withInjector(noP3()) });
  sim.addDevice({ id: 'sw1', type: 'switch.nfc2960', name: 'SW1', startupConfig: o.sw ?? sw1Config() });
  sim.addDevice({ id: 'r1', type: 'router.nf2911', name: 'R1' });
  sim.addDevice({ id: 'pc1', type: 'pc.nfpc', name: 'PC1' });
  sim.addDevice({
    id: 'pc2', type: 'pc.nfpc', name: 'PC2',
    startupConfig: configText([['hostname PC2'], ['interface GigabitEthernet0', ' ip address 192.168.10.50 255.255.255.0'], ['ip default-gateway 192.168.10.1']]),
  });
  sim.addDevice({ id: 'attacker', type: INJECTOR_HOST_TYPE, name: 'ATTACKER' });
  sim.addLink({ id: 'l_pc1', a: { device: 'pc1', port: PC_PORT }, b: { device: 'sw1', port: FA1 } });
  sim.addLink({ id: 'l_pc2', a: { device: 'pc2', port: PC_PORT }, b: { device: 'sw1', port: FA2 } });
  sim.addLink({ id: 'l_att', a: { device: 'attacker', port: INJ_PORT }, b: { device: 'sw1', port: FA5 } });
  sim.addLink({ id: 'l_r1', a: { device: 'sw1', port: GI1 }, b: { device: 'r1', port: 'GigabitEthernet0/0' } });
  sim.runFor(BOOT);
  configured(sim, 'r1', R1_LINES);
  sim.runToIdle();
  configured(sim, 'pc1', ['ip address dhcp']);
  sim.runToIdle();
  return sim;
}

const macOf = (sim: Simulation, dev: string, port = PC_PORT): string => sim.device(dev)!.port(port)!.mac;
const daiRow = (sim: Simulation): ArpInspectionRow | undefined => sim.device('sw1')!.tables.get<ArpInspectionRow>('arp-inspection')!.get('10');
const counters = (r: ArpInspectionRow | undefined): number[] => (r === undefined ? [] : [r.forwarded, r.dropped, r.droppedNoBinding, r.droppedAcl]);
const daiDrops = (evs: readonly TraceEvent[]): Extract<TraceEvent, { kind: 'drop' }>[] => ofKind(evs, 'drop').filter((e) => e.reason === 'arp-inspection');
const daiLogs = (evs: readonly TraceEvent[]): Extract<TraceEvent, { kind: 'log' }>[] => ofKind(evs, 'log').filter((e) => e.device === 'sw1' && e.facility === 'DAI');
const daiDebug = (evs: readonly TraceEvent[]): string[] =>
  ofKind(evs, 'debug').filter((e) => e.event.category === ARP_INSPECTION_DEBUG_CATEGORY).map((e) => e.event.message);
const arpRxAt = (evs: readonly TraceEvent[], dev: string, port: string): number =>
  ofKind(evs, 'frameRx').filter((e) => e.device === dev && e.port === port && e.pdu.proto === 'arp').length;
const gatewayMacAt = (sim: Simulation, dev: string): string | undefined => sim.device(dev)!.tables.arp.find((r) => r.ip === '192.168.10.1')[0]?.mac;
const toNextSecond = (sim: Simulation): number => SEC - (sim.now % SEC);

describe('step 7c: dynamic ARP inspection (§3.4 steps 6–7)', () => {
  it('forwards and counts PC1\'s ARPs, never inspects the trusted trunk, and drops ATTACKER\'s spoof with its detail, rule, counters and log', () => {
    const sim = world();
    expect(sim.device('pc1')!.port(PC_PORT)!.l3.ipv4).toMatchObject({ address: '192.168.10.11', origin: 'dhcp' });
    // during boot and DORA the only refused ARPs are PC2's (a static address with no binding, §3.4 step 8)
    const setup = daiDrops(sim.trace(0).events);
    expect(setup.map((e) => e.port)).toEqual(setup.map(() => FA2));
    const before = daiRow(sim)!;
    expect([before.dropped, before.droppedNoBinding, before.droppedAcl]).toEqual([setup.length, setup.length, 0]);
    const t0 = sim.trace(0).next;
    const p = ping(sim, 'pc1', '192.168.10.1');
    expect(p.text).toMatch(/!!!!!/);
    const pinged = sim.trace(t0).events;
    // every ARP PC1 sent on Fa0/1 was inspected and forwarded; R1's ARPs on the trusted trunk were not counted
    const fromPc1 = arpRxAt(pinged, 'sw1', FA1);
    expect(fromPc1).toBeGreaterThan(0);
    expect(arpRxAt(pinged, 'sw1', GI1)).toBeGreaterThan(0);
    const after = daiRow(sim)!;
    expect(after.forwarded - before.forwarded).toBe(fromPc1);
    expect([after.dropped, after.droppedNoBinding, after.droppedAcl]).toEqual([before.dropped, before.droppedNoBinding, 0]);
    expect(daiDrops(pinged)).toEqual([]);
    const r1Mac = gatewayMacAt(sim, 'pc1');
    expect(r1Mac).toBeDefined();
    expect(r1Mac).not.toBe(A);

    // step 6: ATTACKER (bound to .12 on Fa0/5) claims the gateway's address
    const t1 = sim.trace(0).next;
    injectFrames(sim, { from: 'attacker', port: INJ_PORT, frames: [arpFrame({ sha: A, spa: '192.168.10.1' })], spacingNs: 0 });
    sim.runToIdle();
    const spoof = sim.trace(t1).events;
    const d = daiDrops(spoof);
    expect(d).toHaveLength(1);
    expect(d[0]).toMatchObject({
      device: 'sw1', port: FA5,
      detail: `ARP request from ${A} claiming 192.168.10.1 on ${FA5} (vlan 10) matches no DHCP snooping binding`,
    });
    expect(d[0]!.pdu.tag).toBe(INJECTED_TAG);
    expect(d[0]!.rule).toEqual({
      kind: 'arp-inspection',
      text: `on an untrusted port of an inspected VLAN an ARP needs a DHCP snooping binding for its sender (MAC ${A}, address 192.168.10.1, this port); a host with a static address needs "ip source binding", or the port needs "ip arp inspection trust"`,
      table: 'dhcp-snooping',
      key: `10|${A}`,
      iface: FA5,
    });
    expect(counters(daiRow(sim))).toEqual([after.forwarded, after.dropped + 1, after.droppedNoBinding + 1, 0]);
    expect(daiLogs(spoof).map((e) => [e.severity, e.message])).toEqual([
      [4, `Refused an ARP request on ${FA5}, vlan 10: ${A} claims 192.168.10.1, which no DHCP snooping binding confirms.`],
    ]);
    expect(daiDebug(spoof)).toEqual([`dropped ARP request from ${A} claiming 192.168.10.1 on ${FA5} (vlan 10): no matching binding`]);
    expect(arpRxAt(spoof, 'pc1', PC_PORT)).toBe(0);
    expect(gatewayMacAt(sim, 'pc1')).toBe(r1Mac);
    expect(ping(sim, 'pc1', '192.168.10.1').text).toMatch(/!!!!!/);

    // the same ATTACKER announcing its own bound address is forwarded and counted
    const t2 = sim.trace(0).next;
    const fwd = daiRow(sim)!.forwarded;
    injectFrames(sim, { from: 'attacker', port: INJ_PORT, frames: [arpFrame({ sha: A, spa: '192.168.10.12' })], spacingNs: 0 });
    sim.runToIdle();
    expect(daiDrops(sim.trace(t2).events)).toEqual([]);
    expect(daiRow(sim)!.forwarded).toBe(fwd + 1);
    expect(arpRxAt(sim.trace(t2).events, 'pc1', PC_PORT)).toBe(1);
  });

  it('with DAI off the same gratuitous ARP rewrites PC1\'s row for the gateway (the poisoning demo); no row is written', () => {
    const sim = world({ sw: sw1Config({ dai: false }) });
    ping(sim, 'pc1', '192.168.10.1');
    expect(gatewayMacAt(sim, 'pc1')).not.toBe(A);
    const t0 = sim.trace(0).next;
    injectFrames(sim, { from: 'attacker', port: INJ_PORT, frames: [arpFrame({ sha: A, spa: '192.168.10.1' })], spacingNs: 0 });
    sim.runToIdle();
    expect(gatewayMacAt(sim, 'pc1')).toBe(A);
    expect(daiDrops(sim.trace(t0).events)).toEqual([]);
    expect(daiRow(sim)).toBeUndefined();
    expect(ofKind(sim.trace(0).events, 'tableWrite').filter((e) => e.table === 'arp-inspection')).toEqual([]);
  });

  it('logs at most five invalid ARPs per VLAN per second (limit none: no err-disable)', () => {
    const sim = world({ sw: sw1Config({ fa5: ['ip arp inspection limit none'] }) });
    const t0 = sim.trace(0).next;
    const base = counters(daiRow(sim));
    injectFrames(sim, { from: 'attacker', port: INJ_PORT, frames: [arpFrame({ sha: A, spa: '192.168.10.99' })], count: 40, spacingNs: 20 * MS, startNs: toNextSecond(sim) });
    sim.runToIdle();
    const evs = sim.trace(t0).events;
    expect(daiDrops(evs)).toHaveLength(40);
    expect(sim.device('sw1')!.port(FA5)!.errDisabled).toBeUndefined();
    // 40 ARPs 20 ms apart from a second boundary: 0.00–0.98 s (50 slots, 40 used) all in one second → five logs
    expect(daiLogs(evs)).toHaveLength(5);
    const row = counters(daiRow(sim));
    expect([row[1]! - (base[1] ?? 0), row[2]! - (base[2] ?? 0)]).toEqual([40, 40]);
    // the next second logs again
    const t1 = sim.trace(0).next;
    injectFrames(sim, { from: 'attacker', port: INJ_PORT, frames: [arpFrame({ sha: A, spa: '192.168.10.99' })], count: 2, spacingNs: 0, startNs: toNextSecond(sim) });
    sim.runToIdle();
    expect(daiLogs(sim.trace(t1).events)).toHaveLength(2);
  });
});

describe('step 7c rate limits → err-disable arp-inspection (§3.4 step 7)', () => {
  const valid = arpFrame({ sha: A, spa: '192.168.10.12' });

  it('fifteen ARPs in one second pass the default limit; sixteen err-disable the untrusted port', () => {
    const sim = world();
    const t0 = sim.trace(0).next;
    const base = counters(daiRow(sim));
    injectFrames(sim, { from: 'attacker', port: INJ_PORT, frames: [valid], count: 15, spacingNs: 10 * MS, startNs: toNextSecond(sim) });
    sim.runToIdle();
    expect(daiDrops(sim.trace(t0).events)).toEqual([]);
    expect(sim.device('sw1')!.port(FA5)!.errDisabled).toBeUndefined();
    expect(counters(daiRow(sim))[0]! - (base[0] ?? 0)).toBe(15);

    const t1 = sim.trace(0).next;
    const mid = counters(daiRow(sim));
    injectFrames(sim, { from: 'attacker', port: INJ_PORT, frames: [valid], count: 16, spacingNs: 10 * MS, startNs: toNextSecond(sim) });
    sim.runToIdle();
    const evs = sim.trace(t1).events;
    const d = daiDrops(evs);
    expect(d).toHaveLength(1);
    expect(d[0]).toMatchObject({ device: 'sw1', port: FA5, detail: `ARP rate limit exceeded on ${FA5}: 16 packets in one second, the limit is 15` });
    expect(d[0]!.rule).toEqual({
      kind: 'arp-inspection',
      text: 'an untrusted port accepts at most 15 ARP packets per second by default; more than that shuts the port down (error-disabled) until it is recovered',
      iface: FA5,
    });
    expect(sim.device('sw1')!.port(FA5)!.errDisabled).toBe('arp-inspection');
    expect(ofKind(evs, 'log').filter((e) => e.device === 'sw1').map((e) => [e.severity, e.message])).toContainEqual([
      4, `Interface ${FA5} is error-disabled by dynamic ARP inspection: 16 ARP packets in one second, the limit is 15.`,
    ]);
    expect(daiDebug(evs)).toEqual([`${FA5} (vlan 10): 16 ARP packets in one second exceed the limit of 15; error-disabling the port`]);
    // fifteen forwarded, the sixteenth counted as dropped (not as "no binding")
    const end = counters(daiRow(sim));
    expect([end[0]! - mid[0]!, end[1]! - mid[1]!, end[2]! - mid[2]!]).toEqual([15, 1, 0]);
    // no recovery line: still down much later
    sim.runFor(400 * SEC);
    expect(sim.device('sw1')!.port(FA5)!.errDisabled).toBe('arp-inspection');
  });

  it('limit rate 5 burst interval 2 allows ten ARPs per 2-second window; the eleventh err-disables; recovery brings the port back', () => {
    const sim = world({
      sw: sw1Config({ fa5: ['ip arp inspection limit rate 5 burst interval 2'], extra: [['errdisable recovery cause arp-inspection', 'errdisable recovery interval 30']] }),
    });
    const toNextWindow = 2 * SEC - (sim.now % (2 * SEC));
    const t0 = sim.trace(0).next;
    injectFrames(sim, { from: 'attacker', port: INJ_PORT, frames: [valid], count: 10, spacingNs: 150 * MS, startNs: toNextWindow });
    sim.runToIdle();
    expect(sim.device('sw1')!.port(FA5)!.errDisabled).toBeUndefined();
    expect(daiDrops(sim.trace(t0).events)).toEqual([]);

    const t1 = sim.trace(0).next;
    injectFrames(sim, { from: 'attacker', port: INJ_PORT, frames: [valid], count: 11, spacingNs: 150 * MS, startNs: 2 * SEC - (sim.now % (2 * SEC)) });
    sim.runUntil(sim.now + 4 * SEC);
    const evs = sim.trace(t1).events;
    const d = daiDrops(evs);
    expect(d.map((e) => e.detail)).toEqual([`ARP rate limit exceeded on ${FA5}: 11 packets in 2 seconds, the limit is 10`]);
    expect(d[0]!.rule).toEqual({
      kind: 'arp-inspection',
      text: `${FA5} accepts at most 10 ARP packets in 2 seconds; more than that shuts the port down (error-disabled) until it is recovered`,
      iface: FA5,
      config: { context: [['interface', FA5]], line: ['ip', 'arp', 'inspection', 'limit', 'rate', '5', 'burst', 'interval', '2'] },
    });
    expect(sim.device('sw1')!.port(FA5)!.errDisabled).toBe('arp-inspection');
    const disabledAt = ofKind(evs, 'portState').find((e) => e.port === FA5 && e.reason === 'err-disabled')!.t;
    expect(daiDebug(evs)).toContain(`${FA5} recovers from err-disable in 30 s`);

    const t2 = sim.trace(0).next;
    sim.runFor(40 * SEC);
    const rec = sim.trace(t2).events;
    expect(sim.device('sw1')!.port(FA5)!.errDisabled).toBeUndefined();
    expect(ofKind(rec, 'portState').find((e) => e.port === FA5 && e.reason === 'err-recovered')!.t).toBe(disabledAt + 30 * SEC);
    expect(ofKind(rec, 'log').filter((e) => e.device === 'sw1').map((e) => e.message)).toContain(
      `Interface ${FA5} leaves the error-disabled state (dynamic ARP inspection) and may come up again.`,
    );
    expect(daiDebug(rec)).toContain(`recovering ${FA5} from err-disable`);
  });
});

describe('the static-address gotcha (§3.4 step 8)', () => {
  it('a static-address host on an untrusted port is refused until "ip source binding" names it', () => {
    const sim = world();
    const pc2 = macOf(sim, 'pc2');
    const t0 = sim.trace(0).next;
    expect(ping(sim, 'pc2', '192.168.10.1').text).not.toMatch(/!/);
    const refused = daiDrops(sim.trace(t0).events);
    expect(refused.length).toBeGreaterThan(0);
    expect(refused.every((e) => e.port === FA2 && e.detail === `ARP request from ${pc2} claiming 192.168.10.50 on ${FA2} (vlan 10) matches no DHCP snooping binding`)).toBe(true);

    expect(sim.device('sw1')!.applyConfigLine([], ['ip', 'source', 'binding', pc2, 'vlan', '10', '192.168.10.50', 'interface', FA2], false).ok).toBe(true);
    const t1 = sim.trace(0).next;
    expect(ping(sim, 'pc2', '192.168.10.1').text).toMatch(/!!!/);
    expect(daiDrops(sim.trace(t1).events)).toEqual([]);
  });
});

describe('determinism', () => {
  it('two runs with one seed (spoof, burst, err-disable) are byte-identical', () => {
    const run = (): string => {
      const sim = world({ seed: 13 });
      ping(sim, 'pc1', '192.168.10.1');
      injectFrames(sim, { from: 'attacker', port: INJ_PORT, frames: [arpFrame({ sha: A, spa: '192.168.10.1' }), arpFrame({ sha: A, spa: '192.168.10.12' })], count: 20, spacingNs: 10 * MS });
      sim.runToIdle();
      return JSON.stringify([sim.trace(0).events, sim.snapshot()]);
    };
    expect(run()).toBe(run());
  });
});
