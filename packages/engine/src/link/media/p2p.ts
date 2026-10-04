/**
 * link/media/p2p.ts — CableP2P, the P0 point-to-point frame pipeline extracted as a medium strategy
 * (ARCHITECTURE-P1 D4/D5 media routing, §3.4, §3.9; contracts/link.ts `LinkModel.transmit`).
 *
 * Timing for a frame of `n` bytes sent at `t0` on a link negotiated to `bps` (identical P0 numbers):
 *   txStart = max(t0, port.tx.busyUntil)
 *   txEnd   = txStart + serializationNs(n + phyOverheadBytes(resolvedMedia), bps)
 *   arrive  = txEnd + propagationNs(lengthM, velocityFactor) + impairments.latencyNs + jitter
 * `phyOverheadBytes` is MediaSpec.phyOverheadBytes (serial media 2), else ETH_PHY_OVERHEAD (20).
 *
 * Randomness: the cached stream `link:<id>` takes EXACTLY five draws per transmitted frame, always in the order
 * loss → corrupt → jitter → corrupt-offset → corrupt-bit, whatever the settings or outcomes (P0 invariant, D12).
 * A radio link folds its RF packet error rate into the single loss draw (`tune().perMille`), so the count holds.
 *
 * Corruption flips one bit inside the OUTER layer's payload window: past the outer header and before the outer
 * frame check sequence (ethernet 14/4, hdlc 4/2, dot11 24/4), so the frame still decodes and the receiver sees a
 * genuine checksum mismatch.
 *
 * Refusals (`ok:false`, the drop is emitted here with device+port):
 *   • no cable, link without carrier, sending end not operUp → `link-down`. A serial end down ONLY by its keepalive
 *     latch still sends HDLC keepalives (protocol 0x8035); `no-clock` / `encapsulation-mismatch` stay blocked.
 *   • out-of-band media (console, usb-console) → `out-of-band`: the carrier is shown but no data frame is carried.
 *   • @since P2 (ARCHITECTURE-P2 D23) a full transmit queue → `queue-full`, detail `256 frames already queued`.
 *     The queue of a port is the frames it accepted whose serialization has not ended before `now` (txEnd ≥ now):
 *     waiting behind `busyUntil` plus the one on the wire. With `P2P_QUEUE_LIMIT` (256) of them, a new frame is
 *     refused. The count is kept from the accepted frames' txEnd times, so it does not depend on the run loop
 *     dispatching `txComplete`; in a dispatched simulation it bounds `tx.queue` too (every txComplete before `now`
 *     has run), so `port.tx.queue ≤ P2P_QUEUE_LIMIT` at every instant. It bounds MEMORY in a loop that multiplies
 *     frames, not the event rate (line rate does). A refused frame draws nothing from `link:<id>`. @since P3 (ruling R33)
 *     a serial control frame (HDLC keepalive, PPP LCP/PAP/CHAP/IPCP/IPV6CP; `isSerialControlFrame`) is never refused
 *     `queue-full`: it is committed behind the queue like any frame (the ring grows past the limit for it), so
 *     congestion alone never takes a serial line protocol down. Ethernet frames keep the refusal byte for byte.
 *
 * In-flight legs are keyed `(pdu, link, to)` in the facade registry (link/inflight.ts). Capture tap: tx is recorded
 * when the frame starts (before corruption), rx in `admit` (after corruption).
 *
 * P3 (ARCHITECTURE-P3; W2 media):
 *   • D16, ruling R15: a frame committed behind a busy transmitter (`txStart > now`) records its IP DSCP on its leg
 *     (`frameDscp`, read before any corruption), so `InflightRegistry.queued` can show the waiting frames' classes in
 *     `PortSnapshot.txBacklog`. A leg that starts at once records nothing; no draw, trace or count changes.
 *   • [S19] D17: the sending end's gate is `serialControlExempt` (`link/serial.ts`), which answers every non-PPP frame
 *     exactly as `keepaliveExempt` did and also lets a PPP control frame (LCP, PAP, CHAP, IPCP, IPv6CP) leave a `ppp`
 *     port whose line protocol is down only by PPP, so PPP can negotiate. No P1/P2 world has a `ppp` port.
 *
 * P3 [S20]/[S21] (ARCHITECTURE-P3 D16, §3.11, §4.2; W3 media) — THE HELD QUEUE of a scheduler port. A cable port (never
 * a PtP radio, never a segment) for which `LinkModelDeps.egressPolicy(ref)` returns a compiled `EgressSchedulerSpec` gets
 * one `PortScheduler` (W2 `link/qos/scheduler.ts`, over W1 `core/queueing.ts`), kept per port and keyed to the port's
 * transmitter object (a port rebuilt at power-on starts without one). Every other port keeps the virtual FIFO above,
 * byte for byte: without a spec nothing below runs, reads a draw or emits anything.
 *   • Ruling R33: control traffic (`isQosControlFrame`: HDLC keepalives, PPP control frames, CDP, LLDP, BPDUs) never
 *     joins a class queue: it goes straight to the virtual FIFO, so it leaves next (behind the frame on the wire) and is
 *     never tail-dropped, classified or counted by the scheduler.
 *   • `transmit(from, pdu, now, {qosClass})`: the refusals above come first (link down, out of band). The frame then
 *     joins its class (`qosClass`, the position of the runtime's output-policy class in `spec.classes`; absent or out of
 *     range = class-default; a fair-queue class also gets the frame's WFQ flow, `qosFlowOf`). A tail drop is refused
 *     `queue-full` with the class's detail (`class class-default is full (64 packets)`); a policer drop (the LLQ
 *     conditional policer, an [S21] `police` the scheduler enforces) is refused `policed` with its detail (ruling R35:
 *     `{ok: false, reason: 'policed'}`, drop `policed`; the runtime counts outDrops).
 *     When the port is idle — nothing held, no shaper gate pending, the transmitter free (`busyUntil <= now`) — the
 *     scheduler picks the frame at once and it leaves through the virtual FIFO with the FIFO's own (non-deferred)
 *     result: an uncongested scheduler port emits no `frameQueued` and counts exactly like a FIFO port. Otherwise the
 *     frame waits: trace `frameQueued {queue, depth}` (the class and its depth after the enqueue) and `{ok: true,
 *     deferred: true}` with provisional times (= now); the caller counts nothing now.
 *   • Dequeue: at each `txComplete` of the port (and when the shaper gate opens) the scheduler picks the next frame
 *     while the transmitter is free: priority first, then class DRR (CBWFQ), flow DRR inside a fair-queue class. The
 *     picked frame leaves through the virtual FIFO at `now` (`txStart = now`): the five `link:<id>` draws are taken AT
 *     DEQUEUE, `frameTx` and the in-flight leg are recorded then (so `frameQueued` → `frameTx` is the wait), and
 *     `TxOutcome sent {txStart, bytes}` reports the counters (the `segment.ts` precedent). A frame the FIFO refuses at
 *     dequeue (the end went down meanwhile) reports `TxOutcome dropped` with the refusal's reason, and the next is tried.
 *   • [S21] Shaping: when the scheduler answers `{kind: 'wait', at}` the frame stays held and a `mediumTimer` with the
 *     medium id `qos:<portKey>` and key `shape` (never periodic, §4.2) is armed at `at`; while it is pending nothing
 *     leaves; at expiry the dequeue resumes.
 *   • Frames already committed by the virtual FIFO before a queue is installed keep their times; the scheduler waits for
 *     `busyUntil`. The spec is re-read at every transmit, every dequeue and every `onPortChanged` of the link (the
 *     `service-policy output` line is a PHY line of scheduler ports, D16); an equal spec keeps the queue and its
 *     counters; a removed or different one (or a port that stops routing to this medium) hands the held frames, in the
 *     order they would have left, to the virtual FIFO, which commits them behind `busyUntil`.
 *   • A link that stops carrying data (`abort`) drops every frame held at either end, `link-down` with the abort's
 *     detail and device+port set, each reported `TxOutcome dropped`, and cancels a pending shaper gate.
 *   • `egressQueues(ref, now)`: the scheduler's display view (`EgressQueueView`); a port whose spec has no queue yet
 *     shows that spec's empty view; a FIFO port none.
 */
import type { CaptureLinkType } from '../../contracts/capture.js';
import type { LinkId, PortRef } from '../../contracts/ids.js';
import { portKey } from '../../contracts/ids.js';
import type { ArrivalVerdict, EgressQueueView, EgressSchedulerSpec, LinkState, OperChanges, TransmitOptions, TransmitResult } from '../../contracts/link.js';
import { MEDIA, P2P_QUEUE_LIMIT } from '../../contracts/link.js';
import type { PortState } from '../../contracts/port.js';
import type { MediumId, MediumKind } from '../../contracts/medium.js';
import type { Pdu, ProtoName } from '../../contracts/pdu.js';
import { DOT11_FCS, ETH_FCS, ETH_HEADER, HDLC_FCS } from '../../contracts/pdu.js';
import type { SimTime } from '../../contracts/time.js';
import { propagationNs, serializationNs } from '../../contracts/time.js';
import type { PduSummary, TraceEvent } from '../../contracts/trace.js';
import { phyOverheadBytes } from '../cabling.js';
import { frameDscp } from '../inflight.js';
import { createPortScheduler, qosFlowOf, type PortScheduler } from '../qos/scheduler.js';
import { foldPerIntoLossPct } from '../rf/mcs.js';
import { isQosControlFrame, isSerialControlFrame } from '../control-frame.js';
import { serialControlExempt } from '../serial.js';
import type { FrameArrivalBody, InflightLeg, MediumHost, MediumStrategy } from './types.js';

/** @since P3 [S20]/[S21] Medium-id prefix of a scheduler port's shaper gate (`mediumTimer`, §4.2): `qos:<portKey>`. */
export const QOS_MEDIUM_PREFIX = 'qos:';

/** @since P3 [S21] Key of the shaper-gate `mediumTimer` of a scheduler port. */
export const QOS_SHAPER_TIMER_KEY = 'shape';

/** @since P3 [S20]/[S21] The medium id of the shaper gate of scheduler port `ref`: `qos:<device>/<port>`. */
export function qosMediumId(ref: PortRef): MediumId {
  return `${QOS_MEDIUM_PREFIX}${portKey(ref)}`;
}

/** Frame check sequence bytes of the outer codecs that carry one (corruption never lands in them). */
export const OUTER_FCS_BYTES: Readonly<Partial<Record<ProtoName, number>>> = Object.freeze({
  ethernet: ETH_FCS,
  hdlc: HDLC_FCS,
  dot11: DOT11_FCS,
});

/** Original drop detail for data offered to a console-class cable. */
export const OUT_OF_BAND_DETAIL = 'A console cable carries management characters only, never network frames.';

/** Compact trace description of a PDU (undefined optionals are omitted; P0 byte-identical). */
export function summarizePdu(pdu: Pdu): PduSummary {
  const s: PduSummary = { id: pdu.id, proto: pdu.topProto(), size: pdu.size, summary: pdu.summary() };
  const meta = pdu.meta;
  if (meta.parent !== undefined) s.parent = meta.parent;
  if (meta.flow !== undefined) s.flow = meta.flow;
  if (meta.tag !== undefined) s.tag = meta.tag;
  // P2 (§2.7): the outermost 802.1Q VID of a tagged frame; absent for every untagged frame (P0/P1 bytes unchanged)
  const l1 = pdu.layers[1];
  if (l1 !== undefined && l1.proto === 'dot1q' && typeof l1.fields.vid === 'number') s.vlan = l1.fields.vid;
  // P2 (§2.7, §3.12 step 6): a station frame inside a CAPWAP tunnel — a capwap layer followed by the frame it
  // carries. Control messages and keep-alives carry no frame; P0/P1 PDUs never hold a capwap layer (bytes unchanged).
  // A tunnelled frame has at least five layers (frame, ipv4, udp, capwap, inner frame): shorter PDUs, the hot path
  // of every frame event, skip the walk.
  // P3 [S18] (§2.7; W2 fix, the eigrp-gre report's cross-owner need): a GRE leg — a gre layer after the frame and the
  // outer ipv4, followed by the packet it carries — is tagged 'gre' (the first tunnel layer found decides), the same
  // rule as device/process-ctx.ts `pduSummary`, so the link's frameTx/frameRx carry it. No P1/P2 PDU holds a gre layer.
  const ls = pdu.layers;
  if (ls.length >= 5) {
    for (let i = 1; i < ls.length - 1; i++) {
      const proto = ls[i]!.proto;
      if (proto === 'gre') {
        s.tunnel = 'gre';
        break;
      }
      // P3 [C13] (ruling R36): an ESP leg of a VTI — an esp layer after the frame and the outer ipv4 — is tagged 'ipsec'
      if (proto === 'esp') {
        s.tunnel = 'ipsec';
        break;
      }
      if (proto !== 'capwap') continue;
      const inner = ls[i + 1]!.proto;
      if (inner === 'dot11' || inner === 'ethernet') s.tunnel = 'capwap';
      break;
    }
  }
  return s;
}

/**
 * Inclusive byte range `[lo, hi]` a link corruption may flip: after the outer header, before the outer FCS (or
 * the outer trailer for codecs without an FCS entry). Without decoded layers the Ethernet sizes apply.
 * `lo <= hi` always holds (both are -1 for an empty PDU).
 */
export function corruptionWindow(pdu: Pick<Pdu, 'layers' | 'size'>): { lo: number; hi: number } {
  const outer = pdu.layers[0];
  const headerEnd = outer ? outer.offset + outer.headerLength : ETH_HEADER;
  const fcs = outer ? (OUTER_FCS_BYTES[outer.proto] ?? outer.trailerLength ?? 0) : ETH_FCS;
  const end = outer ? Math.min(pdu.size, outer.offset + outer.length) : pdu.size;
  const lo = Math.min(headerEnd, pdu.size - 1);
  const hi = Math.max(lo, end - fcs - 1);
  return { lo, hi };
}

/** Capture link type of a frame by its outer layer (ethernet, dot11, hdlc, bare IP). */
export function captureLinkTypeOf(pdu: Pick<Pdu, 'layers'>): CaptureLinkType {
  const outer = pdu.layers[0]?.proto;
  if (outer === 'dot11') return 'ieee802_11';
  if (outer === 'hdlc') return 'c_hdlc';
  // P3 [S19] (ruling R4; W2 fix, the capture report's cross-owner need): a PPP-framed leg is captured as PPP in HDLC-like
  // framing (pcap link type 50), never as Ethernet
  if (outer === 'ppp') return 'ppp_hdlc';
  if (outer === 'ipv4' || outer === 'ipv6') return 'raw';
  return 'ethernet';
}

/** Per-frame adjustments a radio link supplies on top of the cable pipeline. */
export interface P2PLegTuning {
  /** Packet error rate in permille folded into the loss draw: p = 1 − (1 − lossPct/100)(1 − perMille/1000). */
  perMille?: number;
  /** Distance used for propagation instead of `LinkState.lengthM`. */
  lengthM?: number;
  /** Velocity factor instead of the media table's (radio 1.0). */
  velocityFactor?: number;
  /** Medium tag written on frameTx and the in-flight leg. */
  medium?: MediumKind;
  /** Link rate shown on frameTx and the leg. */
  rateBps?: number;
  /** Received signal shown on frameTx. */
  rssiDbm?: number;
}

/** Construction options of a point-to-point strategy. */
export interface CableP2POptions {
  /** Link attached to a port (the facade's port index); consulted when `PortState.link` is unset. */
  linkOf(ref: PortRef): LinkId | undefined;
  /** Strategy kind: 'cable' (default) or 'radio' for PtP radio links reusing this pipeline. */
  kind?: Extract<MediumKind, 'cable' | 'radio'>;
  /** Radio links: per-frame RF adjustments. Absent (or undefined result) = plain cable behaviour. */
  tune?(state: LinkState, from: PortRef, to: PortRef, now: SimTime): P2PLegTuning | undefined;
}

/** The other end of `state` seen from `ref`. */
function peerRef(state: LinkState, ref: PortRef): PortRef {
  return ref.device === state.a.device && ref.port === state.a.port ? state.b : state.a;
}

/**
 * @since P2 (D23) The transmit queue of one port: txEnd times of its accepted frames, ascending (a port serializes in
 * order), kept in a ring of `cap` entries (`P2P_QUEUE_LIMIT`; P3 ruling R33: a serial control frame admitted past the
 * limit doubles the ring, keeping the order).
 */
interface TxBacklog {
  ends: number[];
  head: number;
  size: number;
  cap: number;
}

/** Append `end` to a backlog ring, growing it (in order) when it is full (only a serial control frame can, R33). */
function pushBacklogEnd(q: TxBacklog, end: number): void {
  if (q.size === q.cap) {
    const lin: number[] = [];
    for (let i = 0; i < q.size; i++) lin.push(q.ends[(q.head + i) % q.cap]!);
    q.ends = lin;
    q.head = 0;
    q.cap *= 2;
  }
  q.ends[(q.head + q.size) % q.cap] = end;
  q.size++;
}

/** @since P3 [S20]/[S21] A frame held by a scheduler port. */
interface HeldFrame {
  readonly pdu: Pdu;
  /** `pdu.size` when it was offered: the bytes its `TxOutcome sent` counts (the frame as the port handed it over). */
  readonly bytes: number;
}

/** @since P3 [S20]/[S21] The held queue of one scheduler port (file header). */
interface HeldQueue {
  readonly ref: PortRef;
  readonly key: string;
  /** The port's transmitter when the queue was installed (a port rebuilt at power-on gets a new one). */
  readonly tx: PortState['tx'];
  /** The spec the scheduler was built from (the last equal spec seen: the identity fast path of the sync). */
  spec: EgressSchedulerSpec;
  readonly sched: PortScheduler<HeldFrame>;
  /** [S21] The pending shaper gate: its `mediumTimer` seq and time. */
  gate?: { readonly seq: number; readonly at: SimTime };
}

/**
 * @since P3 [S20] Structural equality of two plain values (a compiled spec): same keys with defined values, same
 * primitives, arrays element by element. Lets a recompiled but unchanged spec keep its queue and counters.
 */
export function samePlainValue(x: unknown, y: unknown): boolean {
  if (x === y) return true;
  if (typeof x !== 'object' || typeof y !== 'object' || x === null || y === null) return false;
  if (Array.isArray(x) || Array.isArray(y)) {
    if (!Array.isArray(x) || !Array.isArray(y) || x.length !== y.length) return false;
    for (let i = 0; i < x.length; i++) if (!samePlainValue(x[i], y[i])) return false;
    return true;
  }
  const a = x as Record<string, unknown>;
  const b = y as Record<string, unknown>;
  const keysA = Object.keys(a).filter((k) => a[k] !== undefined);
  const keysB = Object.keys(b).filter((k) => b[k] !== undefined);
  if (keysA.length !== keysB.length) return false;
  for (const k of keysA) if (!samePlainValue(a[k], b[k])) return false;
  return true;
}

/** Create the point-to-point medium strategy (cables, and PtP radio links through `options.tune`). */
export function createCableP2P(host: MediumHost, options: CableP2POptions): MediumStrategy {
  const kind = options.kind ?? 'cable';
  /** Per-port transmit queues, keyed by the port's `tx` object (a port rebuilt at power-on starts empty). */
  const backlogs = new WeakMap<PortState['tx'], TxBacklog>();

  /** The queue of `port` at `now`: frames whose serialization ends at or after `now` (D23). */
  const backlogOf = (port: PortState, now: SimTime): TxBacklog => {
    let q = backlogs.get(port.tx);
    if (q === undefined) {
      q = { ends: [], head: 0, size: 0, cap: P2P_QUEUE_LIMIT };
      backlogs.set(port.tx, q);
    }
    const limit = q.cap;
    // A transmitter reset elsewhere (its busyUntil no longer ends our last frame) holds none of our frames.
    if (q.size > 0 && q.ends[(q.head + q.size - 1) % limit] !== port.tx.busyUntil) q.size = 0;
    while (q.size > 0 && q.ends[q.head]! < now) {
      q.head = (q.head + 1) % limit;
      q.size--;
    }
    return q;
  };

  const refuse = (pdu: Pdu, from: PortRef, now: SimTime, reason: 'link-down' | 'out-of-band' | 'queue-full' | 'policed', detail: string | undefined): TransmitResult => {
    const drop: Extract<TraceEvent, { kind: 'drop' }> = { t: now, kind: 'drop', pdu: summarizePdu(pdu), device: from.device, port: from.port, reason };
    if (detail !== undefined) drop.detail = detail;
    // P2 (§2.7): a dropped background PDU (keepalive) is marked so the trace filter and the canvas can hide it
    if (pdu.meta.background === true) drop.background = true;
    host.emit(drop);
    return { ok: false, reason };
  };

  /** What the sending end needs to put a frame on the wire now, or the refusal (its drop already emitted). */
  type Egress =
    | { readonly ok: true; readonly port: PortState; readonly state: LinkState; readonly peer: PortRef; readonly bps: number }
    | { readonly ok: false; readonly refused: TransmitResult };

  /** The refusals of the file header (no cable, no carrier, end down, out of band), in the P0 order. */
  const egressOf = (from: PortRef, pdu: Pdu, now: SimTime): Egress => {
    const port = host.port(from);
    const id = port?.link ?? options.linkOf(from);
    const state = id === undefined ? undefined : host.link(id);
    const peer = state ? peerRef(state, from) : undefined;
    const peerPort = peer ? host.port(peer) : undefined;
    const carrier = state ? (state.carrier ?? state.up) : false;
    const endUp = port !== undefined && (port.operUp || serialControlExempt(pdu, port));

    if (!port || !state || !peer || !peerPort || !carrier || !endUp || state.negotiatedBps === undefined) {
      const detail = !state ? 'no cable' : (state.downReason ?? port?.phy?.lineProtocolReason);
      return { ok: false, refused: refuse(pdu, from, now, 'link-down', detail) };
    }
    if (MEDIA[state.resolvedMedia].outOfBand === true) {
      return { ok: false, refused: refuse(pdu, from, now, 'out-of-band', OUT_OF_BAND_DETAIL) };
    }
    return { ok: true, port, state, peer, bps: state.negotiatedBps };
  };

  /** The virtual FIFO (P0 timing, P2 D23 queue, five draws at enqueue): every port without a scheduler, byte for byte. */
  const fifoTransmit = (from: PortRef, pdu: Pdu, now: SimTime): TransmitResult => {
    const egress = egressOf(from, pdu, now);
    if (!egress.ok) return egress.refused;
    const { port, state, peer, bps } = egress;
    // D23: a full queue refuses before any draw, so the frames that follow keep their loss/jitter pattern. P3 (ruling
    // R33): a serial control frame (HDLC keepalive, PPP LCP/PAP/CHAP/IPCP/IPV6CP) is never refused for a full queue, so
    // congestion alone never takes a serial line down; it still waits behind the frames committed before it.
    const backlog = backlogOf(port, now);
    if (backlog.size >= P2P_QUEUE_LIMIT && !isSerialControlFrame(pdu)) {
      return refuse(pdu, from, now, 'queue-full', `${P2P_QUEUE_LIMIT} frames already queued`);
    }

    const linkId: LinkId = state.id;
    const imp = state.impairments;
    const tune = options.tune?.(state, from, peer, now);
    const rng = host.stream(`link:${linkId}`);

    const txStart = Math.max(now, port.tx.busyUntil);
    const txEnd = txStart + serializationNs(pdu.size + phyOverheadBytes(state.resolvedMedia), bps);
    // P3 (D16, R15): a frame that waits behind the transmitter keeps its class for the FIFO view (before corruption)
    const dscp = txStart > now ? frameDscp(pdu) : undefined;

    // Five draws per frame, always in this order: loss, corrupt, jitter, corrupt-offset, corrupt-bit.
    const perMille = tune?.perMille ?? 0;
    const lossPct = perMille > 0 ? foldPerIntoLossPct(imp.lossPct, perMille) : imp.lossPct;
    const lost = rng.chance(lossPct / 100);
    const corrupted = rng.chance(imp.corruptPct / 100);
    const jitter = rng.nextInt(0, imp.jitterNs);
    const { lo, hi } = corruptionWindow(pdu);
    const byteOffset = rng.nextInt(lo, hi);
    const bitMask = 1 << rng.nextInt(0, 7);

    const lengthM = tune?.lengthM ?? state.lengthM;
    const vf = tune?.velocityFactor ?? MEDIA[state.resolvedMedia].velocityFactor;
    const arrive = txEnd + propagationNs(lengthM, vf) + imp.latencyNs + jitter;

    port.tx.busyUntil = txEnd;
    port.tx.queue++;
    pushBacklogEnd(backlog, txEnd);
    host.schedule(txEnd, { kind: 'txComplete', device: from.device, port: from.port });

    const summary = summarizePdu(pdu);
    const fromRef: PortRef = { device: from.device, port: from.port };
    const toRef: PortRef = { device: peer.device, port: peer.port };

    // Capture tap: the frame is on the medium now, before any corruption of the receiver's copy.
    host.capture({ t: txStart, dir: 'tx', port: fromRef, pdu, linkType: captureLinkTypeOf(pdu) });

    let arrivalSeq: number | undefined;
    if (lost) {
      const drop: Extract<TraceEvent, { kind: 'drop' }> = { t: now, kind: 'drop', pdu: summary, link: linkId, reason: 'link-loss', detail: `loss ${imp.lossPct}%` };
      if (pdu.meta.background === true) drop.background = true;
      host.emit(drop);
    } else if (corrupted) {
      pdu.corrupt({ now, device: from.device }, byteOffset, bitMask);
      arrivalSeq = host.schedule(arrive, { kind: 'frameArrival', device: peer.device, port: peer.port, pdu, corrupted: true });
    } else {
      arrivalSeq = host.schedule(arrive, { kind: 'frameArrival', device: peer.device, port: peer.port, pdu });
    }

    const tx: Extract<TraceEvent, { kind: 'frameTx' }> = {
      t: now, kind: 'frameTx', pdu: summary, link: linkId, from: fromRef, to: toRef, txStart, txEnd, arrive,
    };
    if (tune?.medium !== undefined) tx.medium = tune.medium;
    if (tune?.rateBps !== undefined) tx.rateBps = tune.rateBps;
    if (tune?.rssiDbm !== undefined) tx.rssiDbm = tune.rssiDbm;
    if (pdu.meta.background === true) tx.background = true;
    host.emit(tx);

    // Lost legs never reach `admit`; the amortized sweep keeps them from accumulating.
    host.inflight.sweep(now);
    const leg: InflightLeg = { pdu: summary, link: linkId, from: fromRef, to: toRef, txStart, txEnd, arrive };
    if (tune?.medium !== undefined) leg.medium = tune.medium;
    if (tune?.rateBps !== undefined) leg.rateBps = tune.rateBps;
    if (pdu.meta.background === true) leg.background = true;
    if (arrivalSeq !== undefined) leg.arrivalSeq = arrivalSeq;
    if (dscp !== undefined) leg.dscp = dscp;
    host.inflight.add(leg);

    const result: Extract<TransmitResult, { ok: true }> = { ok: true, link: linkId, txStart, txEnd, arrive };
    if (lost) result.lost = true;
    else if (corrupted) result.corrupted = true;
    return result;
  };

  // ── P3 [S20]/[S21]: the held queue of a scheduler port (file header) ──────────

  /** portKey → the held queue of a scheduler port. Lookup only; never iterated (no order to keep). */
  const helds = new Map<string, HeldQueue>();
  /** Only cables hold frames: a PtP radio port reuses this pipeline but keeps the virtual FIFO. */
  const schedules = kind === 'cable';

  /** The port's compiled output scheduler (undefined = the virtual FIFO); a spec without classes is none. */
  const specOf = (ref: PortRef): EgressSchedulerSpec | undefined => {
    const spec = schedules ? host.deps.egressPolicy?.(ref) : undefined;
    return spec !== undefined && spec.classes.length > 0 ? spec : undefined;
  };

  /** Hand a held frame to the virtual FIFO at `now` and report what became of it (`TxOutcome sent` or `dropped`). */
  const release = (ref: PortRef, item: HeldFrame, now: SimTime): void => {
    const res = fifoTransmit(ref, item.pdu, now);
    host.txOutcome(
      ref,
      res.ok ? { kind: 'sent', pdu: item.pdu.id, txStart: res.txStart, bytes: item.bytes } : { kind: 'dropped', pdu: item.pdu.id, reason: res.reason },
      now,
    );
  };

  const cancelGate = (held: HeldQueue): void => {
    if (held.gate === undefined) return;
    host.cancel(held.gate.seq);
    delete held.gate;
  };

  /** Remove a port's queue and hand its frames, in the order they would have left, to the virtual FIFO. */
  const uninstall = (held: HeldQueue, now: SimTime): void => {
    helds.delete(held.key);
    cancelGate(held);
    for (const item of held.sched.drain()) release(held.ref, item, now);
  };

  /** Drop every frame a queue holds (`link-down`: its link stopped, or its port was rebuilt). */
  const flush = (held: HeldQueue, now: SimTime, detail: string | undefined, report: boolean): void => {
    cancelGate(held);
    for (const item of held.sched.drain()) {
      const drop: Extract<TraceEvent, { kind: 'drop' }> = { t: now, kind: 'drop', pdu: summarizePdu(item.pdu), device: held.ref.device, port: held.ref.port, reason: 'link-down' };
      if (detail !== undefined) drop.detail = detail;
      if (item.pdu.meta.background === true) drop.background = true;
      host.emit(drop);
      if (report) host.txOutcome(held.ref, { kind: 'dropped', pdu: item.pdu.id, reason: 'link-down' }, now);
    }
  };

  /**
   * Bring the queue of `ref` in line with its current spec: an equal spec keeps it (and its counters); a removed or
   * different spec, or `keep === false` (the port no longer routes to this medium), uninstalls it; a spec without a
   * queue installs one. Returns the queue now in force, if any.
   */
  const syncHeld = (ref: PortRef, port: PortState, now: SimTime, keep = true): HeldQueue | undefined => {
    const key = portKey(ref);
    let held = helds.get(key);
    if (held !== undefined && held.tx !== port.tx) {
      // the port was rebuilt (power cycle): its frames belong to the old transmitter
      helds.delete(key);
      flush(held, now, undefined, false);
      held = undefined;
    }
    const spec = keep ? specOf(ref) : undefined;
    if (held !== undefined) {
      if (spec !== undefined && (spec === held.spec || samePlainValue(spec, held.spec))) {
        held.spec = spec;
        return held;
      }
      uninstall(held, now);
    }
    if (spec === undefined) return undefined;
    const fresh: HeldQueue = { ref: { device: ref.device, port: ref.port }, key, tx: port.tx, spec, sched: createPortScheduler<HeldFrame>(spec, now) };
    helds.set(key, fresh);
    return fresh;
  };

  /** Dequeue while the transmitter is free and no shaper gate is pending (file header). */
  const serve = (held: HeldQueue, now: SimTime): void => {
    for (;;) {
      const port = host.port(held.ref);
      if (port === undefined || port.tx !== held.tx || held.gate !== undefined || port.tx.busyUntil > now) return;
      const next = held.sched.dequeue(now);
      if (next.kind === 'empty') return;
      if (next.kind === 'wait') {
        const at = next.at;
        held.gate = { seq: host.schedule(at, { kind: 'mediumTimer', medium: qosMediumId(held.ref), key: QOS_SHAPER_TIMER_KEY }), at };
        return;
      }
      release(held.ref, next.item, now);
    }
  };

  /** Offer a frame that passed the refusals to the port's scheduler (file header). */
  const enqueueHeld = (held: HeldQueue, from: PortRef, port: PortState, state: LinkState, pdu: Pdu, now: SimTime, opts: TransmitOptions | undefined): TransmitResult => {
    const sched = held.sched;
    const cls = sched.classOf(opts?.qosClass);
    const c = sched.spec.classes[cls]!;
    const flow = c.kind !== 'priority' && c.fairQueue === true ? qosFlowOf(pdu) : undefined;
    const item: HeldFrame = { pdu, bytes: pdu.size };
    const idle = sched.depth === 0 && held.gate === undefined && port.tx.busyUntil <= now;
    const r = sched.enqueue(
      { item, bytes: pdu.size, qosClass: cls, ...(flow === undefined ? {} : { flow: flow.flow, flowWeight: flow.flowWeight }) },
      now,
      port.tx.busyUntil > now,
    );
    const deferred: TransmitResult = { ok: true, link: state.id, txStart: now, txEnd: now, arrive: now, deferred: true };
    // a tail drop is refused `queue-full`, a policer drop `policed` (ruling R35), both with the class's detail
    if (!r.ok) return refuse(pdu, from, now, r.reason, r.detail);
    if (idle) {
      // nothing ahead of it: the scheduler picks it at once (or its shaper gates it)
      const next = sched.dequeue(now);
      if (next.kind === 'packet') {
        if (next.item === item) return fifoTransmit(from, pdu, now);
        release(from, next.item, now); // never: an idle queue can only answer the frame just offered
      } else if (next.kind === 'wait') {
        held.gate = { seq: host.schedule(next.at, { kind: 'mediumTimer', medium: qosMediumId(from), key: QOS_SHAPER_TIMER_KEY }), at: next.at };
      }
    }
    host.emit({ t: now, kind: 'frameQueued', pdu: summarizePdu(pdu), device: from.device, port: from.port, queue: r.queue, depth: r.depth });
    return deferred;
  };

  const strategy: MediumStrategy = {
    kind,

    transmit(from, pdu, now, opts?: TransmitOptions): TransmitResult {
      // Without a scheduler anywhere the virtual FIFO answers alone (P1/P2 worlds: not even a spec lookup).
      if (!schedules || (host.deps.egressPolicy === undefined && helds.size === 0)) return fifoTransmit(from, pdu, now);
      const port = host.port(from);
      if (port === undefined) return fifoTransmit(from, pdu, now);
      const held = syncHeld(from, port, now);
      if (held === undefined) return fifoTransmit(from, pdu, now);
      // ruling R33: control traffic bypasses the class queues (it leaves next, behind the frame on the wire, through the
      // virtual FIFO, which never refuses a serial control frame) and is never classified or counted here
      if (isQosControlFrame(pdu)) return fifoTransmit(from, pdu, now);
      const egress = egressOf(from, pdu, now);
      if (!egress.ok) return egress.refused;
      return enqueueHeld(held, from, egress.port, egress.state, pdu, now, opts);
    },

    admit(ev: FrameArrivalBody, now: SimTime): ArrivalVerdict {
      const to: PortRef = { device: ev.device, port: ev.port };
      host.inflight.remove(ev.pdu.id, to);
      const wire = { t: now, dir: 'rx' as const, port: to, pdu: ev.pdu, linkType: captureLinkTypeOf(ev.pdu) };
      if (ev.corrupted === true) {
        host.capture({ ...wire, corrupted: true });
        return { deliver: true, pdu: ev.pdu, corrupted: true };
      }
      host.capture(wire);
      return { deliver: true, pdu: ev.pdu };
    },

    onTxComplete(ref: PortRef, now: SimTime): void {
      const p = host.port(ref);
      if (p && p.tx.queue > 0) p.tx.queue--;
      // P3 [S20]: a scheduler port's transmitter is free again: the next held frame leaves
      if (helds.size === 0 || p === undefined) return;
      if (!helds.has(portKey(ref))) return;
      const held = syncHeld(ref, p, now);
      if (held !== undefined) serve(held, now);
    },

    onMediumTimer(medium: MediumId, key: string, now: SimTime): OperChanges {
      // P3 [S21]: the shaper gate of a scheduler port opened
      if (!medium.startsWith(QOS_MEDIUM_PREFIX) || key !== QOS_SHAPER_TIMER_KEY) return [];
      const held = helds.get(medium.slice(QOS_MEDIUM_PREFIX.length));
      if (held === undefined || held.gate === undefined || held.gate.at !== now) return [];
      delete held.gate;
      const port = host.port(held.ref);
      if (port === undefined) return [];
      const cur = syncHeld(held.ref, port, now);
      if (cur !== undefined) serve(cur, now);
      return [];
    },

    abort(scope: LinkId | MediumId, now: SimTime, detail?: string): void {
      for (const leg of host.inflight.on(scope)) {
        // Lost legs have no arrival to cancel and are left to the normal pruning.
        if (leg.arrivalSeq === undefined) continue;
        host.cancel(leg.arrivalSeq);
        const drop: Extract<TraceEvent, { kind: 'drop' }> = { t: now, kind: 'drop', pdu: leg.pdu, link: scope, reason: 'link-down' };
        if (detail !== undefined) drop.detail = detail;
        if (leg.background === true) drop.background = true;
        host.emit(drop);
        host.emit({
          t: now, kind: 'frameAbort', pdu: leg.pdu, link: scope, from: leg.from, to: leg.to, abortAt: now, arrive: leg.arrive, reason: 'link-down',
        });
        host.inflight.delete(leg.pdu.id, leg.link, leg.to);
      }
      // P3 [S20]: the frames held at either end will never leave on this link
      if (helds.size === 0) return;
      const state = host.link(scope);
      if (state === undefined) return;
      for (const end of [state.a, state.b]) {
        const held = helds.get(portKey(end));
        if (held !== undefined) flush(held, now, detail, true);
      }
    },

    syncEgress(ref: PortRef, now: SimTime, viaThisMedium: boolean): void {
      if (!schedules || (host.deps.egressPolicy === undefined && helds.size === 0)) return;
      const port = host.port(ref);
      if (port === undefined) return;
      const held = syncHeld(ref, port, now, viaThisMedium);
      if (held !== undefined) serve(held, now);
    },

    egressQueues(ref: PortRef, now: SimTime): EgressQueueView | undefined {
      const held = helds.get(portKey(ref));
      const port = host.port(ref);
      if (held !== undefined && port !== undefined && held.tx === port.tx) return held.sched.view(now);
      const spec = specOf(ref);
      return spec === undefined ? undefined : createPortScheduler<HeldFrame>(spec, now).view(now);
    },
  };
  return strategy;
}
