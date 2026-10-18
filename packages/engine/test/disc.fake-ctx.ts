/**
 * disc.fake-ctx — a small fake ProcessCtx for the discovery daemons (cdp, lldp) driven directly (ARCHITECTURE-P3C §7
 * W1b disc): real tables, a real PDU factory and codecs, a mutable clock, a real config AST; ports and the model are
 * plain data. Used by `disc.cdp-voice-vlan.test.ts` (the fake phone uplink) and `disc.cdp-mismatch.test.ts` (the
 * rate limit to the ns). Not a test file.
 */
import type { Capability } from '../src/contracts/catalog.js';
import type { ConfigAst } from '../src/contracts/config.js';
import type { DeviceModel } from '../src/contracts/device.js';
import type { PortId } from '../src/contracts/ids.js';
import type { LayerSpec, Pdu } from '../src/contracts/pdu.js';
import { emptyCounters, type PortSpec, type PortView } from '../src/contracts/port.js';
import type { Action, ProcessCtx } from '../src/contracts/process.js';
import type { DeviceTables, Table, TableName, TableRow } from '../src/contracts/tables.js';
import type { TraceEvent } from '../src/contracts/trace.js';
import { createConfigAst } from '../src/cli/config-ast.js';
import { createTable } from '../src/core/table.js';
import { createPduFactory } from '../src/pdu/factory.js';
import { testPortSpec } from './port.fixtures.js';

/** One port of the fake device. */
export interface FakePort {
  readonly id: PortId;
  readonly kind?: PortSpec['kind'];
  readonly role: PortView['role'];
  readonly group?: string;
  readonly up?: boolean;
  readonly duplex?: 'full' | 'half';
  readonly ipv4?: string;
}

/** The fake device: its ctx at the current clock, its tables, its trace and a frame builder for a peer. */
export interface FakeDevice {
  readonly config: ConfigAst;
  readonly trace: TraceEvent[];
  readonly ports: Map<PortId, PortView>;
  now: number;
  ctx(): ProcessCtx;
  table<R extends TableRow>(name: TableName): Table<R>;
  /** A frame from a peer (origin `d_peer`). */
  frame(layers: readonly LayerSpec[]): Pdu;
  /** Set a port's operational state. */
  setUp(id: PortId, up: boolean): void;
}

const MAC = (n: number): string => `02:00:00:00:aa:${n.toString(16).padStart(2, '0')}`;

/** A fake device of model `model` (name) with `capabilities` and `ports`. */
export function fakeDevice(opts: { model: string; capabilities: readonly Capability[]; ports: readonly FakePort[]; hostname?: string; profile?: ProcessCtx['profile'] }): FakeDevice {
  const device = 'd_fake';
  const trace: TraceEvent[] = [];
  const sink = { emit: (ev: TraceEvent) => void trace.push(ev) };
  const state = { now: 0 };
  const clock = (): number => state.now;
  const byName: Record<string, Table<TableRow>> = {};
  for (const name of ['cam', 'arp', 'rib', 'cdp-neighbours', 'lldp-neighbours', 'dtp']) {
    byName[name] = createTable<TableRow>({ name: name as TableName, device, sink, now: clock });
  }
  const tables = {
    cam: byName.cam,
    arp: byName.arp,
    rib: byName.rib,
    get: <R extends TableRow = TableRow>(name: TableName): Table<R> | undefined => byName[name] as unknown as Table<R> | undefined,
    names: () => Object.keys(byName) as TableName[],
  } as unknown as DeviceTables;
  const model = { model: opts.model, capabilities: opts.capabilities } as unknown as DeviceModel;
  const ports = new Map<PortId, PortView>();
  opts.ports.forEach((p, i) => {
    const kind = p.kind ?? 'ethernet';
    const spec = testPortSpec({ name: p.id, short: p.id, kind, speedBps: 100_000_000, role: p.role, ...(p.group !== undefined ? { group: p.group } : {}) } as Parameters<typeof testPortSpec>[0], opts.capabilities, i + 1);
    const view = {
      id: p.id,
      spec,
      mac: MAC(i + 1),
      adminUp: true,
      operUp: p.up ?? true,
      mtu: 1500,
      counters: emptyCounters(),
      l3: p.ipv4 !== undefined ? { ipv4: { address: p.ipv4, prefixLen: 24 } } : {},
      tx: { busyUntil: 0, queue: 0 },
      role: p.role,
      ordinal: i + 1,
      encap: 'ethernet',
      ...(p.duplex !== undefined ? { duplex: p.duplex } : {}),
    } as unknown as PortView;
    ports.set(p.id, view);
  });
  const config = createConfigAst();
  const factory = createPduFactory();
  const fake: FakeDevice = {
    config,
    trace,
    ports,
    get now() {
      return state.now;
    },
    set now(t: number) {
      state.now = t;
    },
    ctx(): ProcessCtx {
      const now = state.now;
      return {
        now,
        deviceId: device,
        hostname: opts.hostname ?? 'FAKE',
        model,
        ports,
        tables,
        config,
        profile: opts.profile ?? 'P3',
        debug(category: string, message: string, data?: Record<string, unknown>) {
          trace.push({ t: now, kind: 'debug', event: { at: now, device, process: 'disc', category, message, ...(data !== undefined ? { data } : {}) } } as TraceEvent);
        },
        newPdu: (layers: readonly LayerSpec[], meta?: Record<string, unknown>) => factory.build(layers, { born: now, origin: device, ...(meta ?? {}) }),
        macOf: (port: PortId) => ports.get(port)?.mac ?? MAC(0),
        hasCapability: (cap: Capability) => opts.capabilities.includes(cap),
      } as unknown as ProcessCtx;
    },
    table<R extends TableRow>(name: TableName): Table<R> {
      return byName[name] as unknown as Table<R>;
    },
    frame: (layers) => factory.build(layers, { born: state.now, origin: 'd_peer' }),
    setUp(id, up) {
      const v = ports.get(id) as unknown as { operUp: boolean };
      v.operUp = up;
    },
  };
  return fake;
}

/** The `send` actions of `actions` as `[port, layer fields of proto]`. */
export function sentLayers(actions: readonly Action[], proto: string): [PortId, Record<string, unknown>][] {
  return actions
    .filter((a): a is Extract<Action, { type: 'send' }> => a.type === 'send')
    .map((a) => [a.port, { ...(a.pdu.layer(proto)?.fields ?? {}) }]);
}

/** The `log` actions of `actions`. */
export function logsOf(actions: readonly Action[]): Extract<Action, { type: 'log' }>[] {
  return actions.filter((a): a is Extract<Action, { type: 'log' }> => a.type === 'log');
}

/** The `request` actions of `actions`. */
export function requestsOf(actions: readonly Action[]): Extract<Action, { type: 'request' }>[] {
  return actions.filter((a): a is Extract<Action, { type: 'request' }> => a.type === 'request');
}

/** The `timer` actions of `actions` as `[key, delay]`. */
export function timersOf(actions: readonly Action[]): [string, number][] {
  return actions.filter((a): a is Extract<Action, { type: 'timer' }> => a.type === 'timer').map((a) => [a.key, a.delay]);
}
