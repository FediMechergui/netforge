/**
 * protocols/stp.ts — the per-VLAN spanning-tree daemon: PVST+ (802.1D rules per VLAN) and Rapid PVST+ (802.1w rules
 * per VLAN) (ARCHITECTURE-P2 D3, D6, D8, D9, §2.4, §2.6, §3.0 steps 5–6, §3.2 step 6, §3.6, §4.2, §4.3, §5.1).
 *
 * Instances (D9). One instance per VLAN that exists (VLAN 1 or a `vlans` row; the reserved 1002–1005 run none), is
 * not disabled with `no spanning-tree vlan <v>`, and has at least one up STP port carrying it; at most
 * `STP_MAX_INSTANCES` (128) in ascending VLAN order, the rest run none and a log line says so once. An STP port is an
 * oper-up bridged Ethernet port that is not a bundled, waiting or suspended EtherChannel member (a Port-channel is one
 * bridge port, D10). The instance set is reconciled on every config line, link change and `l2.changed` signal.
 *
 * Silence (§4.3). The daemon sends nothing, arms no timer, writes no row and emits no debug or log line unless
 * `spanning-tree mode pvst|rapid-pvst` is in the running config AND an instance has an up port. A P1-profile world
 * replays no such line, so the daemon's presence changes no byte there; the P2 profile replays it on managed switches.
 *
 * Tables (writer of both, D6): `stp-bridge` (key `vlanKey(vlan)`) and `stp` (key `stpKey(vlan, port)`, one row per
 * instance port; a bundled member has none). eth-switch reads the `stp` row's `state` per frame (the gate, §3.0 step
 * 6) and the runtime derives SVI autostate from it; every change to or from `forwarding` issues
 * `l2Changed {what:'stp', port, vlan}` after the row is written.
 *
 * BPDUs (D8): IEEE format, `[ethernet {dst 01:80:c2:00:00:00, src port MAC}, (dot1q {vid})?, llc {0x42, 0x42, 3},
 * stp {…}]`, `meta {tag:'bpdu', background:true}`. On a trunk the BPDU is tagged per membership (the native VLAN's is
 * untagged) and carries the `pvid` TLV; on an access port it is a plain BPDU without the TLV (a voice-VLAN BPDU is
 * tagged with the TLV, S4). Received BPDUs come from eth-switch's `deliver` on the logical port; the VLAN is the
 * frame's classification on that port (tag, else access or native VLAN).
 *
 * Rules: `stp/pvst.ts` (802.1D), `stp/rstp.ts` (802.1w), `stp/mixed.ts` (port protocol migration), `stp/guards.ts`
 * (PortFast, BPDU guard, root guard, pvid and type inconsistencies); identities in `stp/ids.ts`, vectors in
 * `stp/vector.ts`, costs in `stp/cost.ts`.
 *
 * Timers (§4.2; keys are process-local): periodic `hello:<vlan>` (2 s, one per instance, armed in ascending VLAN
 * order), `age:<vlan>:<port>` (re-armed per BPDU: 802.1D `maxAge − messageAge`, 802.1w 3 × hello), `tcn:<vlan>`
 * (TCN retransmit every hello until acknowledged) and `errdisable:<port>` (BPDU-guard recovery); never periodic
 * `fwd:<vlan>:<port>` (forward delay), `tc:<vlan>` (root TC window 35 s), `tcwhile:<vlan>:<port>` (2 × hello) and
 * `migrate:<vlan>:<port>` (3 s). No randomness (§4.1).
 *
 * Transitions (D19): every port state and role change, every root change and every protocol migration is one
 * `ctx.transition('spanning-tree events', …)` with machine `stp-port` (subject `VLAN0001 GigabitEthernet0/2`) or
 * `stp-bridge` (subject `VLAN0001`).
 *
 * `stateSnapshot()`: `{ process: 'stp', state: { mode, instances: [{vlan, root, rootPort, ports}], sent, received } }`.
 * Debug category: 'spanning-tree events' (§5.4).
 *
 * `clear spanning-tree detected-protocols [interface <if>]` reaches the daemon as the request
 * `{ kind: 'ext.stp.clear-detected-protocols', port? }` (`STP_CLEAR_DETECTED_PROTOCOLS_REQUEST`, the contract's
 * `ext.` slot: §2.4 names no built-in kind for it).
 */
import type { MacAddress } from '../contracts/addr.js';
import { KIND_ENCAP, ROLE_TRAITS, defaultRoleFor } from '../contracts/catalog.js';
import type { PortEncap, PortRole } from '../contracts/catalog.js';
import type { ConfigDelta } from '../contracts/config.js';
import type { PduId, PortId } from '../contracts/ids.js';
import { LLC_SAP_STP, STP_GROUP_MAC } from '../contracts/pdu.js';
import type { LayerSpec, Pdu } from '../contracts/pdu.js';
import type { PortView, SwitchportConfig } from '../contracts/port.js';
import type { Action, DebugEvent, FsmTransition, Process, ProcessCtx, ProcessRequest, StateView } from '../contracts/process.js';
import { stpKey, vlanKey } from '../contracts/tables.js';
import type { DtpRow, EtherchannelRow, StpBridgeRow, StpInconsistency, StpPortRow, StpRole, StpState, VlanRow } from '../contracts/tables.js';
import { SEC } from '../contracts/time.js';
import type { SimTime } from '../contracts/time.js';
import type { L2FlushEvent, ProcessEvent } from '../contracts/transport.js';
import { STP_BPDU_CONFIG, STP_BPDU_RST, STP_BPDU_TCN, STP_VERSION_RSTP, STP_VERSION_STP } from '../pdu/codecs/stp.js';
import { carries, channelOperOf, classify, frameVlanTag, operOf, vlanExistsIn } from './l2/membership.js';
import type { L2PortView, VlanExistsFn } from './l2/membership.js';
import { errdisableRecovery, errdisableTimerKey } from './l2/port-security.js';
import { readAllSwitchports, readSwitchport } from './l2/switchport-config.js';
import { channelPathCost, effectivePathCost, portPathCost } from './stp/cost.js';
import {
  STP_DEFAULT_BRIDGE_PRIORITY,
  STP_DEFAULT_PORT_PRIORITY,
  bridgeIdOf,
  bridgeIdText,
  portIdParts,
  portIdText,
  portIdValue,
  stpPortNumber,
} from './stp/ids.js';
import type { BridgeId } from './stp/ids.js';
import {
  DEFAULT_STP_PORT_LINES,
  STP_LOG_FACILITY,
  bpduGuardDetail,
  bpduGuardMessage,
  facesTrunk,
  instanceCapMessage,
  isBpduGuardOn,
  isEdgePort,
  isRootGuardOn,
  isStpRelevantDelta,
  nativeMismatchClearedMessage,
  nativeMismatchMessage,
  nativeVlanMismatch,
  readAllStpPortLines,
  readStpGlobalLines,
  rootGuardClearedMessage,
  rootGuardMessage,
  typeInconsistentClearedMessage,
  typeInconsistentMessage,
} from './stp/guards.js';
import type { StpGlobalLines, StpMode, StpPortLines } from './stp/guards.js';
import {
  CAUSE_MIGRATED_TO_RSTP,
  CAUSE_MIGRATED_TO_STP,
  CAUSE_MIGRATION_CLEARED,
  STP_CLEAR_DETECTED_PROTOCOLS_REQUEST,
  STP_MIGRATE_DELAY_NS,
  bpduProtocolOf,
  legacyBridgeDiscards,
  migrationDecision,
} from './stp/mixed.js';
import type { StpPortProtocol } from './stp/mixed.js';
import {
  CAUSE_EDGE_PORT,
  CAUSE_FORWARD_DELAY_EXPIRED,
  CAUSE_INFORMATION_AGED,
  CAUSE_PORT_DOWN,
  CAUSE_PORT_UP,
  CAUSE_ROLE_CHANGED,
  CAUSE_SUPERIOR_BPDU,
  PVST_BLOCKED_STATE,
  PVST_ENTRY_STATE,
  configBpduFlags,
  detectsTcOnLeaving,
  isActiveRole,
  pvstAgeTimerNs,
  pvstNextState,
  pvstSupersedes,
  pvstTcWindowNs,
  relayedMessageAge,
} from './stp/pvst.js';
import {
  CAUSE_AGREEMENT_RECEIVED,
  CAUSE_PROPOSAL_ACCEPTED,
  CAUSE_REROOT,
  CAUSE_SYNC,
  CAUSE_TC_RECEIVED,
  RSTP_BLOCKED_STATE,
  RSTP_ENTRY_STATE,
  decodeRstFlags,
  isAgreementFor,
  isDesignatedSender,
  isPointToPoint,
  rstFlags,
  rstpAgeTimerNs,
  rstpNextState,
  tcWhileNs,
} from './stp/rstp.js';
import {
  STP_DEFAULT_TIMERS,
  isBetterVector,
  isSuperiorMessage,
  secondsToStpUnits,
  stpUnitsToNs,
  comparePriorityVectors,
} from './stp/vector.js';
import type { PriorityVector } from './stp/vector.js';

/** Process name registered by the catalog for managed switches. */
export const STP_PROCESS = 'stp';
/** Debug category of this daemon (`debug spanning-tree events`, §5.4). */
export const STP_DEBUG_CATEGORY = 'spanning-tree events';
/** Capacity of the per-process DebugEvent ring. */
export const STP_DEBUG_RING = 200;
/** Instances a switch runs at most (D9). */
export const STP_MAX_INSTANCES = 128;
/** PduMeta.tag of every BPDU (configuration, RST and TCN). */
export const STP_BPDU_TAG = 'bpdu';
/** 802.1D hold time: a designated port replies to inferior BPDUs at most once per second. */
export const STP_HOLD_TIME_NS: SimTime = 1 * SEC;

// ── timer keys (process-local, §4.2) ──────────────────────────────────────────
export const helloTimerKey = (vlan: number): string => `hello:${vlan}`;
export const fwdTimerKey = (vlan: number, port: PortId): string => `fwd:${vlan}:${port}`;
export const ageTimerKey = (vlan: number, port: PortId): string => `age:${vlan}:${port}`;
export const tcnTimerKey = (vlan: number): string => `tcn:${vlan}`;
export const tcTimerKey = (vlan: number): string => `tc:${vlan}`;
export const tcWhileTimerKey = (vlan: number, port: PortId): string => `tcwhile:${vlan}:${port}`;
export const migrateTimerKey = (vlan: number, port: PortId): string => `migrate:${vlan}:${port}`;

/** Transition subject of an instance port: `VLAN0010 GigabitEthernet0/1` (D19). */
export function stpSubject(vlan: number, port?: PortId): string {
  const v = `VLAN${String(vlan).padStart(4, '0')}`;
  return port === undefined ? v : `${v} ${port}`;
}

/** The request `clear spanning-tree detected-protocols [interface <if>]` sends (the `ext.` slot of §2.4). */
export interface StpClearDetectedProtocolsRequest {
  readonly kind: typeof STP_CLEAR_DETECTED_PROTOCOLS_REQUEST;
  readonly port?: PortId;
}

/** True for the ports the daemon may run on: bridged, Ethernet, not a controller tunnel. */
const STP_EXCLUDED_ROLES: readonly PortRole[] = ['wlan-tunnel'];
/** Member states that hide a physical port behind its bundle. */
const HIDDEN_MEMBER_STATES: readonly EtherchannelRow['state'][] = ['bundled', 'waiting', 'suspended'];
/** Reserved VLANs 1002–1005 exist but run no spanning tree. */
const isReservedVlan = (vlan: number): boolean => vlan >= 1002 && vlan <= 1005;

/** Information a port holds from the last accepted BPDU. */
interface StoredInfo {
  vector: PriorityVector;
  messageAge: number;
  maxAge: number;
  hello: number;
  forwardDelay: number;
  version: number;
  receivedAt: SimTime;
}

/** One port of one instance. */
interface StpPort {
  readonly port: PortId;
  portId: number;
  cost: number;
  role: StpRole;
  state: StpState;
  protocol: StpPortProtocol;
  edge: boolean;
  bpduGuard: boolean;
  rootGuard: boolean;
  p2p: boolean;
  /** How the port carries the VLAN: tagged (trunk or voice VLAN) or untagged (access, native). */
  tagged: boolean;
  /** The port is operationally a trunk (BPDUs carry the pvid TLV). */
  trunk: boolean;
  nativeVlan: number;
  info: StoredInfo | undefined;
  designated: PriorityVector;
  inconsistent: StpInconsistency | undefined;
  stateSince: SimTime;
  nextTransitionAt: SimTime | undefined;
  fwdArmed: boolean;
  ageArmed: boolean;
  proposing: boolean;
  /**
   * 802.1D-2004 §17.29.3 `agree`: a root port that already accepted a proposal for its stored vector answers a repeated
   * proposal with the agreement only (ROOT_AGREED) instead of synchronising the designated ports again (ROOT_PROPOSED).
   * Cleared when the stored vector changes, the role leaves root, the information ages out or the protocol changes.
   */
  agreed: boolean;
  tcWhileUntil: SimTime | undefined;
  tcAck: boolean;
  migrateUntil: SimTime | undefined;
  /** When the last TC-flagged BPDU arrived on the port: 802.1w propagation acts on a flag that is new after a quiet tcWhile. */
  lastTcAt: SimTime | undefined;
  /** When the port last replied to an inferior BPDU (802.1D hold time). */
  lastReplyAt: SimTime | undefined;
  /** When the last mismatching untagged BPDU arrived on the port (the pvid inconsistency lifts max age later). */
  pvidMismatchAt: SimTime | undefined;
}

/** One spanning-tree instance (one VLAN). */
interface Instance {
  readonly vlan: number;
  readonly mode: StpMode;
  bridgeId: BridgeId;
  rootId: BridgeId;
  rootPathCost: number;
  rootPort: PortId | undefined;
  helloU: number;
  maxAgeU: number;
  fwdDelayU: number;
  readonly ports: Map<PortId, StpPort>;
  topologyChanges: number;
  lastChangeAt: SimTime | undefined;
  lastChangePort: PortId | undefined;
  tcnPending: boolean;
  tcWindowUntil: SimTime | undefined;
  tcFlagIn: boolean;
  tcActive: boolean;
  tcFlushed: boolean;
}

/** The per-call world of the daemon: tables and parsed configuration. */
interface World {
  readonly global: StpGlobalLines;
  readonly exists: VlanExistsFn;
  readonly switchports: ReadonlyMap<PortId, SwitchportConfig>;
  readonly stpLines: ReadonlyMap<PortId, StpPortLines>;
  readonly dtp: { get(key: string): DtpRow | undefined } | undefined;
  readonly etherchannel: { get(key: string): EtherchannelRow | undefined; find(pred: (r: EtherchannelRow) => boolean): EtherchannelRow[] } | undefined;
}

/** The port whose link state just changed and the state to trust for it (`onLinkChange`). */
interface LinkOverride {
  readonly port: PortId;
  readonly up: boolean;
}

/** Facts of one eligible bridge port, computed once per reconcile. */
interface EligiblePort {
  readonly view: PortView;
  readonly l2: L2PortView;
  readonly lines: StpPortLines;
  readonly speedBps: number | undefined;
  readonly p2p: boolean;
}

/** Bounded ring of DebugEvents, newest last. */
class DebugRing {
  private readonly buf: DebugEvent[] = [];
  private start = 0;

  constructor(private readonly capacity: number) {}

  push(ev: DebugEvent): void {
    if (this.buf.length < this.capacity) {
      this.buf.push(ev);
      return;
    }
    this.buf[this.start] = ev;
    this.start = (this.start + 1) % this.capacity;
  }

  toArray(): DebugEvent[] {
    if (this.buf.length < this.capacity) return this.buf.slice();
    const out = new Array<DebugEvent>(this.buf.length);
    for (let i = 0; i < this.buf.length; i++) out[i] = this.buf[(this.start + i) % this.capacity]!;
    return out;
  }
}

/** Effective role of a port. */
function roleOf(ctx: ProcessCtx, view: PortView): PortRole {
  return view.role ?? view.spec.role ?? defaultRoleFor(view.spec.kind, ctx.model.capabilities ?? []);
}

/** Effective encapsulation of a port. */
function encapOf(view: PortView): PortEncap {
  return view.encap ?? view.spec.encap ?? KIND_ENCAP[view.spec.kind];
}

/** The base MAC of the device (`portMac(base, 0)`): a virtual port carries it; else the first port's MAC with ordinal 0. */
function bridgeMacOf(ctx: ProcessCtx): MacAddress {
  let first: PortView | undefined;
  for (const view of ctx.ports.values()) {
    if (view.ordinal === 0) return view.mac;
    if (first === undefined) first = view;
  }
  if (first === undefined) throw new Error('stp: the device has no ports');
  return `${first.mac.slice(0, 15)}00`;
}

/** The vector a bridge port advertises (§3.6): the instance root, root cost, this bridge, this port. */
function designatedVectorOf(inst: Pick<Instance, 'rootId' | 'rootPathCost' | 'bridgeId'>, portId: number): PriorityVector {
  return { rootId: inst.rootId, rootPathCost: inst.rootPathCost, designatedBridgeId: inst.bridgeId, designatedPortId: portId };
}

function samePortRow(a: StpPortRow, b: StpPortRow): boolean {
  return a.role === b.role && a.state === b.state && a.protocol === b.protocol && a.cost === b.cost && a.portId === b.portId
    && a.designatedBridge === b.designatedBridge && a.designatedPort === b.designatedPort && a.edge === b.edge
    && a.inconsistent === b.inconsistent && a.bpduGuard === b.bpduGuard && a.stateSince === b.stateSince
    && a.nextTransitionAt === b.nextTransitionAt;
}

function sameBridgeRow(a: StpBridgeRow, b: StpBridgeRow): boolean {
  return a.mode === b.mode && a.bridgeId === b.bridgeId && a.rootId === b.rootId && a.isRoot === b.isRoot && a.rootPort === b.rootPort
    && a.rootCost === b.rootCost && a.helloS === b.helloS && a.maxAgeS === b.maxAgeS && a.forwardDelayS === b.forwardDelayS
    && a.topologyChanges === b.topologyChanges && a.lastChangeAt === b.lastChangeAt && a.lastChangePort === b.lastChangePort;
}

class StpDaemon implements Process {
  readonly name = STP_PROCESS;

  private readonly ring = new DebugRing(STP_DEBUG_RING);
  private readonly instances = new Map<number, Instance>();
  private mode: StpMode | undefined;
  private bridgeMac: MacAddress | undefined;
  private started = false;
  private capLogged = false;
  private sent = 0;
  private received = 0;
  /** Ports that received a BPDU and so lost their PortFast (edge) status until they go down. */
  private readonly lostEdge = new Set<PortId>();
  /** Ports whose `errdisable:<port>` recovery timer (BPDU guard) is armed. */
  private readonly recoveryArmed = new Set<PortId>();

  // ═══════════════════════════════════════ Process hooks ═══════════════════════════════════════

  init(ctx: ProcessCtx): Action[] {
    this.started = true;
    this.bridgeMac = bridgeMacOf(ctx);
    return this.reconcile(ctx, CAUSE_PORT_UP);
  }

  onPdu(ctx: ProcessCtx, pdu: Pdu, port: PortId): Action[] {
    if (!this.started) return [{ type: 'drop', pdu, reason: 'other', detail: 'spanning tree is not running', port }];
    return this.receive(ctx, pdu, port);
  }

  onTimer(ctx: ProcessCtx, key: string): Action[] {
    if (!this.started) return [];
    const out: Action[] = [];
    const sep = key.indexOf(':');
    if (sep < 0) return out;
    const kind = key.slice(0, sep);
    const rest = key.slice(sep + 1);
    if (kind === 'errdisable') return this.onRecoveryTimer(ctx, rest);
    const sep2 = rest.indexOf(':');
    const vlan = Number(sep2 < 0 ? rest : rest.slice(0, sep2));
    const port = sep2 < 0 ? undefined : rest.slice(sep2 + 1);
    const inst = this.instances.get(vlan);
    if (inst === undefined) return out;
    switch (kind) {
      case 'hello':
        this.onHello(ctx, inst, out);
        out.push({ type: 'timer', key: helloTimerKey(vlan), delay: stpUnitsToNs(inst.helloU), periodic: true });
        break;
      case 'tcn':
        if (!inst.tcnPending) break;
        this.sendTcn(ctx, inst, out);
        out.push({ type: 'timer', key: tcnTimerKey(vlan), delay: stpUnitsToNs(inst.helloU), periodic: true });
        break;
      case 'tc':
        inst.tcWindowUntil = undefined;
        inst.tcActive = false;
        inst.tcFlushed = false;
        this.emit(ctx, `VLAN ${vlan}: topology-change window ended`, { vlan });
        break;
      case 'fwd': {
        const p = port === undefined ? undefined : inst.ports.get(port);
        if (p !== undefined) this.onForwardDelay(ctx, inst, p, out);
        break;
      }
      case 'age': {
        const p = port === undefined ? undefined : inst.ports.get(port);
        if (p !== undefined) this.onInfoAged(ctx, inst, p, out);
        break;
      }
      case 'tcwhile': {
        const p = port === undefined ? undefined : inst.ports.get(port);
        if (p !== undefined) p.tcWhileUntil = undefined;
        // the change period of a rapid bridge ends with its last tcWhile
        if (![...inst.ports.values()].some((q) => q.tcWhileUntil !== undefined && ctx.now < q.tcWhileUntil)) inst.tcActive = false;
        break;
      }
      case 'migrate': {
        const p = port === undefined ? undefined : inst.ports.get(port);
        if (p !== undefined) p.migrateUntil = undefined;
        break;
      }
      default:
        break;
    }
    return out;
  }

  onConfig(ctx: ProcessCtx, delta: ConfigDelta): Action[] {
    if (!this.started) return [];
    if (delta.context.length === 0 && delta.line[0] === 'errdisable' && delta.line[1] === 'recovery') {
      return [...this.syncRecoveryTimers(ctx), ...this.reconcile(ctx, 'configuration changed')];
    }
    if (!isStpRelevantDelta(delta)) return [];
    return this.reconcile(ctx, 'configuration changed');
  }

  onLinkChange(ctx: ProcessCtx, port: PortId, up: boolean): Action[] {
    if (!this.started) return [];
    if (!up) this.lostEdge.delete(port);
    // During a role-change bounce the port view may lag: trust `up` for this port (contracts/process.ts).
    return this.reconcile(ctx, up ? CAUSE_PORT_UP : CAUSE_PORT_DOWN, { port, up });
  }

  onEvent(ctx: ProcessCtx, ev: ProcessEvent): Action[] {
    if (!this.started || ev.kind !== 'l2.changed') return [];
    return this.reconcile(ctx, `${ev.what} changed`);
  }

  onRequest(ctx: ProcessCtx, req: ProcessRequest): Action[] {
    if (!this.started || req.kind !== STP_CLEAR_DETECTED_PROTOCOLS_REQUEST) return [];
    const wanted = (req as unknown as StpClearDetectedProtocolsRequest).port;
    const out: Action[] = [];
    for (const inst of this.sortedInstances()) {
      if (inst.mode !== 'rapid-pvst') continue;
      for (const p of inst.ports.values()) {
        if (wanted !== undefined && p.port !== wanted) continue;
        p.migrateUntil = ctx.now + STP_MIGRATE_DELAY_NS;
        out.push({ type: 'timer', key: migrateTimerKey(inst.vlan, p.port), delay: STP_MIGRATE_DELAY_NS });
        if (p.protocol !== 'rstp') this.setProtocol(ctx, inst, p, 'rstp', CAUSE_MIGRATION_CLEARED);
        else this.emit(ctx, `${stpSubject(inst.vlan, p.port)}: migrate delay restarted`, { vlan: inst.vlan, port: p.port });
      }
    }
    return out;
  }

  stateSnapshot(): StateView {
    const instances = this.sortedInstances().map((i) => ({
      vlan: i.vlan,
      root: i.rootId.mac === i.bridgeId.mac && i.rootId.priority === i.bridgeId.priority,
      rootPort: i.rootPort ?? null,
      ports: i.ports.size,
    }));
    return { process: STP_PROCESS, state: { mode: this.mode ?? null, instances, sent: this.sent, received: this.received } };
  }

  debugEvents(): readonly DebugEvent[] {
    return this.ring.toArray();
  }

  // ═══════════════════════════════════════ world and reconcile ═══════════════════════════════════════

  private sortedInstances(): Instance[] {
    return [...this.instances.values()].sort((a, b) => a.vlan - b.vlan);
  }

  private world(ctx: ProcessCtx): World {
    return {
      global: readStpGlobalLines(ctx.config),
      exists: vlanExistsIn(ctx.tables.get<VlanRow>('vlans')),
      switchports: readAllSwitchports(ctx.config, ctx.model),
      stpLines: readAllStpPortLines(ctx.config),
      dtp: ctx.tables.get<DtpRow>('dtp'),
      etherchannel: ctx.tables.get<EtherchannelRow>('etherchannel'),
    };
  }

  /** The membership view of a logical port. */
  private l2View(ctx: ProcessCtx, w: World, view: PortView): L2PortView {
    const config = w.switchports.get(view.id) ?? readSwitchport(ctx.config, view.id, ctx.model);
    const role = roleOf(ctx, view);
    if (role === 'channel') {
      const members = w.etherchannel?.find((r) => r.bundle === view.id && r.state === 'bundled') ?? [];
      return { port: view.id, config, oper: channelOperOf(config, members.map((m) => w.dtp?.get(m.port))), role };
    }
    return { port: view.id, config, oper: operOf(config, w.dtp?.get(view.id)), role };
  }

  /** Every port the daemon may run on right now, in canonical port order (`override` = the port whose link just changed). */
  private eligiblePorts(ctx: ProcessCtx, w: World, override?: LinkOverride): EligiblePort[] {
    const out: EligiblePort[] = [];
    for (const view of ctx.ports.values()) {
      const up = override !== undefined && override.port === view.id ? override.up : view.operUp;
      if (!up) continue;
      const role = roleOf(ctx, view);
      if (!ROLE_TRAITS[role].bridged || STP_EXCLUDED_ROLES.includes(role) || encapOf(view) !== 'ethernet') continue;
      const member = w.etherchannel?.get(view.id);
      if (member !== undefined && HIDDEN_MEMBER_STATES.includes(member.state)) continue;
      const l2 = this.l2View(ctx, w, view);
      const lines = w.stpLines.get(view.id) ?? DEFAULT_STP_PORT_LINES;
      let speedBps = view.speedBps;
      let p2p = isPointToPoint(view.duplex);
      if (role === 'channel') {
        const speeds: number[] = [];
        for (const m of w.etherchannel?.find((r) => r.bundle === view.id && r.state === 'bundled') ?? []) {
          const mv = ctx.ports.get(m.port);
          if (mv !== undefined && mv.operUp && mv.speedBps !== undefined) speeds.push(mv.speedBps);
        }
        speedBps = speeds.length === 0 ? undefined : speeds.reduce((a, b) => a + b, 0);
        p2p = true;
      }
      out.push({ view, l2, lines, speedBps, p2p });
    }
    return out;
  }

  /** The VLANs that may run an instance: 1 and every `vlans` row, ascending, minus the reserved and the disabled ones. */
  private candidateVlans(ctx: ProcessCtx, w: World): number[] {
    const set = new Set<number>([1]);
    for (const row of ctx.tables.get<VlanRow>('vlans')?.rows() ?? []) set.add(row.vlan);
    return [...set].filter((v) => !isReservedVlan(v) && !w.global.disabled.has(v)).sort((a, b) => a - b);
  }

  /** Reconcile the instance set and every port's parameters with the config, the tables and the port states. */
  private reconcile(ctx: ProcessCtx, cause: string, override?: LinkOverride): Action[] {
    const out: Action[] = [];
    const w = this.world(ctx);
    const mode = w.global.mode;
    if (mode === undefined || (this.mode !== undefined && this.mode !== mode)) {
      this.teardownAll(ctx, out);
      this.mode = mode;
      if (mode === undefined) return out;
    }
    this.mode = mode;
    const mac = this.bridgeMac ?? bridgeMacOf(ctx);
    this.bridgeMac = mac;
    const eligible = this.eligiblePorts(ctx, w, override);
    const wantedAll = this.candidateVlans(ctx, w).filter((v) => eligible.some((e) => carries(e.l2, v, w.exists) !== undefined));
    let wanted = wantedAll;
    if (wantedAll.length > STP_MAX_INSTANCES) {
      wanted = wantedAll.slice(0, STP_MAX_INSTANCES);
      if (!this.capLogged) {
        this.capLogged = true;
        out.push({ type: 'log', severity: 4, facility: STP_LOG_FACILITY, message: instanceCapMessage(STP_MAX_INSTANCES, wantedAll[STP_MAX_INSTANCES]!) });
      }
    }
    for (const inst of this.sortedInstances()) {
      if (!wanted.includes(inst.vlan)) this.destroyInstance(ctx, inst, out);
    }
    for (const vlan of wanted) {
      let inst = this.instances.get(vlan);
      const priority = w.global.priorities.get(vlan) ?? STP_DEFAULT_BRIDGE_PRIORITY;
      const bridgeId = bridgeIdOf(priority, vlan, mac);
      const created = inst === undefined;
      if (inst === undefined) {
        inst = this.createInstance(vlan, mode, bridgeId, out);
      } else if (inst.bridgeId.priority !== bridgeId.priority) {
        inst.bridgeId = bridgeId;
        this.emit(ctx, `VLAN ${vlan}: bridge priority is now ${bridgeId.priority}`, { vlan, priority: bridgeId.priority });
      }
      const joined = this.syncPorts(ctx, w, inst, eligible, out, cause);
      this.updateRoles(ctx, inst, out, cause);
      // Ports that just joined (or the whole instance that was just created) advertise at once.
      for (const p of joined) if (p.role === 'designated') this.sendBpdu(ctx, inst, p, out);
      if (created) this.emit(ctx, `VLAN ${vlan}: spanning tree started (${mode}), bridge ${bridgeIdText(bridgeId)}`, { vlan, mode, bridgeId: bridgeIdText(bridgeId) });
      this.writeBridgeRow(ctx, inst);
    }
    return out;
  }

  private createInstance(vlan: number, mode: StpMode, bridgeId: BridgeId, out: Action[]): Instance {
    const inst: Instance = {
      vlan,
      mode,
      bridgeId,
      rootId: bridgeId,
      rootPathCost: 0,
      rootPort: undefined,
      helloU: secondsToStpUnits(STP_DEFAULT_TIMERS.helloS),
      maxAgeU: secondsToStpUnits(STP_DEFAULT_TIMERS.maxAgeS),
      fwdDelayU: secondsToStpUnits(STP_DEFAULT_TIMERS.forwardDelayS),
      ports: new Map(),
      topologyChanges: 0,
      lastChangeAt: undefined,
      lastChangePort: undefined,
      tcnPending: false,
      tcWindowUntil: undefined,
      tcFlagIn: false,
      tcActive: false,
      tcFlushed: false,
    };
    this.instances.set(vlan, inst);
    out.push({ type: 'timer', key: helloTimerKey(vlan), delay: stpUnitsToNs(inst.helloU), periodic: true });
    return inst;
  }

  private destroyInstance(ctx: ProcessCtx, inst: Instance, out: Action[]): void {
    for (const p of [...inst.ports.values()]) this.removePort(ctx, inst, p, out, 'spanning tree stopped', false);
    out.push({ type: 'cancelTimer', key: helloTimerKey(inst.vlan) });
    out.push({ type: 'cancelTimer', key: tcnTimerKey(inst.vlan) });
    out.push({ type: 'cancelTimer', key: tcTimerKey(inst.vlan) });
    ctx.tables.get<StpBridgeRow>('stp-bridge')?.delete(vlanKey(inst.vlan), 'cleared');
    this.instances.delete(inst.vlan);
    this.emit(ctx, `VLAN ${inst.vlan}: spanning tree stopped`, { vlan: inst.vlan });
  }

  private teardownAll(ctx: ProcessCtx, out: Action[]): void {
    for (const inst of this.sortedInstances()) this.destroyInstance(ctx, inst, out);
    for (const port of [...this.recoveryArmed]) {
      this.recoveryArmed.delete(port);
      out.push({ type: 'cancelTimer', key: errdisableTimerKey(port) });
    }
  }

  /** Add joining ports, drop leaving ones and refresh every port's parameters; returns the ports that joined. */
  private syncPorts(ctx: ProcessCtx, w: World, inst: Instance, eligible: readonly EligiblePort[], out: Action[], cause: string): StpPort[] {
    const joined: StpPort[] = [];
    const present = new Set<PortId>();
    for (const e of eligible) {
      const carry = carries(e.l2, inst.vlan, w.exists);
      if (carry === undefined) continue;
      present.add(e.view.id);
      const trunk = e.l2.oper === 'trunk';
      const edgeConfigured = isEdgePort(w.global, e.lines, trunk);
      const edge = edgeConfigured && !this.lostEdge.has(e.view.id);
      const bpduGuard = isBpduGuardOn(w.global, e.lines, edgeConfigured);
      const rootGuard = isRootGuardOn(e.lines);
      const computed = e.l2.role === 'channel' ? (channelPathCost(e.speedBps === undefined ? [] : [e.speedBps]) ?? portPathCost(undefined)) : portPathCost(e.speedBps);
      const cost = effectivePathCost(computed, { port: e.lines.cost, vlan: e.lines.vlanCost.get(inst.vlan) });
      const portId = portIdValue(e.lines.vlanPortPriority.get(inst.vlan) ?? e.lines.portPriority ?? STP_DEFAULT_PORT_PRIORITY, stpPortNumber(e.view.id, e.view.ordinal));
      let p = inst.ports.get(e.view.id);
      if (p === undefined) {
        p = this.addPort(ctx, inst, e.view.id, { portId, cost, edge, bpduGuard, rootGuard, p2p: e.p2p, tagged: carry === 'tagged', trunk, nativeVlan: e.l2.config.nativeVlan }, out);
        joined.push(p);
        continue;
      }
      if (p.cost !== cost) {
        this.emit(ctx, `${stpSubject(inst.vlan, p.port)}: path cost ${p.cost} -> ${cost}`, { vlan: inst.vlan, port: p.port, from: p.cost, to: cost });
        p.cost = cost;
      }
      p.portId = portId;
      p.bpduGuard = bpduGuard;
      p.rootGuard = rootGuard;
      p.p2p = e.p2p;
      p.tagged = carry === 'tagged';
      p.trunk = trunk;
      p.nativeVlan = e.l2.config.nativeVlan;
      if (p.edge !== edge) {
        p.edge = edge;
        this.emit(ctx, `${stpSubject(inst.vlan, p.port)}: ${edge ? 'is now an edge port' : 'is no longer an edge port'}`, { vlan: inst.vlan, port: p.port, edge });
        if (edge && isActiveRole(p.role) && p.inconsistent === undefined && p.state !== 'forwarding') {
          this.setState(ctx, inst, p, 'forwarding', CAUSE_EDGE_PORT, out);
        }
      }
      this.writePortRow(ctx, inst, p);
    }
    for (const p of [...inst.ports.values()]) {
      if (!present.has(p.port)) this.removePort(ctx, inst, p, out, cause, true);
    }
    return joined;
  }

  private addPort(
    ctx: ProcessCtx,
    inst: Instance,
    port: PortId,
    params: Pick<StpPort, 'portId' | 'cost' | 'edge' | 'bpduGuard' | 'rootGuard' | 'p2p' | 'tagged' | 'trunk' | 'nativeVlan'>,
    out: Action[],
  ): StpPort {
    const rapid = inst.mode === 'rapid-pvst';
    const p: StpPort = {
      port,
      ...params,
      role: 'designated',
      state: 'disabled',
      protocol: rapid ? 'rstp' : 'stp',
      info: undefined,
      designated: designatedVectorOf(inst, params.portId),
      inconsistent: undefined,
      stateSince: ctx.now,
      nextTransitionAt: undefined,
      fwdArmed: false,
      ageArmed: false,
      proposing: false,
      agreed: false,
      tcWhileUntil: undefined,
      tcAck: false,
      migrateUntil: undefined,
      lastTcAt: undefined,
      lastReplyAt: undefined,
      pvidMismatchAt: undefined,
    };
    inst.ports.set(port, p);
    if (rapid) {
      p.migrateUntil = ctx.now + STP_MIGRATE_DELAY_NS;
      out.push({ type: 'timer', key: migrateTimerKey(inst.vlan, port), delay: STP_MIGRATE_DELAY_NS });
    }
    this.transition(ctx, inst, p.port, 'disabled', p.edge ? 'forwarding' : rapid ? RSTP_ENTRY_STATE : PVST_ENTRY_STATE, p.edge ? CAUSE_EDGE_PORT : CAUSE_PORT_UP);
    if (p.edge) {
      p.state = 'forwarding';
      this.writePortRow(ctx, inst, p);
      out.push({ type: 'l2Changed', what: 'stp', port, vlan: inst.vlan });
    } else {
      p.state = rapid ? RSTP_ENTRY_STATE : PVST_ENTRY_STATE;
      this.armFwd(ctx, inst, p, out);
      if (rapid && p.p2p) p.proposing = true;
      this.writePortRow(ctx, inst, p);
    }
    return p;
  }

  /** The port leaves the instance: timers cancelled, row deleted, TC detected when it was forwarding or learning (802.1D). */
  private removePort(ctx: ProcessCtx, inst: Instance, p: StpPort, out: Action[], cause: string, detectTc: boolean): void {
    if (p.fwdArmed) out.push({ type: 'cancelTimer', key: fwdTimerKey(inst.vlan, p.port) });
    if (p.ageArmed) out.push({ type: 'cancelTimer', key: ageTimerKey(inst.vlan, p.port) });
    if (p.tcWhileUntil !== undefined) out.push({ type: 'cancelTimer', key: tcWhileTimerKey(inst.vlan, p.port) });
    if (p.migrateUntil !== undefined) out.push({ type: 'cancelTimer', key: migrateTimerKey(inst.vlan, p.port) });
    const wasForwarding = p.state === 'forwarding';
    const leaving = detectsTcOnLeaving(p.state) && !p.edge;
    this.transition(ctx, inst, p.port, p.state, 'disabled', cause);
    inst.ports.delete(p.port);
    ctx.tables.get<StpPortRow>('stp')?.delete(stpKey(inst.vlan, p.port), 'cleared');
    if (wasForwarding) out.push({ type: 'l2Changed', what: 'stp', port: p.port, vlan: inst.vlan });
    if (inst.rootPort === p.port) inst.rootPort = undefined;
    if (detectTc && leaving && inst.mode === 'pvst') {
      this.updateRoles(ctx, inst, out, cause);
      this.detectTcLegacy(ctx, inst, p.port, out);
    }
  }

  // ═══════════════════════════════════════ roles and states ═══════════════════════════════════════

  /** Ports of the instance in canonical (device port) order. */
  private orderedPorts(ctx: ProcessCtx, inst: Instance): StpPort[] {
    const out: StpPort[] = [];
    for (const id of ctx.ports.keys()) {
      const p = inst.ports.get(id);
      if (p !== undefined) out.push(p);
    }
    return out;
  }

  /** 802.1D-2004 §17.21.25: elect the root, pick the root port, assign every port its role, then apply the states. */
  private updateRoles(ctx: ProcessCtx, inst: Instance, out: Action[], cause: string, pdu?: PduId): void {
    const ports = this.orderedPorts(ctx, inst);
    const own: PriorityVector = { rootId: inst.bridgeId, rootPathCost: 0, designatedBridgeId: inst.bridgeId, designatedPortId: 0 };
    let best = own;
    let bestPort: StpPort | undefined;
    for (const p of ports) {
      const info = p.info;
      if (info === undefined || p.inconsistent !== undefined || info.vector.designatedBridgeId.mac === inst.bridgeId.mac) continue;
      const rootPath: PriorityVector = {
        rootId: info.vector.rootId,
        rootPathCost: info.vector.rootPathCost + p.cost,
        designatedBridgeId: info.vector.designatedBridgeId,
        designatedPortId: info.vector.designatedPortId,
        receivingPortId: p.portId,
      };
      if (isBetterVector(rootPath, best)) {
        best = rootPath;
        bestPort = p;
      }
    }
    const oldRoot = bridgeIdText(inst.rootId);
    const oldRootCost = inst.rootPathCost;
    const oldRootPort = inst.rootPort;
    inst.rootId = best.rootId;
    inst.rootPathCost = best.rootPathCost;
    inst.rootPort = bestPort?.port;
    if (bestPort?.info !== undefined) {
      inst.helloU = bestPort.info.hello;
      inst.maxAgeU = bestPort.info.maxAge;
      inst.fwdDelayU = bestPort.info.forwardDelay;
    } else {
      inst.helloU = secondsToStpUnits(STP_DEFAULT_TIMERS.helloS);
      inst.maxAgeU = secondsToStpUnits(STP_DEFAULT_TIMERS.maxAgeS);
      inst.fwdDelayU = secondsToStpUnits(STP_DEFAULT_TIMERS.forwardDelayS);
    }
    const newRoot = bridgeIdText(inst.rootId);
    const infoChanged = newRoot !== oldRoot || inst.rootPathCost !== oldRootCost;
    if (newRoot !== oldRoot) {
      const isRoot = bestPort === undefined;
      this.bridgeTransition(ctx, inst, oldRoot, newRoot, isRoot ? 'this switch is the root' : cause, pdu);
      if (isRoot) {
        inst.tcnPending = false;
        out.push({ type: 'cancelTimer', key: tcnTimerKey(inst.vlan) });
      }
    } else if (inst.rootPort !== oldRootPort) {
      this.emit(ctx, `VLAN ${inst.vlan}: root port is now ${inst.rootPort ?? 'none'}`, { vlan: inst.vlan, rootPort: inst.rootPort ?? null });
    }

    // roles
    const changed: StpPort[] = [];
    for (const p of ports) {
      p.designated = designatedVectorOf(inst, p.portId);
      let role: StpRole;
      if (p === bestPort) role = 'root';
      else if (p.info === undefined) role = 'designated';
      else if (isBetterVector(p.designated, p.info.vector)) role = 'designated';
      else role = p.info.vector.designatedBridgeId.mac === inst.bridgeId.mac ? 'backup' : 'alternate';
      if (role !== p.role) {
        this.transition(ctx, inst, p.port, p.role, role, cause, pdu, 'role');
        p.role = role;
        changed.push(p);
      }
      if (role !== 'root') p.agreed = false;
    }

    // states: pass 1 blocks every port that is neither root nor designated (or inconsistent)
    const rapid = inst.mode === 'rapid-pvst';
    const blocked = rapid ? RSTP_BLOCKED_STATE : PVST_BLOCKED_STATE;
    for (const p of ports) {
      if (isActiveRole(p.role) && p.inconsistent === undefined) continue;
      p.proposing = false;
      if (p.state !== blocked) this.setState(ctx, inst, p, blocked, p.inconsistent !== undefined ? `${p.inconsistent} inconsistency` : CAUSE_ROLE_CHANGED, out, pdu);
      else if (p.fwdArmed) this.cancelFwd(inst, p, out);
    }
    // pass 2 activates root and designated ports
    for (const p of ports) {
      if (!isActiveRole(p.role) || p.inconsistent !== undefined) continue;
      if (p.edge) {
        if (p.state !== 'forwarding') this.setState(ctx, inst, p, 'forwarding', CAUSE_EDGE_PORT, out, pdu);
        continue;
      }
      if (!rapid || p.protocol === 'stp') {
        if (p.state === blocked || p.state === 'disabled') this.setState(ctx, inst, p, rapid ? RSTP_ENTRY_STATE : PVST_ENTRY_STATE, cause, out, pdu, true);
        else if (p.state !== 'forwarding' && !p.fwdArmed) this.armFwd(ctx, inst, p, out);
        continue;
      }
      if (p.role === 'root') {
        // 802.1w: a new root port forwards at once once the previous root port stopped forwarding (it is discarding
        // as alternate by pass 1, or gone); a proposal on it was answered by `receive` (sync + agreement).
        if (p.state !== 'forwarding') this.setState(ctx, inst, p, 'forwarding', CAUSE_REROOT, out, pdu);
        p.proposing = false;
        continue;
      }
      // designated, 802.1w: propose on a point-to-point link, fall back to the forward-delay timers otherwise (§3.6)
      if (p.state === 'forwarding') continue;
      if (!p.fwdArmed) this.armFwd(ctx, inst, p, out);
      if (p.p2p && !p.proposing) {
        p.proposing = true;
        this.sendBpdu(ctx, inst, p, out);
      }
    }
    for (const p of changed) this.writePortRow(ctx, inst, p);
    this.writeBridgeRow(ctx, inst);
    // New designated information is advertised at once: on every designated port of a rapid bridge (802.1w
    // `newInfo`), and by a bridge that just became the root of an 802.1D instance.
    if (infoChanged) {
      for (const p of ports) {
        if (p.role !== 'designated' || p.inconsistent !== undefined) continue;
        if (rapid || bestPort === undefined) this.sendBpdu(ctx, inst, p, out);
      }
    }
  }

  private armFwd(ctx: ProcessCtx, inst: Instance, p: StpPort, out: Action[]): void {
    const delay = stpUnitsToNs(inst.fwdDelayU);
    p.fwdArmed = true;
    p.nextTransitionAt = ctx.now + delay;
    out.push({ type: 'timer', key: fwdTimerKey(inst.vlan, p.port), delay });
  }

  private cancelFwd(inst: Instance, p: StpPort, out: Action[]): void {
    if (p.fwdArmed) out.push({ type: 'cancelTimer', key: fwdTimerKey(inst.vlan, p.port) });
    p.fwdArmed = false;
    p.nextTransitionAt = undefined;
  }

  /**
   * Move a port to `to`: timers, the transition event, the row, `l2Changed` on a change to or from forwarding, and the
   * topology-change rules of the instance's protocol. `armFwd` arms the forward-delay timer for a non-terminal state.
   */
  private setState(ctx: ProcessCtx, inst: Instance, p: StpPort, to: StpState, cause: string, out: Action[], pdu?: PduId, armFwd?: boolean): void {
    const from = p.state;
    if (from === to) return;
    this.transition(ctx, inst, p.port, from, to, cause, pdu);
    p.state = to;
    p.stateSince = ctx.now;
    const progressing = to === 'listening' || to === 'learning' || (to === 'discarding' && armFwd === true);
    if (progressing) this.armFwd(ctx, inst, p, out);
    else this.cancelFwd(inst, p, out);
    if (to === 'forwarding') p.proposing = false;
    this.writePortRow(ctx, inst, p);
    if (from === 'forwarding' || to === 'forwarding') out.push({ type: 'l2Changed', what: 'stp', port: p.port, vlan: inst.vlan });
    if (p.edge) return;
    if (inst.mode === 'pvst') {
      if (to === 'forwarding' && this.hasDesignatedPort(inst)) this.detectTcLegacy(ctx, inst, p.port, out);
      else if (detectsTcOnLeaving(from) && to === PVST_BLOCKED_STATE) this.detectTcLegacy(ctx, inst, p.port, out);
    } else if (to === 'forwarding') {
      this.originateTcRapid(ctx, inst, p, out);
    }
  }

  private hasDesignatedPort(inst: Instance): boolean {
    for (const p of inst.ports.values()) if (p.role === 'designated') return true;
    return false;
  }

  /** `fwd:<vlan>:<port>` fired: the next state of an active port. */
  private onForwardDelay(ctx: ProcessCtx, inst: Instance, p: StpPort, out: Action[]): void {
    p.fwdArmed = false;
    p.nextTransitionAt = undefined;
    if (!isActiveRole(p.role) || p.inconsistent !== undefined) return;
    const next = inst.mode === 'pvst' ? pvstNextState(p.state) : rstpNextState(p.state);
    if (next === undefined) return;
    this.setState(ctx, inst, p, next, CAUSE_FORWARD_DELAY_EXPIRED, out, undefined, next !== 'forwarding');
  }

  /** `age:<vlan>:<port>` fired: the stored information is gone; inconsistencies it caused clear. */
  private onInfoAged(ctx: ProcessCtx, inst: Instance, p: StpPort, out: Action[]): void {
    p.ageArmed = false;
    if (p.info === undefined) return;
    p.info = undefined;
    p.agreed = false;
    p.lastTcAt = undefined;
    this.emit(ctx, `${stpSubject(inst.vlan, p.port)}: stored information aged out`, { vlan: inst.vlan, port: p.port });
    if (p.inconsistent === 'pvid') this.clearPvidOnPort(ctx, p.port, out);
    else this.clearInconsistency(ctx, inst, p, out);
    this.updateRoles(ctx, inst, out, CAUSE_INFORMATION_AGED);
    if (inst.rootPort === undefined && !this.isRoot(inst)) this.updateRoles(ctx, inst, out, CAUSE_INFORMATION_AGED);
  }

  private isRoot(inst: Instance): boolean {
    return inst.rootPort === undefined;
  }

  // ═══════════════════════════════════════ BPDU transmit ═══════════════════════════════════════

  private bpduLayers(ctx: ProcessCtx, inst: Instance, p: StpPort, stp: Record<string, number | string>): LayerSpec[] {
    const layers: LayerSpec[] = [];
    const eth: Record<string, string | number> = { dst: STP_GROUP_MAC, src: ctx.macOf(p.port) };
    if (!p.tagged) eth.type = 0;
    layers.push({ proto: 'ethernet', fields: eth });
    if (p.tagged) layers.push({ proto: 'dot1q', fields: { vid: inst.vlan } });
    layers.push({ proto: 'llc', fields: { dsap: LLC_SAP_STP, ssap: LLC_SAP_STP, control: 3 } });
    const fields: Record<string, number | string> = { ...stp };
    if (p.trunk || p.tagged) fields.pvid = inst.vlan;
    layers.push({ proto: 'stp', fields });
    return layers;
  }

  /** The configuration / RST BPDU of a port: the instance's root information, this bridge and port, flags per protocol. */
  private sendBpdu(ctx: ProcessCtx, inst: Instance, p: StpPort, out: Action[], opts: { agreement?: boolean } = {}): void {
    if (!ctx.ports.has(p.port)) return;
    const rootInfo = inst.rootPort === undefined ? undefined : inst.ports.get(inst.rootPort)?.info;
    const messageAge = rootInfo === undefined ? 0 : relayedMessageAge(rootInfo.messageAge);
    const rapidPort = inst.mode === 'rapid-pvst' && p.protocol === 'rstp';
    let flags: number;
    if (rapidPort) {
      const tc = p.tcWhileUntil !== undefined && ctx.now < p.tcWhileUntil;
      const proposal = p.proposing && p.role === 'designated' && p.state !== 'forwarding' && p.p2p;
      flags = rstFlags(p.role, p.state, { tc, proposal, agreement: opts.agreement === true });
    } else {
      const tc = inst.mode === 'pvst'
        ? (this.isRoot(inst) ? inst.tcWindowUntil !== undefined : inst.tcFlagIn)
        : p.tcWhileUntil !== undefined && ctx.now < p.tcWhileUntil;
      flags = configBpduFlags(tc, p.tcAck);
      p.tcAck = false;
    }
    const pdu = ctx.newPdu(
      this.bpduLayers(ctx, inst, p, {
        version: rapidPort ? STP_VERSION_RSTP : STP_VERSION_STP,
        bpduType: rapidPort ? STP_BPDU_RST : STP_BPDU_CONFIG,
        flags,
        rootPriority: inst.rootId.priority,
        rootMac: inst.rootId.mac,
        rootPathCost: inst.rootPathCost,
        bridgePriority: inst.bridgeId.priority,
        bridgeMac: inst.bridgeId.mac,
        portId: p.portId,
        messageAge,
        maxAge: inst.maxAgeU,
        helloTime: inst.helloU,
        forwardDelay: inst.fwdDelayU,
      }),
      { tag: STP_BPDU_TAG, background: true },
    );
    this.sent++;
    out.push({ type: 'send', port: p.port, pdu });
  }

  /** A TCN BPDU out the root port (802.1D). */
  private sendTcn(ctx: ProcessCtx, inst: Instance, out: Action[]): void {
    const rp = inst.rootPort === undefined ? undefined : inst.ports.get(inst.rootPort);
    if (rp === undefined || !ctx.ports.has(rp.port)) return;
    const pdu = ctx.newPdu(this.bpduLayers(ctx, inst, rp, { version: STP_VERSION_STP, bpduType: STP_BPDU_TCN }), { tag: STP_BPDU_TAG, background: true });
    this.sent++;
    out.push({ type: 'send', port: rp.port, pdu });
    this.emit(ctx, `VLAN ${inst.vlan}: topology change notification sent on ${rp.port}`, { vlan: inst.vlan, port: rp.port, pdu: pdu.id });
  }

  /** Configuration BPDUs on every designated port (the root's hello, a non-root bridge's relay). */
  private transmitDesignated(ctx: ProcessCtx, inst: Instance, out: Action[]): void {
    for (const p of this.orderedPorts(ctx, inst)) if (p.role === 'designated') this.sendBpdu(ctx, inst, p, out);
  }

  /** `hello:<vlan>` fired. */
  private onHello(ctx: ProcessCtx, inst: Instance, out: Action[]): void {
    if (inst.mode === 'pvst') {
      if (this.isRoot(inst)) this.transmitDesignated(ctx, inst, out);
      return;
    }
    for (const p of this.orderedPorts(ctx, inst)) {
      if (p.role === 'designated') this.sendBpdu(ctx, inst, p, out);
      else if (p.role === 'root' && p.protocol === 'rstp' && p.tcWhileUntil !== undefined && ctx.now < p.tcWhileUntil) this.sendBpdu(ctx, inst, p, out);
    }
  }

  // ═══════════════════════════════════════ BPDU receive ═══════════════════════════════════════

  private receive(ctx: ProcessCtx, pdu: Pdu, port: PortId): Action[] {
    const stp = pdu.layer('stp');
    if (stp === undefined) return [{ type: 'drop', pdu, reason: 'unsupported-protocol', detail: 'not a spanning-tree BPDU', port }];
    const view = ctx.ports.get(port);
    if (view === undefined) return [{ type: 'drop', pdu, reason: 'other', detail: `unknown port ${port}`, port }];
    const w = this.world(ctx);
    const l2 = this.l2View(ctx, w, view);
    const tag = frameVlanTag(pdu);
    const cl = classify(l2, tag, w.exists);
    if (!cl.ok) return [{ type: 'drop', pdu, reason: cl.reason, detail: cl.detail, port }];
    const vlan = cl.vlan;
    const inst = this.instances.get(vlan);
    const p = inst?.ports.get(port);
    if (inst === undefined || p === undefined) {
      return [{ type: 'drop', pdu, reason: 'other', detail: `no spanning tree for VLAN ${vlan} on ${port}`, port }];
    }
    this.received++;
    const out: Action[] = [];
    const f = stp.fields;
    const version = Number(f.version ?? 0);
    const bpduType = Number(f.bpduType ?? STP_BPDU_CONFIG);
    const tagged = tag !== undefined && tag !== 0;
    const pvid = typeof f.pvid === 'number' ? f.pvid : undefined;

    // BPDU guard (§3.6 Guards)
    if (p.bpduGuard) {
      out.push({ type: 'log', severity: 2, facility: STP_LOG_FACILITY, message: bpduGuardMessage(port, vlan) });
      out.push({ type: 'errDisable', port, cause: 'bpduguard', detail: bpduGuardDetail(port) });
      out.push(...this.recoveryFor(ctx, port, true));
      out.push({ type: 'consume', pdu });
      return out;
    }
    // an edge port that hears a BPDU loses its edge status until it goes down
    if (p.edge && !this.lostEdge.has(port)) {
      this.lostEdge.add(port);
      for (const other of this.instances.values()) {
        const q = other.ports.get(port);
        if (q !== undefined && q.edge) {
          q.edge = false;
          this.emit(ctx, `${stpSubject(other.vlan, port)}: BPDU received, no longer an edge port`, { vlan: other.vlan, port, pdu: pdu.id });
          this.writePortRow(ctx, other, q);
        }
      }
    }
    // a legacy bridge discards RST BPDUs (§3.6 Mixed modes)
    if (inst.mode === 'pvst' && legacyBridgeDiscards(version, bpduType)) {
      out.push({ type: 'drop', pdu, reason: 'unsupported-protocol', detail: 'RST BPDU ignored: this switch runs 802.1D spanning tree', port });
      return out;
    }
    if (bpduType === STP_BPDU_TCN) {
      this.receiveTcn(ctx, inst, p, pdu, out);
      out.push({ type: 'consume', pdu });
      return out;
    }
    // port protocol migration (rapid bridges)
    if (inst.mode === 'rapid-pvst') {
      const next = migrationDecision(p.protocol, bpduProtocolOf(version, bpduType), p.migrateUntil !== undefined && ctx.now < p.migrateUntil);
      if (next !== p.protocol) this.setProtocol(ctx, inst, p, next, next === 'stp' ? CAUSE_MIGRATED_TO_STP : CAUSE_MIGRATED_TO_RSTP, pdu.id);
    }
    // type and pvid checks (§3.2 step 6, §3.6 Guards)
    if (!p.trunk) {
      if (facesTrunk(tagged, pvid)) this.setInconsistency(ctx, inst, p, 'type', out, typeInconsistentMessage(port, vlan));
      else if (p.inconsistent === 'type' && pvid === undefined) this.clearInconsistency(ctx, inst, p, out); // the trunk BPDUs stopped
    } else {
      const mm = nativeVlanMismatch(tagged, pvid, p.nativeVlan);
      if (mm !== undefined && pvid !== undefined) {
        const message = nativeMismatchMessage(port, p.nativeVlan, pvid, mm);
        p.pvidMismatchAt = ctx.now;
        const logged = this.setInconsistency(ctx, inst, p, 'pvid', out, message, 2);
        const other = this.instances.get(pvid)?.ports.get(port);
        if (other !== undefined) {
          other.pvidMismatchAt = ctx.now;
          this.setInconsistency(ctx, this.instances.get(pvid)!, other, 'pvid', out, logged ? undefined : message, 2);
        }
      } else if (!tagged && pvid === p.nativeVlan) {
        // a matching untagged BPDU: the mismatch is over for every VLAN it blocked on this port
        this.clearPvidOnPort(ctx, port, out);
      } else if (p.inconsistent === 'pvid' && p.pvidMismatchAt !== undefined && ctx.now - p.pvidMismatchAt >= stpUnitsToNs(inst.maxAgeU)) {
        // no mismatching BPDU for max age: the information that caused the block has aged out
        this.clearPvidOnPort(ctx, port, out);
      }
    }
    const messageAge = Number(f.messageAge ?? 0);
    const maxAge = Number(f.maxAge ?? inst.maxAgeU);
    if (messageAge >= maxAge) {
      out.push({ type: 'drop', pdu, reason: 'other', detail: 'BPDU message age reached max age', port });
      return out;
    }
    const msg: PriorityVector = {
      rootId: { priority: Number(f.rootPriority ?? 0), mac: String(f.rootMac ?? '') },
      rootPathCost: Number(f.rootPathCost ?? 0),
      designatedBridgeId: { priority: Number(f.bridgePriority ?? 0), mac: String(f.bridgeMac ?? '') },
      designatedPortId: Number(f.portId ?? 0),
      receivingPortId: p.portId,
    };
    const flags = decodeRstFlags(Number(f.flags ?? 0));
    const stpPort = inst.mode === 'pvst' || p.protocol === 'stp';
    const held = p.role === 'designated' ? p.designated : p.info?.vector;
    const superior = stpPort ? pvstSupersedes(msg, held) : isSuperiorMessage(msg, held);

    // root guard: a message that would displace this port's own information; the guard lifts when they stop
    if (p.rootGuard && isBetterVector(msg, p.designated)) {
      this.storeInfo(ctx, inst, p, msg, f, version, out);
      this.setInconsistency(ctx, inst, p, 'root', out, rootGuardMessage(port, vlan));
      out.push({ type: 'consume', pdu });
      return out;
    }
    if (p.inconsistent === 'root') this.clearInconsistency(ctx, inst, p, out);

    if (superior || p.inconsistent !== undefined) {
      const wasRootPort = p.role === 'root';
      this.storeInfo(ctx, inst, p, msg, f, version, out);
      this.updateRoles(ctx, inst, out, CAUSE_SUPERIOR_BPDU, pdu.id);
      if (p.role === 'root' && p.inconsistent === undefined) {
        if (stpPort) {
          // 802.1D: relay on the designated ports; TC-ack stops the TCN; the TC flag is relayed and flushes once
          if (flags.tcAck && inst.tcnPending) {
            inst.tcnPending = false;
            out.push({ type: 'cancelTimer', key: tcnTimerKey(inst.vlan) });
            this.emit(ctx, `VLAN ${inst.vlan}: topology change acknowledged on ${port}`, { vlan: inst.vlan, port, pdu: pdu.id });
          }
          if (inst.mode === 'pvst') {
            if (flags.tc && !inst.tcFlagIn) this.tcReceivedLegacy(ctx, inst, port, out, pdu.id);
            else if (!flags.tc && inst.tcFlagIn) {
              inst.tcActive = false;
              inst.tcFlushed = false;
            }
            inst.tcFlagIn = flags.tc;
            this.transmitDesignated(ctx, inst, out);
          }
        }
        if (!wasRootPort && stpPort && inst.mode === 'pvst') {
          // the port became root port: nothing more (its state keeps its timer, §3.6 step 3)
        }
      }
    } else if (p.role === 'designated' && isDesignatedSender(version, flags.roleBits) && !flags.agreement) {
      // an inferior BPDU on a designated port: reply with this port's own information, at most once per hold time
      if (p.lastReplyAt === undefined || ctx.now - p.lastReplyAt >= STP_HOLD_TIME_NS) {
        p.lastReplyAt = ctx.now;
        this.sendBpdu(ctx, inst, p, out);
      }
    }

    // 802.1w flags on a rapid port
    if (inst.mode === 'rapid-pvst' && p.protocol === 'rstp' && p.inconsistent === undefined) {
      if (flags.proposal) {
        if (p.role === 'root') {
          // ROOT_PROPOSED synchronises the other ports once per stored vector; a repeated proposal for the same vector
          // is ROOT_AGREED (802.1D-2004 §17.29.3): the agreement is re-sent, nothing is re-synchronised
          if (!p.agreed) this.syncOthers(ctx, inst, p, out, pdu.id);
          if (p.state !== 'forwarding') this.setState(ctx, inst, p, 'forwarding', CAUSE_PROPOSAL_ACCEPTED, out, pdu.id);
          this.sendBpdu(ctx, inst, p, out, { agreement: true });
          p.agreed = true;
        } else if (p.role === 'alternate' || p.role === 'backup') {
          this.sendBpdu(ctx, inst, p, out, { agreement: true });
        }
      }
      if (p.role === 'designated' && p.state !== 'forwarding' && isAgreementFor(flags, msg.rootId.mac === inst.rootId.mac && msg.rootId.priority === inst.rootId.priority)) {
        p.proposing = false;
        this.setState(ctx, inst, p, 'forwarding', CAUSE_AGREEMENT_RECEIVED, out, pdu.id);
      }
      if (flags.tc && this.isNewTc(ctx, inst, p)) this.tcReceivedRapid(ctx, inst, p, out, pdu.id);
      p.lastTcAt = flags.tc ? ctx.now : undefined;
    } else if (inst.mode === 'rapid-pvst' && p.protocol === 'stp' && p.inconsistent === undefined) {
      // a migrated port of a rapid bridge: the 802.1D TC flag propagates the 802.1w way
      if (flags.tc && p.role === 'root' && this.isNewTc(ctx, inst, p)) this.tcReceivedRapid(ctx, inst, p, out, pdu.id);
      p.lastTcAt = flags.tc ? ctx.now : undefined;
    }
    out.push({ type: 'consume', pdu });
    return out;
  }

  private storeInfo(ctx: ProcessCtx, inst: Instance, p: StpPort, msg: PriorityVector, f: Readonly<Record<string, unknown>>, version: number, out: Action[]): void {
    const hello = Number(f.helloTime ?? inst.helloU);
    const maxAge = Number(f.maxAge ?? inst.maxAgeU);
    const messageAge = Number(f.messageAge ?? 0);
    if (p.info === undefined || comparePriorityVectors(msg, p.info.vector) !== 0) p.agreed = false;
    p.info = {
      vector: msg,
      messageAge,
      maxAge,
      hello,
      forwardDelay: Number(f.forwardDelay ?? inst.fwdDelayU),
      version,
      receivedAt: ctx.now,
    };
    const delay = inst.mode === 'pvst' || p.protocol === 'stp' ? pvstAgeTimerNs(maxAge, messageAge) : rstpAgeTimerNs(hello);
    p.ageArmed = true;
    out.push({ type: 'timer', key: ageTimerKey(inst.vlan, p.port), delay, periodic: true });
  }

  private setProtocol(ctx: ProcessCtx, inst: Instance, p: StpPort, protocol: StpPortProtocol, cause: string, pdu?: PduId): void {
    const from = p.protocol;
    p.protocol = protocol;
    p.proposing = false;
    p.agreed = false;
    this.transition(ctx, inst, p.port, from, protocol, cause, pdu, 'protocol');
    this.writePortRow(ctx, inst, p);
  }

  /** Mark a port inconsistent (blocked until the information ages out). Returns true when the log line was emitted now. */
  private setInconsistency(ctx: ProcessCtx, inst: Instance, p: StpPort, kind: StpInconsistency, out: Action[], message: string | undefined, severity: 2 | 4 = 4): boolean {
    if (p.inconsistent === kind) return false;
    p.inconsistent = kind;
    const blocked = inst.mode === 'pvst' ? PVST_BLOCKED_STATE : RSTP_BLOCKED_STATE;
    if (message !== undefined) out.push({ type: 'log', severity, facility: STP_LOG_FACILITY, message });
    if (p.state !== blocked) this.setState(ctx, inst, p, blocked, `${kind} inconsistency`, out);
    p.proposing = false;
    p.agreed = false;
    this.writePortRow(ctx, inst, p);
    this.updateRoles(ctx, inst, out, `${kind} inconsistency`);
    return message !== undefined;
  }

  /** Clear the pvid inconsistency of every instance port on `port` (one mismatch blocks two VLANs, §3.2 step 6). */
  private clearPvidOnPort(ctx: ProcessCtx, port: PortId, out: Action[]): void {
    for (const other of this.sortedInstances()) {
      const q = other.ports.get(port);
      if (q !== undefined && q.inconsistent === 'pvid') this.clearInconsistency(ctx, other, q, out);
    }
  }

  private clearInconsistency(ctx: ProcessCtx, inst: Instance, p: StpPort, out: Action[]): void {
    const kind = p.inconsistent;
    if (kind === undefined) return;
    p.inconsistent = undefined;
    p.pvidMismatchAt = undefined;
    const message = kind === 'pvid'
      ? nativeMismatchClearedMessage(p.port, inst.vlan)
      : kind === 'type'
        ? typeInconsistentClearedMessage(p.port, inst.vlan)
        : rootGuardClearedMessage(p.port, inst.vlan);
    out.push({ type: 'log', severity: 5, facility: STP_LOG_FACILITY, message });
    this.writePortRow(ctx, inst, p);
    this.updateRoles(ctx, inst, out, `${kind} inconsistency cleared`);
  }

  /** 802.1w sync: every other non-edge designated port that forwards or learns goes discarding and proposes again. */
  private syncOthers(ctx: ProcessCtx, inst: Instance, except: StpPort, out: Action[], pdu: PduId): void {
    for (const q of this.orderedPorts(ctx, inst)) {
      if (q === except || q.role !== 'designated' || q.edge || q.inconsistent !== undefined) continue;
      if (q.state !== 'forwarding' && q.state !== 'learning') continue;
      this.setState(ctx, inst, q, RSTP_ENTRY_STATE, CAUSE_SYNC, out, pdu, true);
      if (q.p2p && q.protocol === 'rstp') {
        q.proposing = true;
        this.sendBpdu(ctx, inst, q, out);
      }
    }
  }

  // ═══════════════════════════════════════ topology change ═══════════════════════════════════════

  private noteTopologyChange(ctx: ProcessCtx, inst: Instance, port: PortId): void {
    if (!inst.tcActive) {
      inst.topologyChanges++;
      inst.lastChangeAt = ctx.now;
      inst.lastChangePort = port;
    }
    inst.tcActive = true;
    this.writeBridgeRow(ctx, inst);
  }

  /** 802.1D detection on this bridge (§3.6 step 5): the root opens its TC window, a non-root bridge notifies its root. */
  private detectTcLegacy(ctx: ProcessCtx, inst: Instance, port: PortId, out: Action[]): void {
    this.emit(ctx, `VLAN ${inst.vlan}: topology change detected on ${port}`, { vlan: inst.vlan, port });
    this.noteTopologyChange(ctx, inst, port);
    if (this.isRoot(inst)) {
      this.startTcWindow(ctx, inst, out);
      return;
    }
    if (inst.rootPort === undefined) return;
    inst.tcnPending = true;
    this.sendTcn(ctx, inst, out);
    out.push({ type: 'timer', key: tcnTimerKey(inst.vlan), delay: stpUnitsToNs(inst.helloU), periodic: true });
  }

  /** The root's TC window (max age + forward delay): TC in every BPDU, one fast-age flush. */
  private startTcWindow(ctx: ProcessCtx, inst: Instance, out: Action[]): void {
    const delay = pvstTcWindowNs(inst.maxAgeU, inst.fwdDelayU);
    inst.tcWindowUntil = ctx.now + delay;
    out.push({ type: 'timer', key: tcTimerKey(inst.vlan), delay });
    if (!inst.tcFlushed) {
      inst.tcFlushed = true;
      this.fastAge(ctx, inst, out);
    }
    this.transmitDesignated(ctx, inst, out);
  }

  /** A TCN arrived on a port (802.1D): acknowledge on a designated port, then notify upward or open the window. */
  private receiveTcn(ctx: ProcessCtx, inst: Instance, p: StpPort, pdu: Pdu, out: Action[]): void {
    this.emit(ctx, `VLAN ${inst.vlan}: topology change notification received on ${p.port}`, { vlan: inst.vlan, port: p.port, pdu: pdu.id });
    if (p.role !== 'designated') return;
    if (inst.mode === 'rapid-pvst') {
      if (p.protocol === 'stp') {
        p.tcAck = true;
        this.sendBpdu(ctx, inst, p, out);
      }
      this.tcReceivedRapid(ctx, inst, p, out, pdu.id);
      return;
    }
    p.tcAck = true;
    this.noteTopologyChange(ctx, inst, p.port);
    if (this.isRoot(inst)) {
      // the window opens first, so the acknowledgement already carries the TC flag
      this.startTcWindow(ctx, inst, out);
      return;
    }
    this.sendBpdu(ctx, inst, p, out);
    if (inst.tcnPending) return;
    inst.tcnPending = true;
    this.sendTcn(ctx, inst, out);
    out.push({ type: 'timer', key: tcnTimerKey(inst.vlan), delay: stpUnitsToNs(inst.helloU), periodic: true });
  }

  /** A configuration BPDU with TC arrived on the root port of an 802.1D bridge: fast-age once per TC period. */
  private tcReceivedLegacy(ctx: ProcessCtx, inst: Instance, port: PortId, out: Action[], pdu: PduId): void {
    this.emit(ctx, `VLAN ${inst.vlan}: topology change flag received on ${port}`, { vlan: inst.vlan, port, pdu });
    this.noteTopologyChange(ctx, inst, port);
    if (inst.tcFlushed) return;
    inst.tcFlushed = true;
    this.fastAge(ctx, inst, out);
  }

  private fastAge(ctx: ProcessCtx, inst: Instance, out: Action[]): void {
    const ports = this.orderedPorts(ctx, inst).map((p) => p.port);
    const ev: L2FlushEvent = { kind: 'l2.flush', vlan: inst.vlan, mode: 'fast-age', ports, ageingNs: stpUnitsToNs(inst.fwdDelayU) };
    out.push({ type: 'event', to: 'eth-switch', ev });
    this.emit(ctx, `VLAN ${inst.vlan}: fast ageing on ${ports.length} port(s)`, { vlan: inst.vlan, ports });
  }

  /** 802.1w: `tcWhile` on every non-edge root and designated port but `except`; TC BPDUs on them; flush on `flushPorts`. */
  private propagateTcRapid(ctx: ProcessCtx, inst: Instance, except: StpPort | undefined, out: Action[]): PortId[] {
    const flagged: PortId[] = [];
    for (const q of this.orderedPorts(ctx, inst)) {
      if (q === except || q.edge || !isActiveRole(q.role) || q.inconsistent !== undefined) continue;
      flagged.push(q.port);
      if (q.tcWhileUntil !== undefined && ctx.now < q.tcWhileUntil) continue;
      const delay = tcWhileNs(inst.helloU);
      q.tcWhileUntil = ctx.now + delay;
      out.push({ type: 'timer', key: tcWhileTimerKey(inst.vlan, q.port), delay });
      if (q.protocol === 'rstp') this.sendBpdu(ctx, inst, q, out);
      else if (q.role === 'root') {
        inst.tcnPending = true;
        this.sendTcn(ctx, inst, out);
        out.push({ type: 'timer', key: tcnTimerKey(inst.vlan), delay: stpUnitsToNs(inst.helloU), periodic: true });
      } else this.sendBpdu(ctx, inst, q, out);
    }
    return flagged;
  }

  private flushRapid(ctx: ProcessCtx, inst: Instance, ports: readonly PortId[], out: Action[]): void {
    if (ports.length === 0) return;
    const ev: L2FlushEvent = { kind: 'l2.flush', vlan: inst.vlan, mode: 'flush', ports };
    out.push({ type: 'event', to: 'eth-switch', ev });
    this.emit(ctx, `VLAN ${inst.vlan}: flushing dynamic addresses on ${ports.join(', ')}`, { vlan: inst.vlan, ports });
  }

  /** A TC flag is a new change when no TC-flagged BPDU arrived on the port within the last tcWhile (2 × hello). */
  private isNewTc(ctx: ProcessCtx, inst: Instance, p: StpPort): boolean {
    return p.lastTcAt === undefined || ctx.now - p.lastTcAt >= tcWhileNs(inst.helloU);
  }

  /** A non-edge port entered forwarding on a rapid bridge (§3.6 Rapid step 7, originator). */
  private originateTcRapid(ctx: ProcessCtx, inst: Instance, p: StpPort, out: Action[]): void {
    this.emit(ctx, `VLAN ${inst.vlan}: topology change on ${p.port} (entered forwarding)`, { vlan: inst.vlan, port: p.port });
    this.noteTopologyChange(ctx, inst, p.port);
    const flagged = this.propagateTcRapid(ctx, inst, undefined, out);
    this.flushRapid(ctx, inst, flagged.filter((q) => q !== p.port), out);
  }

  /** A TC arrived on port `p` of a rapid bridge (§3.6 Rapid step 7, receiver). */
  private tcReceivedRapid(ctx: ProcessCtx, inst: Instance, p: StpPort, out: Action[], pdu: PduId): void {
    this.emit(ctx, `VLAN ${inst.vlan}: ${CAUSE_TC_RECEIVED} on ${p.port}`, { vlan: inst.vlan, port: p.port, pdu });
    this.noteTopologyChange(ctx, inst, p.port);
    const flagged = this.propagateTcRapid(ctx, inst, p, out);
    this.flushRapid(ctx, inst, flagged, out);
  }

  // ═══════════════════════════════════════ BPDU-guard recovery ═══════════════════════════════════════

  private recoveryFor(ctx: ProcessCtx, port: PortId, wanted: boolean): Action[] {
    const rec = errdisableRecovery(ctx.config, 'bpduguard');
    const armed = this.recoveryArmed.has(port);
    if (wanted && rec.enabled) {
      this.recoveryArmed.add(port);
      this.emit(ctx, `${port} recovers from err-disable in ${rec.intervalNs / SEC} s`, { port, intervalNs: rec.intervalNs });
      return [{ type: 'timer', key: errdisableTimerKey(port), delay: rec.intervalNs, periodic: true }];
    }
    if (armed) {
      this.recoveryArmed.delete(port);
      return [{ type: 'cancelTimer', key: errdisableTimerKey(port) }];
    }
    return [];
  }

  private syncRecoveryTimers(ctx: ProcessCtx): Action[] {
    const rec = errdisableRecovery(ctx.config, 'bpduguard');
    const actions: Action[] = [];
    for (const view of ctx.ports.values()) {
      const disabled = view.errDisabled === 'bpduguard';
      if (disabled && rec.enabled && !this.recoveryArmed.has(view.id)) actions.push(...this.recoveryFor(ctx, view.id, true));
      else if ((!disabled || !rec.enabled) && this.recoveryArmed.has(view.id)) actions.push(...this.recoveryFor(ctx, view.id, false));
    }
    return actions;
  }

  private onRecoveryTimer(ctx: ProcessCtx, port: PortId): Action[] {
    this.recoveryArmed.delete(port);
    const view = ctx.ports.get(port);
    if (view === undefined || view.errDisabled !== 'bpduguard') return [];
    this.emit(ctx, `recovering ${port} from err-disable`, { port });
    return [{ type: 'errRecover', port, cause: 'bpduguard' }];
  }

  // ═══════════════════════════════════════ rows, transitions, debug ═══════════════════════════════════════

  private writePortRow(ctx: ProcessCtx, inst: Instance, p: StpPort): void {
    const table = ctx.tables.get<StpPortRow>('stp');
    if (table === undefined) return;
    const info = p.info;
    const ownDesignated = p.role === 'designated' || info === undefined;
    const dp = ownDesignated ? portIdParts(p.portId) : portIdParts(info!.vector.designatedPortId);
    const row: StpPortRow = {
      key: stpKey(inst.vlan, p.port),
      vlan: inst.vlan,
      port: p.port,
      role: p.role,
      state: p.state,
      protocol: p.protocol,
      cost: p.cost,
      portId: portIdText(portIdParts(p.portId).priority, portIdParts(p.portId).number),
      designatedBridge: ownDesignated ? bridgeIdText(inst.bridgeId) : bridgeIdText(info!.vector.designatedBridgeId),
      designatedPort: portIdText(dp.priority, dp.number),
      edge: p.edge,
      stateSince: p.stateSince,
      updatedAt: ctx.now,
    };
    if (p.inconsistent !== undefined) row.inconsistent = p.inconsistent;
    if (p.bpduGuard) row.bpduGuard = true;
    if (p.nextTransitionAt !== undefined) row.nextTransitionAt = p.nextTransitionAt;
    const prev = table.get(row.key);
    if (prev !== undefined && samePortRow(prev, row)) return;
    table.set(row);
  }

  private writeBridgeRow(ctx: ProcessCtx, inst: Instance): void {
    const table = ctx.tables.get<StpBridgeRow>('stp-bridge');
    if (table === undefined) return;
    const row: StpBridgeRow = {
      key: vlanKey(inst.vlan),
      vlan: inst.vlan,
      mode: inst.mode,
      bridgeId: bridgeIdText(inst.bridgeId),
      rootId: bridgeIdText(inst.rootId),
      isRoot: this.isRoot(inst),
      rootCost: inst.rootPathCost,
      helloS: inst.helloU / 256,
      maxAgeS: inst.maxAgeU / 256,
      forwardDelayS: inst.fwdDelayU / 256,
      topologyChanges: inst.topologyChanges,
      updatedAt: ctx.now,
    };
    if (inst.rootPort !== undefined) row.rootPort = inst.rootPort;
    if (inst.lastChangeAt !== undefined) row.lastChangeAt = inst.lastChangeAt;
    if (inst.lastChangePort !== undefined) row.lastChangePort = inst.lastChangePort;
    const prev = table.get(row.key);
    if (prev !== undefined && sameBridgeRow(prev, row)) return;
    table.set(row);
  }

  private transition(ctx: ProcessCtx, inst: Instance, port: PortId, from: string, to: string, cause: string, pdu?: PduId, what: 'state' | 'role' | 'protocol' = 'state'): void {
    const subject = stpSubject(inst.vlan, port);
    const message = what === 'state' ? `${subject}: ${from} -> ${to} (${cause})` : `${subject}: ${what} ${from} -> ${to} (${cause})`;
    const fsm: FsmTransition = { machine: 'stp-port', subject, port, instance: inst.vlan, from, to, cause, ...(pdu === undefined ? {} : { pdu }) };
    ctx.transition(STP_DEBUG_CATEGORY, message, fsm, { what });
    this.ring.push({ at: ctx.now, device: ctx.deviceId, process: STP_PROCESS, category: STP_DEBUG_CATEGORY, message, data: { what }, fsm });
  }

  private bridgeTransition(ctx: ProcessCtx, inst: Instance, from: string, to: string, cause: string, pdu?: PduId): void {
    const subject = stpSubject(inst.vlan);
    const message = `${subject}: root ${from} -> ${to} (${cause})`;
    const fsm: FsmTransition = { machine: 'stp-bridge', subject, instance: inst.vlan, from, to, cause, ...(pdu === undefined ? {} : { pdu }) };
    ctx.transition(STP_DEBUG_CATEGORY, message, fsm);
    this.ring.push({ at: ctx.now, device: ctx.deviceId, process: STP_PROCESS, category: STP_DEBUG_CATEGORY, message, fsm });
  }

  private emit(ctx: ProcessCtx, message: string, data?: Record<string, unknown>): void {
    ctx.debug(STP_DEBUG_CATEGORY, message, data);
    const ev: DebugEvent = data === undefined
      ? { at: ctx.now, device: ctx.deviceId, process: STP_PROCESS, category: STP_DEBUG_CATEGORY, message }
      : { at: ctx.now, device: ctx.deviceId, process: STP_PROCESS, category: STP_DEBUG_CATEGORY, message, data };
    this.ring.push(ev);
  }
}

/** Create the spanning-tree daemon (`name: 'stp'`, no frame selectors: BPDUs arrive by eth-switch's `deliver`, D7). */
export function createStp(): Process {
  return new StpDaemon();
}
