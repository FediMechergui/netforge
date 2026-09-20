import { describe, expect, it } from 'vitest';
import type { DeviceKind } from '../src/contracts/device.js';
import type { Scheduler, SimEvent } from '../src/contracts/events.js';
import type { DeviceId, PortId, PortRef } from '../src/contracts/ids.js';
import { MEDIA } from '../src/contracts/link.js';
import type { LinkModelDeps, LinkSpec } from '../src/contracts/link.js';
import { ARP_OP_REQUEST, ETHERTYPE_ARP, ETH_PHY_OVERHEAD } from '../src/contracts/pdu.js';
import type { LayerSpec, Pdu, PduMeta } from '../src/contracts/pdu.js';
import { SPEED_100M, SPEED_1G, emptyCounters } from '../src/contracts/port.js';
import type { PortKind, PortState } from '../src/contracts/port.js';
import { propagationNs, serializationNs } from '../src/contracts/time.js';
import type { TraceEvent } from '../src/contracts/trace.js';
import { createRng } from '../src/core/prng.js';
import { createScheduler } from '../src/core/scheduler.js';
import { createLinkModel, summarize } from '../src/link/link.js';
import { createPduFactory } from '../src/pdu/factory.js';
import type { Capability } from '../src/contracts/catalog.js';
import { portStateFields, testPortSpec, INERT_LINK_DEPS } from './port.fixtures.js';

// ── harness ───────────────────────────────────────────────────────────────────

interface Dev {
  kind: DeviceKind;
  up: boolean;
  power: boolean;
  ports: Map<PortId, PortState>;
}

/** Capabilities of the fake device kinds: they pick each port's default role, and so its copper wiring (§9.2). */
const KIND_CAPS: Partial<Record<DeviceKind, readonly Capability[]>> = { pc: ['host'], laptop: ['host'], server: ['host'], router: ['routing'], switch: ['switching'], hub: ['repeater'] };
/** Device kinds with a host shell (the terminal end of a console cable). */
const HOST_KINDS: readonly DeviceKind[] = ['pc', 'laptop', 'server'];

function makePort(id: PortId, kind: PortKind, speedBps: number, mac: string, opts: { autoMdix?: boolean; adminUp?: boolean; caps?: readonly Capability[] } = {}): PortState {
  const spec = testPortSpec({ name: id, short: id, kind, speedBps }, opts.caps ?? []);
  const p: PortState = {
    id,
    spec,
    ...portStateFields(spec),
    mac,
    adminUp: opts.adminUp ?? true,
    operUp: false,
    mtu: 1500,
    counters: emptyCounters(),
    l3: {},
    tx: { busyUntil: 0, queue: 0 },
  };
  if (opts.autoMdix !== undefined) p.spec.autoMdix = opts.autoMdix;
  return p;
}

function harness(seed = 7) {
  const devices = new Map<DeviceId, Dev>();
  const events: TraceEvent[] = [];
  const scheduler: Scheduler = createScheduler();
  let macIdx = 1;
  const nextMac = (): string => `00:1f:00:00:00:${(macIdx++).toString(16).padStart(2, '0')}`;

  const addDevice = (id: DeviceId, kind: DeviceKind, ports: { id: PortId; kind?: PortKind; speed?: number; autoMdix?: boolean; adminUp?: boolean }[]): Dev => {
    const d: Dev = { kind, up: true, power: true, ports: new Map() };
    for (const p of ports) {
      d.ports.set(p.id, makePort(p.id, p.kind ?? 'ethernet', p.speed ?? SPEED_1G, nextMac(), { autoMdix: p.autoMdix, adminUp: p.adminUp, caps: KIND_CAPS[kind] ?? [] }));
    }
    devices.set(id, d);
    return d;
  };

  const deps: LinkModelDeps = {
    ...INERT_LINK_DEPS,
    scheduler,
    trace: { emit: (ev) => events.push(ev) },
    rng: createRng(seed).split('links'),
    port: (ref: PortRef) => {
      const d = devices.get(ref.device);
      if (!d || !d.power) return undefined;
      return d.ports.get(ref.port);
    },
    deviceUp: (id) => devices.get(id)?.up ?? false,
    hostTerminal: (id) => HOST_KINDS.includes(devices.get(id)?.kind ?? 'iot'),
  };
  const model = createLinkModel(deps);
  const pdus = createPduFactory();

  const port = (device: DeviceId, id: PortId): PortState => devices.get(device)!.ports.get(id)!;
  const kinds = (): string[] => events.map((e) => e.kind);
  const drain = (): SimEvent[] => {
    const out: SimEvent[] = [];
    for (let ev = scheduler.next(); ev; ev = scheduler.next()) out.push(ev);
    return out;
  };

  return { devices, events, scheduler, deps, model, pdus, addDevice, port, kinds, drain };
}

const meta = (over: Partial<PduMeta> = {}): PduMeta => ({ born: 0, origin: 'd_pc1', ...over });

const arpFrame = (src = '00:1f:00:00:00:01'): LayerSpec[] => [
  { proto: 'ethernet', fields: { dst: 'ff:ff:ff:ff:ff:ff', src, type: ETHERTYPE_ARP } },
  { proto: 'arp', fields: { op: ARP_OP_REQUEST, sha: src, spa: '10.0.0.1', tha: '00:00:00:00:00:00', tpa: '10.0.0.2' } },
];

/** PC1 Gi0 ↔ SW1 Fa0/1 (100M, auto-MDIX), 3 m straight cable. */
function pcSwitch(seed = 7, spec: Partial<LinkSpec> = {}) {
  const h = harness(seed);
  h.addDevice('d_pc1', 'pc', [{ id: 'GigabitEthernet0' }]);
  h.addDevice('d_sw1', 'switch', [
    { id: 'FastEthernet0/1', speed: SPEED_100M, autoMdix: true },
    { id: 'FastEthernet0/2', speed: SPEED_100M, autoMdix: true },
  ]);
  const link = h.model.add(
    {
      id: 'l_1',
      a: { device: 'd_pc1', port: 'GigabitEthernet0' },
      b: { device: 'd_sw1', port: 'FastEthernet0/1' },
      media: 'copper-straight',
      lengthM: 3,
      impairments: { lossPct: 0, latencyNs: 0, jitterNs: 0, corruptPct: 0 },
      ...spec,
    },
    0,
  );
  return { ...h, link, A: { device: 'd_pc1', port: 'GigabitEthernet0' }, B: { device: 'd_sw1', port: 'FastEthernet0/1' } };
}

// ── up/down derivation ────────────────────────────────────────────────────────

describe('link/link add + up/down derivation', () => {
  it('a valid cable between two booted devices comes up and negotiates min speed, full duplex', () => {
    const h = pcSwitch();
    expect(h.link.up).toBe(true);
    expect(h.link.downReason).toBeUndefined();
    expect(h.link.negotiatedBps).toBe(SPEED_100M);
    expect(h.link.resolvedMedia).toBe('copper-straight');
    const a = h.port('d_pc1', 'GigabitEthernet0');
    const b = h.port('d_sw1', 'FastEthernet0/1');
    expect(a.link).toBe('l_1');
    expect(b.link).toBe('l_1');
    for (const p of [a, b]) {
      expect(p.operUp).toBe(true);
      expect(p.speedBps).toBe(SPEED_100M);
      expect(p.duplex).toBe('full');
      expect(p.lastChange).toBe(0);
    }
    expect(h.kinds()).toEqual(['linkState', 'portState', 'portState']);
    expect(h.events[0]).toEqual({ t: 0, kind: 'linkState', link: 'l_1', up: true, reason: 'cable-connected' });
    expect(h.events[1]).toMatchObject({ kind: 'portState', device: 'd_pc1', port: 'GigabitEthernet0', adminUp: true, operUp: true });
    expect(h.events[2]).toMatchObject({ kind: 'portState', device: 'd_sw1', port: 'FastEthernet0/1', adminUp: true, operUp: true });
  });

  it('get/list/linkOf/peerOf return copies and the right ends', () => {
    const h = pcSwitch();
    const g = h.model.get('l_1')!;
    expect(g).toEqual(h.link);
    g.impairments.lossPct = 50;
    expect(h.model.get('l_1')!.impairments.lossPct).toBe(0);
    expect(h.model.list().map((l) => l.id)).toEqual(['l_1']);
    expect(h.model.linkOf(h.A)?.id).toBe('l_1');
    expect(h.model.linkOf(h.B)?.id).toBe('l_1');
    expect(h.model.linkOf({ device: 'd_sw1', port: 'FastEthernet0/2' })).toBeUndefined();
    expect(h.model.peerOf(h.A)).toEqual(h.B);
    expect(h.model.peerOf(h.B)).toEqual(h.A);
    expect(h.model.peerOf({ device: 'nope', port: 'x' })).toBeUndefined();
    expect(h.model.get('l_9')).toBeUndefined();
  });

  it('admin-down on either end takes the link down with a side-specific reason', () => {
    const h = pcSwitch();
    h.events.length = 0;
    h.port('d_sw1', 'FastEthernet0/1').adminUp = false;
    const changed = h.model.recompute('l_1', 10, 'shutdown');
    expect(changed).toEqual([
      { port: h.A, operUp: false },
      { port: h.B, operUp: false },
    ]);
    const s = h.model.get('l_1')!;
    expect(s.up).toBe(false);
    expect(s.downReason).toBe('admin-down:b');
    expect(s.negotiatedBps).toBeUndefined();
    expect(h.port('d_pc1', 'GigabitEthernet0').speedBps).toBeUndefined();
    expect(h.port('d_pc1', 'GigabitEthernet0').duplex).toBeUndefined();
    expect(h.port('d_pc1', 'GigabitEthernet0').lastChange).toBe(10);
    expect(h.events).toEqual([
      { t: 10, kind: 'linkState', link: 'l_1', up: false, reason: 'shutdown' },
      { t: 10, kind: 'portState', device: 'd_pc1', port: 'GigabitEthernet0', adminUp: true, operUp: false, reason: 'shutdown' },
      { t: 10, kind: 'portState', device: 'd_sw1', port: 'FastEthernet0/1', adminUp: false, operUp: false, reason: 'shutdown' },
    ]);

    // no change → no events, nothing returned
    h.events.length = 0;
    expect(h.model.recompute('l_1', 11)).toEqual([]);
    expect(h.events).toEqual([]);

    // a-side admin-down wins over b-side
    h.port('d_pc1', 'GigabitEthernet0').adminUp = false;
    h.model.recompute('l_1', 12);
    expect(h.model.get('l_1')!.downReason).toBe('admin-down:a');

    // back up: reason defaults to none on the way up when not given
    h.port('d_pc1', 'GigabitEthernet0').adminUp = true;
    h.port('d_sw1', 'FastEthernet0/1').adminUp = true;
    h.events.length = 0;
    const up = h.model.recompute('l_1', 20);
    expect(up).toEqual([
      { port: h.A, operUp: true },
      { port: h.B, operUp: true },
    ]);
    expect(h.events[0]).toEqual({ t: 20, kind: 'linkState', link: 'l_1', up: true });
    expect(h.port('d_sw1', 'FastEthernet0/1').lastChange).toBe(20);
  });

  it('power-off / not booted / err-disabled / cut are derived in order', () => {
    const h = pcSwitch();
    const pc1 = h.devices.get('d_pc1')!;
    const sw1 = h.devices.get('d_sw1')!;

    sw1.power = false; // deps.port returns undefined
    h.model.recompute('l_1', 1);
    expect(h.model.get('l_1')!.downReason).toBe('power-off:b');
    sw1.power = true;
    sw1.up = false; // booting
    h.model.recompute('l_1', 2);
    expect(h.model.get('l_1')!.downReason).toBe('power-off:b');
    pc1.up = false;
    h.model.recompute('l_1', 3);
    expect(h.model.get('l_1')!.downReason).toBe('power-off:a');
    pc1.up = true;
    sw1.up = true;

    h.port('d_pc1', 'GigabitEthernet0').errDisabled = 'loopback';
    h.model.recompute('l_1', 4);
    expect(h.model.get('l_1')!.downReason).toBe('err-disabled:a');
    delete h.port('d_pc1', 'GigabitEthernet0').errDisabled;
    h.model.recompute('l_1', 4);
    expect(h.model.get('l_1')!.up).toBe(true);

    h.events.length = 0;
    expect(h.model.cut('l_1', true, 5)).toEqual([
      { port: h.A, operUp: false },
      { port: h.B, operUp: false },
    ]);
    expect(h.model.isCut('l_1')).toBe(true);
    expect(h.model.get('l_1')!.downReason).toBe('cut');
    expect(h.events[0]).toEqual({ t: 5, kind: 'linkState', link: 'l_1', up: false, reason: 'cable-cut' });
    expect(h.model.cut('l_1', false, 6)!.length).toBe(2);
    expect(h.model.get('l_1')!.up).toBe(true);
    expect(h.model.cut('l_9', true, 6)).toBeUndefined();
    expect(h.model.isCut('l_9')).toBe(false);

    // admin-down beats cut in the derivation order
    h.model.cut('l_1', true, 7);
    h.port('d_sw1', 'FastEthernet0/1').adminUp = false;
    h.model.recompute('l_1', 8);
    expect(h.model.get('l_1')!.downReason).toBe('admin-down:b');
  });

  it('a wrong cable is created anyway but stays down with media-mismatch; too-long likewise', () => {
    const h = harness();
    h.addDevice('d_pc1', 'pc', [{ id: 'GigabitEthernet0' }]);
    h.addDevice('d_pc2', 'pc', [{ id: 'GigabitEthernet0' }]);
    const a = { device: 'd_pc1', port: 'GigabitEthernet0' };
    const b = { device: 'd_pc2', port: 'GigabitEthernet0' };
    const v = h.model.validate(a, b, 'copper-straight', 3);
    expect(v.ok).toBe(false);
    expect(v.reason).toContain('d_pc1 GigabitEthernet0 to d_pc2 GigabitEthernet0');
    expect(v.reason).toContain('use a crossover copper cable instead');
    expect(v.resolvedMedia).toBe('copper-straight'); // the cable actually chosen; the fix is in the reason

    const s = h.model.add({ id: 'l_bad', a, b, media: 'copper-straight', lengthM: 3, impairments: { lossPct: 0, latencyNs: 0, jitterNs: 0, corruptPct: 0 } }, 0);
    expect(s.up).toBe(false);
    expect(s.downReason).toBe('media-mismatch');
    expect(s.resolvedMedia).toBe('copper-straight');
    expect(h.port('d_pc1', 'GigabitEthernet0').operUp).toBe(false);
    expect(h.events).toEqual([]); // nothing changed: link was never up, ports were never up

    // transmit on a down link → drop link-down, ok:false
    const pdu = h.pdus.build(arpFrame(), meta());
    const r = h.model.transmit(a, pdu, 0);
    expect(r).toEqual({ ok: false, reason: 'link-down' });
    expect(h.events).toEqual([
      { t: 0, kind: 'drop', pdu: summarize(pdu), device: 'd_pc1', port: 'GigabitEthernet0', reason: 'link-down', detail: 'media-mismatch' },
    ]);
    expect(h.scheduler.size).toBe(0);
    expect(h.port('d_pc1', 'GigabitEthernet0').tx.queue).toBe(0);

    h.model.remove('l_bad', 1);
    const long = h.model.add({ id: 'l_long', a, b, media: 'copper-crossover', lengthM: 250, impairments: { lossPct: 0, latencyNs: 0, jitterNs: 0, corruptPct: 0 } }, 1);
    expect(long.up).toBe(false);
    expect(long.downReason).toBe('too-long');
  });

  it('same-device loops are created but flagged; auto resolves per port kinds', () => {
    const h = harness();
    h.addDevice('d_sw1', 'switch', [
      { id: 'FastEthernet0/1', speed: SPEED_100M, autoMdix: true },
      { id: 'FastEthernet0/2', speed: SPEED_100M, autoMdix: true },
    ]);
    h.addDevice('d_r1', 'router', [{ id: 'GigabitEthernet0/0' }, { id: 'Serial0/0/0', kind: 'serial', speed: 128_000 }]);
    h.addDevice('d_r2', 'router', [{ id: 'GigabitEthernet0/0' }, { id: 'Serial0/0/0', kind: 'serial', speed: 128_000 }]);
    const a = { device: 'd_sw1', port: 'FastEthernet0/1' };
    const b = { device: 'd_sw1', port: 'FastEthernet0/2' };
    const v = h.model.validate(a, b, 'auto', 1);
    expect(v.ok).toBe(false);
    expect(v.reason).toContain('both ends are on the same device');
    const self = h.model.validate(a, a, 'auto', 1);
    expect(self.ok).toBe(false);
    expect(self.reason).toContain('to itself');
    const loop = h.model.add({ id: 'l_loop', a, b, media: 'auto', lengthM: 1, impairments: { lossPct: 0, latencyNs: 0, jitterNs: 0, corruptPct: 0 } }, 0);
    expect(loop.up).toBe(false);
    expect(loop.downReason).toBe('same-device');
    expect(loop.resolvedMedia).toBe('copper-straight');

    const r1r2 = h.model.add(
      { id: 'l_rr', a: { device: 'd_r1', port: 'GigabitEthernet0/0' }, b: { device: 'd_r2', port: 'GigabitEthernet0/0' }, media: 'auto', lengthM: 2, impairments: { lossPct: 0, latencyNs: 0, jitterNs: 0, corruptPct: 0 } },
      0,
    );
    expect(r1r2.up).toBe(true);
    expect(r1r2.resolvedMedia).toBe('copper-crossover');
    expect(r1r2.negotiatedBps).toBe(SPEED_1G);

    const ser = h.model.add(
      { id: 'l_ser', a: { device: 'd_r1', port: 'Serial0/0/0' }, b: { device: 'd_r2', port: 'Serial0/0/0' }, media: 'auto', lengthM: 2, impairments: { lossPct: 0, latencyNs: 0, jitterNs: 0, corruptPct: 0 } },
      0,
    );
    expect(ser.up).toBe(true);
    expect(ser.resolvedMedia).toBe('serial');
    expect(ser.negotiatedBps).toBe(128_000);
  });

  it('occupied ports are refused by validate and add; duplicate ids and bad lengths throw', () => {
    const h = pcSwitch();
    const other = { device: 'd_sw1', port: 'FastEthernet0/2' };
    const v = h.model.validate(h.A, other, 'auto', 1);
    expect(v.ok).toBe(false);
    expect(v.reason).toContain('already has a cable attached');
    expect(() => h.model.add({ ...h.link, id: 'l_dup' }, 0)).toThrow(/already has a cable/);
    expect(() => h.model.add({ ...h.link, a: other, b: { device: 'd_pc1', port: 'x' } }, 0)).toThrow(/already exists/);
    h.model.remove('l_1', 0);
    expect(() => h.model.add({ ...h.link, lengthM: -1 }, 0)).toThrow(RangeError);
  });

  it('a cable to a powered-off device is validated once the device is back', () => {
    const h = harness();
    h.addDevice('d_pc1', 'pc', [{ id: 'GigabitEthernet0' }]);
    const sw = h.addDevice('d_sw1', 'switch', [{ id: 'FastEthernet0/1', speed: SPEED_100M, autoMdix: true }]);
    sw.power = false;
    const a = { device: 'd_pc1', port: 'GigabitEthernet0' };
    const b = { device: 'd_sw1', port: 'FastEthernet0/1' };
    const v = h.model.validate(a, b, 'copper-straight', 3);
    expect(v.ok).toBe(false);
    expect(v.reason).toContain('powered off or unknown');
    const s = h.model.add({ id: 'l_1', a, b, media: 'auto', lengthM: 3, impairments: { lossPct: 0, latencyNs: 0, jitterNs: 0, corruptPct: 0 } }, 0);
    expect(s.up).toBe(false);
    expect(s.downReason).toBe('power-off:b');
    expect(s.resolvedMedia).toBe('copper-straight');
    expect(h.port('d_sw1', 'FastEthernet0/1').link).toBeUndefined(); // port was unreachable at add time
    sw.power = true;
    h.model.recompute('l_1', 5);
    const t = h.model.get('l_1')!;
    expect(t.up).toBe(true);
    expect(t.negotiatedBps).toBe(SPEED_100M);
  });

  it('remove clears both ports, forces operUp=false and emits state events', () => {
    const h = pcSwitch();
    h.events.length = 0;
    const changed = h.model.remove('l_1', 30);
    expect(changed).toEqual([
      { port: h.A, operUp: false },
      { port: h.B, operUp: false },
    ]);
    expect(h.port('d_pc1', 'GigabitEthernet0').link).toBeUndefined();
    expect(h.port('d_sw1', 'FastEthernet0/1').link).toBeUndefined();
    expect(h.port('d_sw1', 'FastEthernet0/1').operUp).toBe(false);
    expect(h.port('d_sw1', 'FastEthernet0/1').lastChange).toBe(30);
    expect(h.kinds()).toEqual(['linkState', 'portState', 'portState']);
    expect(h.events[0]).toEqual({ t: 30, kind: 'linkState', link: 'l_1', up: false, reason: 'cable-removed' });
    expect(h.model.get('l_1')).toBeUndefined();
    expect(h.model.list()).toEqual([]);
    expect(h.model.linkOf(h.A)).toBeUndefined();
    expect(h.model.remove('l_1', 31)).toEqual([]);
    expect(h.model.recompute('l_1', 31)).toEqual([]);
  });
});

// ── timing ────────────────────────────────────────────────────────────────────

describe('link/link transmit timing', () => {
  it('a 64-byte ARP on 100M: 6720 ns serialization + 16 ns propagation over 3 m', () => {
    const h = pcSwitch();
    const pdu = h.pdus.build(arpFrame(), meta());
    expect(pdu.size).toBe(64);
    h.events.length = 0;
    const r = h.model.transmit(h.A, pdu, 1000);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // (64 + 20) bytes * 8 bits / 100 Mbps = 6720 ns; 3 m / (0.66 c) = 15.16 ns → 16 ns
    expect(serializationNs(64 + ETH_PHY_OVERHEAD, SPEED_100M)).toBe(6720);
    expect(propagationNs(3, MEDIA['copper-straight'].velocityFactor)).toBe(16);
    expect(r).toEqual({ ok: true, link: 'l_1', txStart: 1000, txEnd: 7720, arrive: 7736 });

    const a = h.port('d_pc1', 'GigabitEthernet0');
    expect(a.tx.busyUntil).toBe(7720);
    expect(a.tx.queue).toBe(1);

    expect(h.events).toEqual([
      { t: 1000, kind: 'frameTx', pdu: summarize(pdu), link: 'l_1', from: h.A, to: h.B, txStart: 1000, txEnd: 7720, arrive: 7736 },
    ]);
    expect(summarize(pdu)).toEqual({ id: pdu.id, proto: 'arp', size: 64, summary: pdu.summary() });

    const evs = h.drain();
    expect(evs.map((e) => [e.kind, e.at])).toEqual([
      ['txComplete', 7720],
      ['frameArrival', 7736],
    ]);
    expect(evs[0]).toMatchObject({ kind: 'txComplete', device: 'd_pc1', port: 'GigabitEthernet0' });
    expect(evs[1]).toMatchObject({ kind: 'frameArrival', device: 'd_sw1', port: 'FastEthernet0/1' });
    const arrival = evs[1]!;
    expect(arrival.kind === 'frameArrival' && arrival.pdu).toBe(pdu);
    expect(arrival.kind === 'frameArrival' && arrival.corrupted).toBeUndefined();

    h.model.onTxComplete(h.A, 7720);
    expect(a.tx.queue).toBe(0);
    h.model.onTxComplete(h.A, 7721); // never below zero
    expect(a.tx.queue).toBe(0);
  });

  it('a 64-byte ARP on 1G: 672 ns serialization; bandwidth cap lowers the negotiated rate', () => {
    const h = harness();
    h.addDevice('d_pc1', 'pc', [{ id: 'GigabitEthernet0' }]);
    h.addDevice('d_pc2', 'pc', [{ id: 'GigabitEthernet0' }]);
    const A = { device: 'd_pc1', port: 'GigabitEthernet0' };
    const B = { device: 'd_pc2', port: 'GigabitEthernet0' };
    const s = h.model.add({ id: 'l_1', a: A, b: B, media: 'copper-crossover', lengthM: 100, impairments: { lossPct: 0, latencyNs: 0, jitterNs: 0, corruptPct: 0 } }, 0);
    expect(s.negotiatedBps).toBe(SPEED_1G);
    const pdu = h.pdus.build(arpFrame(), meta());
    const r = h.model.transmit(A, pdu, 0);
    // 672 bits / 1 Gbps = 672 ns; 100 m / (0.66 c) = 505.4 ns → 506 ns
    expect(propagationNs(100, 0.66)).toBe(506);
    expect(r).toEqual({ ok: true, link: 'l_1', txStart: 0, txEnd: 672, arrive: 672 + 506 });

    // Cap at 10 Mbps + 1 ms latency: serialization 67200 ns, arrive += 1_000_000
    const capped = h.model.setImpairments('l_1', { bandwidthBps: 10_000_000, latencyNs: 1_000_000 }, 0)!;
    expect(capped.negotiatedBps).toBe(10_000_000);
    expect(h.port('d_pc1', 'GigabitEthernet0').speedBps).toBe(10_000_000);
    const r2 = h.model.transmit(B, h.pdus.build(arpFrame(), meta()), 1000);
    expect(r2).toEqual({ ok: true, link: 'l_1', txStart: 1000, txEnd: 1000 + 67_200, arrive: 1000 + 67_200 + 506 + 1_000_000 });
    expect(h.model.setImpairments('l_9', {}, 0)).toBeUndefined();
    expect(() => h.model.setImpairments('l_1', { lossPct: 101 }, 0)).toThrow(RangeError);
    expect(() => h.model.setImpairments('l_1', { latencyNs: 1.5 }, 0)).toThrow(RangeError);
    expect(() => h.model.setImpairments('l_1', { bandwidthBps: 0 }, 0)).toThrow(RangeError);
  });

  it('back-to-back frames serialize sequentially on one port, independently per direction', () => {
    const h = pcSwitch();
    const p1 = h.pdus.build(arpFrame(), meta());
    const p2 = h.pdus.build(arpFrame(), meta());
    const p3 = h.pdus.build(arpFrame(), meta());
    const r1 = h.model.transmit(h.A, p1, 0);
    const r2 = h.model.transmit(h.A, p2, 0);
    const r3 = h.model.transmit(h.B, p3, 0); // other direction: own pipeline
    if (!r1.ok || !r2.ok || !r3.ok) throw new Error('expected ok');
    expect(r1.txStart).toBe(0);
    expect(r1.txEnd).toBe(6720);
    expect(r2.txStart).toBe(r1.txEnd);
    expect(r2.txEnd).toBe(2 * 6720);
    expect(r2.arrive).toBe(2 * 6720 + 16);
    expect(r3.txStart).toBe(0);
    expect(h.port('d_pc1', 'GigabitEthernet0').tx.queue).toBe(2);
    expect(h.port('d_pc1', 'GigabitEthernet0').tx.busyUntil).toBe(2 * 6720);
    expect(h.port('d_sw1', 'FastEthernet0/1').tx.queue).toBe(1);

    // a later send after the port went idle starts at `now`
    const r4 = h.model.transmit(h.A, h.pdus.build(arpFrame(), meta()), 20_000);
    expect(r4.ok && r4.txStart).toBe(20_000);
  });
});

// ── impairments ───────────────────────────────────────────────────────────────

describe('link/link impairments', () => {
  const imp = (over: Partial<{ lossPct: number; latencyNs: number; jitterNs: number; corruptPct: number }>) => ({
    lossPct: 0, latencyNs: 0, jitterNs: 0, corruptPct: 0, ...over,
  });

  it('loss 100% drops every frame with a mid-cable link-loss marker and schedules no arrival', () => {
    const h = pcSwitch(7, { impairments: imp({ lossPct: 100 }) });
    h.events.length = 0;
    const pdu = h.pdus.build(arpFrame(), meta({ tag: 'arp-request', flow: 'arp:10.0.0.1>10.0.0.2' }));
    const r = h.model.transmit(h.A, pdu, 0);
    expect(r).toEqual({ ok: true, link: 'l_1', txStart: 0, txEnd: 6720, arrive: 6736, lost: true });
    expect(h.kinds()).toEqual(['drop', 'frameTx']);
    expect(h.events[0]).toEqual({ t: 0, kind: 'drop', pdu: summarize(pdu), link: 'l_1', reason: 'link-loss', detail: 'loss 100%' });
    expect(summarize(pdu).tag).toBe('arp-request');
    expect(summarize(pdu).flow).toBe('arp:10.0.0.1>10.0.0.2');
    expect(h.drain().map((e) => e.kind)).toEqual(['txComplete']);
    // the pdu is untouched
    expect(pdu.provenance).toEqual([]);
    // it still shows as in flight until `arrive`, then is pruned
    expect(h.model.inflight(0).length).toBe(1);
    expect(h.model.inflight(6736)).toEqual([]);
    expect(h.model.inflight(0)).toEqual([]);
  });

  it('corrupt 100% flips a payload bit: fcsValid false, frame still decodes, arrival flagged corrupted', () => {
    const h = pcSwitch(7, { impairments: imp({ corruptPct: 100 }) });
    h.events.length = 0;
    const pdu = h.pdus.build(arpFrame(), meta());
    expect(pdu.get('ethernet.fcsValid')).toBe(true);
    const before = pdu.bytes;
    const r = h.model.transmit(h.A, pdu, 0);
    expect(r).toEqual({ ok: true, link: 'l_1', txStart: 0, txEnd: 6720, arrive: 6736, corrupted: true });
    expect(pdu.get('ethernet.fcsValid')).toBe(false);
    expect(pdu.layer('arp')).toBeDefined();
    expect(pdu.provenance.length).toBe(1);
    const m = pdu.provenance[0]!;
    expect(m).toMatchObject({ reason: 'Corruption', field: 'raw.bytes', at: 0, device: 'd_pc1' });
    // exactly one byte differs, inside the payload (past the 14-byte header, before the FCS)
    const after = pdu.bytes;
    const diffs: number[] = [];
    for (let i = 0; i < before.length; i++) if (before[i] !== after[i]) diffs.push(i);
    expect(diffs.length).toBe(1);
    expect(diffs[0]!).toBeGreaterThanOrEqual(14);
    expect(diffs[0]!).toBeLessThan(64 - 4);
    const flipped = (before[diffs[0]!]! ^ after[diffs[0]!]!) & 0xff;
    expect(flipped & (flipped - 1)).toBe(0); // a single bit
    const evs = h.drain();
    expect(evs.map((e) => e.kind)).toEqual(['txComplete', 'frameArrival']);
    expect(evs[1]).toMatchObject({ kind: 'frameArrival', corrupted: true });
    expect(h.kinds()).toEqual(['frameTx']);
  });

  it('same seed → same loss/corruption/jitter pattern; different seed → different', () => {
    const run = (seed: number): string => {
      const h = pcSwitch(seed, { impairments: imp({ lossPct: 30, corruptPct: 20, jitterNs: 5000 }) });
      const out: string[] = [];
      for (let i = 0; i < 40; i++) {
        const r = h.model.transmit(h.A, h.pdus.build(arpFrame(), meta()), i * 10_000);
        if (!r.ok) throw new Error('down');
        out.push(`${r.lost ? 'L' : r.corrupted ? 'C' : '.'}${r.arrive - r.txEnd}`);
      }
      return out.join(' ');
    };
    const a = run(42);
    expect(run(42)).toBe(a);
    expect(run(43)).not.toBe(a);
    expect(a).toMatch(/L/);
    expect(a).toMatch(/C/);
    expect(a).toMatch(/\./);
    // jitter stays in [0, jitterNs] on top of the 16 ns propagation
    for (const tok of a.split(' ')) {
      const extra = Number(tok.slice(1)) - 16;
      expect(extra).toBeGreaterThanOrEqual(0);
      expect(extra).toBeLessThanOrEqual(5000);
    }
  });

  it('a link with a different id does not share the stream, and the draw count is fixed per frame', () => {
    // With 0% everything, five draws per frame still happen: the fourth frame on a link
    // whose loss was raised afterwards sees the same fate as on a link that had loss all along.
    const seq = (changeAt: number): string => {
      const h = pcSwitch(99, { impairments: imp({ lossPct: changeAt === 0 ? 60 : 0 }) });
      const out: string[] = [];
      for (let i = 0; i < 12; i++) {
        if (i === changeAt && changeAt > 0) h.model.setImpairments('l_1', { lossPct: 60 }, i * 10_000);
        const r = h.model.transmit(h.A, h.pdus.build(arpFrame(), meta()), i * 10_000);
        out.push(r.ok && r.lost ? 'L' : '.');
      }
      return out.join('');
    };
    const always = seq(0);
    const late = seq(4);
    expect(late.slice(0, 4)).toBe('....');
    expect(late.slice(4)).toBe(always.slice(4));
  });
});

// ── inflight ──────────────────────────────────────────────────────────────────

describe('link/link inflight', () => {
  it('lists frames with txStart <= now < arrive ordered by (txStart, pdu.id), prunes arrived ones', () => {
    const h = pcSwitch();
    const p1 = h.pdus.build(arpFrame(), meta());
    const p2 = h.pdus.build(arpFrame(), meta());
    const p3 = h.pdus.build(arpFrame(), meta());
    h.model.transmit(h.B, p3, 0); // switch → pc, starts at 0 too, higher id
    h.model.transmit(h.A, p1, 0); // txStart 0
    h.model.transmit(h.A, p2, 0); // queued: txStart 6720

    const at0 = h.model.inflight(0);
    expect(at0.map((f) => f.pdu.id)).toEqual([p1.id, p3.id]); // p2 not started yet
    expect(at0[0]).toEqual({ pdu: summarize(p1), link: 'l_1', from: h.A, to: h.B, txStart: 0, txEnd: 6720, arrive: 6736 });
    expect(at0[1]!.from).toEqual(h.B);

    expect(h.model.inflight(6720).map((f) => f.pdu.id)).toEqual([p1.id, p3.id, p2.id]);
    // p1 and p3 arrive at 6736 → pruned; p2 still flying
    expect(h.model.inflight(6736).map((f) => f.pdu.id)).toEqual([p2.id]);
    // onFrameArrival removes an entry explicitly
    h.model.onFrameArrival(p2.id, h.B, 6737);
    expect(h.model.inflight(6737)).toEqual([]);
    h.model.onFrameArrival(999, h.B, 6737); // unknown: no-op
  });

  it('removing a link drops its in-flight entries', () => {
    const h = pcSwitch();
    h.model.transmit(h.A, h.pdus.build(arpFrame(), meta()), 0);
    expect(h.model.inflight(0).length).toBe(1);
    h.model.remove('l_1', 1);
    expect(h.model.inflight(1)).toEqual([]);
  });

  it('inflight output is structured-clone safe (no Pdu instances)', () => {
    const h = pcSwitch();
    h.model.transmit(h.A, h.pdus.build(arpFrame(), meta({ parent: 5 })), 0);
    const f = h.model.inflight(0)[0]!;
    expect(f.pdu.parent).toBe(5);
    expect(() => structuredClone(f)).not.toThrow();
  });
});

// ── review regressions ───────────────────────────────────────────────────────

describe('link/link review regressions', () => {
  const imp = (over: Partial<{ lossPct: number; latencyNs: number; jitterNs: number; corruptPct: number }>) => ({
    lossPct: 0, latencyNs: 0, jitterNs: 0, corruptPct: 0, ...over,
  });

  for (const how of ['cut', 'remove'] as const) {
    it(`${how}: a frame on the wire has its arrival cancelled and exactly one link-down drop on the link`, () => {
      const h = pcSwitch(7, { impairments: imp({ latencyNs: 1_000_000 }) });
      const pdu = h.pdus.build(arpFrame(), meta());
      const r = h.model.transmit(h.A, pdu, 0);
      expect(r.ok).toBe(true);
      h.events.length = 0;
      if (how === 'cut') h.model.cut('l_1', true, 100);
      else h.model.remove('l_1', 100);
      const drops = h.events.filter((e) => e.kind === 'drop');
      expect(drops).toEqual([
        { t: 100, kind: 'drop', pdu: summarize(pdu), link: 'l_1', reason: 'link-down', detail: how === 'cut' ? 'cut' : 'cable-removed' },
      ]);
      expect(h.drain().map((e) => e.kind)).toEqual(['txComplete']);
      expect(h.model.inflight(200)).toEqual([]);
      expect(h.model.__flyingSize()).toBe(0);
    });
  }

  it('a lost frame is not aborted on cut (it never arrives anyway) and emits no link-down drop', () => {
    const h = pcSwitch(7, { impairments: imp({ lossPct: 100, latencyNs: 1_000_000 }) });
    h.model.transmit(h.A, h.pdus.build(arpFrame(), meta()), 0);
    h.events.length = 0;
    h.model.cut('l_1', true, 100);
    expect(h.events.filter((e) => e.kind === 'drop')).toEqual([]);
  });

  it('lost frames do not accumulate internally when inflight() is never called', () => {
    const h = pcSwitch(7, { impairments: imp({ lossPct: 100 }) });
    for (let i = 0; i < 10_000; i++) {
      const r = h.model.transmit(h.A, h.pdus.build(arpFrame(), meta()), i * 10_000);
      expect(r.ok && r.lost).toBe(true);
    }
    expect(h.model.__flyingSize()).toBeLessThanOrEqual(1025);
  });

  it('a lost frame is still listed by inflight while txStart <= now < arrive', () => {
    const h = pcSwitch(7, { impairments: imp({ lossPct: 100 }) });
    const pdu = h.pdus.build(arpFrame(), meta());
    const r = h.model.transmit(h.A, pdu, 0);
    if (!r.ok) throw new Error('down');
    expect(h.model.inflight(r.arrive - 1).map((f) => f.pdu.id)).toEqual([pdu.id]);
    expect(h.model.inflight(r.arrive)).toEqual([]);
  });

  it('toggling corruptPct does not change loss or jitter decisions (fixed 5 draws per frame)', () => {
    const run = (corruptPct: number): string => {
      const h = pcSwitch(42, { impairments: imp({ lossPct: 30, jitterNs: 5000, corruptPct }) });
      const out: string[] = [];
      for (let i = 0; i < 100; i++) {
        const r = h.model.transmit(h.A, h.pdus.build(arpFrame(), meta()), i * 10_000);
        if (!r.ok) throw new Error('down');
        out.push(`${r.lost ? 'L' : '.'}${r.arrive - r.txEnd}`);
      }
      return out.join(' ');
    };
    expect(run(100)).toBe(run(0));
    expect(run(50)).toBe(run(0));
  });
});
