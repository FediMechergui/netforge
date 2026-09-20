/**
 * cli/format.ts — text layout helpers for `show` output (spec §7.5 output templates).
 *
 * Pure string functions shared by the show/PC handlers: left-aligned column
 * tables, padding, and human-readable renderings of sim durations, link speeds
 * and byte counts. Nothing here reads engine state; every function is total
 * and deterministic for the same input.
 */
import { SEC } from '../contracts/time.js';
import type { SimTime } from '../contracts/time.js';

/** Options for `table`. */
export interface TableOptions {
  /** Spaces between columns (default 2). */
  gap?: number;
  /** Prefix prepended to every line (default ''). */
  indent?: string;
  /** Per-column alignment; missing entries default to 'left'. */
  align?: readonly ('left' | 'right')[];
  /** Per-column minimum widths; missing entries default to 0. */
  minWidths?: readonly number[];
}

/** Pad `s` with spaces on the right up to `width` (never truncates). */
export function padRight(s: string, width: number): string {
  return s.length >= width ? s : s + ' '.repeat(width - s.length);
}

/** Pad `s` with spaces on the left up to `width` (never truncates). */
export function padLeft(s: string, width: number): string {
  return s.length >= width ? s : ' '.repeat(width - s.length) + s;
}

/**
 * Lay `rows` out as aligned columns. Each column is as wide as its widest cell
 * (or `minWidths[i]`), columns are separated by `gap` spaces, and trailing
 * whitespace is trimmed from every line so output never ends in blanks.
 * Rows may have different lengths; missing cells are treated as empty.
 * Returns the lines joined with '\n' (no trailing newline); '' for no rows.
 */
export function table(rows: readonly (readonly string[])[], opts: TableOptions = {}): string {
  const gap = ' '.repeat(opts.gap ?? 2);
  const indent = opts.indent ?? '';
  const align = opts.align ?? [];
  const widths: number[] = [];
  for (const row of rows) {
    for (let i = 0; i < row.length; i++) {
      const w = row[i]!.length;
      if (w > (widths[i] ?? 0)) widths[i] = w;
    }
  }
  if (opts.minWidths) {
    for (let i = 0; i < opts.minWidths.length; i++) {
      const m = opts.minWidths[i]!;
      if (m > (widths[i] ?? 0)) widths[i] = m;
    }
  }
  const lines: string[] = [];
  for (const row of rows) {
    let line = indent;
    for (let i = 0; i < widths.length; i++) {
      const cell = row[i] ?? '';
      const width = widths[i]!;
      if (i > 0) line += gap;
      line += align[i] === 'right' ? padLeft(cell, width) : padRight(cell, width);
    }
    lines.push(line.replace(/\s+$/, ''));
  }
  return lines.join('\n');
}

const MINUTE_NS = 60 * SEC;
const HOUR_NS = 60 * MINUTE_NS;
const DAY_NS = 24 * HOUR_NS;

function plural(n: number, unit: string): string {
  return `${n} ${unit}${n === 1 ? '' : 's'}`;
}

/**
 * Long-form uptime: '2 days, 3 hours, 4 minutes'. Zero components are omitted
 * except that a duration under one minute renders as '0 minutes'.
 */
export function fmtUptime(ns: SimTime): string {
  const total = Math.max(0, Math.floor(ns));
  const days = Math.floor(total / DAY_NS);
  const hours = Math.floor((total % DAY_NS) / HOUR_NS);
  const minutes = Math.floor((total % HOUR_NS) / MINUTE_NS);
  const parts: string[] = [];
  if (days > 0) parts.push(plural(days, 'day'));
  if (hours > 0) parts.push(plural(hours, 'hour'));
  if (minutes > 0 || parts.length === 0) parts.push(plural(minutes, 'minute'));
  return parts.join(', ');
}

/**
 * Compact duration 'HH:MM:SS' (hours are not capped at 24; sub-second parts are
 * dropped). Used for "last input/output … ago" style fields.
 */
export function fmtDuration(ns: SimTime): string {
  const totalS = Math.max(0, Math.floor(ns / SEC));
  const s = totalS % 60;
  const m = Math.floor(totalS / 60) % 60;
  const h = Math.floor(totalS / 3600);
  const pad = (n: number): string => n.toString().padStart(2, '0');
  return `${pad(h)}:${pad(m)}:${pad(s)}`;
}

/**
 * Time elapsed since `at`, or 'never' when `at` is undefined. `now` is the
 * current sim time; a future `at` renders as '00:00:00'.
 */
export function fmtSince(at: SimTime | undefined, now: SimTime): string {
  if (at === undefined) return 'never';
  return fmtDuration(now - at);
}

/**
 * Link speed: 10 Mb/s, 100 Mb/s, 1 Gb/s, 10 Gb/s. Non-round speeds keep one
 * decimal (2.5 Gb/s); speeds under 1 Mb/s use kb/s or b/s.
 */
export function fmtBps(bps: number): string {
  const units: readonly [number, string][] = [
    [1_000_000_000, 'Gb/s'],
    [1_000_000, 'Mb/s'],
    [1_000, 'kb/s'],
  ];
  for (const [div, unit] of units) {
    if (bps >= div) {
      const v = bps / div;
      const text = Number.isInteger(v) ? String(v) : v.toFixed(1).replace(/\.0$/, '');
      return `${text} ${unit}`;
    }
  }
  return `${bps} b/s`;
}

/**
 * Byte count with a binary-scaled unit: '512 bytes', '1.5 KB', '2.0 MB', '3.0 GB'.
 * Exact byte counts (as used in counters) should be printed raw; this is for
 * summaries where an approximate size reads better.
 */
export function fmtBytes(n: number): string {
  const v = Math.max(0, n);
  if (v < 1024) return `${Math.floor(v)} bytes`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let scaled = v / 1024;
  let i = 0;
  while (scaled >= 1024 && i < units.length - 1) {
    scaled /= 1024;
    i++;
  }
  return `${scaled.toFixed(1)} ${units[i]}`;
}

/** Whole minutes elapsed between `from` and `now` (floored, never negative). */
export function minutesBetween(from: SimTime, now: SimTime): number {
  return Math.max(0, Math.floor((now - from) / MINUTE_NS));
}
