/**
 * The P3 config rule table and sequenced lists (ARCHITECTURE-P3 §5, D2, D12, D14, §2.11; §7 W1 cli).
 *
 * Covers: sequencing (a new entry is the highest + 10, `15 …` inserts, `no 20` removes, a taken number or a repeated
 * entry is a no-op, replay renumbers 10, 20, …); a numbered section joining the global `access-list N` lines of its
 * number; `diffTree` reproducing section numbers; the access-group and service-policy slots; `cdp run` / `cdp enable`
 * in both forms and the LLDP stored negations; `username … privilege 15 secret …` with `secretToken` 5; the OSPF
 * router section and interface lines; the `config-router` refinement to OSPF entries; the identity of every MUST line
 * of §5; and that lines without a number keep every P2 behaviour.
 */
import { describe, expect, it } from 'vitest';
import type { ConfigAst, ConfigNode } from '../src/contracts/config.js';
import { ifaceContext } from '../src/contracts/config.js';
import {
  CONFIG_SECRET_MASK,
  CONFIG_SEQ_MAX,
  DEFAULT_CONFIG_RULES,
  ROUTER_CHILD_ORDER,
  isSequencedSectionContext,
  maskSecretTokens,
  ruleIdentity,
  sequencedListOf,
} from '../src/cli/config-rules.js';
import { applyConfigChange, createConfigAst, parseConfigText } from '../src/cli/config-ast.js';
import { configTextLinesOf } from '../src/cli/config-text.js';
import { OSPF_ROUTER_KEYWORD, contextKeyOf, modeForContext, modeForContextEntry } from '../src/cli/modes.js';

const GLOBAL: string[][] = [];
const GI0 = ifaceContext('GigabitEthernet0/0');
const EXT = [['ip', 'access-list', 'extended', 'NO-WEB']];
const STD10 = [['ip', 'access-list', 'standard', '10']];
const OSPF = [['router', 'ospf', '1']];
const rf = DEFAULT_CONFIG_RULES.ruleFor;
const t = (s: string): string[] => s.split(' ');

/** Identity length and cardinality of a line under the rule table. */
function shape(context: readonly (readonly string[])[], line: string): string {
  const rule = rf(context, t(line));
  if (rule === undefined) return 'none';
  const section = rule.section === undefined ? '' : `/section:${rule.section.mode}`;
  const flags = `${rule.bothForms === true ? '/both' : ''}${rule.storeNegation === true ? '/neg' : ''}`;
  return `${ruleIdentity(rule, t(line))}/${rule.cardinality}${section}${flags}`;
}

/** `seq text` of every child of the node at `path` (a section). */
function entries(ast: ConfigAst, path: string): string[] {
  const node = ast.query(path)[0];
  return (node?.children ?? []).map((c) => `${c.seq ?? '-'} ${[c.key, ...c.args].join(' ')}`);
}

/** `seq text` of the global lines of list `n`. */
function globalEntries(ast: ConfigAst, n: string): string[] {
  return ast.root.children.filter((c) => c.key === 'access-list' && c.args[0] === n).map((c) => `${c.seq ?? '-'} ${c.args.slice(1).join(' ')}`);
}

function extended(): ConfigAst {
  const ast = createConfigAst();
  ast.set(GLOBAL, t('ip access-list extended NO-WEB'));
  ast.set(EXT, t('deny tcp host 192.168.10.10 host 192.168.20.100 eq www log'));
  ast.set(EXT, t('permit icmp 192.168.10.0 0.0.0.255 any'));
  ast.set(EXT, t('permit ip any any'));
  return ast;
}

describe('sequenced lists (D12)', () => {
  it('numbers new entries 10, 20, 30 per section and renders them without the numbers', () => {
    const ast = extended();
    expect(entries(ast, 'ip.access-list.extended.NO-WEB')).toEqual([
      '10 deny tcp host 192.168.10.10 host 192.168.20.100 eq www log',
      '20 permit icmp 192.168.10.0 0.0.0.255 any',
      '30 permit ip any any',
    ]);
    expect(ast.render()).toBe(
      [
        '! NetForge NFOS configuration',
        'version 1.0',
        '!',
        'ip access-list extended NO-WEB',
        ' deny tcp host 192.168.10.10 host 192.168.20.100 eq www log',
        ' permit icmp 192.168.10.0 0.0.0.255 any',
        ' permit ip any any',
        '!',
        'end',
        '',
      ].join('\n'),
    );
  });

  it('inserts 15 between 10 and 20, removes `no 20`, and continues from the highest number', () => {
    const ast = extended();
    const d = ast.apply(EXT, t('15 permit tcp any host 192.168.20.100 eq 443'), false);
    // the delta names the entry without its number
    expect(d).toEqual({ op: 'set', context: EXT, line: t('permit tcp any host 192.168.20.100 eq 443') });
    expect(entries(ast, 'ip.access-list.extended.NO-WEB')).toEqual([
      '10 deny tcp host 192.168.10.10 host 192.168.20.100 eq www log',
      '15 permit tcp any host 192.168.20.100 eq 443',
      '20 permit icmp 192.168.10.0 0.0.0.255 any',
      '30 permit ip any any',
    ]);
    expect(ast.apply(EXT, ['20'], true)).toEqual({
      op: 'unset',
      context: EXT,
      line: t('permit icmp 192.168.10.0 0.0.0.255 any'),
      before: t('icmp 192.168.10.0 0.0.0.255 any'),
    });
    expect(ast.unset(EXT, ['20'])).toBeUndefined();
    ast.set(EXT, t('deny udp any any'));
    expect(entries(ast, 'ip.access-list.extended.NO-WEB')).toEqual([
      '10 deny tcp host 192.168.10.10 host 192.168.20.100 eq www log',
      '15 permit tcp any host 192.168.20.100 eq 443',
      '30 permit ip any any',
      '40 deny udp any any',
    ]);
    // a lone number typed positively names nothing to store
    expect(ast.set(EXT, ['50'])).toBeUndefined();
  });

  it('refuses a taken number and a repeated entry as no-ops, and ignores numbers out of range', () => {
    const ast = extended();
    const before = JSON.stringify(ast.toJSON());
    expect(ast.apply(EXT, t('20 deny udp any any'), false)).toBeUndefined();
    expect(ast.apply(EXT, t('25 permit ip any any'), false)).toBeUndefined();
    expect(ast.set(EXT, t('permit ip any any'))).toBeUndefined();
    expect(ast.apply(EXT, t('0 deny udp any any'), false)).toBeUndefined();
    expect(ast.apply(EXT, [String(CONFIG_SEQ_MAX + 1), 'deny', 'udp', 'any', 'any'], false)).toBeUndefined();
    expect(JSON.stringify(ast.toJSON())).toBe(before);
    expect(ast.apply(EXT, [String(CONFIG_SEQ_MAX), 'deny', 'udp', 'any', 'any'], false)?.op).toBe('set');
    expect(entries(ast, 'ip.access-list.extended.NO-WEB').at(-1)).toBe(`${CONFIG_SEQ_MAX} deny udp any any`);
    // no room above the maximum: a numberless entry is a no-op
    expect(ast.set(EXT, t('deny tcp any any'))).toBeUndefined();
  });

  it('renumbers 10, 20, … on replay from text (reload, export, the lab clone)', () => {
    const ast = extended();
    ast.apply(EXT, t('5 remark web only'), false);
    ast.apply(EXT, t('25 deny udp any any eq 53'), false);
    ast.apply(EXT, ['20'], true);
    const text = ast.render();
    const replayed = parseConfigText(text);
    expect(replayed.render()).toBe(text);
    expect(entries(replayed, 'ip.access-list.extended.NO-WEB')).toEqual([
      '10 remark web only',
      '20 deny tcp host 192.168.10.10 host 192.168.20.100 eq www log',
      '30 deny udp any any eq 53',
      '40 permit ip any any',
    ]);
    // the boot replay lines carry no numbers either
    expect(configTextLinesOf(ast.root).map((l) => l.tokens.join(' '))).not.toContain('5 remark web only');
  });

  it('a pasted text with leading numbers keeps them', () => {
    const ast = parseConfigText(['ip access-list extended NO-WEB', ' 20 permit ip any any', ' 10 deny udp any any'].join('\n'));
    expect(entries(ast, 'ip.access-list.extended.NO-WEB')).toEqual(['10 deny udp any any', '20 permit ip any any']);
  });

  it('numbers global access-list lines per list number, with an explicit seq through apply', () => {
    const ast = createConfigAst();
    ast.set(GLOBAL, t('access-list 10 permit 192.168.10.0 0.0.0.255'));
    ast.set(GLOBAL, t('hostname R1'));
    ast.set(GLOBAL, t('access-list 20 deny any'));
    ast.set(GLOBAL, t('access-list 10 deny any'));
    ast.apply(GLOBAL, t('access-list 10 permit host 192.168.20.5'), false, { seq: 15 });
    expect(globalEntries(ast, '10')).toEqual(['10 permit 192.168.10.0 0.0.0.255', '15 permit host 192.168.20.5', '20 deny any']);
    expect(globalEntries(ast, '20')).toEqual(['10 deny any']);
    // placed before the next higher entry of its list; the other lists keep their positions
    expect(ast.render().split('\n').filter((l) => l.startsWith('access-list'))).toEqual([
      'access-list 10 permit 192.168.10.0 0.0.0.255',
      'access-list 20 deny any',
      'access-list 10 permit host 192.168.20.5',
      'access-list 10 deny any',
    ]);
    // a taken number is a no-op; a leading number is not a sequence number at global level
    expect(ast.apply(GLOBAL, t('access-list 10 deny host 10.0.0.1'), false, { seq: 20 })).toBeUndefined();
    expect(sequencedListOf(GLOBAL, t('access-list 10 deny any'))).toBe('10');
    expect(isSequencedSectionContext(GLOBAL)).toBe(false);
    // `no access-list 10` still removes the whole list (P2)
    ast.unset(GLOBAL, t('access-list 10'));
    expect(globalEntries(ast, '10')).toEqual([]);
    expect(globalEntries(ast, '20')).toEqual(['10 deny any']);
  });

  it('a numbered section joins the global lines of its number: one numbering, global lines first on replay', () => {
    const ast = createConfigAst();
    ast.set(GLOBAL, t('access-list 10 permit 192.168.10.0 0.0.0.255'));
    ast.set(GLOBAL, t('access-list 10 deny host 192.168.10.66'));
    ast.set(GLOBAL, t('ip access-list standard 10'));
    // P2's storage is kept: the numbered section is a section named by the number
    expect(shape(GLOBAL, 'ip access-list standard 10')).toBe('4/single/section:config-std-nacl');
    ast.set(STD10, t('permit 192.168.30.0 0.0.0.255'));
    ast.apply(STD10, t('15 permit host 192.168.20.5'), false);
    expect(globalEntries(ast, '10')).toEqual(['10 permit 192.168.10.0 0.0.0.255', '20 deny host 192.168.10.66']);
    expect(entries(ast, 'ip.access-list.standard.10')).toEqual(['15 permit host 192.168.20.5', '30 permit 192.168.30.0 0.0.0.255']);
    // a number taken by a global line is taken for the section too
    expect(ast.apply(STD10, t('20 permit any'), false)).toBeUndefined();
    // `no 20` in the section removes the global entry 20
    expect(ast.apply(STD10, ['20'], true)).toEqual({
      op: 'unset',
      context: [],
      line: t('access-list 10 deny host 192.168.10.66'),
      before: t('deny host 192.168.10.66'),
    });
    expect(globalEntries(ast, '10')).toEqual(['10 permit 192.168.10.0 0.0.0.255']);
    const replayed = parseConfigText(ast.render());
    expect(globalEntries(replayed, '10')).toEqual(['10 permit 192.168.10.0 0.0.0.255']);
    expect(entries(replayed, 'ip.access-list.standard.10')).toEqual(['20 permit host 192.168.20.5', '30 permit 192.168.30.0 0.0.0.255']);
  });

  it('diffTree reproduces the numbers of section entries', () => {
    const before = extended();
    before.apply(EXT, t('15 permit tcp any any eq 443'), false);
    const after = before.clone();
    after.apply(EXT, ['15'], true);
    after.unset(EXT, t('permit ip any any'));
    after.set(EXT, t('permit ip any any'));
    after.set(EXT, t('permit tcp any any eq 443'));
    expect(entries(after, 'ip.access-list.extended.NO-WEB')).toEqual([
      '10 deny tcp host 192.168.10.10 host 192.168.20.100 eq www log',
      '20 permit icmp 192.168.10.0 0.0.0.255 any',
      '30 permit ip any any',
      '40 permit tcp any any eq 443',
    ]);
    const changes = after.diffTree(before);
    const work = after.clone();
    for (const c of changes) applyConfigChange(work, c);
    expect(work.toJSON()).toEqual(before.toJSON());
    // every re-added entry carries its number as the leading token (only the list changed)
    expect(changes.every((c) => c.context.length === 1)).toBe(true);
    expect(changes.filter((c) => c.op === 'set').map((c) => c.line.join(' '))).toEqual([
      '15 permit tcp any any eq 443',
      '20 permit icmp 192.168.10.0 0.0.0.255 any',
      '30 permit ip any any',
    ]);
  });

  it('keeps every P2 behaviour for lines without a number', () => {
    const ast = createConfigAst();
    ast.set(GLOBAL, t('ip access-list standard LAB'));
    const lab = [['ip', 'access-list', 'standard', 'LAB']];
    expect(ast.set(lab, t('permit 10.0.0.0 0.0.0.255'))).toEqual({ op: 'set', context: lab, line: t('permit 10.0.0.0 0.0.0.255') });
    expect(ast.set(lab, t('permit 10.0.0.0 0.0.0.255'))).toBeUndefined();
    expect(ast.set(lab, t('deny any'))?.op).toBe('set');
    expect(ast.unset(lab, t('permit 10.0.0.0 0.0.0.255'))).toEqual({ op: 'unset', context: lab, line: t('permit 10.0.0.0 0.0.0.255'), before: t('10.0.0.0 0.0.0.255') });
    expect(ast.render().split('\n').slice(3, 6)).toEqual(['ip access-list standard LAB', ' deny any', '!']);
    const copy = ast.clone();
    expect(copy.toJSON()).toEqual(ast.toJSON());
    expect((copy.query('ip.access-list.standard.LAB')[0] as ConfigNode).children[0]?.seq).toBe(20);
  });

  it('remarks are free text in both storages', () => {
    const ast = createConfigAst();
    ast.set(GLOBAL, ['access-list', '10', 'remark', 'only', 'the', 'SALES', 'hosts']);
    expect(globalEntries(ast, '10')).toEqual(['10 remark only the SALES hosts']);
    expect(ast.root.children[0]?.args).toEqual(['10', 'remark', 'only the SALES hosts']);
    ast.set(GLOBAL, t('ip access-list extended NO-WEB'));
    ast.set(EXT, ['remark', 'web', 'is', 'blocked']);
    expect(entries(ast, 'ip.access-list.extended.NO-WEB')).toEqual(['10 remark web is blocked']);
  });
});

describe('the P3 slots (§5)', () => {
  it('access-group: one stored line per list and direction (the handler replaces the same direction, D12)', () => {
    const ast = createConfigAst();
    ast.set(GLOBAL, t('interface GigabitEthernet0/0'));
    expect(shape(GI0, 'ip access-group NO-WEB in')).toBe('2/multi');
    ast.set(GI0, t('ip access-group NO-WEB in'));
    ast.set(GI0, t('ip access-group 101 out'));
    ast.set(GI0, t('ip access-group NO-WEB out'));
    expect(ast.set(GI0, t('ip access-group NO-WEB in'))).toBeUndefined();
    expect(ast.query('interface.GigabitEthernet0/0.ip.access-group').map((n) => n.args.join(' '))).toEqual(['NO-WEB in', '101 out', 'NO-WEB out']);
    expect(ast.unset(GI0, t('ip access-group 101 out'))?.before).toEqual(['101', 'out']);
    expect(ast.query('interface.GigabitEthernet0/0.ip.access-group').map((n) => n.args.join(' '))).toEqual(['NO-WEB in', 'NO-WEB out']);
  });

  it('service-policy: one policy per direction', () => {
    const ast = createConfigAst();
    ast.set(GLOBAL, t('interface GigabitEthernet0/0'));
    expect(shape(GI0, 'service-policy output VOICE')).toBe('2/single');
    ast.set(GI0, t('service-policy output VOICE'));
    ast.set(GI0, t('service-policy input MARK'));
    expect(ast.set(GI0, t('service-policy output WAN'))?.before).toEqual(['VOICE']);
    expect(ast.query('interface.GigabitEthernet0/0')[0]?.children.map((c) => [c.key, ...c.args].join(' '))).toEqual([
      'service-policy output WAN',
      'service-policy input MARK',
    ]);
    expect(ast.unset(GI0, t('service-policy input'))?.before).toEqual(['MARK']);
  });

  it('cdp run and cdp enable in both forms (D2): each form typed is stored and survives replay', () => {
    expect(shape(GLOBAL, 'cdp run')).toBe('2/single/both');
    expect(shape(GI0, 'cdp enable')).toBe('2/single/both');
    const ast = createConfigAst();
    ast.set(GLOBAL, t('interface GigabitEthernet0/0'));
    expect(ast.unset(GLOBAL, t('cdp run'))?.op).toBe('unset');
    expect(ast.unset(GI0, t('cdp enable'))?.op).toBe('unset');
    expect(ast.render()).toContain('no cdp run\n');
    expect(ast.render()).toContain('interface GigabitEthernet0/0\n no cdp enable\n');
    expect(parseConfigText(ast.render()).render()).toBe(ast.render());
    // the positive forms replace the negations and are stored as typed
    expect(ast.set(GLOBAL, t('cdp run'))?.op).toBe('set');
    expect(ast.set(GI0, t('cdp enable'))?.op).toBe('set');
    const text = ast.render();
    expect(text).not.toContain('no cdp');
    expect(text).toContain('cdp run\n');
    expect(text).toContain('interface GigabitEthernet0/0\n cdp enable\n');
    expect(parseConfigText(text).render()).toBe(text);
    // the running configuration of a world that typed nothing shows no CDP line
    expect(createConfigAst().render()).not.toContain('cdp');
  });

  it('LLDP: run is ordinary, transmit and receive are stored negations', () => {
    expect(shape(GLOBAL, 'lldp run')).toBe('2/single');
    expect(shape(GI0, 'lldp transmit')).toBe('2/single/neg');
    expect(shape(GI0, 'lldp receive')).toBe('2/single/neg');
    expect(shape(GLOBAL, 'cdp advertise-v2')).toBe('2/single/neg');
    const ast = createConfigAst();
    ast.set(GLOBAL, t('interface GigabitEthernet0/0'));
    ast.unset(GI0, t('lldp transmit'));
    ast.unset(GI0, t('lldp receive'));
    expect(ast.query('interface.GigabitEthernet0/0')[0]?.children.map((c) => [c.key, ...c.args].join(' '))).toEqual(['no lldp transmit', 'no lldp receive']);
    expect(ast.set(GI0, t('lldp transmit'))?.op).toBe('set');
    expect(ast.query('interface.GigabitEthernet0/0')[0]?.children.map((c) => [c.key, ...c.args].join(' '))).toEqual(['no lldp receive']);
  });

  it('username … privilege 15 secret …: one slot per user, secret at token 5', () => {
    const line = t('username admin privilege 15 secret Lab-Pass1');
    const rule = rf(GLOBAL, line);
    expect(rule?.identity).toBe(2);
    expect(rule?.secretToken).toBe(5);
    expect(maskSecretTokens(GLOBAL, line)).toEqual(['username', 'admin', 'privilege', '15', 'secret', CONFIG_SECRET_MASK]);
    expect(rf(GLOBAL, t('username admin privilege 15 password plain'))?.secretToken).toBe(5);
    const ast = createConfigAst();
    ast.set(GLOBAL, t('username admin secret old'));
    ast.set(GLOBAL, t('username ops secret other'));
    expect(ast.set(GLOBAL, line)?.before).toEqual(['secret', 'old']);
    expect(ast.render().split('\n').filter((l) => l.startsWith('username'))).toEqual(['username admin privilege 15 secret Lab-Pass1', 'username ops secret other']);
  });
});

describe('OSPF lines (§5.1)', () => {
  it('renders the router children in ROUTER_CHILD_ORDER whatever the typing order', () => {
    expect(ROUTER_CHILD_ORDER).toEqual(['router-id', 'auto-cost', 'area', 'passive-interface', 'no passive-interface', 'network', 'default-information', 'maximum-paths']);
    const ast = createConfigAst();
    ast.set(GLOBAL, t('router ospf 1'));
    for (const l of ['maximum-paths 2', 'network 10.0.12.0 0.0.0.3 area 0', 'default-information originate', 'passive-interface GigabitEthernet0/1', 'passive-interface default', 'auto-cost reference-bandwidth 1000', 'router-id 1.1.1.1']) {
      ast.set(OSPF, t(l));
    }
    // the stored negation `passive-interface default` needs: both forms, so it replaces the positive line
    expect(ast.unset(OSPF, t('passive-interface GigabitEthernet0/1'))?.before).toEqual([]);
    expect(ast.render().split('\n').slice(3, 12)).toEqual([
      'router ospf 1',
      ' router-id 1.1.1.1',
      ' auto-cost reference-bandwidth 1000',
      ' passive-interface default',
      ' no passive-interface GigabitEthernet0/1',
      ' network 10.0.12.0 0.0.0.3 area 0',
      ' default-information originate',
      ' maximum-paths 2',
      '!',
    ]);
    expect(parseConfigText(ast.render()).render()).toBe(ast.render());
  });

  it('gives the router and interface lines their identities', () => {
    const table: [readonly (readonly string[])[], string, string][] = [
      [GLOBAL, 'router ospf 1', '2/single/section:config-router'],
      [OSPF, 'router-id 1.1.1.1', '1/single'],
      [OSPF, 'network 10.0.0.0 0.0.0.255 area 0', '3/multi'],
      [OSPF, 'network 10.0.0.0 0.0.0.255 area 0.0.0.0', '3/multi'],
      [OSPF, 'passive-interface default', '2/single'],
      [OSPF, 'passive-interface GigabitEthernet0/1', '2/multi/both'],
      [OSPF, 'auto-cost reference-bandwidth 1000', '2/single'],
      [OSPF, 'default-information originate always', '2/single'],
      [OSPF, 'maximum-paths 4', '1/single'],
      [GI0, 'ip ospf 1 area 0', '2/single'],
      [GI0, 'ip ospf cost 10', '3/single'],
      [GI0, 'ip ospf priority 0', '3/single'],
      [GI0, 'ip ospf hello-interval 5', '3/single'],
      [GI0, 'ip ospf dead-interval 20', '3/single'],
      [GI0, 'ip ospf network point-to-point', '3/single'],
      [GI0, 'bandwidth 100000', '1/single'],
    ];
    for (const [context, text, expected] of table) expect(shape(context, text), text).toBe(expected);
  });

  it('one OSPF slot per interface replaces another pid; the settings stay; network lines leave by address and wildcard', () => {
    const ast = createConfigAst();
    ast.set(GLOBAL, t('interface GigabitEthernet0/0'));
    ast.set(GI0, t('ip ospf 1 area 0'));
    ast.set(GI0, t('ip ospf cost 10'));
    expect(ast.set(GI0, t('ip ospf 2 area 0'))?.before).toEqual(['1', 'area', '0']);
    expect(ast.set(GI0, t('ip ospf cost 20'))?.before).toEqual(['10']);
    expect(ast.query('interface.GigabitEthernet0/0.ip.ospf').map((n) => n.args.join(' '))).toEqual(['2 area 0', 'cost 20']);
    ast.set(GLOBAL, t('router ospf 1'));
    ast.set(OSPF, t('network 10.0.0.0 0.0.0.255 area 0'));
    ast.set(OSPF, t('network 10.0.1.0 0.0.0.255 area 1'));
    expect(ast.unset(OSPF, t('network 10.0.0.0 0.0.0.255'))?.op).toBe('unset');
    expect(ast.query('router.ospf.1')[0]?.children.map((c) => c.args.join(' '))).toEqual(['10.0.1.0 0.0.0.255 area 1']);
  });

  it('refines config-router to OSPF entries (§2.11)', () => {
    expect(OSPF_ROUTER_KEYWORD).toBe('ospf');
    expect(modeForContext(OSPF)).toBe('config-router');
    expect(modeForContextEntry(['router', 'rip'])).toBeUndefined();
    expect(modeForContextEntry(['router', 'eigrp', '100'])).toBe('config-router-eigrp');
    expect(contextKeyOf(['router', 'eigrp', '100'])).toBe('router eigrp');
    expect(contextKeyOf(['router', 'ospf', '1'])).toBe('router');
    expect(modeForContext([['ip', 'access-list', 'extended', 'X']])).toBe('config-ext-nacl');
    expect(modeForContext([['policy-map', 'P'], ['class', 'VOICE']])).toBe('config-pmap-c');
  });
});

describe('the identity of every other MUST line of §5', () => {
  it('ACLs, device access, hardening, QoS marking, discovery, time and the device API', () => {
    const LINE = [['line', 'vty', '0', '4']];
    const CMAP = [['class-map', 'match-any', 'VOICE']];
    const PMAPC = [['policy-map', 'MARK'], ['class', 'VOICE']];
    const table: [readonly (readonly string[])[], string, string][] = [
      [GLOBAL, 'access-list 101 permit tcp any any eq www', '2/multi'],
      [GLOBAL, 'access-list 101 remark web', '2/multi'],
      [GLOBAL, 'ip access-list extended NO-WEB', '4/single/section:config-ext-nacl'],
      [EXT, 'permit tcp any any eq www', '1/multi'],
      [EXT, 'remark web', '1/multi'],
      [LINE, 'access-class 10 in', '1/single'],
      [LINE, 'transport input ssh', '2/single'],
      [LINE, 'login local', '1/single'],
      [GLOBAL, 'crypto key generate rsa modulus 2048', '4/single'],
      [GLOBAL, 'ip ssh version 2', '3/single'],
      [GLOBAL, 'ip ssh time-out 60', '3/single'],
      [GLOBAL, 'ip ssh authentication-retries 2', '3/single'],
      [GLOBAL, 'ip domain-name lab.nf', '2/single'],
      [GLOBAL, 'ip dhcp snooping', '3/single'],
      [GLOBAL, 'ip dhcp snooping vlan 10', '5/single'],
      [GLOBAL, 'ip dhcp snooping verify mac-address', '5/single/neg'],
      [GLOBAL, 'ip dhcp snooping information option', '5/single/neg'],
      [GLOBAL, 'ip source binding 00:50:79:66:68:00 vlan 10 192.168.10.11 interface FastEthernet0/1', '6/single'],
      [GLOBAL, 'ip arp inspection vlan 10', '5/single'],
      [GI0, 'ip dhcp snooping trust', '4/single'],
      [GI0, 'ip dhcp snooping limit rate 15', '5/single'],
      [GI0, 'ip arp inspection trust', '4/single'],
      [GI0, 'ip arp inspection limit rate 15 burst interval 1', '4/single'],
      [GI0, 'ip arp inspection limit none', '4/single'],
      [GLOBAL, 'class-map match-any VOICE', '2/single/section:config-cmap'],
      [CMAP, 'match dscp ef', '2/multi'],
      [GLOBAL, 'policy-map MARK', '2/single/section:config-pmap'],
      [[['policy-map', 'MARK']], 'class VOICE', '2/single/section:config-pmap-c'],
      [PMAPC, 'set dscp ef', '2/single'],
      [GLOBAL, 'cdp timer 30', '2/single'],
      [GLOBAL, 'cdp holdtime 120', '2/single'],
      [GLOBAL, 'lldp timer 30', '2/single'],
      [GLOBAL, 'lldp holdtime 120', '2/single'],
      [GLOBAL, 'lldp reinit 2', '2/single'],
      [GLOBAL, 'clock timezone CET 1', '2/single'],
      [GLOBAL, 'ntp server 10.0.0.10 prefer', '3/single'],
      [GLOBAL, 'ntp master 3', '2/single'],
      [GLOBAL, 'ntp source Loopback0', '2/single'],
      [GLOBAL, 'ip http secure-server', '3/single'],
      [GLOBAL, 'ip http authentication local', '3/single'],
      [GLOBAL, 'restconf', '1/single'],
    ];
    for (const [context, text, expected] of table) expect(shape(context, text), text).toBe(expected);
  });

  it('stores a VLAN list of snooping and inspection lines one line per VLAN, and one NTP slot per server', () => {
    const ast = createConfigAst();
    ast.set(GLOBAL, t('ip dhcp snooping vlan 10,20'));
    ast.set(GLOBAL, t('ip arp inspection vlan 10'));
    ast.set(GLOBAL, t('ntp server 10.0.0.10'));
    ast.set(GLOBAL, t('ntp server 10.0.0.11'));
    expect(ast.set(GLOBAL, t('ntp server 10.0.0.10 prefer'))).toEqual({ op: 'set', context: [], line: t('ntp server 10.0.0.10 prefer'), before: [] });
    const text = ast.render().split('\n');
    expect(text.filter((l) => l.startsWith('ip '))).toEqual(['ip dhcp snooping vlan 10', 'ip dhcp snooping vlan 20', 'ip arp inspection vlan 10']);
    expect(text.filter((l) => l.startsWith('ntp '))).toEqual(['ntp server 10.0.0.10 prefer', 'ntp server 10.0.0.11']);
  });

  it('places the QoS sections before the interfaces with the class nested under its policy', () => {
    const ast = createConfigAst();
    ast.set(GLOBAL, t('interface GigabitEthernet0/0'));
    ast.set(GI0, t('service-policy input MARK'));
    ast.set(GLOBAL, t('policy-map MARK'));
    ast.set([['policy-map', 'MARK']], t('class VOICE'));
    ast.set([['policy-map', 'MARK'], ['class', 'VOICE']], t('set dscp ef'));
    ast.set(GLOBAL, t('class-map match-any VOICE'));
    ast.set([['class-map', 'match-any', 'VOICE']], t('match protocol udp'));
    ast.set([['class-map', 'match-any', 'VOICE']], t('match dscp ef'));
    const text = ast.render();
    expect(text.split('\n').slice(3)).toEqual([
      'class-map match-any VOICE',
      ' match protocol udp',
      ' match dscp ef',
      '!',
      'policy-map MARK',
      ' class VOICE',
      '  set dscp ef',
      '!',
      'interface GigabitEthernet0/0',
      ' service-policy input MARK',
      '!',
      'end',
      '',
    ]);
    expect(parseConfigText(text).render()).toBe(text);
  });
});
