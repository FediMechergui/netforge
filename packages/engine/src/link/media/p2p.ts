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
 *     frames, not the event rate (line rate does). A refused frame draws nothing from `link:<id>`.
 *
 * In-flight legs are keyed `(pdu, link, to)` in the facade registry (link/inflight.ts). Capture tap: tx is recorded
 * when the frame starts (before corruption), rx in `admit` (after corruption).
 */
import type { CaptureLinkType } from '../../contracts/capture.js';
import type { LinkId, PortRef } from '../../contracts/ids.js';
import type { ArrivalVerdict, LinkState, TransmitResult } from '../../contracts/link.js';
import { MEDIA, P2P_QUEUE_LIMIT } from '../../contracts/link.js';
import type { PortState } from '../../contracts/port.js';
import type { MediumId, MediumKind } from '../../contracts/medium.js';
import type { Pdu, ProtoName } from '../../contracts/pdu.js';
import { DOT11_FCS, ETH_FCS, ETH_HEADER, HDLC_FCS } from '../../contracts/pdu.js';
import type { SimTime } from '../../contracts/time.js';
import { propagationNs, serializationNs } from '../../contracts/time.js';
import type { PduSummary, TraceEvent } from '../../contracts/trace.js';
import { phyOverheadBytes } from '../cabling.js';
import { foldPerIntoLossPct } from '../rf/mcs.js';
import { keepaliveExempt } from '../serial.js';
import type { FrameArrivalBody, InflightLeg, MediumHost, MediumStrategy } from './types.js';

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
  const ls = pdu.layers;
  if (ls.length >= 5) {
    for (let i = 1; i < ls.length - 1; i++) {
      if (ls[i]!.proto !== 'capwap') continue;
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
 * order), kept in a ring of at most `P2P_QUEUE_LIMIT` entries.
 */
interface TxBacklog {
  readonly ends: number[];
  head: number;
  size: number;
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
      q = { ends: [], head: 0, size: 0 };
      backlogs.set(port.tx, q);
    }
    const limit = P2P_QUEUE_LIMIT;
    // A transmitter reset elsewhere (its busyUntil no longer ends our last frame) holds none of our frames.
    if (q.size > 0 && q.ends[(q.head + q.size - 1) % limit] !== port.tx.busyUntil) q.size = 0;
    while (q.size > 0 && q.ends[q.head]! < now) {
      q.head = (q.head + 1) % limit;
      q.size--;
    }
    return q;
  };

  const refuse = (pdu: Pdu, from: PortRef, now: SimTime, reason: 'link-down' | 'out-of-band' | 'queue-full', detail: string | undefined): TransmitResult => {
    const drop: Extract<TraceEvent, { kind: 'drop' }> = { t: now, kind: 'drop', pdu: summarizePdu(pdu), device: from.device, port: from.port, reason };
    if (detail !== undefined) drop.detail = detail;
    // P2 (§2.7): a dropped background PDU (keepalive) is marked so the trace filter and the canvas can hide it
    if (pdu.meta.background === true) drop.background = true;
    host.emit(drop);
    return { ok: false, reason };
  };

  const strategy: MediumStrategy = {
    kind,

    transmit(from, pdu, now): TransmitResult {
      const port = host.port(from);
      const id = port?.link ?? options.linkOf(from);
      const state = id === undefined ? undefined : host.link(id);
      const peer = state ? peerRef(state, from) : undefined;
      const peerPort = peer ? host.port(peer) : undefined;
      const carrier = state ? (state.carrier ?? state.up) : false;
      const endUp = port !== undefined && (port.operUp || keepaliveExempt(pdu, port));

      if (!port || !state || !peer || !peerPort || !carrier || !endUp || state.negotiatedBps === undefined) {
        const detail = !state ? 'no cable' : (state.downReason ?? port?.phy?.lineProtocolReason);
        return refuse(pdu, from, now, 'link-down', detail);
      }
      if (MEDIA[state.resolvedMedia].outOfBand === true) {
        return refuse(pdu, from, now, 'out-of-band', OUT_OF_BAND_DETAIL);
      }
      // D23: a full queue refuses before any draw, so the frames that follow keep their loss/jitter pattern.
      const backlog = backlogOf(port, now);
      if (backlog.size >= P2P_QUEUE_LIMIT) {
        return refuse(pdu, from, now, 'queue-full', `${P2P_QUEUE_LIMIT} frames already queued`);
      }

      const linkId: LinkId = state.id;
      const imp = state.impairments;
      const tune = options.tune?.(state, from, peer, now);
      const rng = host.stream(`link:${linkId}`);

      const txStart = Math.max(now, port.tx.busyUntil);
      const txEnd = txStart + serializationNs(pdu.size + phyOverheadBytes(state.resolvedMedia), state.negotiatedBps);

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
      backlog.ends[(backlog.head + backlog.size) % P2P_QUEUE_LIMIT] = txEnd;
      backlog.size++;
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
      host.inflight.add(leg);

      const result: Extract<TransmitResult, { ok: true }> = { ok: true, link: linkId, txStart, txEnd, arrive };
      if (lost) result.lost = true;
      else if (corrupted) result.corrupted = true;
      return result;
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

    onTxComplete(ref: PortRef, _now: SimTime): void {
      const p = host.port(ref);
      if (p && p.tx.queue > 0) p.tx.queue--;
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
    },
  };
  return strategy;
}
