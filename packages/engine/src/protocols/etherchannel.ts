/**
 * protocols/etherchannel.ts — the EtherChannel daemon (ARCHITECTURE-P2 D6, D7, D10, §2.4, §2.6 EtherchannelRow,
 * §3.0 steps 2–3 and 11, §3.7, §4.2, §4.3, §5.1; §13 #25, #31, #32).
 *
 * It owns the `etherchannel` table (key = member port, one row per `channel-group` line) and the egress of every
 * `Port-channelN` (role `channel`, egress `owner`, D10). The three protocols share one member state machine
 * (`ChannelMemberState`): `down` (link down) → `waiting` (negotiating, no traffic) → `bundled` (forwards through the
 * bundle) | `individual` (no partner: an ordinary switch port of its own, §3.7 step 8) | `suspended` (incompatible
 * with the bundle, no traffic, §3.7 step 9). The pure pieces live beside it: etherchannel/lacp.ts (LACPDUs, timers),
 * etherchannel/pagp.ts [S3] (NF-format PAgP), etherchannel/static.ts (`mode on`, the line reader) and
 * etherchannel/compat.ts (the compatibility check and every row reason).
 *
 * Configuration (read from the running config, never copied into state, D6):
 *   interface <port> / channel-group <n> mode on|active|passive|desirable|auto   → the row of <port> in Port-channel<n>
 *   port-channel load-balance <method>                                            → read at egress (l2/lag-hash.ts)
 * `on` is static (bundled at link-up, ignores every negotiation frame); `active`/`passive` run LACP; `desirable`/`auto`
 * run PAgP. The CLI handler creates `interface Port-channel<n>` (§3.7 step 1); the daemon only reads the lines.
 *
 * Decision per member (`targetOf`), re-run on every input: link down → `down`; static → `bundled` when compatible, else
 * `suspended`; LACP/PAgP with no partner known → `waiting` during the initial burst (active/desirable: 3 messages, one
 * per second) or the 3 s wait (passive/auto), then `individual` (`no LACP partner` / `no PAgP partner`); partner
 * known → `waiting` while an LACP partner has its sync bit clear, `suspended` when the member's configuration differs
 * from the Port-channel's (`configuration differs from Port-channel1 (<first difference>)`), when its negotiated
 * trunking mode differs from the other bundled members' (`trunk negotiation differs from Port-channel1`) or when its
 * partner system or key differs from theirs (`partner differs from the rest of Port-channel1`); else `bundled`.
 * Each state change is one `ctx.transition('etherchannel', …, {machine: 'lacp' | 'pagp' | 'channel', subject:
 * '<bundle> <port>', instance: group, from, to, cause, pdu?})`, one row write, and an `l2Changed {what:'channel',
 * port}` — except for a member whose link went down: the runtime's own link-change path recomputes the bundle's oper
 * state and spanning tree recomputes the cost from the rows, and no CAM row of the bundle is flushed (§3.7 step 7,
 * §13 #31) — and except for a port that merely starts negotiating (`down` → `waiting`).
 *
 * Egress (`onEgress(ctx, pdu, 'Port-channelN')`, §3.7 step 5): the bundled, link-up members in canonical port order,
 * `hash(method, frame) mod n` (`pickLagMember`) → `send` on that member; no member → drop `other`,
 * `Port-channelN has no active member`. Control frames arrive through eth-switch's physical control dispatch (`deliver`
 * on the member port); the daemon declares no `handles`. A frame on a port without a channel group, on a `mode on`
 * member or for the other protocol is dropped `not-for-me`, never bridged.
 *
 * Timers (§4.2): `lacp-fast:<port>` (1 s, ≤ 3, non-periodic), `lacp-wait:<port>` (3 s, non-periodic), `lacp-tx:<port>`
 * (30 s, periodic), `lacp-age:<port>` (90 s, re-armed per LACPDU, periodic flag); the same four with the `pagp-`
 * prefix for PAgP members. No randomness (§4.1); bundled members and flood targets are in canonical port order (§4.5).
 * Silence (§4.3): nothing is sent unless a `channel-group` line names `active` or `desirable` on an up port
 * (`passive`/`auto` answer only, `on` never sends); with no line there is no row, no timer and no debug line.
 *
 * `stateSnapshot()`: `{ process: 'etherchannel', state: { loadBalance, bundles: [{ bundle, group, protocol,
 * members: [{ port, mode, state, reason? }] }] } }` — bundles ascending by group, members in canonical order.
 * Debug category: 'etherchannel' (§5.4).
 */
import type { MacAddress } from '../contracts/addr.js';
import type { ConfigDelta } from '../contracts/config.js';
import type { PduId, PortId } from '../contracts/ids.js';
import type { Pdu } from '../contracts/pdu.js';
import type { Duplex, PortView } from '../contracts/port.js';
import type { Action, DebugEvent, FsmMachine, FsmTransition, Process, ProcessCtx, StateView } from '../contracts/process.js';
import type { ChannelMemberState, DeviceTables, DtpRow, EtherchannelRow } from '../contracts/tables.js';
import type { ProcessEvent } from '../contracts/transport.js';
import { noActiveMemberDetail, pickLagMember, readLoadBalance } from './l2/lag-hash.js';
import { operOf, type L2OperMode } from './l2/membership.js';
import { readSwitchport } from './l2/switchport-config.js';
import { channelPathCost } from './stp/cost.js';
import { NO_LACP_PARTNER, NO_PAGP_PARTNER, compatibility, partnerDiffersReason, type BundleFacts, type MemberFacts } from './etherchannel/compat.js';
import {
  LACP_AGE_NS,
  LACP_FAST_INTERVAL_NS,
  LACP_FAST_TRIES,
  LACP_TAG,
  LACP_TIMER_AGE,
  LACP_TIMER_FAST,
  LACP_TIMER_TX,
  LACP_TIMER_WAIT,
  LACP_TX_INTERVAL_NS,
  LACP_WAIT_NS,
  lacpActorState,
  lacpLayerOf,
  lacpSystemMac,
  lacpTimerKey,
  lacpduLayers,
  parseLacpTimerKey,
  partnerInSync,
  readLacpPartner,
  type LacpPartner,
  type LacpTimerKind,
} from './etherchannel/lacp.js';
import {
  PAGP_AGE_NS,
  PAGP_FAST_INTERVAL_NS,
  PAGP_FAST_TRIES,
  PAGP_TAG,
  PAGP_TIMER_AGE,
  PAGP_TIMER_FAST,
  PAGP_TIMER_TX,
  PAGP_TIMER_WAIT,
  PAGP_TX_INTERVAL_NS,
  PAGP_WAIT_NS,
  pagpLayerOf,
  pagpLayers,
  pagpTimerKey,
  parsePagpTimerKey,
  readPagpPartner,
  type PagpPartner,
  type PagpTimerKind,
} from './etherchannel/pagp.js';
import {
  groupOfBundleName,
  isChannelGroupLine,
  modeInitiates,
  readChannelGroups,
  staticIgnoresDetail,
  staticMemberState,
  type ChannelMode,
  type ChannelProtocol,
} from './etherchannel/static.js';

/** Process name registered by the catalog for managed switches (§2.1 `managed-switch` → etherchannel). */
export const ETHERCHANNEL_PROCESS = 'etherchannel';
/** Debug category (`debug etherchannel`, §5.4). */
export const ETHERCHANNEL_DEBUG_CATEGORY = 'etherchannel';
/** Capacity of the per-process DebugEvent ring. */
export const ETHERCHANNEL_DEBUG_RING = 200;
/** Table the daemon writes (§2.6). */
export const ETHERCHANNEL_TABLE = 'etherchannel';
/** Row reason of an LACP member waiting for a partner whose sync bit is clear. */
export const PARTNER_NOT_READY = 'partner is not ready';
/** Config line keys under an interface section that re-run the compatibility check of a bundle. */
export const COMPAT_LINE_KEYS: readonly string[] = Object.freeze(['switchport', 'speed', 'duplex']);

/** Drop detail of a negotiation frame on a port with no channel group. */
export function noChannelGroupDetail(port: PortId): string {
  return `${port} has no channel group`;
}
/** Drop detail of a frame of the other negotiation protocol. */
export function otherProtocolDetail(port: PortId, runs: 'LACP' | 'PAgP', ignores: 'LACP' | 'PAgP'): string {
  return `${port} runs ${runs} and ignores ${ignores}`;
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

/** One member as the daemon tracks it (the row mirrors `state`, `reason` and the partner identity). */
interface Member {
  readonly port: PortId;
  readonly group: number;
  readonly bundle: PortId;
  readonly mode: ChannelMode;
  readonly protocol: ChannelProtocol;
  linkUp: boolean;
  state: ChannelMemberState;
  reason?: string;
  lacp?: LacpPartner;
  pagp?: PagpPartner;
  /** Messages sent in the initial burst. */
  tries: number;
  /** No partner after the burst / the wait (or after the partner expired): individual until one is heard. */
  gaveUp: boolean;
}

/** A target state with its reason. */
interface Target {
  readonly state: ChannelMemberState;
  readonly reason?: string;
}

/** The partner identity a bundle is keyed on (system and key for LACP, device and group for PAgP). */
interface PartnerId {
  readonly system: MacAddress;
  readonly key: number;
}

/**
 * What a formed bundle runs at: the negotiated trunking mode, speed and duplex its bundled members agreed on. Set when
 * the first member bundles, refreshed only when EVERY bundled member agrees on new values (all members renegotiated
 * together), cleared when no member is bundled - so a single member that drifts is the one suspended, whichever
 * port it is (§3.7 step 9, §13 #32). Derived state, never configuration.
 */
interface BundleRef {
  readonly oper: L2OperMode;
  readonly speedBps?: number;
  readonly duplex?: Duplex;
}

/** True when two references agree. */
function sameRef(a: BundleRef, b: BundleRef): boolean {
  return a.oper === b.oper && a.speedBps === b.speedBps && a.duplex === b.duplex;
}

/** The `etherchannel` rows of bundle `bundle`, in row order. */
export function memberRowsOf(tables: DeviceTables, bundle: PortId): EtherchannelRow[] {
  return tables.get<EtherchannelRow>(ETHERCHANNEL_TABLE)?.find((r) => r.bundle === bundle) ?? [];
}

/** Index of every port in canonical (`ports` Map) order. */
function portIndex(ports: ReadonlyMap<PortId, PortView>): ReadonlyMap<PortId, number> {
  const out = new Map<PortId, number>();
  let i = 0;
  for (const id of ports.keys()) out.set(id, i++);
  return out;
}

/** `ids` in canonical port order (unknown ports last, in the given order). */
function canonical(ids: readonly PortId[], ports: ReadonlyMap<PortId, PortView>): PortId[] {
  const index = portIndex(ports);
  const rank = (p: PortId): number => index.get(p) ?? Number.MAX_SAFE_INTEGER;
  return ids.map((p, i) => ({ p, i })).sort((a, b) => rank(a.p) - rank(b.p) || a.i - b.i).map((e) => e.p);
}

/**
 * The bundled members of `bundle` whose port is oper up, in canonical port order (the member list `onEgress` hashes
 * over and spanning tree costs, D10). Read from the rows, so any consumer (runtime, show handlers, tests) may ask.
 */
export function bundledMembersOf(tables: DeviceTables, ports: ReadonlyMap<PortId, PortView>, bundle: PortId): PortId[] {
  const up = memberRowsOf(tables, bundle).filter((r) => r.state === 'bundled' && ports.get(r.port)?.operUp === true).map((r) => r.port);
  return canonical(up, ports);
}

/** The negotiated speeds of `bundledMembersOf(...)` (unknown speeds left out). */
export function bundledMemberSpeeds(tables: DeviceTables, ports: ReadonlyMap<PortId, PortView>, bundle: PortId): number[] {
  const out: number[] = [];
  for (const p of bundledMembersOf(tables, ports, bundle)) {
    const s = ports.get(p)?.speedBps;
    if (s !== undefined) out.push(s);
  }
  return out;
}

/**
 * The spanning-tree path cost of `bundle` from the aggregate bandwidth of its currently bundled members (§3.6, §3.7
 * step 7: 2 × 1 G → 3, one member lost → 4), undefined when no member is bundled and up.
 */
export function channelCostOf(tables: DeviceTables, ports: ReadonlyMap<PortId, PortView>, bundle: PortId): number | undefined {
  return channelPathCost(bundledMemberSpeeds(tables, ports, bundle));
}

class EtherchannelDaemon implements Process {
  readonly name = ETHERCHANNEL_PROCESS;

  private readonly ring = new DebugRing(ETHERCHANNEL_DEBUG_RING);
  private readonly members = new Map<PortId, Member>();
  /** What each formed bundle runs at, by bundle (see `BundleRef`). */
  private readonly refs = new Map<PortId, BundleRef>();

  init(ctx: ProcessCtx): Action[] {
    return this.reconcile(ctx);
  }

  onPdu(ctx: ProcessCtx, pdu: Pdu, port: PortId): Action[] {
    const isLacp = lacpLayerOf(pdu) !== undefined;
    const isPagp = !isLacp && pagpLayerOf(pdu) !== undefined;
    if (!isLacp && !isPagp) {
      return [{ type: 'drop', pdu, reason: 'unsupported-protocol', detail: `${ETHERCHANNEL_PROCESS} handles LACP and PAgP frames only`, port }];
    }
    const m = this.members.get(port);
    if (m === undefined) return this.dropControl(ctx, pdu, port, 'not-for-me', noChannelGroupDetail(port));
    const heard: 'LACP' | 'PAgP' = isLacp ? 'LACP' : 'PAgP';
    if (m.protocol === 'static') return this.dropControl(ctx, pdu, port, 'not-for-me', staticIgnoresDetail(port, heard));
    if ((m.protocol === 'lacp') !== isLacp) {
      return this.dropControl(ctx, pdu, port, 'not-for-me', otherProtocolDetail(port, m.protocol === 'lacp' ? 'LACP' : 'PAgP', heard));
    }
    const actions: Action[] = [];
    if (isLacp) {
      const partner = readLacpPartner(pdu);
      if (partner === undefined) return this.dropControl(ctx, pdu, port, 'unsupported-protocol', 'malformed LACPDU');
      const first = m.lacp === undefined;
      const moved = m.lacp === undefined || m.lacp.system !== partner.system || m.lacp.key !== partner.key || m.lacp.port !== partner.port;
      m.lacp = partner;
      m.gaveUp = false;
      actions.push({ type: 'timer', key: lacpTimerKey(LACP_TIMER_AGE, port), delay: LACP_AGE_NS, periodic: true });
      if (first) {
        if (modeInitiates(m.mode)) {
          actions.push({ type: 'cancelTimer', key: lacpTimerKey(LACP_TIMER_FAST, port) });
          actions.push({ type: 'timer', key: lacpTimerKey(LACP_TIMER_TX, port), delay: LACP_TX_INTERVAL_NS, periodic: true });
        } else {
          actions.push({ type: 'cancelTimer', key: lacpTimerKey(LACP_TIMER_WAIT, port) });
        }
      }
      this.emit(ctx, `LACPDU on ${port} from ${partner.system} port ${partner.port} key ${partner.key}`, { port, pdu: pdu.id, partner: partner.system, partnerPort: partner.port, partnerKey: partner.key, partnerState: partner.state });
      const r = this.evaluate(ctx, m, 'LACP partner heard', pdu.id);
      if (!r.changed && moved) this.writeRow(ctx, m);
      actions.push(...r.actions);
      if (!modeInitiates(m.mode) && !r.sent) actions.push(this.sendLacp(ctx, m));
    } else {
      const partner = readPagpPartner(pdu);
      if (partner === undefined) return this.dropControl(ctx, pdu, port, 'unsupported-protocol', 'malformed port aggregation message');
      const first = m.pagp === undefined;
      const moved = m.pagp === undefined || m.pagp.device !== partner.device || m.pagp.group !== partner.group || m.pagp.port !== partner.port;
      m.pagp = partner;
      m.gaveUp = false;
      actions.push({ type: 'timer', key: pagpTimerKey(PAGP_TIMER_AGE, port), delay: PAGP_AGE_NS, periodic: true });
      if (first) {
        if (modeInitiates(m.mode)) {
          actions.push({ type: 'cancelTimer', key: pagpTimerKey(PAGP_TIMER_FAST, port) });
          actions.push({ type: 'timer', key: pagpTimerKey(PAGP_TIMER_TX, port), delay: PAGP_TX_INTERVAL_NS, periodic: true });
        } else {
          actions.push({ type: 'cancelTimer', key: pagpTimerKey(PAGP_TIMER_WAIT, port) });
        }
      }
      this.emit(ctx, `PAgP message on ${port} from ${partner.device} port ${partner.port} group ${partner.group}`, { port, pdu: pdu.id, partner: partner.device, partnerPort: partner.port, partnerGroup: partner.group });
      const r = this.evaluate(ctx, m, 'PAgP partner heard', pdu.id);
      if (!r.changed && moved) this.writeRow(ctx, m);
      actions.push(...r.actions);
      if (!modeInitiates(m.mode) && !r.sent) actions.push(this.sendPagp(ctx, m));
    }
    actions.push({ type: 'consume', pdu });
    return actions;
  }

  onTimer(ctx: ProcessCtx, key: string): Action[] {
    const lacp = parseLacpTimerKey(key);
    if (lacp !== undefined) {
      const m = this.members.get(lacp.port);
      if (m === undefined || m.protocol !== 'lacp' || !m.linkUp) return [];
      switch (lacp.kind) {
        case LACP_TIMER_FAST: {
          if (m.tries < LACP_FAST_TRIES) {
            m.tries += 1;
            return [this.sendLacp(ctx, m), { type: 'timer', key, delay: LACP_FAST_INTERVAL_NS }];
          }
          m.gaveUp = true;
          const r = this.evaluate(ctx, m, `no answer after ${LACP_FAST_TRIES} LACPDUs`);
          return [...r.actions, { type: 'timer', key: lacpTimerKey(LACP_TIMER_TX, m.port), delay: LACP_TX_INTERVAL_NS, periodic: true }];
        }
        case LACP_TIMER_WAIT: {
          m.gaveUp = true;
          return this.evaluate(ctx, m, 'no LACPDU heard while waiting').actions;
        }
        case LACP_TIMER_TX: {
          if (!modeInitiates(m.mode)) return [];
          return [this.sendLacp(ctx, m), { type: 'timer', key, delay: LACP_TX_INTERVAL_NS, periodic: true }];
        }
        case LACP_TIMER_AGE: {
          if (m.lacp === undefined) return [];
          this.emit(ctx, `LACP partner of ${m.port} expired`, { port: m.port, partner: m.lacp.system });
          m.lacp = undefined;
          m.gaveUp = true;
          return this.evaluate(ctx, m, 'partner information expired').actions;
        }
      }
    }
    const pagp = parsePagpTimerKey(key);
    if (pagp !== undefined) {
      const m = this.members.get(pagp.port);
      if (m === undefined || m.protocol !== 'pagp' || !m.linkUp) return [];
      switch (pagp.kind) {
        case PAGP_TIMER_FAST: {
          if (m.tries < PAGP_FAST_TRIES) {
            m.tries += 1;
            return [this.sendPagp(ctx, m), { type: 'timer', key, delay: PAGP_FAST_INTERVAL_NS }];
          }
          m.gaveUp = true;
          const r = this.evaluate(ctx, m, `no answer after ${PAGP_FAST_TRIES} messages`);
          return [...r.actions, { type: 'timer', key: pagpTimerKey(PAGP_TIMER_TX, m.port), delay: PAGP_TX_INTERVAL_NS, periodic: true }];
        }
        case PAGP_TIMER_WAIT: {
          m.gaveUp = true;
          return this.evaluate(ctx, m, 'no PAgP message heard while waiting').actions;
        }
        case PAGP_TIMER_TX: {
          if (!modeInitiates(m.mode)) return [];
          return [this.sendPagp(ctx, m), { type: 'timer', key, delay: PAGP_TX_INTERVAL_NS, periodic: true }];
        }
        case PAGP_TIMER_AGE: {
          if (m.pagp === undefined) return [];
          this.emit(ctx, `PAgP partner of ${m.port} expired`, { port: m.port, partner: m.pagp.device });
          m.pagp = undefined;
          m.gaveUp = true;
          return this.evaluate(ctx, m, 'partner information expired').actions;
        }
      }
    }
    return [];
  }

  onConfig(ctx: ProcessCtx, delta: ConfigDelta): Action[] {
    const iface = delta.context.length === 1 && delta.context[0]?.[0] === 'interface' ? delta.context[0]?.[1] : undefined;
    if (iface === undefined) return [];
    if (isChannelGroupLine(delta.line)) return this.reconcile(ctx);
    const key = delta.line[0];
    if (key === undefined || !COMPAT_LINE_KEYS.includes(key)) return [];
    const bundle = groupOfBundleName(iface) !== undefined ? iface : this.members.get(iface)?.bundle;
    if (bundle === undefined) return [];
    return this.evaluateBundle(ctx, bundle, 'configuration changed');
  }

  onLinkChange(ctx: ProcessCtx, port: PortId, up: boolean): Action[] {
    const m = this.members.get(port);
    if (m === undefined || m.linkUp === up) return [];
    return up ? this.start(ctx, m, 'link up') : this.stop(ctx, m, 'link down');
  }

  onEvent(ctx: ProcessCtx, ev: ProcessEvent): Action[] {
    if (ev.kind !== 'l2.changed' || ev.what !== 'trunk') return [];
    if (ev.port === undefined) {
      const out: Action[] = [];
      for (const bundle of this.bundles()) out.push(...this.evaluateBundle(ctx, bundle, 'trunk negotiation changed'));
      return out;
    }
    const m = this.members.get(ev.port);
    if (m === undefined) return [];
    return this.evaluateBundle(ctx, m.bundle, 'trunk negotiation changed');
  }

  /** §3.7 step 5: a frame another daemon sends on a Port-channel leaves on one bundled member. */
  onEgress(ctx: ProcessCtx, pdu: Pdu, port: PortId): Action[] {
    const members = this.bundledUp(ctx, port);
    const method = readLoadBalance(ctx.config);
    const pick = pickLagMember(method, pdu, members);
    if (pick === undefined) {
      const detail = noActiveMemberDetail(port);
      this.emit(ctx, `dropped pdu ${pdu.id} for ${port}: ${detail}`, { port, pdu: pdu.id });
      return [{ type: 'drop', pdu, reason: 'other', detail, port }];
    }
    this.emit(ctx, `pdu ${pdu.id} for ${port} leaves on ${pick} (${method})`, { port, pdu: pdu.id, member: pick, method });
    return [{ type: 'send', port: pick, pdu }];
  }

  stateSnapshot(): StateView {
    const groups = new Map<number, Member[]>();
    for (const m of this.members.values()) {
      const list = groups.get(m.group);
      if (list === undefined) groups.set(m.group, [m]);
      else list.push(m);
    }
    const bundles = [...groups.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([group, list]) => ({
        bundle: list[0]!.bundle,
        group,
        protocol: list[0]!.protocol,
        members: list.map((m) => (m.reason === undefined ? { port: m.port, mode: m.mode, state: m.state } : { port: m.port, mode: m.mode, state: m.state, reason: m.reason })),
      }));
    return { process: ETHERCHANNEL_PROCESS, state: { loadBalance: this.lastLoadBalance, bundles } };
  }

  debugEvents(): readonly DebugEvent[] {
    return this.ring.toArray();
  }

  // ── members and rows ─────────────────────────────────────────────────────

  private lastLoadBalance = 'src-mac';

  /** Every bundle with at least one member, ascending by group. */
  private bundles(): PortId[] {
    const byGroup = new Map<number, PortId>();
    for (const m of this.members.values()) byGroup.set(m.group, m.bundle);
    return [...byGroup.entries()].sort((a, b) => a[0] - b[0]).map((e) => e[1]);
  }

  /** The members of `bundle`, in canonical port order. */
  private membersOf(ctx: ProcessCtx, bundle: PortId): Member[] {
    const ids = [...this.members.values()].filter((m) => m.bundle === bundle).map((m) => m.port);
    return canonical(ids, ctx.ports).map((p) => this.members.get(p)!);
  }

  /** The bundled, link-up members of `bundle`, canonical order. */
  private bundledUp(ctx: ProcessCtx, bundle: PortId): PortId[] {
    return this.membersOf(ctx, bundle).filter((m) => m.state === 'bundled' && m.linkUp).map((m) => m.port);
  }

  /** Reconcile the members with the `channel-group` lines of the running config (idempotent). */
  private reconcile(ctx: ProcessCtx): Action[] {
    this.lastLoadBalance = readLoadBalance(ctx.config);
    const wanted = readChannelGroups(ctx.config);
    const actions: Action[] = [];
    const keep = new Set<PortId>();
    for (const w of wanted) {
      const m = this.members.get(w.port);
      if (m !== undefined && m.group === w.group && m.mode === w.mode) {
        keep.add(w.port);
        continue;
      }
      if (m !== undefined) actions.push(...this.remove(ctx, m, 'channel group changed'));
      const created: Member = { port: w.port, group: w.group, bundle: w.bundle, mode: w.mode, protocol: w.protocol, linkUp: false, state: 'down', tries: 0, gaveUp: false };
      this.members.set(w.port, created);
      keep.add(w.port);
      this.writeRow(ctx, created);
      this.emit(ctx, `${w.port} joins channel group ${w.group} (${w.bundle}, mode ${w.mode})`, { port: w.port, group: w.group, bundle: w.bundle, mode: w.mode });
      if (ctx.ports.get(w.port)?.operUp === true) actions.push(...this.start(ctx, created, 'channel group configured'));
    }
    for (const m of [...this.members.values()]) {
      if (!keep.has(m.port)) actions.push(...this.remove(ctx, m, 'channel group removed'));
    }
    return actions;
  }

  /** Delete a member: its timers, its row, and a signal when it took part in the bridge or its bundle. */
  private remove(ctx: ProcessCtx, m: Member, cause: string): Action[] {
    const actions: Action[] = this.cancelTimers(m);
    const prev = m.state;
    this.members.delete(m.port);
    ctx.tables.get<EtherchannelRow>(ETHERCHANNEL_TABLE)?.delete(m.port, 'cleared');
    this.transition(ctx, m, prev, 'none', cause);
    this.syncRef(ctx, m.bundle);
    if (prev !== 'down') actions.push({ type: 'l2Changed', what: 'channel', port: m.port });
    return actions;
  }

  /** A member's link came up: evaluate, then open the negotiation of its protocol. */
  private start(ctx: ProcessCtx, m: Member, cause: string): Action[] {
    m.linkUp = true;
    m.tries = 0;
    m.gaveUp = false;
    m.lacp = undefined;
    m.pagp = undefined;
    const actions: Action[] = this.evaluate(ctx, m, cause).actions;
    if (m.protocol === 'lacp') {
      if (modeInitiates(m.mode)) {
        m.tries = 1;
        actions.push(this.sendLacp(ctx, m), { type: 'timer', key: lacpTimerKey(LACP_TIMER_FAST, m.port), delay: LACP_FAST_INTERVAL_NS });
      } else {
        actions.push({ type: 'timer', key: lacpTimerKey(LACP_TIMER_WAIT, m.port), delay: LACP_WAIT_NS });
      }
    } else if (m.protocol === 'pagp') {
      if (modeInitiates(m.mode)) {
        m.tries = 1;
        actions.push(this.sendPagp(ctx, m), { type: 'timer', key: pagpTimerKey(PAGP_TIMER_FAST, m.port), delay: PAGP_FAST_INTERVAL_NS });
      } else {
        actions.push({ type: 'timer', key: pagpTimerKey(PAGP_TIMER_WAIT, m.port), delay: PAGP_WAIT_NS });
      }
    }
    return actions;
  }

  /** A member's link went down: timers off, partner forgotten, row `down` (no signal, §3.7 step 7). */
  private stop(ctx: ProcessCtx, m: Member, cause: string): Action[] {
    m.linkUp = false;
    m.tries = 0;
    m.gaveUp = false;
    m.lacp = undefined;
    m.pagp = undefined;
    const actions = this.cancelTimers(m);
    actions.push(...this.evaluate(ctx, m, cause).actions);
    // the bundle may be empty now (its reference goes), or the others may agree on something new
    actions.push(...this.evaluateBundle(ctx, m.bundle, `${m.port} left the bundle`));
    return actions;
  }

  private cancelTimers(m: Member): Action[] {
    if (m.protocol === 'lacp') {
      const kinds: LacpTimerKind[] = [LACP_TIMER_FAST, LACP_TIMER_WAIT, LACP_TIMER_TX, LACP_TIMER_AGE];
      return kinds.map((k): Action => ({ type: 'cancelTimer', key: lacpTimerKey(k, m.port) }));
    }
    if (m.protocol === 'pagp') {
      const kinds: PagpTimerKind[] = [PAGP_TIMER_FAST, PAGP_TIMER_WAIT, PAGP_TIMER_TX, PAGP_TIMER_AGE];
      return kinds.map((k): Action => ({ type: 'cancelTimer', key: pagpTimerKey(k, m.port) }));
    }
    return [];
  }

  /** Re-run the decision of every member of `bundle` (canonical order) until nothing changes. */
  private evaluateBundle(ctx: ProcessCtx, bundle: PortId, cause: string): Action[] {
    const actions: Action[] = [];
    const list = this.membersOf(ctx, bundle);
    this.syncRef(ctx, bundle);
    for (let pass = 0; pass <= list.length; pass++) {
      let changed = false;
      for (const m of list) {
        const r = this.evaluate(ctx, m, cause);
        if (r.changed) changed = true;
        actions.push(...r.actions);
      }
      if (!changed) break;
    }
    return actions;
  }

  // ── the decision ─────────────────────────────────────────────────────────

  private facts(ctx: ProcessCtx, m: Member): MemberFacts {
    const config = readSwitchport(ctx.config, m.port, ctx.model);
    const dtp = ctx.tables.get<DtpRow>('dtp')?.get(m.port);
    const view = ctx.ports.get(m.port);
    const out: MemberFacts = { port: m.port, config, oper: operOf(config, dtp) };
    return {
      ...out,
      ...(view?.speedBps !== undefined ? { speedBps: view.speedBps } : {}),
      ...(view?.duplex !== undefined ? { duplex: view.duplex } : {}),
    };
  }

  /** The bundled, link-up members of `m`'s bundle other than `m`, canonical order. */
  private bundledOthers(ctx: ProcessCtx, m: Member): Member[] {
    return this.membersOf(ctx, m.bundle).filter((o) => o !== m && o.state === 'bundled' && o.linkUp);
  }

  /** The reference values of a member: what it would define a bundle as. */
  private refOf(ctx: ProcessCtx, m: Member): BundleRef {
    const f = this.facts(ctx, m);
    return { oper: f.oper, ...(f.speedBps !== undefined ? { speedBps: f.speedBps } : {}), ...(f.duplex !== undefined ? { duplex: f.duplex } : {}) };
  }

  /**
   * Bring the bundle's reference in line with its bundled, link-up members: none = no reference; all agreeing (one
   * member included) = their values; disagreeing = the existing reference stays (or the first member's when none).
   */
  private syncRef(ctx: ProcessCtx, bundle: PortId): void {
    const bundled = this.membersOf(ctx, bundle).filter((o) => o.state === 'bundled' && o.linkUp);
    const first = bundled[0];
    if (first === undefined) {
      this.refs.delete(bundle);
      return;
    }
    const refs = bundled.map((o) => this.refOf(ctx, o));
    const lead = refs[0]!;
    if (refs.every((r) => sameRef(r, lead)) || !this.refs.has(bundle)) this.refs.set(bundle, lead);
  }

  private bundleFacts(ctx: ProcessCtx, m: Member): BundleFacts {
    const config = readSwitchport(ctx.config, m.bundle, ctx.model);
    if (this.bundledOthers(ctx, m).length === 0) return { bundle: m.bundle, config };
    const ref = this.refs.get(m.bundle);
    if (ref === undefined) return { bundle: m.bundle, config };
    return {
      bundle: m.bundle,
      config,
      oper: ref.oper,
      ...(ref.speedBps !== undefined ? { speedBps: ref.speedBps } : {}),
      ...(ref.duplex !== undefined ? { duplex: ref.duplex } : {}),
    };
  }

  private partnerIdOf(m: Member): PartnerId | undefined {
    if (m.protocol === 'lacp') return m.lacp === undefined ? undefined : { system: m.lacp.system, key: m.lacp.key };
    if (m.protocol === 'pagp') return m.pagp === undefined ? undefined : { system: m.pagp.device, key: m.pagp.group };
    return undefined;
  }

  /** The partner identity the bundle is keyed on: that of the first bundled other member. */
  private bundlePartner(ctx: ProcessCtx, m: Member): PartnerId | undefined {
    for (const o of this.bundledOthers(ctx, m)) {
      const id = this.partnerIdOf(o);
      if (id !== undefined) return id;
    }
    return undefined;
  }

  private targetOf(ctx: ProcessCtx, m: Member): Target {
    if (!m.linkUp) return { state: 'down' };
    const compat = compatibility(this.facts(ctx, m), this.bundleFacts(ctx, m));
    if (m.protocol === 'static') return staticMemberState(compat);
    const partner = this.partnerIdOf(m);
    if (partner === undefined) {
      return m.gaveUp ? { state: 'individual', reason: m.protocol === 'lacp' ? NO_LACP_PARTNER : NO_PAGP_PARTNER } : { state: 'waiting' };
    }
    if (m.protocol === 'lacp' && m.lacp !== undefined && !partnerInSync(m.lacp.state)) return { state: 'waiting', reason: PARTNER_NOT_READY };
    if (!compat.ok) return { state: 'suspended', reason: compat.reason };
    const bp = this.bundlePartner(ctx, m);
    if (bp !== undefined && (bp.system !== partner.system || bp.key !== partner.key)) return { state: 'suspended', reason: partnerDiffersReason(m.bundle) };
    return { state: 'bundled' };
  }

  /**
   * Apply the decision for `m`: on a change, one transition, one row write, the `l2Changed` signal (unless the port
   * went down or merely started negotiating) and, when a partner is known, one message telling it (`sent`).
   */
  private evaluate(ctx: ProcessCtx, m: Member, cause: string, pdu?: PduId): { actions: Action[]; changed: boolean; sent: boolean } {
    const next = this.targetOf(ctx, m);
    if (next.state === m.state && next.reason === m.reason) return { actions: [], changed: false, sent: false };
    const prev = m.state;
    m.state = next.state;
    if (next.reason === undefined) delete m.reason;
    else m.reason = next.reason;
    this.writeRow(ctx, m);
    this.transition(ctx, m, prev, next.state, next.reason === undefined ? cause : `${cause}: ${next.reason}`, pdu);
    this.syncRef(ctx, m.bundle);
    const actions: Action[] = [];
    const signal = next.state !== 'down' && !(prev === 'down' && next.state === 'waiting');
    if (signal) actions.push({ type: 'l2Changed', what: 'channel', port: m.port });
    let sent = false;
    if (next.state !== 'down' && prev !== next.state) {
      if (m.protocol === 'lacp' && m.lacp !== undefined) {
        actions.push(this.sendLacp(ctx, m));
        sent = true;
      } else if (m.protocol === 'pagp' && m.pagp !== undefined) {
        actions.push(this.sendPagp(ctx, m));
        sent = true;
      }
    }
    return { actions, changed: true, sent };
  }

  private writeRow(ctx: ProcessCtx, m: Member): void {
    const table = ctx.tables.get<EtherchannelRow>(ETHERCHANNEL_TABLE);
    if (table === undefined) return;
    const row: EtherchannelRow = { key: m.port, port: m.port, group: m.group, bundle: m.bundle, protocol: m.protocol, mode: m.mode, state: m.state, updatedAt: ctx.now };
    if (m.reason !== undefined) row.reason = m.reason;
    if (m.lacp !== undefined) {
      row.partnerSystem = m.lacp.system;
      row.partnerKey = m.lacp.key;
      row.partnerPort = m.lacp.port;
    } else if (m.pagp !== undefined) {
      row.partnerSystem = m.pagp.device;
      row.partnerKey = m.pagp.group;
      row.partnerPort = m.pagp.port;
    }
    table.set(row);
  }

  // ── frames ───────────────────────────────────────────────────────────────

  private sendLacp(ctx: ProcessCtx, m: Member): Action {
    const state = lacpActorState({
      active: m.mode === 'active',
      sync: m.linkUp && m.state !== 'suspended',
      bundled: m.state === 'bundled',
      partnerKnown: m.lacp !== undefined,
    });
    const pdu = ctx.newPdu(
      lacpduLayers({
        srcMac: ctx.macOf(m.port),
        system: lacpSystemMac(ctx.ports),
        key: m.group,
        portNumber: ctx.ports.get(m.port)?.ordinal ?? 0,
        state,
        ...(m.lacp !== undefined ? { partner: m.lacp } : {}),
      }),
      { tag: LACP_TAG, background: true },
    );
    this.emit(ctx, `LACPDU sent on ${m.port} (${m.bundle}, ${m.state})`, { port: m.port, pdu: pdu.id, bundle: m.bundle, state: m.state, actorState: state });
    return { type: 'send', port: m.port, pdu };
  }

  private sendPagp(ctx: ProcessCtx, m: Member): Action {
    const pdu = ctx.newPdu(
      pagpLayers({
        srcMac: ctx.macOf(m.port),
        device: lacpSystemMac(ctx.ports),
        portNumber: ctx.ports.get(m.port)?.ordinal ?? 0,
        group: m.group,
        mode: m.mode === 'desirable' ? 'desirable' : 'auto',
        ...(m.pagp !== undefined ? { partner: m.pagp } : {}),
      }),
      { tag: PAGP_TAG, background: true },
    );
    this.emit(ctx, `PAgP message sent on ${m.port} (${m.bundle}, ${m.state})`, { port: m.port, pdu: pdu.id, bundle: m.bundle, state: m.state });
    return { type: 'send', port: m.port, pdu };
  }

  private dropControl(ctx: ProcessCtx, pdu: Pdu, port: PortId, reason: 'not-for-me' | 'unsupported-protocol', detail: string): Action[] {
    this.emit(ctx, `dropped pdu ${pdu.id} from ${port}: ${detail}`, { port, pdu: pdu.id });
    return [{ type: 'drop', pdu, reason, detail, port }];
  }

  // ── debug ────────────────────────────────────────────────────────────────

  private machineOf(m: Member): FsmMachine {
    if (m.protocol === 'lacp') return 'lacp';
    if (m.protocol === 'pagp') return 'pagp';
    return 'channel';
  }

  private transition(ctx: ProcessCtx, m: Member, from: string, to: string, cause: string, pdu?: PduId): void {
    const fsm: FsmTransition = { machine: this.machineOf(m), subject: `${m.bundle} ${m.port}`, port: m.port, instance: m.group, from, to, cause, ...(pdu !== undefined ? { pdu } : {}) };
    const message = `${m.port} ${from} -> ${to} in ${m.bundle}: ${cause}`;
    ctx.transition(ETHERCHANNEL_DEBUG_CATEGORY, message, fsm);
    this.ring.push({ at: ctx.now, device: ctx.deviceId, process: ETHERCHANNEL_PROCESS, category: ETHERCHANNEL_DEBUG_CATEGORY, message, fsm });
  }

  private emit(ctx: ProcessCtx, message: string, data?: Record<string, unknown>): void {
    ctx.debug(ETHERCHANNEL_DEBUG_CATEGORY, message, data);
    const ev: DebugEvent = data === undefined
      ? { at: ctx.now, device: ctx.deviceId, process: ETHERCHANNEL_PROCESS, category: ETHERCHANNEL_DEBUG_CATEGORY, message }
      : { at: ctx.now, device: ctx.deviceId, process: ETHERCHANNEL_PROCESS, category: ETHERCHANNEL_DEBUG_CATEGORY, message, data };
    this.ring.push(ev);
  }
}

/** Create the EtherChannel daemon (`name: 'etherchannel'`, no frame selectors; owner of the `channel` port role, D10). */
export function createEtherchannel(): Process {
  return new EtherchannelDaemon();
}
