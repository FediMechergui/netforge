/**
 * canvas/capwap.ts — the controller-tunnel (CAPWAP) overlay layer (ARCHITECTURE-P2 §6, §3.12, D17, D20; spec §9.6).
 * @since P2 (W6 web-canvas).
 *
 * Draws one TUNNEL per lightweight access point and controller it talks to, from the render model of
 * `canvas/overlays/capwap-model.ts` (the AP side's `capwap` rows, the "Controller tunnels" toggle of the
 * `topoOverlays` slice) and the controller side's `capwap-aps` rows (§2.6 `CapwapApRow`):
 *
 * - the tunnel is a hollow tube on a gentle arc (`airArc`, the path air packets take) from the access point's body to
 *   the controller's; it runs under the cables, like a trunk rail, and is never a dash pattern (D20);
 * - HOW FAR THE JOIN HAS GOT is the tube's fill: it grows from the access point towards the controller, one sixth per
 *   RFC 5415 step (discovery, DTLS, join, configure, data check, run), read against five tick marks across the tube,
 *   and a badge on the arc's middle names the step with its letters (Di / Dt / Jn / Cf / Dc / Run — the non-colour
 *   channel); a small padlock beside the badge says the control channel is protected (from the simulated DTLS step
 *   on, §3.12 step 3); a joined tunnel shows how many WLANs it received and, from the controller's row, how many
 *   wireless clients it carries;
 * - an access point still LOOKING for a controller it cannot reach on the canvas (a discovery broadcast to its subnet,
 *   or a controller address no device holds) has no tube: its badge sits beside the access point, under three
 *   broadcast arcs for a broadcast, with the address it asks as a caption when zoomed in;
 * - a session the CONTROLLER still lists while the access point reports none (the AP lost power or restarted; the
 *   controller forgets it only when its echo timer runs out) is an empty tube with a warning border and a `?` after the
 *   controller's letters.
 *
 * Two Pixi containers, like `L2Layer` and `StpLayer`: the underlay (`scene.layers.capwap`, below the cables: the tubes)
 * and `labels` (above the devices: badges, padlocks, broadcast arcs). The pure helpers (join steps, the tunnel views,
 * geometry, the text forms) have no Pixi dependency; the keyboard outline reads `capwapDeviceFacts`, so every fact
 * drawn here is also said. Cross-module constants are read at call time and the per-device derivation is memoised
 * per device object on first use (§0 rule 12).
 *
 * ponytail: the tunnel is not a hit target (select the access point or the controller: its tunnels light up), and
 * nothing animates — the fill moves when the rows change, which is what the learner watches.
 */
import { Container, Graphics, type Text } from 'pixi.js';
import { broadcastOf } from '@netforge/engine/pure';
import type { CapwapState, DeviceId, DeviceSnapshot, Ipv4Address, MacAddress, Selection, SimSnapshot } from '@netforge/engine';
import { airArc } from './air';
import { bezierAt, bezierTangent, geomBounds, sampleBezier, type CableGeom, type Pt } from './cables';
import type { OverlayFact } from './l2';
import { capwapLetter, type CapwapOverlayModel } from './overlays/capwap-model';
import { memoPerDevice } from './overlays/registry';
import { deviceBounds, type DeviceGeom, type Layout } from './ports';
import { inflateRect, makeText, rectsIntersect, setText, viewKey, type Lod, type Rect, type ThemeColors } from './scene';

// ── join steps ───────────────────────────────────────────────────────────────

/** The RFC 5415 steps of a join, in order (§3.12 step 3). `idle` comes before the first and counts as step 0. */
export const CAPWAP_JOIN_STEPS: readonly CapwapState[] = Object.freeze(['discovery', 'dtls', 'join', 'configure', 'data-check', 'run']);

/** Steps from the first request to `run`. */
export const CAPWAP_STEP_COUNT = 6;

/** The step a state has reached: 1 (discovery) … 6 (run); 0 for `idle` or a state this build does not know. */
export function capwapStep(state: string): number {
  const i = (CAPWAP_JOIN_STEPS as readonly string[]).indexOf(state);
  return i < 0 ? 0 : i + 1;
}

/** How far the join has got, 0 … 1: the part of the tube that is filled. */
export function capwapProgress(state: string): number {
  return capwapStep(state) / CAPWAP_STEP_COUNT;
}

/** True once the (simulated) DTLS step is done: every later control message is protected (§3.12 step 3, D8). */
export function capwapSecured(state: string): boolean {
  return capwapStep(state) >= 2;
}

const STATE_WORD: Readonly<Record<CapwapState, string>> = Object.freeze({
  idle: 'waiting for an address',
  discovery: 'looking for a controller',
  dtls: 'securing the control channel',
  join: 'asking to join',
  configure: 'receiving its configuration',
  'data-check': 'checking the data channel',
  run: 'joined',
});

/** The words of a join state ("asking to join"); the raw state when this build does not know it. */
export function capwapStateWord(state: string): string {
  return Object.prototype.hasOwnProperty.call(STATE_WORD, state) ? STATE_WORD[state as CapwapState] : state;
}

// ── the controller's side and the identity of an access point ────────────────

/** A session as the controller lists it (its `capwap-aps` row, §2.6 `CapwapApRow`; key = the AP's base MAC). */
export interface ControllerApSession {
  readonly apMac: MacAddress;
  readonly apIp: Ipv4Address;
  readonly name: string;
  readonly state: CapwapState;
  readonly clients: number;
}

/** What the layer needs of one device: the sessions it holds as a controller, and how an access point is recognised. */
export interface DeviceCapwapIdentity {
  /** Controller side: one session per access point, in row order. */
  readonly sessions: readonly ControllerApSession[];
  /**
   * Port MACs and the device's base MAC (a session names its AP by the base MAC its Vlan1 carries, §9.2 item 22b; a
   * D8 port MAC differs from the base only in its last octet, so the base is also derived for a device whose ports
   * have no ordinal-0 port, like the engine's `capwapBaseMac`).
   */
  readonly macs: readonly MacAddress[];
  /** IPv4 interface addresses with their prefix lengths (the session's AP address; the discovery broadcast). */
  readonly addresses: readonly { readonly address: Ipv4Address; readonly prefixLen: number }[];
}

/** A device's controller sessions and identity. Pure in the device object (memoised per device object). */
export function deriveCapwapIdentity(d: DeviceSnapshot): DeviceCapwapIdentity {
  const rows = (d.tables.extra ?? []).find((t) => t.name === 'capwap-aps')?.rows ?? [];
  const sessions: ControllerApSession[] = [];
  for (const r of rows) {
    if (typeof r.apMac !== 'string' || typeof r.state !== 'string') continue;
    sessions.push({
      apMac: r.apMac,
      apIp: typeof r.apIp === 'string' ? r.apIp : '',
      name: typeof r.name === 'string' ? r.name : '',
      state: r.state as CapwapState,
      clients: typeof r.clients === 'number' ? r.clients : 0,
    });
  }
  const macs: MacAddress[] = [];
  const addresses: { address: Ipv4Address; prefixLen: number }[] = [];
  const addMac = (mac: MacAddress): void => {
    if (!macs.includes(mac)) macs.push(mac);
  };
  for (const p of d.ports) {
    if (typeof p.mac === 'string' && p.mac !== '') addMac(p.mac);
    if (p.l3.ipv4 !== undefined) addresses.push({ address: p.l3.ipv4.address, prefixLen: p.l3.ipv4.prefixLen });
  }
  const first = macs[0];
  if (first !== undefined) addMac(baseMacOf(first));
  return { sessions, macs, addresses };
}

/** The base form of a D8 port MAC: the same MAC with its ordinal octet (the last) cleared. */
export function baseMacOf(mac: MacAddress): MacAddress {
  const cut = mac.lastIndexOf(':');
  return cut < 0 ? mac : `${mac.slice(0, cut + 1)}00`;
}

let identityMemo: ((d: DeviceSnapshot) => DeviceCapwapIdentity) | undefined;

/** The memoised derivation, created on first use (no module-scope work, §0 rule 12). */
function identityOf(d: DeviceSnapshot): DeviceCapwapIdentity {
  identityMemo ??= memoPerDevice(deriveCapwapIdentity);
  return identityMemo(d);
}

const NO_IDENTITY: DeviceCapwapIdentity = Object.freeze({ sessions: [], macs: [], addresses: [] });

/** The session a controller holds for this access point: by its base MAC first, else by its address. */
export function sessionFor(sessions: readonly ControllerApSession[], ap: DeviceCapwapIdentity): ControllerApSession | undefined {
  const byMac = sessions.find((s) => ap.macs.includes(s.apMac));
  if (byMac !== undefined) return byMac;
  return sessions.find((s) => s.apIp !== '' && ap.addresses.some((a) => a.address === s.apIp));
}

/** True when `address` is the limited broadcast or the broadcast of one of the access point's own subnets. */
export function isDiscoveryBroadcast(address: Ipv4Address, ap: DeviceCapwapIdentity): boolean {
  if (address === '255.255.255.255') return true;
  return ap.addresses.some((a) => a.prefixLen < 31 && broadcastOf(a.address, a.prefixLen) === address);
}

// ── the tunnels to draw ──────────────────────────────────────────────────────

/** One tunnel as the layer draws it and the outline says it. */
export interface CapwapTunnelView {
  /** Stable key: `<ap>><controller address>` for the AP's own rows, `<controller><<AP MAC>` for a controller-only one. */
  readonly key: string;
  /** 'ap': the access point's own row (its state is drawn); 'controller': only the controller still lists it. */
  readonly origin: 'ap' | 'controller';
  readonly ap: DeviceId;
  /** The controller device, or null when no device of the workspace holds the address the access point uses. */
  readonly controller: DeviceId | null;
  /** The address the access point sends to (null for a controller-only session). */
  readonly controllerAddress: Ipv4Address | null;
  /** The state drawn: the access point's (origin 'ap') or the controller's (origin 'controller'). */
  readonly state: CapwapState;
  /** Badge letters (`?` appended for a controller-only session). */
  readonly letter: string;
  /** 1 … 6, 0 for idle (`capwapStep`). */
  readonly step: number;
  /** 0 … 1, the filled part of the tube (0 for a controller-only session: the access point reports nothing). */
  readonly progress: number;
  readonly joined: boolean;
  /** The control channel is protected (from the simulated DTLS step on). */
  readonly secured: boolean;
  /** WLANs the controller pushed (the AP row's `wlans`). */
  readonly wlans: number;
  /** The access point asks every device of its subnet: discovery to the subnet (or limited) broadcast. */
  readonly broadcast: boolean;
  /** The controller's own session for this access point, when the controller is on the canvas and lists it. */
  readonly session?: ControllerApSession;
}

/**
 * The tunnels of a model, in model order (devices in snapshot order, rows in row order), then the sessions a controller
 * lists that no access point row accounts for (controllers in snapshot order, rows in row order; skipped when no device
 * of the workspace is that access point). Pure; empty without a model (the overlay is off) or a snapshot.
 */
export function capwapTunnelViews(model: CapwapOverlayModel | null, snapshot: SimSnapshot | null): readonly CapwapTunnelView[] {
  if (model === null || snapshot === null) return [];
  const byId = new Map<DeviceId, DeviceSnapshot>();
  for (const d of snapshot.devices) byId.set(d.id, d);
  const identity = (id: DeviceId | null): DeviceCapwapIdentity => {
    const d = id === null ? undefined : byId.get(id);
    return d === undefined ? NO_IDENTITY : identityOf(d);
  };
  const views: CapwapTunnelView[] = [];
  const claimed = new Set<string>();
  for (const t of model.tunnels) {
    const ap = identity(t.ap);
    const session = t.controller === null ? undefined : sessionFor(identity(t.controller).sessions, ap);
    if (session !== undefined && t.controller !== null) claimed.add(`${t.controller}|${session.apMac}`);
    const step = capwapStep(t.state);
    views.push({
      key: `${t.ap}>${t.controllerAddress}`,
      origin: 'ap',
      ap: t.ap,
      controller: t.controller,
      controllerAddress: t.controllerAddress,
      state: t.state,
      letter: t.letter,
      step,
      progress: step / CAPWAP_STEP_COUNT,
      joined: t.joined,
      secured: capwapSecured(t.state),
      wlans: t.wlans,
      broadcast: t.controller === null && isDiscoveryBroadcast(t.controllerAddress, ap),
      ...(session === undefined ? {} : { session }),
    });
  }
  for (const d of snapshot.devices) {
    const own = identityOf(d);
    for (const s of own.sessions) {
      if (claimed.has(`${d.id}|${s.apMac}`)) continue;
      const ap = apDeviceOf(snapshot, s, d.id);
      if (ap === undefined) continue;
      views.push({
        key: `${d.id}<${s.apMac}`,
        origin: 'controller',
        ap,
        controller: d.id,
        controllerAddress: null,
        state: s.state,
        letter: `${capwapLetter(s.state)}?`,
        step: capwapStep(s.state),
        progress: 0,
        joined: false,
        secured: capwapSecured(s.state),
        wlans: 0,
        broadcast: false,
        session: s,
      });
    }
  }
  return views;
}

/** The device a controller session names: the one carrying its base MAC, else the one holding its address. */
function apDeviceOf(snapshot: SimSnapshot, s: ControllerApSession, controller: DeviceId): DeviceId | undefined {
  for (const d of snapshot.devices) if (d.id !== controller && identityOf(d).macs.includes(s.apMac)) return d.id;
  if (s.apIp === '') return undefined;
  for (const d of snapshot.devices) if (d.id !== controller && identityOf(d).addresses.some((a) => a.address === s.apIp)) return d.id;
  return undefined;
}

// ── geometry ─────────────────────────────────────────────────────────────────

/** Bulge of the tunnel arc (`airArc`'s bend: a fraction of the distance, capped by airArc at 60 world units). */
export const TUNNEL_BEND = 0.22;
/** World units the tube keeps clear of a device's body and name block. */
export const TUNNEL_CLEARANCE = 6;
/** Outer width of the tube (world units at zoom quantum 1). */
export const TUBE_WIDTH = 7;
/** Width of the progress fill inside the tube. */
export const FILL_WIDTH = 4;
/** Points sampled along a tube. */
export const TUNNEL_SAMPLES = 32;
/** Zoom at or above which a joined tunnel shows its WLAN and client counts. */
export const CAPWAP_CAPTION_MIN_ZOOM = 0.8;
/** Vertical spacing of stacked stub badges beside one access point. */
export const STUB_STEP = 18;

/**
 * Where a ray from `from` towards `toward` leaves `box` (a point inside the box). When `toward` lies inside the box too,
 * the ray stops there, so a tunnel between overlapping devices never overshoots.
 */
export function boxExit(from: Pt, box: Rect, toward: Pt): Pt {
  const dx = toward.x - from.x;
  const dy = toward.y - from.y;
  if (Math.abs(dx) < 1e-9 && Math.abs(dy) < 1e-9) return { x: from.x, y: box.minY };
  let t = Number.POSITIVE_INFINITY;
  if (dx > 0) t = Math.min(t, (box.maxX - from.x) / dx);
  if (dx < 0) t = Math.min(t, (box.minX - from.x) / dx);
  if (dy > 0) t = Math.min(t, (box.maxY - from.y) / dy);
  if (dy < 0) t = Math.min(t, (box.minY - from.y) / dy);
  const k = Number.isFinite(t) && t > 0 ? Math.min(t, 1) : 0;
  return { x: from.x + dx * k, y: from.y + dy * k };
}

/** The clearance box of a device: its body and name block (`deviceBounds`), grown by `TUNNEL_CLEARANCE`. */
export function tunnelBox(g: DeviceGeom): Rect {
  return inflateRect(deviceBounds(g, false), TUNNEL_CLEARANCE);
}

/** The arc of a tunnel: from the access point's clearance box towards the controller's, bulging left of travel. */
export function tunnelGeometry(ap: DeviceGeom, controller: DeviceGeom): CableGeom {
  const a = boxExit({ x: ap.x, y: ap.y }, tunnelBox(ap), { x: controller.x, y: controller.y });
  const b = boxExit({ x: controller.x, y: controller.y }, tunnelBox(controller), { x: ap.x, y: ap.y });
  return airArc(a, b, TUNNEL_BEND);
}

/** The filled part of a tube: points from the access point end (u = 0) to `progress`, both included. */
export function progressPoints(geom: CableGeom, progress: number, samples = TUNNEL_SAMPLES): Pt[] {
  const p = Math.min(1, Math.max(0, progress));
  if (p === 0) return [];
  const n = Math.max(1, Math.ceil(samples * p));
  const out: Pt[] = [];
  for (let i = 0; i <= n; i++) out.push(bezierAt(geom, (p * i) / n));
  return out;
}

/** The five tick marks across a tube at the step boundaries (u = k/6), each `half` world units either side. */
export function stepTicks(geom: CableGeom, half: number): { readonly a: Pt; readonly b: Pt }[] {
  const out: { a: Pt; b: Pt }[] = [];
  for (let k = 1; k < CAPWAP_STEP_COUNT; k++) {
    const u = k / CAPWAP_STEP_COUNT;
    const p = bezierAt(geom, u);
    const t = bezierTangent(geom, u);
    const nx = -t.y;
    const ny = t.x;
    out.push({ a: { x: p.x - nx * half, y: p.y - ny * half }, b: { x: p.x + nx * half, y: p.y + ny * half } });
  }
  return out;
}

/** Where the `index`-th stub badge of an access point sits: beside its body, top right, stacking upwards. */
export function stubPoint(ap: Pick<DeviceGeom, 'x' | 'y' | 'halfW' | 'halfH'>, index: number, pxq = 1): Pt {
  return { x: ap.x + ap.halfW + 22 * pxq, y: ap.y - ap.halfH - (4 + index * STUB_STEP) * pxq };
}

/** A tunnel's drawn shape: the arc (absent for a stub) and where its badge sits. */
export interface TunnelShape {
  readonly geom?: CableGeom;
  readonly badge: Pt;
}

/**
 * Shapes of the views on a layout: an arc when both devices are drawn, else a stub beside the access point (stubs of
 * one access point stack in view order). Views whose access point is not drawn have no shape.
 */
export function tunnelShapes(views: readonly CapwapTunnelView[], layout: Pick<Layout, 'devices'>, pxq = 1): ReadonlyMap<string, TunnelShape> {
  const out = new Map<string, TunnelShape>();
  const stubs = new Map<DeviceId, number>();
  for (const v of views) {
    const ap = layout.devices.get(v.ap);
    if (ap === undefined) continue;
    const controller = v.controller === null ? undefined : layout.devices.get(v.controller);
    if (controller !== undefined) {
      const geom = tunnelGeometry(ap, controller);
      out.set(v.key, { geom, badge: bezierAt(geom, 0.5) });
      continue;
    }
    const index = stubs.get(v.ap) ?? 0;
    stubs.set(v.ap, index + 1);
    out.set(v.key, { badge: stubPoint(ap, index, pxq) });
  }
  return out;
}

/** True when the selection (or hover) is a device at either end of the tunnel, or one of its ports. */
export function touchesTunnel(sel: Selection | null, v: Pick<CapwapTunnelView, 'ap' | 'controller'>): boolean {
  if (sel === null) return false;
  const id = sel.kind === 'device' ? sel.id : sel.kind === 'port' ? sel.ref.device : null;
  return id !== null && (id === v.ap || id === v.controller);
}

// ── text forms (the keyboard outline) ────────────────────────────────────────

/** "1 WLAN" / "2 WLANs". */
function count(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** The step phrase: "step 3 of 6"; nothing for `run` (joined says it) or idle. */
function stepText(v: Pick<CapwapTunnelView, 'step'>): string {
  return v.step > 0 && v.step < CAPWAP_STEP_COUNT ? `, step ${v.step} of ${CAPWAP_STEP_COUNT}` : '';
}

/**
 * The sentence of a tunnel from the access point's side: "tunnel to controller WLC1 (192.168.99.5): joined, 2 WLANs,
 * 1 wireless client, control channel protected (simulated)". `name` gives a device's display name.
 */
export function describeTunnel(v: CapwapTunnelView, name: (id: DeviceId) => string): string {
  if (v.origin === 'controller') {
    const ctl = v.controller === null ? 'a controller' : `controller ${name(v.controller)}`;
    return `${ctl} still lists a tunnel from it (${capwapStateWord(v.state)}), but the access point reports none`;
  }
  let text: string;
  if (v.broadcast) text = `looking for a controller by broadcast to ${v.controllerAddress ?? ''}`.trimEnd() + stepText(v);
  else if (v.controller === null) {
    text = `tunnel to ${v.controllerAddress ?? 'a controller'}, an address no device in the workspace holds: ${capwapStateWord(v.state)}${stepText(v)}`;
  } else {
    text = `tunnel to controller ${name(v.controller)} (${v.controllerAddress ?? ''}): ${capwapStateWord(v.state)}${stepText(v)}`;
  }
  if (v.joined) {
    text += `, ${count(v.wlans, 'WLAN', 'WLANs')}`;
    if (v.session !== undefined) text += `, ${count(v.session.clients, 'wireless client', 'wireless clients')}`;
  }
  if (v.secured) text += ', control channel protected (simulated)';
  if (v.controller !== null) {
    if (v.session === undefined && v.step >= 3) text += '; the controller does not list it';
    else if (v.session !== undefined && v.session.state !== v.state) text += `; the controller has it at "${capwapStateWord(v.session.state)}"`;
  }
  return text;
}

/**
 * The small caption under a tunnel's badge (zoomed in): a joined tunnel's WLAN count (and, when its controller lists
 * it, its wireless clients), the address a stub is asking, or nothing.
 */
export function tunnelCaption(v: CapwapTunnelView): string {
  if (v.origin !== 'ap') return '';
  if (v.joined) {
    const wlans = count(v.wlans, 'WLAN', 'WLANs');
    return v.session === undefined ? wlans : `${wlans} · ${count(v.session.clients, 'client', 'clients')}`;
  }
  if (v.controller !== null || v.controllerAddress === null) return '';
  return v.broadcast ? `broadcast ${v.controllerAddress}` : `to ${v.controllerAddress}`;
}

/** The short form of a tunnel on the access point's row: "CAPWAP Jn 3/6", "CAPWAP Run", "CAPWAP Run?". */
export function shortTunnel(v: Pick<CapwapTunnelView, 'letter' | 'step' | 'origin'>): string {
  const of = v.origin === 'ap' && v.step > 0 && v.step < CAPWAP_STEP_COUNT ? ` ${v.step}/${CAPWAP_STEP_COUNT}` : '';
  return `CAPWAP ${v.letter}${of}`;
}

/** The controller's words for one of its tunnels: "LAP1 joined", "LAP2 asking to join (step 3 of 6)". */
function controllerPart(v: CapwapTunnelView, name: (id: DeviceId) => string): string {
  if (v.origin === 'controller') return `${name(v.ap)} listed as ${capwapStateWord(v.state)} though the access point reports no tunnel`;
  const step = v.step > 0 && v.step < CAPWAP_STEP_COUNT ? ` (step ${v.step} of ${CAPWAP_STEP_COUNT})` : '';
  return `${name(v.ap)} ${capwapStateWord(v.state)}${step}`;
}

/**
 * Text facts per device: an access point says each of its tunnels; a controller says how many access points it is
 * tunnelling with and how far each has got. Pure; empty without views.
 */
export function capwapDeviceFacts(views: readonly CapwapTunnelView[], snapshot: SimSnapshot | null): ReadonlyMap<DeviceId, OverlayFact> {
  const out = new Map<DeviceId, OverlayFact>();
  if (views.length === 0 || snapshot === null) return out;
  const names = new Map<DeviceId, string>();
  for (const d of snapshot.devices) names.set(d.id, d.name);
  const name = (id: DeviceId): string => names.get(id) ?? id;
  const byAp = new Map<DeviceId, CapwapTunnelView[]>();
  const byController = new Map<DeviceId, CapwapTunnelView[]>();
  for (const v of views) {
    byAp.set(v.ap, [...(byAp.get(v.ap) ?? []), v]);
    if (v.controller !== null) byController.set(v.controller, [...(byController.get(v.controller) ?? []), v]);
  }
  for (const d of snapshot.devices) {
    const shorts: string[] = [];
    const texts: string[] = [];
    const own = byAp.get(d.id);
    if (own !== undefined) {
      shorts.push(own.map(shortTunnel).join(', '));
      texts.push(own.map((v) => describeTunnel(v, name)).join('; '));
    }
    const served = byController.get(d.id);
    if (served !== undefined) {
      const aps = new Set(served.map((v) => v.ap)).size;
      const joined = new Set(served.filter((v) => v.origin === 'ap' && v.joined).map((v) => v.ap)).size;
      shorts.push(`CAPWAP ${joined} of ${aps} joined`);
      texts.push(`controller tunnelling with ${count(aps, 'access point', 'access points')}: ${served.map((v) => controllerPart(v, name)).join(', ')}`);
    }
    if (shorts.length === 0) continue;
    out.set(d.id, { short: shorts.join(' · '), text: texts.join('; ') });
  }
  return out;
}

// ── the layer ────────────────────────────────────────────────────────────────

class BadgeView {
  readonly text: Text;
  seen = 0;

  constructor(theme: ThemeColors, size: number, bold: boolean) {
    this.text = makeText('', size, theme.text, bold ? theme.sans : theme.mono, bold ? 'bold' : 'normal');
    this.text.anchor.set(0.5);
  }
}

export interface CapwapSyncInput {
  /** The registry's render model (`CAPWAP_OVERLAY.sync`), or null when the overlay is off. */
  readonly model: CapwapOverlayModel | null;
  /** The snapshot the model was built from (the controller rows and device names). */
  readonly snapshot: SimSnapshot | null;
  readonly layout: Layout;
  readonly theme: ThemeColors;
  readonly zoom: number;
  readonly lod: Lod;
  readonly view: Rect;
  readonly textResolution: number;
  readonly selection: Selection | null;
  readonly hover: Selection | null;
}

function tracePolyline(g: Graphics, pts: readonly Pt[]): boolean {
  const first = pts[0];
  if (first === undefined || pts.length < 2) return false;
  g.moveTo(first.x, first.y);
  for (let i = 1; i < pts.length; i++) {
    const p = pts[i];
    if (p !== undefined) g.lineTo(p.x, p.y);
  }
  return true;
}

export class CapwapLayer {
  private readonly ground = new Graphics();
  private readonly glyphs = new Graphics();
  private readonly badges = new Map<string, BadgeView>();
  private readonly labels: Container;
  private sig = '';
  private generation = 0;

  constructor(ground: Container, labels: Container) {
    this.labels = labels;
    ground.addChild(this.ground);
    labels.addChild(this.glyphs);
  }

  sync(input: CapwapSyncInput): void {
    const { layout, theme } = input;
    const gen = ++this.generation;
    const view = inflateRect(input.view, 80 / Math.max(input.zoom, 1e-3));
    const zoomBucket = Math.round(Math.log2(Math.max(input.zoom, 1e-3)) * 4);
    const pxq = 1 / 2 ** (zoomBucket / 4);
    const views = capwapTunnelViews(input.model, input.snapshot);
    const shapes = tunnelShapes(views, layout, pxq);

    const r = (p: Pt): string => `${Math.round(p.x)},${Math.round(p.y)}`;
    const parts: string[] = [String(theme.stamp), viewKey(input.view, input.zoom), input.lod, String(input.textResolution)];
    const selKey = (s: Selection | null): string => (s === null ? '' : s.kind === 'device' ? `d:${s.id}` : s.kind === 'port' ? `d:${s.ref.device}` : '');
    parts.push(selKey(input.selection), selKey(input.hover));
    for (const v of views) {
      const shape = shapes.get(v.key);
      const at = shape === undefined ? '-' : shape.geom === undefined ? `s${r(shape.badge)}` : `${r(shape.geom.p0)}|${r(shape.geom.p3)}`;
      parts.push(`${v.key}|${at}|${v.state}|${v.letter}|${v.wlans}|${v.broadcast ? 1 : 0}|${v.session?.state ?? ''}|${v.session?.clients ?? ''}`);
    }
    const sig = parts.join(';');
    if (sig === this.sig) return;
    this.sig = sig;

    const g = this.ground;
    const glyphs = this.glyphs;
    g.clear();
    glyphs.clear();
    const showText = input.lod !== 'far';
    const showCaption = input.lod === 'full' && input.zoom >= CAPWAP_CAPTION_MIN_ZOOM;

    for (const v of views) {
      const shape = shapes.get(v.key);
      if (shape === undefined) continue;
      const selected = touchesTunnel(input.selection, v);
      const hovered = !selected && touchesTunnel(input.hover, v);
      if (shape.geom !== undefined) {
        if (!rectsIntersect(inflateRect(geomBounds(shape.geom), 20), view)) continue;
        this.drawTube(g, shape.geom, v, pxq, theme, selected, hovered);
      } else {
        const b = shape.badge;
        if (b.x < view.minX || b.x > view.maxX || b.y < view.minY || b.y > view.maxY) continue;
        if (v.broadcast) this.drawWaves(glyphs, b, pxq, theme);
      }
      if (!showText) continue;
      const badgeAt = shape.geom === undefined ? { x: shape.badge.x + 20 * pxq, y: shape.badge.y } : shape.badge;
      const w = this.drawBadge(glyphs, badgeAt, v, pxq, theme, gen, input.textResolution);
      if (v.secured) this.drawPadlock(glyphs, { x: badgeAt.x - (w / 2 + 7) * pxq, y: badgeAt.y }, pxq, theme);
      const caption = showCaption ? tunnelCaption(v) : '';
      if (caption !== '') {
        const cap = this.badge(`${v.key}#caption`, theme, 8, false, gen);
        setText(cap.text, caption, theme.textDim, theme.mono, input.textResolution);
        cap.text.anchor.set(0.5, 0);
        cap.text.position.set(badgeAt.x, badgeAt.y + 8 * pxq);
        cap.text.scale.set(pxq);
        cap.text.visible = true;
      }
    }

    for (const [key, badge] of this.badges) {
      if (badge.seen !== gen) {
        badge.text.destroy();
        this.badges.delete(key);
      }
    }
  }

  /** The hollow tube, its progress fill and the step ticks (under the cables). */
  private drawTube(g: Graphics, geom: CableGeom, v: CapwapTunnelView, pxq: number, theme: ThemeColors, selected: boolean, hovered: boolean): void {
    const pts = sampleBezier(geom, TUNNEL_SAMPLES);
    if ((selected || hovered) && tracePolyline(g, pts)) {
      g.stroke({ width: (TUBE_WIDTH + 7) * pxq, color: theme.accent, alpha: selected ? 0.26 : 0.14, cap: 'round', join: 'round' });
    }
    const border = v.origin === 'controller' ? theme.warn : theme.borderStrong;
    if (tracePolyline(g, pts)) g.stroke({ width: (TUBE_WIDTH + 1.8) * pxq, color: border, alpha: 0.85, cap: 'round', join: 'round' });
    if (tracePolyline(g, pts)) g.stroke({ width: TUBE_WIDTH * pxq, color: theme.panel2, alpha: 0.96, cap: 'round', join: 'round' });
    if (v.origin === 'ap' && tracePolyline(g, progressPoints(geom, v.progress))) {
      g.stroke({ width: FILL_WIDTH * pxq, color: v.joined ? theme.ok : theme.accent, alpha: 0.92, cap: 'round', join: 'round' });
    }
    for (const t of stepTicks(geom, (TUBE_WIDTH / 2 + 1.5) * pxq)) g.moveTo(t.a.x, t.a.y).lineTo(t.b.x, t.b.y);
    g.stroke({ width: pxq, color: theme.textDim, alpha: 0.85, cap: 'butt' });
  }

  /** Three broadcast arcs rising from a stub point (an access point still looking for its controller). */
  private drawWaves(glyphs: Graphics, at: Pt, pxq: number, theme: ThemeColors): void {
    const from = -Math.PI * 0.75;
    const to = -Math.PI * 0.25;
    for (const radius of [3.5, 7, 10.5]) {
      const rr = radius * pxq;
      glyphs.moveTo(at.x + rr * Math.cos(from), at.y + 6 * pxq + rr * Math.sin(from)).arc(at.x, at.y + 6 * pxq, rr, from, to);
    }
    glyphs.stroke({ width: 1.4 * pxq, color: theme.accent, alpha: 0.9, cap: 'round' });
    glyphs.circle(at.x, at.y + 6 * pxq, 1.4 * pxq).fill({ color: theme.accent });
  }

  /** The letters badge; returns its width in screen units. */
  private drawBadge(glyphs: Graphics, at: Pt, v: CapwapTunnelView, pxq: number, theme: ThemeColors, gen: number, res: number): number {
    const badge = this.badge(v.key, theme, 8, true, gen);
    setText(badge.text, v.letter, theme.text, theme.sans, res);
    badge.text.anchor.set(0.5);
    // measured unscaled (the text keeps the previous zoom's scale until it is set below)
    badge.text.scale.set(1);
    const w = Math.max(18, badge.text.width + 8);
    const stroke = v.origin === 'controller' ? theme.warn : v.joined ? theme.ok : theme.accent;
    glyphs
      .roundRect(at.x - (w / 2) * pxq, at.y - 6.5 * pxq, w * pxq, 13 * pxq, 6.5 * pxq)
      .fill({ color: theme.panel, alpha: 0.96 })
      .stroke({ width: (v.joined ? 1.6 : 1.2) * pxq, color: stroke });
    badge.text.position.set(at.x, at.y);
    badge.text.scale.set(pxq);
    badge.text.visible = true;
    return w;
  }

  /** A small padlock: the control channel is protected (simulated DTLS). */
  private drawPadlock(glyphs: Graphics, at: Pt, pxq: number, theme: ThemeColors): void {
    const w = 7 * pxq;
    const h = 5.5 * pxq;
    const top = at.y - 1.5 * pxq;
    glyphs
      .moveTo(at.x - 2.2 * pxq, top)
      .arc(at.x, top, 2.2 * pxq, Math.PI, 0)
      .stroke({ width: 1.3 * pxq, color: theme.textDim });
    glyphs.roundRect(at.x - w / 2, top, w, h, 1.2 * pxq).fill({ color: theme.textDim });
  }

  private badge(key: string, theme: ThemeColors, size: number, bold: boolean, gen: number): BadgeView {
    let b = this.badges.get(key);
    if (!b) {
      b = new BadgeView(theme, size, bold);
      this.badges.set(key, b);
      this.labels.addChild(b.text);
    }
    b.seen = gen;
    return b;
  }

  destroy(): void {
    for (const b of this.badges.values()) b.text.destroy();
    this.badges.clear();
    this.ground.destroy();
    this.glyphs.destroy();
  }
}
