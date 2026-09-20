/**
 * Link and media model (spec §4.6; ARCHITECTURE-P1 D4, D5, D6, D12).
 *
 * `LinkModel` stays the single facade the Simulation and devices call. From P0.5 it routes each port to a
 * medium strategy (link/media/*): CableP2P (the P0 pipeline with identical numbers), SharedSegment
 * (collision domain, CSMA/CD — D4), RadioLink (PtP radio with RF-derived parameters), WirelessBss (air — D5)
 * and CellularCell. Routing of `transmit(from)`, in order:
 *   1. port kind 'wlan' with an air role (wireless-bss / wireless-client) → air;
 *      port kind 'cellular' (wireless-bss on a tower, cellular on a UE) → cell;
 *   2. the port's link has kind 'radio' → RadioLink;
 *   3. the cable belongs to a collision domain (an end on a repeater-role port, an end negotiated half
 *      duplex, or a duplex mismatch) → SharedSegment;
 *   4. otherwise → CableP2P.
 *
 * P0 cable timing (unchanged). For a frame of `n` bytes sent at `t0` on a port negotiated to `bps`:
 *   txStart = max(t0, port.tx.busyUntil)
 *   txEnd   = txStart + serializationNs(n + overhead, min(bps, impairments.bandwidthBps ?? ∞))
 *   arrive  = txEnd + propagationNs(lengthM, vf) + impairments.latencyNs + jitter
 * `overhead` is MediaSpec.phyOverheadBytes (default ETH_PHY_OVERHEAD = 20; serial 2 from P0.5).
 * The `frameArrival` event is scheduled at `arrive`; `txComplete` at `txEnd`.
 *
 * RNG sub-streams (all under root 'links'; D12 — never add draws to an existing stream):
 *   'link:<id>'           P0 cables and PtP radio links: exactly 5 draws per frame (loss, corrupt, jitter, offset, bit)
 *   'link:<id>:seg'       segment impairments: 5 draws per transmission attempt, same order
 *   'link:<id>:csma'      1 draw per collision backoff
 *     For both segment streams <id> = the LinkId of the TRANSMITTING station's cable (never the segment MediumId,
 *     which changes with membership). A repeater-originated jam/storm uses 'fault:<id>'.
 *   'air:<medium>:<txKey>' 1 CSMA/CA backoff draw per attempt;  'air:<medium>:<rxKey>' 1 PER draw per delivery attempt
 *     Directed mgmt/EAPOL frames use the BSS whose bssid equals dot11.addr1 (station→AP) or the sending AP's BSS
 *     (AP→station) for both busyUntil and the stream. A broadcast probe-req from an unassociated station uses
 *     'air:scan:<txKey>' with no contention (start = now + DIFS + backoff).
 *   'cell:<medium>:<ueKey>' 1 loss draw per frame;  'fault:<faultId>' storm/noise faults
 * Every stream is created once per label and cached for the simulation lifetime; it is never re-split on a segment
 * rebuild or recompute (split is pure: re-splitting restarts the sequence).
 * Derived radio PER is folded into the single existing loss draw: p = 1 − (1 − lossPct/100)(1 − perMille/1000).
 */
import type { DeviceId, LinkId, PduId, PortId, PortRef } from './ids.js';
import type { Scheduler, SimEventBody } from './events.js';
import type { Pdu, PduFactory } from './pdu.js';
import type { PortKind, PortState } from './port.js';
import type { Rng } from './rng.js';
import type { InflightFrame } from './snapshot.js';
import type { SimTime } from './time.js';
import type { TraceSink } from './trace.js';
import type { Connector, TransceiverSpec } from './catalog.js';
import type { AirView, MediaSnapshot, MediumEvent, MediumId, MediumKind, MediumOp } from './medium.js';
import type { RadioLinkView, RadioSettings, RfBand } from './rf.js';
import type { CaptureTap } from './capture.js';

export type MediaType =
  | 'copper-straight'
  | 'copper-crossover'
  | 'fiber-mm'
  | 'fiber-sm'
  /** Legacy (P0) serial cable: the DCE end is the port with `spec.serial.dce`, else end a. */
  | 'serial'
  | 'console'
  | 'auto' // auto-select the correct cable (spec §5.3)
  // ── P0.5 ──
  | 'usb-console'
  | 'fiber-pon'
  /** Serial cable whose end `a` (the first port clicked) carries the DCE connector. */
  | 'serial-dce'
  /** Serial cable whose end `b` carries the DCE connector (end `a` is DTE). */
  | 'serial-dte'
  | 'coax'
  | 'phone'
  /** PtP radio pairing (TopologyLink kind 'radio'); never offered by 'auto' for cables. */
  | 'radio';

export type MediaClass = 'copper' | 'fiber' | 'serial' | 'console' | 'coax' | 'phone' | 'radio' | 'auto';

export interface MediaSpec {
  media: MediaType;
  /** Max length in metres (most permissive; see maxLengthBySpeed). */
  maxLengthM: number;
  /** Fraction of c for propagation. */
  velocityFactor: number;
  /** Which port kinds may be connected with this media. */
  portKinds: readonly PortKind[];
  /** @since P0.5 */
  class: MediaClass;
  /** @since P0.5 Allowed connector pairings (symmetric). Absent = the portKinds rule only. */
  connectors?: readonly { a: readonly Connector[]; b: readonly Connector[] }[];
  /** @since P0.5 Per-speed limits in ascending maxBps; the first entry with negotiatedBps ≤ maxBps applies. */
  maxLengthBySpeed?: readonly { maxBps: number; maxLengthM: number }[];
  /** @since P0.5 Bytes added for serialization timing. Default ETH_PHY_OVERHEAD (20). */
  phyOverheadBytes?: number;
  /** @since P0.5 Console/USB: carrier shown, data frames refused ('out-of-band'). */
  outOfBand?: boolean;
  /** @since P0.5 */
  wiring?: 'straight' | 'crossover' | 'rollover';
  /** @since P0.5 serial-dce: 'a'; serial-dte: 'b'. */
  dceEnd?: 'a' | 'b';
  /** @since P0.5 */
  fiberMode?: 'mm' | 'sm' | 'pon';
}

/**
 * Media table. P0 entries keep their P0 values (`portKinds`, lengths, velocity factors) — the P0.5
 * link wave widens `console` to terminal ethernet ports with connector pairing and updates
 * link.cabling tests deliberately.
 */
export const MEDIA: Readonly<Record<MediaType, MediaSpec>> = {
  'copper-straight': { media: 'copper-straight', maxLengthM: 100, velocityFactor: 0.66, portKinds: ['ethernet'], class: 'copper', wiring: 'straight' },
  'copper-crossover': { media: 'copper-crossover', maxLengthM: 100, velocityFactor: 0.66, portKinds: ['ethernet'], class: 'copper', wiring: 'crossover' },
  'fiber-mm': {
    media: 'fiber-mm', maxLengthM: 550, velocityFactor: 0.67, portKinds: ['ethernet'], class: 'fiber', fiberMode: 'mm',
    maxLengthBySpeed: [{ maxBps: 1_000_000_000, maxLengthM: 550 }, { maxBps: 10_000_000_000, maxLengthM: 300 }],
  },
  'fiber-sm': { media: 'fiber-sm', maxLengthM: 10_000, velocityFactor: 0.67, portKinds: ['ethernet'], class: 'fiber', fiberMode: 'sm' },
  serial: { media: 'serial', maxLengthM: 15, velocityFactor: 0.66, portKinds: ['serial'], class: 'serial', phyOverheadBytes: 2 },
  // Rollover: one end on a device console/aux line, the other on a computer's terminal (ethernet) port (CATALOG.md).
  console: { media: 'console', maxLengthM: 15, velocityFactor: 0.66, portKinds: ['console', 'ethernet'], class: 'console', outOfBand: true, wiring: 'rollover' },
  auto: { media: 'auto', maxLengthM: 100, velocityFactor: 0.66, portKinds: ['ethernet', 'serial', 'console'], class: 'auto' },
  'usb-console': {
    media: 'usb-console', maxLengthM: 5, velocityFactor: 0.66, portKinds: ['usb', 'console'], class: 'console', outOfBand: true,
    // Computer USB plug at one end; the device end is a mini-USB/USB-C console socket or an RJ-45 console socket.
    connectors: [{ a: ['usb', 'usb-mini', 'usb-c'], b: ['usb', 'usb-mini', 'usb-c', 'rj45-console'] }],
  },
  'fiber-pon': { media: 'fiber-pon', maxLengthM: 20_000, velocityFactor: 0.67, portKinds: ['fiber-pon'], class: 'fiber', fiberMode: 'pon', connectors: [{ a: ['sc'], b: ['sc'] }] },
  'serial-dce': { media: 'serial-dce', maxLengthM: 15, velocityFactor: 0.66, portKinds: ['serial'], class: 'serial', phyOverheadBytes: 2, dceEnd: 'a' },
  'serial-dte': { media: 'serial-dte', maxLengthM: 15, velocityFactor: 0.66, portKinds: ['serial'], class: 'serial', phyOverheadBytes: 2, dceEnd: 'b' },
  coax: {
    media: 'coax', maxLengthM: 500, velocityFactor: 0.66, portKinds: ['coax'], class: 'coax',
    connectors: [{ a: ['bnc'], b: ['bnc'] }, { a: ['f-type'], b: ['f-type'] }],
  },
  phone: { media: 'phone', maxLengthM: 5_000, velocityFactor: 0.67, portKinds: ['phone'], class: 'phone', connectors: [{ a: ['rj11'], b: ['rj11'] }] },
  radio: { media: 'radio', maxLengthM: 100_000, velocityFactor: 1.0, portKinds: ['radio'], class: 'radio', connectors: [{ a: ['antenna'], b: ['antenna'] }] },
};

export interface Impairments {
  /** 0..100 — frame silently lost (traced as a drop with reason `'link-loss'`). */
  lossPct: number;
  /** Added one-way latency. */
  latencyNs: SimTime;
  /** Uniform jitter in [0, jitterNs] added per frame from the link's rng sub-stream. */
  jitterNs: SimTime;
  /** 0..100 — flip random bits; receiver sees an FCS error. */
  corruptPct: number;
  /** Optional cap below the negotiated speed (simulates a slow WAN). */
  bandwidthBps?: number;
}

export const NO_IMPAIRMENTS: Readonly<Impairments> = Object.freeze({
  lossPct: 0, latencyNs: 0, jitterNs: 0, corruptPct: 0,
});

/** 'cable' (default) or a PtP radio pairing between two radio-ptp ports (media must be 'radio'). */
export type LinkKind = 'cable' | 'radio';

/**
 * @since P0.5 The only valid kind for a media; a spec whose kind disagrees fails validation with code
 * 'media-mismatch'. addLink, validateLink and loadTopology fill `kind = linkKindOf(resolvedMedia)` when omitted;
 * 'auto' between two radio-ptp ports resolves to 'radio'.
 */
export function linkKindOf(media: MediaType): LinkKind {
  return media === 'radio' ? 'radio' : 'cable';
}

export interface LinkSpec {
  id: LinkId;
  a: PortRef;
  b: PortRef;
  media: MediaType;
  lengthM: number;
  impairments: Impairments;
  /** @since P0.5 Default 'cable'. */
  kind?: LinkKind;
  /** @since P0.5 Serial DCE end override (topology `dce_end`); wins over media and PortSpec.serial.dce. */
  dceEnd?: 'a' | 'b';
  /** @since P0.5 Radio links: explicit distance overriding canvas distance × metresPerUnit. */
  distanceOverrideM?: number;
}

export interface LinkState extends LinkSpec {
  /**
   * Link usable for data: carrier && both ends' line protocol (physical up, media valid, not cut, clocked). For
   * serial links this is display/animation only: per-end operUp gates data (a keepalive latch downs one end).
   */
  up: boolean;
  /** Why the link is down: CableProblem | LinkDownCode | `'power-off:a'` | `'admin-down:b'` | `'err-disabled:a'`. */
  downReason?: string;
  /** Resolved media when spec.media === 'auto'. */
  resolvedMedia: Exclude<MediaType, 'auto'>;
  negotiatedBps?: number;
  /** @since P0.5 Present only when it differs from `up` (serial: carrier up, line protocol down). */
  carrier?: boolean;
  /** @since P0.5 Resolved serial DCE end. */
  resolvedDceEnd?: 'a' | 'b';
  /** @since P0.5 Per-end negotiation result (omitted for serial/console/radio). */
  phy?: { a: PhyEndView; b: PhyEndView; mismatch?: 'duplex' };
  /** @since P0.5 Collision domain id when the cable is in segment mode. */
  segment?: MediumId;
  /** @since P0.5 Radio links. */
  radio?: RadioLinkView;
}

/**
 * Validation result for cabling (spec §8.3: invalid combinations are rejected WITH an explanation).
 * `ok:false` links can still be created (the student learns), but `up` stays false with `downReason`.
 */
export interface CableValidation {
  ok: boolean;
  /** Original, non-vendor wording. */
  reason?: string;
  resolvedMedia?: Exclude<MediaType, 'auto'>;
  /** @since P0.5 Machine-readable problem class (becomes `downReason`). */
  code?: CableProblem;
}

/** Cable problems detected by validation. */
export type CableProblem =
  | 'unknown-media'
  | 'bad-length'
  | 'same-device'
  | 'media-mismatch'
  | 'too-long'
  // ── P0.5 ──
  | 'connector-mismatch'
  | 'no-transceiver'
  | 'sfp-mismatch'
  | 'not-a-cable-port'
  | 'radio-needs-radio-port';

/** Down reasons produced after the cable check (in recompute order; ARCHITECTURE-P1 §3.4). */
export type LinkDownCode =
  | 'cut'
  | 'removed'
  | 'speed-mismatch'
  | 'radio-band-mismatch'
  | 'radio-channel-mismatch'
  | 'radio-key-mismatch'
  | 'out-of-range'
  | 'no-clock'
  | 'encapsulation-mismatch'
  | 'keepalive-missed';

/** Config-derived PHY settings of a port, produced by the device runtime from running-config (`DeviceRuntime.phySettings`). */
export interface PortPhySettings {
  /** `speed auto|10|100|1000` (bps when fixed). */
  speed: 'auto' | number;
  /** `duplex auto|full|half`. */
  duplex: 'auto' | 'full' | 'half';
  /** Serial `clock rate <bps>`; undefined = not configured (only meaningful on the DCE end). */
  clockRateBps?: number;
}

/** One end's negotiation outcome. */
export interface PhyEndView {
  speedBps: number;
  duplex: 'full' | 'half';
  autoneg: boolean;
  /** How this end reached its values. */
  via: 'autoneg' | 'parallel-detect' | 'forced' | 'fixed';
}

/** Link-model-owned physical detail on `PortState.phy`. */
export interface PortPhy {
  /**
   * Physical carrier. `operUp === carrier && lineProtocol` for non-virtual ports. wlan ports: carrier = powered &&
   * adminUp && radio/BSS configured; lineProtocol = AP: BSS up, station: associated && authorized.
   */
  carrier: boolean;
  /** Per end: a serial keepalive latch downs only the reporting end. */
  lineProtocol: boolean;
  /** 'no-clock' | 'encapsulation-mismatch' | 'keepalive-missed' | 'not-associated' … */
  lineProtocolReason?: string;
  end?: PhyEndView;
  duplexMismatch?: boolean;
  medium?: MediumKind;
  /** Collision domain when in segment mode. */
  segment?: MediumId;
  /** Serial: this end is the DCE. */
  dce?: boolean;
}

/** Reasons a frame can be dropped anywhere in the engine; rendered as the floating drop tag (spec §9.1). */
export type DropReason =
  | 'link-down'
  | 'link-loss'
  | 'fcs-error'
  | 'runt'
  | 'giant'
  | 'port-admin-down'
  | 'port-err-disabled'
  | 'queue-full'
  | 'no-route'
  | 'ttl-expired'
  | 'arp-unresolved'
  | 'not-for-me'
  | 'unsupported-ethertype'
  | 'unsupported-protocol'
  | 'bad-checksum'
  | 'no-l3-address'
  | 'acl-deny'
  | 'other'
  // ── P0.5 ──
  /** Receiver on a half-duplex segment port was hit by a collision (no error counter). */
  | 'collision'
  | 'late-collision'
  | 'excessive-collisions'
  | 'out-of-range'
  | 'not-associated'
  | 'encapsulation-mismatch'
  | 'out-of-band';

/** `ok:false` reasons of `transmit`. */
export type TransmitRefusal = 'link-down' | 'out-of-band' | 'not-associated' | 'queue-full' | 'encapsulation-mismatch';

/**
 * Result of `LinkModel.transmit`. On `ok:false` the link model has ALREADY emitted the `drop`
 * trace event (device+port set); the caller increments `counters.outDrops` and must NOT count
 * `outPackets/outBytes` (rule 6). On `ok:true` without `deferred` the caller increments
 * `outPackets/outBytes`, adds `retries` to `txRetries`, and sets `lastOutput = txStart`.
 * With `deferred: true` (segment media, P0.5) the frame is queued for CSMA/CD: the times are
 * provisional (= now) and the caller counts NOTHING now — the outcome arrives through
 * `LinkModelDeps.onTxOutcome` → `DeviceRuntime.onTxOutcome`.
 */
export type TransmitResult =
  | {
      ok: true;
      link: LinkId | MediumId;
      txStart: SimTime;
      txEnd: SimTime;
      arrive: SimTime;
      lost?: boolean;
      corrupted?: boolean;
      /** @since P0.5 Air: retransmission attempts used. */
      retries?: number;
      /** @since P0.5 Segment: queued; counters are updated later via onTxOutcome. */
      deferred?: boolean;
    }
  | { ok: false; reason: TransmitRefusal };

/** Egress call the device runtime makes for every `send` action (the sim passes `linkModel.transmit`). */
export type TransmitFn = (from: PortRef, pdu: Pdu, now: SimTime) => TransmitResult;

/** Asynchronous transmit outcomes (segment media). Applied to PortCounters by the device runtime (the only counter writer). */
export type TxOutcome =
  | { kind: 'sent'; pdu: PduId; txStart: SimTime; bytes: number }
  /** Waited for carrier (reported once per frame). */
  | { kind: 'deferred'; pdu: PduId }
  | { kind: 'collision'; pdu: PduId; late: boolean; attempt: number }
  | { kind: 'dropped'; pdu: PduId; reason: DropReason }
  /** Repeater port traffic (hub in/out counters). */
  | { kind: 'repeated'; bytes: number; dir: 'in' | 'out'; fragment?: boolean };

/** Receive-side detail passed to `DeviceRuntime.onFrameArrival` (segments, air). */
export interface FrameRxInfo {
  /** Collision fragment: bytes actually received (full-duplex receiver → runt/CRC error). */
  fragmentBytes?: number;
  /** Half-duplex receiver saw a collision during reception (drop 'collision', no error counter). */
  collided?: boolean;
  medium?: MediumKind;
}

/** Verdict of `LinkModel.admit` for a popped frameArrival. */
export type ArrivalVerdict = { deliver: true; pdu: Pdu; corrupted?: boolean; rx?: FrameRxInfo } | { deliver: false };

/** Ports whose operUp changed; the sim calls `DeviceRuntime.onPortOper` for each, in order. */
export type OperChanges = { port: PortRef; operUp: boolean }[];

/**
 * The link model (link/link.ts) — one instance per Simulation. All timestamps are integer ns.
 *
 * FIELD OWNERSHIP on `PortState`: the link model is the ONLY writer of `tx`, `operUp` (non-virtual
 * ports), `speedBps`, `duplex`, `link`, `lastChange` and `phy`; the device runtime owns everything else.
 *
 * In-flight identity is `(pdu.id, link|medium, to)`: a broadcast on a segment or BSS has one entry
 * per receiver leg (P0 cables: one entry per frame).
 */
export interface LinkModel {
  validate(a: PortRef, b: PortRef, media: MediaType, lengthM: number): CableValidation;
  /** Create the link, set both ports' `link`, run `recompute`. (`topologyChanged` is emitted by the Simulation, not here.) */
  add(spec: LinkSpec, now: SimTime): LinkState;
  /**
   * Clear both ports' `link`, force operUp=false on both (emits portState/linkState). Frames still in
   * flight on the link are aborted (drop `link-down` on the link).
   */
  remove(id: LinkId, now: SimTime): OperChanges;
  setImpairments(id: LinkId, imp: Partial<Impairments>, now: SimTime): LinkState | undefined;
  get(id: LinkId): LinkState | undefined;
  list(): LinkState[];
  linkOf(port: PortRef): LinkState | undefined;
  peerOf(port: PortRef): PortRef | undefined;
  /**
   * Called by the device runtime for every `send` action. Routes per the file header.
   *  • Cable/segment link absent, or sending port not operUp → emit drop `link-down` (device+port set) and return
   *    ok:false. Exception: on a serial link whose sender is down ONLY by keepalive (phy.carrier true,
   *    lineProtocolReason 'keepalive-missed'), a frame whose outer layer is hdlc with protocol 0x8035 is transmitted
   *    normally (`no-clock` / `encapsulation-mismatch` stay fully blocked).
   *  • Air: radio carrier down → `link-down`. Dot11 mgmt and EAPOL need only carrier plus the air range/band rules.
   *    Ethernet data from an unauthorized station → `not-associated`.
   *  • CableP2P: compute txStart/txEnd/arrive; `tx.busyUntil = txEnd`, `tx.queue++`; schedule
   *    `txComplete` at txEnd; 5 impairment draws (loss → corrupt → jitter → offset → bit) for EVERY
   *    frame; lost → drop `link-loss` with `link` set, no arrival; corrupted → `pdu.corrupt(...)` on the
   *    receiver's copy and `frameArrival{corrupted:true}`; emit `frameTx`; record the in-flight entry.
   *  • Multi-receiver media clone per receiver via `deps.pdus.clone` (D4/D8 no aliasing), the original
   *    stays the sender's identity; corruption only on the receiver's copy.
   *  • Capture: `deps.capture.record({dir:'tx'})` when the frame actually starts on the medium, after any
   *    egress rewrap and before corruption.
   */
  transmit(from: PortRef, pdu: Pdu, now: SimTime): TransmitResult;
  /** Run-loop hook: the Simulation calls this when it pops a `txComplete` event. `tx.queue--`. */
  onTxComplete(port: PortRef, now: SimTime): void;
  /** P0 run-loop hook: called when a `frameArrival` is popped, BEFORE the device runtime sees it. Removes the in-flight entry `(pduId, *, to)`. */
  onFrameArrival(pduId: PduId, to: PortRef, now: SimTime): void;
  /**
   * Recompute `link.up`/`downReason`/`negotiatedBps` and both ports' operUp/speedBps/duplex/lastChange/phy
   * after any adminUp / errDisabled / power / cut / impairment / PHY-config change. Emits `linkState`
   * (if `up` changed), `phyNegotiated` (if negotiation changed), `portState` per changed port, then
   * `segmentChanged`. Returns the ports whose operUp changed.
   */
  recompute(id: LinkId, now: SimTime, reason?: string): OperChanges;
  /** Frames with `txStart <= now < arrive`, ordered by `(txStart, pdu.id, link, portKey(to))`. */
  inflight(now: SimTime): InflightFrame[];

  // ── P0.5 ──
  /**
   * @since P0.5 Replaces the sim's use of `onFrameArrival`: prunes the in-flight entry, records rx capture
   * (before any ingress rewrap), re-checks air authorization, performs the dot11→ethernet rewrap for data
   * frames (stamped with the receiving device) and returns what the device should receive. Emits the drop
   * itself when `deliver:false`.
   */
  admit(ev: Extract<SimEventBody, { kind: 'frameArrival' }>, now: SimTime): ArrivalVerdict;
  /** @since P0.5 Any port-level change (admin, power, boot, err-disabled, PHY config, radio config, role). Handles cables, radio links and air/cell radios. */
  onPortChanged(ref: PortRef, now: SimTime, cause?: string): OperChanges;
  /** @since P0.5 Dispatch of a `mediumTimer` event (CSMA deferral/backoff/jam end, RF hold, attach, noise bursts). */
  onMediumTimer(medium: MediumId, key: string, now: SimTime): OperChanges;
  /**
   * @since P0.5 Dispatch of coalesced `deviceMoved` events: recompute every radio link and air/cell pair on a
   * band/channel set that overlaps any radio of the moved devices (the moved pairs first, then the others in
   * medium-id then station port order), using a per-band radio index (cost O(radios on the band)). `rfState` is
   * still emitted only on bars/rate change.
   */
  onDevicesMoved(devices: readonly DeviceId[], now: SimTime): OperChanges;
  /** @since P0.5 Daemon → medium request (Action 'medium'). */
  mediumOp(from: PortRef, op: MediumOp, now: SimTime): OperChanges;
  /** @since P0.5 Canvas scale change; recomputes every radio link and air/cell pair. */
  setScale(metresPerUnit: number, now: SimTime): OperChanges;
  /** @since P0.5 Links with an end on the device, in creation order. */
  linksOfDevice(id: DeviceId): LinkId[];
  /** @since P0.5 Segment/BSS/cell/association snapshot. */
  media(now: SimTime): MediaSnapshot;
  /** @since P0.5 RF view for a device's daemons (`ProcessCtx.air`). */
  airView(device: DeviceId): AirView;
  /** @since P1 Fault hook: raise the noise floor (`spec` null removes the entry `key`). */
  injectNoise?(spec: { band?: RfBand; channel?: number; center?: DeviceId; radiusM?: number; riseDb: number } | null, key: string, now: SimTime): OperChanges;
}

/** Constructor dependencies for the link model, supplied by the Simulation. */
export interface LinkModelDeps {
  scheduler: Scheduler;
  trace: TraceSink;
  /** `root.split('links')`; the model derives the sub-streams listed in the file header. */
  rng: Rng;
  /**
   * Mutable port access. Returns undefined for unknown devices → treated as link down. The model reads
   * `role`, `encap`, `spec.wiring/autoMdix/connector/radio`, `transceiver` from it (P0.5).
   */
  port(ref: PortRef): PortState | undefined;
  /** Device id → is powered on and booted (used for negotiation and up/down derivation). */
  deviceUp(id: DeviceId): boolean;
  /**
   * @since P0.5 Whether a device has a host shell (a computer that can run a terminal session over a console
   * cable). Copper wiring comes from the ports (`spec.wiring`, role traits, `spec.autoMdix`), never the device kind.
   */
  hostTerminal(id: DeviceId): boolean;

  // ── P0.5 ──
  /**
   * @since P0.5 Clone per receiver on multi-receiver media (D4). Stays optional after the P0.5 exit gate: absent =
   * receivers share the transmitted pdu (focused link harnesses); the Simulation always supplies it.
   */
  pdus?: Pick<PduFactory, 'clone'>;
  /** @since P0.5 PHY config (speed/duplex/clock rate). undefined = defaults (no clock checks, auto). */
  portSettings(ref: PortRef): PortPhySettings | undefined;
  /** @since P0.5 Radio config of a wlan/radio/cellular port. */
  radioSettings(ref: PortRef): RadioSettings | undefined;
  /** @since P0.5 Optics of the transceiver installed in an SFP cage. */
  transceiver(ref: PortRef): TransceiverSpec | undefined;
  /** @since P0.5 Integer canvas position of a device. */
  position(id: DeviceId): { x: number; y: number } | undefined;
  /** @since P0.5 Metres per canvas unit (default 0.25). */
  metresPerUnit?: number;
  /** @since P0.5 Deferred transmit outcomes → `DeviceRuntime.onTxOutcome`. */
  onTxOutcome(ref: PortRef, outcome: TxOutcome, now: SimTime): void;
  /** @since P0.5 Medium notifications → `DeviceRuntime.onMediumEvent` → `Process.onMediumEvent`. */
  notify(ref: PortRef, ev: MediumEvent, now: SimTime): void;
  /**
   * @since P0.5 Device ids in creation order (segment member order, cellular radio order). Absent = the order in
   * which the link model first saw each device.
   */
  devices?(): readonly DeviceId[];
  /** @since P0.5 Port ids of a device in canonical port order (hub repeater ports, cellular radios). Absent = the ports the link model has seen. */
  devicePorts?(id: DeviceId): readonly PortId[];
  /** @since P1 NetScope capture tap (wire bytes at tx start and at admit). */
  capture?: CaptureTap;
}
