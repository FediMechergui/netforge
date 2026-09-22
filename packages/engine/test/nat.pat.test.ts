/**
 * W3 nat (ARCHITECTURE-P2 §3.9 "PAT on the interface", steps 1–4 and the inbound match rule; §4.1 no randomness):
 * `allocateNatPort` (the class walk), overload on the interface and on a pool, the per-flow overload rows with their
 * ICMP/UDP/TCP timeouts and `tcp-finrst`, ports held by local sockets, the inbound match rule (an outside echo
 * REQUEST never matches a query row; an overload row needs the outside address and port), exhaustion, the [S9]
 * timeout lines — and the real world: PC1 and PC2 ping SRV at the same time with ICMP id 1, SRV sees ids 1 and 2, both
 * pings 5/5, every checksum valid, SRV's own ping to R1 is answered by R1 while PC1's row is alive, idle rows expire
 * after 60 s. The PAT mutation sequence of §3.9 step 2 is DERIVED here from real calls (the acceptance test pins it).
 */
import { describe, expect, it } from 'vitest';
import type { Action } from '../src/contracts/process.js';
import { natKey } from '../src/contracts/tables.js';
import type { NatRow } from '../src/contracts/tables.js';
import { SEC } from '../src/contracts/time.js';
import { NAT_ICMP_ID_CLASS, NAT_PORT_CLASSES, NAT_SWEEP_NS, NAT_SWEEP_TIMER, allocateNatPort, natPortClass } from '../src/protocols/nat.js';
import {
  ACL_LINE, GI0, GI1, MAC_PC2, PAT_RULE, PC1, PC2, POOL_LINE, R1_OUT, SRV,
  createdBy, echo, echoReply, exec, mutationsAt, natFake, natRows, natWorld, sendVias, start, tcp, udp,
} from './nat.harness.js';
import { ofKind, output } from './sim.harness.js';

const SRV2 = '203.0.113.11';
const POOL_OVERLOAD = 'ip nat inside source list 1 pool P overload';

function patRouter(lines: readonly string[] = [ACL_LINE, PAT_RULE]) {
  const h = natFake();
  h.iface(GI0, 'ip nat inside');
  h.iface(GI1, 'ip nat outside');
  for (const l of lines) h.global(l);
  return h;
}

const brief = (r: NatRow): unknown[] => [r.proto, r.insideLocal, r.insideLocalPort, r.insideGlobal, r.insideGlobalPort, r.outsideGlobal, r.outsideGlobalPort, r.kind];

describe('allocateNatPort (§3.9 step 4)', () => {
  it('keeps a free port, walks upward inside the class and wraps within it; icmp ids use one class', () => {
    expect(NAT_PORT_CLASSES).toEqual([[1, 511], [512, 1023], [1024, 65_535]]);
    expect(NAT_ICMP_ID_CLASS).toEqual([0, 65_535]);
    expect(natPortClass('udp', 53)).toEqual([1, 511]);
    expect(natPortClass('tcp', 1023)).toEqual([512, 1023]);
    expect(natPortClass('tcp', 40000)).toEqual([1024, 65_535]);
    expect(natPortClass('icmp', 7)).toEqual([0, 65_535]);
    expect(allocateNatPort('udp', 5000, () => false)).toBe(5000);
    expect(allocateNatPort('udp', 5000, (p) => p === 5000)).toBe(5001);
    expect(allocateNatPort('udp', 5000, (p) => p === 5000 || p === 5001)).toBe(5002);
    // wrap within the class: 1023 taken → 512, never 1024
    expect(allocateNatPort('tcp', 1023, (p) => p === 1023)).toBe(512);
    expect(allocateNatPort('tcp', 65_535, (p) => p === 65_535)).toBe(1024);
    expect(allocateNatPort('udp', 511, (p) => p === 511)).toBe(1);
    // icmp id 65535 wraps to 0
    expect(allocateNatPort('icmp', 65_535, (p) => p === 65_535)).toBe(0);
    expect(allocateNatPort('icmp', 1, (p) => p === 1)).toBe(2);
    // a full class → undefined
    expect(allocateNatPort('udp', 100, () => true)).toBeUndefined();
    expect(allocateNatPort('tcp', 600, (p) => p >= 512 && p <= 1023)).toBeUndefined();
    // deterministic: the same inputs give the same answer
    const taken = new Set([2000, 2001, 2003]);
    expect(allocateNatPort('tcp', 2000, (p) => taken.has(p))).toBe(2002);
    expect(allocateNatPort('tcp', 2000, (p) => taken.has(p))).toBe(2002);
  });
});

describe('PAT on the interface (fake router)', () => {
  it("PC1 keeps id 1 (the row of §3.9 step 1); PC2's id 1 is taken and moves to 2 with the id rewritten before the address", () => {
    const h = patRouter();
    const t0 = h.ctx.now;
    const { pdu: a } = h.outbound(echo(PC1, SRV, 1, 1));
    expect(a.get('ipv4.src')).toBe(R1_OUT);
    expect(a.get('icmpv4.id')).toBe(1);
    expect(h.reasons(a)).toEqual([
      'TtlDecrement:ipv4.ttl', 'ChecksumRecompute:ipv4.checksum', 'FcsRecompute:ethernet.fcs',
      'NatTranslate:ipv4.src', 'ChecksumRecompute:ipv4.checksum', 'FcsRecompute:ethernet.fcs',
    ]);
    expect(h.rows()).toEqual([{
      key: natKey('icmp', R1_OUT, 1), proto: 'icmp', insideLocal: PC1, insideLocalPort: 1, insideGlobal: R1_OUT, insideGlobalPort: 1,
      outsideLocal: SRV, outsideGlobal: SRV, kind: 'overload', rule: PAT_RULE, updatedAt: t0, expiresAt: t0 + 60 * SEC,
    }]);
    // the router's own address is never asked of ipv4 as a virtual address
    expect(h.all.filter((x) => x.type === 'request' && x.req.kind === 'ipv4.virtual')).toEqual([]);
    const { pdu: b } = h.outbound(echo(PC2, SRV, 1, 1), MAC_PC2);
    expect(b.get('ipv4.src')).toBe(R1_OUT);
    expect(b.get('icmpv4.id')).toBe(2);
    // §3.9 step 2, derived from real calls: id first (its checksum, the FCS), then the address (IPv4 checksum, FCS)
    expect(h.reasons(b)).toEqual([
      'TtlDecrement:ipv4.ttl', 'ChecksumRecompute:ipv4.checksum', 'FcsRecompute:ethernet.fcs',
      'NatTranslate:icmpv4.id', 'ChecksumRecompute:icmpv4.checksum', 'FcsRecompute:ethernet.fcs',
      'NatTranslate:ipv4.src', 'ChecksumRecompute:ipv4.checksum', 'FcsRecompute:ethernet.fcs',
    ]);
    expect(b.provenance.filter((m) => m.reason === 'NatTranslate').map((m) => [m.field, m.before, m.after, m.cause])).toEqual([
      ['icmpv4.id', 1, 2, PAT_RULE],
      ['ipv4.src', PC2, R1_OUT, PAT_RULE],
    ]);
    expect(b.get('icmpv4.checksumValid')).toBe(true);
    expect(b.get('ipv4.checksumValid')).toBe(true);
    expect(h.rows().map(brief)).toEqual([
      ['icmp', PC1, 1, R1_OUT, 1, SRV, undefined, 'overload'],
      ['icmp', PC2, 1, R1_OUT, 2, SRV, undefined, 'overload'],
    ]);
    expect(h.natDebug()).toContain(`icmp ${PC2}:1 takes ${R1_OUT}:2 (1 is in use)`);
    expect(sendVias(h)).toEqual([[SRV, GI1], [SRV, GI1]]);
    expect(h.actions.filter((x) => x.type === 'timer')).toEqual([{ type: 'timer', key: NAT_SWEEP_TIMER, delay: NAT_SWEEP_NS, periodic: true }]);
  });

  it("step 3: SRV's reply to (203.0.113.1, 2) matches PC2's row before the for-me test: id 2→1, dst → PC2, forwarded inside", () => {
    const h = patRouter();
    h.outbound(echo(PC1, SRV, 1, 1));
    h.outbound(echo(PC2, SRV, 1, 1), MAC_PC2);
    const { pdu } = h.inbound(echoReply(SRV, R1_OUT, 2, 1));
    expect(pdu.get('ipv4.dst')).toBe(PC2);
    expect(pdu.get('icmpv4.id')).toBe(1);
    expect(h.reasons(pdu)).toEqual([
      'NatTranslate:icmpv4.id', 'ChecksumRecompute:icmpv4.checksum', 'FcsRecompute:ethernet.fcs',
      'NatTranslate:ipv4.dst', 'ChecksumRecompute:ipv4.checksum', 'FcsRecompute:ethernet.fcs',
      'TtlDecrement:ipv4.ttl', 'ChecksumRecompute:ipv4.checksum', 'FcsRecompute:ethernet.fcs',
    ]);
    expect(sendVias(h).at(-1)).toEqual([PC2, GI0]);
    expect(h.icmp.pdus).toEqual([]);
    // the reply to id 1 goes to PC1 with no id rewrite
    const { pdu: one } = h.inbound(echoReply(SRV, R1_OUT, 1, 1));
    expect(one.get('ipv4.dst')).toBe(PC1);
    expect(one.provenance.filter((m) => m.reason === 'NatTranslate').map((m) => m.field)).toEqual(['ipv4.dst']);
  });

  it('inbound match rule: an outside echo REQUEST with id 1 reaches R1 itself while PC1\'s row is alive; a reply from another host does not match', () => {
    const h = patRouter();
    h.outbound(echo(PC1, SRV, 1, 1));
    expect(h.rows().map((r) => r.key)).toEqual([natKey('icmp', R1_OUT, 1)]);
    const { pdu: req } = h.inbound(echo(SRV, R1_OUT, 1, 1, 64));
    expect(req.provenance.some((m) => m.reason === 'NatTranslate')).toBe(false);
    expect(h.icmp.pdus).toEqual([req]);
    expect(sendVias(h)).toHaveLength(1);
    // a reply with the right id from the wrong outside host is not PC1's: delivered to R1
    const { pdu: other } = h.inbound(echoReply(SRV2, R1_OUT, 1, 1));
    expect(other.provenance.some((m) => m.reason === 'NatTranslate')).toBe(false);
    expect(h.icmp.pdus).toEqual([req, other]);
    expect(h.nat.stateSnapshot().state).toMatchObject({ counters: { untranslated: 2 } });
  });

  it('udp and tcp flows: one row per (proto, inside socket, outside socket); the inbound match needs the outside address and port', () => {
    const h = patRouter();
    const t0 = h.ctx.now;
    const { pdu: d } = h.outbound(udp(PC1, 5000, SRV, 53));
    expect(d.get('udp.srcPort')).toBe(5000);
    expect(d.get('ipv4.src')).toBe(R1_OUT);
    expect(h.reasons(d)).toEqual([
      'TtlDecrement:ipv4.ttl', 'ChecksumRecompute:ipv4.checksum', 'FcsRecompute:ethernet.fcs',
      'NatTranslate:ipv4.src', 'ChecksumRecompute:udp.checksum', 'ChecksumRecompute:ipv4.checksum', 'FcsRecompute:ethernet.fcs',
    ]);
    // PC2 with the same source port to the same server: 5000 is taken → 5001, port first then address
    const { pdu: e } = h.outbound(udp(PC2, 5000, SRV, 53), MAC_PC2);
    expect(e.get('udp.srcPort')).toBe(5001);
    expect(h.reasons(e)).toEqual([
      'TtlDecrement:ipv4.ttl', 'ChecksumRecompute:ipv4.checksum', 'FcsRecompute:ethernet.fcs',
      'NatTranslate:udp.srcPort', 'ChecksumRecompute:udp.checksum', 'FcsRecompute:ethernet.fcs',
      'NatTranslate:ipv4.src', 'ChecksumRecompute:udp.checksum', 'ChecksumRecompute:ipv4.checksum', 'FcsRecompute:ethernet.fcs',
    ]);
    expect(e.get('udp.checksumValid')).toBe(true);
    // PC1 from the same port to ANOTHER server is another flow, so another row (5002)
    const { pdu: f } = h.outbound(udp(PC1, 5000, SRV2, 53));
    expect(f.get('udp.srcPort')).toBe(5002);
    expect(h.rows().map(brief)).toEqual([
      ['udp', PC1, 5000, R1_OUT, 5000, SRV, 53, 'overload'],
      ['udp', PC2, 5000, R1_OUT, 5001, SRV, 53, 'overload'],
      ['udp', PC1, 5000, R1_OUT, 5002, SRV2, 53, 'overload'],
    ]);
    expect(h.rows().map((r) => r.expiresAt)).toEqual([t0 + 300 * SEC, t0 + 300 * SEC, t0 + 300 * SEC]);
    // inbound: SRV:53 → 203.0.113.1:5001 matches PC2's row; SRV2:53 → :5001 does not (wrong outside address); SRV:54 → :5001 neither
    const { pdu: in1 } = h.inbound(udp(SRV, 53, R1_OUT, 5001, 64));
    expect(in1.get('ipv4.dst')).toBe(PC2);
    expect(in1.get('udp.dstPort')).toBe(5000);
    expect(in1.provenance.filter((m) => m.reason === 'NatTranslate').map((m) => [m.field, m.before, m.after])).toEqual([['udp.dstPort', 5001, 5000], ['ipv4.dst', R1_OUT, PC2]]);
    const { pdu: in2 } = h.inbound(udp(SRV2, 53, R1_OUT, 5001, 64));
    expect(in2.provenance.some((m) => m.reason === 'NatTranslate')).toBe(false);
    const { pdu: in3 } = h.inbound(udp(SRV, 54, R1_OUT, 5001, 64));
    expect(in3.provenance.some((m) => m.reason === 'NatTranslate')).toBe(false);
    expect(h.udp.pdus).toEqual([in2, in3]);
    // tcp: 86 400 s while open; 60 s once FIN was seen both ways (or an RST)
    const { pdu: syn } = h.outbound(tcp(PC1, 40000, SRV, 80, 'S'));
    expect(syn.get('tcp.srcPort')).toBe(40000);
    expect(syn.get('tcp.checksumValid')).toBe(true);
    const row = (): NatRow => h.rows().find((r) => r.proto === 'tcp')!;
    expect(row().expiresAt).toBe(t0 + 86_400 * SEC);
    h.inbound(tcp(SRV, 80, R1_OUT, 40000, 'SA', 64));
    h.outbound(tcp(PC1, 40000, SRV, 80, 'FA'));
    expect(row().expiresAt).toBe(t0 + 86_400 * SEC);
    h.setNow(t0 + 10 * SEC);
    h.inbound(tcp(SRV, 80, R1_OUT, 40000, 'FA', 64));
    expect(row().expiresAt).toBe(t0 + 10 * SEC + 60 * SEC);
    const fsm = h.fake.debug.filter((x) => x.data?.fsm !== undefined).map((x) => x.data!.fsm as { to: string; cause: string }).filter((x) => x.to === 'closing');
    expect(fsm).toEqual([expect.objectContaining({ machine: 'nat', from: 'active', to: 'closing', cause: 'FIN seen in both directions' })]);
    // a later ACK does not extend the closing row
    h.setNow(t0 + 20 * SEC);
    h.outbound(tcp(PC1, 40000, SRV, 80, 'A'));
    expect(row().expiresAt).toBe(t0 + 70 * SEC);
    // an RST in either direction closes at once
    const { pdu: syn2 } = h.outbound(tcp(PC2, 40000, SRV, 80, 'S'), MAC_PC2);
    expect(syn2.get('tcp.srcPort')).toBe(40001);
    h.inbound(tcp(SRV, 80, R1_OUT, 40001, 'RA', 64));
    expect(h.rows().find((r) => r.insideGlobalPort === 40001)!.expiresAt).toBe(t0 + 20 * SEC + 60 * SEC);
  });

  it('ports held by local sockets are skipped; a full class drops nat-exhausted; a protocol without ports drops under overload', () => {
    const h = patRouter();
    h.sockets.set({ key: 'traceroute#1', id: 'traceroute#1', proto: 'udp', family: 4, localAddr: '0.0.0.0', localPort: 5000, state: 'BOUND', owner: 'traceroute', updatedAt: 0 });
    const { pdu } = h.outbound(udp(PC1, 5000, SRV, 33434));
    expect(pdu.get('udp.srcPort')).toBe(5001);
    // fill the whole 1–511 class for udp on the interface address
    for (let p = 1; p <= 511; p++) {
      h.natTable.set({ key: natKey('udp', R1_OUT, p), proto: 'udp', insideLocal: '192.168.1.99', insideLocalPort: p, insideGlobal: R1_OUT, insideGlobalPort: p, outsideGlobal: SRV, outsideGlobalPort: 53, kind: 'overload', rule: PAT_RULE, updatedAt: 0, expiresAt: 10 ** 15 });
    }
    const { pdu: full } = h.outbound(udp(PC2, 100, SRV, 53), MAC_PC2);
    expect(h.drops()).toEqual([{ type: 'drop', pdu: full, reason: 'nat-exhausted', detail: `interface ${GI1} has no free port on ${R1_OUT}`, port: GI0 }]);
    // GRE-style protocol 47 has nothing to overload on
    const gre = h.fake.build([
      { proto: 'ethernet', fields: { dst: '00:1f:00:00:00:10', src: '00:1f:00:00:00:01', type: 0x0800 } },
      { proto: 'ipv4', fields: { src: PC1, dst: SRV, protocol: 47, ttl: 64 } },
      { proto: 'payload', fields: { data: new Uint8Array(8) } },
    ]);
    h.ipv4.onPdu(h.ctx, gre, GI0).forEach((a) => {
      if (a.type === 'request' && a.to === 'nat') h.request(a.req);
    });
    expect(h.drops().at(-1)).toEqual({ type: 'drop', pdu: gre, reason: 'nat-exhausted', detail: 'protocol 47 carries no port to translate with overload', port: GI0 });
    // an interface without an address cannot overload either
    const g = patRouter([ACL_LINE, 'ip nat inside source list 1 interface Serial0/0/0 overload']);
    const { pdu: noaddr } = g.outbound(udp(PC1, 5000, SRV, 53));
    expect(g.drops()).toEqual([{ type: 'drop', pdu: noaddr, reason: 'nat-exhausted', detail: 'interface Serial0/0/0 has no address', port: GI0 }]);
  });

  it('overload on a pool takes the lowest pool address with a free port and answers ARP for it; [S9] timeout lines apply to new rows', () => {
    const h = patRouter([ACL_LINE, 'ip nat pool P 203.0.113.20 203.0.113.20 netmask 255.255.255.0', POOL_OVERLOAD, 'ip nat translation icmp-timeout 30', 'ip nat translation udp-timeout 120', 'ip nat translation tcp-timeout 600']);
    const t0 = h.ctx.now;
    const { pdu } = h.outbound(echo(PC1, SRV, 7, 1));
    expect(pdu.get('ipv4.src')).toBe('203.0.113.20');
    expect(pdu.get('icmpv4.id')).toBe(7);
    expect(h.rows().map(brief)).toEqual([['icmp', PC1, 7, '203.0.113.20', 7, SRV, undefined, 'overload']]);
    expect(h.rows()[0]!.expiresAt).toBe(t0 + 30 * SEC);
    const virtual = h.all.filter((x): x is Extract<Action, { type: 'request' }> => x.type === 'request' && x.req.kind === 'ipv4.virtual').map((x) => x.req);
    expect(virtual).toEqual([expect.objectContaining({ kind: 'ipv4.virtual', op: 'add', iface: GI1, address: '203.0.113.20', local: false, owner: 'nat' })]);
    h.outbound(udp(PC2, 5000, SRV, 53), MAC_PC2);
    h.outbound(tcp(PC2, 40000, SRV, 80, 'S'), MAC_PC2);
    expect(h.rows().map((r) => [r.proto, r.expiresAt])).toEqual([['icmp', t0 + 30 * SEC], ['udp', t0 + 120 * SEC], ['tcp', t0 + 600 * SEC]]);
    // the reply to 203.0.113.20 id 7 comes back to PC1
    const { pdu: reply } = h.inbound(echoReply(SRV, '203.0.113.20', 7, 1));
    expect(reply.get('ipv4.dst')).toBe(PC1);
    // the second pool address is used only when the first has no free port
    const g = patRouter([ACL_LINE, POOL_LINE, POOL_OVERLOAD]);
    for (let p = 0; p <= 65_535; p++) {
      g.natTable.set({ key: natKey('icmp', '203.0.113.20', p), proto: 'icmp', insideLocal: '192.168.1.99', insideLocalPort: p, insideGlobal: '203.0.113.20', insideGlobalPort: p, outsideGlobal: SRV, kind: 'overload', rule: POOL_OVERLOAD, updatedAt: 0, expiresAt: 10 ** 15 });
    }
    const { pdu: next } = g.outbound(echo(PC1, SRV, 1, 1));
    expect(next.get('ipv4.src')).toBe('203.0.113.21');
  });

  it('the sweep expires idle overload rows after their timeout and the virtual addresses follow', () => {
    const h = patRouter();
    const t0 = h.ctx.now;
    h.outbound(echo(PC1, SRV, 1, 1));
    h.outbound(udp(PC2, 5000, SRV, 53), MAC_PC2);
    h.setNow(t0 + 60 * SEC);
    h.timer(NAT_SWEEP_TIMER);
    expect(h.rows().map((r) => r.proto)).toEqual(['udp']);
    h.setNow(t0 + 300 * SEC);
    expect(h.timer(NAT_SWEEP_TIMER)).toEqual([{ type: 'cancelTimer', key: NAT_SWEEP_TIMER }]);
    expect(h.rows()).toEqual([]);
    expect(h.nat.stateSnapshot().state).toMatchObject({ counters: { expired: 2 } });
  });
});

describe('PAT in a real world (PC1, PC2 — SW — R1 — SRV)', () => {
  it('two pings at once with id 1: rows with inside global ids 1 and 2, SRV sees (203.0.113.1, 1) and (203.0.113.1, 2), both 5/5, checksums valid', () => {
    const sim = natWorld({ r1: [ACL_LINE, PAT_RULE] });
    const cursor = sim.trace(0).next;
    const s1 = start(sim, 'pc1', `ping ${SRV}`);
    const s2 = start(sim, 'pc2', `ping ${SRV}`);
    sim.runToIdle();
    const evs = sim.trace(cursor).events;
    expect(output(evs, s1)).toContain('Sent 5, received 5, lost 0');
    expect(output(evs, s2)).toContain('Sent 5, received 5, lost 0');
    const rows = natRows(sim);
    expect(rows.map(brief)).toEqual([
      ['icmp', PC1, 1, R1_OUT, 1, SRV, undefined, 'overload'],
      ['icmp', PC2, 1, R1_OUT, 2, SRV, undefined, 'overload'],
    ]);
    // what SRV received: five requests with id 1 and five with id 2, all from 203.0.113.1
    const atSrv = ofKind(evs, 'frameRx').filter((e) => e.device === 'srv');
    const seen = atSrv.map((e) => sim.pdu(e.pdu.id)!).filter((p) => p.get('icmpv4.type') === 8).map((p) => [p.get('ipv4.src'), p.get('icmpv4.id')]);
    expect(seen.filter((s) => s[1] === 1)).toHaveLength(5);
    expect(seen.filter((s) => s[1] === 2)).toHaveLength(5);
    expect(seen.every((s) => s[0] === R1_OUT)).toBe(true);
    const ipAtSrv = atSrv.map((e) => sim.pdu(e.pdu.id)!).filter((p) => p.layer('ipv4') !== undefined);
    expect(ipAtSrv.length).toBeGreaterThanOrEqual(10);
    for (const p of ipAtSrv) {
      expect(p.get('ipv4.checksumValid')).toBe(true);
      expect(p.get('icmpv4.checksumValid')).toBe(true);
    }
    // the PAT mutation sequence at R1 for the host whose id moved (§3.9 step 2), from real calls
    const pc2Requests = createdBy(evs, 'pc2', 'ping#');
    const moved = pc2Requests.map((id) => mutationsAt(sim, id, 'r1')).find((ms) => ms.some((m) => m[1] === 'icmpv4.id'))!;
    expect(moved.map((m) => m[0])).toEqual([
      'TtlDecrement', 'ChecksumRecompute', 'FcsRecompute',
      'NatTranslate', 'ChecksumRecompute', 'FcsRecompute',
      'NatTranslate', 'ChecksumRecompute', 'FcsRecompute',
      'MacRewrite', 'FcsRecompute', 'MacRewrite', 'FcsRecompute',
    ]);
    expect(moved.filter((m) => m[0] === 'NatTranslate')).toEqual([['NatTranslate', 'icmpv4.id', 1, 2], ['NatTranslate', 'ipv4.src', PC2, R1_OUT]]);
    // the replies came back translated to the right host
    const replies = createdBy(evs, 'srv', 'echo-reply').map((id) => sim.pdu(id)!);
    expect(replies).toHaveLength(10);
    expect(replies.map((p) => p.get('ipv4.dst')).sort()).toEqual([...Array<string>(5).fill(PC1), ...Array<string>(5).fill(PC2)]);
    // no inside address ever reached SRV
    expect(sim.device('srv')!.tables.arp.rows().map((r) => r.ip).filter((ip) => ip.startsWith('192.168.'))).toEqual([]);
    expect(ofKind(evs, 'drop').filter((d) => d.device === 'r1')).toEqual([]);
  });

  it("inbound match: while PC1's row icmp|203.0.113.1|1 is alive SRV pings 203.0.113.1 with id 1 — R1 answers and nothing reaches PC1; idle rows expire after 60 s", () => {
    const sim = natWorld({ r1: [ACL_LINE, PAT_RULE], inside: [{ id: 'pc1', name: 'PC1', address: PC1 }] });
    const first = exec(sim, 'pc1', `ping ${SRV}`);
    expect(first.text).toContain('Sent 5, received 5, lost 0');
    expect(natRows(sim).map((r) => r.key)).toEqual([natKey('icmp', R1_OUT, 1)]);
    const srv = exec(sim, 'srv', `ping ${R1_OUT}`);
    expect(srv.text).toContain('Sent 5, received 5, lost 0');
    expect(natRows(sim).map((r) => r.key)).toEqual([natKey('icmp', R1_OUT, 1)]);
    const srvRequests = createdBy(srv.evs, 'srv', 'ping#');
    expect(srvRequests).toHaveLength(5);
    for (const id of srvRequests) expect(sim.pdu(id)!.provenance.some((m) => m.reason === 'NatTranslate')).toBe(false);
    expect(createdBy(srv.evs, 'r1', 'echo-reply')).toHaveLength(5);
    expect(ofKind(srv.evs, 'frameRx').filter((e) => e.device === 'pc1')).toEqual([]);
    // 60 s idle: the sweep removes the row
    sim.runFor(130 * SEC);
    expect(natRows(sim)).toEqual([]);
    const expired = ofKind(sim.trace(0).events, 'tableExpire').filter((e) => e.device === 'r1' && e.table === 'nat');
    expect(expired).toEqual([expect.objectContaining({ key: natKey('icmp', R1_OUT, 1), reason: 'aged' })]);
  });
});
