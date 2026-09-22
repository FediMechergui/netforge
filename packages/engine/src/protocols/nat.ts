/**
 * protocols/nat.ts — the NAT daemon (ARCHITECTURE-P2 D14, §2.4, §2.6 NatRow, §3.9, §4.1–§4.3, §5.2; [S9] port
 * forwarding, ICMP-error translation and the timeout lines).
 *
 * ipv4 hooks nat at two points (D14): a packet arriving on an `ip nat outside` port is handed over as `nat.inbound`
 * BEFORE the for-me test and comes back as `ipv4.resume` (translated or not); a forwarded packet whose input port is
 * inside and whose egress is outside is handed over as `nat.outbound` after the TTL decrement, and nat itself sends
 * `arp.sendVia` (or drops `nat-exhausted`). Every rewritten field goes through `ctx.mutate` with reason `NatTranslate`
 * and the configuration line of the rule as cause, so the transport checksum, the IPv4 checksum and the FCS follow as
 * derived records (§3.9 table).
 *
 * Configuration (§5.2; read from the running config on every relevant delta and at boot, idempotent):
 *   interface  `ip nat inside` / `ip nat outside`
 *   global     `ip nat pool <name> <start> <end> netmask <m> | prefix-length <n>`
 *              `ip nat inside source list <acl> pool <name> [overload]`
 *              `ip nat inside source list <acl> interface <if> overload`
 *              `ip nat inside source static <il> <ig>`
 *              `ip nat inside source static tcp|udp <il> <lp> <ig>|interface <if> <gp>`                      [S9]
 *              `ip nat translation timeout|udp-timeout|tcp-timeout|icmp-timeout <s>`                        [S9]
 *              `access-list <n> permit|deny …` / `ip access-list standard <name>` (core/acl.ts, matching only)
 *
 * Rows (`nat` table, key = natKey(proto, insideGlobal, insideGlobalPort)):
 *   static   address-only (`proto 'any'`) or a port forward ([S9], proto tcp|udp with both ports); written by the
 *            reconciliation of the config, never expire; the inside-global address is answered by ARP on every
 *            outside port through `ipv4.virtual` (local false) unless it is one of the router's own addresses.
 *   dynamic  address-only, one per inside host, from a `pool` rule without overload; lowest free pool address.
 *   overload one per flow (proto, inside local, inside port, outside global, outside port) from an `interface` rule
 *            or a `pool … overload` rule; the inside global port is the inside port when free, else the walk of §3.9.
 * Idle timeouts (refreshed by every packet of the row): ICMP 60 s, UDP 300 s, TCP 86 400 s — 60 s once a FIN has
 * been seen in both directions or an RST in either (`tcp-finrst`) — and 86 400 s for address-only dynamic rows; the
 * [S9] timeout lines override the defaults. `nat-sweep` (60 s, periodic) is armed only while a row can expire.
 *
 * Inbound match rule (§3.9, binding): udp/tcp rows match proto, dst = inside global and dst port = inside global
 * port, and an overload row also src = outside global and src port = outside global port; an ICMP query row matches
 * echo REPLIES only, with dst, id and src = outside global; address-only rows match dst alone. [S9] An ICMP error is
 * matched by its EMBEDDED packet with the roles reversed and both the outer and the quoted fields are rewritten.
 * Anything else resumes untranslated at the for-me test — including a packet to an inside global address this router
 * only answers ARP for (a pool or static address) with no row: ipv4 then routes it like any other packet (a TTL of 1
 * still earns a time-exceeded, and the connected route sends it back out the outside port, where nobody answers the
 * ARP), which is what a real router does.
 *
 * Determinism (§4.1): no randomness; ports and pool addresses come from fixed walks; rows are read in insertion order.
 * Silence (§4.3): the daemon never originates a PDU; with no `ip nat` line it writes no row, arms no timer and emits
 * no debug line. Debug category `ip nat` (§5.4); state-machine transitions (`FsmMachine 'nat'`) report a row's life:
 * free → active → (closing) → expired | cleared.
 *
 * `stateSnapshot()`: `{ process: 'nat', state: { inside, outside, rules, pools, translations, static, dynamic,
 * counters: { outbound, inbound, created, expired, cleared, exhausted, untranslated } } }` — what `show ip nat
 * statistics` needs; the rows themselves are the table.
 */
import { ipv4ToU32, isIpv4, maskToPrefixLen, u32ToIpv4, type Ipv4Address } from '../contracts/addr.js';
import type { ConfigAst, ConfigDelta } from '../contracts/config.js';
import type { PortId, ProcessName } from '../contracts/ids.js';
import { ICMP_DEST_UNREACHABLE, ICMP_ECHO_REPLY, ICMP_ECHO_REQUEST, ICMP_TIME_EXCEEDED, IPPROTO_ICMP, IPPROTO_TCP, IPPROTO_UDP } from '../contracts/pdu.js';
import type { FieldValue, LayerView, Pdu } from '../contracts/pdu.js';
import type { Action, DebugEvent, FsmTransition, Process, ProcessCtx, ProcessRequest, StateView } from '../contracts/process.js';
import { natKey, type NatRow, type SocketRow, type Table } from '../contracts/tables.js';
import { SEC, type SimTime } from '../contracts/time.js';
import { configTextLinesOf } from '../cli/config-text.js';
import { aclPermits, isStandardAclNumber, readStandardAcls, type StandardAcl } from '../core/acl.js';

/** Process name (`PROCESS_ORDER` position after `ipv4`, §2.1). */
export const NAT_PROCESS: ProcessName = 'nat';
/** Debug category (`debug ip nat`, §5.4). */
export const NAT_DEBUG_CATEGORY = 'ip nat';
/** The periodic sweep timer (§4.2). */
export const NAT_SWEEP_TIMER = 'nat-sweep';
/** Sweep period. */
export const NAT_SWEEP_NS: SimTime = 60 * SEC;
/** Capacity of the per-process DebugEvent ring. */
export const NAT_DEBUG_RING = 256;
/** Default idle timeouts in seconds (§3.9 step 4); `finrst` has no configuration line. */
export const NAT_DEFAULT_TIMEOUTS_S = Object.freeze({ icmp: 60, udp: 300, tcp: 86_400, finrst: 60, dynamic: 86_400 });
/** Port classes of the allocation walk (§3.9 step 4): a moved port stays in its class. */
export const NAT_PORT_CLASSES: readonly (readonly [number, number])[] = Object.freeze([
  Object.freeze([1, 511] as const),
  Object.freeze([512, 1023] as const),
  Object.freeze([1024, 65_535] as const),
]);
/** ICMP ids walk the single class 0–65535. */
export const NAT_ICMP_ID_CLASS: readonly [number, number] = Object.freeze([0, 65_535] as const);
/** Largest port or id. */
const PORT_MAX = 65_535;

export type NatProto = NatRow['proto'];

/** A `ip nat pool` line. */
export interface NatPool {
  readonly name: string;
  readonly start: Ipv4Address;
  readonly end: Ipv4Address;
  readonly prefixLen: number;
  readonly line: string;
}

/** A `ip nat inside source static …` line: address-only, or a [S9] port forward. */
export interface NatStaticRule {
  readonly proto: 'any' | 'tcp' | 'udp';
  readonly insideLocal: Ipv4Address;
  readonly insideLocalPort?: number;
  /** Explicit inside global address, or absent when `iface` names the outside interface whose address is used. */
  readonly insideGlobal?: Ipv4Address;
  readonly iface?: string;
  readonly insideGlobalPort?: number;
  readonly line: string;
}

/** A `ip nat inside source list …` line. */
export interface NatDynamicRule {
  /** ACL name as core/acl.ts keys it (a number as plain decimal text). */
  readonly acl: string;
  readonly pool?: string;
  readonly iface?: string;
  readonly overload: boolean;
  readonly line: string;
}

/** Idle timeouts in seconds after the [S9] lines. */
export interface NatTimeouts {
  readonly dynamicS: number;
  readonly udpS: number;
  readonly tcpS: number;
  readonly icmpS: number;
}

/** Everything nat reads from the running config. */
export interface NatConfig {
  readonly inside: readonly string[];
  readonly outside: readonly string[];
  readonly pools: readonly NatPool[];
  readonly statics: readonly NatStaticRule[];
  readonly dynamics: readonly NatDynamicRule[];
  readonly timeouts: NatTimeouts;
}

const EMPTY_CONFIG: NatConfig = Object.freeze({
  inside: Object.freeze([]),
  outside: Object.freeze([]),
  pools: Object.freeze([]),
  statics: Object.freeze([]),
  dynamics: Object.freeze([]),
  timeouts: Object.freeze({ dynamicS: NAT_DEFAULT_TIMEOUTS_S.dynamic, udpS: NAT_DEFAULT_TIMEOUTS_S.udp, tcpS: NAT_DEFAULT_TIMEOUTS_S.tcp, icmpS: NAT_DEFAULT_TIMEOUTS_S.icmp }),
});

/** A port token 1–65535 (a port forward's ports), else undefined. */
function portOf(token: string | undefined): number | undefined {
  if (token === undefined || !/^\d{1,5}$/.test(token)) return undefined;
  const v = Number(token);
  return v >= 1 && v <= PORT_MAX ? v : undefined;
}

/** A positive integer token, else undefined. */
function secondsOf(token: string | undefined): number | undefined {
  if (token === undefined || !/^\d{1,7}$/.test(token)) return undefined;
  const v = Number(token);
  return v >= 1 ? v : undefined;
}

/** True when the tokens of `line` start with `head`. */
function startsWith(line: readonly string[], head: readonly string[]): boolean {
  return head.every((t, i) => line[i] === t);
}

/** Does the delta name a NAT concern: an `ip nat` line anywhere, an access list, or an interface address (§5.2)? */
export function isNatDelta(delta: Pick<ConfigDelta, 'context' | 'line'>): boolean {
  const { context, line } = delta;
  if (context.length === 0) {
    if (line[0] === 'ip' && line[1] === 'nat') return true;
    if (line[0] === 'access-list') return true;
    if (line[0] === 'ip' && line[1] === 'access-list' && line[2] === 'standard') return true;
    return false;
  }
  const head = context[0];
  if (head === undefined) return false;
  if (context.length === 1 && head[0] === 'ip' && head[1] === 'access-list' && head[2] === 'standard') return true;
  if (context.length === 1 && head[0] === 'interface') return line[0] === 'ip' && (line[1] === 'nat' || line[1] === 'address');
  return false;
}

/**
 * The NAT configuration of a running config (pure). Lines that do not parse are skipped; a pool named twice keeps the
 * first line; the identity of the rule table already keeps one dynamic rule per ACL and one timeout per kind.
 */
export function readNatConfig(config: Pick<ConfigAst, 'root'>): NatConfig {
  const inside: string[] = [];
  const outside: string[] = [];
  const pools: NatPool[] = [];
  const statics: NatStaticRule[] = [];
  const dynamics: NatDynamicRule[] = [];
  let dynamicS: number = NAT_DEFAULT_TIMEOUTS_S.dynamic;
  let udpS: number = NAT_DEFAULT_TIMEOUTS_S.udp;
  let tcpS: number = NAT_DEFAULT_TIMEOUTS_S.tcp;
  let icmpS: number = NAT_DEFAULT_TIMEOUTS_S.icmp;
  for (const l of configTextLinesOf(config.root)) {
    if (l.negate) continue;
    const t = l.tokens;
    const head = l.context[0];
    if (l.context.length === 1 && head !== undefined && head[0] === 'interface' && head[1] !== undefined) {
      if (t[0] === 'ip' && t[1] === 'nat') {
        if (t[2] === 'inside' && !inside.includes(head[1])) inside.push(head[1]);
        else if (t[2] === 'outside' && !outside.includes(head[1])) outside.push(head[1]);
      }
      continue;
    }
    if (l.context.length !== 0 || t[0] !== 'ip' || t[1] !== 'nat') continue;
    const line = t.join(' ');
    if (t[2] === 'pool') {
      const [name, start, end, how, value] = [t[3], t[4], t[5], t[6], t[7]];
      if (name === undefined || start === undefined || end === undefined || !isIpv4(start) || !isIpv4(end)) continue;
      if (ipv4ToU32(start) > ipv4ToU32(end) || pools.some((p) => p.name === name)) continue;
      let prefixLen: number | null = null;
      if (how === 'netmask' && value !== undefined && isIpv4(value)) prefixLen = maskToPrefixLen(value);
      else if (how === 'prefix-length' && value !== undefined && /^\d{1,2}$/.test(value) && Number(value) <= 32) prefixLen = Number(value);
      if (prefixLen === null) continue;
      pools.push({ name, start, end, prefixLen, line });
      continue;
    }
    if (t[2] === 'translation') {
      const s = secondsOf(t[4]);
      if (s === undefined) continue;
      if (t[3] === 'timeout') dynamicS = s;
      else if (t[3] === 'udp-timeout') udpS = s;
      else if (t[3] === 'tcp-timeout') tcpS = s;
      else if (t[3] === 'icmp-timeout') icmpS = s;
      continue;
    }
    if (t[2] !== 'inside' || t[3] !== 'source') continue;
    if (t[4] === 'static') {
      if (t[5] === 'tcp' || t[5] === 'udp') {
        const proto = t[5];
        const il = t[6];
        const lp = portOf(t[7]);
        if (il === undefined || !isIpv4(il) || lp === undefined) continue;
        if (t[8] === 'interface') {
          const gp = portOf(t[10]);
          if (t[9] === undefined || gp === undefined || t[11] !== undefined) continue;
          statics.push({ proto, insideLocal: il, insideLocalPort: lp, iface: t[9], insideGlobalPort: gp, line });
        } else {
          const ig = t[8];
          const gp = portOf(t[9]);
          if (ig === undefined || !isIpv4(ig) || gp === undefined || t[10] !== undefined) continue;
          statics.push({ proto, insideLocal: il, insideLocalPort: lp, insideGlobal: ig, insideGlobalPort: gp, line });
        }
        continue;
      }
      const [il, ig] = [t[5], t[6]];
      if (il === undefined || ig === undefined || !isIpv4(il) || !isIpv4(ig) || t[7] !== undefined) continue;
      statics.push({ proto: 'any', insideLocal: il, insideGlobal: ig, line });
      continue;
    }
    if (t[4] === 'list' && t[5] !== undefined) {
      const acl = isStandardAclNumber(t[5]) ? String(Number(t[5])) : t[5];
      if (t[6] === 'pool' && t[7] !== undefined && (t[8] === undefined || (t[8] === 'overload' && t[9] === undefined))) {
        dynamics.push({ acl, pool: t[7], overload: t[8] === 'overload', line });
      } else if (t[6] === 'interface' && t[7] !== undefined && t[8] === 'overload' && t[9] === undefined) {
        dynamics.push({ acl, iface: t[7], overload: true, line });
      }
    }
  }
  return { inside, outside, pools, statics, dynamics, timeouts: { dynamicS, udpS, tcpS, icmpS } };
}

/** The allocation class of a port or id (§3.9 step 4). */
export function natPortClass(proto: NatProto, port: number): readonly [number, number] {
  if (proto === 'icmp') return NAT_ICMP_ID_CLASS;
  for (const c of NAT_PORT_CLASSES) if (port >= c[0] && port <= c[1]) return c;
  return NAT_PORT_CLASSES[NAT_PORT_CLASSES.length - 1]!;
}

/**
 * The inside global port for a flow whose inside port is `wanted` (§3.9 step 4, deterministic): `wanted` itself when
 * `taken` says it is free; else the walk upward inside the same class, wrapping within the class. Undefined when the
 * whole class is taken.
 */
export function allocateNatPort(proto: NatProto, wanted: number, taken: (port: number) => boolean): number | undefined {
  const [lo, hi] = natPortClass(proto, wanted);
  const start = wanted < lo || wanted > hi ? lo : wanted;
  const size = hi - lo + 1;
  for (let i = 0; i < size; i++) {
    const p = lo + ((start - lo + i) % size);
    if (!taken(p)) return p;
  }
  return undefined;
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

/** What a packet carries at the transport layer, as nat keys on it. */
interface Flow {
  /** Index of the first ipv4 layer. */
  readonly ipAt: number;
  /** Index of the transport layer right after it, or -1. */
  readonly at: number;
  readonly proto: NatProto | 'other';
  readonly protocolNumber: number;
  readonly src: Ipv4Address;
  readonly dst: Ipv4Address;
  readonly srcPort?: number;
  readonly dstPort?: number;
  /** ICMP echo id (types 8 and 0 only). */
  readonly id?: number;
  readonly icmpType?: number;
  /** An ICMP error (destination unreachable, time exceeded) carrying a quote. */
  readonly error: boolean;
  readonly fin: boolean;
  readonly rst: boolean;
}

const num = (v: FieldValue | undefined): number | undefined => (typeof v === 'number' ? v : undefined);

/** The transport view of `pdu` (undefined without an ipv4 layer). */
function flowOf(pdu: Pdu): Flow | undefined {
  const layers = pdu.layers;
  let ipAt = -1;
  for (let i = 0; i < layers.length; i++) {
    if (layers[i]!.proto === 'ipv4') {
      ipAt = i;
      break;
    }
  }
  if (ipAt < 0) return undefined;
  const ip = layers[ipAt]!;
  const src = String(ip.fields.src);
  const dst = String(ip.fields.dst);
  const protocolNumber = num(ip.fields.protocol) ?? -1;
  const next = layers[ipAt + 1];
  const base = { ipAt, src, dst, protocolNumber, error: false, fin: false, rst: false };
  if (next?.proto === 'udp' && protocolNumber === IPPROTO_UDP) {
    const srcPort = num(next.fields.srcPort);
    const dstPort = num(next.fields.dstPort);
    return { ...base, at: ipAt + 1, proto: 'udp', ...(srcPort !== undefined ? { srcPort } : {}), ...(dstPort !== undefined ? { dstPort } : {}) };
  }
  if (next?.proto === 'tcp' && protocolNumber === IPPROTO_TCP) {
    const srcPort = num(next.fields.srcPort);
    const dstPort = num(next.fields.dstPort);
    const flags = typeof next.fields.flags === 'string' ? next.fields.flags : '';
    return { ...base, at: ipAt + 1, proto: 'tcp', fin: flags.includes('F'), rst: flags.includes('R'), ...(srcPort !== undefined ? { srcPort } : {}), ...(dstPort !== undefined ? { dstPort } : {}) };
  }
  if (next?.proto === 'icmpv4' && protocolNumber === IPPROTO_ICMP) {
    const icmpType = num(next.fields.type) ?? -1;
    const error = icmpType === ICMP_DEST_UNREACHABLE || icmpType === ICMP_TIME_EXCEEDED;
    const id = icmpType === ICMP_ECHO_REQUEST || icmpType === ICMP_ECHO_REPLY ? num(next.fields.id) : undefined;
    return { ...base, at: ipAt + 1, proto: 'icmp', icmpType, error, ...(id !== undefined ? { id } : {}) };
  }
  return { ...base, at: -1, proto: 'other' };
}

/** The proto a quoted packet inside an ICMP error carries, from its own ipv4 layer at `i` and the layer after it. */
function quotedProto(layers: readonly LayerView[], i: number): { proto: NatProto; at: number } | undefined {
  const ip = layers[i];
  if (ip === undefined || ip.proto !== 'ipv4') return undefined;
  const p = num(ip.fields.protocol);
  const next = layers[i + 1];
  if (p === IPPROTO_UDP && next?.proto === 'udp') return { proto: 'udp', at: i + 1 };
  if (p === IPPROTO_TCP && next?.proto === 'tcp') return { proto: 'tcp', at: i + 1 };
  if (p === IPPROTO_ICMP && next?.proto === 'icmpv4') return { proto: 'icmp', at: i + 1 };
  return undefined;
}

/** The field path that carries a flow's port on the outer transport layer. */
function portField(proto: NatProto, side: 'src' | 'dst'): string {
  if (proto === 'icmp') return 'icmpv4.id';
  return `${proto}.${side}Port`;
}

/** The indexed field path that carries a quoted packet's port. */
function quotedPortField(proto: NatProto, at: number, side: 'src' | 'dst'): string {
  if (proto === 'icmp') return `icmpv4[${at}].id`;
  return `${proto}[${at}].${side}Port`;
}

/** A row's rewritten side as text for messages: `192.168.1.10:1024` or `192.168.1.10`. */
function endpoint(address: Ipv4Address, port: number | undefined): string {
  return port === undefined ? address : `${address}:${port}`;
}

/** TCP close tracking of an overload row (`tcp-finrst`). */
interface TcpTracking {
  finOut: boolean;
  finIn: boolean;
  closing: boolean;
}

/** Per-process counters for `show ip nat statistics`. */
interface Counters {
  outbound: number;
  inbound: number;
  created: number;
  expired: number;
  cleared: number;
  exhausted: number;
  untranslated: number;
}

/** The port a local socket holds on `address` (or on the wildcard address) for `proto`. */
function socketHolds(sockets: Table<SocketRow> | undefined, proto: NatProto, address: Ipv4Address, port: number): boolean {
  if (sockets === undefined || proto === 'icmp') return false;
  for (const s of sockets.rows()) {
    if (s.proto !== proto || s.family !== 4 || s.localPort !== port) continue;
    if (s.localAddr === '0.0.0.0' || s.localAddr === address) return true;
  }
  return false;
}

class NatDaemon implements Process {
  readonly name = NAT_PROCESS;

  private readonly ring = new DebugRing(NAT_DEBUG_RING);
  private cfg: NatConfig = EMPTY_CONFIG;
  private acls: ReadonlyMap<string, StandardAcl> = new Map();
  /** Virtual addresses nat has asked ipv4 to answer: address → outside ports. */
  private readonly virtuals = new Map<Ipv4Address, Set<PortId>>();
  /** TCP close tracking by row key. */
  private readonly tcp = new Map<string, TcpTracking>();
  private sweeping = false;
  private readonly counters: Counters = { outbound: 0, inbound: 0, created: 0, expired: 0, cleared: 0, exhausted: 0, untranslated: 0 };

  // ── Process ──────────────────────────────────────────────────────────────

  init(ctx: ProcessCtx): Action[] {
    return this.reconcile(ctx);
  }

  onPdu(ctx: ProcessCtx, pdu: Pdu, port: PortId): Action[] {
    // nat has no selectors and is never a deliver target: it works only through the ipv4 hooks.
    return [{ type: 'drop', pdu, reason: 'unsupported-protocol', detail: `${NAT_PROCESS} handles no frames`, port }];
  }

  onTimer(ctx: ProcessCtx, key: string): Action[] {
    if (key !== NAT_SWEEP_TIMER) return [];
    const table = this.table(ctx);
    if (table === undefined) return [];
    const aged = table.expire(ctx.now);
    for (const row of aged) {
      this.counters.expired++;
      const from = this.tcp.get(row.key)?.closing === true ? 'closing' : 'active';
      this.tcp.delete(row.key);
      this.transition(ctx, row, from, 'expired', 'idle timeout expired');
    }
    const actions = this.reconcileVirtuals(ctx);
    if (!table.rows().some((r) => r.expiresAt !== undefined)) {
      // nothing left to age: let the timer lapse (a stray fire while not sweeping is silent)
      const was = this.sweeping;
      this.sweeping = false;
      return was ? [...actions, { type: 'cancelTimer', key: NAT_SWEEP_TIMER }] : actions;
    }
    this.sweeping = true;
    return [...actions, { type: 'timer', key: NAT_SWEEP_TIMER, delay: NAT_SWEEP_NS, periodic: true }];
  }

  onConfig(ctx: ProcessCtx, delta: ConfigDelta): Action[] {
    if (!isNatDelta(delta)) return [];
    return this.reconcile(ctx);
  }

  onRequest(ctx: ProcessCtx, req: ProcessRequest): Action[] {
    switch (req.kind) {
      case 'nat.outbound':
        return this.outbound(ctx, req);
      case 'nat.inbound':
        return this.inbound(ctx, req);
      case 'nat.clear':
        return this.clear(ctx);
      default:
        return [];
    }
  }

  stateSnapshot(): StateView {
    return {
      process: NAT_PROCESS,
      state: {
        inside: this.cfg.inside.slice(),
        outside: this.cfg.outside.slice(),
        rules: [...this.cfg.statics.map((s) => s.line), ...this.cfg.dynamics.map((d) => d.line)],
        pools: this.cfg.pools.map((p) => ({ name: p.name, start: p.start, end: p.end, prefixLen: p.prefixLen })),
        timeouts: { ...this.cfg.timeouts },
        counters: { ...this.counters },
      },
    };
  }

  debugEvents(): readonly DebugEvent[] {
    return this.ring.toArray();
  }

  // ── configuration ────────────────────────────────────────────────────────

  private table(ctx: ProcessCtx): Table<NatRow> | undefined {
    return ctx.tables.get<NatRow>('nat');
  }

  /** The inside global address of a static rule: explicit, or the named interface's current address. */
  private staticGlobal(ctx: ProcessCtx, rule: NatStaticRule): Ipv4Address | undefined {
    if (rule.insideGlobal !== undefined) return rule.insideGlobal;
    const port = rule.iface === undefined ? undefined : this.findPort(ctx, rule.iface);
    return port === undefined ? undefined : ctx.ports.get(port)?.l3.ipv4?.address;
  }

  private findPort(ctx: ProcessCtx, name: string): PortId | undefined {
    if (ctx.ports.has(name)) return name;
    const lower = name.toLowerCase();
    for (const id of ctx.ports.keys()) if (id.toLowerCase() === lower) return id;
    return undefined;
  }

  /** Re-read the config; reconcile the static rows, drop dynamic rows whose rule is gone, then the virtual addresses. */
  private reconcile(ctx: ProcessCtx): Action[] {
    const cfg = readNatConfig(ctx.config);
    this.cfg = cfg;
    this.acls = readStandardAcls(ctx.config);
    const table = this.table(ctx);
    if (table === undefined) return [];
    const wanted = new Map<string, NatRow>();
    for (const rule of cfg.statics) {
      const ig = this.staticGlobal(ctx, rule);
      if (ig === undefined) continue;
      const key = natKey(rule.proto, ig, rule.insideGlobalPort);
      if (wanted.has(key)) continue;
      const row: NatRow = { key, proto: rule.proto, insideLocal: rule.insideLocal, insideGlobal: ig, kind: 'static', rule: rule.line, updatedAt: ctx.now };
      if (rule.insideLocalPort !== undefined) row.insideLocalPort = rule.insideLocalPort;
      if (rule.insideGlobalPort !== undefined) row.insideGlobalPort = rule.insideGlobalPort;
      wanted.set(key, row);
    }
    const dynamicLines = new Set(cfg.dynamics.map((d) => d.line));
    for (const row of table.rows()) {
      if (row.kind === 'static') {
        const w = wanted.get(row.key);
        if (w !== undefined && w.insideLocal === row.insideLocal && w.insideLocalPort === row.insideLocalPort && w.rule === row.rule) {
          wanted.delete(row.key);
          continue;
        }
        table.delete(row.key, 'cleared');
        this.counters.cleared++;
        this.transition(ctx, row, 'active', 'cleared', 'static translation removed');
      } else if (!dynamicLines.has(row.rule)) {
        table.delete(row.key, 'cleared');
        this.tcp.delete(row.key);
        this.counters.cleared++;
        this.transition(ctx, row, 'active', 'cleared', 'rule removed');
      }
    }
    for (const row of wanted.values()) {
      const prev = table.get(row.key);
      if (prev !== undefined) {
        // the key is reused by a changed rule: the old row went above, but a dynamic row may hold the key
        table.delete(row.key, 'replaced');
        this.tcp.delete(row.key);
        this.transition(ctx, prev, 'active', 'cleared', 'replaced by a static translation');
      }
      table.set(row);
      this.counters.created++;
      this.transition(ctx, row, 'free', 'active', row.rule);
    }
    return [...this.reconcileVirtuals(ctx), ...this.sweepArming(ctx)];
  }

  /** Every inside global address of a row that is not one of the router's own addresses, answered on every outside port. */
  private reconcileVirtuals(ctx: ProcessCtx): Action[] {
    const table = this.table(ctx);
    const wanted = new Map<Ipv4Address, Set<PortId>>();
    if (table !== undefined) {
      const outside: PortId[] = [];
      for (const name of this.cfg.outside) {
        const port = this.findPort(ctx, name);
        if (port !== undefined && !outside.includes(port)) outside.push(port);
      }
      for (const row of table.rows()) {
        if (ctx.ownAddress(row.insideGlobal) !== undefined || wanted.has(row.insideGlobal)) continue;
        wanted.set(row.insideGlobal, new Set(outside));
      }
    }
    const actions: Action[] = [];
    for (const [address, ports] of this.virtuals) {
      const keep = wanted.get(address);
      for (const port of [...ports]) {
        if (keep?.has(port)) continue;
        ports.delete(port);
        actions.push({ type: 'request', to: 'ipv4', req: { kind: 'ipv4.virtual', op: 'remove', iface: port, address, mac: ctx.macOf(port), local: false, owner: NAT_PROCESS } });
      }
      if (ports.size === 0) this.virtuals.delete(address);
    }
    for (const [address, ports] of wanted) {
      let have = this.virtuals.get(address);
      for (const port of ports) {
        if (have?.has(port)) continue;
        if (have === undefined) {
          have = new Set();
          this.virtuals.set(address, have);
        }
        have.add(port);
        actions.push({ type: 'request', to: 'ipv4', req: { kind: 'ipv4.virtual', op: 'add', iface: port, address, mac: ctx.macOf(port), local: false, owner: NAT_PROCESS } });
      }
    }
    return actions;
  }

  /** Arm the sweep when a row can expire and it is not armed; cancel it when none can. */
  private sweepArming(ctx: ProcessCtx): Action[] {
    const table = this.table(ctx);
    const expiring = table !== undefined && table.rows().some((r) => r.expiresAt !== undefined);
    if (expiring && !this.sweeping) {
      this.sweeping = true;
      return [{ type: 'timer', key: NAT_SWEEP_TIMER, delay: NAT_SWEEP_NS, periodic: true }];
    }
    if (!expiring && this.sweeping) {
      this.sweeping = false;
      return [{ type: 'cancelTimer', key: NAT_SWEEP_TIMER }];
    }
    return [];
  }

  /** `clear ip nat translation *`: every dynamic and overload row. */
  private clear(ctx: ProcessCtx): Action[] {
    const table = this.table(ctx);
    if (table === undefined) return [];
    for (const row of table.rows()) {
      if (row.kind === 'static') continue;
      table.delete(row.key, 'cleared');
      this.tcp.delete(row.key);
      this.counters.cleared++;
      this.transition(ctx, row, 'active', 'cleared', 'clear ip nat translation *');
    }
    return [...this.reconcileVirtuals(ctx), ...this.sweepArming(ctx)];
  }

  // ── rows ─────────────────────────────────────────────────────────────────

  private timeoutNs(row: NatRow): SimTime {
    const t = this.cfg.timeouts;
    if (row.kind === 'dynamic') return t.dynamicS * SEC;
    if (row.proto === 'udp') return t.udpS * SEC;
    if (row.proto === 'tcp') return t.tcpS * SEC;
    return t.icmpS * SEC;
  }

  /** Refresh a row's idle timeout (static rows never expire); track TCP closes. */
  private touch(ctx: ProcessCtx, table: Table<NatRow>, row: NatRow, flow: Flow, direction: 'out' | 'in', pduId?: number): void {
    if (row.kind === 'static') return;
    let expiresAt = ctx.now + this.timeoutNs(row);
    if (row.proto === 'tcp') {
      let t = this.tcp.get(row.key);
      if (t === undefined) {
        t = { finOut: false, finIn: false, closing: false };
        this.tcp.set(row.key, t);
      }
      if (flow.fin) {
        if (direction === 'out') t.finOut = true;
        else t.finIn = true;
      }
      if (!t.closing && (flow.rst || (t.finOut && t.finIn))) {
        t.closing = true;
        this.transition(ctx, row, 'active', 'closing', flow.rst ? 'RST seen' : 'FIN seen in both directions', pduId);
      }
      if (t.closing) expiresAt = Math.min(row.expiresAt ?? expiresAt, ctx.now + NAT_DEFAULT_TIMEOUTS_S.finrst * SEC);
    }
    table.set({ ...row, expiresAt, updatedAt: ctx.now });
  }

  private write(ctx: ProcessCtx, table: Table<NatRow>, row: NatRow): void {
    table.set(row);
    this.counters.created++;
    this.transition(ctx, row, 'free', 'active', row.rule);
  }

  /** Rewrite the source (port first when it moved, then the address) of an outbound packet by `row`. */
  private rewriteOut(ctx: ProcessCtx, pdu: Pdu, row: NatRow, flow: Flow): void {
    if (row.insideGlobalPort !== undefined && flow.proto !== 'other') {
      const have = flow.proto === 'icmp' ? flow.id : flow.srcPort;
      if (have !== undefined && have !== row.insideGlobalPort) ctx.mutate(pdu, portField(flow.proto, 'src'), row.insideGlobalPort, 'NatTranslate', row.rule);
    }
    if (flow.src !== row.insideGlobal) ctx.mutate(pdu, 'ipv4.src', row.insideGlobal, 'NatTranslate', row.rule);
    this.counters.outbound++;
    this.emit(ctx, `out ${endpoint(row.insideLocal, row.insideLocalPort)} -> ${endpoint(row.insideGlobal, row.insideGlobalPort)} (${row.proto}, ${row.kind})`, { pdu: pdu.id, key: row.key });
  }

  /** Rewrite the destination (port first when it moved, then the address) of an inbound packet by `row`. */
  private rewriteIn(ctx: ProcessCtx, pdu: Pdu, row: NatRow, flow: Flow): void {
    if (row.insideLocalPort !== undefined && flow.proto !== 'other') {
      const have = flow.proto === 'icmp' ? flow.id : flow.dstPort;
      if (have !== undefined && have !== row.insideLocalPort) ctx.mutate(pdu, portField(flow.proto, 'dst'), row.insideLocalPort, 'NatTranslate', row.rule);
    }
    if (flow.dst !== row.insideLocal) ctx.mutate(pdu, 'ipv4.dst', row.insideLocal, 'NatTranslate', row.rule);
    this.counters.inbound++;
    this.emit(ctx, `in ${endpoint(row.insideGlobal, row.insideGlobalPort)} -> ${endpoint(row.insideLocal, row.insideLocalPort)} (${row.proto}, ${row.kind})`, { pdu: pdu.id, key: row.key });
  }

  // ── outbound ─────────────────────────────────────────────────────────────

  private outbound(ctx: ProcessCtx, req: Extract<ProcessRequest, { kind: 'nat.outbound' }>): Action[] {
    const pdu = req.pdu;
    const send = (): Action[] => [
      { type: 'request', to: 'arp', req: { kind: 'arp.sendVia', pdu, nextHop: req.nextHop, iface: req.iface, ...(req.cause !== undefined ? { cause: req.cause } : {}) } },
    ];
    const table = this.table(ctx);
    const flow = flowOf(pdu);
    if (table === undefined || flow === undefined) return send();
    const rows = table.rows();

    // [S9] an ICMP error from an inside host about an inbound flow
    if (flow.proto === 'icmp' && flow.error) {
      if (!this.outboundError(ctx, pdu, flow, rows)) this.untranslated(ctx, pdu, 'out', flow);
      return send();
    }

    // 1. a port forward for this inside socket
    const port = flow.proto === 'icmp' ? flow.id : flow.srcPort;
    if ((flow.proto === 'tcp' || flow.proto === 'udp') && port !== undefined) {
      const st = rows.find((r) => r.kind === 'static' && r.proto === flow.proto && r.insideLocal === flow.src && r.insideLocalPort === port);
      if (st !== undefined) {
        this.rewriteOut(ctx, pdu, st, flow);
        return send();
      }
    }
    // 2. a static address translation
    const st = rows.find((r) => r.kind === 'static' && r.proto === 'any' && r.insideLocal === flow.src);
    if (st !== undefined) {
      this.rewriteOut(ctx, pdu, st, flow);
      return send();
    }
    // 3. an existing overload row of this flow, or the host's address-only dynamic row
    if (flow.proto !== 'other' && port !== undefined) {
      const ov = rows.find(
        (r) =>
          r.kind === 'overload' && r.proto === flow.proto && r.insideLocal === flow.src && r.insideLocalPort === port && r.outsideGlobal === flow.dst
          && (flow.proto === 'icmp' || r.outsideGlobalPort === flow.dstPort),
      );
      if (ov !== undefined) {
        this.touch(ctx, table, ov, flow, 'out', pdu.id);
        this.rewriteOut(ctx, pdu, ov, flow);
        return send();
      }
    }
    const dyn = rows.find((r) => r.kind === 'dynamic' && r.insideLocal === flow.src);
    if (dyn !== undefined) {
      this.touch(ctx, table, dyn, flow, 'out', pdu.id);
      this.rewriteOut(ctx, pdu, dyn, flow);
      return send();
    }
    // 4. the first dynamic rule whose list permits the source
    for (const rule of this.cfg.dynamics) {
      if (!aclPermits(this.acls.get(rule.acl), flow.src)) continue;
      const made = this.allocate(ctx, table, rule, flow, port, pdu);
      if (made === undefined) return send();
      if (typeof made === 'string') {
        this.counters.exhausted++;
        this.emit(ctx, `dropped ${flow.src} -> ${flow.dst}: ${made}`, { pdu: pdu.id, rule: rule.line });
        return [{ type: 'drop', pdu, reason: 'nat-exhausted', detail: made, port: req.inPort }];
      }
      this.rewriteOut(ctx, pdu, made, flow);
      return [...this.reconcileVirtuals(ctx), ...this.sweepArming(ctx), ...send()];
    }
    this.untranslated(ctx, pdu, 'out', flow);
    return send();
  }

  /**
   * A new row for `rule` and `flow`: the row, a drop detail (exhausted), or undefined when the rule does not apply to
   * this packet (a non-port protocol under overload is dropped, not passed, so no inside address leaks).
   */
  private allocate(ctx: ProcessCtx, table: Table<NatRow>, rule: NatDynamicRule, flow: Flow, port: number | undefined, pdu: Pdu): NatRow | string | undefined {
    const rows = table.rows();
    const sockets = ctx.tables.get<SocketRow>('sockets');
    if (rule.overload) {
      if (flow.proto === 'other' || port === undefined) return `protocol ${flow.protocolNumber} carries no port to translate with overload`;
      const candidates: Ipv4Address[] = [];
      let where: string;
      if (rule.iface !== undefined) {
        const p = this.findPort(ctx, rule.iface);
        const a = p === undefined ? undefined : ctx.ports.get(p)?.l3.ipv4?.address;
        if (a === undefined) return `interface ${rule.iface} has no address`;
        candidates.push(a);
        where = `interface ${rule.iface}`;
      } else {
        const pool = this.cfg.pools.find((p) => p.name === rule.pool);
        if (pool === undefined) return `pool ${String(rule.pool)} does not exist`;
        for (let a = ipv4ToU32(pool.start); a <= ipv4ToU32(pool.end); a++) candidates.push(u32ToIpv4(a));
        where = `pool ${pool.name}`;
      }
      const proto = flow.proto;
      for (const ig of candidates) {
        const taken = (p: number): boolean => table.has(natKey(proto, ig, p)) || socketHolds(sockets, proto, ig, p);
        const igPort = allocateNatPort(proto, port, taken);
        if (igPort === undefined) continue;
        const row: NatRow = {
          key: natKey(proto, ig, igPort), proto, insideLocal: flow.src, insideLocalPort: port, insideGlobal: ig, insideGlobalPort: igPort,
          outsideLocal: flow.dst, outsideGlobal: flow.dst, kind: 'overload', rule: rule.line, updatedAt: ctx.now,
        };
        if (proto !== 'icmp' && flow.dstPort !== undefined) {
          row.outsideLocalPort = flow.dstPort;
          row.outsideGlobalPort = flow.dstPort;
        }
        row.expiresAt = ctx.now + this.timeoutNs(row);
        this.write(ctx, table, row);
        if (igPort !== port) this.emit(ctx, `${proto} ${flow.src}:${port} takes ${ig}:${igPort} (${port} is in use)`, { pdu: pdu.id, key: row.key });
        return row;
      }
      return `${where} has no free ${proto === 'icmp' ? 'id' : 'port'} on ${candidates.length === 1 ? candidates[0]! : where}`;
    }
    const pool = this.cfg.pools.find((p) => p.name === rule.pool);
    if (pool === undefined) return `pool ${String(rule.pool)} does not exist`;
    const used = new Set(rows.map((r) => r.insideGlobal));
    for (let a = ipv4ToU32(pool.start); a <= ipv4ToU32(pool.end); a++) {
      const ig = u32ToIpv4(a);
      if (used.has(ig) || ctx.ownAddress(ig) !== undefined) continue;
      const row: NatRow = { key: natKey('any', ig), proto: 'any', insideLocal: flow.src, insideGlobal: ig, kind: 'dynamic', rule: rule.line, updatedAt: ctx.now };
      row.expiresAt = ctx.now + this.timeoutNs(row);
      this.write(ctx, table, row);
      return row;
    }
    return `pool ${pool.name} has no free address`;
  }

  // ── inbound ──────────────────────────────────────────────────────────────

  private inbound(ctx: ProcessCtx, req: Extract<ProcessRequest, { kind: 'nat.inbound' }>): Action[] {
    const pdu = req.pdu;
    const resume: Action[] = [{ type: 'request', to: 'ipv4', req: { kind: 'ipv4.resume', pdu, inPort: req.inPort } }];
    const table = this.table(ctx);
    const flow = flowOf(pdu);
    if (table === undefined || flow === undefined) return resume;

    if ((flow.proto === 'tcp' || flow.proto === 'udp') && flow.dstPort !== undefined) {
      const row = table.get(natKey(flow.proto, flow.dst, flow.dstPort));
      if (row !== undefined && (row.kind !== 'overload' || (flow.src === row.outsideGlobal && flow.srcPort === row.outsideGlobalPort))) {
        this.touch(ctx, table, row, flow, 'in', pdu.id);
        this.rewriteIn(ctx, pdu, row, flow);
        return resume;
      }
    } else if (flow.proto === 'icmp') {
      if (flow.error) {
        // [S9] an error from beyond about a packet translated outbound
        if (this.inboundError(ctx, pdu, flow, table)) return resume;
      } else if (flow.icmpType === ICMP_ECHO_REPLY && flow.id !== undefined) {
        const row = table.get(natKey('icmp', flow.dst, flow.id));
        if (row !== undefined && flow.src === row.outsideGlobal) {
          this.touch(ctx, table, row, flow, 'in', pdu.id);
          this.rewriteIn(ctx, pdu, row, flow);
          return resume;
        }
      }
    }
    const any = table.get(natKey('any', flow.dst));
    if (any !== undefined) {
      this.touch(ctx, table, any, flow, 'in', pdu.id);
      this.rewriteIn(ctx, pdu, any, flow);
      return resume;
    }
    this.untranslated(ctx, pdu, 'in', flow);
    return resume;
  }

  // ── [S9] ICMP errors ─────────────────────────────────────────────────────

  /**
   * Inbound error: the quoted packet is the one translated OUTBOUND, so the row is found by (quoted proto, quoted src =
   * inside global, quoted src port | id) and the quoted dst must be the row's outside global; address-only rows by the
   * quoted src alone. Rewrites the outer dst and the quoted src (and port) global → local.
   */
  private inboundError(ctx: ProcessCtx, pdu: Pdu, flow: Flow, table: Table<NatRow>): boolean {
    const layers = pdu.layers;
    const qi = flow.at + 1;
    const qip = layers[qi];
    if (qip === undefined || qip.proto !== 'ipv4') return false;
    const qsrc = String(qip.fields.src);
    const qdst = String(qip.fields.dst);
    const q = quotedProto(layers, qi);
    let row: NatRow | undefined;
    let qport: number | undefined;
    if (q !== undefined) {
      const t = layers[q.at]!;
      qport = q.proto === 'icmp' ? num(t.fields.id) : num(t.fields.srcPort);
      if (qport !== undefined) {
        const candidate = table.get(natKey(q.proto, qsrc, qport));
        if (candidate !== undefined && (candidate.kind !== 'overload' || candidate.outsideGlobal === qdst)) row = candidate;
      }
    }
    if (row === undefined) row = table.get(natKey('any', qsrc));
    if (row === undefined || flow.dst !== row.insideGlobal) return false;
    this.touch(ctx, table, row, flow, 'in', pdu.id);
    ctx.mutate(pdu, 'ipv4.dst', row.insideLocal, 'NatTranslate', row.rule);
    ctx.mutate(pdu, `ipv4[${qi}].src`, row.insideLocal, 'NatTranslate', row.rule);
    if (q !== undefined && row.insideLocalPort !== undefined && qport !== undefined && qport !== row.insideLocalPort) {
      ctx.mutate(pdu, quotedPortField(q.proto, q.at, 'src'), row.insideLocalPort, 'NatTranslate', row.rule);
    }
    this.counters.inbound++;
    this.emit(ctx, `in ICMP error ${flow.src} about ${endpoint(row.insideGlobal, row.insideGlobalPort)} -> ${endpoint(row.insideLocal, row.insideLocalPort)} (${row.proto}, ${row.kind})`, { pdu: pdu.id, key: row.key });
    return true;
  }

  /**
   * Outbound error: the quoted packet is the one translated INBOUND, so the row is found by (quoted proto, quoted dst =
   * inside local, quoted dst port | id) plus, for an overload row, the quoted src = outside global; address-only rows
   * by the quoted dst alone. Rewrites the outer src (when it is the inside local) and the quoted dst (and port)
   * local → global, so the outside host matches the error and no inside address leaks.
   */
  private outboundError(ctx: ProcessCtx, pdu: Pdu, flow: Flow, rows: readonly NatRow[]): boolean {
    const layers = pdu.layers;
    const qi = flow.at + 1;
    const qip = layers[qi];
    if (qip === undefined || qip.proto !== 'ipv4') return false;
    const qsrc = String(qip.fields.src);
    const qdst = String(qip.fields.dst);
    const q = quotedProto(layers, qi);
    let row: NatRow | undefined;
    let qport: number | undefined;
    if (q !== undefined) {
      const t = layers[q.at]!;
      qport = q.proto === 'icmp' ? num(t.fields.id) : num(t.fields.dstPort);
      if (qport !== undefined) {
        row = rows.find((r) => r.proto === q.proto && r.insideLocal === qdst && r.insideLocalPort === qport && (r.kind !== 'overload' || r.outsideGlobal === qsrc));
      }
    }
    if (row === undefined) row = rows.find((r) => r.proto === 'any' && r.insideLocal === qdst);
    if (row === undefined) return false;
    if (flow.src === row.insideLocal) ctx.mutate(pdu, 'ipv4.src', row.insideGlobal, 'NatTranslate', row.rule);
    ctx.mutate(pdu, `ipv4[${qi}].dst`, row.insideGlobal, 'NatTranslate', row.rule);
    if (q !== undefined && row.insideGlobalPort !== undefined && qport !== undefined && qport !== row.insideGlobalPort) {
      ctx.mutate(pdu, quotedPortField(q.proto, q.at, 'dst'), row.insideGlobalPort, 'NatTranslate', row.rule);
    }
    this.counters.outbound++;
    this.emit(ctx, `out ICMP error ${flow.src} about ${endpoint(row.insideLocal, row.insideLocalPort)} -> ${endpoint(row.insideGlobal, row.insideGlobalPort)} (${row.proto}, ${row.kind})`, { pdu: pdu.id, key: row.key });
    return true;
  }

  // ── debug ────────────────────────────────────────────────────────────────

  private untranslated(ctx: ProcessCtx, pdu: Pdu, direction: 'out' | 'in', flow: Flow): void {
    this.counters.untranslated++;
    this.emit(ctx, `${direction} ${flow.src} -> ${flow.dst} (${flow.proto}) left untranslated: no matching translation`, { pdu: pdu.id });
  }

  private emit(ctx: ProcessCtx, message: string, data?: Record<string, unknown>): void {
    ctx.debug(NAT_DEBUG_CATEGORY, message, data);
    const ev: DebugEvent = data === undefined
      ? { at: ctx.now, device: ctx.deviceId, process: NAT_PROCESS, category: NAT_DEBUG_CATEGORY, message }
      : { at: ctx.now, device: ctx.deviceId, process: NAT_PROCESS, category: NAT_DEBUG_CATEGORY, message, data };
    this.ring.push(ev);
  }

  /** One `nat` state-machine transition of a row (D19): free → active → closing → expired | cleared. */
  private transition(ctx: ProcessCtx, row: NatRow, from: string, to: string, cause: string, pduId?: number): void {
    const subject = `${row.proto} ${endpoint(row.insideLocal, row.insideLocalPort)} ${endpoint(row.insideGlobal, row.insideGlobalPort)}`;
    const fsm: FsmTransition = { machine: 'nat', subject, from, to, cause, ...(pduId !== undefined ? { pdu: pduId } : {}) };
    const message = `translation ${subject} ${from} -> ${to} (${cause})`;
    const data = { key: row.key, kind: row.kind };
    ctx.transition(NAT_DEBUG_CATEGORY, message, fsm, data);
    this.ring.push({ at: ctx.now, device: ctx.deviceId, process: NAT_PROCESS, category: NAT_DEBUG_CATEGORY, message, data: { ...data, fsm }, fsm });
  }
}

/** Create the NAT daemon (`name: 'nat'`, no frame selectors). One instance per router with `routing` or `nat-gateway`. */
export function createNat(): Process {
  return new NatDaemon();
}
