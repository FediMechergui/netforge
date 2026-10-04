/**
 * canvas/eigrp.ts — [C1] the EIGRP overlay layer (ARCHITECTURE-P3 §6, §2.16, §3.12; spec §9.6 "EIGRP": successors bold,
 * feasible successors marked, the feasibility condition as an inequality that evaluates live). @since P3 (W3
 * web-canvas).
 *
 * Draws the render model of `canvas/overlays/eigrp-model.ts` for ONE destination (the prefix chosen in the View menu,
 * `topoOverlays.eigrpPrefix`; the model falls back to the first prefix any router knows):
 *
 * - each cable carrying a SUCCESSOR path is a thick underlay below the cables, with an `S` chip at the router's end;
 * - each cable carrying a FEASIBLE SUCCESSOR (and no successor) is a medium underlay, with `FS` at the router's end;
 *   a path that fails the feasibility condition draws nothing on its cable;
 * - above each router, the live INEQUALITY of its best backup: `RD 3072 < FD 3328` (the condition holds: a feasible
 *   successor exists, ok border) or `RD 28416 ≥ FD 3328` (it fails: no backup, warning border); a router whose route
 *   is ACTIVE carries an `A` badge beside it; the router the network is connected to shows nothing (it is the origin).
 *
 * Every encoding keeps a non-colour channel (chips, letters, the inequality text with its `<` or `≥`, underlay
 * thickness); feasible successors are a medium line, never a dash pattern (P2 D20). Two Pixi containers, like
 * `StpLayer`: the underlay (the registry's `eigrp` topology container) and `labels`. The pure helpers have no Pixi
 * dependency; the keyboard outline reads the text forms (`eigrpPortFacts`, `eigrpDeviceFacts`, `eigrpLinkFacts`).
 */
import { Container, Graphics, type Text } from 'pixi.js';
import { portKey, type DeviceId, type LinkId } from '@netforge/engine';
import { geomBounds, sampleBezier, type CableGeom, type Pt } from './cables';
import type { OverlayFact } from './l2';
import { eigrpMetricText, type EigrpOverlayModel, type EigrpPathMark, type EigrpRouterMark, type EigrpWeight } from './overlays/eigrp-model';
import type { DeviceGeom, Layout, PortAnchor } from './ports';
import { inflateRect, makeText, rectsIntersect, setText, viewKey, type Lod, type Rect, type ThemeColors } from './scene';

// ── geometry ─────────────────────────────────────────────────────────────────

/** World units a path chip sits out of its port along the cable. */
export const EIGRP_CHIP_INSET = 15;
/** Underlay width of a cable carrying a successor (world units at zoom quantum 1). */
export const EIGRP_THICK_WIDTH = 9;
/** Underlay width of a cable carrying a feasible successor. */
export const EIGRP_MEDIUM_WIDTH = 5;
/** World units between a router's body and the baseline of its inequality. */
export const INEQUALITY_LIFT = 9;

/** Underlay width of a cable weight: thick for a successor, medium for a feasible successor, none otherwise. */
export function eigrpWidth(weight: EigrpWeight, pxq = 1): number {
  if (weight === 'thick') return EIGRP_THICK_WIDTH * pxq;
  if (weight === 'medium') return EIGRP_MEDIUM_WIDTH * pxq;
  return 0;
}

/** Where a path chip sits: out of the router's port along the cable. */
export function pathChipPoint(anchor: Pick<PortAnchor, 'x' | 'y' | 'nx' | 'ny'>, pxq = 1): Pt {
  return { x: anchor.x + anchor.nx * EIGRP_CHIP_INSET * pxq, y: anchor.y + anchor.ny * EIGRP_CHIP_INSET * pxq };
}

/** Where a router's inequality sits: centred above its body (the text's bottom edge). */
export function inequalityPoint(g: Pick<DeviceGeom, 'x' | 'y' | 'halfH'>, pxq = 1): Pt {
  return { x: g.x, y: g.y - g.halfH - INEQUALITY_LIFT * pxq };
}

/**
 * The chip text per port (`portKey`): the chips of the paths leaving that port, successors first (`S`, `FS`, or
 * `S FS` when two neighbours on one segment play both parts). Ports with no chipped path are absent.
 */
export function portChips(model: EigrpOverlayModel | null): ReadonlyMap<string, string> {
  const out = new Map<string, string>();
  if (model === null) return out;
  for (const p of model.paths) {
    if (p.chip === '') continue;
    const key = portKey({ device: p.device, port: p.iface });
    const prev = out.get(key);
    if (prev === undefined) out.set(key, p.chip);
    else if (!prev.split(' ').includes(p.chip)) out.set(key, `${prev} ${p.chip}`);
  }
  return out;
}

// ── text forms (the keyboard outline) ────────────────────────────────────────

const ROLE_WORD: Readonly<Record<EigrpPathMark['role'], string>> = Object.freeze({
  successor: 'successor',
  feasible: 'feasible successor',
  other: 'path',
});

/** "successor to 10.4.0.0/24 via 10.0.12.2, distance 3328, reported 3072 (RD 3072 < FD 3328)". */
export function describeEigrpPath(p: EigrpPathMark, prefix: string): string {
  const head = `${ROLE_WORD[p.role]} to ${prefix} via ${p.nextHop}, distance ${eigrpMetricText(p.metric)}, reported ${eigrpMetricText(p.rd)}`;
  if (p.role === 'other') return `${head}; fails the feasibility condition (${p.inequality})`;
  return `${head} (${p.inequality})`;
}

/** "EIGRP 10.4.0.0/24: passive, FD 3328, 1 successor, 1 feasible successor; RD 3072 < FD 3328, a backup is ready". */
export function describeEigrpRouter(r: EigrpRouterMark): string {
  if (r.connected !== undefined) return `EIGRP ${r.prefix}: directly connected on ${r.connected}`;
  let text = `EIGRP ${r.prefix}: ${r.state}`;
  if (r.state === 'active') {
    text += ', querying its neighbours';
    if (r.pendingReplies !== undefined) text += ` (${r.pendingReplies} ${r.pendingReplies === 1 ? 'reply' : 'replies'} awaited)`;
  }
  text += `, FD ${eigrpMetricText(r.fd)}, ${r.successors} ${r.successors === 1 ? 'successor' : 'successors'}, ${r.feasibleSuccessors} ${r.feasibleSuccessors === 1 ? 'feasible successor' : 'feasible successors'}`;
  if (r.text !== '') text += r.holds ? `; ${r.text}, a backup is ready` : `; ${r.text}, no feasible successor`;
  return text;
}

/** The short row form of a router: `A RD 3072 < FD 3328`, `RD 28416 ≥ FD 3328`, `connected`. */
export function shortEigrpRouter(r: EigrpRouterMark): string {
  if (r.connected !== undefined) return 'connected';
  const parts: string[] = [];
  if (r.badge !== '') parts.push(r.badge);
  parts.push(r.text === '' ? `FD ${eigrpMetricText(r.fd)}` : r.text);
  return parts.join(' ');
}

/** Text facts per port (`portKey`): the paths leaving it for the drawn prefix. */
export function eigrpPortFacts(model: EigrpOverlayModel | null): ReadonlyMap<string, OverlayFact> {
  const out = new Map<string, OverlayFact>();
  if (model === null || model.prefix === null) return out;
  const prefix = model.prefix;
  const shorts = new Map<string, string[]>();
  const texts = new Map<string, string[]>();
  for (const p of model.paths) {
    const key = portKey({ device: p.device, port: p.iface });
    const short = p.chip !== '' ? p.chip : p.role === 'other' ? p.inequality : ROLE_WORD[p.role];
    shorts.set(key, [...(shorts.get(key) ?? []), short]);
    texts.set(key, [...(texts.get(key) ?? []), describeEigrpPath(p, prefix)]);
  }
  for (const [key, s] of shorts) out.set(key, { short: s.join(' · '), text: (texts.get(key) ?? []).join('; ') });
  return out;
}

/** Text facts per router: its state, distances and the live inequality. */
export function eigrpDeviceFacts(model: EigrpOverlayModel | null): ReadonlyMap<DeviceId, OverlayFact> {
  const out = new Map<DeviceId, OverlayFact>();
  if (model === null) return out;
  for (const r of model.routers) out.set(r.device, { short: shortEigrpRouter(r), text: describeEigrpRouter(r) });
  return out;
}

/** Text facts per link: whose successor or feasible-successor path it carries. */
export function eigrpLinkFacts(model: EigrpOverlayModel | null, name: (id: DeviceId) => string = (id) => id): ReadonlyMap<LinkId, OverlayFact> {
  const out = new Map<LinkId, OverlayFact>();
  if (model === null || model.prefix === null) return out;
  const prefix = model.prefix;
  for (const l of model.links) {
    const users = model.paths.filter((p) => p.link === l.link && p.weight !== 'none');
    const phrases = users.map((p) => `${ROLE_WORD[p.role]} path of ${name(p.device)}`);
    out.set(l.link, {
      short: l.weight === 'thick' ? 'S' : 'FS',
      text: `EIGRP ${prefix}: ${phrases.length === 0 ? (l.weight === 'thick' ? 'successor path' : 'feasible successor path') : phrases.join(', ')}`,
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

export interface EigrpSyncInput {
  /** The registry's render model, or null when the overlay is off. */
  model: EigrpOverlayModel | null;
  layout: Layout;
  theme: ThemeColors;
  zoom: number;
  lod: Lod;
  view: Rect;
  textResolution: number;
  /** Wall clock (ms); nothing here animates, kept for the common layer input. */
  wall: number;
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

export class EigrpLayer {
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

  sync(input: EigrpSyncInput): void {
    const { model, layout, theme } = input;
    const gen = ++this.generation;
    const view = inflateRect(input.view, 80 / Math.max(input.zoom, 1e-3));
    const zoomBucket = Math.round(Math.log2(Math.max(input.zoom, 1e-3)) * 4);
    const pxq = 1 / 2 ** (zoomBucket / 4);
    const chips = portChips(model);

    const r = (p: Pt): string => `${Math.round(p.x)},${Math.round(p.y)}`;
    const parts: string[] = [String(theme.stamp), viewKey(input.view, input.zoom), input.lod, String(input.textResolution)];
    if (model !== null) {
      parts.push(String(model.prefix));
      for (const l of model.links) {
        const geom = input.cableGeometry(l.link);
        parts.push(`L${l.link}|${geom ? `${r(geom.p0)}|${r(geom.p3)}` : '-'}|${l.weight}`);
      }
      for (const [key, chip] of chips) {
        const anchor = layout.edge.get(key);
        parts.push(`C${key}|${anchor ? r(anchor) : '-'}|${chip}`);
      }
      for (const rt of model.routers) {
        const g = layout.devices.get(rt.device);
        parts.push(`R${rt.device}|${g ? r(g) : '-'}|${rt.badge}|${rt.text}|${rt.holds ? 1 : 0}`);
      }
    }
    const sig = parts.join(';');
    if (sig === this.sig) return;
    this.sig = sig;

    const g = this.ground;
    const glyphs = this.glyphs;
    g.clear();
    glyphs.clear();

    if (model !== null) {
      const showText = input.lod !== 'far';
      // the underlay
      for (const l of model.links) {
        const width = eigrpWidth(l.weight, pxq);
        if (width === 0) continue;
        const geom = input.cableGeometry(l.link);
        if (!geom || !rectsIntersect(inflateRect(geomBounds(geom), 20), view)) continue;
        if (tracePolyline(g, sampleBezier(geom, 24))) {
          g.stroke({ width, color: l.weight === 'thick' ? theme.ok : theme.accent, alpha: l.weight === 'thick' ? 0.55 : 0.45, cap: 'round', join: 'round' });
        }
      }
      if (showText) {
        // the chips at the routers' ends
        for (const [key, chip] of chips) {
          const anchor = layout.edge.get(key);
          if (anchor === undefined) continue;
          const at = pathChipPoint(anchor, pxq);
          if (at.x < view.minX || at.x > view.maxX || at.y < view.minY || at.y > view.maxY) continue;
          const badge = this.badge(`chip:${key}`, theme, 8, true, gen);
          setText(badge.text, chip, theme.text, theme.mono, input.textResolution);
          badge.text.anchor.set(0.5);
          badge.text.scale.set(1);
          const w = Math.max(14, badge.text.width + 7);
          const successor = chip.split(' ').includes('S');
          glyphs
            .roundRect(at.x - (w / 2) * pxq, at.y - 6.5 * pxq, w * pxq, 13 * pxq, 6.5 * pxq)
            .fill({ color: theme.panel, alpha: 0.96 })
            .stroke({ width: (successor ? 1.8 : 1.2) * pxq, color: successor ? theme.ok : theme.accent });
          badge.text.position.set(at.x, at.y);
          badge.text.scale.set(pxq);
          badge.text.visible = true;
        }
        // the inequality and the active badge at each router
        for (const rt of model.routers) {
          const geom = layout.devices.get(rt.device);
          if (geom === undefined) continue;
          const at = inequalityPoint(geom, pxq);
          if (at.x < view.minX || at.x > view.maxX || at.y < view.minY || at.y > view.maxY) continue;
          const caption = rt.text;
          let left = at.x;
          if (caption !== '') {
            const badge = this.badge(`router:${rt.device}`, theme, 8, true, gen);
            setText(badge.text, caption, theme.text, theme.mono, input.textResolution);
            badge.text.anchor.set(0.5, 1);
            badge.text.scale.set(1);
            const w = badge.text.width + 10;
            glyphs
              .roundRect(at.x - (w / 2) * pxq, at.y - 13 * pxq, w * pxq, 14 * pxq, 3 * pxq)
              .fill({ color: theme.panel, alpha: 0.96 })
              .stroke({ width: (rt.holds ? 1.2 : 1.8) * pxq, color: rt.holds ? theme.ok : theme.warn });
            badge.text.position.set(at.x, at.y - 1 * pxq);
            badge.text.scale.set(pxq);
            badge.text.visible = true;
            left = at.x - (w / 2) * pxq;
          }
          if (rt.badge !== '') {
            const a = this.badge(`active:${rt.device}`, theme, 8, false, gen);
            setText(a.text, rt.badge, theme.text, theme.sans, input.textResolution);
            a.text.anchor.set(0.5);
            const cx = caption === '' ? at.x : left - 9 * pxq;
            const cy = at.y - 6 * pxq;
            glyphs.circle(cx, cy, 6.5 * pxq).fill({ color: theme.panel, alpha: 0.96 }).stroke({ width: 1.8 * pxq, color: theme.warn });
            a.text.position.set(cx, cy);
            a.text.scale.set(pxq);
            a.text.visible = true;
          }
        }
      }
    }

    for (const [key, badge] of this.badges) {
      if (badge.seen !== gen) {
        badge.text.destroy();
        this.badges.delete(key);
      }
    }
  }

  /** Nothing here animates (the inequality is redrawn when the rows change); present for the common layer shape. */
  animate(wall: number, reducedMotion: boolean, theme: ThemeColors): boolean {
    void wall;
    void reducedMotion;
    void theme;
    return false;
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
