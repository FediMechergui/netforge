/**
 * acl.daemon.ipv6 — [S11] IPv6 access lists in the acl daemon, protocols/acl.ts (ARCHITECTURE-P3C §2.4, §2.6, §3.6,
 * §7 W2a acl, §9.2 W2a item 17):
 *  • `readTrafficFilters` and `readVtyAccessClasses6` read the bindings (one per direction, later line wins; per vty
 *    line, a later section wins);
 *  • family-keyed state: an IPv6 list gets rows `aclKey(6, list, seq)` plus the implicit ND tail (`nd-na`, `nd-ns`,
 *    `implicit`) only while applied; an IPv4 list of the same name is a different list; family-4 rows keep their bytes;
 *  • `acl.filter {family 6}`: the first match decides, a deny drops `acl-deny` with a family-6 DropRule and asks icmpv6
 *    for 1/1 from the ingress interface (its own 500 ms gate, beside the IPv4 one); ND never draws an error;
 *  • the §3.6 walk-through at the daemon: an explicit `deny ipv6 any any` takes the NS on row 10, inserting the ND
 *    permits above it restores it; with no explicit deny, the tail's `nd-ns` / `nd-na` rows count;
 *  • `acl.check {family 6}` (vty `ipv6 access-class`), `acl.clear {family}` per family, the StateView's family-6
 *    members only once there is something to show; `log` on an IPv6 entry.
 */
import { describe, expect, it } from 'vitest';
import { ICMPV6_ECHO_REQUEST, ICMPV6_NA, ICMPV6_NS } from '../src/contracts/pdu.js';
import { aclKey } from '../src/contracts/tables.js';
import { SEC } from '../src/contracts/time.js';
import { createConfigAst } from '../src/cli/config-ast.js';
import {
  ACL6_UNREACH_RATE_NS,
  ACL_LOG_FACILITY,
  ACL_LOG_SEVERITY,
  ACL_LOG_TIMER,
  ICMPV6_UNREACH_ADMIN,
  readTrafficFilters,
  readVtyAccessClasses6,
} from '../src/protocols/acl.js';
import { drops, GI0, GI1, icmp6, logs, MS, pkt, pkt6, requestsTo, rig, tcpSyn, tcpSyn6, udp6, type AclRig } from './acl.daemon.rig.js';

const PC1 = '2001:db8:10::10';
const PC2 = '2001:db8:10::11';
const SRV = '2001:db8:20::100';
const R1_GI0 = '2001:db8:10::1';
const SN_R1 = 'ff02::1:ff00:1';
const LIST = 'NO-WEB6';
const SECTION = ['ipv6', 'access-list', LIST];
const ENTRY_10 = 'deny tcp host 2001:db8:10::10 host 2001:db8:20::100 eq www';
const ENTRY_20 = 'permit ipv6 any any';

/** §3.6's NO-WEB6, bound `ipv6 traffic-filter NO-WEB6 in` on Gi0/0 when `bind`. */
function noWeb6(r: AclRig, bind = true): void {
  r.line([], SECTION.join(' '));
  r.line([SECTION], ENTRY_10);
  r.line([SECTION], ENTRY_20);
  if (bind) r.line([['interface', GI0]], `ipv6 traffic-filter ${LIST} in`);
}

const t = (s: string): string[] => s.split(' ');

describe('acl.daemon [S11]: the IPv6 binding readers', () => {
  it('readTrafficFilters: one list per direction, names as typed, later line wins; interfaces without one absent', () => {
    const ast = createConfigAst();
    ast.set([], t(`interface ${GI0}`));
    ast.set([['interface', GI0]], t('ipv6 traffic-filter IN6 in'));
    ast.set([['interface', GI0]], t('ipv6 traffic-filter OUT6 out'));
    ast.set([['interface', GI0]], t('ip access-group 101 in'));
    ast.set([], t(`interface ${GI1}`));
    ast.set([['interface', GI1]], t('ip access-group 101 out'));
    expect([...readTrafficFilters(ast)]).toEqual([[GI0, { in: 'IN6', out: 'OUT6' }]]);
    ast.set([['interface', GI0]], t('ipv6 traffic-filter LATER6 in'));
    expect(readTrafficFilters(ast).get(GI0)).toEqual({ in: 'LATER6', out: 'OUT6' });
  });

  it('readVtyAccessClasses6: per line, a later section binding another list wins; IPv4 access-class is not read', () => {
    const ast = createConfigAst();
    ast.set([], t('line vty 0 4'));
    ast.set([['line', 'vty', '0', '4']], t('ipv6 access-class MGMT6 in'));
    ast.set([['line', 'vty', '0', '4']], t('access-class 10 in'));
    expect(readVtyAccessClasses6(ast)).toEqual(['MGMT6']);
    ast.set([], t('line vty 5 15'));
    ast.set([['line', 'vty', '5', '15']], t('ipv6 access-class OTHER6 in'));
    expect(readVtyAccessClasses6(ast)).toEqual(['MGMT6', 'OTHER6']);
    ast.set([], t('line vty 0 15'));
    ast.set([['line', 'vty', '0', '15']], t('ipv6 access-class ALL6 in'));
    expect(readVtyAccessClasses6(ast)).toEqual(['ALL6']);
  });
});

describe('acl.daemon [S11]: family-6 rows, the ND tail and family-keyed state (§2.6, §3.6)', () => {
  it('an applied IPv6 list has one row per entry plus nd-na, nd-ns and the implicit deny; none while unbound', () => {
    const r = rig();
    noWeb6(r, false);
    expect(r.table.rows()).toEqual([]);
    r.line([['interface', GI0]], `ipv6 traffic-filter ${LIST} in`);
    const applied = `${GI0} in`;
    const now = r.ctx.now;
    expect(r.table.rows()).toEqual([
      { key: aclKey(6, LIST, 10), family: 6, list: LIST, type: 'ipv6', seq: 10, entry: ENTRY_10, action: 'deny', matches: 0, applied, updatedAt: now },
      { key: aclKey(6, LIST, 20), family: 6, list: LIST, type: 'ipv6', seq: 20, entry: ENTRY_20, action: 'permit', matches: 0, applied, updatedAt: now },
      { key: aclKey(6, LIST, 'nd-na'), family: 6, list: LIST, type: 'ipv6', seq: null, implicit: 'nd-na', entry: 'permit icmp any any nd-na', action: 'permit', matches: 0, applied, updatedAt: now },
      { key: aclKey(6, LIST, 'nd-ns'), family: 6, list: LIST, type: 'ipv6', seq: null, implicit: 'nd-ns', entry: 'permit icmp any any nd-ns', action: 'permit', matches: 0, applied, updatedAt: now },
      { key: aclKey(6, LIST, 'implicit'), family: 6, list: LIST, type: 'ipv6', seq: null, implicit: 'deny', entry: 'deny ipv6 any any', action: 'deny', matches: 0, applied, updatedAt: now },
    ]);
    expect(r.table.rows().map((x) => x.key)).toEqual(['6|NO-WEB6|10', '6|NO-WEB6|20', '6|NO-WEB6|nd-na', '6|NO-WEB6|nd-ns', '6|NO-WEB6|implicit']);
    // an outbound filter on Gi0/1 joins the applied text; removing both deletes every row
    r.line([['interface', GI1]], `ipv6 traffic-filter ${LIST} out`);
    expect(new Set(r.table.rows().map((x) => x.applied))).toEqual(new Set([`${GI0} in, ${GI1} out`]));
    r.line([['interface', GI0]], `ipv6 traffic-filter ${LIST} in`, true);
    r.line([['interface', GI1]], `ipv6 traffic-filter ${LIST} out`, true);
    expect(r.table.rows()).toEqual([]);
  });

  it('a list without entries permits everything and gets no row; `ip access-group` never binds an IPv6 list', () => {
    const r = rig();
    r.line([], SECTION.join(' '));
    r.line([['interface', GI0]], `ipv6 traffic-filter ${LIST} in`);
    expect(r.table.rows()).toEqual([]);
    const pdu = pkt6(r, tcpSyn6(PC1, 49152, SRV, 80));
    const { actions, onPermit } = r.filter(pdu, 'in', GI0, { family: 6 });
    expect(actions).toEqual([onPermit]);
    expect(r.aclDebug().at(-1)).toBe(`ipv6 list ${LIST} is not defined: permitted tcp ${PC1}(49152) -> ${SRV}(80) inbound on ${GI0}`);
    r.line([['interface', GI0]], `ipv6 traffic-filter ${LIST} in`, true);
    r.line([SECTION], ENTRY_10);
    r.line([['interface', GI0]], `ip access-group ${LIST} in`);
    expect(r.table.rows()).toEqual([]);
  });

  it('an IPv4 list and an IPv6 list of one name are two lists: separate rows, separate bindings, separate decisions', () => {
    // (the CLI refuses this collision, RC6 (e): config-ast numbers both lists as one, so the IPv4 entry here is 30)
    const r = rig();
    noWeb6(r);
    r.line([], `ip access-list extended ${LIST}`);
    r.line([['ip', 'access-list', 'extended', LIST]], 'permit ip any any');
    r.line([['interface', GI0]], `ip access-group ${LIST} in`);
    expect(r.table.rows().map((x) => [x.key, x.entry]).sort()).toEqual([
      ['4|NO-WEB6|30', 'permit ip any any'], ['4|NO-WEB6|implicit', 'deny ip any any'],
      ['6|NO-WEB6|10', ENTRY_10], ['6|NO-WEB6|20', ENTRY_20], ['6|NO-WEB6|implicit', 'deny ipv6 any any'],
      ['6|NO-WEB6|nd-na', 'permit icmp any any nd-na'], ['6|NO-WEB6|nd-ns', 'permit icmp any any nd-ns'],
    ]);
    // the IPv4 packet is decided by the IPv4 list (permit), the IPv6 SYN by the IPv6 list (deny)
    const v4 = r.filter(pkt(r, tcpSyn('192.168.10.10', 49152, '192.168.20.100', 80)), 'in', GI0);
    expect(v4.actions).toEqual([v4.onPermit]);
    const v6 = r.filter(pkt6(r, tcpSyn6(PC1, 49152, SRV, 80)), 'in', GI0, { family: 6 });
    expect(drops(v6.actions)).toHaveLength(1);
    expect(r.table.get('4|NO-WEB6|30')!.matches).toBe(1);
    expect(r.table.get('6|NO-WEB6|10')!.matches).toBe(1);
    // a family-6 request on an interface with only an IPv4 binding passes untouched (and the reverse)
    const r2 = rig();
    r2.line([], `ip access-list extended ${LIST}`);
    r2.line([['ip', 'access-list', 'extended', LIST]], 'deny ip any any');
    r2.line([['interface', GI0]], `ip access-group ${LIST} in`);
    const only4 = r2.filter(pkt6(r2, tcpSyn6(PC1, 49152, SRV, 80)), 'in', GI0, { family: 6 });
    expect(only4.actions).toEqual([only4.onPermit]);
  });
});

describe('acl.daemon [S11]: acl.filter family 6 (§3.6 walk-through, step 1)', () => {
  it('the SYN matches row 10: acl-deny with a family-6 rule, ICMPv6 1/1 with inPort; ping6 passes row 20', () => {
    const r = rig();
    noWeb6(r);
    r.at(10 * SEC);
    const syn = pkt6(r, tcpSyn6(PC1, 49152, SRV, 80));
    const { actions } = r.filter(syn, 'in', GI0, { family: 6 });
    expect(actions).toEqual([
      {
        type: 'drop', pdu: syn, reason: 'acl-deny', detail: `IPv6 ACL ${LIST} #10`, port: GI0,
        rule: {
          kind: 'acl', text: `denied by IPv6 access list ${LIST} line 10 (${ENTRY_10}), inbound on ${GI0}`, table: 'acl', key: aclKey(6, LIST, 10),
          iface: GI0, dir: 'in', list: LIST, seq: 10, family: 6, config: { context: [SECTION], line: t(ENTRY_10) },
        },
      },
      { type: 'request', to: 'icmpv6', req: { kind: 'icmp6.error', original: syn, type: 1, code: ICMPV6_UNREACH_ADMIN, inPort: GI0 } },
    ]);
    expect(r.table.get(aclKey(6, LIST, 10))).toMatchObject({ matches: 1, lastPdu: syn.id, lastAt: 10 * SEC, lastIface: GI0, lastDir: 'in' });
    expect(r.aclDebug().at(-1)).toBe(`ipv6 list ${LIST} line 10 denied tcp ${PC1}(49152) -> ${SRV}(80) inbound on ${GI0}`);
    const ping = pkt6(r, icmp6(PC1, SRV, ICMPV6_ECHO_REQUEST));
    const p = r.filter(ping, 'in', GI0, { family: 6 });
    expect(p.actions).toEqual([p.onPermit]);
    expect(r.table.get(aclKey(6, LIST, 20))).toMatchObject({ matches: 1, lastPdu: ping.id });
    expect(r.aclDebug().at(-1)).toBe(`ipv6 list ${LIST} line 20 permitted icmp ${PC1} -> ${SRV} (128/0) inbound on ${GI0}`);
  });

  it('ICMPv6 1/1 has its own 500 ms gate: SYN retries draw at most one per gate, and IPv4 3/13 is not limited by it', () => {
    const r = rig();
    noWeb6(r);
    r.line([], 'access-list 101 deny tcp any any eq www');
    r.line([['interface', GI1]], 'ip access-group 101 in');
    const send = (at: number) => {
      r.at(at);
      return requestsTo(r.filter(pkt6(r, tcpSyn6(PC1, 49152, SRV, 80)), 'in', GI0, { family: 6 }).actions, 'icmpv6');
    };
    expect(send(1 * SEC)).toHaveLength(1);
    expect(send(1 * SEC + 200 * MS)).toEqual([]);
    // an IPv4 deny inside the IPv6 gate still answers 3/13 (one gate per family)
    const v4 = r.filter(pkt(r, tcpSyn('192.168.20.100', 49152, '192.168.10.10', 80)), 'in', GI1);
    expect(requestsTo(v4.actions, 'icmpv4')).toHaveLength(1);
    expect(send(1 * SEC + ACL6_UNREACH_RATE_NS - 1)).toEqual([]);
    expect(send(1 * SEC + ACL6_UNREACH_RATE_NS)).toHaveLength(1);
    expect(r.table.get(aclKey(6, LIST, 10))!.matches).toBe(4);
    expect(r.acl.stateSnapshot().state).toMatchObject({ unreachablesSent: 1, unreachablesLimited: 0, unreachables6Sent: 2, unreachables6Limited: 2 });
  });

  it('an outbound deny: the error leaves by the packet\'s ingress (inPort); without one, icmpv6 picks the source', () => {
    const r = rig();
    r.line([], SECTION.join(' '));
    r.line([SECTION], ENTRY_10);
    r.line([SECTION], ENTRY_20);
    r.line([['interface', GI1]], `ipv6 traffic-filter ${LIST} out`);
    const syn = pkt6(r, tcpSyn6(PC1, 49152, SRV, 80));
    const out = r.filter(syn, 'out', GI1, { family: 6, inPort: GI0 });
    expect(drops(out.actions)[0]!.rule).toMatchObject({ dir: 'out', iface: GI1, text: `denied by IPv6 access list ${LIST} line 10 (${ENTRY_10}), outbound on ${GI1}` });
    expect(requestsTo(out.actions, 'icmpv6')).toEqual([{ kind: 'icmp6.error', original: syn, type: 1, code: 1, inPort: GI0 }]);
    r.at(r.ctx.now + SEC);
    const local = pkt6(r, tcpSyn6(PC1, 49153, SRV, 80));
    expect(requestsTo(r.filter(local, 'out', GI1, { family: 6 }).actions, 'icmpv6')).toEqual([{ kind: 'icmp6.error', original: local, type: 1, code: 1 }]);
  });

  it('no ICMPv6 for a multicast destination, an unspecified source or a non-echo ICMPv6 message; the gate stays open', () => {
    const r = rig();
    r.line([], SECTION.join(' '));
    r.line([SECTION], 'deny ipv6 any any');
    r.line([['interface', GI0]], `ipv6 traffic-filter ${LIST} in`);
    const quiet = [
      pkt6(r, udp6(PC1, 5000, 'ff02::1:2', 547)),
      pkt6(r, udp6('::', 546, SRV, 547)),
      pkt6(r, icmp6(PC1, R1_GI0, ICMPV6_NS, 255)),
      pkt6(r, icmp6(PC1, SRV, 1)),
    ];
    for (const p of quiet) {
      const a = r.filter(p, 'in', GI0, { family: 6 }).actions;
      expect(drops(a)).toHaveLength(1);
      expect(requestsTo(a, 'icmpv6')).toEqual([]);
    }
    expect(requestsTo(r.filter(pkt6(r, udp6(PC1, 5000, SRV, 53)), 'in', GI0, { family: 6 }).actions, 'icmpv6')).toHaveLength(1);
  });
});

describe('acl.daemon [S11]: the implicit ND tail (§3.6 walk-through, steps 2 and 3)', () => {
  it('an explicit deny ipv6 any any takes the NS on row 10; ND permits inserted above it restore neighbour discovery', () => {
    const r = rig();
    r.line([], SECTION.join(' '));
    r.line([SECTION], 'deny ipv6 any any');
    r.line([['interface', GI0]], `ipv6 traffic-filter ${LIST} in`);
    const ns = pkt6(r, icmp6(PC1, SN_R1, ICMPV6_NS, 255));
    const a = r.filter(ns, 'in', GI0, { family: 6 }).actions;
    expect(drops(a).map((d) => [d.reason, d.rule?.key])).toEqual([['acl-deny', aclKey(6, LIST, 10)]]);
    expect(requestsTo(a, 'icmpv6')).toEqual([]);
    expect(r.table.get(aclKey(6, LIST, 10))!.matches).toBe(1);
    expect(r.table.get(aclKey(6, LIST, 'nd-ns'))!.matches).toBe(0);
    r.line([SECTION], 'sequence 5 permit icmp any any nd-ns');
    r.line([SECTION], 'sequence 6 permit icmp any any nd-na');
    expect(r.table.rows().filter((x) => x.seq !== null).map((x) => [x.seq, x.entry]).sort((a, b) => Number(a[0]) - Number(b[0]))).toEqual([
      [5, 'permit icmp any any nd-ns'], [6, 'permit icmp any any nd-na'], [10, 'deny ipv6 any any'],
    ]);
    const again = r.filter(pkt6(r, icmp6(PC1, SN_R1, ICMPV6_NS, 255)), 'in', GI0, { family: 6 });
    expect(again.actions).toEqual([again.onPermit]);
    expect(r.table.get(aclKey(6, LIST, 5))!.matches).toBe(1);
  });

  it('with no explicit deny, the NS and NA pass on the tail\'s nd-ns / nd-na rows; anything else meets the implicit deny', () => {
    const r = rig();
    r.line([], SECTION.join(' '));
    r.line([SECTION], 'permit tcp any any eq 22');
    r.line([['interface', GI0]], `ipv6 traffic-filter ${LIST} in`);
    for (const type of [ICMPV6_NS, ICMPV6_NA, ICMPV6_NS]) {
      const p = r.filter(pkt6(r, icmp6(PC1, R1_GI0, type, 255)), 'in', GI0, { family: 6 });
      expect(p.actions).toEqual([p.onPermit]);
    }
    expect(r.table.get(aclKey(6, LIST, 'nd-ns'))!.matches).toBe(2);
    expect(r.table.get(aclKey(6, LIST, 'nd-na'))!.matches).toBe(1);
    expect(r.aclDebug().at(-1)).toBe(`ipv6 list ${LIST} implicit nd-ns permitted icmp ${PC1} -> ${R1_GI0} (135/0) inbound on ${GI0}`);
    // an RS is not in the tail
    const rs = pkt6(r, icmp6(PC1, 'ff02::2', 133, 255));
    const denied = r.filter(rs, 'in', GI0, { family: 6 }).actions;
    expect(drops(denied)).toEqual([
      {
        type: 'drop', pdu: rs, reason: 'acl-deny', detail: `IPv6 ACL ${LIST} implicit deny`, port: GI0,
        rule: {
          kind: 'acl', text: `denied by the implicit deny at the end of IPv6 access list ${LIST}, inbound on ${GI0}`, table: 'acl',
          key: aclKey(6, LIST, 'implicit'), config: { context: [['interface', GI0]], line: ['ipv6', 'traffic-filter', LIST, 'in'] },
          iface: GI0, dir: 'in', list: LIST, seq: 'implicit', family: 6,
        },
      },
    ]);
    expect(r.table.get(aclKey(6, LIST, 'implicit'))!.matches).toBe(1);
  });
});

describe('acl.daemon [S11]: acl.check family 6, acl.clear per family, the StateView, log', () => {
  it('acl.check {family 6}: the vty IPv6 list (rows "vty in" only where vty runs), counted with lastIface vty', () => {
    const tuple = { family: 6 as const, proto: 6, src: PC2, dst: R1_GI0, srcPort: 49152, dstPort: 22, tcpFlags: 0x02 };
    const without = rig();
    without.line([], 'ipv6 access-list VTY6');
    without.line([['ipv6', 'access-list', 'VTY6']], `permit ipv6 host ${PC1} any`);
    without.line([['line', 'vty', '0', '4']], 'ipv6 access-class VTY6 in');
    expect(without.table.rows()).toEqual([]);
    const r = rig(['vty']);
    r.line([], 'ipv6 access-list VTY6');
    r.line([['ipv6', 'access-list', 'VTY6']], `permit ipv6 host ${PC1} any`);
    r.line([['line', 'vty', '0', '4']], 'ipv6 access-class VTY6 in');
    expect(r.table.rows().map((x) => [x.key, x.applied])).toEqual([
      ['6|VTY6|10', 'vty in'], ['6|VTY6|nd-na', 'vty in'], ['6|VTY6|nd-ns', 'vty in'], ['6|VTY6|implicit', 'vty in'],
    ]);
    r.at(5 * SEC);
    expect(r.acl.onRequest!(r.ctx, { kind: 'acl.check', family: 6, list: 'VTY6', tuple, token: 'v6-1', owner: 'vty' })).toEqual([
      { type: 'event', to: 'vty', ev: { kind: 'acl.verdict', token: 'v6-1', action: 'deny', seq: 'implicit' } },
    ]);
    expect(r.table.get('6|VTY6|implicit')).toMatchObject({ matches: 1, lastAt: 5 * SEC, lastIface: 'vty', lastDir: 'in' });
    expect(r.table.get('6|VTY6|implicit')).not.toHaveProperty('lastPdu');
    expect(r.acl.onRequest!(r.ctx, { kind: 'acl.check', family: 6, list: 'VTY6', tuple: { ...tuple, src: PC1 }, token: 'v6-2', owner: 'vty' })).toEqual([
      { type: 'event', to: 'vty', ev: { kind: 'acl.verdict', token: 'v6-2', action: 'permit', seq: 10 } },
    ]);
    expect(r.table.get('6|VTY6|10')).toMatchObject({ matches: 1, lastIface: 'vty' });
    // an IPv6 check never reads the IPv4 list of the same name, and an undefined list admits the login
    r.line([], 'ip access-list standard VTY6');
    r.line([['ip', 'access-list', 'standard', 'VTY6']], 'permit any');
    expect(r.acl.onRequest!(r.ctx, { kind: 'acl.check', family: 6, list: 'VTY6', tuple, token: 'v6-3', owner: 'vty' })).toEqual([
      { type: 'event', to: 'vty', ev: { kind: 'acl.verdict', token: 'v6-3', action: 'deny', seq: 'implicit' } },
    ]);
    const n = r.writes().length;
    expect(r.acl.onRequest!(r.ctx, { kind: 'acl.check', family: 6, list: 'NONE6', tuple, token: 'v6-4', owner: 'vty' })).toEqual([
      { type: 'event', to: 'vty', ev: { kind: 'acl.verdict', token: 'v6-4', action: 'permit', seq: 'implicit' } },
    ]);
    expect(r.writes()).toHaveLength(n);
  });

  it('acl.clear {family 6} clears IPv6 rows only (one list or all); family absent clears IPv4 rows only', () => {
    const r = rig();
    noWeb6(r);
    r.line([], 'access-list 101 deny tcp any any eq www');
    r.line([['interface', GI1]], 'ip access-group 101 in');
    r.filter(pkt6(r, tcpSyn6(PC1, 49152, SRV, 80)), 'in', GI0, { family: 6 });
    r.filter(pkt(r, tcpSyn('192.168.20.100', 49152, '192.168.10.10', 80)), 'in', GI1);
    r.acl.onRequest!(r.ctx, { kind: 'acl.clear' });
    expect(r.table.get('4|101|10')).not.toHaveProperty('lastAt');
    expect(r.table.get('4|101|10')!.matches).toBe(0);
    expect(r.table.get(aclKey(6, LIST, 10))!.matches).toBe(1);
    expect(r.aclDebug().at(-1)).toBe('counters cleared on every access list');
    r.filter(pkt(r, tcpSyn('192.168.20.100', 49152, '192.168.10.10', 80)), 'in', GI1);
    r.acl.onRequest!(r.ctx, { kind: 'acl.clear', family: 6, list: 'OTHER6' });
    expect(r.table.get(aclKey(6, LIST, 10))!.matches).toBe(1);
    expect(r.aclDebug().at(-1)).toBe('counters cleared on IPv6 access list OTHER6');
    r.acl.onRequest!(r.ctx, { kind: 'acl.clear', family: 6, list: LIST });
    expect(r.table.get(aclKey(6, LIST, 10))).toMatchObject({ matches: 0 });
    expect(r.table.get(aclKey(6, LIST, 10))).not.toHaveProperty('lastPdu');
    expect(r.table.get('4|101|10')!.matches).toBe(1);
    r.acl.onRequest!(r.ctx, { kind: 'acl.clear', family: 6 });
    expect(r.aclDebug().at(-1)).toBe('counters cleared on every IPv6 access list');
    expect(r.table.get('4|101|10')!.matches).toBe(1);
  });

  it('the StateView keeps its P3 shape until a family-6 list is applied, then shows applied6 and the family-6 gate', () => {
    const r = rig();
    r.line([], 'access-list 101 permit ip any any');
    r.line([['interface', GI0]], 'ip access-group 101 in');
    expect(r.acl.stateSnapshot()).toEqual({
      process: 'acl', state: { applied: [{ list: '101', applied: `${GI0} in` }], permitted: 0, denied: 0, unreachablesSent: 0, unreachablesLimited: 0, logFlows: 0 },
    });
    noWeb6(r);
    expect(r.acl.stateSnapshot()).toEqual({
      process: 'acl',
      state: {
        applied: [{ list: '101', applied: `${GI0} in` }], permitted: 0, denied: 0, unreachablesSent: 0, unreachablesLimited: 0, logFlows: 0,
        applied6: [{ list: LIST, applied: `${GI0} in` }], unreachables6Sent: 0, unreachables6Limited: 0,
      },
    });
  });

  it('a log entry of an IPv6 list logs the first packet of a flow at once and aggregates the rest', () => {
    const r = rig();
    r.line([], SECTION.join(' '));
    r.line([SECTION], `${ENTRY_10} log`);
    r.line([SECTION], ENTRY_20);
    r.line([['interface', GI0]], `ipv6 traffic-filter ${LIST} in`);
    const first = r.filter(pkt6(r, tcpSyn6(PC1, 49152, SRV, 80)), 'in', GI0, { family: 6 }).actions;
    expect(logs(first)).toEqual([
      { type: 'log', severity: ACL_LOG_SEVERITY, facility: ACL_LOG_FACILITY, message: `ipv6 list ${LIST} line 10 denied tcp ${PC1}(49152) -> ${SRV}(80), 1 packet` },
    ]);
    expect(first.filter((a) => a.type === 'timer')).toEqual([{ type: 'timer', key: ACL_LOG_TIMER, delay: 300 * SEC, periodic: true }]);
    expect(logs(r.filter(pkt6(r, tcpSyn6(PC1, 49152, SRV, 80)), 'in', GI0, { family: 6 }).actions)).toEqual([]);
    expect(r.acl.onTimer(r.ctx, ACL_LOG_TIMER).filter((a) => a.type === 'log').map((a) => (a as { message: string }).message)).toEqual([
      `ipv6 list ${LIST} line 10 denied tcp ${PC1}(49152) -> ${SRV}(80), 1 packet`,
    ]);
  });
});
