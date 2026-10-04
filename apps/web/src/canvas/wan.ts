/**
 * canvas/wan.ts — [S18]/[S19] and [C13] the WAN overlay layer (ARCHITECTURE-P3 §6, §3.9, §3.10, §3.13; spec §9.5 "PPP
 * LCP/NCP", §9.1 "Pulse: payload is encrypted"). @since P3 (W3 web-canvas).
 *
 * Draws the render model of `canvas/overlays/wan-model.ts` (built from the `ppp`, `tunnels` and `ipsec-sa` rows only):
 *
 * - a PPP PHASE RAIL at each serial cable end with a `ppp` row: four cells `D·E·A·N` a little way out of the port. A
 *   finished step is a filled cell, the current one has a heavy border and an underline, a step still to come is a
 *   faint hollow cell, a failed authentication crosses the `A`, and an `A` nobody asked for (no authentication at
 *   either end) is struck through. Once IPCP is open the last cell reads `N ✓ 10.1.1.2` (the peer's address);
 * - a TUNNEL as a hollow tube on a gentle arc (`airArc`, like the controller tunnels) between the two routers of a
 *   `tunnels` pair, below the cables, labelled at its middle `Tu0 GRE 172.16.0.0/30`; an up tunnel has a solid core
 *   inside the tube, a down one is empty and its label ends with `✗`. [C13] An ipsec-mode tube reads `Tu0 IPsec`, a
 *   padlock before the label and the security association's state word after it (`· established`). A tunnel whose
 *   destination belongs to no drawn device is a short open-ended stub leaving its router, labelled the same way.
 *
 * The legs that cross a tunnel (the `G` badge on a GRE leg, the encrypted pulse of an IPsec leg) belong to the packet
 * layer (`packets.ts`, not this file); the model module gives it `tunnelLegStyle` and `encryptedPulseAlpha`.
 *
 * Every encoding keeps a non-colour channel (letters, fill against hollow, ✓ and ✗, the strike, the padlock, words);
 * nothing is a dash pattern (P2 D20). Two Pixi containers, like `StpLayer`: the underlay (the registry's `wan` topology
 * container: the tubes) and `labels` (rails, tube labels, padlocks). The pure helpers have no Pixi dependency; the
 * keyboard outline reads the text forms (`wanPortFacts`, `wanDeviceFacts`, `wanLinkFacts`).
 */
import { Container, Graphics, type Text } from 'pixi.js';
import { portKey, type DeviceId, type LinkId } from '@netforge/engine';
import { airArc } from './air';
import { bezierAt, geomBounds, sampleBezier, type CableGeom, type Pt } from './cables';
import { boxExit, tunnelBox } from './capwap';
import type { OverlayFact } from './l2';
import {
  PPP_FAILED_GLYPH,
  PPP_RAIL_SEPARATOR,
  type PppRailMark,
  type PppRailStep,
  type PppStepState,
  type TunnelEnd,
  type TunnelTubeMark,
  type WanOverlayModel,
  tunnelReasonText,
} from './overlays/wan-model';
import type { Layout, PortAnchor } from './ports';
import { inflateRect, makeText, rectsIntersect, setText, viewKey, type Lod, type Rect, type ThemeColors } from './scene';

// ── the rail: geometry and style ─────────────────────────────────────────────

/** World units between the port and the rail's near edge. */
export const RAIL_INSET = 14;
/** Width of a letter cell (world units at zoom quantum 1). */
export const RAIL_CELL_W = 11;
/** Height of a rail cell. */
export const RAIL_CELL_H = 12;
/** Gap between two cells (the separator dot sits in it). */
export const RAIL_GAP = 4;
/** Mark of a skipped step in the text forms. */
export const PPP_SKIPPED_TEXT = '–';

/** How one rail cell is drawn: every state differs by shape, not only by colour. */
export interface RailCellStyle {
  /** Solid cell (a finished step). */
  readonly filled: boolean;
  /** Heavy border and an underline (the current step). */
  readonly strong: boolean;
  /** Faint cell and letter (a step still to come, or skipped). */
  readonly faint: boolean;
  /** A cross over the cell (a failed authentication). */
  readonly cross: boolean;
  /** A line through the letter (authentication nobody asked for). */
  readonly strike: boolean;
}

/** The drawing style of a rail step state. */
export function railCellStyle(state: PppStepState): RailCellStyle {
  switch (state) {
    case 'done':
      return { filled: true, strong: false, faint: false, cross: false, strike: false };
    case 'current':
      return { filled: false, strong: true, faint: false, cross: false, strike: false };
    case 'failed':
      return { filled: false, strong: true, faint: false, cross: true, strike: false };
    case 'skipped':
      return { filled: false, strong: false, faint: true, cross: false, strike: true };
    default:
      return { filled: false, strong: false, faint: true, cross: false, strike: false };
  }
}

/** The text of each cell: the letters, the last one replaced by `N ✓ 10.1.1.2` once the network phase is open. */
export function railCellTexts(mark: Pick<PppRailMark, 'steps' | 'label' | 'open'>): string[] {
  const out = mark.steps.map((s) => s.letter);
  if (mark.open && mark.label !== '' && out.length > 0) out[out.length - 1] = mark.label;
  return out;
}

/**
 * Centre of the rail of a port: `RAIL_INSET` out along the cable, pushed further out by half the rail's width when the
 * cable leaves sideways, so the rail never sits on the device's body.
 */
export function railCenter(anchor: Pick<PortAnchor, 'x' | 'y' | 'nx' | 'ny'>, railWidth: number, pxq = 1): Pt {
  const d = RAIL_INSET * pxq + Math.abs(anchor.nx) * (railWidth / 2) + Math.abs(anchor.ny) * (RAIL_CELL_H / 2) * pxq;
  return { x: anchor.x + anchor.nx * d, y: anchor.y + anchor.ny * d };
}

/** Width of a rail whose cells are `widths` wide (world units at quantum `pxq`). */
export function railWidth(widths: readonly number[], pxq = 1): number {
  if (widths.length === 0) return 0;
  return (widths.reduce((s, w) => s + w, 0) + RAIL_GAP * (widths.length - 1)) * pxq;
}

/** The cell rectangles of a rail centred on `center`, left to right. */
export function railCellRects(center: Pt, widths: readonly number[], pxq = 1): Rect[] {
  const total = railWidth(widths, pxq);
  let x = center.x - total / 2;
  const h = RAIL_CELL_H * pxq;
  const out: Rect[] = [];
  for (const w of widths) {
    const ww = w * pxq;
    out.push({ minX: x, minY: center.y - h / 2, maxX: x + ww, maxY: center.y + h / 2 });
    x += ww + RAIL_GAP * pxq;
  }
  return out;
}

/** The short text of one step: the letter, `[E]` for the current step, `A✗` failed, `–` skipped. */
function stepShort(step: PppRailStep): string {
  if (step.state === 'current') return `[${step.letter}]`;
  if (step.state === 'failed') return `${step.letter}${PPP_FAILED_GLYPH}`;
  if (step.state === 'skipped') return PPP_SKIPPED_TEXT;
  return step.letter;
}

/** The rail as one line: `D·[E]·A·N`, `D·E·A✗·N`, `D·E·A·N ✓ 10.1.1.2`, `D·E·–·N ✓ 10.1.1.2`. */
export function shortPppRail(mark: Pick<PppRailMark, 'steps' | 'label' | 'open'>): string {
  const parts = mark.steps.map(stepShort);
  if (mark.open && mark.label !== '' && parts.length > 0) parts[parts.length - 1] = mark.label;
  return parts.join(PPP_RAIL_SEPARATOR);
}

/** "PPP open, peer 10.1.1.2" / "PPP authentication failed, authenticating; last failure: …". */
export function describePppRail(mark: Pick<PppRailMark, 'words' | 'lastFailure'>): string {
  return mark.lastFailure === undefined || mark.lastFailure === '' ? mark.words : `${mark.words}; last failure: ${mark.lastFailure}`;
}

// ── tubes: geometry and text ─────────────────────────────────────────────────

/** Bulge of a tunnel tube (`airArc`'s bend, capped by airArc at 60 world units). */
export const WAN_TUBE_BEND = 0.3;
/** Extra bend for the third and later tubes between the same two routers (the second bulges to the other side). */
export const WAN_TUBE_BEND_STEP = 0.14;
/** Outer width of a tube (world units at zoom quantum 1). */
export const WAN_TUBE_WIDTH = 8;
/** Width of an up tunnel's core. */
export const WAN_CORE_WIDTH = 2.6;
/** Length of a stub tube (a destination no drawn device holds). */
export const WAN_STUB_LEN = 64;
/** Points sampled along a tube. */
export const WAN_TUBE_SAMPLES = 32;

/** A tube's drawn shape. */
export interface TubeShape {
  readonly geom: CableGeom;
  /** Where its label sits (the arc's middle, or just past a stub's open end). */
  readonly labelAt: Pt;
  /** The far end is open: no drawn device holds the destination. */
  readonly stub: boolean;
}

/**
 * Shapes of the tubes on a layout: an arc between both routers' clearance boxes when the far router is drawn (a second
 * tube between the same two routers bulges to the other side, later ones further out), else a stub leaving the router
 * up and to the right (fanning out when it has several). Tubes whose own router is not drawn have no shape.
 */
export function tubeShapes(tubes: readonly TunnelTubeMark[], layout: Pick<Layout, 'devices'>, pxq = 1): ReadonlyMap<string, TubeShape> {
  const out = new Map<string, TubeShape>();
  const perPair = new Map<string, number>();
  const stubs = new Map<DeviceId, number>();
  for (const t of tubes) {
    const ga = layout.devices.get(t.a.device);
    if (ga === undefined) continue;
    const gb = t.toward === null ? undefined : layout.devices.get(t.toward);
    if (gb !== undefined && t.toward !== null) {
      const pair = [t.a.device, t.toward].sort().join('|');
      const k = perPair.get(pair) ?? 0;
      perPair.set(pair, k + 1);
      // the pair's endpoints in a fixed order (sorted ids), so "left of travel" is the same side for both directions
      const [first, second] = t.a.device <= t.toward ? [ga, gb] : [gb, ga];
      const a = boxExit({ x: first.x, y: first.y }, tunnelBox(first), { x: second.x, y: second.y });
      const b = boxExit({ x: second.x, y: second.y }, tunnelBox(second), { x: first.x, y: first.y });
      const bend = WAN_TUBE_BEND + Math.floor(k / 2) * WAN_TUBE_BEND_STEP;
      const geom = k % 2 === 0 ? airArc(a, b, bend) : airArc(b, a, bend);
      out.set(t.key, { geom, labelAt: bezierAt(geom, 0.5), stub: false });
      continue;
    }
    const k = stubs.get(t.a.device) ?? 0;
    stubs.set(t.a.device, k + 1);
    const angle = -Math.PI / 4 + k * (Math.PI / 6);
    const dir = { x: Math.cos(angle), y: Math.sin(angle) };
    const far = { x: ga.x + dir.x * 1000, y: ga.y + dir.y * 1000 };
    const a = boxExit({ x: ga.x, y: ga.y }, tunnelBox(ga), far);
    const end = { x: a.x + dir.x * WAN_STUB_LEN * pxq, y: a.y + dir.y * WAN_STUB_LEN * pxq };
    const geom = airArc(a, end, 0.12);
    out.set(t.key, { geom, labelAt: { x: end.x + dir.x * 10 * pxq, y: end.y + dir.y * 10 * pxq }, stub: true });
  }
  return out;
}

/** The label drawn on a tube: `Tu0 GRE 172.16.0.0/30`, `Tu0 IPsec · established`, with `✗` when it is down. */
export function tubeCaption(t: Pick<TunnelTubeMark, 'label' | 'lock' | 'saWord' | 'up'>): string {
  let text = t.label;
  if (t.lock && t.saWord !== '') text += ` · ${t.saWord}`;
  if (!t.up) text += ` ${PPP_FAILED_GLYPH}`;
  return text;
}

const MODE_WORD: Readonly<Record<string, string>> = Object.freeze({ gre: 'GRE', ipsec: 'IPsec' });

/** "GRE tunnel Tu0 to 209.165.200.230 (R2), up, IP MTU 1476, subnet 172.16.0.0/30". */
export function describeTunnelEnd(
  end: TunnelEnd,
  tube: Pick<TunnelTubeMark, 'a' | 'toward' | 'downText'>,
  name: (id: DeviceId) => string = (id) => id,
): string {
  let text = `${MODE_WORD[end.mode] ?? end.mode} tunnel ${end.short}`;
  if (end.destination !== undefined) text += ` to ${end.destination}`;
  const far = end.device === tube.a.device ? tube.toward : tube.a.device;
  if (far !== null) text += ` (${name(far)})`;
  if (end.state === 'up') text += ', up';
  else {
    const why = end.reason === undefined ? tube.downText : tunnelReasonText(end.reason);
    text += why === '' ? ', down' : `, down: ${why}`;
  }
  text += `, IP MTU ${end.ipMtu}`;
  if (end.subnet !== undefined) text += `, subnet ${end.subnet}`;
  if (end.mode === 'ipsec') text += end.sa === undefined ? ', no security association yet' : `, security association ${end.sa}`;
  return text;
}

// ── text forms (the keyboard outline) ────────────────────────────────────────

/** Text facts per port (`portKey`): each serial end's rail and each tunnel interface's tube. */
export function wanPortFacts(model: WanOverlayModel | null, name: (id: DeviceId) => string = (id) => id): ReadonlyMap<string, OverlayFact> {
  const out = new Map<string, OverlayFact>();
  if (model === null) return out;
  for (const r of model.rails) out.set(portKey({ device: r.device, port: r.port }), { short: shortPppRail(r), text: describePppRail(r) });
  for (const t of model.tubes) {
    for (const end of t.b === undefined ? [t.a] : [t.a, t.b]) {
      out.set(portKey({ device: end.device, port: end.port }), { short: tubeCaption(t), text: describeTunnelEnd(end, t, name) });
    }
  }
  return out;
}

/** Text facts per device: its tunnels, one phrase each ("GRE tunnel Tu0 toward R2, up"). */
export function wanDeviceFacts(model: WanOverlayModel | null, name: (id: DeviceId) => string = (id) => id): ReadonlyMap<DeviceId, OverlayFact> {
  const out = new Map<DeviceId, OverlayFact>();
  if (model === null) return out;
  const shorts = new Map<DeviceId, string[]>();
  const texts = new Map<DeviceId, string[]>();
  for (const t of model.tubes) {
    for (const end of t.b === undefined ? [t.a] : [t.a, t.b]) {
      const other = end === t.a ? t.toward : t.a.device;
      const toward = other === null ? (end.destination === undefined ? '' : ` toward ${end.destination}`) : ` toward ${name(other)}`;
      shorts.set(end.device, [...(shorts.get(end.device) ?? []), `${end.short} ${MODE_WORD[end.mode] ?? end.mode}${end.state === 'up' ? '' : ` ${PPP_FAILED_GLYPH}`}`]);
      texts.set(end.device, [...(texts.get(end.device) ?? []), `${MODE_WORD[end.mode] ?? end.mode} tunnel ${end.short}${toward}, ${end.state}`]);
    }
  }
  for (const [device, s] of shorts) out.set(device, { short: s.join(' · '), text: (texts.get(device) ?? []).join('; ') });
  return out;
}

/** Text facts per serial link: PPP at both ends ("PPP open", "PPP A✗", "PPP D·[E]·A·N"). */
export function wanLinkFacts(model: WanOverlayModel | null, name: (id: DeviceId) => string = (id) => id): ReadonlyMap<LinkId, OverlayFact> {
  const out = new Map<LinkId, OverlayFact>();
  if (model === null) return out;
  const byLink = new Map<LinkId, PppRailMark[]>();
  for (const r of model.rails) if (r.link !== undefined) byLink.set(r.link, [...(byLink.get(r.link) ?? []), r]);
  for (const [link, rails] of byLink) {
    const failed = rails.find((r) => r.authFailed);
    const notOpen = rails.find((r) => !r.open);
    let short: string;
    if (failed !== undefined) short = `PPP A${PPP_FAILED_GLYPH}`;
    else if (notOpen === undefined) short = 'PPP open';
    else short = `PPP ${shortPppRail(notOpen)}`;
    const text = rails.map((r) => `${name(r.device)} ${r.port}: ${describePppRail(r)}`).join('; ');
    out.set(link, { short, text });
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

export interface WanSyncInput {
  /** The registry's render model, or null when the overlay is off. */
  model: WanOverlayModel | null;
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

export class WanLayer {
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

  sync(input: WanSyncInput): void {
    const { model, layout, theme } = input;
    const gen = ++this.generation;
    const view = inflateRect(input.view, 80 / Math.max(input.zoom, 1e-3));
    const zoomBucket = Math.round(Math.log2(Math.max(input.zoom, 1e-3)) * 4);
    const pxq = 1 / 2 ** (zoomBucket / 4);
    const shapes = model === null ? new Map<string, TubeShape>() : tubeShapes(model.tubes, layout, pxq);

    const r = (p: Pt): string => `${Math.round(p.x)},${Math.round(p.y)}`;
    const parts: string[] = [String(theme.stamp), viewKey(input.view, input.zoom), input.lod, String(input.textResolution)];
    if (model !== null) {
      for (const rail of model.rails) {
        const anchor = layout.edge.get(portKey({ device: rail.device, port: rail.port }));
        parts.push(`R${rail.device}/${rail.port}|${anchor ? `${r(anchor)}|${anchor.nx.toFixed(2)},${anchor.ny.toFixed(2)}` : '-'}|${shortPppRail(rail)}`);
      }
      for (const t of model.tubes) {
        const s = shapes.get(t.key);
        parts.push(`T${t.key}|${s ? `${r(s.geom.p0)}|${r(s.geom.p3)}|${s.stub ? 1 : 0}` : '-'}|${tubeCaption(t)}`);
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
      for (const t of model.tubes) {
        const shape = shapes.get(t.key);
        if (shape === undefined || !rectsIntersect(inflateRect(geomBounds(shape.geom), 24), view)) continue;
        this.drawTube(g, shape, t, pxq, theme);
        if (!showText) continue;
        const badge = this.badge(`tube:${t.key}`, theme, 8, false, gen);
        setText(badge.text, tubeCaption(t), t.up ? theme.text : theme.err, theme.sans, input.textResolution);
        badge.text.anchor.set(0.5);
        badge.text.scale.set(1);
        const w = badge.text.width + (t.lock ? 22 : 10);
        const at = shape.labelAt;
        glyphs
          .roundRect(at.x - (w / 2) * pxq, at.y - 7 * pxq, w * pxq, 14 * pxq, 7 * pxq)
          .fill({ color: theme.panel, alpha: 0.96 })
          .stroke({ width: (t.up ? 1.2 : 1.8) * pxq, color: t.up ? theme.borderStrong : theme.err });
        const textX = t.lock ? at.x + 6 * pxq : at.x;
        badge.text.position.set(textX, at.y);
        badge.text.scale.set(pxq);
        badge.text.visible = true;
        if (t.lock) this.drawPadlock(glyphs, { x: at.x - (w / 2 - 8) * pxq, y: at.y }, pxq, theme);
      }
      for (const rail of model.rails) {
        if (!showText) break;
        const anchor = layout.edge.get(portKey({ device: rail.device, port: rail.port }));
        if (anchor === undefined) continue;
        this.drawRail(glyphs, rail, anchor, pxq, theme, gen, input.textResolution, view);
      }
    }

    for (const [key, badge] of this.badges) {
      if (badge.seen !== gen) {
        badge.text.destroy();
        this.badges.delete(key);
      }
    }
  }

  /** Nothing here animates (the encrypted legs pulse in the packet layer); present for the common layer shape. */
  animate(wall: number, reducedMotion: boolean, theme: ThemeColors): boolean {
    void wall;
    void reducedMotion;
    void theme;
    return false;
  }

  /** The hollow tube (under the cables): a border, the hollow inside, and the core when the tunnel is up. */
  private drawTube(g: Graphics, shape: TubeShape, t: TunnelTubeMark, pxq: number, theme: ThemeColors): void {
    const pts = sampleBezier(shape.geom, WAN_TUBE_SAMPLES);
    const border = t.up ? theme.borderStrong : theme.err;
    if (tracePolyline(g, pts)) g.stroke({ width: (WAN_TUBE_WIDTH + 1.8) * pxq, color: border, alpha: 0.85, cap: shape.stub ? 'butt' : 'round', join: 'round' });
    if (tracePolyline(g, pts)) g.stroke({ width: WAN_TUBE_WIDTH * pxq, color: theme.panel2, alpha: 0.96, cap: shape.stub ? 'butt' : 'round', join: 'round' });
    if (t.up && tracePolyline(g, pts)) g.stroke({ width: WAN_CORE_WIDTH * pxq, color: t.lock ? theme.purple : theme.ok, alpha: 0.92, cap: 'round', join: 'round' });
  }

  private drawRail(glyphs: Graphics, rail: PppRailMark, anchor: PortAnchor, pxq: number, theme: ThemeColors, gen: number, res: number, view: Rect): void {
    const texts = railCellTexts(rail);
    const views = texts.map((text, i) => {
      const badge = this.badge(`rail:${rail.device}/${rail.port}#${i}`, theme, 8, true, gen);
      const style = railCellStyle(rail.steps[i]?.state ?? 'todo');
      setText(badge.text, text, style.faint ? theme.textFaint : rail.steps[i]?.state === 'failed' ? theme.err : theme.text, theme.mono, res);
      badge.text.anchor.set(0.5);
      badge.text.scale.set(1);
      return badge;
    });
    const widths = views.map((v) => Math.max(RAIL_CELL_W, v.text.width + 5));
    const center = railCenter(anchor, railWidth(widths, pxq), pxq);
    const rects = railCellRects(center, widths, pxq);
    const all = { minX: rects[0]?.minX ?? center.x, minY: center.y - 8 * pxq, maxX: rects[rects.length - 1]?.maxX ?? center.x, maxY: center.y + 8 * pxq };
    if (!rectsIntersect(all, view)) {
      for (const v of views) v.text.visible = false;
      return;
    }
    // the rail's backing strip, so the cells read over the cable
    glyphs
      .roundRect(all.minX - 2 * pxq, all.minY - 1 * pxq, all.maxX - all.minX + 4 * pxq, all.maxY - all.minY + 2 * pxq, 3 * pxq)
      .fill({ color: theme.bg, alpha: 0.85 });
    for (let i = 0; i < rects.length; i++) {
      const rect = rects[i];
      const step = rail.steps[i];
      const v = views[i];
      if (rect === undefined || step === undefined || v === undefined) continue;
      const style = railCellStyle(step.state);
      const w = rect.maxX - rect.minX;
      const h = rect.maxY - rect.minY;
      const cx = (rect.minX + rect.maxX) / 2;
      const cy = (rect.minY + rect.maxY) / 2;
      const color = step.state === 'failed' ? theme.err : step.state === 'done' ? theme.ok : step.state === 'current' ? theme.accent : theme.border;
      glyphs
        .roundRect(rect.minX, rect.minY, w, h, 2.5 * pxq)
        .fill({ color: style.filled ? theme.panel2 : theme.panel, alpha: style.faint ? 0.6 : 0.96 })
        .stroke({ width: (style.strong ? 1.8 : 1) * pxq, color, alpha: style.faint ? 0.6 : 1 });
      if (style.filled) glyphs.rect(rect.minX + 1.5 * pxq, rect.maxY - 3 * pxq, w - 3 * pxq, 1.5 * pxq).fill({ color });
      if (style.strong && !style.cross) glyphs.moveTo(rect.minX + 2 * pxq, rect.maxY + 2 * pxq).lineTo(rect.maxX - 2 * pxq, rect.maxY + 2 * pxq).stroke({ width: 1.4 * pxq, color });
      if (style.cross) {
        glyphs
          .moveTo(rect.minX + 1.5 * pxq, rect.minY + 1.5 * pxq)
          .lineTo(rect.maxX - 1.5 * pxq, rect.maxY - 1.5 * pxq)
          .moveTo(rect.maxX - 1.5 * pxq, rect.minY + 1.5 * pxq)
          .lineTo(rect.minX + 1.5 * pxq, rect.maxY - 1.5 * pxq)
          .stroke({ width: 1.6 * pxq, color: theme.err, cap: 'round' });
      }
      if (style.strike) glyphs.moveTo(rect.minX + 1.5 * pxq, cy).lineTo(rect.maxX - 1.5 * pxq, cy).stroke({ width: 1.2 * pxq, color: theme.textDim });
      v.text.position.set(cx, cy);
      v.text.scale.set(pxq);
      v.text.visible = true;
      const next = rects[i + 1];
      if (next !== undefined) glyphs.circle((rect.maxX + next.minX) / 2, cy, 0.9 * pxq).fill({ color: theme.textDim });
    }
    if (rail.open) {
      // the ✓ is in the last cell's text; a heavier border on the whole rail repeats "the link carries IP"
      glyphs.roundRect(all.minX - 2 * pxq, all.minY - 1 * pxq, all.maxX - all.minX + 4 * pxq, all.maxY - all.minY + 2 * pxq, 3 * pxq).stroke({ width: 1 * pxq, color: theme.ok, alpha: 0.8 });
    }
  }

  /** A small padlock: the tunnel's payload is protected (simulated ESP). */
  private drawPadlock(glyphs: Graphics, at: Pt, pxq: number, theme: ThemeColors): void {
    const w = 7 * pxq;
    const h = 5.5 * pxq;
    const top = at.y - 1.5 * pxq;
    glyphs
      .moveTo(at.x - 2.2 * pxq, top)
      .arc(at.x, top, 2.2 * pxq, Math.PI, 0)
      .stroke({ width: 1.3 * pxq, color: theme.textDim });
    glyphs.roundRect(at.x - w / 2, top, w, h, 1.2 * pxq).fill({ color: theme.textDim });
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
