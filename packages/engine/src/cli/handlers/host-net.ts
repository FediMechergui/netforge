/**
 * cli/handlers/host-net.ts — the P1 host shell expansions (ARCHITECTURE-P1 §6 "Host shell expansions (P1)").
 *
 * A host has no configuration modes, so each of these commands writes the SAME canonical lines a network OS stores,
 * with an explicit context:
 *   host.ip-address-dhcp  `ip address dhcp [<adapter>]`   → interface `ip address dhcp`
 *   host.ip-dns           `ip dns A [B]`                  → global `ip name-server A [B]`
 *   host.ipv6-address     `ipv6 address [<adapter>] X/n`  → interface `ipv6 enable` + `ipv6 address X/n`
 *   host.ipv6-autoconfig  `ipv6 autoconfig [<adapter>]`   → interface `ipv6 enable` + `ipv6 address autoconfig`
 *   host.ipv6config       read-only: the IPv6 addresses, router and neighbours of this host
 * so the running-config text and the GUI panels stay the same on every device. The adapter defaults to
 * `model.hostPorts[0]` (§3.13 "Host shell default adapter"); `ipv6 enable` is written first because writing the
 * address alone would leave the interface without a link-local address when the user later removes it.
 *
 * ponytail: `ipv6config` reuses the `show ipv6 interface` block rather than inventing a second layout; only the
 * heading and the neighbour list are host-flavoured.
 */
import type { CommandCtx, CommandHandler } from '../../contracts/cli.js';
import type { PortId } from '../../contracts/ids.js';
import type { PortView } from '../../contracts/port.js';
import type { NdRow, Route6Row } from '../../contracts/tables.js';
import { macToDotted } from '../../contracts/addr.js';
import { parseCidr6 } from '../../core/addr6.js';
import { HANDLERS } from '../grammar/index.js';
import { table } from '../format.js';
import { globalContext } from './common.js';
import { ipv6Block, MSG_BAD_IPV6_ADDRESS } from './ipv6.js';
import { hostAdapters, hostPort } from './pc.js';

/** Error for an adapter name this host does not have. */
export const MSG_NO_SUCH_ADAPTER = '% No such network adapter on this device.';
/** Error for a host with no network adapter at all. */
export const MSG_NO_ADAPTER = '% This host has no network interface.';
/** [S4] `voice vlan` outside 1–4094. */
export const MSG_BAD_VOICE_VLAN = '% Give a VLAN number between 1 and 4094.';

/** The adapter a host command acts on: the named one, else the default adapter. */
function targetAdapter(ctx: CommandCtx, raw: string | undefined): PortView | { error: string } {
  if (raw === undefined || raw === '') {
    const p = hostPort(ctx);
    return p ?? { error: MSG_NO_ADAPTER };
  }
  const id = ctx.ports.has(raw) ? raw : ctx.resolvePort(raw);
  const view = id === undefined ? undefined : ctx.ports.get(id);
  return view ?? { error: MSG_NO_SUCH_ADAPTER };
}

/** `ip address dhcp [<adapter>]` / `no ip address dhcp [<adapter>]`. */
const ipAddressDhcp: CommandHandler = (ctx, args, negate) => {
  const target = targetAdapter(ctx, args['adapter']);
  if ('error' in target) return { error: target.error };
  const context = [['interface', target.id]];
  const error = ctx.config(['ip', 'address', 'dhcp'], negate, context);
  if (error !== undefined) return { error };
  return { output: negate ? `${target.id} no longer asks for an address.` : `${target.id} is asking a DHCP server for an address. Use "ipconfig" to see the result.` };
};

/** `ip dns A [B]` / `no ip dns` → the global `ip name-server` line. */
const ipDns: CommandHandler = (ctx, args, negate) => {
  const values = [args['first'], args['second']].filter((v): v is string => v !== undefined && v !== '');
  if (negate) return outcome(ctx.config(values.length === 0 ? ['ip', 'name-server'] : ['ip', 'name-server', ...values], true, globalContext()));
  if (values.length === 0) return { error: '% Give the address of a name server.' };
  const error = ctx.config(['ip', 'name-server', ...values], false, globalContext());
  if (error !== undefined) return { error };
  return { output: `Name server${values.length === 1 ? '' : 's'}: ${values.join(', ')}.` };
};

/** Turn a `ctx.config` result into an outcome. */
function outcome(error: string | undefined): ReturnType<CommandHandler> {
  return error === undefined ? {} : { error };
}

/** `ipv6 address [<adapter>] X/len` / `no ipv6 address`. */
const ipv6Address: CommandHandler = (ctx, args, negate) => {
  const target = targetAdapter(ctx, args['adapter']);
  if ('error' in target) return { error: target.error };
  const context = [['interface', target.id]];
  if (negate) return outcome(ctx.config(['ipv6', 'address'], true, context));
  const prefix = args['prefix'] ?? '';
  if (parseCidr6(prefix) === null) return { error: MSG_BAD_IPV6_ADDRESS };
  const first = ctx.config(['ipv6', 'enable'], false, context);
  if (first !== undefined) return { error: first };
  const error = ctx.config(['ipv6', 'address', prefix], false, context);
  if (error !== undefined) return { error };
  return { output: `${target.id}: IPv6 address ${prefix}.` };
};

/** `ipv6 autoconfig [<adapter>]` / its `no` form. */
const ipv6Autoconfig: CommandHandler = (ctx, args, negate) => {
  const target = targetAdapter(ctx, args['adapter']);
  if ('error' in target) return { error: target.error };
  const context = [['interface', target.id]];
  if (negate) return outcome(ctx.config(['ipv6', 'address', 'autoconfig'], true, context));
  const first = ctx.config(['ipv6', 'enable'], false, context);
  if (first !== undefined) return { error: first };
  const error = ctx.config(['ipv6', 'address', 'autoconfig'], false, context);
  if (error !== undefined) return { error };
  return { output: `${target.id} is listening for a router advertisement. Use "ipv6config" to see the address.` };
};

/**
 * @since P2 `ipv6 address dhcp [<adapter>]` / its `no` form (ARCHITECTURE-P2 §5.5): the same `ipv6 address dhcp`
 * interface line a router stores, so dhcpv6-client reads it the same way; `ipv6 enable` first, as autoconfig does.
 */
const ipv6AddressDhcp: CommandHandler = (ctx, args, negate) => {
  const target = targetAdapter(ctx, args['adapter']);
  if ('error' in target) return { error: target.error };
  const context = [['interface', target.id]];
  if (negate) return outcome(ctx.config(['ipv6', 'address', 'dhcp'], true, context));
  const first = ctx.config(['ipv6', 'enable'], false, context);
  if (first !== undefined) return { error: first };
  const error = ctx.config(['ipv6', 'address', 'dhcp'], false, context);
  if (error !== undefined) return { error };
  return { output: `${target.id} is asking a DHCPv6 server for an address. Use "ipv6config" to see the lease.` };
};

/** [S4] `voice vlan <v>` / `no voice vlan` (§5.5): the global line the phone tags its own frames with. */
const voiceVlan: CommandHandler = (ctx, args, negate) => {
  if (negate) return outcome(ctx.config(['voice', 'vlan'], true, globalContext()));
  const vlan = Number(args['vlan']);
  if (!Number.isInteger(vlan) || vlan < 1 || vlan > 4094) return { error: MSG_BAD_VOICE_VLAN };
  return outcome(ctx.config(['voice', 'vlan', String(vlan)], false, globalContext()));
};

/** `ipv6config`: the IPv6 state of every adapter, the default router and the neighbours. */
const ipv6config: CommandHandler = (ctx) => {
  const adapters = hostAdapters(ctx);
  if (adapters.length === 0) return { error: MSG_NO_ADAPTER };
  const blocks = adapters.map((p) => ipv6Block(ctx, p));
  const routes = ctx.tables.get<Route6Row>('rib6')?.rows() ?? [];
  const def = routes.find((r) => r.isDefault === true || (r.prefixLen === 0 && r.network === '::'));
  blocks.push(`Default router ......: ${def?.nextHop ?? 'not known'}`);
  const neighbours = ctx.tables.get<NdRow>('nd')?.rows() ?? [];
  if (neighbours.length > 0) {
    const rows: string[][] = [['IPv6 address', 'MAC address', 'State', 'Interface']];
    for (const n of neighbours) rows.push([n.ip, macToDotted(n.mac), n.state, n.iface]);
    blocks.push(`Neighbours:\n${table(rows, { indent: '  ' })}`);
  }
  return { output: blocks.join('\n\n') };
};

/** Registry fragment for the CLI runtime: P1 host shell handler id → handler. */
export const hostNetHandlers: Readonly<Record<string, CommandHandler>> = {
  [HANDLERS.hostIpAddressDhcp]: ipAddressDhcp,
  [HANDLERS.hostIpDns]: ipDns,
  [HANDLERS.hostIpv6Address]: ipv6Address,
  [HANDLERS.hostIpv6Autoconfig]: ipv6Autoconfig,
  [HANDLERS.hostIpv6AddressDhcp]: ipv6AddressDhcp,
  [HANDLERS.hostVoiceVlan]: voiceVlan,
  [HANDLERS.hostIpv6config]: ipv6config,
};

