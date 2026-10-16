// core/acl, P3c [S17a] (ARCHITECTURE-P3C §3.8 step 5, §7 W1a core): the ACL non-initial-fragment rule and the
// `fragments` keyword, on crafted tuples (no traffic needed), and `tupleOf` marking a non-initial fragment.
import { describe, expect, it } from 'vitest';
import type { LayerSpec, PduView } from '../src/contracts/pdu.js';
import type { PacketTuple } from '../src/contracts/process.js';
import { aclEntryMiss, aclEntryText, evaluateAcl, lintAcl, parseAclEntry, tupleOf, type AclEntry, type AclList } from '../src/core/acl.js';
import { createPduFactory } from '../src/pdu/factory.js';

const tokens = (line: string): string[] => line.split(' ');
const ext = (line: string): AclEntry | undefined => parseAclEntry('extended', tokens(line));
const listOf = (lines: string[]): AclList => ({
  name: '101',
  type: 'extended',
  entries: lines.map((l, i) => {
    const entry = parseAclEntry('extended', tokens(l))!;
    return { seq: (i + 1) * 10, entry, text: aclEntryText(entry) };
  }),
  remarks: [],
});

/** A non-initial TCP fragment from PC1 to the server: L3 fields only. */
const frag: PacketTuple = { family: 4, proto: 6, src: '192.168.10.10', dst: '192.168.20.100', fragment: 'non-initial' };
/** The initial fragment / unfragmented SYN of the same flow. */
const syn: PacketTuple = { family: 4, proto: 6, src: '192.168.10.10', dst: '192.168.20.100', srcPort: 49152, dstPort: 80, tcpFlags: 0x02 };

describe('core/acl P3c [S17a]: the fragment rule', () => {
  it('a deny with L4 conditions is skipped by a non-initial fragment, with failed "fragment"', () => {
    const list = listOf(['deny tcp host 192.168.10.10 host 192.168.20.100 eq www', 'permit ip any any']);
    expect(evaluateAcl(list, syn)).toMatchObject({ action: 'deny', seq: 10 });
    expect(evaluateAcl(list, frag)).toEqual({
      action: 'permit', seq: 20, index: 1,
      trail: [
        { seq: 10, text: 'deny tcp host 192.168.10.10 host 192.168.20.100 eq www', result: 'miss', failed: 'fragment' },
        { seq: 20, text: 'permit ip any any', result: 'match' },
      ],
    });
    // the L3 part is checked first: a fragment of another host misses on its source, as before
    expect(aclEntryMiss(ext('deny tcp host 192.168.10.10 any eq www')!, { ...frag, src: '192.168.10.11' })).toBe('source');
    for (const l4 of ['deny tcp any any established', 'deny tcp any eq 1234 any', 'deny icmp any any echo', 'deny udp any any range 1 2']) {
      expect(aclEntryMiss(ext(l4)!, { ...frag, proto: l4.includes('icmp') ? 1 : l4.includes('udp') ? 17 : 6 }), l4).toBe('fragment');
    }
  });

  it('a permit with L4 conditions matches a non-initial fragment on its L3 part', () => {
    const list = listOf(['permit tcp any host 192.168.20.100 eq www', 'deny ip any any']);
    expect(evaluateAcl(list, frag)).toMatchObject({ action: 'permit', seq: 10 });
    expect(evaluateAcl(list, { ...syn, dstPort: 22 })).toMatchObject({ action: 'deny', seq: 20 });
    expect(aclEntryMiss(ext('permit tcp any any established')!, frag)).toBeUndefined();
    expect(aclEntryMiss(ext('permit udp any any eq domain')!, frag)).toBe('protocol');
  });

  it('entries without L4 conditions treat a fragment like any packet', () => {
    expect(aclEntryMiss(ext('deny tcp any any')!, frag)).toBeUndefined();
    expect(aclEntryMiss(ext('deny ip host 192.168.10.10 any')!, frag)).toBeUndefined();
    expect(parseAclEntry('standard', ['deny', 'host', '192.168.10.10'])).toBeDefined();
    const std: AclList = { name: '1', type: 'standard', entries: [{ seq: 10, entry: parseAclEntry('standard', ['deny', 'host', '192.168.10.10'])!, text: 'deny 192.168.10.10' }], remarks: [] };
    expect(evaluateAcl(std, frag)).toMatchObject({ action: 'deny', seq: 10 });
  });

  it('the fragments keyword matches non-initial fragments only, and never takes L4 conditions', () => {
    const e = ext('deny ip any host 192.168.20.100 fragments')!;
    expect(e).toMatchObject({ fragments: true });
    expect(aclEntryText(e)).toBe('deny ip any host 192.168.20.100 fragments');
    expect(aclEntryText(ext('permit tcp any any fragments log')!)).toBe('permit tcp any any fragments log');
    expect(aclEntryText(ext('permit ip any any log fragments dscp ef')!)).toBe('permit ip any any dscp ef fragments log');
    expect(aclEntryMiss(e, frag)).toBeUndefined();
    expect(aclEntryMiss(e, syn)).toBe('fragment');
    expect(aclEntryMiss(e, { ...frag, dst: '192.168.20.101' })).toBe('destination');
    for (const bad of ['deny tcp any any eq www fragments', 'deny tcp any any established fragments', 'deny icmp any any echo fragments', 'deny ip any any fragments fragments']) {
      expect(ext(bad), bad).toBeUndefined();
    }
    expect(parseAclEntry('standard', ['deny', 'any', 'fragments'])).toBeUndefined();
    const list = listOf(['deny ip any any fragments', 'permit tcp any any eq www']);
    expect(evaluateAcl(list, frag)).toMatchObject({ action: 'deny', seq: 10 });
    expect(evaluateAcl(list, syn).trail).toEqual([
      { seq: 10, text: 'deny ip any any fragments', result: 'miss', failed: 'fragment' },
      { seq: 20, text: 'permit tcp any any eq www', result: 'match' },
    ]);
  });

  it('lint follows the rule', () => {
    const unreachable = (lines: string[]): number[] => lintAcl(listOf(lines)).filter((f) => f.code === 'unreachable').map((f) => f.seq!);
    expect(unreachable(['deny ip any any fragments', 'deny ip any any'])).toEqual([]);
    expect(unreachable(['deny ip any any', 'deny ip any any fragments'])).toEqual([20]);
    expect(unreachable(['permit tcp any any eq www', 'permit tcp any any fragments'])).toEqual([20]);
    expect(unreachable(['deny tcp any any eq www', 'deny tcp any any fragments'])).toEqual([]);
    // a deny over every port still lets the fragments through to the next entry
    expect(unreachable(['deny tcp any any range 0 65535', 'deny tcp any any'])).toEqual([]);
    expect(unreachable(['permit tcp any any range 0 65535', 'permit tcp any any'])).toEqual([20]);
  });
});

describe('core/acl P3c [S17a]: tupleOf marks a non-initial fragment', () => {
  const f = createPduFactory();
  const build = (layers: LayerSpec[]): PduView => f.build(layers, { born: 0, origin: 'r1' as const });
  it('from fragOffset; offset 0 (the initial fragment) keeps its L4 fields', () => {
    const ip = (fragOffset: number, flags: number): LayerSpec => ({ proto: 'ipv4', fields: { src: '192.168.10.10', dst: '192.168.20.100', protocol: 6, ttl: 64, fragOffset, flags } });
    const tcp: LayerSpec = { proto: 'tcp', fields: { srcPort: 49152, dstPort: 80, flags: 'S' } };
    expect(tupleOf(build([ip(0, 1), tcp]))).toEqual(syn);
    const later = tupleOf(build([ip(185, 0), { proto: 'payload', fields: { data: new Uint8Array(8) } }]));
    expect(later).toEqual(frag);
  });
});
