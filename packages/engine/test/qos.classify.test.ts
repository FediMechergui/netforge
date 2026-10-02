// qos/classify and qos/mark (ARCHITECTURE-P3 D16, §3.0 steps 9 and 10c, §3.5 step 3, §5.4; §7 W2 qos): the frame's
// facts, every match kind, match-all / match-any, first match wins with class-default last, the ACL read through the
// D12 matcher, and the marking plan applied with the real `Pdu.mutate` (QosMark, then the derived records).
import { describe, expect, it } from 'vitest';
import type { ConfigAst } from '../src/contracts/config.js';
import { ETHERTYPE_ARP, ETHERTYPE_IPV4, ETHERTYPE_IPV6, ETHERTYPE_VLAN, type LayerSpec, type Pdu } from '../src/contracts/pdu.js';
import { parseConfigText } from '../src/cli/config-ast.js';
import { createPduFactory } from '../src/pdu/factory.js';
import { classifyQos, qosClassMapMatches, qosMatchHits, qosPacketFacts, type QosPacketFacts } from '../src/qos/classify.js';
import { compileQosPolicy, parseQosMatch, QOS_CLASS_DEFAULT, type QosMatch, type QosPolicy } from '../src/qos/config.js';
import { planQosMarking, planQosPoliceMarkdown, qosFactsAfter, qosMarkCause } from '../src/qos/mark.js';

const cfg = (lines: string[]): ConfigAst => parseConfigText(lines.join('\n'));
const f = createPduFactory();
const meta = { born: 0, origin: 'R1' as const };
const MAC_A = '00:50:79:66:68:01';
const MAC_B = '00:50:79:66:68:02';
const eth = (type: number): LayerSpec => ({ proto: 'ethernet', fields: { dst: MAC_B, src: MAC_A, type } });
const tag = (pcp: number, type: number): LayerSpec => ({ proto: 'dot1q', fields: { pcp, vid: 10, type } });
const ip4 = (protocol: number, dscp = 0, src = '192.168.1.10'): LayerSpec => ({ proto: 'ipv4', fields: { src, dst: '192.168.2.10', protocol, ttl: 64, dscp } });
const udp = (dstPort: number): LayerSpec => ({ proto: 'udp', fields: { srcPort: 50000, dstPort } });
const data = (n: number): LayerSpec => ({ proto: 'payload', fields: { data: new Uint8Array(n) } });

/** A voice datagram (UDP 16384) and a data datagram (UDP 9) as they reach R1 Gi0/0 (§3.5). */
const voice = (dscp = 0): Pdu => f.build([eth(ETHERTYPE_IPV4), ip4(17, dscp), udp(16384), data(20)], meta);
const bulk = (dscp = 0): Pdu => f.build([eth(ETHERTYPE_IPV4), ip4(17, dscp, '192.168.1.20'), udp(9), data(960)], meta);
const tagged = (pcp: number, dscp = 0): Pdu => f.build([eth(ETHERTYPE_VLAN), tag(pcp, ETHERTYPE_IPV4), ip4(6, dscp), { proto: 'tcp', fields: { srcPort: 40000, dstPort: 80, flags: 'S' } }], meta);
const ipv6 = (trafficClass: number): Pdu =>
  f.build([eth(ETHERTYPE_IPV6), { proto: 'ipv6', fields: { src: '2001:db8::1', dst: '2001:db8::2', nextHeader: 17, hopLimit: 64, trafficClass } }, udp(5000), data(8)], meta);
const arp = (): Pdu =>
  f.build([eth(ETHERTYPE_ARP), { proto: 'arp', fields: { op: 1, sha: MAC_A, spa: '192.168.1.10', tha: '00:00:00:00:00:00', tpa: '192.168.1.1' } }], meta);

const m = (line: string): QosMatch => parseQosMatch(line.split(' ').slice(1))!;
const NO_ACLS = new Map();

/** §3.5's configuration, plus a second list for the access-group cases. */
const MARK_35 = [
  'ip access-list extended VOICE-PORTS',
  ' permit udp any any range 16384 32767',
  'access-list 101 deny udp host 192.168.1.20 any',
  'access-list 101 permit udp any any',
  'class-map match-all VOIP',
  ' match access-group name VOICE-PORTS',
  'policy-map MARK',
  ' class VOIP',
  '  set dscp ef',
  'interface GigabitEthernet0/0',
  ' service-policy input MARK',
];

describe('qos/classify: the facts of a frame', () => {
  it('reads the first IP layer’s DSCP, the 802.1Q PCP, the IPv4 tuple and the input interface', () => {
    expect(qosPacketFacts(voice(46), 'GigabitEthernet0/0')).toEqual({
      ip: { version: 4, dscp: 46 },
      tuple: { family: 4, proto: 17, src: '192.168.1.10', dst: '192.168.2.10', srcPort: 50000, dstPort: 16384 },
      inputInterface: 'GigabitEthernet0/0',
    });
    expect(qosPacketFacts(tagged(5, 26))).toMatchObject({ ip: { version: 4, dscp: 26 }, cos: 5 });
    // IPv6: DSCP = traffic class ≫ 2; no IPv4 tuple
    expect(qosPacketFacts(ipv6(0xb9))).toEqual({ ip: { version: 6, dscp: 46, trafficClass: 0xb9 } });
    expect(qosPacketFacts(arp())).toEqual({});
  });
});

describe('qos/classify: match lines', () => {
  const v4 = (dscp: number, extra: Partial<QosPacketFacts> = {}): QosPacketFacts => ({ ip: { version: 4, dscp }, ...extra });
  const v6 = (dscp: number): QosPacketFacts => ({ ip: { version: 6, dscp, trafficClass: dscp << 2 } });

  it('dscp (IPv4 and IPv6, values OR-ed), ip precedence (IPv4 only), cos (tagged only), any', () => {
    expect(qosMatchHits(m('match dscp ef af41'), v4(34), NO_ACLS)).toBe(true);
    expect(qosMatchHits(m('match dscp ef af41'), v4(48), NO_ACLS)).toBe(false);
    expect(qosMatchHits(m('match dscp ef'), v6(46), NO_ACLS)).toBe(true);
    expect(qosMatchHits(m('match dscp default'), {}, NO_ACLS)).toBe(false);
    expect(qosMatchHits(m('match ip precedence 5'), v4(46), NO_ACLS)).toBe(true);
    expect(qosMatchHits(m('match ip precedence 5'), v4(40), NO_ACLS)).toBe(true);
    expect(qosMatchHits(m('match ip precedence 5'), v4(34), NO_ACLS)).toBe(false);
    expect(qosMatchHits(m('match ip precedence 5'), v6(46), NO_ACLS)).toBe(false);
    expect(qosMatchHits(m('match cos 5'), v4(0, { cos: 5 }), NO_ACLS)).toBe(true);
    expect(qosMatchHits(m('match cos 5'), v4(0, { cos: 3 }), NO_ACLS)).toBe(false);
    expect(qosMatchHits(m('match cos 0'), v4(0), NO_ACLS)).toBe(false);
    expect(qosMatchHits(m('match any'), {}, NO_ACLS)).toBe(true);
  });

  it('protocol (IPv4), input-interface, access-group through evaluateAcl (permit only; an undefined list never)', () => {
    const facts = qosPacketFacts(voice(), 'GigabitEthernet0/0');
    expect(qosMatchHits(m('match protocol udp'), facts, NO_ACLS)).toBe(true);
    expect(qosMatchHits(m('match protocol ip'), facts, NO_ACLS)).toBe(true);
    expect(qosMatchHits(m('match protocol tcp'), facts, NO_ACLS)).toBe(false);
    expect(qosMatchHits(m('match protocol ip'), qosPacketFacts(ipv6(0)), NO_ACLS)).toBe(false);
    expect(qosMatchHits(m('match input-interface GigabitEthernet0/0'), facts, NO_ACLS)).toBe(true);
    expect(qosMatchHits(m('match input-interface GigabitEthernet0/1'), facts, NO_ACLS)).toBe(false);
    expect(qosMatchHits(m('match input-interface GigabitEthernet0/0'), qosPacketFacts(voice()), NO_ACLS)).toBe(false);
    const p = compileQosPolicy(cfg([...MARK_35, 'class-map C101', ' match access-group 101', 'policy-map Q', ' class C101', ' class VOIP']), 'Q')!;
    expect([...p.acls.keys()]).toEqual(['101', 'VOICE-PORTS']);
    expect(qosMatchHits(m('match access-group 101'), qosPacketFacts(voice()), p.acls)).toBe(true);
    // the deny entry and the implicit deny do not match
    expect(qosMatchHits(m('match access-group 101'), qosPacketFacts(bulk()), p.acls)).toBe(false);
    expect(qosMatchHits(m('match access-group 101'), qosPacketFacts(tagged(0)), p.acls)).toBe(false);
    expect(qosMatchHits(m('match access-group name VOICE-PORTS'), qosPacketFacts(voice()), p.acls)).toBe(true);
    expect(qosMatchHits(m('match access-group name VOICE-PORTS'), qosPacketFacts(bulk()), p.acls)).toBe(false);
    expect(qosMatchHits(m('match access-group name NOPE'), qosPacketFacts(voice()), p.acls)).toBe(false);
    expect(qosMatchHits(m('match access-group name VOICE-PORTS'), qosPacketFacts(ipv6(0)), p.acls)).toBe(false);
  });

  it('match-all needs every line, match-any one; a class-map without lines matches nothing', () => {
    const lines = [m('match dscp ef'), m('match protocol udp')];
    const efUdp = qosPacketFacts(voice(46));
    const efTcp = qosPacketFacts(tagged(0, 46));
    expect(qosClassMapMatches({ name: 'A', mode: 'match-all', matches: lines }, efUdp, NO_ACLS)).toBe(true);
    expect(qosClassMapMatches({ name: 'A', mode: 'match-all', matches: lines }, efTcp, NO_ACLS)).toBe(false);
    expect(qosClassMapMatches({ name: 'A', mode: 'match-any', matches: lines }, efTcp, NO_ACLS)).toBe(true);
    expect(qosClassMapMatches({ name: 'A', mode: 'match-any', matches: lines }, qosPacketFacts(tagged(0, 0)), NO_ACLS)).toBe(false);
    expect(qosClassMapMatches({ name: 'E', mode: 'match-all', matches: [] }, efUdp, NO_ACLS)).toBe(false);
    expect(qosClassMapMatches({ name: 'E', mode: 'match-any', matches: [] }, efUdp, NO_ACLS)).toBe(false);
  });
});

describe('qos/classify: the policy (§3.5 step 3)', () => {
  it('UDP 16384 → VOICE-PORTS permits → VOIP; data datagrams fall in class-default', () => {
    const p = compileQosPolicy(cfg(MARK_35), 'MARK')!;
    expect(classifyQos(p, qosPacketFacts(voice(), 'GigabitEthernet0/0'))).toEqual({ index: 0, name: 'VOIP' });
    expect(classifyQos(p, qosPacketFacts(bulk(), 'GigabitEthernet0/0'))).toEqual({ index: 1, name: QOS_CLASS_DEFAULT });
    expect(classifyQos(p, qosPacketFacts(arp()))).toEqual({ index: 1, name: QOS_CLASS_DEFAULT });
  });

  it('the first class that matches wins, in policy order; a class with a missing class-map is skipped', () => {
    const p = compileQosPolicy(cfg([
      'class-map match-any EF',
      ' match dscp ef',
      'class-map match-all UDP',
      ' match protocol udp',
      'policy-map ORDER',
      ' class GHOST',
      ' class EF',
      '  set cos 5',
      ' class UDP',
      '  set dscp af11',
    ]), 'ORDER')!;
    expect(p.classes.map((c) => c.name)).toEqual(['GHOST', 'EF', 'UDP', QOS_CLASS_DEFAULT]);
    expect(classifyQos(p, qosPacketFacts(voice(46)))).toEqual({ index: 1, name: 'EF' });
    expect(classifyQos(p, qosPacketFacts(voice(0)))).toEqual({ index: 2, name: 'UDP' });
    expect(classifyQos(p, qosPacketFacts(tagged(1, 0)))).toEqual({ index: 3, name: QOS_CLASS_DEFAULT });
  });

  it('an edit of the class-map’s ACL changes the next frame’s class once the policy is recompiled (D16)', () => {
    const ast = cfg(MARK_35);
    const before = compileQosPolicy(ast, 'MARK')!;
    expect(classifyQos(before, qosPacketFacts(bulk())).name).toBe(QOS_CLASS_DEFAULT);
    ast.set([['ip', 'access-list', 'extended', 'VOICE-PORTS']], ['permit', 'udp', 'any', 'any', 'eq', 'discard']);
    const after = compileQosPolicy(ast, 'MARK')!;
    expect(classifyQos(after, qosPacketFacts(bulk())).name).toBe('VOIP');
    // the compiled policy is a snapshot: the old one still says class-default
    expect(classifyQos(before, qosPacketFacts(bulk())).name).toBe(QOS_CLASS_DEFAULT);
  });
});

describe('qos/mark: the marking plan', () => {
  const ctx = { now: 5_000_000, device: 'R1' as const };
  const apply = (pdu: Pdu, plan: ReturnType<typeof planQosMarking>): void => {
    for (const x of plan.mutations) pdu.mutate(ctx, x.field, x.value, 'QosMark', x.cause);
  };

  it('§3.5: set dscp ef on the voice datagram → QosMark ipv4.dscp 0→46, then ChecksumRecompute and FcsRecompute', () => {
    const p = compileQosPolicy(cfg(MARK_35), 'MARK')!;
    const pdu = voice();
    const facts = qosPacketFacts(pdu, 'GigabitEthernet0/0');
    const plan = planQosMarking(p, classifyQos(p, facts).index, facts);
    expect(plan).toEqual({
      cls: 0,
      className: 'VOIP',
      marked: true,
      mutations: [{ field: 'ipv4.dscp', before: 0, value: 46, cause: 'policy-map MARK class VOIP set dscp ef' }],
    });
    apply(pdu, plan);
    expect(pdu.get('ipv4.dscp')).toBe(46);
    expect(pdu.provenance.map((x) => `${x.reason} ${x.field}`)).toEqual(['QosMark ipv4.dscp', 'ChecksumRecompute ipv4.checksum', 'FcsRecompute ethernet.fcs']);
    expect(pdu.provenance[0]).toMatchObject({ before: 0, after: 46, cause: 'policy-map MARK class VOIP set dscp ef', at: 5_000_000, device: 'R1' });
    // data datagrams fall in class-default and are not rewritten
    const d = qosPacketFacts(bulk());
    expect(planQosMarking(p, classifyQos(p, d).index, d)).toEqual({ cls: 1, className: QOS_CLASS_DEFAULT, marked: false, mutations: [] });
  });

  it('an already-marked frame counts as marked without a rewrite; the last set line on a field wins', () => {
    const p = compileQosPolicy(cfg(MARK_35), 'MARK')!;
    expect(planQosMarking(p, 0, qosPacketFacts(voice(46)))).toEqual({ cls: 0, className: 'VOIP', marked: true, mutations: [] });
    const q = compileQosPolicy(cfg(['policy-map TWO', ' class class-default', '  set dscp af41', '  set ip precedence 5']), 'TWO')!;
    expect(planQosMarking(q, 0, qosPacketFacts(voice(0))).mutations).toEqual([
      { field: 'ipv4.dscp', before: 0, value: 40, cause: qosMarkCause('TWO', QOS_CLASS_DEFAULT, 'set ip precedence 5') },
    ]);
  });

  it('set cos writes the tag’s PCP only on a tagged frame; set dscp on IPv6 keeps the ECN bits; precedence is IPv4 only', () => {
    const p = compileQosPolicy(cfg(['policy-map M', ' class class-default', '  set dscp cs3', '  set cos 5']), 'M')!;
    const t = tagged(0, 0);
    const plan = planQosMarking(p, 0, qosPacketFacts(t));
    expect(plan.mutations.map((x) => [x.field, x.before, x.value])).toEqual([['ipv4.dscp', 0, 24], ['dot1q.pcp', 0, 5]]);
    apply(t, plan);
    expect([t.get('ipv4.dscp'), t.get('dot1q.pcp')]).toEqual([24, 5]);
    expect(t.provenance.filter((x) => x.reason === 'QosMark').map((x) => x.cause)).toEqual(['policy-map M class class-default set dscp cs3', 'policy-map M class class-default set cos 5']);
    // untagged: no cos rewrite (and not marked for it)
    expect(planQosMarking(p, 0, qosPacketFacts(voice(24)))).toEqual({ cls: 0, className: QOS_CLASS_DEFAULT, marked: true, mutations: [] });
    // IPv6: traffic class = dscp ≪ 2 | ECN
    const v6 = ipv6(0x03);
    const p6 = planQosMarking(p, 0, qosPacketFacts(v6));
    expect(p6.mutations).toEqual([{ field: 'ipv6.trafficClass', before: 0x03, value: (24 << 2) | 3, cause: 'policy-map M class class-default set dscp cs3' }]);
    apply(v6, p6);
    expect(v6.get('ipv6.trafficClass')).toBe(0x63);
    const prec = compileQosPolicy(cfg(['policy-map P', ' class class-default', '  set ip precedence 5']), 'P')!;
    expect(planQosMarking(prec, 0, qosPacketFacts(ipv6(0)))).toMatchObject({ marked: false, mutations: [] });
    // a frame without IP or tag: nothing applies
    expect(planQosMarking(p, 0, qosPacketFacts(arp()))).toMatchObject({ marked: false, mutations: [] });
    expect(() => planQosMarking(p, 1, {})).toThrow(RangeError);
  });

  it('[S21] the police verdict plan: transmit, drop, or set-dscp-transmit after the marking', () => {
    const p: QosPolicy = compileQosPolicy(cfg([
      'policy-map MARK',
      ' class class-default',
      '  set dscp af21',
      '  police 64000 conform-action transmit exceed-action set-dscp-transmit af11',
      'policy-map DROP',
      ' class class-default',
      '  police 64000 conform-action transmit exceed-action drop',
    ]), 'MARK')!;
    const facts = qosPacketFacts(bulk(0));
    const marked = planQosMarking(p, 0, facts);
    const after = qosFactsAfter(facts, marked.mutations);
    expect(after.ip).toEqual({ version: 4, dscp: 18 });
    expect(planQosPoliceMarkdown(p, 0, 'conform', after)).toEqual({ transmit: true, action: { kind: 'transmit' }, mutations: [] });
    expect(planQosPoliceMarkdown(p, 0, 'exceed', after)).toEqual({
      transmit: true,
      action: { kind: 'set-dscp-transmit', dscp: 10 },
      mutations: [{ field: 'ipv4.dscp', before: 18, value: 10, cause: 'policy-map MARK class class-default police exceed-action set-dscp-transmit af11' }],
    });
    const d = compileQosPolicy(cfg(['policy-map DROP', ' class class-default', '  police 64000 conform-action transmit exceed-action drop']), 'DROP')!;
    expect(planQosPoliceMarkdown(d, 0, 'exceed', facts)).toEqual({ transmit: false, action: { kind: 'drop' }, mutations: [] });
    expect(() => planQosPoliceMarkdown(compileQosPolicy(cfg(MARK_35), 'MARK')!, 0, 'exceed', facts)).toThrow(RangeError);
  });
});
