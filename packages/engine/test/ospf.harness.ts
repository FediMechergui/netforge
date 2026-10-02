/**
 * test/ospf.harness.ts — shared helpers of the W2 ospf tests (ARCHITECTURE-P3 §7 W2 ospf, §0 rule 13): worlds on
 * `staged.world` at stage P3 with the ospf daemon registered through `factories` (the real registry gains it only at
 * the W4 flip), routers configured through `startupConfig` and `applyConfigLine` (the W1 config rules; no W2 grammar),
 * and readers over the trace (OSPF packets on the wire, `ospf-if` / `ospf-nbr` transitions, debug lines, table rows).
 */
import { expect } from 'vitest';
import type { Ipv4Address } from '../src/contracts/addr.js';
import type { DeviceId, PduId, PortId } from '../src/contracts/ids.js';
import type { FsmTransition } from '../src/contracts/process.js';
import type { Simulation } from '../src/contracts/simulation.js';
import type { OspfInterfaceRow, OspfLsaRow, OspfNeighborRow, OspfStateView, RouteRow } from '../src/contracts/tables.js';
import type { SimTime } from '../src/contracts/time.js';
import type { TraceEvent } from '../src/contracts/trace.js';
import { createOspf } from '../src/protocols/ospf.js';
import { createStagedSimulation } from './staged.world.js';

export const GI0 = 'GigabitEthernet0/0';
export const GI1 = 'GigabitEthernet0/1';
export const SE0 = 'Serial0/0/0';
export const LO0 = 'Loopback0';

/** A P3 world whose routers run the ospf daemon (registered through the `factories` overlay). */
export function ospfWorld(seed = 7): Simulation {
  return createStagedSimulation({ seed, stage: 'P3', factories: { ospf: createOspf } });
}

/** Startup-config text from sections of lines (each section ends with '!'). */
export function startup(sections: readonly (readonly string[])[]): string {
  const out: string[] = [];
  for (const s of sections) out.push(...s, '!');
  out.push('end', '');
  return out.join('\n');
}

/** Add an NF-2911 router `id` named `name` with the given startup sections (hostname first). */
export function addRouter(sim: Simulation, id: DeviceId, name: string, sections: readonly (readonly string[])[]): void {
  sim.addDevice({ id, type: 'router.nf2911', name, startupConfig: startup([[`hostname ${name}`], ...sections]) });
}

/**
 * Store one configuration line through the config rules (rule 13), asserting it was accepted. The device clock is
 * synced to `sim.now` first (an empty `applyActions`, as the facade's own `syncClock` does), so timers the line arms
 * start now.
 */
export function setLine(sim: Simulation, device: DeviceId, context: string[][], line: string[], negate = false): void {
  const dev = sim.device(device)!;
  dev.applyActions('sim', [], sim.now);
  expect(dev.applyConfigLine(context, line, negate)).toEqual({ ok: true });
}

/** `no shutdown` (or `shutdown`) on a port. */
export function adminPort(sim: Simulation, device: DeviceId, port: PortId, up: boolean): void {
  setLine(sim, device, [['interface', port]], ['shutdown'], up);
}

/** The trace events since cursor `from`. */
export function eventsSince(sim: Simulation, from: number): TraceEvent[] {
  return sim.trace(from).events;
}

/** The current trace cursor. */
export function cursor(sim: Simulation): number {
  return sim.trace(0).next;
}

/** An OSPF packet that left a device: its time, port, packet type, destination and summary. */
export interface OspfTx {
  readonly t: SimTime;
  readonly from: DeviceId;
  readonly port: PortId;
  readonly to: DeviceId;
  readonly summary: string;
  readonly kind: 'hello' | 'dbd' | 'lsr' | 'lsu' | 'lsack';
  readonly pdu: PduId;
}

function kindOf(summary: string): OspfTx['kind'] | undefined {
  if (summary.startsWith('OSPF hello')) return 'hello';
  if (summary.startsWith('OSPF database description')) return 'dbd';
  if (summary.startsWith('OSPF link-state request')) return 'lsr';
  if (summary.startsWith('OSPF link-state update')) return 'lsu';
  if (summary.startsWith('OSPF link-state acknowledgement')) return 'lsack';
  return undefined;
}

/** Every `frameTx` of an OSPF packet in `evs` (one per receiver leg), in trace order. */
export function ospfTx(evs: readonly TraceEvent[]): OspfTx[] {
  const out: OspfTx[] = [];
  for (const e of evs) {
    if (e.kind !== 'frameTx') continue;
    const k = kindOf(e.pdu.summary);
    if (k === undefined) continue;
    out.push({ t: e.t, from: e.from.device, port: e.from.port, to: e.to.device, summary: e.pdu.summary, kind: k, pdu: e.pdu.id });
  }
  return out;
}

/** OSPF packets a device created (`pduCreated` by the ospf process), with the IPv4 destination from the flow key. */
export function ospfCreated(evs: readonly TraceEvent[], device?: DeviceId): { t: SimTime; device: DeviceId; kind: OspfTx['kind']; dst: string; summary: string; pdu: PduId }[] {
  const out: { t: SimTime; device: DeviceId; kind: OspfTx['kind']; dst: string; summary: string; pdu: PduId }[] = [];
  for (const e of evs) {
    if (e.kind !== 'pduCreated' || e.process !== 'ospf') continue;
    if (device !== undefined && e.device !== device) continue;
    const k = kindOf(e.pdu.summary.replace(/^IPv4 .*$/, ''));
    const flow = e.pdu.flow ?? '';
    const dst = flow.slice(flow.indexOf('>') + 1, flow.lastIndexOf(':'));
    const tag = e.pdu.tag ?? '';
    const kind = k ?? (tag === 'ospf-hello' ? 'hello' : tag === 'ospf-dbd' ? 'dbd' : tag === 'ospf-lsr' ? 'lsr' : tag === 'ospf-lsu' ? 'lsu' : 'lsack');
    out.push({ t: e.t, device: e.device, kind, dst, summary: e.pdu.summary, pdu: e.pdu.id });
  }
  return out;
}

/** The `ctx.transition` events of `machine` on `device`, in order. */
export function fsmOf(evs: readonly TraceEvent[], device: DeviceId, machine: 'ospf-if' | 'ospf-nbr', subject?: string): (FsmTransition & { t: SimTime })[] {
  const out: (FsmTransition & { t: SimTime })[] = [];
  for (const e of evs) {
    if (e.kind !== 'debug' || e.event.device !== device || e.event.fsm === undefined) continue;
    const f = e.event.fsm;
    if (f.machine !== machine || (subject !== undefined && f.subject !== subject)) continue;
    out.push({ ...f, t: e.t });
  }
  return out;
}

/** Debug lines of `device` in `category`, with their times. */
export function debugLines(evs: readonly TraceEvent[], device: DeviceId, category: string): { t: SimTime; message: string }[] {
  const out: { t: SimTime; message: string }[] = [];
  for (const e of evs) if (e.kind === 'debug' && e.event.device === device && e.event.category === category) out.push({ t: e.t, message: e.event.message });
  return out;
}

/** The time of the first `portState` event with the port oper up (undefined when none). */
export function portUpAt(evs: readonly TraceEvent[], device: DeviceId, port: PortId): SimTime | undefined {
  for (const e of evs) if (e.kind === 'portState' && e.device === device && e.port === port && e.operUp) return e.t;
  return undefined;
}

/** The time of the first `portState` event with the port oper down. */
export function portDownAt(evs: readonly TraceEvent[], device: DeviceId, port: PortId): SimTime | undefined {
  for (const e of evs) if (e.kind === 'portState' && e.device === device && e.port === port && !e.operUp) return e.t;
  return undefined;
}

export function ifRow(sim: Simulation, device: DeviceId, port: PortId): OspfInterfaceRow | undefined {
  return sim.device(device)!.tables.get<OspfInterfaceRow>('ospf-interfaces')?.get(port);
}

export function nbrRows(sim: Simulation, device: DeviceId): OspfNeighborRow[] {
  return sim.device(device)!.tables.get<OspfNeighborRow>('ospf-neighbors')?.rows() ?? [];
}

export function lsdbRows(sim: Simulation, device: DeviceId): OspfLsaRow[] {
  return sim.device(device)!.tables.get<OspfLsaRow>('ospf-lsdb')?.rows() ?? [];
}

export function ospfRoutes(sim: Simulation, device: DeviceId): RouteRow[] {
  return sim.device(device)!.tables.rib.rows().filter((r) => r.source === 'O');
}

export function ribRow(sim: Simulation, device: DeviceId, key: string): RouteRow | undefined {
  return sim.device(device)!.tables.rib.get(key);
}

export function ospfView(sim: Simulation, device: DeviceId): OspfStateView {
  const v = sim.device(device)!.stateSnapshots().find((s) => s.process === 'ospf');
  return v!.state as unknown as OspfStateView;
}

/** `tableWrite` / `tableExpire` events of `table` on `device`. */
export function tableEvents(evs: readonly TraceEvent[], device: DeviceId, table: string): Extract<TraceEvent, { kind: 'tableWrite' | 'tableExpire' }>[] {
  return evs.filter((e): e is Extract<TraceEvent, { kind: 'tableWrite' | 'tableExpire' }> => (e.kind === 'tableWrite' || e.kind === 'tableExpire') && e.device === device && e.table === table);
}

/** The interface sections of a router port: address, OSPF network type, admin state. */
export function iface(port: PortId, address: Ipv4Address, mask: string, extra: readonly string[] = [], up = true): string[] {
  return [`interface ${port}`, ` ip address ${address} ${mask}`, ...extra.map((l) => ` ${l}`), up ? ' no shutdown' : ' shutdown'];
}

export const SEC_NS = 1_000_000_000;
export const MS_NS = 1_000_000;
