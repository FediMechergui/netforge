/**
 * [S28] YANG browser model (ARCHITECTURE-P3C D10 "[S28]", §6, §7 W1b web-concept (b)): pure, DOM-free functions
 * behind the concept tool `concept:yang`.
 *
 * The browser is web-only and reads the one YANG model the devices serve, `automation/yang/model.ts` (through
 * `@netforge/engine/pure`), so it never shows a node a device would refuse: the same table drives RESTCONF GET and
 * writes. Nothing here adds a node, a module or a line; every figure is read from the engine's table.
 *
 * - `yangBrowserRoots` / `yangBrowserChildren` walk the tree (the data nodes, then the operations); `visibleYangRows`
 *   flattens it for a given set of open nodes and an optional search, keeping each match's ancestors.
 * - `yangNodeDetail` is what the detail pane shows for one node: its module, kind, type facts, whether it is
 *   configuration or state, the RESTCONF address that reads it (with sample keys), the CLI lines that store, remove or
 *   run it (filled with the model's example values) and an RFC 7951 sample of its value.
 * - `yangTreeDiagram` writes the model in the tree-diagram notation of RFC 8340 (`+--rw`, `+--ro`, `+---x`, `*` for a
 *   list, `?` for an optional leaf).
 *
 * Modules are the IETF/IANA ones and the original `nf-native` only (rule 6: IETF YANG only). Wording is original.
 */
import { YANG_MODULES, fillYangLine, formatApiPath, yangChildren, yangExampleValues, yangMemberName, yangNode, yangNodes, yangOperations, yangTopNodes } from '@netforge/engine/pure';
import type { YangModule, YangNode } from '@netforge/engine/pure';

// ── the tree ─────────────────────────────────────────────────────────────────

/** The roots of the browser tree: the top-level data nodes in schema order, then the operations. */
export function yangBrowserRoots(): readonly YangNode[] {
  return [...yangTopNodes(), ...yangOperations()];
}

/** The children of a node in the browser tree (schema order). */
export function yangBrowserChildren(path: string): readonly YangNode[] {
  const node = yangNode(path);
  return node === undefined ? [] : yangChildren(node);
}

/** Whether a node is configuration, state or an operation. */
export type YangAccess = 'config' | 'state' | 'operation';

export function yangAccess(node: YangNode): YangAccess {
  if (node.kind === 'rpc') return 'operation';
  return node.config ? 'config' : 'state';
}

/** One row of the browser tree. */
export interface YangTreeRow {
  readonly path: string;
  /** The RFC 7951 member name (`ietf-interfaces:interfaces`, `ietf-ip:ipv4`, `name`). */
  readonly label: string;
  readonly kind: YangNode['kind'];
  readonly access: YangAccess;
  /** 0 for a root. */
  readonly depth: number;
  readonly hasChildren: boolean;
  /** Whether the row's children are shown (always true while a search is active and a descendant matches). */
  readonly open: boolean;
  /** With a search: whether this row matches it itself (false for an ancestor kept to show the way). */
  readonly match: boolean;
  /** A short type summary for leaves (`string`, `uint16 (1..4094)`), the keys of a list (`[name]`), or empty. */
  readonly summary: string;
}

/** Whether `node` matches the search text (its name, path or description, case-insensitive). */
export function yangNodeMatches(node: YangNode, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (q === '') return true;
  return node.name.toLowerCase().includes(q) || node.path.toLowerCase().includes(q) || node.description.toLowerCase().includes(q);
}

/** A short summary of a node for its tree row. */
export function yangRowSummary(node: YangNode): string {
  if (node.kind === 'list') return `[${(node.keys ?? []).join(' ')}]`;
  if (node.kind !== 'leaf') return '';
  return `${node.type ?? ''}${node.range !== undefined ? ` (${node.range[0]}..${node.range[1]})` : ''}`;
}

/**
 * The rows of the tree as shown: each root, then the children of every open node, depth first. With a non-empty
 * `query`, only the matching nodes and their ancestors are shown, and every ancestor of a match is open.
 */
export function visibleYangRows(open: ReadonlySet<string>, query = ''): YangTreeRow[] {
  const searching = query.trim() !== '';
  const keep = new Set<string>();
  const matched = new Set<string>();
  if (searching) {
    for (const n of yangNodes()) {
      if (!yangNodeMatches(n, query)) continue;
      matched.add(n.path);
      for (let p: YangNode | undefined = n; p !== undefined; p = p.parent !== undefined ? yangNode(p.parent) : undefined) keep.add(p.path);
    }
  }
  const out: YangTreeRow[] = [];
  const visit = (node: YangNode, depth: number): void => {
    if (searching && !keep.has(node.path)) return;
    const kids = yangChildren(node);
    const showKids = kids.length > 0 && (searching ? kids.some((k) => keep.has(k.path)) : open.has(node.path));
    out.push({
      path: node.path,
      label: yangMemberName(node),
      kind: node.kind,
      access: yangAccess(node),
      depth,
      hasChildren: kids.length > 0,
      open: showKids,
      match: !searching || matched.has(node.path),
      summary: yangRowSummary(node),
    });
    if (showKids) for (const k of kids) visit(k, depth + 1);
  };
  for (const r of yangBrowserRoots()) visit(r, 0);
  return out;
}

/** Every node that has children (to open the whole tree at once). */
export function yangBranchPaths(): string[] {
  return yangNodes().filter((n) => n.children.length > 0).map((n) => n.path);
}

// ── the detail pane ──────────────────────────────────────────────────────────

/**
 * Sample key values for the lists whose model entry carries no example (state lists): the RESTCONF address of a node
 * inside a list must name one entry. Keyed by the list's schema path, in key order.
 */
const SAMPLE_KEYS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  'ietf-interfaces:interfaces-state/interface': ['GigabitEthernet0/1'],
  'ietf-interfaces:interfaces-state/interface/ietf-ip:ipv4/address': ['10.0.99.11'],
  'ietf-yang-library:modules-state/module': ['ietf-interfaces', '2018-02-20'],
});

/** The key values the sample address uses for a list: the model's examples first, then `SAMPLE_KEYS`. */
export function yangSampleKeys(list: YangNode): readonly string[] {
  const keys = list.keys ?? [];
  const values = yangExampleValues(list);
  if (keys.every((k) => Object.prototype.hasOwnProperty.call(values, k))) return keys.map((k) => values[k] as string);
  return SAMPLE_KEYS[list.path] ?? keys.map((k) => `<${k}>`);
}

/** The node and its ancestors, root first. */
export function yangAncestry(node: YangNode): YangNode[] {
  const chain: YangNode[] = [];
  for (let n: YangNode | undefined = node; n !== undefined; n = n.parent !== undefined ? yangNode(n.parent) : undefined) chain.unshift(n);
  return chain;
}

/**
 * The RESTCONF request that reads a data node (`GET /restconf/data/…`, with sample keys on every list step, the node's
 * own list step included) or runs an operation (`POST /restconf/operations/<module>:<name>`).
 */
export function yangRestconfRequest(node: YangNode): { readonly method: 'GET' | 'POST'; readonly url: string } {
  if (node.kind === 'rpc') return { method: 'POST', url: `/restconf/operations/${node.module}:${node.name}` };
  const chain = yangAncestry(node);
  const segs = chain.map((n, i) => {
    const prev = i > 0 ? chain[i - 1] : undefined;
    return {
      ...(prev === undefined || prev.module !== n.module ? { module: n.module } : {}),
      name: n.name,
      ...(n.kind === 'list' ? { keys: yangSampleKeys(n) } : {}),
    };
  });
  return { method: 'GET', url: `/restconf/data${formatApiPath(segs)}` };
}

/** One set of CLI lines a node maps to, filled with the model's example values. */
export interface YangSampleLines {
  readonly op: 'set' | 'unset' | 'exec';
  readonly when?: 'true' | 'false';
  /** What the lines do, in a few words. */
  readonly caption: string;
  /** The lines as pasted in configuration mode (sub-mode lines indented by one space). */
  readonly lines: readonly string[];
}

const OP_CAPTION: Readonly<Record<YangSampleLines['op'], string>> = Object.freeze({
  set: 'Writing it',
  unset: 'Removing it',
  exec: 'Running it',
});

/** The CLI lines of a node, filled with the example values of the node and its ancestors. */
export function yangSampleLines(node: YangNode): YangSampleLines[] {
  const values = yangExampleValues(node);
  return (node.lines ?? []).map((t) => ({
    op: t.op,
    ...(t.when !== undefined ? { when: t.when } : {}),
    caption: t.when !== undefined ? `${OP_CAPTION[t.op]} as ${t.when}` : OP_CAPTION[t.op],
    lines: t.lines.map((l) => fillYangLine(l.text, values)),
  }));
}

const NUMERIC_TYPES: ReadonlySet<string> = new Set(['uint8', 'uint16']);

/** An RFC 7951 sample of a leaf's value (`{ "hostname": "SW1" }`), from the model's example; undefined otherwise. */
export function yangSampleJson(node: YangNode): string | undefined {
  if (node.kind !== 'leaf') return undefined;
  const value = yangExampleValues(node)[node.name] ?? node.default;
  if (value === undefined) return undefined;
  const json =
    NUMERIC_TYPES.has(node.type ?? '') && /^\d+$/.test(value)
      ? value
      : node.type === 'boolean' && (value === 'true' || value === 'false')
        ? value
        : JSON.stringify(value);
  return `{ ${JSON.stringify(yangMemberName(node))}: ${json} }`;
}

const KIND_TEXT: Readonly<Record<YangNode['kind'], string>> = Object.freeze({
  container: 'Container: groups other nodes',
  list: 'List: a set of entries, each named by its key',
  leaf: 'Leaf: holds one value',
  rpc: 'Operation: an action the device runs',
});

const ACCESS_TEXT: Readonly<Record<YangAccess, string>> = Object.freeze({
  config: 'Configuration (config true): read it, and write it with PUT, PATCH, POST or DELETE where the device allows',
  state: 'State (config false): read-only, reports what the device is doing now',
  operation: 'Operation: started with POST, it reads and stores no data',
});

/** Everything the detail pane shows for one node. */
export interface YangNodeDetail {
  readonly path: string;
  readonly label: string;
  readonly kind: YangNode['kind'];
  readonly kindText: string;
  readonly access: YangAccess;
  readonly accessText: string;
  readonly module: YangModule;
  readonly description: string;
  /** Root first, the node last. */
  readonly breadcrumb: readonly { readonly path: string; readonly label: string }[];
  /** Label/value pairs: type, range, values, base, default, units, keys (only those the node has). */
  readonly facts: readonly (readonly [string, string])[];
  readonly request: { readonly method: 'GET' | 'POST'; readonly url: string };
  readonly samples: readonly YangSampleLines[];
  readonly sampleJson?: string;
  readonly children: readonly { readonly path: string; readonly label: string }[];
}

/** The detail of the node at `path`, or undefined for a path the model does not have. */
export function yangNodeDetail(path: string): YangNodeDetail | undefined {
  const node = yangNode(path);
  if (node === undefined) return undefined;
  const module = YANG_MODULES.find((m) => m.name === node.module) as YangModule;
  const facts: [string, string][] = [];
  if (node.type !== undefined) facts.push(['Type', node.type]);
  if (node.range !== undefined) facts.push(['Range', `${node.range[0]} to ${node.range[1]}`]);
  if (node.enums !== undefined) facts.push(['Values', node.enums.join(', ')]);
  if (node.base !== undefined) facts.push(['Identity base', node.base]);
  if (node.default !== undefined) facts.push(['Default', node.default]);
  if (node.units !== undefined) facts.push(['Units', node.units]);
  if (node.keys !== undefined) facts.push(['Keys', node.keys.join(', ')]);
  const access = yangAccess(node);
  const sampleJson = yangSampleJson(node);
  return {
    path: node.path,
    label: yangMemberName(node),
    kind: node.kind,
    kindText: KIND_TEXT[node.kind],
    access,
    accessText: ACCESS_TEXT[access],
    module,
    description: node.description,
    breadcrumb: yangAncestry(node).map((n) => ({ path: n.path, label: yangMemberName(n) })),
    facts,
    request: yangRestconfRequest(node),
    samples: yangSampleLines(node),
    ...(sampleJson !== undefined ? { sampleJson } : {}),
    children: yangChildren(node).map((c) => ({ path: c.path, label: yangMemberName(c) })),
  };
}

// ── the tree diagram (RFC 8340 notation) ─────────────────────────────────────

/** One line of the tree diagram for `node`, without its indentation. */
export function yangTreeLine(node: YangNode): string {
  const flags = node.kind === 'rpc' ? '-x' : node.config ? 'rw' : 'ro';
  const parent = node.parent !== undefined ? yangNode(node.parent) : undefined;
  const isKey = parent?.kind === 'list' && (parent.keys ?? []).includes(node.name);
  // RFC 8340: names are written bare, and with the module's prefix where the module changes (`ip:ipv4`)
  const prefix = parent !== undefined && parent.module !== node.module ? YANG_MODULES.find((m) => m.name === node.module)?.prefix : undefined;
  const name = prefix !== undefined ? `${prefix}:${node.name}` : node.name;
  if (node.kind === 'list') return `+--${flags} ${name}* [${(node.keys ?? []).join(' ')}]`;
  if (node.kind === 'leaf') return `+--${flags} ${name}${isKey ? '' : '?'}   ${node.type ?? ''}`;
  return `+--${flags} ${name}`;
}

/** The whole model as an RFC 8340 tree diagram: one `module:` block per implemented module, then the operations. */
export function yangTreeDiagram(): string {
  const out: string[] = [];
  const walk = (node: YangNode, prefix: string, last: boolean): void => {
    out.push(`${prefix}${yangTreeLine(node)}`);
    const kids = yangChildren(node);
    kids.forEach((k, i) => walk(k, `${prefix}${last ? '   ' : '|  '}`, i === kids.length - 1));
  };
  for (const m of YANG_MODULES) {
    const tops = yangTopNodes().filter((n) => n.module === m.name);
    const ops = yangOperations().filter((n) => n.module === m.name);
    if (tops.length === 0 && ops.length === 0) continue;
    out.push(`module: ${m.name}`);
    tops.forEach((n, i) => walk(n, '  ', i === tops.length - 1));
    if (ops.length > 0) {
      out.push('', '  rpcs:');
      ops.forEach((n, i) => walk(n, '    ', i === ops.length - 1));
    }
    out.push('');
  }
  return out.join('\n').trimEnd();
}
