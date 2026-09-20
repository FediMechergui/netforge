/**
 * Icon validator: bounds (stroke included), shape counts, badge length, labels and the restricted
 * path subset. Used by the tests over every registered icon.
 */
import { ICON_UNITS_MAX, type IconDef, type IconShape } from './icon-types.js';
import { isFillable, isPainted, parsePath, shapeBounds } from './shared.js';

/** Hard cap on shapes per icon (legibility at 24 px). */
export const ICON_MAX_SHAPES = 30;
/** Longest allowed badge text. */
export const ICON_MAX_BADGE_CHARS = 4;

const EPS = 1e-6;

const r2 = (n: number): string => String(Math.round(n * 100) / 100);

/** Structural problems of one shape, before any bounds computation. */
function shapeProblems(s: IconShape, where: string): string[] {
  const p: string[] = [];
  for (const [key, value] of Object.entries(s)) {
    if (typeof value === 'number' && !Number.isFinite(value)) p.push(`${where}: ${key} is not a finite number`);
  }
  if (s.kind === 'polyline' || s.kind === 'polygon') {
    s.points.forEach((v, i) => {
      if (!Number.isFinite(v)) p.push(`${where}: points[${i}] is not a finite number`);
    });
    if (s.points.length % 2 !== 0) p.push(`${where}: points has odd length ${s.points.length}`);
    const min = s.kind === 'polyline' ? 2 : 3;
    if (Math.floor(s.points.length / 2) < min) p.push(`${where}: needs at least ${min} points`);
  }
  if (s.strokeWidth !== undefined && !(s.strokeWidth > 0)) p.push(`${where}: strokeWidth must be > 0`);
  for (const key of ['fillAlpha', 'strokeAlpha'] as const) {
    const a = s[key];
    if (a !== undefined && !(a >= 0 && a <= 1)) p.push(`${where}: ${key} must be within 0..1`);
  }
  const fills = isFillable(s) && isPainted(s.fill);
  if (!isFillable(s) && isPainted(s.fill)) p.push(`${where}: fill is ignored on ${s.kind} (stroke only)`);
  if (!fills && !isPainted(s.stroke)) p.push(`${where}: paints nothing (no fill and no stroke)`);
  switch (s.kind) {
    case 'rect':
      if (!(s.w > 0 && s.h > 0)) p.push(`${where}: w and h must be > 0`);
      if (s.r !== undefined && !(s.r >= 0 && s.r <= Math.min(s.w, s.h) / 2)) p.push(`${where}: r must be within 0..min(w, h)/2`);
      break;
    case 'circle':
    case 'arc':
      if (!(s.r > 0)) p.push(`${where}: r must be > 0`);
      break;
    case 'ellipse':
      if (!(s.rx > 0 && s.ry > 0)) p.push(`${where}: rx and ry must be > 0`);
      break;
    case 'path':
      try {
        parsePath(s.d);
      } catch (e) {
        p.push(`${where}: ${e instanceof Error ? e.message : String(e)}`);
      }
      break;
    default:
      break;
  }
  return p;
}

/** Returns human-readable problems; an empty array means the icon is valid. */
export function validateIcon(def: IconDef): string[] {
  const problems: string[] = [];
  if (typeof def.label !== 'string' || def.label.trim() === '') problems.push('label is empty');
  for (const key of ['w', 'h'] as const) {
    const v = def[key];
    if (!(Number.isFinite(v) && v > 0 && v <= ICON_UNITS_MAX)) problems.push(`${key} = ${v} must be within (0, ${ICON_UNITS_MAX}]`);
  }
  if (def.shapes.length === 0) problems.push('icon has no shapes');
  if (def.shapes.length > ICON_MAX_SHAPES) problems.push(`too many shapes: ${def.shapes.length} > ${ICON_MAX_SHAPES}`);
  if (def.badge !== undefined && (def.badge.length === 0 || def.badge.length > ICON_MAX_BADGE_CHARS)) {
    problems.push(`badge "${def.badge}" must be 1..${ICON_MAX_BADGE_CHARS} characters`);
  }

  const boxOk = problems.every((m) => !m.startsWith('w =') && !m.startsWith('h ='));
  const hw = def.w / 2;
  const hh = def.h / 2;
  def.shapes.forEach((s, i) => {
    const where = `shape[${i}] (${s.kind})`;
    const own = shapeProblems(s, where);
    problems.push(...own);
    if (own.some((m) => !m.includes('paints nothing') && !m.includes('fill is ignored')) || !boxOk) return;
    const b = shapeBounds(s);
    if (!b) return;
    if (b.minX < -hw - EPS || b.maxX > hw + EPS || b.minY < -hh - EPS || b.maxY > hh + EPS) {
      problems.push(
        `${where}: extends outside the ${def.w}x${def.h} box ` +
          `(x ${r2(b.minX)}..${r2(b.maxX)} vs ±${r2(hw)}, y ${r2(b.minY)}..${r2(b.maxY)} vs ±${r2(hh)}, stroke included)`,
      );
    }
  });
  return problems;
}
