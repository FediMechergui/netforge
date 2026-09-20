/**
 * Cables: a cubic bezier between the two port edge anchors, leaving each port along its outward normal.
 *
 * Every media type has its own non-colour line style from vocab/media.ts: stroke kind (single, double for
 * fibre, thick for coax, thin for console/USB), a dash pattern, and a media badge ('ST', 'CO', 'DCE', …) drawn
 * mid-cable when zoomed in. Serial cables carry a clock glyph at the resolved DCE end. A cable in a collision
 * domain (hub or half duplex) shows two short cross ticks. A link that is down keeps its media pattern, is drawn
 * at reduced alpha and gets a crossed badge at its midpoint; carrier-up-but-line-protocol-down gets a warning
 * triangle instead. Hover and selection add a halo. Short port names are drawn next to the anchors when zoomed
 * in (level of detail). Point-to-point radio links are not cables: air.ts draws them as beams.
 *
 * Views outside the visible world rectangle are hidden and not redrawn (culling).
 */
import { Container, Graphics, type Text } from 'pixi.js';
import { portKey, type LinkId, type LinkSnapshot, type MediaType, type Selection } from '@netforge/engine';
import { MEDIA_VOCAB, type MediaStroke } from '../vocab/media';
import { isRadioLink, type Layout, type PortAnchor } from './ports';
import { inflateRect, makeText, rectsIntersect, setText, type Lod, type Rect, type ThemeColors } from './scene';

export interface Pt {
  x: number;
  y: number;
}

export interface CableGeom {
  p0: Pt;
  p1: Pt;
  p2: Pt;
  p3: Pt;
}

/** Zoom at or above which port short names are shown next to cable ends. */
export const PORT_LABEL_MIN_ZOOM = 1;
/** Zoom at or above which the media badge is drawn mid-cable. */
export const MEDIA_BADGE_MIN_ZOOM = 0.9;
/** Base stroke width of a cable (world units). */
export const CABLE_WIDTH = 2.2;

export function cableGeometry(link: LinkSnapshot, layout: Layout): CableGeom | undefined {
  const a = layout.edge.get(portKey(link.a));
  const b = layout.edge.get(portKey(link.b));
  if (!a || !b) return undefined;
  return geometryBetween(a, b);
}

export function geometryBetween(a: Pick<PortAnchor, 'x' | 'y' | 'nx' | 'ny'>, b: Pick<PortAnchor, 'x' | 'y' | 'nx' | 'ny'>): CableGeom {
  const dist = Math.hypot(b.x - a.x, b.y - a.y);
  const reach = Math.min(90, Math.max(18, dist * 0.4));
  return {
    p0: { x: a.x, y: a.y },
    p1: { x: a.x + a.nx * reach, y: a.y + a.ny * reach },
    p2: { x: b.x + b.nx * reach, y: b.y + b.ny * reach },
    p3: { x: b.x, y: b.y },
  };
}

/** A straight segment expressed as a cubic (control points on the line). */
export function straightGeometry(a: Pt, b: Pt): CableGeom {
  return {
    p0: { x: a.x, y: a.y },
    p1: { x: a.x + (b.x - a.x) / 3, y: a.y + (b.y - a.y) / 3 },
    p2: { x: a.x + ((b.x - a.x) * 2) / 3, y: a.y + ((b.y - a.y) * 2) / 3 },
    p3: { x: b.x, y: b.y },
  };
}

export function bezierAt(g: CableGeom, u: number): Pt {
  const t = Math.min(1, Math.max(0, u));
  const m = 1 - t;
  const a = m * m * m;
  const b = 3 * m * m * t;
  const c = 3 * m * t * t;
  const d = t * t * t;
  return {
    x: a * g.p0.x + b * g.p1.x + c * g.p2.x + d * g.p3.x,
    y: a * g.p0.y + b * g.p1.y + c * g.p2.y + d * g.p3.y,
  };
}

export function bezierTangent(g: CableGeom, u: number): Pt {
  const t = Math.min(1, Math.max(0, u));
  const m = 1 - t;
  const x = 3 * m * m * (g.p1.x - g.p0.x) + 6 * m * t * (g.p2.x - g.p1.x) + 3 * t * t * (g.p3.x - g.p2.x);
  const y = 3 * m * m * (g.p1.y - g.p0.y) + 6 * m * t * (g.p2.y - g.p1.y) + 3 * t * t * (g.p3.y - g.p2.y);
  const len = Math.hypot(x, y);
  return len > 1e-9 ? { x: x / len, y: y / len } : { x: 1, y: 0 };
}

/** Bounding box of a cubic (the convex hull of its control points contains the curve). */
export function geomBounds(g: CableGeom): Rect {
  return {
    minX: Math.min(g.p0.x, g.p1.x, g.p2.x, g.p3.x),
    minY: Math.min(g.p0.y, g.p1.y, g.p2.y, g.p3.y),
    maxX: Math.max(g.p0.x, g.p1.x, g.p2.x, g.p3.x),
    maxY: Math.max(g.p0.y, g.p1.y, g.p2.y, g.p3.y),
  };
}

/** Points along the curve (`samples` + 1 of them, both ends included). */
export function sampleBezier(g: CableGeom, samples: number): Pt[] {
  const out: Pt[] = [];
  for (let i = 0; i <= samples; i++) out.push(bezierAt(g, i / samples));
  return out;
}

/**
 * Split a polyline into the "on" pieces of a dash pattern (alternating dash, gap lengths in world units).
 * An empty pattern (or one without positive lengths) returns the whole polyline as one piece. The pattern
 * restarts at the first point.
 */
export function dashPolyline(points: readonly Pt[], pattern: readonly number[]): Pt[][] {
  const first = points[0];
  if (!first) return [];
  const usable = pattern.length > 0 && pattern.some((v) => v > 0) && pattern.every((v) => v >= 0);
  if (!usable) return [points.map((p) => ({ x: p.x, y: p.y }))];
  const pieces: Pt[][] = [];
  let idx = 0;
  let left = pattern[0] ?? 0;
  let on = true;
  let current: Pt[] | null = [{ x: first.x, y: first.y }];
  const advance = (): void => {
    // skip zero-length entries without looping forever (at least one entry is positive)
    do {
      idx = (idx + 1) % pattern.length;
      on = !on;
      left = pattern[idx] ?? 0;
    } while (left <= 0);
  };
  if (left <= 0) {
    current = null;
    advance();
    if (on) current = [{ x: first.x, y: first.y }];
  }
  for (let i = 1; i < points.length; i++) {
    const prev = points[i - 1];
    const next = points[i];
    if (!prev || !next) continue;
    let sx = prev.x;
    let sy = prev.y;
    let segLen = Math.hypot(next.x - sx, next.y - sy);
    while (segLen > 1e-9) {
      const step = Math.min(left, segLen);
      const f = step / segLen;
      const ex = sx + (next.x - sx) * f;
      const ey = sy + (next.y - sy) * f;
      if (on && current) current.push({ x: ex, y: ey });
      segLen -= step;
      left -= step;
      sx = ex;
      sy = ey;
      if (left <= 1e-9) {
        if (on && current && current.length > 1) pieces.push(current);
        current = null;
        advance();
        if (on) current = [{ x: sx, y: sy }];
      }
    }
  }
  if (on && current && current.length > 1) pieces.push(current);
  return pieces;
}

/** Dash multiplier so patterns stay visible when zoomed out (powers of two, 1 at LOD 'full'). */
export function dashScaleFor(zoom: number): number {
  if (zoom >= 0.6) return 1;
  return 2 ** Math.ceil(Math.log2(0.6 / Math.max(zoom, 1e-3)));
}

/** Resolved line style of a media type. */
export interface CableStyle {
  stroke: MediaStroke;
  dash: readonly number[];
  badge: string;
  color: number;
  /** Width multiplier of CABLE_WIDTH. */
  widthFactor: number;
}

export function cableStyle(media: MediaType, theme: ThemeColors): CableStyle {
  const v = MEDIA_VOCAB[media];
  const widthFactor = v.stroke === 'thick' ? 1.8 : v.stroke === 'thin' ? 0.6 : v.stroke === 'double' ? 1.9 : v.stroke === 'beam' ? 1.6 : 1;
  return { stroke: v.stroke, dash: v.dash, badge: v.badge, color: theme[v.color], widthFactor };
}

function tracePolylines(g: Graphics, pieces: readonly Pt[][]): void {
  for (const piece of pieces) {
    const p0 = piece[0];
    if (!p0) continue;
    g.moveTo(p0.x, p0.y);
    for (let i = 1; i < piece.length; i++) {
      const p = piece[i];
      if (p) g.lineTo(p.x, p.y);
    }
  }
}

const CURVE_SAMPLES = 48;

/** Stroke `geom` in `style` (solid or dashed; double strokes get a background core). */
export function strokeCable(g: Graphics, geom: CableGeom, style: CableStyle, width: number, alpha: number, dashScale: number, theme: ThemeColors): void {
  const pattern = style.dash.map((v) => v * dashScale);
  const pieces = dashPolyline(sampleBezier(geom, CURVE_SAMPLES), pattern);
  const w = width * style.widthFactor;
  tracePolylines(g, pieces);
  g.stroke({ width: w, color: style.color, alpha, cap: pattern.length > 0 ? 'butt' : 'round', join: 'round' });
  if (style.stroke === 'double') {
    tracePolylines(g, pieces);
    g.stroke({ width: Math.max(0.6, w * 0.38), color: theme.bg, alpha, cap: 'butt', join: 'round' });
  }
}

/** Draw a small clock glyph (DCE end). */
export function drawClockGlyph(g: Graphics, x: number, y: number, r: number, theme: ThemeColors, color: number): void {
  g.circle(x, y, r).fill({ color: theme.bg }).stroke({ width: 1.3, color });
  g.moveTo(x, y)
    .lineTo(x, y - r * 0.62)
    .moveTo(x, y)
    .lineTo(x + r * 0.5, y + r * 0.1)
    .stroke({ width: 1.2, color, cap: 'round' });
}

/** Crossed badge: the link is down. */
export function drawDownBadge(g: Graphics, x: number, y: number, theme: ThemeColors): void {
  g.circle(x, y, 6.5).fill({ color: theme.bg }).stroke({ width: 1.6, color: theme.err });
  g.moveTo(x - 2.8, y - 2.8).lineTo(x + 2.8, y + 2.8);
  g.moveTo(x + 2.8, y - 2.8).lineTo(x - 2.8, y + 2.8);
  g.stroke({ width: 1.6, color: theme.err, cap: 'round' });
}

/** Triangle with a bar: carrier is up but the line protocol is down. */
export function drawWarnBadge(g: Graphics, x: number, y: number, theme: ThemeColors): void {
  g.poly([x, y - 7, x + 7, y + 5, x - 7, y + 5], true).fill({ color: theme.bg }).stroke({ width: 1.6, color: theme.warn, join: 'round' });
  g.moveTo(x, y - 3).lineTo(x, y + 1).stroke({ width: 1.6, color: theme.warn, cap: 'round' });
  g.circle(x, y + 3, 0.9).fill({ color: theme.warn });
}

class CableView {
  readonly root = new Container();
  readonly g = new Graphics();
  readonly badgeBg = new Graphics();
  readonly badge: Text;
  readonly labelA: Text;
  readonly labelB: Text;
  geom: CableGeom | undefined;
  bounds: Rect | undefined;
  sig = '';
  /** Skipped by culling since its last redraw request. */
  stale = false;

  constructor(theme: ThemeColors) {
    this.labelA = makeText('', 9, theme.textDim, theme.mono);
    this.labelB = makeText('', 9, theme.textDim, theme.mono);
    this.badge = makeText('', 8, theme.text, theme.mono, 'bold');
    this.labelA.anchor.set(0.5);
    this.labelB.anchor.set(0.5);
    this.badge.anchor.set(0.5);
    this.root.addChild(this.g, this.badgeBg, this.badge, this.labelA, this.labelB);
  }
}

export interface CableSyncInput {
  layout: Layout;
  theme: ThemeColors;
  selection: Selection | null;
  hover: Selection | null;
  zoom: number;
  lod: Lod;
  /** Visible world rectangle (views outside it are hidden). */
  view: Rect;
  textResolution: number;
}

/** Margin (world units, scaled by 1/zoom) around the view inside which cables stay drawn. */
const CULL_MARGIN_PX = 120;

export class CableLayer {
  private readonly views = new Map<LinkId, CableView>();

  constructor(private readonly root: Container) {}

  sync(input: CableSyncInput): void {
    const { layout, theme } = input;
    for (const [id, view] of this.views) {
      const link = layout.links.get(id);
      if (!link || isRadioLink(link)) {
        view.root.destroy({ children: true });
        this.views.delete(id);
      }
    }
    const view = inflateRect(input.view, CULL_MARGIN_PX / Math.max(input.zoom, 1e-3));
    const showLabels = input.lod === 'full' && input.zoom >= PORT_LABEL_MIN_ZOOM;
    const showBadge = input.lod === 'full' && input.zoom >= MEDIA_BADGE_MIN_ZOOM;
    const dashScale = dashScaleFor(input.zoom);
    for (const link of layout.links.values()) {
      if (isRadioLink(link)) continue;
      let v = this.views.get(link.id);
      if (!v) {
        v = new CableView(theme);
        this.views.set(link.id, v);
        this.root.addChild(v.root);
      }
      const geom = cableGeometry(link, layout);
      v.geom = geom;
      v.bounds = geom ? inflateRect(geomBounds(geom), 12) : undefined;
      if (!v.bounds || !rectsIntersect(v.bounds, view)) {
        v.root.visible = false;
        v.stale = true;
        continue;
      }
      v.root.visible = true;
      v.stale = false;
      const selected = input.selection?.kind === 'link' && input.selection.id === link.id;
      const hovered = input.hover?.kind === 'link' && input.hover.id === link.id;
      const r = (p: Pt): string => `${Math.round(p.x * 2)},${Math.round(p.y * 2)}`;
      const sig = geom
        ? [
            r(geom.p0),
            r(geom.p1),
            r(geom.p2),
            r(geom.p3),
            link.up,
            link.carrier,
            link.resolvedMedia,
            link.resolvedDceEnd,
            link.segment,
            selected,
            hovered,
            theme.stamp,
            showLabels,
            showBadge,
            dashScale,
            input.textResolution,
          ].join('|')
        : 'none';
      if (sig === v.sig) continue;
      v.sig = sig;
      this.redraw(v, link, layout, input, { selected, hovered, showLabels, showBadge, dashScale });
    }
  }

  /** Re-apply culling after a camera move. Returns true when a view that missed redraws became visible. */
  cull(visible: Rect, zoom: number): boolean {
    const view = inflateRect(visible, CULL_MARGIN_PX / Math.max(zoom, 1e-3));
    let needsSync = false;
    for (const v of this.views.values()) {
      const inView = v.bounds !== undefined && rectsIntersect(v.bounds, view);
      if (inView && v.stale) needsSync = true;
      if (!inView) v.root.visible = false;
      else if (!v.stale) v.root.visible = true;
    }
    return needsSync;
  }

  private redraw(
    view: CableView,
    link: LinkSnapshot,
    layout: Layout,
    input: CableSyncInput,
    o: { selected: boolean; hovered: boolean; showLabels: boolean; showBadge: boolean; dashScale: number },
  ): void {
    const { theme } = input;
    const g = view.g;
    g.clear();
    view.badgeBg.clear();
    const geom = view.geom;
    view.root.visible = geom !== undefined;
    if (!geom) return;

    const style = cableStyle(link.resolvedMedia, theme);
    const width = o.selected ? CABLE_WIDTH + 1.4 : o.hovered ? CABLE_WIDTH + 0.8 : CABLE_WIDTH;
    if (o.selected || o.hovered) {
      g.moveTo(geom.p0.x, geom.p0.y).bezierCurveTo(geom.p1.x, geom.p1.y, geom.p2.x, geom.p2.y, geom.p3.x, geom.p3.y);
      g.stroke({ width: width * style.widthFactor + 8, color: theme.accent, alpha: o.selected ? 0.3 : 0.16, cap: 'round' });
    }
    strokeCable(g, geom, style, width, link.up ? 1 : 0.55, o.dashScale, theme);

    // collision domain: two short cross ticks just before the midpoint
    if (link.segment !== undefined) {
      for (const u of [0.42, 0.46]) {
        const p = bezierAt(geom, u);
        const t = bezierTangent(geom, u);
        g.moveTo(p.x - t.y * 5, p.y + t.x * 5).lineTo(p.x + t.y * 5, p.y - t.x * 5);
      }
      g.stroke({ width: 1.4, color: style.color, alpha: link.up ? 1 : 0.55, cap: 'round' });
    }

    // clock glyph at the DCE end of a serial cable
    if (link.resolvedDceEnd !== undefined) {
      const p = bezierAt(geom, link.resolvedDceEnd === 'a' ? 0.14 : 0.86);
      drawClockGlyph(g, p.x, p.y, 4.6, theme, style.color);
    }

    const mid = bezierAt(geom, 0.5);
    const tan = bezierTangent(geom, 0.5);
    if (!link.up) {
      if (link.carrier === true) drawWarnBadge(g, mid.x, mid.y, theme);
      else drawDownBadge(g, mid.x, mid.y, theme);
    }

    view.badge.visible = o.showBadge;
    if (o.showBadge) {
      setText(view.badge, style.badge, theme.text, theme.mono, input.textResolution);
      // beside the state badge when the link is down, on the cable otherwise
      const off = link.up ? 0 : 13;
      const bx = mid.x - tan.y * off;
      const by = mid.y + tan.x * off;
      const bw = view.badge.width + 7;
      const bh = 11;
      view.badgeBg
        .roundRect(bx - bw / 2, by - bh / 2, bw, bh, 5.5)
        .fill({ color: theme.panel, alpha: 0.95 })
        .stroke({ width: 1, color: style.color, alpha: 0.9 });
      view.badge.position.set(bx, by);
    }

    const place = (label: Text, key: string): void => {
      const a = layout.edge.get(key);
      label.visible = o.showLabels && a !== undefined;
      if (!a || !o.showLabels) return;
      setText(label, a.port.short, theme.textDim, theme.mono, input.textResolution);
      const off = 14;
      // offset sideways from the cable so the text does not sit on the line
      label.position.set(a.x + a.nx * off + a.ny * 8, a.y + a.ny * off + a.nx * -8);
    };
    place(view.labelA, portKey(link.a));
    place(view.labelB, portKey(link.b));
  }

  geometry(id: LinkId): CableGeom | undefined {
    return this.views.get(id)?.geom;
  }

  /** Visible link whose curve passes within `tol` world units of the point. */
  hit(wx: number, wy: number, tol: number): LinkId | undefined {
    let best: LinkId | undefined;
    let bestD = tol * tol;
    const segments = 24;
    for (const [id, view] of this.views) {
      const geom = view.geom;
      if (!geom || !view.root.visible || !view.bounds) continue;
      const b = view.bounds;
      if (wx < b.minX - tol || wx > b.maxX + tol || wy < b.minY - tol || wy > b.maxY + tol) continue;
      let prev = geom.p0;
      for (let i = 1; i <= segments; i++) {
        const next = bezierAt(geom, i / segments);
        const d = distSqToSegment(wx, wy, prev, next);
        if (d <= bestD) {
          bestD = d;
          best = id;
        }
        prev = next;
      }
    }
    return best;
  }

  destroy(): void {
    for (const v of this.views.values()) v.root.destroy({ children: true });
    this.views.clear();
  }
}

export function distSqToSegment(px: number, py: number, a: Pt, b: Pt): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = dx * dx + dy * dy;
  let t = len > 0 ? ((px - a.x) * dx + (py - a.y) * dy) / len : 0;
  t = Math.max(0, Math.min(1, t));
  const cx = a.x + dx * t;
  const cy = a.y + dy * t;
  return (px - cx) ** 2 + (py - cy) ** 2;
}
