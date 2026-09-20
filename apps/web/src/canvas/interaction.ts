/**
 * Pointer, wheel and keyboard interaction for the topology canvas (spec §8.3, §16; ARCHITECTURE-P1 §7).
 *
 *  • Pan: middle-button drag, Space + drag, or a background drag with the 'pan' tool. Wheel zooms about the cursor
 *    within ZOOM_MIN..ZOOM_MAX. With the canvas focused, arrow keys pan and + / − zoom.
 *  • Select tool: click a port (edge LED or antenna), packet, drop marker, device, association line, radio beam or
 *    cable to select it (packets and markers also switch the dock to 'provenance'); click the background to clear
 *    the selection. Drag a device to move it: the local position updates at once, `engine.moveDevice` is
 *    throttled to ~30/s (the engine coalesces the resulting `deviceMoved` RF recomputation) and sent once more on
 *    release. Escape during a drag puts the device back.
 *  • Double-click a device → its natural surface (`openDeviceSurface(id, 'default')`: Desktop, console or settings).
 *  • Right-click a device (or the context-menu key / Shift+F10 with the canvas focused) → context menu
 *    (rendered by Canvas.tsx).
 *  • Add-device tool: click places `store.addDeviceType` at the cursor, then returns to 'select'.
 *  • Cable tool: the media chosen in the cable picker (`store.cable.media`) drives everything. Click a port dot →
 *    pending cable; hovering another port asks `engine.validateLink` (cached per ends + media, so changing the
 *    media while hovering never shows a stale verdict) and shows ✓/✕ with the reason and, for serial media, which
 *    end becomes DCE; click → `engine.addLink`. Occupied ports explain themselves instead of connecting. With the
 *    canvas focused, Enter continues the pending cable in the keyboard cabling dialog (`CanvasA11yApi.beginCable`).
 *    A background click drops the pending cable (Escape is owned by the global hotkeys).
 *  • Enter / F6 with the canvas focused hands keyboard focus to the selected device in the outline
 *    (`CanvasA11yApi.focusDevice`).
 *
 * Hit testing is geometric (see the layers' `hit` methods); Pixi's event system is not used.
 */
import { Graphics } from 'pixi.js';
import { portKey, samePort, type CableValidation, type DeviceId, type LinkId, type PduId, type PortRef, type Selection } from '@netforge/engine';
import {
  addLinkSpecFor,
  serialDceHint,
  validationKey,
  verdictText,
  type PortCompat,
} from '../app/cable/cable-compat';
import { markSpacePan } from '../app/hotkeys';
import { engine } from '../bridge/client';
import { openDeviceSurface } from '../shared/openDeviceSurface';
import { selectAssociation } from '../store/selectors';
import { store } from '../store/store';
import { linkDownText, mediaName } from '../vocab/media';
import { phaseBadge, signalText, type AirLayer } from './air';
import { bezierAt, geometryBetween, type CableLayer } from './cables';
import type { CableTargetHint, DeviceLayer } from './devices';
import type { MarkerLayer } from './markers';
import type { PacketLayer } from './packets';
import { hitPort, portTitle, type Layout, type PortAnchor, type Position } from './ports';
import { distanceLabel } from './rf';
import type { Scene } from './scene';

const DRAG_THRESHOLD_PX = 4;
/** Minimum wall time between two `moveDevice` calls while dragging (~30 per second). */
export const MOVE_INTERVAL_MS = 33;
const CAMERA_SYNC_MS = 120;
/** Keyboard pan step (screen pixels) and zoom factor. */
const KEY_PAN_PX = 40;
const KEY_ZOOM = 1.2;

export interface ContextMenuRequest {
  device: DeviceId;
  /** Canvas-local pixels. */
  x: number;
  y: number;
  /** Opened from the keyboard (focus the first item and return focus to the canvas on close). */
  keyboard?: boolean;
}

/** The part of the a11y bridge the interaction layer calls (see Canvas.tsx `registerCanvasA11y`). */
export interface InteractionA11y {
  focusDevice(id: DeviceId): boolean;
  screenPoint(id: DeviceId): { x: number; y: number } | null;
  beginCable(from: PortRef): boolean;
}

export interface InteractionDeps {
  scene: Scene;
  getLayout(): Layout;
  devices: DeviceLayer;
  cables: CableLayer;
  packets: PacketLayer;
  markers: MarkerLayer;
  air: AirLayer;
  /** Picker verdicts for the current pending cable and media (cable tool), else null. */
  getCompat(): ReadonlyMap<string, PortCompat> | null;
  /** Local device positions that override the snapshot until the engine catches up. */
  overrides: Map<DeviceId, Position>;
  invalidateLayout(): void;
  invalidateStyle(): void;
  tooltip: HTMLElement;
  openMenu(req: ContextMenuRequest | null): void;
  a11y: InteractionA11y;
}

export interface InteractionHandle {
  /** Port currently offered as the other end of the pending cable, with its validation verdict. */
  readonly target: CableTargetHint | null;
  /** Device being pressed/dragged — its override must not be pruned. */
  readonly dragging: DeviceId | null;
  /** Redraw the cable preview (pending cable, pointer or layout changed). */
  refresh(): void;
  detach(): void;
}

// ── shared actions (also used by the context menu) ────────────────────────────

function messageOf(err: unknown): string {
  if (err instanceof Error) return err.message;
  return typeof err === 'string' ? err : 'Something went wrong.';
}

function fail(err: unknown): void {
  const text = messageOf(err);
  store.getState().toast(text, 'error');
  store.getState().announce(text);
}

export async function setDevicePower(device: DeviceId, on: boolean): Promise<void> {
  try {
    await engine.setPower(device, on);
  } catch (err) {
    fail(err);
  }
}

export async function deleteDevice(device: DeviceId): Promise<void> {
  try {
    await engine.removeDevice(device);
    const sel = store.getState().selection;
    if (
      sel &&
      ((sel.kind === 'device' && sel.id === device) || (sel.kind === 'port' && sel.ref.device === device) || (sel.kind === 'slot' && sel.device === device))
    ) {
      store.getState().select(null);
    }
  } catch (err) {
    fail(err);
  }
}

/** Select a PDU, show the provenance tab and fetch its full decode for the inspector. */
export function selectPdu(id: PduId): void {
  const st = store.getState();
  st.select({ kind: 'pdu', id });
  st.setDockTab('provenance');
  engine
    .pdu(id)
    .then((p) => {
      const now = store.getState().selection;
      if (now?.kind === 'pdu' && now.id === id) store.getState().setInspectedPdu(p ?? null);
    })
    .catch(() => {
      /* the PDU may have been evicted; the provenance panel shows its own message */
    });
}

/** `1 Gb/s`, `64 kb/s`. */
export function formatBps(bps: number): string {
  if (bps >= 1e9) return `${+(bps / 1e9).toFixed(1)} Gb/s`;
  if (bps >= 1e6) return `${+(bps / 1e6).toFixed(1)} Mb/s`;
  if (bps >= 1e3) return `${+(bps / 1e3).toFixed(1)} kb/s`;
  return `${bps} b/s`;
}

// ── hit testing ──────────────────────────────────────────────────────────────

type Hit =
  | { kind: 'port'; anchor: PortAnchor }
  | { kind: 'pdu'; id: PduId; marker: boolean }
  | { kind: 'device'; id: DeviceId }
  | { kind: 'link'; id: LinkId }
  | { kind: 'association'; id: string }
  | { kind: 'none' };

interface Press {
  pointerId: number;
  startX: number;
  startY: number;
  moved: boolean;
  kind: 'pan' | 'device';
  camX: number;
  camY: number;
  deviceId?: DeviceId;
  origin?: Position;
  grabDx?: number;
  grabDy?: number;
  onClick?: () => void;
}

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable) return true;
  return target.closest('.xterm') !== null;
}

export function attachInteraction(deps: InteractionDeps): InteractionHandle {
  const { scene } = deps;
  const canvas = scene.canvas;
  const preview = new Graphics();
  scene.layers.overlay.addChild(preview);
  // Focusable by pointer (not a tab stop: the outline is the keyboard entry point).
  canvas.tabIndex = -1;
  canvas.setAttribute('role', 'application');
  canvas.setAttribute(
    'aria-label',
    'Topology canvas. Arrow keys pan, plus and minus zoom, Enter moves keyboard focus to the device list, Shift+F10 opens the device menu.',
  );

  let detached = false;
  let press: Press | null = null;
  let spaceHeld = false;
  let lastPointer: { x: number; y: number } | null = null;

  let target: CableTargetHint | null = null;
  let targetKey = '';
  let validation: CableValidation | null = null;
  let validationToken = 0;

  let moveTimer: ReturnType<typeof setTimeout> | undefined;
  let queuedMove: { id: DeviceId; pos: Position } | null = null;
  let lastMoveSent = 0;
  let cameraTimer: ReturnType<typeof setTimeout> | undefined;

  // ── helpers ────────────────────────────────────────────────────────────────

  const toWorld = (local: { x: number; y: number }): Position => scene.localToWorld(local.x, local.y);
  const worldRadius = (px: number, min: number, max: number): number => Math.max(min, Math.min(max, px / scene.camera.zoom));

  function hitTest(wx: number, wy: number): Hit {
    const layout = deps.getLayout();
    const st = store.getState();
    const tool = st.tool;
    const portR = worldRadius(8, 3.5, 60);
    const lineTol = worldRadius(6, 3, 400);
    if (tool === 'cable') {
      const a = hitPort(layout.grid, wx, wy, portR) ?? hitPort(layout.edge, wx, wy, portR);
      if (a) return { kind: 'port', anchor: a };
      const d = deps.devices.hit(layout, wx, wy, true, worldRadius(4, 4, 120));
      if (d) return { kind: 'device', id: d };
      const air = deps.air.hit(wx, wy, lineTol, st.overlays);
      if (air) return air;
      const l = deps.cables.hit(wx, wy, lineTol);
      return l ? { kind: 'link', id: l } : { kind: 'none' };
    }
    const edge = hitPort(layout.edge, wx, wy, portR) ?? hitPort(layout.antenna, wx, wy, portR);
    if (edge) return { kind: 'port', anchor: edge };
    const marker = deps.markers.hit(wx, wy);
    if (marker !== undefined) return { kind: 'pdu', id: marker, marker: true };
    const pdu = deps.packets.hit(wx, wy, worldRadius(4, 2, 80));
    if (pdu !== undefined) return { kind: 'pdu', id: pdu, marker: false };
    const d = deps.devices.hit(layout, wx, wy, false, worldRadius(4, 4, 120));
    if (d) return { kind: 'device', id: d };
    const air = deps.air.hit(wx, wy, lineTol, st.overlays);
    if (air) return air;
    const l = deps.cables.hit(wx, wy, lineTol);
    return l ? { kind: 'link', id: l } : { kind: 'none' };
  }

  function setTooltip(text: string, tone: 'plain' | 'ok' | 'err' | 'wait', local: { x: number; y: number } | null): void {
    const tip = deps.tooltip;
    if (!text || !local) {
      tip.hidden = true;
      return;
    }
    if (tip.textContent !== text) tip.textContent = text;
    tip.className = `nf-canvas-tip${tone === 'plain' ? '' : ` is-${tone}`}`;
    tip.hidden = false;
    const maxX = Math.max(0, scene.width - tip.offsetWidth - 8);
    const maxY = Math.max(0, scene.height - tip.offsetHeight - 8);
    const x = Math.min(maxX, local.x + 14);
    const y = local.y + 18 > maxY ? Math.max(0, local.y - tip.offsetHeight - 10) : local.y + 18;
    tip.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
  }

  function setCursor(c: string): void {
    if (canvas.style.cursor !== c) canvas.style.cursor = c;
  }

  function scheduleCameraSync(): void {
    if (cameraTimer !== undefined) return;
    cameraTimer = setTimeout(() => {
      cameraTimer = undefined;
      if (detached) return;
      store.getState().setCamera({ ...scene.camera });
    }, CAMERA_SYNC_MS);
  }

  function deviceName(id: DeviceId): string {
    return deps.getLayout().devices.get(id)?.device.name ?? id;
  }

  function portLabel(ref: PortRef): string {
    const g = deps.getLayout().devices.get(ref.device);
    const short = g?.device.ports.find((p) => p.id === ref.port)?.short ?? ref.port;
    return `${short} on ${g?.device.name ?? ref.device}`;
  }

  // ── device moves ───────────────────────────────────────────────────────────

  function flushMove(): void {
    if (!queuedMove) return;
    const { id, pos } = queuedMove;
    queuedMove = null;
    lastMoveSent = performance.now();
    engine.moveDevice(id, pos).catch(fail);
  }

  function queueMove(id: DeviceId, pos: Position): void {
    if (queuedMove && queuedMove.id !== id) flushMove();
    queuedMove = { id, pos };
    const wait = MOVE_INTERVAL_MS - (performance.now() - lastMoveSent);
    if (wait <= 0) {
      if (moveTimer !== undefined) {
        clearTimeout(moveTimer);
        moveTimer = undefined;
      }
      flushMove();
    } else if (moveTimer === undefined) {
      moveTimer = setTimeout(() => {
        moveTimer = undefined;
        flushMove();
      }, wait);
    }
  }

  function finishMove(): void {
    if (moveTimer !== undefined) {
      clearTimeout(moveTimer);
      moveTimer = undefined;
    }
    flushMove();
  }

  // ── cable tool ─────────────────────────────────────────────────────────────

  function currentMedia(): ReturnType<typeof store.getState>['cable']['media'] {
    const st = store.getState();
    return st.pendingCable?.media ?? st.cable.media;
  }

  function clearTarget(): void {
    if (!target) return;
    target = null;
    targetKey = '';
    validation = null;
    validationToken += 1;
    deps.invalidateStyle();
  }

  function requestValidation(from: PortRef, anchor: PortAnchor): void {
    const spec = addLinkSpecFor(from, anchor.ref, currentMedia());
    const key = validationKey(spec);
    if (target && targetKey === key) return;
    target = { key: anchor.key, ok: null };
    targetKey = key;
    validation = null;
    const token = ++validationToken;
    deps.invalidateStyle();
    engine
      .validateLink(spec)
      .then((v) => {
        if (detached || token !== validationToken) return;
        validation = v;
        target = { key: anchor.key, ok: v.ok };
        deps.invalidateStyle();
        if (!press && lastPointer) updateHover(lastPointer);
      })
      .catch((err: unknown) => {
        if (detached || token !== validationToken) return;
        validation = { ok: false, reason: messageOf(err) };
        target = { key: anchor.key, ok: false };
        deps.invalidateStyle();
        if (!press && lastPointer) updateHover(lastPointer);
      });
  }

  async function connect(from: PortRef, to: PortRef, known: CableValidation | null): Promise<void> {
    const media = currentMedia();
    try {
      await engine.addLink(addLinkSpecFor(from, to, media));
      const st = store.getState();
      st.setPendingCable(null);
      clearTarget();
      const words = `${portLabel(from)} and ${portLabel(to)}`;
      if (known && !known.ok) {
        const text = `Cable added between ${words}, but the link will stay down: ${known.reason ?? 'these ports cannot work over it.'}`;
        st.toast(text, 'warn');
        st.announce(text);
      } else {
        st.announce(`Cable added between ${words}.`);
      }
    } catch (err) {
      fail(err);
    }
  }

  function onPortClickInCableTool(anchor: PortAnchor): void {
    const st = store.getState();
    const pending = st.pendingCable;
    const verdict = deps.getCompat()?.get(anchor.key);
    if (!pending) {
      if (verdict?.status === 'occupied') {
        st.toast(verdict.reason ?? 'That port already has a connection.', 'warn');
        return;
      }
      st.setPendingCable({ from: anchor.ref, media: st.cable.media });
      st.announce(`Cable started at ${portLabel(anchor.ref)}. Choose the other port.`);
      return;
    }
    if (samePort(pending.from, anchor.ref)) {
      st.setPendingCable(null);
      clearTarget();
      st.announce('Cable dropped.');
      return;
    }
    if (verdict?.status === 'occupied') {
      st.toast(verdict.reason ?? 'That port already has a connection.', 'warn');
      return;
    }
    const spec = addLinkSpecFor(pending.from, anchor.ref, currentMedia());
    const known = target && targetKey === validationKey(spec) ? validation : null;
    void connect(pending.from, anchor.ref, known);
  }

  function refresh(): void {
    preview.clear();
    scene.dirty = true;
    const st = store.getState();
    const pending = st.pendingCable;
    if (st.tool !== 'cable' || !pending) {
      clearTarget();
      return;
    }
    const layout = deps.getLayout();
    const fromKey = portKey(pending.from);
    const from = layout.grid.get(fromKey) ?? layout.edge.get(fromKey) ?? layout.antenna.get(fromKey);
    if (!from) return;
    let end: { x: number; y: number; nx: number; ny: number } | undefined;
    if (target) end = layout.grid.get(target.key) ?? layout.edge.get(target.key);
    if (!end && lastPointer) {
      const w = toWorld(lastPointer);
      end = { x: w.x, y: w.y, nx: 0, ny: -1 };
    }
    if (!end) return;
    const theme = scene.theme;
    const color = target?.ok === true ? theme.ok : target?.ok === false ? theme.err : theme.accent;
    const width = 2.6 / Math.min(1, scene.camera.zoom);
    const geom = geometryBetween(from, end);
    preview
      .moveTo(geom.p0.x, geom.p0.y)
      .bezierCurveTo(geom.p1.x, geom.p1.y, geom.p2.x, geom.p2.y, geom.p3.x, geom.p3.y)
      .stroke({ width, color, alpha: 0.9, cap: 'round' });
    preview.circle(end.x, end.y, 4).fill({ color });
    const m = bezierAt(geom, 0.5);
    if (target?.ok === false) {
      // a cross at the midpoint: the verdict is not carried by colour alone
      preview.moveTo(m.x - 4, m.y - 4).lineTo(m.x + 4, m.y + 4);
      preview.moveTo(m.x + 4, m.y - 4).lineTo(m.x - 4, m.y + 4);
      preview.stroke({ width: 2.2, color, cap: 'round' });
    } else if (target?.ok === true) {
      // a tick for an accepted pairing
      preview.moveTo(m.x - 4, m.y).lineTo(m.x - 1, m.y + 3).lineTo(m.x + 4, m.y - 3).stroke({ width: 2.2, color, cap: 'round', join: 'round' });
    }
  }

  // ── hover ──────────────────────────────────────────────────────────────────

  function idleCursor(): string {
    const tool = store.getState().tool;
    if (spaceHeld || tool === 'pan') return 'grab';
    if (tool === 'add-device') return 'crosshair';
    return 'default';
  }

  function cableTip(pendingFrom: PortRef, a: PortAnchor, base: string): { tip: string; tone: 'plain' | 'ok' | 'err' | 'wait' } {
    const media = currentMedia();
    const verdict = deps.getCompat()?.get(a.key);
    if (verdict?.status === 'occupied') {
      return { tip: `${base}\n✕ ${verdict.reason ?? 'This port already has a connection.'}`, tone: 'err' };
    }
    requestValidation(pendingFrom, a);
    const dce = serialDceHint(media, pendingFrom, a.ref, { from: portLabel(pendingFrom), to: portLabel(a.ref) });
    const dceLine = dce ? `\n${dce.text}` : '';
    if (!validation || target?.key !== a.key) {
      return { tip: `${base}\n… checking this cable${dceLine}`, tone: 'wait' };
    }
    const v = verdictText(validation, media);
    if (validation.ok) return { tip: `${base}\n${v.title}: ${v.detail}${dceLine}\nClick to connect.`, tone: 'ok' };
    return { tip: `${base}\n${v.title}: ${v.detail}\nClick to cable it anyway and see the link stay down.`, tone: 'err' };
  }

  function updateHover(local: { x: number; y: number }): void {
    const st = store.getState();
    const w = toWorld(local);
    const hit = hitTest(w.x, w.y);
    let hover: Selection | null = null;
    let tip = '';
    let tone: 'plain' | 'ok' | 'err' | 'wait' = 'plain';
    let cursor = idleCursor();
    let keepTarget = false;
    const pending = st.tool === 'cable' ? st.pendingCable : null;

    switch (hit.kind) {
      case 'port': {
        const a = hit.anchor;
        hover = { kind: 'port', ref: a.ref };
        cursor = 'pointer';
        tip = portTitle(a);
        if (st.tool === 'cable') {
          if (!pending) {
            const verdict = deps.getCompat()?.get(a.key);
            if (verdict?.status === 'occupied') {
              tip = `${tip}\n✕ ${verdict.reason ?? 'This port already has a connection.'}`;
              tone = 'err';
            } else if (verdict?.status === 'incompatible') {
              tip = `${tip}\n✕ ${verdict.reason ?? 'The chosen cable does not fit this port.'}`;
              tone = 'err';
            } else {
              const dce = serialDceHint(currentMedia(), a.ref, undefined, { from: portLabel(a.ref) });
              tip = `${tip}\nClick to start a ${mediaName(currentMedia())} here.${dce ? `\n${dce.text}` : ''}`;
            }
          } else if (samePort(pending.from, a.ref)) {
            tip = `${tip}\nThe cable starts here. Click again to let go of it.`;
          } else {
            keepTarget = true;
            const t = cableTip(pending.from, a, tip);
            tip = t.tip;
            tone = t.tone;
          }
        }
        break;
      }
      case 'pdu': {
        hover = { kind: 'pdu', id: hit.id };
        cursor = 'pointer';
        const f = st.inflight.find((x) => x.pdu.id === hit.id);
        const what = f ? `${f.pdu.summary} (${f.pdu.size} B)` : `Packet #${hit.id}`;
        tip = `${what}\nClick to follow its history.`;
        break;
      }
      case 'device': {
        hover = { kind: 'device', id: hit.id };
        const d = deps.getLayout().devices.get(hit.id)?.device;
        if (d) {
          if (st.tool === 'cable') tip = `${d.name}: pick one of the port dots under it.`;
          else if (st.tool === 'select') {
            tip = `${d.name} · ${d.model}\nDrag to move, double-click to open, right-click for more.`;
            cursor = spaceHeld ? 'grab' : 'move';
          }
        }
        break;
      }
      case 'association': {
        hover = { kind: 'association', id: hit.id };
        const a = selectAssociation(st, hit.id);
        if (a) {
          const phase = phaseBadge(a.state);
          const net = a.ssid !== undefined ? ` "${a.ssid}"` : '';
          const tech = a.tech === 'cellular' ? 'Cellular' : 'Wi-Fi';
          const quality = phase.final
            ? `${a.bars} of 4 bars, ${signalText(a.rssiDbm, a.holdUntil !== undefined)}, ${formatBps(a.rateBps)}, ${distanceLabel(a.distanceM)}`
            : `${a.state}${a.reason !== undefined ? ` (${a.reason})` : ''}`;
          const ap = a.ap !== undefined ? ` ↔ ${deviceName(a.ap.device)}` : '';
          tip = `${tech}${net}: ${deviceName(a.station.device)}${ap}\n${quality}`;
          tone = phase.failed ? 'err' : 'plain';
          if (st.tool === 'select') cursor = 'pointer';
        }
        break;
      }
      case 'link': {
        hover = { kind: 'link', id: hit.id };
        const layout = deps.getLayout();
        const link = layout.links.get(hit.id);
        if (link) {
          const nameA = deviceName(link.a.device);
          const nameB = deviceName(link.b.device);
          let state: string;
          if (link.up) {
            const rate = link.radio?.rateBps ?? link.negotiatedBps;
            state = `up${rate ? ` at ${formatBps(rate)}` : ''}`;
            if (link.radio) state += `, ${link.radio.bars} of 4 bars, ${Math.round(link.radio.rssiDbm)} dBm over ${distanceLabel(link.radio.distanceM)}`;
            if (link.phy && (link.phy.a.duplex === 'half' || link.phy.b.duplex === 'half')) state += ', half duplex';
          } else {
            const text = linkDownText(link.downReason, { deviceA: nameA, deviceB: nameB, endA: portLabel(link.a), endB: portLabel(link.b), lengthM: link.lengthM });
            state = link.carrier === true ? `up, line protocol down: ${text.short}` : `down: ${text.short}`;
          }
          const dce = link.resolvedDceEnd !== undefined ? `\nDCE end (clock): ${portLabel(link.resolvedDceEnd === 'a' ? link.a : link.b)}` : '';
          const shared = link.segment !== undefined ? '\nShared collision domain (half duplex).' : '';
          tip = `${nameA} ↔ ${nameB}\n${mediaName(link.resolvedMedia)}, ${state}${dce}${shared}`;
          tone = link.up ? 'plain' : 'err';
          if (st.tool === 'select') cursor = 'pointer';
        }
        break;
      }
      case 'none':
      default:
        if (st.tool === 'add-device' && st.addDeviceType) {
          const m = st.catalog.find((x) => x.type === st.addDeviceType);
          tip = `Click to place ${m ? m.model : 'the device'} here.`;
        } else if (pending) {
          tip = 'Click a port on another device, or the background to drop this cable. Enter continues with the keyboard.';
        }
        break;
    }

    if (!keepTarget) clearTarget();
    st.setHover(hover);
    setCursor(cursor);
    setTooltip(tip, tone, local);
    if (pending) refresh();
  }

  // ── pointer handlers ──────────────────────────────────────────────────────

  function beginPress(e: PointerEvent, p: Press): void {
    press = p;
    try {
      canvas.setPointerCapture(e.pointerId);
    } catch {
      /* capture can fail if the pointer is already gone */
    }
    setTooltip('', 'plain', null);
  }

  function onPointerDown(e: PointerEvent): void {
    if (press) return;
    deps.openMenu(null);
    if (document.activeElement !== canvas) canvas.focus({ preventScroll: true });
    const local = scene.clientToLocal(e.clientX, e.clientY);
    lastPointer = local;
    const w = toWorld(local);
    const st = store.getState();
    const base: Press = {
      pointerId: e.pointerId,
      startX: local.x,
      startY: local.y,
      moved: false,
      kind: 'pan',
      camX: scene.camera.x,
      camY: scene.camera.y,
    };

    if (e.button === 1 || (e.button === 0 && (spaceHeld || st.tool === 'pan'))) {
      e.preventDefault();
      // Space+drag pan: releasing Space afterwards must not toggle play/pause.
      if (e.button === 0 && spaceHeld) markSpacePan();
      const clickClears = e.button === 0 && st.tool === 'pan';
      beginPress(e, { ...base, onClick: clickClears ? () => store.getState().select(null) : undefined });
      setCursor('grabbing');
      return;
    }
    if (e.button !== 0) return;

    const hit = hitTest(w.x, w.y);

    if (st.tool === 'add-device') {
      beginPress(e, { ...base, onClick: () => void placeDevice(w) });
      return;
    }

    if (st.tool === 'cable') {
      if (hit.kind === 'port') {
        const anchor = hit.anchor;
        beginPress(e, { ...base, onClick: () => onPortClickInCableTool(anchor) });
      } else {
        beginPress(e, {
          ...base,
          onClick: () => {
            if (store.getState().pendingCable) {
              store.getState().setPendingCable(null);
              clearTarget();
            }
          },
        });
      }
      return;
    }

    // select tool
    switch (hit.kind) {
      case 'port': {
        const ref = hit.anchor.ref;
        beginPress(e, { ...base, onClick: () => store.getState().select({ kind: 'port', ref }) });
        return;
      }
      case 'pdu': {
        const id = hit.id;
        beginPress(e, { ...base, onClick: () => selectPdu(id) });
        return;
      }
      case 'device': {
        const g = deps.getLayout().devices.get(hit.id);
        if (!g) return;
        st.select({ kind: 'device', id: hit.id });
        beginPress(e, {
          ...base,
          kind: 'device',
          deviceId: hit.id,
          origin: { x: g.x, y: g.y },
          grabDx: w.x - g.x,
          grabDy: w.y - g.y,
        });
        return;
      }
      case 'association': {
        const id = hit.id;
        beginPress(e, { ...base, onClick: () => store.getState().select({ kind: 'association', id }) });
        return;
      }
      case 'link': {
        const id = hit.id;
        beginPress(e, { ...base, onClick: () => store.getState().select({ kind: 'link', id }) });
        return;
      }
      case 'none':
      default:
        beginPress(e, { ...base, onClick: () => store.getState().select(null) });
        return;
    }
  }

  async function placeDevice(w: Position): Promise<void> {
    const st = store.getState();
    const type = st.addDeviceType;
    if (!type) {
      st.setTool('select');
      return;
    }
    try {
      const id = await engine.addDevice({ type, position: { x: Math.round(w.x), y: Math.round(w.y) } });
      const after = store.getState();
      after.setTool('select');
      after.select({ kind: 'device', id });
      after.setCanvasFocus(id);
      const model = after.catalog.find((m) => m.type === type)?.model ?? type;
      after.announce(`${model} placed on the canvas.`);
    } catch (err) {
      fail(err);
    }
  }

  function onPointerMove(e: PointerEvent): void {
    const local = scene.clientToLocal(e.clientX, e.clientY);
    lastPointer = local;
    if (press && e.pointerId === press.pointerId) {
      const dx = local.x - press.startX;
      const dy = local.y - press.startY;
      if (!press.moved && Math.hypot(dx, dy) >= DRAG_THRESHOLD_PX) press.moved = true;
      if (!press.moved) return;
      if (press.kind === 'pan') {
        scene.setCamera({ x: press.camX + dx, y: press.camY + dy, zoom: scene.camera.zoom });
        scheduleCameraSync();
        setCursor('grabbing');
        if (store.getState().pendingCable) refresh();
      } else if (press.deviceId !== undefined) {
        const w = toWorld(local);
        const pos = { x: Math.round(w.x - (press.grabDx ?? 0)), y: Math.round(w.y - (press.grabDy ?? 0)) };
        deps.overrides.set(press.deviceId, pos);
        deps.invalidateLayout();
        queueMove(press.deviceId, pos);
        setCursor('grabbing');
      }
      return;
    }
    if (press) return;
    updateHover(local);
  }

  function endPress(e: PointerEvent, cancelled: boolean): void {
    if (!press || e.pointerId !== press.pointerId) return;
    const p = press;
    press = null;
    try {
      if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    if (p.kind === 'pan' && p.moved) scheduleCameraSync();
    if (p.kind === 'device' && p.moved) {
      finishMove();
      if (p.deviceId !== undefined) store.getState().announce(`${deviceName(p.deviceId)} moved.`);
    }
    if (!p.moved && !cancelled) p.onClick?.();
    const local = scene.clientToLocal(e.clientX, e.clientY);
    lastPointer = local;
    updateHover(local);
  }

  const onPointerUp = (e: PointerEvent): void => endPress(e, false);
  const onPointerCancel = (e: PointerEvent): void => endPress(e, true);

  function onPointerLeave(): void {
    if (press) return;
    lastPointer = null;
    store.getState().setHover(null);
    setTooltip('', 'plain', null);
    clearTarget();
    if (store.getState().pendingCable) refresh();
  }

  function onDoubleClick(e: MouseEvent): void {
    const st = store.getState();
    if (st.tool === 'add-device' || st.tool === 'cable') return;
    const local = scene.clientToLocal(e.clientX, e.clientY);
    const w = toWorld(local);
    const hit = hitTest(w.x, w.y);
    if (hit.kind === 'device') void openDeviceSurface(hit.id, 'default');
    else if (hit.kind === 'port') void openDeviceSurface(hit.anchor.ref.device, 'ports');
  }

  function openMenuFor(id: DeviceId, local: { x: number; y: number }, keyboard: boolean): void {
    store.getState().select({ kind: 'device', id });
    setTooltip('', 'plain', null);
    deps.openMenu({ device: id, x: local.x, y: local.y, keyboard });
  }

  function onContextMenu(e: MouseEvent): void {
    e.preventDefault();
    const local = scene.clientToLocal(e.clientX, e.clientY);
    const w = toWorld(local);
    const id = deps.devices.hit(deps.getLayout(), w.x, w.y, store.getState().tool === 'cable', worldRadius(4, 4, 120));
    if (!id) {
      deps.openMenu(null);
      return;
    }
    openMenuFor(id, local, false);
  }

  function zoomAbout(local: { x: number; y: number }, factor: number): void {
    const cam = scene.camera;
    const zoomed = cam.zoom * factor;
    const wx = (local.x - cam.x) / cam.zoom;
    const wy = (local.y - cam.y) / cam.zoom;
    scene.setCamera({ x: local.x - wx * zoomed, y: local.y - wy * zoomed, zoom: zoomed });
    // setCamera clamps the zoom; re-anchor on the clamped value so the anchor point stays put
    const z = scene.camera.zoom;
    scene.setCamera({ x: local.x - wx * z, y: local.y - wy * z, zoom: z });
    scheduleCameraSync();
  }

  function onWheel(e: WheelEvent): void {
    e.preventDefault();
    deps.openMenu(null);
    const local = scene.clientToLocal(e.clientX, e.clientY);
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? scene.height : 1;
    zoomAbout(local, Math.exp(-e.deltaY * unit * 0.0015));
    if (!press) updateHover(local);
  }

  /** The device keyboard actions apply to: the focused one, else the selected one. */
  function keyboardDevice(): DeviceId | null {
    const st = store.getState();
    const layout = deps.getLayout();
    const focus = st.a11y.canvasFocus;
    if (focus !== null && layout.devices.has(focus)) return focus;
    const sel = st.selection;
    const id = sel?.kind === 'device' ? sel.id : sel?.kind === 'port' ? sel.ref.device : sel?.kind === 'slot' ? sel.device : null;
    return id !== null && layout.devices.has(id) ? id : null;
  }

  /** Keys handled while the canvas element itself has focus. */
  function onCanvasKeyDown(e: KeyboardEvent): void {
    if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey) return;
    const st = store.getState();
    if (e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey)) {
      const id = keyboardDevice();
      if (id === null) return;
      e.preventDefault();
      const p = deps.a11y.screenPoint(id);
      const g = deps.getLayout().devices.get(id);
      const local = p ?? (g ? scene.worldToLocal(g.x, g.y) : { x: scene.width / 2, y: scene.height / 2 });
      openMenuFor(id, local, true);
      return;
    }
    if (e.shiftKey) return;
    switch (e.key) {
      case 'Enter':
      case 'F6': {
        if (e.key === 'Enter' && st.tool === 'cable' && st.pendingCable) {
          e.preventDefault();
          if (!deps.a11y.beginCable(st.pendingCable.from)) st.toast('The keyboard cabling dialog is not available.', 'warn');
          return;
        }
        const id = keyboardDevice() ?? deps.getLayout().devices.keys().next().value ?? null;
        if (id === null) return;
        e.preventDefault();
        if (!deps.a11y.focusDevice(id)) st.setCanvasFocus(id);
        return;
      }
      case 'ArrowLeft':
      case 'ArrowRight':
      case 'ArrowUp':
      case 'ArrowDown': {
        e.preventDefault();
        const dx = e.key === 'ArrowLeft' ? KEY_PAN_PX : e.key === 'ArrowRight' ? -KEY_PAN_PX : 0;
        const dy = e.key === 'ArrowUp' ? KEY_PAN_PX : e.key === 'ArrowDown' ? -KEY_PAN_PX : 0;
        scene.setCamera({ x: scene.camera.x + dx, y: scene.camera.y + dy, zoom: scene.camera.zoom });
        scheduleCameraSync();
        return;
      }
      case '+':
      case '=':
        e.preventDefault();
        zoomAbout({ x: scene.width / 2, y: scene.height / 2 }, KEY_ZOOM);
        return;
      case '-':
      case '_':
        e.preventDefault();
        zoomAbout({ x: scene.width / 2, y: scene.height / 2 }, 1 / KEY_ZOOM);
        return;
      default:
        return;
    }
  }

  function onKeyDown(e: KeyboardEvent): void {
    if (e.key === ' ' && !isTypingTarget(e.target)) {
      if (!spaceHeld) {
        spaceHeld = true;
        if (!press) setCursor('grab');
      }
      return;
    }
    if (e.key === 'Escape') {
      deps.openMenu(null);
      if (press && press.kind === 'device' && press.deviceId !== undefined && press.origin) {
        const { deviceId, origin, pointerId } = press;
        press = null;
        try {
          if (canvas.hasPointerCapture(pointerId)) canvas.releasePointerCapture(pointerId);
        } catch {
          /* ignore */
        }
        if (moveTimer !== undefined) {
          clearTimeout(moveTimer);
          moveTimer = undefined;
        }
        deps.overrides.set(deviceId, origin);
        deps.invalidateLayout();
        queuedMove = { id: deviceId, pos: origin };
        flushMove();
      }
    }
  }

  function onKeyUp(e: KeyboardEvent): void {
    if (e.key === ' ') {
      spaceHeld = false;
      if (!press) setCursor(idleCursor());
    }
  }

  function onBlur(): void {
    spaceHeld = false;
  }

  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerup', onPointerUp);
  canvas.addEventListener('pointercancel', onPointerCancel);
  canvas.addEventListener('pointerleave', onPointerLeave);
  canvas.addEventListener('dblclick', onDoubleClick);
  canvas.addEventListener('contextmenu', onContextMenu);
  canvas.addEventListener('wheel', onWheel, { passive: false });
  canvas.addEventListener('keydown', onCanvasKeyDown);
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  window.addEventListener('blur', onBlur);

  return {
    get target() {
      return target;
    },
    get dragging() {
      return press?.kind === 'device' ? (press.deviceId ?? null) : null;
    },
    refresh,
    detach() {
      if (detached) return;
      detached = true;
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('pointermove', onPointerMove);
      canvas.removeEventListener('pointerup', onPointerUp);
      canvas.removeEventListener('pointercancel', onPointerCancel);
      canvas.removeEventListener('pointerleave', onPointerLeave);
      canvas.removeEventListener('dblclick', onDoubleClick);
      canvas.removeEventListener('contextmenu', onContextMenu);
      canvas.removeEventListener('wheel', onWheel);
      canvas.removeEventListener('keydown', onCanvasKeyDown);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
      finishMove();
      if (cameraTimer !== undefined) {
        clearTimeout(cameraTimer);
        cameraTimer = undefined;
        store.getState().setCamera({ ...scene.camera });
      }
      press = null;
      preview.destroy();
      deps.tooltip.hidden = true;
    },
  };
}
