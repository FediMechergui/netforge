/**
 * cli/handlers/qos.ts — MQC marking lines, their shows, and the host-shell traffic generator (ARCHITECTURE-P3 §5.4,
 * §5.8, D16, M13; §7 W2 cli part 1).
 *
 * Storage follows the W1 config rules: `class-map <type> <name>` and `policy-map <name>` are sections (the type is
 * always stored, match-all when omitted, so the running configuration reads like a device's), `class <name>` a section
 * under a policy-map, `match …` multi lines, `set …` single slots per field, `service-policy <dir> <name>` one slot per
 * direction. Values are stored in the device's display form: a DSCP number with a standard name is stored by name
 * (`set dscp 46` → `set dscp ef`), a precedence name by number. The handlers add what the rules cannot know:
 *   • a class-map name keeps its type: re-entering it with the other type is refused;
 *   • `class <name>` needs the class-map (`qosClassMissing`), except class-default;
 *   • `service-policy` attaches only to routed ports, serial ports and subinterfaces (`qosPortUnsupported` on SVIs,
 *     switched ports and the rest), only a policy that exists, and — the approved [S20] checks, decided here because
 *     this handler is the one attach point — a policy with a queueing action (`priority`, `bandwidth`, `queue-limit`,
 *     `fair-queue`, `shape`) attaches only as output (`qosQueueingOutputOnly`), only on a physical port
 *     (`qosQueueingPhysicalOnly`) and only within 75 % of the port's rate (`qosAdmission`: the `bandwidth` line, else
 *     the routing bandwidth of the port, protocols/ospf/cost.ts).
 * The policies compile lazily in the runtime (D16): nothing here notifies anyone.
 *
 * `flow start|voice` validates the flow (the caps of §2.4: ≤ 2 Mb/s, ≤ 1000 pps, 60-1500 bytes, and every flow ends
 * within `TRAFFIC_MAX_DURATION_MS`; a larger count or duration is refused with `trafficFlowCap` before any job starts),
 * blocks the session on the traffic daemon (a short job: Ctrl+C sends `job.abort`) and sends `traffic.start {flow,
 * session}`; the daemon picks the flow id (the lowest free `f<n>`), prints one line and ends the job. `flow stop` is the
 * same job around `traffic.stop`; `flow show` lists the traffic StateView's flows. Every string is original wording
 * (spec §1.6).
 */
import { CLI_MESSAGES, type CommandCtx, type CommandHandler, type CommandOutcome } from '../../contracts/cli.js';
import { ROLE_TRAITS } from '../../contracts/catalog.js';
import type { ConfigNode } from '../../contracts/config.js';
import type { PortId } from '../../contracts/ids.js';
import type { PortView } from '../../contracts/port.js';
import { TRAFFIC_MAX_DURATION_MS, type ProcessRequest, type TrafficFlowSpec } from '../../contracts/process.js';
import { routingBandwidthKbps } from '../../protocols/ospf/cost.js';
import { table } from '../format.js';
import {
  QOS_CLI_CLASS_DEFAULT,
  QOS_CLI_DSCP_NAMES,
  QOS_CLI_PRECEDENCE_NAMES,
  QOS_FORM_ARG,
  QOS_HANDLERS,
} from '../grammar/qos.js';
import { enterMode, fillTemplate, globalContext, MSG_NO_INTERFACE_SELECTED, outcomeOf, roleOf, selectedPort } from './common.js';

/** A `match` line typed outside a class-map. */
export const MSG_NO_CLASS_MAP_SELECTED = '% Select a class-map first (class-map <name>).';
/** A `class` line typed outside a policy-map. */
export const MSG_NO_POLICY_MAP_SELECTED = '% Select a policy-map first (policy-map <name>).';
/** A `set` line typed outside a policy-map class. */
export const MSG_NO_POLICY_CLASS_SELECTED = '% Select a class of a policy-map first (class <name>).';
/** `service-policy` naming a policy-map that does not exist. */
export const MSG_POLICY_MISSING = (name: string): string => `% There is no policy-map named ${name}.`;
/** A class-map re-entered with the other type. */
export const MSG_CLASS_MAP_TYPE = (name: string, type: string): string => `% Class-map ${name} is ${type}; remove it first to change how its lines combine.`;
/** `show class-map` / `show policy-map` with nothing configured. */
export const MSG_NO_CLASS_MAP = 'No class-map is configured.';
export const MSG_NO_POLICY_MAP = 'No policy-map is configured.';
/** `show policy-map interface` on an interface without a policy. */
export const MSG_NO_SERVICE_POLICY = (port: string): string => `${port} has no service policy.`;
/** `flow show` without a flow. */
export const MSG_NO_FLOW = 'This host sends no flow.';

/** The traffic daemon's process name. */
const TRAFFIC_PROCESS = 'traffic';
/** @since P3 Terminal label of a `flow` job. */
export const FLOW_JOB_LABEL = 'flow';

// ── value forms ──────────────────────────────────────────────────────────────────────────────────────────────────

/** A DSCP value as the device shows it: its standard name when it has one, else the number (`cs0` → `default`). */
export function dscpDisplay(token: string): string {
  if (token === 'cs0') return 'default';
  for (const [n] of QOS_CLI_DSCP_NAMES) if (n === token) return n;
  if (/^\d+$/.test(token)) {
    const v = Number(token);
    for (const [n, x] of QOS_CLI_DSCP_NAMES) if (x === v) return n;
    return String(v);
  }
  return token;
}

/** A DSCP value 0-63 from a name or a number, or undefined. */
export function dscpValue(token: string): number | undefined {
  if (token === 'cs0') return 0;
  for (const [n, x] of QOS_CLI_DSCP_NAMES) if (n === token) return x;
  return /^\d{1,2}$/.test(token) && Number(token) <= 63 ? Number(token) : undefined;
}

/** An IP precedence as the device shows it: the number. */
export function precedenceDisplay(token: string): string {
  for (const [n, x] of QOS_CLI_PRECEDENCE_NAMES) if (n === token) return String(x);
  return String(Number(token));
}

// ── reading the configuration ────────────────────────────────────────────────────────────────────────────────────

/** A stored class-map: its type and name, and the section node. */
interface ClassMapNode {
  readonly type: 'match-all' | 'match-any';
  readonly name: string;
  readonly node: ConfigNode;
}

function classMaps(ctx: CommandCtx): ClassMapNode[] {
  const out: ClassMapNode[] = [];
  for (const n of ctx.running.root.children) {
    if (n.key !== 'class-map') continue;
    const [a, b] = n.args;
    if ((a === 'match-all' || a === 'match-any') && b !== undefined) out.push({ type: a, name: b, node: n });
    else if (a !== undefined && b === undefined) out.push({ type: 'match-all', name: a, node: n });
  }
  return out;
}

function policyMaps(ctx: CommandCtx): ConfigNode[] {
  return ctx.running.root.children.filter((n) => n.key === 'policy-map' && n.args[0] !== undefined);
}

/** The session's innermost context entry when it starts with `key`. */
function innermost(ctx: CommandCtx, key: string): readonly string[] | undefined {
  const e = ctx.context[ctx.context.length - 1];
  return e !== undefined && e[0] === key ? e : undefined;
}

/** The queueing keys of a policy class ([S20]/[S21]): a policy holding one attaches only as output on a physical port. */
const QUEUEING_KEYS: readonly string[] = ['priority', 'bandwidth', 'queue-limit', 'fair-queue', 'shape'];

/** [S20] The kb/s a policy's priority and bandwidth classes ask for at a port rate (`percent` of `bwKbps`). */
function askedKbps(policy: ConfigNode, bwKbps: number): number {
  let asked = 0;
  for (const cls of policy.children) {
    if (cls.key !== 'class') continue;
    for (const line of cls.children) {
      if (line.key !== 'priority' && line.key !== 'bandwidth') continue;
      const [a, b] = line.args;
      if (a === 'percent' && b !== undefined && /^\d+$/.test(b)) asked += Math.floor((bwKbps * Number(b)) / 100);
      else if (a !== undefined && /^\d+$/.test(a)) asked += Number(a);
    }
  }
  return asked;
}

// ── class-maps and policy-maps ───────────────────────────────────────────────────────────────────────────────────

/** `class-map [match-all|match-any] <name>` / its `no` form. */
const classMap: CommandHandler = (ctx, args, negate) => {
  const name = args['name'] ?? '';
  if (name === '') return { error: '% Give the class-map a name.' };
  const existing = classMaps(ctx).find((c) => c.name === name);
  if (negate) return existing === undefined ? {} : outcomeOf(ctx.config(['class-map', ...existing.node.args], true, globalContext()));
  const typed = args[QOS_FORM_ARG];
  const type = typed === 'match-any' ? 'match-any' : typed === 'match-all' ? 'match-all' : (existing?.type ?? 'match-all');
  if (existing !== undefined && existing.type !== type) return { error: MSG_CLASS_MAP_TYPE(name, existing.type) };
  const entry = existing !== undefined ? ['class-map', ...existing.node.args] : ['class-map', type, name];
  const error = ctx.config(entry, false, globalContext());
  if (error !== undefined) return { error };
  enterMode(ctx, 'config-cmap', [entry]);
  return {};
};

/** The `match …` line a spec stands for, in the stored form. */
function matchLine(args: Readonly<Record<string, string>>): string[] | undefined {
  const values = (map: (t: string) => string): string[] => {
    const out: string[] = [];
    for (let i = 1; i <= 8; i++) {
      const v = args[`v${i}`];
      if (v === undefined) continue;
      const shown = map(v);
      if (!out.includes(shown)) out.push(shown);
    }
    return out;
  };
  switch (args[QOS_FORM_ARG]) {
    case 'dscp':
      return ['match', 'dscp', ...values(dscpDisplay)];
    case 'precedence':
      return ['match', 'ip', 'precedence', ...values(precedenceDisplay)];
    case 'cos':
      return ['match', 'cos', ...values((t) => String(Number(t)))];
    case 'access-group':
      return ['match', 'access-group', String(Number(args['number']))];
    case 'access-group-name':
      return ['match', 'access-group', 'name', args['list'] ?? ''];
    case 'protocol':
      return ['match', 'protocol', args['protocol'] ?? ''];
    case 'input-interface':
      return ['match', 'input-interface', args['iface'] ?? ''];
    case 'any':
      return ['match', 'any'];
    default:
      return undefined;
  }
}

/** `match …` / `no match …` inside a class-map. */
const cmapMatch: CommandHandler = (ctx, args, negate) => {
  if (innermost(ctx, 'class-map') === undefined) return { error: MSG_NO_CLASS_MAP_SELECTED };
  const line = matchLine(args);
  if (line === undefined) return { error: '% That match line is not valid.' };
  const bare = line.length === 2 && (args[QOS_FORM_ARG] === 'dscp' || args[QOS_FORM_ARG] === 'cos');
  const barePrec = line.length === 3 && args[QOS_FORM_ARG] === 'precedence';
  if (negate && (bare || barePrec)) {
    // `no match dscp` (no values): every match line of that kind
    const cmap = innermost(ctx, 'class-map') as readonly string[];
    const section = ctx.running.root.children.find((n) => n.key === 'class-map' && n.args.join(' ') === cmap.slice(1).join(' '));
    // a copy: removing a line changes the section's children
    for (const c of [...(section?.children ?? [])]) {
      const t = [c.key, ...c.args];
      if (c.key === 'match' && line.every((x, i) => t[i] === x)) {
        const e = ctx.config(t, true);
        if (e !== undefined) return { error: e };
      }
    }
    return {};
  }
  if (!negate && (bare || barePrec)) return { error: '% Give at least one value.' };
  return outcomeOf(ctx.config(line, negate));
};

/** `policy-map <name>` / its `no` form. */
const policyMap: CommandHandler = (ctx, args, negate) => {
  const name = args['name'] ?? '';
  if (name === '') return { error: '% Give the policy-map a name.' };
  const entry = ['policy-map', name];
  if (negate) return policyMaps(ctx).some((p) => p.args[0] === name) ? outcomeOf(ctx.config(entry, true, globalContext())) : {};
  const error = ctx.config(entry, false, globalContext());
  if (error !== undefined) return { error };
  enterMode(ctx, 'config-pmap', [entry]);
  return {};
};

/** `class <name>` / `no class <name>` inside a policy-map. */
const pmapClass: CommandHandler = (ctx, args, negate) => {
  const pmap = innermost(ctx, 'policy-map');
  if (pmap === undefined) return { error: MSG_NO_POLICY_MAP_SELECTED };
  const name = args['name'] ?? '';
  if (name === '') return { error: '% Give the class name.' };
  if (negate) return outcomeOf(ctx.config(['class', name], true));
  if (name !== QOS_CLI_CLASS_DEFAULT && !classMaps(ctx).some((c) => c.name === name)) return { error: fillTemplate(CLI_MESSAGES.qosClassMissing, { name }) };
  const error = ctx.config(['class', name], false);
  if (error !== undefined) return { error };
  enterMode(ctx, 'config-pmap-c', [pmap.slice(), ['class', name]]);
  return {};
};

/** `set dscp|ip precedence|cos <v>` / their `no` forms inside a policy-map class. */
const pmapcSet: CommandHandler = (ctx, args, negate) => {
  const cls = innermost(ctx, 'class');
  const pmap = ctx.context[ctx.context.length - 2];
  if (cls === undefined || pmap === undefined || pmap[0] !== 'policy-map') return { error: MSG_NO_POLICY_CLASS_SELECTED };
  const form = args[QOS_FORM_ARG];
  const head = form === 'precedence' ? ['set', 'ip', 'precedence'] : form === 'cos' ? ['set', 'cos'] : ['set', 'dscp'];
  if (negate) return outcomeOf(ctx.config(head.slice(0, 2), true));
  const value = args['value'];
  if (value === undefined || value === '') return { error: '% Give the value to set.' };
  const shown = form === 'precedence' ? precedenceDisplay(value) : form === 'cos' ? String(Number(value)) : dscpDisplay(value);
  return outcomeOf(ctx.config([...head, shown], false));
};

/** The stored `service-policy <dir> <name>` lines of a port, by direction. */
function servicePolicies(ctx: CommandCtx, port: PortId): { input?: string; output?: string } {
  const out: { input?: string; output?: string } = {};
  const section = ctx.running.root.children.find((c) => c.key === 'interface' && c.args[0] === port);
  for (const c of section?.children ?? []) {
    if (c.key !== 'service-policy') continue;
    if (c.args[0] === 'input' && c.args[1] !== undefined) out.input = c.args[1];
    if (c.args[0] === 'output' && c.args[1] !== undefined) out.output = c.args[1];
  }
  return out;
}

/** The port's rate in kb/s for the admission check: its `bandwidth` line, else its routing bandwidth. */
function portRateKbps(ctx: CommandCtx, port: PortView): number {
  const section = ctx.running.root.children.find((c) => c.key === 'interface' && c.args[0] === port.id);
  const bw = section?.children.find((c) => c.key === 'bandwidth')?.args[0];
  const configured = bw !== undefined && /^\d+$/.test(bw) ? Number(bw) : undefined;
  return routingBandwidthKbps({ role: roleOf(ctx, port), speedBps: port.speedBps ?? port.spec.speedBps, ...(configured === undefined ? {} : { configuredKbps: configured }) });
}

/** `service-policy input|output <name>` / its `no` form (D16; the [S20] attach checks, module header). */
const servicePolicy: CommandHandler = (ctx, args, negate) => {
  const port = selectedPort(ctx);
  if (port === undefined) return { error: MSG_NO_INTERFACE_SELECTED };
  const role = roleOf(ctx, port);
  if (role !== 'routed' && role !== 'wan' && role !== 'subif') return { error: fillTemplate(CLI_MESSAGES.qosPortUnsupported, { port: port.id }) };
  const dir = args['direction'];
  if (negate) {
    const stored = servicePolicies(ctx, port.id);
    const dirs = dir === undefined ? (['input', 'output'] as const) : [dir as 'input' | 'output'];
    for (const d of dirs) {
      if (stored[d] === undefined) continue;
      const e = ctx.config(['service-policy', d], true);
      if (e !== undefined) return { error: e };
    }
    return {};
  }
  const name = args['name'] ?? '';
  if (dir !== 'input' && dir !== 'output') return { error: '% Expected service-policy input|output <name>.' };
  const policy = policyMaps(ctx).find((p) => p.args[0] === name);
  if (policy === undefined) return { error: MSG_POLICY_MISSING(name) };
  const queueing = policy.children.some((cls) => cls.key === 'class' && cls.children.some((l) => QUEUEING_KEYS.includes(l.key)));
  if (queueing) {
    if (dir !== 'output') return { error: CLI_MESSAGES.qosQueueingOutputOnly };
    if (role === 'subif' || ROLE_TRAITS[role].virtual) return { error: fillTemplate(CLI_MESSAGES.qosQueueingPhysicalOnly, { port: port.id }) };
    const bw = portRateKbps(ctx, port);
    const asked = askedKbps(policy, bw);
    if (asked * 100 > bw * 75) return { error: fillTemplate(CLI_MESSAGES.qosAdmission, { asked, bw, port: port.id }) };
  }
  return outcomeOf(ctx.config(['service-policy', dir, name], false));
};

// ── shows ────────────────────────────────────────────────────────────────────────────────────────────────────────

function classMapBlock(c: ClassMapNode): string {
  const lines = [`Class-map ${c.name} (${c.type === 'match-any' ? 'any one line matches' : 'every line must match'})`];
  const matches = c.node.children.filter((m) => m.key === 'match');
  for (const m of matches) lines.push(`  ${[m.key, ...m.args].join(' ')}`);
  if (matches.length === 0) lines.push('  (no match line: matches nothing)');
  return lines.join('\n');
}

/** `show class-map [<name>]`. */
const showClassMap: CommandHandler = (ctx, args) => {
  const want = args['name'];
  const maps = classMaps(ctx).filter((c) => want === undefined || c.name === want);
  if (maps.length === 0) return { output: want === undefined ? MSG_NO_CLASS_MAP : `No class-map named ${want} is configured.` };
  return { output: maps.map(classMapBlock).join('\n') };
};

/** The classes of a policy in policy order, then class-default (always last, D16). */
function policyClasses(policy: ConfigNode): { name: string; lines: string[] }[] {
  const out: { name: string; lines: string[] }[] = [];
  let def: { name: string; lines: string[] } | undefined;
  for (const c of policy.children) {
    if (c.key !== 'class' || c.args[0] === undefined) continue;
    const entry = { name: c.args[0], lines: c.children.map((l) => [l.key, ...l.args].join(' ')) };
    if (entry.name === QOS_CLI_CLASS_DEFAULT) def = entry;
    else out.push(entry);
  }
  out.push(def ?? { name: QOS_CLI_CLASS_DEFAULT, lines: [] });
  return out;
}

function policyMapBlock(policy: ConfigNode): string {
  const lines = [`Policy-map ${policy.args[0] ?? ''}`];
  for (const c of policyClasses(policy)) {
    lines.push(`  Class ${c.name}`);
    for (const l of c.lines) lines.push(`    ${l}`);
    if (c.lines.length === 0) lines.push('    (no action)');
  }
  return lines.join('\n');
}

/** `show policy-map [<name>]`. */
const showPolicyMap: CommandHandler = (ctx, args) => {
  const want = args['name'];
  const maps = policyMaps(ctx).filter((p) => want === undefined || p.args[0] === want);
  if (maps.length === 0) return { output: want === undefined ? MSG_NO_POLICY_MAP : `No policy-map named ${want} is configured.` };
  return { output: maps.map(policyMapBlock).join('\n') };
};

/** `show policy-map interface <if> [input|output]`: per class, the packets matched and marked (PortSnapshot.qos). */
const showPolicyMapInterface: CommandHandler = (ctx, args) => {
  const name = args['iface'] ?? '';
  const id = ctx.ports.has(name) ? name : ctx.resolvePort(name);
  if (id === undefined) return { error: `% No interface named "${name}" exists on this device.` };
  const attached = servicePolicies(ctx, id);
  const want = args['direction'];
  const dirs = (['input', 'output'] as const).filter((d) => (want === undefined || want === d) && attached[d] !== undefined);
  if (dirs.length === 0) return { output: MSG_NO_SERVICE_POLICY(id) };
  const counters = ctx.qosCounters?.(id);
  const lines = [id];
  for (const d of dirs) {
    const pname = attached[d] as string;
    lines.push(`  ${d === 'input' ? 'Input' : 'Output'} policy ${pname}`);
    const policy = policyMaps(ctx).find((p) => p.args[0] === pname);
    if (policy === undefined) {
      lines.push('    (the policy-map does not exist: nothing is classified)');
      continue;
    }
    for (const c of policyClasses(policy)) {
      const n = counters?.classes.find((x) => x.name === c.name);
      const matched = n === undefined ? '0 packets (0 bytes)' : `${n.matched} packet${n.matched === 1 ? '' : 's'} (${n.matchedBytes} bytes)`;
      const sets = c.lines.filter((l) => l.startsWith('set '));
      const marked = sets.length === 0 ? '' : `; ${n?.marked ?? 0} marked (${sets.join(', ')})`;
      lines.push(`    Class ${c.name}: ${matched} matched${marked}`);
    }
  }
  return { output: lines.join('\n') };
};

// ── host shell: flows ────────────────────────────────────────────────────────────────────────────────────────────

/** Pacing of a flow in ns (§2.4: floor(size·8·1e9 / rate) for a rate in b/s; floor(1e9 / pps)). */
export function flowPacingNs(spec: Pick<TrafficFlowSpec, 'sizeBytes' | 'rateKbps' | 'pps'>): number {
  if (spec.pps !== undefined) return Math.floor(1_000_000_000 / spec.pps);
  const bps = (spec.rateKbps ?? 1) * 1000;
  return Math.floor((spec.sizeBytes * 8 * 1_000_000_000) / bps);
}

/** True when a count or duration would run past the 5-minute cap (`TRAFFIC_MAX_DURATION_MS`, D16). */
export function flowBeyondCap(spec: TrafficFlowSpec): boolean {
  if (spec.durationMs !== undefined) return spec.durationMs > TRAFFIC_MAX_DURATION_MS;
  if (spec.count !== undefined) return spec.count * flowPacingNs(spec) > TRAFFIC_MAX_DURATION_MS * 1_000_000;
  return false;
}

function capError(): { error: string } {
  return { error: fillTemplate(CLI_MESSAGES.trafficFlowCap, { minutes: TRAFFIC_MAX_DURATION_MS / 60_000 }) };
}

/** `flow start <dst> rate <kbps>|pps <n> size <bytes> [dscp <v>] [port <p>] [count <n>|for <s>]`. */
const flowStart: CommandHandler = (ctx, args) => {
  const dst = args['dst'] ?? '';
  const sizeBytes = Number(args['bytes']);
  const flow: { -readonly [K in keyof TrafficFlowSpec]: TrafficFlowSpec[K] } = { dst, sizeBytes };
  if (args[QOS_FORM_ARG] === 'pps') flow.pps = Number(args['pps']);
  else flow.rateKbps = Number(args['kbps']);
  if (args['dscp'] !== undefined) flow.dscp = dscpValue(args['dscp']) ?? 0;
  if (args['port'] !== undefined) flow.dstPort = Number(args['port']);
  if (args['count'] !== undefined) flow.count = Number(args['count']);
  if (args['seconds'] !== undefined) flow.durationMs = Number(args['seconds']) * 1000;
  if (flowBeyondCap(flow)) return capError();
  return flowJob(ctx, { kind: 'traffic.start', flow, session: ctx.session.id });
};

/** `flow voice <dst> [g711] [dscp <v>]`: 50 pps of 60 bytes (G.729) or 200 bytes (G.711), DSCP ef unless given. */
const flowVoice: CommandHandler = (ctx, args) => {
  const g711 = args[QOS_FORM_ARG] === 'voice-g711';
  const flow: TrafficFlowSpec = {
    dst: args['dst'] ?? '',
    sizeBytes: g711 ? 200 : 60,
    pps: 50,
    dscp: args['dscp'] === undefined ? 46 : (dscpValue(args['dscp']) ?? 46),
    preset: g711 ? 'voice-g711' : 'voice-g729',
  };
  return flowJob(ctx, { kind: 'traffic.start', flow, session: ctx.session.id });
};

/** `flow stop <id>`. */
const flowStop: CommandHandler = (ctx, args) => flowJob(ctx, { kind: 'traffic.stop', id: args['id'] ?? '', session: ctx.session.id });

/**
 * A `flow` job: block the session on the traffic daemon BEFORE the request (it answers at once, with one line and
 * `cliDone`, protocols/traffic.ts), then send it. Ctrl+C sends `job.abort` and frees the terminal.
 */
function flowJob(ctx: CommandCtx, req: Extract<ProcessRequest, { kind: 'traffic.start' | 'traffic.stop' }>): CommandOutcome {
  ctx.block({ process: TRAFFIC_PROCESS, abort: { kind: 'job.abort', session: ctx.session.id }, label: FLOW_JOB_LABEL });
  ctx.request(TRAFFIC_PROCESS, req);
  return {};
}

/** A pace in ns as the device shows it: whole milliseconds, with a decimal fraction when there is one (`187.5 ms`). */
export function paceText(ns: number): string {
  const ms = Math.floor(ns / 1_000_000);
  const rest = ns - ms * 1_000_000;
  return rest === 0 ? `${ms} ms` : `${ms}.${String(rest).padStart(6, '0').replace(/0+$/, '')} ms`;
}

/**
 * `flow show`: the traffic StateView's `flows` (protocols/traffic.ts: `{id, dst, dstPort, sizeBytes, dscp, paceNs,
 * sent, state, …}`, running flows then the last finished ones), each read defensively: a StateView is display data.
 */
const flowShow: CommandHandler = (ctx) => {
  const state = ctx.processState(TRAFFIC_PROCESS)?.state as { flows?: unknown } | undefined;
  const flows = Array.isArray(state?.flows) ? (state.flows as Record<string, unknown>[]) : [];
  if (flows.length === 0) return { output: MSG_NO_FLOW };
  const text = (v: unknown, fallback = '-'): string => (typeof v === 'number' || typeof v === 'string' ? String(v) : fallback);
  const rows: string[][] = [['Flow', 'Destination', 'Port', 'Size', 'Every', 'DSCP', 'Sent', 'State']];
  for (const f of flows) {
    const pace = typeof f['paceNs'] === 'number' ? paceText(f['paceNs']) : '-';
    rows.push([text(f['id']), text(f['dst']), text(f['dstPort'], '9'), text(f['sizeBytes']), pace, text(f['dscp'], '0'), text(f['sent'], '0'), text(f['state'])]);
  }
  return { output: table(rows) };
};

/** @since P3 Registry fragment: the QoS marking lines, their shows and the host-shell flows (`QOS_HANDLERS` ids). */
export const qosHandlers: Readonly<Record<string, CommandHandler>> = {
  [QOS_HANDLERS.configClassMap]: classMap,
  [QOS_HANDLERS.cmapMatch]: cmapMatch,
  [QOS_HANDLERS.configPolicyMap]: policyMap,
  [QOS_HANDLERS.pmapClass]: pmapClass,
  [QOS_HANDLERS.pmapcSet]: pmapcSet,
  [QOS_HANDLERS.ifServicePolicy]: servicePolicy,
  [QOS_HANDLERS.showClassMap]: showClassMap,
  [QOS_HANDLERS.showPolicyMap]: showPolicyMap,
  [QOS_HANDLERS.showPolicyMapInterface]: showPolicyMapInterface,
  [QOS_HANDLERS.hostFlowStart]: flowStart,
  [QOS_HANDLERS.hostFlowVoice]: flowVoice,
  [QOS_HANDLERS.hostFlowStop]: flowStop,
  [QOS_HANDLERS.hostFlowShow]: flowShow,
};
