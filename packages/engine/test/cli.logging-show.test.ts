/**
 * cli.logging-show — [S24]/[S25] `show logging` (the settings, the [S25] syslog sender, the counters and the buffer, read
 * from the logger StateView, `LoggerStateView` of ruling R25) and `clear logging` (the `ext.logging.clear` request), and
 * the `syslog` debug category (ARCHITECTURE-P3 §3.7 steps 7-8, §5.8, D20; §7 W3 cli, approved items) — against a fake
 * logger StateView.
 */
import { describe, expect, it } from 'vitest';
import type { LoggerStateView } from '../src/contracts/process.js';
import { LOGGING_DEBUG_CATEGORIES, LOGGING_GRAMMAR, LOGGING_HANDLERS as L } from '../src/cli/grammar/logging.js';
import { facilityText, levelText, LOGGING_CLEAR_REQUEST, MSG_NO_LOGGER } from '../src/cli/handlers/logging.js';
import { approvedCtx, handlerOf, modelWith, parse, runOn, showCtx, showLines } from './cli.p3-approved.fixture.js';
import { SEC } from '../src/contracts/time.js';
import { createLogger } from '../src/protocols/logger.js';
import { commandCtxFor } from './cli.p05.fixture.js';
import { createStagedSimulation } from './staged.world.js';

const R = 'router.nf2911';

/** §3.7 steps 7-8 at R1: `service timestamps log datetime msec`, `logging host 10.0.0.10`, `logging trap warnings`. */
const VIEW: LoggerStateView = {
  buffered: { enabled: true, level: 7, sizeBytes: 4096, usedBytes: 170 },
  console: { enabled: true, level: 7 },
  monitor: { enabled: false, level: 7 },
  timestamps: { log: 'datetime msec', debug: null },
  counts: { seen: 3, buffered: 2, filtered: 1, overflowed: 0 },
  entries: [
    { seq: 1, at: 0, severity: 3, facility: 'LINK', mnemonic: 'UPDOWN', message: 'Interface GigabitEthernet0/2, changed state to down', text: 'Jan  6 08:10:03.123: %LINK-3-UPDOWN: Interface GigabitEthernet0/2, changed state to down' },
    { seq: 2, at: 0, severity: 5, facility: 'LINEPROTO', mnemonic: 'UPDOWN', message: 'Line protocol on Interface GigabitEthernet0/2, changed state to down', text: 'Jan  6 08:10:03.124: %LINEPROTO-5-UPDOWN: Line protocol on Interface GigabitEthernet0/2, changed state to down' },
  ],
  syslog: { trap: 4, facility: 23, hosts: [{ address: '10.0.0.10', sent: 1 }], sent: 1 },
};

describe('cli.logging-show grammar', () => {
  it('parses show logging at user and privileged exec, clear logging at privileged exec only', () => {
    expect(handlerOf(R, 'user-exec', 'show logging')).toBe(L.showLogging);
    expect(handlerOf('switch.nfc2960', 'priv-exec', 'show logging')).toBe(L.showLogging);
    expect(handlerOf(R, 'priv-exec', 'clear logging')).toBe(L.execClearLogging);
    expect(parse(R, 'user-exec', 'clear logging').ok).toBe(false);
    expect(parse('pc.nfpc', 'user-exec', 'show logging').ok).toBe(false);
  });

  it('registers syslog for the syslog server (servers): offered on no device, their host shell has no debug', () => {
    expect(LOGGING_DEBUG_CATEGORIES.map((d) => [d.category, d.requiresAny])).toEqual([['syslog', ['server']]]);
    expect(LOGGING_GRAMMAR.find((s) => s.path.join(' ') === 'debug syslog')?.fixedArgs).toEqual({ category: 'syslog' });
    expect(parse(R, 'priv-exec', 'debug syslog').ok).toBe(false);
    expect(parse('server.nfserver', 'user-exec', 'debug syslog').ok).toBe(false);
  });
});

describe('show logging', () => {
  it('prints the outputs and their levels, the syslog hosts, the timestamps, the counters, then the buffer oldest first', () => {
    const ctx = showCtx(approvedCtx(R, { mode: 'priv-exec' }), { states: { logger: VIEW as unknown as Record<string, unknown> } });
    expect(showLines(ctx, L.showLogging)).toEqual([
      'Buffer logging: on, level debugging (7), 4096 bytes (170 used)',
      'Console logging: on, level debugging (7)',
      'Monitor logging: off',
      'Syslog logging: level warnings (4), facility local7, 1 message sent',
      '  Host 10.0.0.10: 1 message sent',
      'Timestamps: log datetime msec, debug not set',
      'Messages: 3 logged, 2 buffered, 1 not buffered (level or buffer off), 0 pushed out of a full buffer',
      '',
      'Log buffer (2 lines, oldest first):',
      'Jan  6 08:10:03.123: %LINK-3-UPDOWN: Interface GigabitEthernet0/2, changed state to down',
      'Jan  6 08:10:03.124: %LINEPROTO-5-UPDOWN: Line protocol on Interface GigabitEthernet0/2, changed state to down',
    ]);
  });

  it('a buffer switched off, no syslog host and an empty buffer', () => {
    const off: LoggerStateView = {
      ...VIEW,
      buffered: { enabled: false, level: 7, sizeBytes: 4096, usedBytes: 0 },
      console: { enabled: false, level: 7 },
      monitor: { enabled: true, level: 5 },
      timestamps: { log: null, debug: 'uptime' },
      entries: [],
      syslog: undefined,
    } as LoggerStateView;
    const ctx = showCtx(approvedCtx(R, { mode: 'priv-exec' }), { states: { logger: off as unknown as Record<string, unknown> } });
    expect(showLines(ctx, L.showLogging)).toEqual([
      'Buffer logging: off',
      'Console logging: off',
      'Monitor logging: on, level notifications (5)',
      'Syslog logging: off (no logging host)',
      'Timestamps: log not set, debug uptime',
      'Messages: 3 logged, 2 buffered, 1 not buffered (level or buffer off), 0 pushed out of a full buffer',
      '',
      'Log buffer: empty',
    ]);
  });

  it('refuses on a device that runs no logger', () => {
    expect(runOn(showCtx(approvedCtx(R, { mode: 'priv-exec' })), L.showLogging)).toEqual({ error: MSG_NO_LOGGER });
  });

  it('names levels and facilities', () => {
    expect([0, 3, 6, 7].map(levelText)).toEqual(['emergencies (0)', 'errors (3)', 'informational (6)', 'debugging (7)']);
    expect([16, 23, 3].map(facilityText)).toEqual(['local0', 'local7', '3']);
  });
});

describe('clear logging', () => {
  it('asks the logger to empty its buffer through the extension slot', () => {
    const rec = commandCtxFor(modelWith(R, 'logger'), { mode: 'priv-exec' });
    expect(runOn(rec.ctx, L.execClearLogging)).toEqual({});
    expect(rec.requests).toEqual([{ to: 'logger', req: { kind: LOGGING_CLEAR_REQUEST, session: 's_1' } }]);
    expect(LOGGING_CLEAR_REQUEST).toBe('ext.logging.clear');
  });

  it('refuses where no logger runs (every model before the W4 flip)', () => {
    const rec = approvedCtx(R, { mode: 'priv-exec' });
    expect(runOn(rec.ctx, L.execClearLogging)).toEqual({ error: MSG_NO_LOGGER });
    expect(rec.requests).toEqual([]);
  });
});

describe('on a real P3 world (the W2 logger)', () => {
  it('show logging reads the logger: the boot log and the link logs, as the logger rendered them', () => {
    const sim = createStagedSimulation({ seed: 7, stage: 'P3', factories: { logger: createLogger } });
    sim.addDevice({ id: 'r1', type: R, name: 'R1', startupConfig: 'hostname R1\n!\nend\n' });
    sim.runFor(60 * SEC);
    const s = sim.cli.open('r1', 'console');
    sim.cli.exec(s, 'enable');
    const out = sim.cli.exec(s, 'show logging').output.split('\n');
    expect(out[0]).toMatch(/^Buffer logging: on, level debugging \(7\), 4096 bytes \(\d+ used\)$/);
    expect(out.slice(1, 5)).toEqual([
      'Console logging: on, level debugging (7)',
      'Monitor logging: on, level debugging (7)',
      'Syslog logging: off (no logging host)',
      'Timestamps: log not set, debug not set',
    ]);
    expect(out.some((l) => /%SYS-5-BOOTED: /.test(l))).toBe(true);
    // the request reaches the logger (which empties its buffer once it handles `ext.logging.clear`)
    expect(sim.cli.exec(s, 'clear logging').output).toBe('');
  });
});
