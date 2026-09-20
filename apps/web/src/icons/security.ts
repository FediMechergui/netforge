import type { IconDef } from '../catalog/icon-types.js';

/**
 * Security appliances (palette category `security`): firewalls and IDS sensors.
 * Original artwork (§1.6); see catalog/icon-types.ts for the drawing language and icons/README.md
 * for the style guide.
 */
export const ICONS_SECURITY: readonly IconDef[] = [
  // firewall: a slotted barrier; two flows stop at it, one arrow passes through the gap
  {
    id: 'firewall',
    label: 'Firewall',
    w: 64,
    h: 44,
    shapes: [
      { kind: 'rect', x: -31, y: -21, w: 62, h: 42, r: 5, fill: 'face', stroke: 'line', strokeWidth: 2, join: 'round' },
      { kind: 'rect', x: -3, y: -16, w: 6, h: 11, r: 1.5, fill: 'face2', stroke: 'line', strokeWidth: 1.5 },
      { kind: 'rect', x: -3, y: 5, w: 6, h: 11, r: 1.5, fill: 'face2', stroke: 'line', strokeWidth: 1.5 },
      {
        kind: 'path',
        d: 'M-22 -10.5 H-8 M-8 -14 V-7 M-22 10.5 H-8 M-8 7 V14',
        stroke: 'dim',
        strokeWidth: 1.5,
        cap: 'round',
      },
      { kind: 'path', d: 'M-22 0 H20 M14 -6 L20 0 L14 6', stroke: 'accent', strokeWidth: 2, cap: 'round', join: 'round' },
    ],
  },

  // ids: a watchful eye over a signal trace
  {
    id: 'ids',
    label: 'Intrusion detection sensor',
    w: 72,
    h: 40,
    shapes: [
      { kind: 'rect', x: -35, y: -19, w: 70, h: 38, r: 5, fill: 'face', stroke: 'line', strokeWidth: 2, join: 'round' },
      {
        kind: 'polyline',
        points: [-26, 12, -9, 12, -5.5, 7, -2, 16, 1.5, 9, 4.5, 12, 26, 12],
        stroke: 'dim',
        strokeWidth: 1.5,
        cap: 'round',
        join: 'round',
      },
      { kind: 'path', d: 'M-18 -5 C-9 -15.5 9 -15.5 18 -5 C9 5.5 -9 5.5 -18 -5 Z', fill: 'face2', stroke: 'accent', strokeWidth: 2, join: 'round' },
      { kind: 'circle', cx: 0, cy: -5, r: 4, fill: 'accent' },
    ],
  },
];
