/**
 * test/eigrp.world.ts — the §3.12 EIGRP world on `staged.world` (ARCHITECTURE-P3 §3.12, rule 13; §7 W2 eigrp [C1]),
 * shared by `eigrp.adjacency.test.ts` and `eigrp.routes.test.ts`. Owner: eigrp.
 *
 * R1, R2, R3 (NF-2911) and R4 (NF-4451, four copper gigabit ports), every router `router eigrp 100` / `network
 * 10.0.0.0` (classful), K values 1 0 1 0 0, GigE 1 000 000 kb/s and 10 µs:
 *   R1 Gi0/0 10.0.12.1/24 — R2 Gi0/0 10.0.12.2
 *   R1 Gi0/1 10.0.13.1/24 — R3 Gi0/0 10.0.13.3   both ends `bandwidth 100000` / `delay 10` (100 Mb/s, 100 µs)
 *   R2 Gi0/1 10.0.24.2/24 — R4 Gi0/0/0 10.0.24.4
 *   R3 Gi0/1 10.0.34.3/24 — R4 Gi0/0/1 10.0.34.4  (variant 'no-fs': both ends also 100 Mb/s, 100 µs)
 *   R4 Gi0/0/2 10.4.0.1/24 — PC4 10.4.0.10
 * Variant 'ecmp': the R1–R3 link stays GigE, so 10.4.0.0/24 has two equal-cost paths at R1.
 * The configuration goes in through `startupConfig` (rule 13: the W1 config rules, not the W2 grammar). The daemon
 * under test is registered through the registry overlay (`factories: {eigrp: createEigrp}`); `factories` can lay a
 * wrapper over it.
 */
import type { LinkId } from '../src/contracts/ids.js';
import type { Process, ProcessFactory } from '../src/contracts/process.js';
import type { Simulation } from '../src/contracts/simulation.js';
import type { EigrpNeighborRow, EigrpTopologyRow, RouteRow } from '../src/contracts/tables.js';
import type { TraceEvent } from '../src/contracts/trace.js';
import { createEigrp } from '../src/protocols/eigrp.js';
import { createStagedSimulation } from './staged.world.js';

export const R1 = 'r1';
export const R2 = 'r2';
export const R3 = 'r3';
export const R4 = 'r4';
export const PC4 = 'pc4';
export const GI0 = 'GigabitEthernet0/0';
export const GI1 = 'GigabitEthernet0/1';
export const R4_TO_R2 = 'GigabitEthernet0/0/0';
export const R4_TO_R3 = 'GigabitEthernet0/0/1';
export const R4_LAN = 'GigabitEthernet0/0/2';
export const LAN = '10.4.0.0/24';

/** A startup configuration from sections (each a list of lines, the first one the section head). */
export function startup(sections: readonly (readonly string[])[]): string {
  const out: string[] = [];
  for (const s of sections) out.push(...s, '!');
  out.push('end', '');
  return out.join('\n');
}

const iface = (name: string, address: string, extra: readonly string[] = []): string[] => [
  `interface ${name}`,
  ` ip address ${address} 255.255.255.0`,
  ...extra.map((l) => ` ${l}`),
  ' no shutdown',
];

export type EigrpVariant = 'fs' | 'no-fs' | 'ecmp';

export interface EigrpWorldOptions {
  readonly variant?: EigrpVariant;
  readonly seed?: number;
  /** Extra lines per device id, appended as sections (`[['router eigrp 100', ' maximum-paths 1']]`). */
  readonly extra?: Readonly<Record<string, readonly (readonly string[])[]>>;
  /** Replace a device's `router eigrp` section entirely (e.g. another AS, or other K values). */
  readonly process?: Readonly<Record<string, readonly string[]>>;
  /** Registry overlay entries laid over `{eigrp: createEigrp}` (a wrapper on one device type is not possible: the
   * factory is per daemon, so a wrapper applies to every router; see `perDevice`). */
  readonly factory?: ProcessFactory;
  /** Do not run to idle after building (the caller drives the clock). */
  readonly noRun?: boolean;
}

export interface EigrpWorld {
  readonly sim: Simulation;
  readonly links: { r1r2: LinkId; r1r3: LinkId; r2r4: LinkId; r3r4: LinkId; r4pc: LinkId };
}

const SLOW = ['bandwidth 100000', 'delay 10'];

/** The §3.12 world; `runToIdle` unless `noRun`. */
export function eigrpWorld(opts: EigrpWorldOptions = {}): EigrpWorld {
  const variant = opts.variant ?? 'fs';
  const sim = createStagedSimulation({ seed: opts.seed ?? 31, stage: 'P3', factories: { eigrp: opts.factory ?? createEigrp } });
  const proc = (id: string): string[] => [...(opts.process?.[id] ?? ['router eigrp 100', ' network 10.0.0.0'])];
  const r13 = variant === 'ecmp' ? [] : SLOW;
  const r34 = variant === 'no-fs' ? SLOW : [];
  const cfg = (id: string, name: string, sections: string[][]): string =>
    startup([[`hostname ${name}`], ...sections, proc(id), ...((opts.extra?.[id] ?? []).map((s) => [...s]))]);
  sim.addDevice({ id: R1, type: 'router.nf2911', name: 'R1', startupConfig: cfg(R1, 'R1', [iface(GI0, '10.0.12.1'), iface(GI1, '10.0.13.1', r13)]) });
  sim.addDevice({ id: R2, type: 'router.nf2911', name: 'R2', startupConfig: cfg(R2, 'R2', [iface(GI0, '10.0.12.2'), iface(GI1, '10.0.24.2')]) });
  sim.addDevice({ id: R3, type: 'router.nf2911', name: 'R3', startupConfig: cfg(R3, 'R3', [iface(GI0, '10.0.13.3', r13), iface(GI1, '10.0.34.3', r34)]) });
  sim.addDevice({
    id: R4,
    type: 'router.nf4451',
    name: 'R4',
    startupConfig: cfg(R4, 'R4', [iface(R4_TO_R2, '10.0.24.4'), iface(R4_TO_R3, '10.0.34.4', r34), iface(R4_LAN, '10.4.0.1')]),
  });
  sim.addDevice({
    id: PC4,
    type: 'pc.nfpc',
    name: 'PC4',
    startupConfig: startup([['hostname PC4'], ['interface GigabitEthernet0', ' ip address 10.4.0.10 255.255.255.0'], ['ip default-gateway 10.4.0.1']]),
  });
  const links = {
    r1r2: sim.addLink({ a: { device: R1, port: GI0 }, b: { device: R2, port: GI0 } }),
    r1r3: sim.addLink({ a: { device: R1, port: GI1 }, b: { device: R3, port: GI0 } }),
    r2r4: sim.addLink({ a: { device: R2, port: GI1 }, b: { device: R4, port: R4_TO_R2 } }),
    r3r4: sim.addLink({ a: { device: R3, port: GI1 }, b: { device: R4, port: R4_TO_R3 } }),
    r4pc: sim.addLink({ a: { device: R4, port: R4_LAN }, b: { device: PC4, port: 'GigabitEthernet0' } }),
  };
  if (opts.noRun !== true) sim.runToIdle();
  return { sim, links };
}

// ── readers ──────────────────────────────────────────────────────────────────────────────────────────────────────

export function topologyRow(sim: Simulation, device: string, prefix: string): EigrpTopologyRow | undefined {
  return sim.device(device)!.tables.get<EigrpTopologyRow>('eigrp-topology')?.get(prefix);
}

export function neighborRows(sim: Simulation, device: string): EigrpNeighborRow[] {
  return sim.device(device)!.tables.get<EigrpNeighborRow>('eigrp-neighbors')?.rows() ?? [];
}

export function ribRow(sim: Simulation, device: string, key: string): RouteRow | undefined {
  return sim.device(device)!.tables.rib.get(key);
}

/** Events of `fn` and what follows it (`runToIdle`, or `runFor(ns)`). */
export function during(sim: Simulation, fn: () => void, runNs?: number): TraceEvent[] {
  const cursor = sim.trace(0).next;
  fn();
  if (runNs === undefined) sim.runToIdle();
  else sim.runFor(runNs);
  return sim.trace(cursor).events;
}

export type Created = Extract<TraceEvent, { kind: 'pduCreated' }>;
export type Debug = Extract<TraceEvent, { kind: 'debug' }>;

/** EIGRP packets a device created, in order. */
export function eigrpCreated(evs: readonly TraceEvent[], device?: string): Created[] {
  return evs.filter((e): e is Created => e.kind === 'pduCreated' && e.process === 'eigrp' && (device === undefined || e.device === device));
}

/** The `eigrp-nbr` / `eigrp-route` transitions of a device. */
export function transitions(evs: readonly TraceEvent[], device: string, machine: 'eigrp-nbr' | 'eigrp-route'): { t: number; subject: string; from: string; to: string; cause?: string }[] {
  return evs
    .filter((e): e is Debug => e.kind === 'debug' && e.event.device === device && e.event.fsm?.machine === machine)
    .map((e) => ({ t: e.t, subject: e.event.fsm!.subject, from: e.event.fsm!.from, to: e.event.fsm!.to, ...(e.event.fsm!.cause !== undefined ? { cause: e.event.fsm!.cause } : {}) }));
}

/** A process wrapper: `onPdu` goes through `filter` first (return undefined to pass the PDU on). */
export function wrapEigrp(filter: (inner: Process, ...args: Parameters<Process['onPdu']>) => ReturnType<Process['onPdu']> | undefined): ProcessFactory {
  return () => {
    const inner = createEigrp();
    return {
      ...inner,
      name: inner.name,
      onPdu: (ctx, pdu, port) => filter(inner, ctx, pdu, port) ?? inner.onPdu(ctx, pdu, port),
      stateSnapshot: () => inner.stateSnapshot(),
      debugEvents: () => inner.debugEvents(),
    };
  };
}
