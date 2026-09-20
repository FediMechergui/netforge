import type { IconDef } from '../catalog/icon-types.js';

/**
 * Servers (palette category `servers`).
 * Family rules as for computers; the accent is a row of activity lights.
 * Original artwork (§1.6); see catalog/icon-types.ts for the drawing language and icons/README.md
 * for the style guide.
 */
export const ICONS_SERVERS: readonly IconDef[] = [
  {
    id: 'server',
    label: 'Tower server',
    w: 40,
    h: 56,
    shapes: [
      // chassis
      { kind: 'rect', x: -17, y: -27, w: 34, h: 54, r: 4, fill: 'face', stroke: 'line', strokeWidth: 2, join: 'round' },
      // drive bays
      { kind: 'rect', x: -12, y: -21, w: 24, h: 7, r: 1.5, fill: 'face2', stroke: 'dim', strokeWidth: 1.5 },
      { kind: 'rect', x: -12, y: -12, w: 24, h: 7, r: 1.5, fill: 'face2', stroke: 'dim', strokeWidth: 1.5 },
      { kind: 'rect', x: -12, y: -3, w: 24, h: 7, r: 1.5, fill: 'face2', stroke: 'dim', strokeWidth: 1.5 },
      // bay activity lights (accent)
      { kind: 'circle', cx: 7.5, cy: -17.5, r: 1.5, fill: 'accent' },
      { kind: 'circle', cx: 7.5, cy: -8.5, r: 1.5, fill: 'accent' },
      { kind: 'circle', cx: 7.5, cy: 0.5, r: 1.5, fill: 'accent' },
      // vents
      { kind: 'line', x1: -9, y1: 10, x2: 9, y2: 10, stroke: 'dim', strokeWidth: 1.5, cap: 'round' },
      { kind: 'line', x1: -9, y1: 14, x2: 9, y2: 14, stroke: 'dim', strokeWidth: 1.5, cap: 'round' },
      // power button
      { kind: 'circle', cx: 0, cy: 21, r: 2.5, stroke: 'dim', strokeWidth: 1.5 },
    ],
  },

  {
    id: 'server-rack',
    label: 'Rack server stack',
    w: 60,
    h: 54,
    shapes: [
      // rack frame
      { kind: 'rect', x: -29, y: -26, w: 58, h: 52, r: 4, fill: 'face2', stroke: 'line', strokeWidth: 2, join: 'round' },
      // three rack units
      { kind: 'rect', x: -24, y: -21, w: 48, h: 12.5, r: 2.5, fill: 'face', stroke: 'line', strokeWidth: 1.5, join: 'round' },
      { kind: 'rect', x: -24, y: -6, w: 48, h: 12.5, r: 2.5, fill: 'face', stroke: 'line', strokeWidth: 1.5, join: 'round' },
      { kind: 'rect', x: -24, y: 9, w: 48, h: 12.5, r: 2.5, fill: 'face', stroke: 'line', strokeWidth: 1.5, join: 'round' },
      // drive slots
      { kind: 'line', x1: -19, y1: -15, x2: 3, y2: -15, stroke: 'dim', strokeWidth: 1.5, cap: 'round' },
      { kind: 'line', x1: -19, y1: 0, x2: 3, y2: 0, stroke: 'dim', strokeWidth: 1.5, cap: 'round' },
      { kind: 'line', x1: -19, y1: 15, x2: 3, y2: 15, stroke: 'dim', strokeWidth: 1.5, cap: 'round' },
      // status lights (accent)
      { kind: 'circle', cx: 17, cy: -15, r: 2, fill: 'accent' },
      { kind: 'circle', cx: 17, cy: 0, r: 2, fill: 'accent' },
      { kind: 'circle', cx: 17, cy: 15, r: 2, fill: 'accent' },
    ],
  },
];
