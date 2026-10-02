/**
 * cli/log-render.ts — [S24]/[S25] what the CLI runtime needs to print log and debug lines on its sessions
 * (ARCHITECTURE-P3 D20, §3.7; §7 W2 cli, `onLogEvent`). Pure: no state, no wall clock, integer arithmetic only.
 *
 * D20 keeps ONE renderer: the logger's (protocols/logger.ts, `formatLogLine` / `formatDebugLine`, exported for the
 * CLI). This module only adds what the console path decides on its own:
 *   • which `service timestamps log|debug …` form a device stores (a direct read of the top-level `service` lines, so a
 *     debug burst does not walk the whole configuration per line);
 *   • the most detailed severity a console prints (`consoleLogLevel`: a P3 world prints every level by default, a P1/P2
 *     world prints nothing until `logging console` is typed, so P1/P2 transcripts keep their bytes) and the one a
 *     `terminal monitor` session prints (`monitorLogLevel`);
 *   • `renderLogLine` / `renderDebugLine`: the trace event shapes handed to the logger's renderer. Without the
 *     timestamps line both give P1's `*hh:mm:ss.uuuuuu` prefix of simulation time (D20), so a P1/P2 console reads
 *     exactly as before.
 */
import type { DeviceClockView } from '../contracts/clock.js';
import type { ConfigNode } from '../contracts/config.js';
import type { DebugEvent } from '../contracts/process.js';
import type { SimTime } from '../contracts/time.js';
import type { TraceEvent } from '../contracts/trace.js';
import { formatDebugLine, formatLogLine, loggerLevelOf, parseTimestampFormat, type TimestampFormat } from '../protocols/logger.js';

/** @since P3 [S24] A `log` trace event (what `CliRuntime.onLogEvent` receives). */
export type LogTraceEvent = Extract<TraceEvent, { kind: 'log' }>;

/**
 * @since P3 [S24] The `service timestamps <kind> …` form stored at the top level of `root`, or undefined when the line
 * is absent (or does not read). A stored negation (`no service timestamps …`) is a `no` node and never counts.
 */
export function storedTimestampFormat(root: Pick<ConfigNode, 'children'>, kind: 'log' | 'debug'): TimestampFormat | undefined {
  for (const node of root.children) {
    if (node.key !== 'service' || node.args[0] !== 'timestamps' || node.args[1] !== kind) continue;
    return parseTimestampFormat(node.args.slice(2));
  }
  return undefined;
}

/** The first top-level node whose tokens start with `tokens`. */
function topLine(root: Pick<ConfigNode, 'children'>, tokens: readonly string[]): ConfigNode | undefined {
  return root.children.find((c) => {
    const t = [c.key, ...c.args];
    return tokens.every((x, i) => t[i] === x);
  });
}

/**
 * @since P3 [S24]/[S25] (D20) The most detailed severity the console prints, or -1 when it prints none: a stored
 * `no logging console` silences it; `logging console [<level>]` prints up to that level (debugging when omitted);
 * without either line a P3 world prints every level (the extended-logging default) and a P1/P2 world prints nothing.
 */
export function consoleLogLevel(root: Pick<ConfigNode, 'children'>, p3World: boolean): number {
  if (topLine(root, ['no', 'logging', 'console']) !== undefined) return -1;
  const line = topLine(root, ['logging', 'console']);
  if (line !== undefined) return loggerLevelOf(line.args[1]) ?? 7;
  return p3World ? 7 : -1;
}

/**
 * @since P3 [S25] The most detailed severity printed on a `terminal monitor` session: `logging monitor [<level>]`
 * (debugging when omitted or absent); a stored `no logging monitor` silences every monitoring session (-1).
 */
export function monitorLogLevel(root: Pick<ConfigNode, 'children'>): number {
  if (topLine(root, ['no', 'logging', 'monitor']) !== undefined) return -1;
  const line = topLine(root, ['logging', 'monitor']);
  return line === undefined ? 7 : (loggerLevelOf(line.args[1]) ?? 7);
}

/**
 * @since P3 [S24] One log line as a console prints it, through the logger's renderer: `ev.t` is the P1 prefix's time,
 * `clock` the device clock then, `uptime` the device's uptime then, `fmt` the `service timestamps log` form.
 */
export function renderLogLine(ev: Pick<LogTraceEvent, 't' | 'severity' | 'facility' | 'message' | 'mnemonic'>, clock: DeviceClockView, uptime: SimTime, fmt: TimestampFormat | undefined): string {
  const rec = { at: ev.t, severity: ev.severity, facility: ev.facility, message: ev.message, ...(ev.mnemonic === undefined ? {} : { mnemonic: ev.mnemonic }) };
  return formatLogLine(rec, clock, fmt, uptime);
}

/**
 * @since P3 [S24] One debug line under a stored `service timestamps debug …` form, through the logger's renderer (the
 * runtime keeps P1's literal line when the form is absent, so P1/P2 debug output is byte-identical).
 */
export function renderDebugLine(ev: Pick<DebugEvent, 'at' | 'category' | 'message'>, clock: DeviceClockView, uptime: SimTime, fmt: TimestampFormat): string {
  return formatDebugLine(ev, clock, fmt, uptime);
}
