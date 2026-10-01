/**
 * cli/parser.ts P3 arg rules (ARCHITECTURE-P3 §5.1, §5.2, D12; §7 W1 cli) — no new ArgType:
 *   • a number or a name: an `int` arg with `choices` also accepts one of its names (exact first, then an unambiguous
 *     prefix, any letter case) — ACL port names (`portNameArg`) and ICMP message names (`icmpNameArg`);
 *   • dotted or a number: an `ipv4` arg with `max` also accepts a whole number — the OSPF area (`ospfAreaArg`), kept as
 *     typed, with `ospfAreaDotted` giving the dotted id of either form;
 * their `?` listings and Tab completion, and that args without those members keep every P1/P2 message and placeholder.
 */
import { describe, expect, it } from 'vitest';
import type { ArgSpec, CommandSpec } from '../src/contracts/cli.js';
import { ACL_ICMP_NAMES, ACL_TCP_PORT_NAMES, ACL_UDP_PORT_NAMES, aclEntryText, parseAclEntry } from '../src/core/acl.js';
import {
  MSG_AMBIGUOUS_NAME,
  MSG_BAD_DOTTED_OR_NUMBER,
  MSG_BAD_NAMED_NUMBER,
  OSPF_AREA_MAX,
  aclPortNumber,
  cliAclPortNames,
  cliIcmpMessageNames,
  complete,
  help,
  icmpNameArg,
  matchCommand,
  ospfAreaArg,
  ospfAreaDotted,
  placeholderFor,
  portNameArg,
  validateArg,
  type MatchContext,
  type MatchResult,
} from '../src/cli/parser.js';

const TCP_PORT = portNameArg('tcp', 'Port number or name');
const UDP_PORT = portNameArg('udp', 'Port number or name');
const ICMP = icmpNameArg('Message type or name');
const AREA = ospfAreaArg('Area id');

const SPECS: CommandSpec[] = [
  { path: ['tcp-eq', '<port>'], mode: 'priv-exec', privilege: 1, help: 'TCP port', args: { port: TCP_PORT }, handler: 'h' },
  { path: ['udp-eq', '<port>'], mode: 'priv-exec', privilege: 1, help: 'UDP port', args: { port: UDP_PORT }, handler: 'h' },
  { path: ['icmp-msg', '<type>', '<code>'], mode: 'priv-exec', privilege: 1, help: 'ICMP', args: { type: ICMP, code: { type: 'int', help: 'Code', min: 0, max: 255, optional: true } }, handler: 'h' },
  { path: ['area', '<area>'], mode: 'priv-exec', privilege: 1, help: 'Area', args: { area: AREA }, handler: 'h' },
];

const CTX: MatchContext = { mode: 'priv-exec', privilege: 15, resolveInterface: () => undefined };

function ok(line: string): Extract<MatchResult, { ok: true }> {
  const m = matchCommand(SPECS, CTX, line);
  if (!m.ok) throw new Error(`${line}: ${m.error.message}`);
  return m;
}

function fail(line: string): Extract<MatchResult, { ok: false }> {
  const m = matchCommand(SPECS, CTX, line);
  if (m.ok) throw new Error(`${line} matched`);
  return m;
}

describe('a number or a name (int with choices)', () => {
  it('builds the ACL port and ICMP args from the name tables (core/acl, one source of truth)', () => {
    expect(TCP_PORT).toEqual({ type: 'int', help: 'Port number or name', min: 0, max: 65535, choices: [...cliAclPortNames('tcp')] });
    expect(portNameArg('udp', 'x', true)).toEqual({ type: 'int', help: 'x', min: 0, max: 65535, choices: [...cliAclPortNames('udp')], optional: true });
    expect(ICMP).toEqual({ type: 'int', help: 'Message type or name', min: 0, max: 255, choices: [...cliIcmpMessageNames()] });
    expect(cliAclPortNames('tcp')).toEqual(ACL_TCP_PORT_NAMES.map(([n]) => n).sort());
    expect(cliAclPortNames('udp')).toEqual(ACL_UDP_PORT_NAMES.map(([n]) => n).sort());
    expect(cliIcmpMessageNames()).toEqual(ACL_ICMP_NAMES.map(([n]) => n).sort());
    expect(aclPortNumber('tcp', 'www')).toBe(80);
    expect(aclPortNumber('udp', 'domain')).toBe(53);
    expect(ACL_ICMP_NAMES.find(([n]) => n === 'port-unreachable')).toEqual(['port-unreachable', 3, 3]);
    expect(ACL_ICMP_NAMES.find(([n]) => n === 'echo')).toEqual(['echo', 8]);
  });

  it('every name the device prints for an entry (aclEntryText) is accepted when typed back', () => {
    const typedBack = (arg: ArgSpec, name: string): void => {
      expect(validateArg(arg, name, CTX), name).toEqual({ ok: true, value: name });
    };
    for (const [proto, table, arg] of [['tcp', ACL_TCP_PORT_NAMES, TCP_PORT], ['udp', ACL_UDP_PORT_NAMES, UDP_PORT]] as const) {
      for (const [name, port] of table) {
        const text = aclEntryText(parseAclEntry('extended', ['permit', proto, 'any', 'any', 'eq', String(port)])!);
        expect(text).toBe(`permit ${proto} any any eq ${name}`);
        typedBack(arg, name);
        expect(aclPortNumber(proto, name)).toBe(port);
        expect(parseAclEntry('extended', ['permit', proto, 'any', 'any', 'eq', name])).toEqual(parseAclEntry('extended', ['permit', proto, 'any', 'any', 'eq', String(port)]));
      }
    }
    for (const [name, type, code] of ACL_ICMP_NAMES) {
      const tokens = code === undefined ? [String(type)] : [String(type), String(code)];
      expect(aclEntryText(parseAclEntry('extended', ['permit', 'icmp', 'any', 'any', ...tokens])!)).toBe(`permit icmp any any ${name}`);
      typedBack(ICMP, name);
    }
    // the cases that were refused before the tables were joined
    expect(ok('tcp-eq chargen').args['port']).toBe('chargen');
    expect(ok('icmp-msg source-route-failed').args['type']).toBe('source-route-failed');
  });

  it('takes a number in range as that number and a name as its spelling', () => {
    expect(ok('tcp-eq 80').args['port']).toBe('80');
    expect(ok('tcp-eq 0080').args['port']).toBe('80');
    expect(ok('tcp-eq www').args['port']).toBe('www');
    expect(ok('tcp-eq WWW').args['port']).toBe('www');
    expect(ok('tcp-eq ftp-d').args['port']).toBe('ftp-data');
    expect(ok('udp-eq domain').args['port']).toBe('domain');
    expect(ok('udp-eq snmpt').args['port']).toBe('snmptrap');
    // a TCP name is not a UDP name
    expect(fail('udp-eq www').error).toEqual({ message: MSG_BAD_NAMED_NUMBER(UDP_PORT), column: 7 });
  });

  it('an exact name wins over a longer name; a shared prefix is ambiguous', () => {
    expect(ok('icmp-msg echo').args['type']).toBe('echo');
    expect(ok('icmp-msg echo-r').args['type']).toBe('echo-reply');
    expect(ok('icmp-msg unreach').args['type']).toBe('unreachable');
    expect(ok('icmp-msg 3 13').args).toEqual({ type: '3', code: '13' });
    expect(fail('icmp-msg ec').error).toEqual({ message: MSG_AMBIGUOUS_NAME('ec', ['echo', 'echo-reply']), column: 9 });
    expect(MSG_AMBIGUOUS_NAME('ec', ['echo', 'echo-reply'])).toBe('% Ambiguous name "ec": could be echo, echo-reply.');
    // ftp is a name of its own and a prefix of ftp-data: the exact name wins
    expect(ok('tcp-eq ftp').args['port']).toBe('ftp');
  });

  it('refuses a number out of range and an unknown name with one message', () => {
    const msg = '% Expected a whole number between 0 and 65535 or one of the names ? lists at the marked position.';
    expect(MSG_BAD_NAMED_NUMBER(TCP_PORT)).toBe(msg);
    expect(fail('tcp-eq 65536').error).toEqual({ message: msg, column: 7 });
    expect(fail('tcp-eq https').error).toEqual({ message: msg, column: 7 });
    expect(fail('tcp-eq -1').error).toEqual({ message: msg, column: 7 });
    expect(validateArg(ICMP, '256', CTX)).toEqual({ ok: false, message: '% Expected a whole number between 0 and 255 or one of the names ? lists at the marked position.' });
  });

  it('? lists every name and the number range; Tab completes a unique name', () => {
    const h = help(SPECS, CTX, 'tcp-eq ');
    expect(h.items.map((i) => i.token)).toEqual([...cliAclPortNames('tcp'), '<0-65535>']);
    expect(h.items.at(-1)).toEqual({ token: '<0-65535>', help: 'Port number or name', isArg: true });
    expect(help(SPECS, CTX, 'tcp-eq f').items.map((i) => i.token)).toEqual(['finger', 'ftp', 'ftp-data']);
    expect(complete(SPECS, CTX, 'tcp-eq ww').insert).toBe('w ');
    expect(complete(SPECS, CTX, 'icmp-msg echo-').insert).toBe('reply ');
    expect(placeholderFor(TCP_PORT)).toBe('<0-65535>');
  });

  it('aclPortNumber reads either form', () => {
    expect(aclPortNumber('tcp', 'www')).toBe(80);
    expect(aclPortNumber('tcp', '443')).toBe(443);
    expect(aclPortNumber('udp', 'tftp')).toBe(69);
    expect(aclPortNumber('udp', 'www')).toBeUndefined();
    expect(aclPortNumber('tcp', '70000')).toBeUndefined();
    expect(aclPortNumber('tcp', 'toString')).toBeUndefined();
  });
});

describe('dotted or a number (ipv4 with max): the OSPF area', () => {
  it('builds the area arg', () => {
    expect(AREA).toEqual({ type: 'ipv4', help: 'Area id', min: 0, max: 4_294_967_295 });
    expect(OSPF_AREA_MAX).toBe(4_294_967_295);
  });

  it('keeps a number as typed (without leading zeros) and normalises dotted text', () => {
    expect(ok('area 0').args['area']).toBe('0');
    expect(ok('area 00').args['area']).toBe('0');
    expect(ok('area 51').args['area']).toBe('51');
    expect(ok('area 4294967295').args['area']).toBe('4294967295');
    expect(ok('area 0.0.0.0').args['area']).toBe('0.0.0.0');
    expect(ok('area 0.0.0.51').args['area']).toBe('0.0.0.51');
  });

  it('refuses anything else with one message', () => {
    const msg = '% Expected a dotted value (A.B.C.D) or a whole number between 0 and 4294967295 at the marked position.';
    expect(MSG_BAD_DOTTED_OR_NUMBER(AREA)).toBe(msg);
    for (const bad of ['4294967296', '99999999999', '0.0.0', '0.0.0.256', 'backbone', '-1']) {
      expect(fail(`area ${bad}`).error, bad).toEqual({ message: msg, column: 5 });
    }
  });

  it('? lists both forms', () => {
    expect(help(SPECS, CTX, 'area ').items).toEqual([
      { token: '<0-4294967295>', help: 'Area id', isArg: true },
      { token: 'A.B.C.D', help: 'Area id', isArg: true },
    ]);
  });

  it('ospfAreaDotted gives the dotted id of either form', () => {
    expect(ospfAreaDotted('0')).toBe('0.0.0.0');
    expect(ospfAreaDotted('0.0.0.0')).toBe('0.0.0.0');
    expect(ospfAreaDotted('10')).toBe('0.0.0.10');
    expect(ospfAreaDotted('256')).toBe('0.0.1.0');
    expect(ospfAreaDotted('4294967295')).toBe('255.255.255.255');
    expect(ospfAreaDotted('4294967296')).toBeNull();
    expect(ospfAreaDotted('1.2.3')).toBeNull();
    expect(ospfAreaDotted('x')).toBeNull();
  });
});

describe('P1/P2 args are unchanged', () => {
  it('an int without names and an ipv4 without bounds keep their messages and placeholders', () => {
    const plainInt: ArgSpec = { type: 'int', help: 'n', min: 1, max: 10 };
    const plainV4: ArgSpec = { type: 'ipv4', help: 'a' };
    expect(validateArg(plainInt, 'www', CTX)).toEqual({ ok: false, message: '% Expected a whole number between 1 and 10 at the marked position.' });
    expect(validateArg(plainInt, '11', CTX)).toEqual({ ok: false, message: '% Expected a whole number between 1 and 10 at the marked position.' });
    expect(validateArg(plainV4, '0', CTX)).toEqual({ ok: false, message: '% Expected an IPv4 address in dotted-decimal form (A.B.C.D) at the marked position.' });
    expect(validateArg(plainV4, '10.0.0.1', CTX)).toEqual({ ok: true, value: '10.0.0.1' });
    expect(placeholderFor(plainInt)).toBe('<1-10>');
    expect(placeholderFor(plainV4)).toBe('A.B.C.D');
    const specs: CommandSpec[] = [{ path: ['n', '<v>'], mode: 'priv-exec', privilege: 1, help: 'N', args: { v: plainInt }, handler: 'h' }];
    expect(help(specs, CTX, 'n ').items).toEqual([{ token: '<1-10>', help: 'n', isArg: true }]);
  });
});
