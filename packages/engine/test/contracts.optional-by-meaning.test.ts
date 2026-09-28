/**
 * W8 exit gate — the members that stay optional (ARCHITECTURE-P2 §0 rule 2, §2.15, §7 W8; §9.2 item 29b/29d).
 *
 * The transition rule made every `@since P2` contract member optional in the type only; the exit gate removed every
 * `?` that was left, except the members that are optional BY MEANING: absent means P1 behaviour and P1 bytes (several
 * are hashed into goldens), so they keep their `?` for ever. This file pins, per member:
 *
 *  • type level — the type still accepts an object without the member: `optional<T, K>(…, true)` compiles only when
 *    `Omit<T, K>` is assignable to `T` (tsc type-checks test/**), and the runtime `expect` pairs each with a test;
 *  • source level — its JSDoc in packages/engine/src/contracts carries "optional by meaning" (its own comment, or the
 *    comment of the union arm or declaration that holds it and names it in back-ticks), and the member still has `?`.
 *
 * The list is every engine member of the §2.15 table (port, pdu, process, transport, tables, events, trace, snapshot,
 * device, topology, simulation, scenario, rf/medium; the web members are pinned by the web package), including the
 * members the W8 gate tagged optional by meaning: `CliRuntimeDeps.resume` (absent: the session counters start at 0),
 * `ConfigLineRule.bothForms` / `.negationRestoresDefault` (absent = P1 storage), the `setPortL3` action's
 * `virtual4` / `groups4` (absent = unchanged) and `CommandSpec.excludesAny` (absent = no exclusion; item 29b). A last
 * check closes the set: no contract member tagged `@since P2` is optional without being listed here, so no transition
 * `?` survives the gate unnoticed.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import type { CommandSpec, CliRuntimeDeps } from '../src/contracts/cli.js';
import type { ConfigLineRule } from '../src/contracts/config.js';
import type { DeviceModel, DeviceSpec, PortResolution } from '../src/contracts/device.js';
import type { SimEventBody } from '../src/contracts/events.js';
import type { BssSnapshot } from '../src/contracts/medium.js';
import type { PduMeta, RewrapOp } from '../src/contracts/pdu.js';
import type { PortL3, PortSpec, PortState } from '../src/contracts/port.js';
import type { Action, DebugEvent, DemuxSelector, ProcessCtx, ProcessRequest } from '../src/contracts/process.js';
import type { RadioPortView, RadioSettings } from '../src/contracts/rf.js';
import type { LabAssertion } from '../src/contracts/scenario.js';
import type { SimulationOptions, TraceFilter } from '../src/contracts/simulation.js';
import type { PortSnapshot, SimSnapshot } from '../src/contracts/snapshot.js';
import type { CamRow, Route6Row, RouteRow } from '../src/contracts/tables.js';
import type { Topology } from '../src/contracts/topology.js';
import type { PduSummary, TraceEvent } from '../src/contracts/trace.js';
import type { LeaseEvent } from '../src/contracts/transport.js';

const CONTRACTS = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'contracts');

/** `true` exactly when `T` accepts an object without `K`, i.e. when `K` is optional in `T`. */
type AcceptsWithout<T, K extends keyof T> = Omit<T, K> extends T ? true : false;

/** One optional-by-meaning member: where its declaration lives and whether its type accepts an object without it. */
interface OptionalMember {
  /** The §2.15 row ('(W8)': tagged optional by meaning at the exit gate). */
  readonly row: string;
  /** File under src/contracts that declares it. */
  readonly file: string;
  /** Interface or type alias that holds it. */
  readonly owner: string;
  /** Union arm that holds it, as [discriminant key, value] (e.g. ['kind', 'arp.gratuitous']). */
  readonly arm?: readonly [string, string];
  readonly member: string;
  /** The type-level check, carried to run time. */
  readonly accepted: boolean;
}

/**
 * The entry of member `K` of `T`. `accepted` is typed `AcceptsWithout<T, K>`, so passing `true` compiles only while
 * `K` is optional in `T`: removing the `?` breaks `tsc -p packages/engine/tsconfig.json`.
 */
function optional<T, K extends keyof T & string>(
  row: string,
  file: string,
  owner: string,
  member: K,
  accepted: AcceptsWithout<T, K>,
  arm?: readonly [string, string],
): OptionalMember {
  return arm === undefined ? { row, file, owner, member, accepted } : { row, file, owner, arm, member, accepted };
}

type ArpGratuitous = Extract<ProcessRequest, { kind: 'arp.gratuitous' }>;
type UdpOpen = Extract<ProcessRequest, { kind: 'udp.open' }>;
type RadioProfile = Extract<Action, { type: 'radio-profile' }>;
type SetPortL3 = Extract<Action, { type: 'setPortL3' }>;
type FrameArrival = Extract<SimEventBody, { kind: 'frameArrival' }>;
type DropEvent = Extract<TraceEvent, { kind: 'drop' }>;
type VirtualResolution = Extract<PortResolution, { kind: 'virtual' }>;
type Connectivity = Extract<LabAssertion, { kind: 'connectivity' }>;

const MEMBERS: readonly OptionalMember[] = [
  // port.ts
  optional<PortSpec, 'parent'>('port.ts', 'port.ts', 'PortSpec', 'parent', true),
  optional<PortState, 'dot1q'>('port.ts', 'port.ts', 'PortState', 'dot1q', true),
  optional<PortL3, 'virtual4'>('port.ts', 'port.ts', 'PortL3', 'virtual4', true),
  optional<PortL3, 'groups4'>('port.ts [S2]', 'port.ts', 'PortL3', 'groups4', true),
  // pdu.ts
  optional<RewrapOp, 'as'>('pdu.ts', 'pdu.ts', 'RewrapOp', 'as', true),
  optional<PduMeta, 'protected'>('pdu.ts', 'pdu.ts', 'PduMeta', 'protected', true),
  // process.ts
  optional<DebugEvent, 'fsm'>('process.ts', 'process.ts', 'DebugEvent', 'fsm', true),
  optional<DemuxSelector, 'frame'>('process.ts', 'process.ts', 'DemuxSelector', 'frame', true),
  optional<ProcessCtx, 'radioSettings'>('process.ts', 'process.ts', 'ProcessCtx', 'radioSettings', true),
  optional<ArpGratuitous, 'address'>('process.ts', 'process.ts', 'ProcessRequest', 'address', true, ['kind', 'arp.gratuitous']),
  optional<ArpGratuitous, 'mac'>('process.ts', 'process.ts', 'ProcessRequest', 'mac', true, ['kind', 'arp.gratuitous']),
  optional<UdpOpen, 'tunnel'>('process.ts', 'process.ts', 'ProcessRequest', 'tunnel', true, ['kind', 'udp.open']),
  optional<RadioProfile, 'controller'>('process.ts', 'process.ts', 'Action', 'controller', true, ['type', 'radio-profile']),
  // transport.ts
  optional<LeaseEvent, 'family'>('transport.ts', 'transport.ts', 'LeaseEvent', 'family', true),
  // tables.ts
  optional<CamRow, 'secure'>('tables.ts', 'tables.ts', 'CamRow', 'secure', true),
  optional<RouteRow, 'paths'>('tables.ts [S6]', 'tables.ts', 'RouteRow', 'paths', true),
  optional<Route6Row, 'paths'>('tables.ts [S6]', 'tables.ts', 'Route6Row', 'paths', true),
  // events.ts
  optional<FrameArrival, 'central'>('events.ts', 'events.ts', 'SimEventBody', 'central', true, ['kind', 'frameArrival']),
  // trace.ts (TraceFilter lives in simulation.ts)
  optional<DropEvent, 'background'>('trace.ts', 'trace.ts', 'TraceEvent', 'background', true, ['kind', 'drop']),
  optional<PduSummary, 'vlan'>('trace.ts', 'trace.ts', 'PduSummary', 'vlan', true),
  optional<PduSummary, 'tunnel'>('trace.ts', 'trace.ts', 'PduSummary', 'tunnel', true),
  optional<TraceFilter, 'machines'>('trace.ts [S1]', 'simulation.ts', 'TraceFilter', 'machines', true),
  // snapshot.ts
  optional<PortSnapshot, 'l2'>('snapshot.ts', 'snapshot.ts', 'PortSnapshot', 'l2', true),
  optional<PortSnapshot, 'parent'>('snapshot.ts', 'snapshot.ts', 'PortSnapshot', 'parent', true),
  optional<PortSnapshot, 'dot1q'>('snapshot.ts', 'snapshot.ts', 'PortSnapshot', 'dot1q', true),
  optional<SimSnapshot, 'profile'>('snapshot.ts', 'snapshot.ts', 'SimSnapshot', 'profile', true),
  // device.ts
  optional<DeviceSpec, 'profile'>('device.ts', 'device.ts', 'DeviceSpec', 'profile', true),
  optional<DeviceModel, 'profileConfig'>('device.ts', 'device.ts', 'DeviceModel', 'profileConfig', true),
  optional<DeviceModel, 'subinterfaces'>('device.ts', 'device.ts', 'DeviceModel', 'subinterfaces', true),
  optional<DeviceModel, 'stpDefaultMode'>('device.ts', 'device.ts', 'DeviceModel', 'stpDefaultMode', true),
  optional<VirtualResolution, 'parent'>('device.ts', 'device.ts', 'PortResolution', 'parent', true, ['kind', 'virtual']),
  // topology.ts
  optional<Topology, 'profile'>('topology.ts', 'topology.ts', 'Topology', 'profile', true),
  // simulation.ts
  optional<SimulationOptions, 'profile'>('simulation.ts', 'simulation.ts', 'SimulationOptions', 'profile', true),
  optional<SimulationOptions, 'catalog'>('simulation.ts', 'simulation.ts', 'SimulationOptions', 'catalog', true),
  optional<SimulationOptions, 'journal'>('simulation.ts [S1]', 'simulation.ts', 'SimulationOptions', 'journal', true),
  optional<SimulationOptions, 'pduRegistryLimit'>('simulation.ts [S1]', 'simulation.ts', 'SimulationOptions', 'pduRegistryLimit', true),
  optional<SimulationOptions, 'resume'>('simulation.ts [S1]', 'simulation.ts', 'SimulationOptions', 'resume', true),
  // scenario.ts
  optional<Connectivity, 'after'>('scenario.ts', 'scenario.ts', 'LabAssertion', 'after', true, ['kind', 'connectivity']),
  optional<Connectivity, 'settleMs'>('scenario.ts', 'scenario.ts', 'LabAssertion', 'settleMs', true, ['kind', 'connectivity']),
  optional<Connectivity, 'then'>('scenario.ts', 'scenario.ts', 'LabAssertion', 'then', true, ['kind', 'connectivity']),
  // rf.ts / medium.ts
  optional<RadioSettings, 'bss'>('rf.ts / medium.ts', 'rf.ts', 'RadioSettings', 'bss', true),
  optional<RadioSettings, 'controller'>('rf.ts / medium.ts', 'rf.ts', 'RadioSettings', 'controller', true),
  optional<RadioPortView, 'bss'>('rf.ts / medium.ts', 'rf.ts', 'RadioPortView', 'bss', true),
  optional<BssSnapshot, 'index'>('rf.ts / medium.ts', 'medium.ts', 'BssSnapshot', 'index', true),
  optional<BssSnapshot, 'wlanId'>('rf.ts / medium.ts', 'medium.ts', 'BssSnapshot', 'wlanId', true),
  optional<BssSnapshot, 'vlan'>('rf.ts / medium.ts', 'medium.ts', 'BssSnapshot', 'vlan', true),
  optional<BssSnapshot, 'switching'>('rf.ts / medium.ts', 'medium.ts', 'BssSnapshot', 'switching', true),
  // cli.ts, config.ts and the setPortL3 action: tagged optional by meaning at the W8 gate
  optional<CliRuntimeDeps, 'resume'>('cli.ts [S1] (W8)', 'cli.ts', 'CliRuntimeDeps', 'resume', true),
  optional<ConfigLineRule, 'bothForms'>('config.ts (W8)', 'config.ts', 'ConfigLineRule', 'bothForms', true),
  optional<ConfigLineRule, 'negationRestoresDefault'>('config.ts (W8)', 'config.ts', 'ConfigLineRule', 'negationRestoresDefault', true),
  optional<SetPortL3, 'virtual4'>('process.ts (W8)', 'process.ts', 'Action', 'virtual4', true, ['type', 'setPortL3']),
  optional<SetPortL3, 'groups4'>('process.ts [S2] (W8)', 'process.ts', 'Action', 'groups4', true, ['type', 'setPortL3']),
  optional<CommandSpec, 'excludesAny'>('cli.ts (§9.2 item 29b)', 'cli.ts', 'CommandSpec', 'excludesAny', true),
];

// ── source reading (the TypeScript parser; the contracts are read, never executed) ─────────────────────────────────

interface Parsed {
  readonly text: string;
  readonly sf: ts.SourceFile;
}

const parsedFiles = new Map<string, Parsed>();

function parse(file: string): Parsed {
  let p = parsedFiles.get(file);
  if (p === undefined) {
    const text = readFileSync(join(CONTRACTS, file), 'utf8');
    p = { text, sf: ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true) };
    parsedFiles.set(file, p);
  }
  return p;
}

/** The comments before `pos` that start on a later line than `pos` (a node's leading comments, its JSDoc included). */
function commentsAt(text: string, pos: number): string {
  return (ts.getLeadingCommentRanges(text, pos) ?? []).map((r) => text.slice(r.pos, r.end)).join('\n');
}

/** The comments of a union arm: those between the previous arm (or the start of the union) and the arm's `|`. */
function armComments(text: string, arm: ts.TypeNode): string {
  const union = arm.parent;
  if (!ts.isUnionTypeNode(union)) return '';
  const i = union.types.indexOf(arm);
  return commentsAt(text, i === 0 ? union.pos : union.types[i - 1]!.end);
}

/** The string-literal value of member `key` of a type literal, if it has one. */
function literalOf(node: ts.TypeLiteralNode, key: string): string | undefined {
  for (const m of node.members) {
    if (ts.isPropertySignature(m) && m.name.getText() === key && m.type !== undefined && ts.isLiteralTypeNode(m.type) && ts.isStringLiteral(m.type.literal)) {
      return m.type.literal.text;
    }
  }
  return undefined;
}

/** The type literal inside `node` whose `key` is the literal `value` (depth-first). */
function findArm(node: ts.Node, key: string, value: string): ts.TypeLiteralNode | undefined {
  if (ts.isTypeLiteralNode(node) && literalOf(node, key) === value) return node;
  return ts.forEachChild(node, (c) => findArm(c, key, value));
}

/** The union member that holds `node` (the node itself, or its parenthesised / intersected form). */
function unionMemberOf(node: ts.Node): ts.TypeNode | undefined {
  let n: ts.Node = node;
  while (n.parent !== undefined && !ts.isUnionTypeNode(n.parent)) {
    if (ts.isTypeAliasDeclaration(n.parent) || ts.isSourceFile(n.parent)) return undefined;
    n = n.parent;
  }
  return n.parent === undefined ? undefined : (n as ts.TypeNode);
}

interface Located {
  /** The member's own leading comments. */
  readonly own: string;
  /** The comments of the union arm that holds it, then of the declaration that holds it. */
  readonly enclosing: string;
  readonly optional: boolean;
}

/** Find `m` in its contract file; throws with a readable message when the declaration moved or was renamed. */
function locate(m: OptionalMember): Located {
  const { text, sf } = parse(m.file);
  const decl = sf.statements.find(
    (s): s is ts.InterfaceDeclaration | ts.TypeAliasDeclaration =>
      (ts.isInterfaceDeclaration(s) || ts.isTypeAliasDeclaration(s)) && s.name.text === m.owner,
  );
  if (decl === undefined) throw new Error(`${m.file}: no declaration ${m.owner}`);
  let holder: ts.InterfaceDeclaration | ts.TypeLiteralNode;
  let enclosing = commentsAt(text, decl.pos);
  if (m.arm !== undefined) {
    const arm = findArm(decl, m.arm[0], m.arm[1]);
    if (arm === undefined) throw new Error(`${m.file}: ${m.owner} has no arm ${m.arm[0]} '${m.arm[1]}'`);
    holder = arm;
    const member = unionMemberOf(arm);
    enclosing = `${member === undefined ? '' : armComments(text, member)}\n${enclosing}`;
  } else if (ts.isInterfaceDeclaration(decl)) {
    holder = decl;
  } else {
    throw new Error(`${m.file}: ${m.owner} is a type alias; name the arm`);
  }
  const found = holder.members.find(
    (x): x is ts.PropertySignature | ts.MethodSignature =>
      (ts.isPropertySignature(x) || ts.isMethodSignature(x)) && x.name.getText() === m.member,
  );
  if (found === undefined) throw new Error(`${m.file}: ${m.owner} has no member ${m.member}`);
  return { own: commentsAt(text, found.pos), enclosing, optional: found.questionToken !== undefined };
}

const OBM = /optional by meaning/;
const SINCE_P2 = /@since P2\b/;

/** The JSDoc that carries the member's tag: its own, or an enclosing one that names it in back-ticks. */
function tagOf(m: OptionalMember): string {
  const { own, enclosing } = locate(m);
  if (OBM.test(own)) return own;
  return enclosing.includes(`\`${m.member}\``) && OBM.test(enclosing) ? enclosing : own;
}

const label = (m: OptionalMember): string => `${m.file} ${m.owner}${m.arm === undefined ? '' : `[${m.arm[1]}]`}.${m.member}`;

describe('contracts: members optional by meaning (ARCHITECTURE-P2 §2.15, W8)', () => {
  it('lists each member once', () => {
    const keys = MEMBERS.map(label);
    expect(new Set(keys).size).toBe(keys.length);
    expect(MEMBERS).toHaveLength(53);
  });

  describe.each(MEMBERS.map((m) => [label(m), m] as const))('%s', (_name, m) => {
    it('the type accepts an object without it (type-level check, compiled by tsc)', () => {
      expect(m.accepted).toBe(true);
    });

    it('the source keeps its ? and tags it @since P2 (optional by meaning)', () => {
      expect(locate(m).optional).toBe(true);
      const tag = tagOf(m);
      expect(tag, `${label(m)}: JSDoc`).toMatch(OBM);
      expect(tag, `${label(m)}: JSDoc`).toMatch(SINCE_P2);
    });
  });

  it('no @since P2 contract member is optional unless it is listed here (no transition ? survives the gate)', () => {
    const listed = new Set(MEMBERS.map((m) => `${m.file} ${m.owner}.${m.member}`));
    const stray: string[] = [];
    for (const file of readdirSync(CONTRACTS).filter((f) => f.endsWith('.ts')).sort()) {
      const { text, sf } = parse(file);
      const visit = (node: ts.Node, owner: string): void => {
        const at = ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node) ? node.name.text : owner;
        if ((ts.isPropertySignature(node) || ts.isMethodSignature(node)) && node.questionToken !== undefined) {
          const name = `${at}.${node.name.getText()}`;
          if (SINCE_P2.test(commentsAt(text, node.pos)) && !listed.has(`${file} ${name}`)) {
            stray.push(`${file}:${sf.getLineAndCharacterOfPosition(node.getStart()).line + 1} ${name}`);
          }
        }
        ts.forEachChild(node, (c) => visit(c, at));
      };
      visit(sf, '');
    }
    expect(stray).toEqual([]);
  });
});
