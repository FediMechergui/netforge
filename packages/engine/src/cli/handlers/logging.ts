/**
 * cli/handlers/logging.ts — [S24]/[S25] logging lines, `terminal monitor` and the server switch `service syslog on|off`
 * (ARCHITECTURE-P3 §5.7, D20; §7 W2 cli, approved items).
 *
 *   config.logging-buffered          `logging buffered [<size>] [<level>]` / `no logging buffered`
 *   config.logging-console           `logging console [<level>]` / `no logging console` (stored: both forms share a slot)
 *   config.logging-monitor           `logging monitor [<level>]` / `no logging monitor`
 *   config.logging-host              `logging host <a>` and its alias `logging <a>`, each stored as typed (multi);
 *                                    `no logging host [<a>]` / `no logging <a>`
 *   config.logging-trap              `logging trap <level>` / `no logging trap`
 *   config.logging-source-interface  `logging source-interface <if>` / its `no` form
 *   config.logging-facility          `logging facility local0-7` / its `no` form
 *   config.service-timestamps        `service timestamps log|debug datetime [msec] [localtime] [show-timezone]` (the
 *                                    options in that canonical order, each once) | `… uptime` / `no service timestamps
 *                                    log|debug`
 *   exec.terminal-monitor            `terminal monitor` / `terminal no monitor` (a session flag, never stored)
 *   host.service-syslog              `service syslog on|off` → `syslog-server enable` / its removal
 *
 * A level is stored as its keyword (`logging trap 4` → `logging trap warnings`). The logger and the syslog server read
 * these lines; the console and monitor printing reads them through cli/log-render.ts (the logger's renderer, D20).
 * Messages are original wording.
 */
import type { CommandHandler } from '../../contracts/cli.js';
import {
  LOG_LEVEL_NAMES,
  LOGGING_HANDLERS,
  LOGGING_HOST_FORM_ARG,
  MONITOR_STATE_ARG,
  SYSLOG_SERVER_LINE,
  TIMESTAMP_DATETIME_OPTIONS,
  TIMESTAMP_FORM_ARG,
} from '../grammar/logging.js';
import { ctxP3 } from '../command-ctx-p3.js';
import { globalContext, outcomeOf } from './common.js';

/** @since P3 [S24] `service timestamps … datetime` with an option it does not know or twice. */
export const MSG_TIMESTAMP_OPTIONS = '% Options of datetime: msec, localtime and show-timezone, each at most once.';
/** @since P3 [S25] `terminal monitor` on a session that cannot keep the flag (a hand-built context). */
export const MSG_MONITOR_UNAVAILABLE = '% This session cannot print logs.';
/** @since P3 [S25] Monitor switched on. */
export const MSG_MONITOR_ON = 'Logs now print on this session too.';
/** @since P3 [S25] Monitor switched off. */
export const MSG_MONITOR_OFF = 'Logs no longer print on this session.';

/** @since P3 [S24] The stored keyword of a typed level (a keyword or 0-7), or undefined for an absent level. */
export function levelKeyword(level: string | undefined): string | undefined {
  if (level === undefined || level === '') return undefined;
  if (/^[0-7]$/.test(level)) return LOG_LEVEL_NAMES[Number(level)];
  return LOG_LEVEL_NAMES.includes(level) ? level : undefined;
}

/** `logging <what> [<level>]` lines whose negation removes the line (`buffered`, `monitor`). */
function levelLine(what: 'buffered' | 'monitor'): CommandHandler {
  return (ctx, args, negate) => {
    if (negate) return outcomeOf(ctx.config(['logging', what], true, globalContext()));
    const size = what === 'buffered' && args['size'] !== undefined ? [String(Number(args['size']))] : [];
    const level = levelKeyword(args['level']);
    return outcomeOf(ctx.config(['logging', what, ...size, ...(level === undefined ? [] : [level])], false, globalContext()));
  };
}

/** `logging console [<level>]` / `no logging console` (the both-forms slot keeps the negation). */
const loggingConsole: CommandHandler = (ctx, args, negate) => {
  if (negate) return outcomeOf(ctx.config(['logging', 'console'], true, globalContext()));
  const level = levelKeyword(args['level']);
  return outcomeOf(ctx.config(['logging', 'console', ...(level === undefined ? [] : [level])], false, globalContext()));
};

/** `logging host <a>` / `logging <a>` (stored as typed) and their `no` forms. */
const loggingHost: CommandHandler = (ctx, args, negate) => {
  const head = args[LOGGING_HOST_FORM_ARG] === 'alias' ? ['logging'] : ['logging', 'host'];
  const address = args['address'];
  if (address === undefined || address === '') {
    return negate ? outcomeOf(ctx.config(head, true, globalContext())) : { error: '% Give the syslog server address.' };
  }
  return outcomeOf(ctx.config([...head, address], negate, globalContext()));
};

/** `logging trap <level>` / `no logging trap`. */
const loggingTrap: CommandHandler = (ctx, args, negate) => {
  if (negate) return outcomeOf(ctx.config(['logging', 'trap'], true, globalContext()));
  const level = levelKeyword(args['level']);
  if (level === undefined) return { error: '% Give a severity: 0-7 or its name.' };
  return outcomeOf(ctx.config(['logging', 'trap', level], false, globalContext()));
};

/** A one-value `logging <what> <v>` line and its `no` form. */
function valueLine(what: 'source-interface' | 'facility', arg: string): CommandHandler {
  return (ctx, args, negate) => {
    if (negate) return outcomeOf(ctx.config(['logging', what], true, globalContext()));
    const value = args[arg] ?? '';
    if (value === '') return { error: '% Give the value.' };
    return outcomeOf(ctx.config(['logging', what, value], false, globalContext()));
  };
}

/** @since P3 [S24] The canonical datetime options of a typed tail, or undefined when one is unknown or repeated. */
export function datetimeOptions(tail: string | undefined): string[] | undefined {
  const typed = (tail ?? '').trim() === '' ? [] : (tail ?? '').trim().toLowerCase().split(/\s+/);
  const seen = new Set<string>();
  for (const t of typed) {
    if (!TIMESTAMP_DATETIME_OPTIONS.includes(t) || seen.has(t)) return undefined;
    seen.add(t);
  }
  return TIMESTAMP_DATETIME_OPTIONS.filter((o) => seen.has(o));
}

/** `service timestamps log|debug datetime …|uptime` / `no service timestamps log|debug`. */
const serviceTimestamps: CommandHandler = (ctx, args, negate) => {
  const kind = args['kind'] ?? '';
  if (kind === '') return { error: '% Give log or debug.' };
  const head = ['service', 'timestamps', kind];
  if (negate) return outcomeOf(ctx.config(head, true, globalContext()));
  if (args[TIMESTAMP_FORM_ARG] === 'uptime') return outcomeOf(ctx.config([...head, 'uptime'], false, globalContext()));
  const options = datetimeOptions(args['options']);
  if (options === undefined) return { error: MSG_TIMESTAMP_OPTIONS };
  return outcomeOf(ctx.config([...head, 'datetime', ...options], false, globalContext()));
};

/** `terminal monitor` / `terminal no monitor`: a flag of this session, never stored. */
const terminalMonitor: CommandHandler = (ctx, args) => {
  const set = ctxP3(ctx).setMonitor;
  if (set === undefined) return { error: MSG_MONITOR_UNAVAILABLE };
  const on = args[MONITOR_STATE_ARG] !== 'off';
  set(on);
  return { output: on ? MSG_MONITOR_ON : MSG_MONITOR_OFF };
};

/** `service syslog on|off` on a server. */
const serviceSyslog: CommandHandler = (ctx, args) => {
  const on = args['state'] === 'on';
  const error = ctx.config([...SYSLOG_SERVER_LINE], !on, globalContext());
  if (error !== undefined) return { error };
  return { output: on ? 'Syslog receiver started.' : 'Syslog receiver stopped.' };
};

/** @since P3 [S24]/[S25] Registry fragment: logging handler id → handler. */
export const loggingHandlers: Readonly<Record<string, CommandHandler>> = {
  [LOGGING_HANDLERS.configLoggingBuffered]: levelLine('buffered'),
  [LOGGING_HANDLERS.configLoggingConsole]: loggingConsole,
  [LOGGING_HANDLERS.configLoggingMonitor]: levelLine('monitor'),
  [LOGGING_HANDLERS.configLoggingHost]: loggingHost,
  [LOGGING_HANDLERS.configLoggingTrap]: loggingTrap,
  [LOGGING_HANDLERS.configLoggingSourceInterface]: valueLine('source-interface', 'iface'),
  [LOGGING_HANDLERS.configLoggingFacility]: valueLine('facility', 'facility'),
  [LOGGING_HANDLERS.configServiceTimestamps]: serviceTimestamps,
  [LOGGING_HANDLERS.execTerminalMonitor]: terminalMonitor,
  [LOGGING_HANDLERS.hostServiceSyslog]: serviceSyslog,
};
