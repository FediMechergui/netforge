/**
 * link/link.ts — the link model facade (ARCHITECTURE-P1 D4–D6, §3.4–§3.9; contracts/link.ts `LinkModel`).
 *
 * The facade owns cabling (link records, the port → link index, cuts), the recompute of every cable and PtP radio
 * link, and the shared services every medium strategy receives through a `MediumHost`: cached rng streams, the
 * in-flight registry keyed (pdu, link|medium, to), trace emission, the capture tap and an ordered notification
 * outbox. Frames are carried by the strategies under link/media/:
 *   CableP2P (p2p.ts) · SharedSegment (segment.ts) · RadioLink (radio.ts) · WirelessBss (air.ts) · CellularCell (cell.ts)
 *
 * ROUTING of a port (`routeMedium`, in order): wlan with an air role → air; cellular with a tower/UE role → cell;
 * the port's link has kind 'radio' → radio; the port is a member of a collision domain → segment; otherwise cable.
 * `transmit` and `onTxComplete` follow it. `admit` routes by the arrival's `medium` ('seg:' / 'bss:' / 'cell:'),
 * otherwise by the destination port's link kind. `onMediumTimer` routes by the medium id prefix; a bare link id is a
 * PtP radio hold.
 *
 * RECOMPUTE of one cable or radio link, check order (§3.4):
 *   1 power-off:a|b → 2 admin-down:a|b → 3 err-disabled:a|b → 4 cable check (cabling.ts, including too-long at the
 *   negotiated speed) → 5 cut → 6 speed-mismatch (negotiation.ts, cables whose two ends negotiate) → 7 radio rules
 *   (radio.ts `evaluate`) → 8 serial line protocol (serial.ts: no-clock, encapsulation-mismatch, per-end keepalive
 *   latch) → 9 up.
 * Writes `LinkState` (up, downReason, negotiatedBps, carrier when it differs from up, resolvedDceEnd on serial media,
 * phy for a non-plain negotiation, radio) and both ports' operUp/speedBps/duplex/lastChange/phy.
 * Emits, in order: `linkState` (up changed), `phyNegotiated` (a non-plain result changed), `portState` per port whose
 * operUp or carrier changed (`carrier` present only when it differs from operUp), `segmentChanged` (domain rebuild,
 * run when the cable joins or was in a collision domain). Carrier changes are then notified to the ports' processes
 * as MediumEvent `carrier`. A link that stops carrying data in both directions has its in-flight legs aborted first.
 *
 * P0 STABILITY: a plain cable (both ends autonegotiated full duplex) emits no `phyNegotiated`, carries no
 * `LinkState.phy` and no `carrier` field, and uses the P0 numbers and the P0 five draws on `link:<id>`, so P0 traces
 * are byte-identical. `phyNegotiated` and `LinkState.phy` appear only for parallel-detected, forced or half-duplex
 * results (hubs in P0.5; config-driven negotiation in P1 §4.9: each end's `portSettings` speed/duplex feed
 * negotiation.ts). A duplex mismatch is published as `LinkState.phy.mismatch`, `phyNegotiated.mismatch` and
 * `PortPhy.duplexMismatch` on both ends, and puts the cable into a collision domain. When a non-plain result returns
 * to plain autonegotiation (e.g. `speed auto` + `duplex auto` again), one `phyNegotiated` with the plain views
 * announces it and `LinkState.phy` is removed.
 *
 * FAULTS: `collisionStorm` / `stopCollisionStorm` drive the segment's jam-burst fault (§4.9 Faults, rng `fault:<id>`).
 *
 * NOTIFICATIONS: every public method runs inside a re-entrancy guard. Medium events raised during the call are queued
 * and delivered through `deps.notify` in order once the outermost call has finished its state changes, so a daemon
 * reacting synchronously (notify → device → daemon → `mediumOp`) always sees a consistent model; nested calls made
 * while the queue is being delivered append to the same queue.
 *
 * Field ownership: this module (with the strategies it hosts) is the only writer of `PortState.tx`, `operUp` of
 * non-virtual ports, `speedBps`, `duplex`, `link`, `lastChange` and `phy`.
 */
import type { DeviceId, LinkId, PortId, PortRef } from '../contracts/ids.js';
import { portKey } from '../contracts/ids.js';
import type { PortRole } from '../contracts/catalog.js';
import { defaultRoleFor } from '../contracts/catalog.js';
import type {
  ArrivalVerdict,
  CableValidation,
  Impairments,
  LinkKind,
  LinkModel,
  LinkModelDeps,
  LinkState,
  MediaType,
  OperChanges,
  PhyEndView,
  PortPhy,
  TransmitResult,
} from '../contracts/link.js';
import { NO_IMPAIRMENTS, linkKindOf } from '../contracts/link.js';
import type { AirView, MediaSnapshot, MediumEvent, MediumKind, MediumOp } from '../contracts/medium.js';
import type { Pdu } from '../contracts/pdu.js';
import type { PortState } from '../contracts/port.js';
import type { RadioLinkView, RadioPortView } from '../contracts/rf.js';
import { MCS_TABLES, radioModeOf } from '../contracts/rf.js';
import type { Rng } from '../contracts/rng.js';
import type { SimTime } from '../contracts/time.js';
import { assertSimTime } from '../contracts/time.js';
import { DEFAULT_METRES_PER_UNIT } from '../contracts/topology.js';
import type { PduSummary, TraceEvent } from '../contracts/trace.js';
import {
  autoMediaForKind,
  cableEndOf,
  checkCable,
  resolveMedia,
  type CableCheck,
  type CableCheckOptions,
  type PortSpecLike,
  type ResolvedMedia,
} from './cabling.js';
import { clearScope, createInflightRegistry } from './inflight.js';
import { createAirMedium } from './media/air.js';
import { CELL_NOMINAL_UE, createCellularCell } from './media/cell.js';
import { createCableP2P, summarizePdu } from './media/p2p.js';
import { createRadioLink, effectiveRadio } from './media/radio.js';
import { createSharedSegment, type CollisionStormParams } from './media/segment.js';
import type { FrameArrivalBody, MediumHost, MediumRouteInput, MediumStrategy } from './media/types.js';
import { cellId, routeMedium } from './media/types.js';
import { negotiate, negotiatesPhy, samePhyResult, type NegotiationEnd, type NegotiationResult } from './negotiation.js';
import { connectRssiMdb, rangeMetres } from './rf/pathloss.js';
import {
  createKeepaliveLatches,
  effectiveEncap,
  evaluateSerialLine,
  isSerialMedia,
  resolveDceEnd,
  serialCarrierDown,
  type SerialEndInput,
  type SerialLinkResult,
} from './serial.js';

/** The link model plus the hooks the Simulation uses beyond the contract (faults, snapshots, device removal). */
export interface LinkModelImpl extends LinkModel {
  /**
   * Mark the cable as cut (`on = true`) or repaired. A cut link is down with
   * `downReason: 'cut'`; recompute runs immediately and the changed ports are returned
   * (the Simulation fans `onPortOper` out to them). Unknown link → `undefined`.
   */
  cut(id: LinkId, on: boolean, now: SimTime): OperChanges | undefined;
  /** Whether the cable of `id` is currently cut. */
  isCut(id: LinkId): boolean;
  /** Test-only: number of entries in the internal in-flight registry (lost frames included). */
  __flyingSize(): number;
  /**
   * Radio part of a port snapshot (`PortSnapshot.radio`): Wi-Fi radios from the air medium, towers and UEs from the
   * cellular medium, PtP radios from their link. Undefined for ports without radio data.
   */
  radioPortView(ref: PortRef): RadioPortView | undefined;
  /**
   * Forget the radios of a removed device: tears down its Wi-Fi associations and cellular attachments and notifies
   * the peers. Call after the device's links were removed and `deps.port` no longer returns its ports. Returns the
   * oper changes of OTHER devices' ports.
   */
  forgetDevice(device: DeviceId, now: SimTime): OperChanges;
  /** Current metres per canvas unit. */
  metresPerUnit(): number;
  /**
   * Start a collision-storm fault (FaultSpec kind 'collision-storm', §4.9): the segment port `target` emits jam bursts
   * drawn from rng `fault:<faultId>` for `params.durationNs`. Restarting an id replaces that storm. Returns false when
   * the target is not a member of a collision domain. Throws RangeError on invalid parameters.
   */
  collisionStorm(faultId: string, target: PortRef, params: CollisionStormParams, now: SimTime): boolean;
  /** Stop a running collision storm early; false when none has this id. */
  stopCollisionStorm(faultId: string, now: SimTime): boolean;
}

/** Internal per-link record. */
interface LinkRecord {
  readonly state: LinkState;
  cut: boolean;
  /** At least one direction could carry data after the last recompute (abort trigger on the way down). */
  flowing: boolean;
}

/** Result of writing one port during a recompute. */
interface PortWrite {
  operChanged: boolean;
  carrierChanged: boolean;
}

/** Clamp `pct` to 0..100 and reject NaN. */
function checkPct(name: string, v: number): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 100) {
    throw new RangeError(`impairments.${name} must be between 0 and 100, got ${v}`);
  }
  return v;
}

/** Validate a full `Impairments` object; throws RangeError on out-of-range values. */
function normalizeImpairments(imp: Partial<Impairments> | undefined): Impairments {
  const merged: Impairments = { ...NO_IMPAIRMENTS, ...(imp ?? {}) };
  checkPct('lossPct', merged.lossPct);
  checkPct('corruptPct', merged.corruptPct);
  assertSimTime(merged.latencyNs, 'impairments.latencyNs');
  assertSimTime(merged.jitterNs, 'impairments.jitterNs');
  if (merged.bandwidthBps === undefined) {
    delete merged.bandwidthBps;
  } else if (typeof merged.bandwidthBps !== 'number' || !Number.isFinite(merged.bandwidthBps) || merged.bandwidthBps <= 0) {
    throw new RangeError(`impairments.bandwidthBps must be > 0, got ${merged.bandwidthBps}`);
  }
  return merged;
}

/** Compact trace description of a PDU (undefined optionals are omitted). */
export function summarize(pdu: Pdu): PduSummary {
  return summarizePdu(pdu);
}

/**
 * A negotiation result that a P0 cable also produces: both ends autonegotiated to full duplex with no mismatch.
 * Plain results are not published as `phyNegotiated` or `LinkState.phy` (P0 stability, file header).
 */
export function isPlainPhy(phy: { a: PhyEndView; b: PhyEndView; mismatch?: 'duplex' }): boolean {
  const plain = (e: PhyEndView): boolean => e.autoneg && e.via === 'autoneg' && e.duplex === 'full';
  return phy.mismatch === undefined && plain(phy.a) && plain(phy.b);
}

/** Structured-clone-safe copy of a LinkState (impairments, phy and radio views copied too). */
function copyState(s: LinkState): LinkState {
  const out: LinkState = {
    id: s.id,
    a: { device: s.a.device, port: s.a.port },
    b: { device: s.b.device, port: s.b.port },
    media: s.media,
    lengthM: s.lengthM,
    impairments: { ...s.impairments },
    up: s.up,
    resolvedMedia: s.resolvedMedia,
  };
  if (s.downReason !== undefined) out.downReason = s.downReason;
  if (s.negotiatedBps !== undefined) out.negotiatedBps = s.negotiatedBps;
  if (s.kind !== undefined) out.kind = s.kind;
  if (s.dceEnd !== undefined) out.dceEnd = s.dceEnd;
  if (s.distanceOverrideM !== undefined) out.distanceOverrideM = s.distanceOverrideM;
  if (s.carrier !== undefined) out.carrier = s.carrier;
  if (s.resolvedDceEnd !== undefined) out.resolvedDceEnd = s.resolvedDceEnd;
  if (s.phy !== undefined) {
    const phy: NonNullable<LinkState['phy']> = { a: { ...s.phy.a }, b: { ...s.phy.b } };
    if (s.phy.mismatch !== undefined) phy.mismatch = s.phy.mismatch;
    out.phy = phy;
  }
  if (s.segment !== undefined) out.segment = s.segment;
  if (s.radio !== undefined) out.radio = { ...s.radio };
  return out;
}

/** Effective kind of a link: `LinkState.kind`, else the media rule. */
function kindOf(state: LinkState): LinkKind {
  return state.kind ?? linkKindOf(state.resolvedMedia);
}

/** Effective role of a port: runtime role, else spec role, else the catalog default for its kind. */
function roleOf(p: PortState): PortRole {
  return p.role ?? p.spec.role ?? defaultRoleFor(p.spec.kind, []);
}

/**
 * Create the link model for one simulation. See the file header for routing, recompute order, emission order and the
 * notification rules; every method follows the `LinkModel` contract.
 */
export function createLinkModel(deps: LinkModelDeps): LinkModelImpl {
  const { scheduler, trace } = deps;
  /** Links in creation order (Map insertion order is deterministic). */
  const links = new Map<LinkId, LinkRecord>();
  /** portKey → link id. */
  const byPort = new Map<string, LinkId>();
  /** Frame legs on the wires and in the air, keyed (pdu, link|medium, to). */
  const inflight = createInflightRegistry();
  /** rng sub-streams, created once per label for the life of the model (never re-split). */
  const streams = new Map<string, Rng>();
  /** Serial keepalive latches (per reporting port). */
  const latches = createKeepaliveLatches();
  let scale = deps.metresPerUnit ?? DEFAULT_METRES_PER_UNIT;

  // ── device/port registry used when the deps do not enumerate devices ──
  const seenDevices: DeviceId[] = [];
  const seenPorts = new Map<DeviceId, PortId[]>();
  /** Cellular ports the model has listed or been told about (device removal). */
  const cellularSeen = new Map<string, PortRef>();

  const touch = (ref: PortRef): void => {
    let list = seenPorts.get(ref.device);
    if (list === undefined) {
      list = [];
      seenPorts.set(ref.device, list);
      seenDevices.push(ref.device);
    }
    if (!list.includes(ref.port)) list.push(ref.port);
  };
  const deviceList = (): readonly DeviceId[] => deps.devices?.() ?? seenDevices;
  const portsOf = (id: DeviceId): readonly PortId[] => deps.devicePorts?.(id) ?? seenPorts.get(id) ?? [];
  const deviceOrder = (id: DeviceId): number => {
    const i = deviceList().indexOf(id);
    return i < 0 ? Number.MAX_SAFE_INTEGER : i;
  };

  // ── notification outbox and re-entrancy guard ──
  const outbox: { ref: PortRef; ev: MediumEvent; now: SimTime }[] = [];
  let depth = 0;
  let flushing = false;
  const flush = (): void => {
    if (flushing) return;
    flushing = true;
    try {
      while (outbox.length > 0) {
        const item = outbox.shift() as { ref: PortRef; ev: MediumEvent; now: SimTime };
        deps.notify(item.ref, item.ev, item.now);
      }
    } finally {
      flushing = false;
    }
  };
  const run = <T>(fn: () => T): T => {
    depth++;
    try {
      return fn();
    } finally {
      depth--;
      if (depth === 0) flush();
    }
  };
  const notify = (ref: PortRef, ev: MediumEvent, now: SimTime): void => {
    outbox.push({ ref: { device: ref.device, port: ref.port }, ev, now });
    if (depth === 0) flush();
  };

  const emit = (ev: TraceEvent): void => trace.emit(ev);

  const host: MediumHost = {
    deps,
    inflight,
    port: (ref) => deps.port(ref),
    deviceUp: (id) => deps.deviceUp(id),
    link: (id) => links.get(id)?.state,
    stream(label) {
      let s = streams.get(label);
      if (!s) {
        s = deps.rng.split(label);
        streams.set(label, s);
      }
      return s;
    },
    emit,
    schedule: (at, body) => scheduler.schedule(at, body),
    cancel: (seq) => scheduler.cancel(seq),
    txOutcome(ref, outcome, now) {
      deps.onTxOutcome(ref, outcome, now);
    },
    notify,
    capture(ev) {
      const tap = deps.capture;
      if (tap !== undefined && tap.wants(ev.port)) tap.record(ev);
    },
  };

  const linkOf = (ref: PortRef): LinkId | undefined => byPort.get(portKey(ref));
  const roleOfRef = (ref: PortRef): PortRole | undefined => {
    const p = deps.port(ref);
    return p === undefined ? undefined : roleOf(p);
  };

  /** Every cellular port in device-creation then port order (the cellular medium's radio list). */
  const cellRadios = (): PortRef[] => {
    const out: PortRef[] = [];
    for (const device of deviceList()) {
      for (const port of portsOf(device)) {
        const ref: PortRef = { device, port };
        if (deps.port(ref)?.spec.kind !== 'cellular') continue;
        out.push(ref);
        cellularSeen.set(portKey(ref), ref);
      }
    }
    return out;
  };

  const cable = createCableP2P(host, { linkOf });
  const segment = createSharedSegment(host, {
    links: () => [...links.keys()],
    deviceOrder,
    devicePorts: portsOf,
    roleOf: roleOfRef,
    linkOf,
  });
  const radio = createRadioLink(host, {
    linkOf,
    links: () => [...links.keys()],
    recompute: (id, now, reason) => recomputeLink(id, now, reason),
    metresPerUnit: scale,
  });
  const air = createAirMedium(host);
  const cell = createCellularCell(host, { radios: cellRadios, roleOf: (_ref, port) => roleOf(port), metresPerUnit: scale });

  const strategyOf = (kind: MediumKind): MediumStrategy => {
    switch (kind) {
      case 'segment':
        return segment;
      case 'radio':
        return radio;
      case 'air':
        return air;
      case 'cell':
        return cell;
      case 'cable':
        return cable;
    }
  };

  /** Medium that carries traffic for a port (file header routing). */
  const mediumFor = (ref: PortRef): MediumKind => {
    const p = deps.port(ref);
    if (p === undefined) return 'cable';
    const input: MediumRouteInput = { kind: p.spec.kind, role: roleOf(p) };
    const id = p.link ?? byPort.get(portKey(ref));
    const state = id === undefined ? undefined : links.get(id)?.state;
    if (state !== undefined) input.linkKind = kindOf(state);
    if (segment.segmentOfPort(ref) !== undefined) input.inSegment = true;
    return routeMedium(input);
  };

  // ── cable validation ──

  /** Cable-validator view of a port, or undefined when the device is unknown / powered off. */
  const specOf = (ref: PortRef): PortSpecLike | undefined => {
    const p = deps.port(ref);
    if (!p) return undefined;
    const opts: { role: PortRole; transceiver?: NonNullable<ReturnType<LinkModelDeps['transceiver']>>; label: string; device: string; hostTerminal?: boolean } = {
      role: p.role,
      label: `${ref.device} ${ref.port}`,
      device: ref.device,
    };
    const optics = deps.transceiver(ref);
    if (optics !== undefined) opts.transceiver = optics;
    if (deps.hostTerminal(ref.device) === true) opts.hostTerminal = true;
    return cableEndOf(p.spec, opts);
  };

  /** Concrete media for a link whose ends may be unavailable. */
  const fallbackMedia = (a: PortRef, b: PortRef, media: MediaType): ResolvedMedia => {
    if (media !== 'auto') return media;
    const sa = specOf(a);
    const sb = specOf(b);
    if (sa && sb) return resolveMedia(sa, sb, media);
    const kind = sa?.kind ?? sb?.kind;
    return kind === undefined ? 'copper-straight' : autoMediaForKind(kind);
  };

  /**
   * Run the cable checks for two ends. A same-device loop is flagged first; an end whose
   * port is unavailable (device powered off / unknown) is reported as `ok:false` because its
   * port type cannot be checked. `recompute` only gets here with both ports present, since
   * availability is derived before validation.
   */
  const check = (a: PortRef, b: PortRef, media: MediaType, lengthM: number, opts: CableCheckOptions = {}): CableCheck => {
    if (a.device === b.device) {
      const same = a.port === b.port ? `${a.device} ${a.port} to itself` : `${a.device} ${a.port} to ${b.device} ${b.port}`;
      return {
        ok: false,
        code: 'same-device',
        reason: `A cable cannot link ${same}: both ends are on the same device.`,
        resolvedMedia: fallbackMedia(a, b, media),
      };
    }
    const sa = specOf(a);
    const sb = specOf(b);
    if (!sa || !sb) {
      const missing = !sa ? a : b;
      return {
        ok: false,
        code: 'media-mismatch',
        reason: `${missing.device} is powered off or unknown, so the type of port ${missing.port} cannot be checked yet.`,
        resolvedMedia: fallbackMedia(a, b, media),
      };
    }
    return checkCable(sa, sb, media, lengthM, opts);
  };

  // ── recompute ──

  const negotiationEnd = (ref: PortRef, p: PortState): NegotiationEnd => {
    const end: NegotiationEnd = { kind: p.spec.kind, role: roleOf(p), speedBps: p.spec.speedBps, label: `${ref.device} ${ref.port}` };
    if (p.spec.speeds !== undefined) end.speeds = p.spec.speeds;
    if (p.spec.duplexModes !== undefined) end.duplexModes = p.spec.duplexModes;
    if (p.spec.autoneg !== undefined) end.autoneg = p.spec.autoneg;
    const optics = deps.transceiver(ref);
    if (optics !== undefined) end.transceiverBps = optics.speedBps;
    const settings = deps.portSettings(ref);
    if (settings !== undefined) end.settings = settings;
    return end;
  };

  const serialEnd = (ref: PortRef, p: PortState): SerialEndInput => {
    const end: SerialEndInput = { speedBps: p.spec.speedBps, encap: effectiveEncap(p), keepaliveLatched: latches.isLatched(ref) };
    const settings = deps.portSettings(ref);
    if (settings !== undefined) end.settings = settings;
    if (p.spec.clockSource === true) end.clockSource = true;
    return end;
  };

  /** Write one port's derived state; reports what changed. */
  const writePort = (p: PortState, operUp: boolean, phy: PortPhy, bps: number | undefined, now: SimTime): PortWrite => {
    const prevOper = p.operUp;
    const prevCarrier = p.phy?.carrier ?? p.operUp;
    p.operUp = operUp;
    if (operUp && bps !== undefined) {
      p.speedBps = bps;
      p.duplex = phy.end?.duplex ?? 'full';
    } else {
      delete p.speedBps;
      delete p.duplex;
    }
    p.phy = phy;
    const out: PortWrite = { operChanged: prevOper !== operUp, carrierChanged: prevCarrier !== phy.carrier };
    if (out.operChanged || out.carrierChanged) p.lastChange = now;
    return out;
  };

  /** Abort the legs of a link that stopped carrying data, through the medium that put them on it. */
  const abortLink = (id: LinkId, state: LinkState, inSegment: boolean, now: SimTime, detail: string | undefined): void => {
    if (inSegment) segment.abort(id, now, detail);
    else if (kindOf(state) === 'radio') radio.abort(id, now, detail);
    else cable.abort(id, now, detail);
  };

  const recomputeLink = (id: LinkId, now: SimTime, reason?: string): OperChanges => {
    const rec = links.get(id);
    if (!rec) return [];
    const { state } = rec;
    const pa = deps.port(state.a);
    const pb = deps.port(state.b);
    const wasUp = state.up;
    const wasFlowing = rec.flowing;
    const wasSegment = state.segment;
    const prevPhy = state.phy;

    let downReason: string | undefined;
    let carrier = false;
    let bps: number | undefined;
    let nego: Extract<NegotiationResult, { ok: true }> | undefined;
    let serial: SerialLinkResult | undefined;
    let radioView: RadioLinkView | undefined;

    if (!pa || !deps.deviceUp(state.a.device)) downReason = 'power-off:a';
    else if (!pb || !deps.deviceUp(state.b.device)) downReason = 'power-off:b';
    else if (!pa.adminUp) downReason = 'admin-down:a';
    else if (!pb.adminUp) downReason = 'admin-down:b';
    else if (pa.errDisabled) downReason = 'err-disabled:a';
    else if (pb.errDisabled) downReason = 'err-disabled:b';
    else {
      const negotiation = state.kind !== 'radio' && negotiatesPhy(pa.spec.kind, pb.spec.kind)
        ? negotiate(negotiationEnd(state.a, pa), negotiationEnd(state.b, pb))
        : undefined;
      const opts: CableCheckOptions = {};
      if (state.kind !== undefined) opts.kind = state.kind;
      if (negotiation?.ok === true) opts.negotiatedBps = negotiation.bps;
      const v = check(state.a, state.b, state.media, state.lengthM, opts);
      if (v.resolvedMedia !== undefined) state.resolvedMedia = v.resolvedMedia;
      if (!v.ok) downReason = v.code ?? 'media-mismatch';
      else if (rec.cut) downReason = 'cut';
      else if (negotiation !== undefined && !negotiation.ok) downReason = negotiation.code;
      else if (kindOf(state) === 'radio') {
        const verdict = radio.evaluate(id, now);
        if (verdict === undefined) {
          downReason = 'out-of-range';
        } else {
          radioView = verdict.view;
          if (verdict.up) {
            carrier = true;
            bps = verdict.negotiatedBps;
          } else {
            downReason = verdict.downReason ?? 'out-of-range';
          }
        }
      } else if (isSerialMedia(state.resolvedMedia) && pa.spec.kind === 'serial' && pb.spec.kind === 'serial') {
        carrier = true;
        const input = {
          a: serialEnd(state.a, pa),
          b: serialEnd(state.b, pb),
          dceEnd: resolveDceEnd(state, state.resolvedMedia, pa.spec, pb.spec),
        } as Parameters<typeof evaluateSerialLine>[0];
        if (state.impairments.bandwidthBps !== undefined) input.bandwidthBps = state.impairments.bandwidthBps;
        serial = evaluateSerialLine(input);
        if (serial.downReason !== undefined) downReason = serial.downReason;
        bps = serial.negotiatedBps;
      } else {
        carrier = true;
        bps = negotiation?.ok === true ? negotiation.bps : Math.min(pa.spec.speedBps, pb.spec.speedBps);
        const cap = state.impairments.bandwidthBps;
        if (cap !== undefined && cap < bps) bps = cap;
        if (negotiation?.ok === true) nego = negotiation;
      }
    }

    if (!carrier) latches.clearLink(state.a, state.b);
    if (kindOf(state) === 'radio' && radioView === undefined) {
      radio.clear(id);
      delete state.radio;
    } else if (radioView !== undefined) {
      state.radio = radioView;
    }

    const serialMedia = isSerialMedia(state.resolvedMedia);
    const dceEnd = serialMedia ? resolveDceEnd(state, state.resolvedMedia, pa?.spec, pb?.spec) : undefined;
    const up = serial ? serial.up : downReason === undefined;
    const operA = serial ? serial.operUp.a : up;
    const operB = serial ? serial.operUp.b : up;

    state.up = up;
    if (downReason === undefined) delete state.downReason;
    else state.downReason = downReason;
    if (bps === undefined) delete state.negotiatedBps;
    else state.negotiatedBps = bps;
    if (carrier !== up) state.carrier = carrier;
    else delete state.carrier;
    if (dceEnd !== undefined) state.resolvedDceEnd = dceEnd;
    else delete state.resolvedDceEnd;
    let linkPhy: NonNullable<LinkState['phy']> | undefined;
    if (nego !== undefined && !isPlainPhy(nego)) {
      linkPhy = { a: { ...nego.a }, b: { ...nego.b } };
      if (nego.mismatch !== undefined) linkPhy.mismatch = nego.mismatch;
    }
    if (linkPhy !== undefined) state.phy = linkPhy;
    else delete state.phy;

    const medium: MediumKind = kindOf(state) === 'radio' ? 'radio' : 'cable';
    const phyFor = (end: 'a' | 'b'): PortPhy => {
      let phy: PortPhy;
      if (serial) phy = { ...serial[end] };
      else if (serialMedia && dceEnd !== undefined) phy = { ...serialCarrierDown(dceEnd)[end] };
      else phy = { carrier, lineProtocol: carrier };
      if (nego !== undefined && carrier) {
        phy.end = { ...nego[end] };
        if (nego.mismatch === 'duplex') phy.duplexMismatch = true;
      }
      phy.medium = medium;
      return phy;
    };
    const writeA = pa ? writePort(pa, operA, phyFor('a'), bps, now) : undefined;
    const writeB = pb ? writePort(pb, operB, phyFor('b'), bps, now) : undefined;

    const flowing = carrier && (operA || operB);
    rec.flowing = flowing;
    if (wasFlowing && !flowing) abortLink(id, state, wasSegment !== undefined, now, downReason);

    if (wasUp !== up) {
      const ev: TraceEvent = { t: now, kind: 'linkState', link: id, up };
      if (reason !== undefined) ev.reason = reason;
      else if (downReason !== undefined) ev.reason = downReason;
      emit(ev);
    }
    if (linkPhy !== undefined && !samePhyResult(prevPhy, linkPhy)) {
      const ev: Extract<TraceEvent, { kind: 'phyNegotiated' }> = { t: now, kind: 'phyNegotiated', link: id, a: { ...linkPhy.a }, b: { ...linkPhy.b } };
      if (linkPhy.mismatch !== undefined) ev.mismatch = linkPhy.mismatch;
      emit(ev);
    } else if (linkPhy === undefined && prevPhy !== undefined && nego !== undefined) {
      // A non-plain result (forced, parallel-detected, half duplex, mismatch) went back to plain autonegotiation.
      emit({ t: now, kind: 'phyNegotiated', link: id, a: { ...nego.a }, b: { ...nego.b } });
    }

    const changes: OperChanges = [];
    const portEvents: [PortRef, PortState, PortWrite][] = [];
    if (pa && writeA) portEvents.push([state.a, pa, writeA]);
    if (pb && writeB) portEvents.push([state.b, pb, writeB]);
    for (const [ref, p, w] of portEvents) {
      if (!w.operChanged && !w.carrierChanged) continue;
      if (w.operChanged) changes.push({ port: { device: ref.device, port: ref.port }, operUp: p.operUp });
      const ev: TraceEvent = { t: now, kind: 'portState', device: ref.device, port: ref.port, adminUp: p.adminUp, operUp: p.operUp };
      const lineReason = p.phy?.carrier === true && !p.operUp ? p.phy.lineProtocolReason : undefined;
      const why = reason ?? lineReason ?? downReason;
      if (why !== undefined) ev.reason = why;
      if (p.phy !== undefined && p.phy.carrier !== p.operUp) ev.carrier = p.phy.carrier;
      emit(ev);
    }

    const joins = carrier && (nego?.shared === true || (pa !== undefined && roleOf(pa) === 'repeater') || (pb !== undefined && roleOf(pb) === 'repeater'));
    if (wasSegment !== undefined || joins) {
      segment.rebuild(now);
      if (state.segment !== undefined) {
        for (const p of [pa, pb]) if (p?.phy !== undefined) p.phy.medium = 'segment';
      }
    }

    for (const [ref, p, w] of portEvents) {
      if (w.carrierChanged && p.phy !== undefined) notify(ref, { kind: 'carrier', up: p.phy.carrier }, now);
    }
    return changes;
  };

  const peerRef = (state: LinkState, ref: PortRef): PortRef =>
    ref.device === state.a.device && ref.port === state.a.port ? state.b : state.a;

  // ── radio port views ──

  const radioPortView = (ref: PortRef): RadioPortView | undefined => {
    const p = deps.port(ref);
    const spec = p?.spec.radio;
    if (p === undefined || spec === undefined) return undefined;
    const mode = radioModeOf(p.spec.kind, roleOf(p));
    if (mode === undefined) return undefined;
    if (mode === 'ap' || mode === 'station') return air.radioPortView(ref);
    const settings = deps.radioSettings(ref);
    if (mode === 'ptp') {
      const eff = effectiveRadio(spec, settings);
      const end = { txPowerDbm: eff.txPowerDbm, antennaGainDbi: spec.antennaGainDbi };
      const out: RadioPortView = {
        mode,
        band: eff.band,
        channel: eff.channel,
        widthMhz: eff.widthMhz,
        txPowerDbm: eff.txPowerDbm,
        up: p.operUp,
        rangeM: rangeMetres(end, end, eff.band, 'ptp', connectRssiMdb('ptp', 0), spec.maxRangeM),
      };
      const id = p.link ?? byPort.get(portKey(ref));
      const state = id === undefined ? undefined : links.get(id)?.state;
      if (state !== undefined) {
        out.peer = { ...peerRef(state, ref) };
        if (state.radio !== undefined) {
          out.rssiDbm = state.radio.rssiDbm;
          out.snrDb = state.radio.snrDb;
          out.rateBps = state.radio.rateBps;
          out.bars = state.radio.bars;
        }
      }
      return out;
    }
    cellularSeen.set(portKey(ref), { device: ref.device, port: ref.port });
    const txPowerDbm = Math.min(settings?.txPowerDbm ?? spec.maxTxPowerDbm, spec.maxTxPowerDbm);
    const end = { txPowerDbm, antennaGainDbi: spec.antennaGainDbi };
    const connect = connectRssiMdb('cell', MCS_TABLES.lte[0]?.minSinrMdb ?? 0);
    if (mode === 'tower') {
      const into: MediaSnapshot = { metresPerUnit: scale, segments: [], bss: [], cells: [], associations: [] };
      cell.contribute(scheduler.now, into);
      const snap = into.cells.find((c) => c.id === cellId(ref));
      return {
        mode,
        band: 'cell',
        channel: spec.defaultChannel,
        widthMhz: 20,
        txPowerDbm,
        up: cell.towerUp(ref),
        clients: snap?.ues ?? 0,
        rangeM: rangeMetres(end, CELL_NOMINAL_UE, 'cell', 'cell', connect, spec.maxRangeM),
      };
    }
    const att = cell.attachment(ref);
    const out: RadioPortView = {
      mode,
      band: 'cell',
      channel: spec.defaultChannel,
      widthMhz: 20,
      txPowerDbm,
      up: p.operUp,
      state: att?.state ?? 'idle',
      rangeM: rangeMetres(end, end, 'cell', 'cell', connect, spec.maxRangeM),
    };
    if (att?.tower !== undefined) {
      out.peer = { ...att.tower };
      out.rssiDbm = att.rssiDbm;
      out.snrDb = att.snrDb;
      out.rateBps = att.rateBps;
      out.bars = att.bars;
    }
    return out;
  };

  const model: LinkModelImpl = {
    validate(a, b, media, lengthM): CableValidation {
      const occupiedA = byPort.get(portKey(a));
      const occupiedB = byPort.get(portKey(b));
      if (occupiedA !== undefined) {
        return { ok: false, reason: `${a.device} ${a.port} already has a cable attached (link ${occupiedA}).` };
      }
      if (occupiedB !== undefined) {
        return { ok: false, reason: `${b.device} ${b.port} already has a cable attached (link ${occupiedB}).` };
      }
      const c = check(a, b, media, lengthM);
      const out: CableValidation = { ok: c.ok };
      if (c.reason !== undefined) out.reason = c.reason;
      if (c.resolvedMedia !== undefined) out.resolvedMedia = c.resolvedMedia;
      return out;
    },

    add(spec, now): LinkState {
      if (links.has(spec.id)) throw new Error(`link ${spec.id} already exists`);
      const keyA = portKey(spec.a);
      const keyB = portKey(spec.b);
      const busyA = byPort.get(keyA);
      if (busyA !== undefined) throw new Error(`${spec.a.device} ${spec.a.port} already has a cable attached (link ${busyA})`);
      const busyB = byPort.get(keyB);
      if (busyB !== undefined) throw new Error(`${spec.b.device} ${spec.b.port} already has a cable attached (link ${busyB})`);
      if (typeof spec.lengthM !== 'number' || !Number.isFinite(spec.lengthM) || spec.lengthM < 0) {
        throw new RangeError(`link ${spec.id}: lengthM must be a non-negative number, got ${spec.lengthM}`);
      }
      if (spec.distanceOverrideM !== undefined && (!Number.isFinite(spec.distanceOverrideM) || spec.distanceOverrideM < 0)) {
        throw new RangeError(`link ${spec.id}: distanceOverrideM must be a non-negative number, got ${spec.distanceOverrideM}`);
      }
      return run(() => {
        touch(spec.a);
        touch(spec.b);
        const state: LinkState = {
          id: spec.id,
          a: { device: spec.a.device, port: spec.a.port },
          b: { device: spec.b.device, port: spec.b.port },
          media: spec.media,
          lengthM: spec.lengthM,
          impairments: normalizeImpairments(spec.impairments),
          up: false,
          resolvedMedia: fallbackMedia(spec.a, spec.b, spec.media),
        };
        const kind = spec.kind ?? (state.resolvedMedia === 'radio' ? 'radio' : undefined);
        if (kind !== undefined) state.kind = kind;
        if (spec.dceEnd !== undefined) state.dceEnd = spec.dceEnd;
        if (spec.distanceOverrideM !== undefined) state.distanceOverrideM = spec.distanceOverrideM;
        links.set(spec.id, { state, cut: false, flowing: false });
        byPort.set(keyA, spec.id);
        byPort.set(keyB, spec.id);
        const pa = deps.port(spec.a);
        if (pa) pa.link = spec.id;
        const pb = deps.port(spec.b);
        if (pb) pb.link = spec.id;
        recomputeLink(spec.id, now, 'cable-connected');
        return copyState(state);
      });
    },

    remove(id, now) {
      const rec = links.get(id);
      if (!rec) return [];
      return run(() => {
        const { state } = rec;
        const wasSegment = state.segment !== undefined;
        const changed: OperChanges = [];
        const carrierLost: PortRef[] = [];
        const touched: [PortRef, PortState, PortWrite][] = [];
        for (const ref of [state.a, state.b]) {
          const p = deps.port(ref);
          if (!p) continue;
          if (p.link === id) delete p.link;
          const prevOper = p.operUp;
          const prevCarrier = p.phy?.carrier ?? p.operUp;
          p.operUp = false;
          delete p.speedBps;
          delete p.duplex;
          delete p.phy;
          const w: PortWrite = { operChanged: prevOper, carrierChanged: prevCarrier };
          if (w.operChanged || w.carrierChanged) p.lastChange = now;
          if (w.operChanged) changed.push({ port: ref, operUp: false });
          if (w.carrierChanged) carrierLost.push(ref);
          touched.push([ref, p, w]);
        }
        if (state.up) emit({ t: now, kind: 'linkState', link: id, up: false, reason: 'cable-removed' });
        state.up = false;
        state.downReason = 'removed';
        delete state.negotiatedBps;
        delete state.carrier;
        for (const [ref, p, w] of touched) {
          if (!w.operChanged && !w.carrierChanged) continue;
          emit({ t: now, kind: 'portState', device: ref.device, port: ref.port, adminUp: p.adminUp, operUp: false, reason: 'cable-removed' });
        }
        byPort.delete(portKey(state.a));
        byPort.delete(portKey(state.b));
        abortLink(id, state, wasSegment, now, 'cable-removed');
        if (kindOf(state) === 'radio') radio.clear(id);
        clearScope(inflight, id); // lost frames: nothing will ever arrive
        latches.clearLink(state.a, state.b);
        links.delete(id);
        if (wasSegment) segment.rebuild(now);
        for (const ref of carrierLost) notify(ref, { kind: 'carrier', up: false }, now);
        return changed;
      });
    },

    setImpairments(id, imp, now) {
      const rec = links.get(id);
      if (!rec) return undefined;
      rec.state.impairments = normalizeImpairments({ ...rec.state.impairments, ...imp });
      return run(() => {
        recomputeLink(id, now, 'impairments-changed');
        return copyState(rec.state);
      });
    },

    get(id) {
      const rec = links.get(id);
      return rec ? copyState(rec.state) : undefined;
    },

    list() {
      const out: LinkState[] = [];
      for (const rec of links.values()) out.push(copyState(rec.state));
      return out;
    },

    linkOf(port) {
      const id = byPort.get(portKey(port));
      return id === undefined ? undefined : model.get(id);
    },

    peerOf(port) {
      const id = byPort.get(portKey(port));
      if (id === undefined) return undefined;
      const rec = links.get(id);
      if (!rec) return undefined;
      const peer = peerRef(rec.state, port);
      return { device: peer.device, port: peer.port };
    },

    transmit(from, pdu, now): TransmitResult {
      return run(() => {
        touch(from);
        return strategyOf(mediumFor(from)).transmit(from, pdu, now);
      });
    },

    onTxComplete(port, now) {
      run(() => strategyOf(mediumFor(port)).onTxComplete?.(port, now));
    },

    onFrameArrival(pduId, to, _now) {
      inflight.remove(pduId, to);
    },

    admit(ev: FrameArrivalBody, now: SimTime): ArrivalVerdict {
      return run(() => {
        const medium = ev.medium;
        if (medium !== undefined) {
          if (medium.startsWith('seg:')) return segment.admit(ev, now);
          if (medium.startsWith('bss:')) return air.admit(ev, now);
          if (medium.startsWith('cell:')) return cell.admit(ev, now);
        }
        const to: PortRef = { device: ev.device, port: ev.port };
        const id = deps.port(to)?.link ?? byPort.get(portKey(to));
        const state = id === undefined ? undefined : links.get(id)?.state;
        return state !== undefined && kindOf(state) === 'radio' ? radio.admit(ev, now) : cable.admit(ev, now);
      });
    },

    recompute(id, now, reason) {
      return run(() => recomputeLink(id, now, reason));
    },

    onPortChanged(ref, now, cause) {
      return run(() => {
        touch(ref);
        const p = deps.port(ref);
        if (p?.spec.kind === 'wlan') return air.onPortChanged(ref, now, cause);
        if (p?.spec.kind === 'cellular') {
          cellularSeen.set(portKey(ref), { device: ref.device, port: ref.port });
          return cell.onPortChanged(ref, now, cause);
        }
        const changes: OperChanges = [];
        const id = p?.link ?? byPort.get(portKey(ref));
        if (id !== undefined) changes.push(...recomputeLink(id, now, cause));
        else if (p === undefined && cellularSeen.has(portKey(ref))) changes.push(...cell.onPortChanged(ref, now, cause));
        else if (p !== undefined && roleOf(p) === 'repeater' && segment.segments().length > 0) segment.rebuild(now);
        return changes;
      });
    },

    onMediumTimer(medium, key, now) {
      return run(() => {
        if (medium.startsWith('seg:')) return segment.onMediumTimer?.(medium, key, now) ?? [];
        if (medium.startsWith('bss:')) return air.onMediumTimer(medium, key, now);
        if (medium.startsWith('cell:')) return cell.onMediumTimer(medium, key, now);
        return radio.onMediumTimer?.(medium, key, now) ?? [];
      });
    },

    mediumOp(from, op: MediumOp, now) {
      return run(() => {
        touch(from);
        switch (op.op) {
          case 'line-protocol': {
            const p = deps.port(from);
            const id = p?.link ?? byPort.get(portKey(from));
            if (p === undefined || id === undefined) return [];
            if (!latches.apply(from, op, p.phy?.carrier === true)) return [];
            return recomputeLink(id, now);
          }
          case 'sta-state':
          case 'assoc':
          case 'authorize':
            return air.mediumOp(from, op, now);
          case 'cell-attach':
          case 'cell-detach':
            cellularSeen.set(portKey(from), { device: from.device, port: from.port });
            return cell.mediumOp(from, op, now);
        }
      });
    },

    onDevicesMoved(devices, now) {
      return run(() => [
        ...(radio.onDevicesMoved?.(devices, now) ?? []),
        ...air.onDevicesMoved(devices, now),
        ...cell.onDevicesMoved(devices, now),
      ]);
    },

    setScale(metresPerUnit, now) {
      if (typeof metresPerUnit !== 'number' || !Number.isFinite(metresPerUnit) || metresPerUnit <= 0) {
        throw new RangeError(`metresPerUnit must be a positive number, got ${metresPerUnit}`);
      }
      scale = metresPerUnit;
      return run(() => [
        ...(radio.setScale?.(metresPerUnit, now) ?? []),
        ...air.setScale(metresPerUnit, now),
        ...cell.setScale(metresPerUnit, now),
      ]);
    },

    linksOfDevice(id) {
      const out: LinkId[] = [];
      for (const rec of links.values()) {
        if (rec.state.a.device === id || rec.state.b.device === id) out.push(rec.state.id);
      }
      return out;
    },

    media(now) {
      const into: MediaSnapshot = { metresPerUnit: scale, segments: [], bss: [], cells: [], associations: [] };
      segment.contribute?.(now, into);
      air.contribute(now, into);
      cell.contribute(now, into);
      return into;
    },

    airView(device): AirView {
      return air.airView(device);
    },

    inflight(now) {
      return inflight.visible(now);
    },

    cut(id, on, now) {
      const rec = links.get(id);
      if (!rec) return undefined;
      rec.cut = on;
      return run(() => recomputeLink(id, now, on ? 'cable-cut' : 'cable-repaired'));
    },

    isCut(id) {
      return links.get(id)?.cut ?? false;
    },

    __flyingSize() {
      return inflight.size();
    },

    radioPortView,

    forgetDevice(device, now) {
      return run(() => {
        const changes: OperChanges = [...air.forgetDevice(device, now)];
        for (const [key, ref] of [...cellularSeen]) {
          if (ref.device !== device) continue;
          changes.push(...cell.onPortChanged(ref, now, 'device-removed'));
          cellularSeen.delete(key);
        }
        const i = seenDevices.indexOf(device);
        if (i >= 0) seenDevices.splice(i, 1);
        seenPorts.delete(device);
        return changes.filter((c) => c.port.device !== device);
      });
    },

    metresPerUnit() {
      return scale;
    },

    collisionStorm(faultId, target, params, now) {
      return run(() => segment.startStorm(faultId, target, params, now));
    },

    stopCollisionStorm(faultId, now) {
      return run(() => segment.stopStorm(faultId, now));
    },
  };

  return model;
}

/** Re-exported for callers that only need the pure validator. */
export { checkCable, validateCable } from './cabling.js';
