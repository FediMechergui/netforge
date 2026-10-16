/**
 * device/if-index.ts — the shared interface index (ARCHITECTURE-P3C §3.5; §7 W1a device). @since P3c
 *
 * One rule numbers a device's interfaces for [S33] SNMP (`ifIndex`, the ifTable and the link traps) and [S6] OSPFv3
 * (the interface id of its hellos and LSAs), so the two never disagree:
 *   • the physical ports are 1…n, in the model's port order (fixed ports, then module ports in slot order);
 *   • the virtual interfaces (SVIs, loopbacks, tunnels, subinterfaces) follow from n + 1, in the order of their first
 *     creation since boot. A removed interface keeps its place in that order until the next boot, so re-creating it
 *     gives it its old index and never shifts another interface's index.
 *
 * Pure: plain data in, numbers out; no clock, no rng, no device state. The device runtime (`ifIndexSource`,
 * device/device.ts) supplies the two lists; a test or a pure caller may build them itself. A name listed twice counts
 * at its first place, and a virtual name that is also a physical port is a physical port.
 */

/** The two ordered lists the rule numbers. */
export interface IfIndexSource {
  /** The physical ports in the model's port order. */
  readonly physical: readonly string[];
  /** The virtual interfaces in the order of their first creation since boot (removed ones included). */
  readonly virtual: readonly string[];
}

/** Every interface of `src` with its index, in index order (1, 2, 3, …). */
export function ifIndexTable(src: IfIndexSource): ReadonlyMap<string, number> {
  const out = new Map<string, number>();
  for (const name of src.physical) if (!out.has(name)) out.set(name, out.size + 1);
  for (const name of src.virtual) if (!out.has(name)) out.set(name, out.size + 1);
  return out;
}

/** The interface index of `port` (1-based), or undefined when `src` lists no such interface. */
export function ifIndexOf(src: IfIndexSource, port: string): number | undefined {
  let n = 0;
  const seen = new Set<string>();
  for (const list of [src.physical, src.virtual]) {
    for (const name of list) {
      if (seen.has(name)) continue;
      seen.add(name);
      n++;
      if (name === port) return n;
    }
  }
  return undefined;
}

/** The interface whose index is `index`, or undefined when no interface has it (the inverse of `ifIndexOf`). */
export function portOfIfIndex(src: IfIndexSource, index: number): string | undefined {
  if (!Number.isInteger(index) || index < 1) return undefined;
  for (const [name, i] of ifIndexTable(src)) if (i === index) return name;
  return undefined;
}
