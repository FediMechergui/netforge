/**
 * link/negotiation.ts — speed/duplex negotiation of one cable, config-driven (ARCHITECTURE-P1 §3.4, §4.9, D4).
 *
 * Pure: no engine state, no randomness. The link facade (link/link.ts) calls `negotiate` for every cable whose two
 * ends both negotiate (`negotiatesPhy`), after the cable check and before any serial/radio rule, passing each end's
 * config-derived `PortPhySettings` (`speed auto|<bps>`, `duplex auto|full|half`, from `DeviceRuntime.phySettings`),
 * and writes the result to `PortState.speedBps/duplex/phy.end` (+ `phy.duplexMismatch`) and `LinkState.phy`.
 *
 * ABILITIES of an end = speeds × duplex modes:
 *   • a speed is supported when it is not above the port's maximum (`speedBps`, capped by an installed transceiver)
 *     and, when the port lists `speeds`, the list contains it; a configured `speed <n>` keeps only that speed;
 *   • duplex modes are `PortSpec.duplexModes` (default both), where half duplex exists only at speeds ≤ 1 Gb/s;
 *     a configured `duplex full|half` keeps only that mode.
 * An end AUTONEGOTIATES when its PHY can (`PortSpec.autoneg !== false`) unless BOTH speed and duplex are configured.
 * A repeater (hub / coax tap) port never negotiates: it is fixed at 10 Mb/s half duplex, whatever its config says.
 *
 * RESULT (§4.9 table):
 *   • both ends autonegotiate → the best common ability: the highest speed, full duplex before half
 *     (`via: 'autoneg'`). With no config and no `speeds` lists this is exactly `min(speedBps)` full duplex — the
 *     P0 numbers. Nothing in common → `speed-mismatch`.
 *   • one end autonegotiates, the other does not → the autonegotiating end parallel-detects the other end's speed
 *     (`via: 'parallel-detect'`; `speed-mismatch` when it cannot run at it) and, since parallel detection cannot
 *     learn duplex, takes HALF duplex below 1 Gb/s and FULL at 1 Gb/s and above (a configured duplex wins).
 *     A station on a hub is therefore 10 Mb/s half duplex (the P0.5 rule).
 *   • neither end autonegotiates → the speeds must be equal (else `speed-mismatch`); each end keeps its own duplex
 *     (`via: 'forced'` for configured values, `'fixed'` for a PHY without autonegotiation or a repeater port).
 * The two ends running different duplex modes is a DUPLEX MISMATCH (`mismatch: 'duplex'`). A cable with a repeater
 * end, a half-duplex end or a duplex mismatch is `shared`: it joins a collision domain (§3.5), where the full-duplex
 * end of a mismatch transmits without carrier sense and the half-duplex end sees (late) collisions.
 *
 * Explanations are original wording (D13).
 */
import type { PhyEndView, PortPhySettings } from '../contracts/link.js';
import type { PortRole } from '../contracts/catalog.js';
import { CSMA } from '../contracts/medium.js';
import type { PortKind } from '../contracts/port.js';
import { SPEED_1G } from '../contracts/port.js';

/** What negotiation needs to know about one end of a cable. */
export interface NegotiationEnd {
  kind: PortKind;
  /** Effective role (`PortState.role`, else the spec default). */
  role: PortRole;
  /** Maximum speed of the port (`PortSpec.speedBps`). */
  speedBps: number;
  /** Speeds the port can autonegotiate (`PortSpec.speeds`); absent = every speed up to `speedBps`. */
  speeds?: readonly number[];
  /** Speed of the transceiver installed in an SFP cage; caps `speedBps`. */
  transceiverBps?: number;
  /** Duplex modes the PHY supports (`PortSpec.duplexModes`); absent = full and half (half only at ≤ 1 Gb/s). */
  duplexModes?: readonly ('full' | 'half')[];
  /** The PHY can autonegotiate (`PortSpec.autoneg`); absent = true. */
  autoneg?: boolean;
  /** Config-derived settings (`DeviceRuntime.phySettings`); absent = speed auto, duplex auto. */
  settings?: PortPhySettings;
  /** Human label used in explanations (e.g. `PC1 GigabitEthernet0`). Defaults to `end A` / `end B`. */
  label?: string;
}

/** Negotiation outcome of one cable. */
export type NegotiationResult =
  | {
      ok: true;
      /** Speed the link runs at (before any impairment bandwidth cap). */
      bps: number;
      a: PhyEndView;
      b: PhyEndView;
      /** The two ends run different duplex modes. */
      mismatch?: 'duplex';
      /** The cable belongs to a collision domain (a repeater end, a half-duplex end or a duplex mismatch). */
      shared: boolean;
    }
  | { ok: false; code: 'speed-mismatch'; reason: string };

/** Port kinds whose cables negotiate speed and duplex. Serial, console, USB and radio links do not (their `LinkState.phy` is omitted). */
export const NEGOTIATING_KINDS: readonly PortKind[] = Object.freeze(['ethernet', 'coax', 'phone', 'fiber-pon']);

/** Fastest speed at which half duplex exists (802.3 defines no half-duplex operation above 1 Gb/s). */
export const HALF_DUPLEX_MAX_BPS = SPEED_1G;

/** True when a cable between ports of these kinds negotiates speed/duplex. */
export function negotiatesPhy(a: PortKind, b: PortKind): boolean {
  return NEGOTIATING_KINDS.includes(a) && NEGOTIATING_KINDS.includes(b);
}

/** Highest speed the end can run at: `speedBps`, capped by an installed transceiver. */
export function maxEndBps(end: NegotiationEnd): number {
  return end.transceiverBps !== undefined && end.transceiverBps < end.speedBps ? end.transceiverBps : end.speedBps;
}

/** Whether the end's hardware can run at `bps` (configuration not considered). */
export function endSupports(end: NegotiationEnd, bps: number): boolean {
  if (bps > maxEndBps(end)) return false;
  return end.speeds === undefined || end.speeds.includes(bps);
}

/**
 * Best common speed of two ends' hardware: the highest speed at or below both maxima that both ends support.
 * Without `speeds` lists this is `min(maxEndBps(a), maxEndBps(b))`. Undefined when nothing is common.
 */
export function bestCommonBps(a: NegotiationEnd, b: NegotiationEnd): number | undefined {
  for (const bps of candidateSpeeds(a, b)) {
    if (endSupports(a, bps) && endSupports(b, bps)) return bps;
  }
  return undefined;
}

/** Whether a port with this role is a repeater (hub/coax tap) port. */
export function isRepeaterRole(role: PortRole): boolean {
  return role === 'repeater';
}

/** `10 Mb/s`, `1 Gb/s`, `64 kb/s` — speed wording used in explanations. */
export function formatBps(bps: number): string {
  if (bps >= 1_000_000_000 && bps % 1_000_000_000 === 0) return `${bps / 1_000_000_000} Gb/s`;
  if (bps >= 1_000_000 && bps % 1_000_000 === 0) return `${bps / 1_000_000} Mb/s`;
  if (bps >= 1_000 && bps % 1_000 === 0) return `${bps / 1_000} kb/s`;
  return `${bps} b/s`;
}

/** Duplex modes the end's hardware supports at `bps`, full first (half only at ≤ HALF_DUPLEX_MAX_BPS). */
export function hardwareDuplexes(end: NegotiationEnd, bps: number): ('full' | 'half')[] {
  const modes = end.duplexModes ?? ['full', 'half'];
  const out: ('full' | 'half')[] = [];
  if (modes.includes('full')) out.push('full');
  if (modes.includes('half') && bps <= HALF_DUPLEX_MAX_BPS) out.push('half');
  return out;
}

/** Whether the end autonegotiates with this configuration (§4.9: not when both speed and duplex are forced). */
export function endAutonegotiates(end: NegotiationEnd): boolean {
  if (isRepeaterRole(end.role)) return false;
  if (end.autoneg === false) return false;
  const s = end.settings;
  return !(s !== undefined && s.speed !== 'auto' && s.duplex !== 'auto');
}

/** Speeds worth trying for two ends, fastest first: the common cap, both lists and configured speeds at or below it. */
function candidateSpeeds(a: NegotiationEnd, b: NegotiationEnd): number[] {
  const cap = Math.min(maxEndBps(a), maxEndBps(b));
  const out: number[] = [cap];
  const add = (s: number): void => {
    if (s <= cap && !out.includes(s)) out.push(s);
  };
  for (const list of [a.speeds, b.speeds]) if (list !== undefined) for (const s of list) add(s);
  for (const e of [a, b]) if (e.settings !== undefined && e.settings.speed !== 'auto') add(e.settings.speed);
  out.sort((x, y) => y - x);
  return out;
}

/** Speed abilities filter: hardware support plus a configured speed. */
function speedAllowed(end: NegotiationEnd, bps: number): boolean {
  const s = end.settings?.speed ?? 'auto';
  return endSupports(end, bps) && (s === 'auto' || s === bps);
}

/** Duplex abilities at `bps`: hardware modes filtered by a configured duplex (full first). */
function duplexAllowed(end: NegotiationEnd, bps: number): ('full' | 'half')[] {
  const d = end.settings?.duplex ?? 'auto';
  const modes = hardwareDuplexes(end, bps);
  return d === 'auto' ? modes : modes.filter((m) => m === d);
}

/** A non-negotiating end's operating point, or an explanation why it has none. */
type FixedEnd = { ok: true; view: PhyEndView } | { ok: false; reason: string };

const REPEATER_END: PhyEndView = Object.freeze({ speedBps: CSMA.REPEATER_BPS, duplex: 'half', autoneg: false, via: 'fixed' });

/** Operating point of an end that does not autonegotiate (repeater, PHY without autoneg, or speed+duplex forced). */
function fixedEnd(end: NegotiationEnd, label: string): FixedEnd {
  if (isRepeaterRole(end.role)) return { ok: true, view: { ...REPEATER_END } };
  const s = end.settings;
  const speedForced = s !== undefined && s.speed !== 'auto';
  const duplexForced = s !== undefined && s.duplex !== 'auto';
  const bps = speedForced ? (s.speed as number) : maxEndBps(end);
  if (!endSupports(end, bps)) {
    return { ok: false, reason: `${label} is set to ${formatBps(bps)}, a speed its hardware cannot run at.` };
  }
  const modes = hardwareDuplexes(end, bps);
  let duplex: 'full' | 'half';
  if (duplexForced) {
    duplex = s.duplex as 'full' | 'half';
    if (!modes.includes(duplex)) {
      return { ok: false, reason: `${label} is set to ${duplex} duplex, which its hardware cannot use at ${formatBps(bps)}.` };
    }
  } else {
    const first = modes[0];
    if (first === undefined) return { ok: false, reason: `${label} has no duplex mode it can use at ${formatBps(bps)}.` };
    duplex = first;
  }
  return { ok: true, view: { speedBps: bps, duplex, autoneg: false, via: speedForced || duplexForced ? 'forced' : 'fixed' } };
}

/** Assemble the ok result (mismatch and shared derived from the two views and the roles). */
function done(a: NegotiationEnd, b: NegotiationEnd, bps: number, va: PhyEndView, vb: PhyEndView): NegotiationResult {
  const mismatch = va.duplex !== vb.duplex;
  const shared = isRepeaterRole(a.role) || isRepeaterRole(b.role) || va.duplex === 'half' || vb.duplex === 'half' || mismatch;
  const out: NegotiationResult = { ok: true, bps, a: va, b: vb, shared };
  if (mismatch) out.mismatch = 'duplex';
  return out;
}

/** Both ends autonegotiate: best common ability, highest speed, full before half. */
function bothAuto(a: NegotiationEnd, b: NegotiationEnd, labelA: string, labelB: string): NegotiationResult {
  for (const bps of candidateSpeeds(a, b)) {
    if (!speedAllowed(a, bps) || !speedAllowed(b, bps)) continue;
    const da = duplexAllowed(a, bps);
    const db = duplexAllowed(b, bps);
    const duplex = da.find((m) => db.includes(m));
    if (duplex === undefined) continue;
    return done(a, b, bps, { speedBps: bps, duplex, autoneg: true, via: 'autoneg' }, { speedBps: bps, duplex, autoneg: true, via: 'autoneg' });
  }
  const configured = a.settings !== undefined && (a.settings.speed !== 'auto' || a.settings.duplex !== 'auto')
    || b.settings !== undefined && (b.settings.speed !== 'auto' || b.settings.duplex !== 'auto');
  return {
    ok: false,
    code: 'speed-mismatch',
    reason: configured
      ? `${labelA} and ${labelB} advertise no speed and duplex combination in common with their current settings.`
      : `${labelA} (up to ${formatBps(maxEndBps(a))}) and ${labelB} (up to ${formatBps(maxEndBps(b))}) share no speed they can both run at.`,
  };
}

/** One end autonegotiates, the other is fixed: parallel detection on the autonegotiating end. */
function parallelDetect(auto: NegotiationEnd, fixed: PhyEndView, autoLabel: string, fixedLabel: string, fixedIsRepeater: boolean): PhyEndView | string {
  const bps = fixed.speedBps;
  if (!speedAllowed(auto, bps)) {
    return fixedIsRepeater
      ? `${fixedLabel} is a repeater port that only runs at ${formatBps(bps)}, but ${autoLabel} cannot run at that speed.`
      : `${fixedLabel} is fixed at ${formatBps(bps)} without autonegotiation, and ${autoLabel} cannot run at that speed.`;
  }
  const modes = duplexAllowed(auto, bps);
  const preferred: 'full' | 'half' = bps < HALF_DUPLEX_MAX_BPS ? 'half' : 'full';
  const duplex = modes.includes(preferred) ? preferred : modes[0];
  if (duplex === undefined) {
    return `${autoLabel} has no duplex mode it can use at ${formatBps(bps)}, the speed ${fixedLabel} is fixed at.`;
  }
  return { speedBps: bps, duplex, autoneg: true, via: 'parallel-detect' };
}

/** Negotiate one cable (see the file header). Never throws. */
export function negotiate(a: NegotiationEnd, b: NegotiationEnd): NegotiationResult {
  const labelA = a.label ?? 'end A';
  const labelB = b.label ?? 'end B';
  const autoA = endAutonegotiates(a);
  const autoB = endAutonegotiates(b);

  if (autoA && autoB) return bothAuto(a, b, labelA, labelB);

  if (autoA !== autoB) {
    const [autoEnd, fixedSpec, autoLabel, fixedLabel] = autoA ? [a, b, labelA, labelB] : [b, a, labelB, labelA];
    const fixed = fixedEnd(fixedSpec, fixedLabel);
    if (!fixed.ok) return { ok: false, code: 'speed-mismatch', reason: fixed.reason };
    const detected = parallelDetect(autoEnd, fixed.view, autoLabel, fixedLabel, isRepeaterRole(fixedSpec.role));
    if (typeof detected === 'string') return { ok: false, code: 'speed-mismatch', reason: detected };
    const bps = fixed.view.speedBps;
    return autoA ? done(a, b, bps, detected, fixed.view) : done(a, b, bps, fixed.view, detected);
  }

  const fa = fixedEnd(a, labelA);
  if (!fa.ok) return { ok: false, code: 'speed-mismatch', reason: fa.reason };
  const fb = fixedEnd(b, labelB);
  if (!fb.ok) return { ok: false, code: 'speed-mismatch', reason: fb.reason };
  if (fa.view.speedBps !== fb.view.speedBps) {
    return {
      ok: false,
      code: 'speed-mismatch',
      reason: `${labelA} runs at ${formatBps(fa.view.speedBps)} and ${labelB} at ${formatBps(fb.view.speedBps)}; neither end autonegotiates, so the speeds must be set equal.`,
    };
  }
  return done(a, b, fa.view.speedBps, fa.view, fb.view);
}

/** Field-wise equality of two end views (undefined only equals undefined). */
export function samePhyEnd(x: PhyEndView | undefined, y: PhyEndView | undefined): boolean {
  if (x === undefined || y === undefined) return x === y;
  return x.speedBps === y.speedBps && x.duplex === y.duplex && x.autoneg === y.autoneg && x.via === y.via;
}

/**
 * Whether two link negotiation views are identical, so the facade emits `phyNegotiated` only when the
 * result changed (§3.4 emit order step 2).
 */
export function samePhyResult(
  x: { a: PhyEndView; b: PhyEndView; mismatch?: 'duplex' } | undefined,
  y: { a: PhyEndView; b: PhyEndView; mismatch?: 'duplex' } | undefined,
): boolean {
  if (x === undefined || y === undefined) return x === y;
  return samePhyEnd(x.a, y.a) && samePhyEnd(x.b, y.b) && x.mismatch === y.mismatch;
}
