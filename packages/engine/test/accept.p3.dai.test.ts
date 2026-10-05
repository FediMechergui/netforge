/**
 * accept.p3.dai — W4 qa acceptance row (ARCHITECTURE-P3 §10.1; D13, §3.4 steps 6–8, §4.2, §5.3, §5.8): dynamic ARP
 * inspection stops a spoofed ARP, on `staged.world` at stage P3 with every approved P3 daemon (test/hardening.world.ts:
 * the worlds equal the flipped catalog; the flip itself is a later, separate step, rule 14).
 *
 * The §3.4 world with DAI: SW1 (NF-C2960) with `ip dhcp snooping`, `ip dhcp snooping vlan 10`, `ip arp inspection vlan
 * 10`, and the trunk Gi0/1 to R1 trusted for both (`ip dhcp snooping trust`, `ip arp inspection trust`); R1 serves
 * 192.168.10.0/24 on Gi0/0.10 (.1–.10 kept back). PC1 on Fa0/1 and ATTACKER (a PC) on Fa0/5 both lease an address
 * (PC1 .11, ATTACKER .12: bindings on Fa0/1 and Fa0/5). For step 8, PC2 has the static address .50 on Fa0/2. For the
 * burst of step 7 the test injector (test/inject.ts, D13) takes ATTACKER's place on Fa0/5. SW1 is configured through
 * its startup configuration; the hosts and the step-8 remedies through their own grammar, typed.
 *
 * Pinned:
 *   • step 6: the learner gives ATTACKER the gateway's address; its gratuitous ARP (sender .1) on untrusted Fa0/5 is
 *     dropped `arp-inspection` with the exact detail and rule (table `dhcp-snooping`, key `10|<A>`), the VLAN 10 row
 *     gets dropped + 1 and droppedNoBinding + 1, a severity-4 DAI log; ATTACKER's binding still says .12; PC1 never
 *     sees the ARP, its cache keeps R1's MAC and its pings keep working. With DAI off the same change rewrites PC1's
 *     row for .1 (the poisoning demo);
 *   • step 7: R1's replies on the trusted trunk are not inspected; PC1's own ARPs match its binding and `forwarded`
 *     rises by exactly their number; the statistics row (`show ip arp inspection statistics`) equals the table row;
 *     16 injected ARPs in one second on Fa0/5 (the default limit is 15) err-disable it (`arp-inspection`), 15 do not;
 *   • step 8: a static-address host on an untrusted port has every ARP dropped until `ip source binding …` names it,
 *     or until the port is trusted;
 *   • three runs with one seed are byte-identical (trace and snapshot JSON).
 */
import { describe, expect, it } from 'vitest';
import type { Simulation } from '../src/contracts/simulation.js';
import type { ArpInspectionRow, DhcpSnoopingRow } from '../src/contracts/tables.js';
import { MS, SEC } from '../src/contracts/time.js';
import type { TraceEvent } from '../src/contracts/trace.js';
import {
  ARP_INSPECTION_DEBUG_CATEGORY,
  ARP_INSPECTION_DEFAULT_RATE_PPS,
  ARP_INSPECTION_LOG_FACILITY,
  ARP_INSPECTION_LOG_SEVERITY,
} from '../src/protocols/l2/arp-inspection.js';
import { configText, configured, p3Factories } from './hardening.world.js';
import { INJECTED_TAG, INJECTOR_HOST_TYPE, arpFrame, injectFrames, withInjector } from './inject.js';
import { ofKind, ping } from './sim.harness.js';
import { createStagedSimulation } from './staged.world.js';

const FA1 = 'FastEthernet0/1';
const FA2 = 'FastEthernet0/2';
const FA5 = 'FastEthernet0/5';
const GI1 = 'GigabitEthernet0/1';
const HOST_PORT = 'GigabitEthernet0';
const INJ_PORT = 'GigabitEthernet0';
const R1_ADDR = '192.168.10.1';
const PC1_LEASE = '192.168.10.11';
const ATTACKER_LEASE = '192.168.10.12';
const PC2_ADDR = '192.168.10.50';
/** The injector's source MAC on Fa0/5 (step 7's flood). */
const FLOOD_MAC = '02:4e:66:00:00:55';
const BOOT = 120 * SEC;

interface WorldOptions {
  readonly seed?: number;
  /** DAI on VLAN 10 (default true). */
  readonly dai?: boolean;
  /** Who sits on Fa0/5: ATTACKER the PC (default) or the injector (step 7's burst). */
  readonly fa5?: 'attacker' | 'injector';
  /** PC2 with the static address .50 on Fa0/2 (step 8). */
  readonly pc2?: boolean;
}

function access(port: string): string[] {
  return [`interface ${port}`, ' switchport mode access', ' switchport access vlan 10', ' spanning-tree portfast'];
}

function sw1Config(dai: boolean): string {
  return configText([
    ['hostname SW1'],
    ['vlan 10'],
    access(FA1),
    access(FA2),
    access(FA5),
    [`interface ${GI1}`, ' switchport mode trunk', ' ip dhcp snooping trust', ...(dai ? [' ip arp inspection trust'] : [])],
    ['ip dhcp snooping', 'ip dhcp snooping vlan 10', ...(dai ? ['ip arp inspection vlan 10'] : [])],
  ]);
}

const R1_CONFIG = configText([
  ['hostname R1'],
  ['interface GigabitEthernet0/0', ' no shutdown'],
  ['interface GigabitEthernet0/0.10', ' encapsulation dot1q 10', ` ip address ${R1_ADDR} 255.255.255.0`],
  ['ip dhcp excluded-address 192.168.10.1 192.168.10.10'],
  ['ip dhcp pool V10', ' network 192.168.10.0 255.255.255.0', ` default-router ${R1_ADDR}`],
]);

/** The world of the file header: booted, R1 serving the pool, PC1 then ATTACKER leased. */
function world(o: WorldOptions = {}): Simulation {
  const sim = createStagedSimulation({ seed: o.seed ?? 5, stage: 'P3', factories: withInjector(p3Factories()) });
  sim.addDevice({ id: 'sw1', type: 'switch.nfc2960', name: 'SW1', startupConfig: sw1Config(o.dai ?? true) });
  sim.addDevice({ id: 'r1', type: 'router.nf2911', name: 'R1', startupConfig: R1_CONFIG });
  sim.addDevice({ id: 'pc1', type: 'pc.nfpc', name: 'PC1', startupConfig: configText([['hostname PC1']]) });
  sim.addLink({ id: 'l_pc1', a: { device: 'pc1', port: HOST_PORT }, b: { device: 'sw1', port: FA1 } });
  sim.addLink({ id: 'l_r1', a: { device: 'sw1', port: GI1 }, b: { device: 'r1', port: 'GigabitEthernet0/0' } });
  const attacker = (o.fa5 ?? 'attacker') === 'attacker';
  if (attacker) {
    sim.addDevice({ id: 'att', type: 'pc.nfpc', name: 'ATTACKER', startupConfig: configText([['hostname ATTACKER']]) });
    sim.addLink({ id: 'l_att', a: { device: 'att', port: HOST_PORT }, b: { device: 'sw1', port: FA5 } });
  } else {
    sim.addDevice({ id: 'inj', type: INJECTOR_HOST_TYPE, name: 'FLOOD' });
    sim.addLink({ id: 'l_inj', a: { device: 'inj', port: INJ_PORT }, b: { device: 'sw1', port: FA5 } });
  }
  if (o.pc2 === true) {
    sim.addDevice({
      id: 'pc2', type: 'pc.nfpc', name: 'PC2',
      startupConfig: configText([['hostname PC2'], ['interface GigabitEthernet0', ` ip address ${PC2_ADDR} 255.255.255.0`], [`ip default-gateway ${R1_ADDR}`]]),
    });
    sim.addLink({ id: 'l_pc2', a: { device: 'pc2', port: HOST_PORT }, b: { device: 'sw1', port: FA2 } });
  }
  sim.runFor(BOOT);
  sim.runToIdle();
  configured(sim, 'pc1', ['ip address dhcp']);
  sim.runToIdle();
  if (attacker) {
    configured(sim, 'att', ['ip address dhcp']);
    sim.runToIdle();
  }
  return sim;
}

const macOf = (sim: Simulation, dev: string, port = HOST_PORT): string => sim.device(dev)!.port(port)!.mac;
const daiRow = (sim: Simulation): ArpInspectionRow | undefined => sim.device('sw1')!.tables.get<ArpInspectionRow>('arp-inspection')!.get('10');
const counters = (r: ArpInspectionRow | undefined): [number, number, number, number] =>
  r === undefined ? [0, 0, 0, 0] : [r.forwarded, r.dropped, r.droppedNoBinding, r.droppedAcl];
const learned = (sim: Simulation): [string, string, string][] =>
  sim.device('sw1')!.tables.get<DhcpSnoopingRow>('dhcp-snooping')!.rows().filter((r) => r.kind === 'learned').map((r) => [r.key, r.ip, r.port]);
const daiDrops = (evs: readonly TraceEvent[]): Extract<TraceEvent, { kind: 'drop' }>[] => ofKind(evs, 'drop').filter((e) => e.reason === 'arp-inspection');
const daiLogs = (evs: readonly TraceEvent[]): Extract<TraceEvent, { kind: 'log' }>[] => ofKind(evs, 'log').filter((e) => e.device === 'sw1' && e.facility === ARP_INSPECTION_LOG_FACILITY);
const daiDebug = (evs: readonly TraceEvent[]): string[] =>
  ofKind(evs, 'debug').filter((e) => e.event.device === 'sw1' && e.event.category === ARP_INSPECTION_DEBUG_CATEGORY).map((e) => e.event.message);
const daiWrites = (evs: readonly TraceEvent[]): Extract<TraceEvent, { kind: 'tableWrite' }>[] => ofKind(evs, 'tableWrite').filter((e) => e.device === 'sw1' && e.table === 'arp-inspection');
/** ARP frames `dev` received on `port`. */
const arpRx = (evs: readonly TraceEvent[], dev: string, port: string): Extract<TraceEvent, { kind: 'frameRx' }>[] =>
  ofKind(evs, 'frameRx').filter((e) => e.device === dev && e.port === port && e.pdu.proto === 'arp');
/** ARP frames `dev` received whose sender hardware address is `sha`. */
function arpFromAt(sim: Simulation, evs: readonly TraceEvent[], dev: string, sha: string): number {
  return ofKind(evs, 'frameRx').filter((e) => e.device === dev && e.pdu.proto === 'arp' && sim.pdu(e.pdu.id)?.layer('arp')?.fields['sha'] === sha).length;
}
const gatewayMacAt = (sim: Simulation, dev: string): string | undefined => sim.device(dev)!.tables.arp.find((r) => r.ip === R1_ADDR)[0]?.mac;
const toNextSecond = (sim: Simulation): number => SEC - (sim.now % SEC);
const noBindingDetail = (mac: string, ip: string, port: string): string => `ARP request from ${mac} claiming ${ip} on ${port} (vlan 10) matches no DHCP snooping binding`;

/** Type `lines` on SW1's console, from global configuration. */
function typedOnSw1(sim: Simulation, lines: readonly string[]): void {
  const s = sim.cli.open('sw1', 'console');
  for (const line of ['enable', 'configure terminal', ...lines, 'end']) {
    const r = sim.cli.exec(s, line);
    if (r.error !== undefined) throw new Error(`"${line}" was refused: ${r.output}`);
  }
  sim.cli.close(s);
}

/** What a privileged console of SW1 prints for `line`. */
function shown(sim: Simulation, line: string): string {
  const s = sim.cli.open('sw1', 'console');
  sim.cli.exec(s, 'enable');
  const out = sim.cli.exec(s, line).output;
  sim.cli.close(s);
  return out;
}

describe('accept.p3.dai: the spoofed gateway (§3.4 steps 6–7)', () => {
  it('drops ATTACKER\'s gratuitous ARP with its detail, rule, counters and log; PC1\'s cache keeps R1\'s MAC; PC1\'s own ARPs are forwarded', () => {
    const sim = world();
    const pc1 = macOf(sim, 'pc1');
    const A = macOf(sim, 'att');
    expect(learned(sim)).toEqual([[`10|${pc1}`, PC1_LEASE, FA1], [`10|${A}`, ATTACKER_LEASE, FA5]]);

    // step 7: PC1's ARPs match its binding and are forwarded; R1's replies on the trusted trunk are not inspected
    const before = counters(daiRow(sim));
    const t0 = sim.trace(0).next;
    expect(ping(sim, 'pc1', R1_ADDR).text).toMatch(/!!!!!/);
    const pinged = sim.trace(t0).events;
    const fromPc1 = arpRx(pinged, 'sw1', FA1).length;
    expect(fromPc1).toBeGreaterThan(0);
    expect(arpRx(pinged, 'sw1', GI1).length).toBeGreaterThan(0);
    const after = counters(daiRow(sim));
    expect(after).toEqual([before[0] + fromPc1, before[1], before[2], 0]);
    expect(daiDrops(pinged)).toEqual([]);
    const r1Mac = gatewayMacAt(sim, 'pc1');
    expect(r1Mac).toBe(macOf(sim, 'r1', 'GigabitEthernet0/0'));

    // step 6: the learner gives ATTACKER the gateway's address; its announcement claims 192.168.10.1 from Fa0/5
    const t1 = sim.trace(0).next;
    configured(sim, 'att', [`ip address ${R1_ADDR} 255.255.255.0`]);
    sim.runToIdle();
    const spoof = sim.trace(t1).events;
    const d = daiDrops(spoof);
    expect(d.length).toBeGreaterThan(0);
    // every ARP ATTACKER sent now claims the gateway's address, and each one is refused at Fa0/5
    expect(d.every((e) => e.device === 'sw1' && e.port === FA5 && e.detail === noBindingDetail(A, R1_ADDR, FA5))).toBe(true);
    const garp = d[0]!;
    expect(garp.pdu.tag).toBe('arp-gratuitous');
    expect(garp.rule).toEqual({
      kind: 'arp-inspection',
      text: `on an untrusted port of an inspected VLAN an ARP needs a DHCP snooping binding for its sender (MAC ${A}, address ${R1_ADDR}, this port); a host with a static address needs "ip source binding", or the port needs "ip arp inspection trust"`,
      table: 'dhcp-snooping',
      key: `10|${A}`,
      iface: FA5,
    });
    // its row write: dropped + 1, droppedNoBinding + 1
    const w = daiWrites(spoof).find((e) => e.t === garp.t)!;
    const prev = w.previous as unknown as ArpInspectionRow;
    const row = w.row as unknown as ArpInspectionRow;
    expect(counters(row)).toEqual([prev.forwarded, prev.dropped + 1, prev.droppedNoBinding + 1, prev.droppedAcl]);
    expect(counters(daiRow(sim))).toEqual([after[0], after[1] + d.length, after[2] + d.length, 0]);
    // a severity-4 DAI log (original wording), at most five per second
    const logs = daiLogs(spoof);
    expect(logs.length).toBeGreaterThan(0);
    expect(logs.every((e) => e.severity === ARP_INSPECTION_LOG_SEVERITY)).toBe(true);
    expect(logs[0]!.message).toBe(`Refused an ARP request on ${FA5}, vlan 10: ${A} claims ${R1_ADDR}, which no DHCP snooping binding confirms.`);
    expect(daiDebug(spoof)[0]).toBe(`dropped ARP request from ${A} claiming ${R1_ADDR} on ${FA5} (vlan 10): no matching binding`);
    // the binding still says ATTACKER holds .12 on Fa0/5
    expect(learned(sim)).toEqual([[`10|${pc1}`, PC1_LEASE, FA1], [`10|${A}`, ATTACKER_LEASE, FA5]]);
    // the victim: no ARP from ATTACKER reached PC1, its row for the gateway is unchanged, and it still reaches R1
    expect(arpFromAt(sim, spoof, 'pc1', A)).toBe(0);
    expect(gatewayMacAt(sim, 'pc1')).toBe(r1Mac);
    expect(ping(sim, 'pc1', R1_ADDR).text).toMatch(/!!!!!/);
    expect(gatewayMacAt(sim, 'pc1')).toBe(r1Mac);

    // the statistics row (§5.8) is the table row
    const [fwd, dropped, noBinding, acl] = counters(daiRow(sim));
    const stats = shown(sim, 'show ip arp inspection statistics').split('\n');
    expect(stats[0]!.split(/\s{2,}/)).toEqual(['VLAN', 'Forwarded', 'Dropped', 'No binding', 'Filter denied']);
    expect(stats.slice(1).map((l) => l.trim().split(/\s+/))).toEqual([['10', String(fwd), String(dropped), String(noBinding), String(acl)]]);
  });

  it('with DAI off the same change rewrites PC1\'s row for the gateway (the poisoning demo); nothing is inspected', () => {
    const sim = world({ dai: false });
    ping(sim, 'pc1', R1_ADDR);
    const A = macOf(sim, 'att');
    expect(gatewayMacAt(sim, 'pc1')).toBe(macOf(sim, 'r1', 'GigabitEthernet0/0'));
    const t0 = sim.trace(0).next;
    configured(sim, 'att', [`ip address ${R1_ADDR} 255.255.255.0`]);
    sim.runToIdle();
    const evs = sim.trace(t0).events;
    expect(arpFromAt(sim, evs, 'pc1', A)).toBeGreaterThan(0);
    expect(gatewayMacAt(sim, 'pc1')).toBe(A);
    expect(daiDrops(sim.trace(0).events)).toEqual([]);
    expect(daiRow(sim)).toBeUndefined();
  });
});

describe('accept.p3.dai: the rate limit (§3.4 step 7, injected ARPs)', () => {
  const flood = arpFrame({ sha: FLOOD_MAC, spa: R1_ADDR });

  /** `count` ARPs on Fa0/5, 10 ms apart from the next second boundary (one sim-time second); the events. */
  function burst(sim: Simulation, count: number): TraceEvent[] {
    const from = sim.trace(0).next;
    injectFrames(sim, { from: 'inj', port: INJ_PORT, frames: [flood], count, spacingNs: 10 * MS, startNs: toNextSecond(sim) });
    sim.runToIdle();
    return sim.trace(from).events;
  }

  it(`${ARP_INSPECTION_DEFAULT_RATE_PPS} ARPs in one second pass the default limit; ${ARP_INSPECTION_DEFAULT_RATE_PPS + 1} err-disable Fa0/5`, () => {
    const sim = world({ fa5: 'injector' });
    const limit = ARP_INSPECTION_DEFAULT_RATE_PPS;
    const c0 = counters(daiRow(sim));
    const under = burst(sim, limit);
    expect(daiDrops(under).map((e) => e.detail)).toEqual(Array(limit).fill(noBindingDetail(FLOOD_MAC, R1_ADDR, FA5)));
    expect(sim.device('sw1')!.port(FA5)!.errDisabled).toBeUndefined();

    const c1 = counters(daiRow(sim));
    expect(c1).toEqual([c0[0], c0[1] + limit, c0[2] + limit, 0]);
    const over = burst(sim, limit + 1);
    const d = daiDrops(over);
    expect(d).toHaveLength(limit + 1);
    expect(d.every((e) => e.device === 'sw1' && e.port === FA5 && e.pdu.tag === INJECTED_TAG)).toBe(true);
    expect(d[limit]!.detail).toBe(`ARP rate limit exceeded on ${FA5}: ${limit + 1} packets in one second, the limit is ${limit}`);
    expect(d[limit]!.rule).toEqual({
      kind: 'arp-inspection',
      text: `an untrusted port accepts at most ${limit} ARP packets per second by default; more than that shuts the port down (error-disabled) until it is recovered`,
      iface: FA5,
    });
    expect(sim.device('sw1')!.port(FA5)!.errDisabled).toBe('arp-inspection');
    expect(ofKind(over, 'portState').filter((e) => e.device === 'sw1' && e.port === FA5).map((e) => e.reason)).toContain('err-disabled');
    expect(ofKind(over, 'log').filter((e) => e.device === 'sw1').map((e) => [e.severity, e.message])).toContainEqual([
      4, `Interface ${FA5} is error-disabled by dynamic ARP inspection: ${limit + 1} ARP packets in one second, the limit is ${limit}.`,
    ]);
    expect(daiDebug(over).at(-1)).toBe(`${FA5} (vlan 10): ${limit + 1} ARP packets in one second exceed the limit of ${limit}; error-disabling the port`);
    // the first `limit` refused for want of a binding, the last for the rate (counted as dropped, not "no binding")
    expect(counters(daiRow(sim))).toEqual([c1[0], c1[1] + limit + 1, c1[2] + limit, 0]);
    // nothing of the flood reached PC1 or R1
    expect(ofKind([...under, ...over], 'frameRx').filter((e) => e.pdu.tag === INJECTED_TAG && e.device !== 'sw1')).toEqual([]);
  });
});

describe('accept.p3.dai: the static-address gotcha (§3.4 step 8)', () => {
  it('a static host on an untrusted port has every ARP dropped until "ip source binding" names it', () => {
    const sim = world({ pc2: true });
    const pc2 = macOf(sim, 'pc2');
    const t0 = sim.trace(0).next;
    expect(ping(sim, 'pc2', R1_ADDR).text).not.toMatch(/!/);
    const refused = daiDrops(sim.trace(t0).events);
    expect(refused.length).toBeGreaterThan(0);
    expect(refused.every((e) => e.device === 'sw1' && e.port === FA2 && e.detail === noBindingDetail(pc2, PC2_ADDR, FA2))).toBe(true);
    expect(arpFromAt(sim, sim.trace(t0).events, 'r1', pc2)).toBe(0);

    typedOnSw1(sim, [`ip source binding ${pc2} vlan 10 ${PC2_ADDR} interface ${FA2}`]);
    const rows = sim.device('sw1')!.tables.get<DhcpSnoopingRow>('dhcp-snooping')!.rows().filter((r) => r.kind === 'static');
    expect(rows.map((r) => [r.key, r.ip, r.port])).toEqual([[`10|${pc2}`, PC2_ADDR, FA2]]);
    const fwd = counters(daiRow(sim))[0];
    const t1 = sim.trace(0).next;
    expect(ping(sim, 'pc2', R1_ADDR).text).toMatch(/!!!/);
    const ok = sim.trace(t1).events;
    expect(daiDrops(ok)).toEqual([]);
    expect(counters(daiRow(sim))[0]).toBe(fwd + arpRx(ok, 'sw1', FA2).length);
  });

  it('… or until the port is trusted (its ARPs are then not inspected)', () => {
    const sim = world({ pc2: true });
    expect(ping(sim, 'pc2', R1_ADDR).text).not.toMatch(/!/);
    typedOnSw1(sim, [`interface ${FA2}`, 'ip arp inspection trust']);
    const before = counters(daiRow(sim));
    const t0 = sim.trace(0).next;
    expect(ping(sim, 'pc2', R1_ADDR).text).toMatch(/!!!/);
    const evs = sim.trace(t0).events;
    expect(arpRx(evs, 'sw1', FA2).length).toBeGreaterThan(0);
    expect(daiDrops(evs)).toEqual([]);
    expect(counters(daiRow(sim))).toEqual(before);
  });
});

describe('accept.p3.dai: determinism', () => {
  it('three runs with one seed (pings, the spoof, a static host) are byte-identical', () => {
    const run = (): string => {
      const sim = world({ seed: 13, pc2: true });
      ping(sim, 'pc1', R1_ADDR);
      configured(sim, 'att', [`ip address ${R1_ADDR} 255.255.255.0`]);
      sim.runToIdle();
      ping(sim, 'pc2', R1_ADDR);
      return JSON.stringify([sim.trace(0).events, sim.snapshot()]);
    };
    const first = run();
    expect(run()).toBe(first);
    expect(run()).toBe(first);
  });
});
