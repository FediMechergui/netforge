/**
 * cli/grammar/services.ts — the web service a device can offer (ARCHITECTURE-P1 §4.5, §6 P1 table).
 *
 * `ip http server` starts the listener; `ip http page PATH <text>` is the NetForge extension that gives a path its
 * body, so a lab can serve more than the default page without a file system. Scope follows the daemon: a capability
 * whose derived list holds `http-server`.
 *
 * A server runs the HOST shell, which has no configuration modes, so §6 gives it the `service …` expansions: they
 * write exactly the router-form lines above (and the DNS and DHCP ones of the dns.ts and dhcp.ts fragments). The
 * Services panel builds the same lines. Help strings are original wording (spec §1.6).
 *
 * ponytail: no port, no authentication and no TLS — `https:` is answered by the browser tab, not by a listener; the
 * `service dhcp` expansion keeps one pool, named SERVICE_POOL_NAME, which is all a one-subnet lab needs.
 */
import type { CommandSpec } from '../../contracts/cli.js';
import type { Capability } from '../../contracts/catalog.js';
import { capabilitiesRunning, choiceArg, HOST_ONLY, intArg, ipv4Arg, maskArg, NFOS_ONLY, restArg, wordArg } from './core-exec.js';
import { DHCP_SERVER_CAPABILITIES } from './dhcp.js';
import { DNS_RECORD_TYPES, DNS_SERVER_CAPABILITIES } from './dns.js';

/** Handler ids of the service commands. */
export const SERVICES_HANDLERS = {
  configHttpServer: 'config.ip-http-server',
  configHttpPage: 'config.ip-http-page',
  hostService: 'host.service',
} as const;

/** Services the host-shell `service …` expansion switches on and off. */
export const HOST_SERVICES: readonly string[] = Object.freeze(['dhcp', 'dns', 'http']);
/** Name of the one address pool `service dhcp` writes. */
export const SERVICE_POOL_NAME = 'SERVICE';

/**
 * Arg name (`fixedArgs`) that tells the one `service …` handler which sub-form was typed. Every optional arg of a
 * sub-form may be absent (`no service http page` takes none), so the form can never be inferred from the args.
 */
export const SERVICE_FORM_ARG = 'form';
/** Values of SERVICE_FORM_ARG, one per `service …` sub-form. */
export const SERVICE_FORM_HTTP_PAGE = 'http-page';
export const SERVICE_FORM_DNS_RECORD = 'dns-record';
export const SERVICE_FORM_DHCP_POOL = 'dhcp-pool';

/** Capabilities that run the web server. */
export const HTTP_SERVER_CAPABILITIES: readonly Capability[] = capabilitiesRunning('http-server');

/**
 * Path of a page served by `ip http page`: an absolute path without spaces, and without a query or fragment —
 * http-server keys its pages by the path alone, so `/b?x=1` would silently shadow `/b` instead of being served.
 */
export const HTTP_PAGE_PATTERN = '/[!$&-;=@-\\[\\]_a-z~%]*';

const H = SERVICES_HANDLERS;

/** The service command table. */
export const SERVICES_GRAMMAR: readonly CommandSpec[] = Object.freeze<CommandSpec[]>([
  {
    path: ['ip', 'http', 'server'],
    mode: 'config',
    privilege: 15,
    help: 'Answer web requests on this device',
    handler: H.configHttpServer,
    allowNo: true,
    grammars: NFOS_ONLY,
    requiresAny: HTTP_SERVER_CAPABILITIES,
    since: 'P1',
    objectives: ['CCNA1.11.4'],
  },
  {
    path: ['ip', 'http', 'page', '<path>', '<body>'],
    mode: 'config',
    privilege: 15,
    help: 'Text this device serves at one path (NetForge extension)',
    args: {
      path: wordArg('Path, starting with a slash', { maxLength: 120, pattern: HTTP_PAGE_PATTERN }),
      body: restArg('Page text', 1000),
    },
    handler: H.configHttpPage,
    allowNo: true,
    noArgsOptional: true,
    extension: true,
    grammars: NFOS_ONLY,
    requiresAny: HTTP_SERVER_CAPABILITIES,
    since: 'P1',
    objectives: ['CCNA1.11.4'],
  },
  {
    path: ['service', '<service>', '<state>'],
    mode: 'user-exec',
    privilege: 15,
    help: 'Switch one of the network services of this server on or off',
    args: {
      service: choiceArg('Service to switch', HOST_SERVICES),
      state: choiceArg('on starts the service, off stops it', ['on', 'off']),
    },
    handler: H.hostService,
    grammars: HOST_ONLY,
    requiresAny: HTTP_SERVER_CAPABILITIES,
    since: 'P1',
    objectives: ['CCNA1.11.4'],
  },
  {
    path: ['service', 'http', 'page', '<path>', '<body>'],
    mode: 'user-exec',
    privilege: 15,
    help: 'Text this server returns at one path',
    args: {
      path: wordArg('Path, starting with a slash', { maxLength: 120, pattern: HTTP_PAGE_PATTERN }),
      body: restArg('Page text', 1000),
    },
    handler: H.hostService,
    fixedArgs: { [SERVICE_FORM_ARG]: SERVICE_FORM_HTTP_PAGE },
    allowNo: true,
    noArgsOptional: true,
    grammars: HOST_ONLY,
    requiresAny: HTTP_SERVER_CAPABILITIES,
    since: 'P1',
    objectives: ['CCNA1.11.4'],
  },
  {
    path: ['service', 'dns', 'record', '<name>', '<type>', '<data>', '<ttl>'],
    mode: 'user-exec',
    privilege: 15,
    help: 'Add one record to the zone this server answers for',
    args: {
      name: wordArg('Name the record answers for', { maxLength: 253 }),
      type: choiceArg('Record type', DNS_RECORD_TYPES),
      data: wordArg('Address for A and AAAA, target name for CNAME, NS and PTR', { maxLength: 253 }),
      ttl: intArg('How long an answer may be cached, in seconds', 0, 604_800, true),
    },
    handler: H.hostService,
    fixedArgs: { [SERVICE_FORM_ARG]: SERVICE_FORM_DNS_RECORD },
    allowNo: true,
    noArgsOptional: true,
    grammars: HOST_ONLY,
    requiresAny: DNS_SERVER_CAPABILITIES,
    since: 'P1',
    objectives: ['CCNA1.11.1'],
  },
  {
    path: ['service', 'dhcp', 'pool', '<network>', '<mask>', '<router>'],
    mode: 'user-exec',
    privilege: 15,
    help: 'Subnet this server leases addresses from',
    args: {
      network: ipv4Arg('Network address'),
      mask: maskArg('Subnet mask'),
      router: ipv4Arg('Default gateway handed to the clients', true),
    },
    handler: H.hostService,
    fixedArgs: { [SERVICE_FORM_ARG]: SERVICE_FORM_DHCP_POOL },
    grammars: HOST_ONLY,
    requiresAny: DHCP_SERVER_CAPABILITIES,
    since: 'P1',
    objectives: ['CCNA1.11.3'],
  },
]);
