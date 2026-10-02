/**
 * cli/handlers/acl.ts — IPv4 access lists.
 *
 * P2 (ARCHITECTURE-P2 §3.9, §5.2, §5.4, D14; §7 W3 cli): standard lists — `access-list <n> …`, the `ip access-list
 * standard <name>` section with its `permit|deny …` entries. Each entry is stored in the canonical form core/acl.ts
 * reads back (`standardAclEntryTokens`: a host as the bare address, `any` for the all-ones wildcard, otherwise the
 * network with its wildcard). Numbered lists take the standard ranges only (1-99, 1300-1999). `no access-list <n>`
 * removes every entry of the list; `no access-list <n> <entry>` and `no permit|deny <entry>` remove one entry.
 *
 * P3 (ARCHITECTURE-P3 §5.2, §5.8, D12, D14; §7 W2 cli part 1): the generated entry specs of `ACL_P3_GRAMMAR` rebuild
 * the typed tokens (`typedEntryTokens`) and store the canonical `aclEntryText` of core/acl's parser, so the running
 * configuration, `show access-lists` and the `acl` rows print one text. In a list section a leading number is the
 * entry's sequence number (`ConfigNode.seq` through `ConfigAst.apply`: `15 permit …`, `no 15`); a taken number is
 * refused. `ip access-group` keeps one list per direction (the same-direction line goes first), notes an undefined
 * list (`aclUndefinedApplied`; it permits everything, D12) and is refused on switched ports
 * (`accessGroupSwitchport`). `clear access-list counters` sends `acl.clear`; `show access-lists` adds ` (N matches)`
 * from the `acl` rows (applied lists only) and never prints the implicit deny. Every string is original wording.
 */
import { CLI_MESSAGES, type CommandCtx, type CommandHandler, type CommandOutcome } from '../../contracts/cli.js';
import { ROLE_TRAITS, profileIncludes } from '../../contracts/catalog.js';
import type { ConfigNode } from '../../contracts/config.js';
import type { PortId } from '../../contracts/ids.js';
import type { PortView } from '../../contracts/port.js';
import type { AclRow } from '../../contracts/tables.js';
import {
  aclEntryText,
  aclTypeOfNumber,
  isExtendedAclNumber,
  isStandardAclNumber,
  parseAclEntry,
  parseStandardAclEntry,
  readAcls,
  standardAclEntryTokens,
  type AclList,
  type AclListType,
  type StandardAcl,
} from '../../core/acl.js';
import { ACL_FORM, ACL_P3_HANDLERS, ACL_SEQ_MAX } from '../grammar/acl.js';
import { ACL_ACTION_ARG, ACL_SOURCE_FORM_ARG, P2_HANDLERS } from '../grammar/index.js';
import { enterMode, fillTemplate, globalContext, MSG_NO_INTERFACE_SELECTED, outcomeOf, roleOf, selectedPort } from './common.js';

/** A list number outside the standard ranges. */
export const MSG_ACL_NUMBER = '% A standard access list is numbered 1-99 or 1300-1999.';
/** An entry whose source does not parse. */
export const MSG_ACL_ENTRY = '% Expected a source: any, host <address>, or <address> [<wildcard>].';
/** `permit` / `deny` typed outside a list section. */
export const MSG_NO_ACL_SELECTED = '% Select a list first (ip access-list standard <name>).';
/** `show access-lists` with nothing configured. */
export const MSG_NO_ACL = 'No access list is configured.';

/** The canonical entry tokens (starting at the action) of a typed entry, or undefined. */
export function aclEntryTokens(action: string | undefined, form: string | undefined, args: Record<string, string>): string[] | undefined {
  if (action !== 'permit' && action !== 'deny') return undefined;
  let source: string[];
  switch (form) {
    case 'any':
      source = ['any'];
      break;
    case 'host':
      source = ['host', args['address'] ?? ''];
      break;
    default: {
      const wildcard = args['wildcard'];
      source = wildcard === undefined || wildcard === '' ? [args['address'] ?? ''] : [args['address'] ?? '', wildcard];
    }
  }
  const entry = parseStandardAclEntry([action, ...source]);
  return entry === undefined ? undefined : standardAclEntryTokens(entry);
}

/** `access-list <n> permit|deny …` / `no access-list <n> [entry]`. */
const accessList: CommandHandler = (ctx, args, negate) => {
  const number = args['number'] ?? '';
  if (!isStandardAclNumber(number)) return { error: MSG_ACL_NUMBER };
  const n = String(Number(number));
  const action = args[ACL_ACTION_ARG];
  if (negate && action === undefined) return outcomeOf(ctx.config(['access-list', n], true, []));
  const tokens = aclEntryTokens(action, args[ACL_SOURCE_FORM_ARG], args);
  if (tokens === undefined) return { error: MSG_ACL_ENTRY };
  return outcomeOf(ctx.config(['access-list', n, ...tokens], negate, []));
};

/** `ip access-list standard <name>` / its `no` form (removes the whole list). */
const ipAccessListStandard: CommandHandler = (ctx, args, negate) => {
  const name = args['name'] ?? '';
  if (name === '') return { error: '% Give the list a name.' };
  const line = ['ip', 'access-list', 'standard', name];
  if (negate) return outcomeOf(ctx.config(line, true, []));
  // P3: a name the extended section already holds is that list (readAcls keeps the type seen first)
  if (readAcls(ctx.running).get(aclListKey(name))?.type === 'extended') return { error: MSG_ACL_OTHER_TYPE(name, 'extended') };
  const error = ctx.config(line, false, []);
  if (error !== undefined) return { error };
  enterMode(ctx, 'config-std-nacl', [line]);
  return {};
};

/** `permit|deny …` inside a named list / `no permit|deny …`. */
const naclEntry: CommandHandler = (ctx, args, negate) => {
  const entry = ctx.context[ctx.context.length - 1];
  if (entry === undefined || entry[0] !== 'ip' || entry[1] !== 'access-list') return { error: MSG_NO_ACL_SELECTED };
  const tokens = aclEntryTokens(args[ACL_ACTION_ARG], args[ACL_SOURCE_FORM_ARG], args);
  if (tokens === undefined) return { error: MSG_ACL_ENTRY };
  return outcomeOf(ctx.config(tokens, negate));
};

/** The `show access-lists` block of one list (P2's standard-list form; P3 renders through `renderAclList`). */
export function renderAcl(acl: StandardAcl): string {
  const lines = [`Standard access list ${acl.name}`];
  acl.entries.forEach((e, i) => lines.push(`    ${(i + 1) * 10} ${standardAclEntryTokens(e).join(' ')}`));
  if (acl.entries.length === 0) lines.push('    (no entry)');
  return lines.join('\n');
}

// ── P3 (ARCHITECTURE-P3 §5.2, §5.8, D12, D14; §7 W2 cli part 1) ──────────────────────────────────────────────────

/** @since P3 An entry that does not parse for its list type (the generated specs make this rare). */
export const MSG_ACL_P3_ENTRY = '% That entry is not valid for this list.';
/** @since P3 A standard entry form typed for an extended list number, or the reverse. */
export const MSG_ACL_TYPE_MISMATCH = (list: string, type: 'standard' | 'extended'): string =>
  type === 'extended'
    ? `% List ${list} is an extended list: give a protocol, a source and a destination.`
    : `% List ${list} is a standard list: give only a source.`;
/** @since P3 `ip access-list standard|extended <name>` naming a list of the other type. */
export const MSG_ACL_OTHER_TYPE = (name: string, type: 'standard' | 'extended'): string => `% ${name} is already a${type === 'extended' ? 'n extended' : ' standard'} list.`;
/** @since P3 A list-section line typed outside a list section. */
export const MSG_NO_LIST_SECTION = '% Select a list first (ip access-list standard|extended <name>).';
/** @since P3 `<seq> permit|deny …` with a number another entry of the list holds. */
export const MSG_ACL_SEQ_TAKEN = (seq: string): string => `% Entry ${seq} already exists in this list; remove it first (no ${seq}).`;
/** @since P3 `no <seq>` naming no entry. */
export const MSG_ACL_NO_SEQ = (seq: string): string => `% This list has no entry ${seq}.`;
/** @since P3 A sequence number typed alone. */
export const MSG_ACL_SEQ_ALONE = '% Give the entry after its number, for example 15 permit any.';
/** @since P3 A list named in a command that does not exist. */
export const MSG_ACL_UNKNOWN = (list: string): string => `% There is no access list named ${list}.`;
/** @since P3 `ip access-list resequence` whose last number would pass the highest sequence number. */
export const MSG_ACL_RESEQUENCE_RANGE = '% The entries would not fit: choose a smaller start or step.';
/** @since P3 `show access-lists <list>` naming no list. */
export const MSG_ACL_NOT_CONFIGURED = (list: string): string => `No access list named ${list} is configured.`;

/** The canonical list key of a typed list name: a number as plain decimal, a name as typed. */
export function aclListKey(name: string): string {
  return /^\d{1,10}$/.test(name) ? String(Number(name)) : name;
}

/** The tokens one address form stands for. */
function addressTokens(form: string | undefined, address: string | undefined, wildcard: string | undefined): string[] {
  if (form === 'any') return ['any'];
  if (form === 'host') return ['host', address ?? ''];
  return [address ?? '', wildcard ?? ''];
}

/** The tokens one port form stands for. */
function portTokens(form: string | undefined, op: string | undefined, port: string | undefined, high: string | undefined): string[] {
  if (form === 'op') return [op ?? '', port ?? ''];
  if (form === 'range') return ['range', port ?? '', high ?? ''];
  return [];
}

/**
 * @since P3 The tokens of a typed entry (from the action on) as the generated specs describe it (`ACL_FORM` fixed args
 * and the spec's args), before canonicalisation; undefined without an action.
 */
export function typedEntryTokens(args: Readonly<Record<string, string>>): string[] | undefined {
  const action = args[ACL_FORM.action];
  if (action !== 'permit' && action !== 'deny') return undefined;
  const log = args[ACL_FORM.log] === 'log' ? ['log'] : [];
  const src = addressTokens(args[ACL_FORM.src], args['src'], args['srcWild']);
  if (args[ACL_FORM.type] === 'standard') return [action, ...src, ...log];
  const proto = args[ACL_FORM.proto] ?? args['protocol'] ?? '';
  const out = [action, proto, ...src];
  out.push(...portTokens(args[ACL_FORM.sport], args['sportOp'], args['sport'], args['sportHigh']));
  out.push(...addressTokens(args[ACL_FORM.dst], args['dst'], args['dstWild']));
  out.push(...portTokens(args[ACL_FORM.dport], args['dportOp'], args['dport'], args['dportHigh']));
  if (args[ACL_FORM.established] !== undefined) out.push('established');
  const icmp = args[ACL_FORM.icmp];
  if (icmp === 'msg') out.push(args['icmp'] ?? '');
  else if (icmp === 'code') out.push(args['icmpType'] ?? '', args['icmpCode'] ?? '');
  out.push(...log);
  return out;
}

/** The canonical stored tokens of a typed entry of a `type` list (`aclEntryText`), or undefined. */
export function canonicalEntryTokens(type: AclListType, args: Readonly<Record<string, string>>): string[] | undefined {
  const typed = typedEntryTokens(args);
  if (typed === undefined) return undefined;
  const entry = parseAclEntry(type, typed);
  return entry === undefined ? undefined : aclEntryText(entry).split(' ');
}

/** The list section the session is in: its type and name, or undefined. */
function listSection(ctx: CommandCtx): { type: AclListType; name: string; context: string[][] } | undefined {
  const entry = ctx.context[ctx.context.length - 1];
  if (entry === undefined || entry[0] !== 'ip' || entry[1] !== 'access-list') return undefined;
  const type = entry[2];
  const name = entry[3];
  if ((type !== 'standard' && type !== 'extended') || name === undefined) return undefined;
  return { type, name, context: ctx.context.map((e) => e.slice()) };
}

/** `access-list <n> permit|deny …` (the P3 forms: standard with `log`, every extended form) and their `no` forms. */
const accessListEntry: CommandHandler = (ctx, args, negate) => {
  const number = args['number'] ?? '';
  const type = aclTypeOfNumber(number);
  if (type === undefined) return { error: CLI_MESSAGES.aclNumberRange };
  const n = String(Number(number));
  const formType = args[ACL_FORM.type] === 'standard' ? 'standard' : 'extended';
  if (formType !== type) return { error: MSG_ACL_TYPE_MISMATCH(n, type) };
  const tokens = canonicalEntryTokens(type, args);
  if (tokens === undefined) return { error: MSG_ACL_P3_ENTRY };
  return outcomeOf(ctx.config(['access-list', n, ...tokens], negate, globalContext()));
};

/** `access-list <n> remark <text>` / its `no` form. */
const accessListRemark: CommandHandler = (ctx, args, negate) => {
  const number = args['number'] ?? '';
  if (aclTypeOfNumber(number) === undefined) return { error: CLI_MESSAGES.aclNumberRange };
  const text = (args['text'] ?? '').trim();
  if (text === '' && !negate) return { error: '% Give the text of the remark.' };
  return outcomeOf(ctx.config(['access-list', String(Number(number)), 'remark', text], negate, globalContext()));
};

/** The configured list of this name (a number in its canonical form), or undefined. */
function listNamed(ctx: CommandCtx, name: string): AclList | undefined {
  return readAcls(ctx.running).get(aclListKey(name));
}

/** `ip access-list extended <name|number>` / its `no` form (the whole list, global lines of its number included). */
const ipAccessListExtended: CommandHandler = (ctx, args, negate) => {
  const raw = args['name'] ?? '';
  if (raw === '') return { error: '% Give the list a name.' };
  const numbered = /^\d+$/.test(raw);
  if (numbered && !isExtendedAclNumber(raw)) return { error: CLI_MESSAGES.aclNumberRange };
  const name = numbered ? String(Number(raw)) : raw;
  const line = ['ip', 'access-list', 'extended', name];
  if (negate) {
    const root = ctx.running.root.children;
    if (root.some((c) => c.key === 'ip' && c.args[0] === 'access-list' && c.args[1] === 'extended' && c.args[2] === name)) {
      const e = ctx.config(line, true, globalContext());
      if (e !== undefined) return { error: e };
    }
    if (numbered && root.some((c) => c.key === 'access-list' && c.args[0] === name)) return outcomeOf(ctx.config(['access-list', name], true, globalContext()));
    return {};
  }
  const existing = listNamed(ctx, name);
  if (existing !== undefined && existing.type !== 'extended') return { error: MSG_ACL_OTHER_TYPE(name, existing.type) };
  const error = ctx.config(line, false, globalContext());
  if (error !== undefined) return { error };
  enterMode(ctx, 'config-ext-nacl', [line]);
  return {};
};

/** `[<seq>] permit|deny …` inside a list section (the P3 forms) and their `no` forms. */
const naclEntryP3: CommandHandler = (ctx, args, negate) => {
  const section = listSection(ctx);
  if (section === undefined) return { error: MSG_NO_LIST_SECTION };
  const seq = args['seq'];
  if (negate && seq !== undefined) return naclRemoveSeq(ctx, section.name, seq);
  const formType = args[ACL_FORM.type] === 'standard' ? 'standard' : 'extended';
  if (formType !== section.type) return { error: MSG_ACL_TYPE_MISMATCH(section.name, section.type) };
  const tokens = canonicalEntryTokens(section.type, args);
  if (tokens === undefined) return { error: MSG_ACL_P3_ENTRY };
  if (negate) return outcomeOf(ctx.config(tokens, true));
  if (seq !== undefined) {
    if (listNamed(ctx, section.name)?.entries.some((e) => e.seq === Number(seq))) return { error: MSG_ACL_SEQ_TAKEN(seq) };
    return outcomeOf(ctx.config([String(Number(seq)), ...tokens], false));
  }
  return outcomeOf(ctx.config(tokens, false));
};

/** `no <seq>` in a list section: remove that entry (or numbered remark). */
function naclRemoveSeq(ctx: CommandCtx, name: string, seq: string): CommandOutcome {
  const n = Number(seq);
  const list = listNamed(ctx, name);
  const hasEntry = list?.entries.some((e) => e.seq === n) === true;
  const hasRemark = !hasEntry && sequencedNodes(ctx, name).some((x) => x.node.seq === n);
  if (!hasEntry && !hasRemark) return { error: MSG_ACL_NO_SEQ(String(n)) };
  return outcomeOf(ctx.config([String(n)], true));
}

/** `<seq>` alone in a list section: refused positively; `no <seq>` removes the entry. */
const naclSeq: CommandHandler = (ctx, args, negate) => {
  const section = listSection(ctx);
  if (section === undefined) return { error: MSG_NO_LIST_SECTION };
  if (!negate) return { error: MSG_ACL_SEQ_ALONE };
  return naclRemoveSeq(ctx, section.name, args['seq'] ?? '');
};

/** `remark <text>` / `no remark <text>` inside a list section. */
const naclRemark: CommandHandler = (ctx, args, negate) => {
  if (listSection(ctx) === undefined) return { error: MSG_NO_LIST_SECTION };
  const text = (args['text'] ?? '').trim();
  if (text === '' && !negate) return { error: '% Give the text of the remark.' };
  return outcomeOf(ctx.config(['remark', text], negate));
};

/** A stored line of a list: its node, the context it lives in, and its tokens. */
interface ListNode {
  readonly node: ConfigNode;
  readonly context: string[][];
  readonly tokens: string[];
  readonly global: boolean;
}

/** Every stored line (entries and remarks) of list `name`: the global `access-list N` lines, then its section's. */
function sequencedNodes(ctx: CommandCtx, name: string): ListNode[] {
  const key = aclListKey(name);
  const out: ListNode[] = [];
  for (const c of ctx.running.root.children) {
    if (c.key === 'access-list' && c.args[0] !== undefined && aclListKey(c.args[0]) === key) {
      out.push({ node: c, context: [], tokens: [c.key, ...c.args], global: true });
    }
  }
  for (const c of ctx.running.root.children) {
    if (c.key !== 'ip' || c.args[0] !== 'access-list' || c.args[2] === undefined || aclListKey(c.args[2]) !== key) continue;
    for (const child of c.children) out.push({ node: child, context: [['ip', ...c.args]], tokens: [child.key, ...child.args], global: false });
  }
  return out;
}

/**
 * `ip access-list resequence <list> <start> <step>` (not stored): every entry and numbered remark is taken out and put
 * back with its new number, in its current order. Entries of the global `access-list N` lines carry no number syntax,
 * so they move into the list's section (created when absent) — the list stays one list (D12's join rule).
 */
const resequence: CommandHandler = (ctx, args) => {
  const listName = args['list'] ?? '';
  const list = listNamed(ctx, listName);
  if (list === undefined) return { error: MSG_ACL_UNKNOWN(listName) };
  const start = Number(args['start']);
  const step = Number(args['step']);
  const nodes = sequencedNodes(ctx, list.name).filter((x) => x.node.seq !== undefined);
  nodes.sort((a, b) => (a.node.seq as number) - (b.node.seq as number));
  if (nodes.length === 0) return {};
  if (start + step * (nodes.length - 1) > ACL_SEQ_MAX) return { error: MSG_ACL_RESEQUENCE_RANGE };
  const sectionHead = ['ip', 'access-list', list.type, list.name];
  const sectionContext = [sectionHead];
  if (nodes.some((x) => x.global)) {
    const e = ctx.config(sectionHead, false, globalContext());
    if (e !== undefined) return { error: e };
  }
  for (const x of nodes) {
    const e = ctx.config(x.tokens, true, x.context);
    if (e !== undefined) return { error: e };
  }
  for (let i = 0; i < nodes.length; i++) {
    const x = nodes[i] as ListNode;
    const body = x.global ? x.tokens.slice(2) : x.tokens;
    const e = ctx.config([String(start + step * i), ...body], false, sectionContext);
    if (e !== undefined) return { error: e };
  }
  return {};
};

/** The stored `ip access-group <list> <dir>` lines of a port. */
function accessGroups(ctx: CommandCtx, port: PortId): { list: string; dir: string }[] {
  const out: { list: string; dir: string }[] = [];
  const section = ctx.running.root.children.find((c) => c.key === 'interface' && c.args[0] === port);
  for (const c of section?.children ?? []) {
    if (c.key === 'ip' && c.args.length === 0) {
      for (const leaf of c.children) if (leaf.key === 'access-group' && leaf.args.length === 2) out.push({ list: leaf.args[0] as string, dir: leaf.args[1] as string });
    } else if (c.key === 'ip' && c.args[0] === 'access-group' && c.args.length === 3) {
      out.push({ list: c.args[1] as string, dir: c.args[2] as string });
    }
  }
  return out;
}

/** `ip access-group <list> in|out` / its `no` forms: one list per direction (D12); only on L3 interfaces. */
const ipAccessGroup: CommandHandler = (ctx, args, negate) => {
  const port = selectedPort(ctx);
  if (port === undefined) return { error: MSG_NO_INTERFACE_SELECTED };
  const role = roleOf(ctx, port);
  if (role === 'switched' || role === 'channel') return { error: fillTemplate(CLI_MESSAGES.accessGroupSwitchport, { port: port.id }) };
  if (!ROLE_TRAITS[role].l3) return { error: CLI_MESSAGES.portUnsupported };
  const list = args['list'];
  const dir = args['direction'];
  const stored = accessGroups(ctx, port.id);
  if (negate) {
    for (const g of stored) {
      if (dir !== undefined && g.dir !== dir) continue;
      if (list !== undefined && aclListKey(g.list) !== aclListKey(list)) continue;
      const e = ctx.config(['ip', 'access-group', g.list, g.dir], true);
      if (e !== undefined) return { error: e };
    }
    return {};
  }
  if (list === undefined || dir === undefined) return { error: '% Expected ip access-group <list> in|out.' };
  if (/^\d+$/.test(list) && aclTypeOfNumber(list) === undefined) return { error: CLI_MESSAGES.aclNumberRange };
  const name = aclListKey(list);
  for (const g of stored) {
    if (g.dir !== dir) continue;
    if (g.list === name) return {};
    const e = ctx.config(['ip', 'access-group', g.list, g.dir], true);
    if (e !== undefined) return { error: e };
  }
  const error = ctx.config(['ip', 'access-group', name, dir], false);
  if (error !== undefined) return { error };
  return listNamed(ctx, name) === undefined ? { output: fillTemplate(CLI_MESSAGES.aclUndefinedApplied, { list: name }) } : {};
};

/** `clear access-list counters [<list>]` → acl `acl.clear` (D12: the daemon owns the counters). */
const clearCounters: CommandHandler = (ctx, args) => {
  const list = args['list'];
  if (list !== undefined && listNamed(ctx, list) === undefined) return { error: MSG_ACL_UNKNOWN(list) };
  ctx.request(ACL_PROCESS, list === undefined ? { kind: 'acl.clear' } : { kind: 'acl.clear', list: aclListKey(list) });
  return {};
};

/** The acl daemon's process name. */
const ACL_PROCESS = 'acl';

/** The `acl` rows of this device (absent when the model has no acl table). */
function aclRows(ctx: CommandCtx): AclRow[] {
  return (ctx.tables.get<AclRow>('acl')?.rows() ?? []) as AclRow[];
}

/**
 * @since P3 One list as `show access-lists` prints it: `Standard|Extended access list <name>`, then each entry by
 * sequence number with ` (N matches)` when its `acl` row counted any (rows exist only for applied lists, D12); the
 * implicit deny is never printed. A standard list without matches prints exactly P2's `renderAcl` block.
 */
export function renderAclList(list: AclList, matches: ReadonlyMap<number, number>): string {
  const lines = [`${list.type === 'standard' ? 'Standard' : 'Extended'} access list ${list.name}`];
  for (const e of list.entries) {
    const n = matches.get(e.seq) ?? 0;
    lines.push(`    ${e.seq} ${e.text}${n > 0 ? ` (${n} match${n === 1 ? '' : 'es'})` : ''}`);
  }
  if (list.entries.length === 0) lines.push('    (no entry)');
  return lines.join('\n');
}

/** `show access-lists [<list>]` and `show ip access-lists [<list>]`. */
const showAccessLists: CommandHandler = (ctx, args) => {
  const lists = readAcls(ctx.running);
  const want = args['list'];
  let shown = [...lists.values()];
  if (want !== undefined && want !== '') {
    const key = aclListKey(want);
    shown = shown.filter((l) => l.name === key);
    if (shown.length === 0) return { output: MSG_ACL_NOT_CONFIGURED(want) };
  }
  if (shown.length === 0) return { output: MSG_NO_ACL };
  const rows = aclRows(ctx);
  return {
    output: shown
      .map((l) => {
        const m = new Map<number, number>();
        for (const r of rows) if (r.list === l.name && typeof r.seq === 'number') m.set(r.seq, r.matches);
        return renderAclList(l, m);
      })
      .join('\n'),
  };
};

/** One `show ip interface` block (original wording). */
function ipInterfaceBlock(ctx: CommandCtx, port: PortView): string {
  const state = !port.adminUp ? 'administratively down' : port.operUp ? 'up' : 'down';
  const lines = [`${port.id} is ${state}, line protocol is ${port.operUp ? 'up' : 'down'}`];
  const v4 = port.l3.ipv4;
  lines.push(v4 === undefined ? `  No IPv4 address, MTU ${port.mtu} bytes` : `  Address ${v4.address}/${v4.prefixLen}, MTU ${port.mtu} bytes`);
  const helpers = helperAddresses(ctx, port.id);
  lines.push(`  Helper addresses: ${helpers.length === 0 ? 'none' : helpers.join(', ')}`);
  const groups = accessGroups(ctx, port.id);
  const inbound = groups.find((g) => g.dir === 'in')?.list;
  const outbound = groups.find((g) => g.dir === 'out')?.list;
  lines.push(`  Inbound access list: ${inbound ?? 'not set'}`);
  lines.push(`  Outbound access list: ${outbound ?? 'not set'}`);
  const nat = natSide(ctx, port.id);
  const proxy = proxyArpOn(ctx, port) ? 'on' : 'off';
  lines.push(`  Unreachables: sent    Proxy ARP: ${proxy}    NAT: ${nat === undefined ? 'not a NAT interface' : `${nat} interface`}`);
  return lines.join('\n');
}

/**
 * Proxy ARP as `show ip interface` reports it, exactly as the arp daemon decides it (protocols/arp.ts
 * `proxyArpEnabled`): off with a stored `no ip proxy-arp`; else on for an L3 interface of a routing device in a P2 or
 * later world, and off in a P1 world (`CommandCtx.profile`, absent = 'P1'; W2 fix, verified finding 8).
 */
function proxyArpOn(ctx: CommandCtx, port: PortView): boolean {
  const section = ctx.running.root.children.find((c) => c.key === 'interface' && c.args[0] === port.id);
  for (const c of section?.children ?? []) {
    if (c.key === 'no' && c.args.length === 2 && c.args[0] === 'ip' && c.args[1] === 'proxy-arp') return false;
  }
  return profileIncludes(ctx.profile ?? 'P1', 'P2') && ctx.model.ipForwarding && ROLE_TRAITS[roleOf(ctx, port)].l3;
}

/** The `ip helper-address` values of a port, in configuration order. */
function helperAddresses(ctx: CommandCtx, port: PortId): string[] {
  const out: string[] = [];
  const section = ctx.running.root.children.find((c) => c.key === 'interface' && c.args[0] === port);
  for (const c of section?.children ?? []) {
    if (c.key !== 'ip') continue;
    if (c.args.length === 0) for (const leaf of c.children) if (leaf.key === 'helper-address' && leaf.args[0] !== undefined) out.push(leaf.args[0]);
    if (c.args[0] === 'helper-address' && c.args[1] !== undefined) out.push(c.args[1]);
  }
  return out;
}

/** `inside` / `outside` from the port's `ip nat` line. */
function natSide(ctx: CommandCtx, port: PortId): string | undefined {
  const section = ctx.running.root.children.find((c) => c.key === 'interface' && c.args[0] === port);
  for (const c of section?.children ?? []) {
    if (c.key !== 'ip') continue;
    if (c.args.length === 0) for (const leaf of c.children) if (leaf.key === 'nat' && leaf.args[0] !== undefined) return leaf.args[0];
    if (c.args[0] === 'nat' && c.args[1] !== undefined) return c.args[1];
  }
  return undefined;
}

/** `show ip interface [<if>]`: one block per L3 interface (or the one named). */
const showIpInterface: CommandHandler = (ctx, args) => {
  const name = args['iface'];
  if (name !== undefined && name !== '') {
    const id = ctx.ports.has(name) ? name : ctx.resolvePort(name);
    const port = id === undefined ? undefined : ctx.ports.get(id);
    if (port === undefined) return { error: `% No interface named "${name}" exists on this device.` };
    return { output: ipInterfaceBlock(ctx, port) };
  }
  const blocks: string[] = [];
  for (const p of ctx.ports.values()) {
    const role = roleOf(ctx, p);
    if (!ROLE_TRAITS[role].configurable || !ROLE_TRAITS[role].l3) continue;
    blocks.push(ipInterfaceBlock(ctx, p));
  }
  return { output: blocks.length === 0 ? 'No interface carries IPv4.' : blocks.join('\n') };
};

/** @since P3 Registry fragment: the P3 access-list lines and shows (`ACL_P3_HANDLERS` ids). */
export const aclP3Handlers: Readonly<Record<string, CommandHandler>> = {
  [ACL_P3_HANDLERS.configAccessListEntry]: accessListEntry,
  [ACL_P3_HANDLERS.configAccessListRemark]: accessListRemark,
  [ACL_P3_HANDLERS.configIpAccessListExtended]: ipAccessListExtended,
  [ACL_P3_HANDLERS.naclEntryP3]: naclEntryP3,
  [ACL_P3_HANDLERS.naclRemark]: naclRemark,
  [ACL_P3_HANDLERS.naclSeq]: naclSeq,
  [ACL_P3_HANDLERS.configIpAccessListResequence]: resequence,
  [ACL_P3_HANDLERS.ifIpAccessGroup]: ipAccessGroup,
  [ACL_P3_HANDLERS.execClearAccessListCounters]: clearCounters,
  [ACL_P3_HANDLERS.showIpInterface]: showIpInterface,
};

/** @since P2 Registry fragment: the access-list lines and show command. */
export const aclHandlers: Readonly<Record<string, CommandHandler>> = {
  [P2_HANDLERS.configAccessList]: accessList,
  [P2_HANDLERS.configIpAccessListStandard]: ipAccessListStandard,
  [P2_HANDLERS.naclEntry]: naclEntry,
  [P2_HANDLERS.showAccessLists]: showAccessLists,
};
