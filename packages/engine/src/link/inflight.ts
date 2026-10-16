/**
 * link/inflight.ts — the facade-owned in-flight registry shared by every medium strategy (ARCHITECTURE-P1 §3.14,
 * contracts/link.ts `LinkModel` in-flight identity).
 *
 * Identity of a leg is `(pdu.id, link|medium, to)`: a broadcast on a segment or BSS has one entry per receiver leg,
 * a P2P cable one entry per frame. The registry never touches the scheduler or the trace; strategies cancel
 * arrivals and emit drops themselves.
 *
 * Determinism: legs live in insertion-ordered sets (since [S40] of the leg objects themselves, with no string keys);
 * `on(scope)` returns insertion order and `visible(now)` sorts explicitly by `(txStart, pdu.id, link, portKey(to))`
 * with ordinal string comparison.
 *
 * P3 (ARCHITECTURE-P3 D16, §2.8; W2 media): `queued(from, now)` lists the legs an egress port has committed but not
 * started yet (`txStart > now`, the virtual FIFO of `link/media/p2p.ts`), oldest first in the `visible` order, each with
 * the DSCP its medium recorded at enqueue (`frameDscp`). It reads a per-sender index kept beside the scope index, so a
 * snapshot asks each port in O(its own legs), and it never prunes: the snapshot cache's `PortSnapshot.txBacklog` reads
 * it without changing the registry. Legs whose `txStart <= now` (on the wire) are not listed, so an uncongested port
 * returns nothing.
 */
import type { LinkId, PduId, PortRef } from '../contracts/ids.js';
import { portKey } from '../contracts/ids.js';
import type { MediumId } from '../contracts/medium.js';
import type { PduView } from '../contracts/pdu.js';
import type { InflightFrame } from '../contracts/snapshot.js';
import type { SimTime } from '../contracts/time.js';
import type { InflightLeg, InflightRegistry, QueuedFrame } from './media/types.js';
import { compareOrdinal } from './media/types.js';

/** Registry size below which `sweep` never scans (the threshold never drops under it). */
export const INFLIGHT_SWEEP_MIN = 1024;

/** Map key of a leg: `${pdu}|${portKey(to)}|${link}` (the port key cannot contain '|', ids never do). */
export function inflightKey(pdu: PduId, link: LinkId | MediumId, to: PortRef): string {
  return `${pdu}|${portKey(to)}|${link}`;
}

/** Order of `visible`: `(txStart, pdu.id, link, portKey(to))`. */
export function compareInflight(x: InflightFrame, y: InflightFrame): number {
  return (
    x.txStart - y.txStart ||
    x.pdu.id - y.pdu.id ||
    compareOrdinal(x.link, y.link) ||
    compareOrdinal(portKey(x.to), portKey(y.to))
  );
}

/** Structured-clone-safe public copy of a leg (no scheduler seq, optional P0.5 fields only when present). */
export function publicFrame(leg: InflightLeg): InflightFrame {
  const out: InflightFrame = {
    pdu: leg.pdu,
    link: leg.link,
    from: leg.from,
    to: leg.to,
    txStart: leg.txStart,
    txEnd: leg.txEnd,
    arrive: leg.arrive,
  };
  if (leg.medium !== undefined) out.medium = leg.medium;
  if (leg.abortAt !== undefined) out.abortAt = leg.abortAt;
  if (leg.rateBps !== undefined) out.rateBps = leg.rateBps;
  if (leg.background !== undefined) out.background = leg.background;
  return out;
}

/**
 * @since P3 (ARCHITECTURE-P3 D16, ruling R15) The DSCP of a frame: that of its outermost IP header (IPv4 `dscp`, IPv6
 * `trafficClass >> 2`), or undefined when it carries none. Media record it on a leg committed with `txStart > now`.
 */
export function frameDscp(pdu: Pick<PduView, 'layers'>): number | undefined {
  for (const layer of pdu.layers) {
    if (layer.proto === 'ipv4') {
      const d = layer.fields.dscp;
      return typeof d === 'number' ? d & 0x3f : undefined;
    }
    if (layer.proto === 'ipv6') {
      const tc = layer.fields.trafficClass;
      return typeof tc === 'number' ? (tc >>> 2) & 0x3f : undefined;
    }
  }
  return undefined;
}

/** @since P3 The `queued` copy of a waiting leg: its public frame, plus the DSCP recorded at enqueue. */
function queuedFrame(leg: InflightLeg): QueuedFrame {
  const out: QueuedFrame = publicFrame(leg);
  if (leg.dscp !== undefined) out.dscp = leg.dscp;
  return out;
}

/** Delete every leg recorded on `scope` (arrived-or-not, lost legs included); returns how many were removed. */
export function clearScope(registry: InflightRegistry, scope: LinkId | MediumId): number {
  const legs = registry.on(scope);
  for (const leg of legs) registry.delete(leg.pdu.id, leg.link, leg.to);
  return legs.length;
}

/** Create an empty in-flight registry. */
export function createInflightRegistry(): InflightRegistry {
  // [S40] The indexes hold the leg objects themselves, keyed by the PDU id and by the parts of the port refs: no
  // `inflightKey` / `portKey` string is built or hashed per leg (they were the registry's whole cost in a storm). The
  // orders are the ones the string-keyed indexes had: a replaced leg leaves every index and re-enters at its end.
  /** Every leg, insertion ordered (`visible` and `sweep` scan it). */
  const legs = new Set<InflightLeg>();
  /** PDU id → its legs, insertion ordered (normally one). */
  const byPdu = new Map<PduId, InflightLeg[]>();
  /** scope → legs, insertion ordered. */
  const byScope = new Map<string, Set<InflightLeg>>();
  /** @since P3 sender device → sender port → legs, insertion ordered (the sender index `queued` reads). */
  const byFrom = new Map<string, Map<string, Set<InflightLeg>>>();
  let sweepAt = INFLIGHT_SWEEP_MIN;

  const samePort = (a: PortRef, b: PortRef): boolean => a.device === b.device && a.port === b.port;

  /** The leg of identity `(pdu, link, to)`, if held. */
  const find = (pdu: PduId, link: LinkId | MediumId, to: PortRef): InflightLeg | undefined => {
    const list = byPdu.get(pdu);
    if (list === undefined) return undefined;
    for (let i = 0; i < list.length; i++) {
      const leg = list[i]!;
      if (leg.link === link && samePort(leg.to, to)) return leg;
    }
    return undefined;
  };

  const unlink = (leg: InflightLeg): void => {
    legs.delete(leg);
    const id = leg.pdu.id;
    const list = byPdu.get(id);
    if (list) {
      const i = list.indexOf(leg);
      if (i >= 0) list.splice(i, 1);
      if (list.length === 0) byPdu.delete(id);
    }
    const scope = byScope.get(leg.link);
    if (scope) {
      scope.delete(leg);
      if (scope.size === 0) byScope.delete(leg.link);
    }
    const ports = byFrom.get(leg.from.device);
    const sender = ports?.get(leg.from.port);
    if (ports && sender) {
      sender.delete(leg);
      if (sender.size === 0) {
        ports.delete(leg.from.port);
        if (ports.size === 0) byFrom.delete(leg.from.device);
      }
    }
  };

  const registry: InflightRegistry = {
    add(leg) {
      const old = find(leg.pdu.id, leg.link, leg.to);
      if (old) unlink(old);
      legs.add(leg);
      const list = byPdu.get(leg.pdu.id);
      if (list) list.push(leg);
      else byPdu.set(leg.pdu.id, [leg]);
      let scope = byScope.get(leg.link);
      if (!scope) {
        scope = new Set();
        byScope.set(leg.link, scope);
      }
      scope.add(leg);
      let ports = byFrom.get(leg.from.device);
      if (!ports) {
        ports = new Map();
        byFrom.set(leg.from.device, ports);
      }
      let sender = ports.get(leg.from.port);
      if (!sender) {
        sender = new Set();
        ports.set(leg.from.port, sender);
      }
      sender.add(leg);
    },

    remove(pdu, to) {
      const list = byPdu.get(pdu);
      if (list === undefined) return undefined;
      for (let i = 0; i < list.length; i++) {
        const leg = list[i]!;
        if (samePort(leg.to, to)) {
          unlink(leg);
          return leg;
        }
      }
      return undefined;
    },

    on(scope) {
      const set = byScope.get(scope);
      return set ? [...set] : [];
    },

    delete(pdu, link, to) {
      const leg = find(pdu, link, to);
      if (!leg) return undefined;
      unlink(leg);
      return leg;
    },

    visible(now) {
      const out: InflightFrame[] = [];
      for (const leg of [...legs]) {
        if (leg.arrive <= now) {
          unlink(leg);
          continue;
        }
        if (leg.txStart > now) continue;
        out.push(publicFrame(leg));
      }
      out.sort(compareInflight);
      return out;
    },

    queued(from, now) {
      const set = byFrom.get(from.device)?.get(from.port);
      if (!set) return [];
      const out: QueuedFrame[] = [];
      for (const leg of set) if (leg.txStart > now) out.push(queuedFrame(leg));
      out.sort(compareInflight);
      return out;
    },

    sweep(now) {
      if (legs.size < sweepAt) return;
      for (const leg of [...legs]) if (leg.arrive <= now) unlink(leg);
      sweepAt = Math.max(INFLIGHT_SWEEP_MIN, legs.size * 2);
    },

    size() {
      return legs.size;
    },
  };
  return registry;
}
