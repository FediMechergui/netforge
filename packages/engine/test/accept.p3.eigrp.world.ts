/**
 * test/accept.p3.eigrp.world.ts — the §3.12 world of the [C1] EIGRP acceptance rows (`accept.p3.eigrp`,
 * `accept.p3.eigrp-dual`; ARCHITECTURE-P3 §3.12, §10.1, §7 W4 qa). Not a test file. Owner: W4 qa (qa-eigrp-vty).
 *
 * The world is built on `staged.world` at stage P3 (rule 14: the catalog flip is a later step) with the registry the
 * flip writes: every approved P3 daemon's factory is laid over `PROCESS_FACTORIES` (`P3_FLIP_FACTORIES`,
 * `accept.p3.flip-factories.ts`), so the world
 * runs what a flipped P3 world runs (CDP in the P3 profile, the logger, the hidden vty listeners …), and these rows run
 * unchanged against the real catalog once the flip has landed.
 *
 * §3.12 (the routing map's §4.4, corrected): R1, R2, R3 (NF-2911) and R4 (NF-4331, whose third copper gigabit port
 * comes from an NF-NIM-2GE in slot 0/1), every router `router eigrp 100` / `network 10.0.0.0` (classful), K values
 * 1 0 1 0 0, GigE 1 000 000 kb/s and 10 µs:
 *   R1 Gi0/0 10.0.12.1/24 — R2 Gi0/0 10.0.12.2
 *   R1 Gi0/1 10.0.13.1/24 — R3 Gi0/0 10.0.13.3   both ends `bandwidth 100000` / `delay 10` (100 Mb/s, 100 µs)
 *   R2 Gi0/1 10.0.24.2/24 — R4 Gi0/0/0 10.0.24.4
 *   R3 Gi0/1 10.0.34.3/24 — R4 Gi0/0/1 10.0.34.4  (variant 'no-fs': both ends also 100 Mb/s, 100 µs, step 4)
 *   R4 Gi0/1/0 10.4.0.1/24 — PC4 10.4.0.10
 * Variants: 'ecmp' (the R1–R3 link stays GigE: two equal-cost paths at R1); 'switch' (R1 Gi0/0 — SW1 Gi0/1, SW1
 * Gi0/2 — R2 Gi0/0, both switch ports `spanning-tree portfast`: §3.12 step 5's indirect failure). `dhcpUplink` adds
 * the D11 case: R4 Gi0/1/1 `ip address dhcp` from ISP (NF-2911, a DHCP pool with a default router), so R4's table
 * holds a `D*` default at distance 254.
 *
 * Every device boots unconnected (BOOT_NS); the routers are then configured through the grammar exactly as a learner
 * types it (`Simulation.configure`, one call per device, every line must succeed), and only then are the cables
 * added, all at one instant `cabledAt`: link-up is measured from there (§10.1 "Link-up is the linkState up event").
 */
import { expect } from 'vitest';
import type { LinkId } from '../src/contracts/ids.js';
import type { ProcessFactory } from '../src/contracts/process.js';
import type { Simulation } from '../src/contracts/simulation.js';
import type { EigrpNeighborRow, EigrpTopologyRow, RouteRow } from '../src/contracts/tables.js';
import { SEC, type SimTime } from '../src/contracts/time.js';
import type { TraceEvent } from '../src/contracts/trace.js';
import { P3_FLIP_FACTORIES } from './accept.p3.flip-factories.js';
import { createStagedSimulation } from './staged.world.js';

export { P3_FLIP_FACTORIES };

export const R1 = 'r1';
export const R2 = 'r2';
export const R3 = 'r3';
export const R4 = 'r4';
export const PC4 = 'pc4';
export const SW1 = 'sw1';
export const ISP = 'isp';
export const GI0 = 'GigabitEthernet0/0';
export const GI1 = 'GigabitEthernet0/1';
export const R4_TO_R2 = 'GigabitEthernet0/0/0';
export const R4_TO_R3 = 'GigabitEthernet0/0/1';
export const R4_LAN = 'GigabitEthernet0/1/0';
export const R4_UPLINK = 'GigabitEthernet0/1/1';
/** The destination of §3.12. */
export const LAN = '10.4.0.0/24';
/** Every device boots unconnected for this long (a router takes 45 s). */
export const BOOT_NS: SimTime = 60 * SEC;

export type EigrpAcceptVariant = 'fs' | 'no-fs' | 'ecmp' | 'switch';
export type RouterId = typeof R1 | typeof R2 | typeof R3 | typeof R4;

export interface EigrpAcceptOptions {
  readonly variant?: EigrpAcceptVariant;
  readonly seed?: number;
  /** The `router eigrp` lines of a router, replacing `router eigrp 100` / `network 10.0.0.0` (typed in config mode). */
  readonly process?: Partial<Record<RouterId, readonly string[]>>;
  /** More lines typed on a router after its base configuration (config mode). */
  readonly lines?: Partial<Record<RouterId, readonly string[]>>;
  /** R4 Gi0/1/1 leases its address (and a D* default) from ISP's DHCP pool (D11). */
  readonly dhcpUplink?: boolean;
  /** The eigrp daemon's factory (default the real one): a test wrapper for a fault the network cannot make. */
  readonly eigrp?: ProcessFactory;
}

export interface EigrpAcceptWorld {
  readonly sim: Simulation;
  /** When the cables were added (every port of the world comes up at this instant). */
  readonly cabledAt: SimTime;
  /** The trace cursor right before the cables were added (the ports come up inside `addLink`). */
  readonly cursor: number;
  readonly links: {
    /** R1–R2 (the variant 'switch': R1–SW1). */
    readonly r1r2: LinkId;
    readonly r1r3: LinkId;
    readonly r2r4: LinkId;
    readonly r3r4: LinkId;
    readonly r4pc: LinkId;
    /** The variant 'switch': SW1–R2. */
    readonly swR2?: LinkId;
  };
}

const SLOW: readonly string[] = ['bandwidth 100000', 'delay 10'];
const MASK24 = '255.255.255.0';

/** Lines of one routed interface (config mode, back to config mode after). */
function iface(name: string, address: string, extra: readonly string[] = []): string[] {
  return [`interface ${name}`, `ip address ${address} ${MASK24}`, ...extra, 'no shutdown', 'exit'];
}

/** A host's startup configuration. */
function hostConfig(name: string, address: string, gateway: string): string {
  return [`hostname ${name}`, '!', 'interface GigabitEthernet0', ` ip address ${address} ${MASK24}`, '!', `ip default-gateway ${gateway}`, '!', 'end', ''].join('\n');
}

/** Type `lines` on `device` through the grammar (`Simulation.configure`); every line must succeed. */
export function typed(sim: Simulation, device: string, lines: readonly string[]): void {
  const r = sim.configure(device, lines);
  const bad = r.lines.filter((l) => !l.ok).map((l) => `${l.line}: ${l.error?.message ?? (l.skipped === true ? 'skipped' : 'failed')}`);
  expect(bad, `lines refused on ${device}`).toEqual([]);
}

/** The §3.12 world of the file header, booted, configured through the grammar and cabled at `cabledAt` (not run). */
export function eigrpAcceptWorld(opts: EigrpAcceptOptions = {}): EigrpAcceptWorld {
  const variant = opts.variant ?? 'fs';
  const factories = opts.eigrp === undefined ? P3_FLIP_FACTORIES : { ...P3_FLIP_FACTORIES, eigrp: opts.eigrp };
  const sim = createStagedSimulation({ seed: opts.seed ?? 312, stage: 'P3', factories, pduRegistryLimit: 200_000 });
  sim.addDevice({ id: R1, type: 'router.nf2911', name: 'R1' });
  sim.addDevice({ id: R2, type: 'router.nf2911', name: 'R2' });
  sim.addDevice({ id: R3, type: 'router.nf2911', name: 'R3' });
  sim.addDevice({ id: R4, type: 'router.nf4331', name: 'R4', modules: [{ slot: '0/1', module: 'mod.nim-2ge' }] });
  sim.addDevice({ id: PC4, type: 'pc.nfpc', name: 'PC4', startupConfig: hostConfig('PC4', '10.4.0.10', '10.4.0.1') });
  if (variant === 'switch') {
    const portfast = (p: string): string[] => [`interface ${p}`, ' spanning-tree portfast', '!'];
    sim.addDevice({ id: SW1, type: 'switch.nfc2960', name: 'SW1', startupConfig: ['hostname SW1', '!', ...portfast('GigabitEthernet0/1'), ...portfast('GigabitEthernet0/2'), 'end', ''].join('\n') });
  }
  if (opts.dhcpUplink === true) sim.addDevice({ id: ISP, type: 'router.nf2911', name: 'ISP' });
  sim.runFor(BOOT_NS);

  const r13 = variant === 'ecmp' ? [] : SLOW;
  const r34 = variant === 'no-fs' ? SLOW : [];
  const proc = (id: RouterId): string[] => [...(opts.process?.[id] ?? ['router eigrp 100', 'network 10.0.0.0']), 'exit'];
  const extra = (id: RouterId): string[] => [...(opts.lines?.[id] ?? [])];
  typed(sim, R1, ['hostname R1', ...iface(GI0, '10.0.12.1'), ...iface(GI1, '10.0.13.1', r13), ...proc(R1), ...extra(R1)]);
  typed(sim, R2, ['hostname R2', ...iface(GI0, '10.0.12.2'), ...iface(GI1, '10.0.24.2'), ...proc(R2), ...extra(R2)]);
  typed(sim, R3, ['hostname R3', ...iface(GI0, '10.0.13.3', r13), ...iface(GI1, '10.0.34.3', r34), ...proc(R3), ...extra(R3)]);
  const uplink = opts.dhcpUplink === true ? [`interface ${R4_UPLINK}`, 'ip address dhcp', 'no shutdown', 'exit'] : [];
  typed(sim, R4, ['hostname R4', ...iface(R4_TO_R2, '10.0.24.4'), ...iface(R4_TO_R3, '10.0.34.4', r34), ...iface(R4_LAN, '10.4.0.1'), ...uplink, ...proc(R4), ...extra(R4)]);
  if (opts.dhcpUplink === true) {
    typed(sim, ISP, [
      'hostname ISP',
      'ip dhcp excluded-address 192.168.99.1',
      'ip dhcp pool UPLINK',
      'network 192.168.99.0 255.255.255.0',
      'default-router 192.168.99.1',
      'exit',
      'interface GigabitEthernet0/0',
      `ip address 192.168.99.1 ${MASK24}`,
      'no shutdown',
      'exit',
    ]);
  }
  sim.runFor(1 * SEC);

  const cabledAt = sim.now;
  const cursor = sim.trace(0).next;
  const link = (a: string, ap: string, b: string, bp: string): LinkId => sim.addLink({ a: { device: a, port: ap }, b: { device: b, port: bp } });
  let r1r2: LinkId;
  let swR2: LinkId | undefined;
  if (variant === 'switch') {
    r1r2 = link(R1, GI0, SW1, 'GigabitEthernet0/1');
    swR2 = link(SW1, 'GigabitEthernet0/2', R2, GI0);
  } else r1r2 = link(R1, GI0, R2, GI0);
  const r1r3 = link(R1, GI1, R3, GI0);
  const r2r4 = link(R2, GI1, R4, R4_TO_R2);
  const r3r4 = link(R3, GI1, R4, R4_TO_R3);
  const r4pc = link(R4, R4_LAN, PC4, 'GigabitEthernet0');
  if (opts.dhcpUplink === true) link(R4, R4_UPLINK, ISP, GI0);
  return { sim, cabledAt, cursor, links: { r1r2, r1r3, r2r4, r3r4, r4pc, ...(swR2 !== undefined ? { swR2 } : {}) } };
}

// ── readers ──────────────────────────────────────────────────────────────────────────────────────────────────────

export type Created = Extract<TraceEvent, { kind: 'pduCreated' }>;
export type Debug = Extract<TraceEvent, { kind: 'debug' }>;
export type Log = Extract<TraceEvent, { kind: 'log' }>;
export type Write = Extract<TraceEvent, { kind: 'tableWrite' }>;

export function topologyRow(sim: Simulation, device: string, prefix: string): EigrpTopologyRow | undefined {
  return sim.device(device)!.tables.get<EigrpTopologyRow>('eigrp-topology')?.get(prefix);
}

export function neighborRows(sim: Simulation, device: string): EigrpNeighborRow[] {
  return sim.device(device)!.tables.get<EigrpNeighborRow>('eigrp-neighbors')?.rows() ?? [];
}

export function ribRow(sim: Simulation, device: string, key: string): RouteRow | undefined {
  return sim.device(device)!.tables.rib.get(key);
}

/** The EIGRP packets `device` created among `evs`, in order (optionally only those of one flow). */
export function eigrpCreated(evs: readonly TraceEvent[], device: string, flow?: string): Created[] {
  return evs.filter((e): e is Created => e.kind === 'pduCreated' && e.process === 'eigrp' && e.device === device && (flow === undefined || e.pdu.flow === flow));
}

/** The eigrp layer's fields of a PDU. */
export function eigrpFields(sim: Simulation, c: Created): Record<string, unknown> {
  const l = sim.pdu(c.pdu.id)?.layer('eigrp');
  if (l === undefined) throw new Error(`PDU ${c.pdu.id} has no eigrp layer (evicted from the registry?)`);
  return l.fields as Record<string, unknown>;
}

/** The `eigrp-nbr` / `eigrp-route` transitions of a device. */
export function transitions(evs: readonly TraceEvent[], device: string, machine: 'eigrp-nbr' | 'eigrp-route'): { t: SimTime; subject: string; from: string; to: string; cause?: string }[] {
  return evs
    .filter((e): e is Debug => e.kind === 'debug' && e.event.device === device && e.event.fsm?.machine === machine)
    .map((e) => ({ t: e.t, subject: e.event.fsm!.subject, from: e.event.fsm!.from, to: e.event.fsm!.to, ...(e.event.fsm!.cause !== undefined ? { cause: e.event.fsm!.cause } : {}) }));
}

/** The rib writes of `key` on `device`. */
export function ribWrites(evs: readonly TraceEvent[], device: string, key: string): Write[] {
  return evs.filter((e): e is Write => e.kind === 'tableWrite' && e.device === device && e.table === 'rib' && e.key === key);
}

/** The first `operUp` time of a device's port among `evs`. */
export function upAt(evs: readonly TraceEvent[], device: string, port: string): SimTime {
  const e = evs.find((x) => x.kind === 'portState' && x.device === device && x.port === port && x.operUp);
  if (e === undefined) throw new Error(`${device} ${port} never came up`);
  return e.t;
}

/** Events from `cursor` (every one: nothing may have been evicted from the ring). */
export function eventsFrom(sim: Simulation, cursor: number): TraceEvent[] {
  const t = sim.trace(cursor);
  expect(t.dropped, 'the trace ring kept every event').toBe(0);
  return t.events;
}

/** What `line` prints on a fresh privileged console of `device` (opened and closed here). */
export function shown(sim: Simulation, device: string, line: string): string[] {
  const s = sim.cli.open(device, 'console');
  sim.cli.exec(s, 'enable');
  const out = sim.cli.exec(s, line).output;
  sim.cli.close(s);
  return out.split('\n');
}
