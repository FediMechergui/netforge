/**
 * cli/handlers/show.ts — `show …` command handlers (spec §7.5, §4.4 "counters are real", §2.1 troubleshooting row;
 * ARCHITECTURE "P0 CLI surface", ARCHITECTURE-P1 §3.9, §3.13).
 *
 * Every handler renders LIVE state read only through `CommandCtx` (ports, tables, running/startup config, uptime,
 * model, session): there is no parallel display model and nothing is faked. Column layouts are conventional; all
 * wording is original (spec §1.6).
 *
 * Which ports are interfaces comes from the configurable role trait, the hardware label from the port kind (virtual
 * interfaces use their role label), and a MAC is printed only for MAC-bearing encapsulations (Ethernet, 802.11).
 * A port with carrier but no line protocol (serial clocking/keepalive, an unassociated station) prints
 * "link up, line protocol down" with the reason from `PortState.phy`.
 *
 *   show.ip-int-brief       one line per interface: address, status (admin/layer 1), line protocol
 *   show.interfaces         detailed state + PortCounters, optionally for one interface
 *   show.interfaces-status  one line per physical port: status, role, duplex, speed, connector
 *   show.arp                the ARP cache (also `show ip arp`)
 *   show.mac                the MAC address table (sorted by vlan, then MAC)
 *   show.ip-route           the IPv4 RIB with a codes legend and default-route line
 *   show.version            software/model/uptime summary
 *   show.running            running-config text; show.startup: startup-config text (secrets masked below 15)
 *   show.history            the session's command history
 *   show.controllers        serial cable end, clock, framing and line state
 *   show.wireless           radio settings, networks and associations
 *   show.inventory          chassis, slots, modules and transceivers
 */
import type { CommandCtx, CommandHandler } from '../../contracts/cli.js';
import type { ConfigAst } from '../../contracts/config.js';
import type { PortId } from '../../contracts/ids.js';
import type { PortKind, PortView } from '../../contracts/port.js';
import type { ArpRow, CamRow, Dot11AssocRow, RouteRow } from '../../contracts/tables.js';
import { ipv4ToU32, macToDotted } from '../../contracts/addr.js';
import { KIND_CONNECTOR, ROLE_TRAITS, type SlotType } from '../../contracts/catalog.js';
import { radioModeOf, type RadioMode, type RadioPortView } from '../../contracts/rf.js';
import { MODULE_MODELS } from '../../device/catalog/modules.js';
import { maskSecretTokens } from '../config-rules.js';
import { walkConfigText } from '../config-text.js';
import { HANDLERS, MAC_COUNT_ARG, MAC_IFACE_ARG, MAC_KIND_ARG, MAC_VLAN_ARG, ROUTE_SOURCE_ARG, STATUS_FILTER_ARG } from '../grammar/index.js';
import { fmtBps, fmtSince, fmtUptime, minutesBetween, padRight, table } from '../format.js';
import { stationState, type StationStateEntry } from './host.js';
import { encapOf, interfaceLine, interfaceSection, isConfigurablePort, roleOf, sectionArgs, sectionHasNegation } from './common.js';

/** NetForge operating-system family string shown by `show version` (ARCHITECTURE rule 7). */
export const NFOS_NAME = 'NetForge NFOS';
/** Software version shown by `show version` and stored in config headers. */
export const NFOS_VERSION = '1.0';

/** Shown by `show startup-config` when nothing has been saved yet. */
export const MSG_NO_STARTUP = 'startup-config is not present (nothing has been saved yet)';
/** `show controllers serial` on a device without serial interfaces. */
export const MSG_NO_SERIAL = '% This device has no serial interfaces.';
/** `show wireless` on a device without radio interfaces. */
export const MSG_NO_RADIOS = '% This device has no radio interfaces.';

/** Hardware label per port kind (original wording). */
export const PORT_KIND_LABEL: Readonly<Record<PortKind, string>> = Object.freeze({
  ethernet: 'Ethernet',
  serial: 'Serial',
  console: 'Console',
  usb: 'USB console',
  coax: 'Coax',
  phone: 'Phone line',
  'fiber-pon': 'Fibre PON',
  wlan: 'Wireless',
  radio: 'Point-to-point radio',
  cellular: 'Cellular',
  virtual: 'Virtual',
});

/** Readable text of `PortPhy.lineProtocolReason` values (original wording). */
export const LINE_PROTOCOL_REASON_TEXT: Readonly<Record<string, string>> = Object.freeze({
  'no-clock': 'no clock rate on the DCE end',
  'encapsulation-mismatch': 'the two ends use different framing',
  'keepalive-missed': 'keepalives from the other end stopped arriving',
  'not-associated': 'not associated with a wireless network',
});

/** Slot type labels for `show inventory` (original wording). */
export const SLOT_TYPE_LABEL: Readonly<Record<SlotType, string>> = Object.freeze({
  ehwic: 'Interface card slot',
  nim: 'Network module slot',
  sfp: 'SFP cage',
  'sfp+': 'SFP+ cage',
  generic: 'Universal slot',
  'host-expansion': 'Expansion bay',
});

/** Radio mode labels for `show wireless` (original wording). */
const RADIO_MODE_LABEL: Readonly<Record<RadioMode, string>> = Object.freeze({
  ap: 'access point radio',
  station: 'Wi-Fi station',
  ptp: 'point-to-point radio',
  tower: 'cellular base station radio',
  ue: 'cellular adapter',
});

/** Ports that are interfaces (configurable role trait), in canonical port order — console lines are not interfaces. */
function networkPorts(ctx: CommandCtx): PortView[] {
  const out: PortView[] = [];
  for (const p of ctx.ports.values()) if (isConfigurablePort(ctx, p)) out.push(p);
  return out;
}

/** Status column of `show ip interface brief`: admin down, err-disabled, else layer-1 carrier up/down. */
function briefStatus(p: PortView): string {
  if (!p.adminUp) return 'admin down';
  if (p.errDisabled) return 'err-disabled';
  return p.operUp || p.phy?.carrier === true ? 'up' : 'down';
}

/** Line-protocol column. */
function protocolStatus(p: PortView): string {
  return p.operUp ? 'up' : 'down';
}

/** Link text of the `show interfaces` status line: up, down, or carrier up with the line protocol down and why. */
function linkStatus(p: PortView): string {
  if (p.operUp) return 'up';
  if (p.phy?.carrier === true && p.phy.lineProtocol === false) {
    const reason = p.phy.lineProtocolReason;
    return reason === undefined ? 'up, line protocol down' : `up, line protocol down (${LINE_PROTOCOL_REASON_TEXT[reason] ?? reason})`;
  }
  return 'down';
}

/** Compare two dotted IPv4 addresses numerically. */
function compareIpv4(a: string, b: string): number {
  return ipv4ToU32(a) - ipv4ToU32(b);
}

/** Resolve an interface argument to a live port, or undefined. */
function portArg(ctx: CommandCtx, name: string): PortView | undefined {
  const id = ctx.ports.has(name) ? name : ctx.resolvePort(name);
  return id !== undefined ? ctx.ports.get(id) : undefined;
}

/** Display name of a module type (catalog model name, else the type id). */
function moduleName(type: string): string {
  return MODULE_MODELS.find((m) => m.type === type)?.model ?? type;
}

// ── show ip interface brief ─────────────────────────────────────────────────

const showIpIntBrief: CommandHandler = (ctx) => {
  const rows: string[][] = [['Interface', 'IP address', 'Status', 'Protocol']];
  for (const p of networkPorts(ctx)) {
    rows.push([p.id, p.l3.ipv4?.address ?? 'unassigned', briefStatus(p), protocolStatus(p)]);
  }
  return { output: table(rows, { gap: 3 }) };
};

// ── show interfaces [<iface>] ───────────────────────────────────────────────

/** Hardware line of one port: kind (or virtual role) label and the MAC when the encapsulation carries one. */
function hardwareLine(ctx: CommandCtx, p: PortView): string {
  const encap = encapOf(p);
  const macBearing = encap === 'ethernet' || encap === 'dot11';
  const label = p.spec.kind === 'virtual' ? ROLE_TRAITS[roleOf(ctx, p)].label : `${PORT_KIND_LABEL[p.spec.kind]} port`;
  if (macBearing) return `  ${label}, MAC ${macToDotted(p.mac)} (${p.mac})`;
  return encap === 'none' ? `  ${label}, no hardware address` : `  ${label}, ${encap.toUpperCase()} framing, no hardware address`;
}

/** Detailed block for one port: admin/link state, hardware, address, negotiation and RX/TX counters (original wording). */
export function renderInterface(ctx: CommandCtx, p: PortView): string {
  const c = p.counters;
  const configuredKbps = Number(interfaceLine(ctx, p.id, ['bandwidth'])?.[0] ?? NaN);
  const bandwidth = Number.isFinite(configuredKbps) && configuredKbps > 0 ? configuredKbps * 1000 : (p.speedBps ?? p.spec.speedBps);
  const lines: string[] = [];
  lines.push(`${p.id}: admin ${p.adminUp ? 'up' : 'down'}, link ${linkStatus(p)}`);
  lines.push(hardwareLine(ctx, p));
  if (p.l3.ipv4) lines.push(`  IPv4 ${p.l3.ipv4.address}/${p.l3.ipv4.prefixLen}`);
  lines.push(`  MTU ${p.mtu} bytes, bandwidth ${fmtBps(bandwidth)}`);
  if (p.speedBps !== undefined && p.duplex !== undefined) {
    lines.push(`  ${p.duplex}-duplex, ${fmtBps(p.speedBps)}, negotiated`);
  } else {
    lines.push('  Duplex and speed not negotiated (no link)');
  }
  if (p.role !== undefined || p.spec.role !== undefined) lines.push(`  Role: ${ROLE_TRAITS[roleOf(ctx, p)].label}`);
  if (p.transceiver !== undefined) lines.push(`  Transceiver: ${moduleName(p.transceiver)}`);
  if (p.errDisabled) lines.push(`  Error-disabled: ${p.errDisabled}`);
  if (p.link) lines.push(`  Connected via link ${p.link}`);
  lines.push(`  Last input ${fmtSince(p.lastInput, ctx.now)}, last output ${fmtSince(p.lastOutput, ctx.now)}`);
  lines.push(`  Last state change ${fmtSince(p.lastChange, ctx.now)}`);
  lines.push(`  RX: ${c.inPackets} frames, ${c.inBytes} bytes, ${c.inBroadcasts} broadcasts`);
  lines.push(`    errors: ${c.runts} runt, ${c.giants} oversize, ${c.crcErrors} FCS, ${c.inErrors} total, ${c.inDrops} dropped`);
  lines.push(`  TX: ${c.outPackets} frames, ${c.outBytes} bytes`);
  lines.push(`    dropped: ${c.outDrops}, collisions: ${c.collisions}`);
  if (c.lateCollisions !== undefined || c.deferred !== undefined || c.excessiveCollisions !== undefined) {
    lines.push(`    late collisions: ${c.lateCollisions ?? 0}, deferred: ${c.deferred ?? 0}, gave up after collisions: ${c.excessiveCollisions ?? 0}`);
  }
  if (c.txRetries !== undefined) lines.push(`    radio retries: ${c.txRetries}`);
  lines.push(`  Transmit queue: ${p.tx.queue} frame${p.tx.queue === 1 ? '' : 's'} waiting`);
  return lines.join('\n');
}

const showInterfaces: CommandHandler = (ctx, args) => {
  const name = args['iface'];
  if (name !== undefined && name !== '') {
    const p = portArg(ctx, name);
    if (!p) return { error: `% No interface named "${name}" exists on this device.` };
    return { output: renderInterface(ctx, p) };
  }
  const blocks: string[] = [];
  for (const p of networkPorts(ctx)) blocks.push(renderInterface(ctx, p));
  return { output: blocks.join('\n') };
};

// ── show interfaces status ──────────────────────────────────────────────────

/** Status column of `show interfaces status`. */
function portStatusWord(p: PortView): string {
  if (!p.adminUp) return 'disabled';
  if (p.errDisabled) return 'err-disabled';
  if (p.operUp) return 'connected';
  if (p.phy?.carrier === true) return 'no protocol';
  return 'not connected';
}

/** @since P2 Readable text of an err-disable cause (`PortState.errDisabled`), original wording. */
export const ERR_DISABLE_REASON_TEXT: Readonly<Record<string, string>> = Object.freeze({
  'psecure-violation': 'port security violation',
  bpduguard: 'BPDU guard',
  'channel-misconfig': 'EtherChannel misconfiguration',
  fault: 'injected fault',
});

/** @since P2 `show interfaces status err-disabled` when no port is error-disabled. */
export const MSG_NO_ERR_DISABLED = 'No port is error-disabled.';

/** @since P2 `show interfaces status err-disabled`: only the error-disabled ports, with the reason. */
function showErrDisabled(ctx: CommandCtx): string {
  const rows: string[][] = [['Port', 'Description', 'Status', 'Reason']];
  for (const p of networkPorts(ctx)) {
    if (p.spec.kind === 'virtual' || !p.errDisabled) continue;
    const desc = interfaceLine(ctx, p.id, ['description'])?.join(' ') ?? '';
    rows.push([p.id, desc.length > 18 ? `${desc.slice(0, 17)}~` : desc, 'err-disabled', ERR_DISABLE_REASON_TEXT[p.errDisabled] ?? p.errDisabled]);
  }
  return rows.length === 1 ? MSG_NO_ERR_DISABLED : table(rows);
}

const showInterfacesStatus: CommandHandler = (ctx, args) => {
  if (args[STATUS_FILTER_ARG] === 'err-disabled') return { output: showErrDisabled(ctx) };
  const rows: string[][] = [['Port', 'Description', 'Status', 'Role', 'Duplex', 'Speed', 'Type']];
  for (const p of networkPorts(ctx)) {
    if (p.spec.kind === 'virtual') continue;
    const desc = interfaceLine(ctx, p.id, ['description'])?.join(' ') ?? '';
    const type = p.transceiver !== undefined ? moduleName(p.transceiver) : (p.spec.connector ?? KIND_CONNECTOR[p.spec.kind]);
    rows.push([
      p.id,
      desc.length > 18 ? `${desc.slice(0, 17)}~` : desc,
      portStatusWord(p),
      ROLE_TRAITS[roleOf(ctx, p)].label,
      p.duplex ?? 'auto',
      p.speedBps !== undefined ? fmtBps(p.speedBps) : 'auto',
      type,
    ]);
  }
  return { output: table(rows) };
};

// ── show arp / show ip arp ──────────────────────────────────────────────────

/** ARP cache rows sorted by IP address (numeric). */
export function sortedArpRows(ctx: CommandCtx): ArpRow[] {
  return ctx.tables.arp.rows().sort((a, b) => compareIpv4(a.ip, b.ip));
}

const showArp: CommandHandler = (ctx) => {
  const rows = sortedArpRows(ctx);
  if (rows.length === 0) return { output: 'The ARP cache is empty.' };
  const out: string[][] = [['IPv4 address', 'MAC address', 'Age', 'Kind', 'Port']];
  for (const r of rows) {
    const age = r.type === 'static' ? '-' : String(minutesBetween(r.updatedAt, ctx.now));
    const hw = r.incomplete ? 'Incomplete' : macToDotted(r.mac);
    out.push([r.ip, hw, age, r.type, r.iface]);
  }
  return { output: table(out) };
};

// ── show mac address-table ──────────────────────────────────────────────────

/** CAM rows sorted by (vlan asc, mac asc) — canonical lowercase MACs compare correctly as strings. */
export function sortedCamRows(ctx: CommandCtx): CamRow[] {
  return ctx.tables.cam.rows().sort((a, b) => (a.vlan - b.vlan) || (a.mac < b.mac ? -1 : a.mac > b.mac ? 1 : 0));
}

/** @since P2 Kind column of a CAM row: a port-security row names how it was secured (`static (sticky)`). */
function camKindText(r: CamRow): string {
  return r.secure === undefined ? r.type : `${r.type} (${r.secure === 'sticky' ? 'sticky' : 'secure'})`;
}

/**
 * `show mac address-table [dynamic | static | vlan <v> | interface <if> | count]` (the filters since P2, ARCHITECTURE-P2
 * §5.4). The unfiltered table keeps its P0 layout byte for byte.
 */
const showMac: CommandHandler = (ctx, args) => {
  let rows = sortedCamRows(ctx);
  const kind = args[MAC_KIND_ARG];
  if (kind === 'dynamic' || kind === 'static') rows = rows.filter((r) => r.type === kind);
  const vlan = args[MAC_VLAN_ARG];
  if (vlan !== undefined) rows = rows.filter((r) => r.vlan === Number(vlan));
  const iface = args[MAC_IFACE_ARG];
  if (iface !== undefined) {
    const p = portArg(ctx, iface);
    if (p === undefined) return { error: `% No interface named "${iface}" exists on this device.` };
    rows = rows.filter((r) => r.port === p.id);
  }
  if (args[MAC_COUNT_ARG] !== undefined) {
    const dynamic = rows.filter((r) => r.type === 'dynamic').length;
    return { output: [`Dynamic entries: ${dynamic}`, `Static entries: ${rows.length - dynamic}`, `Total entries: ${rows.length}`].join('\n') };
  }
  const out: string[][] = [['VLAN', 'MAC address', 'Kind', 'Port']];
  for (const r of rows) out.push([String(r.vlan), macToDotted(r.mac), camKindText(r), r.port]);
  return { output: `${table(out, { gap: 4, align: ['right'] })}\nTotal entries: ${rows.length}` };
};

// ── show ip route ───────────────────────────────────────────────────────────

/** Legend line printed above the routing table (original wording). */
export const ROUTE_CODES_LEGEND = 'Route source codes: C - connected, L - local, S - static, * - candidate default route';

/** RIB rows sorted by (network numeric asc, prefixLen asc, source). */
export function sortedRouteRows(ctx: CommandCtx): RouteRow[] {
  return ctx.tables.rib.rows().sort((a, b) =>
    compareIpv4(a.network, b.network) || (a.prefixLen - b.prefixLen) || (a.source < b.source ? -1 : a.source > b.source ? 1 : 0));
}

/**
 * One routing-table row, source code in column 1 (original wording):
 *   `C    10.0.0.0/24  connected  GigabitEthernet0/0`
 *   `S    10.1.0.0/24  via 10.0.0.2 [1/0] GigabitEthernet0/0`
 *   `S    9.0.0.0/8  [1/0] out GigabitEthernet0/1`
 */
export function renderRoute(r: RouteRow): string {
  const code = padRight(r.source + (r.isDefault ? '*' : ''), 5);
  const prefix = `${r.network}/${r.prefixLen}`;
  if (r.source === 'S' || r.source === 'D') {
    const ad = `[${r.ad}/${r.metric}]`;
    if (r.nextHop !== undefined) {
      return `${code}${prefix}  via ${r.nextHop} ${ad}${r.iface ? ` ${r.iface}` : ''}`;
    }
    return `${code}${prefix}  ${ad} out ${r.iface ?? 'unknown interface'}`;
  }
  return `${code}${prefix}  connected  ${r.iface ?? 'unknown interface'}`;
}

// [S6] ── equal-cost paths ────────────────────────────────────────────────────────────────────────────────────────
/**
 * [S6] Continuation lines of a route with two or more equal-cost paths (`RouteRow.paths`, ARCHITECTURE-P2 §2.6): the
 * main line shows the first path (the row's own next hop and interface); every further path is one indented line
 * aligned under it, `via <nh> [ad/metric] <iface>` or `[ad/metric] out <iface>`. A row without `paths` (or with one)
 * has no continuation, so every P1 table renders exactly as before.
 */
export function renderRoutePaths(r: RouteRow): string[] {
  const paths = r.paths;
  if (paths === undefined || paths.length < 2) return [];
  const indent = ' '.repeat(5 + `${r.network}/${r.prefixLen}`.length + 2);
  const ad = `[${r.ad}/${r.metric}]`;
  return paths.slice(1).map((p) => {
    if (p.nextHop !== undefined) return `${indent}via ${p.nextHop} ${ad}${p.iface ? ` ${p.iface}` : ''}`;
    return `${indent}${ad} out ${p.iface ?? 'unknown interface'}`;
  });
}
// [S6] ── end ──────────────────────────────────────────────────────────────────────────────────────────────────

/** `show ip route [static]` (the `static` filter since P2, ARCHITECTURE-P2 §5.4, keeps the legend and default line). */
const showIpRoute: CommandHandler = (ctx, args) => {
  const all = sortedRouteRows(ctx);
  const source = args[ROUTE_SOURCE_ARG];
  const rows = source === undefined ? all : all.filter((r) => r.source === source);
  const lines: string[] = [ROUTE_CODES_LEGEND, ''];
  const def = all.find((r) => r.isDefault || (r.prefixLen === 0 && r.network === '0.0.0.0'));
  if (def) {
    const via = def.nextHop !== undefined ? `via ${def.nextHop}` : `out ${def.iface ?? 'unknown interface'}`;
    lines.push(`Default route: ${via} (${def.source}*)`);
  } else {
    lines.push('Default route: none configured');
  }
  lines.push('');
  if (rows.length === 0) {
    lines.push(source === undefined ? 'The routing table is empty.' : 'The routing table holds no static route.');
  } else {
    for (const r of rows) lines.push(renderRoute(r), ...renderRoutePaths(r));
  }
  return { output: lines.join('\n') };
};

// ── show version ────────────────────────────────────────────────────────────

/** Port summary: '2 GigabitEthernet, 2 Serial, 1 Console' grouped by name family in catalog order. */
export function portSummary(ctx: CommandCtx): string {
  const counts = new Map<string, number>();
  for (const spec of ctx.model.ports) {
    const family = spec.name.replace(/[\d/.]+$/, '') || spec.name;
    counts.set(family, (counts.get(family) ?? 0) + 1);
  }
  const parts: string[] = [];
  for (const [family, n] of counts) parts.push(`${n} ${family}`);
  return parts.length ? parts.join(', ') : 'none';
}

const showVersion: CommandHandler = (ctx) => {
  const lines = [
    `${NFOS_NAME} software, version ${NFOS_VERSION}`,
    `Model: ${ctx.model.model} (${ctx.model.description})`,
    `Hostname: ${ctx.hostname}`,
    `Uptime: ${fmtUptime(ctx.uptime)}`,
    `Ports: ${portSummary(ctx)}`,
    `Startup configuration: ${ctx.startup ? 'saved' : 'not saved'}`,
  ];
  return { output: lines.join('\n') };
};

// ── show running-config / show startup-config / show history ────────────────

/**
 * Configuration text with every secret token (`enable secret`, passphrases, pairing keys, line passwords) replaced by
 * the rule table's mask, keeping indentation. Used below privilege 15.
 */
export function maskConfigSecrets(text: string): string {
  const lines = text.split('\n');
  for (const tl of walkConfigText(text)) {
    const masked = maskSecretTokens(tl.context, tl.tokens);
    if (masked.length === tl.tokens.length && masked.every((t, i) => t === tl.tokens[i])) continue;
    const raw = lines[tl.lineNo - 1] ?? '';
    const indent = raw.length - raw.trimStart().length;
    lines[tl.lineNo - 1] = `${' '.repeat(indent)}${tl.negate ? 'no ' : ''}${masked.join(' ')}`;
  }
  return lines.join('\n');
}

/** Render a config for the session: full text at privilege 15, secrets masked below it. */
function renderForSession(ctx: CommandCtx, ast: ConfigAst): string {
  const text = ast.render();
  return ctx.session.privilege >= 15 ? text : maskConfigSecrets(text);
}

const showRunning: CommandHandler = (ctx) => ({ output: renderForSession(ctx, ctx.running) });

const showStartup: CommandHandler = (ctx) => ({ output: ctx.startup ? renderForSession(ctx, ctx.startup) : MSG_NO_STARTUP });

const showHistory: CommandHandler = (ctx) => {
  const history = ctx.session.history;
  if (history.length === 0) return { output: 'No commands have been entered in this session.' };
  const rows: string[][] = history.map((line, i) => [String(i + 1), line]);
  return { output: table(rows, { indent: '  ', align: ['right'] }) };
};

// ── show controllers serial ─────────────────────────────────────────────────

/** One `show controllers serial` block. */
function controllerBlock(ctx: CommandCtx, p: PortView): string {
  const section = interfaceSection(ctx.running.root, p.id);
  const rate = sectionArgs(section, ['clock', 'rate'])?.[0];
  const dce = p.phy?.dce;
  const lines: string[] = [];
  if (p.link === undefined) lines.push(`${p.id}: no cable attached`);
  else if (dce === true) lines.push(`${p.id}: DCE end of the serial cable`);
  else if (dce === false) lines.push(`${p.id}: DTE end of the serial cable`);
  else lines.push(`${p.id}: serial cable attached, end not determined`);

  if (p.spec.clockSource === true) {
    lines.push('  Clock: generated by this port');
  } else if (dce === true) {
    lines.push(rate !== undefined ? `  Clock: supplied at ${rate} bit/s` : '  Clock: not set, so the line protocol stays down until "clock rate" is configured');
  } else if (dce === false) {
    lines.push(rate !== undefined ? `  Clock: taken from the DCE end (the stored clock rate ${rate} is not used here)` : '  Clock: taken from the DCE end');
  } else {
    lines.push(rate !== undefined ? `  Clock: clock rate ${rate} bit/s configured` : '  Clock: no clock rate configured');
  }

  const kaArgs = sectionArgs(section, ['keepalive']);
  let keepalive: string;
  if (sectionHasNegation(section, ['keepalive'])) keepalive = 'keepalives off';
  else if (kaArgs !== undefined && kaArgs[0] === '0') keepalive = 'keepalives off (interval 0)';
  else keepalive = `keepalive every ${kaArgs?.[0] ?? '10'} s`;
  lines.push(`  Framing: ${encapOf(p).toUpperCase()}, ${keepalive}`);

  if (p.phy !== undefined) {
    const reason = p.phy.lineProtocolReason;
    const why = !p.phy.lineProtocol && reason !== undefined ? ` (${LINE_PROTOCOL_REASON_TEXT[reason] ?? reason})` : '';
    lines.push(`  Line: carrier ${p.phy.carrier ? 'up' : 'down'}, protocol ${p.phy.lineProtocol ? 'up' : 'down'}${why}`);
  }
  return lines.join('\n');
}

const showControllers: CommandHandler = (ctx, args) => {
  const name = args['iface'];
  if (name !== undefined && name !== '') {
    const p = portArg(ctx, name);
    if (p === undefined || p.spec.kind !== 'serial') return { error: `% No serial interface named "${name}" exists on this device.` };
    return { output: controllerBlock(ctx, p) };
  }
  const serial = [...ctx.ports.values()].filter((p) => p.spec.kind === 'serial');
  if (serial.length === 0) return { error: MSG_NO_SERIAL };
  return { output: serial.map((p) => controllerBlock(ctx, p)).join('\n\n') };
};

// ── show wireless ───────────────────────────────────────────────────────────

/** Association rows of the device for one radio port, in table order. */
function assocRows(ctx: CommandCtx, port: PortId): Dot11AssocRow[] {
  return ctx.tables.get?.<Dot11AssocRow>('dot11-assoc')?.rows().filter((r) => r.port === port) ?? [];
}

/** `, signal N dBm, rate R` of a radio view (parts left out when unknown). */
function signalRate(v: RadioPortView): string {
  return `${v.rssiDbm !== undefined ? `, signal ${v.rssiDbm} dBm` : ''}${v.rateBps !== undefined ? `, rate ${fmtBps(v.rateBps)}` : ''}`;
}

/** Band and channel of the BSS a station has joined: the live RF view, else the daemon's scan entry for that BSSID. */
function joinedBss(row: Dot11AssocRow | undefined, station: StationStateEntry | undefined, view: RadioPortView | undefined): { band?: string; channel?: number } | undefined {
  if (row === undefined) return undefined;
  if (view !== undefined && view.bssid === row.bssid) return { band: view.band, channel: view.channel };
  const cand = station?.candidates.find((c) => c.bssid === row.bssid);
  if (cand === undefined) return undefined;
  const out: { band?: string; channel?: number } = {};
  if (cand.band !== undefined) out.band = cand.band;
  if (cand.channel !== undefined) out.channel = cand.channel;
  return out;
}

/** Number of wrong-passphrase attempts after which a station stops retrying (wlan-client KEY_ATTEMPTS). */
const KEY_ATTEMPTS = 3;

/** Why an unassociated station is not on its network, from the `wlan-client` daemon state (original wording). */
function stationJoinLine(st: StationStateEntry | undefined): string {
  if (st === undefined || st.state === undefined || st.state === 'idle' || st.ssid === undefined) return '  Not associated.';
  const ssid = st.ssid;
  const security = st.security ?? 'open';
  const reason = st.reason;
  const noNetwork = (): string => {
    const other = st.candidates.find((c) => c.ssid === ssid && c.security !== security);
    return other !== undefined
      ? `  Join failed: "${ssid}" uses security ${other.security}, but this station is set to ${security} (security does not match the network)`
      : `  Searching: no network "${ssid}" with security ${security} in range`;
  };
  if (st.state === 'failed' || st.state === 'scanning') {
    if (reason === 'wrong-key') {
      return `  Join failed: the passphrase for "${ssid}" was rejected (${st.keyFailures ?? 1} of ${KEY_ATTEMPTS} attempts)`;
    }
    if (reason === 'auth-rejected' || reason === 'rejected') {
      return `  Join failed: "${ssid}" refused this station (security ${security} does not match the network)`;
    }
    if (reason === 'no-bss' || reason === 'out-of-range') return noNetwork();
    if (st.state === 'failed') return `  Join failed: ${reason ?? 'unknown reason'}`;
  }
  const rejected = (st.keyFailures ?? 0) > 0 ? ` (the passphrase was rejected ${st.keyFailures} of ${KEY_ATTEMPTS} times so far)` : '';
  return `  Joining "${ssid}": ${st.state}${rejected}`;
}

/** One `show wireless` block. */
function radioBlock(ctx: CommandCtx, p: PortView): string {
  const role = roleOf(ctx, p);
  const mode = radioModeOf(p.spec.kind, role);
  const label = mode !== undefined ? RADIO_MODE_LABEL[mode] : ROLE_TRAITS[role].label.toLowerCase();
  const section = interfaceSection(ctx.running.root, p.id);
  const radio = p.spec.radio;
  const lines = [`${p.id}: ${label}, admin ${p.adminUp ? 'up' : 'down'}, ${p.operUp ? 'operating' : 'not operating'}`];

  const rows = assocRows(ctx, p.id);
  const station = mode === 'station' ? stationState(ctx, p.id) : undefined;
  const view = mode === 'ue' || mode === 'ptp' || mode === 'tower' || mode === 'station' ? ctx.radioView(p.id) : undefined;

  if (p.spec.kind !== 'cellular') {
    let band = sectionArgs(section, ['band'])?.[0] ?? radio?.defaultBand ?? '2.4';
    let channel = sectionArgs(section, ['channel'])?.[0] ?? (radio !== undefined ? String(radio.defaultChannel) : 'default');
    let joined = '';
    const bss = mode === 'station' ? joinedBss(rows[0], station, view) : undefined;
    if (bss !== undefined) {
      band = bss.band ?? band;
      if (bss.channel !== undefined) {
        channel = String(bss.channel);
        joined = ' (network channel)';
      }
    }
    const width = sectionArgs(section, ['channel-width'])?.[0] ?? (band === '60' ? '2160' : '20');
    const power = sectionArgs(section, ['tx-power'])?.[0] ?? (radio !== undefined ? String(radio.maxTxPowerDbm) : 'default');
    lines.push(`  Band ${band} GHz, channel ${channel}${joined}, width ${width} MHz, transmit power ${power} dBm`);
  } else {
    lines.push('  Cellular radio (LTE)');
  }

  if (p.spec.kind === 'wlan') {
    const ssid = sectionArgs(section, ['ssid'])?.join(' ');
    const security = sectionArgs(section, ['security'])?.[0] ?? 'open';
    lines.push(`  Network: ${ssid === undefined ? 'none configured' : `"${ssid}"`}, security ${security}`);
    if (mode === 'ap' && sectionArgs(section, ['beacons']) !== undefined) lines.push('  Beacons: on');
  }
  if (p.spec.kind === 'radio') {
    lines.push(`  Pairing key: ${sectionArgs(section, ['peer-key']) !== undefined ? 'set' : 'not set'}`);
  }
  if (p.phy !== undefined) {
    const reason = p.phy.lineProtocolReason;
    const why = !p.phy.lineProtocol && reason !== undefined ? ` (${LINE_PROTOCOL_REASON_TEXT[reason] ?? reason})` : '';
    lines.push(`  Carrier ${p.phy.carrier ? 'up' : 'down'}${p.phy.lineProtocol ? '' : `, not passing data${why}`}`);
  }

  if (mode === 'tower' && view?.clients !== undefined) {
    lines.push(`  Attached devices: ${view.clients}`);
  } else if (mode === 'ap' || mode === 'tower') {
    if (rows.length === 0) {
      lines.push('  No stations associated.');
    } else {
      const out: string[][] = [['Station', 'State', 'AID', 'Signal', 'Rate']];
      for (const r of rows) {
        out.push([macToDotted(r.station), r.state, r.aid !== undefined ? String(r.aid) : '-',
          r.rssiDbm !== undefined ? `${r.rssiDbm} dBm` : '-', r.rateBps !== undefined ? fmtBps(r.rateBps) : '-']);
      }
      lines.push(table(out, { indent: '  ' }));
    }
  } else if (mode === 'station') {
    const r = rows[0];
    if (r === undefined) {
      lines.push(stationJoinLine(station));
    } else {
      const signal = r.rssiDbm !== undefined ? `, signal ${r.rssiDbm} dBm` : '';
      const rate = r.rateBps !== undefined ? `, rate ${fmtBps(r.rateBps)}` : '';
      lines.push(`  Association: "${r.ssid}" via BSSID ${macToDotted(r.bssid)}, ${r.state}${signal}${rate}`);
    }
  } else if (mode === 'ue') {
    if (view?.peer !== undefined && view.state === 'attached') {
      lines.push(`  Attach: attached to ${view.peer.device} ${view.peer.port}${signalRate(view)}`);
    } else {
      lines.push(`  Not attached${view?.state !== undefined && view.state !== 'idle' ? ` (${view.state})` : ''}.`);
    }
  } else if (mode === 'ptp') {
    if (view?.peer !== undefined && p.operUp) {
      lines.push(`  Peer: ${view.peer.device} ${view.peer.port}${signalRate(view)}, range ${view.rangeM} m`);
    } else {
      lines.push('  No peer link.');
    }
  }
  return lines.join('\n');
}

const showWireless: CommandHandler = (ctx) => {
  const radios = [...ctx.ports.values()].filter((p) => p.spec.kind === 'wlan' || p.spec.kind === 'radio' || p.spec.kind === 'cellular');
  if (radios.length === 0) return { error: MSG_NO_RADIOS };
  return { output: radios.map((p) => radioBlock(ctx, p)).join('\n\n') };
};

// ── show inventory ──────────────────────────────────────────────────────────

const showInventory: CommandHandler = (ctx) => {
  const lines = [`Chassis: ${ctx.model.model} (${ctx.model.description})`];
  const slots = ctx.model.slots ?? [];
  if (slots.length === 0) {
    lines.push('This device has no module slots.');
    return { output: lines.join('\n') };
  }
  const rows: string[][] = [['Slot', 'Kind', 'Installed', 'Adds']];
  const details: string[] = [];
  for (const slot of slots) {
    const modulePorts = [...ctx.ports.values()].filter((p) => p.module !== undefined && p.module.slot === slot.id);
    const cage = slot.cage !== undefined ? ctx.ports.get(slot.cage) : undefined;
    const type = modulePorts[0]?.module?.module ?? cage?.transceiver;
    let adds = '-';
    if (modulePorts.length > 0) adds = modulePorts.map((p) => p.spec.short).join(', ');
    else if (cage !== undefined && type !== undefined) adds = `optics for ${cage.spec.short}`;
    rows.push([slot.id, SLOT_TYPE_LABEL[slot.type], type === undefined ? 'empty' : moduleName(type), adds]);
    if (type !== undefined) {
      const model = MODULE_MODELS.find((m) => m.type === type);
      details.push(`  ${slot.label}: ${model?.model ?? type}${model !== undefined ? ` - ${model.description}` : ''}`);
    }
  }
  lines.push(table(rows));
  if (details.length > 0) lines.push('', 'Installed modules:', ...details);
  return { output: lines.join('\n') };
};

/** Registry fragment for the CLI runtime: show handler id → handler. */
export const showHandlers: Readonly<Record<string, CommandHandler>> = {
  [HANDLERS.showIpIntBrief]: showIpIntBrief,
  [HANDLERS.showInterfaces]: showInterfaces,
  [HANDLERS.showInterfacesStatus]: showInterfacesStatus,
  [HANDLERS.showArp]: showArp,
  [HANDLERS.showIpArp]: showArp,
  [HANDLERS.showMac]: showMac,
  [HANDLERS.showIpRoute]: showIpRoute,
  [HANDLERS.showVersion]: showVersion,
  [HANDLERS.showRunning]: showRunning,
  [HANDLERS.showStartup]: showStartup,
  [HANDLERS.showHistory]: showHistory,
  [HANDLERS.showControllers]: showControllers,
  [HANDLERS.showWireless]: showWireless,
  [HANDLERS.showInventory]: showInventory,
};
