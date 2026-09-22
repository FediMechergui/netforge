// The overlay registry (ARCHITECTURE-P2 §6, D20): plain data in paint order, per-device selection memoised per device
// object, and a sync that reads the `topoOverlays` slice — plus the controller-tunnel model it carries.
import { describe, expect, it } from 'vitest';
import type { DeviceSnapshot, SimSnapshot } from '@netforge/engine';
import {
  CAPWAP_OVERLAY,
  OVERLAY_MODULES,
  STP_OVERLAY,
  TOPO_OVERLAY_DEFAULTS,
  VLAN_OVERLAY,
  memoPerDevice,
  overlayById,
  overlaysForLesson,
  type OverlaySyncInput,
} from '../src/canvas/overlays/registry.js';
import { buildCapwapOverlay, capwapLetter, deriveDeviceCapwap } from '../src/canvas/overlays/capwap-model.js';
import type { L2OverlayModel } from '../src/canvas/overlays/l2-model.js';
import type { StpOverlayModel } from '../src/canvas/overlays/stp-model.js';
import { device, link, port, snapshot } from './canvas-fixtures.js';

const ON = { ...TOPO_OVERLAY_DEFAULTS, vlan: true, stp: true, capwap: true };

function switchDevice(id: string): DeviceSnapshot {
  return device(id, 0, 0, [port('Fa0/1', { short: 'Fa0/1', role: 'switched', operUp: true, link: 'l1' })], {
    kind: 'switch',
    tables: { cam: [], arp: [], rib: [], extra: [{ name: 'vlans', title: 'VLANs', columns: [], rows: [{ key: '10', vlan: 10, name: 'SALES', status: 'active', source: 'config' }] }] },
  });
}

function world(): SimSnapshot {
  const sw1 = switchDevice('sw1');
  const pc1 = device('pc1', 0, 0, [port('Gi0', { role: 'routed', operUp: true, link: 'l1' })]);
  return snapshot([sw1, pc1], [link('l1', ['sw1', 'Fa0/1'], ['pc1', 'Gi0'])]);
}

function input(snap: SimSnapshot | null, state = ON, now = 0): OverlaySyncInput {
  return { snapshot: snap, state, now };
}

describe('the registry', () => {
  it('lists the three overlays in paint order, each with its toggle and CCNA 2 objectives', () => {
    expect(OVERLAY_MODULES.map((m) => m.id)).toEqual(['vlan', 'stp', 'capwap']);
    expect(OVERLAY_MODULES).toEqual([VLAN_OVERLAY, STP_OVERLAY, CAPWAP_OVERLAY]);
    for (const m of OVERLAY_MODULES) {
      expect(m.toggle).toBe(m.id);
      expect(m.since).toBe('P2');
      expect(m.label.length).toBeGreaterThan(0);
      expect(m.hint.length).toBeGreaterThan(0);
      expect(m.objectives.length).toBeGreaterThan(0);
      for (const o of m.objectives) expect(o, o).toMatch(/^ccna2-\d{2}-[a-z0-9-]+$/);
    }
    expect(overlayById('stp')).toBe(STP_OVERLAY);
    expect(overlayById('ospf')).toBeUndefined();
    expect(overlaysForLesson('ccna2-13-electing-a-root')).toEqual([STP_OVERLAY]);
    expect(overlaysForLesson('ccna2-09-router-on-a-stick')).toEqual([VLAN_OVERLAY]);
    expect(overlaysForLesson('ccna2-01-how-a-switch-forwards')).toEqual([]);
  });

  it('starts with every overlay off', () => {
    expect(TOPO_OVERLAY_DEFAULTS).toEqual({ vlan: false, stp: false, stpVlan: null, vlanFocus: null, capwap: false });
  });

  it('syncs nothing while an overlay is off or there is no snapshot', () => {
    const snap = world();
    expect(VLAN_OVERLAY.sync(input(snap, TOPO_OVERLAY_DEFAULTS))).toBeNull();
    expect(STP_OVERLAY.sync(input(snap, TOPO_OVERLAY_DEFAULTS))).toBeNull();
    expect(CAPWAP_OVERLAY.sync(input(snap, TOPO_OVERLAY_DEFAULTS))).toBeNull();
    for (const m of OVERLAY_MODULES) expect(m.sync(input(null))).toBeNull();
  });

  it('syncs each overlay from the slice', () => {
    const snap = world();
    const vlan = VLAN_OVERLAY.sync(input(snap)) as L2OverlayModel;
    expect(vlan.ports.map((p) => p.chip)).toEqual(['V1']);
    expect(vlan.focus).toBeNull();
    expect((VLAN_OVERLAY.sync(input(snap, { ...ON, vlanFocus: 10 })) as L2OverlayModel).focus).toBe(10);
    const stp = STP_OVERLAY.sync(input(snap)) as StpOverlayModel;
    expect(stp).toMatchObject({ vlan: null, vlans: [], ports: [] });
  });

  it('memoises per device object', () => {
    const snap = world();
    const first = VLAN_OVERLAY.select(snap);
    const again = VLAN_OVERLAY.select(snapshot([...snap.devices], snap.links));
    expect(again.get('sw1')).toBe(first.get('sw1'));
    const replaced = snapshot([{ ...(snap.devices[0] as DeviceSnapshot) }, snap.devices[1] as DeviceSnapshot], snap.links);
    expect(VLAN_OVERLAY.select(replaced).get('sw1')).not.toBe(first.get('sw1'));
    expect(VLAN_OVERLAY.select(replaced).get('pc1')).toBe(first.get('pc1'));
  });

  it('memoPerDevice derives once per device object', () => {
    let calls = 0;
    const memo = memoPerDevice((d: DeviceSnapshot) => {
      calls += 1;
      return { id: d.id };
    });
    const d = switchDevice('sw1');
    expect(memo(d)).toBe(memo(d));
    expect(calls).toBe(1);
    memo({ ...d });
    expect(calls).toBe(2);
  });
});

describe('the controller-tunnel model', () => {
  function apAndController(state = 'run'): SimSnapshot {
    const ap = device('ap1', 0, 0, [port('Vlan1', { role: 'svi', operUp: true, l3: { ipv4: { address: '192.168.99.20', prefixLen: 24 } } })], {
      kind: 'ap',
      tables: {
        cam: [],
        arp: [],
        rib: [],
        extra: [{ name: 'capwap', title: 'Controller link', columns: [], rows: [{ key: '192.168.99.5', controller: '192.168.99.5', state, since: 0, wlans: 2 }] }],
      },
    });
    const wlc = device('wlc1', 0, 0, [port('Vlan99', { role: 'svi', operUp: true, l3: { ipv4: { address: '192.168.99.5', prefixLen: 24 } } })], { kind: 'switch' });
    return snapshot([ap, wlc], []);
  }

  it('letters every join state', () => {
    expect(capwapLetter('discovery')).toBe('Di');
    expect(capwapLetter('dtls')).toBe('Dt');
    expect(capwapLetter('join')).toBe('Jn');
    expect(capwapLetter('configure')).toBe('Cf');
    expect(capwapLetter('data-check')).toBe('Dc');
    expect(capwapLetter('run')).toBe('Run');
    expect(capwapLetter('idle')).toBe('–');
    expect(capwapLetter('mystery')).toBe('mystery');
  });

  it('joins each access point to the device that holds the controller address', () => {
    const model = buildCapwapOverlay(apAndController());
    expect(model.tunnels).toEqual([
      { ap: 'ap1', controller: 'wlc1', controllerAddress: '192.168.99.5', state: 'run', letter: 'Run', joined: true, wlans: 2 },
    ]);
    const joining = buildCapwapOverlay(apAndController('join'));
    expect(joining.tunnels[0]).toMatchObject({ letter: 'Jn', joined: false });
  });

  it('leaves the controller null when no device holds that address', () => {
    const snap = apAndController();
    const apOnly = snapshot([snap.devices[0] as DeviceSnapshot], []);
    expect(buildCapwapOverlay(apOnly).tunnels[0]).toMatchObject({ controller: null, controllerAddress: '192.168.99.5' });
    expect(deriveDeviceCapwap(snap.devices[1] as DeviceSnapshot).links).toEqual([]);
    expect(deriveDeviceCapwap(snap.devices[1] as DeviceSnapshot).addresses).toEqual(['192.168.99.5']);
  });

  it('draws nothing in a world with no access point', () => {
    expect(CAPWAP_OVERLAY.sync(input(world()))).toEqual({ tunnels: [] });
  });
});
