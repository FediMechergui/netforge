/**
 * link/media/radio.ts — RadioLink, the point-to-point radio medium (ARCHITECTURE-P1 D5, §3.7).
 *
 * A `TopologyLink {kind:'radio', media:'radio'}` joins two `radio-ptp` ports. Frames use the CableP2P pipeline
 * (link/media/p2p.ts) with per-frame tuning: the RF packet error rate is folded into the single existing loss draw on
 * `link:<id>`, propagation uses velocity factor 1.0 over the radio distance, and frameTx / in-flight legs carry
 * medium 'radio', the rate and the RSSI.
 *
 * EVALUATION (`evaluate`, called by the facade at recompute step 7 once power, admin, err-disabled, the cable check
 * and cut have passed). Config first, in this order:
 *   radio-band-mismatch → radio-channel-mismatch → radio-key-mismatch (`peer-key`; both unset counts as equal).
 * Then RF on the shared band/channel: distance = `distanceOverrideM` ?? canvas distance × metresPerUnit (integer mm);
 * RSSI/SINR/MCS from link/rf with the PtP path-loss exponent and MCS hysteresis per link.
 *   • a link that is down comes up iff RSSI ≥ RF.PTP_CONNECT_RSSI_MDB, SINR ≥ MCS0 and distance ≤ both maxRangeM;
 *     otherwise it stays down with `out-of-range`;
 *   • a link that is up stays up until RSSI/SINR fall below the drop thresholds or the distance exceeds a maxRangeM.
 *     Such an RF-only drop starts the `RF.PTP_HOLD_NS` hold (`mediumTimer 'hold:<linkId>'`); the link stays up while it
 *     runs, the hold is cancelled once the connect thresholds are met again, and on expiry the link goes down with
 *     `out-of-range`. Config mismatches take the link down at once.
 * negotiatedBps = min(MCS rate, both port speeds, impairments.bandwidthBps). `rfState` is emitted only when the bars or
 * the rate of a link change.
 *
 * Moves (`onDevicesMoved`) re-evaluate the moved devices' radio links first (creation order), then every other radio
 * link on an overlapping band/channel; a scale change re-evaluates every radio link. Re-evaluation goes through the
 * facade's `recompute`, which calls `evaluate` again, so link state has one writer.
 *
 * DETERMINISM: integer milli-dB (link/rf), integer canvas positions, explicit creation-order iteration; no rng draws
 * beyond the P2P pipeline's five per frame.
 */
import type { DeviceId, LinkId, PortRef } from '../../contracts/ids.js';
import type { LinkState, OperChanges } from '../../contracts/link.js';
import type { MediumId } from '../../contracts/medium.js';
import type { ChannelWidthMhz, RadioLinkView, RadioPortSpec, RadioSettings, RfBand } from '../../contracts/rf.js';
import { RF } from '../../contracts/rf.js';
import type { SimTime } from '../../contracts/time.js';
import { DEFAULT_METRES_PER_UNIT } from '../../contracts/topology.js';
import { effectiveWidthMhz, resolveChannel } from '../rf/channels.js';
import type { RfAssessment } from '../rf/mcs.js';
import { assessRfLink } from '../rf/mcs.js';
import { canvasDistanceMm, mmToMetres } from '../rf/pathloss.js';
import type { P2PLegTuning } from './p2p.js';
import { createCableP2P } from './p2p.js';
import type { MediumHost, MediumStrategy } from './types.js';

/** Down reasons a radio link can produce after the cable checks (recompute step 7 order). */
export type RadioDownCode = 'radio-band-mismatch' | 'radio-channel-mismatch' | 'radio-key-mismatch' | 'out-of-range';

/** Operating parameters of one radio end after defaults, clamping and channel resolution. */
export interface EffectiveRadio {
  band: RfBand;
  channel: number;
  widthMhz: ChannelWidthMhz;
  txPowerDbm: number;
  peerKey?: string;
}

/** Settings of a radio port that has no configuration: its catalog defaults, open security, 20 MHz (60 GHz: 2160). */
export function defaultRadioSettings(spec: RadioPortSpec): RadioSettings {
  return {
    band: spec.defaultBand,
    channel: spec.defaultChannel,
    widthMhz: spec.defaultBand === '60' ? 2160 : 20,
    txPowerDbm: spec.maxTxPowerDbm,
    security: 'open',
  };
}

/**
 * Effective radio of a port: an unsupported band falls back to the default band; the channel resolves through
 * `resolveChannel` ('auto' picks the first channel in CHANNELS order, since PtP links model no neighbours); the width
 * is capped by the port's maximum and made valid for the band; transmit power is capped by the port's maximum.
 */
export function effectiveRadio(spec: RadioPortSpec, settings: RadioSettings | undefined): EffectiveRadio {
  const s = settings ?? defaultRadioSettings(spec);
  const band = spec.bands.includes(s.band) ? s.band : spec.defaultBand;
  const defaultChannel = band === spec.defaultBand ? spec.defaultChannel : 0;
  const channel = resolveChannel(band, s.channel, defaultChannel, []);
  const requested: ChannelWidthMhz = s.widthMhz > spec.maxWidthMhz ? spec.maxWidthMhz : s.widthMhz;
  const out: EffectiveRadio = {
    band,
    channel,
    widthMhz: effectiveWidthMhz(band, requested),
    txPowerDbm: Math.min(Math.round(s.txPowerDbm), spec.maxTxPowerDbm),
  };
  if (s.peerKey !== undefined) out.peerKey = s.peerKey;
  return out;
}

/** One end of a radio pair evaluation. */
export interface RadioPairEnd {
  spec: RadioPortSpec;
  settings?: RadioSettings;
}

/** Input of `evaluateRadioPair`. */
export interface RadioPairInput {
  a: RadioPairEnd;
  b: RadioPairEnd;
  distanceMm: number;
  /** MCS in use, for hysteresis. */
  currentMcs?: number;
}

/** Stateless verdict of a radio pair (no hold logic). */
export interface RadioPairEvaluation {
  /** First failing config rule, if any. */
  config?: Exclude<RadioDownCode, 'out-of-range'>;
  a: EffectiveRadio;
  b: EffectiveRadio;
  /** RF on end a's band and channel (also computed for mismatched pairs, for display). */
  rf: RfAssessment;
  /** Distance is within both radios' hard cut-off. */
  withinRange: boolean;
  /** Connect rule met: config ok, connect thresholds and range. */
  canConnect: boolean;
  /** Drop rule met: config ok and (below the drop thresholds or beyond range). */
  belowDrop: boolean;
}

/** Evaluate a radio pair: config rules, then RF (§3.7). Pure. */
export function evaluateRadioPair(input: RadioPairInput): RadioPairEvaluation {
  const a = effectiveRadio(input.a.spec, input.a.settings);
  const b = effectiveRadio(input.b.spec, input.b.settings);
  const widthMhz: ChannelWidthMhz = a.widthMhz < b.widthMhz ? a.widthMhz : b.widthMhz;
  const rfInput = {
    band: a.band,
    cls: 'ptp' as const,
    widthMhz: effectiveWidthMhz(a.band, widthMhz),
    distanceMm: Math.max(0, Math.round(input.distanceMm)),
    a: { txPowerDbm: a.txPowerDbm, antennaGainDbi: input.a.spec.antennaGainDbi, generations: input.a.spec.generations, streams: input.a.spec.streams },
    b: { txPowerDbm: b.txPowerDbm, antennaGainDbi: input.b.spec.antennaGainDbi, generations: input.b.spec.generations, streams: input.b.spec.streams },
  };
  const rf = assessRfLink(input.currentMcs === undefined ? rfInput : { ...rfInput, currentMcs: input.currentMcs });
  let config: RadioPairEvaluation['config'];
  if (a.band !== b.band || rf.generation === undefined) config = 'radio-band-mismatch';
  else if (a.channel !== b.channel) config = 'radio-channel-mismatch';
  else if ((a.peerKey ?? '') !== (b.peerKey ?? '')) config = 'radio-key-mismatch';
  const maxRangeMm = Math.min(input.a.spec.maxRangeM, input.b.spec.maxRangeM) * 1000;
  const withinRange = rfInput.distanceMm <= maxRangeMm;
  const out: RadioPairEvaluation = {
    a,
    b,
    rf,
    withinRange,
    canConnect: config === undefined && rf.canConnect && withinRange,
    belowDrop: config === undefined && (rf.belowDrop || !withinRange),
  };
  if (config !== undefined) out.config = config;
  return out;
}

/** Verdict of `RadioLinkStrategy.evaluate` for the facade's recompute. */
export interface RadioLinkVerdict {
  up: boolean;
  downReason?: RadioDownCode;
  /** Present when up. */
  negotiatedBps?: number;
  /** `LinkState.radio`. */
  view: RadioLinkView;
  /** Set while the RF hold runs. */
  holdUntil?: SimTime;
}

/** Construction options of the radio link medium (supplied by the link facade). */
export interface RadioLinkOptions {
  /** Link attached to a port (the facade's port index). */
  linkOf(ref: PortRef): LinkId | undefined;
  /** Every link id in creation order (radio links are picked by `LinkState.kind`). */
  links(): readonly LinkId[];
  /** The facade's recompute (which calls `evaluate`); used for hold expiry, moves, scale and radio config changes. */
  recompute(id: LinkId, now: SimTime, reason?: string): OperChanges;
  /** Initial metres per canvas unit (default `deps.metresPerUnit`, else DEFAULT_METRES_PER_UNIT). */
  metresPerUnit?: number;
}

/** The radio link strategy plus the evaluation hooks the facade drives. */
export interface RadioLinkStrategy extends MediumStrategy {
  readonly kind: 'radio';
  /**
   * Radio rules of a link whose ends passed power/admin/err-disabled/cable/cut. Updates the per-link hold, MCS and
   * tuning caches and emits `rfState` on bars/rate changes. Undefined for an unknown link or ends without ports.
   */
  evaluate(id: LinkId, now: SimTime): RadioLinkVerdict | undefined;
  /** Forget a link's RF state (link down for a non-radio reason, or removed): cancels its hold. */
  clear(id: LinkId): void;
  /** Current metres per canvas unit. */
  metresPerUnit(): number;
}

interface RadioCache {
  wasUp: boolean;
  mcs?: number;
  bps?: number;
  holdSeq?: number;
  holdUntil?: SimTime;
  holdExpired: boolean;
  tuning?: P2PLegTuning;
  lastRf?: { bars: number; rateBps: number };
  band?: RfBand;
  channel?: number;
}

const HOLD_PREFIX = 'hold:';

/** Create the PtP radio link medium (§3.7). */
export function createRadioLink(host: MediumHost, options: RadioLinkOptions): RadioLinkStrategy {
  let scale = options.metresPerUnit ?? host.deps.metresPerUnit ?? DEFAULT_METRES_PER_UNIT;
  const caches = new Map<LinkId, RadioCache>();

  const p2p = createCableP2P(host, {
    kind: 'radio',
    linkOf: options.linkOf,
    tune: (state) => caches.get(state.id)?.tuning,
  });

  const cacheOf = (id: LinkId): RadioCache => {
    let c = caches.get(id);
    if (!c) {
      c = { wasUp: false, holdExpired: false };
      caches.set(id, c);
    }
    return c;
  };

  const cancelHold = (c: RadioCache): void => {
    if (c.holdSeq !== undefined) host.cancel(c.holdSeq);
    delete c.holdSeq;
    delete c.holdUntil;
    c.holdExpired = false;
  };

  const radioLinks = (): LinkState[] => {
    const out: LinkState[] = [];
    for (const id of options.links()) {
      const s = host.link(id);
      if (s && s.kind === 'radio') out.push(s);
    }
    return out;
  };

  /** Distance of a link in integer mm and where it came from. */
  const distanceOf = (state: LinkState): { mm: number; source: RadioLinkView['distanceSource'] } => {
    if (state.distanceOverrideM !== undefined) return { mm: Math.round(state.distanceOverrideM * 1000), source: 'override' };
    const pa = host.deps.position(state.a.device);
    const pb = host.deps.position(state.b.device);
    if (pa && pb) return { mm: canvasDistanceMm(pb.x - pa.x, pb.y - pa.y, scale), source: 'canvas' };
    // Without positions the link's own length is the only distance known: an explicit value, like an override.
    return { mm: Math.round(state.lengthM * 1000), source: 'override' };
  };

  const recomputeAll = (links: readonly LinkState[], now: SimTime, reason: string): OperChanges => {
    const changes: OperChanges = [];
    for (const s of links) changes.push(...options.recompute(s.id, now, reason));
    return changes;
  };

  const strategy: RadioLinkStrategy = {
    kind: 'radio',

    transmit: (from, pdu, now) => p2p.transmit(from, pdu, now),

    admit: (ev, now) => p2p.admit(ev, now),

    onTxComplete(port, now) {
      p2p.onTxComplete?.(port, now);
    },

    abort(scope, now, detail) {
      p2p.abort(scope, now, detail);
    },

    evaluate(id, now) {
      const state = host.link(id);
      if (!state) return undefined;
      const pa = host.port(state.a);
      const pb = host.port(state.b);
      if (!pa || !pb) return undefined;
      const c = cacheOf(id);
      const specA = pa.spec.radio;
      const specB = pb.spec.radio;
      const { mm, source } = distanceOf(state);
      if (!specA || !specB) {
        strategy.clear(id);
        const band: RfBand = specA?.defaultBand ?? specB?.defaultBand ?? '5';
        return {
          up: false,
          downReason: 'radio-band-mismatch',
          view: { distanceM: mmToMetres(mm), distanceSource: source, band, channel: 0, rssiDbm: 0, snrDb: 0, rateBps: 0, bars: 0 },
        };
      }
      const pairInput: RadioPairInput = { a: { spec: specA }, b: { spec: specB }, distanceMm: mm };
      const settingsA = host.deps.radioSettings(state.a);
      const settingsB = host.deps.radioSettings(state.b);
      if (settingsA) pairInput.a.settings = settingsA;
      if (settingsB) pairInput.b.settings = settingsB;
      if (c.mcs !== undefined) pairInput.currentMcs = c.mcs;
      const ev = evaluateRadioPair(pairInput);
      // Past the hard range cut-off (or with a configuration fault) the RF is not usable: RSSI/SNR stay for
      // diagnosis, but no rate or signal bars are reported.
      const usable = ev.withinRange && ev.config === undefined;
      const rfRate = usable ? ev.rf.rateBps : 0;
      const rfBars = usable ? ev.rf.bars : 0;
      const view: RadioLinkView = {
        distanceM: mmToMetres(mm),
        distanceSource: source,
        band: ev.a.band,
        channel: ev.a.channel,
        rssiDbm: ev.rf.rssiDbm,
        snrDb: ev.rf.snrDb,
        rateBps: rfRate,
        bars: rfBars,
      };

      if (ev.config !== undefined) {
        cancelHold(c);
        c.wasUp = false;
        delete c.mcs;
        delete c.bps;
        delete c.tuning;
        delete c.lastRf;
        return { up: false, downReason: ev.config, view };
      }

      c.band = ev.a.band;
      c.channel = ev.a.channel;
      if (c.lastRf === undefined || c.lastRf.bars !== rfBars || c.lastRf.rateBps !== rfRate) {
        c.lastRf = { bars: rfBars, rateBps: rfRate };
        host.emit({
          t: now, kind: 'rfState', port: { device: state.a.device, port: state.a.port }, peer: { device: state.b.device, port: state.b.port },
          rssiDbm: ev.rf.rssiDbm, snrDb: ev.rf.snrDb, rateBps: rfRate, bars: rfBars,
        });
      }

      let up: boolean;
      if (!c.wasUp) {
        up = ev.canConnect;
      } else if (c.holdUntil !== undefined) {
        if (ev.canConnect) {
          cancelHold(c);
          up = true;
        } else if (c.holdExpired) {
          cancelHold(c);
          up = false;
        } else {
          up = true;
        }
      } else if (ev.belowDrop) {
        c.holdUntil = now + RF.PTP_HOLD_NS;
        c.holdSeq = host.schedule(c.holdUntil, { kind: 'mediumTimer', medium: id, key: `${HOLD_PREFIX}${id}` });
        c.holdExpired = false;
        up = true;
      } else {
        up = true;
      }

      if (!up) {
        c.wasUp = false;
        delete c.mcs;
        delete c.bps;
        delete c.tuning;
        return { up: false, downReason: 'out-of-range', view: { ...view, rateBps: 0, bars: 0 } };
      }

      let bps = ev.rf.rateBps > 0 ? ev.rf.rateBps : (c.bps ?? Math.min(pa.spec.speedBps, pb.spec.speedBps));
      bps = Math.min(bps, pa.spec.speedBps, pb.spec.speedBps);
      const cap = state.impairments.bandwidthBps;
      if (cap !== undefined && cap < bps) bps = cap;
      c.wasUp = true;
      c.bps = bps;
      if (ev.rf.mcs !== undefined) c.mcs = ev.rf.mcs.mcs;
      else delete c.mcs;
      c.tuning = {
        perMille: ev.rf.perPermille,
        lengthM: mm / 1000,
        velocityFactor: 1.0,
        medium: 'radio',
        rateBps: bps,
        rssiDbm: ev.rf.rssiDbm,
      };
      const verdict: RadioLinkVerdict = { up: true, negotiatedBps: bps, view: { ...view, rateBps: bps } };
      if (c.holdUntil !== undefined) verdict.holdUntil = c.holdUntil;
      return verdict;
    },

    clear(id) {
      const c = caches.get(id);
      if (!c) return;
      cancelHold(c);
      caches.delete(id);
    },

    metresPerUnit: () => scale,

    onMediumTimer(_medium: MediumId, key: string, now: SimTime): OperChanges {
      if (!key.startsWith(HOLD_PREFIX)) return [];
      const id = key.slice(HOLD_PREFIX.length);
      const c = caches.get(id);
      if (!c || c.holdSeq === undefined || c.holdUntil === undefined || c.holdUntil > now) return [];
      delete c.holdSeq;
      c.holdExpired = true;
      return options.recompute(id, now, 'rf-hold-expired');
    },

    onPortChanged(ref: PortRef, now: SimTime, cause?: string): OperChanges {
      const id = host.port(ref)?.link ?? options.linkOf(ref);
      if (id === undefined || host.link(id)?.kind !== 'radio') return [];
      return options.recompute(id, now, cause ?? 'radio-config');
    },

    onDevicesMoved(devices: readonly DeviceId[], now: SimTime): OperChanges {
      const all = radioLinks();
      const moved = all.filter((s) => devices.includes(s.a.device) || devices.includes(s.b.device));
      const sets = moved.map((s) => {
        const c = caches.get(s.id);
        return c?.band === undefined ? undefined : { band: c.band, channel: c.channel };
      });
      const overlaps = (s: LinkState): boolean => {
        const c = caches.get(s.id);
        if (c?.band === undefined) return false;
        return sets.some((x) => x !== undefined && x.band === c.band && x.channel === c.channel);
      };
      const others = all.filter((s) => !moved.includes(s) && overlaps(s));
      return [...recomputeAll(moved, now, 'device-moved'), ...recomputeAll(others, now, 'device-moved')];
    },

    setScale(metresPerUnit: number, now: SimTime): OperChanges {
      if (!Number.isFinite(metresPerUnit) || metresPerUnit <= 0) throw new RangeError(`metresPerUnit must be > 0, got ${metresPerUnit}`);
      scale = metresPerUnit;
      return recomputeAll(radioLinks(), now, 'scale-changed');
    },
  };
  return strategy;
}
