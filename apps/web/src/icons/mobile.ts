import type { IconDef } from '../catalog/icon-types.js';

/**
 * Mobile end devices (palette category `mobile`).
 * Family rules as for computers; the accent is the tinted screen.
 * Original artwork (§1.6); see catalog/icon-types.ts for the drawing language and icons/README.md
 * for the style guide.
 */
export const ICONS_MOBILE: readonly IconDef[] = [
  {
    id: 'smartphone',
    label: 'Smartphone',
    w: 30,
    h: 50,
    shapes: [
      { kind: 'rect', x: -14, y: -24, w: 28, h: 48, r: 5, fill: 'face', stroke: 'line', strokeWidth: 2, join: 'round' },
      { kind: 'rect', x: -10.5, y: -18, w: 21, h: 34, r: 1.5, fill: 'face2' },
      { kind: 'rect', x: -10.5, y: -18, w: 21, h: 34, r: 1.5, fill: 'accent', fillAlpha: 0.22 },
      // earpiece + home bar
      { kind: 'line', x1: -3, y1: -21, x2: 3, y2: -21, stroke: 'dim', strokeWidth: 1.5, cap: 'round' },
      { kind: 'line', x1: -4.5, y1: 20, x2: 4.5, y2: 20, stroke: 'dim', strokeWidth: 1.5, cap: 'round' },
    ],
  },

  {
    id: 'tablet',
    label: 'Tablet',
    w: 52,
    h: 40,
    shapes: [
      // landscape slate
      { kind: 'rect', x: -25, y: -19, w: 50, h: 38, r: 5, fill: 'face', stroke: 'line', strokeWidth: 2, join: 'round' },
      { kind: 'rect', x: -19, y: -14, w: 38, h: 28, r: 1.5, fill: 'face2' },
      { kind: 'rect', x: -19, y: -14, w: 38, h: 28, r: 1.5, fill: 'accent', fillAlpha: 0.22 },
      // camera dot + side home bar
      { kind: 'circle', cx: -22, cy: 0, r: 1, fill: 'dim' },
      { kind: 'line', x1: 22, y1: -3.5, x2: 22, y2: 3.5, stroke: 'dim', strokeWidth: 1.5, cap: 'round' },
    ],
  },
];
