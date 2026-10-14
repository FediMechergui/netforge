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
 *
 * The P3a exit gate (ARCHITECTURE-P3 §0 rule 2, §2.15, §7 W8, §9.2 W8 item 45, ruling R61 (e)) adds the P3 rows and
 * checks both lists:
 *
 *  • the P3 members optional by meaning — every engine member of the §2.15 table, with the members the rulings named
 *    (R23, R24, R26, R32, R42, R53, R56, R58 (b), R60, R61 (a)'s `innerProtectedBy`) and the four ruling R62 (a) adds,
 *    which the source already tagged so (`LabCheckResult.misconception`, R18; `LoggerStateView.syslog`, R25;
 *    `PortTxQueueView` frames' `dscp`, R15; the P3 values 'gre' / 'ipsec' of the P2 member `PduSummary.tunnel`, a value
 *    set) — each keeps its `?` and its `@since P3 (optional by meaning)` tag, as a member, a nested member
 *    (`Topology.lab`, a `cut` fault, a class or a frame of a snapshot view), an optional parameter
 *    (`DeviceRuntime.applyConfigLine`'s `origin`, `TransmitFn`'s `opts`), a member of a parameter's inline type
 *    literal (`ConfigAst.apply`'s `opts.seq`, §2.11, D12), a declaration (`TransportProbeView`, the
 *    StateViews' `probes`) or a widened value ('P3' of the two `profile` members the P2 list already holds, and
 *    `PduSummary.tunnel`'s two P3 values);
 *  • the P3 members the gate made required (§2.15 "Members that DO become required", every one implemented, with
 *    §2.9's `CommandCtx.qosCounters` / `.egressQueues`, §2.11's `CliRuntime.onLogEvent` and item 47's
 *    `ProcessCtx.protect`, ruling R62 (b)) — each
 *    has lost its `?` (type level: the type refuses an object without it; source level: no `?`, and the tag is
 *    `@since P3` without "optional by meaning").
 *
 * Two last checks close the P3 set as the P2 one is closed: no contract member whose own JSDoc says `@since P3` is
 * optional without being listed (in either list's optional half, or as one of the two earlier members whose JSDoc
 * names P3 values or members), and every member whose own JSDoc says "@since P3 (optional by meaning" has its `?`. A
 * third closes the members of the parameters' inline type literals, which carry no JSDoc of their own: each optional one
 * is a listed P3 row or one of the earlier members named here, so an inline `?` cannot escape both lists.
 * The web rows (`DropMarker.rule`, `RunToIdleSnapshot.runStopped`) are pinned by the web package
 * (apps/web/test/protocol.optional-by-meaning.test.ts).
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import type { VirtualFamilySpec } from '../src/contracts/catalog.js';
import type { CliRuntime, CliSessionView, CommandCtx, CommandSpec, CliRuntimeDeps, ConfigureOptions } from '../src/contracts/cli.js';
import type { ConfigAst, ConfigLineRule, ConfigNode } from '../src/contracts/config.js';
import type { Course } from '../src/contracts/curriculum.js';
import type { DeviceModel, DeviceRuntime, DeviceSpec, PortResolution } from '../src/contracts/device.js';
import type { SimEventBody } from '../src/contracts/events.js';
import type { FacadeCounters } from '../src/contracts/journal.js';
import type { LinkModel, LinkModelDeps, PolicerSpec, TransmitFn } from '../src/contracts/link.js';
import type { BssSnapshot } from '../src/contracts/medium.js';
import type { PduMeta, RewrapOp } from '../src/contracts/pdu.js';
import type { PortCounters, PortL3, PortSpec, PortState } from '../src/contracts/port.js';
import type { Action, DebugEvent, DemuxSelector, LoggerStateView, ProcessCtx, ProcessRequest } from '../src/contracts/process.js';
import type { RadioPortView, RadioSettings } from '../src/contracts/rf.js';
import type { LabAssertion, LabAssertionNotes, LabCheckResult, LabFault } from '../src/contracts/scenario.js';
import type { SimulationOptions, TraceFilter } from '../src/contracts/simulation.js';
import type { DeviceClockSnapshot, DeviceSnapshot, PortQosView, PortSnapshot, PortTxQueueView, SimSnapshot } from '../src/contracts/snapshot.js';
import type { CamRow, Route6Row, RouteRow } from '../src/contracts/tables.js';
import type { Topology, TopologyDevice } from '../src/contracts/topology.js';
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
  /**
   * P3: the property path from the owner (or its arm) to the type literal that holds the member (`['lab']` for
   * `Topology.lab.pendingFaults`, `['classes']` for an element of `PortQosView.classes`). On a union without a
   * discriminant (`LabFault`), the first step names the property that picks the arm (`['cut']`).
   */
  readonly via?: readonly string[];
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

/** The interface or type alias `owner` of contract `file`; throws with a readable message when it moved. */
function declarationOf(file: string, owner: string): ts.InterfaceDeclaration | ts.TypeAliasDeclaration {
  const decl = parse(file).sf.statements.find(
    (s): s is ts.InterfaceDeclaration | ts.TypeAliasDeclaration =>
      (ts.isInterfaceDeclaration(s) || ts.isTypeAliasDeclaration(s)) && s.name.text === owner,
  );
  if (decl === undefined) throw new Error(`${file}: no declaration ${owner}`);
  return decl;
}

/** The property signature `key` of a type literal or interface, if it has one. */
function propertyOf(holder: ts.InterfaceDeclaration | ts.TypeLiteralNode, key: string): ts.PropertySignature | undefined {
  return holder.members.find((x): x is ts.PropertySignature => ts.isPropertySignature(x) && x.name.getText() === key);
}

/** The type literal a property's type spells, through `readonly`, arrays and parentheses (`readonly { … }[]`). */
function literalIn(type: ts.TypeNode | undefined): ts.TypeLiteralNode | undefined {
  if (type === undefined) return undefined;
  if (ts.isTypeLiteralNode(type)) return type;
  if (ts.isTypeOperatorNode(type) || ts.isParenthesizedTypeNode(type)) return literalIn(type.type);
  if (ts.isArrayTypeNode(type)) return literalIn(type.elementType);
  return undefined;
}

/** The type literal inside `node` that has a property `key` (depth-first): the arm of a union without a discriminant. */
function findArmWith(node: ts.Node, key: string): ts.TypeLiteralNode | undefined {
  if (ts.isTypeLiteralNode(node) && propertyOf(node, key) !== undefined) return node;
  return ts.forEachChild(node, (c) => findArmWith(c, key));
}

/** Find `m` in its contract file; throws with a readable message when the declaration moved or was renamed. */
function locate(m: OptionalMember): Located {
  const { text } = parse(m.file);
  const decl = declarationOf(m.file, m.owner);
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
  } else if (m.via !== undefined && m.via.length > 0) {
    const arm = findArmWith(decl, m.via[0]!);
    if (arm === undefined) throw new Error(`${m.file}: ${m.owner} has no arm with ${m.via[0]}`);
    holder = arm;
    const member = unionMemberOf(arm);
    enclosing = `${member === undefined ? '' : armComments(text, member)}\n${enclosing}`;
  } else {
    throw new Error(`${m.file}: ${m.owner} is a type alias; name the arm`);
  }
  for (const step of m.via ?? []) {
    const prop = propertyOf(holder, step);
    const inner = literalIn(prop?.type);
    if (prop === undefined || inner === undefined) throw new Error(`${m.file}: ${m.owner} has no type literal at ${step}`);
    enclosing = `${commentsAt(text, prop.pos)}\n${enclosing}`;
    holder = inner;
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

const label = (m: OptionalMember): string =>
  `${m.file} ${m.owner}${m.arm === undefined ? '' : `[${m.arm[1]}]`}${m.via === undefined ? '' : `.${m.via.join('.')}`}.${m.member}`;

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

// ── P3a exit gate (ARCHITECTURE-P3 §0 rule 2, §2.15, §7 W8, §9.2 W8 item 45, ruling R61 (e)) ─────────────────────────

/**
 * `true` exactly when `K` may be left out of every member of `T`, `false` as soon as one member requires it. It
 * distributes over a union, so an arm such as `udp.send`'s `{…} & AppPayload` (two members) is checked member by
 * member, and a method counts like a property.
 */
type OptionalIn<T, K extends keyof T> = false extends (T extends unknown ? ({} extends Pick<T, K & keyof T> ? true : false) : never) ? false : true;

/** The first `N` parameter types of a parameter list, as a tuple of `N` required elements. */
type Prefix<P extends readonly unknown[], N extends number, Acc extends unknown[] = []> = Acc['length'] extends N ? Acc : Prefix<P, N, [...Acc, P[Acc['length']]]>;

/** `true` exactly when `F` can be called with its first `N` parameters only, i.e. when its parameter `N` is optional. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the widest function type `Parameters` accepts
type CallableWith<F extends (...args: any[]) => unknown, N extends number> = Prefix<Parameters<F>, N> extends Parameters<F> ? true : false;

/**
 * A P3 contract member of either list. `accepted` is typed `OptionalIn<T, K>`: the optional-by-meaning rows pass `true`
 * (removing the `?` breaks `tsc -p packages/engine/tsconfig.json`), the required rows `false` (putting a `?` back
 * breaks it).
 */
function p3<T, K extends keyof T & string>(
  row: string,
  file: string,
  owner: string,
  member: K,
  accepted: OptionalIn<T, K>,
  where: { readonly arm?: readonly [string, string]; readonly via?: readonly string[] } = {},
): OptionalMember {
  return { row, file, owner, member, accepted, ...(where.arm === undefined ? {} : { arm: where.arm }), ...(where.via === undefined ? {} : { via: where.via }) };
}

type DropAction = Extract<Action, { type: 'drop' }>;
type Ipv4Resume = Extract<ProcessRequest, { kind: 'ipv4.resume' }>;
type NatOutbound = Extract<ProcessRequest, { kind: 'nat.outbound' }>;
type AclFilter = Extract<ProcessRequest, { kind: 'acl.filter' }>;
type TcpListen = Extract<ProcessRequest, { kind: 'tcp.listen' }>;
type TcpConnect = Extract<ProcessRequest, { kind: 'tcp.connect' }>;
type IcmpError = Extract<ProcessRequest, { kind: 'icmp.error' }>;
type UdpSend = Extract<ProcessRequest, { kind: 'udp.send' }>;
type LogEvent = Extract<TraceEvent, { kind: 'log' }>;
type ConfigChangeEvent = Extract<TraceEvent, { kind: 'configChange' }>;
type RouteAssertion = Extract<LabAssertion, { kind: 'route' }>;
type TableAssertion = Extract<LabAssertion, { kind: 'table' }>;
type ConfigAssertion = Extract<LabAssertion, { kind: 'config' }>;
type PathAssertion = Extract<LabAssertion, { kind: 'path' }>;
type CutFault = Extract<LabFault, { cut: unknown }>['cut'];
type TopologyLab = NonNullable<Topology['lab']>;
type QosClass = PortQosView['classes'][number];
type BacklogFrame = PortTxQueueView['frames'][number];

/** The P3 members optional by meaning (§2.15 as ruling R61 (e) extends it), in the table's row order. */
const MEMBERS_P3: readonly OptionalMember[] = [
  // catalog.ts / device.ts
  p3<DeviceModel, 'cdpDefault'>('catalog.ts / device.ts', 'device.ts', 'DeviceModel', 'cdpDefault', true),
  p3<VirtualFamilySpec, 'encap'>('catalog.ts / device.ts [S18]', 'catalog.ts', 'VirtualFamilySpec', 'encap', true),
  // port.ts
  p3<PortCounters, 'aclDenies'>('port.ts', 'port.ts', 'PortCounters', 'aclDenies', true),
  // pdu.ts
  p3<PduMeta, 'protectedBy'>('pdu.ts', 'pdu.ts', 'PduMeta', 'protectedBy', true),
  p3<PduMeta, 'innerProtectedBy'>('pdu.ts [C13] (R58 (a), R61 (a))', 'pdu.ts', 'PduMeta', 'innerProtectedBy', true),
  // process.ts
  p3<DropAction, 'rule'>('process.ts', 'process.ts', 'Action', 'rule', true, { arm: ['type', 'drop'] }),
  p3<Ipv4Resume, 'after'>('process.ts', 'process.ts', 'ProcessRequest', 'after', true, { arm: ['kind', 'ipv4.resume'] }),
  p3<NatOutbound, 'filterOut'>('process.ts', 'process.ts', 'ProcessRequest', 'filterOut', true, { arm: ['kind', 'nat.outbound'] }),
  p3<AclFilter, 'inPort'>('process.ts', 'process.ts', 'ProcessRequest', 'inPort', true, { arm: ['kind', 'acl.filter'] }),
  p3<AclFilter, 'natted'>('process.ts', 'process.ts', 'ProcessRequest', 'natted', true, { arm: ['kind', 'acl.filter'] }),
  p3<TcpListen, 'service'>('process.ts [S13]', 'process.ts', 'ProcessRequest', 'service', true, { arm: ['kind', 'tcp.listen'] }),
  p3<IcmpError, 'param'>('process.ts [S18]', 'process.ts', 'ProcessRequest', 'param', true, { arm: ['kind', 'icmp.error'] }),
  p3<UdpSend, 'dscp'>('process.ts (R24)', 'process.ts', 'ProcessRequest', 'dscp', true, { arm: ['kind', 'udp.send'] }),
  p3<LoggerStateView, 'syslog'>('process.ts [S25] (R25, R62 (a))', 'process.ts', 'LoggerStateView', 'syslog', true),
  // transport.ts (the requests are declared in process.ts)
  p3<TcpListen, 'tls'>('transport.ts', 'process.ts', 'ProcessRequest', 'tls', true, { arm: ['kind', 'tcp.listen'] }),
  p3<TcpConnect, 'tls'>('transport.ts', 'process.ts', 'ProcessRequest', 'tls', true, { arm: ['kind', 'tcp.connect'] }),
  // tables.ts (the StateViews' `probes`: DECLARATIONS_P3 below)
  p3<RouteRow, 'routeType'>('tables.ts', 'tables.ts', 'RouteRow', 'routeType', true),
  // trace.ts
  p3<DropEvent, 'rule'>('trace.ts', 'trace.ts', 'TraceEvent', 'rule', true, { arm: ['kind', 'drop'] }),
  p3<LogEvent, 'mnemonic'>('trace.ts [S24]', 'trace.ts', 'TraceEvent', 'mnemonic', true, { arm: ['kind', 'log'] }),
  p3<ConfigChangeEvent, 'origin'>('trace.ts', 'trace.ts', 'TraceEvent', 'origin', true, { arm: ['kind', 'configChange'] }),
  // snapshot.ts (SimSnapshot.profile's 'P3' value: P3_WIDENED below)
  p3<DeviceSnapshot, 'clock'>('snapshot.ts', 'snapshot.ts', 'DeviceSnapshot', 'clock', true),
  p3<PortSnapshot, 'qos'>('snapshot.ts', 'snapshot.ts', 'PortSnapshot', 'qos', true),
  p3<PortSnapshot, 'txBacklog'>('snapshot.ts', 'snapshot.ts', 'PortSnapshot', 'txBacklog', true),
  p3<DeviceSnapshot, 'storage'>('snapshot.ts [S32]', 'snapshot.ts', 'DeviceSnapshot', 'storage', true),
  p3<PortQosView, 'queue'>('snapshot.ts [S20] (R32)', 'snapshot.ts', 'PortQosView', 'queue', true),
  p3<QosClass, 'police'>('snapshot.ts [S21] (R26)', 'snapshot.ts', 'PortQosView', 'police', true, { via: ['classes'] }),
  p3<DeviceClockSnapshot, 'tzName'>('snapshot.ts (R42)', 'snapshot.ts', 'DeviceClockSnapshot', 'tzName', true),
  p3<BacklogFrame, 'dscp'>('snapshot.ts (R15, R62 (a))', 'snapshot.ts', 'PortTxQueueView', 'dscp', true, { via: ['frames'] }),
  // device.ts (the `origin` parameter of applyConfigLine: PARAMS_P3 below)
  p3<DeviceRuntime, 'files'>('device.ts [S32] (R23)', 'device.ts', 'DeviceRuntime', 'files', true),
  p3<DeviceRuntime, 'readFile'>('device.ts [S32] (R23)', 'device.ts', 'DeviceRuntime', 'readFile', true),
  p3<DeviceRuntime, 'configSession'>('device.ts [S25] (R53)', 'device.ts', 'DeviceRuntime', 'configSession', true),
  // topology.ts (Topology.profile's 'P3' value: P3_WIDENED below)
  p3<TopologyDevice, 'files'>('topology.ts [S32]', 'topology.ts', 'TopologyDevice', 'files', true),
  p3<TopologyLab, 'pendingFaults'>('topology.ts [S37] (R58 (b))', 'topology.ts', 'Topology', 'pendingFaults', true, { via: ['lab'] }),
  p3<TopologyLab, 'errDisabled'>('topology.ts [S37] (R58 (b))', 'topology.ts', 'Topology', 'errDisabled', true, { via: ['lab'] }),
  // cli.ts / config.ts (ConfigAst.apply's `opts.seq`: PARAM_MEMBERS_P3 below)
  p3<ConfigNode, 'seq'>('cli.ts / config.ts', 'config.ts', 'ConfigNode', 'seq', true),
  p3<ConfigLineRule, 'sequenced'>('cli.ts / config.ts', 'config.ts', 'ConfigLineRule', 'sequenced', true),
  p3<ConfigureOptions, 'origin'>('cli.ts / config.ts', 'cli.ts', 'ConfigureOptions', 'origin', true),
  p3<CliSessionView, 'monitor'>('cli.ts / config.ts [S25]', 'cli.ts', 'CliSessionView', 'monitor', true),
  p3<CliSessionView, 'remote'>('cli.ts / config.ts [S13]', 'cli.ts', 'CliSessionView', 'remote', true),
  p3<CliRuntimeDeps, 'egressQueues'>('cli.ts / config.ts [S20] (R32)', 'cli.ts', 'CliRuntimeDeps', 'egressQueues', true),
  p3<CommandCtx, 'profile'>('cli.ts / config.ts', 'cli.ts', 'CommandCtx', 'profile', true),
  p3<CommandCtx, 'setMonitor'>('cli.ts / config.ts [S25]', 'cli.ts', 'CommandCtx', 'setMonitor', true),
  p3<CommandCtx, 'files'>('cli.ts / config.ts [S32] (R23)', 'cli.ts', 'CommandCtx', 'files', true),
  p3<CommandCtx, 'readFile'>('cli.ts / config.ts [S32] (R23)', 'cli.ts', 'CommandCtx', 'readFile', true),
  p3<CommandSpec, 'requiresAnyProcess'>('cli.ts / config.ts [S32] (R60)', 'cli.ts', 'CommandSpec', 'requiresAnyProcess', true),
  // journal.ts (R62 (c): the row of the file that declares it)
  p3<FacadeCounters, 'remote'>('journal.ts [S13] (R62 (c))', 'journal.ts', 'FacadeCounters', 'remote', true),
  // scenario.ts
  p3<LabAssertionNotes, 'feedback'>('scenario.ts', 'scenario.ts', 'LabAssertionNotes', 'feedback', true),
  p3<LabAssertionNotes, 'misconception'>('scenario.ts', 'scenario.ts', 'LabAssertionNotes', 'misconception', true),
  p3<LabCheckResult, 'misconception'>('scenario.ts (R18, R62 (a))', 'scenario.ts', 'LabCheckResult', 'misconception', true),
  p3<Connectivity, 'proto'>('scenario.ts', 'scenario.ts', 'LabAssertion', 'proto', true, { arm: ['kind', 'connectivity'] }),
  p3<Connectivity, 'port'>('scenario.ts', 'scenario.ts', 'LabAssertion', 'port', true, { arm: ['kind', 'connectivity'] }),
  p3<Connectivity, 'toIface'>('scenario.ts', 'scenario.ts', 'LabAssertion', 'toIface', true, { arm: ['kind', 'connectivity'] }),
  p3<Connectivity, 'toAddress'>('scenario.ts', 'scenario.ts', 'LabAssertion', 'toAddress', true, { arm: ['kind', 'connectivity'] }),
  p3<Connectivity, 'source'>('scenario.ts', 'scenario.ts', 'LabAssertion', 'source', true, { arm: ['kind', 'connectivity'] }),
  p3<Connectivity, 'droppedAt'>('scenario.ts', 'scenario.ts', 'LabAssertion', 'droppedAt', true, { arm: ['kind', 'connectivity'] }),
  p3<Connectivity, 'dropReason'>('scenario.ts', 'scenario.ts', 'LabAssertion', 'dropReason', true, { arm: ['kind', 'connectivity'] }),
  p3<RouteAssertion, 'metric'>('scenario.ts', 'scenario.ts', 'LabAssertion', 'metric', true, { arm: ['kind', 'route'] }),
  p3<RouteAssertion, 'routeType'>('scenario.ts', 'scenario.ts', 'LabAssertion', 'routeType', true, { arm: ['kind', 'route'] }),
  p3<RouteAssertion, 'minPaths'>('scenario.ts', 'scenario.ts', 'LabAssertion', 'minPaths', true, { arm: ['kind', 'route'] }),
  p3<TableAssertion, 'minCount'>('scenario.ts', 'scenario.ts', 'LabAssertion', 'minCount', true, { arm: ['kind', 'table'] }),
  p3<TableAssertion, 'maxCount'>('scenario.ts', 'scenario.ts', 'LabAssertion', 'maxCount', true, { arm: ['kind', 'table'] }),
  p3<TableAssertion, 'whereOps'>('scenario.ts', 'scenario.ts', 'LabAssertion', 'whereOps', true, { arm: ['kind', 'table'] }),
  p3<CutFault, 'aPort'>('scenario.ts', 'scenario.ts', 'LabFault', 'aPort', true, { via: ['cut'] }),
  p3<CutFault, 'bPort'>('scenario.ts', 'scenario.ts', 'LabFault', 'bPort', true, { via: ['cut'] }),
  p3<PathAssertion, 'tunnelAt'>('scenario.ts [C13]', 'scenario.ts', 'LabAssertion', 'tunnelAt', true, { arm: ['kind', 'path'] }),
  p3<ConfigAssertion, 'count'>('scenario.ts (R56)', 'scenario.ts', 'LabAssertion', 'count', true, { arm: ['kind', 'config'] }),
  // link.ts (TransmitOptions, the `opts` parameter of TransmitFn: PARAMS_P3 below)
  p3<LinkModelDeps, 'egressPolicy'>('link.ts [S20]', 'link.ts', 'LinkModelDeps', 'egressPolicy', true),
  p3<LinkModel, 'egressQueues'>('link.ts [S20]', 'link.ts', 'LinkModel', 'egressQueues', true),
  p3<PolicerSpec, 'conform'>('link.ts [S21] (R26)', 'link.ts', 'PolicerSpec', 'conform', true),
  p3<PolicerSpec, 'exceed'>('link.ts [S21] (R26)', 'link.ts', 'PolicerSpec', 'exceed', true),
];

/** One optional-by-meaning parameter: `param` of method `method` of `owner` (or of the function type `owner`). */
interface OptionalParam {
  readonly row: string;
  readonly file: string;
  readonly owner: string;
  /** Absent when `owner` is a function type alias. */
  readonly method?: string;
  readonly param: string;
  /** `CallableWith<F, index>`: compiles as `true` only while the parameter is optional. */
  readonly accepted: boolean;
}

const ORIGIN_PARAM_OPTIONAL: CallableWith<DeviceRuntime['applyConfigLine'], 3> = true;
const OPTS_PARAM_OPTIONAL: CallableWith<TransmitFn, 3> = true;

const PARAMS_P3: readonly OptionalParam[] = [
  { row: 'device.ts', file: 'device.ts', owner: 'DeviceRuntime', method: 'applyConfigLine', param: 'origin', accepted: ORIGIN_PARAM_OPTIONAL },
  { row: 'link.ts [S20] TransmitOptions', file: 'link.ts', owner: 'TransmitFn', param: 'opts', accepted: OPTS_PARAM_OPTIONAL },
];

/**
 * One optional-by-meaning member of a parameter's inline type literal: `member` of parameter `param` of method `method`
 * of `owner`. It has no JSDoc of its own: the method's JSDoc tags it, naming it `` `param.member` `` on the tag line.
 */
interface OptionalParamMember {
  readonly row: string;
  readonly file: string;
  readonly owner: string;
  readonly method: string;
  readonly param: string;
  readonly member: string;
  /** `OptionalIn<the parameter's type, member>`: compiles as `true` only while the member is optional. */
  readonly accepted: boolean;
}

const APPLY_SEQ_OPTIONAL: OptionalIn<NonNullable<Parameters<ConfigAst['apply']>[3]>, 'seq'> = true;

const PARAM_MEMBERS_P3: readonly OptionalParamMember[] = [
  { row: 'cli.ts / config.ts (§2.11, D12)', file: 'config.ts', owner: 'ConfigAst', method: 'apply', param: 'opts', member: 'seq', accepted: APPLY_SEQ_OPTIONAL },
];

/**
 * The optional members of the parameters' inline type literals introduced before P3: neither P3 list holds them. With
 * PARAM_MEMBERS_P3 they are every such member of the contracts (the closure check below).
 */
const EARLIER_PARAM_MEMBERS: readonly { readonly key: string; readonly why: string }[] = [
  { key: 'config.ts ConfigAst.apply(opts).defaults', why: 'P2 (ARCHITECTURE-P2 §5): absent = plain set / unset' },
  { key: 'link.ts LinkModel.injectNoise(spec).band', why: 'P1 noise fault hook' },
  { key: 'link.ts LinkModel.injectNoise(spec).channel', why: 'P1 noise fault hook' },
  { key: 'link.ts LinkModel.injectNoise(spec).center', why: 'P1 noise fault hook' },
  { key: 'link.ts LinkModel.injectNoise(spec).radiusM', why: 'P1 noise fault hook' },
  { key: 'pdu.ts StandaloneDecodeFn(opts).fcsLen', why: 'P1 registry-only decode' },
  { key: 'simulation.ts Simulation.stepToNext(opts).maxEvents', why: 'P1 step to the next matching event' },
  { key: 'simulation.ts Simulation.stepToNext(opts).until', why: 'P1 step to the next matching event' },
];

/** The closure key of a parameter member: `file Owner.method(param).member` (`file Fn(param).member` for a function type). */
const paramMemberKey = (p: OptionalParamMember): string => `${p.file} ${p.owner}.${p.method}(${p.param}).${p.member}`;

/** Optional-by-meaning P3 data with no member of its own in a contract type: the declaration's JSDoc names it. */
const DECLARATIONS_P3: readonly { readonly row: string; readonly file: string; readonly owner: string; readonly names: string }[] = [
  // the tcp and udp StateViews are untyped (`StateView.state`); the contract declares the entries of their `probes`
  { row: 'StateViews', file: 'tables.ts', owner: 'TransportProbeView', names: 'probes' },
];

/** 'P3' values of members the P2 list already holds: the type takes the value (each line compiles only while it does). */
const SNAPSHOT_P3: NonNullable<SimSnapshot['profile']> = 'P3';
const TOPOLOGY_P3: NonNullable<Topology['profile']> = 'P3';

/** The same members' JSDoc tags the value. */
const P3_WIDENED: readonly { readonly row: string; readonly file: string; readonly owner: string; readonly member: string; readonly value: string }[] = [
  { row: 'snapshot.ts', file: 'snapshot.ts', owner: 'SimSnapshot', member: 'profile', value: SNAPSHOT_P3 },
  { row: 'topology.ts', file: 'topology.ts', owner: 'Topology', member: 'profile', value: TOPOLOGY_P3 },
];

/**
 * Ruling R62 (a): the P3 values of the P2 member `PduSummary.tunnel` (a value set, not a new member; the member itself
 * is a P2 row above): [S18] 'gre' and [C13] 'ipsec'. Each line compiles only while the type takes the value.
 */
const TUNNEL_GRE: NonNullable<PduSummary['tunnel']> = 'gre';
const TUNNEL_IPSEC: NonNullable<PduSummary['tunnel']> = 'ipsec';

/** The member keeps its `?` and its optional-by-meaning tag, and its JSDoc tags each value `@since P3`. */
const P3_VALUES: readonly { readonly row: string; readonly file: string; readonly owner: string; readonly member: string; readonly values: readonly string[] }[] = [
  { row: 'trace.ts (R62 (a))', file: 'trace.ts', owner: 'PduSummary', member: 'tunnel', values: [TUNNEL_GRE, TUNNEL_IPSEC] },
];

/** The P3 members the exit gate made required (§2.15 "Members that DO become required"): every one is implemented. */
const REQUIRED_P3: readonly OptionalMember[] = [
  p3<ProcessCtx, 'clock'>('process.ts (W1)', 'process.ts', 'ProcessCtx', 'clock', false),
  p3<ProcessCtx, 'files'>('process.ts [S32] (W1)', 'process.ts', 'ProcessCtx', 'files', false),
  p3<ProcessCtx, 'readFile'>('process.ts [S32] (W1)', 'process.ts', 'ProcessCtx', 'readFile', false),
  p3<ProcessCtx, 'protect'>('process.ts [C13] (W8 item 47)', 'process.ts', 'ProcessCtx', 'protect', false),
  p3<CommandCtx, 'clock'>('cli.ts (W1)', 'cli.ts', 'CommandCtx', 'clock', false),
  p3<CommandCtx, 'qosCounters'>('cli.ts (W8)', 'cli.ts', 'CommandCtx', 'qosCounters', false),
  p3<CommandCtx, 'egressQueues'>('cli.ts [S20] (W8)', 'cli.ts', 'CommandCtx', 'egressQueues', false),
  p3<DeviceRuntime, 'clockView'>('device.ts (W1)', 'device.ts', 'DeviceRuntime', 'clockView', false),
  p3<DeviceRuntime, 'setClock'>('device.ts (W1)', 'device.ts', 'DeviceRuntime', 'setClock', false),
  p3<DeviceRuntime, 'qosCounters'>('device.ts (W3)', 'device.ts', 'DeviceRuntime', 'qosCounters', false),
  p3<DeviceRuntime, 'emitLog'>('device.ts [S24] (W1)', 'device.ts', 'DeviceRuntime', 'emitLog', false),
  p3<DeviceRuntime, 'egressPolicy'>('device.ts [S20] (W3)', 'device.ts', 'DeviceRuntime', 'egressPolicy', false),
  p3<Course, 'profile'>('curriculum.ts (W8 item 45)', 'curriculum.ts', 'Course', 'profile', false),
  p3<CliRuntime, 'onLogEvent'>('cli.ts [S24] (W8)', 'cli.ts', 'CliRuntime', 'onLogEvent', false),
  p3<CliRuntime, 'openRemote'>('cli.ts [S13] (W8)', 'cli.ts', 'CliRuntime', 'openRemote', false),
  p3<CliRuntime, 'execRemote'>('cli.ts [S13] (W8)', 'cli.ts', 'CliRuntime', 'execRemote', false),
  p3<CliRuntime, 'closeRemote'>('cli.ts [S13] (W8)', 'cli.ts', 'CliRuntime', 'closeRemote', false),
  p3<CliRuntime, 'setRemote'>('cli.ts [S13] (W8)', 'cli.ts', 'CliRuntime', 'setRemote', false),
];

/**
 * Members introduced before P3 whose own JSDoc says `@since P3` about something else: optional by design since then,
 * so neither list holds them.
 */
const EARLIER_WITH_P3_NOTE: readonly { readonly key: string; readonly why: string }[] = [
  { key: 'scenario.ts ScenarioMeta.concept', why: 'a P1 member; its note says the union became ConceptToolId (D24)' },
  { key: 'topology.ts Topology.lab', why: 'a P1 member; its note names the two optional-by-meaning members inside it (R58 (b))' },
];

const SINCE_P3 = /@since P3\b/;
const OBM_P3 = /@since P3\b[^\n]*\(optional by meaning/;

/** The JSDoc block right before `pos` (the last leading `/**` comment), without the section rules above it. */
function jsDocAt(text: string, pos: number): string {
  const docs = (ts.getLeadingCommentRanges(text, pos) ?? []).filter((r) => text.startsWith('/**', r.pos));
  const last = docs[docs.length - 1];
  return last === undefined ? '' : text.slice(last.pos, last.end);
}

/** The parameter `p.param` of its method or function type, and the JSDoc that tags it. */
function locateParam(p: OptionalParam): { readonly optional: boolean; readonly doc: string } {
  const { text } = parse(p.file);
  const decl = declarationOf(p.file, p.owner);
  let params: ts.NodeArray<ts.ParameterDeclaration>;
  let doc: string;
  if (p.method !== undefined) {
    if (!ts.isInterfaceDeclaration(decl)) throw new Error(`${p.file}: ${p.owner} is not an interface`);
    const m = decl.members.find((x): x is ts.MethodSignature => ts.isMethodSignature(x) && x.name.getText() === p.method);
    if (m === undefined) throw new Error(`${p.file}: ${p.owner} has no method ${p.method}`);
    params = m.parameters;
    doc = commentsAt(text, m.pos);
  } else {
    if (!ts.isTypeAliasDeclaration(decl) || !ts.isFunctionTypeNode(decl.type)) throw new Error(`${p.file}: ${p.owner} is not a function type`);
    params = decl.type.parameters;
    doc = commentsAt(text, decl.pos);
  }
  const param = params.find((x) => x.name.getText() === p.param);
  if (param === undefined) throw new Error(`${p.file}: ${p.owner} has no parameter ${p.param}`);
  return { optional: param.questionToken !== undefined, doc };
}

/** The member `p.member` of the inline type literal of parameter `p.param`, and the method's JSDoc block. */
function locateParamMember(p: OptionalParamMember): { readonly optional: boolean; readonly doc: string } {
  const { text } = parse(p.file);
  const decl = declarationOf(p.file, p.owner);
  if (!ts.isInterfaceDeclaration(decl)) throw new Error(`${p.file}: ${p.owner} is not an interface`);
  const m = decl.members.find((x): x is ts.MethodSignature => ts.isMethodSignature(x) && x.name.getText() === p.method);
  if (m === undefined) throw new Error(`${p.file}: ${p.owner} has no method ${p.method}`);
  const param = m.parameters.find((x) => x.name.getText() === p.param);
  const literal = literalIn(param?.type);
  if (literal === undefined) throw new Error(`${p.file}: ${p.owner}.${p.method} has no type literal at parameter ${p.param}`);
  const member = propertyOf(literal, p.member);
  if (member === undefined) throw new Error(`${p.file}: ${p.owner}.${p.method}(${p.param}) has no member ${p.member}`);
  return { optional: member.questionToken !== undefined, doc: jsDocAt(text, m.pos) };
}

/**
 * Every optional member of a parameter's inline type literal in the contracts (a method's, a function property's or a
 * function type's), by `file Owner.method(param).member`, with its line. A nested parameter is visited on its own.
 */
function paramLiteralMembers(): Map<string, number> {
  const out = new Map<string, number>();
  for (const file of readdirSync(CONTRACTS).filter((f) => f.endsWith('.ts')).sort()) {
    const { sf } = parse(file);
    const visit = (node: ts.Node, owner: string): void => {
      const at = ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node) ? node.name.text : owner;
      if (ts.isParameter(node) && node.type !== undefined) {
        const sig = node.parent;
        const holder = ts.isMethodSignature(sig)
          ? `.${sig.name.getText()}`
          : ts.isFunctionTypeNode(sig) && ts.isPropertySignature(sig.parent)
            ? `.${sig.parent.name.getText()}`
            : '';
        const walk = (n: ts.Node): void => {
          if (ts.isParameter(n)) return;
          if ((ts.isPropertySignature(n) || ts.isMethodSignature(n)) && n.questionToken !== undefined) {
            out.set(`${file} ${at}${holder}(${node.name.getText()}).${n.name.getText()}`, sf.getLineAndCharacterOfPosition(n.getStart()).line + 1);
          }
          ts.forEachChild(n, walk);
        };
        walk(node.type);
      }
      ts.forEachChild(node, (c) => visit(c, at));
    };
    visit(sf, '');
  }
  return out;
}

interface TaggedMember {
  readonly optional: boolean;
  readonly doc: string;
  readonly line: number;
}

/** Every contract member whose own JSDoc block says `@since P3`, optional or not, by `file Owner.member`. */
function p3TaggedMembers(): Map<string, TaggedMember> {
  const out = new Map<string, TaggedMember>();
  for (const file of readdirSync(CONTRACTS).filter((f) => f.endsWith('.ts')).sort()) {
    const { text, sf } = parse(file);
    const visit = (node: ts.Node, owner: string): void => {
      const at = ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node) ? node.name.text : owner;
      if (ts.isPropertySignature(node) || ts.isMethodSignature(node)) {
        const doc = jsDocAt(text, node.pos);
        if (SINCE_P3.test(doc)) {
          const line = sf.getLineAndCharacterOfPosition(node.getStart()).line + 1;
          out.set(`${file} ${at}.${node.name.getText()}`, { optional: node.questionToken !== undefined, doc, line });
        }
      }
      ts.forEachChild(node, (c) => visit(c, at));
    };
    visit(sf, '');
  }
  return out;
}

/** The stray-check key of a row: the file, the declaration that holds it and the member (as the P2 check keys). */
const keyOf = (m: OptionalMember): string => `${m.file} ${m.owner}.${m.member}`;

describe('contracts: P3 members optional by meaning (ARCHITECTURE-P3 §2.15, ruling R61 (e), W8 item 45)', () => {
  it('lists each member once, apart from the P2 list', () => {
    const labels = MEMBERS_P3.map(label);
    expect(new Set(labels).size).toBe(labels.length);
    expect(MEMBERS_P3).toHaveLength(70);
    const p2 = new Set(MEMBERS.map(label));
    expect(labels.filter((l) => p2.has(l))).toEqual([]);
  });

  describe.each(MEMBERS_P3.map((m) => [label(m), m] as const))('%s', (_name, m) => {
    it('the type accepts an object without it (type-level check, compiled by tsc)', () => {
      expect(m.accepted).toBe(true);
    });

    it('the source keeps its ? and tags it @since P3 (optional by meaning)', () => {
      expect(locate(m).optional).toBe(true);
      const tag = tagOf(m);
      expect(tag, `${label(m)}: JSDoc`).toMatch(OBM);
      expect(tag, `${label(m)}: JSDoc`).toMatch(SINCE_P3);
    });
  });

  it.each(PARAMS_P3.map((p) => [`${p.file} ${p.owner}${p.method === undefined ? '' : `.${p.method}`}(${p.param}?)`, p] as const))(
    '%s: the call type-checks without it, the parameter keeps its ? and the JSDoc tags it',
    (_name, p) => {
      expect(p.accepted).toBe(true);
      const { optional, doc } = locateParam(p);
      expect(optional).toBe(true);
      expect(doc).toContain(`\`${p.param}\``);
      expect(doc).toMatch(OBM_P3);
    },
  );

  it.each(PARAM_MEMBERS_P3.map((p) => [paramMemberKey(p), p] as const))(
    '%s: the parameter type accepts an argument without it, the member keeps its ? and the method JSDoc tags it',
    (_name, p) => {
      expect(p.accepted).toBe(true);
      const { optional, doc } = locateParamMember(p);
      expect(optional).toBe(true);
      expect(doc).toMatch(new RegExp(`@since P3 \\(optional by meaning\\)[^\\n]*\`${p.param}\\.${p.member}\``));
    },
  );

  it('every optional member of a parameter\'s inline type literal is a listed P3 row or an earlier member (an inline ? cannot escape both lists)', () => {
    expect(PARAM_MEMBERS_P3).toHaveLength(1);
    expect(EARLIER_PARAM_MEMBERS).toHaveLength(8);
    const listed = [...PARAM_MEMBERS_P3.map(paramMemberKey), ...EARLIER_PARAM_MEMBERS.map((e) => e.key)];
    expect(new Set(listed).size).toBe(listed.length);
    const found = paramLiteralMembers();
    expect([...found].filter(([k]) => !listed.includes(k)).map(([k, line]) => `${k} (line ${line})`)).toEqual([]);
    expect(listed.filter((k) => !found.has(k))).toEqual([]);
  });

  it.each(DECLARATIONS_P3.map((d) => [`${d.file} ${d.owner} (${d.names})`, d] as const))(
    '%s: the declaration is tagged @since P3 (optional by meaning) and names the member',
    (_name, d) => {
      const doc = commentsAt(parse(d.file).text, declarationOf(d.file, d.owner).pos);
      expect(doc).toContain(`\`${d.names}\``);
      expect(doc).toMatch(OBM_P3);
    },
  );

  it.each(P3_WIDENED.map((w) => [`${w.file} ${w.owner}.${w.member} '${w.value}'`, w] as const))(
    '%s: the P2 member takes the value (type level) and its JSDoc tags it @since P3 (optional by meaning)',
    (_name, w) => {
      expect(w.value).toBe('P3');
      const { own, optional } = locate({ row: w.row, file: w.file, owner: w.owner, member: w.member, accepted: true });
      expect(optional).toBe(true);
      expect(own).toMatch(new RegExp(`'${w.value}' @since P3 \\(optional by meaning`));
    },
  );

  it.each(P3_VALUES.map((v) => [`${v.file} ${v.owner}.${v.member} ${v.values.map((x) => `'${x}'`).join(' / ')}`, v] as const))(
    '%s: the P2 member takes each P3 value (type level), keeps its ? and its optional-by-meaning tag, and tags each value @since P3',
    (_name, v) => {
      expect(v.values).toEqual(['gre', 'ipsec']);
      const { own, optional } = locate({ row: v.row, file: v.file, owner: v.owner, member: v.member, accepted: true });
      expect(optional).toBe(true);
      expect(own).toMatch(OBM);
      for (const value of v.values) expect(own).toMatch(new RegExp(`'${value}' @since P3\\b`));
    },
  );
});

describe('contracts: P3 members the exit gate made required (ARCHITECTURE-P3 §2.15, ruling R61 (e), W8 item 45)', () => {
  it('lists each member once, and none of them is optional by meaning', () => {
    const labels = REQUIRED_P3.map(label);
    expect(new Set(labels).size).toBe(labels.length);
    expect(REQUIRED_P3).toHaveLength(18);
    const obm = new Set(MEMBERS_P3.map(label));
    expect(labels.filter((l) => obm.has(l))).toEqual([]);
  });

  describe.each(REQUIRED_P3.map((m) => [label(m), m] as const))('%s', (_name, m) => {
    it('the type refuses an object without it (type-level check, compiled by tsc)', () => {
      expect(m.accepted).toBe(false);
    });

    it('the source has no ? and its JSDoc tags it @since P3, not optional by meaning', () => {
      expect(locate(m).optional).toBe(false);
      const doc = p3TaggedMembers().get(keyOf(m))?.doc;
      expect(doc, `${label(m)}: JSDoc`).toMatch(SINCE_P3);
      expect(doc, `${label(m)}: JSDoc`).not.toMatch(OBM);
    });
  });

  it('no @since P3 contract member is optional unless it is listed (no transition ? survives the gate)', () => {
    const listed = new Set([...MEMBERS, ...MEMBERS_P3].map(keyOf));
    const earlier = new Set(EARLIER_WITH_P3_NOTE.map((e) => e.key));
    const stray: string[] = [];
    for (const [k, v] of p3TaggedMembers()) {
      if (v.optional && !listed.has(k) && !earlier.has(k)) stray.push(`${k} (line ${v.line})`);
    }
    expect(stray).toEqual([]);
  });

  it('the earlier members with a P3 note are where they were, and still optional', () => {
    const tagged = p3TaggedMembers();
    for (const e of EARLIER_WITH_P3_NOTE) expect(tagged.get(e.key)?.optional, `${e.key}: ${e.why}`).toBe(true);
  });

  it('every member whose own JSDoc says "@since P3 (optional by meaning" keeps its ? (a method tagging a parameter aside)', () => {
    const paramHolders = new Set([
      ...PARAMS_P3.flatMap((p) => (p.method === undefined ? [] : [`${p.file} ${p.owner}.${p.method}`])),
      ...PARAM_MEMBERS_P3.map((p) => `${p.file} ${p.owner}.${p.method}`),
    ]);
    const lost = [...p3TaggedMembers()]
      .filter(([k, v]) => OBM_P3.test(v.doc) && !v.optional && !paramHolders.has(k))
      .map(([k, v]) => `${k} (line ${v.line})`);
    expect(lost).toEqual([]);
  });
});
