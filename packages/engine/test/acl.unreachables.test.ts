/**
 * acl.unreachables — [S12] `no ip unreachables` in the acl daemon, protocols/acl.ts (ARCHITECTURE-P3C §5 [S12] rows,
 * §7 W2a acl, §8.5b A-4; the `acl.filter` contract, contracts/process.ts):
 *  • `readNoIpUnreachables` reads the stored negation (the `bothForms` slot keeps `no ip unreachables` as typed);
 *  • a deny on an interface whose section stores it answers the drop with no ICMP 3/13, and leaves the 500 ms gate open,
 *    so `ip unreachables` typed back restores the error at once;
 *  • the interface read is the one the error would leave by: `iface` inbound, the packet's ingress (`inPort`)
 *    outbound, else `iface`;
 *  • it is IPv4 only: an IPv6 deny on that interface still answers ICMPv6 1/1;
 *  • a real world (staged P3): with `no ip unreachables` on R1's Gi0/0, PC1's denied pings draw no 3/13 from R1.
 */
import { describe, expect, it } from 'vitest';
import { SEC } from '../src/contracts/time.js';
import { createConfigAst } from '../src/cli/config-ast.js';
import { PING_COUNT } from '../src/cli/handlers/exec.js';
import { readNoIpUnreachables } from '../src/protocols/acl.js';
import { echoRequest } from './ip.fake-ctx.js';
import { ofKind } from './sim.harness.js';
import { drops, GI0, GI1, MS, pingFrom, pkt, pkt6, PC1, requestsTo, rig, SRV, tcpSyn, tcpSyn6, world, type AclRig } from './acl.daemon.rig.js';

const t = (s: string): string[] => s.split(' ');

function denyAll(r: AclRig, iface: string, dir: 'in' | 'out'): void {
  r.line([], 'access-list 101 deny tcp any any eq www');
  r.line([], 'access-list 101 permit ip any any');
  r.line([['interface', iface]], `ip access-group 101 ${dir}`);
}

describe('acl.unreachables [S12]: readNoIpUnreachables', () => {
  it('reads the stored negation per interface; the positive form or nothing reads as the default', () => {
    const ast = createConfigAst();
    ast.set([], t(`interface ${GI0}`));
    ast.set([], t(`interface ${GI1}`));
    expect([...readNoIpUnreachables(ast)]).toEqual([]);
    ast.unset([['interface', GI0]], t('ip unreachables'));
    expect([...readNoIpUnreachables(ast)]).toEqual([GI0]);
    ast.set([['interface', GI0]], t('ip unreachables'));
    expect([...readNoIpUnreachables(ast)]).toEqual([]);
  });
});

describe('acl.unreachables [S12]: no ip unreachables silences ICMP 3/13 for ACL denies', () => {
  it('inbound: the drop stays, the error goes, the gate stays open; ip unreachables brings it back at once', () => {
    const r = rig();
    denyAll(r, GI0, 'in');
    r.line([['interface', GI0]], 'ip unreachables', true);
    r.at(1 * SEC);
    const syn = pkt(r, tcpSyn(PC1, 49152, SRV, 80));
    const a = r.filter(syn, 'in', GI0).actions;
    expect(drops(a).map((d) => [d.reason, d.rule?.key])).toEqual([['acl-deny', '4|101|10']]);
    expect(requestsTo(a, 'icmpv4')).toEqual([]);
    expect(r.aclDebug().at(-1)).toBe(`no unreachable for tcp ${PC1}(49152) -> ${SRV}(80): no ip unreachables on ${GI0}`);
    expect(r.acl.stateSnapshot().state).toMatchObject({ denied: 1, unreachablesSent: 0, unreachablesLimited: 0 });
    // typed back 100 ms later: the next deny answers at once (the suppressed one never closed the gate)
    r.line([['interface', GI0]], 'ip unreachables');
    r.at(1 * SEC + 100 * MS);
    const again = pkt(r, tcpSyn(PC1, 49152, SRV, 80));
    expect(requestsTo(r.filter(again, 'in', GI0).actions, 'icmpv4')).toEqual([{ kind: 'icmp.error', original: again, type: 3, code: 13, inPort: GI0 }]);
  });

  it('outbound: the ingress interface (inPort) decides, not the filtering one; without inPort the filtering one does', () => {
    const r = rig();
    denyAll(r, GI1, 'out');
    r.line([['interface', GI1]], 'ip unreachables', true);
    r.at(1 * SEC);
    const fromPc = pkt(r, tcpSyn(PC1, 49152, SRV, 80));
    expect(requestsTo(r.filter(fromPc, 'out', GI1, { inPort: GI0 }).actions, 'icmpv4')).toEqual([{ kind: 'icmp.error', original: fromPc, type: 3, code: 13, inPort: GI0 }]);
    r.at(2 * SEC);
    expect(requestsTo(r.filter(pkt(r, tcpSyn('192.168.20.1', 1024, SRV, 80)), 'out', GI1).actions, 'icmpv4')).toEqual([]);
    r.line([['interface', GI1]], 'ip unreachables');
    r.line([['interface', GI0]], 'ip unreachables', true);
    r.at(3 * SEC);
    expect(requestsTo(r.filter(pkt(r, tcpSyn(PC1, 49152, SRV, 80)), 'out', GI1, { inPort: GI0 }).actions, 'icmpv4')).toEqual([]);
  });

  it('IPv4 only: an IPv6 deny on the same interface still answers ICMPv6 1/1', () => {
    const r = rig();
    r.line([], 'ipv6 access-list NO-WEB6');
    r.line([['ipv6', 'access-list', 'NO-WEB6']], 'deny tcp any any eq www');
    r.line([['interface', GI0]], 'ipv6 traffic-filter NO-WEB6 in');
    r.line([['interface', GI0]], 'ip unreachables', true);
    const syn = pkt6(r, tcpSyn6('2001:db8:10::10', 49152, '2001:db8:20::100', 80));
    expect(requestsTo(r.filter(syn, 'in', GI0, { family: 6 }).actions, 'icmpv6')).toEqual([{ kind: 'icmp6.error', original: syn, type: 1, code: 1, inPort: GI0 }]);
  });

  it('a permitted packet is untouched by it', () => {
    const r = rig();
    denyAll(r, GI0, 'in');
    r.line([['interface', GI0]], 'ip unreachables', true);
    const echo = r.filter(pkt(r, echoRequest(PC1, SRV, 1, 1)), 'in', GI0);
    expect(echo.actions).toEqual([echo.onPermit]);
  });
});

describe('acl.unreachables [S12] in a real world (staged P3)', () => {
  it('with no ip unreachables on Gi0/0, PC1\'s denied pings are all dropped and R1 sends no 3/13; without it, it does', () => {
    const lines = [`interface ${GI0}`, ' ip access-group BLOCK in', '!', 'ip access-list extended BLOCK', ` deny icmp host ${PC1} any`, ' permit ip any any'];
    const quiet = world(lines, 41, [' no ip unreachables']);
    const q = pingFrom(quiet, 'pc1', SRV);
    expect(q.text).toContain(`Sent ${PING_COUNT}, received 0`);
    expect(ofKind(q.evs, 'drop').filter((d) => d.device === 'r1' && d.reason === 'acl-deny')).toHaveLength(PING_COUNT);
    expect(ofKind(q.evs, 'pduCreated').filter((e) => e.device === 'r1' && e.pdu.tag === 'unreachable')).toEqual([]);
    expect(quiet.device('r1')!.processes.get('acl')!.stateSnapshot().state).toMatchObject({ unreachablesSent: 0, unreachablesLimited: 0 });
    const loud = world(lines, 41);
    const l = pingFrom(loud, 'pc1', SRV);
    expect(ofKind(l.evs, 'pduCreated').filter((e) => e.device === 'r1' && e.pdu.tag === 'unreachable').length).toBeGreaterThan(0);
  });
});
