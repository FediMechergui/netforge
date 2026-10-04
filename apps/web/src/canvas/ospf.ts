/**
 * canvas/ospf.ts — [S1] the OSPF overlay layer (ARCHITECTURE-P3 §6, §3.1, §3.2; spec §9.6 "OSPF": areas as translucent
 * zones, adjacency links weighted, state on the cables). @since P3 (W3 web-canvas).
 *
 * Draws the render model of `canvas/overlays/ospf-model.ts` (built from the `ospf-interfaces` and `ospf-neighbors` rows
 * only):
 *
 * - the ADJACENCY UNDERLAY per cable, below the cables: thick when the adjacency is FULL; thin with a `2W` chip at the
 *   cable's middle at 2-Way (two DROthers on a LAN stay there); thin with an `IN` / `XS` / `XC` / `LD` chip while the
 *   adjacency is being built, the chip ringed by a slow pulse (a static ring under reduced motion); nothing when there
 *   is no neighbour;
 * - at each OSPF port anchor ONE BADGE: the `DR` / `BDR` letters on a multi-access segment, the cost chip `c64`, `P` for
 *   a passive interface and `!` (with a heavier red border) when the last hello from a neighbour was refused; a
 *   DRAINING BAR under the badge while the interface is Waiting (the fraction of the 40 s wait still to run);
 * - AREA ZONES: a translucent hull around the devices with an interface in each area, labelled `Area 0` by a chip at
 *   its top-left corner (the label is the non-colour channel; each area also has its own tint). A selected area
 *   (`topoOverlays.ospfArea`) keeps only its own zone and marks: the model already filtered them.
 *
 * Every encoding keeps a non-colour channel (chip text, letters, glyphs, underlay thickness); nothing is a dash
 * pattern (P2 D20). Two Pixi containers, like `StpLayer`: the underlay (the registry's `ospf` topology container) and
 * `labels`. The pure helpers (geometry, text forms) have no Pixi dependency; the keyboard outline reads the text forms
 * so every fact drawn here is also said (`ospfPortFacts`, `ospfDeviceFacts`, `ospfLinkFacts`).
 */
import { Container, Graphics, type Text } from 'pixi.js';
import { portKey, type DeviceId, type LinkId, type OspfAreaId, type OspfNsmState } from '@netforge/engine';
import { bezierAt, geomBounds, sampleBezier, type CableGeom, type Pt } from './cables';
import type { OverlayFact } from './l2';
import { OSPF_REFUSED_GLYPH, areaLabel, type OspfAreaZone, type OspfLinkMark, type OspfLinkWeight, type OspfOverlayModel, type OspfPortMark } from './overlays/ospf-model';
import { deviceBounds, type DeviceGeom, type Layout, type PortAnchor } from './ports';
import { inflateRect, makeText, rectsIntersect, setText, viewKey, type Lod, type Rect, type ThemeColors } from './scene';
import { drainBarRect } from './stp';

// ── geometry ─────────────────────────────────────────────────────────────────

/** World units the port badge sits out of its port along the cable. */
export const OSPF_BADGE_INSET = 16;
/** World units an area zone keeps around each member device's body and name block. */
export const ZONE_PAD = 18;
/** Underlay width of a FULL adjacency (world units at zoom quantum 1). */
export const ADJ_THICK_WIDTH = 9;
/** Underlay width of a 2-Way or forming adjacency. */
export const ADJ_THIN_WIDTH = 3.5;
/** Period of the forming-chip pulse, wall-clock milliseconds. */
export const OSPF_CHIP_PULSE_MS = 1_400;

/** Where a port's badge sits. */
export function ospfBadgePoint(anchor: Pick<PortAnchor, 'x' | 'y' | 'nx' | 'ny'>, pxq = 1): Pt {
  return { x: anchor.x + anchor.nx * OSPF_BADGE_INSET * pxq, y: anchor.y + anchor.ny * OSPF_BADGE_INSET * pxq };
}

/** Where a cable's state chip sits: the cable's middle. */
export function linkChipPoint(geom: CableGeom): Pt {
  return bezierAt(geom, 0.5);
}

/** Underlay width of an adjacency weight: thick when FULL, thin at 2-Way or while forming, none otherwise. */
export function adjacencyWidth(weight: OspfLinkWeight, pxq = 1): number {
  if (weight === 'thick') return ADJ_THICK_WIDTH * pxq;
  if (weight === 'thin') return ADJ_THIN_WIDTH * pxq;
  return 0;
}

/**
 * Alpha of a forming chip's ring at wall time `wallMs`: a slow breath between 0.35 and 1; a constant 1 under reduced
 * motion, where the ring is static.
 */
export function ospfChipPulseAlpha(wallMs: number, reducedMotion: boolean): number {
  if (reducedMotion) return 1;
  const phase = (((wallMs % OSPF_CHIP_PULSE_MS) + OSPF_CHIP_PULSE_MS) % OSPF_CHIP_PULSE_MS) / OSPF_CHIP_PULSE_MS;
  return 0.675 + 0.325 * Math.cos(phase * 2 * Math.PI);
}

/** The one badge text at a port anchor: role letters, cost chip, `P`, `!` — `DR c1`, `c64`, `c1 P`, `BDR c10 !`. */
export function ospfPortBadge(mark: Pick<OspfPortMark, 'role' | 'costChip' | 'passiveGlyph' | 'refused'>): string {
  const parts: string[] = [];
  if (mark.role !== '') parts.push(mark.role);
  parts.push(mark.costChip);
  if (mark.passiveGlyph !== '') parts.push(mark.passiveGlyph);
  if (mark.refused !== undefined) parts.push(mark.refused.glyph);
  return parts.join(' ');
}

/** True when the model has an interface that is Waiting, so the canvas must rebuild it every frame for the bars. */
export function ospfModelNeedsClock(model: OspfOverlayModel | null): boolean {
  return model !== null && model.ports.some((p) => p.drain !== undefined);
}

/** The convex hull (counter-clockwise in y-down space, no repeated point) of `points` (Andrew's monotone chain). */
export function convexHull(points: readonly Pt[]): Pt[] {
  const pts = [...points].sort((a, b) => a.x - b.x || a.y - b.y);
  const uniq: Pt[] = [];
  for (const p of pts) {
    const last = uniq[uniq.length - 1];
    if (last === undefined || last.x !== p.x || last.y !== p.y) uniq.push(p);
  }
  if (uniq.length <= 2) return uniq;
  const cross = (o: Pt, a: Pt, b: Pt): number => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lower: Pt[] = [];
  for (const p of uniq) {
    while (lower.length >= 2 && cross(lower[lower.length - 2] as Pt, lower[lower.length - 1] as Pt, p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper: Pt[] = [];
  for (let i = uniq.length - 1; i >= 0; i--) {
    const p = uniq[i] as Pt;
    while (upper.length >= 2 && cross(upper[upper.length - 2] as Pt, upper[upper.length - 1] as Pt, p) <= 0) upper.pop();
    upper.push(p);
  }
  lower.pop();
  upper.pop();
  return [...lower, ...upper];
}

/** An area zone's outline on a layout: the hull of its drawn devices' padded boxes, and that hull's bounds. */
export interface ZoneShape {
  readonly area: OspfAreaId;
  readonly label: string;
  readonly hull: readonly Pt[];
  readonly bounds: Rect;
  /** Where the `Area 0` chip's left edge and baseline sit. */
  readonly labelAt: Pt;
}

/** The padded box corners of one device (its body and name block grown by `pad`). */
function paddedCorners(g: DeviceGeom, pad: number): Pt[] {
  const b = inflateRect(deviceBounds(g, false), pad);
  return [
    { x: b.minX, y: b.minY },
    { x: b.maxX, y: b.minY },
    { x: b.maxX, y: b.maxY },
    { x: b.minX, y: b.maxY },
  ];
}

/**
 * The zones' shapes on a layout, in zone order. A zone whose devices are not drawn has no shape. Each label sits on
 * the top-left corner of its zone's bounds; a label that would land on an earlier one moves up a row.
 */
export function zoneShapes(zones: readonly OspfAreaZone[], layout: Pick<Layout, 'devices'>, pxq = 1): ZoneShape[] {
  const out: ZoneShape[] = [];
  const pad = ZONE_PAD;
  for (const z of zones) {
    const corners: Pt[] = [];
    for (const id of z.devices) {
      const g = layout.devices.get(id);
      if (g !== undefined) corners.push(...paddedCorners(g, pad));
    }
    if (corners.length === 0) continue;
    const hull = convexHull(corners);
    let minX = Number.POSITIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;
    for (const p of hull) {
      minX = Math.min(minX, p.x);
      minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x);
      maxY = Math.max(maxY, p.y);
    }
    let labelAt: Pt = { x: minX + 4 * pxq, y: minY - 3 * pxq };
    for (let guard = 0; guard < out.length + 1; guard++) {
      const clash = out.find((o) => Math.abs(o.labelAt.x - labelAt.x) < 56 * pxq && Math.abs(o.labelAt.y - labelAt.y) < 13 * pxq);
      if (clash === undefined) break;
      labelAt = { x: labelAt.x, y: clash.labelAt.y - 14 * pxq };
    }
    out.push({ area: z.area, label: z.label, hull, bounds: { minX, minY, maxX, maxY }, labelAt });
  }
  return out;
}

/** The tint of an area: its index in the model's area list picks a theme hue (the chip text is the real channel). */
export function areaHue(area: OspfAreaId, areas: readonly OspfAreaId[], theme: ThemeColors): number {
  const hues = [theme.accent, theme.purple, theme.yellow, theme.ok, theme.blueDeep, theme.warn];
  const i = Math.max(0, areas.indexOf(area));
  return hues[i % hues.length] ?? theme.accent;
}

// ── text forms (the keyboard outline) ────────────────────────────────────────

/** Words of the neighbour states (RFC 2328 names). */
export const OSPF_NBR_WORD: Readonly<Record<OspfNsmState, string>> = Object.freeze({
  down: 'Down',
  attempt: 'Attempt',
  init: 'Init',
  '2way': '2-Way',
  exstart: 'ExStart',
  exchange: 'Exchange',
  loading: 'Loading',
  full: 'Full',
});

const ISM_WORD: Readonly<Record<string, string>> = Object.freeze({
  down: 'down',
  loopback: 'loopback',
  waiting: 'waiting for the DR election',
  'point-to-point': 'point-to-point',
  drother: 'DROther',
  backup: 'backup designated router (BDR)',
  dr: 'designated router (DR)',
});

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * "OSPF Area 0: designated router (DR), cost 1, passive, 2 neighbours, 2 adjacent, 50% of the wait left; hello from
 * 2.2.2.2 (10.0.12.2) refused: hello interval 5 does not match 10".
 */
export function describeOspfPort(m: OspfPortMark): string {
  let text = `OSPF ${areaLabel(m.area)}: ${ISM_WORD[m.state] ?? m.state}, cost ${m.cost}`;
  if (m.passive) text += ', passive';
  text += `, ${plural(m.neighbors, 'neighbour', 'neighbours')}, ${m.adjacent} adjacent`;
  if (m.drain !== undefined) text += `, ${Math.round(m.drain * 100)}% of the wait left`;
  if (m.refused !== undefined) text += `; hello from ${m.refused.routerId} (${m.refused.from}) refused: ${m.refused.reason}`;
  return text;
}

/** Text facts of the OSPF overlay per port (`portKey`). */
export function ospfPortFacts(model: OspfOverlayModel | null): ReadonlyMap<string, OverlayFact> {
  const out = new Map<string, OverlayFact>();
  if (model === null) return out;
  for (const m of model.ports) out.set(portKey({ device: m.device, port: m.port }), { short: ospfPortBadge(m), text: describeOspfPort(m) });
  return out;
}

/** Text facts per device: the areas it has an interface in (two or more: an area border router). */
export function ospfDeviceFacts(model: OspfOverlayModel | null): ReadonlyMap<DeviceId, OverlayFact> {
  const out = new Map<DeviceId, OverlayFact>();
  if (model === null) return out;
  const areas = new Map<DeviceId, string[]>();
  for (const z of model.zones) for (const d of z.devices) areas.set(d, [...(areas.get(d) ?? []), z.label]);
  const refused = new Map<DeviceId, number>();
  for (const p of model.ports) if (p.refused !== undefined) refused.set(p.device, (refused.get(p.device) ?? 0) + 1);
  for (const [device, labels] of areas) {
    const shorts = [labels.join(' · ')];
    let text = `OSPF in ${labels.join(' and ')}`;
    if (labels.length > 1 && model.area === null) text += ' (area border router)';
    const n = refused.get(device) ?? 0;
    if (n > 0) {
      shorts.push(OSPF_REFUSED_GLYPH);
      text += `, ${plural(n, 'interface refuses', 'interfaces refuse')} a neighbour's hellos`;
    }
    out.set(device, { short: shorts.join(' '), text });
  }
  return out;
}

/** The short and sentence forms of one cable's adjacency. */
export function describeOspfLink(mark: OspfLinkMark): OverlayFact {
  if (mark.state === 'none') return { short: 'no adjacency', text: 'no OSPF adjacency: the cable is down' };
  if (mark.state === 'down') return { short: 'no neighbour', text: 'no OSPF neighbour across this cable' };
  if (mark.state === 'full') return { short: 'FULL', text: 'OSPF adjacency Full' };
  if (mark.state === '2way') return { short: mark.chip, text: 'OSPF neighbours at 2-Way, no adjacency (neither is the DR or the BDR)' };
  return { short: mark.chip, text: `OSPF adjacency forming: ${OSPF_NBR_WORD[mark.state] ?? mark.state}` };
}

/** Text facts per link: the adjacency the cable shows. */
export function ospfLinkFacts(model: OspfOverlayModel | null): ReadonlyMap<LinkId, OverlayFact> {
  const out = new Map<LinkId, OverlayFact>();
  if (model === null) return out;
  for (const l of model.links) out.set(l.link, describeOspfLink(l));
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

interface PulseSite {
  x: number;
  y: number;
  w: number;
}

export interface OspfSyncInput {
  /** The registry's render model, or null when the overlay is off. */
  model: OspfOverlayModel | null;
  layout: Layout;
  theme: ThemeColors;
  zoom: number;
  lod: Lod;
  view: Rect;
  textResolution: number;
  /** Wall clock (ms); unused by the drawing itself (the pulse runs in `animate`), kept for the common layer input. */
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

export class OspfLayer {
  private readonly ground = new Graphics();
  private readonly glyphs = new Graphics();
  private readonly pulse = new Graphics();
  private readonly badges = new Map<string, BadgeView>();
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

  sync(input: OspfSyncInput): void {
    const { model, layout, theme } = input;
    const gen = ++this.generation;
    const view = inflateRect(input.view, 80 / Math.max(input.zoom, 1e-3));
    const zoomBucket = Math.round(Math.log2(Math.max(input.zoom, 1e-3)) * 4);
    const pxq = 1 / 2 ** (zoomBucket / 4);

    const r = (p: Pt): string => `${Math.round(p.x)},${Math.round(p.y)}`;
    const parts: string[] = [String(theme.stamp), viewKey(input.view, input.zoom), input.lod, String(input.textResolution)];
    if (model !== null) {
      parts.push(String(model.area), model.areas.join(','));
      for (const z of model.zones) {
        const at = z.devices.map((d) => {
          const g = layout.devices.get(d);
          return g === undefined ? '-' : `${r(g)}`;
        });
        parts.push(`Z${z.area}|${at.join('|')}`);
      }
      for (const l of model.links) {
        const geom = input.cableGeometry(l.link);
        parts.push(`L${l.link}|${geom ? `${r(geom.p0)}|${r(geom.p3)}` : '-'}|${l.weight}|${l.chip}|${l.pulse ? 1 : 0}`);
      }
      for (const p of model.ports) {
        const anchor = layout.edge.get(portKey({ device: p.device, port: p.port }));
        parts.push(`P${p.device}/${p.port}|${anchor ? r(anchor) : '-'}|${ospfPortBadge(p)}|${p.drain === undefined ? '' : Math.round(p.drain * 40)}`);
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
      const showText = input.lod !== 'far';
      // area zones (under the underlay)
      for (const z of zoneShapes(model.zones, layout, pxq)) {
        if (!rectsIntersect(z.bounds, view)) continue;
        const hue = areaHue(z.area, model.areas, theme);
        const flat: number[] = [];
        for (const p of z.hull) flat.push(p.x, p.y);
        if (flat.length >= 6) g.poly(flat, true).fill({ color: hue, alpha: 0.07 }).stroke({ width: 1.2 * pxq, color: hue, alpha: 0.45, join: 'round' });
        if (!showText) continue;
        const badge = this.badge(`zone:${z.area}`, theme, 8, false, gen);
        setText(badge.text, z.label, theme.text, theme.sans, input.textResolution);
        badge.text.anchor.set(0, 1);
        badge.text.scale.set(1);
        const w = badge.text.width + 8;
        glyphs
          .roundRect(z.labelAt.x - 4 * pxq, z.labelAt.y - 12 * pxq, w * pxq, 13 * pxq, 4 * pxq)
          .fill({ color: theme.panel, alpha: 0.95 })
          .stroke({ width: 1.2 * pxq, color: hue, alpha: 0.9 });
        badge.text.position.set(z.labelAt.x, z.labelAt.y);
        badge.text.scale.set(pxq);
        badge.text.visible = true;
      }
      // the adjacency underlay and the state chips
      for (const l of model.links) {
        const width = adjacencyWidth(l.weight, pxq);
        if (width === 0) continue;
        const geom = input.cableGeometry(l.link);
        if (!geom || !rectsIntersect(inflateRect(geomBounds(geom), 20), view)) continue;
        if (tracePolyline(g, sampleBezier(geom, 24))) {
          g.stroke({ width, color: l.weight === 'thick' ? theme.ok : l.chip === '2W' ? theme.textDim : theme.warn, alpha: l.weight === 'thick' ? 0.55 : 0.6, cap: 'round', join: 'round' });
        }
        if (!showText || l.chip === '') continue;
        const at = linkChipPoint(geom);
        const badge = this.badge(`link:${l.link}`, theme, 8, true, gen);
        setText(badge.text, l.chip, theme.text, theme.mono, input.textResolution);
        badge.text.anchor.set(0.5);
        badge.text.scale.set(1);
        const w = Math.max(18, badge.text.width + 8);
        glyphs
          .roundRect(at.x - (w / 2) * pxq, at.y - 6.5 * pxq, w * pxq, 13 * pxq, 6.5 * pxq)
          .fill({ color: theme.panel, alpha: 0.96 })
          .stroke({ width: 1.2 * pxq, color: l.chip === '2W' ? theme.border : theme.warn });
        badge.text.position.set(at.x, at.y);
        badge.text.scale.set(pxq);
        badge.text.visible = true;
        if (l.pulse) this.pulseSites.push({ x: at.x, y: at.y, w });
      }
      // the port badges and the draining bars
      for (const p of model.ports) {
        if (!showText) break;
        const anchor = layout.edge.get(portKey({ device: p.device, port: p.port }));
        if (anchor === undefined) continue;
        const at = ospfBadgePoint(anchor, pxq);
        if (at.x < view.minX || at.x > view.maxX || at.y < view.minY || at.y > view.maxY) continue;
        const badge = this.badge(`port:${p.device}/${p.port}`, theme, 8, true, gen);
        const refused = p.refused !== undefined;
        setText(badge.text, ospfPortBadge(p), refused ? theme.err : theme.text, theme.mono, input.textResolution);
        badge.text.anchor.set(0.5);
        badge.text.scale.set(1);
        const w = Math.max(14, badge.text.width + 6);
        const stroke = refused ? theme.err : p.role === 'DR' ? theme.ok : p.role === 'BDR' ? theme.accent : theme.border;
        glyphs
          .roundRect(at.x - (w / 2) * pxq, at.y - 6 * pxq, w * pxq, 12 * pxq, 3 * pxq)
          .fill({ color: theme.panel, alpha: 0.95 })
          .stroke({ width: (refused || p.role !== '' ? 1.8 : 1) * pxq, color: stroke });
        badge.text.position.set(at.x, at.y);
        badge.text.scale.set(pxq);
        badge.text.visible = true;
        if (p.drain !== undefined) {
          const bar = drainBarRect(at, p.drain, pxq);
          glyphs.rect(bar.x, bar.y, bar.w, bar.h).fill({ color: theme.panel, alpha: 0.95 }).stroke({ width: 0.8 * pxq, color: theme.border });
          if (bar.fillW > 0) glyphs.rect(bar.x, bar.y, bar.fillW, bar.h).fill({ color: theme.warn });
        }
      }
    }

    for (const [key, badge] of this.badges) {
      if (badge.seen !== gen) {
        badge.text.destroy();
        this.badges.delete(key);
      }
    }
    if (this.pulseSites.length === 0) this.pulse.clear();
  }

  /**
   * Breathe the rings of the forming chips. Returns true while something animates (so the canvas keeps rendering);
   * under reduced motion the ring is drawn once, static, and the layer goes quiet.
   */
  animate(wall: number, reducedMotion: boolean, theme: ThemeColors): boolean {
    if (this.pulseSites.length === 0) return false;
    if (reducedMotion && this.pulseDrawn) return false;
    const g = this.pulse;
    g.clear();
    const alpha = ospfChipPulseAlpha(wall, reducedMotion);
    const pxq = this.pulsePxq;
    for (const s of this.pulseSites) {
      g.roundRect(s.x - (s.w / 2 + 3) * pxq, s.y - 9.5 * pxq, (s.w + 6) * pxq, 19 * pxq, 9.5 * pxq).stroke({ width: 1.6 * pxq, color: theme.warn, alpha });
    }
    this.pulseDrawn = true;
    return !reducedMotion;
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
    this.pulseSites = [];
    this.ground.destroy();
    this.glyphs.destroy();
    this.pulse.destroy();
  }
}
