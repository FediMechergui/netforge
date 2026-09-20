import type { IconDef } from '../catalog/icon-types.js';

/**
 * WAN & ISP (palette category `wan-isp`): access-line modems, the fibre ONT, the serial line unit
 * and the Internet cloud. Modems differ by silhouette and connector; DSL and PON carry a badge.
 * Original artwork (§1.6); see catalog/icon-types.ts for the drawing language and icons/README.md
 * for the style guide.
 */
export const ICONS_WAN: readonly IconDef[] = [
  // modem-dsl: low flat modem with a thin phone cord plugged into the top
  {
    id: 'modem-dsl',
    label: 'DSL modem',
    w: 56,
    h: 40,
    shapes: [
      { kind: 'rect', x: -27, y: -4, w: 54, h: 22, r: 5, fill: 'face', stroke: 'line', strokeWidth: 2, join: 'round' },
      { kind: 'circle', cx: -17, cy: 5, r: 1.5, fill: 'dim' },
      { kind: 'circle', cx: -11, cy: 5, r: 1.5, fill: 'dim' },
      { kind: 'circle', cx: -5, cy: 5, r: 1.5, fill: 'dim' },
      { kind: 'line', x1: 1, y1: 5, x2: 20, y2: 5, stroke: 'dim', strokeWidth: 1.5, cap: 'round' },
      { kind: 'line', x1: -19, y1: 12, x2: -2, y2: 12, stroke: 'dim', strokeWidth: 1.25, cap: 'round' },
      { kind: 'path', d: 'M13 -11 Q13 -18.5 4 -18.5 H-20', stroke: 'accent', strokeWidth: 1.5, cap: 'round', join: 'round' },
      { kind: 'rect', x: 8, y: -11, w: 10, h: 7, r: 1.5, fill: 'face', stroke: 'accent', strokeWidth: 1.5, join: 'round' },
    ],
    badge: 'DSL',
  },

  // modem-cable: upright modem with a hex screw-on coax connector on its side
  {
    id: 'modem-cable',
    label: 'Cable modem',
    w: 48,
    h: 48,
    shapes: [
      { kind: 'line', x1: -16, y1: 3, x2: -16, y2: 22, stroke: 'line', strokeWidth: 2, cap: 'round' },
      { kind: 'rect', x: -6, y: -15, w: 28, h: 38, r: 5, fill: 'face', stroke: 'line', strokeWidth: 2, join: 'round' },
      { kind: 'circle', cx: 8, cy: -7, r: 1.5, fill: 'dim' },
      { kind: 'circle', cx: 8, cy: -1, r: 1.5, fill: 'dim' },
      { kind: 'circle', cx: 8, cy: 5, r: 1.5, fill: 'dim' },
      { kind: 'path', d: 'M2 13.5 H14 M2 17.5 H14', stroke: 'dim', strokeWidth: 1.25, cap: 'round' },
      { kind: 'rect', x: -13, y: -7, w: 7, h: 8, r: 1, fill: 'face2', stroke: 'dim', strokeWidth: 1.25 },
      { kind: 'polygon', points: [-16, -9, -11, -6, -11, 0, -16, 3, -21, 0, -21, -6], fill: 'face', stroke: 'accent', strokeWidth: 2, join: 'round' },
      { kind: 'circle', cx: -16, cy: -3, r: 1.5, fill: 'accent' },
    ],
  },

  // ont: box fed by a fibre drop into its top, a four-point light sparkle on its face
  {
    id: 'ont',
    label: 'Fibre terminal',
    w: 48,
    h: 48,
    shapes: [
      { kind: 'path', d: 'M 0 -14 V -17 Q 0 -22 -6 -22 H -22', stroke: 'line', strokeWidth: 2, cap: 'round', join: 'round' },
      { kind: 'rect', x: -21, y: -10, w: 42, h: 32, r: 5, fill: 'face', stroke: 'line', strokeWidth: 2, join: 'round' },
      { kind: 'rect', x: -4, y: -14, w: 8, h: 5, r: 1.5, fill: 'face2', stroke: 'dim', strokeWidth: 1.25 },
      { kind: 'polygon', points: [-9, -4, -7, 1, -2, 3, -7, 5, -9, 10, -11, 5, -16, 3, -11, 1], fill: 'accent', stroke: 'accent', strokeWidth: 1.25, join: 'round' },
      { kind: 'rect', x: 6, y: -4, w: 10, h: 7, r: 1.5, fill: 'face2', stroke: 'dim', strokeWidth: 1.25 },
      { kind: 'circle', cx: 8, cy: 8.5, r: 1.5, fill: 'dim' },
      { kind: 'circle', cx: 13, cy: 8.5, r: 1.5, fill: 'dim' },
      { kind: 'line', x1: -16, y1: 16, x2: -4, y2: 16, stroke: 'dim', strokeWidth: 1.5, cap: 'round' },
    ],
    badge: 'PON',
  },

  // csu: 1U unit with rack ears and a D-shaped serial connector
  {
    id: 'csu',
    label: 'Serial line unit',
    w: 88,
    h: 28,
    shapes: [
      { kind: 'rect', x: -43, y: -9, w: 8, h: 18, r: 2, fill: 'face', stroke: 'line', strokeWidth: 2, join: 'round' },
      { kind: 'rect', x: 35, y: -9, w: 8, h: 18, r: 2, fill: 'face', stroke: 'line', strokeWidth: 2, join: 'round' },
      { kind: 'rect', x: -37, y: -13, w: 74, h: 26, r: 4, fill: 'face', stroke: 'line', strokeWidth: 2, join: 'round' },
      { kind: 'circle', cx: -39.5, cy: 0, r: 1.5, fill: 'dim' },
      { kind: 'circle', cx: 39.5, cy: 0, r: 1.5, fill: 'dim' },
      { kind: 'circle', cx: -28, cy: -4, r: 1.5, fill: 'dim' },
      { kind: 'circle', cx: -22, cy: -4, r: 1.5, fill: 'dim' },
      { kind: 'line', x1: -29, y1: 5, x2: -10, y2: 5, stroke: 'dim', strokeWidth: 1.5, cap: 'round' },
      { kind: 'polygon', points: [0, -6, 24, -6, 21, 5.5, 3, 5.5], fill: 'face2', stroke: 'accent', strokeWidth: 2, join: 'round' },
      { kind: 'circle', cx: 4.5, cy: -2.5, r: 1.5, fill: 'dim' },
      { kind: 'circle', cx: 9.5, cy: -2.5, r: 1.5, fill: 'dim' },
      { kind: 'circle', cx: 14.5, cy: -2.5, r: 1.5, fill: 'dim' },
      { kind: 'circle', cx: 19.5, cy: -2.5, r: 1.5, fill: 'dim' },
      { kind: 'circle', cx: 7, cy: 2, r: 1.5, fill: 'dim' },
      { kind: 'circle', cx: 12, cy: 2, r: 1.5, fill: 'dim' },
      { kind: 'circle', cx: 17, cy: 2, r: 1.5, fill: 'dim' },
    ],
  },

  // cloud: soft three-lobed outline with a route hopping across it
  {
    id: 'cloud',
    label: 'Internet cloud',
    w: 84,
    h: 50,
    shapes: [
      {
        kind: 'path',
        d: 'M-24 22 C-35 22 -41 16 -41 9 C-41 1 -35 -4 -28 -4 C-27 -15 -18 -22 -8 -21 C-2 -24 10 -24 14 -14 C18 -20 34 -18 34 -6 C40 -5 41 4 41 8 C41 16 36 22 28 22 Z',
        fill: 'face',
        stroke: 'line',
        strokeWidth: 2,
        join: 'round',
      },
      { kind: 'polyline', points: [-20, 9, -6, -1, 8, 9, 22, -1], stroke: 'accent', strokeWidth: 2, cap: 'round', join: 'round' },
      { kind: 'circle', cx: -20, cy: 9, r: 2.5, fill: 'face', stroke: 'accent', strokeWidth: 1.5 },
      { kind: 'circle', cx: -6, cy: -1, r: 2.5, fill: 'face', stroke: 'accent', strokeWidth: 1.5 },
      { kind: 'circle', cx: 8, cy: 9, r: 2.5, fill: 'face', stroke: 'accent', strokeWidth: 1.5 },
      { kind: 'circle', cx: 22, cy: -1, r: 2.5, fill: 'face', stroke: 'accent', strokeWidth: 1.5 },
    ],
  },
];
