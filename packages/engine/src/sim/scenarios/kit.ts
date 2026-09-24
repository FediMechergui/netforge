/**
 * sim/scenarios/kit.ts — the small builders every scenario file uses (ARCHITECTURE-P1 §8.2 W6; ARCHITECTURE-P2 §2.9,
 * §11.2).
 *
 * Nothing here decides anything: it is the vocabulary the templates (sim/scenarios/templates.ts), the CCNA 1 labs
 * (sim/scenarios/ccna1/*.ts) and the CCNA 2 labs (sim/scenarios/ccna2/*.ts) write their topologies in — catalog type
 * ids, config text, devices and cables. The template builders keep the exact bodies they had in P0/P0.5, so their
 * topologies stay byte-identical (the P0.5 acceptance tests compare traces).
 *
 * P2 (W5 sim): `topology(…, { profile: 'P2' })` writes `profile: 'P2'` and, in the same step, `schema =
 * schemaIdFor(t)` (1.2) — every CCNA 2 lab is a P2 world (D2, §11.2). Without the option (every existing caller) the
 * topology is exactly what it was: schema 1.1, no `profile` key. The switching helpers (`vlanSections`,
 * `accessPort`, `trunkPort`) write the canonical §5.1 lines, and the fault helpers (`errDisableFault`,
 * `cableCutFault`, `configFragmentFault` — the three hidden faults of §11.2) build `ScenarioInfo.faults` entries,
 * which the worker injects right after the world is loaded (so a lab can boot with a fault the student has to find).
 *
 * ponytail: internal to the scenario tree (sim/scenarios/index.ts does not re-export it), so the generic names
 * `device` and `link` cannot collide in the engine barrel.
 */
import type { DefaultsProfile } from '../../contracts/catalog.js';
import type { FaultSpec } from '../../contracts/events.js';
import type { DeviceId, LinkId, PortId } from '../../contracts/ids.js';
import type { MediaType } from '../../contracts/link.js';
import type { ErrDisableCause } from '../../contracts/port.js';
import type { SimTime } from '../../contracts/time.js';
import { TOPOLOGY_SCHEMA_ID, schemaIdFor, type Topology, type TopologyDevice, type TopologyLink } from '../../contracts/topology.js';

/** Catalog type ids the scenarios build with. */
export const PC = 'pc.nfpc';
export const SWITCH = 'switch.nfc2960';
export const ROUTER = 'router.nf2911';
export const LAPTOP = 'laptop.nflaptop';
export const HOME_ROUTER = 'wrouter.nfhome';
export const HUB = 'hub.nfhub4';
export const MLSWITCH = 'mlswitch.nfc3650-24';
export const RADIO_PTP5 = 'radio.nfptp5';
export const CELL_TOWER = 'cell.nftower';
export const SMARTPHONE = 'phone.nfsmartphone';
export const SERVER = 'server.nfserver';
/** @since P2 NF-C9300-48U: a multilayer switch whose spanning tree defaults to rapid-pvst in a P2 world. */
export const MLSWITCH_RAPID = 'mlswitch.nfc9300-48';

/** Masks the scenarios write out. */
export const MASK24 = '255.255.255.0';
export const MASK26 = '255.255.255.192';
export const MASK30 = '255.255.255.252';
export const MASK32 = '255.255.255.255';

/** Render a config text from lines (sections separated by `!`, terminated by `end`). */
export function configText(sections: readonly (readonly string[])[]): string {
  const out: string[] = [];
  for (const s of sections) {
    out.push(...s, '!');
  }
  out.push('end', '');
  return out.join('\n');
}

/** A config section: its header line followed by one-space-indented child lines. */
export function section(header: string, children: readonly string[]): string[] {
  return [header, ...children.map((c) => ` ${c}`)];
}

/** A powered device at a logical canvas position, with an optional startup config. */
export function device(id: string, type: string, name: string, x: number, y: number, config?: string): TopologyDevice {
  const d: TopologyDevice = { id, type, name, position: { logical: [x, y] }, power: true };
  if (config !== undefined) d.config = config;
  return d;
}

/** A 3 m cable whose media the port pair resolves ('auto'). */
export function link(id: string, aDev: string, aPort: string, bDev: string, bPort: string): TopologyLink {
  return { id, a: { device: aDev, port: aPort }, b: { device: bDev, port: bPort }, media: 'auto', length_m: 3 };
}

/** A cable of an explicit media type (serial, crossover …), 3 m long unless given. */
export function cable(id: string, aDev: string, aPort: string, bDev: string, bPort: string, media: MediaType, lengthM = 3): TopologyLink {
  return { id, a: { device: aDev, port: aPort }, b: { device: bDev, port: bPort }, media, length_m: lengthM };
}

/** A point-to-point radio pairing (§3.7) with a distance override in metres. */
export function radioLink(id: string, aDev: string, aPort: string, bDev: string, bPort: string, distanceM: number): TopologyLink {
  return { id, a: { device: aDev, port: aPort }, b: { device: bDev, port: bPort }, media: 'radio', kind: 'radio', distance_m: distanceM };
}

/** @since P2 Options of `topology`. */
export interface TopologyOptions {
  /** The world's defaults profile (D2). 'P2' writes `profile: 'P2'` and schema 1.2; absent or 'P1' writes neither. */
  readonly profile?: DefaultsProfile;
}

/**
 * Assemble a topology; `seed` is stamped into the file (the Simulation keeps its own). With `{ profile: 'P2' }` (every
 * CCNA 2 lab) the topology carries `profile: 'P2'` and `schema = schemaIdFor(t)` in the same step (§2.9); without it
 * the result is the P1 topology it always was (schema 1.1, no `profile`).
 */
export function topology(
  seed: number,
  devices: readonly TopologyDevice[],
  links: readonly TopologyLink[],
  objectives: readonly string[],
  notes: string,
  opts: TopologyOptions = {},
): Topology {
  const t: Topology = { schema: TOPOLOGY_SCHEMA_ID, seed, devices: [...devices], links: [...links], objectives: [...objectives], notes };
  if (opts.profile === 'P2') {
    t.profile = 'P2';
    t.schema = schemaIdFor(t);
  }
  return t;
}

// ── P2 switching lines (§5.1 canonical forms) ───────────────────────────────

/** @since P2 One `vlan <id>` section per entry, with its ` name <name>` line when named (§5.1). */
export function vlanSections(vlans: readonly { readonly id: number; readonly name?: string }[]): string[][] {
  return vlans.map((v) => section(`vlan ${v.id}`, v.name === undefined ? [] : [`name ${v.name}`]));
}

/**
 * @since P2 An access port: `switchport mode access`, `switchport access vlan <v>` (omitted for VLAN 1) and, with
 * `portfast`, `spanning-tree portfast` — the edge-port line a lab not about spanning tree gives its host ports so the
 * first ping is not lost to the 30 s forward delay (§11.2).
 */
export function accessPort(port: string, vlan: number, opts: { readonly portfast?: boolean } = {}): string[] {
  const lines = ['switchport mode access'];
  if (vlan !== 1) lines.push(`switchport access vlan ${vlan}`);
  if (opts.portfast === true) lines.push('spanning-tree portfast');
  return section(`interface ${port}`, lines);
}

/**
 * @since P2 A static 802.1Q trunk: `switchport mode trunk`, then the native VLAN (omitted for 1), the allowed list as
 * canonical text (`10,20,99`; omitted = every VLAN) and `switchport nonegotiate` when asked.
 */
export function trunkPort(port: string, opts: { readonly native?: number; readonly allowed?: string; readonly nonegotiate?: boolean } = {}): string[] {
  const lines = ['switchport mode trunk'];
  if (opts.native !== undefined && opts.native !== 1) lines.push(`switchport trunk native vlan ${opts.native}`);
  if (opts.allowed !== undefined) lines.push(`switchport trunk allowed vlan ${opts.allowed}`);
  if (opts.nonegotiate === true) lines.push('switchport nonegotiate');
  return section(`interface ${port}`, lines);
}

// ── P2 scheduled faults (`ScenarioInfo.faults`, injected by the worker after the load) ──────────────────────────

/** A scheduled fault of a lab (`ScenarioInfo.faults` entry). */
export type ScheduledFault = { readonly at: SimTime; readonly fault: FaultSpec };

/**
 * @since P2 Err-disable port `port` (canonical name) of device `device` (topology id, not name) at `at` with `cause`
 * (§2.7 `err-disable` fault; the port stays down until the student shuts it and brings it back, or recovery runs).
 * A lab schedules it at 0: the port stays error-disabled through the boot (the grader's clone re-applies it the same
 * way), so the world is never seen healthy before the fault lands (W5 fix).
 */
export function errDisableFault(at: SimTime, device: DeviceId, port: PortId, cause: ErrDisableCause): ScheduledFault {
  return { at, fault: { id: `errdisable:${device}:${port}`, kind: 'err-disable', target: { device, port }, params: { cause } } };
}

/** @since P2 Cut cable `link` (topology link id) at `at` (the `cable-cut` fault; the grader's clone re-cuts it). */
export function cableCutFault(at: SimTime, link: LinkId): ScheduledFault {
  return { at, fault: { id: `cut:${link}`, kind: 'cable-cut', target: { link } } };
}

/**
 * @since P2 Type `lines` into device `device` (topology id) at `at`, as pasted configuration (an indented line belongs
 * to the section above it; a refused line is skipped): the `config-fragment` fault. The device must have booted by
 * then (a switch boots in 30 s, a router in 45 s); the lines land in its running config, so the grader's clone has them.
 * End the lines with `do write memory` when a power cycle must not undo them (a reboot loads the startup config).
 * Until the last scheduled fault has landed, `evaluateLab` grades no task (sim/lab-checks.ts).
 */
export function configFragmentFault(at: SimTime, device: DeviceId, lines: readonly string[]): ScheduledFault {
  return { at, fault: { id: `config:${device}:${at}`, kind: 'config-fragment', target: { device }, params: { lines: [...lines] } } };
}
