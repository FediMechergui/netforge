/**
 * cli/handlers/time.ts — the device clock and NTP lines (ARCHITECTURE-P3 §5.5, §5.8, D19; §7 W2 cli part 1).
 *
 *   config.clock-timezone  `clock timezone <name> <±hours> [<minutes>]` / `no clock timezone`
 *   config.ntp-server      `ntp server <addr|name> [prefer] [source <if>]` (one slot per server: options replace) /
 *                          `no ntp server <addr|name>`
 *   config.ntp-master      `ntp master [<stratum>]` / `no ntp master`
 *   config.ntp-source      `ntp source <if>` / `no ntp source`
 *   exec.clock-set         `clock set hh:mm:ss <day> <month> <year>`: not stored; sends `ntp.clockSet {unixMs,
 *                          session}` (§2.4) with the local time typed converted to UTC by the clock's time zone
 *   show.clock             `show clock [detail]`: `[*]hh:mm:ss.mmm <zone> <Ddd> <Mmm> <d> <yyyy>` (`*` = not
 *                          authoritative, D19), and with `detail` where the time comes from
 *   host.service-ntp       `service ntp on|off` (servers) → `ntp master 1` / its removal
 *
 * Calendar arithmetic is integer only (days from the civil date, no `Date`, contracts/time.ts); `show clock` renders
 * through the contract's pure `formatClock` (ruling R8). Every string is original wording (spec §1.6).
 */
import type { CommandHandler } from '../../contracts/cli.js';
import { formatClock, type DeviceClockView } from '../../contracts/clock.js';
import { CLOCK_MONTHS, NTP_PREFER_ARG, SHOW_CLOCK_DETAIL_ARG, TIME_HANDLERS } from '../grammar/time.js';
import { globalContext, outcomeOf } from './common.js';

/** `clock set` with a time that does not read as hh:mm:ss. */
export const MSG_CLOCK_TIME = '% Give the time as hh:mm:ss, from 00:00:00 to 23:59:59.';
/** `clock set` with a day the month does not have. */
export const MSG_CLOCK_DAY = (day: number, month: string): string => `% ${month} has no day ${day} that year.`;

const NTP_PROCESS = 'ntp';
const DAY_MS = 86_400_000;

/** Days from 1970-01-01 to a civil date (proleptic Gregorian; month 1-12). Integer arithmetic. */
export function daysFromCivil(year: number, month: number, day: number): number {
  const y = month <= 2 ? year - 1 : year;
  const era = Math.floor(y / 400);
  const yoe = y - era * 400;
  const mp = (month + 9) % 12;
  const doy = Math.floor((153 * mp + 2) / 5) + day - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146_097 + doe - 719_468;
}

/** The civil date of a day count from 1970-01-01. */
export function civilFromDays(days: number): { year: number; month: number; day: number } {
  const z = days + 719_468;
  const era = Math.floor(z / 146_097);
  const doe = z - era * 146_097;
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36_524) - Math.floor(doe / 146_096)) / 365);
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const day = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const month = mp < 10 ? mp + 3 : mp - 9;
  return { year: era * 400 + yoe + (month <= 2 ? 1 : 0), month, day };
}

/** Days in a month (1-12) of a year. */
function daysInMonth(year: number, month: number): number {
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  return [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1] as number;
}


/**
 * @since P3 `show clock`'s text of a clock view: `[*]hh:mm:ss.mmm <zone> <Ddd> <Mmm> <d> <yyyy>` in the clock's local
 * time (`*` when the clock is not authoritative, D19) — the contract renderer's `show-clock` style.
 */
export function renderShowClock(view: DeviceClockView): string {
  return formatClock(view, 'show-clock');
}

/** The `show clock detail` line: where the time comes from. */
export function clockSourceText(view: DeviceClockView): string {
  switch (view.source) {
    case 'unset':
      return 'No time source: the clock was never set.';
    case 'user':
      return 'Time source: set by hand (clock set).';
    case 'ntp':
      return `Time source: NTP, stratum ${view.stratum ?? '?'}${view.reference === undefined ? '' : `, from ${view.reference}`}.`;
    case 'master':
      return `Time source: this device's own clock, served at stratum ${view.stratum ?? 8}.`;
    case 'host':
      return 'Time source: the host\'s own clock.';
  }
}

/** `clock timezone <name> <hours> [<minutes>]` / `no clock timezone`. */
const clockTimezone: CommandHandler = (ctx, args, negate) => {
  if (negate) return outcomeOf(ctx.config(['clock', 'timezone'], true, globalContext()));
  const zone = args['zone'] ?? '';
  const hours = args['hours'];
  if (zone === '' || hours === undefined) return { error: '% Expected clock timezone <name> <hours> [<minutes>].' };
  const minutes = args['minutes'];
  const line = ['clock', 'timezone', zone, String(Number(hours)), ...(minutes === undefined ? [] : [String(Number(minutes))])];
  return outcomeOf(ctx.config(line, false, globalContext()));
};

/** `ntp server <server> [prefer] [source <if>]` / `no ntp server <server>`. */
const ntpServer: CommandHandler = (ctx, args, negate) => {
  const server = args['server'];
  if (server === undefined || server === '') return negate ? {} : { error: '% Give the address or name of the time server.' };
  if (negate) return outcomeOf(ctx.config(['ntp', 'server', server], true, globalContext()));
  const line = ['ntp', 'server', server];
  if (args[NTP_PREFER_ARG] !== undefined) line.push('prefer');
  if (args['iface'] !== undefined) line.push('source', args['iface']);
  return outcomeOf(ctx.config(line, false, globalContext()));
};

/** `ntp master [<stratum>]` / `no ntp master`. */
const ntpMaster: CommandHandler = (ctx, args, negate) => {
  if (negate) return outcomeOf(ctx.config(['ntp', 'master'], true, globalContext()));
  const stratum = args['stratum'];
  return outcomeOf(ctx.config(stratum === undefined ? ['ntp', 'master'] : ['ntp', 'master', String(Number(stratum))], false, globalContext()));
};

/** `ntp source <if>` / `no ntp source`. */
const ntpSource: CommandHandler = (ctx, args, negate) => {
  if (negate) return outcomeOf(ctx.config(['ntp', 'source'], true, globalContext()));
  return outcomeOf(ctx.config(['ntp', 'source', args['iface'] ?? ''], false, globalContext()));
};

/**
 * @since P3 The UTC instant (Unix ms) of a local time typed to `clock set`, or an error message: `time` hh:mm:ss, the
 * day of `month` (a CLOCK_MONTHS name) in `year`, at `offsetMin` minutes from UTC.
 */
export function clockSetInstant(time: string, day: number, month: string, year: number, offsetMin: number): number | string {
  const m = /^(\d{1,2}):(\d{2}):(\d{2})$/.exec(time);
  if (m === null) return MSG_CLOCK_TIME;
  const hh = Number(m[1]);
  const mm = Number(m[2]);
  const ss = Number(m[3]);
  if (hh > 23 || mm > 59 || ss > 59) return MSG_CLOCK_TIME;
  const monthIndex = (CLOCK_MONTHS as readonly string[]).indexOf(month) + 1;
  if (monthIndex < 1) return '% Give the month by name, January to December.';
  if (day < 1 || day > daysInMonth(year, monthIndex)) return MSG_CLOCK_DAY(day, month);
  const localMs = daysFromCivil(year, monthIndex, day) * DAY_MS + ((hh * 60 + mm) * 60 + ss) * 1000;
  return localMs - offsetMin * 60_000;
}

/** `clock set hh:mm:ss <day> <month> <year>` → `ntp.clockSet` (D19: ntp sets the clock and writes its `clock` row). */
const clockSet: CommandHandler = (ctx, args) => {
  const instant = clockSetInstant(args['time'] ?? '', Number(args['day']), args['month'] ?? '', Number(args['year']), ctx.clock().tz.offsetMin);
  if (typeof instant === 'string') return { error: instant };
  ctx.request(NTP_PROCESS, { kind: 'ntp.clockSet', unixMs: instant, session: ctx.session.id });
  return {};
};

/** `show clock [detail]`. */
const showClock: CommandHandler = (ctx, args) => {
  const view = ctx.clock();
  const text = renderShowClock(view);
  return { output: args[SHOW_CLOCK_DETAIL_ARG] === undefined ? text : `${text}\n${clockSourceText(view)}` };
};

/** `service ntp on|off` on a server: `ntp master 1` / `no ntp master` (§5.5). */
const serviceNtp: CommandHandler = (ctx, args) => {
  const on = args['state'] === 'on';
  const error = ctx.config(on ? ['ntp', 'master', '1'] : ['ntp', 'master'], !on, globalContext());
  if (error !== undefined) return { error };
  return { output: on ? 'Time service started (stratum 1).' : 'Time service stopped.' };
};

/** @since P3 Registry fragment: the clock and NTP lines (`TIME_HANDLERS` ids). */
export const timeHandlers: Readonly<Record<string, CommandHandler>> = {
  [TIME_HANDLERS.configClockTimezone]: clockTimezone,
  [TIME_HANDLERS.configNtpServer]: ntpServer,
  [TIME_HANDLERS.configNtpMaster]: ntpMaster,
  [TIME_HANDLERS.configNtpSource]: ntpSource,
  [TIME_HANDLERS.execClockSet]: clockSet,
  [TIME_HANDLERS.showClock]: showClock,
  [TIME_HANDLERS.hostServiceNtp]: serviceNtp,
};
