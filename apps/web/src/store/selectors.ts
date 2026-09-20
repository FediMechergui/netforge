/**
 * Selectors over the store, plus the non-hook clock extrapolation used by the canvas and the playback clock
 * between engine batches.
 *
 * Lookups by id go through `UiState.snapshotIndex` (O(1)); a stale index (a delta applied before the next full
 * snapshot, or a hand-built test state) falls back to a linear search, so a selector never returns the wrong
 * object. Hooks select plain references, so components re-render only when the selected object changes (the
 * store keeps the identity of devices a delta did not touch).
 */
import type {
  AssociationSnapshot,
  CliSessionView,
  DeviceId,
  DeviceModel,
  DeviceSnapshot,
  InflightFrame,
  LinkId,
  LinkSnapshot,
  ModuleModel,
  SessionId,
  SimTime,
} from '@netforge/engine';
import { useStore } from './store';
import type { UiState, WirelessOverlayState } from './types';

export { buildSnapshotIndex, mergeSnapshotDelta } from './store';

type IndexedState = Pick<UiState, 'snapshot' | 'snapshotIndex'>;

export function selectDevice(state: IndexedState, id: DeviceId | null | undefined): DeviceSnapshot | undefined {
  const snap = state.snapshot;
  if (id == null || !snap) return undefined;
  const i = state.snapshotIndex?.devices[id];
  if (i !== undefined) {
    const d = snap.devices[i];
    if (d !== undefined && d.id === id) return d;
  }
  return snap.devices.find((d) => d.id === id);
}

export function selectLink(state: IndexedState, id: LinkId | null | undefined): LinkSnapshot | undefined {
  const snap = state.snapshot;
  if (id == null || !snap) return undefined;
  const i = state.snapshotIndex?.links[id];
  if (i !== undefined) {
    const l = snap.links[i];
    if (l !== undefined && l.id === id) return l;
  }
  return snap.links.find((l) => l.id === id);
}

export function selectSession(state: Pick<UiState, 'snapshot'>, id: SessionId | null | undefined): CliSessionView | undefined {
  if (id == null) return undefined;
  return state.snapshot?.sessions.find((v) => v.id === id);
}

export function selectAssociation(state: Pick<UiState, 'snapshot'>, id: string | null | undefined): AssociationSnapshot | undefined {
  if (id == null) return undefined;
  return state.snapshot?.media?.associations.find((a) => a.id === id);
}

/** The device the current selection is about (device, port or slot selections). */
export function selectedDeviceId(state: Pick<UiState, 'selection'>): DeviceId | undefined {
  const sel = state.selection;
  if (!sel) return undefined;
  if (sel.kind === 'device') return sel.id;
  if (sel.kind === 'port') return sel.ref.device;
  if (sel.kind === 'slot') return sel.device;
  return undefined;
}

const modelIndexCache = new WeakMap<readonly DeviceModel[], Map<string, DeviceModel>>();
const moduleIndexCache = new WeakMap<readonly ModuleModel[], Map<string, ModuleModel>>();

/** Catalog model by type id (the per-catalog map is built once). */
export function selectModel(state: Pick<UiState, 'catalog'>, type: string | null | undefined): DeviceModel | undefined {
  if (type == null) return undefined;
  let map = modelIndexCache.get(state.catalog);
  if (!map) {
    map = new Map(state.catalog.map((m) => [m.type, m]));
    modelIndexCache.set(state.catalog, map);
  }
  return map.get(type);
}

/** Module model by type id. */
export function selectModule(state: Pick<UiState, 'modules'>, type: string | null | undefined): ModuleModel | undefined {
  if (type == null) return undefined;
  let map = moduleIndexCache.get(state.modules);
  if (!map) {
    map = new Map(state.modules.map((m) => [m.type, m]));
    moduleIndexCache.set(state.modules, map);
  }
  return map.get(type);
}

export function useDevice(id: DeviceId | null | undefined): DeviceSnapshot | undefined {
  return useStore((s) => selectDevice(s, id));
}

export function useSelectedDevice(): DeviceSnapshot | undefined {
  return useStore((s) => selectDevice(s, selectedDeviceId(s)));
}

export function useLink(id: LinkId | null | undefined): LinkSnapshot | undefined {
  return useStore((s) => selectLink(s, id));
}

export function useSession(id: SessionId | null | undefined): CliSessionView | undefined {
  return useStore((s) => selectSession(s, id));
}

export function useAssociation(id: string | null | undefined): AssociationSnapshot | undefined {
  return useStore((s) => selectAssociation(s, id));
}

export function useModel(type: string | null | undefined): DeviceModel | undefined {
  return useStore((s) => selectModel(s, type));
}

export function useModule(type: string | null | undefined): ModuleModel | undefined {
  return useStore((s) => selectModule(s, type));
}

export function useOverlay(key: keyof WirelessOverlayState): boolean {
  return useStore((s) => s.overlays[key]);
}

export function useInflight(): InflightFrame[] {
  return useStore((s) => s.inflight);
}

export function useNow(): SimTime {
  return useStore((s) => s.now);
}

/**
 * Sim time extrapolated to `wallNow` (performance.now()) from the last batch:
 * `now + effectiveRate × (wallNow − nowWall)` while playing, never below `now`.
 */
export function extrapolatedNow(
  state: Pick<UiState, 'now' | 'nowWall' | 'playing' | 'effectiveRate'>,
  wallNow: number,
): SimTime {
  if (!state.playing) return state.now;
  const t = state.now + state.effectiveRate * (wallNow - state.nowWall);
  return t > state.now ? Math.round(t) : state.now;
}
