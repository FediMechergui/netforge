/**
 * W3 stp (ARCHITECTURE-P2 §3.6 "PVST+", §4.2, §10.1 accept.p2.stp-pvst): the §3.6 triangle timings on a real
 * P2-profile world (`test/p2.world.ts`, §0 rule 13) with the W2 eth-switch, the real vlan daemon and the stp factory.
 * All switches boot at 30 s and every link comes up at 30 s.
 */
import { describe, expect, it } from 'vitest';
import { SEC, MS } from '../src/contracts/time.js';
import { STP_BPDU_TAG } from '../src/protocols/stp.js';
import { ping } from './sim.harness.js';
import {
  FA1,
  GI1,
  GI2,
  alternateEnd,
  bpduTx,
  bridgeRow,
  events,
  linkUpAt,
  ofKind,
  portRow,
  portRows,
  stpWorld,
  transitions,
  triangle,
} from './stp.harness.js';

describe('PVST+ triangle: election and the 802.1D timers (§3.6 steps 1–4)', () => {
  it('elects SW1, blocks exactly one port on the SW2–SW3 link at the higher bridge id, and forwards 30 s after link-up', () => {
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
    expect(b1.bridgeId.startsWith('4097/')).toBe(true); // 4096 + VLAN 1
    expect(b1.rootCost).toBe(0);
    expect(b1.rootPort).toBeUndefined();
    for (const d of ['sw2', 'sw3']) {
      const b = bridgeRow(sim, d)!;
      expect(b.isRoot).toBe(false);
      expect(b.rootId).toBe(b1.bridgeId);
      expect(b.rootCost).toBe(4);
      expect(b.rootPort).toBe(GI1);
      expect(b.bridgeId.startsWith('32769/')).toBe(true);
      expect([b.helloS, b.maxAgeS, b.forwardDelayS]).toEqual([2, 20, 15]);
    }

    const all = [...portRows(sim, 'sw1'), ...portRows(sim, 'sw2'), ...portRows(sim, 'sw3')];
    expect(all).toHaveLength(9);
    const blocked = all.filter((r) => r.state !== 'forwarding');
    expect(blocked).toHaveLength(1);
    const alt = alternateEnd(sim);
    expect(blocked[0]!.port).toBe(alt.port);
    expect(blocked[0]!.role).toBe('alternate');
    expect(blocked[0]!.state).toBe('blocking');
    expect(portRow(sim, alt.device, GI2)).toBe(blocked[0]);
    expect(portRow(sim, alt.other, GI2)!.role).toBe('designated');
    for (const r of all.filter((x) => x.state === 'forwarding')) {
      expect(['root', 'designated']).toContain(r.role);
      expect(r.stateSince - up).toBeGreaterThanOrEqual(30 * SEC);
      expect(r.stateSince - up).toBeLessThanOrEqual(30 * SEC + 10 * MS);
      expect(r.protocol).toBe('stp');
      expect(r.edge).toBe(false);
      expect(r.nextTransitionAt).toBeUndefined();
    }
    // identities and costs: 802.1t port ids from the ordinal, short-method cost 4 on 1 Gb/s, 19 on 100 Mb/s
    expect(portRow(sim, 'sw1', GI1)!.portId).toBe('128.25');
    expect(portRow(sim, 'sw1', GI2)!.portId).toBe('128.26');
    expect(portRow(sim, 'sw1', GI1)!.cost).toBe(4);
    expect(portRow(sim, 'sw1', FA1)!.cost).toBe(19);
    // the alternate port names the designated bridge of its segment, a root port names the root's port
    expect(blocked[0]!.designatedBridge).toBe(bridgeRow(sim, alt.other)!.bridgeId);
    expect(portRow(sim, 'sw2', GI1)!.designatedBridge).toBe(b1.bridgeId);
    expect(portRow(sim, 'sw2', GI1)!.designatedPort).toBe('128.25');
  });

  it('walks listening → learning → forwarding with 15 s steps, the row countdown set, and no transition on a role change', () => {
    const { sim } = triangle(stpWorld());
    sim.runUntil(31 * SEC);
    const listening = portRow(sim, 'sw2', GI1)!;
    expect(listening.state).toBe('listening');
    expect(listening.role).toBe('root');
    expect(listening.stateSince).toBe(30 * SEC);
    expect(listening.nextTransitionAt).toBe(45 * SEC);
    sim.runUntil(46 * SEC);
    const learning = portRow(sim, 'sw2', GI1)!;
    expect(learning.state).toBe('learning');
    expect(learning.stateSince).toBe(45 * SEC);
    expect(learning.nextTransitionAt).toBe(60 * SEC);
    sim.runUntil(61 * SEC);
    expect(portRow(sim, 'sw2', GI1)!.state).toBe('forwarding');
    expect(portRow(sim, 'sw2', GI1)!.stateSince).toBe(60 * SEC);
    const t = transitions(events(sim), 'sw2').filter((x) => x.port === GI1);
    expect(t.map((x) => `${x.from}>${x.to}@${x.t / SEC}`)).toEqual([
      'disabled>listening@30',
      'designated>root@30.000000688',
      'listening>learning@45',
      'learning>forwarding@60',
    ]);
    expect(t.every((x) => x.machine === 'stp-port' && x.subject === `VLAN0001 ${GI1}` && x.instance === 1)).toBe(true);
    expect(t[1]!.pdu).toBeTypeOf('number');
    expect(t[2]!.cause).toBe('forward delay expired');
  });

  it('sends IEEE BPDUs: the root originates every hello on its designated ports, a non-root bridge relays with message age + 1 s', () => {
    const { sim } = triangle(stpWorld());
    sim.runUntil(40 * SEC);
    const evs = events(sim);
    const root = bpduTx(evs, 'sw1', GI1);
    // one at link-up, then one per hello (2 s); the only other one is the reply to SW2's first (inferior) BPDU
    expect(root.filter((e) => e.t % (2 * SEC) === 0).map((e) => e.t / SEC)).toEqual([30, 32, 34, 36, 38, 40]);
    expect(root.filter((e) => e.t % (2 * SEC) !== 0).map((e) => e.t)).toEqual([30 * SEC + 688]);
    const first = sim.pdu(root[0]!.pdu.id)!;
    expect(first.layers.map((l) => l.proto)).toEqual(['ethernet', 'llc', 'stp']);
    expect(first.get('ethernet.dst')).toBe('01:80:c2:00:00:00');
    expect(first.get('llc.dsap')).toBe(0x42);
    expect(first.get('stp.version')).toBe(0);
    expect(first.get('stp.bpduType')).toBe(0);
    expect(first.get('stp.messageAge')).toBe(0);
    expect(first.get('stp.maxAge')).toBe(20 * 256);
    expect(first.get('stp.helloTime')).toBe(2 * 256);
    expect(first.get('stp.forwardDelay')).toBe(15 * 256);
    expect(first.get('stp.pvid')).toBeUndefined(); // an access port: a plain BPDU, no TLV (D8)
    expect(first.meta.tag).toBe(STP_BPDU_TAG);
    expect(first.meta.background).toBe(true);
    // the designated end of SW2–SW3 relays each hello with the age incremented by one second
    const alt = alternateEnd(sim);
    const relays = bpduTx(evs, alt.other, GI2).filter((e) => e.t > 31 * SEC);
    expect(relays.length).toBeGreaterThanOrEqual(4);
    for (const r of relays) {
      const p = sim.pdu(r.pdu.id)!;
      expect(p.get('stp.messageAge')).toBe(256);
      expect(p.get('stp.rootPriority')).toBe(4097);
      expect(p.get('stp.rootPathCost')).toBe(4);
    }
    // the alternate port sends nothing once blocked
    expect(bpduTx(evs, alt.device, GI2).filter((e) => e.t > 31 * SEC)).toHaveLength(0);
    // hosts drop every BPDU as background traffic
    const pcDrops = ofKind(evs, 'drop').filter((e) => e.device?.startsWith("pc") === true && e.pdu?.tag === STP_BPDU_TAG);
    expect(pcDrops.length).toBeGreaterThan(0);
    expect(pcDrops.every((e) => e.background === true && e.reason === 'not-for-me')).toBe(true);
  });

  it('a PC broadcast reaches each other PC exactly once after convergence and pings succeed', () => {
    const { sim } = triangle(stpWorld());
    sim.runUntil(100 * SEC);
    const p = ping(sim, 'pc1', '10.0.0.2');
    expect(p.text).toContain('Sent 5, received 5, lost 0');
    const arp = ofKind(p.evs, 'frameRx').filter((e) => e.pdu.proto === 'arp' && e.pdu.summary.includes('who-has'));
    expect(arp.filter((e) => e.device === 'pc2')).toHaveLength(1);
    expect(arp.filter((e) => e.device === 'pc3')).toHaveLength(1);
  });
});

describe('PVST+ triangle: failures (§3.6 steps 6–7)', () => {
  it('direct failure: the former alternate becomes root port at once and forwards at T + 30 s; TCN at T; root TC window before T + 1 s', () => {
    const { sim, links } = triangle(stpWorld());
    sim.runUntil(100 * SEC);
    const alt = alternateEnd(sim);
    const before = bridgeRow(sim, 'sw1')!.topologyChanges;
    const T = 100 * SEC;
    sim.removeLink(alt.device === 'sw2' ? links.sw1sw2 : links.sw1sw3);
    sim.runUntil(T + 1 * SEC);
    const listening = portRow(sim, alt.device, GI2)!;
    expect(listening.role).toBe('root');
    expect(listening.state).toBe('listening');
    expect(listening.stateSince).toBe(T);
    expect(bridgeRow(sim, alt.device)!.rootPort).toBe(GI2);
    const evs = events(sim);
    const tcn = ofKind(evs, 'frameTx').filter((e) => e.t >= T && e.from.device === alt.device && e.pdu.summary.startsWith('STP topology change notification'));
    expect(tcn[0]!.t).toBe(T);
    expect(tcn[0]!.from.port).toBe(GI2);
    const tcFlagged = bpduTx(evs, 'sw1').filter((e) => e.t >= T && e.pdu.summary.includes('[TC'));
    expect(tcFlagged.length).toBeGreaterThan(0);
    expect(tcFlagged[0]!.t).toBeLessThan(T + 1 * SEC);
    sim.runUntil(T + 30 * SEC + 10 * MS);
    const fwd = portRow(sim, alt.device, GI2)!;
    expect(fwd.state).toBe('forwarding');
    expect(fwd.stateSince - T).toBeGreaterThanOrEqual(30 * SEC);
    expect(fwd.stateSince - T).toBeLessThanOrEqual(30 * SEC + 10 * MS);
    expect(bridgeRow(sim, 'sw1')!.topologyChanges).toBeGreaterThan(before);
    expect(bridgeRow(sim, alt.device)!.topologyChanges).toBeGreaterThan(0);
    const idle = sim.runToIdle();
    expect(idle.stopped).toBeUndefined();
    expect(sim.now).toBeLessThanOrEqual(T + 30 * SEC + 35 * SEC + 1 * SEC);
  });

  it('indirect failure: the stored information ages out in [T + 17 s, T + 19 s], the port forwards in [T + 47 s, T + 50 s]', () => {
    const { sim, links } = triangle(stpWorld());
    sim.runUntil(100 * SEC);
    const alt = alternateEnd(sim);
    const T = 100 * SEC;
    // cut the root link of the DESIGNATED end: it loses its root port with no alternate and claims to be root
    sim.removeLink(alt.other === 'sw2' ? links.sw1sw2 : links.sw1sw3);
    sim.runUntil(T + 16 * SEC);
    // the alternate end keeps the superior information it stored and stays blocked
    expect(portRow(sim, alt.device, GI2)!.state).toBe('blocking');
    expect(bridgeRow(sim, alt.other)!.isRoot).toBe(true);
    sim.runUntil(T + 20 * SEC);
    const aged = portRow(sim, alt.device, GI2)!;
    expect(aged.role).toBe('designated');
    expect(aged.state).toBe('listening');
    expect(aged.stateSince - T).toBeGreaterThanOrEqual(17 * SEC);
    expect(aged.stateSince - T).toBeLessThanOrEqual(19 * SEC);
    const agedAt = transitions(events(sim), alt.device).find((x) => x.port === GI2 && x.from === 'alternate' && x.to === 'designated')!;
    expect(agedAt.cause).toBe('stored information aged out');
    // the other end hears SW1's information within a hello and takes it as its root port, forwarding all along
    sim.runUntil(T + 23 * SEC);
    const other = portRow(sim, alt.other, GI2)!;
    expect(other.role).toBe('root');
    expect(other.state).toBe('forwarding');
    expect(other.stateSince).toBe(60 * SEC);
    expect(bridgeRow(sim, alt.other)!.isRoot).toBe(false);
    expect(bridgeRow(sim, alt.other)!.rootId).toBe(bridgeRow(sim, 'sw1')!.bridgeId);
    sim.runUntil(T + 51 * SEC);
    const fwd = portRow(sim, alt.device, GI2)!;
    expect(fwd.state).toBe('forwarding');
    expect(fwd.stateSince - T).toBeGreaterThanOrEqual(47 * SEC);
    expect(fwd.stateSince - T).toBeLessThanOrEqual(50 * SEC);
    // a ping across the repaired tree succeeds
    const p = ping(sim, 'pc2', '10.0.0.3');
    expect(p.text).toContain('Sent 5, received 5, lost 0');
  });
});
