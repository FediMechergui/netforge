// core/acl (ARCHITECTURE-P2 D14, §3.9 "Dynamic pool", §5.2): standard IPv4 lists, matching only — first match
// wins, implicit deny, a missing list permits nothing; numbered and named lists read from a running-config tree.
import { describe, expect, it } from 'vitest';
import type { ConfigNode } from '../src/contracts/config.js';
import {
  ACL_WILDCARD_ANY,
  ACL_WILDCARD_HOST,
  aclEntryMatches,
  aclPermits,
  isStandardAclNumber,
  matchStandardAcl,
  parseStandardAclEntry,
  readStandardAcls,
  standardAclEntryTokens,
  standardAclFromLines,
  type StandardAcl,
} from '../src/core/acl.js';

const n = (key: string, args: string[] = [], children: ConfigNode[] = []): ConfigNode => ({ key, args, children });
const tokens = (line: string): string[] => line.split(' ');

describe('core/acl: entries', () => {
  it('parses the four entry forms into canonical address/wildcard pairs', () => {
    expect(parseStandardAclEntry(tokens('permit any'))).toEqual({ action: 'permit', address: '0.0.0.0', wildcard: ACL_WILDCARD_ANY });
    expect(parseStandardAclEntry(tokens('deny host 10.0.0.1'))).toEqual({ action: 'deny', address: '10.0.0.1', wildcard: ACL_WILDCARD_HOST });
    expect(parseStandardAclEntry(tokens('permit 10.0.0.1'))).toEqual({ action: 'permit', address: '10.0.0.1', wildcard: '0.0.0.0' });
    expect(parseStandardAclEntry(tokens('permit 192.168.1.0 0.0.0.255'))).toEqual({ action: 'permit', address: '192.168.1.0', wildcard: '0.0.0.255' });
    // the bits the wildcard ignores are cleared, as the device shows the line
    expect(parseStandardAclEntry(tokens('permit 192.168.1.77 0.0.0.255'))).toEqual({ action: 'permit', address: '192.168.1.0', wildcard: '0.0.0.255' });
    expect(parseStandardAclEntry(tokens('deny 10.1.2.3 0.255.0.255'))).toEqual({ action: 'deny', address: '10.0.2.0', wildcard: '0.255.0.255' });
  });

  it('rejects remarks and malformed entries', () => {
    for (const bad of ['remark SALES hosts', 'permit', 'allow any', 'permit any 0.0.0.0', 'permit host', 'permit host x', 'permit 10.0.0.300',
      'permit 10.0.0.0 0.0.0.256', 'permit 10.0.0.0 0.0.0.255 log', 'permit host 10.0.0.1 0.0.0.0', '']) {
      expect(parseStandardAclEntry(bad === '' ? [] : tokens(bad)), bad).toBeUndefined();
    }
  });

  it('canonical tokens: bare address for one host, any, or address plus wildcard', () => {
    const canon = (line: string): string => standardAclEntryTokens(parseStandardAclEntry(tokens(line))!).join(' ');
    expect(canon('permit host 10.0.0.1')).toBe('permit 10.0.0.1');
    expect(canon('permit 10.0.0.1 0.0.0.0')).toBe('permit 10.0.0.1');
    expect(canon('deny 0.0.0.0 255.255.255.255')).toBe('deny any');
    expect(canon('deny 1.2.3.4 255.255.255.255')).toBe('deny any');
    expect(canon('permit 192.168.1.5 0.0.0.255')).toBe('permit 192.168.1.0 0.0.0.255');
    // canonical tokens parse back to the same entry
    for (const line of ['permit any', 'deny host 10.9.9.9', 'permit 172.16.0.0 0.15.255.255', 'deny 10.1.0.0 0.0.255.0']) {
      const e = parseStandardAclEntry(tokens(line))!;
      expect(parseStandardAclEntry(standardAclEntryTokens(e))).toEqual(e);
    }
  });

  it('matches bit by bit, including a non-contiguous wildcard', () => {
    const e = parseStandardAclEntry(tokens('permit 192.168.1.0 0.0.0.255'))!;
    expect(aclEntryMatches(e, '192.168.1.0')).toBe(true);
    expect(aclEntryMatches(e, '192.168.1.255')).toBe(true);
    expect(aclEntryMatches(e, '192.168.2.1')).toBe(false);
    const odd = parseStandardAclEntry(tokens('permit 10.0.5.0 0.255.0.255'))!;
    expect(aclEntryMatches(odd, '10.200.5.7')).toBe(true);
    expect(aclEntryMatches(odd, '10.200.6.7')).toBe(false);
    const any = parseStandardAclEntry(tokens('deny any'))!;
    expect(aclEntryMatches(any, '255.255.255.255')).toBe(true);
    expect(aclEntryMatches(any, '0.0.0.0')).toBe(true);
    const host = parseStandardAclEntry(tokens('permit host 128.0.0.1'))!;
    expect(aclEntryMatches(host, '128.0.0.1')).toBe(true);
    expect(aclEntryMatches(host, '128.0.0.0')).toBe(false);
  });
});

describe('core/acl: lists', () => {
  const acl = (name: string, lines: string[]): StandardAcl => standardAclFromLines(name, lines.map(tokens));

  it('first match wins', () => {
    const a = acl('1', ['deny host 192.168.1.10', 'permit 192.168.1.0 0.0.0.255', 'deny any']);
    expect(matchStandardAcl(a, '192.168.1.10')).toEqual({ action: 'deny', index: 0 });
    expect(matchStandardAcl(a, '192.168.1.11')).toEqual({ action: 'permit', index: 1 });
    expect(matchStandardAcl(a, '10.0.0.1')).toEqual({ action: 'deny', index: 2 });
    // the same entries in the other order give the other answer for .10
    const b = acl('1', ['permit 192.168.1.0 0.0.0.255', 'deny host 192.168.1.10']);
    expect(matchStandardAcl(b, '192.168.1.10')).toEqual({ action: 'permit', index: 0 });
  });

  it('an address no entry matches is denied (implicit deny, no index)', () => {
    const a = acl('1', ['permit 192.168.1.0 0.0.0.255']);
    expect(matchStandardAcl(a, '192.168.2.1')).toEqual({ action: 'deny' });
    expect('index' in matchStandardAcl(a, '192.168.2.1')).toBe(false);
    expect(aclPermits(a, '192.168.2.1')).toBe(false);
    expect(aclPermits(a, '192.168.1.200')).toBe(true);
    // an empty list (remarks only) denies everything
    const empty = acl('9', ['remark nothing yet']);
    expect(empty.entries).toEqual([]);
    expect(matchStandardAcl(empty, '1.1.1.1')).toEqual({ action: 'deny' });
  });

  it('a list that does not exist permits nothing', () => {
    expect(aclPermits(undefined, '192.168.1.10')).toBe(false);
  });

  it('the §3.9 dynamic-pool list permits the inside hosts and nothing else', () => {
    const a = acl('1', ['permit 192.168.1.0 0.0.0.255']);
    expect(aclPermits(a, '192.168.1.10')).toBe(true);
    expect(aclPermits(a, '192.168.1.11')).toBe(true);
    expect(aclPermits(a, '203.0.113.10')).toBe(false);
  });

  it('standard numbers are 1-99 and 1300-1999', () => {
    expect([1, 99, 1300, 1999, '1', '55', '1300'].map(isStandardAclNumber)).toEqual([true, true, true, true, true, true, true]);
    expect([0, 100, 199, 1299, 2000, 2699, 1.5, '100', 'NAT', '', '-1', '1e1'].map(isStandardAclNumber)).toEqual(
      [false, false, false, false, false, false, false, false, false, false, false, false],
    );
  });
});

describe('core/acl: reading lists from a running-config tree', () => {
  it('reads numbered lines and named sections in configuration order', () => {
    const root = n('', [], [
      n('hostname', ['R1']),
      n('access-list', ['1', 'permit', '192.168.1.0', '0.0.0.255']),
      n('ip', ['access-list', 'standard', 'INSIDE'], [
        n('deny', ['host', '10.0.0.5']),
        n('remark', ['servers', 'next']),
        n('permit', ['10.0.0.0', '0.0.0.255']),
      ]),
      n('access-list', ['1', 'deny', 'any']),
      n('access-list', ['1300', 'permit', 'host', '172.16.0.1']),
      n('interface', ['GigabitEthernet0/0'], [n('ip', ['nat', 'inside'])]),
    ]);
    const lists = readStandardAcls({ root });
    expect([...lists.keys()]).toEqual(['1', 'INSIDE', '1300']);
    expect(lists.get('1')).toEqual({
      name: '1',
      entries: [
        { action: 'permit', address: '192.168.1.0', wildcard: '0.0.0.255' },
        { action: 'deny', address: '0.0.0.0', wildcard: '255.255.255.255' },
      ],
    });
    expect(lists.get('INSIDE')!.entries.map((e) => standardAclEntryTokens(e).join(' '))).toEqual(['deny 10.0.0.5', 'permit 10.0.0.0 0.0.0.255']);
    expect(aclPermits(lists.get('INSIDE'), '10.0.0.5')).toBe(false);
    expect(aclPermits(lists.get('INSIDE'), '10.0.0.6')).toBe(true);
    expect(aclPermits(lists.get('1300'), '172.16.0.1')).toBe(true);
    expect(aclPermits(lists.get('NOPE'), '10.0.0.6')).toBe(false);
  });

  it('ignores extended numbers and extended sections; a numeric named section joins its numbered list', () => {
    const root = n('', [], [
      n('access-list', ['101', 'permit', 'ip', 'any', 'any']),
      n('access-list', ['2000', 'permit', 'any']),
      n('ip', ['access-list', 'extended', 'WEB'], [n('permit', ['tcp', 'any', 'any', 'eq', '80'])]),
      n('access-list', ['5', 'permit', 'host', '10.0.0.1']),
      n('ip', ['access-list', 'standard', '5'], [n('permit', ['host', '10.0.0.2'])]),
      n('access-list', ['7', 'remark', 'only', 'a', 'remark']),
    ]);
    const lists = readStandardAcls({ root });
    expect([...lists.keys()]).toEqual(['5', '7']);
    expect(lists.get('5')!.entries.map((e) => e.address)).toEqual(['10.0.0.1', '10.0.0.2']);
    expect(lists.get('7')!.entries).toEqual([]);
  });

  it('also reads a named section folded under an ip group node', () => {
    const root = n('', [], [n('ip', [], [n('routing'), n('access-list', ['standard', 'LAN'], [n('permit', ['any'])])])]);
    const lists = readStandardAcls({ root });
    expect(lists.get('LAN')!.entries).toEqual([{ action: 'permit', address: '0.0.0.0', wildcard: ACL_WILDCARD_ANY }]);
  });

  it('reads the tree without changing it and is deterministic', () => {
    const root = n('', [], [n('access-list', ['1', 'permit', '10.0.0.0', '0.255.255.255'])]);
    const before = JSON.stringify(root);
    const a = JSON.stringify([...readStandardAcls({ root })]);
    const b = JSON.stringify([...readStandardAcls({ root })]);
    expect(a).toBe(b);
    expect(JSON.stringify(root)).toBe(before);
    expect(readStandardAcls({ root: n('', []) }).size).toBe(0);
  });
});
