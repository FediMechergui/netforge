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

/** Canonical order of lines inside an `interface` section; keys not listed follow in insertion order. */
export const INTERFACE_CHILD_ORDER: readonly string[] = [
  'description',
  'mac-address',
  'no switchport',
  'switchport',
  'encapsulation',
  'clock',
  'bandwidth',
  'keepalive',
  'no keepalive',
  'ip',
  'ipv6',
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

const G = [GLOBAL_CONTEXT_KEY] as const;
const IF = ['interface'] as const;
const POOL = ['ip dhcp pool'] as const;
const LINE = ['line'] as const;
const ANY = [ANY_CONTEXT_KEY] as const;

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
  rule('ip routing', G, 2, 'single', { group: 'ip', renderSlot: 'ip-pre' }),
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

  // ── generic group folding (any other `ip …` / `ipv6 …` line) ──
  rule('ip <setting> <rest>', ANY, 2, 'multi', { group: 'ip', renderSlot: 'ip-pre' }),
  rule('ipv6 <setting> <rest>', ANY, 2, 'multi', { group: 'ipv6', renderSlot: 'ipv6-pre' }),
]);

/** True when a pattern element names an argument (`<x>`). */
function isArgElement(el: string): boolean {
  return el.length >= 2 && el.startsWith('<') && el.endsWith('>');
}

/**
 * Specificity of `rule` for `line`, or -1 when it does not match.
 * A rule matches when the line carries at least `identity` tokens and every literal of the pattern
 * that the line reaches equals its token (`<rest>` swallows the remainder; extra tokens are allowed).
 * Score = literal prefix length × 1000 + literal count.
 */
export function ruleMatchScore(r: ConfigLineRule, line: readonly string[]): number {
  if (line.length < r.identity) return -1;
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
