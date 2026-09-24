/**
 * W5 wireless (ARCHITECTURE-P2 §2.4 `udp.open` `tunnel`, §3.12 steps 7–8): UDP TUNNEL sockets.
 *
 * A datagram matched to a socket opened with `tunnel: true` is handed to its owner as `sock.datagram` WITHOUT udp's
 * `consume` action — the owner carries the same PduId on (or consumes or drops it itself). Everything else is the
 * ordinary socket layer: the same bind and conflict rules, the same `sockets` row, the same checksum and closed-port
 * handling, the same ICMP-error reporting. An ordinary socket is unchanged (consume, then the event).
 *
 * Unit level: the real udp daemon against a small fake ProcessCtx (real tables, real PDU factory and codecs). World
 * level (`p2.world`, test/capwap.harness.ts): the controller's and the AP's CAPWAP data sockets are tunnel sockets, so
 * tunnelled frames show no `pduConsumed` at either end of the tunnel, while control messages (ordinary sockets) do; a
 * datagram to the controller's tunnel port from a host that never joined is dropped by the OWNER, not consumed by udp.
 */
import { describe, expect, it } from 'vitest';
import { inSubnet, type Ipv4Address } from '../src/contracts/addr.js';
import type { PortId } from '../src/contracts/ids.js';
import { ICMP_DEST_UNREACHABLE, ICMP_UNREACH_PORT, IPPROTO_ICMP, IPPROTO_UDP, type LayerSpec, type Pdu } from '../src/contracts/pdu.js';
import type { Action, ProcessCtx, ProcessRequest } from '../src/contracts/process.js';
import { emptyCounters, type PortView } from '../src/contracts/port.js';
import { socketKey, type ArpRow, type CamRow, type DeviceTables, type RouteRow, type SocketRow, type Table, type TableName, type TableRow } from '../src/contracts/tables.js';
import { SEC } from '../src/contracts/time.js';
import type { TraceEvent } from '../src/contracts/trace.js';
import type { ProcessEvent } from '../src/contracts/transport.js';
import { createConfigAst } from '../src/cli/config-ast.js';
import { createRng } from '../src/core/prng.js';
import { createTable, lpm } from '../src/core/table.js';
import { defineModel } from '../src/device/catalog/define.js';
import { createPduFactory } from '../src/pdu/factory.js';
import { createUdp } from '../src/protocols/udp.js';
import { AP_ADDR, AP_GW, SETTLE, WLC_MGMT, capwapWorld, ofKind } from './capwap.harness.js';
import { NF_PC_INPUT } from './device.catalog.p0-inputs.js';
import { NO_IPV6_CTX, P2_CTX, testPortSpec } from './port.fixtures.js';

const OWN = '192.168.99.5';
const PEER = '192.168.99.20';

interface Harness {
  readonly ctx: ProcessCtx;
  readonly sockets: Table<SocketRow>;
  readonly trace: TraceEvent[];
  build(layers: readonly LayerSpec[]): Pdu;
}

/** One routed port Gi0 = 192.168.99.5/24, real tables and codecs. */
function harness(): Harness {
  const device = 'd_wlc';
  const now = 7_000_000;
  const trace: TraceEvent[] = [];
  const sink = { emit: (ev: TraceEvent) => void trace.push(ev) };
  const clock = (): number => now;
  const cam = createTable<CamRow>({ name: 'cam', device, sink, now: clock });
  const arp = createTable<ArpRow>({ name: 'arp', device, sink, now: clock });
  const rib = createTable<RouteRow>({ name: 'rib', device, sink, now: clock });
  const sockets = createTable<SocketRow>({ name: 'sockets', device, sink, now: clock });
  const byName: Record<string, Table<TableRow>> = {
    cam: cam as unknown as Table<TableRow>,
    arp: arp as unknown as Table<TableRow>,
    rib: rib as unknown as Table<TableRow>,
    sockets: sockets as unknown as Table<TableRow>,
  };
  const tables: DeviceTables = {
    cam, arp, rib,
    get: <R extends TableRow = TableRow>(name: TableName): Table<R> | undefined => byName[name] as unknown as Table<R> | undefined,
    names: () => ['cam', 'arp', 'rib', 'sockets'],
  };
  rib.set({ key: '192.168.99.0/24', network: '192.168.99.0', prefixLen: 24, source: 'C', iface: 'Gi0', ad: 0, metric: 0, updatedAt: now });
  const model = defineModel(NF_PC_INPUT, 'P0.5');
  const view: PortView = {
    id: 'Gi0',
    spec: testPortSpec({ name: 'Gi0', short: 'Gi0', kind: 'ethernet', speedBps: 1_000_000_000 }, model.capabilities, 1),
    mac: '02:00:00:00:99:05',
    adminUp: true,
    operUp: true,
    mtu: 1500,
    counters: emptyCounters(),
    l3: { ipv4: { address: OWN, prefixLen: 24 } },
    tx: { busyUntil: 0, queue: 0 },
    role: 'routed',
    ordinal: 1,
    encap: 'ethernet',
  };
  const ports = new Map<PortId, PortView>([['Gi0', view]]);
  const factory = createPduFactory();
  const rng = createRng(99).split('process:udp');
  const own = (ip: Ipv4Address): PortId | undefined => (ip === OWN ? 'Gi0' : undefined);
  const ctx: ProcessCtx = {
    ...P2_CTX,
    ...NO_IPV6_CTX,
    now,
    deviceId: device,
    hostname: 'WLC1',
    model,
    ports,
    tables,
    config: createConfigAst(),
    rng,
    stream: (label) => rng.split(label),
    debug(category, message, data) {
      trace.push({ t: now, kind: 'debug', event: data === undefined ? { at: now, device, process: 'udp', category, message } : { at: now, device, process: 'udp', category, message, data } });
    },
    newPdu: (layers, meta) => factory.build(layers, { born: now, origin: device, ...(meta ?? {}) }),
    mutate: (pdu, field, after, reason, cause) => pdu.mutate({ now, device }, field, after, reason, cause),
    encapsulate: (pdu, outer, cause) => pdu.encapsulate({ now, device }, outer, cause),
    rewrap: (pdu, op, cause) => pdu.rewrap({ now, device }, op, cause),
    hasCapability: (cap) => model.capabilities.includes(cap),
    clone: (pdu) => factory.clone(pdu, now),
    lpm: (dst) => lpm(rib, dst),
    ownAddress: own,
    isLocalDestination: (ip) => own(ip) !== undefined,
    connectedPortFor: (ip) => (inSubnet(ip, OWN, 24) ? 'Gi0' : undefined),
    sourceFor: (dst) => (inSubnet(dst, OWN, 24) ? { address: OWN, iface: 'Gi0' } : undefined),
    macOf: () => view.mac,
  };
  return { ctx, sockets, trace, build: (layers) => factory.build(layers, { born: now, origin: 'd_peer' }) };
}

/** A received datagram `[ethernet, ipv4, udp, payload]` from PEER:srcPort to `dst`:dstPort. */
function datagram(h: Harness, dstPort: number, opts: { dst?: string; srcPort?: number; payload?: Uint8Array } = {}): Pdu {
  return h.build([
    { proto: 'ethernet', fields: { dst: '02:00:00:00:99:05', src: '02:00:00:00:99:20', type: 0x0800 } },
    { proto: 'ipv4', fields: { src: PEER, dst: opts.dst ?? OWN, protocol: IPPROTO_UDP, ttl: 64 } },
    { proto: 'udp', fields: { srcPort: opts.srcPort ?? 40000, dstPort } },
    { proto: 'payload', fields: { data: opts.payload ?? Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8]) } },
  ]);
}

function events(actions: readonly Action[]): { to: string; ev: ProcessEvent }[] {
  return actions.filter((a): a is Extract<Action, { type: 'event' }> => a.type === 'event').map((a) => ({ to: a.to, ev: a.ev }));
}

function open(udp: ReturnType<typeof createUdp>, h: Harness, body: Omit<Extract<ProcessRequest, { kind: 'udp.open' }>, 'kind'>): Action[] {
  return udp.onRequest!(h.ctx, { kind: 'udp.open', ...body });
}

describe('udp tunnel sockets (§2.4)', () => {
  it('bind like any socket: same row, same conflict key; only the StateView and the debug line say "tunnel"', () => {
    const h = harness();
    const udp = createUdp();
    const out = open(udp, h, { owner: 'capwap-ac', socket: 'capwap-ac#data', family: 4, localPort: 5247, tunnel: true });
    expect(events(out)).toEqual([
      { to: 'capwap-ac', ev: { kind: 'sock.opened', socket: 'capwap-ac#data', proto: 'udp', family: 4, localAddr: '0.0.0.0', localPort: 5247 } },
    ]);
    expect(h.sockets.get(socketKey('udp', 'capwap-ac#data'))).toEqual({
      key: socketKey('udp', 'capwap-ac#data'), id: 'capwap-ac#data', proto: 'udp', family: 4, localAddr: '0.0.0.0', localPort: 5247, state: 'BOUND', owner: 'capwap-ac', updatedAt: 7_000_000,
    });
    open(udp, h, { owner: 'capwap-ac', socket: 'capwap-ac#ctl', family: 4, localPort: 5246 });
    const state = udp.stateSnapshot().state as { sockets: Record<string, unknown>[] };
    expect(state.sockets).toEqual([
      { id: 'capwap-ac#data', owner: 'capwap-ac', family: 4, localAddr: '0.0.0.0', localPort: 5247, tunnel: true },
      { id: 'capwap-ac#ctl', owner: 'capwap-ac', family: 4, localAddr: '0.0.0.0', localPort: 5246 },
    ]);
    const lines = h.trace.filter((e): e is Extract<TraceEvent, { kind: 'debug' }> => e.kind === 'debug').map((e) => e.event.message);
    expect(lines).toEqual([
      'socket capwap-ac#data bound to 0.0.0.0:5247 for capwap-ac as a tunnel socket',
      'socket capwap-ac#ctl bound to 0.0.0.0:5246 for capwap-ac',
    ]);
    // a second bind on the tunnel port conflicts exactly as for an ordinary socket
    const clash = open(udp, h, { owner: 'x', socket: 'x#1', family: 4, localPort: 5247 });
    expect(events(clash)[0]!.ev).toMatchObject({ kind: 'sock.error', socket: 'x#1', code: 'addr-in-use' });
  });

  it('hands a matched datagram to the owner WITHOUT consuming it; an ordinary socket still consumes', () => {
    const h = harness();
    const udp = createUdp();
    open(udp, h, { owner: 'capwap-ac', socket: 'capwap-ac#data', family: 4, localPort: 5247, tunnel: true });
    open(udp, h, { owner: 'capwap-ac', socket: 'capwap-ac#ctl', family: 4, localPort: 5246 });
    const tunnelled = datagram(h, 5247);
    const out = udp.onPdu(h.ctx, tunnelled, 'Gi0');
    expect(out.map((a) => a.type)).toEqual(['event']);
    const ev = events(out)[0]!;
    expect(ev.to).toBe('capwap-ac');
    expect(ev.ev).toMatchObject({ kind: 'sock.datagram', socket: 'capwap-ac#data', from: PEER, fromPort: 40000, to: OWN, iface: 'Gi0' });
    const d = ev.ev as Extract<ProcessEvent, { kind: 'sock.datagram' }>;
    expect(d.pdu).toBe(tunnelled);
    expect([...d.data]).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    // the ordinary control socket: consume first, then the event (unchanged)
    const control = datagram(h, 5246);
    const ordinary = udp.onPdu(h.ctx, control, 'Gi0');
    expect(ordinary.map((a) => a.type)).toEqual(['consume', 'event']);
    expect(ordinary[0]).toEqual({ type: 'consume', pdu: control });
    const lines = h.trace.filter((e): e is Extract<TraceEvent, { kind: 'debug' }> => e.kind === 'debug').map((e) => e.event.message);
    expect(lines.slice(-2)).toEqual([
      `receive ${PEER}:40000 > ${OWN}:5247 on Gi0: 8 bytes handed to tunnel socket capwap-ac#data`,
      `receive ${PEER}:40000 > ${OWN}:5246 on Gi0: 8 bytes to socket capwap-ac#ctl`,
    ]);
    expect((udp.stateSnapshot().state as { datagramsIn: number }).datagramsIn).toBe(2);
  });

  it('keeps every other receive rule: a bad checksum is dropped, a closed port answers port-unreachable, an ICMP error reports to the owner', () => {
    const h = harness();
    const udp = createUdp();
    open(udp, h, { owner: 'capwap-wtp', socket: 'capwap-wtp#data', family: 4, localPort: 5247, tunnel: true });
    const good = datagram(h, 5247);
    const flipped = good.bytes.slice();
    const u = good.layer('udp')!;
    flipped[u.offset + 6] = flipped[u.offset + 6]! ^ 0x01;
    const bad = createPduFactory().decode(flipped, { born: 0, origin: 'd_peer' }, 'ethernet');
    expect(bad.get('udp.checksumValid')).toBe(false);
    expect(udp.onPdu(h.ctx, bad, 'Gi0')).toEqual([{ type: 'drop', pdu: bad, reason: 'bad-checksum', detail: 'UDP checksum mismatch', port: 'Gi0' }]);
    const closed = udp.onPdu(h.ctx, datagram(h, 5999), 'Gi0');
    expect(closed.map((a) => a.type)).toEqual(['drop', 'request']);
    // an ICMP port-unreachable quoting a datagram the tunnel socket sent: sock.error to the owner, the error consumed
    const quoted = h.build([
      { proto: 'ipv4', fields: { src: OWN, dst: PEER, protocol: IPPROTO_UDP, ttl: 64 } },
      { proto: 'udp', fields: { srcPort: 5247, dstPort: 5247 } },
      { proto: 'payload', fields: { data: new Uint8Array(4) } },
    ]);
    const error = h.build([
      { proto: 'ipv4', fields: { src: PEER, dst: OWN, protocol: IPPROTO_ICMP, ttl: 64 } },
      { proto: 'icmpv4', fields: { type: ICMP_DEST_UNREACHABLE, code: ICMP_UNREACH_PORT, unused: 0 } },
      { proto: 'payload', fields: { data: quoted.bytes.slice(0, 28) } },
    ]);
    expect(error.layers.map((l) => l.proto)).toEqual(['ipv4', 'icmpv4', 'ipv4', 'udp']);
    const out = udp.onPdu(h.ctx, error, 'Gi0');
    expect(out.map((a) => a.type)).toEqual(['consume', 'event']);
    expect(events(out)[0]!.ev).toMatchObject({ kind: 'sock.error', socket: 'capwap-wtp#data', code: 'port-unreachable', from: PEER });
  });
});

describe('udp tunnel sockets in a controller world (§3.12 steps 7–8)', () => {
  it('tunnelled frames show no pduConsumed at either end of the tunnel; control messages are consumed by udp', () => {
    const sim = capwapWorld({ ap: 'static' });
    sim.runFor(SETTLE);
    const cursor = sim.trace(0).next;
    const session = sim.cli.open('lt1', 'console');
    sim.cli.exec(session, 'ping 192.168.20.1');
    sim.runFor(15 * SEC);
    const evs = sim.trace(cursor).events;
    const consumed = ofKind(evs, 'pduConsumed');
    // no data frame is consumed by udp on the AP or the controller; the laptop's and R1's own daemons consume them
    const tunnelled = new Set(ofKind(evs, 'frameTx').filter((e) => e.from.device === 'lap1' && e.from.port === 'GigabitEthernet0' && e.pdu.proto !== 'capwap').map((e) => e.pdu.id));
    expect(tunnelled.size).toBeGreaterThan(0);
    expect(consumed.filter((e) => tunnelled.has(e.pdu.id) && e.process === 'udp')).toEqual([]);
    expect(consumed.filter((e) => tunnelled.has(e.pdu.id)).map((e) => e.device).every((d) => d === 'r1')).toBe(true);
    // the echoes (control channel, ordinary sockets) are consumed by udp on both sides
    const echoes = consumed.filter((e) => e.process === 'udp' && (e.pdu.tag === 'capwap-echo' || e.pdu.tag === 'capwap-echo-resp'));
    expect(echoes.map((e) => [e.device, e.pdu.tag])).toEqual([
      ['wlc1', 'capwap-echo'],
      ['lap1', 'capwap-echo-resp'],
    ]);
  });

  it('a datagram to the tunnel port from a host that never joined is dropped by the owner, not consumed by udp', () => {
    const sim = capwapWorld({ ap: 'static', laptop: false });
    sim.runFor(SETTLE);
    const r1 = sim.device('r1')!;
    const cursor = sim.trace(0).next;
    r1.applyActions('dns-client', [
      { type: 'request', to: 'udp', req: { kind: 'udp.open', owner: 'dns-client', socket: 'probe#1', family: 4, localPort: 40001 } },
      { type: 'request', to: 'udp', req: { kind: 'udp.send', socket: 'probe#1', dst: WLC_MGMT, dstPort: 5247, src: AP_GW, data: new Uint8Array(8) } },
    ], sim.now);
    sim.runFor(2 * SEC);
    const evs = sim.trace(cursor).events;
    const probe = ofKind(evs, 'pduCreated').find((e) => e.device === 'r1' && e.process === 'udp')!;
    expect(ofKind(evs, 'pduConsumed').filter((e) => e.pdu.id === probe.pdu.id)).toEqual([]);
    expect(ofKind(evs, 'drop').filter((e) => e.pdu.id === probe.pdu.id).map((e) => [e.device, e.reason, e.detail])).toEqual([
      ['wlc1', 'other', `no access point has joined from ${AP_GW}`],
    ]);
    // the AP that did join is untouched
    expect(sim.device('wlc1')!.tables.get('capwap-aps')!.rows()).toEqual([expect.objectContaining({ apIp: AP_ADDR, state: 'run' })]);
  });
});
