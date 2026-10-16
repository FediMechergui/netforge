/**
 * W1a l2 (ARCHITECTURE-P3C [S14], §3.7, §4.3): ARP access lists and `ip arp inspection validate`, pure.
 *  - the readers: `arp access-list` sections and their entries, `ip arp inspection filter … [static]`, `validate`;
 *  - matching: any / host / wildcard for IPv4 and MAC, request / response, response targets;
 *  - `validate` src-mac, dst-mac, ip, in that order;
 *  - steps (3) and (4): explicit permit, explicit deny, fall-through, the `static` implicit deny;
 *  - the row counters, optional until nonzero; nothing at all without a filter or a validate line.
 */
import { describe, expect, it } from 'vitest';
import { configAstFromJson } from '../src/cli/config-ast.js';
import type { ConfigAst, ConfigNode } from '../src/contracts/config.js';
import { ARP_OP_REPLY, ARP_OP_REQUEST, ETHERTYPE_ARP } from '../src/contracts/pdu.js';
import type { ArpInspectionRow } from '../src/contracts/tables.js';
import { createPduFactory } from '../src/pdu/factory.js';
import {
  applyArpValidateAclOutcome,
  arpEthernetOf,
  arpFilterFor,
  arpValidateFailure,
  decideArpValidateAndAcl,
  invalidArpAddress,
  matchArpAcl,
  parseArpAclEntry,
  parseArpValidateLine,
  readArpAclInspection,
  readArpAcls,
  readArpInspectionFilters,
  readArpValidate,
} from '../src/protocols/l2/arp-acl.js';
import type { ArpAclInspectionConfig, ArpValidateAclCheck } from '../src/protocols/l2/arp-acl.js';
import type { ArpInspectView } from '../src/protocols/l2/arp-inspection.js';

const FA5 = 'FastEthernet0/5';
const SRV1 = '00:50:79:66:68:09';
const PC1 = '00:50:79:66:68:00';
const R1 = '02:4e:11:00:00:01';
const ZERO = '00:00:00:00:00:00';

function lineNode(text: string): ConfigNode {
  const t = text.split(' ');
  return t[0] === 'no' ? { key: 'no', args: t.slice(1), children: [] } : { key: t[0] as string, args: t.slice(1), children: [] };
}
function cfg(globals: readonly string[], acls: Readonly<Record<string, readonly string[]>> = {}): ConfigAst {
  const root: ConfigNode = { key: '', args: [], children: globals.map(lineNode) };
  for (const [name, lines] of Object.entries(acls)) root.children.push({ key: 'arp', args: ['access-list', name], children: lines.map(lineNode) });
  return configAstFromJson(root);
}
const req = (sha: string, spa: string, tpa = '192.168.10.1'): ArpInspectView => ({ op: ARP_OP_REQUEST, sha, spa, tha: ZERO, tpa });
const rep = (sha: string, spa: string, tha: string, tpa: string): ArpInspectView => ({ op: ARP_OP_REPLY, sha, spa, tha, tpa });

/** Lab 20's SW1 fix: SRV1 has a static address and no binding; an ARP ACL admits it. */
const LAB20 = (extra: readonly string[] = []): ArpAclInspectionConfig => readArpAclInspection(cfg(
  ['ip arp inspection vlan 10', 'ip arp inspection filter SRV vlan 10', ...extra],
  { SRV: ['permit ip host 192.168.10.9 mac host 0050.7966.6809', 'deny ip host 192.168.10.1 mac any log'] },
));

function check(over: Partial<ArpValidateAclCheck>): ArpValidateAclCheck {
  const arp = over.arp ?? req(SRV1, '192.168.10.9');
  return { config: LAB20(), port: FA5, vlan: 10, eth: { src: arp.sha, dst: 'ff:ff:ff:ff:ff:ff' }, arp, ...over };
}

describe('readers', () => {
  it('reads an arp access-list section with its entries in order, keeping the stored tokens', () => {
    const acls = readArpAcls(cfg([], { SRV: ['permit ip host 192.168.10.9 mac host 0050.7966.6809', 'deny request ip 192.168.20.0 0.0.0.255 mac any log'] }));
    const srv = acls.get('SRV');
    expect(srv?.entries).toHaveLength(2);
    expect(srv?.entries[0]).toMatchObject({ action: 'permit', op: 'any', senderIp: { value: 0xc0a80a09, wildcard: 0 }, log: false });
    expect(srv?.entries[0]?.senderMac).toEqual({ value: [0x00, 0x50, 0x79, 0x66, 0x68, 0x09], wildcard: [0, 0, 0, 0, 0, 0] });
    expect(srv?.entries[1]).toMatchObject({ action: 'deny', op: 'request', senderIp: { value: 0xc0a81400, wildcard: 0xff }, log: true });
    expect(srv?.entries[1]?.line).toEqual(['deny', 'request', 'ip', '192.168.20.0', '0.0.0.255', 'mac', 'any', 'log']);
    expect(readArpAcls(cfg([])).size).toBe(0);
  });
  it('entry grammar: response targets only on response; extra or bad tokens do not parse', () => {
    expect(parseArpAclEntry(['permit', 'response', 'ip', 'any', 'host', '10.0.0.1', 'mac', 'any', 'host', '0000.0000.0001'])).toMatchObject({
      op: 'response', targetIp: { value: 0x0a000001, wildcard: 0 }, targetMac: { value: [0, 0, 0, 0, 0, 1] },
    });
    expect(parseArpAclEntry(['permit', 'ip', 'any', 'host', '10.0.0.1', 'mac', 'any'])).toBeUndefined();
    expect(parseArpAclEntry(['permit', 'request', 'ip', 'any', 'mac', 'any', 'any'])).toBeUndefined();
    expect(parseArpAclEntry(['permit', 'ip', 'any', 'mac', 'any', 'log', 'x'])).toBeUndefined();
    expect(parseArpAclEntry(['permit', 'ip', 'host', '10.0.0.300', 'mac', 'any'])).toBeUndefined();
    expect(parseArpAclEntry(['permit', 'ip', 'any', 'mac', 'host', 'nonsense'])).toBeUndefined();
    expect(parseArpAclEntry(['remark', 'servers'])).toBeUndefined();
    expect(parseArpAclEntry(['permit', 'ip', 'any', 'mac', '0050.7966.6800', '0000.0000.00ff'])).toMatchObject({ senderMac: { value: [0, 0x50, 0x79, 0x66, 0x68, 0], wildcard: [0, 0, 0, 0, 0, 0xff] } });
  });
  it('filters: the last line naming a VLAN wins; static is read; a bad VLAN list is ignored', () => {
    const f = readArpInspectionFilters(cfg([
      'ip arp inspection filter A vlan 10,20',
      'ip arp inspection filter B vlan 20-30 static',
      'ip arp inspection filter C vlan banana',
      'no ip arp inspection filter D vlan 10',
    ]));
    expect(f.map((x) => [x.acl, x.static])).toEqual([['A', false], ['B', true]]);
    expect(arpFilterFor(f, 10)?.acl).toBe('A');
    expect(arpFilterFor(f, 20)?.acl).toBe('B');
    expect(arpFilterFor(f, 31)).toBeUndefined();
    expect(f[1]?.line).toEqual(['ip', 'arp', 'inspection', 'filter', 'B', 'vlan', '20-30', 'static']);
  });
  it('validate: one line whose keyword set is replaced (the last valid one); bad keywords do not parse', () => {
    expect(readArpValidate(cfg([]))).toBeUndefined();
    expect(readArpValidate(cfg(['ip arp inspection validate src-mac ip', 'ip arp inspection validate dst-mac', 'ip arp inspection validate bogus'])))
      .toEqual({ srcMac: false, dstMac: true, ip: false, line: ['ip', 'arp', 'inspection', 'validate', 'dst-mac'] });
    expect(parseArpValidateLine(['ip', 'arp', 'inspection', 'validate'])).toBeUndefined();
    expect(parseArpValidateLine(['ip', 'arp', 'inspection', 'validate', 'ip', 'src-mac', 'dst-mac'])).toMatchObject({ srcMac: true, dstMac: true, ip: true });
  });
});

describe('matching', () => {
  const acls = readArpAcls(cfg([], { L: [
    'deny response ip any host 192.168.10.50 mac any',
    'permit request ip 192.168.10.0 0.0.0.255 mac 0050.7966.6800 0000.0000.00ff',
    'permit response ip any mac host 0050.7966.6809',
  ] }));
  const L = acls.get('L');
  it('first match wins, with its index; op filters request and response; wildcards ignore set bits', () => {
    expect(matchArpAcl(L, req(PC1, '192.168.10.11'))?.index).toBe(1);
    expect(matchArpAcl(L, req(SRV1, '192.168.10.9'))?.index).toBe(1); // mac wildcard covers the last octet
    expect(matchArpAcl(L, req(R1, '192.168.10.1'))).toBeUndefined();
    expect(matchArpAcl(L, req(PC1, '192.168.11.11'))).toBeUndefined();
    expect(matchArpAcl(L, rep(SRV1, '192.168.10.9', R1, '192.168.10.1'))?.index).toBe(2);
    expect(matchArpAcl(L, rep(SRV1, '192.168.10.9', R1, '192.168.10.50'))?.index).toBe(0); // the response target
    expect(matchArpAcl(undefined, req(PC1, '192.168.10.11'))).toBeUndefined();
  });
});

describe('validate checks (order src-mac, dst-mac, ip)', () => {
  const all = parseArpValidateLine(['ip', 'arp', 'inspection', 'validate', 'src-mac', 'dst-mac', 'ip']);
  it('src-mac: Ethernet source differs from the sender MAC (requests and replies)', () => {
    expect(arpValidateFailure(all, { src: R1, dst: 'ff:ff:ff:ff:ff:ff' }, req(PC1, '192.168.10.11'))).toBe('src-mac');
    expect(arpValidateFailure(all, { src: PC1, dst: 'ff:ff:ff:ff:ff:ff' }, req(PC1, '192.168.10.11'))).toBeUndefined();
  });
  it('dst-mac: only a reply whose Ethernet destination differs from the target MAC', () => {
    expect(arpValidateFailure(all, { src: PC1, dst: SRV1 }, rep(PC1, '192.168.10.11', R1, '192.168.10.1'))).toBe('dst-mac');
    expect(arpValidateFailure(all, { src: PC1, dst: R1 }, rep(PC1, '192.168.10.11', R1, '192.168.10.1'))).toBeUndefined();
    expect(arpValidateFailure(all, { src: PC1, dst: SRV1 }, req(PC1, '192.168.10.11'))).toBeUndefined();
  });
  it('ip: sender 0.0.0.0, broadcast or multicast; the target only in replies', () => {
    expect(['0.0.0.0', '255.255.255.255', '224.0.0.5', '192.168.10.11'].map(invalidArpAddress)).toEqual([true, true, true, false]);
    expect(arpValidateFailure(all, { src: PC1, dst: 'ff:ff:ff:ff:ff:ff' }, req(PC1, '0.0.0.0'))).toBe('ip');
    expect(arpValidateFailure(all, { src: PC1, dst: 'ff:ff:ff:ff:ff:ff' }, req(PC1, '192.168.10.11', '255.255.255.255'))).toBeUndefined();
    expect(arpValidateFailure(all, { src: PC1, dst: R1 }, rep(PC1, '192.168.10.11', R1, '224.0.0.1'))).toBe('ip');
  });
  it('order: a frame failing src-mac and ip reports src-mac; a check not configured never fires', () => {
    expect(arpValidateFailure(all, { src: R1, dst: 'ff:ff:ff:ff:ff:ff' }, req(PC1, '0.0.0.0'))).toBe('src-mac');
    const ipOnly = parseArpValidateLine(['ip', 'arp', 'inspection', 'validate', 'ip']);
    expect(arpValidateFailure(ipOnly, { src: R1, dst: 'ff:ff:ff:ff:ff:ff' }, req(PC1, '0.0.0.0'))).toBe('ip');
    expect(arpValidateFailure(undefined, { src: R1, dst: SRV1 }, req(PC1, '0.0.0.0'))).toBeUndefined();
  });
  it('arpEthernetOf reads a real encoded frame', () => {
    const pdus = createPduFactory();
    const f = pdus.build([
      { proto: 'ethernet', fields: { dst: 'ff:ff:ff:ff:ff:ff', src: R1, type: ETHERTYPE_ARP } },
      { proto: 'arp', fields: { op: ARP_OP_REQUEST, sha: PC1, spa: '192.168.10.11', tha: ZERO, tpa: '192.168.10.1' } },
    ], { born: 0, origin: 'd_test' });
    expect(arpEthernetOf(f)).toEqual({ src: R1, dst: 'ff:ff:ff:ff:ff:ff' });
    expect(arpEthernetOf({ layers: [] })).toBeUndefined();
  });
});

describe('decideArpValidateAndAcl (steps 3 and 4)', () => {
  it('continue: no filter and no validate line — nothing decided, nothing written (the P3a path)', () => {
    const none = readArpAclInspection(cfg(['ip arp inspection vlan 10']));
    const o = decideArpValidateAndAcl(check({ config: none }));
    expect(o).toEqual({ kind: 'continue' });
    expect(applyArpValidateAclOutcome(undefined, 10, o, 5)).toBeUndefined();
  });
  it('permit: a static host passes by ARP ACL', () => {
    const o = decideArpValidateAndAcl(check({}));
    expect(o).toMatchObject({ kind: 'permit', acl: 'SRV' });
  });
  it('deny: an explicit deny drops with the rule pointing at the entry', () => {
    const o = decideArpValidateAndAcl(check({ arp: req(R1, '192.168.10.1') }));
    expect(o).toMatchObject({ kind: 'drop', cause: 'acl-deny', reason: 'arp-inspection' });
    if (o.kind !== 'drop') return;
    expect(o.rule).toEqual({
      kind: 'arp-inspection',
      text: 'denied by ARP access list SRV entry 2 (deny ip host 192.168.10.1 mac any log), applied to vlan 10',
      iface: FA5,
      list: 'SRV',
      config: { context: [['arp', 'access-list', 'SRV']], line: ['deny', 'ip', 'host', '192.168.10.1', 'mac', 'any', 'log'] },
    });
  });
  it('no match falls through to the bindings, unless the filter is static (implicit deny at the filter line)', () => {
    expect(decideArpValidateAndAcl(check({ arp: req(PC1, '192.168.10.11') }))).toEqual({ kind: 'continue' });
    expect(decideArpValidateAndAcl(check({ vlan: 20, arp: req(R1, '192.168.10.1') }))).toEqual({ kind: 'continue' }); // no filter for 20
    const st = readArpAclInspection(cfg(['ip arp inspection filter SRV vlan 10 static'], { SRV: ['permit ip host 192.168.10.9 mac any'] }));
    const o = decideArpValidateAndAcl(check({ config: st, arp: req(PC1, '192.168.10.11') }));
    expect(o).toMatchObject({ kind: 'drop', cause: 'acl-static' });
    expect(o.kind === 'drop' && o.rule.config).toEqual({ context: [], line: ['ip', 'arp', 'inspection', 'filter', 'SRV', 'vlan', '10', 'static'] });
    // a filter naming a list that does not exist: nothing matches
    const ghost = readArpAclInspection(cfg(['ip arp inspection filter NOPE vlan 10 static']));
    expect(decideArpValidateAndAcl(check({ config: ghost })).kind).toBe('drop');
  });
  it('validate runs before the ACL: a permitted sender with a spoofed Ethernet source drops src-mac', () => {
    const c = LAB20(['ip arp inspection validate src-mac']);
    const o = decideArpValidateAndAcl(check({ config: c, eth: { src: R1, dst: 'ff:ff:ff:ff:ff:ff' } }));
    expect(o).toMatchObject({ kind: 'drop', cause: 'src-mac' });
    if (o.kind !== 'drop') return;
    expect(o.detail).toBe(`ARP request on ${FA5} (vlan 10): sender MAC ${SRV1} differs from the Ethernet source ${R1}`);
    expect(o.rule.config).toEqual({ context: [], line: ['ip', 'arp', 'inspection', 'validate', 'src-mac'] });
  });
});

describe('applyArpValidateAclOutcome: the counters, written once nonzero', () => {
  const base: ArpInspectionRow = { key: '10', vlan: 10, forwarded: 3, dropped: 1, droppedNoBinding: 1, droppedAcl: 0, updatedAt: 0 };
  it('a permit counts forwarded and aclPermitted; a fresh row is zeroed first', () => {
    const o = decideArpValidateAndAcl(check({}));
    expect(applyArpValidateAclOutcome(base, 10, o, 7)).toEqual({ ...base, forwarded: 4, aclPermitted: 1, updatedAt: 7 });
    expect(applyArpValidateAclOutcome(undefined, 10, o, 7)).toEqual({ key: '10', vlan: 10, forwarded: 1, dropped: 0, droppedNoBinding: 0, droppedAcl: 0, aclPermitted: 1, updatedAt: 7 });
  });
  it('an ACL drop counts dropped and droppedAcl, and adds no optional column', () => {
    const o = decideArpValidateAndAcl(check({ arp: req(R1, '192.168.10.1') }));
    const r = applyArpValidateAclOutcome(base, 10, o, 7);
    expect(r).toEqual({ ...base, dropped: 2, droppedAcl: 1, updatedAt: 7 });
    expect(Object.keys(r ?? {})).not.toContain('aclPermitted');
  });
  it('each validate drop counts its own column only', () => {
    const c = LAB20(['ip arp inspection validate src-mac dst-mac ip']);
    const src = decideArpValidateAndAcl(check({ config: c, eth: { src: R1, dst: 'ff:ff:ff:ff:ff:ff' } }));
    const dst = decideArpValidateAndAcl(check({ config: c, arp: rep(SRV1, '192.168.10.9', R1, '192.168.10.1'), eth: { src: SRV1, dst: PC1 } }));
    const ip = decideArpValidateAndAcl(check({ config: c, arp: req(SRV1, '0.0.0.0') }));
    let row = applyArpValidateAclOutcome(undefined, 10, src, 1);
    expect(row).toEqual({ key: '10', vlan: 10, forwarded: 0, dropped: 1, droppedNoBinding: 0, droppedAcl: 0, droppedSrcMac: 1, updatedAt: 1 });
    row = applyArpValidateAclOutcome(row, 10, dst, 2);
    row = applyArpValidateAclOutcome(row, 10, ip, 3);
    row = applyArpValidateAclOutcome(row, 10, src, 4);
    expect(row).toEqual({ key: '10', vlan: 10, forwarded: 0, dropped: 4, droppedNoBinding: 0, droppedAcl: 0, droppedSrcMac: 2, droppedDstMac: 1, droppedIp: 1, updatedAt: 4 });
  });
});
