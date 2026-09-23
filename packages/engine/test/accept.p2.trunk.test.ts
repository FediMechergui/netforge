/**
 * P2 acceptance — a trunk with a native VLAN and an allowed list (ARCHITECTURE-P2 §3.2, D4, D8, §10.1 row
 * `accept.p2.trunk`), on real worlds of `test/p2.world.ts` with the vlan, dtp, etherchannel and stp daemons.
 *
 * §3.2: SW1 Gi0/1 ↔ SW2 Gi0/1, both `switchport mode trunk`, native 99, allowed 1,10,20,99; VLANs 10, 20, 99 on both.
 * PC1 (SW1 Fa0/1) and PC2 (SW2 Fa0/1) in VLAN 10; PC3 on SW2 Fa0/3 in VLAN 1; PC4 (SW1) and PC5 (SW2) in VLAN 99.
 *  • ping 5/5; the echo request's provenance is exactly VlanTagPush (SW1, `switchport mode trunk`) + FcsRecompute and
 *    VlanTagPop (SW2, `switchport access vlan 10`) + FcsRecompute; PC2's bytes equal PC1's; `PduSummary.vlan` = 10 on
 *    the trunk;
 *  • VLAN 99 (native) traffic crosses with no dot1q mutation;
 *  • a frame tagged 30 drops `vlan-filtered` / `VLAN 30 is not allowed on GigabitEthernet0/1`;
 *  • with `allowed vlan 10,20` on SW2, an untagged frame on Gi0/1 drops `vlan-filtered` / `native VLAN 99 is not
 *    allowed on GigabitEthernet0/1`;
 *  • native mismatch (SW2 native 1) in the P2 profile: both switches log the message, both Gi0/1 rows for VLANs 1 and
 *    99 are `inconsistent: 'pvid'`, and the inconsistency clears after SW2 is set back to native 99;
 *  • in the P1 profile (no spanning tree) the untagged VLAN 99 frames leak into VLAN 1: PC3 answers an ARP sent from
 *    the VLAN 99 host on SW1.
 */
import { describe, expect, it } from 'vitest';
import { MAC_BROADCAST, type MacAddress } from '../src/contracts/addr.js';
import type { PortId } from '../src/contracts/ids.js';
import { ARP_OP_REQUEST, ETHERTYPE_ARP, ETHERTYPE_VLAN, type Pdu } from '../src/contracts/pdu.js';
import type { Simulation } from '../src/contracts/simulation.js';
import { stpKey, type StpPortRow } from '../src/contracts/tables.js';
import { SEC } from '../src/contracts/time.js';
import { createPduFactory } from '../src/pdu/factory.js';
import { createDtp } from '../src/protocols/dtp.js';
import { createEtherchannel } from '../src/protocols/etherchannel.js';
import { nativeNotAllowedDetail, vlanNotAllowedDetail } from '../src/protocols/l2/membership.js';
import { createStp } from '../src/protocols/stp.js';
import { nativeMismatchMessage } from '../src/protocols/stp/guards.js';
import { createVlan } from '../src/protocols/vlan.js';
import { configText, section } from '../src/sim/scenarios/kit.js';
import { pcConfig } from '../src/sim/scenarios/templates.js';
import { createP2Simulation, type P2FactoryOverlay } from './p2.world.js';
import { ofKind, ping } from './sim.harness.js';

const L2: P2FactoryOverlay = { vlan: createVlan, dtp: createDtp, etherchannel: createEtherchannel, stp: createStp };
const SWITCH = 'switch.nfc2960';
const PC = 'pc.nfpc';
const GI1: PortId = 'GigabitEthernet0/1';
const FA1: PortId = 'FastEthernet0/1';
const FA3: PortId = 'FastEthernet0/3';
const FA4: PortId = 'FastEthernet0/4';
/** Switches boot at 30 s; trunk and access ports forward 30 s later. */
const CONVERGED = 70 * SEC;

interface TrunkOptions {
  readonly seed?: number;
  readonly profile?: 'P1' | 'P2';
  /** SW2's native VLAN (default 99; 1 = the §3.2 step 6 mismatch). */
  readonly sw2Native?: number;
}

/** The §3.2 world. Trace and link ids: `l_trunk`, `l_pc1` … `l_pc5`. */
function trunkWorld(o: TrunkOptions = {}): Simulation {
  const sim = createP2Simulation({ seed: o.seed ?? 7, profile: o.profile ?? 'P2', factories: L2 });
  const trunk = (native: number): string[] => section(`interface ${GI1}`, ['switchport mode trunk', `switchport trunk native vlan ${native}`, 'switchport trunk allowed vlan 1,10,20,99']);
  const access = (port: PortId, vlan: number): string[] => section(`interface ${port}`, ['switchport mode access', `switchport access vlan ${vlan}`]);
  sim.addDevice({
    id: 'sw1', type: SWITCH, name: 'SW1',
    startupConfig: configText([['hostname SW1'], ['vlan 10'], ['vlan 20'], ['vlan 99'], trunk(99), access(FA1, 10), access(FA4, 99)]),
  });
  sim.addDevice({
    id: 'sw2', type: SWITCH, name: 'SW2',
    startupConfig: configText([['hostname SW2'], ['vlan 10'], ['vlan 20'], ['vlan 99'], trunk(o.sw2Native ?? 99), access(FA1, 10), access(FA4, 99)]),
  });
  const pcs: readonly [id: string, sw: string, port: PortId, address: string][] = [
    ['pc1', 'sw1', FA1, '10.0.10.1'],
    ['pc2', 'sw2', FA1, '10.0.10.2'],
    ['pc3', 'sw2', FA3, '10.0.99.3'],
    ['pc4', 'sw1', FA4, '10.0.99.1'],
    ['pc5', 'sw2', FA4, '10.0.99.2'],
  ];
  for (const [id, sw, port, address] of pcs) {
    sim.addDevice({ id, type: PC, name: id.toUpperCase(), startupConfig: pcConfig(id.toUpperCase(), address, '255.255.255.0') });
    sim.addLink({ id: `l_${id}`, a: { device: id, port: 'GigabitEthernet0' }, b: { device: sw, port } });
  }
  sim.addLink({ id: 'l_trunk', a: { device: 'sw1', port: GI1 }, b: { device: 'sw2', port: GI1 } });
  return sim;
}

/** An ARP request tagged `vid` (a test-only PDU factory; the id never collides with the world's). */
function taggedFrame(src: MacAddress, vid: number, now: number): Pdu {
  return createPduFactory({ firstId: 900_000 }).build(
    [
      { proto: 'ethernet', fields: { dst: MAC_BROADCAST, src, type: ETHERTYPE_VLAN } },
      { proto: 'dot1q', fields: { vid, type: ETHERTYPE_ARP } },
      { proto: 'arp', fields: { op: ARP_OP_REQUEST, sha: src, spa: '10.0.30.1', tha: '00:00:00:00:00:00', tpa: '10.0.30.2' } },
    ],
    { born: now, origin: 'd_test' },
  );
}

const hexOf = (sim: Simulation, id: number): string => Array.from(sim.pdu(id)!.bytes, (b) => b.toString(16).padStart(2, '0')).join('');
const stpRow = (sim: Simulation, dev: string, vlan: number, port: PortId): StpPortRow | undefined => sim.device(dev)!.tables.get<StpPortRow>('stp')!.get(stpKey(vlan, port));
const logsOf = (sim: Simulation, dev: string): string[] => ofKind(sim.trace(0).events, 'log').filter((e) => e.device === dev).map((e) => e.message);

describe('accept P2 trunk: §3.2 steps 1–5', () => {
  it('PC1→PC2 5/5 with exactly one push at SW1 and one pop at SW2, each followed by an FCS recompute; PC2 receives PC1 bytes', () => {
    const sim = trunkWorld();
    sim.runUntil(CONVERGED);
    for (const dev of ['sw1', 'sw2']) {
      expect(sim.device(dev)!.tables.get('dtp')!.get(GI1)).toMatchObject({ admin: 'trunk', oper: 'trunk', status: 'static' });
      for (const vlan of [1, 10, 20, 99]) expect(stpRow(sim, dev, vlan, GI1)?.state, `${dev} VLAN ${vlan}`).toBe('forwarding');
    }
    const sent = new Map<number, string>();
    const received = new Map<number, string>();
    const stop = sim.onTrace((e) => {
      if (e.kind === 'frameTx' && e.from.device === 'pc1' && (e.pdu.tag ?? '').startsWith('ping#')) sent.set(e.pdu.id, hexOf(sim, e.pdu.id));
      if (e.kind === 'frameRx' && e.device === 'pc2' && (e.pdu.tag ?? '').startsWith('ping#')) received.set(e.pdu.id, hexOf(sim, e.pdu.id));
    });
    const p = ping(sim, 'pc1', '10.0.10.2');
    stop();
    expect(p.text).toContain('Sent 5, received 5, lost 0');
    const requests = ofKind(p.evs, 'pduCreated').filter((e) => e.device === 'pc1' && (e.pdu.tag ?? '').startsWith('ping#'));
    expect(requests).toHaveLength(5);
    for (const req of requests) {
      const id = req.pdu.id;
      const prov = sim.pdu(id)!.provenance;
      // PC1's own framing (Encapsulate) precedes the switches' work; nothing else touched the frame
      expect(prov.map((m) => `${m.reason}@${m.device}`)).toEqual(['Encapsulate@pc1', 'VlanTagPush@sw1', 'FcsRecompute@sw1', 'VlanTagPop@sw2', 'FcsRecompute@sw2']);
      const pushes = prov.filter((m) => m.reason === 'VlanTagPush');
      const pops = prov.filter((m) => m.reason === 'VlanTagPop');
      expect(pushes).toHaveLength(1);
      expect(pops).toHaveLength(1);
      expect(pushes[0]).toMatchObject({ device: 'sw1', field: 'dot1q.vid', before: null, after: 10, cause: 'switchport mode trunk' });
      expect(pops[0]).toMatchObject({ device: 'sw2', field: 'dot1q.vid', before: 10, after: null, cause: 'switchport access vlan 10' });
      expect(prov[prov.indexOf(pushes[0]!) + 1]).toMatchObject({ device: 'sw1', reason: 'FcsRecompute', field: 'ethernet.fcs' });
      expect(prov[prov.indexOf(pops[0]!) + 1]).toMatchObject({ device: 'sw2', reason: 'FcsRecompute', field: 'ethernet.fcs' });
      expect(received.get(id), `echo request ${id} at PC2`).toBe(sent.get(id));
      // on the wire between the switches the frame is tagged 10 and 4 bytes longer; the trace says so
      const onTrunk = ofKind(p.evs, 'frameTx').filter((e) => e.pdu.id === id && e.link === 'l_trunk');
      const fromPc1 = ofKind(p.evs, 'frameTx').filter((e) => e.pdu.id === id && e.from.device === 'pc1');
      expect(onTrunk).toHaveLength(1);
      expect(fromPc1).toHaveLength(1);
      expect(onTrunk[0]!.pdu.vlan).toBe(10);
      expect(fromPc1[0]!.pdu.vlan).toBeUndefined();
      expect(onTrunk[0]!.pdu.size).toBe(fromPc1[0]!.pdu.size + 4);
      const mutations = ofKind(p.evs, 'mutation').filter((m) => m.pdu === id).map((m) => `${m.mutation.reason}@${m.mutation.device}`);
      expect(mutations).toEqual(['Encapsulate@pc1', 'VlanTagPush@sw1', 'FcsRecompute@sw1', 'VlanTagPop@sw2', 'FcsRecompute@sw2']);
    }
  });

  it('VLAN 99 traffic crosses the trunk untagged in both directions: no dot1q mutation at all', () => {
    const sim = trunkWorld();
    sim.runUntil(CONVERGED);
    const p = ping(sim, 'pc4', '10.0.99.2');
    expect(p.text).toContain('Sent 5, received 5, lost 0');
    expect(ofKind(p.evs, 'mutation').filter((m) => m.mutation.reason === 'VlanTagPush' || m.mutation.reason === 'VlanTagPop')).toEqual([]);
    const onTrunk = ofKind(p.evs, 'frameTx').filter((e) => e.link === 'l_trunk' && e.pdu.tag !== 'bpdu');
    expect(onTrunk.length).toBeGreaterThan(0);
    expect(onTrunk.every((e) => e.pdu.vlan === undefined && !(e.pdu.layers ?? []).includes('dot1q'))).toBe(true);
  });

  it('a frame tagged 30 arriving on the trunk drops vlan-filtered: VLAN 30 is not allowed on GigabitEthernet0/1', () => {
    const sim = trunkWorld();
    sim.runUntil(CONVERGED);
    const cursor = sim.trace(0).next;
    const pdu = taggedFrame(sim.device('sw1')!.port(GI1)!.mac, 30, sim.now);
    sim.device('sw2')!.onFrameArrival(GI1, pdu, false, sim.now);
    const drops = ofKind(sim.trace(cursor).events, 'drop').filter((e) => e.pdu.id === pdu.id);
    expect(drops).toHaveLength(1);
    expect(drops[0]).toMatchObject({ device: 'sw2', port: GI1, reason: 'vlan-filtered', detail: vlanNotAllowedDetail(30, GI1) });
    expect(drops[0]!.detail).toBe('VLAN 30 is not allowed on GigabitEthernet0/1');
    // and SW1 never offers the trunk to a VLAN 30 frame: a VLAN 30 host's broadcast has no candidate
    expect(sim.configure('sw1', ['vlan 30', `interface ${FA3}`, 'switchport mode access', 'switchport access vlan 30']).ok).toBe(true);
    sim.addDevice({ id: 'pc6', type: PC, name: 'PC6', startupConfig: pcConfig('PC6', '10.0.30.1', '255.255.255.0') });
    sim.addLink({ id: 'l_pc6', a: { device: 'pc6', port: 'GigabitEthernet0' }, b: { device: 'sw1', port: FA3 } });
    sim.runFor(35 * SEC);
    const p = ping(sim, 'pc6', '10.0.30.2');
    expect(ofKind(p.evs, 'frameTx').filter((e) => e.link === 'l_trunk' && e.pdu.proto === 'arp')).toEqual([]);
  });

  it('with `switchport trunk allowed vlan 10,20` on SW2, an untagged frame on Gi0/1 drops with the native-VLAN detail', () => {
    const sim = trunkWorld();
    sim.runUntil(CONVERGED);
    expect(sim.configure('sw2', [`interface ${GI1}`, 'switchport trunk allowed vlan 10,20']).ok).toBe(true);
    expect(sim.device('sw2')!.running.render()).toContain('switchport trunk allowed vlan 10,20');
    sim.runFor(1 * SEC);
    const p = ping(sim, 'pc4', '10.0.99.2');
    expect(p.text).toContain('received 0, lost 5');
    // PC4's ARP requests arrive untagged (native 99 at SW1) and are refused at SW2; the VLAN-1 BPDUs SW1 still
    // sends tagged 1 are refused by the same rule with their own detail (VLAN 1 is not allowed), as background
    const arpDrops = ofKind(p.evs, 'drop').filter((e) => e.device === 'sw2' && e.reason === 'vlan-filtered' && e.pdu.proto === 'arp');
    expect(arpDrops.length).toBeGreaterThan(0);
    expect(arpDrops.every((e) => e.port === GI1 && e.detail === nativeNotAllowedDetail(99, GI1))).toBe(true);
    expect(arpDrops[0]!.detail).toBe('native VLAN 99 is not allowed on GigabitEthernet0/1');
    // (SW1's VLAN 99 BPDUs arrive untagged too, its VLAN 1 BPDUs tagged 1: both refused as background)
    const otherDrops = ofKind(p.evs, 'drop').filter((e) => e.device === 'sw2' && e.reason === 'vlan-filtered' && e.pdu.proto !== 'arp');
    expect(otherDrops.every((e) => e.pdu.tag === 'bpdu' && e.background === true && (e.detail === vlanNotAllowedDetail(1, GI1) || e.detail === nativeNotAllowedDetail(99, GI1)))).toBe(true);
    expect(ofKind(p.evs, 'frameRx').filter((e) => e.device === 'pc5' && e.pdu.tag !== 'bpdu')).toEqual([]);
    // VLAN 10 still crosses
    expect(ping(sim, 'pc1', '10.0.10.2').text).toContain('Sent 5, received 5, lost 0');
  });
});

describe('accept P2 trunk: native VLAN mismatch (§3.2 step 6)', () => {
  it('P2 profile: both ends log the mismatch, block VLANs 1 and 99 pvid-inconsistent, and clear once the native VLANs agree', () => {
    const sim = trunkWorld({ sw2Native: 1 });
    sim.runUntil(40 * SEC);
    for (const [dev, own, other] of [['sw1', 99, 1], ['sw2', 1, 99]] as const) {
      for (const vlan of [1, 99]) {
        expect(stpRow(sim, dev, vlan, GI1)?.inconsistent, `${dev} VLAN ${vlan}`).toBe('pvid');
        expect(stpRow(sim, dev, vlan, GI1)?.state, `${dev} VLAN ${vlan}`).toBe('blocking');
      }
      expect(stpRow(sim, dev, 10, GI1)?.inconsistent).toBeUndefined();
      expect(logsOf(sim, dev).filter((m) => m.startsWith('Native VLAN mismatch'))).toEqual([nativeMismatchMessage(GI1, own, other, [1, 99])]);
    }
    expect(nativeMismatchMessage(GI1, 99, 1, [1, 99])).toBe('Native VLAN mismatch on GigabitEthernet0/1: this switch sends VLAN 99 untagged, the neighbour sends VLAN 1. VLANs 1 and 99 are blocked on this port.');
    const T = sim.now;
    expect(sim.configure('sw2', [`interface ${GI1}`, 'switchport trunk native vlan 99']).ok).toBe(true);
    sim.runUntil(T + 25 * SEC);
    for (const dev of ['sw1', 'sw2']) {
      for (const vlan of [1, 99]) {
        expect(stpRow(sim, dev, vlan, GI1)?.inconsistent, `${dev} VLAN ${vlan}`).toBeUndefined();
        expect(stpRow(sim, dev, vlan, GI1)?.state, `${dev} VLAN ${vlan}`).not.toBe('blocking');
      }
    }
    sim.runUntil(T + 60 * SEC);
    expect(ping(sim, 'pc4', '10.0.99.2').text).toContain('Sent 5, received 5, lost 0');
  });

  it('P1 profile (no spanning tree): PC3 in VLAN 1 on SW2 answers an ARP sent from the VLAN 99 host on SW1', () => {
    const sim = trunkWorld({ profile: 'P1', sw2Native: 1 });
    sim.runUntil(35 * SEC);
    expect(sim.device('sw1')!.tables.get('stp-bridge')!.size).toBe(0);
    const p = ping(sim, 'pc4', '10.0.99.3');
    const request = ofKind(p.evs, 'pduCreated').find((e) => e.device === 'pc4' && e.pdu.tag === 'arp-request')!;
    expect(request).toBeDefined();
    // the request crossed the trunk untagged and was classified into VLAN 1 at SW2 (native 1): it reached PC3
    const atPc3 = ofKind(p.evs, 'frameRx').filter((e) => e.device === 'pc3' && e.pdu.id === request.pdu.id);
    expect(atPc3).toHaveLength(1);
    const reply = ofKind(p.evs, 'pduCreated').filter((e) => e.device === 'pc3' && e.pdu.tag === 'arp-reply');
    expect(reply).toHaveLength(1);
    expect(ofKind(p.evs, 'frameRx').filter((e) => e.device === 'pc4' && e.pdu.id === reply[0]!.pdu.id)).toHaveLength(1);
    expect(p.text).toContain('Sent 5, received 5, lost 0');
    expect(ofKind(p.evs, 'mutation').filter((m) => m.mutation.reason === 'VlanTagPush' || m.mutation.reason === 'VlanTagPop')).toEqual([]);
  });
});
