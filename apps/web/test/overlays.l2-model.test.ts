// The VLAN overlay model (ARCHITECTURE-P2 §6, §10.2 "overlays.l2-model"): chips, tints, trunk rails, the mismatch
// detector reading both link ends, and the VLAN focus filter — all from snapshot data only.
import { describe, expect, it } from 'vitest';
import { DEFAULT_SWITCHPORT } from '@netforge/engine';
import type { DeviceSnapshot, PortL2View, PortSnapshot, SwitchportConfig } from '@netforge/engine';
import {
  accessChip,
  buildL2Overlay,
  deriveDeviceL2,
  detectL2Mismatch,
  endCarries,
  formatVlanRanges,
  isAllVlans,
  isVlanAwareDevice,
  parseVlanList,
  trunkChip,
  vlanHue,
  vlanRangesHas,
  vlanRangesWithout,
  type L2End,
} from '../src/canvas/overlays/l2-model.js';
import { device, link, port, snapshot } from './canvas-fixtures.js';

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

function switchPort(id: string, short: string, l2?: PortL2View, more: Partial<PortSnapshot> = {}): PortSnapshot {
  return port(id, { short, role: 'switched', operUp: true, link: more.link, ...(l2 === undefined ? {} : { l2 }), ...more });
}

const ACCESS_10 = sw({ mode: 'access', accessVlan: 10 });
const TRUNK_N99 = sw({ mode: 'trunk', nativeVlan: 99, allowed: '1,10,20,99' }, { oper: 'trunk', active: '10,20,99' });
const TRUNK_N1 = sw({ mode: 'trunk', nativeVlan: 1, allowed: '1,10,20,99' }, { oper: 'trunk', active: '10,20,99' });

describe('VLAN lists', () => {
  it('parses, formats and tests the canonical list format', () => {
    expect(parseVlanList('10,20,30-35')).toEqual([[10, 10], [20, 20], [30, 35]]);
    expect(formatVlanRanges(parseVlanList('10,20,30-35'))).toBe('10,20,30-35');
    expect(parseVlanList('')).toEqual([]);
    expect(parseVlanList(undefined)).toEqual([]);
    expect(isAllVlans(parseVlanList('1-4094'))).toBe(true);
    expect(isAllVlans(parseVlanList('1-4093'))).toBe(false);
    expect(parseVlanList(' 20 , 10 ')).toEqual([[10, 10], [20, 20]]);
    expect(parseVlanList('10,11,12')).toEqual([[10, 12]]);
    expect(parseVlanList('nonsense,10')).toEqual([[10, 10]]);
    expect(parseVlanList('0,10,9000')).toEqual([[10, 10]]);
    expect(vlanRangesHas(parseVlanList('10,30-35'), 33)).toBe(true);
    expect(vlanRangesHas(parseVlanList('10,30-35'), 36)).toBe(false);
    expect(formatVlanRanges(vlanRangesWithout(parseVlanList('1,10,20,99'), 99))).toBe('1,10,20');
    expect(formatVlanRanges(vlanRangesWithout(parseVlanList('10-14'), 12))).toBe('10-11,13-14');
  });

  it('spreads VLAN tints and keeps them stable', () => {
    expect(vlanHue(10)).toBe(vlanHue(10));
    expect(vlanHue(10)).not.toBe(vlanHue(20));
    for (const v of [1, 10, 20, 99, 4094]) {
      expect(vlanHue(v)).toBeGreaterThanOrEqual(0);
      expect(vlanHue(v)).toBeLessThan(360);
    }
  });
});

describe('chips', () => {
  it('reads V10 on an access port and T 10,20 · N99 on a trunk (§10.2)', () => {
    expect(accessChip(10)).toBe('V10');
    expect(accessChip(10, 150)).toBe('V10 · v150');
    expect(trunkChip(parseVlanList('10,20,99'), 99)).toBe('T 10,20 · N99');
    expect(trunkChip(parseVlanList('1-4094'), 1)).toBe('T all · N1');
    expect(trunkChip(parseVlanList('99'), 99)).toBe('T — · N99');
    expect(trunkChip(parseVlanList('10,20'), null)).toBe('T 10,20');
  });

  it('clips a long VLAN list with an ellipsis', () => {
    const chip = trunkChip(parseVlanList('10,20,30,40,50,60,70,80,90,100'), 1);
    expect(chip.startsWith('T 10,20,30,40,50')).toBe(true);
    expect(chip).toContain('…');
    expect(chip.endsWith('· N1')).toBe(true);
  });
});

describe('VLAN awareness and ends', () => {
  it('reads VLAN awareness from the vlans table and fills the default view', () => {
    const aware = switchDevice('sw1', [switchPort('Fa0/1', 'Fa0/1')]);
    expect(isVlanAwareDevice(aware)).toBe(true);
    const ends = deriveDeviceL2(aware).ends;
    expect(ends.get('Fa0/1')).toMatchObject({ kind: 'access', vlan: 1 });

    const plain = device('pc1', 0, 0, [port('Gi0', { role: 'routed' })]);
    expect(isVlanAwareDevice(plain)).toBe(false);
    expect(deriveDeviceL2(plain).ends.size).toBe(0);
  });

  it('reads a router port with subinterfaces as a trunk end', () => {
    const r1 = device('r1', 0, 0, [
      port('GigabitEthernet0/0', { short: 'Gi0/0', role: 'routed', operUp: true }),
      port('GigabitEthernet0/0.10', { short: 'Gi0/0.10', role: 'subif', parent: 'GigabitEthernet0/0', dot1q: { vid: 10, native: false } }),
      port('GigabitEthernet0/0.20', { short: 'Gi0/0.20', role: 'subif', parent: 'GigabitEthernet0/0', dot1q: { vid: 20, native: false } }),
      port('GigabitEthernet0/0.99', { short: 'Gi0/0.99', role: 'subif', parent: 'GigabitEthernet0/0', dot1q: { vid: 99, native: true } }),
    ], { type: 'router.nf2911', model: 'NF-2911', kind: 'router' });
    const end = deriveDeviceL2(r1).ends.get('GigabitEthernet0/0');
    expect(end).toMatchObject({ kind: 'trunk', native: 99, source: 'subinterfaces' });
    expect(trunkChip((end as L2End & { kind: 'trunk' }).vlans, 99)).toBe('T 10,20 · N99');
    expect(endCarries(end as L2End, 20)).toBe(true);
    expect(endCarries(end as L2End, 30)).toBe(false);
  });
});

describe('mismatch detection from both ends', () => {
  const a: L2End = { kind: 'trunk', device: 'sw1', port: 'Gi0/1', vlans: parseVlanList('10,20,99'), native: 99, source: 'switchport' };
  const b: L2End = { kind: 'trunk', device: 'sw2', port: 'Gi0/1', vlans: parseVlanList('10,20,99'), native: 1, source: 'switchport' };

  it('flags a native VLAN difference', () => {
    const m = detectL2Mismatch(a, b);
    expect(m?.kind).toBe('native');
    expect(m?.glyph).toBe('!');
    expect(m?.text).toContain('99');
    expect(m?.text).toContain('1');
    expect(detectL2Mismatch(a, { ...b, native: 99 })).toBeUndefined();
  });

  it('flags a trunk facing an access port, and two access ports in different VLANs', () => {
    const access: L2End = { kind: 'access', device: 'sw2', port: 'Fa0/1', vlan: 10, view: ACCESS_10 };
    expect(detectL2Mismatch(a, access)?.kind).toBe('mode');
    expect(detectL2Mismatch(access, a)?.kind).toBe('mode');
    const other: L2End = { kind: 'access', device: 'sw3', port: 'Fa0/1', vlan: 20, view: sw({ mode: 'access', accessVlan: 20 }) };
    expect(detectL2Mismatch(access, other)?.kind).toBe('access-vlan');
    expect(detectL2Mismatch(access, { ...other, vlan: 10 })).toBeUndefined();
  });

  it('never calls a router port without a native subinterface a native mismatch', () => {
    const router: L2End = { kind: 'trunk', device: 'r1', port: 'Gi0/0', vlans: parseVlanList('10,20'), native: null, source: 'subinterfaces' };
    expect(detectL2Mismatch(a, router)).toBeUndefined();
  });
});

describe('the overlay model', () => {
  function trunkPair(nativeB: PortL2View = TRUNK_N1) {
    const sw1 = switchDevice('sw1', [
      switchPort('Gi0/1', 'Gi0/1', TRUNK_N99, { link: 'l1' }),
      switchPort('Fa0/1', 'Fa0/1', ACCESS_10, { link: 'l2' }),
    ]);
    const sw2 = switchDevice('sw2', [switchPort('Gi0/1', 'Gi0/1', nativeB, { link: 'l1' })]);
    const pc1 = device('pc1', 0, 0, [port('Gi0', { role: 'routed', operUp: true, link: 'l2' })]);
    return snapshot([sw1, sw2, pc1], [link('l1', ['sw1', 'Gi0/1'], ['sw2', 'Gi0/1']), link('l2', ['sw1', 'Fa0/1'], ['pc1', 'Gi0'])]);
  }

  it('flags a native 99 against native 1 trunk pair on both ends, with the §10.2 chips', () => {
    const model = buildL2Overlay(trunkPair());
    const trunkMarks = model.ports.filter((p) => p.link === 'l1');
    // Each chip lists the VLANs that end carries TAGGED: with native 99 that is 10 and 20, with native 1 it is 10, 20
    // and 99 — which is the mismatch, said in two chips.
    expect(trunkMarks.map((p) => p.chip)).toEqual(['T 10,20 · N99', 'T 10,20,99 · N1']);
    expect(trunkMarks.every((p) => p.mismatch?.kind === 'native')).toBe(true);
    expect(trunkMarks.every((p) => p.mismatch?.glyph === '!')).toBe(true);
    expect(trunkMarks.every((p) => p.hue === null)).toBe(true);
    const trunkLink = model.links.find((l) => l.link === 'l1');
    expect(trunkLink?.rail).toBe(true);
    expect(trunkLink?.mismatch?.kind).toBe('native');
    expect(trunkLink?.chip).toBeUndefined();
    expect(trunkLink?.mismatch?.text).toContain('SW1 Gi0/1');
    expect(trunkLink?.mismatch?.text).toContain('SW2 Gi0/1');
  });

  it('reads an access chip and tint on the host link, and no mismatch with a device that has no L2 side', () => {
    const model = buildL2Overlay(trunkPair());
    const access = model.ports.filter((p) => p.link === 'l2');
    expect(access).toHaveLength(1);
    expect(access[0]?.chip).toBe('V10');
    expect(access[0]?.hue).toBe(vlanHue(10));
    expect(access[0]?.mismatch).toBeUndefined();
    const hostLink = model.links.find((l) => l.link === 'l2');
    expect(hostLink?.rail).toBe(false);
    expect(hostLink?.chip).toBe('V10');
  });

  it('agrees on one chip when both ends match', () => {
    const model = buildL2Overlay(trunkPair(TRUNK_N99));
    const trunkLink = model.links.find((l) => l.link === 'l1');
    expect(trunkLink?.mismatch).toBeUndefined();
    expect(trunkLink?.chip).toBe('T 10,20 · N99');
  });

  it('offers the VLANs of the world and dims what a focus does not carry', () => {
    const model = buildL2Overlay(trunkPair(), { focus: 20 });
    expect(model.vlans).toEqual([1, 10, 20, 99]);
    expect(model.focus).toBe(20);
    const access = model.ports.find((p) => p.link === 'l2');
    expect(access?.dimmed).toBe(true);
    expect(model.links.find((l) => l.link === 'l2')?.dimmed).toBe(true);
    for (const p of model.ports.filter((x) => x.link === 'l1')) expect(p.dimmed).toBe(false);
    expect(model.links.find((l) => l.link === 'l1')?.dimmed).toBe(false);
    const focused10 = buildL2Overlay(trunkPair(), { focus: 10 });
    expect(focused10.ports.find((p) => p.link === 'l2')?.dimmed).toBe(false);
  });

  it('draws nothing in a world whose switches are not VLAN-aware (a P1 world)', () => {
    const sw1 = device('sw1', 0, 0, [port('Fa0/1', { role: 'switched', operUp: true, link: 'l1' })], { kind: 'switch' });
    const pc1 = device('pc1', 0, 0, [port('Gi0', { role: 'routed', operUp: true, link: 'l1' })]);
    const model = buildL2Overlay(snapshot([sw1, pc1], [link('l1', ['sw1', 'Fa0/1'], ['pc1', 'Gi0'])]));
    expect(model.ports).toEqual([]);
    expect(model.links).toEqual([]);
    expect(model.vlans).toEqual([]);
  });

  it('shows a voice VLAN beside the data VLAN', () => {
    const phonePort = switchPort('Fa0/2', 'Fa0/2', sw({ mode: 'access', accessVlan: 10, voiceVlan: 150 }), { link: 'l3' });
    const sw1 = switchDevice('sw1', [phonePort], [10, 150]);
    const phone = device('ph1', 0, 0, [port('Gi0', { role: 'routed', operUp: true, link: 'l3' })]);
    const model = buildL2Overlay(snapshot([sw1, phone], [link('l3', ['sw1', 'Fa0/2'], ['ph1', 'Gi0'])]));
    expect(model.ports[0]?.chip).toBe('V10 · v150');
    expect(model.vlans).toEqual([1, 10, 150]);
    expect(endCarries(model.ports[0]!.end, 150)).toBe(true);
  });
});
