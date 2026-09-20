/**
 * Geometry shared by both icon renderers and the validator: the restricted path parser, arc
 * normalisation, per-shape bounds and the badge layout. Pure functions, no DOM, no PixiJS.
 */
import type { IconDef, IconPaint, IconShape } from './icon-types.js';

/** Stroke width used when a shape sets `stroke` but no `strokeWidth` (the outline weight). */
export const DEFAULT_STROKE_WIDTH = 2;

/** Semantic paint → CSS custom property of the app theme. */
export const ICON_CSS_VARS: Readonly<Record<Exclude<IconPaint, 'none'>, string>> = {
  face: '--panel-2',
  face2: '--bg-2',
  line: '--text',
  dim: '--text-dim',
  accent: '--accent',
  accent2: '--purple',
  ok: '--ok',
  warn: '--warn',
  err: '--err',
};

/** Dark-theme values of ICON_CSS_VARS (styles.css), used as fallbacks. */
export const ICON_DARK_HEX: Readonly<Record<Exclude<IconPaint, 'none'>, string>> = {
  face: '#212836',
  face2: '#161a20',
  line: '#e6e9ef',
  dim: '#8a93a5',
  accent: '#56b4e9',
  accent2: '#cc79a7',
  ok: '#009e73',
  warn: '#e69f00',
  err: '#d55e00',
};

/** Light-theme values of ICON_CSS_VARS (styles.css). */
export const ICON_LIGHT_HEX: Readonly<Record<Exclude<IconPaint, 'none'>, string>> = {
  face: '#f2f4f7',
  face2: '#f7f8fa',
  line: '#1a1f28',
  dim: '#566073',
  accent: '#0072b2',
  accent2: '#a0507f',
  ok: '#007a59',
  warn: '#a86f00',
  err: '#b04400',
};

// ---------------------------------------------------------------------------------------------
// Restricted path subset: M m L l H h V v C c Q q Z z
// ---------------------------------------------------------------------------------------------

/** Absolute, normalised path segments (H/V become L). */
export type PathSegment =
  | { cmd: 'M'; x: number; y: number }
  | { cmd: 'L'; x: number; y: number }
  | { cmd: 'C'; x1: number; y1: number; x2: number; y2: number; x: number; y: number }
  | { cmd: 'Q'; x1: number; y1: number; x: number; y: number }
  | { cmd: 'Z' };

/** A path token: a command letter or a number. */
export type PathToken = string | number;

/** Every command letter the restricted path subset accepts. */
export const ALLOWED_PATH_COMMANDS = 'MmLlHhVvCcQqZz';

const ARITY: Readonly<Record<string, number>> = { M: 2, L: 2, H: 1, V: 1, C: 6, Q: 4, Z: 0 };

/** Splits a path string into command letters and numbers. Throws on anything outside the subset. */
export function tokenizePath(d: string): PathToken[] {
  const re = /(\s+|,)|([A-Za-z])|([+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)/y;
  const out: PathToken[] = [];
  let pos = 0;
  while (pos < d.length) {
    re.lastIndex = pos;
    const m = re.exec(d);
    if (!m) throw new Error(`Invalid character '${d[pos]}' at index ${pos} in path "${d}"`);
    const [whole, sep, letter, num] = m;
    if (letter !== undefined) {
      if (!ALLOWED_PATH_COMMANDS.includes(letter)) {
        throw new Error(
          `Unsupported path command '${letter}' at index ${pos} in path "${d}" (allowed: M m L l H h V v C c Q q Z z)`,
        );
      }
      out.push(letter);
    } else if (num !== undefined) {
      out.push(Number(num));
    } else if (sep === undefined) {
      throw new Error(`Invalid character '${d[pos]}' at index ${pos} in path "${d}"`);
    }
    pos += whole.length;
  }
  return out;
}

/**
 * Parses the restricted subset into absolute segments, tracking the current point and the subpath
 * start (so relative commands after Z are relative to the subpath start, as in SVG). Implicit
 * command repetition is supported; extra pairs after M/m are treated as L/l.
 */
export function parsePath(d: string): PathSegment[] {
  const toks = tokenizePath(d);
  const out: PathSegment[] = [];
  let cx = 0;
  let cy = 0;
  let sx = 0;
  let sy = 0;
  let prev = '';
  let i = 0;
  while (i < toks.length) {
    const t = toks[i];
    let c: string;
    if (typeof t === 'string') {
      c = t;
      i++;
    } else {
      if (!prev) throw new Error(`Unexpected number ${String(t)} without a command in path "${d}"`);
      c = prev;
    }
    const upper = c.toUpperCase();
    if (out.length === 0 && upper !== 'M') {
      throw new Error(`Path "${d}" must start with M or m, found '${c}'`);
    }
    if (upper === 'Z') {
      out.push({ cmd: 'Z' });
      cx = sx;
      cy = sy;
      prev = '';
      continue;
    }
    const n = ARITY[upper] ?? 0;
    const a: number[] = [];
    for (let k = 0; k < n; k++) {
      const v = toks[i];
      if (typeof v !== 'number') throw new Error(`Path command '${c}' expects ${n} numbers in path "${d}"`);
      a.push(v);
      i++;
    }
    const rel = c !== upper;
    const ox = rel ? cx : 0;
    const oy = rel ? cy : 0;
    const at = (k: number): number => a[k] ?? 0;
    switch (upper) {
      case 'M':
        cx = ox + at(0);
        cy = oy + at(1);
        sx = cx;
        sy = cy;
        out.push({ cmd: 'M', x: cx, y: cy });
        break;
      case 'L':
        cx = ox + at(0);
        cy = oy + at(1);
        out.push({ cmd: 'L', x: cx, y: cy });
        break;
      case 'H':
        cx = ox + at(0);
        out.push({ cmd: 'L', x: cx, y: cy });
        break;
      case 'V':
        cy = oy + at(0);
        out.push({ cmd: 'L', x: cx, y: cy });
        break;
      case 'C':
        out.push({ cmd: 'C', x1: ox + at(0), y1: oy + at(1), x2: ox + at(2), y2: oy + at(3), x: ox + at(4), y: oy + at(5) });
        cx = ox + at(4);
        cy = oy + at(5);
        break;
      case 'Q':
        out.push({ cmd: 'Q', x1: ox + at(0), y1: oy + at(1), x: ox + at(2), y: oy + at(3) });
        cx = ox + at(2);
        cy = oy + at(3);
        break;
    }
    prev = upper === 'M' ? (rel ? 'l' : 'L') : c;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Arcs, bounds, badge
// ---------------------------------------------------------------------------------------------

/**
 * Normalises clockwise degrees to a sweep in [0, 360]. end - start ≥ 360 → full circle; otherwise
 * the sweep wraps clockwise (like canvas arc with anticlockwise = false), so end < start still
 * draws clockwise from start round to end.
 */
export function normalizeArc(start: number, end: number): { start: number; sweep: number } {
  const d = end - start;
  if (d >= 360) return { start, sweep: 360 };
  return { start, sweep: ((d % 360) + 360) % 360 };
}

/** Axis-aligned bounds in icon units. */
export interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** True when a paint draws something (defined and not 'none'). */
export function isPainted(p: IconPaint | undefined): p is Exclude<IconPaint, 'none'> {
  return p !== undefined && p !== 'none';
}

/** Kinds whose `fill` is ignored by both renderers (open strokes). */
export function isFillable(shape: IconShape): boolean {
  return shape.kind !== 'line' && shape.kind !== 'polyline';
}

/**
 * Bounds of a shape including half the stroke width (when stroked). Paths use control-point
 * bounds (a superset of the curve). Miter spikes on sharp polygon/path corners are not included.
 * Returns null for shapes with no geometry (zero-sweep arc, empty points). May throw for bad paths.
 */
export function shapeBounds(shape: IconShape): Bounds | null {
  const pad = isPainted(shape.stroke) ? (shape.strokeWidth ?? DEFAULT_STROKE_WIDTH) / 2 : 0;
  const b: Bounds = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  const add = (x: number, y: number): void => {
    b.minX = Math.min(b.minX, x);
    b.minY = Math.min(b.minY, y);
    b.maxX = Math.max(b.maxX, x);
    b.maxY = Math.max(b.maxY, y);
  };
  switch (shape.kind) {
    case 'rect':
      add(shape.x, shape.y);
      add(shape.x + shape.w, shape.y + shape.h);
      break;
    case 'circle':
      add(shape.cx - shape.r, shape.cy - shape.r);
      add(shape.cx + shape.r, shape.cy + shape.r);
      break;
    case 'ellipse':
      add(shape.cx - shape.rx, shape.cy - shape.ry);
      add(shape.cx + shape.rx, shape.cy + shape.ry);
      break;
    case 'line':
      add(shape.x1, shape.y1);
      add(shape.x2, shape.y2);
      break;
    case 'polyline':
    case 'polygon':
      for (let i = 0; i + 1 < shape.points.length; i += 2) add(shape.points[i] ?? 0, shape.points[i + 1] ?? 0);
      break;
    case 'arc': {
      const { start, sweep } = normalizeArc(shape.start, shape.end);
      if (sweep <= 0) return null;
      const pt = (deg: number): void => {
        const r = (deg * Math.PI) / 180;
        add(shape.cx + shape.r * Math.cos(r), shape.cy + shape.r * Math.sin(r));
      };
      pt(start);
      pt(start + sweep);
      for (let q = Math.ceil(start / 90) * 90; q < start + sweep; q += 90) pt(q);
      if (isPainted(shape.fill) && sweep < 360) add(shape.cx, shape.cy);
      break;
    }
    case 'path':
      for (const s of parsePath(shape.d)) {
        if (s.cmd === 'Z') continue;
        if (s.cmd === 'C') {
          add(s.x1, s.y1);
          add(s.x2, s.y2);
        } else if (s.cmd === 'Q') add(s.x1, s.y1);
        add(s.x, s.y);
      }
      break;
  }
  if (b.minX > b.maxX) return null;
  return { minX: b.minX - pad, minY: b.minY - pad, maxX: b.maxX + pad, maxY: b.maxY + pad };
}

/** Placement of an icon's badge pill and its text. */
export interface BadgeLayout {
  /** Top-left of the pill, icon units × scale, relative to the icon centre. */
  x: number;
  y: number;
  w: number;
  h: number;
  /** Pill centre (text anchor, centred both ways). */
  cx: number;
  cy: number;
  /** Corner radius (h / 2). */
  r: number;
  text: string;
  /** Bold, in icon units × scale. */
  fontSize: number;
}

/** Badge text size in icon units (bold). */
export const BADGE_FONT_SIZE = 9;
/** Badge pill height in icon units (clamped to the icon height). */
export const BADGE_HEIGHT = 12;
/** Approximate advance of a bold 9-unit glyph, used to size the pill without measuring text. */
export const BADGE_CHAR_ADVANCE = 5.5;

/**
 * Pill at the bottom-right corner, fully inside the w×h box (so the SVG viewBox never clips it).
 * Returns null when the icon has no badge.
 */
export function badgeLayout(def: IconDef, scale = 1): BadgeLayout | null {
  const text = def.badge ?? '';
  if (!text) return null;
  const h = Math.min(BADGE_HEIGHT, def.h);
  const w = Math.min(def.w, Math.max(h, text.length * BADGE_CHAR_ADVANCE + 6));
  const x = def.w / 2 - w;
  const y = def.h / 2 - h;
  return {
    x: x * scale,
    y: y * scale,
    w: w * scale,
    h: h * scale,
    cx: (x + w / 2) * scale,
    cy: (y + h / 2) * scale,
    r: (h / 2) * scale,
    text,
    fontSize: BADGE_FONT_SIZE * scale,
  };
}
