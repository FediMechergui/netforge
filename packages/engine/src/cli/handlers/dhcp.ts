/**
 * cli/handlers/dhcp.ts — DHCPv4 configuration and show handlers (ARCHITECTURE-P1 §4.3, §6 P1 table).
 *
 * Client side `ip address dhcp` writes the interface line the ipv4 daemon reads to mark the port DHCP-managed;
 * dhcp-client then runs DORA on its own. Server side the handlers write the pool section and the global exclusions,
 * and `show ip dhcp binding` / `show ip dhcp pool` render what the daemon produced: the 'dhcp-bindings' table and
 * `dhcpPoolViews` (the pool summary the dhcp-server module exports for exactly this command).
 *
 * Entering `ip dhcp pool NAME` pushes the context entry `['ip','dhcp','pool',NAME]`, so every line typed below it is
 * written into that section by the session's own context — the handlers never name the pool again.
 *
 * ponytail: the pool lines are thin wrappers over `ctx.config`; the daemon already refuses a network it cannot use,
 * so the CLI only checks what it can explain better (a network address with host bits, a gateway off the subnet).
 */
import type { CommandHandler } from '../../contracts/cli.js';
import type { DhcpBindingRow } from '../../contracts/tables.js';
import { inSubnet, ipv4ToU32, macToDotted, maskToPrefixLen, networkOf, parseIpv4 } from '../../contracts/addr.js';
import { dhcpPoolViews } from '../../protocols/dhcp-server.js';
import { HANDLERS } from '../grammar/index.js';
import { fmtSince, table } from '../format.js';
import { enterMode, globalContext, MSG_NO_INTERFACE_SELECTED, outcomeOf, selectedInterface } from './common.js';

/** Error for `ip dhcp excluded-address A B` with B below A. */
export const MSG_RANGE_REVERSED = '% The last address of the range comes before the first one.';
/** Error for a `network` line whose address has host bits set under its mask. */
export const MSG_POOL_HOST_BITS = '% The network address has host bits set for that mask.';
/** Error for a `default-router` outside the pool's own subnet. */
export const MSG_ROUTER_OFF_SUBNET = '% That gateway is not on the subnet this pool leases from.';
/** Error for a `lease` of zero length. */
export const MSG_LEASE_ZERO = '% A lease needs a length: give days, hours or minutes.';
/** Printed by `show ip dhcp binding` when the server has leased nothing. */
export const MSG_NO_BINDINGS = 'No address has been offered or leased yet.';
/** Printed by `show ip dhcp pool` when no pool is configured. */
export const MSG_NO_POOLS = 'No address pool is configured.';

/** Interface-context write shared by the interface lines. */
function ifWrite(ctx: Parameters<CommandHandler>[0], line: string[], negate: boolean): ReturnType<CommandHandler> {
  if (selectedInterface(ctx) === undefined) return { error: MSG_NO_INTERFACE_SELECTED };
  return outcomeOf(ctx.config(line, negate));
}

/** `ip address dhcp` / `no ip address dhcp`. */
const ipAddressDhcp: CommandHandler = (ctx, _args, negate) => ifWrite(ctx, ['ip', 'address', 'dhcp'], negate);

/** `ip helper-address <address>` / `no ip helper-address [<address>]`. */
const helperAddress: CommandHandler = (ctx, args, negate) => {
  const address = args['address'];
  if (negate) return ifWrite(ctx, address === undefined ? ['ip', 'helper-address'] : ['ip', 'helper-address', address], true);
  if (address === undefined) return { error: '% Give the address of the server to forward to.' };
  return ifWrite(ctx, ['ip', 'helper-address', address], false);
};

/** `ip dhcp excluded-address <low> [<high>]` and its `no` form. */
const excludedAddress: CommandHandler = (ctx, args, negate) => {
  const low = args['low'] ?? '';
  const high = args['high'] ?? low;
  if (parseIpv4(low) === null || parseIpv4(high) === null) return { error: '% Expected an IPv4 address in dotted-decimal form (A.B.C.D).' };
  if (ipv4ToU32(high) < ipv4ToU32(low)) return { error: MSG_RANGE_REVERSED };
  return outcomeOf(ctx.config(['ip', 'dhcp', 'excluded-address', low, high], negate, globalContext()));
};

/** `ip dhcp pool <name>`: create or edit the section, then configure inside it. */
const dhcpPool: CommandHandler = (ctx, args, negate) => {
  const name = args['name'] ?? '';
  if (name === '') return { error: '% Give the pool a name.' };
  if (negate) return outcomeOf(ctx.config(['ip', 'dhcp', 'pool', name], true, globalContext()));
  const error = ctx.config(['ip', 'dhcp', 'pool', name], false, globalContext());
  if (error !== undefined) return { error };
  enterMode(ctx, 'dhcp-config', [['ip', 'dhcp', 'pool', name]]);
  return {};
};

/** `network <address> <mask>` inside a pool. */
const poolNetwork: CommandHandler = (ctx, args, negate) => {
  if (negate) return outcomeOf(ctx.config(['network'], true));
  const address = args['address'] ?? '';
  const mask = args['mask'] ?? '';
  const len = maskToPrefixLen(mask);
  if (parseIpv4(address) === null) return { error: '% Expected a network address (A.B.C.D).' };
  if (len === null) return { error: '% Expected a contiguous subnet mask such as 255.255.255.0.' };
  if (len > 30) return { error: '% That mask leaves no addresses to lease.' };
  if (networkOf(address, len) !== address) return { error: MSG_POOL_HOST_BITS };
  return outcomeOf(ctx.config(['network', address, mask], false));
};

/** The pool's network and prefix length from the section the session is in, or undefined. */
function poolSubnet(ctx: Parameters<CommandHandler>[0]): { network: string; prefixLen: number } | undefined {
  const entry = ctx.context[ctx.context.length - 1];
  const name = entry?.[0] === 'ip' && entry[1] === 'dhcp' && entry[2] === 'pool' ? entry[3] : undefined;
  if (name === undefined) return undefined;
  const section = ctx.running.root.children.find((c) => c.key === 'ip' && c.args[0] === 'dhcp' && c.args[1] === 'pool' && c.args[2] === name);
  const network = section?.children.find((c) => c.key === 'network');
  const address = network?.args[0];
  const len = network?.args[1] === undefined ? null : maskToPrefixLen(network.args[1]);
  if (address === undefined || len === null) return undefined;
  return { network: address, prefixLen: len };
}

/** `default-router <first> [<second>]` inside a pool: both addresses must be on the pool's subnet. */
const poolDefaultRouter: CommandHandler = (ctx, args, negate) => {
  if (negate) return outcomeOf(ctx.config(['default-router'], true));
  const values = [args['first'], args['second']].filter((v): v is string => v !== undefined && v !== '');
  if (values.length === 0) return { error: '% Give the gateway address handed to the clients.' };
  const subnet = poolSubnet(ctx);
  if (subnet !== undefined) {
    for (const v of values) if (!inSubnet(v, subnet.network, subnet.prefixLen)) return { error: MSG_ROUTER_OFF_SUBNET };
  }
  return outcomeOf(ctx.config(['default-router', ...values], false));
};

/** `dns-server <first> [<second>]` inside a pool. */
const poolDnsServer: CommandHandler = (ctx, args, negate) => {
  if (negate) return outcomeOf(ctx.config(['dns-server'], true));
  const values = [args['first'], args['second']].filter((v): v is string => v !== undefined && v !== '');
  if (values.length === 0) return { error: '% Give the name server address handed to the clients.' };
  return outcomeOf(ctx.config(['dns-server', ...values], false));
};

/** `domain-name <name>` inside a pool. */
const poolDomainName: CommandHandler = (ctx, args, negate) => {
  if (negate) return outcomeOf(ctx.config(['domain-name'], true));
  const name = args['name'] ?? '';
  if (name === '') return { error: '% Give the domain name handed to the clients.' };
  return outcomeOf(ctx.config(['domain-name', name], false));
};

/** `lease <days> [<hours> [<minutes>]]` inside a pool. */
const poolLease: CommandHandler = (ctx, args, negate) => {
  if (negate) return outcomeOf(ctx.config(['lease'], true));
  const days = args['days'] ?? '';
  const hours = args['hours'] ?? '0';
  const minutes = args['minutes'] ?? '0';
  if (days === '') return { error: '% Give the lease length in days, hours and minutes.' };
  if (Number(days) === 0 && Number(hours) === 0 && Number(minutes) === 0) return { error: MSG_LEASE_ZERO };
  return outcomeOf(ctx.config(['lease', days, hours, minutes], false));
};

// ── show ip dhcp … ──────────────────────────────────────────────────────────

const showBinding: CommandHandler = (ctx) => {
  const rows = ctx.tables.get<DhcpBindingRow>('dhcp-bindings')?.rows() ?? [];
  if (rows.length === 0) return { output: MSG_NO_BINDINGS };
  const sorted = rows.slice().sort((a, b) => ipv4ToU32(a.ip) - ipv4ToU32(b.ip));
  const out: string[][] = [['IPv4 address', 'Client', 'Pool', 'State', 'Expires in', 'Host name']];
  for (const r of sorted) {
    const left = r.expiresAt === undefined ? 'never' : fmtSince(ctx.now, r.expiresAt);
    out.push([r.ip, macToDotted(r.mac), r.pool, r.state, left, r.hostname ?? '-']);
  }
  return { output: table(out) };
};

const showPool: CommandHandler = (ctx, args) => {
  const wanted = args['name'];
  const views = dhcpPoolViews({ config: ctx.running, tables: ctx.tables });
  const picked = wanted === undefined || wanted === '' ? views : views.filter((v) => v.name === wanted);
  if (picked.length === 0) return { output: wanted === undefined || wanted === '' ? MSG_NO_POOLS : `% No pool named "${wanted}" is configured.` };
  const blocks = picked.map((v) => {
    const lines = [
      `Pool ${v.name}: ${v.network}/${v.prefixLen}`,
      `  Leased ${v.bound}, free ${v.free}, lease ${v.leaseS} s`,
      `  Default gateway: ${v.router ?? 'not set'}`,
      `  Name servers ...: ${v.dns.length === 0 ? 'not set' : v.dns.join(', ')}`,
      `  Domain name ....: ${v.domain ?? 'not set'}`,
    ];
    if (v.excluded.length > 0) lines.push(`  Kept back ......: ${v.excluded.join(', ')}`);
    return lines.join('\n');
  });
  return { output: blocks.join('\n\n') };
};

/** Registry fragment for the CLI runtime: DHCP handler id → handler. */
export const dhcpHandlers: Readonly<Record<string, CommandHandler>> = {
  [HANDLERS.ifIpAddressDhcp]: ipAddressDhcp,
  [HANDLERS.ifHelperAddress]: helperAddress,
  [HANDLERS.configDhcpExcluded]: excludedAddress,
  [HANDLERS.configDhcpPool]: dhcpPool,
  [HANDLERS.poolNetwork]: poolNetwork,
  [HANDLERS.poolDefaultRouter]: poolDefaultRouter,
  [HANDLERS.poolDnsServer]: poolDnsServer,
  [HANDLERS.poolDomainName]: poolDomainName,
  [HANDLERS.poolLease]: poolLease,
  [HANDLERS.showDhcpBinding]: showBinding,
  [HANDLERS.showDhcpPool]: showPool,
};
