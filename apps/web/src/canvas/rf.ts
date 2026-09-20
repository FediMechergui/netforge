/**
 * Wireless coverage overlay: range rings and channel labels (ARCHITECTURE-P1 §7 "Wireless overlays").
 *
 *  • Range rings: one dashed circle per access radio (Wi-Fi AP, cell tower, PtP radio) with radius
 *    `radio.rangeM / metresPerUnit` world units — the distance at which the engine's RSSI crosses the connect
 *    threshold. The canvas never computes RF itself; it only draws `PortSnapshot.radio`. The dash pattern
 *    encodes the band (non-colour channel) and a small text names the band and range. A radio that is not
 *    operating is drawn faint and dotted with "(idle)". Stations get a ring only while their device is selected.
 *  • Channel labels: "<SSID> · 5 GHz ch 36" (or "cellular") next to each radio's antenna.
 *
 * Both are toggled by `store.overlays.rangeRings` / `channelLabels`. Rings are culled against the view (a ring
 * that encloses the whole view, or lies outside it, is skipped) and dashed with at most MAX_RING_DASHES pieces.
 */
import { Container, Graphics, type Text } from 'pixi.js';
import type { DeviceId, RadioPortView, RfBand, Selection } from '@netforge/engine';
import { antennaPoints, isRadioPort, type Layout } from './ports';
import { inflateRect, makeText, setText, type Lod, type Rect, type ThemeColors } from './scene';

/** Engine default scale (Topology.canvas.metresPerUnit) when the snapshot carries no media section. */
export const DEFAULT_METRES_PER_UNIT = 0.25;
/** Upper bound of dash pieces per ring (huge rings get longer dashes). */
export const MAX_RING_DASHES = 360;

/** Ring radius in world units. */
export function ringRadius(rangeM: number, metresPerUnit: number): number {
  const mpu = metresPerUnit > 0 && Number.isFinite(metresPerUnit) ? metresPerUnit : DEFAULT_METRES_PER_UNIT;
  if (!(rangeM > 0) || !Number.isFinite(rangeM)) return 0;
  return rangeM / mpu;
}

/** Screen-space dash pattern (pixels) per band: the band is readable without colour. */
export const BAND_DASH: Readonly<Record<RfBand, readonly number[]>> = Object.freeze({
  '2.4': [14, 6],
  '5': [6, 5],
  '6': [12, 4, 2, 4],
  '60': [2, 4],
  cell: [20, 5, 3, 5, 3, 5],
});

/** Human band name. */
export function bandLabel(band: RfBand): string {
  return band === 'cell' ? 'cellular' : `${band} GHz`;
}

/** `LAB · 2.4 GHz ch 6`, `5 GHz ch 149`, `cellular`. */
export function channelLabel(radio: Pick<RadioPortView, 'band' | 'channel' | 'ssid' | 'mode'>): string {
  const rf = radio.band === 'cell' ? 'cellular' : `${bandLabel(radio.band)} ch ${radio.channel}`;
  const ssid = radio.ssid !== undefined && radio.ssid !== '' && radio.mode !== 'ptp' ? `${radio.ssid} · ` : '';
  return `${ssid}${rf}`;
}

/** `45 m`, `1.2 km`. */
export function distanceLabel(m: number): string {
  if (m >= 1000) {
    const km = m / 1000;
    return `${km >= 10 ? Math.round(km) : Math.round(km * 10) / 10} km`;
  }
  return `${Math.round(m)} m`;
}

/** One ring to draw. */
export interface RingSpec {
  key: string;
  device: DeviceId;
  port: string;
  x: number;
  y: number;
  r: number;
  band: RfBand;
  up: boolean;
  mode: RadioPortView['mode'];
  rangeM: number;
  label: string;
}

/**
 * Rings for every operating-capable access radio (AP, tower, PtP), plus the station radios of `selectedDevice`.
 * Centred on the device (the antenna sits on top of the body, which is negligible at ring scale).
 */
export function rangeRings(layout: Pick<Layout, 'devices'>, metresPerUnit: number, selectedDevice: DeviceId | null = null): RingSpec[] {
  const out: RingSpec[] = [];
  for (const g of layout.devices.values()) {
    for (const port of g.device.ports) {
      const radio = port.radio;
      if (!radio) continue;
      const access = radio.mode === 'ap' || radio.mode === 'tower' || radio.mode === 'ptp';
      if (!access && g.device.id !== selectedDevice) continue;
      const r = ringRadius(radio.rangeM, metresPerUnit);
      if (r <= 0) continue;
      const up = g.device.power && (access ? radio.up || port.operUp : port.operUp || radio.state === 'associated' || radio.state === 'attached');
      out.push({
        key: `${g.device.id}/${port.id}`,
        device: g.device.id,
        port: port.id,
        x: g.x,
        y: g.y,
        r,
        band: radio.band,
        up,
        mode: radio.mode,
        rangeM: radio.rangeM,
        label: `${bandLabel(radio.band)} · ${distanceLabel(radio.rangeM)}${up ? '' : ' (idle)'}`,
      });
    }
  }
  return out;
}

/** True when some part of the circle outline lies inside `view`. */
export function ringVisible(cx: number, cy: number, r: number, view: Rect): boolean {
  if (cx + r < view.minX || cx - r > view.maxX || cy + r < view.minY || cy - r > view.maxY) return false;
  // farthest view corner inside the circle → the whole view is inside, the outline is not visible
  const fx = Math.max(Math.abs(view.minX - cx), Math.abs(view.maxX - cx));
  const fy = Math.max(Math.abs(view.minY - cy), Math.abs(view.maxY - cy));
  return fx * fx + fy * fy >= r * r;
}

/**
 * Angular spans [start, end] (radians, clockwise from +x) of the "on" dashes of a circle of radius `r` with a
 * world-unit `pattern`. The pattern is stretched so there are at most `maxDashes` pieces; an empty pattern
 * yields one full span.
 */
export function ringDashSpans(r: number, pattern: readonly number[], maxDashes = MAX_RING_DASHES): [number, number][] {
  const period = pattern.reduce((s, v) => s + Math.max(0, v), 0);
  if (r <= 0) return [];
  if (period <= 0) return [[0, Math.PI * 2]];
  const circumference = 2 * Math.PI * r;
  const onCount = Math.ceil(pattern.length / 2);
  // whole periods carry `onCount` dashes each and a partial period at most `onCount` more
  const budget = Math.max(1, maxDashes - onCount);
  const stretch = Math.max(1, (circumference * onCount) / (period * budget));
  const spans: [number, number][] = [];
  let s = 0;
  let i = 0;
  while (s < circumference && spans.length < maxDashes) {
    const len = Math.max(0, pattern[i % pattern.length] ?? 0) * stretch;
    const on = i % 2 === 0;
    if (on && len > 0) {
      const e = Math.min(circumference, s + len);
      spans.push([s / r, e / r]);
    }
    s += len;
    i += 1;
    if (len <= 0 && i > pattern.length * 2 && spans.length === 0) break;
  }
  return spans;
}

export interface RfSyncInput {
  layout: Layout;
  metresPerUnit: number;
  theme: ThemeColors;
  showRings: boolean;
  showChannels: boolean;
  selection: Selection | null;
  zoom: number;
  lod: Lod;
  view: Rect;
  textResolution: number;
}

class RingView {
  readonly text: Text;
  constructor(theme: ThemeColors) {
    this.text = makeText('', 10, theme.textDim, theme.sans);
    this.text.anchor.set(0, 1);
  }
}

class ChannelView {
  readonly text: Text;
  constructor(theme: ThemeColors) {
    this.text = makeText('', 9, theme.textDim, theme.mono);
    this.text.anchor.set(0.5, 1);
  }
}

export class RfLayer {
  private readonly rings = new Graphics();
  private readonly ringTexts = new Container();
  private readonly ringViews = new Map<string, RingView>();
  private readonly channelViews = new Map<string, ChannelView>();
  private sig = '';

  constructor(
    ground: Container,
    private readonly labels: Container,
  ) {
    ground.addChild(this.rings, this.ringTexts);
  }

  sync(input: RfSyncInput): void {
    const { theme } = input;
    const selectedDevice =
      input.selection?.kind === 'device' ? input.selection.id : input.selection?.kind === 'port' ? input.selection.ref.device : null;
    const rings = input.showRings ? rangeRings(input.layout, input.metresPerUnit, selectedDevice) : [];
    const view = inflateRect(input.view, 40 / Math.max(input.zoom, 1e-3));
    const visible = rings.filter((r) => ringVisible(r.x, r.y, r.r, view));
    const zoomBucket = Math.round(Math.log2(Math.max(input.zoom, 1e-3)) * 4);

    // rings: one Graphics, redrawn only when the set, positions, theme or zoom bucket change
    const sig = [
      theme.stamp,
      zoomBucket,
      input.textResolution,
      input.lod,
      ...visible.map((r) => `${r.key}:${Math.round(r.x)},${Math.round(r.y)},${Math.round(r.r)},${r.band},${r.up ? 1 : 0}`),
    ].join('|');
    if (sig !== this.sig) {
      this.sig = sig;
      this.drawRings(visible, input, zoomBucket);
    }

    this.syncChannels(input);
  }

  private drawRings(rings: readonly RingSpec[], input: RfSyncInput, zoomBucket: number): void {
    const { theme } = input;
    const g = this.rings;
    g.clear();
    const pxToWorld = 1 / 2 ** (zoomBucket / 4);
    const seen = new Set<string>();
    for (const ring of rings) {
      const pattern = (ring.up ? BAND_DASH[ring.band] : [2, 6]).map((v) => v * pxToWorld);
      for (const [a0, a1] of ringDashSpans(ring.r, pattern)) {
        g.moveTo(ring.x + ring.r * Math.cos(a0), ring.y + ring.r * Math.sin(a0));
        g.arc(ring.x, ring.y, ring.r, a0, a1, false);
      }
      g.stroke({ width: 1.6 * pxToWorld, color: ring.up ? theme.accent : theme.textFaint, alpha: ring.up ? 0.75 : 0.5, cap: 'butt' });
      if (ring.up) {
        g.circle(ring.x, ring.y, ring.r).fill({ color: theme.accent, alpha: 0.035 });
      }

      if (input.lod === 'far' && input.zoom < 0.1) continue;
      seen.add(ring.key);
      let view = this.ringViews.get(ring.key);
      if (!view) {
        view = new RingView(theme);
        this.ringViews.set(ring.key, view);
        this.ringTexts.addChild(view.text);
      }
      setText(view.text, ring.label, ring.up ? theme.textDim : theme.textFaint, theme.sans, input.textResolution);
      // at the upper-right of the ring (45°), kept at a constant screen size
      const a = -Math.PI / 4;
      view.text.position.set(ring.x + ring.r * Math.cos(a) + 3 * pxToWorld, ring.y + ring.r * Math.sin(a) - 2 * pxToWorld);
      view.text.scale.set(pxToWorld);
      view.text.visible = true;
    }
    for (const [key, view] of this.ringViews) {
      if (!seen.has(key)) {
        view.text.destroy();
        this.ringViews.delete(key);
      }
    }
  }

  private syncChannels(input: RfSyncInput): void {
    const { theme, layout } = input;
    const seen = new Set<string>();
    if (input.showChannels && input.lod !== 'far') {
      const view = inflateRect(input.view, 60 / Math.max(input.zoom, 1e-3));
      for (const g of layout.devices.values()) {
        if (g.x < view.minX || g.x > view.maxX || g.y < view.minY || g.y > view.maxY) continue;
        const radios = g.device.ports.filter(isRadioPort);
        if (radios.length === 0) continue;
        const pts = antennaPoints(g, radios.length);
        radios.forEach((port, i) => {
          const radio = port.radio;
          const p = pts[i];
          if (!radio || !p) return;
          // station radios show their channel only while associated
          if ((radio.mode === 'station' || radio.mode === 'ue') && !port.operUp) return;
          const key = `${g.device.id}/${port.id}`;
          seen.add(key);
          let cv = this.channelViews.get(key);
          if (!cv) {
            cv = new ChannelView(theme);
            this.channelViews.set(key, cv);
            this.labels.addChild(cv.text);
          }
          setText(cv.text, channelLabel(radio), theme.textDim, theme.mono, input.textResolution);
          // stacked above the antenna row, one line per radio
          cv.text.position.set(g.x, p.y - 8 - (radios.length - 1 - i) * 11);
          cv.text.visible = true;
        });
      }
    }
    for (const [key, cv] of this.channelViews) {
      if (!seen.has(key)) {
        cv.text.destroy();
        this.channelViews.delete(key);
      }
    }
  }

  destroy(): void {
    for (const v of this.ringViews.values()) v.text.destroy();
    for (const v of this.channelViews.values()) v.text.destroy();
    this.ringViews.clear();
    this.channelViews.clear();
    this.rings.destroy();
    this.ringTexts.destroy({ children: true });
  }
}
