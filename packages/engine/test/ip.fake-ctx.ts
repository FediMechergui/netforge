/**
 * Test helper for the ipv4 / icmpv4 / host daemons: a fake `ProcessCtx` over real tables,
 * a real PDU factory and the real LPM, plus a tiny action router that applies
 * `setPortL3` (per-member merge, like the runtime), forwards `deliver`/`request`/`event`
 * between registered processes and collects everything else. Not a test file (no `.test.ts` suffix).
 */
import { broadcastOf, inSubnet, type Ipv4Address, type MacAddress } from '../src/contracts/addr.js';
import { KIND_ENCAP, defaultRoleFor } from '../src/contracts/catalog.js';
import type { PortEncap, PortRole } from '../src/contracts/catalog.js';
import type { PortId } from '../src/contracts/ids.js';
import type { BuildStage } from '../src/contracts/catalog.js';
import type { DeviceKind, DeviceModel } from '../src/contracts/device.js';
import type { FieldValue, LayerSpec, MutationReason, Pdu, PduMeta } from '../src/contracts/pdu.js';
import type { Action, DebugEvent, Process, ProcessCtx, ProcessRequest } from '../src/contracts/process.js';
import type { PortKind, PortL3, PortView } from '../src/contracts/port.js';
import { emptyCounters } from '../src/contracts/port.js';
import type { ArpRow, CamRow, DeviceTables, RouteRow } from '../src/contracts/tables.js';
import type { TraceEvent } from '../src/contracts/trace.js';
import { createConfigAst } from '../src/cli/config-ast.js';
import type { Rng } from '../src/contracts/rng.js';
import { createRng } from '../src/core/prng.js';
import { createTable, lpm } from '../src/core/table.js';
import { defineModel } from '../src/device/catalog/define.js';
import { createPduFactory } from '../src/pdu/factory.js';
import { NF_2911_INPUT, NF_PC_INPUT } from './device.catalog.p0-inputs.js';
import { NO_IPV6_CTX, testPortSpec, p0Tables } from './port.fixtures.js';

/** Port description for `makeFake`. */
export interface FakePortSpec {
  id: PortId;
  mac: MacAddress;
  operUp?: boolean;
  ipv4?: { address: Ipv4Address; prefixLen: number };
  /** Port kind (default 'ethernet'). */
  kind?: PortKind;
  /** Effective role (default: `defaultRoleFor(kind, model.capabilities)`); mutable through `setRole`. */
  role?: PortRole;
  /** Effective encapsulation (default `KIND_ENCAP[kind]`). */
  encap?: PortEncap;
}

/** Mutable port record kept by the fake (the fields processes read). */
interface FakePort {
  id: PortId;
  mac: MacAddress;
  adminUp: boolean;
  operUp: boolean;
  l3: PortL3;
  kind: PortKind;
  role: PortRole;
  ordinal: number;
  encap: PortEncap;
}

export interface FakeOptions {
  kind: DeviceKind;
  ports: FakePortSpec[];
  deviceId?: string;
  now?: number;
  /** Catalog build stage of the model (default 'P0.5'; 'P1' adds udp, tcp, dhcp-client, … to the processes). */
  stage?: BuildStage;
}

/** What the fake collects while processes run. */
export interface Fake {
  ctx: ProcessCtx;
  tables: DeviceTables;
  trace: TraceEvent[];
  debug: DebugEvent[];
  mutations: { pdu: number; field: string; after: FieldValue; reason: MutationReason; cause?: string }[];
  /** Every action that reached the router (in application order, including routed ones). */
  actions: Action[];
  /** Advance the fake clock. */
  setNow(t: number): void;
  /** Set / clear a port's oper state. */
  setOper(port: PortId, up: boolean): void;
  /** Change a port's effective role (what `switchport` / `no switchport` does in the runtime). */
  setRole(port: PortId, role: PortRole): void;
  /** Register a process so `deliver`/`request` actions are routed to it. */
  register(p: Process): void;
  /** Apply actions: setPortL3 to the fake ports, deliver/request to registered processes; collect the rest. */
  run(actions: Action[]): Action[];
  /** Build a PDU directly (as a peer device would have). */
  build(layers: readonly LayerSpec[], meta?: Partial<PduMeta>): Pdu;
  /** Concatenated `cliOutput` text for a session from `actions`. */
  cliText(session: string): string;
  actionsOf<T extends Action['type']>(type: T): Extract<Action, { type: T }>[];
}

/** Catalog v2 model of a kind (router → NF-2911, anything else → NF-PC) at `stage`: capabilities, ipDefaults, processes. */
function modelFor(kind: DeviceKind, stage: BuildStage = 'P0.5'): DeviceModel {
  return defineModel(kind === 'router' ? NF_2911_INPUT : NF_PC_INPUT, stage);
}

/** Create a fake device context. */
export function makeFake(opts: FakeOptions): Fake {
  const deviceId = opts.deviceId ?? 'd_fake';
  let now = opts.now ?? 1_000_000;
  const trace: TraceEvent[] = [];
  const debug: DebugEvent[] = [];
  const mutations: Fake['mutations'] = [];
  const collected: Action[] = [];
  const processes = new Map<string, Process>();
  const sink = { emit: (ev: TraceEvent) => void trace.push(ev) };
  const clock = () => now;
  const tables: DeviceTables = p0Tables({
    cam: createTable<CamRow>({ name: 'cam', device: deviceId, sink, now: clock }),
    arp: createTable<ArpRow>({ name: 'arp', device: deviceId, sink, now: clock }),
    rib: createTable<RouteRow>({ name: 'rib', device: deviceId, sink, now: clock }),
  });
  const factory = createPduFactory();
  const model = modelFor(opts.kind, opts.stage);
  const ports = new Map<PortId, FakePort>();
  opts.ports.forEach((p, i) => {
    const kind = p.kind ?? 'ethernet';
    ports.set(p.id, {
      id: p.id,
      mac: p.mac,
      adminUp: true,
      operUp: p.operUp ?? true,
      l3: p.ipv4 ? { ipv4: { ...p.ipv4 } } : {},
      kind,
      role: p.role ?? defaultRoleFor(kind, model.capabilities ?? []),
      ordinal: i + 1,
      encap: p.encap ?? KIND_ENCAP[kind],
    });
  });
  const config = createConfigAst();
  const rng = createRng(7);
  /** Cached child streams (ProcessCtx.stream): created once per label, like device/process-ctx.ts. */
  const streams = new Map<string, Rng>();

  const views = (): ReadonlyMap<PortId, PortView> => {
    const m = new Map<PortId, PortView>();
    for (const p of ports.values()) {
      m.set(p.id, {
        id: p.id,
        spec: testPortSpec({ name: p.id, short: p.id, kind: p.kind, speedBps: p.kind === 'serial' ? 2_000_000 : 1_000_000_000, role: p.role, encap: p.encap }, [], p.ordinal),
        mac: p.mac,
        adminUp: p.adminUp,
        operUp: p.operUp,
        mtu: 1500,
        counters: emptyCounters(),
        l3: p.l3,
        tx: { busyUntil: 0, queue: 0 },
        role: p.role,
        ordinal: p.ordinal,
        encap: p.encap,
      });
    }
    return m;
  };

  const ownAddress = (ip: Ipv4Address): PortId | undefined => {
    for (const p of ports.values()) if (p.l3.ipv4?.address === ip) return p.id;
    return undefined;
  };
  const connectedPortFor = (ip: Ipv4Address): PortId | undefined => {
    for (const p of ports.values()) {
      const a = p.l3.ipv4;
      if (a && p.operUp && inSubnet(ip, a.address, a.prefixLen)) return p.id;
    }
    return undefined;
  };

  const ctx: ProcessCtx = {
    ...NO_IPV6_CTX,
    get now() {
      return now;
    },
    deviceId,
    hostname: 'Fake',
    model,
    get ports() {
      return views();
    },
    tables,
    config,
    rng,
    stream(label) {
      let st = streams.get(label);
      if (st === undefined) {
        st = rng.split(label);
        streams.set(label, st);
      }
      return st;
    },
    debug(category, message, data) {
      debug.push(data ? { at: now, device: deviceId, process: '?', category, message, data } : { at: now, device: deviceId, process: '?', category, message });
    },
    newPdu(layers, meta) {
      return factory.build(layers, { born: now, origin: deviceId, ...(meta ?? {}) });
    },
    mutate(pdu, field, after, reason, cause) {
      pdu.mutate({ now, device: deviceId }, field, after, reason, cause);
      mutations.push(cause === undefined ? { pdu: pdu.id, field, after, reason } : { pdu: pdu.id, field, after, reason, cause });
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
    lpm(dst) {
      return lpm(tables.rib, dst);
    },
    ownAddress,
    isLocalDestination(ip, inPort) {
      if (ownAddress(ip) !== undefined || ip === '255.255.255.255') return true;
      if (inPort !== undefined) {
        const a = ports.get(inPort)?.l3.ipv4;
        if (a && broadcastOf(a.address, a.prefixLen) === ip) return true;
      }
      return false;
    },
    connectedPortFor,
    sourceFor(dst) {
      const w = lpm(tables.rib, dst).winner;
      if (!w) return undefined;
      const iface = w.iface ?? connectedPortFor(w.nextHop ?? dst);
      if (iface === undefined) return undefined;
      const a = ports.get(iface)?.l3.ipv4;
      return a ? { address: a.address, iface } : undefined;
    },
    macOf(port) {
      return ports.get(port)?.mac ?? '00:00:00:00:00:00';
    },
  };

  function run(actions: Action[]): Action[] {
    for (const a of actions) {
      collected.push(a);
      if (a.type === 'setPortL3') {
        const p = ports.get(a.port);
        if (p) {
          const next: PortL3 = { ...p.l3 };
          if (a.ipv4 === null) delete next.ipv4;
          else if (a.ipv4 !== undefined) next.ipv4 = { ...a.ipv4 };
          p.l3 = next;
        }
      } else if (a.type === 'event') {
        const p = processes.get(a.to);
        if (p && p.onEvent) run(p.onEvent(ctx, a.ev));
      } else if (a.type === 'deliver') {
        const p = processes.get(a.to);
        if (p) run(p.onPdu(ctx, a.pdu, a.port));
      } else if (a.type === 'request') {
        const p = processes.get(a.to);
        if (p && p.onRequest) run(p.onRequest(ctx, a.req as ProcessRequest));
      }
    }
    return actions;
  }

  return {
    ctx,
    tables,
    trace,
    debug,
    mutations,
    actions: collected,
    setNow(t) {
      now = t;
    },
    setOper(port, up) {
      const p = ports.get(port);
      if (p) p.operUp = up;
    },
    setRole(port, role) {
      const p = ports.get(port);
      if (p) p.role = role;
    },
    register(p) {
      processes.set(p.name, p);
    },
    run,
    build(layers, meta) {
      return factory.build(layers, { born: now, origin: 'd_peer', ...(meta ?? {}) });
    },
    cliText(session) {
      let s = '';
      for (const a of collected) if (a.type === 'cliOutput' && a.session === session) s += a.text;
      return s;
    },
    actionsOf(type) {
      return collected.filter((a) => a.type === type) as never;
    },
  };
}

/** A process that records `deliver`/`request` it receives (stands in for arp). */
export function makeSink(name: string): Process & { pdus: Pdu[]; requests: ProcessRequest[] } {
  const pdus: Pdu[] = [];
  const requests: ProcessRequest[] = [];
  return {
    name,
    pdus,
    requests,
    onPdu(_ctx, pdu) {
      pdus.push(pdu);
      return [];
    },
    onTimer() {
      return [];
    },
    onConfig() {
      return [];
    },
    onRequest(_ctx, req) {
      requests.push(req);
      return [];
    },
    stateSnapshot() {
      return { process: name, state: {} };
    },
    debugEvents() {
      return [];
    },
  };
}

/** Layers of an echo request as a peer would send it (no ethernet). */
export function echoRequest(src: Ipv4Address, dst: Ipv4Address, id: number, seq: number, ttl = 128, payload = 72): LayerSpec[] {
  const data = new Uint8Array(payload);
  for (let i = 0; i < data.length; i++) data[i] = (i * 7) & 0xff;
  return [
    { proto: 'ipv4', fields: { src, dst, protocol: 1, ttl, id: seq } },
    { proto: 'icmpv4', fields: { type: 8, code: 0, id, seq } },
    { proto: 'payload', fields: { data } },
  ];
}

/** Wrap packet layers in an Ethernet frame. */
export function framed(dst: MacAddress, src: MacAddress, packet: LayerSpec[]): LayerSpec[] {
  return [{ proto: 'ethernet', fields: { dst, src, type: 0x0800 } }, ...packet];
}
