/**
 * W3 nat (ARCHITECTURE-P2 D14, §3.9 "Static", §4.3 silence, §5.2): the nat daemon's config reader, its silence, the
 * static translation on the fake router (row, virtual address, the outbound `ipv4.src` and inbound `ipv4.dst`
 * rewrites with the rule as cause and their derived checksums), and the real world (PC1 — R1 — SRV: SRV sees
 * 203.0.113.5, answers it, and the reply reaches PC1; the P1 path is untouched when no line matches).
 */
import { describe, expect, it } from 'vitest';
import { createConfigAst } from '../src/cli/config-ast.js';
import type { ProcessRequest } from '../src/contracts/process.js';
import { natKey } from '../src/contracts/tables.js';
import { SEC } from '../src/contracts/time.js';
import { NAT_DEBUG_CATEGORY, NAT_PROCESS, NAT_SWEEP_TIMER, createNat, isNatDelta, readNatConfig } from '../src/protocols/nat.js';
import {
  GI0, GI1, MAC_R1, PC1, PC2, R1_OUT, SRV, STATIC_GLOBAL, STATIC_LINE,
  createdBy, echo, echoReply, exec, mutationsAt, natFake, natRows, natWorld, sendVias, udp,
} from './nat.harness.js';
import { ofKind } from './sim.harness.js';

describe('readNatConfig / isNatDelta', () => {
  it('reads interface roles, pools, static and dynamic rules and the timeout lines; skips what does not parse', () => {
    const c = createConfigAst();
    c.set([['interface', GI0]], ['ip', 'nat', 'inside']);
    c.set([['interface', GI1]], ['ip', 'nat', 'outside']);
    c.set([], ['ip', 'nat', 'pool', 'P', '203.0.113.20', '203.0.113.29', 'netmask', '255.255.255.0']);
    c.set([], ['ip', 'nat', 'pool', 'Q', '198.51.100.5', '198.51.100.9', 'prefix-length', '24']);
    c.set([], ['ip', 'nat', 'pool', 'BAD', '203.0.113.29', '203.0.113.20', 'netmask', '255.255.255.0']);
    c.set([], ['ip', 'nat', 'inside', 'source', 'static', PC1, STATIC_GLOBAL]);
    c.set([], ['ip', 'nat', 'inside', 'source', 'static', 'tcp', PC2, '80', STATIC_GLOBAL, '8080']);
    c.set([], ['ip', 'nat', 'inside', 'source', 'static', 'udp', PC2, '53', 'interface', GI1, '5353']);
    c.set([], ['ip', 'nat', 'inside', 'source', 'static', 'nonsense']);
    c.set([], ['ip', 'nat', 'inside', 'source', 'list', '1', 'pool', 'P']);
    c.set([], ['ip', 'nat', 'inside', 'source', 'list', '2', 'pool', 'Q', 'overload']);
    c.set([], ['ip', 'nat', 'inside', 'source', 'list', 'LAN', 'interface', GI1, 'overload']);
    c.set([], ['ip', 'nat', 'inside', 'source', 'list', '3', 'interface', GI1]); // interface form needs overload
    c.set([], ['ip', 'nat', 'translation', 'udp-timeout', '120']);
    c.set([], ['ip', 'nat', 'translation', 'timeout', '3600']);
    c.set([], ['ip', 'nat', 'translation', 'icmp-timeout', 'x']);
    const cfg = readNatConfig(c);
    expect(cfg.inside).toEqual([GI0]);
    expect(cfg.outside).toEqual([GI1]);
    expect(cfg.pools).toEqual([
      { name: 'P', start: '203.0.113.20', end: '203.0.113.29', prefixLen: 24, line: 'ip nat pool P 203.0.113.20 203.0.113.29 netmask 255.255.255.0' },
      { name: 'Q', start: '198.51.100.5', end: '198.51.100.9', prefixLen: 24, line: 'ip nat pool Q 198.51.100.5 198.51.100.9 prefix-length 24' },
    ]);
    expect(cfg.statics).toEqual([
      { proto: 'any', insideLocal: PC1, insideGlobal: STATIC_GLOBAL, line: STATIC_LINE },
      { proto: 'tcp', insideLocal: PC2, insideLocalPort: 80, insideGlobal: STATIC_GLOBAL, insideGlobalPort: 8080, line: `ip nat inside source static tcp ${PC2} 80 ${STATIC_GLOBAL} 8080` },
      { proto: 'udp', insideLocal: PC2, insideLocalPort: 53, iface: GI1, insideGlobalPort: 5353, line: `ip nat inside source static udp ${PC2} 53 interface ${GI1} 5353` },
    ]);
    expect(cfg.dynamics).toEqual([
      { acl: '1', pool: 'P', overload: false, line: 'ip nat inside source list 1 pool P' },
      { acl: '2', pool: 'Q', overload: true, line: 'ip nat inside source list 2 pool Q overload' },
      { acl: 'LAN', iface: GI1, overload: true, line: `ip nat inside source list LAN interface ${GI1} overload` },
    ]);
    expect(cfg.timeouts).toEqual({ dynamicS: 3600, udpS: 120, tcpS: 86_400, icmpS: 60 });
    expect(readNatConfig(createConfigAst())).toEqual({ inside: [], outside: [], pools: [], statics: [], dynamics: [], timeouts: { dynamicS: 86_400, udpS: 300, tcpS: 86_400, icmpS: 60 } });
  });

  it('a delta concerns nat for ip nat lines, access lists and interface addresses only', () => {
    expect(isNatDelta({ context: [], line: ['ip', 'nat', 'pool', 'P'] })).toBe(true);
    expect(isNatDelta({ context: [], line: ['access-list', '1', 'permit', 'any'] })).toBe(true);
    expect(isNatDelta({ context: [], line: ['ip', 'access-list', 'standard', 'LAN'] })).toBe(true);
    expect(isNatDelta({ context: [['ip', 'access-list', 'standard', 'LAN']], line: ['permit', 'any'] })).toBe(true);
    expect(isNatDelta({ context: [['interface', GI0]], line: ['ip', 'nat', 'inside'] })).toBe(true);
    expect(isNatDelta({ context: [['interface', GI0]], line: ['ip', 'address', '10.0.0.1', '255.255.255.0'] })).toBe(true);
    expect(isNatDelta({ context: [], line: ['ip', 'route', '0.0.0.0', '0.0.0.0', '10.0.0.2'] })).toBe(false);
    expect(isNatDelta({ context: [], line: ['hostname', 'R1'] })).toBe(false);
    expect(isNatDelta({ context: [['interface', GI0]], line: ['no', 'shutdown'] })).toBe(false);
    expect(isNatDelta({ context: [['ip', 'dhcp', 'pool', 'X']], line: ['network', '10.0.0.0', '255.255.255.0'] })).toBe(false);
  });
});

describe('the nat daemon: shape and silence', () => {
  it('has no selectors, drops a stray frame, and is silent with no ip nat line: no row, no timer, no debug', () => {
    const h = natFake();
    expect(h.nat.name).toBe(NAT_PROCESS);
    expect(h.nat.handles).toBeUndefined();
    expect(h.boot()).toEqual([]);
    expect(h.nat.onTimer(h.ctx, NAT_SWEEP_TIMER)).toEqual([]);
    expect(h.nat.onConfig(h.ctx, { op: 'set', context: [], line: ['hostname', 'R1'] })).toEqual([]);
    expect(h.rows()).toEqual([]);
    expect(h.natDebug()).toEqual([]);
    expect(h.kinds('tableWrite').filter((e) => e.table === 'nat')).toEqual([]);
    expect(h.nat.debugEvents()).toEqual([]);
    expect(h.nat.stateSnapshot()).toEqual({
      process: 'nat',
      state: { inside: [], outside: [], rules: [], pools: [], timeouts: { dynamicS: 86_400, udpS: 300, tcpS: 86_400, icmpS: 60 }, counters: { outbound: 0, inbound: 0, created: 0, expired: 0, cleared: 0, exhausted: 0, untranslated: 0 } },
    });
    const { pdu } = h.outbound(echo(PC1, SRV, 1, 1));
    // no ip nat line: ipv4 never handed the packet to nat, it went to arp as in P1
    expect(sendVias(h)).toEqual([[SRV, GI1]]);
    expect(h.reasons(pdu)).toEqual(['TtlDecrement:ipv4.ttl', 'ChecksumRecompute:ipv4.checksum', 'FcsRecompute:ethernet.fcs']);
    const stray = h.fake.build(echo(PC1, SRV, 1, 2));
    expect(h.nat.onPdu(h.ctx, stray, GI0)).toEqual([{ type: 'drop', pdu: stray, reason: 'unsupported-protocol', detail: 'nat handles no frames', port: GI0 }]);
  });
});

describe('static translation on the fake router (§3.9 Static)', () => {
  function staticRouter() {
    const h = natFake();
    h.iface(GI0, 'ip nat inside');
    h.iface(GI1, 'ip nat outside');
    h.global(STATIC_LINE);
    return h;
  }

  it('the line writes one static row keyed any|ig|* and asks ipv4 to answer ARP for the inside global on every outside port', () => {
    const h = staticRouter();
    const rows = h.rows();
    expect(rows).toEqual([{ key: natKey('any', STATIC_GLOBAL), proto: 'any', insideLocal: PC1, insideGlobal: STATIC_GLOBAL, kind: 'static', rule: STATIC_LINE, updatedAt: h.ctx.now }]);
    expect(rows[0]!.expiresAt).toBeUndefined();
    const virtuals = h.all.filter((a) => a.type === 'request' && a.req.kind === 'ipv4.virtual').map((a) => (a as { req: ProcessRequest }).req);
    expect(virtuals).toEqual([{ kind: 'ipv4.virtual', op: 'add', iface: GI1, address: STATIC_GLOBAL, mac: MAC_R1, local: false, owner: 'nat' }]);
    expect(h.ipv4.stateSnapshot().state).toMatchObject({ virtual: { [GI1]: [{ address: STATIC_GLOBAL, mac: MAC_R1, owner: 'nat', local: false }] } });
    // the row's life is one transition, in the ip nat debug category
    const fsm = h.fake.debug.filter((d) => d.category === NAT_DEBUG_CATEGORY && d.data?.fsm !== undefined);
    expect(fsm).toHaveLength(1);
    expect(fsm[0]!.data!.fsm).toEqual({ machine: 'nat', subject: `any ${PC1} ${STATIC_GLOBAL}`, from: 'free', to: 'active', cause: STATIC_LINE });
    // no timer: a static row never expires
    expect(h.actions.filter((a) => a.type === 'timer')).toEqual([]);
    // idempotent: re-applying the same config (a reload) rewrites nothing
    const writes = h.kinds('tableWrite').filter((e) => e.table === 'nat').length;
    expect(h.nat.init!(h.ctx)).toEqual([]);
    expect(h.kinds('tableWrite').filter((e) => e.table === 'nat')).toHaveLength(writes);
  });

  it('outbound: ipv4.src → inside global with the rule as cause, then the IPv4 checksum and the FCS, then arp.sendVia', () => {
    const h = staticRouter();
    const { pdu } = h.outbound(echo(PC1, SRV, 1, 1));
    expect(pdu.get('ipv4.src')).toBe(STATIC_GLOBAL);
    expect(pdu.get('ipv4.ttl')).toBe(127);
    expect(h.reasons(pdu)).toEqual([
      'TtlDecrement:ipv4.ttl', 'ChecksumRecompute:ipv4.checksum', 'FcsRecompute:ethernet.fcs',
      'NatTranslate:ipv4.src', 'ChecksumRecompute:ipv4.checksum', 'FcsRecompute:ethernet.fcs',
    ]);
    const m = pdu.provenance.find((x) => x.reason === 'NatTranslate')!;
    expect(m).toMatchObject({ field: 'ipv4.src', before: PC1, after: STATIC_GLOBAL, cause: STATIC_LINE });
    expect(pdu.get('ipv4.checksumValid')).toBe(true);
    expect(pdu.get('icmpv4.checksumValid')).toBe(true);
    expect(sendVias(h)).toEqual([[SRV, GI1]]);
    expect(h.arp.requests[0]).toMatchObject({ kind: 'arp.sendVia', pdu, nextHop: SRV, iface: GI1, cause: `connected via ${GI1}` });
    expect(h.nat.stateSnapshot().state).toMatchObject({ counters: { outbound: 1, inbound: 0 } });
    // a udp datagram also records the transport checksum (pseudo-header) before the IPv4 one
    const { pdu: d } = h.outbound(udp(PC1, 40000, SRV, 53));
    expect(h.reasons(d)).toEqual([
      'TtlDecrement:ipv4.ttl', 'ChecksumRecompute:ipv4.checksum', 'FcsRecompute:ethernet.fcs',
      'NatTranslate:ipv4.src', 'ChecksumRecompute:udp.checksum', 'ChecksumRecompute:ipv4.checksum', 'FcsRecompute:ethernet.fcs',
    ]);
    expect(d.get('udp.checksumValid')).toBe(true);
  });

  it('inbound: a reply to the inside global is handed over before the for-me test, ipv4.dst → inside local, then resumed and forwarded inside', () => {
    const h = staticRouter();
    const { pdu } = h.inbound(echoReply(SRV, STATIC_GLOBAL, 1, 1));
    expect(pdu.get('ipv4.dst')).toBe(PC1);
    expect(h.reasons(pdu)).toEqual([
      'NatTranslate:ipv4.dst', 'ChecksumRecompute:ipv4.checksum', 'FcsRecompute:ethernet.fcs',
      'TtlDecrement:ipv4.ttl', 'ChecksumRecompute:ipv4.checksum', 'FcsRecompute:ethernet.fcs',
    ]);
    expect(pdu.provenance.find((x) => x.reason === 'NatTranslate')).toMatchObject({ field: 'ipv4.dst', before: STATIC_GLOBAL, after: PC1, cause: STATIC_LINE });
    expect(sendVias(h)).toEqual([[PC1, GI0]]);
    expect(h.icmp.pdus).toEqual([]);
    // an inbound echo REQUEST to the static address is translated too (address-only rows match any packet)
    const { pdu: req } = h.inbound(echo(SRV, STATIC_GLOBAL, 5, 1, 64));
    expect(req.get('ipv4.dst')).toBe(PC1);
    expect(sendVias(h)).toEqual([[PC1, GI0], [PC1, GI0]]);
    // a packet for the router's own outside address matches nothing and is delivered locally, untranslated
    const { pdu: own } = h.inbound(echo(SRV, R1_OUT, 7, 1, 64));
    expect(own.provenance.some((m) => m.reason === 'NatTranslate')).toBe(false);
    expect(h.icmp.pdus).toEqual([own]);
    expect(h.natDebug().at(-1)).toBe(`in ${SRV} -> ${R1_OUT} (icmp) left untranslated: no matching translation`);
    expect(h.nat.stateSnapshot().state).toMatchObject({ counters: { inbound: 2, untranslated: 1 } });
  });

  it('a source with no rule leaves untranslated; removing the line deletes the row and withdraws the virtual address', () => {
    const h = staticRouter();
    const { pdu } = h.outbound(echo(PC2, SRV, 1, 1));
    expect(pdu.get('ipv4.src')).toBe(PC2);
    expect(pdu.provenance.some((m) => m.reason === 'NatTranslate')).toBe(false);
    expect(sendVias(h)).toEqual([[SRV, GI1]]);
    h.global(STATIC_LINE, true);
    expect(h.rows()).toEqual([]);
    const expired = h.kinds('tableExpire').filter((e) => e.table === 'nat');
    expect(expired).toHaveLength(1);
    expect(expired[0]).toMatchObject({ key: natKey('any', STATIC_GLOBAL), reason: 'cleared' });
    const last = h.all.filter((a) => a.type === 'request' && a.req.kind === 'ipv4.virtual').at(-1) as { req: ProcessRequest };
    expect(last.req).toEqual({ kind: 'ipv4.virtual', op: 'remove', iface: GI1, address: STATIC_GLOBAL, mac: MAC_R1, local: false, owner: 'nat' });
    expect(h.ipv4.stateSnapshot().state).not.toHaveProperty('virtual');
  });

  it('boot replay: the static row and the virtual address come from the saved config at init', () => {
    const h = natFake();
    h.ctx.config.set([['interface', GI0]], ['ip', 'nat', 'inside']);
    h.ctx.config.set([['interface', GI1]], ['ip', 'nat', 'outside']);
    h.ctx.config.set([], STATIC_LINE.split(' '));
    h.boot();
    expect(h.rows().map((r) => r.key)).toEqual([natKey('any', STATIC_GLOBAL)]);
    expect(h.ipv4.stateSnapshot().state).toMatchObject({ nat: { [GI0]: 'inside', [GI1]: 'outside' }, virtual: { [GI1]: [{ address: STATIC_GLOBAL }] } });
    // a static whose inside global is the router's own address gets no virtual entry
    h.global(`ip nat inside source static ${PC2} ${R1_OUT}`);
    expect(h.rows().map((r) => r.key)).toEqual([natKey('any', STATIC_GLOBAL), natKey('any', R1_OUT)]);
    expect(h.ipv4.stateSnapshot().state).toMatchObject({ virtual: { [GI1]: [{ address: STATIC_GLOBAL }] } });
  });

  it('createNat builds independent daemons (no module state)', () => {
    const a = createNat();
    const b = createNat();
    expect(a).not.toBe(b);
    expect(a.stateSnapshot()).toEqual(b.stateSnapshot());
  });
});

describe('static translation in a real world (PC1 — R1 — SRV)', () => {
  it('SRV sees source 203.0.113.5, answers it, and the reply comes back to PC1 translated; every checksum valid', () => {
    const sim = natWorld({ r1: [STATIC_LINE] });
    expect(sim.device('r1')!.processes.has('nat')).toBe(true);
    expect(natRows(sim)).toEqual([expect.objectContaining({ key: natKey('any', STATIC_GLOBAL), kind: 'static', rule: STATIC_LINE })]);
    const { text, evs } = exec(sim, 'pc1', `ping ${SRV}`);
    expect(text).toContain('Sent 5, received 5, lost 0');
    const requests = createdBy(evs, 'pc1', 'ping#');
    expect(requests).toHaveLength(5);
    expect(mutationsAt(sim, requests[0]!, 'r1').map((m) => m[0])).toEqual([
      'TtlDecrement', 'ChecksumRecompute', 'FcsRecompute', 'NatTranslate', 'ChecksumRecompute', 'FcsRecompute', 'MacRewrite', 'FcsRecompute', 'MacRewrite', 'FcsRecompute',
    ]);
    const nat = sim.pdu(requests[0]!)!.provenance.find((m) => m.reason === 'NatTranslate')!;
    expect(nat).toMatchObject({ device: 'r1', field: 'ipv4.src', before: PC1, after: STATIC_GLOBAL, cause: STATIC_LINE });
    const replies = createdBy(evs, 'srv', 'echo-reply');
    expect(replies).toHaveLength(5);
    const reply = sim.pdu(replies[0]!)!;
    expect(reply.provenance.filter((m) => m.reason === 'NatTranslate').map((m) => [m.field, m.before, m.after])).toEqual([['ipv4.dst', STATIC_GLOBAL, PC1]]);
    expect(reply.get('ipv4.dst')).toBe(PC1);
    expect(reply.get('ipv4.checksumValid')).toBe(true);
    expect(reply.get('icmpv4.checksumValid')).toBe(true);
    // the server learned 203.0.113.5 from R1's ARP answer for the virtual address; no inside address reached it
    const learned = sim.device('srv')!.tables.arp.rows().map((r) => r.ip);
    expect(learned).toContain(STATIC_GLOBAL);
    expect(learned.filter((ip) => ip.startsWith('192.168.'))).toEqual([]);
    expect(ofKind(evs, 'drop').filter((d) => d.device === 'r1')).toEqual([]);
    // no row was added: a static translation is one row for every flow
    expect(natRows(sim)).toHaveLength(1);
  });

  it('PC2 (no rule) still reaches SRV untranslated, exactly the P1 path', () => {
    const sim = natWorld({ r1: [STATIC_LINE] });
    const { text, evs } = exec(sim, 'pc2', `ping ${SRV}`);
    expect(text).toContain('Sent 5, received 5, lost 0');
    const first = createdBy(evs, 'pc2', 'ping#')[0]!;
    expect(sim.pdu(first)!.provenance.some((m) => m.reason === 'NatTranslate')).toBe(false);
    expect(sim.device('srv')!.tables.arp.rows().map((r) => r.ip)).not.toContain(STATIC_GLOBAL);
    // the untranslated packet was still routed: SRV answered PC2 through its gateway R1
    expect(ofKind(evs, 'pduCreated').filter((e) => e.device === 'srv' && e.pdu.tag === 'echo-reply')).toHaveLength(5);
  });

  it('runs byte-identically twice with the same seed and settles: runToIdle returns', () => {
    const a = natWorld({ r1: [STATIC_LINE], seed: 9 });
    const b = natWorld({ r1: [STATIC_LINE], seed: 9 });
    exec(a, 'pc1', `ping ${SRV}`);
    exec(b, 'pc1', `ping ${SRV}`);
    a.runFor(120 * SEC);
    b.runFor(120 * SEC);
    expect(JSON.stringify(a.trace(0).events)).toBe(JSON.stringify(b.trace(0).events));
    expect(JSON.stringify(a.snapshot())).toBe(JSON.stringify(b.snapshot()));
  });
});
