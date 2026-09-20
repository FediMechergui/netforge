/**
 * Air overlay: Wi-Fi associations, cellular attachments and point-to-point radio beams (ARCHITECTURE-P1 §7).
 *
 *  • Association lines join the station's antenna to the AP's (or tower's) antenna. The dash pattern encodes the
 *    phase (joined: long dashes; in progress: dots; failed: short dashes and a crossed badge), a lettered phase
 *    badge sits at the midpoint while joining ("Sc", "Au", "As", "4W", …), and near the station a signal glyph
 *    shows the bar count (filled vs hollow bars) with the RSSI in dBm as text. An RF hold adds "hold".
 *  • PtP radio links (TopologyLink kind 'radio') are thick dash-dot beams between the two antennas with the bar
 *    count, distance and channel; a down beam gets the crossed badge and its reason stays in the tooltip.
 *  • Air packets travel on gentle arcs between antennas; each direction bends to its own side, so uplink and
 *    downlink legs never overlap (`airArc`).
 *
 * Every element has a non-colour channel (dash pattern, bars, letters, glyphs). Toggles: `overlays`
 * (associationLines, signalBars, radioBeams). With `radioBeams` off a PtP link still shows as a thin dotted
 * line so it stays visible and selectable.
 */
import { Container, Graphics, type Text } from 'pixi.js';
import {
  portKey,
  type AssociationSnapshot,
  type LinkId,
  type LinkSnapshot,
  type MediaSnapshot,
  type PortRef,
  type Selection,
} from '@netforge/engine';
import type { WirelessOverlayState } from '../store/types';
import { bezierAt, distSqToSegment, drawDownBadge, geomBounds, straightGeometry, type CableGeom, type Pt } from './cables';
import { anchorOf, isRadioLink, type Layout } from './ports';
import { distanceLabel } from './rf';
import { inflateRect, makeText, rectsIntersect, setText, viewKey, type Lod, type Rect, type ThemeColors } from './scene';

/** Overlay toggles used when the store has none yet (every toggle has a non-colour channel). */
export const CANVAS_OVERLAY_DEFAULTS: Readonly<WirelessOverlayState> = Object.freeze({
  rangeRings: false,
  associationLines: true,
  signalBars: true,
  radioBeams: true,
  channelLabels: false,
  backgroundFrames: false,
});

/** Zoom at or above which dBm text and final-phase badges are drawn. */
export const SIGNAL_TEXT_MIN_ZOOM = 0.8;

// ── pure geometry ────────────────────────────────────────────────────────────

/**
 * A gentle arc from `a` to `b` as a cubic. The bulge is `bend` × distance, to the LEFT of the travel direction
 * (screen coordinates), capped at 60 world units, so the two directions of a pair use opposite sides.
 */
export function airArc(a: Pt, b: Pt, bend = 0.12): CableGeom {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy);
  if (len < 1e-6) return straightGeometry(a, b);
  const bulge = Math.min(60, len * bend);
  // left normal of (dx, dy) in y-down screen space
  const nx = dy / len;
  const ny = -dx / len;
  const k = (4 / 3) * bulge;
  return {
    p0: { x: a.x, y: a.y },
    p1: { x: a.x + dx / 3 + nx * k, y: a.y + dy / 3 + ny * k },
    p2: { x: a.x + (2 * dx) / 3 + nx * k, y: a.y + (2 * dy) / 3 + ny * k },
    p3: { x: b.x, y: b.y },
  };
}

type AssocState = AssociationSnapshot['state'];

/** Phase badge text of an association state and whether the state is final (joined). */
export function phaseBadge(state: AssocState): { text: string; final: boolean; failed: boolean } {
  switch (state) {
    case 'idle':
      return { text: '–', final: false, failed: false };
    case 'scanning':
      return { text: 'Sc', final: false, failed: false };
    case 'authenticating':
      return { text: 'Au', final: false, failed: false };
    case 'associating':
      return { text: 'As', final: false, failed: false };
    case 'handshake':
      return { text: '4W', final: false, failed: false };
    case 'associated':
      return { text: '✓', final: true, failed: false };
    case 'failed':
      return { text: '✕', final: false, failed: true };
    case 'searching':
      return { text: 'Se', final: false, failed: false };
    case 'attaching':
      return { text: 'At', final: false, failed: false };
    case 'attached':
      return { text: '✓', final: true, failed: false };
    case 'detached':
      return { text: '✕', final: false, failed: true };
  }
}

/** Dash pattern (screen pixels) of an association line by phase. */
export function assocDash(state: AssocState, authorized: boolean): readonly number[] {
  const p = phaseBadge(state);
  if (p.failed) return [4, 4];
  if (p.final && authorized) return [10, 4];
  return [2, 4];
}

/** One bar of the signal glyph (relative to its bottom-left corner). */
export interface BarRect {
  x: number;
  y: number;
  w: number;
  h: number;
  filled: boolean;
}

/** Four bars of rising height, the first `bars` filled. `unit` scales the glyph. */
export function signalBarRects(bars: number, unit = 1): BarRect[] {
  const n = Math.max(0, Math.min(4, Math.round(bars)));
  const out: BarRect[] = [];
  for (let i = 0; i < 4; i++) {
    const h = (3 + i * 2.5) * unit;
    out.push({ x: i * 3.4 * unit, y: -h, w: 2.4 * unit, h, filled: i < n });
  }
  return out;
}

/** `-58 dBm`, plus ` · hold` while the RF hold countdown runs. */
export function signalText(rssiDbm: number, holding: boolean): string {
  return `${Math.round(rssiDbm)} dBm${holding ? ' · hold' : ''}`;
}

/** Station and AP attachment points of an association (null when either end is not on the canvas). */
export function assocEndpoints(a: Pick<AssociationSnapshot, 'station' | 'ap'>, layout: Pick<Layout, 'antenna' | 'edge' | 'grid' | 'devices'>): { station: Pt; ap: Pt } | null {
  const station = pointFor(a.station, layout);
  if (!station || !a.ap) return null;
  const ap = pointFor(a.ap, layout);
  return ap ? { station, ap } : null;
}

function pointFor(ref: PortRef, layout: Pick<Layout, 'antenna' | 'edge' | 'grid' | 'devices'>): Pt | undefined {
  const anchor = anchorOf(layout as Layout, portKey(ref));
  if (anchor) return { x: anchor.x, y: anchor.y };
  const g = layout.devices.get(ref.device);
  return g ? { x: g.x, y: g.y - g.halfH } : undefined;
}

/** Straight beam between the antennas of a PtP radio link. */
export function beamGeometry(link: Pick<LinkSnapshot, 'a' | 'b'>, layout: Pick<Layout, 'antenna' | 'edge' | 'grid' | 'devices'>): CableGeom | undefined {
  const a = pointFor(link.a, layout);
  const b = pointFor(link.b, layout);
  return a && b ? straightGeometry(a, b) : undefined;
}

/** Path of an air or cellular leg from one radio port to another. */
export function legGeometry(from: PortRef, to: PortRef, layout: Pick<Layout, 'antenna' | 'edge' | 'grid' | 'devices'>): CableGeom | undefined {
  const a = pointFor(from, layout);
  const b = pointFor(to, layout);
  return a && b ? airArc(a, b) : undefined;
}

// ── layer ────────────────────────────────────────────────────────────────────

export interface AirSyncInput {
  layout: Layout;
  media: MediaSnapshot | undefined;
  overlays: WirelessOverlayState;
  theme: ThemeColors;
  selection: Selection | null;
  hover: Selection | null;
  zoom: number;
  lod: Lod;
  view: Rect;
  textResolution: number;
}

class AssocView {
  readonly phase: Text;
  readonly signal: Text;
  a: Pt = { x: 0, y: 0 };
  b: Pt = { x: 0, y: 0 };
  sig = '';
  constructor(theme: ThemeColors) {
    this.phase = makeText('', 9, theme.text, theme.sans, 'bold');
    this.phase.anchor.set(0.5);
    this.signal = makeText('', 9, theme.textDim, theme.mono);
    this.signal.anchor.set(0, 1);
  }
}

class BeamView {
  readonly text: Text;
  geom: CableGeom | undefined;
  constructor(theme: ThemeColors) {
    this.text = makeText('', 9, theme.textDim, theme.mono);
    this.text.anchor.set(0.5, 1);
  }
}

function sameAssoc(sel: Selection | null, id: string): boolean {
  return sel !== null && sel.kind === 'association' && sel.id === id;
}

function sameLink(sel: Selection | null, id: LinkId): boolean {
  return sel !== null && sel.kind === 'link' && sel.id === id;
}

function strokeDashedLine(g: Graphics, a: Pt, b: Pt, pattern: readonly number[]): void {
  const len = Math.hypot(b.x - a.x, b.y - a.y);
  if (len < 1e-6) return;
  const period = pattern.reduce((s, v) => s + v, 0);
  if (period <= 0) {
    g.moveTo(a.x, a.y).lineTo(b.x, b.y);
    return;
  }
  // at most 400 dashes per line; longer lines get stretched dashes
  const stretch = Math.max(1, len / period / 400);
  let s = 0;
  let i = 0;
  while (s < len) {
    const d = (pattern[i % pattern.length] ?? 0) * stretch;
    if (i % 2 === 0 && d > 0) {
      const e = Math.min(len, s + d);
      g.moveTo(a.x + ((b.x - a.x) * s) / len, a.y + ((b.y - a.y) * s) / len).lineTo(a.x + ((b.x - a.x) * e) / len, a.y + ((b.y - a.y) * e) / len);
    }
    s += d;
    i += 1;
  }
}

function drawBars(g: Graphics, x: number, y: number, bars: number, unit: number, theme: ThemeColors): void {
  for (const r of signalBarRects(bars, unit)) {
    g.rect(x + r.x, y + r.y, r.w, r.h);
    if (r.filled) g.fill({ color: theme.text });
    else g.stroke({ width: 0.8 * unit, color: theme.textDim });
  }
}

export class AirLayer {
  private readonly lines = new Graphics();
  private readonly glyphs = new Graphics();
  private readonly assocViews = new Map<string, AssocView>();
  private readonly beamViews = new Map<LinkId, BeamView>();
  private readonly assocGeom = new Map<string, { a: Pt; b: Pt }>();
  private sig = '';

  constructor(
    ground: Container,
    private readonly labels: Container,
  ) {
    ground.addChild(this.lines);
    labels.addChild(this.glyphs);
  }

  sync(input: AirSyncInput): void {
    const { layout, theme, overlays } = input;
    const view = inflateRect(input.view, 80 / Math.max(input.zoom, 1e-3));
    const zoomBucket = Math.round(Math.log2(Math.max(input.zoom, 1e-3)) * 4);
    const pxq = 1 / 2 ** (zoomBucket / 4);
    const showText = input.lod === 'full' && input.zoom >= SIGNAL_TEXT_MIN_ZOOM;

    // geometry first (packets and markers need it even when the overlay is hidden)
    this.assocGeom.clear();
    const assocs = input.media?.associations ?? [];
    for (const a of assocs) {
      const ends = assocEndpoints(a, layout);
      if (ends) this.assocGeom.set(a.id, { a: ends.station, b: ends.ap });
    }
    const liveBeams = new Set<LinkId>();
    for (const link of layout.links.values()) {
      if (!isRadioLink(link)) continue;
      liveBeams.add(link.id);
      let bv = this.beamViews.get(link.id);
      if (!bv) {
        bv = new BeamView(theme);
        this.beamViews.set(link.id, bv);
        this.labels.addChild(bv.text);
      }
      bv.geom = beamGeometry(link, layout);
    }
    for (const [id, bv] of this.beamViews) {
      if (!liveBeams.has(id)) {
        bv.text.destroy();
        this.beamViews.delete(id);
      }
    }

    const r = (p: Pt): string => `${Math.round(p.x)},${Math.round(p.y)}`;
    const sigParts: string[] = [String(theme.stamp), viewKey(input.view, input.zoom), input.lod, String(input.textResolution), JSON.stringify(overlays)];
    const sel = input.selection;
    const hov = input.hover;
    sigParts.push(sel?.kind === 'association' || sel?.kind === 'link' ? `${sel.kind}:${sel.id}` : '');
    sigParts.push(hov?.kind === 'association' || hov?.kind === 'link' ? `${hov.kind}:${hov.id}` : '');
    for (const a of assocs) {
      const gm = this.assocGeom.get(a.id);
      if (!gm) continue;
      sigParts.push(`${a.id}|${r(gm.a)}|${r(gm.b)}|${a.state}|${a.authorized ? 1 : 0}|${a.bars}|${a.rssiDbm}|${a.holdUntil !== undefined ? 1 : 0}`);
    }
    for (const id of liveBeams) {
      const link = layout.links.get(id);
      const bv = this.beamViews.get(id);
      if (!link || !bv?.geom) continue;
      sigParts.push(`${id}|${r(bv.geom.p0)}|${r(bv.geom.p3)}|${link.up ? 1 : 0}|${link.radio?.bars ?? ''}|${link.radio?.distanceM ?? ''}|${link.radio?.channel ?? ''}`);
    }
    const sig = sigParts.join(';');
    if (sig === this.sig) {
      this.cullTexts(view);
      return;
    }
    this.sig = sig;

    const g = this.lines;
    const glyphs = this.glyphs;
    g.clear();
    glyphs.clear();

    // ── associations
    const seen = new Set<string>();
    for (const a of assocs) {
      const gm = this.assocGeom.get(a.id);
      if (!gm || (!overlays.associationLines && !overlays.signalBars)) continue;
      const bounds = inflateRect(geomBounds(straightGeometry(gm.a, gm.b)), 20);
      if (!rectsIntersect(bounds, view)) continue;
      seen.add(a.id);
      let av = this.assocViews.get(a.id);
      if (!av) {
        av = new AssocView(theme);
        this.assocViews.set(a.id, av);
        this.labels.addChild(av.phase, av.signal);
      }
      av.a = gm.a;
      av.b = gm.b;
      const selected = sameAssoc(sel, a.id);
      const hovered = sameAssoc(hov, a.id);
      const phase = phaseBadge(a.state);
      const color = a.tech === 'cellular' ? theme.purple : theme.accent;

      if (overlays.associationLines) {
        if (selected || hovered) {
          g.moveTo(gm.a.x, gm.a.y).lineTo(gm.b.x, gm.b.y).stroke({ width: (selected ? 9 : 7) * pxq, color: theme.accent, alpha: selected ? 0.28 : 0.15, cap: 'round' });
        }
        strokeDashedLine(g, gm.a, gm.b, assocDash(a.state, a.authorized).map((v) => v * pxq));
        g.stroke({ width: (selected ? 2.4 : 1.6) * pxq, color, alpha: phase.failed ? 0.6 : 0.9, cap: 'butt' });

        const mid = { x: (gm.a.x + gm.b.x) / 2, y: (gm.a.y + gm.b.y) / 2 };
        const showPhase = !phase.final || showText || selected;
        av.phase.visible = showPhase && input.lod !== 'far';
        if (av.phase.visible) {
          if (phase.failed) {
            drawDownBadge(glyphs, mid.x, mid.y, theme);
            av.phase.visible = false;
          } else {
            setText(av.phase, phase.text, theme.text, theme.sans, input.textResolution);
            const w = Math.max(14, av.phase.width + 6);
            glyphs.roundRect(mid.x - (w / 2) * pxq, mid.y - 6 * pxq, w * pxq, 12 * pxq, 6 * pxq).fill({ color: theme.panel, alpha: 0.95 }).stroke({ width: pxq, color });
            av.phase.position.set(mid.x, mid.y);
            av.phase.scale.set(pxq);
          }
        }
      } else {
        av.phase.visible = false;
      }

      if (overlays.signalBars && input.lod !== 'far' && (phase.final || a.state === 'handshake' || a.state === 'associating' || a.state === 'attaching')) {
        // bars glyph just beside the station antenna, on the side away from the AP
        const dx = gm.b.x - gm.a.x;
        const side = dx >= 0 ? -1 : 1;
        const unit = pxq;
        const gx = gm.a.x + side * 8 * unit - (side < 0 ? 12 * unit : 0);
        const gy = gm.a.y - 4 * unit;
        drawBars(glyphs, gx, gy, a.bars, unit, theme);
        av.signal.visible = showText;
        if (showText) {
          setText(av.signal, signalText(a.rssiDbm, a.holdUntil !== undefined), theme.textDim, theme.mono, input.textResolution);
          av.signal.anchor.set(side < 0 ? 1 : 0, 1);
          av.signal.position.set(side < 0 ? gx - 2 * unit : gx + 16 * unit, gy);
          av.signal.scale.set(pxq);
        }
      } else {
        av.signal.visible = false;
      }
    }
    for (const [id, av] of this.assocViews) {
      if (!seen.has(id)) {
        av.phase.destroy();
        av.signal.destroy();
        this.assocViews.delete(id);
      }
    }

    // ── PtP beams
    for (const id of liveBeams) {
      const link = layout.links.get(id);
      const bv = this.beamViews.get(id);
      if (!link || !bv) continue;
      const geom = bv.geom;
      bv.text.visible = false;
      if (!geom || !rectsIntersect(inflateRect(geomBounds(geom), 20), view)) continue;
      const selected = sameLink(sel, id);
      const hovered = sameLink(hov, id);
      const a = geom.p0;
      const b = geom.p3;
      if (selected || hovered) {
        g.moveTo(a.x, a.y).lineTo(b.x, b.y).stroke({ width: (selected ? 12 : 9) * pxq, color: theme.accent, alpha: selected ? 0.28 : 0.15, cap: 'round' });
      }
      if (overlays.radioBeams) {
        strokeDashedLine(g, a, b, [16, 5, 3, 5].map((v) => v * pxq));
        g.stroke({ width: 3.2 * pxq, color: theme.accent, alpha: link.up ? 0.95 : 0.45, cap: 'butt' });
        const mid = bezierAt(geom, 0.5);
        if (!link.up) drawDownBadge(glyphs, mid.x, mid.y, theme);
        const radio = link.radio;
        if (radio && input.lod !== 'far') {
          drawBars(glyphs, mid.x - 6.5 * pxq, mid.y - 9 * pxq, radio.bars, pxq, theme);
          if (showText || selected) {
            const band = radio.band === 'cell' ? 'cellular' : `${radio.band} GHz ch ${radio.channel}`;
            setText(bv.text, `${distanceLabel(radio.distanceM)} · ${band} · ${Math.round(radio.rssiDbm)} dBm`, theme.textDim, theme.mono, input.textResolution);
            bv.text.position.set(mid.x, mid.y - 13 * pxq);
            bv.text.scale.set(pxq);
            bv.text.visible = true;
          }
        }
      } else {
        strokeDashedLine(g, a, b, [2, 5].map((v) => v * pxq));
        g.stroke({ width: 1.2 * pxq, color: theme.textDim, alpha: 0.8, cap: 'butt' });
      }
    }
  }

  /** Hide text of associations and beams far outside the view (the Graphics are cheap to keep). */
  private cullTexts(view: Rect): void {
    for (const av of this.assocViews.values()) {
      const inside = rectsIntersect(inflateRect(geomBounds(straightGeometry(av.a, av.b)), 20), view);
      if (!inside) {
        av.phase.visible = false;
        av.signal.visible = false;
      }
    }
  }

  /** Straight station ↔ AP segment of an association (for drop markers). */
  assocGeometry(id: string): CableGeom | undefined {
    const gm = this.assocGeom.get(id);
    return gm ? straightGeometry(gm.a, gm.b) : undefined;
  }

  /** Beam of a PtP radio link (for packets and markers). */
  beamGeometry(id: LinkId): CableGeom | undefined {
    return this.beamViews.get(id)?.geom;
  }

  /** Association line or radio beam within `tol` world units of the point (beams win ties). */
  hit(wx: number, wy: number, tol: number, overlays: WirelessOverlayState): { kind: 'association'; id: string } | { kind: 'link'; id: LinkId } | undefined {
    let best: { kind: 'association'; id: string } | { kind: 'link'; id: LinkId } | undefined;
    let bestD = tol * tol;
    for (const [id, bv] of this.beamViews) {
      if (!bv.geom) continue;
      const d = distSqToSegment(wx, wy, bv.geom.p0, bv.geom.p3);
      if (d <= bestD) {
        bestD = d;
        best = { kind: 'link', id };
      }
    }
    if (best || !overlays.associationLines) return best;
    for (const [id, gm] of this.assocGeom) {
      const d = distSqToSegment(wx, wy, gm.a, gm.b);
      if (d <= bestD) {
        bestD = d;
        best = { kind: 'association', id };
      }
    }
    return best;
  }

  destroy(): void {
    for (const av of this.assocViews.values()) {
      av.phase.destroy();
      av.signal.destroy();
    }
    for (const bv of this.beamViews.values()) bv.text.destroy();
    this.assocViews.clear();
    this.beamViews.clear();
    this.assocGeom.clear();
    this.lines.destroy();
    this.glyphs.destroy();
  }
}
