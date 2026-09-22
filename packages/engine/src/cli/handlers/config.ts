/**
 * cli/handlers/config.ts — global and shared interface configuration handlers (spec §7.3, §7.4; ARCHITECTURE
 * "Config flow", "P0 CLI surface"; ARCHITECTURE-P1 §3.10, §6).
 *
 * Every handler validates its arguments, then writes the canonical line through `ctx.config(line, negate, context)`
 * so the change flows CLI → `DeviceRuntime.applyConfigLine` → `ConfigAst` → `ConfigDelta` → daemons. Nothing here
 * touches ports or tables directly: `shutdown` is a config line the runtime turns into `adminUp`, `ip address` a line
 * the ipv4 daemon turns into `setPortL3` + connected routes.
 *
 * Global: `hostname`, `interface` (fixed, module and virtual; `no interface` for virtual ones), `ip route`,
 * `ip default-gateway`, `banner motd`, `enable secret`.
 * Interface: `ip address`, `shutdown`, `description`, `duplex`, `speed`, `mac-address` (NetForge extension).
 * `end` / `exit` live in handlers/exec.ts; serial, switchport and radio lines in their own handler files.
 *
 * P2 (ARCHITECTURE-P2 §3.4, §5.2, D11, D13; W2 cli): `interface g0/0.10` creates a router subinterface (through
 * `ensureVirtualPort`, names.ts resolves the name) and enters `config-subif`; `ip address` on a subinterface without
 * its `encapsulation dot1Q` is refused (`CLI_MESSAGES.subifNeedsEncap`); `ip route <net> <mask> <nh>|<if> [<nh>]
 * [<ad 1-255>] [permanent]` stores the canonical §5.2 line (an interface as its canonical id, a distance of 1 left
 * out), and `no ip route <net> <mask> <nh>|<if> [<nh>]` removes every stored line for that destination and hop
 * whatever its distance (falling back to the exact line when none matches).
 *
 * Every user-facing string is original wording (spec §1.6).
 */
import { CLI_MESSAGES, type CommandCtx, type CommandHandler } from '../../contracts/cli.js';
import type { PortId } from '../../contracts/ids.js';
import type { PortView } from '../../contracts/port.js';
import {
  broadcastOf,
  inSubnet,
  isIpv4Loopback,
  isIpv4Multicast,
  maskToPrefixLen,
  networkOf,
  parseIpv4,
  u32ToIpv4,
} from '../../contracts/addr.js';
import { VIRTUAL_PORT_MESSAGES } from '../../device/ports.js';
import { BANNER_TYPE_ARG, HANDLERS, MSG_INTERFACE_NOT_CONFIGURABLE, ROUTE_TAIL_ARG } from '../grammar/index.js';
import { isSubinterfaceName } from '../modes.js';
import { secretTokens } from '../secrets.js';
import {
  cliError,
  enterMode,
  fillTemplate,
  globalContext,
  isConfigurablePort,
  isVirtualInterfaceName,
  MSG_NO_INTERFACE_SELECTED,
  outcomeOf,
  roleOf,
  selectedInterface,
  selectedPort,
} from './common.js';

export { MSG_NO_INTERFACE_SELECTED } from './common.js';

/** Accepted host names: a letter, then up to 62 letters, digits, hyphens or underscores. */
export const HOSTNAME_RE = /^[A-Za-z][A-Za-z0-9_-]{0,62}$/;

/** Error for a host name that fails `HOSTNAME_RE`. */
export const MSG_BAD_HOSTNAME =
  '% Invalid host name: start with a letter and use only letters, digits, hyphens and underscores (63 characters at most).';
/** Error for `interface <name>` with a name the device does not have. */
export const MSG_UNKNOWN_INTERFACE = '% No such interface on this device.';
/** Error for `interface Vlan<n>` on a runtime that cannot create virtual interfaces. */
export const MSG_CANNOT_CREATE_INTERFACE = '% This device cannot create that interface.';
/** Error for an `ip address` whose host part is all-zeros or all-ones. */
export const MSG_BAD_MASK = '% Bad mask: that address is the network or broadcast address of the subnet.';
/** Error for an `ip address` that can never be an interface address. */
export const MSG_BAD_ADDRESS = '% Invalid interface address.';
/** Error for `ip route` when the network has host bits set under the mask. */
export const MSG_ROUTE_HOST_BITS = '% The network address has host bits set for that mask.';
/** Error for an `ip route` next hop that is neither an address nor an interface. */
export const MSG_BAD_NEXT_HOP = '% Next hop must be an IPv4 address (A.B.C.D) or an interface name.';
/** @since P2 Error for an `ip route` option after the next hop that is none of the §5.2 forms. */
export const MSG_BAD_ROUTE_OPTION = '% After the next hop give only a next-hop address (after an exit interface), a distance from 1 to 255 and/or permanent.';
/** @since P2 Error for a second next-hop address on an `ip route` line that already names one. */
export const MSG_ROUTE_TWO_HOPS = '% A next-hop address may follow an exit interface only; this route already names a next hop.';
/** Error for `banner motd` without any text. */
export const MSG_BANNER_EMPTY = '% Banner text is required.';
/** Error for an `enable secret` with no text. */
export const MSG_BAD_SECRET = '% Give the secret to set.';
/** Error for an `ip default-gateway` address that cannot be a gateway. */
export const MSG_BAD_GATEWAY = '% That address cannot be used as a default gateway.';

/**
 * Strip a delimiter pair from banner text the way a device console does: when the first character is not a
 * letter/digit/space and appears again later, the text between the first and the last occurrence is the banner.
 */
export function stripBannerDelimiters(text: string): string {
  const t = text.trim();
  if (t.length < 2) return t;
  if (t.startsWith('^C')) {
    // The conventional two-character delimiter the config renderer also uses.
    const close = t.indexOf('^C', 2);
    if (close !== -1) return t.slice(2, close);
  }
  const d = t.charAt(0);
  if (/[A-Za-z0-9\s]/.test(d)) return t;
  const last = t.lastIndexOf(d);
  if (last <= 0) return t;
  return t.slice(1, last);
}

// ── global configuration ──────────────────────────────────────────────────────

/** `hostname <name>` / `no hostname`. */
const hostname: CommandHandler = (ctx, args, negate) => {
  if (negate) return outcomeOf(ctx.config(['hostname'], true, globalContext()));
  const name = args['name'] ?? '';
  if (!HOSTNAME_RE.test(name)) return { error: MSG_BAD_HOSTNAME };
  ctx.device.setHostname(name);
  return {};
};

/** `no interface <virtual>`: remove a creatable virtual interface (never a fixed or module port). */
function removeInterface(ctx: CommandCtx, name: PortId, existing: PortView | undefined): { error?: string } {
  if (existing !== undefined && existing.spec.kind !== 'virtual') {
    return { error: cliError(fillTemplate(VIRTUAL_PORT_MESSAGES.notVirtual, { name })) };
  }
  const r = ctx.device.removeVirtualPort(name);
  return r.ok ? {} : { error: cliError(r.error ?? fillTemplate(VIRTUAL_PORT_MESSAGES.noSuchInterface, { name })) };
}

/**
 * `interface <name>`: select an interface and enter interface configuration. A virtual interface that does not exist
 * yet (`interface Loopback1`) is created first; `no interface <virtual>` removes one.
 */
const iface: CommandHandler = (ctx, args, negate) => {
  const raw = args['iface'] ?? '';
  let port: PortId | undefined = ctx.ports.has(raw) ? raw : ctx.resolvePort(raw);
  const existing = port !== undefined ? ctx.ports.get(port) : undefined;
  if (negate) return removeInterface(ctx, existing?.id ?? port ?? raw, existing);
  if (existing === undefined) {
    // P2 (D11): a subinterface name (`g0/0.10`) is creatable too; the device resolves and refuses it itself.
    if (!isVirtualInterfaceName(raw) && !isSubinterfaceName(raw)) return { error: MSG_UNKNOWN_INTERFACE };
    const created = ctx.device.ensureVirtualPort(raw);
    if (!created.ok) return { error: cliError(created.error) };
    port = created.port;
  } else if (!isConfigurablePort(ctx, existing)) {
    return { error: MSG_INTERFACE_NOT_CONFIGURABLE };
  }
  const target = port ?? raw;
  // Make the section exist even when nothing is configured under it; a no-op if present.
  const error = ctx.config(['interface', target], false, globalContext());
  if (error !== undefined) return { error };
  enterMode(ctx, isSubinterfaceName(target) ? 'config-subif' : 'config-if', [['interface', target]]);
  return {};
};

/** @since P2 The parsed tail of an `ip route` line: `[<nh>] [<ad>] [permanent]` after the first hop. */
export interface RouteTail {
  /** Next-hop address after an exit interface (fully specified route). */
  via?: string;
  /** Administrative distance 1–255 (absent = 1). */
  distance?: number;
  permanent: boolean;
}

/**
 * @since P2 Parse the optional tail of `ip route` (§5.2): a next-hop address (only after an exit interface), a
 * distance from 1 to 255, and `permanent` (any prefix of the word), in any order, each at most once. Returns the
 * original error message on anything else.
 */
export function parseRouteTail(tail: string, hopIsInterface: boolean): RouteTail | string {
  const out: RouteTail = { permanent: false };
  for (const tok of tail.trim().split(/\s+/).filter((t) => t.length > 0)) {
    const address = parseIpv4(tok);
    if (address !== null && !/^\d{1,3}$/.test(tok)) {
      if (!hopIsInterface) return MSG_ROUTE_TWO_HOPS;
      if (out.via !== undefined) return MSG_BAD_ROUTE_OPTION;
      out.via = u32ToIpv4(address);
      continue;
    }
    if (/^\d{1,3}$/.test(tok)) {
      const n = Number(tok);
      if (n < 1 || n > 255 || out.distance !== undefined) return MSG_BAD_ROUTE_OPTION;
      out.distance = n;
      continue;
    }
    if ('permanent'.startsWith(tok.toLowerCase()) && !out.permanent) {
      out.permanent = true;
      continue;
    }
    return MSG_BAD_ROUTE_OPTION;
  }
  return out;
}

/** Stored `ip route …` lines of the running config (args after `route`), in stored order. */
function storedIpRoutes(ctx: CommandCtx): string[][] {
  return ctx.running.query('ip.route').map((n) => n.args.slice());
}

/**
 * `ip route <network> <mask> <next-hop|interface> [<next-hop>] [<distance>] [permanent]` and its `no` form. The
 * stored line is the canonical §5.2 form; `no ip route` removes every stored line for the same destination and hop
 * (any distance), or the exact typed line when none matches.
 */
const ipRoute: CommandHandler = (ctx, args, negate) => {
  const network = args['network'] ?? '';
  const mask = args['mask'] ?? '';
  const nextHopRaw = args['nexthop'] ?? '';
  const net = parseIpv4(network);
  const len = maskToPrefixLen(mask);
  const maskValue = parseIpv4(mask);
  if (net === null) return { error: '% Expected a destination network address (A.B.C.D).' };
  if (len === null || maskValue === null) return { error: '% Expected a contiguous subnet mask such as 255.255.255.0.' };
  if (networkOf(u32ToIpv4(net), len) !== u32ToIpv4(net)) return { error: MSG_ROUTE_HOST_BITS };
  let nextHop: string;
  let hopIsInterface = false;
  const nh = parseIpv4(nextHopRaw);
  if (nh !== null) {
    nextHop = u32ToIpv4(nh);
  } else {
    const port = ctx.resolvePort(nextHopRaw);
    if (port === undefined || !ctx.ports.has(port)) return { error: MSG_BAD_NEXT_HOP };
    nextHop = port;
    hopIsInterface = true;
  }
  const tail = parseRouteTail(args[ROUTE_TAIL_ARG] ?? '', hopIsInterface);
  if (typeof tail === 'string') return { error: tail };
  const head = [u32ToIpv4(net), u32ToIpv4(maskValue), nextHop, ...(tail.via === undefined ? [] : [tail.via])];
  const line = [
    'ip',
    'route',
    ...head,
    ...(tail.distance !== undefined && tail.distance !== 1 ? [String(tail.distance)] : []),
    ...(tail.permanent ? ['permanent'] : []),
  ];
  if (!negate) return outcomeOf(ctx.config(line, false, globalContext()));
  // `no ip route N M hop [via]`: every stored line for that destination and hop, whatever its distance or flag.
  const matches = storedIpRoutes(ctx).filter((stored) => {
    if (stored.length < head.length) return false;
    for (let i = 0; i < head.length; i++) if (stored[i] !== head[i]) return false;
    // without a typed via, a stored fully specified route (an address right after the interface) is another route
    const after = stored[head.length];
    return tail.via !== undefined || after === undefined || /^\d{1,3}$/.test(after) || parseIpv4(after) === null;
  });
  if (matches.length === 0) return outcomeOf(ctx.config(line, true, globalContext()));
  for (const stored of matches) {
    const error = ctx.config(['ip', 'route', ...stored], true, globalContext());
    if (error !== undefined) return { error };
  }
  return {};
};

/** `ip default-gateway <gateway>` / `no ip default-gateway`: the management gateway of a device that does not route. */
const defaultGateway: CommandHandler = (ctx, args, negate) => {
  if (negate) return outcomeOf(ctx.config(['ip', 'default-gateway'], true, globalContext()));
  const gateway = args['gateway'] ?? '';
  const v = parseIpv4(gateway);
  if (v === null) return { error: '% Expected an IPv4 address in dotted-decimal form (A.B.C.D).' };
  const text = u32ToIpv4(v);
  if (v === 0 || text === '255.255.255.255' || isIpv4Multicast(text) || isIpv4Loopback(text)) return { error: MSG_BAD_GATEWAY };
  return outcomeOf(ctx.config(['ip', 'default-gateway', text], false, globalContext()));
};

/** `banner motd|login|exec <text>` / its `no` form; the type comes from the spec's `fixedArgs`. */
const banner: CommandHandler = (ctx, args, negate) => {
  const type = args[BANNER_TYPE_ARG] ?? 'motd';
  if (negate) return outcomeOf(ctx.config(['banner', type], true, globalContext()));
  const text = stripBannerDelimiters(args['text'] ?? '');
  if (text === '') return { error: MSG_BANNER_EMPTY };
  return outcomeOf(ctx.config(['banner', type, text], false, globalContext()));
};

/**
 * `enable secret <text>` / `no enable secret`. The plain text never reaches the config: it is hashed through
 * `CommandCtx.secrets` and stored as `enable secret nf1 <hash>` (ARCHITECTURE-P1 §4.10).
 */
const enableSecret: CommandHandler = (ctx, args, negate) => {
  if (negate) return outcomeOf(ctx.config(['enable', 'secret'], true, globalContext()));
  const secret = args['secret'] ?? '';
  if (secret === '') return { error: MSG_BAD_SECRET };
  return outcomeOf(ctx.config(['enable', 'secret', ...secretTokens(ctx.secrets.hash(secret))], false, globalContext()));
};

// ── interface configuration ───────────────────────────────────────────────────

/**
 * Validate an interface address/mask pair. Returns an error message, or undefined when the pair is acceptable on
 * `port` given the other ports' addresses.
 */
export function validateInterfaceAddress(ctx: CommandCtx, port: PortId, address: string, mask: string): string | undefined {
  const a = parseIpv4(address);
  const len = maskToPrefixLen(mask);
  if (a === null) return '% Expected an IPv4 address in dotted-decimal form (A.B.C.D).';
  if (len === null) return '% Expected a contiguous subnet mask such as 255.255.255.0.';
  const ip = u32ToIpv4(a);
  if (a === 0 || len === 0 || isIpv4Loopback(ip) || isIpv4Multicast(ip) || ip === '255.255.255.255') return MSG_BAD_ADDRESS;
  if (len <= 30 && (networkOf(ip, len) === ip || broadcastOf(ip, len) === ip)) return MSG_BAD_MASK;
  for (const [id, view] of ctx.ports) {
    if (id === port) continue;
    const other = view.l3.ipv4;
    if (other === undefined) continue;
    const shortest = Math.min(len, other.prefixLen);
    if (inSubnet(ip, other.address, shortest)) {
      return `% That subnet overlaps with the address already on ${id}.`;
    }
  }
  return undefined;
}

/** `ip address <address> <mask>` / `no ip address` under an interface. */
const ipAddress: CommandHandler = (ctx, args, negate) => {
  const port = selectedInterface(ctx);
  if (port === undefined) return { error: MSG_NO_INTERFACE_SELECTED };
  if (negate) return outcomeOf(ctx.config(['ip', 'address'], true));
  // P2 (§3.4 step 2): a subinterface needs its 802.1Q encapsulation before an address.
  const view = selectedPort(ctx);
  if (view !== undefined && roleOf(ctx, view) === 'subif' && view.dot1q === undefined) return { error: CLI_MESSAGES.subifNeedsEncap };
  const address = args['address'] ?? '';
  const mask = args['mask'] ?? '';
  const bad = validateInterfaceAddress(ctx, port, address, mask);
  if (bad !== undefined) return { error: bad };
  return outcomeOf(ctx.config(['ip', 'address', u32ToIpv4(parseIpv4(address) ?? 0), u32ToIpv4(parseIpv4(mask) ?? 0)], false));
};

/** `shutdown` / `no shutdown`: a config line the device runtime turns into the admin state. */
const shutdown: CommandHandler = (ctx, _args, negate) => {
  if (selectedInterface(ctx) === undefined) return { error: MSG_NO_INTERFACE_SELECTED };
  return outcomeOf(ctx.config(['shutdown'], negate));
};

/** `description <text>` / `no description`. */
const description: CommandHandler = (ctx, args, negate) => {
  if (selectedInterface(ctx) === undefined) return { error: MSG_NO_INTERFACE_SELECTED };
  if (negate) return outcomeOf(ctx.config(['description'], true));
  const text = (args['text'] ?? '').trim();
  if (text === '') return { error: '% Description text is required.' };
  return outcomeOf(ctx.config(['description', text], false));
};

/** Shared shape of `duplex <mode>` / `speed <rate>` / `mac-address <mac>`: one single-valued line. */
function singleValued(key: string, argName: string): CommandHandler {
  return (ctx, args, negate) => {
    if (selectedInterface(ctx) === undefined) return { error: MSG_NO_INTERFACE_SELECTED };
    const value = args[argName];
    if (negate) return outcomeOf(ctx.config(value === undefined ? [key] : [key, value], true));
    if (value === undefined || value === '') return { error: `% A value is required after ${key}.` };
    return outcomeOf(ctx.config([key, value], false));
  };
}

/**
 * Configuration handlers keyed by the grammar's handler ids. `if.mac-address` is a NetForge extension: the line is
 * stored in the running-config only (no daemon consumes it yet, so the port keeps its factory MAC).
 */
export const configHandlers: Record<string, CommandHandler> = {
  [HANDLERS.configHostname]: hostname,
  [HANDLERS.configInterface]: iface,
  [HANDLERS.configIpRoute]: ipRoute,
  [HANDLERS.configDefaultGateway]: defaultGateway,
  [HANDLERS.configBanner]: banner,
  [HANDLERS.configEnableSecret]: enableSecret,
  [HANDLERS.ifIpAddress]: ipAddress,
  [HANDLERS.ifShutdown]: shutdown,
  [HANDLERS.ifDescription]: description,
  [HANDLERS.ifDuplex]: singleValued('duplex', 'mode'),
  [HANDLERS.ifSpeed]: singleValued('speed', 'rate'),
  [HANDLERS.ifMacAddress]: singleValued('mac-address', 'mac'),
};
