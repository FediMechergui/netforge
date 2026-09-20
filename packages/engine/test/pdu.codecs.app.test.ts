/**
 * P1 W2 pdu: DHCPv4 (RFC 2131/2132), DNS (RFC 1035, AAAA RFC 3596, TCP framing RFC 7766) and HTTP/1.1
 * (RFC 9112) codecs, including partial-HTTP handling across TCP segments and the pure HTTP parsers.
 *
 * Golden bytes were built independently (Python `struct` / hand-assembled hex), not by the codecs.
 */
import { describe, expect, it } from 'vitest';
import { ETHERTYPE_IPV4, IPPROTO_TCP, IPPROTO_UDP } from '../src/contracts/pdu.js';
import type { LayerSpec, LayerView, PduMeta } from '../src/contracts/pdu.js';
import { PROTO_FIELDS } from '../src/contracts/fields.js';
import { decodeLayers, decodeStandalone, encodeLayers } from '../src/pdu/codecs/registry.js';
import {
  BOOTP_MIN_MESSAGE,
  DHCP_MESSAGE_TYPES,
  dhcpCodec,
  dhcpMessageTypeCode,
  dhcpMessageTypeName,
} from '../src/pdu/codecs/dhcp.js';
import {
  dnsCodec,
  dnsRcodeName,
  dnsTypeCode,
  dnsTypeName,
  formatDnsQuestions,
  formatDnsRecords,
  normalizeDnsName,
  parseDnsQuestions,
  parseDnsRecords,
} from '../src/pdu/codecs/dns.js';
import { httpCodec, httpHeader, httpReasonPhrase, parseHttpMessage, parseHttpStream } from '../src/pdu/codecs/http.js';
import { createPduFactory } from '../src/pdu/factory.js';

const hex = (s: string): Uint8Array => new Uint8Array((s.replace(/\s+/g, '').match(/.{2}/g) ?? []).map((h) => parseInt(h, 16)));
const toHex = (b: Uint8Array): string => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const ascii = (s: string): Uint8Array => new TextEncoder().encode(s);
const protos = (layers: readonly LayerView[]): string[] => layers.map((l) => l.proto);
const meta = (): PduMeta => ({ born: 0, origin: 'd_pc1' });
const layerBytes = (bytes: Uint8Array, l: LayerView): Uint8Array => bytes.slice(l.offset, l.offset + l.length);

const PC_MAC = '00:1f:00:00:00:01';
const R_MAC = '00:1f:00:00:00:0a';

const udpFrame = (src: string, dst: string, sp: number, dp: number, app: LayerSpec): LayerSpec[] => [
  { proto: 'ethernet', fields: { dst: 'ff:ff:ff:ff:ff:ff', src: PC_MAC, type: ETHERTYPE_IPV4 } },
  { proto: 'ipv4', fields: { src, dst, protocol: IPPROTO_UDP, ttl: 128 } },
  { proto: 'udp', fields: { srcPort: sp, dstPort: dp } },
  app,
];

const tcpSeg = (sp: number, dp: number, data: Uint8Array, flags = 'PA'): LayerSpec[] => [
  { proto: 'ipv4', fields: { src: '192.168.1.2', dst: '192.168.1.80', protocol: IPPROTO_TCP } },
  { proto: 'tcp', fields: { srcPort: sp, dstPort: dp, flags, seq: 1, ack: 1 } },
  { proto: 'payload', fields: { data } },
];

// ── DHCP ─────────────────────────────────────────────────────────────────────

const DISCOVER_HEX =
  '010106003903f3260000800000000000000000000000000000000000001f00000001' +
  '00'.repeat(10) + '00'.repeat(64) + '00'.repeat(128) +
  '63825363' + '350101' + '0c03504331' + '3705' + '0103060f33' + 'ff';

describe('dhcp codec', () => {
  it('encodes a DISCOVER byte-identical to the independent layout, padded to 300 bytes', () => {
    const bytes = encodeLayers([{
      proto: 'dhcp',
      fields: { op: 1, xid: 0x3903f326, broadcastFlag: true, chaddr: PC_MAC, messageType: 'DISCOVER', hostname: 'PC1', parameterRequestList: '1,3,6,15,51' },
    }]);
    expect(bytes.length).toBe(BOOTP_MIN_MESSAGE);
    expect(toHex(bytes)).toBe(DISCOVER_HEX + '00'.repeat(300 - DISCOVER_HEX.length / 2));
    const d = decodeLayers(bytes, 'dhcp')[0]!;
    expect(d.fields).toEqual({
      op: 1, htype: 1, hlen: 6, hops: 0, xid: 0x3903f326, secs: 0, broadcastFlag: true,
      ciaddr: '0.0.0.0', yiaddr: '0.0.0.0', siaddr: '0.0.0.0', giaddr: '0.0.0.0', chaddr: PC_MAC, sname: '', file: '',
      messageType: 'DISCOVER', hostname: 'PC1', parameterRequestList: '1,3,6,15,51',
    });
    expect(d.error).toBeUndefined();
    expect(d.headerLength).toBe(240);
    expect(d.fieldRanges.messageType).toEqual([240, 3]);
    expect(d.fieldRanges.chaddr).toEqual([28, 16]);
  });

  it('round-trips an OFFER with every server option (§4.3 step 3)', () => {
    const fields = {
      op: 2, xid: 7, broadcastFlag: true, yiaddr: '192.168.1.2', siaddr: '0.0.0.0', giaddr: '0.0.0.0', chaddr: PC_MAC,
      messageType: 'OFFER', serverId: '192.168.1.1', leaseTimeS: 86400, renewalTimeS: 43200, rebindingTimeS: 75600,
      subnetMask: '255.255.255.0', router: '192.168.1.1', dnsServers: '192.168.1.10,192.168.1.11', domainName: 'lab.nf',
    };
    const d = decodeLayers(encodeLayers([{ proto: 'dhcp', fields }]), 'dhcp')[0]!;
    expect(d.fields).toMatchObject(fields);
    expect(dhcpCodec.summarize(d.fields)).toBe('DHCP OFFER 192.168.1.2 xid=0x00000007');
  });

  it('relay fields: giaddr and hops; REQUEST with requested address and client id', () => {
    const d = decodeLayers(encodeLayers([{
      proto: 'dhcp',
      fields: { op: 1, xid: 1, hops: 1, giaddr: '10.0.0.1', chaddr: PC_MAC, messageType: 'REQUEST', requestedIp: '192.168.1.2', serverId: '192.168.1.1', clientId: '01001f00000001' },
    }]), 'dhcp')[0]!;
    expect(d.fields).toMatchObject({ hops: 1, giaddr: '10.0.0.1', requestedIp: '192.168.1.2', clientId: '01001f00000001' });
    expect(dhcpCodec.summarize(d.fields)).toBe('DHCP REQUEST for 192.168.1.2 xid=0x00000001 via relay 10.0.0.1');
  });

  it('decodes pad options, skips unknown options, keeps the first router and stops at End', () => {
    const head = hex(DISCOVER_HEX).slice(0, 240);
    const opts = hex('00 00 350102 2b0401020304 03080a0000010a000002 ff 350105');
    const msg = new Uint8Array(head.length + opts.length);
    msg.set(head, 0);
    msg.set(opts, head.length);
    const d = dhcpCodec.decode(msg, 0, msg.length);
    expect(d.fields.messageType).toBe('OFFER');
    expect(d.fields.router).toBe('10.0.0.1');
    expect(d.error).toBeUndefined();
  });

  it('reports truncated messages, missing magic cookie and overlong options', () => {
    expect(dhcpCodec.decode(new Uint8Array(100), 0, 100).error).toBe('DHCP message truncated');
    const bootp = hex(DISCOVER_HEX).slice(0, 244);
    bootp[236] = 0;
    const b = dhcpCodec.decode(bootp, 0, bootp.length);
    expect(b.error).toBe('BOOTP message without the DHCP magic cookie');
    expect(b.fields.chaddr).toBe(PC_MAC);
    expect(dhcpCodec.summarize(b.fields)).toBe('DHCP BOOTP request xid=0x3903f326');
    const over = hex(DISCOVER_HEX).slice(0, 240 + 2);
    over[240] = 12;
    over[241] = 50;
    expect(dhcpCodec.decode(over, 0, over.length).error).toBe('DHCP option 12 truncated');
  });

  it('validates builder input', () => {
    const base = { op: 1, xid: 1, chaddr: PC_MAC, messageType: 'DISCOVER' };
    expect(() => encodeLayers([{ proto: 'dhcp', fields: { ...base, messageType: 'HELLO' } }])).toThrow(/messageType unknown/);
    expect(() => encodeLayers([{ proto: 'dhcp', fields: { ...base, op: 3 } }])).toThrow(/op must be 1/);
    expect(() => encodeLayers([{ proto: 'dhcp', fields: { ...base, chaddr: 'nope' } }])).toThrow(/chaddr is not a valid MAC/);
    expect(() => encodeLayers([{ proto: 'dhcp', fields: { ...base, dnsServers: '1.2.3' } }])).toThrow(/dnsServers entry/);
    expect(() => encodeLayers([{ proto: 'dhcp', fields: { op: 1, chaddr: PC_MAC, messageType: 'DISCOVER' } }])).toThrow(/dhcp\.xid is required/);
    expect(DHCP_MESSAGE_TYPES).toEqual(['DISCOVER', 'OFFER', 'REQUEST', 'DECLINE', 'ACK', 'NAK', 'RELEASE', 'INFORM']);
    expect(dhcpMessageTypeCode('ack')).toBe(5);
    expect(dhcpMessageTypeName(9)).toBe('TYPE-9');
  });

  it('decodes inside ethernet/ipv4/udp 68→67 and summarizes the DISCOVER (§4.3 step 2)', () => {
    const p = createPduFactory().build(udpFrame('0.0.0.0', '255.255.255.255', 68, 67, {
      proto: 'dhcp', fields: { op: 1, xid: 0x1234abcd, broadcastFlag: true, chaddr: PC_MAC, messageType: 'DISCOVER' },
    }), meta());
    expect(protos(p.layers)).toEqual(['ethernet', 'ipv4', 'udp', 'dhcp']);
    expect(p.get('udp.checksumValid')).toBe(true);
    expect(p.topProto()).toBe('dhcp');
    expect(p.summary()).toBe(`DHCP DISCOVER from ${PC_MAC} xid=0x1234abcd`);
  });
});

// ── DNS ──────────────────────────────────────────────────────────────────────

const DNS_QUERY_HEX = '1a2b0100000100000000000003777777036c6162026e660000010001';
const DNS_RESPONSE_HEX =
  '1a2b8580000100010000000003777777036c6162026e660000010001c00c000100010000012c0004c0a80150';

describe('dns codec', () => {
  it('encodes the §4.4 query byte-identical to the RFC 1035 layout', () => {
    const bytes = encodeLayers([{ proto: 'dns', fields: { id: 0x1a2b, rd: true, questions: 'www.lab.nf A' } }]);
    expect(toHex(bytes)).toBe(DNS_QUERY_HEX);
    const d = decodeLayers(bytes, 'dns')[0]!;
    expect(d.fields).toEqual({
      id: 0x1a2b, qr: false, opcode: 0, aa: false, tc: false, rd: true, ra: false, rcode: 0,
      questions: 'www.lab.nf A', answers: '', authorities: '', additionals: '',
    });
    expect(dnsCodec.summarize(d.fields)).toBe('DNS query 0x1a2b www.lab.nf A');
  });

  it('decodes a compressed response (pointer to offset 12) into the answers string', () => {
    const d = decodeLayers(hex(DNS_RESPONSE_HEX), 'dns')[0]!;
    expect(d.error).toBeUndefined();
    expect(d.fields).toMatchObject({ qr: true, aa: true, rd: true, ra: true, rcode: 0, answers: 'www.lab.nf A 300 192.168.1.80' });
    expect(dnsCodec.summarize(d.fields)).toBe('DNS response 0x1a2b www.lab.nf A: 192.168.1.80');
    // re-encoding never compresses: longer, same fields
    const again = encodeLayers([{ proto: 'dns', fields: { ...d.fields } }]);
    expect(again.length).toBe(hex(DNS_RESPONSE_HEX).length + 10);
    expect(decodeLayers(again, 'dns')[0]!.fields).toEqual(d.fields);
  });

  it('round-trips every simulated record type across all three sections', () => {
    const fields = {
      id: 9, qr: true, aa: true, ra: true,
      questions: 'lab.nf MX;www.lab.nf AAAA',
      answers:
        'lab.nf MX 300 10 mail.lab.nf;www.lab.nf CNAME 60 web.lab.nf;web.lab.nf AAAA 60 2001:db8::80;' +
        '80.1.168.192.in-addr.arpa PTR 300 web.lab.nf',
      authorities: 'lab.nf NS 3600 ns1.lab.nf;lab.nf SOA 3600 ns1.lab.nf admin.lab.nf 1 3600 600 86400 60',
      additionals: 'ns1.lab.nf A 3600 192.168.1.10;x.lab.nf TYPE99 5 c0ffee',
    };
    const d = decodeLayers(encodeLayers([{ proto: 'dns', fields }]), 'dns')[0]!;
    expect(d.error).toBeUndefined();
    expect(d.fields).toMatchObject(fields);
  });

  it('NXDOMAIN and the name helpers', () => {
    const d = decodeLayers(encodeLayers([{ proto: 'dns', fields: { id: 1, qr: true, rcode: 3, questions: 'nope.lab.nf A' } }]), 'dns')[0]!;
    expect(dnsCodec.summarize(d.fields)).toBe('DNS response 0x0001 nope.lab.nf A NXDOMAIN');
    expect(dnsRcodeName(2)).toBe('SERVFAIL');
    expect(dnsTypeName(28)).toBe('AAAA');
    expect(dnsTypeName(99)).toBe('TYPE99');
    expect(dnsTypeCode('mx')).toBe(15);
    expect(dnsTypeCode('TYPE70000')).toBeUndefined();
    expect(normalizeDnsName('WWW.Lab.NF.')).toBe('www.lab.nf');
    expect(normalizeDnsName('')).toBe('.');
    expect(parseDnsQuestions('a.b A; c.d AAAA')).toEqual([{ name: 'a.b', type: 'A' }, { name: 'c.d', type: 'AAAA' }]);
    expect(formatDnsQuestions([{ name: 'A.B.', type: 'a' }])).toBe('a.b A');
    const recs = parseDnsRecords('lab.nf MX 300 10 mail.lab.nf');
    expect(recs).toEqual([{ name: 'lab.nf', type: 'MX', ttl: 300, data: '10 mail.lab.nf' }]);
    expect(formatDnsRecords(recs)).toBe('lab.nf MX 300 10 mail.lab.nf');
    expect(() => parseDnsRecords('x A notanumber 1.2.3.4')).toThrow(/bad ttl/);
  });

  it('carries a 2-byte length prefix over TCP and flags a message split across segments as partial', () => {
    const f = createPduFactory();
    const full = f.build([
      { proto: 'ipv4', fields: { src: '192.168.1.2', dst: '192.168.1.10', protocol: IPPROTO_TCP } },
      { proto: 'tcp', fields: { srcPort: 49152, dstPort: 53, flags: 'PA' } },
      { proto: 'dns', fields: { id: 0x1a2b, rd: true, questions: 'www.lab.nf A' } },
    ], meta());
    expect(protos(full.layers)).toEqual(['ipv4', 'tcp', 'dns']);
    const dns = full.layer('dns')!;
    expect(toHex(layerBytes(full.bytes, dns))).toBe('001c' + DNS_QUERY_HEX);
    expect(dns.fields.tcpLength).toBe(28);
    expect(dns.error).toBeUndefined();
    const cut = f.build(tcpSeg(49152, 53, hex('001c' + DNS_QUERY_HEX.slice(0, 30))), meta());
    const partial = cut.layer('dns')!;
    expect(partial.error).toBe('partial');
    expect(partial.fields.id).toBe(0x1a2b);
  });

  it('reports truncation, compression loops and bad labels', () => {
    expect(dnsCodec.decode(hex('1a2b01'), 0, 3).error).toBe('DNS header truncated');
    const trunc = hex(DNS_QUERY_HEX.slice(0, 40));
    expect(dnsCodec.decode(trunc, 0, trunc.length).error).toBe('DNS message truncated');
    const loop = hex('0001 0100 0001 0000 0000 0000 c00c 0001 0001');
    expect(dnsCodec.decode(loop, 0, loop.length).error).toBe('DNS name compression loop');
    expect(() => encodeLayers([{ proto: 'dns', fields: { id: 1, questions: `${'a'.repeat(64)}.nf A` } }])).toThrow(/longer than 63/);
    expect(() => encodeLayers([{ proto: 'dns', fields: { id: 1, answers: 'x.nf A 5 1.2.3' } }])).toThrow(/A record data "1.2.3" is not valid/);
    expect(() => encodeLayers([{ proto: 'dns', fields: { id: 1, questions: 'x.nf BOGUS' } }])).toThrow(/unknown/);
  });

  it('decodes inside ethernet/ipv4/udp 53 with the summary as topProto', () => {
    const p = createPduFactory().build(udpFrame('192.168.1.2', '192.168.1.10', 49152, 53, {
      proto: 'dns', fields: { id: 0x1a2b, rd: true, questions: 'www.lab.nf A' },
    }), meta());
    expect(protos(p.layers)).toEqual(['ethernet', 'ipv4', 'udp', 'dns']);
    expect(p.topProto()).toBe('dns');
    expect(p.summary()).toBe('DNS query 0x1a2b www.lab.nf A');
  });
});

// ── HTTP ─────────────────────────────────────────────────────────────────────

const GET_TEXT = 'GET / HTTP/1.1\r\nHost: www.lab.nf\r\nUser-Agent: NetForge-Browser/1\r\nAccept: */*\r\nConnection: close\r\n\r\n';
const BODY = '<html><body><h1>Lab web page</h1></body></html>';
const RESPONSE_TEXT =
  `HTTP/1.1 200 OK\r\nServer: NetForge-HTTP\r\nContent-Type: text/html\r\nContent-Length: ${BODY.length}\r\nConnection: close\r\n\r\n${BODY}`;

describe('http codec', () => {
  it('encodes the §4.5 browser request as the exact HTTP/1.1 text', () => {
    const bytes = encodeLayers([{
      proto: 'http',
      fields: { kind: 'request', method: 'GET', target: '/', headers: 'Host: www.lab.nf\nUser-Agent: NetForge-Browser/1\nAccept: */*\nConnection: close' },
    }]);
    expect(new TextDecoder().decode(bytes)).toBe(GET_TEXT);
    const d = decodeLayers(bytes, 'http')[0]!;
    expect(d.fields).toEqual({
      kind: 'request', method: 'GET', target: '/', version: 'HTTP/1.1',
      headers: 'Host: www.lab.nf\nUser-Agent: NetForge-Browser/1\nAccept: */*\nConnection: close', body: '',
    });
    expect(d.error).toBeUndefined();
    expect(d.headerLength).toBe(GET_TEXT.length);
    expect(httpCodec.summarize(d.fields)).toBe('HTTP GET / HTTP/1.1');
  });

  it('decodes a response with Content-Length inside tcp from port 80', () => {
    const p = createPduFactory().build(tcpSeg(80, 49152, ascii(RESPONSE_TEXT)), meta());
    expect(protos(p.layers)).toEqual(['ipv4', 'tcp', 'http']);
    const h = p.layer('http')!;
    expect(h.error).toBeUndefined();
    expect(h.fields).toMatchObject({ kind: 'response', status: 200, reason: 'OK', version: 'HTTP/1.1', body: BODY });
    expect(httpHeader(String(h.fields.headers), 'content-type')).toBe('text/html');
    expect(h.fieldRanges.body).toEqual([h.offset + RESPONSE_TEXT.length - BODY.length, BODY.length]);
    expect(p.summary()).toBe('HTTP HTTP/1.1 200 OK');
    expect(p.topProto()).toBe('http');
  });

  it('marks a response split across two TCP segments as partial in both', () => {
    const f = createPduFactory();
    const all = ascii(RESPONSE_TEXT);
    const cutAt = RESPONSE_TEXT.indexOf('<h1>');
    const first = f.build(tcpSeg(80, 49152, all.slice(0, cutAt)), meta()).layer('http')!;
    expect(first.error).toBe('partial');
    expect(first.fields).toMatchObject({ kind: 'response', status: 200, body: '<html><body>' });
    const second = f.build(tcpSeg(80, 49152, all.slice(cutAt)), meta());
    const cont = second.layer('http')!;
    expect(cont.error).toBe('partial');
    expect(cont.fields.kind).toBeUndefined();
    expect(cont.fields.body).toBe(BODY.slice(BODY.indexOf('<h1>')));
    expect(second.summary()).toBe(`HTTP continuation ${all.length - cutAt} bytes`);
    // cut inside the header block and inside the start line
    const inHeaders = parseHttpMessage(all.slice(0, 40))!;
    expect(inHeaders.complete).toBe(false);
    expect(inHeaders.headers).toBe('Server: NetForge-HTTP');
    const inStart = f.build(tcpSeg(80, 49152, ascii('HTTP/1.1 2')), meta()).layer('http')!;
    expect(inStart.error).toBe('partial');
    expect(inStart.fields.kind).toBe('response');
  });

  it('de-chunks Transfer-Encoding: chunked and knows bodiless statuses', () => {
    const chunked = ascii('HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n5\r\nhello\r\n6;x=1\r\n world\r\n0\r\n\r\n');
    const m = parseHttpMessage(chunked)!;
    expect(m.body).toBe('hello world');
    expect(m.complete).toBe(true);
    expect(m.consumed).toBe(chunked.length);
    const half = parseHttpMessage(chunked.slice(0, chunked.length - 5))!;
    expect(half.complete).toBe(false);
    const nc = parseHttpMessage(ascii('HTTP/1.1 304 Not Modified\r\nContent-Length: 10\r\n\r\n'))!;
    expect(nc.complete).toBe(true);
    expect(nc.body).toBe('');
  });

  it('close-delimited responses run to the end; requests without length have no body', () => {
    const r = parseHttpMessage(ascii('HTTP/1.1 200 OK\r\n\r\nabc'))!;
    expect(r.body).toBe('abc');
    expect(r.complete).toBe(true);
    const q = parseHttpMessage(ascii('GET /a HTTP/1.1\r\nHost: x\r\n\r\nextra'))!;
    expect(q.body).toBe('');
    expect(q.consumed).toBe('GET /a HTTP/1.1\r\nHost: x\r\n\r\n'.length);
    expect(parseHttpMessage(ascii('\x16\x03\x01binary'))).toBeNull();
  });

  it('parseHttpStream splits pipelined messages and stops at an incomplete one', () => {
    const two = ascii(`${GET_TEXT}GET /b HTTP/1.1\r\nHost: x\r\n\r\n`);
    expect(parseHttpStream(two).map((m) => m.target)).toEqual(['/', '/b']);
    const withBody = ascii('POST /f HTTP/1.1\r\nContent-Length: 3\r\n\r\nabcGET / HTTP/1.1\r\n\r\n');
    const ms = parseHttpStream(withBody);
    expect(ms.map((m) => [m.method, m.body])).toEqual([['POST', 'abc'], ['GET', '']]);
    const partial = parseHttpStream(ascii(`${RESPONSE_TEXT.slice(0, RESPONSE_TEXT.length - 3)}`));
    expect(partial).toHaveLength(1);
    expect(partial[0]!.complete).toBe(false);
  });

  it('encodes responses with a default reason phrase, UTF-8 bodies and validation', () => {
    const bytes = encodeLayers([{ proto: 'http', fields: { kind: 'response', status: 404, headers: 'Content-Length: 5', body: 'héllo'.slice(0, 5) } }]);
    const d = decodeLayers(bytes, 'http')[0]!;
    expect(d.fields).toMatchObject({ status: 404, reason: 'Not Found' });
    expect(httpReasonPhrase(200)).toBe('OK');
    expect(httpReasonPhrase(299)).toBe('');
    const utf8 = encodeLayers([{ proto: 'http', fields: { kind: 'response', status: 200, body: 'café' } }]);
    expect(decodeLayers(utf8, 'http')[0]!.fields.body).toBe('café');
    expect(() => encodeLayers([{ proto: 'http', fields: { kind: 'bogus' } }])).toThrow(/kind must be/);
    expect(() => encodeLayers([{ proto: 'http', fields: { kind: 'response' } }])).toThrow(/http\.status is required/);
    expect(() => encodeLayers([{ proto: 'http', fields: { kind: 'request', target: '/a b' } }])).toThrow(/without spaces/);
    expect(() => encodeLayers([{ proto: 'http', fields: { kind: 'request', method: 'GET\r\n' } }])).toThrow(/line break/);
    expect(new TextDecoder().decode(encodeLayers([{ proto: 'http', fields: { kind: 'request' } }]))).toBe('GET / HTTP/1.1\r\n\r\n');
  });

  it('decodeStandalone of a whole browser frame decodes the http layer', () => {
    const p = createPduFactory().build([
      { proto: 'ethernet', fields: { dst: R_MAC, src: PC_MAC, type: ETHERTYPE_IPV4 } },
      { proto: 'ipv4', fields: { src: '192.168.1.2', dst: '192.168.1.80', protocol: IPPROTO_TCP } },
      { proto: 'tcp', fields: { srcPort: 49152, dstPort: 80, flags: 'PA', seq: 1, ack: 1 } },
      { proto: 'http', fields: { kind: 'request', method: 'GET', target: '/', headers: 'Host: www.lab.nf' } },
    ], meta());
    const d = decodeStandalone(p.bytes, 'ethernet');
    expect(protos(d.layers)).toEqual(['ethernet', 'ipv4', 'tcp', 'http']);
    expect(d.summary).toBe('HTTP GET / HTTP/1.1');
    expect(d.layers[2]!.fields.checksumValid).toBe(true);
  });
});

describe('application field names follow contracts/fields.ts', () => {
  it('every decoded dhcp/dns/http field is a PROTO_FIELDS name', () => {
    const samples: [string, LayerView][] = [
      ['dhcp', decodeLayers(encodeLayers([{ proto: 'dhcp', fields: { op: 2, xid: 1, chaddr: PC_MAC, messageType: 'ACK', serverId: '1.1.1.1', leaseTimeS: 1, renewalTimeS: 1, rebindingTimeS: 1, subnetMask: '255.0.0.0', router: '1.1.1.1', dnsServers: '1.1.1.1', domainName: 'x', hostname: 'y', parameterRequestList: '1', clientId: '01', requestedIp: '1.1.1.2' } }]), 'dhcp')[0]!],
      ['dns', decodeLayers(hex(DNS_RESPONSE_HEX), 'dns')[0]!],
      ['http', decodeLayers(ascii(RESPONSE_TEXT), 'http')[0]!],
      ['http', decodeLayers(ascii(GET_TEXT), 'http')[0]!],
    ];
    for (const [proto, l] of samples) {
      const names = new Set(PROTO_FIELDS[proto]!.fields.map((x) => x.name));
      for (const k of Object.keys(l.fields)) expect(names.has(k), `${proto}.${k}`).toBe(true);
    }
    expect(Object.keys(dnsCodec.derived!)).toEqual(['tcpLength']);
    expect(PROTO_FIELDS.dns!.fields.find((x) => x.name === 'tcpLength')!.derived).toBe(true);
  });
});
