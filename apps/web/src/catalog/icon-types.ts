/**
 * NetForge device icon language — ONE definition per icon, rendered by two renderers:
 *   render-svg.ts  → inline SVG markup for the palette, inspector headers, menus (DOM)
 *   render-pixi.ts → PixiJS v8 Graphics for the topology canvas
 *
 * All artwork is original (spec §1.6): no vendor diagram glyphs or product look-alikes.
 *
 * Coordinate system: icon units, CENTRED on (0, 0). An icon with `w = 88, h = 30` occupies
 * x ∈ [-44, 44], y ∈ [-15, 15]. max(w, h) ≤ ICON_UNITS_MAX. Renderers scale uniformly.
 *
 * Colours are semantic paints resolved from the active theme by each renderer, so every icon
 * works in dark and light themes:
 *   face    device body fill            (CSS --panel-2)
 *   face2   secondary body / recess     (CSS --bg-2)
 *   line    outlines and main strokes   (CSS --text)
 *   dim     details, port rows, vents   (CSS --text-dim)
 *   accent  the ONE distinguishing feature (arrows, waves, lightning) (CSS --accent)
 *   accent2 a second highlight, sparingly (CSS --purple)
 *   ok / warn / err  status-like details (CSS --ok / --warn / --err), rarely used in artwork
 *   none    no paint
 */
import type { DeviceIconId } from '@netforge/engine';

/** Largest allowed icon side (max(w, h)) in icon units. */
export const ICON_UNITS_MAX = 96;

/** Semantic paint resolved from the active theme by each renderer (see the table above). */
export type IconPaint = 'face' | 'face2' | 'line' | 'dim' | 'accent' | 'accent2' | 'ok' | 'warn' | 'err' | 'none';

/** Paint and stroke style shared by every shape kind. */
export interface IconStyle {
  /** Fill paint (ignored on `line` and `polyline`). */
  fill?: IconPaint;
  /** 0..1, default 1. */
  fillAlpha?: number;
  /** Stroke paint. */
  stroke?: IconPaint;
  /** Icon units. Style guide: 2 for outlines, 1.25–1.5 for details. */
  strokeWidth?: number;
  /** 0..1, default 1. */
  strokeAlpha?: number;
  /** Line cap, default 'round'. */
  cap?: 'butt' | 'round' | 'square';
  /** Line join, default 'round'. */
  join?: 'miter' | 'round' | 'bevel';
}

/** One drawing primitive in icon units (centred coordinate system). */
export type IconShape =
  | ({ kind: 'rect'; x: number; y: number; w: number; h: number; /** corner radius */ r?: number } & IconStyle)
  | ({ kind: 'circle'; cx: number; cy: number; r: number } & IconStyle)
  | ({ kind: 'ellipse'; cx: number; cy: number; rx: number; ry: number } & IconStyle)
  | ({ kind: 'line'; x1: number; y1: number; x2: number; y2: number } & IconStyle)
  /** Open polyline: flat [x0, y0, x1, y1, ...] with at least 2 points. */
  | ({ kind: 'polyline'; points: readonly number[] } & IconStyle)
  /** Closed polygon: flat [x0, y0, x1, y1, ...] with at least 3 points. */
  | ({ kind: 'polygon'; points: readonly number[] } & IconStyle)
  /**
   * Circular arc centred on (cx, cy), angles in DEGREES, 0° = +x (right), increasing CLOCKWISE
   * (screen coordinates, y down). Stroke-only unless `fill` is given (then it is a pie slice).
   */
  | ({ kind: 'arc'; cx: number; cy: number; r: number; start: number; end: number } & IconStyle)
  /**
   * Path in a RESTRICTED SVG path subset: commands M m L l H h V v C c Q q Z z only (no A/S/T).
   * Use `arc`, `circle` and `ellipse` shapes for curves that need arcs.
   */
  | ({ kind: 'path'; d: string } & IconStyle);

/** One icon: declarative artwork rendered identically by the SVG and PixiJS renderers. */
export interface IconDef {
  /** Registry key (DEVICE_ICONS) or 'generic' for the fallback. */
  id: DeviceIconId | 'generic';
  /** Original accessible name shown in tooltips and read by screen readers, e.g. 'Router'. */
  label: string;
  /** Bounding box in icon units (centred on 0,0). */
  w: number;
  /** Bounding box height in icon units. */
  h: number;
  /** Painter's order (first = bottom). */
  shapes: readonly IconShape[];
  /**
   * Optional short text badge (≤ 4 chars, e.g. 'L3', 'PoE', '6E', '5G'). Renderers draw it in a small
   * pill at the bottom-right corner. It gives near-identical silhouettes a non-colour distinction (§8.5).
   */
  badge?: string;
}

/** Theme-resolved colours handed to the Pixi renderer (0xRRGGBB numbers). */
export type IconPalette = Readonly<Record<Exclude<IconPaint, 'none'>, number>>;
