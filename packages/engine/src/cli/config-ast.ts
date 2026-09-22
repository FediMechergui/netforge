/**
 * Configuration AST (spec §7.4, §12.4; ARCHITECTURE-P1 §3.12, §6).
 *
 * `running-config` is a tree of `ConfigNode`s (key + args + children), never a string. This module
 * implements the `ConfigAst` contract, driven by the declarative rule table (cli/config-rules.ts):
 *
 *  - `set` / `unset` apply config lines under a mode context and return the `ConfigDelta` actually
 *    applied. Identity (the leading tokens naming a setting) and cardinality come from the matching
 *    rule: a `single` line replaces the node with the same identity (delta `before`), a `multi` line
 *    dedups exact tokens and appends. Lines without a rule are multi-valued with a one-token identity
 *    (the P0 behaviour of unknown keys). No-ops return undefined.
 *  - Sections (`interface X`, `line vty 0 4`, `ip dhcp pool LAN`) are stored as plain full-token
 *    nodes whose children are the lines of that mode. They are never folded into the `ip` group, so
 *    the context walk and the stored section are the same node (this fixes the P0 bug where
 *    `ip dhcp pool` children were lost from render and save).
 *  - Stored negations: for a rule with `storeNegation`, `unset` of the identity-only line (`no
 *    switchport`, `no keepalive`) removes any positive node of that identity and persists a `no …`
 *    node in the context; `set` of any line of that rule removes the stored negation, and the
 *    identity-only line (`switchport`, `keepalive`) is the default state, so it is not stored itself.
 *  - `render` produces the canonical text: the original NetForge header, then top-level lines grouped
 *    by `ConfigLineRule.renderSlot` in `CONFIG_RENDER_SLOTS` order (one `!` block per slot, one block
 *    per section node, unknown keys in the tail with one block per key), section children ordered by
 *    the section rule's `childOrder`, one-space indentation, `end`. P0 text is unchanged.
 *  - `diffTree` returns the set/unset changes (with contexts) that turn this tree into another.
 *  - `query` / `get` address nodes by dotted path; consecutive segments may match a node's args
 *    (`interface.GigabitEthernet0/0.ip.address`, `ip.dhcp.pool.LAN.network`).
 *  - `parseConfigText` rebuilds a tree from text through the shared indentation walker
 *    (cli/config-text.ts) such that `parseConfigText(ast.render()).render() === ast.render()`.
 *
 * P2 (ARCHITECTURE-P2 §5, D2; W1 cli):
 *  - identity is per rule: a single-valued line replaces (and an identity-only `no` form removes) only a node whose own
 *    rule has the same identity length (`switchport port-security` never replaces `switchport port-security maximum 2`);
 *    the identity-only default line of a stored-negation rule (`switchport`, `keepalive`) clears only nodes of its own
 *    rule, so `switchport` keeps `switchport mode …`; `no switchport` still removes every `switchport …` child;
 *  - `bothForms` rules (`ip routing`): the line and its `no` form share one slot and each is
 *    stored as typed (the negation as a `no …` node, the shape the runtime already stores for a global negation);
 *  - VLAN lists (`<vlan-list>` rules, cli/config-rules.ts): `vlan 10,20` stores the sections `vlan 10` and `vlan 20`,
 *    and a line typed under `vlan 10,20` applies to each;
 *  - the completeness rule: `apply(context, line, negate, {defaults})` with the device's default slots stores
 *    explicitly a line that would leave a default slot empty, and restores the default line for
 *    `negationRestoresDefault` rules (`slotKeyOf`, `defaultSlotsOf`, `DefaultSlots`). Without `defaults`, `apply` is
 *    exactly `set` / `unset`.
 *
 * Storage conventions (shared with every process that consumes `ConfigDelta`):
 *  - a line of a rule with `group` (`ip address A M` under an interface) is stored as a group node
 *    `ip` (no args) with a child `address` whose args are `[A, M]` (path `ip.address`);
 *  - flag lines have no args (`shutdown`);
 *  - free text is one arg (`description <rest>`, `banner motd <text>` without its `^C` delimiters);
 *  - `ConfigDelta.line` always carries the full normalized tokens of the line.
 *
 * Pure TypeScript, no I/O, no wall-clock, no randomness (engine rule G4).
 */
import { CONFIG_RENDER_SLOTS } from '../contracts/config.js';
import type {
  ConfigAst,
  ConfigDelta,
  ConfigDiff,
  ConfigLineRule,
  ConfigNode,
  ConfigRenderSlot,
  ConfigRuleSet,
  ConfigTreeChange,
  DefaultSlots,
} from '../contracts/config.js';
import {
  DEFAULT_CONFIG_RULES,
  expandVlanListContext,
  expandVlanListLine,
  groupKeysOf,
  isNegationDefaultLine,
  normalizeConfigLine,
  renderSlotOf,
  ruleIdentity,
} from './config-rules.js';
import { walkConfigText } from './config-text.js';

/** @since P2 The default slots of a device (declared in contracts/config.ts; re-exported, never redeclared). */
export type { DefaultSlots } from '../contracts/config.js';

/** First rendered line — an original NetForge comment, never vendor text. */
export const CONFIG_HEADER_COMMENT = '! NetForge NFOS configuration';

/** Second rendered line. */
export const CONFIG_VERSION_LINE = 'version 1.0';

/** Keys never rendered as nodes (they are synthesized by `render`). */
const SYNTHETIC_KEYS: ReadonlySet<string> = new Set(['version', 'end']);

/** Key of stored negation nodes. */
const NO_KEY = 'no';

// ───────────────────────────── small pure helpers ─────────────────────────────

/** Array equality on string tuples. */
function sameArgs(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** True when the first `n` tokens of `a` and `b` exist and are equal. */
function prefixEqual(a: readonly string[], b: readonly string[], n: number): boolean {
  if (a.length < n || b.length < n) return false;
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** Deep copy of a node (args and children arrays are fresh). */
function cloneNode(node: ConfigNode): ConfigNode {
  return { key: node.key, args: node.args.slice(), children: node.children.map(cloneNode) };
}

/** Fresh root node. The root has an empty key and is never rendered itself. */
function makeRoot(): ConfigNode {
  return { key: '', args: [], children: [] };
}

/** Deep copy of a context stack. */
function copyContext(context: readonly (readonly string[])[]): string[][] {
  return context.map((e) => e.slice());
}

/** Compile a CLI filter pattern; falls back to a literal match for invalid regexes. */
function compilePattern(pattern: string): RegExp {
  try {
    return new RegExp(pattern);
  } catch {
    return new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  }
}

/** Split the rendered text into lines (no trailing empty line). */
function renderedLines(text: string): string[] {
  const lines = text.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** Lines that carry configuration (drops `!` comments, `end` and the version header). */
function isContentLine(line: string): boolean {
  const t = line.trimStart();
  return t !== '' && !t.startsWith('!') && t !== 'end' && line !== CONFIG_VERSION_LINE;
}

/** One rendered line for a node (key + args, banner delimiters restored). */
function leafLine(prefix: string, key: string, args: readonly string[]): string {
  if (key === 'banner' && args.length >= 2) {
    return `${prefix}banner ${args[0]} ^C${args.slice(1).join(' ')}^C`;
  }
  return args.length === 0 ? `${prefix}${key}` : `${prefix}${key} ${args.join(' ')}`;
}

/** Sort key of a section child for `childOrder`: `no <first arg>` for stored negations, else the key. */
function childSortKey(node: ConfigNode): string {
  return node.key === NO_KEY && node.args.length > 0 ? `${NO_KEY} ${node.args[0]}` : node.key;
}

/** Stable sort of section children by `order`; keys not listed follow in insertion order. */
function orderChildren(children: readonly ConfigNode[], order: readonly string[] | undefined): readonly ConfigNode[] {
  if (order === undefined || order.length === 0) return children;
  const rank = (n: ConfigNode): number => {
    const i = order.indexOf(childSortKey(n));
    return i === -1 ? order.length : i;
  };
  return children
    .map((n, i) => ({ n, i, r: rank(n) }))
    .sort((a, b) => a.r - b.r || a.i - b.i)
    .map((x) => x.n);
}

/** Append the rendered lines of `node` (and its subtree) at `depth` to `out`. `context` is the node's context. */
function nodeLines(
  node: ConfigNode,
  depth: number,
  out: string[],
  context: readonly (readonly string[])[],
  rules: ConfigRuleSet,
  groups: ReadonlySet<string>,
): void {
  const indent = ' '.repeat(depth);
  if (groups.has(node.key) && node.args.length === 0) {
    // a group node renders one full line per leaf; an empty group renders nothing
    for (const child of node.children) {
      out.push(leafLine(indent, `${node.key} ${child.key}`, child.args));
      const sub = [...context, [node.key, child.key, ...child.args]];
      for (const grand of child.children) nodeLines(grand, depth + 1, out, sub, rules, groups);
    }
    return;
  }
  out.push(leafLine(indent, node.key, node.args));
  if (node.children.length === 0) return;
  const tokens = [node.key, ...node.args];
  const order = rules.ruleFor(context, tokens)?.section?.childOrder;
  const sub = [...context, tokens];
  for (const child of orderChildren(node.children, order)) nodeLines(child, depth + 1, out, sub, rules, groups);
}

/**
 * Render one node (and its subtree) as text, `depth` spaces of indentation. The root node (empty key)
 * renders its children only, in insertion order. The node is assumed to sit at global context (for
 * child ordering). Lines are joined with `\n` and carry no trailing newline.
 */
export function configNodeToText(node: ConfigNode, depth = 0, rules: ConfigRuleSet = DEFAULT_CONFIG_RULES): string {
  const out: string[] = [];
  const groups = groupKeysOf(rules);
  if (node.key === '') {
    for (const child of node.children) nodeLines(child, depth, out, [], rules, groups);
  } else {
    nodeLines(node, depth, out, [], rules, groups);
  }
  return out.join('\n');
}

/** One top-level render unit. */
interface RenderEntry {
  slot: ConfigRenderSlot;
  order: number;
  seq: number;
  /** Tail grouping key (first token). */
  tailKey: string;
  /** Own `!` block (section rules with `separator`). */
  separator: boolean;
  lines: string[];
}

/** One comparable unit of a storage list for `diffTree`. */
interface DiffEntry {
  kind: 'line' | 'neg' | 'group';
  /** Unique comparison key within the list. */
  key: string;
  /** Full tokens: the line (group leaves include the group key), the negated line, or `[group]`. */
  tokens: string[];
  node: ConfigNode;
}

/** Applies changes to a working tree and records only the ones that changed it. */
class ChangeRecorder {
  readonly changes: ConfigTreeChange[] = [];

  constructor(private readonly ast: ConfigAst) {}

  /** Apply and record a `set` when it is not a no-op. */
  set(context: readonly (readonly string[])[], line: readonly string[]): void {
    if (this.ast.set(context, line) !== undefined) {
      this.changes.push({ op: 'set', context: copyContext(context), line: line.slice() });
    }
  }

  /** Apply and record an `unset` when it is not a no-op. */
  unset(context: readonly (readonly string[])[], line: readonly string[]): void {
    if (this.ast.unset(context, line) !== undefined) {
      this.changes.push({ op: 'unset', context: copyContext(context), line: line.slice() });
    }
  }
}

// ─────────────────────────────── the AST class ────────────────────────────────

class ConfigAstImpl implements ConfigAst {
  readonly root: ConfigNode;
  private readonly rules: ConfigRuleSet;
  private readonly groups: ReadonlySet<string>;

  constructor(root: ConfigNode, rules: ConfigRuleSet) {
    this.root = root;
    this.rules = rules;
    this.groups = groupKeysOf(rules);
  }

  /** Walk (optionally creating) the context nodes; each entry is `[key, ...args]`. */
  private walk(context: readonly (readonly string[])[], create: boolean): ConfigNode | undefined {
    let node: ConfigNode = this.root;
    for (const entry of context) {
      const key = entry[0];
      if (key === undefined) return undefined;
      const args = entry.slice(1);
      let next: ConfigNode | undefined;
      for (const c of node.children) {
        if (c.key === key && sameArgs(c.args, args)) {
          next = c;
          break;
        }
      }
      if (!next) {
        if (!create) return undefined;
        next = { key, args, children: [] };
        node.children.push(next);
      }
      node = next;
    }
    return node;
  }

  /** Group key a normalized line folds into under `rule`, if any. */
  private groupFor(rule: ConfigLineRule | undefined, norm: readonly string[]): string | undefined {
    if (rule?.group === undefined || rule.section !== undefined) return undefined;
    return norm.length >= 2 && norm[0] === rule.group ? rule.group : undefined;
  }

  /** Find the group node (key with no args) under `parent`, creating it when asked. */
  private findGroup(parent: ConfigNode, key: string, create: boolean): ConfigNode | undefined {
    for (const c of parent.children) {
      if (c.key === key && c.args.length === 0) return c;
    }
    if (!create) return undefined;
    const g: ConfigNode = { key, args: [], children: [] };
    parent.children.push(g);
    return g;
  }

  /** Remove `group` from `ctxNode` when it has no leaves left. */
  private dropEmptyGroup(ctxNode: ConfigNode, group: ConfigNode): void {
    if (group.children.length > 0) return;
    const idx = ctxNode.children.indexOf(group);
    if (idx !== -1) ctxNode.children.splice(idx, 1);
  }

  /** Full tokens of a stored node (group leaves include the group key). */
  private tokensOf(node: ConfigNode, group: string | undefined): string[] {
    return group === undefined ? [node.key, ...node.args] : [group, node.key, ...node.args];
  }

  /**
   * Remove every node of `container` whose first `ident` tokens equal `norm`'s; returns their value args. With
   * `sameRule`, only nodes whose own rule (in `context`) is that rule are removed.
   */
  private removeIdentity(
    container: ConfigNode,
    norm: readonly string[],
    ident: number,
    group: string | undefined,
    sameRule?: { rule: ConfigLineRule; context: readonly (readonly string[])[] },
  ): string[][] {
    const removed: string[][] = [];
    const kept: ConfigNode[] = [];
    for (const c of container.children) {
      const t = this.tokensOf(c, group);
      const hit = c.key !== NO_KEY && prefixEqual(t, norm, ident) && (sameRule === undefined || this.rules.ruleFor(sameRule.context, t) === sameRule.rule);
      if (hit) removed.push(t.slice(ident));
      else kept.push(c);
    }
    if (removed.length > 0) container.children.splice(0, container.children.length, ...kept);
    return removed;
  }

  /** Identity length of a stored line (`tokens`, group key included) under its own rule in `context`. */
  private identityOf(context: readonly (readonly string[])[], tokens: readonly string[]): number {
    return ruleIdentity(this.rules.ruleFor(context, tokens), tokens);
  }

  /** Whether `context` holds a stored `no …` node whose args are exactly `args`. */
  private hasNegation(context: readonly (readonly string[])[], args: readonly string[]): boolean {
    const ctxNode = this.walk(context, false);
    return ctxNode !== undefined && ctxNode.children.some((c) => c.key === NO_KEY && sameArgs(c.args, args));
  }

  /**
   * Whether the slot of `norm` (rule `rule`) holds a positive line: for a single-valued rule any node of the same
   * identity under the same identity length, for a multi-valued rule the exact line.
   */
  private slotHasValue(context: readonly (readonly string[])[], rule: ConfigLineRule, norm: readonly string[], ident: number): boolean {
    const ctxNode = this.walk(context, false);
    if (ctxNode === undefined) return false;
    const group = this.groupFor(rule, norm);
    const container = group === undefined ? ctxNode : this.findGroup(ctxNode, group, false);
    if (container === undefined) return false;
    return container.children.some((c) => {
      if (c.key === NO_KEY) return false;
      const t = this.tokensOf(c, group);
      if (rule.cardinality === 'multi') return sameArgs(t, norm);
      return prefixEqual(t, norm, ident) && this.identityOf(context, t) === ident;
    });
  }

  /** Remove stored `no …` nodes in `ctxNode` carrying the identity of `norm`; true when one was removed. */
  private cancelNegation(ctxNode: ConfigNode, norm: readonly string[], ident: number): boolean {
    const identity = norm.slice(0, ident);
    const before = ctxNode.children.length;
    const kept = ctxNode.children.filter((c) => !(c.key === NO_KEY && (sameArgs(c.args, identity) || sameArgs(c.args, norm))));
    if (kept.length === before) return false;
    ctxNode.children.splice(0, ctxNode.children.length, ...kept);
    return true;
  }

  query(path: string): ConfigNode[] {
    const segments = path.split('.').filter((s) => s.length > 0);
    if (segments.length === 0) return [];
    const result: ConfigNode[] = [];
    const visit = (nodes: readonly ConfigNode[], pos: number): void => {
      const seg = segments[pos] as string;
      for (const c of nodes) {
        if (c.key !== seg) continue;
        // the node itself at pos+1, then after consuming consecutive args
        let at = pos + 1;
        const positions = [at];
        for (let m = 0; m < c.args.length && at < segments.length && segments[at] === c.args[m]; m++) {
          at++;
          positions.push(at);
        }
        for (const p of positions) {
          if (p === segments.length) {
            if (!result.includes(c)) result.push(c);
          } else {
            visit(c.children, p);
          }
        }
      }
    };
    visit(this.root.children, 0);
    return result;
  }

  get(path: string): string[] | undefined {
    const first = this.query(path)[0];
    return first ? first.args.slice() : undefined;
  }

  set(context: readonly (readonly string[])[], line: readonly string[]): ConfigDelta | undefined {
    return this.expanded(context, line, (ctx, norm) => this.setOne(ctx, norm));
  }

  unset(context: readonly (readonly string[])[], line: readonly string[]): ConfigDelta | undefined {
    return this.expanded(context, line, (ctx, norm) => this.unsetOne(ctx, norm));
  }

  /**
   * `set` (negate false) or `unset` (negate true) of one typed line. With `opts.defaults` (the device's default slots,
   * ARCHITECTURE-P2 §5, D2) the completeness rule applies:
   *  (1) a line that would leave a default slot empty is stored explicitly: the `no` form of an ordinary rule stores
   *      `no <identity>` (a multi-valued rule: `no <line>`), the identity-only line of a stored-negation rule stores
   *      itself (`switchport`), and a later positive line of the slot cancels that explicit negation;
   *  (2) the `no` form of a `negationRestoresDefault` rule (`spanning-tree mode`) stores the slot's default line, or
   *      clears the slot when it is not a default slot.
   * Section lines are containers, not slots; `bothForms` rules need no special case (both forms are stored anyway).
   * Without `defaults` this is exactly `set` / `unset`.
   */
  apply(
    context: readonly (readonly string[])[],
    line: readonly string[],
    negate: boolean,
    opts: { defaults?: DefaultSlots } = {},
  ): ConfigDelta | undefined {
    const defaults = opts.defaults;
    if (defaults === undefined) return negate ? this.unset(context, line) : this.set(context, line);
    return this.expanded(context, line, (ctx, norm) => this.applyOne(ctx, norm, negate, defaults));
  }

  /**
   * Run `fn` over every stored (context, line) pair a typed line stands for (VLAN lists: `vlan 10,20` is two
   * sections; a line typed under `vlan 10,20` applies to both). One pair returns its delta unchanged; several return
   * one delta for the typed line (without `before`) when any of them changed the tree.
   */
  private expanded(
    context: readonly (readonly string[])[],
    line: readonly string[],
    fn: (ctx: readonly (readonly string[])[], norm: readonly string[]) => ConfigDelta | undefined,
  ): ConfigDelta | undefined {
    if (line.length === 0 || line[0] === '') return undefined;
    const contexts = expandVlanListContext(context, this.rules);
    let count = 0;
    const deltas: ConfigDelta[] = [];
    for (const ctx of contexts) {
      const norm = normalizeConfigLine(ctx, line, this.rules);
      for (const one of expandVlanListLine(ctx, norm, this.rules)) {
        count++;
        const d = fn(ctx, one);
        if (d !== undefined) deltas.push(d);
      }
    }
    if (count === 1) return deltas[0];
    const first = deltas[0];
    if (first === undefined) return undefined;
    return { op: first.op, context: copyContext(context), line: normalizeConfigLine(context, line, this.rules) };
  }

  /** `set` of one normalized stored line (no VLAN list left in it or its context). */
  private setOne(context: readonly (readonly string[])[], norm: readonly string[]): ConfigDelta | undefined {
    const rule = this.rules.ruleFor(context, norm);
    const ctxNode = this.walk(context, true) as ConfigNode;
    const delta: ConfigDelta = { op: 'set', context: copyContext(context), line: norm.slice() };

    if (rule?.section !== undefined) {
      const args = norm.slice(1);
      for (const c of ctxNode.children) {
        if (c.key === norm[0] && sameArgs(c.args, args)) return undefined;
      }
      ctxNode.children.push({ key: norm[0] as string, args, children: [] });
      return delta;
    }

    const ident = ruleIdentity(rule, norm);
    const group = this.groupFor(rule, norm);
    const cancelled = (rule?.storeNegation === true || rule?.bothForms === true) && this.cancelNegation(ctxNode, norm, ident);

    if (isNegationDefaultLine(rule, norm)) {
      // `switchport` / `keepalive`: the default state — clear stored values of this rule only, store nothing
      const container = group === undefined ? ctxNode : this.findGroup(ctxNode, group, false);
      const removed = container === undefined ? [] : this.removeIdentity(container, norm, ident, group, { rule: rule as ConfigLineRule, context });
      if (container !== undefined && group !== undefined) this.dropEmptyGroup(ctxNode, container);
      if (!cancelled && removed.length === 0) return undefined;
      if (removed.length > 0) delta.before = removed[0] as string[];
      return delta;
    }

    const container = group === undefined ? ctxNode : (this.findGroup(ctxNode, group, true) as ConfigNode);
    const leafKey = (group === undefined ? norm[0] : norm[1]) as string;
    const leafArgs = norm.slice(group === undefined ? 1 : 2);
    const single = rule?.cardinality === 'single';
    for (const c of container.children) {
      const t = this.tokensOf(c, group);
      if (!prefixEqual(t, norm, ident)) continue;
      if (sameArgs(t, norm)) return cancelled ? delta : undefined;
      if (single && c.key === leafKey && this.identityOf(context, t) === ident) {
        delta.before = t.slice(ident);
        c.args = leafArgs;
        return delta;
      }
    }
    container.children.push({ key: leafKey, args: leafArgs, children: [] });
    return delta;
  }

  /** `unset` of one normalized stored line (no VLAN list left in it or its context). */
  private unsetOne(context: readonly (readonly string[])[], norm: readonly string[]): ConfigDelta | undefined {
    const rule = this.rules.ruleFor(context, norm);
    const ident = ruleIdentity(rule, norm);

    if (isNegationDefaultLine(rule, norm) && norm[0] !== NO_KEY) {
      // stored negation: remove positives of this identity, persist `no <identity>`. The head of a family
      // (`switchport`, a rule naming exactly its one line) removes the whole family below it; any other rule
      // (`keepalive`, `spanning-tree vlan <v>`) removes only its own values.
      const ctxNode = this.walk(context, true) as ConfigNode;
      const group = this.groupFor(rule, norm);
      const container = group === undefined ? ctxNode : this.findGroup(ctxNode, group, false);
      const r = rule as ConfigLineRule;
      const familyHead = r.pattern.length === r.identity && r.pattern.every((el) => !(el.startsWith('<') && el.endsWith('>')));
      const removed = container === undefined ? [] : this.removeIdentity(container, norm, ident, group, familyHead ? undefined : { rule: r, context });
      if (container !== undefined && group !== undefined) this.dropEmptyGroup(ctxNode, container);
      const negated = norm.slice(0, ident);
      const exists = ctxNode.children.some((c) => c.key === NO_KEY && sameArgs(c.args, negated));
      if (!exists) ctxNode.children.push({ key: NO_KEY, args: negated, children: [] });
      if (exists && removed.length === 0) return undefined;
      const delta: ConfigDelta = { op: 'unset', context: copyContext(context), line: norm.slice() };
      if (removed.length > 0) delta.before = removed[0] as string[];
      return delta;
    }

    if (rule?.bothForms === true && rule.section === undefined) return this.unsetBothForms(context, rule, norm, ident);

    const ctxNode = this.walk(context, false);
    if (!ctxNode) return undefined;

    if (rule?.section !== undefined) {
      const args = norm.slice(1);
      const idx = ctxNode.children.findIndex((c) => c.key === norm[0] && sameArgs(c.args, args));
      if (idx === -1) return undefined;
      ctxNode.children.splice(idx, 1);
      return { op: 'unset', context: copyContext(context), line: norm.slice(), before: norm.slice(ident) };
    }

    const group = this.groupFor(rule, norm);
    const container = group === undefined ? ctxNode : this.findGroup(ctxNode, group, false);
    if (!container) return undefined;

    // With value args: remove the one node whose tokens match exactly. Identity only: remove the
    // single-valued node of this identity (a node whose own rule has the same identity length), or every
    // node of a multi-valued identity.
    const withArgs = norm.length > ident;
    const removeAll = !withArgs && rule?.cardinality !== 'single';
    let before: string[] | undefined;
    const kept: ConfigNode[] = [];
    for (const c of container.children) {
      const t = this.tokensOf(c, group);
      const matches =
        prefixEqual(t, norm, ident) && (withArgs ? sameArgs(t, norm) : removeAll || this.identityOf(context, t) === ident);
      if (matches && (before === undefined || removeAll)) {
        if (before === undefined) before = t.slice(ident);
        continue;
      }
      kept.push(c);
    }
    if (before === undefined) return undefined;
    container.children.splice(0, container.children.length, ...kept);
    if (group !== undefined) this.dropEmptyGroup(ctxNode, container);
    return { op: 'unset', context: copyContext(context), line: norm.slice(), before };
  }

  /** `no` form of a `bothForms` rule: remove the positive line(s) of the identity and store `no <identity>`. */
  private unsetBothForms(
    context: readonly (readonly string[])[],
    rule: ConfigLineRule,
    norm: readonly string[],
    ident: number,
  ): ConfigDelta | undefined {
    const ctxNode = this.walk(context, true) as ConfigNode;
    const group = this.groupFor(rule, norm);
    const container = group === undefined ? ctxNode : this.findGroup(ctxNode, group, false);
    const removed = container === undefined ? [] : this.removeIdentity(container, norm, ident, group, { rule, context });
    if (container !== undefined && group !== undefined) this.dropEmptyGroup(ctxNode, container);
    const negated = norm.slice(0, ident);
    const exists = ctxNode.children.some((c) => c.key === NO_KEY && sameArgs(c.args, negated));
    if (!exists) ctxNode.children.push({ key: NO_KEY, args: negated, children: [] });
    if (exists && removed.length === 0) return undefined;
    const delta: ConfigDelta = { op: 'unset', context: copyContext(context), line: norm.slice() };
    if (removed.length > 0) delta.before = removed[0] as string[];
    return delta;
  }

  /** One stored line through the completeness rule (see `apply`). */
  private applyOne(
    context: readonly (readonly string[])[],
    norm: readonly string[],
    negate: boolean,
    defaults: DefaultSlots,
  ): ConfigDelta | undefined {
    const rule = this.rules.ruleFor(context, norm);
    if (rule === undefined || rule.section !== undefined || rule.bothForms === true) {
      return negate ? this.unsetOne(context, norm) : this.setOne(context, norm);
    }
    const ident = ruleIdentity(rule, norm);
    const identity = norm.slice(0, ident);
    const def = defaults.get(slotKeyOf(context, norm, this.rules));

    if (negate && rule.negationRestoresDefault === true) {
      // (2) `no spanning-tree mode`: the device's default line, or an empty slot when the slot has none
      if (def !== undefined && def[0] !== NO_KEY) return this.setOne(context, def);
      return this.unsetOne(context, identity);
    }
    if (def === undefined) return negate ? this.unsetOne(context, norm) : this.setOne(context, norm);

    if (rule.storeNegation === true) {
      const defIsDefaultState = sameArgs(def, identity);
      if (!negate && isNegationDefaultLine(rule, norm)) {
        // (1) `switchport` where D fills the slot otherwise (`no switchport`): store the default line itself
        return defIsDefaultState ? this.setOne(context, norm) : this.storeDefaultLine(context, rule, identity, ident);
      }
      if (negate && !isNegationDefaultLine(rule, norm)) {
        // (1) `no keepalive 10` back to the default state where D holds another value: store `keepalive`
        const d = this.unsetOne(context, norm);
        if (d === undefined || defIsDefaultState) return d;
        if (!this.slotHasValue(context, rule, norm, ident) && !this.hasNegation(context, identity)) {
          this.storeDefaultLine(context, rule, identity, ident);
        }
        return d;
      }
      return negate ? this.unsetOne(context, norm) : this.setOne(context, norm);
    }

    const negArgs = rule.cardinality === 'multi' ? norm.slice() : identity;
    if (!negate) {
      // a positive line of a default slot cancels an explicit negation stored by (1)
      const ctxNode = this.walk(context, false);
      const cancelled = ctxNode !== undefined && this.cancelNegation(ctxNode, norm, ident);
      const d = this.setOne(context, norm);
      if (d === undefined && cancelled) return { op: 'set', context: copyContext(context), line: norm.slice() };
      return d;
    }
    // (1) `no ip address`, `no capwap enable` where D holds a value: store `no <identity>` once the slot is empty
    const d = this.unsetOne(context, norm);
    if (def[0] === NO_KEY || this.slotHasValue(context, rule, norm, ident)) return d;
    if (this.hasNegation(context, negArgs)) return d;
    const ctxNode = this.walk(context, true) as ConfigNode;
    ctxNode.children.push({ key: NO_KEY, args: negArgs, children: [] });
    return d ?? { op: 'unset', context: copyContext(context), line: norm.slice() };
  }

  /**
   * Store the identity-only line of a stored-negation rule explicitly (`switchport`): cancel its stored negation and
   * any other value of its own rule, then keep the line itself.
   */
  private storeDefaultLine(
    context: readonly (readonly string[])[],
    rule: ConfigLineRule,
    identity: readonly string[],
    ident: number,
  ): ConfigDelta | undefined {
    const ctxNode = this.walk(context, true) as ConfigNode;
    const cancelled = this.cancelNegation(ctxNode, identity, ident);
    const group = this.groupFor(rule, identity);
    const container = group === undefined ? ctxNode : (this.findGroup(ctxNode, group, true) as ConfigNode);
    const kept: ConfigNode[] = [];
    let before: string[] | undefined;
    let exists = false;
    for (const c of container.children) {
      const t = this.tokensOf(c, group);
      if (c.key !== NO_KEY && prefixEqual(t, identity, ident) && this.rules.ruleFor(context, t) === rule) {
        if (sameArgs(t, identity)) {
          exists = true;
          kept.push(c);
          continue;
        }
        if (before === undefined) before = t.slice(ident);
        continue;
      }
      kept.push(c);
    }
    container.children.splice(0, container.children.length, ...kept);
    if (!exists) {
      container.children.push({ key: (group === undefined ? identity[0] : identity[1]) as string, args: identity.slice(group === undefined ? 1 : 2), children: [] });
    }
    if (exists && !cancelled && before === undefined) return undefined;
    const delta: ConfigDelta = { op: 'set', context: copyContext(context), line: identity.slice() };
    if (before !== undefined) delta.before = before;
    return delta;
  }

  render(): string {
    const out: string[] = [CONFIG_HEADER_COMMENT, CONFIG_VERSION_LINE, '!'];
    const entries: RenderEntry[] = [];
    let seq = 0;
    for (const node of this.root.children) {
      if (SYNTHETIC_KEYS.has(node.key)) continue;
      if (this.groups.has(node.key) && node.args.length === 0) {
        for (const leaf of node.children) {
          const tokens = [node.key, leaf.key, ...leaf.args];
          const rule = this.rules.ruleFor([], tokens);
          const lines = [leafLine('', `${node.key} ${leaf.key}`, leaf.args)];
          for (const grand of leaf.children) nodeLines(grand, 1, lines, [tokens], this.rules, this.groups);
          entries.push({ slot: renderSlotOf(rule), order: rule?.order ?? 0, seq: seq++, tailKey: node.key, separator: false, lines });
        }
        continue;
      }
      const rule = this.rules.ruleFor([], [node.key, ...node.args]);
      const lines: string[] = [];
      nodeLines(node, 0, lines, [], this.rules, this.groups);
      entries.push({
        slot: renderSlotOf(rule),
        order: rule?.order ?? 0,
        seq: seq++,
        tailKey: node.key,
        separator: rule?.section?.separator === true,
        lines,
      });
    }

    const block = (lines: readonly string[]): void => {
      if (lines.length === 0) return;
      out.push(...lines, '!');
    };
    const emitBlocks = (list: readonly RenderEntry[]): void => {
      let current: string[] = [];
      for (const e of list) {
        if (e.separator) {
          block(current);
          current = [];
          block(e.lines);
        } else {
          current.push(...e.lines);
        }
      }
      block(current);
    };

    for (const slot of CONFIG_RENDER_SLOTS) {
      const list = entries.filter((e) => e.slot === slot).sort((a, b) => a.order - b.order || a.seq - b.seq);
      if (slot !== 'tail') {
        emitBlocks(list);
        continue;
      }
      // unknown keys: grouped by key in first-appearance order, one block per key
      const keys: string[] = [];
      for (const e of list) if (!keys.includes(e.tailKey)) keys.push(e.tailKey);
      for (const key of keys) emitBlocks(list.filter((e) => e.tailKey === key));
    }

    out.push('end');
    return out.join('\n') + '\n';
  }

  renderFiltered(filter: { kind: 'section' | 'include' | 'exclude' | 'begin'; pattern: string }): string {
    const lines = renderedLines(this.render());
    const re = compilePattern(filter.pattern);
    let kept: string[];
    switch (filter.kind) {
      case 'include':
        kept = lines.filter((l) => re.test(l));
        break;
      case 'exclude':
        kept = lines.filter((l) => !re.test(l));
        break;
      case 'begin': {
        const idx = lines.findIndex((l) => re.test(l));
        kept = idx === -1 ? [] : lines.slice(idx);
        break;
      }
      case 'section': {
        kept = [];
        let keeping = false;
        for (const l of lines) {
          const isChild = l.startsWith(' ');
          if (!isChild) keeping = isContentLine(l) && re.test(l);
          if (keeping) kept.push(l);
        }
        break;
      }
    }
    return kept.join('\n');
  }

  clone(): ConfigAst {
    return new ConfigAstImpl(cloneNode(this.root), this.rules);
  }

  diff(other: ConfigAst): ConfigDiff {
    const entries = (ast: ConfigAst): { key: string; line: string }[] => {
      const result: { key: string; line: string }[] = [];
      let header = '';
      for (const line of renderedLines(ast.render())) {
        if (!isContentLine(line)) continue;
        if (line.startsWith(' ')) {
          result.push({ key: `${header} ${line}`, line });
        } else {
          header = line;
          result.push({ key: line, line });
        }
      }
      return result;
    };
    const mine = entries(this);
    const theirs = entries(other);
    const count = (list: { key: string }[]): Map<string, number> => {
      const m = new Map<string, number>();
      for (const e of list) m.set(e.key, (m.get(e.key) ?? 0) + 1);
      return m;
    };
    const leftover = (list: { key: string; line: string }[], pool: Map<string, number>): string[] => {
      const res: string[] = [];
      for (const e of list) {
        const n = pool.get(e.key) ?? 0;
        if (n > 0) pool.set(e.key, n - 1);
        else res.push(e.line);
      }
      return res;
    };
    return { added: leftover(theirs, count(mine)), removed: leftover(mine, count(theirs)) };
  }

  /**
   * Changes that turn `this` into `other`. Applying them in order with `set`/`unset` (or through
   * `DeviceRuntime.applyConfigLine`, whose global-negation fallback never triggers because every
   * recorded `unset` changes the tree) reproduces `other`'s rendered text and tree.
   *
   * Per storage list (a context's children, or a group's leaves) the longest prefix of `other`'s
   * entries that appears in order in `this` is kept; a single-valued line whose identity is kept but
   * whose value differs is replaced in place (one `set`, so processes see one delta with `before`).
   * The rest of `this` is removed and the rest of `other` appended, and kept sections recurse.
   * Stored negations of `storeNegation` rules are added with `unset <line>` and removed with
   * `set <line>`; other `no …` nodes (P0 global negations) move as raw `no …` lines. The changes are
   * verified against a working copy; when an unusual tree cannot be reproduced incrementally, the
   * result falls back to removing every top-level entry of `this` and adding every entry of `other`.
   */
  diffTree(other: ConfigAst): ConfigTreeChange[] {
    const target = JSON.stringify(other.toJSON());
    const work = this.clone();
    const rec = new ChangeRecorder(work);
    this.diffList(rec, [], this.root.children, other.root.children, undefined);
    if (JSON.stringify(work.toJSON()) === target) return rec.changes;

    const fresh = this.clone();
    const rebuild = new ChangeRecorder(fresh);
    const mine = this.entriesOf(this.root.children, undefined);
    for (const e of mine) if (e.kind === 'neg') this.removeEntry(rebuild, [], e);
    for (const e of mine) if (e.kind !== 'neg') this.removeEntry(rebuild, [], e);
    for (const e of this.entriesOf(other.root.children, undefined)) this.addEntry(rebuild, [], e);
    return rebuild.changes;
  }

  toJSON(): ConfigNode {
    return cloneNode(this.root);
  }

  // ── diffTree internals ──

  /** Comparable entries of a storage list (`group` set for the leaves of a group node). */
  private entriesOf(list: readonly ConfigNode[], group: string | undefined): DiffEntry[] {
    return list.map((node): DiffEntry => {
      if (group !== undefined) {
        const tokens = [group, node.key, ...node.args];
        return { kind: 'line', key: `L ${tokens.join(' ')}`, tokens, node };
      }
      if (this.groups.has(node.key) && node.args.length === 0) {
        return { kind: 'group', key: `G ${node.key}`, tokens: [node.key], node };
      }
      if (node.key === NO_KEY && node.args.length > 0) {
        return { kind: 'neg', key: `N ${node.args.join(' ')}`, tokens: node.args.slice(), node };
      }
      const tokens = [node.key, ...node.args];
      return { kind: 'line', key: `L ${tokens.join(' ')}`, tokens, node };
    });
  }

  /** A plain single-valued, non-section line that a `set` replaces in place. */
  private isReplaceable(context: readonly (readonly string[])[], e: DiffEntry): boolean {
    if (e.kind !== 'line') return false;
    const rule = this.rules.ruleFor(context, e.tokens);
    return rule !== undefined && rule.section === undefined && rule.cardinality === 'single' && !isNegationDefaultLine(rule, e.tokens);
  }

  /** Same rule and identity tokens (for replacement detection). */
  private sameIdentity(context: readonly (readonly string[])[], a: DiffEntry, b: DiffEntry): boolean {
    if (a.kind !== 'line' || b.kind !== 'line') return false;
    const rule = this.rules.ruleFor(context, b.tokens);
    if (rule === undefined || this.rules.ruleFor(context, a.tokens) !== rule) return false;
    return prefixEqual(a.tokens, b.tokens, ruleIdentity(rule, b.tokens));
  }

  /** Emit the changes removing entry `e` from `context`. */
  private removeEntry(rec: ChangeRecorder, context: readonly (readonly string[])[], e: DiffEntry): void {
    if (e.kind === 'neg') {
      if (isNegationDefaultLine(this.rules.ruleFor(context, e.tokens), e.tokens)) rec.set(context, e.tokens);
      else rec.unset(context, [NO_KEY, ...e.tokens]);
      return;
    }
    if (e.kind === 'group') {
      for (const leaf of e.node.children.slice()) rec.unset(context, [e.tokens[0] as string, leaf.key, ...leaf.args]);
      return;
    }
    rec.unset(context, e.tokens);
  }

  /** Emit the changes adding entry `e` (and its subtree) under `context`. */
  private addEntry(rec: ChangeRecorder, context: readonly (readonly string[])[], e: DiffEntry): void {
    if (e.kind === 'neg') {
      if (isNegationDefaultLine(this.rules.ruleFor(context, e.tokens), e.tokens)) rec.unset(context, e.tokens);
      else rec.set(context, [NO_KEY, ...e.tokens]);
      return;
    }
    if (e.kind === 'group') {
      for (const leaf of this.entriesOf(e.node.children, e.tokens[0])) this.addEntry(rec, context, leaf);
      return;
    }
    rec.set(context, e.tokens);
    if (e.node.children.length === 0) return;
    const sub = [...context, e.tokens];
    for (const child of this.entriesOf(e.node.children, undefined)) this.addEntry(rec, sub, child);
  }

  /** Diff one storage list of `this` (`tList`) against the matching list of the target (`oList`). */
  private diffList(
    rec: ChangeRecorder,
    context: readonly (readonly string[])[],
    tList: readonly ConfigNode[],
    oList: readonly ConfigNode[],
    group: string | undefined,
  ): void {
    const eT = this.entriesOf(tList, group);
    const eO = this.entriesOf(oList, group);
    const kept = new Set<number>();
    const pairs: { t: DiffEntry; o: DiffEntry }[] = [];
    const replaced: { t: DiffEntry; o: DiffEntry }[] = [];
    let p = 0;
    let k = 0;
    for (; k < eO.length; k++) {
      const o = eO[k] as DiffEntry;
      let j = -1;
      for (let x = p; x < eT.length; x++) {
        if ((eT[x] as DiffEntry).key === o.key) {
          j = x;
          break;
        }
      }
      if (j !== -1) {
        kept.add(j);
        pairs.push({ t: eT[j] as DiffEntry, o });
        p = j + 1;
        continue;
      }
      if (this.isReplaceable(context, o)) {
        for (let x = p; x < eT.length; x++) {
          if (this.sameIdentity(context, eT[x] as DiffEntry, o)) {
            j = x;
            break;
          }
        }
        if (j !== -1) {
          kept.add(j);
          replaced.push({ t: eT[j] as DiffEntry, o });
          p = j + 1;
          continue;
        }
      }
      break;
    }
    const additions = eO.slice(k);
    const additionKeys = new Set(additions.map((a) => a.key));
    const negations: DiffEntry[] = [];
    const early: DiffEntry[] = [];
    const late: DiffEntry[] = [];
    eT.forEach((t, i) => {
      if (kept.has(i)) return;
      if (t.kind === 'neg') negations.push(t);
      else if (additionKeys.has(t.key) || additions.some((a) => this.isReplaceable(context, a) && this.sameIdentity(context, t, a))) early.push(t);
      else late.push(t);
    });

    for (const t of negations) this.removeEntry(rec, context, t);
    for (const t of early) this.removeEntry(rec, context, t);
    for (const { o } of replaced) rec.set(context, o.tokens);
    for (const o of additions) this.addEntry(rec, context, o);
    for (const t of late) this.removeEntry(rec, context, t);

    for (const { t, o } of [...pairs, ...replaced]) {
      if (t.kind === 'group') {
        this.diffList(rec, context, t.node.children, o.node.children, t.tokens[0]);
      } else if (t.kind === 'line' && (t.node.children.length > 0 || o.node.children.length > 0)) {
        this.diffList(rec, [...context, o.tokens], t.node.children, o.node.children, undefined);
      }
    }
  }
}

// ────────────────────────────────── factories ─────────────────────────────────

/** An empty configuration tree governed by `rules` (default: the built-in rule table). */
export function createConfigAst(rules: ConfigRuleSet = DEFAULT_CONFIG_RULES): ConfigAst {
  return new ConfigAstImpl(makeRoot(), rules);
}

/**
 * Rebuild an AST from a serialized root node (`toJSON()` output or a hand-built tree). The input is
 * deep-copied; the node's own key/args are ignored when it is a root (empty key), otherwise it
 * becomes the sole top-level child.
 */
export function configAstFromJson(node: ConfigNode, rules: ConfigRuleSet = DEFAULT_CONFIG_RULES): ConfigAst {
  const root = makeRoot();
  if (node.key === '') {
    for (const c of node.children) root.children.push(cloneNode(c));
  } else {
    root.children.push(cloneNode(node));
  }
  return new ConfigAstImpl(root, rules);
}

/**
 * Apply one `ConfigTreeChange` to `ast` with AST semantics (`set` or `unset`). Returns the delta, or
 * undefined for a no-op.
 */
export function applyConfigChange(ast: ConfigAst, change: ConfigTreeChange): ConfigDelta | undefined {
  return change.op === 'set' ? ast.set(change.context, change.line) : ast.unset(change.context, change.line);
}

/**
 * Parse configuration text (as produced by `render()`, a `.netforge` `configs/*.cfg`, or typed by a
 * user) into an AST, through the shared indentation walker (cli/config-text.ts).
 *
 * `no X` lines unset `X` under their context. A negation that changes nothing is kept as a `no …`
 * line at global level (e.g. `no ip domain-lookup`); in a sub-mode it is kept only when its rule has
 * `storeNegation` (`no switchport`), otherwise dropped (`no shutdown` is the default state).
 *
 * @since P2 With `opts.defaults` (the device's default slots, §5) every line goes through `apply` with them, so the
 * explicit forms the completeness rule stored (`no ip address` under an interface whose default line sets one) are
 * kept; a device parsing its saved configuration passes them. Without `defaults` parsing is exactly as before.
 */
export function parseConfigText(
  text: string,
  rules: ConfigRuleSet = DEFAULT_CONFIG_RULES,
  opts: { defaults?: DefaultSlots } = {},
): ConfigAst {
  const ast = createConfigAst(rules);
  const defaults = opts.defaults;
  for (const line of walkConfigText(text, rules)) {
    if (line.negate) {
      const delta = defaults === undefined ? ast.unset(line.context, line.tokens) : ast.apply(line.context, line.tokens, true, { defaults });
      if (delta === undefined && line.context.length === 0) ast.set(line.context, [NO_KEY, ...line.tokens]);
      continue;
    }
    if (defaults === undefined) ast.set(line.context, line.tokens);
    else ast.apply(line.context, line.tokens, false, { defaults });
  }
  return ast;
}

// ───────────────────────────── completeness rule (P2) ─────────────────────────────

/**
 * @since P2 (ARCHITECTURE-P2 §5) Slot key of a line under the rule table: the context path plus the rule's identity
 * tokens — the key the AST uses to decide what a later line replaces. A single-valued rule keys on its identity
 * (`ip address …` under one interface is one slot), a multi-valued rule, a section and a line without a rule key on
 * the whole line. A leading `no` is ignored, so a line and its negation share their slot (`no ip routing`).
 */
export function slotKeyOf(
  context: readonly (readonly string[])[],
  line: readonly string[],
  rules: ConfigRuleSet = DEFAULT_CONFIG_RULES,
): string {
  const tokens = line.length > 1 && line[0] === NO_KEY ? line.slice(1) : line;
  const norm = normalizeConfigLine(context, tokens, rules);
  const r = rules.ruleFor(context, norm);
  const whole = r === undefined || r.section !== undefined || r.cardinality === 'multi';
  const identity = whole ? norm : norm.slice(0, ruleIdentity(r, norm));
  return JSON.stringify([context, identity]);
}

/**
 * @since P2 (ARCHITECTURE-P2 §5, D2) The default slots of a device: slot key → the default line, from the tree of its
 * default lines D (defaultConfig + profileConfig), computed once per boot by the runtime. A stored negation of D is
 * recorded as `['no', …]`; section lines are containers, not slots (their children are recorded under them).
 */
export function defaultSlotsOf(defaults: ConfigAst, rules: ConfigRuleSet = DEFAULT_CONFIG_RULES): DefaultSlots {
  const out = new Map<string, readonly string[]>();
  const groups = groupKeysOf(rules);
  const visit = (context: readonly (readonly string[])[], nodes: readonly ConfigNode[]): void => {
    for (const node of nodes) {
      if (groups.has(node.key) && node.args.length === 0) {
        for (const leaf of node.children) {
          const tokens = [node.key, leaf.key, ...leaf.args];
          out.set(slotKeyOf(context, tokens, rules), tokens);
          visit([...context, tokens], leaf.children);
        }
        continue;
      }
      if (node.key === NO_KEY && node.args.length > 0) {
        out.set(slotKeyOf(context, node.args, rules), [NO_KEY, ...node.args]);
        continue;
      }
      const tokens = [node.key, ...node.args];
      if (rules.ruleFor(context, tokens)?.section === undefined) out.set(slotKeyOf(context, tokens, rules), tokens);
      visit([...context, tokens], node.children);
    }
  };
  visit([], defaults.root.children);
  return out;
}
