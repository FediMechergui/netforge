/**
 * app.dns.test.ts — dns-client and dns-server end to end (protocols/dns-{client,server}.ts; ARCHITECTURE-P1 §4.4,
 * §5.1; RFC 1035, RFC 2308), on the ip6.harness bus with the real arp/ipv4/icmpv4/udp daemons. The resolve owner is
 * a recorder standing in for 'http-client' on the PCs.
 *
 * PC1 192.168.1.2 (ip name-server 192.168.1.1) — R1 Gi0/0 192.168.1.1 (ip dns server, ip host www.lab.nf 192.168.1.80).
 */
import { describe, expect, it } from 'vitest';
import type { Pdu } from '../src/contracts/pdu.js';
import type { DnsCacheRow, SocketRow } from '../src/contracts/tables.js';
import { SEC } from '../src/contracts/time.js';
import type { ResolveEvent } from '../src/contracts/transport.js';
import { createDnsClient } from '../src/protocols/dns-client.js';
import { createDnsServer } from '../src/protocols/dns-server.js';
import { createUdp } from '../src/protocols/udp.js';
import { BOOT_NS, createWorld6, recorder, type Recorder, type Sent, type World6 } from './ip6.harness.js';

const PC = 'GigabitEthernet0';
const G0 = 'GigabitEthernet0/0';
const G1 = 'GigabitEthernet0/1';

interface Lab {
  w: World6;
  rec: Recorder;
}

function world(opts: { seed?: number; lose?: (s: Sent) => boolean }): Lab {
  const rec = recorder('http-client');
  const extra = { udp: createUdp, 'dns-client': createDnsClient, 'dns-server': createDnsServer, 'http-client': () => rec };
  return { w: createWorld6({ seed: opts.seed ?? 11, extra, ...(opts.lose ? { lose: opts.lose } : {}) }), rec };
}

/** PC1 — R1 with R1 serving www.lab.nf; `nameServer` false leaves PC1 without `ip name-server`. */
function lab(opts: { seed?: number; lose?: (s: Sent) => boolean; nameServer?: boolean } = {}): Lab {
  const l = world(opts);
  const { w } = l;
  w.add('pc1', 'pc');
  w.add('r1', 'router');
  w.link({ device: 'pc1', port: PC }, { device: 'r1', port: G0 });
  w.runFor(BOOT_NS);
  w.iface('pc1', PC, 'ip address 192.168.1.2 255.255.255.0');
  w.iface('r1', G0, 'ip address 192.168.1.1 255.255.255.0', 'no shutdown');
  w.global('r1', 'ip dns server', 'ip host www.lab.nf 192.168.1.80');
  if (opts.nameServer !== false) w.global('pc1', 'ip name-server 192.168.1.1');
  w.runFor(1 * SEC);
  return l;
}

function resolve(w: World6, name: string, qtype: 'A' | 'AAAA' = 'A', dev = 'pc1'): void {
  w.request(dev, 'dns-client', { kind: 'dns.resolve', owner: 'http-client', token: `t-${name}`, name, qtype });
}

const results = (r: Recorder): ResolveEvent[] => r.evs.filter((e): e is ResolveEvent => e.kind === 'dns.result');
const last = (r: Recorder): ResolveEvent => results(r).at(-1)!;
const dnsOf = (p: Pdu): Record<string, unknown> => p.layers.find((l) => l.proto === 'dns')!.fields as Record<string, unknown>;
const tagged = (w: World6, dev: string, tag: string, port?: string): Pdu[] => w.sentBy(dev, port).filter((p) => p.meta.tag === tag);
const cache = (w: World6, dev: string): DnsCacheRow[] => w.dev(dev).tables.get<DnsCacheRow>('dns-cache')!.rows();
const sockets = (w: World6, dev: string): string[] => w.dev(dev).tables.get<SocketRow>('sockets')!.rows().map((r) => r.id);
const snap = (w: World6, dev: string, p: string): Record<string, unknown> => w.dev(dev).processes.get(p)!.stateSnapshot().state;

describe('app.dns resolve against a router DNS server', () => {
  it('answers A from ip host; the reply echoes the id and is triggered by the query', () => {
    const { w, rec } = lab();
    expect(sockets(w, 'r1')).toContain('dns-server#53');
    resolve(w, 'WWW.Lab.nf.');
    w.runFor(1 * SEC);
    expect(results(rec)).toEqual([
      { kind: 'dns.result', token: 't-WWW.Lab.nf.', name: 'www.lab.nf', qtype: 'A', addresses: ['192.168.1.80'], rcode: 'NOERROR', server: '192.168.1.1', fromCache: false },
    ]);
    const [q] = tagged(w, 'pc1', 'dns-query');
    const [resp] = tagged(w, 'r1', 'dns-response');
    expect(dnsOf(q!)).toMatchObject({ qr: false, rd: true, questions: 'www.lab.nf A' });
    expect(q!.layers.find((l) => l.proto === 'udp')!.fields.dstPort).toBe(53);
    expect(resp!.meta.triggeredBy).toBe(q!.id);
    expect(dnsOf(resp!)).toMatchObject({ id: dnsOf(q!).id, qr: true, aa: true, rd: true, ra: false, tc: false, rcode: 0, answers: 'www.lab.nf A 300 192.168.1.80', additionals: '' });
    const row = cache(w, 'pc1').find((r) => r.key === 'www.lab.nf|A')!;
    expect(row).toMatchObject({ name: 'www.lab.nf', type: 'A', data: '192.168.1.80', ttl: 300, source: 'answer', server: '192.168.1.1' });
    expect(row.expiresAt! - row.updatedAt).toBe(300 * SEC);
    expect(sockets(w, 'pc1').filter((s) => s.startsWith('dns-client'))).toEqual([]);
    expect(snap(w, 'r1', 'dns-server')).toMatchObject({ enabled: true, queries: 1, answered: 1, nxdomain: 0, forwarded: 0 });
  });

  it('serves the second resolve from the cache with no new query on the wire', () => {
    const { w, rec } = lab();
    resolve(w, 'www.lab.nf');
    w.runFor(1 * SEC);
    resolve(w, 'www.lab.nf');
    expect(last(rec)).toMatchObject({ addresses: ['192.168.1.80'], rcode: 'NOERROR', fromCache: true });
    w.runFor(1 * SEC);
    expect(tagged(w, 'pc1', 'dns-query')).toHaveLength(1);
    expect(snap(w, 'pc1', 'dns-client')).toMatchObject({ queries: 1, answers: 1, cacheHits: 1 });
  });

  it('follows a CNAME from ip dns record, answers AAAA, and answers NODATA for a missing type', () => {
    const { w, rec } = lab();
    w.global('r1', 'ip dns record web.lab.nf CNAME www.lab.nf 120', 'ip host v6.lab.nf 2001:DB8::80');
    resolve(w, 'web.lab.nf');
    w.runFor(1 * SEC);
    expect(last(rec)).toMatchObject({ name: 'web.lab.nf', addresses: ['192.168.1.80'], cname: 'www.lab.nf', rcode: 'NOERROR', fromCache: false });
    expect(dnsOf(tagged(w, 'r1', 'dns-response')[0]!).answers).toBe('web.lab.nf CNAME 120 www.lab.nf;www.lab.nf A 300 192.168.1.80');
    expect(cache(w, 'pc1').map((r) => r.key)).toEqual(['web.lab.nf|CNAME', 'www.lab.nf|A']);
    resolve(w, 'web.lab.nf');
    expect(last(rec)).toMatchObject({ addresses: ['192.168.1.80'], cname: 'www.lab.nf', fromCache: true });

    resolve(w, 'v6.lab.nf', 'AAAA');
    w.runFor(1 * SEC);
    expect(last(rec)).toMatchObject({ qtype: 'AAAA', addresses: ['2001:db8::80'], rcode: 'NOERROR' });
    resolve(w, 'www.lab.nf', 'AAAA');
    w.runFor(1 * SEC);
    expect(last(rec)).toMatchObject({ addresses: [], rcode: 'NOERROR', fromCache: false });
  });

  it('answers NXDOMAIN, caches it negatively for 60 s and the sweep removes it', () => {
    const { w, rec } = lab();
    resolve(w, 'nope.lab.nf');
    w.runFor(1 * SEC);
    expect(last(rec)).toMatchObject({ rcode: 'NXDOMAIN', addresses: [], fromCache: false, server: '192.168.1.1' });
    expect(dnsOf(tagged(w, 'r1', 'dns-response')[0]!)).toMatchObject({ rcode: 3, aa: true, answers: '' });
    const neg = cache(w, 'pc1').find((r) => r.key === 'nope.lab.nf|NXDOMAIN')!;
    expect(neg).toMatchObject({ type: 'NXDOMAIN', source: 'negative', ttl: 60 });
    expect(neg.expiresAt! - neg.updatedAt).toBe(60 * SEC);
    resolve(w, 'nope.lab.nf');
    expect(last(rec)).toMatchObject({ rcode: 'NXDOMAIN', fromCache: true });
    expect(tagged(w, 'pc1', 'dns-query')).toHaveLength(1);

    w.runFor(60 * SEC);
    expect(cache(w, 'pc1').map((r) => r.key)).toEqual([]);
    resolve(w, 'nope.lab.nf');
    w.runFor(1 * SEC);
    expect(last(rec)).toMatchObject({ rcode: 'NXDOMAIN', fromCache: false });
    expect(tagged(w, 'pc1', 'dns-query')).toHaveLength(2);
    expect(snap(w, 'r1', 'dns-server')).toMatchObject({ nxdomain: 2 });
  });

  it('keeps ip host lines on the client as static rows without expiry', () => {
    const { w, rec } = lab();
    w.global('pc1', 'ip host printer.lab.nf 192.168.1.50');
    expect(cache(w, 'pc1')).toEqual([expect.objectContaining({ key: 'printer.lab.nf|A', data: '192.168.1.50', source: 'static' })]);
    expect(cache(w, 'pc1')[0]!.expiresAt).toBeUndefined();
    resolve(w, 'printer.lab.nf');
    expect(last(rec)).toMatchObject({ addresses: ['192.168.1.50'], fromCache: true });
    w.global('pc1', 'no ip host printer.lab.nf');
    expect(cache(w, 'pc1')).toEqual([]);
    expect(tagged(w, 'pc1', 'dns-query')).toHaveLength(0);
  });

  it('resolves a literal address at once', () => {
    const { w, rec } = lab({ nameServer: false });
    resolve(w, '192.168.1.1');
    expect(last(rec)).toMatchObject({ addresses: ['192.168.1.1'], rcode: 'NOERROR', fromCache: false });
  });

  it('refuses a name the codec cannot encode instead of throwing, and sends nothing', () => {
    const { w, rec } = lab();
    for (const bad of ['www..lab.nf', 'a;b.lab.nf', `${'x'.repeat(64)}.lab.nf`, 'www lab.nf']) {
      resolve(w, bad);
      expect(last(rec)).toMatchObject({ rcode: 'NXDOMAIN', addresses: [], fromCache: false });
    }
    w.runFor(1 * SEC);
    expect(tagged(w, 'pc1', 'dns-query')).toHaveLength(0);
  });

  it('ignores an ip dns record whose data is not a usable name', () => {
    const { w, rec } = lab();
    w.global('r1', 'ip dns record web.lab.nf CNAME bad..x 120');
    resolve(w, 'web.lab.nf');
    w.runFor(1 * SEC);
    expect(last(rec)).toMatchObject({ rcode: 'NXDOMAIN' });
    expect(snap(w, 'r1', 'dns-server').records).toEqual([expect.objectContaining({ name: 'www.lab.nf' })]);
  });
});

describe('app.dns failures and server selection', () => {
  it('gives up with TIMEOUT after 1 + 2 tries of 2 s to a server that never answers', () => {
    const { w, rec } = lab({ lose: (s) => s.pdu.meta.tag === 'dns-query' });
    resolve(w, 'www.lab.nf');
    w.runFor(6 * SEC - 1);
    expect(results(rec)).toEqual([]);
    const qs = tagged(w, 'pc1', 'dns-query');
    expect(qs).toHaveLength(3);
    expect(new Set(qs.map((p) => dnsOf(p).id)).size).toBe(1);
    expect(new Set(qs.map((p) => p.layers.find((l) => l.proto === 'udp')!.fields.srcPort)).size).toBe(1);
    w.runFor(1);
    expect(last(rec)).toMatchObject({ rcode: 'TIMEOUT', addresses: [], server: '192.168.1.1', fromCache: false });
    expect(sockets(w, 'pc1').filter((s) => s.startsWith('dns-client'))).toEqual([]);
  });

  it('moves to the next name-server after the first one times out', () => {
    const { w, rec } = lab();
    // 192.168.1.9 does not exist: its queries never get past ARP
    w.global('pc1', 'no ip name-server 192.168.1.1', 'ip name-server 192.168.1.9', 'ip name-server 192.168.1.1');
    expect(snap(w, 'pc1', 'dns-client').servers).toEqual(['192.168.1.9', '192.168.1.1']);
    resolve(w, 'www.lab.nf');
    w.runFor(6 * SEC + 1 * SEC);
    expect(last(rec)).toMatchObject({ rcode: 'NOERROR', addresses: ['192.168.1.80'], server: '192.168.1.1' });
  });

  it('counts a port unreachable as a failed try: no DNS service → TIMEOUT well before 6 s', () => {
    const { w, rec } = lab();
    w.global('r1', 'no ip dns server');
    expect(sockets(w, 'r1')).not.toContain('dns-server#53');
    resolve(w, 'www.lab.nf');
    w.runFor(1 * SEC);
    expect(last(rec)).toMatchObject({ rcode: 'TIMEOUT', server: '192.168.1.1' });
    expect(tagged(w, 'pc1', 'dns-query')).toHaveLength(3);
  });

  it('answers NO-SERVER when no server is known', () => {
    const { w, rec } = lab({ nameServer: false });
    resolve(w, 'www.lab.nf');
    expect(last(rec)).toMatchObject({ rcode: 'NO-SERVER', addresses: [], fromCache: false });
    expect(tagged(w, 'pc1', 'dns-query')).toHaveLength(0);
  });

  it('uses DHCP-learned servers from dhcp.lease events and forgets them when the lease is lost', () => {
    const { w, rec } = lab({ nameServer: false });
    const lease = (op: 'bound' | 'lost'): void =>
      w.act('pc1', 'dhcp-client', [{ type: 'event', to: 'dns-client', ev: { kind: 'dhcp.lease', iface: PC, op, dnsServers: ['192.168.1.1'] } }]);
    lease('bound');
    expect(snap(w, 'pc1', 'dns-client').servers).toEqual(['192.168.1.1']);
    resolve(w, 'www.lab.nf');
    w.runFor(1 * SEC);
    expect(last(rec)).toMatchObject({ rcode: 'NOERROR', server: '192.168.1.1', addresses: ['192.168.1.80'] });
    lease('lost');
    resolve(w, 'other.lab.nf');
    expect(last(rec)).toMatchObject({ rcode: 'NO-SERVER' });
  });
});

describe('app.dns forwarding', () => {
  /** PC1 — R1 (ip dns server, forwarder 10.0.0.2) — R2 10.0.0.2 (ip dns server, ext.lab.nf). */
  function fwdLab(): Lab {
    const l = world({ seed: 5 });
    const { w } = l;
    w.add('pc1', 'pc');
    w.add('r1', 'router');
    w.add('r2', 'router');
    w.link({ device: 'pc1', port: PC }, { device: 'r1', port: G0 });
    w.link({ device: 'r1', port: G1 }, { device: 'r2', port: G1 });
    w.runFor(BOOT_NS);
    w.iface('pc1', PC, 'ip address 192.168.1.2 255.255.255.0');
    w.iface('r1', G0, 'ip address 192.168.1.1 255.255.255.0', 'no shutdown');
    w.iface('r1', G1, 'ip address 10.0.0.1 255.255.255.0', 'no shutdown');
    w.iface('r2', G1, 'ip address 10.0.0.2 255.255.255.0', 'no shutdown');
    w.global('r1', 'ip dns server', 'ip name-server 10.0.0.2');
    w.global('r2', 'ip dns server', 'ip host ext.lab.nf 10.0.0.80');
    w.global('pc1', 'ip name-server 192.168.1.1');
    w.runFor(1 * SEC);
    return l;
  }

  it('forwards an unknown name, relays the answer with the client id and caches it', () => {
    const { w, rec } = fwdLab();
    resolve(w, 'ext.lab.nf');
    w.runFor(1 * SEC);
    expect(last(rec)).toMatchObject({ rcode: 'NOERROR', addresses: ['10.0.0.80'], server: '192.168.1.1' });
    const [q] = tagged(w, 'pc1', 'dns-query');
    const [fwd] = tagged(w, 'r1', 'dns-query', G1);
    const [r2answer] = tagged(w, 'r2', 'dns-response');
    const [relay] = tagged(w, 'r1', 'dns-response', G0);
    expect(fwd!.meta.triggeredBy).toBe(q!.id);
    expect(dnsOf(fwd!)).toMatchObject({ rd: true, questions: 'ext.lab.nf A' });
    expect(r2answer!.meta.triggeredBy).toBe(fwd!.id);
    expect(relay!.meta.triggeredBy).toBe(r2answer!.id);
    expect(dnsOf(relay!)).toMatchObject({ id: dnsOf(q!).id, qr: true, aa: false, ra: true, rcode: 0, answers: 'ext.lab.nf A 300 10.0.0.80' });
    expect(cache(w, 'r1')).toEqual([expect.objectContaining({ key: 'ext.lab.nf|A', source: 'answer', server: '10.0.0.2', data: '10.0.0.80' })]);

    // as `clear` does: PC1 forgets, R1 still holds the relayed answer
    w.dev('pc1').tables.get('dns-cache')!.clear('cleared');
    resolve(w, 'ext.lab.nf');
    w.runFor(1 * SEC);
    expect(last(rec)).toMatchObject({ rcode: 'NOERROR', addresses: ['10.0.0.80'], fromCache: false });
    expect(tagged(w, 'r1', 'dns-query', G1)).toHaveLength(1);
    expect(snap(w, 'r1', 'dns-server')).toMatchObject({ forwarded: 1, queries: 2, answered: 2 });
  });

  /** PC1 — R1 (dns server, forwarder = R2's far address) — R2 (10.0.0.10 / 172.16.0.1) — PC2. */
  function farLab(): Lab {
    const l = world({ seed: 7 });
    const { w } = l;
    w.add('pc1', 'pc');
    w.add('r1', 'router');
    w.add('r2', 'router');
    w.add('pc2', 'pc');
    w.link({ device: 'pc1', port: PC }, { device: 'r1', port: G0 });
    w.link({ device: 'r1', port: G1 }, { device: 'r2', port: G1 });
    w.link({ device: 'r2', port: G0 }, { device: 'pc2', port: PC });
    w.runFor(BOOT_NS);
    w.iface('pc1', PC, 'ip address 192.168.1.2 255.255.255.0');
    w.iface('pc2', PC, 'ip address 172.16.0.2 255.255.255.0');
    w.iface('r1', G0, 'ip address 192.168.1.1 255.255.255.0', 'no shutdown');
    w.iface('r1', G1, 'ip address 10.0.0.1 255.255.255.0', 'no shutdown');
    w.iface('r2', G1, 'ip address 10.0.0.10 255.255.255.0', 'no shutdown');
    w.iface('r2', G0, 'ip address 172.16.0.1 255.255.255.0', 'no shutdown');
    w.global('r1', 'ip dns server', 'ip name-server 172.16.0.1', 'ip route 172.16.0.0 255.255.255.0 10.0.0.10');
    w.global('r2', 'ip dns server', 'ip host ext.lab.nf 172.16.0.80', 'ip route 192.168.1.0 255.255.255.0 10.0.0.1');
    w.global('pc1', 'ip name-server 192.168.1.1');
    w.runFor(1 * SEC);
    return l;
  }

  it('answers from the address that was queried, so a multi-homed forwarder is understood', () => {
    const { w, rec } = farLab();
    resolve(w, 'ext.lab.nf');
    w.runFor(1 * SEC);
    expect(last(rec)).toMatchObject({ rcode: 'NOERROR', addresses: ['172.16.0.80'], server: '192.168.1.1' });
    const src = (p: Pdu): unknown => p.layers.find((l) => l.proto === 'ipv4')!.fields.src;
    expect(src(tagged(w, 'r2', 'dns-response')[0]!)).toBe('172.16.0.1');
    expect(src(tagged(w, 'r1', 'dns-response', G0)[0]!)).toBe('192.168.1.1');
  });

  it('never forwards to one of its own addresses: NXDOMAIN, not a self-query storm', () => {
    const { w, rec } = lab();
    w.global('r1', 'ip name-server 192.168.1.1');
    resolve(w, 'nope.lab.nf');
    w.runFor(3 * SEC);
    expect(last(rec)).toMatchObject({ rcode: 'NXDOMAIN' });
    expect(snap(w, 'r1', 'dns-server')).toMatchObject({ forwarded: 0, queries: 1 });
  });

  it('two servers that name each other answer SERVFAIL after one forward each', () => {
    const { w, rec } = fwdLab();
    w.global('r2', 'ip name-server 10.0.0.1');
    resolve(w, 'loop.lab.nf');
    w.runFor(5 * SEC);
    expect(last(rec)).toMatchObject({ rcode: 'SERVFAIL' });
    expect(snap(w, 'r1', 'dns-server')).toMatchObject({ forwarded: 1 });
    expect(snap(w, 'r2', 'dns-server')).toMatchObject({ forwarded: 1 });
  });

  it('sweeps the rows it cached from the forwarder', () => {
    const { w } = fwdLab();
    resolve(w, 'ext.lab.nf');
    w.runFor(1 * SEC);
    expect(cache(w, 'r1').map((r) => r.key)).toEqual(['ext.lab.nf|A']);
    w.runFor(360 * SEC);
    expect(cache(w, 'r1')).toEqual([]);
  });

  it('relays NXDOMAIN (cached negatively) and answers SERVFAIL when the forwarder is silent', () => {
    const { w, rec } = fwdLab();
    resolve(w, 'none.lab.nf');
    w.runFor(1 * SEC);
    expect(last(rec)).toMatchObject({ rcode: 'NXDOMAIN' });
    expect(cache(w, 'r1').map((r) => [r.key, r.source])).toEqual([['none.lab.nf|NXDOMAIN', 'negative']]);

    w.global('r2', 'no ip dns server');
    resolve(w, 'late.lab.nf');
    w.runFor(3 * SEC);
    expect(last(rec)).toMatchObject({ rcode: 'SERVFAIL', addresses: [] });
    expect(dnsOf(tagged(w, 'r1', 'dns-response', G0).at(-1)!)).toMatchObject({ rcode: 2 });
  });
});

describe('app.dns nslookup jobs and determinism', () => {
  it('prints the server, the name and the addresses, then ends the job', () => {
    const { w } = lab();
    w.global('r1', 'ip dns record web.lab.nf CNAME www.lab.nf 120');
    w.request('pc1', 'dns-client', { kind: 'dns.lookup', session: 's1', name: 'web.lab.nf' });
    w.runFor(1 * SEC);
    expect(w.output('s1')).toBe('Looking up web.lab.nf (A) at 192.168.1.1\n  canonical name: www.lab.nf\n  address: 192.168.1.80\n');
    expect(w.done.map((d) => d.session)).toEqual(['s1']);
    w.request('pc1', 'dns-client', { kind: 'dns.lookup', session: 's2', name: 'nope.lab.nf' });
    w.runFor(1 * SEC);
    expect(w.output('s2')).toContain('no such name (NXDOMAIN)');
    expect(w.done.map((d) => d.session)).toEqual(['s1', 's2']);
  });

  it('job.abort stops a lookup: timer off, socket closed, one line and cliDone', () => {
    const { w } = lab({ lose: (s) => s.pdu.meta.tag === 'dns-query' });
    w.request('pc1', 'dns-client', { kind: 'dns.lookup', session: 's1', name: 'www.lab.nf' });
    w.runFor(1 * SEC);
    w.request('pc1', 'dns-client', { kind: 'job.abort', session: 's1' });
    expect(w.output('s1')).toBe('Lookup of www.lab.nf aborted\n');
    expect(w.done.map((d) => d.session)).toEqual(['s1']);
    expect(sockets(w, 'pc1').filter((s) => s.startsWith('dns-client'))).toEqual([]);
    w.runFor(10 * SEC);
    expect(tagged(w, 'pc1', 'dns-query')).toHaveLength(1);
  });

  it('draws the txid from the cached dns-id stream: same seed → same ids, successive queries differ', () => {
    const ids = (): number[] => {
      const { w } = lab({ seed: 21 });
      resolve(w, 'www.lab.nf');
      resolve(w, 'nope.lab.nf');
      w.runFor(1 * SEC);
      return tagged(w, 'pc1', 'dns-query').map((p) => dnsOf(p).id as number);
    };
    const a = ids();
    expect(a).toHaveLength(2);
    expect(a[0]).not.toBe(a[1]);
    expect(ids()).toEqual(a);
  });
});
