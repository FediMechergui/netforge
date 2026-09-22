/**
 * test/stp.harness.ts — shared helpers of the W3 stp tests (stp.pvst, stp.rstp, stp.mixed, stp.guards, stp.tc,
 * stp.instances): real P2-profile worlds on `test/p2.world.ts` (§0 rule 13) with the W2 eth-switch, the real `vlan`
 * daemon and the stp factory. Not a test file itself.
 */
import type { PortId } from '../src/contracts/ids.js';
import type { Simulation } from '../src/contracts/simulation.js';
import type { StpBridgeRow, StpPortRow } from '../src/contracts/tables.js';
import { stpKey, vlanKey } from '../src/contracts/tables.js';
import { SEC } from '../src/contracts/time.js';
import type { TraceEvent } from '../src/contracts/trace.js';
import { createStp } from '../src/protocols/stp.js';
import { createVlan } from '../src/protocols/vlan.js';
import { configText, section } from '../src/sim/scenarios/kit.js';
import { pcConfig } from '../src/sim/scenarios/templates.js';
import { createP2Simulation, type P2FactoryOverlay } from './p2.world.js';

export { section };

export const SWITCH = 'switch.nfc2960';
export const MLS = 'mlswitch.nfc9300-48';
export const PC = 'pc.nfpc';
export const GI1: PortId = 'GigabitEthernet0/1';
export const GI2: PortId = 'GigabitEthernet0/2';
export const FA1: PortId = 'FastEthernet0/1';
export const FA2: PortId = 'FastEthernet0/2';
/** NF-C2960 boot time (switches category). */
export const SWITCH_BOOT = 30 * SEC;

/** The default factory overlay: the real vlan daemon and the stp daemon under test. */
export const STP_FACTORIES: P2FactoryOverlay = { vlan: createVlan, stp: createStp };

/** A fresh P2-profile world with the stp and vlan daemons. */
export function stpWorld(seed = 7, profile: 'P1' | 'P2' = 'P2', factories: P2FactoryOverlay = STP_FACTORIES): Simulation {
  return createP2Simulation({ seed, profile, factories });
}

/** Startup config of a switch: hostname plus global lines and interface sections. */
export function switchConfig(hostname: string, globals: readonly string[] = [], sections: readonly (readonly string[])[] = []): string {
  return configText([[`hostname ${hostname}`], ...globals.map((g) => [g]), ...sections]);
}

export interface TriangleOptions {
  /** Global lines added to every switch (after the hostname). */
  readonly all?: readonly string[];
  /** Global lines per switch id. */
  readonly globals?: Partial<Record<'sw1' | 'sw2' | 'sw3', readonly string[]>>;
  /** Interface sections per switch id. */
  readonly sections?: Partial<Record<'sw1' | 'sw2' | 'sw3', readonly (readonly string[])[]>>;
  /** Switch model type (default NF-C2960). */
  readonly type?: string;
  /** Add one PC per switch on FastEthernet0/1 (default true). */
  readonly pcs?: boolean;
}

export interface Triangle {
  readonly sim: Simulation;
  /** Link ids: `sw1sw2`, `sw1sw3`, `sw2sw3`. */
  readonly links: { readonly sw1sw2: string; readonly sw1sw3: string; readonly sw2sw3: string };
}

/**
 * The §3.6 triangle: SW1–SW2 (Gi0/1–Gi0/1), SW1–SW3 (Gi0/2–Gi0/1), SW2–SW3 (Gi0/2–Gi0/2), all 1 Gb; SW1 has
 * `spanning-tree vlan 1 priority 4096`; one PC per switch on Fa0/1 (10.0.0.1–3/24). Nothing has run yet.
 */
export function triangle(sim: Simulation, opts: TriangleOptions = {}): Triangle {
  const type = opts.type ?? SWITCH;
  const all = opts.all ?? [];
  const cfg = (id: 'sw1' | 'sw2' | 'sw3', name: string, extra: readonly string[] = []): string =>
    switchConfig(name, [...all, ...extra, ...(opts.globals?.[id] ?? [])], opts.sections?.[id] ?? []);
  sim.addDevice({ id: 'sw1', type, name: 'SW1', startupConfig: cfg('sw1', 'SW1', ['spanning-tree vlan 1 priority 4096']) });
  sim.addDevice({ id: 'sw2', type, name: 'SW2', startupConfig: cfg('sw2', 'SW2') });
  sim.addDevice({ id: 'sw3', type, name: 'SW3', startupConfig: cfg('sw3', 'SW3') });
  const sw1sw2 = sim.addLink({ a: { device: 'sw1', port: GI1 }, b: { device: 'sw2', port: GI1 } });
  const sw1sw3 = sim.addLink({ a: { device: 'sw1', port: GI2 }, b: { device: 'sw3', port: GI1 } });
  const sw2sw3 = sim.addLink({ a: { device: 'sw2', port: GI2 }, b: { device: 'sw3', port: GI2 } });
  if (opts.pcs !== false) {
    for (const [i, sw] of ['sw1', 'sw2', 'sw3'].entries()) {
      const id = `pc${i + 1}`;
      sim.addDevice({ id, type: PC, name: id.toUpperCase(), startupConfig: pcConfig(id.toUpperCase(), `10.0.0.${i + 1}`, '255.255.255.0') });
      sim.addLink({ a: { device: id, port: 'GigabitEthernet0' }, b: { device: sw, port: FA1 } });
    }
  }
  return { sim, links: { sw1sw2, sw1sw3, sw2sw3 } };
}

/** The `stp` row of (device, vlan, port), or undefined. */
export function portRow(sim: Simulation, device: string, port: PortId, vlan = 1): StpPortRow | undefined {
  return sim.device(device)?.tables.get<StpPortRow>('stp')?.get(stpKey(vlan, port));
}

/** The `stp-bridge` row of (device, vlan), or undefined. */
export function bridgeRow(sim: Simulation, device: string, vlan = 1): StpBridgeRow | undefined {
  return sim.device(device)?.tables.get<StpBridgeRow>('stp-bridge')?.get(vlanKey(vlan));
}

/** Every `stp` row of a device, sorted by key. */
export function portRows(sim: Simulation, device: string): StpPortRow[] {
  return (sim.device(device)?.tables.get<StpPortRow>('stp')?.rows() ?? []).sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

/** The `linkState up` time of a link (first occurrence in the retained trace). */
export function linkUpAt(evs: readonly TraceEvent[], link: string): number {
  const e = evs.find((x) => x.kind === 'linkState' && x.link === link && x.up);
  if (e === undefined) throw new Error(`link ${link} never came up`);
  return e.t;
}

/** Every event of a kind. */
export function ofKind<K extends TraceEvent['kind']>(evs: readonly TraceEvent[], kind: K): Extract<TraceEvent, { kind: K }>[] {
  return evs.filter((e): e is Extract<TraceEvent, { kind: K }> => e.kind === kind);
}

/** `frameTx` events of BPDUs (tag `bpdu`) leaving `device` (all ports unless `port` is given). */
export function bpduTx(evs: readonly TraceEvent[], device: string, port?: PortId) {
  return ofKind(evs, 'frameTx').filter((e) => e.pdu.tag === 'bpdu' && e.from.device === device && (port === undefined || e.from.port === port));
}

/** The debug events of the stp daemon of `device` carrying an FSM transition. */
export function transitions(evs: readonly TraceEvent[], device: string) {
  return ofKind(evs, 'debug').filter((e) => e.event.device === device && e.event.process === 'stp' && e.event.fsm !== undefined).map((e) => ({ t: e.t, ...e.event.fsm! }));
}

/** Every `stp` row written on `device` (the `tableWrite` events, in order), optionally for one port. */
export function stpRowWrites(evs: readonly TraceEvent[], device: string, port?: PortId): StpPortRow[] {
  return ofKind(evs, 'tableWrite')
    .filter((e) => e.device === device && e.table === 'stp' && (port === undefined || (e.row as unknown as StpPortRow).port === port))
    .map((e) => e.row as unknown as StpPortRow);
}

/** Log lines of a device. */
export function logs(evs: readonly TraceEvent[], device: string): string[] {
  return ofKind(evs, 'log').filter((e) => e.device === device).map((e) => e.message);
}

/** All retained trace events. */
export function events(sim: Simulation): TraceEvent[] {
  return sim.trace(0).events;
}

/** The port of the SW2–SW3 link at the switch with the higher bridge id (the alternate/blocking end), per the rows. */
export function alternateEnd(sim: Simulation): { device: 'sw2' | 'sw3'; port: PortId; other: 'sw2' | 'sw3' } {
  const b2 = bridgeRow(sim, 'sw2')!;
  const b3 = bridgeRow(sim, 'sw3')!;
  return b2.bridgeId < b3.bridgeId ? { device: 'sw3', port: GI2, other: 'sw2' } : { device: 'sw2', port: GI2, other: 'sw3' };
}
