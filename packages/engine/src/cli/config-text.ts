/**
 * Config text: the ONE indentation walker and the replay-line generator (ARCHITECTURE-P1 §3.12).
 *
 * `walkConfigText` turns configuration text (rendered running-config, a `.netforge` `configs/*.cfg`,
 * a pasted fragment, `configure({indentation})` input) into logical lines with their context stack:
 *  - blank lines and `!` comments are skipped; `end` and `version …` are skipped at depth 0;
 *  - the leading-space depth selects the context level: a line is a child of the nearest less
 *    indented non-negated line above it (any indentation width; a stray indented first line is global);
 *  - `no X` lines are negations (they never open a context);
 *  - `banner <type> <text>` keeps the whole text as one token so `^C` delimiters survive;
 *    every other line splits on whitespace.
 *
 * `configTextLinesOf` does the reverse walk over a stored tree and yields the lines a device must
 * apply (boot replay): group leaves as full `ip …` lines, stored `no …` nodes as negations at their
 * depth, sections followed by their children, and a section rule's `impliedDefault` when the
 * section lacks that child (an `interface` section without `shutdown` replays `no shutdown`).
 *
 * Pure functions, no state, no I/O.
 */
import type { ConfigNode, ConfigRuleSet, ConfigTextLine } from '../contracts/config.js';
import { DEFAULT_CONFIG_RULES, groupKeysOf, normalizeConfigLine } from './config-rules.js';

/**
 * Tokenize one config text line (already trimmed). `banner <type> <rest>` keeps the rest as a single
 * token; everything else splits on whitespace.
 */
export function tokenizeConfigLine(text: string): string[] {
  const m = /^banner\s+(\S+)\s+([\s\S]*)$/.exec(text);
  if (m) return ['banner', m[1] as string, m[2] as string];
  return text.split(/\s+/).filter((t) => t.length > 0);
}

/** True for text lines that carry no configuration at depth 0 (`end`, `version …`). */
function isDepthZeroNoise(trimmed: string): boolean {
  return trimmed === 'end' || trimmed === 'version' || trimmed.startsWith('version ');
}

/**
 * Walk configuration text into logical lines. Context entries are the normalized tokens of the
 * enclosing lines (`[['interface','GigabitEthernet0/0']]`, `[['ip','dhcp','pool','LAN']]`).
 * `depth` is the raw leading-whitespace count; `context.length` is the nesting level.
 */
export function walkConfigText(text: string, rules: ConfigRuleSet = DEFAULT_CONFIG_RULES): ConfigTextLine[] {
  const out: ConfigTextLine[] = [];
  // open parents: each entry remembers its own raw depth, so any indentation width nests correctly
  const stack: { depth: number; tokens: string[] }[] = [];
  const rawLines = text.split('\n');
  for (let i = 0; i < rawLines.length; i++) {
    const raw = (rawLines[i] as string).replace(/\r$/, '').replace(/\s+$/, '');
    const trimmed = raw.trimStart();
    if (trimmed === '' || trimmed.startsWith('!')) continue;
    const depth = raw.length - trimmed.length;
    if (depth === 0 && isDepthZeroNoise(trimmed)) continue;
    while (stack.length > 0 && (stack[stack.length - 1] as { depth: number }).depth >= depth) stack.pop();
    const tokens = tokenizeConfigLine(trimmed);
    if (tokens.length === 0) continue;
    const context = stack.map((e) => e.tokens.slice());
    const negate = tokens[0] === 'no' && tokens.length > 1;
    const lineTokens = negate ? tokens.slice(1) : tokens;
    out.push({ lineNo: i + 1, depth, context, tokens: lineTokens, negate });
    if (!negate) stack.push({ depth, tokens: normalizeConfigLine(context, tokens, rules) });
  }
  return out;
}

/** Does `node` (a child of a section) carry the identity tokens `line`? Stored `no …` nodes count. */
function childCarries(node: ConfigNode, line: readonly string[], groups: ReadonlySet<string>): boolean {
  const candidates: string[][] = [];
  if (node.key === 'no') candidates.push(node.args);
  else if (groups.has(node.key) && node.args.length === 0) {
    for (const leaf of node.children) candidates.push([node.key, leaf.key, ...leaf.args]);
  } else candidates.push([node.key, ...node.args]);
  return candidates.some((tokens) => line.every((t, i) => tokens[i] === t));
}

/**
 * Replay lines for a stored tree (children of `root`), in stored order, ready for
 * `DeviceRuntime.applyConfigLine(context, tokens, negate)`. `lineNo` numbers the output (1-based);
 * `depth` equals the context length.
 */
export function configTextLinesOf(root: ConfigNode, rules: ConfigRuleSet = DEFAULT_CONFIG_RULES): ConfigTextLine[] {
  const out: ConfigTextLine[] = [];
  const groups = groupKeysOf(rules);
  const push = (context: readonly (readonly string[])[], tokens: readonly string[], negate: boolean): void => {
    out.push({
      lineNo: out.length + 1,
      depth: context.length,
      context: context.map((e) => e.slice()),
      tokens: tokens.slice(),
      negate,
    });
  };
  const emit = (context: readonly (readonly string[])[], node: ConfigNode): void => {
    if (groups.has(node.key) && node.args.length === 0) {
      for (const leaf of node.children) {
        const tokens = [node.key, leaf.key, ...leaf.args];
        push(context, tokens, false);
        const sub = [...context, tokens];
        for (const grand of leaf.children) emit(sub, grand);
      }
      return;
    }
    if (node.key === 'no' && node.args.length > 0) {
      push(context, node.args, true);
      return;
    }
    const tokens = [node.key, ...node.args];
    push(context, tokens, false);
    const sub = [...context, tokens];
    for (const child of node.children) emit(sub, child);
    const implied = rules.ruleFor(context, tokens)?.impliedDefault;
    if (implied !== undefined && !node.children.some((c) => childCarries(c, implied.line, groups))) {
      push(sub, implied.line, implied.negated);
    }
  };
  for (const node of root.children) emit([], node);
  return out;
}
