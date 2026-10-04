/**
 * cli/grammar/acl.ts — IPv4 access lists.
 *
 * P2 (ARCHITECTURE-P2 §3.9, §5.2, §5.4, D14; §7 W3 cli): standard lists pulled forward from CCNA 3 for NAT —
 * numbered `access-list <1-99|1300-1999> permit|deny <a> [<wildcard>] | host <a> | any` (global, one stored line per
 * entry), the named section `ip access-list standard <name>` (mode `config-std-nacl`) with `permit|deny …` children,
 * and `show access-lists`. core/acl.ts reads the stored lines; the handler stores each entry in its canonical form
 * (`standardAclEntryTokens`).
 *
 * P3 (ARCHITECTURE-P3 §5.2, §5.8, D12, D14; §7 W2 cli part 1), the separate `ACL_P3_GRAMMAR` (folded as the P3
 * fragment `acl-p3`, so the P2 fragment keeps only P2 specs):
 *   • standard entries gain a trailing `log`; extended lists `access-list <100-199|2000-2699> permit|deny <protocol>
 *     <source> [<ports>] <destination> [<ports>] [established] [<icmp-message> | <type> <code>] [log]` and `access-list
 *     <n> remark <text>`; the section `ip access-list extended <name|number>` (mode `config-ext-nacl`);
 *   • in both list sections an entry may start with its sequence number (`15 permit …`), `no <seq>` removes one, and
 *     `remark <text>` annotates; `ip access-list resequence <list> <start> <step>` renumbers (not stored);
 *   • `ip access-group <list> in|out` on L3 interfaces (one per direction, D12), `clear access-list counters [<list>]`,
 *     `show access-lists [<list>]`, `show ip access-lists [<list>]` and `show ip interface [<if>]`;
 *   • (W3, cli part 2) the debug category `ip access-list` (§5.8, a NetForge extension: matches and log aggregation;
 *     protocols/acl.ts `ACL_DEBUG_CATEGORY`), `ACL_DEBUG_CATEGORIES`.
 * Every ACL line is offered on `routing` and `managed-switch` models (D14: lessons 15 and 19 put a vty list on a
 * switch); the P2 specs are widened to the same scope. An address is `any`, `host <a>` or `<a> <wildcard>`; ports are
 * `eq|neq|lt|gt <port>` or `range <low> <high>` with core/acl's port names; ICMP messages by name or `<type> <code>`.
 * The spec table is generated from those forms (each optional keyword is a separate literal path or a trailing
 * optional `log`, so no two complete matches tie). Help strings are original wording (spec §1.6).
 */
import type { ArgSpec, CommandSpec, PortRequirement } from '../../contracts/cli.js';
import type { Capability, PortRole } from '../../contracts/catalog.js';
import { ACL_ICMP_NAMES, ACL_TCP_PORT_NAMES, ACL_UDP_PORT_NAMES } from '../../core/acl.js';
import { choiceArg, debugSpecs, type GrammarDebugCategory, ifaceArg, intArg, ipv4Arg, NFOS_ONLY, restArg, wordArg } from './core-exec.js';

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

/**
 * @since P3 (D14) Capabilities offered every ACL line: routers and managed switches (lessons 15 and 19 put a vty list on
 * a switch). The P2 specs below were scoped to `routing` only (the NAT capabilities) until W2.
 */
export const ACL_CAPABILITIES: readonly Capability[] = Object.freeze(['routing', 'managed-switch']);

const GLOBAL_LINE = {
  mode: 'config',
  privilege: 15,
  allowNo: true,
  grammars: NFOS_ONLY,
  requiresAny: ACL_CAPABILITIES,
  since: 'P2',
} as const;

const NACL_LINE = {
  mode: 'config-std-nacl',
  privilege: 15,
  allowNo: true,
  grammars: NFOS_ONLY,
  requiresAny: ACL_CAPABILITIES,
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
    requiresAny: ACL_CAPABILITIES,
    since: 'P2',
    objectives: ['CCNA2.8.1'],
  },
]);

// ── P3 (ARCHITECTURE-P3 §5.2, §5.8, D12, D14; §7 W2 cli part 1) ──────────────────────────────────────────────────

/** @since P3 Handler ids of the P3 access-list lines and shows. Never rename. */
export const ACL_P3_HANDLERS = {
  configAccessListEntry: 'config.access-list-entry',
  configAccessListRemark: 'config.access-list-remark',
  configIpAccessListExtended: 'config.ip-access-list-extended',
  naclEntryP3: 'nacl.entry-p3',
  naclRemark: 'nacl.remark',
  naclSeq: 'nacl.seq',
  configIpAccessListResequence: 'config.ip-access-list-resequence',
  ifIpAccessGroup: 'if.ip-access-group',
  execClearAccessListCounters: 'exec.clear-access-list-counters',
  showIpInterface: 'show.ip-interface',
} as const;

/**
 * @since P3 `fixedArgs` keys of the generated entry specs: the list type, the protocol of a literal protocol path
 * (`tcp`, `udp`, `icmp`; absent = the `<protocol>` arg), the source and destination address forms (`any` | `host` |
 * `net`), their port forms (`none` | `op` | `range`), `established`, the ICMP form (`none` | `msg` | `code`), the action
 * of a section path that starts with it, and a literal `log`.
 */
export const ACL_FORM = Object.freeze({
  type: 'type',
  proto: 'proto',
  src: 'srcForm',
  dst: 'dstForm',
  sport: 'sportForm',
  dport: 'dportForm',
  established: 'established',
  icmp: 'icmpForm',
  action: 'action',
  log: 'log',
} as const);

/** @since P3 Largest list number (extended 2000-2699); the handler checks the four ranges (`aclNumberRange`). */
export const ACL_P3_NUMBER_MAX = 2699;
/** @since P3 Largest sequence number (a positive 32-bit signed integer, `CONFIG_SEQ_MAX`). */
export const ACL_SEQ_MAX = 2_147_483_647;
/** @since P3 Port operators of an extended entry (besides `range`). */
export const ACL_PORT_OPS = Object.freeze(['eq', 'neq', 'lt', 'gt'] as const);
/** @since P3 Protocol names of the `<protocol>` arg (tcp, udp and icmp have their own literal paths). */
export const ACL_GENERIC_PROTOCOLS = Object.freeze(['ip', 'igmp', 'gre', 'esp', 'ahp', 'eigrp', 'ospf', 'pim'] as const);

type AddrForm = 'any' | 'host' | 'net';
type PortForm = 'none' | 'op' | 'range';
type IcmpForm = 'none' | 'msg' | 'code';
const ADDR_FORMS: readonly AddrForm[] = ['any', 'host', 'net'];
const PORT_FORMS: readonly PortForm[] = ['none', 'op', 'range'];
const ICMP_FORMS: readonly IcmpForm[] = ['none', 'msg', 'code'];

const OBJ_EXT = ['CCNA3.acl.2', 'CCNA3.acl.3'];
const OBJ_EST = ['CCNA3.acl.2', 'CCNA3.acl.5'];
const OBJ_EDIT = ['CCNA3.acl.7'];
const OBJ_LOG = ['CCNA3.acl.8'];

/**
 * A named-number arg whose names are read at call time (rule 12: no module-scope read of core/acl's tables). The
 * parser's P3 reading of an `int` arg with `choices` accepts a number in range or one of the names.
 */
function lazyNamedNumber(help: string, max: number, names: () => readonly string[]): ArgSpec {
  return Object.freeze({
    type: 'int' as const,
    help,
    min: 0,
    max,
    get choices(): readonly string[] {
      return names();
    },
  });
}

const tcpPortNames = (): readonly string[] => ACL_TCP_PORT_NAMES.map(([n]) => n).sort();
const udpPortNames = (): readonly string[] => ACL_UDP_PORT_NAMES.map(([n]) => n).sort();
const icmpNames = (): readonly string[] => ACL_ICMP_NAMES.map(([n]) => n).sort();

const P3_NUMBER_ARG = intArg('List number: 1-99 or 1300-1999 (standard), 100-199 or 2000-2699 (extended)', 1, ACL_P3_NUMBER_MAX);
const P3_ACTION_ARG = choiceArg('permit: match and allow; deny: match and refuse', ['permit', 'deny']);
const SEQ_ARG = intArg('Sequence number of the entry (its place in the list)', 1, ACL_SEQ_MAX);
const LOG_ARG: ArgSpec = choiceArg('log: report the first packet of each flow, then a count every 5 minutes', ['log'], true);
const PROTOCOL_ARG: ArgSpec = Object.freeze({
  type: 'int' as const,
  help: 'IP protocol by name or number (ip matches every packet)',
  min: 0,
  max: 255,
  choices: ACL_GENERIC_PROTOCOLS,
});
const PORT_OP_ARG = choiceArg('eq: equal, neq: not equal, lt: lower than, gt: greater than', ACL_PORT_OPS);

/** The address args of one side. */
function addrArgs(side: 'src' | 'dst'): Record<string, ArgSpec> {
  const what = side === 'src' ? 'Source' : 'Destination';
  return {
    [side]: ipv4Arg(`${what} address (a network when a wildcard follows)`),
    [`${side}Wild`]: ipv4Arg('Wildcard mask: 1 bits are ignored (0.0.0.255 = a /24)'),
  };
}

/** The path elements of one address form. */
function addrPath(side: 'src' | 'dst', form: AddrForm): string[] {
  if (form === 'any') return ['any'];
  if (form === 'host') return ['host', `<${side}>`];
  return [`<${side}>`, `<${side}Wild>`];
}

/** The path elements of one port form (`sport`/`dport` prefix the arg names). */
function portPath(side: 'sport' | 'dport', form: PortForm): string[] {
  if (form === 'none') return [];
  if (form === 'op') return [`<${side}Op>`, `<${side}>`];
  return ['range', `<${side}>`, `<${side}High>`];
}

function portArgs(side: 'sport' | 'dport', proto: 'tcp' | 'udp'): Record<string, ArgSpec> {
  const names = proto === 'tcp' ? tcpPortNames : udpPortNames;
  const what = side === 'sport' ? 'Source port' : 'Destination port';
  return {
    [`${side}Op`]: PORT_OP_ARG,
    [side]: lazyNamedNumber(`${what}: a number or a name`, 65535, names),
    [`${side}High`]: lazyNamedNumber(`Highest ${what.toLowerCase()} of the range`, 65535, names),
  };
}

/** Help of a generated spec, from the last literal of its path (the token `?` shows it for). */
const LAST_LITERAL_HELP: Readonly<Record<string, string>> = Object.freeze({
  any: 'Any address',
  host: 'One host address',
  range: 'A range of ports, lowest and highest',
  established: 'Only segments of connections already open (ACK or RST set)',
  tcp: 'TCP segments',
  udp: 'UDP datagrams',
  icmp: 'ICMP messages',
  log: 'Report the first packet of each flow, then a count every 5 minutes',
  permit: 'Allow the matching packets',
  deny: 'Refuse the matching packets',
  'access-list': 'An access list entry',
});

function isArgElement(el: string): boolean {
  return el.length > 2 && el.startsWith('<') && el.endsWith('>');
}

function lastLiteral(path: readonly string[]): string {
  for (let i = path.length - 1; i >= 0; i--) {
    const el = path[i] as string;
    if (!isArgElement(el)) return el;
  }
  return '';
}

/** Only the args a path names (the structure rule: every ArgSpec is referenced). */
function argsFor(path: readonly string[], pool: Readonly<Record<string, ArgSpec>>): Record<string, ArgSpec> {
  const out: Record<string, ArgSpec> = {};
  for (const el of path) {
    if (!isArgElement(el)) continue;
    const name = el.slice(1, -1);
    const a = pool[name];
    if (a !== undefined) out[name] = a;
  }
  return out;
}

/** Where a generated entry sits: the leading path, the spec flags and the args the lead names. */
interface EntryLead {
  readonly path: readonly string[];
  readonly base: Omit<CommandSpec, 'path' | 'help' | 'handler' | 'objectives' | 'args' | 'fixedArgs'>;
  readonly handler: string;
  readonly args: Readonly<Record<string, ArgSpec>>;
  readonly fixed: Readonly<Record<string, string>>;
}

function entrySpec(lead: EntryLead, body: readonly string[], pool: Record<string, ArgSpec>, fixed: Record<string, string>, objectives: readonly string[]): CommandSpec {
  const path = [...lead.path, ...body];
  const all = { ...lead.args, ...pool, log: LOG_ARG };
  return {
    ...lead.base,
    path,
    help: LAST_LITERAL_HELP[lastLiteral(path)] ?? 'An access list entry',
    args: argsFor(path, all),
    handler: lead.handler,
    fixedArgs: { ...lead.fixed, ...fixed },
    objectives,
  };
}

/** Every extended entry form after `lead` (ARCHITECTURE-P3 §5.2): generic protocols, ICMP, TCP and UDP. */
function extendedEntrySpecs(lead: EntryLead): CommandSpec[] {
  const out: CommandSpec[] = [];
  const t = { [ACL_FORM.type]: 'extended' };
  const addrPool = { ...addrArgs('src'), ...addrArgs('dst') };
  for (const s of ADDR_FORMS) {
    for (const d of ADDR_FORMS) {
      const body = ['<protocol>', ...addrPath('src', s), ...addrPath('dst', d), '<log>'];
      out.push(entrySpec(lead, body, { ...addrPool, protocol: PROTOCOL_ARG }, { ...t, [ACL_FORM.src]: s, [ACL_FORM.dst]: d }, OBJ_EXT));
    }
  }
  const icmpPool = {
    ...addrPool,
    icmp: lazyNamedNumber('ICMP message by name, or its type number', 255, icmpNames),
    icmpType: intArg('ICMP type', 0, 255),
    icmpCode: intArg('ICMP code', 0, 255),
  };
  for (const s of ADDR_FORMS) {
    for (const d of ADDR_FORMS) {
      for (const i of ICMP_FORMS) {
        const tail = i === 'none' ? [] : i === 'msg' ? ['<icmp>'] : ['<icmpType>', '<icmpCode>'];
        const body = ['icmp', ...addrPath('src', s), ...addrPath('dst', d), ...tail, '<log>'];
        out.push(entrySpec(lead, body, icmpPool, { ...t, [ACL_FORM.proto]: 'icmp', [ACL_FORM.src]: s, [ACL_FORM.dst]: d, [ACL_FORM.icmp]: i }, OBJ_EXT));
      }
    }
  }
  for (const proto of ['tcp', 'udp'] as const) {
    const pool = { ...addrPool, ...portArgs('sport', proto), ...portArgs('dport', proto) };
    for (const s of ADDR_FORMS) {
      for (const sp of PORT_FORMS) {
        for (const d of ADDR_FORMS) {
          for (const dp of PORT_FORMS) {
            for (const est of proto === 'tcp' ? [false, true] : [false]) {
              const body = [proto, ...addrPath('src', s), ...portPath('sport', sp), ...addrPath('dst', d), ...portPath('dport', dp), ...(est ? ['established'] : []), '<log>'];
              const fixed: Record<string, string> = { ...t, [ACL_FORM.proto]: proto, [ACL_FORM.src]: s, [ACL_FORM.sport]: sp, [ACL_FORM.dst]: d, [ACL_FORM.dport]: dp };
              if (est) fixed[ACL_FORM.established] = 'established';
              out.push(entrySpec(lead, body, pool, fixed, est ? OBJ_EST : OBJ_EXT));
            }
          }
        }
      }
    }
  }
  return out;
}

/**
 * Standard entry forms after `lead`. `literalLog` (the leads that share their prefix with a P2 spec): `log` is a
 * literal, so the P2 spec and this one never both complete; otherwise a trailing optional `<log>`.
 */
function standardEntrySpecs(lead: EntryLead, literalLog: boolean): CommandSpec[] {
  const t = { [ACL_FORM.type]: 'standard' };
  const pool = { src: ipv4Arg('Source address (a network when a wildcard follows)'), srcWild: ipv4Arg('Wildcard mask: 1 bits are ignored (0.0.0.255 = a /24)') };
  const log = literalLog ? ['log'] : ['<log>'];
  const fixedLog: Record<string, string> = literalLog ? { [ACL_FORM.log]: 'log' } : {};
  return [
    entrySpec(lead, ['any', ...log], pool, { ...t, ...fixedLog, [ACL_FORM.src]: 'any' }, OBJ_LOG),
    entrySpec(lead, ['host', '<src>', ...log], pool, { ...t, ...fixedLog, [ACL_FORM.src]: 'host' }, OBJ_LOG),
    entrySpec(lead, ['<src>', ...log], pool, { ...t, ...fixedLog, [ACL_FORM.src]: 'host' }, OBJ_LOG),
    entrySpec(lead, ['<src>', '<srcWild>', ...log], pool, { ...t, ...fixedLog, [ACL_FORM.src]: 'net' }, OBJ_LOG),
  ];
}

/**
 * @since P3 The access-list debug category (§5.8, a NetForge extension: every match and the log aggregation; the acl
 * daemon's `ACL_DEBUG_CATEGORY`), offered where the acl daemon runs. A literal (rule 12).
 */
export const ACL_DEBUG_CATEGORIES: readonly GrammarDebugCategory[] = Object.freeze([
  { category: 'ip access-list', help: 'Trace access-list matches and the aggregated log lines', requiresAny: ACL_CAPABILITIES, since: 'P3' },
]);

/** @since P3 Objectives of the access-list debug category. */
export const ACL_DEBUG_OBJECTIVES: Readonly<Record<string, readonly string[]>> = Object.freeze({ 'ip access-list': ['CCNA3.acl.7', 'CCNA3.acl.8'] });

const P3_GLOBAL = {
  mode: 'config',
  privilege: 15,
  allowNo: true,
  grammars: NFOS_ONLY,
  requiresAny: ACL_CAPABILITIES,
  since: 'P3',
} as const;

/** The numbered entries (`access-list <n> permit|deny …`). */
const NUMBERED_LEAD: EntryLead = {
  path: ['access-list', '<number>', '<action>'],
  base: P3_GLOBAL,
  handler: 'config.access-list-entry',
  args: { number: P3_NUMBER_ARG, action: P3_ACTION_ARG },
  fixed: {},
};

/** The entries of a list section, without a sequence number (`permit …` / `deny …`; the action is the literal). */
function sectionLead(mode: 'config-std-nacl' | 'config-ext-nacl', action: 'permit' | 'deny'): EntryLead {
  return {
    path: [action],
    base: { ...P3_GLOBAL, mode },
    handler: 'nacl.entry-p3',
    args: {},
    fixed: { [ACL_FORM.action]: action },
  };
}

/** The entries of a list section that start with their sequence number (`15 permit …`). */
function seqLead(mode: 'config-std-nacl' | 'config-ext-nacl'): EntryLead {
  return {
    path: ['<seq>', '<action>'],
    base: { ...P3_GLOBAL, mode },
    handler: 'nacl.entry-p3',
    args: { seq: SEQ_ARG, action: P3_ACTION_ARG },
    fixed: {},
  };
}

const ACL_NAME_ARG = wordArg('List name, or a number of the list type', { maxLength: 64 });
const REMARK_ARG = restArg('Comment text (up to 100 characters)', 100);

/**
 * @since P3 Ports `ip access-group` is offered on: the L3 roles of network devices, and switched ports and channels so
 * that the handler refuses those by name (`accessGroupSwitchport`, §5.2). Radio, access-line and host roles never list it.
 */
export const ACCESS_GROUP_ROLES: readonly PortRole[] = Object.freeze(['routed', 'wan', 'mgmt', 'svi', 'virtual', 'subif', 'tunnel', 'switched', 'channel']);
/** @since P3 Mismatch of `ip access-group` on another port. */
export const MSG_ACCESS_GROUP_PORT = '% Access lists filter routed interfaces, VLAN interfaces and subinterfaces.';
const ACCESS_GROUP_PORT: PortRequirement = Object.freeze<PortRequirement>({ roles: ACCESS_GROUP_ROLES, mismatch: MSG_ACCESS_GROUP_PORT });

/** @since P3 The P3 access-list command table (fragment `acl-p3`). */
export const ACL_P3_GRAMMAR: readonly CommandSpec[] = Object.freeze<CommandSpec[]>([
  // numbered lists: standard entries with `log`, every extended form, remarks
  ...standardEntrySpecs(NUMBERED_LEAD, true),
  ...extendedEntrySpecs(NUMBERED_LEAD),
  {
    ...P3_GLOBAL,
    path: ['access-list', '<number>', 'remark', '<text>'],
    help: 'A comment kept with the list (never matched)',
    args: { number: P3_NUMBER_ARG, text: REMARK_ARG },
    handler: ACL_P3_HANDLERS.configAccessListRemark,
    objectives: OBJ_EDIT,
  },
  {
    ...P3_GLOBAL,
    path: ['ip', 'access-list', 'extended', '<name>'],
    help: 'Create or edit a named or numbered extended access list',
    args: { name: ACL_NAME_ARG },
    handler: ACL_P3_HANDLERS.configIpAccessListExtended,
    entersMode: 'config-ext-nacl',
    sessionEffect: 'enter-mode',
    objectives: OBJ_EXT,
  },
  {
    ...P3_GLOBAL,
    path: ['ip', 'access-list', 'resequence', '<list>', '<start>', '<step>'],
    help: 'Renumber the entries of a list from a first number in steps',
    args: { list: ACL_NAME_ARG, start: intArg('Number of the first entry', 1, ACL_SEQ_MAX), step: intArg('Step between two entries', 1, ACL_SEQ_MAX) },
    handler: ACL_P3_HANDLERS.configIpAccessListResequence,
    allowNo: false,
    objectives: OBJ_EDIT,
  },
  // the standard section: `log` on the P2 forms, numbered entries, remarks, `no <seq>`
  ...standardEntrySpecs(sectionLead('config-std-nacl', 'permit'), true),
  ...standardEntrySpecs(sectionLead('config-std-nacl', 'deny'), true),
  ...standardEntrySpecs(seqLead('config-std-nacl'), false),
  // the extended section
  ...extendedEntrySpecs(sectionLead('config-ext-nacl', 'permit')),
  ...extendedEntrySpecs(sectionLead('config-ext-nacl', 'deny')),
  ...extendedEntrySpecs(seqLead('config-ext-nacl')),
  ...(['config-std-nacl', 'config-ext-nacl'] as const).flatMap((mode): CommandSpec[] => [
    {
      ...P3_GLOBAL,
      mode,
      path: ['remark', '<text>'],
      help: 'A comment kept with the list (never matched)',
      args: { text: REMARK_ARG },
      handler: ACL_P3_HANDLERS.naclRemark,
      objectives: OBJ_EDIT,
    },
    {
      // `no 20` removes entry 20; a number alone, typed positively, asks for the entry
      ...P3_GLOBAL,
      mode,
      path: ['<seq>'],
      help: 'Sequence number of the entry',
      args: { seq: SEQ_ARG },
      handler: ACL_P3_HANDLERS.naclSeq,
      objectives: OBJ_EDIT,
    },
  ]),
  {
    path: ['ip', 'access-group', '<list>', '<direction>'],
    mode: ['config-if', 'config-subif'],
    privilege: 15,
    help: 'Filter the packets of this interface with an access list, inbound or outbound',
    args: {
      list: wordArg('List number or name', { maxLength: 64 }),
      direction: choiceArg('in: packets arriving on this interface; out: packets leaving it', ['in', 'out']),
    },
    handler: ACL_P3_HANDLERS.ifIpAccessGroup,
    allowNo: true,
    noArgsOptional: true,
    grammars: NFOS_ONLY,
    requiresAny: ACL_CAPABILITIES,
    portRequires: ACCESS_GROUP_PORT,
    since: 'P3',
    objectives: ['CCNA3.acl.1', 'CCNA3.acl.2'],
  },
  {
    path: ['clear', 'access-list', 'counters', '<list>'],
    mode: 'priv-exec',
    privilege: 15,
    help: 'Set the match counters of every list (or one) back to zero',
    args: { list: wordArg('List number or name', { optional: true, maxLength: 64 }) },
    handler: ACL_P3_HANDLERS.execClearAccessListCounters,
    grammars: NFOS_ONLY,
    requiresAny: ACL_CAPABILITIES,
    since: 'P3',
    objectives: OBJ_EDIT,
  },
  {
    path: ['show', 'access-lists', '<list>'],
    mode: '@exec',
    privilege: 1,
    help: 'One access list with its entries in order',
    args: { list: wordArg('List number or name', { maxLength: 64 }) },
    handler: H.showAccessLists,
    filterable: true,
    grammars: NFOS_ONLY,
    requiresAny: ACL_CAPABILITIES,
    since: 'P3',
    objectives: OBJ_EDIT,
  },
  {
    path: ['show', 'ip', 'access-lists', '<list>'],
    mode: '@exec',
    privilege: 1,
    help: 'The IPv4 access lists with their entries and match counts',
    args: { list: wordArg('Limit the output to one list', { optional: true, maxLength: 64 }) },
    handler: H.showAccessLists,
    filterable: true,
    grammars: NFOS_ONLY,
    requiresAny: ACL_CAPABILITIES,
    since: 'P3',
    objectives: OBJ_EDIT,
  },
  {
    path: ['show', 'ip', 'interface', '<iface>'],
    mode: '@exec',
    privilege: 1,
    // the keyword's existing help text (LITERAL_HELP.interface): this spec's last literal is `interface`, so its help is
    // what `show ip ?` prints for the word, which P1 and P2 already listed (with `brief`)
    help: 'Interface status and settings',
    args: { iface: ifaceArg('Limit the output to one interface', { optional: true }) },
    handler: ACL_P3_HANDLERS.showIpInterface,
    filterable: true,
    grammars: NFOS_ONLY,
    requiresAny: ACL_CAPABILITIES,
    since: 'P3',
    objectives: ['CCNA3.acl.6', 'CCNA3.acl.7'],
  },
  // W3 cli part 2: `debug ip access-list` (§5.8)
  ...debugSpecs(ACL_DEBUG_CATEGORIES, ACL_DEBUG_OBJECTIVES),
]);
