/**
 * Device sprites.
 *
 * Each device draws its original icon from the visual registry (catalog/visuals.ts → `drawIcon`) with the badge
 * text placed at `badgeLayout`, a name label and a status line underneath, power/boot state (dimmed and labelled
 * "powered off"; pulsing ring and "starting…" while booting), a selection/hover halo, a dashed keyboard focus
 * ring, port LEDs at edge anchors, antenna markers for radio ports, and — while the cable tool is active — the
 * grouped port picker (front, uplinks, module slots, radio, console rows) with each port's compatibility for
 * the chosen cable (occupied bar, incompatible slash, source/target rings; never colour alone).
 *
 * Culling and level of detail: devices outside the view are hidden and not redrawn; at LOD 'mid' the status
 * line and picker row labels are hidden; at LOD 'far' names and LEDs are hidden (except for the selected or
 * focused device) and a constant-size locator dot marks each device.
 */
import { Container, Graphics, type Text } from 'pixi.js';
import { portKey, type DeviceId, type PortRef, type Selection } from '@netforge/engine';
import type { PortCompat } from '../app/cable/cable-compat';
import type { IconDef } from '../catalog/icon-types';
import { badgeLayout, drawIcon } from '../catalog/render-pixi';
import { GRID_SPACING, PORT_DOT_R, deviceBounds, drawLed, ledState, type DeviceGeom, type Layout, type PortAnchor } from './ports';
import { inflateRect, makeText, rectsIntersect, setText, type Lod, type Rect, type ThemeColors } from './scene';

export interface CableTargetHint {
  key: string;
  ok: boolean | null;
}

export interface DeviceSyncInput {
  layout: Layout;
  theme: ThemeColors;
  selection: Selection | null;
  hover: Selection | null;
  /** Show the port picker under every device (cable tool; the layout must carry picker anchors). */
  showGrid: boolean;
  pendingFrom: PortRef | null;
  target: CableTargetHint | null;
  /** Picker verdicts by port key for the chosen media (cable tool). */
  compat: ReadonlyMap<string, PortCompat> | null;
  /** Device with keyboard focus on the canvas. */
  focus: DeviceId | null;
  textResolution: number;
  zoom: number;
  lod: Lod;
  /** Visible world rectangle. */
  view: Rect;
}

/** Status line under a device name ('' when nothing needs saying). */
export function deviceStatusText(d: { power: boolean; booted: boolean; model: string }, visual: Pick<IconDef, 'id'>): string {
  if (!d.power) return 'powered off';
  if (!d.booted) return 'starting…';
  // the generic fallback artwork says nothing about the device, so name the model
  return visual.id === 'generic' ? d.model : '';
}

// ── view ─────────────────────────────────────────────────────────────────────

class DeviceView {
  readonly root = new Container();
  readonly halo = new Graphics();
  readonly body = new Graphics();
  readonly ring = new Graphics();
  readonly far = new Graphics();
  readonly ports = new Graphics();
  readonly label: Text;
  readonly status: Text;
  readonly badge: Text;
  readonly rowLabels: Text[] = [];
  sig = '';
  bodySig = '';
  booting = false;
  stale = false;
  bounds: Rect = { minX: 0, minY: 0, maxX: 0, maxY: 0 };

  constructor(theme: ThemeColors) {
    this.label = makeText('', 12, theme.text, theme.sans, 'bold');
    this.label.anchor.set(0.5, 0);
    this.status = makeText('', 10, theme.textDim, theme.sans);
    this.status.anchor.set(0.5, 0);
    this.badge = makeText('', 9, theme.text, theme.sans, 'bold');
    this.badge.anchor.set(0.5);
    this.far.visible = false;
    this.root.addChild(this.halo, this.ring, this.far, this.body, this.badge, this.ports, this.label, this.status);
  }

  rowLabel(i: number, theme: ThemeColors): Text {
    let t = this.rowLabels[i];
    if (!t) {
      t = makeText('', 8, theme.textDim, theme.sans);
      t.anchor.set(1, 0.5);
      this.rowLabels[i] = t;
      this.root.addChild(t);
    }
    return t;
  }
}

function sameDeviceSel(sel: Selection | null, id: DeviceId): boolean {
  return sel !== null && sel.kind === 'device' && sel.id === id;
}

function selPortKey(sel: Selection | null): string | null {
  return sel !== null && sel.kind === 'port' ? portKey(sel.ref) : null;
}

/** Numeric FNV-1a style mix used for cheap redraw signatures. */
function mix(h: number, v: number): number {
  return Math.imul(h ^ (v | 0), 0x01000193) >>> 0;
}

function hashString(h: number, s: string): number {
  let x = h;
  for (let i = 0; i < s.length; i++) x = mix(x, s.charCodeAt(i));
  return x;
}

const LED_CODE: Readonly<Record<ReturnType<typeof ledState>, number>> = { up: 1, carrier: 2, down: 3, off: 4, err: 5 };
const COMPAT_CODE: Readonly<Record<PortCompat['status'], number>> = { hidden: 1, occupied: 2, source: 3, eligible: 4, compatible: 5, incompatible: 6 };

function anchorHash(list: readonly PortAnchor[], gx: number, gy: number, compat: ReadonlyMap<string, PortCompat> | null): number {
  let h = 0x811c9dc5;
  for (const a of list) {
    h = hashString(h, a.key);
    h = mix(h, LED_CODE[ledState(a.port)]);
    h = mix(h, a.port.link ? 1 : 0);
    h = mix(h, Math.round((a.x - gx) * 2));
    h = mix(h, Math.round((a.y - gy) * 2));
    if (compat) h = mix(h, COMPAT_CODE[compat.get(a.key)?.status ?? 'hidden']);
  }
  return h;
}

/** Margin (screen pixels) around the view inside which devices stay drawn. */
const CULL_MARGIN_PX = 80;

export class DeviceLayer {
  private readonly views = new Map<DeviceId, DeviceView>();
  private order: DeviceId[] = [];
  private farScale = 1;

  constructor(private readonly root: Container) {}

  sync(input: DeviceSyncInput): void {
    const { layout, theme } = input;

    for (const [id, view] of this.views) {
      if (!layout.devices.has(id)) {
        view.root.destroy({ children: true });
        this.views.delete(id);
      }
    }

    const edgeByDevice = new Map<DeviceId, PortAnchor[]>();
    const push = (map: Map<DeviceId, PortAnchor[]>, a: PortAnchor): void => {
      const list = map.get(a.ref.device);
      if (list) list.push(a);
      else map.set(a.ref.device, [a]);
    };
    for (const a of layout.edge.values()) push(edgeByDevice, a);
    const antennaByDevice = new Map<DeviceId, PortAnchor[]>();
    for (const a of layout.antenna.values()) push(antennaByDevice, a);
    const gridByDevice = new Map<DeviceId, PortAnchor[]>();
    if (input.showGrid) for (const a of layout.grid.values()) push(gridByDevice, a);

    const pendingKey = input.pendingFrom ? portKey(input.pendingFrom) : null;
    const hoverPort = selPortKey(input.hover);
    const selectedPort = selPortKey(input.selection);
    const view = inflateRect(input.view, CULL_MARGIN_PX / Math.max(input.zoom, 1e-3));
    this.farScale = 1 / Math.max(input.zoom, 1e-3);

    // paint order follows snapshot order; children are re-sorted only when that order changed
    const previous = this.order;
    this.order = [];
    let reorder = previous.length !== layout.devices.size;
    for (const geom of layout.devices.values()) {
      const id = geom.device.id;
      if (!reorder && previous[this.order.length] !== id) reorder = true;
      this.order.push(id);
      let v = this.views.get(id);
      if (!v) {
        v = new DeviceView(theme);
        this.views.set(id, v);
        this.root.addChild(v.root);
      }
      v.root.position.set(geom.x, geom.y);
      v.bounds = deviceBounds(geom, input.showGrid);
      if (!rectsIntersect(v.bounds, view)) {
        v.root.visible = false;
        v.stale = true;
        continue;
      }
      v.root.visible = true;
      v.stale = false;

      const edges = edgeByDevice.get(id) ?? [];
      const antennas = antennaByDevice.get(id) ?? [];
      const grid = gridByDevice.get(id) ?? [];
      const d = geom.device;
      const selected = sameDeviceSel(input.selection, id);
      const hovered = sameDeviceSel(input.hover, id);
      const focused = input.focus === id;
      const flags = [
        selected ? 'S' : '',
        hovered ? 'H' : '',
        focused ? 'F' : '',
        pendingKey?.startsWith(`${id}/`) ? pendingKey : '',
        hoverPort?.startsWith(`${id}/`) ? hoverPort : '',
        selectedPort?.startsWith(`${id}/`) ? selectedPort : '',
        input.target?.key.startsWith(`${id}/`) ? `${input.target.key}=${String(input.target.ok)}` : '',
      ].join('|');
      const sig = [
        d.name,
        d.model,
        geom.visual.id,
        geom.visual.badge ?? '',
        d.power,
        d.booted,
        theme.stamp,
        input.textResolution,
        input.showGrid,
        input.lod,
        flags,
        anchorHash(edges, geom.x, geom.y, null),
        anchorHash(antennas, geom.x, geom.y, null),
        input.showGrid ? anchorHash(grid, geom.x, geom.y, input.compat) : 0,
      ].join('#');
      if (input.lod === 'far') v.far.scale.set(this.farScale);
      if (sig === v.sig) continue;
      v.sig = sig;
      this.redraw(v, geom, edges, antennas, grid, input, { selected, hovered, focused, pendingKey, hoverPort, selectedPort });
    }
    if (reorder) {
      this.order.forEach((id, i) => {
        const v = this.views.get(id);
        if (v && this.root.getChildIndex(v.root) !== i) this.root.setChildIndex(v.root, i);
      });
    }
  }

  /** Re-apply culling after a camera move. Returns true when a view that missed redraws became visible. */
  cull(visible: Rect, zoom: number): boolean {
    const view = inflateRect(visible, CULL_MARGIN_PX / Math.max(zoom, 1e-3));
    let needsSync = false;
    for (const v of this.views.values()) {
      const inView = rectsIntersect(v.bounds, view);
      if (inView && v.stale) needsSync = true;
      if (!inView) v.root.visible = false;
      else if (!v.stale) v.root.visible = true;
    }
    return needsSync;
  }

  /** Keep the far-LOD locator dots at a constant screen size while zooming. */
  updateZoom(zoom: number): void {
    this.farScale = 1 / Math.max(zoom, 1e-3);
    for (const v of this.views.values()) if (v.far.visible) v.far.scale.set(this.farScale);
  }

  private redraw(
    view: DeviceView,
    geom: DeviceGeom,
    edges: PortAnchor[],
    antennas: PortAnchor[],
    grid: PortAnchor[],
    input: DeviceSyncInput,
    s: { selected: boolean; hovered: boolean; focused: boolean; pendingKey: string | null; hoverPort: string | null; selectedPort: string | null },
  ): void {
    const { theme, lod } = input;
    const d = geom.device;
    const def = geom.visual;

    const bodySig = `${def.id}|${def.badge ?? ''}#${theme.stamp}`;
    if (bodySig !== view.bodySig) {
      view.bodySig = bodySig;
      view.body.clear();
      drawIcon(view.body, def, theme.icon);
      const badge = badgeLayout(def);
      view.badge.visible = badge !== null;
      if (badge) {
        setText(view.badge, badge.text, theme.text, theme.sans, input.textResolution);
        view.badge.style.fontSize = badge.fontSize;
        view.badge.position.set(badge.cx, badge.cy);
      }
    } else if (view.badge.visible && view.badge.resolution !== input.textResolution) {
      view.badge.resolution = input.textResolution;
    }
    const off = !d.power;
    const booting = d.power && !d.booted;
    view.booting = booting;
    view.body.alpha = off ? 0.38 : booting ? 0.7 : 1;
    view.badge.alpha = view.body.alpha;
    const emphasised = s.selected || s.focused;

    // far LOD locator: a constant-size dot (ring when powered off)
    view.far.clear();
    view.far.visible = lod === 'far';
    if (lod === 'far') {
      view.far.circle(0, 0, 5);
      if (off) view.far.fill({ color: theme.bg }).stroke({ width: 2, color: theme.textDim });
      else view.far.fill({ color: theme.text }).stroke({ width: 1.5, color: theme.bg });
      view.far.scale.set(this.farScale);
    }

    // selection / hover halo around the body and label block
    view.halo.clear();
    if (s.selected || s.hovered) {
      const b = deviceBounds({ ...geom, x: 0, y: 0 }, false);
      const pad = 7;
      view.halo.roundRect(b.minX - pad, b.minY - pad, b.maxX - b.minX + pad * 2, b.maxY - b.minY + pad * 2, 8);
      if (s.selected) view.halo.fill({ color: theme.accent, alpha: 0.12 }).stroke({ width: 2, color: theme.accent });
      else view.halo.stroke({ width: 1.5, color: theme.accent, alpha: 0.5 });
    }
    if (s.focused) {
      // dashed keyboard focus ring, outside the selection halo
      const b = deviceBounds({ ...geom, x: 0, y: 0 }, false);
      const pad = 11;
      const x0 = b.minX - pad;
      const y0 = b.minY - pad;
      const x1 = b.maxX + pad;
      const y1 = b.maxY + pad;
      const dash = 6;
      const gap = 4;
      const edge = (ax: number, ay: number, bx: number, by: number): void => {
        const len = Math.hypot(bx - ax, by - ay);
        for (let t = 0; t < len; t += dash + gap) {
          const e = Math.min(len, t + dash);
          view.halo.moveTo(ax + ((bx - ax) * t) / len, ay + ((by - ay) * t) / len).lineTo(ax + ((bx - ax) * e) / len, ay + ((by - ay) * e) / len);
        }
      };
      edge(x0, y0, x1, y0);
      edge(x1, y0, x1, y1);
      edge(x1, y1, x0, y1);
      edge(x0, y1, x0, y0);
      view.halo.stroke({ width: 2, color: theme.text, cap: 'butt' });
    }

    // booting ring (animated in `animate`)
    view.ring.clear();
    if (booting) {
      view.ring.circle(0, 0, Math.max(geom.halfW, geom.halfH) + 9).stroke({ width: 2.5, color: theme.warn });
    }
    view.ring.visible = booting;

    // label + status
    setText(view.label, d.name, off ? theme.textDim : theme.text, theme.sans, input.textResolution);
    view.label.position.set(0, geom.halfH + 5);
    view.label.visible = lod !== 'far' || emphasised;
    const statusText = deviceStatusText(d, def);
    setText(view.status, statusText, booting ? theme.warn : theme.textDim, theme.sans, input.textResolution);
    view.status.position.set(0, geom.halfH + 21);
    view.status.visible = statusText !== '' && (lod === 'full' || emphasised);

    // ports
    const g = view.ports;
    g.clear();
    const ring = (a: PortAnchor, r: number, color: number, width: number): void => {
      g.circle(a.x - geom.x, a.y - geom.y, r).stroke({ width, color });
    };
    const showLeds = lod !== 'far' || emphasised;
    if (showLeds) {
      for (const a of edges) {
        drawLed(g, a.x - geom.x, a.y - geom.y, ledState(a.port), theme);
        if (a.key === s.selectedPort) ring(a, PORT_DOT_R + 3, theme.accent, 2);
        else if (a.key === s.hoverPort && !input.showGrid) ring(a, PORT_DOT_R + 2.5, theme.accent, 1.5);
      }
      for (const a of antennas) {
        // antenna mast: a short stem with the port LED on top
        const lx = a.x - geom.x;
        const ly = a.y - geom.y;
        g.moveTo(lx, ly).lineTo(lx, ly + 4).stroke({ width: 1.2, color: theme.textDim });
        drawLed(g, lx, ly - 1, ledState(a.port), theme, 2.8);
        if (a.key === s.selectedPort) ring({ ...a, y: a.y - 1 }, 6, theme.accent, 2);
        else if (a.key === s.hoverPort) ring({ ...a, y: a.y - 1 }, 5.5, theme.accent, 1.5);
      }
    }

    let labelsUsed = 0;
    if (input.showGrid && grid.length > 0) {
      for (const a of grid) {
        const lx = a.x - geom.x;
        const ly = a.y - geom.y;
        const verdict = input.compat?.get(a.key);
        const status = verdict?.status;
        if (status === 'incompatible') {
          // not usable with this media: a faint hollow dot with a slash
          g.circle(lx, ly, PORT_DOT_R - 0.6).stroke({ width: 1.2, color: theme.textFaint });
          g.moveTo(lx - PORT_DOT_R, ly + PORT_DOT_R).lineTo(lx + PORT_DOT_R, ly - PORT_DOT_R).stroke({ width: 1.2, color: theme.textFaint });
        } else {
          drawLed(g, lx, ly, ledState(a.port), theme);
        }
        if (a.port.link || status === 'occupied') {
          // occupied: a short bar under the dot (shape cue, not only colour)
          g.moveTo(lx - PORT_DOT_R, ly + PORT_DOT_R + 2).lineTo(lx + PORT_DOT_R, ly + PORT_DOT_R + 2).stroke({ width: 1.2, color: theme.textDim });
        }
        if (a.key === s.pendingKey) ring(a, PORT_DOT_R + 3.5, theme.accent, 2.2);
        else if (input.target && a.key === input.target.key) {
          const color = input.target.ok === null ? theme.textDim : input.target.ok ? theme.ok : theme.err;
          ring(a, PORT_DOT_R + 3.5, color, 2.2);
        } else if (a.key === s.hoverPort) ring(a, PORT_DOT_R + 2.5, theme.accent, 1.5);
        else if (status === 'compatible') ring(a, PORT_DOT_R + 2, theme.ok, 1);
      }
      if (lod === 'full' && geom.picker) {
        for (const row of geom.picker.rows) {
          if (row.label === '') continue;
          const t = view.rowLabel(labelsUsed, theme);
          labelsUsed += 1;
          setText(t, row.label, theme.textDim, theme.sans, input.textResolution);
          t.position.set(row.x0 - geom.x - GRID_SPACING / 2 - 2, row.y - geom.y);
          t.visible = true;
        }
      }
    }
    for (let i = labelsUsed; i < view.rowLabels.length; i++) {
      const t = view.rowLabels[i];
      if (t) t.visible = false;
    }
  }

  /** Per-frame animation (boot pulse). Returns true when something is animating. */
  animate(wallNow: number, reducedMotion: boolean): boolean {
    let active = false;
    for (const view of this.views.values()) {
      if (!view.booting || !view.root.visible) continue;
      active = true;
      if (reducedMotion) {
        view.ring.alpha = 0.8;
        view.ring.scale.set(1);
      } else {
        const phase = Math.sin(wallNow / 260);
        view.ring.alpha = 0.3 + 0.5 * (0.5 + 0.5 * phase);
        view.ring.scale.set(1 + 0.07 * phase);
      }
    }
    return active && !reducedMotion;
  }

  /**
   * Topmost device whose body/label (or port picker when `withGrid`) contains the point. `slack` (world units)
   * widens the box, so tiny far-LOD devices stay clickable.
   */
  hit(layout: Layout, wx: number, wy: number, withGrid: boolean, slack = 4): DeviceId | undefined {
    for (let i = this.order.length - 1; i >= 0; i--) {
      const id = this.order[i];
      if (id === undefined) continue;
      const g = layout.devices.get(id);
      if (!g) continue;
      const b = deviceBounds(g, withGrid);
      if (wx >= b.minX - slack && wx <= b.maxX + slack && wy >= b.minY - slack && wy <= b.maxY + slack) return id;
    }
    return undefined;
  }

  destroy(): void {
    for (const v of this.views.values()) v.root.destroy({ children: true });
    this.views.clear();
    this.order = [];
  }
}
