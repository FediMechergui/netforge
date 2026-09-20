/**
 * test/wifi.harness.ts — a small Wi-Fi world for the air medium and wlan daemon tests (not a test file).
 *
 * It wires real catalog models, real port states (D8 MACs), config ASTs, device tables, process contexts, the pdu
 * factory, a tracked scheduler and the air medium behind a facade-like MediumHost, and runs a dispatch loop:
 *   frameArrival → air.admit → (802.11 frames) the wlan daemon of the port role, after the carrier gate and the
 *                  station MAC filter; (Ethernet frames) recorded in `delivered`
 *   timer        → the daemon's onTimer (stale timers ignored);  mediumTimer → air.onMediumTimer
 *   actions      → send → air.transmit; medium → air.mediumOp; timer / cancelTimer; drop → trace
 *   OperChanges  → onLinkChange of every daemon of the device; medium notifications → onMediumEvent
 * `runToIdle` stops when only periodic timers remain (D10).
 */
import { deviceMacBase } from '../src/contracts/addr.js';
import type { ConfigAst } from '../src/contracts/config.js';
import type { DeviceModel } from '../src/contracts/device.js';
import type { Scheduler, SimEvent, SimEventBody } from '../src/contracts/events.js';
import type { DeviceId, PortId, PortRef, ProcessName } from '../src/contracts/ids.js';
import { portKey } from '../src/contracts/ids.js';
import type { LinkModelDeps, OperChanges, TransmitResult } from '../src/contracts/link.js';
import type { MediumEvent, MediumOp } from '../src/contracts/medium.js';
import type { LayerSpec, Pdu } from '../src/contracts/pdu.js';
import { ETHERTYPE_IPV4, ICMP_ECHO_REQUEST, IPPROTO_ICMP } from '../src/contracts/pdu.js';
import type { PortState } from '../src/contracts/port.js';
import type { Action, Process, ProcessCtx } from '../src/contracts/process.js';
import type { Rng } from '../src/contracts/rng.js';
import type { ArpRow, CamRow, DeviceTables, RouteRow, Table, TableName, TableRow } from '../src/contracts/tables.js';
import type { SimTime } from '../src/contracts/time.js';
import type { TraceEvent } from '../src/contracts/trace.js';
import { createConfigAst } from '../src/cli/config-ast.js';
import { createRng } from '../src/core/prng.js';
import { createScheduler } from '../src/core/scheduler.js';
import { createTable } from '../src/core/table.js';
import { ALL_MODELS } from '../src/device/catalog/index.js';
import { fixedPortStates } from '../src/device/ports.js';
import { createProcessCtx } from '../src/device/process-ctx.js';
import type { ProcessHost } from '../src/device/process-ctx.js';
import { createInflightRegistry } from '../src/link/inflight.js';
import { createAirMedium } from '../src/link/media/air.js';
import type { AirMedium } from '../src/link/media/air.js';
import { summarizePdu } from '../src/link/media/p2p.js';
import type { MediumHost } from '../src/link/media/types.js';
import { createPduFactory } from '../src/pdu/factory.js';
import type { PduFactoryImpl } from '../src/pdu/factory.js';
import { createWlanAp } from '../src/protocols/wlan-ap.js';
import { createWlanClient, readRadioSettings } from '../src/protocols/wlan-client.js';
import { INERT_LINK_DEPS } from './port.fixtures.js';

/** One device of the world. */
export interface WifiDevice {
  readonly id: DeviceId;
  readonly model: DeviceModel;
  readonly ports: Map<PortId, PortState>;
  readonly config: ConfigAst;
  readonly tables: DeviceTables;
  readonly processes: Map<ProcessName, Process>;
  readonly ctxs: Map<ProcessName, ProcessCtx>;
  readonly daemons: boolean;
  position: { x: number; y: number };
  power: boolean;
  booted: boolean;
}

/** A frame seen by the harness after admit. */
export interface Seen {
  readonly device: DeviceId;
  readonly port: PortId;
  readonly pdu: Pdu;
  readonly at: SimTime;
}

export interface AddOptions {
  /** Interface lines: [port, tokens]. */
  lines?: readonly (readonly [PortId, readonly string[]])[];
  /** Model override (e.g. a copy with a smaller client limit). */
  model?: DeviceModel;
  /** Instantiate wlan-ap / wlan-client (default true). */
  daemons?: boolean;
}

export interface WifiWorld {
  readonly seed: number;
  readonly scheduler: Scheduler;
  readonly events: TraceEvent[];
  readonly air: AirMedium;
  readonly pdus: PduFactoryImpl;
  readonly devices: Map<DeviceId, WifiDevice>;
  readonly notifications: { ref: PortRef; ev: MediumEvent; at: SimTime }[];
  readonly delivered: Seen[];
  readonly received: Seen[];
  readonly transmits: { from: PortRef; pdu: Pdu; result: TransmitResult; at: SimTime }[];
  /** Replica of the link model's rng root (`createRng(seed).split('links')`). */
  linksRng(): Rng;
  addDevice(id: DeviceId, type: string, position: { x: number; y: number }, opts?: AddOptions): WifiDevice;
  boot(): void;
  configure(id: DeviceId, port: PortId | undefined, tokens: readonly string[], negate?: boolean): void;
  move(id: DeviceId, position: { x: number; y: number }): void;
  setAdmin(id: DeviceId, port: PortId, up: boolean): void;
  powerOff(id: DeviceId): void;
  send(id: DeviceId, port: PortId, pdu: Pdu): TransmitResult;
  op(id: DeviceId, port: PortId, op: MediumOp): OperChanges;
  run(until: SimTime): void;
  runFor(ns: SimTime): void;
  runToIdle(maxEvents?: number): number;
  now(): SimTime;
  port(id: DeviceId, port: PortId): PortState;
  ref(id: DeviceId, port: PortId): PortRef;
  daemon(id: DeviceId, name: ProcessName): Process;
  ofKind<K extends TraceEvent['kind']>(kind: K): Extract<TraceEvent, { kind: K }>[];
}

/** Model by catalog type (throws when unknown). */
export function modelOf(type: string): DeviceModel {
  const m = ALL_MODELS.find((x) => x.type === type);
  if (m === undefined) throw new Error(`no catalog model ${type}`);
  return m;
}

/** Copy of a model whose radio port `port` accepts at most `maxClients` stations. */
export function withClientLimit(model: DeviceModel, port: PortId, maxClients: number): DeviceModel {
  return {
    ...model,
    ports: model.ports.map((p) => (p.name === port && p.radio !== undefined ? { ...p, radio: { ...p.radio, maxClients } } : p)),
  };
}

/** Ethernet/IPv4/ICMP echo layers from `src` to `dst`. */
export function echoLayers(dst: string, src: string): LayerSpec[] {
  return [
    { proto: 'ethernet', fields: { dst, src, type: ETHERTYPE_IPV4 } },
    { proto: 'ipv4', fields: { src: '192.168.1.10', dst: '192.168.1.1', protocol: IPPROTO_ICMP, ttl: 64 } },
    { proto: 'icmpv4', fields: { type: ICMP_ECHO_REQUEST, code: 0, id: 1, seq: 1 } },
    { proto: 'payload', fields: { data: new Uint8Array(32).fill(0x5a) } },
  ];
}

/** Build a Wi-Fi world. */
export function wifiWorld(opts: { seed?: number; metresPerUnit?: number } = {}): WifiWorld {
  const seed = opts.seed ?? 11;
  const events: TraceEvent[] = [];
  const sink = { emit: (ev: TraceEvent) => events.push(ev) };
  const inner = createScheduler();
  const live = new Map<number, boolean>();
  let nonPeriodic = 0;
  const release = (seq: number): void => {
    const periodic = live.get(seq);
    if (periodic === undefined) return;
    live.delete(seq);
    if (!periodic) nonPeriodic--;
  };
  const scheduler: Scheduler = {
    get now() {
      return inner.now;
    },
    get size() {
      return inner.size;
    },
    schedule(at: SimTime, body: SimEventBody): number {
      const seq = inner.schedule(at, body);
      const periodic = body.kind === 'timer' && body.periodic === true;
      live.set(seq, periodic);
      if (!periodic) nonPeriodic++;
      return seq;
    },
    cancel(seq: number): boolean {
      const ok = inner.cancel(seq);
      if (ok) release(seq);
      return ok;
    },
    next(): SimEvent | undefined {
      const ev = inner.next();
      if (ev !== undefined) release(ev.seq);
      return ev;
    },
    peekTime: () => inner.peekTime(),
    advanceTo: (t: SimTime) => inner.advanceTo(t),
  };

  const root = createRng(seed);
  const pdus = createPduFactory();
  const devices = new Map<DeviceId, WifiDevice>();
  const notifications: WifiWorld['notifications'] = [];
  const delivered: Seen[] = [];
  const received: Seen[] = [];
  const transmits: WifiWorld['transmits'] = [];
  const timers = new Map<string, number>();

  const deviceUp = (id: DeviceId): boolean => {
    const d = devices.get(id);
    return d !== undefined && d.power && d.booted;
  };

  let air: AirMedium;

  const fanOper = (changes: OperChanges): void => {
    for (const c of changes) {
      const dev = devices.get(c.port.device);
      if (dev === undefined || !deviceUp(dev.id)) continue;
      for (const [name, proc] of dev.processes) {
        const ctx = dev.ctxs.get(name)!;
        if (proc.onLinkChange) apply(dev, name, proc.onLinkChange(ctx, c.port.port, c.operUp));
      }
    }
  };

  const apply = (dev: WifiDevice, name: ProcessName, actions: readonly Action[]): void => {
    for (const a of actions) {
      const now = scheduler.now;
      switch (a.type) {
        case 'send': {
          const from = { device: dev.id, port: a.port };
          const result = air.transmit(from, a.pdu, now);
          transmits.push({ from, pdu: a.pdu, result, at: now });
          break;
        }
        case 'medium':
          fanOper(air.mediumOp({ device: dev.id, port: a.port }, a.op, now));
          break;
        case 'timer': {
          const key = `${dev.id}|${name}|${a.key}`;
          const prev = timers.get(key);
          if (prev !== undefined) scheduler.cancel(prev);
          const body: SimEventBody = a.periodic === true
            ? { kind: 'timer', device: dev.id, process: name, key: a.key, periodic: true }
            : { kind: 'timer', device: dev.id, process: name, key: a.key };
          timers.set(key, scheduler.schedule(now + a.delay, body));
          break;
        }
        case 'cancelTimer': {
          const key = `${dev.id}|${name}|${a.key}`;
          const prev = timers.get(key);
          if (prev !== undefined) scheduler.cancel(prev);
          timers.delete(key);
          break;
        }
        case 'drop': {
          const ev: TraceEvent = { t: now, kind: 'drop', pdu: summarizePdu(a.pdu), device: dev.id, reason: a.reason };
          if (a.port !== undefined) ev.port = a.port;
          if (a.detail !== undefined) ev.detail = a.detail;
          events.push(ev);
          break;
        }
        default:
          break;
      }
    }
  };

  const deps: LinkModelDeps = {
    ...INERT_LINK_DEPS,
    scheduler,
    trace: sink,
    rng: root.split('links'),
    port: (ref) => devices.get(ref.device)?.ports.get(ref.port),
    deviceUp,
    pdus,
    radioSettings: (ref) => {
      const dev = devices.get(ref.device);
      const spec = dev?.ports.get(ref.port)?.spec.radio;
      return dev === undefined || spec === undefined ? undefined : readRadioSettings(dev.config, ref.port, spec);
    },
    position: (id) => devices.get(id)?.position,
    metresPerUnit: opts.metresPerUnit ?? 0.25,
    notify: (ref, ev, at) => {
      notifications.push({ ref, ev, at });
      const dev = devices.get(ref.device);
      if (dev === undefined || !deviceUp(dev.id)) return;
      for (const [name, proc] of dev.processes) {
        if (proc.onMediumEvent) apply(dev, name, proc.onMediumEvent(dev.ctxs.get(name)!, ref.port, ev));
      }
    },
  };
  const streams = new Map<string, Rng>();
  const host: MediumHost = {
    deps,
    inflight: createInflightRegistry(),
    port: (ref) => deps.port(ref),
    deviceUp,
    link: () => undefined,
    stream(label) {
      let s = streams.get(label);
      if (s === undefined) {
        s = deps.rng.split(label);
        streams.set(label, s);
      }
      return s;
    },
    emit: (ev) => events.push(ev),
    schedule: (at, body) => scheduler.schedule(at, body),
    cancel: (seq) => scheduler.cancel(seq),
    txOutcome: () => undefined,
    notify: (ref, ev, now) => deps.notify!(ref, ev, now),
    capture: () => undefined,
  };
  air = createAirMedium(host);

  const radioPorts = (dev: WifiDevice): PortId[] => [...dev.ports.values()].filter((p) => p.spec.kind === 'wlan').map((p) => p.id);

  const dispatch = (ev: SimEvent): void => {
    switch (ev.kind) {
      case 'frameArrival': {
        const verdict = air.admit(ev, ev.at);
        if (!verdict.deliver) return;
        const seen: Seen = { device: ev.device, port: ev.port, pdu: verdict.pdu, at: ev.at };
        received.push(seen);
        const dev = devices.get(ev.device);
        if (dev === undefined || !deviceUp(dev.id)) return;
        const port = dev.ports.get(ev.port);
        if (port === undefined) return;
        const outer = verdict.pdu.layers[0];
        if (outer?.proto === 'ethernet') {
          delivered.push(seen);
          return;
        }
        if (outer?.proto !== 'dot11' || port.phy?.carrier !== true) return;
        const role = port.role ?? port.spec.role;
        if (role === 'wireless-client') {
          const addr1 = String(outer.fields.addr1);
          const group = (parseInt(addr1.slice(0, 2), 16) & 1) === 1;
          if (!group && addr1 !== port.mac) return;
        }
        const name = role === 'wireless-bss' ? 'wlan-ap' : 'wlan-client';
        const proc = dev.processes.get(name);
        if (proc !== undefined) apply(dev, name, proc.onPdu(dev.ctxs.get(name)!, verdict.pdu, ev.port));
        return;
      }
      case 'timer': {
        const key = `${ev.device}|${ev.process}|${ev.key}`;
        if (timers.get(key) !== ev.seq) return;
        timers.delete(key);
        const dev = devices.get(ev.device);
        const proc = dev?.processes.get(ev.process);
        if (dev === undefined || proc === undefined || !deviceUp(dev.id)) return;
        apply(dev, ev.process, proc.onTimer(dev.ctxs.get(ev.process)!, ev.key));
        return;
      }
      case 'mediumTimer':
        fanOper(air.onMediumTimer(ev.medium, ev.key, ev.at));
        return;
      default:
        return;
    }
  };

  const world: WifiWorld = {
    seed,
    scheduler,
    events,
    air,
    pdus,
    devices,
    notifications,
    delivered,
    received,
    transmits,

    linksRng: () => createRng(seed).split('links'),

    addDevice(id, type, position, addOpts = {}) {
      const model = addOpts.model ?? modelOf(type);
      const macBase = deviceMacBase(id);
      const ports = new Map<PortId, PortState>();
      for (const p of fixedPortStates(model, { macBase, capabilities: model.capabilities, portsDefaultUp: model.portsDefaultUp })) {
        if (p.spec.kind === 'wlan') p.adminUp = true;
        ports.set(p.id, p);
      }
      const make = <R extends TableRow>(name: TableName): Table<R> => createTable<R>({ name, device: id, sink, now: () => scheduler.now });
      const cam = make<CamRow>('cam');
      const arp = make<ArpRow>('arp');
      const rib = make<RouteRow>('rib');
      const extra = new Map<TableName, Table<TableRow>>([['dot11-assoc', make<TableRow>('dot11-assoc')]]);
      const tables: DeviceTables = {
        cam, arp, rib,
        get<R extends TableRow = TableRow>(name: TableName): Table<R> | undefined {
          if (name === 'cam') return cam as unknown as Table<R>;
          if (name === 'arp') return arp as unknown as Table<R>;
          if (name === 'rib') return rib as unknown as Table<R>;
          return extra.get(name) as unknown as Table<R> | undefined;
        },
        names: () => ['cam', 'arp', 'rib', 'dot11-assoc'],
      };
      const config = createConfigAst();
      for (const [port, tokens] of addOpts.lines ?? []) config.set([['interface', port]], [...tokens]);
      const dev: WifiDevice = {
        id, model, ports, config, tables, processes: new Map(), ctxs: new Map(), daemons: addOpts.daemons ?? true,
        position: { ...position }, power: true, booted: false,
      };
      devices.set(id, dev);
      return dev;
    },

    boot() {
      const now = scheduler.now;
      for (const dev of devices.values()) {
        if (dev.booted || !dev.power) continue;
        dev.booted = true;
        if (!dev.daemons) continue;
        const rng = root.split(`device:${dev.id}`);
        for (const name of ['wlan-ap', 'wlan-client'] as const) {
          if (!dev.model.processes.includes(name)) continue;
          const proc = name === 'wlan-ap' ? createWlanAp() : createWlanClient();
          const phost: ProcessHost = {
            id: dev.id,
            hostname: dev.id,
            model: dev.model,
            get now() {
              return scheduler.now;
            },
            ports: dev.ports,
            tables: dev.tables,
            get running() {
              return dev.config;
            },
            trace: sink,
            pdus,
            capabilities: dev.model.capabilities ?? [],
            air: air.airView(dev.id),
            recordDebug: () => undefined,
          };
          const ctx = createProcessCtx(phost, name, rng.split(`process:${name}`));
          dev.processes.set(name, proc);
          dev.ctxs.set(name, ctx);
        }
        for (const [name, proc] of dev.processes) apply(dev, name, proc.init?.(dev.ctxs.get(name)!) ?? []);
      }
      for (const dev of devices.values()) {
        for (const port of radioPorts(dev)) fanOper(air.onPortChanged({ device: dev.id, port }, now, 'boot'));
      }
    },

    configure(id, port, tokens, negate = false) {
      const dev = devices.get(id)!;
      const context: string[][] = port === undefined ? [] : [['interface', port]];
      const delta = negate ? dev.config.unset(context, tokens) : dev.config.set(context, tokens);
      if (delta === undefined || !deviceUp(id)) return;
      if (port !== undefined && tokens[0] === 'shutdown') dev.ports.get(port)!.adminUp = negate;
      const pending: [ProcessName, Action[]][] = [];
      for (const [name, proc] of dev.processes) pending.push([name, proc.onConfig(dev.ctxs.get(name)!, delta)]);
      for (const [name, actions] of pending) apply(dev, name, actions);
      if (port !== undefined && dev.ports.get(port)?.spec.kind === 'wlan') fanOper(air.onPortChanged({ device: id, port }, scheduler.now, 'config'));
    },

    move(id, position) {
      devices.get(id)!.position = { ...position };
      fanOper(air.onDevicesMoved([id], scheduler.now));
    },

    setAdmin(id, port, up) {
      devices.get(id)!.ports.get(port)!.adminUp = up;
      fanOper(air.onPortChanged({ device: id, port }, scheduler.now, up ? 'admin-up' : 'admin-down'));
    },

    powerOff(id) {
      const dev = devices.get(id)!;
      dev.power = false;
      dev.booted = false;
      dev.processes.clear();
      dev.ctxs.clear();
      for (const port of radioPorts(dev)) fanOper(air.onPortChanged({ device: id, port }, scheduler.now, 'power-off'));
    },

    send(id, port, pdu) {
      const from = { device: id, port };
      const result = air.transmit(from, pdu, scheduler.now);
      transmits.push({ from, pdu, result, at: scheduler.now });
      return result;
    },

    op(id, port, op) {
      const changes = air.mediumOp({ device: id, port }, op, scheduler.now);
      fanOper(changes);
      return changes;
    },

    run(until) {
      for (;;) {
        const t = scheduler.peekTime();
        if (t === undefined || t > until) break;
        const ev = scheduler.next();
        if (ev === undefined) break;
        dispatch(ev);
      }
      if (until > scheduler.now) scheduler.advanceTo(until);
    },

    runFor(ns) {
      world.run(scheduler.now + ns);
    },

    runToIdle(maxEvents = 200_000) {
      let n = 0;
      while (nonPeriodic > 0 && n < maxEvents) {
        const ev = scheduler.next();
        if (ev === undefined) break;
        dispatch(ev);
        n++;
      }
      return n;
    },

    now: () => scheduler.now,
    port: (id, port) => devices.get(id)!.ports.get(port)!,
    ref: (id, port) => ({ device: id, port }),
    daemon: (id, name) => devices.get(id)!.processes.get(name)!,
    ofKind<K extends TraceEvent['kind']>(kind: K) {
      return events.filter((e): e is Extract<TraceEvent, { kind: K }> => e.kind === kind);
    },
  };
  return world;
}

/** The port key of a device port (shorthand for tests). */
export function keyOf(id: DeviceId, port: PortId): string {
  return portKey({ device: id, port });
}
