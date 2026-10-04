/**
 * qos/config.ts — the pure MQC reader (ARCHITECTURE-P3 D16, §3.5 step 1, §3.11 step 1, §5.4; §7 W2 qos).
 *
 * Reads the QoS lines of a running configuration (the storage of the W1 config rules, `cli/config-rules.ts`):
 *   global   `class-map [match-all|match-any] <n>` (section; match-all when the type is omitted) with
 *            `match dscp <v…>` (IPv4 and IPv6), `match ip precedence <v…>` (IPv4), `match cos <v…>` (the 802.1Q PCP),
 *            `match access-group <n>|name <n>` (an IPv4 list through the D12 matcher, `core/acl.ts`),
 *            `match protocol ip|icmp|tcp|udp` (IPv4), `match input-interface <if>`, `match any`;
 *   global   `policy-map <n>` (section) with `class <n>|class-default` (section) holding `set dscp|ip precedence|cos
 *            <v>` (M13) and the approved [S20] `priority <kbps>|percent <p>`, `bandwidth <kbps>|percent <p>|remaining
 *            percent <p>`, `queue-limit <n>`, [S21] `fair-queue`, `police <bps> [<bc>] conform-action … exceed-action
 *            …`, `shape average <bps> [<bc>]`;
 *   interface `service-policy input|output <n>`, `bandwidth <kbps>` (the reference rate) and [S21] `fair-queue`.
 *
 * `compileQosPolicy` turns a policy-map into a `QosPolicy`: its classes in policy order, then class-default (always
 * present, always last, D16 / §4.5 "class order = policy order"), each with its class-map and the access lists the
 * class-maps name, resolved at compile time. The runtime keeps one compiled policy per (port, direction) tagged with
 * the configuration generation (`isQosConfigDelta`, `nextQosGeneration`): every delta under `class-map`,
 * `policy-map`, `access-list` or `ip access-list`, and every interface `service-policy` line, bumps it, so an edit of a
 * class-map or of its ACL reaches the next frame (§3.5 step 1). [S20]/[S21] add the interface `bandwidth` and
 * `fair-queue` lines (they change a scheduler port's compiled spec) and the creation or removal of an interface section
 * (which takes its policy lines with it).
 *
 * [S20]/[S21]: `compileEgressScheduler` builds a port's `EgressSchedulerSpec` (contracts/link.ts) from an output policy
 * with a queueing action, with its 75 % admission (`link/qos/scheduler.ts` `egressAdmission`), or from interface
 * `fair-queue`. The spec's classes are the policy's classes one for one, so the runtime's class index is the frame's
 * `qosClass`.
 *
 * Lines that do not parse are skipped (the grammar stores only valid lines). A class naming a class-map that does not
 * exist matches nothing; so does a class-map without `match` lines. A name defined twice keeps its first section.
 *
 * Pure: reads the tree, never changes it; no module state; integer maths only (§4.5).
 */
import type { ConfigAst, ConfigDelta, ConfigNode } from '../contracts/config.js';
import { P2P_QUEUE_LIMIT, type EgressClassSpec, type EgressSchedulerSpec, type PolicerSpec } from '../contracts/link.js';
import { readAcls, type AclList } from '../core/acl.js';
import {
  egressAdmission,
  qosPoliceBurstBytes,
  qosShapeDefaultBcBits,
  QOS_DEFAULT_QUEUE_LIMIT,
  type EgressAdmission,
} from '../link/qos/scheduler.js';
import type { PortRole } from '../contracts/catalog.js';
import { routingBandwidthKbps } from '../protocols/ospf/cost.js';

// ── value names ─────────────────────────────────────────────────────────────

/** @since P3 The DSCP names `match dscp` and `set dscp` accept and show (`cs0` is read as `default`). */
export const QOS_DSCP_NAMES: readonly (readonly [string, number])[] = Object.freeze([
  ['default', 0],
  ['cs1', 8],
  ['af11', 10],
  ['af12', 12],
  ['af13', 14],
  ['cs2', 16],
  ['af21', 18],
  ['af22', 20],
  ['af23', 22],
  ['cs3', 24],
  ['af31', 26],
  ['af32', 28],
  ['af33', 30],
  ['cs4', 32],
  ['af41', 34],
  ['af42', 36],
  ['af43', 38],
  ['cs5', 40],
  ['ef', 46],
  ['cs6', 48],
  ['cs7', 56],
]);

/** @since P3 The IP precedence names `match ip precedence` and `set ip precedence` accept and show. */
export const QOS_PRECEDENCE_NAMES: readonly (readonly [string, number])[] = Object.freeze([
  ['routine', 0],
  ['priority', 1],
  ['immediate', 2],
  ['flash', 3],
  ['flash-override', 4],
  ['critical', 5],
  ['internet', 6],
  ['network', 7],
]);

/** The class every policy ends with. */
export const QOS_CLASS_DEFAULT = 'class-default';

function decimal(token: string | undefined, max: number): number | undefined {
  if (token === undefined || !/^\d{1,13}$/.test(token)) return undefined;
  const v = Number(token);
  return v <= max ? v : undefined;
}

function named(table: readonly (readonly [string, number])[], token: string): number | undefined {
  for (const [n, v] of table) if (n === token) return v;
  return undefined;
}

/** @since P3 A DSCP value from a name (`ef`, `af41`, `cs0`) or a number 0-63. */
export function parseQosDscp(token: string | undefined): number | undefined {
  if (token === undefined) return undefined;
  if (token === 'cs0') return 0;
  return named(QOS_DSCP_NAMES, token) ?? decimal(token, 63);
}

/** @since P3 The name of a DSCP value when it has one (`46` → `ef`), else the number. */
export function qosDscpText(v: number): string {
  for (const [n, x] of QOS_DSCP_NAMES) if (x === v) return n;
  return String(v);
}

/** @since P3 An IP precedence value from a name (`critical`) or a number 0-7. */
export function parseQosPrecedence(token: string | undefined): number | undefined {
  if (token === undefined) return undefined;
  return named(QOS_PRECEDENCE_NAMES, token) ?? decimal(token, 7);
}

/** @since P3 An 802.1Q class of service 0-7. */
export function parseQosCos(token: string | undefined): number | undefined {
  return decimal(token, 7);
}

// ── class-maps ──────────────────────────────────────────────────────────────

/** @since P3 How a class-map combines its `match` lines. */
export type QosClassMatchMode = 'match-all' | 'match-any';

/** @since P3 The protocols `match protocol` names (IPv4: `ip` is every IPv4 packet). */
export type QosMatchProtocol = 'ip' | 'icmp' | 'tcp' | 'udp';

/** @since P3 One `match` line of a class-map (`text` = the line as stored, `match dscp ef af41`). Values are OR-ed. */
export type QosMatch = { readonly text: string } & (
  | { readonly kind: 'dscp'; readonly values: readonly number[] }
  | { readonly kind: 'precedence'; readonly values: readonly number[] }
  | { readonly kind: 'cos'; readonly values: readonly number[] }
  | { readonly kind: 'access-group'; readonly list: string }
  | { readonly kind: 'protocol'; readonly protocol: QosMatchProtocol }
  | { readonly kind: 'input-interface'; readonly port: string }
  | { readonly kind: 'any' }
);

/** @since P3 A class-map: its name, how its matches combine, and its matches in configuration order. */
export interface QosClassMap {
  readonly name: string;
  readonly mode: QosClassMatchMode;
  readonly matches: readonly QosMatch[];
}

function values(tokens: readonly string[], max: number, parse: (t: string) => number | undefined): number[] | undefined {
  if (tokens.length === 0 || tokens.length > max) return undefined;
  const out: number[] = [];
  for (const t of tokens) {
    const v = parse(t);
    if (v === undefined) return undefined;
    if (!out.includes(v)) out.push(v);
  }
  return out;
}

/**
 * @since P3 Parse the tokens of a `match` line after `match` (`['dscp', 'ef', 'af41']`). Undefined for anything else.
 * `match dscp` takes up to 8 values, `match ip precedence` and `match cos` up to 4.
 */
export function parseQosMatch(args: readonly string[]): QosMatch | undefined {
  const text = ['match', ...args].join(' ');
  const [k, a, b, extra] = args;
  switch (k) {
    case 'dscp': {
      const v = values(args.slice(1), 8, parseQosDscp);
      return v === undefined ? undefined : { text, kind: 'dscp', values: v };
    }
    case 'ip': {
      if (a !== 'precedence') return undefined;
      const v = values(args.slice(2), 4, parseQosPrecedence);
      return v === undefined ? undefined : { text, kind: 'precedence', values: v };
    }
    case 'precedence': {
      const v = values(args.slice(1), 4, parseQosPrecedence);
      return v === undefined ? undefined : { text, kind: 'precedence', values: v };
    }
    case 'cos': {
      const v = values(args.slice(1), 4, parseQosCos);
      return v === undefined ? undefined : { text, kind: 'cos', values: v };
    }
    case 'access-group': {
      if (a === 'name') return b !== undefined && extra === undefined ? { text, kind: 'access-group', list: b } : undefined;
      if (a === undefined || b !== undefined || !/^\d{1,4}$/.test(a)) return undefined;
      return { text, kind: 'access-group', list: String(Number(a)) };
    }
    case 'protocol':
      return (a === 'ip' || a === 'icmp' || a === 'tcp' || a === 'udp') && b === undefined ? { text, kind: 'protocol', protocol: a } : undefined;
    case 'input-interface':
      return a !== undefined && b === undefined ? { text, kind: 'input-interface', port: a } : undefined;
    case 'any':
      return a === undefined ? { text, kind: 'any' } : undefined;
    default:
      return undefined;
  }
}

/** Name and mode of a `class-map` section from its stored args (`['match-any', 'VOICE']` or `['VOICE']`). */
function classMapHead(args: readonly string[]): { name: string; mode: QosClassMatchMode } | undefined {
  const [a, b, extra] = args;
  if (a === undefined || extra !== undefined) return undefined;
  if (a === 'match-all' || a === 'match-any') return b === undefined ? undefined : { name: b, mode: a };
  return b === undefined ? { name: a, mode: 'match-all' } : undefined;
}

/** @since P3 Every class-map of a running configuration, keyed by name, in configuration order (a name's first section wins). */
export function readQosClassMaps(config: Pick<ConfigAst, 'root'>): Map<string, QosClassMap> {
  const out = new Map<string, QosClassMap>();
  for (const node of config.root.children) {
    if (node.key !== 'class-map') continue;
    const head = classMapHead(node.args);
    if (head === undefined || out.has(head.name)) continue;
    const matches: QosMatch[] = [];
    for (const c of node.children) {
      if (c.key !== 'match') continue;
      const m = parseQosMatch(c.args);
      if (m !== undefined) matches.push(m);
    }
    out.set(head.name, { name: head.name, mode: head.mode, matches });
  }
  return out;
}

// ── policy-maps ─────────────────────────────────────────────────────────────

/** @since P3 [S20] A rate given in kb/s or as a percentage of the port's reference rate. */
export type QosRate = { readonly kbps: number } | { readonly percent: number };

/** @since P3 [S20] A `bandwidth` reservation, or (`remaining percent`) a share of what is left after the reservations. */
export type QosBandwidth = QosRate | { readonly remainingPercent: number };

/**
 * @since P3 [S21] What a policer does with a conforming or an exceeding packet (the read-only form of the contract's
 * `PolicerAction`, ruling R26).
 */
export type QosPoliceAction = { readonly kind: 'transmit' } | { readonly kind: 'drop' } | { readonly kind: 'set-dscp-transmit'; readonly dscp: number };

/** @since P3 [S21] A `police` line: rate (b/s), burst (bytes; the default when omitted) and the two actions. */
export interface QosPoliceSpec {
  readonly rateBps: number;
  readonly burstBytes: number;
  readonly conform: QosPoliceAction;
  readonly exceed: QosPoliceAction;
  readonly text: string;
}

/** @since P3 [S21] A `shape average` line: rate (b/s) and bucket (bits; the default when omitted). */
export interface QosShapeSpec {
  readonly rateBps: number;
  readonly bcBits: number;
  readonly text: string;
}

/** @since P3 A `set` action (M13): `dscp` (IPv4 and IPv6), `precedence` (IPv4), `cos` (the 802.1Q PCP). */
export interface QosSetAction {
  readonly kind: 'dscp' | 'precedence' | 'cos';
  readonly value: number;
  /** The line as stored (`set dscp ef`): the cause of the `QosMark` mutation reads it. */
  readonly text: string;
}

/** @since P3 One `class` of a policy-map with its actions. */
export interface QosPolicyClassDef {
  readonly name: string;
  readonly isDefault: boolean;
  /** `set` lines in configuration order (a later line wins on the same field). */
  readonly sets: readonly QosSetAction[];
  readonly priority?: QosRate & { readonly text: string };
  readonly bandwidth?: QosBandwidth & { readonly text: string };
  readonly queueLimit?: number;
  readonly fairQueue?: boolean;
  readonly shape?: QosShapeSpec;
  readonly police?: QosPoliceSpec;
}

/** @since P3 A policy-map: its classes, the configured ones in order and then class-default (always present, last). */
export interface QosPolicyMapDef {
  readonly name: string;
  readonly classes: readonly QosPolicyClassDef[];
}

function parseRate(args: readonly string[]): QosRate | undefined {
  const [a, b, extra] = args;
  if (extra !== undefined) return undefined;
  if (a === 'percent') {
    const p = decimal(b, 100);
    return p === undefined || p < 1 ? undefined : { percent: p };
  }
  const k = decimal(a, 4_294_967);
  return k === undefined || k < 1 || b !== undefined ? undefined : { kbps: k };
}

function parseBandwidth(args: readonly string[]): QosBandwidth | undefined {
  if (args[0] === 'remaining') {
    if (args[1] !== 'percent' || args.length !== 3) return undefined;
    const p = decimal(args[2], 100);
    return p === undefined || p < 1 ? undefined : { remainingPercent: p };
  }
  return parseRate(args);
}

function parsePoliceAction(tokens: readonly string[], i: number): { action: QosPoliceAction; next: number } | undefined {
  const t = tokens[i];
  if (t === 'transmit' || t === 'drop') return { action: { kind: t }, next: i + 1 };
  if (t === 'set-dscp-transmit') {
    const v = parseQosDscp(tokens[i + 1]);
    return v === undefined ? undefined : { action: { kind: t, dscp: v }, next: i + 2 };
  }
  return undefined;
}

/**
 * @since P3 [S21] Parse the tokens of a `police` line after `police`: `<bps> [<bc bytes>] [conform-action <a>]
 * [exceed-action <a>]` with the actions `transmit`, `drop`, `set-dscp-transmit <v>`; conform defaults to transmit,
 * exceed to drop, the burst to `qosPoliceBurstBytes(rate)`.
 */
export function parseQosPolice(args: readonly string[]): QosPoliceSpec | undefined {
  const rate = decimal(args[0], 1_099_511_627_776);
  if (rate === undefined || rate < 1) return undefined;
  let i = 1;
  let burst: number | undefined;
  if (args[i] !== undefined && /^\d/.test(args[i]!)) {
    burst = decimal(args[i], 4_294_967_295);
    if (burst === undefined || burst < 1) return undefined;
    i++;
  }
  let conform: QosPoliceAction = { kind: 'transmit' };
  let exceed: QosPoliceAction = { kind: 'drop' };
  if (args[i] === 'conform-action') {
    const r = parsePoliceAction(args, i + 1);
    if (r === undefined) return undefined;
    conform = r.action;
    i = r.next;
  }
  if (args[i] === 'exceed-action') {
    const r = parsePoliceAction(args, i + 1);
    if (r === undefined) return undefined;
    exceed = r.action;
    i = r.next;
  }
  if (i !== args.length) return undefined;
  return { rateBps: rate, burstBytes: burst ?? qosPoliceBurstBytes(rate), conform, exceed, text: ['police', ...args].join(' ') };
}

/** @since P3 [S21] Parse the tokens of a `shape` line after `shape`: `average <bps> [<bc bits>]`. */
export function parseQosShape(args: readonly string[]): QosShapeSpec | undefined {
  const [kind, r, bc, extra] = args;
  if (kind !== 'average' || extra !== undefined) return undefined;
  const rate = decimal(r, 1_099_511_627_776);
  if (rate === undefined || rate < 1) return undefined;
  const bits = bc === undefined ? qosShapeDefaultBcBits(rate) : decimal(bc, 4_294_967_295);
  if (bits === undefined || bits < 1) return undefined;
  return { rateBps: rate, bcBits: bits, text: ['shape', ...args].join(' ') };
}

/** @since P3 Parse the tokens of a `set` line after `set`: `dscp <v>`, `ip precedence <v>`, `cos <v>`. */
export function parseQosSet(args: readonly string[]): QosSetAction | undefined {
  const text = ['set', ...args].join(' ');
  const [k, a, b, extra] = args;
  if (k === 'dscp' && b === undefined) {
    const v = parseQosDscp(a);
    return v === undefined ? undefined : { kind: 'dscp', value: v, text };
  }
  if (k === 'ip' && a === 'precedence' && extra === undefined) {
    const v = parseQosPrecedence(b);
    return v === undefined ? undefined : { kind: 'precedence', value: v, text };
  }
  if (k === 'precedence' && b === undefined) {
    const v = parseQosPrecedence(a);
    return v === undefined ? undefined : { kind: 'precedence', value: v, text };
  }
  if (k === 'cos' && b === undefined) {
    const v = parseQosCos(a);
    return v === undefined ? undefined : { kind: 'cos', value: v, text };
  }
  return undefined;
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

function readPolicyClass(name: string, node: ConfigNode | undefined): QosPolicyClassDef {
  const sets: QosSetAction[] = [];
  const def: Mutable<QosPolicyClassDef> = { name, isDefault: name === QOS_CLASS_DEFAULT, sets };
  for (const c of node?.children ?? []) {
    const text = [c.key, ...c.args].join(' ');
    switch (c.key) {
      case 'set': {
        const s = parseQosSet(c.args);
        if (s !== undefined) sets.push(s);
        break;
      }
      case 'priority': {
        const r = parseRate(c.args);
        if (r !== undefined) def.priority = { ...r, text };
        break;
      }
      case 'bandwidth': {
        const b = parseBandwidth(c.args);
        if (b !== undefined) def.bandwidth = { ...b, text };
        break;
      }
      case 'queue-limit': {
        const n = c.args.length === 1 ? decimal(c.args[0], 32_768) : undefined;
        if (n !== undefined && n >= 1) def.queueLimit = n;
        break;
      }
      case 'fair-queue':
        if (c.args.length === 0) def.fairQueue = true;
        break;
      case 'shape': {
        const s = parseQosShape(c.args);
        if (s !== undefined) def.shape = s;
        break;
      }
      case 'police': {
        const p = parseQosPolice(c.args);
        if (p !== undefined) def.police = p;
        break;
      }
      default:
        break;
    }
  }
  return def;
}

/**
 * @since P3 Every policy-map of a running configuration, keyed by name, in configuration order (a name's first section
 * wins). Each lists its configured classes in order (a class name's first section wins), then class-default, which is
 * always present and always last (an explicit `class class-default` section gives it its actions).
 */
export function readQosPolicyMaps(config: Pick<ConfigAst, 'root'>): Map<string, QosPolicyMapDef> {
  const out = new Map<string, QosPolicyMapDef>();
  for (const node of config.root.children) {
    if (node.key !== 'policy-map' || node.args.length !== 1) continue;
    const name = node.args[0]!;
    if (out.has(name)) continue;
    const classes: QosPolicyClassDef[] = [];
    const seen = new Set<string>();
    let defaultNode: ConfigNode | undefined;
    for (const c of node.children) {
      if (c.key !== 'class' || c.args.length !== 1) continue;
      const cname = c.args[0]!;
      if (cname === QOS_CLASS_DEFAULT) {
        defaultNode ??= c;
        continue;
      }
      if (seen.has(cname)) continue;
      seen.add(cname);
      classes.push(readPolicyClass(cname, c));
    }
    classes.push(readPolicyClass(QOS_CLASS_DEFAULT, defaultNode));
    out.set(name, { name, classes });
  }
  return out;
}

// ── compiled policies ───────────────────────────────────────────────────────

/** @since P3 A class of a compiled policy: its actions and its class-map (absent for class-default). */
export interface QosPolicyClass extends QosPolicyClassDef {
  readonly classMap?: QosClassMap;
  /** The class names a class-map that does not exist: it matches nothing. */
  readonly missing?: true;
}

/** @since P3 A compiled policy (D16): what the runtime caches per (port, direction) and generation. */
export interface QosPolicy {
  readonly name: string;
  /** The configured classes in policy order, then class-default (always last). */
  readonly classes: readonly QosPolicyClass[];
  /** The access lists the class-maps name (`match access-group`), read through `core/acl.ts`; absent = undefined list. */
  readonly acls: ReadonlyMap<string, AclList>;
  /** Some class has a `set` action. */
  readonly marks: boolean;
  /** [S21] Some class has a `police` action. */
  readonly polices: boolean;
  /** [S20] Some class has a queueing action (`priority`, `bandwidth`, `queue-limit`, `fair-queue`, `shape`), D16. */
  readonly queueing: boolean;
}

/** @since P3 Options of the compile: `resolvePort` canonicalises a `match input-interface` name (the device's port names). */
export interface QosCompileOptions {
  readonly resolvePort?: (text: string) => string | undefined;
}

/** @since P3 [S20] True when a class holds a queueing action (D16): priority, bandwidth, queue-limit, fair-queue, shape. */
export function qosClassQueues(c: QosPolicyClassDef): boolean {
  return c.priority !== undefined || c.bandwidth !== undefined || c.queueLimit !== undefined || c.fairQueue === true || c.shape !== undefined;
}

/**
 * @since P3 Compile the policy-map `name` of a running configuration (undefined when it does not exist): the classes
 * with their class-maps and the access lists those name (an undefined list stays absent from `acls`, so its match
 * never hits). Reads the configuration once; the result never changes.
 */
export function compileQosPolicy(config: Pick<ConfigAst, 'root'>, name: string, opts: QosCompileOptions = {}): QosPolicy | undefined {
  const def = readQosPolicyMaps(config).get(name);
  if (def === undefined) return undefined;
  const classMaps = readQosClassMaps(config);
  let allAcls: Map<string, AclList> | undefined;
  const acls = new Map<string, AclList>();
  const resolve = (cm: QosClassMap): QosClassMap => {
    if (opts.resolvePort === undefined || !cm.matches.some((m) => m.kind === 'input-interface')) return cm;
    return {
      ...cm,
      matches: cm.matches.map((m) => (m.kind === 'input-interface' ? { ...m, port: opts.resolvePort!(m.port) ?? m.port } : m)),
    };
  };
  const classes: QosPolicyClass[] = def.classes.map((c) => {
    if (c.isDefault) return c;
    const found = classMaps.get(c.name);
    if (found === undefined) return { ...c, missing: true };
    const cm = resolve(found);
    for (const m of cm.matches) {
      if (m.kind !== 'access-group' || acls.has(m.list)) continue;
      allAcls ??= readAcls(config);
      const list = allAcls.get(m.list);
      if (list !== undefined) acls.set(m.list, list);
    }
    return { ...c, classMap: cm };
  });
  return {
    name,
    classes,
    acls,
    marks: classes.some((c) => c.sets.length > 0),
    polices: classes.some((c) => c.police !== undefined),
    queueing: classes.some(qosClassQueues),
  };
}

/** The `interface <port>` section of a running configuration. */
function interfaceNode(config: Pick<ConfigAst, 'root'>, port: string): ConfigNode | undefined {
  return config.root.children.find((n) => n.key === 'interface' && n.args.length === 1 && n.args[0] === port);
}

/** @since P3 The policy name of `service-policy <direction> <n>` on the interface `port` (undefined without one). */
export function readServicePolicy(config: Pick<ConfigAst, 'root'>, port: string, direction: 'input' | 'output'): string | undefined {
  const line = interfaceNode(config, port)?.children.find((c) => c.key === 'service-policy' && c.args.length === 2 && c.args[0] === direction);
  return line?.args[1];
}

/** @since P3 The compiled policy attached to `port` in `direction` (undefined without one, or when it does not exist). */
export function compilePortQosPolicy(
  config: Pick<ConfigAst, 'root'>,
  port: string,
  direction: 'input' | 'output',
  opts: QosCompileOptions = {},
): QosPolicy | undefined {
  const name = readServicePolicy(config, port, direction);
  return name === undefined ? undefined : compileQosPolicy(config, name, opts);
}

/**
 * @since P3 What the interface sections of a running configuration attach (W3 device: the runtime's per-generation
 * index, so a port without any of these lines costs one map lookup per frame): the `service-policy input|output`
 * names and [S21] interface `fair-queue`. Ports in configuration order; a port without any of the three is absent.
 */
export interface QosAttachment {
  readonly input?: string;
  readonly output?: string;
  readonly fairQueue?: true;
}

/** @since P3 Every interface's QoS attachment (`QosAttachment`), keyed by the interface name as stored. */
export function readQosAttachments(config: Pick<ConfigAst, 'root'>): Map<string, QosAttachment> {
  const out = new Map<string, QosAttachment>();
  for (const node of config.root.children) {
    if (node.key !== 'interface' || node.args.length !== 1) continue;
    const port = node.args[0]!;
    if (out.has(port)) continue;
    let input: string | undefined;
    let output: string | undefined;
    let fairQueue = false;
    for (const c of node.children) {
      if (c.key === 'service-policy' && c.args.length === 2) {
        if (c.args[0] === 'input') input ??= c.args[1];
        else if (c.args[0] === 'output') output ??= c.args[1];
      } else if (c.key === 'fair-queue' && c.args.length === 0) {
        fairQueue = true;
      }
    }
    if (input === undefined && output === undefined && !fairQueue) continue;
    out.set(port, {
      ...(input === undefined ? {} : { input }),
      ...(output === undefined ? {} : { output }),
      ...(fairQueue ? { fairQueue: true as const } : {}),
    });
  }
  return out;
}

/**
 * @since P3 [S21] The `PolicerSpec` (contracts/link.ts) of a `police` line: its rate and burst, and (ruling R26) its
 * actions when they are not the defaults (conform transmit, exceed drop), so a default policer keeps the W0 shape.
 */
export function qosPolicerSpecOf(p: Pick<QosPoliceSpec, 'rateBps' | 'burstBytes' | 'conform' | 'exceed'>): PolicerSpec {
  const spec: PolicerSpec = { rateBps: p.rateBps, burstBytes: p.burstBytes };
  if (p.conform.kind !== 'transmit') spec.conform = { ...p.conform };
  if (p.exceed.kind !== 'drop') spec.exceed = { ...p.exceed };
  return spec;
}

/** @since P3 [S21] True when the interface `port` carries `fair-queue` (WFQ on the whole port). */
export function readInterfaceFairQueue(config: Pick<ConfigAst, 'root'>, port: string): boolean {
  return interfaceNode(config, port)?.children.some((c) => c.key === 'fair-queue' && c.args.length === 0) === true;
}

/**
 * @since P3 [S20] The reference rate of `port` (b/s): its `bandwidth <kbps>` line, else `negotiatedBps` (the 75 %
 * admission check and the percent forms read it, §3.11 step 1).
 */
export function qosReferenceBps(config: Pick<ConfigAst, 'root'>, port: string, negotiatedBps: number): number {
  const line = interfaceNode(config, port)?.children.find((c) => c.key === 'bandwidth' && c.args.length === 1);
  const kbps = line === undefined ? undefined : decimal(line.args[0], 10_000_000_000);
  return kbps !== undefined && kbps > 0 ? kbps * 1000 : negotiatedBps;
}

/**
 * @since P3 (W3 fix, ruling R34) THE QoS reference rate of a port (b/s), one helper for every reader: its `bandwidth
 * <kbps>` line, else its routing bandwidth (`routingBandwidthKbps` of its effective role and speed: the `BW` of `show
 * interfaces`, 1544 kb/s on serial, the negotiated rate on Ethernet). The 75 % admission of `service-policy output`
 * (cli), the compiled scheduler (`DeviceRuntime.egressPolicy`) and the `qos.admitted` fact all read it, so the CLI, the
 * runtime and the grader never disagree.
 */
export function qosPortReferenceRateBps(config: Pick<ConfigAst, 'root'>, port: string, role: PortRole, speedBps: number | undefined): number {
  const routing = routingBandwidthKbps(speedBps === undefined ? { role } : { role, speedBps }) * 1000;
  return qosReferenceBps(config, port, routing);
}

// ── [S20]/[S21] the scheduler spec and its admission ────────────────────────

function rateBps(r: QosRate, refBps: number): number {
  return 'kbps' in r ? r.kbps * 1000 : Math.floor((refBps * r.percent) / 100);
}

/**
 * @since P3 [S20] The reservation of every class in b/s (class order): a priority class reserves its rate, a class
 * with `bandwidth <kbps>|percent <p>` that bandwidth; `bandwidth remaining percent` and the other classes reserve 0.
 */
export function qosReservationsBps(policy: Pick<QosPolicy, 'classes'>, refBps: number): number[] {
  return policy.classes.map((c) => {
    if (c.priority !== undefined) return rateBps(c.priority, refBps);
    if (c.bandwidth !== undefined && !('remainingPercent' in c.bandwidth)) return rateBps(c.bandwidth, refBps);
    return 0;
  });
}

/** @since P3 [S20] The 75 % admission of a policy on a port of reference rate `refBps` (the `qosAdmission` refusal). */
export function qosPolicyAdmission(policy: Pick<QosPolicy, 'classes'>, refBps: number): EgressAdmission {
  return egressAdmission(refBps, qosReservationsBps(policy, refBps));
}

/**
 * @since P3 [S21] True when an output policer's actions are the ones the scheduler enforces (`EgressClassSpec.police`:
 * conform transmits, exceed drops). Any other pair stays with the runtime, which polices before `deps.transmit`.
 */
export function qosPoliceInScheduler(p: Pick<QosPoliceSpec, 'conform' | 'exceed'>): boolean {
  return p.conform.kind === 'transmit' && p.exceed.kind === 'drop';
}

/**
 * @since P3 [S20]/[S21] The scheduler spec of an output policy with a queueing action on a port of reference rate
 * `refBps`; undefined for a policy without one (the port keeps the virtual FIFO, D16). One spec class per policy class,
 * in the same order (the runtime's class index is `qosClass`):
 *   • a `priority` class → kind `priority`, `rateBps` its rate (the LLQ conditional policer, burst 200 ms of it);
 *   • class-default → kind `default`; every other class → kind `bandwidth`;
 *   • DRR weights (`weightKbps`): a `bandwidth <kbps>|percent` class its bandwidth; a `bandwidth remaining percent <p>`
 *     class p % of what the priority and bandwidth classes leave of `refBps`; every class without either (class-default
 *     included) an equal part of what is left after those; at least 1;
 *   • `queueLimit` its `queue-limit`, else 64; `fairQueue` [S21] on a non-priority class with `fair-queue`;
 *   • [S21] `police` when its actions are transmit/drop (`qosPoliceInScheduler`); the port shaper from class-default's
 *     `shape average` (the spec shapes the whole port; a `shape` line in another class is not a port shaper).
 */
export function egressSchedulerSpecOf(policy: QosPolicy, refBps: number): EgressSchedulerSpec | undefined {
  if (!policy.queueing) return undefined;
  const reserved = qosReservationsBps(policy, refBps);
  let left = refBps;
  for (const r of reserved) left -= r;
  if (left < 0) left = 0;
  const shares = policy.classes.map((c) =>
    c.priority === undefined && c.bandwidth !== undefined && 'remainingPercent' in c.bandwidth ? Math.floor((left * c.bandwidth.remainingPercent) / 100) : 0,
  );
  let rest = left;
  for (const s of shares) rest -= s;
  if (rest < 0) rest = 0;
  const unreserved = policy.classes.filter((c) => c.priority === undefined && c.bandwidth === undefined).length;
  const each = unreserved === 0 ? 0 : Math.floor(rest / unreserved);
  const classes: EgressClassSpec[] = policy.classes.map((c, i) => {
    const kind: EgressClassSpec['kind'] = c.priority !== undefined ? 'priority' : c.isDefault ? 'default' : 'bandwidth';
    const bps = c.priority !== undefined ? Math.max(1, reserved[i]!) : c.bandwidth !== undefined ? ('remainingPercent' in c.bandwidth ? shares[i]! : reserved[i]!) : each;
    const spec: Mutable<EgressClassSpec> = {
      name: c.name,
      kind,
      weightKbps: Math.max(1, Math.floor(bps / 1000)),
      queueLimit: c.queueLimit ?? QOS_DEFAULT_QUEUE_LIMIT,
    };
    if (kind === 'priority') spec.rateBps = bps;
    if (kind !== 'priority' && c.fairQueue === true) spec.fairQueue = true;
    if (c.police !== undefined && qosPoliceInScheduler(c.police)) spec.police = qosPolicerSpecOf(c.police);
    return spec;
  });
  const shape = policy.classes[policy.classes.length - 1]!.shape;
  return {
    policy: policy.name,
    refBps,
    classes,
    ...(shape === undefined ? {} : { shapeBps: shape.rateBps, shapeBcBits: shape.bcBits }),
  };
}

/** @since P3 [S21] The policy name of the spec `interface fair-queue` compiles to (no policy: the view shows none). */
export const QOS_INTERFACE_FAIR_QUEUE_POLICY = '';

/**
 * @since P3 [S21] The spec of interface `fair-queue` (WFQ on the whole port): one class-default with flow DRR, held to
 * the port's frame limit `P2P_QUEUE_LIMIT` (256, the virtual FIFO's bound).
 */
export function interfaceFairQueueSpec(refBps: number): EgressSchedulerSpec {
  return {
    policy: QOS_INTERFACE_FAIR_QUEUE_POLICY,
    refBps,
    classes: [{ name: QOS_CLASS_DEFAULT, kind: 'default', weightKbps: Math.max(1, Math.floor(refBps / 1000)), queueLimit: P2P_QUEUE_LIMIT, fairQueue: true }],
  };
}

/** @since P3 [S20]/[S21] A port's egress scheduler: from its output policy, or from interface `fair-queue`. */
export type QosPortEgress =
  | { readonly source: 'policy'; readonly policy: QosPolicy; readonly spec: EgressSchedulerSpec; readonly admission: EgressAdmission }
  | { readonly source: 'fair-queue'; readonly spec: EgressSchedulerSpec };

/**
 * @since P3 [S20]/[S21] The egress scheduler of `port` (undefined = the virtual FIFO): its output policy when that
 * policy has a queueing action (with its admission: a refused policy is the caller's to ignore), else interface
 * `fair-queue`. `negotiatedBps` is the port's rate when it has no `bandwidth` line.
 */
export function compileEgressScheduler(
  config: Pick<ConfigAst, 'root'>,
  port: string,
  negotiatedBps: number,
  opts: QosCompileOptions = {},
): QosPortEgress | undefined {
  const refBps = qosReferenceBps(config, port, negotiatedBps);
  const policy = compilePortQosPolicy(config, port, 'output', opts);
  if (policy !== undefined && policy.queueing) {
    return { source: 'policy', policy, spec: egressSchedulerSpecOf(policy, refBps)!, admission: qosPolicyAdmission(policy, refBps) };
  }
  return readInterfaceFairQueue(config, port) ? { source: 'fair-queue', spec: interfaceFairQueueSpec(refBps) } : undefined;
}

// ── the configuration generation (D16) ──────────────────────────────────────

/**
 * @since P3 True when a configuration delta can change a compiled policy or a scheduler spec (D16): any line under (or
 * the section line of) `class-map`, `policy-map`, `access-list` or `ip access-list`; an interface `service-policy`
 * line; [S20]/[S21] an interface `bandwidth` or `fair-queue` line; the creation or removal of an interface section.
 */
export function isQosConfigDelta(delta: Pick<ConfigDelta, 'context' | 'line'>): boolean {
  const top = delta.context.length > 0 ? delta.context[0]! : delta.line;
  const k = top[0];
  if (k === 'class-map' || k === 'policy-map' || k === 'access-list') return true;
  if (k === 'ip' && top[1] === 'access-list') return true;
  if (k !== 'interface') return false;
  if (delta.context.length === 0) return true;
  if (delta.context.length !== 1) return false;
  const l = delta.line[0];
  return l === 'service-policy' || l === 'bandwidth' || l === 'fair-queue';
}

/** @since P3 The next configuration generation after `delta` (D16): `generation + 1` for a QoS delta, else unchanged. */
export function nextQosGeneration(generation: number, delta: Pick<ConfigDelta, 'context' | 'line'>): number {
  return isQosConfigDelta(delta) ? generation + 1 : generation;
}
