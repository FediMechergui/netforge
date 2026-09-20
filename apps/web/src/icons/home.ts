import type { IconDef } from '../catalog/icon-types.js';

/**
 * Home & SOHO (palette category `home-soho`): the home wireless router (desktop box with two rod
 * antennas, radio arcs as the accent) and the smart TV.
 * Original artwork (§1.6); see catalog/icon-types.ts for the drawing language and icons/README.md
 * for the style guide.
 */
export const ICONS_HOME: readonly IconDef[] = [
  {
    id: 'home-router',
    label: 'Home router',
    w: 60,
    h: 48,
    shapes: [
      // Rear rod antennas.
      { kind: 'rect', x: -24, y: -22, w: 5, h: 26, r: 2.5, fill: 'face', stroke: 'line', strokeWidth: 2, join: 'round' },
      { kind: 'rect', x: 19, y: -22, w: 5, h: 26, r: 2.5, fill: 'face', stroke: 'line', strokeWidth: 2, join: 'round' },
      // Low desktop body.
      { kind: 'rect', x: -28, y: 2, w: 56, h: 18, r: 5, fill: 'face', stroke: 'line', strokeWidth: 2, join: 'round' },
      // Front LAN lights.
      { kind: 'circle', cx: -18, cy: 11, r: 1.5, fill: 'dim' },
      { kind: 'circle', cx: -12, cy: 11, r: 1.5, fill: 'dim' },
      { kind: 'circle', cx: -6, cy: 11, r: 1.5, fill: 'dim' },
      { kind: 'circle', cx: 0, cy: 11, r: 1.5, fill: 'dim' },
      { kind: 'line', x1: 9, y1: 11, x2: 20, y2: 11, stroke: 'dim', strokeWidth: 1.5, cap: 'round' },
      // Feet.
      { kind: 'line', x1: -22, y1: 22, x2: -16, y2: 22, stroke: 'dim', strokeWidth: 1.5, cap: 'round' },
      { kind: 'line', x1: 16, y1: 22, x2: 22, y2: 22, stroke: 'dim', strokeWidth: 1.5, cap: 'round' },
      // Home Wi-Fi waves between the antennas (accent).
      { kind: 'circle', cx: 0, cy: -3, r: 2, fill: 'accent' },
      { kind: 'arc', cx: 0, cy: -3, r: 6.5, start: 225, end: 315, stroke: 'accent', strokeWidth: 2, cap: 'round' },
      { kind: 'arc', cx: 0, cy: -3, r: 12, start: 225, end: 315, stroke: 'accent', strokeWidth: 2, cap: 'round' },
    ],
  },

  {
    id: 'smart-tv',
    label: 'Smart TV',
    w: 80,
    h: 50,
    shapes: [
      { kind: 'line', x1: -26, y1: 17, x2: -30, y2: 23, stroke: 'line', strokeWidth: 2, cap: 'round' },
      { kind: 'line', x1: 26, y1: 17, x2: 30, y2: 23, stroke: 'line', strokeWidth: 2, cap: 'round' },
      { kind: 'rect', x: -38, y: -23, w: 76, h: 40, r: 3, fill: 'face', stroke: 'line', strokeWidth: 2, join: 'round' },
      { kind: 'rect', x: -34, y: -19, w: 68, h: 31, r: 1.5, fill: 'face2' },
      { kind: 'polygon', points: [-5, -10, -5, 4, 7.5, -3], fill: 'accent', stroke: 'accent', strokeWidth: 1.5, join: 'round' },
    ],
  },
];
