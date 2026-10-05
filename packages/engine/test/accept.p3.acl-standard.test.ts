/**
 * P3 acceptance — standard ACLs (ARCHITECTURE-P3 §10.1 `accept.p3.acl-standard`; D12, §2.4 DropRule, §2.6 AclRow,
 * §3.0 (a) steps 2 and 7, §5.2, §5.8; §7 W4 qa).
 *
 * Real worlds on `staged.world` at stage P3 with every approved P3 daemon registered (the catalog flip is a later,
 * separate step; after it the overlay is a no-op):
 *
 *   PC1 192.168.10.10 ─┐                                         10.0.12.0/30
 *   PC2 192.168.10.11 ─┴ SW1 ─ Gi0/0 R1 192.168.10.1 ── Gi0/1 .1 ──────── .2 Gi0/0 R2 Gi0/1 192.168.30.1 ── SRV .100
 *
 * with static routes both ways, and a NAT world (PC1 192.168.1.10 ─ R1 inside / outside 203.0.113.1 ─ SRV .10):
 *   • a standard list near the destination (R2 Gi0/1 out, `access-list 10 permit host 192.168.10.11`): PC2 passes and
 *     is counted on entry 10; PC1 and R1's own traffic die at R2 by the implicit deny, with the structured rule, the
 *     implicit row counting them, `aclDenies` on R2 Gi0/1 only, and ICMP 3/13 from R2's ingress interface;
 *   • an undefined list bound to an interface permits everything and counts nothing (the CLI says so); once defined it
 *     filters, and removing it lets everything through again;
 *   • NAT's use of a list is never counted: the same list as NAT rule and inbound filter counts each packet once; a
 *     NAT list whose entry carries `log` keeps that entry (NAT translates with it) and, used by NAT only, writes no row
 *     and logs nothing.
 */
import { describe, expect, it } from 'vitest';
import { CLI_MESSAGES } from '../src/contracts/cli.js';
import type { Simulation } from '../src/contracts/simulation.js';
import { aclKey, natKey, type NatRow } from '../src/contracts/tables.js';
import { SEC } from '../src/contracts/time.js';
import { PING_COUNT } from '../src/cli/handlers/exec.js';
import { ACL_LOG_SEVERITY } from '../src/protocols/acl.js';
import { accessPort, configText, section } from '../src/sim/scenarios/kit.js';
import { ofKind } from './sim.harness.js';
import {
  GI0,
  GI1,
  MASK24,
  MASK30,
  PC_PORT,
  aclLogs,
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
  privileged,
  routedPort,
  routerConfig,
  show,
  since,
  writesOf,
} from './accept.p3.acl.harness.js';

const PC1 = '192.168.10.10';
const PC2 = '192.168.10.11';
const SRV = '192.168.30.100';
const R1_LAN = '192.168.10.1';
const R1_WAN = '10.0.12.1';
const R2_WAN = '10.0.12.2';
const R2_LAN = '192.168.30.1';

/** The routed world of the file header, booted and settled; `r2` sections are added to R2's startup configuration. */
function routed(seed: number, r2: readonly (readonly string[])[] = []): Simulation {
  const sim = aclWorld(seed);
  sim.addDevice({ id: 'pc1', type: 'pc.nfpc', name: 'PC1', startupConfig: hostConfig('PC1', PC1, R1_LAN) });
  sim.addDevice({ id: 'pc2', type: 'pc.nfpc', name: 'PC2', startupConfig: hostConfig('PC2', PC2, R1_LAN) });
  sim.addDevice({ id: 'srv', type: 'server.nfserver', name: 'SRV', startupConfig: hostConfig('SRV', SRV, R2_LAN) });
  sim.addDevice({
    id: 'sw1',
    type: 'switch.nfc2960',
    name: 'SW1',
    startupConfig: configText([
      ['hostname SW1'],
      accessPort('FastEthernet0/1', 1, { portfast: true }),
      accessPort('FastEthernet0/2', 1, { portfast: true }),
      accessPort('GigabitEthernet0/1', 1, { portfast: true }),
    ]),
  });
  sim.addDevice({
    id: 'r1',
    type: 'router.nf2911',
    name: 'R1',
    startupConfig: routerConfig('R1', [routedPort(GI0, R1_LAN, MASK24), routedPort(GI1, R1_WAN, MASK30), [`ip route 192.168.30.0 ${MASK24} ${R2_WAN}`]]),
  });
  sim.addDevice({
    id: 'r2',
    type: 'router.nf2911',
    name: 'R2',
    startupConfig: routerConfig('R2', [routedPort(GI0, R2_WAN, MASK30), routedPort(GI1, R2_LAN, MASK24), [`ip route 192.168.10.0 ${MASK24} ${R1_WAN}`], ...r2]),
  });
  sim.addLink({ a: { device: 'pc1', port: PC_PORT }, b: { device: 'sw1', port: 'FastEthernet0/1' } });
  sim.addLink({ a: { device: 'pc2', port: PC_PORT }, b: { device: 'sw1', port: 'FastEthernet0/2' } });
  sim.addLink({ a: { device: 'r1', port: GI0 }, b: { device: 'sw1', port: 'GigabitEthernet0/1' } });
  sim.addLink({ a: { device: 'r1', port: GI1 }, b: { device: 'r2', port: GI0 } });
  sim.addLink({ a: { device: 'r2', port: GI1 }, b: { device: 'srv', port: PC_PORT } });
  sim.runFor(60 * SEC);
  sim.runToIdle();
  return sim;
}

const NEAR_DESTINATION: readonly (readonly string[])[] = [['access-list 10 permit host 192.168.10.11'], section(`interface ${GI1}`, ['ip access-group 10 out'])];

describe('accept P3: a standard list near the destination', () => {
  it('permits PC2 on entry 10; the implicit deny drops PC1 and R1 at R2 Gi0/1 out, counted on the right interface', () => {
    const sim = routed(51, NEAR_DESTINATION);
    // applied at boot: entry 10 and the implicit row, nothing counted yet
    expect(aclRows(sim, 'r2').map((r) => [r.key, r.entry, r.action, r.matches, r.applied])).toEqual([
      [aclKey(4, '10', 10), 'permit 192.168.10.11', 'permit', 0, `${GI1} out`],
      [aclKey(4, '10', 'implicit'), 'deny any', 'deny', 0, `${GI1} out`],
    ]);
    expect(aclRows(sim, 'r1')).toEqual([]);

    // PC2 is the one host the list permits
    const ok = pingFrom(sim, 'pc2', SRV);
    expect(ok.text).toContain(`Sent ${PING_COUNT}, received ${PING_COUNT}, lost 0`);
    expect(aclRow(sim, 'r2', aclKey(4, '10', 10))).toMatchObject({ matches: PING_COUNT, lastIface: GI1, lastDir: 'out' });
    // the replies leave SRV towards PC2 through Gi0/0 of R2, which has no list
    expect(writesOf(ok.evs, 'r2', 'acl')).toHaveLength(PING_COUNT);

    // PC1: forwarded by R1, dropped at R2 by the implicit deny
    const denied = pingFrom(sim, 'pc1', SRV);
    expect(denied.text).toContain(`Sent ${PING_COUNT}, received 0`);
    expect(dropsAt(denied.evs, 'r1', 'acl-deny')).toEqual([]);
    const drops = dropsAt(denied.evs, 'r2', 'acl-deny');
    expect(drops).toHaveLength(PING_COUNT);
    for (const d of drops) {
      expect(d.port).toBe(GI1);
      expect(d.detail).toBe('ACL 10 implicit deny');
      expect(d.rule).toEqual({
        kind: 'acl',
        text: `denied by the implicit deny at the end of access list 10, outbound on ${GI1}`,
        table: 'acl',
        key: aclKey(4, '10', 'implicit'),
        config: { context: [['interface', GI1]], line: ['ip', 'access-group', '10', 'out'] },
        iface: GI1,
        dir: 'out',
        list: '10',
        seq: 'implicit',
        family: 4,
      });
      expect(sim.pdu(d.pdu.id)!.get('ipv4.src')).toBe(PC1);
    }
    expect(aclRow(sim, 'r2', aclKey(4, '10', 'implicit'))).toMatchObject({ matches: PING_COUNT, lastIface: GI1, lastDir: 'out', lastPdu: drops.at(-1)!.pdu.id });
    expect(aclRow(sim, 'r2', aclKey(4, '10', 10))!.matches).toBe(PING_COUNT);
    // aclDenies on the right interface: R2 Gi0/1 only
    expect(sim.device('r2')!.port(GI1)!.counters.aclDenies).toBe(PING_COUNT);
    expect(sim.device('r2')!.port(GI0)!.counters).not.toHaveProperty('aclDenies');
    for (const p of [GI0, GI1]) expect(sim.device('r1')!.port(p)!.counters).not.toHaveProperty('aclDenies');
    // an outbound deny's ICMP 3/13 comes from the interface the packet entered (R2 Gi0/0), towards PC1
    const errors = adminProhibited(sim, denied.evs, 'r2');
    expect(errors.length).toBeGreaterThan(0);
    for (const e of errors) expect([e.pdu.get('ipv4.src'), e.pdu.get('ipv4.dst')]).toEqual([R2_WAN, PC1]);
    // D12: one ICMP per 500 ms, the next echo leaves at once after a U, so every other echo times out
    expect(pingMarks(denied.text)).toBe('U.U.U');
    expect(errors).toHaveLength(pingMarks(denied.text).split('U').length - 1);

    // R1's own ping has R1's source address: the implicit deny catches it too
    const fromR1 = pingFrom(sim, 'r1', SRV);
    // the gate is per device: R1's first echo comes less than 500 ms after the last U R2 sent PC1, so it goes unanswered
    expect(pingMarks(fromR1.text)).toBe('.U.U.');
    expect(dropsAt(fromR1.evs, 'r2', 'acl-deny').map((d) => sim.pdu(d.pdu.id)!.get('ipv4.src'))).toEqual(Array.from({ length: PING_COUNT }, () => R1_WAN));
    expect(aclRow(sim, 'r2', aclKey(4, '10', 'implicit'))!.matches).toBe(2 * PING_COUNT);
    expect(sim.device('r2')!.port(GI1)!.counters.aclDenies).toBe(2 * PING_COUNT);

    // show access-lists: the counts of the permit entry; never the implicit deny
    const s = privileged(sim, 'r2');
    expect(show(sim, s, 'show access-lists')).toEqual(['Standard access list 10', `    10 permit 192.168.10.11 (${PING_COUNT} matches)`]);
  });
});

describe('accept P3: an undefined list bound to an interface', () => {
  it('permits everything and counts nothing; once defined it filters; removed, it lets everything through again', () => {
    const sim = routed(53);
    // binding a list that does not exist: stored, with the note, and no row anywhere
    const s = privileged(sim, 'r1');
    for (const line of ['configure terminal', `interface ${GI0}`]) expect(sim.cli.exec(s, line).error).toBeUndefined();
    const bound = sim.cli.exec(s, 'ip access-group 99 in');
    expect(bound.error).toBeUndefined();
    expect(bound.output).toContain(CLI_MESSAGES.aclUndefinedApplied.replace('{list}', '99'));
    expect(sim.cli.exec(s, 'end').error).toBeUndefined();
    expect(show(sim, s, 'show running-config').join('\n')).toContain(`interface ${GI0}\n ip address ${R1_LAN} ${MASK24}\n ip access-group 99 in\n`);
    for (const host of ['pc1', 'pc2']) {
      const p = pingFrom(sim, host, SRV);
      expect(p.text).toContain(`Sent ${PING_COUNT}, received ${PING_COUNT}, lost 0`);
      expect(writesOf(p.evs, 'r1', 'acl')).toEqual([]);
      expect(dropsAt(p.evs, 'r1', 'acl-deny')).toEqual([]);
    }
    expect(aclRows(sim, 'r1')).toEqual([]);
    expect(sim.device('r1')!.port(GI0)!.counters).not.toHaveProperty('aclDenies');

    // defined now: it filters (PC2 by entry 10, PC1 by the implicit deny), counted on R1 Gi0/0 in
    cfg(sim, 'r1', ['access-list 99 deny host 192.168.10.11']);
    expect(aclRows(sim, 'r1').map((r) => [r.key, r.matches, r.applied])).toEqual([
      [aclKey(4, '99', 10), 0, `${GI0} in`],
      [aclKey(4, '99', 'implicit'), 0, `${GI0} in`],
    ]);
    const pc2 = pingFrom(sim, 'pc2', SRV);
    expect(pc2.text).toContain(`Sent ${PING_COUNT}, received 0`);
    expect(dropsAt(pc2.evs, 'r1', 'acl-deny').every((d) => d.port === GI0 && d.rule?.seq === 10)).toBe(true);
    const pc1 = pingFrom(sim, 'pc1', SRV);
    expect(pc1.text).toContain(`Sent ${PING_COUNT}, received 0`);
    expect(dropsAt(pc1.evs, 'r1', 'acl-deny').every((d) => d.port === GI0 && d.rule?.seq === 'implicit')).toBe(true);
    expect(aclRows(sim, 'r1').map((r) => [r.key, r.matches])).toEqual([
      [aclKey(4, '99', 10), PING_COUNT],
      [aclKey(4, '99', 'implicit'), PING_COUNT],
    ]);
    expect(sim.device('r1')!.port(GI0)!.counters.aclDenies).toBe(2 * PING_COUNT);

    // removed again: the binding stays, the list is undefined, so everything passes and the rows are gone
    cfg(sim, 'r1', ['no access-list 99']);
    expect(aclRows(sim, 'r1')).toEqual([]);
    const again = pingFrom(sim, 'pc2', SRV);
    expect(again.text).toContain(`Sent ${PING_COUNT}, received ${PING_COUNT}, lost 0`);
    expect(writesOf(again.evs, 'r1', 'acl')).toEqual([]);
  });
});

// ── NAT and the same list ─────────────────────────────────────────────────────────────────────────────────────────

const IN_PC = '192.168.1.10';
const IN_GW = '192.168.1.1';
const OUT_R1 = '203.0.113.1';
const OUT_SRV = '203.0.113.10';
const NAT_LIST = 'access-list 1 permit 192.168.1.0 0.0.0.255 log';
const PAT_RULE = `ip nat inside source list 1 interface ${GI1} overload`;

/** PC1 ─ R1 (Gi0/0 inside, Gi0/1 outside, `lines`) ─ SRV, booted and settled. */
function natWorld(seed: number, lines: readonly string[]): Simulation {
  const sim = aclWorld(seed);
  sim.addDevice({ id: 'pc1', type: 'pc.nfpc', name: 'PC1', startupConfig: hostConfig('PC1', IN_PC, IN_GW) });
  sim.addDevice({ id: 'srv', type: 'server.nfserver', name: 'SRV', startupConfig: hostConfig('SRV', OUT_SRV, OUT_R1) });
  sim.addDevice({
    id: 'r1',
    type: 'router.nf2911',
    name: 'R1',
    startupConfig: routerConfig('R1', [routedPort(GI0, IN_GW, MASK24, ['ip nat inside']), routedPort(GI1, OUT_R1, MASK24, ['ip nat outside']), [...lines]]),
  });
  sim.addLink({ a: { device: 'pc1', port: PC_PORT }, b: { device: 'r1', port: GI0 } });
  sim.addLink({ a: { device: 'r1', port: GI1 }, b: { device: 'srv', port: PC_PORT } });
  sim.runFor(60 * SEC);
  sim.runToIdle();
  return sim;
}

const natRows = (sim: Simulation): NatRow[] => sim.device('r1')!.tables.get<NatRow>('nat')!.rows();

describe('accept P3: NAT and access lists', () => {
  it('a NAT list whose entry carries log keeps that entry: NAT translates with it, writes no acl row and logs nothing', () => {
    const sim = natWorld(55, [NAT_LIST, PAT_RULE]);
    expect(show(sim, privileged(sim, 'r1'), 'show running-config').join('\n')).toContain(`${NAT_LIST}\n`);
    const p = pingFrom(sim, 'pc1', OUT_SRV);
    expect(p.text).toContain(`Sent ${PING_COUNT}, received ${PING_COUNT}, lost 0`);
    // the translation used the logged entry: one overload row for the ping, SRV saw the global address
    const rows = natRows(sim);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: 'overload', proto: 'icmp', insideLocal: IN_PC, insideGlobal: OUT_R1, outsideGlobal: OUT_SRV, rule: PAT_RULE });
    expect(rows[0]!.key).toBe(natKey('icmp', OUT_R1, rows[0]!.insideGlobalPort));
    // every echo request left R1 with the global source (the PDU keeps its last rewrite)
    const requests = ofKind(p.evs, 'pduCreated').filter((e) => e.device === 'pc1' && sim.pdu(e.pdu.id)?.get('icmpv4.type') === 8);
    expect(requests.map((e) => sim.pdu(e.pdu.id)!.get('ipv4.src'))).toEqual(Array.from({ length: PING_COUNT }, () => OUT_R1));
    // a list NAT uses is no filter: no row, no count, no log line
    expect(aclRows(sim, 'r1')).toEqual([]);
    expect(writesOf(p.evs, 'r1', 'acl')).toEqual([]);
    expect(aclLogs(p.evs, 'r1')).toEqual([]);
  });

  it('the same list as NAT rule and inbound filter counts each packet once: NAT’s use is never counted', () => {
    const sim = natWorld(57, [NAT_LIST, PAT_RULE]);
    cfg(sim, 'r1', [`interface ${GI0}`, 'ip access-group 1 in']);
    expect(aclRows(sim, 'r1').map((r) => [r.key, r.entry, r.matches, r.applied])).toEqual([
      [aclKey(4, '1', 10), 'permit 192.168.1.0 0.0.0.255 log', 0, `${GI0} in`],
      [aclKey(4, '1', 'implicit'), 'deny any', 0, `${GI0} in`],
    ]);
    const c0 = mark(sim);
    for (let run = 1; run <= 2; run++) {
      const p = pingFrom(sim, 'pc1', OUT_SRV);
      expect(p.text).toContain(`Sent ${PING_COUNT}, received ${PING_COUNT}, lost 0`);
      // each echo request crossed the filter once and NAT's rule once; only the filter counts
      expect(writesOf(p.evs, 'r1', 'acl')).toHaveLength(PING_COUNT);
      expect(aclRow(sim, 'r1', aclKey(4, '1', 10))!.matches).toBe(run * PING_COUNT);
    }
    // NAT translated both pings with the list (two ICMP ids, two rows)
    expect(natRows(sim).map((r) => [r.kind, r.insideLocal, r.insideGlobal])).toEqual([
      ['overload', IN_PC, OUT_R1],
      ['overload', IN_PC, OUT_R1],
    ]);
    // the filter's log entry logs the first packet of the flow (a standard list logs the source only), once
    const logs = aclLogs(since(sim, c0), 'r1');
    expect(logs.map((l) => [l.severity, l.message])).toEqual([[ACL_LOG_SEVERITY, `list 1 line 10 permitted ${IN_PC}, 1 packet`]]);
    expect(aclRow(sim, 'r1', aclKey(4, '1', 'implicit'))!.matches).toBe(0);
  });
});
