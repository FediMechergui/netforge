/**
 * l4.udp.test.ts — the UDP daemon and socket layer (protocols/udp.ts; ARCHITECTURE-P1 §4.2, §5.1, §12 item 7;
 * contracts/transport.ts; RFC 768, RFC 1122 §4.1.3, RFC 8200 §8.1).
 *
 * Runs the daemon against a fake ProcessCtx with real tables, the real PDU factory (so every datagram is encoded
 * and re-decoded by the real codecs) and the real RFC 6724-lite source selection.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { inSubnet, type IpAddress, type Ipv4Address } from '../src/contracts/addr.js';
import type { PortId } from '../src/contracts/ids.js';
import type { LayerSpec, Pdu, PduMeta } from '../src/contracts/pdu.js';
import type { Action, ProcessCtx, ProcessRequest } from '../src/contracts/process.js';
import { emptyCounters, type Ipv6PortAddress, type PortL3, type PortView } from '../src/contracts/port.js';
import type { Rng } from '../src/contracts/rng.js';
import {
  socketKey,
  type ArpRow,
  type CamRow,
  type DeviceTables,
  type Route6Row,
  type RouteRow,
  type SocketRow,
  type Table,
  type TableName,
  type TableRow,
} from '../src/contracts/tables.js';
import type { ProcessEvent } from '../src/contracts/transport.js';
import { EPHEMERAL_PORT_MAX, EPHEMERAL_PORT_MIN } from '../src/contracts/transport.js';
import type { TraceEvent } from '../src/contracts/trace.js';
import { createConfigAst } from '../src/cli/config-ast.js';
import { inSubnet6 } from '../src/core/addr6.js';
import { createRng } from '../src/core/prng.js';
import { createTable, lpm } from '../src/core/table.js';
import { defineModel } from '../src/device/catalog/define.js';
import { selectSource6 } from '../src/device/process-ctx.js';
import { createPduFactory } from '../src/pdu/factory.js';
import {
  createUdp,
  matchUdpSocket,
  nextEphemeralPort,
  udpBindsConflict,
  udpErrorCodeFor,
  type UdpSocket,
} from '../src/protocols/udp.js';
import { NF_PC_INPUT } from './device.catalog.p0-inputs.js';
import { testPortSpec } from './port.fixtures.js';

const SEED = 4242;
const LL = 'fe80::1';
const G6 = '2001:db8:1::10';
const PEER6 = '2001:db8:1::99';

interface Harness {
  ctx: ProcessCtx;
  sockets: Table<SocketRow>;
  trace: TraceEvent[];
  build(layers: readonly LayerSpec[], meta?: Partial<PduMeta>): Pdu;
  setPortL3(port: PortId, l3: PortL3): void;
}

function v6(address: string, prefixLen: number, scope: Ipv6PortAddress['scope']): Ipv6PortAddress {
  return { address, prefixLen, scope, origin: scope === 'link-local' ? 'auto-link-local' : 'manual', state: 'preferred' };
}

/** PC with Gi0 = 192.168.1.10/24 + fe80::1 + 2001:db8:1::10/64 and Gi1 = 10.0.0.1/24 (no IPv6). */
function makeHarness(): Harness {
  const deviceId = 'd_pc';
  const now = 5_000_000;
  const trace: TraceEvent[] = [];
  const sink = { emit: (ev: TraceEvent) => void trace.push(ev) };
  const clock = (): number => now;
  const cam = createTable<CamRow>({ name: 'cam', device: deviceId, sink, now: clock });
  const arp = createTable<ArpRow>({ name: 'arp', device: deviceId, sink, now: clock });
  const rib = createTable<RouteRow>({ name: 'rib', device: deviceId, sink, now: clock });
  const rib6 = createTable<Route6Row>({ name: 'rib6', device: deviceId, sink, now: clock });
  const sockets = createTable<SocketRow>({ name: 'sockets', device: deviceId, sink, now: clock });
  const extra: Record<string, Table<TableRow>> = {
    cam: cam as unknown as Table<TableRow>,
    arp: arp as unknown as Table<TableRow>,
    rib: rib as unknown as Table<TableRow>,
    rib6: rib6 as unknown as Table<TableRow>,
    sockets: sockets as unknown as Table<TableRow>,
  };
  const tables: DeviceTables = {
    cam,
    arp,
    rib,
    get: <R extends TableRow = TableRow>(name: TableName): Table<R> | undefined => extra[name] as unknown as Table<R> | undefined,
    names: () => ['cam', 'arp', 'rib', 'rib6', 'sockets'],
  };
  rib.set({ key: '192.168.1.0/24', network: '192.168.1.0', prefixLen: 24, source: 'C', iface: 'Gi0', ad: 0, metric: 0, updatedAt: now });
  rib.set({ key: '10.0.0.0/24', network: '10.0.0.0', prefixLen: 24, source: 'C', iface: 'Gi1', ad: 0, metric: 0, updatedAt: now });
  rib6.set({ key: '2001:db8:1::/64', network: '2001:db8:1::', prefixLen: 64, source: 'C', iface: 'Gi0', ad: 0, metric: 0, updatedAt: now });

  const model = defineModel(NF_PC_INPUT, 'P0.5');
  const l3 = new Map<PortId, PortL3>([
    ['Gi0', { ipv4: { address: '192.168.1.10', prefixLen: 24 }, ipv6: [v6(LL, 64, 'link-local'), v6(G6, 64, 'global')], ipv6Enabled: true }],
    ['Gi1', { ipv4: { address: '10.0.0.1', prefixLen: 24 } }],
  ]);
  const views = (): ReadonlyMap<PortId, PortView> => {
    const m = new Map<PortId, PortView>();
    let ordinal = 0;
    for (const [id, portL3] of l3) {
      ordinal++;
      m.set(id, {
        id,
        spec: testPortSpec({ name: id, short: id, kind: 'ethernet', speedBps: 1_000_000_000 }, model.capabilities, ordinal),
        mac: `02:00:00:00:00:0${ordinal}`,
        adminUp: true,
        operUp: true,
        mtu: 1500,
        counters: emptyCounters(),
        l3: portL3,
        tx: { busyUntil: 0, queue: 0 },
        role: 'routed',
        ordinal,
        encap: 'ethernet',
      });
    }
    return m;
  };
  const ownAddress = (ip: Ipv4Address): PortId | undefined => {
    for (const [id, p] of l3) if (p.ipv4?.address === ip) return id;
    return undefined;
  };
  const connectedPortFor = (ip: Ipv4Address): PortId | undefined => {
    for (const [id, p] of l3) if (p.ipv4 && inSubnet(ip, p.ipv4.address, p.ipv4.prefixLen)) return id;
    return undefined;
  };
  const factory = createPduFactory();
  const rng: Rng = createRng(SEED).split('process:udp');
  const streams = new Map<string, Rng>();
  const ctx: ProcessCtx = {
    get now() {
      return now;
    },
    deviceId,
    hostname: 'PC1',
    model,
    get ports() {
      return views();
    },
    tables,
    config: createConfigAst(),
    rng,
    stream(label) {
      let s = streams.get(label);
      if (!s) {
        s = rng.split(label);
        streams.set(label, s);
      }
      return s;
    },
    debug() {},
    newPdu(layers, meta) {
      return factory.build(layers, { born: now, origin: deviceId, ...(meta ?? {}) });
    },
    mutate(pdu, field, after, reason, cause) {
      pdu.mutate({ now, device: deviceId }, field, after, reason, cause);
    },
    encapsulate(pdu, outer, cause) {
      pdu.encapsulate({ now, device: deviceId }, outer, cause);
    },
    rewrap(pdu, op, cause) {
      pdu.rewrap({ now, device: deviceId }, op, cause);
    },
    hasCapability: (cap) => model.capabilities.includes(cap),
    clone: (pdu) => factory.clone(pdu, now),
    lpm: (dst) => lpm(rib, dst),
    ownAddress,
    isLocalDestination: (ip) => ownAddress(ip) !== undefined || ip === '255.255.255.255',
    connectedPortFor,
    sourceFor(dst) {
      const w = lpm(rib, dst).winner;
      const iface = w?.iface ?? (w?.nextHop !== undefined ? connectedPortFor(w.nextHop) : undefined);
      const a = iface !== undefined ? l3.get(iface)?.ipv4 : undefined;
      return iface !== undefined && a ? { address: a.address, iface } : undefined;
    },
    macOf: (port) => views().get(port)?.mac ?? '00:00:00:00:00:00',
    lpm6(dst) {
      const candidates = rib6.rows().filter((r) => inSubnet6(dst, r.network, r.prefixLen));
      return candidates[0] ? { winner: candidates[0], candidates } : { candidates };
    },
    ownAddress6(ip) {
      for (const [id, p] of l3) if ((p.ipv6 ?? []).some((a) => a.address === ip)) return id;
      return undefined;
    },
    isLocalDestination6(ip, inPort) {
      for (const [id, p] of l3) {
        if (inPort !== undefined && id !== inPort) continue;
        if ((p.ipv6 ?? []).some((a) => a.address === ip && a.state === 'preferred')) return true;
        if ((p.groups6 ?? []).includes(ip)) return true;
      }
      return false;
    },
    connectedPortFor6(ip, hint) {
      for (const [id, p] of l3) {
        if (hint !== undefined && id !== hint) continue;
        if ((p.ipv6 ?? []).some((a) => inSubnet6(ip, a.address, a.prefixLen))) return id;
      }
      return undefined;
    },
    sourceFor6(dst, iface) {
      let egress = iface;
      if (egress === undefined) {
        const w = rib6.rows().find((r) => inSubnet6(dst, r.network, r.prefixLen));
        egress = w?.iface;
      }
      if (egress === undefined) return undefined;
      const sel = selectSource6(l3.get(egress)?.ipv6 ?? [], dst);
      return sel ? { address: sel.address, iface: egress } : undefined;
    },
  };
  return {
    ctx,
    sockets,
    trace,
    build: (layers, meta) => factory.build(layers, { born: now, origin: 'd_peer', ...(meta ?? {}) }),
    setPortL3: (port, value) => void l3.set(port, value),
  };
}

type Req<K extends ProcessRequest['kind']> = Omit<Extract<ProcessRequest, { kind: K }>, 'kind'>;

function events(actions: readonly Action[]): { to: string; ev: ProcessEvent }[] {
  return actions.filter((a): a is Extract<Action, { type: 'event' }> => a.type === 'event').map((a) => ({ to: a.to, ev: a.ev }));
}

function requests(actions: readonly Action[]): { to: string; req: ProcessRequest }[] {
  return actions.filter((a): a is Extract<Action, { type: 'request' }> => a.type === 'request').map((a) => ({ to: a.to, req: a.req }));
}

/** The PDU of the single ipv4.send / ipv6.send request in `actions`. */
function sentPdu(actions: readonly Action[]): Pdu {
  const r = requests(actions);
  expect(r).toHaveLength(1);
  const req = r[0]!.req;
  if (req.kind !== 'ipv4.send' && req.kind !== 'ipv6.send') throw new Error(`unexpected request ${req.kind}`);
  return req.pdu;
}

/** Independent RFC 768 ones'-complement check over the IPv4 pseudo-header + UDP datagram (0 when valid). */
function rfc768Residual(src: string, dst: string, udp: Uint8Array): number {
  const bytes: number[] = [];
  for (const a of [src, dst]) for (const o of a.split('.')) bytes.push(Number(o));
  bytes.push(0, 17, udp.length >> 8, udp.length & 0xff, ...udp);
  if (bytes.length % 2) bytes.push(0);
  let sum = 0;
  for (let i = 0; i < bytes.length; i += 2) sum += (bytes[i]! << 8) | bytes[i + 1]!;
  while (sum > 0xffff) sum = (sum & 0xffff) + (sum >>> 16);
  return ~sum & 0xffff;
}

let h: Harness;
let udp: ReturnType<typeof createUdp>;

function req<K extends ProcessRequest['kind']>(kind: K, body: Req<K>): Action[] {
  return udp.onRequest!(h.ctx, { kind, ...body } as unknown as ProcessRequest);
}

beforeEach(() => {
  h = makeHarness();
  udp = createUdp();
});

describe('udp.open', () => {
  it('binds a socket, writes a BOUND sockets row and answers sock.opened to the owner', () => {
    const out = req('udp.open', { owner: 'dns-server', socket: 'dns-server#53', family: 4, localPort: 53 });
    expect(events(out)).toEqual([
      { to: 'dns-server', ev: { kind: 'sock.opened', socket: 'dns-server#53', proto: 'udp', family: 4, localAddr: '0.0.0.0', localPort: 53 } },
    ]);
    const row = h.sockets.get(socketKey('udp', 'dns-server#53'));
    expect(row).toMatchObject({ id: 'dns-server#53', proto: 'udp', family: 4, localAddr: '0.0.0.0', localPort: 53, state: 'BOUND', owner: 'dns-server' });
    expect(row?.iface).toBeUndefined();
    expect(h.trace.some((e) => e.kind === 'tableWrite')).toBe(true);
  });

  it('refuses a duplicate socket id with addr-in-use and leaves the first socket alone', () => {
    req('udp.open', { owner: 'a', socket: 'a#1', family: 4, localPort: 5000 });
    const out = req('udp.open', { owner: 'a', socket: 'a#1', family: 4, localPort: 5001 });
    expect(events(out)[0]!.ev).toMatchObject({ kind: 'sock.error', socket: 'a#1', code: 'addr-in-use' });
    expect(h.sockets.get(socketKey('udp', 'a#1'))?.localPort).toBe(5000);
  });

  it('applies the conflict key (family, addr, port, iface): different ifaces and families coexist', () => {
    const ok = (socket: string, extra: Partial<Req<'udp.open'>>): string =>
      String((events(req('udp.open', { owner: 'dhcp-client', socket, family: 4, localPort: 68, ...extra }))[0]!.ev as { kind: string }).kind);
    expect(ok('dhcp-client#Gi0', { localAddr: '0.0.0.0', iface: 'Gi0' })).toBe('sock.opened');
    expect(ok('dhcp-client#Gi1', { localAddr: '0.0.0.0', iface: 'Gi1' })).toBe('sock.opened');
    // unrestricted wildcard on the same port overlaps both
    expect(ok('x#1', {})).toBe('sock.error');
    // specific address on the same port overlaps the wildcard binds of the same iface
    expect(ok('x#2', { localAddr: '192.168.1.10', iface: 'Gi0' })).toBe('sock.error');
    // IPv6 on the same port is another family
    expect(String((events(req('udp.open', { owner: 's', socket: 's#v6', family: 6, localPort: 68 }))[0]!.ev as { kind: string }).kind)).toBe('sock.opened');
  });

  it('specific addresses: two different own addresses coexist; a foreign address is refused', () => {
    expect(events(req('udp.open', { owner: 's', socket: 's#1', family: 4, localAddr: '192.168.1.10', localPort: 9000 }))[0]!.ev.kind).toBe('sock.opened');
    expect(events(req('udp.open', { owner: 's', socket: 's#2', family: 4, localAddr: '10.0.0.1', localPort: 9000 }))[0]!.ev.kind).toBe('sock.opened');
    const bad = events(req('udp.open', { owner: 's', socket: 's#3', family: 4, localAddr: '172.16.0.1', localPort: 9000 }))[0]!.ev;
    expect(bad).toMatchObject({ kind: 'sock.error', code: 'no-address' });
    const v6 = events(req('udp.open', { owner: 's', socket: 's#4', family: 6, localAddr: '2001:DB8:1:0::10', localPort: 9000 }))[0]!.ev;
    expect(v6).toMatchObject({ kind: 'sock.opened', localAddr: G6 });
    const wrongFamily = events(req('udp.open', { owner: 's', socket: 's#5', family: 6, localAddr: '10.0.0.1', localPort: 9000 }))[0]!.ev;
    expect(wrongFamily).toMatchObject({ kind: 'sock.error', code: 'bad-socket' });
  });

  it('rejects out-of-range ports and unknown interfaces', () => {
    expect(events(req('udp.open', { owner: 's', socket: 's#1', family: 4, localPort: 70000 }))[0]!.ev).toMatchObject({ code: 'bad-socket' });
    expect(events(req('udp.open', { owner: 's', socket: 's#2', family: 4, localPort: 53, iface: 'Gi9' }))[0]!.ev).toMatchObject({ code: 'bad-socket' });
  });
});

describe('ephemeral ports', () => {
  it('draw 49152 + nextInt(0, 16383) once from the process stream, then go sequentially', () => {
    const twin = createRng(SEED).split('process:udp');
    const base = EPHEMERAL_PORT_MIN + twin.nextInt(0, 16383);
    const before = h.ctx.rng.state();
    const a = events(req('udp.open', { owner: 'dns-client', socket: 'dns-client#q1', family: 4 }))[0]!.ev;
    const afterFirst = h.ctx.rng.state();
    expect(afterFirst).not.toEqual(before);
    expect(a).toMatchObject({ kind: 'sock.opened', localPort: base });
    const b = events(req('udp.open', { owner: 'dns-client', socket: 'dns-client#q2', family: 4, localPort: 0 }))[0]!.ev;
    const c = events(req('udp.open', { owner: 'traceroute', socket: 'traceroute#s1', family: 6 }))[0]!.ev;
    expect(b).toMatchObject({ localPort: base === EPHEMERAL_PORT_MAX ? EPHEMERAL_PORT_MIN : base + 1 });
    expect((c as { localPort: number }).localPort).toBe(nextEphemeralPort(base + 2 > EPHEMERAL_PORT_MAX ? base + 2 - 16384 : base + 2, () => true));
    // only the first ephemeral bind drew
    expect(h.ctx.rng.state()).toEqual(afterFirst);
    expect(udp.stateSnapshot().state.ephemeralNext).toBeTypeOf('number');
  });

  it('never touches the stream when every bind names its port (silence of the rng)', () => {
    const before = h.ctx.rng.state();
    req('udp.open', { owner: 'dns-server', socket: 'dns-server#53', family: 4, localPort: 53 });
    expect(h.ctx.rng.state()).toEqual(before);
    expect(udp.stateSnapshot().state.ephemeralNext).toBeNull();
  });

  it('skips ports in use and wraps from 65535 to 49152', () => {
    expect(nextEphemeralPort(65534, (p) => p !== 65534)).toBe(65535);
    expect(nextEphemeralPort(65535, (p) => p !== 65535)).toBe(49152);
    expect(nextEphemeralPort(50000, (p) => p > 50002)).toBe(50003);
    expect(nextEphemeralPort(50000, () => false)).toBeUndefined();
  });

  it('skips a port bound explicitly by another socket', () => {
    const twin = createRng(SEED).split('process:udp');
    const base = EPHEMERAL_PORT_MIN + twin.nextInt(0, 16383);
    req('udp.open', { owner: 'x', socket: 'x#1', family: 4, localPort: base });
    const ev = events(req('udp.open', { owner: 'y', socket: 'y#1', family: 4 }))[0]!.ev;
    expect(ev).toMatchObject({ kind: 'sock.opened', localPort: base === EPHEMERAL_PORT_MAX ? EPHEMERAL_PORT_MIN : base + 1 });
  });
});

describe('udp.send', () => {
  it('builds [ipv4, udp, payload] with the selected source, host TTL and a valid RFC 768 checksum', () => {
    req('udp.open', { owner: 'app', socket: 'app#1', family: 4, localPort: 4000 });
    const data = new Uint8Array([1, 2, 3, 4, 5]);
    const out = req('udp.send', { socket: 'app#1', dst: '192.168.1.20', dstPort: 7, data, tag: 'probe', triggeredBy: 77 });
    expect(requests(out)[0]!.to).toBe('ipv4');
    const r = requests(out)[0]!.req as Extract<ProcessRequest, { kind: 'ipv4.send' }>;
    expect(r.iface).toBeUndefined();
    const pdu = r.pdu;
    expect(pdu.layers.map((l) => l.proto)).toEqual(['ipv4', 'udp', 'payload']);
    expect(pdu.get('ipv4.src')).toBe('192.168.1.10');
    expect(pdu.get('ipv4.dst')).toBe('192.168.1.20');
    expect(pdu.get('ipv4.protocol')).toBe(17);
    expect(pdu.get('ipv4.ttl')).toBe(128);
    expect(pdu.get('udp.srcPort')).toBe(4000);
    expect(pdu.get('udp.dstPort')).toBe(7);
    expect(pdu.get('udp.length')).toBe(13);
    expect(pdu.get('udp.checksumValid')).toBe(true);
    const u = pdu.layer('udp')!;
    expect(rfc768Residual('192.168.1.10', '192.168.1.20', pdu.bytes.slice(u.offset, u.offset + u.length))).toBe(0);
    expect(pdu.meta).toMatchObject({ tag: 'probe', triggeredBy: 77, flow: 'ipv4:192.168.1.10:4000>192.168.1.20:7:udp' });
  });

  it('encodes app layers (DHCP broadcast from 0.0.0.0 out the socket iface)', () => {
    req('udp.open', { owner: 'dhcp-client', socket: 'dhcp-client#Gi0', family: 4, localAddr: '0.0.0.0', localPort: 68, iface: 'Gi0' });
    const out = req('udp.send', {
      socket: 'dhcp-client#Gi0',
      src: '0.0.0.0',
      dst: '255.255.255.255',
      dstPort: 67,
      tag: 'dhcp-discover',
      app: [{ proto: 'dhcp', fields: { op: 1, xid: 0x1234, chaddr: '02:00:00:00:00:01', messageType: 'DISCOVER', broadcastFlag: true } }],
    });
    const r = requests(out)[0]!.req as Extract<ProcessRequest, { kind: 'ipv4.send' }>;
    expect(r.iface).toBe('Gi0');
    expect(r.pdu.layers.map((l) => l.proto)).toEqual(['ipv4', 'udp', 'dhcp']);
    expect(r.pdu.get('ipv4.src')).toBe('0.0.0.0');
    expect(r.pdu.get('udp.srcPort')).toBe(68);
    expect(r.pdu.get('udp.dstPort')).toBe(67);
    expect(r.pdu.get('udp.checksumValid')).toBe(true);
    expect(r.pdu.get('dhcp.xid')).toBe(0x1234);
  });

  it('uses the iface address and honours ttl and cause (traceroute-style probe)', () => {
    req('udp.open', { owner: 'traceroute', socket: 'traceroute#s1', family: 4, localPort: 50000 });
    const out = req('udp.send', { socket: 'traceroute#s1', dst: '10.0.0.9', dstPort: 33434, ttl: 1, iface: 'Gi1', cause: 'traceroute 10.0.0.9', data: new Uint8Array(12) });
    const r = requests(out)[0]!.req as Extract<ProcessRequest, { kind: 'ipv4.send' }>;
    expect(r).toMatchObject({ iface: 'Gi1', cause: 'traceroute 10.0.0.9' });
    expect(r.pdu.get('ipv4.src')).toBe('10.0.0.1');
    expect(r.pdu.get('ipv4.ttl')).toBe(1);
  });

  it('sends IPv6 through ipv6.send with the RFC 6724-lite source and host hop limit', () => {
    req('udp.open', { owner: 'app', socket: 'app#6', family: 6, localPort: 4000 });
    const pdu = sentPdu(req('udp.send', { socket: 'app#6', dst: '2001:DB8:1::99', dstPort: 9999, data: new Uint8Array([9]) }));
    expect(pdu.layers.map((l) => l.proto)).toEqual(['ipv6', 'udp', 'payload']);
    expect(pdu.get('ipv6.src')).toBe(G6);
    expect(pdu.get('ipv6.dst')).toBe(PEER6);
    expect(pdu.get('ipv6.nextHeader')).toBe(17);
    expect(pdu.get('ipv6.hopLimit')).toBe(64);
    expect(pdu.get('udp.checksumValid')).toBe(true);
    expect(pdu.meta.flow).toBe(`ipv6:[${G6}]:4000>[${PEER6}]:9999:udp`);
    // link-local destination on an iface → link-local source
    const ll = requests(req('udp.send', { socket: 'app#6', dst: 'fe80::2', dstPort: 53, iface: 'Gi0', data: new Uint8Array([1]) }))[0]!;
    expect(ll.to).toBe('ipv6');
    expect(ll.req).toMatchObject({ kind: 'ipv6.send', iface: 'Gi0' });
    expect((ll.req as Extract<ProcessRequest, { kind: 'ipv6.send' }>).pdu.get('ipv6.src')).toBe(LL);
  });

  it('reports send-time failures as sock.error and keeps the socket open', () => {
    req('udp.open', { owner: 'app', socket: 'app#1', family: 4, localPort: 4000 });
    const noRoute = req('udp.send', { socket: 'app#1', dst: '8.8.8.8', dstPort: 53, data: new Uint8Array(1) });
    expect(requests(noRoute)).toHaveLength(0);
    expect(events(noRoute)[0]).toEqual({ to: 'app', ev: expect.objectContaining({ kind: 'sock.error', socket: 'app#1', code: 'no-route' }) });
    const bcast = req('udp.send', { socket: 'app#1', dst: '255.255.255.255', dstPort: 53, data: new Uint8Array(1) });
    expect(events(bcast)[0]!.ev).toMatchObject({ code: 'no-route' });
    const family = req('udp.send', { socket: 'app#1', dst: '2001:db8::1', dstPort: 53, data: new Uint8Array(1) });
    expect(events(family)[0]!.ev).toMatchObject({ code: 'bad-socket' });
    h.setPortL3('Gi1', {});
    const noAddr = req('udp.send', { socket: 'app#1', dst: '10.0.0.9', dstPort: 53, iface: 'Gi1', data: new Uint8Array(1) });
    expect(events(noAddr)[0]!.ev).toMatchObject({ code: 'no-address' });
    req('udp.open', { owner: 'app', socket: 'app#6', family: 6, localPort: 4001 });
    const llNoIface = req('udp.send', { socket: 'app#6', dst: 'ff02::1', dstPort: 53, data: new Uint8Array(1) });
    expect(events(llNoIface)[0]!.ev).toMatchObject({ code: 'no-route' });
    expect(h.sockets.get(socketKey('udp', 'app#1'))).toBeDefined();
    expect(events(req('udp.send', { socket: 'app#1', dst: '192.168.1.20', dstPort: 53, data: new Uint8Array(1) }))).toHaveLength(0);
  });

  it('a send on an unknown socket produces nothing', () => {
    expect(req('udp.send', { socket: 'nobody#1', dst: '192.168.1.20', dstPort: 53, data: new Uint8Array(1) })).toEqual([]);
  });
});

/** A datagram as a peer would send it to us. */
function datagram4(src: string, dst: string, srcPort: number, dstPort: number, data = new Uint8Array([0xaa, 0xbb])): Pdu {
  return h.build([
    { proto: 'ethernet', fields: { dst: '02:00:00:00:00:01', src: '02:00:00:00:00:99', type: 0x0800 } },
    { proto: 'ipv4', fields: { src, dst, protocol: 17, ttl: 64 } },
    { proto: 'udp', fields: { srcPort, dstPort } },
    { proto: 'payload', fields: { data } },
  ]);
}

function datagram6(src: string, dst: string, srcPort: number, dstPort: number, data = new Uint8Array([0xcc])): Pdu {
  return h.build([
    { proto: 'ipv6', fields: { src, dst, nextHeader: 17, hopLimit: 64 } },
    { proto: 'udp', fields: { srcPort, dstPort } },
    { proto: 'payload', fields: { data } },
  ]);
}

describe('receive', () => {
  it('consumes a matched datagram and hands sock.datagram (payload bytes, endpoints, iface, pdu) to the owner', () => {
    req('udp.open', { owner: 'dns-server', socket: 'dns-server#53', family: 4, localPort: 53 });
    const pdu = datagram4('192.168.1.20', '192.168.1.10', 49999, 53, new Uint8Array([1, 2, 3]));
    const out = udp.onPdu(h.ctx, pdu, 'Gi0');
    expect(out[0]).toEqual({ type: 'consume', pdu });
    const ev = events(out);
    expect(ev).toHaveLength(1);
    expect(ev[0]!.to).toBe('dns-server');
    expect(ev[0]!.ev).toMatchObject({ kind: 'sock.datagram', socket: 'dns-server#53', from: '192.168.1.20', fromPort: 49999, to: '192.168.1.10', iface: 'Gi0' });
    const d = ev[0]!.ev as Extract<ProcessEvent, { kind: 'sock.datagram' }>;
    expect(Array.from(d.data)).toEqual([1, 2, 3]);
    expect(d.pdu).toBe(pdu);
  });

  it('matches exact addr + iface, then exact addr, then wildcard + iface, then wildcard', () => {
    req('udp.open', { owner: 'w', socket: 'w#any', family: 4, localPort: 7000 });
    const ev = events(udp.onPdu(h.ctx, datagram4('192.168.1.20', '192.168.1.10', 1111, 7000), 'Gi0'))[0]!.ev as { socket: string };
    expect(ev.socket).toBe('w#any');
    // conflict rules forbid overlapping binds on one device, so the order is checked with the pure matcher
    const socks: UdpSocket[] = [
      { id: 'wild', owner: 'o', family: 4, localAddr: '0.0.0.0', localPort: 7000 },
      { id: 'wild-if', owner: 'o', family: 4, localAddr: '0.0.0.0', localPort: 7000, iface: 'Gi0' },
      { id: 'exact', owner: 'o', family: 4, localAddr: '192.168.1.10', localPort: 7000 },
      { id: 'exact-if', owner: 'o', family: 4, localAddr: '192.168.1.10', localPort: 7000, iface: 'Gi0' },
    ];
    const pick = (list: UdpSocket[], dst: string, port: PortId): string | undefined => matchUdpSocket(list, 4, dst, 7000, port)?.id;
    expect(pick(socks, '192.168.1.10', 'Gi0')).toBe('exact-if');
    expect(pick(socks.slice(0, 3), '192.168.1.10', 'Gi0')).toBe('exact');
    expect(pick(socks.slice(0, 2), '192.168.1.10', 'Gi0')).toBe('wild-if');
    expect(pick(socks.slice(0, 1), '192.168.1.10', 'Gi0')).toBe('wild');
    // iface restriction: arriving on Gi1 skips the Gi0-bound sockets
    expect(pick(socks, '192.168.1.10', 'Gi1')).toBe('exact');
    expect(pick(socks.slice(0, 2), '255.255.255.255', 'Gi1')).toBe('wild');
    // a specific address never receives another destination
    expect(pick(socks.slice(2), '255.255.255.255', 'Gi1')).toBeUndefined();
    // wrong family / port
    expect(matchUdpSocket(socks, 6, '::', 7000, 'Gi0')).toBeUndefined();
    expect(matchUdpSocket(socks, 4, '192.168.1.10', 7001, 'Gi0')).toBeUndefined();
  });

  it('an iface-restricted socket only hears its own port (DHCP clients on two interfaces)', () => {
    req('udp.open', { owner: 'dhcp-client', socket: 'dhcp-client#Gi0', family: 4, localAddr: '0.0.0.0', localPort: 68, iface: 'Gi0' });
    req('udp.open', { owner: 'dhcp-client', socket: 'dhcp-client#Gi1', family: 4, localAddr: '0.0.0.0', localPort: 68, iface: 'Gi1' });
    const on1 = events(udp.onPdu(h.ctx, datagram4('10.0.0.254', '255.255.255.255', 67, 68), 'Gi1'))[0]!.ev as { socket: string };
    expect(on1.socket).toBe('dhcp-client#Gi1');
    const on0 = events(udp.onPdu(h.ctx, datagram4('192.168.1.1', '255.255.255.255', 67, 68), 'Gi0'))[0]!.ev as { socket: string };
    expect(on0.socket).toBe('dhcp-client#Gi0');
  });

  it('a closed port on a unicast destination drops unsupported-protocol and asks icmpv4 for 3/3', () => {
    const pdu = datagram4('192.168.1.20', '192.168.1.10', 1234, 33434);
    const out = udp.onPdu(h.ctx, pdu, 'Gi0');
    expect(out).toEqual([
      { type: 'drop', pdu, reason: 'unsupported-protocol', detail: 'udp port 33434 closed', port: 'Gi0' },
      { type: 'request', to: 'icmpv4', req: { kind: 'icmp.error', original: pdu, type: 3, code: 3, inPort: 'Gi0' } },
    ]);
    expect(udp.stateSnapshot().state.noPort).toBe(1);
  });

  it('a closed port on IPv6 unicast asks icmpv6 for 1/4', () => {
    const pdu = datagram6(PEER6, G6, 1234, 33434);
    const out = udp.onPdu(h.ctx, pdu, 'Gi0');
    expect(out).toEqual([
      { type: 'drop', pdu, reason: 'unsupported-protocol', detail: 'udp port 33434 closed', port: 'Gi0' },
      { type: 'request', to: 'icmpv6', req: { kind: 'icmp6.error', original: pdu, type: 1, code: 4, inPort: 'Gi0' } },
    ]);
  });

  it('never answers a closed port on broadcast, directed broadcast or multicast (RFC 1122 §4.1.3.1)', () => {
    for (const dst of ['255.255.255.255', '192.168.1.255', '224.0.0.9']) {
      const out = udp.onPdu(h.ctx, datagram4('192.168.1.20', dst, 67, 68), 'Gi0');
      expect(out).toHaveLength(1);
      expect(out[0]).toMatchObject({ type: 'drop', reason: 'unsupported-protocol', detail: 'udp port 68 closed' });
    }
    const out6 = udp.onPdu(h.ctx, datagram6(PEER6, 'ff02::1:2', 546, 547), 'Gi0');
    expect(out6).toHaveLength(1);
    expect(out6[0]).toMatchObject({ type: 'drop', reason: 'unsupported-protocol' });
  });

  it('drops a checksum mismatch as bad-checksum; an IPv4 zero checksum means none, an IPv6 zero checksum is invalid', () => {
    req('udp.open', { owner: 'dns-server', socket: 'dns-server#53', family: 4, localPort: 53 });
    req('udp.open', { owner: 'dns-server', socket: 'dns-server#53v6', family: 6, localPort: 53 });
    const good = datagram4('192.168.1.20', '192.168.1.10', 1000, 53);
    const u = good.layer('udp')!;
    const flipped = good.bytes.slice();
    flipped[u.offset + 6] = flipped[u.offset + 6]! ^ 0x01;
    const factory = createPduFactory();
    const meta: PduMeta = { born: 0, origin: 'd_peer' };
    const corrupt = factory.decode(flipped, meta, 'ethernet');
    expect(corrupt.get('udp.checksumValid')).toBe(false);
    expect(udp.onPdu(h.ctx, corrupt, 'Gi0')).toEqual([{ type: 'drop', pdu: corrupt, reason: 'bad-checksum', detail: 'UDP checksum mismatch', port: 'Gi0' }]);

    const zero4 = good.bytes.slice();
    zero4[u.offset + 6] = 0;
    zero4[u.offset + 7] = 0;
    const none = factory.decode(zero4, meta, 'ethernet');
    expect(none.get('udp.checksumValid')).toBeUndefined();
    expect(events(udp.onPdu(h.ctx, none, 'Gi0'))[0]!.ev.kind).toBe('sock.datagram');

    const g6 = datagram6(PEER6, G6, 1000, 53);
    const u6 = g6.layer('udp')!;
    const zero6 = g6.bytes.slice();
    zero6[u6.offset + 6] = 0;
    zero6[u6.offset + 7] = 0;
    const invalid6 = factory.decode(zero6, meta, 'ipv6');
    expect(invalid6.get('udp.checksumValid')).toBe(false);
    expect(udp.onPdu(h.ctx, invalid6, 'Gi0')[0]).toMatchObject({ type: 'drop', reason: 'bad-checksum' });
    expect(udp.stateSnapshot().state.checksumErrors).toBe(2);
  });

  it('drops a truncated datagram as other', () => {
    const good = datagram6(PEER6, G6, 1000, 53, new Uint8Array(20));
    const bytes = good.bytes.slice(0, good.bytes.length - 10);
    const truncated = createPduFactory().decode(bytes, { born: 0, origin: 'd_peer' }, 'ipv6');
    const out = udp.onPdu(h.ctx, truncated, 'Gi0');
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ type: 'drop', reason: 'other' });
  });
});

describe('ICMP errors quoting UDP (socket stays open, §12 item 7)', () => {
  function probe(ttl: number, dstPort: number): Pdu {
    return sentPdu(req('udp.send', { socket: 'traceroute#s1', dst: '10.0.0.9', dstPort, ttl, data: new Uint8Array(12) }));
  }

  /** ICMPv4 error from `from` quoting the IPv4 header + 8 bytes of `original` (RFC 792). */
  function icmp4Error(from: string, type: number, code: number, original: Pdu): Pdu {
    const ip = original.layer('ipv4')!;
    const quote = original.bytes.slice(ip.offset, ip.offset + ip.headerLength + 8);
    return h.build([
      { proto: 'ipv4', fields: { src: from, dst: String(ip.fields.src), protocol: 1, ttl: 255 } },
      { proto: 'icmpv4', fields: { type, code, unused: 0 } },
      { proto: 'payload', fields: { data: quote } },
    ]);
  }

  beforeEach(() => {
    req('udp.open', { owner: 'traceroute', socket: 'traceroute#s1', family: 4, localPort: 50001 });
  });

  it('time exceeded → sock.error ttl-exceeded with from, quotedDstPort and quotedTtl; later probes still go out', () => {
    const p1 = probe(1, 33434);
    const err = icmp4Error('10.0.0.254', 11, 0, p1);
    expect(err.layers.map((l) => l.proto)).toEqual(['ipv4', 'icmpv4', 'ipv4', 'udp']);
    const out = udp.onPdu(h.ctx, err, 'Gi1');
    expect(out[0]).toEqual({ type: 'consume', pdu: err });
    const ev = events(out);
    expect(ev).toHaveLength(1);
    expect(ev[0]!.to).toBe('traceroute');
    expect(ev[0]!.ev).toMatchObject({
      kind: 'sock.error',
      socket: 'traceroute#s1',
      code: 'ttl-exceeded',
      from: '10.0.0.254',
      icmp: { type: 11, code: 0, quotedDstPort: 33434, quotedTtl: 1, pdu: err },
    });
    // the socket was not closed: no sock.closed, row still present, next probe is sent
    expect(ev.some((e) => e.ev.kind === 'sock.closed')).toBe(false);
    expect(h.sockets.get(socketKey('udp', 'traceroute#s1'))).toBeDefined();
    const p2 = probe(2, 33437);
    expect(p2.get('ipv4.ttl')).toBe(2);
    expect(udp.stateSnapshot().state.icmpErrors).toBe(1);
  });

  it('port unreachable from the target → sock.error port-unreachable (destination reached)', () => {
    const p = probe(3, 33440);
    const ev = events(udp.onPdu(h.ctx, icmp4Error('10.0.0.9', 3, 3, p), 'Gi1'))[0]!.ev;
    expect(ev).toMatchObject({ kind: 'sock.error', code: 'port-unreachable', from: '10.0.0.9', icmp: { type: 3, code: 3, quotedDstPort: 33440 } });
    expect(h.sockets.get(socketKey('udp', 'traceroute#s1'))).toBeDefined();
  });

  it('maps unreachable codes (RFC 792 / RFC 4443) to socket error codes', () => {
    expect(udpErrorCodeFor(4, 3, 0)).toBe('net-unreachable');
    expect(udpErrorCodeFor(4, 3, 1)).toBe('host-unreachable');
    expect(udpErrorCodeFor(4, 3, 2)).toBe('proto-unreachable');
    expect(udpErrorCodeFor(4, 3, 3)).toBe('port-unreachable');
    expect(udpErrorCodeFor(4, 3, 13)).toBe('host-unreachable');
    expect(udpErrorCodeFor(4, 11, 1)).toBe('ttl-exceeded');
    expect(udpErrorCodeFor(4, 5, 0)).toBeUndefined();
    expect(udpErrorCodeFor(6, 1, 0)).toBe('net-unreachable');
    expect(udpErrorCodeFor(6, 1, 3)).toBe('host-unreachable');
    expect(udpErrorCodeFor(6, 1, 4)).toBe('port-unreachable');
    expect(udpErrorCodeFor(6, 3, 0)).toBe('ttl-exceeded');
    expect(udpErrorCodeFor(6, 4, 1)).toBe('proto-unreachable');
    expect(udpErrorCodeFor(6, 2, 0)).toBeUndefined();
    const p = probe(4, 33443);
    expect(events(udp.onPdu(h.ctx, icmp4Error('10.0.0.254', 3, 13, p), 'Gi1'))[0]!.ev).toMatchObject({ code: 'host-unreachable', icmp: { type: 3, code: 13 } });
  });

  it('an error for a port with no socket is consumed silently', () => {
    const p = probe(1, 33434);
    udp.onRequest!(h.ctx, { kind: 'udp.close', socket: 'traceroute#s1' });
    const err = icmp4Error('10.0.0.254', 11, 0, p);
    expect(udp.onPdu(h.ctx, err, 'Gi1')).toEqual([{ type: 'consume', pdu: err }]);
  });

  it('ICMPv6 time exceeded and port unreachable quoting a UDP datagram reach the socket', () => {
    req('udp.open', { owner: 'traceroute', socket: 'traceroute#v6', family: 6, localPort: 50002 });
    const p = sentPdu(req('udp.send', { socket: 'traceroute#v6', dst: PEER6, dstPort: 33434, ttl: 1, data: new Uint8Array(12) }));
    const build6 = (from: string, type: number, code: number): Pdu =>
      h.build([
        { proto: 'ipv6', fields: { src: from, dst: G6, nextHeader: 58, hopLimit: 64 } },
        { proto: 'icmpv6', fields: { type, code, unused: 0 } },
        { proto: 'payload', fields: { data: p.bytes.slice() } },
      ]);
    const te = build6('2001:db8:1::1', 3, 0);
    expect(te.layers.map((l) => l.proto)).toEqual(['ipv6', 'icmpv6', 'ipv6', 'udp', 'payload']);
    expect(events(udp.onPdu(h.ctx, te, 'Gi0'))[0]).toEqual({
      to: 'traceroute',
      ev: {
        kind: 'sock.error',
        socket: 'traceroute#v6',
        code: 'ttl-exceeded',
        detail: 'time to live exceeded in transit reported by 2001:db8:1::1',
        from: '2001:db8:1::1',
        icmp: { type: 3, code: 0, quotedDstPort: 33434, quotedTtl: 1, pdu: te },
      },
    });
    const pu = build6(PEER6, 1, 4);
    expect(events(udp.onPdu(h.ctx, pu, 'Gi0'))[0]!.ev).toMatchObject({ code: 'port-unreachable', from: PEER6 });
    expect(h.sockets.get(socketKey('udp', 'traceroute#v6'))).toBeDefined();
  });

  it('an ICMP error that quotes something other than UDP is consumed without an event', () => {
    const echo = h.build([
      { proto: 'ipv4', fields: { src: '10.0.0.1', dst: '10.0.0.9', protocol: 1, ttl: 1 } },
      { proto: 'icmpv4', fields: { type: 8, code: 0, id: 1, seq: 1 } },
    ]);
    const err = icmp4Error('10.0.0.254', 11, 0, echo);
    expect(udp.onPdu(h.ctx, err, 'Gi1')).toEqual([{ type: 'consume', pdu: err }]);
  });
});

describe('udp.close', () => {
  it('removes the socket and its row, answers sock.closed, and the port is closed afterwards', () => {
    req('udp.open', { owner: 'dns-server', socket: 'dns-server#53', family: 4, localPort: 53 });
    const out = req('udp.close', { socket: 'dns-server#53' });
    expect(events(out)).toEqual([{ to: 'dns-server', ev: { kind: 'sock.closed', socket: 'dns-server#53' } }]);
    expect(h.sockets.get(socketKey('udp', 'dns-server#53'))).toBeUndefined();
    expect(h.trace.some((e) => e.kind === 'tableExpire')).toBe(true);
    expect(req('udp.send', { socket: 'dns-server#53', dst: '192.168.1.20', dstPort: 53, data: new Uint8Array(1) })).toEqual([]);
    const pdu = datagram4('192.168.1.20', '192.168.1.10', 1000, 53);
    expect(udp.onPdu(h.ctx, pdu, 'Gi0')[0]).toMatchObject({ type: 'drop', detail: 'udp port 53 closed' });
    // the id may be reused after sock.closed
    expect(events(req('udp.open', { owner: 'dns-server', socket: 'dns-server#53', family: 4, localPort: 53 }))[0]!.ev.kind).toBe('sock.opened');
    expect(req('udp.close', { socket: 'nobody#1' })).toEqual([]);
  });
});

describe('silence and state', () => {
  it('init and config changes emit nothing; the snapshot lists sockets in bind order', () => {
    expect(udp.init!(h.ctx)).toEqual([]);
    expect(udp.onConfig(h.ctx, { op: 'set', context: [], line: ['ip', 'dns', 'server'] } as never)).toEqual([]);
    expect(udp.onTimer(h.ctx, 'anything')).toEqual([]);
    req('udp.open', { owner: 'b', socket: 'b#1', family: 4, localPort: 2000 });
    req('udp.open', { owner: 'a', socket: 'a#1', family: 6, localPort: 1000, iface: 'Gi0' });
    const state = udp.stateSnapshot();
    expect(state.process).toBe('udp');
    expect(state.state.sockets).toEqual([
      { id: 'b#1', owner: 'b', family: 4, localAddr: '0.0.0.0', localPort: 2000 },
      { id: 'a#1', owner: 'a', family: 6, localAddr: '::', localPort: 1000, iface: 'Gi0' },
    ]);
    expect(h.sockets.rows().map((r) => r.key)).toEqual(['udp|b#1', 'udp|a#1']);
    expect(structuredClone(state)).toEqual(state);
  });

  it('two daemons fed the same requests produce identical datagrams (determinism)', () => {
    const run = (): Uint8Array[] => {
      h = makeHarness();
      udp = createUdp();
      const out: Uint8Array[] = [];
      for (let i = 0; i < 3; i++) {
        req('udp.open', { owner: 'dns-client', socket: `dns-client#q${i}`, family: 4 });
        out.push(sentPdu(req('udp.send', { socket: `dns-client#q${i}`, dst: '192.168.1.53', dstPort: 53, data: new Uint8Array([i]) })).bytes.slice());
      }
      return out;
    };
    expect(run()).toEqual(run());
  });

  it('binds conflict per the transport contract', () => {
    const base = { family: 4 as const, localAddr: '0.0.0.0' as IpAddress, localPort: 68 };
    expect(udpBindsConflict({ ...base, iface: 'Gi0' }, { ...base, iface: 'Gi1' })).toBe(false);
    expect(udpBindsConflict({ ...base, iface: 'Gi0' }, base)).toBe(true);
    expect(udpBindsConflict({ ...base, localAddr: '10.0.0.1' }, { ...base, localAddr: '192.168.1.10' })).toBe(false);
    expect(udpBindsConflict({ ...base, localAddr: '10.0.0.1' }, base)).toBe(true);
    expect(udpBindsConflict(base, { ...base, family: 6, localAddr: '::' })).toBe(false);
    expect(udpBindsConflict(base, { ...base, localPort: 67 })).toBe(false);
  });
});
