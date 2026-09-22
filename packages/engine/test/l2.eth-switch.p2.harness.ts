/**
 * Shared helper of the W2 l2 eth-switch tests (vlan, trunk, psec, svi-trunk, controller): a fake `ProcessCtx` over a
 * VLAN-aware model (a P2-stage NF-C2960 built by test/p2.world.ts with the real `vlan` factory, or a hand-built
 * controller), real tables for every name the §3.0 path reads (cam, vlans, port-security, dtp, stp, stp-bridge,
 * etherchannel — created on demand so a test may seed the rows of a daemon that does not run), a real config AST and
 * pdu factory, and helpers to build untagged/tagged frames and to apply config lines through `onConfig`. Not a test
 * file itself.
 */
import { createConfigAst } from '../src/cli/config-ast.js';
import { MAC_BROADCAST } from '../src/contracts/addr.js';
import type { MacAddress } from '../src/contracts/addr.js';
import type { PortRole } from '../src/contracts/catalog.js';
import type { ConfigAst, ConfigDelta } from '../src/contracts/config.js';
import type { DeviceModel } from '../src/contracts/device.js';
import type { PortId } from '../src/contracts/ids.js';
import { ARP_OP_REQUEST, ETHERTYPE_ARP, ETHERTYPE_VLAN } from '../src/contracts/pdu.js';
import type { LayerSpec, Pdu, PduMeta } from '../src/contracts/pdu.js';
import { DEFAULT_MTU, SPEED_100M, emptyCounters } from '../src/contracts/port.js';
import type { PortView } from '../src/contracts/port.js';
import type { Action, DebugEvent, Process, ProcessCtx } from '../src/contracts/process.js';
import type { Rng } from '../src/contracts/rng.js';
import type { DeviceTables, Table, TableName, TableRow } from '../src/contracts/tables.js';
import type { TraceEvent } from '../src/contracts/trace.js';
import { createRng } from '../src/core/prng.js';
import { createTable } from '../src/core/table.js';
import { createPduFactory } from '../src/pdu/factory.js';
import { createVlan } from '../src/protocols/vlan.js';
import { NF_C2960_INPUT } from './device.catalog.p0-inputs.js';
import { defineP2Model, p2Registry } from './p2.world.js';
import { NO_IPV6_CTX, P2_CTX, testPortSpec } from './port.fixtures.js';

export const DEVICE = 'd_sw1';
export const FA1 = 'FastEthernet0/1';
export const FA2 = 'FastEthernet0/2';
export const FA3 = 'FastEthernet0/3';
export const GI1 = 'GigabitEthernet0/1';
export const GI2 = 'GigabitEthernet0/2';
export const MAC_A = '00:1f:00:00:00:0a';
export const MAC_B = '00:1f:00:00:00:0b';
export const MAC_C = '00:1f:00:00:00:0c';
export const MAC_X = '00:1f:00:00:00:0d';
/** The base MAC every SVI of the fake device shares (ports.ts: virtual ports use ordinal 0). */
export const SVI_MAC = '02:4e:00:10:00:00';

/** The P2-stage NF-C2960 with the real `vlan` factory: `managed-switch`, processes with `vlan`, tables with `vlans`. */
export const VLAN_AWARE_MODEL: DeviceModel = defineP2Model(NF_C2960_INPUT, p2Registry({ vlan: createVlan }));

/** Every table name the VLAN-aware path may read. */
const TABLE_NAMES: readonly TableName[] = ['cam', 'arp', 'rib', 'vlans', 'port-security', 'dtp', 'stp', 'stp-bridge', 'etherchannel'];

export interface FakePortOptions {
  readonly role?: PortRole;
  readonly operUp?: boolean;
  readonly mac?: MacAddress;
  readonly kind?: 'ethernet' | 'virtual';
}

export interface P2SwitchHarness {
  readonly ctx: ProcessCtx;
  readonly ports: Map<PortId, PortView>;
  readonly trace: TraceEvent[];
  readonly debug: DebugEvent[];
  readonly config: ConfigAst;
  readonly tables: DeviceTables;
  setNow(t: number): void;
  setOper(port: PortId, up: boolean): void;
  setErrDisabled(port: PortId, cause: string | undefined): void;
  /** Add (or replace) a port view; `role` defaults to 'switched' for ethernet and 'svi' for virtual kinds. */
  addPort(id: PortId, index: number, opts?: FakePortOptions): PortView;
  /** An ARP request frame `src → dst`, tagged with `vid` when given (`[ethernet 0x8100, dot1q, arp]`). */
  frame(src: MacAddress, dst: MacAddress, vid?: number): Pdu;
  /** Apply one config line (or its `no` form) to the AST and hand the delta to `sw.onConfig`; returns its actions. */
  configure(sw: Process, context: readonly (readonly string[])[], line: readonly string[], negate?: boolean): Action[];
  /** Apply several interface lines of `port` through `configure`. */
  lines(sw: Process, port: PortId, lines: readonly string[]): Action[];
  /** Trace events of one kind. */
  kinds<K extends TraceEvent['kind']>(kind: K): Extract<TraceEvent, { kind: K }>[];
}

export interface P2SwitchHarnessOptions {
  readonly model?: DeviceModel;
  /** Port ids to create as oper-up switched ports (index = position + 1). Default: FA1–FA3, GI1, GI2. */
  readonly ports?: readonly PortId[];
}

/** Fake ProcessCtx over `opts.model` (default `VLAN_AWARE_MODEL`). */
export function p2SwitchHarness(opts: P2SwitchHarnessOptions = {}): P2SwitchHarness {
  const model = opts.model ?? VLAN_AWARE_MODEL;
  let now = 0;
  const trace: TraceEvent[] = [];
  const debug: DebugEvent[] = [];
  const sink = { emit: (ev: TraceEvent) => { trace.push(ev); } };
  const clock = () => now;
  const byName = new Map<TableName, Table<TableRow>>();
  const tableOf = <R extends TableRow>(name: TableName): Table<R> => {
    let t = byName.get(name);
    if (t === undefined) {
      t = createTable<TableRow>({ name, device: DEVICE, sink, now: clock });
      byName.set(name, t);
    }
    return t as unknown as Table<R>;
  };
  const tables = {
    get cam() { return tableOf<never>('cam') as unknown as DeviceTables['cam']; },
    get arp() { return tableOf<never>('arp') as unknown as DeviceTables['arp']; },
    get rib() { return tableOf<never>('rib') as unknown as DeviceTables['rib']; },
    get: <R extends TableRow = TableRow>(name: TableName): Table<R> | undefined => (TABLE_NAMES.includes(name) ? tableOf<R>(name) : undefined),
    names: (): readonly TableName[] => TABLE_NAMES,
  } as DeviceTables;
  const ports = new Map<PortId, PortView>();
  const config = createConfigAst();
  const factory = createPduFactory();
  const meta = (over: Partial<PduMeta> = {}): PduMeta => ({ born: now, origin: DEVICE, ...over });
  const rng = createRng(7);
  const streams = new Map<string, Rng>();

  const addPort = (id: PortId, index: number, o: FakePortOptions = {}): PortView => {
    const kind = o.kind ?? 'ethernet';
    const role: PortRole = o.role ?? (kind === 'ethernet' ? 'switched' : 'svi');
    const view: PortView = {
      id,
      spec: testPortSpec({ name: id, short: id, kind, speedBps: SPEED_100M, autoMdix: true, role }, model.capabilities, index),
      mac: o.mac ?? (kind === 'virtual' ? SVI_MAC : `00:1f:00:00:01:${index.toString(16).padStart(2, '0')}`),
      adminUp: true,
      operUp: o.operUp ?? true,
      mtu: DEFAULT_MTU,
      counters: emptyCounters(),
      l3: {},
      tx: { busyUntil: 0, queue: 0 },
      role,
      ordinal: kind === 'virtual' ? 0 : index,
      encap: 'ethernet',
    };
    ports.set(id, view);
    return view;
  };
  (opts.ports ?? [FA1, FA2, FA3, GI1, GI2]).forEach((id, i) => addPort(id, i + 1));

  const ctx: ProcessCtx = {
    ...P2_CTX,
    ...NO_IPV6_CTX,
    get now() { return now; },
    deviceId: DEVICE,
    hostname: 'SW1',
    model,
    ports,
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
      debug.push(data === undefined
        ? { at: now, device: DEVICE, process: 'eth-switch', category, message }
        : { at: now, device: DEVICE, process: 'eth-switch', category, message, data });
    },
    newPdu(layers, m) { return factory.build(layers, meta(m)); },
    mutate(pdu, field, after, reason, cause) { pdu.mutate({ now, device: DEVICE }, field, after, reason, cause); },
    encapsulate(pdu, outer, cause) { pdu.encapsulate({ now, device: DEVICE }, outer, cause); },
    clone(pdu) { return factory.clone(pdu, now); },
    lpm() { return { candidates: [] }; },
    ownAddress() { return undefined; },
    isLocalDestination() { return false; },
    connectedPortFor() { return undefined; },
    sourceFor() { return undefined; },
    macOf(port) { return ports.get(port)!.mac; },
    rewrap(pdu, op, cause) { pdu.rewrap({ now, device: DEVICE }, op, cause); },
    hasCapability(cap) { return model.capabilities.includes(cap); },
  };

  const frame = (src: MacAddress, dst: MacAddress, vid?: number): Pdu => {
    const arp: LayerSpec = {
      proto: 'arp',
      fields: { op: ARP_OP_REQUEST, sha: src, spa: '10.0.0.1', tha: dst === MAC_BROADCAST ? '00:00:00:00:00:00' : dst, tpa: '10.0.0.2' },
    };
    const layers: LayerSpec[] = vid === undefined
      ? [{ proto: 'ethernet', fields: { dst, src, type: ETHERTYPE_ARP } }, arp]
      : [{ proto: 'ethernet', fields: { dst, src, type: ETHERTYPE_VLAN } }, { proto: 'dot1q', fields: { vid, type: ETHERTYPE_ARP } }, arp];
    return factory.build(layers, meta({ origin: 'd_pc1' }));
  };

  const configure = (sw: Process, context: readonly (readonly string[])[], line: readonly string[], negate = false): Action[] => {
    const delta: ConfigDelta | undefined = negate ? config.unset(context, line) : config.set(context, line);
    if (delta === undefined) return [];
    return sw.onConfig(ctx, delta);
  };

  return {
    ctx,
    ports,
    trace,
    debug,
    config,
    tables,
    setNow(t) { now = t; },
    setOper(port, up) {
      const v = ports.get(port)!;
      ports.set(port, { ...v, operUp: up });
    },
    setErrDisabled(port, cause) {
      const v = ports.get(port)!;
      const { errDisabled: _drop, ...rest } = v;
      ports.set(port, cause === undefined ? (rest as PortView) : { ...rest, errDisabled: cause });
    },
    addPort,
    frame,
    configure,
    lines(sw, port, ls) {
      const out: Action[] = [];
      for (const l of ls) {
        const negate = l.startsWith('no ');
        out.push(...configure(sw, [['interface', port]], (negate ? l.slice(3) : l).split(' '), negate));
      }
      return out;
    },
    kinds<K extends TraceEvent['kind']>(kind: K): Extract<TraceEvent, { kind: K }>[] {
      return trace.filter((e): e is Extract<TraceEvent, { kind: K }> => e.kind === kind);
    },
  };
}

/** The `send` actions of a result. */
export const sendsOf = (actions: readonly Action[]): Extract<Action, { type: 'send' }>[] =>
  actions.filter((a): a is Extract<Action, { type: 'send' }> => a.type === 'send');
/** The `ingress` actions of a result. */
export const ingressOf = (actions: readonly Action[]): Extract<Action, { type: 'ingress' }>[] =>
  actions.filter((a): a is Extract<Action, { type: 'ingress' }> => a.type === 'ingress');
/** The `drop` actions of a result. */
export const dropsOf = (actions: readonly Action[]): Extract<Action, { type: 'drop' }>[] =>
  actions.filter((a): a is Extract<Action, { type: 'drop' }> => a.type === 'drop');
/** The protocol names of a PDU's layers, outermost first. */
export const protosOf = (pdu: Pdu): string[] => pdu.layers.map((l) => l.proto);
/** The provenance of a PDU as `[reason, cause]` pairs. */
export const provenanceOf = (pdu: Pdu): [string, string | undefined][] => pdu.provenance.map((m) => [m.reason, m.cause]);
/** Hex text of a PDU's bytes. */
export const hexOf = (pdu: Pdu): string => Array.from(pdu.bytes, (b) => b.toString(16).padStart(2, '0')).join('');
