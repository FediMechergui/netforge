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
 * The console's default is `cli/log-render.ts` `consoleLogLevel`'s (ruling R25): without a `logging console` line a
 * P3 world prints every level (debugging) and a P1/P2 world prints none (`enabled: false`) — the world's profile is
 * read for this invisible default only.
 *
 * [S25] The UDP 514 sender (the delimited W3 svc block below; D20, §3.7 step 8, §4.3): with at least one `logging host
 * <a>` (or its alias `logging <a>`), every record whose severity is at or below `logging trap` (informational when not
 * set) leaves at once — no timer, no queue — as one datagram per host, in configuration order, `[ipv4, udp 514 → 514,
 * syslog {pri = facility × 8 + severity, timestamp, hostname, message}]`: the facility is `logging facility local0-7`
 * (local7 = 23 when not set), the timestamp the stamp of the buffered line (the same renderer, the device clock and
 * `service timestamps log`), the hostname the device's, the message `%FAC-SEV[-MNEMONIC]: text`. The source address is
 * `logging source-interface`'s when that interface has one, else udp's choice. The daemon owns socket `logger#514`
 * (0.0.0.0, the fixed RFC 3164 source port 514: no ephemeral draw, §4.1) only while a host is configured; with none it
 * opens no socket and sends nothing (silence, §4.3), and a P1/P2 file never holds the line (the P1/P2 grammars refused
 * it). On a managed switch the line also wakes the dormant transport (D22, `DORMANT_TRANSPORT_OWNERS`, l3). A send udp
 * refuses (no route, no address) is udp's `sock.error`, ignored here: syslog is fire-and-forget.
 *
 * stateSnapshot (kind 'logger', `LoggerStateView` of contracts/process.ts, R25): { buffered: { enabled, level,
 *   sizeBytes, usedBytes }, console: { enabled, level }, monitor: { enabled, level }, timestamps: { log, debug } (the
 *   configured forms as text, or null), counts: { seen, buffered, filtered, overflowed }, entries: [{ seq, at, severity,
 *   facility, mnemonic?, message, text }] (oldest first), syslog?: { trap, facility, hosts: [{ address, sent }], sent }
 *   ([S25]: only while a `logging host` is configured) }.
 *
 * ponytail: no `logging discriminator`, no rate limiting, no sequence-number service; the history of a reload is lost
 * (the buffer is RAM, as on real devices); syslog over IPv4 only (the grammar takes IPv4 hosts), no TCP or TLS
 * transport, no per-host trap level.
 */
import { profileIncludes } from '../contracts/catalog.js';
import { formatClock, type DeviceClockView } from '../contracts/clock.js';
import { isIpv4, type Ipv4Address } from '../contracts/addr.js';
import type { ConfigNode } from '../contracts/config.js';
import type { PortId, ProcessName } from '../contracts/ids.js';
import { UDP_PORT_SYSLOG, type FieldValue } from '../contracts/pdu.js';
import type {
  Action,
  DebugEvent,
  LoggerEntryView,
  LoggerOutputView,
  LoggerStateView,
  LoggerSyslogView,
  Process,
  ProcessCtx,
  ProcessRequest,
  Severity,
  StateView,
} from '../contracts/process.js';
import { formatSimTime, HOUR, MIN, SEC, type SimTime } from '../contracts/time.js';
import type { LogRecordEvent, ProcessEvent } from '../contracts/transport.js';
import { configTextLinesOf } from '../cli/config-text.js';

/** @since P3 [S24] The logger StateView is a contract type (ruling R25); re-exported here for the daemon's callers. */
export type { LoggerStateView } from '../contracts/process.js';

const NAME: ProcessName = 'logger';

/**
 * @since P3 (W3 fix, ruling R38) The request `clear logging` sends (`cli/handlers/logging.ts` `LOGGING_CLEAR_REQUEST`, the
 * same text): the contract's `ext.` slot; the logger empties its buffer's lines and used bytes and keeps its counters.
 */
export const LOGGER_CLEAR_REQUEST = 'ext.logging.clear';
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

/** One output's switch and level (the contract's `LoggerOutputView`, R25). */
export type LogOutput = LoggerOutputView;

/** What the logging lines of a running configuration ask for (§5.7, [S24]). */
export interface LoggingConfig {
  readonly buffered: LogOutput & { readonly sizeBytes: number };
  readonly console: LogOutput;
  readonly monitor: LogOutput;
  readonly log?: TimestampFormat;
  readonly debug?: TimestampFormat;
}

/**
 * Read `logging buffered|console|monitor …` and `service timestamps …` from `root` (defaults: on, debugging, 4096 B).
 * `p3World` (R25) is the console's default, as `cli/log-render.ts` `consoleLogLevel` decides it: without a `logging
 * console` line a P3 world prints every level and a P1/P2 world (`false`) prints none. The logger passes its world's
 * profile; the default `true` is the logger's own stage.
 */
export function loggingConfigOf(root: ConfigNode, p3World = true): LoggingConfig {
  let buffered = { enabled: true, level: LOGGING_DEFAULT_LEVEL, sizeBytes: LOGGING_BUFFER_DEFAULT_BYTES };
  let consoleOut: LogOutput = { enabled: p3World, level: LOGGING_DEFAULT_LEVEL };
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

// ── [S25] the UDP 514 sender: configuration (W3 svc; a delimited block of the W2 logger) ─────────────────────────

/** @since P3 [S25] The logger's syslog socket: 0.0.0.0:514, the fixed RFC 3164 source port (no ephemeral draw, §4.1). */
export const LOGGER_SYSLOG_SOCKET = 'logger#514';
/** @since P3 [S25] `logging trap` when not set: informational (§5.7). */
export const LOGGING_TRAP_DEFAULT: Severity = 6;
/** @since P3 [S25] The RFC 3164 number of facility local0 (`logging facility local<n>` is 16 + n). */
export const SYSLOG_FACILITY_LOCAL0 = 16;
/** @since P3 [S25] `logging facility` when not set: local7 (23), so a severity-3 line has priority 187 (§3.7). */
export const LOGGING_FACILITY_DEFAULT = 23;
/** @since P3 [S25] The tag of every syslog datagram the logger builds. */
export const SYSLOG_PDU_TAG = 'syslog';

/** @since P3 [S25] What the syslog lines of a running configuration ask for (§5.7). */
export interface SyslogConfig {
  /** `logging host <a>` and its alias `logging <a>`, in running-configuration order, each address once. */
  readonly hosts: readonly Ipv4Address[];
  /** `logging trap <level>` (informational when not set). */
  readonly trap: Severity;
  /** `logging facility local0-7` as its RFC 3164 number (local7 = 23 when not set). */
  readonly facility: number;
  /** `logging source-interface <if>`. */
  readonly sourceInterface?: string;
}

/** @since P3 [S25] The RFC 3164 number of `local0`–`local7`, else undefined. */
export function syslogFacilityOf(token: string | undefined): number | undefined {
  const m = token === undefined ? null : /^local([0-7])$/.exec(token.toLowerCase());
  return m === null ? undefined : SYSLOG_FACILITY_LOCAL0 + Number(m[1]);
}

/** @since P3 [S25] Read `logging host|trap|facility|source-interface` and `logging <a>` from `root` (§5.7). */
export function syslogConfigOf(root: ConfigNode): SyslogConfig {
  const hosts: Ipv4Address[] = [];
  let trap: Severity = LOGGING_TRAP_DEFAULT;
  let facility = LOGGING_FACILITY_DEFAULT;
  let sourceInterface: string | undefined;
  for (const l of configTextLinesOf(root)) {
    const t = l.tokens;
    if (l.context.length !== 0 || l.negate || t[0] !== 'logging') continue;
    const what = t[1] ?? '';
    if (what === 'host' || (t.length === 2 && isIpv4(what))) {
      const address = what === 'host' ? t[2] : what;
      if (address !== undefined && isIpv4(address) && !hosts.includes(address)) hosts.push(address);
    } else if (what === 'trap') trap = loggerLevelOf(t[2]) ?? LOGGING_TRAP_DEFAULT;
    else if (what === 'facility') facility = syslogFacilityOf(t[2]) ?? LOGGING_FACILITY_DEFAULT;
    else if (what === 'source-interface' && t[2] !== undefined) sourceInterface = t[2];
  }
  return sourceInterface === undefined ? { hosts, trap, facility } : { hosts, trap, facility, sourceInterface };
}

/**
 * @since P3 [S25] The hostname a syslog header can carry (the codec's rule: one word, no ':', not starting with '%'):
 * runs of white space and ':' become '-', leading '%' are dropped. An empty result sends the message without a
 * header (no timestamp, no hostname), which the codec allows.
 */
export function syslogHostname(name: string): string {
  return name.replace(/[\s:]+/g, '-').replace(/^%+/, '');
}

/** @since P3 [S25] The syslog fields of one record (§3.7 step 8): priority, the line's stamp, the hostname, the message. */
export function syslogFields(
  rec: Pick<LogRecordEvent, 'severity' | 'facility' | 'message' | 'mnemonic'>,
  facility: number,
  stamp: string,
  hostname: string,
): Record<string, FieldValue> {
  const host = syslogHostname(hostname);
  return {
    pri: facility * 8 + rec.severity,
    timestamp: host === '' ? '' : stamp,
    hostname: host,
    message: formatLogMessage(rec.severity, rec.facility, rec.message, rec.mnemonic),
  };
}

// ── end of the [S25] configuration block ──────────────────────────────────────────────────────────────────────────

// ── the daemon ───────────────────────────────────────────────────────────────

/** One buffered line (the contract's `LoggerEntryView`, R25). */
export type LoggerEntry = LoggerEntryView;

/** Create the logger daemon ([S24]: buffering is silent; [S25]: it sends only with a `logging host` line). */
export function createLogger(): Process {
  let cfg: LoggingConfig | undefined;
  /** R25: the world's profile decides the console's default (read for that invisible default only). */
  let p3World = true;
  let bootAt: SimTime = 0;
  let seq = 0;
  let usedBytes = 0;
  let seen = 0;
  let bufferedCount = 0;
  let filtered = 0;
  let overflowed = 0;
  const entries: LoggerEntry[] = [];
  // [S25] the UDP 514 sender's state
  let syslog: SyslogConfig | undefined;
  let syslogOpen = false;
  let syslogSent = 0;
  const sentTo = new Map<Ipv4Address, number>();

  function readConfig(ctx: ProcessCtx): LoggingConfig {
    p3World = profileIncludes(ctx.profile, 'P3');
    const next = loggingConfigOf(ctx.config.root, p3World);
    cfg = next;
    return next;
  }

  const config = (ctx: ProcessCtx): LoggingConfig => cfg ?? readConfig(ctx);

  /** Drop the oldest lines until the buffer fits `size` bytes. */
  function trim(size: number): void {
    while (entries.length > 0 && usedBytes > size) {
      const e = entries.shift() as LoggerEntry;
      usedBytes -= e.text.length + 1;
      overflowed++;
    }
  }

  function record(ctx: ProcessCtx, ev: LogRecordEvent): Action[] {
    seen++;
    const c = config(ctx);
    // one stamp per record, shared by the buffered line and the [S25] syslog header (one renderer, D20)
    let stamp: string | undefined;
    const stampOf = (): string => (stamp ??= formatLogTimestamp(ev.at, ctx.clock(), c.log, ev.at - bootAt));
    if (!c.buffered.enabled || ev.severity > c.buffered.level) filtered++;
    else {
      const text = `${stampOf()}: ${formatLogMessage(ev.severity, ev.facility, ev.message, ev.mnemonic)}`;
      const entry: LoggerEntry =
        ev.mnemonic !== undefined
          ? { seq: ++seq, at: ev.at, severity: ev.severity, facility: ev.facility, mnemonic: ev.mnemonic, message: ev.message, text }
          : { seq: ++seq, at: ev.at, severity: ev.severity, facility: ev.facility, message: ev.message, text };
      entries.push(entry);
      usedBytes += text.length + 1;
      bufferedCount++;
      trim(c.buffered.sizeBytes);
    }
    return sendSyslog(ctx, ev, stampOf);
  }

  // ── [S25] the UDP 514 sender (W3 svc; a delimited block of the W2 logger) ──────────────────────────────────────

  const syslogConfig = (ctx: ProcessCtx): SyslogConfig => (syslog ??= syslogConfigOf(ctx.config.root));

  function openSyslog(): Action {
    syslogOpen = true;
    return { type: 'request', to: 'udp', req: { kind: 'udp.open', owner: NAME, socket: LOGGER_SYSLOG_SOCKET, family: 4, localAddr: '0.0.0.0', localPort: UDP_PORT_SYSLOG } };
  }

  /** Re-read the syslog lines and converge the socket: open while a host is configured, closed otherwise (§4.3). */
  function syncSyslog(ctx: ProcessCtx): Action[] {
    const next = syslogConfigOf(ctx.config.root);
    syslog = next;
    for (const host of [...sentTo.keys()]) if (!next.hosts.includes(host)) sentTo.delete(host);
    if (next.hosts.length > 0 && !syslogOpen) return [openSyslog()];
    if (next.hosts.length === 0 && syslogOpen) {
      syslogOpen = false;
      return [{ type: 'request', to: 'udp', req: { kind: 'udp.close', socket: LOGGER_SYSLOG_SOCKET } }];
    }
    return [];
  }

  /** One datagram per configured host for a record at or below the trap level, at once (§3.7 step 8, §4.2). */
  function sendSyslog(ctx: ProcessCtx, ev: LogRecordEvent, stampOf: () => string): Action[] {
    const s = syslogConfig(ctx);
    if (s.hosts.length === 0 || ev.severity > s.trap) return [];
    const out: Action[] = syslogOpen ? [] : [openSyslog()];
    const fields = syslogFields(ev, s.facility, stampOf(), ctx.hostname);
    const src = s.sourceInterface === undefined ? undefined : ctx.ports.get(s.sourceInterface as PortId)?.l3.ipv4?.address;
    for (const host of s.hosts) {
      const req: Extract<ProcessRequest, { kind: 'udp.send' }> = {
        kind: 'udp.send',
        socket: LOGGER_SYSLOG_SOCKET,
        dst: host,
        dstPort: UDP_PORT_SYSLOG,
        tag: SYSLOG_PDU_TAG,
        app: [{ proto: 'syslog', fields: { ...fields } }],
      };
      if (src !== undefined) req.src = src;
      out.push({ type: 'request', to: 'udp', req });
      sentTo.set(host, (sentTo.get(host) ?? 0) + 1);
      syslogSent++;
    }
    return out;
  }

  function syslogView(): LoggerSyslogView | undefined {
    const s = syslog;
    if (s === undefined || s.hosts.length === 0) return undefined;
    return { trap: s.trap, facility: s.facility, hosts: s.hosts.map((address) => ({ address, sent: sentTo.get(address) ?? 0 })), sent: syslogSent };
  }

  // ── end of the [S25] sender block ──────────────────────────────────────────────────────────────────────────────

  return {
    name: NAME,

    init(ctx): Action[] {
      bootAt = ctx.now;
      readConfig(ctx);
      return syncSyslog(ctx);
    },

    onPdu(_ctx, pdu, port): Action[] {
      return [{ type: 'drop', pdu, reason: 'unsupported-protocol', detail: 'the logger takes no packets', port }];
    },

    onConfig(ctx, delta): Action[] {
      if (delta.context.length !== 0 || (delta.line[0] !== 'logging' && delta.line[0] !== 'service')) return [];
      const c = readConfig(ctx);
      if (!c.buffered.enabled) {
        entries.length = 0;
        usedBytes = 0;
      } else trim(c.buffered.sizeBytes);
      return delta.line[0] === 'logging' ? syncSyslog(ctx) : [];
    },

    onTimer(): Action[] {
      return [];
    },

    onEvent(ctx, ev: ProcessEvent): Action[] {
      // [S25] sock.opened / sock.error / sock.datagram of `logger#514` need no answer: syslog is fire-and-forget
      return ev.kind === 'log.record' ? record(ctx, ev) : [];
    },

    /**
     * Ruling R38: `clear logging` (`ext.logging.clear`) empties the buffer's lines and used bytes and keeps every
     * counter (seen, buffered, filtered, overflowed). Silent: no trace action, no debug line.
     */
    onRequest(_ctx, req: ProcessRequest): Action[] {
      if (req.kind === LOGGER_CLEAR_REQUEST) {
        entries.length = 0;
        usedBytes = 0;
      }
      return [];
    },

    stateSnapshot(): StateView {
      const c: LoggingConfig = cfg ?? {
        buffered: { enabled: true, level: LOGGING_DEFAULT_LEVEL, sizeBytes: LOGGING_BUFFER_DEFAULT_BYTES },
        console: { enabled: p3World, level: LOGGING_DEFAULT_LEVEL },
        monitor: { enabled: true, level: LOGGING_DEFAULT_LEVEL },
      };
      const view: { -readonly [K in keyof LoggerStateView]: LoggerStateView[K] } = {
        buffered: { ...c.buffered, usedBytes },
        console: { ...c.console },
        monitor: { ...c.monitor },
        timestamps: { log: c.log !== undefined ? timestampFormatText(c.log) : null, debug: c.debug !== undefined ? timestampFormatText(c.debug) : null },
        counts: { seen, buffered: bufferedCount, filtered, overflowed },
        entries: entries.map((e) => ({ ...e })),
      };
      const sl = syslogView(); // [S25] optional by meaning: only while a `logging host` is configured
      if (sl !== undefined) view.syslog = sl;
      return { process: NAME, state: { ...view } };
    },

    debugEvents(): readonly DebugEvent[] {
      return [];
    },
  };
}
