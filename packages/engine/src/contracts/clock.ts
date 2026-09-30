/**
 * Device clocks and calendar time (ARCHITECTURE-P3 §2.9, D19). @since P3
 *
 * One calendar: SimTime 0 is `NF_WORLD_EPOCH_UNIX_MS` ("true time"), written as a literal — the engine never reads the
 * wall clock (contracts/time.ts). Each device keeps a clock as a view on SimTime (`base + (now − baseAt)`), in integer
 * arithmetic; network devices boot unset (`NF_CLOCK_UNSET_UNIX_MS` plus uptime, shown with a leading '*'), hosts and
 * servers boot with true time (source 'host'). BigInt is confined to the clock and NTP helpers and never enters a
 * snapshot or the trace.
 *
 * W0 (§0 rule 3) adds the types and constants only. The pure helpers of §2.9 — `formatClock(view, style)`,
 * `ntpTimestamp(view)` and `fromNtpTimestamp(text)` — have bodies (behaviour), so they are not declared here yet; they
 * land in this file with the W1 core/svc clock item as a reviewed additive edit (ruling R8).
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
