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
 * P3 (ARCHITECTURE-P3 §5, D2, D12, D14, D16, D18, D19, D21; W1 cli), in delimited blocks below:
 *  - the MUST lines of §5.1–§5.6: OSPF (`router ospf` keeps the generic `router <protocol>` rule of identity 2, with
 *    `ROUTER_CHILD_ORDER`), the ACL lines (`sequenced`: global `access-list N …` per list number, section entries per
 *    section; the extended section; remarks), `ip access-group` (a multi line: the handler removes the same-direction
 *    line first, D12), device access (`username … privilege …` with `secretToken` 5, SSH, `transport input`,
 *    `access-class`), hardening, QoS marking (`class-map`, `policy-map` / `class`, `service-policy <dir>` as a
 *    per-direction slot), discovery (`cdp run` / `cdp enable` are `bothForms`; `no lldp transmit|receive` and `no cdp
 *    advertise-v2` stored negations), time and the device API;
 *  - the approved items' rules (§5 "The approved items' rules"): [C1] `router eigrp` with `EIGRP_CHILD_ORDER` and
 *    interface `delay`; [S18]/[C13] tunnel lines and the three crypto sections; [S19] the serial PPP lines; [S20]/[S21]
 *    the queueing actions and interface `fair-queue` (`SCHEDULER_PHY_LINES`); [S24]/[S25] the `logging …` lines and the
 *    identity-3 `service timestamps <kind>` rule.
 * No P1 or P2 grammar line matches a P3 rule, and every P3 key is new in the child orders, so every P1/P2 rendering
 * and storage is unchanged.
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
  'delay', // [C1] (P3: a key no P1/P2 interface section holds)
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
  // ── P3 (§5): keys no P1/P2 interface section holds, so every P1/P2 rendering keeps its order ──
  'ppp', // [S19]
  'peer', // [S19] `peer neighbor-route`
  'no peer', // [S19] its stored negation
  'tunnel', // [S18] / [C13]
  'service-policy',
  'fair-queue', // [S21]
  'cdp',
  'no cdp',
  'lldp',
  'no lldp',
  'shutdown',
  'duplex',
  'speed',
];

/** Canonical order of lines inside an `ip dhcp pool` section. */
export const DHCP_POOL_CHILD_ORDER: readonly string[] = ['network', 'default-router', 'dns-server', 'domain-name', 'lease'];

/**
 * Canonical order of lines inside a `line` section. P3 appends `access-class` and `transport` (§5.2, D14), keys no P1/P2
 * line section holds.
 */
export const LINE_CHILD_ORDER: readonly string[] = ['password', 'login', 'exec-timeout', 'access-class', 'transport'];

/**
 * @since P3 (§5, W1 cli) Canonical order of the children of `router ospf <pid>` (keys; a stored `no passive-interface X`
 * follows the positive `passive-interface` lines). `area` is kept for the lines of later stages ([S5], [C4], [C5]).
 */
export const ROUTER_CHILD_ORDER: readonly string[] = [
  'router-id',
  'auto-cost',
  'area',
  'passive-interface',
  'no passive-interface',
  'network',
  'default-information',
  'maximum-paths',
];

/**
 * @since P3 [C1] (§2.16) Canonical order of the children of `router eigrp <as>`: `eigrp router-id`, `metric weights`,
 * `network`, `passive-interface`, `maximum-paths` (keys; `no auto-summary` is accepted and never stored).
 */
export const EIGRP_CHILD_ORDER: readonly string[] = ['eigrp', 'metric', 'network', 'passive-interface', 'no passive-interface', 'maximum-paths'];

/** @since P3 (§5.4) Canonical order of the children of a `class` section under `policy-map` (mode `config-pmap-c`). */
export const POLICY_CLASS_CHILD_ORDER: readonly string[] = ['set', 'priority', 'bandwidth', 'shape', 'police', 'fair-queue', 'queue-limit'];

/** @since P3 [C13] (§5.7) Canonical order of the children of `crypto ikev2 profile <p>`. */
export const IKEV2_PROFILE_CHILD_ORDER: readonly string[] = ['match', 'authentication', 'keyring'];

/** @since P3 [C13] (§5.7) Canonical order of the children of a keyring's `peer <n>` section. */
export const IKEV2_PEER_CHILD_ORDER: readonly string[] = ['address', 'pre-shared-key'];

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
// P3 contexts (context keys of contracts/cli.ts MODES; `router` is the OSPF process after the §2.11 refinement)
const ROUTER = ['router'] as const;
const EIGRP = ['router eigrp'] as const;
const ACL_SECTIONS = ['ip access-list standard', 'ip access-list extended'] as const;
const CMAP = ['class-map'] as const;
const PMAP = ['policy-map'] as const;
const PMAP_CLASS = ['class'] as const;
const IKE_KEYRING = ['crypto ikev2 keyring'] as const;
const IKE_PEER = ['peer'] as const;
const IKE_PROFILE = ['crypto ikev2 profile'] as const;
const IPSEC_PROFILE = ['crypto ipsec profile'] as const;

/** @since P3 (D12) Sequencing of the entries of an `ip access-list` section (one sequence per section). */
const SEQ_SECTION = { sequenced: { list: 'section' } } as const;
/** @since P3 (D12) Sequencing of the global `access-list <n> …` lines (one sequence per list number, token 1). */
const SEQ_BY_NUMBER = { sequenced: { list: { token: 1 } } } as const;

/**
 * @since P3 Render placement of the P3 sections that precede the interfaces (class-map, policy-map and [C13] the three
 * crypto sections), after the DHCP pools (orders 1, 2) in the `dhcp` slot.
 */
const QOS_CMAP_SECTION = { renderSlot: 'dhcp', order: 3 } as const;
const QOS_PMAP_SECTION = { renderSlot: 'dhcp', order: 4 } as const;
const CRYPTO_SECTION = { renderSlot: 'dhcp', order: 5 } as const;

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
  // P3 (§5.2, D14): the privilege forms keep identity 2 (one slot per user) with the secret at token 5
  rule('username <name> privilege <level> secret <rest>', G, 2, 'single', { renderSlot: 'username', secretToken: 5 }),
  rule('username <name> privilege <level> password <rest>', G, 2, 'single', { renderSlot: 'username', secretToken: 5 }),
  rule('banner <type> <rest>', G, 2, 'single', { renderSlot: 'banner', freeTextFrom: 2 }),
  rule('no <rest>', ANY, 1, 'multi', { renderSlot: 'global-no' }),

  // ── sections ──
  rule('interface <name>', G, 2, 'single', {
    section: { mode: 'config-if', separator: true, childOrder: INTERFACE_CHILD_ORDER },
    impliedDefault: { line: ['shutdown'], negated: true },
    renderSlot: 'interface',
  }),
  // P3 (§5): the identity stays 2, so `router ospf 1` and [C1] `router eigrp 100` are different slots; a second OSPF
  // process is refused by the handler (`ospfOneProcess`), never stored here. Children render in ROUTER_CHILD_ORDER.
  rule('router <protocol> <rest>', G, 2, 'single', {
    section: { mode: 'config-router', separator: true, childOrder: ROUTER_CHILD_ORDER },
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
  // P3 (D12): numbered entries are sequenced per list number (ConfigNode.seq, never rendered)
  rule('access-list <number> <rest>', G, 2, 'multi', { renderSlot: 'ip-post', order: 1, ...SEQ_BY_NUMBER }),
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
  // P3 (D12): the entries of a standard or extended section are sequenced per section
  rule('permit <rest>', ACL_SECTIONS, 1, 'multi', SEQ_SECTION),
  rule('deny <rest>', ACL_SECTIONS, 1, 'multi', SEQ_SECTION),
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

  // ── P3 §5.1 routing: OSPF (MUST) ──
  rule('router-id <address>', ROUTER, 1, 'single'),
  // multi, identity 3: `no network A W` removes that network whatever its area; the handler refuses A W in another area
  rule('network <address> <wildcard> area <area>', ROUTER, 3, 'multi'),
  rule('passive-interface default', ROUTER, 2, 'single'),
  // both forms, so the stored negation that `passive-interface default` needs (`no passive-interface X`) survives
  // replay (reload, export, the clone); the handler clears it when the default goes and needs none without it
  rule('passive-interface <interface>', ROUTER, 2, 'multi', { bothForms: true }),
  rule('auto-cost reference-bandwidth <mbps>', ROUTER, 2, 'single'),
  rule('default-information originate <rest>', ROUTER, 2, 'single'),
  rule('maximum-paths <paths>', ROUTER, 1, 'single'),
  // interface: `ip ospf <pid> area <a>` is one slot per interface (identity 2 under the `ip ospf` leaf), so another
  // pid's line is replaced; the per-setting lines have identity 3
  rule('ip ospf <pid> area <area>', IF, 2, 'single', { group: 'ip' }),
  rule('ip ospf cost <cost>', IF, 3, 'single', { group: 'ip' }),
  rule('ip ospf priority <priority>', IF, 3, 'single', { group: 'ip' }),
  rule('ip ospf hello-interval <seconds>', IF, 3, 'single', { group: 'ip' }),
  rule('ip ospf dead-interval <seconds>', IF, 3, 'single', { group: 'ip' }),
  rule('ip ospf network <type>', IF, 3, 'single', { group: 'ip' }),

  // ── P3 §5.2 ACLs and device access (MUST) ──
  rule('access-list <number> remark <rest>', G, 2, 'multi', { renderSlot: 'ip-post', order: 1, freeTextFrom: 3, ...SEQ_BY_NUMBER }),
  rule('ip access-list extended <name>', G, 4, 'single', {
    section: { mode: 'config-ext-nacl', separator: true },
    renderSlot: 'ip-post',
    order: 2,
  }),
  rule('remark <rest>', ACL_SECTIONS, 1, 'multi', { freeTextFrom: 1, ...SEQ_SECTION }),
  // one line per direction: the handler removes the same-direction line before storing (D12), so the AST keeps a multi
  // line whose value is the whole `<list> <dir>` pair
  rule('ip access-group <list> <direction>', IF, 2, 'multi', { group: 'ip' }),
  rule('access-class <list> <direction>', LINE, 1, 'single'),
  rule('transport input <rest>', LINE, 2, 'single'),
  rule('crypto key generate rsa <rest>', G, 4, 'single', { renderSlot: 'ip-pre', order: 1 }),
  rule('ip ssh version <version>', G, 3, 'single', { group: 'ip', renderSlot: 'ip-pre', order: 2 }),
  rule('ip ssh time-out <seconds>', G, 3, 'single', { group: 'ip', renderSlot: 'ip-pre', order: 2 }),
  rule('ip ssh authentication-retries <count>', G, 3, 'single', { group: 'ip', renderSlot: 'ip-pre', order: 2 }),

  // ── P3 §5.3 access-layer hardening (MUST) ──
  rule('ip dhcp snooping', G, 3, 'single', { group: 'ip', renderSlot: 'ip-pre' }),
  rule('ip dhcp snooping vlan <vlan-list>', G, 5, 'single', { group: 'ip', renderSlot: 'ip-pre' }),
  rule('ip dhcp snooping verify mac-address', G, 5, 'single', { group: 'ip', renderSlot: 'ip-pre', storeNegation: true }),
  rule('ip dhcp snooping information option', G, 5, 'single', { group: 'ip', renderSlot: 'ip-pre', storeNegation: true }),
  rule('ip source binding <mac> vlan <vlan> <address> interface <interface>', G, 6, 'single', { group: 'ip', renderSlot: 'ip-pre' }),
  rule('ip arp inspection vlan <vlan-list>', G, 5, 'single', { group: 'ip', renderSlot: 'ip-pre' }),
  rule('ip dhcp snooping trust', IF, 4, 'single', { group: 'ip' }),
  rule('ip dhcp snooping limit rate <pps>', IF, 5, 'single', { group: 'ip' }),
  rule('ip arp inspection trust', IF, 4, 'single', { group: 'ip' }),
  rule('ip arp inspection limit <rest>', IF, 4, 'single', { group: 'ip' }),

  // ── P3 §5.4 QoS marking (MUST) ──
  rule('class-map <rest>', G, 2, 'single', { section: { mode: 'config-cmap', separator: true }, ...QOS_CMAP_SECTION }),
  rule('match <rest>', CMAP, 2, 'multi'),
  rule('policy-map <name>', G, 2, 'single', { section: { mode: 'config-pmap', separator: true }, ...QOS_PMAP_SECTION }),
  rule('class <name>', PMAP, 2, 'single', { section: { mode: 'config-pmap-c', separator: false, childOrder: POLICY_CLASS_CHILD_ORDER } }),
  rule('set <rest>', PMAP_CLASS, 2, 'single'),
  // one policy per direction (a per-direction slot; not a PHY_CONFIG_KEYS line in the MUST plan, D16)
  rule('service-policy <direction> <name>', IF, 2, 'single'),

  // ── P3 §5.5 discovery and time (MUST) ──
  rule('cdp run', G, 2, 'single', { renderSlot: 'global-no', bothForms: true }),
  rule('cdp timer <seconds>', G, 2, 'single', { renderSlot: 'global-no' }),
  rule('cdp holdtime <seconds>', G, 2, 'single', { renderSlot: 'global-no' }),
  rule('cdp advertise-v2', G, 2, 'single', { renderSlot: 'global-no', storeNegation: true }),
  rule('cdp enable', IF, 2, 'single', { bothForms: true }),
  rule('lldp run', G, 2, 'single', { renderSlot: 'global-no' }),
  rule('lldp timer <seconds>', G, 2, 'single', { renderSlot: 'global-no' }),
  rule('lldp holdtime <seconds>', G, 2, 'single', { renderSlot: 'global-no' }),
  rule('lldp reinit <seconds>', G, 2, 'single', { renderSlot: 'global-no' }),
  rule('lldp transmit', IF, 2, 'single', { storeNegation: true }),
  rule('lldp receive', IF, 2, 'single', { storeNegation: true }),
  rule('clock timezone <rest>', G, 2, 'single', { renderSlot: 'hostname', order: 1 }),
  // one slot per server address (identity 3), so `prefer` or `source` replaces that server's line
  rule('ntp server <address> <rest>', G, 3, 'single'),
  rule('ntp master <rest>', G, 2, 'single'),
  rule('ntp source <interface>', G, 2, 'single'),

  // ── P3 §5.6 device API (MUST) ──
  rule('ip http secure-server', G, 3, 'single', { group: 'ip', renderSlot: 'ip-post' }),
  rule('ip http authentication <kind>', G, 3, 'single', { group: 'ip', renderSlot: 'ip-post' }),
  rule('restconf', G, 1, 'single'),

  // ── [C1] EIGRP (§2.16, §5.1) ──
  rule('router eigrp <as>', G, 2, 'single', {
    section: { mode: 'config-router-eigrp', separator: true, childOrder: EIGRP_CHILD_ORDER },
    renderSlot: 'router',
  }),
  rule('network <address> <rest>', EIGRP, 2, 'multi'),
  rule('eigrp router-id <address>', EIGRP, 2, 'single'),
  rule('passive-interface default', EIGRP, 2, 'single'),
  rule('passive-interface <interface>', EIGRP, 2, 'multi', { bothForms: true }),
  rule('metric weights <rest>', EIGRP, 2, 'single'),
  rule('maximum-paths <paths>', EIGRP, 1, 'single'),
  rule('delay <tens-of-us>', IF, 1, 'single'),
  rule('ip hello-interval eigrp <as> <seconds>', IF, 4, 'single', { group: 'ip' }),
  rule('ip hold-time eigrp <as> <seconds>', IF, 4, 'single', { group: 'ip' }),

  // ── [S18] GRE tunnel interface and [C13] its IPsec mode (§5.7) ──
  rule('tunnel source <source>', IF, 2, 'single'),
  rule('tunnel destination <address>', IF, 2, 'single'),
  rule('tunnel mode <rest>', IF, 2, 'single'),
  rule('tunnel protection <rest>', IF, 2, 'single'),
  rule('ip mtu <bytes>', IF, 2, 'single', { group: 'ip' }),
  rule('ip tcp adjust-mss <bytes>', IF, 3, 'single', { group: 'ip' }),

  // ── [C13] the crypto sections (§2.17, §5.7) ──
  rule('crypto ikev2 keyring <name>', G, 4, 'single', { section: { mode: 'config-ikev2-keyring', separator: true }, ...CRYPTO_SECTION }),
  rule('peer <name>', IKE_KEYRING, 2, 'single', {
    section: { mode: 'config-ikev2-keyring-peer', separator: false, childOrder: IKEV2_PEER_CHILD_ORDER },
  }),
  rule('address <address>', IKE_PEER, 1, 'single'),
  rule('pre-shared-key <rest>', IKE_PEER, 1, 'single', { secretToken: 1 }),
  rule('crypto ikev2 profile <name>', G, 4, 'single', {
    section: { mode: 'config-ikev2-profile', separator: true, childOrder: IKEV2_PROFILE_CHILD_ORDER },
    renderSlot: 'dhcp',
    order: 6,
  }),
  rule('match identity remote address <address> <rest>', IKE_PROFILE, 5, 'single'),
  rule('authentication local <method>', IKE_PROFILE, 2, 'single'),
  rule('authentication remote <method>', IKE_PROFILE, 2, 'single'),
  rule('keyring local <name>', IKE_PROFILE, 2, 'single'),
  rule('crypto ipsec profile <name>', G, 4, 'single', { section: { mode: 'config-ipsec-profile', separator: true }, renderSlot: 'dhcp', order: 7 }),
  rule('set ikev2-profile <name>', IPSEC_PROFILE, 2, 'single'),

  // ── [S19] PPP on serial interfaces (§5.7; the global `username <n> password <pw>` form is the P0 rule above) ──
  rule('ppp authentication <rest>', IF, 2, 'single'),
  rule('ppp pap sent-username <name> password <rest>', IF, 3, 'single', { secretToken: 5 }),
  rule('peer neighbor-route', IF, 2, 'single', { storeNegation: true }),

  // ── [S20]/[S21] queueing actions under `policy-map` / `class`, and interface WFQ (§5.4) ──
  rule('priority <rest>', PMAP_CLASS, 1, 'single'),
  rule('bandwidth <rest>', PMAP_CLASS, 1, 'single'),
  rule('queue-limit <packets>', PMAP_CLASS, 1, 'single'),
  rule('fair-queue', PMAP_CLASS, 1, 'single'),
  rule('police <rest>', PMAP_CLASS, 1, 'single'),
  rule('shape average <rest>', PMAP_CLASS, 2, 'single'),
  rule('fair-queue', IF, 1, 'single'),

  // ── [S24]/[S25] logging (§5.7): tail slot, like every rule-less line before them ──
  rule('service timestamps <kind> <rest>', G, 3, 'single', { renderSlot: 'service' }),
  rule('logging buffered <rest>', G, 2, 'single'),
  rule('logging console <rest>', G, 2, 'single', { bothForms: true }),
  rule('logging monitor <rest>', G, 2, 'single'),
  rule('logging host <address>', G, 2, 'multi'),
  rule('logging trap <level>', G, 2, 'single'),
  rule('logging source-interface <interface>', G, 2, 'single'),
  rule('logging facility <facility>', G, 2, 'single'),
  // `logging <addr>` (the alias of `logging host <addr>`); every keyword form above is more specific
  rule('logging <address>', G, 2, 'multi'),

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

// ── P3: sequencing (D12) and the scheduler lines ([S20]/[S21]) ────────────────────────────────────────────────────

/** @since P3 (D12) Step between two sequence numbers: a new entry gets the list's highest number + 10 (10 when empty). */
export const CONFIG_SEQ_STEP = 10;
/** @since P3 (D12) Highest sequence number an entry may carry (a positive 32-bit signed integer). */
export const CONFIG_SEQ_MAX = 2_147_483_647;

/** Context keys whose entries are sequenced per section, per rule set (built on first use). */
const SECTION_SEQUENCED_KEYS = new WeakMap<ConfigRuleSet, ReadonlySet<string>>();

function sectionSequencedKeys(rules: ConfigRuleSet): ReadonlySet<string> {
  let keys = SECTION_SEQUENCED_KEYS.get(rules);
  if (keys === undefined) {
    const set = new Set<string>();
    for (const r of rules.rules) if (r.sequenced?.list === 'section') for (const c of r.contexts) set.add(c);
    keys = set;
    SECTION_SEQUENCED_KEYS.set(rules, keys);
  }
  return keys;
}

/**
 * @since P3 (D12) True when lines typed in `context` are entries of a sequenced list section (`ip access-list
 * standard|extended <name>`): there a leading number is the entry's sequence number (`15 permit …`) and a lone number
 * names an entry (`no 20`).
 */
export function isSequencedSectionContext(context: readonly (readonly string[])[], rules: ConfigRuleSet = DEFAULT_CONFIG_RULES): boolean {
  return context.length > 0 && sectionSequencedKeys(rules).has(ruleContextKey(context));
}

/**
 * @since P3 (D12) The list a sequenced line belongs to: the section's name (the last token of the innermost context
 * entry) for a section entry, the rule's `{token}` for a global line (`access-list 10 …` → '10'). A numbered section
 * and the global lines of its number are one list. Undefined for a line whose rule is not sequenced.
 */
export function sequencedListOf(
  context: readonly (readonly string[])[],
  line: readonly string[],
  rules: ConfigRuleSet = DEFAULT_CONFIG_RULES,
): string | undefined {
  const seq = rules.ruleFor(context, line)?.sequenced;
  if (seq === undefined) return undefined;
  if (seq.list === 'section') {
    const entry = context[context.length - 1];
    return entry === undefined ? undefined : entry[entry.length - 1];
  }
  return line[seq.list.token];
}

/**
 * @since P3 [S20]/[S21] (§5 "The approved items' rules") The interface lines whose change the link model must see on a
 * PHYSICAL port besides `PHY_CONFIG_KEYS` (device/device.ts): the output policy (`service-policy output …`, a
 * per-direction slot, so only this direction) and interface WFQ (`fair-queue`). The device applies it to physical ports
 * only, as it does for `PHY_CONFIG_KEYS`; no P1/P2 line matches, and the MUST plan never calls it.
 */
export const SCHEDULER_PHY_LINES: readonly (readonly string[])[] = Object.freeze([
  Object.freeze(['service-policy', 'output']),
  Object.freeze(['fair-queue']),
]);

/** @since P3 [S20]/[S21] True when `line` (without `no`) starts with one of `SCHEDULER_PHY_LINES`. */
export function isSchedulerPhyLine(line: readonly string[]): boolean {
  return SCHEDULER_PHY_LINES.some((p) => p.length <= line.length && p.every((t, i) => line[i] === t));
}

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
