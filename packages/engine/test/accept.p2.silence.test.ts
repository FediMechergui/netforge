/**
 * P2 acceptance — the silence rule (ARCHITECTURE-P2 §0 rule 5, §4.3, §7 W4 qa, §10.1 row `accept.p2.silence`).
 *
 * Worlds are built on `test/p2.world.ts` (§0 rule 13) with EVERY approved P2 daemon registered (vlan, dtp,
 * etherchannel, stp, nat, dhcpv6-client, dhcpv6-server, hsrp [S2]), so a daemon that wakes up unasked is caught, and
 * a daemon a model lists without a factory would be caught too ("Process … is not available").
 *
 *  (a) Every template and every CCNA 1 lab (with its reference solution applied), P1 profile, 600 s after the
 *      solution: no `pduCreated`, `tableWrite`, `tableExpire`, `log` or `debug` event attributable to a P2 daemon
 *      (including `sockets` rows those daemons would own), no write on a P2 table (descriptor `since: 'P2'`), no
 *      drop with a P2 reason, no "Process … is not available" log.
 *  (b) A P2-profile NF-C2960 with two PCs and no configuration, 600 s: the only P2-daemon PDUs are BPDUs (tag `bpdu`,
 *      background); no DTP / LACP / PAgP / HSRP / DHCPv6 / CAPWAP PDU; every BPDU that reached a PC was dropped
 *      `not-for-me` with `background: true`.
 *  (c) A P1 world with an NF-AP-1832 whose Vlan1 has a static address and no `capwap enable`: no CAPWAP PDU and no
 *      `capwap` row in 600 s.
 */
import { describe, expect, it } from 'vitest';
import type { DeviceId, ProcessName } from '../src/contracts/ids.js';
import type { ScenarioInfo } from '../src/contracts/scenario.js';
import type { Simulation } from '../src/contracts/simulation.js';
import { TABLE_DESCRIPTORS } from '../src/contracts/tables.js';
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
import { CCNA1_LABS, SCENARIO_SEED, TEMPLATES } from '../src/sim/scenarios.js';
import { configText, section } from '../src/sim/scenarios/kit.js';
import { pcConfig } from '../src/sim/scenarios/templates.js';
import { createP2Simulation, type P2FactoryOverlay } from './p2.world.js';
import { ofKind } from './sim.harness.js';

/** Every approved P2 daemon with its real factory (§8.5: MUST plus S2 hsrp). */
const ALL_P2: P2FactoryOverlay = {
  vlan: createVlan,
  dtp: createDtp,
  etherchannel: createEtherchannel,
  stp: createStp,
  nat: createNat,
  'dhcpv6-client': createDhcpv6Client,
  'dhcpv6-server': createDhcpv6Server,
  hsrp: createHsrp,
};

/** The daemons the §10.1 row names (the wireless and RADIUS ones have no factory yet; naming them costs nothing). */
const P2_DAEMONS: readonly ProcessName[] = ['vlan', 'dtp', 'stp', 'etherchannel', 'nat', 'hsrp', 'dhcpv6-client', 'dhcpv6-server', 'capwap-wtp', 'capwap-ac', 'radius-server'];
const isP2Daemon = (name: unknown): boolean => P2_DAEMONS.includes(name as ProcessName);

/** Tables whose descriptor is `since: 'P2'`. */
const P2_TABLES = new Set(Object.values(TABLE_DESCRIPTORS).filter((d) => d.since === 'P2').map((d) => d.name as string));
/** Drop reasons P2 added (contracts/link.ts). */
const P2_DROP_REASONS: readonly string[] = ['vlan-filtered', 'stp-discarding', 'port-security', 'nat-exhausted'];
/** Log facilities only P2 daemons write (stp/guards.ts, l2/port-security.ts, dhcpv6-client.ts). */
const P2_LOG_FACILITIES: readonly string[] = ['SPANTREE', 'PORTSEC', 'DHCPV6'];
/** Wire protocols only P2 daemons speak (a P2 PDU is recognisable by its layers whatever its tag). */
const P2_PROTOS: readonly string[] = ['dtp', 'lacp', 'pagp', 'hsrp', 'dhcpv6', 'capwap'];

/** §10.1: the P1-profile worlds are watched for 600 s after the script. */
const WINDOW_NS = 600 * SEC;
/** Every model of a template or lab is up by then (routers 45 s, data-centre switches 60 s). */
const BOOT_NS = 60 * SEC;

/** Every trace event of a run, collected through `onTrace` so the ring's capacity plays no part. */
function collect(sim: Simulation): TraceEvent[] {
  const out: TraceEvent[] = [];
  sim.onTrace((ev) => out.push(ev));
  return out;
}

/** Device id of a topology name. */
function idOf(sim: Simulation, name: string): DeviceId {
  for (const d of sim.devices()) if (d.spec.name === name) return d.id;
  throw new Error(`no device called ${name} in this world`);
}

/** Every event of `evs` attributable to a P2 daemon, as readable lines (empty = silence). */
function p2Attributable(evs: readonly TraceEvent[]): string[] {
  const out: string[] = [];
  for (const e of evs) {
    switch (e.kind) {
      case 'pduCreated':
        if (isP2Daemon(e.process)) out.push(`${String(e.t)} pduCreated ${e.device}/${e.process} ${e.pdu.tag ?? e.pdu.proto}`);
        else if ((e.pdu.layers ?? []).some((l) => P2_PROTOS.includes(l))) out.push(`${String(e.t)} pduCreated ${e.device}/${e.process} carries a P2 protocol: ${(e.pdu.layers ?? []).join('/')}`);
        break;
      case 'tableWrite':
      case 'tableExpire':
        if (P2_TABLES.has(e.table)) out.push(`${String(e.t)} ${e.kind} ${e.device} ${e.table} ${e.key}`);
        else if (e.table === 'sockets' && isP2Daemon(e.row['owner'])) out.push(`${String(e.t)} ${e.kind} ${e.device} sockets ${e.key} owned by ${String(e.row['owner'])}`);
        // a secure CAM row is port security's (eth-switch writes it only for `switchport port-security`, D12)
        else if (e.table === 'cam' && e.row['secure'] !== undefined) out.push(`${String(e.t)} ${e.kind} ${e.device} cam ${e.key} secure ${String(e.row['secure'])}`);
        break;
      case 'debug':
        if (isP2Daemon(e.event.process)) out.push(`${String(e.t)} debug ${e.event.device}/${e.event.process} ${e.event.message}`);
        // eth-switch's new port-security messages (§5.4) and every state-machine event (only P2 daemons emit them, D19)
        else if (e.event.category === 'port-security' || e.event.fsm !== undefined) out.push(`${String(e.t)} debug ${e.event.device}/${e.event.process} [${e.event.category}] ${e.event.message}`);
        break;
      case 'log':
        if (P2_LOG_FACILITIES.includes(e.facility) || e.message.includes('error-disabled') || e.message.includes('is not available')) {
          out.push(`${String(e.t)} log ${e.device} ${e.facility}: ${e.message}`);
        }
        break;
      case 'drop':
        if (P2_DROP_REASONS.includes(e.reason)) out.push(`${String(e.t)} drop ${e.device ?? e.link ?? '?'} ${e.reason} ${e.detail ?? ''}`);
        break;
      default:
        break;
    }
  }
  return out;
}

/** One P1-profile world of (a): load, boot, the reference solution, then the 600 s window. */
function runP1World(sc: ScenarioInfo): { sim: Simulation; events: TraceEvent[]; refused: string[] } {
  const sim = createP2Simulation({ seed: sc.seed ?? SCENARIO_SEED, profile: 'P1', factories: ALL_P2 });
  const events = collect(sim);
  const topo = sc.build();
  sim.loadTopology((sc.tasks?.length ?? 0) > 0 ? { ...topo, lab: { name: sc.name, version: sc.version ?? 1 } } : topo);
  for (const f of sc.faults ?? []) sim.injectFault(f.at, f.fault);
  sim.runFor(BOOT_NS);
  const refused: string[] = [];
  for (const [name, lines] of Object.entries(sc.solution ?? {})) {
    const r = sim.configure(idOf(sim, name), lines);
    for (const l of r.lines) if (!l.ok) refused.push(`${name}: ${l.line}: ${l.error?.message ?? l.output}`);
  }
  sim.runFor(WINDOW_NS);
  return { sim, events, refused };
}

describe('accept P2 silence (a): every template and CCNA 1 lab stays a P1 world with every P2 daemon registered', () => {
  const worlds = [...TEMPLATES, ...CCNA1_LABS];

  it('covers every template and every CCNA 1 lab', () => {
    expect(worlds.length).toBeGreaterThanOrEqual(24);
    expect(worlds.every((w) => w.category === 'template' || w.category === 'ccna1-lab')).toBe(true);
  });

  for (const sc of worlds) {
    it(`${sc.name}: 600 s in the P1 profile without a P2 daemon event, table write, drop reason or missing-process log`, () => {
      const { sim, events, refused } = runP1World(sc);
      expect(refused, 'the reference solution was accepted').toEqual([]);
      expect(sim.profile).toBe('P1');
      expect(sim.now).toBe(BOOT_NS + WINDOW_NS);
      // the world really ran, and the P2 daemons really are installed where the flip puts them (§9.2 item 13)
      expect(ofKind(events, 'pduCreated').length).toBeGreaterThan(0);
      const installed = new Set<ProcessName>();
      for (const d of sim.devices()) for (const p of d.processes.keys()) if (isP2Daemon(p)) installed.add(p);
      expect(installed.size, 'at least one P2 daemon runs in this world').toBeGreaterThan(0);
      expect(p2Attributable(events)).toEqual([]);
    }, 120_000);
  }
});

describe('accept P2 silence (b): an unconfigured P2-profile switch with two PCs', () => {
  // the row's world has no configuration at all; the second variant gives the PCs addresses so that ordinary P1
  // traffic (gratuitous ARP) runs beside the switch, which must still add nothing but BPDUs
  const variants: readonly [name: string, pc: (n: number) => string | undefined][] = [
    ['no configuration on any device', () => undefined],
    ['the PCs addressed, the switch untouched', (n) => pcConfig(`PC${n}`, `10.0.0.${n}`, '255.255.255.0')],
  ];
  for (const [variant, pcStartup] of variants) it(`${variant}: BPDUs and nothing else for 600 s; the PCs drop every BPDU not-for-me as background`, () => {
    const sim = createP2Simulation({ seed: 3, profile: 'P2', factories: ALL_P2 });
    const events = collect(sim);
    sim.addDevice({ id: 'sw1', type: 'switch.nfc2960', name: 'SW1' });
    for (const n of [1, 2]) {
      const startupConfig = pcStartup(n);
      sim.addDevice({ id: `pc${n}`, type: 'pc.nfpc', name: `PC${n}`, ...(startupConfig === undefined ? {} : { startupConfig }) });
    }
    sim.addLink({ id: 'l1', a: { device: 'pc1', port: 'GigabitEthernet0' }, b: { device: 'sw1', port: 'FastEthernet0/1' } });
    sim.addLink({ id: 'l2', a: { device: 'pc2', port: 'GigabitEthernet0' }, b: { device: 'sw1', port: 'FastEthernet0/2' } });
    sim.runFor(WINDOW_NS);
    const sw = sim.device('sw1')!;
    for (const p of ['vlan', 'dtp', 'etherchannel', 'stp'] as const) expect(sw.processes.has(p), p).toBe(true);
    expect(sim.device('pc1')!.processes.has('dhcpv6-client')).toBe(true);
    expect(sw.running.render()).toContain('spanning-tree mode pvst');

    const created = ofKind(events, 'pduCreated');
    const byP2 = created.filter((e) => isP2Daemon(e.process));
    expect(byP2.length).toBeGreaterThan(0);
    expect(byP2.every((e) => e.process === 'stp' && e.pdu.tag === 'bpdu')).toBe(true);
    // no other P2 protocol on the wire, from any daemon
    for (const e of created) {
      expect((e.pdu.layers ?? []).filter((l) => P2_PROTOS.includes(l)), `${e.device}/${e.process} ${e.pdu.tag ?? ''}`).toEqual([]);
      expect(['dtp', 'lacp', 'pagp']).not.toContain(e.pdu.tag ?? '');
    }
    const bpduTx = ofKind(events, 'frameTx').filter((e) => e.pdu.tag === 'bpdu');
    expect(bpduTx.length).toBeGreaterThan(0);
    expect(bpduTx.every((e) => e.background === true)).toBe(true);
    // every BPDU a PC received was dropped there, not-for-me and background
    for (const pc of ['pc1', 'pc2']) {
      const received = ofKind(events, 'frameRx').filter((e) => e.device === pc && e.pdu.tag === 'bpdu');
      const dropped = ofKind(events, 'drop').filter((e) => e.device === pc && e.pdu.tag === 'bpdu');
      expect(received.length, pc).toBeGreaterThan(0);
      expect(dropped.length, pc).toBe(received.length);
      expect(dropped.every((e) => e.reason === 'not-for-me' && e.background === true), pc).toBe(true);
    }
    expect(ofKind(events, 'log').filter((e) => e.message.includes('is not available'))).toEqual([]);
  }, 60_000);
});

describe('accept P2 silence (c): an autonomous NF-AP-1832 in a P1 world', () => {
  it('with a static Vlan1 address and no capwap enable sends no CAPWAP PDU and keeps no capwap row in 600 s', () => {
    const sim = createP2Simulation({ seed: 5, profile: 'P1', factories: ALL_P2 });
    const events = collect(sim);
    sim.addDevice({ id: 'sw1', type: 'switch.nfc2960', name: 'SW1' });
    sim.addDevice({
      id: 'ap1', type: 'ap.nfap-lw', name: 'AP1',
      startupConfig: configText([['hostname AP1'], section('interface Vlan1', ['ip address 192.168.1.5 255.255.255.0', 'no shutdown'])]),
    });
    sim.addDevice({ id: 'pc1', type: 'pc.nfpc', name: 'PC1', startupConfig: pcConfig('PC1', '192.168.1.10', '255.255.255.0') });
    sim.addLink({ id: 'l1', a: { device: 'ap1', port: 'GigabitEthernet0' }, b: { device: 'sw1', port: 'FastEthernet0/1' } });
    sim.addLink({ id: 'l2', a: { device: 'pc1', port: 'GigabitEthernet0' }, b: { device: 'sw1', port: 'FastEthernet0/2' } });
    sim.runFor(WINDOW_NS);
    const ap = sim.device('ap1')!;
    expect(ap.running.render()).not.toContain('capwap enable');
    expect(ap.port('Vlan1')?.l3.ipv4?.address).toBe('192.168.1.5');
    const capwap = events.filter((e) => (e.kind === 'pduCreated' || e.kind === 'frameTx') && ((e.pdu.layers ?? []).includes('capwap') || (e.pdu.tag ?? '').startsWith('capwap')));
    expect(capwap).toEqual([]);
    expect(ap.tables.get('capwap')?.size ?? 0).toBe(0);
    expect(ofKind(events, 'tableWrite').filter((e) => e.table === 'capwap')).toEqual([]);
    expect(ofKind(events, 'log').filter((e) => e.message.includes('is not available'))).toEqual([]);
  }, 60_000);
});
