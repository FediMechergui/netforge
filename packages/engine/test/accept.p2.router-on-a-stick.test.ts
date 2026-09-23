/**
 * P2 acceptance — router-on-a-stick (ARCHITECTURE-P2 §3.4, D11, §3.0 step 10a, §10.1 row `accept.p2.router-on-a-stick`),
 * on a real P2-profile world of `test/p2.world.ts` (vlan, dtp, etherchannel and stp daemons; the P2-stage NF-2911
 * declares subinterfaces).
 *
 * R1 Gi0/0 ↔ SW1 Gi0/1 (trunk, native 99). R1: Gi0/0.10 (VLAN 10, 192.168.10.1), Gi0/0.20 (VLAN 20, 192.168.20.1),
 * Gi0/0.99 (native, 192.168.99.1). PC1 (VLAN 10), PC2 (VLAN 20), PC3 (VLAN 99) and PC4 (VLAN 30, which no
 * subinterface carries) on SW1 access ports.
 *  • PC1→PC2 5/5; the echo request's mutation events are exactly the sequence the W1 `pdu.vlan.test.ts` derivation
 *    produced from real calls (push at SW1; pop, TTL, checksum, MAC rewrites src then dst, push at R1; pop at SW1),
 *    with causes `encapsulation dot1Q 10` / `encapsulation dot1Q 20` at R1, one PduId throughout;
 *  • native VLAN 99 frames cross untagged (no dot1q mutation) and land on Gi0/0.99;
 *  • `shutdown` on Gi0/0 takes every subinterface down with reason `parent-down`, withdraws their connected routes,
 *    and the ping fails;
 *  • a frame tagged 30 drops `encapsulation-mismatch` at R1 with the §3.0 detail.
 */
import { describe, expect, it } from 'vitest';
import type { PortId } from '../src/contracts/ids.js';
import type { Simulation } from '../src/contracts/simulation.js';
import { SEC } from '../src/contracts/time.js';
import { createDtp } from '../src/protocols/dtp.js';
import { createEtherchannel } from '../src/protocols/etherchannel.js';
import { createStp } from '../src/protocols/stp.js';
import { createVlan } from '../src/protocols/vlan.js';
import { configText, section } from '../src/sim/scenarios/kit.js';
import { pcConfig } from '../src/sim/scenarios/templates.js';
import { createP2Simulation, type P2FactoryOverlay } from './p2.world.js';
import { ofKind, ping } from './sim.harness.js';

const L2: P2FactoryOverlay = { vlan: createVlan, dtp: createDtp, etherchannel: createEtherchannel, stp: createStp };
const GI00: PortId = 'GigabitEthernet0/0';
const SUB10: PortId = 'GigabitEthernet0/0.10';
const SUB20: PortId = 'GigabitEthernet0/0.20';
const SUB99: PortId = 'GigabitEthernet0/0.99';
const GI1: PortId = 'GigabitEthernet0/1';
/** SW1 boots at 30 s, R1 at 45 s (its trunk port forwards at 75 s). */
const CONVERGED = 80 * SEC;

/** The §3.4 world (with the `.99` subinterface addressed so native traffic can be observed). */
function stickWorld(seed = 7): Simulation {
  const sim = createP2Simulation({ seed, profile: 'P2', factories: L2 });
  sim.addDevice({
    id: 'r1', type: 'router.nf2911', name: 'R1',
    startupConfig: configText([
      ['hostname R1'],
      section(`interface ${GI00}`, ['no shutdown']),
      section(`interface ${SUB10}`, ['encapsulation dot1Q 10', 'ip address 192.168.10.1 255.255.255.0']),
      section(`interface ${SUB20}`, ['encapsulation dot1Q 20', 'ip address 192.168.20.1 255.255.255.0']),
      section(`interface ${SUB99}`, ['encapsulation dot1Q 99 native', 'ip address 192.168.99.1 255.255.255.0']),
    ]),
  });
  const access = (port: string, vlan: number): string[] => section(`interface ${port}`, ['switchport mode access', `switchport access vlan ${vlan}`]);
  sim.addDevice({
    id: 'sw1', type: 'switch.nfc2960', name: 'SW1',
    startupConfig: configText([
      ['hostname SW1'], ['vlan 10'], ['vlan 20'], ['vlan 30'], ['vlan 99'],
      section(`interface ${GI1}`, ['switchport mode trunk', 'switchport trunk native vlan 99']),
      access('FastEthernet0/1', 10), access('FastEthernet0/2', 20), access('FastEthernet0/3', 99), access('FastEthernet0/4', 30),
    ]),
  });
  const pcs: readonly [id: string, port: string, address: string, gateway: string][] = [
    ['pc1', 'FastEthernet0/1', '192.168.10.10', '192.168.10.1'],
    ['pc2', 'FastEthernet0/2', '192.168.20.10', '192.168.20.1'],
    ['pc3', 'FastEthernet0/3', '192.168.99.10', '192.168.99.1'],
    ['pc4', 'FastEthernet0/4', '192.168.30.10', '192.168.30.1'],
  ];
  for (const [id, port, address, gateway] of pcs) {
    sim.addDevice({ id, type: 'pc.nfpc', name: id.toUpperCase(), startupConfig: pcConfig(id.toUpperCase(), address, '255.255.255.0', gateway) });
    sim.addLink({ id: `l_${id}`, a: { device: id, port: 'GigabitEthernet0' }, b: { device: 'sw1', port } });
  }
  sim.addLink({ id: 'l_trunk', a: { device: 'r1', port: GI00 }, b: { device: 'sw1', port: GI1 } });
  return sim;
}

/** The connected routes of R1 as `network/prefix via iface`. */
function connectedRoutes(sim: Simulation): string[] {
  return sim.device('r1')!.tables.rib.rows().filter((r) => r.source === 'C').map((r) => `${r.network}/${r.prefixLen} via ${r.iface ?? '?'}`).sort();
}

describe('accept P2 router-on-a-stick: §3.4', () => {
  it('PC1→PC2 5/5 with exactly the derived mutation sequence, one PduId end to end, causes encapsulation dot1Q 10 / 20 at R1', () => {
    const sim = stickWorld();
    sim.runUntil(CONVERGED);
    for (const sub of [SUB10, SUB20, SUB99]) expect(sim.device('r1')!.port(sub)?.operUp, sub).toBe(true);
    expect(connectedRoutes(sim)).toEqual([`192.168.10.0/24 via ${SUB10}`, `192.168.20.0/24 via ${SUB20}`, `192.168.99.0/24 via ${SUB99}`]);
    const p = ping(sim, 'pc1', '192.168.20.10');
    expect(p.text).toContain('Sent 5, received 5, lost 0');
    const requests = ofKind(p.evs, 'pduCreated').filter((e) => e.device === 'pc1' && (e.pdu.tag ?? '').startsWith('ping#'));
    expect(requests).toHaveLength(5);
    for (const req of requests) {
      const id = req.pdu.id;
      const all = ofKind(p.evs, 'mutation').filter((m) => m.pdu === id);
      // PC1's own framing is mirrored first; everything after it is the §3.4 step 4 sequence as derived in W1
      expect(all[0]!.mutation).toMatchObject({ device: 'pc1', reason: 'Encapsulate', field: 'ethernet' });
      const events = all.slice(1);
      expect(events.map((m) => `${m.mutation.reason}:${m.mutation.field}@${m.mutation.device}`)).toEqual([
        'VlanTagPush:dot1q.vid@sw1', 'FcsRecompute:ethernet.fcs@sw1',
        'VlanTagPop:dot1q.vid@r1', 'FcsRecompute:ethernet.fcs@r1',
        'TtlDecrement:ipv4.ttl@r1', 'ChecksumRecompute:ipv4.checksum@r1', 'FcsRecompute:ethernet.fcs@r1',
        'MacRewrite:ethernet.src@r1', 'FcsRecompute:ethernet.fcs@r1',
        'MacRewrite:ethernet.dst@r1', 'FcsRecompute:ethernet.fcs@r1',
        'VlanTagPush:dot1q.vid@r1', 'FcsRecompute:ethernet.fcs@r1',
        'VlanTagPop:dot1q.vid@sw1', 'FcsRecompute:ethernet.fcs@sw1',
      ]);
      const causes = events.map((m) => m.mutation.cause);
      expect(causes[0]).toBe('switchport mode trunk');
      expect(causes[2]).toBe('encapsulation dot1Q 10');
      expect(causes[11]).toBe('encapsulation dot1Q 20');
      expect(causes[13]).toBe('switchport access vlan 20');
      expect(events[2]!.mutation).toMatchObject({ before: 10, after: null });
      expect(events[11]!.mutation).toMatchObject({ before: null, after: 20 });
      expect(events[4]!.mutation).toMatchObject({ before: 128, after: 127 });
      // the same PduId reached PC2, popped back to a plain frame
      expect(ofKind(p.evs, 'frameRx').filter((e) => e.device === 'pc2' && e.pdu.id === id)).toHaveLength(1);
      const view = sim.pdu(id)!;
      expect(view.layers.map((l) => l.proto)).toEqual(['ethernet', 'ipv4', 'icmpv4', 'payload']);
      expect(view.get('ipv4.ttl')).toBe(127);
      expect(view.get('ethernet.src')).toBe(sim.device('r1')!.port(GI00)!.mac);
      expect(view.get('ethernet.dst')).toBe(sim.device('pc2')!.port('GigabitEthernet0')!.mac);
      expect(view.provenance.map((m) => `${m.reason}@${m.device}`).slice(1)).toEqual(events.map((m) => `${m.mutation.reason}@${m.mutation.device}`));
      expect(view.provenance[0]).toMatchObject({ device: 'pc1', reason: 'Encapsulate' });
    }
  });

  it('native VLAN 99 frames cross untagged to Gi0/0.99 and back', () => {
    const sim = stickWorld();
    sim.runUntil(CONVERGED);
    const before = sim.device('r1')!.port(SUB99)!.counters.inPackets;
    const p = ping(sim, 'pc3', '192.168.99.1');
    expect(p.text).toContain('Sent 5, received 5, lost 0');
    // the ping's own frames (PC3's requests and ARP, R1's replies): none was ever tagged. (SW1's per-VLAN BPDUs
    // tagged 10 and 20 keep crossing and are popped into the subinterfaces before R1 refuses them.)
    const mine = new Set(ofKind(p.evs, 'pduCreated').filter((e) => e.device === 'pc3' || e.device === 'r1').map((e) => e.pdu.id));
    expect(mine.size).toBeGreaterThanOrEqual(10);
    expect(ofKind(p.evs, 'mutation').filter((m) => mine.has(m.pdu) && (m.mutation.reason === 'VlanTagPush' || m.mutation.reason === 'VlanTagPop'))).toEqual([]);
    const onTrunk = ofKind(p.evs, 'frameTx').filter((e) => e.link === 'l_trunk' && mine.has(e.pdu.id));
    expect(onTrunk.length).toBeGreaterThanOrEqual(10);
    expect(onTrunk.every((e) => e.pdu.vlan === undefined)).toBe(true);
    expect(sim.device('r1')!.port(SUB99)!.counters.inPackets).toBeGreaterThan(before);
    expect(ofKind(p.evs, 'pduCreated').filter((e) => e.device === 'r1' && e.pdu.tag === 'echo-reply')).toHaveLength(5);
  });

  it('shutdown on Gi0/0 takes both subinterfaces down (parent-down), withdraws their C routes, and the ping fails', () => {
    const sim = stickWorld();
    sim.runUntil(CONVERGED);
    expect(ping(sim, 'pc1', '192.168.20.10').text).toContain('Sent 5, received 5, lost 0');
    const cursor = sim.trace(0).next;
    expect(sim.configure('r1', [`interface ${GI00}`, 'shutdown']).ok).toBe(true);
    sim.runFor(1 * SEC);
    const down = ofKind(sim.trace(cursor).events, 'portState').filter((e) => e.device === 'r1' && !e.operUp);
    for (const sub of [SUB10, SUB20, SUB99]) {
      expect(down.find((e) => e.port === sub)?.reason, sub).toBe('parent-down');
      expect(sim.device('r1')!.port(sub)?.operUp, sub).toBe(false);
      expect(sim.device('r1')!.port(sub)?.adminUp, sub).toBe(true);
    }
    expect(connectedRoutes(sim)).toEqual([]);
    const p = ping(sim, 'pc1', '192.168.20.10');
    expect(p.text).toContain('received 0, lost 5');
    expect(ofKind(p.evs, 'frameRx').filter((e) => e.device === 'r1')).toEqual([]);
    // no shutdown brings everything back
    expect(sim.configure('r1', [`interface ${GI00}`, 'no shutdown']).ok).toBe(true);
    sim.runFor(35 * SEC);
    expect(connectedRoutes(sim)).toHaveLength(3);
    expect(ping(sim, 'pc1', '192.168.20.10').text).toContain('Sent 5, received 5, lost 0');
  });

  it('a frame tagged 30 drops encapsulation-mismatch at R1: no subinterface carries it', () => {
    const sim = stickWorld();
    sim.runUntil(CONVERGED);
    const p = ping(sim, 'pc4', '192.168.30.1');
    expect(p.text).toContain('received 0, lost 5');
    // PC4's ARP requests (tagged 30 by SW1's trunk) are refused; so are SW1's VLAN 1 and VLAN 30 BPDUs (background)
    const drops = ofKind(p.evs, 'drop').filter((e) => e.device === 'r1' && e.reason === 'encapsulation-mismatch' && e.pdu.proto === 'arp');
    expect(drops.length).toBeGreaterThan(0);
    expect(drops.every((e) => e.port === GI00 && e.detail === 'tagged frame for VLAN 30; no subinterface carries it' && e.pdu.vlan === 30)).toBe(true);
    const others = ofKind(p.evs, 'drop').filter((e) => e.device === 'r1' && e.reason === 'encapsulation-mismatch' && e.pdu.proto !== 'arp');
    expect(others.every((e) => e.pdu.tag === 'bpdu' && e.background === true)).toBe(true);
    expect(ofKind(p.evs, 'pduCreated').filter((e) => e.device === 'r1')).toEqual([]);
  });
});
