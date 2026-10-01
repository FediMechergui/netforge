/**
 * protocols/l2/rate-window.ts — per-port packet counting in windows aligned to sim time (ARCHITECTURE-P3 D13, §3.4
 * steps 5 and 7, §4.1 "Snooping and DAI", §4.2, §4.5 "L2 hardening").
 *
 * DHCP snooping (`ip dhcp snooping limit rate <pps>`) and dynamic ARP inspection (`ip arp inspection limit rate <pps>
 * [burst interval <s>]`, 15 pps by default on untrusted ports) count the packets a port receives in fixed windows:
 *
 *  • a window of length L (1 s by default) starts at `floor(now / L) · L` — aligned to multiples of L from SimTime 0,
 *    never to the first packet, so two worlds that receive the same packets at the same instants count them the same;
 *  • `countInRateWindow(prev, now, L)` counts one packet: in the window of `prev` it adds one, in a later window it
 *    starts again at 1 (a window with no packets is never materialised, so there is no timer: windows are evaluated
 *    lazily, §4.2);
 *  • the limit is exceeded when a window holds MORE packets than the limit (`count > limit`): with limit 10 the 11th
 *    DHCP packet of a second err-disables the port; with the DAI default of 15 the 16th ARP does (§3.4).
 *
 * The same counter bounds log lines (DAI logs at most 5 invalid ARPs per VLAN per second): a line is written while the
 * window's count is within the limit.
 *
 * Integer only (`SimTime` is an integer of ns; the window start is an exact multiple of L). Pure: no state, no I/O,
 * no clock, no randomness — the caller keeps the window of each port (or VLAN) and passes it back.
 */
import { SEC } from '../../contracts/time.js';
import type { SimTime } from '../../contracts/time.js';

/** The default window length: one second of sim time (D13). */
export const RATE_WINDOW_NS: SimTime = SEC;

/** Packets counted in one window. */
export interface RateWindow {
  /** The window's first instant: a multiple of its length. */
  readonly start: SimTime;
  /** Packets counted in it so far (≥ 1). */
  readonly count: number;
}

/** The start of the window of length `lengthNs` that holds `now`: `floor(now / lengthNs) · lengthNs`. */
export function rateWindowStart(now: SimTime, lengthNs: SimTime = RATE_WINDOW_NS): SimTime {
  if (!Number.isInteger(lengthNs) || lengthNs <= 0) throw new RangeError(`rate window length must be a positive integer, got ${lengthNs}`);
  return now - (now % lengthNs);
}

/**
 * The window after counting one packet at `now`: `prev` plus one when `now` falls in `prev`'s window, else a new window
 * holding this packet only. A `prev` from a LATER window (never produced by a caller that moves forward in time) is
 * treated like an earlier one and restarts the count.
 */
export function countInRateWindow(prev: RateWindow | undefined, now: SimTime, lengthNs: SimTime = RATE_WINDOW_NS): RateWindow {
  const start = rateWindowStart(now, lengthNs);
  if (prev !== undefined && prev.start === start) return { start, count: prev.count + 1 };
  return { start, count: 1 };
}

/** True when `window` holds more packets than `limit` allows. */
export function rateExceeded(window: RateWindow, limit: number): boolean {
  return window.count > limit;
}

/** Packets counted so far in the window holding `now` (0 when `prev` belongs to another window or is absent). */
export function rateWindowCount(prev: RateWindow | undefined, now: SimTime, lengthNs: SimTime = RATE_WINDOW_NS): number {
  return prev !== undefined && prev.start === rateWindowStart(now, lengthNs) ? prev.count : 0;
}
