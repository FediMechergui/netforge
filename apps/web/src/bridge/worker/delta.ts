/**
 * Dirty-set tracking and delta assembly (protocol.ts header; ARCHITECTURE-P1 §3.14 "Worker", §12 item 24).
 *
 * Devices are marked dirty from the device/port/table fields of drained trace events:
 *   frameTx/frameAbort from+to, frameRx, drop, pduCreated/pduConsumed, tableWrite/tableExpire, log, portState,
 *   deviceState, configChange, debug (event.device), assocState station+ap, backoff, carrierDefer,
 *   topologyChanged op 'move' → the device,
 *   rfState → port.device and peer.device, plus "links changed",
 *   linkState, phyNegotiated → "links changed" plus both link ends,
 *   segmentChanged → "links changed" plus every member device,
 *   collision → every station.
 * P2 (ARCHITECTURE-P2 §2.7, §6): a `drop` flagged `background` (a BPDU a host discards, a keepalive) marks nothing —
 * it changes no table and no state a delta would carry, and marking would refresh every host twice a second.
 * API calls whose effect may emit no dirtying event mark their targets explicitly (`markDevices`, `markLinks`).
 *
 * A delta is valid only while the store's topologyVersion equals the snapshot's; the batcher sends a full snapshot
 * whenever it changes.
 */
import type { DeviceId, LinkId, SimSnapshot, TraceEvent } from '@netforge/engine';
import type { SnapshotDelta } from '../protocol';

/** A full snapshot replaces a delta when more than this fraction of devices is dirty. */
export const FULL_SNAPSHOT_DIRTY_FRACTION = 0.6;

/** Resolves the device ids at both ends of a link (undefined for unknown ids). */
export type LinkEndsResolver = (link: LinkId) => readonly [DeviceId, DeviceId] | undefined;

export interface DirtyTracker {
  /** Mark from one drained trace event. */
  observe(ev: TraceEvent): void;
  markDevices(ids: Iterable<DeviceId>): void;
  /** Links changed: the next delta carries the full link list. */
  markLinks(): void;
  readonly deviceCount: number;
  readonly linksDirty: boolean;
  readonly empty: boolean;
  /** Dirty devices (insertion order), plus `extra` ids not already present. */
  devices(extra?: Iterable<DeviceId>): DeviceId[];
  clear(): void;
}

export function createDirtyTracker(linkEnds: LinkEndsResolver): DirtyTracker {
  const devices = new Set<DeviceId>();
  let links = false;

  const mark = (id: DeviceId | undefined): void => {
    if (id !== undefined) devices.add(id);
  };
  const markLinkEnds = (id: LinkId): void => {
    links = true;
    const ends = linkEnds(id);
    if (ends !== undefined) {
      devices.add(ends[0]);
      devices.add(ends[1]);
    }
  };

  return {
    observe(ev) {
      switch (ev.kind) {
        case 'frameTx':
        case 'frameAbort':
          mark(ev.from.device);
          mark(ev.to.device);
          return;
        case 'frameRx':
        case 'pduCreated':
        case 'pduConsumed':
        case 'tableWrite':
        case 'tableExpire':
        case 'log':
        case 'portState':
        case 'deviceState':
        case 'configChange':
        case 'backoff':
        case 'carrierDefer':
          mark(ev.device);
          return;
        case 'drop':
          if (ev.background !== true) mark(ev.device);
          return;
        case 'debug':
          mark(ev.event.device);
          return;
        case 'assocState':
          mark(ev.station.device);
          mark(ev.ap?.device);
          return;
        case 'topologyChanged':
          if (ev.op === 'move' && ev.what === 'device') mark(ev.id);
          return;
        case 'rfState':
          links = true;
          mark(ev.port.device);
          mark(ev.peer.device);
          return;
        case 'linkState':
        case 'phyNegotiated':
          markLinkEnds(ev.link);
          return;
        case 'segmentChanged':
          links = true;
          for (const m of ev.members) mark(m.device);
          return;
        case 'collision':
          for (const st of ev.stations) mark(st.device);
          return;
        case 'mutation':
        case 'cliOutput':
        case 'cliPrompt':
          return;
      }
    },
    markDevices(ids) {
      for (const id of ids) devices.add(id);
    },
    markLinks() {
      links = true;
    },
    get deviceCount() {
      return devices.size;
    },
    get linksDirty() {
      return links;
    },
    get empty() {
      return devices.size === 0 && !links;
    },
    devices(extra) {
      const out = [...devices];
      if (extra !== undefined) for (const id of extra) if (!devices.has(id)) out.push(id);
      return out;
    },
    clear() {
      devices.clear();
      links = false;
    },
  };
}

/** True when a delta of `dirty` devices out of `total` should be a full snapshot instead. */
export function preferFullSnapshot(dirty: number, total: number): boolean {
  return total > 0 && dirty > total * FULL_SNAPSHOT_DIRTY_FRACTION;
}

/** Turn a subset snapshot (`Simulation.snapshot({devices})`) into a delta; links are kept only when changed. */
export function toDelta(subset: SimSnapshot, includeLinks: boolean): SnapshotDelta {
  const { links, ...rest } = subset;
  return includeLinks ? { ...rest, links } : rest;
}
