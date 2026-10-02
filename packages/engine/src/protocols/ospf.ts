/**
 * protocols/ospf.ts — the OSPFv2 daemon, single area (ARCHITECTURE-P3 D7–D10, §2.4–§2.6, §3.1, §3.2, §4.1–§4.5, §5.1,
 * §5.8; RFC 2328; §7 W2 ospf). One process per device (`router ospf <pid>`), over the pure modules of protocols/ospf/
 * (config, cost, ism, dr, hello-check, nsm, flood, lsdb, originate, routes) and core/ (ospf-lsa, ospf-spf).
 *
 * Silent unless configured (§4.3): nothing is sent, no table row is written and no timer is armed until `router ospf`
 * is stored; hellos leave only on an enabled, up, non-passive interface with an address.
 *
 * Process. Started at the first resync where a router id can be chosen (D7, `selectOspfRouterId`: `router-id` > the
 * highest up loopback > the highest up interface address); a later `router-id` change is shown as `configuredRouterId`
 * and applied by `clear ip ospf process` (`ospf.clear`) or a reload. With no `router-id` and no interface address at
 * all, the `ospfNoRouterId` log is written once. `no router ospf`, or a stored `no ip routing` (D7), stops the process:
 * neighbours and rows go, the LSDB is cleared and an empty `ipv4.routes` batch withdraws every route.
 *
 * Resync (`resync`, 0 ns, coalesced, after `init`, `onConfig` and `onLinkChange`): the daemon reads the port views after
 * the whole dispatch applied its actions (the stale-view lag of ipv4.ts) and reconciles the process, the enabled
 * interfaces (network lines and `ip ospf <pid> area <a>`, D7) and their parameters (area, network type by role, cost
 * from the routing bandwidth, priority, hello and dead intervals, passive) with what runs.
 *
 * Interfaces (ISM, protocols/ospf/ism.ts). InterfaceUp on an up interface with an address: point-to-point networks go
 * Point-to-point, a loopback Loopback (a /32 host stub), a broadcast interface Waiting (`wait:<if>`, the dead interval,
 * non-periodic) or DROther with priority 0. Every non-passive interface that leaves Down joins 224.0.0.5 and sends a
 * hello at once, then every hello interval (`hello:<if>`, periodic); DR and Backup also join 224.0.0.6. A passive
 * interface (and a loopback) sends nothing, joins nothing and ignores OSPF packets; a passive broadcast interface elects
 * itself at once (no wait: it can have no neighbour; listed in the wave report). The election is
 * protocols/ospf/dr.ts; when an interface's (DR, BDR) pair changes, `dr-hello:<if>` (0 ns, coalesced) sends one hello
 * unless one already left after the change (D9).
 *
 * Neighbours (NSM, protocols/ospf/nsm.ts; key `ospfNbrKey(port, router id)`). A hello that passes the checks
 * (protocols/ospf/hello-check.ts; a refusal sets the interface row's `rejected`, writes an `ip ospf hello` line and
 * drops the packet) creates the neighbour in Init (`dead:<if>:<rid>`, the dead interval, periodic, re-armed by every
 * hello) and arms `hello-reply:<if>` (1 s, non-periodic, coalesced, D9). A hello that lists this router is
 * 2-WayReceived; BackupSeen and NeighborChange follow RFC 2328 §10.5 (`drEventsFromHello`; the election runs at most
 * once per hello). AdjOK? (RFC §10.4) moves 2-Way neighbours to ExStart: the DD sequence of D9, an empty I|M|MS DBD and
 * `rxmt:<if>:<rid>` (5 s, periodic: DBD, LSR, unacknowledged LSAs; ExStart restarts with attempt + 1 after 10
 * retransmissions). The higher router id is master; the exchange, Loading (LSR / LSU) and Full follow RFC §10.6–§10.9;
 * a DBD received from a neighbour in Init is 2-WayReceived first (§3.1 step 7). A neighbour that goes Down (dead,
 * link down, interface removed) loses its row.
 *
 * Packets: `[ipv4 {src, dst, ttl 1, protocol 89, dscp 48}, ospf …]`, sent with `ipv4.send {iface, nextHop: dst}` (D7).
 * Hellos go to 224.0.0.5 (`meta.tag 'ospf-hello'`, background). On a broadcast network DBD, LSR, acknowledgements and
 * retransmissions are unicast to the neighbour; on a point-to-point network every packet goes to 224.0.0.5 (RFC §8.1).
 * Flooding follows protocols/ospf/flood.ts (a non-DR floods to 224.0.0.6, the DR re-floods to 224.0.0.5, the BDR
 * re-floods nothing it received on the segment). Updates are bundled per interface and destination per handler call,
 * LSAs in database order (§4.5); acknowledgements are direct and immediate (D9).
 *
 * LSDB (`ospf-lsdb` rows, protocols/ospf/lsdb.ts). RFC 2328 §13: MinLSArrival (1 s), the newer-instance rules
 * (core/ospf-lsa.ts), install, flood, acknowledge, and an older copy answered with the database copy. A newer copy of a
 * self-originated LSA is installed, then re-originated above it (or flushed when no longer wanted); when such copies
 * keep arriving (another router with the same router id) the re-origination moves to the periodic `self-war:<lsa>` and
 * a log names the conflict once, so `runToIdle` still returns. MaxAge LSAs are removed once no retransmission list
 * holds them and no neighbour is exchanging; `maxage` (60 s, periodic, only while LSAs of other routers exist) ages
 * them out; `refresh` (periodic) re-originates every self LSA at 1800 s.
 *
 * Origination (protocols/ospf/originate.ts): the router-LSA of each area, the network-LSA of each segment where this
 * router is DR with a Full neighbour, and the AS-external default of `default-information originate` (D8: while the
 * routing table holds a default route from another source — watched with `ipv4.ribWatch {keys: ['0.0.0.0/0']}` — or
 * always with `always`). MinLSInterval: a first origination is immediate, later ones wait for `lsa-gen:<lsa>` (5 s
 * after the previous one, non-periodic).
 *
 * SPF (D9, D10): `spf` (non-periodic) 5 s after the first change, and not before the last run + 10 s. At expiry it first
 * performs every `lsa-gen` due at or before now, then computes (protocols/ospf/routes.ts over core/ospf-spf.ts) and
 * sends ONE `ipv4.routes {owner: 'ospf', rows}` batch (D8); the trees go to the StateView. Paths through an interface
 * that goes down are withdrawn by ipv4 at link-down, before this SPF (D8).
 *
 * Debug categories (§5.8): 'ip ospf adj' (ISM and NSM transitions through `ctx.transition`, machines 'ospf-if' and
 * 'ospf-nbr', elections), 'ip ospf hello' (hellos and refusals), 'ip ospf flood' (updates, requests, acknowledgements,
 * install, flush), 'ip ospf spf' (runs, reasons, route changes), 'ip ospf packet' (one line per packet sent or
 * received).
 *
 * Tables (rule 20): `ospf-interfaces` (key port; rewritten only when a column changes), `ospf-neighbors` (key
 * port|router id; written on a change of state, role, DR/BDR, priority, address or master), `ospf-lsdb` (one row per
 * LSA instance installed). stateSnapshot(): the `OspfStateView` of contracts/tables.ts (kind 'ospf').
 *
 * Deviations (listed): the hello reply and the DR-change hello (D9); immediate direct acknowledgements; a passive
 * broadcast interface elects itself at once; a deterministic DD sequence number; one process; full SPF only.
 */
import { ipv4ToU32, networkOf, prefixLenToMask, type Ipv4Address } from '../contracts/addr.js';
import type { PortRole } from '../contracts/catalog.js';
import { CLI_MESSAGES } from '../contracts/cli.js';
import type { ConfigDelta } from '../contracts/config.js';
import type { PortId, ProcessName } from '../contracts/ids.js';
import { IPPROTO_OSPF, OSPF_ALL_DROUTERS, OSPF_ALL_ROUTERS, type FieldValue, type LayerSpec, type LayerView, type Pdu, type PduMeta } from '../contracts/pdu.js';
import type { Action, DebugEvent, FsmTransition, Process, ProcessCtx, ProcessRequest, StateView } from '../contracts/process.js';
import {
  ospfNbrKey,
  routeKey,
  type OspfAreaId,
  type OspfInterfaceRow,
  type OspfIsmState,
  type OspfLsaRow,
  type OspfNeighborRow,
  type OspfNetworkType,
  type OspfNsmState,
  type OspfStateView,
  type RouteRow,
  type SpfTree,
  type Table,
} from '../contracts/tables.js';
import { SEC, type SimTime } from '../contracts/time.js';
import type { ProcessEvent } from '../contracts/transport.js';
import { compareLsaInstances, lsaAgeAt, lsaChecksumAndLength, LSA_INITIAL_SEQ, LSA_MAX_AGE_S, LSA_MIN_ARRIVAL_NS, LSA_REFRESH_S, nextLsaSeq, type LsaInstance } from '../core/ospf-lsa.js';
import type { SpfRootIface } from '../core/ospf-spf.js';
import { OSPF_DD_FLAG, OSPF_PACKET, ospfPacketText } from '../pdu/codecs/ospf.js';
import { ipRoutingSwitchedOff } from './ipv4.js';
import {
  isOspfPassive,
  ospfEnabledInterfaces,
  ospfIfacePriority,
  ospfIfaceTimers,
  ospfNetworkType,
  readOspfConfig,
  selectOspfRouterId,
  type OspfConfig,
  type OspfProcessConfig,
} from './ospf/config.js';
import { ospfInterfaceCost, routingBandwidthKbps } from './ospf/cost.js';
import { drEventsFromHello, electDesignatedRouter, ospfAdjacencyOk, OSPF_NO_DR, type OspfDrCandidate, type OspfHelloDeclaration } from './ospf/dr.js';
import { ackDirectly, directDestination, floodOut, type FloodIface, type OspfAckCase } from './ospf/flood.js';
import { checkOspfHello, OSPF_OPTION_E } from './ospf/hello-check.js';
import { ismOutcome, OSPF_ISM_EVENT_NAMES, type OspfIsmEvent } from './ospf/ism.js';
import {
  compareLsdbRows,
  isOspfLsaType,
  lsaBodyEqual,
  lsaHeaderLayerOf,
  lsaKeyOf,
  lsaLayerOf,
  lsaRowOf,
  lsaScopeOf,
  lsaText,
  lsaWireOf,
  lsdbForArea,
  lsrEntryOf,
  OSPF_OPTIONS,
  parseLsrEntries,
  rowInstance,
  sortedLsdb,
  wireHeaderLayerOf,
  wireInstance,
  type OspfLsaBody,
  type OspfLsaWire,
} from './ospf/lsdb.js';
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
} from './ospf/nsm.js';
import { defaultExternalBody, lsaGenAt, networkLsaBody, routerLsaBody, type OriginIface } from './ospf/originate.js';
import { computeOspfRoutes, ospfRouteText, type OspfAreaRoot } from './ospf/routes.js';

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
/** @since P3 The DSCP of every OSPF packet (D7: the classic TOS 0xc0). */
export const OSPF_DSCP = 48;
/** @since P3 Port roles OSPF can run on (D7). */
export const OSPF_PORT_ROLES: readonly PortRole[] = Object.freeze(['routed', 'wan', 'svi', 'virtual', 'subif', 'tunnel'] as PortRole[]);
/** @since P3 Two newer copies of one self-originated LSA within this window are a router id conflict (`self-war`). */
export const OSPF_SELF_WAR_WINDOW_NS = 60 * SEC;

const NAME = OSPF_PROCESS;
const DEBUG_RING = 256;
const ALL_ROUTERS: Ipv4Address = OSPF_ALL_ROUTERS;
const ALL_DROUTERS: Ipv4Address = OSPF_ALL_DROUTERS;

interface Proc {
  readonly pid: number;
  readonly routerId: Ipv4Address;
  readonly startedAt: SimTime;
}

interface Nbr {
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

interface Iface {
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
interface IfaceWant {
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
interface Out {
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

const num = (v: FieldValue | undefined, dflt = 0): number => (typeof v === 'number' && Number.isFinite(v) ? v : dflt);
const str = (v: FieldValue | undefined): string => (typeof v === 'string' ? v : '');
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

/** @since P3 The OSPFv2 daemon (the module header). */
export function createOspf(): Process {
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
  let lastRoutes: RouteRow[] = [];
  let watchKeys: string[] = [];
  let haveDefault = false;
  let refreshAt: SimTime | undefined;
  let maxageArmed = false;
  let resyncArmed = false;
  let noRidLogged = false;
  let ipId = 0;
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

  const ifTable = (ctx: ProcessCtx): Table<OspfInterfaceRow> | undefined => ctx.tables.get<OspfInterfaceRow>('ospf-interfaces');
  const nbrTable = (ctx: ProcessCtx): Table<OspfNeighborRow> | undefined => ctx.tables.get<OspfNeighborRow>('ospf-neighbors');
  const lsdbTable = (ctx: ProcessCtx): Table<OspfLsaRow> | undefined => ctx.tables.get<OspfLsaRow>('ospf-lsdb');

  function ifRowOf(ctx: ProcessCtx, i: Iface): OspfInterfaceRow {
    const row: OspfInterfaceRow = {
      key: i.port,
      port: i.port,
      process: proc!.pid,
      routerId: proc!.routerId,
      area: i.area,
      networkType: i.networkType,
      state: i.state,
      cost: i.cost,
      costSource: i.costSource,
      priority: i.priority,
      helloS: i.helloS,
      deadS: i.deadS,
      passive: i.passive,
      neighbors: i.nbrs.size,
      adjacent: [...i.nbrs.values()].filter((n) => n.state === 'full').length,
      stateSince: i.stateSince,
      updatedAt: ctx.now,
    };
    if (i.address !== undefined) row.address = i.address;
    if (i.prefixLen !== undefined) row.prefixLen = i.prefixLen;
    if (i.dr !== OSPF_NO_DR) {
      row.drAddress = i.dr;
      if (i.drRid !== undefined) row.dr = i.drRid;
    }
    if (i.bdr !== OSPF_NO_DR) {
      row.bdrAddress = i.bdr;
      if (i.bdrRid !== undefined) row.bdr = i.bdrRid;
    }
    if (i.waitUntil !== undefined) row.waitUntil = i.waitUntil;
    if (i.rejected !== undefined) row.rejected = { ...i.rejected };
    return row;
  }

  function writeIfRow(ctx: ProcessCtx, i: Iface): void {
    if (proc === undefined) return;
    const row = ifRowOf(ctx, i);
    const fp = fingerprint(row);
    if (fp === i.rowFp) return;
    i.rowFp = fp;
    ifTable(ctx)?.set(row);
  }

  function nbrRowOf(ctx: ProcessCtx, i: Iface, n: Nbr): OspfNeighborRow {
    const row: OspfNeighborRow = {
      key: ospfNbrKey(n.port, n.routerId),
      port: n.port,
      routerId: n.routerId,
      address: n.address,
      priority: n.priority,
      state: n.state,
      role: ospfNeighborRole(i.networkType, n.address, i.dr, i.bdr),
      dr: n.declared?.dr ?? OSPF_NO_DR,
      bdr: n.declared?.bdr ?? OSPF_NO_DR,
      stateSince: n.stateSince,
      updatedAt: ctx.now,
    };
    if (n.nbrMaster !== undefined) row.master = n.nbrMaster;
    return row;
  }

  function writeNbrRow(ctx: ProcessCtx, i: Iface, n: Nbr): void {
    const row = nbrRowOf(ctx, i, n);
    const fp = fingerprint(row);
    if (fp === n.rowFp) return;
    n.rowFp = fp;
    nbrTable(ctx)?.set(row);
  }

  function installRow(ctx: ProcessCtx, row: OspfLsaRow): void {
    lsdb.set(row.key, row);
    lsdbTable(ctx)?.set(row);
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

  function ipLayer(src: Ipv4Address, dst: Ipv4Address): LayerSpec {
    ipId = (ipId + 1) & 0xffff;
    return { proto: 'ipv4', fields: { src, dst, ttl: 1, protocol: IPPROTO_OSPF, dscp: OSPF_DSCP, id: ipId } };
  }

  /** Build and send one OSPF packet out `i` to `dst`. */
  function sendPacket(ctx: ProcessCtx, out: Out, i: Iface, dst: Ipv4Address, type: number, fields: Record<string, FieldValue>, inner: readonly LayerSpec[], detail: string): Pdu | undefined {
    if (proc === undefined || i.address === undefined) return undefined;
    const tag = type === OSPF_PACKET.hello ? 'ospf-hello' : type === OSPF_PACKET.dbd ? 'ospf-dbd' : type === OSPF_PACKET.lsr ? 'ospf-lsr' : type === OSPF_PACKET.lsu ? 'ospf-lsu' : 'ospf-lsack';
    const meta: Partial<PduMeta> = { tag, flow: `ipv4:${i.address}>${dst}:ospf`, ...(type === OSPF_PACKET.hello ? { background: true } : {}) };
    const layers: LayerSpec[] = [
      ipLayer(i.address, dst),
      { proto: 'ospf', fields: { version: 2, type, routerId: proc.routerId, area: i.area, ...fields } },
      ...inner,
    ];
    const pdu = ctx.newPdu(layers, meta);
    debug(ctx, OSPF_DEBUG.packet, `${i.port}: sent ${ospfPacketText(type)} to ${dst}${detail === '' ? '' : `, ${detail}`} (pdu ${pdu.id})`, { port: i.port, dst, type, pdu: pdu.id });
    out.actions.push({ type: 'request', to: 'ipv4', req: { kind: 'ipv4.send', pdu, iface: i.port, nextHop: dst, cause: `ospf ${proc.pid} ${ospfPacketText(type)} on ${i.port}` } });
    return pdu;
  }

  function sendHello(ctx: ProcessCtx, out: Out, i: Iface, why: string): void {
    if (i.address === undefined || i.prefixLen === undefined) return;
    const heard = [...i.nbrs.values()].filter((n) => nsmAtLeast(n.state, 'init')).sort(byRid).map((n) => n.routerId);
    i.helloCount++;
    const fields: Record<string, FieldValue> = {
      mask: prefixLenToMask(i.prefixLen),
      helloInterval: i.helloS,
      options: OSPF_OPTIONS,
      priority: i.priority,
      deadInterval: i.deadS,
      dr: i.dr,
      bdr: i.bdr,
      neighbors: heard.join(','),
    };
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
    sendPacket(ctx, out, i, directDestination(i.networkType, n.address), OSPF_PACKET.dbd, { mtu, options: OSPF_OPTIONS, flags: s.flags, ddSeq: s.ddSeq >>> 0 }, s.headers, `seq ${s.ddSeq}, flags ${ddFlagsText(s.flags)}, ${s.headers.length} headers`);
  }

  function sendLsr(ctx: ProcessCtx, out: Out, i: Iface, n: Nbr): void {
    const batch = [...n.requests.entries()].slice(0, OSPF_LSR_MAX_ENTRIES);
    if (batch.length === 0) return;
    n.lastLsr = batch.map(([k]) => k);
    const requests = batch.map(([, r]) => lsrEntryOf(r.type, r.lsid, r.advRouter)).join(';');
    debug(ctx, OSPF_DEBUG.flood, `${i.port}: requesting ${batch.length} ${batch.length === 1 ? 'LSA' : 'LSAs'} from ${n.routerId}`, { port: i.port, neighbor: n.routerId, requests });
    sendPacket(ctx, out, i, directDestination(i.networkType, n.address), OSPF_PACKET.lsr, { requests }, [], `${batch.length} requests`);
  }

  function armRxmt(n: Nbr, out: Out): void {
    if (n.rxmtArmed) return;
    n.rxmtArmed = true;
    out.actions.push(timer(`rxmt:${n.port}:${n.routerId}`, OSPF_RXMT_NS, true));
  }

  function queueFlood(out: Out, port: PortId, dst: Ipv4Address, key: string): void {
    const k = `${port}|${dst}`;
    let e = out.flood.get(k);
    if (e === undefined) {
      e = { port, dst, keys: new Set() };
      out.flood.set(k, e);
    }
    e.keys.add(key);
  }

  function queueDirect(out: Out, i: Iface, n: Nbr, key: string): void {
    const dst = directDestination(i.networkType, n.address);
    const k = `${i.port}|${dst}`;
    let e = out.direct.get(k);
    if (e === undefined) {
      e = { port: i.port, dst, keys: new Set() };
      out.direct.set(k, e);
    }
    e.keys.add(key);
  }

  function queueAck(out: Out, i: Iface, n: Nbr, w: OspfLsaWire): void {
    const dst = directDestination(i.networkType, n.address);
    const k = `${i.port}|${dst}`;
    let e = out.acks.get(k);
    if (e === undefined) {
      e = { port: i.port, dst, headers: new Map() };
      out.acks.set(k, e);
    }
    e.headers.set(lsaKeyOf(lsaScopeOf(w.type, i.area), w.type, w.lsid, w.advRouter), wireHeaderLayerOf(w));
  }

  /** Emit the bundled updates (flooded, then direct) and acknowledgements of this handler call. */
  function finish(ctx: ProcessCtx, out: Out): void {
    const updates = (bundles: Map<string, { port: PortId; dst: Ipv4Address; keys: Set<string> }>, kind: string): void => {
      for (const b of bundles.values()) {
        const i = ifaces.get(b.port);
        if (i === undefined || i.state === 'down') continue;
        const rows = sortedLsdb([...b.keys].map((k) => lsdb.get(k)).filter((r): r is OspfLsaRow => r !== undefined));
        let chunk: OspfLsaRow[] = [];
        let bytes = 4;
        const flush = (): void => {
          if (chunk.length === 0) return;
          debug(ctx, OSPF_DEBUG.flood, `${i.port}: ${kind} update to ${b.dst}: ${chunk.map((r) => lsaText(r)).join('; ')}`, { port: i.port, dst: b.dst, lsas: chunk.map((r) => r.key) });
          sendPacket(ctx, out, i, b.dst, OSPF_PACKET.lsu, {}, chunk.map((r) => lsaLayerOf(r, ctx.now)), `${chunk.length} ${chunk.length === 1 ? 'LSA' : 'LSAs'}`);
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

  function wantedGroups(i: Iface): Ipv4Address[] {
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
      out.actions.push({ type: 'request', to: 'ipv4', req: { kind: 'ipv4.group', op: should ? 'join' : 'leave', iface: i.port, group: g, owner: NAME } });
    }
  }

  function setIfState(ctx: ProcessCtx, out: Out, i: Iface, to: OspfIsmState, cause: string): void {
    const from = i.state;
    if (from === to) return;
    i.state = to;
    i.stateSince = ctx.now;
    transition(ctx, `${i.port}: interface ${from} -> ${to} (${cause})`, { machine: 'ospf-if', subject: i.port, port: i.port, from, to, cause });
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
    const fsm: FsmTransition = { machine: 'ospf-nbr', subject: `${i.port} ${n.routerId}`, port: i.port, from, to, cause, ...(pdu !== undefined ? { pdu: pdu.id } : {}) };
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
    n.summary = sortedLsdb(lsdbForArea(lsdb.values(), i.area))
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
      if (row !== undefined) headers.push(lsaHeaderLayerOf(row, ctx.now));
    }
    return { headers, more: n.summary.length > 0 };
  }

  /** Read the LSA headers of a DBD into the request list; false on an unknown LSA type (SeqNumberMismatch). */
  function takeHeaders(ctx: ProcessCtx, i: Iface, n: Nbr, layers: readonly LayerView[]): boolean {
    for (const l of layers) {
      const w = lsaWireOf(l.fields);
      if (w === undefined || !isOspfLsaType(w.type)) return false;
      const key = lsaKeyOf(lsaScopeOf(w.type, i.area), w.type, w.lsid, w.advRouter);
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

  function rxHello(ctx: ProcessCtx, out: Out, i: Iface, pdu: Pdu, src: Ipv4Address, f: Readonly<Record<string, FieldValue>>): void {
    if (proc === undefined || i.address === undefined || i.prefixLen === undefined) return;
    const routerId = str(f.routerId);
    const hello = {
      routerId,
      area: str(f.area),
      src,
      mask: str(f.mask),
      helloS: num(f.helloInterval),
      deadS: num(f.deadInterval),
      options: num(f.options),
      authType: num(f.auType),
    };
    const check = checkOspfHello(
      { routerId: proc.routerId, area: i.area, networkType: i.networkType, address: i.address, prefixLen: i.prefixLen, helloS: i.helloS, deadS: i.deadS, options: OSPF_OPTION_E, authType: 0 },
      hello,
    );
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
    const entries = parseLsrEntries(str(f.requests));
    debug(ctx, OSPF_DEBUG.flood, `${i.port}: ${n.routerId} requests ${entries.length} ${entries.length === 1 ? 'LSA' : 'LSAs'}`, { port: i.port, neighbor: n.routerId });
    for (const e of entries) {
      const key = lsaKeyOf(lsaScopeOf(e.type, i.area), e.type, e.lsid, e.advRouter);
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
    if (w.advRouter === proc.routerId) return true;
    if (w.type !== 2) return false;
    for (const i of ifaces.values()) if (i.address === w.lsid) return true;
    return ctx.ownAddress(w.lsid) !== undefined;
  }

  function rxLsu(ctx: ProcessCtx, out: Out, i: Iface, n: Nbr, pdu: Pdu, lsas: readonly LayerView[]): void {
    out.actions.push({ type: 'consume', pdu });
    if (!nsmAtLeast(n.state, 'exchange') || proc === undefined) return;
    for (const l of lsas) {
      const w = lsaWireOf(l.fields);
      if (w === undefined || w.checksumValid === false || !isOspfLsaType(w.type)) {
        debug(ctx, OSPF_DEBUG.flood, `${i.port}: discarded an LSA from ${n.routerId}: ${w === undefined ? 'incomplete header' : w.checksumValid === false ? 'bad checksum' : `unknown type ${w.type}`}`, { port: i.port });
        continue;
      }
      const scope = lsaScopeOf(w.type, i.area);
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
          debug(ctx, OSPF_DEBUG.flood, `${i.port}: ${lsaText(w)} from ${n.routerId} discarded: the last copy arrived less than 1 s ago`, { port: i.port, lsa: key });
          continue;
        }
        const self = isSelf(ctx, w);
        if (n.requests.has(key)) byRequest.add(key);
        else byRequest.delete(key);
        const row = lsaRowOf(w, scope, ctx.now, self && w.advRouter === proc.routerId);
        const floodedBack = installAndFlood(ctx, out, row, { port: i.port, routerId: n.routerId }, `${lsaText(w)} from ${n.routerId}`);
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
      const w = lsaWireOf(l.fields);
      if (w === undefined) continue;
      const key = lsaKeyOf(lsaScopeOf(w.type, i.area), w.type, w.lsid, w.advRouter);
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
    const changed = prev === undefined || (prev.maxAge === true) !== (row.maxAge === true) || !lsaBodyEqual(prev, row);
    if (changed) scheduleSpf(ctx, out, `${lsaText(row)}${row.maxAge === true ? ' flushed' : prev === undefined ? ' added' : ' changed'}`);
    if (!row.self) armMaxAge(out);
    if (row.maxAge === true) out.checkMaxAge = true;
    return flood(ctx, out, row, from);
  }

  function flood(ctx: ProcessCtx, out: Out, row: OspfLsaRow, from: { port: PortId; routerId: Ipv4Address } | undefined): boolean {
    const inst: LsaInstance = { seq: row.seq, checksum: row.checksum, age: row.maxAge === true ? LSA_MAX_AGE_S : lsaAgeAt(row, ctx.now) };
    let floodedBack = false;
    for (const i of ordered(ctx)) {
      if (!running(i) || i.silent || i.state === 'loopback') continue;
      if (row.scope !== 'as' && row.scope !== i.area) continue;
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
        queueFlood(out, i.port, v.dst, row.key);
        if (from !== undefined && from.port === i.port) floodedBack = true;
      }
    }
    return floodedBack;
  }

  /** The OSPF interfaces as the router-LSA sees them. */
  function originIfaces(ctx: ProcessCtx): OriginIface[] {
    return ordered(ctx).map((i) => {
      const full = [...i.nbrs.values()].filter((n) => n.state === 'full').sort(byRid).map((n) => ({ routerId: n.routerId, address: n.address }));
      const o: OriginIface = { port: i.port, area: i.area, networkType: i.networkType, state: i.state, cost: i.cost, dr: i.dr, fullNeighbors: full };
      return i.address !== undefined && i.prefixLen !== undefined ? { ...o, address: i.address, prefixLen: i.prefixLen } : o;
    });
  }

  function areasOf(ctx: ProcessCtx): OspfAreaId[] {
    const out: OspfAreaId[] = [];
    for (const i of ordered(ctx)) if (!out.includes(i.area)) out.push(i.area);
    return out;
  }

  /** Every self LSA this router wants now, by key. */
  function desiredSelf(ctx: ProcessCtx): Map<string, OspfLsaBody> {
    const out = new Map<string, OspfLsaBody>();
    if (proc === undefined) return out;
    const rid = proc.routerId;
    const oifs = originIfaces(ctx);
    const areas = areasOf(ctx);
    const external = cfg?.process?.defaultOriginate !== undefined && (cfg.process.defaultOriginate === 'always' || haveDefault);
    for (const area of areas) {
      const body = routerLsaBody(rid, area, oifs, { areaBorder: areas.length > 1, asbr: external });
      const key = lsaKeyOf(area, 1, rid, rid);
      const had = lsdb.get(key);
      if (body.links.length > 0 || (had !== undefined && had.maxAge !== true)) out.set(key, body);
    }
    for (const o of oifs) {
      const body = networkLsaBody(rid, o);
      if (body !== undefined) out.set(lsaKeyOf(o.area, 2, body.lsid, rid), body);
    }
    if (external) out.set(lsaKeyOf('as', 5, '0.0.0.0', rid), defaultExternalBody(rid));
    return out;
  }

  function originateAll(ctx: ProcessCtx, out: Out): void {
    if (proc === undefined) return;
    const want = desiredSelf(ctx);
    for (const [key, body] of want) originate(ctx, out, key, body, false);
    for (const row of sortedLsdb(lsdb.values())) {
      if (row.advRouter !== proc.routerId || row.maxAge === true || want.has(row.key)) continue;
      flushSelf(ctx, out, row, 'no longer originated');
    }
    armRefresh(ctx, out);
  }

  /** Originate (or re-originate) `key` with `body` now, or arm its `lsa-gen` (MinLSInterval) or `self-war` timer. */
  function originate(ctx: ProcessCtx, out: Out, key: string, body: OspfLsaBody, force: boolean, fromWar = false): void {
    if (proc === undefined) return;
    const db = lsdb.get(key);
    if (!force && db !== undefined && db.maxAge !== true && lsaBodyEqual(db, body)) {
      if (!db.self) installRow(ctx, { ...db, self: true, updatedAt: ctx.now });
      dropGen(out, key);
      return;
    }
    const due = lsaGenAt(lastOrig.get(key), ctx.now);
    const war = warSeen.get(key);
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
    const scope = lsaScopeOf(body.type, key.slice(0, key.indexOf('|')));
    const content = { ...body, seq };
    const { checksum, length } = lsaChecksumAndLength(content);
    const row: OspfLsaRow = {
      key,
      scope,
      type: body.type,
      lsid: body.lsid,
      advRouter: body.advRouter,
      seq,
      ageAtInstall: 0,
      installedAt: ctx.now,
      checksum,
      length,
      options: body.options,
      self: true,
      updatedAt: ctx.now,
    };
    if (body.flags !== undefined) row.flags = { ...body.flags };
    if (body.links !== undefined) row.links = body.links.map((l) => ({ ...l }));
    if (body.mask !== undefined) row.mask = body.mask;
    if (body.attached !== undefined) row.attached = [...body.attached];
    if (body.metric !== undefined) row.metric = body.metric;
    if (body.external !== undefined) row.external = { ...body.external };
    lastOrig.set(key, ctx.now);
    installAndFlood(ctx, out, row, undefined, `own ${lsaText(row)}`);
  }

  function dropGen(out: Out, key: string): void {
    if (genDue.delete(key)) out.actions.push(cancel(`lsa-gen:${key}`));
    if (warDue.delete(key)) out.actions.push(cancel(`self-war:${key}`));
  }

  /** Premature aging (RFC 2328 §14.1): the row at MaxAge, flooded, removed once acknowledged. */
  function flushSelf(ctx: ProcessCtx, out: Out, row: OspfLsaRow, why: string): void {
    dropGen(out, row.key);
    const flushed: OspfLsaRow = { ...row, ageAtInstall: LSA_MAX_AGE_S, installedAt: ctx.now, maxAge: true, updatedAt: ctx.now };
    debug(ctx, OSPF_DEBUG.flood, `flushing ${lsaText(row)} (${why})`, { lsa: row.key });
    installAndFlood(ctx, out, flushed, undefined, lsaText(row));
  }

  /** RFC 2328 §13.4: a newer copy of a self-originated LSA arrived. */
  function selfNewer(ctx: ProcessCtx, out: Out, row: OspfLsaRow): void {
    if (proc === undefined) return;
    const prev = warSeen.get(row.key);
    const count = prev !== undefined && ctx.now - prev.at < OSPF_SELF_WAR_WINDOW_NS ? prev.count + 1 : 1;
    warSeen.set(row.key, { at: ctx.now, count, logged: prev?.logged === true && count > 1 });
    if (count >= 2 && row.type === 1 && warSeen.get(row.key)!.logged !== true) {
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
    for (const row of sortedLsdb(lsdb.values())) {
      if (row.maxAge !== true) continue;
      let held = false;
      for (const i of ifaces.values()) for (const n of i.nbrs.values()) if (n.rxmt.has(row.key)) held = true;
      if (held) continue;
      removeRow(ctx, row.key, 'aged');
      debug(ctx, OSPF_DEBUG.flood, `removed ${lsaText(row)} (MaxAge, acknowledged)`, { lsa: row.key });
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
    const res = computeOspfRoutes(sortedLsdb(lsdb.values()), proc.routerId, areas, { maximumPaths: cfg?.process?.maximumPaths ?? 4, now: ctx.now });
    trees = res.trees;
    spfRuns++;
    lastSpfAt = ctx.now;
    lastSpfReason = reason;
    const vertices = res.trees.reduce((s, t) => s + t.tree.vertices.length, 0);
    debug(ctx, OSPF_DEBUG.spf, `SPF run ${spfRuns} (${reason}): ${vertices} vertices, ${res.routes.length} routes`, { runs: spfRuns, reason });
    reportRouteChanges(ctx, res.rows);
    lastRoutes = res.rows;
    routesSent = true;
    out.actions.push({ type: 'request', to: 'ipv4', req: { kind: 'ipv4.routes', owner: NAME, rows: res.rows } });
  }

  function reportRouteChanges(ctx: ProcessCtx, rows: readonly RouteRow[]): void {
    const text = (list: readonly RouteRow[]): Map<string, string> => {
      const m = new Map<string, string>();
      for (const r of list) m.set(r.key, `${m.has(r.key) ? `${m.get(r.key)!}, ` : ''}${ospfRouteText(r)}`);
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

  // ── process lifecycle and resync ──────────────────────────────────────────

  function hasRouterOspf(ctx: ProcessCtx): boolean {
    return ctx.config.root.children.some((c) => c.key === 'router' && c.args[0] === 'ospf');
  }

  function wants(ctx: ProcessCtx, c: OspfConfig): IfaceWant[] {
    const p = c.process;
    if (p === undefined) return [];
    const cands: { port: PortId; address?: Ipv4Address }[] = [];
    for (const [id, view] of ctx.ports) {
      if (!OSPF_PORT_ROLES.includes(view.role)) continue;
      const a = view.l3.ipv4;
      cands.push(a !== undefined ? { port: id, address: a.address } : { port: id });
    }
    const out: IfaceWant[] = [];
    for (const e of ospfEnabledInterfaces(c, cands)) {
      const view = ctx.ports.get(e.port)!;
      const icfg = c.interfaces.get(e.port);
      const role = view.role;
      const parent = view.spec.parent !== undefined ? ctx.ports.get(view.spec.parent) : undefined;
      const speedBps = role === 'subif' ? (parent?.speedBps ?? parent?.spec.speedBps) : (view.speedBps ?? view.spec.speedBps);
      const bw = routingBandwidthKbps({ role, ...(speedBps !== undefined ? { speedBps } : {}), ...(icfg?.bandwidthKbps !== undefined ? { configuredKbps: icfg.bandwidthKbps } : {}) });
      const { cost, costSource } = ospfInterfaceCost({ ...(icfg?.cost !== undefined ? { configuredCost: icfg.cost } : {}), referenceMbps: p.referenceBandwidthMbps, bandwidthKbps: bw });
      const timers = ospfIfaceTimers(icfg);
      const passive = isOspfPassive(p, e.port);
      const a = view.l3.ipv4;
      const w: IfaceWant = {
        port: e.port,
        area: e.area,
        role,
        networkType: ospfNetworkType(role, icfg?.networkType),
        cost,
        costSource,
        priority: ospfIfacePriority(icfg),
        helloS: timers.helloS,
        deadS: timers.deadS,
        passive,
        silent: passive || role === 'virtual',
        up: view.operUp && a !== undefined,
        ...(a !== undefined ? { address: a.address, prefixLen: a.prefixLen } : {}),
      };
      out.push(w);
    }
    return out;
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
      out.actions.push({ type: 'request', to: 'ipv4', req: { kind: 'ipv4.routes', owner: NAME, rows: [] } });
      reportRouteChanges(ctx, []);
      routesSent = false;
      lastRoutes = [];
    }
    if (watchKeys.length > 0) {
      watchKeys = [];
      out.actions.push({ type: 'request', to: 'ipv4', req: { kind: 'ipv4.ribWatch', owner: NAME, keys: [] } });
    }
    haveDefault = false;
    debug(ctx, OSPF_DEBUG.adj, `OSPF process ${proc.pid} stopped (${why})`, { pid: proc.pid });
    proc = undefined;
  }

  function resync(ctx: ProcessCtx, out: Out): void {
    const c = readOspfConfig(ctx.config);
    cfg = c;
    const p = c.process;
    if (p === undefined || ipRoutingSwitchedOff(ctx)) {
      stop(ctx, out, p === undefined ? 'no router ospf' : 'ip routing is switched off');
      noRidLogged = false;
      return;
    }
    if (proc !== undefined && proc.pid !== p.pid) stop(ctx, out, `process ${proc.pid} replaced by ${p.pid}`);
    if (proc === undefined) {
      const ports: { role: PortRole; operUp: boolean; address?: Ipv4Address }[] = [];
      let anyAddress = false;
      for (const view of ctx.ports.values()) {
        const a = view.l3.ipv4?.address;
        if (a !== undefined) anyAddress = true;
        ports.push(a !== undefined ? { role: view.role, operUp: view.operUp, address: a } : { role: view.role, operUp: view.operUp });
      }
      const pick = selectOspfRouterId(p.routerId, ports);
      if (pick === undefined) {
        if (!anyAddress && !noRidLogged) {
          noRidLogged = true;
          const message = CLI_MESSAGES.ospfNoRouterId.replace('{pid}', String(p.pid));
          debug(ctx, OSPF_DEBUG.adj, message, { pid: p.pid });
          out.actions.push({ type: 'log', severity: 4, facility: 'OSPF', message });
        }
        return;
      }
      start(ctx, p, pick.routerId, pick.source);
    }
    // interfaces
    const wanted = wants(ctx, c);
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
    syncWatch(ctx, out);
  }

  function syncWatch(ctx: ProcessCtx, out: Out): void {
    const keys: string[] = [];
    if (proc !== undefined && cfg?.process?.defaultOriginate !== undefined) keys.push('0.0.0.0/0');
    if (proc !== undefined) {
      for (const i of ordered(ctx)) {
        const a = ctx.ports.get(i.port)?.l3.ipv4;
        if (a !== undefined && (a.origin === 'dhcp' || a.origin === 'apipa')) keys.push(routeKey(networkOf(a.address, a.prefixLen), a.prefixLen));
      }
    }
    if (keys.length === watchKeys.length && keys.every((k, n) => k === watchKeys[n])) return;
    watchKeys = keys;
    if (!keys.includes('0.0.0.0/0')) haveDefault = false;
    out.actions.push({ type: 'request', to: 'ipv4', req: { kind: 'ipv4.ribWatch', owner: NAME, keys } });
  }

  // ── timers ────────────────────────────────────────────────────────────────

  function onTimerKey(ctx: ProcessCtx, out: Out, key: string): void {
    const at = key.indexOf(':');
    const kind = at < 0 ? key : key.slice(0, at);
    const rest = at < 0 ? '' : key.slice(at + 1);
    switch (kind) {
      case 'resync':
        resyncArmed = false;
        resync(ctx, out);
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
        for (const r of sortedLsdb(lsdb.values())) {
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
        for (const r of sortedLsdb(lsdb.values())) {
          if (r.self && r.maxAge !== true) continue;
          others = true;
          if (r.maxAge !== true && lsaAgeAt(r, ctx.now) >= LSA_MAX_AGE_S) {
            installAndFlood(ctx, out, { ...r, ageAtInstall: LSA_MAX_AGE_S, installedAt: ctx.now, maxAge: true, updatedAt: ctx.now }, undefined, `${lsaText(r)} (reached MaxAge)`);
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

  // ── the process ───────────────────────────────────────────────────────────

  return {
    name: NAME,

    init(ctx: ProcessCtx): Action[] {
      return hasRouterOspf(ctx) ? armResync() : [];
    },

    onPdu(ctx: ProcessCtx, pdu: Pdu, port: PortId): Action[] {
      return run(ctx, (out) => {
        const ip = pdu.layer('ipv4');
        const o = pdu.layer('ospf');
        if (ip === undefined || o === undefined) {
          out.actions.push({ type: 'drop', pdu, reason: 'other', detail: 'not an OSPF packet', port });
          return;
        }
        if (o.fields.checksumValid === false) {
          out.actions.push({ type: 'drop', pdu, reason: 'bad-checksum', detail: o.error ?? 'OSPF checksum mismatch', port });
          return;
        }
        const i = ifaces.get(port);
        if (proc === undefined || i === undefined || i.state === 'down' || i.silent || i.state === 'loopback') {
          out.actions.push({ type: 'drop', pdu, reason: 'other', detail: `OSPF does not run on ${port}${i?.silent === true ? ' (passive)' : ''}`, port });
          return;
        }
        const src = str(ip.fields.src);
        const dst = str(ip.fields.dst);
        const type = num(o.fields.type);
        if (src === i.address) {
          out.actions.push({ type: 'consume', pdu });
          return;
        }
        if (num(o.fields.version) !== 2) {
          out.actions.push({ type: 'drop', pdu, reason: 'other', detail: `OSPF version ${num(o.fields.version)} is not spoken here`, port });
          return;
        }
        if (dst === ALL_DROUTERS && i.state !== 'dr' && i.state !== 'backup') {
          out.actions.push({ type: 'drop', pdu, reason: 'not-for-me', detail: `${port} is neither DR nor BDR (AllDRouters)`, port });
          return;
        }
        const lsas = pdu.layers.filter((l) => l.proto === 'ospf-lsa');
        debug(ctx, OSPF_DEBUG.packet, `${port}: received ${ospfPacketText(type)} from ${str(o.fields.routerId)} (${src})${lsas.length > 0 ? `, ${lsas.length} LSAs` : ''} (pdu ${pdu.id})`, { port, from: src, type, pdu: pdu.id });
        if (type === OSPF_PACKET.hello) {
          rxHello(ctx, out, i, pdu, src, o.fields);
          return;
        }
        if (str(o.fields.area) !== i.area) {
          out.actions.push({ type: 'drop', pdu, reason: 'other', detail: `OSPF area ${str(o.fields.area)} does not match ${port}'s area ${i.area}`, port });
          return;
        }
        const n = i.nbrs.get(str(o.fields.routerId));
        if (n === undefined) {
          out.actions.push({ type: 'drop', pdu, reason: 'other', detail: `no OSPF neighbour ${str(o.fields.routerId)} on ${port}`, port });
          return;
        }
        switch (type) {
          case OSPF_PACKET.dbd:
            rxDbd(ctx, out, i, n, pdu, o.fields, lsas);
            return;
          case OSPF_PACKET.lsr:
            rxLsr(ctx, out, i, n, pdu, o.fields);
            return;
          case OSPF_PACKET.lsu:
            rxLsu(ctx, out, i, n, pdu, lsas);
            return;
          case OSPF_PACKET.lsack:
            rxAck(ctx, out, i, n, pdu, lsas);
            return;
          default:
            out.actions.push({ type: 'drop', pdu, reason: 'other', detail: `unknown OSPF packet type ${type}`, port });
        }
      });
    },

    onTimer(ctx: ProcessCtx, key: string): Action[] {
      return run(ctx, (out) => onTimerKey(ctx, out, key));
    },

    onConfig(ctx: ProcessCtx, _delta: ConfigDelta): Action[] {
      if (proc === undefined && !hasRouterOspf(ctx)) return [];
      return armResync();
    },

    onLinkChange(ctx: ProcessCtx): Action[] {
      if (proc === undefined && !hasRouterOspf(ctx)) return [];
      return armResync();
    },

    onRequest(ctx: ProcessCtx, req: ProcessRequest): Action[] {
      if (req.kind !== 'ospf.clear') return [];
      return run(ctx, (out) => {
        if (proc === undefined) {
          resync(ctx, out);
          return;
        }
        const configured = cfg?.process?.routerId;
        if (configured !== undefined && configured !== proc.routerId) {
          // the router id changes: flush this router's LSAs first, while its adjacencies still carry them
          for (const row of sortedLsdb(lsdb.values())) if (row.advRouter === proc.routerId && row.maxAge !== true) flushSelf(ctx, out, row, 'router ID changes');
          finish(ctx, out);
        }
        stop(ctx, out, 'clear ip ospf process');
        resync(ctx, out);
      });
    },

    onEvent(ctx: ProcessCtx, ev: ProcessEvent): Action[] {
      if (ev.kind !== 'ipv4.ribChanged' || proc === undefined) return [];
      return run(ctx, (out) => {
        if (ev.key === '0.0.0.0/0') {
          const has = ev.row !== undefined && ev.row.source !== 'O';
          if (has !== haveDefault) {
            haveDefault = has;
            debug(ctx, OSPF_DEBUG.spf, `default route ${has ? 'present' : 'gone'}: ${cfg?.process?.defaultOriginate === undefined ? 'not advertised' : has || cfg.process.defaultOriginate === 'always' ? 'advertised' : 'no longer advertised'}`, { has });
            out.originate = true;
          }
        } else if (ev.key !== undefined) {
          out.actions.push(...armResync());
        }
      });
    },

    onShutdown(): Action[] {
      return [];
    },

    stateSnapshot(): StateView {
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
    },

    debugEvents(): readonly DebugEvent[] {
      return ring;
    },
  };
}
