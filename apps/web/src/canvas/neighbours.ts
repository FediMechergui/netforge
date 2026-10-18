/**
 * canvas/neighbours.ts — [S26] the neighbours overlay layer (ARCHITECTURE-P3C §6, §7 W1c web-canvas; lesson 28 "map an
 * unknown network"). @since P3c (W1c web-canvas).
 *
 * Draws the render model of `canvas/overlays/neighbours-model.ts` for the protocol chosen in the View menu
 * (`topoOverlays.neighbourProtocol`):
 *
 * - a chip at each cable end whose port holds a neighbour entry, `R1 · Gi0/0 · R`, with the holdtime ring at its left:
 *   a ring as long as the share of the holdtime still to run (an entry about to age out has an almost empty ring);
 * - a thin track under a cable whose ends both hold an entry for each other (the neighbours know each other) or one of
 *   them (heard one way only, a thinner track);
 * - a hollow circle at a cable end where the device listens and hears nobody;
 * - "map from here": with a device selected, a veil over every device its neighbour tables cannot reach.
 *
 * Every encoding keeps a non-colour channel (the chip text, the ring's length, the hollow circle, the veil); nothing is
 * a dash pattern (P2 D20). Two Pixi containers, like `EigrpLayer`: the underlay (the registry's `neighbours` topology
 * container) and `labels`. The keyboard outline reads the text forms (`neighboursPortFacts`, `neighboursDeviceFacts`).
 */
import { Container, Graphics, type Text } from 'pixi.js';
import type { DeviceId, LinkId } from '@netforge/engine';
import { portKey } from '@netforge/engine/contracts';
import { geomBounds, sampleBezier, type CableGeom, type Pt } from './cables';
import type { OverlayFact } from './l2';
import type { NeighbourChip, NeighbourProtocol, NeighboursModel } from './overlays/neighbours-model';
import type { Layout, PortAnchor } from './ports';
import { inflateRect, makeText, rectsIntersect, setText, viewKey, type Lod, type Rect, type ThemeColors } from './scene';

// ── geometry ─────────────────────────────────────────────────────────────────

/** World units a chip's centre sits out of its port along the cable. */
export const NEIGHBOUR_CHIP_INSET = 30;
/** Radius of the holdtime ring and of the hollow glyph. */
export const NEIGHBOUR_RING_RADIUS = 5;
/** Track width of a cable whose two ends know each other. */
export const NEIGHBOUR_TRACK_WIDTH = 5;

/** Where a chip sits: out of the port along the cable. */
export function neighbourChipPoint(anchor: Pick<PortAnchor, 'x' | 'y' | 'nx' | 'ny'>, pxq = 1): Pt {
  return { x: anchor.x + anchor.nx * NEIGHBOUR_CHIP_INSET * pxq, y: anchor.y + anchor.ny * NEIGHBOUR_CHIP_INSET * pxq };
}

/** How a cable is heard: both ends hold an entry, one end does, or neither (absent). */
export function neighbourLinks(model: NeighboursModel | null): ReadonlyMap<LinkId, 'both' | 'one'> {
  const out = new Map<LinkId, 'both' | 'one'>();
  if (model === null) return out;
  const ends = new Map<LinkId, Set<string>>();
  for (const c of model.chips) {
    if (c.link === undefined || c.end === undefined) continue;
    const set = ends.get(c.link) ?? new Set<string>();
    set.add(c.end);
    ends.set(c.link, set);
  }
  for (const [link, set] of ends) out.set(link, set.size >= 2 ? 'both' : 'one');
  return out;
}

// ── text forms (the keyboard outline) ────────────────────────────────────────

const PROTOCOL_WORD: Readonly<Record<NeighbourProtocol, string>> = Object.freeze({ cdp: 'CDP', lldp: 'LLDP' });

/** "CDP neighbour R1 on its Gi0/0, capabilities R, holdtime 150 s, 142 s left". */
export function describeNeighbourChip(c: NeighbourChip): string {
  const proto = c.protocols.map((p) => PROTOCOL_WORD[p]).join(' and ');
  let text = `${proto} neighbour ${c.name} on its ${c.remotePort}`;
  if (c.capabilities !== '') text += `, capabilities ${c.capabilities}`;
  text += `, holdtime ${c.holdS} s`;
  if (c.remainingS !== undefined) text += `, ${c.remainingS} s left`;
  return text;
}

/** Text facts per port (`portKey`): its neighbour entries, or that it listens and hears nobody. */
export function neighboursPortFacts(model: NeighboursModel | null): ReadonlyMap<string, OverlayFact> {
  const out = new Map<string, OverlayFact>();
  if (model === null) return out;
  const shorts = new Map<string, string[]>();
  const texts = new Map<string, string[]>();
  for (const c of model.chips) {
    const key = portKey({ device: c.device, port: c.port });
    shorts.set(key, [...(shorts.get(key) ?? []), c.text]);
    texts.set(key, [...(texts.get(key) ?? []), describeNeighbourChip(c)]);
  }
  for (const h of model.hollows) {
    const key = portKey({ device: h.device, port: h.port });
    shorts.set(key, [...(shorts.get(key) ?? []), '○']);
    texts.set(key, [...(texts.get(key) ?? []), `${h.protocols.map((p) => PROTOCOL_WORD[p]).join(' and ')} listening, no neighbour heard`]);
  }
  for (const [key, s] of shorts) out.set(key, { short: s.join(' · '), text: (texts.get(key) ?? []).join('; ') });
  return out;
}

/** Text facts per device: how many neighbours it lists, and whether "map from here" reaches it. */
export function neighboursDeviceFacts(model: NeighboursModel | null): ReadonlyMap<DeviceId, OverlayFact> {
  const out = new Map<DeviceId, OverlayFact>();
  if (model === null) return out;
  for (const m of model.devices) {
    const proto = m.protocols.map((p) => PROTOCOL_WORD[p]).join(' and ');
    out.set(m.device, {
      short: `${m.entries} nbr`,
      text: `${proto === '' ? 'discovery' : proto}: ${m.entries} ${m.entries === 1 ? 'neighbour entry' : 'neighbour entries'}`,
    });
  }
  if (model.from !== null) {
    for (const id of model.dimmed) {
      const prev = out.get(id);
      const text = 'not reachable from the selected device through neighbour tables';
      out.set(id, prev === undefined ? { short: 'unmapped', text } : { short: `${prev.short} · unmapped`, text: `${prev.text}; ${text}` });
    }
  }
  return out;
}

// ── the layer ────────────────────────────────────────────────────────────────

class BadgeView {
  readonly text: Text;
  seen = 0;

  constructor(theme: ThemeColors, size: number) {
    this.text = makeText('', size, theme.text, theme.mono, 'bold');
    this.text.anchor.set(0.5);
  }
}

export interface NeighboursSyncInput {
  /** The registry's render model, or null when the overlay is off. */
  model: NeighboursModel | null;
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

export class NeighboursLayer {
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

  sync(input: NeighboursSyncInput): void {
    const { model, layout, theme } = input;
    const gen = ++this.generation;
    const view = inflateRect(input.view, 80 / Math.max(input.zoom, 1e-3));
    const zoomBucket = Math.round(Math.log2(Math.max(input.zoom, 1e-3)) * 4);
    const pxq = 1 / 2 ** (zoomBucket / 4);
    const heard = neighbourLinks(model);

    const r = (p: Pt): string => `${Math.round(p.x)},${Math.round(p.y)}`;
    const parts: string[] = [String(theme.stamp), viewKey(input.view, input.zoom), input.lod, String(input.textResolution)];
    if (model !== null) {
      parts.push(model.protocol, String(model.from));
      for (const [link, how] of heard) {
        const geom = input.cableGeometry(link);
        parts.push(`L${link}|${geom ? `${r(geom.p0)}|${r(geom.p3)}` : '-'}|${how}`);
      }
      for (const c of model.chips) {
        const anchor = layout.edge.get(portKey({ device: c.device, port: c.port }));
        parts.push(`C${c.device}|${c.port}|${anchor ? r(anchor) : '-'}|${c.text}|${c.ring}`);
      }
      for (const h of model.hollows) {
        const anchor = layout.edge.get(portKey({ device: h.device, port: h.port }));
        parts.push(`H${h.device}|${h.port}|${anchor ? r(anchor) : '-'}`);
      }
      for (const id of model.dimmed) {
        const g = layout.devices.get(id);
        parts.push(`V${id}|${g ? `${r(g)}|${Math.round(g.halfW)}|${Math.round(g.halfH)}` : '-'}`);
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
      // the tracks of the cables the neighbours were heard over
      for (const [link, how] of heard) {
        const geom = input.cableGeometry(link);
        if (!geom || !rectsIntersect(inflateRect(geomBounds(geom), 20), view)) continue;
        if (tracePolyline(g, sampleBezier(geom, 24))) {
          g.stroke({ width: (how === 'both' ? NEIGHBOUR_TRACK_WIDTH : NEIGHBOUR_TRACK_WIDTH * 0.5) * pxq, color: theme.ok, alpha: 0.4, cap: 'round', join: 'round' });
        }
      }
      // "map from here": a veil over what the selected device's neighbour tables cannot reach (drawn first, under the chips)
      for (const id of model.dimmed) {
        const geom = layout.devices.get(id);
        if (geom === undefined) continue;
        if (!inView({ x: geom.x, y: geom.y }, view)) continue;
        const pad = 6 * pxq;
        glyphs
          .roundRect(geom.x - geom.halfW - pad, geom.y - geom.halfH - pad, (geom.halfW + pad) * 2, (geom.halfH + pad) * 2, 8 * pxq)
          .fill({ color: theme.bg, alpha: 0.6 });
      }
      const showText = input.lod !== 'far';
      for (const c of model.chips) {
        const anchor = layout.edge.get(portKey({ device: c.device, port: c.port }));
        if (anchor === undefined) continue;
        const at = neighbourChipPoint(anchor, pxq);
        if (!inView(at, view)) continue;
        const rr = NEIGHBOUR_RING_RADIUS * pxq;
        let ringAt = at;
        if (showText) {
          const badge = this.badge(`chip:${c.device}|${c.port}|${c.name}`, theme, 8, gen);
          setText(badge.text, c.text, theme.text, theme.mono, input.textResolution);
          badge.text.anchor.set(0.5);
          badge.text.scale.set(1);
          const w = badge.text.width + 10 + NEIGHBOUR_RING_RADIUS * 2 + 4;
          const left = at.x - (w / 2) * pxq;
          glyphs
            .roundRect(left, at.y - 7 * pxq, w * pxq, 14 * pxq, 7 * pxq)
            .fill({ color: theme.panel, alpha: 0.96 })
            .stroke({ width: 1.2 * pxq, color: theme.ok });
          ringAt = { x: left + (5 + NEIGHBOUR_RING_RADIUS) * pxq, y: at.y };
          badge.text.position.set(at.x + (NEIGHBOUR_RING_RADIUS + 2) * pxq, at.y);
          badge.text.scale.set(pxq);
          badge.text.visible = true;
        }
        // the holdtime ring: a faint full circle and an arc as long as the share still to run (clockwise from the top)
        glyphs.circle(ringAt.x, ringAt.y, rr).stroke({ width: 1 * pxq, color: theme.border, alpha: 0.9 });
        if (c.ring > 0) {
          const start = -Math.PI / 2;
          glyphs.moveTo(ringAt.x + Math.cos(start) * rr, ringAt.y + Math.sin(start) * rr);
          glyphs.arc(ringAt.x, ringAt.y, rr, start, start + c.ring * Math.PI * 2).stroke({ width: 2 * pxq, color: c.ring <= 0.25 ? theme.warn : theme.ok });
        }
      }
      // the hollow glyphs: listening, nobody heard
      for (const h of model.hollows) {
        const anchor = layout.edge.get(portKey({ device: h.device, port: h.port }));
        if (anchor === undefined) continue;
        const at = neighbourChipPoint(anchor, pxq);
        if (!inView(at, view)) continue;
        glyphs.circle(at.x, at.y, NEIGHBOUR_RING_RADIUS * 1.3 * pxq).fill({ color: theme.panel, alpha: 0.9 }).stroke({ width: 1.8 * pxq, color: theme.textDim });
      }
    }

    for (const [key, badge] of this.badges) {
      if (badge.seen !== gen) {
        badge.text.destroy();
        this.badges.delete(key);
      }
    }
  }

  /** Nothing here animates on wall time (the rings follow the sim clock through `sync`). */
  animate(wall: number, reducedMotion: boolean, theme: ThemeColors): boolean {
    void wall;
    void reducedMotion;
    void theme;
    return false;
  }

  private badge(key: string, theme: ThemeColors, size: number, gen: number): BadgeView {
    let b = this.badges.get(key);
    if (!b) {
      b = new BadgeView(theme, size);
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
