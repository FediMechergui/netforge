/**
 * core/acl.ts — standard IPv4 access lists, matching only (ARCHITECTURE-P2 D14, §3.9 "Dynamic pool", §5.2).
 *
 * Pulled forward from CCNA 3 for NAT: `ip nat inside source list <acl> …` asks whether a source address is
 * permitted. Interface filtering (`ip access-group`) and extended lists stay in P3; hit counters are not kept.
 *
 * Lines (§5.2; the grammar and storage belong to the CLI, this module only reads them):
 *   numbered  `access-list <1-99|1300-1999> permit|deny <a> [<wildcard>] | host <a> | any`   (global, multi)
 *   named     `ip access-list standard <name>` (section, mode config-std-nacl) with `permit|deny …` children
 * `remark …` entries are skipped. Numbers outside the standard ranges and `ip access-list extended` sections are
 * not standard lists and are ignored here.
 *
 * Matching: an entry matches address x when every bit that is 0 in its wildcard is equal in x and in the entry's
 * address, i.e. `((x ^ address) & ~wildcard) === 0` (a wildcard need not be contiguous). Entries are tried in order;
 * the FIRST match decides (`permit` or `deny`); an address no entry matches is denied (the implicit deny at the end
 * of every list). A list that does not exist permits nothing (`aclPermits(undefined, x)` is false): NAT then leaves
 * the packet untranslated (§3.9 step 3).
 *
 * Canonical entry (`standardAclEntryTokens`), as the device's running configuration shows it: wildcard 0.0.0.0 →
 * the bare address (`permit 10.0.0.1`, also for `host 10.0.0.1`); wildcard 255.255.255.255 → `any`; otherwise the
 * address with its wildcard bits cleared, then the wildcard (`permit 192.168.1.0 0.0.0.255` for `192.168.1.5 0.0.0.255`).
 *
 * Pure: no module state, no randomness; lists keep configuration order.
 */
import { ipv4ToU32, parseIpv4, u32ToIpv4, type Ipv4Address } from '../contracts/addr.js';
import type { ConfigAst, ConfigNode } from '../contracts/config.js';

/** What an entry does with the addresses it matches. */
export type AclAction = 'permit' | 'deny';

/** One entry of a standard list: an action for the addresses that `address`/`wildcard` match. */
export interface StandardAclEntry {
  readonly action: AclAction;
  /** Canonical: the bits the wildcard ignores are 0. */
  readonly address: Ipv4Address;
  /** Wildcard (inverse) mask: 1 bits are "don't care". 0.0.0.0 = one host, 255.255.255.255 = any. */
  readonly wildcard: Ipv4Address;
}

/** A standard list: numbered lists are named by their number (`'1'`), named lists by their name. */
export interface StandardAcl {
  readonly name: string;
  readonly entries: readonly StandardAclEntry[];
}

/** Result of matching one address against a list. */
export interface AclMatch {
  readonly action: AclAction;
  /** Index of the entry that decided; absent = no entry matched (implicit deny). */
  readonly index?: number;
}

/** Wildcard of `any`. */
export const ACL_WILDCARD_ANY: Ipv4Address = '255.255.255.255';
/** Wildcard of one host. */
export const ACL_WILDCARD_HOST: Ipv4Address = '0.0.0.0';

/** True for a standard numbered list: 1–99 or 1300–1999 (numbers given as text must be plain decimal). */
export function isStandardAclNumber(n: number | string): boolean {
  const v = typeof n === 'number' ? n : /^\d{1,4}$/.test(n) ? Number(n) : Number.NaN;
  return Number.isInteger(v) && ((v >= 1 && v <= 99) || (v >= 1300 && v <= 1999));
}

function entry(action: AclAction, address: number, wildcard: number): StandardAclEntry {
  return { action, address: u32ToIpv4((address & ~wildcard) >>> 0), wildcard: u32ToIpv4(wildcard) };
}

/**
 * Parse the tokens of one entry, starting at the action: `permit|deny any`, `permit|deny host <a>`,
 * `permit|deny <a>`, `permit|deny <a> <wildcard>`. Returns undefined for anything else (including `remark …`).
 */
export function parseStandardAclEntry(tokens: readonly string[]): StandardAclEntry | undefined {
  const [act, a, b, extra] = tokens;
  if ((act !== 'permit' && act !== 'deny') || a === undefined || extra !== undefined) return undefined;
  if (a === 'any') return b === undefined ? entry(act, 0, 0xffffffff) : undefined;
  if (a === 'host') {
    const h = b === undefined ? null : parseIpv4(b);
    return h === null ? undefined : entry(act, h, 0);
  }
  const addr = parseIpv4(a);
  if (addr === null) return undefined;
  if (b === undefined) return entry(act, addr, 0);
  const wild = parseIpv4(b);
  return wild === null ? undefined : entry(act, addr, wild);
}

/** The canonical tokens of an entry (see the module header), starting at the action. */
export function standardAclEntryTokens(e: StandardAclEntry): string[] {
  if (e.wildcard === ACL_WILDCARD_ANY) return [e.action, 'any'];
  if (e.wildcard === ACL_WILDCARD_HOST) return [e.action, e.address];
  return [e.action, e.address, e.wildcard];
}

/** True when the entry's address and wildcard match `address`. */
export function aclEntryMatches(e: StandardAclEntry, address: Ipv4Address): boolean {
  const wild = ipv4ToU32(e.wildcard);
  return ((ipv4ToU32(address) ^ ipv4ToU32(e.address)) & ~wild) >>> 0 === 0;
}

/** First match wins; no match = implicit deny (no `index`). */
export function matchStandardAcl(acl: StandardAcl, address: Ipv4Address): AclMatch {
  for (let i = 0; i < acl.entries.length; i++) {
    const e = acl.entries[i]!;
    if (aclEntryMatches(e, address)) return { action: e.action, index: i };
  }
  return { action: 'deny' };
}

/** True when the list permits `address`. A list that does not exist permits nothing. */
export function aclPermits(acl: StandardAcl | undefined, address: Ipv4Address): boolean {
  return acl !== undefined && matchStandardAcl(acl, address).action === 'permit';
}

/** Build a list from entry token lines (each starting at the action); lines that do not parse are skipped. */
export function standardAclFromLines(name: string, lines: Iterable<readonly string[]>): StandardAcl {
  const entries: StandardAclEntry[] = [];
  for (const line of lines) {
    const e = parseStandardAclEntry(line);
    if (e !== undefined) entries.push(e);
  }
  return { name, entries };
}

/**
 * Every standard list of a running configuration, keyed by name (a numbered list by its number text), in order of
 * first appearance; entries keep configuration order. A named section whose name is a standard number joins the
 * numbered list of that number (one list, as on the device). Pure: reads the tree, never changes it.
 */
export function readStandardAcls(config: Pick<ConfigAst, 'root'>): Map<string, StandardAcl> {
  const lists = new Map<string, StandardAclEntry[]>();
  const add = (name: string, tokens: readonly string[]): void => {
    let list = lists.get(name);
    if (list === undefined) {
      list = [];
      lists.set(name, list);
    }
    const e = parseStandardAclEntry(tokens);
    if (e !== undefined) list.push(e);
  };
  const named = (raw: string | undefined, children: readonly ConfigNode[]): void => {
    if (raw === undefined) return;
    const name = isStandardAclNumber(raw) ? String(Number(raw)) : raw;
    if (!lists.has(name)) lists.set(name, []);
    for (const c of children) add(name, [c.key, ...c.args]);
  };
  for (const node of config.root.children) {
    if (node.key === 'access-list') {
      const num = node.args[0];
      if (num !== undefined && isStandardAclNumber(num)) add(String(Number(num)), node.args.slice(1));
    } else if (node.key === 'ip' && node.args[0] === 'access-list' && node.args[1] === 'standard') {
      // the section node carries every token of its mode-entering line (contracts/config.ts)
      named(node.args[2], node.children);
    } else if (node.key === 'ip' && node.args.length === 0) {
      // defensive: a folded `ip` group never holds sections, but read one if a rule table ever stores it that way
      for (const leaf of node.children) {
        if (leaf.key === 'access-list' && leaf.args[0] === 'standard') named(leaf.args[1], leaf.children);
      }
    }
  }
  const out = new Map<string, StandardAcl>();
  for (const [name, entries] of lists) out.set(name, { name, entries });
  return out;
}
