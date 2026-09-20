/**
 * Configuration as an AST (spec §7.4).
 *
 * `running-config` is a tree, never a string. It renders to text with canonical
 * ordering and indentation; `show running-config | section ...` is a tree
 * query; grading assertions address nodes by dotted path (spec §12.4), e.g.
 * `interface.GigabitEthernet0/0.ip.address` → `["10.0.0.1", "255.255.255.0"]`.
 *
 * Node model: a node is `key` + `args` + `children`. Two nodes with the same
 * key but different args (e.g. `interface Gi0/0` and `interface Gi0/1`) are
 * siblings. Path segments match `key` first; when several siblings share the
 * key, the next segment matches `args[0]` (from P0.5 also consecutive args:
 * `ip.dhcp.pool.LAN.network`).
 *
 * P0.5 (ARCHITECTURE-P1 D9, §3.12): line identity, cardinality, sections, stored negations, free text,
 * secrets and render placement come from ONE declarative table (`ConfigLineRule[]`, content in
 * cli/config-rules.ts) consulted by ConfigAst set/unset/render/parse, the shared indentation walker
 * (cli/config-text.ts), device boot replay, `Simulation.configure({indentation})` and secret masking.
 * Mode-entering lines (`ip dhcp pool LAN`, `line vty 0 4`) are ALWAYS stored as plain full-token
 * section nodes, never folded into the `ip` group — this fixes the P0 bug where pool children were lost.
 */
import type { PortId } from './ids.js';
import type { CliMode } from './cli.js';

export interface ConfigNode {
  key: string;
  args: string[];
  children: ConfigNode[];
}

export interface ConfigAst {
  /** Children of the root are top-level config lines/sections. */
  readonly root: ConfigNode;
  /** Query by dotted path; returns matching nodes (possibly several, e.g. all interfaces). */
  query(path: string): ConfigNode[];
  /** First match's args, or undefined. `get("hostname")` → ["R1"]. */
  get(path: string): string[] | undefined;
  /**
   * Set a line under `context` (a mode path like `[["interface","GigabitEthernet0/0"]]`).
   * `line` is tokens; nodes are created as needed. Returns the delta actually applied
   * (undefined if it was a no-op).
   */
  set(context: readonly (readonly string[])[], line: readonly string[]): ConfigDelta | undefined;
  /** `no ...` form. Removes the node matching the line's key (and args, if given). */
  unset(context: readonly (readonly string[])[], line: readonly string[]): ConfigDelta | undefined;
  /** Canonical text rendering, `!`-separated sections, IOS-like indentation. */
  render(): string;
  /** `section`/`include`/`exclude`/`begin` filters over rendered lines. */
  renderFiltered(filter: { kind: 'section' | 'include' | 'exclude' | 'begin'; pattern: string }): string;
  /** Deep copy (for startup-config, checkpoints, diff). */
  clone(): ConfigAst;
  /** Structured diff: lines added/removed between `this` and `other`. */
  diff(other: ConfigAst): ConfigDiff;
  toJSON(): ConfigNode;
  /** @since P0.5 Changes (with contexts) that turn `this` into `other`; applying them in order reproduces `other` exactly (atomic configure revert, Config diff view). */
  diffTree(other: ConfigAst): ConfigTreeChange[];
}

export interface ConfigDelta {
  op: 'set' | 'unset';
  /** Mode path, outermost first: `[["interface","GigabitEthernet0/0"]]` or `[]` for global. */
  context: string[][];
  /** The tokens of the line (without `no`). */
  line: string[];
  /** Previous args of the same key at this context, when replaced or removed. */
  before?: string[];
}

export interface ConfigDiff {
  added: string[];
  removed: string[];
}

/** Helper: context for an interface sub-mode. */
export const ifaceContext = (port: PortId): string[][] => [['interface', port]];

/**
 * Canonical top-level section order used by `render()` in P0. Sections not listed
 * are emitted after these, in insertion order. From P0.5 new keys are placed by
 * `ConfigLineRule.renderSlot` (P0 keys map onto CONFIG_RENDER_SLOTS unchanged).
 */
export const CONFIG_SECTION_ORDER: readonly string[] = [
  'version',
  'service',
  'hostname',
  'enable',
  'username',
  'no',
  'ip',
  'interface',
  'router',
  'banner',
  'line',
  'end',
];

// ── P0.5 line schema ─────────────────────────────────────────────────────────

/** Where a top-level line/section renders. Order = enum order. P0 golden text is unchanged. */
export type ConfigRenderSlot =
  | 'service'
  | 'hostname'
  | 'enable'
  | 'username'
  | 'global-no'
  | 'ip-pre'
  | 'ipv6-pre'
  | 'dhcp'
  | 'interface'
  | 'router'
  | 'ip-post'
  | 'ipv6-post'
  | 'banner'
  | 'line'
  | 'tail';

export const CONFIG_RENDER_SLOTS: readonly ConfigRenderSlot[] = [
  'service', 'hostname', 'enable', 'username', 'global-no', 'ip-pre', 'ipv6-pre',
  'dhcp', 'interface', 'router', 'ip-post', 'ipv6-post', 'banner', 'line', 'tail',
];

/**
 * @since P0.5 Declarative schema of one config line family.
 * Identity = the first `identity` tokens: `set` of a `single` rule replaces the node with equal identity
 * (delta.before); `multi` dedups exact args and appends. `unset` with identity tokens only removes the single
 * node / every multi node with that identity; with extra args removes the exact node.
 */
export interface ConfigLineRule {
  /** Token pattern: literals, `<arg>` = one token, `<rest>` = free-text tail. E.g. ['ip','dhcp','excluded-address','<a>','<b>']. */
  pattern: readonly string[];
  /** Context keys where the rule applies: '' global, 'interface', 'line', 'ip dhcp pool', 'router', 'vlan', '*' any. */
  contexts: readonly string[];
  /** Leading tokens forming the identity (≥ 1). */
  identity: number;
  cardinality: 'single' | 'multi';
  /** Folding group ('ip' | 'ipv6'): stored under the group node with leaf key = token[1]. Never on section rules. */
  group?: string;
  /** Mode-entering line: stored as a plain node carrying all tokens; its children are that mode's lines. */
  section?: { mode: CliMode; separator: boolean; childOrder?: readonly string[] };
  /** `no <line>` that removes nothing persists as a `no …` node in its context (`no switchport`, `no keepalive`, `no ip domain-lookup`). */
  storeNegation?: boolean;
  /** Section rules only: child implied when absent (interface: `shutdown` absent ⇒ `no shutdown`; SVIs on multilayer switches: shutdown implied). */
  impliedDefault?: { line: readonly string[]; negated: boolean };
  /** Token index from which the remainder is one free-text arg (description, banner, ssid, passphrase, ip http page). */
  freeTextFrom?: number;
  /** Token index of a secret value: masked below privilege 15, in snapshots' rendered config shown to lower privilege, and in capture annotations. */
  secretToken?: number;
  renderSlot?: ConfigRenderSlot;
  /** Sort key within the slot or section (lower first; ties = insertion order). */
  order?: number;
}

export interface ConfigRuleSet {
  readonly rules: readonly ConfigLineRule[];
  /** Most specific matching rule (longest literal prefix) for a line in a context; undefined = plain multi-valued key line rendered in 'tail'. */
  ruleFor(context: readonly (readonly string[])[], line: readonly string[]): ConfigLineRule | undefined;
}

/** One logical line produced by the indentation walker (cli/config-text.ts). */
export interface ConfigTextLine {
  /** 1-based line number in the source text. */
  lineNo: number;
  /** Leading-space depth. */
  depth: number;
  context: string[][];
  tokens: string[];
  negate: boolean;
}

/** Structural difference with contexts (atomic configure revert; Config diff view). */
export interface ConfigTreeChange {
  op: 'set' | 'unset';
  context: string[][];
  line: string[];
}
