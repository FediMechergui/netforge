/**
 * P3 acceptance — where filtering happens (ARCHITECTURE-P3 §10.1 `accept.p3.acl-order`; D12, §3.0 (a) steps 2, 3, 6
 * and 7, §3.3 step 7; §7 W4 qa).
 *
 * Real worlds on `staged.world` at stage P3 with every approved P3 daemon registered (the catalog flip is a later,
 * separate step; after it the overlay is a no-op):
 *
 *   PC1 192.168.1.10 ── Gi0/0 R1 (ip nat inside) 192.168.1.1     Gi0/1 (ip nat outside) 203.0.113.1 ── SRV 203.0.113.10
 *
 * R1 overloads `access-list 1` (192.168.1.0/24) on Gi0/1 (the same world without any NAT line for the plain cases);
 * lists are applied and swapped through R1's CLI.
 *   • an outside INBOUND list runs before NAT inbound: it sees the global address (a list naming the inside local
 *     address matches nothing), and a packet it denies never reaches NAT (no NAT write, no translation);
 *   • an outside OUTBOUND list runs after NAT outbound: it sees the translated source (a list naming the inside local
 *     source matches nothing), NAT's row exists after its deny, and no ICMP is sent for it;
 *   • without NAT an outbound deny's ICMP 3/13 is sourced from the ingress interface;
 *   • locally originated packets are never filtered outbound (the very packets a list denies when forwarded);
 *   • an inbound implicit deny blocks relayed DHCP broadcasts (source 0.0.0.0): nothing is relayed, the client falls
 *     back to a link-local address; permitting 0.0.0.0 lets the relay work.
 */
import { describe, expect, it } from 'vitest';
import type { Simulation } from '../src/contracts/simulation.js';
import { aclKey, natKey, type DhcpBindingRow, type NatRow } from '../src/contracts/tables.js';
import { SEC } from '../src/contracts/time.js';
import type { TraceEvent } from '../src/contracts/trace.js';
import { PING_COUNT } from '../src/cli/handlers/exec.js';
import { ofKind } from './sim.harness.js';
import {
  GI0,
  GI1,
  MASK24,
  PC_PORT,
  aclRow,
  aclRows,
  aclWorld,
  adminProhibited,
  cfg,
  dropsAt,
  hostConfig,
  mark,
  pingFrom,
  pingMarks,
  routedPort,
  routerConfig,
  since,
  writesOf,
} from './accept.p3.acl.harness.js';

const PC1 = '192.168.1.10';
const SRV = '203.0.113.10';
const R1_IN = '192.168.1.1';
const R1_OUT = '203.0.113.1';

/** The world of the file header, booted and settled; without `nat` R1 holds no NAT line at all. */
function natWorld(seed: number, nat = true): Simulation {
  const sim = aclWorld(seed);
  sim.addDevice({ id: 'pc1', type: 'pc.nfpc', name: 'PC1', startupConfig: hostConfig('PC1', PC1, R1_IN) });
  sim.addDevice({ id: 'srv', type: 'server.nfserver', name: 'SRV', startupConfig: hostConfig('SRV', SRV, R1_OUT) });
  sim.addDevice({
    id: 'r1',
    type: 'router.nf2911',
    name: 'R1',
    startupConfig: routerConfig(
      'R1',
      nat
        ? [
            routedPort(GI0, R1_IN, MASK24, ['ip nat inside']),
            routedPort(GI1, R1_OUT, MASK24, ['ip nat outside']),
            ['access-list 1 permit 192.168.1.0 0.0.0.255', `ip nat inside source list 1 interface ${GI1} overload`],
          ]
        : [routedPort(GI0, R1_IN, MASK24), routedPort(GI1, R1_OUT, MASK24)],
    ),
  });
  sim.addLink({ a: { device: 'pc1', port: PC_PORT }, b: { device: 'r1', port: GI0 } });
  sim.addLink({ a: { device: 'r1', port: GI1 }, b: { device: 'srv', port: PC_PORT } });
  sim.runFor(60 * SEC);
  sim.runToIdle();
  return sim;
}

const natRows = (sim: Simulation): NatRow[] => sim.device('r1')!.tables.get<NatRow>('nat')!.rows();

/** nat's debug lines (category `ip nat`) that report a translation in one direction (`out …` / `in …`). */
function natLines(evs: readonly TraceEvent[], dir: 'out' | 'in'): string[] {
  return ofKind(evs, 'debug')
    .filter((d) => d.event.device === 'r1' && d.event.category === 'ip nat' && d.event.message.startsWith(`${dir} `))
    .map((d) => d.event.message);
}

describe('accept P3: ACL order with NAT (§3.3 step 7)', () => {
  it('an outside inbound list sees global addresses; a packet it denies never reaches NAT', () => {
    const sim = natWorld(61);
    cfg(sim, 'r1', [
      'ip access-list extended SEES-GLOBAL',
      `deny icmp host ${SRV} host ${R1_OUT} echo-reply`,
      'permit ip any any',
      'exit',
      'ip access-list extended NAMES-LOCAL',
      `deny icmp host ${SRV} host ${PC1} echo-reply`,
      'permit ip any any',
      'exit',
      `interface ${GI1}`,
      'ip access-group SEES-GLOBAL in',
    ]);

    // the replies come back to the global address 203.0.113.1, so entry 10 matches them before NAT translates
    const denied = pingFrom(sim, 'pc1', SRV);
    expect(denied.text).toContain(`Sent ${PING_COUNT}, received 0`);
    const drops = dropsAt(denied.evs, 'r1', 'acl-deny');
    expect(drops).toHaveLength(PING_COUNT);
    for (const d of drops) {
      expect([d.port, d.rule?.dir, d.rule?.list, d.rule?.seq]).toEqual([GI1, 'in', 'SEES-GLOBAL', 10]);
      const pdu = sim.pdu(d.pdu.id)!;
      expect([pdu.get('ipv4.src'), pdu.get('ipv4.dst'), pdu.get('icmpv4.type')]).toEqual([SRV, R1_OUT, 0]);
    }
    expect(aclRow(sim, 'r1', aclKey(4, 'SEES-GLOBAL', 10))!.matches).toBe(PING_COUNT);
    // NAT saw only the outbound requests: one row created then refreshed by each request; no reply was translated
    expect(natLines(denied.evs, 'out')).toHaveLength(PING_COUNT);
    expect(natLines(denied.evs, 'in')).toEqual([]);
    expect(writesOf(denied.evs, 'r1', 'nat')).toHaveLength(PING_COUNT);
    const rows = natRows(sim);
    expect(rows.map((r) => [r.kind, r.proto, r.insideLocal, r.insideGlobal, r.outsideGlobal])).toEqual([['overload', 'icmp', PC1, R1_OUT, SRV]]);
    // an inbound deny is answered towards the packet's source (SRV), from the input interface
    const errors = adminProhibited(sim, denied.evs, 'r1');
    expect(errors.length).toBeGreaterThan(0);
    for (const e of errors) expect([e.pdu.get('ipv4.src'), e.pdu.get('ipv4.dst')]).toEqual([R1_OUT, SRV]);

    // a list that names the inside local address never matches inbound: the replies pass and NAT translates them
    cfg(sim, 'r1', [`interface ${GI1}`, 'ip access-group NAMES-LOCAL in']);
    expect(aclRows(sim, 'r1').map((r) => r.list)).toEqual(['NAMES-LOCAL', 'NAMES-LOCAL', 'NAMES-LOCAL']);
    const passed = pingFrom(sim, 'pc1', SRV);
    expect(passed.text).toContain(`Sent ${PING_COUNT}, received ${PING_COUNT}, lost 0`);
    expect(aclRow(sim, 'r1', aclKey(4, 'NAMES-LOCAL', 10))!.matches).toBe(0);
    expect(aclRow(sim, 'r1', aclKey(4, 'NAMES-LOCAL', 20))!.matches).toBe(PING_COUNT);
    expect(natLines(passed.evs, 'in')).toHaveLength(PING_COUNT);
    expect(dropsAt(passed.evs, 'r1', 'acl-deny')).toEqual([]);
  });

  it('an outside outbound list sees the translated source; NAT’s row exists after its deny; no ICMP is sent for it', () => {
    const sim = natWorld(63);
    cfg(sim, 'r1', [
      'ip access-list extended SEES-TRANSLATED',
      `deny icmp host ${R1_OUT} host ${SRV}`,
      'permit ip any any',
      'exit',
      'ip access-list extended NAMES-INSIDE',
      `deny icmp host ${PC1} any`,
      'permit ip any any',
      'exit',
      `interface ${GI1}`,
      'ip access-group SEES-TRANSLATED out',
    ]);
    // R1's own ping carries exactly the source and destination entry 10 denies: locally originated, never filtered
    // (sent first, while no NAT row holds R1's address and an ICMP id its replies could match)
    const own = pingFrom(sim, 'r1', SRV);
    expect(pingMarks(own.text)).toBe('!'.repeat(PING_COUNT));
    expect(dropsAt(own.evs, 'r1', 'acl-deny')).toEqual([]);
    expect(writesOf(own.evs, 'r1', 'acl')).toEqual([]);
    const ownRequests = ofKind(own.evs, 'pduCreated').filter((e) => e.device === 'r1' && sim.pdu(e.pdu.id)?.get('icmpv4.type') === 8);
    expect(ownRequests.map((e) => sim.pdu(e.pdu.id)!.get('ipv4.src'))).toEqual(Array.from({ length: PING_COUNT }, () => R1_OUT));
    expect(natRows(sim)).toEqual([]);

    const denied = pingFrom(sim, 'pc1', SRV);
    expect(denied.text).toContain(`Sent ${PING_COUNT}, received 0`);
    expect(pingMarks(denied.text)).toBe('.'.repeat(PING_COUNT));
    const drops = dropsAt(denied.evs, 'r1', 'acl-deny');
    expect(drops).toHaveLength(PING_COUNT);
    for (const d of drops) {
      expect([d.port, d.rule?.dir, d.rule?.list, d.rule?.seq]).toEqual([GI1, 'out', 'SEES-TRANSLATED', 10]);
      // the denied packet already carries the global source
      expect(sim.pdu(d.pdu.id)!.get('ipv4.src')).toBe(R1_OUT);
    }
    // NAT translated first: its row exists after the deny and is left to age out
    expect(natLines(denied.evs, 'out')).toHaveLength(PING_COUNT);
    const rows = natRows(sim);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: 'overload', proto: 'icmp', insideLocal: PC1, insideGlobal: R1_OUT, outsideGlobal: SRV });
    expect(rows[0]!.key).toBe(natKey('icmp', R1_OUT, rows[0]!.insideGlobalPort));
    expect(rows[0]!.expiresAt).toBeGreaterThan(sim.now);
    // no ICMP for a natted packet (its source is now the router's own address)
    expect(adminProhibited(sim, denied.evs, 'r1')).toEqual([]);
    expect(ofKind(denied.evs, 'pduCreated').filter((e) => e.device === 'r1' && e.process === 'icmpv4')).toEqual([]);
    expect(ofKind(denied.evs, 'pduCreated').filter((e) => e.device === 'srv' && e.process === 'icmpv4')).toEqual([]);

    // a list that names the inside local source never matches outbound: the requests pass
    cfg(sim, 'r1', [`interface ${GI1}`, 'ip access-group NAMES-INSIDE out']);
    const passed = pingFrom(sim, 'pc1', SRV);
    expect(passed.text).toContain(`Sent ${PING_COUNT}, received ${PING_COUNT}, lost 0`);
    expect(aclRow(sim, 'r1', aclKey(4, 'NAMES-INSIDE', 10))!.matches).toBe(0);
    expect(aclRow(sim, 'r1', aclKey(4, 'NAMES-INSIDE', 20))!.matches).toBe(PING_COUNT);
  });

  it('without NAT an outbound deny’s ICMP 3/13 is sourced from the ingress interface; locally originated packets are not filtered', () => {
    const sim = natWorld(65, false);
    cfg(sim, 'r1', ['ip access-list extended TO-SRV', `deny icmp any host ${SRV}`, 'permit ip any any', 'exit', `interface ${GI1}`, 'ip access-group TO-SRV out']);
    // no NAT anywhere: acl.filter straight from ipv4 after routing, with the ingress port Gi0/0 as inPort
    const denied = pingFrom(sim, 'pc1', SRV);
    expect(denied.text).toContain(`Sent ${PING_COUNT}, received 0`);
    expect(pingMarks(denied.text)).toBe('U.U.U');
    const drops = dropsAt(denied.evs, 'r1', 'acl-deny');
    expect(drops).toHaveLength(PING_COUNT);
    expect(drops.every((d) => d.port === GI1 && d.rule?.dir === 'out' && d.rule.seq === 10)).toBe(true);
    expect(natRows(sim)).toEqual([]);
    const errors = adminProhibited(sim, denied.evs, 'r1');
    expect(errors.length).toBeGreaterThan(0);
    // from Gi0/0's address, where the packet came in — not Gi0/1's, where it would have left
    for (const e of errors) expect([e.pdu.get('ipv4.src'), e.pdu.get('ipv4.dst')]).toEqual([R1_IN, PC1]);
    expect(errors).toHaveLength(pingMarks(denied.text).split('U').length - 1);
    expect(aclRow(sim, 'r1', aclKey(4, 'TO-SRV', 10))!.matches).toBe(PING_COUNT);

    // R1's own ping to SRV is exactly what entry 10 denies when forwarded: locally originated, never filtered outbound
    const own = pingFrom(sim, 'r1', SRV);
    expect(pingMarks(own.text)).toBe('!'.repeat(PING_COUNT));
    expect(dropsAt(own.evs, 'r1', 'acl-deny')).toEqual([]);
    expect(writesOf(own.evs, 'r1', 'acl')).toEqual([]);
    expect(aclRow(sim, 'r1', aclKey(4, 'TO-SRV', 10))!.matches).toBe(PING_COUNT);
    expect(sim.device('r1')!.port(GI1)!.counters.aclDenies).toBe(PING_COUNT);
  });
});

// ── an inbound implicit deny and the DHCP relay ───────────────────────────────────────────────────────────────────

const SRV1 = '10.0.0.10';
const R1_SRV1 = '10.0.0.1';

/** PC1 (DHCP client) ── R1 Gi0/0 (helper-address SRV1, inbound `access-list 10`) ── Gi0/1 ── SRV1 (a router with a pool). */
function relayWorld(seed: number, list: readonly string[]): Simulation {
  const sim = aclWorld(seed);
  sim.addDevice({ id: 'pc1', type: 'pc.nfpc', name: 'PC1', startupConfig: 'hostname PC1\n!\nend\n' });
  sim.addDevice({
    id: 'r1',
    type: 'router.nf2911',
    name: 'R1',
    startupConfig: routerConfig('R1', [routedPort(GI0, R1_IN, MASK24, [`ip helper-address ${SRV1}`, 'ip access-group 10 in']), routedPort(GI1, R1_SRV1, MASK24), [...list]]),
  });
  sim.addDevice({
    id: 'srv1',
    type: 'router.nf2911',
    name: 'SRV1',
    startupConfig: routerConfig('SRV1', [
      routedPort(GI0, SRV1, MASK24),
      [`ip route 192.168.1.0 ${MASK24} ${R1_SRV1}`, `ip dhcp excluded-address ${R1_IN}`],
      ['ip dhcp pool LAN', ' network 192.168.1.0 255.255.255.0', ` default-router ${R1_IN}`],
    ]),
  });
  sim.addLink({ a: { device: 'pc1', port: PC_PORT }, b: { device: 'r1', port: GI0 } });
  sim.addLink({ a: { device: 'r1', port: GI1 }, b: { device: 'srv1', port: GI0 } });
  sim.runFor(60 * SEC);
  sim.runToIdle();
  return sim;
}

/** The DHCP PDUs created since `from`: device, tag and message type. */
function dhcpFlight(sim: Simulation, evs: readonly TraceEvent[]): { device: string; tag: string; type: string; src: string }[] {
  return ofKind(evs, 'pduCreated')
    .filter((e) => (e.pdu.tag ?? '').startsWith('dhcp-'))
    .map((e) => ({ device: e.device, tag: e.pdu.tag!, type: String(sim.pdu(e.pdu.id)!.get('dhcp.messageType')), src: String(sim.pdu(e.pdu.id)!.get('ipv4.src')) }));
}

const bindings = (sim: Simulation): DhcpBindingRow[] => sim.device('srv1')!.tables.get<DhcpBindingRow>('dhcp-bindings')?.rows() ?? [];

describe('accept P3: an inbound implicit deny blocks relayed DHCP broadcasts', () => {
  it('the DISCOVERs (source 0.0.0.0) die at R1 by the implicit deny: nothing relayed, no ICMP, the client goes link-local', () => {
    const sim = relayWorld(67, ['access-list 10 permit 192.168.1.0 0.0.0.255']);
    const c = mark(sim);
    cfg(sim, 'pc1', ['ip address dhcp']);
    expect(sim.runToIdle(200_000).stopped).toBeUndefined();
    const evs = since(sim, c);
    const flight = dhcpFlight(sim, evs);
    // only the client spoke: every DISCOVER dropped at R1 Gi0/0 by the implicit deny, nothing left R1
    expect(flight.length).toBeGreaterThanOrEqual(2);
    expect(flight.every((f) => f.device === 'pc1' && f.type === 'DISCOVER' && f.src === '0.0.0.0')).toBe(true);
    const drops = dropsAt(evs, 'r1', 'acl-deny');
    expect(drops).toHaveLength(flight.length);
    for (const d of drops) {
      expect([d.port, d.detail, d.rule?.seq, d.rule?.key]).toEqual([GI0, 'ACL 10 implicit deny', 'implicit', aclKey(4, '10', 'implicit')]);
      expect(sim.pdu(d.pdu.id)!.get('ipv4.dst')).toBe('255.255.255.255');
    }
    expect(aclRow(sim, 'r1', aclKey(4, '10', 'implicit'))!.matches).toBe(flight.length);
    expect(aclRow(sim, 'r1', aclKey(4, '10', 10))!.matches).toBe(0);
    // a broadcast from 0.0.0.0 gets no ICMP, and the relay never ran
    expect(adminProhibited(sim, evs, 'r1')).toEqual([]);
    expect(ofKind(evs, 'pduCreated').filter((e) => e.device === 'r1' && (e.pdu.tag ?? '').startsWith('dhcp-'))).toEqual([]);
    expect(bindings(sim)).toEqual([]);
    expect(sim.device('pc1')!.port(PC_PORT)!.l3.ipv4?.origin).toBe('apipa');
  });

  it('permitting 0.0.0.0 lets the relay work: the DISCOVER and REQUEST count on that entry and the lease is bound', () => {
    const sim = relayWorld(69, ['access-list 10 permit host 0.0.0.0', 'access-list 10 permit 192.168.1.0 0.0.0.255']);
    const c = mark(sim);
    cfg(sim, 'pc1', ['ip address dhcp']);
    sim.runToIdle();
    const evs = since(sim, c);
    expect(dropsAt(evs, 'r1', 'acl-deny')).toEqual([]);
    expect(dhcpFlight(sim, evs).filter((f) => f.device === 'pc1').map((f) => f.type)).toEqual(['DISCOVER', 'REQUEST']);
    expect(aclRow(sim, 'r1', aclKey(4, '10', 10))!.matches).toBe(2);
    expect(sim.device('pc1')!.port(PC_PORT)!.l3.ipv4).toMatchObject({ address: '192.168.1.2', prefixLen: 24, origin: 'dhcp' });
    expect(bindings(sim).map((b) => [b.ip, b.state, b.relay])).toEqual([['192.168.1.2', 'bound', R1_IN]]);
  });
});
