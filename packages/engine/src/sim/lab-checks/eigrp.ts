/**
 * sim/lab-checks/eigrp.ts — the [C1] EIGRP checker adapter (ARCHITECTURE-P3 D5, D26, §2.10, §2.16, §3.12, §5.1; §0
 * rules 12 and 20; §7 W3 "Approved items in W3", eigrp). sim/lab-checks/facts.ts wires these entries into
 * NEIGHBOR_SOURCES, IDENTITY_SOURCES and FACT_READERS; nothing here is read at module scope (rule 12: the entries are
 * plain data whose `read` reads tables and the running configuration at call time).
 *
 * Neighbours (rule 20: the source names its table):
 *   eigrp → the `eigrp-neighbors` rows: the local interface, the neighbour's interface address (the identity the row
 *           names; a device NAME matches it through that device's interface addresses), labelled by the address; the
 *           state word is the row's state, 'up' once the init update is acknowledged ('pending' before). A device
 *           whose model keeps no such table does not run EIGRP.
 *
 * Identities: `eigrp` → the configured `eigrp router-id` of `router eigrp` (configuration). Without the line the
 * router id in use is the highest address of an up loopback, else of an up interface (D26, as OSPF's D7): an interface
 * address, which the `address` identities already hold. The router id in use is not in a table (the daemon's StateView
 * is display only, rule 20), so the configured line is the one source.
 *
 * Facts, each with its declared type and source (rule 20); subject = a prefix ('10.4.0.0/24'; host bits are cleared,
 * so '10.4.0.9/24' names the same row) for the first three, read from the `eigrp-topology` row of that prefix (not set
 * without one):
 *   eigrp.fd                 number   eigrp-topology.fd (the feasible distance; 4294967295 while unreachable)
 *   eigrp.successor          address  eigrp-topology.successors — the next hop of the first successor in path order
 *                                     (not set for a connected network or an unreachable prefix: no successor)
 *   eigrp.feasibleSuccessor  address  eigrp-topology.feasible — the next hop of the first feasible successor in path
 *                                     order (not set when none meets the feasibility condition)
 *   eigrp.kValues            string   configuration: `metric weights 0 k1 k2 k3 k4 k5` of `router eigrp`, as
 *                                     'k1 k2 k3 k4 k5' ('1 0 1 0 0' without the line); not set without the section.
 * An 'address' fact compares against a device NAME through the identities (§2.10: `eigrp.feasibleSuccessor {subject:
 * '10.4.0.0/24', equals: 'R3'}` passes when the next hop is one of R3's addresses) or against a literal address. A
 * missing or malformed prefix fails the assertion with an original detail.
 *
 * Nothing here draws randomness, advances time or emits trace.
 */
import { parseIpv4, u32ToIpv4 } from '../../contracts/addr.js';
import type { DeviceRuntime } from '../../contracts/device.js';
import type { LabFactName, NeighborProtocol } from '../../contracts/scenario.js';
import type { EigrpNeighborRow, EigrpTopologyRow } from '../../contracts/tables.js';
import { readEigrpProcess } from '../../protocols/eigrp/config.js';
import type { FactContext, FactReader, FactReading, FactValue, IdentitySource, IdentitySourceName, NeighborSource, NeighborView } from './facts.js';

/** One `eigrp-neighbors` row as the `neighbor` checker sees it. */
function neighborView(r: EigrpNeighborRow): NeighborView {
  return { iface: r.iface, peer: [r.address], label: r.address, state: r.state };
}

/** NEIGHBOR_SOURCES entries of the eigrp item. */
export const EIGRP_NEIGHBOR_SOURCES: Partial<Record<NeighborProtocol, NeighborSource>> = {
  eigrp: {
    table: 'eigrp-neighbors',
    read(dev) {
      return dev.tables.get<EigrpNeighborRow>('eigrp-neighbors')?.rows().map(neighborView);
    },
  },
};

/** The configured EIGRP router id (file header). */
function routerIdsOf(dev: DeviceRuntime): string[] {
  // ruling R41: a device without a running configuration (a fake, a device being built) has no EIGRP router id
  const root = dev.running?.root;
  if (root === undefined) return [];
  const id = readEigrpProcess(root)?.routerId;
  return id === undefined ? [] : [id];
}

/** IDENTITY_SOURCES entries of the eigrp item. */
export const EIGRP_IDENTITY_SOURCES: Partial<Record<IdentitySourceName, IdentitySource>> = {
  eigrp: { source: 'configuration: router eigrp / eigrp router-id', read: routerIdsOf },
};

/** `a.b.c.d/len` with the host bits cleared, or undefined when `text` is not a prefix. */
function eigrpPrefixOf(text: string): string | undefined {
  const m = /^(\d{1,3}(?:\.\d{1,3}){3})\/(\d{1,2})$/.exec(text.trim());
  if (m === null) return undefined;
  const addr = parseIpv4(m[1]!);
  const len = Number(m[2]);
  if (addr === null || len > 32) return undefined;
  const mask = len === 0 ? 0 : (0xffffffff << (32 - len)) >>> 0;
  return `${u32ToIpv4((addr & mask) >>> 0)}/${len}`;
}

/** A fact of the subject prefix's `eigrp-topology` row. */
function topologyFact(fact: LabFactName, type: FactReader['type'], source: string, value: (r: EigrpTopologyRow) => FactValue | undefined): FactReader {
  return {
    type,
    source,
    read(ctx: FactContext): FactReading {
      if (ctx.subject === undefined) return { problem: `${fact} needs a prefix as its subject (10.4.0.0/24).` };
      const prefix = eigrpPrefixOf(ctx.subject);
      if (prefix === undefined) return { problem: `"${ctx.subject}" is not a prefix (write it as 10.4.0.0/24).` };
      const row = ctx.dev.tables.get<EigrpTopologyRow>('eigrp-topology')?.rows().find((r) => r.prefix === prefix);
      return { value: row === undefined ? undefined : value(row) };
    },
  };
}

/** eigrp.kValues (file header). */
function readKValues(ctx: FactContext): FactReading {
  return { value: readEigrpProcess(ctx.dev.running.root)?.kValues.join(' ') };
}

/** FACT_READERS entries of the eigrp item. */
export const EIGRP_FACT_READERS: Partial<Record<LabFactName, FactReader>> = {
  'eigrp.fd': topologyFact('eigrp.fd', 'number', 'eigrp-topology.fd', (r) => r.fd),
  'eigrp.successor': topologyFact('eigrp.successor', 'address', 'eigrp-topology.successors (the first, in path order)', (r) => r.successors[0]?.nextHop),
  'eigrp.feasibleSuccessor': topologyFact('eigrp.feasibleSuccessor', 'address', 'eigrp-topology.feasible (the first, in path order)', (r) => r.feasible[0]?.nextHop),
  'eigrp.kValues': { type: 'string', source: 'configuration: router eigrp / metric weights', read: readKValues },
};
