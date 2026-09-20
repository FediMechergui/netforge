/**
 * test/ip6.harness.ts — a small world for the IPv6 daemon tests (not a test file).
 *
 * Real device runtimes (device/device.ts) with P1-stage NF-PC and NF-2911 models and a registry holding the real
 * arp, ipv4, icmpv4, host, ipv6, nd and icmpv6 daemons, on one shared scheduler, trace and PDU factory. Links are
 * ideal buses: a frame sent on one end arrives on every other end `delayNs` later (a clone per receiver when there
 * are several), and a bus is up while every end's device is booted and the port is administratively up. The config
 * is applied through `DeviceRuntime.applyConfigLine` (what the CLI and `Simulation.configure` do), after syncing the
 * device clock like the Simulation facade.
 */
import type { PortRef, ProcessName, SessionId } from '../src/contracts/ids.js';
import type { DeviceRuntime, DeviceSpec } from '../src/contracts/device.js';
import type { LinkId } from '../src/contracts/ids.js';
import type { LayerSpec, Pdu, PduMeta } from '../src/contracts/pdu.js';
import type { Action, DebugEvent, Process, ProcessRequest, StateView } from '../src/contracts/process.js';
import type { ProcessEvent } from '../src/contracts/transport.js';
import type { SimTime } from '../src/contracts/time.js';
import { SEC } from '../src/contracts/time.js';
import type { TraceEvent } from '../src/contracts/trace.js';
import type { Scheduler } from '../src/contracts/events.js';
import { createRng } from '../src/core/prng.js';
import { createScheduler } from '../src/core/scheduler.js';
import { createTable } from '../src/core/table.js';
import { createCatalog } from '../src/device/catalog.js';
import { defineModel } from '../src/device/catalog/define.js';
import { createDevice } from '../src/device/device.js';
import { createPduFactory } from '../src/pdu/factory.js';
import { createArp } from '../src/protocols/arp.js';
import { createHost } from '../src/protocols/host.js';
import { createIcmpv4 } from '../src/protocols/icmpv4.js';
import { createIcmpv6 } from '../src/protocols/icmpv6.js';
import { createIpv4 } from '../src/protocols/ipv4.js';
import { createIpv6 } from '../src/protocols/ipv6.js';
import { createNd } from '../src/protocols/nd.js';
import { NF_2911_INPUT, NF_PC_INPUT } from './device.catalog.p0-inputs.js';

/** NF-PC with the P1 daemon list. */
export const P1_PC = defineModel(NF_PC_INPUT, 'P1');
/** NF-2911 with the P1 daemon list. */
export const P1_ROUTER = defineModel(NF_2911_INPUT, 'P1');

/** Daemons of the harness registry (the others of the P1 lists are absent and logged at boot). */
export const IP6_REGISTRY: Record<ProcessName, () => Process> = {
  arp: createArp,
  ipv4: createIpv4,
  icmpv4: createIcmpv4,
  host: createHost,
  ipv6: createIpv6,
  nd: createNd,
  icmpv6: createIcmpv6,
};

/** Long enough for both models to boot. */
export const BOOT_NS: SimTime = 60 * SEC;

/** One bus link. */
export interface Bus {
  id: LinkId;
  ends: PortRef[];
  up: boolean;
}

/** One transmitted frame (what the medium saw). */
export interface Sent {
  t: SimTime;
  from: PortRef;
  pdu: Pdu;
}

export interface World6 {
  readonly scheduler: Scheduler;
  readonly devices: Map<string, DeviceRuntime>;
  readonly events: TraceEvent[];
  readonly sent: Sent[];
  readonly buses: Bus[];
  readonly cli: { session: SessionId; text: string; t: SimTime }[];
  readonly done: { session: SessionId; t: SimTime }[];
  now(): SimTime;
  /** Add a powered device of `kind` ('pc' | 'router'). */
  add(id: string, kind: 'pc' | 'router', name?: string): DeviceRuntime;
  /** Join ports on one bus. */
  link(...ends: PortRef[]): Bus;
  /** Run every event up to `until` (inclusive), then move the clock there. */
  runUntil(until: SimTime): void;
  runFor(dt: SimTime): void;
  /** Apply global config lines ('no …' negates). */
  global(device: string, ...lines: string[]): void;
  /** Apply config lines under `interface <port>`. */
  iface(device: string, port: string, ...lines: string[]): void;
  /** Deliver a request to a daemon of `device` now (as the CLI does). */
  request(device: string, to: ProcessName, req: ProcessRequest): void;
  /** Apply raw actions on behalf of `process`. */
  act(device: string, process: ProcessName, actions: Action[]): void;
  /** Frames sent by `device` (optionally only on `port`). */
  sentBy(device: string, port?: string): Pdu[];
  /** Concatenated CLI output of a session. */
  output(session: SessionId): string;
  /** Trace events of one kind. */
  kinds<K extends TraceEvent['kind']>(kind: K): Extract<TraceEvent, { kind: K }>[];
  /** The device. */
  dev(id: string): DeviceRuntime;
  /** Build a PDU with the shared factory (as a peer device would have). */
  build(layers: readonly LayerSpec[], meta?: Partial<PduMeta>): Pdu;
}

/** A daemon stand-in that records the PDUs, requests and events it receives. */
export interface Recorder extends Process {
  pdus: Pdu[];
  requests: ProcessRequest[];
  evs: ProcessEvent[];
}

/** Build a recorder daemon named `name` (one shared object for every instance). */
export function recorder(name: ProcessName): Recorder {
  const r: Recorder = {
    name,
    pdus: [],
    requests: [],
    evs: [],
    onPdu(_ctx, pdu): Action[] {
      r.pdus.push(pdu);
      return [{ type: 'consume', pdu }];
    },
    onTimer(): Action[] {
      return [];
    },
    onConfig(): Action[] {
      return [];
    },
    onRequest(_ctx, req): Action[] {
      r.requests.push(req);
      return [];
    },
    onEvent(_ctx, ev): Action[] {
      r.evs.push(ev);
      return [];
    },
    stateSnapshot(): StateView {
      return { process: name, state: {} };
    },
    debugEvents(): readonly DebugEvent[] {
      return [];
    },
  };
  return r;
}

/** Split a config line into tokens and a negation flag. */
function tokens(line: string): { negate: boolean; toks: string[] } {
  const toks = line.trim().split(/\s+/);
  if (toks[0] === 'no') return { negate: true, toks: toks.slice(1) };
  return { negate: false, toks };
}

/** Build a world. `delayNs` is the one-way bus latency; `lose` silently loses a transmitted frame (still in `sent`). */
export function createWorld6(opts: { seed?: number; delayNs?: SimTime; extra?: Record<ProcessName, () => Process>; lose?: (s: Sent) => boolean } = {}): World6 {
  const seed = opts.seed ?? 1;
  const delayNs = opts.delayNs ?? 10_000;
  const scheduler = createScheduler();
  const events: TraceEvent[] = [];
  const sink = { emit: (ev: TraceEvent) => void events.push(ev) };
  const pdus = createPduFactory();
  const root = createRng(seed);
  const catalog = createCatalog({ ...IP6_REGISTRY, ...(opts.extra ?? {}) }, { models: [P1_PC, P1_ROUTER], modules: [], stage: 'P1' });
  const devices = new Map<string, DeviceRuntime>();
  const buses: Bus[] = [];
  const sent: Sent[] = [];
  const cli: World6['cli'] = [];
  const done: World6['done'] = [];
  let nextBus = 1;

  const busOf = (ref: PortRef): Bus | undefined => buses.find((b) => b.ends.some((e) => e.device === ref.device && e.port === ref.port));

  function wantUp(b: Bus): boolean {
    return b.ends.every((e) => {
      const d = devices.get(e.device);
      const p = d?.port(e.port);
      return d !== undefined && d.power && d.bootedAt !== undefined && p !== undefined && p.adminUp;
    });
  }

  function recompute(b: Bus, now: SimTime): void {
    const up = wantUp(b);
    if (up === b.up) return;
    b.up = up;
    scheduler.schedule(now, { kind: 'linkState', link: b.id, up });
  }

  function add(id: string, kind: 'pc' | 'router', name?: string): DeviceRuntime {
    const spec: DeviceSpec = {
      id,
      type: kind === 'pc' ? P1_PC.type : P1_ROUTER.type,
      name: name ?? id.toUpperCase(),
      position: { x: 0, y: 0 },
      power: true,
      modules: [],
      macSalt: 0,
    };
    const device = createDevice(
      spec,
      {
        scheduler,
        trace: sink,
        rng: root.split(`device:${id}`),
        pdus,
        catalog,
        tables: createTable,
        transmit: (from, pdu, now) => {
          const b = busOf(from);
          if (b === undefined || !b.up) {
            events.push({ t: now, kind: 'drop', pdu: { id: pdu.id, proto: pdu.topProto(), size: pdu.size, summary: pdu.summary() }, reason: 'link-down', device: from.device, port: from.port } as TraceEvent);
            return { ok: false, reason: 'link-down' };
          }
          sent.push({ t: now, from, pdu });
          if (opts.lose?.({ t: now, from, pdu }) === true) return { ok: true, link: b.id, txStart: now, txEnd: now + 1_000, arrive: now + delayNs };
          const receivers = b.ends.filter((e) => !(e.device === from.device && e.port === from.port));
          for (const r of receivers) {
            const copy = receivers.length > 1 ? pdus.clone(pdu, now) : pdu;
            scheduler.schedule(now + delayNs, { kind: 'frameArrival', device: r.device, port: r.port, pdu: copy });
          }
          return { ok: true, link: b.id, txStart: now, txEnd: now + 1_000, arrive: now + delayNs };
        },
        onPortAdmin: (ref, _adminUp, now) => {
          const b = busOf(ref);
          if (b !== undefined) recompute(b, now);
        },
        onPortPhyConfig: () => undefined,
        mediumOp: () => undefined,
        airView: () => ({ visibleBss: () => [], link: () => undefined }),
        cliSink: {
          output: (session, text, now) => void cli.push({ session, text, t: now }),
          done: (session, now) => void done.push({ session, t: now }),
        },
      },
      scheduler.now,
    );
    devices.set(id, device);
    return device;
  }

  function dispatch(): boolean {
    const ev = scheduler.next();
    if (ev === undefined) return false;
    switch (ev.kind) {
      case 'boot': {
        const d = devices.get(ev.device);
        d?.onBoot(ev.at);
        for (const b of buses) if (b.ends.some((e) => e.device === ev.device)) recompute(b, ev.at);
        break;
      }
      case 'timer':
        devices.get(ev.device)?.onTimer(ev.process, ev.key, ev.at);
        break;
      case 'frameArrival':
        devices.get(ev.device)?.onFrameArrival(ev.port, ev.pdu, false, ev.at);
        break;
      case 'linkState': {
        const b = buses.find((x) => x.id === ev.link);
        if (b === undefined || b.up !== ev.up) break;
        for (const e of b.ends) {
          const d = devices.get(e.device);
          const p = d?.port(e.port);
          if (d === undefined || p === undefined) continue;
          p.operUp = ev.up;
          p.lastChange = ev.at;
          d.onPortOper(e.port, ev.up, ev.at);
        }
        break;
      }
      default:
        break;
    }
    return true;
  }

  function runUntil(until: SimTime): void {
    for (;;) {
      const t = scheduler.peekTime();
      if (t === undefined || t > until) break;
      dispatch();
    }
    if (scheduler.now < until) scheduler.advanceTo(until);
  }

  function dev(id: string): DeviceRuntime {
    const d = devices.get(id);
    if (d === undefined) throw new Error(`no device ${id}`);
    return d;
  }

  function apply(device: string, context: string[][], line: string): void {
    const d = dev(device);
    d.applyActions('cli', [], scheduler.now);
    const { negate, toks } = tokens(line);
    const r = d.applyConfigLine(context, toks, negate);
    if (!r.ok) throw new Error(`${line} on ${device}: ${r.error ?? 'failed'}`);
  }

  return {
    scheduler,
    devices,
    events,
    sent,
    buses,
    cli,
    done,
    now: () => scheduler.now,
    add,
    link(...ends: PortRef[]): Bus {
      const b: Bus = { id: `l_${nextBus++}`, ends, up: false };
      buses.push(b);
      recompute(b, scheduler.now);
      return b;
    },
    runUntil,
    runFor(dt: SimTime): void {
      runUntil(scheduler.now + dt);
    },
    global(device: string, ...lines: string[]): void {
      for (const l of lines) apply(device, [], l);
    },
    iface(device: string, port: string, ...lines: string[]): void {
      for (const l of lines) apply(device, [['interface', port]], l);
    },
    request(device: string, to: ProcessName, req: ProcessRequest): void {
      dev(device).applyActions('cli', [{ type: 'request', to, req }], scheduler.now);
    },
    act(device: string, process: ProcessName, actions: Action[]): void {
      dev(device).applyActions(process, actions, scheduler.now);
    },
    sentBy(device: string, port?: string): Pdu[] {
      return sent.filter((s) => s.from.device === device && (port === undefined || s.from.port === port)).map((s) => s.pdu);
    },
    output(session: SessionId): string {
      return cli.filter((c) => c.session === session).map((c) => c.text).join('');
    },
    kinds<K extends TraceEvent['kind']>(kind: K): Extract<TraceEvent, { kind: K }>[] {
      return events.filter((e): e is Extract<TraceEvent, { kind: K }> => e.kind === kind);
    },
    dev,
    build(layers: readonly LayerSpec[], meta?: Partial<PduMeta>): Pdu {
      return pdus.build(layers, { born: scheduler.now, origin: 'd_peer', ...(meta ?? {}) });
    },
  };
}

/** The ICMPv6 layer of a frame, if any (first one). */
export function icmp6Of(pdu: Pdu): Record<string, unknown> | undefined {
  return pdu.layer('icmpv6')?.fields as Record<string, unknown> | undefined;
}

/** Frames whose first ICMPv6 layer has `type`. */
export function ofIcmp6Type(pdus: readonly Pdu[], type: number): Pdu[] {
  return pdus.filter((p) => icmp6Of(p)?.type === type);
}
