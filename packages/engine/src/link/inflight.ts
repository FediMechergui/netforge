/**
 * link/inflight.ts — the facade-owned in-flight registry shared by every medium strategy (ARCHITECTURE-P1 §3.14,
 * contracts/link.ts `LinkModel` in-flight identity).
 *
 * Identity of a leg is `(pdu.id, link|medium, to)`: a broadcast on a segment or BSS has one entry per receiver leg,
 * a P2P cable one entry per frame. The registry never touches the scheduler or the trace; strategies cancel
 * arrivals and emit drops themselves.
 *
 * Determinism: legs live in an insertion-ordered Map; `on(scope)` returns insertion order and `visible(now)` sorts
 * explicitly by `(txStart, pdu.id, link, portKey(to))` with ordinal string comparison.
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
  /** Every leg, insertion ordered. */
  const legs = new Map<string, InflightLeg>();
  /** `${pdu}|${portKey(to)}` → leg keys (normally one). */
  const byTarget = new Map<string, string[]>();
  /** scope → leg keys, insertion ordered. */
  const byScope = new Map<string, Set<string>>();
  /** @since P3 portKey(from) → leg keys, insertion ordered (the sender index `queued` reads). */
  const byFrom = new Map<string, Set<string>>();
  let sweepAt = INFLIGHT_SWEEP_MIN;

  const targetKey = (pdu: PduId, to: PortRef): string => `${pdu}|${portKey(to)}`;

  const unlink = (key: string, leg: InflightLeg): void => {
    legs.delete(key);
    const tk = targetKey(leg.pdu.id, leg.to);
    const list = byTarget.get(tk);
    if (list) {
      const i = list.indexOf(key);
      if (i >= 0) list.splice(i, 1);
      if (list.length === 0) byTarget.delete(tk);
    }
    const scope = byScope.get(leg.link);
    if (scope) {
      scope.delete(key);
      if (scope.size === 0) byScope.delete(leg.link);
    }
    const fk = portKey(leg.from);
    const sender = byFrom.get(fk);
    if (sender) {
      sender.delete(key);
      if (sender.size === 0) byFrom.delete(fk);
    }
  };

  const registry: InflightRegistry = {
    add(leg) {
      const key = inflightKey(leg.pdu.id, leg.link, leg.to);
      const old = legs.get(key);
      if (old) unlink(key, old);
      legs.set(key, leg);
      const tk = targetKey(leg.pdu.id, leg.to);
      const list = byTarget.get(tk);
      if (list) list.push(key);
      else byTarget.set(tk, [key]);
      let scope = byScope.get(leg.link);
      if (!scope) {
        scope = new Set();
        byScope.set(leg.link, scope);
      }
      scope.add(key);
      const fk = portKey(leg.from);
      let sender = byFrom.get(fk);
      if (!sender) {
        sender = new Set();
        byFrom.set(fk, sender);
      }
      sender.add(key);
    },

    remove(pdu, to) {
      const list = byTarget.get(targetKey(pdu, to));
      const key = list?.[0];
      if (key === undefined) return undefined;
      const leg = legs.get(key);
      if (!leg) return undefined;
      unlink(key, leg);
      return leg;
    },

    on(scope) {
      const keys = byScope.get(scope);
      if (!keys) return [];
      const out: InflightLeg[] = [];
      for (const k of keys) {
        const leg = legs.get(k);
        if (leg) out.push(leg);
      }
      return out;
    },

    delete(pdu, link, to) {
      const key = inflightKey(pdu, link, to);
      const leg = legs.get(key);
      if (!leg) return undefined;
      unlink(key, leg);
      return leg;
    },

    visible(now) {
      const out: InflightFrame[] = [];
      for (const [key, leg] of [...legs]) {
        if (leg.arrive <= now) {
          unlink(key, leg);
          continue;
        }
        if (leg.txStart > now) continue;
        out.push(publicFrame(leg));
      }
      out.sort(compareInflight);
      return out;
    },

    queued(from, now) {
      const keys = byFrom.get(portKey(from));
      if (!keys) return [];
      const out: QueuedFrame[] = [];
      for (const k of keys) {
        const leg = legs.get(k);
        if (leg !== undefined && leg.txStart > now) out.push(queuedFrame(leg));
      }
      out.sort(compareInflight);
      return out;
    },

    sweep(now) {
      if (legs.size < sweepAt) return;
      for (const [key, leg] of [...legs]) if (leg.arrive <= now) unlink(key, leg);
      sweepAt = Math.max(INFLIGHT_SWEEP_MIN, legs.size * 2);
    },

    size() {
      return legs.size;
    },
  };
  return registry;
}
