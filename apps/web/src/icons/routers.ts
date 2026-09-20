import type { IconDef } from '../catalog/icon-types.js';

/**
 * Routers (palette category `routers`).
 * Family motif: two opposing curved arrows (a route cycle). Silhouettes separate the compact
 * router, the modular router with rack ears and module bays, and the tall chassis.
 * Original artwork (§1.6); see catalog/icon-types.ts for the drawing language and icons/README.md
 * for the style guide.
 */
export const ICONS_ROUTERS: readonly IconDef[] = [
  // ── router: compact body, two opposing curved arrows ──────────────────────
  {
    id: 'router',
    label: 'Router',
    w: 64,
    h: 44,
    shapes: [
      { kind: 'rect', x: -31, y: -21, w: 62, h: 42, r: 6, fill: 'face', stroke: 'line', strokeWidth: 2, join: 'round' },
      { kind: 'path', d: 'M -15 -3 Q 0 -16 13 -5', stroke: 'accent', strokeWidth: 2, cap: 'round' },
      { kind: 'polygon', points: [17.5, -1.5, 11, -2.5, 15.5, -7.5], fill: 'accent', stroke: 'accent', strokeWidth: 1.25, join: 'round' },
      { kind: 'path', d: 'M 15 3 Q 0 16 -13 5', stroke: 'accent', strokeWidth: 2, cap: 'round' },
      { kind: 'polygon', points: [-17.5, 1.5, -11, 2.5, -15.5, 7.5], fill: 'accent', stroke: 'accent', strokeWidth: 1.25, join: 'round' },
      { kind: 'rect', x: 17, y: 12.5, w: 4.5, h: 3.5, r: 1, fill: 'dim' },
      { kind: 'rect', x: 23, y: 12.5, w: 4.5, h: 3.5, r: 1, fill: 'dim' },
    ],
  },

  // ── router-modular: wider body with rack ears, arrows on top, two module bays ──
  {
    id: 'router-modular',
    label: 'Modular router',
    w: 72,
    h: 48,
    shapes: [
      { kind: 'rect', x: -35, y: -17, w: 5, h: 10, r: 1.5, fill: 'face2', stroke: 'dim', strokeWidth: 1.5 },
      { kind: 'rect', x: 30, y: -17, w: 5, h: 10, r: 1.5, fill: 'face2', stroke: 'dim', strokeWidth: 1.5 },
      { kind: 'rect', x: -32, y: -23, w: 64, h: 46, r: 5, fill: 'face', stroke: 'line', strokeWidth: 2, join: 'round' },
      { kind: 'path', d: 'M -12 -11 Q 0 -21 10 -13', stroke: 'accent', strokeWidth: 2, cap: 'round' },
      { kind: 'polygon', points: [13.5, -10, 8, -10.5, 12, -15.5], fill: 'accent', stroke: 'accent', strokeWidth: 1.25, join: 'round' },
      { kind: 'path', d: 'M 12 -7 Q 0 3 -10 -5', stroke: 'accent', strokeWidth: 2, cap: 'round' },
      { kind: 'polygon', points: [-13.5, -8, -8, -7.5, -12, -2.5], fill: 'accent', stroke: 'accent', strokeWidth: 1.25, join: 'round' },
      { kind: 'line', x1: -26, y1: 3.5, x2: 26, y2: 3.5, stroke: 'dim', strokeWidth: 1.25, cap: 'round' },
      { kind: 'rect', x: -27, y: 7.5, w: 25, h: 11, r: 2, fill: 'face2', stroke: 'dim', strokeWidth: 1.5 },
      { kind: 'rect', x: 2, y: 7.5, w: 25, h: 11, r: 2, fill: 'face2', stroke: 'dim', strokeWidth: 1.5 },
      { kind: 'line', x1: -21, y1: 13, x2: -8, y2: 13, stroke: 'dim', strokeWidth: 1.5, cap: 'round' },
      { kind: 'line', x1: 8, y1: 13, x2: 21, y2: 13, stroke: 'dim', strokeWidth: 1.5, cap: 'round' },
    ],
  },

  // ── router-chassis: tall chassis, arrows in the head, 2 x 4 module bays ──
  {
    id: 'router-chassis',
    label: 'Router chassis',
    w: 56,
    h: 80,
    shapes: [
      { kind: 'rect', x: -27, y: -39, w: 54, h: 78, r: 5, fill: 'face', stroke: 'line', strokeWidth: 2, join: 'round' },
      { kind: 'path', d: 'M -10 -30 Q 0 -38 8 -32', stroke: 'accent', strokeWidth: 2, cap: 'round' },
      { kind: 'polygon', points: [11, -29.5, 6.5, -30, 9.5, -34], fill: 'accent', stroke: 'accent', strokeWidth: 1.25, join: 'round' },
      { kind: 'path', d: 'M 10 -26 Q 0 -18 -8 -24', stroke: 'accent', strokeWidth: 2, cap: 'round' },
      { kind: 'polygon', points: [-11, -26.5, -6.5, -26, -9.5, -22], fill: 'accent', stroke: 'accent', strokeWidth: 1.25, join: 'round' },
      { kind: 'line', x1: -21, y1: -17.5, x2: 21, y2: -17.5, stroke: 'dim', strokeWidth: 1.25, cap: 'round' },
      { kind: 'rect', x: -22, y: -13, w: 20.5, h: 9, r: 1.5, fill: 'face2', stroke: 'dim', strokeWidth: 1.5 },
      { kind: 'rect', x: 1.5, y: -13, w: 20.5, h: 9, r: 1.5, fill: 'face2', stroke: 'dim', strokeWidth: 1.5 },
      { kind: 'rect', x: -22, y: -2, w: 20.5, h: 9, r: 1.5, fill: 'face2', stroke: 'dim', strokeWidth: 1.5 },
      { kind: 'rect', x: 1.5, y: -2, w: 20.5, h: 9, r: 1.5, fill: 'face2', stroke: 'dim', strokeWidth: 1.5 },
      { kind: 'rect', x: -22, y: 9, w: 20.5, h: 9, r: 1.5, fill: 'face2', stroke: 'dim', strokeWidth: 1.5 },
      { kind: 'rect', x: 1.5, y: 9, w: 20.5, h: 9, r: 1.5, fill: 'face2', stroke: 'dim', strokeWidth: 1.5 },
      { kind: 'rect', x: -22, y: 20, w: 20.5, h: 9, r: 1.5, fill: 'face2', stroke: 'dim', strokeWidth: 1.5 },
      { kind: 'rect', x: 1.5, y: 20, w: 20.5, h: 9, r: 1.5, fill: 'face2', stroke: 'dim', strokeWidth: 1.5 },
      { kind: 'line', x1: -14, y1: 34, x2: 14, y2: 34, stroke: 'dim', strokeWidth: 1.5, cap: 'round' },
    ],
  },
];
