/**
 * cli/handlers/dns.ts — name-resolution configuration, `show hosts` and the `nslookup` job (ARCHITECTURE-P1 §4.4,
 * §6 P1 table).
 *
 * The configuration handlers write the canonical lines of §6; dns-client rebuilds its server list and its static
 * rows from them, and dns-server its zone. `show hosts` renders the 'dns-cache' table (static rows first, then what
 * the resolver learnt, with the time each row has left). `nslookup` is a blocking job: the handler asks dns-client
 * for one name with `dns.lookup {session, …}` and blocks the session with an abort request of its own, so ^C ends
 * the lookup instead of the ping job.
 *
 * ponytail: `ip dns record` always stores a TTL (the server parses the four-value form only), and `show hosts` prints
 * the cache as one table rather than splitting static and learnt entries into two.
 */
import type { CommandHandler } from '../../contracts/cli.js';
import type { DnsCacheRow } from '../../contracts/tables.js';
import { DNS_DEFAULT_TTL_S } from '../../contracts/services.js';
import { HANDLERS } from '../grammar/index.js';
import { fmtSince, table } from '../format.js';
import { globalContext, outcomeOf } from './common.js';

/** Name of the daemon that resolves names. */
export const DNS_CLIENT_PROCESS = 'dns-client';
/** Terminal label of the `nslookup` job. */
export const NSLOOKUP_JOB_LABEL = 'nslookup';

/** Message for `nslookup` on a device whose resolver is not running. */
export const MSG_NO_RESOLVER = '% This device has no name resolver to ask.';
/** Message printed when neither a static name nor a cached answer exists. */
export const MSG_NO_HOSTS = 'No names are defined and nothing has been resolved yet.';

/** Addresses of a one-or-two address argument pair, in typed order. */
function addressPair(args: Record<string, string>): string[] {
  return [args['first'], args['second']].filter((v): v is string => v !== undefined && v !== '');
}

/** `ip name-server <first> [<second>]` and its `no` form. */
const nameServer: CommandHandler = (ctx, args, negate) => {
  const values = addressPair(args);
  if (negate) return outcomeOf(ctx.config(values.length === 0 ? ['ip', 'name-server'] : ['ip', 'name-server', ...values], true, globalContext()));
  if (values.length === 0) return { error: '% Give the address of a name server.' };
  return outcomeOf(ctx.config(['ip', 'name-server', ...values], false, globalContext()));
};

/** `ip domain-name <name>` and its `no` form. */
const domainName: CommandHandler = (ctx, args, negate) => {
  if (negate) return outcomeOf(ctx.config(['ip', 'domain-name'], true, globalContext()));
  const name = args['name'] ?? '';
  if (name === '') return { error: '% Give the domain name of this device.' };
  return outcomeOf(ctx.config(['ip', 'domain-name', name], false, globalContext()));
};

/**
 * `ip domain-lookup` / `no ip domain-lookup`. Resolving names is the default, so the OFF state is what has to
 * persist (§6 "stored negation"): the negation writes the literal `no ip domain-lookup` line and the positive form
 * removes it again. Nothing is stored while the default holds.
 */
const domainLookup: CommandHandler = (ctx, _args, negate) =>
  outcomeOf(ctx.config(['no', 'ip', 'domain-lookup'], !negate, globalContext()));

/** `ip host <name> <first> [<second>]` and its `no` form. */
const ipHost: CommandHandler = (ctx, args, negate) => {
  const name = args['name'] ?? '';
  if (negate) return outcomeOf(ctx.config(name === '' ? ['ip', 'host'] : ['ip', 'host', name], true, globalContext()));
  const values = addressPair(args);
  if (name === '') return { error: '% Give the name to define.' };
  if (values.length === 0) return { error: `% Give at least one address for "${name}".` };
  return outcomeOf(ctx.config(['ip', 'host', name, ...values], false, globalContext()));
};

/** `ip dns record <name> <type> <data> [<ttl>]` and its `no` form. */
const dnsRecord: CommandHandler = (ctx, args, negate) => {
  const name = args['name'] ?? '';
  const type = (args['type'] ?? '').toUpperCase();
  const data = args['data'] ?? '';
  const ttl = args['ttl'] ?? String(DNS_DEFAULT_TTL_S);
  if (negate) {
    if (name === '') return outcomeOf(ctx.config(['ip', 'dns', 'record'], true, globalContext()));
    return outcomeOf(ctx.config(['ip', 'dns', 'record', name, type, data, ttl], true, globalContext()));
  }
  if (name === '' || data === '') return { error: '% Give the name, the type and the value of the record.' };
  return outcomeOf(ctx.config(['ip', 'dns', 'record', name, type, data, ttl], false, globalContext()));
};

// ── show hosts ──────────────────────────────────────────────────────────────

const showHosts: CommandHandler = (ctx) => {
  const rows = ctx.tables.get<DnsCacheRow>('dns-cache')?.rows() ?? [];
  if (rows.length === 0) return { output: MSG_NO_HOSTS };
  const sorted = rows.slice().sort((a, b) => (a.source === b.source ? (a.name < b.name ? -1 : a.name > b.name ? 1 : 0) : a.source === 'static' ? -1 : 1));
  const out: string[][] = [['Name', 'Type', 'Value', 'Source', 'Expires in']];
  for (const r of sorted) {
    out.push([r.name, r.type, r.data, r.source, r.expiresAt === undefined ? 'never' : fmtSince(ctx.now, r.expiresAt)]);
  }
  return { output: table(out) };
};

// ── nslookup ────────────────────────────────────────────────────────────────

const nslookup: CommandHandler = (ctx, args) => {
  const name = args['name'] ?? '';
  const server = args['server'];
  if (name === '') return { error: '% Give the name to look up.' };
  if (ctx.processState(DNS_CLIENT_PROCESS) === undefined) return { error: MSG_NO_RESOLVER };
  // Block BEFORE the request: a lookup answered from the cache sends `cliDone` during the request.
  ctx.block({ process: DNS_CLIENT_PROCESS, abort: { kind: 'job.abort', session: ctx.session.id }, label: NSLOOKUP_JOB_LABEL });
  ctx.request(DNS_CLIENT_PROCESS, {
    kind: 'dns.lookup',
    session: ctx.session.id,
    name,
    ...(server === undefined || server === '' ? {} : { server }),
  });
  return {};
};

/** Registry fragment for the CLI runtime: DNS handler id → handler. */
export const dnsHandlers: Readonly<Record<string, CommandHandler>> = {
  [HANDLERS.configNameServer]: nameServer,
  [HANDLERS.configDomainName]: domainName,
  [HANDLERS.configDomainLookup]: domainLookup,
  [HANDLERS.configIpHost]: ipHost,
  [HANDLERS.configDnsServer]: (ctx, _args, negate) => outcomeOf(ctx.config(['ip', 'dns', 'server'], negate, globalContext())),
  [HANDLERS.configDnsRecord]: dnsRecord,
  [HANDLERS.showHosts]: showHosts,
  [HANDLERS.execNslookup]: nslookup,
};
