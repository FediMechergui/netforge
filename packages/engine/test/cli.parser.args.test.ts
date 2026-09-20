/**
 * cli/parser.ts P1 arg types (ARCHITECTURE-P1 §4.10, §6; contracts/cli.ts `ArgType`): ipv6 and ipv6-prefix
 * (RFC 4291 text, RFC 5952 output), ip, host and hostname (RFC 1035 §2.3.1 / RFC 1123 §2.1), url (RFC 3986
 * subset), hex, secret (rest-of-line tail, history spans), int-range and quoted values, with their placeholders,
 * error columns and completion behaviour.
 */
import { describe, expect, it } from 'vitest';
import type { ArgSpec, CommandSpec } from '../src/contracts/cli.js';
import {
  complete,
  formatIntRange,
  help,
  isHostName,
  matchCommand,
  MSG_BAD_HOST,
  MSG_BAD_HOSTNAME,
  MSG_BAD_IP,
  MSG_BAD_IPV6,
  MSG_BAD_IPV6_PREFIX,
  MSG_BAD_SECRET,
  MSG_BAD_URL,
  MSG_INCOMPLETE,
  MSG_STRAY_QUOTE,
  MSG_UNCLOSED_QUOTE,
  normalizeIpLiteral,
  normalizeIpv6Prefix,
  normalizeUrl,
  parseIntRange,
  placeholderFor,
  validateArg,
  type MatchContext,
  type MatchResult,
} from '../src/cli/parser.js';

const arg = (type: ArgSpec['type'], extra: Partial<ArgSpec> = {}): ArgSpec => ({ type, help: `A ${type} value`, ...extra });

/** One spec per arg type; `grammars` is omitted so the default grammars apply (the context has none). */
const SPECS: CommandSpec[] = [
  { path: ['v6', '<a>'], mode: 'priv-exec', privilege: 1, help: 'IPv6 address', args: { a: arg('ipv6') }, handler: 'h' },
  { path: ['v6p', '<p>'], mode: 'priv-exec', privilege: 1, help: 'IPv6 prefix', args: { p: arg('ipv6-prefix') }, handler: 'h' },
  { path: ['anyip', '<a>'], mode: 'priv-exec', privilege: 1, help: 'Any IP', args: { a: arg('ip') }, handler: 'h' },
  { path: ['reach', '<h>'], mode: 'priv-exec', privilege: 1, help: 'Host', args: { h: arg('host') }, handler: 'h' },
  { path: ['name', '<n>'], mode: 'priv-exec', privilege: 1, help: 'Host name', args: { n: arg('hostname') }, handler: 'h' },
  { path: ['browse', '<u>'], mode: 'priv-exec', privilege: 1, help: 'URL', args: { u: arg('url') }, handler: 'h' },
  { path: ['hexval', '<x>'], mode: 'priv-exec', privilege: 1, help: 'Hex', args: { x: arg('hex') }, handler: 'h' },
  { path: ['bytehex', '<x>'], mode: 'priv-exec', privilege: 1, help: 'Hex byte', args: { x: arg('hex', { min: 0, max: 255 }) }, handler: 'h' },
  { path: ['range', '<r>'], mode: 'priv-exec', privilege: 1, help: 'Range', args: { r: arg('int-range', { min: 1, max: 10 }) }, handler: 'h' },
  { path: ['keytail', '<s>'], mode: 'priv-exec', privilege: 1, help: 'Secret tail', args: { s: arg('secret') }, handler: 'h' },
  { path: ['keymid', '<s>', 'level', '<n>'], mode: 'priv-exec', privilege: 1, help: 'Secret token', args: { s: arg('secret'), n: arg('int', { min: 0, max: 15 }) }, handler: 'h' },
  { path: ['label', '<t>'], mode: 'priv-exec', privilege: 1, help: 'Quoted', args: { t: arg('quoted', { maxLength: 20 }) }, handler: 'h' },
  { path: ['tag', '<t>', '<n>'], mode: 'priv-exec', privilege: 1, help: 'Quoted then number', args: { t: arg('quoted'), n: arg('int') }, handler: 'h' },
  { path: ['show', 'names'], mode: 'priv-exec', privilege: 1, help: 'Names', handler: 'h', filterable: true },
];

const CTX: MatchContext = { mode: 'priv-exec', privilege: 15, resolveInterface: () => undefined };

function ok(line: string): Extract<MatchResult, { ok: true }> {
  const m = matchCommand(SPECS, CTX, line);
  if (!m.ok) throw new Error(`${line}: ${m.error.message}`);
  return m;
}

function fail(line: string): Extract<MatchResult, { ok: false }> {
  const m = matchCommand(SPECS, CTX, line);
  if (m.ok) throw new Error(`${line} matched ${JSON.stringify(m.args)}`);
  return m;
}

describe('ipv6 and ipv6-prefix (RFC 4291 §2.2 input, RFC 5952 output)', () => {
  it('normalises to the RFC 5952 canonical form', () => {
    expect(ok('v6 2001:0DB8:0000:0000:0000:ff00:0042:8329').args['a']).toBe('2001:db8::ff00:42:8329');
    // RFC 5952 §4.2.3: the longest zero run is shortened, the first on a tie
    expect(ok('v6 2001:db8:0:0:1:0:0:1').args['a']).toBe('2001:db8::1:0:0:1');
    // §4.2.2: a single zero group is never shortened
    expect(ok('v6 2001:db8:0:1:1:1:1:1').args['a']).toBe('2001:db8:0:1:1:1:1:1');
    expect(ok('v6 FE80::1').args['a']).toBe('fe80::1');
    expect(ok('v6 ::').args['a']).toBe('::');
    // an embedded IPv4 tail is accepted on input
    expect(ok('v6 ::ffff:10.0.0.1').args['a']).toBe('::ffff:a00:1');
  });

  it('rejects malformed addresses at the column of the value', () => {
    for (const bad of ['2001:db8::1::2', '12345::1', '2001:db8::1/64', 'fe80::1%eth0', '1:2:3:4:5:6:7:8:9', '10.0.0.1']) {
      const m = fail(`v6 ${bad}`);
      expect(m.kind).toBe('invalid-arg');
      expect(m.error).toEqual({ message: MSG_BAD_IPV6, column: 3 });
    }
  });

  it('prefixes keep the host bits and bound the length to 0-128', () => {
    expect(ok('v6p 2001:DB8:0:1::1/64').args['p']).toBe('2001:db8:0:1::1/64');
    expect(ok('v6p ::/0').args['p']).toBe('::/0');
    expect(ok('v6p 2001:db8::/128').args['p']).toBe('2001:db8::/128');
    for (const bad of ['2001:db8::/129', '2001:db8::', '2001:db8::/', '/64', '2001:db8::/6a', 'x::/64']) {
      expect(fail(`v6p ${bad}`).error).toEqual({ message: MSG_BAD_IPV6_PREFIX, column: 4 });
    }
    expect(normalizeIpv6Prefix('2001:0db8::0001/064')).toBe('2001:db8::1/64');
  });
});

describe('ip, host and hostname', () => {
  it('ip accepts either family and normalises it', () => {
    expect(ok('anyip 10.0.0.1').args['a']).toBe('10.0.0.1');
    expect(ok('anyip 2001:DB8::0:1').args['a']).toBe('2001:db8::1');
    expect(fail('anyip www.lab.nf').error).toEqual({ message: MSG_BAD_IP, column: 6 });
    expect(fail('anyip 10.0.0.0/8').error.message).toBe(MSG_BAD_IP);
    expect(normalizeIpLiteral('2001:db8::1/64')).toBeNull();
  });

  it('host accepts addresses and RFC 1123 names', () => {
    expect(ok('reach 192.168.1.10').args['h']).toBe('192.168.1.10');
    expect(ok('reach 2001:db8::A').args['h']).toBe('2001:db8::a');
    expect(ok('reach www.Lab.nf').args['h']).toBe('www.Lab.nf');
    expect(ok('reach PC2').args['h']).toBe('PC2');
    expect(ok('reach 3com.lab.').args['h']).toBe('3com.lab.');
    // not a valid IPv4 address, and an all-digit last label is not a name either
    expect(fail('reach 10.0.0.256').error).toEqual({ message: MSG_BAD_HOST, column: 6 });
    expect(fail('reach 1.2.3').error.message).toBe(MSG_BAD_HOST);
    expect(fail('reach -srv').error.message).toBe(MSG_BAD_HOST);
    expect(fail('reach srv-.lab').error.message).toBe(MSG_BAD_HOST);
    expect(fail('reach a..b').error.message).toBe(MSG_BAD_HOST);
  });

  it('hostname enforces label and name lengths (RFC 1035 §2.3.4)', () => {
    const label63 = 'a'.repeat(63);
    expect(isHostName(label63)).toBe(true);
    expect(isHostName('a'.repeat(64))).toBe(false);
    const name253 = [label63, label63, label63, 'b'.repeat(61)].join('.');
    expect(name253.length).toBe(253);
    expect(isHostName(name253)).toBe(true);
    expect(isHostName(`${name253}.`)).toBe(true);
    expect(isHostName(`${name253}c`)).toBe(false);
    expect(ok('name lab.nf').args['n']).toBe('lab.nf');
    expect(fail('name under_score').error).toEqual({ message: MSG_BAD_HOSTNAME, column: 5 });
    expect(fail('name 10.0.0.1').error.message).toBe(MSG_BAD_HOSTNAME);
    expect(isHostName('.')).toBe(false);
    expect(isHostName('')).toBe(false);
  });
});

describe('url (RFC 3986 subset)', () => {
  it('normalises scheme, host, port and an empty path', () => {
    expect(ok('browse www.lab.nf').args['u']).toBe('http://www.lab.nf/');
    expect(ok('browse HTTP://WWW.Lab.NF:08080/Index.html').args['u']).toBe('http://www.lab.nf:8080/Index.html');
    expect(ok('browse http://[2001:DB8::1]:80/x').args['u']).toBe('http://[2001:db8::1]:80/x');
    expect(ok('browse https://srv').args['u']).toBe('https://srv/');
    expect(ok('browse http://10.0.0.1?q=1').args['u']).toBe('http://10.0.0.1/?q=1');
    expect(ok('browse srv:8080/p').args['u']).toBe('http://srv:8080/p');
  });

  it('refuses user info, bad ports, empty hosts and authority-less references', () => {
    for (const bad of ['http://user@h/', 'http://h:0/', 'http://h:65536/', 'http:///x', 'mailto:x', 'http://[2001:db8::1/', 'http://bad_host/', 'ht tp://x']) {
      expect(normalizeUrl(bad)).toBeNull();
    }
    expect(fail('browse http://h:0/').error).toEqual({ message: MSG_BAD_URL, column: 7 });
  });
});

describe('hex and int-range', () => {
  it('hex drops 0x, lower-cases and honours numeric bounds', () => {
    expect(ok('hexval 0xFF').args['x']).toBe('ff');
    expect(ok('hexval DEADbeef00').args['x']).toBe('deadbeef00');
    expect(fail('hexval zz').error.message).toBe('% Expected a hexadecimal value at the marked position.');
    expect(fail('hexval 0x').error.column).toBe(7);
    expect(ok('bytehex ff').args['x']).toBe('ff');
    expect(fail('bytehex 100').error.message).toBe('% Expected a hexadecimal value between 0x0 and 0xff at the marked position.');
  });

  it('int-range canonicalises sorted, merged ranges within min and max', () => {
    expect(ok('range 1-4,7').args['r']).toBe('1-4,7');
    expect(ok('range 7,1-3,4').args['r']).toBe('1-4,7');
    expect(ok('range 2-2').args['r']).toBe('2');
    expect(ok('range 5,5,6').args['r']).toBe('5-6');
    for (const bad of ['4-1', '1,,2', '0-3', '9-11', 'a', '1-', '-1']) {
      expect(fail(`range ${bad}`).error).toEqual({ message: '% Expected numbers or ranges such as 1-4,7 between 1 and 10 at the marked position.', column: 6 });
    }
    expect(parseIntRange('3-5,1,2')).toEqual([[1, 5]]);
    expect(formatIntRange([[1, 1], [3, 9]])).toBe('1,3-9');
  });
});

describe('secret', () => {
  it('a trailing secret takes the rest of the line and reports its span', () => {
    const m = ok('keytail  my pass  word  ');
    expect(m.args['s']).toBe('my pass  word');
    expect(m.secretSpans).toEqual([{ column: 9, end: 22 }]);
  });

  it('a secret followed by more path is one token', () => {
    const m = ok('keymid s3cret level 15');
    expect(m.args).toEqual({ s: 's3cret', n: '15' });
    expect(m.secretSpans).toEqual([{ column: 7, end: 13 }]);
    expect(ok('show names').secretSpans).toBeUndefined();
  });

  it('refuses control characters', () => {
    expect(validateArg(arg('secret'), 'ab', CTX)).toEqual({ ok: false, message: MSG_BAD_SECRET });
    expect(validateArg(arg('secret'), 'pässwörd', CTX)).toEqual({ ok: true, value: 'pässwörd' });
  });
});

describe('quoted', () => {
  it('reads quoted text from the raw line, spaces and pipes included', () => {
    expect(ok('label "two  words"').args['t']).toBe('two  words');
    expect(ok('label one').args['t']).toBe('one');
    expect(ok('label "a|b"').args['t']).toBe('a|b');
    expect(ok('label ""').args['t']).toBe('');
    expect(ok('label " padded "').args['t']).toBe(' padded ');
    expect(ok('tag "x y" 5').args).toEqual({ t: 'x y', n: '5' });
  });

  it('reports unclosed and stray quotation marks', () => {
    expect(fail('label "open ended').error).toEqual({ message: MSG_UNCLOSED_QUOTE, column: 6 });
    expect(fail('label "').error).toEqual({ message: MSG_UNCLOSED_QUOTE, column: 6 });
    expect(fail('label ab"c').error).toEqual({ message: MSG_STRAY_QUOTE, column: 6 });
    expect(fail('label "a"b"').error.message).toBe(MSG_STRAY_QUOTE);
    expect(fail('label "one tw"o').error).toEqual({ message: MSG_STRAY_QUOTE, column: 11 });
    expect(fail('tag "x y"').error).toEqual({ message: MSG_INCOMPLETE });
  });

  it('applies maxLength to the text inside the quotes', () => {
    expect(ok(`label "${'x'.repeat(20)}"`).args['t']).toBe('x'.repeat(20));
    expect(fail(`label "${'x'.repeat(10)} ${'y'.repeat(10)}"`).error.message).toBe('% The value at the marked position is longer than 20 characters.');
    expect(validateArg(arg('quoted'), '"quoted"', CTX)).toEqual({ ok: true, value: 'quoted' });
  });

  it('completion inside an open quote offers free text and no error', () => {
    const c = complete(SPECS, CTX, 'label "abc ');
    expect(c.error).toBeUndefined();
    expect(c.items).toEqual([{ token: 'TEXT"', help: 'More text, then a closing quotation mark', isArg: true }]);
    expect(c.cr).toBeUndefined();
    const typing = help(SPECS, CTX, 'label "abc de');
    expect(typing.error).toBeUndefined();
    expect(help(SPECS, CTX, 'label "abc" ').cr).toBe(true);
  });
});

describe('placeholders', () => {
  it('every P1 arg type has its own placeholder', () => {
    expect(placeholderFor(arg('ipv6'))).toBe('X:X:X:X::X');
    expect(placeholderFor(arg('ipv6-prefix'))).toBe('X:X:X:X::X/<0-128>');
    expect(placeholderFor(arg('ip'))).toBe('A.B.C.D|X:X:X:X::X');
    expect(placeholderFor(arg('host'))).toBe('HOST');
    expect(placeholderFor(arg('hostname'))).toBe('NAME');
    expect(placeholderFor(arg('url'))).toBe('URL');
    expect(placeholderFor(arg('hex'))).toBe('HEX');
    expect(placeholderFor(arg('hex', { min: 0, max: 255 }))).toBe('<0x0-0xff>');
    expect(placeholderFor(arg('secret'))).toBe('SECRET');
    expect(placeholderFor(arg('int-range', { min: 1, max: 4094 }))).toBe('<1-4094>[,-]');
    expect(placeholderFor(arg('quoted'))).toBe('"TEXT"');
  });

  it('help lists the placeholder at the arg position', () => {
    expect(help(SPECS, CTX, 'reach ').items).toEqual([{ token: 'HOST', help: 'A host value', isArg: true }]);
    expect(help(SPECS, CTX, 'v6 ').items).toEqual([{ token: 'X:X:X:X::X', help: 'A ipv6 value', isArg: true }]);
    expect(help(SPECS, CTX, 'v6 fe80::1 ').cr).toBe(true);
  });
});
