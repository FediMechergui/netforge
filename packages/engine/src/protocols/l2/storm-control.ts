/**
 * protocols/l2/storm-control.ts — the storm-control ingress check (ARCHITECTURE-P3C D8 [S16], §3.7, §4.1, §4.2, §4.3,
 * §5, §2.6 `StormControlRow`).
 *
 * eth-switch checks storm control at **ingress**, before learning, on a port with a `storm-control … level …` line.
 * W1a delivers the pure pieces only; the W2a l2 item wires them into eth-switch (§7). The pieces:
 *
 *  • `readStormControl(config)` — per interface `storm-control broadcast|multicast|unicast level [pps|bps] <rise>
 *    [<fall>]` (fall defaults to rise; a later line of the same class replaces the earlier one) and `storm-control
 *    action shutdown|trap`. A percent level is stored in integer hundredths (`level 1.00` = 100, at most 100.00); a
 *    `pps` or `bps` level is an integer, optionally written with a `k`, `m` or `g` suffix (`1.5k` = 1500). A fall above
 *    the rise does not parse. Only ports with at least one level line are in the map, so with no line anywhere the
 *    per-frame cost is one Map lookup (the loop-storm budget, §12.2).
 *  • `stormClassOf(dst)` — broadcast (ff:ff:ff:ff:ff:ff), multicast (the group bit) or unicast (every other frame, the
 *    real behaviour: known and unknown unicast alike).
 *  • `stormControlArrive(arrival)` — one frame of a configured class:
 *      – a window is one simulated second `[k s, (k+1) s)`, aligned to SimTime 0 and evaluated lazily on the first
 *        frame of the class after its boundary; there is no timer (§4.2);
 *      – the amount a frame adds is 1 for `pps`, else its wire bits: the frame's size (with FCS, without preamble) × 8;
 *      – thresholds per window: `pps` and `bps` are the configured values; a percent level is
 *        ⌊operational speedBps × level / 10 000⌋ bits;
 *      – while forwarding, the frame that would push the window's offered amount above `rise` and every later frame
 *        of the class in that window are dropped `storm-control` (state `blocking`);
 *      – at the next boundary, if the window just before it offered ≤ `fall` (dropped frames included; an empty
 *        window offered 0), the state returns to `forwarding`; otherwise the whole new window drops;
 *      – the first exceedance (forwarding → blocking) err-disables the port with `action shutdown` (cause
 *        `storm-control`), and with `action trap` emits one log (severity 3, facility `STORM_CONTROL`).
 *  • Rows (rule 20): `stormControlRows(pc, now)` is written once when the line is stored or the port comes up (state
 *    `forwarding`, `current` 0, `dropped` 0, `windowStart` = now). `stormControlArrive` then returns a row only on a
 *    state change or when it closes a window that had drops — never per frame. `current` is the level of the last
 *    closed window that carried traffic (same unit as the line), `dropped` the drops counted since the row was first
 *    written, `windowStart` the start of the window in progress. Windows are lazy, so once traffic stops `current`,
 *    `dropped` and `state` keep their last values: they are not live.
 *
 * Wording is original. Integer only. Pure: no state, no I/O, no clock, no randomness — the caller keeps one
 * `StormWindowState` and one row per (port, class) and passes them back.
 */
import { MAC_BROADCAST, isMulticastMac, normalizeMac } from '../../contracts/addr.js';
import type { MacAddress } from '../../contracts/addr.js';
import type { ConfigAst } from '../../contracts/config.js';
import type { PortId } from '../../contracts/ids.js';
import type { ErrDisableCause } from '../../contracts/port.js';
import type { DropRule, Severity } from '../../contracts/process.js';
import type { StormControlRow } from '../../contracts/tables.js';
import { SEC } from '../../contracts/time.js';
import type { SimTime } from '../../contracts/time.js';
import { configTextLinesOf } from '../../cli/config-text.js';
import { interfaceOfContext } from './switchport-config.js';

/** The traffic classes, in display order. */
export const STORM_CLASSES = Object.freeze(['broadcast', 'multicast', 'unicast'] as const);
export type StormClass = (typeof STORM_CLASSES)[number];
export type StormUnit = StormControlRow['unit'];
export type StormAction = StormControlRow['action'];

/** One storm-control window: one simulated second. */
export const STORM_WINDOW_NS: SimTime = SEC;
/** A percent level of 100.00 % in hundredths. */
export const STORM_PERCENT_MAX = 10_000;
/** Highest accepted `pps` or `bps` level. */
export const STORM_RATE_MAX = 10_000_000_000;
/** The err-disable cause of `action shutdown`. */
export const STORM_CONTROL_ERR_DISABLE_CAUSE: ErrDisableCause = 'storm-control';
/** Syslog facility of the `action trap` log. */
export const STORM_CONTROL_LOG_FACILITY = 'STORM_CONTROL';
/** Severity of the `action trap` log. */
export const STORM_CONTROL_LOG_SEVERITY: Severity = 3;
/** Debug category of storm-control messages. */
export const STORM_CONTROL_DEBUG_CATEGORY = 'storm-control';

/** `storm-control` row key: `${port}|${kind}` (§2.6). */
export function stormControlKey(port: PortId, kind: StormClass): string {
  return `${port}|${kind}`;
}

// ── configuration ─────────────────────────────────────────────────────────────────────────────────────────────

/** One `storm-control <class> level …` line. */
export interface StormControlLevel {
  readonly kind: StormClass;
  readonly unit: StormUnit;
  /** Percent in hundredths (100 = 1.00 %), else pps or bps. */
  readonly rise: number;
  /** As `rise`; equal to it when the line has no falling level. */
  readonly fall: number;
  /** The stored line's tokens. */
  readonly line: readonly string[];
}

/** The storm-control lines of one interface (only interfaces with at least one level line are listed). */
export interface StormControlPortConfig {
  readonly port: PortId;
  /** One level per configured class, in class order (broadcast, multicast, unicast). */
  readonly levels: readonly StormControlLevel[];
  /** `storm-control action shutdown`. */
  readonly shutdown: boolean;
  /** `storm-control action trap`. */
  readonly trap: boolean;
  /** The row's action: `shutdown` when configured, else `trap` when configured, else `drop`. */
  readonly action: StormAction;
}

/** Every port with a level line; a port without one is absent. */
export type StormControlConfig = ReadonlyMap<PortId, StormControlPortConfig>;

/** A percent level (`1`, `1.5`, `1.25`, at most `100.00`) in hundredths, or undefined. */
export function parseStormPercent(t: string | undefined): number | undefined {
  const m = t === undefined ? null : /^(\d{1,3})(?:\.(\d{1,2}))?$/.exec(t);
  if (m === null) return undefined;
  const v = Number(m[1]) * 100 + Number(((m[2] ?? '') + '00').slice(0, 2));
  return v <= STORM_PERCENT_MAX ? v : undefined;
}

const SUFFIX: Readonly<Record<string, { mult: number; digits: number }>> = {
  '': { mult: 1, digits: 0 },
  k: { mult: 1_000, digits: 3 },
  m: { mult: 1_000_000, digits: 6 },
  g: { mult: 1_000_000_000, digits: 9 },
};

/** A `pps` / `bps` level (`500`, `1k`, `1.5m`, `2g`) as an integer, or undefined (a fraction must stay whole). */
export function parseStormRate(t: string | undefined): number | undefined {
  const m = t === undefined ? null : /^(\d{1,11})(?:\.(\d{1,9}))?([kmg]?)$/i.exec(t);
  if (m === null) return undefined;
  const s = SUFFIX[(m[3] as string).toLowerCase()] as { mult: number; digits: number };
  const frac = m[2] ?? '';
  if (frac.length > s.digits) return undefined;
  const v = Number(m[1]) * s.mult + (frac === '' ? 0 : Number(frac.padEnd(s.digits, '0')));
  return v <= STORM_RATE_MAX ? v : undefined;
}

/** The level of a `storm-control <class> level …` line (tokens without `no`), or undefined when it does not parse. */
export function parseStormLevelLine(tokens: readonly string[]): StormControlLevel | undefined {
  if (tokens[0] !== 'storm-control' || tokens[2] !== 'level') return undefined;
  const kind = STORM_CLASSES.find((c) => c === tokens[1]);
  if (kind === undefined) return undefined;
  let unit: StormUnit = 'percent';
  let i = 3;
  if (tokens[3] === 'pps' || tokens[3] === 'bps') {
    unit = tokens[3];
    i = 4;
  }
  const rest = tokens.slice(i);
  if (rest.length < 1 || rest.length > 2) return undefined;
  const parse = unit === 'percent' ? parseStormPercent : parseStormRate;
  const rise = parse(rest[0]);
  const fall = rest.length === 2 ? parse(rest[1]) : rise;
  if (rise === undefined || fall === undefined || fall > rise) return undefined;
  return Object.freeze({ kind, unit, rise, fall, line: Object.freeze(tokens.slice()) });
}

/** The storm-control configuration of a device. Stored negations and lines that do not parse configure nothing. */
export function readStormControl(config: ConfigAst): StormControlConfig {
  const ports = new Map<PortId, { levels: Map<StormClass, StormControlLevel>; shutdown: boolean; trap: boolean }>();
  const entry = (port: PortId): { levels: Map<StormClass, StormControlLevel>; shutdown: boolean; trap: boolean } => {
    let e = ports.get(port);
    if (e === undefined) {
      e = { levels: new Map(), shutdown: false, trap: false };
      ports.set(port, e);
    }
    return e;
  };
  for (const l of configTextLinesOf(config.root)) {
    const t = l.tokens;
    if (l.negate || l.context.length !== 1 || t[0] !== 'storm-control') continue;
    const port = interfaceOfContext(l.context);
    if (port === undefined) continue;
    if (t[1] === 'action' && t.length === 3 && (t[2] === 'shutdown' || t[2] === 'trap')) {
      entry(port)[t[2]] = true;
      continue;
    }
    const level = parseStormLevelLine(t);
    if (level !== undefined) entry(port).levels.set(level.kind, level);
  }
  const out = new Map<PortId, StormControlPortConfig>();
  for (const [port, e] of ports) {
    if (e.levels.size === 0) continue;
    const levels = STORM_CLASSES.flatMap((c) => (e.levels.has(c) ? [e.levels.get(c) as StormControlLevel] : []));
    const action: StormAction = e.shutdown ? 'shutdown' : e.trap ? 'trap' : 'drop';
    out.set(port, Object.freeze({ port, levels: Object.freeze(levels), shutdown: e.shutdown, trap: e.trap, action }));
  }
  return out;
}

/** The level of `kind` on a configured port, or undefined (the class is not limited). */
export function stormLevelFor(pc: StormControlPortConfig, kind: StormClass): StormControlLevel | undefined {
  return pc.levels.find((l) => l.kind === kind);
}

// ── units ─────────────────────────────────────────────────────────────────────────────────────────────────────

/** The class of a frame by its Ethernet destination. */
export function stormClassOf(dst: MacAddress): StormClass {
  const mac = normalizeMac(dst) ?? dst;
  if (mac === MAC_BROADCAST) return 'broadcast';
  return isMulticastMac(mac) ? 'multicast' : 'unicast';
}

/** What one frame adds to a window: 1 for `pps`, else its wire bits (`frameBytes` with FCS, without preamble, × 8). */
export function stormAmount(unit: StormUnit, frameBytes: number): number {
  return unit === 'pps' ? 1 : frameBytes * 8;
}

/** A level as a per-window threshold: frames (`pps`), bits (`bps`), or ⌊speedBps × hundredths / 10 000⌋ bits. */
export function stormThreshold(unit: StormUnit, value: number, speedBps: number): number {
  return unit === 'percent' ? Math.floor((speedBps * value) / STORM_PERCENT_MAX) : value;
}

/** A window's offered amount as a level in the line's unit (percent in hundredths, rounded down). */
export function stormLevelOf(unit: StormUnit, offered: number, speedBps: number): number {
  if (unit !== 'percent') return offered;
  return speedBps > 0 ? Math.floor((offered * STORM_PERCENT_MAX) / speedBps) : 0;
}

/** `1.00%`, `100 pps`, `1000000 bps`. */
export function formatStormLevel(unit: StormUnit, value: number): string {
  if (unit === 'pps') return `${value} pps`;
  if (unit === 'bps') return `${value} bps`;
  return `${Math.floor(value / 100)}.${String(value % 100).padStart(2, '0')}%`;
}

/** The start of the window holding `now`. */
export function stormWindowStart(now: SimTime): SimTime {
  return now - (now % STORM_WINDOW_NS);
}

// ── rows ──────────────────────────────────────────────────────────────────────────────────────────────────────

/** The row written when the line is stored or the port comes up: forwarding, current 0, dropped 0, windowStart = now. */
export function stormControlInitialRow(pc: StormControlPortConfig, level: StormControlLevel, now: SimTime): StormControlRow {
  return {
    key: stormControlKey(pc.port, level.kind),
    port: pc.port,
    kind: level.kind,
    unit: level.unit,
    rise: level.rise,
    fall: level.fall,
    current: 0,
    state: 'forwarding',
    action: pc.action,
    dropped: 0,
    windowStart: now,
    updatedAt: now,
  };
}

/** The initial rows of a port, one per configured class (class order). */
export function stormControlRows(pc: StormControlPortConfig, now: SimTime): StormControlRow[] {
  return pc.levels.map((l) => stormControlInitialRow(pc, l, now));
}

// ── the check ─────────────────────────────────────────────────────────────────────────────────────────────────

/** The per-(port, class) window the caller keeps between frames. */
export interface StormWindowState {
  /** The window's first instant (a multiple of one second). */
  readonly start: SimTime;
  /** Amount offered in the window so far, dropped frames included (frames or bits). */
  readonly offered: number;
  /** Frames dropped in the window so far. */
  readonly dropped: number;
  readonly blocking: boolean;
  /** Drops counted since the row was first written (the row's `dropped`). */
  readonly total: number;
  /** The level of the last closed window that carried traffic (the row's `current`). */
  readonly current: number;
}

/** Inputs of one ingress check. */
export interface StormControlArrival {
  readonly config: StormControlPortConfig;
  readonly level: StormControlLevel;
  /** The port's operational speed. */
  readonly speedBps: number;
  /** The frame's size on the wire, with FCS, without preamble. */
  readonly frameBytes: number;
  readonly now: SimTime;
  /** The window so far; undefined after the row was (re)written at store or port-up. */
  readonly state?: StormWindowState;
  /** The class's row as last written (from `stormControlRows` or a previous step). */
  readonly row: StormControlRow;
}

/** A log line to emit: `Action log {severity, facility, message}`. */
export interface StormControlLog {
  readonly severity: Severity;
  readonly facility: string;
  readonly message: string;
}

/** Outcome of one check. `state` is always the new window for the caller to keep. */
export interface StormControlStep {
  readonly state: StormWindowState;
  /** Present when the frame is dropped: `Action drop {reason: 'storm-control', detail, rule}`. */
  readonly drop?: { readonly reason: 'storm-control'; readonly detail: string; readonly rule: DropRule };
  /** The first exceedance with `action shutdown`: `Action errDisable {port, cause, detail}`. */
  readonly errDisable?: { readonly cause: ErrDisableCause; readonly detail: string };
  /** The first exceedance with `action trap`. */
  readonly log?: StormControlLog;
  /** Present when the row must be written (a state change, or a closed window that had drops). */
  readonly row?: StormControlRow;
  readonly debug?: string;
}

function dropRule(pc: StormControlPortConfig, level: StormControlLevel): DropRule {
  return {
    kind: 'storm-control',
    text: `storm control on ${pc.port} lets at most ${formatStormLevel(level.unit, level.rise)} of ${level.kind} traffic through per second; above it the rest of the second is dropped, and the class stays blocked until a second stays at or below ${formatStormLevel(level.unit, level.fall)}`,
    table: 'storm-control',
    key: stormControlKey(pc.port, level.kind),
    iface: pc.port,
    config: { context: [['interface', pc.port]], line: level.line },
  };
}

/** The storm-control check for one frame of a configured class (see the file header). */
export function stormControlArrive(a: StormControlArrival): StormControlStep {
  const { config: pc, level, speedBps, now, row } = a;
  const start = stormWindowStart(now);
  const prev = a.state;
  let st: { start: SimTime; offered: number; dropped: number; blocking: boolean; total: number; current: number };
  let rollWrite = false;
  if (prev === undefined) {
    st = { start, offered: 0, dropped: 0, blocking: false, total: row.dropped, current: row.current };
  } else if (prev.start === start) {
    st = { ...prev };
  } else {
    // close the previous window: the one just before `start` offered prev.offered if adjacent, else 0
    const before = prev.start + STORM_WINDOW_NS === start ? prev.offered : 0;
    const blocking = prev.blocking && before > stormThreshold(level.unit, level.fall, speedBps);
    const current = prev.offered > 0 ? stormLevelOf(level.unit, prev.offered, speedBps) : prev.current;
    rollWrite = prev.dropped > 0 || blocking !== prev.blocking;
    st = { start, offered: 0, dropped: 0, blocking, total: prev.total, current };
  }
  const amount = stormAmount(level.unit, a.frameBytes);
  const rise = stormThreshold(level.unit, level.rise, speedBps);
  const wasBlocking = st.blocking;
  const exceeds = !wasBlocking && st.offered + amount > rise;
  st.offered += amount;
  const dropped = wasBlocking || exceeds;
  if (dropped) {
    st.dropped += 1;
    st.total += 1;
    st.blocking = true;
  }
  const state: StormWindowState = Object.freeze({ ...st });
  const shutdown = exceeds && pc.shutdown;
  const out: {
    state: StormWindowState; drop?: StormControlStep['drop']; errDisable?: StormControlStep['errDisable'];
    log?: StormControlLog; row?: StormControlRow; debug?: string;
  } = { state };
  if (exceeds || rollWrite) {
    out.row = {
      ...row,
      current: st.current,
      state: shutdown ? 'err-disabled' : st.blocking ? 'blocking' : 'forwarding',
      dropped: st.total,
      windowStart: start,
      updatedAt: now,
    };
  }
  if (!dropped) return out;
  const riseText = formatStormLevel(level.unit, level.rise);
  out.drop = {
    reason: 'storm-control',
    detail: exceeds
      ? `${level.kind} traffic on ${pc.port} went above the storm-control rising level of ${riseText} in this second`
      : `${level.kind} traffic on ${pc.port} is blocked by storm control for this second (the class is above its levels)`,
    rule: dropRule(pc, level),
  };
  out.debug = exceeds
    ? `${pc.port}: ${level.kind} storm detected (above ${riseText}); blocking the class`
    : `${pc.port}: ${level.kind} frame dropped while the class is blocked`;
  if (shutdown) {
    out.errDisable = { cause: STORM_CONTROL_ERR_DISABLE_CAUSE, detail: `${level.kind} traffic went above the storm-control rising level of ${riseText}` };
  }
  if (exceeds && pc.trap) {
    out.log = {
      severity: STORM_CONTROL_LOG_SEVERITY,
      facility: STORM_CONTROL_LOG_FACILITY,
      message: `A ${level.kind} storm was detected on ${pc.port}: traffic went above ${riseText}, and storm control is filtering the class.`,
    };
  }
  return out;
}
