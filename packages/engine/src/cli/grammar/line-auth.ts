/**
 * cli/grammar/line-auth.ts — passwords, banners and the terminal lines (ARCHITECTURE-P1 §4.10, §6 P1 table).
 *
 * `enable password` beside the `enable secret` of config-global.ts, `service password-encryption`,
 * `username X secret Y`, the login and exec banners, and the `line con 0` / `line vty 0 4` sections (mode
 * `config-line`) with `password`, `login` and `exec-timeout`. The runtime turns `login` plus a `password` on the
 * matching line into the login stage a new session must pass, and `enable` into a secret question.
 *
 * Secret values use the `secret` arg type: the parser reports their columns so the runtime keeps them out of the
 * session history, and the handlers store them hashed (`nf1`) or reversibly encoded (`nf7`), never in the clear.
 * Help strings are original wording (spec §1.6).
 *
 * ponytail: one `line <type> <first> [<last>]` spec for both console and vty lines; `exec-timeout` is stored and
 * shown but no timer disconnects an idle session yet.
 */
import type { CommandSpec } from '../../contracts/cli.js';
import { BANNER_TYPE_ARG, CONFIG_GLOBAL_HANDLERS } from './config-global.js';
import { choiceArg, intArg, NFOS_ONLY, restArg, secretArg, wordArg } from './core-exec.js';

/** Handler ids of the password, banner and line commands. */
export const LINE_AUTH_HANDLERS = {
  configEnablePassword: 'config.enable-password',
  configPasswordEncryption: 'config.service-password-encryption',
  configUsername: 'config.username',
  configLine: 'config.line',
  linePassword: 'line.password',
  lineLogin: 'line.login',
  lineExecTimeout: 'line.exec-timeout',
} as const;

/** Line types a `line` section may name: the console port and the remote terminal lines. */
export const LINE_TYPES: readonly string[] = Object.freeze(['con', 'vty']);

/** Highest line number a `line` section may name. */
export const LINE_NUMBER_MAX = 15;

const H = LINE_AUTH_HANDLERS;

/** The password, banner and line command table. */
export const LINE_AUTH_GRAMMAR: readonly CommandSpec[] = Object.freeze<CommandSpec[]>([
  {
    path: ['enable', 'password', '<secret>'],
    mode: 'config',
    privilege: 15,
    help: 'Weaker alternative to the enable secret (stored recoverably)',
    args: { secret: secretArg('The password') },
    handler: H.configEnablePassword,
    allowNo: true,
    noArgsOptional: true,
    grammars: NFOS_ONLY,
    since: 'P1',
    objectives: ['CCNA1.2.4'],
  },
  {
    path: ['service', 'password-encryption'],
    mode: 'config',
    privilege: 15,
    help: 'Store line and enable passwords scrambled instead of in the clear',
    handler: H.configPasswordEncryption,
    allowNo: true,
    grammars: NFOS_ONLY,
    since: 'P1',
    objectives: ['CCNA1.2.4'],
  },
  {
    path: ['username', '<name>', 'secret', '<secret>'],
    mode: 'config',
    privilege: 15,
    help: 'Define a user name and its password for "login local"',
    args: { name: wordArg('User name', { maxLength: 32 }), secret: secretArg('The password') },
    handler: H.configUsername,
    allowNo: true,
    noArgsOptional: true,
    grammars: NFOS_ONLY,
    since: 'P1',
    objectives: ['CCNA1.2.4'],
  },
  {
    path: ['banner', 'login', '<text>'],
    mode: 'config',
    privilege: 15,
    help: 'Message shown above the password question',
    args: { text: restArg('Banner text') },
    handler: CONFIG_GLOBAL_HANDLERS.configBanner,
    allowNo: true,
    noArgsOptional: true,
    fixedArgs: { [BANNER_TYPE_ARG]: 'login' },
    grammars: NFOS_ONLY,
    since: 'P1',
    objectives: ['CCNA1.2.4'],
  },
  {
    path: ['banner', 'exec', '<text>'],
    mode: 'config',
    privilege: 15,
    help: 'Message shown once a session reaches the prompt',
    args: { text: restArg('Banner text') },
    handler: CONFIG_GLOBAL_HANDLERS.configBanner,
    allowNo: true,
    noArgsOptional: true,
    fixedArgs: { [BANNER_TYPE_ARG]: 'exec' },
    grammars: NFOS_ONLY,
    since: 'P1',
    objectives: ['CCNA1.2.4'],
  },
  {
    path: ['line', '<type>', '<first>', '<last>'],
    mode: 'config',
    privilege: 15,
    help: 'Configure the console port or the remote terminal lines',
    args: {
      type: choiceArg('con for the console port, vty for remote sessions', LINE_TYPES),
      first: intArg('First line number', 0, LINE_NUMBER_MAX),
      last: intArg('Last line number of the range', 0, LINE_NUMBER_MAX, true),
    },
    handler: H.configLine,
    entersMode: 'config-line',
    sessionEffect: 'enter-mode',
    grammars: NFOS_ONLY,
    since: 'P1',
    objectives: ['CCNA1.2.4'],
  },
  {
    path: ['password', '<secret>'],
    mode: 'config-line',
    privilege: 15,
    help: 'Password this line asks for',
    args: { secret: secretArg('The password') },
    handler: H.linePassword,
    allowNo: true,
    noArgsOptional: true,
    grammars: NFOS_ONLY,
    since: 'P1',
    objectives: ['CCNA1.2.4'],
  },
  {
    path: ['login', '<method>'],
    mode: 'config-line',
    privilege: 15,
    help: 'Ask for a password before giving this line a prompt',
    args: { method: choiceArg('local checks the user name table instead of the line password', ['local'], true) },
    handler: H.lineLogin,
    allowNo: true,
    noArgsOptional: true,
    grammars: NFOS_ONLY,
    since: 'P1',
    objectives: ['CCNA1.2.4'],
  },
  {
    path: ['exec-timeout', '<minutes>', '<seconds>'],
    mode: 'config-line',
    privilege: 15,
    help: 'How long this line may stay idle before it is closed',
    args: { minutes: intArg('Minutes (0 never closes the line)', 0, 3600), seconds: intArg('Seconds', 0, 59, true) },
    handler: H.lineExecTimeout,
    allowNo: true,
    noArgsOptional: true,
    grammars: NFOS_ONLY,
    since: 'P1',
    objectives: ['CCNA1.2.4'],
  },
]);
