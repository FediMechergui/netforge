/**
 * canvas/overlays/registry.ts — the topology overlay registry (ARCHITECTURE-P2 §6, D20; spec §9: a visualizer is a
 * module registered against a protocol and a set of curriculum objectives, so a lesson or lab can open the right one).
 *
 * Plain data (§0 rule 12): one entry per topology overlay, in paint order (the scene's layer containers are created in
 * this order under the cables, `scene.ts` `TOPO_LAYER_ORDER`). Each entry is
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
 * @since P3 (ARCHITECTURE-P3 §2.14, §6; W3 web-canvas) Five more entries: `qos` (M13: FIFO stacks, load sleeves and
 * the [S20] class lanes), [S1] `ospf`, [S3] `spf`, [S18]/[S19] `wan` and [C1] `eigrp`. The P3 entries switched from
 * the View menu (`ROUTING_OVERLAY_MODULES`: qos, ospf, wan, eigrp) key on the slice's P3 booleans; `spf` has no
 * toggle (`null`): it follows the SPF stepper, drawn while the link-state browser is on screen
 * (`OverlaySyncInput.routing`), for the router, area and frame its `routingUi` slice holds. `SWITCHING_OVERLAY_MODULES`
 * are the P2 entries, which the "Switching overlays" menu lists. The QoS entry keeps a short history of `outBytes` and
 * class-drop samples (`qos-model.ts` `pushLoadSample`), created on first use, so the load sleeves and the lanes' drop
 * tags compare against a sample about one second of simulated time old.
 *
 * Every cross-module reference is resolved at call time (the builders are called from inside arrow functions and the
 * memo caches are created on first use), so importing this module reads nothing from another module (f4f883e).
 * Pure: no Pixi, no store access (the slice arrives in `input`).
 */
import type { BuildStage, DeviceId, DeviceSnapshot, SimSnapshot, SimTime } from '@netforge/engine';
import type { RoutingUiState, TopoOverlayState } from '../../store/types';
import { buildCapwapOverlay, deriveDeviceCapwap, type CapwapOverlayModel, type DeviceCapwap } from './capwap-model';
import { buildEigrpOverlay, deriveDeviceEigrp, type DeviceEigrp, type EigrpOverlayModel } from './eigrp-model';
import { buildL2Overlay, deriveDeviceL2, type DeviceL2, type L2OverlayModel } from './l2-model';
import { buildOspfOverlay, deriveDeviceOspf, type DeviceOspf, type OspfOverlayModel } from './ospf-model';
import {
  buildQosLayerModel,
  deriveDeviceQos,
  loadBaseOf,
  loadSampleOf,
  pushLoadSample,
  type DeviceQos,
  type LoadSample,
  type QosLayerModel,
} from './qos-model';
import { buildSpfOverlay, lsdbOf, type DeviceLsdb, type SpfOverlayModel } from './spf-model';
import { buildStpOverlay, deriveDeviceStp, type DeviceStp, type StpOverlayModel } from './stp-model';
import { buildWanOverlay, deriveDeviceWan, type DeviceWan, type WanOverlayModel } from './wan-model';

/** The topology overlays, by id. */
export type OverlayId = 'vlan' | 'stp' | 'capwap' | 'qos' | 'ospf' | 'spf' | 'wan' | 'eigrp';

/** The P2 booleans of the slice: the "Switching overlays" toggles. */
export type SwitchingOverlayToggle = 'vlan' | 'stp' | 'capwap';
/** @since P3 The P3 booleans of the slice: the "Routing, WAN and QoS overlays" toggles. */
export type RoutingOverlayToggle = 'qos' | 'ospf' | 'wan' | 'eigrp';
/** A boolean key of the `topoOverlays` slice that shows an overlay. */
export type OverlayToggle = SwitchingOverlayToggle | RoutingOverlayToggle;

/** @since P3 [S3] What the `spf` layer follows: the link-state browser's selection, and whether its panel is shown. */
export interface OverlayRoutingInput {
  readonly ui: RoutingUiState;
  /** The link-state browser (with the SPF stepper) is on screen. */
  readonly shown: boolean;
}

/** What `sync` reads: the slice, the snapshot the canvas draws, and the sim clock (draining bars). */
export interface OverlaySyncInput {
  readonly state: TopoOverlayState;
  readonly snapshot: SimSnapshot | null;
  readonly now: SimTime;
  /** @since P3 `prefers-reduced-motion`: chips that would pulse ([S1] OSPF) stay static. Absent = false. */
  readonly reducedMotion?: boolean;
  /** @since P3 [S3] The SPF stepper's selection; absent = the `spf` layer is off. */
  readonly routing?: OverlayRoutingInput;
}

/** One registered overlay. `D` is its per-device data, `M` its render model, `T` its toggle. */
export interface OverlayModule<D, M, T extends OverlayToggle | null = OverlayToggle | null> {
  readonly id: OverlayId;
  /** Menu label (the View menu's overlay sections, web-shell). */
  readonly label: string;
  /** Tooltip sentence. */
  readonly hint: string;
  readonly since: BuildStage;
  /** Lesson ids this overlay illustrates (a lesson or its lab can switch it on). */
  readonly objectives: readonly string[];
  /** The boolean key of the slice that shows it; null for a layer another view drives ([S3] `spf`). */
  readonly toggle: T;
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
const qosPerDevice = lazyMemo<DeviceQos>(() => deriveDeviceQos);
const ospfPerDevice = lazyMemo<DeviceOspf>(() => deriveDeviceOspf);
const wanPerDevice = lazyMemo<DeviceWan>(() => deriveDeviceWan);
const eigrpPerDevice = lazyMemo<DeviceEigrp>(() => deriveDeviceEigrp);

function selectAll<T>(snapshot: SimSnapshot, perDevice: (d: DeviceSnapshot) => T): ReadonlyMap<DeviceId, T> {
  const out = new Map<DeviceId, T>();
  for (const d of snapshot.devices) out.set(d.id, perDevice(d));
  return out;
}

/** The VLAN overlay: access tints and chips, trunk rails and chips, mismatch pulses, the VLAN focus filter. */
export const VLAN_OVERLAY: OverlayModule<DeviceL2, L2OverlayModel, 'vlan'> = Object.freeze({
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
export const STP_OVERLAY: OverlayModule<DeviceStp, StpOverlayModel, 'stp'> = Object.freeze({
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
export const CAPWAP_OVERLAY: OverlayModule<DeviceCapwap, CapwapOverlayModel, 'capwap'> = Object.freeze({
  id: 'capwap',
  label: 'Controller tunnels',
  hint: 'Joins each lightweight access point to its controller and shows how far its join has got.',
  since: 'P2',
  objectives: Object.freeze(['ccna2-25-controllers-and-lightweight-aps', 'ccna2-27-wlans-on-a-controller']),
  toggle: 'capwap',
  select: (snapshot: SimSnapshot) => selectAll(snapshot, capwapPerDevice()),
  sync: (input: OverlaySyncInput) => (input.state.capwap && input.snapshot !== null ? buildCapwapOverlay(input.snapshot, capwapPerDevice()) : null),
});

// ── P3 ───────────────────────────────────────────────────────────────────────

/** The QoS load history, created on first use: one sample per snapshot object, trimmed to about one window. */
let qosHistory: LoadSample[] | undefined;
let qosSamples: WeakMap<SimSnapshot, LoadSample> | undefined;

/**
 * The sample the QoS model compares with: the current snapshot's sample joins the history (once per snapshot object;
 * the canvas and the outline sync the same snapshot), and the history's oldest sample older than now is the base.
 */
function qosBaseFor(snapshot: SimSnapshot, perDevice: (d: DeviceSnapshot) => DeviceQos): LoadSample | null {
  qosSamples ??= new WeakMap();
  let sample = qosSamples.get(snapshot);
  if (sample === undefined) {
    sample = loadSampleOf(snapshot, perDevice);
    qosSamples.set(snapshot, sample);
    qosHistory = pushLoadSample(qosHistory ?? [], sample);
  }
  return loadBaseOf(qosHistory ?? [], snapshot.now);
}

/** Forget the QoS load history (a test, or a new world: the next snapshot starts it again). */
export function resetQosHistory(): void {
  qosHistory = undefined;
  qosSamples = undefined;
}

/** @since P3 (M13, [S20]) The QoS overlay: FIFO stacks at congested ports, load sleeves, and the class lanes. */
export const QOS_OVERLAY: OverlayModule<DeviceQos, QosLayerModel, 'qos'> = Object.freeze({
  id: 'qos',
  label: 'Queues and link load',
  hint: 'Stacks the frames waiting at each congested port and wraps each cable in a sleeve as thick as its load.',
  since: 'P3',
  objectives: Object.freeze(['ccna3-26-why-traffic-needs-priority', 'ccna3-27-marking-queuing-and-policing']),
  toggle: 'qos',
  select: (snapshot: SimSnapshot) => selectAll(snapshot, qosPerDevice()),
  sync: (input: OverlaySyncInput) => {
    if (!input.state.qos || input.snapshot === null) return null;
    const perDevice = qosPerDevice();
    return buildQosLayerModel(input.snapshot, { base: qosBaseFor(input.snapshot, perDevice) }, perDevice);
  },
});

/** @since P3 [S1] The OSPF overlay: adjacencies on the cables, DR/BDR letters, costs, refusals and area zones. */
export const OSPF_OVERLAY: OverlayModule<DeviceOspf, OspfOverlayModel, 'ospf'> = Object.freeze({
  id: 'ospf',
  label: 'OSPF adjacencies',
  hint: 'Draws how far each neighbour relationship has come, the DR and BDR letters, interface costs and areas.',
  since: 'P3',
  objectives: Object.freeze([
    'ccna3-02-how-ospf-maps-a-network',
    'ccna3-03-neighbours-and-the-designated-router',
    'ccna3-04-switching-ospf-on',
    'ccna3-05-cost-and-the-best-path',
    'ccna3-06-default-routes-and-timers',
    'ccna3-07-fixing-ospf',
    'ccna3-08-more-than-one-area',
  ]),
  toggle: 'ospf',
  select: (snapshot: SimSnapshot) => selectAll(snapshot, ospfPerDevice()),
  sync: (input: OverlaySyncInput) =>
    input.state.ospf && input.snapshot !== null
      ? buildOspfOverlay(input.snapshot, { area: input.state.ospfArea, now: input.now, reducedMotion: input.reducedMotion === true }, ospfPerDevice())
      : null,
});

/** @since P3 [S3] The SPF layer: the SPF stepper's frame on the canvas (settled rings, cost chips, the tree underlay). */
export const SPF_OVERLAY: OverlayModule<DeviceLsdb, SpfOverlayModel, null> = Object.freeze({
  id: 'spf',
  label: 'SPF tree',
  hint: 'Follows the SPF stepper: rings the routers and networks as they settle, with their costs and the tree so far.',
  since: 'P3',
  objectives: Object.freeze(['ccna3-02-how-ospf-maps-a-network', 'ccna3-05-cost-and-the-best-path']),
  toggle: null,
  select: (snapshot: SimSnapshot) => selectAll(snapshot, lsdbOf),
  sync: (input: OverlaySyncInput) => {
    const routing = input.routing;
    if (routing === undefined || !routing.shown || input.snapshot === null) return null;
    return buildSpfOverlay(input.snapshot, { device: routing.ui.device, area: routing.ui.area, step: routing.ui.spf.step }, input.now, lsdbOf);
  },
});

/** @since P3 [S18]/[S19] (and [C13]) The WAN overlay: PPP phase rails at serial ends, tunnel tubes, IPsec state. */
export const WAN_OVERLAY: OverlayModule<DeviceWan, WanOverlayModel, 'wan'> = Object.freeze({
  id: 'wan',
  label: 'WAN links and tunnels',
  hint: 'Shows the phases a PPP link has passed and draws each tunnel over the network that carries it.',
  since: 'P3',
  objectives: Object.freeze(['ccna3-22-point-to-point-links', 'ccna3-24-gre-tunnels', 'ccna3-25-site-to-site-ipsec']),
  toggle: 'wan',
  select: (snapshot: SimSnapshot) => selectAll(snapshot, wanPerDevice()),
  sync: (input: OverlaySyncInput) => (input.state.wan && input.snapshot !== null ? buildWanOverlay(input.snapshot, wanPerDevice()) : null),
});

/** @since P3 [C1] The EIGRP overlay: successors and feasible successors for one destination, the feasibility text. */
export const EIGRP_OVERLAY: OverlayModule<DeviceEigrp, EigrpOverlayModel, 'eigrp'> = Object.freeze({
  id: 'eigrp',
  label: 'EIGRP successors',
  hint: 'For one destination, marks the route each router uses and the backup routes it keeps ready.',
  since: 'P3',
  objectives: Object.freeze(['ccna3-10-eigrp-and-its-metric', 'ccna3-33-a-method-for-enterprise-faults']),
  toggle: 'eigrp',
  select: (snapshot: SimSnapshot) => selectAll(snapshot, eigrpPerDevice()),
  sync: (input: OverlaySyncInput) =>
    input.state.eigrp && input.snapshot !== null ? buildEigrpOverlay(input.snapshot, { prefix: input.state.eigrpPrefix }, eigrpPerDevice()) : null,
});

/**
 * Every topology overlay, in paint order (bottom first): the P2 overlays as before, then the OSPF zones and
 * adjacencies, the EIGRP successors, the SPF tree, the WAN rails and tunnels, and last the QoS sleeves and queues (beside
 * the cables, so nothing covers them).
 */
export const OVERLAY_MODULES: readonly OverlayModule<unknown, unknown>[] = Object.freeze([
  VLAN_OVERLAY as OverlayModule<unknown, unknown>,
  STP_OVERLAY as OverlayModule<unknown, unknown>,
  CAPWAP_OVERLAY as OverlayModule<unknown, unknown>,
  OSPF_OVERLAY as OverlayModule<unknown, unknown>,
  EIGRP_OVERLAY as OverlayModule<unknown, unknown>,
  SPF_OVERLAY as OverlayModule<unknown, unknown>,
  WAN_OVERLAY as OverlayModule<unknown, unknown>,
  QOS_OVERLAY as OverlayModule<unknown, unknown>,
]);

/** The P2 overlays the "Switching overlays" menu toggles, in paint order. */
export const SWITCHING_OVERLAY_MODULES: readonly OverlayModule<unknown, unknown, SwitchingOverlayToggle>[] = Object.freeze([
  VLAN_OVERLAY as OverlayModule<unknown, unknown, SwitchingOverlayToggle>,
  STP_OVERLAY as OverlayModule<unknown, unknown, SwitchingOverlayToggle>,
  CAPWAP_OVERLAY as OverlayModule<unknown, unknown, SwitchingOverlayToggle>,
]);

/** @since P3 The P3 overlays the "Routing, WAN and QoS overlays" menu toggles, in its order (§2.14: qos, ospf, wan, eigrp). */
export const ROUTING_OVERLAY_MODULES: readonly OverlayModule<unknown, unknown, RoutingOverlayToggle>[] = Object.freeze([
  QOS_OVERLAY as OverlayModule<unknown, unknown, RoutingOverlayToggle>,
  OSPF_OVERLAY as OverlayModule<unknown, unknown, RoutingOverlayToggle>,
  WAN_OVERLAY as OverlayModule<unknown, unknown, RoutingOverlayToggle>,
  EIGRP_OVERLAY as OverlayModule<unknown, unknown, RoutingOverlayToggle>,
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
  // P3 (ARCHITECTURE-P3 §2.14, §9.2 item 23; the W2 web-shell slice migration, a reviewed additive edit): the QoS,
  // OSPF, WAN and EIGRP keys at their defaults, so this stays equal to the store's DEFAULT_TOPO_OVERLAYS.
  qos: false,
  ospf: false,
  ospfArea: null,
  wan: false,
  eigrp: false,
  eigrpPrefix: null,
});
