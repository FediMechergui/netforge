/**
 * cli/handlers/switchport.ts — `switchport` / `no switchport` (ARCHITECTURE-P1 D3, §3.10, §6) and, from P2, the
 * switchport lines and switching show commands of a VLAN-aware switch (ARCHITECTURE-P2 §3.1, §3.2, §5.1, §5.4, D3;
 * §7 W2 cli).
 *
 * `no switchport` asks for the routed role and `switchport` for the switched role. A port whose `allowedRoles` lack
 * the target answers `CLI_MESSAGES.roleLocked` before anything is written (an NF-C2960 port, a routed router port).
 * Otherwise the line goes through `ctx.config`: the device runtime special-cases it before the AST mutation and runs
 * `setPortRole` (address withdrawal, link bounce, `portsVersion`, `portState` with reason `role-change`); the AST
 * keeps `no switchport` as a stored negation so the role survives save and reload.
 *
 * P2 lines (every one first checks that the selected port is switched or a Port-channel, else
 * `CLI_MESSAGES.notSwitchport`), each written as its canonical §5.1 line through `ctx.config`:
 *   • `switchport mode access|trunk|dynamic auto|dynamic desirable` (refused while `switchport nonegotiate` is stored
 *     and the new mode is dynamic);
 *   • `switchport access vlan <v>`: a missing VLAN is created first (`vlan <v>`, `CLI_MESSAGES.vlanCreated`);
 *   • `switchport trunk native vlan <v>`;
 *   • `switchport trunk allowed vlan <list>|add|remove|except <list>|all|none`: the keyword forms are resolved against
 *     the port's current list (`readSwitchport`) and the CANONICAL list is stored (`all` removes the line, `none`
 *     stores `none`, core/vlan-list.ts format otherwise);
 *   • `switchport nonegotiate`: access or trunk mode only (`CLI_MESSAGES.nonegotiateNeedsStaticMode`);
 *   • [S4] `switchport voice vlan <v>`: stored as typed; a VLAN that does not exist yet earns a note.
 * A switchport line typed under `interface Port-channelN` is also applied to every member whose `channel-group`
 * line names that bundle (§3.7 step 1, canonical port order, stopping on the first error), so the members and the
 * bundle keep one switchport view and the etherchannel compatibility check stays satisfied.
 * Show commands read live state only (the running config through `readSwitchport`, the dtp, etherchannel, vlans,
 * stp-bridge and stp tables). Every string is original wording (spec §1.6).
 */
import { CLI_MESSAGES, type CommandCtx, type CommandHandler, type CommandOutcome } from '../../contracts/cli.js';
import type { PortRole } from '../../contracts/catalog.js';
import type { PortId } from '../../contracts/ids.js';
import type { PortView, SwitchportConfig } from '../../contracts/port.js';
import type { StpBridgeRow, StpPortRow } from '../../contracts/tables.js';
import { stpKey, vlanKey } from '../../contracts/tables.js';
import {
  formatVlanList,
  parseVlanList,
  VLAN_LIST_ALL,
  VLAN_LIST_NONE,
  vlanListAdd,
  vlanListExcept,
  vlanListRemove,
} from '../../core/vlan-list.js';
import { readChannelGroups } from '../../protocols/etherchannel/static.js';
import { readSwitchport, switchportModeText } from '../../protocols/l2/switchport-config.js';
import { ALLOWED_FORM_ARG, ALLOWED_LIST_ARG, HANDLERS, P2_HANDLERS } from '../grammar/index.js';
import { table } from '../format.js';
import { fillTemplate, MSG_NO_INTERFACE_SELECTED, outcomeOf, roleOf, selectedPort } from './common.js';
import { operModeOf, switchedPorts, vlanExists, vlanNameOf } from './vlan.js';

/** `switchport mode dynamic …` while `switchport nonegotiate` is stored on the port. */
export const MSG_DYNAMIC_WITH_NONEGOTIATE = '% Remove "switchport nonegotiate" before choosing a dynamic mode.';
/** [S4] `switchport voice vlan <v>` for a VLAN that does not exist yet (the line is stored). */
export const MSG_VOICE_VLAN_MISSING = '% Note: VLAN {vlan} does not exist yet; the voice VLAN takes effect once it is created.';
/** `show interfaces trunk` when no port is trunking. */
export const MSG_NO_TRUNK = 'No port is trunking.';
/** `show interfaces <if> switchport` for a name the device does not have. */
export const MSG_NO_SUCH_PORT = '% No interface named "{name}" exists on this device.';

/** `switchport` / `no switchport`. */
const switchport: CommandHandler = (ctx, _args, negate) => {
  const port = selectedPort(ctx);
  if (port === undefined) return { error: MSG_NO_INTERFACE_SELECTED };
  const target: PortRole = negate ? 'routed' : 'switched';
  const allowed = port.spec.allowedRoles ?? [port.spec.role ?? roleOf(ctx, port)];
  if (!allowed.includes(target)) return { error: CLI_MESSAGES.roleLocked };
  return outcomeOf(ctx.config(['switchport'], negate));
};

/** Registry fragment for the CLI runtime: switchport handler id → handler. */
export const switchportHandlers: Readonly<Record<string, CommandHandler>> = {
  [HANDLERS.ifSwitchport]: switchport,
};

// ── P2: the switchport lines of a VLAN-aware switch ─────────────────────────────────────────────────────────────

/** The selected port when it is switched or a Port-channel, else the outcome to answer. */
function switchedPort(ctx: CommandCtx): { port: PortView } | { error: string } {
  const port = selectedPort(ctx);
  if (port === undefined) return { error: MSG_NO_INTERFACE_SELECTED };
  const role = roleOf(ctx, port);
  if (role !== 'switched' && role !== 'channel') return { error: fillTemplate(CLI_MESSAGES.notSwitchport, { port: port.id }) };
  return { port };
}

/** The members of bundle `bundle` (ports whose `channel-group` line names it), in canonical port order. */
export function membersOfBundle(ctx: Pick<CommandCtx, 'running' | 'ports'>, bundle: PortId): PortId[] {
  const named = new Set<PortId>(readChannelGroups(ctx.running).filter((g) => g.bundle === bundle).map((g) => g.port));
  const out: PortId[] = [];
  for (const id of ctx.ports.keys()) if (named.has(id)) out.push(id);
  for (const id of named) if (!out.includes(id)) out.push(id);
  return out;
}

/**
 * Store a switchport line on the selected port and, when that port is a Port-channel, on each of its members too
 * (§3.7 step 1): the same tokens, the same `no`, under `interface <member>`, stopping at the first refusal.
 */
function configWithMembers(ctx: CommandCtx, port: PortView, line: string[], negate: boolean): string | undefined {
  const error = ctx.config(line, negate);
  if (error !== undefined || roleOf(ctx, port) !== 'channel') return error;
  for (const member of membersOfBundle(ctx, port.id)) {
    const e = ctx.config(line, negate, [['interface', member]]);
    if (e !== undefined) return `${member}: ${e}`;
  }
  return undefined;
}

/** `switchport mode access|trunk` / `switchport mode dynamic auto|desirable` / `no switchport mode`. */
const switchportMode: CommandHandler = (ctx, args, negate) => {
  const sel = switchedPort(ctx);
  if ('error' in sel) return { error: sel.error };
  if (negate) return outcomeOf(configWithMembers(ctx, sel.port, ['switchport', 'mode'], true));
  const wish = args['wish'];
  const tokens = wish !== undefined ? ['dynamic', wish] : [args['mode'] ?? ''];
  if (tokens[0] === '') return { error: '% Give the mode: access, trunk, dynamic auto or dynamic desirable.' };
  if (wish !== undefined && !readSwitchport(ctx.running, sel.port.id, ctx.model).negotiate) return { error: MSG_DYNAMIC_WITH_NONEGOTIATE };
  return outcomeOf(configWithMembers(ctx, sel.port, ['switchport', 'mode', ...tokens], false));
};

/** `switchport access vlan <v>` / `no switchport access vlan`: creates a missing VLAN first (§3.1 step 2). */
const switchportAccessVlan: CommandHandler = (ctx, args, negate) => {
  const sel = switchedPort(ctx);
  if ('error' in sel) return { error: sel.error };
  if (negate) return outcomeOf(configWithMembers(ctx, sel.port, ['switchport', 'access', 'vlan'], true));
  const vlan = Number(args['vlan']);
  if (!Number.isInteger(vlan) || vlan < 1 || vlan > 4094) return { error: '% Give a VLAN number between 1 and 4094.' };
  let output: string | undefined;
  if (!vlanExists(ctx, vlan)) {
    const created = ctx.config(['vlan', String(vlan)], false, []);
    if (created !== undefined) return { error: created };
    output = fillTemplate(CLI_MESSAGES.vlanCreated, { vlan });
  }
  const error = configWithMembers(ctx, sel.port, ['switchport', 'access', 'vlan', String(vlan)], false);
  if (error !== undefined) return output === undefined ? { error } : { output, error };
  return output === undefined ? {} : { output };
};

/** `switchport trunk native vlan <v>` / its `no` form. */
const switchportTrunkNative: CommandHandler = (ctx, args, negate) => {
  const sel = switchedPort(ctx);
  if ('error' in sel) return { error: sel.error };
  if (negate) return outcomeOf(configWithMembers(ctx, sel.port, ['switchport', 'trunk', 'native', 'vlan'], true));
  const vlan = Number(args['vlan']);
  if (!Number.isInteger(vlan) || vlan < 1 || vlan > 4094) return { error: '% Give a VLAN number between 1 and 4094.' };
  return outcomeOf(configWithMembers(ctx, sel.port, ['switchport', 'trunk', 'native', 'vlan', String(vlan)], false));
};

/**
 * The canonical allowed list after applying one typed form to `current` (§5.1): a plain list replaces, `add` /
 * `remove` / `except` are resolved against the current value, `all` is every VLAN, `none` is the empty list.
 * Undefined when the list text does not parse.
 */
export function resolveAllowedVlans(current: string, form: string | undefined, list: string | undefined): string | undefined {
  const text = list ?? '';
  switch (form) {
    case 'all':
      return VLAN_LIST_ALL;
    case 'none':
      return VLAN_LIST_NONE;
    case 'add':
      return parseVlanList(text) === undefined ? undefined : vlanListAdd(current === VLAN_LIST_NONE ? '' : current, text);
    case 'remove':
      return parseVlanList(text) === undefined ? undefined : vlanListRemove(current === VLAN_LIST_NONE ? '' : current, text);
    case 'except':
      return parseVlanList(text) === undefined ? undefined : vlanListExcept(text);
    default: {
      const ids = parseVlanList(text);
      return ids === undefined || ids.length === 0 ? undefined : formatVlanList(ids);
    }
  }
}

/** `switchport trunk allowed vlan <list>|add|remove|except <list>|all|none` / `no switchport trunk allowed vlan`. */
const switchportTrunkAllowed: CommandHandler = (ctx, args, negate) => {
  const sel = switchedPort(ctx);
  if ('error' in sel) return { error: sel.error };
  const identity = ['switchport', 'trunk', 'allowed', 'vlan'];
  if (negate) return outcomeOf(configWithMembers(ctx, sel.port, identity, true));
  const current = readSwitchport(ctx.running, sel.port.id, ctx.model).allowed;
  const resolved = resolveAllowedVlans(current, args[ALLOWED_FORM_ARG], args[ALLOWED_LIST_ARG]);
  if (resolved === undefined) return { error: '% Expected VLAN numbers or ranges such as 1,10,20-30.' };
  if (resolved === VLAN_LIST_ALL) return outcomeOf(configWithMembers(ctx, sel.port, identity, true));
  return outcomeOf(configWithMembers(ctx, sel.port, [...identity, resolved === VLAN_LIST_NONE ? 'none' : resolved], false));
};

/** `switchport nonegotiate` / `no switchport nonegotiate`: fixed modes only. */
const switchportNonegotiate: CommandHandler = (ctx, _args, negate) => {
  const sel = switchedPort(ctx);
  if ('error' in sel) return { error: sel.error };
  if (negate) return outcomeOf(configWithMembers(ctx, sel.port, ['switchport', 'nonegotiate'], true));
  const mode = readSwitchport(ctx.running, sel.port.id, ctx.model).mode;
  if (mode !== 'access' && mode !== 'trunk') return { error: CLI_MESSAGES.nonegotiateNeedsStaticMode };
  return outcomeOf(configWithMembers(ctx, sel.port, ['switchport', 'nonegotiate'], false));
};

// [S4] ── voice VLAN ────────────────────────────────────────────────────────────────────────────────────────────
/** [S4] `switchport voice vlan <v>` / its `no` form: stored as typed; a missing VLAN earns a note, not a refusal. */
const switchportVoiceVlan: CommandHandler = (ctx, args, negate) => {
  const sel = switchedPort(ctx);
  if ('error' in sel) return { error: sel.error };
  if (negate) return outcomeOf(configWithMembers(ctx, sel.port, ['switchport', 'voice', 'vlan'], true));
  const vlan = Number(args['vlan']);
  if (!Number.isInteger(vlan) || vlan < 1 || vlan > 4094) return { error: '% Give a VLAN number between 1 and 4094.' };
  const error = configWithMembers(ctx, sel.port, ['switchport', 'voice', 'vlan', String(vlan)], false);
  if (error !== undefined) return { error };
  return vlanExists(ctx, vlan) ? {} : { output: fillTemplate(MSG_VOICE_VLAN_MISSING, { vlan }) };
};
// [S4] ── end ──────────────────────────────────────────────────────────────────────────────────────────────────

// ── show interfaces trunk / show interfaces [<if>] switchport ───────────────────────────────────────────────────

/** VLANs of `allowed` that exist on this device, canonical text. */
function existingOf(ctx: CommandCtx, allowed: string): string {
  const ids = parseVlanList(allowed) ?? [];
  return formatVlanList(ids.filter((v) => vlanExists(ctx, v)));
}

/** Of the existing VLANs `list`, those the port forwards in: no spanning tree for a VLAN means forwarding (§3.0). */
function forwardingOf(ctx: CommandCtx, port: PortView, list: string): string {
  const bridges = ctx.tables.get?.<StpBridgeRow>('stp-bridge');
  const stp = ctx.tables.get?.<StpPortRow>('stp');
  const ids = parseVlanList(list) ?? [];
  return formatVlanList(ids.filter((v) => {
    if (bridges === undefined || !bridges.has(vlanKey(v))) return true;
    return stp?.get(stpKey(v, port.id))?.state === 'forwarding';
  }));
}

/** Text of a VLAN list for display: `all` for every VLAN, `none` for the empty list. */
function listText(list: string): string {
  if (list === VLAN_LIST_ALL) return 'all';
  if (list === VLAN_LIST_NONE) return 'none';
  return list;
}

/** A VLAN number with its name, and why it is inactive when it does not exist. */
function vlanText(ctx: CommandCtx, vlan: number): string {
  if (!vlanExists(ctx, vlan)) return `${vlan} (inactive: VLAN ${vlan} does not exist)`;
  return `${vlan} (${vlanNameOf(ctx, vlan)})`;
}

const showInterfacesTrunk: CommandHandler = (ctx) => {
  const trunks = switchedPorts(ctx).filter((p) => operModeOf(ctx, p) === 'trunk');
  if (trunks.length === 0) return { output: MSG_NO_TRUNK };
  const configs = new Map<string, SwitchportConfig>();
  for (const p of trunks) configs.set(p.id, readSwitchport(ctx.running, p.id, ctx.model));
  const cfg = (p: PortView): SwitchportConfig => configs.get(p.id) as SwitchportConfig;
  const head: string[][] = [['Port', 'Mode', 'Negotiation', 'Status', 'Native VLAN']];
  for (const p of trunks) head.push([p.id, switchportModeText(cfg(p).mode), cfg(p).negotiate ? 'on' : 'off', 'trunking', String(cfg(p).nativeVlan)]);
  const allowed: string[][] = [['Port', 'VLANs allowed on the trunk']];
  for (const p of trunks) allowed.push([p.id, listText(cfg(p).allowed)]);
  const active: string[][] = [['Port', 'VLANs allowed and existing']];
  for (const p of trunks) active.push([p.id, listText(existingOf(ctx, cfg(p).allowed))]);
  const forwarding: string[][] = [['Port', 'VLANs forwarding (spanning tree)']];
  for (const p of trunks) forwarding.push([p.id, listText(forwardingOf(ctx, p, existingOf(ctx, cfg(p).allowed)))]);
  return { output: [table(head), '', table(allowed), '', table(active), '', table(forwarding)].join('\n') };
};

/** One `show interfaces <if> switchport` block. */
export function renderSwitchport(ctx: CommandCtx, p: PortView): string {
  const role = roleOf(ctx, p);
  const lines = [`Name: ${p.id}`];
  if (role !== 'switched' && role !== 'channel') {
    lines.push('Switched port: no (a routed interface)');
    return lines.join('\n');
  }
  const cfg = readSwitchport(ctx.running, p.id, ctx.model);
  const oper = operModeOf(ctx, p);
  lines.push('Switched port: yes');
  lines.push(`Administrative mode: ${switchportModeText(cfg.mode)}`);
  lines.push(`Operational mode: ${oper}${p.operUp ? '' : ' (link down)'}`);
  lines.push(`Trunk negotiation: ${cfg.negotiate ? 'on' : 'off'}`);
  lines.push(`Access VLAN: ${vlanText(ctx, cfg.accessVlan)}`);
  lines.push(`Voice VLAN: ${cfg.voiceVlan === undefined ? 'none' : vlanText(ctx, cfg.voiceVlan)}`); // [S4]
  lines.push(`Trunk native VLAN: ${vlanText(ctx, cfg.nativeVlan)}`);
  lines.push(`Trunk allowed VLANs: ${listText(cfg.allowed)}`);
  lines.push(`Trunk VLANs allowed and existing: ${listText(existingOf(ctx, cfg.allowed))}`);
  return lines.join('\n');
}

const showInterfacesSwitchport: CommandHandler = (ctx, args): CommandOutcome => {
  const name = args['iface'];
  if (name !== undefined && name !== '') {
    const id = ctx.ports.has(name) ? name : ctx.resolvePort(name);
    const p = id === undefined ? undefined : ctx.ports.get(id);
    if (p === undefined) return { error: fillTemplate(MSG_NO_SUCH_PORT, { name }) };
    return { output: renderSwitchport(ctx, p) };
  }
  const blocks = switchedPorts(ctx).map((p) => renderSwitchport(ctx, p));
  return { output: blocks.length === 0 ? 'This device has no switched ports.' : blocks.join('\n\n') };
};

/** @since P2 Registry fragment: the P2 switchport lines and switching show commands. */
export const switchportP2Handlers: Readonly<Record<string, CommandHandler>> = {
  [P2_HANDLERS.ifSwitchportMode]: switchportMode,
  [P2_HANDLERS.ifSwitchportAccessVlan]: switchportAccessVlan,
  [P2_HANDLERS.ifSwitchportTrunkNative]: switchportTrunkNative,
  [P2_HANDLERS.ifSwitchportTrunkAllowed]: switchportTrunkAllowed,
  [P2_HANDLERS.ifSwitchportNonegotiate]: switchportNonegotiate,
  [P2_HANDLERS.ifSwitchportVoiceVlan]: switchportVoiceVlan, // [S4]
  [P2_HANDLERS.showInterfacesTrunk]: showInterfacesTrunk,
  [P2_HANDLERS.showInterfacesSwitchport]: showInterfacesSwitchport,
};
