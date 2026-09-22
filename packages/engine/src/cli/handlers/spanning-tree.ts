/**
 * cli/handlers/spanning-tree.ts — the spanning-tree lines, the root macro, `show spanning-tree`, `show dtp interface`
 * and `clear spanning-tree detected-protocols` (ARCHITECTURE-P2 §3.6, §5.1, §5.4, D9; §7 W3 cli).
 *
 * Every configuration line is validated here and stored as its canonical §5.1 line through `ctx.config`; the stp
 * daemon (and dtp for `show dtp`) is the consumer. Rules the handlers enforce:
 *   • `no spanning-tree mode` clears the slot; the device runtime restores the model default in a P2 world (§5);
 *   • `no spanning-tree extend system-id` is refused (`CLI_MESSAGES.extendSystemIdFixed`);
 *   • bridge priorities are multiples of 4096, port priorities multiples of 16;
 *   • `spanning-tree vlan <list> root primary|secondary` is a macro: it reads the `stp-bridge` row of each VLAN and
 *     stores `spanning-tree vlan <v> priority <p>` per `rootMacroPriority` (protocols/stp/ids.ts); when the root of
 *     any VLAN of the list already uses priority 0 the whole line is refused (`CLI_MESSAGES.rootPriorityExhausted`)
 *     and nothing is stored; a VLAN without an instance gets the plain 24576 / 28672;
 *   • `spanning-tree portfast` on an operationally trunking port is stored with the note `CLI_MESSAGES.portfastOnTrunk`.
 * Show commands read live state only: the `stp` and `stp-bridge` tables (one writer, D6), the `dtp` table and the
 * running config. `clear spanning-tree detected-protocols` sends `STP_CLEAR_DETECTED_REQUEST` to stp. Every string is
 * original wording (spec §1.6).
 */
import { CLI_MESSAGES, type CommandCtx, type CommandHandler, type CommandOutcome } from '../../contracts/cli.js';
import type { PortId } from '../../contracts/ids.js';
import type { PortView } from '../../contracts/port.js';
import type { DtpRow, StpBridgeRow, StpPortRow } from '../../contracts/tables.js';
import { vlanKey } from '../../contracts/tables.js';
import { parseVlanList } from '../../core/vlan-list.js';
import { readSwitchport, switchportModeText } from '../../protocols/l2/switchport-config.js';
import { configuredPriorityOf, isBridgePriority, isPortPriority, parseBridgeIdText, rootMacroPriority, STP_ROOT_PRIMARY_PRIORITY, STP_ROOT_SECONDARY_PRIORITY } from '../../protocols/stp/ids.js';
import { P2_HANDLERS, STP_CLEAR_DETECTED_REQUEST, STP_SHOW_DETAIL_ARG, STP_SHOW_FORM_ARG } from '../grammar/index.js';
import { fmtDuration, table } from '../format.js';
import { fillTemplate, MSG_NO_INTERFACE_SELECTED, outcomeOf, roleOf, selectedPort } from './common.js';
import { MSG_NO_SUCH_PORT } from './switchport.js';
import { defaultVlanName, operModeOf } from './vlan.js';

/** A bridge priority that is not a multiple of 4096. */
export const MSG_BAD_BRIDGE_PRIORITY = '% A bridge priority is a multiple of 4096 between 0 and 61440.';
/** A port priority that is not a multiple of 16. */
export const MSG_BAD_PORT_PRIORITY = '% A port priority is a multiple of 16 between 0 and 240.';
/** A VLAN list that does not parse. */
export const MSG_BAD_VLAN_LIST = '% Expected VLAN numbers or ranges such as 1,10,20-30.';
/** `show spanning-tree` when no instance exists. */
export const MSG_STP_NOT_RUNNING = 'Spanning tree is not running: no VLAN has an instance on this switch.';
/** `show spanning-tree interface <if>` for a port with no instance. */
export const MSG_STP_NO_PORT_INSTANCE = 'Spanning tree does not run on {port}.';
/** `show dtp interface <if>` on a port that has never negotiated. */
export const MSG_DTP_NOTHING_HEARD = 'no negotiation frame has been received on this port';

/** The selected port when it is switched or a Port-channel, else the outcome to answer (shared by the L2 lines). */
export function selectedBridgedPort(ctx: CommandCtx): { port: PortView } | { error: string } {
  const port = selectedPort(ctx);
  if (port === undefined) return { error: MSG_NO_INTERFACE_SELECTED };
  const role = roleOf(ctx, port);
  if (role !== 'switched' && role !== 'channel') return { error: fillTemplate(CLI_MESSAGES.notSwitchport, { port: port.id }) };
  return { port };
}

/** A port view by typed name (canonical id or any accepted spelling). */
export function portByName(ctx: CommandCtx, name: string): PortView | undefined {
  const id = ctx.ports.has(name) ? name : ctx.resolvePort(name);
  return id === undefined ? undefined : ctx.ports.get(id);
}

/** The VLAN ids of a typed list, or undefined when it does not parse. */
function vlansOf(text: string | undefined): number[] | undefined {
  const ids = parseVlanList(text ?? '');
  return ids === undefined || ids.length === 0 ? undefined : ids;
}

// ── global lines ────────────────────────────────────────────────────────────────────────────────────────────────

/** `spanning-tree mode pvst|rapid-pvst` / `no spanning-tree mode` (the runtime restores the model default, §5). */
const stpMode: CommandHandler = (ctx, args, negate) => {
  if (negate) return outcomeOf(ctx.config(['spanning-tree', 'mode'], true, []));
  const mode = args['mode'];
  if (mode !== 'pvst' && mode !== 'rapid-pvst') return { error: '% Give the flavour: pvst or rapid-pvst.' };
  return outcomeOf(ctx.config(['spanning-tree', 'mode', mode], false, []));
};

/** `spanning-tree extend system-id`; its `no` form is refused (deviation (13)). */
const stpExtend: CommandHandler = (ctx, _args, negate) => {
  if (negate) return { error: CLI_MESSAGES.extendSystemIdFixed };
  return outcomeOf(ctx.config(['spanning-tree', 'extend', 'system-id'], false, []));
};

/** `spanning-tree vlan <list> priority <p>` / `no spanning-tree vlan <list> priority`. */
const stpVlanPriority: CommandHandler = (ctx, args, negate) => {
  const list = args['vlans'] ?? '';
  if (vlansOf(list) === undefined) return { error: MSG_BAD_VLAN_LIST };
  if (negate) return outcomeOf(ctx.config(['spanning-tree', 'vlan', list, 'priority'], true, []));
  const priority = Number(args['priority']);
  if (!isBridgePriority(priority)) return { error: MSG_BAD_BRIDGE_PRIORITY };
  return outcomeOf(ctx.config(['spanning-tree', 'vlan', list, 'priority', String(priority)], false, []));
};

/** What the root macro stores for one VLAN: from its `stp-bridge` row, or the plain macro priority without one. */
export function rootMacroFor(ctx: CommandCtx, which: 'primary' | 'secondary', vlan: number): ReturnType<typeof rootMacroPriority> {
  const row = ctx.tables.get?.<StpBridgeRow>('stp-bridge')?.get(vlanKey(vlan));
  if (row !== undefined) return rootMacroPriority(which, row);
  return { kind: 'store', priority: which === 'primary' ? STP_ROOT_PRIMARY_PRIORITY : STP_ROOT_SECONDARY_PRIORITY };
}

/** `spanning-tree vlan <list> root primary|secondary`: the macro of §5.1. */
const stpVlanRoot: CommandHandler = (ctx, args) => {
  const vlans = vlansOf(args['vlans']);
  if (vlans === undefined) return { error: MSG_BAD_VLAN_LIST };
  const which = args['which'];
  if (which !== 'primary' && which !== 'secondary') return { error: '% Give primary or secondary.' };
  const plan: { vlan: number; priority: number }[] = [];
  for (const vlan of vlans) {
    const outcome = rootMacroFor(ctx, which, vlan);
    if (outcome.kind === 'exhausted') return { error: fillTemplate(CLI_MESSAGES.rootPriorityExhausted, { vlan }) };
    if (outcome.kind === 'store') plan.push({ vlan, priority: outcome.priority });
  }
  for (const { vlan, priority } of plan) {
    const error = ctx.config(['spanning-tree', 'vlan', String(vlan), 'priority', String(priority)], false, []);
    if (error !== undefined) return { error };
  }
  return {};
};

/** `spanning-tree vlan <list>` (the default) / `no spanning-tree vlan <list>` (a stored negation per VLAN). */
const stpVlan: CommandHandler = (ctx, args, negate) => {
  const list = args['vlans'] ?? '';
  if (vlansOf(list) === undefined) return { error: MSG_BAD_VLAN_LIST };
  return outcomeOf(ctx.config(['spanning-tree', 'vlan', list], negate, []));
};

/** `spanning-tree portfast default` / its `no` form. */
const stpPortfastDefault: CommandHandler = (ctx, _args, negate) => outcomeOf(ctx.config(['spanning-tree', 'portfast', 'default'], negate, []));

/** `spanning-tree portfast bpduguard default` / its `no` form. */
const stpBpduguardDefault: CommandHandler = (ctx, _args, negate) => outcomeOf(ctx.config(['spanning-tree', 'portfast', 'bpduguard', 'default'], negate, []));

// ── interface lines ─────────────────────────────────────────────────────────────────────────────────────────────

/** `spanning-tree portfast [trunk|disable]` / `no spanning-tree portfast`: stored; a trunking port earns the note. */
const ifPortfast: CommandHandler = (ctx, args, negate) => {
  const sel = selectedBridgedPort(ctx);
  if ('error' in sel) return { error: sel.error };
  if (negate) return outcomeOf(ctx.config(['spanning-tree', 'portfast'], true));
  const kind = args['kind'];
  const line = kind === undefined || kind === '' ? ['spanning-tree', 'portfast'] : ['spanning-tree', 'portfast', kind];
  const error = ctx.config(line, false);
  if (error !== undefined) return { error };
  if (kind !== 'trunk' && kind !== 'disable' && operModeOf(ctx, sel.port) === 'trunk') {
    return { output: fillTemplate(CLI_MESSAGES.portfastOnTrunk, { port: sel.port.id }) };
  }
  return {};
};

/** One `spanning-tree <key> <value>` interface line with a choice value. */
function ifChoiceLine(key: string, arg: string, choices: readonly string[]): CommandHandler {
  return (ctx, args, negate) => {
    const sel = selectedBridgedPort(ctx);
    if ('error' in sel) return { error: sel.error };
    if (negate) return outcomeOf(ctx.config(['spanning-tree', key], true));
    const value = args[arg];
    if (value === undefined || !choices.includes(value)) return { error: `% Give one of: ${choices.join(', ')}.` };
    return outcomeOf(ctx.config(['spanning-tree', key, value], false));
  };
}

/** `spanning-tree cost <n>` / `spanning-tree vlan <list> cost <n>` and the port-priority twins. */
function ifNumberLine(key: 'cost' | 'port-priority', perVlan: boolean): CommandHandler {
  return (ctx, args, negate) => {
    const sel = selectedBridgedPort(ctx);
    if ('error' in sel) return { error: sel.error };
    const head = ['spanning-tree'];
    if (perVlan) {
      const list = args['vlans'] ?? '';
      if (vlansOf(list) === undefined) return { error: MSG_BAD_VLAN_LIST };
      head.push('vlan', list);
    }
    if (negate) return outcomeOf(ctx.config([...head, key], true));
    const value = Number(args[key === 'cost' ? 'cost' : 'priority']);
    if (!Number.isInteger(value)) return { error: key === 'cost' ? '% Give a path cost between 1 and 200000000.' : MSG_BAD_PORT_PRIORITY };
    if (key === 'port-priority' && !isPortPriority(value)) return { error: MSG_BAD_PORT_PRIORITY };
    if (key === 'cost' && (value < 1 || value > 200_000_000)) return { error: '% Give a path cost between 1 and 200000000.' };
    return outcomeOf(ctx.config([...head, key, String(value)], false));
  };
}

// ── show spanning-tree ──────────────────────────────────────────────────────────────────────────────────────────

/** The `stp-bridge` rows, ascending VLAN. */
export function stpInstances(ctx: CommandCtx): StpBridgeRow[] {
  return (ctx.tables.get?.<StpBridgeRow>('stp-bridge')?.rows() ?? []).sort((a, b) => a.vlan - b.vlan);
}

/** The `stp` rows of one VLAN in canonical port order (ports unknown to the device last, by name). */
export function stpPortsOf(ctx: CommandCtx, vlan: number): StpPortRow[] {
  const rows = (ctx.tables.get?.<StpPortRow>('stp')?.rows() ?? []).filter((r) => r.vlan === vlan);
  const order = new Map<PortId, number>();
  let i = 0;
  for (const id of ctx.ports.keys()) order.set(id, i++);
  return rows.sort((a, b) => (order.get(a.port) ?? 1e9) - (order.get(b.port) ?? 1e9) || (a.port < b.port ? -1 : a.port > b.port ? 1 : 0));
}

/** `priority 32769  address 02:…` for a bridge id text. */
function bridgeText(id: string): string {
  const b = parseBridgeIdText(id);
  return b === undefined ? id : `priority ${b.priority}  address ${b.mac}`;
}

/** The notes column of a port row: edge, inconsistency, migrated flavour, guard. */
export function stpPortNotes(row: StpPortRow, bridge: StpBridgeRow | undefined): string {
  const notes: string[] = [];
  if (row.edge) notes.push('edge');
  if (row.inconsistent !== undefined) notes.push(`${row.inconsistent}-inconsistent`);
  if (row.bpduGuard === true) notes.push('bpdu guard');
  if (bridge?.mode === 'rapid-pvst' && row.protocol === 'stp') notes.push('classic neighbour');
  return notes.join(', ');
}

/** The port table of one instance. */
function portTable(ctx: CommandCtx, bridge: StpBridgeRow): string {
  const out: string[][] = [['Port', 'Role', 'State', 'Cost', 'Port id', 'Notes']];
  for (const r of stpPortsOf(ctx, bridge.vlan)) out.push([r.port, r.role, r.state, String(r.cost), r.portId, stpPortNotes(r, bridge)]);
  return out.length === 1 ? '  (no port takes part yet)' : table(out, { indent: '  ' });
}

/** One instance block of `show spanning-tree`. */
export function renderInstance(ctx: CommandCtx, b: StpBridgeRow): string {
  const own = parseBridgeIdText(b.bridgeId);
  const lines = [`${defaultVlanName(b.vlan)}  (${b.mode})`];
  if (b.isRoot) lines.push(`  Root bridge    ${bridgeText(b.rootId)}  (this switch is the root)`);
  else lines.push(`  Root bridge    ${bridgeText(b.rootId)}  reached through ${b.rootPort ?? 'no port'} at cost ${b.rootCost}`);
  const configured = own === undefined ? undefined : configuredPriorityOf(own, b.vlan);
  lines.push(`  This bridge    ${bridgeText(b.bridgeId)}${configured === undefined ? '' : `  (${configured} + VLAN ${b.vlan})`}`);
  lines.push(`  Timers         hello ${b.helloS} s, max age ${b.maxAgeS} s, forward delay ${b.forwardDelayS} s`);
  const last = b.lastChangeAt === undefined ? 'none yet' : `last ${fmtDuration(ctx.now - b.lastChangeAt)} ago${b.lastChangePort === undefined ? '' : ` through ${b.lastChangePort}`}`;
  lines.push(`  Topology changes  ${b.topologyChanges} (${last})`);
  lines.push('');
  lines.push(portTable(ctx, b));
  return lines.join('\n');
}

/** `show spanning-tree summary`. */
function renderSummary(ctx: CommandCtx, instances: readonly StpBridgeRow[]): string {
  const root = ctx.running.root;
  const modeLine = root.children.find((c) => c.key === 'spanning-tree' && c.args[0] === 'mode');
  const has = (...tokens: string[]): boolean => root.children.some((c) => c.key === 'spanning-tree' && tokens.every((t, i) => c.args[i] === t) && c.args.length === tokens.length);
  const lines = [
    `Spanning-tree flavour: ${modeLine?.args[1] ?? 'off'}`,
    'Bridge identifiers include the VLAN number: yes',
    `PortFast on every non-trunking port by default: ${has('portfast', 'default') ? 'yes' : 'no'}`,
    `BPDU guard on edge ports by default: ${has('portfast', 'bpduguard', 'default') ? 'yes' : 'no'}`,
  ];
  const roots = instances.filter((b) => b.isRoot).map((b) => defaultVlanName(b.vlan));
  lines.push(`Root bridge for: ${roots.length === 0 ? 'no VLAN' : roots.join(', ')}`);
  lines.push('');
  const rows: string[][] = [['VLAN', 'Blocking', 'Listening', 'Learning', 'Forwarding', 'Total']];
  const totals = [0, 0, 0, 0, 0];
  for (const b of instances) {
    const counts = [0, 0, 0, 0];
    for (const r of stpPortsOf(ctx, b.vlan)) {
      if (r.state === 'blocking' || r.state === 'discarding') counts[0]!++;
      else if (r.state === 'listening') counts[1]!++;
      else if (r.state === 'learning') counts[2]!++;
      else if (r.state === 'forwarding') counts[3]!++;
    }
    const total = counts.reduce((a, c) => a + c, 0);
    counts.forEach((c, i) => (totals[i]! += c));
    totals[4]! += total;
    rows.push([defaultVlanName(b.vlan), ...counts.map(String), String(total)]);
  }
  rows.push([`${instances.length} VLAN${instances.length === 1 ? '' : 's'}`, ...totals.map(String)]);
  lines.push(table(rows));
  return lines.join('\n');
}

/** `show spanning-tree root`. */
function renderRoot(instances: readonly StpBridgeRow[]): string {
  const rows: string[][] = [['VLAN', 'Root priority', 'Root address', 'Cost', 'Hello', 'Max age', 'Fwd delay', 'Root port']];
  for (const b of instances) {
    const id = parseBridgeIdText(b.rootId);
    rows.push([
      defaultVlanName(b.vlan),
      id === undefined ? b.rootId : String(id.priority),
      id === undefined ? '' : id.mac,
      String(b.rootCost),
      `${b.helloS} s`,
      `${b.maxAgeS} s`,
      `${b.forwardDelayS} s`,
      b.isRoot ? '(this switch)' : (b.rootPort ?? '-'),
    ]);
  }
  return table(rows);
}

/** `show spanning-tree [vlan <v>] interface <if> [detail]`: the port's rows, in one VLAN when `vlan` is given. */
function renderInterface(ctx: CommandCtx, port: PortView, instances: readonly StpBridgeRow[], detail: boolean, vlan?: number): string {
  const byVlan = new Map<number, StpBridgeRow>();
  for (const b of instances) byVlan.set(b.vlan, b);
  const rows = (ctx.tables.get?.<StpPortRow>('stp')?.rows() ?? [])
    .filter((r) => r.port === port.id && (vlan === undefined || r.vlan === vlan))
    .sort((a, b) => a.vlan - b.vlan);
  if (rows.length === 0) return fillTemplate(MSG_STP_NO_PORT_INSTANCE, { port: vlan === undefined ? port.id : `${port.id} in ${defaultVlanName(vlan)}` });
  if (!detail) {
    const out: string[][] = [['VLAN', 'Role', 'State', 'Cost', 'Port id', 'Notes']];
    for (const r of rows) out.push([defaultVlanName(r.vlan), r.role, r.state, String(r.cost), r.portId, stpPortNotes(r, byVlan.get(r.vlan))]);
    return table(out);
  }
  const blocks: string[] = [];
  for (const r of rows) {
    const lines = [
      `${port.id} in ${defaultVlanName(r.vlan)}`,
      `  Role: ${r.role}   State: ${r.state}   Flavour: ${r.protocol === 'rstp' ? 'rapid' : 'classic'}`,
      `  Cost: ${r.cost}   Port id: ${r.portId}   Edge: ${r.edge ? 'yes' : 'no'}`,
      `  Designated bridge: ${bridgeText(r.designatedBridge)}   Designated port: ${r.designatedPort}`,
      `  In this state for ${fmtDuration(ctx.now - r.stateSince)}${r.nextTransitionAt === undefined ? '' : `, next change in ${fmtDuration(r.nextTransitionAt - ctx.now)}`}`,
    ];
    if (r.inconsistent !== undefined) lines.push(`  Inconsistency: ${r.inconsistent}`);
    if (r.bpduGuard === true) lines.push('  BPDU guard: on');
    blocks.push(lines.join('\n'));
  }
  return blocks.join('\n\n');
}

const showSpanningTree: CommandHandler = (ctx, args): CommandOutcome => {
  const instances = stpInstances(ctx);
  const form = args[STP_SHOW_FORM_ARG];
  const vlanText = args['vlan'];
  let selected = instances;
  if (vlanText !== undefined && vlanText !== '') {
    const vlan = Number(vlanText);
    selected = instances.filter((b) => b.vlan === vlan);
    if (selected.length === 0) return { error: fillTemplate(CLI_MESSAGES.stpVlanMissing, { vlan: vlanText }) };
  }
  if (form === 'interface') {
    const name = args['iface'] ?? '';
    const port = portByName(ctx, name);
    if (port === undefined) return { error: fillTemplate(MSG_NO_SUCH_PORT, { name }) };
    const vlan = vlanText === undefined || vlanText === '' ? undefined : Number(vlanText);
    return { output: renderInterface(ctx, port, selected, args[STP_SHOW_DETAIL_ARG] === 'detail', vlan) };
  }
  if (instances.length === 0) return { output: MSG_STP_NOT_RUNNING };
  if (form === 'summary') return { output: renderSummary(ctx, selected) };
  if (form === 'root') return { output: renderRoot(selected) };
  return { output: selected.map((b) => renderInstance(ctx, b)).join('\n\n') };
};

// ── show dtp interface <if> ─────────────────────────────────────────────────────────────────────────────────────

/** Status text of a `dtp` row (or its absence). */
export function dtpStatusText(row: DtpRow | undefined, negotiate: boolean): string {
  if (!negotiate) return 'static (negotiation switched off)';
  if (row === undefined) return `waiting (${MSG_DTP_NOTHING_HEARD})`;
  switch (row.status) {
    case 'negotiated':
      return 'negotiated with the neighbour';
    case 'waiting':
      return `waiting (${MSG_DTP_NOTHING_HEARD})`;
    default:
      return 'static';
  }
}

const showDtpInterface: CommandHandler = (ctx, args) => {
  const name = args['iface'] ?? '';
  const port = portByName(ctx, name);
  if (port === undefined) return { error: fillTemplate(MSG_NO_SUCH_PORT, { name }) };
  const role = roleOf(ctx, port);
  if (role !== 'switched' && role !== 'channel') return { error: fillTemplate(CLI_MESSAGES.notSwitchport, { port: port.id }) };
  const cfg = readSwitchport(ctx.running, port.id, ctx.model);
  const row = ctx.tables.get?.<DtpRow>('dtp')?.get(port.id);
  const lines = [
    port.id,
    `  Configured mode: ${switchportModeText(cfg.mode)}`,
    `  Operational mode: ${operModeOf(ctx, port)}${port.operUp ? '' : ' (link down)'}`,
    `  Negotiation: ${cfg.negotiate ? 'on' : 'off'}`,
    `  Status: ${dtpStatusText(row, cfg.negotiate)}`,
    `  Neighbour: ${row?.neighbor === undefined ? 'none heard' : `${row.neighbor}${row.neighborMode === undefined ? '' : ` (${switchportModeText(row.neighborMode)})`}`}`,
  ];
  return { output: lines.join('\n') };
};

// ── clear spanning-tree detected-protocols [interface <if>] ────────────────────────────────────────────────────

const clearDetected: CommandHandler = (ctx, args) => {
  const name = args['iface'];
  let port: PortId | undefined;
  if (name !== undefined && name !== '') {
    const view = portByName(ctx, name);
    if (view === undefined) return { error: fillTemplate(MSG_NO_SUCH_PORT, { name }) };
    port = view.id;
  }
  ctx.request('stp', port === undefined ? { kind: STP_CLEAR_DETECTED_REQUEST, session: ctx.session.id } : { kind: STP_CLEAR_DETECTED_REQUEST, port, session: ctx.session.id });
  return {};
};

/** @since P2 Registry fragment: the spanning-tree lines and show commands. */
export const spanningTreeHandlers: Readonly<Record<string, CommandHandler>> = {
  [P2_HANDLERS.configStpMode]: stpMode,
  [P2_HANDLERS.configStpExtend]: stpExtend,
  [P2_HANDLERS.configStpVlanPriority]: stpVlanPriority,
  [P2_HANDLERS.configStpVlanRoot]: stpVlanRoot,
  [P2_HANDLERS.configStpVlan]: stpVlan,
  [P2_HANDLERS.configStpPortfastDefault]: stpPortfastDefault,
  [P2_HANDLERS.configStpBpduguardDefault]: stpBpduguardDefault,
  [P2_HANDLERS.ifStpPortfast]: ifPortfast,
  [P2_HANDLERS.ifStpBpduguard]: ifChoiceLine('bpduguard', 'mode', ['enable', 'disable']),
  [P2_HANDLERS.ifStpGuard]: ifChoiceLine('guard', 'mode', ['root', 'none']),
  [P2_HANDLERS.ifStpCost]: ifNumberLine('cost', false),
  [P2_HANDLERS.ifStpPortPriority]: ifNumberLine('port-priority', false),
  [P2_HANDLERS.ifStpVlanCost]: ifNumberLine('cost', true),
  [P2_HANDLERS.ifStpVlanPortPriority]: ifNumberLine('port-priority', true),
  [P2_HANDLERS.showSpanningTree]: showSpanningTree,
  [P2_HANDLERS.showDtpInterface]: showDtpInterface,
  [P2_HANDLERS.execClearStpDetected]: clearDetected,
};
