// core/acl, P3c (ARCHITECTURE-P3C §7 W1a core): the [S12] extended-entry terms `dscp`, `precedence` and `log-input`,
// `tupleOf`'s DSCP, and the [S10] `aclTrailText` walk. Every P3 entry keeps its parse and its canonical text.
import { describe, expect, it } from 'vitest';
import type { LayerSpec, PduView } from '../src/contracts/pdu.js';
import type { PacketTuple } from '../src/contracts/process.js';
import {
  ACL_DSCP_NAMES,
  ACL_PRECEDENCE_NAMES,
  aclEntryMiss,
  aclEntryText,
  aclTrailText,
  evaluateAcl,
  lintAcl,
  parseAclEntry,
  tupleOf,
  type AclEntry,
  type AclList,
} from '../src/core/acl.js';
import { createPduFactory } from '../src/pdu/factory.js';

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

describe('core/acl P3c [S12]: dscp, precedence and log-input', () => {
  it('parses each term by number or name and shows it by name', () => {
    expect(ext('permit ip any any dscp ef')).toEqual({
      kind: 'extended', action: 'permit', protocol: 'ip',
      source: { address: '0.0.0.0', wildcard: '255.255.255.255' }, destination: { address: '0.0.0.0', wildcard: '255.255.255.255' },
      dscp: 46,
    });
    expect(canon('permit ip any any dscp 46')).toBe('permit ip any any dscp ef');
    expect(canon('permit udp any any range 16384 32767 dscp 34')).toBe('permit udp any any range 16384 32767 dscp af41');
    expect(canon('permit ip any any dscp 7')).toBe('permit ip any any dscp 7');
    expect(canon('deny tcp any any eq www precedence 5')).toBe('deny tcp any any eq www precedence critical');
    expect(canon('permit ip any any precedence flash-override')).toBe('permit ip any any precedence flash-override');
    expect(ext('permit ip any any precedence 4')!).toMatchObject({ precedence: 4 });
    for (const [name, v] of ACL_DSCP_NAMES) expect(ext(`permit ip any any dscp ${name}`)).toMatchObject({ dscp: v });
    for (const [name, v] of ACL_PRECEDENCE_NAMES) expect(ext(`permit ip any any precedence ${name}`)).toMatchObject({ precedence: v });
  });

  it('log-input is its own flag, shown last; the terms come in any order but once each', () => {
    const e = ext('deny tcp host 10.1.1.1 any eq telnet log-input')!;
    expect(e).toMatchObject({ logInput: true });
    expect('log' in e).toBe(false);
    expect(aclEntryText(e)).toBe('deny tcp host 10.1.1.1 any eq telnet log-input');
    expect(canon('permit ip any any log-input dscp ef')).toBe('permit ip any any dscp ef log-input');
    expect(canon('permit ip any any log dscp cs3')).toBe('permit ip any any dscp cs3 log');
    expect(canon('permit icmp any any echo dscp ef log')).toBe('permit icmp any any echo dscp ef log');
    for (const bad of [
      'permit ip any any dscp 64', 'permit ip any any dscp', 'permit ip any any dscp bogus', 'permit ip any any precedence 8',
      'permit ip any any dscp ef precedence 5', 'permit ip any any dscp ef dscp ef', 'permit ip any any log log-input',
      'permit ip any any log log', 'permit ip any any log-input log-input',
    ]) {
      expect(ext(bad), bad).toBeUndefined();
    }
    // a standard list has no log-input and no DS terms
    expect(parseAclEntry('standard', tokens('permit any log-input'))).toBeUndefined();
    expect(parseAclEntry('standard', tokens('permit any dscp ef'))).toBeUndefined();
  });

  it('every P3 entry keeps its parse and its text', () => {
    for (const line of [
      'permit ip any any', 'deny tcp host 192.168.10.10 host 192.168.20.100 eq www log', 'permit tcp any any established',
      'permit icmp any any echo-reply', 'permit udp any eq bootpc any eq bootps', 'deny icmp any any administratively-prohibited log', 'deny icmp any any 3 9',
    ]) {
      const e = ext(line)!;
      expect(aclEntryText(e)).toBe(line);
      expect('dscp' in e || 'precedence' in e || 'logInput' in e || 'fragments' in e).toBe(false);
    }
  });

  it('a dscp term matches that DSCP only; precedence matches its eight values; no dscp reads as 0', () => {
    const ef = ext('permit ip any any dscp ef')!;
    const t = tuple({ proto: 17, src: '10.0.0.1', dst: '10.0.0.2' });
    expect(aclEntryMiss(ef, { ...t, dscp: 46 })).toBeUndefined();
    expect(aclEntryMiss(ef, { ...t, dscp: 34 })).toBe('dscp');
    expect(aclEntryMiss(ef, t)).toBe('dscp');
    expect(aclEntryMiss(ext('permit ip any any dscp default')!, t)).toBeUndefined();
    const crit = ext('permit ip any any precedence critical')!;
    for (let d = 0; d < 64; d++) expect(aclEntryMiss(crit, { ...t, dscp: d }) === undefined).toBe(d >> 3 === 5);
    expect(aclEntryMiss(ext('permit ip any any precedence routine')!, t)).toBeUndefined();
    // the L3/L4 parts are checked first
    expect(aclEntryMiss(ext('permit tcp any any dscp ef')!, { ...t, dscp: 46 })).toBe('protocol');
    const list = listOf('extended', ['permit udp any any dscp ef', 'deny udp any any']);
    expect(evaluateAcl(list, { ...t, dscp: 46 }).seq).toBe(10);
    expect(evaluateAcl(list, { ...t, dscp: 0 }).trail).toEqual([
      { seq: 10, text: 'permit udp any any dscp ef', result: 'miss', failed: 'dscp' },
      { seq: 20, text: 'deny udp any any', result: 'match' },
    ]);
  });

  it('lint: a DS term narrows coverage', () => {
    expect(lintAcl(listOf('extended', ['permit ip any any dscp ef', 'permit ip any any dscp af41'])).filter((f) => f.code === 'unreachable')).toEqual([]);
    expect(lintAcl(listOf('extended', ['permit ip any any precedence critical', 'permit ip any any dscp cs5'])).filter((f) => f.code === 'unreachable').map((f) => f.seq)).toEqual([20]);
    expect(lintAcl(listOf('extended', ['permit ip any any', 'permit ip any any dscp ef'])).filter((f) => f.code === 'unreachable').map((f) => f.seq)).toEqual([20]);
    expect(lintAcl(listOf('extended', ['permit ip any any dscp ef', 'permit ip any any'])).filter((f) => f.code === 'unreachable')).toEqual([]);
  });

  it('tupleOf carries a nonzero DSCP only when asked (the P3 tuple otherwise)', () => {
    const f = createPduFactory();
    const build = (layers: LayerSpec[]): PduView => f.build(layers, { born: 0, origin: 'r1' as const });
    const ip = (dscp: number): LayerSpec => ({ proto: 'ipv4', fields: { src: '10.0.0.1', dst: '10.0.0.2', protocol: 17, ttl: 64, dscp } });
    const udp: LayerSpec = { proto: 'udp', fields: { srcPort: 5000, dstPort: 16384 } };
    expect(tupleOf(build([ip(46), udp]), { dscp: true })).toEqual({ family: 4, proto: 17, src: '10.0.0.1', dst: '10.0.0.2', dscp: 46, srcPort: 5000, dstPort: 16384 });
    expect(tupleOf(build([ip(0), udp]), { dscp: true })).toEqual({ family: 4, proto: 17, src: '10.0.0.1', dst: '10.0.0.2', srcPort: 5000, dstPort: 16384 });
    expect(tupleOf(build([ip(46), udp]))).toEqual({ family: 4, proto: 17, src: '10.0.0.1', dst: '10.0.0.2', srcPort: 5000, dstPort: 16384 });
    expect(tupleOf(build([ip(46), udp]), {})).toEqual(tupleOf(build([ip(46), udp])));
  });
});

describe('core/acl P3c [S10]: aclTrailText', () => {
  it('one line per step, the deciding one last', () => {
    const list = listOf('extended', [
      'deny tcp host 192.168.10.10 host 192.168.20.100 eq www',
      'permit icmp any any',
      'permit ip 192.168.10.0 0.0.0.255 any',
    ]);
    const syn = tuple({ proto: 6, src: '192.168.10.11', dst: '192.168.20.100', srcPort: 49152, dstPort: 80, tcpFlags: 0x02 });
    expect(aclTrailText(evaluateAcl(list, syn).trail)).toEqual([
      'line 10 deny tcp host 192.168.10.10 host 192.168.20.100 eq www: no match, the source address is outside the entry',
      'line 20 permit icmp any any: no match, the protocol differs',
      'line 30 permit ip 192.168.10.0 0.0.0.255 any: match, permitted',
    ]);
    const other = tuple({ proto: 17, src: '10.9.9.9', dst: '192.168.20.100', srcPort: 1, dstPort: 2 });
    expect(aclTrailText(evaluateAcl(list, other).trail).slice(-1)).toEqual(['implicit deny ip any any: match, denied']);
    expect(aclTrailText(evaluateAcl(listOf('standard', ['permit 10.0.0.0 0.255.255.255']), other).trail)).toEqual([
      'line 10 permit 10.0.0.0 0.255.255.255: match, permitted',
    ]);
    expect(aclTrailText(evaluateAcl(listOf('extended', ['deny tcp any any eq www']), tuple({ ...syn, src: '1.1.1.1' })).trail)[0]).toBe(
      'line 10 deny tcp any any eq www: match, denied',
    );
  });

  it('every miss reason has words, and the IPv6 tail rows read as implicit', () => {
    const reasons = ['protocol', 'source', 'source-port', 'destination', 'destination-port', 'established', 'icmp', 'dscp', 'precedence', 'fragment'] as const;
    const lines = aclTrailText(reasons.map((failed, i) => ({ seq: i + 1, text: 'permit ip any any', result: 'miss' as const, failed })));
    expect(new Set(lines).size).toBe(reasons.length);
    for (const l of lines) expect(l).toMatch(/^line \d+ permit ip any any: no match, \S/);
    expect(aclTrailText([
      { seq: 'nd-na', text: 'permit icmp any any nd-na', result: 'miss', failed: 'icmp' },
      { seq: 'nd-ns', text: 'permit icmp any any nd-ns', result: 'match' },
    ])).toEqual([
      'implicit permit icmp any any nd-na: no match, the ICMP message differs',
      'implicit permit icmp any any nd-ns: match, permitted',
    ]);
  });
});
