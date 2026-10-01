/**
 * The approved items' configuration rules (ARCHITECTURE-P3 §5 "The approved items' rules", §5.7, §2.16, §2.17;
 * §7 W1 cli, approved items).
 *
 * Covers: [C1] the EIGRP router section (its own slot beside `router ospf`, its child order, `delay` and the EIGRP
 * interface lines); [C13] the three crypto sections (the keyring's nested `peer` sections, the profiles) and the
 * tunnel lines; [S18] the tunnel interface; [S19] the serial PPP lines; [S20]/[S21] the queueing actions and interface
 * WFQ, with `service-policy output` (and `fair-queue`) the scheduler lines the link model must see on physical ports
 * only; [S24]/[S25] `service timestamps log` and `debug` coexisting and the `logging …` lines; [S13] `transport input`
 * and `access-class` under `line vty`.
 */
import { describe, expect, it } from 'vitest';
import type { ConfigAst } from '../src/contracts/config.js';
import { ifaceContext } from '../src/contracts/config.js';
import {
  CONFIG_SECRET_MASK,
  DEFAULT_CONFIG_RULES,
  EIGRP_CHILD_ORDER,
  SCHEDULER_PHY_LINES,
  isSchedulerPhyLine,
  maskSecretTokens,
  ruleIdentity,
} from '../src/cli/config-rules.js';
import { createConfigAst, parseConfigText } from '../src/cli/config-ast.js';
import { modeForContext } from '../src/cli/modes.js';

const GLOBAL: string[][] = [];
const GI0 = ifaceContext('GigabitEthernet0/0');
const TU0 = ifaceContext('Tunnel0');
const SE0 = ifaceContext('Serial0/0/0');
const EIGRP = [['router', 'eigrp', '100']];
const KEYRING = [['crypto', 'ikev2', 'keyring', 'KR']];
const PEER = [...KEYRING, ['peer', 'R2']];
const IKEPROF = [['crypto', 'ikev2', 'profile', 'IKE-PROF']];
const IPSECPROF = [['crypto', 'ipsec', 'profile', 'VPN']];
const PMAPC = [['policy-map', 'WAN'], ['class', 'VOICE']];
const rf = DEFAULT_CONFIG_RULES.ruleFor;
const t = (s: string): string[] => s.split(' ');

function shape(context: readonly (readonly string[])[], line: string): string {
  const rule = rf(context, t(line));
  if (rule === undefined) return 'none';
  const section = rule.section === undefined ? '' : `/section:${rule.section.mode}`;
  const flags = `${rule.bothForms === true ? '/both' : ''}${rule.storeNegation === true ? '/neg' : ''}`;
  return `${ruleIdentity(rule, t(line))}/${rule.cardinality}${section}${flags}`;
}

function body(ast: ConfigAst): string[] {
  const lines = ast.render().split('\n');
  return lines.slice(3, lines.length - 2);
}

describe('[C1] EIGRP', () => {
  it('router eigrp is its own identity-2 slot beside router ospf, and renders its children in EIGRP_CHILD_ORDER', () => {
    expect(shape(GLOBAL, 'router eigrp 100')).toBe('2/single/section:config-router-eigrp');
    expect(modeForContext(EIGRP)).toBe('config-router-eigrp');
    expect(EIGRP_CHILD_ORDER).toEqual(['eigrp', 'metric', 'network', 'passive-interface', 'no passive-interface', 'maximum-paths']);
    const ast = createConfigAst();
    ast.set(GLOBAL, t('router ospf 1'));
    ast.set([['router', 'ospf', '1']], t('network 10.0.0.0 0.0.0.255 area 0'));
    ast.set(GLOBAL, t('router eigrp 100'));
    for (const l of ['maximum-paths 2', 'passive-interface default', 'network 10.0.0.0', 'network 10.1.0.0 0.0.0.255', 'metric weights 0 1 0 1 0 0', 'eigrp router-id 1.1.1.1']) {
      ast.set(EIGRP, t(l));
    }
    ast.unset(EIGRP, t('passive-interface GigabitEthernet0/1'));
    expect(body(ast)).toEqual([
      'router ospf 1',
      ' network 10.0.0.0 0.0.0.255 area 0',
      '!',
      'router eigrp 100',
      ' eigrp router-id 1.1.1.1',
      ' metric weights 0 1 0 1 0 0',
      ' network 10.0.0.0',
      ' network 10.1.0.0 0.0.0.255',
      ' passive-interface default',
      ' no passive-interface GigabitEthernet0/1',
      ' maximum-paths 2',
      '!',
    ]);
    expect(parseConfigText(ast.render()).render()).toBe(ast.render());
    // removing the EIGRP process leaves the OSPF one
    expect(ast.unset(GLOBAL, t('router eigrp 100'))?.op).toBe('unset');
    expect(ast.query('router').map((n) => n.args.join(' '))).toEqual(['ospf 1']);
  });

  it('gives the process and interface lines their identities', () => {
    const table: [readonly (readonly string[])[], string, string][] = [
      [EIGRP, 'network 10.0.0.0', '2/multi'],
      [EIGRP, 'network 10.0.0.0 0.0.0.255', '2/multi'],
      [EIGRP, 'eigrp router-id 1.1.1.1', '2/single'],
      [EIGRP, 'passive-interface default', '2/single'],
      [EIGRP, 'passive-interface GigabitEthernet0/0', '2/multi/both'],
      [EIGRP, 'metric weights 0 1 0 1 0 0', '2/single'],
      [EIGRP, 'maximum-paths 4', '1/single'],
      [GI0, 'delay 10', '1/single'],
      [GI0, 'ip hello-interval eigrp 100 5', '4/single'],
      [GI0, 'ip hold-time eigrp 100 15', '4/single'],
    ];
    for (const [context, text, expected] of table) expect(shape(context, text), text).toBe(expected);
    const ast = createConfigAst();
    ast.set(GLOBAL, t('interface GigabitEthernet0/0'));
    ast.set(GI0, t('delay 10'));
    ast.set(GI0, t('bandwidth 1000'));
    expect(ast.set(GI0, t('delay 2000'))?.before).toEqual(['10']);
    ast.set(GI0, t('ip hello-interval eigrp 100 5'));
    expect(ast.set(GI0, t('ip hello-interval eigrp 100 10'))?.before).toEqual(['5']);
    expect(body(ast)).toEqual(['interface GigabitEthernet0/0', ' bandwidth 1000', ' delay 2000', ' ip hello-interval eigrp 100 10', '!']);
  });
});

describe('[C13] the crypto sections and [S18] the tunnel interface', () => {
  function vpn(): ConfigAst {
    const ast = createConfigAst();
    ast.set(GLOBAL, t('interface Tunnel0'));
    ast.set(TU0, t('tunnel protection ipsec profile VPN'));
    ast.set(TU0, t('tunnel mode ipsec ipv4'));
    ast.set(TU0, t('tunnel destination 209.165.200.230'));
    ast.set(TU0, t('tunnel source GigabitEthernet0/1'));
    ast.set(TU0, t('ip address 172.16.0.1 255.255.255.252'));
    ast.set(TU0, t('ip mtu 1400'));
    ast.set(TU0, t('ip tcp adjust-mss 1360'));
    ast.set(GLOBAL, t('crypto ipsec profile VPN'));
    ast.set(IPSECPROF, t('set ikev2-profile IKE-PROF'));
    ast.set(GLOBAL, t('crypto ikev2 profile IKE-PROF'));
    ast.set(IKEPROF, t('keyring local KR'));
    ast.set(IKEPROF, t('authentication remote pre-share'));
    ast.set(IKEPROF, t('authentication local pre-share'));
    ast.set(IKEPROF, t('match identity remote address 209.165.200.230 255.255.255.255'));
    ast.set(GLOBAL, t('crypto ikev2 keyring KR'));
    ast.set(KEYRING, t('peer R2'));
    ast.set(PEER, t('pre-shared-key Lab-Key-42'));
    ast.set(PEER, t('address 209.165.200.230'));
    return ast;
  }

  it('renders the keyring with its nested peer, the profiles and the tunnel in canonical order, and round-trips', () => {
    const ast = vpn();
    expect(body(ast)).toEqual([
      'crypto ikev2 keyring KR',
      ' peer R2',
      '  address 209.165.200.230',
      '  pre-shared-key Lab-Key-42',
      '!',
      'crypto ikev2 profile IKE-PROF',
      ' match identity remote address 209.165.200.230 255.255.255.255',
      ' authentication remote pre-share',
      ' authentication local pre-share',
      ' keyring local KR',
      '!',
      'crypto ipsec profile VPN',
      ' set ikev2-profile IKE-PROF',
      '!',
      'interface Tunnel0',
      ' ip address 172.16.0.1 255.255.255.252',
      ' ip mtu 1400',
      ' ip tcp adjust-mss 1360',
      ' tunnel protection ipsec profile VPN',
      ' tunnel mode ipsec ipv4',
      ' tunnel destination 209.165.200.230',
      ' tunnel source GigabitEthernet0/1',
      '!',
    ]);
    expect(parseConfigText(ast.render()).render()).toBe(ast.render());
    expect(modeForContext(PEER)).toBe('config-ikev2-keyring-peer');
    expect(modeForContext(IKEPROF)).toBe('config-ikev2-profile');
    expect(modeForContext(IPSECPROF)).toBe('config-ipsec-profile');
  });

  it('gives the crypto and tunnel lines their identities; the pre-shared key is a secret', () => {
    const table: [readonly (readonly string[])[], string, string][] = [
      [GLOBAL, 'crypto ikev2 keyring KR', '4/single/section:config-ikev2-keyring'],
      [KEYRING, 'peer R2', '2/single/section:config-ikev2-keyring-peer'],
      [PEER, 'address 209.165.200.230', '1/single'],
      [PEER, 'pre-shared-key Lab-Key-42', '1/single'],
      [GLOBAL, 'crypto ikev2 profile IKE-PROF', '4/single/section:config-ikev2-profile'],
      [IKEPROF, 'match identity remote address 209.165.200.230', '5/single'],
      [IKEPROF, 'authentication local pre-share', '2/single'],
      [IKEPROF, 'authentication remote pre-share', '2/single'],
      [IKEPROF, 'keyring local KR', '2/single'],
      [GLOBAL, 'crypto ipsec profile VPN', '4/single/section:config-ipsec-profile'],
      [IPSECPROF, 'set ikev2-profile IKE-PROF', '2/single'],
      [TU0, 'tunnel source GigabitEthernet0/1', '2/single'],
      [TU0, 'tunnel destination 203.0.113.2', '2/single'],
      [TU0, 'tunnel mode ipsec ipv4', '2/single'],
      [TU0, 'tunnel protection ipsec profile VPN', '2/single'],
      [TU0, 'ip mtu 1400', '2/single'],
      [TU0, 'ip tcp adjust-mss 1360', '3/single'],
    ];
    for (const [context, text, expected] of table) expect(shape(context, text), text).toBe(expected);
    expect(maskSecretTokens(PEER, t('pre-shared-key Lab-Key-42'))).toEqual(['pre-shared-key', CONFIG_SECRET_MASK]);
    // the tunnel mode is one slot: back to GRE replaces the IPsec mode
    const ast = vpn();
    expect(ast.set(TU0, t('tunnel mode gre ip'))?.before).toEqual(['ipsec', 'ipv4']);
    // removing the keyring removes its peers
    ast.unset(GLOBAL, t('crypto ikev2 keyring KR'));
    expect(ast.root.children.filter((c) => c.key === 'crypto').map((c) => c.args.join(' '))).toEqual(['ipsec profile VPN', 'ikev2 profile IKE-PROF']);
  });
});

describe('[S19] PPP on serial interfaces', () => {
  it('stores the authentication, the PAP credentials (secret at token 5) and the peer route negation', () => {
    expect(shape(SE0, 'encapsulation ppp')).toBe('1/single');
    expect(shape(SE0, 'ppp authentication chap pap')).toBe('2/single');
    expect(shape(SE0, 'ppp pap sent-username R1 password Pap-Pw')).toBe('3/single');
    expect(shape(SE0, 'peer neighbor-route')).toBe('2/single/neg');
    expect(shape(GLOBAL, 'username R2 password Chap-Pw')).toBe('2/single');
    expect(rf(GLOBAL, t('username R2 password Chap-Pw'))?.secretToken).toBe(3);
    expect(maskSecretTokens(SE0, t('ppp pap sent-username R1 password Pap-Pw'))).toEqual(['ppp', 'pap', 'sent-username', 'R1', 'password', CONFIG_SECRET_MASK]);
    const ast = createConfigAst();
    ast.set(GLOBAL, t('interface Serial0/0/0'));
    ast.set(SE0, t('ppp authentication chap'));
    ast.set(SE0, t('encapsulation ppp'));
    ast.unset(SE0, t('peer neighbor-route'));
    expect(ast.set(SE0, t('ppp authentication pap chap'))?.before).toEqual(['chap']);
    expect(body(ast)).toEqual(['interface Serial0/0/0', ' encapsulation ppp', ' ppp authentication pap chap', ' no peer neighbor-route', '!']);
    expect(parseConfigText(ast.render()).render()).toBe(ast.render());
  });
});

describe('[S20]/[S21] queueing', () => {
  it('orders the class actions and keeps one value per action', () => {
    const table: [readonly (readonly string[])[], string, string][] = [
      [PMAPC, 'priority 128', '1/single'],
      [PMAPC, 'priority percent 20', '1/single'],
      [PMAPC, 'bandwidth remaining percent 30', '1/single'],
      [PMAPC, 'queue-limit 64', '1/single'],
      [PMAPC, 'fair-queue', '1/single'],
      [PMAPC, 'police 64000 conform-action transmit exceed-action drop', '1/single'],
      [PMAPC, 'shape average 256000', '2/single'],
      [GI0, 'fair-queue', '1/single'],
      [SE0, 'bandwidth 1544', '1/single'],
    ];
    for (const [context, text, expected] of table) expect(shape(context, text), text).toBe(expected);
    const ast = createConfigAst();
    ast.set(GLOBAL, t('policy-map WAN'));
    ast.set([['policy-map', 'WAN']], t('class VOICE'));
    ast.set(PMAPC, t('queue-limit 64'));
    ast.set(PMAPC, t('police 64000 conform-action transmit exceed-action drop'));
    ast.set(PMAPC, t('priority 128'));
    ast.set(PMAPC, t('set dscp ef'));
    expect(ast.set(PMAPC, t('priority percent 20'))?.before).toEqual(['128']);
    expect(body(ast)).toEqual([
      'policy-map WAN',
      ' class VOICE',
      '  set dscp ef',
      '  priority percent 20',
      '  police 64000 conform-action transmit exceed-action drop',
      '  queue-limit 64',
      '!',
    ]);
  });

  it('service-policy output (and interface fair-queue) are the scheduler lines, on physical ports only', () => {
    expect(SCHEDULER_PHY_LINES).toEqual([['service-policy', 'output'], ['fair-queue']]);
    expect(isSchedulerPhyLine(t('service-policy output WAN'))).toBe(true);
    expect(isSchedulerPhyLine(t('fair-queue'))).toBe(true);
    // the input policy only marks or polices: never a PHY line
    expect(isSchedulerPhyLine(t('service-policy input MARK'))).toBe(false);
    expect(isSchedulerPhyLine(['service-policy'])).toBe(false);
    expect(isSchedulerPhyLine(t('speed 100'))).toBe(false);
  });
});

describe('[S24]/[S25] logging', () => {
  it('service timestamps log and debug are two identity-3 slots that coexist', () => {
    expect(shape(GLOBAL, 'service timestamps log datetime msec')).toBe('3/single');
    expect(shape(GLOBAL, 'service timestamps debug datetime msec')).toBe('3/single');
    expect(shape(GLOBAL, 'service password-encryption')).toBe('2/single');
    const ast = createConfigAst();
    ast.set(GLOBAL, t('service timestamps debug datetime msec'));
    ast.set(GLOBAL, t('service timestamps log datetime msec'));
    ast.set(GLOBAL, t('service password-encryption'));
    expect(ast.set(GLOBAL, t('service timestamps log uptime'))?.before).toEqual(['datetime', 'msec']);
    expect(body(ast)).toEqual(['service timestamps debug datetime msec', 'service timestamps log uptime', 'service password-encryption', '!']);
    expect(parseConfigText(ast.render()).render()).toBe(ast.render());
  });

  it('stores the logging lines: one value per setting, every host, console in both forms', () => {
    const table: [readonly (readonly string[])[], string, string][] = [
      [GLOBAL, 'logging buffered 16384 informational', '2/single'],
      [GLOBAL, 'logging console warnings', '2/single/both'],
      [GLOBAL, 'logging monitor debugging', '2/single'],
      [GLOBAL, 'logging host 10.0.0.50', '2/multi'],
      [GLOBAL, 'logging 10.0.0.51', '2/multi'],
      [GLOBAL, 'logging trap warnings', '2/single'],
      [GLOBAL, 'logging source-interface Loopback0', '2/single'],
      [GLOBAL, 'logging facility local5', '2/single'],
    ];
    for (const [context, text, expected] of table) expect(shape(context, text), text).toBe(expected);
    const ast = createConfigAst();
    ast.set(GLOBAL, t('logging buffered 8192'));
    expect(ast.set(GLOBAL, t('logging buffered 16384'))?.before).toEqual(['8192']);
    ast.set(GLOBAL, t('logging host 10.0.0.50'));
    ast.set(GLOBAL, t('logging host 10.0.0.51'));
    ast.unset(GLOBAL, t('logging console'));
    expect(ast.render().split('\n').filter((l) => l.includes('logging'))).toEqual([
      'no logging console',
      'logging buffered 16384',
      'logging host 10.0.0.50',
      'logging host 10.0.0.51',
    ]);
    expect(ast.set(GLOBAL, t('logging console'))?.op).toBe('set');
    expect(ast.render()).not.toContain('no logging console');
    expect(ast.unset(GLOBAL, t('logging host'))?.op).toBe('unset');
    expect(ast.render()).not.toContain('logging host');
  });
});

describe('[S13] vty access lines', () => {
  it('transport input is one identity-2 slot under line vty; access-class one slot', () => {
    const VTY = [['line', 'vty', '0', '4']];
    expect(shape(VTY, 'transport input ssh')).toBe('2/single');
    expect(shape(VTY, 'access-class 10 in')).toBe('1/single');
    const ast = createConfigAst();
    ast.set(GLOBAL, t('line vty 0 4'));
    ast.set(VTY, t('transport input ssh telnet'));
    ast.set(VTY, t('access-class 10 in'));
    ast.set(VTY, t('login local'));
    expect(ast.set(VTY, t('transport input ssh'))?.before).toEqual(['ssh', 'telnet']);
    expect(body(ast)).toEqual(['line vty 0 4', ' login local', ' access-class 10 in', ' transport input ssh', '!']);
  });
});
