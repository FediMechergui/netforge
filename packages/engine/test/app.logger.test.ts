/**
 * app.logger — [S24] local logging (ARCHITECTURE-P3 D20, §2.5 `log.record`, §3.7 step 7, §4.6 item 4, §5.7; §7 W2
 * svc), on `staged.world` at stage P3 with the logger (and ntp, for `clock set`) factories, fed by the W1 `emitLog`
 * seam. The configuration is stored through `startupConfig` or `DeviceRuntime.applyConfigLine` (rule 13).
 *
 *  • without a `service timestamps log` line the stamp is P1's debug prefix `*hh:mm:ss.uuuuuu` of SimTime, byte for
 *    byte what the CLI prints on a debug line at the same instant;
 *  • `datetime msec` stamps the device clock: `*` while unset, `Jan  6 08:10:03.123` once set (the §3.7 line);
 *    `localtime`, `show-timezone` and `uptime`;
 *  • `%FAC-SEV-MNEMONIC: text` and `%FAC-SEV: text`;
 *  • the buffered level and size (bytes, oldest first out); buffering writes no trace.
 */
import { describe, expect, it } from 'vitest';
import { formatClock, type DeviceClockView } from '../src/contracts/clock.js';
import type { ConfigNode } from '../src/contracts/config.js';
import type { DeviceId } from '../src/contracts/ids.js';
import type { Simulation } from '../src/contracts/simulation.js';
import { formatSimTime, MS, SEC, type SimTime } from '../src/contracts/time.js';
import type { TraceEvent } from '../src/contracts/trace.js';
import {
  createLogger,
  formatUptime,
  loggerLevelOf,
  loggingConfigOf,
  formatLogMessage,
  formatDebugLine,
  formatLogLine,
  formatLogTimestamp,
  type LoggerStateView,
} from '../src/protocols/logger.js';
import { createNtp } from '../src/protocols/ntp.js';
import { createStagedSimulation } from './staged.world.js';

function startup(sections: readonly (readonly string[])[]): string {
  const out: string[] = [];
  for (const s of sections) out.push(...s, '!');
  out.push('end', '');
  return out.join('\n');
}

/**
 * The two [S24] visible P3 defaults removed, as a learner removes them: ARCHITECTURE-P3 §9.2 W4 (the catalog flip) —
 * since the flip a P3 world replays `service timestamps debug|log datetime msec` (profileConfig.P3, D2), so the router
 * stores their negations first and the cases below keep exercising the renderer without a timestamps line (or with only
 * the line a case adds), as they did on the pre-flip staged catalog.
 */
const WITHOUT_P3_TIMESTAMPS: readonly string[] = ['no service timestamps debug datetime msec', 'no service timestamps log datetime msec'];

/**
 * R1 (NF-2911) with Gi0/0 and Gi0/1 up (Gi0/1 cabled to PC1), without the two P3 timestamps lines, plus `lines`;
 * booted (45 s) and settled at 100 s.
 */
function router(seed: number, lines: readonly string[] = []): Simulation {
  const sim = createStagedSimulation({ seed, stage: 'P3', factories: { logger: createLogger, ntp: createNtp } });
  sim.addDevice({
    id: 'r1', type: 'router.nf2911', name: 'R1',
    startupConfig: startup([
      ['hostname R1'],
      ['interface GigabitEthernet0/0', ' ip address 10.0.0.1 255.255.255.0', ' no shutdown'],
      ['interface GigabitEthernet0/1', ' ip address 10.0.1.1 255.255.255.0', ' no shutdown'],
      ...WITHOUT_P3_TIMESTAMPS.map((l) => [l]),
      ...lines.map((l) => [l]),
    ]),
  });
  sim.addDevice({ id: 'pc1', type: 'pc.nfpc', name: 'PC1', startupConfig: startup([['hostname PC1'], ['interface GigabitEthernet0', ' ip address 10.0.1.10 255.255.255.0']]) });
  sim.addLink({ a: { device: 'r1', port: 'GigabitEthernet0/1' }, b: { device: 'pc1', port: 'GigabitEthernet0' } });
  sim.runUntil(100 * SEC);
  return sim;
}

function setLine(sim: Simulation, text: string, negate = false, context: string[][] = []): void {
  const d = sim.device('r1')!;
  d.applyActions('sim', [], sim.now);
  expect(d.applyConfigLine(context, text.split(' '), negate)).toEqual({ ok: true });
}

/** `shutdown` on `port` now: the runtime's admin-state log (severity 3, LINK, P1 wording) goes through emitLog. */
function shut(sim: Simulation, port: string): void {
  setLine(sim, 'shutdown', false, [['interface', port]]);
}

const view = (sim: Simulation, dev: DeviceId = 'r1'): LoggerStateView => sim.device(dev)!.processes.get('logger')!.stateSnapshot().state as unknown as LoggerStateView;
const texts = (sim: Simulation): string[] => view(sim).entries.map((e) => e.text);
/** The newest buffered LINK line (P3 worlds also log the [S25] configuration changes around it). */
const lastLink = (sim: Simulation): string | undefined => texts(sim).filter((t) => t.includes(': %LINK-')).at(-1);
const pad = (n: number, w: number): string => String(n).padStart(w, '0');

const UTC_VIEW = (unixMs: number, authoritative = true): DeviceClockView => ({ source: authoritative ? 'user' : 'unset', authoritative, unixMs, subMsNs: 0, tz: { name: 'UTC', offsetMin: 0 } });

describe('app.logger: the renderer (pure)', () => {
  it('without a timestamps line: P1 debug prefix of SimTime; message shapes with and without a mnemonic', () => {
    const at = 3 * 3600 * SEC + 25 * 60 * SEC + 7 * SEC + 123_456_789;
    const clock = UTC_VIEW(1_736_151_003_123);
    expect(formatLogTimestamp(at, clock, undefined)).toBe('*03:25:07.123456');
    expect(formatLogTimestamp(at, clock, undefined)).toBe(`*${formatSimTime(at)}`);
    expect(formatLogLine({ at, severity: 3, facility: 'LINK', message: 'x down', mnemonic: 'UPDOWN' }, clock, undefined)).toBe('*03:25:07.123456: %LINK-3-UPDOWN: x down');
    expect(formatLogMessage(5, 'SYS', 'restarted')).toBe('%SYS-5: restarted');
    expect(formatDebugLine({ at, category: 'ip routing', message: 'm' }, clock, undefined)).toBe(`*${formatSimTime(at)}: ip routing: m`);
  });

  it('datetime forms over the device clock (UTC unless localtime; zone with show-timezone; * while unset); uptime', () => {
    const set = UTC_VIEW(1_736_151_003_123); // Mon 2025-01-06 08:10:03.123 UTC
    const cet: DeviceClockView = { ...set, tz: { name: 'CET', offsetMin: 60 } };
    expect(formatLogTimestamp(0, set, { kind: 'datetime', msec: true, localtime: false, showTimezone: false })).toBe('Jan  6 08:10:03.123');
    expect(formatLogTimestamp(0, set, { kind: 'datetime', msec: false, localtime: false, showTimezone: false })).toBe('Jan  6 08:10:03');
    expect(formatLogTimestamp(0, cet, { kind: 'datetime', msec: true, localtime: true, showTimezone: true })).toBe('Jan  6 09:10:03.123 CET');
    expect(formatLogTimestamp(0, cet, { kind: 'datetime', msec: true, localtime: false, showTimezone: true })).toBe('Jan  6 08:10:03.123 UTC');
    expect(formatLogTimestamp(0, UTC_VIEW(1_577_836_812_500, false), { kind: 'datetime', msec: true, localtime: false, showTimezone: false })).toBe('*Jan  1 00:00:12.500');
    expect(formatLogTimestamp(0, set, { kind: 'uptime' }, 55 * SEC + 250 * MS)).toBe('00:00:55');
    expect([formatUptime(0), formatUptime(25 * 3600 * SEC), formatUptime(9 * 24 * 3600 * SEC)]).toEqual(['00:00:00', '1d01h', '1w2d']);
    expect(formatClock(set, 'show-clock')).toBe('08:10:03.123 UTC Mon Jan 6 2025');
    expect(formatClock(UTC_VIEW(1_577_836_812_500, false), 'show-clock')).toBe('*00:00:12.500 UTC Wed Jan 1 2020');
  });

  it('reads the logging lines and the two timestamps lines (identity 3, they coexist)', () => {
    const root = (lines: readonly (readonly string[])[]): ConfigNode => ({ key: '', args: [], children: lines.map(([key, ...args]) => ({ key: key!, args, children: [] })) });
    const c = loggingConfigOf(
      root([
        ['service', 'timestamps', 'log', 'datetime', 'msec', 'localtime'],
        ['service', 'timestamps', 'debug', 'uptime'],
        ['logging', 'buffered', '8192', 'warnings'],
        ['logging', 'console', '3'],
        ['no', 'logging', 'monitor'],
      ]),
    );
    expect(c).toEqual({
      buffered: { enabled: true, level: 4, sizeBytes: 8192 },
      console: { enabled: true, level: 3 },
      monitor: { enabled: false, level: 7 },
      log: { kind: 'datetime', msec: true, localtime: true, showTimezone: false },
      debug: { kind: 'uptime' },
    });
    expect(loggingConfigOf(root([['no', 'logging', 'buffered']])).buffered.enabled).toBe(false);
    expect(loggingConfigOf(root([['logging', 'buffered', '6']])).buffered).toEqual({ enabled: true, level: 6, sizeBytes: 4096 });
    expect(loggingConfigOf(root([])).buffered).toEqual({ enabled: true, level: 7, sizeBytes: 4096 });
    expect([loggerLevelOf('debugging'), loggerLevelOf('0'), loggerLevelOf('8'), loggerLevelOf('loud')]).toEqual([7, 0, undefined, undefined]);
  });
});

describe('app.logger: the buffer on a real device (W1 emitLog)', () => {
  it("without the timestamps line: P1's debug prefix, byte for byte what the console prints on a debug line at that instant", () => {
    const sim = router(1);
    const session = sim.cli.open('r1', 'console');
    sim.cli.exec(session, 'enable');
    sim.cli.exec(session, 'debug all');
    const cursor = sim.trace(0).next;
    sim.runUntil(100 * SEC + 250 * MS + 7);
    const t = sim.now;
    shut(sim, 'GigabitEthernet0/1');
    const line = lastLink(sim);
    expect(line).toBe(`*${formatSimTime(t)}: %LINK-3: Interface GigabitEthernet0/1 administratively down`);
    // every debug line the console printed meanwhile is the renderer's line without a timestamps form, byte for byte
    sim.runFor(1 * SEC);
    const evs = sim.trace(cursor).events;
    const debugs = evs.filter((e): e is Extract<TraceEvent, { kind: 'debug' }> => e.kind === 'debug' && e.event.device === 'r1');
    // §9.2 W3 item 30i: since the W3 [S25] log branch a P3 console also prints the shut's log lines with the same
    // prefix; `printed` keeps the debug lines (a log line's message starts with `%`), and the log lines are pinned below
    const stamped = evs.filter((e): e is Extract<TraceEvent, { kind: 'cliOutput' }> => e.kind === 'cliOutput' && /^\*\d{2}:\d{2}:\d{2}\.\d{6}: /.test(e.text));
    const printed = stamped.filter((e) => !/^\*\d{2}:\d{2}:\d{2}\.\d{6}: %/.test(e.text));
    const logged = stamped.filter((e) => /^\*\d{2}:\d{2}:\d{2}\.\d{6}: %/.test(e.text)).map((p) => p.text.replace(/\r?\n$/, ''));
    expect(logged).toEqual([
      `*${formatSimTime(t)}: %LINK-3: Interface GigabitEthernet0/1 administratively down`,
      `*${formatSimTime(t)}: %LINEPROTO-5-UPDOWN: Interface GigabitEthernet0/1: line protocol is down`,
      `*${formatSimTime(t)}: %SYS-5-CONFIGURED: Configuration changed from the console.`,
    ]);
    expect(debugs.length).toBeGreaterThan(0);
    expect(printed.length).toBe(debugs.length);
    expect(printed.map((p) => p.text.replace(/\r?\n$/, ''))).toEqual(debugs.map((d) => formatDebugLine(d.event, sim.device('r1')!.clockView(d.t), undefined)));
    expect(printed.some((p) => p.t === t && p.text.startsWith(`*${formatSimTime(t)}: `))).toBe(true);
  });

  it('`service timestamps log datetime msec`: the unset clock with `*`, then the §3.7 line once the clock is set', () => {
    const sim = router(2, ['service timestamps log datetime msec']);
    const r1 = sim.device('r1')!;
    sim.runUntil(100 * SEC + 250 * MS);
    shut(sim, 'GigabitEthernet0/1');
    const up = sim.now - r1.bootedAt!;
    const s = Math.floor(up / SEC);
    expect(lastLink(sim)).toBe(
      `*Jan  1 00:${pad(Math.floor(s / 60), 2)}:${pad(s % 60, 2)}.${pad(Math.floor((up % SEC) / MS), 3)}: %LINK-3: Interface GigabitEthernet0/1 administratively down`,
    );
    // clock set (through ntp) to 08:10:03.123 UTC on Mon 2025-01-06, then a log in the same instant
    r1.applyActions('sim', [{ type: 'request', to: 'ntp', req: { kind: 'ntp.clockSet', unixMs: 1_736_151_003_123 } }], sim.now);
    shut(sim, 'GigabitEthernet0/0');
    expect(lastLink(sim)).toBe('Jan  6 08:10:03.123: %LINK-3: Interface GigabitEthernet0/0 administratively down');
    // localtime + show-timezone with a zone, then uptime
    setLine(sim, 'clock timezone CET 1');
    setLine(sim, 'service timestamps log datetime msec localtime show-timezone');
    setLine(sim, 'shutdown', true, [['interface', 'GigabitEthernet0/0']]);
    expect(lastLink(sim)).toBe('Jan  6 09:10:03.123 CET: %LINK-3: Interface GigabitEthernet0/0 administratively enabled');
    setLine(sim, 'service timestamps log uptime');
    shut(sim, 'GigabitEthernet0/0');
    expect(lastLink(sim)).toBe(`${formatUptime(sim.now - r1.bootedAt!)}: %LINK-3: Interface GigabitEthernet0/0 administratively down`);
    expect(view(sim).timestamps).toEqual({ log: 'uptime', debug: null });
  });

  it('mnemonics, levels and the byte-bounded buffer; buffering writes no trace', () => {
    const sim = router(3, ['logging buffered 4096 warnings']);
    const r1 = sim.device('r1')!;
    const cursor = sim.trace(0).next;
    const before = view(sim);
    const t: SimTime = sim.now;
    r1.emitLog(3, 'LINK', 'Interface GigabitEthernet0/2 changed state to down', t, 'UPDOWN');
    r1.emitLog(5, 'LINEPROTO', 'Line protocol on Interface GigabitEthernet0/2 changed state to down', t, 'UPDOWN');
    r1.applyActions('ipv4', [{ type: 'log', severity: 4, facility: 'IP', message: 'a warning' }], t);
    expect(view(sim).entries.slice(before.entries.length).map((e) => [e.severity, e.facility, e.mnemonic ?? null, e.text])).toEqual([
      [3, 'LINK', 'UPDOWN', `*${formatSimTime(t)}: %LINK-3-UPDOWN: Interface GigabitEthernet0/2 changed state to down`],
      [4, 'IP', null, `*${formatSimTime(t)}: %IP-4: a warning`],
    ]);
    const c0 = before.counts;
    expect(view(sim).counts).toEqual({ seen: c0.seen + 3, buffered: c0.buffered + 2, filtered: c0.filtered + 1, overflowed: c0.overflowed });
    // the only trace of all this is the three log events: the logger itself emits nothing
    expect(sim.trace(cursor).events.map((e) => e.kind)).toEqual(['log', 'log', 'log']);
    // fill past 4096 bytes: the oldest lines go first and the used bytes stay within the size
    for (let i = 0; i < 100; i++) r1.emitLog(3, 'TEST', `line ${pad(i, 3)} ${'x'.repeat(40)}`, t);
    const v = view(sim);
    expect(v.buffered.usedBytes).toBeLessThanOrEqual(4096);
    expect(v.buffered.usedBytes).toBe(v.entries.reduce((n, e) => n + e.text.length + 1, 0));
    expect(v.entries.at(-1)!.message).toMatch(/^line 099 /);
    expect(v.counts.overflowed).toBe(v.counts.buffered - v.entries.length);
    expect(v.counts.overflowed).toBeGreaterThan(0);
    // `logging buffered informational` lets severity 6 in; a smaller buffer is trimmed at once
    setLine(sim, 'logging buffered informational');
    r1.applyActions('ipv4', [{ type: 'log', severity: 6, facility: 'IP', message: 'informational line' }], sim.now);
    expect(view(sim).entries.at(-1)!.message).toBe('informational line');
    expect(view(sim).buffered).toMatchObject({ enabled: true, level: 6, sizeBytes: 4096 });
  });

  it('a model without the logger factory gets nothing (silence), and the logger never answers a packet', () => {
    // ARCHITECTURE-P3 §9.2 W4 (the catalog flip registered the logger, so the overlay now removes it: staged.world's
    // documented way to model a daemon without a factory)
    const sim = createStagedSimulation({ seed: 4, stage: 'P3', factories: { logger: undefined } });
    sim.addDevice({ id: 'r1', type: 'router.nf2911', name: 'R1', startupConfig: startup([['hostname R1']]) });
    sim.runUntil(60 * SEC);
    expect(sim.device('r1')!.processes.has('logger')).toBe(false);
  });
});
