/**
 * cli/grammar/ssh.ts — SSH-only device access at the configuration level (ARCHITECTURE-P3 §5.2, D14, D22, M10; §7 W2
 * cli part 1).
 *
 *   global       `crypto key generate rsa [general-keys] [modulus <360-4096>]` (asks for the size when omitted, so
 *                that form is interactive; needs a hostname other than the default and `ip domain-name`; stored as
 *                `crypto key generate rsa modulus <n>`, which replaying regenerates — a listed deviation, D14),
 *                `crypto key zeroize rsa`, `ip ssh version 1|2`, `ip ssh time-out <s>`, `ip ssh authentication-retries
 *                <n>`, `username <name> privilege <0-15> secret <secret>` (the privilege form, D14, D21: `login local`
 *                and the API's Basic authentication read it through `userSecretOf`)
 *   line vty     `transport input ssh|telnet|ssh telnet|all|none`, `access-class <list> in` (stored and shown; [S13]
 *                enforces it at every remote login); `login local` is the P1 line-auth spec
 * `ip domain-name` (dns.ts) is widened to `managed-switch` in the same change (D14). `crypto key generate rsa` and a
 * `transport input` other than `none` wake a managed switch's dormant transport (D22; l3 reads the lines).
 *
 * Scope: routers and managed switches (D14: lessons 15 and 19 configure SSH on a switch). Help strings are original
 * wording (spec §1.6).
 */
import type { ArgSpec, CommandSpec } from '../../contracts/cli.js';
import type { Capability } from '../../contracts/catalog.js';
import { choiceArg, intArg, NFOS_ONLY, secretArg, wordArg } from './core-exec.js';

/** Handler ids of the SSH fragment. Never rename. */
export const SSH_HANDLERS = {
  configCryptoKeyGenerate: 'config.crypto-key-generate',
  configCryptoKeyZeroize: 'config.crypto-key-zeroize',
  configIpSsh: 'config.ip-ssh',
  configUsernamePrivilege: 'config.username-privilege',
  lineTransportInput: 'line.transport-input',
  lineAccessClass: 'line.access-class',
} as const;

/** @since P3 Capabilities offered the device-access lines (D14). */
export const SSH_CAPABILITIES: readonly Capability[] = Object.freeze(['routing', 'managed-switch']);

/** @since P3 `fixedArgs` key naming the sub-form of an `ip ssh` line. */
export const SSH_FORM_ARG = 'form';
/** @since P3 Bounds of an RSA key modulus (bits) and the size taken when the question is answered with nothing. */
export const RSA_MODULUS_MIN = 360;
export const RSA_MODULUS_MAX = 4096;
export const RSA_MODULUS_DEFAULT = 1024;
/** @since P3 Smallest key SSH version 2 accepts (bits). */
export const SSH_V2_MIN_MODULUS = 768;
/** @since P3 The `transport input` choices (one keyword, or `ssh telnet` in either order). */
export const TRANSPORT_INPUT_CHOICES = Object.freeze(['ssh', 'telnet', 'all', 'none'] as const);

const H = SSH_HANDLERS;
const OBJ_SSH = ['CCNA3.hardening.1'];
const OBJ_USERS = ['CCNA3.security.4'];
const OBJ_VTY_ACL = ['CCNA3.acl.9'];

const GLOBAL = { mode: 'config', privilege: 15, grammars: NFOS_ONLY, requiresAny: SSH_CAPABILITIES, since: 'P3' } as const;
const LINE = { mode: 'config-line', privilege: 15, allowNo: true, grammars: NFOS_ONLY, requiresAny: SSH_CAPABILITIES, since: 'P3' } as const;

const MODULUS_ARG: ArgSpec = intArg('Key size in bits (768 or more for SSH version 2)', RSA_MODULUS_MIN, RSA_MODULUS_MAX);

/** One `crypto key generate rsa` form. */
function keySpec(general: boolean, modulus: boolean): CommandSpec {
  const path = ['crypto', 'key', 'generate', 'rsa', ...(general ? ['general-keys'] : []), ...(modulus ? ['modulus', '<bits>'] : [])];
  return {
    ...GLOBAL,
    path,
    help: modulus ? 'Size of the key, so no question is asked' : general ? 'One key pair for every use (the only kind here)' : 'Create the RSA key pair SSH needs',
    ...(modulus ? { args: { bits: MODULUS_ARG } } : { interactive: true }),
    handler: H.configCryptoKeyGenerate,
    objectives: OBJ_SSH,
  };
}

/** The SSH command table. */
export const SSH_GRAMMAR: readonly CommandSpec[] = Object.freeze<CommandSpec[]>([
  keySpec(false, false),
  keySpec(true, false),
  keySpec(false, true),
  keySpec(true, true),
  {
    ...GLOBAL,
    path: ['crypto', 'key', 'zeroize', 'rsa'],
    help: 'Delete the RSA key pair (SSH stops)',
    handler: H.configCryptoKeyZeroize,
    objectives: OBJ_SSH,
  },
  {
    ...GLOBAL,
    path: ['ip', 'ssh', 'version', '<version>'],
    help: 'SSH protocol version this device accepts',
    args: { version: choiceArg('1 or 2 (2 needs a key of at least 768 bits)', ['1', '2']) },
    handler: H.configIpSsh,
    fixedArgs: { [SSH_FORM_ARG]: 'version' },
    allowNo: true,
    noArgsOptional: true,
    objectives: OBJ_SSH,
  },
  {
    ...GLOBAL,
    path: ['ip', 'ssh', 'time-out', '<seconds>'],
    help: 'Seconds a client has to log in (default 120)',
    args: { seconds: intArg('Seconds', 1, 120) },
    handler: H.configIpSsh,
    fixedArgs: { [SSH_FORM_ARG]: 'time-out' },
    allowNo: true,
    noArgsOptional: true,
    objectives: OBJ_SSH,
  },
  {
    ...GLOBAL,
    path: ['ip', 'ssh', 'authentication-retries', '<count>'],
    help: 'Failed logins allowed before the connection closes (default 3)',
    args: { count: intArg('Retries', 0, 5) },
    handler: H.configIpSsh,
    fixedArgs: { [SSH_FORM_ARG]: 'authentication-retries' },
    allowNo: true,
    noArgsOptional: true,
    objectives: OBJ_SSH,
  },
  {
    ...GLOBAL,
    path: ['username', '<name>', 'privilege', '<level>', 'secret', '<secret>'],
    help: 'A user who logs in at this privilege level (15 = privileged) with a hashed password',
    args: { name: wordArg('User name', { maxLength: 32 }), level: intArg('Privilege level', 0, 15), secret: secretArg('The password') },
    handler: H.configUsernamePrivilege,
    allowNo: true,
    noArgsOptional: true,
    objectives: OBJ_USERS,
  },
  {
    ...LINE,
    path: ['transport', 'input', '<protocol>'],
    help: 'Which protocols may open a remote session on these lines',
    args: { protocol: choiceArg('ssh, telnet, all of them, or none', TRANSPORT_INPUT_CHOICES) },
    handler: H.lineTransportInput,
    noArgsOptional: true,
    objectives: OBJ_SSH,
  },
  {
    ...LINE,
    path: ['transport', 'input', '<first>', '<second>'],
    help: 'Both SSH and telnet',
    args: { first: choiceArg('ssh or telnet', ['ssh', 'telnet']), second: choiceArg('the other one', ['ssh', 'telnet']) },
    handler: H.lineTransportInput,
    objectives: OBJ_SSH,
  },
  {
    ...LINE,
    path: ['access-class', '<list>', '<direction>'],
    help: 'Allow remote sessions only from the addresses a standard access list permits',
    args: { list: wordArg('Access list number or name', { maxLength: 64 }), direction: choiceArg('in: sessions arriving on these lines', ['in']) },
    handler: H.lineAccessClass,
    noArgsOptional: true,
    objectives: OBJ_VTY_ACL,
  },
]);
