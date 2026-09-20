import type { IconDef } from '../catalog/icon-types.js';

/**
 * Wireless infrastructure (palette category `wireless`).
 * Accent = the radio emission. Silhouettes separate the look-alikes: ceiling pill (ap),
 * pole-mounted enclosure (ap-outdoor), 1U chassis (wlc).
 * Original artwork (§1.6); see catalog/icon-types.ts for the drawing language and icons/README.md
 * for the style guide.
 */
export const ICONS_WIRELESS: readonly IconDef[] = [
  {
    id: 'ap',
    label: 'Access point',
    w: 56,
    h: 44,
    shapes: [
      // Ceiling unit, side view: flat pill.
      { kind: 'rect', x: -24, y: 4, w: 48, h: 16, r: 8, fill: 'face', stroke: 'line', strokeWidth: 2, join: 'round' },
      { kind: 'line', x1: -15, y1: 12, x2: -5, y2: 12, stroke: 'dim', strokeWidth: 1.5, cap: 'round' },
      { kind: 'circle', cx: 5, cy: 12, r: 1.5, fill: 'dim' },
      // Radiating arcs (accent).
      { kind: 'arc', cx: 0, cy: 3, r: 8, start: 225, end: 315, stroke: 'accent', strokeWidth: 2, cap: 'round' },
      { kind: 'arc', cx: 0, cy: 3, r: 15, start: 225, end: 315, stroke: 'accent', strokeWidth: 2, cap: 'round' },
      { kind: 'arc', cx: 0, cy: 3, r: 22, start: 225, end: 315, stroke: 'accent', strokeWidth: 2, cap: 'round' },
    ],
  },

  {
    id: 'ap-outdoor',
    label: 'Outdoor access point',
    w: 48,
    h: 60,
    shapes: [
      // Mounting pole.
      { kind: 'rect', x: -22, y: -29, w: 5, h: 58, r: 2, fill: 'face2', stroke: 'line', strokeWidth: 2, join: 'round' },
      // Clamps.
      { kind: 'line', x1: -17, y1: -1, x2: -12, y2: -1, stroke: 'dim', strokeWidth: 1.5, cap: 'round' },
      { kind: 'line', x1: -17, y1: 20, x2: -12, y2: 20, stroke: 'dim', strokeWidth: 1.5, cap: 'round' },
      // External antennas.
      { kind: 'rect', x: -6.5, y: -28, w: 5, h: 20, r: 2.5, fill: 'face', stroke: 'line', strokeWidth: 1.5, join: 'round' },
      { kind: 'rect', x: 5.5, y: -28, w: 5, h: 20, r: 2.5, fill: 'face', stroke: 'line', strokeWidth: 1.5, join: 'round' },
      // Weatherproof enclosure with drip hood.
      { kind: 'rect', x: -12, y: -8, w: 26, h: 34, r: 4, fill: 'face', stroke: 'line', strokeWidth: 2, join: 'round' },
      { kind: 'line', x1: -15, y1: -10, x2: 17, y2: -10, stroke: 'line', strokeWidth: 2, cap: 'round' },
      // Fins.
      { kind: 'line', x1: -6, y1: 4, x2: 8, y2: 4, stroke: 'dim', strokeWidth: 1.5, cap: 'round' },
      { kind: 'line', x1: -6, y1: 9, x2: 8, y2: 9, stroke: 'dim', strokeWidth: 1.5, cap: 'round' },
      { kind: 'line', x1: -6, y1: 14, x2: 8, y2: 14, stroke: 'dim', strokeWidth: 1.5, cap: 'round' },
      { kind: 'circle', cx: 1, cy: 20.5, r: 1.5, fill: 'dim' },
      // Side-facing waves (accent).
      { kind: 'arc', cx: 14, cy: -20, r: 5, start: -55, end: 55, stroke: 'accent', strokeWidth: 2, cap: 'round' },
      { kind: 'arc', cx: 14, cy: -20, r: 9, start: -55, end: 55, stroke: 'accent', strokeWidth: 2, cap: 'round' },
    ],
  },

  {
    id: 'wlc',
    label: 'Wireless controller',
    w: 88,
    h: 30,
    shapes: [
      // 1U chassis.
      { kind: 'rect', x: -43, y: -14, w: 86, h: 28, r: 5, fill: 'face', stroke: 'line', strokeWidth: 2, join: 'round' },
      // Recessed panel holding the wave motif.
      { kind: 'rect', x: -38, y: -9, w: 30, h: 18, r: 3, fill: 'face2', stroke: 'dim', strokeWidth: 1.25, join: 'round' },
      { kind: 'circle', cx: -23, cy: 5, r: 2, fill: 'accent' },
      { kind: 'arc', cx: -23, cy: 5, r: 5.5, start: 220, end: 320, stroke: 'accent', strokeWidth: 2, cap: 'round' },
      { kind: 'arc', cx: -23, cy: 5, r: 10, start: 225, end: 315, stroke: 'accent', strokeWidth: 2, cap: 'round' },
      // Managed-AP list: three short rows, each with a status dot.
      { kind: 'path', d: 'M 4 -6.5 H 26 M 4 0 H 26 M 4 6.5 H 26', stroke: 'dim', strokeWidth: 1.5, cap: 'round' },
      { kind: 'circle', cx: -1, cy: -6.5, r: 1.5, fill: 'dim' },
      { kind: 'circle', cx: -1, cy: 0, r: 1.5, fill: 'dim' },
      { kind: 'circle', cx: -1, cy: 6.5, r: 1.5, fill: 'dim' },
      // Status LEDs.
      { kind: 'circle', cx: 34, cy: -6.5, r: 1.5, fill: 'dim' },
      { kind: 'circle', cx: 34, cy: 0, r: 1.5, fill: 'dim' },
    ],
  },
];
