/**
 * canvas/l2.ts — the VLAN overlay layer (ARCHITECTURE-P2 §6, D20; spec §9.6). @since P2 (W3 web-canvas).
 *
 * Draws the render model of `canvas/overlays/l2-model.ts` (built by the registry from the `topoOverlays` slice and
 * the snapshot's `PortSnapshot.l2` views, D20):
 *
 * - an ACCESS end tints the first part of its cable in the VLAN's colour (`vlanColor`, a fixed hue per VLAN id) and
 *   carries a chip at its port anchor: `V10` (the number badge is the non-colour channel; two VLANs are told apart by
 *   their numbers, never by tint alone);
 * - a TRUNK end draws a rail under the whole cable (a wide neutral track with ticks, never a dash pattern) and a chip
 *   `T 10,20 · N99`;
 * - the two ends of a link that DISAGREE (native VLANs differ, trunk against access, two access VLANs) pulse and
 *   carry a `!` glyph on both chips; under reduced motion the pulse is a static ring;
 * - with a VLAN focus everything that does not carry the VLAN is dimmed.
 *
 * Two Pixi containers: the underlay (`scene.layers.vlan`, below the cables: tints and rails) and the `labels`
 * container (above the devices: chips and pulses), like `AirLayer`. Every cross-module constant is read at call time
 * (§0 rule 12). The pure helpers (colours, chip geometry, text forms) have no Pixi dependency and are what the tests
 * and the keyboard outline (`a11y/CanvasOutline.tsx`) use: every fact the overlay draws has a text form here.
 */
import { Container, Graphics, type Text } from 'pixi.js';
import { portKey, type DeviceId, type LinkId, type PortRef } from '@netforge/engine';
import { bezierAt, geomBounds, sampleBezier, type CableGeom, type Pt } from './cables';
import { formatVlanRanges, isAllVlans, vlanHue, type DeviceL2, type L2End, type L2OverlayModel, type L2PortMark } from './overlays/l2-model';
import type { Layout, PortAnchor } from './ports';
import { inflateRect, makeText, rectsIntersect, setText, viewKey, type Lod, type Rect, type ThemeColors } from './scene';

// ── colours ──────────────────────────────────────────────────────────────────

/** HSL (h in degrees, s and l in 0..1) → 0xRRGGBB. */
export function hslToRgb(h: number, s: number, l: number): number {
  const hue = (((h % 360) + 360) % 360) / 360;
  const sat = Math.min(1, Math.max(0, s));
  const lum = Math.min(1, Math.max(0, l));
  const q = lum < 0.5 ? lum * (1 + sat) : lum + sat - lum * sat;
  const p = 2 * lum - q;
  const channel = (t0: number): number => {
    let t = t0;
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  const to255 = (v: number): number => Math.round(v * 255);
  return (to255(channel(hue + 1 / 3)) << 16) | (to255(channel(hue)) << 8) | to255(channel(hue - 1 / 3));
}

/** Relative luminance (0..1) of an 0xRRGGBB colour (sRGB, WCAG formula). */
export function relativeLuminance(rgb: number): number {
  const lin = (c: number): number => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin((rgb >> 16) & 0xff) + 0.7152 * lin((rgb >> 8) & 0xff) + 0.0722 * lin(rgb & 0xff);
}

/** True when the theme paints on a dark background (tints are then lighter). */
export function isDarkTheme(theme: Pick<ThemeColors, 'bg'>): boolean {
  return relativeLuminance(theme.bg) < 0.4;
}

/** Tint colour of a VLAN: its hue (`vlanHue`, spread by the golden angle) at a saturation and lightness the theme reads. */
export function vlanColor(vlan: number, theme: Pick<ThemeColors, 'bg'>): number {
  return hslToRgb(vlanHue(vlan), 0.62, isDarkTheme(theme) ? 0.56 : 0.42);
}

/** WCAG contrast ratio (1..21) of two colours. */
export function contrastRatio(a: number, b: number): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

const INK_DARK = 0x101418;
const INK_LIGHT = 0xf7f8fa;

/** Text colour that reads on `rgb`: whichever of near-black and near-white contrasts more (always at least 3:1). */
export function contrastText(rgb: number): number {
  return contrastRatio(rgb, INK_DARK) >= contrastRatio(rgb, INK_LIGHT) ? INK_DARK : INK_LIGHT;
}

// ── geometry ─────────────────────────────────────────────────────────────────

/** Fraction of a cable, measured from an access end, that carries that end's tint. */
export const TINT_SPAN = 0.35;
/** World units a chip sits from its port anchor, along the cable's leaving direction. */
export const CHIP_INSET = 15;
/** Alpha of a port, chip or link that the VLAN focus dims. */
export const DIM_ALPHA = 0.22;
/** Rail ticks every this many world units (the rail's non-colour pattern). */
export const RAIL_TICK_STEP = 14;

/** The u-range (0 → link end a, 1 → link end b) of a cable that an access end's tint covers. */
export function tintSpan(end: 'a' | 'b'): readonly [number, number] {
  return end === 'a' ? [0, TINT_SPAN] : [1 - TINT_SPAN, 1];
}

/** Where a chip sits: `inset` units out of the port along the cable's leaving normal. */
export function chipPoint(anchor: Pick<PortAnchor, 'x' | 'y' | 'nx' | 'ny'>, inset = CHIP_INSET): Pt {
  return { x: anchor.x + anchor.nx * inset, y: anchor.y + anchor.ny * inset };
}

/** Width of a trunk rail at a zoom quantum (`pxq` = world units per screen pixel bucket). */
export function railWidth(pxq: number): number {
  return 9 * pxq;
}

/** Width of an access tint band. */
export function tintWidth(pxq: number): number {
  return 6.5 * pxq;
}

/**
 * Alpha of the mismatch pulse at wall time `wall` (ms): a slow breath between 0.35 and 1; a constant 1 under reduced
 * motion, where the ring is static.
 */
export function pulseAlpha(wall: number, reducedMotion: boolean): number {
  if (reducedMotion) return 1;
  return 0.675 + 0.325 * Math.sin(wall / 180);
}

/** Tick positions (u along the cable) of a rail: one every `RAIL_TICK_STEP` world units of the polyline. */
export function railTicks(points: readonly Pt[], step = RAIL_TICK_STEP): Pt[] {
  const out: Pt[] = [];
  let carried = step / 2;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    if (a === undefined || b === undefined) continue;
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if (len === 0) continue;
    let at = carried;
    while (at <= len) {
      const t = at / len;
      out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
      at += step;
    }
    carried = at - len;
  }
  return out;
}

// ── text forms (the keyboard outline) ────────────────────────────────────────

/** A fact of an overlay in text: `short` joins the visible row, `text` the screen-reader sentence. */
export interface OverlayFact {
  readonly short: string;
  readonly text: string;
}

function vlanListText(end: Extract<L2End, { kind: 'trunk' }>): string {
  if (isAllVlans(end.vlans)) return 'all VLANs';
  const text = formatVlanRanges(end.vlans);
  return text === '' ? 'no VLANs' : `VLANs ${text}`;
}

/** The sentence fragment of an L2 end: "access port in VLAN 10", "trunk carrying VLANs 10,20, native VLAN 99". */
export function describeL2End(end: L2End): string {
  if (end.kind === 'access') {
    return end.voice === undefined ? `access port in VLAN ${end.vlan}` : `access port in VLAN ${end.vlan}, voice VLAN ${end.voice}`;
  }
  const native = end.native === null ? 'no native VLAN' : `native VLAN ${end.native}`;
  return end.source === 'subinterfaces'
    ? `routed port with subinterfaces for ${vlanListText(end)}, ${native}`
    : `trunk carrying ${vlanListText(end)}, ${native}`;
}

/** Text facts of the VLAN overlay per port (`portKey`): the end, a mismatch, and the focus dimming. */
export function l2PortFacts(model: L2OverlayModel | null): ReadonlyMap<string, OverlayFact> {
  const out = new Map<string, OverlayFact>();
  if (model === null) return out;
  for (const mark of model.ports) {
    let text = describeL2End(mark.end);
    let short = mark.chip;
    if (mark.mismatch !== undefined) {
      text = `${text}; ${mark.mismatch.text.replace(/\.$/, '')}`;
      short = `${short} ${mark.mismatch.glyph}`;
    }
    if (mark.dimmed) text = `${text}, outside VLAN ${model.focus ?? ''}`.trimEnd();
    out.set(portKey({ device: mark.device, port: mark.port }), { short, text });
  }
  return out;
}

/** Text facts of the VLAN overlay per link: the shared chip, or the disagreement. */
export function l2LinkFacts(model: L2OverlayModel | null): ReadonlyMap<LinkId, OverlayFact> {
  const out = new Map<LinkId, OverlayFact>();
  if (model === null) return out;
  for (const link of model.links) {
    if (link.mismatch !== undefined) {
      out.set(link.link, { short: `${link.mismatch.glyph} VLAN mismatch`, text: link.mismatch.text.replace(/\.$/, '') });
      continue;
    }
    const chip = link.chip ?? [link.a?.chip, link.b?.chip].find((c) => c !== undefined);
    if (chip === undefined) continue;
    const kind = link.rail ? 'trunk' : 'access link';
    out.set(link.link, { short: chip, text: `${kind} ${chip}${link.dimmed ? `, outside VLAN ${model.focus ?? ''}`.trimEnd() : ''}` });
  }
  return out;
}

/**
 * The untagged VLAN a frame leaving `from` belongs to: an access port's VLAN, a trunk's native VLAN; undefined for a
 * port that is not an L2 end (routed ports, hosts, P1 worlds). Packet colouring of untagged legs (packets.ts).
 */
export function untaggedVlanOf(ends: ReadonlyMap<DeviceId, DeviceL2>, from: PortRef): number | undefined {
  const end = ends.get(from.device)?.ends.get(from.port);
  if (end === undefined) return undefined;
  if (end.kind === 'access') return end.vlan;
  return end.native ?? undefined;
}

// ── the layer ────────────────────────────────────────────────────────────────

class ChipView {
  readonly text: Text;
  x = 0;
  y = 0;
  seen = 0;

  constructor(theme: ThemeColors) {
    this.text = makeText('', 8, theme.text, theme.mono, 'bold');
    this.text.anchor.set(0.5);
  }
}

export interface L2SyncInput {
  /** The registry's render model, or null when the overlay is off. */
  model: L2OverlayModel | null;
  layout: Layout;
  theme: ThemeColors;
  zoom: number;
  lod: Lod;
  /** Visible world rectangle. */
  view: Rect;
  textResolution: number;
  /** Cable path of a link (the cable layer's geometry). */
  cableGeometry(link: LinkId): CableGeom | undefined;
}

interface PulseSite {
  x: number;
  y: number;
}

export class L2Layer {
  private readonly ground = new Graphics();
  private readonly glyphs = new Graphics();
  private readonly pulse = new Graphics();
  private readonly chips = new Map<string, ChipView>();
  private readonly labels: Container;
  private pulseSites: PulseSite[] = [];
  private pulsePxq = 1;
  private pulseDrawn = false;
  private sig = '';
  private generation = 0;

  constructor(ground: Container, labels: Container) {
    this.labels = labels;
    ground.addChild(this.ground);
    labels.addChild(this.glyphs, this.pulse);
  }

  sync(input: L2SyncInput): void {
    const { model, layout, theme } = input;
    const gen = ++this.generation;
    const view = inflateRect(input.view, 80 / Math.max(input.zoom, 1e-3));
    const zoomBucket = Math.round(Math.log2(Math.max(input.zoom, 1e-3)) * 4);
    const pxq = 1 / 2 ** (zoomBucket / 4);
    const showChips = input.lod === 'full';

    const r = (p: Pt): string => `${Math.round(p.x)},${Math.round(p.y)}`;
    const parts: string[] = [String(theme.stamp), viewKey(input.view, input.zoom), input.lod, String(input.textResolution)];
    if (model !== null) {
      parts.push(String(model.focus));
      for (const link of model.links) {
        const geom = input.cableGeometry(link.link);
        parts.push(
          `${link.link}|${geom ? `${r(geom.p0)}|${r(geom.p3)}` : '-'}|${link.rail ? 1 : 0}|${link.dimmed ? 1 : 0}|${link.mismatch?.kind ?? ''}|${link.a?.chip ?? ''}|${link.a?.hue ?? ''}|${link.a?.dimmed ? 1 : 0}|${link.b?.chip ?? ''}|${link.b?.hue ?? ''}|${link.b?.dimmed ? 1 : 0}`,
        );
      }
    }
    const sig = parts.join(';');
    if (sig === this.sig) return;
    this.sig = sig;

    const g = this.ground;
    const glyphs = this.glyphs;
    g.clear();
    glyphs.clear();
    this.pulseSites = [];
    this.pulsePxq = pxq;
    this.pulseDrawn = false;

    if (model !== null) {
      for (const link of model.links) {
        const geom = input.cableGeometry(link.link);
        if (!geom || !rectsIntersect(inflateRect(geomBounds(geom), 20), view)) continue;
        const linkAlpha = link.dimmed ? DIM_ALPHA : 1;
        if (link.rail) this.drawRail(g, geom, pxq, theme, linkAlpha);
        const ends: (readonly ['a' | 'b', L2PortMark | undefined])[] = [
          ['a', link.a],
          ['b', link.b],
        ];
        for (const [side, mark] of ends) {
          if (mark === undefined) continue;
          const alpha = mark.dimmed ? DIM_ALPHA : 1;
          if (mark.hue !== null) this.drawTint(g, geom, side, vlanColor(mark.end.kind === 'access' ? mark.end.vlan : 0, theme), pxq, alpha);
          if (!showChips) continue;
          const anchor = layout.edge.get(portKey({ device: mark.device, port: mark.port }));
          if (anchor === undefined) continue;
          const at = chipPoint(anchor, CHIP_INSET * pxq);
          this.drawChip(glyphs, at, mark, pxq, theme, alpha, gen, input.textResolution);
          if (mark.mismatch !== undefined) this.pulseSites.push({ x: at.x, y: at.y });
        }
      }
    }

    for (const [key, chip] of this.chips) {
      if (chip.seen !== gen) {
        chip.text.destroy();
        this.chips.delete(key);
      }
    }
    if (this.pulseSites.length === 0) this.pulse.clear();
  }

  /**
   * Breathe the mismatch pulses. Returns true while something animates (so the canvas keeps rendering); under
   * reduced motion the ring is drawn once and the layer goes quiet.
   */
  animate(wall: number, reducedMotion: boolean, theme: ThemeColors): boolean {
    if (this.pulseSites.length === 0) return false;
    if (reducedMotion && this.pulseDrawn) return false;
    const g = this.pulse;
    g.clear();
    const alpha = pulseAlpha(wall, reducedMotion);
    const pxq = this.pulsePxq;
    for (const s of this.pulseSites) {
      g.circle(s.x, s.y, 13 * pxq).stroke({ width: 2 * pxq, color: theme.err, alpha });
    }
    this.pulseDrawn = true;
    return !reducedMotion;
  }

  private drawRail(g: Graphics, geom: CableGeom, pxq: number, theme: ThemeColors, alpha: number): void {
    const pts = sampleBezier(geom, 24);
    const first = pts[0];
    if (first === undefined) return;
    g.moveTo(first.x, first.y);
    for (let i = 1; i < pts.length; i++) {
      const p = pts[i];
      if (p !== undefined) g.lineTo(p.x, p.y);
    }
    g.stroke({ width: railWidth(pxq), color: theme.panel2, alpha: 0.95 * alpha, cap: 'round', join: 'round' });
    g.moveTo(first.x, first.y);
    for (let i = 1; i < pts.length; i++) {
      const p = pts[i];
      if (p !== undefined) g.lineTo(p.x, p.y);
    }
    g.stroke({ width: railWidth(pxq) + 1.6 * pxq, color: theme.borderStrong, alpha: 0.7 * alpha, cap: 'round', join: 'round' });
    // dots along the rail: the pattern that says "trunk" without colour
    for (const t of railTicks(pts, RAIL_TICK_STEP * pxq)) {
      g.circle(t.x, t.y, 0.9 * pxq);
    }
    g.fill({ color: theme.textDim, alpha: 0.75 * alpha });
  }

  private drawTint(g: Graphics, geom: CableGeom, side: 'a' | 'b', color: number, pxq: number, alpha: number): void {
    const [u0, u1] = tintSpan(side);
    const steps = 8;
    const p0 = bezierAt(geom, u0);
    g.moveTo(p0.x, p0.y);
    for (let i = 1; i <= steps; i++) {
      const p = bezierAt(geom, u0 + ((u1 - u0) * i) / steps);
      g.lineTo(p.x, p.y);
    }
    g.stroke({ width: tintWidth(pxq), color, alpha: 0.85 * alpha, cap: 'round', join: 'round' });
  }

  private drawChip(glyphs: Graphics, at: Pt, mark: L2PortMark, pxq: number, theme: ThemeColors, alpha: number, gen: number, res: number): void {
    const key = portKey({ device: mark.device, port: mark.port });
    let chip = this.chips.get(key);
    if (!chip) {
      chip = new ChipView(theme);
      this.chips.set(key, chip);
      this.labels.addChild(chip.text);
    }
    chip.seen = gen;
    const access = mark.end.kind === 'access';
    const fill = access ? vlanColor(mark.end.vlan, theme) : theme.panel;
    const textColor = access ? contrastText(fill) : theme.text;
    const label = mark.mismatch === undefined ? mark.chip : `${mark.chip} ${mark.mismatch.glyph}`;
    setText(chip.text, label, textColor, theme.mono, res);
    const w = Math.max(16, chip.text.width + 8);
    const h = 12;
    glyphs
      .roundRect(at.x - (w / 2) * pxq, at.y - (h / 2) * pxq, w * pxq, h * pxq, 4 * pxq)
      .fill({ color: fill, alpha: 0.96 * alpha })
      .stroke({ width: (mark.mismatch === undefined ? 1 : 1.8) * pxq, color: mark.mismatch === undefined ? theme.border : theme.err, alpha });
    chip.text.position.set(at.x, at.y);
    chip.text.scale.set(pxq);
    chip.text.alpha = alpha;
    chip.text.visible = true;
    chip.x = at.x;
    chip.y = at.y;
  }

  destroy(): void {
    for (const c of this.chips.values()) c.text.destroy();
    this.chips.clear();
    this.ground.destroy();
    this.glyphs.destroy();
    this.pulse.destroy();
  }
}
