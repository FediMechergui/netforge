/**
 * cli/grammar/acl.ts — standard IPv4 access lists, pulled forward from CCNA 3 for NAT (ARCHITECTURE-P2 §3.9, §5.2,
 * §5.4, D14; §7 W3 cli): numbered `access-list <1-99|1300-1999> permit|deny <a> [<wildcard>] | host <a> | any`
 * (global, one stored line per entry), the named section `ip access-list standard <name>` (mode `config-std-nacl`)
 * with `permit|deny …` children, and `show access-lists`. core/acl.ts reads the stored lines; the handler stores
 * each entry in its canonical form (`standardAclEntryTokens`).
 *
 * Scope is the `routing` capability (the lists exist to feed `ip nat inside source list`). Help strings are original
 * wording (spec §1.6).
 */
import type { CommandSpec } from '../../contracts/cli.js';
import { choiceArg, intArg, ipv4Arg, NFOS_ONLY, wordArg } from './core-exec.js';
import { NAT_CAPABILITIES } from './nat.js';

/** Handler ids of the access-list fragment. Never rename. */
export const ACL_HANDLERS = {
  configAccessList: 'config.access-list',
  configIpAccessListStandard: 'config.ip-access-list-standard',
  naclEntry: 'nacl.entry',
  showAccessLists: 'show.access-lists',
} as const;

/** Arg names the entry handlers read through `fixedArgs`: the action (`permit` | `deny`) and the source form. */
export const ACL_ACTION_ARG = 'action';
export const ACL_SOURCE_FORM_ARG = 'form'; // any | host | address

/** Highest number `access-list <n>` accepts; the handler checks the standard ranges (1-99, 1300-1999). */
export const ACL_NUMBER_MAX = 1999;

const H = ACL_HANDLERS;

const NUMBER_ARG = intArg('List number: 1-99 or 1300-1999 (standard lists)', 1, ACL_NUMBER_MAX);
const ACTION_ARG = choiceArg('permit: match and allow; deny: match and refuse', ['permit', 'deny']);
const ADDRESS_ARG = ipv4Arg('Source address (a network when a wildcard follows)');
const WILDCARD_ARG = { type: 'ipv4', help: 'Wildcard mask: 1 bits are ignored (0.0.0.255 = a /24)', optional: true } as const;
const HOST_ARG = ipv4Arg('One host address');

const GLOBAL_LINE = {
  mode: 'config',
  privilege: 15,
  allowNo: true,
  grammars: NFOS_ONLY,
  requiresAny: NAT_CAPABILITIES,
  since: 'P2',
} as const;

const NACL_LINE = {
  mode: 'config-std-nacl',
  privilege: 15,
  allowNo: true,
  grammars: NFOS_ONLY,
  requiresAny: NAT_CAPABILITIES,
  since: 'P2',
  objectives: ['CCNA2.8.1'],
} as const;

/** One named-list entry spec per action and source form. */
function naclSpec(action: 'permit' | 'deny', form: 'any' | 'host' | 'address'): CommandSpec {
  const help = action === 'permit' ? 'Allow the matching sources' : 'Refuse the matching sources';
  switch (form) {
    case 'any':
      return { ...NACL_LINE, path: [action, 'any'], help: `${help} (every address)`, handler: H.naclEntry, fixedArgs: { [ACL_ACTION_ARG]: action, [ACL_SOURCE_FORM_ARG]: 'any' } };
    case 'host':
      return { ...NACL_LINE, path: [action, 'host', '<address>'], help: `${help} (one host)`, args: { address: HOST_ARG }, handler: H.naclEntry, fixedArgs: { [ACL_ACTION_ARG]: action, [ACL_SOURCE_FORM_ARG]: 'host' } };
    default:
      return { ...NACL_LINE, path: [action, '<address>', '<wildcard>'], help: `${help} (an address, or a network with its wildcard)`, args: { address: ADDRESS_ARG, wildcard: WILDCARD_ARG }, handler: H.naclEntry, fixedArgs: { [ACL_ACTION_ARG]: action, [ACL_SOURCE_FORM_ARG]: 'address' } };
  }
}

/** The access-list command table. */
export const ACL_GRAMMAR: readonly CommandSpec[] = Object.freeze<CommandSpec[]>([
  {
    // the short `no access-list <n>` form (removes the whole list); typed positively it asks for an entry
    ...GLOBAL_LINE,
    path: ['access-list', '<number>'],
    help: 'Remove a whole numbered list (no access-list <n>)',
    args: { number: NUMBER_ARG },
    handler: H.configAccessList,
    hidden: true,
    objectives: ['CCNA2.8.1'],
  },
  {
    ...GLOBAL_LINE,
    path: ['access-list', '<number>', '<action>', 'any'],
    help: 'An entry that matches every source address',
    args: { number: NUMBER_ARG, action: ACTION_ARG },
    handler: H.configAccessList,
    fixedArgs: { [ACL_SOURCE_FORM_ARG]: 'any' },
    objectives: ['CCNA2.8.1'],
  },
  {
    ...GLOBAL_LINE,
    path: ['access-list', '<number>', '<action>', 'host', '<address>'],
    help: 'An entry that matches one host',
    args: { number: NUMBER_ARG, action: ACTION_ARG, address: HOST_ARG },
    handler: H.configAccessList,
    fixedArgs: { [ACL_SOURCE_FORM_ARG]: 'host' },
    objectives: ['CCNA2.8.1'],
  },
  {
    ...GLOBAL_LINE,
    path: ['access-list', '<number>', '<action>', '<address>', '<wildcard>'],
    help: 'An entry that matches an address, or a network with its wildcard mask',
    args: { number: NUMBER_ARG, action: ACTION_ARG, address: ADDRESS_ARG, wildcard: WILDCARD_ARG },
    handler: H.configAccessList,
    fixedArgs: { [ACL_SOURCE_FORM_ARG]: 'address' },
    objectives: ['CCNA2.8.1'],
  },
  {
    ...GLOBAL_LINE,
    path: ['ip', 'access-list', 'standard', '<name>'],
    help: 'Create or edit a named standard access list',
    args: { name: wordArg('List name', { maxLength: 64 }) },
    handler: H.configIpAccessListStandard,
    entersMode: 'config-std-nacl',
    sessionEffect: 'enter-mode',
    objectives: ['CCNA2.8.1'],
  },
  naclSpec('permit', 'any'),
  naclSpec('permit', 'host'),
  naclSpec('permit', 'address'),
  naclSpec('deny', 'any'),
  naclSpec('deny', 'host'),
  naclSpec('deny', 'address'),
  {
    path: ['show', 'access-lists'],
    mode: '@exec',
    privilege: 1,
    help: 'Every access list with its entries in order',
    handler: H.showAccessLists,
    filterable: true,
    grammars: NFOS_ONLY,
    requiresAny: NAT_CAPABILITIES,
    since: 'P2',
    objectives: ['CCNA2.8.1'],
  },
]);
