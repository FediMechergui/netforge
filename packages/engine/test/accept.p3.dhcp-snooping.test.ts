/**
 * accept.p3.dhcp-snooping — W4 qa acceptance row (ARCHITECTURE-P3 §10.1; D13, §3.4 steps 1–5 and 9, §4.2, §5.3,
 * §5.8): DHCP snooping stops a rogue server, on `staged.world` at stage P3 with every approved P3 daemon
 * (test/hardening.world.ts: the worlds equal the flipped catalog; the flip itself is a later, separate step, rule 14).
 *
 * The §3.4 world: SW1 (NF-C2960) with PC1 on Fa0/1 (VLAN 10); ROGUE, a router serving 10.66.0.0/24 with gateway .1, on
 * Fa0/24; the trunk Gi0/1 to R1, which serves 192.168.10.0/24 on Gi0/0.10 (.1–.10 kept back). SW1: `ip dhcp
 * snooping`, `ip dhcp snooping vlan 10`, Gi0/1 `ip dhcp snooping trust`, Fa0/24 `ip dhcp snooping limit rate 10`; and a
 * static `ip source binding` on Fa0/1 (step 4: static bindings stay). The test injector (test/inject.ts, D13) is cabled
 * to Fa0/23, a trusted port, to shape the server messages no MUST sender produces (an ACK for a client the switch has
 * not seen, a NAK, a short lease); for step 5 it takes ROGUE's place on Fa0/24 and sends the burst. The switch is
 * configured through its startup configuration (the saved-file path), PC1 through its own grammar.
 *
 * Pinned:
 *   • step 1: PC1's DISCOVER on untrusted Fa0/1 is learned and flooded to Fa0/24 and Gi0/1;
 *   • step 2: ROGUE's OFFER on untrusted Fa0/24 is dropped `dhcp-snooping` with the exact detail, its rule (the `ip dhcp
 *     snooping vlan 10` line with the hint about `trust`) and the `ip dhcp snooping` debug line; PC1 never sees it;
 *   • step 3: R1's OFFER and ACK on trusted Gi0/1 are forwarded; the ACK writes the exact binding row (`show ip dhcp
 *     snooping binding` shows it); an ACK for a client with no CAM row writes nothing and the debug line says why;
 *   • step 4: the binding goes on NAK, at lease end (in the `cam-sweep`), at link-down of Fa0/1 and on RELEASE from
 *     Fa0/1; the static binding stays through all of it;
 *   • step 5: ten DHCP messages in one sim-time second on Fa0/24 pass the limit, eleven err-disable the port
 *     (`dhcp-rate-limit`) with the exact drop, log and port state; without a recovery line it stays down past the
 *     default interval (`runFor`); `errdisable recovery cause dhcp-rate-limit` brings it back exactly one interval
 *     later (typed afterwards, or configured beforehand);
 *   • step 9: the grader clone rebuilds the bindings (bindings are runtime state, absent from the export: the clone's
 *     PC1 runs DORA while it settles), and a connectivity check through a port inspected by DAI passes there, while
 *     the static host without a binding fails. The trunk carries `spanning-tree portfast trunk` in this world: in the
 *     clone every device boots from t = 0, and with the standard forward delay the trunk to R1 (up when R1 has booted,
 *     45 s) forwards only at 75 s, after PC1's four DISCOVERs (30–58 s); PC1 then takes a link-local address and the
 *     clone settles (110 s) before the client's periodic 60 s restart, so no binding would be rebuilt (reported in
 *     the W4 qa report, §3.4 step 9 / lab 20);
 *   • three runs with one seed are byte-identical (trace and snapshot JSON).
 */
import { describe, expect, it } from 'vitest';
import type { LabAssertion, ScenarioInfo } from '../src/contracts/scenario.js';
import type { Simulation } from '../src/contracts/simulation.js';
import type { ArpInspectionRow, DhcpSnoopingRow } from '../src/contracts/tables.js';
import { MS, SEC } from '../src/contracts/time.js';
import { TOPOLOGY_SCHEMA_ID } from '../src/contracts/topology.js';
import type { TraceEvent } from '../src/contracts/trace.js';
import { CAM_SWEEP_INTERVAL_NS } from '../src/protocols/eth-switch.js';
import { DHCP_SNOOPING_DEBUG_CATEGORY } from '../src/protocols/l2/dhcp-snooping.js';
import { ERRDISABLE_RECOVERY_DEFAULT_NS } from '../src/protocols/l2/port-security.js';
import { evaluateLab } from '../src/sim/lab-checks.js';
import { configText, configured, gradingClone } from './hardening.world.js';
import { INJECTED_TAG, INJECTOR_HOST_TYPE, dhcpServerFrame, injectFrames, withInjector } from './inject.js';
import { ofKind, ping } from './sim.harness.js';
import { createStagedSimulation } from './staged.world.js';

const FA1 = 'FastEthernet0/1';
const FA2 = 'FastEthernet0/2';
const FA23 = 'FastEthernet0/23';
const FA24 = 'FastEthernet0/24';
const GI1 = 'GigabitEthernet0/1';
const HOST_PORT = 'GigabitEthernet0';
/** The injector's trusted path (Fa0/23) and, for step 5, its port on Fa0/24. */
const INJ_TRUSTED = 'GigabitEthernet0';
const INJ_ROGUE = 'GigabitEthernet1';
const INJ_MAC = '02:4e:77:00:00:23';
const ROGUE_ADDR = '10.66.0.1';
const R1_ADDR = '192.168.10.1';
/** The address R1 leases first (.1–.10 kept back). */
const PC1_LEASE = '192.168.10.11';
/** The static binding of step 4 (a host that is not cabled; the line alone makes the row). */
const STATIC_MAC = '02:4e:66:00:00:05';
const STATIC_IP = '192.168.10.5';
/** A MAC address no CAM row holds. */
const STRANGER_MAC = '02:4e:99:00:00:99';
/** `ip dhcp snooping limit rate 10` on Fa0/24 (§3.4). */
const LIMIT = 10;
/** Every model booted; the trunk through spanning tree. */
const BOOT = 120 * SEC;

interface WorldOptions {
  readonly seed?: number;
  /** Who sits on Fa0/24: ROGUE the router (default) or the injector (step 5). */
  readonly fa24?: 'rogue' | 'injector';
  /** DAI on VLAN 10 too (Gi0/1 trusted for it), for the inspected-port check of step 9. */
  readonly dai?: boolean;
  /** `errdisable recovery cause dhcp-rate-limit` in SW1's startup configuration. */
  readonly recovery?: boolean;
  /** PC2, a static-address host (192.168.10.50) on Fa0/2. */
  readonly pc2?: boolean;
  /** `spanning-tree portfast trunk` on Gi0/1 (step 9: the trunk forwards as soon as R1's port comes up). */
  readonly portfastTrunk?: boolean;
}

function access(port: string, more: readonly string[] = []): string[] {
  return [`interface ${port}`, ' switchport mode access', ' switchport access vlan 10', ' spanning-tree portfast', ...more.map((l) => ` ${l}`)];
}

function sw1Config(o: WorldOptions): string {
  return configText([
    ['hostname SW1'],
    ['vlan 10'],
    access(FA1),
    access(FA2),
    access(FA23, ['ip dhcp snooping trust']),
    access(FA24, [`ip dhcp snooping limit rate ${LIMIT}`]),
    [
      `interface ${GI1}`, ' switchport mode trunk', ' ip dhcp snooping trust',
      ...(o.dai === true ? [' ip arp inspection trust'] : []),
      ...(o.portfastTrunk === true ? [' spanning-tree portfast trunk'] : []),
    ],
    [
      'ip dhcp snooping',
      'ip dhcp snooping vlan 10',
      `ip source binding ${STATIC_MAC} vlan 10 ${STATIC_IP} interface ${FA1}`,
      ...(o.dai === true ? ['ip arp inspection vlan 10'] : []),
      ...(o.recovery === true ? ['errdisable recovery cause dhcp-rate-limit'] : []),
    ],
  ]);
}

const R1_CONFIG = configText([
  ['hostname R1'],
  ['interface GigabitEthernet0/0', ' no shutdown'],
  ['interface GigabitEthernet0/0.10', ' encapsulation dot1q 10', ` ip address ${R1_ADDR} 255.255.255.0`],
  ['ip dhcp excluded-address 192.168.10.1 192.168.10.10'],
  ['ip dhcp pool V10', ' network 192.168.10.0 255.255.255.0', ` default-router ${R1_ADDR}`],
]);

const ROGUE_CONFIG = configText([
  ['hostname ROGUE'],
  ['interface GigabitEthernet0/0', ` ip address ${ROGUE_ADDR} 255.255.255.0`, ' no shutdown'],
  ['ip dhcp pool LURE', ' network 10.66.0.0 255.255.255.0', ` default-router ${ROGUE_ADDR}`],
]);

/** The §3.4 world (file header), booted and settled; PC1 not yet asking for an address. */
function world(o: WorldOptions = {}): Simulation {
  const sim = createStagedSimulation({ seed: o.seed ?? 5, stage: 'P3', factories: withInjector() });
  sim.addDevice({ id: 'sw1', type: 'switch.nfc2960', name: 'SW1', startupConfig: sw1Config(o) });
  sim.addDevice({ id: 'r1', type: 'router.nf2911', name: 'R1', startupConfig: R1_CONFIG });
  sim.addDevice({ id: 'pc1', type: 'pc.nfpc', name: 'PC1', startupConfig: configText([['hostname PC1']]) });
  sim.addDevice({ id: 'inj', type: INJECTOR_HOST_TYPE, name: 'INJ' });
  sim.addLink({ id: 'l_pc1', a: { device: 'pc1', port: HOST_PORT }, b: { device: 'sw1', port: FA1 } });
  sim.addLink({ id: 'l_inj', a: { device: 'inj', port: INJ_TRUSTED }, b: { device: 'sw1', port: FA23 } });
  sim.addLink({ id: 'l_r1', a: { device: 'sw1', port: GI1 }, b: { device: 'r1', port: 'GigabitEthernet0/0' } });
  if ((o.fa24 ?? 'rogue') === 'rogue') {
    sim.addDevice({ id: 'rogue', type: 'router.nf2911', name: 'ROGUE', startupConfig: ROGUE_CONFIG });
    sim.addLink({ id: 'l_rogue', a: { device: 'rogue', port: 'GigabitEthernet0/0' }, b: { device: 'sw1', port: FA24 } });
  } else {
    sim.addLink({ id: 'l_inj24', a: { device: 'inj', port: INJ_ROGUE }, b: { device: 'sw1', port: FA24 } });
  }
  if (o.pc2 === true) {
    sim.addDevice({
      id: 'pc2', type: 'pc.nfpc', name: 'PC2',
      startupConfig: configText([['hostname PC2'], ['interface GigabitEthernet0', ' ip address 192.168.10.50 255.255.255.0'], [`ip default-gateway ${R1_ADDR}`]]),
    });
    sim.addLink({ id: 'l_pc2', a: { device: 'pc2', port: HOST_PORT }, b: { device: 'sw1', port: FA2 } });
  }
  sim.runFor(BOOT);
  sim.runToIdle();
  return sim;
}

const macOf = (sim: Simulation, dev: string, port = HOST_PORT): string => sim.device(dev)!.port(port)!.mac;
const bindings = (sim: Simulation): DhcpSnoopingRow[] => sim.device('sw1')!.tables.get<DhcpSnoopingRow>('dhcp-snooping')!.rows().map((r) => ({ ...r }));
const learned = (sim: Simulation): DhcpSnoopingRow[] => bindings(sim).filter((r) => r.kind === 'learned');
const staticRows = (sim: Simulation): [string, string, string, string][] => bindings(sim).filter((r) => r.kind === 'static').map((r) => [r.key, r.ip, r.port, r.kind]);
const STATIC_ROW: [string, string, string, string] = [`10|${STATIC_MAC}`, STATIC_IP, FA1, 'static'];
const drops = (evs: readonly TraceEvent[], reason: string): Extract<TraceEvent, { kind: 'drop' }>[] => ofKind(evs, 'drop').filter((e) => e.reason === reason);
const snoopDebug = (evs: readonly TraceEvent[]): string[] =>
  ofKind(evs, 'debug').filter((e) => e.event.device === 'sw1' && e.event.category === DHCP_SNOOPING_DEBUG_CATEGORY).map((e) => e.event.message);
const snoopWrites = (evs: readonly TraceEvent[]): Extract<TraceEvent, { kind: 'tableWrite' }>[] => ofKind(evs, 'tableWrite').filter((e) => e.table === 'dhcp-snooping');
const snoopExpires = (evs: readonly TraceEvent[]): [string, string][] =>
  ofKind(evs, 'tableExpire').filter((e) => e.table === 'dhcp-snooping').map((e) => [e.key, e.reason]);
/** The next sim-time second boundary, as a delay from now (rate windows are aligned to seconds). */
const toNextSecond = (sim: Simulation): number => SEC - (sim.now % SEC);

/** One received DHCP frame: where, which message, from which IPv4 source. */
interface DhcpRx {
  readonly device: string;
  readonly port: string;
  readonly type: string;
  readonly src: string;
  readonly injected: boolean;
}
function dhcpRx(sim: Simulation, evs: readonly TraceEvent[]): DhcpRx[] {
  return ofKind(evs, 'frameRx').flatMap((e) => {
    const p = sim.pdu(e.pdu.id);
    const dhcp = p?.layer('dhcp');
    if (p === undefined || dhcp === undefined) return [];
    return [{ device: e.device, port: e.port, type: String(dhcp.fields['messageType']), src: String(p.layer('ipv4')?.fields['src']), injected: e.pdu.tag === INJECTED_TAG }];
  });
}

/** PC1 asks for an address (typed) and the world settles; the events of the exchange. */
function dora(sim: Simulation): TraceEvent[] {
  const from = sim.trace(0).next;
  configured(sim, 'pc1', ['ip address dhcp']);
  sim.runToIdle();
  return sim.trace(from).events;
}

/** Inject one server message on the trusted Fa0/23 and settle; the events. */
function injectTrusted(sim: Simulation, frame: ReturnType<typeof dhcpServerFrame>): TraceEvent[] {
  const from = sim.trace(0).next;
  injectFrames(sim, { from: 'inj', port: INJ_TRUSTED, frames: [frame], spacingNs: 0 });
  sim.runToIdle();
  return sim.trace(from).events;
}

/** A privileged console of SW1 prints `line`. */
function shown(sim: Simulation, line: string): string {
  const s = sim.cli.open('sw1', 'console');
  sim.cli.exec(s, 'enable');
  const out = sim.cli.exec(s, line).output;
  sim.cli.close(s);
  return out;
}

describe('accept.p3.dhcp-snooping: a rogue server on an untrusted port (§3.4 steps 1–3)', () => {
  it('floods the DISCOVER, drops the rogue OFFER exactly, forwards R1\'s OFFER and ACK and writes the exact binding row', () => {
    const sim = world();
    const pc1 = macOf(sim, 'pc1');
    const evs = dora(sim);
    const rx = dhcpRx(sim, evs);

    // step 1: learned on untrusted Fa0/1 and flooded to Fa0/24 (ROGUE) and Gi0/1 (R1)
    expect(rx.filter((r) => r.device === 'sw1' && r.type === 'DISCOVER').map((r) => r.port)).toEqual([FA1]);
    expect(rx.some((r) => r.device === 'rogue' && r.type === 'DISCOVER')).toBe(true);
    expect(rx.some((r) => r.device === 'r1' && r.type === 'DISCOVER')).toBe(true);
    expect(sim.device('sw1')!.tables.cam.get(`10/${pc1}`)?.port).toBe(FA1);

    // step 2: ROGUE's OFFER dies at SW1 with the §3.4 detail, its rule and the debug line; PC1 never sees it
    expect(rx.filter((r) => r.device === 'sw1' && r.port === FA24 && r.type === 'OFFER').map((r) => r.src)).toEqual([ROGUE_ADDR]);
    const dropped = drops(evs, 'dhcp-snooping');
    expect(dropped).toHaveLength(1);
    expect(dropped[0]).toMatchObject({ device: 'sw1', port: FA24, detail: `DHCP server message (OFFER) from ${ROGUE_ADDR} on untrusted port ${FA24} (vlan 10)` });
    expect(dropped[0]!.rule).toEqual({
      kind: 'dhcp-snooping',
      text: `DHCP snooping on vlan 10 accepts server messages only on trusted ports; if a legitimate server is reached through ${FA24}, mark the port with "ip dhcp snooping trust"`,
      config: { context: [], line: ['ip', 'dhcp', 'snooping', 'vlan', '10'] },
      iface: FA24,
    });
    expect(snoopDebug(evs)[0]).toBe(`dropped OFFER from ${ROGUE_ADDR} on untrusted ${FA24} (vlan 10)`);
    expect(rx.filter((r) => r.device === 'pc1' && r.src === ROGUE_ADDR)).toEqual([]);

    // step 3: R1's OFFER and ACK cross the trusted trunk to PC1; nothing else of the exchange is dropped
    expect(rx.filter((r) => r.device === 'pc1').map((r) => [r.type, r.src])).toEqual([['OFFER', R1_ADDR], ['ACK', R1_ADDR]]);
    expect(ofKind(evs, 'drop').filter((e) => e.device === 'sw1' && e.pdu.proto === 'dhcp')).toEqual([dropped[0]]);
    expect(sim.device('pc1')!.port(HOST_PORT)!.l3.ipv4).toMatchObject({ address: PC1_LEASE, prefixLen: 24, origin: 'dhcp' });
    const writes = snoopWrites(evs);
    expect(writes).toHaveLength(1);
    const ackAt = writes[0]!.t;
    expect(learned(sim)).toEqual([{
      key: `10|${pc1}`, mac: pc1, ip: PC1_LEASE, vlan: 10, port: FA1, kind: 'learned', leaseS: 86400, updatedAt: ackAt, expiresAt: ackAt + 86400 * SEC,
    }]);
    expect(staticRows(sim)).toEqual([STATIC_ROW]);
    expect(snoopDebug(evs).slice(1)).toEqual([`binding ${pc1} ${PC1_LEASE} on ${FA1} (vlan 10), lease 86400 s`]);

    // the show command reads the same rows (§5.8)
    const lines = shown(sim, 'show ip dhcp snooping binding').split('\n');
    expect(lines[0]!.split(/\s{2,}/)).toEqual(['MAC address', 'IP address', 'Lease (s)', 'Kind', 'VLAN', 'Interface']);
    const left = String(Math.floor((ackAt + 86400 * SEC - sim.now) / SEC));
    expect(lines.slice(1).map((l) => l.trim().split(/\s+/))).toEqual([
      [STATIC_MAC, STATIC_IP, 'infinite', 'static', '10', FA1],
      [pc1, PC1_LEASE, left, 'learned', '10', FA1],
      ['2', 'bindings'],
    ]);
  });

  it('an ACK on a trusted port for a client the MAC address table does not hold writes no binding, and says why', () => {
    const sim = world();
    const evs = injectTrusted(sim, dhcpServerFrame({ srcMac: INJ_MAC, serverIp: R1_ADDR, chaddr: STRANGER_MAC, yiaddr: '192.168.10.70', type: 'ACK' }));
    expect(snoopWrites(evs)).toEqual([]);
    expect(drops(evs, 'dhcp-snooping')).toEqual([]);
    expect(snoopDebug(evs)).toEqual([`ACK for ${STRANGER_MAC} (vlan 10) records no binding for 192.168.10.70: the MAC address table has no entry for the client`]);
    expect(learned(sim)).toEqual([]);
  });
});

describe('accept.p3.dhcp-snooping: the binding\'s end (§3.4 step 4)', () => {
  it('goes on NAK, at lease end in the cam-sweep, at link-down of Fa0/1 and on RELEASE from Fa0/1; the static binding stays', () => {
    const sim = world();
    const pc1 = macOf(sim, 'pc1');
    const key = `10|${pc1}`;
    dora(sim);
    expect(learned(sim).map((r) => [r.key, r.ip, r.port])).toEqual([[key, PC1_LEASE, FA1]]);

    // a NAK (from a server on a trusted port) removes the learned binding
    const nak = injectTrusted(sim, dhcpServerFrame({ srcMac: INJ_MAC, serverIp: R1_ADDR, chaddr: pc1, type: 'NAK' }));
    expect(snoopExpires(nak)).toEqual([[key, 'cleared']]);
    expect(snoopDebug(nak)).toEqual([`binding ${pc1} ${PC1_LEASE} (vlan 10) removed: NAK`]);
    expect(learned(sim)).toEqual([]);
    expect(staticRows(sim)).toEqual([STATIC_ROW]);

    // an ACK with a 60 s lease binds PC1 again; the first cam-sweep at or after the lease end removes it
    const short = injectTrusted(sim, dhcpServerFrame({ srcMac: INJ_MAC, serverIp: R1_ADDR, chaddr: pc1, yiaddr: PC1_LEASE, type: 'ACK', leaseS: 60 }));
    expect(snoopWrites(short)).toHaveLength(1);
    const end = learned(sim)[0]!.expiresAt!;
    expect(end).toBe(snoopWrites(short)[0]!.t + 60 * SEC);
    sim.runUntil(end - 1);
    expect(learned(sim)).toHaveLength(1);
    const t0 = sim.trace(0).next;
    sim.runFor(CAM_SWEEP_INTERVAL_NS + 1);
    const aged = ofKind(sim.trace(t0).events, 'tableExpire').filter((e) => e.table === 'dhcp-snooping');
    expect(aged.map((e) => [e.key, e.reason])).toEqual([[key, 'aged']]);
    expect(aged[0]!.t).toBeGreaterThanOrEqual(end);
    expect(aged[0]!.t).toBeLessThan(end + CAM_SWEEP_INTERVAL_NS);
    expect(snoopDebug(sim.trace(t0).events)).toEqual([`binding ${pc1} ${PC1_LEASE} on ${FA1} (vlan 10) removed: its lease ended`]);
    expect(staticRows(sim)).toEqual([STATIC_ROW]);

    // PC1 leases again; link-down of Fa0/1 removes its learned binding, never the static one on the same port
    configured(sim, 'pc1', ['no ip address dhcp']);
    sim.runToIdle();
    dora(sim);
    expect(learned(sim).map((r) => [r.key, r.port])).toEqual([[key, FA1]]);
    const t1 = sim.trace(0).next;
    sim.removeLink('l_pc1');
    sim.runFor(SEC);
    const down = sim.trace(t1).events;
    expect(snoopExpires(down)).toEqual([[key, 'link-down']]);
    expect(snoopDebug(down)).toEqual([`binding ${pc1} ${PC1_LEASE} on ${FA1} (vlan 10) removed: link down`]);
    expect(staticRows(sim)).toEqual([STATIC_ROW]);

    // cabled again, PC1 leases again; `no ip address dhcp` sends a RELEASE from Fa0/1, which removes the binding
    sim.addLink({ id: 'l_pc1b', a: { device: 'pc1', port: HOST_PORT }, b: { device: 'sw1', port: FA1 } });
    sim.runFor(5 * SEC);
    configured(sim, 'pc1', ['no ip address dhcp']);
    sim.runToIdle();
    dora(sim);
    expect(learned(sim).map((r) => [r.key, r.port])).toEqual([[key, FA1]]);
    const t2 = sim.trace(0).next;
    configured(sim, 'pc1', ['no ip address dhcp']);
    sim.runToIdle();
    const rel = sim.trace(t2).events;
    expect(snoopExpires(rel)).toEqual([[key, 'cleared']]);
    expect(snoopDebug(rel)).toEqual([`binding ${pc1} ${PC1_LEASE} (vlan 10) removed: RELEASE on ${FA1}`]);
    expect(learned(sim)).toEqual([]);
    expect(staticRows(sim)).toEqual([STATIC_ROW]);
  });
});

describe('accept.p3.dhcp-snooping: the rate limit (§3.4 step 5, an injected burst)', () => {
  const offer = (sim: Simulation) => dhcpServerFrame({ srcMac: INJ_MAC, serverIp: ROGUE_ADDR, chaddr: macOf(sim, 'pc1'), yiaddr: '10.66.0.20' });
  const untrustedDetail = `DHCP server message (OFFER) from ${ROGUE_ADDR} on untrusted port ${FA24} (vlan 10)`;

  /** `count` OFFERs on Fa0/24, 10 ms apart from the next second boundary (all in one sim-time second); the events. */
  function burst(sim: Simulation, count: number): TraceEvent[] {
    const from = sim.trace(0).next;
    injectFrames(sim, { from: 'inj', port: INJ_ROGUE, frames: [offer(sim)], count, spacingNs: 10 * MS, startNs: toNextSecond(sim) });
    sim.runToIdle();
    return sim.trace(from).events;
  }
  const disabledAtOf = (evs: readonly TraceEvent[]): number =>
    ofKind(evs, 'portState').find((e) => e.device === 'sw1' && e.port === FA24 && e.reason === 'err-disabled')!.t;

  it(`${LIMIT} messages in one second pass; ${LIMIT + 1} err-disable Fa0/24 with the exact drop, log and port state; no recovery line keeps it down`, () => {
    const sim = world({ fa24: 'injector' });
    const ten = burst(sim, LIMIT);
    expect(drops(ten, 'dhcp-snooping').map((e) => e.detail)).toEqual(Array(LIMIT).fill(untrustedDetail));
    expect(sim.device('sw1')!.port(FA24)!.errDisabled).toBeUndefined();

    const eleven = burst(sim, LIMIT + 1);
    const d = drops(eleven, 'dhcp-snooping');
    expect(d.map((e) => e.detail)).toEqual([
      ...Array(LIMIT).fill(untrustedDetail),
      `DHCP rate limit exceeded on ${FA24}: ${LIMIT + 1} packets in one second, the limit is ${LIMIT}`,
    ]);
    expect(d.every((e) => e.device === 'sw1' && e.port === FA24 && e.pdu.tag === INJECTED_TAG)).toBe(true);
    expect(d[LIMIT]!.rule).toEqual({
      kind: 'dhcp-snooping',
      text: `${FA24} accepts at most ${LIMIT} DHCP packets per second; more than that shuts the port down (error-disabled) until it is recovered`,
      config: { context: [['interface', FA24]], line: ['ip', 'dhcp', 'snooping', 'limit', 'rate', String(LIMIT)] },
      iface: FA24,
    });
    expect(sim.device('sw1')!.port(FA24)!.errDisabled).toBe('dhcp-rate-limit');
    expect(ofKind(eleven, 'log').filter((e) => e.device === 'sw1').map((e) => [e.severity, e.message])).toContainEqual([
      4, `Interface ${FA24} is error-disabled by the DHCP snooping rate limit: ${LIMIT + 1} DHCP packets in one second, the limit is ${LIMIT}.`,
    ]);
    expect(ofKind(eleven, 'portState').filter((e) => e.device === 'sw1' && e.port === FA24).map((e) => e.reason)).toContain('err-disabled');
    expect(snoopDebug(eleven).at(-1)).toBe(`${FA24} (vlan 10): ${LIMIT + 1} DHCP packets in this second exceed the limit of ${LIMIT}; error-disabling the port`);
    // nothing of the burst reached PC1 or R1
    expect(dhcpRx(sim, [...ten, ...eleven]).filter((r) => r.injected && r.device !== 'sw1')).toEqual([]);

    // without `errdisable recovery cause dhcp-rate-limit` the port stays down well past the default interval
    sim.runFor(ERRDISABLE_RECOVERY_DEFAULT_NS + 60 * SEC);
    expect(sim.device('sw1')!.port(FA24)!.errDisabled).toBe('dhcp-rate-limit');

    // the recovery line typed now brings it back one default interval later
    const s = sim.cli.open('sw1', 'console');
    for (const line of ['enable', 'configure terminal', 'errdisable recovery cause dhcp-rate-limit', 'end']) expect(sim.cli.exec(s, line).error, line).toBeUndefined();
    sim.cli.close(s);
    const typedAt = sim.now;
    const t0 = sim.trace(0).next;
    sim.runFor(ERRDISABLE_RECOVERY_DEFAULT_NS + 10 * SEC);
    const rec = sim.trace(t0).events;
    expect(sim.device('sw1')!.port(FA24)!.errDisabled).toBeUndefined();
    expect(ofKind(rec, 'portState').find((e) => e.port === FA24 && e.reason === 'err-recovered')!.t).toBe(typedAt + ERRDISABLE_RECOVERY_DEFAULT_NS);
    expect(ofKind(rec, 'log').filter((e) => e.device === 'sw1').map((e) => e.message)).toContain(
      `Interface ${FA24} leaves the error-disabled state (the DHCP snooping rate limit) and may come up again.`,
    );

    // back in service: a rogue OFFER is inspected (and dropped) again, not err-disabled
    const after = burst(sim, 1);
    expect(drops(after, 'dhcp-snooping').map((e) => e.detail)).toEqual([untrustedDetail]);
    expect(sim.device('sw1')!.port(FA24)!.errDisabled).toBeUndefined();
  });

  it('with the recovery line configured beforehand the port comes back exactly one default interval after the err-disable (runFor)', () => {
    const sim = world({ fa24: 'injector', recovery: true });
    const evs = burst(sim, LIMIT + 1);
    expect(sim.device('sw1')!.port(FA24)!.errDisabled).toBe('dhcp-rate-limit');
    const disabledAt = disabledAtOf(evs);
    expect(snoopDebug(evs)).toContain(`${FA24} recovers from err-disable in ${ERRDISABLE_RECOVERY_DEFAULT_NS / SEC} s`);
    // still down just before the interval ends
    sim.runUntil(disabledAt + ERRDISABLE_RECOVERY_DEFAULT_NS - 1);
    expect(sim.device('sw1')!.port(FA24)!.errDisabled).toBe('dhcp-rate-limit');
    const t0 = sim.trace(0).next;
    sim.runFor(10 * SEC);
    const rec = sim.trace(t0).events;
    expect(ofKind(rec, 'portState').find((e) => e.port === FA24 && e.reason === 'err-recovered')!.t).toBe(disabledAt + ERRDISABLE_RECOVERY_DEFAULT_NS);
    expect(sim.device('sw1')!.port(FA24)!.errDisabled).toBeUndefined();
    expect(snoopDebug(rec)).toContain(`recovering ${FA24} from err-disable`);
  });
});

describe('accept.p3.dhcp-snooping: the grader clone (§3.4 step 9)', () => {
  function labWith(assertions: readonly LabAssertion[]): ScenarioInfo {
    return {
      name: 'snooping-clone-demo',
      title: 'Snooping clone demo',
      description: 'A lab built by the test',
      category: 'ccna3-lab',
      build: () => ({ schema: TOPOLOGY_SCHEMA_ID, seed: 1, devices: [], links: [] }),
      tasks: [{ id: 'only', title: 'Only task', description: 'One task', points: 10, assertions }],
    };
  }

  it('rebuilds the bindings (the clone\'s PC1 runs DORA while it settles), and a check through a DAI-inspected port passes there', () => {
    const sim = world({ dai: true, pc2: true, portfastTrunk: true });
    dora(sim);
    const pc1 = macOf(sim, 'pc1');
    expect(learned(sim).map((r) => [r.key, r.ip, r.port])).toEqual([[`10|${pc1}`, PC1_LEASE, FA1]]);
    // bindings are runtime state: the export carries no lease and no row
    const topo = JSON.stringify(sim.exportTopology());
    expect(topo).not.toContain(PC1_LEASE);

    const clone = gradingClone(sim);
    expect(clone.device('pc1')!.port(HOST_PORT)!.l3.ipv4).toMatchObject({ address: PC1_LEASE, origin: 'dhcp' });
    const rows = clone.device('sw1')!.tables.get<DhcpSnoopingRow>('dhcp-snooping')!.rows();
    expect(rows.map((r) => [r.key, r.ip, r.port, r.kind])).toEqual([STATIC_ROW, [`10|${pc1}`, PC1_LEASE, FA1, 'learned']]);
    // the clone's DAI checks PC1's ARPs against the rebuilt binding (forwarded) and refuses PC2's (no binding)
    const daiOf = (w: Simulation): ArpInspectionRow => w.device('sw1')!.tables.get<ArpInspectionRow>('arp-inspection')!.get('10')!;
    const forwarded = daiOf(clone).forwarded;
    const p1 = ping(clone, 'pc1', R1_ADDR);
    expect(p1.text).toMatch(/!!!!!/);
    expect(daiOf(clone).forwarded).toBeGreaterThan(forwarded);
    const p2 = ping(clone, 'pc2', R1_ADDR);
    expect(p2.text).not.toMatch(/!/);
    const refused = drops(p2.evs, 'arp-inspection');
    expect(refused.length).toBeGreaterThan(0);
    expect(refused.every((e) => e.device === 'sw1' && e.port === FA2)).toBe(true);

    // through the grader: PC1 (bound on the inspected Fa0/1) reaches R1; PC2 (static, no binding) does not
    const before = JSON.stringify({ now: sim.now, head: sim.trace(0).next, topo: sim.exportTopology() });
    const status = evaluateLab(sim, labWith([
      { kind: 'connectivity', from: 'PC1', to: 'R1', toAddress: R1_ADDR, expect: 'success' },
      { kind: 'connectivity', from: 'PC2', to: 'R1', toAddress: R1_ADDR, expect: 'fail' },
    ]));
    expect(status.results[0]!.assertions.map((a) => (a.pass ? undefined : a.detail))).toEqual([undefined, undefined]);
    expect(JSON.stringify({ now: sim.now, head: sim.trace(0).next, topo: sim.exportTopology() })).toBe(before);
  });
});

describe('accept.p3.dhcp-snooping: determinism', () => {
  it('three runs with one seed (the rogue exchange, then a burst on Fa0/24) are byte-identical', () => {
    const run = (): string => {
      const sim = world({ seed: 11, fa24: 'injector', recovery: true });
      dora(sim);
      injectFrames(sim, { from: 'inj', port: INJ_ROGUE, frames: [dhcpServerFrame({ srcMac: INJ_MAC, serverIp: ROGUE_ADDR, chaddr: macOf(sim, 'pc1') })], count: LIMIT + 1, spacingNs: 10 * MS });
      sim.runToIdle();
      return JSON.stringify([sim.trace(0).events, sim.snapshot()]);
    };
    const first = run();
    expect(run()).toBe(first);
    expect(run()).toBe(first);
  });
});
