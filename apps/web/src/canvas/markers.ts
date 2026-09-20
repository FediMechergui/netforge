/**
 * Drop markers and collision bursts (spec §9.1 "Fading out — dropped, with a floating reason tag";
 * ARCHITECTURE-P1 §7 "collision burst").
 *
 * Drop markers: the store spawns a `DropMarker` for every `drop` trace event. A marker floats at
 *  - the midpoint of the station's association line when the drop names an association (Wi-Fi, cellular),
 *  - else the midpoint of its cable or radio beam when it names a link,
 *  - else above the device.
 * Markers at the same spot stack upward. Each shows a crossed badge plus the reason in original wording from the
 * drop vocabulary (and a short detail line when the engine gave one), rises slightly and fades out over
 * DROP_MARKER_MS of wall time. Clicking a marker selects its PDU.
 *
 * Collision bursts: every `collision` trace event on a hub segment flashes a jagged starburst on the cable of each
 * station that detected it (above the device when the station has no cable on the canvas), labelled "collision"
 * or "late collision" — shape and text, never colour alone. Under reduced motion the burst is static.
 */
import { Container, Graphics, type Text } from 'pixi.js';
import type { LinkId, PduId, PortRef, TraceEvent } from '@netforge/engine';
import { DROP_MARKER_MS, type DropMarker } from '../store/types';
import { dropTag } from '../vocab/drops';
import { bezierAt, type CableGeom, type Pt } from './cables';
import type { Layout } from './ports';
import { makeText, setText, type ThemeColors } from './scene';

/** Wall time a collision burst stays on screen. */
export const COLLISION_BURST_MS = 1400;
/** Live bursts kept at most (a collision storm cannot grow the list unbounded). */
export const MAX_COLLISION_BURSTS = 60;

/** Title and optional detail line for a marker (vocabulary wording; `other` shows its detail as the title). */
export function dropReasonText(reason: string, detail?: string): { title: string; detail: string } {
  return dropTag(reason, detail);
}

/** Where a drop marker floats. */
export interface MarkerAnchorSource {
  layout: Pick<Layout, 'devices'>;
  /** Cable or beam path of a link. */
  linkGeometry(link: LinkId): CableGeom | undefined;
  /** Station ↔ AP segment of an association. */
  assocGeometry(id: string): CableGeom | undefined;
}

/** Base point and stacking key of a marker, or undefined when nothing it names is on the canvas. */
export function markerAnchor(at: DropMarker['at'], src: MarkerAnchorSource): { x: number; y: number; key: string } | undefined {
  if (at.association !== undefined) {
    const geom = src.assocGeometry(at.association);
    if (geom) {
      const p = bezierAt(geom, 0.5);
      return { x: p.x, y: p.y - 10, key: `a:${at.association}` };
    }
  }
  if (at.link !== undefined) {
    const geom = src.linkGeometry(at.link);
    if (geom) {
      const p = bezierAt(geom, 0.5);
      return { x: p.x, y: p.y - 10, key: `l:${at.link}` };
    }
  }
  if (at.device !== undefined) {
    const g = src.layout.devices.get(at.device);
    if (g) return { x: g.x, y: g.y - g.halfH - 10, key: `d:${at.device}` };
  }
  return undefined;
}

/** One live collision burst. */
export interface CollisionBurst {
  id: number;
  segment: string;
  stations: PortRef[];
  late: boolean;
  wallCreated: number;
}

/**
 * Where a station's burst is drawn: 40 % along its cable from the station (so bursts of two stations on one hub
 * do not overlap), else above its device.
 */
export function burstPoint(station: PortRef, src: MarkerAnchorSource, linkEnds: (link: LinkId) => { a: PortRef } | undefined): Pt | undefined {
  const g = src.layout.devices.get(station.device);
  if (!g) return undefined;
  const port = g.device.ports.find((p) => p.id === station.port);
  if (port?.link !== undefined) {
    const geom = src.linkGeometry(port.link);
    const ends = linkEnds(port.link);
    if (geom && ends) {
      const fromA = ends.a.device === station.device && ends.a.port === station.port;
      return bezierAt(geom, fromA ? 0.4 : 0.6);
    }
  }
  return { x: g.x, y: g.y - g.halfH - 14 };
}

/** Points of a jagged starburst (flat [x, y, …]) with `spikes` points. */
export function starburstPoints(cx: number, cy: number, outer: number, inner: number, spikes = 8): number[] {
  const pts: number[] = [];
  for (let i = 0; i < spikes * 2; i++) {
    const r = i % 2 === 0 ? outer : inner;
    const a = -Math.PI / 2 + (Math.PI * i) / spikes;
    pts.push(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
  }
  return pts;
}

/**
 * Index just past `last` in `events` (searched from the end), or 0 when `last` is not there (new epoch, or the
 * ring dropped it).
 */
export function indexAfter(events: readonly TraceEvent[], last: TraceEvent | null): number {
  if (last === null) return 0;
  for (let i = events.length - 1; i >= 0; i--) if (events[i] === last) return i + 1;
  return 0;
}

class MarkerView {
  readonly root = new Container();
  readonly bg = new Graphics();
  readonly title: Text;
  readonly detail: Text;
  sig = '';
  seen = 0;
  pdu: PduId = 0;
  w = 0;
  h = 0;
  /** World-space hit box. */
  box = { minX: 0, minY: 0, maxX: 0, maxY: 0 };

  constructor(theme: ThemeColors) {
    this.title = makeText('', 11, theme.text, theme.sans, 'bold');
    this.detail = makeText('', 9.5, theme.textDim, theme.mono);
    this.root.addChild(this.bg, this.title, this.detail);
  }
}

class BurstView {
  readonly root = new Container();
  readonly g = new Graphics();
  readonly label: Text;
  sig = '';
  seen = 0;

  constructor(theme: ThemeColors) {
    this.label = makeText('', 9, theme.text, theme.sans, 'bold');
    this.label.anchor.set(0.5, 0);
    this.root.addChild(this.g, this.label);
  }
}

export interface MarkerUpdateInput extends MarkerAnchorSource {
  markers: readonly DropMarker[];
  wallNow: number;
  theme: ThemeColors;
  zoom: number;
  reducedMotion: boolean;
  selectedPdu: PduId | null;
  textResolution: number;
  /** Cable ends of a link (burst placement). */
  linkEnds(link: LinkId): { a: PortRef } | undefined;
}

export class MarkerLayer {
  private readonly views = new Map<number, MarkerView>();
  private readonly burstViews = new Map<string, BurstView>();
  private bursts: CollisionBurst[] = [];
  private nextBurstId = 1;
  private lastEvents: readonly TraceEvent[] | null = null;
  private lastSeen: TraceEvent | null = null;
  private primed = false;
  private generation = 0;

  constructor(private readonly root: Container) {}

  /**
   * Turn new `collision` events of the store's event ring into bursts. The first call only remembers where the
   * ring ends, so history from before the canvas mounted does not flash.
   */
  ingest(events: readonly TraceEvent[], wallNow: number): void {
    if (events === this.lastEvents) return;
    this.lastEvents = events;
    const tail = events.length > 0 ? (events[events.length - 1] ?? null) : null;
    if (!this.primed) {
      this.primed = true;
      this.lastSeen = tail;
      return;
    }
    const start = indexAfter(events, this.lastSeen);
    for (let i = start; i < events.length; i++) {
      const ev = events[i];
      if (ev?.kind !== 'collision') continue;
      this.bursts.push({ id: this.nextBurstId++, segment: ev.segment, stations: ev.stations.map((s) => ({ ...s })), late: ev.late, wallCreated: wallNow });
    }
    if (this.bursts.length > MAX_COLLISION_BURSTS) this.bursts.splice(0, this.bursts.length - MAX_COLLISION_BURSTS);
    this.lastSeen = tail;
  }

  /** Forget bursts (new simulation generation). */
  clearBursts(): void {
    this.bursts = [];
  }

  /** Place and fade every live marker and burst. Returns how many are visible. */
  update(input: MarkerUpdateInput): number {
    const gen = ++this.generation;
    const { theme } = input;
    const scale = Math.min(1.4, Math.max(0.6, 1 / input.zoom));
    const stacks = new Map<string, number>();
    let visible = 0;

    for (const m of input.markers) {
      const age = input.wallNow - m.wallCreated;
      if (age < 0 || age >= DROP_MARKER_MS) continue;
      const base = markerAnchor(m.at, input);
      if (!base) continue;

      let view = this.views.get(m.id);
      if (!view) {
        view = new MarkerView(theme);
        this.views.set(m.id, view);
        this.root.addChild(view.root);
      }
      view.seen = gen;
      view.pdu = m.pdu;
      visible += 1;

      const selected = input.selectedPdu === m.pdu;
      const text = dropReasonText(m.reason, m.detail);
      const sig = `${text.title}|${text.detail}|${selected}|${theme.stamp}|${input.textResolution}`;
      if (sig !== view.sig) {
        view.sig = sig;
        this.layoutMarker(view, text, selected, theme, input.textResolution);
      }

      const slot = stacks.get(base.key) ?? 0;
      stacks.set(base.key, slot + 1);
      const frac = age / DROP_MARKER_MS;
      const rise = input.reducedMotion ? 0 : frac * 18;
      const x = base.x;
      const y = base.y - (rise + slot * (view.h + 4)) * scale;
      view.root.position.set(x, y);
      view.root.scale.set(scale);
      view.root.alpha = frac < 0.6 ? 1 : Math.max(0, 1 - (frac - 0.6) / 0.4);
      view.box = {
        minX: x - (view.w / 2) * scale,
        maxX: x + (view.w / 2) * scale,
        minY: y - view.h * scale,
        maxY: y,
      };
    }

    for (const [id, view] of this.views) {
      if (view.seen !== gen) {
        view.root.destroy({ children: true });
        this.views.delete(id);
      }
    }

    visible += this.updateBursts(input, gen, scale);
    return visible;
  }

  private updateBursts(input: MarkerUpdateInput, gen: number, scale: number): number {
    const { theme } = input;
    let visible = 0;
    this.bursts = this.bursts.filter((b) => input.wallNow - b.wallCreated < COLLISION_BURST_MS && input.wallNow >= b.wallCreated);
    for (const b of this.bursts) {
      const frac = (input.wallNow - b.wallCreated) / COLLISION_BURST_MS;
      for (const station of b.stations) {
        const p = burstPoint(station, input, input.linkEnds);
        if (!p) continue;
        const key = `${b.id}|${station.device}/${station.port}`;
        let view = this.burstViews.get(key);
        if (!view) {
          view = new BurstView(theme);
          this.burstViews.set(key, view);
          this.root.addChild(view.root);
        }
        view.seen = gen;
        visible += 1;
        const sig = `${b.late}|${theme.stamp}|${input.textResolution}`;
        if (sig !== view.sig) {
          view.sig = sig;
          const g = view.g;
          g.clear();
          g.poly(starburstPoints(0, 0, 11, 5, 8), true)
            .fill({ color: theme.bg, alpha: 0.9 })
            .stroke({ width: b.late ? 2.4 : 1.6, color: theme.warn, join: 'miter' });
          // a jagged zig-zag inside: the "clash" mark
          g.moveTo(-4, -3).lineTo(-1, 1).lineTo(1, -1).lineTo(4, 3).stroke({ width: 1.6, color: theme.warn, cap: 'round', join: 'round' });
          if (b.late) g.circle(0, 0, 14).stroke({ width: 1, color: theme.warn, alpha: 0.9 });
          setText(view.label, b.late ? 'late collision' : 'collision', theme.text, theme.sans, input.textResolution);
          view.label.position.set(0, b.late ? 15 : 12);
        }
        const pulse = input.reducedMotion ? 1 : 0.7 + 0.3 * Math.min(1, frac * 4);
        view.root.position.set(p.x, p.y);
        view.root.scale.set(scale * pulse);
        view.root.alpha = frac < 0.7 ? 1 : Math.max(0, 1 - (frac - 0.7) / 0.3);
      }
    }
    for (const [key, view] of this.burstViews) {
      if (view.seen !== gen) {
        view.root.destroy({ children: true });
        this.burstViews.delete(key);
      }
    }
    return visible;
  }

  /** Lay the pill out with its bottom-centre at the container origin. */
  private layoutMarker(view: MarkerView, text: { title: string; detail: string }, selected: boolean, theme: ThemeColors, res: number): void {
    setText(view.title, text.title, theme.text, theme.sans, res);
    setText(view.detail, text.detail, theme.textDim, theme.mono, res);
    view.detail.visible = text.detail !== '';

    const padX = 7;
    const badge = 12;
    const gap = 5;
    const titleW = view.title.width;
    const detailW = view.detail.visible ? view.detail.width : 0;
    const contentW = Math.max(titleW, detailW);
    const h = view.detail.visible ? 32 : 20;
    const w = padX + badge + gap + contentW + padX;
    view.w = w;
    view.h = h;

    const left = -w / 2;
    const top = -h;
    const g = view.bg;
    g.clear();
    g.roundRect(left, top, w, h, 6)
      .fill({ color: theme.panel, alpha: 0.96 })
      .stroke({ width: selected ? 2 : 1.3, color: selected ? theme.text : theme.err });
    // pointer notch towards the drop point
    g.poly([-4, 0, 4, 0, 0, 5], true).fill({ color: theme.err });
    // crossed badge
    const cx = left + padX + badge / 2;
    const cy = top + 10;
    g.circle(cx, cy, badge / 2).fill({ color: theme.err });
    g.moveTo(cx - 2.6, cy - 2.6).lineTo(cx + 2.6, cy + 2.6);
    g.moveTo(cx + 2.6, cy - 2.6).lineTo(cx - 2.6, cy + 2.6);
    g.stroke({ width: 1.6, color: theme.bg, cap: 'round' });

    const textX = left + padX + badge + gap;
    view.title.position.set(textX, top + 3);
    view.detail.position.set(textX, top + 18);
  }

  hit(wx: number, wy: number): PduId | undefined {
    let found: PduId | undefined;
    for (const v of this.views.values()) {
      if (v.root.alpha <= 0.05) continue;
      const b = v.box;
      if (wx >= b.minX && wx <= b.maxX && wy >= b.minY && wy <= b.maxY + 5) found = v.pdu;
    }
    return found;
  }

  destroy(): void {
    for (const v of this.views.values()) v.root.destroy({ children: true });
    for (const v of this.burstViews.values()) v.root.destroy({ children: true });
    this.views.clear();
    this.burstViews.clear();
    this.bursts = [];
  }
}
