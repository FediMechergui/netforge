/**
 * The canonical config line rule table (ARCHITECTURE-P1 §3.12, §6; contracts/config.ts `ConfigLineRule`).
 *
 * ONE declarative table decides, for every config line family:
 *  - identity (the leading tokens that name "the same setting") and cardinality (single / multi);
 *  - folding into a group node (`ip address A M` → `ip` → `address [A, M]`);
 *  - sections (mode-entering lines stored as plain full-token nodes: `interface X`, `ip dhcp pool LAN`);
 *  - stored negations (`no switchport`, `no keepalive` persist as `no …` nodes);
 *  - free-text tails (description, banner, ssid, passphrase) and secret tokens;
 *  - render placement (slot and order at top level, child order inside sections).
 *
 * Consumers: `ConfigAst` set/unset/render/parse (cli/config-ast.ts), the indentation walker and replay
 * lines (cli/config-text.ts), device boot replay, `Simulation.configure({indentation})`, secret masking.
 * GUI panels and host-shell expansions write exactly these lines.
 *
 * Lines that match no rule are plain multi-valued key lines (identity = first token) rendered in the
 * `tail` slot, exactly as unknown keys behaved in P0.
 *
 * P2 (ARCHITECTURE-P2 §5, D2; W1 cli):
 *  - the canonical lines of §5.1 (switching), §5.2 (routing and services) and §5.3 (wireless), including the approved
 *    SHOULD lines [S2] HSRP, [S4] voice VLAN, [S7] proxy ARP and [S9] NAT port forwarding and timeouts;
 *  - the corrections P2 needs first: the bare `switchport` rule names only the one-token line (a stored-negation rule
 *    whose pattern is its identity literals alone never matches a longer line), and `ip routing` is `bothForms`;
 *  - `negationRestoresDefault` on `spanning-tree mode` (used by `ConfigAst.apply` with the device's default slots);
 *  - VLAN lists: a `<vlan-list>` pattern element marks the token that is stored as one line per VLAN (`vlan 10,20`
 *    stores the sections `vlan 10` and `vlan 20`; `spanning-tree vlan 10,20 priority 4096` stores one line per VLAN);
 *    `expandVlanListLine` is the one place that splits such a line.
 *
 * Pure data and pure functions; no state, no I/O.
 */
import type { ConfigLineRule, ConfigRenderSlot, ConfigRuleSet } from '../contracts/config.js';
import { contextKeyOf } from './modes.js';

/** Context key used by rules for the global configuration level. */
export const GLOBAL_CONTEXT_KEY = '';

/** Context wildcard accepted in `ConfigLineRule.contexts`. */
export const ANY_CONTEXT_KEY = '*';

/** Replacement text for secret tokens shown below privilege 15 (original wording). */
export const CONFIG_SECRET_MASK = '<hidden>';

/**
 * Canonical order of lines inside an `interface` section; keys not listed follow in insertion order.
 * P2 inserts `spanning-tree`, `channel-group`, `no ip` (an explicit negation stored by the completeness rule, §5) and
 * `standby` [S2]; no P1 section holds those keys, so every P1 rendering keeps its order.
 */
export const INTERFACE_CHILD_ORDER: readonly string[] = [
  'description',
  'mac-address',
  'no switchport',
  'switchport',
  'spanning-tree',
  'channel-group',
  'encapsulation',
  'clock',
  'bandwidth',
  'keepalive',
  'no keepalive',
  'ip',
  'no ip',
  'ipv6',
  'standby',
  'ssid',
  'security',
  'passphrase',
  'band',
  'channel',
  'channel-width',
  'tx-power',
  'peer-key',
  'beacons',
  'shutdown',
  'duplex',
  'speed',
];

/** Canonical order of lines inside an `ip dhcp pool` section. */
export const DHCP_POOL_CHILD_ORDER: readonly string[] = ['network', 'default-router', 'dns-server', 'domain-name', 'lease'];

/** Canonical order of lines inside a `line` section. */
export const LINE_CHILD_ORDER: readonly string[] = ['password', 'login', 'exec-timeout'];

/** @since P2 Canonical order of lines inside a `vlan <v>` section (mode `config-vlan`). */
export const VLAN_CHILD_ORDER: readonly string[] = ['name'];

/** @since P2 Canonical order of lines inside an `ipv6 dhcp pool` section (mode `config-dhcpv6`). */
export const DHCPV6_POOL_CHILD_ORDER: readonly string[] = ['address', 'dns-server', 'domain-name'];

/** @since P2 Canonical order of lines inside a `wlc-interface` section (mode `config-wlc-if`). */
export const WLC_INTERFACE_CHILD_ORDER: readonly string[] = ['vlan', 'address', 'gateway', 'dhcp-server'];

/** @since P2 Canonical order of lines inside a `wlan` section (mode `config-wlan`). */
export const WLAN_CHILD_ORDER: readonly string[] = ['security', 'passphrase', 'interface', 'radio', 'shutdown'];

/**
 * @since P2 Pattern element naming a VLAN list (`10,20,30-35`, 1-4094). A line of a rule carrying it is stored as one
 * line per VLAN (`expandVlanListLine`); a section rule carrying it stores one section per VLAN and applies the lines
 * typed inside it to each of them (§5).
 */
export const VLAN_LIST_ELEMENT = '<vlan-list>';

/** @since P2 Lowest and highest VLAN id a stored VLAN list may name (802.1Q; 0 and 4095 are reserved). */
export const CONFIG_VLAN_MIN = 1;
export const CONFIG_VLAN_MAX = 4094;

/**
 * Render placement of the P2 switching and access-point globals (§5.1, §5.3): they share the `dhcp` slot, ahead of the
 * DHCP lines (orders 0 and 1), so a switch renders its `spanning-tree …` lines, then one block per `vlan` section,
 * before its interfaces (the order a learner sees on a real switch). No P1 line sits in these positions.
 */
const EARLY_GLOBAL = { renderSlot: 'dhcp', order: -2 } as const;
const EARLY_SECTION = { renderSlot: 'dhcp', order: -1 } as const;

const G = [GLOBAL_CONTEXT_KEY] as const;
const IF = ['interface'] as const;
const POOL = ['ip dhcp pool'] as const;
const LINE = ['line'] as const;
const ANY = [ANY_CONTEXT_KEY] as const;
const VLAN = ['vlan'] as const;
const POOL6 = ['ipv6 dhcp pool'] as const;
const NACL = ['ip access-list standard'] as const;
const WLAN = ['wlan'] as const;
const WLC_IF = ['wlc-interface'] as const;

/** Build one rule from a space-separated pattern. */
function rule(
  pattern: string,
  contexts: readonly string[],
  identity: number,
  cardinality: 'single' | 'multi',
  extra: Partial<Omit<ConfigLineRule, 'pattern' | 'contexts' | 'identity' | 'cardinality'>> = {},
): ConfigLineRule {
  return Object.freeze({ pattern: Object.freeze(pattern.split(' ')), contexts, identity, cardinality, ...extra });
}

/**
 * The built-in rule table (P0 lines, the P0.5 lines of §6 and the P1 lines of §6).
 * Table order breaks ties between equally specific rules.
 */
export const CONFIG_LINE_RULES: readonly ConfigLineRule[] = Object.freeze([
  // ── global identity lines ──
  rule('hostname <name>', G, 1, 'single', { renderSlot: 'hostname' }),
  rule('service <name>', G, 2, 'single', { renderSlot: 'service' }),
  rule('enable secret <rest>', G, 2, 'single', { renderSlot: 'enable', secretToken: 2 }),
  rule('enable password <rest>', G, 2, 'single', { renderSlot: 'enable', secretToken: 2 }),
  rule('username <name> secret <rest>', G, 2, 'single', { renderSlot: 'username', secretToken: 3 }),
  rule('username <name> password <rest>', G, 2, 'single', { renderSlot: 'username', secretToken: 3 }),
  rule('banner <type> <rest>', G, 2, 'single', { renderSlot: 'banner', freeTextFrom: 2 }),
  rule('no <rest>', ANY, 1, 'multi', { renderSlot: 'global-no' }),

  // ── sections ──
  rule('interface <name>', G, 2, 'single', {
    section: { mode: 'config-if', separator: true, childOrder: INTERFACE_CHILD_ORDER },
    impliedDefault: { line: ['shutdown'], negated: true },
    renderSlot: 'interface',
  }),
  rule('router <protocol> <rest>', G, 2, 'single', {
    section: { mode: 'config-router', separator: true },
    renderSlot: 'router',
  }),
  rule('line <type> <first> <last>', G, 3, 'single', {
    section: { mode: 'config-line', separator: true, childOrder: LINE_CHILD_ORDER },
    renderSlot: 'line',
  }),
  rule('ip dhcp pool <name>', G, 4, 'single', {
    section: { mode: 'dhcp-config', separator: true, childOrder: DHCP_POOL_CHILD_ORDER },
    renderSlot: 'dhcp',
    order: 1,
  }),

  // ── global ip / ipv6 lines ──
  rule('ip dhcp excluded-address <low> <high>', G, 3, 'multi', { group: 'ip', renderSlot: 'dhcp', order: 0 }),
  rule('ip route <rest>', G, 2, 'multi', { group: 'ip', renderSlot: 'ip-post' }),
  rule('ip default-gateway <gateway>', G, 2, 'single', { group: 'ip', renderSlot: 'ip-post' }),
  rule('ip forward-protocol <rest>', G, 2, 'multi', { group: 'ip', renderSlot: 'ip-post' }),
  rule('ip http server', G, 3, 'single', { group: 'ip', renderSlot: 'ip-post' }),
  rule('ip http page <path> <rest>', G, 4, 'single', { group: 'ip', renderSlot: 'ip-post', freeTextFrom: 4 }),
  rule('ip http <setting> <rest>', G, 3, 'multi', { group: 'ip', renderSlot: 'ip-post' }),
  // P2 (§5.2, D2): `ip routing` and `no ip routing` share one slot and each is stored as typed.
  rule('ip routing', G, 2, 'single', { group: 'ip', renderSlot: 'ip-pre', bothForms: true }),
  rule('ip domain-lookup', G, 2, 'single', { group: 'ip', renderSlot: 'ip-pre' }),
  rule('ip domain-name <name>', G, 2, 'single', { group: 'ip', renderSlot: 'ip-pre' }),
  rule('ip name-server <rest>', G, 2, 'multi', { group: 'ip', renderSlot: 'ip-pre' }),
  rule('ip host <name> <rest>', G, 3, 'single', { group: 'ip', renderSlot: 'ip-pre' }),
  rule('ip dns server', G, 3, 'single', { group: 'ip', renderSlot: 'ip-pre' }),
  rule('ip dns record <name> <type> <data> <ttl>', G, 3, 'multi', { group: 'ip', renderSlot: 'ip-pre' }),
  rule('ipv6 unicast-routing', G, 2, 'single', { group: 'ipv6', renderSlot: 'ipv6-pre' }),
  rule('ipv6 route <rest>', G, 2, 'multi', { group: 'ipv6', renderSlot: 'ipv6-post' }),

  // ── interface lines ──
  rule('description <rest>', ANY, 1, 'single', { freeTextFrom: 1 }),
  rule('mac-address <mac>', IF, 1, 'single'),
  rule('ip address <rest>', IF, 2, 'single', { group: 'ip' }),
  rule('ip helper-address <address>', IF, 2, 'multi', { group: 'ip' }),
  rule('ipv6 enable', IF, 2, 'single', { group: 'ipv6' }),
  rule('ipv6 address autoconfig', IF, 3, 'single', { group: 'ipv6' }),
  rule('ipv6 address <prefix> <kind>', IF, 2, 'multi', { group: 'ipv6' }),
  rule('ipv6 nd suppress-ra', IF, 3, 'single', { group: 'ipv6' }),
  rule('shutdown', IF, 1, 'single'),
  rule('duplex <mode>', IF, 1, 'single'),
  rule('speed <speed>', IF, 1, 'single'),
  rule('switchport', IF, 1, 'single', { storeNegation: true }),
  rule('clock rate <bps>', IF, 2, 'single'),
  rule('encapsulation <encapsulation>', IF, 1, 'single'),
  rule('bandwidth <kbps>', IF, 1, 'single'),
  rule('keepalive <seconds>', IF, 1, 'single', { storeNegation: true }),
  rule('ssid <rest>', IF, 1, 'single', { freeTextFrom: 1 }),
  rule('security <mode>', IF, 1, 'single'),
  rule('passphrase <rest>', IF, 1, 'single', { freeTextFrom: 1, secretToken: 1 }),
  rule('band <band>', IF, 1, 'single'),
  rule('channel <channel>', IF, 1, 'single'),
  rule('channel-width <mhz>', IF, 1, 'single'),
  rule('tx-power <dbm>', IF, 1, 'single'),
  rule('peer-key <rest>', IF, 1, 'single', { freeTextFrom: 1, secretToken: 1 }),
  rule('beacons', IF, 1, 'single'),

  // ── dhcp pool lines ──
  rule('network <address> <mask>', POOL, 1, 'single'),
  rule('default-router <rest>', POOL, 1, 'single'),
  rule('dns-server <rest>', POOL, 1, 'single'),
  rule('domain-name <name>', POOL, 1, 'single'),
  rule('lease <rest>', POOL, 1, 'single'),

  // ── line (console / vty) lines ──
  rule('password <rest>', LINE, 1, 'single', { secretToken: 1 }),
  rule('login <rest>', LINE, 1, 'single'),
  rule('exec-timeout <minutes> <seconds>', LINE, 1, 'single'),

  // ── P2 §5.1 switching (global) ──
  rule('vlan <vlan-list>', G, 2, 'single', {
    section: { mode: 'config-vlan', separator: true, childOrder: VLAN_CHILD_ORDER },
    ...EARLY_SECTION,
  }),
  rule('spanning-tree mode <mode>', G, 2, 'single', { negationRestoresDefault: true, ...EARLY_GLOBAL }),
  rule('spanning-tree extend system-id', G, 2, 'single', EARLY_GLOBAL),
  rule('spanning-tree vlan <vlan-list> priority <priority>', G, 4, 'single', EARLY_GLOBAL),
  // `spanning-tree vlan <v>` is the default state; `no spanning-tree vlan <v>` persists (one stored negation per VLAN)
  rule('spanning-tree vlan <vlan-list>', G, 3, 'single', { storeNegation: true, ...EARLY_GLOBAL }),
  rule('port-channel load-balance <method>', G, 2, 'single', EARLY_GLOBAL),
  rule('errdisable recovery cause <cause>', G, 3, 'multi', EARLY_GLOBAL),
  rule('errdisable recovery interval <seconds>', G, 3, 'single', EARLY_GLOBAL),
  rule('mac address-table static <rest>', G, 3, 'multi', EARLY_GLOBAL),
  rule('mac address-table aging-time <seconds>', G, 3, 'single', EARLY_GLOBAL),

  // ── P2 §5.1 switching (config-vlan) ──
  rule('name <name>', VLAN, 1, 'single'),

  // ── P2 §5.1 switching (interface) ──
  rule('switchport mode <rest>', IF, 2, 'single'),
  rule('switchport access vlan <vlan>', IF, 3, 'single'),
  rule('switchport trunk native vlan <vlan>', IF, 4, 'single'),
  rule('switchport trunk allowed vlan <rest>', IF, 4, 'single'),
  rule('switchport voice vlan <vlan>', IF, 3, 'single'), // [S4]
  rule('switchport nonegotiate', IF, 2, 'single'),
  // sticky addresses before the sticky flag: a five-token line ties on the literal prefix and table order decides
  rule('switchport port-security mac-address sticky <mac>', IF, 5, 'multi'),
  rule('switchport port-security mac-address sticky', IF, 4, 'single'),
  rule('switchport port-security mac-address <mac>', IF, 3, 'multi'),
  rule('switchport port-security maximum <count>', IF, 3, 'single'),
  rule('switchport port-security violation <mode>', IF, 3, 'single'),
  // any other port-security setting keeps its own identity instead of replacing `switchport port-security`
  rule('switchport port-security <setting> <rest>', IF, 3, 'multi'),
  rule('switchport port-security', IF, 2, 'single'),
  rule('spanning-tree portfast <rest>', IF, 2, 'single'),
  rule('spanning-tree bpduguard <mode>', IF, 2, 'single'),
  rule('spanning-tree guard <mode>', IF, 2, 'single'),
  rule('spanning-tree cost <cost>', IF, 2, 'single'),
  rule('spanning-tree port-priority <priority>', IF, 2, 'single'),
  rule('spanning-tree vlan <vlan-list> cost <cost>', IF, 4, 'single'),
  rule('spanning-tree vlan <vlan-list> port-priority <priority>', IF, 4, 'single'),
  rule('channel-group <group> mode <mode>', IF, 1, 'single'),

  // ── P2 §5.2 routing and services (global) ──
  rule('ip nat pool <name> <rest>', G, 4, 'single', { group: 'ip', renderSlot: 'ip-post' }),
  rule('ip nat inside source list <acl> <rest>', G, 6, 'single', { group: 'ip', renderSlot: 'ip-post' }),
  rule('ip nat inside source static <rest>', G, 5, 'multi', { group: 'ip', renderSlot: 'ip-post' }), // incl. [S9] tcp|udp
  rule('ip nat translation <timeout> <seconds>', G, 4, 'single', { group: 'ip', renderSlot: 'ip-post' }), // [S9]
  rule('access-list <number> <rest>', G, 2, 'multi', { renderSlot: 'ip-post', order: 1 }),
  rule('ip access-list standard <name>', G, 4, 'single', {
    section: { mode: 'config-std-nacl', separator: true },
    renderSlot: 'ip-post',
    order: 2,
  }),
  rule('ipv6 dhcp pool <name>', G, 4, 'single', {
    section: { mode: 'config-dhcpv6', separator: true, childOrder: DHCPV6_POOL_CHILD_ORDER },
    renderSlot: 'dhcp',
    order: 2,
  }),
  rule('voice vlan <vlan>', G, 2, 'single'), // [S4] the IP phone's Voice VLAN field (§5.5)

  // ── P2 §5.2 routing and services (sub-modes) ──
  rule('permit <rest>', NACL, 1, 'multi'),
  rule('deny <rest>', NACL, 1, 'multi'),
  rule('address prefix <prefix> <rest>', POOL6, 2, 'single'),
  rule('dns-server <address>', POOL6, 1, 'multi'),
  rule('domain-name <name>', POOL6, 1, 'single'),

  // ── P2 §5.2 routing and services (interface) ──
  rule('ip nat <side>', IF, 2, 'single', { group: 'ip' }),
  // [S7] §5.2: storeNegation — only `no ip proxy-arp` is stored; with no line the arp reader takes the profile default
  rule('ip proxy-arp', IF, 2, 'single', { group: 'ip', storeNegation: true }),
  rule('ipv6 address dhcp', IF, 3, 'single', { group: 'ipv6' }),
  rule('ipv6 dhcp server <pool>', IF, 3, 'single', { group: 'ipv6' }),
  rule('ipv6 nd managed-config-flag', IF, 3, 'single', { group: 'ipv6' }),
  rule('ipv6 nd other-config-flag', IF, 3, 'single', { group: 'ipv6' }),
  // [S2] HSRP: the group number is optional, so each setting has a group-less and a grouped form
  rule('standby version <version>', IF, 2, 'single'),
  rule('standby ip <rest>', IF, 2, 'single'),
  rule('standby <group> ip <rest>', IF, 3, 'single'),
  rule('standby priority <priority>', IF, 2, 'single'),
  rule('standby <group> priority <priority>', IF, 3, 'single'),
  rule('standby preempt <rest>', IF, 2, 'single'),
  rule('standby <group> preempt <rest>', IF, 3, 'single'),
  rule('standby timers <rest>', IF, 2, 'single'),
  rule('standby <group> timers <rest>', IF, 3, 'single'),

  // ── P2 §5.3 wireless ──
  rule('capwap enable', G, 2, 'single', EARLY_GLOBAL),
  rule('capwap controller <address>', G, 2, 'multi', EARLY_GLOBAL),
  rule('wlc-interface <name>', G, 2, 'single', {
    section: { mode: 'config-wlc-if', separator: true, childOrder: WLC_INTERFACE_CHILD_ORDER },
    renderSlot: 'interface',
    order: -2,
  }),
  rule('wlan <id> <profile> <ssid>', G, 4, 'single', {
    section: { mode: 'config-wlan', separator: true, childOrder: WLAN_CHILD_ORDER },
    renderSlot: 'interface',
    order: -1,
  }),
  rule('vlan <vlan>', WLC_IF, 1, 'single'),
  rule('address <address> <mask>', WLC_IF, 1, 'single'),
  rule('gateway <address>', WLC_IF, 1, 'single'),
  rule('dhcp-server <address>', WLC_IF, 1, 'single'),
  rule('security <mode>', WLAN, 1, 'single'),
  rule('passphrase <rest>', WLAN, 1, 'single', { freeTextFrom: 1, secretToken: 1 }),
  rule('interface <name>', WLAN, 1, 'single'),
  rule('radio <band>', WLAN, 1, 'single'),
  rule('shutdown', WLAN, 1, 'single'),

  // ── generic group folding (any other `ip …` / `ipv6 …` line) ──
  rule('ip <setting> <rest>', ANY, 2, 'multi', { group: 'ip', renderSlot: 'ip-pre' }),
  rule('ipv6 <setting> <rest>', ANY, 2, 'multi', { group: 'ipv6', renderSlot: 'ipv6-pre' }),
]);

/** True when a pattern element names an argument (`<x>`). */
function isArgElement(el: string): boolean {
  return el.length >= 2 && el.startsWith('<') && el.endsWith('>');
}

/**
 * True for a stored-negation rule whose pattern is its identity literals alone (`switchport`): such a rule names
 * exactly that line, never a longer one (ARCHITECTURE-P2 §5 correction: `switchport mode access` is not the bare
 * `switchport` line, so it neither replaces nor cancels it).
 */
function isExactLineRule(r: ConfigLineRule): boolean {
  if (r.storeNegation !== true || r.pattern.length !== r.identity) return false;
  for (const el of r.pattern) if (isArgElement(el)) return false;
  return true;
}

/**
 * Specificity of `rule` for `line`, or -1 when it does not match.
 * A rule matches when the line carries at least `identity` tokens and every literal of the pattern
 * that the line reaches equals its token (`<rest>` swallows the remainder; extra tokens are allowed,
 * except for a stored-negation rule made of its identity literals alone, which matches only its own line).
 * Score = literal prefix length × 1000 + literal count.
 */
export function ruleMatchScore(r: ConfigLineRule, line: readonly string[]): number {
  if (line.length < r.identity) return -1;
  if (line.length > r.pattern.length && isExactLineRule(r)) return -1;
  let prefix = 0;
  let literals = 0;
  let prefixOpen = true;
  for (let i = 0; i < r.pattern.length; i++) {
    const el = r.pattern[i] as string;
    if (el === '<rest>') break;
    if (i >= line.length) {
      if (!isArgElement(el) && i < r.identity) return -1;
      break;
    }
    if (isArgElement(el)) {
      prefixOpen = false;
      continue;
    }
    if (line[i] !== el) return -1;
    literals++;
    if (prefixOpen) prefix++;
  }
  return prefix * 1000 + literals;
}

/** Context key of a context stack for rule lookup: `''` at global level, else the innermost entry's key. */
export function ruleContextKey(context: readonly (readonly string[])[]): string {
  const last = context[context.length - 1];
  return last === undefined ? GLOBAL_CONTEXT_KEY : contextKeyOf(last);
}

/**
 * Build a `ConfigRuleSet` over `rules`. `ruleFor` picks the most specific matching rule whose contexts
 * include the context key (or `*`); ties prefer a context-specific rule, then table order.
 */
export function createConfigRuleSet(rules: readonly ConfigLineRule[]): ConfigRuleSet {
  const frozen = Object.freeze(rules.slice());
  return Object.freeze({
    rules: frozen,
    ruleFor(context: readonly (readonly string[])[], line: readonly string[]): ConfigLineRule | undefined {
      if (line.length === 0) return undefined;
      const key = ruleContextKey(context);
      let best: ConfigLineRule | undefined;
      let bestScore = -1;
      let bestSpecific = false;
      for (const r of frozen) {
        const specific = r.contexts.includes(key);
        if (!specific && !r.contexts.includes(ANY_CONTEXT_KEY)) continue;
        const score = ruleMatchScore(r, line);
        if (score < 0) continue;
        if (score > bestScore || (score === bestScore && specific && !bestSpecific)) {
          best = r;
          bestScore = score;
          bestSpecific = specific;
        }
      }
      return best;
    },
  });
}

/** The rule set built from `CONFIG_LINE_RULES`; the default for every ConfigAst and text walker. */
export const DEFAULT_CONFIG_RULES: ConfigRuleSet = createConfigRuleSet(CONFIG_LINE_RULES);

/** Group keys (`ip`, `ipv6`) declared by a rule set, in first-declaration order. */
export function groupKeysOf(rules: ConfigRuleSet): ReadonlySet<string> {
  const keys = new Set<string>();
  for (const r of rules.rules) if (r.group !== undefined && r.section === undefined) keys.add(r.group);
  return keys;
}

/** Identity token count of `line` under `rule` (1 for rule-less lines), never more than the line length. */
export function ruleIdentity(r: ConfigLineRule | undefined, line: readonly string[]): number {
  const n = r === undefined ? 1 : r.identity;
  return Math.max(1, Math.min(n, line.length));
}

/** True when `line` is the identity-only form of a stored-negation rule (the default state: `switchport`, `keepalive`). */
export function isNegationDefaultLine(r: ConfigLineRule | undefined, line: readonly string[]): boolean {
  return r?.storeNegation === true && r.section === undefined && line.length === r.identity;
}

/** Strip `^C…^C` or single-character delimiters around banner text. */
export function stripBannerDelimiters(text: string): string {
  if (text.length >= 4 && text.startsWith('^C') && text.endsWith('^C')) return text.slice(2, -2);
  if (text.length >= 2) {
    const d = text[0] as string;
    if (!/[A-Za-z0-9\s]/.test(d) && text.endsWith(d)) return text.slice(1, -1);
  }
  return text;
}

/**
 * Canonical token form of a line: the free-text tail of the matching rule is folded into one token
 * (joined with single spaces), and banner text loses its delimiters. Equality and no-op checks
 * therefore do not depend on how a caller tokenized free text.
 */
export function normalizeConfigLine(
  context: readonly (readonly string[])[],
  line: readonly string[],
  rules: ConfigRuleSet = DEFAULT_CONFIG_RULES,
): string[] {
  const r = rules.ruleFor(context, line);
  const from = r?.freeTextFrom;
  if (from === undefined || line.length <= from) return line.slice();
  const out = [...line.slice(0, from), line.slice(from).join(' ')];
  if (out[0] === 'banner') out[out.length - 1] = stripBannerDelimiters(out[out.length - 1] as string);
  return out;
}

/**
 * VLAN ids named by a stored VLAN list (`10,20,30-35`), ascending and without duplicates; null when the text is not a
 * list of whole numbers and ascending ranges within `CONFIG_VLAN_MIN`–`CONFIG_VLAN_MAX`.
 */
function vlanIdsOf(text: string): number[] | null {
  if (text.length === 0) return null;
  const seen = new Set<number>();
  for (const part of text.split(',')) {
    const m = /^(\d{1,4})(?:-(\d{1,4}))?$/.exec(part);
    if (m === null) return null;
    const lo = Number(m[1]);
    const hi = m[2] === undefined ? lo : Number(m[2]);
    if (lo < CONFIG_VLAN_MIN || hi > CONFIG_VLAN_MAX || hi < lo) return null;
    for (let v = lo; v <= hi; v++) seen.add(v);
  }
  return [...seen].sort((a, b) => a - b);
}

/**
 * @since P2 (§5) The stored form of a line whose rule carries `<vlan-list>`: one line per VLAN of the list, in
 * ascending order, the list token replaced by the VLAN number (`vlan 10,20` → `vlan 10`, `vlan 20`;
 * `spanning-tree vlan 1,10 priority 4096` → one line per VLAN). A line whose rule has no such element, that stops
 * before it, or whose token is not a VLAN list of 1-4094 is returned as the only line (a copy). `line` is normalized.
 */
export function expandVlanListLine(
  context: readonly (readonly string[])[],
  line: readonly string[],
  rules: ConfigRuleSet = DEFAULT_CONFIG_RULES,
): string[][] {
  const r = rules.ruleFor(context, line);
  const at = r === undefined ? -1 : r.pattern.indexOf(VLAN_LIST_ELEMENT);
  if (at === -1 || at >= line.length) return [line.slice()];
  const ids = vlanIdsOf(line[at] as string);
  if (ids === null) return [line.slice()];
  return ids.map((v) => {
    const out = line.slice();
    out[at] = String(v);
    return out;
  });
}

/**
 * @since P2 (§5) Every stored context a typed context stands for: a section entry whose rule carries `<vlan-list>`
 * (`vlan 10,20`) stands for one section per VLAN, so `name SALES` typed under it applies to each. A context without
 * such an entry is returned as the only context (a copy).
 */
export function expandVlanListContext(
  context: readonly (readonly string[])[],
  rules: ConfigRuleSet = DEFAULT_CONFIG_RULES,
): string[][][] {
  let out: string[][][] = [[]];
  for (let i = 0; i < context.length; i++) {
    const entry = context[i] as readonly string[];
    const outer = context.slice(0, i);
    const r = rules.ruleFor(outer, entry);
    const entries = r?.section !== undefined ? expandVlanListLine(outer, entry, rules) : [entry.slice()];
    const next: string[][][] = [];
    for (const prefix of out) for (const e of entries) next.push([...prefix.map((p) => p.slice()), e.slice()]);
    out = next;
  }
  return out;
}

/** Render slot of a top-level line (rule slot, else `tail`). */
export function renderSlotOf(r: ConfigLineRule | undefined): ConfigRenderSlot {
  return r?.renderSlot ?? 'tail';
}

/**
 * Copy of `line` with its secret value replaced by `CONFIG_SECRET_MASK` (every token from the rule's
 * `secretToken` on). Lines without a secret token are returned unchanged (as a copy).
 */
export function maskSecretTokens(
  context: readonly (readonly string[])[],
  line: readonly string[],
  rules: ConfigRuleSet = DEFAULT_CONFIG_RULES,
): string[] {
  const r = rules.ruleFor(context, line);
  const idx = r?.secretToken;
  if (idx === undefined || line.length <= idx) return line.slice();
  return [...line.slice(0, idx), CONFIG_SECRET_MASK];
}
