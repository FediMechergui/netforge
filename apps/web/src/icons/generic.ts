import type { IconDef } from '../catalog/icon-types.js';

/**
 * Neutral fallback: a small appliance box with a display recess, two port slots and a single
 * status light as the accent. Original artwork, no vendor stencil.
 */
export const ICON_GENERIC: IconDef = {
  id: 'generic',
  label: 'Device',
  w: 52,
  h: 44,
  shapes: [
    { kind: 'rect', x: -25, y: -21, w: 50, h: 42, r: 5, fill: 'face', stroke: 'line', strokeWidth: 2 },
    { kind: 'rect', x: -18, y: -14.5, w: 36, h: 16, r: 3, fill: 'face2', stroke: 'dim', strokeWidth: 1.25 },
    { kind: 'line', x1: -13, y1: -9, x2: 6, y2: -9, stroke: 'dim', strokeWidth: 1.5 },
    { kind: 'line', x1: -13, y1: -3.5, x2: -1, y2: -3.5, stroke: 'dim', strokeWidth: 1.5 },
    { kind: 'rect', x: -18, y: 8, w: 8, h: 6, r: 1.5, stroke: 'dim', strokeWidth: 1.25 },
    { kind: 'rect', x: -6, y: 8, w: 8, h: 6, r: 1.5, stroke: 'dim', strokeWidth: 1.25 },
    { kind: 'circle', cx: 13, cy: 11, r: 3, fill: 'accent' },
  ],
};
