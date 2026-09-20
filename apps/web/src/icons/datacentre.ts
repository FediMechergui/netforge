import type { IconDef } from '../catalog/icon-types.js';

/**
 * Data-centre switches (palette category `data-centre`).
 * Slim 1U body with the accent OUTSIDE the body: uplink arrows rising from a leaf, a fan of links
 * dropping from a spine, so their silhouettes differ from a switch and from each other.
 * Original artwork (§1.6); see catalog/icon-types.ts for the drawing language and icons/README.md
 * for the style guide.
 */
export const ICONS_DATACENTRE: readonly IconDef[] = [
  // ── dc-leaf: slim 1U body low in the box, dense two-row grid, uplinks rising above ──
  {
    id: 'dc-leaf',
    label: 'Leaf switch',
    w: 88,
    h: 36,
    shapes: [
      { kind: 'rect', x: -43, y: -3, w: 86, h: 20, r: 3, fill: 'face', stroke: 'line', strokeWidth: 2, join: 'round' },
      {
        kind: 'path',
        d:
          'M -38 1 h 3 v 4 h -3 Z M -33.5 1 h 3 v 4 h -3 Z M -29 1 h 3 v 4 h -3 Z M -24.5 1 h 3 v 4 h -3 Z ' +
          'M -20 1 h 3 v 4 h -3 Z M -15.5 1 h 3 v 4 h -3 Z M -11 1 h 3 v 4 h -3 Z M -6.5 1 h 3 v 4 h -3 Z ' +
          'M -2 1 h 3 v 4 h -3 Z M 2.5 1 h 3 v 4 h -3 Z M 7 1 h 3 v 4 h -3 Z M 11.5 1 h 3 v 4 h -3 Z ' +
          'M -38 8 h 3 v 4 h -3 Z M -33.5 8 h 3 v 4 h -3 Z M -29 8 h 3 v 4 h -3 Z M -24.5 8 h 3 v 4 h -3 Z ' +
          'M -20 8 h 3 v 4 h -3 Z M -15.5 8 h 3 v 4 h -3 Z M -11 8 h 3 v 4 h -3 Z M -6.5 8 h 3 v 4 h -3 Z ' +
          'M -2 8 h 3 v 4 h -3 Z M 2.5 8 h 3 v 4 h -3 Z M 7 8 h 3 v 4 h -3 Z M 11.5 8 h 3 v 4 h -3 Z',
        fill: 'dim',
      },
      { kind: 'rect', x: 20, y: 1, w: 18, h: 11, r: 1.5, fill: 'face2', stroke: 'dim', strokeWidth: 1.25 },
      { kind: 'path', d: 'M 25 6 V -14 M 33 6 V -14', stroke: 'accent', strokeWidth: 2, cap: 'round' },
      { kind: 'polygon', points: [25, -16.5, 21.5, -11.5, 28.5, -11.5], fill: 'accent', stroke: 'accent', strokeWidth: 1.25, join: 'round' },
      { kind: 'polygon', points: [33, -16.5, 29.5, -11.5, 36.5, -11.5], fill: 'accent', stroke: 'accent', strokeWidth: 1.25, join: 'round' },
    ],
  },

  // ── dc-spine: slim 1U body high in the box, six large cages, fan of links below ──
  {
    id: 'dc-spine',
    label: 'Spine switch',
    w: 88,
    h: 36,
    shapes: [
      { kind: 'path', d: 'M -8 3 L -34 16 M -3 3 L -12 16 M 3 3 L 12 16 M 8 3 L 34 16', stroke: 'accent', strokeWidth: 2, cap: 'round' },
      { kind: 'rect', x: -43, y: -17, w: 86, h: 20, r: 3, fill: 'face', stroke: 'line', strokeWidth: 2, join: 'round' },
      { kind: 'rect', x: -38, y: -12.5, w: 11, h: 11, r: 1.5, fill: 'face2', stroke: 'dim', strokeWidth: 1.25 },
      { kind: 'rect', x: -24.5, y: -12.5, w: 11, h: 11, r: 1.5, fill: 'face2', stroke: 'dim', strokeWidth: 1.25 },
      { kind: 'rect', x: -11, y: -12.5, w: 11, h: 11, r: 1.5, fill: 'face2', stroke: 'dim', strokeWidth: 1.25 },
      { kind: 'rect', x: 2.5, y: -12.5, w: 11, h: 11, r: 1.5, fill: 'face2', stroke: 'dim', strokeWidth: 1.25 },
      { kind: 'rect', x: 16, y: -12.5, w: 11, h: 11, r: 1.5, fill: 'face2', stroke: 'dim', strokeWidth: 1.25 },
      { kind: 'rect', x: 29.5, y: -12.5, w: 11, h: 11, r: 1.5, fill: 'face2', stroke: 'dim', strokeWidth: 1.25 },
    ],
  },
];
