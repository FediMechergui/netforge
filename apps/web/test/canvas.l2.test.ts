// The VLAN overlay layer's pure parts (ARCHITECTURE-P2 §6, D20; W3 web-canvas): tint colours with their non-colour
// channel, chip and rail geometry, the mismatch pulse, the text forms the keyboard outline reads, the untagged VLAN
// of a port for packet colouring, and the scene's overlay containers matching the registry.
import { describe, expect, it } from 'vitest';
import { DEFAULT_SWITCHPORT } from '@netforge/engine';
import type { DeviceSnapshot, PortL2View, PortSnapshot, SwitchportConfig } from '@netforge/engine';
import {
  CHIP_INSET,
  DIM_ALPHA,
  TINT_SPAN,
  chipPoint,
  contrastRatio,
  contrastText,
  describeL2End,
  hslToRgb,
  isDarkTheme,
  l2LinkFacts,
  l2PortFacts,
  pulseAlpha,
  railTicks,
  railWidth,
  relativeLuminance,
  tintSpan,
  tintWidth,
  untaggedVlanOf,
  vlanColor,
} from '../src/canvas/l2.js';
import { buildL2Overlay, parseVlanList, vlanHue, type L2End } from '../src/canvas/overlays/l2-model.js';
import { OVERLAY_MODULES, VLAN_OVERLAY } from '../src/canvas/overlays/registry.js';
import { TOPO_LAYER_ORDER } from '../src/canvas/scene.js';
import { TEST_THEME, device, link, port, snapshot } from './canvas-fixtures.js';

const VLANS_TABLE = { name: 'vlans', title: 'VLANs', columns: [], rows: [] as Record<string, unknown>[] };

function switchDevice(id: string, ports: PortSnapshot[], vlans: number[] = [10, 20, 99]): DeviceSnapshot {
  return device(id, 0, 0, ports, {
    type: 'switch.nfc2960',
    model: 'NF-C2960',
    kind: 'switch',
    tables: { cam: [], arp: [], rib: [], extra: [{ ...VLANS_TABLE, rows: vlans.map((v) => ({ key: String(v), vlan: v, name: `VLAN${v}`, status: 'active', source: 'config' })) }] },
  });
}

function sw(config: Partial<SwitchportConfig>, extra: Partial<PortL2View> = {}): PortL2View {
  return { config: { ...DEFAULT_SWITCHPORT, ...config }, oper: extra.oper ?? 'access', ...extra };
}

function switchPort(id: string, l2: PortL2View | undefined, linkId: string): PortSnapshot {
  return port(id, { short: id, role: 'switched', operUp: true, link: linkId, ...(l2 === undefined ? {} : { l2 }) });
}

const ACCESS_10 = sw({ mode: 'access', accessVlan: 10 });
const ACCESS_20 = sw({ mode: 'access', accessVlan: 20 });
const TRUNK_N99 = sw({ mode: 'trunk', nativeVlan: 99, allowed: '1,10,20,99' }, { oper: 'trunk', active: '10,20,99' });
const TRUNK_N1 = sw({ mode: 'trunk', nativeVlan: 1, allowed: '1,10,20,99' }, { oper: 'trunk', active: '10,20,99' });

/** SW1 — SW2 trunk (native 99 against native 1: a mismatch), SW1 Gi0/2 access 10 to PC1, SW2 Gi0/2 access 20 to PC2. */
function world() {
  const sw1 = switchDevice('sw1', [switchPort('Gi0/1', TRUNK_N99, 'l12'), switchPort('Gi0/2', ACCESS_10, 'l1p')]);
  const sw2 = switchDevice('sw2', [switchPort('Gi0/1', TRUNK_N1, 'l12'), switchPort('Gi0/2', ACCESS_20, 'l2p')]);
  const pc1 = device('pc1', 200, 0, [port('eth0', { link: 'l1p', operUp: true })]);
  const pc2 = device('pc2', 200, 200, [port('eth0', { link: 'l2p', operUp: true })]);
  return snapshot([sw1, sw2, pc1, pc2], [
    link('l12', ['sw1', 'Gi0/1'], ['sw2', 'Gi0/1']),
    link('l1p', ['sw1', 'Gi0/2'], ['pc1', 'eth0']),
    link('l2p', ['sw2', 'Gi0/2'], ['pc2', 'eth0']),
  ]);
}

describe('colours', () => {
  it('converts HSL to RGB at the corners', () => {
    expect(hslToRgb(0, 1, 0.5)).toBe(0xff0000);
    expect(hslToRgb(120, 1, 0.5)).toBe(0x00ff00);
    expect(hslToRgb(240, 1, 0.5)).toBe(0x0000ff);
    expect(hslToRgb(0, 0, 1)).toBe(0xffffff);
    expect(hslToRgb(0, 0, 0)).toBe(0x000000);
    expect(hslToRgb(360 + 120, 1, 0.5)).toBe(0x00ff00);
  });

  it('measures luminance and tells a dark theme from a light one', () => {
    expect(relativeLuminance(0xffffff)).toBeCloseTo(1, 5);
    expect(relativeLuminance(0x000000)).toBe(0);
    expect(isDarkTheme({ bg: 0x0f1216 })).toBe(true);
    expect(isDarkTheme({ bg: 0xf5f6f8 })).toBe(false);
  });

  it('tints a VLAN by its hue, lighter on a dark theme, and always with a readable text colour', () => {
    const dark = vlanColor(10, { bg: 0x0f1216 });
    const light = vlanColor(10, { bg: 0xffffff });
    expect(dark).not.toBe(light);
    expect(relativeLuminance(dark)).toBeGreaterThan(relativeLuminance(light));
    expect(vlanColor(10, TEST_THEME)).toBe(vlanColor(10, TEST_THEME));
    expect(vlanColor(10, TEST_THEME)).not.toBe(vlanColor(20, TEST_THEME));
    // the hue is the model's hue, so chips and capsules of one VLAN agree
    expect(vlanColor(10, { bg: 0 })).toBe(hslToRgb(vlanHue(10), 0.62, 0.56));
    for (const theme of [TEST_THEME, { bg: 0xffffff }]) {
      for (let v = 1; v <= 4094; v += 37) {
        const c = vlanColor(v, theme);
        expect(contrastRatio(c, contrastText(c)), `VLAN ${v} chip text contrast`).toBeGreaterThanOrEqual(3);
      }
    }
    expect(contrastText(0xffffff)).toBe(0x101418);
    expect(contrastText(0x000000)).toBe(0xf7f8fa);
    expect(contrastRatio(0xffffff, 0x000000)).toBeCloseTo(21, 5);
  });
});

describe('geometry', () => {
  it('places a chip out of the port along the cable normal', () => {
    expect(chipPoint({ x: 10, y: 20, nx: 1, ny: 0 })).toEqual({ x: 10 + CHIP_INSET, y: 20 });
    expect(chipPoint({ x: 10, y: 20, nx: 0, ny: -1 }, 4)).toEqual({ x: 10, y: 16 });
  });

  it('tints the first part of a cable from an access end, on that end', () => {
    expect(tintSpan('a')).toEqual([0, TINT_SPAN]);
    expect(tintSpan('b')).toEqual([1 - TINT_SPAN, 1]);
    expect(TINT_SPAN).toBeLessThan(0.5);
  });

  it('scales rails and tints with the zoom quantum, rail wider than tint', () => {
    expect(railWidth(1)).toBeGreaterThan(tintWidth(1));
    expect(railWidth(2)).toBe(railWidth(1) * 2);
    expect(tintWidth(0.5)).toBe(tintWidth(1) / 2);
    expect(DIM_ALPHA).toBeGreaterThan(0);
    expect(DIM_ALPHA).toBeLessThan(0.5);
  });

  it('dots a rail at a fixed spacing along its polyline (the trunk pattern without colour)', () => {
    const ticks = railTicks([{ x: 0, y: 0 }, { x: 100, y: 0 }], 10);
    expect(ticks.length).toBe(10);
    expect(ticks[0]).toEqual({ x: 5, y: 0 });
    expect(ticks[9]).toEqual({ x: 95, y: 0 });
    // spacing carries across polyline vertices
    const bent = railTicks([{ x: 0, y: 0 }, { x: 7, y: 0 }, { x: 7, y: 30 }], 10);
    expect(bent.map((p) => `${p.x},${p.y}`)).toEqual(['5,0', '7,8', '7,18', '7,28']);
    expect(railTicks([{ x: 0, y: 0 }], 10)).toEqual([]);
  });

  it('breathes the mismatch pulse and holds it still under reduced motion', () => {
    const samples = [0, 200, 400, 600, 800].map((w) => pulseAlpha(w, false));
    expect(Math.max(...samples)).toBeGreaterThan(0.9);
    expect(Math.min(...samples)).toBeLessThan(0.6);
    for (const a of samples) {
      expect(a).toBeGreaterThan(0.3);
      expect(a).toBeLessThanOrEqual(1);
    }
    expect(pulseAlpha(123, true)).toBe(1);
    expect(pulseAlpha(9999, true)).toBe(1);
  });
});

describe('text forms', () => {
  const access: L2End = { kind: 'access', device: 'sw1', port: 'Gi0/2', vlan: 10, view: ACCESS_10 };
  const voice: L2End = { kind: 'access', device: 'sw1', port: 'Gi0/3', vlan: 10, voice: 150, view: ACCESS_10 };
  const trunk: L2End = { kind: 'trunk', device: 'sw1', port: 'Gi0/1', vlans: parseVlanList('10,20,99'), native: 99, source: 'switchport', view: TRUNK_N99 };
  const all: L2End = { kind: 'trunk', device: 'sw1', port: 'Gi0/1', vlans: parseVlanList('1-4094'), native: 1, source: 'switchport', view: TRUNK_N1 };
  const routed: L2End = { kind: 'trunk', device: 'r1', port: 'Gi0/0', vlans: parseVlanList('10,20'), native: null, source: 'subinterfaces' };

  it('describes every kind of end in plain words', () => {
    expect(describeL2End(access)).toBe('access port in VLAN 10');
    expect(describeL2End(voice)).toBe('access port in VLAN 10, voice VLAN 150');
    expect(describeL2End(trunk)).toBe('trunk carrying VLANs 10,20,99, native VLAN 99');
    expect(describeL2End(all)).toBe('trunk carrying all VLANs, native VLAN 1');
    expect(describeL2End(routed)).toBe('routed port with subinterfaces for VLANs 10,20, no native VLAN');
  });

  it('gives every drawn port a fact, with the chip as its short form and the mismatch on both ends', () => {
    const model = buildL2Overlay(world());
    const facts = l2PortFacts(model);
    expect(facts.get('sw1/Gi0/2')).toEqual({ short: 'V10', text: 'access port in VLAN 10' });
    expect(facts.get('sw2/Gi0/2')).toEqual({ short: 'V20', text: 'access port in VLAN 20' });
    const a = facts.get('sw1/Gi0/1');
    const b = facts.get('sw2/Gi0/1');
    expect(a?.short).toBe('T 10,20 · N99 !');
    expect(b?.short).toBe('T 10,20,99 · N1 !');
    expect(a?.text).toContain('trunk carrying VLANs 10,20,99, native VLAN 99; Native VLANs differ');
    expect(b?.text).toContain('Native VLANs differ');
    expect(a?.text.endsWith('.')).toBe(false);
    // hosts are not L2 ends: no fact
    expect(facts.has('pc1/eth0')).toBe(false);
    expect(l2PortFacts(null).size).toBe(0);
  });

  it('gives every link a fact: the shared chip, or the disagreement', () => {
    const facts = l2LinkFacts(buildL2Overlay(world()));
    expect(facts.get('l12')).toEqual({ short: '! VLAN mismatch', text: expect.stringContaining('Native VLANs differ') });
    expect(facts.get('l1p')).toEqual({ short: 'V10', text: 'access link V10' });
    expect(l2LinkFacts(null).size).toBe(0);
  });

  it('says when the focus dims an end', () => {
    const facts = l2PortFacts(buildL2Overlay(world(), { focus: 20 }));
    expect(facts.get('sw1/Gi0/2')?.text).toBe('access port in VLAN 10, outside VLAN 20');
    expect(facts.get('sw2/Gi0/2')?.text).toBe('access port in VLAN 20');
    expect(l2LinkFacts(buildL2Overlay(world(), { focus: 20 })).get('l1p')?.text).toBe('access link V10, outside VLAN 20');
  });
});

describe('the untagged VLAN of a port (packet colouring)', () => {
  it('is the access VLAN, the trunk native VLAN, and nothing for a host or routed port', () => {
    const ends = VLAN_OVERLAY.select(world());
    expect(untaggedVlanOf(ends, { device: 'sw1', port: 'Gi0/2' })).toBe(10);
    expect(untaggedVlanOf(ends, { device: 'sw2', port: 'Gi0/2' })).toBe(20);
    expect(untaggedVlanOf(ends, { device: 'sw1', port: 'Gi0/1' })).toBe(99);
    expect(untaggedVlanOf(ends, { device: 'sw2', port: 'Gi0/1' })).toBe(1);
    expect(untaggedVlanOf(ends, { device: 'pc1', port: 'eth0' })).toBeUndefined();
    expect(untaggedVlanOf(ends, { device: 'nobody', port: 'x' })).toBeUndefined();
  });

  it('is undefined for a router port without a native subinterface', () => {
    const r1 = device('r1', 0, 0, [
      port('Gi0/0', { role: 'routed', link: 'l' }),
      port('Gi0/0.10', { role: 'routed', parent: 'Gi0/0', dot1q: { vid: 10, native: false } }),
    ], { kind: 'router', model: 'NF-2911' });
    const ends = VLAN_OVERLAY.select(snapshot([r1], []));
    expect(untaggedVlanOf(ends, { device: 'r1', port: 'Gi0/0' })).toBeUndefined();
  });
});

describe('the scene', () => {
  it('has one underlay container per registry overlay, in the registry order', () => {
    expect([...TOPO_LAYER_ORDER]).toEqual(OVERLAY_MODULES.map((m) => m.id));
  });
});
