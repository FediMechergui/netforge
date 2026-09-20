import type { IconDef } from '../catalog/icon-types.js';

/**
 * Voice end devices (palette category `voice`).
 * Original artwork (§1.6); see catalog/icon-types.ts for the drawing language and icons/README.md
 * for the style guide.
 */
export const ICONS_VOICE: readonly IconDef[] = [
  {
    id: 'ip-phone',
    label: 'IP desk phone',
    w: 56,
    h: 44,
    shapes: [
      { kind: 'polygon', points: [-26, 20, 26, 20, 22, -6, -22, -6], fill: 'face', stroke: 'line', strokeWidth: 2, join: 'round' },
      { kind: 'rect', x: -24, y: -19, w: 30, h: 7, r: 3.5, fill: 'face', stroke: 'line', strokeWidth: 2, join: 'round' },
      { kind: 'rect', x: 3, y: -2, w: 16, h: 8, r: 1.5, fill: 'face2', stroke: 'dim', strokeWidth: 1.25, join: 'round' },
      { kind: 'circle', cx: -18, cy: 1, r: 1.5, fill: 'dim' },
      { kind: 'circle', cx: -12, cy: 1, r: 1.5, fill: 'dim' },
      { kind: 'circle', cx: -6, cy: 1, r: 1.5, fill: 'dim' },
      { kind: 'circle', cx: -18, cy: 7, r: 1.5, fill: 'dim' },
      { kind: 'circle', cx: -12, cy: 7, r: 1.5, fill: 'dim' },
      { kind: 'circle', cx: -6, cy: 7, r: 1.5, fill: 'dim' },
      { kind: 'circle', cx: -18, cy: 13, r: 1.5, fill: 'dim' },
      { kind: 'circle', cx: -12, cy: 13, r: 1.5, fill: 'dim' },
      { kind: 'circle', cx: -6, cy: 13, r: 1.5, fill: 'dim' },
      { kind: 'line', x1: 4, y1: 13, x2: 18, y2: 13, stroke: 'dim', strokeWidth: 1.5, cap: 'round' },
      { kind: 'arc', cx: 10, cy: -15, r: 6, start: -35, end: 35, stroke: 'accent', strokeWidth: 1.5, cap: 'round' },
      { kind: 'arc', cx: 10, cy: -15, r: 10, start: -35, end: 35, stroke: 'accent', strokeWidth: 1.5, cap: 'round' },
    ],
  },
];
