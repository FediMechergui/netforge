// The keyboard outline says the P3 overlays (ARCHITECTURE-P3 §6; W3 web-canvas): with QoS, OSPF, EIGRP or WAN on, or
// the link-state browser shown ([S3] SPF), port, device and cable rows carry each layer's facts — the same registry
// models the canvas draws, folded in paint order after the P2 facts; with everything off (and the browser hidden) the
// bare outline comes back untouched.
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_SWITCHPORT, emptyCounters } from '@netforge/engine';
import type { DeviceSnapshot, EgressQueueView, EigrpTopologyRow, OspfInterfaceRow, OspfNeighborRow, PortL2View, PortSnapshot, SimSnapshot } from '@netforge/engine';
import { decorateOutline, outlineFacts, type OutlineFacts } from '../src/canvas/a11y/CanvasOutline.js';
import { buildOutline } from '../src/canvas/a11y/keyboard-nav.js';
import { eigrpDeviceFacts, eigrpLinkFacts, eigrpPortFacts } from '../src/canvas/eigrp.js';
import type { OverlayFact } from '../src/canvas/l2.js';
import { ospfDeviceFacts, ospfLinkFacts, ospfPortFacts } from '../src/canvas/ospf.js';
import {
  EIGRP_OVERLAY,
  OSPF_OVERLAY,
  SPF_OVERLAY,
  TOPO_OVERLAY_DEFAULTS,
  WAN_OVERLAY,
  resetQosHistory,
  type OverlayRoutingInput,
} from '../src/canvas/overlays/registry.js';
import { spfDeviceFacts, spfLinkFacts, spfPortFacts } from '../src/canvas/spf.js';
import { wanDeviceFacts, wanLinkFacts, wanPortFacts } from '../src/canvas/wan.js';
import { device, link, port, snapshot } from './canvas-fixtures.js';

const SEC = 1_000_000_000;

afterEach(() => resetQosHistory());

// ── worlds ───────────────────────────────────────────────────────────────────

type ClassRow = EgressQueueView['classes'][number];

function cls(name: string, kind: ClassRow['kind'], over: Partial<ClassRow> = {}): ClassRow {
  return { name, kind, depth: 0, limit: 64, matched: 0, matchedBytes: 0, sent: 0, tailDrops: 0, policed: 0, offeredBps30s: 0, ...over };
}

const ACCESS_10: PortL2View = { config: { ...DEFAULT_SWITCHPORT, mode: 'access', accessVlan: 10 }, oper: 'access' };

/**
 * R1 Se0/0/0 (WAN-EDGE: VOICE priority, class-default full) ↔ R2 Se0/0/0 at 128 kb/s; SW1 Fa0/1 (access VLAN 10, two
 * frames waiting) ↔ PC1.
 */
function qosWorld(r1Out: number, now: number): SimSnapshot {
  const queue: EgressQueueView = {
    policy: 'WAN-EDGE',
    strategy: 'class-based',
    refBps: 128_000,
    classes: [cls('VOICE', 'priority', { depth: 1 }), cls('class-default', 'default', { depth: 64, tailDrops: 3 })],
  };
  const serial = (extra: Partial<PortSnapshot> = {}): PortSnapshot =>
    port('Se0/0/0', { short: 'Se0/0/0', kind: 'serial', role: 'routed', encap: 'hdlc', operUp: true, link: 'wan', speedBps: 128_000, ...extra });
  const r1 = device('r1', 0, 0, [serial({ counters: { ...emptyCounters(), outBytes: r1Out }, qos: { output: 'WAN-EDGE', classes: [], queue } })], {
    type: 'router.nf2911',
    model: 'NF-2911',
    kind: 'router',
  });
  const r2 = device('r2', 300, 0, [serial()], { type: 'router.nf2911', model: 'NF-2911', kind: 'router' });
  const backlog = {
    depth: 2,
    frames: [
      { pdu: 1, summary: { id: 1, proto: 'udp' as const, size: 64, summary: 'UDP #1' }, txStart: now + 1, bytes: 64, dscp: 46 },
      { pdu: 2, summary: { id: 2, proto: 'udp' as const, size: 64, summary: 'UDP #2' }, txStart: now + 2, bytes: 64, dscp: 0 },
    ],
  };
  const sw1 = device('sw1', 0, 200, [port('Fa0/1', { short: 'Fa0/1', role: 'switched', operUp: true, link: 'acc', l2: ACCESS_10, txBacklog: backlog })], {
    type: 'switch.nfc2960',
    model: 'NF-C2960',
    kind: 'switch',
    tables: { cam: [], arp: [], rib: [], extra: [{ name: 'vlans', title: 'VLANs', columns: [], rows: [{ key: '10', vlan: 10, name: 'VLAN10', status: 'active', source: 'config' }] }] },
  });
  const pc1 = device('pc1', 300, 200, [port('eth0', { link: 'acc', operUp: true })]);
  return snapshot(
    [r1, r2, sw1, pc1],
    [link('wan', ['r1', 'Se0/0/0'], ['r2', 'Se0/0/0'], { media: 'serial-dce', resolvedMedia: 'serial-dce' }), link('acc', ['sw1', 'Fa0/1'], ['pc1', 'eth0'])],
    { now },
  );
}

function ifRow(portId: string, routerId: string): OspfInterfaceRow {
  return {
    key: portId,
    port: portId,
    process: 1,
    routerId,
    area: '0.0.0.0',
    networkType: 'point-to-point',
    state: 'point-to-point',
    cost: 1,
    costSource: 'bandwidth',
    priority: 1,
    helloS: 10,
    deadS: 40,
    passive: false,
    neighbors: 1,
    adjacent: 1,
    stateSince: 0,
  } as OspfInterfaceRow;
}

function nbrRow(portId: string, routerId: string): OspfNeighborRow {
  return { key: `${portId}|${routerId}`, port: portId, routerId, address: '10.0.12.2', priority: 1, state: 'full', role: 'none', dr: '0.0.0.0', bdr: '0.0.0.0', stateSince: 0 } as OspfNeighborRow;
}

/** R1 Gi0/0 — R2 Gi0/0, a FULL OSPF adjacency in area 0; R1's EIGRP table holds the connected 10.0.12.0/24. */
function routingWorld(): SimSnapshot {
  const extra = (name: string, rows: unknown[]) => ({ name, title: name, columns: [], rows: rows as Record<string, unknown>[] });
  const eigrp = { key: '10.0.12.0/24', prefix: '10.0.12.0/24', state: 'passive', fd: 2816, successors: [], feasible: [], others: [], connected: 'Gi0/0' } as unknown as EigrpTopologyRow;
  const router = (id: string, rid: string, peer: string, rows: ReturnType<typeof extra>[] = []): DeviceSnapshot =>
    device(id, id === 'r1' ? 0 : 300, 0, [port('Gi0/0', { short: 'Gi0/0', role: 'routed', operUp: true, link: 'l1' })], {
      type: 'router.nf2911',
      model: 'NF-2911',
      kind: 'router',
      name: id.toUpperCase(),
      tables: { cam: [], arp: [], rib: [], extra: [extra('ospf-interfaces', [ifRow('Gi0/0', rid)]), extra('ospf-neighbors', [nbrRow('Gi0/0', peer)]), ...rows] },
    });
  return snapshot([router('r1', '1.1.1.1', '2.2.2.2', [extra('eigrp-topology', [eigrp])]), router('r2', '2.2.2.2', '1.1.1.1')], [link('l1', ['r1', 'Gi0/0'], ['r2', 'Gi0/0'])], {
    now: 50 * SEC,
  });
}

const HIDDEN: OverlayRoutingInput = { ui: { device: null, area: null, lsa: null, spf: { step: 0, playing: false } }, shown: false };

/** Every fact of `expected` is among `facts`' facts for the same key. */
function expectFolded<K>(facts: ReadonlyMap<K, readonly OverlayFact[]>, expected: ReadonlyMap<K, OverlayFact>): void {
  for (const [key, fact] of expected) expect(facts.get(key), String(key)).toContainEqual(fact);
}

function size(f: OutlineFacts): number {
  return f.ports.size + f.devices.size + f.links.size;
}

// ── cases ────────────────────────────────────────────────────────────────────

describe('outline facts of the P3 overlays', () => {
  it('are empty with every overlay off and the link-state browser hidden; the bare model comes back as is', () => {
    const snap = qosWorld(0, 0);
    const facts = outlineFacts(snap, TOPO_OVERLAY_DEFAULTS, HIDDEN);
    expect(size(facts)).toBe(0);
    const bare = buildOutline(snap);
    expect(decorateOutline(bare, facts)).toBe(bare);
    expect(size(outlineFacts(routingWorld(), TOPO_OVERLAY_DEFAULTS, HIDDEN))).toBe(0);
    expect(size(outlineFacts(null, { ...TOPO_OVERLAY_DEFAULTS, qos: true }))).toBe(0);
  });

  it('say the QoS overlay: class lanes and stacks on port rows, waiting ports on device rows, VLAN facts first', () => {
    const snap = qosWorld(0, 0);
    const model = decorateOutline(buildOutline(snap), outlineFacts(snap, { ...TOPO_OVERLAY_DEFAULTS, qos: true, vlan: true }));
    const r1 = model.devices.find((d) => d.id === 'r1');
    const se = r1?.ports.find((p) => p.ref.port === 'Se0/0/0');
    expect(se?.label).toBe('Se0/0/0 · P VOICE 1/64 · class-default 64/64 ✕');
    expect(se?.description).toMatch(
      /; output policy WAN-EDGE: VOICE, the priority queue, 1 of 64 waiting; class-default, 64 of 64 waiting, queue full · class-default \(3 dropped\)\.$/,
    );
    expect(r1?.label).toBe('R1, NF-2911 · queues 1');
    const fa = model.devices.find((d) => d.id === 'sw1')?.ports.find((p) => p.ref.port === 'Fa0/1');
    expect(fa?.label).toBe('Fa0/1 · V10 · queue 2: EF BE');
    expect(fa?.description).toMatch(/; access port in VLAN 10; 2 frames waiting to be sent, first to last: EF \(46\), BE \(0\)\.$/);
    // no load yet: one snapshot is no window
    expect(model.links.find((l) => l.id === 'wan')?.description).not.toContain('load');
  });

  it('say each direction’s load on the cable row once a second snapshot gives the window', () => {
    const on = { ...TOPO_OVERLAY_DEFAULTS, qos: true };
    outlineFacts(qosWorld(0, 0), on);
    const snap = qosWorld(16_000, SEC);
    const model = decorateOutline(buildOutline(snap), outlineFacts(snap, on));
    const cable = model.links.find((l) => l.id === 'wan');
    expect(cable?.label).toMatch(/ · → 100 % ← 0 %$/);
    expect(cable?.description).toMatch(
      /; load: sending at 100 % of the line rate \(near saturation\) from r1 Se0\/0\/0; sending at 0 % of the line rate \(light\) from r2 Se0\/0\/0\.$/,
    );
  });

  it('fold the OSPF, EIGRP and WAN facts of the same registry models the canvas draws', () => {
    const snap = routingWorld();
    const state = { ...TOPO_OVERLAY_DEFAULTS, ospf: true, eigrp: true, wan: true };
    const facts = outlineFacts(snap, state, HIDDEN);
    const input = { state, snapshot: snap, now: snap.now };
    const name = (id: string): string => snap.devices.find((d) => d.id === id)?.name ?? id;
    const ospf = OSPF_OVERLAY.sync(input);
    expect(ospfPortFacts(ospf).size).toBeGreaterThan(0);
    expectFolded(facts.ports, ospfPortFacts(ospf));
    expectFolded(facts.devices, ospfDeviceFacts(ospf));
    expectFolded(facts.links, ospfLinkFacts(ospf));
    const eigrp = EIGRP_OVERLAY.sync(input);
    expect(eigrpDeviceFacts(eigrp).size).toBeGreaterThan(0);
    expectFolded(facts.ports, eigrpPortFacts(eigrp));
    expectFolded(facts.devices, eigrpDeviceFacts(eigrp));
    expectFolded(facts.links, eigrpLinkFacts(eigrp, name));
    const wan = WAN_OVERLAY.sync(input);
    expectFolded(facts.ports, wanPortFacts(wan, name));
    expectFolded(facts.devices, wanDeviceFacts(wan, name));
    expectFolded(facts.links, wanLinkFacts(wan, name));
    // OSPF before EIGRP on R1's row (paint order)
    const r1 = facts.devices.get('r1') ?? [];
    const ospfAt = r1.findIndex((f) => f === ospfDeviceFacts(ospf).get('r1') || f.text === ospfDeviceFacts(ospf).get('r1')?.text);
    const eigrpAt = r1.findIndex((f) => f.text === eigrpDeviceFacts(eigrp).get('r1')?.text);
    expect(ospfAt).toBeGreaterThanOrEqual(0);
    expect(eigrpAt).toBeGreaterThan(ospfAt);
  });

  it('say the SPF frame only while the link-state browser is shown', () => {
    const snap = routingWorld();
    const ui = { device: 'r1', area: '0.0.0.0', lsa: null, spf: { step: 0, playing: false } };
    const shown: OverlayRoutingInput = { ui, shown: true };
    const facts = outlineFacts(snap, TOPO_OVERLAY_DEFAULTS, shown);
    const spf = SPF_OVERLAY.sync({ state: TOPO_OVERLAY_DEFAULTS, snapshot: snap, now: snap.now, routing: shown });
    expect(spf).not.toBeNull();
    expect(spfDeviceFacts(spf).size).toBeGreaterThan(0);
    expectFolded(facts.ports, spfPortFacts(spf));
    expectFolded(facts.devices, spfDeviceFacts(spf));
    expectFolded(facts.links, spfLinkFacts(spf));
    expect(size(outlineFacts(snap, TOPO_OVERLAY_DEFAULTS, { ui, shown: false }))).toBe(0);
    expect(size(outlineFacts(snap, TOPO_OVERLAY_DEFAULTS))).toBe(0);
  });
});
