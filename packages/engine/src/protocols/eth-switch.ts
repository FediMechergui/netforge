/**
 * protocols/eth-switch.ts — the transparent bridging daemon (switches, multilayer switches, access points, home
 * routers, radio bridges, cell towers, modems and ISP clouds).
 *
 * Implements spec §2.1 "MAC addressing & switching" (CAM table with ageing timers, flooding, unicast/broadcast/
 * multicast handling), §4.8 (process model: actions out, `stateSnapshot()` is the only UI truth, every transition
 * emits a DebugEvent), §9.4 (MAC table visualizer) and ARCHITECTURE-P1 D3/§3.10 (per-port roles, SVIs, hairpin).
 *
 * Bridge membership is a ROLE trait, never a device kind: a port belongs to the bridge when
 * `ROLE_TRAITS[role].bridged` (switched, wireless-bss, radio-ptp, access-line). The effective role is
 * `PortView.role`, else the spec default for the model capabilities.
 *
 * Behaviour (VLAN 1 only):
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
 *  • CONFIG  — ignored (no switch-specific configuration in P0.5).
 *
 * `stateSnapshot()` (stable shape):
 *   { process: 'eth-switch', state: { vlan: 1, ageingNs, entries, floods, forwards, filtered, learned, moved, aged } }
 * `entries` is the live CAM size. SVI deliveries, hairpin sends, SVI egress and relays count as `forwards` or
 * `floods`.
 *
 * Debug category: 'ethernet switching' (matches `debug ethernet switching`).
 */
import { MAC_BROADCAST } from '../contracts/addr.js';
import type { MacAddress } from '../contracts/addr.js';
import { BRIDGED_ROLES, KIND_ENCAP, ROLE_TRAITS, defaultRoleFor } from '../contracts/catalog.js';
import type { PortEncap, PortRole } from '../contracts/catalog.js';
import type { PortId } from '../contracts/ids.js';
import type { Pdu } from '../contracts/pdu.js';
import type { PortView } from '../contracts/port.js';
import type { Action, DebugEvent, DemuxSelector, Process, ProcessCtx, StateView } from '../contracts/process.js';
import { CAM_AGEING_NS, camKey } from '../contracts/tables.js';
import type { CamRow, DeviceTables } from '../contracts/tables.js';
import { SEC } from '../contracts/time.js';
import type { SimTime } from '../contracts/time.js';

/** Process name registered by the catalog for bridging models. */
export const ETH_SWITCH_PROCESS = 'eth-switch';
/** Debug category emitted by this daemon (`debug ethernet switching`). */
export const ETH_SWITCH_DEBUG_CATEGORY = 'ethernet switching';
/** Timer key of the periodic CAM ageing sweep. */
export const CAM_SWEEP_TIMER = 'cam-sweep';
/** Interval between CAM ageing sweeps (15 s). Rows expire on the first sweep at or after `expiresAt`. */
export const CAM_SWEEP_INTERVAL_NS: SimTime = 15 * SEC;
/** The only VLAN in P0.5. */
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

  init(ctx: ProcessCtx): Action[] {
    this.capture(ctx);
    this.emit(ctx, `ageing sweep armed every ${CAM_SWEEP_INTERVAL_NS / SEC} s, entries age out after ${this.ageingNs / SEC} s`, {
      sweepNs: CAM_SWEEP_INTERVAL_NS, ageingNs: this.ageingNs,
    });
    return [{ type: 'timer', key: CAM_SWEEP_TIMER, delay: CAM_SWEEP_INTERVAL_NS, periodic: true }];
  }

  onPdu(ctx: ProcessCtx, pdu: Pdu, port: PortId): Action[] {
    this.capture(ctx);
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
   * destination → the member port, else flood to every oper-up Ethernet-carrying bridged port.
   */
  onEgress(ctx: ProcessCtx, pdu: Pdu, port: PortId): Action[] {
    this.capture(ctx);
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
      return [{ type: 'send', port: row.port, pdu }];
    }
    const targets: CopyTarget[] = [];
    for (const view of ctx.ports.values()) {
      if (isEgressCandidate(ctx, view, 'ethernet')) targets.push({ kind: 'send', port: view.id });
    }
    return this.fanOut(ctx, pdu, port, dst, targets, `from ${port}`);
  }

  onTimer(ctx: ProcessCtx, key: string): Action[] {
    this.capture(ctx);
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

  onConfig(ctx: ProcessCtx): Action[] {
    this.capture(ctx);
    return [];
  }

  onLinkChange(ctx: ProcessCtx, port: PortId, up: boolean): Action[] {
    this.capture(ctx);
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
  }

  /** The SVI of this device whose MAC is `mac`, if any (first in port order). */
  private sviByMac(ctx: ProcessCtx, mac: MacAddress): PortView | undefined {
    for (const view of ctx.ports.values()) {
      if (view.mac === mac && roleOf(ctx, view) === 'svi') return view;
    }
    return undefined;
  }

  /** Learn or refresh the source address. Group sources and static rows are left alone. */
  private learn(ctx: ProcessCtx, src: MacAddress, port: PortId): void {
    if (isGroupMac(src)) return;
    const key = camKey(DEFAULT_VLAN, src);
    const cam = ctx.tables.cam;
    const previous = cam.get(key);
    if (previous !== undefined && previous.type === 'static') return;
    const row: CamRow = {
      key,
      mac: src,
      vlan: DEFAULT_VLAN,
      port,
      type: 'dynamic',
      updatedAt: ctx.now,
      expiresAt: ctx.now + this.ageingNs,
    };
    cam.set(row);
    if (previous === undefined) {
      this.learned++;
      this.emit(ctx, `learned ${src} on ${port} (vlan ${DEFAULT_VLAN})`, { mac: src, port, vlan: DEFAULT_VLAN });
    } else if (previous.port !== port) {
      this.moved++;
      this.emit(ctx, `${src} moved from ${previous.port} to ${port} (vlan ${DEFAULT_VLAN})`, {
        mac: src, from: previous.port, to: port, vlan: DEFAULT_VLAN,
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

  /** Emit one copy per target: the original to the first, clones to the rest; none → drop 'no egress port'. */
  private fanOut(ctx: ProcessCtx, pdu: Pdu, port: PortId, dst: MacAddress, targets: readonly CopyTarget[], origin: string): Action[] {
    const kind = destinationClass(dst, false);
    if (targets.length === 0) {
      this.emit(ctx, `dropped ${kind} frame for ${dst} ${origin}: ${DETAIL_NO_EGRESS}`, {
        dst, port, pdu: pdu.id, kind,
      });
      return [{ type: 'drop', pdu, reason: 'other', detail: DETAIL_NO_EGRESS, port }];
    }
    const actions: Action[] = [];
    for (let i = 0; i < targets.length; i++) {
      const t = targets[i]!;
      const copy = i === 0 ? pdu : ctx.clone(pdu);
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
  private emit(ctx: ProcessCtx, message: string, data?: Record<string, unknown>): void {
    ctx.debug(ETH_SWITCH_DEBUG_CATEGORY, message, data);
    const ev: DebugEvent = data === undefined
      ? { at: ctx.now, device: ctx.deviceId, process: ETH_SWITCH_PROCESS, category: ETH_SWITCH_DEBUG_CATEGORY, message }
      : { at: ctx.now, device: ctx.deviceId, process: ETH_SWITCH_PROCESS, category: ETH_SWITCH_DEBUG_CATEGORY, message, data };
    this.ring.push(ev);
  }
}

/**
 * Create the transparent-bridging daemon (`name: 'eth-switch'`, `handles: ETH_SWITCH_HANDLES`). One instance per
 * bridging device; the device runtime calls `init` at boot and `onEgress` for sends on the SVIs it owns.
 */
export function createEthSwitch(): Process {
  return new EthSwitch();
}
