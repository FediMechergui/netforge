/**
 * cli/handlers/transport.ts — the socket listing behind `netstat` and `show ip sockets` (ARCHITECTURE-P1 §4.5,
 * §6 P1 table).
 *
 * One handler for both names. It renders the device's 'sockets' table, which the udp and tcp daemons own: every row
 * is a bind (`BOUND` for UDP) or a connection with its TCP state, the daemon that opened it and, for a socket that
 * receives on one interface only (a DHCP client socket), that interface. Nothing is computed here — the table is the
 * truth, so what the listing shows is exactly what the transport layer holds.
 *
 * ponytail: no name resolution of addresses or ports and no listen/established filter; the table is short enough
 * that a learner can read all of it.
 */
import type { CommandHandler } from '../../contracts/cli.js';
import type { SocketRow } from '../../contracts/tables.js';
import { formatEndpoint } from '../../core/addr6.js';
import { HANDLERS } from '../grammar/index.js';
import { table } from '../format.js';

/** Printed when the device has no socket open. */
export const MSG_NO_SOCKETS = 'No socket is open on this device.';

/** Socket rows sorted by (protocol, local port, socket id) — a stable, readable order. */
export function sortedSocketRows(rows: readonly SocketRow[]): SocketRow[] {
  return rows.slice().sort((a, b) =>
    (a.proto < b.proto ? -1 : a.proto > b.proto ? 1 : 0) || (a.localPort - b.localPort) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** `netstat` (host shell) and `show ip sockets` (network OS). */
const showSockets: CommandHandler = (ctx) => {
  const rows = ctx.tables.get<SocketRow>('sockets')?.rows() ?? [];
  if (rows.length === 0) return { output: MSG_NO_SOCKETS };
  const out: string[][] = [['Proto', 'Local address', 'Remote address', 'State', 'Owner', 'Interface']];
  for (const r of sortedSocketRows(rows)) {
    const remote = r.remoteAddr === undefined ? '-' : formatEndpoint(r.remoteAddr, r.remotePort ?? 0);
    out.push([`${r.proto}${r.family === 6 ? '6' : ''}`, formatEndpoint(r.localAddr, r.localPort), remote, r.state, r.owner, r.iface ?? '-']);
  }
  return { output: table(out) };
};

/** Registry fragment for the CLI runtime: transport handler id → handler. */
export const transportHandlers: Readonly<Record<string, CommandHandler>> = {
  [HANDLERS.showSockets]: showSockets,
};
