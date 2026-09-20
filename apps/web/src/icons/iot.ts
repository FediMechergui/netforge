import type { IconDef } from '../catalog/icon-types.js';

/**
 * IoT end devices (palette category `iot`).
 * Original artwork (§1.6); see catalog/icon-types.ts for the drawing language and icons/README.md
 * for the style guide.
 */
export const ICONS_IOT: readonly IconDef[] = [
  {
    id: 'iot-sensor',
    label: 'IoT sensor',
    w: 40,
    h: 40,
    shapes: [
      { kind: 'arc', cx: 0, cy: 0, r: 17, start: 200, end: 340, stroke: 'accent', strokeWidth: 1.5, cap: 'round' },
      { kind: 'arc', cx: 0, cy: 0, r: 17, start: 20, end: 160, stroke: 'accent', strokeWidth: 1.5, cap: 'round' },
      { kind: 'circle', cx: 0, cy: 0, r: 11, fill: 'face', stroke: 'line', strokeWidth: 2 },
      { kind: 'circle', cx: 0, cy: 0, r: 5.5, fill: 'face2', stroke: 'dim', strokeWidth: 1.25 },
      { kind: 'circle', cx: 0, cy: 0, r: 2, fill: 'dim' },
    ],
  },

  {
    id: 'ip-camera',
    label: 'IP camera',
    w: 52,
    h: 40,
    shapes: [
      { kind: 'path', d: 'M -4 0 V 10 H -18', stroke: 'line', strokeWidth: 2, cap: 'round', join: 'round' },
      { kind: 'rect', x: -24, y: 4, w: 6, h: 14, r: 2, fill: 'face', stroke: 'line', strokeWidth: 2, join: 'round' },
      { kind: 'rect', x: -20, y: -16, w: 34, h: 16, r: 5, fill: 'face', stroke: 'line', strokeWidth: 2, join: 'round' },
      { kind: 'line', x1: -14, y1: -8, x2: 4, y2: -8, stroke: 'dim', strokeWidth: 1.5, cap: 'round' },
      { kind: 'polyline', points: [-18, -19, 17, -19, 21.5, -14.5], stroke: 'dim', strokeWidth: 1.5, cap: 'round', join: 'round' },
      { kind: 'ellipse', cx: 16, cy: -8, rx: 5, ry: 8.5, fill: 'face', stroke: 'line', strokeWidth: 2 },
      { kind: 'ellipse', cx: 16.5, cy: -8, rx: 2.5, ry: 4.5, fill: 'accent' },
    ],
  },

  {
    id: 'thermostat',
    label: 'Smart thermostat',
    w: 44,
    h: 48,
    shapes: [
      { kind: 'rect', x: -20, y: -22, w: 40, h: 44, r: 6, fill: 'face', stroke: 'line', strokeWidth: 2, join: 'round' },
      { kind: 'circle', cx: 0, cy: -3, r: 13, fill: 'face2', stroke: 'dim', strokeWidth: 1.25 },
      { kind: 'arc', cx: 0, cy: -3, r: 9.5, start: 135, end: 300, stroke: 'accent', strokeWidth: 2, cap: 'round' },
      { kind: 'line', x1: 0, y1: -3, x2: 3, y2: -8, stroke: 'dim', strokeWidth: 1.5, cap: 'round' },
      { kind: 'circle', cx: 0, cy: -3, r: 2, fill: 'line' },
      { kind: 'circle', cx: -6, cy: 16, r: 1.5, fill: 'dim' },
      { kind: 'circle', cx: 6, cy: 16, r: 1.5, fill: 'dim' },
    ],
  },

  {
    id: 'smart-plug',
    label: 'Smart plug',
    w: 36,
    h: 48,
    shapes: [
      { kind: 'rect', x: -8, y: -23, w: 4, h: 11, r: 1, fill: 'line' },
      { kind: 'rect', x: 4, y: -23, w: 4, h: 11, r: 1, fill: 'line' },
      { kind: 'line', x1: 0, y1: 17, x2: 0, y2: 22.5, stroke: 'line', strokeWidth: 2, cap: 'round' },
      { kind: 'rect', x: -7, y: 11, w: 14, h: 6, r: 2, fill: 'face', stroke: 'line', strokeWidth: 2, join: 'round' },
      { kind: 'rect', x: -15, y: -13, w: 30, h: 26, r: 6, fill: 'face', stroke: 'line', strokeWidth: 2, join: 'round' },
      { kind: 'arc', cx: 0, cy: 0.5, r: 6, start: -50, end: 230, stroke: 'accent', strokeWidth: 1.5, cap: 'round' },
      { kind: 'line', x1: 0, y1: -7, x2: 0, y2: -0.5, stroke: 'accent', strokeWidth: 1.5, cap: 'round' },
    ],
  },

  {
    id: 'iot-gateway',
    label: 'IoT gateway',
    w: 60,
    h: 48,
    shapes: [
      { kind: 'path', d: 'M -24 -16 L -10 -20.5 L -4 -11 L -18 -5 Z M -24 -16 L -4 -11 M -18 -5 L -13 1', stroke: 'accent', strokeWidth: 1.25, cap: 'round', join: 'round' },
      { kind: 'circle', cx: -24, cy: -16, r: 2.5, fill: 'accent' },
      { kind: 'circle', cx: -10, cy: -20.5, r: 2.5, fill: 'accent' },
      { kind: 'circle', cx: -4, cy: -11, r: 2.5, fill: 'accent' },
      { kind: 'circle', cx: -18, cy: -5, r: 2.5, fill: 'accent' },
      { kind: 'line', x1: 13, y1: 2, x2: 13, y2: -12, stroke: 'line', strokeWidth: 2, cap: 'round' },
      { kind: 'circle', cx: 13, cy: -14, r: 2.5, fill: 'line' },
      { kind: 'rect', x: -20, y: 2, w: 40, h: 18, r: 5, fill: 'face', stroke: 'line', strokeWidth: 2, join: 'round' },
      { kind: 'circle', cx: -12, cy: 11, r: 1.5, fill: 'dim' },
      { kind: 'circle', cx: -6.5, cy: 11, r: 1.5, fill: 'dim' },
      { kind: 'circle', cx: -1, cy: 11, r: 1.5, fill: 'dim' },
      { kind: 'line', x1: 7, y1: 15, x2: 14, y2: 15, stroke: 'dim', strokeWidth: 1.5, cap: 'round' },
    ],
  },
];
