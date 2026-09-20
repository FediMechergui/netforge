import { describe, expect, it } from 'vitest';
import { ICMP_DEST_UNREACHABLE, ICMP_ECHO_REPLY, ICMP_ECHO_REQUEST, ICMP_TIME_EXCEEDED, IPPROTO_ICMP } from '../src/contracts/pdu.js';
import type { LayerSpec, Pdu } from '../src/contracts/pdu.js';
import type { RouteRow } from '../src/contracts/tables.js';
import { MS, SEC } from '../src/contracts/time.js';
import { createIcmpv4 } from '../src/protocols/icmpv4.js';
import { createIpv4 } from '../src/protocols/ipv4.js';
import { echoRequest, framed, makeFake, makeSink } from './ip.fake-ctx.js';

const GI = 'GigabitEthernet0';
const GI0 = 'GigabitEthernet0/0';
const GI1 = 'GigabitEthernet0/1';
const MAC_PC = '00:1f:00:00:00:01';
const MAC_PEER = '00:1f:00:00:00:02';
const S = 's_1';
const T0 = 1_000_000;

const connected = (network: string, prefixLen: number, iface: string): RouteRow => ({ key: `${network}/${prefixLen}`, network, prefixLen, source: 'C', iface, ad: 0, metric: 0, updatedAt: 0 });

/** A PC with 10.0.0.1/24 on GigabitEthernet0, ipv4 + icmpv4 wired together, arp captured. */
function pc() {
  const fake = makeFake({ kind: 'pc', ports: [{ id: GI, mac: MAC_PC, ipv4: { address: '10.0.0.1', prefixLen: 24 } }], now: T0 });
  fake.tables.rib.set(connected('10.0.0.0', 24, GI));
  const icmp = createIcmpv4();
  const ipv4 = createIpv4();
  const arp = makeSink('arp');
  fake.register(icmp);
  fake.register(ipv4);
  fake.register(arp);
  return { fake, icmp, ipv4, arp };
}

const echoReply = (src: string, dst: string, id: number, seq: number, payload = 72): LayerSpec[] => [
  { proto: 'ipv4', fields: { src, dst, protocol: IPPROTO_ICMP, ttl: 128, id: seq } },
  { proto: 'icmpv4', fields: { type: ICMP_ECHO_REPLY, code: 0, id, seq } },
  { proto: 'payload', fields: { data: new Uint8Array(payload) } },
];

/** Wrap an original packet in an ICMP error the way a router would build it (header + 8 bytes). */
function errorFor(fake: ReturnType<typeof pc>['fake'], type: number, from: string, original: Pdu): Pdu {
  const ip = original.layer('ipv4')!;
  const quote = original.bytes.slice(ip.offset, ip.offset + ip.headerLength + 8);
  return fake.build([
    { proto: 'ipv4', fields: { src: from, dst: '10.0.0.1', protocol: IPPROTO_ICMP, ttl: 255 } },
    { proto: 'icmpv4', fields: { type, code: type === ICMP_TIME_EXCEEDED ? 0 : 1, unused: 0 } },
    { proto: 'payload', fields: { data: quote } },
  ]);
}

describe('icmpv4 echo responder', () => {
  it('answers an echo request with a reply: swapped addresses, same id/seq/payload, triggeredBy', () => {
    const { fake, icmp, arp } = pc();
    const req = fake.build(framed(MAC_PC, MAC_PEER, echoRequest('10.0.0.2', '10.0.0.1', 7, 3)), { flow: 'ipv4:10.0.0.2>10.0.0.1:icmp', tag: 'ping#3' });
    const actions = fake.run(icmp.onPdu(fake.ctx, req, GI));
    expect(actions.map((a) => a.type)).toEqual(['consume', 'request']);
    expect(actions[0]).toEqual({ type: 'consume', pdu: req });
    const sendVia = arp.requests[0];
    expect(sendVia).toMatchObject({ kind: 'arp.sendVia', nextHop: '10.0.0.2', iface: GI });
    const reply = (sendVia as { pdu: Pdu }).pdu;
    expect(reply.id).not.toBe(req.id);
    expect(reply.layers.map((l) => l.proto)).toEqual(['ipv4', 'icmpv4', 'payload']);
    expect(reply.get('ipv4.src')).toBe('10.0.0.1');
    expect(reply.get('ipv4.dst')).toBe('10.0.0.2');
    expect(reply.get('ipv4.ttl')).toBe(128);
    expect(reply.get('ipv4.protocol')).toBe(IPPROTO_ICMP);
    expect(reply.get('icmpv4.type')).toBe(ICMP_ECHO_REPLY);
    expect(reply.get('icmpv4.code')).toBe(0);
    expect(reply.get('icmpv4.id')).toBe(7);
    expect(reply.get('icmpv4.seq')).toBe(3);
    expect(reply.get('icmpv4.checksumValid')).toBe(true);
    expect(reply.get('payload.data')).toEqual(req.get('payload.data'));
    expect(reply.meta).toMatchObject({ triggeredBy: req.id, flow: 'ipv4:10.0.0.2>10.0.0.1:icmp', tag: 'echo-reply', origin: 'd_fake', born: T0 });
    expect(reply.summary()).toBe('ICMP echo reply 10.0.0.1 > 10.0.0.2 id=7 seq=3');
    expect(icmp.stateSnapshot().state).toMatchObject({ repliesSent: 1, errorsSent: 0 });
    expect(fake.debug.filter((d) => d.category === 'ip icmp')).toHaveLength(1);
  });

  it('answers a broadcast echo request from the ingress port address and uses router TTL on routers', () => {
    const fake = makeFake({ kind: 'router', ports: [{ id: GI0, mac: MAC_PC, ipv4: { address: '10.0.0.1', prefixLen: 24 } }, { id: GI1, mac: MAC_PEER }], now: T0 });
    fake.tables.rib.set(connected('10.0.0.0', 24, GI0));
    const icmp = createIcmpv4();
    const ipv4 = createIpv4();
    const arp = makeSink('arp');
    fake.register(icmp);
    fake.register(ipv4);
    fake.register(arp);
    const req = fake.build(framed('ff:ff:ff:ff:ff:ff', MAC_PEER, echoRequest('10.0.0.2', '10.0.0.255', 1, 1)));
    fake.run(icmp.onPdu(fake.ctx, req, GI0));
    const reply = (arp.requests[0] as { pdu: Pdu }).pdu;
    expect(reply.get('ipv4.src')).toBe('10.0.0.1');
    expect(reply.get('ipv4.dst')).toBe('10.0.0.2');
    expect(reply.get('ipv4.ttl')).toBe(255);
    expect(reply.meta.flow).toBe('ipv4:10.0.0.2>10.0.0.255:icmp');
  });

  it('drops the request when there is no address to reply from', () => {
    const fake = makeFake({ kind: 'pc', ports: [{ id: GI, mac: MAC_PC }], now: T0 });
    const icmp = createIcmpv4();
    const req = fake.build(framed(MAC_PC, MAC_PEER, echoRequest('10.0.0.2', '255.255.255.255', 1, 1)));
    expect(icmp.onPdu(fake.ctx, req, GI)).toEqual([{ type: 'drop', pdu: req, reason: 'no-l3-address', detail: expect.any(String), port: GI }]);
  });

  it('consumes unmatched replies, bad checksums and unknown types without replying', () => {
    const { fake, icmp, arp } = pc();
    const stray = fake.build(framed(MAC_PC, MAC_PEER, echoReply('10.0.0.2', '10.0.0.1', 99, 1)));
    expect(icmp.onPdu(fake.ctx, stray, GI)).toEqual([{ type: 'consume', pdu: stray }]);
    const odd = fake.build(framed(MAC_PC, MAC_PEER, [{ proto: 'ipv4', fields: { src: '10.0.0.2', dst: '10.0.0.1', protocol: 1, ttl: 64 } }, { proto: 'icmpv4', fields: { type: 13, code: 0, unused: 0 } }]));
    expect(icmp.onPdu(fake.ctx, odd, GI)).toEqual([{ type: 'consume', pdu: odd }]);
    const broken = fake.build(framed(MAC_PC, MAC_PEER, echoRequest('10.0.0.2', '10.0.0.1', 1, 1)));
    broken.corrupt({ now: T0, device: 'd_peer' }, 14 + 20 + 4, 0x80); // flip a bit of the ICMP id
    expect(broken.get('icmpv4.checksumValid')).toBe(false);
    expect(icmp.onPdu(fake.ctx, broken, GI)[0]).toMatchObject({ type: 'drop', reason: 'bad-checksum' });
    expect(arp.requests).toEqual([]);
    expect(fake.debug.filter((d) => d.message.includes('no matching ping job'))).toHaveLength(1);
  });
});

describe('icmpv4 ping job', () => {
  it('prints the header, builds the first request from sourceFor and arms the timeout', () => {
    const { fake, icmp, arp } = pc();
    const actions = fake.run(icmp.onRequest!(fake.ctx, { kind: 'icmp.ping', session: S, target: '10.0.0.2', count: 5, timeoutNs: 2 * SEC, sizeBytes: 100 }));
    expect(actions[0]).toEqual({ type: 'cliOutput', session: S, text: 'Sending 5 echo requests to 10.0.0.2, 100-byte datagrams, timeout 2 s:\n' });
    expect(actions.map((a) => a.type)).toEqual(['cliOutput', 'request', 'timer']);
    expect(actions[2]).toEqual({ type: 'timer', key: `ping-timeout:${S}`, delay: 2 * SEC });
    expect(arp.requests).toHaveLength(1);
    const req = (arp.requests[0] as { pdu: Pdu }).pdu;
    expect(arp.requests[0]).toMatchObject({ kind: 'arp.sendVia', nextHop: '10.0.0.2', iface: GI, cause: 'ping 10.0.0.2' });
    expect(req.layers.map((l) => l.proto)).toEqual(['ipv4', 'icmpv4', 'payload']);
    expect(req.get('ipv4.src')).toBe('10.0.0.1');
    expect(req.get('ipv4.dst')).toBe('10.0.0.2');
    expect(req.get('ipv4.ttl')).toBe(128);
    expect(req.get('ipv4.id')).toBe(1);
    expect(req.get('ipv4.totalLength')).toBe(100);
    expect(req.get('icmpv4.type')).toBe(ICMP_ECHO_REQUEST);
    expect(req.get('icmpv4.id')).toBe(1);
    expect(req.get('icmpv4.seq')).toBe(1);
    const data = req.get('payload.data') as Uint8Array;
    expect(data.length).toBe(72);
    expect(Array.from(data.slice(0, 4))).toEqual([0, 1, 2, 3]);
    expect(req.meta).toMatchObject({ flow: 'ipv4:10.0.0.1>10.0.0.2:icmp', tag: 'ping#1' });
    expect(icmp.stateSnapshot().state).toEqual({ jobs: [{ session: S, target: '10.0.0.2', sent: 1, received: 0, lost: 0, seq: 1 }], repliesSent: 0, errorsSent: 0 });
  });

  it('prints "!" on a matching reply, sends the next echo immediately and finishes with statistics', () => {
    const { fake, icmp, arp } = pc();
    fake.run(icmp.onRequest!(fake.ctx, { kind: 'icmp.ping', session: S, target: '10.0.0.2', count: 2, timeoutNs: 2 * SEC, sizeBytes: 100 }));
    fake.setNow(T0 + Math.round(1.5 * MS));
    const reply1 = fake.build(framed(MAC_PC, MAC_PEER, echoReply('10.0.0.2', '10.0.0.1', 1, 1)));
    const a1 = fake.run(icmp.onPdu(fake.ctx, reply1, GI));
    expect(a1).toEqual([
      { type: 'consume', pdu: reply1 },
      { type: 'cliOutput', session: S, text: '!' },
      { type: 'cancelTimer', key: `ping-timeout:${S}` },
      { type: 'timer', key: `ping:${S}`, delay: 0 },
    ]);
    const a2 = fake.run(icmp.onTimer(fake.ctx, `ping:${S}`));
    expect(a2.map((a) => a.type)).toEqual(['request', 'timer']);
    expect(arp.requests).toHaveLength(2);
    const req2 = (arp.requests[1] as { pdu: Pdu }).pdu;
    expect(req2.get('icmpv4.seq')).toBe(2);
    expect(req2.meta.tag).toBe('ping#2');
    // a stale reply (seq 1 again) no longer matches
    const dup = fake.build(framed(MAC_PC, MAC_PEER, echoReply('10.0.0.2', '10.0.0.1', 1, 1)));
    expect(icmp.onPdu(fake.ctx, dup, GI)).toEqual([{ type: 'consume', pdu: dup }]);

    fake.setNow(T0 + Math.round(1.5 * MS) + Math.round(0.5 * MS));
    const reply2 = fake.build(framed(MAC_PC, MAC_PEER, echoReply('10.0.0.2', '10.0.0.1', 1, 2)));
    const a3 = fake.run(icmp.onPdu(fake.ctx, reply2, GI));
    expect(a3.map((a) => a.type)).toEqual(['consume', 'cliOutput', 'cancelTimer', 'cancelTimer', 'cancelTimer', 'cliOutput', 'cliDone']);
    expect(a3[a3.length - 1]).toEqual({ type: 'cliDone', session: S });
    expect(fake.cliText(S)).toBe(
      'Sending 2 echo requests to 10.0.0.2, 100-byte datagrams, timeout 2 s:\n!!\nSent 2, received 2, lost 0 (0% loss), round-trip min/avg/max = 0.50/1.00/1.50 ms\n',
    );
    expect(icmp.stateSnapshot().state).toMatchObject({ jobs: [] });
    // a late timer for a finished job is ignored
    expect(icmp.onTimer(fake.ctx, `ping-timeout:${S}`)).toEqual([]);
    expect(icmp.onTimer(fake.ctx, `ping:${S}`)).toEqual([]);
  });

  it('prints "." on timeout and "U" on an unreachable error, then reports the losses', () => {
    const { fake, icmp, arp } = pc();
    fake.run(icmp.onRequest!(fake.ctx, { kind: 'icmp.ping', session: S, target: '10.0.0.2', count: 3, timeoutNs: 2 * SEC, sizeBytes: 100 }));
    fake.setNow(T0 + 2 * SEC);
    const t1 = fake.run(icmp.onTimer(fake.ctx, `ping-timeout:${S}`));
    expect(t1.map((a) => a.type)).toEqual(['cliOutput', 'request', 'timer']);
    expect(t1[0]).toEqual({ type: 'cliOutput', session: S, text: '.' });
    expect(arp.requests).toHaveLength(2);

    const req2 = (arp.requests[1] as { pdu: Pdu }).pdu;
    const unreachable = errorFor(fake, ICMP_DEST_UNREACHABLE, '10.0.0.254', req2);
    expect(unreachable.layers.map((l) => l.proto)).toEqual(['ipv4', 'icmpv4', 'ipv4', 'icmpv4', 'payload']);
    const u = fake.run(icmp.onPdu(fake.ctx, unreachable, GI));
    expect(u[0]).toEqual({ type: 'consume', pdu: unreachable });
    expect(u[1]).toEqual({ type: 'cliOutput', session: S, text: 'U' });
    expect(arp.requests).toHaveLength(2);
    fake.run(icmp.onTimer(fake.ctx, `ping:${S}`));
    expect(arp.requests).toHaveLength(3);

    const req3 = (arp.requests[2] as { pdu: Pdu }).pdu;
    const exceeded = errorFor(fake, ICMP_TIME_EXCEEDED, '10.0.0.254', req3);
    const t = fake.run(icmp.onPdu(fake.ctx, exceeded, GI));
    expect(t[1]).toEqual({ type: 'cliOutput', session: S, text: 'T' });
    expect(t[t.length - 1]).toEqual({ type: 'cliDone', session: S });
    expect(fake.cliText(S)).toBe('Sending 3 echo requests to 10.0.0.2, 100-byte datagrams, timeout 2 s:\n.UT\nSent 3, received 0, lost 3 (100% loss)\n');
  });

  it('rounds the loss percentage and prints two-decimal round-trip times from ns', () => {
    const { fake, icmp } = pc();
    fake.run(icmp.onRequest!(fake.ctx, { kind: 'icmp.ping', session: S, target: '10.0.0.2', count: 3, timeoutNs: 2 * SEC, sizeBytes: 100 }));
    fake.setNow(T0 + 1_234_567);
    fake.run(icmp.onPdu(fake.ctx, fake.build(framed(MAC_PC, MAC_PEER, echoReply('10.0.0.2', '10.0.0.1', 1, 1))), GI));
    fake.run(icmp.onTimer(fake.ctx, `ping:${S}`));
    fake.run(icmp.onTimer(fake.ctx, `ping-timeout:${S}`));
    fake.setNow(fake.ctx.now + 987_654);
    fake.run(icmp.onPdu(fake.ctx, fake.build(framed(MAC_PC, MAC_PEER, echoReply('10.0.0.2', '10.0.0.1', 1, 3))), GI));
    expect(fake.cliText(S).split('\n')[2]).toBe('Sent 3, received 2, lost 1 (33% loss), round-trip min/avg/max = 0.99/1.11/1.23 ms');
  });

  it('abort finishes immediately with the statistics so far and counts the outstanding echo as lost', () => {
    const { fake, icmp } = pc();
    fake.run(icmp.onRequest!(fake.ctx, { kind: 'icmp.ping', session: S, target: '10.0.0.2', count: 5, timeoutNs: 2 * SEC, sizeBytes: 100 }));
    fake.setNow(T0 + MS);
    fake.run(icmp.onPdu(fake.ctx, fake.build(framed(MAC_PC, MAC_PEER, echoReply('10.0.0.2', '10.0.0.1', 1, 1))), GI));
    fake.run(icmp.onTimer(fake.ctx, `ping:${S}`));
    const actions = fake.run(icmp.onRequest!(fake.ctx, { kind: 'icmp.abort', session: S }));
    expect(actions.map((a) => a.type)).toEqual(['cancelTimer', 'cancelTimer', 'cliOutput', 'cliDone']);
    expect(fake.cliText(S)).toBe('Sending 5 echo requests to 10.0.0.2, 100-byte datagrams, timeout 2 s:\n!\nSent 2, received 1, lost 1 (50% loss), round-trip min/avg/max = 1.00/1.00/1.00 ms\n');
    expect(icmp.stateSnapshot().state).toMatchObject({ jobs: [] });
    expect(icmp.onRequest!(fake.ctx, { kind: 'icmp.abort', session: S })).toEqual([]);
  });

  it('reports no route when there is no source address for the target', () => {
    const { fake, icmp, arp } = pc();
    const actions = fake.run(icmp.onRequest!(fake.ctx, { kind: 'icmp.ping', session: S, target: '192.0.2.9', count: 5, timeoutNs: 2 * SEC, sizeBytes: 100 }));
    // No echo header: nothing can be sent (review-protocol.regress pins this).
    expect(actions).toEqual([
      { type: 'cliOutput', session: S, text: 'No route to 192.0.2.9 from this device.\n' },
      { type: 'cliDone', session: S },
    ]);
    expect(arp.requests).toEqual([]);
    expect(icmp.stateSnapshot().state).toMatchObject({ jobs: [] });
  });

  it('honours an explicit source, gives each job its own id and pings itself through local delivery', () => {
    const { fake, icmp, arp } = pc();
    fake.run(icmp.onRequest!(fake.ctx, { kind: 'icmp.ping', session: S, target: '10.0.0.2', count: 1, timeoutNs: SEC, sizeBytes: 64, source: '10.0.0.7' }));
    const req = (arp.requests[0] as { pdu: Pdu }).pdu;
    expect(req.get('ipv4.src')).toBe('10.0.0.7');
    expect(req.get('ipv4.totalLength')).toBe(64);
    // second session, second job id; the target is our own address so ipv4 delivers it straight back
    const actions = fake.run(icmp.onRequest!(fake.ctx, { kind: 'icmp.ping', session: 's_2', target: '10.0.0.1', count: 1, timeoutNs: SEC, sizeBytes: 100 }));
    expect(actions.map((a) => a.type)).toEqual(['cliOutput', 'request', 'timer']);
    expect(fake.cliText('s_2')).toBe('Sending 1 echo requests to 10.0.0.1, 100-byte datagrams, timeout 1 s:\n!\nSent 1, received 1, lost 0 (0% loss), round-trip min/avg/max = 0.00/0.00/0.00 ms\n');
    const reqs = fake.actionsOf('request').filter((r) => r.to === 'ipv4');
    expect(reqs).toHaveLength(3); // ping#1 of s_1, ping#1 of s_2, the echo reply
    const ids = fake.actionsOf('request').filter((r) => r.to === 'arp').map((r) => (r.req as { pdu: Pdu }).pdu.get('icmpv4.id'));
    expect(ids).toEqual([1]);
    expect(icmp.stateSnapshot().state).toMatchObject({ repliesSent: 1, jobs: [{ session: S }] });
  });
});

describe('icmpv4 error generation', () => {
  it('quotes the original header plus 8 payload bytes, nests the quoted layers and sends via ipv4', () => {
    const fake = makeFake({ kind: 'router', ports: [{ id: GI0, mac: MAC_PC, ipv4: { address: '10.0.0.1', prefixLen: 24 } }, { id: GI1, mac: MAC_PEER, ipv4: { address: '10.0.1.1', prefixLen: 24 } }], now: T0 });
    fake.tables.rib.set(connected('10.0.0.0', 24, GI0));
    fake.tables.rib.set(connected('10.0.1.0', 24, GI1));
    const icmp = createIcmpv4();
    const ipv4 = createIpv4();
    const arp = makeSink('arp');
    fake.register(icmp);
    fake.register(ipv4);
    fake.register(arp);
    const original = fake.build(framed(MAC_PC, MAC_PEER, echoRequest('10.0.0.2', '10.0.1.2', 5, 9, 1)), { flow: 'ipv4:10.0.0.2>10.0.1.2:icmp', tag: 'ping#9' });
    const actions = fake.run(icmp.onRequest!(fake.ctx, { kind: 'icmp.error', original, type: ICMP_TIME_EXCEEDED, code: 0, inPort: GI0 }));
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({ type: 'request', to: 'ipv4', req: { kind: 'ipv4.send' } });
    expect(arp.requests[0]).toMatchObject({ kind: 'arp.sendVia', nextHop: '10.0.0.2', iface: GI0 });
    const err = (arp.requests[0] as { pdu: Pdu }).pdu;
    expect(err.layers.map((l) => l.proto)).toEqual(['ipv4', 'icmpv4', 'ipv4', 'icmpv4', 'payload']);
    expect(err.get('ipv4.src')).toBe('10.0.0.1');
    expect(err.get('ipv4.dst')).toBe('10.0.0.2');
    expect(err.get('ipv4.ttl')).toBe(255);
    expect(err.get('icmpv4.type')).toBe(ICMP_TIME_EXCEEDED);
    expect(err.get('icmpv4.code')).toBe(0);
    expect(err.get('icmpv4.unused')).toBe(0);
    expect(err.get('icmpv4.checksumValid')).toBe(true);
    const quotedIp = err.layers[2]!;
    const quotedIcmp = err.layers[3]!;
    expect(quotedIp.fields).toMatchObject({ src: '10.0.0.2', dst: '10.0.1.2', ttl: 1, protocol: 1, totalLength: 100 });
    expect(quotedIp.length).toBe(28);
    expect(quotedIcmp.fields).toMatchObject({ type: ICMP_ECHO_REQUEST, id: 5, seq: 9 });
    const ipLayer = original.layer('ipv4')!;
    expect(err.get('icmpv4.type')).toBe(ICMP_TIME_EXCEEDED);
    expect(Array.from(err.bytes.slice(err.layers[1]!.offset + 8, err.layers[1]!.offset + 8 + 28))).toEqual(Array.from(original.bytes.slice(ipLayer.offset, ipLayer.offset + 28)));
    expect(err.meta).toMatchObject({ triggeredBy: original.id, flow: 'ipv4:10.0.0.2>10.0.1.2:icmp', tag: 'ttl-exceeded' });
    expect(err.summary()).toBe('ICMP time exceeded (ttl)');
    expect(icmp.stateSnapshot().state).toMatchObject({ errorsSent: 1 });
  });

  it('falls back to sourceFor when the ingress port has no address, and tags unreachables', () => {
    const fake = makeFake({ kind: 'router', ports: [{ id: GI0, mac: MAC_PC, ipv4: { address: '10.0.0.1', prefixLen: 24 } }, { id: GI1, mac: MAC_PEER }], now: T0 });
    fake.tables.rib.set(connected('10.0.0.0', 24, GI0));
    const icmp = createIcmpv4();
    const original = fake.build(framed(MAC_PEER, MAC_PC, echoRequest('10.0.0.2', '10.0.9.9', 1, 1, 64)));
    const actions = icmp.onRequest!(fake.ctx, { kind: 'icmp.error', original, type: ICMP_DEST_UNREACHABLE, code: 0, inPort: GI1 });
    const err = (actions[0] as { req: { pdu: Pdu } }).req.pdu;
    expect(err.get('ipv4.src')).toBe('10.0.0.1');
    expect(err.get('ipv4.dst')).toBe('10.0.0.2');
    expect(err.meta.tag).toBe('unreachable');
    expect(err.summary()).toBe('ICMP destination unreachable (net)');
  });

  it('never generates errors for broadcast/multicast destinations or in answer to ICMP errors', () => {
    const { fake, icmp } = pc();
    const bcast = fake.build(framed('ff:ff:ff:ff:ff:ff', MAC_PEER, echoRequest('10.0.0.2', '255.255.255.255', 1, 1, 1)));
    expect(icmp.onRequest!(fake.ctx, { kind: 'icmp.error', original: bcast, type: ICMP_TIME_EXCEEDED, code: 0, inPort: GI })).toEqual([]);
    const mcast = fake.build(framed('01:00:5e:00:00:01', MAC_PEER, echoRequest('10.0.0.2', '224.0.0.1', 1, 1, 1)));
    expect(icmp.onRequest!(fake.ctx, { kind: 'icmp.error', original: mcast, type: ICMP_DEST_UNREACHABLE, code: 0 })).toEqual([]);
    const req = fake.build(framed(MAC_PC, MAC_PEER, echoRequest('10.0.0.2', '10.0.0.1', 1, 1)));
    const priorError = errorFor(fake, ICMP_DEST_UNREACHABLE, '10.0.0.2', req);
    expect(icmp.onRequest!(fake.ctx, { kind: 'icmp.error', original: priorError, type: ICMP_TIME_EXCEEDED, code: 0, inPort: GI })).toEqual([]);
    const noSource = makeFake({ kind: 'pc', ports: [{ id: GI, mac: MAC_PC }], now: T0 });
    expect(icmp.onRequest!(noSource.ctx, { kind: 'icmp.error', original: req, type: ICMP_TIME_EXCEEDED, code: 0, inPort: GI })).toEqual([]);
    expect(icmp.stateSnapshot().state).toMatchObject({ errorsSent: 0 });
    expect(fake.debug.filter((d) => d.message.startsWith('suppressed'))).toHaveLength(3);
  });
});

describe('icmpv4 process shape', () => {
  it('has no wire selector, ignores config and foreign timers, and keeps a debug ring', () => {
    const icmp = createIcmpv4();
    expect(icmp.name).toBe('icmpv4');
    expect(icmp.handles).toBeUndefined();
    const { fake } = pc();
    expect(icmp.onConfig(fake.ctx, { op: 'set', context: [], line: ['hostname', 'X'] })).toEqual([]);
    expect(icmp.onTimer(fake.ctx, 'something-else')).toEqual([]);
    expect(icmp.onTimer(fake.ctx, 'ping:nobody')).toEqual([]);
    expect(icmp.onRequest!(fake.ctx, { kind: 'ext.whatever' })).toEqual([]);
    expect(icmp.stateSnapshot()).toEqual({ process: 'icmpv4', state: { jobs: [], repliesSent: 0, errorsSent: 0 } });
    expect(icmp.debugEvents()).toEqual([]);
    fake.run(icmp.onRequest!(fake.ctx, { kind: 'icmp.ping', session: S, target: '10.0.0.2', count: 1, timeoutNs: SEC, sizeBytes: 100 }));
    const ev = icmp.debugEvents();
    expect(ev.length).toBeGreaterThan(0);
    expect(ev[0]).toMatchObject({ process: 'icmpv4', category: 'ip icmp', device: 'd_fake' });
    const plain = fake.build(framed(MAC_PC, MAC_PEER, [{ proto: 'ipv4', fields: { src: '10.0.0.2', dst: '10.0.0.1', protocol: 17, ttl: 64 } }, { proto: 'payload', fields: { data: new Uint8Array(4) } }]));
    expect(icmp.onPdu(fake.ctx, plain, GI)[0]).toMatchObject({ type: 'drop', reason: 'unsupported-protocol' });
  });
});
