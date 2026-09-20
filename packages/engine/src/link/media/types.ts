/**
 * link/media/types.ts — the internal MediumStrategy interface (ARCHITECTURE-P1 D4, D5, §3.4–§3.8).
 *
 * `LinkModel` (link/link.ts) stays the single facade the Simulation and devices call. Behind it, each
 * medium kind is a strategy: CableP2P (link/media/p2p.ts, the P0 pipeline), SharedSegment (segment.ts,
 * CSMA/CD), RadioLink (radio.ts), WirelessBss (air.ts) and CellularCell (cell.ts). A strategy never talks
 * to the Simulation directly: it receives a `MediumHost` from the facade that wraps `LinkModelDeps` with
 * cached rng streams, the in-flight registry, trace emission and the capture tap.
 *
 * Routing of a port (`routeMedium`, in order — contracts/link.ts header):
 *   1. kind 'wlan' with an air role (wireless-bss / wireless-client) → air;
 *      kind 'cellular' with role wireless-bss (tower) or cellular (UE) → cell;
 *   2. the port's link has kind 'radio' → radio;
 *   3. the cable belongs to a collision domain → segment;
 *   4. otherwise → cable.
 *
 * Medium ids (contracts/medium.ts): cables and PtP radio links use their LinkId; a segment
 * 'seg:<ordinal-smallest member LinkId>'; a BSS 'bss:<apDevice>/<port>'; a cell 'cell:<towerDevice>/<port>'.
 */
import type { SimEventBody } from '../../contracts/events.js';
import type { DeviceId, LinkId, PduId, PortRef } from '../../contracts/ids.js';
import { portKey } from '../../contracts/ids.js';
import type {
  ArrivalVerdict,
  LinkKind,
  LinkModelDeps,
  LinkState,
  OperChanges,
  TransmitResult,
  TxOutcome,
} from '../../contracts/link.js';
import type { WireEvent } from '../../contracts/capture.js';
import type { PortRole } from '../../contracts/catalog.js';
import type { MediaSnapshot, MediumEvent, MediumId, MediumKind, MediumOp } from '../../contracts/medium.js';
import type { Pdu } from '../../contracts/pdu.js';
import type { PortKind, PortState } from '../../contracts/port.js';
import type { Rng } from '../../contracts/rng.js';
import type { InflightFrame } from '../../contracts/snapshot.js';
import type { SimTime } from '../../contracts/time.js';
import type { TraceEvent } from '../../contracts/trace.js';

/** A popped `frameArrival` event body (input of `admit`). */
export type FrameArrivalBody = Extract<SimEventBody, { kind: 'frameArrival' }>;

/** One frame leg on a medium, as the in-flight registry keeps it. Identity: `(pdu.id, link, to)`. */
export interface InflightLeg extends InflightFrame {
  /** Scheduler seq of the pending `frameArrival` (undefined for lost legs, which never arrive). */
  arrivalSeq?: number;
}

/** Facade-owned in-flight registry shared by every strategy (link/inflight.ts implements it). */
export interface InflightRegistry {
  /** Record a leg (replaces an entry with the same identity). */
  add(leg: InflightLeg): void;
  /** Remove and return the leg `(pdu, *, to)` when its arrival is popped. */
  remove(pdu: PduId, to: PortRef): InflightLeg | undefined;
  /** Legs on a link or medium, in insertion order. */
  on(scope: LinkId | MediumId): InflightLeg[];
  /** Drop a leg without an arrival (lost, aborted); returns it when present. */
  delete(pdu: PduId, link: LinkId | MediumId, to: PortRef): InflightLeg | undefined;
  /** Legs with `txStart <= now < arrive`, ordered by `(txStart, pdu.id, link, portKey(to))`; prunes arrived legs. */
  visible(now: SimTime): InflightFrame[];
  /**
   * Amortized pruning of legs whose `arrive <= now` (lost legs never reach `remove`). Runs a full pass only once the
   * registry has grown past its sweep threshold, then doubles the threshold (minimum 1024), so it is O(1) amortized.
   */
  sweep(now: SimTime): void;
  /** Number of legs held (lost and not yet pruned legs included). */
  size(): number;
}

/**
 * Services the facade hands to every strategy. All of them are deterministic: rng streams are created once
 * per label and cached for the simulation lifetime (never re-split), and every ordering is explicit.
 */
export interface MediumHost {
  /** The facade's constructor dependencies (scheduler, trace, port access, settings sources). */
  readonly deps: LinkModelDeps;
  readonly inflight: InflightRegistry;
  /** Port state, or undefined for unknown devices. */
  port(ref: PortRef): PortState | undefined;
  /** Device powered on and booted. */
  deviceUp(id: DeviceId): boolean;
  /** Link record view (the facade owns LinkState; strategies may write the fields §3.4 assigns to recompute). */
  link(id: LinkId): LinkState | undefined;
  /** Cached rng sub-stream `label` under `deps.rng` ('link:<id>', 'link:<id>:seg', 'air:<bss>:<key>', …). */
  stream(label: string): Rng;
  emit(ev: TraceEvent): void;
  /** `deps.scheduler.schedule`. */
  schedule(at: SimTime, body: SimEventBody): number;
  /** `deps.scheduler.cancel`. */
  cancel(seq: number): boolean;
  /** Deferred counter outcome → `deps.onTxOutcome` (no-op when absent). */
  txOutcome(ref: PortRef, outcome: TxOutcome, now: SimTime): void;
  /** Medium notification → `deps.notify` (no-op when absent). */
  notify(ref: PortRef, ev: MediumEvent, now: SimTime): void;
  /** Capture tap: records only when a capture wants the port (no-op without captures). */
  capture(ev: WireEvent): void;
}

/**
 * One medium implementation. `transmit` and `admit` are mandatory; the other hooks exist only on mediums
 * that react to them (the facade treats a missing hook as "no changes": an empty OperChanges).
 */
export interface MediumStrategy {
  readonly kind: MediumKind;
  /** Egress of `pdu` on `from` (the facade already routed the port to this strategy). Follows `LinkModel.transmit`. */
  transmit(from: PortRef, pdu: Pdu, now: SimTime): TransmitResult;
  /** A popped arrival scheduled by this medium: prune the leg, record rx capture, rewrap/authorize, decide delivery. */
  admit(ev: FrameArrivalBody, now: SimTime): ArrivalVerdict;
  /** Serialization of the head-of-line frame on `port` finished. */
  onTxComplete?(port: PortRef, now: SimTime): void;
  /** A `mediumTimer` event addressed to a medium of this kind. */
  onMediumTimer?(medium: MediumId, key: string, now: SimTime): OperChanges;
  /** Port-level change (admin, power, boot, err-disabled, PHY/radio config, role). */
  onPortChanged?(ref: PortRef, now: SimTime, cause?: string): OperChanges;
  /** Daemon → medium request (association grants, line protocol, cell attach). */
  mediumOp?(from: PortRef, op: MediumOp, now: SimTime): OperChanges;
  /** Coalesced device moves (radio mediums). */
  onDevicesMoved?(devices: readonly DeviceId[], now: SimTime): OperChanges;
  /** Canvas scale change (radio mediums). */
  setScale?(metresPerUnit: number, now: SimTime): OperChanges;
  /** Abort every leg on `scope` (link down, member removed): cancel arrivals, emit drops/frameAbort. */
  abort(scope: LinkId | MediumId, now: SimTime, detail?: string): void;
  /** Append this medium's segments/BSSs/cells/associations to a snapshot under construction. */
  contribute?(now: SimTime, into: MediaSnapshot): void;
}

/** Inputs of `routeMedium`. */
export interface MediumRouteInput {
  kind: PortKind;
  /** Effective role of the port. */
  role: PortRole;
  /** Kind of the port's link, when it has one. */
  linkKind?: LinkKind;
  /** The port's cable currently belongs to a collision domain. */
  inSegment?: boolean;
}

/** Medium kind that carries traffic for a port (routing order in the file header). */
export function routeMedium(input: MediumRouteInput): MediumKind {
  if (input.kind === 'wlan' && (input.role === 'wireless-bss' || input.role === 'wireless-client')) return 'air';
  if (input.kind === 'cellular' && (input.role === 'wireless-bss' || input.role === 'cellular')) return 'cell';
  if (input.linkKind === 'radio') return 'radio';
  if (input.inSegment === true) return 'segment';
  return 'cable';
}

/** Deterministic ordinal (code-unit) string comparison used for every medium ordering. */
export function compareOrdinal(x: string, y: string): number {
  return x < y ? -1 : x > y ? 1 : 0;
}

/** Segment id from its member cables: 'seg:<ordinal-smallest LinkId>'. Throws on an empty member list. */
export function segmentId(members: readonly LinkId[]): MediumId {
  if (members.length === 0) throw new RangeError('a segment needs at least one member cable');
  let min = members[0] as LinkId;
  for (const id of members) if (compareOrdinal(id, min) < 0) min = id;
  return `seg:${min}`;
}

/** BSS id of an AP radio port: 'bss:<device>/<port>'. */
export function bssId(ap: PortRef): MediumId {
  return `bss:${portKey(ap)}`;
}

/** Cell id of a tower radio port: 'cell:<device>/<port>'. */
export function cellId(tower: PortRef): MediumId {
  return `cell:${portKey(tower)}`;
}
