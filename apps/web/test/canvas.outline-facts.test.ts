// The keyboard outline mirrors the topology overlays in text (ARCHITECTURE-P2 §6 "Keyboard outline"; W3 web-canvas):
// with an overlay on, port, device and cable rows carry the overlay's facts in their label and description; with
// every overlay off the model is the bare outline, untouched.
import { describe, expect, it } from 'vitest';
import { DEFAULT_SWITCHPORT } from '@netforge/engine';
import type { DeviceSnapshot, PortL2View, PortSnapshot, SimSnapshot, StpBridgeRow, StpPortRow, SwitchportConfig } from '@netforge/engine';
import { decorateOutline, outlineFacts } from '../src/canvas/a11y/CanvasOutline.js';
import { buildOutline } from '../src/canvas/a11y/keyboard-nav.js';
import { TOPO_OVERLAY_DEFAULTS } from '../src/canvas/overlays/registry.js';
import { device, link, port, snapshot } from './canvas-fixtures.js';

const SEC = 1_000_000_000;

function sw(config: Partial<SwitchportConfig>, extra: Partial<PortL2View> = {}): PortL2View {
  return { config: { ...DEFAULT_SWITCHPORT, ...config }, oper: extra.oper ?? 'access', ...extra };
}

function portRow(vlan: number, id: string, over: Partial<StpPortRow> = {}): StpPortRow {
  return {
    key: `${vlan}|${id}`,
    vlan,
    port: id,
    role: 'designated',
    state: 'forwarding',
    protocol: 'stp',
    cost: 4,
    portId: '128.1',
    designatedBridge: '32769/00:1f:00:0a:00:00',
    designatedPort: '128.1',
    edge: false,
    stateSince: 30 * SEC,
    ...over,
  } as StpPortRow;
}

function bridgeRow(vlan: number, over: Partial<StpBridgeRow> = {}): StpBridgeRow {
  return {
    key: String(vlan),
    vlan,
    mode: 'pvst',
    bridgeId: '32769/00:1f:00:0a:00:00',
    rootId: '4097/00:1f:00:0a:00:00',
    isRoot: false,
    rootCost: 4,
    helloS: 2,
    maxAgeS: 20,
    forwardDelayS: 15,
    topologyChanges: 0,
    ...over,
  } as StpBridgeRow;
}

function switchDevice(id: string, x: number, ports: PortSnapshot[], bridges: StpBridgeRow[], rows: StpPortRow[]): DeviceSnapshot {
  return device(id, x, 0, ports, {
    type: 'switch.nfc2960',
    model: 'NF-C2960',
    kind: 'switch',
    tables: {
      cam: [],
      arp: [],
      rib: [],
      extra: [
        { name: 'vlans', title: 'VLANs', columns: [], rows: [{ key: '10', vlan: 10, name: 'VLAN10', status: 'active', source: 'config' }] },
        { name: 'stp', title: 'Spanning tree ports', columns: [], rows: rows as unknown as Record<string, unknown>[] },
        { name: 'stp-bridge', title: 'Spanning tree', columns: [], rows: bridges as unknown as Record<string, unknown>[] },
      ],
    },
  });
}

function switched(id: string, linkId: string, l2?: PortL2View): PortSnapshot {
  return port(id, { short: id, role: 'switched', operUp: true, link: linkId, ...(l2 === undefined ? {} : { l2 }) });
}

const TRUNK = sw({ mode: 'trunk', nativeVlan: 1, allowed: '1-4094' }, { oper: 'trunk', active: '1,10' });
const ACCESS_10 = sw({ mode: 'access', accessVlan: 10 });

/** SW1 (root) —trunk— SW2; SW2 Gi0/2 access VLAN 10 to PC1. */
function world(): SimSnapshot {
  const sw1 = switchDevice('sw1', 0, [switched('Gi0/1', 'l12', TRUNK)], [bridgeRow(1, { isRoot: true, topologyChanges: 1, lastChangePort: 'Gi0/1' })], [portRow(1, 'Gi0/1')]);
  const sw2 = switchDevice('sw2', 200, [switched('Gi0/1', 'l12', TRUNK), switched('Gi0/2', 'l2p', ACCESS_10)], [bridgeRow(1)], [
    portRow(1, 'Gi0/1', { role: 'root' }),
    portRow(1, 'Gi0/2', { edge: true }),
  ]);
  const pc1 = device('pc1', 400, 0, [port('eth0', { link: 'l2p', operUp: true })]);
  return snapshot([sw1, sw2, pc1], [link('l12', ['sw1', 'Gi0/1'], ['sw2', 'Gi0/1']), link('l2p', ['sw2', 'Gi0/2'], ['pc1', 'eth0'])], { now: 90 * SEC });
}

describe('outline facts', () => {
  it('are empty with every overlay off, and the bare model is returned as is', () => {
    const snap = world();
    const facts = outlineFacts(snap, TOPO_OVERLAY_DEFAULTS);
    expect(facts.ports.size + facts.devices.size + facts.links.size).toBe(0);
    const bare = buildOutline(snap);
    expect(decorateOutline(bare, facts)).toBe(bare);
    expect(outlineFacts(null, { ...TOPO_OVERLAY_DEFAULTS, vlan: true }).ports.size).toBe(0);
    expect(outlineFacts(snap, undefined).ports.size).toBe(0);
  });

  it('mirror the VLAN overlay: chips in the labels, sentences in the descriptions', () => {
    const snap = world();
    const facts = outlineFacts(snap, { ...TOPO_OVERLAY_DEFAULTS, vlan: true });
    const model = decorateOutline(buildOutline(snap), facts);
    const sw2 = model.devices.find((d) => d.id === 'sw2');
    const access = sw2?.ports.find((p) => p.ref.port === 'Gi0/2');
    expect(access?.label).toBe('Gi0/2 · V10');
    expect(access?.description).toMatch(/; access port in VLAN 10\.$/);
    const trunk = sw2?.ports.find((p) => p.ref.port === 'Gi0/1');
    expect(trunk?.label).toBe('Gi0/1 · T 10 · N1');
    expect(trunk?.description).toContain('trunk carrying VLANs 1,10, native VLAN 1');
    // the host port has no VLAN fact; the device row is untouched by the VLAN overlay
    const pc1 = model.devices.find((d) => d.id === 'pc1');
    expect(pc1?.ports[0]?.label).toBe('eth0');
    expect(sw2?.label).toBe('SW2, NF-C2960');
    const cable = model.links.find((l) => l.id === 'l2p');
    expect(cable?.label).toContain(' · V10');
    expect(cable?.description).toMatch(/; access link V10\.$/);
  });

  it('mirror the spanning-tree overlay: roles and states on ports, the crown on the root, the tree on cables', () => {
    const snap = world();
    const facts = outlineFacts(snap, { ...TOPO_OVERLAY_DEFAULTS, stp: true });
    const model = decorateOutline(buildOutline(snap), facts);
    const sw1 = model.devices.find((d) => d.id === 'sw1');
    expect(sw1?.label).toBe('SW1, NF-C2960 · ROOT v1 · TC 1');
    expect(sw1?.description).toMatch(/; root bridge for VLAN 1, 1 topology change, the last at Gi0\/1\.$/);
    const sw2 = model.devices.find((d) => d.id === 'sw2');
    expect(sw2?.ports.find((p) => p.ref.port === 'Gi0/1')?.label).toBe('Gi0/1 · R forwarding');
    expect(sw2?.ports.find((p) => p.ref.port === 'Gi0/2')?.description).toContain('designated port, forwarding, edge port');
    expect(model.links.find((l) => l.id === 'l12')?.description).toMatch(/; in the spanning tree of VLAN 1\.$/);
  });

  it('stack both overlays on one row, VLAN first', () => {
    const snap = world();
    const facts = outlineFacts(snap, { ...TOPO_OVERLAY_DEFAULTS, vlan: true, stp: true });
    const model = decorateOutline(buildOutline(snap), facts);
    const trunk = model.devices.find((d) => d.id === 'sw2')?.ports.find((p) => p.ref.port === 'Gi0/1');
    expect(trunk?.label).toBe('Gi0/1 · T 10 · N1 · R forwarding');
    expect(trunk?.description).toMatch(/; trunk carrying VLANs 1,10, native VLAN 1; spanning tree VLAN 1: root port, forwarding, classic messages\.$/);
  });

  it('keep untouched rows identical so memoised rows do not re-render', () => {
    const snap = world();
    const bare = buildOutline(snap);
    const model = decorateOutline(bare, outlineFacts(snap, { ...TOPO_OVERLAY_DEFAULTS, stp: true }));
    const pc1 = bare.devices.find((d) => d.id === 'pc1');
    expect(model.devices.find((d) => d.id === 'pc1')).toBe(pc1);
    expect(model.associations).toBe(bare.associations);
  });
});
