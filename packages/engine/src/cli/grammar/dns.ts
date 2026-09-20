/**
 * cli/grammar/dns.ts — the name-resolution command surface (ARCHITECTURE-P1 §4.4, §6 P1 table).
 *
 * Resolver side: `ip name-server`, `ip domain-name`, `no ip domain-lookup` (a stored negation, so the resolver sees
 * that lookups are off) and `ip host` (a static entry both the resolver and the server answer from). Server side:
 * `ip dns server` and the `ip dns record` extension. `show hosts` prints the static entries and the resolver cache;
 * `nslookup` is a blocking job that asks dns-client for one name.
 *
 * `ping <name>` lives here too: the shared `ping A.B.C.D` of core-exec.ts keeps its address form and its caret
 * message, and the name form only exists where a resolver runs, so a switch still cannot type one (§4.7-§4.8,
 * §10.2 accept.p1.host-shell). icmpv4 resolves the name and pings the first address.
 *
 * `nslookup` exists in both shells (a host types it at its prompt, a router at EXEC), so it carries no `grammars`.
 * Scope otherwise follows the daemons: the resolver lines need a capability whose daemon list holds `dns-client`,
 * the server lines one that holds `dns-server`. Help strings are original wording (spec §1.6).
 *
 * ponytail: `ip name-server` and `ip host` take at most two addresses, and `ip dns record` writes the four-token
 * form the server parses (a missing TTL becomes DNS_DEFAULT_TTL_S in the handler) rather than a second spec.
 */
import type { CommandSpec } from '../../contracts/cli.js';
import type { Capability } from '../../contracts/catalog.js';
import type { GrammarDebugCategory } from './core-exec.js';
import { capabilitiesRunning, choiceArg, debugSpecs, intArg, ipArg, nameArg, NFOS_ONLY, wordArg } from './core-exec.js';

/** Handler ids of the DNS commands. */
export const DNS_HANDLERS = {
  configNameServer: 'config.ip-name-server',
  configDomainName: 'config.ip-domain-name',
  configDomainLookup: 'config.ip-domain-lookup',
  configIpHost: 'config.ip-host',
  configDnsServer: 'config.ip-dns-server',
  configDnsRecord: 'config.ip-dns-record',
  showHosts: 'show.hosts',
  execNslookup: 'exec.nslookup',
  execPingName: 'exec.ping-name',
} as const;

/** Capabilities that run the stub resolver and the name server. */
export const DNS_CLIENT_CAPABILITIES: readonly Capability[] = capabilitiesRunning('dns-client');
export const DNS_SERVER_CAPABILITIES: readonly Capability[] = capabilitiesRunning('dns-server');

/** Both DNS daemons stamp their events with this one category. */
export const DNS_DEBUG_CATEGORIES: readonly GrammarDebugCategory[] = Object.freeze([
  {
    category: 'dns',
    help: 'Trace name queries, answers and cache entries',
    requiresAny: capabilitiesRunning('dns-client', 'dns-server'),
    since: 'P1',
  },
]);

/** Objectives of the DNS debug category. */
export const DNS_DEBUG_OBJECTIVES: Readonly<Record<string, readonly string[]>> = { dns: ['CCNA1.11.1'] };

/** Record types `ip dns record` accepts (the set the name server can answer). */
export const DNS_RECORD_TYPES: readonly string[] = Object.freeze(['A', 'AAAA', 'CNAME', 'NS', 'PTR']);

const H = DNS_HANDLERS;

/** The DNS command table. */
export const DNS_GRAMMAR: readonly CommandSpec[] = Object.freeze<CommandSpec[]>([
  {
    path: ['ip', 'name-server', '<first>', '<second>'],
    mode: 'config',
    privilege: 15,
    help: 'Name servers this device asks to resolve names',
    args: { first: ipArg('Name server address'), second: ipArg('Second name server address', true) },
    handler: H.configNameServer,
    allowNo: true,
    noArgsOptional: true,
    grammars: NFOS_ONLY,
    requiresAny: DNS_CLIENT_CAPABILITIES,
    since: 'P1',
    objectives: ['CCNA1.11.1'],
  },
  {
    path: ['ip', 'domain-name', '<name>'],
    mode: 'config',
    privilege: 15,
    help: 'Domain this device belongs to',
    args: { name: nameArg('Domain name, e.g. lab.nf') },
    handler: H.configDomainName,
    allowNo: true,
    noArgsOptional: true,
    grammars: NFOS_ONLY,
    requiresAny: DNS_CLIENT_CAPABILITIES,
    since: 'P1',
    objectives: ['CCNA1.11.1'],
  },
  {
    path: ['ip', 'domain-lookup'],
    mode: 'config',
    privilege: 15,
    help: 'Resolve names through the configured name servers (no form turns it off)',
    handler: H.configDomainLookup,
    allowNo: true,
    grammars: NFOS_ONLY,
    requiresAny: DNS_CLIENT_CAPABILITIES,
    since: 'P1',
    objectives: ['CCNA1.11.1'],
  },
  {
    path: ['ip', 'host', '<name>', '<first>', '<second>'],
    mode: 'config',
    privilege: 15,
    help: 'Give a name to an address without asking a name server',
    args: {
      name: nameArg('Name to define'),
      first: ipArg('Address of the name'),
      second: ipArg('Second address of the name', true),
    },
    handler: H.configIpHost,
    allowNo: true,
    noArgsOptional: true,
    grammars: NFOS_ONLY,
    requiresAny: DNS_CLIENT_CAPABILITIES,
    since: 'P1',
    objectives: ['CCNA1.11.1'],
  },
  {
    path: ['ip', 'dns', 'server'],
    mode: 'config',
    privilege: 15,
    help: 'Answer name queries from other devices',
    handler: H.configDnsServer,
    allowNo: true,
    grammars: NFOS_ONLY,
    requiresAny: DNS_SERVER_CAPABILITIES,
    since: 'P1',
    objectives: ['CCNA1.11.1'],
  },
  {
    path: ['ip', 'dns', 'record', '<name>', '<type>', '<data>', '<ttl>'],
    mode: 'config',
    privilege: 15,
    help: 'Add one record to the zone this device serves (NetForge extension)',
    args: {
      name: nameArg('Name the record answers for'),
      type: choiceArg('Record type', DNS_RECORD_TYPES),
      data: wordArg('Address for A and AAAA, target name for CNAME, NS and PTR', { maxLength: 253 }),
      ttl: intArg('How long an answer may be cached, in seconds', 0, 604_800, true),
    },
    handler: H.configDnsRecord,
    allowNo: true,
    noArgsOptional: true,
    extension: true,
    grammars: NFOS_ONLY,
    requiresAny: DNS_SERVER_CAPABILITIES,
    since: 'P1',
    objectives: ['CCNA1.11.1'],
  },
  {
    path: ['show', 'hosts'],
    mode: '@exec',
    privilege: 1,
    help: 'Static names and what the resolver has cached',
    filterable: true,
    handler: H.showHosts,
    requiresAny: DNS_CLIENT_CAPABILITIES,
    since: 'P1',
    objectives: ['CCNA1.11.1'],
  },
  {
    // `ping <name>` is a second spec beside the address form of core-exec.ts: a dotted-decimal token still matches
    // the address spec first, and a name can only be typed where the resolver runs (§10.2 accept.p1.host-shell).
    path: ['ping', '<name>'],
    mode: '@exec',
    privilege: 1,
    help: 'Send echo requests to a host by name',
    args: { name: nameArg('Name of the host to reach') },
    handler: H.execPingName,
    job: true,
    requiresAny: DNS_CLIENT_CAPABILITIES,
    since: 'P1',
    objectives: ['CCNA1.11.1'],
  },
  {
    path: ['nslookup', '<name>', '<server>'],
    mode: '@exec',
    privilege: 1,
    help: 'Ask a name server for the addresses of a name',
    args: { name: nameArg('Name to look up'), server: ipArg('Name server to ask instead of the configured ones', true) },
    handler: H.execNslookup,
    job: true,
    requiresAny: DNS_CLIENT_CAPABILITIES,
    since: 'P1',
    objectives: ['CCNA1.11.1'],
  },
  ...debugSpecs(DNS_DEBUG_CATEGORIES, DNS_DEBUG_OBJECTIVES),
]);
