/**
 * canvas/overlays/neighbours-model.ts — [S26] the pure model behind the neighbours overlay (ARCHITECTURE-P3C §6, §7 W1c
 * web-canvas, §10.2; ARCHITECTURE-P3 §6's S26 row; lesson 28 "map an unknown network" on the canvas, W-12).
 *
 * From the `cdp-neighbours` and `lldp-neighbours` rows and the `cdp` / `lldp` process views of the snapshot only
 * (P3 D24), for the protocol chosen in the View menu (`topoOverlays.neighbourProtocol`: CDP, LLDP or both):
 *
 * - a **chip** at each cable end whose port holds a neighbour entry, `R1 · Gi0/0 · R` (the neighbour's name, its port
 *   and its capability letters), with a **holdtime ring**: the share of the entry's holdtime (CDP) or TTL (LLDP) still
 *   to run, so an entry about to age out shows an almost empty ring. With both protocols, one chip carries a neighbour
 *   that both report on the same port (`CDP+LLDP`), with the shorter of the two rings;
 * - a **hollow glyph** at a cable end whose device runs the protocol on that port, with the port up, but which holds no
 *   entry there: the device is listening and hears nothing (the far end does not run it, or does not send);
 * - **map from here**: from one device (the selected device), what its neighbour tables reach, hop by hop through each
 *   neighbour's own tables; every other device is dimmed, which is what a learner who can only read `show cdp
 *   neighbors` from that device could discover.
 *
 * A chip's neighbour is the device at the far end of its port's cable (the frame came over it), or, without a cable,
 * the device whose name or `hostname` is the entry's name. Every encoding keeps a non-colour channel (the chip text,
 * the ring's length, the hollow circle, the dim veil). Pure: no Pixi, no store. `deriveDeviceNeighbours` depends on one
 * device object only, so the registry memoises it per device object.
 */
import { SEC } from '@netforge/engine/contracts';
import type { CdpNeighbourRow, DeviceId, DeviceSnapshot, LinkId, LldpNeighbourRow, PortId, SimSnapshot, SimTime } from '@netforge/engine';

/** The protocol selector of the slice (`topoOverlays.neighbourProtocol`). */
export type NeighbourProtocolChoice = 'cdp' | 'lldp' | 'both';
/** One discovery protocol. */
export type NeighbourProtocol = 'cdp' | 'lldp';

/** Steps of the holdtime ring (the ring's share is rounded to 1/RING_STEPS, so a redraw is rare). */
export const NEIGHBOUR_RING_STEPS = 24;
/** The separator of a chip's parts. */
export const NEIGHBOUR_CHIP_SEPARATOR = ' · ';

// ── per device ───────────────────────────────────────────────────────────────

/** One neighbour entry as the overlay reads it. */
export interface NeighbourEntry {
  readonly protocol: NeighbourProtocol;
  readonly localPort: PortId;
  /** CDP device id; LLDP system name, else chassis id. */
  readonly name: string;
  /** The neighbour's port as it reports it. */
  readonly remotePort: string;
  /** Capability letters, space separated (`R S I`); '' when none are reported. */
  readonly capabilities: string;
  /** Holdtime (CDP) or TTL (LLDP), seconds. */
  readonly holdS: number;
  readonly expiresAt?: SimTime;
}

/** What the overlay reads of one device. */
export interface DeviceNeighbours {
  /** The device runs the protocol (its process view says running). */
  readonly runs: Readonly<Record<NeighbourProtocol, boolean>>;
  /** Ports where the protocol does not listen (`no cdp enable`, `no lldp receive`). */
  readonly deaf: Readonly<Record<NeighbourProtocol, ReadonlySet<PortId>>>;
  readonly entries: readonly NeighbourEntry[];
  /** The `hostname` of the rendered running config, when there is one. */
  readonly hostname?: string;
}

const EMPTY_PORTS: ReadonlySet<PortId> = new Set();

function rowsOf(d: DeviceSnapshot, name: string): readonly Record<string, unknown>[] | undefined {
  return (d.tables.extra ?? []).find((t) => t.name === name)?.rows;
}

function stateOf(d: DeviceSnapshot, process: string): Record<string, unknown> | undefined {
  return d.processes.find((p) => p.process === process)?.state;
}

function portList(v: unknown): ReadonlySet<PortId> {
  return Array.isArray(v) ? new Set(v.filter((x): x is string => typeof x === 'string')) : EMPTY_PORTS;
}

function letters(text: string | undefined): string {
  return (text ?? '')
    .split(/[\s,]+/)
    .filter((t) => t.length > 0)
    .join(' ');
}

/** Derive a device's discovery state. Pure in the device object. */
export function deriveDeviceNeighbours(d: DeviceSnapshot): DeviceNeighbours {
  const cdpRows = rowsOf(d, 'cdp-neighbours');
  const lldpRows = rowsOf(d, 'lldp-neighbours');
  const cdpState = stateOf(d, 'cdp');
  const lldpState = stateOf(d, 'lldp');
  const entries: NeighbourEntry[] = [];
  for (const raw of cdpRows ?? []) {
    const r = raw as unknown as CdpNeighbourRow;
    if (typeof r.localPort !== 'string' || typeof r.deviceId !== 'string') continue;
    entries.push({
      protocol: 'cdp',
      localPort: r.localPort,
      name: r.deviceId,
      remotePort: typeof r.remotePort === 'string' ? r.remotePort : '',
      capabilities: letters(r.capabilities),
      holdS: typeof r.holdtimeS === 'number' ? r.holdtimeS : 0,
      ...(typeof r.expiresAt === 'number' ? { expiresAt: r.expiresAt } : {}),
    });
  }
  for (const raw of lldpRows ?? []) {
    const r = raw as unknown as LldpNeighbourRow;
    if (typeof r.localPort !== 'string' || typeof r.chassisId !== 'string') continue;
    entries.push({
      protocol: 'lldp',
      localPort: r.localPort,
      name: r.systemName !== undefined && r.systemName !== '' ? r.systemName : r.chassisId,
      remotePort: typeof r.portId === 'string' ? r.portId : '',
      capabilities: letters(r.enabled ?? r.capabilities),
      holdS: typeof r.ttlS === 'number' ? r.ttlS : 0,
      ...(typeof r.expiresAt === 'number' ? { expiresAt: r.expiresAt } : {}),
    });
  }
  const host = /^hostname\s+(\S+)/m.exec(d.runningConfig)?.[1];
  return {
    runs: {
      cdp: cdpState !== undefined ? cdpState.running === true : (cdpRows?.length ?? 0) > 0,
      lldp: lldpState !== undefined ? lldpState.running === true : (lldpRows?.length ?? 0) > 0,
    },
    deaf: { cdp: portList(cdpState?.disabled), lldp: portList(lldpState?.noReceive) },
    entries,
    ...(host === undefined ? {} : { hostname: host }),
  };
}

/** The protocols a selector value shows. */
export function protocolsOf(choice: NeighbourProtocolChoice | null | undefined): readonly NeighbourProtocol[] {
  return choice === 'cdp' ? ['cdp'] : choice === 'lldp' ? ['lldp'] : ['cdp', 'lldp'];
}

/** The share of `holdS` still to run at `now`, rounded to 1/NEIGHBOUR_RING_STEPS (1 when the entry has no expiry). */
export function ringShare(expiresAt: SimTime | undefined, holdS: number, now: SimTime): number {
  if (expiresAt === undefined || !(holdS > 0)) return 1;
  const share = Math.min(1, Math.max(0, (expiresAt - now) / (holdS * SEC)));
  return Math.round(share * NEIGHBOUR_RING_STEPS) / NEIGHBOUR_RING_STEPS;
}

// ── the overlay model ────────────────────────────────────────────────────────

/** One chip at a cable end. */
export interface NeighbourChip {
  readonly device: DeviceId;
  readonly port: PortId;
  readonly link?: LinkId;
  readonly end?: 'a' | 'b';
  /** The protocols that report this neighbour on this port. */
  readonly protocols: readonly NeighbourProtocol[];
  readonly name: string;
  readonly remotePort: string;
  readonly capabilities: string;
  /** `R1 · Gi0/0 · R`. */
  readonly text: string;
  /** The share of the holdtime still to run (0…1, in 1/24 steps). */
  readonly ring: number;
  /** Seconds left before the entry ages out (rounded down); absent without an expiry. */
  readonly remainingS?: number;
  readonly holdS: number;
  /** The device the entry names, when it is in the world. */
  readonly peer?: DeviceId;
}

/** A cable end where the device listens and hears nobody. */
export interface NeighbourHollow {
  readonly device: DeviceId;
  readonly port: PortId;
  readonly link: LinkId;
  readonly end: 'a' | 'b';
  /** The protocols that listen there and hold no entry. */
  readonly protocols: readonly NeighbourProtocol[];
}

/** One device that runs a shown protocol. */
export interface NeighbourDeviceMark {
  readonly device: DeviceId;
  readonly protocols: readonly NeighbourProtocol[];
  /** Entries of the shown protocols. */
  readonly entries: number;
}

/** The neighbours overlay's full render model. */
export interface NeighboursModel {
  readonly protocol: NeighbourProtocolChoice;
  readonly chips: readonly NeighbourChip[];
  readonly hollows: readonly NeighbourHollow[];
  readonly devices: readonly NeighbourDeviceMark[];
  /** "Map from here": the device the map starts from, or null. */
  readonly from: DeviceId | null;
  /** The devices the map reaches from `from` (in snapshot order); empty when `from` is null. */
  readonly reachable: readonly DeviceId[];
  /** The devices it cannot reach (dimmed), in snapshot order; empty when `from` is null. */
  readonly dimmed: readonly DeviceId[];
}

/** Options of `buildNeighboursOverlay`. */
export interface NeighboursOptions {
  /** `topoOverlays.neighbourProtocol` (absent = both). */
  readonly protocol?: NeighbourProtocolChoice;
  /** The sim clock (the holdtime rings). */
  readonly now?: SimTime;
  /** "Map from here": the device the map starts from (the selected device); null or absent = no map. */
  readonly from?: DeviceId | null;
}

/** Build the neighbours overlay from a snapshot. Devices in snapshot order, ports in port order. */
export function buildNeighboursOverlay(
  snapshot: SimSnapshot,
  opts: NeighboursOptions = {},
  perDevice: (d: DeviceSnapshot) => DeviceNeighbours = deriveDeviceNeighbours,
): NeighboursModel {
  const protocol = opts.protocol ?? 'both';
  const shown = protocolsOf(protocol);
  const now = opts.now ?? snapshot.now;
  const derived = new Map<DeviceSnapshot, DeviceNeighbours>();
  const info = (d: DeviceSnapshot): DeviceNeighbours => {
    let v = derived.get(d);
    if (v === undefined) derived.set(d, (v = perDevice(d)));
    return v;
  };

  const endOf = new Map<string, { link: LinkId; end: 'a' | 'b'; far: { device: DeviceId; port: PortId }; up: boolean }>();
  for (const l of snapshot.links) {
    endOf.set(`${l.a.device}|${l.a.port}`, { link: l.id, end: 'a', far: l.b, up: l.up });
    endOf.set(`${l.b.device}|${l.b.port}`, { link: l.id, end: 'b', far: l.a, up: l.up });
  }
  const byId = new Map(snapshot.devices.map((d) => [d.id, d] as const));
  const byName = new Map<string, DeviceId>();
  for (const d of snapshot.devices) {
    const host = info(d).hostname;
    for (const n of [d.name, host]) if (n !== undefined && !byName.has(n.toLowerCase())) byName.set(n.toLowerCase(), d.id);
  }

  const chips: NeighbourChip[] = [];
  const hollows: NeighbourHollow[] = [];
  const marks: NeighbourDeviceMark[] = [];
  const adjacency = new Map<DeviceId, DeviceId[]>();
  for (const d of snapshot.devices) {
    const n = info(d);
    const running = shown.filter((p) => n.runs[p]);
    const entries = n.entries.filter((e) => shown.includes(e.protocol));
    if (running.length === 0 && entries.length === 0) continue;
    marks.push({ device: d.id, protocols: running, entries: entries.length });
    for (const p of d.ports) {
      const here = entries.filter((e) => e.localPort === p.id);
      const at = endOf.get(`${d.id}|${p.id}`);
      // one chip per neighbour name on the port; both protocols naming it share the chip
      const groups = new Map<string, NeighbourEntry[]>();
      for (const e of here) {
        const key = e.name.toLowerCase();
        groups.set(key, [...(groups.get(key) ?? []), e]);
      }
      for (const group of groups.values()) {
        const first = group[0] as NeighbourEntry;
        const viaCable = at?.far.device;
        const named = byName.get(first.name.toLowerCase());
        const peer = viaCable ?? named;
        const peerDevice = peer === undefined ? undefined : byId.get(peer);
        const remoteShort = peerDevice?.ports.find((q) => q.id === first.remotePort)?.short ?? first.remotePort;
        let ring = 1;
        let remainingS: number | undefined;
        for (const e of group) {
          ring = Math.min(ring, ringShare(e.expiresAt, e.holdS, now));
          if (e.expiresAt !== undefined) {
            const left = Math.max(0, Math.floor((e.expiresAt - now) / SEC));
            remainingS = remainingS === undefined ? left : Math.min(remainingS, left);
          }
        }
        const parts = [first.name, remoteShort];
        if (first.capabilities !== '') parts.push(first.capabilities);
        chips.push({
          device: d.id,
          port: p.id,
          ...(at === undefined ? {} : { link: at.link, end: at.end }),
          protocols: shown.filter((x) => group.some((e) => e.protocol === x)),
          name: first.name,
          remotePort: first.remotePort,
          capabilities: first.capabilities,
          text: parts.join(NEIGHBOUR_CHIP_SEPARATOR),
          ring,
          ...(remainingS === undefined ? {} : { remainingS }),
          holdS: Math.min(...group.map((e) => e.holdS)),
          ...(peer === undefined ? {} : { peer }),
        });
        if (peer !== undefined && peer !== d.id) adjacency.set(d.id, [...(adjacency.get(d.id) ?? []), peer]);
      }
      // a listening port, up and cabled, that heard nobody
      if (at !== undefined && at.up && p.operUp) {
        const silent = running.filter((x) => !n.deaf[x].has(p.id) && !here.some((e) => e.protocol === x));
        if (silent.length > 0 && here.length === 0) hollows.push({ device: d.id, port: p.id, link: at.link, end: at.end, protocols: silent });
      }
    }
  }

  const from = opts.from !== undefined && opts.from !== null && byId.has(opts.from) ? opts.from : null;
  let reachable: DeviceId[] = [];
  let dimmed: DeviceId[] = [];
  if (from !== null) {
    const seen = new Set<DeviceId>([from]);
    const queue: DeviceId[] = [from];
    for (let i = 0; i < queue.length; i++) {
      for (const w of adjacency.get(queue[i] as DeviceId) ?? []) {
        if (seen.has(w)) continue;
        seen.add(w);
        queue.push(w);
      }
    }
    reachable = snapshot.devices.filter((d) => seen.has(d.id)).map((d) => d.id);
    dimmed = snapshot.devices.filter((d) => !seen.has(d.id)).map((d) => d.id);
  }
  return { protocol, chips, hollows, devices: marks, from, reachable, dimmed };
}

/** True while some chip's ring is still running down (the layer redraws on the sim clock). */
export function neighboursModelNeedsClock(model: NeighboursModel | null): boolean {
  return model !== null && model.chips.some((c) => c.remainingS !== undefined && c.remainingS > 0);
}
