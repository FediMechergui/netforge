/**
 * sim/lab-checks/ospf.ts — the ospf area's checker adapter (ARCHITECTURE-P3 D5, D7, D10, §2.6, §2.10, §3.1, §3.2,
 * §5.1; §0 rules 12 and 20; §7 W3 "ospf, acl, l2, qos, disc, svc, http"). sim/lab-checks/facts.ts wires these entries
 * into NEIGHBOR_SOURCES, IDENTITY_SOURCES and FACT_READERS; nothing here is read at module scope (rule 12: the entries
 * are plain data whose `read` reads tables and the running configuration at call time).
 *
 * Neighbours (rule 20: the source names its table):
 *   ospf → the `ospf-neighbors` rows: the local port, the identities the row names (the neighbour's router id and its
 *          interface address), labelled by the router id; the state word is the NSM state ('full', '2way', 'init' …)
 *          and the role the neighbour's role on the segment ('dr', 'bdr', 'drother', 'none'). A device whose model
 *          keeps no such table does not run OSPF.
 *
 * Identities: `ospf` → the `routerId` column of the device's `ospf-interfaces` rows (the router id in use, D5), so a
 * device NAME stands for its OSPF router id too (a `neighbor {neighbor: 'R2'}` matches R2's router id).
 *
 * Facts, each with its declared type and source (rule 20):
 *   ospf.routerId               address  ospf-interfaces.routerId — the id in use (every row of the one process
 *                                        carries it), not the configured one: a `router-id` typed after the process
 *                                        started is applied only at `clear ip ospf process` or reload (D7), which is
 *                                        why a router-id fault is graded live, never in a clone alone (§2.10).
 *   ospf.referenceBandwidthMbps number   configuration: `auto-cost reference-bandwidth` of `router ospf` (100 when the
 *                                        line is absent); not set without a `router ospf` section.
 *   ospf.defaultOriginate       string   configuration: `default-information originate [always]` of `router ospf` —
 *                                        'on', 'always', or 'off' without the line; not set without the section.
 *   subject = an interface (long or short name); not set when the interface has no `ospf-interfaces` row (it does not
 *   run OSPF):
 *   ospf.ifaceArea              string   ospf-interfaces.area (dotted, '0.0.0.0')
 *   ospf.ifaceCost              number   ospf-interfaces.cost
 *   ospf.ifaceNetworkType       string   ospf-interfaces.networkType ('broadcast', 'point-to-point', 'loopback')
 *   ospf.ifaceState             string   ospf-interfaces.state (the ISM state word: 'dr', 'backup', 'drother',
 *                                        'point-to-point', 'waiting', 'loopback', 'down')
 *   ospf.ifacePriority          number   ospf-interfaces.priority
 *   ospf.passive                boolean  ospf-interfaces.passive
 *   subject = an area, dotted or as an integer ('0.0.0.0', '0'):
 *   ospf.lsdbSynced             boolean  ospf-lsdb: every router of the area — every device with an `ospf-interfaces`
 *                                        row in that area — holds the same LSA headers as this device over the rows a
 *                                        database description of the area summarises (`lsdbForArea`: the area's LSAs
 *                                        and the AS-external ones). A header is (type, link-state id, advertising
 *                                        router, sequence, checksum, MaxAge flag); the age is not compared (it moves
 *                                        with time and is not part of an instance's identity). Not set when the device
 *                                        itself has no interface in the area.
 * A missing subject, or a subject the device does not have, fails the assertion with an original detail.
 *
 * Nothing here draws randomness, advances time or emits trace.
 */
import type { DeviceRuntime } from '../../contracts/device.js';
import type { PortState } from '../../contracts/port.js';
import type { LabFactName, NeighborProtocol } from '../../contracts/scenario.js';
import type { OspfInterfaceRow, OspfLsaRow, OspfNeighborRow } from '../../contracts/tables.js';
import { parseOspfArea, readOspfConfig } from '../../protocols/ospf/config.js';
import { lsdbForArea, sortedLsdb } from '../../protocols/ospf/lsdb.js';
import { noPort, portNamed } from './core.js';
import type { FactContext, FactReader, FactReading, FactValue, IdentitySource, IdentitySourceName, NeighborSource, NeighborView } from './facts.js';

/** The `ospf-interfaces` rows of `dev`, or undefined when its model keeps no such table. */
function interfaceRows(dev: DeviceRuntime): OspfInterfaceRow[] | undefined {
  return dev.tables.get<OspfInterfaceRow>('ospf-interfaces')?.rows();
}

/** One `ospf-neighbors` row as the `neighbor` checker sees it. */
function neighborView(r: OspfNeighborRow): NeighborView {
  return { iface: r.port, peer: [r.routerId, r.address], label: r.routerId, state: r.state, role: r.role };
}

/** NEIGHBOR_SOURCES entries of the ospf area. */
export const OSPF_NEIGHBOR_SOURCES: Partial<Record<NeighborProtocol, NeighborSource>> = {
  ospf: {
    table: 'ospf-neighbors',
    read(dev) {
      return dev.tables.get<OspfNeighborRow>('ospf-neighbors')?.rows().map(neighborView);
    },
  },
};

/** The router id in use: the `routerId` column of the device's `ospf-interfaces` rows (one process, one id). */
function routerIdsOf(dev: DeviceRuntime): string[] {
  const out: string[] = [];
  for (const r of interfaceRows(dev) ?? []) if (!out.includes(r.routerId)) out.push(r.routerId);
  return out;
}

/** IDENTITY_SOURCES entries of the ospf area. */
export const OSPF_IDENTITY_SOURCES: Partial<Record<IdentitySourceName, IdentitySource>> = {
  ospf: { source: 'ospf-interfaces.routerId', read: routerIdsOf },
};

/** The interface the subject names (file header), or the problem that fails the assertion. */
function subjectPort(ctx: FactContext, fact: LabFactName): { readonly port: PortState } | { readonly problem: string } {
  if (ctx.subject === undefined) return { problem: `${fact} needs an interface as its subject.` };
  const port = portNamed(ctx.dev, ctx.subject);
  if (port === undefined) return { problem: noPort(ctx.dev.spec.name, ctx.subject).detail ?? '' };
  return { port };
}

/** A fact of one `ospf-interfaces` column of the subject's row. */
function interfaceFact(fact: LabFactName, type: FactReader['type'], column: keyof OspfInterfaceRow & string, value: (r: OspfInterfaceRow) => FactValue): FactReader {
  return {
    type,
    source: `ospf-interfaces.${column}`,
    read(ctx) {
      const at = subjectPort(ctx, fact);
      if ('problem' in at) return at;
      const row = interfaceRows(ctx.dev)?.find((r) => r.port === at.port.id);
      return { value: row === undefined ? undefined : value(row) };
    },
  };
}

/** ospf.routerId (file header). */
function readRouterId(ctx: FactContext): FactReading {
  return { value: routerIdsOf(ctx.dev)[0] };
}

/** ospf.referenceBandwidthMbps (file header). */
function readReferenceBandwidth(ctx: FactContext): FactReading {
  return { value: readOspfConfig(ctx.dev.running).process?.referenceBandwidthMbps };
}

/** ospf.defaultOriginate (file header). */
function readDefaultOriginate(ctx: FactContext): FactReading {
  const proc = readOspfConfig(ctx.dev.running).process;
  return { value: proc === undefined ? undefined : (proc.defaultOriginate ?? 'off') };
}

/** One LSA header as `ospf.lsdbSynced` compares it (file header). */
function headerText(r: OspfLsaRow): string {
  return `${r.scope}|${r.type}|${r.lsid}|${r.advRouter}|${r.seq}|${r.checksum}${r.maxAge === true ? '|maxage' : ''}`;
}

/** The headers of a device's database for `area`, in database order. */
function areaHeaders(dev: DeviceRuntime, area: string): string[] {
  const rows = dev.tables.get<OspfLsaRow>('ospf-lsdb')?.rows() ?? [];
  return sortedLsdb(lsdbForArea(rows, area)).map(headerText);
}

/** ospf.lsdbSynced (file header). */
function readLsdbSynced(ctx: FactContext): FactReading {
  if (ctx.subject === undefined) return { problem: 'ospf.lsdbSynced needs an OSPF area as its subject (0.0.0.0).' };
  const area = parseOspfArea(ctx.subject.trim());
  if (area === undefined) return { problem: `"${ctx.subject}" is not an OSPF area (write it as 0.0.0.0 or 0).` };
  const inArea = (d: DeviceRuntime): boolean => (interfaceRows(d) ?? []).some((r) => r.area === area);
  if (!inArea(ctx.dev)) return { value: undefined };
  const mine = areaHeaders(ctx.dev, area).join('\n');
  for (const d of ctx.sim.devices()) {
    if (d === ctx.dev || !inArea(d)) continue;
    if (areaHeaders(d, area).join('\n') !== mine) return { value: false };
  }
  return { value: true };
}

/** FACT_READERS entries of the ospf area. */
export const OSPF_FACT_READERS: Partial<Record<LabFactName, FactReader>> = {
  'ospf.routerId': { type: 'address', source: 'ospf-interfaces.routerId', read: readRouterId },
  'ospf.referenceBandwidthMbps': { type: 'number', source: 'configuration: router ospf / auto-cost reference-bandwidth', read: readReferenceBandwidth },
  'ospf.defaultOriginate': { type: 'string', source: 'configuration: router ospf / default-information originate', read: readDefaultOriginate },
  'ospf.ifaceArea': interfaceFact('ospf.ifaceArea', 'string', 'area', (r) => r.area),
  'ospf.ifaceCost': interfaceFact('ospf.ifaceCost', 'number', 'cost', (r) => r.cost),
  'ospf.ifaceNetworkType': interfaceFact('ospf.ifaceNetworkType', 'string', 'networkType', (r) => r.networkType),
  'ospf.ifaceState': interfaceFact('ospf.ifaceState', 'string', 'state', (r) => r.state),
  'ospf.ifacePriority': interfaceFact('ospf.ifacePriority', 'number', 'priority', (r) => r.priority),
  'ospf.passive': interfaceFact('ospf.passive', 'boolean', 'passive', (r) => r.passive),
  'ospf.lsdbSynced': { type: 'boolean', source: 'ospf-lsdb (every router with an interface in the area)', read: readLsdbSynced },
};
