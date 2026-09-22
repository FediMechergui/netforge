/**
 * cli/handlers/ipv6.ts — IPv6 configuration and show handlers (ARCHITECTURE-P1 §4.6, §6 P1 table).
 *
 * The configuration handlers validate and write the canonical lines of §6 through `ctx.config`; the ipv6 and nd
 * daemons turn them into addresses, duplicate address detection, router solicitations and routes. The show handlers
 * render live state only: `ports[].l3.ipv6` / `groups6` for the interfaces, the 'rib6' table for the routes and the
 * 'nd' table for the neighbours. `ping <X:X::X>` starts the icmpv6 echo job exactly as the IPv4 `ping` does.
 *
 * Validation is the part a learner needs to see: a multicast or unspecified address, a `eui-64` prefix that is not
 * /64, a `link-local` address outside fe80::/10 and a next hop that is neither an address nor an interface each get
 * their own original message.
 *
 * ponytail: `no ipv6 address` without a value clears every address of the interface (the daemon re-reads the whole
 * section anyway), and `ipv6 route` keeps the stored token order the daemon parses instead of a normal form of its
 * own.
 */
import type { CommandCtx, CommandHandler } from '../../contracts/cli.js';
import type { PortView } from '../../contracts/port.js';
import type { NdRow, Route6Row } from '../../contracts/tables.js';
import { macToDotted } from '../../contracts/addr.js';
import { ipv6Scope, normalizeIpv6, parseCidr6 } from '../../core/addr6.js';
import { HANDLERS, ROUTE6_DISTANCE_ARG } from '../grammar/index.js';
import { fmtSince, padRight, table } from '../format.js';
import { MSG_NO_INTERFACE_SELECTED, outcomeOf, selectedInterface } from './common.js';

/** Name of the daemon that owns the IPv6 echo job. */
export const ICMP6_PROCESS = 'icmpv6';

/** Echo requests sent by a plain `ping`, its per-echo timeout and its datagram size (the IPv4 values of §"P0 CLI surface"). */
export const PING6_COUNT = 5;
export const PING6_TIMEOUT_NS = 2_000_000_000;
export const PING6_SIZE_BYTES = 100;

/** Message for `ping` of an IPv6 address on a device that runs no IPv6 stack. */
export const MSG_NO_IPV6_STACK = '% This device has no IPv6 stack to send echo requests from.';
/** Message for an address that can never be the target of an echo request. */
export const MSG_BAD_PING6_TARGET = '% That address cannot be the target of an echo request.';
/** Message for an interface address that can never be assigned. */
export const MSG_BAD_IPV6_ADDRESS = '% That address cannot be assigned to an interface.';
/** Message for `eui-64` with a prefix length other than 64. */
export const MSG_EUI64_NEEDS_64 = '% An eui-64 address needs a /64 prefix: the hardware address fills the other half.';
/** Message for `link-local` with an address outside fe80::/10. */
export const MSG_NOT_LINK_LOCAL = '% A link-local address starts with fe80::.';
/** Message for an `ipv6 route` next hop that is neither an address nor an interface. */
export const MSG_BAD_IPV6_NEXT_HOP = '% Next hop must be an IPv6 address (X:X:X:X::X) or an interface name.';
/** @since P2 Message for a second next-hop address on an `ipv6 route` line whose hop is already an address. */
export const MSG_ROUTE6_TWO_HOPS = '% A next-hop address may follow an exit interface only; this route already names a next hop.';
/** @since P2 Message for an `ipv6 route` distance outside 1–255. */
export const MSG_BAD_ROUTE6_DISTANCE = '% The administrative distance of a route is a number from 1 to 255.';
/** Message for `show ipv6 interface <name>` with a name the device does not have. */
export const MSG_NO_SUCH_INTERFACE = '% No interface of that name exists on this device.';

/** Interface-context write shared by the simple `ipv6` switches. */
function ifLine(tokens: readonly string[]): CommandHandler {
  return (ctx, _args, negate) => {
    if (selectedInterface(ctx) === undefined) return { error: MSG_NO_INTERFACE_SELECTED };
    return outcomeOf(ctx.config([...tokens], negate));
  };
}

/** `ipv6 address <prefix> [eui-64|link-local]` / `no ipv6 address [<prefix>]`. */
const ipv6Address: CommandHandler = (ctx, args, negate) => {
  if (selectedInterface(ctx) === undefined) return { error: MSG_NO_INTERFACE_SELECTED };
  const prefix = args['prefix'];
  const kind = args['kind'];
  if (negate) {
    return outcomeOf(ctx.config(prefix === undefined ? ['ipv6', 'address'] : ['ipv6', 'address', prefix, ...(kind === undefined ? [] : [kind])], true));
  }
  const parsed = prefix === undefined ? null : parseCidr6(prefix);
  if (prefix === undefined || parsed === null) return { error: MSG_BAD_IPV6_ADDRESS };
  const scope = ipv6Scope(parsed.network);
  if (scope === 'multicast' || scope === 'unspecified' || scope === 'loopback') return { error: MSG_BAD_IPV6_ADDRESS };
  if (kind === 'eui-64' && parsed.prefixLen !== 64) return { error: MSG_EUI64_NEEDS_64 };
  if (kind === 'link-local' && scope !== 'link-local') return { error: MSG_NOT_LINK_LOCAL };
  return outcomeOf(ctx.config(['ipv6', 'address', prefix, ...(kind === undefined ? [] : [kind])], false));
};

/**
 * `ipv6 route <prefix> <next hop|interface> [<next hop>] [<distance>]` and its `no` form (P2, ARCHITECTURE-P2 §5.2:
 * the distance is stored only when it is not the default 1; `no ipv6 route P hop [via]` removes every stored line
 * for that prefix and hop whatever its distance, or the exact line when none matches).
 */
const ipv6Route: CommandHandler = (ctx, args, negate) => {
  const prefix = args['prefix'] ?? '';
  const nextHopRaw = args['nexthop'] ?? '';
  const via = args['via'];
  if (parseCidr6(prefix) === null) return { error: '% Expected a destination prefix in X:X:X:X::X/nn form.' };
  const address = normalizeIpv6(nextHopRaw);
  let nextHop: string;
  if (address !== null) {
    if (via !== undefined) return { error: MSG_ROUTE6_TWO_HOPS };
    nextHop = address;
  } else {
    const port = ctx.resolvePort(nextHopRaw);
    if (port === undefined || !ctx.ports.has(port)) return { error: MSG_BAD_IPV6_NEXT_HOP };
    nextHop = port;
  }
  const distanceText = args[ROUTE6_DISTANCE_ARG];
  const distance = distanceText === undefined ? undefined : Number(distanceText);
  if (distance !== undefined && (!Number.isInteger(distance) || distance < 1 || distance > 255)) return { error: MSG_BAD_ROUTE6_DISTANCE };
  const head = [prefix, nextHop, ...(via === undefined ? [] : [via])];
  const line = ['ipv6', 'route', ...head, ...(distance !== undefined && distance !== 1 ? [String(distance)] : [])];
  if (!negate) return outcomeOf(ctx.config(line, false));
  const matches = ctx.running.query('ipv6.route').map((n) => n.args).filter((stored) => {
    if (stored.length < head.length) return false;
    for (let i = 0; i < head.length; i++) if (stored[i] !== head[i]) return false;
    // without a typed via, a stored route with a next hop after the interface is another route
    const after = stored[head.length];
    return via !== undefined || after === undefined || /^\d{1,3}$/.test(after);
  });
  if (matches.length === 0) return outcomeOf(ctx.config(line, true));
  for (const stored of matches) {
    const error = ctx.config(['ipv6', 'route', ...stored], true);
    if (error !== undefined) return { error };
  }
  return {};
};

// ── show ipv6 … ─────────────────────────────────────────────────────────────

/** Interfaces that can carry IPv6 state, in canonical port order. */
function ipv6Ports(ctx: CommandCtx): PortView[] {
  return [...ctx.ports.values()].filter((p) => p.l3.ipv6 !== undefined || p.l3.ipv6Enabled === true);
}

/** Addresses of a port, link-local first (the daemon already orders them that way). */
function addressesOf(p: PortView): readonly { address: string; prefixLen: number; state: string; origin: string }[] {
  return p.l3.ipv6 ?? [];
}

const showIpv6IntBrief: CommandHandler = (ctx) => {
  const rows: string[][] = [['Interface', 'Status', 'IPv6 addresses']];
  for (const p of ctx.ports.values()) {
    const addrs = addressesOf(p);
    if (addrs.length === 0 && p.l3.ipv6Enabled !== true) continue;
    const status = `${p.adminUp ? 'up' : 'admin down'}/${p.operUp ? 'up' : 'down'}`;
    rows.push([p.id, status, addrs.length === 0 ? 'none' : addrs.map((a) => a.address).join(', ')]);
  }
  if (rows.length === 1) return { output: 'No interface has IPv6 enabled.' };
  return { output: table(rows, { gap: 3 }) };
};

/** One `show ipv6 interface` block. */
function ipv6Block(ctx: CommandCtx, p: PortView): string {
  const lines = [`${p.id}: admin ${p.adminUp ? 'up' : 'down'}, link ${p.operUp ? 'up' : 'down'}, IPv6 ${p.l3.ipv6Enabled === true ? 'enabled' : 'disabled'}`];
  const addrs = addressesOf(p);
  if (addrs.length === 0) {
    lines.push('  No IPv6 address.');
  } else {
    for (const a of addrs) {
      const linkLocal = ipv6Scope(a.address) === 'link-local' ? ', link-local' : '';
      lines.push(`  ${a.address}/${a.prefixLen} (${a.origin}, ${a.state}${linkLocal})`);
    }
  }
  const groups = p.l3.groups6 ?? [];
  if (groups.length > 0) lines.push(`  Joined groups: ${groups.join(', ')}`);
  return lines.join('\n');
}

const showIpv6Interface: CommandHandler = (ctx, args) => {
  const name = args['iface'];
  if (name !== undefined && name !== '') {
    const id = ctx.ports.has(name) ? name : ctx.resolvePort(name);
    const p = id === undefined ? undefined : ctx.ports.get(id);
    if (p === undefined) return { error: MSG_NO_SUCH_INTERFACE };
    return { output: ipv6Block(ctx, p) };
  }
  const ports = ipv6Ports(ctx);
  if (ports.length === 0) return { output: 'No interface has IPv6 enabled.' };
  return { output: ports.map((p) => ipv6Block(ctx, p)).join('\n\n') };
};

/** Legend line printed above the IPv6 routing table (original wording). */
export const ROUTE6_CODES_LEGEND = 'Route source codes: C - connected, L - local, S - static, ND - learned from a router advertisement, * - default route';

/** IPv6 RIB rows sorted by (prefix text, length, source) — canonical text compares stably. */
export function sortedRoute6Rows(ctx: CommandCtx): Route6Row[] {
  const rows = ctx.tables.get<Route6Row>('rib6')?.rows() ?? [];
  return rows.sort((a, b) =>
    (a.network < b.network ? -1 : a.network > b.network ? 1 : 0) || (a.prefixLen - b.prefixLen) || (a.source < b.source ? -1 : a.source > b.source ? 1 : 0));
}

/** One IPv6 routing-table row, source code in column 1. */
export function renderRoute6(r: Route6Row): string {
  const code = padRight(r.source + (r.isDefault === true ? '*' : ''), 5);
  const prefix = `${r.network}/${r.prefixLen}`;
  if (r.nextHop !== undefined) return `${code}${prefix}  via ${r.nextHop} [${r.ad}/${r.metric}]${r.iface === undefined ? '' : ` ${r.iface}`}`;
  return `${code}${prefix}  connected  ${r.iface ?? 'unknown interface'}`;
}

const showIpv6Route: CommandHandler = (ctx) => {
  const rows = sortedRoute6Rows(ctx);
  const lines: string[] = [ROUTE6_CODES_LEGEND, ''];
  if (rows.length === 0) lines.push('The IPv6 routing table is empty.');
  else for (const r of rows) lines.push(renderRoute6(r));
  return { output: lines.join('\n') };
};

const showIpv6Neighbors: CommandHandler = (ctx) => {
  const rows = ctx.tables.get<NdRow>('nd')?.rows() ?? [];
  if (rows.length === 0) return { output: 'The neighbour cache is empty.' };
  const out: string[][] = [['IPv6 address', 'MAC address', 'State', 'Router', 'Age', 'Interface']];
  for (const r of rows) {
    out.push([r.ip, r.state === 'INCOMPLETE' ? 'Incomplete' : macToDotted(r.mac), r.state, r.isRouter ? 'yes' : 'no', fmtSince(r.updatedAt, ctx.now), r.iface]);
  }
  return { output: table(out) };
};

// ── ping <X:X::X> ───────────────────────────────────────────────────────────

/** `ping <IPv6 address>` (and the host `ping -6` form): start the icmpv6 echo job and block until `cliDone`. */
const ping6: CommandHandler = (ctx, args) => {
  const target = normalizeIpv6(args['target'] ?? '');
  if (target === null) return { error: '% Expected an IPv6 address (X:X:X:X::X).' };
  const scope = ipv6Scope(target);
  if (scope === 'unspecified' || scope === 'multicast') return { error: MSG_BAD_PING6_TARGET };
  if (ctx.processState(ICMP6_PROCESS) === undefined) return { error: MSG_NO_IPV6_STACK };
  // Block BEFORE the request, as the IPv4 ping does: a job that answers synchronously must clear the flag.
  ctx.block({ process: ICMP6_PROCESS, abort: { kind: 'icmp.abort', session: ctx.session.id }, label: 'ping' });
  ctx.request(ICMP6_PROCESS, {
    kind: 'icmp6.ping',
    session: ctx.session.id,
    target,
    count: PING6_COUNT,
    timeoutNs: PING6_TIMEOUT_NS,
    sizeBytes: PING6_SIZE_BYTES,
  });
  return {};
};

/** Registry fragment for the CLI runtime: IPv6 handler id → handler. */
export const ipv6Handlers: Readonly<Record<string, CommandHandler>> = {
  [HANDLERS.ifIpv6Enable]: ifLine(['ipv6', 'enable']),
  [HANDLERS.ifIpv6Address]: ipv6Address,
  [HANDLERS.ifIpv6Autoconfig]: ifLine(['ipv6', 'address', 'autoconfig']),
  [HANDLERS.ifIpv6SuppressRa]: ifLine(['ipv6', 'nd', 'suppress-ra']),
  [HANDLERS.configIpv6UnicastRouting]: (ctx, _args, negate) => outcomeOf(ctx.config(['ipv6', 'unicast-routing'], negate, [])),
  [HANDLERS.configIpv6Route]: ipv6Route,
  [HANDLERS.showIpv6IntBrief]: showIpv6IntBrief,
  [HANDLERS.showIpv6Interface]: showIpv6Interface,
  [HANDLERS.showIpv6Route]: showIpv6Route,
  [HANDLERS.showIpv6Neighbors]: showIpv6Neighbors,
  [HANDLERS.execPing6]: ping6,
};

/** One interface block of the IPv6 listing; the host shell's `ipv6config` prints the same shape. */
export { ipv6Block };
