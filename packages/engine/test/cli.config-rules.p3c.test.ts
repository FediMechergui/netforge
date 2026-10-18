/**
 * The P3c configuration rules (ARCHITECTURE-P3C §5, D10; §7 W1b cli).
 *
 * Covers: a rule for every P3c line of §5, so W2 daemon tests store lines through `startupConfig` (parseConfigText)
 * without the grammar: the sections `ipv6 router ospf <pid>` (`config-rtr`, OSPF6_CHILD_ORDER), `ipv6 access-list`
 * (`config-ipv6-acl`, sequenced per section) and `arp access-list` (`config-arp-nacl`); the multi-instance lines
 * (`ip ospf message-digest-key <id>`, `monitor session <n>`, `snmp-server community|host`, `storm-control <class>`);
 * `secretToken` on the key lines; `bothForms` for `ip unreachables`; no rule for `config-register` (D10); a startup
 * text holding every line round-trips byte-identically; and every P3 rule lookup it could shadow is unchanged.
 */
import { describe, expect, it } from 'vitest';
import type { ConfigAst } from '../src/contracts/config.js';
import { ifaceContext } from '../src/contracts/config.js';
import {
  CONFIG_SECRET_MASK,
  DEFAULT_CONFIG_RULES,
  INTERFACE_CHILD_ORDER,
  OSPF6_CHILD_ORDER,
  isSequencedSectionContext,
  maskSecretTokens,
  ruleIdentity,
} from '../src/cli/config-rules.js';
import { createConfigAst, parseConfigText } from '../src/cli/config-ast.js';
import { contextKeyOf, modeForContext } from '../src/cli/modes.js';

const GLOBAL: string[][] = [];
const GI0 = ifaceContext('GigabitEthernet0/0');
const FA1 = ifaceContext('FastEthernet0/1');
const TU0 = ifaceContext('Tunnel0');
const VTY = [['line', 'vty', '0', '4']];
const OSPF = [['router', 'ospf', '1']];
const OSPF6 = [['ipv6', 'router', 'ospf', '1']];
const ACL6 = [['ipv6', 'access-list', 'NO-TELNET6']];
const ARPACL = [['arp', 'access-list', 'SERVERS']];
const rf = DEFAULT_CONFIG_RULES.ruleFor;
const t = (s: string): string[] => s.split(' ');

/** identity/cardinality[/section:mode][/both][/neg][/secret:N] of the rule a line gets, or 'none'. */
function shape(context: readonly (readonly string[])[], line: string): string {
  const rule = rf(context, t(line));
  if (rule === undefined) return 'none';
  const section = rule.section === undefined ? '' : `/section:${rule.section.mode}`;
  const flags = `${rule.bothForms === true ? '/both' : ''}${rule.storeNegation === true ? '/neg' : ''}`;
  const secret = rule.secretToken === undefined ? '' : `/secret:${rule.secretToken}`;
  return `${ruleIdentity(rule, t(line))}/${rule.cardinality}${section}${flags}${secret}`;
}

function body(ast: ConfigAst): string[] {
  const lines = ast.render().split('\n');
  return lines.slice(3, lines.length - 2);
}

describe('P3c sections', () => {
  it('ipv6 router ospf is a config-rtr section beside router ospf, rendered after it in OSPF6_CHILD_ORDER', () => {
    expect(shape(GLOBAL, 'ipv6 router ospf 1')).toBe('4/single/section:config-rtr');
    expect(contextKeyOf(t('ipv6 router ospf 1'))).toBe('ipv6 router ospf');
    expect(modeForContext(OSPF6)).toBe('config-rtr');
    expect(OSPF6_CHILD_ORDER).toEqual(['router-id', 'auto-cost', 'passive-interface', 'no passive-interface', 'maximum-paths']);
    expect(shape(OSPF6, 'router-id 1.1.1.1')).toBe('1/single');
    expect(shape(OSPF6, 'passive-interface default')).toBe('2/single');
    expect(shape(OSPF6, 'passive-interface GigabitEthernet0/1')).toBe('2/multi/both');
    expect(shape(OSPF6, 'auto-cost reference-bandwidth 1000')).toBe('2/single');
    expect(shape(OSPF6, 'maximum-paths 2')).toBe('1/single');

    const ast = createConfigAst();
    ast.set(GLOBAL, t('ipv6 router ospf 1'));
    for (const l of ['maximum-paths 2', 'passive-interface default', 'auto-cost reference-bandwidth 1000', 'router-id 1.1.1.1']) ast.set(OSPF6, t(l));
    ast.unset(OSPF6, t('passive-interface GigabitEthernet0/1'));
    ast.set(GLOBAL, t('router ospf 1'));
    ast.set(OSPF, t('router-id 1.1.1.1'));
    expect(body(ast)).toEqual([
      'router ospf 1',
      ' router-id 1.1.1.1',
      '!',
      'ipv6 router ospf 1',
      ' router-id 1.1.1.1',
      ' auto-cost reference-bandwidth 1000',
      ' passive-interface default',
      ' no passive-interface GigabitEthernet0/1',
      ' maximum-paths 2',
      '!',
    ]);
    expect(parseConfigText(ast.render()).render()).toBe(ast.render());
    // a second pid is another slot (the handler refuses it, ospf6OneProcess); `no ipv6 router ospf 1` removes the section
    ast.unset(GLOBAL, t('ipv6 router ospf 1'));
    expect(ast.render()).not.toContain('ipv6 router');
  });

  it('ipv6 access-list is a config-ipv6-acl section whose entries are sequenced per section', () => {
    expect(shape(GLOBAL, 'ipv6 access-list NO-TELNET6')).toBe('3/single/section:config-ipv6-acl');
    expect(modeForContext(ACL6)).toBe('config-ipv6-acl');
    expect(isSequencedSectionContext(ACL6)).toBe(true);
    expect(shape(ACL6, 'deny tcp any any eq telnet')).toBe('1/multi');
    expect(shape(ACL6, 'permit ipv6 any any')).toBe('1/multi');
    expect(rf(ACL6, t('remark keep it'))?.freeTextFrom).toBe(1);

    const ast = createConfigAst();
    ast.set(GLOBAL, t('ipv6 access-list NO-TELNET6'));
    ast.set(ACL6, t('deny tcp any any eq telnet'));
    ast.set(ACL6, t('permit ipv6 any any'));
    ast.set(ACL6, t('15 remark keep ND working'));
    const section = ast.root.children.find((c) => c.key === 'ipv6' && c.args[0] === 'access-list');
    expect(section?.children.map((c) => [c.seq, [c.key, ...c.args].join(' ')])).toEqual([
      [10, 'deny tcp any any eq telnet'],
      [15, 'remark keep ND working'],
      [20, 'permit ipv6 any any'],
    ]);
    ast.unset(ACL6, t('20'));
    expect(body(ast)).toEqual(['ipv6 access-list NO-TELNET6', ' deny tcp any any eq telnet', ' remark keep ND working', '!']);
  });

  it('arp access-list is a config-arp-nacl section of entries in typed order, after the IPv4 sections', () => {
    expect(shape(GLOBAL, 'arp access-list SERVERS')).toBe('3/single/section:config-arp-nacl');
    expect(modeForContext(ARPACL)).toBe('config-arp-nacl');
    expect(isSequencedSectionContext(ARPACL)).toBe(false);
    expect(shape(ARPACL, 'permit ip host 10.0.0.5 mac host 0000.1111.2222')).toBe('1/multi');
    expect(shape(ARPACL, 'deny ip any mac any log')).toBe('1/multi');

    const ast = createConfigAst();
    ast.set(GLOBAL, t('arp access-list SERVERS'));
    ast.set(ARPACL, t('permit ip host 10.0.0.5 mac host 0000.1111.2222'));
    ast.set(ARPACL, t('deny ip any mac any log'));
    ast.set(GLOBAL, t('ip access-list standard LAB'));
    ast.set([['ip', 'access-list', 'standard', 'LAB']], t('permit any'));
    expect(body(ast)).toEqual([
      'ip access-list standard LAB',
      ' permit any',
      '!',
      'arp access-list SERVERS',
      ' permit ip host 10.0.0.5 mac host 0000.1111.2222',
      ' deny ip any mac any log',
      '!',
    ]);
  });
});

describe('P3c lines', () => {
  it('[S5] [C7] OSPF authentication and MTU lines', () => {
    expect(shape(OSPF, 'area 0 authentication')).toBe('3/single');
    expect(shape(OSPF, 'area 0 authentication message-digest')).toBe('3/single');
    expect(shape(GI0, 'ip ospf authentication message-digest')).toBe('3/single');
    expect(shape(GI0, 'ip ospf authentication')).toBe('3/single');
    expect(shape(GI0, 'ip ospf authentication-key LabKey1')).toBe('3/single/secret:3');
    expect(shape(GI0, 'ip ospf message-digest-key 1 md5 LabKey1')).toBe('4/single/secret:5');
    expect(shape(GI0, 'ip ospf mtu-ignore')).toBe('3/single');
    expect(shape(GI0, 'ip mtu 1400')).toBe('2/single');
    // the interface OSPF slot is untouched
    expect(shape(GI0, 'ip ospf 1 area 0')).toBe('2/single');
  });

  it('[S5] message-digest keys are multi-instance by id, and the area slot holds one authentication mode', () => {
    const ast = createConfigAst();
    ast.set(GLOBAL, t('interface GigabitEthernet0/0'));
    for (const l of ['ip ospf 1 area 0', 'ip ospf authentication message-digest', 'ip ospf message-digest-key 1 md5 OldKey', 'ip ospf message-digest-key 2 md5 NewKey', 'ip ospf message-digest-key 1 md5 Again']) {
      ast.set(GI0, t(l));
    }
    expect(ast.render().split('\n').filter((l) => l.startsWith(' ip ospf'))).toEqual([
      ' ip ospf 1 area 0',
      ' ip ospf authentication message-digest',
      ' ip ospf message-digest-key 1 md5 Again',
      ' ip ospf message-digest-key 2 md5 NewKey',
    ]);
    ast.unset(GI0, t('ip ospf message-digest-key 1'));
    expect(ast.render()).not.toContain('message-digest-key 1');
    expect(ast.render()).toContain(' ip ospf message-digest-key 2 md5 NewKey');
    expect(ast.render()).toContain(' ip ospf 1 area 0');

    ast.set(GLOBAL, t('router ospf 1'));
    ast.set(OSPF, t('area 0 authentication'));
    ast.set(OSPF, t('area 0 authentication message-digest'));
    ast.set(OSPF, t('area 1 authentication'));
    expect(ast.render().split('\n').filter((l) => l.startsWith(' area'))).toEqual([' area 0 authentication message-digest', ' area 1 authentication']);
  });

  it('secretToken on the key lines', () => {
    expect(maskSecretTokens(GI0, t('ip ospf authentication-key LabKey1'))).toEqual(['ip', 'ospf', 'authentication-key', CONFIG_SECRET_MASK]);
    expect(maskSecretTokens(GI0, t('ip ospf message-digest-key 1 md5 LabKey1'))).toEqual(['ip', 'ospf', 'message-digest-key', '1', 'md5', CONFIG_SECRET_MASK]);
    expect(maskSecretTokens(GI0, t('ip ospf message-digest-key 1 md5 7 0822455D0A16'))).toEqual(['ip', 'ospf', 'message-digest-key', '1', 'md5', CONFIG_SECRET_MASK]);
    expect(maskSecretTokens(GLOBAL, t('snmp-server user ops NMS v3 auth sha AuthPass1 priv aes 128 PrivPass1'))).toEqual([
      'snmp-server', 'user', 'ops', 'NMS', 'v3', 'auth', 'sha', CONFIG_SECRET_MASK,
    ]);
    // a v3 user without keys carries no secret
    expect(maskSecretTokens(GLOBAL, t('snmp-server user ops NMS v3'))).toEqual(t('snmp-server user ops NMS v3'));
  });

  it('[S6] OSPFv3 interface lines mirror the OSPFv2 identities', () => {
    expect(shape(GI0, 'ipv6 ospf 1 area 0')).toBe('2/single');
    for (const l of ['ipv6 ospf cost 10', 'ipv6 ospf priority 0', 'ipv6 ospf hello-interval 5', 'ipv6 ospf dead-interval 20', 'ipv6 ospf network point-to-point']) {
      expect(shape(GI0, l)).toBe('3/single');
    }
    const ast = createConfigAst();
    ast.set(GLOBAL, t('interface GigabitEthernet0/0'));
    for (const l of ['ipv6 ospf 1 area 0', 'ipv6 ospf cost 10', 'ipv6 ospf 2 area 1', 'ipv6 ospf network broadcast', 'ipv6 ospf network point-to-point']) ast.set(GI0, t(l));
    expect(ast.render().split('\n').filter((l) => l.startsWith(' ipv6'))).toEqual([' ipv6 ospf 2 area 1', ' ipv6 ospf cost 10', ' ipv6 ospf network point-to-point']);
  });

  it('[S11] the IPv6 filters, [S12] ip unreachables in both forms', () => {
    expect(shape(GI0, 'ipv6 traffic-filter NO-TELNET6 in')).toBe('2/multi');
    expect(shape(VTY, 'ipv6 access-class MGMT6 in')).toBe('2/single');
    expect(shape(GI0, 'ip unreachables')).toBe('2/single/both');

    const ast = createConfigAst();
    ast.set(GLOBAL, t('interface GigabitEthernet0/0'));
    ast.set(GI0, t('ipv6 traffic-filter NO-TELNET6 in'));
    ast.set(GI0, t('ipv6 traffic-filter OUT6 out'));
    ast.unset(GI0, t('ip unreachables'));
    expect(ast.render()).toContain(' no ip unreachables');
    ast.set(GI0, t('ip unreachables'));
    expect(ast.render()).not.toContain('no ip unreachables');
    expect(ast.render()).toContain(' ip unreachables');
    ast.unset(GI0, t('ip unreachables'));
    expect(ast.render().split('\n').filter((l) => l.includes('unreachables'))).toEqual([' no ip unreachables']);
    expect(ast.render().split('\n').filter((l) => l.includes('traffic-filter'))).toEqual([' ipv6 traffic-filter NO-TELNET6 in', ' ipv6 traffic-filter OUT6 out']);
    expect(parseConfigText(ast.render()).render()).toBe(ast.render());

    ast.set(GLOBAL, t('line vty 0 4'));
    ast.set(VTY, t('ipv6 access-class MGMT6 in'));
    ast.set(VTY, t('ipv6 access-class OTHER6 in'));
    expect(ast.render().split('\n').filter((l) => l.includes('access-class'))).toEqual([' ipv6 access-class OTHER6 in']);
  });

  it('[S14] [S15] [S16] the access layer', () => {
    expect(shape(GLOBAL, 'ip arp inspection filter SERVERS vlan 10')).toBe('5/multi');
    expect(shape(GLOBAL, 'ip arp inspection validate src-mac ip')).toBe('4/single');
    expect(shape(GLOBAL, 'ip arp inspection vlan 10')).toBe('5/single');
    expect(shape(FA1, 'ip verify source')).toBe('3/single');
    expect(shape(FA1, 'ip verify source port-security')).toBe('3/single');
    expect(shape(FA1, 'storm-control broadcast level 50 30')).toBe('3/single');
    expect(shape(FA1, 'storm-control multicast level pps 100 50')).toBe('3/single');
    expect(shape(FA1, 'storm-control action shutdown')).toBe('2/multi');
    expect(shape(GLOBAL, 'errdisable recovery cause storm-control')).toBe('3/multi');

    const ast = createConfigAst();
    ast.set(GLOBAL, t('interface FastEthernet0/1'));
    for (const l of [
      'spanning-tree portfast',
      'storm-control action trap',
      'storm-control broadcast level 50 30',
      'storm-control unicast level 80',
      'storm-control broadcast level 40',
      'storm-control action shutdown',
      'switchport mode access',
      'ip verify source',
      'ip verify source port-security',
    ]) {
      ast.set(FA1, t(l));
    }
    expect(INTERFACE_CHILD_ORDER.indexOf('storm-control')).toBe(INTERFACE_CHILD_ORDER.indexOf('switchport') + 1);
    expect(body(ast)).toEqual([
      'interface FastEthernet0/1',
      ' switchport mode access',
      ' storm-control action trap',
      ' storm-control broadcast level 40',
      ' storm-control unicast level 80',
      ' storm-control action shutdown',
      ' spanning-tree portfast',
      ' ip verify source port-security',
      '!',
    ]);
    ast.unset(FA1, t('storm-control broadcast level'));
    ast.unset(FA1, t('storm-control action trap'));
    expect(ast.render().split('\n').filter((l) => l.includes('storm-control'))).toEqual([' storm-control unicast level 80', ' storm-control action shutdown']);

    ast.set(GLOBAL, t('ip arp inspection validate src-mac'));
    ast.set(GLOBAL, t('ip arp inspection validate src-mac dst-mac ip'));
    ast.set(GLOBAL, t('ip arp inspection filter SERVERS vlan 10'));
    ast.set(GLOBAL, t('ip arp inspection filter OTHER vlan 10'));
    expect(ast.render().split('\n').filter((l) => l.startsWith('ip arp'))).toEqual([
      'ip arp inspection validate src-mac dst-mac ip',
      'ip arp inspection filter SERVERS vlan 10',
      'ip arp inspection filter OTHER vlan 10',
    ]);
  });

  it('[C17] the tunnel key; [S36b] the tunnel IPv6 lines keep their rules', () => {
    expect(shape(TU0, 'tunnel key 42')).toBe('2/single');
    expect(shape(TU0, 'keepalive 10 3')).toBe('1/single/neg');
    expect(shape(TU0, 'ipv6 enable')).toBe('2/single');
    expect(shape(TU0, 'ipv6 address 2001:db8::1/64')).toBe('2/multi');
  });

  it('[S29] [S30] files and boot; [S31] config-register has no rule (D10)', () => {
    expect(shape(GLOBAL, 'tftp-server flash:nf2900-15.9.bin')).toBe('2/single');
    expect(shape(GLOBAL, 'boot system flash:nf2900-15.9.bin')).toBe('2/multi');
    expect(rf(GLOBAL, t('config-register 0x2142'))).toBeUndefined();
    // the host's `service tftp on|off` is the P0 `service <name>` slot
    expect(shape(GLOBAL, 'service tftp on')).toBe('2/single');

    const ast = createConfigAst();
    ast.set(GLOBAL, t('clock timezone UTC 0'));
    ast.set(GLOBAL, t('boot system flash:nf2900-15.9.bin'));
    ast.set(GLOBAL, t('boot system flash:nf2900-15.7.bin'));
    ast.set(GLOBAL, t('hostname R1'));
    ast.set(GLOBAL, t('tftp-server flash:a.bin'));
    ast.set(GLOBAL, t('tftp-server flash:b.bin'));
    const text = ast.render().split('\n');
    const at = text.indexOf('hostname R1');
    expect(text.slice(at, at + 4)).toEqual([
      'hostname R1',
      'boot system flash:nf2900-15.9.bin',
      'boot system flash:nf2900-15.7.bin',
      'clock timezone UTC 0',
    ]);
    expect(text.filter((l) => l.startsWith('tftp-server'))).toEqual(['tftp-server flash:a.bin', 'tftp-server flash:b.bin']);
  });

  it('[S33] [C23] SNMP: one slot per community, host, trap type, group and user', () => {
    expect(shape(GLOBAL, 'snmp-server community public ro')).toBe('3/single');
    expect(shape(GLOBAL, 'snmp-server community private rw 10')).toBe('3/single');
    expect(shape(GLOBAL, 'snmp-server host 10.0.0.9 traps version 2c public')).toBe('3/single');
    expect(shape(GLOBAL, 'snmp-server location Lab rack 3')).toBe('2/single');
    expect(rf(GLOBAL, t('snmp-server contact ops desk'))?.freeTextFrom).toBe(2);
    expect(shape(GLOBAL, 'snmp-server enable traps snmp linkdown linkup')).toBe('4/single');
    expect(shape(GLOBAL, 'snmp-server enable traps')).toBe('3/single');
    expect(shape(GLOBAL, 'snmp-server group NMS v3 priv')).toBe('3/single');
    expect(shape(GLOBAL, 'snmp-server user ops NMS v3 auth md5 AuthPass1')).toBe('3/single/secret:7');

    const ast = createConfigAst();
    for (const l of [
      'snmp-server community public ro',
      'snmp-server community private rw',
      'snmp-server community public rw 10',
      'snmp-server location Lab rack 3',
      'snmp-server host 10.0.0.9 traps version 2c public',
      'snmp-server host 10.0.0.8 traps version 2c public',
      'snmp-server enable traps snmp linkdown',
      'snmp-server enable traps snmp linkdown linkup coldstart',
    ]) {
      ast.set(GLOBAL, t(l));
    }
    expect(ast.render().split('\n').filter((l) => l.startsWith('snmp-server'))).toEqual([
      'snmp-server community public rw 10',
      'snmp-server community private rw',
      'snmp-server location Lab rack 3',
      'snmp-server host 10.0.0.9 traps version 2c public',
      'snmp-server host 10.0.0.8 traps version 2c public',
      'snmp-server enable traps snmp linkdown linkup coldstart',
    ]);
    ast.unset(GLOBAL, t('snmp-server community private'));
    ast.unset(GLOBAL, t('snmp-server host 10.0.0.9'));
    expect(ast.render().split('\n').filter((l) => l.startsWith('snmp-server community') || l.startsWith('snmp-server host'))).toEqual([
      'snmp-server community public rw 10',
      'snmp-server host 10.0.0.8 traps version 2c public',
    ]);
  });

  it('[S34] SPAN: every line of a session shares its identity; no monitor session <n> removes the session', () => {
    expect(shape(GLOBAL, 'monitor session 1 source interface GigabitEthernet0/1 both')).toBe('3/multi');
    expect(shape(GLOBAL, 'monitor session 1 source vlan 10 rx')).toBe('3/multi');
    expect(shape(GLOBAL, 'monitor session 1 destination interface GigabitEthernet0/24 encapsulation replicate')).toBe('3/multi');
    expect(shape(GLOBAL, 'monitor session 1')).toBe('3/multi');

    const ast = createConfigAst();
    for (const l of [
      'monitor session 1 source interface GigabitEthernet0/1 both',
      'monitor session 1 source interface GigabitEthernet0/2 rx',
      'monitor session 1 destination interface GigabitEthernet0/24',
      'monitor session 2 source vlan 10 rx',
      'monitor session 2 destination interface GigabitEthernet0/23',
    ]) {
      ast.set(GLOBAL, t(l));
    }
    ast.unset(GLOBAL, t('monitor session 1'));
    expect(ast.render().split('\n').filter((l) => l.startsWith('monitor'))).toEqual([
      'monitor session 2 source vlan 10 rx',
      'monitor session 2 destination interface GigabitEthernet0/23',
    ]);
  });
});

describe('startupConfig: a text holding every P3c line', () => {
  const STARTUP = [
    'hostname R1',
    'boot system flash:nf2900-15.9.bin',
    '!',
    'ip arp inspection validate src-mac ip',
    'ip arp inspection filter SERVERS vlan 10',
    '!',
    'interface GigabitEthernet0/0',
    ' ip address 10.0.12.1 255.255.255.0',
    ' ip mtu 1400',
    ' ip ospf 1 area 0',
    ' ip ospf authentication message-digest',
    ' ip ospf message-digest-key 1 md5 LabKey1',
    ' ip ospf mtu-ignore',
    ' no ip unreachables',
    ' ipv6 address 2001:db8:12::1/64',
    ' ipv6 ospf 1 area 0',
    ' ipv6 ospf cost 10',
    ' ipv6 traffic-filter NO-TELNET6 in',
    '!',
    'interface FastEthernet0/1',
    ' storm-control broadcast level 50 30',
    ' storm-control action shutdown',
    ' ip verify source port-security',
    '!',
    'router ospf 1',
    ' router-id 1.1.1.1',
    ' area 0 authentication message-digest',
    '!',
    'ipv6 router ospf 1',
    ' router-id 1.1.1.1',
    ' passive-interface default',
    ' no passive-interface GigabitEthernet0/0',
    '!',
    'ipv6 access-list NO-TELNET6',
    ' deny tcp any any eq telnet',
    ' permit ipv6 any any',
    '!',
    'arp access-list SERVERS',
    ' permit ip host 10.0.0.5 mac host 0000.1111.2222',
    '!',
    'tftp-server flash:nf2900-15.9.bin',
    'snmp-server community public ro',
    'snmp-server host 10.0.0.9 traps version 2c public',
    'snmp-server enable traps snmp linkdown linkup',
    'monitor session 1 source interface GigabitEthernet0/1 both',
    'monitor session 1 destination interface GigabitEthernet0/24',
    '!',
    'line vty 0 4',
    ' ipv6 access-class MGMT6 in',
    '!',
  ].join('\n');

  it('parses every line into its slot and renders a fixed point', () => {
    const ast = parseConfigText(STARTUP);
    const once = ast.render();
    expect(parseConfigText(once).render()).toBe(once);
    for (const line of [
      'boot system flash:nf2900-15.9.bin',
      ' ip ospf message-digest-key 1 md5 LabKey1',
      ' no ip unreachables',
      ' ipv6 ospf 1 area 0',
      ' storm-control broadcast level 50 30',
      'ipv6 router ospf 1',
      ' no passive-interface GigabitEthernet0/0',
      'ipv6 access-list NO-TELNET6',
      'arp access-list SERVERS',
      'snmp-server community public ro',
      'monitor session 1 destination interface GigabitEthernet0/24',
      ' ipv6 access-class MGMT6 in',
    ]) {
      expect(once.split('\n')).toContain(line);
    }
    const acl6 = ast.root.children.find((c) => c.key === 'ipv6' && c.args[0] === 'access-list');
    expect(acl6?.children.map((c) => c.seq)).toEqual([10, 20]);
    const ospf6 = ast.root.children.find((c) => c.key === 'ipv6' && c.args[0] === 'router');
    expect(ospf6?.children.map((c) => [c.key, ...c.args].join(' '))).toEqual(['router-id 1.1.1.1', 'passive-interface default', 'no passive-interface GigabitEthernet0/0']);
  });
});
