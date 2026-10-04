/**
 * canvas/spf.ts — [S3] the SPF stepper's canvas layer (ARCHITECTURE-P3 §6, D10; spec §9.7 "SPF animation"). Owner:
 * web-routing (the stepper and its layer have one owner); the scene and registry wiring are web-canvas's.
 *
 * Draws the render model of `canvas/overlays/spf-model.ts` — the frame the SPF stepper (`routing/SpfStepper.tsx`)
 * shows, for the router and area the link-state browser chose (`routingUi`):
 *
 * - **settled rings** around each vertex where it sits on the canvas (a router on its device; a transit network on
 *   its switch, else at the centroid of its routers): one heavy ring when settled, a second inner ring on the root, an
 *   outer halo on the vertex the shown frame settles, one thin ring while a vertex is only tentative;
 * - a **cost chip** at each ring (`3`; `3?` while tentative — the `?` is the non-colour channel of "not final");
 * - the **tree underlay on the real cables**: a thick underlay on the cable from each settled vertex's parent, and a
 *   thin one on the cable a tentative vertex is offered through. Never a dash pattern (P2 D20).
 *
 * Two Pixi containers, like `StpLayer`: the underlay (below the cables) and `labels`. The layer redraws only when its
 * signature changes; nothing animates by itself (the stepper's play button advances frames), so there is no
 * `animate`. The pure helpers (geometry, text forms) have no Pixi dependency; the keyboard outline reads the text
 * forms so every fact drawn here is also said (`spfPortFacts`, `spfDeviceFacts`, `spfLinkFacts`).
 */
import { Container, Graphics, type Text } from 'pixi.js';
import { portKey, type DeviceId, type LinkId } from '@netforge/engine';
import { geomBounds, sampleBezier, type CableGeom, type Pt } from './cables';
import type { OverlayFact } from './l2';
import type { SpfLinkMark, SpfOverlayModel, SpfPlace, SpfVertexMark } from './overlays/spf-model';
import type { Layout } from './ports';
import { inflateRect, makeText, rectsIntersect, setText, viewKey, type Lod, type Rect, type ThemeColors } from './scene';

// ── geometry ─────────────────────────────────────────────────────────────────

/** World units between a device body and its ring. */
export const SPF_RING_GAP = 7;
/** World units between the ring and the halo of the vertex settled in the shown frame. */
export const SPF_HALO_GAP = 6;
/** Radius of a network vertex's ring when it sits at a centroid (no device body under it). */
export const SPF_CENTROID_RADIUS = 12;

/** The centre of a place on the canvas, and the radius of the body under it (0 at a centroid). */
export function placeCentre(at: SpfPlace, layout: Pick<Layout, 'devices'>): { x: number; y: number; body: number } | undefined {
  if (at.kind === 'device') {
    const g = layout.devices.get(at.device);
    return g === undefined ? undefined : { x: g.x, y: g.y, body: Math.max(g.halfW, g.halfH) };
  }
  let x = 0;
  let y = 0;
  let n = 0;
  for (const id of at.devices) {
    const g = layout.devices.get(id);
    if (g === undefined) continue;
    x += g.x;
    y += g.y;
    n++;
  }
  return n === 0 ? undefined : { x: x / n, y: y / n, body: 0 };
}

/** The radius of a vertex's ring around a body of radius `body` (a centroid gets a fixed small ring). */
export function ringRadius(body: number, pxq = 1): number {
  return body > 0 ? body + SPF_RING_GAP * pxq : SPF_CENTROID_RADIUS * pxq;
}

/** Ring stroke widths by status: the heavy settled ring, the thin tentative one. */
export function ringWidth(status: SpfVertexMark['status'], pxq = 1): number {
  return status === 'tentative' ? 1.2 * pxq : 3 * pxq;
}

/** Underlay width of a cable: thick in the tree, thin on a tentative offer. */
export function spfUnderlayWidth(status: SpfLinkMark['status'], pxq = 1): number {
  return status === 'tree' ? 9 * pxq : 3.5 * pxq;
}

/** Where a vertex's cost chip sits: up and right of its ring, at 45°. */
export function chipPoint(c: Pt, radius: number): Pt {
  const k = Math.SQRT1_2;
  return { x: c.x + radius * k + 4, y: c.y - radius * k - 4 };
}

// ── text forms (the keyboard outline) ────────────────────────────────────────

const STATUS_WORD: Readonly<Record<SpfVertexMark['status'], string>> = Object.freeze({
  root: 'the root, at cost 0',
  settled: 'settled',
  current: 'settled in this step',
  tentative: 'tentative',
});

/** "shortest-path tree from R1 (1.1.1.1), step 3 of 6: R2 (2.2.2.2) settled at cost 2, reached through R1 (1.1.1.1)". */
export function describeSpfVertex(model: Pick<SpfOverlayModel, 'rootName' | 'step' | 'last'>, v: SpfVertexMark): string {
  let text = `shortest-path tree from ${model.rootName}, step ${model.step + 1} of ${model.last + 1}: ${v.name} ${STATUS_WORD[v.status]}`;
  if (v.status !== 'root') text += ` at cost ${v.cost}${v.status === 'tentative' ? ' so far' : ''}`;
  if (v.parentName !== undefined && v.status !== 'root') text += `, reached through ${v.parentName}`;
  return text;
}

/** The short form: `SPF 2`, `SPF 3?`, `SPF root`. */
export function shortSpfVertex(v: SpfVertexMark): string {
  return v.status === 'root' ? 'SPF root' : `SPF ${v.chip}`;
}

/**
 * Text facts of the SPF layer per port (`portKey`): each router port an edge of the shown frame leaves or enters its
 * cable at (the port whose address is the router link's data).
 */
export function spfPortFacts(model: SpfOverlayModel | null): ReadonlyMap<string, OverlayFact> {
  const out = new Map<string, OverlayFact>();
  if (model === null) return out;
  for (const l of model.links) {
    for (const end of l.ports) {
      const key = portKey(end);
      const fact = { short: l.status === 'tree' ? 'SPF tree' : 'SPF offer', text: `shortest-path tree from ${model.rootName}: ${l.text}` };
      const prev = out.get(key);
      out.set(key, prev === undefined ? fact : { short: prev.short, text: `${prev.text}; ${l.text}` });
    }
  }
  return out;
}

/** Text facts per device: the vertex drawn on it (a router, or a transit network on its switch). */
export function spfDeviceFacts(model: SpfOverlayModel | null): ReadonlyMap<DeviceId, OverlayFact> {
  const out = new Map<DeviceId, OverlayFact>();
  if (model === null) return out;
  for (const v of model.vertices) {
    if (v.at.kind !== 'device') continue;
    const prev = out.get(v.at.device);
    const fact = { short: shortSpfVertex(v), text: describeSpfVertex(model, v) };
    out.set(v.at.device, prev === undefined ? fact : { short: `${prev.short} · ${fact.short}`, text: `${prev.text}; ${fact.text}` });
  }
  return out;
}

/** Text facts per link: its place in the shown frame's tree. */
export function spfLinkFacts(model: SpfOverlayModel | null): ReadonlyMap<LinkId, OverlayFact> {
  const out = new Map<LinkId, OverlayFact>();
  if (model === null) return out;
  for (const l of model.links) {
    out.set(l.link, {
      short: l.status === 'tree' ? 'SPF tree' : 'SPF offer',
      text: l.status === 'tree' ? `in the shortest-path tree from ${model.rootName}: ${l.text}` : `offered to the shortest-path tree from ${model.rootName}: ${l.text}`,
    });
  }
  return out;
}

// ── the layer ────────────────────────────────────────────────────────────────

class ChipView {
  readonly text: Text;
  seen = 0;

  constructor(theme: ThemeColors) {
    this.text = makeText('', 8, theme.text, theme.mono, 'bold');
    this.text.anchor.set(0.5);
  }
}

export interface SpfSyncInput {
  /** The registry's render model, or null when the layer is off. */
  model: SpfOverlayModel | null;
  layout: Layout;
  theme: ThemeColors;
  zoom: number;
  lod: Lod;
  view: Rect;
  textResolution: number;
  cableGeometry(link: LinkId): CableGeom | undefined;
}

export class SpfLayer {
  private readonly ground = new Graphics();
  private readonly glyphs = new Graphics();
  private readonly chips = new Map<string, ChipView>();
  private readonly labels: Container;
  private sig = '';
  private generation = 0;

  constructor(ground: Container, labels: Container) {
    this.labels = labels;
    ground.addChild(this.ground);
    labels.addChild(this.glyphs);
  }

  sync(input: SpfSyncInput): void {
    const { model, layout, theme } = input;
    const gen = ++this.generation;
    const view = inflateRect(input.view, 80 / Math.max(input.zoom, 1e-3));
    const zoomBucket = Math.round(Math.log2(Math.max(input.zoom, 1e-3)) * 4);
    const pxq = 1 / 2 ** (zoomBucket / 4);

    const r = (p: Pt): string => `${Math.round(p.x)},${Math.round(p.y)}`;
    const parts: string[] = [String(theme.stamp), viewKey(input.view, input.zoom), input.lod, String(input.textResolution)];
    if (model !== null) {
      parts.push(`${model.device}|${model.area}|${model.step}`);
      for (const l of model.links) {
        const geom = input.cableGeometry(l.link);
        parts.push(`L${l.link}|${geom ? `${r(geom.p0)}|${r(geom.p3)}` : '-'}|${l.status}`);
      }
      for (const v of model.vertices) {
        const c = placeCentre(v.at, layout);
        parts.push(`V${v.key}|${c ? r(c) : '-'}|${v.status}|${v.chip}`);
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
      // the tree underlay: tentative first, the tree over it
      for (const status of ['tentative', 'tree'] as const) {
        for (const l of model.links) {
          if (l.status !== status) continue;
          const geom = input.cableGeometry(l.link);
          if (!geom || !rectsIntersect(inflateRect(geomBounds(geom), 20), view)) continue;
          const pts = sampleBezier(geom, 24);
          const first = pts[0];
          if (first === undefined) continue;
          g.moveTo(first.x, first.y);
          for (let i = 1; i < pts.length; i++) {
            const p = pts[i];
            if (p !== undefined) g.lineTo(p.x, p.y);
          }
          g.stroke({ width: spfUnderlayWidth(status, pxq), color: status === 'tree' ? theme.accent : theme.warn, alpha: status === 'tree' ? 0.5 : 0.45, cap: 'round', join: 'round' });
        }
      }
      // rings and chips
      for (const v of model.vertices) {
        const c = placeCentre(v.at, layout);
        if (c === undefined) continue;
        const radius = ringRadius(c.body, pxq);
        if (c.x + radius < view.minX || c.x - radius > view.maxX || c.y + radius < view.minY || c.y - radius > view.maxY) continue;
        const color = v.status === 'tentative' ? theme.warn : theme.accent;
        if (c.body === 0) glyphs.circle(c.x, c.y, radius).fill({ color: theme.panel, alpha: 0.9 });
        glyphs.circle(c.x, c.y, radius).stroke({ width: ringWidth(v.status, pxq), color, alpha: 0.95 });
        if (v.status === 'root') glyphs.circle(c.x, c.y, Math.max(2 * pxq, radius - 4 * pxq)).stroke({ width: 1.5 * pxq, color, alpha: 0.95 });
        if (v.status === 'current') glyphs.circle(c.x, c.y, radius + SPF_HALO_GAP * pxq).stroke({ width: 2 * pxq, color, alpha: 0.6 });
        if (!showText) continue;
        const at = chipPoint(c, radius + (v.status === 'current' ? SPF_HALO_GAP * pxq : 0));
        const chip = this.chip(`v:${v.key}`, theme, gen);
        setText(chip.text, v.chip, theme.text, theme.mono, input.textResolution);
        const w = Math.max(14, chip.text.width + 8);
        glyphs
          .roundRect(at.x - (w / 2) * pxq, at.y - 7 * pxq, w * pxq, 14 * pxq, 4 * pxq)
          .fill({ color: theme.panel, alpha: 0.95 })
          .stroke({ width: (v.status === 'tentative' ? 1 : 1.6) * pxq, color });
        chip.text.position.set(at.x, at.y);
        chip.text.scale.set(pxq);
        chip.text.visible = true;
      }
    }

    for (const [key, chip] of this.chips) {
      if (chip.seen !== gen) {
        chip.text.destroy();
        this.chips.delete(key);
      }
    }
  }

  private chip(key: string, theme: ThemeColors, gen: number): ChipView {
    let c = this.chips.get(key);
    if (!c) {
      c = new ChipView(theme);
      this.chips.set(key, c);
      this.labels.addChild(c.text);
    }
    c.seen = gen;
    return c;
  }

  destroy(): void {
    for (const c of this.chips.values()) c.text.destroy();
    this.chips.clear();
    this.ground.destroy();
    this.glyphs.destroy();
  }
}
