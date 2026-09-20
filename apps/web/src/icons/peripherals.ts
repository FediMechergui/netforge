import type { IconDef } from '../catalog/icon-types.js';

/**
 * Peripherals (palette category `peripherals`).
 * Original artwork (§1.6); see catalog/icon-types.ts for the drawing language and icons/README.md
 * for the style guide.
 */
export const ICONS_PERIPHERALS: readonly IconDef[] = [
  {
    id: 'printer',
    label: 'Network printer',
    w: 56,
    h: 48,
    shapes: [
      { kind: 'rect', x: -14, y: -23, w: 28, h: 16, r: 1, fill: 'face', stroke: 'dim', strokeWidth: 1.5, join: 'round' },
      { kind: 'path', d: 'M -8 -19 H 8 M -8 -15.5 H 3', stroke: 'accent', strokeWidth: 1.5, cap: 'round' },
      { kind: 'rect', x: -26, y: -11, w: 52, h: 22, r: 4, fill: 'face', stroke: 'line', strokeWidth: 2, join: 'round' },
      { kind: 'rect', x: 11, y: -6, w: 10, h: 4, r: 1, fill: 'face2', stroke: 'dim', strokeWidth: 1.25, join: 'round' },
      { kind: 'line', x1: -18, y1: 5, x2: 18, y2: 5, stroke: 'dim', strokeWidth: 1.5, cap: 'round' },
      { kind: 'polygon', points: [-19, 11, 19, 11, 23, 21, -23, 21], fill: 'face2', stroke: 'line', strokeWidth: 2, join: 'round' },
    ],
  },
];
