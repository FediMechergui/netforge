import type { IconDef } from '../catalog/icon-types.js';

/**
 * Legacy devices (palette category `legacy`): hubs, coax taps, repeaters and learning bridges.
 * Original artwork (§1.6); see catalog/icon-types.ts for the drawing language and icons/README.md
 * for the style guide.
 */
export const ICONS_LEGACY: readonly IconDef[] = [
  // hub: one shared bus fed from a single point, dropping to every port
  {
    id: 'hub',
    label: 'Hub',
    w: 88,
    h: 30,
    shapes: [
      { kind: 'rect', x: -43, y: -14, w: 86, h: 28, r: 4, fill: 'face', stroke: 'line', strokeWidth: 2, join: 'round' },
      { kind: 'rect', x: -33.5, y: 3, w: 7, h: 7, r: 1.5, fill: 'face2', stroke: 'dim', strokeWidth: 1.25 },
      { kind: 'rect', x: -21.5, y: 3, w: 7, h: 7, r: 1.5, fill: 'face2', stroke: 'dim', strokeWidth: 1.25 },
      { kind: 'rect', x: -9.5, y: 3, w: 7, h: 7, r: 1.5, fill: 'face2', stroke: 'dim', strokeWidth: 1.25 },
      { kind: 'rect', x: 2.5, y: 3, w: 7, h: 7, r: 1.5, fill: 'face2', stroke: 'dim', strokeWidth: 1.25 },
      { kind: 'rect', x: 14.5, y: 3, w: 7, h: 7, r: 1.5, fill: 'face2', stroke: 'dim', strokeWidth: 1.25 },
      { kind: 'rect', x: 26.5, y: 3, w: 7, h: 7, r: 1.5, fill: 'face2', stroke: 'dim', strokeWidth: 1.25 },
      {
        kind: 'path',
        d: 'M0 -8 V-4 M-30 -4 H30 M-30 -4 V3 M-18 -4 V3 M-6 -4 V3 M6 -4 V3 M18 -4 V3 M30 -4 V3',
        stroke: 'accent',
        strokeWidth: 1.5,
        cap: 'round',
        join: 'round',
      },
      { kind: 'circle', cx: 0, cy: -8, r: 2.5, fill: 'accent' },
    ],
  },

  // coax-tap: a T-connector clamped onto a coax line, dropping to a transceiver
  {
    id: 'coax-tap',
    label: 'Coax tap',
    w: 64,
    h: 44,
    shapes: [
      { kind: 'rect', x: -31, y: -12, w: 62, h: 8, r: 4, fill: 'face2', stroke: 'line', strokeWidth: 2, join: 'round' },
      { kind: 'path', d: 'M-26 -8 H-12 M12 -8 H26 M-22 -12 V-4 M22 -12 V-4', stroke: 'dim', strokeWidth: 1.25, cap: 'round' },
      { kind: 'line', x1: 0, y1: 8, x2: 0, y2: 12, stroke: 'line', strokeWidth: 2, cap: 'round' },
      { kind: 'rect', x: -10, y: -15, w: 20, h: 14, r: 3, fill: 'face', stroke: 'accent', strokeWidth: 2, join: 'round' },
      { kind: 'rect', x: -5, y: -1, w: 10, h: 9, r: 2, fill: 'face', stroke: 'accent', strokeWidth: 2, join: 'round' },
      { kind: 'rect', x: -15, y: 12, w: 30, h: 9, r: 3, fill: 'face', stroke: 'line', strokeWidth: 2, join: 'round' },
      { kind: 'circle', cx: -8, cy: 16.5, r: 1.5, fill: 'dim' },
      { kind: 'line', x1: -2, y1: 16.5, x2: 9, y2: 16.5, stroke: 'dim', strokeWidth: 1.25, cap: 'round' },
    ],
  },

  // repeater: two ports with an amplifier triangle between them
  {
    id: 'repeater',
    label: 'Repeater',
    w: 64,
    h: 36,
    shapes: [
      { kind: 'rect', x: -31, y: -17, w: 62, h: 34, r: 5, fill: 'face', stroke: 'line', strokeWidth: 2, join: 'round' },
      { kind: 'circle', cx: -24, cy: -10, r: 1.5, fill: 'dim' },
      { kind: 'circle', cx: -19, cy: -10, r: 1.5, fill: 'dim' },
      { kind: 'rect', x: -25, y: -3.5, w: 10, h: 9, r: 1.5, fill: 'face2', stroke: 'dim', strokeWidth: 1.5 },
      { kind: 'rect', x: 15, y: -3.5, w: 10, h: 9, r: 1.5, fill: 'face2', stroke: 'dim', strokeWidth: 1.5 },
      { kind: 'path', d: 'M-15 1 H-8 M9 1 H15', stroke: 'dim', strokeWidth: 1.5, cap: 'round' },
      { kind: 'polygon', points: [-7, -8.5, 9, 1, -7, 10.5], stroke: 'accent', strokeWidth: 2, join: 'round' },
    ],
  },

  // bridge: two port blocks joined by an arched span over a deck
  {
    id: 'bridge',
    label: 'Bridge',
    w: 88,
    h: 36,
    shapes: [
      { kind: 'line', x1: -13, y1: 7, x2: 13, y2: 7, stroke: 'line', strokeWidth: 2, cap: 'round' },
      { kind: 'path', d: 'M-6.5 -16 V7 M0 -17 V7 M6.5 -16 V7', stroke: 'dim', strokeWidth: 1.25, cap: 'round' },
      { kind: 'rect', x: -43, y: -3, w: 30, h: 20, r: 4, fill: 'face', stroke: 'line', strokeWidth: 2, join: 'round' },
      { kind: 'rect', x: 13, y: -3, w: 30, h: 20, r: 4, fill: 'face', stroke: 'line', strokeWidth: 2, join: 'round' },
      { kind: 'rect', x: -38, y: 4, w: 8, h: 7, r: 1.5, fill: 'face2', stroke: 'dim', strokeWidth: 1.25 },
      { kind: 'rect', x: -26, y: 4, w: 8, h: 7, r: 1.5, fill: 'face2', stroke: 'dim', strokeWidth: 1.25 },
      { kind: 'rect', x: 18, y: 4, w: 8, h: 7, r: 1.5, fill: 'face2', stroke: 'dim', strokeWidth: 1.25 },
      { kind: 'rect', x: 30, y: 4, w: 8, h: 7, r: 1.5, fill: 'face2', stroke: 'dim', strokeWidth: 1.25 },
      { kind: 'arc', cx: 0, cy: 18, r: 35, start: 217, end: 323, stroke: 'accent', strokeWidth: 2, cap: 'round' },
    ],
  },
];
