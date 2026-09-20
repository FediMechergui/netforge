/**
 * cli/handlers/line-auth.ts — passwords, user names and terminal lines (ARCHITECTURE-P1 §4.10, §6 P1 table).
 *
 * How a secret is stored is decided here, once:
 *   • `enable secret` and `username X secret Y` are hashed through `CommandCtx.secrets` and stored as the two
 *     tokens `nf1 <hash>`, so the running config renders `enable secret nf1 <hash>` and nothing can read the plain
 *     text back;
 *   • `enable password` and a line `password` are stored in the clear unless `service password-encryption` is set,
 *     and then as `nf7 <hex>` — reversible, exactly like the real thing, which is why the secret one is the one to
 *     teach. Turning the service on rewrites the passwords already stored; turning it off leaves them encoded
 *     (nothing remembers the plain text).
 * The runtime verifies any of the three forms (`verifySecret`), so a config written by hand keeps working.
 *
 * `line con 0` / `line vty 0 4` write the section and enter mode `config-line`; `login` plus a `password` there is
 * what puts a new session into the login stage.
 *
 * ponytail: `exec-timeout` is stored and rendered but no timer closes an idle session yet; `username X password Y`
 * is not offered, only the hashed `secret` form.
 */
import type { CommandCtx, CommandHandler } from '../../contracts/cli.js';
import type { ConfigNode } from '../../contracts/config.js';
import { HANDLERS, LINE_TYPES } from '../grammar/index.js';
import { encodeReversibleSecret, isTaggedSecret, secretTokens } from '../secrets.js';
import { enterMode, globalContext, outcomeOf } from './common.js';

/** Error for a secret that is empty. */
export const MSG_SECRET_EMPTY = '% Give the password to set.';
/** Error for a line command typed outside a `line` section. */
export const MSG_NO_LINE_SELECTED = '% Select a line first (line con 0 or line vty 0 4).';
/** Error for a `line vty` range whose last number comes before its first. */
export const MSG_LINE_RANGE = '% The last line number comes before the first one.';

/** True when the running config carries `service password-encryption`. */
export function passwordEncryptionOn(running: CommandCtx['running']): boolean {
  return running.root.children.some((c) => c.key === 'service' && c.args[0] === 'password-encryption');
}

/** The stored `enable secret`, else the stored `enable password`, as one value; undefined when neither is set. */
export function enableSecretOf(running: CommandCtx['running']): string | undefined {
  for (const kind of ['secret', 'password'] as const) {
    const node = running.root.children.find((c) => c.key === 'enable' && c.args[0] === kind);
    if (node !== undefined && node.args.length > 1) return node.args.slice(1).join(' ');
  }
  return undefined;
}

/** Tokens of a secret stored one-way (`nf1 <hash>`). */
function hashedTokens(ctx: CommandCtx, plain: string): string[] {
  return secretTokens(ctx.secrets.hash(plain));
}

/** Tokens of a password stored recoverably: `nf7 <hex>` under `service password-encryption`, else the plain text. */
function passwordTokens(ctx: CommandCtx, plain: string): string[] {
  return passwordEncryptionOn(ctx.running) ? secretTokens(encodeReversibleSecret(plain)) : [plain];
}

/** `enable password <text>` / `no enable password`. */
const enablePassword: CommandHandler = (ctx, args, negate) => {
  if (negate) return outcomeOf(ctx.config(['enable', 'password'], true, globalContext()));
  const plain = args['secret'] ?? '';
  if (plain === '') return { error: MSG_SECRET_EMPTY };
  return outcomeOf(ctx.config(['enable', 'password', ...passwordTokens(ctx, plain)], false, globalContext()));
};

/** `username <name> secret <text>` / `no username <name>`. */
const username: CommandHandler = (ctx, args, negate) => {
  const name = args['name'] ?? '';
  if (name === '') return { error: '% Give the user name.' };
  if (negate) return outcomeOf(ctx.config(['username', name, 'secret'], true, globalContext()));
  const plain = args['secret'] ?? '';
  if (plain === '') return { error: MSG_SECRET_EMPTY };
  return outcomeOf(ctx.config(['username', name, 'secret', ...hashedTokens(ctx, plain)], false, globalContext()));
};

/** Every password line already stored: `enable password` and the `password` of each `line` section. */
function storedPasswords(root: ConfigNode): { context: string[][]; line: string[]; value: string }[] {
  const out: { context: string[][]; line: string[]; value: string }[] = [];
  for (const node of root.children) {
    if (node.key === 'enable' && node.args[0] === 'password' && node.args.length > 1) {
      out.push({ context: [], line: ['enable', 'password'], value: node.args.slice(1).join(' ') });
      continue;
    }
    if (node.key !== 'line') continue;
    const pw = node.children.find((c) => c.key === 'password');
    if (pw === undefined || pw.args.length === 0) continue;
    out.push({ context: [['line', ...node.args]], line: ['password'], value: pw.args.join(' ') });
  }
  return out;
}

/** `service password-encryption` / its `no` form: turning it on re-writes the passwords already stored. */
const passwordEncryption: CommandHandler = (ctx, _args, negate) => {
  const error = ctx.config(['service', 'password-encryption'], negate, globalContext());
  if (error !== undefined) return { error };
  if (negate) return { output: 'Passwords already stored stay scrambled: their plain text is gone.' };
  let changed = 0;
  for (const p of storedPasswords(ctx.running.root)) {
    if (isTaggedSecret(p.value)) continue;
    const e = ctx.config([...p.line, ...secretTokens(encodeReversibleSecret(p.value))], false, p.context);
    if (e !== undefined) return { error: e };
    changed++;
  }
  return changed === 0 ? {} : { output: `Scrambled ${changed} stored password${changed === 1 ? '' : 's'}.` };
};

/** `line con 0` / `line vty 0 4`: write the section and configure inside it. */
const line: CommandHandler = (ctx, args) => {
  const type = args['type'] ?? '';
  const first = args['first'] ?? '';
  const last = args['last'];
  if (!LINE_TYPES.includes(type)) return { error: `% Expected one of: ${LINE_TYPES.join(', ')}.` };
  if (last !== undefined && Number(last) < Number(first)) return { error: MSG_LINE_RANGE };
  const entry = ['line', type, first, ...(last === undefined ? [] : [last])];
  const error = ctx.config(entry, false, globalContext());
  if (error !== undefined) return { error };
  enterMode(ctx, 'config-line', [entry]);
  return {};
};

/** True when the session is inside a `line` section. */
function inLineSection(ctx: CommandCtx): boolean {
  return ctx.context[ctx.context.length - 1]?.[0] === 'line';
}

/** `password <text>` / `no password` inside a line section. */
const linePassword: CommandHandler = (ctx, args, negate) => {
  if (!inLineSection(ctx)) return { error: MSG_NO_LINE_SELECTED };
  if (negate) return outcomeOf(ctx.config(['password'], true));
  const plain = args['secret'] ?? '';
  if (plain === '') return { error: MSG_SECRET_EMPTY };
  return outcomeOf(ctx.config(['password', ...passwordTokens(ctx, plain)], false));
};

/** `login [local]` / `no login` inside a line section. */
const lineLogin: CommandHandler = (ctx, args, negate) => {
  if (!inLineSection(ctx)) return { error: MSG_NO_LINE_SELECTED };
  if (negate) return outcomeOf(ctx.config(['login'], true));
  const method = args['method'];
  return outcomeOf(ctx.config(method === undefined ? ['login'] : ['login', method], false));
};

/** `exec-timeout <minutes> [<seconds>]` / `no exec-timeout` inside a line section. */
const lineExecTimeout: CommandHandler = (ctx, args, negate) => {
  if (!inLineSection(ctx)) return { error: MSG_NO_LINE_SELECTED };
  if (negate) return outcomeOf(ctx.config(['exec-timeout'], true));
  const minutes = args['minutes'] ?? '';
  if (minutes === '') return { error: '% Give the idle time in minutes.' };
  return outcomeOf(ctx.config(['exec-timeout', minutes, args['seconds'] ?? '0'], false));
};

/** Registry fragment for the CLI runtime: password, banner and line handler id → handler. */
export const lineAuthHandlers: Readonly<Record<string, CommandHandler>> = {
  [HANDLERS.configEnablePassword]: enablePassword,
  [HANDLERS.configPasswordEncryption]: passwordEncryption,
  [HANDLERS.configUsername]: username,
  [HANDLERS.configLine]: line,
  [HANDLERS.linePassword]: linePassword,
  [HANDLERS.lineLogin]: lineLogin,
  [HANDLERS.lineExecTimeout]: lineExecTimeout,
};
