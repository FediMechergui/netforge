/**
 * W3 nat [S9] (ARCHITECTURE-P2 §3.9 step 5 and the two "ICMP error" table rows, §2.3 quoted-layer patching): an ICMP
 * error carries no port, so nat looks its translation up in the EMBEDDED packet with the roles reversed.
 *  • Inbound (an error from beyond R1 about a packet R1 translated outbound): row by (quoted proto, quoted src =
 *    inside global, quoted src port | id), quoted dst must be the row's outside global; the outer dst and the quoted
 *    src (and port / id) are rewritten global → local, the quoted checksums patched in place, the outer ones re-encoded.
 *  • Outbound (an error from an inside host about an inbound flow): row by (quoted proto, quoted dst = inside local,
 *    quoted dst port | id) plus the quoted src for an overload row; the outer src and the quoted dst (and port) are
 *    rewritten local → global, so the outside host matches the error and no inside address leaks.
 * Real worlds: traceroute through PAT with echo probes (two PCs at once, ids collide and move) and with udp probes (an
 * inside router) — every hop matched back at the host: R1, R2, SRV.
 */
import { describe, expect, it } from 'vitest';
import { ICMP_DEST_UNREACHABLE, ICMP_TIME_EXCEEDED, ICMP_UNREACH_PORT, TRACEROUTE_BASE_PORT } from '../src/contracts/pdu.js';
import type { PduView } from '../src/contracts/pdu.js';
import {
  ACL_LINE, GI0, GI1, MAC_PC2, PAT_RULE, PC1, PC2, R1_IN, R1_OUT, R2_NEAR, SRV, SRV_FAR, STATIC_GLOBAL, STATIC_LINE,
  echo, icmpError, natFake, natRows, natWorld, sendVias, start, tcp, udp,
} from './nat.harness.js';
import { ofKind, output } from './sim.harness.js';

const HOP = '198.51.100.9';
const SRV2 = '203.0.113.11';

const nats = (p: PduView): [string, unknown, unknown][] => p.provenance.filter((m) => m.reason === 'NatTranslate').map((m) => [m.field, m.before, m.after]);

function patRouter(lines: readonly string[] = [ACL_LINE, PAT_RULE]) {
  const h = natFake();
  h.iface(GI0, 'ip nat inside');
  h.iface(GI1, 'ip nat outside');
  for (const l of lines) h.global(l);
  return h;
}

describe('[S9] inbound ICMP errors on the fake router', () => {
  it('a time-exceeded from a far hop about a translated udp probe: outer dst, quoted src and quoted src port back to the inside host', () => {
    const h = patRouter();
    h.outbound(udp(PC1, 5000, SRV, TRACEROUTE_BASE_PORT, 2));
    const { pdu: probe } = h.outbound(udp(PC2, 5000, SRV, TRACEROUTE_BASE_PORT, 2), MAC_PC2);
    expect(probe.get('udp.srcPort')).toBe(5001);
    // the hop quotes what it received: R1's translated packet (TTL already down to 1 there)
    const quoted = udp(R1_OUT, 5001, SRV, TRACEROUTE_BASE_PORT, 1);
    const { pdu } = h.inbound(icmpError(HOP, R1_OUT, quoted), '00:1f:00:00:00:30');
    expect(nats(pdu)).toEqual([
      ['ipv4.dst', R1_OUT, PC2],
      ['ipv4[3].src', R1_OUT, PC2],
      ['udp[4].srcPort', 5001, 5000],
    ]);
    expect(pdu.provenance.filter((m) => m.reason === 'NatTranslate').every((m) => m.cause === PAT_RULE)).toBe(true);
    // Derived records, from real calls: the quoted udp checksum (pseudo-header) and quoted ipv4 header checksum are
    // patched, then the enclosing icmp checksum re-encodes and the FCS follows. The outer ipv4 header checksum does not
    // cover the payload, so it is unchanged by a quote patch; and a port patch plus its udp checksum adjustment cancel
    // out in the ones-complement sum, so the icmp checksum is unchanged by the second patch. Only changes are recorded.
    expect(h.reasons(pdu)).toEqual([
      'NatTranslate:ipv4.dst', 'ChecksumRecompute:ipv4.checksum', 'FcsRecompute:ethernet.fcs',
      'NatTranslate:ipv4[3].src', 'ChecksumRecompute:udp[4].checksum', 'ChecksumRecompute:ipv4[3].checksum', 'ChecksumRecompute:icmpv4.checksum', 'FcsRecompute:ethernet.fcs',
      'NatTranslate:udp[4].srcPort', 'ChecksumRecompute:udp[4].checksum', 'FcsRecompute:ethernet.fcs',
      'TtlDecrement:ipv4.ttl', 'ChecksumRecompute:ipv4.checksum', 'FcsRecompute:ethernet.fcs',
    ]);
    expect(pdu.get('ipv4.dst')).toBe(PC2);
    expect(pdu.get('ipv4[3].src')).toBe(PC2);
    expect(pdu.get('ipv4[3].dst')).toBe(SRV);
    expect(pdu.get('udp[4].srcPort')).toBe(5000);
    expect(pdu.get('udp[4].dstPort')).toBe(TRACEROUTE_BASE_PORT);
    expect(pdu.get('ipv4.checksumValid')).toBe(true);
    expect(pdu.get('icmpv4.checksumValid')).toBe(true);
    expect(pdu.get('ipv4[3].checksumValid')).toBe(true);
    // the quote is still the IP header plus 8 bytes: the quoted udp length field is untouched
    expect(pdu.layerAt(4)!.length).toBe(8);
    expect(sendVias(h).at(-1)).toEqual([PC2, GI0]);
    expect(h.icmp.pdus).toEqual([]);
    // the row was refreshed, not duplicated
    expect(h.rows()).toHaveLength(2);
  });

  it('a quoted echo probe whose id moved: quoted id back too; a quoted tcp segment: its port patched, its checksum never touched', () => {
    const h = patRouter();
    h.outbound(echo(PC1, SRV, 1, 1, 2));
    h.outbound(echo(PC2, SRV, 1, 1, 2), MAC_PC2);
    const { pdu } = h.inbound(icmpError(HOP, R1_OUT, echo(R1_OUT, SRV, 2, 1, 1)), '00:1f:00:00:00:30');
    expect(nats(pdu)).toEqual([
      ['ipv4.dst', R1_OUT, PC2],
      ['ipv4[3].src', R1_OUT, PC2],
      ['icmpv4[4].id', 2, 1],
    ]);
    const at = h.reasons(pdu).indexOf('NatTranslate:icmpv4[4].id');
    expect(at).toBeGreaterThan(0);
    // the quoted icmp checksum is adjusted in place (RFC 1624), then the FCS; the enclosing icmp checksum is unchanged
    // (the id change and its quoted checksum adjustment cancel out in the ones-complement sum)
    expect(h.reasons(pdu).slice(at, at + 3)).toEqual(['NatTranslate:icmpv4[4].id', 'ChecksumRecompute:icmpv4[4].checksum', 'FcsRecompute:ethernet.fcs']);
    expect(pdu.get('icmpv4.checksumValid')).toBe(true);
    expect(pdu.get('ipv4[3].checksumValid')).toBe(true);
    expect(pdu.get('icmpv4[4].id')).toBe(1);
    expect(sendVias(h).at(-1)).toEqual([PC2, GI0]);
    // tcp
    h.outbound(tcp(PC1, 40000, SRV, 80, 'S', 2));
    h.outbound(tcp(PC2, 40000, SRV, 80, 'S', 2), MAC_PC2);
    const { pdu: t } = h.inbound(icmpError(HOP, R1_OUT, tcp(R1_OUT, 40001, SRV, 80, 'S', 1), ICMP_DEST_UNREACHABLE, 1), '00:1f:00:00:00:30');
    expect(nats(t)).toEqual([
      ['ipv4.dst', R1_OUT, PC2],
      ['ipv4[3].src', R1_OUT, PC2],
      ['tcp[4].srcPort', 40001, 40000],
    ]);
    expect(h.reasons(t).filter((r) => r.includes('tcp[4].checksum'))).toEqual([]);
    expect(t.get('tcp[4].srcPort')).toBe(40000);
    expect(t.get('tcp[4].dstPort')).toBe(80);
  });

  it('no match: a quote about another outside host, an unknown port, or a non-quoting error leaves the packet alone (delivered to R1)', () => {
    const h = patRouter();
    h.outbound(udp(PC1, 5000, SRV, TRACEROUTE_BASE_PORT, 2));
    const { pdu: wrongDst } = h.inbound(icmpError(HOP, R1_OUT, udp(R1_OUT, 5000, SRV2, TRACEROUTE_BASE_PORT, 1)), '00:1f:00:00:00:30');
    expect(nats(wrongDst)).toEqual([]);
    const { pdu: wrongPort } = h.inbound(icmpError(HOP, R1_OUT, udp(R1_OUT, 5009, SRV, TRACEROUTE_BASE_PORT, 1)), '00:1f:00:00:00:30');
    expect(nats(wrongPort)).toEqual([]);
    expect(h.icmp.pdus).toEqual([wrongDst, wrongPort]);
    expect(h.nat.stateSnapshot().state).toMatchObject({ counters: { untranslated: 2, inbound: 0 } });
  });

  it('address-only rows (static): an error about the inside global goes to the inside host with the quoted src rewritten, no port', () => {
    const h = patRouter([STATIC_LINE]);
    const { pdu } = h.inbound(icmpError(HOP, STATIC_GLOBAL, udp(STATIC_GLOBAL, 5000, SRV, TRACEROUTE_BASE_PORT, 1)), '00:1f:00:00:00:30');
    expect(nats(pdu)).toEqual([
      ['ipv4.dst', STATIC_GLOBAL, PC1],
      ['ipv4[3].src', STATIC_GLOBAL, PC1],
    ]);
    expect(pdu.provenance.filter((m) => m.reason === 'NatTranslate').every((m) => m.cause === STATIC_LINE)).toBe(true);
    expect(pdu.get('udp[4].srcPort')).toBe(5000);
    expect(sendVias(h).at(-1)).toEqual([PC1, GI0]);
  });
});

describe('[S9] outbound ICMP errors on the fake router', () => {
  it("an inside host's port-unreachable about a datagram that came in through PAT: outer src, quoted dst and quoted dst port to the global side", () => {
    const h = patRouter();
    h.outbound(udp(PC1, 5000, SRV, 53));
    h.outbound(udp(PC2, 5000, SRV, 53), MAC_PC2); // → 203.0.113.1:5001
    const { pdu: back } = h.inbound(udp(SRV, 53, R1_OUT, 5001, 64));
    expect([back.get('ipv4.dst'), back.get('udp.dstPort')]).toEqual([PC2, 5000]);
    // PC2 had no socket: it errors, quoting what it received (the translated datagram)
    const { pdu } = h.outbound(icmpError(PC2, SRV, udp(SRV, 53, PC2, 5000, 63), ICMP_DEST_UNREACHABLE, ICMP_UNREACH_PORT, 128), MAC_PC2);
    expect(nats(pdu)).toEqual([
      ['ipv4.src', PC2, R1_OUT],
      ['ipv4[3].dst', PC2, R1_OUT],
      ['udp[4].dstPort', 5000, 5001],
    ]);
    expect(pdu.provenance.filter((m) => m.reason === 'NatTranslate').every((m) => m.cause === PAT_RULE)).toBe(true);
    expect(pdu.get('ipv4.src')).toBe(R1_OUT);
    expect(pdu.get('ipv4[3].src')).toBe(SRV);
    expect(pdu.get('ipv4[3].dst')).toBe(R1_OUT);
    expect(pdu.get('udp[4].dstPort')).toBe(5001);
    expect(pdu.get('ipv4.checksumValid')).toBe(true);
    expect(pdu.get('icmpv4.checksumValid')).toBe(true);
    expect(pdu.get('ipv4[3].checksumValid')).toBe(true);
    expect(sendVias(h).at(-1)).toEqual([SRV, GI1]);
    // nothing inside leaks: no 192.168 byte pattern remains in the packet's addresses
    expect([pdu.get('ipv4.src'), pdu.get('ipv4.dst'), pdu.get('ipv4[3].src'), pdu.get('ipv4[3].dst')].some((a) => String(a).startsWith('192.168.'))).toBe(false);
  });

  it('a port forward: the server\'s error about a forwarded connection carries the global address and port; an unrelated error leaves untranslated', () => {
    const WEB = `ip nat inside source static tcp ${PC1} 80 ${STATIC_GLOBAL} 8080`;
    const h = patRouter([WEB]);
    h.inbound(tcp(SRV, 40000, STATIC_GLOBAL, 8080, 'S', 64));
    const { pdu } = h.outbound(icmpError(PC1, SRV, tcp(SRV, 40000, PC1, 80, 'S', 63), ICMP_DEST_UNREACHABLE, ICMP_UNREACH_PORT, 128));
    expect(nats(pdu)).toEqual([
      ['ipv4.src', PC1, STATIC_GLOBAL],
      ['ipv4[3].dst', PC1, STATIC_GLOBAL],
      ['tcp[4].dstPort', 80, 8080],
    ]);
    expect(h.reasons(pdu).filter((r) => r.includes('tcp[4].checksum'))).toEqual([]);
    expect(pdu.get('tcp[4].dstPort')).toBe(8080);
    // an error PC2 sends about a packet nobody translated: passed through as is
    const { pdu: none } = h.outbound(icmpError(PC2, SRV, udp(SRV, 53, PC2, 7000, 63), ICMP_DEST_UNREACHABLE, ICMP_UNREACH_PORT, 128), MAC_PC2);
    expect(nats(none)).toEqual([]);
    expect(sendVias(h).at(-1)).toEqual([SRV, GI1]);
    expect(h.natDebug().at(-1)).toBe(`out ${PC2} -> ${SRV} (icmp) left untranslated: no matching translation`);
  });
});

describe('[S9] traceroute through PAT in a real world (PC1, PC2 — SW — R1 — R2 — SRV)', () => {
  const hops = (text: string): [number, string][] =>
    text.split('\n').map((l) => /^\s*(\d+)\s+(\S+)/.exec(l)).filter((m): m is RegExpExecArray => m !== null).map((m) => [Number(m[1]), m[2]!]);

  it('echo probes from two hosts at once: every hop is matched back at each host, the far hop\'s errors are translated (ids moved for one host)', () => {
    const sim = natWorld({ r1: [ACL_LINE, PAT_RULE], far: true });
    const cursor = sim.trace(0).next;
    const s1 = start(sim, 'pc1', `tracert ${SRV_FAR}`);
    const s2 = start(sim, 'pc2', `tracert ${SRV_FAR}`);
    sim.runToIdle();
    const evs = sim.trace(cursor).events;
    for (const s of [s1, s2]) {
      const text = output(evs, s);
      expect(hops(text)).toEqual([[1, R1_IN], [2, R2_NEAR], [3, SRV_FAR]]);
      expect(text).toContain(`Reached ${SRV_FAR} in 3 hops`);
      expect(text).not.toContain('*');
    }
    // R2's time-exceeded messages (hop 2) were addressed to 203.0.113.1 and translated at R1 to each host, quote included
    const errors = ofKind(evs, 'pduCreated').filter((e) => e.device === 'r2').map((e) => sim.pdu(e.pdu.id)!).filter((p) => p.get('icmpv4.type') === ICMP_TIME_EXCEEDED);
    expect(errors).toHaveLength(6);
    for (const p of errors) {
      const n = nats(p);
      expect(n[0]).toEqual(['ipv4.dst', R1_OUT, p.get('ipv4.dst')]);
      expect(n[1]).toEqual(['ipv4[3].src', R1_OUT, p.get('ipv4.dst')]);
      expect([PC1, PC2]).toContain(p.get('ipv4.dst'));
      expect(p.get('ipv4.checksumValid')).toBe(true);
      expect(p.get('icmpv4.checksumValid')).toBe(true);
      expect(p.get('ipv4[3].checksumValid')).toBe(true);
    }
    // the two hosts used the same probe ids, so one host's ids moved and its errors carry the quoted id rewrite too
    const moved = errors.filter((p) => nats(p).some((m) => m[0] === 'icmpv4[4].id'));
    expect(moved.length).toBeGreaterThanOrEqual(3);
    expect(moved.map((p) => p.get('ipv4.dst'))).toContain(PC2);
    expect(natRows(sim).every((r) => r.proto === 'icmp' && r.kind === 'overload' && r.outsideGlobal === SRV_FAR)).toBe(true);
    expect(natRows(sim).length).toBeGreaterThanOrEqual(6);
    expect(ofKind(evs, 'drop').filter((d) => d.device === 'r1' && d.reason !== 'ttl-expired')).toEqual([]);
  });

  it('udp probes from an inside router: R1, R2 and SRV (its port-unreachable translated back) are matched at the tracing router', () => {
    const sim = natWorld({ r1: [ACL_LINE, PAT_RULE], far: true, inside: [{ id: 'r0', name: 'R0', address: PC1, type: 'router' }] });
    const cursor = sim.trace(0).next;
    const s = start(sim, 'r0', `traceroute ${SRV_FAR}`);
    sim.runToIdle();
    const evs = sim.trace(cursor).events;
    const text = output(evs, s);
    expect(hops(text)).toEqual([[1, R1_IN], [2, R2_NEAR], [3, SRV_FAR]]);
    expect(text).toContain(`Reached ${SRV_FAR} in 3 hops`);
    const exceeded = ofKind(evs, 'pduCreated').filter((e) => e.device === 'r2').map((e) => sim.pdu(e.pdu.id)!).filter((p) => p.get('icmpv4.type') === ICMP_TIME_EXCEEDED);
    const unreachable = ofKind(evs, 'pduCreated').filter((e) => e.device === 'srv').map((e) => sim.pdu(e.pdu.id)!).filter((p) => p.get('icmpv4.type') === ICMP_DEST_UNREACHABLE);
    expect(exceeded).toHaveLength(3);
    expect(unreachable).toHaveLength(3);
    for (const p of [...exceeded, ...unreachable]) {
      expect(nats(p).slice(0, 2)).toEqual([
        ['ipv4.dst', R1_OUT, PC1],
        ['ipv4[3].src', R1_OUT, PC1],
      ]);
      expect(p.get('udp[4].dstPort')).toBeGreaterThanOrEqual(TRACEROUTE_BASE_PORT);
      expect(p.get('ipv4.checksumValid')).toBe(true);
      expect(p.get('icmpv4.checksumValid')).toBe(true);
    }
    // the probe rows: udp overload rows to SRV, one per probe port of hops 2 and 3 (hop 1's probes expired at R1 before NAT)
    const rows = natRows(sim);
    expect(rows.every((r) => r.proto === 'udp' && r.kind === 'overload' && r.insideLocal === PC1 && r.outsideGlobal === SRV_FAR)).toBe(true);
    expect(rows).toHaveLength(6);
    expect(rows.map((r) => r.outsideGlobalPort)).toEqual([33437, 33438, 33439, 33440, 33441, 33442]);
  });
});
