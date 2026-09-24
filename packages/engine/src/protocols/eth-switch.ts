/**
 * protocols/eth-switch.ts — the bridging daemon (switches, multilayer switches, access points, home routers, radio
 * bridges, cell towers, modems, ISP clouds and, from P2, managed switches and wireless controllers).
 *
 * Implements spec §2.1 "MAC addressing & switching" (CAM table with ageing timers, flooding, unicast/broadcast/
 * multicast handling), §4.8 (process model: actions out, `stateSnapshot()` is the only UI truth, every transition
 * emits a DebugEvent), §9.4 (MAC table visualizer), ARCHITECTURE-P1 D3/§3.10 (per-port roles, SVIs, hairpin) and
 * ARCHITECTURE-P2 §3.0 "frame path v3" (the VLAN-aware path), §3.8 (port security) and D12 (secure rows).
 *
 * Bridge membership is a ROLE trait, never a device kind: a port belongs to the bridge when
 * `ROLE_TRAITS[role].bridged` (switched, wireless-bss, radio-ptp, access-line, channel, wlan-tunnel). The effective
 * role is `PortView.role`, else the spec default for the model capabilities.
 *
 * TWO PATHS (ARCHITECTURE-P2 D5). A device whose model runs the `vlan` daemon (`isVlanAware(model)`) takes the
 * VLAN-aware path below; every other bridging device takes the TRANSPARENT path, which is the P0.5/P1 code unchanged,
 * byte for byte in traffic, trace and debug text. Both paths share `learn`, `fanOut`, `relay` and the wording, so the
 * VLAN-aware path on untagged VLAN-1 traffic (a P1-profile world after the catalog flip) emits exactly the transparent
 * path's events (`l2.eth-switch.p0-parity.test.ts`).
 *
 * Transparent behaviour (VLAN 1 only):
 *  • LEARN   — a frame from bridged port P with a unicast source S creates or refreshes `camKey(1, S)` →
 *              `{port: P, type: 'dynamic', expiresAt: now + ageing}` (ageing = `model.ipDefaults.camAgeingNs`,
 *              300 s). A row that changes port is a "move". Static rows are never overwritten. Group sources are
 *              never learned.
 *  • SVI     — a frame whose destination is the MAC of an oper-up SVI of this device becomes
 *              `Action ingress {port: <svi>, pdu}` (the original pdu, no bridging). A group frame is flooded AND
 *              handed to every oper-up SVI as an ingress clone. A frame for the MAC of a down SVI is dropped.
 *  • FORWARD — a known unicast destination is sent out its CAM port. When that port is the ingress port the frame
 *              is FILTERED (drop 'other', detail 'destination is on the ingress port') unless the port's role has
 *              the hairpin trait (one radio serving many stations): then it goes back out the same port.
 *  • FLOOD   — broadcast, multicast and unknown unicast destinations are copied to every oper-up bridged port whose
 *              encapsulation carries Ethernet (ethernet, dot11) except the ingress port (included when it is a
 *              hairpin port; the medium suppresses the copy to the originator), in `ctx.ports` order. The ORIGINAL
 *              pdu goes to the first target and `ctx.clone(pdu)` copies to the others, so provenance chains via
 *              `meta.parent`. No target at all → drop 'other', detail 'no egress port'.
 *  • RELAY   — a non-Ethernet frame (HDLC on the serial access lines of a CSU/DSU or an ISP cloud) is relayed
 *              without learning to every other oper-up bridged port of the same encapsulation.
 *  • EGRESS  — `onEgress(pdu, svi)` (the runtime calls it when arp/ipv4 send on an SVI this daemon owns): CAM lookup
 *              → send on the member port, else flood to every oper-up Ethernet-carrying bridged port.
 *  • AGEING  — `init` arms the periodic 'cam-sweep' timer every CAM_SWEEP_INTERVAL_NS (15 s); each sweep calls
 *              `tables.cam.expire(now)` and always re-arms.
 *  • LINK    — `onLinkChange(port, false)` deletes every CAM row learned on that port (reason 'link-down').
 *  • CONFIG  — ignored.
 *
 * VLAN-aware behaviour (§3.0 steps 1–12, only on a device running `vlan`):
 *  1. not bridged → drop; hdlc → relay; no ethernet → drop (as above);
 *  2. PHYSICAL CONTROL — `classifyControl` (protocols/l2/control.ts): lacp, dtp, pagp and reserved frames are
 *     delivered to their daemon (or dropped per the table) on the ARRIVAL port, before member translation;
 *  3. MEMBER TRANSLATION — an `etherchannel` row `bundled` → the logical port L is the bundle; `waiting` or
 *     `suspended` → drop 'other', `<P> is not forwarding for <bundle> (<state>)`; else L = P;
 *  4. CLASSIFY — `classify(readSwitchport(config, L), operOf(L), tag)` gives the VLAN V or a `vlan-filtered` drop;
 *     a controller distribution port that is not the ACTIVE one drops 'other', `<P> is a backup distribution port`;
 *  5. LOGICAL CONTROL — a BPDU goes to stp with port L when a `stp-bridge` row exists for V (even when L is
 *     blocking), else it continues as an ordinary multicast of V;
 *  6. SPANNING-TREE GATE — with a `stp-bridge` row for V: forwarding continues, learning learns then drops
 *     `stp-discarding` 'learning', anything else drops `stp-discarding` with the state (or 'not a spanning-tree port');
 *  7. PORT SECURITY — with a `port-security` row for L (§3.8): allow, learn a secure row (sticky → a `configLine`
 *     action with the sticky line), or a `port-security` drop plus the mode's effects;
 *  8. LEARN `camKey(V, src)` → L (static and secure rows are never overwritten; group sources never learned);
 *  9. SVI — a unicast for the MAC of `Vlan<V>` (or one of its `virtual4` MACs): down → drop `<svi> is down`; up →
 *     the tag is popped (cause `interface Vlan<V>`) and the frame re-enters on the SVI (`ingress`);
 * 10. FORWARD — a CAM hit in V is sent on its port if that port is an egress candidate for V (filtered when it is L,
 *     unless hairpin), else dropped 'no egress port';
 * 11. FLOOD — every candidate carrying V (oper up, bridged, not a bundled/waiting/suspended member, forwarding in V
 *     when spanning tree runs for V, E ≠ L unless hairpin; a controller bridges only between the active
 *     distribution port and the tunnel, never port to port), plus an ingress clone for `Vlan<V>` when the frame is a
 *     group frame and the SVI is up;
 * 12. FAN-OUT — every clone is allocated first, then each copy is normalised toward its target with
 *     `ctx.rewrap(copy, vlanPushOp(V) | vlanPopOp(), cause)` (the cause is the line that makes the port carry V that
 *     way; the SVI copy is always untagged, cause `interface Vlan<V>`).
 *
 * CAM FLUSHES on the VLAN-aware path (§3.0 table; only DYNAMIC rows are ever flushed, D12): a membership line of port
 * X (`switchport mode|access vlan|trunk native vlan|trunk allowed vlan|voice vlan|nonegotiate`) flushes X's dynamic
 * rows (a `switchport port-security …` line never does); `l2.changed` trunk/channel/stp/vlans and `l2.flush`
 * flush or fast-age as the table says; link-down removes every dynamic row of the port, dynamic (non-sticky)
 * secure rows included. Configured static rows (`mac address-table static <mac> vlan <v> interface <if>`) and
 * configured or sticky secure rows are derived from the running config on every relevant `onConfig`, idempotently.
 *
 * PORT SECURITY rows (`port-security` table, key = port) exist only for ports with `switchport port-security`; the
 * daemon keeps `count` equal to the secure CAM rows of the port. A shutdown-mode violation err-disables the port
 * (`errDisable` action, cause `psecure-violation`) and, when `errdisable recovery cause psecure-violation` is
 * configured, arms the periodic timer `errdisable:<port>` (§4.2) that issues `errRecover`.
 *
 * `stateSnapshot()` (stable shape, identical on both paths):
 *   { process: 'eth-switch', state: { vlan: 1, ageingNs, entries, floods, forwards, filtered, learned, moved, aged } }
 * `entries` is the live CAM size. SVI deliveries, hairpin sends, SVI egress and relays count as `forwards` or
 * `floods`.
 *
 * Debug categories: 'ethernet switching' (matches `debug ethernet switching`; every bridging message, unchanged),
 * 'port-security' (the port-security messages only, §5.4).
 */
import { MAC_BROADCAST } from '../contracts/addr.js';
import type { MacAddress } from '../contracts/addr.js';
import { BRIDGED_ROLES, KIND_ENCAP, ROLE_TRAITS, defaultRoleFor, isVlanAware } from '../contracts/catalog.js';
import type { PortEncap, PortRole } from '../contracts/catalog.js';
import type { ConfigDelta } from '../contracts/config.js';
import type { PortId } from '../contracts/ids.js';
import type { Pdu } from '../contracts/pdu.js';
import type { PortView, SwitchportConfig } from '../contracts/port.js';
import type { Action, DebugEvent, DemuxSelector, Process, ProcessCtx, StateView } from '../contracts/process.js';
import { CAM_AGEING_NS, camKey, stpKey, vlanKey } from '../contracts/tables.js';
import type { CamRow, DeviceTables, DtpRow, EtherchannelRow, PortSecurityRow, StpBridgeRow, StpPortRow, VlanRow } from '../contracts/tables.js';
import type { ProcessEvent } from '../contracts/transport.js';
import { SEC } from '../contracts/time.js';
import type { SimTime } from '../contracts/time.js';
import { vlanPopOp, vlanPushOp } from '../pdu/vlan.js';
import { classifyControl, controlAction } from './l2/control.js';
import {
  carries,
  channelOperOf,
  classify,
  frameVlanTag,
  normaliseForPort,
  normaliseForSvi,
  operOf,
  sviName,
  vlanExistsIn,
  vlanOfSviName,
} from './l2/membership.js';
import type { L2PortView, VlanExistsFn } from './l2/membership.js';
import {
  PORT_SECURITY_DEBUG_CATEGORY,
  PORT_SECURITY_LOG_FACILITY,
  applyPortSecurityVerdict,
  configuredSecureAddresses,
  decidePortSecurity,
  errdisableRecovery,
  errdisableTimerKey,
  isPortSecurityLine,
  portSecurityRow,
  portSecurityStatus,
  readPortSecurity,
  stickyConfigLine,
} from './l2/port-security.js';
import { interfaceOfContext, isControllerModel, isMembershipLine, readAllSwitchports, readSwitchport, readVoiceVlan } from './l2/switchport-config.js';

/** Process name registered by the catalog for bridging models. */
export const ETH_SWITCH_PROCESS = 'eth-switch';
/** Debug category emitted by this daemon (`debug ethernet switching`). */
export const ETH_SWITCH_DEBUG_CATEGORY = 'ethernet switching';
/** Timer key of the periodic CAM ageing sweep. */
export const CAM_SWEEP_TIMER = 'cam-sweep';
/** Interval between CAM ageing sweeps (15 s). Rows expire on the first sweep at or after `expiresAt`. */
export const CAM_SWEEP_INTERVAL_NS: SimTime = 15 * SEC;
/** The only VLAN in P0.5 (and the VLAN of the transparent path). */
export const DEFAULT_VLAN = 1;
/** Capacity of the per-process DebugEvent ring. */
export const ETH_SWITCH_DEBUG_RING = 200;

/** Drop detail when a known destination sits on the ingress port (filtering). */
export const DETAIL_FILTERED = 'destination is on the ingress port';
/** Drop detail when no oper-up bridged port is available for egress. */
export const DETAIL_NO_EGRESS = 'no egress port';
/** Drop detail when the frame handed to the switch has no ethernet layer. */
export const DETAIL_NO_ETHERNET = 'frame has no ethernet header';
/** Drop detail when a frame arrives on (or is sent through) a port that is not a bridge member. */
export const DETAIL_NOT_BRIDGED = 'port is not part of the bridge';
/** Drop detail prefix when a frame is addressed to the MAC of an SVI that is down: `<svi> is down`. */
export const DETAIL_SVI_DOWN_SUFFIX = 'is down';
/** @since P2 Drop detail of a learning port: `stp-discarding`, detail 'learning'. */
export const DETAIL_STP_LEARNING = 'learning';
/** @since P2 Drop detail of a port with no spanning-tree row while an instance runs for the VLAN. */
export const DETAIL_NOT_STP_PORT = 'not a spanning-tree port';
/** @since P2 Drop detail of a frame sent on a port that is not an SVI of a VLAN-aware device. */
export const DETAIL_NO_VLAN = 'port carries no VLAN';

/** @since P2 Drop detail of a member that is not forwarding: `<P> is not forwarding for <bundle> (<state>)`. */
export function memberNotForwardingDetail(port: PortId, bundle: PortId, state: EtherchannelRow['state']): string {
  return `${port} is not forwarding for ${bundle} (${state})`;
}
/** @since P2 Drop detail of a frame on a controller distribution port that is not the active one (D17). */
export function backupDistributionDetail(port: PortId): string {
  return `${port} is a backup distribution port`;
}

/**
 * Frame selectors: every Ethernet frame on a bridged port, plus non-Ethernet (HDLC) frames on bridged ports for the
 * transparent relay of serial access lines. Keyed daemons (arp/ipv4/hdlc) win their own ethertypes on L3 roles.
 */
export const ETH_SWITCH_HANDLES: readonly DemuxSelector[] = Object.freeze([
  Object.freeze({ layer: 'ethernet', roles: BRIDGED_ROLES }),
  Object.freeze({ layer: 'hdlc', roles: BRIDGED_ROLES }),
]) as readonly DemuxSelector[];

/** True for group addresses (broadcast or multicast): the I/G bit of the first octet. */
function isGroupMac(mac: MacAddress): boolean {
  const c = mac.charCodeAt(1);
  // '0'..'9' → 0..9, 'a'..'f' / 'A'..'F' → 10..15 (canonical MACs are lowercase; tolerate upper).
  const v = c <= 57 ? c - 48 : (c | 0x20) - 87;
  return (v & 1) === 1;
}

/** Human class of a destination for debug wording. */
function destinationClass(dst: MacAddress, known: boolean): 'broadcast' | 'multicast' | 'unknown unicast' | 'unicast' {
  if (dst === MAC_BROADCAST) return 'broadcast';
  if (isGroupMac(dst)) return 'multicast';
  return known ? 'unicast' : 'unknown unicast';
}

/** Effective role of a port: live role, else the spec default for the model capabilities. */
function roleOf(ctx: ProcessCtx, view: PortView): PortRole {
  return view.role ?? view.spec.role ?? defaultRoleFor(view.spec.kind, ctx.model.capabilities ?? []);
}

/** Effective encapsulation of a port: live encap, else the spec default. */
function encapOf(view: PortView): PortEncap {
  return view.encap ?? view.spec.encap ?? KIND_ENCAP[view.spec.kind];
}

/** Can a frame whose outer layer is `outer` leave through a port of encapsulation `encap`? (dot11 radios rewrap Ethernet.) */
function encapCarries(encap: PortEncap, outer: string): boolean {
  if (outer === 'ethernet') return encap === 'ethernet' || encap === 'dot11';
  return encap === outer;
}

/** Can a frame with outer layer `outer` leave through this port right now? */
function isEgressCandidate(ctx: ProcessCtx, view: PortView, outer: string): boolean {
  return view.operUp && ROLE_TRAITS[roleOf(ctx, view)].bridged && encapCarries(encapOf(view), outer);
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

  /** Oldest → newest. Fresh array. */
  toArray(): DebugEvent[] {
    if (this.buf.length < this.capacity) return this.buf.slice();
    const out = new Array<DebugEvent>(this.buf.length);
    for (let i = 0; i < this.buf.length; i++) out[i] = this.buf[(this.start + i) % this.capacity]!;
    return out;
  }
}

/** One destination of a copy: a bridged port (`send`) or an SVI of this device (`ingress`). */
interface CopyTarget {
  kind: 'send' | 'ingress';
  port: PortId;
}

/**
 * @since P2 Per-frame view of the VLAN-aware device: the tables the path reads (absent when the model does not declare
 * them), the switchport configurations of every configured port (one parse per frame) and the existence predicate.
 */
interface VlanWorld {
  readonly exists: VlanExistsFn;
  readonly switchports: ReadonlyMap<PortId, SwitchportConfig>;
  readonly etherchannel: { get(key: string): EtherchannelRow | undefined; find(pred: (r: EtherchannelRow) => boolean): EtherchannelRow[] } | undefined;
  readonly dtp: { get(key: string): DtpRow | undefined } | undefined;
  readonly stpBridge: { has(key: string): boolean } | undefined;
  readonly stp: { get(key: string): StpPortRow | undefined } | undefined;
  readonly controller: boolean;
}

/** Member states that take a port out of the bridge on its own (its bundle bridges instead, or nothing does). */
const NON_INDIVIDUAL_MEMBER: readonly EtherchannelRow['state'][] = ['bundled', 'waiting', 'suspended'];

/** Timer key prefix of the port-security err-disable recovery timer. */
const ERRDISABLE_TIMER_PREFIX = 'errdisable:';

// [S4] ── the IP phone's voice VLAN (ARCHITECTURE-P2 §5.5 `voice vlan <v>`) ──────────────────────────────────────
// A host with a built-in transparent bridge (the phone) tags its OWN frames with its voice VLAN on its network port
// (the `uplink` port) and takes frames tagged with that VLAN on that port as its own; the computer behind the
// pass-through port keeps its untagged frames. Without the line nothing here runs (the P1 path stays verbatim).

/** [S4] Provenance cause of the tag the phone pushes on (or pops from) its own frames. */
export function phoneVoiceVlanCause(vlan: number): string {
  return `voice vlan ${vlan}`;
}
/** [S4] Drop detail of a voice-VLAN frame on the phone's network port that is for neither the phone nor a group. */
export const DETAIL_VOICE_NOT_FOR_PHONE = 'voice VLAN frame for another station';

/** [S4] The phone's voice VLAN and network port. */
interface VoiceUplink {
  readonly vlan: number;
  readonly uplink: PortId;
}

class EthSwitch implements Process {
  readonly name = ETH_SWITCH_PROCESS;
  readonly handles = ETH_SWITCH_HANDLES;

  private readonly ring = new DebugRing(ETH_SWITCH_DEBUG_RING);
  /** Device tables captured from the last ctx seen (device-owned, stable for the device's life). */
  private tables: DeviceTables | undefined;
  /** CAM ageing of the model, captured from the last ctx seen. */
  private ageingNs: SimTime = CAM_AGEING_NS;
  private floods = 0;
  private forwards = 0;
  private filtered = 0;
  private learned = 0;
  private moved = 0;
  private aged = 0;
  /** @since P2 Ports whose `errdisable:<port>` recovery timer is armed. */
  private readonly recoveryArmed = new Set<PortId>();

  init(ctx: ProcessCtx): Action[] {
    this.capture(ctx);
    this.emit(ctx, `ageing sweep armed every ${CAM_SWEEP_INTERVAL_NS / SEC} s, entries age out after ${this.ageingNs / SEC} s`, {
      sweepNs: CAM_SWEEP_INTERVAL_NS, ageingNs: this.ageingNs,
    });
    return [{ type: 'timer', key: CAM_SWEEP_TIMER, delay: CAM_SWEEP_INTERVAL_NS, periodic: true }];
  }

  onPdu(ctx: ProcessCtx, pdu: Pdu, port: PortId): Action[] {
    this.capture(ctx);
    if (isVlanAware(ctx.model)) return this.onPduVlanAware(ctx, pdu, port);
    const ingress = ctx.ports.get(port);
    if (ingress !== undefined && !ROLE_TRAITS[roleOf(ctx, ingress)].bridged) {
      this.emit(ctx, `dropped pdu ${pdu.id} from ${port}: ${DETAIL_NOT_BRIDGED}`, { port, pdu: pdu.id });
      return [{ type: 'drop', pdu, reason: 'other', detail: DETAIL_NOT_BRIDGED, port }];
    }
    const outer = pdu.layers[0]?.proto;
    if (outer === 'hdlc') return this.relay(ctx, pdu, port, outer);
    const eth = pdu.layer('ethernet');
    if (eth === undefined) {
      this.emit(ctx, `dropped pdu ${pdu.id} from ${port}: ${DETAIL_NO_ETHERNET}`, { port, pdu: pdu.id });
      return [{ type: 'drop', pdu, reason: 'other', detail: DETAIL_NO_ETHERNET, port }];
    }
    const src = eth.fields.src as MacAddress;
    const dst = eth.fields.dst as MacAddress;

    // [S4] a frame tagged with the phone's voice VLAN on its network port is the phone's own
    const voice = this.voiceUplink(ctx);
    if (voice !== undefined && port === voice.uplink && frameVlanTag(pdu) === voice.vlan) return this.onVoiceFrame(ctx, pdu, port, voice, src, dst);

    this.learn(ctx, src, port);

    const group = isGroupMac(dst);
    if (!group) {
      const svi = this.sviByMac(ctx, dst);
      if (svi !== undefined) {
        if (!svi.operUp) {
          const detail = `${svi.id} ${DETAIL_SVI_DOWN_SUFFIX}`;
          this.emit(ctx, `dropped frame for ${dst} from ${port}: ${detail}`, { dst, port, svi: svi.id, pdu: pdu.id });
          return [{ type: 'drop', pdu, reason: 'other', detail, port }];
        }
        this.forwards++;
        this.emit(ctx, `delivering frame for ${dst} from ${port} to ${svi.id} (vlan ${DEFAULT_VLAN})`, {
          dst, port, svi: svi.id, pdu: pdu.id,
        });
        return [{ type: 'ingress', port: svi.id, pdu }];
      }
    }

    const row = group ? undefined : ctx.tables.cam.get(camKey(DEFAULT_VLAN, dst));
    if (row === undefined) return this.flood(ctx, pdu, port, dst, group);

    if (row.port === port) {
      const hairpin = ingress !== undefined && ROLE_TRAITS[roleOf(ctx, ingress)].hairpin;
      if (!hairpin) {
        this.filtered++;
        this.emit(ctx, `filtered frame for ${dst} from ${port}: ${DETAIL_FILTERED} (vlan ${DEFAULT_VLAN})`, {
          dst, port, pdu: pdu.id,
        });
        return [{ type: 'drop', pdu, reason: 'other', detail: DETAIL_FILTERED, port }];
      }
      if (ingress === undefined || !isEgressCandidate(ctx, ingress, 'ethernet')) {
        this.emit(ctx, `dropped frame for ${dst} from ${port}: ${DETAIL_NO_EGRESS} (${port} is not forwarding)`, {
          dst, port, egress: port, pdu: pdu.id,
        });
        return [{ type: 'drop', pdu, reason: 'other', detail: DETAIL_NO_EGRESS, port }];
      }
      this.forwards++;
      this.emit(ctx, `forwarding frame for ${dst} back out ${port} (same radio, vlan ${DEFAULT_VLAN})`, {
        dst, port, egress: port, pdu: pdu.id,
      });
      return [{ type: 'send', port, pdu }];
    }

    const egress = ctx.ports.get(row.port);
    if (egress === undefined || !isEgressCandidate(ctx, egress, 'ethernet')) {
      this.emit(ctx, `dropped frame for ${dst} from ${port}: ${DETAIL_NO_EGRESS} (${row.port} is not forwarding)`, {
        dst, port, egress: row.port, pdu: pdu.id,
      });
      return [{ type: 'drop', pdu, reason: 'other', detail: DETAIL_NO_EGRESS, port }];
    }

    this.forwards++;
    this.emit(ctx, `forwarding frame for ${dst} from ${port} out ${row.port} (vlan ${DEFAULT_VLAN})`, {
      dst, port, egress: row.port, pdu: pdu.id,
    });
    return [{ type: 'send', port: row.port, pdu }];
  }

  /**
   * SVI egress (the runtime calls this when another daemon sends on an SVI owned by eth-switch): CAM lookup of the
   * destination → the member port, else flood to every oper-up Ethernet-carrying bridged port. On a VLAN-aware device
   * the lookup and the flood are confined to the SVI's VLAN and every copy is normalised (§3.0 `onEgress`).
   */
  onEgress(ctx: ProcessCtx, pdu: Pdu, port: PortId): Action[] {
    this.capture(ctx);
    if (isVlanAware(ctx.model)) return this.onEgressVlanAware(ctx, pdu, port);
    const eth = pdu.layer('ethernet');
    if (eth === undefined) {
      this.emit(ctx, `dropped pdu ${pdu.id} sent on ${port}: ${DETAIL_NO_ETHERNET}`, { port, pdu: pdu.id });
      return [{ type: 'drop', pdu, reason: 'other', detail: DETAIL_NO_ETHERNET, port }];
    }
    const dst = eth.fields.dst as MacAddress;
    const group = isGroupMac(dst);
    const row = group ? undefined : ctx.tables.cam.get(camKey(DEFAULT_VLAN, dst));
    if (row !== undefined) {
      const egress = ctx.ports.get(row.port);
      if (egress === undefined || !isEgressCandidate(ctx, egress, 'ethernet')) {
        this.emit(ctx, `dropped frame for ${dst} from ${port}: ${DETAIL_NO_EGRESS} (${row.port} is not forwarding)`, {
          dst, port, egress: row.port, pdu: pdu.id,
        });
        return [{ type: 'drop', pdu, reason: 'other', detail: DETAIL_NO_EGRESS, port }];
      }
      this.forwards++;
      this.emit(ctx, `bridging frame for ${dst} from ${port} out ${row.port} (vlan ${DEFAULT_VLAN})`, {
        dst, port, egress: row.port, pdu: pdu.id,
      });
      this.tagForVoiceUplink(ctx, pdu, row.port);
      return [{ type: 'send', port: row.port, pdu }];
    }
    const targets: CopyTarget[] = [];
    for (const view of ctx.ports.values()) {
      if (isEgressCandidate(ctx, view, 'ethernet')) targets.push({ kind: 'send', port: view.id });
    }
    return this.fanOut(ctx, pdu, port, dst, targets, `from ${port}`, (copy, t) => this.tagForVoiceUplink(ctx, copy, t.port));
  }

  // [S4] ── the phone's voice VLAN on the transparent path ──────────────────────────────────────────────────────

  /** [S4] The voice VLAN and network port of a transparent bridge with `voice vlan <v>` stored (the phone), else undefined. */
  private voiceUplink(ctx: ProcessCtx): VoiceUplink | undefined {
    if (isVlanAware(ctx.model)) return undefined;
    const vlan = readVoiceVlan(ctx.config);
    if (vlan === undefined) return undefined;
    for (const view of ctx.ports.values()) {
      if (view.spec.group === 'uplink' && ROLE_TRAITS[roleOf(ctx, view)].bridged) return { vlan, uplink: view.id };
    }
    return undefined;
  }

  /** [S4] A copy of the phone's own frame (sent on its SVI) leaving its network port carries the voice VLAN tag. */
  private tagForVoiceUplink(ctx: ProcessCtx, copy: Pdu, egress: PortId): void {
    const voice = this.voiceUplink(ctx);
    if (voice === undefined || egress !== voice.uplink || frameVlanTag(copy) !== undefined) return;
    ctx.rewrap(copy, vlanPushOp(voice.vlan), phoneVoiceVlanCause(voice.vlan));
  }

  /** [S4] A frame tagged with the voice VLAN on the network port: untagged and handed to the phone's own adapter (never bridged). */
  private onVoiceFrame(ctx: ProcessCtx, pdu: Pdu, port: PortId, voice: VoiceUplink, src: MacAddress, dst: MacAddress): Action[] {
    this.learn(ctx, src, port);
    ctx.rewrap(pdu, vlanPopOp(), phoneVoiceVlanCause(voice.vlan));
    const group = isGroupMac(dst);
    const targets: CopyTarget[] = [];
    for (const view of ctx.ports.values()) {
      if (view.operUp && roleOf(ctx, view) === 'svi' && (group || view.mac === dst)) targets.push({ kind: 'ingress', port: view.id });
    }
    if (targets.length === 0) {
      this.emit(ctx, `dropped frame for ${dst} from ${port}: ${DETAIL_VOICE_NOT_FOR_PHONE} (voice vlan ${voice.vlan})`, { dst, port, pdu: pdu.id, vlan: voice.vlan });
      return [{ type: 'drop', pdu, reason: 'other', detail: DETAIL_VOICE_NOT_FOR_PHONE, port }];
    }
    if (targets.length === 1) {
      this.forwards++;
      this.emit(ctx, `delivering frame for ${dst} from ${port} to ${targets[0]!.port} (voice vlan ${voice.vlan})`, { dst, port, svi: targets[0]!.port, pdu: pdu.id, vlan: voice.vlan });
      return [{ type: 'ingress', port: targets[0]!.port, pdu }];
    }
    return this.fanOut(ctx, pdu, port, dst, targets, `from ${port} (voice vlan ${voice.vlan})`);
  }

  onTimer(ctx: ProcessCtx, key: string): Action[] {
    this.capture(ctx);
    if (key.startsWith(ERRDISABLE_TIMER_PREFIX)) return this.onRecoveryTimer(ctx, key.slice(ERRDISABLE_TIMER_PREFIX.length));
    if (key !== CAM_SWEEP_TIMER) return [];
    const removed = ctx.tables.cam.expire(ctx.now);
    for (const row of removed) {
      this.aged++;
      this.emit(ctx, `aged out ${row.mac} on ${row.port} (vlan ${row.vlan}) after ${this.ageingNs / SEC} s of silence`, {
        mac: row.mac, port: row.port, vlan: row.vlan,
      });
    }
    return [{ type: 'timer', key: CAM_SWEEP_TIMER, delay: CAM_SWEEP_INTERVAL_NS, periodic: true }];
  }

  onConfig(ctx: ProcessCtx, delta?: ConfigDelta): Action[] {
    this.capture(ctx);
    if (delta === undefined || !isVlanAware(ctx.model)) return [];
    return this.onConfigVlanAware(ctx, delta);
  }

  onLinkChange(ctx: ProcessCtx, port: PortId, up: boolean): Action[] {
    this.capture(ctx);
    if (isVlanAware(ctx.model)) return this.onLinkChangeVlanAware(ctx, port, up);
    if (up) return [];
    const rows = ctx.tables.cam.find((r) => r.port === port);
    for (const row of rows) {
      ctx.tables.cam.delete(row.key, 'link-down');
      this.emit(ctx, `removed ${row.mac} on ${row.port} (vlan ${row.vlan}): link down`, {
        mac: row.mac, port: row.port, vlan: row.vlan,
      });
    }
    return [];
  }

  /** @since P2 `l2.changed` and `l2.flush` (§3.0 CAM flush table); VLAN-aware devices only. */
  onEvent(ctx: ProcessCtx, ev: ProcessEvent): Action[] {
    this.capture(ctx);
    if (!isVlanAware(ctx.model)) return [];
    if (ev.kind === 'l2.changed') {
      const port = ev.port;
      const vlan = ev.vlan;
      switch (ev.what) {
        case 'trunk':
          if (port !== undefined) this.flushDynamic(ctx, (r) => r.port === port, `trunk state of ${port} changed`);
          break;
        case 'channel':
          if (port !== undefined) {
            const bundle = ctx.tables.get<EtherchannelRow>('etherchannel')?.get(port)?.bundle;
            this.flushDynamic(ctx, (r) => r.port === port || (bundle !== undefined && r.port === bundle), `channel membership of ${port} changed`);
          }
          break;
        case 'stp':
          if (port !== undefined && vlan !== undefined) {
            const state = ctx.tables.get<StpPortRow>('stp')?.get(stpKey(vlan, port))?.state;
            if (state !== 'forwarding') this.flushDynamic(ctx, (r) => r.vlan === vlan && r.port === port, `${port} left forwarding in vlan ${vlan}`);
          }
          break;
        case 'vlans':
          if (vlan !== undefined && !vlanExistsIn(ctx.tables.get<VlanRow>('vlans'))(vlan)) {
            this.flushDynamic(ctx, (r) => r.vlan === vlan, `vlan ${vlan} was deleted`);
          }
          break;
        case 'security':
          break;
      }
      return [];
    }
    if (ev.kind === 'l2.flush') {
      const ports = ev.ports;
      if (ev.mode === 'flush') {
        this.flushDynamic(ctx, (r) => r.vlan === ev.vlan && ports.includes(r.port), `spanning-tree flush in vlan ${ev.vlan}`);
        return [];
      }
      const ageingNs = ev.ageingNs ?? 0;
      const cap = ctx.now + ageingNs;
      for (const row of ctx.tables.cam.find((r) => r.type === 'dynamic' && r.vlan === ev.vlan && ports.includes(r.port))) {
        if (row.expiresAt !== undefined && row.expiresAt <= cap) continue;
        ctx.tables.cam.set({ ...row, updatedAt: ctx.now, expiresAt: cap });
        this.emit(ctx, `fast ageing ${row.mac} on ${row.port} (vlan ${row.vlan}): expires in ${ageingNs / SEC} s`, {
          mac: row.mac, port: row.port, vlan: row.vlan, ageingNs,
        });
      }
      return [];
    }
    return [];
  }

  stateSnapshot(): StateView {
    return {
      process: ETH_SWITCH_PROCESS,
      state: {
        vlan: DEFAULT_VLAN,
        ageingNs: this.ageingNs,
        entries: this.tables?.cam.size ?? 0,
        floods: this.floods,
        forwards: this.forwards,
        filtered: this.filtered,
        learned: this.learned,
        moved: this.moved,
        aged: this.aged,
      },
    };
  }

  debugEvents(): readonly DebugEvent[] {
    return this.ring.toArray();
  }

  /** Remember the device tables and the model's CAM ageing. */
  private capture(ctx: ProcessCtx): void {
    this.tables = ctx.tables;
    this.ageingNs = ctx.model.ipDefaults?.camAgeingNs ?? CAM_AGEING_NS;
    if (isVlanAware(ctx.model)) {
      const configured = configuredAgeingNs(ctx);
      if (configured !== undefined) this.ageingNs = configured;
    }
  }

  /** The SVI of this device whose MAC is `mac`, if any (first in port order). */
  private sviByMac(ctx: ProcessCtx, mac: MacAddress): PortView | undefined {
    for (const view of ctx.ports.values()) {
      if (view.mac === mac && roleOf(ctx, view) === 'svi') return view;
    }
    return undefined;
  }

  /** Learn or refresh the source address in VLAN 1 (transparent path). */
  private learn(ctx: ProcessCtx, src: MacAddress, port: PortId): void {
    this.learnIn(ctx, DEFAULT_VLAN, src, port);
  }

  /** Learn or refresh the source address in `vlan`. Group sources and static (incl. secure) rows are left alone. */
  private learnIn(ctx: ProcessCtx, vlan: number, src: MacAddress, port: PortId): void {
    if (isGroupMac(src)) return;
    const key = camKey(vlan, src);
    const cam = ctx.tables.cam;
    const previous = cam.get(key);
    if (previous !== undefined && previous.type === 'static') return;
    const row: CamRow = {
      key,
      mac: src,
      vlan,
      port,
      type: 'dynamic',
      updatedAt: ctx.now,
      expiresAt: ctx.now + this.ageingNs,
    };
    cam.set(row);
    if (previous === undefined) {
      this.learned++;
      this.emit(ctx, `learned ${src} on ${port} (vlan ${vlan})`, { mac: src, port, vlan });
    } else if (previous.port !== port) {
      this.moved++;
      this.emit(ctx, `${src} moved from ${previous.port} to ${port} (vlan ${vlan})`, {
        mac: src, from: previous.port, to: port, vlan,
      });
    }
  }

  /** Copy a frame to every forwarding bridged port (except the ingress one unless hairpin) and every up SVI when group. */
  private flood(ctx: ProcessCtx, pdu: Pdu, ingress: PortId, dst: MacAddress, group: boolean): Action[] {
    const targets: CopyTarget[] = [];
    for (const view of ctx.ports.values()) {
      if (!isEgressCandidate(ctx, view, 'ethernet')) continue;
      if (view.id === ingress && !ROLE_TRAITS[roleOf(ctx, view)].hairpin) continue;
      targets.push({ kind: 'send', port: view.id });
    }
    if (group) {
      for (const view of ctx.ports.values()) {
        if (view.operUp && roleOf(ctx, view) === 'svi') targets.push({ kind: 'ingress', port: view.id });
      }
    }
    return this.fanOut(ctx, pdu, ingress, dst, targets, `from ${ingress}`);
  }

  /**
   * Emit one copy per target: the original to the first, clones to the rest; none → drop 'no egress port'. With
   * `normalise` (VLAN-aware path), every clone is allocated first and then each copy is normalised toward its target
   * (§3.0 step 12), so PduIds never depend on tags.
   */
  private fanOut(
    ctx: ProcessCtx,
    pdu: Pdu,
    port: PortId,
    dst: MacAddress,
    targets: readonly CopyTarget[],
    origin: string,
    normalise?: (copy: Pdu, target: CopyTarget) => void,
  ): Action[] {
    const kind = destinationClass(dst, false);
    if (targets.length === 0) {
      this.emit(ctx, `dropped ${kind} frame for ${dst} ${origin}: ${DETAIL_NO_EGRESS}`, {
        dst, port, pdu: pdu.id, kind,
      });
      return [{ type: 'drop', pdu, reason: 'other', detail: DETAIL_NO_EGRESS, port }];
    }
    const actions: Action[] = [];
    const copies: Pdu[] = [];
    for (let i = 0; i < targets.length; i++) copies.push(i === 0 ? pdu : ctx.clone(pdu));
    for (let i = 0; i < targets.length; i++) {
      const t = targets[i]!;
      const copy = copies[i]!;
      if (normalise !== undefined) normalise(copy, t);
      actions.push(t.kind === 'send' ? { type: 'send', port: t.port, pdu: copy } : { type: 'ingress', port: t.port, pdu: copy });
    }
    const names = targets.map((t) => t.port);
    this.floods++;
    this.emit(ctx, `flooding ${kind} frame for ${dst} ${origin} to ${names.length} port(s): ${names.join(', ')}`, {
      dst, port, egress: names, pdu: pdu.id, kind,
    });
    return actions;
  }

  /** Relay a non-Ethernet frame (no MAC addresses, no learning) to every other forwarding bridged port of its framing. */
  private relay(ctx: ProcessCtx, pdu: Pdu, ingress: PortId, outer: string): Action[] {
    const actions: Action[] = [];
    const egress: PortId[] = [];
    for (const view of ctx.ports.values()) {
      if (view.id === ingress || !isEgressCandidate(ctx, view, outer)) continue;
      const copy = actions.length === 0 ? pdu : ctx.clone(pdu);
      actions.push({ type: 'send', port: view.id, pdu: copy });
      egress.push(view.id);
    }
    if (actions.length === 0) {
      this.emit(ctx, `dropped ${outer} frame from ${ingress}: ${DETAIL_NO_EGRESS}`, { port: ingress, pdu: pdu.id, outer });
      return [{ type: 'drop', pdu, reason: 'other', detail: DETAIL_NO_EGRESS, port: ingress }];
    }
    this.forwards++;
    this.emit(ctx, `relaying ${outer} frame from ${ingress} to ${egress.length} port(s): ${egress.join(', ')}`, {
      port: ingress, egress, pdu: pdu.id, outer,
    });
    return actions;
  }

  /** Emit a DebugEvent to the runtime and keep it in the local ring. */
  private emit(ctx: ProcessCtx, message: string, data?: Record<string, unknown>, category: string = ETH_SWITCH_DEBUG_CATEGORY): void {
    ctx.debug(category, message, data);
    const ev: DebugEvent = data === undefined
      ? { at: ctx.now, device: ctx.deviceId, process: ETH_SWITCH_PROCESS, category, message }
      : { at: ctx.now, device: ctx.deviceId, process: ETH_SWITCH_PROCESS, category, message, data };
    this.ring.push(ev);
  }

  // ═══════════════════════════════ VLAN-aware path (ARCHITECTURE-P2 §3.0) ═══════════════════════════════

  /** The per-frame world of a VLAN-aware device. */
  private world(ctx: ProcessCtx): VlanWorld {
    return {
      exists: vlanExistsIn(ctx.tables.get<VlanRow>('vlans')),
      switchports: readAllSwitchports(ctx.config, ctx.model),
      etherchannel: ctx.tables.get<EtherchannelRow>('etherchannel'),
      dtp: ctx.tables.get<DtpRow>('dtp'),
      stpBridge: ctx.tables.get<StpBridgeRow>('stp-bridge'),
      stp: ctx.tables.get<StpPortRow>('stp'),
      controller: isControllerModel(ctx.model),
    };
  }

  /** The switchport configuration of `port` from the per-frame cache (default or controller when absent). */
  private switchportOf(ctx: ProcessCtx, w: VlanWorld, port: PortId): SwitchportConfig {
    return w.switchports.get(port) ?? readSwitchport(ctx.config, port, ctx.model);
  }

  /** The membership view of logical port `port` (§3.0 step 4: `operOf` for a port, the common member mode for a bundle). */
  private l2View(ctx: ProcessCtx, w: VlanWorld, port: PortId, view: PortView | undefined = ctx.ports.get(port)): L2PortView {
    const config = this.switchportOf(ctx, w, port);
    const role = view === undefined ? undefined : roleOf(ctx, view);
    if (role === 'channel') {
      const members = w.etherchannel?.find((r) => r.bundle === port && r.state === 'bundled') ?? [];
      const oper = channelOperOf(config, members.map((m) => w.dtp?.get(m.port)));
      return { port, config, oper, role };
    }
    const oper = operOf(config, w.dtp?.get(port));
    return role === undefined ? { port, config, oper } : { port, config, oper, role };
  }

  /** True for a physical (non-virtual) bridged port of a wireless controller: a distribution port (D17). */
  private isDistributionPort(ctx: ProcessCtx, w: VlanWorld, view: PortView): boolean {
    if (!w.controller) return false;
    const traits = ROLE_TRAITS[roleOf(ctx, view)];
    return traits.bridged && !traits.virtual;
  }

  /** The active distribution port of a controller: the first oper-up distribution port in port order. */
  private activeDistributionPort(ctx: ProcessCtx, w: VlanWorld): PortId | undefined {
    for (const view of ctx.ports.values()) {
      if (view.operUp && this.isDistributionPort(ctx, w, view)) return view.id;
    }
    return undefined;
  }

  /**
   * Is `view` an egress candidate for VLAN `vlan` (§3.0 step 11): oper up, bridged, Ethernet-carrying, not a
   * bundled/waiting/suspended member, carries the VLAN, forwarding in it when spanning tree runs for it, and — on a
   * controller — a distribution port only when it is the active one and the frame did not come from a distribution
   * port (`fromDistribution`).
   */
  private isVlanCandidate(ctx: ProcessCtx, w: VlanWorld, view: PortView, vlan: number, stpRuns: boolean, fromDistribution: boolean): boolean {
    if (!isEgressCandidate(ctx, view, 'ethernet')) return false;
    const member = w.etherchannel?.get(view.id);
    if (member !== undefined && NON_INDIVIDUAL_MEMBER.includes(member.state)) return false;
    if (carries(this.l2View(ctx, w, view.id, view), vlan, w.exists) === undefined) return false;
    if (stpRuns && w.stp?.get(stpKey(vlan, view.id))?.state !== 'forwarding') return false;
    if (this.isDistributionPort(ctx, w, view)) {
      if (fromDistribution) return false;
      if (this.activeDistributionPort(ctx, w) !== view.id) return false;
    }
    return true;
  }

  /**
   * Normalise `copy` toward port target `E` (push / pop / nothing, with the cause line) — §3.0 step 12. `have` is
   * "tagged" iff `layers[1]` is dot1q with a VID other than 0: a priority tag (VID 0) classified the frame as
   * untagged (step 4), so toward a tagged target it is popped and the classified VLAN pushed (two recorded
   * mutations), and toward an untagged target it is popped.
   */
  private normaliseToPort(ctx: ProcessCtx, w: VlanWorld, copy: Pdu, egress: PortId, vlan: number): void {
    const vid = frameVlanTag(copy);
    const norm = normaliseForPort(this.l2View(ctx, w, egress), vlan, vid !== undefined && vid !== 0, w.exists);
    if (norm === undefined) return;
    if (vid === 0) {
      ctx.rewrap(copy, vlanPopOp(), norm.cause);
      if (norm.want === 'tagged') ctx.rewrap(copy, vlanPushOp(vlan), norm.cause);
      return;
    }
    if (norm.change === 'none') return;
    ctx.rewrap(copy, norm.change === 'push' ? vlanPushOp(vlan) : vlanPopOp(), norm.cause);
  }

  /** Normalise `copy` toward the SVI of `vlan`: always untagged (a priority tag is popped too), cause `interface Vlan<V>` (D4). */
  private normaliseToSvi(ctx: ProcessCtx, copy: Pdu, vlan: number): void {
    const vid = frameVlanTag(copy);
    const norm = normaliseForSvi(vlan, vid !== undefined && vid !== 0);
    if (norm.change === 'pop' || vid === 0) ctx.rewrap(copy, vlanPopOp(), norm.cause);
  }

  /** §3.0 steps 1–12 for a frame arriving on physical port `port` of a VLAN-aware device. */
  private onPduVlanAware(ctx: ProcessCtx, pdu: Pdu, port: PortId): Action[] {
    const ingress = ctx.ports.get(port);
    if (ingress !== undefined && !ROLE_TRAITS[roleOf(ctx, ingress)].bridged) {
      this.emit(ctx, `dropped pdu ${pdu.id} from ${port}: ${DETAIL_NOT_BRIDGED}`, { port, pdu: pdu.id });
      return [{ type: 'drop', pdu, reason: 'other', detail: DETAIL_NOT_BRIDGED, port }];
    }
    const outer = pdu.layers[0]?.proto;
    if (outer === 'hdlc') return this.relay(ctx, pdu, port, outer);
    const eth = pdu.layer('ethernet');
    if (eth === undefined) {
      this.emit(ctx, `dropped pdu ${pdu.id} from ${port}: ${DETAIL_NO_ETHERNET}`, { port, pdu: pdu.id });
      return [{ type: 'drop', pdu, reason: 'other', detail: DETAIL_NO_ETHERNET, port }];
    }
    const w = this.world(ctx);

    // 2. physical control dispatch (before member translation)
    const cls = classifyControl(pdu);
    if (cls !== undefined && cls !== 'stp') {
      const act = controlAction(cls, ctx.model);
      if (act.kind === 'deliver') {
        this.emit(ctx, `handing ${cls} frame from ${port} to ${act.to}`, { port, pdu: pdu.id, control: cls, to: act.to });
        return [{ type: 'deliver', to: act.to, pdu, port }];
      }
      if (act.kind === 'drop') {
        this.emit(ctx, `dropped ${cls} frame from ${port}: ${act.detail}`, { port, pdu: pdu.id, control: cls });
        return [{ type: 'drop', pdu, reason: act.reason, detail: act.detail, port }];
      }
    }

    // 3. member translation
    let logical = port;
    const member = w.etherchannel?.get(port);
    if (member !== undefined) {
      if (member.state === 'bundled') {
        logical = member.bundle;
      } else if (member.state === 'waiting' || member.state === 'suspended') {
        const detail = memberNotForwardingDetail(port, member.bundle, member.state);
        this.emit(ctx, `dropped pdu ${pdu.id} from ${port}: ${detail}`, { port, pdu: pdu.id, bundle: member.bundle, state: member.state });
        return [{ type: 'drop', pdu, reason: 'other', detail, port }];
      }
    }
    const lview = ctx.ports.get(logical);

    // 4. classify
    const l2 = this.l2View(ctx, w, logical, lview);
    const cl = classify(l2, frameVlanTag(pdu), w.exists);
    if (!cl.ok) {
      this.emit(ctx, `dropped pdu ${pdu.id} from ${port}: ${cl.detail}`, { port, pdu: pdu.id });
      return [{ type: 'drop', pdu, reason: cl.reason, detail: cl.detail, port }];
    }
    const vlan = cl.vlan;
    const fromDistribution = ingress !== undefined && this.isDistributionPort(ctx, w, ingress);
    if (fromDistribution && this.activeDistributionPort(ctx, w) !== port) {
      const detail = backupDistributionDetail(port);
      this.emit(ctx, `dropped pdu ${pdu.id} from ${port}: ${detail}`, { port, pdu: pdu.id });
      return [{ type: 'drop', pdu, reason: 'other', detail, port }];
    }

    // 5. logical control dispatch (spanning tree)
    const stpRuns = w.stpBridge?.has(vlanKey(vlan)) ?? false;
    if (cls === 'stp') {
      const act = controlAction('stp', ctx.model, stpRuns);
      if (act.kind === 'deliver') {
        this.emit(ctx, `handing spanning-tree frame from ${logical} (vlan ${vlan}) to ${act.to}`, { port: logical, pdu: pdu.id, vlan, to: act.to });
        return [{ type: 'deliver', to: act.to, pdu, port: logical }];
      }
      if (act.kind === 'drop') {
        this.emit(ctx, `dropped spanning-tree frame from ${port}: ${act.detail}`, { port, pdu: pdu.id });
        return [{ type: 'drop', pdu, reason: act.reason, detail: act.detail, port }];
      }
    }

    // 6. spanning-tree gate
    let learnOnly = false;
    if (stpRuns) {
      const state = w.stp?.get(stpKey(vlan, logical))?.state;
      if (state === 'learning') {
        learnOnly = true;
      } else if (state !== 'forwarding') {
        const detail = state ?? DETAIL_NOT_STP_PORT;
        this.emit(ctx, `dropped pdu ${pdu.id} from ${logical} (vlan ${vlan}): spanning tree is ${detail}`, { port: logical, pdu: pdu.id, vlan, state: detail });
        return [{ type: 'drop', pdu, reason: 'stp-discarding', detail, port }];
      }
    }

    const src = eth.fields.src as MacAddress;
    const dst = eth.fields.dst as MacAddress;

    // 7. port security
    const prefix: Action[] = [];
    const psec = this.portSecurityCheck(ctx, pdu, logical, port, vlan, src);
    if (psec !== undefined) {
      if (psec.stop) return psec.actions;
      prefix.push(...psec.actions);
    }

    // 8. learn
    this.learnIn(ctx, vlan, src, logical);
    if (learnOnly) {
      this.emit(ctx, `dropped pdu ${pdu.id} from ${logical} (vlan ${vlan}): spanning tree is ${DETAIL_STP_LEARNING}`, { port: logical, pdu: pdu.id, vlan, state: DETAIL_STP_LEARNING });
      return [...prefix, { type: 'drop', pdu, reason: 'stp-discarding', detail: DETAIL_STP_LEARNING, port }];
    }

    // 9. SVI
    const group = isGroupMac(dst);
    if (!group) {
      const svi = ctx.ports.get(sviName(vlan));
      if (svi !== undefined && roleOf(ctx, svi) === 'svi' && (svi.mac === dst || (svi.l3.virtual4 ?? []).some((v) => v.mac === dst))) {
        if (!svi.operUp) {
          const detail = `${svi.id} ${DETAIL_SVI_DOWN_SUFFIX}`;
          this.emit(ctx, `dropped frame for ${dst} from ${logical}: ${detail}`, { dst, port: logical, svi: svi.id, pdu: pdu.id });
          return [...prefix, { type: 'drop', pdu, reason: 'other', detail, port }];
        }
        this.forwards++;
        this.emit(ctx, `delivering frame for ${dst} from ${logical} to ${svi.id} (vlan ${vlan})`, {
          dst, port: logical, svi: svi.id, pdu: pdu.id,
        });
        this.normaliseToSvi(ctx, pdu, vlan);
        return [...prefix, { type: 'ingress', port: svi.id, pdu }];
      }
    }

    // 10. forward
    const row = group ? undefined : ctx.tables.cam.get(camKey(vlan, dst));
    if (row === undefined) return [...prefix, ...this.floodVlan(ctx, w, pdu, logical, dst, group, vlan, stpRuns, fromDistribution)];

    if (row.port === logical) {
      const hairpin = lview !== undefined && ROLE_TRAITS[roleOf(ctx, lview)].hairpin;
      if (!hairpin) {
        this.filtered++;
        this.emit(ctx, `filtered frame for ${dst} from ${logical}: ${DETAIL_FILTERED} (vlan ${vlan})`, {
          dst, port: logical, pdu: pdu.id,
        });
        return [...prefix, { type: 'drop', pdu, reason: 'other', detail: DETAIL_FILTERED, port }];
      }
      if (lview === undefined || !this.isVlanCandidate(ctx, w, lview, vlan, stpRuns, fromDistribution)) {
        this.emit(ctx, `dropped frame for ${dst} from ${logical}: ${DETAIL_NO_EGRESS} (${logical} is not forwarding)`, {
          dst, port: logical, egress: logical, pdu: pdu.id,
        });
        return [...prefix, { type: 'drop', pdu, reason: 'other', detail: DETAIL_NO_EGRESS, port }];
      }
      this.forwards++;
      this.emit(ctx, `forwarding frame for ${dst} back out ${logical} (same radio, vlan ${vlan})`, {
        dst, port: logical, egress: logical, pdu: pdu.id,
      });
      this.normaliseToPort(ctx, w, pdu, logical, vlan);
      return [...prefix, { type: 'send', port: logical, pdu }];
    }

    const egress = ctx.ports.get(row.port);
    if (egress === undefined || !this.isVlanCandidate(ctx, w, egress, vlan, stpRuns, fromDistribution)) {
      this.emit(ctx, `dropped frame for ${dst} from ${logical}: ${DETAIL_NO_EGRESS} (${row.port} is not forwarding)`, {
        dst, port: logical, egress: row.port, pdu: pdu.id,
      });
      return [...prefix, { type: 'drop', pdu, reason: 'other', detail: DETAIL_NO_EGRESS, port }];
    }

    this.forwards++;
    this.emit(ctx, `forwarding frame for ${dst} from ${logical} out ${row.port} (vlan ${vlan})`, {
      dst, port: logical, egress: row.port, pdu: pdu.id,
    });
    this.normaliseToPort(ctx, w, pdu, row.port, vlan);
    return [...prefix, { type: 'send', port: row.port, pdu }];
  }

  /** §3.0 steps 11–12: flood in `vlan` from logical port `ingress` (an SVI ingress clone for a group frame). */
  private floodVlan(
    ctx: ProcessCtx,
    w: VlanWorld,
    pdu: Pdu,
    ingress: PortId,
    dst: MacAddress,
    group: boolean,
    vlan: number,
    stpRuns: boolean,
    fromDistribution: boolean,
  ): Action[] {
    const targets: CopyTarget[] = [];
    for (const view of ctx.ports.values()) {
      if (!this.isVlanCandidate(ctx, w, view, vlan, stpRuns, fromDistribution)) continue;
      if (view.id === ingress && !ROLE_TRAITS[roleOf(ctx, view)].hairpin) continue;
      targets.push({ kind: 'send', port: view.id });
    }
    if (group) {
      const svi = ctx.ports.get(sviName(vlan));
      if (svi !== undefined && svi.operUp && roleOf(ctx, svi) === 'svi') targets.push({ kind: 'ingress', port: svi.id });
    }
    return this.fanOut(ctx, pdu, ingress, dst, targets, `from ${ingress}`, (copy, t) => {
      if (t.kind === 'ingress') this.normaliseToSvi(ctx, copy, vlan);
      else this.normaliseToPort(ctx, w, copy, t.port, vlan);
    });
  }

  /** §3.0 `onEgress(ctx, pdu, 'Vlan<V>')`: the frame leaves the SVI untagged, confined to V, every copy normalised. */
  private onEgressVlanAware(ctx: ProcessCtx, pdu: Pdu, port: PortId): Action[] {
    const eth = pdu.layer('ethernet');
    if (eth === undefined) {
      this.emit(ctx, `dropped pdu ${pdu.id} sent on ${port}: ${DETAIL_NO_ETHERNET}`, { port, pdu: pdu.id });
      return [{ type: 'drop', pdu, reason: 'other', detail: DETAIL_NO_ETHERNET, port }];
    }
    const vlan = vlanOfSviName(port);
    if (vlan === undefined) {
      this.emit(ctx, `dropped pdu ${pdu.id} sent on ${port}: ${DETAIL_NO_VLAN}`, { port, pdu: pdu.id });
      return [{ type: 'drop', pdu, reason: 'other', detail: DETAIL_NO_VLAN, port }];
    }
    const w = this.world(ctx);
    const stpRuns = w.stpBridge?.has(vlanKey(vlan)) ?? false;
    const dst = eth.fields.dst as MacAddress;
    const group = isGroupMac(dst);
    const row = group ? undefined : ctx.tables.cam.get(camKey(vlan, dst));
    if (row !== undefined) {
      const egress = ctx.ports.get(row.port);
      if (egress === undefined || !this.isVlanCandidate(ctx, w, egress, vlan, stpRuns, false)) {
        this.emit(ctx, `dropped frame for ${dst} from ${port}: ${DETAIL_NO_EGRESS} (${row.port} is not forwarding)`, {
          dst, port, egress: row.port, pdu: pdu.id,
        });
        return [{ type: 'drop', pdu, reason: 'other', detail: DETAIL_NO_EGRESS, port }];
      }
      this.forwards++;
      this.emit(ctx, `bridging frame for ${dst} from ${port} out ${row.port} (vlan ${vlan})`, {
        dst, port, egress: row.port, pdu: pdu.id,
      });
      this.normaliseToPort(ctx, w, pdu, row.port, vlan);
      return [{ type: 'send', port: row.port, pdu }];
    }
    const targets: CopyTarget[] = [];
    for (const view of ctx.ports.values()) {
      if (this.isVlanCandidate(ctx, w, view, vlan, stpRuns, false)) targets.push({ kind: 'send', port: view.id });
    }
    return this.fanOut(ctx, pdu, port, dst, targets, `from ${port}`, (copy, t) => this.normaliseToPort(ctx, w, copy, t.port, vlan));
  }

  // ─────────────────────────────── CAM flushes and derived rows ───────────────────────────────

  /** Delete every DYNAMIC row matching `pred` (reason 'cleared'), with one debug line per row. Never a secure row. */
  private flushDynamic(ctx: ProcessCtx, pred: (r: CamRow) => boolean, why: string): void {
    for (const row of ctx.tables.cam.find((r) => r.type === 'dynamic' && r.secure === undefined && pred(r))) {
      ctx.tables.cam.delete(row.key, 'cleared');
      this.emit(ctx, `removed ${row.mac} on ${row.port} (vlan ${row.vlan}): ${why}`, { mac: row.mac, port: row.port, vlan: row.vlan });
    }
  }

  /** The VLAN-aware `onConfig`: membership flushes, derived secure and static rows, recovery timers (§3.0, §3.8, §5.1). */
  private onConfigVlanAware(ctx: ProcessCtx, delta: ConfigDelta): Action[] {
    const line = delta.line;
    const port = interfaceOfContext(delta.context);
    if (port !== undefined) {
      if (isMembershipLine(line)) {
        this.flushDynamic(ctx, (r) => r.port === port, `${line.join(' ')} changed on ${port}`);
        this.rekeySecureRows(ctx, port);
      }
      if (isPortSecurityLine(line)) return this.syncPortSecurity(ctx, port);
      return [];
    }
    if (delta.context.length !== 0) return [];
    if (line[0] === 'mac' && line[1] === 'address-table') {
      if (line[2] === 'static') this.syncStaticRows(ctx);
      return [];
    }
    if (line[0] === 'errdisable' && line[1] === 'recovery') return this.syncRecoveryTimers(ctx);
    return [];
  }

  /** The VLAN-aware `onLinkChange`: link-down flushes dynamic rows (dynamic secure rows included); the psec row follows. */
  private onLinkChangeVlanAware(ctx: ProcessCtx, port: PortId, up: boolean): Action[] {
    if (!up) {
      const rows = ctx.tables.cam.find((r) => r.port === port && (r.type === 'dynamic' || r.secure === 'dynamic'));
      for (const row of rows) {
        ctx.tables.cam.delete(row.key, 'link-down');
        this.emit(ctx, `removed ${row.mac} on ${row.port} (vlan ${row.vlan}): link down`, {
          mac: row.mac, port: row.port, vlan: row.vlan,
        });
      }
    }
    this.refreshPortSecurityRow(ctx, port, up);
    return [];
  }

  /** Secure CAM rows of `port` (configured, sticky and dynamic secure). */
  private secureRowsOf(ctx: ProcessCtx, port: PortId): CamRow[] {
    return ctx.tables.cam.find((r) => r.port === port && r.secure !== undefined);
  }

  /** Move the configured and sticky rows of `port` to its current access VLAN and drop its dynamic secure rows (a membership change). */
  private rekeySecureRows(ctx: ProcessCtx, port: PortId): void {
    const rows = this.secureRowsOf(ctx, port);
    if (rows.length === 0) return;
    const vlan = readSwitchport(ctx.config, port, ctx.model).accessVlan;
    for (const row of rows) {
      if (row.secure === 'dynamic') {
        ctx.tables.cam.delete(row.key, 'cleared');
        this.emit(ctx, `removed secure address ${row.mac} on ${port} (vlan ${row.vlan}): the port's VLAN changed`, { mac: row.mac, port, vlan: row.vlan }, PORT_SECURITY_DEBUG_CATEGORY);
      } else if (row.vlan !== vlan) {
        ctx.tables.cam.delete(row.key, 'replaced');
        ctx.tables.cam.set({ key: camKey(vlan, row.mac), mac: row.mac, vlan, port, type: 'static', secure: row.secure, updatedAt: ctx.now });
        this.emit(ctx, `moved secure address ${row.mac} on ${port} from vlan ${row.vlan} to vlan ${vlan}`, { mac: row.mac, port, from: row.vlan, to: vlan }, PORT_SECURITY_DEBUG_CATEGORY);
      }
    }
    this.refreshPortSecurityRow(ctx, port);
  }

  /**
   * Derive the `port-security` row and the configured/sticky secure CAM rows of `port` from the running config,
   * idempotently (§3.8 step 2): an address already secure on the port changes nothing; a line for a new address
   * installs its row; a removed line removes its row; the enabling line gone removes everything of the port.
   */
  private syncPortSecurity(ctx: ProcessCtx, port: PortId): Action[] {
    const table = ctx.tables.get<PortSecurityRow>('port-security');
    if (table === undefined) return [];
    const cfg = readPortSecurity(ctx.config, port);
    const prev = table.get(port);
    const cam = ctx.tables.cam;
    if (cfg === undefined) {
      if (prev === undefined) return [];
      for (const row of this.secureRowsOf(ctx, port)) {
        cam.delete(row.key, 'cleared');
        this.emit(ctx, `removed secure address ${row.mac} on ${port} (vlan ${row.vlan}): port security switched off`, { mac: row.mac, port, vlan: row.vlan }, PORT_SECURITY_DEBUG_CATEGORY);
      }
      table.delete(port, 'cleared');
      this.emit(ctx, `port security switched off on ${port}`, { port }, PORT_SECURITY_DEBUG_CATEGORY);
      return this.recoveryFor(ctx, port, false);
    }
    const desired = configuredSecureAddresses(cfg);
    const vlan = readSwitchport(ctx.config, port, ctx.model).accessVlan;
    const current = this.secureRowsOf(ctx, port);
    for (const row of current) {
      if (row.secure === 'dynamic' || desired.some((d) => d.mac === row.mac)) continue;
      cam.delete(row.key, 'cleared');
      this.emit(ctx, `removed ${row.secure} secure address ${row.mac} on ${port} (vlan ${row.vlan}): its line is gone`, { mac: row.mac, port, vlan: row.vlan }, PORT_SECURITY_DEBUG_CATEGORY);
    }
    for (const d of desired) {
      const have = current.find((r) => r.mac === d.mac);
      if (have !== undefined) {
        if (have.secure !== d.secure) cam.set({ ...have, secure: d.secure, updatedAt: ctx.now });
        continue;
      }
      cam.set({ key: camKey(vlan, d.mac), mac: d.mac, vlan, port, type: 'static', secure: d.secure, updatedAt: ctx.now });
      this.emit(ctx, `secured ${d.mac} on ${port} (vlan ${vlan}, ${d.secure})`, { mac: d.mac, port, vlan, secure: d.secure }, PORT_SECURITY_DEBUG_CATEGORY);
    }
    // Sticky learning switched on also pins the addresses the port already learned dynamically, and writes their
    // sticky lines, as a real switch does (§3.8 step 2; W5 fix). The line comes back through onConfig as a no-op.
    const stickyLines: Action[] = [];
    if (cfg.sticky) {
      for (const row of current) {
        if (row.secure !== 'dynamic' || cam.get(row.key) === undefined) continue;
        cam.set({ ...row, secure: 'sticky', updatedAt: ctx.now });
        this.emit(ctx, `made ${row.mac} on ${port} sticky (vlan ${row.vlan}): sticky learning is on`, { mac: row.mac, port, vlan: row.vlan, secure: 'sticky' }, PORT_SECURITY_DEBUG_CATEGORY);
        stickyLines.push(stickyConfigLine(port, row.mac));
      }
    }
    const view = ctx.ports.get(port);
    const status = prev?.status ?? portSecurityStatus(view?.operUp ?? false, view?.errDisabled);
    const next: PortSecurityRow = { ...portSecurityRow(port, cfg, ctx.now, prev, status), count: this.secureRowsOf(ctx, port).length };
    if (prev === undefined) {
      table.set(next);
      this.emit(ctx, `port security enabled on ${port}: maximum ${next.max}, violation ${next.violation}${next.sticky ? ', sticky learning' : ''}`, {
        port, max: next.max, violation: next.violation, sticky: next.sticky,
      }, PORT_SECURITY_DEBUG_CATEGORY);
    } else if (!samePortSecurityRow(prev, next)) {
      table.set(next);
    }
    return stickyLines;
  }

  /**
   * Recompute `status` and `count` of the `port-security` row of `port` (link changes, re-keys), if it has one. `up`
   * is the link state the runtime reports (trusted over the port view during a bounce); absent = the view's.
   */
  private refreshPortSecurityRow(ctx: ProcessCtx, port: PortId, up?: boolean): void {
    const table = ctx.tables.get<PortSecurityRow>('port-security');
    const prev = table?.get(port);
    if (table === undefined || prev === undefined) return;
    const view = ctx.ports.get(port);
    const operUp = up ?? view?.operUp ?? false;
    const status = portSecurityStatus(operUp, view?.errDisabled);
    const next: PortSecurityRow = { ...prev, status, count: this.secureRowsOf(ctx, port).length, updatedAt: ctx.now };
    if (samePortSecurityRow(prev, next)) return;
    table.set(next);
    if (prev.status !== status) {
      ctx.transition(PORT_SECURITY_DEBUG_CATEGORY, `${port} port security ${prev.status} -> ${status}`, {
        machine: 'port-security', subject: port, port, from: prev.status, to: status, cause: operUp ? 'link up' : 'link down',
      });
    }
  }

  /** Derive the configured static rows (`mac address-table static <mac> vlan <v> interface <if>`) from the running config. */
  private syncStaticRows(ctx: ProcessCtx): void {
    const desired = readStaticMacLines(ctx);
    const cam = ctx.tables.cam;
    for (const row of cam.find((r) => r.type === 'static' && r.secure === undefined)) {
      if (desired.some((d) => d.key === row.key && d.port === row.port)) continue;
      cam.delete(row.key, 'cleared');
      this.emit(ctx, `removed static ${row.mac} on ${row.port} (vlan ${row.vlan}): its line is gone`, { mac: row.mac, port: row.port, vlan: row.vlan });
    }
    for (const d of desired) {
      const have = cam.get(d.key);
      if (have !== undefined && have.type === 'static' && have.port === d.port) continue;
      cam.set({ key: d.key, mac: d.mac, vlan: d.vlan, port: d.port, type: 'static', updatedAt: ctx.now });
      this.emit(ctx, `static ${d.mac} on ${d.port} (vlan ${d.vlan})`, { mac: d.mac, port: d.port, vlan: d.vlan });
    }
  }

  // ─────────────────────────────── port security (§3.8) ───────────────────────────────

  /**
   * §3.0 step 7 for a frame from `src` on logical port `port` (arrival port `physical`) in `vlan`. Undefined when no
   * `port-security` row exists for the port or the source is a group address; otherwise the actions to prepend
   * (`stop` false: a sticky line, the frame continues) or to return (`stop` true: the violation drop and its effects).
   */
  private portSecurityCheck(ctx: ProcessCtx, pdu: Pdu, port: PortId, physical: PortId, vlan: number, src: MacAddress): { actions: Action[]; stop: boolean } | undefined {
    const table = ctx.tables.get<PortSecurityRow>('port-security');
    const row = table?.get(port);
    if (table === undefined || row === undefined || isGroupMac(src)) return undefined;
    const cfg = readPortSecurity(ctx.config, port);
    if (cfg === undefined) return undefined;
    const cam = ctx.tables.cam;
    const existing = cam.get(camKey(vlan, src));
    const securedOn = existing?.secure !== undefined ? existing.port : undefined;
    const check = securedOn === undefined
      ? { port, config: cfg, src, count: this.secureRowsOf(ctx, port).length }
      : { port, config: cfg, src, securedOn, count: this.secureRowsOf(ctx, port).length };
    const verdict = decidePortSecurity(check);
    if (verdict.kind === 'allow') return undefined;
    if (verdict.kind === 'learn') {
      cam.set({ key: camKey(vlan, src), mac: src, vlan, port, type: 'static', secure: verdict.secure, updatedAt: ctx.now });
      table.set(applyPortSecurityVerdict(row, verdict, src, ctx.now));
      this.emit(ctx, `secured ${src} on ${port} (vlan ${vlan}, ${verdict.secure})`, { mac: src, port, vlan, secure: verdict.secure, pdu: pdu.id }, PORT_SECURITY_DEBUG_CATEGORY);
      return { actions: verdict.secure === 'sticky' ? [stickyConfigLine(port, src)] : [], stop: false };
    }
    const next = applyPortSecurityVerdict(row, verdict, src, ctx.now);
    if (next !== row) table.set(next);
    this.emit(ctx, `violation on ${port}: ${verdict.detail}`, { mac: src, port, vlan, mode: verdict.mode, pdu: pdu.id }, PORT_SECURITY_DEBUG_CATEGORY);
    const actions: Action[] = [{ type: 'drop', pdu, reason: 'port-security', detail: verdict.detail, port: physical }];
    if (verdict.log !== undefined) actions.push({ type: 'log', severity: verdict.log.severity, facility: PORT_SECURITY_LOG_FACILITY, message: verdict.log.message });
    if (verdict.errDisable !== undefined) {
      if (row.status !== next.status) {
        ctx.transition(PORT_SECURITY_DEBUG_CATEGORY, `${port} port security ${row.status} -> ${next.status}`, {
          machine: 'port-security', subject: port, port, from: row.status, to: next.status, cause: 'violation', pdu: pdu.id,
        });
      }
      actions.push({ type: 'errDisable', port, cause: verdict.errDisable.cause, detail: verdict.errDisable.detail });
      actions.push(...this.recoveryFor(ctx, port, true));
    }
    return { actions, stop: true };
  }

  /** Arm (`wanted`) or cancel the recovery timer of `port` for `psecure-violation`, per the `errdisable recovery` lines. */
  private recoveryFor(ctx: ProcessCtx, port: PortId, wanted: boolean): Action[] {
    const rec = errdisableRecovery(ctx.config, 'psecure-violation');
    const armed = this.recoveryArmed.has(port);
    if (wanted && rec.enabled) {
      this.recoveryArmed.add(port);
      this.emit(ctx, `${port} recovers from err-disable in ${rec.intervalNs / SEC} s`, { port, intervalNs: rec.intervalNs }, PORT_SECURITY_DEBUG_CATEGORY);
      return [{ type: 'timer', key: errdisableTimerKey(port), delay: rec.intervalNs, periodic: true }];
    }
    if (armed) {
      this.recoveryArmed.delete(port);
      return [{ type: 'cancelTimer', key: errdisableTimerKey(port) }];
    }
    return [];
  }

  /** After an `errdisable recovery …` line: arm the timer of every psecure-err-disabled port, or cancel every armed one. */
  private syncRecoveryTimers(ctx: ProcessCtx): Action[] {
    const rec = errdisableRecovery(ctx.config, 'psecure-violation');
    const actions: Action[] = [];
    for (const view of ctx.ports.values()) {
      const disabled = view.errDisabled === 'psecure-violation';
      if (disabled && rec.enabled && !this.recoveryArmed.has(view.id)) actions.push(...this.recoveryFor(ctx, view.id, true));
      else if ((!disabled || !rec.enabled) && this.recoveryArmed.has(view.id)) actions.push(...this.recoveryFor(ctx, view.id, false));
    }
    return actions;
  }

  /** The `errdisable:<port>` timer fired: recover the port when it is still err-disabled for a violation. */
  private onRecoveryTimer(ctx: ProcessCtx, port: PortId): Action[] {
    this.recoveryArmed.delete(port);
    const view = ctx.ports.get(port);
    if (view === undefined || view.errDisabled !== 'psecure-violation') return [];
    this.emit(ctx, `recovering ${port} from err-disable`, { port }, PORT_SECURITY_DEBUG_CATEGORY);
    return [{ type: 'errRecover', port, cause: 'psecure-violation' }];
  }
}

/** True when two `port-security` rows differ only in `updatedAt` (no write needed). */
function samePortSecurityRow(a: PortSecurityRow, b: PortSecurityRow): boolean {
  return a.max === b.max && a.count === b.count && a.violation === b.violation && a.sticky === b.sticky
    && a.violations === b.violations && a.status === b.status && a.lastViolationMac === b.lastViolationMac;
}

/** One configured static row. */
interface StaticMacLine {
  readonly key: string;
  readonly mac: MacAddress;
  readonly vlan: number;
  readonly port: PortId;
}

/** The `mac address-table static <mac> vlan <v> interface <if>` lines of the running config (invalid lines ignored). */
function readStaticMacLines(ctx: ProcessCtx): StaticMacLine[] {
  const out: StaticMacLine[] = [];
  for (const c of ctx.config.root.children) {
    if (c.key !== 'mac' || c.args[0] !== 'address-table' || c.args[1] !== 'static') continue;
    const [, , macText, vlanWord, vlanText, ifWord, port] = c.args;
    if (vlanWord !== 'vlan' || ifWord !== 'interface' || macText === undefined || vlanText === undefined || port === undefined) continue;
    const mac = macText.toLowerCase();
    if (!/^[0-9a-f]{2}(?::[0-9a-f]{2}){5}$/.test(mac) || !/^\d{1,4}$/.test(vlanText)) continue;
    const vlan = Number(vlanText);
    if (vlan < 1 || vlan > 4094 || !ctx.ports.has(port)) continue;
    if (out.some((s) => s.key === camKey(vlan, mac))) continue;
    out.push({ key: camKey(vlan, mac), mac, vlan, port });
  }
  return out;
}

/** `mac address-table aging-time <s>` of the running config in SimTime (10–1 000 000 s), else undefined. */
function configuredAgeingNs(ctx: ProcessCtx): SimTime | undefined {
  for (const c of ctx.config.root.children) {
    if (c.key !== 'mac' || c.args[0] !== 'address-table' || c.args[1] !== 'aging-time' || c.args.length !== 3) continue;
    const text = c.args[2] as string;
    if (!/^\d{1,7}$/.test(text)) continue;
    const s = Number(text);
    if (s >= 10 && s <= 1_000_000) return s * SEC;
  }
  return undefined;
}

/**
 * Create the bridging daemon (`name: 'eth-switch'`, `handles: ETH_SWITCH_HANDLES`). One instance per bridging device;
 * the device runtime calls `init` at boot and `onEgress` for sends on the SVIs it owns.
 */
export function createEthSwitch(): Process {
  return new EthSwitch();
}
