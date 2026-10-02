/**
 * cli.logging — [S24]/[S25] logging lines, `terminal monitor`, `service syslog on|off` and the console / monitor
 * printing of `onLogEvent` (ARCHITECTURE-P3 §5.7, D20, §3.7; §7 W2 cli, approved items): canonical stored lines
 * (levels as keywords, timestamp options in order), the console path of cli/log-render.ts over the logger's one
 * renderer (D20), and which sessions print a log: P3 consoles by default, P1/P2 consoles only after a typed `logging
 * console`, `terminal monitor` sessions up to `logging monitor`; never a `cliOutput` in a P2 world without the line
 * (P1/P2 transcripts keep their bytes); debug lines stamped by `service timestamps debug`, P1's line without it.
 */
import { describe, expect, it } from 'vitest';
import type { DeviceClockView } from '../src/contracts/clock.js';
import type { TraceEvent } from '../src/contracts/trace.js';
import {
  LOG_BUFFER_MAX,
  LOG_BUFFER_MIN,
  LOG_LEVEL_NAMES,
  LOGGING_HANDLERS as H,
  LOGGING_HOST_FORM_ARG,
  MONITOR_STATE_ARG,
  TIMESTAMP_FORM_ARG,
} from '../src/cli/grammar/logging.js';
import { datetimeOptions, levelKeyword, MSG_TIMESTAMP_OPTIONS } from '../src/cli/handlers/logging.js';
import { consoleLogLevel, monitorLogLevel, renderDebugLine, renderLogLine, storedTimestampFormat } from '../src/cli/log-render.js';
import { formatLogLine, LOGGER_LEVEL_NAMES, LOGGING_BUFFER_MAX_BYTES, LOGGING_BUFFER_MIN_BYTES, timestampFormatOf } from '../src/protocols/logger.js';
import { createConfigAst } from '../src/cli/config-ast.js';
import { approvedCtx, approvedHarness, body, handlerOf, parse, run, withProfile } from './cli.p3-approved.fixture.js';

const R = 'router.nf2911';
const SEC = 1_000_000_000;

/** Mon 2025-01-06 08:10:03.123 UTC, synchronised. */
const SYNCED: DeviceClockView = { source: 'ntp', authoritative: true, unixMs: 1_736_151_003_123, subMsNs: 0, tz: { name: 'CET', offsetMin: 60 } };

function logEvent(severity: 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7, mnemonic?: string): Extract<TraceEvent, { kind: 'log' }> {
  const ev: Extract<TraceEvent, { kind: 'log' }> = { t: 400 * SEC, kind: 'log', device: 'd_1', severity, facility: 'LINK', message: 'Interface GigabitEthernet0/2 changed state to down' };
  if (mnemonic !== undefined) ev.mnemonic = mnemonic;
  return ev;
}

describe('cli.logging grammar and handlers', () => {
  it('parses every line on routers and switches, and service syslog on servers', () => {
    expect(handlerOf(R, 'config', 'logging buffered')).toBe(H.configLoggingBuffered);
    expect(handlerOf(R, 'config', 'logging buffered 8192 warnings')).toBe(H.configLoggingBuffered);
    expect(handlerOf(R, 'config', 'logging buffered 4')).toBe(H.configLoggingBuffered);
    expect(handlerOf('switch.nfc2960', 'config', 'logging console 3')).toBe(H.configLoggingConsole);
    expect(handlerOf(R, 'config', 'no logging console')).toBe(H.configLoggingConsole);
    expect(handlerOf(R, 'config', 'logging monitor informational')).toBe(H.configLoggingMonitor);
    expect(handlerOf(R, 'config', 'logging host 10.0.0.10')).toBe(H.configLoggingHost);
    expect(handlerOf(R, 'config', 'logging 10.0.0.10')).toBe(H.configLoggingHost);
    expect(handlerOf(R, 'config', 'logging trap warnings')).toBe(H.configLoggingTrap);
    expect(handlerOf(R, 'config', 'logging source-interface g0/0')).toBe(H.configLoggingSourceInterface);
    expect(handlerOf(R, 'config', 'logging facility local7')).toBe(H.configLoggingFacility);
    expect(handlerOf(R, 'config', 'service timestamps log datetime msec')).toBe(H.configServiceTimestamps);
    expect(handlerOf(R, 'config', 'service timestamps debug uptime')).toBe(H.configServiceTimestamps);
    expect(handlerOf(R, 'priv-exec', 'terminal monitor')).toBe(H.execTerminalMonitor);
    expect(handlerOf(R, 'priv-exec', 'terminal no monitor')).toBe(H.execTerminalMonitor);
    expect(handlerOf('server.nfserver', 'user-exec', 'service syslog on')).toBe(H.hostServiceSyslog);
    expect(parse(R, 'user-exec', 'terminal monitor', { privilege: 1 }).ok).toBe(false); // privileged EXEC only
    expect(parse(R, 'config', 'logging trap 8').ok).toBe(false);
    expect(parse('pc.nfpc', 'user-exec', 'service syslog on').ok).toBe(false); // not a server
  });

  it('stores levels as keywords and timestamp options in canonical order', () => {
    const r = approvedCtx(R);
    expect(run(r, H.configLoggingBuffered, { size: '8192', level: '4' })).toEqual({});
    expect(run(r, H.configLoggingConsole, { level: 'errors' })).toEqual({});
    expect(run(r, H.configLoggingMonitor, {})).toEqual({});
    expect(run(r, H.configLoggingHost, { address: '10.0.0.10', [LOGGING_HOST_FORM_ARG]: 'host' })).toEqual({});
    expect(run(r, H.configLoggingHost, { address: '10.0.0.11', [LOGGING_HOST_FORM_ARG]: 'alias' })).toEqual({});
    expect(run(r, H.configLoggingTrap, { level: '4' })).toEqual({});
    expect(run(r, H.configLoggingFacility, { facility: 'local5' })).toEqual({});
    expect(run(r, H.configServiceTimestamps, { kind: 'log', [TIMESTAMP_FORM_ARG]: 'datetime', options: 'show-timezone msec' })).toEqual({});
    expect(run(r, H.configServiceTimestamps, { kind: 'debug', [TIMESTAMP_FORM_ARG]: 'uptime' })).toEqual({});
    expect(run(r, H.configServiceTimestamps, { kind: 'log', [TIMESTAMP_FORM_ARG]: 'datetime', options: 'msec msec' })).toEqual({ error: MSG_TIMESTAMP_OPTIONS });
    expect(body(r)).toEqual([
      'service timestamps log datetime msec show-timezone',
      'service timestamps debug uptime',
      'logging buffered 8192 warnings',
      'logging console errors',
      'logging monitor',
      'logging host 10.0.0.10',
      'logging 10.0.0.11',
      'logging trap warnings',
      'logging facility local5',
    ]);
    run(r, H.configLoggingConsole, {}, true); // stored: both forms share the slot
    run(r, H.configLoggingHost, { [LOGGING_HOST_FORM_ARG]: 'host' }, true);
    run(r, H.configLoggingHost, { address: '10.0.0.11', [LOGGING_HOST_FORM_ARG]: 'alias' }, true);
    run(r, H.configServiceTimestamps, { kind: 'debug' }, true);
    for (const id of [H.configLoggingBuffered, H.configLoggingMonitor, H.configLoggingTrap, H.configLoggingFacility]) run(r, id, {}, true);
    expect(body(r)).toEqual(['service timestamps log datetime msec show-timezone', 'no logging console']);
  });

  it('service syslog writes and removes the syslog-server extension line', () => {
    const r = approvedCtx('server.nfserver');
    expect(run(r, H.hostServiceSyslog, { state: 'on' })).toEqual({ output: 'Syslog receiver started.' });
    expect(body(r)).toContain('syslog-server enable');
    expect(run(r, H.hostServiceSyslog, { state: 'off' })).toEqual({ output: 'Syslog receiver stopped.' });
    expect(body(r)).not.toContain('syslog-server enable');
  });

  it('level and option helpers; the grammar shares the logger\'s levels and buffer bounds', () => {
    expect(LOG_LEVEL_NAMES).toBe(LOGGER_LEVEL_NAMES);
    expect([LOG_BUFFER_MIN, LOG_BUFFER_MAX]).toEqual([LOGGING_BUFFER_MIN_BYTES, LOGGING_BUFFER_MAX_BYTES]);
    expect(parse(R, 'config', `logging buffered ${LOGGING_BUFFER_MAX_BYTES + 1}`).ok).toBe(false);
    expect(levelKeyword('0')).toBe('emergencies');
    expect(levelKeyword('debugging')).toBe('debugging');
    expect(levelKeyword('9')).toBeUndefined();
    expect(datetimeOptions('localtime msec')).toEqual(['msec', 'localtime']);
    expect(datetimeOptions('year')).toBeUndefined();
  });
});

describe('cli/log-render (the console path over the logger\'s renderer, D20)', () => {
  const ev = { t: 400 * SEC, severity: 3 as const, facility: 'LINK', message: 'Interface GigabitEthernet0/2 administratively down' };
  const MSEC = { kind: 'datetime' as const, msec: true, localtime: false, showTimezone: false };

  it('stamps with the device clock (datetime), the uptime, or P1\'s prefix without the timestamps line', () => {
    expect(renderLogLine(ev, SYNCED, 0, MSEC)).toBe('Jan  6 08:10:03.123: %LINK-3: Interface GigabitEthernet0/2 administratively down');
    expect(renderLogLine({ ...ev, mnemonic: 'UPDOWN' }, SYNCED, 0, MSEC)).toMatch(/: %LINK-3-UPDOWN: Interface/);
    const unset: DeviceClockView = { ...SYNCED, authoritative: false };
    expect(renderLogLine(ev, unset, 0, { ...MSEC, msec: false })).toMatch(/^\*Jan {2}6 08:10:03: %LINK-3: /);
    expect(renderLogLine(ev, SYNCED, 0, { ...MSEC, localtime: true, showTimezone: true })).toMatch(/^Jan {2}6 09:10:03\.123 CET: /);
    expect(renderLogLine(ev, SYNCED, 3725 * SEC, { kind: 'uptime' })).toMatch(/^01:02:05: /);
    expect(renderLogLine(ev, SYNCED, 26 * 3600 * SEC, { kind: 'uptime' })).toMatch(/^1d02h: /);
    expect(renderLogLine(ev, SYNCED, 0, undefined)).toBe('*00:06:40.000000: %LINK-3: Interface GigabitEthernet0/2 administratively down');
    // the very line the logger buffers
    expect(renderLogLine(ev, SYNCED, 0, MSEC)).toBe(formatLogLine({ at: ev.t, severity: 3, facility: 'LINK', message: ev.message }, SYNCED, MSEC, 0));
    expect(renderDebugLine({ at: 400 * SEC, category: 'ip icmp', message: 'echo reply sent' }, SYNCED, 0, MSEC)).toBe('Jan  6 08:10:03.123: ip icmp: echo reply sent');
  });

  it('reads the timestamp forms and the console and monitor levels from the configuration', () => {
    const ast = createConfigAst();
    expect(storedTimestampFormat(ast.root, 'log')).toBeUndefined();
    expect(consoleLogLevel(ast.root, true)).toBe(7); // P3 default
    expect(consoleLogLevel(ast.root, false)).toBe(-1); // P1/P2: nothing without the line
    ast.set([], ['logging', 'console', 'warnings']);
    expect(consoleLogLevel(ast.root, false)).toBe(4);
    ast.unset([], ['logging', 'console']);
    expect(consoleLogLevel(ast.root, true)).toBe(-1);
    ast.set([], ['service', 'timestamps', 'log', 'datetime', 'msec', 'localtime']);
    ast.set([], ['service', 'timestamps', 'debug', 'uptime']);
    expect(storedTimestampFormat(ast.root, 'log')).toEqual({ kind: 'datetime', msec: true, localtime: true, showTimezone: false });
    expect(storedTimestampFormat(ast.root, 'debug')).toEqual({ kind: 'uptime' });
    // the same answer as the logger's own reader
    expect(storedTimestampFormat(ast.root, 'log')).toEqual(timestampFormatOf(ast.root, 'log'));
    expect(storedTimestampFormat(ast.root, 'debug')).toEqual(timestampFormatOf(ast.root, 'debug'));
    expect(monitorLogLevel(ast.root)).toBe(7);
    ast.set([], ['logging', 'monitor', 'errors']);
    expect(monitorLogLevel(ast.root)).toBe(3);
  });
});

describe('cli.logging: onLogEvent and terminal monitor through the runtime', () => {
  it('prints on P3 consoles by default, on terminal-monitor sessions up to logging monitor, never on others', () => {
    const h = approvedHarness();
    const d = withProfile(h.add('d_1', 'router', 'R1'), 'P3');
    d.clockView = () => SYNCED;
    d.running.set([], ['service', 'timestamps', 'log', 'datetime', 'msec']);
    const con = h.cli.open('d_1', 'console');
    const vty = h.cli.open('d_1', 'vty');
    const quiet = h.cli.open('d_1', 'vty');
    h.cli.exec(vty, 'enable');
    expect(h.cli.exec(vty, 'terminal monitor').output).toBe('Logs now print on this session too.');
    expect(h.cli.session(vty)?.monitor).toBe(true);
    expect(h.cli.session(con)?.monitor).toBeUndefined();
    h.trace.clear();
    h.cli.onLogEvent(logEvent(3, 'UPDOWN'));
    const line = 'Jan  6 08:10:03.123: %LINK-3-UPDOWN: Interface GigabitEthernet0/2 changed state to down';
    expect(h.trace.of('cliOutput')).toEqual([
      { t: 400 * SEC, kind: 'cliOutput', session: con, text: line },
      { t: 400 * SEC, kind: 'cliOutput', session: vty, text: line },
    ]);
    // levels: the console up to errors, the monitor up to critical
    d.running.set([], ['logging', 'console', 'errors']);
    d.running.set([], ['logging', 'monitor', 'critical']);
    h.trace.clear();
    h.cli.onLogEvent(logEvent(3));
    expect(h.trace.of('cliOutput').map((e) => e.session)).toEqual([con]);
    h.cli.exec(vty, 'terminal no monitor');
    expect(h.cli.session(vty)?.monitor).toBeUndefined();
    h.trace.clear();
    h.cli.onLogEvent(logEvent(2));
    expect(h.trace.of('cliOutput').map((e) => e.session)).toEqual([con]);
    expect(h.trace.of('cliOutput').some((e) => e.session === quiet)).toBe(false);
  });

  it('prints nothing in a P2 world until logging console is typed', () => {
    const h = approvedHarness();
    const d = h.add('d_1', 'router', 'R1'); // the fake's profile is P2's
    const con = h.cli.open('d_1', 'console');
    h.trace.clear();
    h.cli.onLogEvent(logEvent(3));
    expect(h.trace.of('cliOutput')).toEqual([]);
    d.running.set([], ['logging', 'console']);
    h.cli.onLogEvent(logEvent(3));
    expect(h.trace.of('cliOutput')).toEqual([
      { t: 400 * SEC, kind: 'cliOutput', session: con, text: '*00:06:40.000000: %LINK-3: Interface GigabitEthernet0/2 changed state to down' },
    ]);
  });

  it('stamps debug lines by service timestamps debug, and keeps P1\'s line without it', () => {
    const h = approvedHarness();
    const d = h.add('d_1', 'router', 'R1');
    d.clockView = () => SYNCED;
    const con = h.cli.open('d_1', 'console');
    h.cli.exec(con, 'enable');
    h.cli.exec(con, 'debug ip icmp');
    const dbg = { at: 400 * SEC, device: 'd_1', process: 'icmpv4', category: 'ip icmp', message: 'echo reply sent' } as const;
    h.trace.clear();
    h.cli.onDebugEvent(dbg);
    expect(h.trace.of('cliOutput').map((e) => e.text)).toEqual(['*00:06:40.000000: ip icmp: echo reply sent']);
    d.running.set([], ['service', 'timestamps', 'debug', 'datetime', 'msec']);
    d.running.set([], ['service', 'timestamps', 'log', 'uptime']); // the log form does not stamp debug lines
    h.trace.clear();
    h.cli.onDebugEvent(dbg);
    expect(h.trace.of('cliOutput').map((e) => e.text)).toEqual(['Jan  6 08:10:03.123: ip icmp: echo reply sent']);
  });
});
