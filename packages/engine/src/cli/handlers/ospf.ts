/**
 * cli/handlers/ospf.ts — OSPFv2 configuration lines and the W2 shows (ARCHITECTURE-P3 §5.1, §5.8, D7, D9, D11; §7 W2
 * cli part 1).
 *
 * Storage follows the W1 config rules (cli/config-rules.ts): `router ospf <pid>` is a section entered in mode
 * `config-router`; its children are single slots except `network` (multi, identity 3) and `passive-interface` (multi,
 * both forms). The handlers add what the rules cannot know:
 *   • one process per device (`CLI_MESSAGES.ospfOneProcess`) and none under a stored `no ip routing`
 *     (`ospfNeedsIpRouting`);
 *   • `network A W area X` is stored with A masked by W (the device's own canonical form); the same A W in another
 *     area is refused (`ospfNetworkOtherArea`), the same area typed another way (`0` / `0.0.0.0`) is a no-op;
 *   • `passive-interface X` under `passive-interface default` cancels the stored `no passive-interface X`; without the
 *     default `no passive-interface X` only removes the positive line (no negation is kept), and `no passive-interface
 *     default` clears every stored negation (D7);
 *   • `router-id` changed while the process runs prints `ospfRouterIdLater` (the id in use changes at `clear ip ospf
 *     process` or a reload);
 *   • `ip ospf <pid> area <a>` replaces another pid's line (the rule's identity-2 slot); `no ip ospf <pid> area …`
 *     removes the stored line whatever spelling its area has.
 * `clear ip ospf process` asks `CLI_MESSAGES.clearOspfConfirm` (interactive, so headless configure refuses it) and
 * sends `ospf.clear {session}` on yes.
 *
 * The shows read the `ospf-interfaces` and `ospf-neighbors` rows (absent tables read as empty) and the ospf StateView
 * (`OspfStateView`, §2.6) for the countdowns. Every string is original wording (spec §1.6); RFC state words (FULL,
 * DR, BDR, 2WAY) are protocol facts.
 */
import { ipv4ToU32, parseIpv4, u32ToIpv4 } from '../../contracts/addr.js';
import { PORT_FAMILIES } from '../../contracts/catalog.js';
import { CLI_MESSAGES, type CommandCtx, type CommandHandler, type CommandOutcome } from '../../contracts/cli.js';
import type { ConfigNode } from '../../contracts/config.js';
import type { PortId } from '../../contracts/ids.js';
import type { PortView } from '../../contracts/port.js';
import type { OspfInterfaceRow, OspfIsmState, OspfNeighborRow, OspfNsmState, OspfStateView } from '../../contracts/tables.js';
import { readOspfConfig } from '../../protocols/ospf/config.js';
import { fmtDuration, fmtSince, table } from '../format.js';
import { OSPF_HANDLERS, OSPF_PASSIVE_DEFAULT_ARG, OSPF_SHOW_BRIEF_ARG } from '../grammar/ospf.js';
import { enterMode, fillTemplate, globalContext, MSG_NO_INTERFACE_SELECTED, outcomeOf, selectedInterface } from './common.js';

/** `show ip ospf …` / `clear ip ospf process` without a `router ospf` section. */
export const MSG_NO_OSPF = 'No OSPF process is configured.';
/** A `config-router` line typed outside a `router ospf` section. */
export const MSG_NO_OSPF_SELECTED = '% Select the OSPF process first (router ospf <process>).';
/** `router-id 0.0.0.0`. */
export const MSG_ROUTER_ID_ZERO = '% 0.0.0.0 cannot be a router ID.';
/** The note of `auto-cost reference-bandwidth`. */
export const MSG_REFERENCE_NOTE = 'Note: give every OSPF router the same reference bandwidth, or their costs will not agree.';
/** `show ip ospf interface <if>` on an interface that does not run OSPF. */
export const MSG_OSPF_NOT_ON = (port: string): string => `${port} does not run OSPF.`;
/** `show ip ospf neighbor` with no neighbour. */
export const MSG_NO_OSPF_NEIGHBOUR = 'No OSPF neighbour has been heard yet.';
/** `show ip ospf interface` with no OSPF interface. */
export const MSG_NO_OSPF_INTERFACE = 'No interface runs OSPF yet.';
/** `clear ip ospf process` answered with anything but yes. */
export const MSG_CLEAR_OSPF_CANCELLED = 'Nothing was restarted.';

/** The ospf daemon's process name. */
const OSPF_PROCESS = 'ospf';

// ── reading the configuration ────────────────────────────────────────────────────────────────────────────────────

/** The `router ospf <pid>` section nodes of the running configuration (normally one). */
function ospfSections(ctx: CommandCtx): ConfigNode[] {
  return ctx.running.root.children.filter((n) => n.key === 'router' && n.args[0] === 'ospf');
}

/** True when the running configuration stores `no ip routing` (the P2 `bothForms` slot; protocols/ipv4.ts reads it so). */
export function ipRoutingOff(ctx: Pick<CommandCtx, 'running'>): boolean {
  return ctx.running.root.children.some((c) => c.key === 'no' && c.args.length === 2 && c.args[0] === 'ip' && c.args[1] === 'routing');
}

/** The `router ospf …` context entry of the session, or undefined. */
function ospfContext(ctx: CommandCtx): readonly string[] | undefined {
  const entry = ctx.context[ctx.context.length - 1];
  return entry !== undefined && entry[0] === 'router' && entry[1] === 'ospf' ? entry : undefined;
}

/** The ospf StateView, when the daemon runs. */
export function ospfStateView(ctx: Pick<CommandCtx, 'processState'>): OspfStateView | undefined {
  const sv = ctx.processState(OSPF_PROCESS);
  return sv === undefined ? undefined : (sv.state as unknown as OspfStateView);
}

/** The dotted id of an area typed as a number or dotted, or undefined. */
export function areaDotted(text: string): string | undefined {
  const a = parseIpv4(text);
  if (a !== null) return u32ToIpv4(a);
  if (!/^\d{1,10}$/.test(text)) return undefined;
  const n = Number(text);
  return n <= 0xffffffff ? u32ToIpv4(n) : undefined;
}

// ── global and router lines ──────────────────────────────────────────────────────────────────────────────────────

/** `router ospf <pid>` / `no router ospf <pid>`. */
const routerOspf: CommandHandler = (ctx, args, negate) => {
  const pid = args['pid'] ?? '';
  if (!/^\d+$/.test(pid)) return { error: '% Give the OSPF process number (1-65535).' };
  const pidText = String(Number(pid));
  const existing = ospfSections(ctx);
  const entry = ['router', 'ospf', pidText];
  if (negate) {
    if (!existing.some((n) => n.args[1] === pidText)) return {};
    return outcomeOf(ctx.config(entry, true, globalContext()));
  }
  const other = existing.find((n) => n.args[1] !== pidText);
  if (other !== undefined) return { error: fillTemplate(CLI_MESSAGES.ospfOneProcess, { pid: other.args[1] ?? '' }) };
  if (ipRoutingOff(ctx)) return { error: CLI_MESSAGES.ospfNeedsIpRouting };
  const error = ctx.config(entry, false, globalContext());
  if (error !== undefined) return { error };
  enterMode(ctx, 'config-router', [entry]);
  return {};
};

/** `router-id <a>` / `no router-id`. */
const routerId: CommandHandler = (ctx, args, negate) => {
  if (ospfContext(ctx) === undefined) return { error: MSG_NO_OSPF_SELECTED };
  if (negate) return outcomeOf(ctx.config(['router-id'], true));
  const id = args['id'] ?? '';
  if (id === '0.0.0.0') return { error: MSG_ROUTER_ID_ZERO };
  const error = ctx.config(['router-id', id], false);
  if (error !== undefined) return { error };
  const running = ospfStateView(ctx)?.process;
  return running !== undefined && running.routerId !== id ? { output: CLI_MESSAGES.ospfRouterIdLater } : {};
};

/** The stored `network` lines of the session's section, as tokens. */
function networkLines(ctx: CommandCtx): string[][] {
  const section = ospfSections(ctx).find((n) => n.args[1] === ospfContext(ctx)?.[2]);
  return (section?.children ?? []).filter((c) => c.key === 'network').map((c) => [c.key, ...c.args]);
}

/** `network <a> <wildcard> area <area>` / its `no` form. */
const network: CommandHandler = (ctx, args, negate) => {
  if (ospfContext(ctx) === undefined) return { error: MSG_NO_OSPF_SELECTED };
  const a = parseIpv4(args['address'] ?? '');
  const w = parseIpv4(args['wildcard'] ?? '');
  const areaText = args['area'] ?? '';
  const area = areaDotted(areaText);
  if (a === null || w === null || area === undefined) return { error: '% Expected network <address> <wildcard> area <area>.' };
  const net = u32ToIpv4((a & ~w) >>> 0);
  const wild = u32ToIpv4(w >>> 0);
  const same = networkLines(ctx).find((t) => t[1] === net && t[2] === wild);
  if (negate) return same === undefined ? {} : outcomeOf(ctx.config(same, true));
  if (same !== undefined) {
    const storedArea = areaDotted(same[4] ?? '');
    if (storedArea === area) return {};
    return { error: fillTemplate(CLI_MESSAGES.ospfNetworkOtherArea, { net, wildcard: wild, area: same[4] ?? '' }) };
  }
  return outcomeOf(ctx.config(['network', net, wild, 'area', areaText], false));
};

/** The stored children of the session's `router ospf` section. */
function sectionChildren(ctx: CommandCtx): readonly ConfigNode[] {
  return ospfSections(ctx).find((n) => n.args[1] === ospfContext(ctx)?.[2])?.children ?? [];
}

/** `passive-interface <if>` / `passive-interface default` and their `no` forms (D7). */
const passiveInterface: CommandHandler = (ctx, args, negate) => {
  if (ospfContext(ctx) === undefined) return { error: MSG_NO_OSPF_SELECTED };
  const children = sectionChildren(ctx);
  const negations = children.filter((c) => c.key === 'no' && c.args[0] === 'passive-interface' && c.args.length === 2);
  if (args[OSPF_PASSIVE_DEFAULT_ARG] !== undefined) {
    if (!negate) return outcomeOf(ctx.config(['passive-interface', 'default'], false));
    const error = ctx.config(['passive-interface', 'default'], true);
    if (error !== undefined) return { error };
    // the stored `no passive-interface X` lines meant "not passive under the default": without it they mean nothing
    for (const n of negations) {
      const e = ctx.config(['no', ...n.args], true);
      if (e !== undefined) return { error: e };
    }
    return {};
  }
  const port = args['iface'] ?? '';
  const underDefault = children.some((c) => c.key === 'passive-interface' && c.args.length === 1 && c.args[0] === 'default');
  if (!negate) return outcomeOf(ctx.config(['passive-interface', port], false));
  if (underDefault) return outcomeOf(ctx.config(['passive-interface', port], true));
  // without the default: remove the positive line only (the rule would keep a negation nobody needs)
  const positive = children.some((c) => c.key === 'passive-interface' && c.args.length === 1 && c.args[0] === port);
  if (!positive) return {};
  const error = ctx.config(['passive-interface', port], true);
  if (error !== undefined) return { error };
  if (sectionChildren(ctx).some((c) => c.key === 'no' && c.args[0] === 'passive-interface' && c.args[1] === port)) {
    return outcomeOf(ctx.config(['no', 'passive-interface', port], true));
  }
  return {};
};

/** `auto-cost reference-bandwidth <Mb/s>` / its `no` form. */
const autoCost: CommandHandler = (ctx, args, negate) => {
  if (ospfContext(ctx) === undefined) return { error: MSG_NO_OSPF_SELECTED };
  if (negate) return outcomeOf(ctx.config(['auto-cost', 'reference-bandwidth'], true));
  const mbps = args['mbps'] ?? '';
  const error = ctx.config(['auto-cost', 'reference-bandwidth', mbps], false);
  return error === undefined ? { output: MSG_REFERENCE_NOTE } : { error };
};

/** `default-information originate [always]` / its `no` form. */
const defaultInformation: CommandHandler = (ctx, args, negate) => {
  if (ospfContext(ctx) === undefined) return { error: MSG_NO_OSPF_SELECTED };
  if (negate) return outcomeOf(ctx.config(['default-information', 'originate'], true));
  return outcomeOf(ctx.config(args['always'] === 'always' ? ['default-information', 'originate', 'always'] : ['default-information', 'originate'], false));
};

/** `maximum-paths <n>` / its `no` form. */
const maximumPaths: CommandHandler = (ctx, args, negate) => {
  if (ospfContext(ctx) === undefined) return { error: MSG_NO_OSPF_SELECTED };
  if (negate) return outcomeOf(ctx.config(['maximum-paths'], true));
  return outcomeOf(ctx.config(['maximum-paths', args['paths'] ?? ''], false));
};

// ── interface lines ──────────────────────────────────────────────────────────────────────────────────────────────

/** The stored `ip ospf <pid> area <a>` tokens of the selected interface, or undefined. */
function storedAreaLine(ctx: CommandCtx, port: PortId): string[] | undefined {
  const section = ctx.running.root.children.find((c) => c.key === 'interface' && c.args[0] === port);
  for (const c of section?.children ?? []) {
    if (c.key === 'ip' && c.args.length === 0) {
      for (const leaf of c.children) if (leaf.key === 'ospf' && leaf.args[1] === 'area') return ['ip', 'ospf', ...leaf.args];
    } else if (c.key === 'ip' && c.args[0] === 'ospf' && c.args[2] === 'area') {
      return ['ip', ...c.args];
    }
  }
  return undefined;
}

/** `ip ospf <pid> area <a>`, `ip ospf cost|priority|hello-interval|dead-interval <n>`, `ip ospf network <type>`. */
const ifIpOspf: CommandHandler = (ctx, args, negate) => {
  const port = selectedInterface(ctx);
  if (port === undefined) return { error: MSG_NO_INTERFACE_SELECTED };
  const setting = args['setting'] ?? '';
  if (setting === 'area') {
    const pid = args['pid'];
    if (negate) {
      const stored = storedAreaLine(ctx, port);
      if (stored === undefined || (pid !== undefined && stored[2] !== String(Number(pid)))) return {};
      return outcomeOf(ctx.config(stored, true));
    }
    const area = args['area'] ?? '';
    if (pid === undefined || areaDotted(area) === undefined) return { error: '% Expected ip ospf <process> area <area>.' };
    return outcomeOf(ctx.config(['ip', 'ospf', String(Number(pid)), 'area', area], false));
  }
  const valueArg = setting === 'cost' ? 'cost' : setting === 'priority' ? 'priority' : setting === 'network' ? 'type' : 'seconds';
  if (negate) return outcomeOf(ctx.config(['ip', 'ospf', setting], true));
  const value = args[valueArg];
  if (value === undefined || value === '') return { error: '% A value is required.' };
  return outcomeOf(ctx.config(['ip', 'ospf', setting, value], false));
};

// ── shows ────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Rows of a table this device may not declare (read as empty). */
function rowsOf<R extends { key: string }>(ctx: CommandCtx, name: 'ospf-interfaces' | 'ospf-neighbors'): R[] {
  const t = ctx.tables.get(name);
  return t === undefined ? [] : (t.rows() as unknown as R[]);
}

/** Canonical port order of this device. */
function portIndex(ctx: CommandCtx): Map<PortId, number> {
  const out = new Map<PortId, number>();
  let i = 0;
  for (const id of ctx.ports.keys()) out.set(id, i++);
  return out;
}

const ISM_WORD: Readonly<Record<OspfIsmState, string>> = Object.freeze({
  down: 'DOWN',
  loopback: 'LOOP',
  waiting: 'WAIT',
  'point-to-point': 'P2P',
  drother: 'DROTHER',
  backup: 'BDR',
  dr: 'DR',
});

const NSM_WORD: Readonly<Record<OspfNsmState, string>> = Object.freeze({
  down: 'DOWN',
  attempt: 'ATTEMPT',
  init: 'INIT',
  '2way': '2WAY',
  exstart: 'EXSTART',
  exchange: 'EXCHANGE',
  loading: 'LOADING',
  full: 'FULL',
});

const ROLE_WORD: Readonly<Record<OspfNeighborRow['role'], string>> = Object.freeze({ dr: 'DR', bdr: 'BDR', drother: 'DROTHER', none: '-' });

/** The decimal form of a dotted area id ('0.0.0.0' → '0'). */
function areaNumber(area: string): string {
  const v = parseIpv4(area);
  return v === null ? area : String(v >>> 0);
}

/** The short name of a port (`Gi0/0`, `Lo0`): its spec's, else its family's short letters, else its id. */
function shortName(ctx: CommandCtx, port: PortId): string {
  const view: PortView | undefined = ctx.ports.get(port);
  if (view?.spec.short !== undefined) return view.spec.short;
  const m = /^([A-Za-z-]+)(.*)$/.exec(port);
  const family = m === null ? undefined : PORT_FAMILIES.find((f) => f.long === m[1]);
  return family === undefined || m === null ? port : `${family.short}${m[2] ?? ''}`;
}

/** `<port> is up, line protocol is up` (original wording). */
function statusLine(view: PortView | undefined, port: PortId): string {
  if (view === undefined) return `${port} is down, line protocol is down`;
  const state = !view.adminUp ? 'administratively down' : view.operUp ? 'up' : 'down';
  return `${port} is ${state}, line protocol is ${view.operUp ? 'up' : 'down'}`;
}

const NETWORK_TYPE_WORD: Readonly<Record<OspfInterfaceRow['networkType'], string>> = Object.freeze({
  broadcast: 'BROADCAST',
  'point-to-point': 'POINT-TO-POINT',
  loopback: 'LOOPBACK',
});

/** `show ip ospf`. */
const showIpOspf: CommandHandler = (ctx) => {
  const cfg = readOspfConfig(ctx.running);
  if (cfg.process === undefined) return { output: MSG_NO_OSPF };
  const sv = ospfStateView(ctx);
  const proc = sv?.process;
  const lines: string[] = [];
  const rid = proc?.routerId ?? cfg.process.routerId;
  lines.push(`OSPF process ${cfg.process.pid}, router ID ${rid ?? 'not chosen yet'}`);
  if (proc === undefined) lines.push('  The process is configured but not running on this device.');
  else lines.push(`  Running for ${fmtSince(proc.startedAt, ctx.now)}`);
  if (proc?.configuredRouterId !== undefined && proc.configuredRouterId !== proc.routerId) {
    lines.push(`  Router ID ${proc.configuredRouterId} is configured; it is used after "clear ip ospf process" or a reload`);
  }
  const reference = proc?.referenceBandwidthMbps ?? cfg.process.referenceBandwidthMbps;
  const paths = proc?.maximumPaths ?? cfg.process.maximumPaths;
  lines.push(`  Reference bandwidth ${reference} Mb/s; up to ${paths} equal-cost path${paths === 1 ? '' : 's'} per destination`);
  const origin = proc?.defaultOriginate ?? cfg.process.defaultOriginate;
  lines.push(`  Default route: ${origin === 'always' ? 'always advertised' : origin === 'on' ? 'advertised while this router has one' : 'not advertised'}`);
  if (sv !== undefined) {
    const spf = sv.spf;
    const last = spf.lastAt === undefined ? 'never run' : `last run ${fmtSince(spf.lastAt, ctx.now)} ago${spf.lastReason === undefined ? '' : ` (${spf.lastReason})`}`;
    const next = spf.nextAt === undefined ? 'no run scheduled' : `next run in ${fmtDuration(spf.nextAt - ctx.now)}`;
    lines.push(`  Shortest-path calculation: ${spf.runs} run${spf.runs === 1 ? '' : 's'}, ${last}; ${next}`);
  }
  const ifRows = rowsOf<OspfInterfaceRow>(ctx, 'ospf-interfaces');
  const nbrRows = rowsOf<OspfNeighborRow>(ctx, 'ospf-neighbors');
  const areas = [...new Set(ifRows.map((r) => r.area))].sort((x, y) => (ipv4ToU32(x) >>> 0) - (ipv4ToU32(y) >>> 0));
  for (const area of areas) {
    const ports = new Set(ifRows.filter((r) => r.area === area).map((r) => r.port));
    const full = nbrRows.filter((n) => ports.has(n.port) && n.state === 'full').length;
    const label = area === '0.0.0.0' ? `Area ${area} (backbone)` : `Area ${area}`;
    lines.push(`  ${label}: ${ports.size} interface${ports.size === 1 ? '' : 's'}, ${full} fully adjacent neighbour${full === 1 ? '' : 's'}`);
  }
  if (areas.length === 0) lines.push('  No interface runs OSPF yet.');
  return { output: lines.join('\n') };
};

/** `show ip ospf neighbor`. */
const showIpOspfNeighbor: CommandHandler = (ctx) => {
  if (readOspfConfig(ctx.running).process === undefined) return { output: MSG_NO_OSPF };
  const order = portIndex(ctx);
  const rows = rowsOf<OspfNeighborRow>(ctx, 'ospf-neighbors').sort(
    (a, b) => (order.get(a.port) ?? 1e9) - (order.get(b.port) ?? 1e9) || (ipv4ToU32(a.routerId) >>> 0) - (ipv4ToU32(b.routerId) >>> 0),
  );
  if (rows.length === 0) return { output: MSG_NO_OSPF_NEIGHBOUR };
  const sv = ospfStateView(ctx);
  const out: string[][] = [['Neighbour ID', 'Pri', 'State', 'Dead in', 'Address', 'Interface']];
  for (const r of rows) {
    const live = sv?.neighbors.find((n) => n.port === r.port && n.routerId === r.routerId);
    const dead = live === undefined ? '-' : fmtDuration(live.deadAt - ctx.now);
    out.push([r.routerId, String(r.priority), `${NSM_WORD[r.state] ?? r.state.toUpperCase()}/${ROLE_WORD[r.role] ?? '-'}`, dead, r.address, r.port]);
  }
  return { output: table(out, { gap: 2, align: ['left', 'right'], minWidths: [15, 3, 15, 9, 13] }) };
};

/** One detailed `show ip ospf interface` block. */
function interfaceBlock(ctx: CommandCtx, r: OspfInterfaceRow, sv: OspfStateView | undefined): string {
  const lines = [statusLine(ctx.ports.get(r.port), r.port)];
  const addr = r.address === undefined ? 'no address' : `${r.address}/${r.prefixLen ?? 32}`;
  lines.push(`  Address ${addr}, area ${r.area}, process ${r.process}, router ID ${r.routerId}`);
  lines.push(`  Network type ${NETWORK_TYPE_WORD[r.networkType] ?? r.networkType}, cost ${r.cost} (${r.costSource === 'configured' ? 'configured' : 'from the bandwidth'})`);
  lines.push(`  State ${ISM_WORD[r.state] ?? r.state}, priority ${r.priority}`);
  if (r.networkType === 'broadcast') {
    const dr = r.dr === undefined ? 'none' : `${r.dr}${r.drAddress === undefined ? '' : ` (${r.drAddress})`}`;
    const bdr = r.bdr === undefined ? 'none' : `${r.bdr}${r.bdrAddress === undefined ? '' : ` (${r.bdrAddress})`}`;
    lines.push(`  Designated router ${dr}, backup ${bdr}`);
  }
  const live = sv?.interfaces.find((i) => i.port === r.port);
  const hello = live?.helloDueAt === undefined || r.passive ? '' : `, next hello in ${fmtDuration(live.helloDueAt - ctx.now)}`;
  lines.push(`  Timers: hello ${r.helloS} s, dead ${r.deadS} s${hello}`);
  if (r.waitUntil !== undefined) lines.push(`  Waiting for the election, ${fmtDuration(r.waitUntil - ctx.now)} left`);
  lines.push(`  Neighbours ${r.neighbors}, fully adjacent ${r.adjacent}`);
  lines.push(`  Passive: ${r.passive ? 'yes (no hellos are sent)' : 'no'}`);
  if (r.rejected !== undefined) {
    lines.push(`  Last refused hello: from ${r.rejected.from} (router ${r.rejected.routerId}), ${fmtSince(r.rejected.at, ctx.now)} ago: ${r.rejected.reason}`);
  }
  return lines.join('\n');
}

/** `show ip ospf interface [brief|<if>]`. */
const showIpOspfInterface: CommandHandler = (ctx, args) => {
  if (readOspfConfig(ctx.running).process === undefined) return { output: MSG_NO_OSPF };
  const order = portIndex(ctx);
  const rows = rowsOf<OspfInterfaceRow>(ctx, 'ospf-interfaces').sort((a, b) => (order.get(a.port) ?? 1e9) - (order.get(b.port) ?? 1e9));
  const name = args['iface'];
  if (name !== undefined && name !== '') {
    const port = ctx.ports.has(name) ? name : ctx.resolvePort(name);
    if (port === undefined) return { error: `% No interface named "${name}" exists on this device.` };
    const row = rows.find((r) => r.port === port);
    return { output: row === undefined ? MSG_OSPF_NOT_ON(port) : interfaceBlock(ctx, row, ospfStateView(ctx)) };
  }
  if (rows.length === 0) return { output: MSG_NO_OSPF_INTERFACE };
  if (args[OSPF_SHOW_BRIEF_ARG] !== undefined) {
    const out: string[][] = [['Interface', 'Process', 'Area', 'Address/Mask', 'Cost', 'State', 'Neighbours full/total']];
    for (const r of rows) {
      const addr = r.address === undefined ? 'unassigned' : `${r.address}/${r.prefixLen ?? 32}`;
      out.push([shortName(ctx, r.port), String(r.process), areaNumber(r.area), addr, String(r.cost), ISM_WORD[r.state] ?? r.state, `${r.adjacent}/${r.neighbors}`]);
    }
    return { output: table(out, { gap: 2, minWidths: [9, 7, 4, 15, 4, 5] }) };
  }
  const sv = ospfStateView(ctx);
  return { output: rows.map((r) => interfaceBlock(ctx, r, sv)).join('\n\n') };
};

/** `clear ip ospf process`: confirm, then `ospf.clear` (D7: the new router id applies; neighbours restart). */
const clearIpOspf: CommandHandler = (ctx) => {
  if (readOspfConfig(ctx.running).process === undefined) return { output: MSG_NO_OSPF };
  const resume = (rctx: CommandCtx, answer: string): CommandOutcome => {
    const a = answer.trim().toLowerCase();
    if (a !== 'y' && a !== 'yes') return { output: MSG_CLEAR_OSPF_CANCELLED };
    rctx.request(OSPF_PROCESS, { kind: 'ospf.clear', session: rctx.session.id });
    return {};
  };
  return { ask: { request: { kind: 'confirm', prompt: CLI_MESSAGES.clearOspfConfirm }, resume } };
};

/** @since P3 Registry fragment: the OSPF lines and shows (`OSPF_HANDLERS` ids). */
export const ospfHandlers: Readonly<Record<string, CommandHandler>> = {
  [OSPF_HANDLERS.configRouterOspf]: routerOspf,
  [OSPF_HANDLERS.ospfRouterId]: routerId,
  [OSPF_HANDLERS.ospfNetwork]: network,
  [OSPF_HANDLERS.ospfPassiveInterface]: passiveInterface,
  [OSPF_HANDLERS.ospfAutoCost]: autoCost,
  [OSPF_HANDLERS.ospfDefaultInformation]: defaultInformation,
  [OSPF_HANDLERS.ospfMaximumPaths]: maximumPaths,
  [OSPF_HANDLERS.ifIpOspf]: ifIpOspf,
  [OSPF_HANDLERS.showIpOspf]: showIpOspf,
  [OSPF_HANDLERS.showIpOspfNeighbor]: showIpOspfNeighbor,
  [OSPF_HANDLERS.showIpOspfInterface]: showIpOspfInterface,
  [OSPF_HANDLERS.execClearIpOspf]: clearIpOspf,
};
