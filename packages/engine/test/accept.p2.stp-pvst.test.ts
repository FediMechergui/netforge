/**
 * P2 acceptance — PVST+ on the §3.6 triangle (ARCHITECTURE-P2 §3.6 "PVST+", §4.2, §10.1 row `accept.p2.stp-pvst`),
 * on real P2-profile worlds of `test/p2.world.ts` (the W3 `stp.harness` triangle: SW1–SW2, SW1–SW3, SW2–SW3 at 1 Gb,
 * SW1 priority 4096, one PC per switch; every switch boots at 30 s and every link comes up at 30 s).
 *
 *  • SW1 is the root; exactly one alternate/blocking port, on the SW2–SW3 link at the switch with the higher bridge
 *    id; every root and designated port reaches forwarding with `stateSince − linkUp ∈ [30 s, 30 s + 10 ms]`; a PC
 *    broadcast reaches each other PC exactly once.
 *  • Direct failure (the alternate holder's root link cut at T): its former alternate forwards at T + 30 s ± 10 ms.
 *  • Indirect failure (the designated end's root link cut at T): the former alternate forwards in [T + 47 s, T + 50 s].
 *  • On each failure `stp-bridge.topologyChanges` increases and the root's TC window starts before T + 1 s.
 *  • The first TCN (the §10.1 row as amended by the architect's ruling of 2026-09-23): on the DIRECT failure the bridge
 *    that lost its root port has an alternate to promote, so its first TCN leaves at T, on the promoted port. On the
 *    INDIRECT failure no bridge can send one at T — the root signals with the TC flag and never sends a TCN, and the
 *    designated end of the cut has lost its only root port and claims the root role (§3.6 steps 5 and 7), while the
 *    alternate holder detects nothing until max age expires — so no TCN leaves any bridge before the former
 *    alternate holder converges, and its first one leaves on its root port when its former alternate enters
 *    forwarding, in [T + 47 s, T + 50 s]. (The row's earlier wording, "the first TCN is sent at T", described only the
 *    direct case and is superseded.)
 */
import { describe, expect, it } from 'vitest';
import { MS, SEC } from '../src/contracts/time.js';
import type { TraceEvent } from '../src/contracts/trace.js';
import { ping } from './sim.harness.js';
import { GI1, GI2, alternateEnd, bpduTx, bridgeRow, events, linkUpAt, ofKind, portRow, portRows, stpWorld, transitions, triangle } from './stp.harness.js';

const TCN = 'STP topology change notification';
/** TCN frames leaving `device` at or after `from`. */
const tcns = (evs: readonly TraceEvent[], device: string, from: number) =>
  ofKind(evs, 'frameTx').filter((e) => e.t >= from && e.from.device === device && e.pdu.summary.startsWith(TCN));

describe('accept P2 stp-pvst: election and the 802.1D timers', () => {
  it('SW1 root, one blocking port at the higher bridge id on SW2–SW3, forwarding 30 s (+10 ms) after link-up, one broadcast copy per PC', () => {
    const { sim, links } = triangle(stpWorld());
    sim.runUntil(65 * SEC);
    const evs = events(sim);
    const up = linkUpAt(evs, links.sw1sw2);
    expect(up).toBe(30 * SEC);
    expect(linkUpAt(evs, links.sw1sw3)).toBe(up);
    expect(linkUpAt(evs, links.sw2sw3)).toBe(up);
    const b1 = bridgeRow(sim, 'sw1')!;
    expect(b1.isRoot).toBe(true);
    expect(b1.mode).toBe('pvst');
    expect(b1.bridgeId.startsWith('4097/')).toBe(true);
    for (const d of ['sw2', 'sw3']) {
      expect(bridgeRow(sim, d)!.isRoot, d).toBe(false);
      expect(bridgeRow(sim, d)!.rootId, d).toBe(b1.bridgeId);
      expect(bridgeRow(sim, d)!.rootPort, d).toBe(GI1);
    }
    const all = [...portRows(sim, 'sw1'), ...portRows(sim, 'sw2'), ...portRows(sim, 'sw3')];
    expect(all).toHaveLength(9);
    const blocked = all.filter((r) => r.state !== 'forwarding');
    expect(blocked).toHaveLength(1);
    const alt = alternateEnd(sim);
    expect(bridgeRow(sim, alt.device)!.bridgeId > bridgeRow(sim, alt.other)!.bridgeId).toBe(true);
    expect(portRow(sim, alt.device, GI2)).toBe(blocked[0]);
    expect(blocked[0]).toMatchObject({ role: 'alternate', state: 'blocking', port: GI2 });
    expect(portRow(sim, alt.other, GI2)!.role).toBe('designated');
    for (const r of all.filter((x) => x.state === 'forwarding')) {
      expect(['root', 'designated']).toContain(r.role);
      expect(r.stateSince - up).toBeGreaterThanOrEqual(30 * SEC);
      expect(r.stateSince - up).toBeLessThanOrEqual(30 * SEC + 10 * MS);
      expect(r.nextTransitionAt).toBeUndefined();
    }
    // a PC broadcast (PC1's ARP request) reaches each other PC exactly once
    const p = ping(sim, 'pc1', '10.0.0.2');
    expect(p.text).toContain('Sent 5, received 5, lost 0');
    const request = ofKind(p.evs, 'pduCreated').find((e) => e.device === 'pc1' && e.pdu.tag === 'arp-request')!;
    expect(request).toBeDefined();
    const copies = ofKind(p.evs, 'frameRx').filter((e) => e.device.startsWith('pc') && e.pdu.proto === 'arp' && e.pdu.summary.includes('tell 10.0.0.1'));
    expect(copies.filter((e) => e.device === 'pc2')).toHaveLength(1);
    expect(copies.filter((e) => e.device === 'pc3')).toHaveLength(1);
    expect(copies.filter((e) => e.device === 'pc1')).toHaveLength(0);
  });
});

describe('accept P2 stp-pvst: failures', () => {
  it('direct failure at T: the former alternate is root port at once and forwards at T + 30 s ± 10 ms; TCN at T; TC window before T + 1 s', () => {
    const { sim, links } = triangle(stpWorld());
    sim.runUntil(100 * SEC);
    const alt = alternateEnd(sim);
    const before = { root: bridgeRow(sim, 'sw1')!.topologyChanges, alt: bridgeRow(sim, alt.device)!.topologyChanges };
    const T = sim.now;
    sim.removeLink(alt.device === 'sw2' ? links.sw1sw2 : links.sw1sw3);
    sim.runUntil(T + 1 * SEC);
    const evs = events(sim);
    expect(portRow(sim, alt.device, GI2)).toMatchObject({ role: 'root', state: 'listening', stateSince: T });
    const tcn = tcns(evs, alt.device, T);
    expect(tcn.length).toBeGreaterThan(0);
    expect(tcn[0]!.t).toBe(T);
    expect(tcn[0]!.from.port).toBe(GI2);
    const tc = bpduTx(evs, 'sw1').filter((e) => e.t >= T && e.pdu.summary.includes('[TC'));
    expect(tc.length).toBeGreaterThan(0);
    expect(tc[0]!.t).toBeLessThan(T + 1 * SEC);
    expect(bridgeRow(sim, 'sw1')!.topologyChanges).toBeGreaterThan(before.root);
    expect(bridgeRow(sim, alt.device)!.topologyChanges).toBeGreaterThan(before.alt);
    sim.runUntil(T + 30 * SEC + 10 * MS);
    const fwd = portRow(sim, alt.device, GI2)!;
    expect(fwd.state).toBe('forwarding');
    expect(fwd.role).toBe('root');
    expect(fwd.stateSince - T).toBeGreaterThanOrEqual(30 * SEC - 10 * MS);
    expect(fwd.stateSince - T).toBeLessThanOrEqual(30 * SEC + 10 * MS);
    expect(ping(sim, 'pc2', '10.0.0.3').text).toContain('Sent 5, received 5, lost 0');
  });

  it('indirect failure at T: the former alternate forwards in [T + 47 s, T + 50 s]; the change is detected at T on both ends of the cut; TC window before T + 1 s', () => {
    const { sim, links } = triangle(stpWorld());
    sim.runUntil(100 * SEC);
    const alt = alternateEnd(sim);
    const before = { root: bridgeRow(sim, 'sw1')!.topologyChanges, alt: bridgeRow(sim, alt.device)!.topologyChanges, other: bridgeRow(sim, alt.other)!.topologyChanges };
    const T = sim.now;
    // the designated end's root link: SW1's port and the designated end's root port (Gi0/1) are its two ends
    const cutAtRoot = alt.other === 'sw2' ? GI1 : GI2;
    sim.removeLink(alt.other === 'sw2' ? links.sw1sw2 : links.sw1sw3);
    sim.runUntil(T + 1 * SEC);
    const evs = events(sim);
    // detection when the port went down: both ends of the cut note the change at T, on the port that went down
    expect(bridgeRow(sim, 'sw1')).toMatchObject({ isRoot: true, lastChangeAt: T, lastChangePort: cutAtRoot });
    expect(bridgeRow(sim, alt.other)).toMatchObject({ isRoot: true, lastChangeAt: T, lastChangePort: GI1 });
    expect(bridgeRow(sim, 'sw1')!.topologyChanges).toBeGreaterThan(before.root);
    expect(bridgeRow(sim, alt.other)!.topologyChanges).toBeGreaterThan(before.other);
    // the root's TC window starts at once; the designated end, now claiming to be root, flags TC in its own BPDUs at T
    const tc = bpduTx(evs, 'sw1').filter((e) => e.t >= T && e.pdu.summary.includes('[TC'));
    expect(tc.length).toBeGreaterThan(0);
    expect(tc[0]!.t).toBeLessThan(T + 1 * SEC);
    expect(tc[0]!.t).toBe(T);
    const claimTc = bpduTx(evs, alt.other).filter((e) => e.t >= T && e.pdu.summary.includes('[TC'));
    expect(claimTc.length).toBeGreaterThan(0);
    expect(claimTc[0]!.t).toBe(T);
    // the alternate holder keeps its stored information until it ages out
    sim.runUntil(T + 16 * SEC);
    expect(portRow(sim, alt.device, GI2)!.state).toBe('blocking');
    sim.runUntil(T + 20 * SEC);
    const aged = portRow(sim, alt.device, GI2)!;
    expect(aged.role).toBe('designated');
    expect(aged.state).toBe('listening');
    expect(aged.stateSince - T).toBeGreaterThanOrEqual(17 * SEC);
    expect(aged.stateSince - T).toBeLessThanOrEqual(19 * SEC);
    expect(transitions(events(sim), alt.device).find((x) => x.port === GI2 && x.from === 'alternate' && x.to === 'designated')!.cause).toBe('stored information aged out');
    sim.runUntil(T + 51 * SEC);
    const fwd = portRow(sim, alt.device, GI2)!;
    expect(fwd.state).toBe('forwarding');
    expect(fwd.stateSince - T).toBeGreaterThanOrEqual(47 * SEC);
    expect(fwd.stateSince - T).toBeLessThanOrEqual(50 * SEC);
    // the first TCN of this failure: the alternate holder, a non-root bridge, detects the change when its former
    // alternate enters forwarding and notifies at once on its root port (§3.6 step 5)
    const firstTcn = ofKind(events(sim), 'frameTx').filter((e) => e.t >= T && e.pdu.summary.startsWith(TCN));
    expect(firstTcn.length).toBeGreaterThan(0);
    expect(firstTcn[0]!.from).toEqual({ device: alt.device, port: GI1 });
    expect(firstTcn[0]!.t).toBe(fwd.stateSince);
    expect(bridgeRow(sim, alt.device)!.lastChangePort).toBe(GI2);
    expect(portRow(sim, alt.other, GI2)).toMatchObject({ role: 'root', state: 'forwarding' });
    expect(bridgeRow(sim, alt.other)!.rootId).toBe(bridgeRow(sim, 'sw1')!.bridgeId);
    expect(bridgeRow(sim, alt.device)!.topologyChanges).toBeGreaterThan(before.alt);
    expect(bridgeRow(sim, alt.other)!.topologyChanges).toBeGreaterThan(before.other);
    expect(ping(sim, 'pc2', '10.0.0.3').text).toContain('Sent 5, received 5, lost 0');
    expect(sim.runToIdle().stopped).toBeUndefined();
  });

  it('the first TCN (§10.1 row, architect ruling 2026-09-23): at T on a direct failure; on an indirect failure none before the former alternate holder converges, then from it in [T + 47 s, T + 50 s]', () => {
    /** TCN frames leaving any bridge at or after `from`, in trace order. */
    const anyTcn = (sim: ReturnType<typeof stpWorld>, from: number) => ofKind(events(sim), 'frameTx').filter((e) => e.t >= from && e.pdu.summary.startsWith(TCN));

    // DIRECT: the alternate holder's root link is cut; it promotes its alternate and notifies on it at once
    const direct = triangle(stpWorld());
    direct.sim.runUntil(100 * SEC);
    const alt = alternateEnd(direct.sim);
    const T1 = direct.sim.now;
    direct.sim.removeLink(alt.device === 'sw2' ? direct.links.sw1sw2 : direct.links.sw1sw3);
    direct.sim.runUntil(T1 + 1 * SEC);
    const first1 = anyTcn(direct.sim, T1);
    expect(first1.length).toBeGreaterThan(0);
    expect(first1[0]!.t).toBe(T1);
    expect(first1[0]!.from).toEqual({ device: alt.device, port: GI2 });
    expect(portRow(direct.sim, alt.device, GI2)).toMatchObject({ role: 'root', stateSince: T1 });

    // INDIRECT: the designated end's root link is cut; no bridge has a root port to notify on at T
    const indirect = triangle(stpWorld());
    indirect.sim.runUntil(100 * SEC);
    const alt2 = alternateEnd(indirect.sim);
    const T2 = indirect.sim.now;
    indirect.sim.removeLink(alt2.other === 'sw2' ? indirect.links.sw1sw2 : indirect.links.sw1sw3);
    indirect.sim.runUntil(T2 + 47 * SEC - 1);
    expect(anyTcn(indirect.sim, T2)).toEqual([]);
    // the root and the designated end signalled the change with the TC flag at T instead
    expect(bpduTx(events(indirect.sim), 'sw1').find((e) => e.t >= T2 && e.pdu.summary.includes('[TC'))!.t).toBe(T2);
    expect(bpduTx(events(indirect.sim), alt2.other).find((e) => e.t >= T2 && e.pdu.summary.includes('[TC'))!.t).toBe(T2);
    indirect.sim.runUntil(T2 + 50 * SEC + 1);
    const first2 = anyTcn(indirect.sim, T2);
    expect(first2.length).toBeGreaterThan(0);
    expect(first2[0]!.from).toEqual({ device: alt2.device, port: GI1 });
    expect(first2[0]!.t - T2).toBeGreaterThanOrEqual(47 * SEC);
    expect(first2[0]!.t - T2).toBeLessThanOrEqual(50 * SEC);
    // it leaves when the former alternate enters forwarding (the alternate holder's detection, §3.6 step 5)
    const fwd = portRow(indirect.sim, alt2.device, GI2)!;
    expect(fwd).toMatchObject({ role: 'designated', state: 'forwarding' });
    expect(first2[0]!.t).toBe(fwd.stateSince);
  });
});
