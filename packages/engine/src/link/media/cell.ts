/**
 * link/media/cell.ts — CellularCell, the cellular medium (ARCHITECTURE-P1 D5, §3.8; contracts/medium.ts).
 *
 * A tower radio port (kind `cellular`, role `wireless-bss`) serves UE ports (kind `cellular`, role `cellular`) in
 * range. There is one cell per tower port, id `cell:<towerDevice>/<port>` (`cellId`).
 *
 * Attach (behavioural, no frames on the air; the UE's `cell-client` daemon is the only requester):
 *   1. `mediumOp cell-attach` from the UE → state `searching`; the best tower is picked: towers that are up, whose
 *      RF assessment meets the connect thresholds (lte table, cellular path loss) within both radios' `maxRangeM`
 *      and that have room (`maxClients`), sorted by decision RSSI desc, then tower device id (ordinal), then port.
 *   2. `attaching` plus `mediumTimer {medium: cell, key: 'attach:<ueKey>'}` at now + `RF.CELL_ATTACH_NS` (300 ms).
 *   3. On the timer the UE and tower state and RF are re-checked: success → `attached` (UE operUp, portState reason
 *      'associated', MediumEvent `cell-attached`, `assocState`, `rfState`); failure → `detached` with a reason and
 *      MediumEvent `cell-detached`.
 *   No tower at all → `detached` reason 'no-cell' and `cell-detached`; a further request that still finds no tower
 *   stays `detached` silently (the daemon's periodic `re-search` keeps asking).
 *   A request received while the UE radio is not ready (powered off, admin down) is remembered and the search starts
 *   when `onPortChanged` reports the UE ready; power-off forgets it (the daemon asks again after boot).
 *
 * Mobility: `onDevicesMoved` / `setScale` re-assess attached pairs (hysteresis on the MCS). Below the drop threshold
 * (cellular: SINR below the lowest lte threshold − `RF.SINR_DROP_MARGIN_MDB`) or beyond `maxRangeM`, a hold
 * `mediumTimer 'hold:<ueKey>'` runs for `RF.RF_HOLD_NS`; back at the connect threshold cancels it. When the hold
 * expires while still dropped → `detached` reason 'out-of-range', `cell-detached`, in-flight legs aborted.
 * `rfState` is emitted only when bars or rate change. A tower going down detaches its UEs with 'tower-down'.
 *
 * Data: Ethernet frames unchanged, contention free. Per leg:
 *   txStart = max(now, port.tx.busyUntil)
 *   txEnd   = txStart + serializationNs(size + CELL_PHY_OVERHEAD_BYTES, rate)
 *   arrive  = txEnd + propagationNs(distance, 1.0)
 * `rate` = min(lte MCS rate, both ports' speedBps). Randomness: exactly ONE loss draw per frame per UE leg on the
 * cached stream `cell:<cell>:<ueKey>` (uplink and downlink share the UE's stream), probability = PER permille.
 * Tower egress: unicast goes to the attached UE whose port MAC equals `ethernet.dst` (else `not-associated`); group
 * frames go to every attached UE of the cell except the one whose MAC equals `ethernet.src` (echo suppression, the
 * tower's radio is a hairpin bridge port), cloned per receiver when there is more than one (the original stays the
 * sender's identity). The tower port serializes once (busyUntil = the latest leg end, one txComplete).
 *
 * Operational state written here (link-model ownership): `operUp`, `speedBps`, `duplex`, `lastChange` and `phy`
 * (carrier = line protocol = attached for UEs, = radio up for towers; `phy.medium` 'cell').
 *
 * DETERMINISM: integer milli-dB RF (link/rf/*), explicit orderings, cached streams only; no Math.log10/pow/exp.
 */
import { isMulticastMac } from '../../contracts/addr.js';
import type { MacAddress } from '../../contracts/addr.js';
import type { PortRole } from '../../contracts/catalog.js';
import type { DeviceId, LinkId, PortRef } from '../../contracts/ids.js';
import { portKey } from '../../contracts/ids.js';
import type { ArrivalVerdict, OperChanges, TransmitRefusal, TransmitResult } from '../../contracts/link.js';
import type {
  AssociationSnapshot,
  CellAttachState,
  CellSnapshot,
  MediaSnapshot,
  MediumId,
  MediumOp,
} from '../../contracts/medium.js';
import type { Pdu } from '../../contracts/pdu.js';
import type { PortState } from '../../contracts/port.js';
import { MCS_TABLES, RF, radioModeOf } from '../../contracts/rf.js';
import type { RadioPortSpec } from '../../contracts/rf.js';
import type { SimTime } from '../../contracts/time.js';
import { propagationNs, serializationNs } from '../../contracts/time.js';
import type { TraceEvent } from '../../contracts/trace.js';
import { assessRfLink, mcsRateBps } from '../rf/mcs.js';
import type { Bars, RfAssessment, RfLinkEnd } from '../rf/mcs.js';
import { canvasDistanceMm, connectRssiMdb, mmToMetres, rangeMetres } from '../rf/pathloss.js';
import type { RadioEnd } from '../rf/pathloss.js';
import { captureLinkTypeOf, summarizePdu } from './p2p.js';
import type { FrameArrivalBody, InflightLeg, MediumHost, MediumStrategy } from './types.js';
import { cellId, compareOrdinal } from './types.js';

/** Bytes added to every cellular frame for serialization timing (radio framing of the simulated air). */
export const CELL_PHY_OVERHEAD_BYTES = 8;

/** Canvas scale used when neither the options nor the link-model deps give one (metres per canvas unit). */
export const DEFAULT_METRES_PER_UNIT = 0.25;

/** Nominal handset radio used to draw a tower's range ring (`CellSnapshot.rangeM`). */
export const CELL_NOMINAL_UE: RadioEnd = Object.freeze({ txPowerDbm: 23, antennaGainDbi: 0 });

/** Medium id reported on `assocState` events of a search that found no tower. */
export const CELL_NO_TOWER_MEDIUM: MediumId = 'cell:none';

/** Reasons carried by `cell-detached` notifications, `assocState` events and association snapshots. */
export const CELL_DETACH_REASONS = Object.freeze({
  /** No tower in range accepted the UE. */
  noCell: 'no-cell',
  /** The RF hold expired below the drop threshold. */
  outOfRange: 'out-of-range',
  /** The serving tower's radio went down (power, shutdown, removal). */
  towerDown: 'tower-down',
  /** The chosen tower reached its client limit before the attach completed. */
  cellFull: 'cell-full',
  /** The UE device was powered off. */
  powerOff: 'power-off',
  /** The UE radio was shut down. */
  adminDown: 'admin-down',
  /** The UE's daemon asked to detach without a reason. */
  released: 'released',
});

/** Original drop detail for data offered by a UE that is not attached. */
export const CELL_NOT_ATTACHED_DETAIL = 'The cellular adapter is not attached to a cell.';

/** Original drop detail for a tower unicast frame whose destination is not an attached device. */
export const CELL_UNKNOWN_UE_DETAIL = 'No device attached to this cell uses that destination address.';

/** Original drop detail for a frame without an Ethernet header on the cellular air. */
export const CELL_NOT_ETHERNET_DETAIL = 'The cellular air carries Ethernet frames only.';

/** Original drop detail for a frame offered to a radio that is not operating. */
export const CELL_RADIO_DOWN_DETAIL = 'The cellular radio is not operating.';

/** Timer key of the attach delay of a UE port. */
export function cellAttachKey(ue: PortRef): string {
  return `attach:${portKey(ue)}`;
}

/** Timer key of the RF hold of a UE port. */
export function cellHoldKey(ue: PortRef): string {
  return `hold:${portKey(ue)}`;
}

/** Association id of a UE on a cell: `${medium}|${portKey(ue)}` (contracts/medium.ts). */
export function cellAssociationId(medium: MediumId, ue: PortRef): string {
  return `${medium}|${portKey(ue)}`;
}

/** Rng stream label of a UE on a cell: one loss draw per frame. */
export function cellStreamLabel(medium: MediumId, ue: PortRef): string {
  return `cell:${medium}:${portKey(ue)}`;
}

/** Construction options of the cellular medium. */
export interface CellularCellOptions {
  /**
   * Every port of kind `cellular` in the world (towers and UEs), in device-creation then port order. The facade
   * keeps this list; every ordering of the medium that is not an explicit sort follows it.
   */
  radios(): readonly PortRef[];
  /** Effective role when neither `PortState.role` nor `PortSpec.role` is set (hand-built fixtures). */
  roleOf?(ref: PortRef, port: PortState): PortRole | undefined;
  /** Initial metres per canvas unit (default `deps.metresPerUnit`, else `DEFAULT_METRES_PER_UNIT`). */
  metresPerUnit?: number;
}

/** Read-only view of one UE's attachment (radio port views, air views, tests). */
export interface CellAttachmentView {
  ue: PortRef;
  state: CellAttachState;
  /** Serving (or last) tower. */
  tower?: PortRef;
  medium?: MediumId;
  rssiDbm: number;
  snrDb: number;
  rateBps: number;
  bars: Bars;
  distanceM: number;
  since: SimTime;
  holdUntil?: SimTime;
  reason?: string;
  /** A search was requested and is remembered until the UE radio is ready. */
  wanted: boolean;
}

/** The cellular medium strategy, with read-only views for snapshots and daemons. */
export interface CellularCellStrategy extends MediumStrategy {
  readonly kind: 'cell';
  onMediumTimer(medium: MediumId, key: string, now: SimTime): OperChanges;
  onPortChanged(ref: PortRef, now: SimTime, cause?: string): OperChanges;
  mediumOp(from: PortRef, op: MediumOp, now: SimTime): OperChanges;
  onDevicesMoved(devices: readonly DeviceId[], now: SimTime): OperChanges;
  setScale(metresPerUnit: number, now: SimTime): OperChanges;
  contribute(now: SimTime, into: MediaSnapshot): void;
  /** Attachment of a UE port, or undefined when the medium never saw it. */
  attachment(ue: PortRef): CellAttachmentView | undefined;
  /** A tower radio is operating (device up, admin up, not err-disabled). */
  towerUp(tower: PortRef): boolean;
  /** Current metres per canvas unit. */
  metresPerUnit(): number;
}

/** Mutable per-UE record. */
interface UeRecord {
  readonly ref: PortRef;
  readonly key: string;
  state: CellAttachState;
  wanted: boolean;
  tower?: PortRef;
  medium?: MediumId;
  since: SimTime;
  reason?: string;
  rf?: RfAssessment;
  distanceMm: number;
  attachSeq?: number;
  holdSeq?: number;
  holdUntil?: SimTime;
  /** Last values reported by `rfState`. */
  lastBars?: Bars;
  lastRate?: number;
}

/** Result of assessing one UE ↔ tower pair. */
interface PairAssessment {
  rf: RfAssessment;
  distanceMm: number;
  /** Connect thresholds met within both range cut-offs. */
  inRange: boolean;
  /** Below the drop threshold or beyond a range cut-off. */
  dropped: boolean;
  /** Usable data rate: min(MCS rate, both ports' speed). */
  rateBps: number;
}

const samePort = (a: PortRef | undefined, b: PortRef): boolean => a !== undefined && a.device === b.device && a.port === b.port;

/** Create the cellular medium strategy (one instance serves every cell of the world). */
export function createCellularCell(host: MediumHost, options: CellularCellOptions): CellularCellStrategy {
  const ues = new Map<string, UeRecord>();
  let scale = options.metresPerUnit ?? host.deps.metresPerUnit ?? DEFAULT_METRES_PER_UNIT;

  // ── port classification ────────────────────────────────────────────────────

  const roleOf = (ref: PortRef, port: PortState): PortRole | undefined => port.role ?? port.spec.role ?? options.roleOf?.(ref, port);
  const modeOf = (ref: PortRef, port: PortState | undefined): 'tower' | 'ue' | undefined => {
    if (!port) return undefined;
    const role = roleOf(ref, port);
    if (role === undefined) return undefined;
    const mode = radioModeOf(port.spec.kind, role);
    return mode === 'tower' || mode === 'ue' ? mode : undefined;
  };
  const radioReady = (ref: PortRef, port: PortState | undefined): port is PortState =>
    port !== undefined && port.spec.radio !== undefined && host.deviceUp(ref.device) && port.adminUp && port.errDisabled === undefined;
  const towerReady = (ref: PortRef): boolean => {
    const port = host.port(ref);
    return modeOf(ref, port) === 'tower' && radioReady(ref, port);
  };
  const ueReady = (ref: PortRef): boolean => {
    const port = host.port(ref);
    return modeOf(ref, port) === 'ue' && radioReady(ref, port);
  };

  const radioIndex = (): Map<string, number> => {
    const index = new Map<string, number>();
    options.radios().forEach((r, i) => index.set(portKey(r), i));
    return index;
  };

  const record = (ref: PortRef): UeRecord => {
    const key = portKey(ref);
    let rec = ues.get(key);
    if (!rec) {
      rec = { ref: { device: ref.device, port: ref.port }, key, state: 'idle', wanted: false, since: 0, distanceMm: 0 };
      ues.set(key, rec);
    }
    return rec;
  };

  // ── RF ─────────────────────────────────────────────────────────────────────

  const endOf = (ref: PortRef, radio: RadioPortSpec): RfLinkEnd => ({
    txPowerDbm: host.deps.radioSettings(ref)?.txPowerDbm ?? radio.maxTxPowerDbm,
    antennaGainDbi: radio.antennaGainDbi,
    generations: radio.generations,
    streams: radio.streams,
  });

  const distanceMm = (a: DeviceId, b: DeviceId): number => {
    if (a === b) return 0;
    const pa = host.deps.position(a);
    const pb = host.deps.position(b);
    if (!pa || !pb) return 0;
    return canvasDistanceMm(pb.x - pa.x, pb.y - pa.y, scale);
  };

  const assess = (ue: PortRef, tower: PortRef, currentMcs: number | undefined): PairAssessment | undefined => {
    const up = host.port(ue);
    const tp = host.port(tower);
    const ur = up?.spec.radio;
    const tr = tp?.spec.radio;
    if (!up || !tp || !ur || !tr) return undefined;
    const mm = distanceMm(ue.device, tower.device);
    const input = { band: 'cell' as const, cls: 'cell' as const, widthMhz: 20 as const, distanceMm: mm, a: endOf(tower, tr), b: endOf(ue, ur) };
    const rf = assessRfLink(currentMcs === undefined ? input : { ...input, currentMcs });
    const limitMm = Math.min(ur.maxRangeM, tr.maxRangeM) * 1000;
    const beyond = mm > limitMm;
    const rateBps = rf.rateBps === 0 ? 0 : Math.min(rf.rateBps, up.spec.speedBps, tp.spec.speedBps);
    return { rf, distanceMm: mm, inRange: rf.canConnect && !beyond && rateBps > 0, dropped: rf.belowDrop || beyond || rateBps === 0, rateBps };
  };

  const attachedCount = (tower: PortRef): number => {
    let n = 0;
    for (const rec of ues.values()) if (rec.state === 'attached' && samePort(rec.tower, tower)) n++;
    return n;
  };

  const hasRoom = (tower: PortRef): boolean => {
    const limit = host.port(tower)?.spec.radio?.maxClients;
    return limit === undefined || attachedCount(tower) < limit;
  };

  /** Best tower for a UE (§3.8 step 2), or undefined. */
  const bestTower = (ue: PortRef): { tower: PortRef; pair: PairAssessment } | undefined => {
    const found: { tower: PortRef; pair: PairAssessment; index: number }[] = [];
    options.radios().forEach((ref, index) => {
      if (!towerReady(ref) || !hasRoom(ref)) return;
      const pair = assess(ue, ref, undefined);
      if (pair?.inRange) found.push({ tower: ref, pair, index });
    });
    found.sort((x, y) => y.pair.rf.rssiMdb - x.pair.rf.rssiMdb || compareOrdinal(x.tower.device, y.tower.device) || x.index - y.index);
    const best = found[0];
    return best ? { tower: best.tower, pair: best.pair } : undefined;
  };

  // ── trace helpers ──────────────────────────────────────────────────────────

  const emitAssoc = (rec: UeRecord, prev: CellAttachState, now: SimTime, reason?: string): void => {
    const ev: Extract<TraceEvent, { kind: 'assocState' }> = {
      t: now, kind: 'assocState', tech: 'cellular', medium: rec.medium ?? CELL_NO_TOWER_MEDIUM, station: rec.ref, state: rec.state, prev,
    };
    if (rec.tower) ev.ap = rec.tower;
    if (reason !== undefined) ev.reason = reason;
    if (rec.rf && rec.tower) ev.rssiDbm = rec.rf.rssiDbm;
    host.emit(ev);
  };

  /** Lowest lte rate (one stream): the serialization rate of a pair whose SINR selects no MCS (during an RF hold). */
  const floorRateBps = (): number => {
    const lowest = MCS_TABLES.lte[0];
    return lowest === undefined ? 1 : mcsRateBps(lowest, 20, 1);
  };

  const rateOf = (rec: UeRecord): number => {
    if (!rec.rf || !rec.tower) return 0;
    const up = host.port(rec.ref);
    const tp = host.port(rec.tower);
    if (!up || !tp) return 0;
    const phy = rec.rf.rateBps === 0 ? floorRateBps() : rec.rf.rateBps;
    return Math.min(phy, up.spec.speedBps, tp.spec.speedBps);
  };

  const emitRfState = (rec: UeRecord, now: SimTime, force: boolean): void => {
    if (!rec.rf || !rec.tower) return;
    const rate = rateOf(rec);
    if (!force && rec.lastBars === rec.rf.bars && rec.lastRate === rate) return;
    rec.lastBars = rec.rf.bars;
    rec.lastRate = rate;
    host.emit({ t: now, kind: 'rfState', port: rec.ref, peer: rec.tower, rssiDbm: rec.rf.rssiDbm, snrDb: rec.rf.snrDb, rateBps: rate, bars: rec.rf.bars });
  };

  /** Write a radio port's operational state; emits portState when operUp changes. Returns whether it changed. */
  const writeOper = (ref: PortRef, up: boolean, rateBps: number, now: SimTime, reason: string): boolean => {
    const port = host.port(ref);
    if (!port) return false;
    const changed = port.operUp !== up;
    port.operUp = up;
    port.phy = { carrier: up, lineProtocol: up, medium: 'cell' };
    if (up) {
      port.speedBps = rateBps;
      port.duplex = 'full';
    } else {
      delete port.speedBps;
      delete port.duplex;
    }
    if (changed) {
      port.lastChange = now;
      host.emit({ t: now, kind: 'portState', device: ref.device, port: ref.port, adminUp: port.adminUp, operUp: up, reason });
    }
    return changed;
  };

  const cancelTimers = (rec: UeRecord): void => {
    if (rec.attachSeq !== undefined) host.cancel(rec.attachSeq);
    if (rec.holdSeq !== undefined) host.cancel(rec.holdSeq);
    delete rec.attachSeq;
    delete rec.holdSeq;
    delete rec.holdUntil;
  };

  /** Abort the in-flight legs of `rec` (to or from its UE) on its cell. */
  const abortUe = (rec: UeRecord, now: SimTime, reason: 'out-of-range' | 'link-down'): void => {
    const medium = rec.medium;
    if (medium === undefined) return;
    for (const leg of host.inflight.on(medium)) {
      if (!samePort(leg.from, rec.ref) && !samePort(leg.to, rec.ref)) continue;
      host.inflight.delete(leg.pdu.id, leg.link, leg.to);
      if (leg.arrivalSeq === undefined) continue;
      host.cancel(leg.arrivalSeq);
      host.emit({
        t: now, kind: 'drop', pdu: leg.pdu, link: medium, reason, detail: rec.reason ?? reason, medium, association: cellAssociationId(medium, rec.ref),
      });
      host.emit({ t: now, kind: 'frameAbort', pdu: leg.pdu, link: medium, from: leg.from, to: leg.to, abortAt: now, arrive: leg.arrive, reason });
    }
  };

  /** Leave `attaching`/`attached`/`searching`/`detached` for `next`. */
  const detach = (rec: UeRecord, now: SimTime, reason: string, next: 'detached' | 'idle', notify: boolean): OperChanges => {
    cancelTimers(rec);
    const prev = rec.state;
    rec.reason = reason;
    abortUe(rec, now, reason === CELL_DETACH_REASONS.outOfRange ? 'out-of-range' : 'link-down');
    rec.state = next;
    rec.since = now;
    delete rec.lastBars;
    delete rec.lastRate;
    const changed = writeOper(rec.ref, false, 0, now, 'disassociated');
    if (prev !== next) emitAssoc(rec, prev, now, reason);
    if (next === 'idle') {
      delete rec.tower;
      delete rec.medium;
      delete rec.rf;
    }
    if (notify) host.notify(rec.ref, { kind: 'cell-detached', reason }, now);
    return changed ? [{ port: rec.ref, operUp: false }] : [];
  };

  // ── attach state machine ───────────────────────────────────────────────────

  const startSearch = (rec: UeRecord, now: SimTime): OperChanges => {
    if (!ueReady(rec.ref)) return [];
    if (rec.state === 'searching' || rec.state === 'attaching' || rec.state === 'attached') return [];
    const best = bestTower(rec.ref);
    const prev = rec.state;
    if (!best) {
      if (prev === 'detached') return [];
      rec.state = 'searching';
      rec.since = now;
      delete rec.reason;
      emitAssoc(rec, prev, now);
      rec.state = 'detached';
      rec.reason = CELL_DETACH_REASONS.noCell;
      emitAssoc(rec, 'searching', now, CELL_DETACH_REASONS.noCell);
      host.notify(rec.ref, { kind: 'cell-detached', reason: CELL_DETACH_REASONS.noCell }, now);
      return [];
    }
    rec.tower = best.tower;
    rec.medium = cellId(best.tower);
    rec.rf = best.pair.rf;
    rec.distanceMm = best.pair.distanceMm;
    delete rec.reason;
    rec.state = 'searching';
    rec.since = now;
    emitAssoc(rec, prev, now);
    rec.state = 'attaching';
    emitAssoc(rec, 'searching', now);
    rec.attachSeq = host.schedule(now + RF.CELL_ATTACH_NS, { kind: 'mediumTimer', medium: rec.medium, key: cellAttachKey(rec.ref) });
    return [];
  };

  const completeAttach = (rec: UeRecord, now: SimTime): OperChanges => {
    delete rec.attachSeq;
    if (rec.state !== 'attaching' || !rec.tower) return [];
    if (!ueReady(rec.ref)) {
      return detach(rec, now, host.deviceUp(rec.ref.device) ? CELL_DETACH_REASONS.adminDown : CELL_DETACH_REASONS.powerOff, 'idle', false);
    }
    if (!towerReady(rec.tower)) return detach(rec, now, CELL_DETACH_REASONS.towerDown, 'detached', true);
    const pair = assess(rec.ref, rec.tower, undefined);
    if (!pair?.inRange) {
      if (pair) {
        rec.rf = pair.rf;
        rec.distanceMm = pair.distanceMm;
      }
      return detach(rec, now, CELL_DETACH_REASONS.outOfRange, 'detached', true);
    }
    if (!hasRoom(rec.tower)) return detach(rec, now, CELL_DETACH_REASONS.cellFull, 'detached', true);
    rec.rf = pair.rf;
    rec.distanceMm = pair.distanceMm;
    rec.state = 'attached';
    rec.since = now;
    const changed = writeOper(rec.ref, true, pair.rateBps, now, 'associated');
    emitAssoc(rec, 'attaching', now);
    emitRfState(rec, now, true);
    host.notify(rec.ref, { kind: 'cell-attached', tower: rec.tower }, now);
    return changed ? [{ port: rec.ref, operUp: true }] : [];
  };

  /** Re-assess an attached UE after a move, a scale change or a radio change (hold rules). */
  const reassess = (rec: UeRecord, now: SimTime): OperChanges => {
    if (rec.state !== 'attached' || !rec.tower) return [];
    if (!towerReady(rec.tower)) return detach(rec, now, CELL_DETACH_REASONS.towerDown, 'detached', true);
    const pair = assess(rec.ref, rec.tower, rec.rf?.mcs?.mcs);
    if (!pair) return detach(rec, now, CELL_DETACH_REASONS.towerDown, 'detached', true);
    rec.rf = pair.rf;
    rec.distanceMm = pair.distanceMm;
    const port = host.port(rec.ref);
    if (port && pair.rateBps > 0) port.speedBps = pair.rateBps;
    if (pair.dropped) {
      if (rec.holdSeq === undefined && rec.medium !== undefined) {
        rec.holdUntil = now + RF.RF_HOLD_NS;
        rec.holdSeq = host.schedule(rec.holdUntil, { kind: 'mediumTimer', medium: rec.medium, key: cellHoldKey(rec.ref) });
      }
    } else if (pair.inRange && rec.holdSeq !== undefined) {
      host.cancel(rec.holdSeq);
      delete rec.holdSeq;
      delete rec.holdUntil;
    }
    emitRfState(rec, now, false);
    return [];
  };

  const holdExpired = (rec: UeRecord, now: SimTime): OperChanges => {
    delete rec.holdSeq;
    delete rec.holdUntil;
    if (rec.state !== 'attached' || !rec.tower) return [];
    if (!towerReady(rec.tower)) return detach(rec, now, CELL_DETACH_REASONS.towerDown, 'detached', true);
    const pair = assess(rec.ref, rec.tower, rec.rf?.mcs?.mcs);
    if (!pair || pair.dropped) {
      if (pair) {
        rec.rf = pair.rf;
        rec.distanceMm = pair.distanceMm;
      }
      return detach(rec, now, CELL_DETACH_REASONS.outOfRange, 'detached', true);
    }
    rec.rf = pair.rf;
    rec.distanceMm = pair.distanceMm;
    emitRfState(rec, now, false);
    return [];
  };

  /** Attached records touching `devices` (or all when undefined), by medium id then station order. */
  const affected = (devices: ReadonlySet<DeviceId> | undefined): UeRecord[] => {
    const index = radioIndex();
    const out: UeRecord[] = [];
    for (const rec of ues.values()) {
      if (rec.state !== 'attached' || !rec.tower) continue;
      if (devices && !devices.has(rec.ref.device) && !devices.has(rec.tower.device)) continue;
      out.push(rec);
    }
    out.sort((x, y) => compareOrdinal(x.medium ?? '', y.medium ?? '') || (index.get(x.key) ?? 0) - (index.get(y.key) ?? 0) || compareOrdinal(x.key, y.key));
    return out;
  };

  // ── transmit ───────────────────────────────────────────────────────────────

  const refuse = (pdu: Pdu, from: PortRef, now: SimTime, reason: TransmitRefusal, detail: string, medium?: MediumId, association?: string): TransmitResult => {
    const drop: Extract<TraceEvent, { kind: 'drop' }> = { t: now, kind: 'drop', pdu: summarizePdu(pdu), device: from.device, port: from.port, reason, detail };
    if (medium !== undefined) drop.medium = medium;
    if (association !== undefined) drop.association = association;
    host.emit(drop);
    return { ok: false, reason };
  };

  interface LegPlan {
    from: PortRef;
    to: PortRef;
    rec: UeRecord;
  }

  const sendLegs = (sender: PortState, from: PortRef, medium: MediumId, pdu: Pdu, legs: readonly LegPlan[], now: SimTime): TransmitResult => {
    const txStart = Math.max(now, sender.tx.busyUntil);
    host.capture({ t: txStart, dir: 'tx', port: { device: from.device, port: from.port }, pdu, linkType: captureLinkTypeOf(pdu) });
    host.inflight.sweep(now);
    let txEndMax = txStart;
    let arriveMax = txStart;
    let lostAll = legs.length > 0;
    // More than one receiver: every leg carries its own clone and the original stays the sender's identity. Without a
    // factory in the deps (hand-built harnesses) the legs share the original.
    const fanOut = legs.length > 1 && host.deps.pdus !== undefined;
    legs.forEach((plan) => {
      const rate = Math.max(1, rateOf(plan.rec));
      const leg = fanOut && host.deps.pdus ? host.deps.pdus.clone(pdu, now) : pdu;
      const txEnd = txStart + serializationNs(leg.size + CELL_PHY_OVERHEAD_BYTES, rate);
      const arrive = txEnd + propagationNs(mmToMetres(plan.rec.distanceMm), 1.0);
      const association = cellAssociationId(medium, plan.rec.ref);
      const per = plan.rec.rf?.perPermille ?? 1000;
      // Exactly one loss draw per frame per UE leg.
      const lost = host.stream(cellStreamLabel(medium, plan.rec.ref)).chance(per / 1000);
      const summary = summarizePdu(leg);
      let arrivalSeq: number | undefined;
      if (lost) {
        host.emit({ t: now, kind: 'drop', pdu: summary, link: medium, reason: 'link-loss', detail: `packet error rate ${per} per mille`, medium, association });
      } else {
        lostAll = false;
        arrivalSeq = host.schedule(arrive, { kind: 'frameArrival', device: plan.to.device, port: plan.to.port, pdu: leg, medium });
      }
      const tx: Extract<TraceEvent, { kind: 'frameTx' }> = {
        t: now, kind: 'frameTx', pdu: summary, link: medium, from: plan.from, to: plan.to, txStart, txEnd, arrive, medium: 'cell', rateBps: rate,
      };
      if (plan.rec.rf) tx.rssiDbm = plan.rec.rf.rssiDbm;
      if (pdu.meta.background === true) tx.background = true;
      host.emit(tx);
      const inflight: InflightLeg = { pdu: summary, link: medium, from: plan.from, to: plan.to, txStart, txEnd, arrive, medium: 'cell', rateBps: rate };
      if (pdu.meta.background === true) inflight.background = true;
      if (arrivalSeq !== undefined) inflight.arrivalSeq = arrivalSeq;
      host.inflight.add(inflight);
      txEndMax = Math.max(txEndMax, txEnd);
      arriveMax = Math.max(arriveMax, arrive);
    });
    if (legs.length > 0) {
      sender.tx.busyUntil = txEndMax;
      sender.tx.queue++;
      host.schedule(txEndMax, { kind: 'txComplete', device: from.device, port: from.port });
    }
    const result: Extract<TransmitResult, { ok: true }> = { ok: true, link: medium, txStart, txEnd: txEndMax, arrive: arriveMax };
    if (lostAll) result.lost = true;
    return result;
  };

  const transmitFromUe = (from: PortRef, port: PortState, pdu: Pdu, now: SimTime): TransmitResult => {
    if (!radioReady(from, port)) return refuse(pdu, from, now, 'link-down', CELL_RADIO_DOWN_DETAIL);
    const rec = ues.get(portKey(from));
    if (!rec || rec.state !== 'attached' || !rec.tower || rec.medium === undefined) {
      return refuse(pdu, from, now, 'not-associated', CELL_NOT_ATTACHED_DETAIL, rec?.medium, rec?.medium === undefined ? undefined : cellAssociationId(rec.medium, from));
    }
    if (!towerReady(rec.tower)) return refuse(pdu, from, now, 'link-down', CELL_RADIO_DOWN_DETAIL, rec.medium);
    return sendLegs(port, from, rec.medium, pdu, [{ from: rec.ref, to: rec.tower, rec }], now);
  };

  const transmitFromTower = (from: PortRef, port: PortState, pdu: Pdu, now: SimTime): TransmitResult => {
    const medium = cellId(from);
    if (!towerReady(from)) return refuse(pdu, from, now, 'link-down', CELL_RADIO_DOWN_DETAIL, medium);
    const outer = pdu.layers[0];
    const dst = outer?.proto === 'ethernet' ? outer.fields.dst : undefined;
    const src = outer?.proto === 'ethernet' ? outer.fields.src : undefined;
    if (typeof dst !== 'string') return refuse(pdu, from, now, 'encapsulation-mismatch', CELL_NOT_ETHERNET_DETAIL, medium);
    const attached: UeRecord[] = [];
    for (const ref of options.radios()) {
      const rec = ues.get(portKey(ref));
      if (rec && rec.state === 'attached' && samePort(rec.tower, from)) attached.push(rec);
    }
    const macOf = (rec: UeRecord): MacAddress | undefined => host.port(rec.ref)?.mac;
    let targets: UeRecord[];
    if (isMulticastMac(dst)) {
      targets = attached.filter((rec) => typeof src !== 'string' || macOf(rec) !== src);
    } else {
      targets = attached.filter((rec) => macOf(rec) === dst);
      if (targets.length === 0) return refuse(pdu, from, now, 'not-associated', CELL_UNKNOWN_UE_DETAIL, medium);
    }
    return sendLegs(port, from, medium, pdu, targets.map((rec) => ({ from, to: rec.ref, rec })), now);
  };

  // ── strategy ───────────────────────────────────────────────────────────────

  const strategy: CellularCellStrategy = {
    kind: 'cell',

    transmit(from, pdu, now): TransmitResult {
      const port = host.port(from);
      const mode = modeOf(from, port);
      if (!port || mode === undefined) return refuse(pdu, from, now, 'link-down', CELL_RADIO_DOWN_DETAIL);
      return mode === 'ue' ? transmitFromUe(from, port, pdu, now) : transmitFromTower(from, port, pdu, now);
    },

    admit(ev: FrameArrivalBody, now: SimTime): ArrivalVerdict {
      const to: PortRef = { device: ev.device, port: ev.port };
      const leg = host.inflight.remove(ev.pdu.id, to);
      const toMode = modeOf(to, host.port(to));
      const medium = ev.medium ?? (toMode === 'tower' ? cellId(to) : undefined);
      // Uplink: the sender is the leg's origin; when the leg is gone (pruned or aborted) it is the UE of this cell
      // whose port MAC is the frame's Ethernet source (unattached senders fail the check below).
      let ueRef: PortRef | undefined = toMode === 'ue' ? to : leg?.from;
      let unknownSender = false;
      if (ueRef === undefined && toMode === 'tower') {
        const outer = ev.pdu.layers[0];
        const src = outer?.proto === 'ethernet' ? outer.fields.src : undefined;
        for (const rec of ues.values()) {
          if (rec.medium === medium && typeof src === 'string' && host.port(rec.ref)?.mac === src) {
            ueRef = rec.ref;
            break;
          }
        }
        unknownSender = ueRef === undefined;
      }
      if (ueRef !== undefined || unknownSender) {
        const rec = ueRef === undefined ? undefined : ues.get(portKey(ueRef));
        if (!rec || rec.state !== 'attached' || (medium !== undefined && rec.medium !== medium)) {
          const drop: Extract<TraceEvent, { kind: 'drop' }> = {
            t: now, kind: 'drop', pdu: summarizePdu(ev.pdu), device: to.device, port: to.port, reason: 'not-associated', detail: CELL_NOT_ATTACHED_DETAIL,
          };
          if (medium !== undefined) {
            drop.medium = medium;
            if (ueRef !== undefined) drop.association = cellAssociationId(medium, ueRef);
          }
          host.emit(drop);
          return { deliver: false };
        }
      }
      host.capture({ t: now, dir: 'rx', port: to, pdu: ev.pdu, linkType: captureLinkTypeOf(ev.pdu) });
      return { deliver: true, pdu: ev.pdu, rx: { medium: 'cell' } };
    },

    onTxComplete(ref: PortRef, _now: SimTime): void {
      const p = host.port(ref);
      if (p && p.tx.queue > 0) p.tx.queue--;
    },

    onMediumTimer(_medium: MediumId, key: string, now: SimTime): OperChanges {
      const sep = key.indexOf(':');
      if (sep < 0) return [];
      const kind = key.slice(0, sep);
      const rec = ues.get(key.slice(sep + 1));
      if (!rec) return [];
      if (kind === 'attach') return completeAttach(rec, now);
      if (kind === 'hold') return holdExpired(rec, now);
      return [];
    },

    onPortChanged(ref: PortRef, now: SimTime, _cause?: string): OperChanges {
      const port = host.port(ref);
      const mode = modeOf(ref, port);
      const key = portKey(ref);
      if (mode === 'tower' || (mode === undefined && port === undefined && !ues.has(key))) {
        const up = towerReady(ref);
        const changes: OperChanges = [];
        if (port && writeOper(ref, up, up ? port.spec.speedBps : 0, now, up ? 'radio-up' : 'radio-down')) changes.push({ port: ref, operUp: up });
        for (const rec of affected(undefined)) {
          if (!samePort(rec.tower, ref)) continue;
          changes.push(...(up ? reassess(rec, now) : detach(rec, now, CELL_DETACH_REASONS.towerDown, 'detached', true)));
        }
        for (const rec of ues.values()) {
          if (rec.state === 'attaching' && samePort(rec.tower, ref) && !up) changes.push(...detach(rec, now, CELL_DETACH_REASONS.towerDown, 'detached', true));
        }
        if (!up) strategy.abort(cellId(ref), now, CELL_DETACH_REASONS.towerDown);
        return changes;
      }
      const rec = ues.get(key) ?? (mode === 'ue' ? record(ref) : undefined);
      if (!rec) return [];
      if (!ueReady(ref)) {
        const powered = port !== undefined && host.deviceUp(ref.device);
        if (!powered) rec.wanted = false;
        if (rec.state === 'idle') return [];
        return detach(rec, now, powered ? CELL_DETACH_REASONS.adminDown : CELL_DETACH_REASONS.powerOff, 'idle', false);
      }
      if (rec.state === 'attached') return reassess(rec, now);
      if (rec.wanted && (rec.state === 'idle' || rec.state === 'detached')) return startSearch(rec, now);
      return [];
    },

    mediumOp(from: PortRef, op: MediumOp, now: SimTime): OperChanges {
      if (op.op === 'cell-attach') {
        if (modeOf(from, host.port(from)) !== 'ue') return [];
        const rec = record(from);
        rec.wanted = true;
        return startSearch(rec, now);
      }
      if (op.op === 'cell-detach') {
        const rec = ues.get(portKey(from));
        if (!rec) return [];
        rec.wanted = false;
        if (rec.state === 'idle') return [];
        return detach(rec, now, op.reason ?? CELL_DETACH_REASONS.released, 'idle', false);
      }
      return [];
    },

    onDevicesMoved(devices: readonly DeviceId[], now: SimTime): OperChanges {
      const moved = new Set(devices);
      const changes: OperChanges = [];
      for (const rec of affected(moved)) changes.push(...reassess(rec, now));
      return changes;
    },

    setScale(metresPerUnit: number, now: SimTime): OperChanges {
      if (!Number.isFinite(metresPerUnit) || metresPerUnit <= 0) return [];
      scale = metresPerUnit;
      const changes: OperChanges = [];
      for (const rec of affected(undefined)) changes.push(...reassess(rec, now));
      return changes;
    },

    abort(scope: LinkId | MediumId, now: SimTime, detail?: string): void {
      for (const leg of host.inflight.on(scope)) {
        host.inflight.delete(leg.pdu.id, leg.link, leg.to);
        if (leg.arrivalSeq === undefined) continue;
        host.cancel(leg.arrivalSeq);
        const drop: Extract<TraceEvent, { kind: 'drop' }> = { t: now, kind: 'drop', pdu: leg.pdu, link: scope, reason: 'link-down', medium: scope };
        if (detail !== undefined) drop.detail = detail;
        host.emit(drop);
        host.emit({ t: now, kind: 'frameAbort', pdu: leg.pdu, link: scope, from: leg.from, to: leg.to, abortAt: now, arrive: leg.arrive, reason: 'link-down' });
      }
    },

    contribute(_now: SimTime, into: MediaSnapshot): void {
      const index = radioIndex();
      const connect = connectRssiMdb('cell', MCS_TABLES.lte[0]?.minSinrMdb ?? 0);
      for (const ref of options.radios()) {
        const port = host.port(ref);
        const radio = port?.spec.radio;
        if (modeOf(ref, port) !== 'tower' || !radio) continue;
        const tower: RadioEnd = { txPowerDbm: host.deps.radioSettings(ref)?.txPowerDbm ?? radio.maxTxPowerDbm, antennaGainDbi: radio.antennaGainDbi };
        const cell: CellSnapshot = {
          id: cellId(ref),
          tower: { device: ref.device, port: ref.port },
          up: towerReady(ref),
          ues: attachedCount(ref),
          rangeM: rangeMetres(tower, CELL_NOMINAL_UE, 'cell', 'cell', connect, radio.maxRangeM),
        };
        into.cells.push(cell);
      }
      const shown: UeRecord[] = [];
      for (const rec of ues.values()) if (rec.state !== 'idle' && rec.tower && rec.medium !== undefined) shown.push(rec);
      shown.sort((x, y) => compareOrdinal(x.medium ?? '', y.medium ?? '') || (index.get(x.key) ?? 0) - (index.get(y.key) ?? 0) || compareOrdinal(x.key, y.key));
      for (const rec of shown) {
        const medium = rec.medium as MediumId;
        const tower = rec.tower as PortRef;
        const assoc: AssociationSnapshot = {
          id: cellAssociationId(medium, rec.ref),
          tech: 'cellular',
          medium,
          ap: { device: tower.device, port: tower.port },
          station: { device: rec.ref.device, port: rec.ref.port },
          band: 'cell',
          channel: 0,
          state: rec.state,
          authorized: rec.state === 'attached',
          rssiDbm: rec.rf?.rssiDbm ?? 0,
          snrDb: rec.rf?.snrDb ?? 0,
          rateBps: rec.state === 'attached' ? rateOf(rec) : 0,
          bars: rec.rf?.bars ?? 0,
          distanceM: mmToMetres(rec.distanceMm),
          since: rec.since,
        };
        if (rec.holdUntil !== undefined) assoc.holdUntil = rec.holdUntil;
        if (rec.reason !== undefined) assoc.reason = rec.reason;
        into.associations.push(assoc);
      }
    },

    attachment(ue: PortRef): CellAttachmentView | undefined {
      const rec = ues.get(portKey(ue));
      if (!rec) return undefined;
      const view: CellAttachmentView = {
        ue: { device: rec.ref.device, port: rec.ref.port },
        state: rec.state,
        rssiDbm: rec.rf?.rssiDbm ?? 0,
        snrDb: rec.rf?.snrDb ?? 0,
        rateBps: rec.state === 'attached' ? rateOf(rec) : 0,
        bars: rec.rf?.bars ?? 0,
        distanceM: mmToMetres(rec.distanceMm),
        since: rec.since,
        wanted: rec.wanted,
      };
      if (rec.tower) view.tower = { device: rec.tower.device, port: rec.tower.port };
      if (rec.medium !== undefined) view.medium = rec.medium;
      if (rec.holdUntil !== undefined) view.holdUntil = rec.holdUntil;
      if (rec.reason !== undefined) view.reason = rec.reason;
      return view;
    },

    towerUp(tower: PortRef): boolean {
      return towerReady(tower);
    },

    metresPerUnit(): number {
      return scale;
    },
  };
  return strategy;
}
