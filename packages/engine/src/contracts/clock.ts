/**
 * Device clocks and calendar time (ARCHITECTURE-P3 §2.9, D19). @since P3
 *
 * One calendar: SimTime 0 is `NF_WORLD_EPOCH_UNIX_MS` ("true time"), written as a literal — the engine never reads the
 * wall clock (contracts/time.ts). Each device keeps a clock as a view on SimTime (`base + (now − baseAt)`), in integer
 * arithmetic; network devices boot unset (`NF_CLOCK_UNSET_UNIX_MS` plus uptime, shown with a leading '*'), hosts and
 * servers boot with true time (source 'host'). BigInt is confined to the clock and NTP helpers and never enters a
 * snapshot or the trace.
 *
 * W0 (§0 rule 3) added the types and constants only. The pure helpers of §2.9 — `formatClock(view, style)`,
 * `ntpTimestamp(view)` and `fromNtpTimestamp(text)` — land at the end of this file with the svc clock item as a
 * reviewed additive edit (ruling R8; built with the W2 svc item, the first that needs them).
 */

/** @since P3 Mon 2025-01-06 08:00:00 UTC = SimTime 0 (true time). */
export const NF_WORLD_EPOCH_UNIX_MS = 1_736_150_400_000;
/** @since P3 Wed 2020-01-01 00:00:00 UTC: an unset network device's clock at boot (plus uptime). */
export const NF_CLOCK_UNSET_UNIX_MS = 1_577_836_800_000;
/** @since P3 Seconds from the NTP era 0 epoch (1900-01-01) to the Unix epoch (RFC 5905). */
export const NTP_UNIX_OFFSET_S = 2_208_988_800;

/**
 * @since P3 Where a device clock's value comes from: 'unset' (a network device that was never set), 'user'
 * (`clock set`), 'ntp' (a synchronisation), 'master' (`ntp master`), 'host' (hosts and servers boot with true time).
 */
export type ClockSource = 'unset' | 'user' | 'ntp' | 'master' | 'host';

/** @since P3 A device clock at one instant (`ProcessCtx.clock()`, `CommandCtx.clock()`, `DeviceRuntime.clockView(now)`). */
export interface DeviceClockView {
  readonly source: ClockSource;
  /** false → rendered with a leading '*'. */
  readonly authoritative: boolean;
  readonly unixMs: number;
  readonly subMsNs: number;
  readonly stratum?: number;
  readonly reference?: string;
  readonly tz: { readonly name: string; readonly offsetMin: number };
}

/**
 * @since P3 How a clock value is rendered: `show clock`, the [S24] `service timestamps … datetime msec` and `datetime`
 * forms, and P1's `*hh:mm:ss.uuuuuu` debug prefix (kept byte-identical without the timestamps line).
 */
export type ClockStyle = 'show-clock' | 'timestamp-msec' | 'timestamp' | 'legacy-debug';

// ── pure helpers (§2.9; ruling R8: the svc clock item's reviewed additive edit) ──────────────────────────────────

/** Nanoseconds per millisecond and per second, and the 1900 → 1970 offset, as BigInt (clock and NTP maths only). */
const NS_PER_MS_N = 1_000_000n;
const NS_PER_S_N = 1_000_000_000n;
const NTP_UNIX_OFFSET_NS_N = BigInt(NTP_UNIX_OFFSET_S) * NS_PER_S_N;
/** One NTP era: 2³² seconds (written as a literal; no exponentiation in the engine). */
const NTP_ERA_S_N = 4_294_967_296n;
const MS_PER_DAY = 86_400_000;
const MONTH_NAMES = Object.freeze(['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']);
const DAY_NAMES = Object.freeze(['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']);
const NTP_TIMESTAMP_TEXT = /^(\d{1,10})(?:\.(\d{1,9}))?$/;

/** `n` as a decimal string of at least `w` digits (zero-padded). */
function pad(n: number, w: number): string {
  return String(n).padStart(w, '0');
}

/**
 * The civil (proleptic Gregorian) date of a count of days since 1970-01-01 (integer arithmetic only; the days-from-civil
 * inverse of the well-known era algorithm), with the weekday (0 = Sunday).
 */
function civilOfDays(days: number): { year: number; month: number; day: number; weekday: number } {
  const z = days + 719_468;
  const era = Math.floor(z / 146_097);
  const doe = z - era * 146_097;
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36_524) - Math.floor(doe / 146_096)) / 365);
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const day = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const month = mp < 10 ? mp + 3 : mp - 9;
  const year = yoe + era * 400 + (month <= 2 ? 1 : 0);
  const weekday = (((days + 4) % 7) + 7) % 7;
  return { year, month, day, weekday };
}

/**
 * @since P3 Render a clock value (D19, §3.7, §5.8; [S24] the `service timestamps` forms). The time is the view's value
 * in its own zone (`view.tz`: callers that want UTC pass a view whose `tz` is UTC). A clock that is not authoritative
 * (never set) gets a leading `*`.
 *  - `'show-clock'`: `[*]hh:mm:ss.mmm <zone> <Day> <Mon> <d> <yyyy>` — `08:05:12.412 UTC Mon Jan 6 2025`;
 *  - `'timestamp-msec'`: `[*]<Mon> <dd> hh:mm:ss.mmm`, the day space-padded — `Jan  6 08:10:03.123`;
 *  - `'timestamp'`: the same without milliseconds — `Jan  6 08:10:03`;
 *  - `'legacy-debug'`: the shape of P1's debug prefix, `*hh:mm:ss.uuuuuu`, over the clock's time of day (always a `*`).
 *    P1's debug lines themselves are stamped with SimTime (`formatSimTime`), never with a device clock; the logger
 *    keeps that form, byte for byte, when no timestamps line is configured.
 */
export function formatClock(view: DeviceClockView, style: ClockStyle): string {
  const local = view.unixMs + view.tz.offsetMin * 60_000;
  const days = Math.floor(local / MS_PER_DAY);
  const msOfDay = local - days * MS_PER_DAY;
  const h = Math.floor(msOfDay / 3_600_000);
  const m = Math.floor(msOfDay / 60_000) % 60;
  const s = Math.floor(msOfDay / 1000) % 60;
  const ms = msOfDay % 1000;
  const hms = `${pad(h, 2)}:${pad(m, 2)}:${pad(s, 2)}`;
  const star = view.authoritative ? '' : '*';
  const c = civilOfDays(days);
  const mon = MONTH_NAMES[c.month - 1] as string;
  switch (style) {
    case 'show-clock':
      return `${star}${hms}.${pad(ms, 3)} ${view.tz.name} ${DAY_NAMES[c.weekday] as string} ${mon} ${c.day} ${c.year}`;
    case 'timestamp-msec':
      return `${star}${mon} ${String(c.day).padStart(2, ' ')} ${hms}.${pad(ms, 3)}`;
    case 'timestamp':
      return `${star}${mon} ${String(c.day).padStart(2, ' ')} ${hms}`;
    case 'legacy-debug':
      return `*${hms}.${pad(ms * 1000 + Math.floor(view.subMsNs / 1000), 6)}`;
  }
}

/**
 * @since P3 The 64-bit NTP timestamp of a clock value (RFC 5905 era 0: seconds since 1900-01-01 and nanoseconds) as
 * the decimal text `s.fffffffff` the `ntp` codec carries (nine fraction digits, exact to the nanosecond; the codec
 * maps it to the 32-bit fraction and back without loss). A value before 1900 is clamped to 0; the seconds wrap at the
 * era boundary (2036) as on the wire. BigInt stays inside.
 */
export function ntpTimestamp(view: Pick<DeviceClockView, 'unixMs' | 'subMsNs'>): string {
  let ns = BigInt(view.unixMs) * NS_PER_MS_N + BigInt(view.subMsNs) + NTP_UNIX_OFFSET_NS_N;
  if (ns < 0n) ns = 0n;
  const s = (ns / NS_PER_S_N) % NTP_ERA_S_N;
  const f = ns % NS_PER_S_N;
  return `${s.toString()}.${f.toString().padStart(9, '0')}`;
}

/**
 * @since P3 The clock value of an NTP timestamp text `s[.fffffffff]` (era 0; up to nine fraction digits, read as
 * nanoseconds): whole Unix milliseconds (floored) and the 0 … 999 999 ns remainder. Throws on any other text.
 */
export function fromNtpTimestamp(text: string): { unixMs: number; subMsNs: number } {
  const m = NTP_TIMESTAMP_TEXT.exec(text.trim());
  if (m === null) throw new Error(`an NTP timestamp is 's.fffffffff' (seconds since 1900), got "${text}"`);
  const total = BigInt(m[1] as string) * NS_PER_S_N + BigInt((m[2] ?? '').padEnd(9, '0')) - NTP_UNIX_OFFSET_NS_N;
  let ms = total / NS_PER_MS_N;
  let sub = total % NS_PER_MS_N;
  if (sub < 0n) {
    sub += NS_PER_MS_N;
    ms -= 1n;
  }
  return { unixMs: Number(ms), subMsNs: Number(sub) };
}
