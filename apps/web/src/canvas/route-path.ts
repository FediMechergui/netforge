/**
 * canvas/route-path.ts — [S7] the route-path overlay layer (ARCHITECTURE-P3C §6, §7 W1c web-canvas; spec §9.6 "Routing
 * (any)"). @since P3c (W1c web-canvas).
 *
 * Draws the render model of `canvas/overlays/route-path-model.ts` for ONE destination (`topoOverlays.routeTo`):
 *
 * - each cable a hop crosses is a track below the cables with an arrowhead at its middle pointing the way the packet
 *   goes (two arrowheads when hops cross it both ways); a cable on a forwarding loop is drawn in the warning colour;
 * - a tunnel hop, or a hop no cable path reaches, is a gentle arc between the two devices (`airArc`), labelled
 *   `tunnel` for a tunnel; an ECMP hop carries its `1/2` chip at the device's egress port;
 * - above each device its glyph: `◎` the destination, `↻` a device on a loop, `∅` a black hole;
 * - `NAT` at an inside interface where the path is translated.
 *
 * Every encoding keeps a non-colour channel (the arrowheads, glyphs and chips); nothing is a dash pattern (P2 D20).
 * Two Pixi containers, like `EigrpLayer`: the underlay (the registry's `route-path` topology container) and `labels`.
 * The pure helpers have no Pixi dependency; the keyboard outline reads the text forms (`routePathPortFacts`,
 * `routePathDeviceFacts`, `routePathLinkFacts`).
 */
import { Container, Graphics, type Text } from 'pixi.js';
import type { DeviceId, LinkId } from '@netforge/engine';
import { portKey } from '@netforge/engine/contracts';
import { airArc } from './air';
import { geomBounds, sampleBezier, type CableGeom, type Pt } from './cables';
import type { OverlayFact } from './l2';
import {
  ROUTE_BLACK_HOLE_GLYPH,
  ROUTE_LOOP_GLYPH,
  ROUTE_NAT_GLYPH,
  ROUTE_TUNNEL_CHIP,
  type RouteDeviceMark,
  type RouteHop,
  type RoutePathModel,
} from './overlays/route-path-model';
import type { DeviceGeom, Layout, PortAnchor } from './ports';
import { inflateRect, makeText, rectsIntersect, setText, viewKey, type Lod, type Rect, type ThemeColors } from './scene';

// ── geometry ─────────────────────────────────────────────────────────────────

/** Track width of a cable a hop crosses (world units at zoom quantum 1). */
export const ROUTE_TRACK_WIDTH = 7;
/** Half the length of an arrowhead along the cable. */
export const ROUTE_ARROW_SIZE = 7;
/** World units a chip sits out of its port along the cable. */
export const ROUTE_CHIP_INSET = 15;
/** World units between a device's body and its glyph. */
export const ROUTE_GLYPH_LIFT = 10;

/** The point and unit direction halfway along a sampled path (by length). */
export function midpointOf(pts: readonly Pt[]): { at: Pt; dx: number; dy: number } | null {
  if (pts.length < 2) return null;
  let total = 0;
  for (let i = 1; i < pts.length; i++) total += Math.hypot((pts[i] as Pt).x - (pts[i - 1] as Pt).x, (pts[i] as Pt).y - (pts[i - 1] as Pt).y);
  let left = total / 2;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1] as Pt;
    const b = pts[i] as Pt;
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if (len >= left && len > 0) {
      const t = left / len;
      return { at: { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }, dx: (b.x - a.x) / len, dy: (b.y - a.y) / len };
    }
    left -= len;
  }
  const a = pts[pts.length - 2] as Pt;
  const b = pts[pts.length - 1] as Pt;
  const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
  return { at: b, dx: (b.x - a.x) / len, dy: (b.y - a.y) / len };
}

/** The three corners of an arrowhead centred on `at` pointing along (dx, dy). */
export function arrowHead(at: Pt, dx: number, dy: number, size = ROUTE_ARROW_SIZE): [Pt, Pt, Pt] {
  const nx = -dy;
  const ny = dx;
  return [
    { x: at.x + dx * size, y: at.y + dy * size },
    { x: at.x - dx * size + nx * size * 0.8, y: at.y - dy * size + ny * size * 0.8 },
    { x: at.x - dx * size - nx * size * 0.8, y: at.y - dy * size - ny * size * 0.8 },
  ];
}

/** The chip text per egress port (`portKey`): ECMP shares (`1/2`) and `tunnel`. Ports without a chip are absent. */
export function routeChips(model: RoutePathModel | null): ReadonlyMap<string, string> {
  const out = new Map<string, string>();
  if (model === null) return out;
  for (const h of model.hops) {
    const parts: string[] = [];
    if (h.ecmp !== '') parts.push(h.ecmp);
    if (h.via === 'tunnel') parts.push(ROUTE_TUNNEL_CHIP);
    if (parts.length === 0 || h.iface === '') continue;
    const key = portKey({ device: h.from, port: h.iface });
    const prev = out.get(key);
    out.set(key, prev === undefined ? parts.join(' ') : `${prev} ${parts.join(' ')}`);
  }
  return out;
}

// ── text forms (the keyboard outline) ────────────────────────────────────────

const REASON_TEXT: Readonly<Record<NonNullable<RouteDeviceMark['reason']>, string>> = Object.freeze({
  'no-route': 'no route matches, the packet is dropped',
  'no-next-hop': 'the next hop belongs to no device, the packet is dropped',
  down: 'the device is off',
});

const FATE_TEXT: Readonly<Record<RouteDeviceMark['fate'], string>> = Object.freeze({
  delivered: 'reaches the destination',
  loop: 'ends in a forwarding loop',
  'black-hole': 'is dropped on the way',
});

/** "path to 10.4.0.9: 10.4.0.0/24 via 10.0.12.2, loop (↻)" and the like. */
export function describeRouteDevice(m: RouteDeviceMark, to: string): string {
  if (m.state === 'destination') return `path to ${to}: this device owns the destination`;
  let text = `path to ${to}: `;
  if (m.route !== '') text += m.route;
  if (m.state === 'black-hole') text += `${m.route === '' ? '' : ', '}black hole (${ROUTE_BLACK_HOLE_GLYPH}): ${REASON_TEXT[m.reason ?? 'no-route']}`;
  else if (m.state === 'loop') text += `, on a forwarding loop (${ROUTE_LOOP_GLYPH})`;
  else text += `; the packet ${FATE_TEXT[m.fate]}`;
  return text;
}

/** The short row form of a device: its glyph, else `→`. */
export function shortRouteDevice(m: RouteDeviceMark): string {
  return m.glyph !== '' ? m.glyph : '→';
}

/** "next hop 10.0.12.2 (R2), path 1/2" and the like. */
export function describeRouteHop(h: RouteHop, name: (id: DeviceId) => string): string {
  const who = h.to === null ? 'which no device owns' : `(${name(h.to)})`;
  let text = `next hop ${h.nextHop} ${who}`;
  if (h.via === 'tunnel') text += ', through the tunnel';
  if (h.ecmp !== '') text += `, equal-cost path ${h.ecmp}`;
  if (h.loop) text += ', on a loop';
  return text;
}

/** Text facts per port (`portKey`): the hops leaving it, and the NAT mark of an inside interface. */
export function routePathPortFacts(model: RoutePathModel | null, name: (id: DeviceId) => string = (id) => id): ReadonlyMap<string, OverlayFact> {
  const out = new Map<string, OverlayFact>();
  if (model === null || model.to === null) return out;
  const shorts = new Map<string, string[]>();
  const texts = new Map<string, string[]>();
  const add = (key: string, short: string, text: string): void => {
    shorts.set(key, [...(shorts.get(key) ?? []), short]);
    texts.set(key, [...(texts.get(key) ?? []), text]);
  };
  for (const h of model.hops) {
    if (h.iface === '') continue;
    add(portKey({ device: h.from, port: h.iface }), h.ecmp !== '' ? `→ ${h.ecmp}` : '→', `towards ${model.to}: ${describeRouteHop(h, name)}`);
  }
  for (const n of model.nat) add(portKey({ device: n.device, port: n.port }), ROUTE_NAT_GLYPH, `NAT inside interface on the path to ${model.to}`);
  for (const [key, s] of shorts) out.set(key, { short: s.join(' · '), text: (texts.get(key) ?? []).join('; ') });
  return out;
}

/** Text facts per device: what it does with a packet to the destination. */
export function routePathDeviceFacts(model: RoutePathModel | null): ReadonlyMap<DeviceId, OverlayFact> {
  const out = new Map<DeviceId, OverlayFact>();
  if (model === null || model.to === null) return out;
  for (const m of model.devices) out.set(m.device, { short: shortRouteDevice(m), text: describeRouteDevice(m, model.to) });
  return out;
}

/** Text facts per cable: the way the path crosses it. */
export function routePathLinkFacts(model: RoutePathModel | null): ReadonlyMap<LinkId, OverlayFact> {
  const out = new Map<LinkId, OverlayFact>();
  if (model === null || model.to === null) return out;
  for (const l of model.links) {
    const way = l.forward && l.backward ? 'both ways' : 'one way';
    out.set(l.link, {
      short: l.loop ? ROUTE_LOOP_GLYPH : l.forward && l.backward ? '⇄' : '→',
      text: `path to ${model.to} crosses this cable ${way}${l.loop ? ', on a forwarding loop' : ''}`,
    });
  }
  return out;
}

// ── the layer ────────────────────────────────────────────────────────────────

class BadgeView {
  readonly text: Text;
  seen = 0;

  constructor(theme: ThemeColors, size: number, mono: boolean) {
    this.text = makeText('', size, theme.text, mono ? theme.mono : theme.sans, 'bold');
    this.text.anchor.set(0.5);
  }
}

export interface RoutePathSyncInput {
  /** The registry's render model, or null when the overlay is off. */
  model: RoutePathModel | null;
  layout: Layout;
  theme: ThemeColors;
  zoom: number;
  lod: Lod;
  view: Rect;
  textResolution: number;
  cableGeometry(link: LinkId): CableGeom | undefined;
}

function tracePolyline(g: Graphics, pts: readonly Pt[]): boolean {
  const first = pts[0];
  if (first === undefined || pts.length < 2) return false;
  g.moveTo(first.x, first.y);
  for (let i = 1; i < pts.length; i++) {
    const p = pts[i];
    if (p !== undefined) g.lineTo(p.x, p.y);
  }
  return true;
}

function inView(p: Pt, view: Rect): boolean {
  return p.x >= view.minX && p.x <= view.maxX && p.y >= view.minY && p.y <= view.maxY;
}

/** Where a chip sits: out of the device's port along the cable. */
function chipPoint(anchor: Pick<PortAnchor, 'x' | 'y' | 'nx' | 'ny'>, pxq: number): Pt {
  return { x: anchor.x + anchor.nx * ROUTE_CHIP_INSET * pxq, y: anchor.y + anchor.ny * ROUTE_CHIP_INSET * pxq };
}

function glyphPoint(g: Pick<DeviceGeom, 'x' | 'y' | 'halfH'>, pxq: number): Pt {
  return { x: g.x, y: g.y - g.halfH - ROUTE_GLYPH_LIFT * pxq };
}

export class RoutePathLayer {
  private readonly ground = new Graphics();
  private readonly glyphs = new Graphics();
  private readonly badges = new Map<string, BadgeView>();
  private readonly labels: Container;
  private sig = '';
  private generation = 0;

  constructor(ground: Container, labels: Container) {
    this.labels = labels;
    ground.addChild(this.ground);
    labels.addChild(this.glyphs);
  }

  sync(input: RoutePathSyncInput): void {
    const { model, layout, theme } = input;
    const gen = ++this.generation;
    const view = inflateRect(input.view, 80 / Math.max(input.zoom, 1e-3));
    const zoomBucket = Math.round(Math.log2(Math.max(input.zoom, 1e-3)) * 4);
    const pxq = 1 / 2 ** (zoomBucket / 4);
    const chips = routeChips(model);

    const r = (p: Pt): string => `${Math.round(p.x)},${Math.round(p.y)}`;
    const parts: string[] = [String(theme.stamp), viewKey(input.view, input.zoom), input.lod, String(input.textResolution)];
    if (model !== null) {
      parts.push(String(model.to));
      for (const l of model.links) {
        const geom = input.cableGeometry(l.link);
        parts.push(`L${l.link}|${geom ? `${r(geom.p0)}|${r(geom.p3)}` : '-'}|${l.forward ? 1 : 0}${l.backward ? 1 : 0}${l.loop ? 1 : 0}`);
      }
      for (const h of model.hops) {
        if (h.via === 'cable' || h.to === null) continue;
        const a = layout.devices.get(h.from);
        const b = layout.devices.get(h.to);
        parts.push(`H${h.from}|${h.to}|${a ? r(a) : '-'}|${b ? r(b) : '-'}|${h.via}|${h.loop ? 1 : 0}`);
      }
      for (const [key, chip] of chips) {
        const anchor = layout.edge.get(key);
        parts.push(`C${key}|${anchor ? r(anchor) : '-'}|${chip}`);
      }
      for (const m of model.devices) {
        const g = layout.devices.get(m.device);
        parts.push(`D${m.device}|${g ? r(g) : '-'}|${m.glyph}`);
      }
      for (const n of model.nat) {
        const anchor = layout.edge.get(portKey({ device: n.device, port: n.port }));
        parts.push(`N${n.device}|${n.port}|${anchor ? r(anchor) : '-'}`);
      }
    }
    const sig = parts.join(';');
    if (sig === this.sig) return;
    this.sig = sig;

    const g = this.ground;
    const glyphs = this.glyphs;
    g.clear();
    glyphs.clear();

    if (model !== null && model.to !== null) {
      const width = ROUTE_TRACK_WIDTH * pxq;
      // the tracks on the cables, with their arrowheads
      for (const l of model.links) {
        const geom = input.cableGeometry(l.link);
        if (!geom || !rectsIntersect(inflateRect(geomBounds(geom), 20), view)) continue;
        const pts = sampleBezier(geom, 24);
        const color = l.loop ? theme.warn : theme.accent;
        if (tracePolyline(g, pts)) g.stroke({ width, color, alpha: 0.5, cap: 'round', join: 'round' });
        const mid = midpointOf(pts);
        if (mid === null) continue;
        const heads: [number, number][] = [];
        if (l.forward && l.backward) {
          heads.push([1, -ROUTE_ARROW_SIZE * 1.6], [-1, ROUTE_ARROW_SIZE * 1.6]);
        } else heads.push([l.forward ? 1 : -1, 0]);
        for (const [sign, shift] of heads) {
          const at = { x: mid.at.x + mid.dx * shift * pxq, y: mid.at.y + mid.dy * shift * pxq };
          const [p0, p1, p2] = arrowHead(at, mid.dx * sign, mid.dy * sign, ROUTE_ARROW_SIZE * pxq);
          glyphs.poly([p0.x, p0.y, p1.x, p1.y, p2.x, p2.y]).fill({ color, alpha: 0.95 }).stroke({ width: 1 * pxq, color: theme.panel });
        }
      }
      // tunnel and direct hops: an arc between the two devices
      const showText = input.lod !== 'far';
      for (const h of model.hops) {
        if (h.via === 'cable' || h.to === null) continue;
        const a = layout.devices.get(h.from);
        const b = layout.devices.get(h.to);
        if (a === undefined || b === undefined) continue;
        const geom = airArc(a, b, 0.18);
        if (!rectsIntersect(inflateRect(geomBounds(geom), 20), view)) continue;
        const pts = sampleBezier(geom, 24);
        const color = h.loop ? theme.warn : theme.accent;
        if (tracePolyline(g, pts)) g.stroke({ width: (h.via === 'tunnel' ? width : width * 0.6), color, alpha: 0.45, cap: 'round', join: 'round' });
        const mid = midpointOf(pts);
        if (mid === null) continue;
        const [p0, p1, p2] = arrowHead(mid.at, mid.dx, mid.dy, ROUTE_ARROW_SIZE * pxq);
        glyphs.poly([p0.x, p0.y, p1.x, p1.y, p2.x, p2.y]).fill({ color, alpha: 0.95 }).stroke({ width: 1 * pxq, color: theme.panel });
      }
      if (showText) {
        // ECMP and tunnel chips at the egress ports
        for (const [key, chip] of chips) {
          const anchor = layout.edge.get(key);
          if (anchor === undefined) continue;
          const at = chipPoint(anchor, pxq);
          if (!inView(at, view)) continue;
          this.chip(`chip:${key}`, chip, at, theme.accent, theme, input.textResolution, pxq, gen);
        }
        // NAT at the inside interfaces
        for (const n of model.nat) {
          const anchor = layout.edge.get(portKey({ device: n.device, port: n.port }));
          if (anchor === undefined) continue;
          const at = chipPoint(anchor, pxq);
          if (!inView(at, view)) continue;
          this.chip(`nat:${n.device}|${n.port}`, ROUTE_NAT_GLYPH, at, theme.purple, theme, input.textResolution, pxq, gen);
        }
      }
      // the device glyphs (drawn at every level of detail: a loop or a black hole must stay visible)
      for (const m of model.devices) {
        if (m.glyph === '') continue;
        const geom = layout.devices.get(m.device);
        if (geom === undefined) continue;
        const at = glyphPoint(geom, pxq);
        if (!inView(at, view)) continue;
        const color = m.state === 'destination' ? theme.ok : m.state === 'loop' ? theme.warn : theme.err;
        const badge = this.badge(`dev:${m.device}`, theme, 11, false, gen);
        setText(badge.text, m.glyph, theme.text, theme.sans, input.textResolution);
        badge.text.anchor.set(0.5);
        glyphs.circle(at.x, at.y, 9 * pxq).fill({ color: theme.panel, alpha: 0.96 }).stroke({ width: 2 * pxq, color });
        badge.text.position.set(at.x, at.y);
        badge.text.scale.set(pxq);
        badge.text.visible = true;
      }
    }

    for (const [key, badge] of this.badges) {
      if (badge.seen !== gen) {
        badge.text.destroy();
        this.badges.delete(key);
      }
    }
  }

  /** Nothing here animates (the path is redrawn when the tables change); present for the common layer shape. */
  animate(wall: number, reducedMotion: boolean, theme: ThemeColors): boolean {
    void wall;
    void reducedMotion;
    void theme;
    return false;
  }

  private chip(key: string, text: string, at: Pt, border: number, theme: ThemeColors, resolution: number, pxq: number, gen: number): void {
    const badge = this.badge(key, theme, 8, true, gen);
    setText(badge.text, text, theme.text, theme.mono, resolution);
    badge.text.anchor.set(0.5);
    badge.text.scale.set(1);
    const w = Math.max(14, badge.text.width + 7);
    this.glyphs
      .roundRect(at.x - (w / 2) * pxq, at.y - 6.5 * pxq, w * pxq, 13 * pxq, 6.5 * pxq)
      .fill({ color: theme.panel, alpha: 0.96 })
      .stroke({ width: 1.4 * pxq, color: border });
    badge.text.position.set(at.x, at.y);
    badge.text.scale.set(pxq);
    badge.text.visible = true;
  }

  private badge(key: string, theme: ThemeColors, size: number, mono: boolean, gen: number): BadgeView {
    let b = this.badges.get(key);
    if (!b) {
      b = new BadgeView(theme, size, mono);
      this.badges.set(key, b);
      this.labels.addChild(b.text);
    }
    b.seen = gen;
    return b;
  }

  destroy(): void {
    for (const b of this.badges.values()) b.text.destroy();
    this.badges.clear();
    this.ground.destroy();
    this.glyphs.destroy();
  }
}
