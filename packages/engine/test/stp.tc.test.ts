/**
 * W3 stp (ARCHITECTURE-P2 §3.6 step 5 and Rapid step 7, §2.5 `L2FlushEvent`, §13 #23): topology change handling on
 * real P2-profile worlds — 802.1D detection when a port leaves forwarding, TCN until acknowledged and relayed, the
 * root's TC window and the fast-age flush, 802.1w propagation on every non-edge port, and host CAM rows on edge ports
 * surviving a change.
 */
import { describe, expect, it } from 'vitest';
import { camKey } from '../src/contracts/tables.js';
import type { CamRow } from '../src/contracts/tables.js';
import { SEC } from '../src/contracts/time.js';
import { pcConfig } from '../src/sim/scenarios/templates.js';
import { ping } from './sim.harness.js';
import {
  FA1,
  FA2,
  GI1,
  GI2,
  PC,
  SWITCH,
  alternateEnd,
  bpduTx,
  bridgeRow,
  events,
  ofKind,
  portRow,
  section,
  stpWorld,
  switchConfig,
  triangle,
} from './stp.harness.js';

const TCN = 'STP topology change notification';
const tcns = (sim: ReturnType<typeof stpWorld>, device: string, from: number) =>
  ofKind(events(sim), 'frameTx').filter((e) => e.t >= from && e.from.device === device && e.pdu.summary.startsWith(TCN));
const flushDebug = (sim: ReturnType<typeof stpWorld>, device: string, from: number, text: string) =>
  ofKind(events(sim), 'debug').filter((e) => e.t >= from && e.event.device === device && e.event.process === 'eth-switch' && e.event.message.includes(text));

describe('802.1D topology change (§3.6 step 5)', () => {
  it('a non-edge port leaving forwarding is detected at once: TCN on the root port, TC-ack from the designated bridge, relay to the root, 35 s TC window, one fast-age flush per period', () => {
    const { sim } = triangle(stpWorld(), { sections: { sw3: [section(`interface ${FA2}`, ['switchport mode access'])] } });
    sim.addDevice({ id: 'pc4', type: PC, name: 'PC4', startupConfig: pcConfig('PC4', '10.0.0.4', '255.255.255.0') });
    const l = sim.addLink({ a: { device: 'pc4', port: 'GigabitEthernet0' }, b: { device: 'sw3', port: FA2 } });
    sim.runUntil(100 * SEC);
    expect(portRow(sim, 'sw3', FA2)!.state).toBe('forwarding');
    expect(portRow(sim, 'sw3', FA2)!.edge).toBe(false);
    const alt = alternateEnd(sim);
    const rootPortOfSw3 = bridgeRow(sim, 'sw3')!.rootPort!;
    const before = { sw1: bridgeRow(sim, 'sw1')!.topologyChanges, sw3: bridgeRow(sim, 'sw3')!.topologyChanges };
    const T = sim.now;
    sim.removeLink(l);
    sim.runUntil(T + 1 * SEC);
    const evs = events(sim);
    // detection at the cut; the TCN leaves on the root port at T
    const t = tcns(sim, 'sw3', T);
    expect(t).toHaveLength(1);
    expect(t[0]!.t).toBe(T);
    expect(t[0]!.from.port).toBe(rootPortOfSw3);
    const tcn = sim.pdu(t[0]!.pdu.id)!;
    expect(tcn.get('stp.bpduType')).toBe(0x80);
    expect(tcn.get('stp.version')).toBe(0);
    expect(tcn.size).toBe(64);
    // the root acknowledges at once and opens its TC window: TC in its BPDUs
    const acks = bpduTx(evs, 'sw1', GI2).filter((e) => e.t >= T).map((e) => sim.pdu(e.pdu.id)!).filter((p) => String(p.get('stp.flagsText')).includes('TCA'));
    expect(acks.length).toBeGreaterThan(0);
    expect(String(acks[0]!.get('stp.flagsText'))).toBe('TC,TCA');
    expect(bridgeRow(sim, 'sw1')!.topologyChanges).toBe(before.sw1 + 1);
    expect(bridgeRow(sim, 'sw3')!.topologyChanges).toBe(before.sw3 + 1);
    expect(bridgeRow(sim, 'sw3')!.lastChangePort).toBe(FA2);
    expect(bridgeRow(sim, 'sw3')!.lastChangeAt).toBe(T);
    // each bridge fast-ages once per TC period; the flush names every STP port of the VLAN
    for (const d of ['sw1', 'sw2', 'sw3']) {
      expect(flushDebug(sim, d, T, 'fast ageing')).toHaveLength(0); // no dynamic rows yet: nothing to age
    }
    const stpFlush = ofKind(evs, 'debug').filter((e) => e.t >= T && e.event.process === 'stp' && e.event.message.includes('fast ageing'));
    expect(stpFlush.map((e) => e.event.device).sort()).toEqual(['sw1', 'sw2', 'sw3']);
    expect(stpFlush.find((e) => e.event.device === 'sw3')!.event.data!.ports).toEqual([FA1, GI1, GI2]);
    // TC stays set for max age + forward delay = 35 s, then clears
    sim.runUntil(T + 34 * SEC);
    const late = bpduTx(events(sim), 'sw1', GI1).filter((e) => e.t > T + 33 * SEC).map((e) => sim.pdu(e.pdu.id)!);
    expect(late.every((p) => String(p.get('stp.flagsText')).includes('TC'))).toBe(true);
    sim.runUntil(T + 38 * SEC);
    const after = bpduTx(events(sim), 'sw1', GI1).filter((e) => e.t > T + 36 * SEC).map((e) => sim.pdu(e.pdu.id)!);
    expect(after.length).toBeGreaterThan(0);
    expect(after.every((p) => !String(p.get('stp.flagsText')).includes('TC'))).toBe(true);
    // the relayed BPDUs carried the flag downstream too
    const relayed = bpduTx(evs, alt.other, GI2).filter((e) => e.t > T && e.t < T + 1 * SEC).map((e) => sim.pdu(e.pdu.id)!);
    expect(relayed.some((p) => String(p.get('stp.flagsText')).includes('TC'))).toBe(true);
  });

  it('a TCN is repeated every hello until a TC-ack arrives, and a designated port relays its own TCN toward the root', () => {
    const { sim, links } = triangle(stpWorld(), { sections: { sw3: [section(`interface ${FA2}`, ['switchport mode access'])] } });
    sim.addDevice({ id: 'pc4', type: PC, name: 'PC4', startupConfig: pcConfig('PC4', '10.0.0.4', '255.255.255.0') });
    const l = sim.addLink({ a: { device: 'pc4', port: 'GigabitEthernet0' }, b: { device: 'sw3', port: FA2 } });
    sim.runUntil(100 * SEC);
    // SW3's root link loses every frame: its TCNs never reach SW1 and no ack comes back
    sim.setImpairments(links.sw1sw3, { lossPct: 100 });
    const T = sim.now;
    sim.removeLink(l);
    sim.runUntil(T + 15 * SEC);
    const repeated = tcns(sim, 'sw3', T);
    expect(repeated.map((e) => (e.t - T) / SEC)).toEqual([0, 2, 4, 6, 8, 10, 12, 14]);
    // heal the link: the next TCN is acknowledged and the repeats stop
    sim.setImpairments(links.sw1sw3, { lossPct: 0 });
    sim.runUntil(T + 17 * SEC);
    expect(tcns(sim, 'sw3', T)).toHaveLength(9);
    sim.runUntil(T + 30 * SEC);
    expect(tcns(sim, 'sw3', T)).toHaveLength(9);
    const acked = ofKind(events(sim), 'debug').filter((e) => e.t > T + 15 * SEC && e.event.device === 'sw3' && e.event.message.includes('acknowledged'));
    expect(acked).toHaveLength(1);
    expect(sim.runToIdle().stopped).toBeUndefined();

    // relay: a change at a bridge whose root port faces a non-root designated port is relayed by that bridge
    const relay = triangle(stpWorld());
    relay.sim.runUntil(100 * SEC);
    const alt = alternateEnd(relay.sim);
    const T2 = relay.sim.now;
    relay.sim.removeLink(alt.device === 'sw2' ? relay.links.sw1sw2 : relay.links.sw1sw3);
    relay.sim.runUntil(T2 + 1 * SEC);
    // the alternate holder lost its root port: it notifies on its new root port (the SW2–SW3 link)…
    const own = tcns(relay.sim, alt.device, T2);
    expect(own[0]!.t).toBe(T2);
    expect(own[0]!.from.port).toBe(GI2);
    // …the designated end acknowledges on that port and sends its own TCN on its root port toward SW1
    const relayed = tcns(relay.sim, alt.other, T2);
    expect(relayed).toHaveLength(1);
    expect(relayed[0]!.from.port).toBe(GI1);
    const ack = bpduTx(events(relay.sim), alt.other, GI2).filter((e) => e.t >= T2).map((e) => relay.sim.pdu(e.pdu.id)!).filter((p) => String(p.get('stp.flagsText')).includes('TCA'));
    expect(ack.length).toBeGreaterThan(0);
  });

  it('a non-edge port entering forwarding is a change; edge ports never are', () => {
    const { sim } = triangle(stpWorld(), { sections: { sw2: [section(`interface ${FA1}`, ['spanning-tree portfast'])] } });
    sim.runUntil(59 * SEC);
    expect(tcns(sim, 'sw2', 0)).toHaveLength(0);
    expect(tcns(sim, 'sw3', 0)).toHaveLength(0);
    sim.runUntil(61 * SEC);
    // SW2's non-edge root port entered forwarding at 60 s: a TCN; SW3 too (its PC port is not edge)
    expect(tcns(sim, 'sw2', 0).map((e) => e.t)).toEqual([60 * SEC]);
    expect(tcns(sim, 'sw3', 0).length).toBeGreaterThanOrEqual(1);
    expect(bridgeRow(sim, 'sw2')!.lastChangePort).toBe(GI1);
  });
});

describe('802.1w topology change (§3.6 Rapid step 7)', () => {
  const RAPID = ['spanning-tree mode rapid-pvst'];
  const PORTFAST = [section(`interface ${FA1}`, ['spanning-tree portfast'])];

  it('the originator flags TC on every non-edge root and designated port for 2 × hello and flushes them except the one that went forwarding; receivers propagate and flush', () => {
    const { sim, links } = triangle(stpWorld(), { all: RAPID, sections: { sw1: PORTFAST, sw2: PORTFAST, sw3: PORTFAST } });
    sim.runUntil(100 * SEC);
    const alt = alternateEnd(sim);
    const T = sim.now;
    // cut the alternate holder's root link: its alternate port goes forwarding and originates the change
    sim.removeLink(alt.device === 'sw2' ? links.sw1sw2 : links.sw1sw3);
    sim.runUntil(T + 1 * SEC);
    const evs = events(sim);
    const flushes = ofKind(evs, 'debug').filter((e) => e.t >= T && e.event.process === 'stp' && e.event.message.includes('flushing dynamic addresses'));
    const byDevice = new Map(flushes.map((e) => [e.event.device, e.event.data!.ports]));
    // the originator flushed nothing: its only non-edge port is the one that went forwarding
    expect(byDevice.has(alt.device)).toBe(false);
    // the designated end heard TC on Gi0/2 and flushed its other non-edge port (its root port), never the edge port
    expect(byDevice.get(alt.other)).toEqual([GI1]);
    // the root heard it too (on the surviving link); its only other non-edge port is the one that was cut, so it
    // had nothing to flush
    expect(byDevice.has('sw1')).toBe(false);
    expect(ofKind(evs, 'debug').some((e) => e.t >= T && e.event.device === 'sw1' && e.event.process === 'stp' && e.event.message.includes('topology change received'))).toBe(true);
    const tcFlagged = bpduTx(evs, alt.device, GI2).filter((e) => e.t >= T).map((e) => sim.pdu(e.pdu.id)!);
    expect(tcFlagged.length).toBeGreaterThan(0);
    expect(tcFlagged.every((p) => String(p.get('stp.flagsText')).includes('TC'))).toBe(true);
    expect(String(tcFlagged[0]!.get('stp.flagsText')).split(',')).toContain('R');
    // the hellos 2 × hello later carry no TC any more
    sim.runUntil(T + 8 * SEC);
    const later = bpduTx(events(sim), alt.other, GI2).filter((e) => e.t > T + 5 * SEC).map((e) => sim.pdu(e.pdu.id)!);
    expect(later.length).toBeGreaterThan(0);
    expect(later.every((p) => !String(p.get('stp.flagsText')).includes('TC'))).toBe(true);
    // no 802.1D TCN anywhere, and every counter moved
    expect(ofKind(evs, 'frameTx').filter((e) => e.t >= T && e.pdu.summary.startsWith(TCN))).toHaveLength(0);
    for (const d of ['sw1', 'sw2', 'sw3']) expect(bridgeRow(sim, d)!.topologyChanges).toBeGreaterThanOrEqual(2);
    expect(sim.runToIdle().stopped).toBeUndefined();
  });

  it('host CAM rows on edge ports survive a change; rows on the flushed inter-switch ports do not', () => {
    const { sim } = triangle(stpWorld(), { all: RAPID, sections: { sw1: PORTFAST, sw2: PORTFAST, sw3: PORTFAST } });
    sim.runUntil(40 * SEC);
    expect(ping(sim, 'pc1', '10.0.0.2').text).toContain('Sent 5, received 5, lost 0');
    const pc1 = sim.device('pc1')!.portView('GigabitEthernet0')!.mac;
    const pc2 = sim.device('pc2')!.portView('GigabitEthernet0')!.mac;
    const cam = (d: string, mac: string): CamRow | undefined => sim.device(d)!.tables.cam.get(camKey(1, mac));
    expect(cam('sw1', pc1)!.port).toBe(FA1);
    expect(cam('sw2', pc2)!.port).toBe(FA1);
    expect(cam('sw2', pc1)!.port).toBe(GI1);
    expect(cam('sw1', pc2)!.port).toBe(GI1);
    // a new non-edge port entering forwarding on SW3 originates a change that reaches every bridge
    sim.addDevice({ id: 'sw4', type: SWITCH, name: 'SW4', startupConfig: switchConfig('SW4', RAPID) });
    sim.addLink({ a: { device: 'sw4', port: GI1 }, b: { device: 'sw3', port: FA2 } });
    const T = sim.now;
    sim.runUntil(T + 35 * SEC);
    const evs = events(sim);
    const flushes = ofKind(evs, 'debug').filter((e) => e.t >= T && e.event.process === 'stp' && e.event.message.includes('flushing dynamic addresses'));
    expect(flushes.map((e) => e.event.device)).toContain('sw1');
    expect(flushes.map((e) => e.event.device)).toContain('sw2');
    expect(flushes.every((e) => !(e.event.data!.ports as string[]).includes(FA1))).toBe(true);
    // the edge rows are still there; the inter-switch rows went with the flush
    expect(cam('sw1', pc1)!.port).toBe(FA1);
    expect(cam('sw2', pc2)!.port).toBe(FA1);
    expect(cam('sw2', pc1)).toBeUndefined();
    expect(cam('sw1', pc2)).toBeUndefined();
    const removed = ofKind(evs, 'tableExpire').filter((e) => e.t >= T && e.table === 'cam' && e.device === 'sw1');
    expect(removed.map((e) => (e.row as { mac: string }).mac)).toContain(pc2);
    expect(removed.every((e) => [GI1, GI2].includes((e.row as { port: string }).port) && e.reason === 'cleared')).toBe(true);
    expect(removed[0]!.t - T).toBeLessThan(35 * SEC);
  });
});



