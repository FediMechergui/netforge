/**
 * cli/handlers/dhcpv6.ts — the DHCPv6 pool section, its interface lines and `show ipv6 dhcp pool|binding|interface`
 * (ARCHITECTURE-P2 §3.11, §5.2, §5.4, D16; §7 W3 cli).
 *
 * `ipv6 dhcp pool <name>` stores the section and enters `config-dhcpv6`; inside it `address prefix <p/len>
 * [lifetime <valid> <preferred>]` (the prefix canonical; a preferred lifetime never above the valid one),
 * `dns-server <a>` (several, canonical) and `domain-name <d>`. On an interface: `ipv6 dhcp server <pool>` (a
 * missing pool earns a note, the line is stored), `ipv6 nd managed-config-flag`, `ipv6 nd other-config-flag` and
 * the client's `ipv6 address dhcp`. dhcpv6-server, nd, ipv6 and dhcpv6-client are the consumers.
 *
 * Show commands read live state: the pool sections and interface lines of the running config, the
 * `dhcpv6-bindings` table (writer: dhcpv6-server) and the ports' leased addresses (origin `dhcpv6`). Every string
 * is original wording (spec §1.6).
 */
import type { CommandCtx, CommandHandler } from '../../contracts/cli.js';
import type { ConfigNode } from '../../contracts/config.js';
import type { PortId } from '../../contracts/ids.js';
import type { PortView } from '../../contracts/port.js';
import type { Dhcpv6BindingRow } from '../../contracts/tables.js';
import { cidr6, normalizeIpv6, parseCidr6 } from '../../core/addr6.js';
import { P2_HANDLERS } from '../grammar/index.js';
import { fmtDuration, table } from '../format.js';
import { enterMode, MSG_NO_INTERFACE_SELECTED, outcomeOf, selectedInterface } from './common.js';
import { interfaceLinesOf } from './nat.js';

/** Messages of the pool lines. */
export const MSG_NO_POOL6_SELECTED = '% Select a pool first (ipv6 dhcp pool <name>).';
export const MSG_BAD_PREFIX6 = '% Expected an IPv6 prefix in X:X:X:X::X/nn form.';
export const MSG_BAD_LIFETIME = '% Lifetimes are seconds (or infinite), and the preferred lifetime is never above the valid one.';
export const MSG_BAD_DNS6 = '% Expected an IPv6 address (X:X:X:X::X).';
/** `ipv6 dhcp server <pool>` naming a pool that does not exist yet (the line is stored). */
export const MSG_POOL6_MISSING = '% Note: there is no pool named {pool} yet; the server answers once it exists.';
/** Show messages. */
export const MSG_NO_POOL6 = 'No DHCPv6 pool is configured.';
export const MSG_NO_BINDING6 = 'No IPv6 address is leased.';
export const MSG_NO_DHCPV6_INTERFACE = 'No interface has a DHCPv6 role.';

/** A pool as the running config describes it. */
export interface Dhcpv6PoolView {
  name: string;
  prefix?: string;
  validLifetime?: string;
  preferredLifetime?: string;
  dnsServers: string[];
  domainName?: string;
  /** Interfaces with `ipv6 dhcp server <name>`. */
  interfaces: PortId[];
}

/** The `ipv6 dhcp pool <name>` section node, if any. */
export function pool6Section(ctx: CommandCtx, name: string): ConfigNode | undefined {
  return ctx.running.root.children.find((c) => c.key === 'ipv6' && c.args[0] === 'dhcp' && c.args[1] === 'pool' && c.args[2] === name);
}

/** Every pool of the running config, in config order. */
export function dhcpv6Pools(ctx: CommandCtx): Dhcpv6PoolView[] {
  const out: Dhcpv6PoolView[] = [];
  for (const c of ctx.running.root.children) {
    if (c.key !== 'ipv6' || c.args[0] !== 'dhcp' || c.args[1] !== 'pool' || c.args[2] === undefined) continue;
    const view: Dhcpv6PoolView = { name: c.args[2], dnsServers: [], interfaces: [] };
    for (const line of c.children) {
      if (line.key === 'address' && line.args[0] === 'prefix') {
        view.prefix = line.args[1];
        if (line.args[2] === 'lifetime') {
          view.validLifetime = line.args[3];
          view.preferredLifetime = line.args[4];
        }
      } else if (line.key === 'dns-server' && line.args[0] !== undefined) view.dnsServers.push(line.args[0]);
      else if (line.key === 'domain-name') view.domainName = line.args[0];
    }
    out.push(view);
  }
  for (const port of ctx.ports.keys()) {
    const served = serverPoolOf(ctx, port);
    const pool = served === undefined ? undefined : out.find((p) => p.name === served);
    if (pool !== undefined) pool.interfaces.push(port);
  }
  return out;
}

/** The pool an interface serves (`ipv6 dhcp server <pool>`), if any. */
export function serverPoolOf(ctx: CommandCtx, port: PortId): string | undefined {
  for (const t of interfaceLinesOf(ctx, port)) if (t[0] === 'ipv6' && t[1] === 'dhcp' && t[2] === 'server') return t[3];
  return undefined;
}

/** Whether an interface carries `ipv6 <...tokens>`. */
function hasIpv6Line(ctx: CommandCtx, port: PortId, tokens: readonly string[]): boolean {
  return interfaceLinesOf(ctx, port).some((t) => t[0] === 'ipv6' && tokens.every((tok, i) => t[i + 1] === tok) && t.length === tokens.length + 1);
}

// ── pool section ────────────────────────────────────────────────────────────────────────────────────────────────

/** `ipv6 dhcp pool <name>` / its `no` form. */
const pool6: CommandHandler = (ctx, args, negate) => {
  const name = args['name'] ?? '';
  if (name === '') return { error: '% Give the pool a name.' };
  const line = ['ipv6', 'dhcp', 'pool', name];
  if (negate) return outcomeOf(ctx.config(line, true, []));
  const error = ctx.config(line, false, []);
  if (error !== undefined) return { error };
  enterMode(ctx, 'config-dhcpv6', [line]);
  return {};
};

/** The selected pool name, or undefined outside a pool section. */
function selectedPool(ctx: CommandCtx): string | undefined {
  const entry = ctx.context[ctx.context.length - 1];
  return entry?.[0] === 'ipv6' && entry[1] === 'dhcp' && entry[2] === 'pool' ? entry[3] : undefined;
}

/** A lifetime token: seconds (an integer) or `infinite`; the number, or Infinity, or undefined. */
function lifetimeOf(text: string | undefined): number | undefined {
  if (text === 'infinite') return Number.POSITIVE_INFINITY;
  if (text === undefined || !/^\d{1,10}$/.test(text)) return undefined;
  return Number(text);
}

/** `address prefix <p/len> [lifetime <valid> <preferred>]` / `no address prefix`. */
const addressPrefix: CommandHandler = (ctx, args, negate) => {
  if (selectedPool(ctx) === undefined) return { error: MSG_NO_POOL6_SELECTED };
  if (negate) return outcomeOf(ctx.config(['address', 'prefix'], true));
  const parsed = parseCidr6(args['prefix'] ?? '');
  if (parsed === null) return { error: MSG_BAD_PREFIX6 };
  const line = ['address', 'prefix', cidr6(parsed.network, parsed.prefixLen)];
  const valid = args['valid'];
  const preferred = args['preferred'];
  if (valid !== undefined || preferred !== undefined) {
    const v = lifetimeOf(valid);
    const p = lifetimeOf(preferred);
    if (v === undefined || p === undefined || p > v) return { error: MSG_BAD_LIFETIME };
    line.push('lifetime', valid as string, preferred as string);
  }
  return outcomeOf(ctx.config(line, false));
};

/** `dns-server <a>` / `no dns-server [<a>]` inside a pool. */
const dnsServer: CommandHandler = (ctx, args, negate) => {
  if (selectedPool(ctx) === undefined) return { error: MSG_NO_POOL6_SELECTED };
  const raw = args['address'];
  if (negate && (raw === undefined || raw === '')) return outcomeOf(ctx.config(['dns-server'], true));
  const address = normalizeIpv6(raw ?? '');
  if (address === null) return { error: MSG_BAD_DNS6 };
  return outcomeOf(ctx.config(['dns-server', address], negate));
};

/** `domain-name <d>` / `no domain-name` inside a pool. */
const domainName: CommandHandler = (ctx, args, negate) => {
  if (selectedPool(ctx) === undefined) return { error: MSG_NO_POOL6_SELECTED };
  if (negate) return outcomeOf(ctx.config(['domain-name'], true));
  const name = args['name'] ?? '';
  if (name === '') return { error: '% Give the domain name.' };
  return outcomeOf(ctx.config(['domain-name', name], false));
};

// ── interface lines ─────────────────────────────────────────────────────────────────────────────────────────────

/** `ipv6 dhcp server <pool>` / `no ipv6 dhcp server`. */
const ifServer: CommandHandler = (ctx, args, negate) => {
  if (selectedInterface(ctx) === undefined) return { error: MSG_NO_INTERFACE_SELECTED };
  if (negate) return outcomeOf(ctx.config(['ipv6', 'dhcp', 'server'], true));
  const pool = args['pool'] ?? '';
  if (pool === '') return { error: '% Name the pool to serve.' };
  const error = ctx.config(['ipv6', 'dhcp', 'server', pool], false);
  if (error !== undefined) return { error };
  return pool6Section(ctx, pool) === undefined ? { output: MSG_POOL6_MISSING.replace('{pool}', pool) } : {};
};

/** A plain interface line. */
function ifLine(line: readonly string[]): CommandHandler {
  return (ctx, _args, negate) => {
    if (selectedInterface(ctx) === undefined) return { error: MSG_NO_INTERFACE_SELECTED };
    return outcomeOf(ctx.config([...line], negate));
  };
}

// ── show ────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Lifetime text: seconds, infinite, or the default note. */
function lifetimeText(value: string | undefined, fallback: string): string {
  if (value === undefined) return fallback;
  return value === 'infinite' ? 'infinite' : `${value} s`;
}

/** One pool block of `show ipv6 dhcp pool`. */
export function renderPool6(ctx: CommandCtx, p: Dhcpv6PoolView): string {
  const bindings = (ctx.tables.get?.<Dhcpv6BindingRow>('dhcpv6-bindings')?.rows() ?? []).filter((b) => b.pool === p.name).length;
  const lines = [`Pool ${p.name}`];
  if (p.prefix === undefined) lines.push('  Addresses: none (stateless: settings only)');
  else lines.push(`  Addresses from: ${p.prefix}   valid ${lifetimeText(p.validLifetime, '2592000 s (default)')}, preferred ${lifetimeText(p.preferredLifetime, '604800 s (default)')}`);
  lines.push(`  Name servers: ${p.dnsServers.length === 0 ? 'none' : p.dnsServers.join(', ')}`);
  lines.push(`  Domain name: ${p.domainName ?? 'none'}`);
  lines.push(`  Served on: ${p.interfaces.length === 0 ? 'no interface' : p.interfaces.join(', ')}`);
  lines.push(`  Active leases: ${bindings}`);
  return lines.join('\n');
}

const showPool: CommandHandler = (ctx) => {
  const pools = dhcpv6Pools(ctx);
  if (pools.length === 0) return { output: MSG_NO_POOL6 };
  return { output: pools.map((p) => renderPool6(ctx, p)).join('\n\n') };
};

const showBinding: CommandHandler = (ctx) => {
  const rows = ctx.tables.get?.<Dhcpv6BindingRow>('dhcpv6-bindings')?.rows() ?? [];
  if (rows.length === 0) return { output: MSG_NO_BINDING6 };
  const out: string[][] = [['Address', 'Client identifier', 'IAID', 'Pool', 'Preferred for', 'Valid for']];
  for (const r of rows) {
    out.push([r.address, r.duid, String(r.iaid), r.pool, r.preferredUntil === undefined ? '-' : fmtDuration(r.preferredUntil - ctx.now), r.expiresAt === undefined ? 'ever' : fmtDuration(r.expiresAt - ctx.now)]);
  }
  return { output: table(out) };
};

/** One interface block of `show ipv6 dhcp interface`, or undefined when the interface has no DHCPv6 role. */
export function renderDhcpv6Interface(ctx: CommandCtx, p: PortView): string | undefined {
  const pool = serverPoolOf(ctx, p.id);
  const client = hasIpv6Line(ctx, p.id, ['address', 'dhcp']);
  const managed = hasIpv6Line(ctx, p.id, ['nd', 'managed-config-flag']);
  const other = hasIpv6Line(ctx, p.id, ['nd', 'other-config-flag']);
  if (pool === undefined && !client && !managed && !other) return undefined;
  const lines = [p.id];
  if (pool !== undefined) lines.push(`  Server: pool ${pool}${pool6Section(ctx, pool) === undefined ? ' (does not exist)' : ''}`);
  if (client) {
    const leased = (p.l3.ipv6 ?? []).filter((a) => a.origin === 'dhcpv6');
    lines.push(`  Client: ${leased.length === 0 ? 'waiting for a lease' : leased.map((a) => `${a.address} (${a.state}${a.validUntil === undefined ? '' : `, valid for ${fmtDuration(a.validUntil - ctx.now)}`})`).join(', ')}`);
  }
  if (managed || other) lines.push(`  Advertised flags: ${[managed ? 'managed address (M)' : '', other ? 'other settings (O)' : ''].filter((s) => s !== '').join(', ')}`);
  return lines.join('\n');
}

const showInterface: CommandHandler = (ctx) => {
  const blocks: string[] = [];
  for (const p of ctx.ports.values()) {
    const block = renderDhcpv6Interface(ctx, p);
    if (block !== undefined) blocks.push(block);
  }
  return { output: blocks.length === 0 ? MSG_NO_DHCPV6_INTERFACE : blocks.join('\n\n') };
};

/** @since P2 Registry fragment: the DHCPv6 lines and show commands. */
export const dhcpv6Handlers: Readonly<Record<string, CommandHandler>> = {
  [P2_HANDLERS.configIpv6DhcpPool]: pool6,
  [P2_HANDLERS.pool6AddressPrefix]: addressPrefix,
  [P2_HANDLERS.pool6DnsServer]: dnsServer,
  [P2_HANDLERS.pool6DomainName]: domainName,
  [P2_HANDLERS.ifIpv6DhcpServer]: ifServer,
  [P2_HANDLERS.ifIpv6NdManagedFlag]: ifLine(['ipv6', 'nd', 'managed-config-flag']),
  [P2_HANDLERS.ifIpv6NdOtherFlag]: ifLine(['ipv6', 'nd', 'other-config-flag']),
  [P2_HANDLERS.ifIpv6AddressDhcp]: ifLine(['ipv6', 'address', 'dhcp']),
  [P2_HANDLERS.showIpv6DhcpPool]: showPool,
  [P2_HANDLERS.showIpv6DhcpBinding]: showBinding,
  [P2_HANDLERS.showIpv6DhcpInterface]: showInterface,
};
