import { describe, expect, it } from 'vitest';
import { Graphics } from 'pixi.js';
import type { IconDef, IconPalette, IconShape } from '../src/catalog/icon-types.js';
import { ICON_GENERIC } from '../src/icons/generic.js';
import { arcToPathD, iconToDataUri, iconToSvg } from '../src/catalog/render-svg.js';
import { badgeLayout, drawIcon, paletteFromCss, parseIconColor, parsePath } from '../src/catalog/render-pixi.js';
import { shapeBounds } from '../src/catalog/shared.js';
import { validateIcon } from '../src/catalog/validate.js';
import {
  DEVICE_CATEGORIES,
  DEVICE_ICONS,
  createCatalog,
  type DeviceKind,
  type ProcessFactory,
  type ProcessName,
} from '@netforge/engine';
import {
  BADGE_READY_ICONS,
  CAPABILITY_BADGES,
  DEVICE_VISUALS,
  GENERIC_VISUAL,
  ICON_GROUPS,
  KIND_DEFAULT_ICON,
  badgeFor,
  buildVisualRegistry,
  resolveVisual,
  visualForModel,
} from '../src/catalog/visuals.js';

describe('visuals (P0.5 W1 brief)', () => {
  const all = [...ICON_GROUPS.flatMap((g) => g.icons), GENERIC_VISUAL];

  it('every DEVICE_ICONS id has original artwork', () => {
    for (const id of DEVICE_ICONS) {
      const def = DEVICE_VISUALS[id];
      expect(def).toBeDefined();
      expect(def.id).toBe(id);
      expect(def.shapes.length).toBeGreaterThan(0);
      expect(def).not.toBe(GENERIC_VISUAL);
    }
  });

  it('every path string parses', () => {
    let paths = 0;
    for (const def of all) {
      for (const s of def.shapes) {
        if (s.kind !== 'path') continue;
        paths++;
        expect(() => parsePath(s.d), `${def.id}: ${s.d}`).not.toThrow();
        expect(parsePath(s.d)[0]?.cmd).toBe('M');
      }
    }
    expect(paths).toBeGreaterThan(0);
  });

  it('groups follow DEVICE_CATEGORIES order with their labels, one artwork file each', () => {
    expect(ICON_GROUPS.map((g) => g.id)).toEqual(DEVICE_CATEGORIES.map((c) => c.id));
    expect(ICON_GROUPS.map((g) => g.label)).toEqual(DEVICE_CATEGORIES.map((c) => c.label));
    for (const g of ICON_GROUPS) expect(g.icons.length).toBeGreaterThan(0);
  });

  it("every catalog model's icon resolves without the generic fallback", () => {
    const catalog = createCatalog({} as Record<ProcessName, ProcessFactory>);
    const models = catalog.list();
    expect(models.length).toBeGreaterThan(0);
    for (const m of models) {
      const r = resolveVisual(m);
      expect(r.source, m.type).not.toBe('generic');
      if (m.icon !== undefined) {
        expect(r.source, m.type).toBe('model');
        expect(r.def.id).toBe(m.icon);
      } else {
        expect(r.def.id).toBe(KIND_DEFAULT_ICON[m.kind]);
      }
    }
  });

  it('reports the resolution source', () => {
    expect(resolveVisual({ kind: 'switch', icon: 'switch-poe' }).source).toBe('model');
    expect(resolveVisual({ kind: 'modem' })).toEqual({ def: DEVICE_VISUALS['modem-dsl'], source: 'kind' });
    const alien = JSON.parse('{"kind":"toaster","icon":"nope"}') as Parameters<typeof resolveVisual>[0];
    expect(resolveVisual(alien)).toEqual({ def: GENERIC_VISUAL, source: 'generic' });
  });

  it('derives badges from capabilities on badge-ready icons only', () => {
    // Capability badges are valid badge text.
    for (const b of CAPABILITY_BADGES) expect(b.text.length).toBeLessThanOrEqual(4);
    // Badge-ready icons reserve a corner with their own artwork badge.
    for (const id of BADGE_READY_ICONS) expect(DEVICE_VISUALS[id].badge).toBeDefined();

    // L3 + PoE on an L3 switch: L3 wins (priority order).
    const ml = visualForModel({ kind: 'mlswitch', icon: 'mlswitch', capabilities: ['switching', 'routing', 'layer3-switch', 'poe-source'] });
    expect(ml.badge).toBe('L3');
    expect(ml).toBe(DEVICE_VISUALS.mlswitch);
    // A PoE switch icon on a model that also routes as an L3 switch shows L3 (shorter, fits the PoE corner).
    const poeL3 = visualForModel({ kind: 'switch', icon: 'switch-poe', capabilities: ['switching', 'routing', 'layer3-switch', 'poe-source'] });
    expect(poeL3.badge).toBe('L3');
    expect(poeL3.id).toBe('switch-poe');
    expect(poeL3.shapes).toBe(DEVICE_VISUALS['switch-poe'].shapes);
    expect(validateIcon(poeL3)).toEqual([]);
    // Identity-stable variants.
    expect(visualForModel({ kind: 'switch', icon: 'switch-poe', capabilities: ['layer3-switch'] })).toBe(poeL3);
    // A longer capability badge never replaces a shorter artwork badge (PoE on the mlswitch L3 corner).
    expect(badgeFor(DEVICE_VISUALS.mlswitch, ['poe-source'])).toBe('L3');
    // The plain switch has a full port row under the badge corner: no capability badge.
    expect(visualForModel({ kind: 'switch', icon: 'switch', capabilities: ['switching', 'poe-source'] })).toBe(DEVICE_VISUALS.switch);
    // Non-ready icons keep their artwork badge; no capabilities keeps the artwork badge.
    expect(visualForModel({ kind: 'modem', icon: 'ont', capabilities: ['modem', 'poe-source'] }).badge).toBe('PON');
    expect(visualForModel({ kind: 'switch', icon: 'switch-poe' }).badge).toBe('PoE');
    expect(badgeFor(GENERIC_VISUAL, ['layer3-switch'])).toBeUndefined();
  });

  it('never mutates the registry when deriving badges', () => {
    visualForModel({ kind: 'switch', icon: 'switch-poe', capabilities: ['layer3-switch'] });
    expect(DEVICE_VISUALS['switch-poe'].badge).toBe('PoE');
    expect(Object.isFrozen(DEVICE_VISUALS)).toBe(true);
  });
});

describe('device visual registry', () => {
  const all = ICON_GROUPS.flatMap((g) => g.icons);

  it('has every DEVICE_ICONS id exactly once across the icon groups', () => {
    const ids = all.map((d) => d.id);
    expect([...ids].sort()).toEqual([...DEVICE_ICONS].sort());
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of DEVICE_ICONS) expect(DEVICE_VISUALS[id].id).toBe(id);
    expect(Object.keys(DEVICE_VISUALS)).toHaveLength(DEVICE_ICONS.length);
  });

  it('throws on missing, duplicated or unknown ids', () => {
    const lists = ICON_GROUPS.map((g) => g.icons);
    expect(() => buildVisualRegistry(lists)).not.toThrow();
    expect(() => buildVisualRegistry(lists.slice(1))).toThrow(/missing icon ids/);
    expect(() => buildVisualRegistry([...lists, [DEVICE_VISUALS.router]])).toThrow(/duplicated icon id 'router'/);
    expect(() => buildVisualRegistry([...lists, [GENERIC_VISUAL]])).toThrow(/unknown icon id 'generic'/);
  });

  it.each([...all, GENERIC_VISUAL].map((d) => [d.id, d] as const))('%s passes validateIcon and renders well-formed SVG', (_id, def) => {
    expect(validateIcon(def)).toEqual([]);
    expect(def.label.trim()).not.toBe('');
    for (const opts of [{}, { size: 64, title: def.label }]) {
      const svg = iconToSvg(def, opts);
      expect(svg.startsWith('<svg ')).toBe(true);
      expect(svg.endsWith('</svg>')).toBe(true);
      expect(checkMarkup(svg)[0]).toBe('svg');
    }
  });

  it('maps every device kind to an existing icon', () => {
    const kinds: readonly DeviceKind[] = [
      'pc', 'switch', 'router', 'hub', 'laptop', 'server', 'phone', 'tablet', 'ipphone', 'printer', 'tv', 'iot', 'mlswitch',
      'dcswitch', 'repeater', 'bridge', 'firewall', 'ids', 'ap', 'wlc', 'wrouter', 'radio', 'cell', 'modem', 'csu', 'cloud',
    ];
    expect(Object.keys(KIND_DEFAULT_ICON).sort()).toEqual([...kinds].sort());
    for (const k of kinds) expect(DEVICE_VISUALS[KIND_DEFAULT_ICON[k]]).toBeDefined();
  });

  it('resolves visualForModel: explicit icon, then kind default, then generic', () => {
    expect(visualForModel({ kind: 'switch', icon: 'switch-poe' }).id).toBe('switch-poe');
    expect(visualForModel({ kind: 'dcswitch' }).id).toBe('dc-leaf');
    expect(visualForModel({ kind: 'phone', icon: undefined }).id).toBe('smartphone');
    // Stale snapshot data: unknown icon id falls back to the kind; unknown kind falls back to generic.
    const stale = JSON.parse('{"kind":"router","icon":"no-such-icon"}') as Parameters<typeof visualForModel>[0];
    expect(visualForModel(stale).id).toBe('router');
    const alien = JSON.parse('{"kind":"toaster"}') as Parameters<typeof visualForModel>[0];
    expect(visualForModel(alien)).toBe(GENERIC_VISUAL);
    const proto = JSON.parse('{"kind":"toString","icon":"constructor"}') as Parameters<typeof visualForModel>[0];
    expect(visualForModel(proto)).toBe(GENERIC_VISUAL);
  });
});

const PALETTE: IconPalette = {
  face: 0x212836,
  face2: 0x161a20,
  line: 0xe6e9ef,
  dim: 0x8a93a5,
  accent: 0x56b4e9,
  accent2: 0xcc79a7,
  ok: 0x009e73,
  warn: 0xe69f00,
  err: 0xd55e00,
};

const icon = (shapes: IconShape[], extra: Partial<IconDef> = {}): IconDef => ({
  id: 'generic',
  label: 'Test',
  w: 40,
  h: 40,
  shapes,
  ...extra,
});

/** Tiny well-formedness check: balanced tags, no stray angle brackets in text. Returns tag names seen. */
function checkMarkup(xml: string): string[] {
  const stack: string[] = [];
  const seen: string[] = [];
  const re = /<(\/?)([a-zA-Z][\w:-]*)((?:\s+[\w:-]+="[^"<>]*")*)\s*(\/?)>/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) {
    const between = xml.slice(last, m.index);
    if (/[<>]/.test(between)) throw new Error(`stray bracket in text: ${between}`);
    last = re.lastIndex;
    const [, closing, name = '', , selfClosing] = m;
    seen.push(name);
    if (closing) {
      const open = stack.pop();
      if (open !== name) throw new Error(`</${name}> closes <${open ?? 'nothing'}>`);
    } else if (!selfClosing) stack.push(name);
  }
  if (/[<>]/.test(xml.slice(last))) throw new Error('stray bracket after last tag');
  if (stack.length) throw new Error(`unclosed: ${stack.join(',')}`);
  return seen;
}

describe('render-svg', () => {
  it('renders the generic icon as well-formed markup with the right viewBox and size', () => {
    const svg = iconToSvg(ICON_GENERIC);
    expect(svg.startsWith('<svg ')).toBe(true);
    expect(svg.endsWith('</svg>')).toBe(true);
    const tags = checkMarkup(svg);
    expect(tags[0]).toBe('svg');
    expect(tags.filter((t) => t === 'rect')).toHaveLength(4);
    expect(svg).toContain('viewBox="-26 -22 52 44"');
    expect(svg).toContain('height="24"');
    expect(svg).toContain('width="28.364"');
    expect(iconToSvg(ICON_GENERIC, { size: 64 })).toContain('height="64"');
  });

  it('paints with CSS variables and default round caps/joins', () => {
    const svg = iconToSvg(ICON_GENERIC);
    for (const v of ['--panel-2', '--bg-2', '--text', '--text-dim', '--accent']) expect(svg).toContain(`"var(${v})"`);
    expect(svg).not.toMatch(/#[0-9a-f]{3,6}/i);
    expect(svg).toContain('stroke-linecap="round"');
    expect(svg).toContain('stroke-linejoin="round"');
    const alpha = iconToSvg(icon([{ kind: 'circle', cx: 0, cy: 0, r: 5, fill: 'accent2', fillAlpha: 0.4, stroke: 'warn', strokeAlpha: 0.5 }]));
    expect(alpha).toContain('fill="var(--purple)" fill-opacity="0.4"');
    expect(alpha).toContain('stroke="var(--warn)"');
    expect(alpha).toContain('stroke-opacity="0.5"');
  });

  it('handles title vs aria-hidden', () => {
    const titled = iconToSvg(ICON_GENERIC, { title: 'Device' });
    expect(titled).toContain('role="img"');
    expect(titled).toContain('<title>Device</title>');
    expect(titled).not.toContain('aria-hidden');
    const plain = iconToSvg(ICON_GENERIC);
    expect(plain).toContain('aria-hidden="true"');
    expect(plain).not.toContain('<title>');
    expect(plain).not.toContain('role=');
  });

  it('escapes title, class and badge text', () => {
    const svg = iconToSvg(icon([{ kind: 'rect', x: -10, y: -10, w: 20, h: 20, fill: 'face' }], { badge: '<&>' }), {
      title: `R&D "lab" <core>`,
      className: `x" onload="alert(1)`,
    });
    checkMarkup(svg);
    expect(svg).toContain('<title>R&amp;D &quot;lab&quot; &lt;core&gt;</title>');
    expect(svg).toContain('class="x&quot; onload=&quot;alert(1)"');
    expect(svg).not.toContain('onload="');
    expect(svg).toContain('>&lt;&amp;&gt;</text>');
    expect(svg).toContain('font-family:var(--sans');
  });

  it('converts arcs clockwise, as a pie slice when filled', () => {
    expect(arcToPathD(0, 0, 10, 0, 90, false)).toBe('M10 0A10 10 0 0 1 0 10');
    expect(arcToPathD(0, 0, 10, 0, 90, true)).toBe('M0 0L10 0A10 10 0 0 1 0 10Z');
    expect(arcToPathD(0, 0, 10, 0, 270, false)).toBe('M10 0A10 10 0 1 1 0 -10');
    expect(arcToPathD(0, 0, 10, 0, 360, false)).toBe('M10 0A10 10 0 1 1 -10 0A10 10 0 1 1 10 0Z');
    expect(arcToPathD(0, 0, 10, 30, 30, false)).toBeNull();
  });

  it('is deterministic and produces a data URI with theme fallbacks', () => {
    expect(iconToSvg(ICON_GENERIC, { title: 'a' })).toBe(iconToSvg(ICON_GENERIC, { title: 'a' }));
    const uri = iconToDataUri(ICON_GENERIC);
    expect(uri.startsWith('data:image/svg+xml,')).toBe(true);
    const decoded = decodeURIComponent(uri.slice('data:image/svg+xml,'.length));
    checkMarkup(decoded);
    expect(decoded).toContain('var(--panel-2, #212836)');
    expect(decodeURIComponent(iconToDataUri(ICON_GENERIC, { theme: 'light' }))).toContain('var(--panel-2, #f2f4f7)');
  });
});

describe('path subset parser', () => {
  it('parses every absolute command', () => {
    expect(parsePath('M1 2 L3 4 H5 V6 C1 2 3 4 5 6 Q7 8 9 10 Z')).toEqual([
      { cmd: 'M', x: 1, y: 2 },
      { cmd: 'L', x: 3, y: 4 },
      { cmd: 'L', x: 5, y: 4 },
      { cmd: 'L', x: 5, y: 6 },
      { cmd: 'C', x1: 1, y1: 2, x2: 3, y2: 4, x: 5, y: 6 },
      { cmd: 'Q', x1: 7, y1: 8, x: 9, y: 10 },
      { cmd: 'Z' },
    ]);
  });

  it('resolves relative variants against the current point and subpath start', () => {
    expect(parsePath('m1 1 l2 0 h3 v4 c1 1 2 2 3 3 q1 0 2 2 z m2 2 l1 0')).toEqual([
      { cmd: 'M', x: 1, y: 1 },
      { cmd: 'L', x: 3, y: 1 },
      { cmd: 'L', x: 6, y: 1 },
      { cmd: 'L', x: 6, y: 5 },
      { cmd: 'C', x1: 7, y1: 6, x2: 8, y2: 7, x: 9, y: 8 },
      { cmd: 'Q', x1: 10, y1: 8, x: 11, y: 10 },
      { cmd: 'Z' },
      { cmd: 'M', x: 3, y: 3 },
      { cmd: 'L', x: 4, y: 3 },
    ]);
  });

  it('supports implicit repetition and compact number syntax', () => {
    expect(parsePath('M0 0 10 0 10 10')).toEqual([
      { cmd: 'M', x: 0, y: 0 },
      { cmd: 'L', x: 10, y: 0 },
      { cmd: 'L', x: 10, y: 10 },
    ]);
    expect(parsePath('m1,1 5,5')[1]).toEqual({ cmd: 'L', x: 6, y: 6 });
    expect(parsePath('M-1-2.5L.5.5h1e1')).toEqual([
      { cmd: 'M', x: -1, y: -2.5 },
      { cmd: 'L', x: 0.5, y: 0.5 },
      { cmd: 'L', x: 10.5, y: 0.5 },
    ]);
  });

  it('throws descriptive errors', () => {
    expect(() => parsePath('M0 0 A5 5 0 0 1 10 0')).toThrow(/Unsupported path command 'A'/);
    expect(() => parsePath('M0 0 S1 1 2 2')).toThrow(/'S'/);
    expect(() => parsePath('M0 0 T1 1')).toThrow(/'T'/);
    expect(() => parsePath('L1 1')).toThrow(/must start with M/);
    expect(() => parsePath('M0 0 L1')).toThrow(/expects 2 numbers/);
    expect(() => parsePath('M0 0 #')).toThrow(/Invalid character/);
  });
});

describe('validateIcon', () => {
  it('accepts the generic icon (every shape inside the box, stroke included)', () => {
    expect(validateIcon(ICON_GENERIC)).toEqual([]);
    for (const s of ICON_GENERIC.shapes) {
      const b = shapeBounds(s);
      expect(b).not.toBeNull();
      if (!b) continue;
      expect(b.minX).toBeGreaterThanOrEqual(-ICON_GENERIC.w / 2);
      expect(b.maxX).toBeLessThanOrEqual(ICON_GENERIC.w / 2);
      expect(b.minY).toBeGreaterThanOrEqual(-ICON_GENERIC.h / 2);
      expect(b.maxY).toBeLessThanOrEqual(ICON_GENERIC.h / 2);
    }
  });

  it('counts half the stroke width when checking bounds', () => {
    const edge: IconShape = { kind: 'rect', x: -20, y: -20, w: 40, h: 40, fill: 'face' };
    expect(validateIcon(icon([edge]))).toEqual([]);
    const stroked = validateIcon(icon([{ ...edge, stroke: 'line', strokeWidth: 2 }]));
    expect(stroked.join('\n')).toMatch(/outside the 40x40 box/);
  });

  it('computes arc and path bounds', () => {
    expect(validateIcon(icon([{ kind: 'arc', cx: 0, cy: 0, r: 18, start: -45, end: 45, stroke: 'accent' }]))).toEqual([]);
    expect(validateIcon(icon([{ kind: 'arc', cx: 0, cy: 0, r: 19.5, start: 80, end: 100, stroke: 'accent' }])).join()).toMatch(/outside/);
    expect(validateIcon(icon([{ kind: 'path', d: 'M-10 0 C-10 -25 10 -25 10 0', stroke: 'line' }])).join()).toMatch(/outside/);
  });

  it('catches bad commands, point counts, numbers, badge, label, sizes', () => {
    const bad = validateIcon({
      id: 'generic',
      label: ' ',
      w: 120,
      h: 40,
      badge: 'LONGER',
      shapes: [
        { kind: 'path', d: 'M0 0 A1 1 0 0 1 2 2', stroke: 'line' },
        { kind: 'polyline', points: [0, 0], stroke: 'line' },
        { kind: 'polygon', points: [0, 0, 1, 1, 2], fill: 'face' },
        { kind: 'circle', cx: Number.NaN, cy: 0, r: 2, fill: 'face' },
        { kind: 'line', x1: 0, y1: 0, x2: 1, y2: 1, fill: 'face' },
      ],
    }).join('\n');
    expect(bad).toMatch(/label is empty/);
    expect(bad).toMatch(/w = 120/);
    expect(bad).toMatch(/badge "LONGER"/);
    expect(bad).toMatch(/Unsupported path command 'A'/);
    expect(bad).toMatch(/shape\[1\] \(polyline\): needs at least 2 points/);
    expect(bad).toMatch(/shape\[2\] \(polygon\): points has odd length 5/);
    expect(bad).toMatch(/shape\[2\] \(polygon\): needs at least 3 points/);
    expect(bad).toMatch(/cx is not a finite number/);
    expect(bad).toMatch(/fill is ignored on line/);
    expect(bad).toMatch(/paints nothing/);
    const many = icon(Array.from({ length: 31 }, (): IconShape => ({ kind: 'circle', cx: 0, cy: 0, r: 1, fill: 'dim' })));
    expect(validateIcon(many).join()).toMatch(/too many shapes/);
  });
});

describe('render-pixi', () => {
  type Call = [string, unknown[]];
  const recorder = (): { g: Graphics; calls: Call[] } => {
    const calls: Call[] = [];
    const proxy: object = new Proxy(
      {},
      {
        get: (_t, name) =>
          (...args: unknown[]) => {
            calls.push([String(name), args]);
            return proxy;
          },
      },
    );
    return { g: proxy as unknown as Graphics, calls };
  };

  it('draws into a real PixiJS v8 Graphics in node and scales uniformly', () => {
    const g1 = new Graphics();
    drawIcon(g1, ICON_GENERIC, PALETTE);
    const b1 = g1.getLocalBounds();
    expect(b1.width).toBeGreaterThan(48);
    expect(b1.width).toBeLessThanOrEqual(52.01);
    expect(b1.height).toBeLessThanOrEqual(44.01);
    const g2 = new Graphics();
    drawIcon(g2, ICON_GENERIC, PALETTE, 2);
    expect(g2.getLocalBounds().width).toBeCloseTo(b1.width * 2, 0);
    g1.destroy();
    g2.destroy();
  });

  it('maps a path to moveTo/lineTo/curves/closePath then fill and stroke', () => {
    const { g, calls } = recorder();
    drawIcon(g, icon([{ kind: 'path', d: 'M0 0 l10 0 v5 q1 1 2 2 C1 1 2 2 3 3 h-10 z', fill: 'face', stroke: 'line', strokeWidth: 1.5 }]), PALETTE);
    expect(calls).toEqual([
      ['beginPath', []],
      ['moveTo', [0, 0]],
      ['lineTo', [10, 0]],
      ['lineTo', [10, 5]],
      ['quadraticCurveTo', [11, 6, 12, 7]],
      ['bezierCurveTo', [1, 1, 2, 2, 3, 3]],
      ['lineTo', [-7, 3]],
      ['closePath', []],
      ['fill', [{ color: PALETTE.face, alpha: 1 }]],
      ['stroke', [{ width: 1.5, color: PALETTE.line, alpha: 1, cap: 'round', join: 'round' }]],
    ]);
  });

  it('draws arcs in radians clockwise, pie slices when filled, and skips fill on lines', () => {
    const { g, calls } = recorder();
    drawIcon(
      g,
      icon([
        { kind: 'arc', cx: 0, cy: 0, r: 10, start: 0, end: 90, stroke: 'accent' },
        { kind: 'arc', cx: 0, cy: 0, r: 10, start: 0, end: 90, fill: 'accent' },
        { kind: 'line', x1: 0, y1: 0, x2: 1, y2: 1, fill: 'face', stroke: 'dim', cap: 'butt' },
      ]),
      PALETTE,
    );
    const names = calls.map((c) => c[0]);
    expect(names).toEqual([
      'beginPath', 'moveTo', 'arc', 'stroke',
      'beginPath', 'moveTo', 'lineTo', 'arc', 'closePath', 'fill',
      'beginPath', 'moveTo', 'lineTo', 'stroke',
    ]);
    const arc = calls[2]?.[1] ?? [];
    expect(arc.slice(0, 3)).toEqual([0, 0, 10]);
    expect(arc[3]).toBe(0);
    expect(arc[4]).toBeCloseTo(Math.PI / 2);
    expect(arc[5]).toBe(false);
    expect(calls[13]?.[1][0]).toMatchObject({ cap: 'butt', join: 'round' });
  });

  it('throws for unsupported path commands', () => {
    expect(() => drawIcon(new Graphics(), icon([{ kind: 'path', d: 'M0 0 A1 1 0 0 1 2 2', stroke: 'line' }]), PALETTE)).toThrow(
      /Unsupported path command 'A'/,
    );
  });

  it('lays out the badge at the bottom-right and draws only its pill', () => {
    expect(badgeLayout(ICON_GENERIC)).toBeNull();
    const def = icon([{ kind: 'rect', x: -10, y: -10, w: 20, h: 20, fill: 'face' }], { badge: 'PoE' });
    const b = badgeLayout(def);
    expect(b).not.toBeNull();
    if (!b) return;
    expect(b.text).toBe('PoE');
    expect(b.x + b.w).toBe(20);
    expect(b.y + b.h).toBe(20);
    expect(b.cx).toBe(b.x + b.w / 2);
    expect(badgeLayout(def, 2)?.w).toBe(b.w * 2);
    const { g, calls } = recorder();
    drawIcon(g, def, PALETTE);
    expect(calls.slice(-4).map((c) => c[0])).toEqual(['beginPath', 'roundRect', 'fill', 'stroke']);
    expect(calls.some((c) => c[0] === 'text')).toBe(false);
  });

  it('parses theme colours with fallbacks', () => {
    expect(parseIconColor('#fff', 0)).toBe(0xffffff);
    expect(parseIconColor(' #56b4e9 ', 0)).toBe(0x56b4e9);
    expect(parseIconColor('#11223380', 0)).toBe(0x112233);
    expect(parseIconColor('rgb(1, 2, 3)', 0)).toBe(0x010203);
    expect(parseIconColor('rgba(255 0 0 / 0.5)', 0)).toBe(0xff0000);
    expect(parseIconColor('rgb(100%, 0%, 50%)', 0)).toBe(0xff0080);
    expect(parseIconColor('', 7)).toBe(7);
    expect(parseIconColor('tomato', 7)).toBe(7);
    const vars: Record<string, string> = { '--panel-2': '#010203', '--purple': 'rgb(4,5,6)', '--text': 'garbage' };
    const pal = paletteFromCss((n) => vars[n] ?? '');
    expect(pal.face).toBe(0x010203);
    expect(pal.accent2).toBe(0x040506);
    expect(pal.line).toBe(0xe6e9ef);
    expect(pal.accent).toBe(0x56b4e9);
  });
});
