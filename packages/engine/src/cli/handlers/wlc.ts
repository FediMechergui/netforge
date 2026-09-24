/**
 * cli/handlers/wlc.ts — the controller's `wlc-interface` and `wlan` sections, the lightweight access point's
 * `capwap` lines and `show capwap` (ARCHITECTURE-P2 §3.12, §5.3, §5.4, D17; §7 W5 cli).
 *
 * Controller interfaces (`wlc-interface <name>`, mode `config-wlc-if`). The section and its lines are stored as typed
 * (`vlan <v>`, `address <a> <mask>`, `gateway <a>`, `dhcp-server <a>`); capwap-ac reads them. The handlers also keep
 * the lines the interface stands for, so that the controller answers on the address (§3.12):
 *   • VLAN list — the interface's VLAN is a VLAN the controller bridges, so a missing `vlan <v>` section is created
 *     (the controller has no `vlan` command of its own; VLAN 1 is built in). These handlers never remove a VLAN.
 *   • SVI — an interface with a VLAN and an address is carried by `interface Vlan<v>` with `ip address <a> <m>` and
 *     `no shutdown`, created when missing (as `channel-group` creates its Port-channel). When the address goes, the
 *     VLAN changes or the interface is removed, the SVI that carried the old address is removed with it.
 *   • management gateway — the `gateway` of the `management` interface is also `ip default-gateway <a>`; removing it
 *     removes that line when it still names the old gateway.
 * One VLAN belongs to one controller interface. `management` is the predefined management interface: a WLAN may name
 * it before its section exists, and it cannot be removed. An interface a WLAN uses cannot be removed either.
 *
 * WLANs (`wlan <id> <profile> <ssid>`, mode `config-wlan`): one WLAN per number; inside it `security`, `passphrase`
 * (8-63 printable characters; a secret token of the rule table), `interface <name>` (`CLI_MESSAGES.wlcInterfaceMissing`
 * when no such controller interface exists; without the line the WLAN uses `management`), `radio`, `shutdown`.
 * capwap-ac is the consumer.
 *
 * Lightweight access point: `capwap enable` / `no capwap enable` (the store keeps `no capwap enable` explicitly where
 * the P2 profile replays `capwap enable`, D2) and `capwap controller <ip>` (several). capwap-wtp is the consumer.
 *
 * `show capwap` reads live state in the §2.6 row shapes: on an access point its `capwap` rows (writer capwap-wtp) and
 * its capwap lines; on a controller its `capwap-aps` and `wlan-clients` rows (writer capwap-ac). Every string is
 * original wording (spec §1.6).
 */
import { CLI_MESSAGES, type CommandCtx, type CommandHandler, type CommandOutcome } from '../../contracts/cli.js';
import type { ConfigNode } from '../../contracts/config.js';
import type { PortId } from '../../contracts/ids.js';
import type { CapwapApRow, CapwapRow, WlanClientRow } from '../../contracts/tables.js';
import { broadcastOf, inSubnet, isIpv4Loopback, isIpv4Multicast, maskToPrefixLen, networkOf, parseIpv4, u32ToIpv4 } from '../../contracts/addr.js';
import { isImplicitVlan } from '../../protocols/l2/membership.js';
import { P2_HANDLERS, WLC_ARG_LIMITS } from '../grammar/index.js';
import { fmtDuration, table } from '../format.js';
import { enterMode, fillTemplate, interfaceSection, isPrintableAscii, outcomeOf } from './common.js';
import { MSG_BAD_ADDRESS, MSG_BAD_MASK } from './config.js';
import { vlanExists } from './vlan.js';

// The argument limits are read from the grammar at call time (§0 rule 12: no module-scope reads of other modules).

/** Whether `name` is the predefined management interface (§5.3). */
function isManagement(name: string): boolean {
  return name === WLC_ARG_LIMITS.managementInterface;
}

/** Whether `text` is a valid controller interface or WLAN profile name. */
function isName(text: string): boolean {
  return new RegExp(`^(?:${WLC_ARG_LIMITS.namePattern})$`).test(text);
}

/** Whether `text` is a valid SSID token. */
function isSsid(text: string): boolean {
  return new RegExp(`^(?:${WLC_ARG_LIMITS.ssidPattern})$`).test(text);
}

// ── messages ────────────────────────────────────────────────────────────────────────────────────────────────────

/** A controller interface line typed outside a `wlc-interface` section. */
export const MSG_NO_WLC_INTERFACE_SELECTED = '% Select a controller interface first (wlc-interface <name>).';
/** A WLAN line typed outside a `wlan` section. */
export const MSG_NO_WLAN_SELECTED = '% Select a WLAN first (wlan <id> <profile> <ssid>).';
/** `no wlc-interface management`. */
export const MSG_WLC_MANAGEMENT_FIXED = '% The management interface is built in and cannot be removed.';
/** `no wlc-interface <name>` for an interface that does not exist. */
export const MSG_WLC_NO_SUCH_INTERFACE = '% There is no controller interface named {name}.';
/** `no wlc-interface <name>` while a WLAN uses it. */
export const MSG_WLC_INTERFACE_IN_USE = '% WLAN {id} uses controller interface {name}; point it at another interface first.';
/** `no vlan` under a controller interface. */
export const MSG_WLC_VLAN_REQUIRED = '% A controller interface always has a VLAN; give it another one instead (vlan <number>).';
/** `vlan 1002`-`1005` under a controller interface. */
export const MSG_WLC_VLAN_RESERVED = '% VLANs 1002-1005 are reserved; choose another VLAN for a controller interface.';
/** Two controller interfaces on one VLAN. */
export const MSG_WLC_VLAN_TAKEN = '% VLAN {vlan} already belongs to controller interface {name}.';
/** An address whose subnet overlaps another controller interface's. */
export const MSG_WLC_SUBNET_OVERLAP = '% That subnet overlaps with controller interface {name}.';
/** A gateway, DHCP server or controller address that cannot be one. */
export const MSG_BAD_WLC_GATEWAY = '% That address cannot be a gateway.';
export const MSG_BAD_WLC_DHCP_SERVER = '% That address cannot be a DHCP server.';
export const MSG_BAD_CAPWAP_CONTROLLER = '% That address cannot be a controller.';
/** WLAN section messages. */
export const MSG_NAME_THE_WLAN = '% Give the number of the WLAN to remove (no wlan <id>).';
export const MSG_NO_SUCH_WLAN = '% There is no WLAN {id}.';
export const MSG_WLAN_ID_TAKEN = '% WLAN {id} already exists as "wlan {id} {profile} {ssid}"; enter it with those words, or remove it first.';
export const MSG_WLAN_WORDS_DIFFER = '% WLAN {id} is "wlan {id} {profile} {ssid}"; give those words, or only its number.';
export const MSG_BAD_WLC_NAME = '% A profile or interface name is 1 to 32 letters, digits, dots, dashes or underscores.';
export const MSG_BAD_WLAN_SSID = '% A network name is 1 to 32 printable characters, without spaces or colons.';
export const MSG_BAD_WLAN_PASSPHRASE = '% A WLAN passphrase has 8 to 63 printable characters.';
/** `show capwap` texts. */
export const MSG_CAPWAP_ON = 'CAPWAP: on';
export const MSG_CAPWAP_OFF = 'CAPWAP: off (this access point works on its own; "capwap enable" joins it to a controller)';
export const MSG_NO_CONTROLLER_LINES = 'Controllers configured: none (discovery searches the local subnet)';
export const MSG_NO_CONTROLLER_YET = 'No controller has been found yet.';
export const MSG_NO_ACCESS_POINTS = 'No access point has joined this controller.';
export const MSG_NO_WIRELESS_CLIENTS = 'No wireless client is connected.';

// ── reading the sections ────────────────────────────────────────────────────────────────────────────────────────

/** A controller interface as the running config states it. */
export interface WlcInterfaceView {
  name: string;
  vlan?: number;
  address?: string;
  mask?: string;
  gateway?: string;
  dhcpServer?: string;
}

/** A WLAN as the running config states it (`iface` is `management` when the WLAN has no `interface` line). */
export interface WlanView {
  id: number;
  profile: string;
  ssid: string;
  security?: string;
  passphrase: boolean;
  iface: string;
  radio?: string;
  shutdown: boolean;
}

/** The SVI named for VLAN `vlan` (`Vlan20`). */
export function sviName(vlan: number): PortId {
  return `Vlan${vlan}`;
}

/** The `wlc-interface <name>` section node, if any. */
export function wlcInterfaceSection(ctx: CommandCtx, name: string): ConfigNode | undefined {
  return ctx.running.root.children.find((c) => c.key === 'wlc-interface' && c.args.length === 1 && c.args[0] === name);
}

function interfaceViewOf(node: ConfigNode): WlcInterfaceView {
  const out: WlcInterfaceView = { name: node.args[0] as string };
  for (const c of node.children) {
    const v = c.args[0];
    if (v === undefined) continue;
    if (c.key === 'vlan' && /^\d{1,4}$/.test(v)) out.vlan = Number(v);
    else if (c.key === 'address' && c.args[1] !== undefined) {
      out.address = v;
      out.mask = c.args[1];
    } else if (c.key === 'gateway') out.gateway = v;
    else if (c.key === 'dhcp-server') out.dhcpServer = v;
  }
  return out;
}

/** Every controller interface of the running config, in config order. */
export function wlcInterfaces(ctx: CommandCtx): WlcInterfaceView[] {
  return ctx.running.root.children.filter((c) => c.key === 'wlc-interface' && c.args.length === 1).map(interfaceViewOf);
}

/** One controller interface by name. */
export function wlcInterface(ctx: CommandCtx, name: string): WlcInterfaceView | undefined {
  const node = wlcInterfaceSection(ctx, name);
  return node === undefined ? undefined : interfaceViewOf(node);
}

function wlanViewOf(node: ConfigNode): WlanView {
  const out: WlanView = { id: Number(node.args[0]), profile: node.args[1] as string, ssid: node.args[2] as string, passphrase: false, iface: WLC_ARG_LIMITS.managementInterface, shutdown: false };
  for (const c of node.children) {
    if (c.key === 'security' && c.args[0] !== undefined) out.security = c.args[0];
    else if (c.key === 'passphrase') out.passphrase = true;
    else if (c.key === 'interface' && c.args[0] !== undefined) out.iface = c.args[0];
    else if (c.key === 'radio' && c.args[0] !== undefined) out.radio = c.args[0];
    else if (c.key === 'shutdown') out.shutdown = true;
  }
  return out;
}

/** Every WLAN of the running config, in config order. */
export function wlans(ctx: CommandCtx): WlanView[] {
  return ctx.running.root.children.filter((c) => c.key === 'wlan' && c.args.length === 3).map(wlanViewOf);
}

/** The WLAN with number `id`, if any. */
export function wlanById(ctx: CommandCtx, id: number): WlanView | undefined {
  return wlans(ctx).find((w) => w.id === id);
}

/** Name of the controller interface whose section the session is in. */
function selectedWlcInterface(ctx: CommandCtx): string | undefined {
  const entry = ctx.context[ctx.context.length - 1];
  return entry?.[0] === 'wlc-interface' ? entry[1] : undefined;
}

/** Whether the session is inside a `wlan` section. */
function inWlan(ctx: CommandCtx): boolean {
  return ctx.context[ctx.context.length - 1]?.[0] === 'wlan';
}

// ── the lines an interface stands for ───────────────────────────────────────────────────────────────────────────

/** The SVI an interface needs: present only when it has both a VLAN and an address. */
interface SviPlan {
  readonly port: PortId;
  readonly address: string;
  readonly mask: string;
}

function sviPlanOf(view: WlcInterfaceView | undefined): SviPlan | undefined {
  if (view?.vlan === undefined || view.address === undefined || view.mask === undefined) return undefined;
  return { port: sviName(view.vlan), address: view.address, mask: view.mask };
}

/** Run config writes in order; the first error stops them. */
function writeAll(ctx: CommandCtx, writes: readonly (readonly [line: string[], negate: boolean, context: string[][]])[]): string | undefined {
  for (const [line, negate, context] of writes) {
    const error = ctx.config(line, negate, context);
    if (error !== undefined) return error;
  }
  return undefined;
}

/**
 * Move the SVI lines from what the interface needed before a line (`before`) to what it needs after it (`after`): the
 * SVI that carried the old address goes when the new plan names another SVI or none; the new plan's SVI is created
 * when missing and given the address and `no shutdown`.
 */
function syncSvi(ctx: CommandCtx, before: SviPlan | undefined, after: SviPlan | undefined): string | undefined {
  if (before !== undefined && before.port !== after?.port && interfaceSection(ctx.running.root, before.port) !== undefined) {
    const error = ctx.config(['interface', before.port], true, []);
    if (error !== undefined) return error;
  }
  if (after === undefined) return undefined;
  const at = [['interface', after.port]];
  return writeAll(ctx, [
    [['interface', after.port], false, []],
    [['ip', 'address', after.address, after.mask], false, at],
    [['shutdown'], true, at],
  ]);
}

/** The `ip default-gateway` value of the running config, if any. */
function defaultGatewayOf(ctx: CommandCtx): string | undefined {
  return ctx.running.get('ip.default-gateway')?.[0];
}

/**
 * Keep `ip default-gateway` equal to the management interface's gateway (other interfaces change nothing): a gateway
 * is written unless the line already names it; a removed gateway removes the line only while it still names it.
 */
function syncGateway(ctx: CommandCtx, name: string, before: string | undefined, after: string | undefined): string | undefined {
  if (!isManagement(name)) return undefined;
  const current = defaultGatewayOf(ctx);
  if (after !== undefined) return current === after ? undefined : ctx.config(['ip', 'default-gateway', after], false, []);
  if (before !== undefined && current === before) return ctx.config(['ip', 'default-gateway'], true, []);
  return undefined;
}

/** The controller's VLAN list holds `vlan`: create the section when the VLAN is neither built in nor configured. */
function ensureVlan(ctx: CommandCtx, vlan: number): string | undefined {
  if (isImplicitVlan(vlan) || vlanExists(ctx, vlan)) return undefined;
  return ctx.config(['vlan', String(vlan)], false, []);
}

/** A unicast IPv4 address in canonical text, or undefined for one that cannot name a host. */
function unicastAddress(text: string | undefined): string | undefined {
  const v = parseIpv4(text ?? '');
  if (v === null) return undefined;
  const ip = u32ToIpv4(v);
  if (v === 0 || ip === '255.255.255.255' || isIpv4Multicast(ip) || isIpv4Loopback(ip)) return undefined;
  return ip;
}

/**
 * Validate an interface address/mask pair: a host address of a contiguous mask, whose subnet overlaps no other
 * controller interface and no address already on a port other than `own` (the interface's own SVIs).
 */
export function validateWlcAddress(ctx: CommandCtx, name: string, address: string, mask: string, own: ReadonlySet<PortId>): string | undefined {
  const a = parseIpv4(address);
  const len = maskToPrefixLen(mask);
  if (a === null) return '% Expected an IPv4 address in dotted-decimal form (A.B.C.D).';
  if (len === null) return '% Expected a contiguous subnet mask such as 255.255.255.0.';
  const ip = u32ToIpv4(a);
  if (a === 0 || len === 0 || isIpv4Loopback(ip) || isIpv4Multicast(ip) || ip === '255.255.255.255') return MSG_BAD_ADDRESS;
  if (len <= 30 && (networkOf(ip, len) === ip || broadcastOf(ip, len) === ip)) return MSG_BAD_MASK;
  for (const other of wlcInterfaces(ctx)) {
    if (other.name === name || other.address === undefined || other.mask === undefined) continue;
    const otherLen = maskToPrefixLen(other.mask);
    if (otherLen !== null && inSubnet(ip, other.address, Math.min(len, otherLen))) return fillTemplate(MSG_WLC_SUBNET_OVERLAP, { name: other.name });
  }
  for (const [id, view] of ctx.ports) {
    const other = view.l3.ipv4;
    if (own.has(id) || other === undefined) continue;
    if (inSubnet(ip, other.address, Math.min(len, other.prefixLen))) return `% That subnet overlaps with the address already on ${id}.`;
  }
  return undefined;
}

// ── controller interfaces ───────────────────────────────────────────────────────────────────────────────────────

/** `wlc-interface <name>` / `no wlc-interface <name>`. */
const wlcInterfaceHandler: CommandHandler = (ctx, args, negate) => {
  const name = args['name'] ?? '';
  if (!isName(name)) return { error: MSG_BAD_WLC_NAME };
  if (negate) {
    if (isManagement(name)) return { error: MSG_WLC_MANAGEMENT_FIXED };
    const view = wlcInterface(ctx, name);
    if (view === undefined) return { error: fillTemplate(MSG_WLC_NO_SUCH_INTERFACE, { name }) };
    const user = wlans(ctx).find((w) => w.iface === name);
    if (user !== undefined) return { error: fillTemplate(MSG_WLC_INTERFACE_IN_USE, { id: user.id, name }) };
    const error = syncSvi(ctx, sviPlanOf(view), undefined);
    if (error !== undefined) return { error };
    return outcomeOf(ctx.config(['wlc-interface', name], true, []));
  }
  const error = ctx.config(['wlc-interface', name], false, []);
  if (error !== undefined) return { error };
  enterMode(ctx, 'config-wlc-if', [['wlc-interface', name]]);
  return {};
};

/** A controller interface line: `body` gets the selected interface and its view before the line; errors are outcomes. */
function onInterface(body: (ctx: CommandCtx, name: string, before: WlcInterfaceView | undefined, args: Record<string, string>, negate: boolean) => string | undefined): CommandHandler {
  return (ctx, args, negate) => {
    const name = selectedWlcInterface(ctx);
    if (name === undefined) return { error: MSG_NO_WLC_INTERFACE_SELECTED };
    return outcomeOf(body(ctx, name, wlcInterface(ctx, name), args, negate));
  };
}

/** `vlan <v>` under a controller interface (`no vlan` is refused: an interface always has a VLAN). */
const wlcIfVlan = onInterface((ctx, name, before, args, negate) => {
  if (negate) return MSG_WLC_VLAN_REQUIRED;
  const vlan = Number(args['vlan']);
  if (!Number.isInteger(vlan) || vlan < 1 || vlan > 4094) return '% Give a VLAN between 1 and 4094.';
  if (vlan >= 1002 && vlan <= 1005) return MSG_WLC_VLAN_RESERVED;
  const owner = wlcInterfaces(ctx).find((i) => i.name !== name && i.vlan === vlan);
  if (owner !== undefined) return fillTemplate(MSG_WLC_VLAN_TAKEN, { vlan, name: owner.name });
  return (
    ensureVlan(ctx, vlan) ??
    ctx.config(['vlan', String(vlan)], false) ??
    syncSvi(ctx, sviPlanOf(before), sviPlanOf(wlcInterface(ctx, name)))
  );
});

/** `address <a> <mask>` / `no address` under a controller interface. */
const wlcIfAddress = onInterface((ctx, name, before, args, negate) => {
  if (negate) {
    if (before?.address === undefined) return undefined;
    return ctx.config(['address'], true) ?? syncSvi(ctx, sviPlanOf(before), undefined);
  }
  const own = new Set<PortId>(before?.vlan === undefined ? [] : [sviName(before.vlan)]);
  const address = args['address'] ?? '';
  const mask = args['mask'] ?? '';
  const bad = validateWlcAddress(ctx, name, address, mask, own);
  if (bad !== undefined) return bad;
  const line = ['address', u32ToIpv4(parseIpv4(address) ?? 0), u32ToIpv4(parseIpv4(mask) ?? 0)];
  return ctx.config(line, false) ?? syncSvi(ctx, sviPlanOf(before), sviPlanOf(wlcInterface(ctx, name)));
});

/** `gateway <a>` / `no gateway` under a controller interface (management: also `ip default-gateway`). */
const wlcIfGateway = onInterface((ctx, name, before, args, negate) => {
  if (negate) {
    if (before?.gateway === undefined) return undefined;
    return ctx.config(['gateway'], true) ?? syncGateway(ctx, name, before.gateway, undefined);
  }
  const gateway = unicastAddress(args['address']);
  if (gateway === undefined) return MSG_BAD_WLC_GATEWAY;
  return ctx.config(['gateway', gateway], false) ?? syncGateway(ctx, name, before?.gateway, gateway);
});

/** `dhcp-server <a>` / `no dhcp-server` under a controller interface (stored and shown; deviation (15)). */
const wlcIfDhcpServer = onInterface((ctx, _name, _before, args, negate) => {
  if (negate) return ctx.config(['dhcp-server'], true);
  const server = unicastAddress(args['address']);
  if (server === undefined) return MSG_BAD_WLC_DHCP_SERVER;
  return ctx.config(['dhcp-server', server], false);
});

// ── WLANs ───────────────────────────────────────────────────────────────────────────────────────────────────────

/** `wlan <id> <profile> <ssid>` / `no wlan <id> [<profile> <ssid>]`. */
const wlanHandler: CommandHandler = (ctx, args, negate) => {
  const rawId = args['id'];
  const profile = args['profile'];
  const ssid = args['ssid'];
  if (negate) {
    if (rawId === undefined || rawId === '') return { error: MSG_NAME_THE_WLAN };
    const found = wlanById(ctx, Number(rawId));
    if (found === undefined) return { error: fillTemplate(MSG_NO_SUCH_WLAN, { id: Number(rawId) }) };
    if ((profile !== undefined && profile !== '' && profile !== found.profile) || (ssid !== undefined && ssid !== '' && ssid !== found.ssid)) {
      return { error: fillTemplate(MSG_WLAN_WORDS_DIFFER, { id: found.id, profile: found.profile, ssid: found.ssid }) };
    }
    return outcomeOf(ctx.config(['wlan', String(found.id), found.profile, found.ssid], true, []));
  }
  const id = Number(rawId);
  const { wlanIdMin, wlanIdMax } = WLC_ARG_LIMITS;
  if (!Number.isInteger(id) || id < wlanIdMin || id > wlanIdMax) return { error: `% Give a WLAN number between ${wlanIdMin} and ${wlanIdMax}.` };
  if (profile === undefined || !isName(profile)) return { error: MSG_BAD_WLC_NAME };
  if (ssid === undefined || !isSsid(ssid)) return { error: MSG_BAD_WLAN_SSID };
  const existing = wlanById(ctx, id);
  if (existing !== undefined && (existing.profile !== profile || existing.ssid !== ssid)) {
    return { error: fillTemplate(MSG_WLAN_ID_TAKEN, { id, profile: existing.profile, ssid: existing.ssid }) };
  }
  const line = ['wlan', String(id), profile, ssid];
  const error = ctx.config(line, false, []);
  if (error !== undefined) return { error };
  enterMode(ctx, 'config-wlan', [line]);
  return {};
};

/** A WLAN section line: refused outside a `wlan` section. */
function onWlan(body: (ctx: CommandCtx, args: Record<string, string>, negate: boolean) => CommandOutcome): CommandHandler {
  return (ctx, args, negate) => (inWlan(ctx) ? body(ctx, args, negate) : { error: MSG_NO_WLAN_SELECTED });
}

/** `security open|wpa2-psk|wpa3-sae` / `no security`. */
const wlanSecurity = onWlan((ctx, args, negate) => {
  if (negate) return outcomeOf(ctx.config(['security'], true));
  const mode = args['mode'] ?? '';
  const modes: readonly string[] = WLC_ARG_LIMITS.securityModes;
  if (!modes.includes(mode)) return { error: `% Expected ${modes.join(', ')}.` };
  return outcomeOf(ctx.config(['security', mode], false));
});

/** `passphrase <text>` / `no passphrase`. */
const wlanPassphrase = onWlan((ctx, args, negate) => {
  if (negate) return outcomeOf(ctx.config(['passphrase'], true));
  const text = (args['text'] ?? '').trim();
  if (text.length < WLC_ARG_LIMITS.passphraseMin || text.length > WLC_ARG_LIMITS.passphraseMax || !isPrintableAscii(text)) return { error: MSG_BAD_WLAN_PASSPHRASE };
  return outcomeOf(ctx.config(['passphrase', text], false));
});

/** `interface <name>` / `no interface` (back to the management interface). */
const wlanInterface = onWlan((ctx, args, negate) => {
  if (negate) return outcomeOf(ctx.config(['interface'], true));
  const name = args['name'] ?? '';
  if (!isName(name)) return { error: MSG_BAD_WLC_NAME };
  if (!isManagement(name) && wlcInterfaceSection(ctx, name) === undefined) {
    return { error: fillTemplate(CLI_MESSAGES.wlcInterfaceMissing, { name }) };
  }
  return outcomeOf(ctx.config(['interface', name], false));
});

/** `radio 2.4|5|all` / `no radio`. */
const wlanRadio = onWlan((ctx, args, negate) => {
  if (negate) return outcomeOf(ctx.config(['radio'], true));
  const band = args['band'] ?? '';
  const radios: readonly string[] = WLC_ARG_LIMITS.radios;
  if (!radios.includes(band)) return { error: `% Expected ${radios.join(', ')}.` };
  return outcomeOf(ctx.config(['radio', band], false));
});

/** `shutdown` / `no shutdown` inside a WLAN. */
const wlanShutdown = onWlan((ctx, _args, negate) => outcomeOf(ctx.config(['shutdown'], negate)));

// ── lightweight access point ────────────────────────────────────────────────────────────────────────────────────

/**
 * `capwap enable` / `no capwap enable`. The `no` form is written only while the line is there: where the P2 profile
 * replays `capwap enable` the store then keeps `no capwap enable` explicitly (D2), and where nothing enabled CAPWAP
 * (a P1 world) there is nothing to undo, so no stray `no capwap enable` line is kept. `capwap enable` also drops an
 * explicit `no capwap enable` the store did not cancel itself (one read from a file of a P1 world).
 */
const capwapEnable: CommandHandler = (ctx, _args, negate) => {
  const line = ['capwap', 'enable'];
  if (negate) return hasGlobalLine(ctx, line) ? outcomeOf(ctx.config(line, true, [])) : {};
  const error = ctx.config(line, false, []);
  if (error !== undefined) return { error };
  return hasGlobalLine(ctx, ['no', ...line]) ? outcomeOf(ctx.config(['no', ...line], true, [])) : {};
};

/** `capwap controller <ip>` / `no capwap controller [<ip>]` (the `no` forms remove configured lines only). */
const capwapController: CommandHandler = (ctx, args, negate) => {
  const raw = args['address'];
  if (negate && (raw === undefined || raw === '')) return controllerLines(ctx).length === 0 ? {} : outcomeOf(ctx.config(['capwap', 'controller'], true, []));
  const address = unicastAddress(raw);
  if (address === undefined) return { error: MSG_BAD_CAPWAP_CONTROLLER };
  if (negate && !controllerLines(ctx).includes(address)) return {};
  return outcomeOf(ctx.config(['capwap', 'controller', address], negate, []));
};

/** The `capwap controller <ip>` addresses of the running config, in config order. */
function controllerLines(ctx: CommandCtx): string[] {
  return ctx.running.root.children.filter((c) => c.key === 'capwap' && c.args[0] === 'controller' && c.args.length === 2).map((c) => c.args[1] as string);
}

// ── show capwap ─────────────────────────────────────────────────────────────────────────────────────────────────

/** Numeric sort key of a dotted IPv4 address (unparseable text sorts last). */
function ipKey(text: string): number {
  return parseIpv4(text) ?? 0x1_0000_0000;
}

/** Ordering of two strings (plain code-unit order, so it never depends on the host locale). */
function byText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Whether the running config holds exactly the global line `tokens` (`['no', …]` asks for a stored negation). */
function hasGlobalLine(ctx: CommandCtx, tokens: readonly string[]): boolean {
  return ctx.running.root.children.some((c) => c.key === tokens[0] && c.args.length === tokens.length - 1 && tokens.slice(1).every((t, i) => c.args[i] === t));
}

/** The access point's view: whether CAPWAP is on, the configured controllers and the `capwap` rows. */
function renderApSide(ctx: CommandCtx): string {
  const on = hasGlobalLine(ctx, ['capwap', 'enable']);
  const lines = [on ? MSG_CAPWAP_ON : MSG_CAPWAP_OFF];
  const configured = controllerLines(ctx).sort((a, b) => ipKey(a) - ipKey(b));
  lines.push(configured.length === 0 ? MSG_NO_CONTROLLER_LINES : `Controllers configured: ${configured.join(', ')}`);
  const rows = (ctx.tables.get?.<CapwapRow>('capwap')?.rows() ?? []).sort((a, b) => ipKey(a.controller) - ipKey(b.controller));
  if (rows.length === 0) {
    if (on) lines.push(MSG_NO_CONTROLLER_YET);
    return lines.join('\n');
  }
  const out: string[][] = [['Controller', 'State', 'In state for', 'WLANs']];
  for (const r of rows) out.push([r.controller, r.state, fmtDuration(ctx.now - r.since), String(r.wlans)]);
  lines.push(table(out));
  return lines.join('\n');
}

/** The controller's view: the joined access points (`capwap-aps`) and the wireless clients (`wlan-clients`). */
function renderControllerSide(ctx: CommandCtx): string {
  const aps = (ctx.tables.get?.<CapwapApRow>('capwap-aps')?.rows() ?? []).sort((a, b) => byText(a.name, b.name) || byText(a.apMac, b.apMac));
  const clients = (ctx.tables.get?.<WlanClientRow>('wlan-clients')?.rows() ?? []).sort((a, b) => byText(a.station, b.station));
  const blocks: string[] = [];
  if (aps.length === 0) blocks.push(MSG_NO_ACCESS_POINTS);
  else {
    const rows: string[][] = [['AP name', 'AP MAC', 'AP address', 'State', 'Clients']];
    for (const a of aps) rows.push([a.name, a.apMac, a.apIp, a.state, String(a.clients)]);
    blocks.push(`Access points: ${aps.length}\n${table(rows)}`);
  }
  if (clients.length === 0) blocks.push(MSG_NO_WIRELESS_CLIENTS);
  else {
    const nameOf = new Map(aps.map((a) => [a.apMac, a.name] as const));
    const rows: string[][] = [['Client', 'Access point', 'BSSID', 'WLAN', 'SSID', 'VLAN', 'Interface', 'State']];
    for (const c of clients) rows.push([c.station, nameOf.get(c.ap) ?? c.ap, c.bssid, String(c.wlanId), c.ssid, String(c.vlan), c.iface, c.state]);
    blocks.push(`Wireless clients: ${clients.length}\n${table(rows)}`);
  }
  return blocks.join('\n\n');
}

/** `show capwap`: the access point side, the controller side, or both (by capability). */
const showCapwap: CommandHandler = (ctx) => {
  const blocks: string[] = [];
  if (ctx.capabilities.has('lightweight-ap')) blocks.push(renderApSide(ctx));
  if (ctx.capabilities.has('wireless-controller')) blocks.push(renderControllerSide(ctx));
  return { output: blocks.join('\n\n') };
};

/** @since P2 Registry fragment: the controller and lightweight access point lines and `show capwap`. */
export const wlcHandlers: Readonly<Record<string, CommandHandler>> = {
  [P2_HANDLERS.configWlcInterface]: wlcInterfaceHandler,
  [P2_HANDLERS.wlcIfVlan]: wlcIfVlan,
  [P2_HANDLERS.wlcIfAddress]: wlcIfAddress,
  [P2_HANDLERS.wlcIfGateway]: wlcIfGateway,
  [P2_HANDLERS.wlcIfDhcpServer]: wlcIfDhcpServer,
  [P2_HANDLERS.configWlan]: wlanHandler,
  [P2_HANDLERS.wlanSecurity]: wlanSecurity,
  [P2_HANDLERS.wlanPassphrase]: wlanPassphrase,
  [P2_HANDLERS.wlanInterface]: wlanInterface,
  [P2_HANDLERS.wlanRadio]: wlanRadio,
  [P2_HANDLERS.wlanShutdown]: wlanShutdown,
  [P2_HANDLERS.configCapwapEnable]: capwapEnable,
  [P2_HANDLERS.configCapwapController]: capwapController,
  [P2_HANDLERS.showCapwap]: showCapwap,
};
