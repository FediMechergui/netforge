/**
 * Packet capsules (spec §9.1, ARCHITECTURE "Animation", ARCHITECTURE-P1 §7 "Canvas core").
 *
 * One capsule per frame LEG. Identity is `(pdu.id, link|medium, to)` (`inflightKey`): a broadcast on a hub
 * segment or a BSS has one leg per receiver, each with its own clone id. For each leg, at the (extrapolated)
 * sim time `now`:
 *   head = clamp((now - txStart) / (arrive - txStart))            — the leading bit
 *   tail = clamp((now - min(txEnd, abortAt)) / (arrive - txStart)) — the trailing bit
 * so a leg cut short by a collision or a lost radio (`abortAt`) travels on as a short fragment, drawn hollow with
 * a cut stroke. A leg is shown only while txStart <= now < arrive.
 *
 * Paths:
 *  - cables and hub segment legs follow the cable bezier (a segment leg is always one cable, end to end);
 *  - PtP radio links follow the straight beam between the two antennas;
 *  - Wi-Fi and cellular legs (whose `link` is a medium id) travel on a gentle arc between the two antennas,
 *    each direction bending to its own side (`air.ts` `legGeometry`).
 *
 * Shape and badge letter come from the protocol vocabulary (vocab/protocols.ts): the pair is unique, so a packet
 * is identifiable without colour. Colour follows the protocol, or a hash of the flow when "colour by flow" is on.
 * Size is log-scaled by frame size and clamped; when zoomed far out capsules keep a readable screen size.
 * Background frames (keepalives, beacons) are hidden unless the `backgroundFrames` overlay is on.
 */
import { Container, Graphics, type Text } from 'pixi.js';
import {
  inflightKey,
  samePort,
  type InflightFrame,
  type LinkId,
  type LinkSnapshot,
  type PduId,
  type PduSummary,
  type ProtoName,
  type SimTime,
} from '@netforge/engine';
import { protocolVocab, type PacketShape } from '../vocab/protocols';
import { bezierAt, bezierTangent, geomBounds, type CableGeom, type Pt } from './cables';
import { isRadioLink } from './ports';
import { inflateRect, makeText, rectsIntersect, setText, type Rect, type ThemeColors } from './scene';

export type { PacketShape } from '../vocab/protocols';

/** Zoom at or above which capsules carry their protocol letter. */
export const PACKET_LETTER_MIN_ZOOM = 0.9;
/** Letters are drawn only while at most this many capsules are on screen. */
export const PACKET_LETTER_MAX = 80;
/** Hard cap of capsules drawn in one frame (flood protection). */
export const MAX_PACKET_VIEWS = 1500;

/**
 * Protocol a capsule represents: the summary's protocol, unless it is framing glue or raw data, in which case the
 * innermost meaningful layer of the stack.
 */
export function displayProto(pdu: Pick<PduSummary, 'proto' | 'layers'>): ProtoName {
  const top = protocolVocab(pdu.proto);
  if (pdu.proto !== 'payload' && top.transparent !== true) return pdu.proto;
  const layers = pdu.layers ?? [];
  for (let i = layers.length - 1; i >= 0; i--) {
    const p = layers[i];
    if (p === undefined || p === 'payload') continue;
    if (protocolVocab(p).transparent === true) continue;
    return p;
  }
  return pdu.proto;
}

export function shapeFor(proto: ProtoName): PacketShape {
  return protocolVocab(proto).shape;
}

export function letterFor(proto: ProtoName): string {
  return protocolVocab(proto).letter;
}

export function protoColor(proto: ProtoName, theme: ThemeColors): number {
  return theme[protocolVocab(proto).color];
}

function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Stable colour per conversation: the flow id when present, else the PDU family root. */
export function flowColor(pdu: PduSummary, theme: ThemeColors): number {
  const palette = [theme.accent, theme.warn, theme.ok, theme.purple, theme.yellow, theme.blueDeep, theme.err];
  const key = pdu.flow ?? `pdu:${pdu.parent ?? pdu.id}`;
  return palette[fnv1a(key) % palette.length] ?? theme.accent;
}

/** Capsule radius from frame size: 64 B → 4.5, doubling adds 1.6, clamped at 11. */
export function packetRadius(size: number): number {
  const r = 4.5 + 1.6 * Math.log2(Math.max(64, size) / 64);
  return Math.min(11, Math.max(4.5, r));
}

/** Capsule scale at a zoom level: 1 when zoomed in, growing so capsules stay visible far out (max 10). */
export function packetScaleFor(zoom: number): number {
  if (zoom >= 0.6) return 1;
  return Math.min(10, 0.6 / Math.max(zoom, 1e-3));
}

/**
 * Head/tail position along the path from the sender (0) to the receiver (1), or undefined when not on the wire.
 * `aborted` is true once the transmission was cut (`abortAt` reached).
 */
export function framePlacement(
  f: Pick<InflightFrame, 'txStart' | 'txEnd' | 'arrive' | 'abortAt'>,
  now: SimTime,
): { head: number; tail: number; aborted: boolean } | undefined {
  if (now < f.txStart || now >= f.arrive) return undefined;
  const span = f.arrive - f.txStart;
  if (span <= 0) return undefined;
  const clamp = (v: number): number => Math.min(1, Math.max(0, v));
  const end = f.abortAt !== undefined ? Math.max(f.txStart, Math.min(f.txEnd, f.abortAt)) : f.txEnd;
  const aborted = f.abortAt !== undefined && now >= f.abortAt;
  return { head: clamp((now - f.txStart) / span), tail: clamp((now - end) / span), aborted };
}

/** Geometry sources a leg can travel on. */
export interface LegGeometrySource {
  links: ReadonlyMap<LinkId, LinkSnapshot>;
  /** Cable bezier of a (non-radio) link. */
  cable(link: LinkId): CableGeom | undefined;
  /** Straight beam of a PtP radio link. */
  beam(link: LinkId): CableGeom | undefined;
  /** Arc between two radio ports (air and cellular legs). */
  air(from: InflightFrame['from'], to: InflightFrame['to']): CableGeom | undefined;
}

/** Path of a leg plus whether the leg runs along it from p0 (true) or from p3 (false). */
export interface LegPath {
  geom: CableGeom;
  forward: boolean;
}

/** Resolve the path a frame leg travels on (undefined when its ends are not on the canvas). */
export function resolveLegPath(f: Pick<InflightFrame, 'link' | 'from' | 'to' | 'medium'>, src: LegGeometrySource): LegPath | undefined {
  const link = src.links.get(f.link);
  if (link !== undefined) {
    const geom = isRadioLink(link) ? src.beam(link.id) : src.cable(link.id);
    if (!geom) return undefined;
    const forward = samePort(f.from, link.a) || (!samePort(f.from, link.b) && samePort(f.to, link.b));
    return { geom, forward };
  }
  if (f.medium === 'air' || f.medium === 'cell') {
    const geom = src.air(f.from, f.to);
    return geom ? { geom, forward: true } : undefined;
  }
  return undefined;
}

function regularPolygon(g: Graphics, sides: number, r: number, rotation: number): void {
  const pts: number[] = [];
  for (let i = 0; i < sides; i++) {
    const a = rotation + ((Math.PI * 2) / sides) * i;
    pts.push(Math.cos(a) * r, Math.sin(a) * r);
  }
  g.poly(pts, true);
}

/** Trace the outline of a packet shape centred on (0, 0) (the caller fills/strokes it). */
export function traceShape(g: Graphics, shape: PacketShape, r: number): void {
  switch (shape) {
    case 'diamond': {
      const d = r * 1.3;
      g.poly([0, -d, d, 0, 0, d, -d, 0], true);
      break;
    }
    case 'capsule':
    case 'ring-capsule':
      g.roundRect(-r * 1.6, -r * 0.9, r * 3.2, r * 1.8, r * 0.9);
      break;
    case 'square':
      g.rect(-r, -r, r * 2, r * 2);
      break;
    case 'triangle': {
      const t = r * 1.35;
      // points along +x (the travel direction after rotation)
      g.poly([t, 0, -t * 0.6, -t * 0.85, -t * 0.6, t * 0.85], true);
      break;
    }
    case 'circle':
      g.circle(0, 0, r * 1.05);
      break;
    case 'pentagon':
      regularPolygon(g, 5, r * 1.2, 0);
      break;
    case 'octagon':
      regularPolygon(g, 8, r * 1.15, Math.PI / 8);
      break;
    case 'hexagon':
    default:
      regularPolygon(g, 6, r * 1.15, 0);
      break;
  }
}

function drawBody(g: Graphics, shape: PacketShape, r: number, fill: number, outline: number, outlineWidth: number, aborted: boolean, theme: ThemeColors): void {
  traceShape(g, shape, r);
  if (aborted) {
    // a fragment: hollow, with a cut stroke across it
    g.fill({ color: theme.bg, alpha: 0.85 }).stroke({ width: Math.max(1.4, outlineWidth), color: fill, join: 'round' });
    g.moveTo(-r * 0.9, r * 0.9).lineTo(r * 0.9, -r * 0.9).stroke({ width: 1.4, color: fill, cap: 'round' });
    return;
  }
  g.fill({ color: fill }).stroke({ width: outlineWidth, color: outline, join: 'round' });
  if (shape === 'ring-capsule') {
    // the ring variant: an inner outline distinguishes it from the plain capsule
    g.roundRect(-r * 1.15, -r * 0.5, r * 2.3, r, r * 0.5).stroke({ width: 1.1, color: theme.bg, alpha: 0.9 });
  }
}

class PacketView {
  readonly root = new Container();
  readonly trail = new Graphics();
  readonly body = new Graphics();
  letter: Text | null = null;
  letterText = '';
  letterColor = 0;
  bodySig = '';
  x = 0;
  y = 0;
  r = 0;
  pdu: PduId = 0;
  seen = 0;

  constructor() {
    this.root.addChild(this.trail, this.body);
  }
}

export interface PacketUpdateInput {
  inflight: readonly InflightFrame[];
  now: SimTime;
  paths: LegGeometrySource;
  theme: ThemeColors;
  colourByFlow: boolean;
  selectedPdu: PduId | null;
  /** Draw trails (off under reduced motion, where capsules jump between samples). */
  trails: boolean;
  /** Show background frames (keepalives, beacons). */
  showBackground: boolean;
  zoom: number;
  /** Visible world rectangle (capsules outside it are hidden). */
  view: Rect;
  textResolution: number;
}

export class PacketLayer {
  private readonly views = new Map<string, PacketView>();
  private generation = 0;

  constructor(private readonly root: Container) {}

  /** Place every visible capsule. Returns the number of legs currently on a medium (on screen or not). */
  update(input: PacketUpdateInput): number {
    const gen = ++this.generation;
    const { theme } = input;
    const scale = packetScaleFor(input.zoom);
    const view = inflateRect(input.view, 30 / Math.max(input.zoom, 1e-3));
    let onWire = 0;
    let drawn = 0;
    const placed: PacketView[] = [];
    for (const f of input.inflight) {
      if (f.background === true && !input.showBackground) continue;
      const place = framePlacement(f, input.now);
      if (!place) continue;
      const path = resolveLegPath(f, input.paths);
      if (!path) continue;
      onWire += 1;
      if (drawn >= MAX_PACKET_VIEWS) continue;
      const { geom, forward } = path;
      const toU = (s: number): number => (forward ? s : 1 - s);
      const head = bezierAt(geom, toU(place.head));
      if (head.x < view.minX || head.x > view.maxX || head.y < view.minY || head.y > view.maxY) {
        // the trail may still cross the view: keep the leg only when its path does
        if (!rectsIntersect(geomBounds(geom), view)) continue;
      }
      drawn += 1;
      const key = inflightKey(f.pdu.id, f.link, f.to);
      let pv = this.views.get(key);
      if (!pv) {
        pv = new PacketView();
        this.views.set(key, pv);
        this.root.addChild(pv.root);
      }
      pv.seen = gen;
      placed.push(pv);

      const tan = bezierTangent(geom, toU(place.head));
      const dir = forward ? 1 : -1;
      const proto = displayProto(f.pdu);
      const shape = shapeFor(proto);
      const r = packetRadius(f.pdu.size) * scale;
      const color = input.colourByFlow ? flowColor(f.pdu, theme) : protoColor(proto, theme);
      const selected = input.selectedPdu === f.pdu.id;
      const bodySig = `${shape}|${r}|${color}|${selected}|${place.aborted}|${theme.stamp}`;
      if (bodySig !== pv.bodySig) {
        pv.bodySig = bodySig;
        pv.body.clear();
        if (selected) pv.body.circle(0, 0, r * 1.9).stroke({ width: 2 * scale, color: theme.text, alpha: 0.9 });
        drawBody(pv.body, shape, r, color, selected ? theme.text : theme.bg, (selected ? 2 : 1.4) * scale, place.aborted, theme);
      }
      pv.body.position.set(head.x, head.y);
      const angle = Math.atan2(tan.y * dir, tan.x * dir);
      pv.body.rotation = shape === 'diamond' || shape === 'circle' ? 0 : angle;
      pv.x = head.x;
      pv.y = head.y;
      pv.r = r;
      pv.pdu = f.pdu.id;

      pv.trail.clear();
      if (input.trails && place.head - place.tail > 0.002) {
        const steps = 10;
        const tailU = toU(place.tail);
        const headU = toU(place.head);
        const p0: Pt = bezierAt(geom, tailU);
        pv.trail.moveTo(p0.x, p0.y);
        for (let i = 1; i <= steps; i++) {
          const p = bezierAt(geom, tailU + ((headU - tailU) * i) / steps);
          pv.trail.lineTo(p.x, p.y);
        }
        pv.trail.stroke({ width: Math.max(2, r * 1.1), color, alpha: place.aborted ? 0.18 : 0.32, cap: 'round', join: 'round' });
      }

      if (pv.letter) pv.letter.visible = false;
      pv.letterText = letterFor(proto);
      pv.letterColor = place.aborted ? color : theme.bg;
    }

    // protocol letters: only when zoomed in and the screen is not crowded
    const letters = input.zoom >= PACKET_LETTER_MIN_ZOOM && placed.length <= PACKET_LETTER_MAX;
    for (const pv of placed) {
      const text = pv.letterText;
      if (!letters || text === '') continue;
      if (!pv.letter) {
        pv.letter = makeText('', 7, theme.bg, theme.sans, 'bold');
        pv.letter.anchor.set(0.5);
        pv.root.addChild(pv.letter);
      }
      setText(pv.letter, text, pv.letterColor, theme.sans, input.textResolution);
      const size = (text.length > 1 ? 6 : 7.5) * scale;
      if (pv.letter.style.fontSize !== size) pv.letter.style.fontSize = size;
      pv.letter.position.set(pv.x, pv.y);
      pv.letter.visible = true;
    }

    for (const [key, pv] of this.views) {
      if (pv.seen !== gen) {
        pv.root.destroy({ children: true });
        this.views.delete(key);
      }
    }
    return onWire;
  }

  /** PDU whose capsule is under the point (the most recently placed wins). */
  hit(wx: number, wy: number, slack: number): PduId | undefined {
    let found: PduId | undefined;
    for (const v of this.views.values()) {
      const reach = v.r * 1.6 + slack;
      if ((v.x - wx) ** 2 + (v.y - wy) ** 2 <= reach * reach) found = v.pdu;
    }
    return found;
  }

  destroy(): void {
    for (const v of this.views.values()) v.root.destroy({ children: true });
    this.views.clear();
  }
}
