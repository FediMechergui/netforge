/**
 * capture/tap.ts — the NetScope live capture tap (ARCHITECTURE-P1 §4.12; contracts/capture.ts `CaptureTap`,
 * `WireEvent`; contracts/link.ts `LinkModelDeps.capture`).
 *
 * The link model is the only tap point: it reports tx when a frame starts on its medium (after egress rewrap,
 * before corruption) and rx in `admit` (before ingress rewrap, with `corrupted` / `fragmentBytes`). The Simulation
 * installs one {@link CaptureHub} as `LinkModelDeps.capture`; the hub fans each wire event out to the running
 * captures that watch the port.
 *
 *  • `wants(port)` is true only while some running capture watches the port, so taps cost nothing without captures.
 *  • Capture points: `resolveCapturePoints(spec, resolver)` = the spec's ports ∪ both ends of its links ∪ the members
 *    of its media, first occurrence order, each port once; with neither `ports` nor `links`, every port.
 *  • Interfaces: one per capture point, typed by the port encapsulation: ethernet → `ethernet` (fcsLen 4, the FCS
 *    stays in the record), dot11 → `ieee802_11` (FCS stripped, fcsLen 0), hdlc (and reserved ppp) → `c_hdlc`
 *    (2-byte CRC stripped, fcsLen 0), none → `raw` (fcsLen 0). A frame whose link type differs from its point's
 *    interface (the event's `linkType`, from the frame's outer layer) goes to an extra interface of that point and
 *    link type, named `<point> (<link type>)`, added on first use.
 *  • `record` copies `pdu.bytes` immediately (PDUs are mutated in place on later hops): the FCS bytes of the event's
 *    link type are stripped (802.11 4, HDLC 2); a collision fragment keeps only its leading `fragmentBytes` bytes
 *    (no trailer is stripped from a fragment) and is marked corrupted, with `origLen` the full frame length. One copy
 *    is shared by every capture that records the event (records are never modified).
 *  • Per capture: `dir` ('tx' | 'rx' | 'both', default both) filters events; background frames
 *    (`pdu.meta.background`: keepalives, beacons, periodic RAs) are skipped unless `includeBackground`.
 *  • Ids are `c_<n>` from a per-hub counter (1, 2, …) unless the caller passes one; the default name is
 *    `Capture <id>`.
 */
import type {
  CaptureId,
  CaptureInfo,
  CaptureLinkType,
  CaptureRecord,
  CaptureSpec,
  CaptureTap,
  WireEvent,
} from '../contracts/capture.js';
import type { PortEncap } from '../contracts/catalog.js';
import { portKey, type PortRef } from '../contracts/ids.js';
import { createCaptureStoreImpl, type CaptureStoreImpl } from './store.js';

/** Link type and FCS length of a capture interface. */
export interface CaptureLinkInfo {
  linkType: CaptureLinkType;
  fcsLen: 0 | 2 | 4;
}

/** One capture point: a port, its display name and its interface link type. */
export interface CapturePoint {
  ref: PortRef;
  /** Display name, e.g. 'PC1 Gi0'. */
  name: string;
  linkType: CaptureLinkType;
  fcsLen: 0 | 2 | 4;
}

/** What `resolveCapturePoints` needs to know about the world. */
export interface CapturePointResolver {
  /** Every port in device-creation then canonical port order (the default capture set). */
  allPorts(): readonly PortRef[];
  /** Both ends of a link, or the member ports of a segment / BSS / cell medium; undefined for an unknown id. */
  linkPorts(id: string): readonly PortRef[] | undefined;
  /** Display name of a port ('PC1 Gi0'); undefined for an unknown port. */
  portName(ref: PortRef): string | undefined;
  /** Outer encapsulation of a port. */
  encap(ref: PortRef): PortEncap | undefined;
}

/** FCS bytes a frame of this link type carries at the end of `Pdu.bytes` and that a capture strips. */
export const CAPTURE_STRIP_BYTES: Readonly<Record<CaptureLinkType, number>> = Object.freeze({ ethernet: 0, ieee802_11: 4, c_hdlc: 2, raw: 0 });

/** fcsLen of a live interface of this link type (the FCS bytes that remain in each record). */
export const CAPTURE_LIVE_FCS_LEN: Readonly<Record<CaptureLinkType, 0 | 2 | 4>> = Object.freeze({ ethernet: 4, ieee802_11: 0, c_hdlc: 0, raw: 0 });

/** Interface link type of a port by its encapsulation (see the file header). */
export function captureLinkForEncap(encap: PortEncap | undefined): CaptureLinkInfo {
  switch (encap) {
    case 'dot11':
      return { linkType: 'ieee802_11', fcsLen: 0 };
    case 'hdlc':
    case 'ppp':
      return { linkType: 'c_hdlc', fcsLen: 0 };
    case 'none':
      return { linkType: 'raw', fcsLen: 0 };
    case 'ethernet':
    case undefined:
      return { linkType: 'ethernet', fcsLen: 4 };
  }
}

/**
 * Resolve a capture spec to its points (see the file header). Throws an Error naming an unknown port or link.
 */
export function resolveCapturePoints(spec: CaptureSpec, resolver: CapturePointResolver): CapturePoint[] {
  const refs: PortRef[] = [];
  if (spec.ports === undefined && spec.links === undefined) refs.push(...resolver.allPorts());
  for (const p of spec.ports ?? []) {
    if (resolver.portName(p) === undefined) throw new Error(`There is no port ${p.port} on device ${p.device} to capture on.`);
    refs.push(p);
  }
  for (const id of spec.links ?? []) {
    const members = resolver.linkPorts(id);
    if (members === undefined) throw new Error(`There is no link or medium ${id} to capture on.`);
    refs.push(...members);
  }
  const seen = new Set<string>();
  const out: CapturePoint[] = [];
  for (const ref of refs) {
    const k = portKey(ref);
    if (seen.has(k)) continue;
    seen.add(k);
    const link = captureLinkForEncap(resolver.encap(ref));
    out.push({ ref: { device: ref.device, port: ref.port }, name: resolver.portName(ref) ?? k, linkType: link.linkType, fcsLen: link.fcsLen });
  }
  return out;
}

/** Bytes and original length a capture records for a wire event (see the file header). */
export function captureBytesOf(ev: Pick<WireEvent, 'pdu' | 'linkType' | 'fragmentBytes'>): { bytes: Uint8Array; origLen: number } {
  const src = ev.pdu.bytes;
  const strip = Math.min(src.length, CAPTURE_STRIP_BYTES[ev.linkType]);
  const full = src.length - strip;
  if (ev.fragmentBytes !== undefined) {
    const n = Math.max(0, Math.min(src.length, Math.floor(ev.fragmentBytes)));
    return { bytes: src.slice(0, n), origLen: Math.max(full, n) };
  }
  return { bytes: src.slice(0, full), origLen: full };
}

/** Options of a started capture. */
export interface CaptureStartOptions {
  /** Capture id; default the hub's next `c_<n>`. */
  id?: CaptureId;
}

/** The Simulation's capture hub: the link model tap plus the live capture registry. */
export interface CaptureHub extends CaptureTap {
  /** Start a live capture on resolved points; returns its store (running). */
  start(spec: CaptureSpec, points: readonly CapturePoint[], opts?: CaptureStartOptions): CaptureStoreImpl;
  /** Stop recording (the records stay); false for an unknown id. */
  stop(id: CaptureId): boolean;
  /** Drop a capture and its records; false for an unknown id. */
  remove(id: CaptureId): boolean;
  /** A capture's store. */
  get(id: CaptureId): CaptureStoreImpl | undefined;
  /** Every capture, in start order. */
  list(): CaptureInfo[];
  /** Remove every capture (world reset). The id counter keeps counting. */
  clear(): void;
}

interface LiveCapture {
  store: CaptureStoreImpl;
  spec: CaptureSpec;
  dir: 'tx' | 'rx' | 'both';
  /** portKey → interface index per link type. */
  ifaces: Map<string, Map<CaptureLinkType, number>>;
  /** portKey → display name and port of the point. */
  points: Map<string, { name: string; ref: PortRef }>;
}

/** Create a capture hub (install it as `LinkModelDeps.capture`). */
export function createCaptureHub(): CaptureHub {
  const captures = new Map<CaptureId, LiveCapture>();
  /** portKey → running captures watching it, in start order. Rebuilt on every start/stop/remove. */
  let watch = new Map<string, LiveCapture[]>();
  let counter = 0;

  const rebuild = (): void => {
    const next = new Map<string, LiveCapture[]>();
    for (const c of captures.values()) {
      if (!c.store.running) continue;
      for (const k of c.ifaces.keys()) {
        const list = next.get(k);
        if (list === undefined) next.set(k, [c]);
        else list.push(c);
      }
    }
    watch = next;
  };

  const ifaceFor = (c: LiveCapture, key: string, linkType: CaptureLinkType): number => {
    const byType = c.ifaces.get(key)!;
    const have = byType.get(linkType);
    if (have !== undefined) return have;
    const point = c.points.get(key)!;
    const idx = c.store.addInterface({
      ref: { device: point.ref.device, port: point.ref.port },
      name: `${point.name} (${linkType})`,
      linkType,
      fcsLen: CAPTURE_LIVE_FCS_LEN[linkType],
    });
    byType.set(linkType, idx);
    return idx;
  };

  return {
    wants(port) {
      return watch.has(portKey(port));
    },
    record(ev) {
      const key = portKey(ev.port);
      const list = watch.get(key);
      if (list === undefined) return;
      let copy: { bytes: Uint8Array; origLen: number } | undefined;
      const background = ev.pdu.meta.background === true;
      for (const c of list) {
        if (c.dir !== 'both' && c.dir !== ev.dir) continue;
        if (background && c.spec.includeBackground !== true) continue;
        copy ??= captureBytesOf(ev);
        const rec: CaptureRecord = {
          index: c.store.info().head,
          t: ev.t,
          iface: ifaceFor(c, key, ev.linkType),
          dir: ev.dir,
          bytes: copy.bytes,
          origLen: copy.origLen,
          pdu: ev.pdu.id,
        };
        if (ev.corrupted === true || ev.fragmentBytes !== undefined) rec.corrupted = true;
        c.store.append(rec);
      }
    },
    start(spec, points, opts) {
      let id = opts?.id;
      if (id === undefined) {
        do id = `c_${++counter}`;
        while (captures.has(id));
      } else if (captures.has(id)) {
        throw new Error(`A capture named ${id} already exists.`);
      }
      const store = createCaptureStoreImpl({
        id,
        name: spec.name ?? `Capture ${id}`,
        source: 'live',
        interfaces: points.map((p, index) => ({ index, ref: { device: p.ref.device, port: p.ref.port }, name: p.name, linkType: p.linkType, fcsLen: p.fcsLen })),
        ...(spec.maxRecords !== undefined ? { maxRecords: spec.maxRecords } : {}),
      });
      const ifaces = new Map<string, Map<CaptureLinkType, number>>();
      const named = new Map<string, { name: string; ref: PortRef }>();
      points.forEach((p, index) => {
        const k = portKey(p.ref);
        if (ifaces.has(k)) return;
        ifaces.set(k, new Map([[p.linkType, index]]));
        named.set(k, { name: p.name, ref: { device: p.ref.device, port: p.ref.port } });
      });
      captures.set(id, { store, spec: { ...spec }, dir: spec.dir ?? 'both', ifaces, points: named });
      rebuild();
      return store;
    },
    stop(id) {
      const c = captures.get(id);
      if (c === undefined) return false;
      c.store.setRunning(false);
      rebuild();
      return true;
    },
    remove(id) {
      if (!captures.delete(id)) return false;
      rebuild();
      return true;
    },
    get(id) {
      return captures.get(id)?.store;
    },
    list() {
      return [...captures.values()].map((c) => c.store.info());
    },
    clear() {
      captures.clear();
      rebuild();
    },
  };
}
