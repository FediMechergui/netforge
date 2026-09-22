/**
 * cli/grammar/nat.ts — the NAT command surface of a routing device (ARCHITECTURE-P2 §3.9, §5.2, §5.4, D14; §7 W3 cli):
 * `ip nat inside|outside` on an interface, `ip nat pool <name> <start> <end> netmask <m>|prefix-length <n>`,
 * `ip nat inside source list <acl> pool <name> [overload]`, `ip nat inside source list <acl> interface <if> overload`,
 * `ip nat inside source static <il> <ig>`, [S9] `ip nat inside source static tcp|udp <il> <lp> <ig>|interface <if>
 * <gp>` and `ip nat translation timeout|udp-timeout|tcp-timeout|icmp-timeout <s>`, plus `show ip nat translations
 * [verbose]`, `show ip nat statistics` and `clear ip nat translation *`. The nat daemon is the consumer of every
 * line; the CLI validates and stores. The `ip nat` debug category (§5.4) is declared here.
 *
 * Scope is the `routing` capability (the W4 catalog adds `nat` to it; `nat-gateway` implies `routing`). Help strings
 * are original wording (spec §1.6).
 */
import type { CommandSpec } from '../../contracts/cli.js';
import type { Capability } from '../../contracts/catalog.js';
import { capabilitiesRunning, choiceArg, type GrammarDebugCategory, ifaceArg, intArg, ipv4Arg, L3_PORT, maskArg, NFOS_ONLY, wordArg } from './core-exec.js';

/** Handler ids of the NAT fragment. Never rename. */
export const NAT_HANDLERS = {
  ifIpNat: 'if.ip-nat',
  configIpNatPool: 'config.ip-nat-pool',
  configIpNatSourceList: 'config.ip-nat-inside-source-list',
  configIpNatStatic: 'config.ip-nat-inside-source-static',
  configIpNatStaticPort: 'config.ip-nat-inside-source-static-port', // [S9]
  configIpNatTimeout: 'config.ip-nat-translation-timeout', // [S9]
  showIpNatTranslations: 'show.ip-nat-translations',
  showIpNatStatistics: 'show.ip-nat-statistics',
  execClearIpNat: 'exec.clear-ip-nat-translation',
} as const;

/** Capabilities that run NAT (the W4 catalog adds the daemon to `routing`; home routers reach it through `nat-gateway`). */
export const NAT_CAPABILITIES: readonly Capability[] = Object.freeze(['routing']);

/** Arg names shared by the NAT specs through `fixedArgs`. */
export const NAT_POOL_FORM_ARG = 'form'; // netmask | prefix-length
export const NAT_SOURCE_FORM_ARG = 'via'; // pool | interface
export const NAT_SHOW_VERBOSE_ARG = 'verbose';

/** `ip nat translation <which>` keywords [S9], in help order. */
export const NAT_TIMEOUT_KINDS = Object.freeze(['timeout', 'udp-timeout', 'tcp-timeout', 'icmp-timeout'] as const);
/** Bounds of a NAT translation timeout (seconds). */
export const NAT_TIMEOUT_MIN_S = 1;
export const NAT_TIMEOUT_MAX_S = 2_147_483;
/** Lowest and highest inside-global port of a static port forward [S9]. */
export const NAT_PORT_MIN = 1;
export const NAT_PORT_MAX = 65535;

/** Debug category of the nat daemon (§5.4, binding; the daemon exports the same string from protocols/nat.ts). */
const NAT_DEBUG_CATEGORY = 'ip nat';

/** The NAT debug category (offered where the daemon runs, §2.1). */
export const NAT_DEBUG_CATEGORIES: readonly GrammarDebugCategory[] = Object.freeze([
  { category: NAT_DEBUG_CATEGORY, help: 'Trace address translations as packets cross the inside and outside interfaces', requiresAny: capabilitiesRunning('nat'), since: 'P2' },
]);

/** Objectives of the NAT debug category. */
export const NAT_DEBUG_OBJECTIVES: Readonly<Record<string, readonly string[]>> = { [NAT_DEBUG_CATEGORY]: ['CCNA2.9.1'] };

const H = NAT_HANDLERS;

const GLOBAL_LINE = {
  mode: 'config',
  privilege: 15,
  allowNo: true,
  grammars: NFOS_ONLY,
  requiresAny: NAT_CAPABILITIES,
  since: 'P2',
} as const;

const SHOW_LINE = {
  mode: '@exec',
  privilege: 1,
  filterable: true,
  grammars: NFOS_ONLY,
  requiresAny: NAT_CAPABILITIES,
  since: 'P2',
} as const;

const ACL_ARG = wordArg('Standard access list: a number (1-99, 1300-1999) or a name', { maxLength: 64 });
const POOL_NAME_ARG = wordArg('Pool name', { maxLength: 32 });

/** The NAT command table. */
export const NAT_GRAMMAR: readonly CommandSpec[] = Object.freeze<CommandSpec[]>([
  {
    path: ['ip', 'nat', '<side>'],
    mode: 'config-if',
    privilege: 15,
    help: 'Which side of the translation this interface is on',
    args: { side: choiceArg('inside: the private side; outside: the public side', ['inside', 'outside']) },
    handler: H.ifIpNat,
    allowNo: true,
    noArgsOptional: true,
    grammars: NFOS_ONLY,
    requiresAny: NAT_CAPABILITIES,
    portRequires: L3_PORT,
    since: 'P2',
    objectives: ['CCNA2.9.1'],
  },
  {
    ...GLOBAL_LINE,
    path: ['ip', 'nat', 'pool', '<name>', '<start>', '<end>', 'netmask', '<mask>'],
    help: 'A range of public addresses to hand out, with its subnet mask',
    args: { name: POOL_NAME_ARG, start: ipv4Arg('First address of the range'), end: ipv4Arg('Last address of the range'), mask: maskArg('Subnet mask of the range') },
    handler: H.configIpNatPool,
    fixedArgs: { [NAT_POOL_FORM_ARG]: 'netmask' },
    objectives: ['CCNA2.9.2'],
  },
  {
    ...GLOBAL_LINE,
    path: ['ip', 'nat', 'pool', '<name>', '<start>', '<end>', 'prefix-length', '<length>'],
    help: 'A range of public addresses to hand out, with its prefix length',
    args: { name: POOL_NAME_ARG, start: ipv4Arg('First address of the range'), end: ipv4Arg('Last address of the range'), length: intArg('Prefix length', 1, 30) },
    handler: H.configIpNatPool,
    fixedArgs: { [NAT_POOL_FORM_ARG]: 'prefix-length' },
    objectives: ['CCNA2.9.2'],
  },
  {
    // the short `no ip nat pool <name>` form; typed positively it asks for the range
    ...GLOBAL_LINE,
    path: ['ip', 'nat', 'pool', '<name>'],
    help: 'Remove a pool (no ip nat pool <name>)',
    args: { name: POOL_NAME_ARG },
    handler: H.configIpNatPool,
    hidden: true,
    objectives: ['CCNA2.9.2'],
  },
  {
    // the short `no ip nat inside source list <acl>` form; typed positively it asks for the target
    ...GLOBAL_LINE,
    path: ['ip', 'nat', 'inside', 'source', 'list', '<acl>'],
    help: 'Remove a translation rule (no ip nat inside source list <acl>)',
    args: { acl: ACL_ARG },
    handler: H.configIpNatSourceList,
    hidden: true,
    objectives: ['CCNA2.9.2'],
  },
  {
    ...GLOBAL_LINE,
    path: ['ip', 'nat', 'inside', 'source', 'list', '<acl>', 'pool', '<pool>', '<overload>'],
    help: 'Translate the sources the list permits to addresses of the pool (overload: share them by port)',
    args: { acl: ACL_ARG, pool: POOL_NAME_ARG, overload: choiceArg('Share each pool address between many hosts by port', ['overload'], true) },
    handler: H.configIpNatSourceList,
    fixedArgs: { [NAT_SOURCE_FORM_ARG]: 'pool' },
    objectives: ['CCNA2.9.2'],
  },
  {
    ...GLOBAL_LINE,
    path: ['ip', 'nat', 'inside', 'source', 'list', '<acl>', 'interface', '<iface>', 'overload'],
    help: 'Translate the sources the list permits to the address of this interface, shared by port',
    args: { acl: ACL_ARG, iface: ifaceArg('The outside interface whose address is shared', { portFilter: L3_PORT }) },
    handler: H.configIpNatSourceList,
    fixedArgs: { [NAT_SOURCE_FORM_ARG]: 'interface' },
    objectives: ['CCNA2.9.3'],
  },
  {
    ...GLOBAL_LINE,
    path: ['ip', 'nat', 'inside', 'source', 'static', '<local>', '<global>'],
    help: 'Always translate one inside address to one public address, in both directions',
    args: { local: ipv4Arg('Inside local address'), global: ipv4Arg('Inside global (public) address') },
    handler: H.configIpNatStatic,
    objectives: ['CCNA2.9.1'],
  },
  // [S9] ── port forwarding ───────────────────────────────────────────────────────────────────────────────────
  {
    ...GLOBAL_LINE,
    path: ['ip', 'nat', 'inside', 'source', 'static', '<proto>', '<local>', '<lport>', '<global>', '<gport>'],
    help: 'Forward one public address and port to an inside address and port',
    args: {
      proto: choiceArg('Transport protocol', ['tcp', 'udp']),
      local: ipv4Arg('Inside local address'),
      lport: intArg('Inside local port', NAT_PORT_MIN, NAT_PORT_MAX),
      global: ipv4Arg('Inside global (public) address'),
      gport: intArg('Inside global (public) port', NAT_PORT_MIN, NAT_PORT_MAX),
    },
    handler: H.configIpNatStaticPort,
    fixedArgs: { [NAT_SOURCE_FORM_ARG]: 'address' },
    objectives: ['CCNA2.9.4'],
  },
  {
    ...GLOBAL_LINE,
    path: ['ip', 'nat', 'inside', 'source', 'static', '<proto>', '<local>', '<lport>', 'interface', '<iface>', '<gport>'],
    help: 'Forward a port of this interface\'s address to an inside address and port',
    args: {
      proto: choiceArg('Transport protocol', ['tcp', 'udp']),
      local: ipv4Arg('Inside local address'),
      lport: intArg('Inside local port', NAT_PORT_MIN, NAT_PORT_MAX),
      iface: ifaceArg('The outside interface whose address is forwarded', { portFilter: L3_PORT }),
      gport: intArg('Public port on that interface', NAT_PORT_MIN, NAT_PORT_MAX),
    },
    handler: H.configIpNatStaticPort,
    fixedArgs: { [NAT_SOURCE_FORM_ARG]: 'interface' },
    objectives: ['CCNA2.9.4'],
  },
  {
    ...GLOBAL_LINE,
    path: ['ip', 'nat', 'translation', '<which>', '<seconds>'],
    help: 'How long an idle dynamic translation lives (timeout: address-only rows; per protocol otherwise)',
    args: {
      which: choiceArg('timeout: address rows (86400 s); udp-timeout (300 s); tcp-timeout (86400 s); icmp-timeout (60 s)', NAT_TIMEOUT_KINDS),
      seconds: intArg('Seconds', NAT_TIMEOUT_MIN_S, NAT_TIMEOUT_MAX_S),
    },
    handler: H.configIpNatTimeout,
    noArgsOptional: true,
    objectives: ['CCNA2.9.3'],
  },
  // [S9] ── end ────────────────────────────────────────────────────────────────────────────────────────────────
  {
    ...SHOW_LINE,
    path: ['show', 'ip', 'nat', 'translations'],
    help: 'Every active translation: protocol, inside and outside addresses and ports',
    handler: H.showIpNatTranslations,
    objectives: ['CCNA2.9.1'],
  },
  {
    ...SHOW_LINE,
    path: ['show', 'ip', 'nat', 'translations', 'verbose'],
    help: 'Every active translation with its kind, rule and remaining lifetime',
    handler: H.showIpNatTranslations,
    fixedArgs: { [NAT_SHOW_VERBOSE_ARG]: 'verbose' },
    objectives: ['CCNA2.9.1'],
  },
  {
    ...SHOW_LINE,
    path: ['show', 'ip', 'nat', 'statistics'],
    help: 'Translation counts, the inside and outside interfaces and the configured rules',
    handler: H.showIpNatStatistics,
    objectives: ['CCNA2.9.1'],
  },
  {
    path: ['clear', 'ip', 'nat', 'translation', '<which>'],
    mode: 'priv-exec',
    privilege: 15,
    help: 'Remove every dynamic translation (static ones stay)',
    args: { which: { type: 'choice', help: 'Every dynamic translation', choices: ['*'] } },
    handler: H.execClearIpNat,
    grammars: NFOS_ONLY,
    requiresAny: NAT_CAPABILITIES,
    since: 'P2',
    objectives: ['CCNA2.9.1'],
  },
]);
