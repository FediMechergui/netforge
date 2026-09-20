// Canvas core geometry (ARCHITECTURE-P1 §7 "Canvas core", §8.1 W6 web-canvas): icon-driven body sizes, edge and
// antenna anchors, the grouped port picker (slot rows, console row, radios excluded), LED states, the camera
// view/culling/LOD helpers and the rendering geometry of cables.
import { describe, expect, it } from 'vitest';
import { MEDIA, portKey, type MediaType } from '@netforge/engine';
import { DEVICE_VISUALS, GENERIC_VISUAL, KIND_DEFAULT_ICON } from '../src/catalog/visuals.js';
import {
  ANTENNA_LIFT,
  GRID_SPACING,
  LABEL_BLOCK,
  PICKER_COLS,
  PICKER_GROUP_GAP,
  anchorOf,
  antennaPoints,
  bodySize,
  computeLayout,
  deviceBounds,
  deviceVisual,
  gridTop,
  isRadioLink,
  isRadioPort,
  layoutPicker,
  ledLabel,
  ledState,
  pickSide,
  pickerGroupLabel,
  pickerGroupOf,
  pickerGroups,
  portTitle,
  snapshotReplaced,
} from '../src/canvas/ports.js';
import {
  LOD_FAR_ZOOM,
  LOD_MID_ZOOM,
  ZOOM_MAX,
  ZOOM_MIN,
  inflateRect,
  lodFor,
  parseCssColor,
  rectsIntersect,
  viewKey,
  viewRect,
} from '../src/canvas/scene.js';
import {
  bezierAt,
  cableGeometry,
  cableStyle,
  dashPolyline,
  dashScaleFor,
  geomBounds,
  geometryBetween,
  sampleBezier,
  straightGeometry,
} from '../src/canvas/cables.js';
import { deviceStatusText } from '../src/canvas/devices.js';
import { MEDIA_VOCAB } from '../src/vocab/media.js';
import { TEST_THEME, device, link, port, snapshot, templateSnapshot } from './canvas-fixtures.js';

describe('device visuals and body size', () => {
  it('takes the body from the model icon, then the kind default, then the generic artwork', () => {
    const byIcon = deviceVisual({ kind: 'pc', icon: 'router' });
    expect(byIcon).toBe(DEVICE_VISUALS.router);
    expect(deviceVisual({ kind: 'switch' })).toBe(DEVICE_VISUALS[KIND_DEFAULT_ICON.switch]);
    expect(bodySize(byIcon)).toEqual({ halfW: byIcon.w / 2, halfH: byIcon.h / 2 });
    expect(bodySize(GENERIC_VISUAL).halfW).toBeGreaterThan(0);
  });

  it('adds a capability badge to badge-ready artwork only', () => {
    const plain = deviceVisual({ kind: 'mlswitch', icon: 'mlswitch' });
    const badged = deviceVisual({ kind: 'mlswitch', icon: 'mlswitch', capabilities: ['layer3-switch'] });
    expect(badged.badge).toBe('L3');
    expect(badged.w).toBe(plain.w);
  });

  it('names the model under generic artwork and states power/boot in words', () => {
    expect(deviceStatusText({ power: false, booted: false, model: 'NF-X' }, { id: 'pc' })).toBe('powered off');
    expect(deviceStatusText({ power: true, booted: false, model: 'NF-X' }, { id: 'pc' })).toBe('starting…');
    expect(deviceStatusText({ power: true, booted: true, model: 'NF-X' }, { id: 'pc' })).toBe('');
    expect(deviceStatusText({ power: true, booted: true, model: 'NF-X' }, { id: 'generic' })).toBe('NF-X');
  });
});

describe('port picker groups', () => {
  const chassis = device('r1', 0, 0, [
    port('Gi0/0', { group: 'front' }),
    port('Gi0/1'),
    port('Te0/2', { group: 'uplink' }),
    port('Serial0/1/0', { kind: 'serial', slot: 'hwic1', module: { slot: 'hwic1', module: 'mod.x' } }),
    port('Serial0/0/0', { kind: 'serial', slot: 'hwic0', module: { slot: 'hwic0', module: 'mod.x' } }),
    port('Serial0/0/1', { kind: 'serial', slot: 'hwic0', module: { slot: 'hwic0', module: 'mod.x' } }),
    port('Gi0/3/0', { group: 'slot:nim0' }),
    port('Radio0', { kind: 'radio', role: 'radio-ptp' }),
    port('Wlan0', { kind: 'wlan', role: 'wireless-bss' }),
    port('Cellular0', { kind: 'cellular', role: 'cellular' }),
    port('Vlan1', { kind: 'virtual', role: 'svi', virtual: true }),
    port('Loop', { linkable: false }),
    port('Console', { kind: 'console', role: 'console' }),
    port('Usb0', { kind: 'usb' }),
  ], { slots: [
    { id: 'hwic0', label: 'HWIC slot 0', type: 'hwic', accepts: [] },
    { id: 'hwic1', label: 'HWIC slot 1', type: 'hwic', accepts: [] },
  ] });

  it('classifies ports and never offers Wi-Fi, cellular or virtual interfaces', () => {
    const kinds = Object.fromEntries(chassis.ports.map((p) => [p.id, pickerGroupOf(p)?.kind ?? null]));
    expect(kinds).toEqual({
      'Gi0/0': 'front',
      'Gi0/1': 'front',
      'Te0/2': 'uplink',
      'Serial0/1/0': 'slot',
      'Serial0/0/0': 'slot',
      'Serial0/0/1': 'slot',
      'Gi0/3/0': 'slot',
      Radio0: 'radio',
      Wlan0: null,
      Cellular0: null,
      Vlan1: null,
      Loop: null,
      Console: 'console',
      Usb0: 'console',
    });
  });

  it('orders front, uplinks, slots in chassis order (unknown slots after), radio and console last', () => {
    const groups = pickerGroups(chassis);
    expect(groups.map((g) => g.key)).toEqual(['front', 'uplink', 'slot:hwic0', 'slot:hwic1', 'slot:nim0', 'radio', 'console']);
    expect(groups.map((g) => g.label)).toEqual(['', 'Uplinks', 'HWIC slot 0', 'HWIC slot 1', 'Slot nim0', 'Radio', 'Console']);
    expect(groups.find((g) => g.key === 'slot:hwic0')?.ports.map((p) => p.id)).toEqual(['Serial0/0/0', 'Serial0/0/1']);
    expect(pickerGroupLabel('slot')).toBe('Module');
  });

  it('wraps long groups into rows, labels only the first row and separates groups', () => {
    const many = device('sw', 100, 50, Array.from({ length: 26 }, (_, i) => port(`Fa0/${i + 1}`)).concat([port('Console', { kind: 'console' })]));
    const g = { x: 100, y: 50, halfH: 20 };
    const { geom, dots } = layoutPicker(g, pickerGroups(many));
    expect(geom.rows.map((r) => [r.kind, r.count, r.label])).toEqual([
      ['front', PICKER_COLS, ''],
      ['front', PICKER_COLS, ''],
      ['front', 2, ''],
      ['console', 1, 'Console'],
    ]);
    const top = gridTop(g);
    expect(top).toBe(50 + 20 + LABEL_BLOCK + 4);
    expect(geom.rows.map((r) => r.y)).toEqual([top, top + GRID_SPACING, top + 2 * GRID_SPACING, top + 3 * GRID_SPACING + PICKER_GROUP_GAP]);
    // the dot block is centred on the device and every row starts at its left edge
    expect(geom.halfW).toBe(((PICKER_COLS - 1) * GRID_SPACING) / 2);
    expect(geom.rows.every((r) => r.x0 === 100 - geom.halfW)).toBe(true);
    expect(dots).toHaveLength(27);
    expect(dots[PICKER_COLS]).toMatchObject({ x: 100 - geom.halfW, y: top + GRID_SPACING });
    expect(geom.bottom).toBe(geom.rows[3]?.y);
  });
});

describe('computeLayout', () => {
  const a = device('a', 0, 0, [port('p1', { link: 'l1' }), port('p2', { link: 'l2' }), port('r', { kind: 'radio', role: 'radio-ptp', link: 'lr' })]);
  const b = device('b', 300, -100, [port('p1', { link: 'l1' })]);
  const c = device('c', 300, 100, [port('p1', { link: 'l2' })]);
  const d = device('d', 0, -900, [port('r', { kind: 'radio', role: 'radio-ptp', link: 'lr' }), port('w', { kind: 'wlan', role: 'wireless-client' })]);
  const snap = snapshot([a, b, c, d], [
    link('l1', ['a', 'p1'], ['b', 'p1']),
    link('l2', ['a', 'p2'], ['c', 'p1']),
    link('lr', ['a', 'r'], ['d', 'r'], { kind: 'radio', media: 'radio', resolvedMedia: 'radio' }),
  ]);

  it('puts cable ends on the side facing the peer, ordered by the peer position', () => {
    const layout = computeLayout(snap, new Map());
    const g = layout.devices.get('a');
    expect(g).toBeDefined();
    const e1 = layout.edge.get('a/p1');
    const e2 = layout.edge.get('a/p2');
    expect(e1).toMatchObject({ nx: 1, ny: 0 });
    expect(e2).toMatchObject({ nx: 1, ny: 0 });
    expect(e1?.x).toBe((g?.x ?? 0) + (g?.halfW ?? 0));
    // b is above c, so a's port towards b sits higher on the right edge
    expect((e1?.y ?? 0) < (e2?.y ?? 0)).toBe(true);
    expect(layout.edge.get('b/p1')).toMatchObject({ nx: -1, ny: 0 });
    expect(pickSide(0, -50, { halfW: 20, halfH: 20 })).toBe('top');
  });

  it('gives radio ports antenna anchors and never edge anchors for radio links', () => {
    const layout = computeLayout(snap, new Map());
    expect(layout.edge.has('a/r')).toBe(false);
    expect(layout.edge.has('d/r')).toBe(false);
    const g = layout.devices.get('d');
    const ant = layout.antenna.get('d/r');
    expect(ant).toMatchObject({ ny: -1 });
    expect(ant?.y).toBe((g?.y ?? 0) - (g?.halfH ?? 0) - ANTENNA_LIFT);
    expect(layout.antenna.has('d/w')).toBe(true);
    expect(anchorOf(layout, 'd/r')).toBe(ant);
    expect(anchorOf(layout, 'a/p1')).toBe(layout.edge.get('a/p1'));
    expect(antennaPoints({ x: 0, y: 0, halfH: 10 }, 3).map((p) => p.x)).toEqual([-14, 0, 14]);
    expect(isRadioLink(snap.links[2] as NonNullable<(typeof snap.links)[2]>)).toBe(true);
    expect(isRadioLink(snap.links[0] as NonNullable<(typeof snap.links)[0]>)).toBe(false);
    expect(isRadioPort({ kind: 'ethernet' })).toBe(false);
  });

  it('lays out the picker only on request and applies drag overrides', () => {
    expect(computeLayout(snap, new Map()).grid.size).toBe(0);
    const withPicker = computeLayout(snap, new Map([['a', { x: 40, y: 60 }]]), { picker: true });
    expect(withPicker.devices.get('a')).toMatchObject({ x: 40, y: 60 });
    expect([...withPicker.grid.keys()].sort()).toEqual(['a/p1', 'a/p2', 'a/r', 'b/p1', 'c/p1', 'd/r']);
    const ga = withPicker.devices.get('a');
    expect(ga?.picker?.rows.map((r) => r.kind)).toEqual(['front', 'radio']);
    // bounds include the picker and its row labels
    const inner = deviceBounds(ga as NonNullable<typeof ga>, false);
    const outer = deviceBounds(ga as NonNullable<typeof ga>, true);
    expect(outer.maxY).toBeGreaterThan(inner.maxY);
    expect(outer.minX).toBeLessThan(inner.minX);
    expect(computeLayout(null, new Map()).devices.size).toBe(0);
  });

  it('lays out real templates: a home router radio pair, hub cables and a radio beam', () => {
    const home = computeLayout(templateSnapshot('home-wifi'), new Map(), { picker: true });
    expect(home.antenna.has('home1/Wlan0')).toBe(true);
    expect(home.antenna.has('home1/Wlan1')).toBe(true);
    expect(home.antenna.has('laptop1/Wlan0')).toBe(true);
    expect(home.grid.has('home1/Wlan0')).toBe(false);
    expect(home.grid.has('home1/Vlan1')).toBe(false);
    expect(home.devices.get('home1')?.picker?.rows.map((r) => r.kind)).toEqual(['front', 'uplink']);

    const hub = computeLayout(templateSnapshot('hub-collision'), new Map());
    expect(['pc1', 'pc2', 'pc3'].every((id) => hub.edge.has(`${id}/GigabitEthernet0`))).toBe(true);
    expect(hub.edge.has('hub1/Ethernet3')).toBe(false);

    const radio = computeLayout(templateSnapshot('radio-bridge'), new Map(), { picker: true });
    expect(radio.edge.has('radio1/Radio0')).toBe(false);
    expect(radio.antenna.has('radio1/Radio0')).toBe(true);
    expect(radio.grid.has('radio1/Radio0')).toBe(true);
    expect(radio.devices.get('radio1')?.picker?.rows.map((r) => r.kind)).toEqual(['front', 'radio']);

    const serial = computeLayout(templateSnapshot('serial-pair'), new Map(), { picker: true });
    expect(serial.devices.get('r1')?.picker?.rows.map((r) => r.kind)).toEqual(['front', 'console']);
  });
});

describe('LEDs and port titles', () => {
  it('encodes state by shape family and says it in words', () => {
    expect(ledState({ operUp: true, adminUp: true })).toBe('up');
    expect(ledState({ operUp: false, adminUp: false })).toBe('off');
    expect(ledState({ operUp: false, adminUp: true })).toBe('down');
    expect(ledState({ operUp: false, adminUp: true, phy: { carrier: true, lineProtocol: false, lineProtocolReason: 'no-clock' } })).toBe('carrier');
    expect(ledState({ operUp: true, adminUp: true, errDisabled: 'bpdu' })).toBe('err');
    expect(new Set((['up', 'carrier', 'down', 'off', 'err'] as const).map(ledLabel)).size).toBe(5);
  });

  it('explains carrier-without-line-protocol and radio ports', () => {
    const d = device('r1', 0, 0, []);
    const serial = port('Serial0/0/0', { short: 'Se0/0/0', kind: 'serial', phy: { carrier: true, lineProtocol: false, lineProtocolReason: 'no-clock' } });
    expect(portTitle({ port: serial, device: d })).toBe('R1 Se0/0/0 — up, line protocol down (waiting for a clock from the DCE end) · free');
    const wlan = port('Wlan0', {
      kind: 'wlan',
      operUp: true,
      radio: { mode: 'ap', band: '5', channel: 36, widthMhz: 20, txPowerDbm: 20, up: true, rangeM: 100, ssid: 'LAB' },
    });
    expect(portTitle({ port: wlan, device: d })).toBe('R1 Wlan0 — radio on · "LAB" · 5 GHz ch 36');
  });
});

describe('camera view, culling and level of detail', () => {
  it('lets a 10 km radio link fit on a 2 000 px wide view', () => {
    expect(ZOOM_MIN).toBeLessThanOrEqual(0.05);
    expect((10_000 / 0.25) * ZOOM_MIN).toBeLessThanOrEqual(2000);
    expect(ZOOM_MAX).toBeGreaterThan(1);
  });

  it('computes the visible world rectangle and coarse view keys', () => {
    const v = viewRect({ x: -100, y: 50, zoom: 2 }, 800, 600);
    expect(v).toEqual({ minX: 50, minY: -25, maxX: 450, maxY: 275 });
    expect(viewKey(v, 2)).toBe(viewKey({ minX: 60, minY: -20, maxX: 460, maxY: 280 }, 2.05));
    expect(viewKey(v, 2)).not.toBe(viewKey({ minX: 160, minY: -25, maxX: 560, maxY: 275 }, 2));
    expect(viewKey(v, 2)).not.toBe(viewKey(v, 2.6));
    expect(rectsIntersect(v, { minX: 450, minY: 275, maxX: 500, maxY: 300 })).toBe(true);
    expect(rectsIntersect(v, { minX: 451, minY: 0, maxX: 500, maxY: 10 })).toBe(false);
    expect(inflateRect(v, 10)).toEqual({ minX: 40, minY: -35, maxX: 460, maxY: 285 });
  });

  it('drops detail as the camera zooms out', () => {
    expect(lodFor(1)).toBe('full');
    expect(lodFor(LOD_MID_ZOOM)).toBe('full');
    expect(lodFor(LOD_MID_ZOOM - 0.01)).toBe('mid');
    expect(lodFor(LOD_FAR_ZOOM)).toBe('mid');
    expect(lodFor(ZOOM_MIN)).toBe('far');
  });

  it('parses theme colours', () => {
    expect(parseCssColor('#abc', 0)).toBe(0xaabbcc);
    expect(parseCssColor(' #112233 ', 0)).toBe(0x112233);
    expect(parseCssColor('rgb(1, 2, 3)', 0)).toBe(0x010203);
    expect(parseCssColor('nonsense', 7)).toBe(7);
  });

  it('detects a replaced world for auto-fit', () => {
    const one = snapshot([device('a', 0, 0, [])]);
    const two = snapshot([device('b', 0, 0, [])]);
    expect(snapshotReplaced(one, two)).toBe(true);
    expect(snapshotReplaced(one, snapshot([device('a', 5, 5, []), device('c', 0, 0, [])]))).toBe(false);
    expect(snapshotReplaced(null, two)).toBe(false);
  });
});

describe('cable rendering geometry', () => {
  it('leaves each port along its normal and resolves only between edge anchors', () => {
    const g = geometryBetween({ x: 0, y: 0, nx: 1, ny: 0 }, { x: 100, y: 0, nx: -1, ny: 0 });
    expect(g.p1).toEqual({ x: 40, y: 0 });
    expect(g.p2).toEqual({ x: 60, y: 0 });
    expect(bezierAt(g, 0.5)).toEqual({ x: 50, y: 0 });
    const snap = snapshot([device('a', 0, 0, [port('p', { link: 'l' })]), device('b', 200, 0, [port('p', { link: 'l' })])], [link('l', ['a', 'p'], ['b', 'p'])]);
    const layout = computeLayout(snap, new Map());
    const l = snap.links[0];
    expect(l && cableGeometry(l, layout)).toBeDefined();
    expect(l && cableGeometry({ ...l, a: { device: 'a', port: 'x' } }, layout)).toBeUndefined();
    expect(geomBounds(straightGeometry({ x: 0, y: 5 }, { x: 9, y: -3 }))).toEqual({ minX: 0, minY: -3, maxX: 9, maxY: 5 });
    expect(sampleBezier(g, 4)).toHaveLength(5);
  });

  it('splits a polyline into dash pieces that keep the pattern lengths', () => {
    const line = [{ x: 0, y: 0 }, { x: 30, y: 0 }];
    const pieces = dashPolyline(line, [10, 5]);
    expect(pieces.map((p) => [p[0]?.x, p[p.length - 1]?.x])).toEqual([[0, 10], [15, 25]]);
    expect(dashPolyline(line, [])).toEqual([line]);
    expect(dashPolyline(line, [0, 0])).toEqual([line]);
    // a zero-length dash is skipped: the pattern continues with the following gap
    expect(dashPolyline(line, [0, 5, 10, 5]).map((p) => [p[0]?.x, p[p.length - 1]?.x])).toEqual([[5, 15], [25, 30]]);
    // the pattern carries across polyline corners
    const corner = dashPolyline([{ x: 0, y: 0 }, { x: 6, y: 0 }, { x: 6, y: 10 }], [8, 4]);
    expect(corner[0]).toEqual([{ x: 0, y: 0 }, { x: 6, y: 0 }, { x: 6, y: 2 }]);
    expect(dashPolyline([], [1, 1])).toEqual([]);
  });

  it('keeps dash patterns readable when zoomed out', () => {
    expect(dashScaleFor(1)).toBe(1);
    expect(dashScaleFor(0.3)).toBe(2);
    expect(dashScaleFor(0.05)).toBe(16);
  });

  it('gives every media a distinct non-colour line style', () => {
    const media = Object.keys(MEDIA) as MediaType[];
    const styles = media.map((m) => {
      const s = cableStyle(m, TEST_THEME);
      const dce = MEDIA[m].dceEnd ?? (m === 'serial' ? 'port' : '-');
      return `${s.stroke}|${s.dash.join(',')}|${s.widthFactor}|${dce}`;
    });
    expect(new Set(styles).size).toBe(media.length);
    expect(cableStyle('fiber-mm', TEST_THEME).badge).toBe(MEDIA_VOCAB['fiber-mm'].badge);
    expect(cableStyle('coax', TEST_THEME).widthFactor).toBeGreaterThan(cableStyle('console', TEST_THEME).widthFactor);
    expect(cableStyle('copper-straight', TEST_THEME).color).toBe(TEST_THEME[MEDIA_VOCAB['copper-straight'].color]);
  });

  it('keys cable ends by port', () => {
    expect(portKey({ device: 'a', port: 'Gi0/1' })).toBe('a/Gi0/1');
  });
});
