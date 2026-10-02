/**
 * disc.cdp — the NF discovery daemon, "CDP" as a name only (ARCHITECTURE-P3 D2, D18, §3.6, §4.2, §4.3, §5.5; §7 W2
 * disc), on `staged.world` at stage P3 with the real daemon passed through `factories` (the W4 flip registers it).
 *
 * The §3.6 setup: R1 (NF-2911) Gi0/0 ↔ SW1 (NF-C2960) Gi0/1; SW1 Gi0/2 ↔ SW2 Gi0/1, a trunk; PC1 on SW1 Fa0/1. The
 * managed switches receive on bridged ports (eth-switch step 2 and the W1 control rows); R1 receives on its routed port
 * through the pipeline's control check (W2 device). Configuration goes through the stored-line path (`startupConfig`,
 * `applyConfigLine`, rule 13): the CDP grammar is the W2/W3 cli item's.
 */
import { describe, expect, it } from 'vitest';
import type { DefaultsProfile } from '../src/contracts/catalog.js';
import type { DeviceId } from '../src/contracts/ids.js';
import { NF_L2_CONTROL_MAC, NF_OUI, NF_PID_CDP } from '../src/contracts/pdu.js';
import type { Simulation } from '../src/contracts/simulation.js';
import type { CdpNeighbourRow } from '../src/contracts/tables.js';
import { MS, SEC } from '../src/contracts/time.js';
import type { TraceEvent } from '../src/contracts/trace.js';
import { createConfigAst } from '../src/cli/config-ast.js';
import {
  CDP_AGE_TIMER,
  CDP_DEBUG_EVENTS,
  CDP_DEBUG_PACKETS,
  CDP_DETAIL_OFF,
  CDP_TX_TIMER,
  cdpAdvertisesV2,
  cdpCapabilitiesOf,
  cdpHoldtimeS,
  cdpNeighbourKey,
  cdpNeighbourRow,
  cdpPortEnabled,
  cdpPortOffDetail,
  cdpRunning,
  cdpTimerS,
  createCdp,
  discoverySoftwareText,
  isCdpDelta,
} from '../src/protocols/cdp.js';
import { createStagedSimulation } from './staged.world.js';

const SEED = 41;

function startup(sections: readonly (readonly string[])[]): string {
  const out: string[] = [];
  for (const s of sections) out.push(...s, '!');
  out.push('end', '');
  return out.join('\n');
}

interface World {
  sim: Simulation;
  links: { r1sw1: string; sw1sw2: string; pc1sw1: string };
}

/** The §3.6 world; `extra` adds startup lines per device. */
function world(opts: { profile?: DefaultsProfile; extra?: Partial<Record<DeviceId, string[][]>>; hub?: boolean } = {}): World {
  const sim = createStagedSimulation({ seed: SEED, stage: 'P3', ...(opts.profile !== undefined ? { profile: opts.profile } : {}), factories: { cdp: createCdp } });
  const extra = (id: DeviceId): string[][] => opts.extra?.[id] ?? [];
  sim.addDevice({
    id: 'r1', type: 'router.nf2911', name: 'R1',
    startupConfig: startup([['hostname R1'], ['interface GigabitEthernet0/0', ' ip address 10.0.12.1 255.255.255.0', ' no shutdown'], ...extra('r1')]),
  });
  sim.addDevice({
    id: 'sw1', type: 'switch.nfc2960', name: 'SW1',
    startupConfig: startup([['hostname SW1'], ['interface GigabitEthernet0/2', ' switchport mode trunk'], ['interface Vlan1', ' ip address 10.0.12.2 255.255.255.0', ' no shutdown'], ...extra('sw1')]),
  });
  sim.addDevice({ id: 'sw2', type: 'switch.nfc2960', name: 'SW2', startupConfig: startup([['hostname SW2'], ['interface GigabitEthernet0/1', ' switchport mode trunk'], ...extra('sw2')]) });
  sim.addDevice({ id: 'pc1', type: 'pc.nfpc', name: 'PC1', startupConfig: startup([['hostname PC1'], ['interface GigabitEthernet0', ' ip address 10.0.12.10 255.255.255.0']]) });
  let r1sw1: string;
  if (opts.hub === true) {
    sim.addDevice({ id: 'hub1', type: 'hub.nfhub4', name: 'HUB1' });
    sim.addLink({ a: { device: 'r1', port: 'GigabitEthernet0/0' }, b: { device: 'hub1', port: 'Ethernet0' } });
    r1sw1 = sim.addLink({ a: { device: 'hub1', port: 'Ethernet1' }, b: { device: 'sw1', port: 'GigabitEthernet0/1' } });
  } else {
    r1sw1 = sim.addLink({ a: { device: 'r1', port: 'GigabitEthernet0/0' }, b: { device: 'sw1', port: 'GigabitEthernet0/1' } });
  }
  const sw1sw2 = sim.addLink({ a: { device: 'sw1', port: 'GigabitEthernet0/2' }, b: { device: 'sw2', port: 'GigabitEthernet0/1' } });
  const pc1sw1 = sim.addLink({ a: { device: 'pc1', port: 'GigabitEthernet0' }, b: { device: 'sw1', port: 'FastEthernet0/1' } });
  return { sim, links: { r1sw1, sw1sw2, pc1sw1 } };
}

type Created = Extract<TraceEvent, { kind: 'pduCreated' }>;
type Drop = Extract<TraceEvent, { kind: 'drop' }>;

const rows = (sim: Simulation, device: DeviceId): CdpNeighbourRow[] => sim.device(device)!.tables.get<CdpNeighbourRow>('cdp-neighbours')?.rows() ?? [];
const sends = (evs: readonly TraceEvent[], device?: DeviceId): Created[] =>
  evs.filter((e): e is Created => e.kind === 'pduCreated' && e.process === 'cdp' && (device === undefined || e.device === device));
const drops = (evs: readonly TraceEvent[], device: DeviceId): Drop[] => evs.filter((e): e is Drop => e.kind === 'drop' && e.device === device && e.pdu.proto === 'cdp');

/** Events of `fn` and the `runNs` after it. */
function during(sim: Simulation, runNs: number, fn: () => void = () => undefined): TraceEvent[] {
  const cursor = sim.trace(0).next;
  fn();
  sim.runFor(runNs);
  return sim.trace(cursor).events;
}

describe('configuration readers (D2, §5.5)', () => {
  it('cdp run: on by default only in a P3 world on a cdpDefault model; both stored forms win in every profile', () => {
    const ast = createConfigAst();
    const router = { cdpDefault: true as const };
    expect(cdpRunning(ast, 'P3', router)).toBe(true);
    expect(cdpRunning(ast, 'P2', router)).toBe(false);
    expect(cdpRunning(ast, 'P1', router)).toBe(false);
    expect(cdpRunning(ast, 'P3', {})).toBe(false);
    ast.apply([], ['cdp', 'run'], true);
    expect(cdpRunning(ast, 'P3', router)).toBe(false);
    ast.apply([], ['cdp', 'run'], false);
    expect(cdpRunning(ast, 'P1', {})).toBe(true);
    expect(cdpTimerS(ast)).toBe(60);
    expect(cdpHoldtimeS(ast)).toBe(180);
    expect(cdpAdvertisesV2(ast)).toBe(true);
    ast.apply([], ['cdp', 'timer', '30'], false);
    ast.apply([], ['cdp', 'holdtime', '120'], false);
    ast.apply([], ['cdp', 'advertise-v2'], true);
    expect([cdpTimerS(ast), cdpHoldtimeS(ast), cdpAdvertisesV2(ast)]).toEqual([30, 120, false]);
    ast.apply([], ['cdp', 'timer', '4'], false); // out of range: the default
    expect(cdpTimerS(ast)).toBe(60);
    expect(cdpPortEnabled(ast, 'FastEthernet0/1')).toBe(true);
    ast.apply([['interface', 'FastEthernet0/1']], ['cdp', 'enable'], true);
    expect(cdpPortEnabled(ast, 'FastEthernet0/1')).toBe(false);
    expect(cdpPortEnabled(ast, 'FastEthernet0/2')).toBe(true);
    expect(isCdpDelta({ line: ['cdp', 'run'] })).toBe(true);
    expect(isCdpDelta({ line: ['no', 'cdp', 'run'] })).toBe(true);
    expect(isCdpDelta({ line: ['lldp', 'run'] })).toBe(false);
  });

  it('rows from a received layer; capability letters from the model', () => {
    expect(cdpNeighbourRow('GigabitEthernet0/1', { version: 2, ttl: 180, deviceId: 'R1', portId: 'GigabitEthernet0/0', addresses: '10.0.12.1', capabilities: 'R', platform: 'NF-2911', software: 'x', duplex: 'full' }, 5 * SEC)).toEqual({
      key: 'GigabitEthernet0/1|R1', localPort: 'GigabitEthernet0/1', deviceId: 'R1', remotePort: 'GigabitEthernet0/0', platform: 'NF-2911', capabilities: 'R',
      addresses: '10.0.12.1', version: 'x', holdtimeS: 180, cdpVersion: 2, duplex: 'full', expiresAt: 185 * SEC, updatedAt: 5 * SEC,
    });
    expect(cdpNeighbourRow('Gi0/1', { version: 2, ttl: 180, portId: 'x' }, 0)).toBeUndefined();
    expect(cdpNeighbourKey('GigabitEthernet0/1', 'R1')).toBe('GigabitEthernet0/1|R1');
    expect(cdpCapabilitiesOf({ capabilities: ['routing'] })).toBe('R');
    expect(cdpCapabilitiesOf({ capabilities: ['switching', 'managed-switch'] })).toBe('S I');
    expect(cdpCapabilitiesOf({ capabilities: ['switching', 'routing', 'managed-switch'] })).toBe('R S I');
    expect(cdpCapabilitiesOf({ capabilities: ['host'] })).toBe('H');
  });
});

describe('§3.6 on staged.world: boot, link-up, receipt, rows', () => {
  it('boot: silent while every port is down — no frame, no row, no debug line', () => {
    const { sim } = world();
    const evs = during(sim, 29 * SEC); // switches boot at 30 s, routers at 45 s
    expect(sends(evs)).toEqual([]);
    expect(evs.filter((e) => e.kind === 'debug' && e.event.process === 'cdp')).toEqual([]);
    expect(evs.filter((e) => e.kind === 'tableWrite' && e.table === 'cdp-neighbours')).toEqual([]);
  });

  it('link-up: one frame at once in the NF format, background, untagged; SW1 S I, on the trunk with its native VLAN', () => {
    const { sim } = world();
    const evs = during(sim, 50 * SEC);
    const r1 = sends(evs, 'r1');
    expect(r1).toHaveLength(1);
    const f = sim.pdu(r1[0]!.pdu.id)!;
    expect(f.layers.map((l) => l.proto)).toEqual(['ethernet', 'llc', 'cdp']);
    expect(f.layers[0]!.fields).toMatchObject({ dst: NF_L2_CONTROL_MAC, src: sim.device('r1')!.port('GigabitEthernet0/0')!.mac });
    expect(f.layers[1]!.fields).toMatchObject({ oui: NF_OUI, type: NF_PID_CDP });
    expect(f.layers[2]!.fields).toEqual({
      version: 2, ttl: 180, deviceId: 'R1', addresses: '10.0.12.1', portId: 'GigabitEthernet0/0', capabilities: 'R', platform: 'NF-2911',
      software: discoverySoftwareText({ model: 'NF-2911' }), duplex: 'full',
    });
    expect(f.meta).toMatchObject({ tag: 'cdp', background: true });
    const sw1 = sends(evs, 'sw1').map((e) => sim.pdu(e.pdu.id)!.layers[2]!.fields);
    const towardR1 = sw1.find((x) => x.portId === 'GigabitEthernet0/1')!;
    const towardSw2 = sw1.find((x) => x.portId === 'GigabitEthernet0/2')!;
    expect(towardR1).toMatchObject({ deviceId: 'SW1', capabilities: 'S I', platform: 'NF-C2960' });
    expect(towardR1.nativeVlan).toBeUndefined();
    // the switch's management address is its first up SVI's: at its first link-up Vlan1 is not up yet
    expect(towardR1.addresses).toBeUndefined();
    sim.runFor(60 * SEC);
    expect(rows(sim, 'r1').map((r) => r.addresses)).toEqual(['10.0.12.2']);
    expect(towardSw2).toMatchObject({ deviceId: 'SW1', nativeVlan: 1 });
    expect(sends(evs).every((e) => e.pdu.vlan === undefined)).toBe(true);
  });

  it('receipt: rows on the switches (bridged ports) and on R1 (routed port, the control check); PC1 drops not-for-me', () => {
    const { sim } = world();
    const evs = during(sim, 50 * SEC);
    const sw1 = rows(sim, 'sw1');
    const r1row = sw1.find((r) => r.deviceId === 'R1')!;
    expect(r1row).toMatchObject({
      key: 'GigabitEthernet0/1|R1', localPort: 'GigabitEthernet0/1', deviceId: 'R1', remotePort: 'GigabitEthernet0/0', platform: 'NF-2911',
      capabilities: 'R', addresses: '10.0.12.1', holdtimeS: 180, cdpVersion: 2, duplex: 'full',
    });
    expect(r1row.expiresAt).toBe(r1row.updatedAt + 180 * SEC);
    expect(sw1.find((r) => r.deviceId === 'SW2')).toMatchObject({ localPort: 'GigabitEthernet0/2', remotePort: 'GigabitEthernet0/1', nativeVlan: 1, capabilities: 'S I' });
    expect(rows(sim, 'sw2').map((r) => [r.localPort, r.deviceId, r.remotePort])).toEqual([['GigabitEthernet0/1', 'SW1', 'GigabitEthernet0/2']]);
    expect(rows(sim, 'r1').map((r) => [r.localPort, r.deviceId, r.remotePort, r.capabilities])).toEqual([['GigabitEthernet0/0', 'SW1', 'GigabitEthernet0/1', 'S I']]);
    // the debug line of a receipt (§3.6 step 4) and the new-neighbour event
    const dbg = evs.filter((e): e is Extract<TraceEvent, { kind: 'debug' }> => e.kind === 'debug' && e.event.device === 'sw1' && e.event.process === 'cdp');
    expect(dbg.some((e) => e.event.category === CDP_DEBUG_PACKETS && e.event.message === 'received CDP v2 from R1 on GigabitEthernet0/1, 1 address, holdtime 180 s')).toBe(true);
    expect(dbg.some((e) => e.event.category === CDP_DEBUG_EVENTS && e.event.message.startsWith('new neighbour R1 on GigabitEthernet0/1'))).toBe(true);
    // PC1 runs no cdp: SW1's frame drops not-for-me at step 10b, marked background
    const pc = drops(evs, 'pc1');
    expect(pc.length).toBeGreaterThan(0);
    expect(pc.every((d) => d.reason === 'not-for-me' && d.detail === 'link-layer control frame' && d.background === true)).toBe(true);
    // nothing else dropped a CDP frame
    for (const d of ['r1', 'sw1', 'sw2']) expect(drops(evs, d)).toEqual([]);
  });

  it('every 60 s one frame per enabled up port; a refresh rewrites only the volatile columns; runToIdle returns', () => {
    const { sim } = world();
    sim.runFor(50 * SEC);
    const before = rows(sim, 'sw1').find((r) => r.deviceId === 'R1')!;
    const evs = during(sim, 180 * SEC);
    const r1 = sends(evs, 'r1');
    expect(r1).toHaveLength(3);
    expect(r1[1]!.t - r1[0]!.t).toBe(60 * SEC);
    expect(r1[2]!.t - r1[1]!.t).toBe(60 * SEC);
    // SW1 sends on Gi0/1, Gi0/2 and Fa0/1 each time, in canonical port order
    const sw1 = sends(evs, 'sw1');
    expect(sw1).toHaveLength(9);
    expect(sw1.slice(0, 3).map((e) => sim.pdu(e.pdu.id)!.layers[2]!.fields.portId)).toEqual(['FastEthernet0/1', 'GigabitEthernet0/1', 'GigabitEthernet0/2']);
    const after = rows(sim, 'sw1').find((r) => r.deviceId === 'R1')!;
    const { expiresAt: e1, updatedAt: u1, ...stable1 } = before;
    const { expiresAt: e2, updatedAt: u2, ...stable2 } = after;
    expect(stable2).toEqual(stable1);
    expect(e2! - e1!).toBe(u2 - u1);
    expect(e2! - u2).toBe(180 * SEC);
    const idle = sim.runToIdle();
    expect(idle).toBeDefined();
    expect(sim.device('r1')!.processes.get('cdp')!.stateSnapshot()).toMatchObject({ process: 'cdp', state: { running: true, timerS: 60, holdtimeS: 180, advertiseV2: true, disabled: [] } });
  });

  it('link-down deletes the port rows (reason link-down); behind a hub a silent neighbour ages out at last update + holdtime', () => {
    const w = world();
    w.sim.runFor(50 * SEC);
    const evs = during(w.sim, SEC, () => w.sim.removeLink(w.links.r1sw1));
    const expired = evs.filter((e): e is Extract<TraceEvent, { kind: 'tableExpire' }> => e.kind === 'tableExpire' && e.table === 'cdp-neighbours');
    expect(expired.map((e) => [e.device, e.key, e.reason]).sort()).toEqual([
      ['r1', 'GigabitEthernet0/0|SW1', 'link-down'],
      ['sw1', 'GigabitEthernet0/1|R1', 'link-down'],
    ]);
    expect(rows(w.sim, 'sw1').some((r) => r.deviceId === 'R1')).toBe(false);

    const h = world({ hub: true });
    h.sim.runFor(50 * SEC);
    const row = rows(h.sim, 'sw1').find((r) => r.deviceId === 'R1')!;
    expect(row.localPort).toBe('GigabitEthernet0/1');
    const last = row.updatedAt;
    h.sim.setPower('r1', false);
    const aged = during(h.sim, 200 * SEC).filter((e): e is Extract<TraceEvent, { kind: 'tableExpire' }> => e.kind === 'tableExpire' && e.table === 'cdp-neighbours' && e.device === 'sw1');
    expect(aged.map((e) => [e.key, e.reason])).toEqual([['GigabitEthernet0/1|R1', 'aged']]);
    expect(aged[0]!.t - last).toBeGreaterThanOrEqual(180 * SEC);
    expect(aged[0]!.t - last).toBeLessThanOrEqual(180 * SEC + MS);
  });
});

describe('§3.6 step 6: hardening and the configuration lines', () => {
  it('no cdp enable on SW1 Fa0/1 stops sending there (edge hardening); frames from that port are dropped', () => {
    const { sim } = world({ extra: { sw1: [['interface FastEthernet0/1', ' no cdp enable']] } });
    const evs = during(sim, 160 * SEC);
    const ports = sends(evs, 'sw1').map((e) => sim.pdu(e.pdu.id)!.layers[2]!.fields.portId);
    expect(ports).not.toContain('FastEthernet0/1');
    expect(ports).toContain('GigabitEthernet0/1');
    expect(drops(evs, 'pc1')).toEqual([]);
    expect(sim.device('sw1')!.processes.get('cdp')!.stateSnapshot().state).toMatchObject({ disabled: ['FastEthernet0/1'] });
    expect(cdpPortOffDetail('FastEthernet0/1')).toBe('CDP is off on FastEthernet0/1');
  });

  it('no cdp run stops everything, clears the table, is stored explicitly, and frames are consumed as off', () => {
    const { sim } = world();
    sim.runFor(50 * SEC);
    expect(rows(sim, 'sw1').length).toBe(2);
    const sw1 = sim.device('sw1')!;
    const evs = during(sim, 130 * SEC, () => expect(sw1.applyConfigLine([], ['cdp', 'run'], true)).toEqual({ ok: true }));
    expect(sw1.running.render()).toContain('\nno cdp run\n');
    expect(rows(sim, 'sw1')).toEqual([]);
    expect(evs.filter((e) => e.kind === 'tableExpire' && e.device === 'sw1' && e.table === 'cdp-neighbours').map((e) => (e as { reason: string }).reason)).toEqual(['cleared', 'cleared']);
    expect(sends(evs, 'sw1')).toEqual([]);
    const off = drops(evs, 'sw1');
    expect(off.length).toBeGreaterThan(0);
    expect(off.every((d) => d.reason === 'not-for-me' && d.detail === CDP_DETAIL_OFF)).toBe(true);
    // turned on again: it speaks at once on every up port
    const again = during(sim, SEC, () => expect(sw1.applyConfigLine([], ['cdp', 'run'], false)).toEqual({ ok: true }));
    expect(sends(again, 'sw1')).toHaveLength(3);
    expect(sends(again, 'sw1').every((e) => e.t === sends(again, 'sw1')[0]!.t)).toBe(true);
  });

  it('cdp timer and holdtime change the period and the advertised holdtime; no cdp advertise-v2 sends version 1', () => {
    const { sim } = world({ extra: { r1: [['cdp timer 30'], ['cdp holdtime 120'], ['no cdp advertise-v2']] } });
    const evs = during(sim, 120 * SEC);
    const r1 = sends(evs, 'r1');
    expect(r1.length).toBeGreaterThanOrEqual(3);
    expect(r1[1]!.t - r1[0]!.t).toBe(30 * SEC);
    expect(sim.pdu(r1[0]!.pdu.id)!.layers[2]!.fields).toMatchObject({ version: 1, ttl: 120 });
    expect(rows(sim, 'sw1').find((r) => r.deviceId === 'R1')).toMatchObject({ holdtimeS: 120, cdpVersion: 1 });
    expect(CDP_TX_TIMER).toBe('cdp-tx');
    expect(CDP_AGE_TIMER).toBe('cdp-age');
  });
});

describe('silence (§4.3) and the profile (D2)', () => {
  it('a P2 world sends no CDP, writes no row, emits no cdp debug line', () => {
    const { sim } = world({ profile: 'P2' });
    const evs = during(sim, 200 * SEC);
    expect(sends(evs)).toEqual([]);
    expect(evs.filter((e) => e.kind === 'debug' && e.event.process === 'cdp')).toEqual([]);
    expect(evs.filter((e) => (e.kind === 'tableWrite' || e.kind === 'tableExpire') && e.table === 'cdp-neighbours')).toEqual([]);
    expect(sim.device('r1')!.model.processes).toContain('cdp');
  });

  it('cdp run typed in a P2 world works (the profile never gates the feature)', () => {
    const { sim } = world({ profile: 'P2', extra: { r1: [['cdp run']], sw1: [['cdp run']] } });
    sim.runFor(50 * SEC);
    expect(rows(sim, 'sw1').map((r) => r.deviceId)).toEqual(['R1']);
    expect(rows(sim, 'r1').map((r) => r.deviceId)).toEqual(['SW1']);
    expect(rows(sim, 'sw2')).toEqual([]);
  });

  it('two runs with one seed are identical', () => {
    const a = world();
    const b = world();
    const ta = during(a.sim, 130 * SEC).filter((e) => e.kind !== 'topologyChanged');
    const tb = during(b.sim, 130 * SEC).filter((e) => e.kind !== 'topologyChanged');
    expect(JSON.stringify(ta)).toBe(JSON.stringify(tb));
  });
});
