/**
 * P1 W3 netscope: the live capture tap on the link model (ARCHITECTURE-P1 §4.12; contracts/capture.ts `CaptureTap`,
 * contracts/link.ts `LinkModelDeps.capture`).
 *
 * A real link model is built over hand-made ports with the capture hub installed as its tap, and frames built by the
 * real PDU factory are transmitted through it. Checked: `wants` gating, tx at the transmit instant and rx at admit,
 * the immediate byte copy, per-capture direction and background filters, link types and FCS handling per
 * encapsulation (Ethernet keeps its 4-byte FCS; 802.11 and HDLC lose theirs), collision fragments, extra interfaces
 * for a different link type, capture point resolution and deterministic exports.
 */
import { describe, expect, it } from 'vitest';
import type { PortEncap } from '../src/contracts/catalog.js';
import { KIND_ENCAP } from '../src/contracts/catalog.js';
import type { DeviceId, PortId, PortRef } from '../src/contracts/ids.js';
import { portKey } from '../src/contracts/ids.js';
import type { LinkModelDeps } from '../src/contracts/link.js';
import { NO_IMPAIRMENTS } from '../src/contracts/link.js';
import {
  ETHERTYPE_IPV4,
  HDLC_ADDRESS_BROADCAST,
  HDLC_PROTO_KEEPALIVE,
  IPPROTO_UDP,
} from '../src/contracts/pdu.js';
import type { LayerSpec, Pdu, PduMeta } from '../src/contracts/pdu.js';
import { SPEED_100M, SPEED_1G, emptyCounters } from '../src/contracts/port.js';
import type { PortState } from '../src/contracts/port.js';
import { SEC } from '../src/contracts/time.js';
import { createRng } from '../src/core/prng.js';
import { createScheduler } from '../src/core/scheduler.js';
import { createLinkModel } from '../src/link/link.js';
import { createPduFactory } from '../src/pdu/factory.js';
import { readCapture } from '../src/io/pcap.js';
import {
  CAPTURE_LIVE_FCS_LEN,
  captureBytesOf,
  captureLinkForEncap,
  createCaptureHub,
  resolveCapturePoints,
  type CapturePointResolver,
} from '../src/capture/tap.js';
import { INERT_LINK_DEPS, testPortSpec } from './port.fixtures.js';

const meta = (over: Partial<PduMeta> = {}): PduMeta => ({ born: 0, origin: 'd_pc1', ...over });

/** A link model with the capture hub as its tap, two devices and a run loop dispatching through the model. */
function world(seed = 5) {
  const ports = new Map<string, PortState>();
  const deviceOrder: DeviceId[] = [];
  const devicePorts = new Map<DeviceId, PortId[]>();
  const names = new Map<string, string>();
  const scheduler = createScheduler();
  const pdus = createPduFactory();
  const hub = createCaptureHub();
  let macs = 0;
  const deps: LinkModelDeps = {
    ...INERT_LINK_DEPS,
    scheduler,
    trace: { emit: () => undefined },
    rng: createRng(seed).split('links'),
    port: (ref) => ports.get(portKey(ref)),
    deviceUp: (id) => devicePorts.has(id),
    pdus,
    capture: hub,
    devices: () => deviceOrder,
    devicePorts: (id) => devicePorts.get(id) ?? [],
  };
  const model = createLinkModel(deps);
  const links = new Map<string, PortRef[]>();

  const add = (device: DeviceId, label: string, port: PortId, role: 'routed' | 'switched', speedBps = SPEED_1G): PortRef => {
    macs++;
    const state: PortState = {
      id: port,
      spec: testPortSpec({ name: port, short: port, kind: 'ethernet', speedBps, role }),
      mac: `02:00:00:00:00:${macs.toString(16).padStart(2, '0')}`,
      adminUp: true,
      operUp: false,
      mtu: 1500,
      counters: emptyCounters(),
      l3: {},
      tx: { busyUntil: 0, queue: 0 },
      role,
      ordinal: 1,
      encap: KIND_ENCAP.ethernet,
    };
    const ref = { device, port };
    ports.set(portKey(ref), state);
    if (!devicePorts.has(device)) {
      deviceOrder.push(device);
      devicePorts.set(device, []);
    }
    devicePorts.get(device)!.push(port);
    names.set(portKey(ref), `${label} ${port}`);
    return ref;
  };
  const connect = (id: string, a: PortRef, b: PortRef): void => {
    model.add({ id, a, b, media: 'copper-straight', lengthM: 3, impairments: { ...NO_IMPAIRMENTS } }, scheduler.now);
    links.set(id, [a, b]);
  };
  const run = (until: number): void => {
    for (;;) {
      const at = scheduler.peekTime();
      if (at === undefined || at > until) {
        if (scheduler.now < until) scheduler.advanceTo(until);
        return;
      }
      const ev = scheduler.next();
      if (!ev) return;
      if (ev.kind === 'frameArrival') model.admit(ev, ev.at);
      else if (ev.kind === 'txComplete') model.onTxComplete({ device: ev.device, port: ev.port }, ev.at);
    }
  };
  const resolver: CapturePointResolver = {
    allPorts: () => deviceOrder.flatMap((d) => (devicePorts.get(d) ?? []).map((port) => ({ device: d, port }))),
    linkPorts: (id) => links.get(id),
    portName: (ref) => names.get(portKey(ref)),
    encap: (ref) => ports.get(portKey(ref))?.encap,
  };
  const pc = add('d_pc1', 'PC1', 'Gi0', 'routed');
  const sw = add('d_sw1', 'SW1', 'Fa0/1', 'switched', SPEED_100M);
  connect('l_1', pc, sw);
  return { hub, model, pdus, scheduler, run, resolver, pc, sw, ports };
}

const udpFrame = (srcMac: string, text: string, ttl = 64): LayerSpec[] => [
  { proto: 'ethernet', fields: { src: srcMac, dst: '02:00:00:00:00:02', type: ETHERTYPE_IPV4 } },
  { proto: 'ipv4', fields: { src: '192.168.1.2', dst: '192.168.1.3', protocol: IPPROTO_UDP, ttl } },
  { proto: 'udp', fields: { srcPort: 50000, dstPort: 9999 } },
  { proto: 'payload', fields: { data: new TextEncoder().encode(text) } },
];

describe('capture tap on the link model', () => {
  it('costs nothing without captures: wants() is false and nothing is recorded', () => {
    const w = world();
    expect(w.hub.wants(w.pc)).toBe(false);
    const pdu = w.pdus.build(udpFrame('02:00:00:00:00:01', 'x'), meta());
    expect(w.model.transmit(w.pc, pdu, 0).ok).toBe(true);
    w.run(SEC);
    expect(w.hub.list()).toEqual([]);
  });

  it('records tx at the transmit instant and rx at admit, as independent byte copies with the Ethernet FCS', () => {
    const w = world();
    const store = w.hub.start({ links: ['l_1'] }, resolveCapturePoints({ links: ['l_1'] }, w.resolver));
    expect(store.id).toBe('c_1');
    expect(store.info()).toMatchObject({ name: 'Capture c_1', source: 'live', running: true, head: 0 });
    expect(store.info().interfaces).toEqual([
      { index: 0, ref: w.pc, name: 'PC1 Gi0', linkType: 'ethernet', fcsLen: 4 },
      { index: 1, ref: w.sw, name: 'SW1 Fa0/1', linkType: 'ethernet', fcsLen: 4 },
    ]);
    expect(w.hub.wants(w.pc)).toBe(true);

    const pdu = w.pdus.build(udpFrame('02:00:00:00:00:01', 'hello'), meta());
    const wire = pdu.bytes.slice();
    const r = w.model.transmit(w.pc, pdu, 0);
    if (!r.ok) throw new Error('transmit failed');
    // Mutate the live PDU after the tx record: the capture keeps the bytes as they were on the wire.
    pdu.mutate({ now: 0, device: 'd_sw1' }, 'ipv4.ttl', 63, 'TtlDecrement');
    w.run(SEC);

    const recs = store.records();
    expect(recs.map((x) => [x.index, x.dir, x.iface, x.t])).toEqual([
      [0, 'tx', 0, r.txStart],
      [1, 'rx', 1, r.arrive],
    ]);
    expect(recs[0]!.bytes).toEqual(wire);
    expect(recs[0]!.bytes).not.toBe(pdu.bytes);
    expect(recs[0]!.origLen).toBe(wire.length);
    expect(recs[0]!.pdu).toBe(pdu.id);
    // The rx copy was taken at admit, after the in-place TTL change.
    expect(recs[1]!.bytes).toEqual(pdu.bytes);

    const rows = store.query({ from: 0, limit: 10 }).rows;
    expect(rows.map((x) => [x.proto, x.src, x.dst, x.stream])).toEqual([
      ['udp', '192.168.1.2', '192.168.1.3', 'udp:192.168.1.2:50000-192.168.1.3:9999'],
      ['udp', '192.168.1.2', '192.168.1.3', 'udp:192.168.1.2:50000-192.168.1.3:9999'],
    ]);
    const d = store.record(0)!;
    expect(d.layers.map((l) => l.proto)).toEqual(['ethernet', 'ipv4', 'udp', 'payload']);
    expect(d.layers[0]!.fields.fcsValid).toBe(true);
    expect(store.query({ filter: 'ip.ttl == 63', from: 0, limit: 10 }).rows.map((x) => x.index)).toEqual([1]);
  });

  it('filters by direction per capture, stops and removes', () => {
    const w = world();
    const tx = w.hub.start({ ports: [w.pc, w.sw], dir: 'tx', name: 'tx only' }, resolveCapturePoints({ ports: [w.pc, w.sw] }, w.resolver));
    const rx = w.hub.start({ ports: [w.sw], dir: 'rx' }, resolveCapturePoints({ ports: [w.sw] }, w.resolver));
    expect(tx.id).toBe('c_1');
    expect(rx.id).toBe('c_2');
    w.model.transmit(w.pc, w.pdus.build(udpFrame('02:00:00:00:00:01', 'a'), meta()), 0);
    w.run(SEC);
    expect(tx.records().map((x) => x.dir)).toEqual(['tx']);
    expect(rx.records().map((x) => x.dir)).toEqual(['rx']);

    expect(w.hub.stop('c_1')).toBe(true);
    expect(w.hub.wants(w.pc)).toBe(false);
    expect(w.hub.wants(w.sw)).toBe(true);
    w.model.transmit(w.pc, w.pdus.build(udpFrame('02:00:00:00:00:01', 'b'), meta()), w.scheduler.now);
    w.run(2 * SEC);
    expect(tx.info()).toMatchObject({ running: false, head: 1 });
    expect(rx.info().head).toBe(2);
    expect(w.hub.list().map((c) => [c.id, c.name, c.running])).toEqual([
      ['c_1', 'tx only', false],
      ['c_2', 'Capture c_2', true],
    ]);
    expect(w.hub.remove('c_2')).toBe(true);
    expect(w.hub.remove('c_2')).toBe(false);
    expect(w.hub.stop('c_9')).toBe(false);
    expect(w.hub.wants(w.sw)).toBe(false);
    expect(w.hub.get('c_1')).toBe(tx);
    expect(() => w.hub.start({}, [], { id: 'c_1' })).toThrow(/already exists/);
    w.hub.clear();
    expect(w.hub.list()).toEqual([]);
    expect(w.hub.start({}, []).id).toBe('c_3');
  });

  it('skips background frames unless the capture includes them', () => {
    const w = world();
    const quiet = w.hub.start({ ports: [w.pc] }, resolveCapturePoints({ ports: [w.pc] }, w.resolver));
    const all = w.hub.start({ ports: [w.pc], includeBackground: true }, resolveCapturePoints({ ports: [w.pc] }, w.resolver));
    w.model.transmit(w.pc, w.pdus.build(udpFrame('02:00:00:00:00:01', 'bg'), meta({ background: true })), 0);
    w.run(SEC);
    expect(quiet.info().head).toBe(0);
    expect(all.info().head).toBe(1);
  });

  it('exports are byte-deterministic for the same seed and read back as the same frames', () => {
    const once = (): Uint8Array => {
      const w = world(11);
      const store = w.hub.start({}, resolveCapturePoints({}, w.resolver));
      for (let i = 0; i < 3; i++) {
        w.model.transmit(w.pc, w.pdus.build(udpFrame('02:00:00:00:00:01', `m${i}`), meta()), w.scheduler.now);
        w.run(w.scheduler.now + SEC);
      }
      return store.export({ format: 'pcapng' });
    };
    const a = once();
    expect(once()).toEqual(a);
    const file = readCapture(a);
    expect(file.interfaces.map((i) => [i.name, i.linkType, i.fcsLen])).toEqual([['PC1 Gi0', 'ethernet', 4], ['SW1 Fa0/1', 'ethernet', 4]]);
    expect(file.records.map((r) => r.dir)).toEqual(['tx', 'rx', 'tx', 'rx', 'tx', 'rx']);
  });
});

describe('capture bytes per link type', () => {
  const f = createPduFactory();
  const keepalive = (): Pdu =>
    f.build(
      [
        { proto: 'hdlc', fields: { address: HDLC_ADDRESS_BROADCAST, control: 0, protocol: HDLC_PROTO_KEEPALIVE } },
        { proto: 'payload', fields: { data: new Uint8Array([0, 0, 0, 1, 0, 0, 0, 0, 0xff, 0xff, 0, 0]) } },
      ],
      meta({ background: true }),
    );
  const beacon = (): Pdu =>
    f.build(
      [
        { proto: 'dot11', fields: { frameType: 'mgmt', subtype: 'beacon', addr1: 'ff:ff:ff:ff:ff:ff', addr2: '02:00:00:00:0a:01', addr3: '02:00:00:00:0a:01' } },
        { proto: 'dot11-mgmt', fields: { ssid: 'LAB', beaconIntervalMs: 100, capability: 0x0011, channel: 6, rates: '1,2,5.5,11', security: 'open', band: '2.4' } },
      ],
      meta(),
    );

  it('maps encapsulations to link types and FCS lengths', () => {
    const cases: [PortEncap | undefined, string, number][] = [
      ['ethernet', 'ethernet', 4],
      ['dot11', 'ieee802_11', 0],
      ['hdlc', 'c_hdlc', 0],
      ['ppp', 'c_hdlc', 0],
      ['none', 'raw', 0],
      [undefined, 'ethernet', 4],
    ];
    for (const [encap, linkType, fcsLen] of cases) expect(captureLinkForEncap(encap)).toEqual({ linkType, fcsLen });
    expect(CAPTURE_LIVE_FCS_LEN).toEqual({ ethernet: 4, ieee802_11: 0, c_hdlc: 0, raw: 0 });
  });

  it('strips the 802.11 FCS and the HDLC CRC; the rows still decode with fcsLen 0', () => {
    const hub = createCaptureHub();
    const ap: PortRef = { device: 'd_ap', port: 'Wl0' };
    const r1: PortRef = { device: 'd_r1', port: 'Se0/0/0' };
    const store = hub.start({ includeBackground: true }, [
      { ref: ap, name: 'AP Wl0', ...captureLinkForEncap('dot11') },
      { ref: r1, name: 'R1 Se0/0/0', ...captureLinkForEncap('hdlc') },
    ]);
    const b = beacon();
    const k = keepalive();
    hub.record({ t: 5, dir: 'tx', port: ap, pdu: b, linkType: 'ieee802_11' });
    hub.record({ t: 7, dir: 'rx', port: r1, pdu: k, linkType: 'c_hdlc' });
    const [x, y] = store.records();
    expect(x!.bytes).toEqual(b.bytes.slice(0, b.size - 4));
    expect(x!.origLen).toBe(b.size - 4);
    expect(y!.bytes).toEqual(k.bytes.slice(0, k.size - 2));
    const rows = store.query({ from: 0, limit: 10 }).rows;
    expect(rows.map((r) => [r.iface, r.layers[0], r.src, r.dst])).toEqual([
      [0, 'dot11', '02:00:00:00:0a:01', 'ff:ff:ff:ff:ff:ff'],
      [1, 'hdlc', '', ''],
    ]);
    const detail = store.record(0)!;
    expect(detail.layers[0]!.fields.fcsValid).toBeUndefined();
    expect(detail.layers.map((l) => l.proto)).toContain('dot11-mgmt');
    // pcapng keeps if_fcslen 0 for both interfaces.
    expect(readCapture(store.export({ format: 'pcapng' })).interfaces.map((i) => [i.linkType, i.fcsLen])).toEqual([['ieee802_11', 0], ['c_hdlc', 0]]);
  });

  it('a collision fragment keeps its leading bytes, the full frame length and a corruption mark', () => {
    const f2 = createPduFactory();
    const p = f2.build(udpFrame('02:00:00:00:00:01', 'fragment me'), meta());
    expect(captureBytesOf({ pdu: p, linkType: 'ethernet', fragmentBytes: 20 })).toEqual({ bytes: p.bytes.slice(0, 20), origLen: p.size });
    const hub = createCaptureHub();
    const port: PortRef = { device: 'd_pc2', port: 'Gi0' };
    const store = hub.start({}, [{ ref: port, name: 'PC2 Gi0', ...captureLinkForEncap('ethernet') }]);
    hub.record({ t: 1, dir: 'rx', port, pdu: p, linkType: 'ethernet', fragmentBytes: 20 });
    hub.record({ t: 2, dir: 'rx', port, pdu: p, linkType: 'ethernet', corrupted: true });
    const recs = store.records();
    expect(recs.map((r) => [r.bytes.length, r.origLen, r.corrupted])).toEqual([
      [20, p.size, true],
      [p.size, p.size, true],
    ]);
    expect(store.query({ filter: 'frame.corrupted == 1', from: 0, limit: 5 }).rows).toHaveLength(2);
  });

  it('a frame of another link type opens an extra interface for that point', () => {
    const hub = createCaptureHub();
    const port: PortRef = { device: 'd_r1', port: 'Gi0/0' };
    const store = hub.start({}, [{ ref: port, name: 'R1 Gi0/0', ...captureLinkForEncap('ethernet') }]);
    const ip = createPduFactory().build(udpFrame('02:00:00:00:00:01', 'raw').slice(1), meta());
    hub.record({ t: 1, dir: 'tx', port, pdu: ip, linkType: 'raw' });
    hub.record({ t: 2, dir: 'tx', port, pdu: ip, linkType: 'raw' });
    expect(store.info().interfaces).toEqual([
      { index: 0, ref: port, name: 'R1 Gi0/0', linkType: 'ethernet', fcsLen: 4 },
      { index: 1, ref: port, name: 'R1 Gi0/0 (raw)', linkType: 'raw', fcsLen: 0 },
    ]);
    expect(store.records().map((r) => r.iface)).toEqual([1, 1]);
    expect(store.query({ from: 0, limit: 5 }).rows[0]!.layers).toEqual(['ipv4', 'udp', 'payload']);
  });
});

describe('capture point resolution', () => {
  it('defaults to every port; otherwise ports ∪ link ends, each once, first occurrence order', () => {
    const w = world();
    expect(resolveCapturePoints({}, w.resolver).map((p) => p.name)).toEqual(['PC1 Gi0', 'SW1 Fa0/1']);
    expect(resolveCapturePoints({ ports: [w.sw], links: ['l_1'] }, w.resolver).map((p) => p.name)).toEqual(['SW1 Fa0/1', 'PC1 Gi0']);
    expect(resolveCapturePoints({ links: [] }, w.resolver)).toEqual([]);
    expect(() => resolveCapturePoints({ links: ['l_9'] }, w.resolver)).toThrow(/l_9/);
    expect(() => resolveCapturePoints({ ports: [{ device: 'd_x', port: 'Gi0' }] }, w.resolver)).toThrow(/Gi0/);
  });
});
