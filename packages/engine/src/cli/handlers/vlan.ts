/**
 * cli/handlers/vlan.ts — the VLAN database lines and `show vlan` (ARCHITECTURE-P2 §3.1, §5.1, §5.4, D3; §7 W2 cli).
 *
 * `vlan <list>` writes the section line through `ctx.config` (the config store expands `vlan 10,20` into one
 * section per VLAN, §5) and enters `config-vlan` with the typed list as its context entry, so `name <name>` inside
 * it applies to every VLAN of the list. The `vlan` daemon turns the sections into `vlans` rows. VLAN 1 and 1002–1005
 * exist implicitly (D3): they are never stored, and the handler refuses to create or remove them.
 *
 * `show vlan [brief | id <v>]` renders the VLAN database from live state: the `vlans` table when the device has one
 * (the daemon is the writer), else the `vlan` sections of the running config (a device without the daemon), plus
 * the implicit VLANs; the access ports of each VLAN come from every switched port's `readSwitchport` configuration
 * and its operational mode (a trunk belongs to no VLAN's port list). The Ports cell wraps on a `, ` boundary so that
 * every line fits `VLAN_TABLE_WIDTH` (80) columns, each continuation line indented under the Ports column
 * (ARCHITECTURE-P2 §7 W5 cli, the W4 browser-gate polish: one long cell used to break mid-name in an 80-column
 * console). Every string is original wording (spec §1.6).
 *
 * The VLAN-existence helpers are shared with the switchport handlers (auto-creation, §5.1).
 */
import type { CommandCtx, CommandHandler } from '../../contracts/cli.js';
import type { ConfigNode } from '../../contracts/config.js';
import type { PortView } from '../../contracts/port.js';
import type { DtpRow, EtherchannelRow, VlanRow } from '../../contracts/tables.js';
import { vlanKey } from '../../contracts/tables.js';
import { parseVlanList } from '../../core/vlan-list.js';
import { channelOperOf, isImplicitVlan, operOf, type L2OperMode } from '../../protocols/l2/membership.js';
import { readSwitchport } from '../../protocols/l2/switchport-config.js';
import { P2_HANDLERS, SHOW_VLAN_FORM_ARG, VLAN_NAME_MAX_LENGTH } from '../grammar/index.js';
import { table } from '../format.js';
import { fillTemplate, outcomeOf, roleOf } from './common.js';

/** `vlan <v>` / `no vlan <v>` for a built-in VLAN (1, 1002–1005). */
export const MSG_VLAN_RESERVED = '% VLAN {vlan} is built in: it always exists and cannot be created or removed.';
/** `name` typed outside a `vlan` section, or with a name that is not one word of printable characters. */
export const MSG_NO_VLAN_SELECTED = '% Select a VLAN first (vlan <number>).';
export const MSG_BAD_VLAN_NAME = `% A VLAN name is one word of up to ${VLAN_NAME_MAX_LENGTH} printable characters.`;
/** `show vlan id <v>` for a VLAN the switch does not have. */
export const MSG_NO_SUCH_VLAN = '% VLAN {vlan} does not exist on this switch.';

/** Names of the implicit VLANs (D3): VLAN 1 and the four legacy reserved ids `show vlan` lists as reserved. */
export const IMPLICIT_VLAN_NAMES: Readonly<Record<number, string>> = Object.freeze({
  1: 'default',
  1002: 'fddi-default',
  1003: 'token-ring-default',
  1004: 'fddinet-default',
  1005: 'trnet-default',
});

/** Default name of a VLAN without a `name` line: `VLAN0010`. */
export function defaultVlanName(vlan: number): string {
  return `VLAN${String(vlan).padStart(4, '0')}`;
}

/** The `vlan <v>` section node of the running config, if any (`vlan 10` is stored as one section per VLAN). */
export function vlanSection(ctx: CommandCtx, vlan: number): ConfigNode | undefined {
  const text = String(vlan);
  return ctx.running.root.children.find((c) => c.key === 'vlan' && c.args.length === 1 && c.args[0] === text);
}

/** True when VLAN `vlan` exists on this device: implicit, a `vlans` row, or a `vlan <v>` section (no daemon yet). */
export function vlanExists(ctx: CommandCtx, vlan: number): boolean {
  if (isImplicitVlan(vlan)) return true;
  const rows = ctx.tables.get?.<VlanRow>('vlans');
  if (rows !== undefined) return rows.has(vlanKey(vlan)) || vlanSection(ctx, vlan) !== undefined;
  return vlanSection(ctx, vlan) !== undefined;
}

/** One VLAN of the database as `show vlan` lists it. */
export interface VlanListing {
  vlan: number;
  name: string;
  status: 'active' | 'suspended' | 'reserved';
}

/** Name of VLAN `vlan` from its row, else its `name` line, else the default name (implicit VLANs have fixed names). */
export function vlanNameOf(ctx: CommandCtx, vlan: number): string {
  const fixed = IMPLICIT_VLAN_NAMES[vlan];
  if (fixed !== undefined) return fixed;
  const row = ctx.tables.get?.<VlanRow>('vlans')?.get(vlanKey(vlan));
  if (row !== undefined && row.name !== '') return row.name;
  const named = vlanSection(ctx, vlan)?.children.find((c) => c.key === 'name')?.args[0];
  return named !== undefined && named !== '' ? named : defaultVlanName(vlan);
}

/** The VLAN database, ascending: the implicit VLANs plus every configured one (rows first, sections as fallback). */
export function vlanListings(ctx: CommandCtx): VlanListing[] {
  const out = new Map<number, VlanListing>();
  out.set(1, { vlan: 1, name: IMPLICIT_VLAN_NAMES[1] as string, status: 'active' });
  const rows = ctx.tables.get?.<VlanRow>('vlans');
  if (rows !== undefined) {
    for (const r of rows.rows()) if (!isImplicitVlan(r.vlan)) out.set(r.vlan, { vlan: r.vlan, name: vlanNameOf(ctx, r.vlan), status: r.status });
  }
  for (const c of ctx.running.root.children) {
    if (c.key !== 'vlan' || c.args.length !== 1) continue;
    const v = Number(c.args[0]);
    if (!Number.isInteger(v) || isImplicitVlan(v) || out.has(v)) continue;
    out.set(v, { vlan: v, name: vlanNameOf(ctx, v), status: 'active' });
  }
  for (const v of [1002, 1003, 1004, 1005]) out.set(v, { vlan: v, name: IMPLICIT_VLAN_NAMES[v] as string, status: 'reserved' });
  return [...out.values()].sort((a, b) => a.vlan - b.vlan);
}

/** Bridged ports that carry switchport lines: switched Ethernet ports and Port-channels, in canonical order. */
export function switchedPorts(ctx: CommandCtx): PortView[] {
  const out: PortView[] = [];
  for (const p of ctx.ports.values()) {
    const role = roleOf(ctx, p);
    if (role === 'switched' || role === 'channel') out.push(p);
  }
  return out;
}

/** Operational mode of a switched port or Port-channel (§3.0 step 4): static modes as configured, dynamic from dtp. */
export function operModeOf(ctx: CommandCtx, port: PortView): L2OperMode {
  const config = readSwitchport(ctx.running, port.id, ctx.model);
  const dtp = ctx.tables.get?.<DtpRow>('dtp');
  if (roleOf(ctx, port) === 'channel') {
    const members = ctx.tables.get?.<EtherchannelRow>('etherchannel')?.rows().filter((r) => r.bundle === port.id && r.state === 'bundled') ?? [];
    return channelOperOf(config, members.map((m) => dtp?.get(m.port)));
  }
  return operOf(config, dtp?.get(port.id));
}

/** Ports listed for a VLAN: access ports whose access VLAN is `vlan`, plus those whose voice VLAN [S4] is `vlan`. */
export function accessPortsOf(ctx: CommandCtx, vlan: number): string[] {
  const out: string[] = [];
  for (const p of switchedPorts(ctx)) {
    if (operModeOf(ctx, p) !== 'access') continue;
    const config = readSwitchport(ctx.running, p.id, ctx.model);
    if (config.accessVlan === vlan || config.voiceVlan === vlan) out.push(p.spec.short);
  }
  return out;
}

// ── configuration ───────────────────────────────────────────────────────────

/** `vlan <list>` / `no vlan <list>`: the VLAN database lines (one stored section per VLAN). */
const vlan: CommandHandler = (ctx, args, negate) => {
  const list = args['vlans'] ?? '';
  const ids = parseVlanList(list);
  if (ids === undefined || ids.length === 0) return { error: '% Expected VLAN numbers or ranges such as 10,20,30-35.' };
  const reserved = ids.find((v) => isImplicitVlan(v));
  if (reserved !== undefined) return { error: fillTemplate(MSG_VLAN_RESERVED, { vlan: reserved }) };
  if (negate) return outcomeOf(ctx.config(['vlan', list], true, []));
  const error = ctx.config(['vlan', list], false, []);
  if (error !== undefined) return { error };
  ctx.enterMode('config-vlan', { context: [['vlan', list]] });
  return {};
};

/** `name <name>` / `no name` inside a `vlan` section (applies to every VLAN of the section's list). */
const vlanName: CommandHandler = (ctx, args, negate) => {
  const entry = ctx.context[ctx.context.length - 1];
  if (entry === undefined || entry[0] !== 'vlan') return { error: MSG_NO_VLAN_SELECTED };
  if (negate) return outcomeOf(ctx.config(['name'], true));
  const name = args['name'] ?? '';
  if (name === '' || name.length > VLAN_NAME_MAX_LENGTH || !/^[\x21-\x7e]+$/.test(name)) return { error: MSG_BAD_VLAN_NAME };
  return outcomeOf(ctx.config(['name', name], false));
};

// ── show vlan ───────────────────────────────────────────────────────────────

/** Every `show vlan` line fits this console width (§7 W5 cli, the ruling restated on 2026-09-24). */
export const VLAN_TABLE_WIDTH = 80;
/** The narrowest Ports cell the wrap ever uses, however wide the Name and Status columns grow. */
export const VLAN_PORTS_MIN_WRAP = 20;

/**
 * The lines of a Ports cell: the names joined by `, `, broken at a `, ` boundary (the separator is dropped at the
 * break) so that no line is longer than `width`; a single name longer than `width` stands alone on its line. An
 * empty list is one empty line.
 */
export function wrapPortList(ports: readonly string[], width: number): string[] {
  const lines: string[] = [];
  let current = '';
  for (const port of ports) {
    if (current === '') current = port;
    else if (current.length + 2 + port.length <= width) current += `, ${port}`;
    else {
      lines.push(current);
      current = port;
    }
  }
  lines.push(current);
  return lines;
}

/**
 * The `show vlan` table over `rows`; a wrapped Ports cell continues on rows whose other cells are empty. The Ports
 * column starts after the three columns before it (each as wide as its widest cell, two spaces apart), and the cell
 * wraps at whatever is left of `VLAN_TABLE_WIDTH` — 44 characters in the usual layout, whose Ports column starts at 36.
 */
function renderVlanTable(ctx: CommandCtx, rows: readonly VlanListing[]): string {
  const out: string[][] = [['VLAN', 'Name', 'Status', 'Ports']];
  const widest = (header: string, cells: readonly string[]): number => cells.reduce((w, c) => Math.max(w, c.length), header.length);
  const portsColumn =
    widest('VLAN', rows.map((r) => String(r.vlan))) + 2 + widest('Name', rows.map((r) => r.name)) + 2 + widest('Status', rows.map((r) => r.status)) + 2;
  const wrap = Math.max(VLAN_PORTS_MIN_WRAP, VLAN_TABLE_WIDTH - portsColumn);
  for (const r of rows) {
    const [first = '', ...more] = r.status === 'reserved' ? [''] : wrapPortList(accessPortsOf(ctx, r.vlan), wrap);
    out.push([String(r.vlan), r.name, r.status, first]);
    for (const line of more) out.push(['', '', '', line]);
  }
  return table(out, { align: ['right'] });
}

const showVlan: CommandHandler = (ctx, args) => {
  const rows = vlanListings(ctx);
  if (args[SHOW_VLAN_FORM_ARG] === 'id') {
    const wanted = Number(args['vlan']);
    const row = rows.find((r) => r.vlan === wanted);
    if (row === undefined) return { error: fillTemplate(MSG_NO_SUCH_VLAN, { vlan: args['vlan'] ?? '' }) };
    return { output: renderVlanTable(ctx, [row]) };
  }
  return { output: renderVlanTable(ctx, rows) };
};

/** Registry fragment for the CLI runtime: vlan handler id → handler. */
export const vlanHandlers: Readonly<Record<string, CommandHandler>> = {
  [P2_HANDLERS.configVlan]: vlan,
  [P2_HANDLERS.vlanName]: vlanName,
  [P2_HANDLERS.showVlan]: showVlan,
};
