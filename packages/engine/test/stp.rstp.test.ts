/**
 * W3 stp (ARCHITECTURE-P2 §3.6 "Rapid PVST+", §13 #10 and #18, §10.1 accept.p2.stp-rapid): 802.1w proposal /
 * agreement on the §3.6 triangle in a real P2-profile world, including the alternate-port agreement on the SW2–SW3
 * link and the 30 s fallback of a non-edge host port.
 */
import { describe, expect, it } from 'vitest';
import { SEC, MS } from '../src/contracts/time.js';
import { pcConfig } from '../src/sim/scenarios/templates.js';
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
  linkUpAt,
  portRow,
  portRows,
  section,
  stpRowWrites,
  stpWorld,
  switchConfig,
  transitions,
  triangle,
} from './stp.harness.js';

const RAPID = ['spanning-tree mode rapid-pvst'];
const PORTFAST = [section(`interface ${FA1}`, ['spanning-tree portfast'])];

function rapidTriangle(sim = stpWorld()) {
  return triangle(sim, { all: RAPID, sections: { sw1: PORTFAST, sw2: PORTFAST, sw3: PORTFAST } });
}

describe('Rapid PVST+ triangle (§3.6 Rapid steps 1–4)', () => {
  it('converges within 1 s of link-up with the same roles as PVST+, RST BPDUs from every bridge, and no forward-delay timer on the inter-switch links', () => {
    const { sim, links } = rapidTriangle();
    sim.runUntil(31 * SEC);
    const evs = events(sim);
    const up = linkUpAt(evs, links.sw1sw2);
    expect(bridgeRow(sim, 'sw1')!.isRoot).toBe(true);
    expect(bridgeRow(sim, 'sw1')!.mode).toBe('rapid-pvst');
    const all = [...portRows(sim, 'sw1'), ...portRows(sim, 'sw2'), ...portRows(sim, 'sw3')];
    expect(all).toHaveLength(9);
    const alt = alternateEnd(sim);
    for (const r of all) {
      expect(r.protocol).toBe('rstp');
      if (r.port === GI2 && r.vlan === 1 && all.indexOf(r) >= 0 && portRow(sim, alt.device, GI2) === r) {
        expect(r.role).toBe('alternate');
        expect(r.state).toBe('discarding');
        continue;
      }
      expect(r.state).toBe('forwarding');
      expect(r.stateSince - up).toBeLessThan(1 * SEC);
    }
    expect(portRow(sim, alt.device, GI2)!.role).toBe('alternate');
    expect(portRow(sim, alt.other, GI2)!.role).toBe('designated');
    // the PC ports are edge and forward at link-up
    for (const d of ['sw1', 'sw2', 'sw3']) {
      expect(portRow(sim, d, FA1)!.edge).toBe(true);
      expect(portRow(sim, d, FA1)!.stateSince).toBe(up);
    }
    // no `fwd:` countdown was ever written for an inter-switch port (the handshake made every transition)
    for (const d of ['sw1', 'sw2', 'sw3']) {
      const writes = stpRowWrites(evs, d).filter((r) => r.port === GI1 || r.port === GI2);
      expect(writes.length).toBeGreaterThan(0);
      expect(writes.some((r) => r.nextTransitionAt !== undefined)).toBe(true); // armed as the fallback while proposing…
      const final = portRows(sim, d).filter((r) => r.port === GI1 || r.port === GI2);
      expect(final.every((r) => r.nextTransitionAt === undefined)).toBe(true); // …and cleared by the agreement
    }
    // every bridge sends its own RST BPDUs on its designated ports every hello
    for (const d of ['sw1', alt.other]) {
      const port = d === 'sw1' ? GI1 : GI2;
      const hellos = bpduTx(evs, d, port).filter((e) => e.t > 30 * SEC + 100 * MS);
      expect(hellos.length).toBeGreaterThanOrEqual(0);
    }
    sim.runUntil(40 * SEC);
    const later = events(sim);
    const rootHellos = bpduTx(later, 'sw1', GI1).filter((e) => e.t % (2 * SEC) === 0 && e.t > 30 * SEC);
    expect(rootHellos.map((e) => e.t / SEC)).toEqual([32, 34, 36, 38, 40]);
    const desg = bpduTx(later, alt.other, GI2).filter((e) => e.t % (2 * SEC) === 0 && e.t > 30 * SEC);
    expect(desg.map((e) => e.t / SEC)).toEqual([32, 34, 36, 38, 40]);
    const p = sim.pdu(rootHellos[0]!.pdu.id)!;
    expect(p.get('stp.version')).toBe(2);
    expect(p.get('stp.bpduType')).toBe(2);
    expect(String(p.get('stp.flagsText'))).toContain('D');
    expect(String(p.get('stp.flagsText'))).toContain('F');
    // an alternate port sends nothing on its own
    expect(bpduTx(later, alt.device, GI2).filter((e) => e.t > 31 * SEC)).toHaveLength(0);
  });

  it('the designated port on SW2–SW3 proposes and the alternate port answers with an agreement (ALTERNATE_AGREED, #18)', () => {
    const { sim } = rapidTriangle();
    sim.runUntil(31 * SEC);
    const evs = events(sim);
    const alt = alternateEnd(sim);
    const proposals = bpduTx(evs, alt.other, GI2).map((e) => sim.pdu(e.pdu.id)!).filter((p) => String(p.get('stp.flagsText')).includes('P'));
    expect(proposals.length).toBeGreaterThan(0);
    const agreements = bpduTx(evs, alt.device, GI2).map((e) => sim.pdu(e.pdu.id)!).filter((p) => String(p.get('stp.flagsText')).includes('AG'));
    expect(agreements.length).toBeGreaterThan(0);
    const ag = agreements[agreements.length - 1]!;
    expect(String(ag.get('stp.flagsText')).split(',')).toContain('A'); // role bits: alternate/backup
    expect(ag.get('stp.rootPriority')).toBe(4097);
    const forwarded = transitions(evs, alt.other).find((t) => t.port === GI2 && t.to === 'forwarding')!;
    expect(forwarded.cause).toBe('agreement received');
    expect(forwarded.pdu).toBeTypeOf('number');
    // the root ports accepted SW1's proposals and agreed
    for (const d of ['sw2', 'sw3']) {
      const rootAgreed = bpduTx(evs, d, GI1).map((e) => sim.pdu(e.pdu.id)!).filter((p) => String(p.get('stp.flagsText')).includes('AG'));
      expect(rootAgreed.length).toBeGreaterThan(0);
      expect(String(rootAgreed[0]!.get('stp.flagsText')).split(',')).toContain('R');
    }
    const sw1Agreed = transitions(evs, 'sw1').filter((t) => t.to === 'forwarding' && (t.port === GI1 || t.port === GI2));
    expect(sw1Agreed.map((t) => t.cause)).toEqual(['agreement received', 'agreement received']);
  });

  it('direct failure: the alternate port becomes root port and forwards in the same dispatch; indirect failure: well under 1 s', () => {
    const direct = rapidTriangle();
    direct.sim.runUntil(100 * SEC);
    const alt = alternateEnd(direct.sim);
    const T = 100 * SEC;
    direct.sim.removeLink(alt.device === 'sw2' ? direct.links.sw1sw2 : direct.links.sw1sw3);
    direct.sim.runUntil(T + 1 * MS);
    const r = portRow(direct.sim, alt.device, GI2)!;
    expect(r.role).toBe('root');
    expect(r.state).toBe('forwarding');
    expect(r.stateSince).toBe(T);
    expect(bridgeRow(direct.sim, alt.device)!.topologyChanges).toBeGreaterThan(1);
    expect(direct.sim.runToIdle().stopped).toBeUndefined();
    expect(direct.sim.now).toBeLessThan(T + 10 * SEC);

    const indirect = rapidTriangle();
    indirect.sim.runUntil(100 * SEC);
    const alt2 = alternateEnd(indirect.sim);
    indirect.sim.removeLink(alt2.other === 'sw2' ? indirect.links.sw1sw2 : indirect.links.sw1sw3);
    indirect.sim.runUntil(T + 1 * SEC);
    const former = portRow(indirect.sim, alt2.device, GI2)!;
    expect(former.role).toBe('designated');
    expect(former.state).toBe('forwarding');
    expect(former.stateSince - T).toBeLessThan(1 * SEC);
    const other = portRow(indirect.sim, alt2.other, GI2)!;
    expect(other.role).toBe('root');
    expect(other.state).toBe('forwarding');
    expect(bridgeRow(indirect.sim, alt2.other)!.rootId).toBe(bridgeRow(indirect.sim, 'sw1')!.bridgeId);
    const t = transitions(events(indirect.sim), alt2.device).filter((x) => x.t >= T && x.port === GI2);
    expect(t.map((x) => `${x.from}>${x.to}`)).toEqual(['alternate>designated', 'discarding>forwarding']);
    expect(t[1]!.cause).toBe('agreement received');
    expect(indirect.sim.runToIdle().stopped).toBeUndefined();
  });

  it('a non-edge host port gets no agreement and falls back to the forward-delay timers: forwarding at link-up + 30 s', () => {
    const sim = stpWorld();
    sim.addDevice({ id: 'sw1', type: SWITCH, name: 'SW1', startupConfig: switchConfig('SW1', RAPID, [section(`interface ${FA1}`, ['spanning-tree portfast'])]) });
    sim.addDevice({ id: 'pc1', type: PC, name: 'PC1', startupConfig: pcConfig('PC1', '10.0.0.1', '255.255.255.0') });
    sim.addDevice({ id: 'pc2', type: PC, name: 'PC2', startupConfig: pcConfig('PC2', '10.0.0.2', '255.255.255.0') });
    sim.addLink({ a: { device: 'pc1', port: 'GigabitEthernet0' }, b: { device: 'sw1', port: FA1 } });
    const l2 = sim.addLink({ a: { device: 'pc2', port: 'GigabitEthernet0' }, b: { device: 'sw1', port: FA2 } });
    sim.runUntil(31 * SEC);
    const up = linkUpAt(events(sim), l2);
    expect(portRow(sim, 'sw1', FA1)!.state).toBe('forwarding');
    expect(portRow(sim, 'sw1', FA1)!.edge).toBe(true);
    const host = portRow(sim, 'sw1', FA2)!;
    expect(host.edge).toBe(false);
    expect(host.role).toBe('designated');
    expect(host.state).toBe('discarding');
    expect(host.nextTransitionAt).toBe(up + 15 * SEC);
    // the port proposes on its point-to-point link, and the host never answers
    const proposals = bpduTx(events(sim), 'sw1', FA2).map((e) => sim.pdu(e.pdu.id)!).filter((p) => String(p.get('stp.flagsText')).includes('P'));
    expect(proposals.length).toBeGreaterThan(0);
    sim.runUntil(up + 16 * SEC);
    expect(portRow(sim, 'sw1', FA2)!.state).toBe('learning');
    sim.runUntil(up + 30 * SEC + 10 * MS);
    const fwd = portRow(sim, 'sw1', FA2)!;
    expect(fwd.state).toBe('forwarding');
    expect(fwd.stateSince - up).toBeGreaterThanOrEqual(30 * SEC);
    expect(fwd.stateSince - up).toBeLessThanOrEqual(30 * SEC + 10 * MS);
    expect(transitions(events(sim), 'sw1').filter((t) => t.port === FA2).map((t) => `${t.from}>${t.to}`)).toEqual([
      'disabled>discarding',
      'discarding>learning',
      'learning>forwarding',
    ]);
  });

  it('a half-duplex (hub-backed) link is shared: no proposal, 30 s fallback on both ends', () => {
    const sim = stpWorld();
    sim.addDevice({ id: 'sw1', type: SWITCH, name: 'SW1', startupConfig: switchConfig('SW1', [...RAPID, 'spanning-tree vlan 1 priority 4096']) });
    sim.addDevice({ id: 'sw2', type: SWITCH, name: 'SW2', startupConfig: switchConfig('SW2', RAPID) });
    sim.addDevice({ id: 'hub', type: 'hub.nfhub4', name: 'HUB' });
    const l1 = sim.addLink({ a: { device: 'sw1', port: FA1 }, b: { device: 'hub', port: 'Ethernet1' } });
    sim.addLink({ a: { device: 'sw2', port: FA1 }, b: { device: 'hub', port: 'Ethernet2' } });
    sim.runUntil(32 * SEC);
    const up = linkUpAt(events(sim), l1);
    expect(sim.device('sw1')!.portView(FA1)!.duplex).toBe('half');
    const desg = portRow(sim, 'sw1', FA1)!;
    expect(desg.role).toBe('designated');
    expect(desg.state).toBe('discarding');
    expect(desg.nextTransitionAt).toBe(up + 15 * SEC);
    const proposals = bpduTx(events(sim), 'sw1', FA1).map((e) => sim.pdu(e.pdu.id)!).filter((p) => String(p.get('stp.flagsText')).includes('P'));
    expect(proposals).toHaveLength(0);
    // the root port on a shared link forwards at once (802.1w root ports are not gated by the link type)
    expect(portRow(sim, 'sw2', FA1)!.role).toBe('root');
    sim.runUntil(up + 30 * SEC + 10 * MS);
    expect(portRow(sim, 'sw1', FA1)!.state).toBe('forwarding');
    expect(portRow(sim, 'sw1', FA1)!.stateSince).toBe(up + 30 * SEC);
  });

  it('a better root joining a converged switch synchronises its designated ports once (ROOT_PROPOSED then ROOT_AGREED, 802.1D-2004 §17.29.3)', () => {
    const { sim } = rapidTriangle();
    sim.runUntil(60 * SEC);
    const STATES = ['discarding', 'learning', 'forwarding', 'disabled'];
    const wasForwarding = { [GI1]: portRow(sim, 'sw2', GI1)!.state === 'forwarding', [GI2]: portRow(sim, 'sw2', GI2)!.state === 'forwarding' };
    sim.addDevice({ id: 'sw4', type: SWITCH, name: 'SW4', startupConfig: switchConfig('SW4', [...RAPID, 'spanning-tree vlan 1 priority 0']) });
    const link = sim.addLink({ a: { device: 'sw4', port: GI1 }, b: { device: 'sw2', port: FA2 } });
    const T = sim.now;
    sim.runUntil(T + 35 * SEC);
    const evs = events(sim);
    const up = linkUpAt(evs, link);
    expect(bridgeRow(sim, 'sw4')!.isRoot).toBe(true);
    expect(portRow(sim, 'sw2', FA2)!.role).toBe('root');
    // SW4's designated port keeps proposing until it forwards; SW2's root port answers every proposal with an
    // agreement but re-synchronises its designated ports only for the first one
    const after = transitions(evs, 'sw2').filter((t) => t.t >= T && STATES.includes(t.from) && STATES.includes(t.to));
    for (const port of [GI1, GI2]) {
      const mine = after.filter((t) => t.port === port).map((t) => `${t.from}>${t.to}`);
      // a forwarding designated port is synchronised (discarding) once and forwards again once; the alternate
      // port that becomes designated forwards once and is never bounced
      expect(mine, port).toEqual(wasForwarding[port] ? ['forwarding>discarding', 'discarding>forwarding'] : ['discarding>forwarding']);
    }
    expect(portRow(sim, 'sw2', GI1)!.state).toBe('forwarding');
    expect(portRow(sim, 'sw2', GI2)!.state).toBe('forwarding');
    const agreements = bpduTx(evs, 'sw2', FA2).filter((e) => e.t >= T).map((e) => sim.pdu(e.pdu.id)!).filter((p) => String(p.get('stp.flagsText')).split(',').includes('AG'));
    expect(agreements.length).toBeGreaterThanOrEqual(1);
    // SW4's port forwards within 1 s of link-up without a forward-delay timer
    const sw4 = portRow(sim, 'sw4', GI1)!;
    expect(sw4.state).toBe('forwarding');
    expect(sw4.stateSince - up).toBeLessThan(1 * SEC);
  });
});
