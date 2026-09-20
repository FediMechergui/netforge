import { describe, expect, it } from 'vitest';
import type { LayerView, FieldValue } from '../src/contracts/pdu.js';
import { PROTO_FIELDS } from '../src/contracts/fields.js';
import { tokenizeDisplayFilter } from '../src/capture/filter/lexer.js';
import { parseDisplayFilter } from '../src/capture/filter/parser.js';
import {
  DISPLAY_FIELDS,
  formatFilterIpv6,
  lookupDisplayField,
  parseFilterIpv6,
  type DisplayFilterFrame,
} from '../src/capture/filter/fields.js';
import { compileDisplayFilter, evaluateDisplayFilter } from '../src/capture/filter/eval.js';
import { completeDisplayFilter } from '../src/capture/filter/complete.js';
import { findBannedWords } from '../src/device/catalog/validate.js';

// ── fixtures: hand-built decoded layers (the codec registry is not needed to test the filter) ──

function layer(proto: string, fields: Record<string, FieldValue>, offset: number, length: number, headerLength: number, trailerLength?: number): LayerView {
  const base = { proto, offset, length, headerLength, fields, fieldRanges: {} };
  return trailerLength === undefined ? base : { ...base, trailerLength };
}

const PC = '192.168.1.10';
const SRV = '192.168.1.80';
const PC_MAC = '02:00:00:00:00:0a';
const SRV_MAC = '02:00:00:00:00:50';

function tcpFrame(n: number, flags: string, opts: { from?: 'pc' | 'srv'; payload?: string; http?: Record<string, FieldValue>; t?: number } = {}): DisplayFilterFrame {
  const fromPc = (opts.from ?? 'pc') === 'pc';
  const payload = opts.payload ?? '';
  const bodyLen = payload.length;
  const tcpLen = 20 + bodyLen;
  const ipLen = 20 + tcpLen;
  const frameLen = Math.max(64, 14 + ipLen + 4);
  const bytes = new Uint8Array(frameLen);
  bytes.set(new TextEncoder().encode(payload), 54);
  const layers: LayerView[] = [
    layer('ethernet', { dst: fromPc ? SRV_MAC : PC_MAC, src: fromPc ? PC_MAC : SRV_MAC, type: 0x0800, fcsValid: true }, 0, frameLen, 14, frameLen - 14 - ipLen),
    layer('ipv4', { version: 4, ttl: 128, protocol: 6, src: fromPc ? PC : SRV, dst: fromPc ? SRV : PC, totalLength: ipLen }, 14, ipLen, 20),
    layer('tcp', { srcPort: fromPc ? 49152 : 80, dstPort: fromPc ? 80 : 49152, seq: 1000 + n, ack: 0, flags, window: 65535 }, 34, tcpLen, 20),
  ];
  if (opts.http !== undefined) layers.push(layer('http', opts.http, 54, bodyLen, bodyLen));
  return { number: n, len: frameLen, timeRelativeNs: opts.t ?? n * 100_000_000, iface: 0, ifaceName: 'PC1 Gi0', dir: fromPc ? 'tx' : 'rx', layers, bytes };
}

const arpFrame: DisplayFilterFrame = {
  number: 1,
  len: 64,
  timeRelativeNs: 0,
  iface: 0,
  dir: 'tx',
  layers: [
    layer('ethernet', { dst: 'ff:ff:ff:ff:ff:ff', src: PC_MAC, type: 0x0806 }, 0, 64, 14, 22),
    layer('arp', { op: 1, sha: PC_MAC, spa: PC, tha: '00:00:00:00:00:00', tpa: SRV }, 14, 28, 28),
  ],
};

const GET = 'GET / HTTP/1.1\r\nHost: www.lab.nf\r\n\r\n';
const OK = 'HTTP/1.1 200 OK\r\nServer: nf-web\r\n\r\nhello';
const CAPTURE: DisplayFilterFrame[] = [
  arpFrame,
  tcpFrame(2, 'S'),
  tcpFrame(3, 'SA', { from: 'srv' }),
  tcpFrame(4, 'A'),
  tcpFrame(5, 'PA', { payload: GET, http: { kind: 'request', method: 'GET', target: '/', version: 'HTTP/1.1', headers: 'Host: www.lab.nf', body: '' } }),
  tcpFrame(6, 'PA', { from: 'srv', payload: OK, http: { kind: 'response', status: 200, reason: 'OK', version: 'HTTP/1.1', headers: 'Server: nf-web', body: 'hello' } }),
  tcpFrame(7, 'FA'),
  tcpFrame(8, 'R', { from: 'srv' }),
];

function numbers(filter: string, frames: readonly DisplayFilterFrame[] = CAPTURE): number[] {
  const c = compileDisplayFilter(filter);
  expect(c.error, filter).toBeUndefined();
  return frames.filter((f) => c.test(f)).map((f) => f.number);
}

function errorOf(filter: string): { message: string; column: number; length: number } {
  const r = parseDisplayFilter(filter);
  if (r.ok) throw new Error(`expected '${filter}' to fail`);
  return r.error;
}

describe('display filter lexer', () => {
  it('splits words, strings, operators and punctuation with 0-based spans', () => {
    const r = tokenizeDisplayFilter('ip.addr==10.0.0.1 && !(tcp.port in {80,443}) || http.host contains "a\\"b"');
    expect(r.error).toBeUndefined();
    expect(r.tokens.map((t) => [t.kind, t.value])).toEqual([
      ['word', 'ip.addr'], ['op', '=='], ['word', '10.0.0.1'], ['op', '&&'], ['op', '!'], ['lparen', '('], ['word', 'tcp.port'],
      ['word', 'in'], ['lbrace', '{'], ['word', '80'], ['comma', ','], ['word', '443'], ['rbrace', '}'], ['rparen', ')'], ['op', '||'],
      ['word', 'http.host'], ['word', 'contains'], ['string', 'a"b'],
    ]);
    expect(r.tokens[0]).toMatchObject({ start: 0, end: 7 });
    expect(r.tokens[1]).toMatchObject({ start: 7, end: 9 });
  });

  it('keeps IPv6, MAC and prefix literals as one word', () => {
    const r = tokenizeDisplayFilter('ipv6.addr == fe80::1/64 eth.src == aa-bb-cc-dd-ee-ff');
    expect(r.tokens.map((t) => t.text)).toEqual(['ipv6.addr', '==', 'fe80::1/64', 'eth.src', '==', 'aa-bb-cc-dd-ee-ff']);
  });

  it('reports an unterminated string at its opening quote and a stray character', () => {
    const r = tokenizeDisplayFilter('http.host == "www');
    expect(r.error).toEqual({ message: 'This text value is missing its closing quote.', column: 13, length: 4 });
    expect(r.openStringAt).toBe(13);
    expect(r.tokens).toHaveLength(2);
    expect(tokenizeDisplayFilter('tcp $').error).toMatchObject({ column: 4, length: 1 });
    expect(tokenizeDisplayFilter('"\\x4"').error?.message).toContain('two hexadecimal digits');
    expect(tokenizeDisplayFilter('"\\x41\\n"').tokens[0]?.value).toBe('A\n');
  });
});

describe('display filter parser', () => {
  it('parses an empty filter to null', () => {
    expect(parseDisplayFilter('')).toEqual({ ok: true, ast: null });
    expect(parseDisplayFilter('   ')).toEqual({ ok: true, ast: null });
  });

  it('builds comparisons with typed values', () => {
    expect(parseDisplayFilter('tcp.flags.syn == 1')).toEqual({ ok: true, ast: { op: '==', field: 'tcp.flags.syn', value: { type: 'bool', value: true } } });
    expect(parseDisplayFilter('ip.src eq 10.0.0.0/8')).toEqual({ ok: true, ast: { op: '==', field: 'ip.src', value: { type: 'ipv4', value: '10.0.0.0', prefixLen: 8 } } });
    expect(parseDisplayFilter('ipv6.addr == 2001:DB8:0:0:0::1')).toEqual({ ok: true, ast: { op: '==', field: 'ipv6.addr', value: { type: 'ipv6', value: '2001:db8::1' } } });
    expect(parseDisplayFilter('eth.src != AA-BB-CC-DD-EE-FF')).toEqual({ ok: true, ast: { op: '!=', field: 'eth.src', value: { type: 'mac', value: 'aa:bb:cc:dd:ee:ff' } } });
    expect(parseDisplayFilter('ethernet.type == 0x86dd')).toEqual({ ok: true, ast: { op: '==', field: 'ethernet.type', value: { type: 'number', value: 0x86dd } } });
    expect(parseDisplayFilter('frame.time_relative ge 1.5')).toEqual({ ok: true, ast: { op: '>=', field: 'frame.time_relative', value: { type: 'number', value: 1.5 } } });
    expect(parseDisplayFilter('http.request.method contains "GE"')).toEqual({ ok: true, ast: { op: 'contains', field: 'http.request.method', value: { type: 'string', value: 'GE' } } });
    expect(parseDisplayFilter('ip.src == "10.0.0.1"')).toEqual({ ok: true, ast: { op: '==', field: 'ip.src', value: { type: 'ipv4', value: '10.0.0.1' } } });
  });

  it('gives not > and > or precedence, with parentheses overriding', () => {
    const r = parseDisplayFilter('arp || tcp && !udp');
    expect(r).toEqual({
      ok: true,
      ast: { op: 'or', left: { op: 'present', field: 'arp' }, right: { op: 'and', left: { op: 'present', field: 'tcp' }, right: { op: 'not', expr: { op: 'present', field: 'udp' } } } },
    });
    const p = parseDisplayFilter('(arp or tcp) and not udp');
    expect(p).toEqual({
      ok: true,
      ast: { op: 'and', left: { op: 'or', left: { op: 'present', field: 'arp' }, right: { op: 'present', field: 'tcp' } }, right: { op: 'not', expr: { op: 'present', field: 'udp' } } },
    });
  });

  it('parses membership sets and not in', () => {
    expect(parseDisplayFilter('tcp.port in {80, 443 8080}')).toEqual({
      ok: true,
      ast: { op: 'in', field: 'tcp.port', values: [{ type: 'number', value: 80 }, { type: 'number', value: 443 }, { type: 'number', value: 8080 }] },
    });
    expect(parseDisplayFilter('ip.addr not in {10.0.0.0/8 192.168.1.1}')).toEqual({
      ok: true,
      ast: { op: 'not', expr: { op: 'in', field: 'ip.addr', values: [{ type: 'ipv4', value: '10.0.0.0', prefixLen: 8 }, { type: 'ipv4', value: '192.168.1.1' }] } },
    });
  });

  it('reports errors with their column and span', () => {
    expect(errorOf('tcp && foo.bar == 1')).toEqual({ message: "'foo.bar' is not a field or protocol that NetScope knows.", column: 7, length: 7 });
    expect(errorOf('ip.src = 1.2.3.4')).toEqual({ message: "Use '==' to test for equality.", column: 7, length: 1 });
    expect(errorOf('tcp.port ==')).toMatchObject({ column: 11, length: 0 });
    expect(errorOf('(tcp || udp')).toMatchObject({ message: "This '(' is never closed.", column: 0, length: 1 });
    expect(errorOf('tcp)')).toMatchObject({ message: "There is no '(' for this ')'.", column: 3 });
    expect(errorOf('ip.src == 300.1.1.1')).toMatchObject({ column: 10, length: 9 });
    expect(errorOf('ip.src > 10.0.0.0/8').message).toBe('A prefix length (/len) can only be used with ==, != and in.');
    expect(errorOf('tcp == 1')).toMatchObject({ column: 4, length: 2 });
    expect(errorOf('tcp.port contains "8"')).toMatchObject({ column: 9, length: 8 });
    expect(errorOf('tcp.flags.syn > 0').message).toContain('cannot be ordered');
    expect(errorOf('http.host == www')).toMatchObject({ message: 'Text values go in double quotes, e.g. "www".', column: 13 });
    expect(errorOf('tcp udp')).toMatchObject({ message: "Expected '&&', '||' or the end of the filter here.", column: 4 });
    expect(errorOf('tcp &&')).toMatchObject({ column: 6, length: 0 });
    expect(errorOf('ip.src == 1.2.3.4 & tcp')).toMatchObject({ column: 18 });
    expect(errorOf('tcp.flags.syn == 2').message).toContain('1, 0, true or false');
    expect(errorOf('10.0.0.1 == ip.src').message).toContain('starts with a field');
    expect(errorOf('()').message).toContain('Empty parentheses');
    expect(errorOf('tcp.port in {}').message).toContain('empty');
    expect(errorOf('tcp.port in {80')).toMatchObject({ column: 12 });
  });

  it('names the unsupported constructs', () => {
    expect(errorOf('http.host matches "a.*"').message).toContain('Regular-expression');
    expect(errorOf('http.host ~ "a"')).toMatchObject({ column: 10, length: 1 });
    expect(errorOf('eth.src[0:2] == 02:00').message).toContain('Byte slices');
    expect(errorOf('len(tcp) > 3').message).toBe("Functions such as 'len()' are not supported.");
    expect(errorOf('tcp.port in {1..9}').message).toContain('Ranges');
    expect(errorOf('tcp xor udp').message).toContain('Exclusive or');
    expect(errorOf('tcp.port === 80').message).toContain("'==='");
    // A grammar error before an unterminated string wins; otherwise the lexical error is reported.
    expect(errorOf('tcp.port = "x')).toMatchObject({ column: 9 });
    expect(errorOf('http.host == "x')).toMatchObject({ message: 'This text value is missing its closing quote.', column: 13 });
  });
});

describe('display field registry', () => {
  it('covers every canonical PROTO_FIELDS path and protocol with a mapped type', () => {
    for (const table of Object.values(PROTO_FIELDS)) {
      expect(lookupDisplayField(table.proto)?.type, table.proto).toBe('protocol');
      for (const f of table.fields) {
        const d = lookupDisplayField(`${table.proto}.${f.name}`);
        expect(d, `${table.proto}.${f.name}`).toBeDefined();
        const expected = f.type === 'uint' || f.type === 'int' ? 'number' : f.type === 'bytes' ? 'string' : f.type;
        expect(d?.type).toBe(expected);
        expect(d?.reads).toEqual([`${table.proto}.${f.name}`]);
      }
    }
  });

  it('has the documented aliases and unique names with original help text', () => {
    expect(lookupDisplayField('ip.addr')).toMatchObject({ reads: ['ipv4.src', 'ipv4.dst'], type: 'ipv4' });
    expect(lookupDisplayField('ipv6.addr')).toMatchObject({ reads: ['ipv6.src', 'ipv6.dst'], type: 'ipv6' });
    expect(lookupDisplayField('eth.addr')).toMatchObject({ reads: ['ethernet.src', 'ethernet.dst'], type: 'mac' });
    expect(lookupDisplayField('tcp.port')).toMatchObject({ reads: ['tcp.srcPort', 'tcp.dstPort'], type: 'number' });
    expect(lookupDisplayField('udp.port')?.type).toBe('number');
    for (const flag of ['syn', 'ack', 'fin', 'rst']) expect(lookupDisplayField(`tcp.flags.${flag}`)).toMatchObject({ reads: ['tcp.flags'], type: 'bool' });
    expect(lookupDisplayField('icmp')?.type).toBe('protocol');
    expect(lookupDisplayField('dns.qry.name')?.type).toBe('string');
    expect(lookupDisplayField('http.request.method')?.type).toBe('string');
    expect(lookupDisplayField('http.response.code')?.type).toBe('number');
    for (const n of ['frame.number', 'frame.len', 'frame.time_relative', 'frame.interface']) expect(lookupDisplayField(n)?.type).toBe('number');
    const names = DISPLAY_FIELDS.map((d) => d.name);
    expect(new Set(names).size).toBe(names.length);
    for (const d of DISPLAY_FIELDS) {
      expect(d.help.length, d.name).toBeGreaterThan(0);
      expect(findBannedWords(d.help), d.name).toEqual([]);
    }
    expect(lookupDisplayField('nope')).toBeUndefined();
  });

  it('parses and formats IPv6 per RFC 4291 text forms and RFC 5952 output', () => {
    const cases: [string, string][] = [
      ['2001:0db8:0000:0000:0000:0000:0000:0001', '2001:db8::1'],
      ['2001:db8:0:0:1:0:0:1', '2001:db8::1:0:0:1'],
      ['2001:db8:0:1:1:1:1:1', '2001:db8:0:1:1:1:1:1'],
      ['FE80::0200:5EFF:FE00:5301', 'fe80::200:5eff:fe00:5301'],
      ['::', '::'],
      ['::1', '::1'],
      ['1::', '1::'],
      ['::ffff:192.0.2.1', '::ffff:c000:201'],
      ['2001:db8::1:0:0:0:1', '2001:db8:0:1::1'],
    ];
    for (const [input, out] of cases) {
      const b = parseFilterIpv6(input);
      expect(b, input).not.toBeNull();
      expect(formatFilterIpv6(b as Uint8Array), input).toBe(out);
    }
    for (const bad of ['1:2:3:4:5:6:7:8:9', '1::2::3', 'fe80::1%eth0', 'g::1', '12345::', '1:2:3:4:5:6:7', '']) expect(parseFilterIpv6(bad), bad).toBeNull();
  });
});

describe('display filter evaluation', () => {
  it('tcp.flags.syn == 1 selects exactly the SYN and the SYN-ACK', () => {
    expect(numbers('tcp.flags.syn == 1')).toEqual([2, 3]);
    expect(numbers(`ip.addr == ${SRV} && tcp.flags.syn == 1`)).toEqual([2, 3]);
    expect(numbers('tcp.flags.syn == 0')).toEqual([4, 5, 6, 7, 8]);
    expect(numbers('tcp.flags.rst == 1 || tcp.flags.fin == true')).toEqual([7, 8]);
    expect(numbers('tcp.flags == "SA"')).toEqual([3]);
    expect(numbers('tcp.flags contains "A"')).toEqual([3, 4, 5, 6, 7]);
  });

  it('tests presence of protocols and fields', () => {
    expect(numbers('arp')).toEqual([1]);
    expect(numbers('tcp')).toEqual([2, 3, 4, 5, 6, 7, 8]);
    expect(numbers('ip')).toEqual([2, 3, 4, 5, 6, 7, 8]);
    expect(numbers('!tcp')).toEqual([1]);
    expect(numbers('http')).toEqual([5, 6]);
    expect(numbers('http.request')).toEqual([5]);
    expect(numbers('http.response')).toEqual([6]);
    expect(numbers('tcp.flags.syn')).toEqual([2, 3, 4, 5, 6, 7, 8]);
    expect(numbers('frame')).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it('treats multi-valued fields as any-of for == and none-of for !=', () => {
    expect(numbers(`ip.addr == ${PC}`)).toEqual([2, 3, 4, 5, 6, 7, 8]);
    expect(numbers(`ip.src == ${PC}`)).toEqual([2, 4, 5, 7]);
    expect(numbers(`ip.addr != ${PC}`)).toEqual([1]);
    expect(numbers(`ip.src != ${PC}`)).toEqual([1, 3, 6, 8]);
    expect(numbers(`!(ip.src == ${PC})`)).toEqual([1, 3, 6, 8]);
    expect(numbers('tcp.port == 80')).toEqual([2, 3, 4, 5, 6, 7, 8]);
    expect(numbers('tcp.dstport == 80')).toEqual([2, 4, 5, 7]);
    expect(numbers(`eth.addr == ${SRV_MAC}`)).toEqual([2, 3, 4, 5, 6, 7, 8]);
    expect(numbers(`eth.dst == ${SRV_MAC.toUpperCase()}`)).toEqual([2, 4, 5, 7]);
  });

  it('matches subnets, orders numbers and addresses, and handles sets', () => {
    expect(numbers('ip.src == 192.168.1.64/26')).toEqual([3, 6, 8]);
    expect(numbers('ip.dst == 192.168.0.0/16 && arp')).toEqual([]);
    expect(numbers('arp.tpa == 192.168.1.0/24')).toEqual([1]);
    expect(numbers('ip.src > 192.168.1.50')).toEqual([3, 6, 8]);
    expect(numbers('tcp.seq >= 1006')).toEqual([6, 7, 8]);
    expect(numbers('tcp.seq < 1003 and tcp.seq > 1001')).toEqual([2]);
    expect(numbers('tcp.srcport in {80 443}')).toEqual([3, 6, 8]);
    expect(numbers('tcp.srcport not in {80 443}')).toEqual([1, 2, 4, 5, 7]);
    expect(numbers(`ip.src in {10.0.0.1 ${SRV}}`)).toEqual([3, 6, 8]);
    expect(numbers('frame.number <= 2 || frame.number == 0x8')).toEqual([1, 2, 8]);
    expect(numbers('frame.time_relative > 0.55')).toEqual([6, 7, 8]);
    expect(numbers('frame.len > 64')).toEqual([5, 6]);
    expect(numbers('frame.direction == "rx"')).toEqual([3, 6, 8]);
    expect(numbers('frame.interface_name contains "Gi0"')).toEqual([2, 3, 4, 5, 6, 7, 8]);
  });

  it('reads HTTP aliases, header values and protocol bytes', () => {
    expect(numbers('http.request.method == "GET"')).toEqual([5]);
    expect(numbers('http.request.uri == "/"')).toEqual([5]);
    expect(numbers('http.response.code == 200')).toEqual([6]);
    expect(numbers('http.response.code >= 400')).toEqual([]);
    expect(numbers('http.host == "www.lab.nf"')).toEqual([5]);
    expect(numbers('http.server contains "web"')).toEqual([6]);
    expect(numbers('frame contains "Host:"')).toEqual([5]);
    expect(numbers('tcp contains "hello"')).toEqual([6]);
    expect(numbers('http contains "HTTP/1.1 200"')).toEqual([6]);
    expect(numbers('ip contains "zzz"')).toEqual([]);
  });

  it('reads DNS names and records, byte payloads and quoted IPv6 layers', () => {
    const dns: DisplayFilterFrame = {
      number: 1,
      len: 90,
      timeRelativeNs: 0,
      iface: 0,
      layers: [
        layer('ipv6', { src: '2001:db8::53', dst: '2001:db8:1::10', nextHeader: 17, hopLimit: 64 }, 0, 90, 40),
        layer('udp', { srcPort: 53, dstPort: 50000 }, 40, 50, 8),
        layer('dns', { id: 7, qr: true, rcode: 0, questions: 'www.lab.nf A', answers: 'www.lab.nf CNAME 300 web.lab.nf;web.lab.nf A 300 10.0.0.80;web.lab.nf AAAA 300 2001:db8::80' }, 48, 42, 12),
      ],
    };
    const data: DisplayFilterFrame = {
      number: 2,
      len: 20,
      timeRelativeNs: 0,
      iface: 1,
      layers: [layer('payload', { data: new TextEncoder().encode('abcé') }, 0, 5, 5)],
    };
    const frames = [dns, data];
    expect(numbers('dns.qry.name == "www.lab.nf"', frames)).toEqual([1]);
    expect(numbers('dns.qry.type == "A"', frames)).toEqual([1]);
    expect(numbers('dns.a == 10.0.0.0/8', frames)).toEqual([1]);
    expect(numbers('dns.aaaa == 2001:db8:0::80', frames)).toEqual([1]);
    expect(numbers('dns.cname == "web.lab.nf"', frames)).toEqual([1]);
    expect(numbers('dns.flags.response == 1 && udp.srcport == 53', frames)).toEqual([1]);
    expect(numbers('ipv6.addr == 2001:db8:1::/48', frames)).toEqual([1]);
    expect(numbers('ipv6.src == 2001:DB8::53', frames)).toEqual([1]);
    expect(numbers('ipv6.dst > 2001:db8::ffff', frames)).toEqual([1]);
    expect(numbers('payload.data contains "bcé"', frames)).toEqual([2]);
    expect(numbers('payload.data == "abcé"', frames)).toEqual([2]);
    expect(numbers('data', frames)).toEqual([2]);
    expect(numbers('frame.interface == 1', frames)).toEqual([2]);
  });

  it('sees every occurrence of a protocol (ICMP error quoting a datagram)', () => {
    const icmpErr: DisplayFilterFrame = {
      number: 1,
      len: 70,
      timeRelativeNs: 0,
      iface: 0,
      layers: [
        layer('ipv4', { src: '10.0.0.1', dst: '192.168.1.10', protocol: 1, ttl: 255 }, 0, 70, 20),
        layer('icmpv4', { type: 11, code: 0 }, 20, 50, 8),
        layer('ipv4', { src: '192.168.1.10', dst: '8.8.8.8', protocol: 17, ttl: 1 }, 28, 28, 20),
        layer('udp', { srcPort: 49152, dstPort: 33434 }, 48, 8, 8),
      ],
    };
    expect(numbers('ip.dst == 8.8.8.8', [icmpErr])).toEqual([1]);
    expect(numbers('icmp.type == 11 && ip.ttl == 1', [icmpErr])).toEqual([1]);
    expect(numbers('ip.src != 10.0.0.1', [icmpErr])).toEqual([]);
  });

  it('compiles once: invalid text matches nothing and carries the error; evaluate works on a raw AST', () => {
    const bad = compileDisplayFilter('tcp.port ==');
    expect(bad.error).toMatchObject({ column: 11, length: 0 });
    expect(CAPTURE.filter((f) => bad.test(f))).toEqual([]);
    const all = compileDisplayFilter('');
    expect(all.ast).toBeNull();
    expect(CAPTURE.every((f) => all.test(f))).toBe(true);
    expect(evaluateDisplayFilter({ op: 'present', field: 'arp' }, arpFrame)).toBe(true);
    expect(evaluateDisplayFilter(null, arpFrame)).toBe(true);
    expect(() => evaluateDisplayFilter({ op: 'present', field: 'no.such' }, arpFrame)).toThrow(/unknown field/);
  });
});

describe('display filter completion', () => {
  const labels = (text: string, cursor?: number): string[] => completeDisplayFilter(text, cursor).items.map((i) => i.label);

  it('offers tcp.flags.* for a field prefix, replacing the typed word', () => {
    const c = completeDisplayFilter('ip.addr == 10.0.0.1 && tcp.fl');
    expect(c.from).toBe(23);
    expect(c.to).toBe(29);
    const items = c.items.map((i) => i.label);
    for (const f of ['tcp.flags', 'tcp.flags.syn', 'tcp.flags.ack', 'tcp.flags.fin', 'tcp.flags.rst']) expect(items).toContain(f);
    expect(items.every((l) => l.startsWith('tcp.fl'))).toBe(true);
    expect(c.items.every((i) => i.kind === 'field' && i.help.length > 0)).toBe(true);
    expect([...items].sort()).toEqual(items);
  });

  it('extends the replaced span over the rest of the word after the cursor', () => {
    const c = completeDisplayFilter('tcp.flxx == 1', 6);
    expect(c).toMatchObject({ from: 0, to: 8 });
    expect(c.items.map((i) => i.label)).toContain('tcp.flags.syn');
  });

  it('offers protocols and not at the start, and operators the field type allows', () => {
    const start = labels('');
    expect(start).toContain('tcp');
    expect(start).toContain('frame');
    expect(start).toContain('not');
    expect(start).not.toContain('tcp.port');
    expect(labels('tcp.port ')).toEqual(['==', '!=', '<', '<=', '>', '>=', 'in', '&&', '||', 'and', 'or']);
    expect(labels('tcp.flags.syn ')).toEqual(['==', '!=', 'in', '&&', '||', 'and', 'or']);
    expect(labels('http ')).toEqual(['contains', '&&', '||', 'and', 'or']);
    expect(labels('tcp.port =')).toEqual(['==']);
    expect(labels('tcp.port <')).toEqual(['<', '<=']);
    expect(labels('tcp.port c')).toEqual([]);
    expect(labels('ip.src != 1.2.3.4 || !')).toContain('udp');
  });

  it('offers values after an operator and joins after a complete test', () => {
    expect(labels('tcp.flags.syn == ')).toEqual(['1', '0', 'true', 'false']);
    expect(labels('dhcp.type == "RE')).toEqual(['"REQUEST"', '"RELEASE"']);
    expect(completeDisplayFilter('dhcp.type == "RE')).toMatchObject({ from: 13, to: 16 });
    expect(labels('http.request.method == ')).toContain('"GET"');
    expect(labels('tcp.port == 80 ')).toEqual(['&&', '||', 'and', 'or']);
    expect(labels('(tcp.port == 80 ')).toEqual(['&&', '||', 'and', 'or', ')']);
    expect(labels('tcp.port in ')).toEqual(['{']);
    expect(labels('tcp.port in {80 ')).toEqual(['}']);
    expect(labels('tcp.port not ')).toEqual(['in']);
    expect(labels('tcp.port == 80 a')).toEqual(['and']);
    expect(labels('nope ')).toEqual([]);
  });
});
