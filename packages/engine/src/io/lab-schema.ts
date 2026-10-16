/**
 * io/lab-schema.ts — the zod schema of a lab document (ARCHITECTURE-P3 D6 [S37], §2.13; §7 W5 io).
 *
 * A `LabDocument` (format `netforge.lab/1`, contracts/lab-document.ts) is a lab as data: every built-in lab becomes
 * one through `labDocumentOf`, and P3b's studio and assessment engine write and read them. Like a topology file, a
 * document is untrusted input, and this module is the gate through which JSON becomes a typed `LabDocument`:
 *
 *   • structure — the document, its metadata, its tasks and every assertion kind of §2.10 with each of its members.
 *     Closed vocabularies (assertion kinds, facts, neighbour protocols, drop reasons, trace kinds, state machines,
 *     fault kinds, counters …) are written here as records checked against the contract unions, so the compiler fails
 *     when a union gains a member this file does not list, and the type checks at the end of the builder fail when a
 *     contract object gains or loses a member. Objects are strict: a misspelt member is refused (`unknown keys:
 *     equal`), never silently dropped. The topology is read by the topology schema (io/schema.ts) with its own rules.
 *   • references — task ids are unique and `dependsOn` names another task of the document; every device an
 *     assertion, a grader fault (`LabFault`) or the solution names by NAME is a device of the topology, and device
 *     names are unique; a scheduled fault's target and a trace filter name devices (and links) by ID; a follow-up
 *     check (`connectivity.then`) is never a connectivity, service, path or traffic check (the grader fails each: it
 *     reads state in the same clone, it cannot ping again, log in, probe a path or start traffic). An identity text (`neighbor.neighbor`, a fact's `equals`) may be an address too and is not checked.
 *
 * Failures are readable, path-qualified lines (`tasks[1].assertions[0].device: unknown device "R9"`) formatted by
 * io/schema.ts's `formatIssue`. The `MAX_LAB_*` limits bound what a hostile document can make the engine hold.
 *
 * @since P3 W7 (ruling R58 (b)) `parseSavedLabState` checks the lab state a save of a P3 world records for headless
 * grading (`Topology.lab.pendingFaults`, `Topology.lab.errDisabled`), with this file's scheduled-fault schema, before
 * sim/grade.ts replays it.
 *
 * @since P3c (ARCHITECTURE-P3C D2; W1a io, a reviewed edit) A lab document's `topology` may be a
 * `netforge.topology/1.4` document ([S29] flash files, [S30] image sizes, [S31] the configuration register): the
 * topology schema reads every id of `TOPOLOGY_SCHEMA_IDS` with its own field set, and keeps the document's id (no
 * migration), so a 1.1–1.3 topology inside a lab document reads exactly as before.
 *
 * ponytail: §0 rule 12 — the schema is built on first use (`labDocumentSchema` is a lazy zod schema over a memoised
 * builder), so nothing here reads another module at module scope.
 */
import { z } from 'zod';
import type { FaultKind } from '../contracts/events.js';
import type { LabDocument } from '../contracts/lab-document.js';
import type { DropReason, MediaType } from '../contracts/link.js';
import type { ErrDisableCause, PortCounters, SwitchportMode } from '../contracts/port.js';
import type { FsmMachine, TrafficFlowSpec } from '../contracts/process.js';
import type { RfBand } from '../contracts/rf.js';
import type { ConceptToolId, LabAssertion, LabFactName, LabFault, LabTask, NeighborProtocol } from '../contracts/scenario.js';
import type { TraceFilter } from '../contracts/simulation.js';
import type { HsrpRow, PortSecurityRow, StpRole, StpState } from '../contracts/tables.js';
import type { Topology, TopologyErrDisabledPort, TopologyPendingFault } from '../contracts/topology.js';
import type { TraceKind } from '../contracts/trace.js';
import type { ConvergenceProtocol } from '../contracts/timeline.js';
import { MAX_ID_CHARS, MAX_LAB_NAME_CHARS, MAX_LAB_VERSION, MEDIA_TYPES, formatIssues, topologyLoadError, topologySchema } from './schema.js';

// ── format and limits ─────────────────────────────────────────────────────

/** The `format` every lab document carries. */
export const LAB_DOCUMENT_FORMAT: LabDocument['format'] = 'netforge.lab/1';

/** Maximum number of tasks in one document. */
export const MAX_LAB_TASKS = 100;
/** Maximum number of assertions in one task (and of follow-up checks in one `connectivity.then`). */
export const MAX_LAB_ASSERTIONS = 200;
/** Maximum number of scheduled faults. */
export const MAX_LAB_FAULTS = 100;
/** Maximum number of entries in any other list (allowed VLANs, ACL entries, one device's solution lines, flows …). */
export const MAX_LAB_LIST_ITEMS = 4096;
/** Maximum length of a long text: the instructions, a task's description, hint and feedback, an assertion's feedback. */
export const MAX_LAB_TEXT_CHARS = 64 * 1024;
/** Maximum length of every other string (a title, a config path, a compared value, one solution line …). */
export const MAX_LAB_LINE_CHARS = 1024;
/** Largest number of points one task may carry. */
export const MAX_LAB_TASK_POINTS = 1000;
/** Deepest nesting of a fault's `params` (JSON data, nested lists and objects). */
export const MAX_LAB_PARAMS_DEPTH = 16;

/** Number of issues quoted in the message of the Error thrown by `parseLabDocument`. */
const ISSUES_IN_MESSAGE = 5;

// ── closed vocabularies (each record is exhaustive over its contract union) ─

type Kind = LabAssertion['kind'];
/** The assertion of kind K, notes included. */
type Of<K extends Kind> = Extract<LabAssertion, { kind: K }>;
/** One member of the assertion of kind K, without `undefined`. */
type Member<K extends Kind, M extends keyof Of<K>> = NonNullable<Of<K>[M]>;

// P3c (ARCHITECTURE-P3C §2.10, §9.2 W0 item 1): the concept tools [S22] 'wan', [S28] 'yang', [C26] 'sdn' and the
// neighbour protocol [S6] 'ospfv3' (W0 compile stubs; their views and adapters land with their items).
const CONCEPT_TOOLS: Record<ConceptToolId, true> = {
  subnetting: true,
  ipv6: true,
  queueing: true,
  'data-formats': true,
  wildcard: true,
  wan: true,
  yang: true,
  sdn: true,
};

const NEIGHBOR_PROTOCOLS: Record<NeighborProtocol, true> = { ospf: true, cdp: true, lldp: true, ppp: true, eigrp: true, ospfv3: true };

const FACT_NAMES: Record<LabFactName, true> = {
  'ospf.routerId': true,
  'ospf.referenceBandwidthMbps': true,
  'ospf.defaultOriginate': true,
  'ospf.ifaceArea': true,
  'ospf.ifaceCost': true,
  'ospf.ifaceNetworkType': true,
  'ospf.ifaceState': true,
  'ospf.ifacePriority': true,
  'ospf.passive': true,
  'ospf.lsdbSynced': true,
  'snooping.enabled': true,
  'dai.enabled': true,
  'dai.dropped': true,
  'snooping.trusted': true,
  'dai.trusted': true,
  'snooping.bindingPort': true,
  'ssh.enabled': true,
  'ssh.version': true,
  'ssh.keyBits': true,
  'vty.transport': true,
  'vty.loginLocal': true,
  'vty.accessClass': true,
  'qos.inputPolicy': true,
  'qos.outputPolicy': true,
  'cdp.enabled': true,
  'lldp.enabled': true,
  'ntp.synced': true,
  'ntp.peer': true,
  'ntp.stratum': true,
  'clock.source': true,
  'clock.offsetMs': true,
  'vty.logins': true,
  'tunnel.up': true,
  'ppp.lcp': true,
  'ppp.ipcp': true,
  'ppp.auth': true,
  'qos.admitted': true,
  'logging.buffered': true,
  'logging.trap': true,
  'automation.lastRun': true,
  'eigrp.fd': true,
  'eigrp.successor': true,
  'eigrp.feasibleSuccessor': true,
  'eigrp.kValues': true,
  'ipsec.sa': true,
  // P3c (ARCHITECTURE-P3C §2.10; W0 compile stubs: FACT_AREAS reads them as {} until their adapter items land)
  'ospf.abr': true,
  'ospf.asbr': true,
  'ospfv3.routerId': true,
  'ospfv3.ifaceArea': true,
  'ospfv3.ifaceCost': true,
  'ipsg.enabled': true,
  'storage.file': true,
  'device.imageVersion': true,
  'device.configRegister': true,
};

const DROP_REASONS: Record<DropReason, true> = {
  'link-down': true,
  'link-loss': true,
  'fcs-error': true,
  runt: true,
  giant: true,
  'port-admin-down': true,
  'port-err-disabled': true,
  'queue-full': true,
  'no-route': true,
  'ttl-expired': true,
  'arp-unresolved': true,
  'not-for-me': true,
  'unsupported-ethertype': true,
  'unsupported-protocol': true,
  'bad-checksum': true,
  'no-l3-address': true,
  'acl-deny': true,
  other: true,
  collision: true,
  'late-collision': true,
  'excessive-collisions': true,
  'out-of-range': true,
  'not-associated': true,
  'encapsulation-mismatch': true,
  'out-of-band': true,
  'vlan-filtered': true,
  'stp-discarding': true,
  'port-security': true,
  'nat-exhausted': true,
  'dhcp-snooping': true,
  'arp-inspection': true,
  'mtu-exceeded': true,
  policed: true,
  'ipsec-no-sa': true,
  // P3c (ARCHITECTURE-P3C §2.7, §9.2 W0 item 1: the reason list +3)
  'ip-source-guard': true,
  'storm-control': true,
  'span-destination': true,
};

const TRACE_KINDS: Record<TraceKind, true> = {
  frameTx: true,
  frameRx: true,
  drop: true,
  pduCreated: true,
  pduConsumed: true,
  mutation: true,
  tableWrite: true,
  tableExpire: true,
  debug: true,
  log: true,
  linkState: true,
  portState: true,
  deviceState: true,
  cliOutput: true,
  cliPrompt: true,
  configChange: true,
  topologyChanged: true,
  frameAbort: true,
  collision: true,
  backoff: true,
  carrierDefer: true,
  phyNegotiated: true,
  assocState: true,
  rfState: true,
  segmentChanged: true,
  frameQueued: true,
};

const FSM_MACHINES: Record<FsmMachine, true> = {
  'stp-port': true,
  'stp-bridge': true,
  dtp: true,
  lacp: true,
  channel: true,
  'port-security': true,
  'err-disable': true,
  nat: true,
  dhcpv6: true,
  'capwap-wtp': true,
  'capwap-ac': true,
  hsrp: true,
  pagp: true,
  'ospf-if': true,
  'ospf-nbr': true,
  ntp: true,
  tunnel: true,
  'ppp-lcp': true,
  'ppp-auth': true,
  'ppp-ncp': true,
  'eigrp-nbr': true,
  'eigrp-route': true,
  ike: true,
  // P3c [S6] (ARCHITECTURE-P3C §2.10)
  'ospf6-if': true,
  'ospf6-nbr': true,
};

const FAULT_KINDS: Record<FaultKind, true> = {
  'cable-cut': true,
  'port-flap': true,
  'power-loss': true,
  'link-impairment': true,
  'config-fragment': true,
  'rf-interference': true,
  'radio-fade': true,
  'duplex-mismatch': true,
  'clock-missing': true,
  'collision-storm': true,
  'err-disable': true,
};

const RF_BANDS: Record<RfBand, true> = { '2.4': true, '5': true, '6': true, '60': true, cell: true };

/** @since P3 (ruling R58 (b)) The causes a saved lab world's err-disabled port may carry (`Topology.lab.errDisabled`). */
const ERR_DISABLE_CAUSE_NAMES: Record<ErrDisableCause, true> = {
  'psecure-violation': true,
  bpduguard: true,
  'channel-misconfig': true,
  fault: true,
  'dhcp-rate-limit': true,
  'arp-inspection': true,
  // P3c [S16] (ARCHITECTURE-P3C §2.2)
  'storm-control': true,
};

const COUNTERS: Record<keyof PortCounters, true> = {
  inPackets: true,
  outPackets: true,
  inBytes: true,
  outBytes: true,
  inErrors: true,
  crcErrors: true,
  runts: true,
  giants: true,
  collisions: true,
  inDrops: true,
  outDrops: true,
  inBroadcasts: true,
  lateCollisions: true,
  deferred: true,
  excessiveCollisions: true,
  txRetries: true,
  aclDenies: true,
};

const SWITCHPORT_MODES: Record<SwitchportMode, true> = { access: true, trunk: true, 'dynamic-auto': true, 'dynamic-desirable': true };
const STP_ROLES: Record<StpRole, true> = { root: true, designated: true, alternate: true, backup: true, disabled: true };
const STP_STATES: Record<StpState, true> = { blocking: true, listening: true, learning: true, forwarding: true, discarding: true, disabled: true };
const PORT_SECURITY_STATUS: Record<PortSecurityRow['status'], true> = { 'secure-up': true, 'secure-down': true, 'secure-shutdown': true };
const HSRP_STATES: Record<HsrpRow['state'], true> = { initial: true, learn: true, listen: true, speak: true, standby: true, active: true };

// ── leaf helpers ──────────────────────────────────────────────────────────

const OBJECT = { invalid_type_error: 'must be an object' } as const;
const ARRAY = { invalid_type_error: 'must be an array' } as const;

/** A strict object: an unknown member is an issue (`unknown keys: …`). */
const obj = <S extends z.ZodRawShape>(shape: S) => z.object(shape, OBJECT).strict();

/** One of a closed set of strings, refused with the whole set in the message. */
function oneOf<T extends string>(values: Readonly<Record<T, true>>): z.ZodType<T> {
  const list = Object.keys(values) as T[];
  const message = `must be one of ${list.join(', ')}`;
  return z.enum(list as [T, ...T[]], { errorMap: () => ({ message }) });
}

const text = (max: number) => z.string({ invalid_type_error: 'must be a string' }).max(max, `must be at most ${max} characters`);
const nonEmpty = (max: number) => text(max).min(1, 'must not be empty');

const finite = () => z.number({ invalid_type_error: 'must be a number' }).finite('must be finite');
const atLeastZero = () => finite().min(0, 'must be >= 0');
const integer = (min: number, max: number) =>
  z
    .number({ invalid_type_error: 'must be a number' })
    .int('must be an integer')
    .min(min, `must be between ${min} and ${max}`)
    .max(max, `must be between ${min} and ${max}`);
const natural = () => z.number({ invalid_type_error: 'must be a number' }).int('must be an integer').min(0, 'must be >= 0');

const bool = () => z.boolean({ invalid_type_error: 'must be true or false' });
const list = <T extends z.ZodTypeAny>(item: T, max: number = MAX_LAB_LIST_ITEMS) =>
  z.array(item, ARRAY).max(max, `must have at most ${max} entries`);

/** A compared value: text, a number or a flag. */
const scalar = () =>
  z.union([z.string().max(MAX_LAB_LINE_CHARS, `must be at most ${MAX_LAB_LINE_CHARS} characters`), finite(), z.boolean()], {
    errorMap: () => ({ message: 'must be text, a number or true/false' }),
  });

/** JSON data at most MAX_LAB_PARAMS_DEPTH levels deep (a fault's `params` values). */
function isJsonData(v: unknown, depth: number): boolean {
  if (v === null || typeof v === 'string' || typeof v === 'boolean') return true;
  if (typeof v === 'number') return Number.isFinite(v);
  if (typeof v !== 'object' || depth >= MAX_LAB_PARAMS_DEPTH) return false;
  if (Array.isArray(v)) return v.every((x) => isJsonData(x, depth + 1));
  if (Object.getPrototypeOf(v) !== Object.prototype) return false;
  return Object.values(v).every((x) => isJsonData(x, depth + 1));
}

// ── type checks: a schema object has exactly the members of its contract type ─

/** True when A and B have the same member names. */
type SameKeys<A, B> = [Exclude<keyof A, keyof B>, Exclude<keyof B, keyof A>] extends [never, never] ? true : false;
/** True when every value of T is true. */
type AllTrue<T> = false extends T[keyof T] ? false : true;
/** Compiles only for `true`. */
type Assert<T extends true> = T;

// ── the builder ───────────────────────────────────────────────────────────

/** Every schema of a lab document, built once on first use (rule 12: reads io/schema.ts at call time). */
function buildLabSchemas() {
  const device = nonEmpty(MAX_ID_CHARS);
  const port = nonEmpty(MAX_ID_CHARS);
  const name = nonEmpty(MAX_ID_CHARS);
  const line = text(MAX_LAB_LINE_CHARS);
  const longText = text(MAX_LAB_TEXT_CHARS);
  const vlan = integer(1, 4094);
  const l4Port = integer(0, 65535);
  const family = z.union([z.literal(4), z.literal(6)], { errorMap: () => ({ message: 'must be 4 or 6' }) });
  const aclEntry = z.union([natural(), z.literal('implicit')], { errorMap: () => ({ message: 'must be an entry number or "implicit"' }) });
  /** @since P3c [S11] The `acl` kind's entry: also an IPv6 list's implicit ND rows. */
  const aclEntry6 = z.union([natural(), z.literal('implicit'), z.literal('nd-na'), z.literal('nd-ns')], {
    errorMap: () => ({ message: 'must be an entry number, "implicit", "nd-na" or "nd-ns"' }),
  });
  const media = z.enum(MEDIA_TYPES as [MediaType, ...MediaType[]], { errorMap: () => ({ message: `must be one of ${MEDIA_TYPES.join(', ')}` }) });
  const notes = { feedback: longText.optional(), misconception: line.optional() };

  /** A grader fault inside a clone (`LabFault`): exactly one of its four forms. */
  const labFault = z
    .object(
      {
        cut: obj({ a: device, b: device, aPort: port.optional(), bPort: port.optional() }).optional(),
        powerOff: device.optional(),
        shutdown: obj({ device, port }).optional(),
        config: obj({ device, lines: list(line) }).optional(),
      },
      OBJECT,
    )
    .strict()
    .superRefine((f, ctx) => {
      if (Object.keys(f).length !== 1) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'must name exactly one fault: cut, powerOff, shutdown or config' });
    })
    .transform((f) => f as LabFault);
  const after = list(labFault);

  const traceFilter = obj({
    kinds: list(oneOf(TRACE_KINDS)).optional(),
    protos: list(name).optional(),
    devices: list(name).optional(),
    links: list(name).optional(),
    ports: list(obj({ device: name, port })).optional(),
    tables: list(name).optional(),
    tags: list(line).optional(),
    includeBackground: bool().optional(),
    machines: list(oneOf(FSM_MACHINES)).optional(),
    // P3c (ARCHITECTURE-P3C §2.8): [S10] `reasons` and [C32] `vlans` (optional by meaning)
    reasons: list(oneOf(DROP_REASONS)).optional(),
    vlans: list(vlan).optional(),
  });

  const flow = obj({
    id: name.optional(),
    dst: line,
    dstPort: l4Port.optional(),
    sizeBytes: integer(60, 1500),
    rateKbps: finite().positive('must be > 0').optional(),
    pps: finite().positive('must be > 0').optional(),
    dscp: integer(0, 63).optional(),
    count: natural().optional(),
    durationMs: atLeastZero().optional(),
    preset: oneOf<NonNullable<TrafficFlowSpec['preset']>>({ 'voice-g729': true, 'voice-g711': true }).optional(),
    from: device,
    to: device,
  });

  /** Every assertion kind but `connectivity` (the follow-up checks of `connectivity.then`). */
  const statics = {
    config: obj({
      kind: z.literal('config'),
      device,
      path: line,
      equals: z.union([line, list(line)], { errorMap: () => ({ message: 'must be a string or a list of strings' }) }).optional(),
      exists: bool().optional(),
      contains: line.optional(),
      count: natural().optional(),
      ...notes,
    }),
    port: obj({ kind: z.literal('port'), device, port, field: oneOf<Member<'port', 'field'>>({ operUp: true, adminUp: true, ipv4: true, ipv6: true, duplex: true, speedBps: true, role: true, errDisabled: true }), equals: scalar(), ...notes }),
    table: obj({
      kind: z.literal('table'),
      device,
      table: name,
      where: z.record(z.string(), scalar(), OBJECT),
      exists: bool(),
      minCount: natural().optional(),
      maxCount: natural().optional(),
      whereOps: z
        .record(
          z.string(),
          obj({
            op: oneOf<Member<'table', 'whereOps'>[string]['op']>({ lt: true, le: true, gt: true, ge: true, ne: true, contains: true }),
            value: z.union([line, finite()], { errorMap: () => ({ message: 'must be text or a number' }) }),
          }),
          OBJECT,
        )
        .optional(),
      ...notes,
    }),
    process: obj({ kind: z.literal('process'), device, process: name, path: line, equals: scalar(), ...notes }),
    link: obj({ kind: z.literal('link'), a: device, b: device, media: media.optional(), up: bool().optional(), ...notes }),
    counter: obj({
      kind: z.literal('counter'),
      device,
      port,
      counter: oneOf(COUNTERS),
      op: oneOf<Member<'counter', 'op'>>({ gt: true, eq: true, lt: true }),
      value: finite(),
      ...notes,
    }),
    traceSeen: obj({ kind: z.literal('traceSeen'), filter: traceFilter, min: natural().optional(), ...notes }),
    vlan: obj({
      kind: z.literal('vlan'),
      device,
      vlan,
      exists: bool().optional(),
      name: line.optional(),
      accessPorts: list(port).optional(),
      match: oneOf<Member<'vlan', 'match'>>({ includes: true, exactly: true }).optional(),
      ...notes,
    }),
    switchport: obj({
      kind: z.literal('switchport'),
      device,
      port,
      oper: oneOf<Member<'switchport', 'oper'>>({ access: true, trunk: true, down: true }).optional(),
      mode: oneOf(SWITCHPORT_MODES).optional(),
      accessVlan: vlan.optional(),
      voiceVlan: vlan.optional(),
      nativeVlan: vlan.optional(),
      allowedVlans: list(vlan).optional(),
      ...notes,
    }),
    stp: obj({
      kind: z.literal('stp'),
      device,
      vlan,
      root: bool().optional(),
      rootBridge: device.optional(),
      port: port.optional(),
      role: oneOf(STP_ROLES).optional(),
      state: oneOf(STP_STATES).optional(),
      edge: bool().optional(),
      mode: oneOf<Member<'stp', 'mode'>>({ pvst: true, 'rapid-pvst': true }).optional(),
      ...notes,
    }),
    etherchannel: obj({
      kind: z.literal('etherchannel'),
      device,
      group: natural(),
      protocol: oneOf<Member<'etherchannel', 'protocol'>>({ lacp: true, pagp: true, static: true }).optional(),
      up: bool().optional(),
      bundled: list(port).optional(),
      minBundled: natural().optional(),
      ...notes,
    }),
    portSecurity: obj({
      kind: z.literal('portSecurity'),
      device,
      port,
      enabled: bool().optional(),
      status: oneOf(PORT_SECURITY_STATUS).optional(),
      violation: oneOf<Member<'portSecurity', 'violation'>>({ protect: true, restrict: true, shutdown: true }).optional(),
      max: natural().optional(),
      stickyMac: line.optional(),
      minViolations: natural().optional(),
      ...notes,
    }),
    route: obj({
      kind: z.literal('route'),
      device,
      family: family.optional(),
      destination: line,
      source: line.optional(),
      network: line.optional(),
      nextHop: line.optional(),
      iface: port.optional(),
      ad: integer(0, 255).optional(),
      none: bool().optional(),
      metric: natural().optional(),
      routeType: oneOf<Member<'route', 'routeType'>>({ E2: true, IA: true, OI: true, OE2: true }).optional(),
      minPaths: natural().optional(),
      ...notes,
    }),
    nat: obj({
      kind: z.literal('nat'),
      device,
      insideLocal: line.optional(),
      insideGlobal: line.optional(),
      outsideGlobal: line.optional(),
      proto: oneOf<Member<'nat', 'proto'>>({ icmp: true, tcp: true, udp: true }).optional(),
      kindOf: oneOf<Member<'nat', 'kindOf'>>({ static: true, dynamic: true, overload: true }).optional(),
      exists: bool().optional(),
      minCount: natural().optional(),
      ...notes,
    }),
    fhrp: obj({
      kind: z.literal('fhrp'),
      device,
      iface: port,
      group: natural(),
      state: oneOf(HSRP_STATES).optional(),
      virtualIp: line.optional(),
      priority: integer(0, 255).optional(),
      preempt: bool().optional(),
      ...notes,
    }),
    neighbor: obj({
      kind: z.literal('neighbor'),
      device,
      protocol: oneOf(NEIGHBOR_PROTOCOLS),
      neighbor: line.optional(),
      iface: port.optional(),
      state: line.optional(),
      role: oneOf<Member<'neighbor', 'role'>>({ dr: true, bdr: true, drother: true }).optional(),
      exists: bool().optional(),
      count: natural().optional(),
      minCount: natural().optional(),
      ...notes,
    }),
    fact: obj({
      kind: z.literal('fact'),
      device,
      fact: oneOf(FACT_NAMES),
      subject: line.optional(),
      equals: scalar().optional(),
      atLeast: finite().optional(),
      atMost: finite().optional(),
      ...notes,
    }),
    acl: obj({
      kind: z.literal('acl'),
      device,
      list: name,
      family: family.optional(),
      type: oneOf<Member<'acl', 'type'>>({ standard: true, extended: true, ipv6: true }).optional(),
      exists: bool().optional(),
      entries: list(line).optional(),
      match: oneOf<Member<'acl', 'match'>>({ exactly: true, includes: true }).optional(),
      applied: list(
        obj({
          iface: port.optional(),
          vty: z.literal(true, { errorMap: () => ({ message: 'must be true (leave it out otherwise)' }) }).optional(),
          dir: oneOf<Member<'acl', 'applied'>[number]['dir']>({ in: true, out: true }),
        }),
      ).optional(),
      entry: aclEntry6.optional(),
      minMatches: natural().optional(),
      ...notes,
    }),
    aclDecision: obj({
      kind: z.literal('aclDecision'),
      device,
      list: name,
      family: family.optional(),
      packet: obj({
        proto: oneOf<Member<'aclDecision', 'packet'>['proto']>({ ip: true, icmp: true, tcp: true, udp: true }),
        src: line,
        dst: line,
        srcPort: l4Port.optional(),
        dstPort: l4Port.optional(),
        established: bool().optional(),
      }),
      expect: oneOf<Member<'aclDecision', 'expect'>>({ permit: true, deny: true }),
      entry: aclEntry.optional(),
      ...notes,
    }),
    service: obj({
      kind: z.literal('service'),
      from: device,
      to: device,
      service: oneOf<Member<'service', 'service'>>({ telnet: true, ssh: true }),
      user: line.optional(),
      password: line.optional(),
      expect: oneOf<Member<'service', 'expect'>>({ success: true, fail: true, refused: true }),
      timeoutMs: atLeastZero().optional(),
      after: after.optional(),
      ...notes,
    }),
    path: obj({
      kind: z.literal('path'),
      from: device,
      to: device,
      toIface: port.optional(),
      toAddress: line.optional(),
      family: family.optional(),
      via: list(device).optional(),
      notVia: list(device).optional(),
      after: after.optional(),
      settleMs: atLeastZero().optional(),
      tunnelAt: obj({ device, tunnel: oneOf<Member<'path', 'tunnelAt'>['tunnel']>({ gre: true, ipsec: true }) }).optional(),
      ...notes,
    }),
    traffic: obj({
      kind: z.literal('traffic'),
      flows: list(flow),
      runMs: atLeastZero(),
      expect: list(
        obj({
          receiver: device,
          flow: name,
          maxLossPct: finite().min(0, 'must be between 0 and 100').max(100, 'must be between 0 and 100').optional(),
          maxDelayMs: atLeastZero().optional(),
          maxJitterMs: atLeastZero().optional(),
        }),
      ),
      ...notes,
    }),
  };

  // A follow-up check reads state in the connectivity check's clone: the clone kinds (service, path, traffic) need a
  // clone of their own and the grader refuses each inside `then` (registry.ts), so the schema refuses them too and
  // its message lists only the kinds a follow-up may be (W5 fix #26).
  const followUpOptions = [
    statics.config,
    statics.port,
    statics.table,
    statics.process,
    statics.link,
    statics.counter,
    statics.traceSeen,
    statics.vlan,
    statics.switchport,
    statics.stp,
    statics.etherchannel,
    statics.portSecurity,
    statics.route,
    statics.nat,
    statics.fhrp,
    statics.neighbor,
    statics.fact,
    statics.acl,
    statics.aclDecision,
  ] as const;
  const FOLLOW_UP_KINDS = followUpOptions.map((o) => o.shape.kind.value).join(', ');
  const followUp = z.discriminatedUnion(
    'kind',
    followUpOptions,
    {
      errorMap: (issue, ctx) =>
        issue.code === z.ZodIssueCode.invalid_union_discriminator
          ? { message: `must be one of ${FOLLOW_UP_KINDS} (a follow-up check reads state in the same clone, so it cannot be a connectivity, service, path or traffic check)` }
          : issue.code === z.ZodIssueCode.invalid_type
            ? { message: 'must be an object' }
            : { message: ctx.defaultError },
    },
  );

  const connectivity = obj({
    kind: z.literal('connectivity'),
    from: device,
    to: line.min(1, 'must not be empty'),
    family: family.optional(),
    byName: bool().optional(),
    expect: oneOf<Member<'connectivity', 'expect'>>({ success: true, fail: true }),
    timeoutMs: atLeastZero().optional(),
    after: after.optional(),
    settleMs: atLeastZero().optional(),
    then: list(followUp, MAX_LAB_ASSERTIONS).optional(),
    proto: oneOf<Member<'connectivity', 'proto'>>({ icmp: true, tcp: true, udp: true }).optional(),
    port: l4Port.optional(),
    toIface: port.optional(),
    toAddress: line.optional(),
    source: line.optional(),
    droppedAt: device.optional(),
    dropReason: oneOf(DROP_REASONS).optional(),
    ...notes,
  });

  // ── P3c (ARCHITECTURE-P3C §2.10; W0): the [S8] `convergence` and [S38] `packetSeen` kinds, written against the
  // contract (the kind check below). A document may name them; until the W3b sim item lands, the grader's W0 stub
  // fails each with "not available in this build" (sim/lab-checks/registry.ts P3C_UNAVAILABLE_KIND_DETAILS). Clone
  // kinds: never a follow-up. ──
  const convergence = obj({
    kind: z.literal('convergence'),
    fault: labFault,
    protocol: oneOf<ConvergenceProtocol>({ stp: true, etherchannel: true, fhrp: true, routing: true, wireless: true, wan: true }),
    only: oneOf<Member<'convergence', 'only'>>({ ospf: true, eigrp: true }).optional(),
    withinMs: atLeastZero(),
    atLeastMs: atLeastZero().optional(),
    windowMs: atLeastZero().optional(),
    ...notes,
  });
  const packetSeen = obj({
    kind: z.literal('packetSeen'),
    at: z.union([obj({ device, port: port.optional() }), obj({ link: z.tuple([device, device]) })]),
    filter: line.min(1, 'must not be empty'),
    dir: oneOf<Member<'packetSeen', 'dir'>>({ tx: true, rx: true, both: true }).optional(),
    expect: oneOf<Member<'packetSeen', 'expect'>>({ seen: true, absent: true }).optional(),
    min: natural().optional(),
    drive: z
      .union([
        obj({ probe: obj({ from: device, to: device, proto: oneOf<'icmp' | 'tcp' | 'udp'>({ icmp: true, tcp: true, udp: true }).optional(), port: l4Port.optional() }) }),
        obj({ flows: list(flow), runMs: atLeastZero() }),
        obj({ snmp: obj({ from: device, to: device, community: line, oid: line }), runMs: atLeastZero() }),
        obj({ runMs: atLeastZero() }),
      ])
      .optional(),
    includeBackground: bool().optional(),
    after: after.optional(),
    settleMs: atLeastZero().optional(),
    ...notes,
  });
  const kinds = { ...statics, connectivity, convergence, packetSeen };
  const KINDS = Object.keys(kinds).join(', ');
  const assertion = z.discriminatedUnion(
    'kind',
    [
      kinds.config,
      kinds.port,
      kinds.table,
      kinds.process,
      kinds.link,
      kinds.counter,
      kinds.connectivity,
      kinds.traceSeen,
      kinds.vlan,
      kinds.switchport,
      kinds.stp,
      kinds.etherchannel,
      kinds.portSecurity,
      kinds.route,
      kinds.nat,
      kinds.fhrp,
      kinds.neighbor,
      kinds.fact,
      kinds.acl,
      kinds.aclDecision,
      kinds.service,
      kinds.path,
      kinds.traffic,
      kinds.convergence,
      kinds.packetSeen,
    ],
    {
      errorMap: (issue, ctx) =>
        issue.code === z.ZodIssueCode.invalid_union_discriminator
          ? { message: `must be one of ${KINDS}` }
          : issue.code === z.ZodIssueCode.invalid_type
            ? { message: 'must be an object' }
            : { message: ctx.defaultError },
    },
  );

  const task = obj({
    id: name,
    title: line.min(1, 'must not be empty'),
    description: longText,
    points: integer(0, MAX_LAB_TASK_POINTS),
    hint: longText.optional(),
    dependsOn: list(name).optional(),
    assertions: list(assertion, MAX_LAB_ASSERTIONS).min(1, 'a task needs at least one assertion'),
    feedbackOnFail: longText.optional(),
  });

  const meta = obj({
    name: text(MAX_LAB_NAME_CHARS).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'must be a kebab-case id (lowercase letters and digits joined by single hyphens)'),
    version: integer(1, MAX_LAB_VERSION),
    title: line.min(1, 'must not be empty'),
    course: line.min(1, 'must not be empty').optional(),
    topic: line.min(1, 'must not be empty').optional(),
    seed: z
      .number({ invalid_type_error: 'must be a number' })
      .int('must be an integer')
      .min(Number.MIN_SAFE_INTEGER, 'out of range')
      .max(Number.MAX_SAFE_INTEGER, 'out of range'),
    concept: oneOf(CONCEPT_TOOLS).optional(),
    instructions: longText.optional(),
  });

  const faultSpec = obj({
    id: line.min(1, 'must not be empty'),
    kind: oneOf(FAULT_KINDS),
    target: obj({
      device: name.optional(),
      port: port.optional(),
      link: name.optional(),
      medium: name.optional(),
      band: oneOf(RF_BANDS).optional(),
      channel: natural().optional(),
    }),
    params: z
      .record(
        z.string(),
        z.custom<unknown>((v) => isJsonData(v, 0), {
          message: `must be JSON data (text, a number, true/false, null, a list or an object; at most ${MAX_LAB_PARAMS_DEPTH} levels deep)`,
        }),
        OBJECT,
      )
      .optional(),
    hiddenFromStudent: bool().optional(),
  });
  const scheduledFault = obj({
    at: z
      .number({ invalid_type_error: 'must be a number' })
      .int('must be an integer number of nanoseconds')
      .min(0, 'must be >= 0')
      .max(Number.MAX_SAFE_INTEGER, 'exceeds the largest representable time'),
    fault: faultSpec,
  });

  const documentObject = obj({
    format: z.literal(LAB_DOCUMENT_FORMAT, { errorMap: () => ({ message: `must be "${LAB_DOCUMENT_FORMAT}"` }) }),
    meta,
    topology: topologySchema,
    tasks: list(task, MAX_LAB_TASKS),
    faults: list(scheduledFault, MAX_LAB_FAULTS).optional(),
    solution: z.record(z.string(), list(line), OBJECT).optional(),
  });
  const document = documentObject.superRefine(checkReferences);

  // R58 (b): the lab state a save of a P3 world records (`Topology.lab.pendingFaults` / `.errDisabled`). The `lab`
  // section's name and version belong to the topology schema (io/schema.ts), so this object reads its two members and
  // leaves the others alone (not strict).
  const errDisabledPort = obj({ device, port, cause: oneOf(ERR_DISABLE_CAUSE_NAMES) });
  const savedLabState = z.object(
    { pendingFaults: list(scheduledFault, MAX_LAB_FAULTS).optional(), errDisabled: list(errDisabledPort).optional() },
    OBJECT,
  );
  const savedLab = z.object({ lab: savedLabState.optional() }, OBJECT);

  return { kinds, labFault, traceFilter, flow, task, meta, faultSpec, documentObject, document, errDisabledPort, savedLabState, savedLab };
}

type LabSchemas = ReturnType<typeof buildLabSchemas>;

/** Every assertion kind of the contract has a schema with exactly its members (and no schema has another kind). */
type _LabAssertionKindsMatch = Assert<AllTrue<{ [K in Kind]: SameKeys<z.output<LabSchemas['kinds'][K]>, Of<K>> }>>;
/** The other contract objects the schema spells out member by member. */
type _LabObjectsMatch = Assert<
  AllTrue<{
    document: SameKeys<z.output<LabSchemas['documentObject']>, LabDocument>;
    meta: SameKeys<z.output<LabSchemas['meta']>, LabDocument['meta']>;
    task: SameKeys<z.output<LabSchemas['task']>, LabTask>;
    fault: SameKeys<z.output<LabSchemas['faultSpec']>, NonNullable<LabDocument['faults']>[number]['fault']>;
    traceFilter: SameKeys<z.output<LabSchemas['traceFilter']>, TraceFilter>;
    flow: SameKeys<z.output<LabSchemas['flow']>, Member<'traffic', 'flows'>[number]>;
    errDisabledPort: SameKeys<z.output<LabSchemas['errDisabledPort']>, TopologyErrDisabledPort>;
    pendingFault: SameKeys<NonNullable<z.output<LabSchemas['savedLabState']>['pendingFaults']>[number], TopologyPendingFault>;
    savedLabState: SameKeys<z.output<LabSchemas['savedLabState']>, Pick<NonNullable<Topology['lab']>, 'pendingFaults' | 'errDisabled'>>;
  }>
>;

let built: LabSchemas | undefined;
/** The schemas, built on first use. */
function schemas(): LabSchemas {
  built ??= buildLabSchemas();
  return built;
}

// ── references ────────────────────────────────────────────────────────────

/**
 * The device and link lists of the parsed topology, or undefined when the topology was refused: zod still runs the
 * document's refinement when the only issues so far are refinement issues, and a refused topology then holds zod's
 * invalid marker instead of a topology (its own issues are already reported).
 */
function topologyLists(t: unknown): { devices: readonly { id: string; name: string }[]; links: readonly { id: string }[] } | undefined {
  if (typeof t !== 'object' || t === null) return undefined;
  const { devices, links } = t as { devices?: unknown; links?: unknown };
  return Array.isArray(devices) && Array.isArray(links) ? { devices, links } : undefined;
}

/**
 * The cross-references a schema cannot express (file header): unique task ids and device names, `dependsOn`, the
 * device names of assertions, grader faults and the solution, the device and link ids of scheduled faults and trace
 * filters.
 */
function checkReferences(doc: LabDocument, ctx: z.RefinementCtx): void {
  const topology = topologyLists(doc.topology);
  if (topology === undefined) return;
  const add = (path: readonly (string | number)[], message: string): void => {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: [...path], message });
  };

  const names = new Set<string>();
  topology.devices.forEach((d, i) => {
    if (names.has(d.name)) add(['topology', 'devices', i, 'name'], `another device is already named "${d.name}" (a lab names its devices, so names must be unique)`);
    else names.add(d.name);
  });
  const deviceIds = new Set(topology.devices.map((d) => d.id));
  const linkIds = new Set(topology.links.map((l) => l.id));
  const named = (value: string, path: readonly (string | number)[]): void => {
    if (!names.has(value)) add(path, `unknown device "${value}"`);
  };

  const fault = (f: LabFault, path: readonly (string | number)[]): void => {
    if ('cut' in f) {
      named(f.cut.a, [...path, 'cut', 'a']);
      named(f.cut.b, [...path, 'cut', 'b']);
    } else if ('powerOff' in f) named(f.powerOff, [...path, 'powerOff']);
    else if ('shutdown' in f) named(f.shutdown.device, [...path, 'shutdown', 'device']);
    else named(f.config.device, [...path, 'config', 'device']);
  };
  const faults = (list: readonly LabFault[] | undefined, path: readonly (string | number)[]): void => {
    list?.forEach((f, k) => fault(f, [...path, 'after', k]));
  };
  const devices = (list: readonly string[] | undefined, path: readonly (string | number)[]): void => {
    list?.forEach((n, k) => named(n, [...path, k]));
  };

  const assertion = (a: LabAssertion, path: readonly (string | number)[]): void => {
    if ('device' in a) named(a.device, [...path, 'device']);
    switch (a.kind) {
      case 'link':
        named(a.a, [...path, 'a']);
        named(a.b, [...path, 'b']);
        break;
      case 'connectivity':
        named(a.from, [...path, 'from']);
        if (a.byName !== true) named(a.to, [...path, 'to']);
        if (a.droppedAt !== undefined) named(a.droppedAt, [...path, 'droppedAt']);
        faults(a.after, path);
        a.then?.forEach((next, k) => assertion(next, [...path, 'then', k]));
        break;
      case 'traceSeen':
        a.filter.devices?.forEach((id, k) => {
          if (!deviceIds.has(id)) add([...path, 'filter', 'devices', k], `unknown device id "${id}" (a trace filter names devices by id)`);
        });
        break;
      case 'stp':
        if (a.rootBridge !== undefined) named(a.rootBridge, [...path, 'rootBridge']);
        break;
      case 'service':
        named(a.from, [...path, 'from']);
        named(a.to, [...path, 'to']);
        faults(a.after, path);
        break;
      case 'path':
        named(a.from, [...path, 'from']);
        named(a.to, [...path, 'to']);
        devices(a.via, [...path, 'via']);
        devices(a.notVia, [...path, 'notVia']);
        faults(a.after, path);
        if (a.tunnelAt !== undefined) named(a.tunnelAt.device, [...path, 'tunnelAt', 'device']);
        break;
      case 'traffic':
        a.flows.forEach((f, k) => {
          named(f.from, [...path, 'flows', k, 'from']);
          named(f.to, [...path, 'flows', k, 'to']);
        });
        a.expect.forEach((e, k) => named(e.receiver, [...path, 'expect', k, 'receiver']));
        break;
      default:
        break;
    }
  };

  const taskIds = new Set<string>();
  doc.tasks.forEach((t, i) => {
    if (taskIds.has(t.id)) add(['tasks', i, 'id'], `task "${t.id}" is listed more than once`);
    else taskIds.add(t.id);
  });
  doc.tasks.forEach((t, i) => {
    t.dependsOn?.forEach((d, j) => {
      if (d === t.id) add(['tasks', i, 'dependsOn', j], `task "${t.id}" cannot depend on itself`);
      else if (!taskIds.has(d)) add(['tasks', i, 'dependsOn', j], `unknown task "${d}"`);
    });
    t.assertions.forEach((a, j) => assertion(a, ['tasks', i, 'assertions', j]));
  });

  doc.faults?.forEach(({ fault: f }, i) => {
    const { device, link } = f.target;
    if (device !== undefined && !deviceIds.has(device)) add(['faults', i, 'fault', 'target', 'device'], `unknown device id "${device}" (a scheduled fault names devices by id)`);
    if (link !== undefined && !linkIds.has(link)) add(['faults', i, 'fault', 'target', 'link'], `unknown link id "${link}"`);
  });

  for (const deviceName of Object.keys(doc.solution ?? {})) named(deviceName, ['solution', deviceName]);
}

// ── public API ────────────────────────────────────────────────────────────

/**
 * The full lab-document schema (structure and references, file header). Lazy: the schemas are built the first time
 * it parses. The output is a `LabDocument`; the topology keeps its schema id (no migration), like `validateTopology`.
 */
export const labDocumentSchema: z.ZodType<LabDocument, z.ZodTypeDef, unknown> = z.lazy(() => schemas().document);

/** Result of `validateLabDocument`. */
export type LabDocumentValidation = { ok: true; document: LabDocument } | { ok: false; errors: string[] };

/**
 * Validate an arbitrary JSON value as a `LabDocument` without throwing. On failure `errors` lists every issue as one
 * readable line with its path (`tasks[0].assertions[2].device: unknown device "R9"`); the references are checked
 * once the structure is valid.
 */
export function validateLabDocument(json: unknown): LabDocumentValidation {
  const result = labDocumentSchema.safeParse(json);
  if (!result.success) return { ok: false, errors: formatIssues(result.error) };
  return { ok: true, document: result.data };
}

/** Parse an arbitrary JSON value as a `LabDocument`; throws an `Error` whose message lists the first issues. */
export function parseLabDocument(json: unknown): LabDocument {
  const result = validateLabDocument(json);
  if (result.ok) return result.document;
  const shown = result.errors.slice(0, ISSUES_IN_MESSAGE).map((e) => `  - ${e}`);
  const more = result.errors.length - ISSUES_IN_MESSAGE;
  if (more > 0) shown.push(`  ... and ${more} more`);
  const count = `${result.errors.length} issue${result.errors.length === 1 ? '' : 's'}`;
  throw new Error([`Invalid lab document: ${count}`, ...shown].join('\n'));
}

/** Pretty JSON text of a lab document (two-space indent, final newline): the `activity.json` text. */
export function labDocumentToJson(doc: LabDocument): string {
  return JSON.stringify(doc, null, 2) + '\n';
}

/**
 * @since P3 (ruling R58 (b)) The lab state a saved world records for headless grading: `topology.lab.pendingFaults`
 * (the scheduled faults that had not landed) and `topology.lab.errDisabled` (the err-disabled ports and their causes),
 * each an empty list when absent (a world without a lab stamp, a P1 or P2 save, a P3 save with nothing pending).
 */
export interface SavedLabState {
  readonly pendingFaults: readonly TopologyPendingFault[];
  readonly errDisabled: readonly TopologyErrDisabledPort[];
}

/**
 * @since P3 (ruling R58 (b)) Read and check the saved lab state of `topology`, an untrusted submission (only its `lab`
 * section is read; its name and version, and everything else, are the topology schema's). Each scheduled fault is
 * checked as a lab document's scheduled fault is (at most MAX_LAB_FAULTS, an integer instant >= 0, a fault of a known
 * kind with JSON parameters), each port as a device id, a port name and one of the err-disable causes. Throws a
 * `TopologyLoadError` whose problems are path-qualified lines (`lab.pendingFaults[0].at: must be >= 0`); returns
 * plain copies. Pure.
 */
export function parseSavedLabState(topology: unknown): SavedLabState {
  const result = schemas().savedLab.safeParse(topology);
  if (!result.success) throw topologyLoadError(formatIssues(result.error).map((message) => ({ message })));
  const lab = result.data.lab;
  return { pendingFaults: lab?.pendingFaults ?? [], errDisabled: lab?.errDisabled ?? [] };
}

/** Parse and validate lab-document JSON text; throws a readable `Error` on bad syntax or a wrong document. */
export function labDocumentFromJson(text: string): LabDocument {
  let json: unknown;
  try {
    json = JSON.parse(text) as unknown;
  } catch (e) {
    throw new Error(`lab document is not valid JSON: ${e instanceof Error ? e.message : String(e)}`);
  }
  return parseLabDocument(json);
}
