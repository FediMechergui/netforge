/**
 * icmpv4 — P1 additions (ARCHITECTURE-P1 §4.2 ICMP fan-back, §4.7 traceroute ICMP mode): `icmp.probe` results,
 * the `ttl` of ping jobs, errors dispatched on the quoted datagram (RFC 792: the quote is the original IP header plus
 * 8 bytes, enough for the UDP/TCP ports) and the source of locally generated unreachables (RFC 1122 §3.2.2).
 */
import { describe, expect, it } from 'vitest';
import { ICMP_DEST_UNREACHABLE, ICMP_ECHO_REPLY, ICMP_TIME_EXCEEDED, IPPROTO_ICMP } from '../src/contracts/pdu.js';
import type { LayerSpec, Pdu } from '../src/contracts/pdu.js';
import type { Action } from '../src/contracts/process.js';
import type { RouteRow } from '../src/contracts/tables.js';
import { SEC } from '../src/contracts/time.js';
import type { ProbeResultEvent } from '../src/contracts/transport.js';
import { TRACEROUTE_TIMEOUT_NS } from '../src/contracts/services.js';
import { ICMP_PROBE_DEFAULT_SIZE, createIcmpv4 } from '../src/protocols/icmpv4.js';
import { createIpv4 } from '../src/protocols/ipv4.js';
import { framed, makeFake, makeSink } from './ip.fake-ctx.js';

const GI = 'GigabitEthernet0';
const MAC_PC = '00:1f:00:00:00:01';
const MAC_GW = '00:1f:00:00:00:10';
const T0 = 1_000_000;

const route = (network: string, prefixLen: number, extra: Partial<RouteRow>): RouteRow => ({
  key: `${network}/${prefixLen}`, network, prefixLen, source: 'C', ad: 0, metric: 0, updatedAt: 0, ...extra,
});

/** A PC 10.0.0.1/24 with a default route via 10.0.0.254; `stage` P1 adds the udp/tcp daemons to the model. */
function pc(stage: 'P0.5' | 'P1' = 'P1') {
  const fake = makeFake({ kind: 'pc', stage, ports: [{ id: GI, mac: MAC_PC, ipv4: { address: '10.0.0.1', prefixLen: 24 } }], now: T0 });
  fake.tables.rib.set(route('10.0.0.0', 24, { iface: GI }));
  fake.tables.rib.set(route('0.0.0.0', 0, { source: 'S', ad: 1, nextHop: '10.0.0.254', isDefault: true }));
  const icmp = createIcmpv4();
  const ipv4 = createIpv4();
  const arp = makeSink('arp');
  const traceroute = makeSink('traceroute');
  const udp = makeSink('udp');
  const tcp = makeSink('tcp');
  for (const p of [icmp, ipv4, arp, traceroute, udp, tcp]) fake.register(p);
  return { fake, icmp, ipv4, arp, udp, tcp };
}

/** Packets handed to arp (what left the device), in order. */
const sentPdus = (arp: ReturnType<typeof makeSink>): Pdu[] => arp.requests.flatMap((r) => (r.kind === 'arp.sendVia' ? [r.pdu] : []));
const results = (actions: Action[]): ProbeResultEvent[] =>
  actions.flatMap((a) => (a.type === 'event' && a.ev.kind === 'icmp.result' ? [a.ev as ProbeResultEvent] : []));

/** An ICMP error from `from` quoting `original` (header + 8 bytes), as a router builds it, framed for the PC. */
function errorFor(fake: ReturnType<typeof pc>['fake'], type: number, code: number, from: string, original: Pdu): Pdu {
  const ip = original.layer('ipv4')!;
  const quote = original.bytes.slice(ip.offset, ip.offset + ip.headerLength + 8);
  return fake.build(framed(MAC_PC, MAC_GW, [
    { proto: 'ipv4', fields: { src: from, dst: '10.0.0.1', protocol: IPPROTO_ICMP, ttl: 255 } },
    { proto: 'icmpv4', fields: { type, code, unused: 0 } },
    { proto: 'payload', fields: { data: quote } },
  ]));
}

describe('icmp.probe (traceroute ICMP mode)', () => {
  it('sends one echo request with the given TTL and reports ttl-exceeded, then a reply, to the owner', () => {
    const { fake, icmp, arp } = pc();
    const out = fake.run(icmp.onRequest!(fake.ctx, { kind: 'icmp.probe', owner: 'traceroute', token: 's_1:1:0', target: '192.0.2.9', ttl: 1, timeoutNs: TRACEROUTE_TIMEOUT_NS }));
    expect(out.map((a) => a.type)).toEqual(['request', 'timer']);
    expect(out[1]).toEqual({ type: 'timer', key: 'probe:s_1:1:0', delay: TRACEROUTE_TIMEOUT_NS });
    const [probe] = sentPdus(arp);
    expect(probe!.get('ipv4.ttl')).toBe(1);
    expect(probe!.get('ipv4.src')).toBe('10.0.0.1');
    expect(probe!.get('ipv4.dst')).toBe('192.0.2.9');
    expect(probe!.get('icmpv4.type')).toBe(8);
    expect(probe!.get('ipv4.totalLength')).toBe(ICMP_PROBE_DEFAULT_SIZE);
    expect(probe!.meta.tag).toBe('icmp-probe');
    expect(icmp.stateSnapshot().state.probes).toEqual([{ token: 's_1:1:0', owner: 'traceroute', target: '192.0.2.9', ttl: 1 }]);

    fake.setNow(T0 + 3_000_000);
    const err = errorFor(fake, ICMP_TIME_EXCEEDED, 0, '10.0.0.254', probe!);
    const r1 = fake.run(icmp.onPdu(fake.ctx, err, GI));
    expect(r1[0]).toEqual({ type: 'consume', pdu: err });
    expect(results(r1)).toEqual([{ kind: 'icmp.result', token: 's_1:1:0', outcome: 'ttl-exceeded', sentAt: T0, from: '10.0.0.254', type: ICMP_TIME_EXCEEDED, code: 0, pdu: err }]);
    expect(r1).toContainEqual({ type: 'cancelTimer', key: 'probe:s_1:1:0' });
    expect(icmp.stateSnapshot().state.probes).toBeUndefined();

    // hop 2 reaches the target: echo reply
    fake.run(icmp.onRequest!(fake.ctx, { kind: 'icmp.probe', owner: 'traceroute', token: 's_1:2:0', target: '192.0.2.9', ttl: 2, timeoutNs: TRACEROUTE_TIMEOUT_NS }));
    const second = sentPdus(arp)[1]!;
    expect(second.get('icmpv4.id')).not.toBe(probe!.get('icmpv4.id'));
    const reply = fake.build(framed(MAC_PC, MAC_GW, [
      { proto: 'ipv4', fields: { src: '192.0.2.9', dst: '10.0.0.1', protocol: IPPROTO_ICMP, ttl: 62 } },
      { proto: 'icmpv4', fields: { type: ICMP_ECHO_REPLY, code: 0, id: second.get('icmpv4.id') as number, seq: second.get('icmpv4.seq') as number } },
      { proto: 'payload', fields: { data: new Uint8Array(32) } },
    ]));
    const r2 = fake.run(icmp.onPdu(fake.ctx, reply, GI));
    expect(results(r2)).toEqual([{ kind: 'icmp.result', token: 's_1:2:0', outcome: 'reply', sentAt: T0 + 3_000_000, from: '192.0.2.9', type: ICMP_ECHO_REPLY, code: 0, pdu: reply }]);
  });

  it('reports unreachable, timeout and no-route', () => {
    const { fake, icmp, arp } = pc();
    fake.run(icmp.onRequest!(fake.ctx, { kind: 'icmp.probe', owner: 'traceroute', token: 'a', target: '192.0.2.9', ttl: 5, timeoutNs: TRACEROUTE_TIMEOUT_NS }));
    const err = errorFor(fake, ICMP_DEST_UNREACHABLE, 1, '10.0.0.254', sentPdus(arp)[0]!);
    expect(results(fake.run(icmp.onPdu(fake.ctx, err, GI)))[0]).toMatchObject({ token: 'a', outcome: 'unreachable', type: 3, code: 1, from: '10.0.0.254' });

    fake.run(icmp.onRequest!(fake.ctx, { kind: 'icmp.probe', owner: 'traceroute', token: 'b', target: '192.0.2.9', ttl: 5, timeoutNs: TRACEROUTE_TIMEOUT_NS }));
    fake.setNow(T0 + TRACEROUTE_TIMEOUT_NS);
    const t = fake.run(icmp.onTimer(fake.ctx, 'probe:b'));
    expect(results(t)).toEqual([{ kind: 'icmp.result', token: 'b', outcome: 'timeout', sentAt: T0 }]);
    expect(fake.run(icmp.onTimer(fake.ctx, 'probe:b'))).toEqual([]);

    fake.tables.rib.delete('0.0.0.0/0');
    const nr = fake.run(icmp.onRequest!(fake.ctx, { kind: 'icmp.probe', owner: 'traceroute', token: 'c', target: '192.0.2.9', ttl: 5, timeoutNs: TRACEROUTE_TIMEOUT_NS }));
    expect(nr).toEqual([{ type: 'event', to: 'traceroute', ev: { kind: 'icmp.result', token: 'c', outcome: 'no-route', sentAt: T0 + TRACEROUTE_TIMEOUT_NS } }]);
  });

  it('a ping job and a probe never share an echo identifier', () => {
    const { fake, icmp, arp } = pc();
    fake.run(icmp.onRequest!(fake.ctx, { kind: 'icmp.ping', session: 's_1', target: '10.0.0.2', count: 1, timeoutNs: 2 * SEC, sizeBytes: 100 }));
    fake.run(icmp.onRequest!(fake.ctx, { kind: 'icmp.probe', owner: 'traceroute', token: 'p', target: '10.0.0.2', ttl: 1, timeoutNs: SEC }));
    const [ping, probe] = sentPdus(arp);
    expect(ping!.get('icmpv4.id')).toBe(1);
    expect(probe!.get('icmpv4.id')).toBe(2);
  });
});

describe('icmp.ping ttl (@since P1)', () => {
  it('sets the TTL of the echo requests when given, else the originated default', () => {
    const { fake, icmp, arp } = pc();
    fake.run(icmp.onRequest!(fake.ctx, { kind: 'icmp.ping', session: 's_1', target: '10.0.0.2', count: 1, timeoutNs: 2 * SEC, sizeBytes: 100, ttl: 3 }));
    fake.run(icmp.onRequest!(fake.ctx, { kind: 'icmp.ping', session: 's_2', target: '10.0.0.2', count: 1, timeoutNs: 2 * SEC, sizeBytes: 100 }));
    expect(sentPdus(arp).map((p) => p.get('ipv4.ttl'))).toEqual([3, 128]);
  });
});

describe('ICMP error fan-back on the quoted datagram (§4.2)', () => {
  /** A UDP datagram the PC sent (e.g. a traceroute probe or a DNS query). */
  function udpOriginal(fake: ReturnType<typeof pc>['fake'], dstPort: number): Pdu {
    const layers: LayerSpec[] = [
      { proto: 'ipv4', fields: { src: '10.0.0.1', dst: '192.0.2.9', protocol: 17, ttl: 1 } },
      { proto: 'udp', fields: { srcPort: 49200, dstPort } },
      { proto: 'payload', fields: { data: new Uint8Array(12) } },
    ];
    return fake.ctx.newPdu(layers);
  }

  it('delivers an error quoting UDP to the udp daemon and one quoting TCP to tcp (quoted ports intact)', () => {
    const { fake, icmp, udp, tcp } = pc('P1');
    const original = udpOriginal(fake, 33434);
    const err = errorFor(fake, ICMP_TIME_EXCEEDED, 0, '10.0.0.254', original);
    // the quote decodes as nested ipv4 → udp, so udp can read the quoted destination port and TTL
    expect(err.layers.map((l) => l.proto)).toEqual(['ethernet', 'ipv4', 'icmpv4', 'ipv4', 'udp']);
    const out = fake.run(icmp.onPdu(fake.ctx, err, GI));
    expect(out).toEqual([{ type: 'deliver', to: 'udp', pdu: err, port: GI }]);
    expect(udp.pdus).toEqual([err]);
    expect(err.layers[4]!.fields.dstPort).toBe(33434);

    const tcpOriginal = fake.ctx.newPdu([
      { proto: 'ipv4', fields: { src: '10.0.0.1', dst: '192.0.2.9', protocol: 6, ttl: 64 } },
      { proto: 'tcp', fields: { srcPort: 49300, dstPort: 80, seq: 7, ack: 0, flags: 'S', window: 65535 } },
    ]);
    const unreachable = errorFor(fake, ICMP_DEST_UNREACHABLE, 3, '192.0.2.9', tcpOriginal);
    expect(fake.run(icmp.onPdu(fake.ctx, unreachable, GI))).toEqual([{ type: 'deliver', to: 'tcp', pdu: unreachable, port: GI }]);
    expect(tcp.pdus).toEqual([unreachable]);
  });

  it('consumes an error about UDP when the device runs no udp daemon', () => {
    const { fake, icmp, udp } = pc('P0.5');
    const err = errorFor(fake, ICMP_DEST_UNREACHABLE, 3, '192.0.2.9', udpOriginal(fake, 53));
    expect(fake.run(icmp.onPdu(fake.ctx, err, GI))).toEqual([{ type: 'consume', pdu: err }]);
    expect(udp.pdus).toEqual([]);
  });

  it('a locally generated port/protocol unreachable is sourced from the address the original was sent to', () => {
    const fake = makeFake({ kind: 'router', stage: 'P1', ports: [
      { id: 'Gi0/0', mac: MAC_GW, ipv4: { address: '10.0.0.254', prefixLen: 24 } },
      { id: 'Gi0/1', mac: '00:1f:00:00:00:11', ipv4: { address: '10.0.1.254', prefixLen: 24 } },
    ], now: T0 });
    fake.tables.rib.set(route('10.0.0.0', 24, { iface: 'Gi0/0' }));
    fake.tables.rib.set(route('10.0.1.0', 24, { iface: 'Gi0/1' }));
    const icmp = createIcmpv4();
    const ipv4 = createIpv4();
    const arp = makeSink('arp');
    for (const p of [icmp, ipv4, arp]) fake.register(p);
    // a datagram from PC 10.0.0.1 to the router's far address 10.0.1.254, received on Gi0/0
    const dgram = fake.build(framed(MAC_GW, MAC_PC, [
      { proto: 'ipv4', fields: { src: '10.0.0.1', dst: '10.0.1.254', protocol: 17, ttl: 64 } },
      { proto: 'udp', fields: { srcPort: 49200, dstPort: 33434 } },
      { proto: 'payload', fields: { data: new Uint8Array(12) } },
    ]));
    fake.run(icmp.onRequest!(fake.ctx, { kind: 'icmp.error', original: dgram, type: ICMP_DEST_UNREACHABLE, code: 3, inPort: 'Gi0/0' }));
    const [err] = sentPdus(arp);
    expect(err!.get('ipv4.src')).toBe('10.0.1.254');
    expect(err!.get('ipv4.dst')).toBe('10.0.0.1');
    expect(err!.get('icmpv4.type')).toBe(3);
    expect(err!.get('icmpv4.code')).toBe(3);
    expect(err!.meta.triggeredBy).toBe(dgram.id);
  });
});
