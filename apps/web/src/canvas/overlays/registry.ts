/**
 * canvas/overlays/registry.ts — the topology overlay registry (ARCHITECTURE-P2 §6, D20; spec §9: a visualizer is a
 * module registered against a protocol and a set of curriculum objectives, so a lesson or lab can open the right one).
 *
 * Plain data (§0 rule 12): one entry per overlay of the `topoOverlays` slice, in paint order (the scene's VLAN, STP and
 * CAPWAP layer containers, W3/W6, are created in this order under the devices layer). Each entry is
 *
 *   { id, label, hint, since, objectives, toggle, select(snapshot), sync(input) }
 *
 * - `select(snapshot)` derives the per-device data the overlay needs, memoised per device OBJECT (the store replaces a
 *   device object only when that device changed, and Canvas.tsx restyles every layer on every snapshot or delta, so
 *   an unchanged device is never re-derived);
 * - `sync(input)` turns the slice (`TopoOverlayState`) plus the snapshot and the sim clock into the overlay's render
 *   model, or null when the overlay is off (or there is no snapshot). The scene iterates `OVERLAY_MODULES` and hands
 *   each non-null model to the layer registered under the same id.
 *
 * Every cross-module reference is resolved at call time (the builders are called from inside arrow functions and the
 * memo caches are created on first use), so importing this module reads nothing from another module (f4f883e).
 * Pure: no Pixi, no store access (the slice arrives in `input`).
 */
import type { BuildStage, DeviceId, DeviceSnapshot, SimSnapshot, SimTime } from '@netforge/engine';
import type { TopoOverlayState } from '../../store/types';
import { buildCapwapOverlay, deriveDeviceCapwap, type CapwapOverlayModel, type DeviceCapwap } from './capwap-model';
import { buildL2Overlay, deriveDeviceL2, type DeviceL2, type L2OverlayModel } from './l2-model';
import { buildStpOverlay, deriveDeviceStp, type DeviceStp, type StpOverlayModel } from './stp-model';

/** The overlays of the `topoOverlays` slice, by id. */
export type OverlayId = 'vlan' | 'stp' | 'capwap';

/** What `sync` reads: the slice, the snapshot the canvas draws, and the sim clock (draining bars). */
export interface OverlaySyncInput {
  readonly state: TopoOverlayState;
  readonly snapshot: SimSnapshot | null;
  readonly now: SimTime;
}

/** One registered overlay. `D` is its per-device data, `M` its render model. */
export interface OverlayModule<D, M> {
  readonly id: OverlayId;
  /** Menu label (the "Switching overlays" menu, W2 web-shell). */
  readonly label: string;
  /** Tooltip sentence. */
  readonly hint: string;
  readonly since: BuildStage;
  /** CCNA 2 lesson ids this overlay illustrates (a lesson or its lab can switch it on). */
  readonly objectives: readonly string[];
  /** The boolean key of the slice that shows it. */
  readonly toggle: 'vlan' | 'stp' | 'capwap';
  /** Per-device data of a snapshot, memoised per device object. */
  select(snapshot: SimSnapshot): ReadonlyMap<DeviceId, D>;
  /** The render model for the current slice, or null when the overlay is off or there is no snapshot. */
  sync(input: OverlaySyncInput): M | null;
}

/** A per-device memo: derives once per device object (WeakMap, so replaced devices are collected). */
export function memoPerDevice<T>(derive: (d: DeviceSnapshot) => T): (d: DeviceSnapshot) => T {
  const cache = new WeakMap<DeviceSnapshot, T>();
  return (d) => {
    const hit = cache.get(d);
    if (hit !== undefined) return hit;
    const value = derive(d);
    cache.set(d, value);
    return value;
  };
}

/** A memoised derivation created on first use (no module-scope work). */
function lazyMemo<T>(derive: () => (d: DeviceSnapshot) => T): () => (d: DeviceSnapshot) => T {
  let memo: ((d: DeviceSnapshot) => T) | undefined;
  return () => (memo ??= memoPerDevice(derive()));
}

const l2PerDevice = lazyMemo<DeviceL2>(() => deriveDeviceL2);
const stpPerDevice = lazyMemo<DeviceStp>(() => deriveDeviceStp);
const capwapPerDevice = lazyMemo<DeviceCapwap>(() => deriveDeviceCapwap);

function selectAll<T>(snapshot: SimSnapshot, perDevice: (d: DeviceSnapshot) => T): ReadonlyMap<DeviceId, T> {
  const out = new Map<DeviceId, T>();
  for (const d of snapshot.devices) out.set(d.id, perDevice(d));
  return out;
}

/** The VLAN overlay: access tints and chips, trunk rails and chips, mismatch pulses, the VLAN focus filter. */
export const VLAN_OVERLAY: OverlayModule<DeviceL2, L2OverlayModel> = Object.freeze({
  id: 'vlan',
  label: 'VLANs',
  hint: 'Tints access ports by VLAN, draws trunks as rails with their VLAN lists, and flags ends that disagree.',
  since: 'P2',
  objectives: Object.freeze([
    'ccna2-04-why-split-a-lan',
    'ccna2-05-access-ports-and-the-vlan-list',
    'ccna2-06-trunks-and-tags',
    'ccna2-07-trunk-negotiation',
    'ccna2-08-voice-vlans',
    'ccna2-09-router-on-a-stick',
    'ccna2-10-multilayer-switching',
    'ccna2-11-fixing-inter-vlan-routing',
    'ccna2-24-hardening-switch-ports',
  ]),
  toggle: 'vlan',
  select: (snapshot: SimSnapshot) => selectAll(snapshot, l2PerDevice()),
  sync: (input: OverlaySyncInput) =>
    input.state.vlan && input.snapshot !== null ? buildL2Overlay(input.snapshot, { focus: input.state.vlanFocus }, l2PerDevice()) : null,
});

/** The spanning-tree overlay: root crown, role letters, state glyphs, the active tree, draining bars, change waves. */
export const STP_OVERLAY: OverlayModule<DeviceStp, StpOverlayModel> = Object.freeze({
  id: 'stp',
  label: 'Spanning tree',
  hint: 'Crowns the root bridge, letters every port with its role, crosses blocked ports and thickens the active tree.',
  since: 'P2',
  objectives: Object.freeze([
    'ccna2-12-what-a-loop-does',
    'ccna2-13-electing-a-root',
    'ccna2-14-port-roles-states-and-timers',
    'ccna2-15-rapid-spanning-tree',
    'ccna2-16-edge-ports-and-guards',
    'ccna2-17-bundling-links',
  ]),
  toggle: 'stp',
  select: (snapshot: SimSnapshot) => selectAll(snapshot, stpPerDevice()),
  sync: (input: OverlaySyncInput) =>
    input.state.stp && input.snapshot !== null
      ? buildStpOverlay(input.snapshot, { vlan: input.state.stpVlan, now: input.now }, stpPerDevice())
      : null,
});

/** The controller-tunnel overlay: an arc per access point and controller with the join state letters. */
export const CAPWAP_OVERLAY: OverlayModule<DeviceCapwap, CapwapOverlayModel> = Object.freeze({
  id: 'capwap',
  label: 'Controller tunnels',
  hint: 'Joins each lightweight access point to its controller and shows how far its join has got.',
  since: 'P2',
  objectives: Object.freeze(['ccna2-25-controllers-and-lightweight-aps', 'ccna2-27-wlans-on-a-controller']),
  toggle: 'capwap',
  select: (snapshot: SimSnapshot) => selectAll(snapshot, capwapPerDevice()),
  sync: (input: OverlaySyncInput) => (input.state.capwap && input.snapshot !== null ? buildCapwapOverlay(input.snapshot, capwapPerDevice()) : null),
});

/** Every topology overlay, in paint order (bottom first). */
export const OVERLAY_MODULES: readonly OverlayModule<unknown, unknown>[] = Object.freeze([
  VLAN_OVERLAY as OverlayModule<unknown, unknown>,
  STP_OVERLAY as OverlayModule<unknown, unknown>,
  CAPWAP_OVERLAY as OverlayModule<unknown, unknown>,
]);

/** The overlay with this id. */
export function overlayById(id: string): OverlayModule<unknown, unknown> | undefined {
  return OVERLAY_MODULES.find((m) => m.id === id);
}

/** Overlays that illustrate a lesson (a lesson id from `objectives`), in paint order. */
export function overlaysForLesson(lessonId: string): readonly OverlayModule<unknown, unknown>[] {
  return OVERLAY_MODULES.filter((m) => m.objectives.includes(lessonId));
}

/**
 * Every overlay off and no VLAN chosen: what the scene uses while the store has no `topoOverlays` slice yet (the slice
 * is optional in `UiState` until the W2 web-shell item implements it), like `CANVAS_OVERLAY_DEFAULTS` for the wireless
 * toggles.
 */
export const TOPO_OVERLAY_DEFAULTS: Readonly<TopoOverlayState> = Object.freeze({
  vlan: false,
  stp: false,
  stpVlan: null,
  vlanFocus: null,
  capwap: false,
});
