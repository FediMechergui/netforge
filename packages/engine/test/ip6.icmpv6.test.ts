/**
 * ip6.icmpv6 — the ICMPv6 daemon (protocols/icmpv6.ts) against RFC 4443 semantics, on real device runtimes
 * (test/ip6.harness.ts): the echo responder, `ping -6` jobs (§4.6), error generation and its suppression rules
 * (RFC 4443 §2.4 e), traceroute probes (§4.7) and the error fan-back to UDP (§4.2).
 */
import { describe, expect, it } from 'vitest';
import {
  ICMPV6_DEST_UNREACHABLE,
  ICMPV6_ECHO_REPLY,
  ICMPV6_ECHO_REQUEST,
  ICMPV6_PARAM_PROBLEM,
  ICMPV6_TIME_EXCEEDED,
} from '../src/contracts/pdu.js';
import type { ProbeResultEvent } from '../src/contracts/transport.js';
import { MS, SEC } from '../src/contracts/time.js';
import { eui64Address, linkLocalFromMac } from '../src/core/addr6.js';
import { ICMPV6_ECHO_OVERHEAD, ICMPV6_MAX_QUOTE } from '../src/protocols/icmpv6.js';
import { BOOT_NS, createWorld6, icmp6Of, ofIcmp6Type, recorder, type Recorder, type World6 } from './ip6.harness.js';

const PC = 'GigabitEthernet0';
const G0 = 'GigabitEthernet0/0';
const G1 = 'GigabitEthernet0/1';

function mac(w: World6, dev: string, port: string): string {
  return w.dev(dev).port(port)!.mac;
}
function slaacOf(w: World6, dev: string, prefix: string): string {
  return eui64Address(prefix, 64, mac(w, dev, PC))!;
}

/** PC1 (2001:db8:1::/64) — R1 (routing) — PC2 (2001:db8:2::/64), both hosts by SLAAC. */
function lan(extra: Record<string, () => Recorder> = {}): World6 {
  const w = createWorld6({ seed: 4, extra });
  w.add('pc1', 'pc');
  w.add('r1', 'router');
  w.add('pc2', 'pc');
  w.link({ device: 'pc1', port: PC }, { device: 'r1', port: G0 });
  w.link({ device: 'r1', port: G1 }, { device: 'pc2', port: PC });
  w.runFor(BOOT_NS);
  w.global('r1', 'ipv6 unicast-routing');
  w.iface('r1', G0, 'ipv6 address 2001:db8:1::1/64', 'no shutdown');
  w.iface('r1', G1, 'ipv6 address 2001:db8:2::1/64', 'no shutdown');
  w.iface('pc1', PC, 'ipv6 address autoconfig');
  w.iface('pc2', PC, 'ipv6 address autoconfig');
  w.runFor(6 * SEC);
  return w;
}

describe('ip6.icmpv6 ping -6 (§4.6)', () => {
  it('pings across the router 5/5 with hop limit 64→63 at the router, then prints the statistics', () => {
    const w = lan();
    const target = slaacOf(w, 'pc2', '2001:db8:2::');
    w.request('pc1', 'icmpv6', { kind: 'icmp6.ping', session: 'p', target, count: 5, timeoutNs: 2 * SEC, sizeBytes: 100 });
    w.runFor(5 * SEC);
    const text = w.output('p');
    expect(text.startsWith(`Sending 5 echo requests to ${target}, 100-byte packets, timeout 2 s:\n!!!!!`)).toBe(true);
    expect(text).toContain('Sent 5, received 5, lost 0 (0% loss), round-trip min/avg/max = ');
    expect(w.done.map((d) => d.session)).toEqual(['p']);
    const req = w.sentBy('pc1').find((p) => icmp6Of(p)?.type === ICMPV6_ECHO_REQUEST)!;
    // (sent frames are live objects: the router's decrement shows on them, so the original hop limit is read from the mutation)
    expect(req.layer('ipv6')!.fields).toMatchObject({ src: slaacOf(w, 'pc1', '2001:db8:1::'), dst: target, nextHeader: 58, payloadLength: 100 - 40 });
    expect(req.meta.flow).toBe(`ipv6:[${slaacOf(w, 'pc1', '2001:db8:1::')}]>[${target}]:icmpv6`);
    const hop = w.kinds('mutation').find((m) => m.pdu === req.id && m.mutation.field === 'ipv6.hopLimit')!;
    expect(hop.mutation).toMatchObject({ device: 'r1', before: 64, after: 63, reason: 'TtlDecrement', cause: `connected via ${G1}` });
  });

  it('answers an echo request with the same id, seq and data, swapped addresses, a valid checksum and triggeredBy', () => {
    const w = lan();
    const target = slaacOf(w, 'pc2', '2001:db8:2::');
    w.request('pc1', 'icmpv6', { kind: 'icmp6.ping', session: 'e', target, count: 1, timeoutNs: 2 * SEC, sizeBytes: 64 });
    w.runFor(SEC);
    const req = w.sentBy('pc1').find((p) => icmp6Of(p)?.type === ICMPV6_ECHO_REQUEST)!;
    const rep = w.sentBy('pc2').find((p) => icmp6Of(p)?.type === ICMPV6_ECHO_REPLY)!;
    expect(rep.meta.triggeredBy).toBe(req.id);
    expect(rep.meta.tag).toBe('echo6-reply');
    expect(rep.layer('ipv6')!.fields).toMatchObject({ src: target, dst: slaacOf(w, 'pc1', '2001:db8:1::') });
    expect(w.kinds('mutation').find((m) => m.pdu === rep.id && m.mutation.field === 'ipv6.hopLimit')!.mutation).toMatchObject({ before: 64, after: 63 });
    expect(icmp6Of(rep)).toMatchObject({ id: icmp6Of(req)!.id, seq: icmp6Of(req)!.seq, code: 0, checksumValid: true });
    expect(rep.layer('payload')!.fields.data).toEqual(req.layer('payload')!.fields.data);
    expect((req.layer('payload')!.fields.data as Uint8Array).length).toBe(64 - ICMPV6_ECHO_OVERHEAD);
  });

  it('answers a multicast echo to ff02::1 from the link-local of the ingress port', () => {
    const w = lan();
    w.request('r1', 'icmpv6', { kind: 'icmp6.ping', session: 'mc', target: 'ff02::1', count: 1, timeoutNs: 2 * SEC, sizeBytes: 100 });
    w.runFor(SEC);
    const req = w.sentBy('r1').find((p) => icmp6Of(p)?.type === ICMPV6_ECHO_REQUEST)!;
    expect(req.layer('ipv6')!.fields).toMatchObject({ src: linkLocalFromMac(mac(w, 'r1', G0)), dst: 'ff02::1' });
    expect(req.layer('ethernet')!.fields.dst).toBe('33:33:00:00:00:01');
    const rep = w.sentBy('pc1').find((p) => icmp6Of(p)?.type === ICMPV6_ECHO_REPLY)!;
    expect(rep.layer('ipv6')!.fields).toMatchObject({ src: linkLocalFromMac(mac(w, 'pc1', PC)), dst: linkLocalFromMac(mac(w, 'r1', G0)) });
    expect(w.output('mc')).toContain('!');
  });

  it('prints the no-route line when no source exists, marks T and U for errors, and job.abort ends the job', () => {
    const w = createWorld6();
    w.add('pc1', 'pc');
    w.runFor(BOOT_NS);
    w.request('pc1', 'icmpv6', { kind: 'icmp6.ping', session: 'n', target: '2001:db8:9::1', count: 5, timeoutNs: 2 * SEC, sizeBytes: 100 });
    expect(w.output('n')).toBe('No IPv6 route to 2001:db8:9::1 from this device.\n');
    expect(w.done.map((d) => d.session)).toEqual(['n']);

    const v = lan();
    const target = slaacOf(v, 'pc2', '2001:db8:2::');
    v.request('pc1', 'icmpv6', { kind: 'icmp6.ping', session: 't', target, count: 2, timeoutNs: 2 * SEC, sizeBytes: 100, hopLimit: 1 });
    v.runFor(SEC);
    expect(v.output('t')).toMatch(/:\nTT\nSent 2, received 0, lost 2 \(100% loss\)\n$/);
    v.request('pc1', 'icmpv6', { kind: 'icmp6.ping', session: 'u', target: '2001:db8:99::1', count: 1, timeoutNs: 2 * SEC, sizeBytes: 100 });
    v.runFor(SEC);
    expect(v.output('u')).toContain(':\nU\n');
    // a silent on-link target (resolution fails, no error for own packets): timeouts print '.', abort prints the statistics so far
    v.request('pc1', 'icmpv6', { kind: 'icmp6.ping', session: 'a', target: '2001:db8:1::77', count: 100, timeoutNs: 2 * SEC, sizeBytes: 100 });
    v.runFor(5 * SEC);
    v.request('pc1', 'icmpv6', { kind: 'job.abort', session: 'a' });
    const out = v.output('a');
    expect(out).toContain('..');
    expect(out).toMatch(/Sent 3, received 0, lost 3 \(100% loss\)\n$/);
    expect(v.done.some((d) => d.session === 'a')).toBe(true);
    expect(v.dev('pc1').processes.get('icmpv6')!.stateSnapshot().state).toMatchObject({ jobs: [] });
  });
});

describe('ip6.icmpv6 errors (RFC 4443 §2.4)', () => {
  it('quotes the invoking packet, as much as fits in 1280 bytes', () => {
    const w = lan();
    const target = slaacOf(w, 'pc2', '2001:db8:2::');
    w.request('pc1', 'icmpv6', { kind: 'icmp6.ping', session: 'q', target, count: 1, timeoutNs: 2 * SEC, sizeBytes: 1500, hopLimit: 1 });
    w.runFor(SEC);
    const err = w.sentBy('r1').find((p) => icmp6Of(p)?.type === ICMPV6_TIME_EXCEEDED)!;
    const outer = err.layer('ipv6')!;
    expect(outer.length).toBe(1280);
    expect(outer.fields.payloadLength).toBe(8 + ICMPV6_MAX_QUOTE);
    expect(err.meta.tag).toBe('icmp6-time-exceeded');
    expect(icmp6Of(err)).toMatchObject({ code: 0, checksumValid: true });
  });

  it('never answers an error, a multicast destination, a link-layer group frame or the unspecified source', () => {
    const w = lan();
    const src = slaacOf(w, 'pc1', '2001:db8:1::');
    const created = (): number => w.kinds('pduCreated').filter((e) => e.device === 'r1' && e.process === 'icmpv6').length;
    const base = created();
    const errorPdu = w.build([
      { proto: 'ipv6', fields: { src, dst: '2001:db8:2::9', nextHeader: 58, hopLimit: 64 } },
      { proto: 'icmpv6', fields: { type: ICMPV6_DEST_UNREACHABLE, code: 0 } },
      { proto: 'payload', fields: { data: new Uint8Array(48) } },
    ]);
    const multicast = w.build([
      { proto: 'ipv6', fields: { src, dst: 'ff0e::5', nextHeader: 59, hopLimit: 64 } },
    ]);
    const groupFrame = w.build([
      { proto: 'ethernet', fields: { dst: 'ff:ff:ff:ff:ff:ff', src: mac(w, 'pc1', PC), type: 0x86dd } },
      { proto: 'ipv6', fields: { src, dst: '2001:db8:2::9', nextHeader: 59, hopLimit: 64 } },
    ]);
    const unspecified = w.build([{ proto: 'ipv6', fields: { src: '::', dst: '2001:db8:2::9', nextHeader: 59, hopLimit: 64 } }]);
    for (const original of [errorPdu, multicast, groupFrame, unspecified]) {
      w.request('r1', 'icmpv6', { kind: 'icmp6.error', original, type: ICMPV6_DEST_UNREACHABLE, code: 0, inPort: G0 });
    }
    expect(created()).toBe(base);
    expect(w.dev('r1').processes.get('icmpv6')!.stateSnapshot().state).toMatchObject({ errorsSuppressed: 4 });
    // parameter problem code 2 and packet too big are allowed for multicast destinations
    w.request('r1', 'icmpv6', { kind: 'icmp6.error', original: multicast, type: ICMPV6_PARAM_PROBLEM, code: 2, param: 40, inPort: G0 });
    w.runFor(100 * MS);
    expect(created()).toBe(base + 1);
    const pp = ofIcmp6Type(w.sentBy('r1', G0), ICMPV6_PARAM_PROBLEM);
    expect(icmp6Of(pp[pp.length - 1]!)).toMatchObject({ code: 2, pointer: 40 });
  });

  it('delivers an error quoting UDP to the udp daemon (fan-back, §4.2)', () => {
    const udp = recorder('udp');
    const w = lan({ udp: () => udp });
    const src = slaacOf(w, 'pc1', '2001:db8:1::');
    const probe = w.build([
      { proto: 'ipv6', fields: { src, dst: slaacOf(w, 'pc2', '2001:db8:2::'), nextHeader: 17, hopLimit: 1 } },
      { proto: 'udp', fields: { srcPort: 50000, dstPort: 33434 } },
      { proto: 'payload', fields: { data: new Uint8Array(12) } },
    ]);
    w.act('pc1', 'udp', [{ type: 'request', to: 'ipv6', req: { kind: 'ipv6.send', pdu: probe } }]);
    w.runFor(SEC);
    const got = udp.pdus.filter((p) => icmp6Of(p)?.type === ICMPV6_TIME_EXCEEDED);
    expect(got).toHaveLength(1);
    const quotedUdp = got[0]!.layers.filter((l) => l.proto === 'udp');
    expect(quotedUdp[0]!.fields).toMatchObject({ srcPort: 50000, dstPort: 33434 });
  });
});

describe('ip6.icmpv6 probes (traceroute ICMP mode over IPv6, §4.7)', () => {
  it('reports ttl-exceeded from the router, the reply from the target, unreachable, no-route, and timeout', () => {
    const tr = recorder('traceroute');
    const w = lan({ traceroute: () => tr });
    const target = slaacOf(w, 'pc2', '2001:db8:2::');
    const t0 = w.now();
    w.request('pc1', 'icmpv6', { kind: 'icmp6.probe', owner: 'traceroute', token: 's1:1:0', target, hopLimit: 1, timeoutNs: 3 * SEC });
    w.request('pc1', 'icmpv6', { kind: 'icmp6.probe', owner: 'traceroute', token: 's1:2:0', target, hopLimit: 2, timeoutNs: 3 * SEC });
    w.request('pc1', 'icmpv6', { kind: 'icmp6.probe', owner: 'traceroute', token: 's1:3:0', target: '2001:db8:99::1', hopLimit: 5, timeoutNs: 3 * SEC });
    w.request('pc1', 'icmpv6', { kind: 'icmp6.probe', owner: 'traceroute', token: 's1:4:0', target: '2001:db8:2::77', hopLimit: 5, timeoutNs: 5 * SEC });
    w.request('pc1', 'icmpv6', { kind: 'icmp6.probe', owner: 'traceroute', token: 's1:5:0', target: '2001:db8:1::77', hopLimit: 5, timeoutNs: 2 * SEC });
    w.runFor(6 * SEC);
    const byToken = new Map((tr.evs as ProbeResultEvent[]).map((e) => [e.token, e]));
    expect(byToken.get('s1:1:0')).toMatchObject({ kind: 'icmp.result', outcome: 'ttl-exceeded', from: '2001:db8:1::1', type: 3, code: 0, sentAt: t0 });
    expect(byToken.get('s1:2:0')).toMatchObject({ outcome: 'reply', from: target, type: ICMPV6_ECHO_REPLY });
    expect(byToken.get('s1:3:0')).toMatchObject({ outcome: 'unreachable', from: '2001:db8:1::1', type: 1, code: 0 });
    // an unresolvable host behind the router: address unreachable (code 3) after the router's 3 s of solicitations
    expect(byToken.get('s1:4:0')).toMatchObject({ outcome: 'unreachable', from: '2001:db8:2::1', type: 1, code: 3 });
    // an unresolvable on-link address: no answer at all; the probe timer reports a timeout and forgets it
    expect(byToken.get('s1:5:0')).toMatchObject({ kind: 'icmp.result', outcome: 'timeout', sentAt: t0 });
    expect(byToken.get('s1:5:0')!.from).toBeUndefined();
    expect(w.dev('pc1').processes.get('icmpv6')!.stateSnapshot().state).toMatchObject({ probes: [] });

    const lone = createWorld6({ extra: { traceroute: () => tr } });
    lone.add('pc9', 'pc');
    lone.runFor(BOOT_NS);
    lone.request('pc9', 'icmpv6', { kind: 'icmp6.probe', owner: 'traceroute', token: 'x', target: '2001:db8::1', hopLimit: 1, timeoutNs: SEC });
    expect((tr.evs as ProbeResultEvent[]).find((e) => e.token === 'x')).toMatchObject({ outcome: 'no-route' });
  });
});
