/**
 * disc.lldp — the IEEE 802.1AB LLDP daemon (ARCHITECTURE-P3 D2, D18, §3.6 step 7, §4.2, §4.3, §5.5; §7 W2 disc), on
 * `staged.world` at stage P3 with the real daemon passed through `factories` (the W4 flip registers it).
 *
 * Setup: SW1 (NF-C2960) Gi0/2 ↔ SW2 (NF-C2960) Gi0/1, a trunk; R1 (NF-2911) Gi0/0 ↔ SW1 Gi0/1; PC1 on SW1 Fa0/1.
 * LLDP is off by default in every profile; `lldp run` turns it on (stored-line path, rule 13). The switches receive on
 * bridged ports (eth-switch step 2); R1 on its routed port (the pipeline's control check).
 */
import { describe, expect, it } from 'vitest';
import type { DefaultsProfile } from '../src/contracts/catalog.js';
import type { DeviceId } from '../src/contracts/ids.js';
import { ETHERTYPE_LLDP, LLDP_NEAREST_BRIDGE_MAC } from '../src/contracts/pdu.js';
import type { Simulation } from '../src/contracts/simulation.js';
import type { LldpNeighbourRow } from '../src/contracts/tables.js';
import { SEC } from '../src/contracts/time.js';
import type { TraceEvent } from '../src/contracts/trace.js';
import { createConfigAst } from '../src/cli/config-ast.js';
import { discoverySoftwareText } from '../src/protocols/cdp.js';
import {
  LLDP_DEBUG_PACKETS,
  LLDP_DETAIL_OFF,
  createLldp,
  isLldpDelta,
  lldpCapabilityBits,
  lldpCapabilityText,
  lldpHoldtimeS,
  lldpNeighbourKey,
  lldpNeighbourRow,
  lldpPortReceives,
  lldpPortTransmits,
  lldpReceiveOffDetail,
  lldpReinitS,
  lldpRunning,
  lldpTimerS,
} from '../src/protocols/lldp.js';
import { createStagedSimulation } from './staged.world.js';

function startup(sections: readonly (readonly string[])[]): string {
  const out: string[] = [];
  for (const s of sections) out.push(...s, '!');
  out.push('end', '');
  return out.join('\n');
}

function world(opts: { profile?: DefaultsProfile; extra?: Partial<Record<DeviceId, string[][]>> } = {}): Simulation {
  const sim = createStagedSimulation({ seed: 43, stage: 'P3', ...(opts.profile !== undefined ? { profile: opts.profile } : {}), factories: { lldp: createLldp } });
  const extra = (id: DeviceId): string[][] => opts.extra?.[id] ?? [];
  sim.addDevice({
    id: 'r1', type: 'router.nf2911', name: 'R1',
    startupConfig: startup([['hostname R1'], ['interface GigabitEthernet0/0', ' description to SW1', ' ip address 10.0.12.1 255.255.255.0', ' no shutdown'], ...extra('r1')]),
  });
  sim.addDevice({
    id: 'sw1', type: 'switch.nfc2960', name: 'SW1',
    startupConfig: startup([['hostname SW1'], ['interface GigabitEthernet0/2', ' switchport mode trunk'], ['interface Vlan1', ' ip address 10.0.12.2 255.255.255.0', ' no shutdown'], ...extra('sw1')]),
  });
  sim.addDevice({ id: 'sw2', type: 'switch.nfc2960', name: 'SW2', startupConfig: startup([['hostname SW2'], ['interface GigabitEthernet0/1', ' switchport mode trunk'], ...extra('sw2')]) });
  sim.addDevice({ id: 'pc1', type: 'pc.nfpc', name: 'PC1', startupConfig: startup([['hostname PC1']]) });
  sim.addLink({ a: { device: 'r1', port: 'GigabitEthernet0/0' }, b: { device: 'sw1', port: 'GigabitEthernet0/1' } });
  sim.addLink({ a: { device: 'sw1', port: 'GigabitEthernet0/2' }, b: { device: 'sw2', port: 'GigabitEthernet0/1' } });
  sim.addLink({ a: { device: 'pc1', port: 'GigabitEthernet0' }, b: { device: 'sw1', port: 'FastEthernet0/1' } });
  return sim;
}

type Created = Extract<TraceEvent, { kind: 'pduCreated' }>;
type Drop = Extract<TraceEvent, { kind: 'drop' }>;
const rows = (sim: Simulation, device: DeviceId): LldpNeighbourRow[] => sim.device(device)!.tables.get<LldpNeighbourRow>('lldp-neighbours')?.rows() ?? [];
const sends = (evs: readonly TraceEvent[], device?: DeviceId): Created[] =>
  evs.filter((e): e is Created => e.kind === 'pduCreated' && e.process === 'lldp' && (device === undefined || e.device === device));
const drops = (evs: readonly TraceEvent[], device: DeviceId): Drop[] => evs.filter((e): e is Drop => e.kind === 'drop' && e.device === device && e.pdu.proto === 'lldp');
function during(sim: Simulation, runNs: number, fn: () => void = () => undefined): TraceEvent[] {
  const cursor = sim.trace(0).next;
  fn();
  sim.runFor(runNs);
  return sim.trace(cursor).events;
}

const ALL_ON = { r1: [['lldp run']], sw1: [['lldp run']], sw2: [['lldp run']] };

describe('configuration readers (§5.5)', () => {
  it('off unless lldp run is stored; timer, holdtime and reinit with their defaults; per-port transmit and receive', () => {
    const ast = createConfigAst();
    expect(lldpRunning(ast)).toBe(false);
    expect([lldpTimerS(ast), lldpHoldtimeS(ast), lldpReinitS(ast)]).toEqual([30, 120, 2]);
    ast.apply([], ['lldp', 'run'], false);
    ast.apply([], ['lldp', 'timer', '10'], false);
    ast.apply([], ['lldp', 'holdtime', '0'], false);
    ast.apply([], ['lldp', 'reinit', '5'], false);
    expect(lldpRunning(ast)).toBe(true);
    expect([lldpTimerS(ast), lldpHoldtimeS(ast), lldpReinitS(ast)]).toEqual([10, 0, 5]);
    ast.apply([['interface', 'GigabitEthernet0/1']], ['lldp', 'transmit'], true);
    expect([lldpPortTransmits(ast, 'GigabitEthernet0/1'), lldpPortReceives(ast, 'GigabitEthernet0/1')]).toEqual([false, true]);
    ast.apply([['interface', 'GigabitEthernet0/1']], ['lldp', 'receive'], true);
    expect(lldpPortReceives(ast, 'GigabitEthernet0/1')).toBe(false);
    ast.apply([], ['lldp', 'run'], true);
    expect(lldpRunning(ast)).toBe(false);
    expect(isLldpDelta({ line: ['lldp', 'transmit'] })).toBe(true);
    expect(isLldpDelta({ line: ['cdp', 'run'] })).toBe(false);
  });

  it('IEEE capability bits and letters; rows from a received layer', () => {
    expect(lldpCapabilityBits({ capabilities: ['switching', 'managed-switch'] })).toBe(0x04);
    expect(lldpCapabilityBits({ capabilities: ['routing'] })).toBe(0x10);
    expect(lldpCapabilityBits({ capabilities: ['switching', 'routing'] })).toBe(0x14);
    expect(lldpCapabilityBits({ capabilities: ['host'] })).toBe(0x80);
    expect(lldpCapabilityText(0x14)).toBe('B,R');
    expect(lldpCapabilityText(0)).toBe('');
    expect(lldpNeighbourRow('GigabitEthernet0/1', { chassisSubtype: 4, chassisId: '02:00:00:00:00:01', portSubtype: 5, portId: 'GigabitEthernet0/0', ttl: 120, systemName: 'R1', capabilities: 0x10, enabledCapabilities: 0x10, mgmtAddress: '10.0.12.1' }, 3 * SEC)).toEqual({
      key: 'GigabitEthernet0/1|02:00:00:00:00:01|GigabitEthernet0/0', localPort: 'GigabitEthernet0/1', chassisId: '02:00:00:00:00:01', portId: 'GigabitEthernet0/0',
      ttlS: 120, systemName: 'R1', capabilities: 'R', enabled: 'R', mgmtAddress: '10.0.12.1', expiresAt: 123 * SEC, updatedAt: 3 * SEC,
    });
    expect(lldpNeighbourKey('Gi0/1', 'c', 'p')).toBe('Gi0/1|c|p');
    expect(lldpNeighbourRow('Gi0/1', { chassisId: 'c', portId: 'p' }, 0)).toBeUndefined();
  });
});

describe('§3.6 step 7 on staged.world', () => {
  it('silent by default in a P3 world (LLDP is opt-in everywhere): no frame, no row, no debug line', () => {
    const sim = world();
    const evs = during(sim, 200 * SEC);
    expect(sends(evs)).toEqual([]);
    expect(evs.filter((e) => e.kind === 'debug' && e.event.process === 'lldp')).toEqual([]);
    expect(evs.filter((e) => e.kind === 'tableWrite' && e.table === 'lldp-neighbours')).toEqual([]);
  });

  it('lldp run: IEEE frames at link-up and every 30 s, TTL 120; rows on the switches and on R1 (routed port)', () => {
    const sim = world({ extra: ALL_ON });
    const evs = during(sim, 50 * SEC);
    const r1 = sends(evs, 'r1');
    expect(r1).toHaveLength(1);
    const f = sim.pdu(r1[0]!.pdu.id)!;
    expect(f.layers.map((l) => l.proto)).toEqual(['ethernet', 'lldp']);
    expect(f.layers[0]!.fields).toMatchObject({ dst: LLDP_NEAREST_BRIDGE_MAC, type: ETHERTYPE_LLDP });
    const r1mac = sim.device('r1')!.port('GigabitEthernet0/0')!.mac;
    const chassis = [...sim.device('r1')!.ports.values()][0]!.mac;
    expect(f.layers[1]!.fields).toEqual({
      chassisSubtype: 4, chassisId: chassis, portSubtype: 5, portId: 'GigabitEthernet0/0', ttl: 120, portDescription: 'to SW1', systemName: 'R1',
      systemDescription: discoverySoftwareText({ model: 'NF-2911' }), capabilities: 0x10, enabledCapabilities: 0x10, mgmtAddress: '10.0.12.1',
    });
    expect(f.layers[0]!.fields.src).toBe(r1mac);
    expect(f.meta).toMatchObject({ tag: 'lldp', background: true });
    expect(rows(sim, 'sw1').map((r) => [r.localPort, r.systemName, r.portId, r.capabilities, r.mgmtAddress])).toEqual(
      expect.arrayContaining([
        ['GigabitEthernet0/1', 'R1', 'GigabitEthernet0/0', 'R', '10.0.12.1'],
        ['GigabitEthernet0/2', 'SW2', 'GigabitEthernet0/1', 'B', undefined],
      ]),
    );
    // SW1's management address is its first up SVI's: Vlan1 is not up yet at its first frames
    expect(rows(sim, 'r1').map((r) => [r.localPort, r.systemName, r.portId, r.capabilities, r.mgmtAddress])).toEqual([['GigabitEthernet0/0', 'SW1', 'GigabitEthernet0/1', 'B', undefined]]);
    const row = rows(sim, 'r1')[0]!;
    expect(row.expiresAt).toBe(row.updatedAt + 120 * SEC);
    // PC1 runs no lldp: SW1's frames drop not-for-me at step 10b
    expect(drops(evs, 'pc1').every((d) => d.reason === 'not-for-me' && d.detail === 'link-layer control frame' && d.background === true)).toBe(true);
    for (const d of ['r1', 'sw1', 'sw2']) expect(drops(evs, d)).toEqual([]);
    const later = during(sim, 90 * SEC);
    const periodic = sends(later, 'r1');
    expect(periodic).toHaveLength(3);
    expect(periodic[1]!.t - periodic[0]!.t).toBe(30 * SEC);
    expect(rows(sim, 'r1').map((r) => r.mgmtAddress)).toEqual(['10.0.12.2']);
    expect(later.some((e) => e.kind === 'debug' && e.event.process === 'lldp' && e.event.category === LLDP_DEBUG_PACKETS && e.event.message === 'received LLDP from R1 on GigabitEthernet0/1, ttl 120 s')).toBe(true);
    expect(sim.runToIdle()).toBeDefined();
  });

  it('no lldp transmit / no lldp receive are per port and asymmetric', () => {
    const sim = world({ extra: { r1: [['lldp run']], sw1: [['lldp run'], ['interface GigabitEthernet0/1', ' no lldp transmit']], sw2: [['lldp run'], ['interface GigabitEthernet0/1', ' no lldp receive']] } });
    const evs = during(sim, 100 * SEC);
    // SW1 does not transmit toward R1: R1 learns nothing; SW1 still learns R1
    expect(rows(sim, 'r1')).toEqual([]);
    expect(rows(sim, 'sw1').map((r) => r.systemName)).toContain('R1');
    // SW2 does not receive from SW1 (its frames are dropped there), but SW1 still learns SW2
    expect(rows(sim, 'sw2')).toEqual([]);
    expect(rows(sim, 'sw1').map((r) => r.systemName)).toContain('SW2');
    const refused = drops(evs, 'sw2');
    expect(refused.length).toBeGreaterThan(0);
    expect(refused.every((d) => d.reason === 'not-for-me' && d.detail === lldpReceiveOffDetail('GigabitEthernet0/1'))).toBe(true);
    expect(sends(evs, 'sw1').map((e) => sim.pdu(e.pdu.id)!.layers[1]!.fields.portId)).not.toContain('GigabitEthernet0/1');
    expect(sim.device('sw2')!.processes.get('lldp')!.stateSnapshot().state).toMatchObject({ running: true, noReceive: ['GigabitEthernet0/1'], noTransmit: [] });
  });

  it('no lldp run stops, clears the table, and drops what still arrives as off', () => {
    const sim = world({ extra: ALL_ON });
    sim.runFor(50 * SEC);
    const sw1 = sim.device('sw1')!;
    expect(rows(sim, 'sw1')).toHaveLength(2);
    const evs = during(sim, 40 * SEC, () => expect(sw1.applyConfigLine([], ['lldp', 'run'], true)).toEqual({ ok: true }));
    expect(rows(sim, 'sw1')).toEqual([]);
    expect(evs.filter((e) => e.kind === 'tableExpire' && e.device === 'sw1' && e.table === 'lldp-neighbours').map((e) => (e as { reason: string }).reason)).toEqual(['cleared', 'cleared']);
    expect(sends(evs, 'sw1')).toEqual([]);
    expect(drops(evs, 'sw1').length).toBeGreaterThan(0);
    expect(drops(evs, 'sw1').every((d) => d.reason === 'not-for-me' && d.detail === LLDP_DETAIL_OFF)).toBe(true);
  });

  it('lldp holdtime 0 advertises a TTL of 0, which removes the row at the neighbours at once (an IEEE shutdown)', () => {
    const sim = world({ extra: ALL_ON });
    sim.runFor(50 * SEC);
    expect(rows(sim, 'sw2').map((r) => r.systemName)).toEqual(['SW1']);
    expect(rows(sim, 'r1').map((r) => r.systemName)).toEqual(['SW1']);
    const sw1 = sim.device('sw1')!;
    const evs = during(sim, 31 * SEC, () => expect(sw1.applyConfigLine([], ['lldp', 'holdtime', '0'], false)).toEqual({ ok: true }));
    expect(sends(evs, 'sw1').map((e) => sim.pdu(e.pdu.id)!.layers[1]!.fields.ttl)).toEqual([0, 0, 0]);
    expect(rows(sim, 'sw2')).toEqual([]);
    expect(rows(sim, 'r1')).toEqual([]);
    const gone = evs.filter((e): e is Extract<TraceEvent, { kind: 'tableExpire' }> => e.kind === 'tableExpire' && e.table === 'lldp-neighbours');
    expect(gone.map((e) => [e.device, e.reason]).sort()).toEqual([['r1', 'cleared'], ['sw2', 'cleared']]);
  });

  it('a P2 world is silent too; lldp run in a P2 world works', () => {
    const quiet = world({ profile: 'P2' });
    expect(sends(during(quiet, 100 * SEC))).toEqual([]);
    const on = world({ profile: 'P2', extra: ALL_ON });
    on.runFor(50 * SEC);
    expect(rows(on, 'sw2').map((r) => r.systemName)).toEqual(['SW1']);
  });
});
