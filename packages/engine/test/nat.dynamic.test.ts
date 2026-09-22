/**
 * W3 nat (ARCHITECTURE-P2 §3.9 "Dynamic pool", §4.2 `nat-sweep`, §5.2): the pool rule on the fake router — ACL
 * permit → lowest free pool address, the address-only dynamic row with its 86 400 s expiry and virtual address, the
 * inbound reverse translation, `nat-exhausted` when the pool is full, an ACL deny or a missing list left
 * untranslated, the periodic sweep (armed only while a row can expire), `clear ip nat translation *` (dynamic rows
 * only), the [S9] `ip nat translation timeout` line — and the real world (first host gets .20; a full pool drops).
 */
import { describe, expect, it } from 'vitest';
import type { Action, ProcessRequest } from '../src/contracts/process.js';
import { natKey } from '../src/contracts/tables.js';
import { SEC } from '../src/contracts/time.js';
import { NAT_SWEEP_NS, NAT_SWEEP_TIMER } from '../src/protocols/nat.js';
import {
  ACL_LINE, GI0, GI1, MAC_R1, PC1, PC2, POOL_LINE, POOL_RULE, SRV,
  createdBy, echo, echoReply, exec, natFake, natRows, natWorld, sendVias, udp,
} from './nat.harness.js';
import { ofKind } from './sim.harness.js';

const POOL_FIRST = '203.0.113.20';
const POOL_LAST = '203.0.113.29';
const HOST = (n: number): string => `192.168.1.${n}`;

function poolRouter(lines: readonly string[] = [ACL_LINE, POOL_LINE, POOL_RULE]) {
  const h = natFake();
  h.iface(GI0, 'ip nat inside');
  h.iface(GI1, 'ip nat outside');
  for (const l of lines) h.global(l);
  return h;
}

const virtualRequests = (h: ReturnType<typeof natFake>): ProcessRequest[] =>
  h.all.filter((a): a is Extract<Action, { type: 'request' }> => a.type === 'request' && a.req.kind === 'ipv4.virtual').map((a) => a.req);

describe('dynamic pool on the fake router (§3.9 Dynamic pool)', () => {
  it('the lines alone write no row and arm no timer', () => {
    const h = poolRouter();
    expect(h.rows()).toEqual([]);
    expect(h.actions.filter((a) => a.type === 'timer')).toEqual([]);
    expect(virtualRequests(h)).toEqual([]);
    expect(h.nat.stateSnapshot().state).toMatchObject({ rules: [POOL_RULE], pools: [{ name: 'P', start: POOL_FIRST, end: POOL_LAST, prefixLen: 24 }] });
  });

  it("PC1's first packet: ACL permits, .20 is taken, the row expires in 86 400 s, .20 is answered on the outside port, the sweep is armed", () => {
    const h = poolRouter();
    const t0 = h.ctx.now;
    const { pdu } = h.outbound(echo(PC1, SRV, 1, 1));
    expect(pdu.get('ipv4.src')).toBe(POOL_FIRST);
    expect(h.reasons(pdu)).toEqual([
      'TtlDecrement:ipv4.ttl', 'ChecksumRecompute:ipv4.checksum', 'FcsRecompute:ethernet.fcs',
      'NatTranslate:ipv4.src', 'ChecksumRecompute:ipv4.checksum', 'FcsRecompute:ethernet.fcs',
    ]);
    expect(pdu.provenance.find((m) => m.reason === 'NatTranslate')).toMatchObject({ before: PC1, after: POOL_FIRST, cause: POOL_RULE });
    expect(h.rows()).toEqual([
      { key: natKey('any', POOL_FIRST), proto: 'any', insideLocal: PC1, insideGlobal: POOL_FIRST, kind: 'dynamic', rule: POOL_RULE, updatedAt: t0, expiresAt: t0 + 86_400 * SEC },
    ]);
    expect(virtualRequests(h)).toEqual([{ kind: 'ipv4.virtual', op: 'add', iface: GI1, address: POOL_FIRST, mac: MAC_R1, local: false, owner: 'nat' }]);
    expect(h.actions.filter((a) => a.type === 'timer')).toEqual([{ type: 'timer', key: NAT_SWEEP_TIMER, delay: NAT_SWEEP_NS, periodic: true }]);
    expect(sendVias(h)).toEqual([[SRV, GI1]]);
    // a second packet of the same host reuses the row and refreshes it; no new row, no new timer
    h.setNow(t0 + 5 * SEC);
    const { pdu: second } = h.outbound(udp(PC1, 5000, SRV, 53));
    expect(second.get('ipv4.src')).toBe(POOL_FIRST);
    expect(h.rows()).toHaveLength(1);
    expect(h.rows()[0]!.expiresAt).toBe(t0 + 5 * SEC + 86_400 * SEC);
    expect(h.actions.filter((a) => a.type === 'timer')).toHaveLength(1);
    // PC2 takes the next address
    h.outbound(echo(PC2, SRV, 1, 1));
    expect(h.rows().map((r) => [r.insideLocal, r.insideGlobal])).toEqual([[PC1, POOL_FIRST], [PC2, '203.0.113.21']]);
  });

  it('inbound: a packet to the pool address is translated to the inside host; to a free pool address it is left alone', () => {
    const h = poolRouter();
    h.outbound(echo(PC1, SRV, 1, 1));
    const { pdu } = h.inbound(echoReply(SRV, POOL_FIRST, 1, 1));
    expect(pdu.get('ipv4.dst')).toBe(PC1);
    expect(pdu.provenance.find((m) => m.reason === 'NatTranslate')).toMatchObject({ field: 'ipv4.dst', before: POOL_FIRST, after: PC1, cause: POOL_RULE });
    expect(sendVias(h).at(-1)).toEqual([PC1, GI0]);
    const { pdu: free } = h.inbound(echoReply(SRV, '203.0.113.25', 1, 1));
    expect(free.provenance.some((m) => m.reason === 'NatTranslate')).toBe(false);
  });

  it('an eleventh host with ten addresses in use drops nat-exhausted with the pool named; a denied or unlisted source leaves untranslated', () => {
    const h = poolRouter();
    for (let n = 10; n < 20; n++) h.outbound(echo(HOST(n), SRV, 1, 1));
    expect(h.rows().map((r) => r.insideGlobal)).toEqual(Array.from({ length: 10 }, (_, i) => `203.0.113.${20 + i}`));
    expect(h.drops()).toEqual([]);
    const { pdu } = h.outbound(echo(HOST(20), SRV, 1, 1));
    expect(h.drops()).toEqual([{ type: 'drop', pdu, reason: 'nat-exhausted', detail: 'pool P has no free address', port: GI0 }]);
    expect(pdu.get('ipv4.src')).toBe(HOST(20));
    expect(sendVias(h)).toHaveLength(10);
    expect(h.nat.stateSnapshot().state).toMatchObject({ counters: { exhausted: 1, created: 10 } });
    // an address the list denies
    const { pdu: denied } = h.outbound(echo('10.9.9.9', SRV, 1, 1));
    expect(denied.get('ipv4.src')).toBe('10.9.9.9');
    expect(sendVias(h)).toHaveLength(11);
    expect(h.natDebug().at(-1)).toBe(`out 10.9.9.9 -> ${SRV} (icmp) left untranslated: no matching translation`);
    // a rule naming a list that does not exist permits nothing
    const g = poolRouter([POOL_LINE, 'ip nat inside source list 7 pool P']);
    const { pdu: nolist } = g.outbound(echo(PC1, SRV, 1, 1));
    expect(nolist.get('ipv4.src')).toBe(PC1);
    expect(g.rows()).toEqual([]);
  });

  it('the sweep expires idle rows, withdraws their virtual address and stops when none is left; a timeout line shortens the idle time', () => {
    const h = poolRouter([ACL_LINE, POOL_LINE, POOL_RULE, 'ip nat translation timeout 300']);
    const t0 = h.ctx.now;
    h.outbound(echo(PC1, SRV, 1, 1));
    expect(h.rows()[0]!.expiresAt).toBe(t0 + 300 * SEC);
    h.setNow(t0 + NAT_SWEEP_NS);
    expect(h.timer(NAT_SWEEP_TIMER)).toEqual([{ type: 'timer', key: NAT_SWEEP_TIMER, delay: NAT_SWEEP_NS, periodic: true }]);
    expect(h.rows()).toHaveLength(1);
    h.setNow(t0 + 300 * SEC);
    const fired = h.timer(NAT_SWEEP_TIMER);
    expect(fired).toEqual([
      { type: 'request', to: 'ipv4', req: { kind: 'ipv4.virtual', op: 'remove', iface: GI1, address: POOL_FIRST, mac: MAC_R1, local: false, owner: 'nat' } },
      { type: 'cancelTimer', key: NAT_SWEEP_TIMER },
    ]);
    expect(h.rows()).toEqual([]);
    const expired = h.kinds('tableExpire').filter((e) => e.table === 'nat');
    expect(expired).toEqual([expect.objectContaining({ key: natKey('any', POOL_FIRST), reason: 'aged' })]);
    expect(h.nat.stateSnapshot().state).toMatchObject({ counters: { expired: 1 } });
    const fsm = h.fake.debug.filter((d) => d.data?.fsm !== undefined).map((d) => d.data!.fsm);
    expect(fsm).toEqual([
      { machine: 'nat', subject: `any ${PC1} ${POOL_FIRST}`, from: 'free', to: 'active', cause: POOL_RULE },
      { machine: 'nat', subject: `any ${PC1} ${POOL_FIRST}`, from: 'active', to: 'expired', cause: 'idle timeout expired' },
    ]);
    // the next packet allocates .20 again and arms the sweep anew (first arm, the periodic re-arm, this arm)
    h.outbound(echo(PC1, SRV, 1, 2));
    expect(h.rows().map((r) => r.insideGlobal)).toEqual([POOL_FIRST]);
    expect(h.actions.filter((a) => a.type === 'timer')).toHaveLength(3);
  });

  it('nat.clear removes dynamic rows only and keeps static ones; removing the rule clears its rows', () => {
    const h = poolRouter([ACL_LINE, POOL_LINE, POOL_RULE, `ip nat inside source static ${HOST(50)} 203.0.113.50`]);
    h.outbound(echo(PC1, SRV, 1, 1));
    h.outbound(echo(PC2, SRV, 1, 1));
    expect(h.rows().map((r) => r.kind)).toEqual(['static', 'dynamic', 'dynamic']);
    const cleared = h.request({ kind: 'nat.clear' });
    expect(h.rows().map((r) => r.kind)).toEqual(['static']);
    expect(cleared.filter((a) => a.type === 'request').map((a) => (a as Extract<Action, { type: 'request' }>).req)).toEqual([
      { kind: 'ipv4.virtual', op: 'remove', iface: GI1, address: POOL_FIRST, mac: MAC_R1, local: false, owner: 'nat' },
      { kind: 'ipv4.virtual', op: 'remove', iface: GI1, address: '203.0.113.21', mac: MAC_R1, local: false, owner: 'nat' },
    ]);
    expect(cleared.filter((a) => a.type === 'cancelTimer')).toEqual([{ type: 'cancelTimer', key: NAT_SWEEP_TIMER }]);
    expect(h.kinds('tableExpire').filter((e) => e.table === 'nat').map((e) => e.reason)).toEqual(['cleared', 'cleared']);
    expect(h.nat.stateSnapshot().state).toMatchObject({ counters: { cleared: 2 } });
    // a new row, then the rule is removed: its rows go with it
    h.outbound(echo(PC1, SRV, 1, 2));
    expect(h.rows()).toHaveLength(2);
    h.global(POOL_RULE, true);
    expect(h.rows().map((r) => r.kind)).toEqual(['static']);
    // and the host is now untranslated
    const { pdu } = h.outbound(echo(PC1, SRV, 1, 3));
    expect(pdu.get('ipv4.src')).toBe(PC1);
  });

  it('a static translation wins over the pool for its host, and a pool address that is one of the router addresses is skipped', () => {
    const h = poolRouter([ACL_LINE, POOL_LINE, POOL_RULE, `ip nat inside source static ${PC1} 203.0.113.5`]);
    const { pdu } = h.outbound(echo(PC1, SRV, 1, 1));
    expect(pdu.get('ipv4.src')).toBe('203.0.113.5');
    expect(h.rows().map((r) => r.kind)).toEqual(['static']);
    const g = poolRouter([ACL_LINE, 'ip nat pool P 203.0.113.1 203.0.113.2 netmask 255.255.255.0', POOL_RULE]);
    const { pdu: p } = g.outbound(echo(PC1, SRV, 1, 1));
    expect(p.get('ipv4.src')).toBe('203.0.113.2');
  });
});

describe('dynamic pool in a real world (PC1, PC2 — SW — R1 — SRV)', () => {
  it('the first host gets .20 and pings 5/5; the second gets .21; with the pool full the next drops nat-exhausted', () => {
    const sim = natWorld({ r1: [ACL_LINE, 'ip nat pool P 203.0.113.20 203.0.113.21 netmask 255.255.255.0', POOL_RULE], inside: [
      { id: 'pc1', name: 'PC1', address: PC1 },
      { id: 'pc2', name: 'PC2', address: PC2 },
      { id: 'pc3', name: 'PC3', address: '192.168.1.12' },
    ] });
    const first = exec(sim, 'pc1', `ping ${SRV}`);
    expect(first.text).toContain('Sent 5, received 5, lost 0');
    const req = createdBy(first.evs, 'pc1', 'ping#')[0]!;
    expect(sim.pdu(req)!.provenance.find((m) => m.reason === 'NatTranslate')).toMatchObject({ device: 'r1', field: 'ipv4.src', before: PC1, after: '203.0.113.20', cause: POOL_RULE });
    expect(natRows(sim)).toEqual([expect.objectContaining({ key: natKey('any', '203.0.113.20'), insideLocal: PC1, kind: 'dynamic' })]);
    expect(natRows(sim)[0]!.expiresAt).toBeDefined();
    const second = exec(sim, 'pc2', `ping ${SRV}`);
    expect(second.text).toContain('Sent 5, received 5, lost 0');
    expect(natRows(sim).map((r) => [r.insideLocal, r.insideGlobal])).toEqual([[PC1, '203.0.113.20'], [PC2, '203.0.113.21']]);
    const third = exec(sim, 'pc3', `ping ${SRV}`);
    expect(third.text).toContain('received 0');
    const drops = ofKind(third.evs, 'drop').filter((d) => d.device === 'r1' && d.reason === 'nat-exhausted');
    expect(drops).toHaveLength(5);
    expect(drops[0]!.detail).toBe('pool P has no free address');
    // SRV learned both pool addresses through R1's ARP answers and never an inside one
    const learned = sim.device('srv')!.tables.arp.rows().map((r) => r.ip);
    expect(learned).toEqual(expect.arrayContaining(['203.0.113.20', '203.0.113.21']));
    expect(learned.filter((ip) => ip.startsWith('192.168.'))).toEqual([]);
    // the sweep is periodic: runToIdle returned above with the rows alive, and they are still there
    expect(natRows(sim)).toHaveLength(2);
  });
});
