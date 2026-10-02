/**
 * cli/handlers/api.ts — the device API lines and the host-shell `rest` job (ARCHITECTURE-P3 §5.6, D21, §3.8; §7 W2 cli
 * part 1).
 *
 * `ip http secure-server`, `ip http authentication local` and `restconf` are plain global lines (the W1 config rules);
 * `restconf` without `ip http secure-server` is stored and notes `restconfNeedsSecureServer`.
 *
 * `rest <method> <url> [options]`: `splitRestOptions` reads the options with the host shell's quoting rule — tokens
 * are separated by spaces, a token that starts with `"` runs to the next `"` (no escapes; the closing mark must end
 * the token), an unquoted token may hold no `"` (cli/parser.ts `MSG_UNCLOSED_QUOTE`, `MSG_STRAY_QUOTE`) — and stops at
 * `-d`, which takes the rest of the line exactly as typed (only the spaces right after `-d` are skipped). `-H "Name:
 * value"` adds a header (repeatable, in order), `-u user:password` adds `Authorization: Basic …` (RFC 7617, UTF-8)
 * unless an Authorization header was given; an `Accept: application/yang-data+json` header is added when none was
 * given (§3.8 step 1). The job blocks the session before it asks (a failure can answer at once), then requests
 * `http.request {owner: 'cli', token, method, url, headers, body, session}`; http-client prints the answer and ends the
 * job (`cliDone`); Ctrl+C sends `job.abort`. Every string is original wording (spec §1.6).
 */
import { CLI_MESSAGES, type CommandHandler } from '../../contracts/cli.js';
import type { HttpMethod } from '../../contracts/process.js';
import { MSG_STRAY_QUOTE, MSG_UNCLOSED_QUOTE } from '../parser.js';
import { API_HANDLERS, REST_METHODS } from '../grammar/api.js';
import { globalContext, outcomeOf } from './common.js';

/** An option `rest` does not know. */
export const MSG_REST_OPTION = (option: string): string => `% Unknown option ${option}: use -H "Name: value", -u user:password and, last, -d <body>.`;
/** `-H` / `-u` without its value. */
export const MSG_REST_VALUE = (option: string): string => `% Give a value after ${option}.`;
/** A header without `Name: value`. */
export const MSG_REST_HEADER = '% Write a header as "Name: value", in double quotes when it holds spaces.';
/** `-u` without `user:password`. */
export const MSG_REST_USER = '% Write the credentials as user:password.';
/** `-d` with nothing after it. */
export const MSG_REST_BODY = '% Give the body after -d.';

/** The http-client process (owner of the job) and the job label. */
const HTTP_CLIENT = 'http-client';
const REST_JOB_LABEL = 'rest';
/** The media type `rest` asks for when the user names none (RESTCONF's JSON, RFC 8040). */
export const REST_DEFAULT_ACCEPT = 'application/yang-data+json';

/** @since P3 The options of a `rest` line: headers in typed order, the credentials, and the body text. */
export interface RestOptions {
  readonly headers: readonly (readonly [string, string])[];
  readonly user?: { readonly name: string; readonly password: string };
  readonly body?: string;
}

const isSpace = (c: string | undefined): boolean => c === ' ' || c === '\t';

/**
 * @since P3 Split the option text of `rest` (module header): `-H` and `-u` take one token (quoted or bare), `-d` takes
 * the rest of the text verbatim. An error message (original wording) when the text does not read.
 */
export function splitRestOptions(text: string): RestOptions | string {
  const headers: [string, string][] = [];
  let user: { name: string; password: string } | undefined;
  let body: string | undefined;
  let i = 0;
  const n = text.length;
  /** The next token from `i` (quotes stripped), or an error. */
  const nextToken = (): string | { error: string } | undefined => {
    while (i < n && isSpace(text[i])) i++;
    if (i >= n) return undefined;
    if (text[i] === '"') {
      const close = text.indexOf('"', i + 1);
      if (close === -1) return { error: MSG_UNCLOSED_QUOTE };
      if (close + 1 < n && !isSpace(text[close + 1])) return { error: MSG_STRAY_QUOTE };
      const value = text.slice(i + 1, close);
      i = close + 1;
      return value;
    }
    const start = i;
    while (i < n && !isSpace(text[i])) i++;
    const value = text.slice(start, i);
    return value.includes('"') ? { error: MSG_STRAY_QUOTE } : value;
  };
  for (;;) {
    while (i < n && isSpace(text[i])) i++;
    if (i >= n) break;
    if (text.startsWith('-d', i) && (i + 2 === n || isSpace(text[i + 2]))) {
      let j = i + 2;
      while (j < n && isSpace(text[j])) j++;
      body = text.slice(j);
      if (body === '') return MSG_REST_BODY;
      break;
    }
    const option = nextToken();
    if (option === undefined) break;
    if (typeof option !== 'string') return option.error;
    if (option !== '-H' && option !== '-u') return MSG_REST_OPTION(option);
    const value = nextToken();
    if (value === undefined) return MSG_REST_VALUE(option);
    if (typeof value !== 'string') return value.error;
    const colon = value.indexOf(':');
    if (option === '-H') {
      const name = colon <= 0 ? '' : value.slice(0, colon).trim();
      if (name === '' || /\s/.test(name)) return MSG_REST_HEADER;
      headers.push([name, value.slice(colon + 1).trim()]);
    } else {
      if (colon <= 0) return MSG_REST_USER;
      user = { name: value.slice(0, colon), password: value.slice(colon + 1) };
    }
  }
  return { headers, ...(user === undefined ? {} : { user }), ...(body === undefined ? {} : { body }) };
}

const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** Base64 of bytes (RFC 4648, with padding). */
export function base64(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i] as number;
    const b = i + 1 < bytes.length ? (bytes[i + 1] as number) : 0;
    const c = i + 2 < bytes.length ? (bytes[i + 2] as number) : 0;
    const triple = (a << 16) | (b << 8) | c;
    out += BASE64[(triple >> 18) & 63];
    out += BASE64[(triple >> 12) & 63];
    out += i + 1 < bytes.length ? BASE64[(triple >> 6) & 63] : '=';
    out += i + 2 < bytes.length ? BASE64[triple & 63] : '=';
  }
  return out;
}

const UTF8 = new TextEncoder();

/** @since P3 The headers `rest` sends: the typed ones in order, then Accept and Authorization when not typed (§3.8). */
export function restHeaders(opts: RestOptions): [string, string][] {
  const out = opts.headers.map(([k, v]) => [k, v] as [string, string]);
  const has = (name: string): boolean => out.some(([k]) => k.toLowerCase() === name);
  if (!has('accept')) out.push(['Accept', REST_DEFAULT_ACCEPT]);
  if (opts.user !== undefined && !has('authorization')) {
    out.push(['Authorization', `Basic ${base64(UTF8.encode(`${opts.user.name}:${opts.user.password}`))}`]);
  }
  return out;
}

/** `rest <method> <url> [options]`: a blocking job on http-client (module header). */
const rest: CommandHandler = (ctx, args) => {
  const method = args['method'] ?? '';
  if (!(REST_METHODS as readonly string[]).includes(method)) return { error: `% Expected a method: ${REST_METHODS.join(', ')}.` };
  const url = args['url'] ?? '';
  const opts = splitRestOptions(args['options'] ?? '');
  if (typeof opts === 'string') return { error: opts };
  const session = ctx.session.id;
  // Block BEFORE the request: a request that fails at once answers with `cliDone` during it.
  ctx.block({ process: HTTP_CLIENT, abort: { kind: 'job.abort', session }, label: REST_JOB_LABEL });
  ctx.request(HTTP_CLIENT, {
    kind: 'http.request',
    owner: 'cli',
    token: `rest:${session}:${ctx.now}`,
    method: method as HttpMethod,
    url,
    headers: restHeaders(opts),
    ...(opts.body === undefined ? {} : { body: UTF8.encode(opts.body) }),
    session,
  });
  return {};
};

/** `ip http secure-server` / its `no` form. */
const httpSecureServer: CommandHandler = (ctx, _args, negate) => outcomeOf(ctx.config(['ip', 'http', 'secure-server'], negate, globalContext()));

/** `ip http authentication local` / its `no` form. */
const httpAuthentication: CommandHandler = (ctx, args, negate) => {
  if (negate) return outcomeOf(ctx.config(['ip', 'http', 'authentication'], true, globalContext()));
  return outcomeOf(ctx.config(['ip', 'http', 'authentication', args['method'] ?? 'local'], false, globalContext()));
};

/** True when the running configuration holds `ip http secure-server` (under the `ip` group or as a full line). */
function secureServerOn(ctx: Parameters<CommandHandler>[0]): boolean {
  for (const c of ctx.running.root.children) {
    if (c.key !== 'ip') continue;
    if (c.args.length === 0 && c.children.some((l) => l.key === 'http' && l.args.length === 1 && l.args[0] === 'secure-server')) return true;
    if (c.args[0] === 'http' && c.args[1] === 'secure-server' && c.args.length === 2) return true;
  }
  return false;
}

/** `restconf` / `no restconf` (the note when the HTTPS server is off, §5.6). */
const restconf: CommandHandler = (ctx, _args, negate) => {
  const error = ctx.config(['restconf'], negate, globalContext());
  if (error !== undefined) return { error };
  return !negate && !secureServerOn(ctx) ? { output: CLI_MESSAGES.restconfNeedsSecureServer } : {};
};

/** @since P3 Registry fragment: the device API lines and `rest` (`API_HANDLERS` ids). */
export const apiHandlers: Readonly<Record<string, CommandHandler>> = {
  [API_HANDLERS.configIpHttpSecureServer]: httpSecureServer,
  [API_HANDLERS.configIpHttpAuthentication]: httpAuthentication,
  [API_HANDLERS.configRestconf]: restconf,
  [API_HANDLERS.hostRest]: rest,
};
