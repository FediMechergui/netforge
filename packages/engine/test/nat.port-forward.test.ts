/**
 * W3 nat [S9] (ARCHITECTURE-P2 §3.9 table row "static port forward", §5.2 `ip nat inside source static tcp|udp <il>
 * <lp> <ig>|interface <if> <gp>`): a static port row (proto tcp|udp, both ports), inbound to (ig, gp) → (il, lp) with
 * the port rewritten before the address, outbound from (il, lp) → (ig, gp) — and only that socket; the `interface`
 * form follows the interface address; the row never expires and wins over a dynamic rule; a real world where an
 * outside host reaches the forwarded port of an inside server (a udp probe answered by the inside host).
 */
import { describe, expect, it } from 'vitest';
import type { Action } from '../src/contracts/process.js';
import { natKey } from '../src/contracts/tables.js';
import type { NatRow } from '../src/contracts/tables.js';
import { NAT_SWEEP_TIMER } from '../src/protocols/nat.js';
import {
  ACL_LINE, GI0, GI1, MAC_R1, MASK24, PAT_RULE, PC1, PC2, R1_OUT, SRV, STATIC_GLOBAL,
  exec, natFake, natRows, natWorld, sendVias, tcp, udp,
} from './nat.harness.js';
import { ofKind } from './sim.harness.js';

const WEB = `ip nat inside source static tcp ${PC1} 80 ${STATIC_GLOBAL} 8080`;
const DNS_IF = `ip nat inside source static udp ${PC2} 53 interface ${GI1} 5353`;

const brief = (r: NatRow): unknown[] => [r.proto, r.insideLocal, r.insideLocalPort, r.insideGlobal, r.insideGlobalPort, r.kind];

function forwardRouter(lines: readonly string[] = [WEB, DNS_IF]) {
  const h = natFake();
  h.iface(GI0, 'ip nat inside');
  h.iface(GI1, 'ip nat outside');
  for (const l of lines) h.global(l);
  return h;
}

describe('[S9] static port forwarding on the fake router', () => {
  it('writes one static row per line keyed proto|ig|gp, answers ARP for an explicit inside global, never for the interface address', () => {
    const h = forwardRouter();
    expect(h.rows().map(brief)).toEqual([
      ['tcp', PC1, 80, STATIC_GLOBAL, 8080, 'static'],
      ['udp', PC2, 53, R1_OUT, 5353, 'static'],
    ]);
    expect(h.rows().map((r) => r.key)).toEqual([natKey('tcp', STATIC_GLOBAL, 8080), natKey('udp', R1_OUT, 5353)]);
    expect(h.rows().every((r) => r.expiresAt === undefined)).toBe(true);
    expect(h.rows().map((r) => r.rule)).toEqual([WEB, DNS_IF]);
    const virtual = h.all.filter((a): a is Extract<Action, { type: 'request' }> => a.type === 'request' && a.req.kind === 'ipv4.virtual').map((a) => a.req);
    expect(virtual).toEqual([{ kind: 'ipv4.virtual', op: 'add', iface: GI1, address: STATIC_GLOBAL, mac: MAC_R1, local: false, owner: 'nat' }]);
    expect(h.actions.filter((a) => a.type === 'timer')).toEqual([]);
    expect(h.nat.onTimer(h.ctx, NAT_SWEEP_TIMER)).toEqual([]);
  });

  it('inbound to 203.0.113.5:8080 from anywhere → 192.168.1.10:80 (port first, then address), with the rule as cause; other ports are untouched', () => {
    const h = forwardRouter();
    const { pdu } = h.inbound(tcp(SRV, 40000, STATIC_GLOBAL, 8080, 'S', 64));
    expect(pdu.get('ipv4.dst')).toBe(PC1);
    expect(pdu.get('tcp.dstPort')).toBe(80);
    expect(h.reasons(pdu)).toEqual([
      'NatTranslate:tcp.dstPort', 'ChecksumRecompute:tcp.checksum', 'FcsRecompute:ethernet.fcs',
      'NatTranslate:ipv4.dst', 'ChecksumRecompute:tcp.checksum', 'ChecksumRecompute:ipv4.checksum', 'FcsRecompute:ethernet.fcs',
      'TtlDecrement:ipv4.ttl', 'ChecksumRecompute:ipv4.checksum', 'FcsRecompute:ethernet.fcs',
    ]);
    expect(pdu.provenance.filter((m) => m.reason === 'NatTranslate').map((m) => [m.field, m.before, m.after, m.cause])).toEqual([
      ['tcp.dstPort', 8080, 80, WEB],
      ['ipv4.dst', STATIC_GLOBAL, PC1, WEB],
    ]);
    expect(pdu.get('tcp.checksumValid')).toBe(true);
    expect(sendVias(h)).toEqual([[PC1, GI0]]);
    // a second outside host reaches the same forward (no outside filter on a static port row)
    const { pdu: other } = h.inbound(tcp('198.51.100.7', 1234, STATIC_GLOBAL, 8080, 'S', 64));
    expect(other.get('ipv4.dst')).toBe(PC1);
    // another port of 203.0.113.5, or udp to 8080, matches nothing: left as is (no address-only row for .5 exists)
    const { pdu: port } = h.inbound(tcp(SRV, 40001, STATIC_GLOBAL, 8081, 'S', 64));
    expect(port.provenance.some((m) => m.reason === 'NatTranslate')).toBe(false);
    const { pdu: proto } = h.inbound(udp(SRV, 40002, STATIC_GLOBAL, 8080, 64));
    expect(proto.provenance.some((m) => m.reason === 'NatTranslate')).toBe(false);
    // the interface form: 203.0.113.1:5353/udp → PC2:53; 203.0.113.1:53 stays the router's own
    const { pdu: dns } = h.inbound(udp(SRV, 40003, R1_OUT, 5353, 64));
    expect(dns.get('ipv4.dst')).toBe(PC2);
    expect(dns.get('udp.dstPort')).toBe(53);
    expect(dns.provenance.filter((m) => m.reason === 'NatTranslate').map((m) => m.cause)).toEqual([DNS_IF, DNS_IF]);
    const { pdu: own } = h.inbound(udp(SRV, 40004, R1_OUT, 53, 64));
    expect(own.provenance.some((m) => m.reason === 'NatTranslate')).toBe(false);
    expect(h.udp.pdus).toEqual([own]);
    expect(h.rows()).toHaveLength(2);
  });

  it('outbound from the forwarded socket → (ig, gp) with the port rewritten first; another socket of the host is not translated by the forward', () => {
    const h = forwardRouter();
    const { pdu } = h.outbound(tcp(PC1, 80, SRV, 40000, 'SA'));
    expect(pdu.get('ipv4.src')).toBe(STATIC_GLOBAL);
    expect(pdu.get('tcp.srcPort')).toBe(8080);
    expect(h.reasons(pdu)).toEqual([
      'TtlDecrement:ipv4.ttl', 'ChecksumRecompute:ipv4.checksum', 'FcsRecompute:ethernet.fcs',
      'NatTranslate:tcp.srcPort', 'ChecksumRecompute:tcp.checksum', 'FcsRecompute:ethernet.fcs',
      'NatTranslate:ipv4.src', 'ChecksumRecompute:tcp.checksum', 'ChecksumRecompute:ipv4.checksum', 'FcsRecompute:ethernet.fcs',
    ]);
    expect(pdu.provenance.filter((m) => m.reason === 'NatTranslate').map((m) => [m.field, m.before, m.after])).toEqual([['tcp.srcPort', 80, 8080], ['ipv4.src', PC1, STATIC_GLOBAL]]);
    const { pdu: other } = h.outbound(tcp(PC1, 81, SRV, 40000, 'S'));
    expect(other.provenance.some((m) => m.reason === 'NatTranslate')).toBe(false);
    const { pdu: dns } = h.outbound(udp(PC2, 53, SRV, 40003), '00:1f:00:00:00:02');
    expect(dns.get('ipv4.src')).toBe(R1_OUT);
    expect(dns.get('udp.srcPort')).toBe(5353);
  });

  it('the forward wins over PAT for its socket, PAT takes the rest, and the PAT walk skips the forwarded global port', () => {
    const h = forwardRouter([WEB, DNS_IF, ACL_LINE, PAT_RULE]);
    const { pdu: web } = h.outbound(tcp(PC1, 80, SRV, 40000, 'SA'));
    expect([web.get('ipv4.src'), web.get('tcp.srcPort')]).toEqual([STATIC_GLOBAL, 8080]);
    const { pdu: browse } = h.outbound(tcp(PC1, 50000, SRV, 80, 'S'));
    expect([browse.get('ipv4.src'), browse.get('tcp.srcPort')]).toEqual([R1_OUT, 50000]);
    // a host whose inside udp port is 5353 cannot take 203.0.113.1:5353 (the forward holds it): it moves to 5354
    const { pdu: clash } = h.outbound(udp(PC1, 5353, SRV, 53));
    expect([clash.get('ipv4.src'), clash.get('udp.srcPort')]).toEqual([R1_OUT, 5354]);
    expect(h.rows().map(brief)).toEqual([
      ['tcp', PC1, 80, STATIC_GLOBAL, 8080, 'static'],
      ['udp', PC2, 53, R1_OUT, 5353, 'static'],
      ['tcp', PC1, 50000, R1_OUT, 50000, 'overload'],
      ['udp', PC1, 5353, R1_OUT, 5354, 'overload'],
    ]);
    // clear removes the overload rows only
    h.request({ kind: 'nat.clear' });
    expect(h.rows().map((r) => r.kind)).toEqual(['static', 'static']);
  });

  it('the interface form follows the address of its interface and has no row while the interface has none', () => {
    const h = natFake({ addresses: false });
    h.iface(GI0, `ip address 192.168.1.1 ${MASK24}`);
    h.iface(GI0, 'ip nat inside');
    h.iface(GI1, 'ip nat outside');
    h.global(DNS_IF);
    expect(h.rows()).toEqual([]);
    h.iface(GI1, `ip address ${R1_OUT} ${MASK24}`);
    expect(h.rows().map((r) => r.key)).toEqual([natKey('udp', R1_OUT, 5353)]);
    h.iface(GI1, 'ip address 203.0.113.2 255.255.255.0');
    expect(h.rows().map((r) => r.key)).toEqual([natKey('udp', '203.0.113.2', 5353)]);
    expect(h.kinds('tableExpire').filter((e) => e.table === 'nat').map((e) => [e.key, e.reason])).toEqual([[natKey('udp', R1_OUT, 5353), 'cleared']]);
    h.global(DNS_IF, true);
    expect(h.rows()).toEqual([]);
  });
});

describe('[S9] port forwarding in a real world', () => {
  it('an outside router\'s udp probe to 203.0.113.5:33434 reaches the inside host, whose port-unreachable comes back translated (traceroute completes at hop 2 = 203.0.113.5)', () => {
    // R1 forwards the udp ports of the second hop's three probes (33437–33439) to PC1; R2 (outside) traces
    // 203.0.113.5: hop 1 is R1, hop 2 the "server" 203.0.113.5
    const ports = [33437, 33438, 33439];
    const sim = natWorld({
      r1: ports.map((p) => `ip nat inside source static udp ${PC1} ${p} ${STATIC_GLOBAL} ${p}`),
      inside: [{ id: 'pc1', name: 'PC1', address: PC1 }],
      far: true,
    });
    expect(natRows(sim).map(brief)).toEqual(ports.map((p) => ['udp', PC1, p, STATIC_GLOBAL, p, 'static']));
    const { text, evs } = exec(sim, 'r2', `traceroute ${STATIC_GLOBAL}`);
    const hops = text.split('\n').filter((l) => /^\s*\d+\s/.test(l));
    expect(hops).toHaveLength(2);
    expect(hops[0]).toMatch(/^\s*1\s+203\.0\.113\.1\s/);
    expect(hops[1]).toMatch(new RegExp(`^\\s*2\\s+${STATIC_GLOBAL.replace(/\./g, '\\.')}\\s`));
    expect(text).not.toContain('192.168.');
    // every hop-2 probe reached PC1 translated (dst 203.0.113.5:p → 192.168.1.10:p, the port unchanged so no port mutation)
    const probes = ofKind(evs, 'pduCreated').filter((e) => e.device === 'r2' && (e.pdu.tag ?? '').startsWith('trace 2.'));
    expect(probes).toHaveLength(3);
    for (const e of probes) {
      const p = sim.pdu(e.pdu.id)!;
      expect(p.provenance.filter((m) => m.reason === 'NatTranslate').map((m) => [m.field, m.before, m.after])).toEqual([['ipv4.dst', STATIC_GLOBAL, PC1]]);
      expect(p.get('ipv4.dst')).toBe(PC1);
    }
    expect(hops[1]).not.toContain('*');
    // PC1's port-unreachable left R1 with its source and its quoted destination translated back (the outbound error direction)
    const errors = ofKind(evs, 'pduCreated').filter((e) => e.device === 'pc1').map((e) => sim.pdu(e.pdu.id)!).filter((p) => p.get('icmpv4.type') === 3);
    expect(errors.length).toBeGreaterThanOrEqual(1);
    const err = errors[0]!;
    expect(err.get('ipv4.src')).toBe(STATIC_GLOBAL);
    expect(err.provenance.filter((m) => m.reason === 'NatTranslate').map((m) => [m.field, m.before, m.after])).toEqual([
      ['ipv4.src', PC1, STATIC_GLOBAL],
      ['ipv4[3].dst', PC1, STATIC_GLOBAL],
    ]);
    expect(err.get('ipv4.checksumValid')).toBe(true);
    expect(err.get('icmpv4.checksumValid')).toBe(true);
    // R1's drops are the hop-1 probes whose TTL ran out there (hop 1 = R1) and nothing else: every hop-2 probe was forwarded
    expect(ofKind(evs, 'drop').filter((d) => d.device === 'r1').map((d) => d.reason)).toEqual(['ttl-expired', 'ttl-expired', 'ttl-expired']);
    // a probe to an unforwarded port of 203.0.113.5 is left untranslated and routed as a real router would: back out the
    // connected outside network, where nobody answers the ARP (a second trace would reach hop 3's ports 33440 …)
    const stray = exec(sim, 'r2', `traceroute ${STATIC_GLOBAL}`);
    expect(stray.text).toContain(`2 ${STATIC_GLOBAL}`);
  });
});
