/**
 * cli/handlers/pc.ts — host shell address and cache handlers (ARCHITECTURE "P0 CLI surface", spec §2.1
 * troubleshooting row, §7.5 show output reads live state; ARCHITECTURE-P1 §3.13 "Host shell default adapter").
 *
 * Host devices run a single `user-exec` mode at privilege 15 with the host grammar. The commands here:
 *   pc.ip-address  `ip address A M [GW]` / `no ip address` — a pure CLI-side expansion into the same config lines a
 *                  router produces, written via `ctx.config` on the default adapter (`model.hostPorts[0]`):
 *                    ctx.config(['ip','address',A,M], false, [['interface', <adapter>]])
 *                    ctx.config(['ip','default-gateway',GW], false, [])   // only when GW given
 *   pc.ipconfig    `ipconfig [/all|/release|/renew]` — per adapter: link state, MAC, Wi-Fi network, address, mask
 *                  and gateway, from `ports[].l3` and the running-config. `/all` adds where the address came from,
 *                  the lease (dhcp-client's StateView) and the IPv6 addresses; `/release` and `/renew` ask
 *                  dhcp-client with `dhcp.client {iface, op, session}` and block the session until it answers, so
 *                  ^C aborts the wait (ARCHITECTURE-P1 §4.3 "Renew and release").
 *   pc.arp         `arp -a` — the ARP cache in an OS-style listing.
 * Wi-Fi and adapter commands are in handlers/host.ts. Validation produces original error wording (spec §1.6).
 */
import type { CommandCtx, CommandHandler } from '../../contracts/cli.js';
import type { PortId } from '../../contracts/ids.js';
import type { PortView } from '../../contracts/port.js';
import type { ArpRow } from '../../contracts/tables.js';
import { ROLE_TRAITS } from '../../contracts/catalog.js';
import {
  broadcastOf, inSubnet, ipv4ToU32, isIpv4Loopback, isIpv4Multicast, maskToPrefixLen, networkOf, parseIpv4, prefixLenToMask,
} from '../../contracts/addr.js';
import { HANDLERS, IPCONFIG_ALL, IPCONFIG_OPTION_ARG, IPCONFIG_RELEASE, IPCONFIG_RENEW } from '../grammar/index.js';
import { table } from '../format.js';
import { interfaceLine, roleOf } from './common.js';

/** Interface name used when the device exposes no adapter at all (never the case for catalog hosts). */
export const PC_DEFAULT_PORT: PortId = 'GigabitEthernet0';

/** Name of the daemon that leases addresses for this host. */
export const DHCP_CLIENT_PROCESS = 'dhcp-client';
/** Terminal label of the `ipconfig /renew` and `/release` jobs. */
export const IPCONFIG_JOB_LABEL = 'ipconfig';
/** Error for `/renew` or `/release` with no adapter set to DHCP. */
export const MSG_NO_DHCP_ADAPTER = '% No adapter of this host takes its address from DHCP. Run "ip address dhcp" first.';

/**
 * The host's default network adapter: the first entry of `model.hostPorts` that exists on the device, else (models
 * without host ports, such as hand-built fixtures) the first Ethernet port in catalog order.
 */
export function hostPort(ctx: CommandCtx): PortView | undefined {
  for (const id of ctx.model.hostPorts ?? []) {
    const p = ctx.ports.get(id);
    if (p !== undefined) return p;
  }
  for (const p of ctx.ports.values()) if (p.spec.kind === 'ethernet') return p;
  return undefined;
}

/**
 * Every network adapter of the host in display order: `model.hostPorts` that exist, then any other port whose
 * effective role holds L3 addresses and is not virtual (for example a Wi-Fi card installed in the expansion bay).
 */
export function hostAdapters(ctx: CommandCtx): PortView[] {
  const out: PortView[] = [];
  const seen = new Set<PortId>();
  for (const id of ctx.model.hostPorts ?? []) {
    const p = ctx.ports.get(id);
    if (p !== undefined && !seen.has(id)) {
      out.push(p);
      seen.add(id);
    }
  }
  for (const p of ctx.ports.values()) {
    if (seen.has(p.id)) continue;
    const traits = ROLE_TRAITS[roleOf(ctx, p)];
    if (traits.l3 && !traits.virtual) {
      out.push(p);
      seen.add(p.id);
    }
  }
  return out;
}

/**
 * Validate a host address assignment. Returns an error message (original wording) or undefined when
 * `address`/`mask`/`gateway` form a usable host configuration.
 */
export function validateHostAddress(address: string, mask: string, gateway?: string): string | undefined {
  if (parseIpv4(address) === null) return `% "${address}" is not a valid IPv4 address.`;
  const prefixLen = maskToPrefixLen(mask);
  if (prefixLen === null) return `% "${mask}" is not a valid subnet mask: the one bits must be contiguous.`;
  if (prefixLen === 0) return '% A mask of 0.0.0.0 cannot be used for a host address.';
  if (ipv4ToU32(address) === 0) return '% 0.0.0.0 cannot be assigned to a host.';
  if (isIpv4Multicast(address)) return `% ${address} is a multicast address and cannot be assigned to a host.`;
  if (isIpv4Loopback(address)) return `% ${address} is a loopback address and cannot be assigned to an interface.`;
  if (address === '255.255.255.255') return '% 255.255.255.255 is the limited broadcast address.';
  const network = networkOf(address, prefixLen);
  if (prefixLen <= 30) {
    if (address === network) return `% ${address} is the network address of ${network}/${prefixLen}; choose a host address.`;
    if (address === broadcastOf(address, prefixLen)) return `% ${address} is the broadcast address of ${network}/${prefixLen}; choose a host address.`;
  }
  if (gateway !== undefined) {
    if (parseIpv4(gateway) === null) return `% "${gateway}" is not a valid gateway address.`;
    if (gateway === address) return '% The default gateway cannot be the host\'s own address.';
    if (!inSubnet(gateway, network, prefixLen)) return `% Gateway ${gateway} is not on the subnet ${network}/${prefixLen}.`;
    if (ipv4ToU32(gateway) === 0 || isIpv4Multicast(gateway) || isIpv4Loopback(gateway)) {
      return `% ${gateway} cannot be used as a gateway.`;
    }
  }
  return undefined;
}

// ── ip address A M [GW] ─────────────────────────────────────────────────────

const pcIpAddress: CommandHandler = (ctx, args, negate) => {
  const port = hostPort(ctx)?.id ?? ctx.model.hostPorts?.[0] ?? PC_DEFAULT_PORT;
  const ifaceContext = [['interface', port]];
  if (negate) {
    const e1 = ctx.config(['ip', 'address'], true, ifaceContext);
    if (e1) return { error: e1 };
    const e2 = ctx.config(['ip', 'default-gateway'], true, []);
    if (e2) return { error: e2 };
    return { output: `IPv4 address and default gateway removed from ${port}.` };
  }
  const address = args['address'] ?? '';
  const mask = args['mask'] ?? '';
  const gateway = args['gateway'];
  const problem = validateHostAddress(address, mask, gateway);
  if (problem) return { error: problem };
  const e1 = ctx.config(['ip', 'address', address, mask], false, ifaceContext);
  if (e1) return { error: e1 };
  const prefixLen = maskToPrefixLen(mask) ?? 0;
  if (gateway !== undefined) {
    const e2 = ctx.config(['ip', 'default-gateway', gateway], false, []);
    if (e2) return { error: e2 };
    return { output: `${port}: IPv4 address ${address}/${prefixLen}, default gateway ${gateway}.` };
  }
  return { output: `${port}: IPv4 address ${address}/${prefixLen}.` };
};

// ── ipconfig [/all|/release|/renew] ─────────────────────────────────────────

/** Link state word for ipconfig: 'up' (link), 'down' (no link) or 'disabled' (admin down). */
function linkWord(p: PortView): string {
  if (!p.adminUp) return 'disabled';
  return p.operUp ? 'up' : 'down';
}

/** Default gateway from the running-config (`ip default-gateway GW`), if any. */
export function configuredGateway(ctx: CommandCtx): string | undefined {
  return ctx.running.get('ip.default-gateway')?.[0];
}

/** What a DHCP-managed adapter is doing, read from the dhcp-client StateView. */
export interface DhcpClientView {
  state: string;
  lease?: { address: string; prefixLen: number; router?: string; server: string; dns: string[]; domain?: string; leaseS: number; boundAt: number };
}

/** The dhcp-client entry for `iface`, or undefined when the daemon is absent or does not manage that adapter. */
export function dhcpClientView(ctx: CommandCtx, iface: PortId): DhcpClientView | undefined {
  const clients = ctx.processState(DHCP_CLIENT_PROCESS)?.state?.['clients'];
  if (!Array.isArray(clients)) return undefined;
  for (const raw of clients) {
    if (raw === null || typeof raw !== 'object') continue;
    const c = raw as Record<string, unknown>;
    if (c['iface'] !== iface) continue;
    const view: DhcpClientView = { state: typeof c['state'] === 'string' ? c['state'] : 'unknown' };
    const lease = c['lease'];
    if (lease !== null && typeof lease === 'object') view.lease = lease as DhcpClientView['lease'];
    return view;
  }
  return undefined;
}

/** One adapter block of `ipconfig`; `/all` adds the hardware, lease and name-server detail. */
function adapterBlock(ctx: CommandCtx, p: PortView, gateway: string | undefined, all: boolean): string {
  const ip = p.l3.ipv4;
  const dhcp = dhcpClientView(ctx, p.id);
  const lines = [`${p.id} (link ${linkWord(p)})`, `  Physical address ....: ${p.mac}`];
  if (p.spec.kind === 'wlan') {
    const ssid = interfaceLine(ctx, p.id, ['ssid'])?.join(' ');
    lines.push(`  Wireless network ....: ${ssid === undefined ? 'not set' : `${ssid}${p.operUp ? ' (connected)' : ' (not connected)'}`}`);
  }
  if (all) lines.push(`  Address from DHCP ...: ${dhcp === undefined ? 'no' : `yes (${dhcp.state})`}`);
  lines.push(
    `  IPv4 address ........: ${ip ? ip.address : 'not set'}${all && ip?.origin !== undefined ? ` (${ip.origin})` : ''}`,
    `  Subnet mask .........: ${ip ? prefixLenToMask(ip.prefixLen) : 'not set'}`,
    `  Default gateway .....: ${dhcp?.lease?.router ?? gateway ?? 'not set'}`,
  );
  if (all) {
    const lease = dhcp?.lease;
    if (lease !== undefined) {
      lines.push(
        `  DHCP server .........: ${lease.server}`,
        `  Lease length ........: ${lease.leaseS} s`,
      );
      if (lease.domain !== undefined) lines.push(`  Domain name .........: ${lease.domain}`);
      if (lease.dns.length > 0) lines.push(`  Name servers ........: ${lease.dns.join(', ')}`);
    }
    const configured = nameServersOf(ctx);
    if (lease === undefined && configured.length > 0) lines.push(`  Name servers ........: ${configured.join(', ')}`);
    const v6 = p.l3.ipv6 ?? [];
    for (const a of v6) lines.push(`  IPv6 address ........: ${a.address}/${a.prefixLen} (${a.origin}, ${a.state})`);
  }
  return lines.join('\n');
}

/** Addresses of the global `ip name-server` lines, in config order. */
export function nameServersOf(ctx: CommandCtx): string[] {
  const out: string[] = [];
  for (const node of ctx.running.root.children) {
    if (node.key !== 'ip') continue;
    for (const child of node.children) {
      if (child.key !== 'name-server') continue;
      for (const v of child.args) if (!out.includes(v)) out.push(v);
    }
  }
  return out;
}

const pcIpconfig: CommandHandler = (ctx, args) => {
  const adapters = hostAdapters(ctx);
  if (adapters.length === 0) return { error: '% This host has no network interface.' };
  const option = args[IPCONFIG_OPTION_ARG];
  if (option === IPCONFIG_RENEW || option === IPCONFIG_RELEASE) return dhcpJob(ctx, adapters, option === IPCONFIG_RENEW ? 'renew' : 'release');
  const gateway = configuredGateway(ctx);
  return { output: adapters.map((p) => adapterBlock(ctx, p, gateway, option === IPCONFIG_ALL)).join('\n\n') };
};

/** `ipconfig /renew` and `ipconfig /release`: ask dhcp-client on every DHCP-managed adapter and wait for it. */
function dhcpJob(ctx: CommandCtx, adapters: readonly PortView[], op: 'renew' | 'release'): ReturnType<CommandHandler> {
  const managed = adapters.filter((p) => dhcpClientView(ctx, p.id) !== undefined);
  if (managed.length === 0) return { error: MSG_NO_DHCP_ADAPTER };
  // Block BEFORE the request: a release that finishes at once answers with `cliDone` during it.
  ctx.block({ process: DHCP_CLIENT_PROCESS, abort: { kind: 'job.abort', session: ctx.session.id }, label: IPCONFIG_JOB_LABEL });
  for (const p of managed) ctx.request(DHCP_CLIENT_PROCESS, { kind: 'dhcp.client', iface: p.id, op, session: ctx.session.id });
  return {};
}

// ── arp -a ──────────────────────────────────────────────────────────────────

/** OS-style dashed MAC: `00-1f-00-00-00-02`. */
export function macDashed(mac: string): string {
  return mac.replace(/:/g, '-');
}

/** ARP rows grouped by interface in catalog port order, each group sorted by IP. */
export function arpRowsByInterface(ctx: CommandCtx): Map<PortId, ArpRow[]> {
  const groups = new Map<PortId, ArpRow[]>();
  for (const p of ctx.ports.values()) groups.set(p.id, []);
  for (const r of ctx.tables.arp.rows()) {
    let list = groups.get(r.iface);
    if (!list) {
      list = [];
      groups.set(r.iface, list);
    }
    list.push(r);
  }
  for (const list of groups.values()) list.sort((a, b) => ipv4ToU32(a.ip) - ipv4ToU32(b.ip));
  return groups;
}

const pcArp: CommandHandler = (ctx) => {
  const groups = arpRowsByInterface(ctx);
  const blocks: string[] = [];
  for (const [iface, rows] of groups) {
    if (rows.length === 0) continue;
    const own = ctx.ports.get(iface)?.l3.ipv4?.address ?? 'no address';
    const out: string[][] = [['IPv4 address', 'MAC address', 'Kind']];
    for (const r of rows) out.push([r.ip, r.incomplete ? 'incomplete' : macDashed(r.mac), r.type]);
    blocks.push(`Interface: ${own} --- ${iface}\n${table(out, { indent: '  ' })}`);
  }
  if (blocks.length === 0) return { output: 'No ARP entries found.' };
  return { output: blocks.join('\n\n') };
};

/** Registry fragment for the CLI runtime: PC handler id → handler. */
export const pcHandlers: Readonly<Record<string, CommandHandler>> = {
  [HANDLERS.pcIpAddress]: pcIpAddress,
  [HANDLERS.pcIpconfig]: pcIpconfig,
  [HANDLERS.pcArp]: pcArp,
};
