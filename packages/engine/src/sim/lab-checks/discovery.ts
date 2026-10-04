/**
 * sim/lab-checks/discovery.ts — the disc area's checker adapter (ARCHITECTURE-P3 D5, §2.10, §3.6, §5.5; §0 rules 12 and
 * 20; §7 W3 "ospf, acl, l2, qos, disc, svc, http"). The registry (sim/lab-checks/facts.ts, owned by sim) wires these
 * entries into NEIGHBOR_SOURCES and FACT_READERS; nothing here is read at module scope (rule 12: the entries are plain
 * data whose `read` calls the daemons' pure configuration readers at call time).
 *
 * Neighbours (rule 20: each source names its table):
 *   cdp   → the `cdp-neighbours` rows: the local port, the identities the row names (the device id, which is the
 *           neighbour's hostname, and every advertised address), labelled by the device id; CDP has no state word.
 *   lldp  → the `lldp-neighbours` rows: the local port, the chassis id (a port MAC of the neighbour), the system name
 *           and the management address, labelled by the system name (else the chassis id); no state word.
 *   A device whose model keeps no such table, or on which the protocol does not run (CDP: `cdpRunning`, D2 — a stored
 *   `cdp run` / `no cdp run`, else on by default only in a P3 world on a `cdpDefault` model; LLDP: a stored `lldp run`),
 *   has no neighbours of that protocol: the source answers undefined, so the detail says the device does not run it.
 *
 * Facts (both type 'boolean'; source: the configuration, with the defaults profile for CDP's default):
 *   cdp.enabled   no subject → CDP runs on the device (`cdpRunning` over the running configuration, the world's
 *                 profile and the model's `cdpDefault`);
 *                 subject = an interface → CDP runs on the device, the port takes part in discovery
 *                 (`discoveryPortEligible`: a physical Ethernet port in the switched or routed role, as the daemon
 *                 decides) and its section holds no `no cdp enable` (`cdpPortEnabled`).
 *   lldp.enabled  no subject → a stored `lldp run` (`lldpRunning`);
 *                 subject = an interface → LLDP runs, the port takes part, and it still transmits or receives (false
 *                 only when both `no lldp transmit` and `no lldp receive` are stored: LLDP is fully off there).
 *   An interface the device does not have fails the assertion with the usual detail.
 *
 * Nothing here draws randomness, advances time or emits trace.
 */
import type { DeviceRuntime } from '../../contracts/device.js';
import type { PortState } from '../../contracts/port.js';
import type { LabFactName, NeighborProtocol } from '../../contracts/scenario.js';
import type { CdpNeighbourRow, LldpNeighbourRow, TableName } from '../../contracts/tables.js';
import { cdpPortEnabled, cdpRunning, discoveryPortEligible } from '../../protocols/cdp.js';
import { lldpPortReceives, lldpPortTransmits, lldpRunning } from '../../protocols/lldp.js';
import { noPort, portNamed } from './core.js';
import type { FactContext, FactReader, FactReading, NeighborSource, NeighborView } from './facts.js';

/** The rows of `table` on `dev`, or undefined when its model keeps no such table. */
function tableRows<R>(dev: DeviceRuntime, table: TableName): R[] | undefined {
  return dev.tables.get(table)?.rows() as R[] | undefined;
}

/** The comma-joined address list of a CDP row, one address per element. */
function cdpAddresses(addresses: string): string[] {
  return addresses
    .split(',')
    .map((a) => a.trim())
    .filter((a) => a !== '');
}

/** One `cdp-neighbours` row as the `neighbor` checker sees it. */
function cdpView(r: CdpNeighbourRow): NeighborView {
  return { iface: r.localPort, peer: [r.deviceId, ...cdpAddresses(r.addresses)], label: r.deviceId };
}

/** One `lldp-neighbours` row as the `neighbor` checker sees it. */
function lldpView(r: LldpNeighbourRow): NeighborView {
  const peer = [r.chassisId];
  if (r.systemName !== undefined && r.systemName !== '') peer.push(r.systemName);
  if (r.mgmtAddress !== undefined) peer.push(r.mgmtAddress);
  return { iface: r.localPort, peer, label: r.systemName !== undefined && r.systemName !== '' ? r.systemName : r.chassisId };
}

/** NEIGHBOR_SOURCES entries of the disc area. */
export const DISCOVERY_NEIGHBOR_SOURCES: Partial<Record<NeighborProtocol, NeighborSource>> = {
  cdp: {
    table: 'cdp-neighbours',
    read(dev) {
      const rows = tableRows<CdpNeighbourRow>(dev, 'cdp-neighbours');
      if (rows === undefined || !cdpRunning(dev.running, dev.profile, dev.model)) return undefined;
      return rows.map(cdpView);
    },
  },
  lldp: {
    table: 'lldp-neighbours',
    read(dev) {
      const rows = tableRows<LldpNeighbourRow>(dev, 'lldp-neighbours');
      if (rows === undefined || !lldpRunning(dev.running)) return undefined;
      return rows.map(lldpView);
    },
  },
};

/**
 * The port an optional subject names: `null` without a subject, the port when the device has it, else the usual
 * "no interface" problem.
 */
function subjectPort(ctx: FactContext): { readonly port: PortState | null } | { readonly problem: string } {
  if (ctx.subject === undefined) return { port: null };
  const port = portNamed(ctx.dev, ctx.subject);
  if (port === undefined) return { problem: noPort(ctx.dev.spec.name, ctx.subject).detail ?? '' };
  return { port };
}

/** cdp.enabled (file header). */
function readCdpEnabled(ctx: FactContext): FactReading {
  const at = subjectPort(ctx);
  if ('problem' in at) return at;
  const dev = ctx.dev;
  const running = cdpRunning(dev.running, dev.profile, dev.model);
  if (at.port === null) return { value: running };
  return { value: running && discoveryPortEligible(dev.model, at.port) && cdpPortEnabled(dev.running, at.port.id) };
}

/** lldp.enabled (file header). */
function readLldpEnabled(ctx: FactContext): FactReading {
  const at = subjectPort(ctx);
  if ('problem' in at) return at;
  const dev = ctx.dev;
  const running = lldpRunning(dev.running);
  if (at.port === null) return { value: running };
  const id = at.port.id;
  return { value: running && discoveryPortEligible(dev.model, at.port) && (lldpPortTransmits(dev.running, id) || lldpPortReceives(dev.running, id)) };
}

/** FACT_READERS entries of the disc area. */
export const DISCOVERY_FACT_READERS: Partial<Record<LabFactName, FactReader>> = {
  'cdp.enabled': { type: 'boolean', source: 'configuration', read: readCdpEnabled },
  'lldp.enabled': { type: 'boolean', source: 'configuration', read: readLldpEnabled },
};
