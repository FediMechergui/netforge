/**
 * P2 acceptance — Rapid PVST+ (ARCHITECTURE-P2 §3.6 "Rapid PVST+" and "Mixed modes", §10.1 row `accept.p2.stp-rapid`),
 * on real P2-profile worlds of `test/p2.world.ts` (the W3 `stp.harness` triangle with `spanning-tree mode
 * rapid-pvst` and PortFast on the PC ports).
 *
 *  • the same final roles as PVST+; every port in its final state within 1 s of the last link-up; no inter-switch
 *    port ever waits on a forward-delay timer — a designated port may arm `fwd:<vlan>:<port>` at link-up as the
 *    no-agreement fallback 802.1w requires, but the agreement cancels it, so every inter-switch port's
 *    `nextTransitionAt` is clear within 1 s of link-up and no inter-switch port transitions on a timer expiry
 *    (no `forward delay expired` transition there; every forwarding transition is the handshake's: `agreement
 *    received` on a designated port, the accepted proposal on a root port); the SW2→SW3 proposal is answered by the
 *    alternate port with an agreement;
 *  • direct failure: the alternate forwards at T + propagation (< 1 ms); indirect failure: the former alternate
 *    forwards before T + 1 s;
 *  • a PC port without PortFast reaches forwarding at link-up + 30 s ± 10 ms; a half-duplex (hub-backed) link falls
 *    back to 30 s;
 *  • mixed: an NF-C2960 (pvst) linked to an NF-C9300 (rapid by model default): the C9300's port shows `protocol:
 *    'stp'` after the migrate delay and forwards 30 s after link-up; rapid-only links converge within 1 s; `clear
 *    spanning-tree detected-protocols` returns the port to `rstp` and it migrates back to `stp`.
 *
 * The forward-delay clause is the §10.1 row as amended by the architect's ruling of 2026-09-23 (the earlier wording,
 * "no `fwd:` timer ever armed", is superseded: the same row's full-duplex host port without PortFast needs exactly
 * that timer, armed at link-up, to reach forwarding at link-up + 30 s).
 */
import { describe, expect, it } from 'vitest';
import { MS, SEC } from '../src/contracts/time.js';
import { CAUSE_MIGRATION_CLEARED, STP_MIGRATE_DELAY_NS } from '../src/protocols/stp/mixed.js';
import { CAUSE_FORWARD_DELAY_EXPIRED } from '../src/protocols/stp/pvst.js';
import { CAUSE_AGREEMENT_RECEIVED, CAUSE_PROPOSAL_ACCEPTED, CAUSE_REROOT } from '../src/protocols/stp/rstp.js';
import { pcConfig } from '../src/sim/scenarios/templates.js';
import {
  FA1,
  FA2,
  GI1,
  GI2,
  MLS,
  PC,
  SWITCH,
  alternateEnd,
  bpduTx,
  bridgeRow,
  events,
  linkUpAt,
  ofKind,
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
const M1 = 'GigabitEthernet1/0/1';
const M2 = 'GigabitEthernet1/0/2';

function rapidTriangle(sim = stpWorld()) {
  return triangle(sim, { all: RAPID, sections: { sw1: PORTFAST, sw2: PORTFAST, sw3: PORTFAST } });
}

describe('accept P2 stp-rapid: the triangle', () => {
  it('converges within 1 s of link-up with the PVST+ roles, by proposal/agreement only on the inter-switch links', () => {
    const { sim, links } = rapidTriangle();
    sim.runUntil(31 * SEC);
    const evs = events(sim);
    const up = Math.max(linkUpAt(evs, links.sw1sw2), linkUpAt(evs, links.sw1sw3), linkUpAt(evs, links.sw2sw3));
    expect(bridgeRow(sim, 'sw1')).toMatchObject({ isRoot: true, mode: 'rapid-pvst' });
    const all = [...portRows(sim, 'sw1'), ...portRows(sim, 'sw2'), ...portRows(sim, 'sw3')];
    expect(all).toHaveLength(9);
    const alt = alternateEnd(sim);
    const blocked = all.filter((r) => r.state !== 'forwarding');
    expect(blocked).toHaveLength(1);
    expect(blocked[0]).toBe(portRow(sim, alt.device, GI2));
    expect(blocked[0]).toMatchObject({ role: 'alternate', state: 'discarding' });
    expect(portRow(sim, alt.other, GI2)!.role).toBe('designated');
    for (const r of all) {
      expect(r.protocol).toBe('rstp');
      expect(r.stateSince - up, `${r.port} VLAN ${r.vlan}`).toBeLessThan(1 * SEC);
      expect(r.nextTransitionAt).toBeUndefined();
    }
    // the last transition on an inter-switch port: the handshake is over by then
    const settled = Math.max(...['sw1', 'sw2', 'sw3'].flatMap((d) => transitions(evs, d).filter((t) => t.port === GI1 || t.port === GI2).map((t) => t.t)));
    expect(settled - up).toBeLessThan(1 * SEC);
    for (const d of ['sw1', 'sw2', 'sw3']) {
      expect(portRow(sim, d, FA1)).toMatchObject({ edge: true, state: 'forwarding', stateSince: up });
      // the forward-delay timers never drove a transition on the inter-switch links: the handshake made every one —
      // a designated port forwards on the agreement, a root port when it accepts the proposal (§3.6 Rapid step 3)
      const inter = transitions(evs, d).filter((t) => t.port === GI1 || t.port === GI2);
      expect(inter.filter((t) => t.cause === CAUSE_FORWARD_DELAY_EXPIRED)).toEqual([]);
      const toForwarding = inter.filter((t) => t.to === 'forwarding');
      expect(toForwarding.length).toBeGreaterThan(0);
      for (const t of toForwarding) {
        const role = portRow(sim, d, t.port!)!.role;
        expect([CAUSE_AGREEMENT_RECEIVED, CAUSE_REROOT, CAUSE_PROPOSAL_ACCEPTED], `${d} ${t.port} ${role}`).toContain(t.cause);
        if (role === 'designated') expect(t.cause, `${d} ${t.port}`).toBe(CAUSE_AGREEMENT_RECEIVED);
        else expect(role, `${d} ${t.port}`).toBe('root');
      }
      // no forward-delay countdown survives the handshake on an inter-switch port: none is pending once it is over
      const later = stpRowWrites(evs, d).filter((r) => (r.port === GI1 || r.port === GI2) && r.updatedAt >= settled);
      expect(later.filter((r) => r.nextTransitionAt !== undefined), d).toEqual([]);
    }
    // the SW2→SW3 proposal is answered by the alternate port with an agreement (ALTERNATE_AGREED)
    const flags = (id: number): string[] => String(sim.pdu(id)!.get('stp.flagsText')).split(',');
    const proposals = bpduTx(evs, alt.other, GI2).filter((e) => flags(e.pdu.id).includes('P'));
    expect(proposals.length).toBeGreaterThan(0);
    const agreements = bpduTx(evs, alt.device, GI2).filter((e) => flags(e.pdu.id).includes('AG'));
    expect(agreements.length).toBeGreaterThan(0);
    // sent by the port in its alternate role (role bits 'A'), after a proposal reached it
    expect(flags(agreements[0]!.pdu.id)).toContain('A');
    expect(agreements[0]!.t).toBeGreaterThan(proposals[0]!.t);
    const designatedForwards = transitions(evs, alt.other).find((t) => t.port === GI2 && t.to === 'forwarding')!;
    expect(designatedForwards.cause).toBe(CAUSE_AGREEMENT_RECEIVED);
    expect(designatedForwards.t).toBeGreaterThan(agreements[0]!.t);
    // still converged and countdown-free a minute later
    sim.runUntil(90 * SEC);
    for (const d of ['sw1', 'sw2', 'sw3']) for (const r of portRows(sim, d)) expect(r.nextTransitionAt, `${d} ${r.port}`).toBeUndefined();
    expect(portRows(sim, alt.device).find((r) => r.port === GI2)!.state).toBe('discarding');
  });

  it('no inter-switch port ever waits on a forward-delay timer (§10.1 row, architect ruling 2026-09-23): a fallback armed at link-up is cleared within 1 s, and none transitions on a `fwd:` expiry', () => {
    const { sim, links } = rapidTriangle();
    // past link-up + 2 × forward delay: a countdown that had survived the handshake would have fired by now
    sim.runUntil(90 * SEC);
    const evs = events(sim);
    const up = Math.max(linkUpAt(evs, links.sw1sw2), linkUpAt(evs, links.sw1sw3), linkUpAt(evs, links.sw2sw3));
    for (const d of ['sw1', 'sw2', 'sw3']) {
      // the row's `nextTransitionAt` is the trace of an armed forward-delay timer (tables.ts StpPortRow)
      const writes = stpRowWrites(evs, d).filter((r) => r.port === GI1 || r.port === GI2);
      expect(writes.length, d).toBeGreaterThan(0);
      // a countdown appears only as the fallback, within 1 s of link-up …
      for (const r of writes.filter((w) => w.nextTransitionAt !== undefined)) expect(r.updatedAt - up, `${d} ${r.key}`).toBeLessThan(1 * SEC);
      // … and every inter-switch port's last row written within 1 s of link-up has none
      const settled = new Map<string, (typeof writes)[number]>();
      for (const r of writes) if (r.updatedAt < up + 1 * SEC) settled.set(r.key, r);
      expect(settled.size, d).toBe(2);
      for (const [key, r] of settled) expect(r.nextTransitionAt, `${d} ${key}`).toBeUndefined();
      // no inter-switch port transitions on a timer expiry, then or later
      const inter = transitions(evs, d).filter((t) => t.port === GI1 || t.port === GI2);
      expect(inter.length, d).toBeGreaterThan(0);
      expect(inter.filter((t) => t.cause === CAUSE_FORWARD_DELAY_EXPIRED), d).toEqual([]);
      for (const r of portRows(sim, d).filter((x) => x.port === GI1 || x.port === GI2)) expect(r.nextTransitionAt, `${d} ${r.port}`).toBeUndefined();
    }
  });

  it('direct failure: the alternate forwards within propagation (< 1 ms); indirect failure: the former alternate forwards before T + 1 s', () => {
    const direct = rapidTriangle();
    direct.sim.runUntil(100 * SEC);
    const alt = alternateEnd(direct.sim);
    const T = 100 * SEC;
    direct.sim.removeLink(alt.device === 'sw2' ? direct.links.sw1sw2 : direct.links.sw1sw3);
    direct.sim.runUntil(T + 1 * MS);
    const r = portRow(direct.sim, alt.device, GI2)!;
    expect(r.role).toBe('root');
    expect(r.state).toBe('forwarding');
    expect(r.stateSince - T).toBeLessThan(1 * MS);
    expect(bridgeRow(direct.sim, alt.device)!.topologyChanges).toBeGreaterThan(1);
    expect(direct.sim.runToIdle().stopped).toBeUndefined();
    expect(ping(direct.sim, 'pc2', '10.0.0.3').text).toContain('Sent 5, received 5, lost 0');

    const indirect = rapidTriangle();
    indirect.sim.runUntil(100 * SEC);
    const alt2 = alternateEnd(indirect.sim);
    indirect.sim.removeLink(alt2.other === 'sw2' ? indirect.links.sw1sw2 : indirect.links.sw1sw3);
    indirect.sim.runUntil(T + 1 * SEC);
    const former = portRow(indirect.sim, alt2.device, GI2)!;
    expect(former.role).toBe('designated');
    expect(former.state).toBe('forwarding');
    expect(former.stateSince - T).toBeLessThan(1 * SEC);
    expect(portRow(indirect.sim, alt2.other, GI2)).toMatchObject({ role: 'root', state: 'forwarding' });
    expect(bridgeRow(indirect.sim, alt2.other)!.rootId).toBe(bridgeRow(indirect.sim, 'sw1')!.bridgeId);
    expect(transitions(events(indirect.sim), alt2.device).filter((x) => x.t >= T && x.port === GI2).map((x) => `${x.from}>${x.to}`)).toEqual(['alternate>designated', 'discarding>forwarding']);
    expect(indirect.sim.runToIdle().stopped).toBeUndefined();
    expect(ping(indirect.sim, 'pc2', '10.0.0.3').text).toContain('Sent 5, received 5, lost 0');
  });

  it('a PC port without PortFast forwards at link-up + 30 s ± 10 ms; a hub-backed (half-duplex) link falls back to 30 s', () => {
    const sim = stpWorld();
    sim.addDevice({ id: 'sw1', type: SWITCH, name: 'SW1', startupConfig: switchConfig('SW1', RAPID, PORTFAST) });
    sim.addDevice({ id: 'pc1', type: PC, name: 'PC1', startupConfig: pcConfig('PC1', '10.0.0.1', '255.255.255.0') });
    sim.addDevice({ id: 'pc2', type: PC, name: 'PC2', startupConfig: pcConfig('PC2', '10.0.0.2', '255.255.255.0') });
    sim.addLink({ a: { device: 'pc1', port: 'GigabitEthernet0' }, b: { device: 'sw1', port: FA1 } });
    const l2 = sim.addLink({ a: { device: 'pc2', port: 'GigabitEthernet0' }, b: { device: 'sw1', port: FA2 } });
    sim.runUntil(31 * SEC);
    const up = linkUpAt(events(sim), l2);
    expect(portRow(sim, 'sw1', FA1)).toMatchObject({ edge: true, state: 'forwarding' });
    expect(portRow(sim, 'sw1', FA2)).toMatchObject({ edge: false, role: 'designated', state: 'discarding' });
    sim.runUntil(up + 30 * SEC + 10 * MS);
    const host = portRow(sim, 'sw1', FA2)!;
    expect(host.state).toBe('forwarding');
    expect(host.stateSince - up).toBeGreaterThanOrEqual(30 * SEC - 10 * MS);
    expect(host.stateSince - up).toBeLessThanOrEqual(30 * SEC + 10 * MS);

    const shared = stpWorld();
    shared.addDevice({ id: 'sw1', type: SWITCH, name: 'SW1', startupConfig: switchConfig('SW1', [...RAPID, 'spanning-tree vlan 1 priority 4096']) });
    shared.addDevice({ id: 'sw2', type: SWITCH, name: 'SW2', startupConfig: switchConfig('SW2', RAPID) });
    shared.addDevice({ id: 'hub', type: 'hub.nfhub4', name: 'HUB' });
    const l1 = shared.addLink({ a: { device: 'sw1', port: FA1 }, b: { device: 'hub', port: 'Ethernet1' } });
    shared.addLink({ a: { device: 'sw2', port: FA1 }, b: { device: 'hub', port: 'Ethernet2' } });
    shared.runUntil(32 * SEC);
    const hubUp = linkUpAt(events(shared), l1);
    expect(shared.device('sw1')!.portView(FA1)!.duplex).toBe('half');
    expect(portRow(shared, 'sw1', FA1)).toMatchObject({ role: 'designated', state: 'discarding', nextTransitionAt: hubUp + 15 * SEC });
    shared.runUntil(hubUp + 30 * SEC + 10 * MS);
    expect(portRow(shared, 'sw1', FA1)!.state).toBe('forwarding');
    expect(portRow(shared, 'sw1', FA1)!.stateSince - hubUp).toBeGreaterThanOrEqual(30 * SEC - 10 * MS);
    expect(portRow(shared, 'sw1', FA1)!.stateSince - hubUp).toBeLessThanOrEqual(30 * SEC + 10 * MS);
  });
});

describe('accept P2 stp-rapid: mixed pvst / rapid-pvst', () => {
  /** MLS1 (NF-C9300, rapid, priority 4096) — SW2 (NF-C2960, pvst) on M1; MLS2 (rapid) on M2. */
  function mixedWorld(legacyRoot = false) {
    const sim = stpWorld();
    sim.addDevice({ id: 'mls1', type: MLS, name: 'MLS1', startupConfig: switchConfig('MLS1', legacyRoot ? [] : ['spanning-tree vlan 1 priority 4096']) });
    sim.addDevice({ id: 'sw2', type: SWITCH, name: 'SW2', startupConfig: switchConfig('SW2', legacyRoot ? ['spanning-tree vlan 1 priority 4096'] : []) });
    sim.addDevice({ id: 'mls2', type: MLS, name: 'MLS2', startupConfig: switchConfig('MLS2') });
    const legacy = sim.addLink({ a: { device: 'mls1', port: M1 }, b: { device: 'sw2', port: GI1 } });
    const rapid = sim.addLink({ a: { device: 'mls1', port: M2 }, b: { device: 'mls2', port: M1 } });
    return { sim, legacy, rapid };
  }

  it('the C9300 port facing the C2960 migrates to 802.1D after the migrate delay and forwards 30 s after link-up; the rapid link converges within 1 s', () => {
    const { sim, legacy, rapid } = mixedWorld();
    sim.runUntil(41 * SEC);
    const evs = events(sim);
    const up = linkUpAt(evs, legacy);
    expect(linkUpAt(evs, rapid)).toBe(up);
    expect(bridgeRow(sim, 'mls1')).toMatchObject({ mode: 'rapid-pvst', isRoot: true });
    expect(bridgeRow(sim, 'sw2')!.mode).toBe('pvst');
    expect(portRow(sim, 'mls1', M2)).toMatchObject({ state: 'forwarding', protocol: 'rstp' });
    expect(portRow(sim, 'mls2', M1)).toMatchObject({ state: 'forwarding', role: 'root', protocol: 'rstp' });
    expect(portRow(sim, 'mls1', M2)!.stateSince - up).toBeLessThan(1 * SEC);
    sim.runUntil(up + 6 * SEC);
    expect(portRow(sim, 'mls1', M1)!.protocol).toBe('stp');
    const migrated = transitions(events(sim), 'mls1').find((t) => t.port === M1 && t.from === 'rstp' && t.to === 'stp')!;
    expect(migrated.t - up).toBeGreaterThanOrEqual(STP_MIGRATE_DELAY_NS);
    expect(portRow(sim, 'mls1', M2)!.protocol).toBe('rstp');
    sim.runUntil(up + 30 * SEC + 10 * MS);
    expect(portRow(sim, 'mls1', M1)).toMatchObject({ state: 'forwarding', stateSince: up + 30 * SEC, protocol: 'stp' });
    expect(portRow(sim, 'sw2', GI1)).toMatchObject({ state: 'forwarding', stateSince: up + 30 * SEC, role: 'root' });
  });

  it('clear spanning-tree detected-protocols returns the port to rstp; the legacy neighbour migrates it back to stp', () => {
    const { sim } = mixedWorld(true);
    sim.runUntil(80 * SEC);
    expect(bridgeRow(sim, 'sw2')!.isRoot).toBe(true);
    expect(portRow(sim, 'mls1', M1)).toMatchObject({ role: 'root', protocol: 'stp', state: 'forwarding' });
    // typed at the C9300's console (§5.4), first for the one port, then for every port
    const session = sim.cli.open('mls1', 'console');
    expect(sim.cli.exec(session, 'enable').error).toBeUndefined();
    for (const line of [`clear spanning-tree detected-protocols interface ${M1}`, 'clear spanning-tree detected-protocols']) {
      const T = sim.now;
      const r = sim.cli.exec(session, line);
      expect(r.error, line).toBeUndefined();
      expect(portRow(sim, 'mls1', M1)!.protocol, line).toBe('rstp');
      expect(portRow(sim, 'mls1', M1)!.state, line).toBe('forwarding');
      const back = transitions(events(sim), 'mls1').filter((t) => t.t === T && t.port === M1 && t.from === 'stp' && t.to === 'rstp');
      expect(back, line).toHaveLength(1);
      expect(back[0]!.cause, line).toBe(CAUSE_MIGRATION_CLEARED);
      // the neighbour still speaks 802.1D: after the migrate delay its next BPDU migrates the port back
      sim.runUntil(T + STP_MIGRATE_DELAY_NS + 2 * SEC + 1);
      expect(portRow(sim, 'mls1', M1)!.protocol, line).toBe('stp');
      expect(portRow(sim, 'mls1', M2)!.protocol, line).toBe('rstp');
    }
    expect(sim.runToIdle().stopped).toBeUndefined();
  });
});

/** Ping helper shared with the pvst file (the sim harness one). */
function ping(sim: ReturnType<typeof stpWorld>, device: string, target: string): { text: string } {
  const cursor = sim.trace(0).next;
  const session = sim.cli.open(device, 'console');
  sim.cli.exec(session, `ping ${target}`);
  sim.runToIdle();
  let text = '';
  for (const e of ofKind(sim.trace(cursor).events, 'cliOutput')) if (e.session === session) text += e.text;
  return { text };
}
