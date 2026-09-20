/**
 * P1 W3 netscope: capture store, row decoding, follow stream and statistics (ARCHITECTURE-P1 §4.12).
 *
 * TCP reassembly follows RFC 9293 sequence semantics: the SYN consumes one sequence number (§3.4), data is placed
 * by sequence number modulo 2^32, retransmitted bytes are delivered once, and out-of-order data waits for the gap.
 * HTTP messages are recognised per RFC 9112 by the http codec's pure parser.
 */
import { describe, expect, it } from 'vitest';
import type { CaptureInterface, CaptureRecord } from '../src/contracts/capture.js';
import { ETHERTYPE_IPV4, ETHERTYPE_IPV6, IPPROTO_TCP, IPPROTO_UDP } from '../src/contracts/pdu.js';
import type { LayerSpec, LayerView, Pdu, PduMeta } from '../src/contracts/pdu.js';
import { createPduFactory } from '../src/pdu/factory.js';
import { readCapture } from '../src/io/pcap.js';
import { CAPTURE_QUERY_SCAN_BUDGET, createCaptureStore, createCaptureStoreImpl } from '../src/capture/store.js';
import {
  compareAddresses,
  followStream,
  networkLayerIndex,
  parseStreamKey,
  seqDiff,
  streamKey,
  streamText,
  transportLayerIndex,
} from '../src/capture/stream.js';
import { createDecodeCache, decodeCaptureRecord, frameAddresses } from '../src/capture/decode-row.js';
import { CAPTURE_LENGTH_BUCKETS, computeCaptureStatistics, lengthBucketIndex } from '../src/capture/stats.js';

const f = createPduFactory();
const meta = (): PduMeta => ({ born: 0, origin: 'd_test' });
const ascii = (s: string): Uint8Array => new TextEncoder().encode(s);

const MAC_C = '02:00:00:00:00:01';
const MAC_S = '02:00:00:00:00:02';
const PC = '192.168.1.2';
const SRV = '192.168.1.80';
const KEY = 'tcp:192.168.1.2:49152-192.168.1.80:80';

const ETH0: CaptureInterface = { index: 0, name: 'PC1 Gi0', linkType: 'ethernet', fcsLen: 4 };
const ETH1: CaptureInterface = { index: 1, name: 'SW1 Fa0/1', linkType: 'ethernet', fcsLen: 4 };

let ipId = 1;
function tcp(from: 'c' | 's', seq: number, ack: number, flags: string, data = '', opts: { id?: number; v6?: boolean } = {}): Pdu {
  const c = from === 'c';
  const id = opts.id ?? ipId++;
  const layers: LayerSpec[] = opts.v6
    ? [
        { proto: 'ethernet', fields: { src: c ? MAC_C : MAC_S, dst: c ? MAC_S : MAC_C, type: ETHERTYPE_IPV6 } },
        { proto: 'ipv6', fields: { src: c ? '2001:db8::1' : '2001:db8::80', dst: c ? '2001:db8::80' : '2001:db8::1', nextHeader: IPPROTO_TCP } },
      ]
    : [
        { proto: 'ethernet', fields: { src: c ? MAC_C : MAC_S, dst: c ? MAC_S : MAC_C, type: ETHERTYPE_IPV4 } },
        { proto: 'ipv4', fields: { src: c ? PC : SRV, dst: c ? SRV : PC, protocol: IPPROTO_TCP, ttl: 128, id } },
      ];
  layers.push({ proto: 'tcp', fields: { srcPort: c ? 49152 : 80, dstPort: c ? 80 : 49152, seq: seq >>> 0, ack: ack >>> 0, flags, window: 65535 } });
  if (data !== '') layers.push({ proto: 'payload', fields: { data: ascii(data) } });
  return f.build(layers, meta());
}

function udp(fromClient: boolean, text: string, port = 9999): Pdu {
  return f.build(
    [
      { proto: 'ethernet', fields: { src: fromClient ? MAC_C : MAC_S, dst: fromClient ? MAC_S : MAC_C, type: ETHERTYPE_IPV4 } },
      { proto: 'ipv4', fields: { src: fromClient ? PC : SRV, dst: fromClient ? SRV : PC, protocol: IPPROTO_UDP, ttl: 64, id: ipId++ } },
      { proto: 'udp', fields: { srcPort: fromClient ? 50000 : port, dstPort: fromClient ? port : 50000 } },
      { proto: 'payload', fields: { data: ascii(text) } },
    ],
    meta(),
  );
}

function rec(index: number, p: Pdu, t = index * 1000, iface = 0, dir: CaptureRecord['dir'] = 'tx'): CaptureRecord {
  return { index, t, iface, dir, bytes: p.bytes.slice(), origLen: p.size, pdu: p.id };
}

const REQ = 'GET / HTTP/1.1\r\nHost: www.lab.nf\r\n\r\n';
const BODY = '<h1>Hello</h1>';
const RESP = `HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: ${BODY.length}\r\n\r\n${BODY}`;
const RESP1 = RESP.slice(0, 30);
const RESP2 = RESP.slice(30);

/**
 * A browser fetch as captured on PC1 Gi0 (iface 0) plus the request seen again at SW1 Fa0/1 (iface 1, rx):
 * handshake, request, response delivered out of order, a retransmission, and the close.
 */
function browsingCapture(): CaptureRecord[] {
  ipId = 100;
  const C = 1000;
  const S = 5000;
  const out: CaptureRecord[] = [];
  const add = (p: Pdu, iface = 0, dir: CaptureRecord['dir'] = 'tx'): void => {
    out.push(rec(out.length, p, out.length * 1000, iface, dir));
  };
  add(tcp('c', C, 0, 'S')); // 0
  add(tcp('s', S, C + 1, 'SA'), 0, 'rx'); // 1
  add(tcp('c', C + 1, S + 1, 'A')); // 2
  const req = tcp('c', C + 1, S + 1, 'PA', REQ);
  add(req); // 3
  out.push({ ...rec(out.length, req, out.length * 1000, 1, 'rx') }); // 4: the same frame at the switch
  add(tcp('s', S + 1, C + 1 + REQ.length, 'A'), 0, 'rx'); // 5
  add(tcp('s', S + 1 + RESP1.length, C + 1 + REQ.length, 'PA', RESP2), 0, 'rx'); // 6: second half first
  add(tcp('s', S + 1, C + 1 + REQ.length, 'PA', RESP1), 0, 'rx'); // 7: first half
  add(tcp('s', S + 1, C + 1 + REQ.length, 'PA', RESP1), 0, 'rx'); // 8: retransmission (new IP id)
  add(tcp('c', C + 1 + REQ.length, S + 1 + RESP.length, 'FA')); // 9
  add(tcp('s', S + 1 + RESP.length, C + 2 + REQ.length, 'FA'), 0, 'rx'); // 10
  add(tcp('c', C + 2 + REQ.length, S + 2 + RESP.length, 'A')); // 11
  return out;
}

function browsingStore() {
  return createCaptureStoreImpl({ id: 'i_1', name: 'browse', source: 'import', interfaces: [ETH0, ETH1], records: browsingCapture() });
}

describe('stream keys', () => {
  it('normalise the two endpoints numerically, IPv4 before IPv6, with bracketed IPv6', () => {
    expect(streamKey('tcp', '10.0.0.80:80', '10.0.0.1:49152')).toBe('tcp:10.0.0.1:49152-10.0.0.80:80');
    expect(streamKey('tcp', '10.0.0.1:49152', '10.0.0.80:80')).toBe('tcp:10.0.0.1:49152-10.0.0.80:80');
    // numeric, not text order: 10.0.0.9 < 10.0.0.10
    expect(streamKey('udp', '10.0.0.10:53', '10.0.0.9:1024')).toBe('udp:10.0.0.9:1024-10.0.0.10:53');
    expect(streamKey('tcp', '10.0.0.1:80', '10.0.0.1:1024')).toBe('tcp:10.0.0.1:80-10.0.0.1:1024');
    expect(streamKey('tcp', '[2001:db8::80]:80', '[2001:db8::1]:49152')).toBe('tcp:[2001:db8::1]:49152-[2001:db8::80]:80');
    expect(compareAddresses('10.0.0.1', '::1')).toBeLessThan(0);
    expect(compareAddresses('2001:db8::2', '2001:db8::10')).toBeLessThan(0);
    expect(parseStreamKey('tcp:[2001:db8::1]:49152-[2001:db8::80]:80')).toEqual({ proto: 'tcp', endpoints: ['[2001:db8::1]:49152', '[2001:db8::80]:80'] });
    expect(parseStreamKey('icmp:1-2')).toBeUndefined();
    expect(parseStreamKey('tcp:10.0.0.1-10.0.0.2')).toBeUndefined();
  });

  it('both directions of a TCP conversation share the row stream key; IPv6 rows get bracketed keys', () => {
    const recs = browsingCapture();
    const a = decodeCaptureRecord(recs[0]!, ETH0).row;
    const b = decodeCaptureRecord(recs[1]!, ETH0).row;
    expect(a.stream).toBe(KEY);
    expect(b.stream).toBe(KEY);
    expect(a).toMatchObject({ proto: 'tcp', src: PC, dst: SRV, len: recs[0]!.origLen, layers: ['ethernet', 'ipv4', 'tcp'] });
    const req = decodeCaptureRecord(recs[3]!, ETH0).row;
    expect(req.proto).toBe('http');
    expect(req.info).toContain('GET');
    const v6 = tcp('c', 1, 0, 'S', '', { v6: true });
    expect(decodeCaptureRecord(rec(0, v6), ETH0).row.stream).toBe('tcp:[2001:db8::1]:49152-[2001:db8::80]:80');
  });

  it('transport and IP layers inside an ICMP error quote do not count', () => {
    const lv = (proto: string, fields: Record<string, string | number> = {}): LayerView =>
      ({ proto, offset: 0, length: 0, headerLength: 0, fields, fieldRanges: {} }) as unknown as LayerView;
    const layers = [lv('ethernet', { src: MAC_S, dst: MAC_C }), lv('ipv4', { src: '10.0.0.254', dst: PC }), lv('icmpv4'), lv('ipv4', { src: PC, dst: SRV }), lv('udp', { srcPort: 1, dstPort: 2 })];
    expect(transportLayerIndex(layers)).toBe(-1);
    expect(networkLayerIndex(layers)).toBe(1);
    expect(frameAddresses(layers)).toEqual({ src: '10.0.0.254', dst: PC });
    expect(frameAddresses([lv('ethernet', { src: MAC_C, dst: 'ff:ff:ff:ff:ff:ff' }), lv('arp')])).toEqual({ src: MAC_C, dst: 'ff:ff:ff:ff:ff:ff' });
    expect(frameAddresses([lv('dot11', { addr1: MAC_S, addr2: MAC_C })])).toEqual({ src: MAC_C, dst: MAC_S });
  });
});

describe('follow stream: TCP reassembly (RFC 9293)', () => {
  it('reassembles request and response in order, counts one retransmission, ignores the second capture point', () => {
    const s = browsingStore();
    const r = s.follow(KEY);
    expect(r.proto).toBe('tcp');
    expect(r.endpoints).toEqual(['192.168.1.2:49152', '192.168.1.80:80']);
    expect(r.retransmissions).toBe(1);
    expect(r.chunks).toEqual([
      { from: 0, index: 3, text: REQ, bytes: REQ.length },
      { from: 1, index: 7, text: RESP, bytes: RESP.length },
    ]);
    expect(r.http).toEqual([
      { kind: 'request', startLine: 'GET / HTTP/1.1', headers: 'Host: www.lab.nf', body: '', index: 3 },
      { kind: 'response', startLine: 'HTTP/1.1 200 OK', headers: `Content-Type: text/html\nContent-Length: ${BODY.length}`, body: BODY, index: 7 },
    ]);
  });

  it('the first endpoint is the SYN sender even when the server speaks first in the capture', () => {
    const recs = browsingCapture();
    // Put the SYN-ACK first.
    const swapped = [recs[1]!, recs[0]!, ...recs.slice(2)].map((r, i) => ({ ...r, index: i }));
    const frames = swapped.map((r) => ({ index: r.index, iface: r.iface, dir: r.dir, bytes: r.bytes, layers: decodeCaptureRecord(r, ETH0).layers }));
    expect(followStream(KEY, frames).endpoints).toEqual(['192.168.1.2:49152', '192.168.1.80:80']);
  });

  it('places data by sequence number across the 2^32 wrap', () => {
    const isn = 0xfffffff0;
    const first = 'ABCDEFGHIJKLMNOPQRST'; // 20 bytes starting at isn+1
    const second = 'abcdefghijkl';
    const seq2 = (isn + 1 + first.length) >>> 0;
    expect(seq2).toBe(5);
    expect(seqDiff(seq2, (isn + 1) >>> 0)).toBe(20);
    const recs = [tcp('c', isn, 0, 'S'), tcp('c', seq2, 1, 'PA', second), tcp('c', (isn + 1) >>> 0, 1, 'PA', first)].map((p, i) => rec(i, p));
    const frames = recs.map((r) => ({ index: r.index, iface: 0, dir: r.dir, bytes: r.bytes, layers: decodeCaptureRecord(r, ETH0).layers }));
    const r = followStream(KEY, frames);
    expect(r.chunks).toEqual([{ from: 0, index: 2, text: first + second, bytes: 32 }]);
    expect(r.retransmissions).toBe(0);
  });

  it('a partial overlap contributes only its new tail and counts as a retransmission', () => {
    const recs = [tcp('c', 99, 0, 'S'), tcp('c', 100, 1, 'PA', 'hello '), tcp('c', 103, 1, 'PA', 'lo world')].map((p, i) => rec(i, p));
    const frames = recs.map((r) => ({ index: r.index, iface: 0, dir: r.dir, bytes: r.bytes, layers: decodeCaptureRecord(r, ETH0).layers }));
    const r = followStream(KEY, frames);
    expect(r.chunks).toEqual([{ from: 0, index: 1, text: 'hello world', bytes: 11 }]);
    expect(r.retransmissions).toBe(1);
  });

  it('without a SYN the first data segment is the origin; a gap that never fills is appended in order at the end', () => {
    const recs = [tcp('c', 500, 1, 'PA', 'one '), tcp('c', 510, 1, 'PA', 'three')].map((p, i) => rec(i, p));
    const frames = recs.map((r) => ({ index: r.index, iface: 0, dir: r.dir, bytes: r.bytes, layers: decodeCaptureRecord(r, ETH0).layers }));
    const r = followStream(KEY, frames);
    expect(r.chunks.map((c) => c.text).join('')).toBe('one three');
    expect(r.http).toBeUndefined();
  });

  it('an unknown or malformed key gives an empty result', () => {
    const s = browsingStore();
    expect(s.follow('tcp:1.1.1.1:1-2.2.2.2:2')).toEqual({ key: 'tcp:1.1.1.1:1-2.2.2.2:2', proto: 'tcp', endpoints: ['1.1.1.1:1', '2.2.2.2:2'], chunks: [], retransmissions: 0 });
    expect(s.follow('nonsense').chunks).toEqual([]);
  });

  it('shows control characters as dots', () => {
    expect(streamText(Uint8Array.of(0x41, 0x00, 0x0d, 0x0a, 0x09, 0x7f, 0x42))).toBe('A.\r\n\t.B');
  });
});

describe('follow stream: UDP', () => {
  it('lists each datagram as its own chunk, from the first sender', () => {
    const recs = [udp(true, 'ping?'), udp(false, 'pong!'), udp(true, 'again')].map((p, i) => rec(i, p));
    const s = createCaptureStore({ id: 'i_2', name: 'udp', source: 'import', interfaces: [ETH0], records: recs });
    const key = 'udp:192.168.1.2:50000-192.168.1.80:9999';
    expect(s.query({ from: 0, limit: 10 }).rows.map((r) => r.stream)).toEqual([key, key, key]);
    const r = s.follow(key);
    expect(r.proto).toBe('udp');
    expect(r.endpoints).toEqual(['192.168.1.2:50000', '192.168.1.80:9999']);
    expect(r.chunks).toEqual([
      { from: 0, index: 0, text: 'ping?', bytes: 5 },
      { from: 1, index: 1, text: 'pong!', bytes: 5 },
      { from: 0, index: 2, text: 'again', bytes: 5 },
    ]);
    expect(r.http).toBeUndefined();
  });
});

describe('capture store: queries and display filters', () => {
  it('tcp.flags.syn == 1 returns exactly the SYN and the SYN-ACK; the address form gives the same', () => {
    const s = browsingStore();
    const syn = s.query({ filter: 'tcp.flags.syn == 1', from: 0, limit: 100 });
    expect(syn.rows.map((r) => r.index)).toEqual([0, 1]);
    expect(syn).toMatchObject({ next: 12, scanned: 12, matched: 2 });
    expect(syn.filterError).toBeUndefined();
    const both = s.query({ filter: 'ip.addr == 192.168.1.80 && tcp.flags.syn == 1', from: 0, limit: 100 });
    expect(both.rows.map((r) => r.index)).toEqual([0, 1]);
    expect(s.query({ filter: 'http', from: 0, limit: 100 }).rows.map((r) => r.index)).toEqual([3, 4, 6, 7, 8]);
    expect(s.query({ filter: 'frame.interface == 1', from: 0, limit: 100 }).rows.map((r) => r.index)).toEqual([4]);
  });

  it('an invalid filter reports its column and matches nothing', () => {
    const s = browsingStore();
    const r = s.query({ filter: 'tcp.port == ', from: 0, limit: 10 });
    expect(r.rows).toEqual([]);
    expect(r.filterError).toBeDefined();
    expect(r.filterError!.column).toBe(12);
    expect(s.stats('tcp.port ==').total).toBe(0);
    expect(() => s.export({ format: 'pcapng', filter: 'tcp.port ==' })).toThrow(/filter is not valid/);
  });

  it('pages with limit and next, and validates the cursor', () => {
    const s = browsingStore();
    const p1 = s.query({ from: 0, limit: 5 });
    expect(p1.rows.map((r) => r.index)).toEqual([0, 1, 2, 3, 4]);
    expect(p1.next).toBe(5);
    const p2 = s.query({ from: p1.next, limit: 100 });
    expect(p2.rows.map((r) => r.index)).toEqual([5, 6, 7, 8, 9, 10, 11]);
    expect(p2.next).toBe(12);
    expect(s.query({ from: 12, limit: 5 })).toMatchObject({ rows: [], next: 12, scanned: 0 });
    expect(s.query({ from: 0, limit: 0 }).next).toBe(0);
    expect(() => s.query({ from: 0.5, limit: 1 })).toThrow(RangeError);
    expect(() => s.query({ from: 0, limit: -1 })).toThrow(RangeError);
    expect(CAPTURE_QUERY_SCAN_BUDGET).toBeGreaterThan(1000);
  });

  it('record() decodes one frame with its bytes, layers and summary', () => {
    const s = browsingStore();
    const d = s.record(3)!;
    expect(d.row.index).toBe(3);
    expect(d.layers.map((l) => l.proto)).toEqual(['ethernet', 'ipv4', 'tcp', 'http']);
    expect(d.summary).toBe(d.row.info);
    expect(d.bytes).toEqual(browsingCapture()[3]!.bytes);
    expect(s.record(12)).toBeUndefined();
    expect(s.record(-1)).toBeUndefined();
  });

  it('drops the oldest records beyond maxRecords and maxBytes', () => {
    const s = createCaptureStoreImpl({ id: 'c_1', name: 'ring', source: 'live', interfaces: [ETH0], maxRecords: 3 });
    const recs = browsingCapture();
    for (const r of recs.slice(0, 5)) s.append({ ...r, iface: 0, index: 999 });
    expect(s.info()).toMatchObject({ head: 5, oldest: 2, dropped: 2, running: true, source: 'live' });
    expect(s.query({ from: 0, limit: 10 }).rows.map((r) => r.index)).toEqual([2, 3, 4]);
    expect(s.record(1)).toBeUndefined();
    s.setRunning(false);
    s.append(recs[5]!);
    expect(s.info().head).toBe(5);

    const b = createCaptureStoreImpl({ id: 'c_2', name: 'bytes', source: 'live', interfaces: [ETH0], maxBytes: recs[0]!.bytes.length * 2 + 1 });
    for (const r of recs.slice(0, 4)) b.append({ ...r, iface: 0 });
    // Frames 0-2 are 64-byte minimum frames: two fit the byte budget; the request frame alone exceeds it but is kept.
    expect(b.info()).toMatchObject({ head: 4, oldest: 3, dropped: 3 });
    expect(() => createCaptureStoreImpl({ id: 'x', name: 'x', source: 'live', interfaces: [ETH0], maxRecords: 0 })).toThrow(RangeError);
  });

  it('an imported store never runs; unknown interfaces are refused', () => {
    const s = browsingStore();
    expect(s.info().running).toBe(false);
    s.setRunning(true);
    expect(s.info().running).toBe(false);
    expect(() => createCaptureStore({ id: 'x', name: 'x', source: 'import', interfaces: [ETH0], records: [{ ...browsingCapture()[0]!, iface: 7 }] })).toThrow(/interface 7/);
  });

  it('exports pcapng and pcap that read back to the same frames; the filter picks the records', () => {
    const s = browsingStore();
    const all = browsingCapture();
    const ng = readCapture(s.export({ format: 'pcapng' }));
    expect(ng.interfaces.map((i) => [i.name, i.linkType, i.fcsLen])).toEqual([['PC1 Gi0', 'ethernet', 4], ['SW1 Fa0/1', 'ethernet', 4]]);
    expect(ng.records.map((r) => r.bytes)).toEqual(all.map((r) => r.bytes));
    expect(ng.records.map((r) => r.t)).toEqual(all.map((r) => r.t));
    expect(ng.records.map((r) => r.dir)).toEqual(all.map((r) => r.dir));
    const syn = readCapture(s.export({ format: 'pcapng', filter: 'tcp.flags.syn == 1' }));
    expect(syn.records.map((r) => r.bytes)).toEqual([all[0]!.bytes, all[1]!.bytes]);
    const classic = readCapture(s.export({ format: 'pcap' }));
    expect(classic.records.map((r) => r.bytes.length)).toEqual(all.map((r) => r.bytes.length - 4));
    // Re-importing the export gives the same rows.
    const again = createCaptureStore({ id: 'i_9', name: 'again', source: 'import', interfaces: ng.interfaces, records: ng.records });
    expect(again.query({ from: 0, limit: 100 }).rows.map((r) => [r.proto, r.info])).toEqual(s.query({ from: 0, limit: 100 }).rows.map((r) => [r.proto, r.info]));
  });

  it('the decode cache is bounded and least-recently-used', () => {
    const cache = createDecodeCache(2);
    const recs = browsingCapture();
    const a = cache.get(recs[0]!, ETH0);
    cache.get(recs[1]!, ETH0);
    expect(cache.get(recs[0]!, ETH0)).toBe(a);
    cache.get(recs[2]!, ETH0); // evicts record 1
    expect(cache.size).toBe(2);
    expect(cache.get(recs[0]!, ETH0)).toBe(a);
    expect(() => createDecodeCache(0)).toThrow(RangeError);
  });
});

describe('statistics', () => {
  it('builds the protocol hierarchy, conversations, endpoints and length buckets', () => {
    const s = browsingStore();
    const st = s.stats();
    const all = browsingCapture();
    expect(st.total).toBe(12);
    expect(st.bytes).toBe(all.reduce((n, r) => n + r.origLen, 0));
    expect(st.durationNs).toBe(11_000);
    expect(st.hierarchy.map((h) => h.path)).toEqual(['ethernet', 'ethernet/ipv4', 'ethernet/ipv4/tcp', 'ethernet/ipv4/tcp/http']);
    expect(st.hierarchy[0]).toMatchObject({ frames: 12, bytes: st.bytes });
    expect(st.hierarchy[3]!.frames).toBe(5);
    expect(st.conversations.map((c) => [c.proto, c.a, c.b, c.frames])).toEqual([
      ['ethernet', MAC_C, MAC_S, 12],
      ['ipv4', PC, SRV, 12],
      ['tcp', '192.168.1.2:49152', '192.168.1.80:80', 12],
    ]);
    expect(st.conversations[0]).toMatchObject({ firstNs: 0, lastNs: 11_000 });
    expect(st.endpoints.map((e) => [e.proto, e.address, e.frames])).toEqual([
      ['ethernet', MAC_C, 12],
      ['ethernet', MAC_S, 12],
      ['ipv4', PC, 12],
      ['ipv4', SRV, 12],
    ]);
    expect(st.lengths.map((l) => l.bucket)).toEqual(CAPTURE_LENGTH_BUCKETS.map(([b]) => b));
    expect(st.lengths.reduce((n, l) => n + l.frames, 0)).toBe(12);
    expect(lengthBucketIndex(64)).toBe(2);
    expect(lengthBucketIndex(1518)).toBe(7);
    expect(lengthBucketIndex(9000)).toBe(9);

    const filtered = s.stats('tcp.flags.syn == 1');
    expect(filtered.total).toBe(2);
    expect(filtered.hierarchy.map((h) => h.path)).toEqual(['ethernet', 'ethernet/ipv4', 'ethernet/ipv4/tcp']);
    expect(computeCaptureStatistics([])).toMatchObject({ total: 0, bytes: 0, durationNs: 0, hierarchy: [], conversations: [], endpoints: [] });
  });
});
