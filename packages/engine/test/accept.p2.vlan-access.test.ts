/**
 * P2 acceptance — access ports with a VLAN (ARCHITECTURE-P2 §3.1, §3.0 step 4, §10.1 row `accept.p2.vlan-access`),
 * on a real P2-profile world of `test/p2.world.ts` with the vlan, dtp, etherchannel and stp daemons.
 *
 * §3.1: SW1 with `vlan 10` (SALES), Fa0/1–2 access VLAN 10 (PC1, PC2), Fa0/3 at its defaults (PC3, VLAN 1). PC1→PC2
 * pings 5/5; PC3→PC1 0/5 with `arp-unresolved` at PC3; the CAM keys are `10/<PC1 mac>` and `1/<PC3 mac>`; the echo
 * request PC2 receives has PC1's PduId and byte-identical bytes; no VlanTagPush/VlanTagPop anywhere; a frame tagged
 * 20 injected on Fa0/1 drops `vlan-filtered`; after `no vlan 10` the ping fails with `vlan-filtered` / `VLAN 10 does
 * not exist`. Access-VLAN mismatch: SW1 Fa0/24 (VLAN 10) ↔ SW2 Fa0/24 (VLAN 20) with one PC each in one subnet:
 * after convergence the ping succeeds 5/5 and neither port is inconsistent (two access ports merge their VLANs, D8).
 */
import { describe, expect, it } from 'vitest';
import { MAC_BROADCAST, type MacAddress } from '../src/contracts/addr.js';
import type { PortId } from '../src/contracts/ids.js';
import { ARP_OP_REQUEST, ETHERTYPE_ARP, ETHERTYPE_VLAN, type Pdu } from '../src/contracts/pdu.js';
import type { Simulation } from '../src/contracts/simulation.js';
import { camKey, stpKey, type StpPortRow } from '../src/contracts/tables.js';
import { SEC } from '../src/contracts/time.js';
import type { TraceEvent } from '../src/contracts/trace.js';
import { createPduFactory } from '../src/pdu/factory.js';
import { createDtp } from '../src/protocols/dtp.js';
import { createEtherchannel } from '../src/protocols/etherchannel.js';
import { taggedOnAccessDetail, vlanMissingDetail } from '../src/protocols/l2/membership.js';
import { createStp } from '../src/protocols/stp.js';
import { createVlan } from '../src/protocols/vlan.js';
import { configText, section } from '../src/sim/scenarios/kit.js';
import { pcConfig } from '../src/sim/scenarios/templates.js';
import { createP2Simulation, type P2FactoryOverlay } from './p2.world.js';
import { ofKind, ping } from './sim.harness.js';

const L2: P2FactoryOverlay = { vlan: createVlan, dtp: createDtp, etherchannel: createEtherchannel, stp: createStp };
const SWITCH = 'switch.nfc2960';
const PC = 'pc.nfpc';
const FA1: PortId = 'FastEthernet0/1';
const FA2: PortId = 'FastEthernet0/2';
const FA3: PortId = 'FastEthernet0/3';
const FA24: PortId = 'FastEthernet0/24';
/** Switches boot at 30 s; every access port forwards 30 s later (no PortFast). */
const CONVERGED = 65 * SEC;

const macOf = (sim: Simulation, dev: string): MacAddress => sim.device(dev)!.port('GigabitEthernet0')!.mac;

/** The §3.1 world: SW1 with VLAN 10 on Fa0/1–2, Fa0/3 untouched, three PCs in 10.0.0.0/24. */
function salesWorld(seed = 7): Simulation {
  const sim = createP2Simulation({ seed, profile: 'P2', factories: L2 });
  sim.addDevice({
    id: 'sw1', type: SWITCH, name: 'SW1',
    startupConfig: configText([
      ['hostname SW1'],
      section('vlan 10', ['name SALES']),
      section(`interface ${FA1}`, ['switchport mode access', 'switchport access vlan 10']),
      section(`interface ${FA2}`, ['switchport mode access', 'switchport access vlan 10']),
    ]),
  });
  for (const [i, port] of [FA1, FA2, FA3].entries()) {
    const id = `pc${i + 1}`;
    sim.addDevice({ id, type: PC, name: id.toUpperCase(), startupConfig: pcConfig(id.toUpperCase(), `10.0.0.${i + 1}`, '255.255.255.0') });
    sim.addLink({ id: `l_${id}`, a: { device: id, port: 'GigabitEthernet0' }, b: { device: 'sw1', port } });
  }
  return sim;
}

/** An ARP request frame tagged `vid` from `src`, as a switch would inject it on a port (a test-only PDU factory). */
function taggedFrame(src: MacAddress, vid: number, now: number): Pdu {
  return createPduFactory({ firstId: 900_000 }).build(
    [
      { proto: 'ethernet', fields: { dst: MAC_BROADCAST, src, type: ETHERTYPE_VLAN } },
      { proto: 'dot1q', fields: { vid, type: ETHERTYPE_ARP } },
      { proto: 'arp', fields: { op: ARP_OP_REQUEST, sha: src, spa: '10.0.0.9', tha: '00:00:00:00:00:00', tpa: '10.0.0.8' } },
    ],
    { born: now, origin: 'd_test' },
  );
}

describe('accept P2 vlan-access: §3.1', () => {
  it('PC1→PC2 5/5, PC3→PC1 0/5 arp-unresolved, CAM keys per VLAN, the same PduId and bytes end to end, no tag mutation', () => {
    const sim = salesWorld();
    sim.runUntil(CONVERGED);
    expect(sim.device('sw1')!.tables.get('vlans')!.get('10')).toMatchObject({ vlan: 10, name: 'SALES', status: 'active', source: 'config' });
    for (const port of [FA1, FA2]) expect(sim.device('sw1')!.tables.get<StpPortRow>('stp')!.get(stpKey(10, port))?.state, port).toBe('forwarding');

    // bytes as PC1 sent them and as PC2 received them, captured when the events happen (the PDU object is shared)
    const sent = new Map<number, string>();
    const received = new Map<number, string>();
    const hex = (id: number): string => Array.from(sim.pdu(id)!.bytes, (b) => b.toString(16).padStart(2, '0')).join('');
    const stop = sim.onTrace((e) => {
      if (e.kind === 'frameTx' && e.from.device === 'pc1' && (e.pdu.tag ?? '').startsWith('ping#')) sent.set(e.pdu.id, hex(e.pdu.id));
      if (e.kind === 'frameRx' && e.device === 'pc2' && (e.pdu.tag ?? '').startsWith('ping#')) received.set(e.pdu.id, hex(e.pdu.id));
    });
    const p12 = ping(sim, 'pc1', '10.0.0.2');
    stop();
    expect(p12.text).toContain('Sent 5, received 5, lost 0');
    const requestIds = ofKind(p12.evs, 'pduCreated').filter((e) => e.device === 'pc1' && (e.pdu.tag ?? '').startsWith('ping#')).map((e) => e.pdu.id);
    expect(requestIds).toHaveLength(5);
    for (const id of requestIds) {
      expect(received.has(id), `echo request ${id} reached PC2 with PC1's PduId`).toBe(true);
      expect(received.get(id)).toBe(sent.get(id));
    }
    expect(ofKind(p12.evs, 'mutation').filter((m) => m.mutation.reason === 'VlanTagPush' || m.mutation.reason === 'VlanTagPop')).toEqual([]);
    // the CAM: PC1 in VLAN 10, PC3 (once it has spoken) in VLAN 1
    const cam = sim.device('sw1')!.tables.cam;
    expect(cam.get(camKey(10, macOf(sim, 'pc1')))).toMatchObject({ port: FA1, vlan: 10 });
    expect(camKey(10, macOf(sim, 'pc1'))).toBe(`10/${macOf(sim, 'pc1')}`);

    const p31 = ping(sim, 'pc3', '10.0.0.1');
    expect(p31.text).toContain('received 0, lost 5');
    const unresolved = ofKind(p31.evs, 'drop').filter((e) => e.device === 'pc3' && e.reason === 'arp-unresolved');
    expect(unresolved.length).toBeGreaterThan(0);
    // PC3's ARP flooded VLAN 1 only: it never reached PC1 or PC2
    expect(ofKind(p31.evs, 'frameRx').filter((e) => (e.device === 'pc1' || e.device === 'pc2') && e.pdu.proto === 'arp')).toEqual([]);
    expect(cam.get(camKey(1, macOf(sim, 'pc3')))).toMatchObject({ port: FA3, vlan: 1 });
    expect(camKey(1, macOf(sim, 'pc3'))).toBe(`1/${macOf(sim, 'pc3')}`);
    expect(cam.get(camKey(1, macOf(sim, 'pc1')))).toBeUndefined();
    expect(cam.get(camKey(10, macOf(sim, 'pc3')))).toBeUndefined();
    expect(ofKind(p31.evs, 'mutation').filter((m) => m.mutation.reason === 'VlanTagPush' || m.mutation.reason === 'VlanTagPop')).toEqual([]);
    // no provenance anywhere in this access-only world ever records a tag (every PDU since boot, BPDUs included)
    const all = sim.trace(0);
    expect(all.dropped).toBe(0);
    const ids = new Set(ofKind(all.events, 'pduCreated').map((e) => e.pdu.id));
    expect(ids.size).toBeGreaterThan(0);
    for (const id of ids) expect(sim.pdu(id)?.provenance.filter((m) => m.reason === 'VlanTagPush' || m.reason === 'VlanTagPop') ?? [], `pdu ${id}`).toEqual([]);
    expect(ofKind(all.events, 'mutation').filter((m) => m.mutation.reason === 'VlanTagPush' || m.mutation.reason === 'VlanTagPop')).toEqual([]);
  });

  it('a frame tagged 20 arriving on the access port Fa0/1 drops vlan-filtered with the §3.0 detail', () => {
    const sim = salesWorld();
    sim.runUntil(CONVERGED);
    const cursor = sim.trace(0).next;
    const pdu = taggedFrame('00:1f:00:00:00:20', 20, sim.now);
    sim.device('sw1')!.onFrameArrival(FA1, pdu, false, sim.now);
    const drops = ofKind(sim.trace(cursor).events, 'drop').filter((e) => e.pdu.id === pdu.id);
    expect(drops).toHaveLength(1);
    expect(drops[0]).toMatchObject({ device: 'sw1', port: FA1, reason: 'vlan-filtered', detail: taggedOnAccessDetail(20, 10) });
    expect(drops[0]!.detail).toBe('tagged frame for VLAN 20 on an access port (access VLAN 10)');
    expect(ofKind(sim.trace(cursor).events, 'frameTx').filter((e) => e.pdu.id === pdu.id)).toEqual([]);
  });

  it('after `no vlan 10` the ping fails: frames of the deleted VLAN drop vlan-filtered / VLAN 10 does not exist', () => {
    const sim = salesWorld();
    sim.runUntil(CONVERGED);
    expect(ping(sim, 'pc1', '10.0.0.2').text).toContain('Sent 5, received 5, lost 0');
    const r = sim.configure('sw1', ['no vlan 10']);
    expect(r.ok).toBe(true);
    expect(sim.device('sw1')!.tables.get('vlans')!.get('10')).toBeUndefined();
    sim.runFor(1 * SEC);
    const p = ping(sim, 'pc1', '10.0.0.2');
    expect(p.text).toContain('received 0, lost 5');
    const filtered = ofKind(p.evs, 'drop').filter((e) => e.device === 'sw1' && e.reason === 'vlan-filtered');
    expect(filtered.length).toBeGreaterThan(0);
    expect(filtered.every((e) => e.port === FA1 && e.detail === vlanMissingDetail(10))).toBe(true);
    expect(filtered[0]!.detail).toBe('VLAN 10 does not exist');
    expect(ofKind(p.evs, 'frameRx').filter((e) => e.device === 'pc2')).toEqual([]);
  });
});

describe('accept P2 vlan-access: access VLAN mismatch across a switch-to-switch link (P2 profile)', () => {
  it('SW1 Fa0/24 in VLAN 10 facing SW2 Fa0/24 in VLAN 20: the ping succeeds 5/5 after convergence and neither port is inconsistent', () => {
    const sim = createP2Simulation({ seed: 9, profile: 'P2', factories: L2 });
    const cfg = (name: string, vlan: number): string =>
      configText([
        [`hostname ${name}`],
        [`vlan ${vlan}`],
        section(`interface ${FA1}`, ['switchport mode access', `switchport access vlan ${vlan}`]),
        section(`interface ${FA24}`, ['switchport mode access', `switchport access vlan ${vlan}`]),
      ]);
    sim.addDevice({ id: 'sw1', type: SWITCH, name: 'SW1', startupConfig: cfg('SW1', 10) });
    sim.addDevice({ id: 'sw2', type: SWITCH, name: 'SW2', startupConfig: cfg('SW2', 20) });
    sim.addDevice({ id: 'pc1', type: PC, name: 'PC1', startupConfig: pcConfig('PC1', '10.0.0.1', '255.255.255.0') });
    sim.addDevice({ id: 'pc2', type: PC, name: 'PC2', startupConfig: pcConfig('PC2', '10.0.0.2', '255.255.255.0') });
    sim.addLink({ id: 'l_pc1', a: { device: 'pc1', port: 'GigabitEthernet0' }, b: { device: 'sw1', port: FA1 } });
    sim.addLink({ id: 'l_pc2', a: { device: 'pc2', port: 'GigabitEthernet0' }, b: { device: 'sw2', port: FA1 } });
    const trunk = sim.addLink({ id: 'l_sw', a: { device: 'sw1', port: FA24 }, b: { device: 'sw2', port: FA24 } });
    sim.runUntil(CONVERGED);
    const evs: TraceEvent[] = sim.trace(0).events;
    expect(ofKind(evs, 'linkState').find((e) => e.link === trunk && e.up)?.t).toBe(30 * SEC);
    const sw1 = sim.device('sw1')!.tables.get<StpPortRow>('stp')!.get(stpKey(10, FA24))!;
    const sw2 = sim.device('sw2')!.tables.get<StpPortRow>('stp')!.get(stpKey(20, FA24))!;
    expect(sw1.state).toBe('forwarding');
    expect(sw2.state).toBe('forwarding');
    expect(sw1.inconsistent).toBeUndefined();
    expect(sw2.inconsistent).toBeUndefined();
    expect(ping(sim, 'pc1', '10.0.0.2').text).toContain('Sent 5, received 5, lost 0');
    expect(sim.device('sw1')!.tables.get<StpPortRow>('stp')!.get(stpKey(10, FA24))!.inconsistent).toBeUndefined();
    expect(sim.device('sw2')!.tables.get<StpPortRow>('stp')!.get(stpKey(20, FA24))!.inconsistent).toBeUndefined();
    expect(ofKind(sim.trace(0).events, 'log').filter((e) => e.message.includes('inconsistent') || e.message.includes('mismatch'))).toEqual([]);
  });
});
