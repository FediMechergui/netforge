/**
 * sim/scenarios/kit.ts — the small builders every scenario file uses (ARCHITECTURE-P1 §8.2 W6).
 *
 * Nothing here decides anything: it is the vocabulary the templates (sim/scenarios/templates.ts) and the CCNA 1 labs
 * (sim/scenarios/ccna1/*.ts) write their topologies in — catalog type ids, config text, devices and cables. The
 * template builders keep the exact bodies they had in P0/P0.5, so their topologies stay byte-identical (the P0.5
 * acceptance tests compare traces).
 *
 * ponytail: internal to the scenario tree (sim/scenarios/index.ts does not re-export it), so the generic names
 * `device` and `link` cannot collide in the engine barrel.
 */
import { TOPOLOGY_SCHEMA_ID, type Topology, type TopologyDevice, type TopologyLink } from '../../contracts/topology.js';
import type { MediaType } from '../../contracts/link.js';

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

/** Assemble a topology; `seed` is stamped into the file (the Simulation keeps its own). */
export function topology(
  seed: number,
  devices: readonly TopologyDevice[],
  links: readonly TopologyLink[],
  objectives: readonly string[],
  notes: string,
): Topology {
  return { schema: TOPOLOGY_SCHEMA_ID, seed, devices: [...devices], links: [...links], objectives: [...objectives], notes };
}
