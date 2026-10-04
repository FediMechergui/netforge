/**
 * canvas/qos.ts — the QoS overlay layer (ARCHITECTURE-P3 §6, D16, §3.5 step 5, §3.11; spec §9.6 "QoS": links coloured
 * by utilisation, queues drawn as stacked bars at egress ports). @since P3 (W3 web-canvas).
 *
 * Draws the render model of `canvas/overlays/qos-model.ts` (`buildQosLayerModel`, built by the registry entry `qos`
 * from the `topoOverlays.qos` toggle and the snapshot):
 *
 * - a **load sleeve** per cable direction: a band hugging the cable on the sender's right-hand side (so the two
 *   directions never overlap), as thick as the utilisation (world units: it scales with the camera like the cable),
 *   coloured by the ok/warn/err ramp, with a `37 %` label when zoomed in — thickness and the label are the non-colour
 *   channels;
 * - a **FIFO stack** at every egress port with a `txBacklog`: up to 8 capsules piled sideways from the cable on the
 *   same side as the port's own sleeve, the frame that leaves first nearest the cable, each lettered with its DSCP
 *   (`EF`, `AF`, `CS`, `BE`), then `+k` for the frames beyond them;
 * - [S20] **per-class queue lanes** at a scheduler port (`PortSnapshot.qos.queue`): one strip per class beside the
 *   cable, the priority lane nearest it with a `P` badge, each strip filled to `depth / limit`; a legend names every
 *   lane (`VOICE 1/64`) and its drop tags (`✕ queue full · class-default`, [S21] `✕ policed`) when zoomed in. A port
 *   with lanes AND a backlog (frames the link had already committed when the policy was attached) piles its capsules
 *   beyond the lanes.
 *
 * Nothing here is a dash pattern (P2 D20) and nothing animates: the drawing moves when the snapshot does. Two Pixi
 * containers, like `StpLayer`: the underlay (`scene.layers.qos`, below the cables: the sleeves) and `labels` (above the
 * devices: stacks, lanes, badges and text). The pure helpers (geometry, colours, the text forms) have no Pixi
 * dependency; the keyboard outline reads `qosPortFacts`, `qosDeviceFacts` and `qosLinkFacts`, so every fact drawn here
 * is also said.
 */
import { Container, Graphics, type Text } from 'pixi.js';
import { portKey, type DeviceId, type LinkId } from '@netforge/engine';
import { CABLE_WIDTH, bezierAt, bezierTangent, geomBounds, type CableGeom, type Pt } from './cables';
import type { OverlayFact } from './l2';
import {
  LOAD_SLEEVE_MAX_WIDTH,
  type LoadLevel,
  type QosCapsule,
  type QosLaneMark,
  type QosLayerModel,
  type QosQueueMark,
  type QosSleeveMark,
  type QosStackMark,
} from './overlays/qos-model';
import type { Layout, PortAnchor } from './ports';
import { inflateRect, makeText, rectsIntersect, setText, viewKey, type Lod, type Rect, type ThemeColors } from './scene';

// ── geometry ─────────────────────────────────────────────────────────────────

/** World units between the cable's centre line and the inner edge of a sleeve. */
export const SLEEVE_GAP = CABLE_WIDTH / 2 + 0.8;
/** How far from the cable's centre line a sleeve can reach (at 100 %). */
export const SLEEVE_EXTENT = SLEEVE_GAP + LOAD_SLEEVE_MAX_WIDTH;
/** Zoom from which a sleeve shows its `%` label. */
export const QOS_PERCENT_MIN_ZOOM = 1;
/** Along the cable, how far from the port the stacks and lanes start (before the camera factor). */
export const QOS_INSET = 10;
/** Sideways, the gap between the sleeve's reach and the first lane or capsule (before the camera factor). */
export const QOS_SIDE_GAP = 3;
/** A capsule: its length along the cable and its thickness across it. */
export const CAPSULE_W = 20;
export const CAPSULE_H = 8;
export const CAPSULE_GAP = 1.5;
/** A lane: the badge room before the strip, the strip's length along the cable, its thickness and the gap between lanes. */
export const LANE_BADGE = 9;
export const LANE_LEN = 40;
export const LANE_H = 7;
export const LANE_GAP = 2;
/** The non-colour mark of a drop tag. */
export const QOS_DROP_GLYPH = '✕';

/** The unit vector across the cable on the right-hand side of a frame leaving `anchor` (screen axes, y down). */
export function sideOf(anchor: Pick<PortAnchor, 'nx' | 'ny'>): Pt {
  return { x: -anchor.ny, y: anchor.nx };
}

/** Where the stacks and lanes of a port begin across the cable: past the reach of the widest sleeve. */
export function sideStart(pxq = 1): number {
  return SLEEVE_EXTENT + QOS_SIDE_GAP * pxq;
}

/** Thickness across the cable of `count` lanes and the gap after the last one (0 for none). */
export function lanesThickness(count: number, pxq = 1): number {
  return count <= 0 ? 0 : count * (LANE_H + LANE_GAP) * pxq;
}

/** A point `along` the cable direction from the port and `across` it (positive: the right-hand side). */
export function portFrame(anchor: Pick<PortAnchor, 'x' | 'y' | 'nx' | 'ny'>, along: number, across: number): Pt {
  const t = sideOf(anchor);
  return { x: anchor.x + anchor.nx * along + t.x * across, y: anchor.y + anchor.ny * along + t.y * across };
}

/** The four corners (flat [x, y, …]) of a rectangle in the port's frame: `along` from a0 to a1, `across` from c0 to c1. */
export function frameQuad(anchor: Pick<PortAnchor, 'x' | 'y' | 'nx' | 'ny'>, a0: number, a1: number, c0: number, c1: number): number[] {
  const p = [portFrame(anchor, a0, c0), portFrame(anchor, a1, c0), portFrame(anchor, a1, c1), portFrame(anchor, a0, c1)];
  return p.flatMap((q) => [q.x, q.y]);
}

/** Centre of capsule `index` of a stack whose first capsule sits `offset` further out than `sideStart` (lanes before it). */
export function capsuleCenter(anchor: Pick<PortAnchor, 'x' | 'y' | 'nx' | 'ny'>, index: number, offset = 0, pxq = 1): Pt {
  const across = sideStart(pxq) + offset + (index * (CAPSULE_H + CAPSULE_GAP) + CAPSULE_H / 2) * pxq;
  return portFrame(anchor, (QOS_INSET + CAPSULE_W / 2) * pxq, across);
}

/** Corners of capsule `index`. */
export function capsuleQuad(anchor: Pick<PortAnchor, 'x' | 'y' | 'nx' | 'ny'>, index: number, offset = 0, pxq = 1): number[] {
  const c0 = sideStart(pxq) + offset + index * (CAPSULE_H + CAPSULE_GAP) * pxq;
  return frameQuad(anchor, QOS_INSET * pxq, (QOS_INSET + CAPSULE_W) * pxq, c0, c0 + CAPSULE_H * pxq);
}

/** Across-the-cable band of lane `index` (0 = nearest the cable): [inner, outer]. */
export function laneBand(index: number, pxq = 1): [number, number] {
  const c0 = sideStart(pxq) + index * (LANE_H + LANE_GAP) * pxq;
  return [c0, c0 + LANE_H * pxq];
}

/** Corners of lane `index`'s strip, filled to `fill` (1 = the whole strip). */
export function laneQuad(anchor: Pick<PortAnchor, 'x' | 'y' | 'nx' | 'ny'>, index: number, fill = 1, pxq = 1): number[] {
  const [c0, c1] = laneBand(index, pxq);
  const a0 = (QOS_INSET + LANE_BADGE) * pxq;
  const f = Math.min(1, Math.max(0, fill));
  return frameQuad(anchor, a0, a0 + LANE_LEN * f * pxq, c0, c1);
}

/** Where lane `index`'s `P` badge sits (in the badge room before its strip). */
export function laneBadgePoint(anchor: Pick<PortAnchor, 'x' | 'y' | 'nx' | 'ny'>, index: number, pxq = 1): Pt {
  const [c0, c1] = laneBand(index, pxq);
  return portFrame(anchor, (QOS_INSET + LANE_BADGE / 2) * pxq, (c0 + c1) / 2);
}

/**
 * Where a port's lane legend sits and how it is anchored: beside the lanes, away from the cable (below or above a
 * horizontal cable, left or right of a vertical one), its lines in the lanes' visual order.
 */
export function legendPlacement(
  anchor: Pick<PortAnchor, 'x' | 'y' | 'nx' | 'ny'>,
  lanes: number,
  pxq = 1,
): { at: Pt; anchorX: number; anchorY: number; reversed: boolean } {
  const t = sideOf(anchor);
  const across = sideStart(pxq) + lanesThickness(lanes, pxq) + 2 * pxq;
  const at = portFrame(anchor, (QOS_INSET + LANE_BADGE + LANE_LEN / 2) * pxq, across);
  if (Math.abs(t.y) >= Math.abs(t.x)) {
    // a horizontal cable: the lanes stack vertically; the legend goes under them (or over them), lines top to bottom
    return { at, anchorX: 0.5, anchorY: t.y >= 0 ? 0 : 1, reversed: t.y < 0 };
  }
  return { at, anchorX: t.x >= 0 ? 0 : 1, anchorY: 0.5, reversed: false };
}

/** Distance from the cable's centre line to the centre of a sleeve of `width`. */
export function sleeveOffset(width: number): number {
  return SLEEVE_GAP + width / 2;
}

/**
 * The centre line of a sleeve: `samples + 1` points along the cable in the sending direction, each moved to the
 * sender's right by `sleeveOffset(width)`.
 */
export function sleevePath(geom: CableGeom, from: 'a' | 'b', width: number, samples = 20): Pt[] {
  const off = sleeveOffset(width);
  const out: Pt[] = [];
  for (let i = 0; i <= samples; i++) {
    const s = i / samples;
    const u = from === 'a' ? s : 1 - s;
    const p = bezierAt(geom, u);
    const tan = bezierTangent(geom, u);
    const dir = from === 'a' ? tan : { x: -tan.x, y: -tan.y };
    out.push({ x: p.x - dir.y * off, y: p.y + dir.x * off });
  }
  return out;
}

/** Where a sleeve's `%` label sits: three quarters of the way along, just outside the sleeve. */
export function sleeveLabelPoint(geom: CableGeom, from: 'a' | 'b', width: number): Pt {
  const u = from === 'a' ? 0.72 : 0.28;
  const p = bezierAt(geom, u);
  const tan = bezierTangent(geom, u);
  const dir = from === 'a' ? tan : { x: -tan.x, y: -tan.y };
  const off = SLEEVE_GAP + width + 6;
  return { x: p.x - dir.y * off, y: p.y + dir.x * off };
}

// ── colours ──────────────────────────────────────────────────────────────────

/** The ramp colour of a load level. */
export function levelColor(level: LoadLevel, theme: Pick<ThemeColors, 'ok' | 'warn' | 'err'>): number {
  return level === 'ok' ? theme.ok : level === 'warn' ? theme.warn : theme.err;
}

/** A capsule's fill: by DSCP family (the letter is the non-colour channel). */
export function capsuleColor(letter: string, theme: Pick<ThemeColors, 'purple' | 'accent' | 'blueDeep' | 'panel2' | 'yellow'>): number {
  switch (letter) {
    case 'EF':
      return theme.purple;
    case 'AF':
      return theme.accent;
    case 'CS':
      return theme.blueDeep;
    case 'BE':
    case '':
      return theme.panel2;
    default:
      return theme.yellow;
  }
}

// ── text forms (the keyboard outline) ────────────────────────────────────────

const LEVEL_WORD: Readonly<Record<LoadLevel, string>> = Object.freeze({ ok: 'light', warn: 'heavy', err: 'near saturation' });

function frames(n: number): string {
  return `${n} ${n === 1 ? 'frame' : 'frames'}`;
}

function capsuleWord(c: QosCapsule): string {
  return c.dscpName === '' ? 'unmarked' : c.dscpName;
}

/** "3 frames waiting to be sent, first to last: EF (46), EF (46), BE (0), and 4 more". */
export function describeStack(m: QosStackMark): string {
  const list = m.capsules.map(capsuleWord).join(', ');
  return `${frames(m.depth)} waiting to be sent, first to last: ${list}${m.more > 0 ? `, and ${m.more} more` : ''}`;
}

/** `queue 7: EF EF BE +4`. */
export function shortStack(m: QosStackMark): string {
  const letters = m.capsules.map((c) => (c.letter === '' ? '·' : c.letter)).join(' ');
  return `queue ${m.depth}: ${letters}${m.moreLabel === '' ? '' : ` ${m.moreLabel}`}`;
}

/** "VOICE, the priority queue, 1 of 64 waiting" (+ its drop tags). */
export function describeLane(l: QosLaneMark): string {
  const kind = l.priority ? ', the priority queue' : '';
  const flows = l.flows === undefined ? '' : `, ${l.flows} ${l.flows === 1 ? 'flow' : 'flows'}`;
  const tags = l.tags.map((t) => `, ${t.text} (${t.count} dropped)`).join('');
  return `${l.name}${kind}, ${l.depth} of ${l.limit} waiting${flows}${tags}`;
}

/** The lane's legend line: `P VOICE 1/64`, `class-default 64/64 ✕ queue full · class-default`. */
export function laneLegend(l: QosLaneMark): string {
  const tags = l.tags.map((t) => ` ${QOS_DROP_GLYPH} ${t.text}`).join('');
  return `${l.badge === '' ? '' : `${l.badge} `}${l.label}${tags}`;
}

/** "output policy WAN-EDGE: VOICE, the priority queue, 1 of 64 waiting; class-default, 64 of 64 waiting, …". */
export function describeQueue(m: QosQueueMark): string {
  const head = m.policy === undefined ? 'output queues' : `output policy ${m.policy}`;
  return `${head}: ${m.lanes.map(describeLane).join('; ')}`;
}

/** `P VOICE 1/64 · class-default 64/64 ✕`. */
export function shortQueue(m: QosQueueMark): string {
  return m.lanes.map((l) => `${l.badge === '' ? '' : `${l.badge} `}${l.label}${l.tags.length > 0 ? ` ${QOS_DROP_GLYPH}` : ''}`).join(' · ');
}

/** "sending at 100 % of the line rate (near saturation) from r1 Se0/0/0". */
export function describeSleeve(s: QosSleeveMark): string {
  return `sending at ${s.label} of the line rate (${LEVEL_WORD[s.level]}) from ${s.device} ${s.port}`;
}

/** Text facts per port: its FIFO stack and its class lanes. */
export function qosPortFacts(model: QosLayerModel | null): ReadonlyMap<string, OverlayFact> {
  const out = new Map<string, OverlayFact>();
  if (model === null) return out;
  const add = (device: DeviceId, port: string, fact: OverlayFact): void => {
    const key = portKey({ device, port });
    const had = out.get(key);
    out.set(key, had === undefined ? fact : { short: `${had.short} · ${fact.short}`, text: `${had.text}; ${fact.text}` });
  };
  for (const q of model.queues) add(q.device, q.port, { short: shortQueue(q), text: describeQueue(q) });
  for (const s of model.stacks) add(s.device, s.port, { short: shortStack(s), text: describeStack(s) });
  return out;
}

/** Text facts per device: how many of its ports have frames waiting. */
export function qosDeviceFacts(model: QosLayerModel | null): ReadonlyMap<DeviceId, OverlayFact> {
  const out = new Map<DeviceId, OverlayFact>();
  if (model === null) return out;
  const waiting = new Map<DeviceId, Set<string>>();
  const note = (device: DeviceId, port: string): void => {
    const s = waiting.get(device) ?? new Set<string>();
    s.add(port);
    waiting.set(device, s);
  };
  for (const s of model.stacks) note(s.device, s.port);
  for (const q of model.queues) if (q.lanes.some((l) => l.depth > 0)) note(q.device, q.port);
  for (const [device, ports] of waiting) {
    const n = ports.size;
    out.set(device, { short: `queues ${n}`, text: `frames waiting at ${n} ${n === 1 ? 'port' : 'ports'}` });
  }
  return out;
}

/** Text facts per cable: the load of each direction. */
export function qosLinkFacts(model: QosLayerModel | null): ReadonlyMap<LinkId, OverlayFact> {
  const out = new Map<LinkId, OverlayFact>();
  if (model === null) return out;
  const by = new Map<LinkId, QosSleeveMark[]>();
  for (const s of model.sleeves) by.set(s.link, [...(by.get(s.link) ?? []), s]);
  for (const [link, sleeves] of by) {
    out.set(link, {
      short: sleeves.map((s) => `${s.from === 'a' ? '→' : '←'} ${s.label}`).join(' '),
      text: `load: ${sleeves.map(describeSleeve).join('; ')}`,
    });
  }
  return out;
}

// ── the layer ────────────────────────────────────────────────────────────────

class LabelView {
  readonly text: Text;
  seen = 0;

  constructor(theme: ThemeColors, size: number, mono: boolean, bold: boolean) {
    this.text = makeText('', size, theme.text, mono ? theme.mono : theme.sans, bold ? 'bold' : 'normal');
    this.text.anchor.set(0.5);
  }
}

export interface QosSyncInput {
  /** The registry's render model, or null when the overlay is off. */
  model: QosLayerModel | null;
  layout: Layout;
  theme: ThemeColors;
  zoom: number;
  lod: Lod;
  view: Rect;
  textResolution: number;
  cableGeometry(link: LinkId): CableGeom | undefined;
}

export class QosLayer {
  private readonly ground = new Graphics();
  private readonly glyphs = new Graphics();
  private readonly texts = new Map<string, LabelView>();
  private readonly labels: Container;
  private sig = '';
  private generation = 0;

  constructor(ground: Container, labels: Container) {
    this.labels = labels;
    ground.addChild(this.ground);
    labels.addChild(this.glyphs);
  }

  sync(input: QosSyncInput): void {
    const { model, layout, theme } = input;
    const gen = ++this.generation;
    const view = inflateRect(input.view, 80 / Math.max(input.zoom, 1e-3));
    const zoomBucket = Math.round(Math.log2(Math.max(input.zoom, 1e-3)) * 4);
    const pxq = 1 / 2 ** (zoomBucket / 4);
    const showPercent = input.lod === 'full' && input.zoom >= QOS_PERCENT_MIN_ZOOM;

    const r = (p: Pt): string => `${Math.round(p.x)},${Math.round(p.y)}`;
    const parts: string[] = [String(theme.stamp), viewKey(input.view, input.zoom), input.lod, String(input.textResolution), String(showPercent)];
    if (model !== null) {
      for (const s of model.sleeves) {
        const geom = input.cableGeometry(s.link);
        parts.push(`S${s.link}|${s.from}|${geom ? `${r(geom.p0)}|${r(geom.p3)}` : '-'}|${s.width.toFixed(2)}|${s.label}|${s.level}`);
      }
      for (const st of model.stacks) {
        const a = layout.edge.get(portKey({ device: st.device, port: st.port }));
        parts.push(`K${st.device}/${st.port}|${a ? r(a) : '-'}|${st.capsules.map((c) => `${c.pdu}${c.letter}`).join(',')}|${st.moreLabel}`);
      }
      for (const q of model.queues) {
        const a = layout.edge.get(portKey({ device: q.device, port: q.port }));
        parts.push(`Q${q.device}/${q.port}|${a ? r(a) : '-'}|${q.lanes.map(laneLegend).join(',')}|${q.lanes.map((l) => l.fill.toFixed(3)).join(',')}`);
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
      const showLegend = input.lod === 'full';
      // sleeves (the underlay)
      for (const s of model.sleeves) {
        if (s.width < 0.3) continue;
        const geom = input.cableGeometry(s.link);
        if (!geom || !rectsIntersect(inflateRect(geomBounds(geom), SLEEVE_EXTENT + 20), view)) continue;
        const pts = sleevePath(geom, s.from, s.width);
        const first = pts[0];
        if (first === undefined) continue;
        g.moveTo(first.x, first.y);
        for (let i = 1; i < pts.length; i++) {
          const p = pts[i];
          if (p !== undefined) g.lineTo(p.x, p.y);
        }
        g.stroke({ width: s.width, color: levelColor(s.level, theme), alpha: 0.5, cap: 'butt', join: 'round' });
        if (showPercent) {
          const at = sleeveLabelPoint(geom, s.from, s.width);
          const label = this.text(`pct:${s.link}/${s.from}`, theme, 8, true, false, gen);
          setText(label.text, s.label, theme.textDim, theme.mono, input.textResolution);
          label.text.position.set(at.x, at.y);
          label.text.scale.set(1);
          label.text.visible = true;
        }
      }

      // class lanes ([S20])
      const laneDepth = new Map<string, number>();
      for (const q of model.queues) {
        const anchor = layout.edge.get(portKey({ device: q.device, port: q.port }));
        if (anchor === undefined) continue;
        laneDepth.set(portKey({ device: q.device, port: q.port }), lanesThickness(q.lanes.length, pxq));
        if (anchor.x < view.minX || anchor.x > view.maxX || anchor.y < view.minY || anchor.y > view.maxY) continue;
        q.lanes.forEach((lane, i) => {
          const dropped = lane.tags.length > 0;
          glyphs.poly(laneQuad(anchor, i, 1, pxq), true).fill({ color: theme.panel, alpha: 0.92 }).stroke({ width: (dropped ? 1.6 : 0.9) * pxq, color: dropped ? theme.err : theme.borderStrong });
          if (lane.fill > 0) glyphs.poly(laneQuad(anchor, i, lane.fill, pxq), true).fill({ color: lane.priority ? theme.purple : dropped ? theme.err : theme.accent, alpha: 0.85 });
          if (lane.badge !== '' && showText) {
            const at = laneBadgePoint(anchor, i, pxq);
            glyphs.rect(at.x - 4 * pxq, at.y - 4 * pxq, 8 * pxq, 8 * pxq).fill({ color: theme.purple, alpha: 0.95 }).stroke({ width: 0.8 * pxq, color: theme.text });
            const badge = this.text(`badge:${q.device}/${q.port}/${lane.name}`, theme, 7, true, true, gen);
            setText(badge.text, lane.badge, theme.bg, theme.mono, input.textResolution);
            badge.text.anchor.set(0.5);
            badge.text.position.set(at.x, at.y);
            badge.text.scale.set(pxq);
            badge.text.visible = true;
          }
        });
        if (showLegend) {
          const place = legendPlacement(anchor, q.lanes.length, pxq);
          const lines = q.lanes.map(laneLegend);
          const legend = this.text(`legend:${q.device}/${q.port}`, theme, 7.5, true, false, gen);
          const dropped = q.lanes.some((l) => l.tags.length > 0);
          setText(legend.text, (place.reversed ? [...lines].reverse() : lines).join('\n'), dropped ? theme.err : theme.text, theme.mono, input.textResolution);
          legend.text.anchor.set(place.anchorX, place.anchorY);
          legend.text.position.set(place.at.x, place.at.y);
          legend.text.scale.set(pxq);
          legend.text.visible = true;
        }
      }

      // FIFO stacks (beyond the lanes of a scheduler port)
      for (const st of model.stacks) {
        const key = portKey({ device: st.device, port: st.port });
        const anchor = layout.edge.get(key);
        if (anchor === undefined) continue;
        if (anchor.x < view.minX || anchor.x > view.maxX || anchor.y < view.minY || anchor.y > view.maxY) continue;
        const offset = laneDepth.get(key) ?? 0;
        st.capsules.forEach((c, i) => {
          glyphs.poly(capsuleQuad(anchor, i, offset, pxq), true).fill({ color: capsuleColor(c.letter, theme), alpha: 0.95 }).stroke({ width: 0.8 * pxq, color: theme.borderStrong });
          if (!showText || c.letter === '') return;
          const at = capsuleCenter(anchor, i, offset, pxq);
          const letter = this.text(`cap:${key}/${i}`, theme, 6.5, true, true, gen);
          setText(letter.text, c.letter, c.letter === 'BE' ? theme.text : theme.bg, theme.mono, input.textResolution);
          letter.text.anchor.set(0.5);
          letter.text.position.set(at.x, at.y);
          letter.text.scale.set(pxq);
          letter.text.visible = true;
        });
        if (st.moreLabel !== '' && showText) {
          const at = capsuleCenter(anchor, st.capsules.length, offset, pxq);
          const more = this.text(`more:${key}`, theme, 7.5, true, true, gen);
          setText(more.text, st.moreLabel, theme.text, theme.mono, input.textResolution);
          more.text.anchor.set(0.5);
          more.text.position.set(at.x, at.y);
          more.text.scale.set(pxq);
          more.text.visible = true;
        }
      }
    }

    for (const [key, t] of this.texts) {
      if (t.seen !== gen) {
        t.text.destroy();
        this.texts.delete(key);
      }
    }
  }

  private text(key: string, theme: ThemeColors, size: number, mono: boolean, bold: boolean, gen: number): LabelView {
    let t = this.texts.get(key);
    if (!t) {
      t = new LabelView(theme, size, mono, bold);
      this.texts.set(key, t);
      this.labels.addChild(t.text);
    }
    t.seen = gen;
    return t;
  }

  destroy(): void {
    for (const t of this.texts.values()) t.text.destroy();
    this.texts.clear();
    this.ground.destroy();
    this.glyphs.destroy();
  }
}
