/**
 * Shared harness for the device runtime tests: fake processes that record every call and
 * return scripted actions, a fake transmit, a fake CLI sink, and a real scheduler / rng /
 * tables / pdu factory. Not a test file itself (vitest only picks up `*.test.ts`).
 */
import { createCatalog } from '../src/device/catalog.js';
import { createDevice } from '../src/device/device.js';
import { createRng } from '../src/core/prng.js';
import { createScheduler } from '../src/core/scheduler.js';
import { createTable } from '../src/core/table.js';
import { createPduFactory } from '../src/pdu/factory.js';
import type { ModuleInstall } from '../src/contracts/catalog.js';
import type { ConfigDelta } from '../src/contracts/config.js';
import type { DeviceRuntime, DeviceSpec } from '../src/contracts/device.js';
import type { AirView, MediumEvent, MediumOp } from '../src/contracts/medium.js';
import type { PortId, PortRef, ProcessName, SessionId } from '../src/contracts/ids.js';
import type { TransmitResult } from '../src/contracts/link.js';
import type { LayerSpec, Pdu, PduMeta } from '../src/contracts/pdu.js';
import { ARP_OP_REQUEST, ETHERTYPE_ARP, ETHERTYPE_IPV4, ICMP_ECHO_REQUEST, IPPROTO_ICMP } from '../src/contracts/pdu.js';
import type { Action, DebugEvent, DemuxSelector, Process, ProcessCtx, ProcessRequest, StateView } from '../src/contracts/process.js';
import type { SimTime } from '../src/contracts/time.js';
import type { TraceEvent } from '../src/contracts/trace.js';

export const MAC_A = '00:1f:00:00:00:aa';
export const MAC_B = '00:1f:00:00:00:bb';

/** One recorded handler invocation. */
export interface Call {
  kind: 'init' | 'onPdu' | 'onTimer' | 'onConfig' | 'onLinkChange' | 'onRequest' | 'onEgress' | 'onMediumEvent';
  pdu?: Pdu;
  port?: PortId;
  key?: string;
  delta?: ConfigDelta;
  up?: boolean;
  req?: ProcessRequest;
  ev?: MediumEvent;
  at: SimTime;
}

/** Scripted responses a fake process returns from each handler. */
export interface FakeScript {
  handles?: readonly DemuxSelector[];
  init?: (ctx: ProcessCtx) => Action[];
  onPdu?: (ctx: ProcessCtx, pdu: Pdu, port: PortId) => Action[];
  onTimer?: (ctx: ProcessCtx, key: string) => Action[];
  onConfig?: (ctx: ProcessCtx, delta: ConfigDelta) => Action[];
  onLinkChange?: (ctx: ProcessCtx, port: PortId, up: boolean) => Action[];
  onRequest?: (ctx: ProcessCtx, req: ProcessRequest) => Action[];
  /** When given, the fake implements `Process.onEgress` (owner egress). */
  onEgress?: (ctx: ProcessCtx, pdu: Pdu, port: PortId) => Action[];
  /** When given, the fake implements `Process.onMediumEvent`. */
  onMediumEvent?: (ctx: ProcessCtx, port: PortId, ev: MediumEvent) => Action[];
}

/** A fake process recording calls and the ctx it was given; `factory` hands out this same object. */
export interface FakeProcess extends Process {
  calls: Call[];
  ctx?: ProcessCtx;
  /** How many times `factory` was invoked (one per boot). */
  instances: number;
  factory: () => Process;
}

/** Build a fake process; the one object is shared by every instance for easy assertions. */
export function fakeProcess(name: ProcessName, script: FakeScript = {}): FakeProcess {
  const calls: Call[] = [];
  const fake: FakeProcess = {
    name,
    calls,
    instances: 0,
    factory: () => {
      fake.instances++;
      return fake;
    },
    handles: script.handles,
    init(ctx) {
      fake.ctx = ctx;
      calls.push({ kind: 'init', at: ctx.now });
      return script.init ? script.init(ctx) : [];
    },
    onPdu(ctx, pdu, port) {
      fake.ctx = ctx;
      calls.push({ kind: 'onPdu', pdu, port, at: ctx.now });
      return script.onPdu ? script.onPdu(ctx, pdu, port) : [];
    },
    onTimer(ctx, key) {
      fake.ctx = ctx;
      calls.push({ kind: 'onTimer', key, at: ctx.now });
      return script.onTimer ? script.onTimer(ctx, key) : [];
    },
    onConfig(ctx, delta) {
      fake.ctx = ctx;
      calls.push({ kind: 'onConfig', delta, at: ctx.now });
      return script.onConfig ? script.onConfig(ctx, delta) : [];
    },
    onLinkChange(ctx, port, up) {
      fake.ctx = ctx;
      calls.push({ kind: 'onLinkChange', port, up, at: ctx.now });
      return script.onLinkChange ? script.onLinkChange(ctx, port, up) : [];
    },
    onRequest(ctx, req) {
      fake.ctx = ctx;
      calls.push({ kind: 'onRequest', req, at: ctx.now });
      return script.onRequest ? script.onRequest(ctx, req) : [];
    },
    stateSnapshot(): StateView {
      return { process: name, state: { calls: calls.length } };
    },
    debugEvents(): readonly DebugEvent[] {
      return [];
    },
  };
  const egress = script.onEgress;
  if (egress !== undefined) {
    fake.onEgress = (ctx, pdu, port) => {
      fake.ctx = ctx;
      calls.push({ kind: 'onEgress', pdu, port, at: ctx.now });
      return egress(ctx, pdu, port);
    };
  }
  const medium = script.onMediumEvent;
  if (medium !== undefined) {
    fake.onMediumEvent = (ctx, port, ev) => {
      fake.ctx = ctx;
      calls.push({ kind: 'onMediumEvent', port, ev, at: ctx.now });
      return medium(ctx, port, ev);
    };
  }
  return fake;
}

export interface Harness {
  device: DeviceRuntime;
  events: TraceEvent[];
  scheduler: ReturnType<typeof createScheduler>;
  pdus: ReturnType<typeof createPduFactory>;
  transmits: { from: PortRef; pdu: Pdu; now: SimTime }[];
  adminCalls: { ref: PortRef; adminUp: boolean; now: SimTime }[];
  /** `deps.onPortPhyConfig` calls. */
  phyCalls: { ref: PortRef; now: SimTime }[];
  /** `deps.mediumOp` calls (only recorded when `HarnessOptions.mediumOps` is not false). */
  mediumOps: { from: PortRef; op: MediumOp; now: SimTime }[];
  cli: { output: { session: SessionId; text: string; now: SimTime }[]; done: { session: SessionId; now: SimTime }[] };
  /** Set what the fake transmit returns (default ok). */
  setTransmit(fn: (from: PortRef, pdu: Pdu, now: SimTime) => TransmitResult): void;
  kinds(kind: TraceEvent['kind']): TraceEvent[];
  /** Run the scheduler until empty or until an event later than `until`, dispatching boot/timer to the device. */
  run(until?: SimTime): number;
}

export interface HarnessOptions {
  type?: string;
  name?: string;
  power?: boolean;
  startupConfig?: string;
  processes?: Record<ProcessName, () => Process>;
  id?: string;
  now?: SimTime;
  /** `DeviceSpec.modules`. */
  modules?: readonly ModuleInstall[];
  /** `DeviceSpec.macSalt`. */
  macSalt?: number;
  /** `DeviceRuntimeDeps.airView` (default: a radio hears nothing). */
  airView?: (device: string) => AirView;
}

/** Create a device with fake dependencies. */
export function harness(opts: HarnessOptions = {}): Harness {
  const events: TraceEvent[] = [];
  const scheduler = createScheduler();
  const pdus = createPduFactory();
  const transmits: Harness['transmits'] = [];
  const adminCalls: Harness['adminCalls'] = [];
  const phyCalls: Harness['phyCalls'] = [];
  const mediumOps: Harness['mediumOps'] = [];
  const cli: Harness['cli'] = { output: [], done: [] };
  let transmitFn: (from: PortRef, pdu: Pdu, now: SimTime) => TransmitResult = (_f, _p, now) => ({
    ok: true, link: 'l_1', txStart: now, txEnd: now + 1000, arrive: now + 2000,
  });
  const catalog = createCatalog(opts.processes ?? {});
  const spec: DeviceSpec = {
    id: opts.id ?? 'd_1',
    type: opts.type ?? 'pc.nfpc',
    name: opts.name ?? 'PC1',
    position: { x: 0, y: 0 },
    power: opts.power ?? true,
    ...(opts.startupConfig !== undefined ? { startupConfig: opts.startupConfig } : {}),
    modules: opts.modules ?? [],
    macSalt: opts.macSalt ?? 0,
  };
  const device = createDevice(
    spec,
    {
      scheduler,
      trace: { emit: (ev) => events.push(ev) },
      rng: createRng(42).split(`device:${spec.id}`),
      pdus,
      catalog,
      tables: createTable,
      transmit: (from, pdu, now) => {
        transmits.push({ from, pdu, now });
        return transmitFn(from, pdu, now);
      },
      onPortAdmin: (ref, adminUp, now) => adminCalls.push({ ref, adminUp, now }),
      onPortPhyConfig: (ref, now) => phyCalls.push({ ref, now }),
      mediumOp: (from: PortRef, op: MediumOp, now: SimTime) => mediumOps.push({ from, op, now }),
      airView: opts.airView ?? (() => ({ visibleBss: () => [], link: () => undefined })),
      cliSink: {
        output: (session, text, now) => cli.output.push({ session, text, now }),
        done: (session, now) => cli.done.push({ session, now }),
      },
    },
    opts.now ?? 0,
  );
  return {
    device, events, scheduler, pdus, transmits, adminCalls, phyCalls, mediumOps, cli,
    setTransmit(fn) {
      transmitFn = fn;
    },
    kinds(kind) {
      return events.filter((e) => e.kind === kind);
    },
    run(until = Number.MAX_SAFE_INTEGER) {
      let n = 0;
      for (;;) {
        const t = scheduler.peekTime();
        if (t === undefined || t > until) break;
        const ev = scheduler.next();
        if (ev === undefined) break;
        n++;
        if (ev.kind === 'boot') device.onBoot(ev.at);
        else if (ev.kind === 'timer') device.onTimer(ev.process, ev.key, ev.at);
      }
      return n;
    },
  };
}

/** Boot a powered device by dispatching the earliest pending event (its `boot`). */
export function boot(h: Harness): void {
  const t = h.scheduler.peekTime();
  if (t !== undefined) h.run(t);
}

const meta = (over: Partial<PduMeta> = {}): PduMeta => ({ born: 0, origin: 'd_peer', ...over });

/** Build an ARP request frame from `src` to broadcast. */
export function arpFrame(h: Harness, src = MAC_A): Pdu {
  const layers: LayerSpec[] = [
    { proto: 'ethernet', fields: { dst: 'ff:ff:ff:ff:ff:ff', src, type: ETHERTYPE_ARP } },
    { proto: 'arp', fields: { op: ARP_OP_REQUEST, sha: src, spa: '10.0.0.1', tha: '00:00:00:00:00:00', tpa: '10.0.0.2' } },
  ];
  return h.pdus.build(layers, meta());
}

/** Build an ICMP echo request frame addressed to `dst`. */
export function echoFrame(h: Harness, dst: string, src = MAC_A, payloadLen = 56): Pdu {
  const layers: LayerSpec[] = [
    { proto: 'ethernet', fields: { dst, src, type: ETHERTYPE_IPV4 } },
    { proto: 'ipv4', fields: { src: '10.0.0.1', dst: '10.0.0.2', protocol: IPPROTO_ICMP, ttl: 128 } },
    { proto: 'icmpv4', fields: { type: ICMP_ECHO_REQUEST, code: 0, id: 1, seq: 1 } },
    { proto: 'payload', fields: { data: new Uint8Array(payloadLen).fill(0xab) } },
  ];
  return h.pdus.build(layers, meta());
}

/** Build a frame with an ethertype nobody handles. */
export function unknownFrame(h: Harness, dst: string): Pdu {
  const layers: LayerSpec[] = [
    { proto: 'ethernet', fields: { dst, src: MAC_A, type: 0x88b5 } },
    { proto: 'payload', fields: { data: new Uint8Array(50).fill(1) } },
  ];
  return h.pdus.build(layers, meta());
}
