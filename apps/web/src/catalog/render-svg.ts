/**
 * IconDef → inline SVG markup (palette, inspector headers, menus). Colours are CSS custom
 * properties so the markup follows the active theme without re-rendering.
 */
import type { IconDef, IconPaint, IconShape } from './icon-types.js';
import {
  DEFAULT_STROKE_WIDTH,
  ICON_CSS_VARS,
  ICON_DARK_HEX,
  ICON_LIGHT_HEX,
  badgeLayout,
  isFillable,
  isPainted,
  normalizeArc,
} from './shared.js';

/** Options for `iconToSvg`. */
export interface IconSvgOptions {
  /** Rendered HEIGHT in CSS px; width follows the icon aspect ratio. Default 24. */
  size?: number;
  /** Accessible name. When given: role="img" + <title>; otherwise aria-hidden="true". */
  title?: string;
  /** CSS class on the <svg> element (escaped). */
  className?: string;
}

/** Options for `iconToDataUri`. */
export interface IconDataUriOptions extends IconSvgOptions {
  /**
   * A data URI rendered through <img> cannot see page CSS variables, so each var() carries a
   * fallback colour from this theme. Default 'dark'.
   */
  theme?: 'dark' | 'light';
}

type PaintRef = (p: Exclude<IconPaint, 'none'>) => string;

/** Escapes text for XML content and double- or single-quoted attributes. */
export function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Deterministic compact number: ≤ 3 decimals, no "-0", no exponent for icon-range values. */
export function fmt(n: number): string {
  if (!Number.isFinite(n)) return '0';
  const v = Math.round(n * 1000) / 1000;
  return Object.is(v, -0) || v === 0 ? '0' : String(v);
}

function attrs(list: ReadonlyArray<readonly [string, string | number | undefined]>): string {
  let out = '';
  for (const [name, value] of list) {
    if (value === undefined) continue;
    out += ` ${name}="${escapeXml(typeof value === 'number' ? fmt(value) : value)}"`;
  }
  return out;
}

function paintAttrs(shape: IconShape, ref: PaintRef): Array<readonly [string, string | number | undefined]> {
  const list: Array<readonly [string, string | number | undefined]> = [];
  if (isFillable(shape) && isPainted(shape.fill)) {
    list.push(['fill', ref(shape.fill)]);
    if (shape.fillAlpha !== undefined && shape.fillAlpha !== 1) list.push(['fill-opacity', shape.fillAlpha]);
  } else {
    list.push(['fill', 'none']);
  }
  if (isPainted(shape.stroke)) {
    list.push(['stroke', ref(shape.stroke)]);
    list.push(['stroke-width', shape.strokeWidth ?? DEFAULT_STROKE_WIDTH]);
    list.push(['stroke-linecap', shape.cap ?? 'round']);
    list.push(['stroke-linejoin', shape.join ?? 'round']);
    if (shape.strokeAlpha !== undefined && shape.strokeAlpha !== 1) list.push(['stroke-opacity', shape.strokeAlpha]);
  }
  return list;
}

/** SVG path data for a clockwise-degree arc; a pie slice when `pie`. Null for a zero sweep. */
export function arcToPathD(cx: number, cy: number, r: number, start: number, end: number, pie: boolean): string | null {
  const { sweep } = normalizeArc(start, end);
  if (sweep <= 0 || r <= 0) return null;
  const pt = (deg: number): string => {
    const a = (deg * Math.PI) / 180;
    return `${fmt(cx + r * Math.cos(a))} ${fmt(cy + r * Math.sin(a))}`;
  };
  const rr = `${fmt(r)} ${fmt(r)}`;
  if (sweep >= 360) {
    // Two half-circles: a single SVG arc cannot start and end at the same point.
    return `M${pt(start)}A${rr} 0 1 1 ${pt(start + 180)}A${rr} 0 1 1 ${pt(start)}Z`;
  }
  // y grows downwards, so a clockwise (increasing-angle) sweep is sweep-flag 1.
  const arc = `A${rr} 0 ${sweep > 180 ? 1 : 0} 1 ${pt(start + sweep)}`;
  return pie ? `M${fmt(cx)} ${fmt(cy)}L${pt(start)}${arc}Z` : `M${pt(start)}${arc}`;
}

function shapeToSvg(shape: IconShape, ref: PaintRef): string {
  const paint = paintAttrs(shape, ref);
  switch (shape.kind) {
    case 'rect':
      return `<rect${attrs([
        ['x', shape.x],
        ['y', shape.y],
        ['width', shape.w],
        ['height', shape.h],
        ['rx', shape.r !== undefined && shape.r > 0 ? shape.r : undefined],
        ...paint,
      ])}/>`;
    case 'circle':
      return `<circle${attrs([['cx', shape.cx], ['cy', shape.cy], ['r', shape.r], ...paint])}/>`;
    case 'ellipse':
      return `<ellipse${attrs([['cx', shape.cx], ['cy', shape.cy], ['rx', shape.rx], ['ry', shape.ry], ...paint])}/>`;
    case 'line':
      return `<line${attrs([['x1', shape.x1], ['y1', shape.y1], ['x2', shape.x2], ['y2', shape.y2], ...paint])}/>`;
    case 'polyline':
    case 'polygon': {
      const pts: string[] = [];
      for (let i = 0; i + 1 < shape.points.length; i += 2) {
        pts.push(`${fmt(shape.points[i] ?? 0)},${fmt(shape.points[i + 1] ?? 0)}`);
      }
      return `<${shape.kind}${attrs([['points', pts.join(' ')], ...paint])}/>`;
    }
    case 'arc': {
      const d = arcToPathD(shape.cx, shape.cy, shape.r, shape.start, shape.end, isPainted(shape.fill));
      return d ? `<path${attrs([['d', d], ...paint])}/>` : '';
    }
    case 'path':
      return `<path${attrs([['d', shape.d.trim()], ...paint])}/>`;
  }
}

function renderSvg(def: IconDef, opts: IconSvgOptions, ref: PaintRef): string {
  const height = opts.size ?? 24;
  const width = (height * def.w) / def.h;
  const head: Array<readonly [string, string | number | undefined]> = [
    ['xmlns', 'http://www.w3.org/2000/svg'],
    ['viewBox', `${fmt(-def.w / 2)} ${fmt(-def.h / 2)} ${fmt(def.w)} ${fmt(def.h)}`],
    ['width', width],
    ['height', height],
    ['class', opts.className],
    ['focusable', 'false'],
  ];
  const hasTitle = opts.title !== undefined && opts.title !== '';
  if (hasTitle) head.push(['role', 'img']);
  else head.push(['aria-hidden', 'true']);

  let body = hasTitle ? `<title>${escapeXml(opts.title ?? '')}</title>` : '';
  for (const shape of def.shapes) body += shapeToSvg(shape, ref);

  const badge = badgeLayout(def);
  if (badge) {
    // Inset by half the 1-unit border so the stroke stays inside the viewBox.
    body +=
      `<g class="nf-icon-badge">` +
      `<rect${attrs([
        ['x', badge.x + 0.5],
        ['y', badge.y + 0.5],
        ['width', badge.w - 1],
        ['height', badge.h - 1],
        ['rx', badge.r - 0.5],
        ['fill', ref('face2')],
        ['stroke', ref('dim')],
        ['stroke-width', 1],
      ])}/>` +
      `<text${attrs([
        ['x', badge.cx],
        ['y', badge.cy],
        ['fill', ref('line')],
        ['text-anchor', 'middle'],
        ['dominant-baseline', 'central'],
        ['style', `font-family:var(--sans, system-ui, sans-serif);font-size:${fmt(badge.fontSize)}px;font-weight:700`],
      ])}>${escapeXml(badge.text)}</text>` +
      `</g>`;
  }
  return `<svg${attrs(head)}>${body}</svg>`;
}

/** Complete <svg> element string for an icon, painted with theme CSS variables. Deterministic. */
export function iconToSvg(def: IconDef, opts: IconSvgOptions = {}): string {
  return renderSvg(def, opts, (p) => `var(${ICON_CSS_VARS[p]})`);
}

/** `data:image/svg+xml,…` URI; var() references carry theme fallbacks so <img> renders in colour. */
export function iconToDataUri(def: IconDef, opts: IconDataUriOptions = {}): string {
  const hex = opts.theme === 'light' ? ICON_LIGHT_HEX : ICON_DARK_HEX;
  const svg = renderSvg(def, opts, (p) => `var(${ICON_CSS_VARS[p]}, ${hex[p]})`);
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}
