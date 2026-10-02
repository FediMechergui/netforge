/**
 * cli/grammar/time.ts and cli/handlers/time.ts (ARCHITECTURE-P3 §5.5, §5.8, D19; §7 W2 cli part 1): `clock timezone`,
 * `ntp server [prefer] [source]` (one slot per server), `ntp master [<stratum>]`, `ntp source`, `clock set` (not stored:
 * `ntp.clockSet {unixMs, session}` with the typed local time converted to UTC; both day/month orders; refusals),
 * `show clock [detail]` (the contract's `formatClock` show-clock style, `*` when not authoritative), the servers'
 * `service ntp on|off`, the integer calendar helpers, and `show clock` on a real P3-stage router.
 */
import { describe, expect, it } from 'vitest';
import type { CommandHandler, CommandOutcome } from '../src/contracts/cli.js';
import { NF_CLOCK_UNSET_UNIX_MS, NF_WORLD_EPOCH_UNIX_MS, type DeviceClockView } from '../src/contracts/clock.js';
import { SEC } from '../src/contracts/time.js';
import { GRAMMAR, HANDLERS } from '../src/cli/grammar/index.js';
import { HANDLER_REGISTRY } from '../src/cli/handlers/index.js';
import {
  civilFromDays,
  clockSetInstant,
  clockSourceText,
  daysFromCivil,
  MSG_CLOCK_DAY,
  MSG_CLOCK_TIME,
  renderShowClock,
} from '../src/cli/handlers/time.js';
import { matchCommand } from '../src/cli/parser.js';
import { catalogModel, commandCtxFor, matchContextFor, type CommandCtxOptions, type RecordingCtx } from './cli.p05.fixture.js';
import { createStagedSimulation } from './staged.world.js';

const ROUTER = catalogModel('router.nf2911');
const SWITCH = catalogModel('switch.nfc2960');
const SERVER = catalogModel('server.nfserver');
const PC = catalogModel('pc.nfpc');
const DAY_MS = 86_400_000;

function run(rec: RecordingCtx, id: string, args: Record<string, string> = {}, negate = false): CommandOutcome {
  const h: CommandHandler | undefined = HANDLER_REGISTRY[id];
  if (h === undefined) throw new Error(`no handler ${id}`);
  return h(rec.ctx, args, negate);
}

const ok = (ctx: ReturnType<typeof matchContextFor>, line: string) => matchCommand(GRAMMAR, ctx, line);

function typed(rec: RecordingCtx, mode: Parameters<typeof matchContextFor>[1], line: string): CommandOutcome {
  const m = ok(matchContextFor(rec.ctx.model, mode), line);
  if (!m.ok) throw new Error(`${line}: ${m.error.message}`);
  return run(rec, m.spec.handler, { ...m.args }, m.negated);
}

/** A command context whose clock reads `view`. */
function withClock(view: DeviceClockView, opts: CommandCtxOptions = {}): RecordingCtx {
  const r = commandCtxFor(ROUTER, { mode: 'priv-exec', ...opts });
  (r.ctx as { clock: () => DeviceClockView }).clock = () => view;
  return r;
}

const UTC = { name: 'UTC', offsetMin: 0 };

describe('parsing and scope', () => {
  it('parses every §5.5 time line on routers and switches', () => {
    for (const [model, src, srcId] of [[ROUTER, 'g0/0', 'GigabitEthernet0/0'], [SWITCH, 'vlan 1', 'Vlan1']] as const) {
      const cfg = matchContextFor(model, 'config');
      expect(ok(cfg, 'clock timezone CET 1')).toMatchObject({ ok: true, spec: { handler: HANDLERS.configClockTimezone }, args: { zone: 'CET', hours: '1' } });
      expect(ok(cfg, 'clock timezone NST -3 30')).toMatchObject({ ok: true, args: { hours: '-3', minutes: '30' } });
      expect(ok(cfg, 'clock timezone X 24').ok).toBe(false);
      expect(ok(cfg, 'ntp server 10.0.0.10')).toMatchObject({ ok: true, spec: { handler: HANDLERS.configNtpServer }, args: { server: '10.0.0.10' } });
      expect(ok(cfg, 'ntp server time.lab.nf prefer')).toMatchObject({ ok: true, args: { server: 'time.lab.nf', prefer: 'prefer' } });
      expect(ok(cfg, `ntp server 10.0.0.10 source ${src}`)).toMatchObject({ ok: true, args: { iface: srcId } });
      expect(ok(cfg, 'ntp master')).toMatchObject({ ok: true, spec: { handler: HANDLERS.configNtpMaster } });
      expect(ok(cfg, 'ntp master 3')).toMatchObject({ ok: true, args: { stratum: '3' } });
      expect(ok(cfg, 'ntp master 16').ok).toBe(false);
      expect(ok(cfg, `ntp source ${src}`)).toMatchObject({ ok: true, spec: { handler: HANDLERS.configNtpSource }, args: { iface: srcId } });
      const exec = matchContextFor(model, 'priv-exec');
      expect(ok(exec, 'clock set 10:30:00 6 January 2025')).toMatchObject({ ok: true, spec: { handler: HANDLERS.execClockSet }, args: { time: '10:30:00', day: '6', month: 'January', year: '2025' } });
      expect(ok(exec, 'clock set 10:30:00 jan 6 2025')).toMatchObject({ ok: true, args: { month: 'January', day: '6' } });
      expect(ok(exec, 'clock set 10:30 6 January 2025').ok).toBe(false);
      expect(ok(exec, 'show clock')).toMatchObject({ ok: true, spec: { handler: HANDLERS.showClock } });
      expect(ok(exec, 'show clock detail')).toMatchObject({ ok: true, args: { detail: 'detail' } });
    }
    // clock set is privileged; show clock is not
    expect(ok(matchContextFor(ROUTER, 'user-exec'), 'show clock').ok).toBe(true);
    expect(ok(matchContextFor(ROUTER, 'user-exec'), 'clock set 10:30:00 6 January 2025').ok).toBe(false);
    // the servers' host shell
    expect(ok(matchContextFor(SERVER, 'user-exec'), 'service ntp on')).toMatchObject({ ok: true, spec: { handler: HANDLERS.hostServiceNtp }, args: { state: 'on' } });
    expect(ok(matchContextFor(PC, 'user-exec'), 'service ntp on').ok).toBe(false);
  });
});

describe('configuration lines', () => {
  it('store the time zone, one line per server, the master stratum and the source', () => {
    const r = commandCtxFor(ROUTER, { mode: 'config' });
    for (const l of [
      'clock timezone CET 1',
      'ntp server 10.0.0.10',
      'ntp server 10.0.0.11 prefer',
      'ntp server 10.0.0.10 prefer source g0/0',
      'ntp master',
      'ntp source g0/1',
    ]) expect(typed(r, 'config', l), l).toEqual({});
    const text = r.running.render();
    expect(text).toContain('clock timezone CET 1\n');
    expect(text).toContain('ntp server 10.0.0.10 prefer source GigabitEthernet0/0\n');
    expect(text).toContain('ntp server 10.0.0.11 prefer\n');
    expect(text).not.toContain('ntp server 10.0.0.10\n');
    expect(text).toContain('ntp master\n');
    expect(text).toContain('ntp source GigabitEthernet0/1\n');
    typed(r, 'config', 'ntp master 3');
    expect(r.running.render()).toContain('ntp master 3\n');
    typed(r, 'config', 'clock timezone NST -3 30');
    expect(r.running.render()).toContain('clock timezone NST -3 30\n');
    for (const l of ['no clock timezone', 'no ntp server 10.0.0.10', 'no ntp master', 'no ntp source']) expect(typed(r, 'config', l), l).toEqual({});
    const after = r.running.render();
    expect(after).not.toMatch(/clock timezone|ntp master|ntp source|10\.0\.0\.10/);
    expect(after).toContain('ntp server 10.0.0.11 prefer\n');
  });

  it('service ntp on|off on a server writes ntp master 1 or removes it', () => {
    const r = commandCtxFor(SERVER, { mode: 'user-exec' });
    expect(run(r, HANDLERS.hostServiceNtp, { state: 'on' })).toEqual({ output: 'Time service started (stratum 1).' });
    expect(r.running.render()).toContain('ntp master 1\n');
    expect(run(r, HANDLERS.hostServiceNtp, { state: 'off' })).toEqual({ output: 'Time service stopped.' });
    expect(r.running.render()).not.toContain('ntp master');
  });
});

describe('clock set', () => {
  it('sends ntp.clockSet with the UTC instant of the typed local time; nothing is stored', () => {
    const r = withClock({ source: 'unset', authoritative: false, unixMs: NF_CLOCK_UNSET_UNIX_MS, subMsNs: 0, tz: UTC });
    expect(typed(r, 'priv-exec', 'clock set 08:00:00 6 January 2025')).toEqual({});
    expect(r.requests).toEqual([{ to: 'ntp', req: { kind: 'ntp.clockSet', unixMs: NF_WORLD_EPOCH_UNIX_MS, session: 's_1' } }]);
    expect(r.configCalls).toEqual([]);
    // with a time zone, the typed time is local
    const cet = withClock({ source: 'unset', authoritative: false, unixMs: NF_CLOCK_UNSET_UNIX_MS, subMsNs: 0, tz: { name: 'CET', offsetMin: 60 } });
    expect(typed(cet, 'priv-exec', 'clock set 09:00:00 January 6 2025')).toEqual({});
    expect(cet.requests[0]?.req).toEqual({ kind: 'ntp.clockSet', unixMs: NF_WORLD_EPOCH_UNIX_MS, session: 's_1' });
  });

  it('refuses a time or a day that does not exist', () => {
    const r = withClock({ source: 'unset', authoritative: false, unixMs: NF_CLOCK_UNSET_UNIX_MS, subMsNs: 0, tz: UTC });
    expect(typed(r, 'priv-exec', 'clock set 24:00:00 6 January 2025')).toEqual({ error: MSG_CLOCK_TIME });
    expect(typed(r, 'priv-exec', 'clock set 10:61:00 6 January 2025')).toEqual({ error: MSG_CLOCK_TIME });
    expect(typed(r, 'priv-exec', 'clock set 10:00:00 30 February 2024')).toEqual({ error: MSG_CLOCK_DAY(30, 'February') });
    expect(typed(r, 'priv-exec', 'clock set 10:00:00 29 February 2023')).toEqual({ error: MSG_CLOCK_DAY(29, 'February') });
    expect(typed(r, 'priv-exec', 'clock set 10:00:00 29 February 2024')).toEqual({});
    expect(r.requests).toHaveLength(1);
  });

  it('clockSetInstant and the calendar helpers are integer and exact', () => {
    expect(clockSetInstant('08:00:00', 6, 'January', 2025, 0)).toBe(NF_WORLD_EPOCH_UNIX_MS);
    expect(clockSetInstant('00:00:00', 1, 'January', 2020, 0)).toBe(NF_CLOCK_UNSET_UNIX_MS);
    expect(clockSetInstant('00:00:00', 1, 'January', 1970, -300)).toBe(5 * 3_600_000);
    expect(daysFromCivil(1970, 1, 1)).toBe(0);
    expect(daysFromCivil(2025, 1, 6)).toBe(Math.floor(NF_WORLD_EPOCH_UNIX_MS / DAY_MS));
    expect(civilFromDays(daysFromCivil(2024, 2, 29))).toEqual({ year: 2024, month: 2, day: 29 });
    expect(civilFromDays(-1)).toEqual({ year: 1969, month: 12, day: 31 });
  });
});

describe('show clock', () => {
  it('renders the clock in its zone with a * while it is not authoritative (D19)', () => {
    const unset: DeviceClockView = { source: 'unset', authoritative: false, unixMs: NF_CLOCK_UNSET_UNIX_MS + 5 * SEC / 1_000_000, subMsNs: 0, tz: UTC };
    expect(renderShowClock(unset)).toBe('*00:00:05.000 UTC Wed Jan 1 2020');
    const synced: DeviceClockView = { source: 'ntp', authoritative: true, unixMs: NF_WORLD_EPOCH_UNIX_MS + 312_412, subMsNs: 7, stratum: 2, reference: '10.0.0.10', tz: { name: 'CET', offsetMin: 60 } };
    expect(renderShowClock(synced)).toBe('09:05:12.412 CET Mon Jan 6 2025');
    expect(run(withClock(synced), HANDLERS.showClock)).toEqual({ output: '09:05:12.412 CET Mon Jan 6 2025' });
    expect(run(withClock(synced), HANDLERS.showClock, { detail: 'detail' })).toEqual({ output: '09:05:12.412 CET Mon Jan 6 2025\nTime source: NTP, stratum 2, from 10.0.0.10.' });
  });

  it('names every time source in the detail line', () => {
    const base = { authoritative: true, unixMs: NF_WORLD_EPOCH_UNIX_MS, subMsNs: 0, tz: UTC };
    expect(clockSourceText({ ...base, source: 'unset', authoritative: false })).toBe('No time source: the clock was never set.');
    expect(clockSourceText({ ...base, source: 'user' })).toBe('Time source: set by hand (clock set).');
    expect(clockSourceText({ ...base, source: 'master', stratum: 3 })).toBe("Time source: this device's own clock, served at stratum 3.");
    expect(clockSourceText({ ...base, source: 'host' })).toBe("Time source: the host's own clock.");
  });

  it('on a real P3-stage router: an unset clock that runs from the boot, then the configured zone', () => {
    const sim = createStagedSimulation({ seed: 7, stage: 'P3' });
    const r1 = sim.addDevice({ type: 'router.nf2911', name: 'R1' });
    sim.runFor(60 * SEC);
    const s = sim.cli.open(r1, 'console');
    const before = sim.cli.exec(s, 'show clock');
    expect(before.error).toBeUndefined();
    expect(before.output).toMatch(/^\*\d\d:\d\d:\d\d\.\d{3} UTC Wed Jan 1 2020$/);
    for (const line of ['enable', 'configure terminal', 'clock timezone CET 1', 'end']) expect(sim.cli.exec(s, line).error, line).toBeUndefined();
    expect(sim.cli.exec(s, 'show clock').output).toMatch(/^\*01:\d\d:\d\d\.\d{3} CET Wed Jan 1 2020$/);
  });
});
