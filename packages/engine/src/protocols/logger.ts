/**
 * protocols/logger.ts — [S24] local logging (ARCHITECTURE-P3 D20, §2.5 `log.record`, §3.7 step 7, §4.3, §4.6 item 4,
 * §5.7, §5.8): the buffer, the levels and the one pure renderer over the device clock and `service timestamps`.
 *
 * The runtime's one log path (`DeviceRuntime.emitLog`, W1 device) emits the unchanged `log` trace event and, when the
 * model runs this daemon, delivers `ProcessEvent {kind: 'log.record', at, severity, facility, message, mnemonic?}`
 * depth-first inside the same action budget. The logger renders the line at once — the timestamp is the device clock
 * at the moment of the log, as real devices stamp it — and keeps it in a bounded buffer. Buffering produces no trace
 * and no action (§4.3): `show logging` (W3 cli) reads the StateView. [S25]'s UDP 514 sender is a delimited W3 block of
 * this file; console and `terminal monitor` printing is the CLI's (`onLogEvent`, fed from the trace sink).
 *
 * The renderer (`formatLogLine`, `formatDebugLine`, `formatLogTimestamp`; pure, exported for the CLI):
 *  • the line is `<stamp>: %FAC-SEV-MNEMONIC: text`, or `%FAC-SEV: text` without a mnemonic;
 *  • with `service timestamps <kind> datetime [msec] [localtime] [show-timezone]` the stamp is the device clock —
 *    `Jan  6 08:10:03.123` (`formatClock` 'timestamp-msec'; 'timestamp' without msec), in UTC unless `localtime`
 *    (then the `clock timezone` zone), followed by the zone name with `show-timezone`, with a leading `*` while the
 *    clock was never set; `service timestamps <kind> uptime` (also the meaning of a bare `service timestamps <kind>`)
 *    stamps the device uptime (`hh:mm:ss` under a day, `<d>d<hh>h` under a week, `<w>w<d>d` beyond);
 *  • WITHOUT the timestamps line the stamp is P1's debug prefix `*hh:mm:ss.uuuuuu` of SimTime (`formatSimTime`), so a
 *    debug line rendered here is byte-identical to the one the P1 CLI prints (`cli/runtime.ts` onDebugEvent), §4.6.
 *
 * Configuration (global lines, §5.7; read through `configTextLinesOf`, re-read after a `logging …` or `service …`
 * delta): `logging buffered [<size>] [<level>]` (size 4096–1048576 bytes, default 4096; level 0–7 or its keyword,
 * default debugging; a lone number 0–7 is a level), a stored `no logging buffered` (buffering off); `logging console
 * [<level>]` / `no logging console`; `logging monitor [<level>]` / `no logging monitor`. Buffering is on by default at
 * level debugging, as on real devices. A record whose severity is above the buffered level is counted, not kept.
 * The buffer is bounded in bytes (each line plus its newline); the oldest lines go first. Shrinking the size trims it.
 *
 * stateSnapshot (kind 'logger'): { buffered: { enabled, level, sizeBytes, usedBytes }, console: { enabled, level },
 *   monitor: { enabled, level }, timestamps: { log, debug } (the configured forms as text, or null), counts: { seen,
 *   buffered, filtered, overflowed }, entries: [{ seq, at, severity, facility, mnemonic?, message, text }] (oldest
 *   first) }.
 *
 * ponytail: no `logging discriminator`, no rate limiting, no sequence-number service; the history of a reload is lost
 * (the buffer is RAM, as on real devices).
 */
import { formatClock, type DeviceClockView } from '../contracts/clock.js';
import type { ConfigNode } from '../contracts/config.js';
import type { ProcessName } from '../contracts/ids.js';
import type { Action, DebugEvent, Process, ProcessCtx, Severity, StateView } from '../contracts/process.js';
import { formatSimTime, HOUR, MIN, SEC, type SimTime } from '../contracts/time.js';
import type { LogRecordEvent, ProcessEvent } from '../contracts/transport.js';
import { configTextLinesOf } from '../cli/config-text.js';

const NAME: ProcessName = 'logger';
/** Syslog level keywords, index = severity (§5.7). */
export const LOGGER_LEVEL_NAMES: readonly string[] = Object.freeze([
  'emergencies',
  'alerts',
  'critical',
  'errors',
  'warnings',
  'notifications',
  'informational',
  'debugging',
]);
/** Buffer size bounds and default, in bytes. */
export const LOGGING_BUFFER_MIN_BYTES = 4096;
export const LOGGING_BUFFER_MAX_BYTES = 1_048_576;
export const LOGGING_BUFFER_DEFAULT_BYTES = 4096;
/** Default level of the buffer, the console and the monitor: debugging. */
export const LOGGING_DEFAULT_LEVEL: Severity = 7;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;

/** A severity from a level token (0–7 or a keyword), else undefined. */
export function loggerLevelOf(token: string | undefined): Severity | undefined {
  if (token === undefined) return undefined;
  if (/^[0-7]$/.test(token)) return Number(token) as Severity;
  const i = LOGGER_LEVEL_NAMES.indexOf(token.toLowerCase());
  return i < 0 ? undefined : (i as Severity);
}

// ── the renderer (pure) ──────────────────────────────────────────────────────

/** One `service timestamps <kind> …` form. */
export type TimestampFormat =
  | { readonly kind: 'datetime'; readonly msec: boolean; readonly localtime: boolean; readonly showTimezone: boolean }
  | { readonly kind: 'uptime' };

/** The canonical text of a timestamp form (`datetime msec localtime`, `uptime`). */
export function timestampFormatText(f: TimestampFormat): string {
  if (f.kind === 'uptime') return 'uptime';
  return ['datetime', ...(f.msec ? ['msec'] : []), ...(f.localtime ? ['localtime'] : []), ...(f.showTimezone ? ['show-timezone'] : [])].join(' ');
}

/** The tokens after `service timestamps <kind>` as a form: `datetime [msec] [localtime] [show-timezone]` or `uptime`; none = uptime. */
export function parseTimestampFormat(tokens: readonly string[]): TimestampFormat | undefined {
  if (tokens.length === 0 || tokens[0] === 'uptime') return tokens.length <= 1 ? { kind: 'uptime' } : undefined;
  if (tokens[0] !== 'datetime') return undefined;
  const rest = tokens.slice(1);
  if (rest.some((t) => t !== 'msec' && t !== 'localtime' && t !== 'show-timezone')) return undefined;
  return { kind: 'datetime', msec: rest.includes('msec'), localtime: rest.includes('localtime'), showTimezone: rest.includes('show-timezone') };
}

/** The `service timestamps <kind>` form stored in `root` (§5.7, identity 3), or undefined when there is none. */
export function timestampFormatOf(root: ConfigNode, kind: 'log' | 'debug'): TimestampFormat | undefined {
  let out: TimestampFormat | undefined;
  for (const l of configTextLinesOf(root)) {
    const t = l.tokens;
    if (l.context.length !== 0 || l.negate || t[0] !== 'service' || t[1] !== 'timestamps' || t[2] !== kind) continue;
    out = parseTimestampFormat(t.slice(3));
  }
  return out;
}

/** Uptime as the timestamps `uptime` form shows it: `hh:mm:ss` under a day, `<d>d<hh>h` under a week, `<w>w<d>d`. */
export function formatUptime(ns: SimTime): string {
  const t = Math.max(0, ns);
  if (t < DAY) {
    const h = Math.floor(t / HOUR);
    const m = Math.floor((t % HOUR) / MIN);
    const s = Math.floor((t % MIN) / SEC);
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }
  if (t < WEEK) return `${Math.floor(t / DAY)}d${String(Math.floor((t % DAY) / HOUR)).padStart(2, '0')}h`;
  return `${Math.floor(t / WEEK)}w${Math.floor((t % WEEK) / DAY)}d`;
}

/**
 * The stamp of a line logged at `at` (D20): without a form, P1's `*hh:mm:ss.uuuuuu` of SimTime (byte-identical to the
 * P1 debug prefix); `datetime`, the device clock `clock` (UTC unless `localtime`; the zone name after it with
 * `show-timezone`; a leading `*` while the clock was never set); `uptime`, the device uptime `uptimeNs`.
 */
export function formatLogTimestamp(at: SimTime, clock: DeviceClockView, fmt: TimestampFormat | undefined, uptimeNs = 0): string {
  if (fmt === undefined) return `*${formatSimTime(at)}`;
  if (fmt.kind === 'uptime') return formatUptime(uptimeNs);
  const view: DeviceClockView = fmt.localtime ? clock : { ...clock, tz: { name: 'UTC', offsetMin: 0 } };
  const text = formatClock(view, fmt.msec ? 'timestamp-msec' : 'timestamp');
  return fmt.showTimezone ? `${text} ${view.tz.name}` : text;
}

/** `%FAC-SEV-MNEMONIC: text`, or `%FAC-SEV: text` without a mnemonic (D20; the shape is a teaching fact, D23). */
export function formatLogMessage(severity: Severity, facility: string, message: string, mnemonic?: string): string {
  return `%${facility}-${severity}${mnemonic !== undefined && mnemonic !== '' ? `-${mnemonic}` : ''}: ${message}`;
}

/** One log line: `<stamp>: %FAC-SEV[-MNEMONIC]: text` (D20). */
export function formatLogLine(
  rec: Pick<LogRecordEvent, 'at' | 'severity' | 'facility' | 'message' | 'mnemonic'>,
  clock: DeviceClockView,
  fmt: TimestampFormat | undefined,
  uptimeNs?: SimTime,
): string {
  return `${formatLogTimestamp(rec.at, clock, fmt, uptimeNs)}: ${formatLogMessage(rec.severity, rec.facility, rec.message, rec.mnemonic)}`;
}

/** One debug line: `<stamp>: <category>: <message>`; without a form exactly P1's line (§4.6 item 4). */
export function formatDebugLine(ev: Pick<DebugEvent, 'at' | 'category' | 'message'>, clock: DeviceClockView, fmt: TimestampFormat | undefined, uptimeNs?: SimTime): string {
  return `${formatLogTimestamp(ev.at, clock, fmt, uptimeNs)}: ${ev.category}: ${ev.message}`;
}

// ── configuration ────────────────────────────────────────────────────────────

/** One output's switch and level. */
export interface LogOutput {
  readonly enabled: boolean;
  readonly level: Severity;
}

/** What the logging lines of a running configuration ask for (§5.7, [S24]). */
export interface LoggingConfig {
  readonly buffered: LogOutput & { readonly sizeBytes: number };
  readonly console: LogOutput;
  readonly monitor: LogOutput;
  readonly log?: TimestampFormat;
  readonly debug?: TimestampFormat;
}

/** Read `logging buffered|console|monitor …` and `service timestamps …` from `root` (defaults: on, debugging, 4096 B). */
export function loggingConfigOf(root: ConfigNode): LoggingConfig {
  let buffered = { enabled: true, level: LOGGING_DEFAULT_LEVEL, sizeBytes: LOGGING_BUFFER_DEFAULT_BYTES };
  let consoleOut: LogOutput = { enabled: true, level: LOGGING_DEFAULT_LEVEL };
  let monitorOut: LogOutput = { enabled: true, level: LOGGING_DEFAULT_LEVEL };
  let log: TimestampFormat | undefined;
  let debug: TimestampFormat | undefined;
  for (const l of configTextLinesOf(root)) {
    const t = l.tokens;
    if (l.context.length !== 0) continue;
    if (t[0] === 'service' && t[1] === 'timestamps' && (t[2] === 'log' || t[2] === 'debug')) {
      const f = l.negate ? undefined : parseTimestampFormat(t.slice(3));
      if (t[2] === 'log') log = f;
      else debug = f;
      continue;
    }
    if (t[0] !== 'logging') continue;
    if (t[1] === 'buffered') {
      if (l.negate) {
        buffered = { ...buffered, enabled: false };
        continue;
      }
      let size = LOGGING_BUFFER_DEFAULT_BYTES;
      let level: Severity = LOGGING_DEFAULT_LEVEL;
      for (const tok of t.slice(2)) {
        const lv = loggerLevelOf(tok);
        const n = Number(tok);
        if (lv !== undefined) level = lv;
        else if (Number.isInteger(n) && n >= LOGGING_BUFFER_MIN_BYTES && n <= LOGGING_BUFFER_MAX_BYTES) size = n;
      }
      buffered = { enabled: true, level, sizeBytes: size };
    } else if (t[1] === 'console' || t[1] === 'monitor') {
      const out: LogOutput = l.negate ? { enabled: false, level: LOGGING_DEFAULT_LEVEL } : { enabled: true, level: loggerLevelOf(t[2]) ?? LOGGING_DEFAULT_LEVEL };
      if (t[1] === 'console') consoleOut = out;
      else monitorOut = out;
    }
  }
  const cfg: { -readonly [K in keyof LoggingConfig]: LoggingConfig[K] } = { buffered, console: consoleOut, monitor: monitorOut };
  if (log !== undefined) cfg.log = log;
  if (debug !== undefined) cfg.debug = debug;
  return cfg;
}

// ── the daemon ───────────────────────────────────────────────────────────────

/** One buffered line. */
export interface LoggerEntry {
  readonly seq: number;
  readonly at: SimTime;
  readonly severity: Severity;
  readonly facility: string;
  readonly mnemonic?: string;
  readonly message: string;
  /** The line as rendered when it was logged. */
  readonly text: string;
}

/** The logger StateView (kind 'logger', display only: `show logging`). */
export interface LoggerStateView {
  readonly buffered: LogOutput & { readonly sizeBytes: number; readonly usedBytes: number };
  readonly console: LogOutput;
  readonly monitor: LogOutput;
  readonly timestamps: { readonly log: string | null; readonly debug: string | null };
  readonly counts: { readonly seen: number; readonly buffered: number; readonly filtered: number; readonly overflowed: number };
  readonly entries: readonly LoggerEntry[];
}

/** Create the logger daemon ([S24]; silent: it never sends, and buffering writes no trace). */
export function createLogger(): Process {
  let cfg: LoggingConfig | undefined;
  let bootAt: SimTime = 0;
  let seq = 0;
  let usedBytes = 0;
  let seen = 0;
  let bufferedCount = 0;
  let filtered = 0;
  let overflowed = 0;
  const entries: LoggerEntry[] = [];

  const config = (ctx: ProcessCtx): LoggingConfig => (cfg ??= loggingConfigOf(ctx.config.root));

  /** Drop the oldest lines until the buffer fits `size` bytes. */
  function trim(size: number): void {
    while (entries.length > 0 && usedBytes > size) {
      const e = entries.shift() as LoggerEntry;
      usedBytes -= e.text.length + 1;
      overflowed++;
    }
  }

  function record(ctx: ProcessCtx, ev: LogRecordEvent): void {
    seen++;
    const c = config(ctx);
    if (!c.buffered.enabled || ev.severity > c.buffered.level) {
      filtered++;
      return;
    }
    const text = formatLogLine(ev, ctx.clock(), c.log, ev.at - bootAt);
    const entry: LoggerEntry =
      ev.mnemonic !== undefined
        ? { seq: ++seq, at: ev.at, severity: ev.severity, facility: ev.facility, mnemonic: ev.mnemonic, message: ev.message, text }
        : { seq: ++seq, at: ev.at, severity: ev.severity, facility: ev.facility, message: ev.message, text };
    entries.push(entry);
    usedBytes += text.length + 1;
    bufferedCount++;
    trim(c.buffered.sizeBytes);
  }

  return {
    name: NAME,

    init(ctx): Action[] {
      bootAt = ctx.now;
      cfg = loggingConfigOf(ctx.config.root);
      return [];
    },

    onPdu(_ctx, pdu, port): Action[] {
      return [{ type: 'drop', pdu, reason: 'unsupported-protocol', detail: 'the logger takes no packets', port }];
    },

    onConfig(ctx, delta): Action[] {
      if (delta.context.length !== 0 || (delta.line[0] !== 'logging' && delta.line[0] !== 'service')) return [];
      cfg = loggingConfigOf(ctx.config.root);
      if (!cfg.buffered.enabled) {
        entries.length = 0;
        usedBytes = 0;
      } else trim(cfg.buffered.sizeBytes);
      return [];
    },

    onTimer(): Action[] {
      return [];
    },

    onEvent(ctx, ev: ProcessEvent): Action[] {
      if (ev.kind === 'log.record') record(ctx, ev);
      return [];
    },

    stateSnapshot(): StateView {
      const c: LoggingConfig = cfg ?? {
        buffered: { enabled: true, level: LOGGING_DEFAULT_LEVEL, sizeBytes: LOGGING_BUFFER_DEFAULT_BYTES },
        console: { enabled: true, level: LOGGING_DEFAULT_LEVEL },
        monitor: { enabled: true, level: LOGGING_DEFAULT_LEVEL },
      };
      const view: LoggerStateView = {
        buffered: { ...c.buffered, usedBytes },
        console: { ...c.console },
        monitor: { ...c.monitor },
        timestamps: { log: c.log !== undefined ? timestampFormatText(c.log) : null, debug: c.debug !== undefined ? timestampFormatText(c.debug) : null },
        counts: { seen, buffered: bufferedCount, filtered, overflowed },
        entries: entries.map((e) => ({ ...e })),
      };
      return { process: NAME, state: { ...view } };
    },

    debugEvents(): readonly DebugEvent[] {
      return [];
    },
  };
}
