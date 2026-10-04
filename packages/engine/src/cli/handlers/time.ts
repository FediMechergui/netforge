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
 *   show.ntp-associations  (W3) `show ntp associations [detail]`: one row (or block) per configured server, in
 *                          configuration order, from its `ntp-peers` row (reference, stratum, reach in octal, delay and
 *                          offset in ms; `When` = seconds since the last reply) and the ntp StateView (`Next` = seconds
 *                          to `peers[].nextPollAt`, the retries left, the last refusal)
 *   show.ntp-status        (W3) `show ntp status`: `Clock is synchronised, stratum 2, reference is 10.0.0.10` (§5.8) from
 *                          the device clock, then the source, the last change from the `clock` row and the requests
 *                          answered (StateView `served`)
 *
 * Calendar arithmetic is integer only (days from the civil date, no `Date`, contracts/time.ts); `show clock` renders
 * through the contract's pure `formatClock` (ruling R8). Every string is original wording (spec §1.6).
 */
import type { CommandCtx, CommandHandler } from '../../contracts/cli.js';
import { formatClock, type DeviceClockView } from '../../contracts/clock.js';
import type { ClockRow, NtpPeerRow, NtpStateView } from '../../contracts/tables.js';
import { SEC, type SimTime } from '../../contracts/time.js';
import { ntpConfigOf } from '../../protocols/ntp.js';
import { fmtDuration, fmtSince, table } from '../format.js';
import { CLOCK_MONTHS, NTP_PREFER_ARG, SHOW_CLOCK_DETAIL_ARG, SHOW_NTP_DETAIL_ARG, TIME_HANDLERS } from '../grammar/time.js';
import { globalContext, outcomeOf } from './common.js';

/** `clock set` with a time that does not read as hh:mm:ss. */
export const MSG_CLOCK_TIME = '% Give the time as hh:mm:ss, from 00:00:00 to 23:59:59.';
/** `clock set` with a day the month does not have. */
export const MSG_CLOCK_DAY = (day: number, month: string): string => `% ${month} has no day ${day} that year.`;
/** @since P3 `show ntp associations` without any `ntp server` line. */
export const MSG_NO_NTP_SERVER = 'No time server is configured ("ntp server <address>" adds one).';
/** @since P3 The legend under `show ntp associations`. */
export const NTP_ASSOCIATIONS_LEGEND = 'Marks: * the server this clock follows, + a candidate, - its last reply was refused, ? not reached yet';

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

// ── show ntp (W3) ────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * @since P3 An NTP offset (θ = `offsetMs` ms + `offsetSubMsNs` ns, the sub-millisecond part floored toward −∞, so
 * 0 ≤ `offsetSubMsNs` < 1 000 000; §2.6) as milliseconds with three decimals, truncated toward zero: '0.567', '-1.500'.
 * Integer arithmetic only (an offset can exceed 2^53 ns).
 */
export function ntpOffsetText(offsetMs: number, offsetSubMsNs: number): string {
  const us3 = (ns: number): string => String(Math.floor(ns / 1000)).padStart(3, '0');
  if (offsetMs >= 0) return `${offsetMs}.${us3(offsetSubMsNs)}`;
  if (offsetSubMsNs === 0) return `${offsetMs}.000`;
  return `-${-offsetMs - 1}.${us3(1_000_000 - offsetSubMsNs)}`;
}

/** @since P3 A round-trip delay in ns as milliseconds with three decimals ('1.234'). */
export function ntpDelayText(delayNs: number): string {
  return `${Math.floor(delayNs / 1_000_000)}.${String(Math.floor(delayNs / 1000) % 1000).padStart(3, '0')}`;
}

const SELECTED_MARK: Readonly<Record<NtpPeerRow['selected'], string>> = Object.freeze({ 'sys-peer': '*', candidate: '+', reject: '-', unreached: '?' });
const SELECTED_WORDS: Readonly<Record<NtpPeerRow['selected'], string>> = Object.freeze({
  'sys-peer': 'the server this clock follows',
  candidate: 'a candidate',
  reject: 'its last reply was refused',
  unreached: 'not reached yet',
});

/** The ntp StateView, when the daemon runs. */
function ntpStateView(ctx: Pick<CommandCtx, 'processState'>): NtpStateView | undefined {
  const sv = ctx.processState(NTP_PROCESS);
  return sv === undefined ? undefined : (sv.state as unknown as NtpStateView);
}

/** Whole seconds from `now` to `at` (never negative). */
function secondsTo(at: SimTime, now: SimTime): number {
  return Math.max(0, Math.floor((at - now) / SEC));
}

/** The servers to show: the configured ones in configuration order with their rows, then any other row. */
function ntpServers(ctx: CommandCtx): { address: string; prefer: boolean; row?: NtpPeerRow }[] {
  const cfg = ntpConfigOf(ctx.running.root);
  const rows = (ctx.tables.get('ntp-peers')?.rows() ?? []) as unknown as NtpPeerRow[];
  const byAddress = new Map<string, NtpPeerRow>(rows.map((r) => [r.address, r]));
  const out: { address: string; prefer: boolean; row?: NtpPeerRow }[] = [];
  for (const s of cfg.servers) {
    const row = byAddress.get(s.address);
    out.push(row === undefined ? { address: s.address, prefer: s.prefer } : { address: s.address, prefer: s.prefer, row });
    byAddress.delete(s.address);
  }
  for (const row of byAddress.values()) out.push({ address: row.address, prefer: false, row });
  return out;
}

/** `show ntp associations [detail]`. */
const showNtpAssociations: CommandHandler = (ctx, args) => {
  const servers = ntpServers(ctx);
  const ignored = ntpConfigOf(ctx.running.root).ignored;
  const note = ignored.length === 0 ? [] : [`Not used (a name, not an address): ${ignored.join(', ')}`];
  if (servers.length === 0) return { output: [MSG_NO_NTP_SERVER, ...note].join('\n') };
  const sv = ntpStateView(ctx);
  const live = (address: string): NtpStateView['peers'][number] | undefined => sv?.peers.find((p) => p.address === address);
  if (args[SHOW_NTP_DETAIL_ARG] !== undefined) {
    const blocks = servers.map(({ address, prefer, row }) => {
      const peer = live(address);
      const lines = [`${address}: configured${prefer ? ' (prefer)' : ''}, ${row === undefined ? 'not polled yet' : SELECTED_WORDS[row.selected]}`];
      if (row !== undefined) {
        lines.push(`  Stratum ${row.stratum}, reference ${row.refId}`);
        const last = row.lastRxAt === undefined ? 'no reply yet' : `last reply ${fmtSince(row.lastRxAt, ctx.now)} ago`;
        lines.push(`  Reach ${(row.reach & 0xff).toString(8)} (octal); poll every ${row.pollS} s; ${last}`);
        const delay = row.delayNs === undefined ? 'unknown' : `${ntpDelayText(row.delayNs)} ms`;
        const offset = row.offsetMs === undefined ? 'unknown' : `${ntpOffsetText(row.offsetMs, row.offsetSubMsNs ?? 0)} ms`;
        lines.push(`  Delay ${delay}, offset ${offset}`);
      }
      if (peer !== undefined) {
        const next = peer.nextPollAt === undefined ? 'No poll scheduled' : `Next poll in ${fmtDuration(peer.nextPollAt - ctx.now)}`;
        lines.push(`  ${next}; quick retries left ${peer.retriesLeft}`);
        if (peer.lastReject !== undefined) lines.push(`  Last refusal: ${peer.lastReject}`);
      }
      return lines.join('\n');
    });
    return { output: [blocks.join('\n\n'), ...note].join('\n') };
  }
  const out: string[][] = [['', 'Address', 'Reference', 'Stratum', 'When', 'Poll', 'Next', 'Reach', 'Delay (ms)', 'Offset (ms)']];
  for (const { address, row } of servers) {
    const peer = live(address);
    const next = peer?.nextPollAt === undefined ? '-' : String(secondsTo(peer.nextPollAt, ctx.now));
    if (row === undefined) {
      out.push(['?', address, '-', '-', '-', '-', next, '0', '-', '-']);
      continue;
    }
    out.push([
      SELECTED_MARK[row.selected],
      address,
      row.refId,
      String(row.stratum),
      row.lastRxAt === undefined ? '-' : String(Math.max(0, Math.floor((ctx.now - row.lastRxAt) / SEC))),
      String(row.pollS),
      next,
      (row.reach & 0xff).toString(8),
      row.delayNs === undefined ? '-' : ntpDelayText(row.delayNs),
      row.offsetMs === undefined ? '-' : ntpOffsetText(row.offsetMs, row.offsetSubMsNs ?? 0),
    ]);
  }
  return { output: [table(out, { gap: 2, minWidths: [1, 15, 9] }), NTP_ASSOCIATIONS_LEGEND, ...note].join('\n') };
};

/** The words of a clock source in `show ntp status`. */
function sourceWords(view: DeviceClockView): string {
  switch (view.source) {
    case 'ntp':
      return 'NTP';
    case 'master':
      return `this device's own clock, served at stratum ${view.stratum ?? 8} (ntp master)`;
    case 'user':
      return 'set by hand (clock set); not synchronised';
    case 'host':
      return "the host's own clock";
    case 'unset':
      return 'none: the clock was never set';
  }
}

/** `show ntp status` (§5.8 first line). */
const showNtpStatus: CommandHandler = (ctx) => {
  const view = ctx.clock();
  const synced = view.source === 'ntp' || view.source === 'master';
  const lines = [
    synced
      ? `Clock is synchronised, stratum ${view.stratum ?? 16}, reference is ${view.reference ?? 'unknown'}`
      : 'Clock is not synchronised, stratum 16, no reference',
  ];
  lines.push(`  Time source: ${sourceWords(view)}`);
  const row = (ctx.tables.get('clock')?.rows() ?? [])[0] as unknown as ClockRow | undefined;
  if (row !== undefined) lines.push(`  Last set ${fmtSince(row.since, ctx.now)} ago; it reads ${ntpOffsetText(row.offsetMs, row.offsetSubMsNs)} ms from true time`);
  const sv = ntpStateView(ctx);
  if (sv !== undefined) lines.push(`  Requests answered as a time server: ${sv.served}`);
  return { output: lines.join('\n') };
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
  // W3 cli part 2
  [TIME_HANDLERS.showNtpAssociations]: showNtpAssociations,
  [TIME_HANDLERS.showNtpStatus]: showNtpStatus,
};
