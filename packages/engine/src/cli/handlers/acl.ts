/**
 * cli/handlers/acl.ts — standard access lists: `access-list <n> …`, the `ip access-list standard <name>` section with
 * its `permit|deny …` entries, and `show access-lists` (ARCHITECTURE-P2 §3.9, §5.2, §5.4, D14; §7 W3 cli).
 *
 * Each entry is stored in the canonical form core/acl.ts reads back (`standardAclEntryTokens`: a host as the bare
 * address, `any` for the all-ones wildcard, otherwise the network with its wildcard). Numbered lists take the
 * standard ranges only (1-99, 1300-1999). `no access-list <n>` removes every entry of the list; `no access-list <n>
 * <entry>` and `no permit|deny <entry>` remove one entry. Every string is original wording (spec §1.6).
 */
import type { CommandCtx, CommandHandler } from '../../contracts/cli.js';
import { isStandardAclNumber, parseStandardAclEntry, readStandardAcls, standardAclEntryTokens, type StandardAcl } from '../../core/acl.js';
import { ACL_ACTION_ARG, ACL_SOURCE_FORM_ARG, P2_HANDLERS } from '../grammar/index.js';
import { enterMode, outcomeOf } from './common.js';

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

/** The `show access-lists` block of one list. */
export function renderAcl(acl: StandardAcl): string {
  const lines = [`Standard access list ${acl.name}`];
  acl.entries.forEach((e, i) => lines.push(`    ${(i + 1) * 10} ${standardAclEntryTokens(e).join(' ')}`));
  if (acl.entries.length === 0) lines.push('    (no entry)');
  return lines.join('\n');
}

const showAccessLists: CommandHandler = (ctx: CommandCtx) => {
  const lists = [...readStandardAcls(ctx.running).values()];
  if (lists.length === 0) return { output: MSG_NO_ACL };
  return { output: lists.map(renderAcl).join('\n') };
};

/** @since P2 Registry fragment: the access-list lines and show command. */
export const aclHandlers: Readonly<Record<string, CommandHandler>> = {
  [P2_HANDLERS.configAccessList]: accessList,
  [P2_HANDLERS.configIpAccessListStandard]: ipAccessListStandard,
  [P2_HANDLERS.naclEntry]: naclEntry,
  [P2_HANDLERS.showAccessLists]: showAccessLists,
};
