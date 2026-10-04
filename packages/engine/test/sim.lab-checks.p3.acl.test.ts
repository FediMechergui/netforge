/**
 * sim.lab-checks.p3.acl — the acl area's checker adapter (ARCHITECTURE-P3 D5, D12, D14, §2.10, §3.3, §3.14; §7 W3
 * "ospf, acl, l2, qos, disc, svc, http" and "Approved items in W3", acl): the typed kinds `acl` and `aclDecision`
 * (sim/lab-checks/acl.ts, called by sim/lab-checks/registry.ts) and the approved [S13] `vty.logins` fact.
 *
 * Against fakes (§7 W3): R1 runs silent stubs in place of the acl and vty daemons, so its model keeps the `acl` and
 * `vty-logins` tables and nothing writes them but this test, which writes the rows the daemons would (§3.3's hit
 * counts, §3.14's logins). The lists and bindings are stored through the real CLI. Pinned, each member with a wrong
 * answer and its original detail:
 *   • `acl`: exists, type, entries (exactly / includes, canonical text: `eq 80` = `eq www`), applied (interface and
 *     vty bindings), entry, minMatches (one entry's row, the implicit row, the list's sum; an unapplied list counts
 *     nothing);
 *   • `aclDecision`: the configured list evaluated with `evaluateAcl` for tcp (SYN, established), udp, icmp and ip
 *     probes, by address or device name, the deciding entry or the implicit deny; a list without entries filters
 *     nothing;
 *   • `vty.logins`: successful logins from the `vty-logins` rows, per protocol.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import type { ProcessFactory } from '../src/contracts/process.js';
import type { LabAssertion, LabFactName, LabPacketProbe } from '../src/contracts/scenario.js';
import type { Simulation } from '../src/contracts/simulation.js';
import { aclKey, type AclRow, type VtyLoginRow } from '../src/contracts/tables.js';
import { SEC } from '../src/contracts/time.js';
import { FACT_READERS } from '../src/sim/lab-checks/facts.js';
import { ACL_FACT_READERS, LAB_PROBE_IP_PROTOCOL, canonicalAclEntry, probeTuple } from '../src/sim/lab-checks/acl.js';
import { CHECKERS, UNAVAILABLE_KIND_DETAILS, runCheck } from '../src/sim/lab-checks/registry.js';
import { createStagedSimulation } from './staged.world.js';

/** A silent daemon in place of the real one: the model keeps its tables, nothing writes them. */
const stub =
  (name: string): ProcessFactory =>
  () => ({
    name,
    onPdu: () => [],
    onTimer: () => [],
    onConfig: () => [],
    stateSnapshot: () => ({ process: name, state: {} }),
    debugEvents: () => [],
  });

let sim: Simulation;

/** Configure through the real CLI; a refused line fails the test with its error. */
function cfg(id: string, lines: readonly string[]): void {
  const r = sim.configure(id, lines);
  if (!r.ok) throw new Error(`${id}: ${JSON.stringify(r.lines.filter((l) => !l.ok))}`);
}

const DENY_WEB = 'deny tcp host 192.168.10.10 host 192.168.20.100 eq www log';
const PERMIT_ICMP = 'permit icmp 192.168.10.0 0.0.0.255 any';
const PERMIT_ANY = 'permit ip any any';

function row(list: string, type: 'standard' | 'extended', seq: number | 'implicit', entry: string, action: 'permit' | 'deny', matches: number, applied: string): AclRow {
  return {
    key: aclKey(4, list, seq),
    updatedAt: 0,
    family: 4,
    list,
    type,
    seq: seq === 'implicit' ? null : seq,
    ...(seq === 'implicit' ? { implicit: 'deny' as const } : {}),
    entry,
    action,
    matches,
    applied,
  };
}

/**
 * §3.3's R1: NO-WEB-PC1 applied in on Gi0/0 (rows 10: 4 matches, 20: 5, 30: 0, implicit 0); §3.14's list 10 bound to
 * the vty lines (row 10: 1, implicit: 2); list 20 configured and never applied (no rows); EMPTY an extended list
 * without entries; RETURN `permit tcp any any established`; DNS `permit udp any any eq domain`. R2 holds
 * 192.168.10.10 on Gi0/0 (a probe may name it); R3 has no address. The vty-logins rows: two successes (ssh, telnet),
 * a failure and a refusal. Built once: no test changes it.
 */
beforeAll(() => {
  sim = createStagedSimulation({ seed: 6, stage: 'P3', factories: { acl: stub('acl'), vty: stub('vty') } });
  for (const n of [1, 2, 3]) sim.addDevice({ id: `r${n}`, type: 'router.nf2911', name: `R${n}` });
  sim.addDevice({ id: 'pc1', type: 'pc.nfpc', name: 'PC1' });
  sim.runFor(60 * SEC);
  cfg('r1', [
    'access-list 10 permit host 192.168.10.10',
    'access-list 20 permit any',
    'ip access-list extended NO-WEB-PC1',
    DENY_WEB,
    PERMIT_ICMP,
    PERMIT_ANY,
    'exit',
    'ip access-list extended EMPTY',
    'exit',
    'ip access-list extended RETURN',
    'permit tcp any any established',
    'exit',
    'ip access-list extended DNS',
    'permit udp any any eq 53',
    'exit',
    'interface GigabitEthernet0/0',
    'ip access-group NO-WEB-PC1 in',
    'exit',
    'line vty 0 4',
    'access-class 10 in',
  ]);
  cfg('r2', ['interface GigabitEthernet0/0', 'ip address 192.168.10.10 255.255.255.0']);
  const acl = sim.device('r1')!.tables.get<AclRow>('acl')!;
  acl.set(row('NO-WEB-PC1', 'extended', 10, DENY_WEB, 'deny', 4, 'GigabitEthernet0/0 in'));
  acl.set(row('NO-WEB-PC1', 'extended', 20, PERMIT_ICMP, 'permit', 5, 'GigabitEthernet0/0 in'));
  acl.set(row('NO-WEB-PC1', 'extended', 30, PERMIT_ANY, 'permit', 0, 'GigabitEthernet0/0 in'));
  acl.set(row('NO-WEB-PC1', 'extended', 'implicit', 'deny ip any any', 'deny', 0, 'GigabitEthernet0/0 in'));
  acl.set(row('10', 'standard', 10, 'permit 192.168.10.10', 'permit', 1, 'vty in'));
  acl.set(row('10', 'standard', 'implicit', 'deny any', 'deny', 2, 'vty in'));
  const logins = sim.device('r1')!.tables.get<VtyLoginRow>('vty-logins')!;
  const login = (seq: number, proto: 'telnet' | 'ssh', result: VtyLoginRow['result']): VtyLoginRow => ({
    key: String(seq),
    updatedAt: 0,
    seq,
    proto,
    peer: '192.168.10.10',
    user: 'admin',
    result,
    at: 0,
  });
  logins.set(login(1, 'ssh', 'success'));
  logins.set(login(2, 'telnet', 'success'));
  logins.set(login(3, 'ssh', 'failed'));
  logins.set(login(4, 'ssh', 'refused'));
});

/** The detail of one assertion (undefined = it passed). */
function detail(a: LabAssertion): string | undefined {
  const r = runCheck({ sim, host: undefined }, a);
  return r.pass ? undefined : (r.detail ?? '(no detail)');
}

const acl = (over: Partial<Extract<LabAssertion, { kind: 'acl' }>>): LabAssertion => ({ kind: 'acl', device: 'R1', list: 'NO-WEB-PC1', ...over });
const decide = (list: string, packet: LabPacketProbe, expectWord: 'permit' | 'deny', entry?: number | 'implicit'): LabAssertion => ({
  kind: 'aclDecision',
  device: 'R1',
  list,
  packet,
  expect: expectWord,
  ...(entry === undefined ? {} : { entry }),
});

describe('the registry runs the acl adapter (a reviewed edit of registry.ts)', () => {
  it('acl and aclDecision are no longer stubs; the kinds a later item brings still are', () => {
    expect(Object.keys(UNAVAILABLE_KIND_DETAILS)).toEqual(['service', 'path', 'traffic']);
    expect(detail({ kind: 'acl', device: 'R1', list: '101' })).toBe('R1 has no access list 101.');
    expect(detail(decide('101', { proto: 'ip', src: '10.0.0.1', dst: '10.0.0.2' }, 'deny'))).toBe('R1 has no access list 101.');
    expect(typeof CHECKERS.acl).toBe('function');
    expect(detail({ kind: 'acl', device: 'R9', list: '10' })).toBe('There is no device called R9 in this topology.');
  });
});

describe('acl: content', () => {
  it('passes on §3.3’s list: type, entries in order, the binding, the hits of entry 10', () => {
    expect(detail(acl({ type: 'extended', entries: [DENY_WEB, PERMIT_ICMP, PERMIT_ANY], applied: [{ iface: 'Gi0/0', dir: 'in' }], entry: 10, minMatches: 4 }))).toBeUndefined();
  });

  it('entries compare in canonical form (eq 80 = eq www, host form, a leading sequence number, spaces)', () => {
    expect(canonicalAclEntry('extended', '10  deny tcp host 192.168.10.10 host 192.168.20.100 eq 80 log')).toBe(DENY_WEB);
    expect(canonicalAclEntry('standard', 'permit host 192.168.10.10')).toBe('permit 192.168.10.10');
    expect(canonicalAclEntry('extended', 'not an  entry')).toBe('not an entry');
    expect(detail(acl({ entries: ['deny tcp host 192.168.10.10 host 192.168.20.100 eq 80 log', PERMIT_ICMP, 'permit ip any any'] }))).toBeUndefined();
    expect(detail({ kind: 'acl', device: 'R1', list: '010', type: 'standard', entries: ['permit host 192.168.10.10'] })).toBeUndefined();
  });

  it('includes: each given entry, anywhere', () => {
    expect(detail(acl({ entries: [PERMIT_ANY, DENY_WEB], match: 'includes' }))).toBeUndefined();
    expect(detail(acl({ entries: [PERMIT_ANY, 'deny ip any any'], match: 'includes' }))).toBe('Access list NO-WEB-PC1 on R1 has no entry "deny ip any any".');
  });

  it('wrong answers: existence, type, order, a missing and an extra entry', () => {
    expect(detail(acl({ exists: false }))).toBe('R1 still has access list NO-WEB-PC1.');
    expect(detail(acl({ list: 'NOPE', exists: false }))).toBeUndefined();
    expect(detail(acl({ list: 'NOPE' }))).toBe('R1 has no access list NOPE.');
    expect(detail(acl({ type: 'standard' }))).toBe('Access list NO-WEB-PC1 on R1 is an extended list, expected a standard list.');
    expect(detail(acl({ list: '10', type: 'extended' }))).toBe('Access list 10 on R1 is a standard list, expected an extended list.');
    expect(detail(acl({ entries: [DENY_WEB, PERMIT_ANY, PERMIT_ICMP] }))).toBe(
      `Entry 2 of access list NO-WEB-PC1 on R1 is "${PERMIT_ICMP}", expected "${PERMIT_ANY}".`,
    );
    expect(detail(acl({ entries: [DENY_WEB, PERMIT_ICMP, PERMIT_ANY, 'deny ip any any'] }))).toBe(
      'Access list NO-WEB-PC1 on R1 has 3 entries; entry 4 should be "deny ip any any".',
    );
    expect(detail(acl({ entries: [DENY_WEB, PERMIT_ICMP] }))).toBe(`Access list NO-WEB-PC1 on R1 has an extra entry 3, "${PERMIT_ANY}".`);
  });
});

describe('acl: bindings (configuration)', () => {
  it('an interface binding per direction, and the vty binding', () => {
    expect(detail(acl({ applied: [{ iface: 'GigabitEthernet0/0', dir: 'in' }] }))).toBeUndefined();
    expect(detail(acl({ list: '10', applied: [{ vty: true, dir: 'in' }], entry: 'implicit', minMatches: 1 }))).toBeUndefined();
  });

  it('wrong answers: the direction, another list on the interface, the vty lines, an unknown interface', () => {
    expect(detail(acl({ applied: [{ iface: 'Gi0/0', dir: 'out' }] }))).toBe('R1 does not apply access list NO-WEB-PC1 to Gi0/0 out.');
    expect(detail(acl({ list: '10', applied: [{ iface: 'Gi0/0', dir: 'in' }] }))).toBe('R1 does not apply access list 10 to Gi0/0 in; it applies NO-WEB-PC1 there.');
    expect(detail(acl({ applied: [{ vty: true, dir: 'in' }] }))).toBe('R1 does not apply access list NO-WEB-PC1 to its vty lines (access-class NO-WEB-PC1 in).');
    expect(detail(acl({ list: '10', applied: [{ vty: true, dir: 'out' }] }))).toBe('The vty lines bind an access list inbound only (access-class 10 in), not out.');
    expect(detail(acl({ applied: [{ iface: 'Gi9/9', dir: 'in' }] }))).toBe('R1 has no interface called Gi9/9.');
    expect(detail(acl({ applied: [{ dir: 'in' }] }))).toBe('A binding of access list NO-WEB-PC1 names neither an interface nor the vty lines.');
  });
});

describe('acl: entry and minMatches (the acl table)', () => {
  it('one entry’s row, the implicit row, the list’s sum', () => {
    expect(detail(acl({ entry: 20, minMatches: 5 }))).toBeUndefined();
    expect(detail(acl({ entry: 30 }))).toBeUndefined();
    expect(detail(acl({ entry: 'implicit' }))).toBeUndefined();
    expect(detail(acl({ minMatches: 9 }))).toBeUndefined();
  });

  it('wrong answers: an entry the list lacks, too few hits on an entry, on the implicit deny, on the list', () => {
    expect(detail(acl({ entry: 40 }))).toBe('Access list NO-WEB-PC1 on R1 has no entry 40.');
    expect(detail(acl({ entry: 30, minMatches: 1 }))).toBe('Entry 30 of access list NO-WEB-PC1 on R1 has 0 matches, expected at least 1.');
    expect(detail(acl({ entry: 10, minMatches: 5 }))).toBe('Entry 10 of access list NO-WEB-PC1 on R1 has 4 matches, expected at least 5.');
    expect(detail(acl({ entry: 'implicit', minMatches: 1 }))).toBe('The implicit deny of access list NO-WEB-PC1 on R1 has 0 matches, expected at least 1.');
    expect(detail(acl({ list: '10', entry: 10, minMatches: 2 }))).toBe('Entry 10 of access list 10 on R1 has 1 match, expected at least 2.');
    expect(detail(acl({ minMatches: 10 }))).toBe('Access list NO-WEB-PC1 on R1 has 9 matches, expected at least 10.');
  });

  it('an unapplied list counts nothing, and the detail says why', () => {
    expect(detail(acl({ list: '20', minMatches: 1 }))).toBe(
      'Access list 20 on R1 has 0 matches, expected at least 1 (the list is not applied as a filter, so nothing is counted).',
    );
  });
});

describe('aclDecision (pure: the configured list, evaluateAcl)', () => {
  const web: LabPacketProbe = { proto: 'tcp', src: '192.168.10.10', dst: '192.168.20.100', dstPort: 80 };

  it('the probe becomes the daemon’s tuple', () => {
    expect(probeTuple(sim, web)).toEqual({ tuple: { family: 4, proto: 6, src: '192.168.10.10', dst: '192.168.20.100', srcPort: 49152, dstPort: 80, tcpFlags: 0x02 } });
    expect(probeTuple(sim, { ...web, established: true, srcPort: 1234 })).toEqual({
      tuple: { family: 4, proto: 6, src: '192.168.10.10', dst: '192.168.20.100', srcPort: 1234, dstPort: 80, tcpFlags: 0x10 },
    });
    expect(probeTuple(sim, { proto: 'icmp', src: 'R2', dst: '10.0.0.1' })).toEqual({
      tuple: { family: 4, proto: 1, src: '192.168.10.10', dst: '10.0.0.1', icmpType: 8, icmpCode: 0 },
    });
    expect(probeTuple(sim, { proto: 'udp', src: '10.0.0.1', dst: '10.0.0.2', dstPort: 53 })).toEqual({
      tuple: { family: 4, proto: 17, src: '10.0.0.1', dst: '10.0.0.2', srcPort: 49152, dstPort: 53 },
    });
    expect(probeTuple(sim, { proto: 'ip', src: '10.0.0.1', dst: '10.0.0.2' })).toEqual({ tuple: { family: 4, proto: LAB_PROBE_IP_PROTOCOL, src: '10.0.0.1', dst: '10.0.0.2' } });
  });

  it('§3.3: PC1’s HTTP is denied by entry 10, its ping permitted by entry 20, other traffic by entry 30', () => {
    expect(detail(decide('NO-WEB-PC1', web, 'deny', 10))).toBeUndefined();
    expect(detail(decide('NO-WEB-PC1', { ...web, src: 'R2' }, 'deny'))).toBeUndefined();
    expect(detail(decide('NO-WEB-PC1', { proto: 'icmp', src: '192.168.10.10', dst: '192.168.20.100' }, 'permit', 20))).toBeUndefined();
    expect(detail(decide('NO-WEB-PC1', { ...web, src: '192.168.10.11' }, 'permit', 30))).toBeUndefined();
    expect(detail(decide('NO-WEB-PC1', { proto: 'ip', src: '10.1.1.1', dst: '10.2.2.2' }, 'permit', 30))).toBeUndefined();
  });

  it('a wrong action, or the right action decided by another entry', () => {
    expect(detail(decide('NO-WEB-PC1', web, 'permit'))).toBe(
      `Access list NO-WEB-PC1 on R1 denies a TCP segment from 192.168.10.10 port 49152 to 192.168.20.100 port 80 by entry 10 (${DENY_WEB}); expected permit.`,
    );
    expect(detail(decide('NO-WEB-PC1', { proto: 'icmp', src: '192.168.10.10', dst: '192.168.20.100' }, 'permit', 30))).toBe(
      `Access list NO-WEB-PC1 on R1 permits an ICMP echo request from 192.168.10.10 to 192.168.20.100 by entry 20 (${PERMIT_ICMP}); expected entry 30 to decide it.`,
    );
  });

  it('the implicit deny of a standard list', () => {
    const other: LabPacketProbe = { proto: 'ip', src: '192.168.10.11', dst: '192.168.10.1' };
    expect(detail(decide('10', other, 'deny', 'implicit'))).toBeUndefined();
    expect(detail(decide('10', { ...other, src: '192.168.10.10' }, 'permit', 10))).toBeUndefined();
    expect(detail(decide('10', other, 'permit'))).toBe('Access list 10 on R1 denies an IP packet from 192.168.10.11 to 192.168.10.1 by its implicit deny; expected permit.');
    expect(detail(decide('10', { ...other, src: '192.168.10.10' }, 'permit', 'implicit'))).toBe(
      'Access list 10 on R1 permits an IP packet from 192.168.10.10 to 192.168.10.1 by entry 10 (permit 192.168.10.10); expected the implicit deny to decide it.',
    );
  });

  it('established and UDP ports', () => {
    const ret: LabPacketProbe = { proto: 'tcp', src: '192.168.20.100', dst: '192.168.10.10', srcPort: 80, dstPort: 49152, established: true };
    expect(detail(decide('RETURN', ret, 'permit', 10))).toBeUndefined();
    expect(detail(decide('RETURN', { ...ret, established: false }, 'permit'))).toBe(
      'Access list RETURN on R1 denies a TCP segment from 192.168.20.100 port 80 to 192.168.10.10 port 49152 by its implicit deny; expected permit.',
    );
    expect(detail(decide('DNS', { proto: 'udp', src: '10.0.0.1', dst: '10.0.0.2', dstPort: 53 }, 'permit', 10))).toBeUndefined();
    expect(detail(decide('DNS', { proto: 'udp', src: '10.0.0.1', dst: '10.0.0.2', dstPort: 54 }, 'permit'))).toBe(
      'Access list DNS on R1 denies a UDP datagram from 10.0.0.1 port 49152 to 10.0.0.2 port 54 by its implicit deny; expected permit.',
    );
  });

  it('a list without entries filters nothing', () => {
    const p: LabPacketProbe = { proto: 'ip', src: '10.0.0.1', dst: '10.0.0.2' };
    expect(detail(decide('EMPTY', p, 'permit'))).toBeUndefined();
    expect(detail(decide('EMPTY', p, 'deny', 'implicit'))).toBe(
      'Access list EMPTY on R1 has no permit or deny entry, so it filters nothing: it permits an IP packet from 10.0.0.1 to 10.0.0.2; expected deny by the implicit deny.',
    );
  });

  it('a probe address that names nothing, or a device without an IPv4 address', () => {
    expect(detail(decide('10', { proto: 'ip', src: 'Nowhere', dst: '10.0.0.1' }, 'deny'))).toBe('There is no device called Nowhere in this topology.');
    expect(detail(decide('10', { proto: 'ip', src: '10.0.0.1', dst: 'R3' }, 'deny'))).toBe('R3 has no IPv4 address.');
  });
});

describe('[S13] vty.logins (the vty-logins rows)', () => {
  const logins = (over: { device?: string; subject?: string; equals?: number; atLeast?: number } = {}): LabAssertion => ({
    kind: 'fact',
    device: over.device ?? 'R1',
    fact: 'vty.logins' as LabFactName,
    ...(over.subject === undefined ? {} : { subject: over.subject }),
    ...(over.equals === undefined ? {} : { equals: over.equals }),
    ...(over.atLeast === undefined ? {} : { atLeast: over.atLeast }),
  });

  it('is wired and names its table', () => {
    expect(FACT_READERS['vty.logins']).toBe(ACL_FACT_READERS['vty.logins']);
    expect(ACL_FACT_READERS['vty.logins']?.type).toBe('number');
    expect(ACL_FACT_READERS['vty.logins']?.source).toBe("vty-logins (rows with result 'success')");
  });

  it('counts the successful logins, per protocol', () => {
    expect(detail(logins({ equals: 2 }))).toBeUndefined();
    expect(detail(logins({ subject: 'ssh', equals: 1 }))).toBeUndefined();
    expect(detail(logins({ subject: 'TELNET', atLeast: 1 }))).toBeUndefined();
  });

  it('wrong answers; a device without the table; a subject that is not a protocol', () => {
    expect(detail(logins({ subject: 'ssh', atLeast: 2 }))).toBe('R1 vty.logins of ssh is 1, expected at least 2.');
    expect(detail(logins({ equals: 3 }))).toBe('R1 vty.logins is 2, expected 3.');
    expect(detail(logins({ device: 'PC1', atLeast: 1 }))).toBe('PC1 vty.logins is not set, expected at least 1.');
    expect(detail(logins({ subject: 'http' }))).toBe('vty.logins takes telnet or ssh as its subject, not "http".');
  });
});
