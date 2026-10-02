/**
 * cli/grammar/api.ts — the device API and its host-shell client (ARCHITECTURE-P3 §5.6, D21; §7 W2 cli part 1).
 *
 *   global      `ip http secure-server`, `ip http authentication local`, `restconf` (the restconf daemon listens on
 *               TCP 443 only with both `restconf` and `ip http secure-server`; `restconf` alone is stored with the
 *               `restconfNeedsSecureServer` note)
 *   host shell  `rest <GET|HEAD|POST|PUT|PATCH|DELETE> <url> [-H "<name>: <value>"]… [-u <user>:<password>] [-d
 *               <body…>]`: a job (Ctrl+C aborts it) that sends `http.request {owner: 'cli'}` to http-client, which
 *               prints the status line, the headers and the body. The options are one trailing `rest` argument
 *               (everything after the URL, verbatim); the handler splits it with the host shell's quoting rule
 *               (double quotes only, no escapes) and gives `-d` everything after it, so a JSON body is typed
 *               unquoted and arrives byte for byte (D21). `-d` therefore comes last.
 * The `username … privilege 15 secret` line the API authenticates against is in ssh.ts.
 *
 * Scope: the restconf lines on routers and managed switches (§2.1), `rest` on every host (http-client). Help strings
 * are original wording (spec §1.6).
 */
import type { CommandSpec } from '../../contracts/cli.js';
import type { Capability } from '../../contracts/catalog.js';
import { choiceArg, HOST_ONLY, NFOS_ONLY } from './core-exec.js';

/** Handler ids of the API fragment. Never rename. */
export const API_HANDLERS = {
  configIpHttpSecureServer: 'config.ip-http-secure-server',
  configIpHttpAuthentication: 'config.ip-http-authentication',
  configRestconf: 'config.restconf',
  hostRest: 'host.rest',
} as const;

/** @since P3 Capabilities that run restconf (§2.1: routing, managed-switch). */
export const RESTCONF_CAPABILITIES: readonly Capability[] = Object.freeze(['routing', 'managed-switch']);
/** @since P3 Capabilities whose host shell offers `rest` (http-client runs on every host). */
export const REST_CLIENT_CAPABILITIES: readonly Capability[] = Object.freeze(['host']);

/** @since P3 The methods `rest` sends (§2.4 `HttpMethod`). */
export const REST_METHODS = Object.freeze(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'] as const);
/** @since P3 The longest option text `rest` reads (headers and body). */
export const REST_OPTIONS_MAX = 4000;

const H = API_HANDLERS;
const OBJ = ['CCNA3.automation.2', 'CCNA3.automation.3'];

const GLOBAL = { mode: 'config', privilege: 15, allowNo: true, grammars: NFOS_ONLY, requiresAny: RESTCONF_CAPABILITIES, since: 'P3' } as const;

/** The API command table. */
export const API_GRAMMAR: readonly CommandSpec[] = Object.freeze<CommandSpec[]>([
  {
    ...GLOBAL,
    path: ['ip', 'http', 'secure-server'],
    help: 'Answer encrypted web requests (HTTPS, TCP 443): the device API needs it',
    handler: H.configIpHttpSecureServer,
    objectives: OBJ,
  },
  {
    ...GLOBAL,
    path: ['ip', 'http', 'authentication', '<method>'],
    help: 'Check web and API users against this device\'s user names',
    args: { method: choiceArg('local: the "username … secret" lines', ['local']) },
    handler: H.configIpHttpAuthentication,
    noArgsOptional: true,
    objectives: OBJ,
  },
  {
    ...GLOBAL,
    path: ['restconf'],
    help: 'Offer the RESTCONF device API (with ip http secure-server)',
    handler: H.configRestconf,
    objectives: OBJ,
  },
  {
    path: ['rest', '<method>', '<url>', '<options>'],
    mode: 'user-exec',
    privilege: 15,
    help: 'Send one HTTP request to a web API and print the answer',
    args: {
      method: choiceArg('HTTP method', REST_METHODS),
      url: { type: 'url', help: 'Address of the resource, e.g. https://10.0.99.11/restconf/data/ietf-interfaces:interfaces' },
      options: {
        type: 'rest',
        help: '-H "Name: value" (repeatable), -u user:password, then -d and the body (the rest of the line, as typed)',
        optional: true,
        maxLength: REST_OPTIONS_MAX,
      },
    },
    handler: H.hostRest,
    job: true,
    grammars: HOST_ONLY,
    requiresAny: REST_CLIENT_CAPABILITIES,
    since: 'P3',
    objectives: OBJ,
  },
]);
