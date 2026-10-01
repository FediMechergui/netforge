// core/acl, P3 (ARCHITECTURE-P3 D12, §3.3, §5.2; §7 W1 core): extended IPv4 lists, the unified reader with sequence
// numbers, tupleOf, evaluateAcl with its trail, wildcardMatches, rangeToAces and lintAcl. The P2 standard cases of
// core.acl.test.ts stay unchanged (its :35 still refuses `… 0.0.0.255 log` in parseStandardAclEntry); NAT's reader
// now keeps an entry written with a trailing `log`.
import { describe, expect, it } from 'vitest';
import { ipv4ToU32, u32ToIpv4 } from '../src/contracts/addr.js';
import type { ConfigNode } from '../src/contracts/config.js';
import type { LayerSpec, LayerView, PduView } from '../src/contracts/pdu.js';
import type { PacketTuple } from '../src/contracts/process.js';
import {
  aclEntryMiss,
  aclEntryText,
  aclImplicitText,
  aclPermits,
  aclTypeOfNumber,
  evaluateAcl,
  isExtendedAclNumber,
  lintAcl,
  parseAclEntry,
  parseStandardAclEntry,
  rangeToAces,
  readAcls,
  readStandardAcls,
  standardAclEntryTokens,
  tupleOf,
  wildcardMatches,
  type AclEntry,
  type AclList,
} from '../src/core/acl.js';
import { createPduFactory } from '../src/pdu/factory.js';

const n = (key: string, args: string[] = [], children: ConfigNode[] = [], seq?: number): ConfigNode =>
  seq === undefined ? { key, args, children } : { key, args, children, seq };
const tokens = (line: string): string[] => line.split(' ');
const ext = (line: string): AclEntry | undefined => parseAclEntry('extended', tokens(line));
const canon = (line: string): string | undefined => {
  const e = ext(line);
  return e === undefined ? undefined : aclEntryText(e);
};
const tuple = (t: Partial<PacketTuple> & Pick<PacketTuple, 'proto' | 'src' | 'dst'>): PacketTuple => ({ family: 4, ...t });
const listOf = (type: 'standard' | 'extended', lines: string[]): AclList => ({
  name: 'T',
  type,
  entries: lines.map((l, i) => {
    const entry = parseAclEntry(type, tokens(l))!;
    return { seq: (i + 1) * 10, entry, text: aclEntryText(entry) };
  }),
  remarks: [],
});

describe('core/acl P3: standard entries and NAT', () => {
  it('the unified parser reads every P2 standard form like parseStandardAclEntry, plus a trailing log', () => {
    for (const line of ['permit any', 'deny host 10.0.0.1', 'permit 10.0.0.1', 'permit 192.168.1.77 0.0.0.255', 'deny 10.1.2.3 0.255.0.255']) {
      const p2 = parseStandardAclEntry(tokens(line))!;
      const p3 = parseAclEntry('standard', tokens(line));
      expect(p3).toEqual({ kind: 'standard', action: p2.action, source: { address: p2.address, wildcard: p2.wildcard } });
      expect(aclEntryText(p3!)).toBe(standardAclEntryTokens(p2).join(' '));
      expect(parseAclEntry('standard', tokens(`${line} log`))).toEqual({ ...p3, log: true });
    }
    expect(aclEntryText(parseAclEntry('standard', tokens('permit 192.168.10.5 0.0.0.255 log'))!)).toBe('permit 192.168.10.0 0.0.0.255 log');
    // P2's parser is unchanged: it still refuses the logged entry (core.acl.test.ts:35)
    expect(parseStandardAclEntry(tokens('permit 10.0.0.0 0.0.0.255 log'))).toBeUndefined();
    for (const bad of ['remark hosts', 'permit', 'permit log', 'permit any any', 'permit host 10.0.0.1 0.0.0.0', 'permit any log log']) {
      expect(parseAclEntry('standard', tokens(bad)), bad).toBeUndefined();
    }
  });

  it('a NAT list with a log entry keeps it (readStandardAcls ignores the trailing log)', () => {
    const root = n('', [], [
      n('access-list', ['1', 'permit', '192.168.1.0', '0.0.0.255', 'log']),
      n('access-list', ['1', 'deny', 'any']),
      n('ip', ['access-list', 'standard', 'INSIDE'], [n('permit', ['host', '10.0.0.5', 'log'])]),
    ]);
    const lists = readStandardAcls({ root });
    expect(lists.get('1')!.entries).toEqual([
      { action: 'permit', address: '192.168.1.0', wildcard: '0.0.0.255' },
      { action: 'deny', address: '0.0.0.0', wildcard: '255.255.255.255' },
    ]);
    expect(aclPermits(lists.get('1'), '192.168.1.20')).toBe(true);
    expect(aclPermits(lists.get('INSIDE'), '10.0.0.5')).toBe(true);
  });

  it('list numbers: standard 1-99 and 1300-1999, extended 100-199 and 2000-2699', () => {
    expect([100, 199, 2000, 2699, '101', '2500'].map(isExtendedAclNumber)).toEqual([true, true, true, true, true, true]);
    expect([99, 200, 1999, 2700, 0, 'NAME', '1e2', 150.5].map(isExtendedAclNumber)).toEqual([false, false, false, false, false, false, false, false]);
    expect(['1', '99', '1300', '100', '2699', '200', 'x'].map(aclTypeOfNumber)).toEqual(['standard', 'standard', 'standard', 'extended', 'extended', undefined, undefined]);
  });
});

describe('core/acl P3: extended entries', () => {
  it('parses the §3.3 and §3.5 entries into their canonical text', () => {
    expect(canon('deny tcp host 192.168.10.10 host 192.168.20.100 eq www log')).toBe('deny tcp host 192.168.10.10 host 192.168.20.100 eq www log');
    expect(canon('deny tcp host 192.168.10.10 host 192.168.20.100 eq 80 log')).toBe('deny tcp host 192.168.10.10 host 192.168.20.100 eq www log');
    expect(canon('permit icmp 192.168.10.7 0.0.0.255 any')).toBe('permit icmp 192.168.10.0 0.0.0.255 any');
    expect(canon('permit ip any any')).toBe('permit ip any any');
    expect(canon('permit udp any any range 16384 32767')).toBe('permit udp any any range 16384 32767');
    expect(ext('deny tcp host 192.168.10.10 host 192.168.20.100 eq www log')).toEqual({
      kind: 'extended',
      action: 'deny',
      protocol: 6,
      source: { address: '192.168.10.10', wildcard: '0.0.0.0' },
      destination: { address: '192.168.20.100', wildcard: '0.0.0.0' },
      destinationPort: { op: 'eq', port: 80 },
      log: true,
    });
  });

  it('protocols by name or number, a number with a name shown by its name, 0 = ip', () => {
    expect(canon('permit 89 any any')).toBe('permit ospf any any');
    expect(canon('permit ospf any any')).toBe('permit ospf any any');
    expect(canon('permit 0 any any')).toBe('permit ip any any');
    expect(canon('deny 112 any any')).toBe('deny 112 any any');
    expect(canon('permit gre host 1.1.1.1 host 2.2.2.2')).toBe('permit gre host 1.1.1.1 host 2.2.2.2');
    expect(canon('permit eigrp any any')).toBe('permit eigrp any any');
    expect(canon('permit esp any any')).toBe('permit esp any any');
    expect(ext('permit 256 any any')).toBeUndefined();
    expect(ext('permit tcpx any any')).toBeUndefined();
  });

  it('ports: eq neq lt gt range, names per protocol, shown by name when they have one', () => {
    expect(canon('permit tcp any eq 23 any')).toBe('permit tcp any eq telnet any');
    expect(canon('permit tcp any any eq 443')).toBe('permit tcp any any eq 443');
    expect(canon('permit tcp any any eq 22')).toBe('permit tcp any any eq 22');
    expect(canon('permit udp any any eq 161')).toBe('permit udp any any eq snmp');
    expect(canon('permit udp any any eq domain')).toBe('permit udp any any eq domain');
    expect(canon('permit tcp any any eq domain')).toBe('permit tcp any any eq domain');
    expect(canon('permit udp any eq bootpc any eq bootps')).toBe('permit udp any eq bootpc any eq bootps');
    expect(canon('permit tcp any any neq 21')).toBe('permit tcp any any neq ftp');
    expect(canon('permit tcp any any lt 1024')).toBe('permit tcp any any lt 1024');
    expect(canon('permit tcp any any gt 1023')).toBe('permit tcp any any gt 1023');
    expect(canon('permit tcp any any range 20 21')).toBe('permit tcp any any range ftp-data ftp');
    expect(canon('permit tcp any any range ftp-data ftp')).toBe('permit tcp any any range ftp-data ftp');
    // a UDP name is not a TCP name, and the reverse
    expect(ext('permit tcp any any eq snmp')).toBeUndefined();
    expect(ext('permit udp any any eq www')).toBeUndefined();
    for (const bad of ['permit tcp any any eq', 'permit tcp any any eq 65536', 'permit tcp any any lt 0', 'permit tcp any any gt 65535',
      'permit tcp any any range 80 20', 'permit tcp any any range 20', 'permit icmp any any eq 80', 'permit ip any eq 80 any']) {
      expect(ext(bad), bad).toBeUndefined();
    }
  });

  it('established on TCP only; ICMP types, codes and names on ICMP only', () => {
    expect(canon('permit tcp any 10.0.0.0 0.0.0.255 established')).toBe('permit tcp any 10.0.0.0 0.0.0.255 established');
    expect(ext('permit udp any any established')).toBeUndefined();
    expect(canon('permit icmp any any 8')).toBe('permit icmp any any echo');
    expect(canon('permit icmp any any echo-reply')).toBe('permit icmp any any echo-reply');
    expect(canon('deny icmp any any 3 3')).toBe('deny icmp any any port-unreachable');
    expect(canon('deny icmp any any 3')).toBe('deny icmp any any unreachable');
    expect(canon('permit icmp any any 3 13 log')).toBe('permit icmp any any administratively-prohibited log');
    expect(canon('permit icmp any any 42')).toBe('permit icmp any any 42');
    expect(canon('permit icmp any any 3 99')).toBe('permit icmp any any 3 99');
    expect(canon('permit icmp any any 11 0')).toBe('permit icmp any any ttl-exceeded');
    expect(ext('permit icmp any any echo extra')).toBeUndefined();
    expect(ext('permit tcp any any echo')).toBeUndefined();
    expect(ext('permit icmp any any 256')).toBeUndefined();
  });

  it('addresses need a wildcard in extended lists; host and any forms', () => {
    expect(canon('permit ip 10.0.0.1 0.0.0.0 any')).toBe('permit ip host 10.0.0.1 any');
    expect(canon('permit ip 0.0.0.0 255.255.255.255 host 10.0.0.2')).toBe('permit ip any host 10.0.0.2');
    expect(ext('permit ip 10.0.0.1 any')).toBeUndefined();
    expect(ext('permit ip host any')).toBeUndefined();
    expect(ext('permit ip any')).toBeUndefined();
    expect(ext('remark web servers')).toBeUndefined();
    expect(ext('allow ip any any')).toBeUndefined();
  });

  it('canonical text parses back to the same entry', () => {
    for (const line of [
      'deny tcp host 192.168.10.10 host 192.168.20.100 eq www log',
      'permit udp 10.0.0.0 0.255.255.255 range 1000 2000 any neq 53',
      'permit icmp any any host-unreachable',
      'permit tcp any any established log',
      'deny 47 any 10.9.0.0 0.0.255.255',
    ]) {
      const e = ext(line)!;
      expect(ext(aclEntryText(e))).toEqual(e);
    }
  });
});

describe('core/acl P3: readAcls', () => {
  it('reads numbered and named lists of both types, with sequence numbers 10, 20, … and remarks', () => {
    const root = n('', [], [
      n('hostname', ['R1']),
      n('access-list', ['10', 'remark', 'the', 'LAN']),
      n('access-list', ['10', 'permit', '192.168.10.0', '0.0.0.255']),
      n('ip', ['access-list', 'extended', 'NO-WEB-PC1'], [
        n('deny', ['tcp', 'host', '192.168.10.10', 'host', '192.168.20.100', 'eq', 'www', 'log']),
        n('remark', ['pings', 'are', 'fine']),
        n('permit', ['icmp', '192.168.10.0', '0.0.0.255', 'any']),
        n('permit', ['ip', 'any', 'any']),
      ]),
      n('access-list', ['101', 'permit', 'tcp', 'any', 'any', 'eq', '80']),
      n('access-list', ['101', 'bogus', 'entry']),
      n('access-list', ['7000', 'permit', 'any']),
    ]);
    const lists = readAcls({ root });
    expect([...lists.keys()]).toEqual(['10', 'NO-WEB-PC1', '101']);
    expect(lists.get('10')).toEqual({
      name: '10',
      type: 'standard',
      entries: [{ seq: 10, entry: parseAclEntry('standard', tokens('permit 192.168.10.0 0.0.0.255')), text: 'permit 192.168.10.0 0.0.0.255' }],
      remarks: [{ before: 0, text: 'the LAN' }],
    });
    const web = lists.get('NO-WEB-PC1')!;
    expect(web.type).toBe('extended');
    expect(web.entries.map((e) => `${e.seq} ${e.text}`)).toEqual([
      '10 deny tcp host 192.168.10.10 host 192.168.20.100 eq www log',
      '20 permit icmp 192.168.10.0 0.0.0.255 any',
      '30 permit ip any any',
    ]);
    expect(web.remarks).toEqual([{ before: 1, text: 'pings are fine' }]);
    expect(lists.get('101')!.entries.map((e) => e.text)).toEqual(['permit tcp any any eq www']);
  });

  it('keeps ConfigNode.seq (and a leading number); a missing or taken number is the highest + 10; sequence order', () => {
    const root = n('', [], [
      n('ip', ['access-list', 'extended', 'SEQ'], [
        n('permit', ['tcp', 'any', 'any', 'eq', '22'], [], 10),
        n('deny', ['tcp', 'any', 'any', 'eq', '23'], [], 15),
        n('permit', ['ip', 'any', 'any'], [], 20),
        n('55', ['deny', 'udp', 'any', 'any']),
        n('permit', ['icmp', 'any', 'any']),
        n('permit', ['gre', 'any', 'any'], [], 30),
        n('permit', ['esp', 'any', 'any'], [], 15),
      ]),
    ]);
    expect(readAcls({ root }).get('SEQ')!.entries.map((e) => `${e.seq} ${e.text}`)).toEqual([
      '10 permit tcp any any eq 22',
      '15 deny tcp any any eq telnet',
      '20 permit ip any any',
      '30 permit gre any any',
      '55 deny udp any any',
      '65 permit icmp any any',
      '75 permit esp any any',
    ]);
  });

  it('a section entry numbered below the global lines of its number is evaluated before them (the CLI’s one list)', () => {
    // as `ConfigAst.apply` stores them: `access-list 10 permit …` (10, 20), then `ip access-list standard 10` / `5 deny …`
    const root = n('', [], [
      n('access-list', ['10', 'permit', '192.168.10.0', '0.0.0.255'], [], 10),
      n('access-list', ['10', 'remark', 'the', 'servers'], [], 20),
      n('access-list', ['10', 'permit', 'host', '192.168.20.100'], [], 30),
      n('ip', ['access-list', 'standard', '10'], [n('deny', ['host', '192.168.10.66'], [], 5), n('remark', ['last']), n('permit', ['any'], [], 40)]),
    ]);
    const list = readAcls({ root }).get('10')!;
    expect(list.entries.map((e) => `${e.seq} ${e.text}`)).toEqual(['5 deny 192.168.10.66', '10 permit 192.168.10.0 0.0.0.255', '30 permit 192.168.20.100', '40 permit any']);
    expect(list.remarks).toEqual([{ before: 2, text: 'the servers' }, { before: 3, text: 'last' }]);
    expect(evaluateAcl(list, tuple({ proto: 1, src: '192.168.10.66', dst: '10.0.0.1' }))).toMatchObject({ action: 'deny', seq: 5, index: 0 });
  });

  it('a numbered section joins the global lines of its number, global lines first', () => {
    const root = n('', [], [
      n('ip', ['access-list', 'extended', '110'], [n('permit', ['ip', 'any', 'any'])]),
      n('access-list', ['110', 'deny', 'tcp', 'any', 'any', 'eq', '23']),
      n('ip', ['access-list', 'standard', '05'], [n('permit', ['host', '10.0.0.2'])]),
      n('access-list', ['5', 'permit', 'host', '10.0.0.1']),
    ]);
    const lists = readAcls({ root });
    expect([...lists.keys()]).toEqual(['110', '5']);
    expect(lists.get('110')!.entries.map((e) => `${e.seq} ${e.text}`)).toEqual(['10 deny tcp any any eq telnet', '20 permit ip any any']);
    expect(lists.get('5')!.entries.map((e) => `${e.seq} ${e.text}`)).toEqual(['10 permit 10.0.0.1', '20 permit 10.0.0.2']);
  });

  it('a name used by both types keeps the first type; folded ip groups are read; the tree is not changed', () => {
    const root = n('', [], [
      n('ip', ['access-list', 'standard', 'MIX'], [n('permit', ['any'])]),
      n('ip', ['access-list', 'extended', 'MIX'], [n('permit', ['ip', 'any', 'any'])]),
      n('ip', [], [n('routing'), n('access-list', ['extended', 'FOLD'], [n('deny', ['ip', 'any', 'any', 'log'])])]),
    ]);
    const before = JSON.stringify(root);
    const lists = readAcls({ root });
    expect(lists.get('MIX')).toMatchObject({ type: 'standard', entries: [{ seq: 10, text: 'permit any' }] });
    expect(lists.get('FOLD')!.entries.map((e) => e.text)).toEqual(['deny ip any any log']);
    expect(JSON.stringify(root)).toBe(before);
    expect(readAcls({ root: n('') }).size).toBe(0);
  });
});

describe('core/acl P3: tupleOf', () => {
  const f = createPduFactory();
  const meta = { born: 0, origin: 'r1' as const };
  const build = (layers: LayerSpec[]): PduView => f.build(layers, meta);
  const ip = (protocol: number, extra: Record<string, number> = {}): LayerSpec => ({ proto: 'ipv4', fields: { src: '192.168.10.10', dst: '192.168.20.100', protocol, ttl: 64, ...extra } });

  it('reads TCP ports and flags, UDP ports and ICMP type and code', () => {
    expect(tupleOf(build([ip(6), { proto: 'tcp', fields: { srcPort: 49152, dstPort: 80, flags: 'S' } }]))).toEqual({
      family: 4, proto: 6, src: '192.168.10.10', dst: '192.168.20.100', srcPort: 49152, dstPort: 80, tcpFlags: 0x02,
    });
    expect(tupleOf(build([ip(6), { proto: 'tcp', fields: { srcPort: 80, dstPort: 49152, flags: 'SA' } }]))!.tcpFlags).toBe(0x12);
    expect(tupleOf(build([ip(6), { proto: 'tcp', fields: { srcPort: 80, dstPort: 49152, flags: 'FSRPAUEC' } }]))!.tcpFlags).toBe(0xff);
    expect(tupleOf(build([ip(17), { proto: 'udp', fields: { srcPort: 5000, dstPort: 16384 } }, { proto: 'payload', fields: { data: new Uint8Array(4) } }]))).toEqual({
      family: 4, proto: 17, src: '192.168.10.10', dst: '192.168.20.100', srcPort: 5000, dstPort: 16384,
    });
    expect(tupleOf(build([ip(1), { proto: 'icmpv4', fields: { type: 8, code: 0, id: 1, seq: 1 } }]))).toEqual({
      family: 4, proto: 1, src: '192.168.10.10', dst: '192.168.20.100', icmpType: 8, icmpCode: 0,
    });
  });

  it('starts at the first ipv4 layer (under Ethernet) and never reads a quoted datagram', () => {
    const framed = build([
      { proto: 'ethernet', fields: { src: '02:00:00:00:00:01', dst: '02:00:00:00:00:02', ethertype: 0x0800 } },
      ip(1),
      { proto: 'icmpv4', fields: { type: 3, code: 13 } },
      { proto: 'ipv4', fields: { src: '192.168.20.100', dst: '192.168.10.10', protocol: 6, ttl: 63 } },
      { proto: 'tcp', fields: { srcPort: 49152, dstPort: 80, flags: 'S' } },
    ]);
    expect(tupleOf(framed)).toEqual({ family: 4, proto: 1, src: '192.168.10.10', dst: '192.168.20.100', icmpType: 3, icmpCode: 13 });
    expect(tupleOf(build([{ proto: 'ethernet', fields: { src: '02:00:00:00:00:01', dst: 'ff:ff:ff:ff:ff:ff', ethertype: 0x0806 } }, {
      proto: 'arp', fields: { op: 1, sha: '02:00:00:00:00:01', spa: '10.0.0.1', tha: '00:00:00:00:00:00', tpa: '10.0.0.2' },
    }]))).toBeUndefined();
  });

  it('a non-initial fragment carries no transport fields', () => {
    const layer = (proto: string, fields: Record<string, unknown>): LayerView =>
      ({ proto, offset: 0, length: 0, headerLength: 0, fields, fieldRanges: {} }) as unknown as LayerView;
    const pdu = { layers: [layer('ipv4', { protocol: 6, src: '10.0.0.1', dst: '10.0.0.2', fragOffset: 185 }), layer('tcp', { srcPort: 1, dstPort: 2, flags: 'A' })] };
    expect(tupleOf(pdu)).toEqual({ family: 4, proto: 6, src: '10.0.0.1', dst: '10.0.0.2' });
  });
});

describe('core/acl P3: evaluateAcl', () => {
  const noWeb = listOf('extended', [
    'deny tcp host 192.168.10.10 host 192.168.20.100 eq www log',
    'permit icmp 192.168.10.0 0.0.0.255 any',
    'permit ip any any',
  ]);

  it('§3.3: a ping from PC1 misses line 10 on the protocol and matches line 20', () => {
    const d = evaluateAcl(noWeb, tuple({ proto: 1, src: '192.168.10.10', dst: '192.168.20.100', icmpType: 8, icmpCode: 0 }));
    expect(d).toEqual({
      action: 'permit',
      seq: 20,
      index: 1,
      trail: [
        { seq: 10, text: 'deny tcp host 192.168.10.10 host 192.168.20.100 eq www log', result: 'miss', failed: 'protocol' },
        { seq: 20, text: 'permit icmp 192.168.10.0 0.0.0.255 any', result: 'match' },
      ],
    });
  });

  it('§3.3: PC1 HTTP is denied by line 10; PC2 HTTP falls through to line 30', () => {
    const syn = (src: string): PacketTuple => tuple({ proto: 6, src, dst: '192.168.20.100', srcPort: 49152, dstPort: 80, tcpFlags: 0x02 });
    expect(evaluateAcl(noWeb, syn('192.168.10.10'))).toMatchObject({ action: 'deny', seq: 10, index: 0, trail: [{ seq: 10, result: 'match' }] });
    const pc2 = evaluateAcl(noWeb, syn('192.168.10.11'));
    expect(pc2.action).toBe('permit');
    expect(pc2.seq).toBe(30);
    expect(pc2.trail.map((s) => [s.seq, s.result, s.failed])).toEqual([[10, 'miss', 'source'], [20, 'miss', 'protocol'], [30, 'match', undefined]]);
  });

  it('a packet no entry matches ends at the implicit deny', () => {
    const l = listOf('extended', ['permit tcp any any eq www', 'permit udp any any eq domain']);
    const d = evaluateAcl(l, tuple({ proto: 89, src: '10.0.0.1', dst: '224.0.0.5' }));
    expect(d).toEqual({
      action: 'deny',
      seq: null,
      implicit: 'deny',
      trail: [
        { seq: 10, text: 'permit tcp any any eq www', result: 'miss', failed: 'protocol' },
        { seq: 20, text: 'permit udp any any eq domain', result: 'miss', failed: 'protocol' },
        { seq: 'implicit', text: 'deny ip any any', result: 'match' },
      ],
    });
    // §3.3 step 8: a standard list without the neighbour's address drops its hellos
    const std = listOf('standard', ['permit 192.168.10.0 0.0.0.255']);
    const hello = evaluateAcl(std, tuple({ proto: 89, src: '10.0.12.2', dst: '224.0.0.5' }));
    expect(hello).toMatchObject({ action: 'deny', seq: null, implicit: 'deny' });
    expect(hello.trail[hello.trail.length - 1]).toEqual({ seq: 'implicit', text: aclImplicitText('standard'), result: 'match' });
    expect(evaluateAcl(listOf('standard', []), tuple({ proto: 1, src: '1.1.1.1', dst: '2.2.2.2' })).trail).toEqual([{ seq: 'implicit', text: 'deny any', result: 'match' }]);
  });

  it('matches each part in order and reports the first that fails', () => {
    const e = ext('permit tcp 10.0.0.0 0.0.0.255 range 1000 2000 host 10.9.9.9 eq www established')!;
    const ok = tuple({ proto: 6, src: '10.0.0.7', dst: '10.9.9.9', srcPort: 1500, dstPort: 80, tcpFlags: 0x10 });
    expect(aclEntryMiss(e, ok)).toBeUndefined();
    expect(aclEntryMiss(e, { ...ok, proto: 17 })).toBe('protocol');
    expect(aclEntryMiss(e, { ...ok, src: '10.0.1.7' })).toBe('source');
    expect(aclEntryMiss(e, { ...ok, srcPort: 999 })).toBe('source-port');
    expect(aclEntryMiss(e, { ...ok, srcPort: 2000 })).toBeUndefined();
    expect(aclEntryMiss(e, { ...ok, dst: '10.9.9.8' })).toBe('destination');
    expect(aclEntryMiss(e, { ...ok, dstPort: 443 })).toBe('destination-port');
    expect(aclEntryMiss(e, { ...ok, tcpFlags: 0x02 })).toBe('established');
    expect(aclEntryMiss(e, { ...ok, tcpFlags: 0x04 })).toBeUndefined();
    expect(aclEntryMiss(e, { ...ok, tcpFlags: 0x12 })).toBeUndefined();
    const { srcPort: _drop, ...noPorts } = ok;
    expect(aclEntryMiss(e, noPorts)).toBe('source-port');
    const ops = (op: string, port: number): boolean => aclEntryMiss(ext(`permit udp any any ${op}`)!, tuple({ proto: 17, src: '1.1.1.1', dst: '2.2.2.2', srcPort: 1, dstPort: port })) === undefined;
    expect([ops('eq 53', 53), ops('eq 53', 54), ops('neq 53', 53), ops('neq 53', 54)]).toEqual([true, false, false, true]);
    expect([ops('lt 1024', 1023), ops('lt 1024', 1024), ops('gt 1023', 1024), ops('gt 1023', 1023)]).toEqual([true, false, true, false]);
  });

  it('ICMP: a type matches every code; a type and code match exactly', () => {
    const t = (type: number, code: number): PacketTuple => tuple({ proto: 1, src: '1.1.1.1', dst: '2.2.2.2', icmpType: type, icmpCode: code });
    const unreach = ext('permit icmp any any unreachable')!;
    const port = ext('permit icmp any any port-unreachable')!;
    expect([aclEntryMiss(unreach, t(3, 3)), aclEntryMiss(unreach, t(3, 13)), aclEntryMiss(unreach, t(8, 0))]).toEqual([undefined, undefined, 'icmp']);
    expect([aclEntryMiss(port, t(3, 3)), aclEntryMiss(port, t(3, 1))]).toEqual([undefined, 'icmp']);
    expect(aclEntryMiss(ext('permit icmp any any')!, t(0, 0))).toBeUndefined();
    expect(aclEntryMiss(ext('permit ip any any')!, t(0, 0))).toBeUndefined();
  });
});

describe('core/acl P3: wildcards and ranges', () => {
  it('wildcardMatches, including non-contiguous wildcards', () => {
    expect(wildcardMatches('192.168.1.200', '192.168.1.0', '0.0.0.255')).toBe(true);
    expect(wildcardMatches('192.168.2.1', '192.168.1.0', '0.0.0.255')).toBe(false);
    expect(wildcardMatches('10.200.5.7', '10.0.5.0', '0.255.0.255')).toBe(true);
    expect(wildcardMatches('10.200.6.7', '10.0.5.0', '0.255.0.255')).toBe(false);
    // odd third octets of 172.16.0.0/16: 0.0.254.255 with base 172.16.1.0
    expect(wildcardMatches('172.16.3.9', '172.16.1.0', '0.0.254.255')).toBe(true);
    expect(wildcardMatches('172.16.4.9', '172.16.1.0', '0.0.254.255')).toBe(false);
    expect(wildcardMatches('0.0.0.0', '1.2.3.4', '255.255.255.255')).toBe(true);
  });

  it('rangeToAces: the fewest aligned blocks', () => {
    expect(rangeToAces('192.168.1.0', '192.168.1.255')).toEqual([{ address: '192.168.1.0', wildcard: '0.0.0.255' }]);
    expect(rangeToAces('10.0.0.1', '10.0.0.6')).toEqual([
      { address: '10.0.0.1', wildcard: '0.0.0.0' },
      { address: '10.0.0.2', wildcard: '0.0.0.1' },
      { address: '10.0.0.4', wildcard: '0.0.0.1' },
      { address: '10.0.0.6', wildcard: '0.0.0.0' },
    ]);
    expect(rangeToAces('192.168.1.64', '192.168.1.191')).toEqual([
      { address: '192.168.1.64', wildcard: '0.0.0.63' },
      { address: '192.168.1.128', wildcard: '0.0.0.63' },
    ]);
    expect(rangeToAces('0.0.0.0', '255.255.255.255')).toEqual([{ address: '0.0.0.0', wildcard: '255.255.255.255' }]);
    expect(rangeToAces('128.0.0.0', '255.255.255.255')).toEqual([{ address: '128.0.0.0', wildcard: '127.255.255.255' }]);
    expect(rangeToAces('10.0.0.9', '10.0.0.9')).toEqual([{ address: '10.0.0.9', wildcard: '0.0.0.0' }]);
    expect(rangeToAces('10.0.0.9', '10.0.0.8')).toEqual([]);
    expect(rangeToAces('10.0.0.300', '10.0.0.8')).toEqual([]);
  });

  it('rangeToAces covers exactly the range with maximal aligned blocks (deterministic sweep)', () => {
    let seed = 12345;
    const next = (): number => {
      seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
      return seed;
    };
    for (let k = 0; k < 200; k++) {
      const a = next() >>> (k % 24);
      const b = a + (next() % 5000);
      if (b > 0xffffffff) continue;
      const blocks = rangeToAces(u32ToIpv4(a), u32ToIpv4(b));
      let cur = a;
      for (const blk of blocks) {
        const base = ipv4ToU32(blk.address);
        const size = ipv4ToU32(blk.wildcard) + 1;
        expect(base).toBe(cur);
        expect(base % size).toBe(0);
        // maximal: the doubled block would be misaligned or leave the range
        expect(base % (size * 2) !== 0 || base + size * 2 - 1 > b).toBe(true);
        cur = base + size;
      }
      expect(cur).toBe(b + 1);
    }
  });
});

describe('core/acl P3: lintAcl', () => {
  it('a clean list has no finding', () => {
    expect(lintAcl(listOf('extended', ['deny tcp host 10.0.0.1 any eq www', 'permit ip any any']))).toEqual([]);
    expect(lintAcl(listOf('standard', ['deny host 10.0.0.1', 'permit 10.0.0.0 0.0.0.255']))).toEqual([]);
  });

  it('flags an entry an earlier entry already covers, whatever the actions', () => {
    const l = listOf('standard', ['permit 10.0.0.0 0.0.0.255', 'deny host 10.0.0.1', 'permit 10.0.0.128 0.0.0.127']);
    expect(lintAcl(l)).toEqual([
      { code: 'unreachable', severity: 'warning', seq: 20, coveredBy: 10, text: 'Entry 20 is never used: entry 10 (permit 10.0.0.0 0.0.0.255) already matches every packet it matches.' },
      { code: 'unreachable', severity: 'warning', seq: 30, coveredBy: 10, text: 'Entry 30 is never used: entry 10 (permit 10.0.0.0 0.0.0.255) already matches every packet it matches.' },
    ]);
    const x = listOf('extended', [
      'permit tcp any any range 20 100',
      'deny tcp host 1.1.1.1 any eq www',
      'deny tcp any any',
      'permit ip any any',
      'permit icmp any any echo',
    ]);
    expect(lintAcl(x).map((f) => [f.code, f.seq, f.coveredBy])).toEqual([['unreachable', 20, 10], ['unreachable', 50, 40]]);
    // ports, established and ICMP narrow what an entry covers
    const y = listOf('extended', ['permit tcp any any eq www', 'permit tcp any any', 'permit tcp any any established', 'permit icmp any any unreachable', 'permit icmp any any port-unreachable', 'permit icmp any any']);
    expect(lintAcl(y).map((f) => [f.code, f.seq, f.coveredBy])).toEqual([['unreachable', 30, 20], ['unreachable', 50, 40]]);
  });

  it('flags a wildcard shaped like a subnet mask, and a list that permits nothing', () => {
    const l = listOf('extended', ['deny ip 192.168.1.0 255.255.255.0 any', 'deny tcp any 10.0.0.0 0.0.0.255 eq 23']);
    expect(lintAcl(l)).toEqual([
      { code: 'mask-as-wildcard', severity: 'info', seq: 10, text: 'Entry 10 uses 255.255.255.0 as a wildcard. It is shaped like a subnet mask; the wildcard for that mask is 0.0.0.255.' },
      { code: 'no-permit', severity: 'warning', text: 'This list permits nothing: every packet reaches the implicit deny.' },
    ]);
    expect(lintAcl(listOf('standard', [])).map((f) => f.code)).toEqual(['no-permit']);
  });
});
