import type { IconDef } from '../catalog/icon-types.js';

/**
 * Multilayer switches (palette category `multilayer-switches`).
 * A switch body (switch family layout, badge corner kept clear) with a router cap stacked on top.
 * Original artwork (§1.6); see catalog/icon-types.ts for the drawing language and icons/README.md
 * for the style guide.
 */
export const ICONS_MULTILAYER: readonly IconDef[] = [
  // ── mlswitch: switch body with a router cap stacked on top (routing arrows), L3 badge ──
  {
    id: 'mlswitch',
    label: 'Multilayer switch',
    w: 88,
    h: 46,
    badge: 'L3',
    shapes: [
      { kind: 'rect', x: -22, y: -22, w: 44, h: 20, r: 5, fill: 'face', stroke: 'line', strokeWidth: 2, join: 'round' },
      { kind: 'rect', x: -43, y: -4, w: 86, h: 26, r: 5, fill: 'face', stroke: 'line', strokeWidth: 2, join: 'round' },
      { kind: 'path', d: 'M -9 -14.5 Q 0 -21 8 -15.5', stroke: 'accent', strokeWidth: 2, cap: 'round' },
      { kind: 'polygon', points: [11, -13.5, 6.5, -14, 9.5, -17.5], fill: 'accent', stroke: 'accent', strokeWidth: 1.25, join: 'round' },
      { kind: 'path', d: 'M 9 -11 Q 0 -4.5 -8 -10', stroke: 'accent', strokeWidth: 2, cap: 'round' },
      { kind: 'polygon', points: [-11, -12, -6.5, -11.5, -9.5, -8], fill: 'accent', stroke: 'accent', strokeWidth: 1.25, join: 'round' },
      { kind: 'line', x1: -36, y1: 2.5, x2: 36, y2: 2.5, stroke: 'dim', strokeWidth: 1.25, cap: 'round' },
      {
        kind: 'path',
        d:
          'M -36 8 h 4 v 7 h -4 Z M -30.5 8 h 4 v 7 h -4 Z M -25 8 h 4 v 7 h -4 Z M -19.5 8 h 4 v 7 h -4 Z ' +
          'M -14 8 h 4 v 7 h -4 Z M -8.5 8 h 4 v 7 h -4 Z M -3 8 h 4 v 7 h -4 Z M 2.5 8 h 4 v 7 h -4 Z ' +
          'M 8 8 h 4 v 7 h -4 Z M 13.5 8 h 4 v 7 h -4 Z',
        fill: 'dim',
      },
    ],
  },
];
