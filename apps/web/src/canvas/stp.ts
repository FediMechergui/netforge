/**
 * canvas/stp.ts — the spanning-tree overlay layer (ARCHITECTURE-P2 §6, §3.6, D20; spec §9.6). @since P2 (W3 web-canvas).
 *
 * Draws the render model of `canvas/overlays/stp-model.ts` (one VLAN at a time, chosen by `topoOverlays.stpVlan`):
 *
 * - the ROOT bridge wears a crown above its icon with `ROOT v10`;
 * - every linked spanning-tree port carries its role LETTER (R/D/A/B) in a badge a little way out of the port, and a
 *   state GLYPH: a cross drawn over the cable where a blocking or discarding port holds frames (the non-colour
 *   channel of "blocked"), an open or half circle while it listens or learns, nothing when it forwards; an
 *   inconsistent port adds `!`;
 * - the ACTIVE TREE (links whose spanning-tree ends all forward) is a thick underlay below the cables; a blocked link
 *   has no underlay and its cross (never a dash pattern, D20); a converging link has a thin underlay;
 * - a port in a timed phase shows a DRAINING BAR under its letter: the fraction of the forward-delay phase still to
 *   run (`drainFraction` from `stateSince` / `nextTransitionAt`);
 * - a TOPOLOGY CHANGE (a bridge's counter went up between two models) plays a wave at the bridge's last change port:
 *   the starburst of `markers.ts` growing and fading over `STP_CHANGE_WAVE_MS` of wall time, labelled "topology
 *   change" (static under reduced motion).
 *
 * Two Pixi containers, like `L2Layer`: the underlay (`scene.layers.stp`) and `labels`. The pure helpers (geometry,
 * text forms) have no Pixi dependency; the keyboard outline reads the text forms so every fact drawn here is also
 * said (`stpPortFacts`, `stpDeviceFacts`, `stpLinkFacts`).
 */
import { Container, Graphics, type Text } from 'pixi.js';
import { portKey, type DeviceId, type LinkId, type PortId } from '@netforge/engine';
import { bezierTangent, geomBounds, sampleBezier, type CableGeom, type Pt } from './cables';
import type { OverlayFact } from './l2';
import { starburstPoints } from './markers';
import { STP_INCONSISTENT_GLYPH, newTopologyChanges, type StpOverlayModel, type StpPortMark } from './overlays/stp-model';
import type { Layout, PortAnchor } from './ports';
import { inflateRect, makeText, rectsIntersect, setText, viewKey, type Lod, type Rect, type ThemeColors } from './scene';

// ── geometry ─────────────────────────────────────────────────────────────────

/** World units the role letter sits out of its port along the cable. */
export const LETTER_INSET = 13;
/** World units the state cross sits out of its port along the cable (over the cable itself). */
export const CROSS_INSET = 28;
/** Wall time a topology-change wave plays. */
export const STP_CHANGE_WAVE_MS = 1600;
/** Live waves kept at most. */
export const MAX_CHANGE_WAVES = 40;

/** Where a port's role letter sits. */
export function letterPoint(anchor: Pick<PortAnchor, 'x' | 'y' | 'nx' | 'ny'>, pxq = 1): Pt {
  return { x: anchor.x + anchor.nx * LETTER_INSET * pxq, y: anchor.y + anchor.ny * LETTER_INSET * pxq };
}

/** Where a port's state cross sits (on the cable, further out than the letter). */
export function crossPoint(anchor: Pick<PortAnchor, 'x' | 'y' | 'nx' | 'ny'>, pxq = 1): Pt {
  return { x: anchor.x + anchor.nx * CROSS_INSET * pxq, y: anchor.y + anchor.ny * CROSS_INSET * pxq };
}

/** Points (flat [x, y, …]) of a three-peak crown of width `w` and height `h`, its base centred on (cx, cy). */
export function crownPoints(cx: number, cy: number, w: number, h: number): number[] {
  const l = cx - w / 2;
  const r = cx + w / 2;
  const top = cy - h;
  const dip = cy - h * 0.45;
  return [l, cy, l, top, cx - w * 0.25, dip, cx, top - h * 0.15, cx + w * 0.25, dip, r, top, r, cy];
}

/** The draining bar under a letter badge: its frame and the filled part for `fraction` (1 = full, 0 = drained). */
export function drainBarRect(at: Pt, fraction: number, pxq = 1): { x: number; y: number; w: number; h: number; fillW: number } {
  const w = 18 * pxq;
  const h = 3 * pxq;
  const f = Math.min(1, Math.max(0, fraction));
  return { x: at.x - w / 2, y: at.y + 8 * pxq, w, h, fillW: w * f };
}

/** Underlay width of a link in the drawn tree: thick when active, thin while converging, none otherwise. */
export function treeWidth(status: StpOverlayModel['links'][number]['status'], pxq = 1): number {
  if (status === 'active') return 9 * pxq;
  if (status === 'converging') return 4 * pxq;
  return 0;
}

/** Radius of the topology-change wave's ring at `frac` (0 → 1) of its life. */
export function changeWaveRadius(frac: number): number {
  return 10 + 34 * Math.min(1, Math.max(0, frac));
}

/** Alpha of the topology-change wave at `frac` of its life: full for the first half, then fading out. */
export function changeWaveAlpha(frac: number): number {
  if (frac < 0.5) return 1;
  return Math.max(0, 1 - (frac - 0.5) / 0.5);
}

/** True when the model has a port in a timed phase, so the canvas must rebuild it every frame for the draining bars. */
export function modelNeedsClock(model: StpOverlayModel | null): boolean {
  return model !== null && model.ports.some((p) => p.drain !== undefined);
}

// ── text forms (the keyboard outline) ────────────────────────────────────────

const ROLE_WORD: Readonly<Record<string, string>> = Object.freeze({
  root: 'root port',
  designated: 'designated port',
  alternate: 'alternate port',
  backup: 'backup port',
  disabled: 'disabled port',
});

const INCONSISTENCY_WORD: Readonly<Record<string, string>> = Object.freeze({
  root: 'root guard',
  loop: 'loop guard',
  pvid: 'native VLAN mismatch',
  type: 'a trunk faces this access port',
});

/** "spanning tree VLAN 1: alternate port, blocking (crossed), 50% of the timer left". */
export function describeStpMark(m: StpPortMark): string {
  const role = ROLE_WORD[m.role] ?? `${m.role} port`;
  let text = `spanning tree VLAN ${m.vlan}: ${role}, ${m.state}`;
  if (m.blocked) text += ' (crossed)';
  if (m.edge) text += ', edge port';
  if (m.protocol === 'stp') text += ', classic messages';
  if (m.inconsistent !== undefined) text += `, inconsistent (${INCONSISTENCY_WORD[m.inconsistent] ?? m.inconsistent})`;
  if (m.drain !== undefined) text += `, ${Math.round(m.drain * 100)}% of the timer left`;
  if (m.viaBundle !== undefined) text += `, through ${m.viaBundle}`;
  return text;
}

/** The short row form of a port mark: the letter, the glyph and the state. */
export function shortStpMark(m: StpPortMark): string {
  const glyph = m.glyph === '' ? '' : `${m.glyph} `;
  const bang = m.inconsistent === undefined ? '' : ` ${STP_INCONSISTENT_GLYPH}`;
  return `${m.letter} ${glyph}${m.state}${bang}`;
}

/** Text facts of the spanning-tree overlay per port (`portKey`). */
export function stpPortFacts(model: StpOverlayModel | null): ReadonlyMap<string, OverlayFact> {
  const out = new Map<string, OverlayFact>();
  if (model === null) return out;
  for (const m of model.ports) out.set(portKey({ device: m.device, port: m.port }), { short: shortStpMark(m), text: describeStpMark(m) });
  return out;
}

/** Text facts per device: the crown, and the topology-change record. */
export function stpDeviceFacts(model: StpOverlayModel | null): ReadonlyMap<DeviceId, OverlayFact> {
  const out = new Map<DeviceId, OverlayFact>();
  if (model === null) return out;
  const roots = new Set(model.roots.map((r) => r.device));
  for (const c of model.changes) {
    const parts: string[] = [];
    const shorts: string[] = [];
    if (roots.has(c.device)) {
      parts.push(`root bridge for VLAN ${c.vlan}`);
      shorts.push(`ROOT v${c.vlan}`);
    }
    if (c.count > 0) {
      parts.push(`${c.count} topology ${c.count === 1 ? 'change' : 'changes'}${c.port !== undefined ? `, the last at ${c.port}` : ''}`);
      shorts.push(`TC ${c.count}`);
    }
    if (parts.length === 0) continue;
    out.set(c.device, { short: shorts.join(' · '), text: parts.join(', ') });
  }
  return out;
}

/** Text facts per link: its place in the drawn VLAN's tree. */
export function stpLinkFacts(model: StpOverlayModel | null): ReadonlyMap<LinkId, OverlayFact> {
  const out = new Map<LinkId, OverlayFact>();
  if (model === null) return out;
  const blockedAt = new Map<LinkId, string[]>();
  for (const m of model.ports) if (m.blocked) blockedAt.set(m.link, [...(blockedAt.get(m.link) ?? []), `${m.device} ${m.port}`]);
  for (const l of model.links) {
    switch (l.status) {
      case 'active':
        out.set(l.link, { short: 'in the tree', text: `in the spanning tree of VLAN ${model.vlan ?? ''}`.trimEnd() });
        break;
      case 'blocked':
        out.set(l.link, { short: '✕ blocked', text: `blocked by spanning tree at ${(blockedAt.get(l.link) ?? []).join(' and ')}` });
        break;
      case 'converging':
        out.set(l.link, { short: 'converging', text: 'joining the spanning tree' });
        break;
      default:
        break;
    }
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

interface ChangeWave {
  id: number;
  x: number;
  y: number;
  wallCreated: number;
  label: Text;
}

export interface StpSyncInput {
  /** The registry's render model, or null when the overlay is off. */
  model: StpOverlayModel | null;
  layout: Layout;
  theme: ThemeColors;
  zoom: number;
  lod: Lod;
  view: Rect;
  textResolution: number;
  /** Wall clock (ms), for the change waves. */
  wall: number;
  cableGeometry(link: LinkId): CableGeom | undefined;
}

export class StpLayer {
  private readonly ground = new Graphics();
  private readonly glyphs = new Graphics();
  private readonly waves = new Graphics();
  private readonly badges = new Map<string, BadgeView>();
  private readonly labels: Container;
  private live: ChangeWave[] = [];
  private nextWaveId = 1;
  private prevModel: StpOverlayModel | null = null;
  private wavePxq = 1;
  private waveDrawn = false;
  private sig = '';
  private generation = 0;

  constructor(ground: Container, labels: Container) {
    this.labels = labels;
    ground.addChild(this.ground);
    labels.addChild(this.glyphs, this.waves);
  }

  sync(input: StpSyncInput): void {
    const { model, layout, theme } = input;
    const gen = ++this.generation;
    const view = inflateRect(input.view, 80 / Math.max(input.zoom, 1e-3));
    const zoomBucket = Math.round(Math.log2(Math.max(input.zoom, 1e-3)) * 4);
    const pxq = 1 / 2 ** (zoomBucket / 4);
    this.wavePxq = pxq;

    // topology-change waves (spawned on the counter going up, at the bridge's last change port)
    if (model !== null) {
      for (const change of newTopologyChanges(this.prevModel, model)) {
        const at = this.changePoint(change.device, change.port, layout);
        if (at === undefined) continue;
        const label = makeText('topology change', 9, theme.text, theme.sans, 'bold');
        label.anchor.set(0.5, 0);
        this.labels.addChild(label);
        this.live.push({ id: this.nextWaveId++, x: at.x, y: at.y, wallCreated: input.wall, label });
      }
      if (this.live.length > MAX_CHANGE_WAVES) for (const w of this.live.splice(0, this.live.length - MAX_CHANGE_WAVES)) w.label.destroy();
    }
    this.prevModel = model;

    const r = (p: Pt): string => `${Math.round(p.x)},${Math.round(p.y)}`;
    const parts: string[] = [String(theme.stamp), viewKey(input.view, input.zoom), input.lod, String(input.textResolution)];
    if (model !== null) {
      parts.push(String(model.vlan));
      for (const root of model.roots) {
        const g = layout.devices.get(root.device);
        parts.push(`R${root.device}|${g ? r(g) : '-'}|${root.label}`);
      }
      for (const l of model.links) {
        const geom = input.cableGeometry(l.link);
        parts.push(`L${l.link}|${geom ? `${r(geom.p0)}|${r(geom.p3)}` : '-'}|${l.status}`);
      }
      for (const p of model.ports) {
        parts.push(`P${p.device}/${p.port}|${p.letter}|${p.state}|${p.inconsistent ?? ''}|${p.drain === undefined ? '' : Math.round(p.drain * 40)}`);
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
      // the tree
      for (const l of model.links) {
        const width = treeWidth(l.status, pxq);
        if (width === 0) continue;
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
        g.stroke({ width, color: theme.ok, alpha: l.status === 'active' ? 0.55 : 0.35, cap: 'round', join: 'round' });
      }
      // crowns
      for (const root of model.roots) {
        const geom = layout.devices.get(root.device);
        if (!geom) continue;
        const cx = geom.x;
        const cy = geom.y - geom.halfH - 6 * pxq;
        if (cx < view.minX || cx > view.maxX || cy < view.minY || cy > view.maxY) continue;
        glyphs.poly(crownPoints(cx, cy, 22 * pxq, 11 * pxq), true).fill({ color: theme.yellow, alpha: 0.95 }).stroke({ width: 1.2 * pxq, color: theme.text, alpha: 0.85 });
        if (showText) {
          const badge = this.badge(`crown:${root.device}`, theme, 8, false, gen);
          setText(badge.text, root.label, theme.text, theme.sans, input.textResolution);
          badge.text.anchor.set(0.5, 1);
          badge.text.position.set(cx, cy - 12 * pxq);
          badge.text.scale.set(pxq);
          badge.text.visible = true;
        }
      }
      // ports: letters, glyphs, draining bars
      for (const p of model.ports) {
        const anchor = layout.edge.get(portKey({ device: p.device, port: p.port }));
        if (anchor === undefined) continue;
        const at = letterPoint(anchor, pxq);
        if (at.x < view.minX || at.x > view.maxX || at.y < view.minY || at.y > view.maxY) continue;
        if (p.blocked) {
          const geom = input.cableGeometry(p.link);
          const c = crossPoint(anchor, pxq);
          const tan = geom ? bezierTangent(geom, p.end === 'a' ? 0.12 : 0.88) : { x: 1, y: 0 };
          this.drawCross(glyphs, c, tan, pxq, theme);
        }
        if (!showText) continue;
        const badge = this.badge(`port:${p.device}/${p.port}`, theme, 8, true, gen);
        const label = `${p.letter}${p.inconsistent === undefined ? '' : STP_INCONSISTENT_GLYPH}`;
        setText(badge.text, label, p.blocked ? theme.err : theme.text, theme.mono, input.textResolution);
        badge.text.anchor.set(0.5);
        const w = Math.max(12, badge.text.width + 6);
        glyphs
          .roundRect(at.x - (w / 2) * pxq, at.y - 6 * pxq, w * pxq, 12 * pxq, 3 * pxq)
          .fill({ color: theme.panel, alpha: 0.95 })
          .stroke({ width: (p.inconsistent === undefined ? 1 : 1.8) * pxq, color: p.blocked || p.inconsistent !== undefined ? theme.err : p.state === 'forwarding' ? theme.ok : theme.warn });
        badge.text.position.set(at.x, at.y);
        badge.text.scale.set(pxq);
        badge.text.visible = true;
        if (p.glyph !== '' && !p.blocked) {
          // listening: open circle; learning: half circle — beside the letter, away from the port
          const gx = at.x + (w / 2 + 5) * pxq;
          const gy = at.y;
          glyphs.circle(gx, gy, 3.2 * pxq).stroke({ width: 1.2 * pxq, color: theme.warn });
          if (p.state === 'learning') {
            glyphs.moveTo(gx, gy - 3.2 * pxq).arc(gx, gy, 3.2 * pxq, -Math.PI / 2, Math.PI / 2).lineTo(gx, gy - 3.2 * pxq).fill({ color: theme.warn });
          }
        }
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
  }

  /**
   * Play the change waves. Returns true while a wave is alive (so the canvas keeps rendering); under reduced motion
   * a wave is drawn once as a static starburst and the layer goes quiet until the next change.
   */
  animate(wall: number, reducedMotion: boolean, theme: ThemeColors): boolean {
    const expired = this.live.filter((w) => wall - w.wallCreated >= STP_CHANGE_WAVE_MS || wall < w.wallCreated);
    if (expired.length > 0) {
      for (const w of expired) w.label.destroy();
      this.live = this.live.filter((w) => !expired.includes(w));
      this.waveDrawn = false;
    }
    if (this.live.length === 0) {
      if (this.waveDrawn || expired.length > 0) this.waves.clear();
      this.waveDrawn = false;
      return false;
    }
    if (reducedMotion && this.waveDrawn) return false;
    const g = this.waves;
    g.clear();
    const pxq = this.wavePxq;
    for (const w of this.live) {
      const frac = reducedMotion ? 0.25 : (wall - w.wallCreated) / STP_CHANGE_WAVE_MS;
      const alpha = changeWaveAlpha(frac);
      const radius = changeWaveRadius(frac) * pxq;
      g.poly(starburstPoints(w.x, w.y, 11 * pxq, 5 * pxq, 8), true).fill({ color: theme.bg, alpha: 0.9 * alpha }).stroke({ width: 1.6 * pxq, color: theme.warn, alpha, join: 'miter' });
      g.circle(w.x, w.y, radius).stroke({ width: 1.4 * pxq, color: theme.warn, alpha: alpha * 0.8 });
      w.label.position.set(w.x, w.y + 13 * pxq);
      w.label.scale.set(pxq);
      w.label.alpha = alpha;
    }
    this.waveDrawn = true;
    return !reducedMotion;
  }

  private changePoint(device: DeviceId, port: PortId | undefined, layout: Layout): Pt | undefined {
    if (port !== undefined) {
      const anchor = layout.edge.get(portKey({ device, port }));
      if (anchor !== undefined) return crossPoint(anchor, 1);
    }
    const g = layout.devices.get(device);
    return g === undefined ? undefined : { x: g.x, y: g.y - g.halfH - 14 };
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

  private drawCross(glyphs: Graphics, c: Pt, tan: Pt, pxq: number, theme: ThemeColors): void {
    const len = Math.hypot(tan.x, tan.y) || 1;
    const tx = tan.x / len;
    const ty = tan.y / len;
    const s = 5 * pxq;
    // a disc that breaks the cable, then the cross
    glyphs.circle(c.x, c.y, 7 * pxq).fill({ color: theme.bg, alpha: 0.95 }).stroke({ width: 1.2 * pxq, color: theme.err });
    const nx = -ty;
    const ny = tx;
    glyphs
      .moveTo(c.x + (tx + nx) * s, c.y + (ty + ny) * s)
      .lineTo(c.x - (tx + nx) * s, c.y - (ty + ny) * s)
      .moveTo(c.x + (tx - nx) * s, c.y + (ty - ny) * s)
      .lineTo(c.x - (tx - nx) * s, c.y - (ty - ny) * s)
      .stroke({ width: 2 * pxq, color: theme.err, cap: 'round' });
  }

  destroy(): void {
    for (const b of this.badges.values()) b.text.destroy();
    this.badges.clear();
    for (const w of this.live) w.label.destroy();
    this.live = [];
    this.ground.destroy();
    this.glyphs.destroy();
    this.waves.destroy();
  }
}
