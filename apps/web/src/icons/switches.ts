import type { IconDef } from '../catalog/icon-types.js';

/**
 * Switches (palette category `switches`).
 * Switch family layout: long low body, accent feature on the LEFT, port row to the right, the
 * bottom-right corner kept clear for a badge.
 * Original artwork (§1.6); see catalog/icon-types.ts for the drawing language and icons/README.md
 * for the style guide.
 */
export const ICONS_SWITCHES: readonly IconDef[] = [
  // ── switch: long low box, fan-out (one frame to many ports) on the left, 12-port row ──
  {
    id: 'switch',
    label: 'Switch',
    w: 88,
    h: 30,
    shapes: [
      { kind: 'rect', x: -43, y: -14, w: 86, h: 28, r: 5, fill: 'face', stroke: 'line', strokeWidth: 2, join: 'round' },
      { kind: 'path', d: 'M -38 0 H -33 M -33 0 L -27 -7 H -24 M -33 0 H -24 M -33 0 L -27 7 H -24', stroke: 'accent', strokeWidth: 2, cap: 'round', join: 'round' },
      { kind: 'line', x1: -18, y1: -6, x2: 37, y2: -6, stroke: 'dim', strokeWidth: 1.25, cap: 'round' },
      {
        kind: 'path',
        d:
          'M -18 1 h 4 v 7 h -4 Z M -12.5 1 h 4 v 7 h -4 Z M -7 1 h 4 v 7 h -4 Z M -1.5 1 h 4 v 7 h -4 Z ' +
          'M 4 1 h 4 v 7 h -4 Z M 9.5 1 h 4 v 7 h -4 Z M 15 1 h 4 v 7 h -4 Z M 20.5 1 h 4 v 7 h -4 Z ' +
          'M 26 1 h 4 v 7 h -4 Z M 31.5 1 h 4 v 7 h -4 Z',
        fill: 'dim',
      },
    ],
  },

  // ── switch-poe: switch body, lightning bolt on the left, 7 ports, PoE badge bottom-right ──
  {
    id: 'switch-poe',
    label: 'PoE switch',
    w: 88,
    h: 30,
    badge: 'PoE',
    shapes: [
      { kind: 'rect', x: -43, y: -14, w: 86, h: 28, r: 5, fill: 'face', stroke: 'line', strokeWidth: 2, join: 'round' },
      { kind: 'polygon', points: [-27, -10.5, -36, 1.5, -30, 1.5, -33, 10.5, -23.5, -2.5, -29.5, -2.5, -25, -10.5], fill: 'accent', stroke: 'accent', strokeWidth: 1.25, join: 'round' },
      { kind: 'line', x1: -18, y1: -6, x2: 37, y2: -6, stroke: 'dim', strokeWidth: 1.25, cap: 'round' },
      {
        kind: 'path',
        d:
          'M -18 1 h 4 v 7 h -4 Z M -12.5 1 h 4 v 7 h -4 Z M -7 1 h 4 v 7 h -4 Z M -1.5 1 h 4 v 7 h -4 Z ' +
          'M 4 1 h 4 v 7 h -4 Z M 9.5 1 h 4 v 7 h -4 Z',
        fill: 'dim',
      },
    ],
  },
];
