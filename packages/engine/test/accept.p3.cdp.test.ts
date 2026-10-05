/**
 * P3 acceptance — CDP discovers neighbours (ARCHITECTURE-P3 §10.1 row `accept.p3.cdp`; §3.6 steps 1–6; D2, D18; §4.2,
 * §4.3; §5.5, §5.8; §7 W4 qa).
 *
 * The row, clause by clause, on `staged.world` at stage P3 (rule 13, rule 14: the qa step runs before the catalog flip,
 * so the daemons the W4 flip registers are laid over the registry here — `FLIP_FACTORIES`; after the flip the overlay
 * names the registry's own factories and changes nothing). Configuration a learner types goes through the real CLI
 * (consoles on the devices); the boot configuration through `startupConfig`.
 *
 *   §3.6 world: R1 (NF-2911) Gi0/0 10.0.12.1/24 ↔ SW1 (NF-C2960) Gi0/1; SW1 Gi0/2 ↔ SW2 Gi0/1, a trunk; PC1 on SW1
 *   Fa0/1; SW1 Vlan1 10.0.12.2/24.
 *
 *   • both rows within link-up + propagation, with exact fields: the frame each end sends AT the link-up instant (not
 *     on the 60 s timer) writes the other end's row at its arrival; the router's row is received on its routed port,
 *     and also when that port carries a native subinterface (the control check before step 10a);
 *   • the hold time counts down (`show cdp neighbors`: `ceil((expiresAt − now) / 1 s)`);
 *   • behind an unmanaged switch (NF-BRIDGE-4, a transparent learning bridge: the link stays up) a silent neighbour's
 *     row expires at last update + 180 s ± 1 ms (reason `aged`);
 *   • link-down deletes the row (reason `link-down`): R1 powered off, and a removed cable;
 *   • `no cdp enable` stops sending on that port (edge hardening) and refuses what arrives there; `no cdp run` stops
 *     everything, clears the table, is stored explicitly in a P3 world, and consumes frames silently as off; `cdp run`
 *     speaks again at once;
 *   • NF-AP-1832 bridges CDP (a switch's frame reaches a wireless station through it) and has no row (no table, no
 *     frame of its own);
 *   • `runToIdle` returns in fewer than 5 000 events; three runs with one seed give byte-identical trace and snapshot.
 */
import { describe, expect, it } from 'vitest';
import type { DeviceId, SessionId } from '../src/contracts/ids.js';
import type { Simulation } from '../src/contracts/simulation.js';
import type { CdpNeighbourRow } from '../src/contracts/tables.js';
import { MS, SEC } from '../src/contracts/time.js';
import type { TraceEvent } from '../src/contracts/trace.js';
import { CDP_CAPABILITY_LEGEND, MSG_CDP_OFF } from '../src/cli/handlers/discovery.js';
import { CDP_DETAIL_OFF, cdpPortOffDetail, createCdp, discoverySoftwareText } from '../src/protocols/cdp.js';
import { createAcl } from '../src/protocols/acl.js';
import { createEigrp } from '../src/protocols/eigrp.js';
import { createGre } from '../src/protocols/gre.js';
import { createIke } from '../src/protocols/ike.js';
import { createLldp } from '../src/protocols/lldp.js';
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

const SEED = 3_006;
const HOLD_S = 180;
const R1_ROUTED = 'GigabitEthernet0/0';
const SW1_TO_R1 = 'GigabitEthernet0/1';
const SW1_TO_SW2 = 'GigabitEthernet0/2';
const SW1_TO_PC1 = 'FastEthernet0/1';

type Created = Extract<TraceEvent, { kind: 'pduCreated' }>;
type Tx = Extract<TraceEvent, { kind: 'frameTx' }>;
type Drop = Extract<TraceEvent, { kind: 'drop' }>;
type Write = Extract<TraceEvent, { kind: 'tableWrite' }>;
type Expire = Extract<TraceEvent, { kind: 'tableExpire' }>;

function startup(sections: readonly (readonly string[])[]): string {
  const out: string[] = [];
  for (const s of sections) out.push(...s, '!');
  out.push('end', '');
  return out.join('\n');
}

interface World {
  readonly sim: Simulation;
  readonly r1sw1: string;
}

/** The §3.6 world. `nativeSub`: R1's address lives on Gi0/0.1, the native-VLAN subinterface, and SW1 Gi0/1 is a trunk. */
function world(opts: { seed?: number; nativeSub?: boolean } = {}): World {
  const sim = createStagedSimulation({ seed: opts.seed ?? SEED, stage: 'P3', factories: FLIP_FACTORIES });
  const r1Port = opts.nativeSub === true
    ? [[`interface ${R1_ROUTED}`, ' no shutdown'], [`interface ${R1_ROUTED}.1`, ' encapsulation dot1Q 1 native', ' ip address 10.0.12.1 255.255.255.0']]
    : [[`interface ${R1_ROUTED}`, ' ip address 10.0.12.1 255.255.255.0', ' no shutdown']];
  sim.addDevice({ id: 'r1', type: 'router.nf2911', name: 'R1', startupConfig: startup([['hostname R1'], ...r1Port]) });
  sim.addDevice({
    id: 'sw1', type: 'switch.nfc2960', name: 'SW1',
    startupConfig: startup([
      ['hostname SW1'],
      ...(opts.nativeSub === true ? [[`interface ${SW1_TO_R1}`, ' switchport mode trunk']] : []),
      [`interface ${SW1_TO_SW2}`, ' switchport mode trunk'],
      ['interface Vlan1', ' ip address 10.0.12.2 255.255.255.0', ' no shutdown'],
    ]),
  });
  sim.addDevice({ id: 'sw2', type: 'switch.nfc2960', name: 'SW2', startupConfig: startup([['hostname SW2'], ['interface GigabitEthernet0/1', ' switchport mode trunk']]) });
  sim.addDevice({ id: 'pc1', type: 'pc.nfpc', name: 'PC1', startupConfig: startup([['hostname PC1'], ['interface GigabitEthernet0', ' ip address 10.0.12.10 255.255.255.0']]) });
  const r1sw1 = sim.addLink({ a: { device: 'r1', port: R1_ROUTED }, b: { device: 'sw1', port: SW1_TO_R1 } });
  sim.addLink({ a: { device: 'sw1', port: SW1_TO_SW2 }, b: { device: 'sw2', port: 'GigabitEthernet0/1' } });
  sim.addLink({ a: { device: 'pc1', port: 'GigabitEthernet0' }, b: { device: 'sw1', port: SW1_TO_PC1 } });
  return { sim, r1sw1 };
}

const rows = (sim: Simulation, dev: DeviceId): CdpNeighbourRow[] => sim.device(dev)!.tables.get<CdpNeighbourRow>('cdp-neighbours')?.rows() ?? [];
const rowOf = (sim: Simulation, dev: DeviceId, neighbour: string): CdpNeighbourRow | undefined => rows(sim, dev).find((r) => r.deviceId === neighbour);
const isCdp = (sim: Simulation, id: number): boolean => sim.pdu(id)?.layer('cdp') !== undefined;
const cdpSent = (sim: Simulation, evs: readonly TraceEvent[], dev?: DeviceId): Created[] =>
  evs.filter((e): e is Created => e.kind === 'pduCreated' && e.process === 'cdp' && (dev === undefined || e.device === dev));
const cdpDrops = (evs: readonly TraceEvent[], dev: DeviceId): Drop[] => evs.filter((e): e is Drop => e.kind === 'drop' && e.device === dev && e.pdu.proto === 'cdp');
const cdpField = (sim: Simulation, id: number, f: string): unknown => sim.pdu(id)!.get(`cdp.${f}`);

/** Trace events of `fn` and the `ns` run after it. */
function during(sim: Simulation, ns: number, fn: () => void = () => undefined): TraceEvent[] {
  const cursor = sim.trace(0).next;
  fn();
  sim.runFor(ns);
  return sim.trace(cursor).events;
}

/** A privileged console on `dev`. */
function consoleOn(sim: Simulation, dev: DeviceId): SessionId {
  const s = sim.cli.open(dev, 'console');
  expect(sim.cli.exec(s, 'enable').error).toBeUndefined();
  return s;
}

/** Type configuration lines on a console of `dev` (configure terminal … end), each accepted. */
function typeConfig(sim: Simulation, dev: DeviceId, lines: readonly string[]): void {
  const s = consoleOn(sim, dev);
  for (const line of ['configure terminal', ...lines, 'end']) expect(sim.cli.exec(s, line).error, `${dev}: ${line}`).toBeUndefined();
  sim.cli.close(s);
}

/** One `show` on a fresh privileged console of `dev`. */
function show(sim: Simulation, dev: DeviceId, line: string): string {
  const s = consoleOn(sim, dev);
  const out = sim.cli.exec(s, line);
  expect(out.error, line).toBeUndefined();
  sim.cli.close(s);
  return out.output ?? '';
}

/** The `show cdp neighbors` data rows of `dev`, split into columns (Device ID, local port, hold, capability…, platform, port). */
function neighborLines(sim: Simulation, dev: DeviceId): { device: string; local: string; hold: number }[] {
  const out = show(sim, dev, 'show cdp neighbors').split('\n');
  expect(out[0]).toBe(CDP_CAPABILITY_LEGEND);
  const header = out.findIndex((l) => l.startsWith('Device ID'));
  expect(header).toBeGreaterThan(0);
  const body = out.slice(header + 1, out.indexOf('', header));
  return body.map((l) => {
    const cols = l.split(/\s{2,}/);
    return { device: cols[0]!, local: cols[1]!, hold: Number(cols[2]) };
  });
}

describe('§3.6 steps 1–4: both rows at link-up, with exact fields', () => {
  it('each end speaks at the link-up instant; the other end writes its row at the arrival of that frame', () => {
    const { sim, r1sw1 } = world();
    const evs = during(sim, 50 * SEC);
    // step 1: silent while every port is down (switches boot at 30 s, routers at 45 s)
    expect(cdpSent(sim, evs).every((e) => e.t >= 30 * SEC)).toBe(true);
    expect(evs.some((e) => e.kind === 'tableWrite' && e.table === 'cdp-neighbours' && e.t < 30 * SEC)).toBe(false);
    // the R1–SW1 cable comes up when R1 has booted
    const up = evs.find((e): e is Extract<TraceEvent, { kind: 'linkState' }> => e.kind === 'linkState' && e.link === r1sw1 && e.up);
    expect(up).toBeDefined();
    const U = up!.t;
    for (const [from, to, port, toPort, key] of [['r1', 'sw1', R1_ROUTED, SW1_TO_R1, `${SW1_TO_R1}|R1`], ['sw1', 'r1', SW1_TO_R1, R1_ROUTED, `${R1_ROUTED}|SW1`]] as const) {
      // the first frame out of that port is built at U (a BPDU sent at the same instant may go first on the wire),
      // untagged, background, tag cdp
      const first = cdpSent(sim, evs, from).find((e) => cdpField(sim, e.pdu.id, 'portId') === port)!;
      expect(first.t, `${from} speaks at link-up`).toBe(U);
      const tx = evs.find((e): e is Tx => e.kind === 'frameTx' && e.pdu.id === first.pdu.id && e.from.device === from)!;
      expect([tx.to.device, tx.to.port]).toEqual([to, toPort]);
      expect(tx.txStart).toBeGreaterThanOrEqual(U);
      expect(tx.txStart - U).toBeLessThan(MS);
      expect(first.pdu.vlan).toBeUndefined();
      expect(sim.pdu(first.pdu.id)!.meta).toMatchObject({ tag: 'cdp', background: true });
      // the receiver's row is written at the arrival, link-up + serialisation + propagation (not on any timer)
      const write = evs.find((e): e is Write => e.kind === 'tableWrite' && e.device === to && e.table === 'cdp-neighbours' && e.key === key)!;
      expect(write.t, `${to} writes at the arrival`).toBe(tx.arrive);
      expect(tx.arrive - U).toBeLessThan(MS);
      expect(evs.some((e) => e.kind === 'pduConsumed' && e.device === to && e.process === 'cdp' && e.pdu.id === first.pdu.id && e.t === tx.arrive)).toBe(true);
    }
    // §3.6 step 4: the exact rows
    const atSw1 = rowOf(sim, 'sw1', 'R1')!;
    expect(atSw1).toEqual({
      key: `${SW1_TO_R1}|R1`, localPort: SW1_TO_R1, deviceId: 'R1', remotePort: R1_ROUTED, platform: 'NF-2911', capabilities: 'R',
      addresses: '10.0.12.1', version: discoverySoftwareText({ model: 'NF-2911' }), holdtimeS: HOLD_S, cdpVersion: 2, duplex: 'full',
      expiresAt: atSw1.updatedAt + HOLD_S * SEC, updatedAt: atSw1.updatedAt,
    });
    expect(atSw1.version).toBe('NetForge NF-OS, release 3, NF-2911');
    // SW1's first frame left before its Vlan1 came up: no management address yet; native VLAN only on trunks
    const atR1 = rowOf(sim, 'r1', 'SW1')!;
    expect(atR1).toEqual({
      key: `${R1_ROUTED}|SW1`, localPort: R1_ROUTED, deviceId: 'SW1', remotePort: SW1_TO_R1, platform: 'NF-C2960', capabilities: 'S I',
      addresses: '', version: discoverySoftwareText({ model: 'NF-C2960' }), holdtimeS: HOLD_S, cdpVersion: 2, duplex: 'full',
      expiresAt: atR1.updatedAt + HOLD_S * SEC, updatedAt: atR1.updatedAt,
    });
    // the trunk carries SW1's native VLAN in both directions
    expect(rowOf(sim, 'sw1', 'SW2')).toMatchObject({ localPort: SW1_TO_SW2, remotePort: 'GigabitEthernet0/1', capabilities: 'S I', nativeVlan: 1 });
    expect(rowOf(sim, 'sw2', 'SW1')).toMatchObject({ localPort: 'GigabitEthernet0/1', remotePort: SW1_TO_SW2, nativeVlan: 1 });
    // PC1 runs no cdp: SW1's frames drop there not-for-me, in the background
    const atPc = cdpDrops(evs, 'pc1');
    expect(atPc.length).toBeGreaterThan(0);
    expect(atPc.every((d) => d.reason === 'not-for-me' && d.background === true)).toBe(true);
    expect([...cdpDrops(evs, 'r1'), ...cdpDrops(evs, 'sw1'), ...cdpDrops(evs, 'sw2')]).toEqual([]);
    // the next periodic frame (60 s) carries SW1's management address once Vlan1 is up
    sim.runFor(70 * SEC);
    expect(rowOf(sim, 'r1', 'SW1')!.addresses).toBe('10.0.12.2');
  });

  it('the router receives on its routed port, also when the port carries a native subinterface', () => {
    const { sim } = world({ nativeSub: true });
    const evs = during(sim, 50 * SEC);
    const atR1 = rowOf(sim, 'r1', 'SW1')!;
    expect(atR1).toMatchObject({ key: `${R1_ROUTED}|SW1`, localPort: R1_ROUTED, remotePort: SW1_TO_R1, capabilities: 'S I', nativeVlan: 1 });
    // delivered to cdp on the physical port: never the subinterface path, never a drop
    const consumed = evs.filter((e) => e.kind === 'pduConsumed' && e.device === 'r1' && e.process === 'cdp');
    expect(consumed.length).toBeGreaterThan(0);
    const rx = evs.filter((e): e is Extract<TraceEvent, { kind: 'frameRx' }> => e.kind === 'frameRx' && e.device === 'r1' && isCdp(sim, e.pdu.id));
    expect(rx.every((e) => e.port === R1_ROUTED)).toBe(true);
    expect(cdpDrops(evs, 'r1')).toEqual([]);
    // R1 itself still speaks untagged out of the physical port, and SW1 hears it on its trunk port
    expect(rowOf(sim, 'sw1', 'R1')).toMatchObject({ localPort: SW1_TO_R1, remotePort: R1_ROUTED, capabilities: 'R' });
    expect(cdpSent(sim, evs, 'r1').every((e) => e.pdu.vlan === undefined)).toBe(true);
  });
});

describe('§3.6 step 5: the hold time counts down', () => {
  it('show cdp neighbors prints ceil((expiresAt − now) / 1 s), which falls with time and is restored by the next frame', () => {
    const { sim } = world();
    sim.runUntil(45 * SEC + 100 * MS); // R1 boots at 45 s: its link-up frame has just been received
    const row = rowOf(sim, 'sw1', 'R1')!;
    expect(row.updatedAt).toBeLessThan(sim.now);
    const holdAt = (now: number): number => Math.ceil((row.expiresAt! - now) / SEC);
    sim.runUntil(row.updatedAt + SEC / 2);
    const a = neighborLines(sim, 'sw1');
    expect(a.find((l) => l.device === 'R1')).toEqual({ device: 'R1', local: 'Gi0/1', hold: holdAt(sim.now) });
    expect(holdAt(sim.now)).toBe(HOLD_S);
    sim.runFor(10 * SEC);
    const b = neighborLines(sim, 'sw1');
    expect(b.find((l) => l.device === 'R1')!.hold).toBe(holdAt(sim.now));
    expect(holdAt(sim.now)).toBe(HOLD_S - 10);
    sim.runFor(30 * SEC);
    expect(neighborLines(sim, 'sw1').find((l) => l.device === 'R1')!.hold).toBe(HOLD_S - 40);
    // rows ordered by local port: Gi0/1 (R1) before Gi0/2 (SW2)
    expect(b.map((l) => l.local)).toEqual(['Gi0/1', 'Gi0/2']);
    // R1's next periodic frame (60 s after its first) restores the full hold time
    sim.runUntil(row.updatedAt + 60 * SEC + SEC / 2);
    const refreshed = rowOf(sim, 'sw1', 'R1')!;
    expect(refreshed.updatedAt).toBe(row.updatedAt + 60 * SEC);
    expect(neighborLines(sim, 'sw1').find((l) => l.device === 'R1')!.hold).toBe(HOLD_S);
  });
});

describe('§3.6 step 6: ageing and link-down', () => {
  it('behind an unmanaged switch the row of a silent neighbour expires at last update + 180 s ± 1 ms (aged)', () => {
    const sim = createStagedSimulation({ seed: SEED, stage: 'P3', factories: FLIP_FACTORIES });
    sim.addDevice({ id: 'r1', type: 'router.nf2911', name: 'R1', startupConfig: startup([['hostname R1'], [`interface ${R1_ROUTED}`, ' ip address 10.0.12.1 255.255.255.0', ' no shutdown']]) });
    sim.addDevice({ id: 'br1', type: 'bridge.nfbr4', name: 'BR1' });
    sim.addDevice({ id: 'sw1', type: 'switch.nfc2960', name: 'SW1', startupConfig: startup([['hostname SW1']]) });
    sim.addLink({ a: { device: 'r1', port: R1_ROUTED }, b: { device: 'br1', port: 'Ethernet0' } });
    sim.addLink({ a: { device: 'br1', port: 'Ethernet1' }, b: { device: 'sw1', port: SW1_TO_R1 } });
    sim.runFor(100 * SEC);
    // the bridge forwarded both ways: each side has the other, received on the port toward the bridge
    expect(rowOf(sim, 'sw1', 'R1')).toMatchObject({ localPort: SW1_TO_R1, remotePort: R1_ROUTED });
    expect(rowOf(sim, 'r1', 'SW1')).toMatchObject({ localPort: R1_ROUTED, remotePort: SW1_TO_R1 });
    expect(sim.device('br1')!.tables.get('cdp-neighbours')).toBeUndefined();
    sim.setPower('r1', false);
    const last = rowOf(sim, 'sw1', 'R1')!.updatedAt;
    const evs = during(sim, 200 * SEC);
    // SW1's port stays up (the bridge holds the link): the row goes only when its hold time runs out
    expect(evs.some((e) => e.kind === 'portState' && e.device === 'sw1')).toBe(false);
    const aged = evs.filter((e): e is Expire => e.kind === 'tableExpire' && e.device === 'sw1' && e.table === 'cdp-neighbours');
    expect(aged.map((e) => [e.key, e.reason])).toEqual([[`${SW1_TO_R1}|R1`, 'aged']]);
    expect(aged[0]!.t - last).toBeGreaterThanOrEqual(HOLD_S * SEC - MS);
    expect(aged[0]!.t - last).toBeLessThanOrEqual(HOLD_S * SEC + MS);
    expect(rows(sim, 'sw1')).toEqual([]);
  });

  it('link-down deletes the row at once on both ends: R1 powered off, then a removed cable', () => {
    const w = world();
    w.sim.runFor(50 * SEC);
    const off = during(w.sim, SEC, () => w.sim.setPower('r1', false));
    const t = off.find((e) => e.kind === 'deviceState' && e.device === 'r1')!.t;
    const gone = off.filter((e): e is Expire => e.kind === 'tableExpire' && e.table === 'cdp-neighbours' && e.device === 'sw1');
    expect(gone.map((e) => [e.key, e.reason, e.t])).toEqual([[`${SW1_TO_R1}|R1`, 'link-down', t]]);
    expect(rowOf(w.sim, 'sw1', 'R1')).toBeUndefined();
    expect(rowOf(w.sim, 'sw1', 'SW2')).toBeDefined();

    const v = world();
    v.sim.runFor(50 * SEC);
    const cut = during(v.sim, SEC, () => v.sim.removeLink(v.r1sw1));
    const expired = cut.filter((e): e is Expire => e.kind === 'tableExpire' && e.table === 'cdp-neighbours');
    expect(expired.map((e) => [e.device, e.key, e.reason]).sort()).toEqual([
      ['r1', `${R1_ROUTED}|SW1`, 'link-down'],
      ['sw1', `${SW1_TO_R1}|R1`, 'link-down'],
    ]);
    expect(new Set(expired.map((e) => e.t)).size).toBe(1);
    expect(rows(v.sim, 'r1')).toEqual([]);
  });
});

describe('§3.6 step 6: no cdp enable and no cdp run, typed', () => {
  it('no cdp enable on SW1 Fa0/1 stops sending to PC1; on Gi0/2 it also refuses what SW2 sends there', () => {
    const { sim } = world();
    sim.runFor(50 * SEC);
    typeConfig(sim, 'sw1', [`interface ${SW1_TO_PC1}`, 'no cdp enable', `interface ${SW1_TO_SW2}`, 'no cdp enable']);
    expect(sim.device('sw1')!.running.render()).toContain(`interface ${SW1_TO_PC1}\n no cdp enable\n`);
    const evs = during(sim, 130 * SEC);
    const ports = cdpSent(sim, evs, 'sw1').map((e) => cdpField(sim, e.pdu.id, 'portId'));
    expect(ports.length).toBeGreaterThan(0);
    expect(ports.every((p) => p === SW1_TO_R1)).toBe(true);
    expect(cdpDrops(evs, 'pc1')).toEqual([]);
    expect(evs.some((e) => e.kind === 'frameRx' && e.device === 'pc1' && isCdp(sim, e.pdu.id))).toBe(false);
    const refused = cdpDrops(evs, 'sw1');
    expect(refused.length).toBeGreaterThan(0);
    expect(refused.every((d) => d.reason === 'not-for-me' && d.port === SW1_TO_SW2 && d.detail === cdpPortOffDetail(SW1_TO_SW2))).toBe(true);
    // R1 is still heard on Gi0/1, and still hears SW1
    expect(rowOf(sim, 'sw1', 'R1')!.updatedAt).toBeGreaterThan(100 * SEC);
    expect(rowOf(sim, 'r1', 'SW1')!.updatedAt).toBeGreaterThan(100 * SEC);
    expect(show(sim, 'sw1', `show cdp interface ${SW1_TO_PC1}`)).toContain('CDP: off on this interface (no cdp enable)');
  });

  it('no cdp run stops everything, clears the table, is stored explicitly, and frames are consumed as off; cdp run speaks at once', () => {
    const { sim } = world();
    sim.runFor(50 * SEC);
    expect(rows(sim, 'sw1')).toHaveLength(2);
    // a default P3 world shows no CDP line (D2)
    expect(sim.device('sw1')!.running.render()).not.toMatch(/cdp/);
    const evs = during(sim, 130 * SEC, () => typeConfig(sim, 'sw1', ['no cdp run']));
    expect(sim.device('sw1')!.running.render()).toContain('\nno cdp run\n');
    expect(rows(sim, 'sw1')).toEqual([]);
    const cleared = evs.filter((e): e is Expire => e.kind === 'tableExpire' && e.device === 'sw1' && e.table === 'cdp-neighbours');
    expect(cleared.map((e) => e.reason)).toEqual(['cleared', 'cleared']);
    expect(cdpSent(sim, evs, 'sw1')).toEqual([]);
    const off = cdpDrops(evs, 'sw1');
    expect(off.length).toBeGreaterThan(0);
    expect(off.every((d) => d.reason === 'not-for-me' && d.detail === CDP_DETAIL_OFF)).toBe(true);
    expect(show(sim, 'sw1', 'show cdp neighbors')).toBe(MSG_CDP_OFF);
    // the neighbours age SW1 out: no frame refreshes them
    expect(rowOf(sim, 'r1', 'SW1')!.updatedAt).toBeLessThan(evs[0]!.t);
    // turned on again: one frame at once on every up port, in canonical port order
    const again = during(sim, SEC, () => typeConfig(sim, 'sw1', ['cdp run']));
    const sent = cdpSent(sim, again, 'sw1');
    expect(sent.map((e) => cdpField(sim, e.pdu.id, 'portId'))).toEqual([SW1_TO_PC1, SW1_TO_R1, SW1_TO_SW2]);
    expect(new Set(sent.map((e) => e.t)).size).toBe(1);
    // both forms are stored as typed (a bothForms slot, D2): `cdp run` replaces `no cdp run`
    expect(sim.device('sw1')!.running.render()).toContain('\ncdp run\n');
    expect(sim.device('sw1')!.running.render()).not.toContain('no cdp run');
  });
});

describe('NF-AP-1832 bridges CDP and has no row (D2)', () => {
  it("a switch's frame reaches a wireless station through the AP; the AP keeps no table and sends nothing of its own", () => {
    const sim = createStagedSimulation({ seed: SEED, stage: 'P3', factories: FLIP_FACTORIES });
    sim.addDevice({ id: 'sw1', type: 'switch.nfc2960', name: 'SW1', position: { x: 0, y: 0 }, startupConfig: startup([['hostname SW1']]) });
    sim.addDevice({
      id: 'ap1', type: 'ap.nfap-lw', name: 'AP1', position: { x: 100, y: 0 },
      startupConfig: startup([['hostname AP1'], ['no capwap enable'], ['interface Wlan0', ' ssid LAB', ' security wpa2-psk', ' passphrase labpass123']]),
    });
    sim.addDevice({ id: 'lap1', type: 'laptop.nflaptop', name: 'LAP1', position: { x: 150, y: 0 } });
    sim.addLink({ a: { device: 'sw1', port: SW1_TO_PC1 }, b: { device: 'ap1', port: 'GigabitEthernet0' } });
    sim.runFor(5 * SEC);
    expect(sim.configure('lap1', ['wifi connect LAB key labpass123']).ok).toBe(true);
    const evs = during(sim, 150 * SEC);
    expect(sim.device('ap1')!.model.processes).not.toContain('cdp');
    expect(sim.device('ap1')!.tables.get('cdp-neighbours')).toBeUndefined();
    expect(cdpSent(sim, evs, 'ap1')).toEqual([]);
    // every SW1 frame out of Fa0/1 crosses the AP onto the radio and reaches the station, which drops it not-for-me
    const fromSw1 = cdpSent(sim, evs, 'sw1').map((e) => e.pdu.id);
    expect(fromSw1.length).toBeGreaterThanOrEqual(2);
    for (const id of fromSw1) {
      expect(evs.some((e) => e.kind === 'frameTx' && e.pdu.id === id && e.from.device === 'ap1'), `frame ${id} bridged`).toBe(true);
      expect(evs.some((e) => e.kind === 'drop' && e.device === 'lap1' && e.pdu.id === id && e.reason === 'not-for-me' && e.background === true)).toBe(true);
    }
    // nothing was classified as CDP at the AP (no cdp consumer, no off/port refusal there)
    expect(evs.some((e) => e.kind === 'pduConsumed' && e.device === 'ap1' && isCdp(sim, e.pdu.id))).toBe(false);
    expect(cdpDrops(evs, 'ap1').some((d) => d.detail === CDP_DETAIL_OFF || (d.detail ?? '').startsWith('CDP is off on'))).toBe(false);
    expect(rows(sim, 'sw1')).toEqual([]);
  });
});

describe('rule 19 and determinism', () => {
  it('runToIdle returns in fewer than 5 000 events', () => {
    const { sim } = world();
    const stats = sim.runToIdle(5_000);
    expect(stats.stopped).toBeUndefined();
    expect(stats.events).toBeLessThan(5_000);
    // converged: every CDP row of the §3.6 world exists
    expect(rows(sim, 'sw1').map((r) => r.deviceId).sort()).toEqual(['R1', 'SW2']);
    expect(rows(sim, 'r1').map((r) => r.deviceId)).toEqual(['SW1']);
    expect(rows(sim, 'sw2').map((r) => r.deviceId)).toEqual(['SW1']);
    // and it stays idle: a further run to idle dispatches nothing new that is not periodic
    expect(sim.runToIdle(5_000).events).toBe(0);
  });

  it('three runs with one seed give byte-identical trace and snapshot JSON', () => {
    const run = (): string => {
      const { sim, r1sw1 } = world();
      sim.runFor(130 * SEC);
      typeConfig(sim, 'sw1', [`interface ${SW1_TO_PC1}`, 'no cdp enable']);
      sim.runFor(10 * SEC);
      sim.removeLink(r1sw1);
      sim.runFor(10 * SEC);
      return JSON.stringify({ trace: sim.trace(0).events, snapshot: sim.snapshot() });
    };
    const a = run();
    expect(run()).toBe(a);
    expect(run()).toBe(a);
  });
});
