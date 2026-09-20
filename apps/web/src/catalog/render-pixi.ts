/**
 * IconDef → PixiJS v8 Graphics (topology canvas). Graphics only: the badge text is placed by the
 * caller as a Text using badgeLayout(); this module draws just the pill background.
 */
import type { Graphics } from 'pixi.js';
import type { IconDef, IconPalette, IconShape } from './icon-types.js';
import {
  DEFAULT_STROKE_WIDTH,
  ICON_CSS_VARS,
  ICON_DARK_HEX,
  badgeLayout,
  isFillable,
  isPainted,
  normalizeArc,
  parsePath,
} from './shared.js';

export { badgeLayout, parsePath, tokenizePath } from './shared.js';
export type { BadgeLayout, PathSegment } from './shared.js';

const DEG = Math.PI / 180;

/** Adds the shape's geometry to the active path. Returns false when there is nothing to draw. */
function traceShape(g: Graphics, shape: IconShape, k: number): boolean {
  switch (shape.kind) {
    case 'rect':
      if (shape.r !== undefined && shape.r > 0) g.roundRect(shape.x * k, shape.y * k, shape.w * k, shape.h * k, shape.r * k);
      else g.rect(shape.x * k, shape.y * k, shape.w * k, shape.h * k);
      return true;
    case 'circle':
      g.circle(shape.cx * k, shape.cy * k, shape.r * k);
      return true;
    case 'ellipse':
      g.ellipse(shape.cx * k, shape.cy * k, shape.rx * k, shape.ry * k);
      return true;
    case 'line':
      g.moveTo(shape.x1 * k, shape.y1 * k);
      g.lineTo(shape.x2 * k, shape.y2 * k);
      return true;
    case 'polyline': {
      const p = shape.points;
      if (p.length < 4) return false;
      g.moveTo((p[0] ?? 0) * k, (p[1] ?? 0) * k);
      for (let i = 2; i + 1 < p.length; i += 2) g.lineTo((p[i] ?? 0) * k, (p[i + 1] ?? 0) * k);
      return true;
    }
    case 'polygon': {
      if (shape.points.length < 6) return false;
      const pts: number[] = [];
      for (let i = 0; i + 1 < shape.points.length; i += 2) pts.push((shape.points[i] ?? 0) * k, (shape.points[i + 1] ?? 0) * k);
      g.poly(pts, true);
      return true;
    }
    case 'arc': {
      const { start, sweep } = normalizeArc(shape.start, shape.end);
      if (sweep <= 0 || shape.r <= 0) return false;
      const cx = shape.cx * k;
      const cy = shape.cy * k;
      const r = shape.r * k;
      if (sweep >= 360) {
        g.circle(cx, cy, r);
        return true;
      }
      const a0 = start * DEG;
      const a1 = (start + sweep) * DEG;
      const sx = cx + r * Math.cos(a0);
      const sy = cy + r * Math.sin(a0);
      if (isPainted(shape.fill)) {
        g.moveTo(cx, cy);
        g.lineTo(sx, sy);
        g.arc(cx, cy, r, a0, a1, false);
        g.closePath();
      } else {
        g.moveTo(sx, sy);
        g.arc(cx, cy, r, a0, a1, false);
      }
      return true;
    }
    case 'path': {
      const segs = parsePath(shape.d); // throws a descriptive Error on unsupported commands
      for (const s of segs) {
        switch (s.cmd) {
          case 'M':
            g.moveTo(s.x * k, s.y * k);
            break;
          case 'L':
            g.lineTo(s.x * k, s.y * k);
            break;
          case 'C':
            g.bezierCurveTo(s.x1 * k, s.y1 * k, s.x2 * k, s.y2 * k, s.x * k, s.y * k);
            break;
          case 'Q':
            g.quadraticCurveTo(s.x1 * k, s.y1 * k, s.x * k, s.y * k);
            break;
          case 'Z':
            g.closePath();
            break;
        }
      }
      return segs.length > 0;
    }
  }
}

/**
 * Draws `def` centred on (0, 0) into `g` (appends; the caller clears). `scale` multiplies
 * coordinates, radii and stroke widths. Throws for paths outside the restricted subset.
 */
export function drawIcon(g: Graphics, def: IconDef, palette: IconPalette, scale = 1): void {
  const k = scale;
  for (const shape of def.shapes) {
    // v8 keeps the active path after fill()/stroke() (as a moveTo) and reuses the last
    // instruction's path when nothing was traced in between, so start every shape afresh.
    g.beginPath();
    if (!traceShape(g, shape, k)) continue;
    if (isFillable(shape) && isPainted(shape.fill)) {
      g.fill({ color: palette[shape.fill], alpha: shape.fillAlpha ?? 1 });
    }
    if (isPainted(shape.stroke)) {
      g.stroke({
        width: (shape.strokeWidth ?? DEFAULT_STROKE_WIDTH) * k,
        color: palette[shape.stroke],
        alpha: shape.strokeAlpha ?? 1,
        cap: shape.cap ?? 'round',
        join: shape.join ?? 'round',
      });
    }
  }
  const badge = badgeLayout(def, k);
  if (badge) {
    g.beginPath();
    g.roundRect(badge.x + 0.5 * k, badge.y + 0.5 * k, badge.w - k, badge.h - k, badge.r - 0.5 * k);
    g.fill({ color: palette.face2, alpha: 1 });
    g.stroke({ width: k, color: palette.dim, alpha: 1 });
  }
}

/** Parses #rgb, #rgba, #rrggbb, #rrggbbaa, rgb()/rgba() (comma or space syntax) → 0xRRGGBB. */
export function parseIconColor(value: string | null | undefined, fallback: number): number {
  const v = (value ?? '').trim();
  if (v.startsWith('#')) {
    const hex = v.slice(1);
    if (/^[0-9a-f]{3,4}$/i.test(hex)) {
      const r = hex[0] ?? '0';
      const g = hex[1] ?? '0';
      const b = hex[2] ?? '0';
      return parseInt(r + r + g + g + b + b, 16);
    }
    if (/^[0-9a-f]{6}([0-9a-f]{2})?$/i.test(hex)) return parseInt(hex.slice(0, 6), 16);
    return fallback;
  }
  const m = /^rgba?\(\s*([\d.]+)(%?)[\s,]+([\d.]+)(%?)[\s,]+([\d.]+)(%?)/i.exec(v);
  if (m) {
    const ch = (num: string | undefined, pct: string | undefined): number => {
      const raw = Number(num ?? 0);
      const n = pct ? (raw / 100) * 255 : raw;
      return Number.isFinite(n) ? Math.max(0, Math.min(255, Math.round(n))) : 0;
    };
    return (ch(m[1], m[2]) << 16) | (ch(m[3], m[4]) << 8) | ch(m[5], m[6]);
  }
  return fallback;
}

/**
 * Builds a palette from theme CSS variables. `get` receives the variable name including the
 * leading dashes (e.g. '--panel-2'), typically `(n) => getComputedStyle(root).getPropertyValue(n)`.
 * Unparseable or empty values fall back to the dark theme.
 */
export function paletteFromCss(get: (name: string) => string): IconPalette {
  const read = (p: keyof IconPalette): number => {
    const fb = parseInt(ICON_DARK_HEX[p].slice(1), 16);
    let raw = '';
    try {
      raw = get(ICON_CSS_VARS[p]);
    } catch {
      raw = '';
    }
    return parseIconColor(raw, fb);
  };
  return {
    face: read('face'),
    face2: read('face2'),
    line: read('line'),
    dim: read('dim'),
    accent: read('accent'),
    accent2: read('accent2'),
    ok: read('ok'),
    warn: read('warn'),
    err: read('err'),
  };
}
