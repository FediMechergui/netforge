// The overlay registry (ARCHITECTURE-P2 §6, D20): plain data in paint order, per-device selection memoised per device
// object, and a sync that reads the `topoOverlays` slice — plus the controller-tunnel model it carries.
// ARCHITECTURE-P3 §2.14, §6 (W3 web-canvas): the registry gains qos, [S1] ospf, [S3] spf, [S18]/[S19] wan and [C1] eigrp
// (the exact lists below); the P2 entries keep every assertion they had, now on the switching list.
import { describe, expect, it } from 'vitest';
import type { DeviceSnapshot, EigrpTopologyRow, OspfInterfaceRow, OspfNeighborRow, SimSnapshot } from '@netforge/engine';
import {
  CAPWAP_OVERLAY,
  EIGRP_OVERLAY,
  OSPF_OVERLAY,
  OVERLAY_MODULES,
  QOS_OVERLAY,
  ROUTING_OVERLAY_MODULES,
  SPF_OVERLAY,
  STP_OVERLAY,
  SWITCHING_OVERLAY_MODULES,
  TOPO_OVERLAY_DEFAULTS,
  VLAN_OVERLAY,
  WAN_OVERLAY,
  memoPerDevice,
  overlayById,
  overlaysForLesson,
  type OverlaySyncInput,
} from '../src/canvas/overlays/registry.js';
import { TOPO_LAYER_ORDER } from '../src/canvas/scene.js';
import { buildCapwapOverlay, capwapLetter, deriveDeviceCapwap } from '../src/canvas/overlays/capwap-model.js';
import { buildEigrpOverlay, type EigrpOverlayModel } from '../src/canvas/overlays/eigrp-model.js';
import { buildOspfOverlay, type OspfOverlayModel } from '../src/canvas/overlays/ospf-model.js';
import { buildSpfOverlay } from '../src/canvas/overlays/spf-model.js';
import { buildWanOverlay } from '../src/canvas/overlays/wan-model.js';
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
    // §2.14 (W3): the full paint order is the P2 overlays, then OSPF, EIGRP, SPF, WAN and QoS (exact lists)
    expect(OVERLAY_MODULES.map((m) => m.id)).toEqual(['vlan', 'stp', 'capwap', 'ospf', 'eigrp', 'spf', 'wan', 'qos']);
    expect(OVERLAY_MODULES).toEqual([VLAN_OVERLAY, STP_OVERLAY, CAPWAP_OVERLAY, OSPF_OVERLAY, EIGRP_OVERLAY, SPF_OVERLAY, WAN_OVERLAY, QOS_OVERLAY]);
    expect(SWITCHING_OVERLAY_MODULES.map((m) => m.id)).toEqual(['vlan', 'stp', 'capwap']);
    expect(SWITCHING_OVERLAY_MODULES).toEqual([VLAN_OVERLAY, STP_OVERLAY, CAPWAP_OVERLAY]);
    for (const m of SWITCHING_OVERLAY_MODULES) {
      expect(m.toggle).toBe(m.id);
      expect(m.since).toBe('P2');
      expect(m.label.length).toBeGreaterThan(0);
      expect(m.hint.length).toBeGreaterThan(0);
      expect(m.objectives.length).toBeGreaterThan(0);
      for (const o of m.objectives) expect(o, o).toMatch(/^ccna2-\d{2}-[a-z0-9-]+$/);
    }
    expect(overlayById('stp')).toBe(STP_OVERLAY);
    // 'ospf' is registered since W3; the overlays that are not approved never are (§2.14)
    expect(overlayById('ospf')).toBe(OSPF_OVERLAY);
    expect(overlayById('route-path')).toBeUndefined();
    expect(overlayById('neighbours')).toBeUndefined();
    expect(overlaysForLesson('ccna2-13-electing-a-root')).toEqual([STP_OVERLAY]);
    expect(overlaysForLesson('ccna2-09-router-on-a-stick')).toEqual([VLAN_OVERLAY]);
    expect(overlaysForLesson('ccna2-01-how-a-switch-forwards')).toEqual([]);
  });

  it('lists the P3 overlays: the View-menu toggles in §2.14 order, the SPF layer without a toggle, CCNA 3 objectives', () => {
    expect(ROUTING_OVERLAY_MODULES.map((m) => m.id)).toEqual(['qos', 'ospf', 'wan', 'eigrp']);
    expect(ROUTING_OVERLAY_MODULES).toEqual([QOS_OVERLAY, OSPF_OVERLAY, WAN_OVERLAY, EIGRP_OVERLAY]);
    expect(ROUTING_OVERLAY_MODULES.map((m) => m.toggle)).toEqual(['qos', 'ospf', 'wan', 'eigrp']);
    expect(SPF_OVERLAY.toggle).toBeNull();
    const p3 = OVERLAY_MODULES.filter((m) => !SWITCHING_OVERLAY_MODULES.includes(m as never));
    expect(p3.map((m) => m.id)).toEqual(['ospf', 'eigrp', 'spf', 'wan', 'qos']);
    for (const m of p3) {
      expect(m.since).toBe('P3');
      expect(m.toggle === null || m.toggle === m.id, m.id).toBe(true);
      expect(m.label.length).toBeGreaterThan(0);
      expect(m.hint.length).toBeGreaterThan(0);
      expect(m.objectives.length).toBeGreaterThan(0);
      for (const o of m.objectives) expect(o, o).toMatch(/^ccna3-\d{2}-[a-z0-9-]+$/);
      expect(m.label + m.hint).not.toMatch(/cisco|packet tracer|ios\b/i);
    }
    expect(new Set(OVERLAY_MODULES.map((m) => m.label)).size).toBe(OVERLAY_MODULES.length);
    // every boolean of the slice is exactly one overlay's toggle
    const booleans = Object.entries(TOPO_OVERLAY_DEFAULTS)
      .filter(([, v]) => typeof v === 'boolean')
      .map(([k]) => k)
      .sort();
    expect(OVERLAY_MODULES.flatMap((m) => (m.toggle === null ? [] : [m.toggle])).sort()).toEqual(booleans);
    expect(overlaysForLesson('ccna3-02-how-ospf-maps-a-network')).toEqual([OSPF_OVERLAY, SPF_OVERLAY]);
    expect(overlaysForLesson('ccna3-27-marking-queuing-and-policing')).toEqual([QOS_OVERLAY]);
    expect(overlaysForLesson('ccna3-24-gre-tunnels')).toEqual([WAN_OVERLAY]);
    expect(overlaysForLesson('ccna3-10-eigrp-and-its-metric')).toEqual([EIGRP_OVERLAY]);
    expect(overlaysForLesson('ccna3-14-how-an-acl-decides')).toEqual([]);
  });

  it('gives the scene one underlay container per overlay, in the same order', () => {
    expect([...TOPO_LAYER_ORDER]).toEqual(OVERLAY_MODULES.map((m) => m.id));
  });

  it('starts with every overlay off', () => {
    // ARCHITECTURE-P3 §9.2 item 23 (W2 web-shell): the default object gains the P3 keys, still pinned exactly
    expect(TOPO_OVERLAY_DEFAULTS).toEqual({
      vlan: false,
      stp: false,
      stpVlan: null,
      vlanFocus: null,
      capwap: false,
      qos: false,
      ospf: false,
      ospfArea: null,
      wan: false,
      eigrp: false,
      eigrpPrefix: null,
    });
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

describe('the P3 entries (W3)', () => {
  const P3_ON = { ...TOPO_OVERLAY_DEFAULTS, qos: true, ospf: true, wan: true, eigrp: true };
  const SEC = 1_000_000_000;

  function ifRow(portId: string, routerId: string, area = '0.0.0.0'): OspfInterfaceRow {
    return {
      key: portId,
      port: portId,
      process: 1,
      routerId,
      area,
      networkType: 'point-to-point',
      state: 'point-to-point',
      cost: 1,
      costSource: 'bandwidth',
      priority: 1,
      helloS: 10,
      deadS: 40,
      passive: false,
      neighbors: 1,
      adjacent: 0,
      stateSince: 0,
    } as OspfInterfaceRow;
  }

  function nbrRow(portId: string, routerId: string): OspfNeighborRow {
    return { key: `${portId}|${routerId}`, port: portId, routerId, address: '10.0.12.2', priority: 1, state: 'init', role: 'none', dr: '0.0.0.0', bdr: '0.0.0.0', stateSince: 0 } as OspfNeighborRow;
  }

  function eigrpRow(prefix: string): EigrpTopologyRow {
    return { key: prefix, prefix, state: 'passive', fd: 2816, successors: [], feasible: [], others: [], connected: 'Gi0/0' } as unknown as EigrpTopologyRow;
  }

  /** R1 Gi0/0 — R2 Gi0/0 in OSPF area 0, each seeing the other in Init; R2 Gi0/1 in area 1; R1 knows two EIGRP prefixes. */
  function routingWorld(): SimSnapshot {
    const extra = (name: string, rows: unknown[]) => ({ name, title: name, columns: [], rows: rows as Record<string, unknown>[] });
    const r1 = device('r1', 0, 0, [port('Gi0/0', { role: 'routed', operUp: true, link: 'l1' })], {
      kind: 'router',
      tables: {
        cam: [],
        arp: [],
        rib: [],
        extra: [
          extra('ospf-interfaces', [ifRow('Gi0/0', '1.1.1.1')]),
          extra('ospf-neighbors', [nbrRow('Gi0/0', '2.2.2.2')]),
          extra('eigrp-topology', [eigrpRow('10.0.12.0/24'), eigrpRow('10.9.0.0/16')]),
        ],
      },
    });
    const r2 = device('r2', 0, 0, [port('Gi0/0', { role: 'routed', operUp: true, link: 'l1' }), port('Gi0/1', { role: 'routed', operUp: true })], {
      kind: 'router',
      tables: {
        cam: [],
        arp: [],
        rib: [],
        extra: [extra('ospf-interfaces', [ifRow('Gi0/0', '2.2.2.2'), ifRow('Gi0/1', '2.2.2.2', '0.0.0.1')]), extra('ospf-neighbors', [nbrRow('Gi0/0', '1.1.1.1')])],
      },
    });
    return snapshot([r1, r2], [link('l1', ['r1', 'Gi0/0'], ['r2', 'Gi0/0'])], { now: 5 * SEC });
  }

  it('syncs nothing while its toggle is off, and an empty model in a world without the protocol', () => {
    const snap = world();
    for (const m of [QOS_OVERLAY, OSPF_OVERLAY, WAN_OVERLAY, EIGRP_OVERLAY]) expect(m.sync(input(snap, TOPO_OVERLAY_DEFAULTS)), m.id).toBeNull();
    expect(QOS_OVERLAY.sync(input(snap, P3_ON))).toEqual({ stacks: [], sleeves: [], queues: [] });
    expect(OSPF_OVERLAY.sync(input(snap, P3_ON))).toEqual({ area: null, areas: [], zones: [], ports: [], links: [] });
    expect(WAN_OVERLAY.sync(input(snap, P3_ON))).toEqual(buildWanOverlay(snap));
    expect(EIGRP_OVERLAY.sync(input(snap, P3_ON))).toEqual({ prefix: null, prefixes: [], routers: [], paths: [], links: [] });
  });

  it('hands OSPF its area, the clock and reduced motion; EIGRP its prefix', () => {
    const snap = routingWorld();
    const all = OSPF_OVERLAY.sync({ state: P3_ON, snapshot: snap, now: snap.now }) as OspfOverlayModel;
    expect(all).toEqual(buildOspfOverlay(snap, { area: null, now: snap.now, reducedMotion: false }));
    expect(all.areas).toEqual(['0.0.0.0', '0.0.0.1']);
    expect(all.links.some((l) => l.pulse)).toBe(true);
    const still = OSPF_OVERLAY.sync({ state: P3_ON, snapshot: snap, now: snap.now, reducedMotion: true }) as OspfOverlayModel;
    expect(still.links.some((l) => l.pulse)).toBe(false);
    const one = OSPF_OVERLAY.sync({ state: { ...P3_ON, ospfArea: '0.0.0.1' }, snapshot: snap, now: snap.now }) as OspfOverlayModel;
    expect(one).toEqual(buildOspfOverlay(snap, { area: '0.0.0.1', now: snap.now, reducedMotion: false }));
    expect(one.area).toBe('0.0.0.1');
    const first = EIGRP_OVERLAY.sync({ state: P3_ON, snapshot: snap, now: snap.now }) as EigrpOverlayModel;
    expect(first.prefixes).toEqual(['10.0.12.0/24', '10.9.0.0/16']);
    expect(first.prefix).toBe('10.0.12.0/24');
    const chosen = EIGRP_OVERLAY.sync({ state: { ...P3_ON, eigrpPrefix: '10.9.0.0/16' }, snapshot: snap, now: snap.now }) as EigrpOverlayModel;
    expect(chosen).toEqual(buildEigrpOverlay(snap, { prefix: '10.9.0.0/16' }));
    expect(chosen.prefix).toBe('10.9.0.0/16');
  });

  it('draws the SPF layer only while the link-state browser is shown, for its router, area and frame', () => {
    const snap = routingWorld();
    const ui = { device: 'r1', area: '0.0.0.0', lsa: null, spf: { step: 0, playing: false } };
    expect(SPF_OVERLAY.sync({ state: P3_ON, snapshot: snap, now: snap.now })).toBeNull();
    expect(SPF_OVERLAY.sync({ state: P3_ON, snapshot: snap, now: snap.now, routing: { ui, shown: false } })).toBeNull();
    expect(SPF_OVERLAY.sync({ state: P3_ON, snapshot: null, now: 0, routing: { ui, shown: true } })).toBeNull();
    const shown = SPF_OVERLAY.sync({ state: TOPO_OVERLAY_DEFAULTS, snapshot: snap, now: snap.now, routing: { ui, shown: true } });
    expect(shown).not.toBeNull();
    expect(shown).toEqual(buildSpfOverlay(snap, { device: 'r1', area: '0.0.0.0', step: 0 }, snap.now));
    expect(SPF_OVERLAY.select(snap).has('r1')).toBe(true);
  });

  it('memoises each P3 entry per device object', () => {
    const snap = routingWorld();
    const again = snapshot([...snap.devices], snap.links, { now: snap.now });
    for (const m of [QOS_OVERLAY, OSPF_OVERLAY, WAN_OVERLAY, EIGRP_OVERLAY, SPF_OVERLAY]) expect(m.select(again).get('r1'), m.id).toBe(m.select(snap).get('r1'));
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
