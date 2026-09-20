/**
 * app.traceroute.test.ts — the traceroute job daemon (protocols/traceroute.ts; ARCHITECTURE-P1 §4.7), end to end on
 * the ip6.harness bus with the real arp/ipv4/icmpv4/ipv6/nd/icmpv6/udp daemons.
 *
 * PC1 192.168.1.2 — (192.168.1.1) R1 (10.0.0.1) — (10.0.0.2) R2 (192.168.2.1) — PC2 192.168.2.2, static routes both
 * ways; the IPv6 chain mirrors it with 2001:db8:1::/64, 2001:db8:12::/64 and 2001:db8:2::/64 (SLAAC on the PCs).
 */
import { describe, expect, it } from 'vitest';
import type { SessionId } from '../src/contracts/ids.js';
import type { Pdu } from '../src/contracts/pdu.js';
import type { Process, ProcessRequest } from '../src/contracts/process.js';
import type { SocketRow } from '../src/contracts/tables.js';
import { MS, SEC } from '../src/contracts/time.js';
import { eui64Address } from '../src/core/addr6.js';
import { createTraceroute } from '../src/protocols/traceroute.js';
import { createUdp } from '../src/protocols/udp.js';
import { BOOT_NS, createWorld6, recorder, type Sent, type World6 } from './ip6.harness.js';

const PC = 'GigabitEthernet0';
const G0 = 'GigabitEthernet0/0';
const G1 = 'GigabitEthernet0/1';
const S: SessionId = 's1';

interface Opts {
  seed?: number;
  lose?: (s: Sent) => boolean;
  extra?: Record<string, () => Process>;
  /** R1's route towards PC2's LAN (default true). */
  r1Route?: boolean;
}

function world(o: Opts): World6 {
  const w = createWorld6({
    seed: o.seed ?? 4,
    delayNs: 1 * MS,
    extra: { udp: createUdp, traceroute: createTraceroute, ...(o.extra ?? {}) },
    ...(o.lose ? { lose: o.lose } : {}),
  });
  w.add('pc1', 'pc');
  w.add('r1', 'router');
  w.add('r2', 'router');
  w.add('pc2', 'pc');
  w.link({ device: 'pc1', port: PC }, { device: 'r1', port: G0 });
  w.link({ device: 'r1', port: G1 }, { device: 'r2', port: G1 });
  w.link({ device: 'r2', port: G0 }, { device: 'pc2', port: PC });
  w.runFor(BOOT_NS);
  return w;
}

function chain(o: Opts = {}): World6 {
  const w = world(o);
  w.iface('pc1', PC, 'ip address 192.168.1.2 255.255.255.0');
  w.iface('pc2', PC, 'ip address 192.168.2.2 255.255.255.0');
  w.global('pc1', 'ip default-gateway 192.168.1.1');
  w.global('pc2', 'ip default-gateway 192.168.2.1');
  w.iface('r1', G0, 'ip address 192.168.1.1 255.255.255.0', 'no shutdown');
  w.iface('r1', G1, 'ip address 10.0.0.1 255.255.255.0', 'no shutdown');
  w.iface('r2', G1, 'ip address 10.0.0.2 255.255.255.0', 'no shutdown');
  w.iface('r2', G0, 'ip address 192.168.2.1 255.255.255.0', 'no shutdown');
  if (o.r1Route !== false) w.global('r1', 'ip route 192.168.2.0 255.255.255.0 10.0.0.2');
  w.global('r2', 'ip route 192.168.1.0 255.255.255.0 10.0.0.1');
  w.runFor(1 * SEC);
  return w;
}

/** The IPv6 chain (ip6.ipv6.test chain()); returns PC2's SLAAC address. */
function chain6(o: Opts = {}): { w: World6; pc2: string } {
  const w = world(o);
  w.global('r1', 'ipv6 unicast-routing', 'ipv6 route 2001:db8:2::/64 2001:db8:12::2');
  w.global('r2', 'ipv6 unicast-routing', 'ipv6 route 2001:db8:1::/64 2001:db8:12::1');
  w.iface('r1', G0, 'ipv6 address 2001:db8:1::1/64', 'no shutdown');
  w.iface('r1', G1, 'ipv6 address 2001:db8:12::1/64', 'no shutdown');
  w.iface('r2', G0, 'ipv6 address 2001:db8:2::1/64', 'no shutdown');
  w.iface('r2', G1, 'ipv6 address 2001:db8:12::2/64', 'no shutdown');
  w.iface('pc1', PC, 'ipv6 address autoconfig');
  w.iface('pc2', PC, 'ipv6 address autoconfig');
  w.runFor(6 * SEC);
  return { w, pc2: eui64Address('2001:db8:2::', 64, w.dev('pc2').port(PC)!.mac)! };
}

function trace(w: World6, dev: string, target: string, mode: 'udp' | 'icmp', extra: Partial<Extract<ProcessRequest, { kind: 'trace.start' }>> = {}, session = S): void {
  w.request(dev, 'traceroute', { kind: 'trace.start', session, target, mode, ...extra });
}

const HEADER = 'Route trace to 192.168.2.2, up to 30 hops\n';
const layer = (p: Pdu, proto: string): Record<string, unknown> | undefined => p.layers.find((l) => l.proto === proto)?.fields;
const probes = (w: World6, dev: string): Pdu[] => w.sentBy(dev).filter((p) => (p.meta.tag ?? '').startsWith('trace '));
const doneCount = (w: World6, session = S): number => w.done.filter((d) => d.session === session).length;
const traceSockets = (w: World6, dev: string): SocketRow[] =>
  (w.dev(dev).tables.get<SocketRow>('sockets')?.rows() ?? []).filter((r) => r.owner === 'traceroute');
/** ICMP time-exceeded frames sent by `dev`. */
const timeExceededFrom = (dev: string) => (s: Sent): boolean =>
  s.from.device === dev && s.pdu.layers.some((l) => (l.proto === 'icmpv4' && l.fields.type === 11) || (l.proto === 'icmpv6' && l.fields.type === 3));

describe('app.traceroute UDP mode', () => {
  it('lists R1 and R2 by their ingress addresses, then PC2, and ends with cliDone', () => {
    const w = chain();
    trace(w, 'pc1', '192.168.2.2', 'udp');
    w.runFor(10 * SEC);
    expect(w.output(S)).toBe(
      HEADER +
        '  1 192.168.1.1 4 msec 2 msec 2 msec\n' +
        '  2 10.0.0.2 6 msec 4 msec 4 msec\n' +
        '  3 192.168.2.2 8 msec 6 msec 6 msec\n' +
        'Reached 192.168.2.2 in 3 hops.\n',
    );
    expect(doneCount(w)).toBe(1);
    expect(traceSockets(w, 'pc1')).toEqual([]);
    const sent = probes(w, 'pc1');
    expect(sent.map((p) => p.meta.tag)).toEqual(['trace 1.0', 'trace 1.1', 'trace 1.2', 'trace 2.0', 'trace 2.1', 'trace 2.2', 'trace 3.0', 'trace 3.1', 'trace 3.2']);
    expect(sent.map((p) => layer(p, 'udp')!.dstPort)).toEqual([33434, 33435, 33436, 33437, 33438, 33439, 33440, 33441, 33442]);
    // Sent with TTL h and decremented by the h−1 routers before it: every probe expires (or lands) with TTL 1.
    expect(sent.map((p) => layer(p, 'ipv4')!.ttl)).toEqual([1, 1, 1, 1, 1, 1, 1, 1, 1]);
    expect(layer(sent[0]!, 'payload')!.data).toEqual(new Uint8Array(12));
  });

  it('a router traces too (R1 to PC2: R2, then PC2)', () => {
    const w = chain();
    trace(w, 'r1', '192.168.2.2', 'udp', { maxHops: 5, probes: 2 });
    w.runFor(10 * SEC);
    expect(w.output(S)).toMatch(/^Route trace to 192\.168\.2\.2, up to 5 hops\n {2}1 10\.0\.0\.2( \d+ msec){2}\n {2}2 192\.168\.2\.2( \d+ msec){2}\nReached 192\.168\.2\.2 in 2 hops\.\n$/);
    expect(probes(w, 'r1').map((p) => layer(p, 'udp')!.dstPort)).toEqual([33434, 33435, 33436, 33437]);
  });

  it('a hop that never answers prints * after each timeout, then the trace goes on', () => {
    const w = chain({ lose: timeExceededFrom('r2') });
    trace(w, 'pc1', '192.168.2.2', 'udp');
    w.runFor(8 * SEC);
    expect(w.output(S)).toBe(HEADER + '  1 192.168.1.1 4 msec 2 msec 2 msec\n  2 * *');
    w.runFor(3 * SEC);
    expect(w.output(S)).toMatch(/ {2}2 \* \* \*\n {2}3 192\.168\.2\.2( \d+ msec){3}\nReached 192\.168\.2\.2 in 3 hops\.\n$/);
    expect(doneCount(w)).toBe(1);
  });

  it('a router without a route answers net unreachable: !N, and the trace stops after that hop', () => {
    const w = chain({ r1Route: false });
    trace(w, 'pc1', '192.168.2.2', 'udp');
    w.runFor(10 * SEC);
    expect(w.output(S)).toBe(HEADER + '  1 192.168.1.1 4 msec 2 msec 2 msec\n  2 192.168.1.1 !N !N !N\nStopped at hop 2: 192.168.2.2 is unreachable.\n');
    expect(doneCount(w)).toBe(1);
    expect(traceSockets(w, 'pc1')).toEqual([]);
  });

  it('gives up after maxHops', () => {
    const w = chain({ lose: timeExceededFrom('r2') });
    trace(w, 'pc1', '192.168.2.2', 'udp', { maxHops: 2, probes: 1, timeoutNs: 1 * SEC });
    w.runFor(5 * SEC);
    expect(w.output(S)).toBe('Route trace to 192.168.2.2, up to 2 hops\n  1 192.168.1.1 4 msec\n  2 *\n192.168.2.2 was not reached within 2 hops.\n');
    expect(doneCount(w)).toBe(1);
  });

  it('job.abort mid-trace prints a partial footer, closes the socket and sends nothing more', () => {
    const w = chain({ lose: (s) => s.from.device === 'r2' });
    trace(w, 'pc1', '192.168.2.2', 'udp');
    w.runFor(4 * SEC);
    w.request('pc1', 'traceroute', { kind: 'job.abort', session: S });
    const n = probes(w, 'pc1').length;
    w.runFor(20 * SEC);
    expect(w.output(S)).toBe(HEADER + '  1 192.168.1.1 4 msec 2 msec 2 msec\n  2 *\nTrace aborted at hop 2.\n');
    expect(doneCount(w)).toBe(1);
    expect(probes(w, 'pc1')).toHaveLength(n);
    expect(traceSockets(w, 'pc1')).toEqual([]);
    const snap = w.dev('pc1').processes.get('traceroute')!.stateSnapshot();
    expect(snap).toEqual({ process: 'traceroute', state: { jobs: [{ session: S, target: '192.168.2.2', address: '192.168.2.2', mode: 'udp', hop: 2, probe: 1, done: true }] } });
  });

  it('a source address the device does not own ends the job before any hop line', () => {
    const w = chain();
    trace(w, 'r1', '192.168.2.2', 'udp', { source: '10.9.9.9' });
    w.runFor(10 * SEC);
    expect(w.output(S)).toBe(HEADER + 'Cannot trace to 192.168.2.2: 10.9.9.9 is not an address of this device.\n');
    expect(doneCount(w)).toBe(1);
    expect(probes(w, 'r1')).toEqual([]);
  });

  it('is deterministic: the same seed gives the same output and the same frames', () => {
    const run = (): [string, string[]] => {
      const w = chain({ seed: 11 });
      trace(w, 'pc1', '192.168.2.2', 'udp');
      w.runFor(10 * SEC);
      return [w.output(S), w.sent.map((s) => `${s.t} ${s.from.device} ${s.pdu.summary()}`)];
    };
    expect(run()).toEqual(run());
  });
});

describe('app.traceroute ICMP mode', () => {
  it('lists R1, R2 and PC2 by echo probes and ends with cliDone', () => {
    const w = chain();
    trace(w, 'pc1', '192.168.2.2', 'icmp');
    w.runFor(10 * SEC);
    expect(w.output(S)).toBe(
      HEADER +
        '  1 192.168.1.1 4 msec 2 msec 2 msec\n' +
        '  2 10.0.0.2 6 msec 4 msec 4 msec\n' +
        '  3 192.168.2.2 8 msec 6 msec 6 msec\n' +
        'Reached 192.168.2.2 in 3 hops.\n',
    );
    expect(doneCount(w)).toBe(1);
    const echoes = w.sentBy('pc1').filter((p) => p.meta.tag === 'icmp-probe');
    expect(echoes.map((p) => [layer(p, 'ipv4')!.dst, layer(p, 'ipv4')!.ttl])).toEqual(Array.from({ length: 9 }, () => ['192.168.2.2', 1]));
  });

  it('the icmp daemon times probes out (*) and unreachables print !N', () => {
    const w = chain({ lose: timeExceededFrom('r2') });
    trace(w, 'pc1', '192.168.2.2', 'icmp', { probes: 1 });
    w.runFor(10 * SEC);
    expect(w.output(S)).toMatch(/^Route trace to 192\.168\.2\.2, up to 30 hops\n {2}1 192\.168\.1\.1 \d+ msec\n {2}2 \*\n {2}3 192\.168\.2\.2 \d+ msec\nReached/);

    const u = chain({ r1Route: false });
    trace(u, 'pc1', '192.168.2.2', 'icmp');
    u.runFor(10 * SEC);
    expect(u.output(S)).toBe(HEADER + '  1 192.168.1.1 4 msec 2 msec 2 msec\n  2 192.168.1.1 !N !N !N\nStopped at hop 2: 192.168.2.2 is unreachable.\n');
  });

  it('two sessions trace at once without mixing their answers', () => {
    const w = chain();
    trace(w, 'pc1', '192.168.2.2', 'icmp', {}, 'a');
    trace(w, 'pc1', '10.0.0.2', 'udp', {}, 'b');
    w.runFor(10 * SEC);
    expect(w.output('a')).toMatch(/ {2}3 192\.168\.2\.2( \d+ msec){3}\nReached 192\.168\.2\.2 in 3 hops\.\n$/);
    expect(w.output('b')).toMatch(/^Route trace to 10\.0\.0\.2, up to 30 hops\n {2}1 192\.168\.1\.1( \d+ msec){3}\n {2}2 10\.0\.0\.2( \d+ msec){3}\nReached 10\.0\.0\.2 in 2 hops\.\n$/);
    expect([doneCount(w, 'a'), doneCount(w, 'b')]).toEqual([1, 1]);
  });
});

describe('app.traceroute names and IPv6', () => {
  it('resolves a name through dns-client first (A), then traces the first address', () => {
    const dns = recorder('dns-client');
    const w = chain({ extra: { 'dns-client': () => dns } });
    trace(w, 'pc1', 'pc2.lab.nf', 'udp');
    expect(dns.requests).toEqual([{ kind: 'dns.resolve', owner: 'traceroute', token: `${S}#1`, name: 'pc2.lab.nf', qtype: 'A' }]);
    expect(w.output(S)).toBe('');
    w.act('pc1', 'dns-client', [
      { type: 'event', to: 'traceroute', ev: { kind: 'dns.result', token: `${S}#1`, name: 'pc2.lab.nf', qtype: 'A', addresses: ['192.168.2.2', '192.168.2.9'], rcode: 'NOERROR', fromCache: false } },
    ]);
    w.runFor(10 * SEC);
    expect(w.output(S)).toMatch(/^Route trace to pc2\.lab\.nf \(192\.168\.2\.2\), up to 30 hops\n[\s\S]*Reached 192\.168\.2\.2 in 3 hops\.\n$/);
  });

  it('ignores the late answer of an aborted job: the next trace in that session keeps its own address', () => {
    const dns = recorder('dns-client');
    const w = chain({ extra: { 'dns-client': () => dns } });
    trace(w, 'pc1', 'a.lab.nf', 'udp');
    w.request('pc1', 'traceroute', { kind: 'job.abort', session: S });
    trace(w, 'pc1', 'b.lab.nf', 'udp');
    expect(dns.requests.map((r) => (r as { token: string }).token)).toEqual([`${S}#1`, `${S}#2`]);
    const result = (token: string, name: string, address: string): void =>
      w.act('pc1', 'dns-client', [
        { type: 'event', to: 'traceroute', ev: { kind: 'dns.result', token, name, qtype: 'A', addresses: [address], rcode: 'NOERROR', fromCache: false } },
      ]);
    result(`${S}#1`, 'a.lab.nf', '192.168.2.2');
    w.runFor(1 * SEC);
    expect(w.output(S)).toBe('Trace aborted.\n');
    result(`${S}#2`, 'b.lab.nf', '10.0.0.2');
    w.runFor(10 * SEC);
    expect(w.output(S)).toContain('Route trace to b.lab.nf (10.0.0.2), up to 30 hops\n');
  });

  it('a name that does not resolve prints one line and cliDone', () => {
    const dns = recorder('dns-client');
    const w = chain({ extra: { 'dns-client': () => dns } });
    trace(w, 'pc1', 'nowhere.lab.nf', 'icmp', { family: 6 });
    expect((dns.requests[0] as { qtype: string }).qtype).toBe('AAAA');
    w.act('pc1', 'dns-client', [
      { type: 'event', to: 'traceroute', ev: { kind: 'dns.result', token: `${S}#1`, name: 'nowhere.lab.nf', qtype: 'AAAA', addresses: [], rcode: 'NXDOMAIN', fromCache: false } },
    ]);
    expect(w.output(S)).toBe('Cannot resolve nowhere.lab.nf (NXDOMAIN).\n');
    expect(doneCount(w)).toBe(1);
  });

  it('traces over IPv6 in both modes (hop limit h), ending at PC2', () => {
    for (const mode of ['udp', 'icmp'] as const) {
      const { w, pc2 } = chain6();
      trace(w, 'pc1', pc2, mode);
      w.runFor(10 * SEC);
      const out = w.output(S);
      const hops = out.split('\n').slice(1, 4).map((l) => l.split(' ').filter(Boolean)[1]);
      expect(hops).toEqual(['2001:db8:1::1', '2001:db8:12::2', pc2]);
      expect(out.endsWith(`Reached ${pc2} in 3 hops.\n`)).toBe(true);
      expect(doneCount(w)).toBe(1);
    }
  });
});
