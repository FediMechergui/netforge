/**
 * cli/handlers/services.ts — the web service switches (ARCHITECTURE-P1 §4.5, §6 P1 table).
 *
 * `ip http server` and the `ip http page PATH <text>` extension are plain config lines: http-server reads them and
 * starts or stops its listener and its page table. The handlers only check what they can explain — a path that does
 * not start with a slash, and a page without text. Messages are original wording (spec §1.6).
 *
 * The host-shell `service …` forms share one handler id, so each spec names its sub-form in `fixedArgs`
 * (SERVICE_FORM_ARG); `service dhcp on` reports success when a SERVICE pool already leases a subnet, because those
 * pool lines are the running address service.
 */
import type { CommandCtx, CommandHandler } from '../../contracts/cli.js';
import { maskToPrefixLen, networkOf, parseIpv4 } from '../../contracts/addr.js';
import { dhcpPoolViews } from '../../protocols/dhcp-server.js';
import {
  HANDLERS,
  SERVICE_FORM_ARG,
  SERVICE_FORM_DNS_RECORD,
  SERVICE_FORM_HTTP_PAGE,
  SERVICE_POOL_NAME,
} from '../grammar/index.js';
import { globalContext, outcomeOf } from './common.js';
import { dnsHandlers } from './dns.js';

/** Error for an `ip http page` path that is not absolute. */
export const MSG_PAGE_PATH = '% A page path starts with a slash, for example /status.';
/** Error for an `ip http page` without any text. */
export const MSG_PAGE_EMPTY = '% Give the text this device should serve at that path.';

/** `ip http server` / `no ip http server`. */
const httpServer: CommandHandler = (ctx, _args, negate) => outcomeOf(ctx.config(['ip', 'http', 'server'], negate, globalContext()));

/** `ip http page <path> <text>` / `no ip http page [<path>]`. */
const httpPage: CommandHandler = (ctx, args, negate) => {
  const path = args['path'];
  if (negate) return outcomeOf(ctx.config(path === undefined ? ['ip', 'http', 'page'] : ['ip', 'http', 'page', path], true, globalContext()));
  if (path === undefined || !path.startsWith('/')) return { error: MSG_PAGE_PATH };
  const body = (args['body'] ?? '').trim();
  if (body === '') return { error: MSG_PAGE_EMPTY };
  return outcomeOf(ctx.config(['ip', 'http', 'page', path, body], false, globalContext()));
};

// ── host shell: service http|dns|dhcp … ─────────────────────────────────────

/** Error for a `service dhcp pool` network with host bits set under its mask. */
export const MSG_SERVICE_POOL_HOST_BITS = '% The network address has host bits set for that mask.';

/** Global lines `service <name> on|off` writes: the router form of §6 for that service. */
function serviceSwitch(ctx: CommandCtx, service: string, on: boolean): ReturnType<CommandHandler> {
  if (service === 'http') {
    const e = ctx.config(['ip', 'http', 'server'], !on, globalContext());
    return e === undefined ? { output: `Web service ${on ? 'started' : 'stopped'}.` } : { error: e };
  }
  if (service === 'dns') {
    const e = ctx.config(['ip', 'dns', 'server'], !on, globalContext());
    return e === undefined ? { output: `Name service ${on ? 'started' : 'stopped'}.` } : { error: e };
  }
  if (on) {
    // The pool lines ARE the address service, so `on` succeeds exactly when a SERVICE pool already leases a subnet.
    const leasing = dhcpPoolViews({ config: ctx.running, tables: ctx.tables }).some((p) => p.name === SERVICE_POOL_NAME);
    return leasing ? { output: 'Address service started.' } : { error: MSG_DHCP_NEEDS_POOL };
  }
  const e = ctx.config(['ip', 'dhcp', 'pool', SERVICE_POOL_NAME], true, globalContext());
  return e === undefined ? { output: 'Address service stopped.' } : { error: e };
}

/** Error for `service dhcp on` without a subnet to lease from. */
export const MSG_DHCP_NEEDS_POOL = '% Give the subnet to lease from first: service dhcp pool <network> <mask> [<gateway>].';

/**
 * `service http|dns|dhcp …` — the host-shell expansions of §6. Every form writes the canonical router lines, so a
 * server's running config reads exactly like a router's and the daemons need no second parser.
 */
const hostService: CommandHandler = (ctx, args, negate) => {
  // The sub-form comes from the spec's `fixedArgs`, never from which optional arg happens to be present:
  // `no service http page` and `no service dns record` carry no args at all.
  const form = args[SERVICE_FORM_ARG];
  if (form === SERVICE_FORM_HTTP_PAGE) return httpPage(ctx, args, negate);
  if (form === SERVICE_FORM_DNS_RECORD) return (dnsHandlers[HANDLERS.configDnsRecord] as CommandHandler)(ctx, args, negate);
  const service = args['service'];
  const state = args['state'];
  if (service !== undefined && state !== undefined) return serviceSwitch(ctx, service, state === 'on');
  const network = args['network'] ?? '';
  const mask = args['mask'] ?? '';
  const len = maskToPrefixLen(mask);
  if (parseIpv4(network) === null) return { error: '% Expected a network address (A.B.C.D).' };
  if (len === null || len > 30) return { error: '% Expected a contiguous subnet mask such as 255.255.255.0.' };
  if (networkOf(network, len) !== network) return { error: MSG_SERVICE_POOL_HOST_BITS };
  const pool = [['ip', 'dhcp', 'pool', SERVICE_POOL_NAME]];
  const steps: [string[], string[][]][] = [
    [['ip', 'dhcp', 'pool', SERVICE_POOL_NAME], globalContext()],
    [['network', network, mask], pool],
  ];
  const router = args['router'];
  if (router !== undefined && router !== '') steps.push([['default-router', router], pool]);
  for (const [line, context] of steps) {
    const e = ctx.config(line, false, context);
    if (e !== undefined) return { error: e };
  }
  return { output: `Address service leases from ${network}/${len}.` };
};

/** Registry fragment for the CLI runtime: service handler id → handler. */
export const servicesHandlers: Readonly<Record<string, CommandHandler>> = {
  [HANDLERS.configHttpServer]: httpServer,
  [HANDLERS.configHttpPage]: httpPage,
  [HANDLERS.hostService]: hostService,
};
