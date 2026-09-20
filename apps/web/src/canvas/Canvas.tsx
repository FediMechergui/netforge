/**
 * Topology canvas (spec §8.2 logical view, §8.3 interaction, §9.1 packet animation, §16 keyboard canvas;
 * ARCHITECTURE-P1 §7 "Canvas core" and "Wireless overlays").
 *
 * The component only mounts DOM: a host for the Pixi surface, an imperative tooltip, a tool hint banner, the
 * device context menu and the keyboard canvas (`CanvasOutline`: outline tree, keyboard cabling, live region).
 * Everything drawn on the canvas is driven by `runCanvas`, a requestAnimationFrame loop that reads
 * `store.getState()` directly — React never re-renders per frame.
 *
 * Paint order: range rings → cables → association lines and radio beams → packets → drop markers and collision
 * bursts → devices → signal/phase/channel labels → cable preview. Layers cull against the visible world rectangle
 * (re-culled only when the coarse view key changes) and draw at a level of detail chosen from the zoom, so
 * topologies with hundreds of devices stay responsive.
 *
 * Keyboard bridge: `registerCanvasA11y(api)` is the pinned hook the a11y layer calls to hand the canvas its
 * `focusDevice` / `screenPoint` / `beginCable` functions; it returns the unregister function.
 *
 * ponytail: while a concept view covers the workspace (§4.13) the loop returns before it reads the world or
 * draws anything, instead of tearing the scene down and rebuilding it; the rAF callback itself stays
 * scheduled, which is one no-op call per frame against a full re-create of every layer.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, RefObject } from 'react';
import type { DeviceId, PortRef, SimSnapshot } from '@netforge/engine';
import { buildCableLookup, portCompatibility, serialDceHint, type CableLookup, type PortCompat } from '../app/cable/cable-compat';
import { openDeviceSurface, type DeviceSurface } from '../shared/openDeviceSurface';
import { extrapolatedNow, selectDevice, useDevice } from '../store/selectors';
import { store, useStore } from '../store/store';
import type { WirelessOverlayState } from '../store/types';
import { GUI_PANEL_VOCAB } from '../vocab/categories';
import { MEDIA_VOCAB } from '../vocab/media';
import { AirLayer, CANVAS_OVERLAY_DEFAULTS, legGeometry } from './air';
import { CableLayer } from './cables';
import { DeviceLayer } from './devices';
import { attachInteraction, deleteDevice, setDevicePower, type ContextMenuRequest, type InteractionA11y } from './interaction';
import { MarkerLayer } from './markers';
import { PacketLayer } from './packets';
import { computeLayout, deviceBounds, emptyLayout, snapshotReplaced, type Layout, type Position } from './ports';
import { DEFAULT_METRES_PER_UNIT, RfLayer } from './rf';
import { Scene, lodFor, textResolutionFor, viewKey } from './scene';
import { CanvasOutline } from './a11y/CanvasOutline';
import './canvas.css';

/** Under reduced motion capsules are re-positioned at this wall interval instead of gliding. */
const REDUCED_MOTION_SAMPLE_MS = 350;

// ── keyboard bridge (pinned) ─────────────────────────────────────────────────

/** Functions the a11y layer gives the canvas (structurally the a11y `CanvasA11yApi`). */
export interface CanvasA11yHooks {
  /** Move keyboard focus to the device's row in the outline. */
  focusDevice(id: DeviceId): void;
  /** Where the device is drawn (canvas-local pixels), or null. */
  screenPoint(id: DeviceId): { x: number; y: number } | null;
  /** Continue a cable from `from` in the keyboard cabling dialog. */
  beginCable(from: PortRef): void;
}

const a11yHooks: CanvasA11yHooks[] = [];

/** Register the a11y layer's hooks; the most recent registration wins. Returns the unregister function. */
export function registerCanvasA11y(api: CanvasA11yHooks): () => void {
  a11yHooks.push(api);
  return () => {
    const i = a11yHooks.lastIndexOf(api);
    if (i >= 0) a11yHooks.splice(i, 1);
  };
}

function currentHooks(): CanvasA11yHooks | undefined {
  return a11yHooks[a11yHooks.length - 1];
}

const interactionA11y: InteractionA11y = {
  focusDevice(id) {
    const h = currentHooks();
    if (!h) return false;
    h.focusDevice(id);
    return true;
  },
  screenPoint(id) {
    return currentHooks()?.screenPoint(id) ?? null;
  },
  beginCable(from) {
    const h = currentHooks();
    if (!h) return false;
    h.beginCable(from);
    return true;
  },
};

// ── component ────────────────────────────────────────────────────────────────

export function Canvas() {
  const surfaceRef = useRef<HTMLDivElement>(null);
  const tipRef = useRef<HTMLDivElement>(null);
  const [menu, setMenu] = useState<ContextMenuRequest | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  useEffect(() => {
    const host = surfaceRef.current;
    const tip = tipRef.current;
    if (!host || !tip) return undefined;
    let cancelled = false;
    let stop: (() => void) | undefined;
    Scene.create(host)
      .then((scene) => {
        if (cancelled) {
          scene.destroy();
          return;
        }
        stop = runCanvas(scene, tip, setMenu);
      })
      .catch((err: unknown) => {
        if (!cancelled) setFailure(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
      stop?.();
      stop = undefined;
    };
  }, []);

  const closeMenu = useCallback(() => setMenu(null), []);

  return (
    <div className="nf-canvas">
      <div className="nf-canvas-host" ref={surfaceRef} />
      <div ref={tipRef} className="nf-canvas-tip" role="tooltip" hidden />
      <CanvasHint />
      {menu && <DeviceMenu menu={menu} onClose={closeMenu} host={surfaceRef} />}
      <CanvasOutline />
      {failure && (
        <div className="nf-canvas-failure" role="alert">
          <b>The topology view could not start.</b>
          <span>This browser did not provide a WebGL drawing surface ({failure}).</span>
        </div>
      )}
    </div>
  );
}

/** One-line guidance for the active tool, or an empty-workspace nudge. */
function CanvasHint() {
  const hint = useStore((s): string | null => {
    if (s.tool === 'add-device') {
      const m = s.catalog.find((x) => x.type === s.addDeviceType);
      return `Click the canvas to place ${m ? m.model : 'a device'}. Esc cancels.`;
    }
    if (s.tool === 'cable') {
      const media = s.pendingCable?.media ?? s.cable.media;
      const cable = MEDIA_VOCAB[media].short;
      if (s.pendingCable) {
        const dce = serialDceHint(media, s.pendingCable.from);
        return `${cable}: now click a port dot on the other device. Enter continues with the keyboard, Esc drops it.${dce ? ` ${dce.text}` : ''}`;
      }
      return `${cable}: click a port dot under a device to start. Crossed-out dots do not take this cable. Esc leaves cabling.`;
    }
    if (s.tool === 'pan') return 'Drag to move around the workspace.';
    if (s.ready && s.snapshot && s.snapshot.devices.length === 0) {
      return 'Empty workspace: choose a device in the palette, then click here to place it.';
    }
    return null;
  });
  if (!hint) return null;
  return (
    <div className="nf-canvas-hint" aria-live="polite">
      {hint}
    </div>
  );
}

interface MenuEntry {
  key: string;
  label: string;
  hint?: string;
  danger?: boolean;
  run: () => Promise<unknown>;
}

function DeviceMenu({ menu, onClose, host }: { menu: ContextMenuRequest; onClose: () => void; host: RefObject<HTMLDivElement> }) {
  const device = useDevice(menu.device);
  const ref = useRef<HTMLDivElement>(null);
  const keyboard = menu.keyboard === true;

  const close = useCallback(() => {
    onClose();
    if (keyboard) host.current?.querySelector<HTMLCanvasElement>('canvas')?.focus({ preventScroll: true });
  }, [onClose, keyboard, host]);

  useEffect(() => {
    const onDown = (e: PointerEvent): void => {
      if (ref.current && e.target instanceof Node && !ref.current.contains(e.target)) onClose();
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') close();
    };
    window.addEventListener('pointerdown', onDown, true);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('keydown', onKey);
    };
  }, [onClose, close]);

  useEffect(() => {
    if (!device) onClose();
  }, [device, onClose]);

  useEffect(() => {
    ref.current?.querySelector<HTMLButtonElement>('button')?.focus();
  }, []);

  if (!device) return null;
  const id: DeviceId = device.id;
  const open = (surface: DeviceSurface) => () => openDeviceSurface(id, surface);
  const entries: MenuEntry[] = [];
  const hasShell = device.cli === undefined || device.cli.shell !== 'none';
  const gui = device.gui ?? [];
  const apps = gui.filter((g) => GUI_PANEL_VOCAB[g].placement === 'desktop-app');
  const panels = gui.filter((g) => GUI_PANEL_VOCAB[g].placement !== 'desktop-app');
  if (apps.length > 0) entries.push({ key: 'desktop', label: 'Open desktop', hint: 'double-click', run: open('desktop') });
  if (hasShell) entries.push({ key: 'console', label: 'Open console', hint: apps.length > 0 ? undefined : 'double-click', run: open('console') });
  for (const app of apps) entries.push({ key: app, label: `${GUI_PANEL_VOCAB[app].label}…`, run: open(app) });
  for (const p of panels) entries.push({ key: p, label: `${GUI_PANEL_VOCAB[p].label} settings`, run: open(p) });
  entries.push({ key: 'details', label: 'Show details', run: open('overview') });
  entries.push({ key: 'power', label: device.power ? 'Power off' : 'Power on', run: () => setDevicePower(id, !device.power) });
  entries.push({ key: 'delete', label: 'Delete device', hint: 'Del', danger: true, run: () => deleteDevice(id) });

  const run = (action: () => Promise<unknown>): void => {
    close();
    void action();
  };

  const onMenuKey = (e: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'Home' && e.key !== 'End') return;
    const items = [...(ref.current?.querySelectorAll<HTMLButtonElement>('button[role="menuitem"]') ?? [])];
    if (items.length === 0) return;
    e.preventDefault();
    const at = items.indexOf(document.activeElement as HTMLButtonElement);
    let next = 0;
    if (e.key === 'End') next = items.length - 1;
    else if (e.key === 'ArrowDown') next = at < 0 ? 0 : (at + 1) % items.length;
    else if (e.key === 'ArrowUp') next = at <= 0 ? items.length - 1 : at - 1;
    items[next]?.focus();
  };

  const surfaceW = host.current?.clientWidth ?? 0;
  const surfaceH = host.current?.clientHeight ?? 0;
  const left = surfaceW > 0 ? Math.max(4, Math.min(menu.x, surfaceW - 200)) : menu.x;
  const top = surfaceH > 0 ? Math.max(4, Math.min(menu.y, surfaceH - (entries.length * 30 + 40))) : menu.y;

  return (
    <div
      ref={ref}
      className="nf-canvas-menu menu-popup"
      role="menu"
      aria-label={`${device.name} actions`}
      style={{ left, top }}
      onKeyDown={onMenuKey}
    >
      <div className="menu-heading" aria-hidden="true">
        {device.name}
      </div>
      {entries.map((entry, i) => (
        <div key={entry.key} role="none">
          {entry.danger && i > 0 && <div className="menu-sep" />}
          <button
            type="button"
            role="menuitem"
            className={entry.danger ? 'menu-item nf-danger' : 'menu-item'}
            onClick={() => run(entry.run)}
          >
            {entry.label}
            {entry.hint !== undefined && <span className="hint">{entry.hint}</span>}
          </button>
        </div>
      ))}
    </div>
  );
}

// ── frame loop ──────────────────────────────────────────────────────────────

function isDefaultCamera(c: { x: number; y: number; zoom: number }): boolean {
  return c.x === 0 && c.y === 0 && c.zoom === 1;
}

function runCanvas(scene: Scene, tip: HTMLElement, openMenu: (m: ContextMenuRequest | null) => void): () => void {
  const overrides = new Map<DeviceId, Position>();
  const rf = new RfLayer(scene.layers.rf, scene.layers.labels);
  const cables = new CableLayer(scene.layers.cables);
  const air = new AirLayer(scene.layers.air, scene.layers.labels);
  const packets = new PacketLayer(scene.layers.packets);
  const markers = new MarkerLayer(scene.layers.markers);
  const devices = new DeviceLayer(scene.layers.devices);

  let layout: Layout = emptyLayout();
  let layoutDirty = true;
  let styleDirty = true;
  let compat: ReadonlyMap<string, PortCompat> | null = null;

  const initial = store.getState();
  scene.setCamera(initial.camera);
  // A restored (non-default) camera means the user already framed the view: do not auto-fit.
  let knownDeviceCount = isDefaultCamera(initial.camera) ? 0 : (initial.snapshot?.devices.length ?? 0);

  const interaction = attachInteraction({
    scene,
    getLayout: () => layout,
    devices,
    cables,
    packets,
    markers,
    air,
    getCompat: () => compat,
    overrides,
    invalidateLayout: () => {
      layoutDirty = true;
    },
    invalidateStyle: () => {
      styleDirty = true;
    },
    tooltip: tip,
    openMenu,
    a11y: interactionA11y,
  });

  const themeObserver = new MutationObserver(() => {
    scene.refreshTheme();
    styleDirty = true;
  });
  themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

  let lastSnapshot: SimSnapshot | null = null;
  let lastEpoch = initial.epoch;
  let lastSelection = initial.selection;
  let lastHover = initial.hover;
  let lastTool = initial.tool;
  let lastPending = initial.pendingCable;
  let lastTarget = interaction.target;
  let lastRes = 0;
  let lastLod = lodFor(scene.camera.zoom);
  let lastZoom = scene.camera.zoom;
  let lastViewKey = '';
  let lastOverlays: WirelessOverlayState | undefined = initial.overlays;
  let lastFocus = initial.a11y.canvasFocus;
  let lastGrid = false;
  let compatKey: { snap: SimSnapshot | null; from: string; media: string; lookup: CableLookup } | null = null;
  let lookupSource: { catalog: unknown; modules: unknown; lookup: CableLookup } | null = null;
  let lastPackets = 0;
  let lastMarkers = 0;
  let raf = 0;
  let alive = true;

  const lookupFor = (st: ReturnType<typeof store.getState>): CableLookup => {
    if (!lookupSource || lookupSource.catalog !== st.catalog || lookupSource.modules !== st.modules) {
      lookupSource = { catalog: st.catalog, modules: st.modules, lookup: buildCableLookup(st.catalog, st.modules) };
    }
    return lookupSource.lookup;
  };

  const pruneOverrides = (st: ReturnType<typeof store.getState>, snap: SimSnapshot | null, prev: SimSnapshot | null): void => {
    const dragging = interaction.dragging;
    const reloaded = !!snap && !!prev && (snap.seed !== prev.seed || snap.topologyVersion < prev.topologyVersion);
    for (const [id, pos] of overrides) {
      if (id === dragging) continue;
      const d = selectDevice(st, id);
      if (reloaded || !d || (Math.abs(d.position.x - pos.x) < 0.5 && Math.abs(d.position.y - pos.y) < 0.5)) {
        overrides.delete(id);
      }
    }
  };

  const maybeFit = (snap: SimSnapshot | null, prev: SimSnapshot | null): void => {
    const count = snap?.devices.length ?? 0;
    const replaced = snapshotReplaced(prev, snap);
    const fromEmpty = knownDeviceCount === 0 && count >= 2;
    knownDeviceCount = count;
    if (!snap || (!replaced && !fromEmpty)) return;
    const fitLayout = computeLayout(snap, overrides);
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const g of fitLayout.devices.values()) {
      const b = deviceBounds(g, false);
      minX = Math.min(minX, b.minX);
      minY = Math.min(minY, b.minY);
      maxX = Math.max(maxX, b.maxX);
      maxY = Math.max(maxY, b.maxY);
    }
    if (!Number.isFinite(minX)) return;
    scene.fitTo({ minX, minY, maxX, maxY });
    store.getState().setCamera({ ...scene.camera });
  };

  const frame = (): void => {
    if (!alive) return;
    const st = store.getState();
    // §4.13: a concept tool covers this cell. The scene stays mounted; it simply stops drawing until the
    // student comes back, and the next frame then sees the world as it is now.
    if (st.view === 'concept') {
      raf = requestAnimationFrame(frame);
      return;
    }
    const wall = performance.now();

    if (st.epoch !== lastEpoch) {
      lastEpoch = st.epoch;
      markers.clearBursts();
    }

    const snap = st.snapshot;
    if (snap !== lastSnapshot) {
      pruneOverrides(st, snap, lastSnapshot);
      maybeFit(snap, lastSnapshot);
      lastSnapshot = snap;
      layoutDirty = true;
    }
    const showGrid = st.tool === 'cable';
    if (showGrid !== lastGrid) {
      lastGrid = showGrid;
      layoutDirty = true;
    }
    if (layoutDirty) {
      layout = computeLayout(snap, overrides, { picker: showGrid });
      layoutDirty = false;
      styleDirty = true;
    }

    // picker verdicts for the chosen cable (recomputed only when their inputs change)
    if (showGrid && snap) {
      const from = st.pendingCable?.from;
      const media = st.pendingCable?.media ?? st.cable.media;
      const lookup = lookupFor(st);
      const fromKey = from ? `${from.device}/${from.port}` : '';
      if (!compatKey || compatKey.snap !== snap || compatKey.from !== fromKey || compatKey.media !== media || compatKey.lookup !== lookup) {
        compatKey = { snap, from: fromKey, media, lookup };
        compat = portCompatibility(snap, lookup, from ?? null, media);
        styleDirty = true;
      }
    } else if (compat !== null) {
      compat = null;
      compatKey = null;
      styleDirty = true;
    }

    // keyboard focus: highlight and keep the device on screen
    const focus = st.a11y.canvasFocus;
    if (focus !== lastFocus) {
      lastFocus = focus;
      styleDirty = true;
      const g = focus !== null ? layout.devices.get(focus) : undefined;
      if (g && scene.reveal(deviceBounds(g, false))) store.getState().setCamera({ ...scene.camera });
    }

    const zoom = scene.camera.zoom;
    const lod = lodFor(zoom);
    const view = scene.viewBounds();
    const vkey = viewKey(view, zoom);
    if (zoom !== lastZoom) {
      lastZoom = zoom;
      devices.updateZoom(zoom);
      scene.dirty = true;
    }
    if (vkey !== lastViewKey) {
      lastViewKey = vkey;
      // hide what left the view at once; the style pass below redraws what entered it (rings, air lines and
      // labels also follow the zoom bucket carried by the view key)
      cables.cull(view, zoom);
      devices.cull(view, zoom);
      styleDirty = true;
      scene.dirty = true;
    }
    const res = textResolutionFor(zoom);
    const overlays = st.overlays ?? CANVAS_OVERLAY_DEFAULTS;
    const target = interaction.target;
    if (
      styleDirty ||
      st.selection !== lastSelection ||
      st.hover !== lastHover ||
      st.tool !== lastTool ||
      st.pendingCable !== lastPending ||
      target !== lastTarget ||
      res !== lastRes ||
      lod !== lastLod ||
      overlays !== lastOverlays
    ) {
      styleDirty = false;
      lastSelection = st.selection;
      lastHover = st.hover;
      lastTool = st.tool;
      lastPending = st.pendingCable;
      lastTarget = target;
      lastRes = res;
      lastLod = lod;
      lastOverlays = overlays;
      const theme = scene.theme;
      const metresPerUnit = snap?.media?.metresPerUnit ?? DEFAULT_METRES_PER_UNIT;
      rf.sync({
        layout,
        metresPerUnit,
        theme,
        showRings: overlays.rangeRings,
        showChannels: overlays.channelLabels,
        selection: st.selection,
        zoom,
        lod,
        view,
        textResolution: res,
      });
      cables.sync({ layout, theme, selection: st.selection, hover: st.hover, zoom, lod, view, textResolution: res });
      air.sync({
        layout,
        media: snap?.media,
        overlays,
        theme,
        selection: st.selection,
        hover: st.hover,
        zoom,
        lod,
        view,
        textResolution: res,
      });
      devices.sync({
        layout,
        theme,
        selection: st.selection,
        hover: st.hover,
        showGrid,
        pendingFrom: st.pendingCable?.from ?? null,
        target,
        compat,
        focus,
        textResolution: res,
        zoom,
        lod,
        view,
      });
      interaction.refresh();
      scene.dirty = true;
    }

    const animating = devices.animate(wall, scene.reducedMotion);
    const sampleWall = scene.reducedMotion ? Math.floor(wall / REDUCED_MOTION_SAMPLE_MS) * REDUCED_MOTION_SAMPLE_MS : wall;
    const now = extrapolatedNow(st, Math.max(st.nowWall, sampleWall));
    const selectedPdu = st.selection?.kind === 'pdu' ? st.selection.id : null;

    const onWire = packets.update({
      inflight: st.inflight,
      now,
      paths: {
        links: layout.links,
        cable: (id) => cables.geometry(id),
        beam: (id) => air.beamGeometry(id),
        air: (from, to) => legGeometry(from, to, layout),
      },
      theme: scene.theme,
      colourByFlow: st.colourByFlow,
      selectedPdu,
      trails: !scene.reducedMotion,
      showBackground: overlays.backgroundFrames,
      zoom,
      view,
      textResolution: res,
    });
    markers.ingest(st.events, wall);
    const floating = markers.update({
      markers: st.dropMarkers,
      wallNow: wall,
      layout,
      linkGeometry: (id) => cables.geometry(id) ?? air.beamGeometry(id),
      assocGeometry: (id) => air.assocGeometry(id),
      linkEnds: (id) => layout.links.get(id),
      theme: scene.theme,
      zoom,
      reducedMotion: scene.reducedMotion,
      selectedPdu,
      textResolution: res,
    });

    if (scene.dirty || animating || onWire > 0 || lastPackets > 0 || floating > 0 || lastMarkers > 0) {
      scene.render();
    }
    lastPackets = onWire;
    lastMarkers = floating;
    raf = requestAnimationFrame(frame);
  };
  raf = requestAnimationFrame(frame);

  return () => {
    alive = false;
    cancelAnimationFrame(raf);
    themeObserver.disconnect();
    interaction.detach();
    packets.destroy();
    markers.destroy();
    air.destroy();
    rf.destroy();
    cables.destroy();
    devices.destroy();
    if (store.getState().hover) store.getState().setHover(null);
    scene.destroy();
  };
}
