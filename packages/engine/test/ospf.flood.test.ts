/**
 * ospf.flood — flooding on a broadcast segment on `staged.world` (ARCHITECTURE-P3 D9, §3.1 step 6, §4.5, §13 T33;
 * RFC 2328 §13.3, §13.5; §7 W2 ospf): a router that is not DR — the BDR included — floods its own LSAs to AllDRouters
 * (224.0.0.6); the DR re-floods them to AllSPFRouters (224.0.0.5), which is the originator's implicit
 * acknowledgement, and floods its own LSAs to 224.0.0.5; the BDR re-floods nothing it received on the segment (it
 * only listens) and acknowledges directly; updates are bundled per interface in database order; every database ends
 * identical and no retransmission follows. The pure rules of protocols/ospf/flood.ts are pinned as well.
 */
import { describe, expect, it } from 'vitest';
import type { PduId } from '../src/contracts/ids.js';
import type { Simulation } from '../src/contracts/simulation.js';
import { SEC } from '../src/contracts/time.js';
import type { TraceEvent } from '../src/contracts/trace.js';
import { ackDirectly, directDestination, floodDestination, floodOut, type FloodIface } from '../src/protocols/ospf/flood.js';
import {
  addRouter,
  adminPort,
  cursor,
  debugLines,
  eventsSince,
  GI0,
  iface,
  lsdbRows,
  MS_NS,
  ospfCreated,
  ospfView,
  ospfWorld,
  portUpAt,
  startup,
} from './ospf.harness.js';

/** §3.1: SW1 (PortFast) with R1, R2, R3 on 10.0.123.0/24; R1 and R2 up at U, R3 at U + 65 s; run to idle. */
function segment(): { sim: Simulation; evs: TraceEvent[]; U: number; U3: number } {
  const sim = ospfWorld(21);
  sim.addDevice({
    id: 'sw1',
    type: 'switch.nfc2960',
    name: 'SW1',
    startupConfig: startup([['hostname SW1'], ...[1, 2, 3].map((k) => [`interface FastEthernet0/${k}`, ' spanning-tree portfast'])]),
  });
  for (const n of [1, 2, 3]) {
    addRouter(sim, `r${n}`, `R${n}`, [
      iface(GI0, `10.0.123.${n}`, '255.255.255.0', [], false),
      ['router ospf 1', ` router-id ${n}.${n}.${n}.${n}`, ' network 10.0.123.0 0.0.0.255 area 0'],
    ]);
    sim.addLink({ a: { device: `r${n}`, port: GI0 }, b: { device: 'sw1', port: `FastEthernet0/${n}` } });
  }
  sim.runFor(100 * SEC);
  const c = cursor(sim);
  adminPort(sim, 'r1', GI0, true);
  adminPort(sim, 'r2', GI0, true);
  sim.runFor(65 * SEC);
  adminPort(sim, 'r3', GI0, true);
  sim.runToIdle();
  const evs = eventsSince(sim, c);
  return { sim, evs, U: portUpAt(evs, 'r1', GI0)!, U3: portUpAt(evs, 'r3', GI0)! };
}

/** The `ospf-lsa` layers (type, link-state id, advertising router) of a created update. */
function lsasOf(sim: Simulation, pdu: PduId): string[] {
  return sim.pdu(pdu)!.layers.filter((l) => l.proto === 'ospf-lsa').map((l) => `${String(l.fields.lsType)}:${String(l.fields.lsid)}:${String(l.fields.advRouter)}`);
}

const flooded = (evs: readonly TraceEvent[], device: string, from: number, to: number) =>
  ospfCreated(evs, device).filter((p) => (p.kind === 'lsu' || p.kind === 'lsack') && p.t >= from && p.t < to);

describe('ospf.flood: a broadcast segment (§3.1 step 6)', () => {
  it('at Full: the BDR floods its own router-LSA to 224.0.0.6; the DR floods its own LSAs to 224.0.0.5 in one update, database order', () => {
    const { sim, evs, U } = segment();
    const full = U + 40 * SEC;
    const r1 = flooded(evs, 'r1', full, full + 50 * MS_NS).filter((p) => p.kind === 'lsu');
    const r2 = flooded(evs, 'r2', full, full + 50 * MS_NS).filter((p) => p.kind === 'lsu');
    // the LSR answers go unicast; the floods go to the groups
    const r1flood = r1.filter((p) => p.dst.startsWith('224.'));
    const r2flood = r2.filter((p) => p.dst.startsWith('224.'));
    expect(r1flood.map((p) => [p.dst, lsasOf(sim, p.pdu)])).toEqual([['224.0.0.6', ['1:1.1.1.1:1.1.1.1']]]);
    expect(r2flood.map((p) => [p.dst, lsasOf(sim, p.pdu)])).toEqual([['224.0.0.5', ['1:2.2.2.2:2.2.2.2', '2:10.0.123.2:2.2.2.2']]]);
    // with R1 as its only adjacency the DR has nobody to re-flood R1's LSA to: it acknowledges directly
    expect(flooded(evs, 'r2', full, full + 50 * MS_NS).filter((p) => p.kind === 'lsu' && p.dst === '224.0.0.5')).toHaveLength(1);
    expect(flooded(evs, 'r2', full, full + 50 * MS_NS).filter((p) => p.kind === 'lsack').map((p) => p.dst)).toEqual(['10.0.123.1', '10.0.123.1']);
    expect(debugLines(evs, 'r1', 'ip ospf flood').some((l) => l.message.startsWith('GigabitEthernet0/0: flooding update to 224.0.0.6: router LSA 1.1.1.1 from 1.1.1.1'))).toBe(true);
  });

  it('a DROther floods to 224.0.0.6; the DR re-floods to 224.0.0.5 (the implicit acknowledgement); the BDR re-floods nothing and acknowledges directly', () => {
    const { sim, evs, U3 } = segment();
    // R3's router-LSA with its transit link: MinLSInterval after its first origination at U3
    const from = U3 + 5 * SEC;
    const r3 = flooded(evs, 'r3', from, from + 50 * MS_NS);
    expect(r3.map((p) => [p.kind, p.dst, p.kind === 'lsu' ? lsasOf(sim, p.pdu) : []])).toEqual([['lsu', '224.0.0.6', ['1:3.3.3.3:3.3.3.3']]]);
    const t3 = r3[0]!.t;
    // the DR re-floods it to 224.0.0.5 within a millisecond
    const r2 = flooded(evs, 'r2', t3, t3 + 50 * MS_NS);
    expect(r2.map((p) => [p.kind, p.dst, p.kind === 'lsu' ? lsasOf(sim, p.pdu) : []])).toEqual([['lsu', '224.0.0.5', ['1:3.3.3.3:3.3.3.3']]]);
    expect(r2[0]!.t - t3).toBeLessThan(MS_NS);
    // the BDR: no update, only direct acknowledgements (to R3 for its LSU, to the DR for the re-flood)
    const r1 = flooded(evs, 'r1', t3, t3 + 50 * MS_NS);
    expect(r1.map((p) => [p.kind, p.dst])).toEqual([['lsack', '10.0.123.3'], ['lsack', '10.0.123.2']]);
    // R3 takes the DR's re-flood as its acknowledgement: it sends none and its retransmission lists are empty
    expect(flooded(evs, 'r3', t3 + 1, t3 + 50 * MS_NS)).toEqual([]);
    for (const d of ['r1', 'r2', 'r3']) expect(ospfView(sim, d).neighbors.map((n) => n.retransmitQueue)).toEqual([0, 0]);
    // no retransmission ever follows (the runs ended idle, with nothing left to send)
    expect(ospfCreated(evs).filter((p) => p.kind === 'lsu' && p.t > t3 + SEC)).toEqual([]);
  });

  it('every database ends identical: the same LSAs, sequence numbers and checksums on R1, R2 and R3', () => {
    const { sim } = segment();
    const db = (d: string) => lsdbRows(sim, d).map((r) => `${r.key}@${r.seq}/${r.checksum}`).sort();
    expect(db('r1')).toEqual(db('r2'));
    expect(db('r3')).toEqual(db('r2'));
    expect(db('r1').map((k) => k.slice(0, k.indexOf('@')))).toEqual([
      '0.0.0.0|1|1.1.1.1|1.1.1.1',
      '0.0.0.0|1|2.2.2.2|2.2.2.2',
      '0.0.0.0|1|3.3.3.3|3.3.3.3',
      '0.0.0.0|2|10.0.123.2|2.2.2.2',
    ]);
    // `self` marks the router's own LSAs only
    expect(lsdbRows(sim, 'r2').filter((r) => r.self).map((r) => r.key).sort()).toEqual(['0.0.0.0|1|2.2.2.2|2.2.2.2', '0.0.0.0|2|10.0.123.2|2.2.2.2']);
  });
});

describe('ospf.flood: the pure rules (protocols/ospf/flood.ts)', () => {
  const nbr = (routerId: string, address: string, state: 'full' | 'exchange' | '2way' = 'full') => ({ routerId, address, state });
  const lan = (state: FloodIface['state']): FloodIface => ({
    networkType: 'broadcast',
    state,
    dr: '10.0.0.2',
    bdr: '10.0.0.1',
    neighbors: state === 'drother' ? [nbr('1.1.1.1', '10.0.0.1'), nbr('2.2.2.2', '10.0.0.2'), nbr('4.4.4.4', '10.0.0.4', '2way')] : [nbr('1.1.1.1', '10.0.0.1'), nbr('3.3.3.3', '10.0.0.3'), nbr('4.4.4.4', '10.0.0.4')],
  });
  const inst = { seq: 0x80000002, checksum: 0x1234, age: 1 };

  it('destinations: point-to-point 224.0.0.5; on a LAN the DR floods to 224.0.0.5, every other router to 224.0.0.6', () => {
    expect(floodDestination('point-to-point', 'point-to-point')).toBe('224.0.0.5');
    expect(floodDestination('broadcast', 'dr')).toBe('224.0.0.5');
    expect(floodDestination('broadcast', 'backup')).toBe('224.0.0.6');
    expect(floodDestination('broadcast', 'drother')).toBe('224.0.0.6');
    expect(directDestination('broadcast', '10.0.0.7')).toBe('10.0.0.7');
    expect(directDestination('point-to-point', '10.0.0.7')).toBe('224.0.0.5');
  });

  it('own LSAs: from a DROther only the DR and the BDR must acknowledge; from the DR every adjacent neighbour', () => {
    expect(floodOut(lan('drother'), inst)).toEqual({ send: true, dst: '224.0.0.6', retransmitTo: ['1.1.1.1', '2.2.2.2'], settledRequests: [] });
    expect(floodOut({ ...lan('backup'), neighbors: [nbr('2.2.2.2', '10.0.0.2'), nbr('3.3.3.3', '10.0.0.3')] }, inst)).toEqual({
      send: true,
      dst: '224.0.0.6',
      retransmitTo: ['2.2.2.2'],
      settledRequests: [],
    });
    expect(floodOut(lan('dr'), inst)).toEqual({ send: true, dst: '224.0.0.5', retransmitTo: ['1.1.1.1', '3.3.3.3', '4.4.4.4'], settledRequests: [] });
  });

  it('received on the segment: the DR re-floods (skipping the sender), the BDR and DROthers never; a lone sender gets no re-flood', () => {
    expect(floodOut(lan('dr'), inst, '3.3.3.3')).toEqual({ send: true, dst: '224.0.0.5', retransmitTo: ['1.1.1.1', '4.4.4.4'], settledRequests: [] });
    expect(floodOut({ ...lan('backup'), neighbors: [nbr('2.2.2.2', '10.0.0.2'), nbr('3.3.3.3', '10.0.0.3')] }, inst, '3.3.3.3')).toEqual({ send: false, retransmitTo: [], settledRequests: [] });
    expect(floodOut({ ...lan('dr'), neighbors: [nbr('1.1.1.1', '10.0.0.1')] }, inst, '1.1.1.1')).toEqual({ send: false, retransmitTo: [], settledRequests: [] });
  });

  it('request lists: an equal or newer LSA settles an Exchange/Loading neighbour\'s request; an equal one needs no flooding to it', () => {
    const v = floodOut({ networkType: 'point-to-point', state: 'point-to-point', dr: '0.0.0.0', bdr: '0.0.0.0', neighbors: [{ ...nbr('2.2.2.2', '10.0.0.2', 'exchange'), requested: { ...inst } }] }, inst);
    expect(v).toEqual({ send: false, retransmitTo: [], settledRequests: ['2.2.2.2'] });
    const older = floodOut({ networkType: 'point-to-point', state: 'point-to-point', dr: '0.0.0.0', bdr: '0.0.0.0', neighbors: [{ ...nbr('2.2.2.2', '10.0.0.2', 'exchange'), requested: { ...inst, seq: 0x80000003 } }] }, inst);
    expect(older).toEqual({ send: false, retransmitTo: [], settledRequests: [] });
  });

  it('acknowledgements are direct and immediate except when implied (D9)', () => {
    expect(['newer-flooded-back', 'newer', 'duplicate-implied', 'duplicate', 'maxage-unknown'].map((c) => ackDirectly(c as Parameters<typeof ackDirectly>[0]))).toEqual([false, true, false, true, true]);
  });
});
