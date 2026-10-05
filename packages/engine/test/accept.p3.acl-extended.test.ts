/**
 * P3 acceptance — an extended ACL with counters, logging and provenance (ARCHITECTURE-P3 §10.1
 * `accept.p3.acl-extended`; §3.3 steps 1–6, D12, §2.4 DropRule, §2.6 AclRow, §2.10, §4.2, §5.2, §5.8; §7 W4 qa).
 *
 * §3.3's world, on `staged.world` at stage P3 with every approved P3 daemon registered (the catalog flip is a later,
 * separate step; after it the overlay is a no-op): PC1 192.168.10.10 and PC2 .11 on SW1 → R1 Gi0/0 192.168.10.1;
 * R1 Gi0/1 192.168.20.1 → SRV 192.168.20.100 (`ip http server`). R1 gets, through its CLI,
 * `ip access-list extended NO-WEB-PC1` with `deny tcp host 192.168.10.10 host 192.168.20.100 eq www log`,
 * `permit icmp 192.168.10.0 0.0.0.255 any`, `permit ip any any`, and `ip access-group NO-WEB-PC1 in` on Gi0/0.
 *   • configuration: hidden seq 10, 20, 30; the binding writes the four rows (matches 0, applied Gi0/0 in) and one
 *     `ip routing` debug line;
 *   • ping 5/5: row 20 counts 5, one tableWrite per echo request, `lastPdu` names the echo request;
 *   • HTTP from PC1: every SYN is denied by line 10 with the structured drop `rule` (list, seq 10, key, the entry's
 *     place in the configuration) and the marker detail `ACL NO-WEB-PC1 #10`, answered with ICMP 3/13 (at most one per
 *     500 ms) and taken by PC1's TCP as the soft error `admin-prohibited`; the SYN count, row 10's matches and the
 *     aggregated log count are derived from TCP_INITIAL_RTO_NS, TCP_SYN_RETRIES and HTTP_CLIENT_TIMEOUT_NS, never
 *     typed; the first packet is logged at once, the aggregate 300 s later; the tab ends in `error` at the deadline;
 *   • PC2's HTTP succeeds and every segment of that connection counts on row 30; `show access-lists` prints the counts
 *     and never the implicit deny;
 *   • the rate gate: two SYNs at the same instant draw one ICMP;
 *   • the `established` variant allows only return traffic;
 *   • the grader: a lab `connectivity {proto: 'tcp', port: 80, expect: 'fail', droppedAt: 'R1', dropReason:
 *     'acl-deny'}` passes in the clone (W3 clone features) and an `aclDecision` for the same tuple says deny by entry 10.
 */
import { describe, expect, it } from 'vitest';
import type { LabAssertion, ScenarioInfo } from '../src/contracts/scenario.js';
import type { Simulation } from '../src/contracts/simulation.js';
import { HTTP_CLIENT_TIMEOUT_NS } from '../src/contracts/services.js';
import { aclKey } from '../src/contracts/tables.js';
import { SEC, type SimTime } from '../src/contracts/time.js';
import { TOPOLOGY_SCHEMA_ID } from '../src/contracts/topology.js';
import type { TraceEvent } from '../src/contracts/trace.js';
import { EPHEMERAL_PORT_MIN, TCP_INITIAL_RTO_NS, TCP_SYN_RETRIES } from '../src/contracts/transport.js';
import { PING_COUNT } from '../src/cli/handlers/exec.js';
import { ACL_LOG_FACILITY, ACL_LOG_INTERVAL_NS, ACL_LOG_SEVERITY, ACL_UNREACH_RATE_NS } from '../src/protocols/acl.js';
import { evaluateLab } from '../src/sim/lab-checks.js';
import { accessPort, configText } from '../src/sim/scenarios/kit.js';
import { ofKind } from './sim.harness.js';
import {
  GI0,
  GI1,
  MASK24,
  PC_PORT,
  aclLogs,
  aclRow,
  aclRows,
  aclWorld,
  adminProhibited,
  browserTab,
  cfg,
  dropsAt,
  hostConfig,
  mark,
  pingFrom,
  privileged,
  routedPort,
  routerConfig,
  show,
  since,
  writesOf,
} from './accept.p3.acl.harness.js';

const PC1 = '192.168.10.10';
const PC2 = '192.168.10.11';
const SRV = '192.168.20.100';
const R1_LAN = '192.168.10.1';
const R1_SRV = '192.168.20.1';
const LIST = 'NO-WEB-PC1';
const SECTION = ['ip', 'access-list', 'extended', LIST];
const ENTRY_10 = 'deny tcp host 192.168.10.10 host 192.168.20.100 eq www log';
const ENTRY_20 = 'permit icmp 192.168.10.0 0.0.0.255 any';
const ENTRY_30 = 'permit ip any any';
const APPLIED = `${GI0} in`;
const MS = 1_000_000;

/** §3.3's R1 lines (typed through the CLI after boot). */
const NO_WEB_PC1: readonly string[] = [`ip access-list extended ${LIST}`, ENTRY_10, ENTRY_20, ENTRY_30, 'exit', `interface ${GI0}`, `ip access-group ${LIST} in`];

/**
 * The offsets of PC1's SYNs from the first one, derived from the constants (§3.3 step 3): the RTO starts at
 * TCP_INITIAL_RTO_NS and doubles per expiry, at most TCP_SYN_RETRIES retransmissions, and only those sent before the
 * browser's HTTP_CLIENT_TIMEOUT_NS ends the tab.
 */
function synOffsets(): SimTime[] {
  const out: SimTime[] = [0];
  let at = 0;
  let rto = TCP_INITIAL_RTO_NS;
  for (let k = 0; k < TCP_SYN_RETRIES; k++) {
    at += rto;
    if (at >= HTTP_CLIENT_TIMEOUT_NS) break;
    out.push(at);
    rto *= 2;
  }
  return out;
}

/** How many of the packets denied at `offsets` the rate gate answers (one ICMP per ACL_UNREACH_RATE_NS, D12). */
function answered(offsets: readonly SimTime[]): number {
  let last: SimTime | undefined;
  let n = 0;
  for (const t of offsets) {
    if (last !== undefined && t - last < ACL_UNREACH_RATE_NS) continue;
    last = t;
    n++;
  }
  return n;
}

/** §3.3's world, booted and settled; `r1` lines are added to R1's startup configuration. */
function world(seed: number, r1: readonly (readonly string[])[] = []): Simulation {
  const sim = aclWorld(seed);
  sim.addDevice({ id: 'pc1', type: 'pc.nfpc', name: 'PC1', startupConfig: hostConfig('PC1', PC1, R1_LAN) });
  sim.addDevice({ id: 'pc2', type: 'pc.nfpc', name: 'PC2', startupConfig: hostConfig('PC2', PC2, R1_LAN) });
  sim.addDevice({ id: 'srv', type: 'server.nfserver', name: 'SRV', startupConfig: hostConfig('SRV', SRV, R1_SRV, ['ip http server']) });
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
  sim.addDevice({ id: 'r1', type: 'router.nf2911', name: 'R1', startupConfig: routerConfig('R1', [routedPort(GI0, R1_LAN, MASK24), routedPort(GI1, R1_SRV, MASK24), ...r1]) });
  sim.addLink({ a: { device: 'pc1', port: PC_PORT }, b: { device: 'sw1', port: 'FastEthernet0/1' } });
  sim.addLink({ a: { device: 'pc2', port: PC_PORT }, b: { device: 'sw1', port: 'FastEthernet0/2' } });
  sim.addLink({ a: { device: 'r1', port: GI0 }, b: { device: 'sw1', port: 'GigabitEthernet0/1' } });
  sim.addLink({ a: { device: 'r1', port: GI1 }, b: { device: 'srv', port: PC_PORT } });
  sim.runFor(60 * SEC);
  sim.runToIdle();
  return sim;
}

/** The TCP segments `device` created (its tcp process), with their flags. */
function segments(sim: Simulation, evs: readonly TraceEvent[], device: string): { t: SimTime; id: number; flags: string; srcPort: number; dstPort: number }[] {
  return ofKind(evs, 'pduCreated')
    .filter((e) => e.device === device && e.process === 'tcp')
    .map((e) => {
      const p = sim.pdu(e.pdu.id)!;
      return { t: e.t, id: e.pdu.id, flags: String(p.get('tcp.flags')), srcPort: Number(p.get('tcp.srcPort')), dstPort: Number(p.get('tcp.dstPort')) };
    });
}

/** The debug lines of `device` in `category`. */
function debugOf(evs: readonly TraceEvent[], device: string, category: string): string[] {
  return ofKind(evs, 'debug').filter((d) => d.event.device === device && d.event.category === category).map((d) => d.event.message);
}

/** A lab whose single task carries `assertions`; the verdicts, `undefined` for a pass, else the detail. */
function grade(sim: Simulation, assertions: readonly LabAssertion[]): (string | undefined)[] {
  const lab: ScenarioInfo = {
    name: 'acl-extended-accept',
    title: 'Extended ACL',
    description: 'A lab built by the test',
    category: 'ccna2-lab',
    build: () => ({ schema: TOPOLOGY_SCHEMA_ID, seed: 1, devices: [], links: [] }),
    tasks: [{ id: 'only', title: 'Only task', description: 'One task', points: 10, assertions }],
  };
  return evaluateLab(sim, lab).results[0]!.assertions.map((r) => (r.pass ? undefined : (r.detail ?? '(no detail)')));
}

describe('accept P3: an extended ACL with counters, logging and provenance (§3.3)', () => {
  it('steps 1–5: the rows, the ping, the denied HTTP of PC1 with its derived counts, PC2’s HTTP and show access-lists', () => {
    const sim = world(33);

    // ── step 1: configuration ──
    const c1 = mark(sim);
    const at = sim.now;
    cfg(sim, 'r1', NO_WEB_PC1);
    const e1 = since(sim, c1);
    // the entries keep hidden sequence numbers: the running configuration has none, show access-lists prints them
    const s = privileged(sim, 'r1');
    const running = show(sim, s, 'show running-config').join('\n');
    expect(running).toContain(`ip access-list extended ${LIST}\n ${ENTRY_10}\n ${ENTRY_20}\n ${ENTRY_30}\n`);
    expect(running).toContain(`interface ${GI0}\n`);
    expect(running).toContain(` ip access-group ${LIST} in\n`);
    // the binding makes the list applied: four tableWrites in evaluation order, 0 matches, applied on Gi0/0 in
    expect(writesOf(e1, 'r1', 'acl').map((w) => w.row)).toEqual([
      { key: aclKey(4, LIST, 10), family: 4, list: LIST, type: 'extended', seq: 10, entry: ENTRY_10, action: 'deny', matches: 0, applied: APPLIED, updatedAt: at },
      { key: aclKey(4, LIST, 20), family: 4, list: LIST, type: 'extended', seq: 20, entry: ENTRY_20, action: 'permit', matches: 0, applied: APPLIED, updatedAt: at },
      { key: aclKey(4, LIST, 30), family: 4, list: LIST, type: 'extended', seq: 30, entry: ENTRY_30, action: 'permit', matches: 0, applied: APPLIED, updatedAt: at },
      { key: aclKey(4, LIST, 'implicit'), family: 4, list: LIST, type: 'extended', seq: null, implicit: 'deny', entry: 'deny ip any any', action: 'deny', matches: 0, applied: APPLIED, updatedAt: at },
    ]);
    // ipv4 sees the access-group delta: one `ip routing` debug line
    expect(debugOf(e1, 'r1', 'ip routing')).toEqual([`interface ${GI0} filters inbound packets with access list ${LIST}`]);
    expect(show(sim, s, 'show access-lists')).toEqual([`Extended access list ${LIST}`, `    10 ${ENTRY_10}`, `    20 ${ENTRY_20}`, `    30 ${ENTRY_30}`]);

    // ── step 2: ping from PC1 ──
    const ping = pingFrom(sim, 'pc1', SRV);
    expect(ping.text).toContain(`Sent ${PING_COUNT}, received ${PING_COUNT}, lost 0`);
    // every echo request matched line 20: one tableWrite each; the replies entered Gi0/1, which has no list
    const pingWrites = writesOf(ping.evs, 'r1', 'acl');
    expect(pingWrites.map((w) => [w.row.key, (w.row as { matches: number }).matches])).toEqual(
      Array.from({ length: PING_COUNT }, (_, k) => [aclKey(4, LIST, 20), k + 1]),
    );
    const echoes = ofKind(ping.evs, 'pduCreated').filter((e) => e.device === 'pc1' && sim.pdu(e.pdu.id)?.get('icmpv4.type') === 8);
    expect(echoes).toHaveLength(PING_COUNT);
    const row20 = aclRow(sim, 'r1', aclKey(4, LIST, 20))!;
    expect(row20).toMatchObject({ matches: PING_COUNT, lastIface: GI0, lastDir: 'in', lastPdu: echoes.at(-1)!.pdu.id });
    // lastPdu names the echo request (the provenance chip of [S10] reads it)
    const last = sim.pdu(row20.lastPdu!)!;
    expect([last.get('ipv4.src'), last.get('ipv4.dst'), last.get('icmpv4.type')]).toEqual([PC1, SRV, 8]);
    expect(dropsAt(ping.evs, 'r1', 'acl-deny')).toEqual([]);

    // ── step 3: HTTP from PC1 ──
    const offsets = synOffsets();
    const c3 = mark(sim);
    const fetchAt = sim.now;
    const ticket = sim.hostRequest!('pc1', { app: 'http.get', url: `http://${SRV}/` });
    // the tab is still trying one nanosecond before the browser's deadline, and in error at it
    sim.runFor(HTTP_CLIENT_TIMEOUT_NS - 1);
    expect(browserTab(sim, 'pc1', ticket.requestId)['phase']).toBe('connecting');
    sim.runFor(1);
    expect(browserTab(sim, 'pc1', ticket.requestId)).toMatchObject({ phase: 'error', error: 'The page did not load in time.' });
    expect(sim.now).toBe(fetchAt + HTTP_CLIENT_TIMEOUT_NS);
    const e3 = since(sim, c3);
    const syns = segments(sim, e3, 'pc1');
    expect(syns.every((x) => x.flags === 'S' && x.dstPort === 80)).toBe(true);
    // the SYNs leave at 0, +RTO, +3 RTO, … — all inside the deadline, no further attempt
    expect(syns.map((x) => x.t - syns[0]!.t)).toEqual(offsets);
    expect(syns[0]!.t - fetchAt).toBeLessThan(MS);
    const sport = syns[0]!.srcPort;
    expect(new Set(syns.map((x) => x.srcPort))).toEqual(new Set([sport]));
    // each one denied at R1 Gi0/0 by line 10, with the structured rule and the marker detail
    const denies = dropsAt(e3, 'r1', 'acl-deny');
    expect(denies.map((d) => d.pdu.id)).toEqual(syns.map((x) => x.id));
    for (const d of denies) {
      expect(d.port).toBe(GI0);
      expect(d.detail).toBe(`ACL ${LIST} #10`);
      expect(d.rule).toEqual({
        kind: 'acl',
        text: `denied by access list ${LIST} line 10 (${ENTRY_10}), inbound on ${GI0}`,
        table: 'acl',
        key: aclKey(4, LIST, 10),
        iface: GI0,
        dir: 'in',
        list: LIST,
        seq: 10,
        family: 4,
        config: { context: [SECTION], line: ENTRY_10.split(' ') },
      });
    }
    expect(sim.device('r1')!.port(GI0)!.counters.aclDenies).toBe(offsets.length);
    expect(sim.device('r1')!.port(GI1)!.counters).not.toHaveProperty('aclDenies');
    // nothing of the connection crossed R1
    expect(ofKind(e3, 'pduCreated').filter((e) => e.device === 'srv' && e.process === 'tcp')).toEqual([]);
    // ICMP 3/13 from the input interface, at most one per 500 ms: here every SYN is answered (they are ≥ 1 s apart)
    const errors = adminProhibited(sim, e3, 'r1');
    expect(errors).toHaveLength(answered(offsets));
    expect(errors).toHaveLength(offsets.length);
    for (let i = 1; i < errors.length; i++) expect(errors[i]!.t - errors[i - 1]!.t).toBeGreaterThanOrEqual(ACL_UNREACH_RATE_NS);
    for (const e of errors) expect([e.pdu.get('ipv4.src'), e.pdu.get('ipv4.dst')]).toEqual([R1_LAN, PC1]);
    // PC1's TCP takes each as the soft error admin-prohibited and keeps retransmitting
    const soft = debugOf(e3, 'pc1', 'tcp').filter((m) => m.includes('soft error admin-prohibited'));
    expect(soft).toHaveLength(offsets.length);
    // row 10 counts every SYN; its last match is the last SYN
    expect(aclRow(sim, 'r1', aclKey(4, LIST, 10))).toMatchObject({ matches: offsets.length, lastPdu: syns.at(-1)!.id, lastIface: GI0, lastDir: 'in' });
    // the first packet of the flow is logged at once, the others are only counted
    const flowText = `list ${LIST} line 10 denied tcp ${PC1}(${sport}) -> ${SRV}(80)`;
    expect(aclLogs(e3, 'r1')).toEqual([{ t: denies[0]!.t, severity: ACL_LOG_SEVERITY, message: `${flowText}, 1 packet` }]);
    expect(ofKind(e3, 'log').filter((l) => l.device === 'r1' && l.facility === ACL_LOG_FACILITY)).toHaveLength(1);

    // the aggregation tick, 300 s after the first line, logs the packets counted since: the SYN count minus one
    const c4 = mark(sim);
    sim.runFor(denies[0]!.t + ACL_LOG_INTERVAL_NS - sim.now);
    const pending = offsets.length - 1;
    expect(aclLogs(since(sim, c4), 'r1')).toEqual([
      { t: denies[0]!.t + ACL_LOG_INTERVAL_NS, severity: ACL_LOG_SEVERITY, message: `${flowText}, ${pending} packet${pending === 1 ? '' : 's'}` },
    ]);
    // the next tick finds the flow idle: no line, the flow is forgotten and nothing holds runToIdle
    const c5 = mark(sim);
    sim.runFor(ACL_LOG_INTERVAL_NS + SEC);
    expect(aclLogs(since(sim, c5), 'r1')).toEqual([]);
    expect(sim.runToIdle().stopped).toBeUndefined();

    // ── step 4: HTTP from PC2 matches line 30, segment by segment ──
    const c6 = mark(sim);
    const t2 = sim.hostRequest!('pc2', { app: 'http.get', url: `http://${SRV}/` });
    sim.runToIdle();
    const e6 = since(sim, c6);
    expect(browserTab(sim, 'pc2', t2.requestId)).toMatchObject({ phase: 'done', status: 200 });
    const pc2Segments = segments(sim, e6, 'pc2');
    expect(pc2Segments.length).toBeGreaterThan(3);
    const row30Writes = writesOf(e6, 'r1', 'acl');
    expect(row30Writes.every((w) => w.row.key === aclKey(4, LIST, 30))).toBe(true);
    expect(aclRow(sim, 'r1', aclKey(4, LIST, 30))!.matches).toBe(pc2Segments.length);
    expect(dropsAt(e6, 'r1', 'acl-deny')).toEqual([]);

    // ── step 5: show access-lists ──
    expect(show(sim, s, 'show access-lists')).toEqual([
      `Extended access list ${LIST}`,
      `    10 ${ENTRY_10} (${offsets.length} matches)`,
      `    20 ${ENTRY_20} (${PING_COUNT} matches)`,
      `    30 ${ENTRY_30} (${pc2Segments.length} matches)`,
    ]);
    // the implicit deny is never printed, and it counted nothing
    expect(aclRow(sim, 'r1', aclKey(4, LIST, 'implicit'))!.matches).toBe(0);
    expect(aclRows(sim, 'r1').map((r) => [r.key, r.matches])).toEqual([
      [aclKey(4, LIST, 10), offsets.length],
      [aclKey(4, LIST, 20), PING_COUNT],
      [aclKey(4, LIST, 30), pc2Segments.length],
      [aclKey(4, LIST, 'implicit'), 0],
    ]);
  });

  it('the rate gate: two SYNs denied at the same instant draw one ICMP 3/13; every round of retransmissions likewise', () => {
    const sim = world(35);
    cfg(sim, 'r1', NO_WEB_PC1);
    const c = mark(sim);
    // two browser tabs at once: two connections, two SYNs in the same instant
    sim.hostRequest!('pc1', { app: 'http.get', url: `http://${SRV}/` });
    sim.hostRequest!('pc1', { app: 'http.get', url: `http://${SRV}/a` });
    sim.runFor(HTTP_CLIENT_TIMEOUT_NS);
    const evs = since(sim, c);
    const offsets = synOffsets();
    const syns = segments(sim, evs, 'pc1');
    expect(syns).toHaveLength(2 * offsets.length);
    expect(new Set(syns.map((x) => x.srcPort)).size).toBe(2);
    const denies = dropsAt(evs, 'r1', 'acl-deny');
    expect(denies).toHaveLength(2 * offsets.length);
    const errors = adminProhibited(sim, evs, 'r1');
    // one answer per instant: the second SYN of a pair finds the gate closed
    expect(errors).toHaveLength(answered(denies.map((d) => d.t)));
    expect(errors).toHaveLength(offsets.length);
    for (let i = 1; i < errors.length; i++) expect(errors[i]!.t - errors[i - 1]!.t).toBeGreaterThanOrEqual(ACL_UNREACH_RATE_NS);
    // both flows are logged at once (two flows: different source ports), each counted on row 10
    expect(aclLogs(evs, 'r1').map((l) => l.message.endsWith(', 1 packet'))).toEqual([true, true]);
    expect(aclRow(sim, 'r1', aclKey(4, LIST, 10))!.matches).toBe(2 * offsets.length);
  });

  it('the established variant allows only return traffic', () => {
    const RETURN = 'RETURN-ONLY';
    const sim = world(37, [['ip access-list extended RETURN-ONLY', ' permit tcp any any established'], [`interface ${GI1}`, ` ip access-group ${RETURN} in`]]);
    // the rows were written at boot, as the configuration replayed
    expect(aclRows(sim, 'r1').map((r) => [r.key, r.matches, r.applied])).toEqual([
      [aclKey(4, RETURN, 10), 0, `${GI1} in`],
      [aclKey(4, RETURN, 'implicit'), 0, `${GI1} in`],
    ]);
    // PC1 opens the connection: the SYN leaves through Gi0/1 (no outbound list), every segment back carries ACK
    const c1 = mark(sim);
    const t1 = sim.hostRequest!('pc1', { app: 'http.get', url: `http://${SRV}/` });
    sim.runToIdle();
    const e1 = since(sim, c1);
    expect(browserTab(sim, 'pc1', t1.requestId)).toMatchObject({ phase: 'done', status: 200 });
    const back = segments(sim, e1, 'srv');
    expect(back.length).toBeGreaterThan(0);
    expect(back.every((x) => x.flags.includes('A'))).toBe(true);
    expect(aclRow(sim, 'r1', aclKey(4, RETURN, 10))!.matches).toBe(back.length);
    expect(dropsAt(e1, 'r1', 'acl-deny')).toEqual([]);
    // a connection opened from the outside: its SYN has no ACK, so the implicit deny drops it at R1 Gi0/1
    const c2 = mark(sim);
    sim.hostRequest!('srv', { app: 'http.get', url: `http://${PC2}/` });
    sim.runFor(HTTP_CLIENT_TIMEOUT_NS);
    const e2 = since(sim, c2);
    const outsideSyns = segments(sim, e2, 'srv');
    expect(outsideSyns.length).toBeGreaterThan(0);
    expect(outsideSyns.every((x) => x.flags === 'S')).toBe(true);
    const denied = dropsAt(e2, 'r1', 'acl-deny');
    expect(denied.map((d) => d.pdu.id)).toEqual(outsideSyns.map((x) => x.id));
    for (const d of denied) {
      expect(d.port).toBe(GI1);
      expect(d.detail).toBe(`ACL ${RETURN} implicit deny`);
      expect(d.rule).toMatchObject({ kind: 'acl', list: RETURN, seq: 'implicit', key: aclKey(4, RETURN, 'implicit'), dir: 'in', iface: GI1 });
    }
    expect(ofKind(e2, 'pduCreated').filter((e) => e.device === 'pc2')).toEqual([]);
    // and anything that is not TCP coming back is denied too: PC1's ping gets no reply
    const ping = pingFrom(sim, 'pc1', SRV);
    expect(ping.text).toContain(`Sent ${PING_COUNT}, received 0`);
    expect(dropsAt(ping.evs, 'r1', 'acl-deny').every((d) => d.port === GI1 && d.rule?.seq === 'implicit')).toBe(true);
    expect(dropsAt(ping.evs, 'r1', 'acl-deny')).toHaveLength(PING_COUNT);
  });

  it('the grader: the connectivity check with droppedAt and dropReason passes in the clone; aclDecision says deny by entry 10', () => {
    const sim = world(39);
    cfg(sim, 'r1', NO_WEB_PC1);
    const before = JSON.stringify({ now: sim.now, head: sim.trace(0).next, snapshot: sim.snapshot() });
    const tuple = { proto: 'tcp' as const, src: PC1, dst: SRV, dstPort: 80 };
    expect(
      grade(sim, [
        { kind: 'connectivity', from: 'PC1', to: 'SRV', proto: 'tcp', port: 80, expect: 'fail', droppedAt: 'R1', dropReason: 'acl-deny' },
        { kind: 'connectivity', from: 'PC2', to: 'SRV', proto: 'tcp', port: 80, expect: 'success' },
        { kind: 'connectivity', from: 'PC1', to: 'SRV', expect: 'success' },
        { kind: 'aclDecision', device: 'R1', list: LIST, packet: tuple, expect: 'deny', entry: 10 },
        { kind: 'aclDecision', device: 'R1', list: LIST, packet: { ...tuple, src: PC2 }, expect: 'permit', entry: 30 },
        { kind: 'aclDecision', device: 'R1', list: LIST, packet: { proto: 'icmp', src: PC1, dst: SRV }, expect: 'permit', entry: 20 },
        // wrong answers (an aclDecision probe's source port defaults to the first ephemeral port)
        { kind: 'connectivity', from: 'PC1', to: 'SRV', proto: 'tcp', port: 80, expect: 'success' },
        { kind: 'aclDecision', device: 'R1', list: LIST, packet: tuple, expect: 'permit' },
      ]),
    ).toEqual([
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      `PC1 could not open TCP port 80 on ${SRV}: it was dropped at R1 (acl-deny).`,
      `Access list ${LIST} on R1 denies a TCP segment from ${PC1} port ${EPHEMERAL_PORT_MIN} to ${SRV} port 80 by entry 10 (${ENTRY_10}); expected permit.`,
    ]);
    // grading leaves the live world untouched
    expect(JSON.stringify({ now: sim.now, head: sim.trace(0).next, snapshot: sim.snapshot() })).toBe(before);
  });
});
