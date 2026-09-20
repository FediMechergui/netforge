import type { IconDef } from '../catalog/icon-types.js';

/**
 * Computers (palette category `computers`).
 * Family rules: 'face' body + 'line' outline at 2, 'dim' details at 1.5, one 'accent' feature
 * (a tinted screen for display devices, waves for the wireless desktop).
 * Original artwork (§1.6); see catalog/icon-types.ts for the drawing language and icons/README.md
 * for the style guide.
 */
export const ICONS_COMPUTERS: readonly IconDef[] = [
  {
    id: 'pc',
    label: 'Desktop computer',
    w: 48,
    h: 46,
    shapes: [
      // monitor bezel
      { kind: 'rect', x: -23, y: -22, w: 46, h: 32, r: 4, fill: 'face', stroke: 'line', strokeWidth: 2, join: 'round' },
      // screen recess + accent tint
      { kind: 'rect', x: -18.5, y: -17.5, w: 37, h: 22, r: 2, fill: 'face2' },
      { kind: 'rect', x: -18.5, y: -17.5, w: 37, h: 22, r: 2, fill: 'accent', fillAlpha: 0.22 },
      // window lines
      { kind: 'line', x1: -13.5, y1: -11, x2: 1, y2: -11, stroke: 'dim', strokeWidth: 1.5, cap: 'round' },
      { kind: 'line', x1: -13.5, y1: -5.5, x2: 7, y2: -5.5, stroke: 'dim', strokeWidth: 1.5, cap: 'round' },
      // stand neck + foot
      { kind: 'rect', x: -3.5, y: 10, w: 7, h: 6, fill: 'dim' },
      { kind: 'rect', x: -12, y: 16, w: 24, h: 5, r: 2.5, fill: 'dim' },
    ],
  },

  {
    id: 'pc-wifi',
    label: 'Wireless desktop computer',
    w: 56,
    h: 50,
    shapes: [
      // monitor bezel (shifted left to leave room for the waves)
      { kind: 'rect', x: -26, y: -14, w: 44, h: 28, r: 4, fill: 'face', stroke: 'line', strokeWidth: 2, join: 'round' },
      // screen recess (untinted: the waves are this icon's accent)
      { kind: 'rect', x: -21.5, y: -9.5, w: 35, h: 19, r: 2, fill: 'face2' },
      { kind: 'line', x1: -16.5, y1: -4, x2: -3, y2: -4, stroke: 'dim', strokeWidth: 1.5, cap: 'round' },
      { kind: 'line', x1: -16.5, y1: 1.5, x2: 3, y2: 1.5, stroke: 'dim', strokeWidth: 1.5, cap: 'round' },
      // stand neck + foot
      { kind: 'rect', x: -7.5, y: 14, w: 7, h: 5, fill: 'dim' },
      { kind: 'rect', x: -16, y: 19, w: 24, h: 4.5, r: 2, fill: 'dim' },
      // radio waves rising from the top-right corner
      { kind: 'circle', cx: 16, cy: -13, r: 2, fill: 'accent' },
      { kind: 'arc', cx: 16, cy: -13, r: 5.5, start: -90, end: 0, stroke: 'accent', strokeWidth: 1.5, cap: 'round' },
      { kind: 'arc', cx: 16, cy: -13, r: 10.5, start: -90, end: 0, stroke: 'accent', strokeWidth: 1.5, cap: 'round' },
    ],
  },

  {
    id: 'laptop',
    label: 'Laptop',
    w: 56,
    h: 40,
    shapes: [
      // lid
      { kind: 'rect', x: -20, y: -19, w: 40, h: 28, r: 3.5, fill: 'face', stroke: 'line', strokeWidth: 2, join: 'round' },
      { kind: 'rect', x: -16, y: -15, w: 32, h: 20, r: 1.5, fill: 'face2' },
      { kind: 'rect', x: -16, y: -15, w: 32, h: 20, r: 1.5, fill: 'accent', fillAlpha: 0.22 },
      // keyboard deck (flared trapezoid)
      { kind: 'polygon', points: [-23.5, 9, 23.5, 9, 26.5, 17.5, -26.5, 17.5], fill: 'face', stroke: 'line', strokeWidth: 2, join: 'round' },
      { kind: 'line', x1: -17, y1: 12, x2: 17, y2: 12, stroke: 'dim', strokeWidth: 1.5, cap: 'round' },
      { kind: 'line', x1: -5, y1: 15, x2: 5, y2: 15, stroke: 'dim', strokeWidth: 1.5, cap: 'round' },
    ],
  },
];
