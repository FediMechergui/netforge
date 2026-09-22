/**
 * protocols/hsrp.ts — first-hop redundancy: HSRP versions 1 and 2 [SHOULD S2] (RFC 2281 as a state model;
 * ARCHITECTURE-P2 D8, D15, §2.4, §3.10, §4.2, §5.2). Protocol names, port, groups and virtual MAC prefixes are
 * protocol facts (D8); everything on the wire is the NF codec of pdu/codecs/hsrp.ts.
 *
 * Silent unless an interface carries `standby [<g>] ip [<a>]` AND is operationally up with an IPv4 address (§4.3).
 * Lines (interface context; the group-less form is group 0): `standby version 1|2` (default 1), `standby [g] ip [a]`,
 * `standby [g] priority <n>` (default 100), `standby [g] preempt [delay minimum <s>]`, `standby [g] timers <hello>
 * <hold>` (seconds; default 3 and 10). One `hsrp` row per configured group (key `<iface>|<g>`), state 'initial'
 * while the interface is down or unaddressed.
 *
 * Per running group (§3.10): socket `hsrp#<iface>` (family 4, port 1985, receive restricted to the interface) opened
 * with the first group of the interface, `ipv4.group join` of 224.0.0.2 (v1) or 224.0.0.102 (v2) so the pipeline and
 * ipv4 accept the hellos, then the election:
 *   listen — `listen:<if>:<g>` (hold time, non-periodic): no active or no standby heard → speak;
 *   speak  — hellos every hello time (`hello:<if>:<g>`, periodic) for `speak:<if>:<g>` (hold time, non-periodic); a
 *            better router in speak or standby → listen; at the end, no standby (or a worse one) → standby;
 *   standby — no active heard, or `active-hold:<if>:<g>` (periodic, re-armed per active hello) expires → active; a
 *            better standby → listen; a resign from the active → active;
 *   active — `ipv4.virtual add {address: vip, mac: virtual MAC, local: true, owner: 'hsrp'}` (ipv4 writes virtual4
 *            and sends the gratuitous ARP from the virtual MAC); hellos leave from the virtual MAC; a coup, or a
 *            hello from a better active, → speak (virtual address removed).
 * Better = higher priority, then higher interface address. Preemption: a listening, speaking or standby router
 * with `preempt` that hears a worse active sends a coup (opCode 1) and becomes active, after `delay minimum` when
 * set (`preempt-delay:<if>:<g>`, non-periodic). `no standby ip`, a version or address change and power-off send a
 * resign (opCode 2) from an active router. `standby-hold:<if>:<g>` (periodic) tracks the standby router.
 * Hellos are `[ethernet {dst = the group MAC, src = interface MAC, or the virtual MAC once active}, ipv4 {ttl 1,
 * protocol 17}, udp {1985 → 1985}, hsrp {...}]`, built here and sent with `send` so this daemon controls the Ethernet
 * source; `meta {tag: 'hsrp-hello', background: true}`. No randomness is used (§4.1).
 *
 * Debug category 'standby'; every state change is a `ctx.transition` of machine 'hsrp' (subject
 * '<iface> group <g>'). stateSnapshot: { groups: [{ iface, group, version, state, priority, preempt, virtualIp,
 * virtualMac, active, standby }] }.
 *
 * ponytail: no authentication, no interface tracking, no `standby use-bia`, no msec timers, hello and hold times
 * are not learned from the active router.
 */
import { IPV4_ANY, ipv4ToU32, isIpv4, type Ipv4Address, type MacAddress } from '../contracts/addr.js';
import type { ConfigDelta } from '../contracts/config.js';
import type { PduId, PortId } from '../contracts/ids.js';
import { ETHERTYPE_IPV4, HSRP_V1_GROUP, HSRP_V2_GROUP, IPPROTO_UDP, UDP_PORT_HSRP, type FieldValue, type LayerSpec, type Pdu, type PduMeta } from '../contracts/pdu.js';
import type { Action, DebugEvent, FsmTransition, Process, ProcessCtx, ProcessRequest, StateView } from '../contracts/process.js';
import type { HsrpRow, Table } from '../contracts/tables.js';
import { SEC, type SimTime } from '../contracts/time.js';
import type { ProcessEvent } from '../contracts/transport.js';
import { configTextLinesOf } from '../cli/config-text.js';
import { ipv4MulticastMac } from '../core/addr6.js';
import { HSRP_OP, HSRP_STATE, hsrpStateText, hsrpVirtualMac } from '../pdu/codecs/hsrp.js';

const NAME = 'hsrp';
/** Debug category (§5.4): `debug standby` (the cli grammar names the same string). */
const CAT = 'standby';
const DEBUG_RING = 256;

export const HSRP_DEFAULT_PRIORITY = 100;
export const HSRP_DEFAULT_HELLO_MS = 3000;
export const HSRP_DEFAULT_HOLD_MS = 10_000;
export const HSRP_DEFAULT_VERSION = 1;
/** Highest group number per version. */
export const HSRP_V1_MAX_GROUP = 255;
export const HSRP_V2_MAX_GROUP = 4095;

export type HsrpState = HsrpRow['state'];

/** One `standby` group of an interface, parsed from the running config. */
export interface HsrpGroupConfig {
  iface: PortId;
  group: number;
  version: 1 | 2;
  /** Configured virtual address; absent = learn it from the active router. */
  virtualIp?: Ipv4Address;
  priority: number;
  preempt: boolean;
  /** `preempt delay minimum <s>`, seconds (0 = none). */
  preemptDelayS: number;
  helloMs: number;
  holdMs: number;
}

/** Every configured group of every interface, in config order (interface, then group). */
export function hsrpConfig(ctx: Pick<ProcessCtx, 'config' | 'ports'>): HsrpGroupConfig[] {
  const versions = new Map<PortId, 1 | 2>();
  const groups = new Map<string, HsrpGroupConfig>();
  const get = (iface: PortId, group: number): HsrpGroupConfig => {
    const key = `${iface}|${group}`;
    let g = groups.get(key);
    if (g === undefined) {
      g = { iface, group, version: HSRP_DEFAULT_VERSION, priority: HSRP_DEFAULT_PRIORITY, preempt: false, preemptDelayS: 0, helloMs: HSRP_DEFAULT_HELLO_MS, holdMs: HSRP_DEFAULT_HOLD_MS };
      groups.set(key, g);
    }
    return g;
  };
  const withIp = new Set<string>();
  for (const l of configTextLinesOf(ctx.config.root)) {
    const head = l.context[0];
    const t = l.tokens;
    if (l.context.length !== 1 || head?.[0] !== 'interface' || head[1] === undefined || t[0] !== 'standby' || !ctx.ports.has(head[1])) continue;
    const iface = head[1];
    if (t[1] === 'version') {
      if (t[2] === '2') versions.set(iface, 2);
      else if (t[2] === '1') versions.set(iface, 1);
      continue;
    }
    let at = 1;
    let group = 0;
    if (t[1] !== undefined && /^\d+$/.test(t[1])) {
      group = Number(t[1]);
      at = 2;
    }
    const what = t[at];
    if (what === 'ip') {
      const g = get(iface, group);
      withIp.add(`${iface}|${group}`);
      const a = t[at + 1];
      if (a !== undefined && isIpv4(a)) g.virtualIp = a;
    } else if (what === 'priority') {
      const n = Number(t[at + 1]);
      if (Number.isInteger(n) && n >= 0 && n <= 255) get(iface, group).priority = n;
    } else if (what === 'preempt') {
      const g = get(iface, group);
      g.preempt = true;
      if (t[at + 1] === 'delay' && t[at + 2] === 'minimum') {
        const s = Number(t[at + 3]);
        if (Number.isInteger(s) && s >= 0) g.preemptDelayS = s;
      }
    } else if (what === 'timers') {
      const hello = Number(t[at + 1]);
      const hold = Number(t[at + 2]);
      if (Number.isInteger(hello) && hello >= 1 && Number.isInteger(hold) && hold > hello) {
        const g = get(iface, group);
        g.helloMs = hello * 1000;
        g.holdMs = hold * 1000;
      }
    }
  }
  const out: HsrpGroupConfig[] = [];
  for (const g of groups.values()) {
    if (!withIp.has(`${g.iface}|${g.group}`)) continue;
    g.version = versions.get(g.iface) ?? HSRP_DEFAULT_VERSION;
    if (g.group > (g.version === 1 ? HSRP_V1_MAX_GROUP : HSRP_V2_MAX_GROUP)) continue;
    out.push(g);
  }
  return out;
}

/** The multicast group of a version. */
export function hsrpGroupAddress(version: 1 | 2): Ipv4Address {
  return version === 1 ? HSRP_V1_GROUP : HSRP_V2_GROUP;
}

/** A router the group heard about. */
interface Peer {
  ip: Ipv4Address;
  priority: number;
}

interface Group {
  readonly key: string;
  cfg: HsrpGroupConfig;
  state: HsrpState;
  virtualMac: MacAddress;
  /** The virtual address in use (configured, or learned in 'learn'). */
  virtualIp?: Ipv4Address;
  active?: Peer;
  standby?: Peer;
  /** Waiting for `preempt-delay`. */
  preemptPending: boolean;
  /** The virtual address is currently added on ipv4. */
  virtualAdded: boolean;
}

const STATE_CODE: Readonly<Record<HsrpState, number>> = Object.freeze({
  initial: HSRP_STATE.initial,
  learn: HSRP_STATE.learn,
  listen: HSRP_STATE.listen,
  speak: HSRP_STATE.speak,
  standby: HSRP_STATE.standby,
  active: HSRP_STATE.active,
});

const RUNNING: readonly HsrpState[] = ['learn', 'listen', 'speak', 'standby', 'active'];
const SPEAKING: readonly HsrpState[] = ['speak', 'standby', 'active'];

const hsrpOf = (pdu: Pdu): Readonly<Record<string, FieldValue>> | undefined => pdu.layers.find((l) => l.proto === 'hsrp')?.fields;
const num = (v: FieldValue | undefined, dflt = 0): number => (typeof v === 'number' && Number.isFinite(v) ? v : dflt);

/** True when `a` wins the election over `b` (higher priority, then higher address). */
export function hsrpBetter(a: Peer, b: Peer): boolean {
  if (a.priority !== b.priority) return a.priority > b.priority;
  return ipv4ToU32(a.ip) > ipv4ToU32(b.ip);
}

export function createHsrp(): Process {
  const groups = new Map<string, Group>();
  const ring: DebugEvent[] = [];
  let hellosSent = 0;
  let hellosReceived = 0;

  function record(ctx: ProcessCtx, message: string, data?: Record<string, unknown>): void {
    const ev: DebugEvent = data
      ? { at: ctx.now, device: ctx.deviceId, process: NAME, category: CAT, message, data }
      : { at: ctx.now, device: ctx.deviceId, process: NAME, category: CAT, message };
    ring.push(ev);
    if (ring.length > DEBUG_RING) ring.splice(0, ring.length - DEBUG_RING);
  }

  function debug(ctx: ProcessCtx, message: string, data?: Record<string, unknown>): void {
    ctx.debug(CAT, message, data);
    record(ctx, message, data);
  }

  const table = (ctx: ProcessCtx): Table<HsrpRow> | undefined => ctx.tables.get<HsrpRow>('hsrp');
  const socketOf = (iface: PortId): string => `${NAME}#${iface}`;
  const subject = (g: Group): string => `${g.cfg.iface} group ${g.cfg.group}`;
  const tkey = (kind: string, g: Group): string => `${kind}:${g.cfg.iface}:${g.cfg.group}`;
  const timer = (key: string, delay: SimTime, periodic = false): Action => (periodic ? { type: 'timer', key, delay, periodic: true } : { type: 'timer', key, delay });
  const cancel = (key: string): Action => ({ type: 'cancelTimer', key });
  const addressOf = (ctx: ProcessCtx, iface: PortId): Ipv4Address | undefined => {
    const p = ctx.ports.get(iface);
    return p !== undefined && p.operUp ? p.l3.ipv4?.address : undefined;
  };
  const me = (ctx: ProcessCtx, g: Group): Peer => ({ ip: addressOf(ctx, g.cfg.iface) ?? IPV4_ANY, priority: g.cfg.priority });
  const isRunning = (g: Group): boolean => RUNNING.includes(g.state);

  function writeRow(ctx: ProcessCtx, g: Group): void {
    const row: HsrpRow = {
      key: g.key,
      iface: g.cfg.iface,
      group: g.cfg.group,
      version: g.cfg.version,
      state: g.state,
      priority: g.cfg.priority,
      preempt: g.cfg.preempt,
      virtualMac: g.virtualMac,
      updatedAt: ctx.now,
    };
    if (g.virtualIp !== undefined) row.virtualIp = g.virtualIp;
    if (g.state === 'active') row.active = 'local';
    else if (g.active !== undefined) row.active = g.active.ip;
    if (g.state === 'standby') row.standby = 'local';
    else if (g.standby !== undefined) row.standby = g.standby.ip;
    table(ctx)?.set(row);
  }

  // ── sending ───────────────────────────────────────────────────────────────

  function frame(ctx: ProcessCtx, g: Group, opCode: number, tag: string, background: boolean, triggeredBy?: PduId): Action[] {
    const src = addressOf(ctx, g.cfg.iface);
    if (src === undefined) return [];
    const groupIp = hsrpGroupAddress(g.cfg.version);
    const ethSrc = g.state === 'active' ? g.virtualMac : ctx.macOf(g.cfg.iface);
    const hsrp: Record<string, FieldValue> = {
      version: g.cfg.version,
      opCode,
      state: STATE_CODE[g.state],
      helloMs: g.cfg.helloMs,
      holdMs: g.cfg.holdMs,
      priority: g.cfg.priority,
      group: g.cfg.group,
      virtualIp: g.virtualIp ?? IPV4_ANY,
    };
    if (g.cfg.version === 2) hsrp.identifier = ctx.macOf(g.cfg.iface);
    const layers: LayerSpec[] = [
      { proto: 'ethernet', fields: { dst: ipv4MulticastMac(groupIp), src: ethSrc, type: ETHERTYPE_IPV4 } },
      { proto: 'ipv4', fields: { src, dst: groupIp, protocol: IPPROTO_UDP, ttl: 1 } },
      { proto: 'udp', fields: { srcPort: UDP_PORT_HSRP, dstPort: UDP_PORT_HSRP } },
      { proto: 'hsrp', fields: hsrp },
    ];
    const meta: Partial<PduMeta> = {
      tag,
      flow: `ipv4:${src}>${groupIp}:udp`,
      ...(background ? { background: true } : {}),
      ...(triggeredBy !== undefined ? { triggeredBy } : {}),
    };
    const pdu = ctx.newPdu(layers, meta);
    if (opCode === HSRP_OP.hello) hellosSent++;
    return [{ type: 'send', port: g.cfg.iface, pdu }];
  }

  const hello = (ctx: ProcessCtx, g: Group): Action[] => frame(ctx, g, HSRP_OP.hello, 'hsrp-hello', true);
  const coup = (ctx: ProcessCtx, g: Group, triggeredBy?: PduId): Action[] => frame(ctx, g, HSRP_OP.coup, 'hsrp-coup', false, triggeredBy);
  const resign = (ctx: ProcessCtx, g: Group): Action[] => frame(ctx, g, HSRP_OP.resign, 'hsrp-resign', false);

  // ── state machine ─────────────────────────────────────────────────────────

  function virtualRequest(g: Group, op: 'add' | 'remove'): Action[] {
    if (g.virtualIp === undefined) return [];
    if (op === 'add' && g.virtualAdded) return [];
    if (op === 'remove' && !g.virtualAdded) return [];
    g.virtualAdded = op === 'add';
    const req: Extract<ProcessRequest, { kind: 'ipv4.virtual' }> = { kind: 'ipv4.virtual', op, iface: g.cfg.iface, address: g.virtualIp, mac: g.virtualMac, local: true, owner: NAME };
    return [{ type: 'request', to: 'ipv4', req }];
  }

  /** Move `g` to `to`, with the timers and virtual address each state needs. */
  function enter(ctx: ProcessCtx, g: Group, to: HsrpState, cause: string, pdu?: PduId): Action[] {
    const from = g.state;
    const out: Action[] = [];
    if (from === to) return out;
    const fsm: FsmTransition = { machine: 'hsrp', subject: subject(g), port: g.cfg.iface, instance: g.cfg.group, from, to, cause, ...(pdu !== undefined ? { pdu } : {}) };
    const message = `${subject(g)}: ${from} -> ${to} (${cause})`;
    ctx.transition(CAT, message, fsm, { iface: g.cfg.iface, group: g.cfg.group });
    record(ctx, message, { iface: g.cfg.iface, group: g.cfg.group, fsm });
    if (from === 'active') out.push(...virtualRequest(g, 'remove'));
    g.state = to;
    g.preemptPending = g.preemptPending && to !== 'active';
    switch (to) {
      case 'initial':
      case 'learn':
        out.push(cancel(tkey('hello', g)), cancel(tkey('listen', g)), cancel(tkey('speak', g)), cancel(tkey('preempt-delay', g)));
        if (to === 'initial') {
          out.push(cancel(tkey('active-hold', g)), cancel(tkey('standby-hold', g)));
          delete g.active;
          delete g.standby;
        }
        break;
      case 'listen':
        out.push(cancel(tkey('hello', g)), cancel(tkey('speak', g)), timer(tkey('listen', g), g.cfg.holdMs * (SEC / 1000)));
        break;
      case 'speak':
        out.push(cancel(tkey('listen', g)), timer(tkey('speak', g), g.cfg.holdMs * (SEC / 1000)), ...hello(ctx, g), timer(tkey('hello', g), g.cfg.helloMs * (SEC / 1000), true));
        break;
      case 'standby':
        out.push(cancel(tkey('listen', g)), cancel(tkey('speak', g)), ...hello(ctx, g), timer(tkey('hello', g), g.cfg.helloMs * (SEC / 1000), true));
        break;
      case 'active':
        out.push(cancel(tkey('listen', g)), cancel(tkey('speak', g)), cancel(tkey('preempt-delay', g)), ...virtualRequest(g, 'add'), ...hello(ctx, g), timer(tkey('hello', g), g.cfg.helloMs * (SEC / 1000), true));
        delete g.active;
        break;
      default:
        break;
    }
    writeRow(ctx, g);
    return out;
  }

  /** A standby router with no active router becomes active at once (§3.10 step 3). */
  function settleStandby(ctx: ProcessCtx, g: Group, cause: string, pdu?: PduId): Action[] {
    if (g.state === 'standby' && g.active === undefined) return enter(ctx, g, 'active', cause, pdu);
    return [];
  }

  /** Preempt a worse active router: coup, then active (after `delay minimum` when set). */
  function tryPreempt(ctx: ProcessCtx, g: Group, pdu?: PduId): Action[] {
    if (!g.cfg.preempt || g.state === 'active' || g.state === 'initial' || g.state === 'learn' || g.active === undefined) return [];
    if (!hsrpBetter(me(ctx, g), g.active)) return [];
    if (g.cfg.preemptDelayS > 0 && !g.preemptPending) {
      g.preemptPending = true;
      debug(ctx, `${subject(g)}: preempting ${g.active.ip} in ${g.cfg.preemptDelayS} s`, { iface: g.cfg.iface, group: g.cfg.group, active: g.active.ip });
      return [timer(tkey('preempt-delay', g), g.cfg.preemptDelayS * SEC)];
    }
    if (g.cfg.preemptDelayS > 0 && g.preemptPending) return [];
    debug(ctx, `${subject(g)}: preempting active router ${g.active.ip} (priority ${g.active.priority})`, { iface: g.cfg.iface, group: g.cfg.group, active: g.active.ip });
    return [...coup(ctx, g, pdu), ...enter(ctx, g, 'active', `preempted ${g.active.ip}`, pdu)];
  }

  function onMessage(ctx: ProcessCtx, g: Group, f: Readonly<Record<string, FieldValue>>, from: Ipv4Address, pdu: Pdu): Action[] {
    const opCode = num(f.opCode, HSRP_OP.hello);
    const theirState = num(f.state, 0);
    const peer: Peer = { ip: from, priority: num(f.priority, HSRP_DEFAULT_PRIORITY) };
    const mine = me(ctx, g);
    const better = hsrpBetter(peer, mine);
    const holdNs = g.cfg.holdMs * (SEC / 1000);
    const out: Action[] = [];
    if (opCode === HSRP_OP.hello) hellosReceived++;
    debug(ctx, `${subject(g)}: ${hsrpStateText(theirState)} ${opCode === HSRP_OP.hello ? 'hello' : opCode === HSRP_OP.coup ? 'coup' : 'resign'} from ${from} priority ${peer.priority} (pdu ${pdu.id})`, {
      iface: g.cfg.iface, group: g.cfg.group, from, priority: peer.priority, state: theirState, opCode, pdu: pdu.id,
    });

    if (opCode === HSRP_OP.coup) {
      if (g.state === 'active' && better) {
        g.active = peer;
        out.push(timer(tkey('active-hold', g), holdNs, true), ...enter(ctx, g, 'speak', `coup from ${from}`, pdu.id));
      }
      return out;
    }
    if (opCode === HSRP_OP.resign) {
      if (g.active?.ip === from) {
        delete g.active;
        out.push(cancel(tkey('active-hold', g)));
      }
      if (g.state === 'standby') out.push(...enter(ctx, g, 'active', `resign from ${from}`, pdu.id));
      else if (g.state === 'listen') out.push(...enter(ctx, g, 'speak', `resign from ${from}`, pdu.id));
      else writeRow(ctx, g);
      return out;
    }

    // hello
    if (theirState === HSRP_STATE.active) {
      const vip = typeof f.virtualIp === 'string' && isIpv4(f.virtualIp) && f.virtualIp !== IPV4_ANY ? f.virtualIp : undefined;
      if (g.state === 'learn' && vip !== undefined) {
        g.virtualIp = vip;
        debug(ctx, `${subject(g)}: learned virtual address ${vip} from ${from}`, { iface: g.cfg.iface, group: g.cfg.group, vip });
        out.push(...enter(ctx, g, 'listen', `virtual address learned from ${from}`, pdu.id));
      }
      if (g.state === 'active') {
        if (better) {
          g.active = peer;
          out.push(timer(tkey('active-hold', g), holdNs, true), ...enter(ctx, g, 'speak', `better active router ${from}`, pdu.id));
        }
        return out;
      }
      g.active = peer;
      out.push(timer(tkey('active-hold', g), holdNs, true));
      if (g.standby?.ip === from) {
        delete g.standby;
        out.push(cancel(tkey('standby-hold', g)));
      }
      out.push(...tryPreempt(ctx, g, pdu.id));
      writeRow(ctx, g);
      return out;
    }
    if (theirState === HSRP_STATE.standby) {
      if (g.active?.ip === from) {
        delete g.active;
        out.push(cancel(tkey('active-hold', g)));
      }
      if (g.state === 'standby') {
        if (better) {
          g.standby = peer;
          out.push(timer(tkey('standby-hold', g), holdNs, true), ...enter(ctx, g, 'listen', `better standby router ${from}`, pdu.id));
        }
        return out;
      }
      g.standby = peer;
      out.push(timer(tkey('standby-hold', g), holdNs, true));
      if (g.state === 'speak') {
        if (better) out.push(...enter(ctx, g, 'listen', `standby router ${from} is better`, pdu.id));
        else out.push(...enter(ctx, g, 'standby', `standby router ${from} is worse`, pdu.id), ...settleStandby(ctx, g, 'no active router', pdu.id));
      } else writeRow(ctx, g);
      return out;
    }
    if (theirState === HSRP_STATE.speak) {
      if (better && (g.state === 'speak' || g.state === 'standby')) out.push(...enter(ctx, g, 'listen', `speaking router ${from} is better`, pdu.id));
      return out;
    }
    return out;
  }

  // ── lifecycle ─────────────────────────────────────────────────────────────

  /** Groups of `iface` that are running and use `groupIp` (for the join / leave and socket bookkeeping). */
  function runningOn(iface: PortId, groupIp?: Ipv4Address): Group[] {
    return [...groups.values()].filter((g) => g.cfg.iface === iface && isRunning(g) && (groupIp === undefined || hsrpGroupAddress(g.cfg.version) === groupIp));
  }

  function startGroup(ctx: ProcessCtx, g: Group, why: string): Action[] {
    const out: Action[] = [];
    const iface = g.cfg.iface;
    const groupIp = hsrpGroupAddress(g.cfg.version);
    if (runningOn(iface).length === 0) {
      out.push({ type: 'request', to: 'udp', req: { kind: 'udp.open', owner: NAME, socket: socketOf(iface), family: 4, localAddr: IPV4_ANY, localPort: UDP_PORT_HSRP, iface } });
    }
    if (runningOn(iface, groupIp).length === 0) out.push({ type: 'request', to: 'ipv4', req: { kind: 'ipv4.group', op: 'join', iface, group: groupIp, owner: NAME } });
    g.virtualIp = g.cfg.virtualIp;
    out.push(...enter(ctx, g, g.virtualIp === undefined ? 'learn' : 'listen', why));
    return out;
  }

  function stopGroup(ctx: ProcessCtx, g: Group, why: string): Action[] {
    const out: Action[] = [];
    if (!isRunning(g)) return out;
    if (g.state === 'active') out.push(...resign(ctx, g));
    out.push(...enter(ctx, g, 'initial', why));
    const iface = g.cfg.iface;
    const groupIp = hsrpGroupAddress(g.cfg.version);
    if (runningOn(iface, groupIp).length === 0) out.push({ type: 'request', to: 'ipv4', req: { kind: 'ipv4.group', op: 'leave', iface, group: groupIp, owner: NAME } });
    if (runningOn(iface).length === 0) out.push({ type: 'request', to: 'udp', req: { kind: 'udp.close', socket: socketOf(iface) } });
    return out;
  }

  function removeGroup(ctx: ProcessCtx, g: Group, why: string): Action[] {
    const out = stopGroup(ctx, g, why);
    groups.delete(g.key);
    table(ctx)?.delete(g.key, 'cleared');
    debug(ctx, `${subject(g)}: removed (${why})`, { iface: g.cfg.iface, group: g.cfg.group });
    return out;
  }

  /** Reconcile the groups with the running config and the interface states. */
  function sync(ctx: ProcessCtx, why: string): Action[] {
    const out: Action[] = [];
    const wanted = new Map<string, HsrpGroupConfig>(hsrpConfig(ctx).map((c) => [`${c.iface}|${c.group}`, c]));
    for (const g of [...groups.values()]) {
      const c = wanted.get(g.key);
      if (c === undefined) {
        out.push(...removeGroup(ctx, g, 'no standby ip'));
        continue;
      }
      const restart = c.version !== g.cfg.version || c.virtualIp !== g.cfg.virtualIp;
      const rearm = c.helloMs !== g.cfg.helloMs || c.holdMs !== g.cfg.holdMs;
      const priorityChanged = c.priority !== g.cfg.priority;
      const preemptChanged = c.preempt !== g.cfg.preempt || c.preemptDelayS !== g.cfg.preemptDelayS;
      if (restart) {
        out.push(...stopGroup(ctx, g, 'configuration changed'));
        g.cfg = c;
        g.virtualMac = hsrpVirtualMac(c.version, c.group);
      } else {
        g.cfg = c;
        if (rearm && SPEAKING.includes(g.state)) out.push(timer(tkey('hello', g), c.helloMs * (SEC / 1000), true));
        if (priorityChanged || preemptChanged) {
          debug(ctx, `${subject(g)}: priority ${c.priority}, preempt ${c.preempt ? 'on' : 'off'}`, { iface: g.cfg.iface, group: g.cfg.group, priority: c.priority, preempt: c.preempt });
          out.push(...tryPreempt(ctx, g));
        }
        writeRow(ctx, g);
      }
    }
    for (const [key, c] of wanted) {
      if (groups.has(key)) continue;
      const g: Group = { key, cfg: c, state: 'initial', virtualMac: hsrpVirtualMac(c.version, c.group), preemptPending: false, virtualAdded: false };
      groups.set(key, g);
      debug(ctx, `${subject(g)}: configured (version ${c.version}, priority ${c.priority}${c.virtualIp !== undefined ? `, virtual address ${c.virtualIp}` : ''})`, { iface: c.iface, group: c.group });
      writeRow(ctx, g);
    }
    // run every group whose interface is up and addressed; stop the others
    for (const g of groups.values()) {
      const can = addressOf(ctx, g.cfg.iface) !== undefined;
      if (can && !isRunning(g)) out.push(...startGroup(ctx, g, why));
      else if (!can && isRunning(g)) out.push(...stopGroup(ctx, g, 'interface down or unaddressed'));
    }
    return out;
  }

  return {
    name: NAME,

    init(ctx: ProcessCtx): Action[] {
      return sync(ctx, 'boot');
    },

    onPdu(_ctx: ProcessCtx, pdu: Pdu, port: PortId): Action[] {
      return [{ type: 'drop', pdu, reason: 'unsupported-protocol', detail: 'hsrp takes datagrams from its udp socket', port }];
    },

    onConfig(ctx: ProcessCtx, delta: ConfigDelta): Action[] {
      if (delta.context[0]?.[0] !== 'interface') return [];
      const l = delta.line;
      if (l[0] !== 'standby' && !(l[0] === 'ip' && l[1] === 'address')) return [];
      return sync(ctx, 'configuration');
    },

    onLinkChange(ctx: ProcessCtx, port: PortId, up: boolean): Action[] {
      if (![...groups.values()].some((g) => g.cfg.iface === port)) return [];
      return sync(ctx, up ? 'link up' : 'link down');
    },

    onTimer(ctx: ProcessCtx, key: string): Action[] {
      const i = key.indexOf(':');
      const kind = key.slice(0, i);
      const g = groups.get(key.slice(i + 1).replace(':', '|'));
      if (g === undefined || !isRunning(g)) return [];
      switch (kind) {
        case 'hello':
          return SPEAKING.includes(g.state) ? [...hello(ctx, g), timer(tkey('hello', g), g.cfg.helloMs * (SEC / 1000), true)] : [];
        case 'listen':
          if (g.state !== 'listen') return [];
          if (g.active === undefined || g.standby === undefined) return enter(ctx, g, 'speak', g.active === undefined ? 'no active router heard' : 'no standby router heard');
          return [];
        case 'speak': {
          if (g.state !== 'speak') return [];
          const mine = me(ctx, g);
          if (g.standby === undefined || hsrpBetter(mine, g.standby)) {
            return [...enter(ctx, g, 'standby', g.standby === undefined ? 'no standby router heard' : 'better than the standby router'), ...settleStandby(ctx, g, 'no active router heard')];
          }
          return enter(ctx, g, 'listen', 'a better standby router exists');
        }
        case 'active-hold': {
          const lost = g.active;
          delete g.active;
          if (lost === undefined) return [];
          debug(ctx, `${subject(g)}: active router ${lost.ip} timed out`, { iface: g.cfg.iface, group: g.cfg.group, active: lost.ip });
          if (g.state === 'standby') return enter(ctx, g, 'active', `active router ${lost.ip} timed out`);
          if (g.state === 'listen') return enter(ctx, g, 'speak', `active router ${lost.ip} timed out`);
          writeRow(ctx, g);
          return [];
        }
        case 'standby-hold': {
          const lost = g.standby;
          delete g.standby;
          if (lost === undefined) return [];
          debug(ctx, `${subject(g)}: standby router ${lost.ip} timed out`, { iface: g.cfg.iface, group: g.cfg.group, standby: lost.ip });
          if (g.state === 'listen') return enter(ctx, g, 'speak', `standby router ${lost.ip} timed out`);
          writeRow(ctx, g);
          return [];
        }
        case 'preempt-delay':
          if (!g.preemptPending) return [];
          g.preemptPending = false;
          if (g.active === undefined || !g.cfg.preempt || !hsrpBetter(me(ctx, g), g.active)) return [];
          debug(ctx, `${subject(g)}: preempting active router ${g.active.ip} (priority ${g.active.priority})`, { iface: g.cfg.iface, group: g.cfg.group, active: g.active.ip });
          return [...coup(ctx, g), ...enter(ctx, g, 'active', `preempted ${g.active.ip} after the delay`)];
        default:
          return [];
      }
    },

    onEvent(ctx: ProcessCtx, ev: ProcessEvent): Action[] {
      if (ev.kind === 'sock.error') {
        debug(ctx, `socket ${ev.socket}: ${ev.code}${ev.detail !== undefined ? ` (${ev.detail})` : ''}`, { socket: ev.socket, code: ev.code });
        return [];
      }
      if (ev.kind !== 'sock.datagram') return [];
      const f = hsrpOf(ev.pdu);
      if (f === undefined) return [];
      const iface = ev.iface;
      if (ev.socket !== socketOf(iface)) return [];
      const version = num(f.version, 0);
      const group = num(f.group, -1);
      const g = groups.get(`${iface}|${group}`);
      if (g === undefined || !isRunning(g) || g.cfg.version !== version) {
        debug(ctx, `${iface}: ignored HSRPv${version} group ${group} message from ${ev.from} (pdu ${ev.pdu.id})`, { iface, group, version, from: ev.from, pdu: ev.pdu.id });
        return [];
      }
      if (!isIpv4(ev.from) || ev.from === addressOf(ctx, iface)) return [];
      return onMessage(ctx, g, f, ev.from, ev.pdu);
    },

    onRequest(): Action[] {
      return [];
    },

    onShutdown(ctx: ProcessCtx): Action[] {
      // power-off says nothing: the standby router notices through its hold time (§3.10 step 5)
      const out: Action[] = [];
      for (const g of groups.values()) if (g.state === 'active') out.push(...virtualRequest(g, 'remove'));
      return out;
    },

    stateSnapshot(): StateView {
      return {
        process: NAME,
        state: {
          groups: [...groups.values()].map((g) => ({
            iface: g.cfg.iface,
            group: g.cfg.group,
            version: g.cfg.version,
            state: g.state,
            priority: g.cfg.priority,
            preempt: g.cfg.preempt,
            virtualIp: g.virtualIp ?? null,
            virtualMac: g.virtualMac,
            active: g.state === 'active' ? 'local' : (g.active?.ip ?? null),
            standby: g.state === 'standby' ? 'local' : (g.standby?.ip ?? null),
          })),
          hellosSent,
          hellosReceived,
        },
      };
    },

    debugEvents(): readonly DebugEvent[] {
      return ring;
    },
  };
}
