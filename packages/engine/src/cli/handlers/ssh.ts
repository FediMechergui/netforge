/**
 * cli/handlers/ssh.ts — SSH key, SSH settings, privileged users and vty transport (ARCHITECTURE-P3 §5.2, D14, D22,
 * M10; §7 W2 cli part 1).
 *
 *   config.crypto-key-generate  `crypto key generate rsa [general-keys] [modulus <n>]`: needs a hostname other than the
 *                               model's default (`<prefix>` or `<prefix><n>`, the names a new device gets;
 *                               `sshNeedsHostname`) and `ip domain-name` (`sshNeedsDomain`); without `modulus` it asks
 *                               for the size (empty answer: 1024 bits). Stored as `crypto key generate rsa modulus
 *                               <n>` (one slot: a new key replaces the old one)
 *   config.crypto-key-zeroize   `crypto key zeroize rsa`: removes the stored key line
 *   config.ip-ssh               `ip ssh version 1|2` (2 needs a key of at least 768 bits, `sshVersionNeedsKey`),
 *                               `ip ssh time-out <s>`, `ip ssh authentication-retries <n>` and their `no` forms
 *   config.username-privilege   `username <name> privilege <level> secret <secret>`: hashed like P1's `username …
 *                               secret` (`nf1 <hash>`), one slot per user (identity 2, D14)
 *   line.transport-input        `transport input ssh|telnet|ssh telnet|all|none` on vty lines (stored `ssh telnet` in
 *                               that order)
 *   line.access-class           `access-class <list> in` on vty lines
 *   show.ip-ssh                 (W3) `show ip ssh`: on with an RSA key (D14), the version in force (the `ip ssh version`
 *                               line, else 2 with a key of at least 768 bits and 1 below), the key size and name, the
 *                               login time-out and retries (defaults 120 s and 3), and each `line vty` section's
 *                               transport (`telnet ssh` when it has no `transport input` line, §5.2), access class and
 *                               login rule
 * Every string is original wording (spec §1.6).
 */
import { CLI_MESSAGES, type CliInputRequest, type CommandCtx, type CommandHandler, type CommandOutcome } from '../../contracts/cli.js';
import type { ConfigNode } from '../../contracts/config.js';
import { aclTypeOfNumber } from '../../core/acl.js';
import { secretTokens } from '../secrets.js';
import {
  RSA_MODULUS_DEFAULT,
  RSA_MODULUS_MAX,
  RSA_MODULUS_MIN,
  SSH_FORM_ARG,
  SSH_HANDLERS,
  SSH_RETRIES_DEFAULT,
  SSH_TIMEOUT_DEFAULT_S,
  SSH_V2_MIN_MODULUS,
} from '../grammar/ssh.js';
import { globalContext, outcomeOf } from './common.js';

/** The question `crypto key generate rsa` asks when no size is given. */
export const RSA_SIZE_PROMPT: CliInputRequest = Object.freeze({
  kind: 'text',
  prompt: `Key size in bits, ${RSA_MODULUS_MIN} to ${RSA_MODULUS_MAX} [${RSA_MODULUS_DEFAULT}]: `,
});
/** `crypto key zeroize rsa` without a key. */
export const MSG_NO_RSA_KEY = '% There is no RSA key to delete.';
/** A vty-only line typed under the console line. */
export const MSG_VTY_ONLY = '% This setting applies to the remote terminal lines (line vty) only.';
/** A line typed outside a `line` section. */
export const MSG_NO_LINE = '% Select a line first (line vty 0 4).';

/** The stored key size, or undefined without a key line. */
export function rsaModulus(ctx: Pick<CommandCtx, 'running'>): number | undefined {
  for (const c of ctx.running.root.children) {
    if (c.key !== 'crypto' || c.args[0] !== 'key' || c.args[1] !== 'generate' || c.args[2] !== 'rsa') continue;
    const i = c.args.indexOf('modulus');
    const v = i === -1 ? undefined : c.args[i + 1];
    return v !== undefined && /^\d+$/.test(v) ? Number(v) : RSA_MODULUS_DEFAULT;
  }
  return undefined;
}

/** The stored `ip domain-name`, or undefined. */
export function domainNameOf(ctx: Pick<CommandCtx, 'running'>): string | undefined {
  for (const c of ctx.running.root.children) {
    if (c.key !== 'ip') continue;
    if (c.args.length === 0) {
      const leaf = c.children.find((l) => l.key === 'domain-name' && l.args[0] !== undefined);
      if (leaf !== undefined) return leaf.args[0];
    } else if (c.args[0] === 'domain-name' && c.args[1] !== undefined) {
      return c.args[1];
    }
  }
  return undefined;
}

/** True when `hostname` is the model's default name (`<prefix>` or `<prefix><n>`, D14). */
export function isDefaultHostname(ctx: Pick<CommandCtx, 'hostname' | 'model'>): boolean {
  const prefix = ctx.model.hostnamePrefix;
  if (!ctx.hostname.startsWith(prefix)) return false;
  return /^\d*$/.test(ctx.hostname.slice(prefix.length));
}

/** Store the key line and report it (the question's answer and the `modulus` form share it). */
function storeKey(ctx: CommandCtx, bits: number): CommandOutcome {
  const replaced = rsaModulus(ctx) !== undefined;
  const error = ctx.config(['crypto', 'key', 'generate', 'rsa', 'modulus', String(bits)], false, globalContext());
  if (error !== undefined) return { error };
  const lines = [`The RSA key pair ${ctx.hostname}.${domainNameOf(ctx) ?? ''} was created (${bits} bits)${replaced ? '; it replaces the previous key' : ''}. SSH can now be used.`];
  if (bits < SSH_V2_MIN_MODULUS) lines.push(`Note: SSH version 2 needs a key of at least ${SSH_V2_MIN_MODULUS} bits.`);
  return { output: lines.join('\n') };
}

/** `crypto key generate rsa [general-keys] [modulus <n>]` (module header). */
const cryptoKeyGenerate: CommandHandler = (ctx, args) => {
  if (isDefaultHostname(ctx)) return { error: CLI_MESSAGES.sshNeedsHostname };
  if (domainNameOf(ctx) === undefined) return { error: CLI_MESSAGES.sshNeedsDomain };
  const bits = args['bits'];
  if (bits !== undefined) return storeKey(ctx, Number(bits));
  const resume = (rctx: CommandCtx, answer: string): CommandOutcome => {
    const text = answer.trim();
    if (text === '') return storeKey(rctx, RSA_MODULUS_DEFAULT);
    const n = /^\d{1,5}$/.test(text) ? Number(text) : NaN;
    if (!(n >= RSA_MODULUS_MIN && n <= RSA_MODULUS_MAX)) return { ask: { request: { ...RSA_SIZE_PROMPT }, resume } };
    return storeKey(rctx, n);
  };
  return { output: `The key pair will be named ${ctx.hostname}.${domainNameOf(ctx) ?? ''}.`, ask: { request: { ...RSA_SIZE_PROMPT }, resume } };
};

/** `crypto key zeroize rsa`. */
const cryptoKeyZeroize: CommandHandler = (ctx) => {
  if (rsaModulus(ctx) === undefined) return { error: MSG_NO_RSA_KEY };
  const error = ctx.config(['crypto', 'key', 'generate', 'rsa'], true, globalContext());
  return error === undefined ? { output: 'The RSA key pair was deleted; SSH stays off until a new key is created.' } : { error };
};

/** `ip ssh version|time-out|authentication-retries <v>` and their `no` forms. */
const ipSsh: CommandHandler = (ctx, args, negate) => {
  const form = args[SSH_FORM_ARG] ?? '';
  if (negate) return outcomeOf(ctx.config(['ip', 'ssh', form], true, globalContext()));
  const value = form === 'version' ? args['version'] : form === 'time-out' ? args['seconds'] : args['count'];
  if (value === undefined) return { error: '% Give the value.' };
  if (form === 'version' && value === '2' && (rsaModulus(ctx) ?? 0) < SSH_V2_MIN_MODULUS) return { error: CLI_MESSAGES.sshVersionNeedsKey };
  return outcomeOf(ctx.config(['ip', 'ssh', form, value], false, globalContext()));
};

/** `username <name> privilege <level> secret <secret>` / `no username <name> …`. */
const usernamePrivilege: CommandHandler = (ctx, args, negate) => {
  const name = args['name'] ?? '';
  if (name === '') return { error: '% Give the user name.' };
  if (negate) {
    const stored = ctx.running.root.children.some((c) => c.key === 'username' && c.args[0] === name);
    return stored ? outcomeOf(ctx.config(['username', name], true, globalContext())) : {};
  }
  const plain = args['secret'] ?? '';
  if (plain === '') return { error: '% Give the password to set.' };
  const level = String(Number(args['level'] ?? '1'));
  return outcomeOf(ctx.config(['username', name, 'privilege', level, 'secret', ...secretTokens(ctx.secrets.hash(plain))], false, globalContext()));
};

/** The `line` context entry of the session when it names the vty lines; an error outcome otherwise. */
function vtyLine(ctx: CommandCtx): { error: string } | undefined {
  const entry = ctx.context[ctx.context.length - 1];
  if (entry === undefined || entry[0] !== 'line') return { error: MSG_NO_LINE };
  return entry[1] === 'vty' ? undefined : { error: MSG_VTY_ONLY };
}

/** `transport input ssh|telnet|ssh telnet|all|none` / `no transport input`. */
const transportInput: CommandHandler = (ctx, args, negate) => {
  const refused = vtyLine(ctx);
  if (refused !== undefined) return refused;
  if (negate) return outcomeOf(ctx.config(['transport', 'input'], true));
  const first = args['protocol'] ?? args['first'];
  const second = args['second'];
  if (first === undefined) return { error: '% Give the protocols: ssh, telnet, ssh telnet, all or none.' };
  const value = second === undefined || second === first ? [first] : ['ssh', 'telnet'];
  return outcomeOf(ctx.config(['transport', 'input', ...value], false));
};

/** `access-class <list> in` / `no access-class [<list> in]` on vty lines. */
const accessClass: CommandHandler = (ctx, args, negate) => {
  const refused = vtyLine(ctx);
  if (refused !== undefined) return refused;
  if (negate) return outcomeOf(ctx.config(['access-class'], true));
  const list = args['list'] ?? '';
  if (/^\d+$/.test(list) && aclTypeOfNumber(list) === undefined) return { error: CLI_MESSAGES.aclNumberRange };
  const name = /^\d+$/.test(list) ? String(Number(list)) : list;
  return outcomeOf(ctx.config(['access-class', name, args['direction'] ?? 'in'], false));
};

/** The value of a stored `ip ssh <setting> <value>` line (grouped under `ip` or not), or undefined. */
export function ipSshValue(ctx: Pick<CommandCtx, 'running'>, setting: 'version' | 'time-out' | 'authentication-retries'): string | undefined {
  for (const c of ctx.running.root.children) {
    if (c.key !== 'ip') continue;
    if (c.args.length === 0) {
      const leaf = c.children.find((l) => l.key === 'ssh' && l.args[0] === setting && l.args[1] !== undefined);
      if (leaf !== undefined) return leaf.args[1];
    } else if (c.args[0] === 'ssh' && c.args[1] === setting && c.args[2] !== undefined) {
      return c.args[2];
    }
  }
  return undefined;
}

/** @since P3 The SSH version in force: the `ip ssh version` line, else 2 with a key of at least 768 bits, else 1. */
export function sshVersionInForce(ctx: Pick<CommandCtx, 'running'>): { version: string; configured: boolean } {
  const configured = ipSshValue(ctx, 'version');
  if (configured !== undefined) return { version: configured, configured: true };
  return { version: (rsaModulus(ctx) ?? RSA_MODULUS_DEFAULT) >= SSH_V2_MIN_MODULUS ? '2' : '1', configured: false };
}

/** One `line vty …` section as `show ip ssh` reports it. */
function vtySectionText(section: ConfigNode): string {
  const transport = section.children.find((c) => c.key === 'transport' && c.args[0] === 'input');
  const accept = transport === undefined ? 'telnet ssh (no transport input line)' : transport.args.slice(1).join(' ');
  const acl = section.children.find((c) => c.key === 'access-class');
  const login = section.children.find((c) => c.key === 'login');
  const parts = [`accepts ${accept}`, acl === undefined ? 'no access class' : `access class ${acl.args.join(' ')}`];
  parts.push(login === undefined ? 'no login line' : login.args[0] === 'local' ? 'login local' : 'login with the line password');
  return `  line vty ${section.args.slice(1).join(' ')}: ${parts.join('; ')}`;
}

/** `show ip ssh` (§5.8; D14). */
const showIpSsh: CommandHandler = (ctx) => {
  const bits = rsaModulus(ctx);
  const lines = [bits === undefined ? 'SSH: off (there is no RSA key; "crypto key generate rsa" creates one)' : 'SSH: on'];
  const v = sshVersionInForce(ctx);
  lines.push(`  Version ${v.version}${v.configured ? '' : ' (no "ip ssh version" line)'}`);
  lines.push(bits === undefined ? '  RSA key: none' : `  RSA key: ${bits} bits, named ${ctx.hostname}.${domainNameOf(ctx) ?? ''}`);
  const timeout = ipSshValue(ctx, 'time-out') ?? String(SSH_TIMEOUT_DEFAULT_S);
  const retries = ipSshValue(ctx, 'authentication-retries') ?? String(SSH_RETRIES_DEFAULT);
  lines.push(`  Login time-out ${timeout} s; failed logins allowed ${retries}`);
  const vty = ctx.running.root.children.filter((c) => c.key === 'line' && c.args[0] === 'vty');
  if (vty.length === 0) lines.push('  No line vty section: remote logins are not offered');
  for (const section of vty) lines.push(vtySectionText(section));
  return { output: lines.join('\n') };
};

/** @since P3 Registry fragment: SSH and vty access lines (`SSH_HANDLERS` ids). */
export const sshHandlers: Readonly<Record<string, CommandHandler>> = {
  [SSH_HANDLERS.configCryptoKeyGenerate]: cryptoKeyGenerate,
  [SSH_HANDLERS.configCryptoKeyZeroize]: cryptoKeyZeroize,
  [SSH_HANDLERS.configIpSsh]: ipSsh,
  [SSH_HANDLERS.configUsernamePrivilege]: usernamePrivilege,
  [SSH_HANDLERS.lineTransportInput]: transportInput,
  [SSH_HANDLERS.lineAccessClass]: accessClass,
  // W3 cli part 2
  [SSH_HANDLERS.showIpSsh]: showIpSsh,
};
