/**
 * protocols/ospf/engine.ts — the OSPF adjacency engine (ARCHITECTURE-P3C D7 [S6], §7 W1a: the zero-diff refactor, part
 * 1 of 2). What the v2 daemon (protocols/ospf.ts) ran inside its closure, moved here unchanged: the interface and
 * neighbour state machines, the elections, the DBD exchange, link-state requests, flooding and acknowledgements, the
 * LSDB with MinLSArrival and MaxAge, origination with MinLSInterval and the self-war cap, the SPF throttle, the debug
 * ring, the table rows and every timer of the daemon (protocols/ospf.ts's module header describes the behaviour).
 *
 * Part 2 (W1c, zero-diff) moved every family-specific part behind the `OspfFamily` adapter (below): the outer packet
 * layer and its send request, the hello fields and checks, the multicast groups, the LSA wire forms, scopes and orders,
 * the self-originated LSA bodies, the route computation and its batch, the three table rows, and the daemon half that
 * reads the configuration (the process start decision, which interfaces run (`IfaceWant`), the RIB watch, the packet
 * demultiplexer's outer layers). `createOspfProcess(family)` is the daemon shell both families share:
 * `ospf` = engine + protocols/ospf/family-v4.ts (OSPFv2), and `ospfv3` = engine + family-v6.ts (W2a/W3a [S6]).
 *
 * Addresses are strings: for v2 the interface and neighbour addresses are IPv4; a v3 family carries link-local IPv6
 * addresses in the same slots. The v2 flooding helpers (protocols/ospf/flood.ts) answer with the v2 group addresses,
 * which the engine maps onto the family's groups (`groupOf`, the identity for v2).
 */
import { ipv4ToU32, type Ipv4Address } from '../../contracts/addr.js';
import type { PortRole } from '../../contracts/catalog.js';
import type { ConfigDelta } from '../../contracts/config.js';
import type { PortId, ProcessName } from '../../contracts/ids.js';
import { OSPF_ALL_DROUTERS, OSPF_ALL_ROUTERS, type FieldValue, type LayerSpec, type LayerView, type Pdu, type PduMeta, type ProtoName } from '../../contracts/pdu.js';
import type { Action, DebugEvent, FsmMachine, FsmTransition, Process, ProcessCtx, ProcessRequest, StateView } from '../../contracts/process.js';
import {
  ospfNbrKey,
  type OspfAreaId,
  type OspfIsmState,
  type OspfLsaRow,
  type OspfNetworkType,
  type OspfNsmState,
  type OspfStateView,
  type SpfTree,
  type Table,
  type TableName,
  type TableRow,
} from '../../contracts/tables.js';
import { SEC, type SimTime } from '../../contracts/time.js';
import type { ProcessEvent } from '../../contracts/transport.js';
import { compareLsaInstances, lsaAgeAt, LSA_INITIAL_SEQ, LSA_MAX_AGE_S, LSA_MIN_ARRIVAL_NS, LSA_REFRESH_S, nextLsaSeq, type LsaInstance } from '../../core/ospf-lsa.js';
import type { SpfRootIface } from '../../core/ospf-spf.js';
import { OSPF_DD_FLAG, OSPF_PACKET, ospfPacketText } from '../../pdu/codecs/ospf.js';
import {
  type OspfConfig,
  type OspfProcessConfig,
} from './config.js';
import { drEventsFromHello, electDesignatedRouter, ospfAdjacencyOk, OSPF_NO_DR, type OspfDrCandidate, type OspfHelloDeclaration } from './dr.js';
import { ackDirectly, directDestination, floodOut, type FloodIface, type OspfAckCase } from './flood.js';
import type { OspfHelloCheck } from './hello-check.js';
import { ismOutcome, OSPF_ISM_EVENT_NAMES } from './ism.js';
import {
  lsaKeyOf,
  rowInstance,
  wireInstance,
  type OspfLsaBody,
  type OspfLsaWire,
} from './lsdb.js';
import {
  dbdVerdict,
  ddFlagsText,
  nsmAtLeast,
  nsmRank,
  OSPF_DBD_MAX_HEADERS,
  OSPF_DBD_MTU_DEFAULT,
  OSPF_EXSTART_MAX_RETRANSMITS,
  OSPF_HELLO_REPLY_NS,
  OSPF_LSR_MAX_ENTRIES,
  OSPF_MAX_BODY,
  OSPF_NSM_EVENT_NAMES,
  OSPF_RXMT_NS,
  ospfDdSeqInitial,
  ospfNeighborRole,
  type OspfNsmEvent,
} from './nsm.js';
import { lsaGenAt } from './originate.js';
import type { OspfAreaRoot } from './routes.js';

/** @since P3 The daemon's process name (D7). */
export const OSPF_PROCESS: ProcessName = 'ospf';
/** @since P3 Debug categories (§5.8; the `debug` tokens). */
export const OSPF_DEBUG = Object.freeze({
  adj: 'ip ospf adj',
  hello: 'ip ospf hello',
  flood: 'ip ospf flood',
  spf: 'ip ospf spf',
  packet: 'ip ospf packet',
});
/** @since P3 SPF delay after the first change (D9). */
export const OSPF_SPF_DELAY_NS = 5 * SEC;
/** @since P3 SPF hold: two runs are at least 10 s apart (D9). */
export const OSPF_SPF_HOLD_NS = 10 * SEC;
/** @since P3 The MaxAge sweep interval (§4.2). */
export const OSPF_MAXAGE_SWEEP_NS = 60 * SEC;
/** @since P3 Two newer copies of one self-originated LSA within this window are a router id conflict (`self-war`). */
export const OSPF_SELF_WAR_WINDOW_NS = 60 * SEC;
/**
 * @since P3 (W5 fix, the ospf report; rule 19) Newer copies of one self-originated LSA, each within the war window of
 * the one before, after which this router stops re-originating it: the other router's copy stands until the window
 * passes with no newer copy. Without the cap, two routers with one id that are not neighbours re-originate over each
 * other for ever, every round re-arming the non-periodic flooding and SPF work, so `runToIdle` never returned.
 */
export const OSPF_SELF_WAR_MAX_COPIES = 8;

const DEBUG_RING = 256;

export interface Proc {
  readonly pid: number;
  readonly routerId: Ipv4Address;
  readonly startedAt: SimTime;
}

export interface Nbr {
  readonly port: PortId;
  readonly routerId: Ipv4Address;
  address: Ipv4Address;
  priority: number;
  state: OspfNsmState;
  stateSince: SimTime;
  /** What its last hello declared (the `before` of drEventsFromHello). */
  declared?: OspfHelloDeclaration;
  /** ExStart restart counter (D9). */
  attempt: number;
  ddSeq: number;
  /** This router is master of the exchange. */
  master: boolean;
  /** The row's `master` column: the neighbour is master (set at NegotiationDone). */
  nbrMaster?: boolean;
  lastReceived?: { flags: number; ddSeq: number };
  /** The last DBD sent (retransmitted as is). */
  lastSent?: { flags: number; ddSeq: number; headers: LayerSpec[] };
  /** Master: a DBD with M clear has been sent. */
  allSent: boolean;
  /** Keys still to describe, database order. */
  summary: string[];
  /** Link-state request list, insertion order. */
  readonly requests: Map<string, LsaInstance & { type: number; lsid: Ipv4Address; advRouter: Ipv4Address }>;
  /** Keys of the last LSR sent. */
  lastLsr: string[];
  /** Link-state retransmission list: key → the instance sent. */
  readonly rxmt: Map<string, LsaInstance>;
  rxmtArmed: boolean;
  exstartRetransmits: number;
  deadAt: SimTime;
  /** Database copies sent back to it (MinLSArrival). */
  readonly sentBack: Map<string, SimTime>;
  /** Fingerprint of the last row written. */
  rowFp?: string;
}

export interface Iface {
  readonly port: PortId;
  area: OspfAreaId;
  role: PortRole;
  networkType: OspfNetworkType;
  address?: Ipv4Address;
  prefixLen?: number;
  cost: number;
  costSource: 'bandwidth' | 'configured';
  priority: number;
  helloS: number;
  deadS: number;
  /** Configured passive (the row column). */
  passive: boolean;
  /** Sends no hello and takes no packet: passive, or a loopback. */
  silent: boolean;
  state: OspfIsmState;
  stateSince: SimTime;
  dr: Ipv4Address;
  bdr: Ipv4Address;
  drRid?: Ipv4Address;
  bdrRid?: Ipv4Address;
  waitUntil?: SimTime;
  helloDueAt?: SimTime;
  readonly joined: Set<Ipv4Address>;
  readonly nbrs: Map<Ipv4Address, Nbr>;
  rejected?: { from: Ipv4Address; routerId: Ipv4Address; reason: string; at: SimTime };
  helloCount: number;
  pairMark: number;
  replyArmed: boolean;
  drHelloArmed: boolean;
  rowFp?: string;
}

/** What one interface should look like after a resync. */
export interface IfaceWant {
  readonly port: PortId;
  readonly area: OspfAreaId;
  readonly role: PortRole;
  readonly networkType: OspfNetworkType;
  readonly address?: Ipv4Address;
  readonly prefixLen?: number;
  readonly cost: number;
  readonly costSource: 'bandwidth' | 'configured';
  readonly priority: number;
  readonly helloS: number;
  readonly deadS: number;
  readonly passive: boolean;
  readonly silent: boolean;
  readonly up: boolean;
}

/** The work of one handler call: actions in order, then the bundled updates and acknowledgements. */
export interface Out {
  readonly actions: Action[];
  readonly flood: Map<string, { port: PortId; dst: Ipv4Address; keys: Set<string> }>;
  readonly direct: Map<string, { port: PortId; dst: Ipv4Address; keys: Set<string> }>;
  readonly acks: Map<string, { port: PortId; dst: Ipv4Address; headers: Map<string, LayerSpec> }>;
  /** Interfaces with a pending NeighborChange. */
  readonly nbrChange: Set<PortId>;
  /** Self LSAs may need re-origination. */
  originate: boolean;
  /** MaxAge rows may be removable. */
  checkMaxAge: boolean;
}

export const num = (v: FieldValue | undefined, dflt = 0): number => (typeof v === 'number' && Number.isFinite(v) ? v : dflt);
export const str = (v: FieldValue | undefined): string => (typeof v === 'string' ? v : '');
const u32 = (a: Ipv4Address): number => ipv4ToU32(a);
const byRid = (a: { routerId: Ipv4Address }, b: { routerId: Ipv4Address }): number => u32(a.routerId) - u32(b.routerId);

/** `fn` of a row without its `updatedAt`, key order independent: the "a column changed" test of rule 20. */
function fingerprint(row: object): string {
  const rec = row as Record<string, unknown>;
  const parts: string[] = [];
  for (const k of Object.keys(rec).sort()) {
    if (k === 'updatedAt' || rec[k] === undefined) continue;
    parts.push(`${k}=${JSON.stringify(rec[k])}`);
  }
  return parts.join('|');
}

/** @since P3c One received packet as the family's demultiplexer reads its outer layers (`OspfFamily.decode`). */
export interface OspfPacketIn {
  /** Source and destination of the enclosing IP header (v2: IPv4; v3: the link-local source, ff02::5/6 or unicast). */
  readonly src: string;
  readonly dst: string;
  readonly version: number;
  readonly type: number;
  readonly routerId: Ipv4Address;
  readonly area: OspfAreaId;
  /** The header's checksum verdict (`false` = mismatch) and the codec's error text. */
  readonly checksumValid: FieldValue | undefined;
  readonly error?: string;
  /** The OSPF header's fields (hello, DBD and LSR bodies are read from them). */
  readonly fields: Readonly<Record<string, FieldValue>>;
  /** The chained LSA layers (full LSAs or header copies), in packet order. */
  readonly lsas: readonly LayerView[];
}

/**
 * @since P3c The LSA half of a family: wire forms, scopes, orders and the rows of self-originated LSAs. v2 is
 * protocols/ospf/lsdb.ts (types 1, 2, 5; scope = the area or 'as'); a v3 family adds the link scope (`link:<port>`,
 * type 0x0008) and the function-coded types 0x2001… through the same members.
 */
export interface OspfLsaOps {
  /** The PDU layer an LSA (or an LSA header copy) travels in ('ospf-lsa'; v3 'ospf6-lsa'). */
  readonly proto: ProtoName;
  /** One LSA layer's fields as an LSA (undefined when the header is incomplete). */
  wireOf(fields: Readonly<Record<string, FieldValue>>): OspfLsaWire | undefined;
  /** An LSA type the family speaks (anything else is a SeqNumberMismatch in a DBD, discarded in an update). */
  isKnownType(type: number): boolean;
  /** The flooding scope of an LSA of `type` received on `port` in `area` (or originated under the key scope `area`). */
  scopeOf(type: number, area: OspfAreaId, port?: PortId): OspfAreaId | 'as';
  /** The rows a database description to a neighbour on `i` summarises (unsorted). */
  forIface(rows: Iterable<OspfLsaRow>, i: Iface): OspfLsaRow[];
  /** An LSA of `scope` is flooded out `i`. */
  floodsOn(scope: OspfAreaId | 'as', i: Iface): boolean;
  /** Database order (§4.5). */
  sorted(rows: Iterable<OspfLsaRow>): OspfLsaRow[];
  /** A full LSA as an update carries it at `now`. */
  layerOf(row: OspfLsaRow, now: SimTime): LayerSpec;
  /** A header copy of an installed row at `now` (DBD). */
  headerLayerOf(row: OspfLsaRow, now: SimTime): LayerSpec;
  /** A header copy of a received LSA (acknowledgement). */
  wireHeaderLayerOf(w: OspfLsaWire): LayerSpec;
  /** The row of a received full LSA installed at `now`. */
  rowOf(w: OspfLsaWire, scope: OspfAreaId | 'as', now: SimTime, self: boolean): OspfLsaRow;
  /** The row of a self-originated LSA: `body` with sequence `seq`, its checksum and length, installed at `now`. */
  selfRowOf(key: string, scope: OspfAreaId | 'as', body: OspfLsaBody, seq: number, now: SimTime): OspfLsaRow;
  /** Content equality (the header is not content). */
  bodyEqual(a: Partial<OspfLsaBody>, b: Partial<OspfLsaBody>): boolean;
  /** The debug text of an LSA. */
  text(l: Pick<OspfLsaWire, 'type' | 'lsid' | 'advRouter' | 'seq'>): string;
  /** One link-state request entry, and the entries of a request packet. */
  requestEntryOf(type: number, lsid: Ipv4Address, advRouter: Ipv4Address): string;
  parseRequests(text: string): { type: number; lsid: Ipv4Address; advRouter: Ipv4Address }[];
  /** The router-LSA type (1; v3 0x2001): a self-war over it logs the router id conflict. */
  readonly routerType: number;
}

/** @since P3c What desiredSelf hands the family: the running process and the engine's interfaces. */
export interface OspfOriginView {
  readonly proc: Proc;
  readonly cfg: OspfConfig | undefined;
  /** Interfaces in canonical port order. */
  readonly ifaces: readonly Iface[];
  /** The areas of the interfaces, in first-seen canonical order. */
  readonly areas: readonly OspfAreaId[];
  readonly haveDefault: boolean;
  readonly lsdb: ReadonlyMap<string, OspfLsaRow>;
}

/**
 * @since P3c [S6] The OSPF family adapter (ARCHITECTURE-P3C D7): everything the shared engine does not know about the
 * address family and the packet version. One instance per daemon instance (it may keep per-instance state, as v2's IP
 * identification counter). v2: protocols/ospf/family-v4.ts; v3: family-v6.ts (W2a/W3a).
 */
export interface OspfFamily {
  /** The daemon name: the process of every debug event and the StateView, the owner of every request. */
  readonly name: ProcessName;
  /** The OSPF version a received packet must carry (2; v3 3). */
  readonly version: number;
  /** The `ctx.transition` machines ('ospf-if', 'ospf-nbr'; v3 'ospf6-if', 'ospf6-nbr'). */
  readonly machines: { readonly iface: FsmMachine; readonly nbr: FsmMachine };
  /** The three tables the engine writes. */
  readonly tables: { readonly interfaces: TableName; readonly neighbors: TableName; readonly lsdb: TableName };
  /** AllSPFRouters and AllDRouters (224.0.0.5/6; v3 ff02::5/6). */
  readonly allRouters: string;
  readonly allDRouters: string;
  /** The options of the DBD (and, through `helloFields`, the hello): v2 E 0x02; v3 V6|E|R 0x13. */
  readonly dbdOptions: number;
  readonly lsa: OspfLsaOps;

  // ── packets ──
  /** The outer layers of one packet from `i` to `dst` (the IP header and the OSPF header with `fields`). */
  packetLayers(proc: Proc, i: Iface, dst: string, type: number, fields: Record<string, FieldValue>): LayerSpec[];
  /** The `meta.flow` of a packet from `i` to `dst`. */
  flowOf(i: Iface, dst: string): string;
  /** The request that sends `pdu` out `i` to `dst` (v2 `ipv4.send`; v3 `ipv6.send`). */
  sendAction(proc: Proc, i: Iface, dst: string, type: number, pdu: Pdu): Action;
  /** The hello's body fields (undefined: `i` cannot send a hello yet, e.g. no prefix; v3 adds the interface id). */
  helloFields(i: Iface, heard: readonly Ipv4Address[]): Record<string, FieldValue> | undefined;
  /** The hello checks (undefined: `i` cannot check a hello yet, the packet is ignored). */
  checkHello(proc: Proc, i: Iface, f: Readonly<Record<string, FieldValue>>, src: string): OspfHelloCheck | undefined;
  /** Join or leave a multicast group on `port` (v2 `ipv4.group`; v3 `ipv6.group`). */
  groupAction(op: 'join' | 'leave', port: PortId, group: string): Action;
  /** The outer layers of a received packet, or undefined when it is not one of this family's packets. */
  decode(pdu: Pdu): OspfPacketIn | undefined;

  // ── origination and routes ──
  /** Every self LSA this router wants now, by key. */
  desiredSelf(view: OspfOriginView): Map<string, OspfLsaBody>;
  /** An LSA that names this router: its own advertising router, or a network-LSA for one of its addresses. */
  isSelf(ctx: ProcessCtx, proc: Proc, ifaces: ReadonlyMap<PortId, Iface>, w: Pick<OspfLsaWire, 'type' | 'lsid' | 'advRouter'>): boolean;
  /** The SPF of every area and the merged routes (rows in key order). */
  computeRoutes(lsdb: readonly OspfLsaRow[], routerId: Ipv4Address, areas: readonly OspfAreaRoot[], opts: { readonly maximumPaths: number; readonly now: SimTime }): { readonly rows: readonly TableRow[]; readonly routes: readonly unknown[]; readonly trees: { area: OspfAreaId; tree: SpfTree }[] };
  /** The ONE route batch of an SPF (v2 `ipv4.routes`; v3 `ipv6.routes`); `[]` withdraws every route. */
  routesAction(rows: readonly TableRow[]): Action;
  /** The debug text of one route row. */
  routeText(r: TableRow): string;
  /** The RIB watch request (v2 `ipv4.ribWatch`); `[]` stops watching. */
  watchAction(keys: readonly string[]): Action;

  // ── table rows ──
  ifRow(ctx: ProcessCtx, proc: Proc, i: Iface): TableRow;
  nbrRow(ctx: ProcessCtx, i: Iface, n: Nbr): TableRow;
  /** The `lsdb` table row of an installed LSA (v2: the row itself). */
  lsdbRow(row: OspfLsaRow): TableRow;

  // ── the daemon half (createOspfProcess) ──
  /** The device's configuration holds this family's process section. */
  hasSection(ctx: ProcessCtx): boolean;
  /** `delta` removes the section of the running process `pid` (stopped inside the configuration dispatch). */
  removesOwnSection(delta: ConfigDelta, pid: number): boolean;
  /** The request kind of `clear … ospf process`. */
  readonly clearKind: ProcessRequest['kind'];
  /** The coalesced `resync` timer fired: read the configuration and the ports, then reconcile the engine. */
  resync(eng: OspfEngine, ctx: ProcessCtx, out: Out): void;
  /** A transport event (v2: `ipv4.ribChanged`). */
  onEvent(eng: OspfEngine, ctx: ProcessCtx, ev: ProcessEvent): Action[];
}

/** @since P3c The OSPF adjacency engine (the module header): one instance per daemon instance. */
export function createOspfEngine(family: OspfFamily): OspfEngine {
  const NAME = family.name;
  const L = family.lsa;
  const ALL_ROUTERS = family.allRouters;
  const ALL_DROUTERS = family.allDRouters;
  /** flood.ts answers with the v2 group addresses: this family's groups (the identity for v2). */
  const groupOf = (d: string): string => (d === OSPF_ALL_ROUTERS ? ALL_ROUTERS : d === OSPF_ALL_DROUTERS ? ALL_DROUTERS : d);
  let proc: Proc | undefined;
  let cfg: OspfConfig | undefined;
  const ifaces = new Map<PortId, Iface>();
  /** The LSDB (the `ospf-lsdb` table mirrors it). */
  const lsdb = new Map<string, OspfLsaRow>();
  const lastOrig = new Map<string, SimTime>();
  const genDue = new Map<string, SimTime>();
  const warDue = new Map<string, SimTime>();
  const warSeen = new Map<string, { at: SimTime; count: number; logged: boolean }>();
  /** Keys whose database copy answered one of our link-state requests (not "received via flooding": no MinLSArrival). */
  const byRequest = new Set<string>();
  let spfDue: SimTime | undefined;
  let spfReason: string | undefined;
  let lastSpfAt: SimTime | undefined;
  let spfRuns = 0;
  let lastSpfReason: string | undefined;
  let inSpf = false;
  let trees: { area: OspfAreaId; tree: SpfTree }[] = [];
  let routesSent = false;
  let lastRoutes: readonly TableRow[] = [];
  let watchKeys: string[] = [];
  let haveDefault = false;
  let refreshAt: SimTime | undefined;
  let maxageArmed = false;
  let resyncArmed = false;
  let noRidLogged = false;
  const ring: DebugEvent[] = [];

  // ── debug ─────────────────────────────────────────────────────────────────

  function record(ctx: ProcessCtx, category: string, message: string, data?: Record<string, unknown>): void {
    const ev: DebugEvent = data === undefined
      ? { at: ctx.now, device: ctx.deviceId, process: NAME, category, message }
      : { at: ctx.now, device: ctx.deviceId, process: NAME, category, message, data };
    ring.push(ev);
    if (ring.length > DEBUG_RING) ring.splice(0, ring.length - DEBUG_RING);
  }

  function debug(ctx: ProcessCtx, category: string, message: string, data?: Record<string, unknown>): void {
    ctx.debug(category, message, data);
    record(ctx, category, message, data);
  }

  function transition(ctx: ProcessCtx, message: string, fsm: FsmTransition): void {
    ctx.transition(OSPF_DEBUG.adj, message, fsm);
    record(ctx, OSPF_DEBUG.adj, message, { fsm });
  }

  // ── tables ────────────────────────────────────────────────────────────────

  const ifTable = (ctx: ProcessCtx): Table<TableRow> | undefined => ctx.tables.get<TableRow>(family.tables.interfaces);
  const nbrTable = (ctx: ProcessCtx): Table<TableRow> | undefined => ctx.tables.get<TableRow>(family.tables.neighbors);
  const lsdbTable = (ctx: ProcessCtx): Table<TableRow> | undefined => ctx.tables.get<TableRow>(family.tables.lsdb);

  function writeIfRow(ctx: ProcessCtx, i: Iface): void {
    if (proc === undefined) return;
    const row = family.ifRow(ctx, proc, i);
    const fp = fingerprint(row);
    if (fp === i.rowFp) return;
    i.rowFp = fp;
    ifTable(ctx)?.set(row);
  }

  function writeNbrRow(ctx: ProcessCtx, i: Iface, n: Nbr): void {
    const row = family.nbrRow(ctx, i, n);
    const fp = fingerprint(row);
    if (fp === n.rowFp) return;
    n.rowFp = fp;
    nbrTable(ctx)?.set(row);
  }

  function installRow(ctx: ProcessCtx, row: OspfLsaRow): void {
    lsdb.set(row.key, row);
    lsdbTable(ctx)?.set(family.lsdbRow(row));
  }

  function removeRow(ctx: ProcessCtx, key: string, reason: 'aged' | 'cleared'): void {
    if (!lsdb.delete(key)) return;
    lsdbTable(ctx)?.delete(key, reason);
  }

  // ── timers ────────────────────────────────────────────────────────────────

  const timer = (key: string, delay: SimTime, periodic = false): Action =>
    periodic ? { type: 'timer', key, delay: Math.max(0, delay), periodic: true } : { type: 'timer', key, delay: Math.max(0, delay) };
  const cancel = (key: string): Action => ({ type: 'cancelTimer', key });

  function armResync(): Action[] {
    if (resyncArmed) return [];
    resyncArmed = true;
    return [timer('resync', 0)];
  }

  // ── output ────────────────────────────────────────────────────────────────

  function newOut(): Out {
    return { actions: [], flood: new Map(), direct: new Map(), acks: new Map(), nbrChange: new Set(), originate: false, checkMaxAge: false };
  }

  /** Run `fn` with an accumulator, settle the elections, origination and MaxAge removals, then emit the bundles. */
  function run(ctx: ProcessCtx, fn: (out: Out) => void): Action[] {
    const out = newOut();
    fn(out);
    settle(ctx, out);
    finish(ctx, out);
    return out.actions;
  }

  function settle(ctx: ProcessCtx, out: Out): void {
    for (let guard = 0; guard < 64; guard++) {
      settleNeighborChanges(ctx, out);
      if (out.originate) {
        out.originate = false;
        if (proc !== undefined) originateAll(ctx, out);
      }
      if (out.checkMaxAge) {
        out.checkMaxAge = false;
        removeAckedMaxAge(ctx);
      }
      if (out.nbrChange.size === 0 && !out.originate && !out.checkMaxAge) return;
    }
  }

  /** Build and send one OSPF packet out `i` to `dst`. */
  function sendPacket(ctx: ProcessCtx, out: Out, i: Iface, dst: string, type: number, fields: Record<string, FieldValue>, inner: readonly LayerSpec[], detail: string): Pdu | undefined {
    if (proc === undefined || i.address === undefined) return undefined;
    const tag = type === OSPF_PACKET.hello ? 'ospf-hello' : type === OSPF_PACKET.dbd ? 'ospf-dbd' : type === OSPF_PACKET.lsr ? 'ospf-lsr' : type === OSPF_PACKET.lsu ? 'ospf-lsu' : 'ospf-lsack';
    const meta: Partial<PduMeta> = { tag, flow: family.flowOf(i, dst), ...(type === OSPF_PACKET.hello ? { background: true } : {}) };
    const layers: LayerSpec[] = [...family.packetLayers(proc, i, dst, type, fields), ...inner];
    const pdu = ctx.newPdu(layers, meta);
    debug(ctx, OSPF_DEBUG.packet, `${i.port}: sent ${ospfPacketText(type)} to ${dst}${detail === '' ? '' : `, ${detail}`} (pdu ${pdu.id})`, { port: i.port, dst, type, pdu: pdu.id });
    out.actions.push(family.sendAction(proc, i, dst, type, pdu));
    return pdu;
  }

  function sendHello(ctx: ProcessCtx, out: Out, i: Iface, why: string): void {
    const heard = [...i.nbrs.values()].filter((n) => nsmAtLeast(n.state, 'init')).sort(byRid).map((n) => n.routerId);
    const fields = family.helloFields(i, heard);
    if (fields === undefined) return;
    i.helloCount++;
    debug(ctx, OSPF_DEBUG.hello, `${i.port}: hello sent (${why}): DR ${i.dr}, BDR ${i.bdr}, neighbours ${heard.length === 0 ? 'none' : heard.join(', ')}`, { port: i.port, dr: i.dr, bdr: i.bdr, neighbors: heard });
    sendPacket(ctx, out, i, ALL_ROUTERS, OSPF_PACKET.hello, fields, [], `DR ${i.dr} BDR ${i.bdr}`);
  }

  function sendDbd(ctx: ProcessCtx, out: Out, i: Iface, n: Nbr, flags: number, headers: LayerSpec[]): void {
    n.lastSent = { flags, ddSeq: n.ddSeq, headers };
    resendDbd(ctx, out, i, n);
  }

  function resendDbd(ctx: ProcessCtx, out: Out, i: Iface, n: Nbr): void {
    const s = n.lastSent;
    if (s === undefined) return;
    const mtu = ctx.ports.get(i.port)?.mtu ?? OSPF_DBD_MTU_DEFAULT;
    sendPacket(ctx, out, i, groupOf(directDestination(i.networkType, n.address)), OSPF_PACKET.dbd, { mtu, options: family.dbdOptions, flags: s.flags, ddSeq: s.ddSeq >>> 0 }, s.headers, `seq ${s.ddSeq}, flags ${ddFlagsText(s.flags)}, ${s.headers.length} headers`);
  }

  function sendLsr(ctx: ProcessCtx, out: Out, i: Iface, n: Nbr): void {
    const batch = [...n.requests.entries()].slice(0, OSPF_LSR_MAX_ENTRIES);
    if (batch.length === 0) return;
    n.lastLsr = batch.map(([k]) => k);
    const requests = batch.map(([, r]) => L.requestEntryOf(r.type, r.lsid, r.advRouter)).join(';');
    debug(ctx, OSPF_DEBUG.flood, `${i.port}: requesting ${batch.length} ${batch.length === 1 ? 'LSA' : 'LSAs'} from ${n.routerId}`, { port: i.port, neighbor: n.routerId, requests });
    sendPacket(ctx, out, i, groupOf(directDestination(i.networkType, n.address)), OSPF_PACKET.lsr, { requests }, [], `${batch.length} requests`);
  }

  function armRxmt(n: Nbr, out: Out): void {
    if (n.rxmtArmed) return;
    n.rxmtArmed = true;
    out.actions.push(timer(`rxmt:${n.port}:${n.routerId}`, OSPF_RXMT_NS, true));
  }

  function queueFlood(out: Out, port: PortId, dst: string, key: string): void {
    const k = `${port}|${dst}`;
    let e = out.flood.get(k);
    if (e === undefined) {
      e = { port, dst, keys: new Set() };
      out.flood.set(k, e);
    }
    e.keys.add(key);
  }

  function queueDirect(out: Out, i: Iface, n: Nbr, key: string): void {
    const dst = groupOf(directDestination(i.networkType, n.address));
    const k = `${i.port}|${dst}`;
    let e = out.direct.get(k);
    if (e === undefined) {
      e = { port: i.port, dst, keys: new Set() };
      out.direct.set(k, e);
    }
    e.keys.add(key);
  }

  function queueAck(out: Out, i: Iface, n: Nbr, w: OspfLsaWire): void {
    const dst = groupOf(directDestination(i.networkType, n.address));
    const k = `${i.port}|${dst}`;
    let e = out.acks.get(k);
    if (e === undefined) {
      e = { port: i.port, dst, headers: new Map() };
      out.acks.set(k, e);
    }
    e.headers.set(lsaKeyOf(L.scopeOf(w.type, i.area, i.port), w.type, w.lsid, w.advRouter), L.wireHeaderLayerOf(w));
  }

  /** Emit the bundled updates (flooded, then direct) and acknowledgements of this handler call. */
  function finish(ctx: ProcessCtx, out: Out): void {
    const updates = (bundles: Map<string, { port: PortId; dst: string; keys: Set<string> }>, kind: string): void => {
      for (const b of bundles.values()) {
        const i = ifaces.get(b.port);
        if (i === undefined || i.state === 'down') continue;
        const rows = L.sorted([...b.keys].map((k) => lsdb.get(k)).filter((r): r is OspfLsaRow => r !== undefined));
        let chunk: OspfLsaRow[] = [];
        let bytes = 4;
        const flush = (): void => {
          if (chunk.length === 0) return;
          debug(ctx, OSPF_DEBUG.flood, `${i.port}: ${kind} update to ${b.dst}: ${chunk.map((r) => L.text(r)).join('; ')}`, { port: i.port, dst: b.dst, lsas: chunk.map((r) => r.key) });
          sendPacket(ctx, out, i, b.dst, OSPF_PACKET.lsu, {}, chunk.map((r) => L.layerOf(r, ctx.now)), `${chunk.length} ${chunk.length === 1 ? 'LSA' : 'LSAs'}`);
          chunk = [];
          bytes = 4;
        };
        for (const r of rows) {
          if (chunk.length > 0 && bytes + r.length > OSPF_MAX_BODY) flush();
          chunk.push(r);
          bytes += r.length;
        }
        flush();
      }
    };
    updates(out.flood, 'flooding');
    updates(out.direct, 'direct');
    for (const a of out.acks.values()) {
      const i = ifaces.get(a.port);
      if (i === undefined || i.state === 'down') continue;
      const headers = [...a.headers.values()];
      for (let at = 0; at < headers.length; at += OSPF_DBD_MAX_HEADERS) {
        const part = headers.slice(at, at + OSPF_DBD_MAX_HEADERS);
        debug(ctx, OSPF_DEBUG.flood, `${i.port}: acknowledging ${part.length} ${part.length === 1 ? 'LSA' : 'LSAs'} to ${a.dst}`, { port: i.port, dst: a.dst });
        sendPacket(ctx, out, i, a.dst, OSPF_PACKET.lsack, {}, part, `${part.length} headers`);
      }
    }
    out.flood.clear();
    out.direct.clear();
    out.acks.clear();
  }

  // ── interfaces ────────────────────────────────────────────────────────────

  /** Interfaces in canonical port order. */
  function ordered(ctx: ProcessCtx): Iface[] {
    const out: Iface[] = [];
    for (const id of ctx.ports.keys()) {
      const i = ifaces.get(id);
      if (i !== undefined) out.push(i);
    }
    for (const i of ifaces.values()) if (!ctx.ports.has(i.port)) out.push(i);
    return out;
  }

  const running = (i: Iface): boolean => i.state !== 'down';

  function wantedGroups(i: Iface): string[] {
    if (proc === undefined || i.silent || i.state === 'down' || i.state === 'loopback') return [];
    return i.state === 'dr' || i.state === 'backup' ? [ALL_ROUTERS, ALL_DROUTERS] : [ALL_ROUTERS];
  }

  function syncGroups(out: Out, i: Iface): void {
    const want = wantedGroups(i);
    for (const g of [ALL_ROUTERS, ALL_DROUTERS]) {
      const has = i.joined.has(g);
      const should = want.includes(g);
      if (has === should) continue;
      if (should) i.joined.add(g);
      else i.joined.delete(g);
      out.actions.push(family.groupAction(should ? 'join' : 'leave', i.port, g));
    }
  }

  function setIfState(ctx: ProcessCtx, out: Out, i: Iface, to: OspfIsmState, cause: string): void {
    const from = i.state;
    if (from === to) return;
    i.state = to;
    i.stateSince = ctx.now;
    transition(ctx, `${i.port}: interface ${from} -> ${to} (${cause})`, { machine: family.machines.iface, subject: i.port, port: i.port, from, to, cause });
    if (from === 'waiting') {
      i.waitUntil = undefined;
      out.actions.push(cancel(`wait:${i.port}`));
    }
    syncGroups(out, i);
    writeIfRow(ctx, i);
    out.originate = true;
  }

  function interfaceUp(ctx: ProcessCtx, out: Out, i: Iface): void {
    const cause = OSPF_ISM_EVENT_NAMES['interface-up'];
    if (i.silent) {
      if (i.networkType === 'broadcast' && i.address !== undefined) {
        // a passive LAN can have no neighbour: it elects itself at once (no wait)
        const r = electDesignatedRouter({ routerId: proc!.routerId, address: i.address, priority: i.priority, dr: OSPF_NO_DR, bdr: OSPF_NO_DR }, []);
        i.dr = r.dr;
        i.bdr = r.bdr;
        i.drRid = r.drRouterId;
        i.bdrRid = r.bdrRouterId;
        setIfState(ctx, out, i, r.state, cause);
      } else {
        setIfState(ctx, out, i, i.networkType === 'loopback' ? 'loopback' : 'point-to-point', cause);
      }
      writeIfRow(ctx, i);
      return;
    }
    const o = ismOutcome('down', 'interface-up', { networkType: i.networkType, priority: i.priority });
    if (o.kind !== 'goto') return;
    if (o.to === 'waiting') {
      i.waitUntil = ctx.now + i.deadS * SEC;
      out.actions.push(timer(`wait:${i.port}`, i.deadS * SEC));
    }
    setIfState(ctx, out, i, o.to, cause);
    sendHello(ctx, out, i, 'interface up');
    i.helloDueAt = ctx.now + i.helloS * SEC;
    out.actions.push(timer(`hello:${i.port}`, i.helloS * SEC, true));
    writeIfRow(ctx, i);
  }

  function interfaceDown(ctx: ProcessCtx, out: Out, i: Iface, cause: string, nbrEvent: OspfNsmEvent, rowReason: 'link-down' | 'cleared'): void {
    for (const n of [...i.nbrs.values()].sort(byRid)) killNbr(ctx, out, i, n, nbrEvent, rowReason);
    out.nbrChange.delete(i.port);
    for (const k of ['hello', 'wait', 'hello-reply', 'dr-hello']) out.actions.push(cancel(`${k}:${i.port}`));
    i.replyArmed = false;
    i.drHelloArmed = false;
    i.helloDueAt = undefined;
    i.dr = OSPF_NO_DR;
    i.bdr = OSPF_NO_DR;
    i.drRid = undefined;
    i.bdrRid = undefined;
    setIfState(ctx, out, i, 'down', cause);
    syncGroups(out, i);
    writeIfRow(ctx, i);
  }

  /** RFC 2328 §9.4 on `i`, then AdjOK? for its neighbours (D9: the DR-change hello). */
  function elect(ctx: ProcessCtx, out: Out, i: Iface, cause: string): void {
    if (proc === undefined || i.address === undefined) return;
    const self: OspfDrCandidate = { routerId: proc.routerId, address: i.address, priority: i.priority, dr: i.dr, bdr: i.bdr };
    const cands: OspfDrCandidate[] = [...i.nbrs.values()]
      .filter((n) => nsmAtLeast(n.state, '2way'))
      .sort(byRid)
      .map((n) => ({ routerId: n.routerId, address: n.address, priority: n.priority, dr: n.declared?.dr ?? OSPF_NO_DR, bdr: n.declared?.bdr ?? OSPF_NO_DR }));
    const r = electDesignatedRouter(self, cands);
    const changed = r.dr !== i.dr || r.bdr !== i.bdr;
    i.dr = r.dr;
    i.bdr = r.bdr;
    i.drRid = r.drRouterId;
    i.bdrRid = r.bdrRouterId;
    setIfState(ctx, out, i, r.state, cause);
    debug(ctx, OSPF_DEBUG.adj, `${i.port} election: DR ${r.drRouterId ?? 'none'} (${r.dr}), BDR ${r.bdrRouterId ?? 'none'} (${r.bdr})`, { port: i.port, dr: r.dr, bdr: r.bdr, reran: r.reran });
    if (changed) {
      i.pairMark = i.helloCount;
      if (!i.drHelloArmed && !i.silent) {
        i.drHelloArmed = true;
        out.actions.push(timer(`dr-hello:${i.port}`, 0));
      }
      out.originate = true;
    }
    adjOk(ctx, out, i);
    for (const n of i.nbrs.values()) writeNbrRow(ctx, i, n);
    writeIfRow(ctx, i);
  }

  /** AdjOK? (RFC 2328 §10.4) for every neighbour of `i` at 2-Way or later. */
  function adjOk(ctx: ProcessCtx, out: Out, i: Iface): void {
    if (i.address === undefined) return;
    for (const n of [...i.nbrs.values()].sort(byRid)) {
      if (!nsmAtLeast(n.state, '2way')) continue;
      const ok = ospfAdjacencyOk(i.networkType, { address: i.address, dr: i.dr, bdr: i.bdr }, n.address);
      if (n.state === '2way' && ok) enterExStart(ctx, out, i, n, OSPF_NSM_EVENT_NAMES['adj-ok'], false);
      else if (nsmAtLeast(n.state, 'exstart') && !ok) {
        clearExchange(n, out);
        setNbrState(ctx, out, i, n, '2way', OSPF_NSM_EVENT_NAMES['adj-ok']);
      }
    }
  }

  function settleNeighborChanges(ctx: ProcessCtx, out: Out): void {
    for (let guard = 0; guard < 64 && out.nbrChange.size > 0; guard++) {
      const port = out.nbrChange.values().next().value as PortId;
      out.nbrChange.delete(port);
      const i = ifaces.get(port);
      if (i === undefined) continue;
      const o = ismOutcome(i.state, 'neighbor-change', { networkType: i.networkType, priority: i.priority });
      if (o.kind === 'elect') elect(ctx, out, i, OSPF_ISM_EVENT_NAMES['neighbor-change']);
    }
  }

  // ── neighbours ────────────────────────────────────────────────────────────

  function newNbr(ctx: ProcessCtx, port: PortId, routerId: Ipv4Address, address: Ipv4Address, priority: number): Nbr {
    return {
      port,
      routerId,
      address,
      priority,
      state: 'down',
      stateSince: ctx.now,
      attempt: 0,
      ddSeq: 0,
      master: true,
      allSent: false,
      summary: [],
      requests: new Map(),
      lastLsr: [],
      rxmt: new Map(),
      rxmtArmed: false,
      exstartRetransmits: 0,
      deadAt: ctx.now,
      sentBack: new Map(),
    };
  }

  function clearExchange(n: Nbr, out: Out): void {
    n.summary = [];
    n.requests.clear();
    n.lastLsr = [];
    if (n.rxmt.size > 0) out.checkMaxAge = true;
    n.rxmt.clear();
    n.lastSent = undefined;
    n.lastReceived = undefined;
    n.allSent = false;
    n.exstartRetransmits = 0;
  }

  function setNbrState(ctx: ProcessCtx, out: Out, i: Iface, n: Nbr, to: OspfNsmState, cause: string, pdu?: Pdu): void {
    const from = n.state;
    if (from === to) return;
    n.state = to;
    n.stateSince = ctx.now;
    const fsm: FsmTransition = { machine: family.machines.nbr, subject: `${i.port} ${n.routerId}`, port: i.port, from, to, cause, ...(pdu !== undefined ? { pdu: pdu.id } : {}) };
    transition(ctx, `${i.port}: neighbour ${n.routerId} (${n.address}) ${from} -> ${to} (${cause})`, fsm);
    if (nsmRank(to) < nsmRank('exstart')) clearExchange(n, out);
    if ((from === 'exchange' || from === 'loading') && to !== 'exchange' && to !== 'loading') out.checkMaxAge = true;
    const two = nsmRank('2way');
    if ((nsmRank(from) >= two) !== (nsmRank(to) >= two)) out.nbrChange.add(i.port);
    if (from === 'full' || to === 'full') out.originate = true;
    if (to === 'down') {
      i.nbrs.delete(n.routerId);
      out.actions.push(cancel(`dead:${i.port}:${n.routerId}`), cancel(`rxmt:${i.port}:${n.routerId}`));
      n.rxmtArmed = false;
    } else {
      writeNbrRow(ctx, i, n);
    }
    writeIfRow(ctx, i);
  }

  function killNbr(ctx: ProcessCtx, out: Out, i: Iface, n: Nbr, ev: OspfNsmEvent, reason: 'aged' | 'link-down' | 'cleared' | 'replaced'): void {
    setNbrState(ctx, out, i, n, 'down', OSPF_NSM_EVENT_NAMES[ev]);
    nbrTable(ctx)?.delete(ospfNbrKey(i.port, n.routerId), reason);
  }

  function enterExStart(ctx: ProcessCtx, out: Out, i: Iface, n: Nbr, cause: string, restart: boolean): void {
    if (proc === undefined) return;
    if (restart) n.attempt++;
    clearExchange(n, out);
    n.ddSeq = ospfDdSeqInitial(proc.routerId, n.routerId, n.attempt);
    n.master = true;
    n.nbrMaster = undefined;
    setNbrState(ctx, out, i, n, 'exstart', cause);
    writeNbrRow(ctx, i, n);
    sendDbd(ctx, out, i, n, OSPF_DD_FLAG.I | OSPF_DD_FLAG.M | OSPF_DD_FLAG.MS, []);
    armRxmt(n, out);
  }

  /** NegotiationDone: Exchange, with the summary of every LSA of the area (MaxAge copies left out). */
  function negotiationDone(ctx: ProcessCtx, out: Out, i: Iface, n: Nbr): void {
    n.summary = L.sorted(L.forIface(lsdb.values(), i))
      .filter((r) => r.maxAge !== true)
      .map((r) => r.key);
    n.allSent = false;
    setNbrState(ctx, out, i, n, 'exchange', OSPF_NSM_EVENT_NAMES['negotiation-done']);
    writeNbrRow(ctx, i, n);
  }

  /** The next chunk of the summary list as header copies. */
  function nextHeaders(ctx: ProcessCtx, n: Nbr): { headers: LayerSpec[]; more: boolean } {
    const headers: LayerSpec[] = [];
    while (n.summary.length > 0 && headers.length < OSPF_DBD_MAX_HEADERS) {
      const key = n.summary.shift()!;
      const row = lsdb.get(key);
      if (row !== undefined) headers.push(L.headerLayerOf(row, ctx.now));
    }
    return { headers, more: n.summary.length > 0 };
  }

  /** Read the LSA headers of a DBD into the request list; false on an unknown LSA type (SeqNumberMismatch). */
  function takeHeaders(ctx: ProcessCtx, i: Iface, n: Nbr, layers: readonly LayerView[]): boolean {
    for (const l of layers) {
      const w = L.wireOf(l.fields);
      if (w === undefined || !L.isKnownType(w.type)) return false;
      const key = lsaKeyOf(L.scopeOf(w.type, i.area, i.port), w.type, w.lsid, w.advRouter);
      const db = lsdb.get(key);
      if (db === undefined || compareLsaInstances(wireInstance(w), rowInstance(db, ctx.now)) > 0) {
        n.requests.set(key, { ...wireInstance(w), type: w.type, lsid: w.lsid, advRouter: w.advRouter });
      }
    }
    return true;
  }

  function exchangeDone(ctx: ProcessCtx, out: Out, i: Iface, n: Nbr): void {
    if (n.requests.size === 0) {
      setNbrState(ctx, out, i, n, 'full', OSPF_NSM_EVENT_NAMES['exchange-done']);
      return;
    }
    setNbrState(ctx, out, i, n, 'loading', OSPF_NSM_EVENT_NAMES['exchange-done']);
    sendLsr(ctx, out, i, n);
    armRxmt(n, out);
  }

  /** Master: the slave's packet was accepted (RFC 2328 §10.8). */
  function masterNext(ctx: ProcessCtx, out: Out, i: Iface, n: Nbr, theirMore: boolean): void {
    n.ddSeq = (n.ddSeq + 1) >>> 0;
    if (n.allSent && !theirMore) {
      exchangeDone(ctx, out, i, n);
      return;
    }
    const { headers, more } = nextHeaders(ctx, n);
    if (!more) n.allSent = true;
    sendDbd(ctx, out, i, n, OSPF_DD_FLAG.MS | (more ? OSPF_DD_FLAG.M : 0), headers);
    armRxmt(n, out);
  }

  /** Slave: answer the master's packet with the next chunk (same sequence number). */
  function slaveAnswer(ctx: ProcessCtx, out: Out, i: Iface, n: Nbr, theirMore: boolean): void {
    const { headers, more } = nextHeaders(ctx, n);
    sendDbd(ctx, out, i, n, more ? OSPF_DD_FLAG.M : 0, headers);
    if (!theirMore && !more) exchangeDone(ctx, out, i, n);
  }

  // ── receive ───────────────────────────────────────────────────────────────

  function rxHello(ctx: ProcessCtx, out: Out, i: Iface, pdu: Pdu, src: string, f: Readonly<Record<string, FieldValue>>): void {
    if (proc === undefined || i.address === undefined) return;
    const check = family.checkHello(proc, i, f, src);
    if (check === undefined) return;
    const routerId = str(f.routerId);
    if (!check.ok) {
      i.rejected = { from: src, routerId, reason: check.text, at: ctx.now };
      debug(ctx, OSPF_DEBUG.hello, `${i.port}: hello from ${routerId} (${src}) refused: ${check.text}`, { port: i.port, from: src, routerId, reason: check.reason });
      if (check.reason === 'router-id') logConflict(ctx, out, `${i.port}|${src}`, `OSPF process ${proc.pid}: ${src} on ${i.port} uses this router's own router ID ${proc.routerId}; no adjacency forms with it.`);
      writeIfRow(ctx, i);
      out.actions.push({ type: 'drop', pdu, reason: 'other', detail: `OSPF hello refused: ${check.text}`, port: i.port });
      return;
    }
    const priority = num(f.priority, 1);
    const dr = str(f.dr) || OSPF_NO_DR;
    const bdr = str(f.bdr) || OSPF_NO_DR;
    const listed = str(f.neighbors).split(',').map((s) => s.trim()).filter((s) => s !== '');
    debug(ctx, OSPF_DEBUG.hello, `${i.port}: hello from ${routerId} (${src}): priority ${priority}, DR ${dr}, BDR ${bdr}, ${listed.includes(proc.routerId) ? 'lists' : 'does not list'} this router`, { port: i.port, from: src, routerId, dr, bdr, priority });
    // another router id now at this address replaces the old neighbour (broadcast networks name neighbours by address)
    for (const other of [...i.nbrs.values()]) {
      if (other.routerId !== routerId && other.address === src) killNbr(ctx, out, i, other, 'kill-nbr', 'replaced');
    }
    let n = i.nbrs.get(routerId);
    if (n === undefined) {
      n = newNbr(ctx, i.port, routerId, src, priority);
      i.nbrs.set(routerId, n);
      setNbrState(ctx, out, i, n, 'init', OSPF_NSM_EVENT_NAMES['hello-received'], pdu);
      if (!i.replyArmed) {
        i.replyArmed = true;
        out.actions.push(timer(`hello-reply:${i.port}`, OSPF_HELLO_REPLY_NS));
      }
    }
    n.address = src;
    n.deadAt = ctx.now + i.deadS * SEC;
    out.actions.push(timer(`dead:${i.port}:${routerId}`, i.deadS * SEC, true));
    const before = n.declared;
    const now: OspfHelloDeclaration = { dr, bdr, priority };
    let electNow = false;
    if (listed.includes(proc.routerId)) {
      if (n.state === 'init') setNbrState(ctx, out, i, n, '2way', OSPF_NSM_EVENT_NAMES['2-way-received'], pdu);
      for (const e of drEventsFromHello(i.state, before, { address: src, ...now })) {
        if (ismOutcome(i.state, e, { networkType: i.networkType, priority: i.priority }).kind === 'elect') electNow = true;
      }
      if (out.nbrChange.has(i.port)) {
        out.nbrChange.delete(i.port);
        if (ismOutcome(i.state, 'neighbor-change', { networkType: i.networkType, priority: i.priority }).kind === 'elect') electNow = true;
      }
    } else if (nsmAtLeast(n.state, '2way')) {
      setNbrState(ctx, out, i, n, 'init', OSPF_NSM_EVENT_NAMES['1-way-received'], pdu);
    }
    n.declared = now;
    n.priority = priority;
    if (electNow) elect(ctx, out, i, i.state === 'waiting' ? OSPF_ISM_EVENT_NAMES['backup-seen'] : OSPF_ISM_EVENT_NAMES['neighbor-change']);
    adjOk(ctx, out, i);
    writeNbrRow(ctx, i, n);
    writeIfRow(ctx, i);
    out.actions.push({ type: 'consume', pdu });
  }

  function rxDbd(ctx: ProcessCtx, out: Out, i: Iface, n: Nbr, pdu: Pdu, f: Readonly<Record<string, FieldValue>>, lsas: readonly LayerView[]): void {
    if (proc === undefined) return;
    if (n.state === 'init') {
      // §3.1 step 7, RFC 2328 §10.6: a DBD from a neighbour in Init is 2-WayReceived first
      setNbrState(ctx, out, i, n, '2way', OSPF_NSM_EVENT_NAMES['2-way-received'], pdu);
      settleNeighborChanges(ctx, out);
      adjOk(ctx, out, i);
    }
    const flags = num(f.flags);
    const ddSeq = num(f.ddSeq) >>> 0;
    const theirMore = (flags & OSPF_DD_FLAG.M) !== 0;
    const v = dbdVerdict(
      { state: n.state, master: n.master, ddSeq: n.ddSeq, ownRouterId: proc.routerId, ...(n.lastReceived !== undefined ? { lastReceived: n.lastReceived } : {}) },
      { flags, ddSeq, routerId: n.routerId, empty: lsas.length === 0 },
    );
    debug(ctx, OSPF_DEBUG.adj, `${i.port}: database description from ${n.routerId}: seq ${ddSeq}, flags ${ddFlagsText(flags)}, ${lsas.length} headers (${v})`, { port: i.port, neighbor: n.routerId, ddSeq, flags, verdict: v });
    out.actions.push({ type: 'consume', pdu });
    switch (v) {
      case 'slave':
        n.master = false;
        n.nbrMaster = true;
        n.ddSeq = ddSeq;
        n.lastReceived = { flags, ddSeq };
        negotiationDone(ctx, out, i, n);
        if (!takeHeaders(ctx, i, n, lsas)) return mismatch(ctx, out, i, n);
        slaveAnswer(ctx, out, i, n, theirMore);
        return;
      case 'master':
        n.master = true;
        n.nbrMaster = false;
        n.lastReceived = { flags, ddSeq };
        negotiationDone(ctx, out, i, n);
        if (!takeHeaders(ctx, i, n, lsas)) return mismatch(ctx, out, i, n);
        masterNext(ctx, out, i, n, theirMore);
        return;
      case 'accept':
        n.lastReceived = { flags, ddSeq };
        if (!takeHeaders(ctx, i, n, lsas)) return mismatch(ctx, out, i, n);
        if (n.master) masterNext(ctx, out, i, n, theirMore);
        else {
          n.ddSeq = ddSeq;
          slaveAnswer(ctx, out, i, n, theirMore);
        }
        return;
      case 'duplicate':
        if (!n.master) resendDbd(ctx, out, i, n);
        return;
      case 'mismatch':
        mismatch(ctx, out, i, n);
        return;
      default:
        return;
    }
  }

  function mismatch(ctx: ProcessCtx, out: Out, i: Iface, n: Nbr): void {
    enterExStart(ctx, out, i, n, OSPF_NSM_EVENT_NAMES['seq-number-mismatch'], true);
  }

  function rxLsr(ctx: ProcessCtx, out: Out, i: Iface, n: Nbr, pdu: Pdu, f: Readonly<Record<string, FieldValue>>): void {
    out.actions.push({ type: 'consume', pdu });
    if (!nsmAtLeast(n.state, 'exchange')) return;
    const entries = L.parseRequests(str(f.requests));
    debug(ctx, OSPF_DEBUG.flood, `${i.port}: ${n.routerId} requests ${entries.length} ${entries.length === 1 ? 'LSA' : 'LSAs'}`, { port: i.port, neighbor: n.routerId });
    for (const e of entries) {
      const key = lsaKeyOf(L.scopeOf(e.type, i.area, i.port), e.type, e.lsid, e.advRouter);
      if (!lsdb.has(key)) {
        enterExStart(ctx, out, i, n, OSPF_NSM_EVENT_NAMES['bad-ls-req'], true);
        return;
      }
      queueDirect(out, i, n, key);
    }
  }

  function anyExchanging(): boolean {
    for (const i of ifaces.values()) for (const n of i.nbrs.values()) if (n.state === 'exchange' || n.state === 'loading') return true;
    return false;
  }

  function isSelf(ctx: ProcessCtx, w: Pick<OspfLsaWire, 'type' | 'lsid' | 'advRouter'>): boolean {
    if (proc === undefined) return false;
    return family.isSelf(ctx, proc, ifaces, w);
  }

  function rxLsu(ctx: ProcessCtx, out: Out, i: Iface, n: Nbr, pdu: Pdu, lsas: readonly LayerView[]): void {
    out.actions.push({ type: 'consume', pdu });
    if (!nsmAtLeast(n.state, 'exchange') || proc === undefined) return;
    for (const l of lsas) {
      const w = L.wireOf(l.fields);
      if (w === undefined || w.checksumValid === false || !L.isKnownType(w.type)) {
        debug(ctx, OSPF_DEBUG.flood, `${i.port}: discarded an LSA from ${n.routerId}: ${w === undefined ? 'incomplete header' : w.checksumValid === false ? 'bad checksum' : `unknown type ${w.type}`}`, { port: i.port });
        continue;
      }
      const scope = L.scopeOf(w.type, i.area, i.port);
      const key = lsaKeyOf(scope, w.type, w.lsid, w.advRouter);
      const db = lsdb.get(key);
      const inst = wireInstance(w);
      if (w.age >= LSA_MAX_AGE_S && db === undefined && !anyExchanging()) {
        queueAck(out, i, n, w);
        continue;
      }
      const cmp = db === undefined ? 1 : compareLsaInstances(inst, rowInstance(db, ctx.now));
      if (cmp > 0) {
        if (db !== undefined && !db.self && !byRequest.has(key) && ctx.now - db.installedAt < LSA_MIN_ARRIVAL_NS) {
          debug(ctx, OSPF_DEBUG.flood, `${i.port}: ${L.text(w)} from ${n.routerId} discarded: the last copy arrived less than 1 s ago`, { port: i.port, lsa: key });
          continue;
        }
        const self = isSelf(ctx, w);
        if (n.requests.has(key)) byRequest.add(key);
        else byRequest.delete(key);
        const row = L.rowOf(w, scope, ctx.now, self && w.advRouter === proc.routerId);
        const floodedBack = installAndFlood(ctx, out, row, { port: i.port, routerId: n.routerId }, `${L.text(w)} from ${n.routerId}`);
        if (ackDirectly(floodedBack ? 'newer-flooded-back' : 'newer')) queueAck(out, i, n, w);
        if (self) selfNewer(ctx, out, row);
        continue;
      }
      if (n.requests.has(key)) {
        enterExStart(ctx, out, i, n, OSPF_NSM_EVENT_NAMES['bad-ls-req'], true);
        return;
      }
      if (cmp === 0) {
        const entry = n.rxmt.get(key);
        let c: OspfAckCase = 'duplicate';
        if (entry !== undefined && compareLsaInstances(inst, entry) === 0) {
          n.rxmt.delete(key);
          out.checkMaxAge = true;
          c = 'duplicate-implied';
        }
        if (ackDirectly(c)) queueAck(out, i, n, w);
        continue;
      }
      // the database copy is newer: send it back (RFC 2328 §13 step 8), at most once per MinLSArrival
      if (db === undefined || (db.maxAge === true && (db.seq | 0) === 0x7fffffff)) continue;
      const last = n.sentBack.get(key);
      if (last !== undefined && ctx.now - last < LSA_MIN_ARRIVAL_NS) continue;
      n.sentBack.set(key, ctx.now);
      queueDirect(out, i, n, key);
    }
    if (n.state === 'loading') {
      if (n.requests.size === 0) setNbrState(ctx, out, i, n, 'full', OSPF_NSM_EVENT_NAMES['loading-done'], pdu);
      else if (n.lastLsr.every((k) => !n.requests.has(k))) sendLsr(ctx, out, i, n);
    }
  }

  function rxAck(ctx: ProcessCtx, out: Out, i: Iface, n: Nbr, pdu: Pdu, lsas: readonly LayerView[]): void {
    out.actions.push({ type: 'consume', pdu });
    if (!nsmAtLeast(n.state, 'exchange')) return;
    for (const l of lsas) {
      const w = L.wireOf(l.fields);
      if (w === undefined) continue;
      const key = lsaKeyOf(L.scopeOf(w.type, i.area, i.port), w.type, w.lsid, w.advRouter);
      const entry = n.rxmt.get(key);
      if (entry !== undefined && compareLsaInstances(wireInstance(w), entry) === 0) {
        n.rxmt.delete(key);
        out.checkMaxAge = true;
      }
    }
  }

  // ── LSDB, flooding, origination ───────────────────────────────────────────

  /** RFC 2328 §13 steps 5b–5d: remove the old copy from every retransmission list, install, flood. */
  function installAndFlood(ctx: ProcessCtx, out: Out, row: OspfLsaRow, from: { port: PortId; routerId: Ipv4Address } | undefined, what: string): boolean {
    for (const i of ifaces.values()) for (const n of i.nbrs.values()) n.rxmt.delete(row.key);
    const prev = lsdb.get(row.key);
    installRow(ctx, row);
    debug(ctx, OSPF_DEBUG.flood, `installed ${what}${row.maxAge === true ? ' (MaxAge)' : ''}`, { lsa: row.key, seq: row.seq });
    const changed = prev === undefined || (prev.maxAge === true) !== (row.maxAge === true) || !L.bodyEqual(prev, row);
    if (changed) scheduleSpf(ctx, out, `${L.text(row)}${row.maxAge === true ? ' flushed' : prev === undefined ? ' added' : ' changed'}`);
    if (!row.self) armMaxAge(out);
    if (row.maxAge === true) out.checkMaxAge = true;
    return flood(ctx, out, row, from);
  }

  function flood(ctx: ProcessCtx, out: Out, row: OspfLsaRow, from: { port: PortId; routerId: Ipv4Address } | undefined): boolean {
    const inst: LsaInstance = { seq: row.seq, checksum: row.checksum, age: row.maxAge === true ? LSA_MAX_AGE_S : lsaAgeAt(row, ctx.now) };
    let floodedBack = false;
    for (const i of ordered(ctx)) {
      if (!running(i) || i.silent || i.state === 'loopback') continue;
      if (!L.floodsOn(row.scope, i)) continue;
      const nbrs = [...i.nbrs.values()].sort(byRid);
      const view: FloodIface = {
        networkType: i.networkType,
        state: i.state,
        dr: i.dr,
        bdr: i.bdr,
        neighbors: nbrs.map((n) => {
          const r = n.requests.get(row.key);
          return r === undefined ? { routerId: n.routerId, address: n.address, state: n.state } : { routerId: n.routerId, address: n.address, state: n.state, requested: r };
        }),
      };
      const v = floodOut(view, inst, from !== undefined && from.port === i.port ? from.routerId : undefined);
      for (const rid of v.settledRequests) {
        const n = i.nbrs.get(rid);
        if (n === undefined) continue;
        n.requests.delete(row.key);
        if (n.state === 'loading' && n.requests.size === 0 && !(from !== undefined && from.port === i.port && from.routerId === rid)) {
          setNbrState(ctx, out, i, n, 'full', OSPF_NSM_EVENT_NAMES['loading-done']);
        }
      }
      for (const rid of v.retransmitTo) {
        const n = i.nbrs.get(rid);
        if (n === undefined) continue;
        n.rxmt.set(row.key, inst);
        armRxmt(n, out);
      }
      if (v.send && v.dst !== undefined) {
        queueFlood(out, i.port, groupOf(v.dst), row.key);
        if (from !== undefined && from.port === i.port) floodedBack = true;
      }
    }
    return floodedBack;
  }

  function areasOf(ctx: ProcessCtx): OspfAreaId[] {
    const out: OspfAreaId[] = [];
    for (const i of ordered(ctx)) if (!out.includes(i.area)) out.push(i.area);
    return out;
  }

  /** Every self LSA this router wants now, by key. */
  function desiredSelf(ctx: ProcessCtx): Map<string, OspfLsaBody> {
    if (proc === undefined) return new Map<string, OspfLsaBody>();
    return family.desiredSelf({ proc, cfg, ifaces: ordered(ctx), areas: areasOf(ctx), haveDefault, lsdb });
  }

  function originateAll(ctx: ProcessCtx, out: Out): void {
    if (proc === undefined) return;
    const want = desiredSelf(ctx);
    for (const [key, body] of want) originate(ctx, out, key, body, false);
    for (const row of L.sorted(lsdb.values())) {
      if (row.advRouter !== proc.routerId || row.maxAge === true || want.has(row.key)) continue;
      flushSelf(ctx, out, row, 'no longer originated');
    }
    armRefresh(ctx, out);
  }

  /** Originate (or re-originate) `key` with `body` now, or arm its `lsa-gen` (MinLSInterval) or `self-war` timer. */
  function originate(ctx: ProcessCtx, out: Out, key: string, body: OspfLsaBody, force: boolean, fromWar = false): void {
    if (proc === undefined) return;
    const db = lsdb.get(key);
    if (!force && db !== undefined && db.maxAge !== true && L.bodyEqual(db, body)) {
      if (!db.self) installRow(ctx, { ...db, self: true, updatedAt: ctx.now });
      dropGen(out, key);
      return;
    }
    const due = lsaGenAt(lastOrig.get(key), ctx.now);
    const war = warSeen.get(key);
    if (war !== undefined && war.count >= OSPF_SELF_WAR_MAX_COPIES && ctx.now - war.at < OSPF_SELF_WAR_WINDOW_NS) {
      // the war is lost for now (rule 19): no re-origination, so the conflict's flooding and SPF work drain
      dropGen(out, key);
      return;
    }
    if (!fromWar && war !== undefined && war.count >= 2 && ctx.now - war.at < OSPF_SELF_WAR_WINDOW_NS) {
      if (warDue.get(key) === undefined) {
        warDue.set(key, due);
        out.actions.push(timer(`self-war:${key}`, due - ctx.now, true));
      }
      return;
    }
    if (due > ctx.now) {
      if (genDue.get(key) !== due) {
        genDue.set(key, due);
        out.actions.push(timer(`lsa-gen:${key}`, due - ctx.now));
      }
      return;
    }
    dropGen(out, key);
    const seq = db === undefined ? LSA_INITIAL_SEQ : (nextLsaSeq(db.seq) ?? LSA_INITIAL_SEQ);
    const scope = L.scopeOf(body.type, key.slice(0, key.indexOf('|')));
    const row = L.selfRowOf(key, scope, body, seq, ctx.now);
    lastOrig.set(key, ctx.now);
    installAndFlood(ctx, out, row, undefined, `own ${L.text(row)}`);
  }

  function dropGen(out: Out, key: string): void {
    if (genDue.delete(key)) out.actions.push(cancel(`lsa-gen:${key}`));
    if (warDue.delete(key)) out.actions.push(cancel(`self-war:${key}`));
  }

  /** Premature aging (RFC 2328 §14.1): the row at MaxAge, flooded, removed once acknowledged. */
  function flushSelf(ctx: ProcessCtx, out: Out, row: OspfLsaRow, why: string): void {
    dropGen(out, row.key);
    const flushed: OspfLsaRow = { ...row, ageAtInstall: LSA_MAX_AGE_S, installedAt: ctx.now, maxAge: true, updatedAt: ctx.now };
    debug(ctx, OSPF_DEBUG.flood, `flushing ${L.text(row)} (${why})`, { lsa: row.key });
    installAndFlood(ctx, out, flushed, undefined, L.text(row));
  }

  /** RFC 2328 §13.4: a newer copy of a self-originated LSA arrived. */
  function selfNewer(ctx: ProcessCtx, out: Out, row: OspfLsaRow): void {
    if (proc === undefined) return;
    const prev = warSeen.get(row.key);
    const count = prev !== undefined && ctx.now - prev.at < OSPF_SELF_WAR_WINDOW_NS ? prev.count + 1 : 1;
    warSeen.set(row.key, { at: ctx.now, count, logged: prev?.logged === true && count > 1 });
    if (count >= 2 && row.type === L.routerType && warSeen.get(row.key)!.logged !== true) {
      warSeen.get(row.key)!.logged = true;
      logConflict(ctx, out, row.key, `OSPF process ${proc.pid}: another router also uses router ID ${proc.routerId}; its link-state advertisements keep replacing this router's own.`);
    }
    if (row.advRouter !== proc.routerId) {
      if (row.maxAge !== true) flushSelf(ctx, out, row, 'a network LSA for an address of this router');
      return;
    }
    out.originate = true;
  }

  const conflictsLogged = new Set<string>();
  function logConflict(ctx: ProcessCtx, out: Out, key: string, message: string): void {
    if (conflictsLogged.has(key)) return;
    conflictsLogged.add(key);
    debug(ctx, OSPF_DEBUG.adj, message, { key });
    out.actions.push({ type: 'log', severity: 4, facility: 'OSPF', message });
  }

  function removeAckedMaxAge(ctx: ProcessCtx): void {
    if (anyExchanging()) return;
    for (const row of L.sorted(lsdb.values())) {
      if (row.maxAge !== true) continue;
      let held = false;
      for (const i of ifaces.values()) for (const n of i.nbrs.values()) if (n.rxmt.has(row.key)) held = true;
      if (held) continue;
      removeRow(ctx, row.key, 'aged');
      debug(ctx, OSPF_DEBUG.flood, `removed ${L.text(row)} (MaxAge, acknowledged)`, { lsa: row.key });
    }
  }

  function armRefresh(ctx: ProcessCtx, out: Out): void {
    let at: SimTime | undefined;
    for (const r of lsdb.values()) {
      if (!r.self || r.maxAge === true || proc === undefined || r.advRouter !== proc.routerId) continue;
      const t = r.installedAt + Math.max(0, LSA_REFRESH_S - r.ageAtInstall) * SEC;
      if (at === undefined || t < at) at = t;
    }
    if (at === refreshAt) return;
    refreshAt = at;
    out.actions.push(at === undefined ? cancel('refresh') : timer('refresh', at - ctx.now, true));
  }

  function armMaxAge(out: Out): void {
    if (maxageArmed) return;
    maxageArmed = true;
    out.actions.push(timer('maxage', OSPF_MAXAGE_SWEEP_NS, true));
  }

  // ── SPF ───────────────────────────────────────────────────────────────────

  function scheduleSpf(ctx: ProcessCtx, out: Out, reason: string): void {
    if (proc === undefined || inSpf || spfDue !== undefined) return;
    const soonest = ctx.now + OSPF_SPF_DELAY_NS;
    const due = lastSpfAt === undefined ? soonest : Math.max(soonest, lastSpfAt + OSPF_SPF_HOLD_NS);
    spfDue = due;
    spfReason = reason;
    debug(ctx, OSPF_DEBUG.spf, `SPF scheduled in ${(due - ctx.now) / SEC} s: ${reason}`, { at: due, reason });
    out.actions.push(timer('spf', due - ctx.now));
  }

  function runSpf(ctx: ProcessCtx, out: Out): void {
    if (proc === undefined) return;
    spfDue = undefined;
    const reason = spfReason ?? 'scheduled';
    spfReason = undefined;
    // D9: every origination due at or before now runs first
    inSpf = true;
    for (const [key, due] of [...genDue.entries()].sort((a, b) => a[1] - b[1] || (a[0] < b[0] ? -1 : 1))) {
      if (due > ctx.now) continue;
      genDue.delete(key);
      out.actions.push(cancel(`lsa-gen:${key}`));
      originateKey(ctx, out, key);
    }
    inSpf = false;
    const areas: OspfAreaRoot[] = [];
    for (const area of areasOf(ctx)) {
      const rootIfaces: SpfRootIface[] = [];
      for (const i of ordered(ctx)) if (i.area === area && running(i) && i.address !== undefined) rootIfaces.push({ port: i.port, address: i.address });
      if (rootIfaces.length > 0) areas.push({ area, rootIfaces });
    }
    const res = family.computeRoutes(L.sorted(lsdb.values()), proc.routerId, areas, { maximumPaths: cfg?.process?.maximumPaths ?? 4, now: ctx.now });
    trees = res.trees;
    spfRuns++;
    lastSpfAt = ctx.now;
    lastSpfReason = reason;
    const vertices = res.trees.reduce((s, t) => s + t.tree.vertices.length, 0);
    debug(ctx, OSPF_DEBUG.spf, `SPF run ${spfRuns} (${reason}): ${vertices} vertices, ${res.routes.length} routes`, { runs: spfRuns, reason });
    reportRouteChanges(ctx, res.rows);
    lastRoutes = res.rows;
    routesSent = true;
    out.actions.push(family.routesAction(res.rows));
  }

  function reportRouteChanges(ctx: ProcessCtx, rows: readonly TableRow[]): void {
    const text = (list: readonly TableRow[]): Map<string, string> => {
      const m = new Map<string, string>();
      for (const r of list) m.set(r.key, `${m.has(r.key) ? `${m.get(r.key)!}, ` : ''}${family.routeText(r)}`);
      return m;
    };
    const before = text(lastRoutes);
    const after = text(rows);
    for (const [k, t] of after) {
      const b = before.get(k);
      if (b === undefined) debug(ctx, OSPF_DEBUG.spf, `route added: ${t}`, { key: k });
      else if (b !== t) debug(ctx, OSPF_DEBUG.spf, `route changed: ${t} (was ${b})`, { key: k });
    }
    for (const [k, b] of before) if (!after.has(k)) debug(ctx, OSPF_DEBUG.spf, `route removed: ${b}`, { key: k });
  }

  /** The `lsa-gen` / `self-war` work of one key: originate what is wanted, flush a self copy that is not. */
  function originateKey(ctx: ProcessCtx, out: Out, key: string): void {
    if (proc === undefined) return;
    const want = desiredSelf(ctx).get(key);
    if (want !== undefined) originate(ctx, out, key, want, false);
    else {
      const row = lsdb.get(key);
      if (row !== undefined && row.advRouter === proc.routerId && row.maxAge !== true) flushSelf(ctx, out, row, 'no longer originated');
    }
    armRefresh(ctx, out);
  }

  function newIface(ctx: ProcessCtx, w: IfaceWant): Iface {
    return {
      port: w.port,
      area: w.area,
      role: w.role,
      networkType: w.networkType,
      cost: w.cost,
      costSource: w.costSource,
      priority: w.priority,
      helloS: w.helloS,
      deadS: w.deadS,
      passive: w.passive,
      silent: w.silent,
      state: 'down',
      stateSince: ctx.now,
      dr: OSPF_NO_DR,
      bdr: OSPF_NO_DR,
      joined: new Set(),
      nbrs: new Map(),
      helloCount: 0,
      pairMark: -1,
      replyArmed: false,
      drHelloArmed: false,
      ...(w.address !== undefined ? { address: w.address, prefixLen: w.prefixLen } : {}),
    };
  }

  function removeIface(ctx: ProcessCtx, out: Out, i: Iface, why: string): void {
    if (i.state !== 'down') interfaceDown(ctx, out, i, why, 'kill-nbr', 'cleared');
    ifaces.delete(i.port);
    ifTable(ctx)?.delete(i.port, 'cleared');
    out.originate = true;
  }

  function start(ctx: ProcessCtx, p: OspfProcessConfig, routerId: Ipv4Address, source: string): void {
    proc = { pid: p.pid, routerId, startedAt: ctx.now };
    noRidLogged = false;
    debug(ctx, OSPF_DEBUG.adj, `OSPF process ${p.pid} started with router ID ${routerId} (${source})`, { pid: p.pid, routerId });
  }

  function stop(ctx: ProcessCtx, out: Out, why: string): void {
    if (proc === undefined) return;
    for (const i of ordered(ctx)) removeIface(ctx, out, i, why);
    out.originate = false;
    for (const key of genDue.keys()) out.actions.push(cancel(`lsa-gen:${key}`));
    for (const key of warDue.keys()) out.actions.push(cancel(`self-war:${key}`));
    genDue.clear();
    warDue.clear();
    warSeen.clear();
    lastOrig.clear();
    out.actions.push(cancel('spf'), cancel('refresh'), cancel('maxage'));
    spfDue = undefined;
    spfReason = undefined;
    lastSpfAt = undefined;
    refreshAt = undefined;
    maxageArmed = false;
    trees = [];
    for (const key of [...lsdb.keys()]) removeRow(ctx, key, 'cleared');
    byRequest.clear();
    if (routesSent) {
      out.actions.push(family.routesAction([]));
      reportRouteChanges(ctx, []);
      routesSent = false;
      lastRoutes = [];
    }
    if (watchKeys.length > 0) {
      watchKeys = [];
      out.actions.push(family.watchAction([]));
    }
    haveDefault = false;
    debug(ctx, OSPF_DEBUG.adj, `OSPF process ${proc.pid} stopped (${why})`, { pid: proc.pid });
    proc = undefined;
  }

  /** The interface half of a resync: reconcile the running interfaces with `wanted` (the daemon's reading of the ports). */
  function reconcile(ctx: ProcessCtx, out: Out, wanted: readonly IfaceWant[]): void {
    const byPort = new Map(wanted.map((w) => [w.port, w] as const));
    for (const i of ordered(ctx)) if (!byPort.has(i.port)) removeIface(ctx, out, i, 'OSPF disabled on the interface');
    for (const w of wanted) {
      let i = ifaces.get(w.port);
      if (i === undefined) {
        i = newIface(ctx, w);
        ifaces.set(w.port, i);
        debug(ctx, OSPF_DEBUG.adj, `${w.port}: enabled in area ${w.area} (${w.networkType}, cost ${w.cost})`, { port: w.port, area: w.area });
      } else {
        const structural = i.area !== w.area || i.networkType !== w.networkType || i.address !== w.address || i.prefixLen !== w.prefixLen || i.silent !== w.silent || i.role !== w.role;
        if (structural && i.state !== 'down') interfaceDown(ctx, out, i, 'configuration changed', 'kill-nbr', 'cleared');
        if (i.cost !== w.cost) out.originate = true;
        const timersChanged = i.helloS !== w.helloS;
        i.area = w.area;
        i.role = w.role;
        i.networkType = w.networkType;
        i.address = w.address;
        i.prefixLen = w.prefixLen;
        i.cost = w.cost;
        i.costSource = w.costSource;
        i.priority = w.priority;
        i.helloS = w.helloS;
        i.deadS = w.deadS;
        i.passive = w.passive;
        i.silent = w.silent;
        if (timersChanged && i.state !== 'down' && !i.silent) {
          i.helloDueAt = ctx.now + i.helloS * SEC;
          out.actions.push(timer(`hello:${i.port}`, i.helloS * SEC, true));
        }
      }
      if (w.up && i.state === 'down') interfaceUp(ctx, out, i);
      else if (!w.up && i.state !== 'down') interfaceDown(ctx, out, i, OSPF_ISM_EVENT_NAMES['interface-down'], 'll-down', 'link-down');
      writeIfRow(ctx, i);
    }
    // keep the interface records in canonical port order (§4.5: the StateView lists them that way)
    const canonical = ordered(ctx);
    ifaces.clear();
    for (const i of canonical) ifaces.set(i.port, i);
    out.originate = true;
  }

  // ── timers ────────────────────────────────────────────────────────────────

  function onTimerKey(ctx: ProcessCtx, out: Out, key: string): void {
    const at = key.indexOf(':');
    const kind = at < 0 ? key : key.slice(0, at);
    const rest = at < 0 ? '' : key.slice(at + 1);
    switch (kind) {
      case 'resync':
        resyncArmed = false;
        family.resync(surface, ctx, out);
        return;
      case 'spf':
        if (spfDue !== undefined) runSpf(ctx, out);
        return;
      case 'lsa-gen':
        if (!genDue.has(rest)) return;
        genDue.delete(rest);
        originateKey(ctx, out, rest);
        return;
      case 'self-war':
        if (!warDue.has(rest)) return;
        warDue.delete(rest);
        if (proc === undefined) return;
        {
          const want = desiredSelf(ctx).get(rest);
          if (want !== undefined) originate(ctx, out, rest, want, false, true);
        }
        return;
      case 'refresh':
        refreshAt = undefined;
        if (proc === undefined) return;
        for (const r of L.sorted(lsdb.values())) {
          if (!r.self || r.maxAge === true || r.advRouter !== proc.routerId) continue;
          if (r.installedAt + Math.max(0, LSA_REFRESH_S - r.ageAtInstall) * SEC > ctx.now) continue;
          const want = desiredSelf(ctx).get(r.key);
          if (want !== undefined) originate(ctx, out, r.key, want, true);
        }
        armRefresh(ctx, out);
        return;
      case 'maxage': {
        maxageArmed = false;
        if (proc === undefined) return;
        let others = false;
        for (const r of L.sorted(lsdb.values())) {
          if (r.self && r.maxAge !== true) continue;
          others = true;
          if (r.maxAge !== true && lsaAgeAt(r, ctx.now) >= LSA_MAX_AGE_S) {
            installAndFlood(ctx, out, { ...r, ageAtInstall: LSA_MAX_AGE_S, installedAt: ctx.now, maxAge: true, updatedAt: ctx.now }, undefined, `${L.text(r)} (reached MaxAge)`);
          }
        }
        out.checkMaxAge = true;
        if (others) armMaxAge(out);
        return;
      }
      default:
        break;
    }
    // per-interface and per-neighbour timers: '<kind>:<port>' / '<kind>:<port>:<rid>'
    const sep = rest.lastIndexOf(':');
    const i = ifaces.get(kind === 'dead' || kind === 'rxmt' ? rest.slice(0, sep) : rest);
    if (i === undefined || proc === undefined) return;
    switch (kind) {
      case 'hello':
        if (i.state === 'down' || i.silent) return;
        sendHello(ctx, out, i, 'periodic');
        i.helloDueAt = ctx.now + i.helloS * SEC;
        out.actions.push(timer(`hello:${i.port}`, i.helloS * SEC, true));
        return;
      case 'hello-reply':
        i.replyArmed = false;
        if (i.state !== 'down' && !i.silent) sendHello(ctx, out, i, 'reply to a new neighbour');
        return;
      case 'dr-hello':
        i.drHelloArmed = false;
        if (i.state !== 'down' && !i.silent && i.helloCount === i.pairMark) sendHello(ctx, out, i, 'DR or BDR changed');
        return;
      case 'wait':
        if (i.state !== 'waiting') return;
        i.waitUntil = undefined;
        elect(ctx, out, i, OSPF_ISM_EVENT_NAMES['wait-timer']);
        return;
      case 'dead': {
        const n = i.nbrs.get(rest.slice(sep + 1));
        if (n === undefined) return;
        killNbr(ctx, out, i, n, 'inactivity-timer', 'aged');
        return;
      }
      case 'rxmt': {
        const n = i.nbrs.get(rest.slice(sep + 1));
        if (n === undefined) return;
        n.rxmtArmed = false;
        retransmit(ctx, out, i, n);
        return;
      }
      default:
        return;
    }
  }

  function retransmit(ctx: ProcessCtx, out: Out, i: Iface, n: Nbr): void {
    let again = false;
    if (n.state === 'exstart') {
      n.exstartRetransmits++;
      if (n.exstartRetransmits > OSPF_EXSTART_MAX_RETRANSMITS) {
        enterExStart(ctx, out, i, n, 'ExStart retransmissions exhausted', true);
        return;
      }
      resendDbd(ctx, out, i, n);
      again = true;
    } else if (n.state === 'exchange' && n.master) {
      resendDbd(ctx, out, i, n);
      again = true;
    } else if (n.state === 'loading') {
      sendLsr(ctx, out, i, n);
      again = true;
    }
    if (nsmAtLeast(n.state, 'exchange') && n.rxmt.size > 0) {
      for (const key of n.rxmt.keys()) if (lsdb.has(key)) queueDirect(out, i, n, key);
      again = true;
    }
    if (again) armRxmt(n, out);
  }

  // ── state view ────────────────────────────────────────────────────────────

  function stateSnapshot(): StateView {
    const view: OspfStateView = {
      spf: {
        runs: spfRuns,
        ...(lastSpfAt !== undefined ? { lastAt: lastSpfAt, holdUntil: lastSpfAt + OSPF_SPF_HOLD_NS } : {}),
        ...(spfDue !== undefined ? { nextAt: spfDue } : {}),
        ...(lastSpfReason !== undefined ? { lastReason: lastSpfReason } : {}),
      },
      interfaces: [...ifaces.values()].map((i) => ({
        port: i.port,
        ...(i.helloDueAt !== undefined && i.state !== 'down' ? { helloDueAt: i.helloDueAt } : {}),
        ...(i.waitUntil !== undefined ? { waitUntil: i.waitUntil } : {}),
      })),
      neighbors: [...ifaces.values()].flatMap((i) => [...i.nbrs.values()].sort(byRid).map((n) => ({ port: i.port, routerId: n.routerId, deadAt: n.deadAt, retransmitQueue: n.rxmt.size }))),
      trees: trees.map((t) => ({ area: t.area, tree: { root: t.tree.root, vertices: t.tree.vertices.map((v) => ({ ...v, nextHops: v.nextHops.map((h) => ({ ...h })) })) } })),
    };
    if (proc !== undefined) {
      const p = cfg?.process;
      view.process = {
        pid: proc.pid,
        routerId: proc.routerId,
        ...(p?.routerId !== undefined && p.routerId !== proc.routerId ? { configuredRouterId: p.routerId } : {}),
        startedAt: proc.startedAt,
        referenceBandwidthMbps: p?.referenceBandwidthMbps ?? 100,
        maximumPaths: p?.maximumPaths ?? 4,
        ...(p?.defaultOriginate !== undefined ? { defaultOriginate: p.defaultOriginate } : {}),
      };
    }
    return { process: NAME, state: view as unknown as Record<string, unknown> };
  }

  // ── the engine's surface (what the family and the daemon shell reach) ───

  const surface: OspfEngine = {
    get proc(): Proc | undefined {
      return proc;
    },
    get cfg(): OspfConfig | undefined {
      return cfg;
    },
    set cfg(c: OspfConfig | undefined) {
      cfg = c;
    },
    get lastSpfAt(): SimTime | undefined {
      return lastSpfAt;
    },
    get noRidLogged(): boolean {
      return noRidLogged;
    },
    set noRidLogged(v: boolean) {
      noRidLogged = v;
    },
    get haveDefault(): boolean {
      return haveDefault;
    },
    set haveDefault(v: boolean) {
      haveDefault = v;
    },
    get watchKeys(): string[] {
      return watchKeys;
    },
    set watchKeys(k: string[]) {
      watchKeys = k;
    },
    ifaces,
    lsdb,
    debug,
    armResync,
    run,
    finish,
    ordered,
    scheduleSpf,
    flushSelf,
    start,
    stop,
    reconcile,
    onTimerKey,
    rxHello,
    rxDbd,
    rxLsr,
    rxLsu,
    rxAck,
    stateSnapshot,
    debugEvents(): readonly DebugEvent[] {
      return ring;
    },
  };
  return surface;
}

/** @since P3c The engine one OSPF daemon runs on (the module header): what its family and the daemon shell reach. */
export interface OspfEngine {
  readonly proc: Proc | undefined;
  cfg: OspfConfig | undefined;
  readonly lastSpfAt: SimTime | undefined;
  /** The `ospfNoRouterId` log was written (once per process absence). */
  noRidLogged: boolean;
  /** The RIB holds a default route from another source (`default-information originate`). */
  haveDefault: boolean;
  /** The keys of the last RIB watch request. */
  watchKeys: string[];
  readonly ifaces: Map<PortId, Iface>;
  readonly lsdb: Map<string, OspfLsaRow>;
  debug(ctx: ProcessCtx, category: string, message: string, data?: Record<string, unknown>): void;
  armResync(): Action[];
  /** Run `fn` with an accumulator, settle elections, origination and MaxAge removals, then emit the bundles. */
  run(ctx: ProcessCtx, fn: (out: Out) => void): Action[];
  finish(ctx: ProcessCtx, out: Out): void;
  ordered(ctx: ProcessCtx): Iface[];
  scheduleSpf(ctx: ProcessCtx, out: Out, reason: string): void;
  flushSelf(ctx: ProcessCtx, out: Out, row: OspfLsaRow, why: string): void;
  start(ctx: ProcessCtx, p: OspfProcessConfig, routerId: Ipv4Address, source: string): void;
  stop(ctx: ProcessCtx, out: Out, why: string): void;
  /** The interface half of a resync: reconcile the running interfaces with `wanted`. */
  reconcile(ctx: ProcessCtx, out: Out, wanted: readonly IfaceWant[]): void;
  onTimerKey(ctx: ProcessCtx, out: Out, key: string): void;
  rxHello(ctx: ProcessCtx, out: Out, i: Iface, pdu: Pdu, src: string, f: Readonly<Record<string, FieldValue>>): void;
  rxDbd(ctx: ProcessCtx, out: Out, i: Iface, n: Nbr, pdu: Pdu, f: Readonly<Record<string, FieldValue>>, lsas: readonly LayerView[]): void;
  rxLsr(ctx: ProcessCtx, out: Out, i: Iface, n: Nbr, pdu: Pdu, f: Readonly<Record<string, FieldValue>>): void;
  rxLsu(ctx: ProcessCtx, out: Out, i: Iface, n: Nbr, pdu: Pdu, lsas: readonly LayerView[]): void;
  rxAck(ctx: ProcessCtx, out: Out, i: Iface, n: Nbr, pdu: Pdu, lsas: readonly LayerView[]): void;
  stateSnapshot(): StateView;
  debugEvents(): readonly DebugEvent[];
}

/**
 * @since P3c [S6] The daemon shell both OSPF families share: the engine plus `family` as a `Process`. Configuration and
 * link changes arm the coalesced resync (the family reads the configuration there); a packet is demultiplexed on the
 * family's outer layers, then handed to the engine by type; `clear … ospf process` restarts the process, flushing this
 * router's LSAs first when the configured router id differs from the running one.
 */
export function createOspfProcess(family: OspfFamily): Process {
  const eng = createOspfEngine(family);
  const resync = (ctx: ProcessCtx, out: Out): void => family.resync(eng, ctx, out);

  return {
    name: family.name,

    init(ctx: ProcessCtx): Action[] {
      return family.hasSection(ctx) ? eng.armResync() : [];
    },

    onPdu(ctx: ProcessCtx, pdu: Pdu, port: PortId): Action[] {
      return eng.run(ctx, (out) => {
        const p = family.decode(pdu);
        if (p === undefined) {
          out.actions.push({ type: 'drop', pdu, reason: 'other', detail: 'not an OSPF packet', port });
          return;
        }
        if (p.checksumValid === false) {
          out.actions.push({ type: 'drop', pdu, reason: 'bad-checksum', detail: p.error ?? 'OSPF checksum mismatch', port });
          return;
        }
        const i = eng.ifaces.get(port);
        if (eng.proc === undefined || i === undefined || i.state === 'down' || i.silent || i.state === 'loopback') {
          out.actions.push({ type: 'drop', pdu, reason: 'other', detail: `OSPF does not run on ${port}${i?.silent === true ? ' (passive)' : ''}`, port });
          return;
        }
        const { src, dst, type } = p;
        if (src === i.address) {
          out.actions.push({ type: 'consume', pdu });
          return;
        }
        if (p.version !== family.version) {
          out.actions.push({ type: 'drop', pdu, reason: 'other', detail: `OSPF version ${p.version} is not spoken here`, port });
          return;
        }
        if (dst === family.allDRouters && i.state !== 'dr' && i.state !== 'backup') {
          out.actions.push({ type: 'drop', pdu, reason: 'not-for-me', detail: `${port} is neither DR nor BDR (AllDRouters)`, port });
          return;
        }
        const lsas = p.lsas;
        eng.debug(ctx, OSPF_DEBUG.packet, `${port}: received ${ospfPacketText(type)} from ${p.routerId} (${src})${lsas.length > 0 ? `, ${lsas.length} LSAs` : ''} (pdu ${pdu.id})`, { port, from: src, type, pdu: pdu.id });
        if (type === OSPF_PACKET.hello) {
          eng.rxHello(ctx, out, i, pdu, src, p.fields);
          return;
        }
        if (p.area !== i.area) {
          out.actions.push({ type: 'drop', pdu, reason: 'other', detail: `OSPF area ${p.area} does not match ${port}'s area ${i.area}`, port });
          return;
        }
        const n = i.nbrs.get(p.routerId);
        if (n === undefined) {
          out.actions.push({ type: 'drop', pdu, reason: 'other', detail: `no OSPF neighbour ${p.routerId} on ${port}`, port });
          return;
        }
        switch (type) {
          case OSPF_PACKET.dbd:
            eng.rxDbd(ctx, out, i, n, pdu, p.fields, lsas);
            return;
          case OSPF_PACKET.lsr:
            eng.rxLsr(ctx, out, i, n, pdu, p.fields);
            return;
          case OSPF_PACKET.lsu:
            eng.rxLsu(ctx, out, i, n, pdu, lsas);
            return;
          case OSPF_PACKET.lsack:
            eng.rxAck(ctx, out, i, n, pdu, lsas);
            return;
          default:
            out.actions.push({ type: 'drop', pdu, reason: 'other', detail: `unknown OSPF packet type ${type}`, port });
        }
      });
    },

    onTimer(ctx: ProcessCtx, key: string): Action[] {
      return eng.run(ctx, (out) => eng.onTimerKey(ctx, out, key));
    },

    onConfig(ctx: ProcessCtx, delta: ConfigDelta): Action[] {
      // Removing the running process's own section destroys it at once (D7: the router id is chosen at process start),
      // so a section removed and re-created in one instant starts a NEW process that picks its id again, never
      // inheriting the deleted process's id; the coalesced resync then reconciles as usual (W5 fix, exposed by lab 07).
      // Only the running process's own section counts: removing another section leaves the running process alone.
      if (eng.proc !== undefined && family.removesOwnSection(delta, eng.proc.pid)) {
        return [...eng.run(ctx, (out) => eng.stop(ctx, out, 'no router ospf')), ...eng.armResync()];
      }
      if (eng.proc === undefined && !family.hasSection(ctx)) return [];
      return eng.armResync();
    },

    onLinkChange(ctx: ProcessCtx): Action[] {
      if (eng.proc === undefined && !family.hasSection(ctx)) return [];
      return eng.armResync();
    },

    onRequest(ctx: ProcessCtx, req: ProcessRequest): Action[] {
      if (req.kind !== family.clearKind) return [];
      return eng.run(ctx, (out) => {
        if (eng.proc === undefined) {
          resync(ctx, out);
          return;
        }
        const configured = eng.cfg?.process?.routerId;
        if (configured !== undefined && configured !== eng.proc.routerId) {
          // the router id changes: flush this router's LSAs first, while its adjacencies still carry them
          for (const row of family.lsa.sorted(eng.lsdb.values())) if (row.advRouter === eng.proc.routerId && row.maxAge !== true) eng.flushSelf(ctx, out, row, 'router ID changes');
          eng.finish(ctx, out);
        }
        eng.stop(ctx, out, 'clear ip ospf process');
        resync(ctx, out);
      });
    },

    onEvent(ctx: ProcessCtx, ev: ProcessEvent): Action[] {
      return family.onEvent(eng, ctx, ev);
    },

    onShutdown(): Action[] {
      return [];
    },

    stateSnapshot(): StateView {
      return eng.stateSnapshot();
    },

    debugEvents(): readonly DebugEvent[] {
      return eng.debugEvents();
    },
  };
}
