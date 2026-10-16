// core/acl6, P3c [S11] (ARCHITECTURE-P3C D8, §3.6, §7 W1a core): IPv6 access lists — the entry parser and its
// canonical text, the reader with sequence numbers, tupleOf6 over extension headers, evaluateAcl6 with the implicit
// ND tail (nd-na, nd-ns, deny) and lintAcl6's `nd-blocked`. The family-4 functions of core/acl are untouched.
import { describe, expect, it } from 'vitest';
import type { ConfigNode } from '../src/contracts/config.js';
import type { LayerView } from '../src/contracts/pdu.js';
import type { PacketTuple6 } from '../src/contracts/process.js';
import { aclKey } from '../src/contracts/tables.js';
import { aclTrailText } from '../src/core/acl.js';
import {
  ACL6_IMPLICIT_TAIL,
  acl6EntryMiss,
  acl6EntryText,
  evaluateAcl6,
  lintAcl6,
  parseAcl6Entry,
  readAcls6,
  tupleOf6,
  type Acl6List,
} from '../src/core/acl6.js';

const n = (key: string, args: string[] = [], children: ConfigNode[] = [], seq?: number): ConfigNode =>
  seq === undefined ? { key, args, children } : { key, args, children, seq };
const tokens = (line: string): string[] => line.split(' ');
const canon = (line: string): string | undefined => {
  const e = parseAcl6Entry(tokens(line));
  return e === undefined ? undefined : acl6EntryText(e);
};
const listOf = (lines: string[], name = 'NO-WEB6'): Acl6List => ({
  name,
  type: 'ipv6',
  entries: lines.map((l, i) => {
    const entry = parseAcl6Entry(tokens(l))!;
    return { seq: (i + 1) * 10, entry, text: acl6EntryText(entry) };
  }),
  remarks: [],
});
const t6 = (t: Partial<PacketTuple6> & Pick<PacketTuple6, 'proto' | 'src' | 'dst'>): PacketTuple6 => ({ family: 6, ...t });

const PC1 = '2001:db8:10::10';
const SRV = '2001:db8:20::100';
const R1 = '2001:db8:10::1';
const synWeb = t6({ proto: 6, src: PC1, dst: SRV, srcPort: 49152, dstPort: 80, tcpFlags: 0x02 });
const ping6 = t6({ proto: 58, src: PC1, dst: SRV, icmpType: 128, icmpCode: 0 });
const ns = t6({ proto: 58, src: PC1, dst: 'ff02::1:ff00:1', icmpType: 135, icmpCode: 0 });
const na = t6({ proto: 58, src: R1, dst: PC1, icmpType: 136, icmpCode: 0 });
const rs = t6({ proto: 58, src: 'fe80::1', dst: 'ff02::2', icmpType: 133, icmpCode: 0 });

describe('core/acl6 [S11]: entries', () => {
  it('parses the §3.6 forms and shows them canonically', () => {
    expect(parseAcl6Entry(tokens(`deny tcp host ${PC1} host ${SRV} eq www`))).toEqual({
      kind: 'ipv6', action: 'deny', protocol: 6,
      source: { network: PC1, prefixLen: 128 }, destination: { network: SRV, prefixLen: 128 },
      destinationPort: { op: 'eq', port: 80 },
    });
    expect(canon(`deny tcp host ${PC1} host ${SRV} eq 80`)).toBe(`deny tcp host ${PC1} host ${SRV} eq www`);
    expect(canon('permit ipv6 any any')).toBe('permit ipv6 any any');
    expect(canon('permit icmp any any nd-ns')).toBe('permit icmp any any nd-ns');
    expect(canon('permit icmp any any 136')).toBe('permit icmp any any nd-na');
    expect(canon('permit icmp any any 1 1')).toBe('permit icmp any any no-admin');
    expect(canon('permit icmp any any 1 9')).toBe('permit icmp any any 1 9');
    expect(canon('permit 58 any any echo-request')).toBe('permit icmp any any echo-request');
    expect(canon('deny ipv6 2001:DB8:10::5/64 any log')).toBe('deny ipv6 2001:db8:10::/64 any log');
    expect(canon('permit ipv6 2001:db8::1/128 ::/0')).toBe('permit ipv6 host 2001:db8::1 any');
    expect(canon('permit tcp any eq 22 any established')).toBe('permit tcp any eq 22 any established');
    expect(canon('permit udp any any range domain 60')).toBe('permit udp any any range domain 60');
    expect(canon('permit 89 any any')).toBe('permit 89 any any');
    expect(canon('permit sctp any any')).toBe('permit sctp any any');
  });

  it('refuses what IOS refuses', () => {
    for (const bad of [
      'permit any any', 'allow ipv6 any any', 'permit ipv6 host 10.0.0.1 any', 'permit ipv6 2001:db8::/129 any',
      'permit ipv6 2001:db8:: any', 'permit ipv6 any eq 80 any', 'permit udp any any established', 'permit tcp any any echo-request',
      'permit icmp any any eq 80', 'permit ipv6 any any log log', 'permit tcp any any eq 70000', 'remark hello',
    ]) {
      expect(parseAcl6Entry(tokens(bad)), bad).toBeUndefined();
    }
  });
});

describe('core/acl6 [S11]: readAcls6', () => {
  it('reads named sections with sequence numbers, remarks, and the leading or trailing sequence form', () => {
    const config = {
      root: n('', [], [
        n('ipv6', ['access-list', 'NO-WEB6'], [
          n('remark', ['no', 'web', 'for', 'PC1']),
          n('deny', ['tcp', 'host', PC1, 'host', SRV, 'eq', 'www']),
          n('permit', ['ipv6', 'any', 'any']),
          n('sequence', ['5', 'permit', 'icmp', 'any', 'any', 'nd-ns']),
          n('permit', ['icmp', 'any', 'any', 'nd-na', 'sequence', '6']),
          n('permit', ['udp', 'any', 'any'], [], 15),
          n('deny', ['bogus']),
        ]),
        n('ip', ['access-list', 'extended', 'NO-WEB6'], [n('deny', ['ip', 'any', 'any'])]),
        n('ipv6', ['unicast-routing']),
        n('ipv6', ['access-list', 'EMPTY']),
      ]),
    };
    const lists = readAcls6(config);
    expect([...lists.keys()]).toEqual(['NO-WEB6', 'EMPTY']);
    const l = lists.get('NO-WEB6')!;
    expect(l.type).toBe('ipv6');
    expect(l.entries.map((e) => [e.seq, e.text])).toEqual([
      [5, 'permit icmp any any nd-ns'],
      [6, 'permit icmp any any nd-na'],
      [10, `deny tcp host ${PC1} host ${SRV} eq www`],
      [15, 'permit udp any any'],
      [20, 'permit ipv6 any any'],
    ]);
    expect(l.remarks).toEqual([{ before: 2, text: 'no web for PC1' }]);
    expect(lists.get('EMPTY')!.entries).toEqual([]);
  });
});

describe('core/acl6 [S11]: tupleOf6', () => {
  const layer = (proto: string, fields: Record<string, unknown>): LayerView =>
    ({ proto, offset: 0, length: 0, headerLength: 0, fields, fieldRanges: {} }) as unknown as LayerView;
  const ip6 = (nextHeader: number): LayerView => layer('ipv6', { src: PC1, dst: SRV, nextHeader, hopLimit: 64 });
  it('reads TCP, UDP and ICMPv6 after the extension headers', () => {
    expect(tupleOf6({ layers: [layer('ethernet', {}), ip6(6), layer('tcp', { srcPort: 49152, dstPort: 80, flags: 'S' })] })).toEqual(synWeb);
    expect(tupleOf6({ layers: [ip6(0), layer('ipv6-hopopts', { nextHeader: 60 }), layer('ipv6-dstopts', { nextHeader: 17 }), layer('udp', { srcPort: 546, dstPort: 547 })] }))
      .toEqual(t6({ proto: 17, src: PC1, dst: SRV, srcPort: 546, dstPort: 547 }));
    expect(tupleOf6({ layers: [ip6(58), layer('icmpv6', { type: 128, code: 0 })] })).toEqual(ping6);
    expect(tupleOf6({ layers: [ip6(59)] })).toEqual(t6({ proto: 59, src: PC1, dst: SRV }));
    expect(tupleOf6({ layers: [layer('ipv4', { src: '10.0.0.1', dst: '10.0.0.2', protocol: 6 })] })).toBeUndefined();
  });

  it('a non-initial fragment carries no L4 fields; an atomic fragment does', () => {
    expect(tupleOf6({ layers: [ip6(44), layer('ipv6-frag', { nextHeader: 6, offset: 185, more: false, id: 7 }), layer('payload', {})] }))
      .toEqual(t6({ proto: 6, src: PC1, dst: SRV, fragment: 'non-initial' }));
    expect(tupleOf6({ layers: [ip6(44), layer('ipv6-frag', { nextHeader: 6, offset: 0, more: false, id: 7 }), layer('tcp', { srcPort: 49152, dstPort: 80, flags: 'S' })] }))
      .toEqual(synWeb);
    expect(tupleOf6({ layers: [ip6(44), layer('ipv6-frag', { nextHeader: 6, offset: 0, more: true, id: 7 }), layer('payload', {})] }))
      .toEqual(t6({ proto: 6, src: PC1, dst: SRV }));
  });
});

describe('core/acl6 [S11]: evaluateAcl6 and the implicit ND tail (§3.6 walk-through)', () => {
  it('step 1: the SYN matches row 10; ping6 passes row 20', () => {
    const list = listOf([`deny tcp host ${PC1} host ${SRV} eq www`, 'permit ipv6 any any']);
    expect(evaluateAcl6(list, synWeb)).toEqual({
      action: 'deny', seq: 10, index: 0, trail: [{ seq: 10, text: `deny tcp host ${PC1} host ${SRV} eq www`, result: 'match' }],
    });
    expect(evaluateAcl6(list, ping6)).toMatchObject({ action: 'permit', seq: 20, index: 1 });
    expect(aclKey(6, 'NO-WEB6', 10)).toBe('6|NO-WEB6|10');
  });

  it('step 2: an explicit deny ipv6 any any drops ND before the tail; lint says nd-blocked', () => {
    const list = listOf(['deny ipv6 any any']);
    expect(evaluateAcl6(list, ns)).toMatchObject({ action: 'deny', seq: 10 });
    expect(evaluateAcl6(list, na)).toMatchObject({ action: 'deny', seq: 10 });
    const lint = lintAcl6(list);
    expect(lint.map((f) => [f.code, f.seq, f.ndTypes])).toEqual([['nd-blocked', 10, [135, 136]], ['no-permit', undefined, undefined]]);
    // inserting the two permits above it restores ND
    const fixed: Acl6List = {
      ...list,
      entries: [
        { seq: 5, entry: parseAcl6Entry(tokens('permit icmp any any nd-ns'))!, text: 'permit icmp any any nd-ns' },
        { seq: 6, entry: parseAcl6Entry(tokens('permit icmp any any nd-na'))!, text: 'permit icmp any any nd-na' },
        ...list.entries,
      ],
    };
    expect(evaluateAcl6(fixed, ns)).toMatchObject({ action: 'permit', seq: 5 });
    expect(evaluateAcl6(fixed, na)).toMatchObject({ action: 'permit', seq: 6 });
    expect(lintAcl6(fixed).filter((f) => f.code === 'nd-blocked')).toEqual([]);
  });

  it('step 3: with no explicit deny, ND passes through the implicit nd-na / nd-ns rows; RS and RA do not', () => {
    const list = listOf(['permit tcp any any eq 22']);
    expect(evaluateAcl6(list, na)).toEqual({
      action: 'permit', seq: null, implicit: 'nd-na',
      trail: [
        { seq: 10, text: 'permit tcp any any eq 22', result: 'miss', failed: 'protocol' },
        { seq: 'nd-na', text: 'permit icmp any any nd-na', result: 'match' },
      ],
    });
    expect(evaluateAcl6(list, ns)).toMatchObject({ action: 'permit', seq: null, implicit: 'nd-ns' });
    expect(evaluateAcl6(list, rs)).toMatchObject({ action: 'deny', seq: null, implicit: 'deny' });
    expect(evaluateAcl6(list, synWeb).trail.map((s) => s.seq)).toEqual([10, 'nd-na', 'nd-ns', 'implicit']);
    expect(aclTrailText(evaluateAcl6(list, rs).trail)).toEqual([
      'line 10 permit tcp any any eq 22: no match, the protocol differs',
      'implicit permit icmp any any nd-na: no match, the ICMP message differs',
      'implicit permit icmp any any nd-ns: no match, the ICMP message differs',
      'implicit deny ipv6 any any: match, denied',
    ]);
    expect(ACL6_IMPLICIT_TAIL.map((r) => [r.implicit, r.text])).toEqual([
      ['nd-na', 'permit icmp any any nd-na'], ['nd-ns', 'permit icmp any any nd-ns'], ['deny', 'deny ipv6 any any'],
    ]);
    expect(aclKey(6, 'NO-WEB6', 'nd-na')).toBe('6|NO-WEB6|nd-na');
    expect(lintAcl6(list)).toEqual([]);
  });

  it('prefixes, ports, established and the fragment rule', () => {
    const e = parseAcl6Entry(tokens('permit tcp 2001:db8:10::/64 any eq www established'))!;
    expect(acl6EntryMiss(e, { ...synWeb, tcpFlags: 0x10 })).toBeUndefined();
    expect(acl6EntryMiss(e, synWeb)).toBe('established');
    expect(acl6EntryMiss(e, { ...synWeb, src: '2001:db8:11::10' })).toBe('source');
    expect(acl6EntryMiss(e, { ...synWeb, tcpFlags: 0x10, dstPort: 443 })).toBe('destination-port');
    const frag = t6({ proto: 6, src: PC1, dst: SRV, fragment: 'non-initial' });
    expect(acl6EntryMiss(e, frag)).toBeUndefined();
    const list = listOf([`deny tcp host ${PC1} host ${SRV} eq www`, 'permit ipv6 any any']);
    expect(evaluateAcl6(list, frag)).toMatchObject({ action: 'permit', seq: 20 });
    expect(evaluateAcl6(list, frag).trail[0]).toEqual({ seq: 10, text: `deny tcp host ${PC1} host ${SRV} eq www`, result: 'miss', failed: 'fragment' });
  });
});

describe('core/acl6 [S11]: lintAcl6', () => {
  it('unreachable entries, a partial ND permit, and nd-blocked once per entry', () => {
    expect(lintAcl6(listOf(['permit ipv6 2001:db8::/32 any', 'permit tcp 2001:db8:10::/64 any eq www'])).map((f) => [f.code, f.seq, f.coveredBy]))
      .toEqual([['unreachable', 20, 10]]);
    // a permit for one host's ND leaves the others open: the deny still blocks them
    expect(lintAcl6(listOf([`permit icmp host ${R1} any nd-na`, 'deny icmp any any'])).filter((f) => f.code === 'nd-blocked').map((f) => [f.seq, f.ndTypes]))
      .toEqual([[20, [135, 136]]]);
    expect(lintAcl6(listOf(['permit icmp any any nd-ns', 'deny ipv6 any any', 'deny icmp any any nd-na'])).filter((f) => f.code === 'nd-blocked').map((f) => [f.seq, f.ndTypes]))
      .toEqual([[20, [136]]]);
    expect(lintAcl6(listOf(['deny tcp any any', 'deny icmp any any echo-request', 'permit ipv6 any any']))).toEqual([]);
  });
});
