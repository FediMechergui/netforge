// qos/config (ARCHITECTURE-P3 D16, §3.5 step 1, §3.11 step 1, §5.4; §7 W2 qos): the pure MQC reader over the W1
// config storage, the compiled policy, the [S20]/[S21] scheduler spec with its 75 % admission, interface fair-queue,
// and the configuration generation.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { ConfigAst } from '../src/contracts/config.js';
import { P2P_QUEUE_LIMIT } from '../src/contracts/link.js';
import { createConfigAst, parseConfigText } from '../src/cli/config-ast.js';
import {
  compileEgressScheduler,
  compilePortQosPolicy,
  compileQosPolicy,
  qosDscpText,
  egressSchedulerSpecOf,
  interfaceFairQueueSpec,
  isQosConfigDelta,
  nextQosGeneration,
  parseQosDscp,
  parseQosPrecedence,
  parseQosMatch,
  parseQosPolice,
  parseQosSet,
  parseQosShape,
  qosClassQueues,
  qosPoliceInScheduler,
  qosPolicyAdmission,
  qosReferenceBps,
  qosReservationsBps,
  QOS_CLASS_DEFAULT,
  QOS_INTERFACE_FAIR_QUEUE_POLICY,
  readInterfaceFairQueue,
  readQosClassMaps,
  readQosPolicyMaps,
  readServicePolicy,
} from '../src/qos/config.js';

const cfg = (lines: string[]): ConfigAst => parseConfigText(lines.join('\n'));

/** §3.5: R1's marking configuration. */
const MARK_35 = [
  'ip access-list extended VOICE-PORTS',
  ' permit udp any any range 16384 32767',
  'class-map match-all VOIP',
  ' match access-group name VOICE-PORTS',
  'policy-map MARK',
  ' class VOIP',
  '  set dscp ef',
  'interface GigabitEthernet0/0',
  ' service-policy input MARK',
];

/** §3.11: R1's LLQ configuration (with [S21] fair-queue in class-default). */
const LLQ_311 = [
  'class-map match-all VOICE',
  ' match dscp ef',
  'policy-map WAN-EDGE',
  ' class VOICE',
  '  priority 32',
  ' class class-default',
  '  fair-queue',
  'interface Serial0/0/0',
  ' bandwidth 128',
  ' service-policy output WAN-EDGE',
];

describe('qos/config: value names', () => {
  it('reads DSCP and precedence names and numbers, and shows a DSCP by its name', () => {
    expect([parseQosDscp('ef'), parseQosDscp('af41'), parseQosDscp('cs6'), parseQosDscp('default'), parseQosDscp('cs0'), parseQosDscp('63')]).toEqual([46, 34, 48, 0, 0, 63]);
    expect([parseQosDscp('64'), parseQosDscp('af44'), parseQosDscp('-1'), parseQosDscp(undefined)]).toEqual([undefined, undefined, undefined, undefined]);
    expect([parseQosPrecedence('critical'), parseQosPrecedence('flash-override'), parseQosPrecedence('7'), parseQosPrecedence('8')]).toEqual([5, 4, 7, undefined]);
    expect([qosDscpText(46), qosDscpText(10), qosDscpText(0), qosDscpText(47)]).toEqual(['ef', 'af11', 'default', '47']);
  });
});

describe('qos/config: class-maps', () => {
  it('parses every match form of §5.4 and refuses malformed ones', () => {
    expect(parseQosMatch(['dscp', 'ef', 'af41', '46'])).toEqual({ text: 'match dscp ef af41 46', kind: 'dscp', values: [46, 34] });
    expect(parseQosMatch(['ip', 'precedence', 'critical', '3'])).toEqual({ text: 'match ip precedence critical 3', kind: 'precedence', values: [5, 3] });
    expect(parseQosMatch(['cos', '5', '6'])).toEqual({ text: 'match cos 5 6', kind: 'cos', values: [5, 6] });
    expect(parseQosMatch(['access-group', 'name', 'VOICE-PORTS'])).toEqual({ text: 'match access-group name VOICE-PORTS', kind: 'access-group', list: 'VOICE-PORTS' });
    expect(parseQosMatch(['access-group', '0101'])).toEqual({ text: 'match access-group 0101', kind: 'access-group', list: '101' });
    expect(parseQosMatch(['protocol', 'udp'])).toEqual({ text: 'match protocol udp', kind: 'protocol', protocol: 'udp' });
    expect(parseQosMatch(['input-interface', 'GigabitEthernet0/1'])).toEqual({ text: 'match input-interface GigabitEthernet0/1', kind: 'input-interface', port: 'GigabitEthernet0/1' });
    expect(parseQosMatch(['any'])).toEqual({ text: 'match any', kind: 'any' });
    for (const bad of [['dscp'], ['dscp', '64'], ['dscp', '1', '2', '3', '4', '5', '6', '7', '8', '9'], ['cos', '8'], ['cos', '1', '2', '3', '4', '5'],
      ['ip', 'dscp', 'ef'], ['protocol', 'ospf'], ['access-group', 'name'], ['access-group', 'X'], ['any', 'thing'], ['vlan', '10']]) {
      expect(parseQosMatch(bad), bad.join(' ')).toBeUndefined();
    }
  });

  it('reads class-maps: match-all by default, match-any, lines in order, unparsable lines skipped, first section wins', () => {
    const ast = cfg([
      'class-map match-any VOICE',
      ' match dscp ef',
      ' match cos 5',
      ' match dscp 99',
      'class-map DATA',
      ' match protocol tcp',
      'class-map match-all EMPTY',
    ]);
    ast.set([], ['class-map', 'match-all', 'VOICE']);
    ast.set([['class-map', 'match-all', 'VOICE']], ['match', 'any']);
    const maps = readQosClassMaps(ast);
    expect([...maps.keys()]).toEqual(['VOICE', 'DATA', 'EMPTY']);
    expect(maps.get('VOICE')).toEqual({
      name: 'VOICE',
      mode: 'match-any',
      matches: [{ text: 'match dscp ef', kind: 'dscp', values: [46] }, { text: 'match cos 5', kind: 'cos', values: [5] }],
    });
    expect(maps.get('DATA')!.mode).toBe('match-all');
    expect(maps.get('EMPTY')!.matches).toEqual([]);
  });
});

describe('qos/config: policy-maps', () => {
  it('parses set, police and shape lines', () => {
    expect(parseQosSet(['dscp', 'ef'])).toEqual({ kind: 'dscp', value: 46, text: 'set dscp ef' });
    expect(parseQosSet(['ip', 'precedence', '5'])).toEqual({ kind: 'precedence', value: 5, text: 'set ip precedence 5' });
    expect(parseQosSet(['cos', '5'])).toEqual({ kind: 'cos', value: 5, text: 'set cos 5' });
    expect([parseQosSet(['cos', '8']), parseQosSet(['dscp']), parseQosSet(['qos-group', '1'])]).toEqual([undefined, undefined, undefined]);
    // conform transmits and exceed drops by default; the burst defaults to 250 ms of the rate, at least 1500 bytes
    expect(parseQosPolice(['64000', 'conform-action', 'transmit', 'exceed-action', 'drop'])).toEqual({
      rateBps: 64_000, burstBytes: 2000, conform: { kind: 'transmit' }, exceed: { kind: 'drop' }, text: 'police 64000 conform-action transmit exceed-action drop',
    });
    expect(parseQosPolice(['8000'])).toMatchObject({ rateBps: 8000, burstBytes: 1500, conform: { kind: 'transmit' }, exceed: { kind: 'drop' } });
    expect(parseQosPolice(['1000000', '4000', 'exceed-action', 'set-dscp-transmit', 'af11'])).toMatchObject({
      rateBps: 1_000_000, burstBytes: 4000, conform: { kind: 'transmit' }, exceed: { kind: 'set-dscp-transmit', dscp: 10 },
    });
    for (const bad of [['x'], ['0'], ['64000', 'exceed-action', 'shout'], ['64000', 'conform-action'], ['64000', 'exceed-action', 'drop', 'extra']]) {
      expect(parseQosPolice(bad), bad.join(' ')).toBeUndefined();
    }
    // a shaper's bucket defaults to 100 ms of its rate, in bits
    expect(parseQosShape(['average', '64000'])).toEqual({ rateBps: 64_000, bcBits: 6400, text: 'shape average 64000' });
    expect(parseQosShape(['average', '2000000', '16000'])).toEqual({ rateBps: 2_000_000, bcBits: 16_000, text: 'shape average 2000000 16000' });
    expect([parseQosShape(['peak', '64000']), parseQosShape(['average'])]).toEqual([undefined, undefined]);
  });

  it('lists the configured classes in order, then class-default (always present, always last)', () => {
    const ast = cfg([
      'policy-map P',
      ' class class-default',
      '  fair-queue',
      '  queue-limit 40',
      ' class VOICE',
      '  priority percent 25',
      '  set cos 5',
      '  set dscp ef',
      ' class DATA',
      '  bandwidth remaining percent 30',
      '  shape average 64000',
      '  police 32000',
      'policy-map BARE',
    ]);
    const maps = readQosPolicyMaps(ast);
    expect([...maps.keys()]).toEqual(['P', 'BARE']);
    const p = maps.get('P')!;
    expect(p.classes.map((c) => c.name)).toEqual(['VOICE', 'DATA', QOS_CLASS_DEFAULT]);
    // the stored child order (config-rules POLICY_CLASS_CHILD_ORDER) puts `set` first; values keep their lines
    expect(p.classes[0]).toEqual({
      name: 'VOICE',
      isDefault: false,
      sets: [{ kind: 'cos', value: 5, text: 'set cos 5' }, { kind: 'dscp', value: 46, text: 'set dscp ef' }],
      priority: { percent: 25, text: 'priority percent 25' },
    });
    expect(p.classes[1]).toMatchObject({ bandwidth: { remainingPercent: 30 }, shape: { rateBps: 64_000 }, police: { rateBps: 32_000, burstBytes: 1500 } });
    expect(p.classes[2]).toEqual({ name: QOS_CLASS_DEFAULT, isDefault: true, sets: [], queueLimit: 40, fairQueue: true });
    expect(maps.get('BARE')!.classes).toEqual([{ name: QOS_CLASS_DEFAULT, isDefault: true, sets: [] }]);
    expect(p.classes.map(qosClassQueues)).toEqual([true, true, true]);
  });
});

describe('qos/config: compiled policies (§3.5 step 1)', () => {
  it('compiles §3.5: [VOIP (acl VOICE-PORTS), class-default], actions [set dscp 46]', () => {
    const ast = cfg(MARK_35);
    expect(readServicePolicy(ast, 'GigabitEthernet0/0', 'input')).toBe('MARK');
    expect(readServicePolicy(ast, 'GigabitEthernet0/0', 'output')).toBeUndefined();
    const p = compilePortQosPolicy(ast, 'GigabitEthernet0/0', 'input')!;
    expect(p.name).toBe('MARK');
    expect(p.classes.map((c) => c.name)).toEqual(['VOIP', QOS_CLASS_DEFAULT]);
    expect(p.classes[0]!.classMap).toEqual({ name: 'VOIP', mode: 'match-all', matches: [{ text: 'match access-group name VOICE-PORTS', kind: 'access-group', list: 'VOICE-PORTS' }] });
    expect(p.classes[0]!.sets).toEqual([{ kind: 'dscp', value: 46, text: 'set dscp ef' }]);
    expect([...p.acls.keys()]).toEqual(['VOICE-PORTS']);
    expect(p.acls.get('VOICE-PORTS')!.entries.map((e) => e.text)).toEqual(['permit udp any any range 16384 32767']);
    expect([p.marks, p.polices, p.queueing]).toEqual([true, false, false]);
    expect(compilePortQosPolicy(ast, 'GigabitEthernet0/1', 'input')).toBeUndefined();
    expect(compileQosPolicy(ast, 'NOPE')).toBeUndefined();
  });

  it('a class naming a missing class-map matches nothing; an undefined list stays out of acls; resolvePort canonicalises', () => {
    const ast = cfg([
      'class-map match-any FROM-LAN',
      ' match input-interface g0/1',
      ' match access-group 150',
      'policy-map P',
      ' class GHOST',
      '  set dscp af11',
      ' class FROM-LAN',
      '  set dscp af21',
    ]);
    const p = compileQosPolicy(ast, 'P', { resolvePort: (t) => (t === 'g0/1' ? 'GigabitEthernet0/1' : undefined) })!;
    expect(p.classes[0]).toMatchObject({ name: 'GHOST', missing: true });
    expect(p.classes[0]!.classMap).toBeUndefined();
    expect(p.classes[1]!.classMap!.matches[0]).toEqual({ text: 'match input-interface g0/1', kind: 'input-interface', port: 'GigabitEthernet0/1' });
    expect(p.acls.size).toBe(0);
    // without a resolver the stored name is kept
    expect(compileQosPolicy(ast, 'P')!.classes[1]!.classMap!.matches[0]).toMatchObject({ port: 'g0/1' });
  });
});

describe('qos/config: [S20]/[S21] the scheduler spec and the 75 % admission (§3.11 step 1)', () => {
  it('§3.11: refBps 128 kb/s from `bandwidth 128`; admission 32 ≤ 96 accepted; the exact spec', () => {
    const ast = cfg(LLQ_311);
    const egress = compileEgressScheduler(ast, 'Serial0/0/0', 2_000_000);
    expect(egress?.source).toBe('policy');
    if (egress?.source !== 'policy') return;
    expect(egress.admission).toEqual({ ok: true, askedBps: 32_000, refBps: 128_000, limitBps: 96_000, askedKbps: 32, refKbps: 128 });
    expect(egress.spec).toEqual({
      policy: 'WAN-EDGE',
      refBps: 128_000,
      classes: [
        { name: 'VOICE', kind: 'priority', weightKbps: 32, queueLimit: 64, rateBps: 32_000 },
        { name: QOS_CLASS_DEFAULT, kind: 'default', weightKbps: 96, queueLimit: 64, fairQueue: true },
      ],
    });
  });

  it('refuses more than 75 % of the reference rate (exact at the boundary); remaining percent reserves nothing', () => {
    const policy = (lines: string[]) => compileQosPolicy(cfg(['policy-map P', ...lines]), 'P')!;
    expect(qosPolicyAdmission(policy([' class A', '  priority 64', ' class B', '  bandwidth 32']), 128_000)).toMatchObject({ ok: true, askedBps: 96_000 });
    const over = qosPolicyAdmission(policy([' class A', '  priority 64', ' class B', '  bandwidth 33']), 128_000);
    expect(over).toEqual({ ok: false, askedBps: 97_000, refBps: 128_000, limitBps: 96_000, askedKbps: 97, refKbps: 128 });
    // percent forms are of the reference rate: 50 % + 30 % = 80 % > 75 %
    expect(qosPolicyAdmission(policy([' class A', '  priority percent 50', ' class B', '  bandwidth percent 30']), 1_544_000)).toMatchObject({ ok: false, askedBps: 1_235_200, askedKbps: 1236, refKbps: 1544 });
    expect(qosPolicyAdmission(policy([' class A', '  priority percent 50', ' class B', '  bandwidth remaining percent 90']), 1_544_000)).toMatchObject({ ok: true, askedBps: 772_000 });
    // class-default's own bandwidth counts too
    expect(qosReservationsBps(policy([' class class-default', '  bandwidth 100']), 128_000)).toEqual([100_000]);
    expect(qosPolicyAdmission(policy([' class class-default', '  bandwidth 100']), 128_000).ok).toBe(false);
  });

  it('CBWFQ weights: bandwidth in kb/s or percent, remaining percent of what is left, an equal part for the others', () => {
    const p = compileQosPolicy(cfg([
      'policy-map CB',
      ' class VOICE',
      '  priority 200',
      ' class GOLD',
      '  bandwidth 400',
      ' class SILVER',
      '  bandwidth percent 10',
      ' class BRONZE',
      '  bandwidth remaining percent 50',
      '  queue-limit 20',
      ' class MARKED',
      '  set dscp af11',
      ' class class-default',
      '  fair-queue',
    ]), 'CB')!;
    const spec = egressSchedulerSpecOf(p, 2_000_000)!;
    // left = 2000 − 200 − 400 − 200 = 1200 kb/s; BRONZE 600; MARKED and class-default share the other 600
    expect(spec.classes).toEqual([
      { name: 'VOICE', kind: 'priority', weightKbps: 200, queueLimit: 64, rateBps: 200_000 },
      { name: 'GOLD', kind: 'bandwidth', weightKbps: 400, queueLimit: 64 },
      { name: 'SILVER', kind: 'bandwidth', weightKbps: 200, queueLimit: 64 },
      { name: 'BRONZE', kind: 'bandwidth', weightKbps: 600, queueLimit: 20 },
      { name: 'MARKED', kind: 'bandwidth', weightKbps: 300, queueLimit: 64 },
      { name: QOS_CLASS_DEFAULT, kind: 'default', weightKbps: 300, queueLimit: 64, fairQueue: true },
    ]);
    expect(spec.shapeBps).toBeUndefined();
  });

  it('[S21] police enters the spec only as transmit/drop; class-default shape shapes the port', () => {
    const p = compileQosPolicy(cfg([
      'policy-map S',
      ' class BULK',
      '  bandwidth 64',
      '  police 64000 conform-action transmit exceed-action drop',
      ' class REMARK',
      '  bandwidth 32',
      '  police 32000 conform-action transmit exceed-action set-dscp-transmit af11',
      ' class class-default',
      '  shape average 256000',
    ]), 'S')!;
    expect(qosPoliceInScheduler(p.classes[0]!.police!)).toBe(true);
    expect(qosPoliceInScheduler(p.classes[1]!.police!)).toBe(false);
    const spec = egressSchedulerSpecOf(p, 512_000)!;
    expect(spec.classes[0]!.police).toEqual({ rateBps: 64_000, burstBytes: 2000 });
    expect(spec.classes[1]!.police).toBeUndefined();
    expect([spec.shapeBps, spec.shapeBcBits]).toEqual([256_000, 25_600]);
    // a shape line in another class is not a port shaper
    const q = compileQosPolicy(cfg(['policy-map T', ' class X', '  shape average 64000']), 'T')!;
    expect(q.queueing).toBe(true);
    expect(egressSchedulerSpecOf(q, 128_000)!.shapeBps).toBeUndefined();
  });

  it('a marking-only output policy keeps the virtual FIFO; interface fair-queue gives the fair spec; the policy wins over it', () => {
    const ast = cfg([...MARK_35, 'interface Serial0/0/0', ' service-policy output MARK', ' fair-queue', 'interface Serial0/0/1', ' fair-queue']);
    expect(egressSchedulerSpecOf(compileQosPolicy(ast, 'MARK')!, 128_000)).toBeUndefined();
    expect(readInterfaceFairQueue(ast, 'Serial0/0/1')).toBe(true);
    expect(readInterfaceFairQueue(ast, 'GigabitEthernet0/0')).toBe(false);
    // no bandwidth line: the negotiated rate is the reference
    expect(qosReferenceBps(ast, 'Serial0/0/1', 64_000)).toBe(64_000);
    expect(compileEgressScheduler(ast, 'Serial0/0/1', 64_000)).toEqual({ source: 'fair-queue', spec: interfaceFairQueueSpec(64_000) });
    expect(interfaceFairQueueSpec(64_000)).toEqual({
      policy: QOS_INTERFACE_FAIR_QUEUE_POLICY,
      refBps: 64_000,
      classes: [{ name: QOS_CLASS_DEFAULT, kind: 'default', weightKbps: 64, queueLimit: P2P_QUEUE_LIMIT, fairQueue: true }],
    });
    // a marking output policy plus interface fair-queue: the fair spec
    expect(compileEgressScheduler(ast, 'Serial0/0/0', 128_000)?.source).toBe('fair-queue');
    expect(compileEgressScheduler(ast, 'GigabitEthernet0/0', 1_000_000_000)).toBeUndefined();
    const both = cfg([...LLQ_311, 'interface Serial0/0/0', ' fair-queue']);
    expect(compileEgressScheduler(both, 'Serial0/0/0', 128_000)?.source).toBe('policy');
  });
});

describe('qos/config: the configuration generation (D16)', () => {
  it('bumps on class-map, policy-map, access-list and service-policy deltas, and the [S20]/[S21] interface lines', () => {
    const ast = createConfigAst();
    const deltas = [
      ast.set([], ['class-map', 'match-all', 'VOIP']),
      ast.set([['class-map', 'match-all', 'VOIP']], ['match', 'dscp', 'ef']),
      ast.set([], ['policy-map', 'MARK']),
      ast.set([['policy-map', 'MARK']], ['class', 'VOIP']),
      ast.set([['policy-map', 'MARK'], ['class', 'VOIP']], ['set', 'dscp', 'ef']),
      ast.set([], ['access-list', '101', 'permit', 'udp', 'any', 'any']),
      ast.set([], ['ip', 'access-list', 'extended', 'VOICE-PORTS']),
      ast.set([['ip', 'access-list', 'extended', 'VOICE-PORTS']], ['permit', 'udp', 'any', 'any']),
      ast.set([], ['interface', 'GigabitEthernet0/0']),
      ast.set([['interface', 'GigabitEthernet0/0']], ['service-policy', 'input', 'MARK']),
      ast.set([['interface', 'GigabitEthernet0/0']], ['bandwidth', '128']),
      ast.set([['interface', 'GigabitEthernet0/0']], ['fair-queue']),
      ast.unset([['policy-map', 'MARK'], ['class', 'VOIP']], ['set', 'dscp']),
      ast.unset([], ['class-map', 'match-all', 'VOIP']),
    ];
    for (const d of deltas) {
      expect(d, JSON.stringify(d)).toBeDefined();
      expect(isQosConfigDelta(d!), JSON.stringify(d)).toBe(true);
    }
    const quiet = [
      ast.set([], ['hostname', 'R1']),
      ast.set([['interface', 'GigabitEthernet0/0']], ['ip', 'address', '10.0.0.1', '255.255.255.0']),
      ast.set([['interface', 'GigabitEthernet0/0']], ['ip', 'access-group', '101', 'in']),
      ast.set([], ['router', 'ospf', '1']),
      ast.set([['router', 'ospf', '1']], ['network', '10.0.0.0', '0.0.0.255', 'area', '0']),
    ];
    for (const d of quiet) {
      expect(d, JSON.stringify(d)).toBeDefined();
      expect(isQosConfigDelta(d!), JSON.stringify(d)).toBe(false);
    }
    let g = 0;
    for (const d of [...deltas, ...quiet]) g = nextQosGeneration(g, d!);
    expect(g).toBe(deltas.length);
  });
});

describe('qos/: integer discipline (§4.5)', () => {
  it('uses no floating-point maths, exponentiation, randomness or clocks', () => {
    const BANNED = /Math\.(log10|log2|log|pow|exp|random)\s*\(|Date\.now|performance\.now|new Date\(|setTimeout|[\w)\]]\s*\*\*\s*[\w(]/;
    for (const f of ['../src/qos/config.ts', '../src/qos/classify.ts', '../src/qos/mark.ts']) {
      expect(readFileSync(new URL(f, import.meta.url), 'utf8'), f).not.toMatch(BANNED);
    }
  });
});
