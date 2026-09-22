/**
 * PixiJS application lifecycle for the topology canvas.
 *
 * One `Scene` per <Canvas/> mount. It owns the Pixi `Application`, the camera
 * (world container transform), the background dot grid, and the draw layers in
 * paint order: rf (range rings) → vlan → stp → capwap (the topology overlays'
 * underlays: VLAN tints and trunk rails, the active spanning tree, controller
 * tunnels; ARCHITECTURE-P2 §6) → cables → air (association lines, radio beams)
 * → packets → markers → devices → labels (signal bars, dBm text, phase badges,
 * channel labels, VLAN chips, spanning-tree letters and crowns) → overlay
 * (cable preview, keyboard focus ring). Devices sit above packets so their
 * ports stay clickable; the overlay underlays sit below the cables so a trunk
 * rail or the active tree reads as a track the cable runs on, never as a dash
 * pattern (D20).
 *
 * The camera zooms from ZOOM_MIN (0.05, so kilometre radio links fit on screen)
 * to ZOOM_MAX. `viewBounds()` gives the visible world rectangle for culling and
 * `lodFor(zoom)` the level of detail the layers draw at.
 *
 * Rendering is manual (`autoStart: false`): the canvas loop in Canvas.tsx calls
 * `render()` from its own requestAnimationFrame. Hit testing is done by the
 * canvas modules against their own geometry, so Pixi's event system is unused.
 */
import { Application, Container, Graphics, Text } from 'pixi.js';
import type { IconPalette } from '../catalog/icon-types';
import { paletteFromCss } from '../catalog/render-pixi';

// ── theme ────────────────────────────────────────────────────────────────────

export interface ThemeColors {
  bg: number;
  bg2: number;
  panel: number;
  panel2: number;
  border: number;
  borderStrong: number;
  text: number;
  textDim: number;
  textFaint: number;
  accent: number;
  ok: number;
  warn: number;
  err: number;
  purple: number;
  yellow: number;
  blueDeep: number;
  sans: string;
  mono: string;
  /** Theme-resolved paints of the device icon language (catalog/icon-types.ts). */
  icon: IconPalette;
  /** Changes whenever the palette is re-read, so views can cheaply detect a theme switch. */
  stamp: number;
}

const FALLBACK: Omit<ThemeColors, 'stamp' | 'icon'> = {
  bg: 0x0f1216,
  bg2: 0x161a20,
  panel: 0x1b2029,
  panel2: 0x212836,
  border: 0x2a3140,
  borderStrong: 0x3a4356,
  text: 0xe6e9ef,
  textDim: 0x8a93a5,
  textFaint: 0x5d6678,
  accent: 0x56b4e9,
  ok: 0x009e73,
  warn: 0xe69f00,
  err: 0xd55e00,
  purple: 0xcc79a7,
  yellow: 0xf0e442,
  blueDeep: 0x0072b2,
  sans: "'Segoe UI', system-ui, sans-serif",
  mono: 'Consolas, monospace',
};

/** Parse `#rgb`, `#rrggbb`, `rgb(r, g, b)` or `rgba(r, g, b, a)` into 0xRRGGBB. */
export function parseCssColor(value: string, fallback: number): number {
  const v = value.trim();
  if (v.startsWith('#')) {
    const hex = v.slice(1);
    if (/^[0-9a-f]{3}$/i.test(hex)) {
      const [r = '0', g = '0', b = '0'] = hex.split('');
      return parseInt(r + r + g + g + b + b, 16);
    }
    if (/^[0-9a-f]{6}([0-9a-f]{2})?$/i.test(hex)) return parseInt(hex.slice(0, 6), 16);
    return fallback;
  }
  const m = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/i.exec(v);
  if (m) {
    const c = (s: string | undefined): number => Math.max(0, Math.min(255, Math.round(Number(s ?? 0))));
    return (c(m[1]) << 16) | (c(m[2]) << 8) | c(m[3]);
  }
  return fallback;
}

let themeStamp = 0;

/** Read the app tokens from CSS variables on the root element (call again after a theme switch). */
export function readTheme(): ThemeColors {
  const cs = getComputedStyle(document.documentElement);
  const col = (name: string, fb: number): number => parseCssColor(cs.getPropertyValue(name), fb);
  const str = (name: string, fb: string): string => cs.getPropertyValue(name).trim() || fb;
  themeStamp += 1;
  return {
    bg: col('--bg', FALLBACK.bg),
    bg2: col('--bg-2', FALLBACK.bg2),
    panel: col('--panel', FALLBACK.panel),
    panel2: col('--panel-2', FALLBACK.panel2),
    border: col('--border', FALLBACK.border),
    borderStrong: col('--border-strong', FALLBACK.borderStrong),
    text: col('--text', FALLBACK.text),
    textDim: col('--text-dim', FALLBACK.textDim),
    textFaint: col('--text-faint', FALLBACK.textFaint),
    accent: col('--accent', FALLBACK.accent),
    ok: col('--ok', FALLBACK.ok),
    warn: col('--warn', FALLBACK.warn),
    err: col('--err', FALLBACK.err),
    purple: col('--purple', FALLBACK.purple),
    yellow: col('--yellow', FALLBACK.yellow),
    blueDeep: col('--blue-deep', FALLBACK.blueDeep),
    sans: str('--sans', FALLBACK.sans),
    mono: str('--mono', FALLBACK.mono),
    icon: paletteFromCss((name) => cs.getPropertyValue(name)),
    stamp: themeStamp,
  };
}

// ── text helpers ─────────────────────────────────────────────────────────────

export function makeText(text: string, size: number, fill: number, fontFamily: string, weight: 'normal' | 'bold' = 'normal'): Text {
  return new Text({ text, style: { fontFamily, fontSize: size, fill, fontWeight: weight } });
}

/** Text texture resolution for a zoom level: sharp when zoomed in, bucketed to avoid re-rasterising every wheel tick. */
export function textResolutionFor(zoom: number): number {
  const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
  return Math.min(4, Math.max(1, Math.ceil(dpr * Math.max(1, zoom) * 2) / 2));
}

export function setText(t: Text, text: string, fill: number, fontFamily: string, resolution: number): void {
  if (t.text !== text) t.text = text;
  if (t.style.fill !== fill) t.style.fill = fill;
  if (t.style.fontFamily !== fontFamily) t.style.fontFamily = fontFamily;
  if (t.resolution !== resolution) t.resolution = resolution;
}

// ── camera, culling, level of detail ─────────────────────────────────────────

export interface Camera {
  x: number;
  y: number;
  zoom: number;
}

/** Lowest zoom: a 10 km radio link at 0.25 m per unit (40 000 units) still fits a 2 000 px wide view. */
export const ZOOM_MIN = 0.05;
export const ZOOM_MAX = 3;
const GRID_STEP = 40;

/** A world-space rectangle. */
export interface Rect {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** True when the two rectangles overlap (touching counts). */
export function rectsIntersect(a: Rect, b: Rect): boolean {
  return a.minX <= b.maxX && a.maxX >= b.minX && a.minY <= b.maxY && a.maxY >= b.minY;
}

/** `r` grown by `pad` on every side. */
export function inflateRect(r: Rect, pad: number): Rect {
  return { minX: r.minX - pad, minY: r.minY - pad, maxX: r.maxX + pad, maxY: r.maxY + pad };
}

/**
 * Level of detail:
 *  'full' — everything (zoom ≥ LOD_MID_ZOOM);
 *  'mid'  — no status lines, picker row labels or port-name labels (LOD_FAR_ZOOM ≤ zoom < LOD_MID_ZOOM);
 *  'far'  — icons plus a constant-size locator dot, names only for the selected or focused device, no port
 *           LEDs (zoom < LOD_FAR_ZOOM, used for kilometre-scale radio topologies).
 */
export type Lod = 'full' | 'mid' | 'far';

export const LOD_MID_ZOOM = 0.6;
export const LOD_FAR_ZOOM = 0.25;

export function lodFor(zoom: number): Lod {
  if (zoom >= LOD_MID_ZOOM) return 'full';
  if (zoom >= LOD_FAR_ZOOM) return 'mid';
  return 'far';
}

/** World rectangle seen through a `width × height` viewport with `camera`. */
export function viewRect(camera: Camera, width: number, height: number): Rect {
  const z = camera.zoom > 0 ? camera.zoom : 1;
  return { minX: -camera.x / z, minY: -camera.y / z, maxX: (width - camera.x) / z, maxY: (height - camera.y) / z };
}

/** The camera that centres `bounds` in a `width × height` viewport, zoomed to fit with `padding` to spare. */
export function fitCamera(bounds: Rect, width: number, height: number, padding = 90, maxZoom = 1.4): Camera {
  const bw = Math.max(1, bounds.maxX - bounds.minX + padding * 2);
  const bh = Math.max(1, bounds.maxY - bounds.minY + padding * 2);
  const zoom = Math.min(maxZoom, Math.max(ZOOM_MIN, Math.min(width / bw, height / bh)));
  const cx = (bounds.minX + bounds.maxX) / 2;
  const cy = (bounds.minY + bounds.maxY) / 2;
  return { x: width / 2 - cx * zoom, y: height / 2 - cy * zoom, zoom };
}

/**
 * Coarse key of a view rectangle: changes when the view moves by more than a quarter of its size or the zoom
 * changes by more than ~19 %. Layers re-cull only when it changes (they cull with a half-view margin).
 */
export function viewKey(view: Rect, zoom: number): string {
  const w = Math.max(1, view.maxX - view.minX);
  const h = Math.max(1, view.maxY - view.minY);
  const qx = Math.floor(view.minX / (w / 4));
  const qy = Math.floor(view.minY / (h / 4));
  const qz = Math.round(Math.log2(Math.max(1e-6, zoom)) * 4);
  return `${qx},${qy},${qz}`;
}

/**
 * The topology overlays' underlay containers, in paint order (bottom first) — the same order and ids as the overlay
 * registry (`canvas/overlays/registry.ts` `OVERLAY_MODULES`), so a registry entry finds its container by id.
 */
export const TOPO_LAYER_ORDER = Object.freeze(['vlan', 'stp', 'capwap'] as const);
export type TopoLayerId = (typeof TOPO_LAYER_ORDER)[number];

export interface SceneLayers {
  /** Range rings (under everything drawn on the ground). */
  rf: Container;
  /** @since P2 VLAN overlay underlay: access tints and trunk rails (chips go to `labels`). */
  vlan: Container;
  /** @since P2 Spanning-tree overlay underlay: the active tree (letters, crowns and crosses go to `labels`). */
  stp: Container;
  /** @since P2 Controller-tunnel overlay underlay (W6). */
  capwap: Container;
  cables: Container;
  /** Association lines and point-to-point radio beams. */
  air: Container;
  packets: Container;
  markers: Container;
  devices: Container;
  /** Signal bars, dBm text, phase badges and channel labels (above the device icons). */
  labels: Container;
  overlay: Container;
}

/**
 * The host's size, or a viewport-sized stand-in while it has none. A host under a `display:none` ancestor
 * measures 0x0 — the scene is created behind the landing page, so that is the normal first measurement, not an
 * edge case. One pixel would be a *valid* size and would survive into `fitTo`, which then divides by it and
 * clamps the camera to `ZOOM_MIN`; a stand-in in the right order of magnitude simply looks like a slightly
 * wrong window until the ResizeObserver reports the real one.
 */
function hostSize(host: HTMLElement): { readonly width: number; readonly height: number } {
  return measureHost(host) ?? { width: Math.max(1, window.innerWidth || 1), height: Math.max(1, window.innerHeight || 1) };
}

/** The host's real size, or null while a `display:none` ancestor leaves it 0x0 and it has none. */
export function measureHost(host: Pick<HTMLElement, 'clientWidth' | 'clientHeight'>): { readonly width: number; readonly height: number } | null {
  const w = host.clientWidth;
  const h = host.clientHeight;
  return w > 0 && h > 0 ? { width: w, height: h } : null;
}

export class Scene {
  readonly app: Application;
  readonly host: HTMLElement;
  readonly world = new Container();
  readonly grid = new Graphics();
  readonly layers: SceneLayers;
  camera: Camera = { x: 0, y: 0, zoom: 1 };
  theme: ThemeColors = readTheme();
  reducedMotion = false;
  width = 0;
  height = 0;
  /** Set when the next frame must be painted even if nothing animated. */
  dirty = true;
  private gridDirty = true;
  private readonly cleanups: (() => void)[] = [];
  private destroyed = false;

  /** Create and initialise the Pixi application inside `host`. */
  static async create(host: HTMLElement): Promise<Scene> {
    const app = new Application();
    const { width, height } = hostSize(host);
    await app.init({
      width,
      height,
      backgroundAlpha: 0,
      antialias: true,
      autoDensity: true,
      resolution: window.devicePixelRatio || 1,
      autoStart: false,
      preference: 'webgl',
    });
    return new Scene(app, host);
  }

  private constructor(app: Application, host: HTMLElement) {
    this.app = app;
    this.host = host;
    this.layers = {
      rf: new Container(),
      vlan: new Container(),
      stp: new Container(),
      capwap: new Container(),
      cables: new Container(),
      air: new Container(),
      packets: new Container(),
      markers: new Container(),
      devices: new Container(),
      labels: new Container(),
      overlay: new Container(),
    };
    const canvas = app.canvas;
    canvas.classList.add('nf-canvas-surface');
    host.appendChild(canvas);

    app.stage.addChild(this.grid);
    app.stage.addChild(this.world);
    const l = this.layers;
    this.world.addChild(l.rf, l.vlan, l.stp, l.capwap, l.cables, l.air, l.packets, l.markers, l.devices, l.labels, l.overlay);

    const size = hostSize(host);
    this.width = size.width;
    this.height = size.height;

    // Size tracking. This is also what gives a scene born behind the landing page its real size, the moment the
    // host stops being display:none.
    const ro = new ResizeObserver(() => this.resize());
    ro.observe(host);
    this.cleanups.push(() => ro.disconnect());

    // Device-pixel-ratio changes (window dragged to another monitor, browser zoom).
    let dprQuery: MediaQueryList | undefined;
    const onDpr = (): void => {
      this.resize(true);
      watchDpr();
    };
    const watchDpr = (): void => {
      dprQuery?.removeEventListener('change', onDpr);
      dprQuery = window.matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`);
      dprQuery.addEventListener('change', onDpr);
    };
    watchDpr();
    this.cleanups.push(() => dprQuery?.removeEventListener('change', onDpr));

    // Reduced motion preference.
    const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
    this.reducedMotion = motion.matches;
    const onMotion = (e: MediaQueryListEvent): void => {
      this.reducedMotion = e.matches;
      this.dirty = true;
    };
    motion.addEventListener('change', onMotion);
    this.cleanups.push(() => motion.removeEventListener('change', onMotion));
  }

  get canvas(): HTMLCanvasElement {
    return this.app.canvas;
  }

  /** The underlay container of a topology overlay (by registry id). */
  topoLayer(id: TopoLayerId): Container {
    return this.layers[id];
  }

  /**
   * Re-measure the host, e.g. after it was hidden and shown again. A hidden host measures 0x0, and the last real
   * size is a far better guess than one pixel, so `resize` keeps it; this is how a caller asks for the real size
   * once the host is back on screen. False while the host still has no size, so the caller can wait a frame.
   */
  remeasure(): boolean {
    return this.resize(true);
  }

  private resize(force = false): boolean {
    if (this.destroyed) return false;
    // A display:none ancestor makes the host 0x0. Clamping that to 1 would overwrite the real size and let a
    // later fitTo divide by one pixel, which pins the camera to ZOOM_MIN with the world in the top-left corner.
    // Keeping the previous size instead means a scene that is hidden simply holds still.
    const size = measureHost(this.host);
    if (size === null) return false;
    const { width: w, height: h } = size;
    const dpr = window.devicePixelRatio || 1;
    if (!force && w === this.width && h === this.height && this.app.renderer.resolution === dpr) return true;
    this.width = w;
    this.height = h;
    this.app.renderer.resize(w, h, dpr);
    this.gridDirty = true;
    this.dirty = true;
    return true;
  }

  /** Re-read CSS tokens (after a theme switch). */
  refreshTheme(): void {
    this.theme = readTheme();
    this.gridDirty = true;
    this.dirty = true;
  }

  setCamera(c: Camera): void {
    const zoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, c.zoom));
    if (c.x === this.camera.x && c.y === this.camera.y && zoom === this.camera.zoom) return;
    this.camera = { x: c.x, y: c.y, zoom };
    this.world.position.set(c.x, c.y);
    this.world.scale.set(zoom);
    this.gridDirty = true;
    this.dirty = true;
  }

  /** Visible world rectangle. */
  viewBounds(): Rect {
    return viewRect(this.camera, this.width, this.height);
  }

  /** World coordinates → canvas-local pixels. */
  worldToLocal(wx: number, wy: number): { x: number; y: number } {
    return { x: wx * this.camera.zoom + this.camera.x, y: wy * this.camera.zoom + this.camera.y };
  }

  /** Canvas-local pixel → world coordinates. */
  localToWorld(sx: number, sy: number): { x: number; y: number } {
    return { x: (sx - this.camera.x) / this.camera.zoom, y: (sy - this.camera.y) / this.camera.zoom };
  }

  /** Viewport client coordinates → canvas-local pixels. */
  clientToLocal(clientX: number, clientY: number): { x: number; y: number } {
    const r = this.canvas.getBoundingClientRect();
    return { x: clientX - r.left, y: clientY - r.top };
  }

  /** Centre and zoom the camera on a world rectangle. */
  fitTo(bounds: Rect, padding = 90, maxZoom = 1.4): void {
    this.setCamera(fitCamera(bounds, this.width, this.height, padding, maxZoom));
  }

  /**
   * Pan (never zoom) so that `bounds` lies inside the view with `margin` pixels to spare. Returns true when the
   * camera moved. Used to keep the keyboard-focused device on screen.
   */
  reveal(bounds: Rect, margin = 40): boolean {
    const { x, y, zoom } = this.camera;
    const left = bounds.minX * zoom + x;
    const right = bounds.maxX * zoom + x;
    const top = bounds.minY * zoom + y;
    const bottom = bounds.maxY * zoom + y;
    let dx = 0;
    let dy = 0;
    if (right - left > this.width - 2 * margin) dx = this.width / 2 - (left + right) / 2;
    else if (left < margin) dx = margin - left;
    else if (right > this.width - margin) dx = this.width - margin - right;
    if (bottom - top > this.height - 2 * margin) dy = this.height / 2 - (top + bottom) / 2;
    else if (top < margin) dy = margin - top;
    else if (bottom > this.height - margin) dy = this.height - margin - bottom;
    if (dx === 0 && dy === 0) return false;
    this.setCamera({ x: x + dx, y: y + dy, zoom });
    return true;
  }

  private drawGrid(): void {
    const g = this.grid;
    g.clear();
    const { x, y, zoom } = this.camera;
    let step = GRID_STEP * zoom;
    while (step < 16) step *= 2;
    const ox = ((x % step) + step) % step;
    const oy = ((y % step) + step) % step;
    const size = zoom >= 1 ? 1.6 : 1.2;
    let count = 0;
    for (let py = oy; py < this.height; py += step) {
      for (let px = ox; px < this.width; px += step) {
        g.rect(px - size / 2, py - size / 2, size, size);
        count += 1;
      }
    }
    if (count > 0) g.fill({ color: this.theme.borderStrong, alpha: 0.55 });
  }

  render(): void {
    if (this.destroyed) return;
    if (this.gridDirty) {
      this.drawGrid();
      this.gridDirty = false;
    }
    this.app.render();
    this.dirty = false;
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    for (const c of this.cleanups.splice(0)) c();
    this.app.destroy(true, { children: true });
  }
}
