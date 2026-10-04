/**
 * cli/handlers/eigrp.ts — [C1] EIGRP configuration handlers (ARCHITECTURE-P3 §2.16, §5.1, D26; §7 W2 cli).
 *
 *   config.router-eigrp            `router eigrp <as>`: one process per device (`eigrpOneProcess` names the existing AS),
 *                                  refused under `no ip routing` (`eigrpNeedsIpRouting`); enters `config-router-eigrp`
 *                                  with context `[['router', 'eigrp', <as>]]`; `no router eigrp <as>` removes the section
 *   eigrp.network                  `network <a> [<wildcard>]`: stored with the host bits cleared; without a wildcard
 *                                  the classful network of the address (`network 10.1.2.3` → `network 10.0.0.0`)
 *   eigrp.router-id                `eigrp router-id <a>` (0.0.0.0 and 255.255.255.255 refused) / its `no` form
 *   eigrp.passive-interface        `passive-interface <if>`: with `passive-interface default` set, the positive form
 *                                  removes the stored exception and the `no` form stores it (`no passive-interface X`);
 *                                  without the default, the positive form is stored and the `no` form removes it
 *   eigrp.passive-interface-default `passive-interface default`; its `no` form also drops every stored exception
 *   eigrp.metric-weights           `metric weights 0 k1 k2 k3 k4 k5` / `no metric weights` (the defaults 1 0 1 0 0)
 *   eigrp.maximum-paths            `maximum-paths <1-4>` / its `no` form
 *   eigrp.auto-summary             `auto-summary` refused (`eigrpAutoSummary`); `no auto-summary` accepted, not stored
 *   if.delay                       `delay <n>` / `no delay`
 *   if.ip-hello-interval-eigrp     `ip hello-interval eigrp <as> <s>` / `no ip hello-interval eigrp <as>`
 *   if.ip-hold-time-eigrp          `ip hold-time eigrp <as> <s>` / `no ip hold-time eigrp <as>`
 *   show.ip-eigrp-neighbors        (W3 cli) `show ip eigrp neighbors [<if>]`: the `eigrp-neighbors` rows with the hold
 *                                  countdown, queue and sequence of the eigrp StateView
 *   show.ip-eigrp-topology         (W3 cli) `show ip eigrp topology [all-links | <prefix>]` (§3.12, the §5.8 example)
 *   show.ip-eigrp-interfaces       (W3 cli) `show ip eigrp interfaces`: the covered interfaces, peers, timers, metric parts
 *   exec.clear-ip-eigrp-neighbors  (W3 cli) `clear ip eigrp neighbors [<address>]` → `eigrp.clear` (not interactive)
 * `show ip route eigrp` is the shared `show.ip-route` handler filtered on the machine source 'EIGRP' (D11).
 *
 * The lines are exactly the W1 rules' canonical forms (cli/config-rules.ts, the [C1] block); the eigrp daemon reads
 * them. Messages are original wording (spec §1.6).
 */
import type { CommandCtx, CommandHandler, CommandOutcome } from '../../contracts/cli.js';
import { CLI_MESSAGES } from '../../contracts/cli.js';
import { ipv4ToU32, isIpv4, networkOf, parseIpv4, u32ToIpv4 } from '../../contracts/addr.js';
import { ROLE_TRAITS } from '../../contracts/catalog.js';
import type { PortId } from '../../contracts/ids.js';
import { EIGRP_HELLO_S, EIGRP_HOLD_S, EIGRP_INFINITY } from '../../contracts/pdu.js';
import type { ProcessRequest } from '../../contracts/process.js';
import type { EigrpNeighborRow, EigrpPath, EigrpStateView, EigrpTopologyRow } from '../../contracts/tables.js';
import { SEC } from '../../contracts/time.js';
import { eigrpInterfaceEnabled, eigrpInterfacePassive, readEigrpInterfaces, readEigrpProcess } from '../../protocols/eigrp/config.js';
import { eigrpBandwidthKbps, eigrpDelayUs } from '../../protocols/eigrp/metric.js';
import { fmtSince, table } from '../format.js';
import { EIGRP_HANDLERS, EIGRP_MODE, EIGRP_TOPOLOGY_ALL_LINKS, EIGRP_TOPOLOGY_VIEW_ARG } from '../grammar/eigrp.js';
import { enterMode, fillTemplate, MSG_NO_INTERFACE_SELECTED, outcomeOf, roleOf, selectedInterface } from './common.js';

/** @since P3 [C1] A process line typed outside `router eigrp`. */
export const MSG_NO_EIGRP_PROCESS = '% Enter "router eigrp <as>" first.';
/** @since P3 [C1] `eigrp router-id` with an address that cannot name a router. */
export const MSG_EIGRP_ROUTER_ID = '% A router ID cannot be 0.0.0.0 or 255.255.255.255.';
/** @since P3 [C1] `network` with a wildcard that is not a valid wildcard mask. */
export const MSG_EIGRP_WILDCARD = '% Expected a wildcard mask whose 1 bits are contiguous at the right, such as 0.0.0.255.';
/** @since P3 [C1] `no ip hello-interval eigrp` / `no ip hold-time eigrp` without the autonomous system. */
export const MSG_EIGRP_AS_NEEDED = '% Give the autonomous system number.';

/** The `router eigrp <as>` section of a running config, as its AS, or undefined. */
export function eigrpProcessAs(running: CommandCtx['running']): string | undefined {
  const node = running.root.children.find((c) => c.key === 'router' && c.args[0] === 'eigrp');
  return node?.args[1];
}

/** True when the running config stores `no ip routing` (the stored negation of the `ip routing` slot). */
export function ipRoutingOff(running: CommandCtx['running']): boolean {
  return running.root.children.some((c) => c.key === 'no' && c.args.length === 2 && c.args[0] === 'ip' && c.args[1] === 'routing');
}

/** The context entry of the session's `router eigrp` section, or undefined outside it. */
function eigrpEntry(ctx: CommandCtx): readonly string[] | undefined {
  const e = ctx.context[ctx.context.length - 1];
  return e !== undefined && e[0] === 'router' && e[1] === 'eigrp' ? e : undefined;
}

/** The classful network of an IPv4 address (class A /8, B /16, C /24; D and E kept whole). */
export function classfulNetwork(address: string): string | undefined {
  const v = parseIpv4(address);
  if (v === null) return undefined;
  const first = v >>> 24;
  const mask = first < 128 ? 0xff000000 : first < 192 ? 0xffff0000 : first < 224 ? 0xffffff00 : 0xffffffff;
  return u32ToIpv4((v & mask) >>> 0);
}

/** A wildcard mask whose 1 bits are contiguous at the right (0.0.0.255), or undefined. */
function wildcardBits(wildcard: string): number | undefined {
  const w = parseIpv4(wildcard);
  if (w === null) return undefined;
  // contiguous low ones: w + 1 is a power of two (or w is all ones)
  const next = (w + 1) >>> 0;
  return w === 0xffffffff || (next & (next - 1)) === 0 ? w : undefined;
}

/** `router eigrp <as>` / `no router eigrp <as>`. */
const routerEigrp: CommandHandler = (ctx, args, negate) => {
  const as = args['as'] ?? '';
  if (as === '') return { error: '% Give the autonomous system number (1-65535).' };
  const line = ['router', 'eigrp', String(Number(as))];
  if (negate) return outcomeOf(ctx.config(line, true, []));
  if (ipRoutingOff(ctx.running)) return { error: CLI_MESSAGES.eigrpNeedsIpRouting };
  const existing = eigrpProcessAs(ctx.running);
  if (existing !== undefined && existing !== line[2]) return { error: fillTemplate(CLI_MESSAGES.eigrpOneProcess, { as: existing }) };
  const error = ctx.config(line, false, []);
  if (error !== undefined) return { error };
  enterMode(ctx, EIGRP_MODE, [line]);
  return {};
};

/** `network <a> [<wildcard>]` / its `no` form. */
const network: CommandHandler = (ctx, args, negate) => {
  if (eigrpEntry(ctx) === undefined) return { error: MSG_NO_EIGRP_PROCESS };
  const address = args['address'] ?? '';
  const wildcard = args['wildcard'];
  let tokens: string[];
  if (wildcard === undefined || wildcard === '') {
    const net = classfulNetwork(address);
    if (net === undefined) return { error: '% Expected a network address (A.B.C.D).' };
    tokens = ['network', net];
  } else {
    const w = wildcardBits(wildcard);
    const a = parseIpv4(address);
    if (w === undefined) return { error: MSG_EIGRP_WILDCARD };
    if (a === null) return { error: '% Expected a network address (A.B.C.D).' };
    tokens = ['network', u32ToIpv4((a & ~w) >>> 0), wildcard];
  }
  return outcomeOf(ctx.config(tokens, negate));
};

/** `eigrp router-id <a>` / `no eigrp router-id`. */
const routerId: CommandHandler = (ctx, args, negate) => {
  if (eigrpEntry(ctx) === undefined) return { error: MSG_NO_EIGRP_PROCESS };
  if (negate) return outcomeOf(ctx.config(['eigrp', 'router-id'], true));
  const address = args['address'] ?? '';
  if (address === '0.0.0.0' || address === '255.255.255.255') return { error: MSG_EIGRP_ROUTER_ID };
  return outcomeOf(ctx.config(['eigrp', 'router-id', address], false));
};

/** True when the session's `router eigrp` section stores `passive-interface default`. */
function passiveDefaultOn(ctx: CommandCtx): boolean {
  const entry = eigrpEntry(ctx);
  if (entry === undefined) return false;
  const section = ctx.running.root.children.find((c) => c.key === 'router' && c.args[0] === 'eigrp' && c.args[1] === entry[2]);
  return section?.children.some((c) => c.key === 'passive-interface' && c.args[0] === 'default') ?? false;
}

/** The stored exceptions (`no passive-interface X`) of the session's `router eigrp` section. */
function passiveExceptions(ctx: CommandCtx): string[] {
  const entry = eigrpEntry(ctx);
  if (entry === undefined) return [];
  const section = ctx.running.root.children.find((c) => c.key === 'router' && c.args[0] === 'eigrp' && c.args[1] === entry[2]);
  const out: string[] = [];
  for (const c of section?.children ?? []) {
    if (c.key === 'no' && c.args[0] === 'passive-interface' && c.args[1] !== undefined) out.push(c.args[1]);
  }
  return out;
}

/** Remove a stored `no passive-interface <port>` line (the `no <rest>` rule removes exactly that node). */
function dropException(ctx: CommandCtx, port: string): string | undefined {
  return ctx.config(['no', 'passive-interface', port], true);
}

/** `passive-interface <if>` / `no passive-interface <if>`. */
const passiveInterface: CommandHandler = (ctx, args, negate) => {
  if (eigrpEntry(ctx) === undefined) return { error: MSG_NO_EIGRP_PROCESS };
  const port = args['iface'] ?? '';
  if (port === '') return { error: '% Give the interface.' };
  const isException = passiveExceptions(ctx).includes(port);
  if (passiveDefaultOn(ctx)) {
    // every interface is passive: the positive form removes the exception, the negation stores it
    if (!negate) return isException ? outcomeOf(dropException(ctx, port)) : {};
    return outcomeOf(ctx.config(['passive-interface', port], true));
  }
  if (!negate) return outcomeOf(ctx.config(['passive-interface', port], false));
  // without the default, `no passive-interface X` removes the line and leaves no exception behind
  const error = ctx.config(['passive-interface', port], true);
  if (error !== undefined) return { error };
  return passiveExceptions(ctx).includes(port) ? outcomeOf(dropException(ctx, port)) : {};
};

/** `passive-interface default` / `no passive-interface default` (which also drops every exception). */
const passiveDefault: CommandHandler = (ctx, _args, negate) => {
  if (eigrpEntry(ctx) === undefined) return { error: MSG_NO_EIGRP_PROCESS };
  if (!negate) return outcomeOf(ctx.config(['passive-interface', 'default'], false));
  const error = ctx.config(['passive-interface', 'default'], true);
  if (error !== undefined) return { error };
  // every exception (`no passive-interface X`) goes with the default it qualified
  const leftovers = [...passiveExceptions(ctx)];
  for (const port of leftovers) {
    const e = dropException(ctx, port);
    if (e !== undefined) return { error: e };
  }
  return {};
};

/** `metric weights 0 k1 k2 k3 k4 k5` / `no metric weights`. */
const metricWeights: CommandHandler = (ctx, args, negate) => {
  if (eigrpEntry(ctx) === undefined) return { error: MSG_NO_EIGRP_PROCESS };
  if (negate) return outcomeOf(ctx.config(['metric', 'weights'], true));
  const ks = ['tos', 'k1', 'k2', 'k3', 'k4', 'k5'].map((k) => args[k] ?? '');
  if (ks.some((k) => k === '')) return { error: '% Give the type of service (0) and the five K values.' };
  return outcomeOf(ctx.config(['metric', 'weights', ...ks.map((k) => String(Number(k)))], false));
};

/** `maximum-paths <1-4>` / `no maximum-paths`. */
const maximumPaths: CommandHandler = (ctx, args, negate) => {
  if (eigrpEntry(ctx) === undefined) return { error: MSG_NO_EIGRP_PROCESS };
  if (negate) return outcomeOf(ctx.config(['maximum-paths'], true));
  return outcomeOf(ctx.config(['maximum-paths', String(Number(args['paths'] ?? ''))], false));
};

/** `auto-summary` (refused) / `no auto-summary` (the default: accepted, nothing stored). */
const autoSummary: CommandHandler = (ctx, _args, negate) => {
  if (eigrpEntry(ctx) === undefined) return { error: MSG_NO_EIGRP_PROCESS };
  return negate ? {} : { error: CLI_MESSAGES.eigrpAutoSummary };
};

/** `delay <tens-of-us>` / `no delay`. */
const delay: CommandHandler = (ctx, args, negate) => {
  if (selectedInterface(ctx) === undefined) return { error: MSG_NO_INTERFACE_SELECTED };
  if (negate) return outcomeOf(ctx.config(['delay'], true));
  return outcomeOf(ctx.config(['delay', String(Number(args['tens-of-us'] ?? ''))], false));
};

/** `ip hello-interval|hold-time eigrp <as> <s>` and their `no` forms. */
function eigrpTimer(keyword: 'hello-interval' | 'hold-time'): CommandHandler {
  return (ctx, args, negate): CommandOutcome => {
    if (selectedInterface(ctx) === undefined) return { error: MSG_NO_INTERFACE_SELECTED };
    const as = args['as'];
    if (as === undefined || as === '') return { error: MSG_EIGRP_AS_NEEDED };
    const head = ['ip', keyword, 'eigrp', String(Number(as))];
    if (negate) return outcomeOf(ctx.config(head, true));
    return outcomeOf(ctx.config([...head, String(Number(args['seconds'] ?? ''))], false));
  };
}

// ── W3 cli (cli-b): the shows and the clear (§2.16, §3.12, §5.8) ──────────────────────────────────────────────────

/** @since P3 (W3 cli) [C1] The EIGRP daemon (its StateView and tables feed the shows; `eigrp.clear` goes to it). */
export const EIGRP_PROCESS = 'eigrp';
/** @since P3 (W3 cli) [C1] A show or clear on a device without `router eigrp`. */
export const MSG_EIGRP_NOT_RUNNING = 'EIGRP is not configured on this device.';
/** @since P3 (W3 cli) [C1] `show ip eigrp neighbors` with no neighbour. */
export const MSG_NO_EIGRP_NEIGHBOR = 'No EIGRP neighbour has been found.';
/** @since P3 (W3 cli) [C1] `show ip eigrp topology` with an empty table. */
export const MSG_EIGRP_TOPOLOGY_EMPTY = 'The EIGRP topology table is empty.';
/** @since P3 (W3 cli) [C1] `show ip eigrp interfaces` when no network line covers an interface address. */
export const MSG_NO_EIGRP_INTERFACE = 'No interface runs EIGRP: no network line covers an interface address.';
/** @since P3 (W3 cli) [C1] The codes line of `show ip eigrp topology` (§5.8). */
export const EIGRP_TOPOLOGY_CODES = 'Codes: P passive, A active, U update, Q query, R reply';

/** @since P3 (W3 cli) [C1] The eigrp StateView (`EigrpStateView`, §2.16), or undefined where the daemon does not run. */
export function eigrpStateView(ctx: Pick<CommandCtx, 'processState'>): EigrpStateView | undefined {
  const sv = ctx.processState(EIGRP_PROCESS);
  return sv === undefined ? undefined : (sv.state as unknown as EigrpStateView);
}

/** The autonomous system of the device's process: the daemon's, else the configured one. */
function eigrpAs(ctx: CommandCtx, sv: EigrpStateView | undefined): number | undefined {
  if (sv?.process !== undefined) return sv.process.as;
  const as = eigrpProcessAs(ctx.running);
  return as === undefined ? undefined : Number(as);
}

/** Position of each port in the device's canonical port order. */
function portOrder(ctx: CommandCtx): Map<PortId, number> {
  const order = new Map<PortId, number>();
  for (const id of ctx.ports.keys()) order.set(id, order.size);
  return order;
}

/** The short name of a port (`Gi0/0`), or the id itself. */
function shortName(ctx: CommandCtx, port: PortId): string {
  return ctx.ports.get(port)?.spec.short ?? port;
}

/** The `eigrp-neighbors` rows of `as`, in neighbour order (interface port order, then address). */
export function eigrpNeighborRows(ctx: CommandCtx, as: number): EigrpNeighborRow[] {
  const order = portOrder(ctx);
  const rows = ctx.tables.get<EigrpNeighborRow>('eigrp-neighbors')?.rows() ?? [];
  return rows
    .filter((r) => r.as === as)
    .sort((a, b) => (order.get(a.iface) ?? Number.MAX_SAFE_INTEGER) - (order.get(b.iface) ?? Number.MAX_SAFE_INTEGER) || ipv4ToU32(a.address) - ipv4ToU32(b.address));
}

/** `show ip eigrp neighbors [<if>]` (§2.16): the rows, with the hold countdown, queue and sequence of the StateView. */
const showIpEigrpNeighbors: CommandHandler = (ctx, args) => {
  const sv = eigrpStateView(ctx);
  const as = eigrpAs(ctx, sv);
  if (as === undefined) return { output: MSG_EIGRP_NOT_RUNNING };
  let rows = eigrpNeighborRows(ctx, as);
  const name = args['iface'];
  if (name !== undefined && name !== '') {
    const id = ctx.ports.has(name) ? name : ctx.resolvePort(name);
    if (id === undefined) return { error: `% No interface named "${name}" exists on this device.` };
    rows = rows.filter((r) => r.iface === id);
  }
  const header = `EIGRP neighbours, AS ${as}`;
  if (rows.length === 0) return { output: `${header}\n${MSG_NO_EIGRP_NEIGHBOR}` };
  const out: string[][] = [['H', 'Address', 'Interface', 'Hold (s)', 'Up for', 'SRTT (ms)', 'RTO (ms)', 'Queue', 'Seq']];
  rows.forEach((r, i) => {
    const live = sv?.neighbors.find((n) => n.iface === r.iface && n.address === r.address);
    const hold = live !== undefined ? Math.max(0, Math.floor((live.holdUntil - ctx.now) / SEC)) : r.holdS;
    out.push([
      String(i),
      r.address,
      shortName(ctx, r.iface),
      String(hold),
      r.state === 'up' && r.upSince !== undefined ? fmtSince(r.upSince, ctx.now) : 'pending',
      String(r.srttMs),
      String(r.rtoMs),
      String(live?.queue ?? 0),
      String(live?.lastSeq ?? 0),
    ]);
  });
  return { output: `${header}\n${table(out)}` };
};

/** A distance as the topology shows it (`inaccessible` at infinity). */
function distanceText(d: number): string {
  return d >= EIGRP_INFINITY ? 'inaccessible' : String(d);
}

/** One path line of a topology entry: `        via 10.0.12.2 (3328/3072), GigabitEthernet0/0`. */
function pathLine(p: EigrpPath): string {
  return `        via ${p.nextHop} (${distanceText(p.metric)}/${distanceText(p.rd)}), ${p.iface}`;
}

/** The order of topology prefixes: network address, then prefix length. */
function prefixOrder(a: string, b: string): number {
  const [na = '0.0.0.0', la = '0'] = a.split('/');
  const [nb = '0.0.0.0', lb = '0'] = b.split('/');
  return ipv4ToU32(na) - ipv4ToU32(nb) || Number(la) - Number(lb);
}

/**
 * @since P3 (W3 cli) [C1] One entry of `show ip eigrp topology` (§3.12 step 2): the state code, the prefix, the number
 * of successors and the FD, then the connected interface, the successors and the feasible successors (and, with
 * `allLinks`, the paths that fail the feasibility condition), one `via` line each.
 */
export function eigrpTopologyEntry(r: EigrpTopologyRow, allLinks: boolean): string[] {
  const successors = r.successors.length + (r.connected !== undefined ? 1 : 0);
  let head = `${r.state === 'active' ? 'A' : 'P'} ${r.prefix}, ${successors} successor${successors === 1 ? '' : 's'}, FD ${distanceText(r.fd)}`;
  if (r.state === 'active' && r.pendingReplies !== undefined) head += `, waiting for ${r.pendingReplies} repl${r.pendingReplies === 1 ? 'y' : 'ies'}`;
  const lines = [head];
  if (r.connected !== undefined) lines.push(`        via Connected, ${r.connected}`);
  for (const p of r.successors) lines.push(pathLine(p));
  for (const p of r.feasible) lines.push(pathLine(p));
  if (allLinks) for (const p of r.others) lines.push(pathLine(p));
  return lines;
}

/** `show ip eigrp topology [all-links | <prefix>]` (§3.12, §5.8). */
const showIpEigrpTopology: CommandHandler = (ctx, args) => {
  const sv = eigrpStateView(ctx);
  const as = eigrpAs(ctx, sv);
  if (as === undefined) return { output: MSG_EIGRP_NOT_RUNNING };
  const rid = sv?.process?.routerId;
  const head = [`EIGRP topology, AS ${as}, router ID ${rid === undefined || rid === '0.0.0.0' ? 'not chosen yet' : rid}`, EIGRP_TOPOLOGY_CODES, ''];
  const rows = (ctx.tables.get<EigrpTopologyRow>('eigrp-topology')?.rows() ?? []).sort((a, b) => prefixOrder(a.prefix, b.prefix));
  const wanted = args['prefix'];
  if (wanted !== undefined && wanted !== '') {
    const [address = '', len = ''] = wanted.split('/');
    const prefix = isIpv4(address) && /^\d+$/.test(len) && Number(len) <= 32 ? `${networkOf(address, Number(len))}/${Number(len)}` : wanted;
    const row = rows.find((r) => r.prefix === prefix);
    if (row === undefined) return { output: `${prefix} is not in the EIGRP topology table.` };
    return { output: [...head, ...eigrpTopologyEntry(row, true)].join('\n') };
  }
  if (rows.length === 0) return { output: [...head, MSG_EIGRP_TOPOLOGY_EMPTY].join('\n') };
  const allLinks = args[EIGRP_TOPOLOGY_VIEW_ARG] === EIGRP_TOPOLOGY_ALL_LINKS;
  return { output: [...head, ...rows.flatMap((r) => eigrpTopologyEntry(r, allLinks))].join('\n') };
};

/**
 * `show ip eigrp interfaces` (§2.16): every interface an EIGRP network line covers (the daemon's rule: an L3 port whose
 * primary address matches), with its up neighbours, timers, the metric's bandwidth and delay (metric.ts defaults when
 * not configured) and whether it is passive.
 */
const showIpEigrpInterfaces: CommandHandler = (ctx) => {
  const cfg = readEigrpProcess(ctx.running.root);
  if (cfg === undefined) return { output: MSG_EIGRP_NOT_RUNNING };
  const lines = readEigrpInterfaces(ctx.running.root, cfg.as);
  const nbrs = eigrpNeighborRows(ctx, cfg.as);
  const out: string[][] = [['Interface', 'Peers', 'Hello (s)', 'Hold (s)', 'Bandwidth (kb/s)', 'Delay (usec)', 'Passive']];
  for (const [id, p] of ctx.ports) {
    const role = roleOf(ctx, p);
    const v4 = p.l3.ipv4;
    if (!ROLE_TRAITS[role].l3 || v4 === undefined || !eigrpInterfaceEnabled(cfg, v4.address)) continue;
    const l = lines.get(id);
    const info = { kind: p.spec.kind, role, speedBps: p.speedBps ?? p.spec.speedBps };
    const passive = eigrpInterfacePassive(cfg, id) || role === 'virtual';
    out.push([
      p.spec.short,
      String(nbrs.filter((n) => n.iface === id && n.state === 'up').length),
      String(l?.helloS ?? EIGRP_HELLO_S),
      String(l?.holdS ?? EIGRP_HOLD_S),
      String(eigrpBandwidthKbps(info, l?.bandwidthKbps)),
      String(eigrpDelayUs(info, l?.delayTens)),
      passive ? 'yes' : 'no',
    ]);
  }
  const header = `EIGRP interfaces, AS ${cfg.as}`;
  return { output: out.length === 1 ? `${header}\n${MSG_NO_EIGRP_INTERFACE}` : `${header}\n${table(out)}` };
};

/** `clear ip eigrp neighbors [<address>]` (§2.16): `eigrp.clear`, not interactive. */
const clearIpEigrpNeighbors: CommandHandler = (ctx, args) => {
  if (eigrpProcessAs(ctx.running) === undefined) return { output: MSG_EIGRP_NOT_RUNNING };
  const neighbor = args['address'];
  const req: Extract<ProcessRequest, { kind: 'eigrp.clear' }> = { kind: 'eigrp.clear', session: ctx.session.id };
  if (neighbor !== undefined && neighbor !== '') req.neighbor = neighbor;
  ctx.request(EIGRP_PROCESS, req);
  return {};
};

/** @since P3 [C1] Registry fragment: EIGRP handler id → handler. */
export const eigrpHandlers: Readonly<Record<string, CommandHandler>> = {
  [EIGRP_HANDLERS.configRouterEigrp]: routerEigrp,
  [EIGRP_HANDLERS.eigrpNetwork]: network,
  [EIGRP_HANDLERS.eigrpRouterId]: routerId,
  [EIGRP_HANDLERS.eigrpPassiveInterface]: passiveInterface,
  [EIGRP_HANDLERS.eigrpPassiveDefault]: passiveDefault,
  [EIGRP_HANDLERS.eigrpMetricWeights]: metricWeights,
  [EIGRP_HANDLERS.eigrpMaximumPaths]: maximumPaths,
  [EIGRP_HANDLERS.eigrpAutoSummary]: autoSummary,
  [EIGRP_HANDLERS.ifDelay]: delay,
  [EIGRP_HANDLERS.ifIpHelloEigrp]: eigrpTimer('hello-interval'),
  [EIGRP_HANDLERS.ifIpHoldEigrp]: eigrpTimer('hold-time'),
  [EIGRP_HANDLERS.showIpEigrpNeighbors]: showIpEigrpNeighbors,
  [EIGRP_HANDLERS.showIpEigrpTopology]: showIpEigrpTopology,
  [EIGRP_HANDLERS.showIpEigrpInterfaces]: showIpEigrpInterfaces,
  [EIGRP_HANDLERS.execClearIpEigrpNeighbors]: clearIpEigrpNeighbors,
};
