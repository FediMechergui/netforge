import type { IconDef } from '../catalog/icon-types.js';

/**
 * Radios (palette category `radios`).
 * Accent = the radio emission (beam, arcs): dish on a mast (radio-ptp), lattice mast (cell-tower).
 * Original artwork (§1.6); see catalog/icon-types.ts for the drawing language and icons/README.md
 * for the style guide.
 */
export const ICONS_RADIOS: readonly IconDef[] = [
  {
    id: 'radio-ptp',
    label: 'Point-to-point radio',
    w: 64,
    h: 56,
    shapes: [
      // Base plate and mast.
      { kind: 'rect', x: -31, y: 22, w: 18, h: 4, r: 2, fill: 'face2', stroke: 'line', strokeWidth: 2, join: 'round' },
      { kind: 'rect', x: -24.5, y: 4, w: 5, h: 18, r: 2, fill: 'face', stroke: 'line', strokeWidth: 2, join: 'round' },
      // Dish (side view, opening to the right).
      { kind: 'path', d: 'M -16 -24 Q -31 -6 -16 12 Z', fill: 'face', stroke: 'line', strokeWidth: 2, join: 'round' },
      // Feed arm and feed.
      { kind: 'line', x1: -16, y1: -6, x2: -7, y2: -6, stroke: 'dim', strokeWidth: 1.5, cap: 'round' },
      { kind: 'circle', cx: -5, cy: -6, r: 2, fill: 'face2', stroke: 'dim', strokeWidth: 1.5 },
      // Narrow beam (accent).
      { kind: 'polygon', points: [-2, -6, 28, -11.5, 28, -0.5], fill: 'accent', fillAlpha: 0.25, stroke: 'accent', strokeWidth: 1.5, join: 'round' },
      { kind: 'arc', cx: -4, cy: -6, r: 34, start: -9, end: 9, stroke: 'accent', strokeWidth: 2, cap: 'round' },
    ],
  },

  {
    id: 'cell-tower',
    label: 'Cell tower',
    w: 56,
    h: 80,
    shapes: [
      // Lattice mast legs and base.
      { kind: 'line', x1: -14, y1: 38, x2: -4, y2: -26, stroke: 'line', strokeWidth: 2, cap: 'round' },
      { kind: 'line', x1: 14, y1: 38, x2: 4, y2: -26, stroke: 'line', strokeWidth: 2, cap: 'round' },
      { kind: 'line', x1: -20, y1: 38, x2: 20, y2: 38, stroke: 'line', strokeWidth: 2, cap: 'round' },
      // Cross bracing.
      { kind: 'polyline', points: [-13.5, 34, 11, 18, -8.5, 2, 6, -12, -4.5, -22], stroke: 'dim', strokeWidth: 1.25, join: 'round', cap: 'round' },
      { kind: 'polyline', points: [13.5, 34, -11, 18, 8.5, 2, -6, -12, 4.5, -22], stroke: 'dim', strokeWidth: 1.25, join: 'round', cap: 'round' },
      // Top spire.
      { kind: 'line', x1: 0, y1: -26, x2: 0, y2: -38, stroke: 'line', strokeWidth: 2, cap: 'round' },
      // Sector panels.
      { kind: 'rect', x: -12, y: -30, w: 5, h: 14, r: 1.5, fill: 'face', stroke: 'line', strokeWidth: 1.5, join: 'round' },
      { kind: 'rect', x: -2.5, y: -32, w: 5, h: 14, r: 1.5, fill: 'face', stroke: 'line', strokeWidth: 1.5, join: 'round' },
      { kind: 'rect', x: 7, y: -30, w: 5, h: 14, r: 1.5, fill: 'face', stroke: 'line', strokeWidth: 1.5, join: 'round' },
      // Broadcast arcs on both sides (accent).
      { kind: 'arc', cx: 0, cy: -23, r: 18, start: 150, end: 210, stroke: 'accent', strokeWidth: 2, cap: 'round' },
      { kind: 'arc', cx: 0, cy: -23, r: 25, start: 150, end: 210, stroke: 'accent', strokeWidth: 2, cap: 'round' },
      { kind: 'arc', cx: 0, cy: -23, r: 18, start: -30, end: 30, stroke: 'accent', strokeWidth: 2, cap: 'round' },
      { kind: 'arc', cx: 0, cy: -23, r: 25, start: -30, end: 30, stroke: 'accent', strokeWidth: 2, cap: 'round' },
    ],
  },
];
