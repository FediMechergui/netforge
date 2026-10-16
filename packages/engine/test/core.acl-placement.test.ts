// core/acl-placement, P3c [S23] (ARCHITECTURE-P3C §7 W1a core, §8.2): the placement advisor's findings and the
// impact preview of a draft edit, on a described router (no simulation).
import { describe, expect, it } from 'vitest';
import type { PacketTuple } from '../src/contracts/process.js';
import { aclEntryText, parseAclEntry, type AclList, type AclListType } from '../src/core/acl.js';
import { aclImpact, aclPlacementFindings, type AclPlacementInput } from '../src/core/acl-placement.js';

const listOf = (name: string, type: AclListType, lines: string[]): AclList => ({
  name,
  type,
  entries: lines.map((l, i) => {
    const entry = parseAclEntry(type, l.split(' '))!;
    return { seq: (i + 1) * 10, entry, text: aclEntryText(entry) };
  }),
  remarks: [],
});

// R1: Gi0/0 staff 192.168.10.0/24 (PC1 .10, PC2 .11), Gi0/1 servers 192.168.20.0/24 (SRV .100),
// Gi0/2 a second LAN 192.168.30.0/24 (PC3 .30).
const sources = [
  { label: 'PC1', address: '192.168.10.10', ingress: 'Gi0/0' },
  { label: 'PC2', address: '192.168.10.11', ingress: 'Gi0/0' },
  { label: 'PC3', address: '192.168.30.30', ingress: 'Gi0/2' },
];
const destinations = [
  { label: 'SRV', address: '192.168.20.100', egress: 'Gi0/1' },
  { label: 'PC3', address: '192.168.30.30', egress: 'Gi0/2' },
  { label: 'PC1', address: '192.168.10.10', egress: 'Gi0/0' },
];
const std = listOf('1', 'standard', ['deny host 192.168.10.10', 'permit any']);
const at = (list: AclList, iface: string, dir: 'in' | 'out'): AclPlacementInput => ({ list, iface, dir, sources, destinations });

describe('core/acl-placement [S23]: findings', () => {
  it('a standard list inbound at the source edge: standard-near-source, naming the destinations it also cuts', () => {
    expect(aclPlacementFindings(at(std, 'Gi0/0', 'in'))).toEqual([{
      code: 'standard-near-source',
      severity: 'warning',
      list: '1',
      iface: 'Gi0/0',
      dir: 'in',
      sources: ['PC1'],
      destinations: ['SRV', 'PC3'],
      text: 'Standard list 1 is applied inbound on Gi0/0, next to the sources it denies. A standard list reads only the source address, so PC1 also loses SRV and PC3. Apply it outbound on the interface toward the destination you want to protect.',
    }]);
  });

  it('the solved placement (outbound toward the destination) has no finding', () => {
    expect(aclPlacementFindings(at(std, 'Gi0/1', 'out'))).toEqual([]);
    // inbound where no denied source arrives: nothing to say either
    expect(aclPlacementFindings(at(std, 'Gi0/2', 'in'))).toEqual([]);
    // a list that denies nobody arriving there
    expect(aclPlacementFindings(at(listOf('2', 'standard', ['permit any']), 'Gi0/0', 'in'))).toEqual([]);
  });

  it('an extended list outbound near the destination: extended-near-destination (info)', () => {
    const ext = listOf('101', 'extended', ['deny tcp host 192.168.10.10 host 192.168.20.100 eq www', 'permit ip any any']);
    const f = aclPlacementFindings(at(ext, 'Gi0/1', 'out'));
    expect(f.map((x) => [x.code, x.severity, x.sources, x.destinations])).toEqual([['extended-near-destination', 'info', ['PC1'], ['SRV']]]);
    expect(f[0]!.text).toBe('Extended list 101 is applied outbound on Gi0/1, so the traffic it denies from PC1 crosses the network before it is dropped. Apply it inbound on the interface where that traffic arrives.');
    // inbound near the source is the recommended place
    expect(aclPlacementFindings(at(ext, 'Gi0/0', 'in'))).toEqual([]);
    // the implicit deny alone is not a finding
    expect(aclPlacementFindings(at(listOf('102', 'extended', ['permit tcp any any eq www']), 'Gi0/1', 'out'))).toEqual([]);
  });
});

describe('core/acl-placement [S23]: impact preview', () => {
  const t = (src: string, dst: string, proto: number, dstPort?: number): PacketTuple =>
    dstPort === undefined ? { family: 4, proto, src, dst } : { family: 4, proto, src, dst, srcPort: 49152, dstPort, tcpFlags: 0x02 };
  const flows = [
    { id: 'PC1→SRV web', tuple: t('192.168.10.10', '192.168.20.100', 6, 80) },
    { id: 'PC1→SRV ping', tuple: t('192.168.10.10', '192.168.20.100', 1) },
    { id: 'PC2→SRV web', tuple: t('192.168.10.11', '192.168.20.100', 6, 80) },
    { id: 'PC3→SRV ssh', tuple: t('192.168.30.30', '192.168.20.100', 6, 22) },
  ];

  it('lists exactly the flows whose action changes, in input order', () => {
    const before = listOf('101', 'extended', ['deny tcp host 192.168.10.10 host 192.168.20.100 eq www', 'permit ip any any']);
    const after = listOf('101', 'extended', ['deny tcp 192.168.10.0 0.0.0.255 host 192.168.20.100 eq www', 'deny tcp any any eq 22', 'permit ip any any']);
    expect(aclImpact(before, after, flows)).toEqual([
      { id: 'PC2→SRV web', before: { action: 'permit', seq: 20 }, after: { action: 'deny', seq: 10 } },
      { id: 'PC3→SRV ssh', before: { action: 'permit', seq: 20 }, after: { action: 'deny', seq: 20 } },
    ]);
    // a flow decided by another entry with the same action is not a change
    expect(aclImpact(before, before, flows)).toEqual([]);
  });

  it('an absent list permits everything (a new list, a removed list)', () => {
    const only = listOf('101', 'extended', ['permit icmp any any']);
    expect(aclImpact(undefined, only, flows).map((c) => [c.id, c.before, c.after])).toEqual([
      ['PC1→SRV web', { action: 'permit', seq: null }, { action: 'deny', seq: null }],
      ['PC2→SRV web', { action: 'permit', seq: null }, { action: 'deny', seq: null }],
      ['PC3→SRV ssh', { action: 'permit', seq: null }, { action: 'deny', seq: null }],
    ]);
    expect(aclImpact(only, undefined, flows).map((c) => c.id)).toEqual(['PC1→SRV web', 'PC2→SRV web', 'PC3→SRV ssh']);
  });
});
