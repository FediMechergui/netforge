/**
 * P3 acceptance — LLDP on request (ARCHITECTURE-P3 §10.1 row `accept.p3.lldp`; §3.6 step 7; D2, D18; §4.2, §4.3;
 * §5.5; §7 W4 qa).
 *
 * The row, clause by clause, on `staged.world` at stage P3 (rule 13; rule 14: the qa step runs before the catalog flip,
 * so the daemons the W4 flip registers are laid over the registry — `FLIP_FACTORIES`; after the flip the overlay names
 * the registry's own factories). LLDP is off by default in every profile (D2); `lldp run` and the per-port lines are
 * typed on consoles (the real grammar) or stored at boot through `startupConfig`.
 *
 *   • the IEEE byte golden: R1's frame on the wire is, byte for byte, the IEEE 802.1AB image written out below from
 *     the standard (not from the codec): destination 01:80:c2:00:00:0e, ethertype 0x88cc, chassis id subtype 4 (the
 *     chassis MAC), port id subtype 5 (the interface name), TTL 120, system name, system description, system
 *     capabilities (router), the IPv4 management address, the end TLV, and a valid IEEE CRC-32 FCS;
 *   • the 30 s interval;
 *   • transmit/receive asymmetry (`no lldp transmit`, `no lldp receive`, per port);
 *   • never bridged by a VLAN-aware switch (a switch with LLDP off consumes the frames as off; with it on, it learns
 *     and still forwards nothing);
 *   • dropped with `lldp is not running on this device` at the controller (NF-WLC-9800 runs cdp but not lldp);
 *   • bridged by a transparent one (NF-BRIDGE-4, a learning bridge without VLANs: two routers learn each other).
 */
import { describe, expect, it } from 'vitest';
import type { DeviceId, SessionId } from '../src/contracts/ids.js';
import type { Simulation } from '../src/contracts/simulation.js';
import type { LldpNeighbourRow } from '../src/contracts/tables.js';
import { SEC } from '../src/contracts/time.js';
import type { TraceEvent } from '../src/contracts/trace.js';
import { createAcl } from '../src/protocols/acl.js';
import { createCdp } from '../src/protocols/cdp.js';
import { createEigrp } from '../src/protocols/eigrp.js';
import { createGre } from '../src/protocols/gre.js';
import { createIke } from '../src/protocols/ike.js';
import { createLldp, LLDP_DETAIL_OFF, lldpReceiveOffDetail } from '../src/protocols/lldp.js';
import { createLogger } from '../src/protocols/logger.js';
import { createNtp } from '../src/protocols/ntp.js';
import { createOspf } from '../src/protocols/ospf.js';
import { createPpp } from '../src/protocols/ppp.js';
import { createRestconf } from '../src/protocols/restconf.js';
import { createSyslogServer } from '../src/protocols/syslog-server.js';
import { createTraffic } from '../src/protocols/traffic.js';
import { createVty } from '../src/protocols/vty.js';
import { createVtyClient } from '../src/protocols/vty-client.js';
import { createStagedSimulation, type StagedFactoryOverlay } from './staged.world.js';

/** The daemons the W4 catalog flip registers (§7 W4 step 2), laid over the registry until it lands. */
const FLIP_FACTORIES: StagedFactoryOverlay = {
  ppp: createPpp, cdp: createCdp, lldp: createLldp, acl: createAcl, gre: createGre, vty: createVty, 'vty-client': createVtyClient,
  logger: createLogger, ntp: createNtp, 'syslog-server': createSyslogServer, ospf: createOspf, eigrp: createEigrp, ike: createIke,
  restconf: createRestconf, traffic: createTraffic,
};

const SEED = 3_007;
const INTERVAL_S = 30;
const TTL_S = 120;

type Created = Extract<TraceEvent, { kind: 'pduCreated' }>;
type Drop = Extract<TraceEvent, { kind: 'drop' }>;

function startup(sections: readonly (readonly string[])[]): string {
  const out: string[] = [];
  for (const s of sections) out.push(...s, '!');
  out.push('end', '');
  return out.join('\n');
}

const rows = (sim: Simulation, dev: DeviceId): LldpNeighbourRow[] => sim.device(dev)!.tables.get<LldpNeighbourRow>('lldp-neighbours')?.rows() ?? [];
const names = (sim: Simulation, dev: DeviceId): string[] => rows(sim, dev).map((r) => r.systemName ?? r.chassisId);
const lldpSent = (evs: readonly TraceEvent[], dev?: DeviceId): Created[] =>
  evs.filter((e): e is Created => e.kind === 'pduCreated' && e.process === 'lldp' && (dev === undefined || e.device === dev));
const lldpDrops = (evs: readonly TraceEvent[], dev: DeviceId): Drop[] => evs.filter((e): e is Drop => e.kind === 'drop' && e.device === dev && e.pdu.proto === 'lldp');
const isLldp = (sim: Simulation, id: number): boolean => sim.pdu(id)?.layer('lldp') !== undefined;
const rxLldp = (sim: Simulation, evs: readonly TraceEvent[], dev: DeviceId): Extract<TraceEvent, { kind: 'frameRx' }>[] =>
  evs.filter((e): e is Extract<TraceEvent, { kind: 'frameRx' }> => e.kind === 'frameRx' && e.device === dev && isLldp(sim, e.pdu.id));

function during(sim: Simulation, ns: number, fn: () => void = () => undefined): TraceEvent[] {
  const cursor = sim.trace(0).next;
  fn();
  sim.runFor(ns);
  return sim.trace(cursor).events;
}

/** Type configuration lines on a console of `dev` (enable, configure terminal … end), each accepted. */
function typeConfig(sim: Simulation, dev: DeviceId, lines: readonly string[]): void {
  const s: SessionId = sim.cli.open(dev, 'console');
  for (const line of ['enable', 'configure terminal', ...lines, 'end']) expect(sim.cli.exec(s, line).error, `${dev}: ${line}`).toBeUndefined();
  sim.cli.close(s);
}

// ── the golden, from IEEE 802.1AB (independent of the codec) ─────────────────────────────────────────────────

const ascii = (text: string): number[] => [...text].map((c) => c.charCodeAt(0));
const mac = (m: string): number[] => m.split(':').map((h) => parseInt(h, 16));
/** A TLV: a 7-bit type and a 9-bit length in two bytes, then the value. */
const tlv = (type: number, value: readonly number[]): number[] => [((type << 1) | (value.length >> 8)) & 0xff, value.length & 0xff, ...value];

/** The reflected IEEE 802.3 CRC-32 (polynomial 0xEDB88320, init and xorout 0xFFFFFFFF), bit by bit. */
function crc32(bytes: readonly number[]): number {
  let c = 0xffffffff;
  for (const b of bytes) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
  }
  return (c ^ 0xffffffff) >>> 0;
}

describe('the IEEE byte golden', () => {
  it("R1's frame on the wire is the 802.1AB image: chassis subtype 4, port subtype 5, TTL 120, …, end TLV, FCS", () => {
    const sim = createStagedSimulation({ seed: SEED, stage: 'P3', factories: FLIP_FACTORIES });
    sim.addDevice({ id: 'r1', type: 'router.nf2911', name: 'R1', startupConfig: startup([['hostname R1'], ['lldp run'], ['interface GigabitEthernet0/0', ' ip address 10.0.12.1 255.255.255.0', ' no shutdown']]) });
    sim.addDevice({ id: 'r2', type: 'router.nf2911', name: 'R2', startupConfig: startup([['hostname R2'], ['lldp run'], ['interface GigabitEthernet0/0', ' ip address 10.0.12.2 255.255.255.0', ' no shutdown']]) });
    sim.addLink({ a: { device: 'r1', port: 'GigabitEthernet0/0' }, b: { device: 'r2', port: 'GigabitEthernet0/0' } });
    const evs = during(sim, 50 * SEC);
    const sent = lldpSent(evs, 'r1');
    expect(sent).toHaveLength(1);
    const frame = sim.pdu(sent[0]!.pdu.id)!;
    const r1 = sim.device('r1')!;
    const portMac = r1.port('GigabitEthernet0/0')!.mac;
    const chassisMac = [...r1.ports.values()][0]!.mac; // the chassis id: the device's first port MAC
    const lldpdu = [
      ...tlv(1, [4, ...mac(chassisMac)]), // chassis ID, subtype 4: MAC address
      ...tlv(2, [5, ...ascii('GigabitEthernet0/0')]), // port ID, subtype 5: interface name
      ...tlv(3, [0x00, TTL_S]), // time to live, 120 s
      ...tlv(5, ascii('R1')), // system name
      ...tlv(6, ascii('NetForge NF-OS, release 3, NF-2911')), // system description (original text)
      ...tlv(7, [0x00, 0x10, 0x00, 0x10]), // system capabilities: router; enabled: router
      ...tlv(8, [5, 1, 10, 0, 12, 1, 1, 0, 0, 0, 0, 0]), // management address: IPv4 10.0.12.1, if subtype unknown, no OID
      0x00, 0x00, // end of LLDPDU
    ];
    // the fixed parts, as literal bytes
    expect(lldpdu.slice(0, 3)).toEqual([0x02, 0x07, 0x04]);
    expect(lldpdu.slice(9, 12)).toEqual([0x04, 0x13, 0x05]);
    expect(lldpdu.slice(30, 34)).toEqual([0x06, 0x02, 0x00, 0x78]);
    expect(lldpdu.slice(-2)).toEqual([0x00, 0x00]);
    const head = [...mac('01:80:c2:00:00:0e'), ...mac(portMac), 0x88, 0xcc];
    const body = [...head, ...lldpdu];
    const padded = body.length >= 60 ? body : [...body, ...new Array<number>(60 - body.length).fill(0)];
    const fcs = crc32(padded);
    const golden = [...padded, fcs & 0xff, (fcs >>> 8) & 0xff, (fcs >>> 16) & 0xff, (fcs >>> 24) & 0xff];
    expect(Array.from(frame.bytes)).toEqual(golden);
    expect(frame.bytes.length).toBe(14 + 96 + 4);
    // the receiver decoded the same fields and wrote its row from them
    expect(rows(sim, 'r2')).toEqual([
      {
        key: `GigabitEthernet0/0|${chassisMac}|GigabitEthernet0/0`, localPort: 'GigabitEthernet0/0', chassisId: chassisMac, portId: 'GigabitEthernet0/0',
        ttlS: TTL_S, systemName: 'R1', systemDescription: 'NetForge NF-OS, release 3, NF-2911', capabilities: 'R', enabled: 'R', mgmtAddress: '10.0.12.1',
        expiresAt: rows(sim, 'r2')[0]!.updatedAt + TTL_S * SEC, updatedAt: rows(sim, 'r2')[0]!.updatedAt,
      },
    ]);
    expect(frame.meta).toMatchObject({ tag: 'lldp', background: true });
  });
});

describe('§3.6 step 7: interval and asymmetry', () => {
  /** R1 Gi0/0 ↔ SW1 Gi0/1; SW1 Gi0/2 ↔ SW2 Gi0/1 (trunk); `lldp run` on all three at boot. */
  function chain(): Simulation {
    const sim = createStagedSimulation({ seed: SEED, stage: 'P3', factories: FLIP_FACTORIES });
    sim.addDevice({ id: 'r1', type: 'router.nf2911', name: 'R1', startupConfig: startup([['hostname R1'], ['lldp run'], ['interface GigabitEthernet0/0', ' ip address 10.0.12.1 255.255.255.0', ' no shutdown']]) });
    sim.addDevice({ id: 'sw1', type: 'switch.nfc2960', name: 'SW1', startupConfig: startup([['hostname SW1'], ['lldp run'], ['interface GigabitEthernet0/2', ' switchport mode trunk']]) });
    sim.addDevice({ id: 'sw2', type: 'switch.nfc2960', name: 'SW2', startupConfig: startup([['hostname SW2'], ['lldp run'], ['interface GigabitEthernet0/1', ' switchport mode trunk']]) });
    sim.addLink({ a: { device: 'r1', port: 'GigabitEthernet0/0' }, b: { device: 'sw1', port: 'GigabitEthernet0/1' } });
    sim.addLink({ a: { device: 'sw1', port: 'GigabitEthernet0/2' }, b: { device: 'sw2', port: 'GigabitEthernet0/1' } });
    return sim;
  }

  it('a frame at link-up, then every 30 s on every up port, TTL 120 each time', () => {
    const sim = chain();
    const evs = during(sim, 50 * SEC + 3 * INTERVAL_S * SEC);
    const r1 = lldpSent(evs, 'r1');
    expect(r1.length).toBe(4);
    expect(r1[0]!.t).toBe(45 * SEC);
    for (let i = 1; i < r1.length; i++) expect(r1[i]!.t - r1[i - 1]!.t).toBe(INTERVAL_S * SEC);
    expect(r1.every((e) => sim.pdu(e.pdu.id)!.get('lldp.ttl') === TTL_S)).toBe(true);
    // SW1 sends on both up ports at each tick, in canonical port order
    const sw1 = lldpSent(evs, 'sw1').filter((e) => e.t > 50 * SEC);
    expect(sw1.length % 2).toBe(0);
    expect(sw1.slice(0, 2).map((e) => sim.pdu(e.pdu.id)!.get('lldp.portId'))).toEqual(['GigabitEthernet0/1', 'GigabitEthernet0/2']);
    expect(new Set(sw1.map((e) => e.t)).size).toBe(sw1.length / 2);
    expect(names(sim, 'sw1').sort()).toEqual(['R1', 'SW2']);
    expect(rows(sim, 'r1').map((r) => [r.localPort, r.systemName, r.portId, r.capabilities])).toEqual([['GigabitEthernet0/0', 'SW1', 'GigabitEthernet0/1', 'B']]);
    expect(sim.runToIdle(5_000).events).toBeLessThan(5_000);
  });

  it('no lldp transmit and no lldp receive are per port and asymmetric', () => {
    const sim = chain();
    sim.runFor(50 * SEC);
    typeConfig(sim, 'sw1', ['interface GigabitEthernet0/1', 'no lldp transmit']);
    typeConfig(sim, 'sw2', ['interface GigabitEthernet0/1', 'no lldp receive']);
    expect(sim.device('sw1')!.running.render()).toContain('interface GigabitEthernet0/1\n no lldp transmit\n');
    expect(sim.device('sw2')!.running.render()).toMatch(/\ninterface GigabitEthernet0\/1\n(?: [^\n]*\n)* no lldp receive\n/);
    const evs = during(sim, TTL_S * SEC + 10 * SEC);
    // SW1 stopped sending toward R1, but still sends toward SW2; R1's row of SW1 aged out, SW1 still hears R1
    const sw1Ports = lldpSent(evs, 'sw1').map((e) => sim.pdu(e.pdu.id)!.get('lldp.portId'));
    expect(sw1Ports.length).toBeGreaterThan(0);
    expect(sw1Ports.every((p) => p === 'GigabitEthernet0/2')).toBe(true);
    expect(rows(sim, 'r1')).toEqual([]);
    expect(evs.some((e) => e.kind === 'tableExpire' && e.device === 'r1' && e.table === 'lldp-neighbours' && e.reason === 'aged')).toBe(true);
    expect(names(sim, 'sw1')).toContain('R1');
    // SW2 refuses what arrives on Gi0/1 (its row of SW1 aged out), while SW1 still learns SW2
    const refused = lldpDrops(evs, 'sw2');
    expect(refused.length).toBeGreaterThan(0);
    expect(refused.every((d) => d.reason === 'not-for-me' && d.detail === lldpReceiveOffDetail('GigabitEthernet0/1'))).toBe(true);
    expect(rows(sim, 'sw2')).toEqual([]);
    expect(names(sim, 'sw1')).toContain('SW2');
    expect(lldpSent(evs, 'sw2').length).toBeGreaterThan(0);
  });
});

describe('who bridges LLDP (D18)', () => {
  it('never a VLAN-aware switch: with LLDP off it consumes the frames as off; with it on it learns and forwards nothing', () => {
    const sim = createStagedSimulation({ seed: SEED, stage: 'P3', factories: FLIP_FACTORIES });
    sim.addDevice({ id: 'r1', type: 'router.nf2911', name: 'R1', startupConfig: startup([['hostname R1'], ['lldp run'], ['interface GigabitEthernet0/0', ' ip address 10.0.12.1 255.255.255.0', ' no shutdown']]) });
    sim.addDevice({ id: 'sw1', type: 'switch.nfc2960', name: 'SW1', startupConfig: startup([['hostname SW1']]) });
    sim.addDevice({ id: 'sw2', type: 'switch.nfc2960', name: 'SW2', startupConfig: startup([['hostname SW2'], ['lldp run']]) });
    sim.addDevice({ id: 'pc1', type: 'pc.nfpc', name: 'PC1' });
    sim.addLink({ a: { device: 'r1', port: 'GigabitEthernet0/0' }, b: { device: 'sw1', port: 'GigabitEthernet0/1' } });
    sim.addLink({ a: { device: 'sw1', port: 'GigabitEthernet0/2' }, b: { device: 'sw2', port: 'GigabitEthernet0/1' } });
    sim.addLink({ a: { device: 'pc1', port: 'GigabitEthernet0' }, b: { device: 'sw1', port: 'FastEthernet0/1' } });
    const off = during(sim, 120 * SEC);
    const fromR1 = new Set(lldpSent(off, 'r1').map((e) => e.pdu.id));
    expect(fromR1.size).toBeGreaterThanOrEqual(3);
    const consumed = lldpDrops(off, 'sw1').filter((d) => fromR1.has(d.pdu.id));
    expect(consumed.length).toBe(fromR1.size);
    expect(consumed.every((d) => d.reason === 'not-for-me' && d.detail === LLDP_DETAIL_OFF)).toBe(true);
    for (const dev of ['sw2', 'pc1'] as const) expect(rxLldp(sim, off, dev).filter((e) => fromR1.has(e.pdu.id)), dev).toEqual([]);
    expect(names(sim, 'sw2')).toEqual([]);
    // LLDP turned on in SW1: it learns R1 and SW2, and still bridges none of their frames
    typeConfig(sim, 'sw1', ['lldp run']);
    const on = during(sim, 120 * SEC);
    expect(names(sim, 'sw1').sort()).toEqual(['R1', 'SW2']);
    const r1Frames = new Set(lldpSent(on, 'r1').map((e) => e.pdu.id));
    const sw2Frames = new Set(lldpSent(on, 'sw2').map((e) => e.pdu.id));
    expect(rxLldp(sim, on, 'sw2').some((e) => r1Frames.has(e.pdu.id))).toBe(false);
    expect(rxLldp(sim, on, 'r1').some((e) => sw2Frames.has(e.pdu.id))).toBe(false);
    expect(rxLldp(sim, on, 'pc1').some((e) => r1Frames.has(e.pdu.id) || sw2Frames.has(e.pdu.id))).toBe(false);
    expect(names(sim, 'sw2')).toEqual(['SW1']);
    expect(names(sim, 'r1')).toEqual(['SW1']);
  });

  it('dropped with "lldp is not running on this device" at the controller', () => {
    const sim = createStagedSimulation({ seed: SEED, stage: 'P3', factories: FLIP_FACTORIES });
    sim.addDevice({ id: 'sw1', type: 'switch.nfc2960', name: 'SW1', startupConfig: startup([['hostname SW1'], ['lldp run'], ['interface GigabitEthernet0/1', ' switchport mode trunk']]) });
    sim.addDevice({ id: 'wlc1', type: 'wlc.nfwlc9800', name: 'WLC1' });
    sim.addLink({ a: { device: 'sw1', port: 'GigabitEthernet0/1' }, b: { device: 'wlc1', port: 'GigabitEthernet0/1' } });
    const evs = during(sim, 100 * SEC);
    const wlc = sim.device('wlc1')!;
    expect(wlc.model.processes).toContain('cdp');
    expect(wlc.model.processes).not.toContain('lldp');
    const fromSw1 = lldpSent(evs, 'sw1').filter((e) => sim.pdu(e.pdu.id)!.get('lldp.portId') === 'GigabitEthernet0/1');
    expect(fromSw1.length).toBeGreaterThanOrEqual(2);
    const dropped = lldpDrops(evs, 'wlc1');
    expect(dropped.map((d) => d.pdu.id)).toEqual(fromSw1.map((e) => e.pdu.id));
    expect(dropped.every((d) => d.reason === 'not-for-me' && d.detail === 'lldp is not running on this device' && d.port === 'GigabitEthernet0/1')).toBe(true);
    expect(wlc.tables.get('lldp-neighbours')).toBeUndefined();
    // the controller sends no LLDP; its CDP (on by default in P3) is heard by the switch
    expect(lldpSent(evs, 'wlc1')).toEqual([]);
    expect(names(sim, 'sw1')).toEqual([]);
  });

  it('bridged by a transparent one: two routers learn each other through a learning bridge', () => {
    const sim = createStagedSimulation({ seed: SEED, stage: 'P3', factories: FLIP_FACTORIES });
    sim.addDevice({ id: 'r1', type: 'router.nf2911', name: 'R1', startupConfig: startup([['hostname R1'], ['lldp run'], ['interface GigabitEthernet0/0', ' ip address 10.0.12.1 255.255.255.0', ' no shutdown']]) });
    sim.addDevice({ id: 'br1', type: 'bridge.nfbr4', name: 'BR1' });
    sim.addDevice({ id: 'r2', type: 'router.nf2911', name: 'R2', startupConfig: startup([['hostname R2'], ['lldp run'], ['interface GigabitEthernet0/0', ' ip address 10.0.12.2 255.255.255.0', ' no shutdown']]) });
    sim.addLink({ a: { device: 'r1', port: 'GigabitEthernet0/0' }, b: { device: 'br1', port: 'Ethernet0' } });
    sim.addLink({ a: { device: 'br1', port: 'Ethernet1' }, b: { device: 'r2', port: 'GigabitEthernet0/0' } });
    const evs = during(sim, 100 * SEC);
    expect(rows(sim, 'r1').map((r) => [r.localPort, r.systemName, r.portId, r.mgmtAddress])).toEqual([['GigabitEthernet0/0', 'R2', 'GigabitEthernet0/0', '10.0.12.2']]);
    expect(rows(sim, 'r2').map((r) => [r.localPort, r.systemName, r.portId, r.mgmtAddress])).toEqual([['GigabitEthernet0/0', 'R1', 'GigabitEthernet0/0', '10.0.12.1']]);
    // the very frames crossed the bridge: received on one bridge port, sent out of the other, unchanged in identity
    for (const e of lldpSent(evs, 'r1')) {
      expect(evs.some((x) => x.kind === 'frameTx' && x.pdu.id === e.pdu.id && x.from.device === 'br1' && x.to.device === 'r2')).toBe(true);
    }
    expect(lldpDrops(evs, 'br1')).toEqual([]);
    expect(sim.device('br1')!.tables.get('lldp-neighbours')).toBeUndefined();
  });
});

describe('determinism', () => {
  it('three runs with one seed give byte-identical trace and snapshot JSON', () => {
    const run = (): string => {
      const sim = createStagedSimulation({ seed: SEED, stage: 'P3', factories: FLIP_FACTORIES });
      sim.addDevice({ id: 'r1', type: 'router.nf2911', name: 'R1', startupConfig: startup([['hostname R1'], ['lldp run'], ['interface GigabitEthernet0/0', ' no shutdown']]) });
      sim.addDevice({ id: 'sw1', type: 'switch.nfc2960', name: 'SW1', startupConfig: startup([['hostname SW1'], ['lldp run']]) });
      sim.addLink({ a: { device: 'r1', port: 'GigabitEthernet0/0' }, b: { device: 'sw1', port: 'GigabitEthernet0/1' } });
      sim.runFor(100 * SEC);
      typeConfig(sim, 'sw1', ['interface GigabitEthernet0/1', 'no lldp receive']);
      sim.runFor(150 * SEC);
      return JSON.stringify({ trace: sim.trace(0).events, snapshot: sim.snapshot() });
    };
    const a = run();
    expect(run()).toBe(a);
    expect(run()).toBe(a);
  });
});
