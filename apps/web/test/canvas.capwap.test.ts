// The controller-tunnel (CAPWAP) overlay layer's pure parts (ARCHITECTURE-P2 §6, §3.12, D20; W6 web-canvas): the join
// steps and their fill, which controller session belongs to which access point, the tunnels drawn (joined, looking by
// broadcast, asking an address no device holds, listed only by the controller), the tube geometry (clearance boxes,
// the arc, the fill, the step ticks, stacked stubs) and the text forms the keyboard outline reads.
import { describe, expect, it } from 'vitest';
import type { CapwapApRow, CapwapRow, DeviceSnapshot, PortSnapshot, SimSnapshot } from '@netforge/engine';
import { decorateOutline, outlineFacts } from '../src/canvas/a11y/CanvasOutline.js';
import { buildOutline } from '../src/canvas/a11y/keyboard-nav.js';
import { airArc } from '../src/canvas/air.js';
import { bezierAt, bezierTangent } from '../src/canvas/cables.js';
import {
  CAPWAP_JOIN_STEPS,
  CAPWAP_STEP_COUNT,
  STUB_STEP,
  TUNNEL_BEND,
  TUNNEL_CLEARANCE,
  TUNNEL_SAMPLES,
  baseMacOf,
  boxExit,
  capwapDeviceFacts,
  capwapProgress,
  capwapSecured,
  capwapStateWord,
  capwapStep,
  capwapTunnelViews,
  deriveCapwapIdentity,
  describeTunnel,
  isDiscoveryBroadcast,
  progressPoints,
  sessionFor,
  shortTunnel,
  stepTicks,
  stubPoint,
  touchesTunnel,
  tunnelBox,
  tunnelCaption,
  tunnelGeometry,
  tunnelShapes,
  type CapwapTunnelView,
} from '../src/canvas/capwap.js';
import { buildCapwapOverlay } from '../src/canvas/overlays/capwap-model.js';
import { CAPWAP_OVERLAY, TOPO_OVERLAY_DEFAULTS } from '../src/canvas/overlays/registry.js';
import { deviceBounds, type DeviceGeom, type Layout } from '../src/canvas/ports.js';
import { inflateRect } from '../src/canvas/scene.js';
import { device, port, snapshot } from './canvas-fixtures.js';

// ── fixtures ─────────────────────────────────────────────────────────────────

function svi(id: string, mac: string, address: string, prefixLen = 24): PortSnapshot {
  return port(id, { mac, operUp: true, l3: { ipv4: { address, prefixLen } } });
}

function capwapRow(controller: string, state: CapwapRow['state'], wlans = 0): CapwapRow {
  return { key: controller, controller, state, since: 0, wlans } as CapwapRow;
}

function apRow(apMac: string, apIp: string, name: string, state: CapwapApRow['state'], clients = 0): CapwapApRow {
  return { key: apMac, apMac, apIp, name, state, clients } as CapwapApRow;
}

function ap(id: string, n: number, ports: PortSnapshot[], rows: CapwapRow[]): DeviceSnapshot {
  return device(id, n * 100, 200, ports, {
    type: 'ap.nfap-lw',
    model: 'NF-AP-1832',
    kind: 'ap',
    tables: { cam: [], arp: [], rib: [], extra: [{ name: 'capwap', title: 'Controller link', columns: [], rows: rows as unknown as Record<string, unknown>[] }] },
  });
}

const AP1_MAC = '02:0a:00:00:01:00';
const AP4_MAC = '02:0a:00:00:04:00';

/**
 * AP1 joined to WLC1 (2 WLANs, the controller counts 1 client); AP2 looking by broadcast to its subnet; AP3 asking an
 * address no device holds (and waiting for an address on a second row); AP4 reports nothing but WLC1 still lists it;
 * WLC1 also lists an AP no device is, and a row without a MAC.
 */
function world(): SimSnapshot {
  const ap1 = ap('ap1', 1, [port('Gi0', { mac: '02:0a:00:00:01:01', operUp: true }), svi('Vlan1', AP1_MAC, '192.168.99.20')], [capwapRow('192.168.99.5', 'run', 2)]);
  const ap2 = ap('ap2', 2, [svi('Vlan1', '02:0a:00:00:02:00', '192.168.99.21')], [capwapRow('192.168.99.255', 'discovery')]);
  const ap3 = ap('ap3', 3, [svi('Vlan1', '02:0a:00:00:03:00', '192.168.50.3')], [capwapRow('10.9.9.9', 'discovery'), capwapRow('10.9.9.10', 'idle')]);
  const ap4 = ap('ap4', 4, [svi('Vlan1', AP4_MAC, '192.168.99.24')], []);
  const wlc = device('wlc', 300, 0, [port('Gi0/1', { mac: '02:0b:00:00:00:01', operUp: true }), svi('Vlan99', '02:0b:00:00:00:00', '192.168.99.5')], {
    type: 'wlc.nfwlc9800',
    model: 'NF-WLC-9800',
    kind: 'wlc',
    name: 'WLC1',
    tables: {
      cam: [],
      arp: [],
      rib: [],
      extra: [
        {
          name: 'capwap-aps',
          title: 'Access points',
          columns: [],
          rows: [
            apRow(AP1_MAC, '192.168.99.20', 'AP1', 'run', 1),
            apRow(AP4_MAC, '192.168.99.24', 'AP4', 'run'),
            apRow('02:0c:00:00:00:00', '192.168.99.77', 'GONE', 'join'),
            { key: 'broken', state: 'run' },
          ] as unknown as Record<string, unknown>[],
        },
      ],
    },
  });
  return snapshot([ap1, ap2, ap3, ap4, wlc]);
}

function views(snap: SimSnapshot): readonly CapwapTunnelView[] {
  return capwapTunnelViews(buildCapwapOverlay(snap), snap);
}

function geom(d: DeviceSnapshot, x: number, y: number, halfW = 30, halfH = 20): DeviceGeom {
  return { device: d, x, y, halfW, halfH, visual: {} as DeviceGeom['visual'] };
}

const NAMES: Record<string, string> = { ap1: 'AP1', ap2: 'AP2', ap3: 'AP3', ap4: 'AP4', wlc: 'WLC1' };
const name = (id: string): string => NAMES[id] ?? id;

const close = (a: number, b: number): boolean => Math.abs(a - b) < 1e-9;

// ── join steps ───────────────────────────────────────────────────────────────

describe('join steps', () => {
  it('number the RFC 5415 states 1 to 6 and fill the tube a sixth per step', () => {
    expect(CAPWAP_JOIN_STEPS).toEqual(['discovery', 'dtls', 'join', 'configure', 'data-check', 'run']);
    expect(CAPWAP_STEP_COUNT).toBe(6);
    expect(CAPWAP_JOIN_STEPS.map(capwapStep)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(capwapStep('idle')).toBe(0);
    expect(capwapStep('mystery')).toBe(0);
    expect(capwapProgress('join')).toBe(0.5);
    expect(capwapProgress('run')).toBe(1);
    expect(capwapProgress('idle')).toBe(0);
  });

  it('protect the control channel from the simulated DTLS step on', () => {
    expect(['idle', ...CAPWAP_JOIN_STEPS].map((s) => capwapSecured(s))).toEqual([false, false, true, true, true, true, true]);
  });

  it('say each state in words', () => {
    expect(['idle', ...CAPWAP_JOIN_STEPS].map(capwapStateWord)).toEqual([
      'waiting for an address',
      'looking for a controller',
      'securing the control channel',
      'asking to join',
      'receiving its configuration',
      'checking the data channel',
      'joined',
    ]);
    expect(capwapStateWord('mystery')).toBe('mystery');
  });
});

// ── identity ─────────────────────────────────────────────────────────────────

describe('controller sessions and access point identity', () => {
  it('reads the controller rows, skipping a row without a MAC, and the port MACs with the base MAC', () => {
    const snap = world();
    const wlc = deriveCapwapIdentity(snap.devices[4]!);
    expect(wlc.sessions.map((s) => [s.apMac, s.apIp, s.name, s.state, s.clients])).toEqual([
      [AP1_MAC, '192.168.99.20', 'AP1', 'run', 1],
      [AP4_MAC, '192.168.99.24', 'AP4', 'run', 0],
      ['02:0c:00:00:00:00', '192.168.99.77', 'GONE', 'join', 0],
    ]);
    const ap1 = deriveCapwapIdentity(snap.devices[0]!);
    expect(ap1.sessions).toEqual([]);
    expect(ap1.macs).toEqual(['02:0a:00:00:01:01', AP1_MAC]);
    expect(ap1.addresses).toEqual([{ address: '192.168.99.20', prefixLen: 24 }]);
    // a device without an ordinal-0 port still answers to its base MAC
    const bare = deriveCapwapIdentity(device('x', 0, 0, [port('Gi0', { mac: '02:0d:00:00:00:03' })]));
    expect(bare.macs).toEqual(['02:0d:00:00:00:03', '02:0d:00:00:00:00']);
    expect(baseMacOf('02:0d:00:00:00:83')).toBe('02:0d:00:00:00:00');
  });

  it('finds the session of an access point by its base MAC first, then by its address', () => {
    const snap = world();
    const sessions = deriveCapwapIdentity(snap.devices[4]!).sessions;
    const ap1 = deriveCapwapIdentity(snap.devices[0]!);
    expect(sessionFor(sessions, ap1)?.name).toBe('AP1');
    // an AP whose MAC the controller does not know is matched by the address it reported
    const byIp = { sessions: [], macs: ['02:0e:00:00:00:00'], addresses: [{ address: '192.168.99.24', prefixLen: 24 }] };
    expect(sessionFor(sessions, byIp)?.name).toBe('AP4');
    expect(sessionFor(sessions, { sessions: [], macs: [], addresses: [] })).toBeUndefined();
  });

  it('knows a discovery broadcast: the limited one or a broadcast of the access point’s own subnet', () => {
    const ap = { sessions: [], macs: [], addresses: [{ address: '192.168.99.21', prefixLen: 24 }, { address: '10.0.0.1', prefixLen: 31 }] };
    expect(isDiscoveryBroadcast('255.255.255.255', ap)).toBe(true);
    expect(isDiscoveryBroadcast('192.168.99.255', ap)).toBe(true);
    expect(isDiscoveryBroadcast('192.168.98.255', ap)).toBe(false);
    expect(isDiscoveryBroadcast('192.168.99.5', ap)).toBe(false);
    expect(isDiscoveryBroadcast('10.0.0.1', ap)).toBe(false); // a /31 has no broadcast
  });
});

// ── the tunnels ──────────────────────────────────────────────────────────────

describe('tunnel views', () => {
  it('are empty with the overlay off or without a snapshot', () => {
    const snap = world();
    expect(capwapTunnelViews(null, snap)).toEqual([]);
    expect(capwapTunnelViews(buildCapwapOverlay(snap), null)).toEqual([]);
    expect(CAPWAP_OVERLAY.sync({ state: TOPO_OVERLAY_DEFAULTS, snapshot: snap, now: 0 })).toBeNull();
  });

  it('list the access points’ rows in model order, then the sessions only the controller still holds', () => {
    const v = views(world());
    expect(v.map((x) => [x.key, x.origin, x.ap, x.controller, x.state, x.letter, x.step, x.joined, x.secured, x.broadcast])).toEqual([
      ['ap1>192.168.99.5', 'ap', 'ap1', 'wlc', 'run', 'Run', 6, true, true, false],
      ['ap2>192.168.99.255', 'ap', 'ap2', null, 'discovery', 'Di', 1, false, false, true],
      ['ap3>10.9.9.9', 'ap', 'ap3', null, 'discovery', 'Di', 1, false, false, false],
      ['ap3>10.9.9.10', 'ap', 'ap3', null, 'idle', '–', 0, false, false, false],
      [`wlc<${AP4_MAC}`, 'controller', 'ap4', 'wlc', 'run', 'Run?', 6, false, true, false],
    ]);
    expect(v.map((x) => x.progress)).toEqual([1, 1 / 6, 1 / 6, 0, 0]);
    expect(v[0]!.wlans).toBe(2);
    expect(v[0]!.session?.clients).toBe(1);
    expect(v[1]!.session).toBeUndefined();
    expect(v[4]!.session?.name).toBe('AP4');
    expect(v[4]!.controllerAddress).toBeNull();
  });

  it('light up when either end, or one of its ports, is selected', () => {
    const t = { ap: 'ap1', controller: 'wlc' };
    expect(touchesTunnel({ kind: 'device', id: 'ap1' }, t)).toBe(true);
    expect(touchesTunnel({ kind: 'device', id: 'wlc' }, t)).toBe(true);
    expect(touchesTunnel({ kind: 'port', ref: { device: 'wlc', port: 'Gi0/1' } }, t)).toBe(true);
    expect(touchesTunnel({ kind: 'device', id: 'ap2' }, t)).toBe(false);
    expect(touchesTunnel({ kind: 'link', id: 'l1' }, t)).toBe(false);
    expect(touchesTunnel(null, t)).toBe(false);
    expect(touchesTunnel({ kind: 'device', id: 'ap2' }, { ap: 'ap2', controller: null })).toBe(true);
  });
});

// ── geometry ─────────────────────────────────────────────────────────────────

describe('tube geometry', () => {
  const box = { minX: -10, minY: -5, maxX: 10, maxY: 5 };

  it('leaves a box where the ray towards the other end crosses its border', () => {
    expect(boxExit({ x: 0, y: 0 }, box, { x: 100, y: 0 })).toEqual({ x: 10, y: 0 });
    expect(boxExit({ x: 0, y: 0 }, box, { x: 0, y: -100 })).toEqual({ x: 0, y: -5 });
    expect(boxExit({ x: 0, y: 0 }, box, { x: -40, y: 40 })).toEqual({ x: -5, y: 5 });
    // the other end inside the box: the ray stops there; the same point: the top of the box
    expect(boxExit({ x: 0, y: 0 }, box, { x: 4, y: 2 })).toEqual({ x: 4, y: 2 });
    expect(boxExit({ x: 0, y: 0 }, box, { x: 0, y: 0 })).toEqual({ x: 0, y: -5 });
  });

  it('runs on an arc from the access point’s clearance box to the controller’s, bulging left of travel', () => {
    const snap = world();
    const a = geom(snap.devices[0]!, 0, 0);
    const c = geom(snap.devices[4]!, 400, 0);
    expect(tunnelBox(a)).toEqual(inflateRect(deviceBounds(a, false), TUNNEL_CLEARANCE));
    const g = tunnelGeometry(a, c);
    expect(g.p0.x).toBeCloseTo(30 + TUNNEL_CLEARANCE, 9);
    expect(g.p0.y).toBe(0);
    expect(g.p3.x).toBeCloseTo(400 - 30 - TUNNEL_CLEARANCE, 9);
    expect(g.p3.y).toBe(0);
    expect(g).toEqual(airArc(g.p0, g.p3, TUNNEL_BEND));
    expect(g.p1.y).toBeLessThan(0); // travelling right, left is up
  });

  it('fills from the access point end as far as the join has got', () => {
    const g = airArc({ x: 0, y: 0 }, { x: 300, y: 0 }, TUNNEL_BEND);
    expect(progressPoints(g, 0)).toEqual([]);
    expect(progressPoints(g, -1)).toEqual([]);
    const full = progressPoints(g, 1);
    expect(full).toHaveLength(TUNNEL_SAMPLES + 1);
    expect(full[0]).toEqual(g.p0);
    expect(full[full.length - 1]).toEqual(bezierAt(g, 1));
    const half = progressPoints(g, capwapProgress('join'));
    expect(half).toHaveLength(Math.ceil(TUNNEL_SAMPLES / 2) + 1);
    expect(half[half.length - 1]).toEqual(bezierAt(g, 0.5));
    expect(progressPoints(g, 2)).toEqual(full);
  });

  it('marks the five step boundaries with ticks across the tube', () => {
    const g = airArc({ x: 0, y: 0 }, { x: 300, y: 60 }, TUNNEL_BEND);
    const ticks = stepTicks(g, 5);
    expect(ticks).toHaveLength(5);
    ticks.forEach((t, i) => {
      const u = (i + 1) / 6;
      const mid = bezierAt(g, u);
      expect(close((t.a.x + t.b.x) / 2, mid.x) && close((t.a.y + t.b.y) / 2, mid.y)).toBe(true);
      expect(close(Math.hypot(t.b.x - t.a.x, t.b.y - t.a.y), 10)).toBe(true);
      const tan = bezierTangent(g, u);
      expect(close((t.b.x - t.a.x) * tan.x + (t.b.y - t.a.y) * tan.y, 0)).toBe(true);
    });
  });

  it('puts a stub beside its access point, stacking upwards', () => {
    const g = { x: 100, y: 50, halfW: 30, halfH: 20 };
    expect(stubPoint(g, 0)).toEqual({ x: 152, y: 26 });
    expect(stubPoint(g, 1)).toEqual({ x: 152, y: 26 - STUB_STEP });
    expect(stubPoint(g, 0, 0.5)).toEqual({ x: 141, y: 28 });
  });

  it('gives an arc to a tunnel with both ends drawn and a stub to the others', () => {
    const snap = world();
    const [ap1, ap2, ap3, , wlc] = snap.devices;
    const layout: Pick<Layout, 'devices'> = {
      devices: new Map([
        ['ap1', geom(ap1!, 0, 200)],
        ['ap2', geom(ap2!, 200, 200)],
        ['ap3', geom(ap3!, 400, 200)],
        ['wlc', geom(wlc!, 200, 0)],
      ]),
    };
    const shapes = tunnelShapes(views(snap), layout);
    // AP4 is not drawn: its controller-only tunnel has no shape
    expect([...shapes.keys()]).toEqual(['ap1>192.168.99.5', 'ap2>192.168.99.255', 'ap3>10.9.9.9', 'ap3>10.9.9.10']);
    const arc = shapes.get('ap1>192.168.99.5');
    expect(arc?.geom).toEqual(tunnelGeometry(layout.devices.get('ap1')!, layout.devices.get('wlc')!));
    expect(arc?.badge).toEqual(bezierAt(arc!.geom!, 0.5));
    expect(shapes.get('ap2>192.168.99.255')).toEqual({ badge: stubPoint(layout.devices.get('ap2')!, 0) });
    expect(shapes.get('ap3>10.9.9.9')).toEqual({ badge: stubPoint(layout.devices.get('ap3')!, 0) });
    expect(shapes.get('ap3>10.9.9.10')).toEqual({ badge: stubPoint(layout.devices.get('ap3')!, 1) });
  });
});

// ── text forms ───────────────────────────────────────────────────────────────

describe('text forms', () => {
  it('describe every tunnel in a sentence, a short row form and a caption', () => {
    const v = views(world());
    expect(v.map((x) => describeTunnel(x, name))).toEqual([
      'tunnel to controller WLC1 (192.168.99.5): joined, 2 WLANs, 1 wireless client, control channel protected (simulated)',
      'looking for a controller by broadcast to 192.168.99.255, step 1 of 6',
      'tunnel to 10.9.9.9, an address no device in the workspace holds: looking for a controller, step 1 of 6',
      'tunnel to 10.9.9.10, an address no device in the workspace holds: waiting for an address',
      'controller WLC1 still lists a tunnel from it (joined), but the access point reports none',
    ]);
    expect(v.map(shortTunnel)).toEqual(['CAPWAP Run', 'CAPWAP Di 1/6', 'CAPWAP Di 1/6', 'CAPWAP –', 'CAPWAP Run?']);
    expect(v.map(tunnelCaption)).toEqual(['2 WLANs · 1 client', 'broadcast 192.168.99.255', 'to 10.9.9.9', 'to 10.9.9.10', '']);
  });

  it('say where the controller disagrees with the access point', () => {
    const base = views(world())[0]!;
    const midway: CapwapTunnelView = { ...base, state: 'join', letter: 'Jn', step: 3, progress: 0.5, joined: false };
    expect(describeTunnel(midway, name)).toBe(
      'tunnel to controller WLC1 (192.168.99.5): asking to join, step 3 of 6, control channel protected (simulated); the controller has it at "joined"',
    );
    const unlisted: CapwapTunnelView = { ...midway, session: undefined };
    expect(describeTunnel(unlisted, name)).toBe(
      'tunnel to controller WLC1 (192.168.99.5): asking to join, step 3 of 6, control channel protected (simulated); the controller does not list it',
    );
    expect(shortTunnel(midway)).toBe('CAPWAP Jn 3/6');
    expect(tunnelCaption(midway)).toBe('');
    expect(tunnelCaption({ ...base, session: undefined })).toBe('2 WLANs');
  });

  it('give each access point its tunnels and the controller how many have joined', () => {
    const snap = world();
    const facts = capwapDeviceFacts(views(snap), snap);
    expect([...facts.keys()]).toEqual(['ap1', 'ap2', 'ap3', 'ap4', 'wlc']);
    expect(facts.get('ap1')).toEqual({
      short: 'CAPWAP Run',
      text: 'tunnel to controller WLC1 (192.168.99.5): joined, 2 WLANs, 1 wireless client, control channel protected (simulated)',
    });
    expect(facts.get('ap3')?.short).toBe('CAPWAP Di 1/6, CAPWAP –');
    expect(facts.get('ap4')?.short).toBe('CAPWAP Run?');
    expect(facts.get('wlc')).toEqual({
      short: 'CAPWAP 1 of 2 joined',
      text: 'controller tunnelling with 2 access points: AP1 joined, AP4 listed as joined though the access point reports no tunnel',
    });
    expect(capwapDeviceFacts([], snap).size).toBe(0);
    expect(capwapDeviceFacts(views(snap), null).size).toBe(0);
  });

  it('reach the keyboard outline while the overlay is on, and only then', () => {
    const snap = world();
    expect(outlineFacts(snap, TOPO_OVERLAY_DEFAULTS).devices.size).toBe(0);
    const facts = outlineFacts(snap, { ...TOPO_OVERLAY_DEFAULTS, capwap: true });
    const model = decorateOutline(buildOutline(snap), facts);
    const ap1 = model.devices.find((d) => d.id === 'ap1');
    expect(ap1?.label).toBe('AP1, NF-AP-1832 · CAPWAP Run');
    expect(ap1?.description).toMatch(/; tunnel to controller WLC1 \(192\.168\.99\.5\): joined, 2 WLANs, 1 wireless client, control channel protected \(simulated\)\.$/);
    const wlc = model.devices.find((d) => d.id === 'wlc');
    expect(wlc?.label).toBe('WLC1, NF-WLC-9800 · CAPWAP 1 of 2 joined');
  });
});
