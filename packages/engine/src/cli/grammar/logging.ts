/**
 * cli/grammar/logging.ts — [S24]/[S25] logging lines, `terminal monitor` and the server switch `service syslog on|off`
 * (ARCHITECTURE-P3 §5.7, §5.8, D20; §7 W2 cli, approved items).
 *
 * Global ([S24]): `logging buffered [<size>] [<level>]`, `logging console [<level>]` / `no logging console` (both forms
 * are stored), `logging monitor [<level>]`, `service timestamps log|debug datetime [msec] [localtime] [show-timezone]`
 * and `service timestamps log|debug uptime`. Global ([S25]): `logging host <addr>` (multi) and its alias
 * `logging <addr>` (stored as typed), `logging trap <level>`, `logging source-interface <if>`, `logging facility
 * local0-7`. A level is a number 0-7 or its keyword and is stored as the keyword (`logging trap warnings`).
 * Exec: `terminal monitor` / `terminal no monitor` (logs also print on this remote session). Host shell (servers):
 * `service syslog on|off` → the extension line `syslog-server enable` / its removal.
 *
 * Scope: the `logger` daemon rows of §2.1 (routing, managed-switch, wireless-controller) for the network lines; the
 * `server` capability (the `syslog-server` row) for `service syslog`. `terminal monitor` is privileged EXEC, so the
 * user EXEC help lists keep their §9.2 item 21 shape. Help strings are original wording (spec §1.6).
 */
import type { ArgSpec, CommandSpec } from '../../contracts/cli.js';
import type { Capability } from '../../contracts/catalog.js';
import { LOGGER_LEVEL_NAMES, LOGGING_BUFFER_MAX_BYTES, LOGGING_BUFFER_MIN_BYTES } from '../../protocols/logger.js';
import { choiceArg, HOST_ONLY, ifaceArg, intArg, ipv4Arg, NFOS_ONLY } from './core-exec.js';

/** @since P3 [S24]/[S25] Handler ids of the logging fragment. Never rename. */
export const LOGGING_HANDLERS = {
  configLoggingBuffered: 'config.logging-buffered',
  configLoggingConsole: 'config.logging-console',
  configLoggingMonitor: 'config.logging-monitor',
  configLoggingHost: 'config.logging-host',
  configLoggingTrap: 'config.logging-trap',
  configLoggingSourceInterface: 'config.logging-source-interface',
  configLoggingFacility: 'config.logging-facility',
  configServiceTimestamps: 'config.service-timestamps',
  execTerminalMonitor: 'exec.terminal-monitor',
  hostServiceSyslog: 'host.service-syslog',
} as const;

/**
 * @since P3 [S24] Severity keywords by level (0 = emergencies … 7 = debugging), the syslog severities: the logger's
 * own list (protocols/logger.ts), so the grammar and the daemon never disagree.
 */
export const LOG_LEVEL_NAMES: readonly string[] = LOGGER_LEVEL_NAMES;

/** @since P3 [S25] Facilities `logging facility` accepts. */
export const LOG_FACILITIES: readonly string[] = Object.freeze(['local0', 'local1', 'local2', 'local3', 'local4', 'local5', 'local6', 'local7']);

/** @since P3 [S24] Kinds of `service timestamps`, and the datetime options in their canonical order. */
export const TIMESTAMP_KINDS: readonly string[] = Object.freeze(['log', 'debug']);
export const TIMESTAMP_DATETIME_OPTIONS: readonly string[] = Object.freeze(['msec', 'localtime', 'show-timezone']);
/** @since P3 [S24] Arg name (`fixedArgs`) naming the timestamp form (`datetime` | `uptime`). */
export const TIMESTAMP_FORM_ARG = 'form';

/** @since P3 [S24] Bounds of the log buffer, in bytes: the logger's (a size outside them would be ignored there). */
export const LOG_BUFFER_MIN = LOGGING_BUFFER_MIN_BYTES;
export const LOG_BUFFER_MAX = LOGGING_BUFFER_MAX_BYTES;

/** @since P3 [S25] Arg name (`fixedArgs`) naming the typed form of a syslog host (`host` | `alias`, stored as typed). */
export const LOGGING_HOST_FORM_ARG = 'form';

/** @since P3 [S24] Arg name (`fixedArgs`) naming the `terminal monitor` direction (`on` | `off`). */
export const MONITOR_STATE_ARG = 'state';

/** @since P3 [S25] The extension line `service syslog on` writes on a server. */
export const SYSLOG_SERVER_LINE: readonly string[] = Object.freeze(['syslog-server', 'enable']);

/** @since P3 [S24] Capabilities whose devices run the logger (§2.1 rows). */
export const LOGGER_CAPABILITIES: readonly Capability[] = Object.freeze(['routing', 'managed-switch', 'wireless-controller'] as Capability[]);
/** @since P3 [S25] Capabilities whose devices run the syslog server (§2.1 rows). */
export const SYSLOG_SERVER_CAPABILITIES: readonly Capability[] = Object.freeze(['server'] as Capability[]);

const H = LOGGING_HANDLERS;

/** A severity: 0-7 or its keyword (stored as the keyword). */
function levelArg(help: string, optional: boolean): ArgSpec {
  const a: ArgSpec = { type: 'int', help, min: 0, max: 7, choices: LOG_LEVEL_NAMES };
  if (optional) a.optional = true;
  return a;
}

const GLOBAL_LINE = {
  mode: 'config',
  privilege: 15,
  allowNo: true,
  noArgsOptional: true,
  grammars: NFOS_ONLY,
  requiresAny: LOGGER_CAPABILITIES,
  since: 'P3',
  objectives: ['CCNA3.management.3'],
} as const;

/** @since P3 [S24]/[S25] The logging command table. */
export const LOGGING_GRAMMAR: readonly CommandSpec[] = Object.freeze<CommandSpec[]>([
  {
    ...GLOBAL_LINE,
    path: ['logging', 'buffered', '<level>'],
    help: 'Keep logs in a buffer on this device (show logging reads it)',
    args: { level: levelArg('Most detailed severity kept: 0-7 or its name', true) },
    handler: H.configLoggingBuffered,
  },
  {
    ...GLOBAL_LINE,
    path: ['logging', 'buffered', '<size>', '<level>'],
    help: 'Keep logs in a buffer of this many bytes',
    args: {
      size: intArg('Buffer size in bytes', LOG_BUFFER_MIN, LOG_BUFFER_MAX),
      level: levelArg('Most detailed severity kept: 0-7 or its name', true),
    },
    handler: H.configLoggingBuffered,
  },
  {
    ...GLOBAL_LINE,
    path: ['logging', 'console', '<level>'],
    help: 'Print logs on the console (no logging console stops it)',
    args: { level: levelArg('Most detailed severity printed: 0-7 or its name', true) },
    handler: H.configLoggingConsole,
  },
  {
    ...GLOBAL_LINE,
    path: ['logging', 'monitor', '<level>'],
    help: 'Print logs on remote sessions that asked for them (terminal monitor)',
    args: { level: levelArg('Most detailed severity printed: 0-7 or its name', true) },
    handler: H.configLoggingMonitor,
  },
  {
    ...GLOBAL_LINE,
    path: ['logging', 'host', '<address>'],
    help: 'Send logs to a syslog server',
    args: { address: ipv4Arg('Syslog server address') },
    handler: H.configLoggingHost,
    fixedArgs: { [LOGGING_HOST_FORM_ARG]: 'host' },
  },
  {
    ...GLOBAL_LINE,
    path: ['logging', '<address>'],
    help: 'Send logs to a syslog server (short form of logging host)',
    args: { address: ipv4Arg('Syslog server address') },
    handler: H.configLoggingHost,
    fixedArgs: { [LOGGING_HOST_FORM_ARG]: 'alias' },
  },
  {
    ...GLOBAL_LINE,
    path: ['logging', 'trap', '<level>'],
    help: 'Most detailed severity sent to syslog servers',
    args: { level: levelArg('Severity: 0-7 or its name (informational when not set)', false) },
    handler: H.configLoggingTrap,
  },
  {
    ...GLOBAL_LINE,
    path: ['logging', 'source-interface', '<iface>'],
    help: 'Interface whose address syslog messages are sent from',
    args: { iface: ifaceArg('Source interface', { completion: 'interfaces' }) },
    handler: H.configLoggingSourceInterface,
  },
  {
    ...GLOBAL_LINE,
    path: ['logging', 'facility', '<facility>'],
    help: 'Facility syslog messages carry (local7 when not set)',
    args: { facility: choiceArg('Facility', LOG_FACILITIES) },
    handler: H.configLoggingFacility,
  },
  {
    ...GLOBAL_LINE,
    path: ['service', 'timestamps', '<kind>', 'datetime', '<options>'],
    help: 'Stamp each line with the date and time of the device clock',
    args: {
      kind: choiceArg('log for log lines, debug for debug lines', TIMESTAMP_KINDS),
      options: { type: 'rest', help: '[msec] [localtime] [show-timezone]', optional: true },
    },
    handler: H.configServiceTimestamps,
    fixedArgs: { [TIMESTAMP_FORM_ARG]: 'datetime' },
  },
  {
    ...GLOBAL_LINE,
    path: ['service', 'timestamps', '<kind>', 'uptime'],
    help: 'Stamp each line with the time since the device started',
    args: { kind: choiceArg('log for log lines, debug for debug lines', TIMESTAMP_KINDS) },
    handler: H.configServiceTimestamps,
    fixedArgs: { [TIMESTAMP_FORM_ARG]: 'uptime' },
  },
  {
    path: ['terminal', 'monitor'],
    mode: 'priv-exec',
    privilege: 15,
    help: 'Also print logs on this session',
    handler: H.execTerminalMonitor,
    fixedArgs: { [MONITOR_STATE_ARG]: 'on' },
    grammars: NFOS_ONLY,
    requiresAny: LOGGER_CAPABILITIES,
    since: 'P3',
    objectives: ['CCNA3.management.3'],
  },
  {
    path: ['terminal', 'no', 'monitor'],
    mode: 'priv-exec',
    privilege: 15,
    help: 'Stop printing logs on this session',
    handler: H.execTerminalMonitor,
    fixedArgs: { [MONITOR_STATE_ARG]: 'off' },
    grammars: NFOS_ONLY,
    requiresAny: LOGGER_CAPABILITIES,
    since: 'P3',
    objectives: ['CCNA3.management.3'],
  },
  {
    path: ['service', 'syslog', '<state>'],
    mode: 'user-exec',
    privilege: 15,
    help: 'Switch this server\'s syslog receiver on or off',
    args: { state: choiceArg('on starts the receiver, off stops it', ['on', 'off']) },
    handler: H.hostServiceSyslog,
    grammars: HOST_ONLY,
    requiresAny: SYSLOG_SERVER_CAPABILITIES,
    since: 'P3',
    objectives: ['CCNA3.management.3'],
  },
]);

/** @since P3 [S24]/[S25] Help of the intermediate logging keywords (merged into `LITERAL_HELP` by the fold). */
export const LOGGING_LITERAL_HELP: Readonly<Record<string, string>> = Object.freeze({
  logging: 'Log settings',
  timestamps: 'How log and debug lines are stamped',
  terminal: 'Settings of this session',
});
