/**
 * sim/lab-checks/wan.ts — the wan area's checker adapter for the approved [S18] GRE, [S19] PPP and [C13] IPsec items
 * (ARCHITECTURE-P3 D5, D17, D27, §2.10, §2.17, §3.9, §3.10, §3.13; §0 rules 12 and 20; §7 W3 "Approved items in W3",
 * wan). The registry (sim/lab-checks/facts.ts, owned by sim) wires these entries into NEIGHBOR_SOURCES and
 * FACT_READERS; nothing here is read at module scope (rule 12).
 *
 * Neighbours (rule 20):
 *   [S19] ppp → the `ppp` rows, one per serial port running PPP: the local port, the identities the row has learnt
 *         (`peerName`, the name the peer authenticated with — its hostname with CHAP —, and `peerAddress`, from
 *         IPCP), labelled by the first of them (`unidentified` before either is known), and the state word = the LCP
 *         state (`opened` once the link is up). A device whose model keeps no `ppp` table does not run PPP.
 *
 * Facts, each with its source (rule 20); subject: the interface (long or short name):
 *   [S18] tunnel.up  boolean  tunnels.state === 'up' (the tunnel's own row, D17: one per configured Tunnel interface).
 *   [S19] ppp.lcp    string   ppp.lcp   — the LCP automaton state ('opened', 'req-sent', 'stopped' …).
 *   [S19] ppp.ipcp   string   ppp.ipcp  — the IPCP automaton state.
 *   [S19] ppp.auth   string   ppp.authLocal — the authentication this end requires of its peer ('chap', 'pap' or
 *                            'none'); whether it succeeded is the LCP state's business (a failure stops LCP).
 *   [C13] ipsec.sa   string   ipsec-sa.state — 'negotiating', 'established' or 'failed'.
 * A subject the device does not have as an interface fails with the usual detail; an interface without a row has no
 * value ("not set"). Without a subject, a device with exactly one row of the table is read from that row (the brief's
 * own `fact ppp.ipcp {equals: 'opened'}`), none means no value, and several fail with a detail asking for a subject.
 *
 * Nothing here draws randomness, advances time or emits trace.
 */
import type { DeviceRuntime } from '../../contracts/device.js';
import type { PortId } from '../../contracts/ids.js';
import type { LabFactName, NeighborProtocol } from '../../contracts/scenario.js';
import type { IpsecSaRow, PppRow, TableName, TableRow, TunnelRow } from '../../contracts/tables.js';
import { noPort, portNamed } from './core.js';
import type { FactContext, FactReader, FactReading, NeighborSource, NeighborView } from './facts.js';

/** How a PPP neighbour is named before its name or address is learnt. */
const PPP_UNIDENTIFIED = 'unidentified';

/** The rows of `table` on `dev`, or undefined when its model keeps no such table. */
function tableRows<R>(dev: DeviceRuntime, table: TableName): R[] | undefined {
  return dev.tables.get(table)?.rows() as R[] | undefined;
}

/** One `ppp` row as the `neighbor` checker sees it. */
function pppView(r: PppRow): NeighborView {
  const peer: string[] = [];
  if (r.peerName !== undefined && r.peerName !== '') peer.push(r.peerName);
  if (r.peerAddress !== undefined) peer.push(r.peerAddress);
  return { iface: r.port, peer, label: peer[0] ?? PPP_UNIDENTIFIED, state: r.lcp };
}

/** NEIGHBOR_SOURCES entries of the wan area. */
export const WAN_NEIGHBOR_SOURCES: Partial<Record<NeighborProtocol, NeighborSource>> = {
  ppp: {
    table: 'ppp',
    read(dev) {
      return tableRows<PppRow>(dev, 'ppp')?.map(pppView);
    },
  },
};

/**
 * The row of a per-interface table (`tunnels`, `ppp`, `ipsec-sa`) the assertion's subject names (file header): the
 * subject's port row, else the device's only row; `noun` names the rows in the detail asking for a subject.
 */
function subjectRow<R extends TableRow & { readonly port: PortId }>(
  ctx: FactContext,
  table: TableName,
  fact: LabFactName,
  noun: string,
): { readonly row: R | undefined } | { readonly problem: string } {
  const dev = ctx.dev;
  const rows = tableRows<R>(dev, table) ?? [];
  if (ctx.subject !== undefined) {
    const port = portNamed(dev, ctx.subject);
    if (port === undefined) return { problem: noPort(dev.spec.name, ctx.subject).detail ?? '' };
    return { row: rows.find((r) => r.port === port.id) };
  }
  if (rows.length <= 1) return { row: rows[0] };
  const names = rows.map((r) => dev.port(r.port)?.spec.short ?? r.port).join(', ');
  return { problem: `${dev.spec.name} has ${rows.length} ${noun} (${names}), so ${fact} needs a subject naming one.` };
}

/** A fact read from one column of the subject's row. */
function columnReader<R extends TableRow & { readonly port: PortId }>(
  table: TableName,
  fact: LabFactName,
  noun: string,
  value: (row: R) => string | boolean,
): (ctx: FactContext) => FactReading {
  return (ctx) => {
    const at = subjectRow<R>(ctx, table, fact, noun);
    if ('problem' in at) return at;
    return { value: at.row === undefined ? undefined : value(at.row) };
  };
}

/** FACT_READERS entries of the wan area. */
export const WAN_FACT_READERS: Partial<Record<LabFactName, FactReader>> = {
  'tunnel.up': {
    type: 'boolean',
    source: 'tunnels.state',
    read: columnReader<TunnelRow>('tunnels', 'tunnel.up', 'tunnels', (r) => r.state === 'up'),
  },
  'ppp.lcp': {
    type: 'string',
    source: 'ppp.lcp',
    read: columnReader<PppRow>('ppp', 'ppp.lcp', 'PPP interfaces', (r) => r.lcp),
  },
  'ppp.ipcp': {
    type: 'string',
    source: 'ppp.ipcp',
    read: columnReader<PppRow>('ppp', 'ppp.ipcp', 'PPP interfaces', (r) => r.ipcp),
  },
  'ppp.auth': {
    type: 'string',
    source: 'ppp.authLocal',
    read: columnReader<PppRow>('ppp', 'ppp.auth', 'PPP interfaces', (r) => r.authLocal),
  },
  'ipsec.sa': {
    type: 'string',
    source: 'ipsec-sa.state',
    read: columnReader<IpsecSaRow>('ipsec-sa', 'ipsec.sa', 'protected tunnels', (r) => r.state),
  },
};
