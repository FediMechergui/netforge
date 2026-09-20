/**
 * Test harness for the protocols-l3 daemons: a fake `ProcessCtx` backed by the REAL
 * table implementation (collecting trace sink), the REAL pdu factory and the REAL
 * config AST. Ports carry MACs and optional IPv4 addresses and can be flipped up/down.
 * The model is a catalog v2 model (`defineModel` of the P0 inputs), so daemons read
 * capabilities, port roles and `ipDefaults` exactly as on a real device.
 */
import { createRng } from '../src/core/prng.js';
import { createTable, lpm } from '../src/core/table.js';
import { createPduFactory } from '../src/pdu/factory.js';
import { createConfigAst } from '../src/cli/config-ast.js';
import { defineModel } from '../src/device/catalog/define.js';
import { inSubnet } from '../src/contracts/addr.js';
import type { Ipv4Address, MacAddress } from '../src/contracts/addr.js';
import { KIND_ENCAP, defaultRoleFor } from '../src/contracts/catalog.js';
import type { PortEncap, PortRole } from '../src/contracts/catalog.js';
import type { DeviceKind, DeviceModel } from '../src/contracts/device.js';
import type { PortId } from '../src/contracts/ids.js';
import type { PortPhy } from '../src/contracts/link.js';
import { emptyCounters } from '../src/contracts/port.js';
import type { PortKind, PortState, PortView } from '../src/contracts/port.js';
import { ARP_OP_REPLY, ARP_OP_REQUEST, ETHERTYPE_ARP, ETHERTYPE_IPV4, IPPROTO_ICMP } from '../src/contracts/pdu.js';
import type { LayerSpec, Pdu, PduMeta, ProtoName } from '../src/contracts/pdu.js';
import type { Action, ProcessCtx } from '../src/contracts/process.js';
import type { Rng } from '../src/contracts/rng.js';
import type { ArpRow, CamRow, DeviceTables, LpmResult, RouteRow } from '../src/contracts/tables.js';
import type { SimTime } from '../src/contracts/time.js';
import type { TraceEvent } from '../src/contracts/trace.js';
import { NO_IPV6_CTX, testPortSpec, p0Tables } from './port.fixtures.js';
import { NF_2911_INPUT, NF_C2960_INPUT, NF_PC_INPUT } from './device.catalog.p0-inputs.js';

export interface FakePortSpec {
  id: PortId;
  mac: MacAddress;
  address?: Ipv4Address;
  prefixLen?: number;
  operUp?: boolean;
  /** Port kind (default 'ethernet'). */
  kind?: PortKind;
  /** Effective role (default: `defaultRoleFor(kind, model.capabilities)`). */
  role?: PortRole;
  /** Effective encapsulation (default `KIND_ENCAP[kind]`). */
  encap?: PortEncap;
  /** Link-owned physical detail (serial carrier / line protocol). */
  phy?: PortPhy;
}

export interface FakeDebug {
  at: SimTime;
  category: string;
  message: string;
  data?: Record<string, unknown>;
}

export interface Harness {
  ctx: ProcessCtx;
  model: DeviceModel;
  events: TraceEvent[];
  debug: FakeDebug[];
  tables: DeviceTables;
  ports: Map<PortId, PortState>;
  setNow(t: SimTime): void;
  /** Build a frame/packet "from the wire" or from another daemon (fresh id, stamped now). */
  build(layers: readonly LayerSpec[], meta?: Partial<PduMeta>): Pdu;
  /** Decode raw bytes as a frame whose outer layer is `outer` (default ethernet) to check what was sent. */
  decode(bytes: Uint8Array, outer?: ProtoName): Pdu;
}

export interface HarnessOptions {
  deviceId?: string;
  kind?: DeviceKind;
  /** Use this model instead of the P0 model of `kind`. */
  model?: DeviceModel;
  ports: FakePortSpec[];
}

/** The catalog v2 P0 model for a device kind: router → NF-2911, switch → NF-C2960, anything else → NF-PC. */
export function modelForKind(kind: DeviceKind): DeviceModel {
  const input = kind === 'router' ? NF_2911_INPUT : kind === 'switch' ? NF_C2960_INPUT : NF_PC_INPUT;
  return defineModel(input, 'P0.5');
}

function makePort(p: FakePortSpec, index: number, model: DeviceModel): PortState {
  const l3 = p.address !== undefined ? { ipv4: { address: p.address, prefixLen: p.prefixLen ?? 24 } } : {};
  const kind = p.kind ?? 'ethernet';
  const state: PortState = {
    id: p.id,
    spec: testPortSpec({ name: p.id, short: p.id, kind, speedBps: kind === 'serial' ? 2_000_000 : 1_000_000_000 }, model.capabilities, index + 1),
    mac: p.mac,
    adminUp: true,
    operUp: p.operUp ?? true,
    mtu: 1500,
    counters: emptyCounters(),
    l3,
    tx: { busyUntil: 0, queue: 0 },
    role: p.role ?? defaultRoleFor(kind, model.capabilities),
    ordinal: index + 1,
    encap: p.encap ?? KIND_ENCAP[kind],
  };
  if (p.phy !== undefined) state.phy = p.phy;
  return state;
}

/** Build a fake device context for one daemon. */
export function makeHarness(opts: HarnessOptions): Harness {
  const deviceId = opts.deviceId ?? 'd_test';
  const kind = opts.kind ?? 'pc';
  const events: TraceEvent[] = [];
  const debug: FakeDebug[] = [];
  let now: SimTime = 0;
  const sink = { emit: (ev: TraceEvent) => { events.push(ev); } };
  const clock = () => now;
  const tables: DeviceTables = p0Tables({
    cam: createTable<CamRow>({ name: 'cam', device: deviceId, sink, now: clock }),
    arp: createTable<ArpRow>({ name: 'arp', device: deviceId, sink, now: clock }),
    rib: createTable<RouteRow>({ name: 'rib', device: deviceId, sink, now: clock }),
  });
  const model = opts.model ?? modelForKind(kind);
  const ports = new Map<PortId, PortState>();
  opts.ports.forEach((p, i) => ports.set(p.id, makePort(p, i, model)));
  const factory = createPduFactory();
  const config = createConfigAst();
  const rng = createRng(7);
  const streams = new Map<string, Rng>();

  const ownAddress = (ip: Ipv4Address): PortId | undefined => {
    for (const p of ports.values()) if (p.l3.ipv4?.address === ip) return p.id;
    return undefined;
  };
  const connectedPortFor = (ip: Ipv4Address): PortId | undefined => {
    for (const p of ports.values()) {
      const v4 = p.l3.ipv4;
      if (v4 && inSubnet(ip, v4.address, v4.prefixLen)) return p.id;
    }
    return undefined;
  };
  const doLpm = (dst: Ipv4Address): LpmResult => lpm(tables.rib, dst);

  const ctx: ProcessCtx = {
    ...NO_IPV6_CTX,
    get now() { return now; },
    deviceId,
    hostname: 'TEST',
    model,
    ports: ports as ReadonlyMap<PortId, PortView>,
    tables,
    config,
    rng,
    stream(label) {
      let s = streams.get(label);
      if (s === undefined) {
        s = rng.split(label);
        streams.set(label, s);
      }
      return s;
    },
    debug(category, message, data) {
      debug.push(data ? { at: now, category, message, data } : { at: now, category, message });
    },
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
    hasCapability(cap) {
      return (model.capabilities ?? []).includes(cap);
    },
    clone(pdu) {
      return factory.clone(pdu, now);
    },
    lpm: doLpm,
    ownAddress,
    isLocalDestination(ip) {
      return ownAddress(ip) !== undefined || ip === '255.255.255.255';
    },
    connectedPortFor,
    sourceFor(dst) {
      let iface = connectedPortFor(dst);
      if (iface === undefined) {
        const w = doLpm(dst).winner;
        if (w?.nextHop !== undefined) iface = connectedPortFor(w.nextHop);
        else if (w?.iface !== undefined) iface = w.iface;
      }
      if (iface === undefined) return undefined;
      const address = ports.get(iface)?.l3.ipv4?.address;
      return address === undefined ? undefined : { address, iface };
    },
    macOf(port) {
      const p = ports.get(port);
      if (!p) throw new Error(`unknown port ${port}`);
      return p.mac;
    },
  };

  return {
    ctx,
    model,
    events,
    debug,
    tables,
    ports,
    setNow: (t) => { now = t; },
    build: (layers, meta) => factory.build(layers, { born: now, origin: 'd_peer', ...(meta ?? {}) }),
    decode: (bytes, outer) => factory.decode(bytes, { born: now, origin: 'wire' }, outer ?? 'ethernet'),
  };
}

/** An ARP request/reply frame as a peer would send it. */
export function arpFrame(h: Harness, f: { op: 'request' | 'reply'; sha: MacAddress; spa: Ipv4Address; tha: MacAddress; tpa: Ipv4Address; dst?: MacAddress }): Pdu {
  const dst = f.dst ?? (f.op === 'request' ? 'ff:ff:ff:ff:ff:ff' : f.tha);
  return h.build([
    { proto: 'ethernet', fields: { dst, src: f.sha, type: ETHERTYPE_ARP } },
    { proto: 'arp', fields: { op: f.op === 'request' ? ARP_OP_REQUEST : ARP_OP_REPLY, sha: f.sha, spa: f.spa, tha: f.tha, tpa: f.tpa } },
  ]);
}

/** A locally-originated echo request (no ethernet layer yet), as icmpv4 would build it. */
export function echoPacket(h: Harness, src: Ipv4Address, dst: Ipv4Address, seq = 1): Pdu {
  return h.build([
    { proto: 'ipv4', fields: { src, dst, protocol: IPPROTO_ICMP, ttl: 128 } },
    { proto: 'icmpv4', fields: { type: 8, code: 0, id: 1, seq } },
    { proto: 'payload', fields: { data: new Uint8Array(32) } },
  ], { tag: `ping#${seq}` });
}

/** A forwarded echo request that already carries an ethernet header (router path). */
export function forwardedFrame(h: Harness, src: Ipv4Address, dst: Ipv4Address, srcMac: MacAddress, dstMac: MacAddress): Pdu {
  return h.build([
    { proto: 'ethernet', fields: { dst: dstMac, src: srcMac, type: ETHERTYPE_IPV4 } },
    { proto: 'ipv4', fields: { src, dst, protocol: IPPROTO_ICMP, ttl: 127 } },
    { proto: 'icmpv4', fields: { type: 8, code: 0, id: 1, seq: 1 } },
    { proto: 'payload', fields: { data: new Uint8Array(32) } },
  ]);
}

export const sends = (actions: Action[]) => actions.filter((a): a is Extract<Action, { type: 'send' }> => a.type === 'send');
export const drops = (actions: Action[]) => actions.filter((a): a is Extract<Action, { type: 'drop' }> => a.type === 'drop');
export const timers = (actions: Action[]) => actions.filter((a): a is Extract<Action, { type: 'timer' }> => a.type === 'timer');
export const cancels = (actions: Action[]) => actions.filter((a): a is Extract<Action, { type: 'cancelTimer' }> => a.type === 'cancelTimer');
export const consumes = (actions: Action[]) => actions.filter((a): a is Extract<Action, { type: 'consume' }> => a.type === 'consume');
export const mediums = (actions: Action[]) => actions.filter((a): a is Extract<Action, { type: 'medium' }> => a.type === 'medium');
