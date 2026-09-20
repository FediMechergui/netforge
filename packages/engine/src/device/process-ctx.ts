/**
 * device/process-ctx.ts — the `ProcessCtx` handed to protocol daemons (spec §4.8 process model,
 * §4.5 provenance invariant, §9.3 provenance timeline; ARCHITECTURE-P1 D2, D5, D12).
 *
 * One ctx object is built per process at boot and reused for every handler call; the
 * time-varying members (`now`, `hostname`, `config`, `air`) are getters that read the live device
 * runtime, so a ctx is always current. The `ports` map exposes the runtime's live
 * `PortState` objects typed as read-only `PortView`s: processes see counters/L3 state change
 * in real time without any copying (hot-path allocation-light); they must never write to them
 * (the `setPortL3` action is the only L3 write path). The Map object is the runtime's own one and
 * keeps its identity when module or virtual ports are added (the runtime refills it in place).
 *
 * Every PDU write path (`newPdu`, `mutate`, `encapsulate`, `rewrap`, `clone`) is stamped with this
 * device/time and mirrored into the trace stream (`pduCreated` / `mutation`), which is what
 * the provenance timeline renders live. `rewrap` is a recorded structural write (D12): its
 * Decapsulate/Encapsulate provenance entries are emitted as `mutation` events like any other.
 *
 * P0.5 members:
 *  - `hasCapability(cap)` tests the EFFECTIVE capabilities (model plus installed modules);
 *  - `air` is the RF view of the device (`DeviceRuntimeDeps.airView`), undefined on devices without radio ports;
 *  - `stream(label)` returns a cached child stream of the process rng (never re-split per use).
 *
 * P1 members (IPv6, ARCHITECTURE-P1 §4.6, §4.8):
 *  - `lpm6(dst)`: longest-prefix match over `tables.get('rib6')` (no rib6 table → no candidates); candidates ordered
 *    by prefixLen desc, AD asc, metric asc, then table insertion order (the `Lpm6Result` contract);
 *  - `ownAddress6(ip)`: the port carrying `ip` in its `l3.ipv6` list, whatever its DAD state (config level, like
 *    `ownAddress`);
 *  - `isLocalDestination6(ip, inPort?)`: a PREFERRED own unicast address on an oper-up port (a link-local one must be
 *    on `inPort` when given: link-local addresses are zoned to their link, RFC 4007), or a multicast group joined on
 *    `inPort` (on any port when `inPort` is omitted);
 *  - `connectedPortFor6(ip, hint?)`: the oper-up port with an on-link prefix (an address that finished DAD) containing
 *    `ip`; the hint port wins when it qualifies; link-scoped destinations (fe80::/10, multicast of link scope or
 *    narrower) resolve only through `hint`;
 *  - `sourceFor6(dst, iface?)`: RFC 6724-lite source selection (§4.8, `selectSource6`).
 * Every IPv6 input is parsed, never compared as raw text, so non-canonical spellings behave like canonical ones.
 */
import { broadcastOf, inSubnet, isIpv4Broadcast, type Ipv4Address, type Ipv6Address, type MacAddress } from '../contracts/addr.js';
import type { Capability } from '../contracts/catalog.js';
import type { ConfigAst } from '../contracts/config.js';
import type { DeviceModel } from '../contracts/device.js';
import type { DeviceId, PortId, ProcessName } from '../contracts/ids.js';
import type { AirView } from '../contracts/medium.js';
import type { FieldValue, LayerSpec, MutationReason, Pdu, PduFactory, PduMeta, RewrapOp } from '../contracts/pdu.js';
import type { Ipv6PortAddress, PortState, PortView } from '../contracts/port.js';
import type { DebugEvent, ProcessCtx } from '../contracts/process.js';
import type { Rng } from '../contracts/rng.js';
import type { DeviceTables, Lpm6Result, LpmResult, Route6Row } from '../contracts/tables.js';
import type { SimTime } from '../contracts/time.js';
import type { PduSummary, TraceSink } from '../contracts/trace.js';
import { normalizeIpv6, parseIpv6 } from '../core/addr6.js';
import { lpm } from '../core/lpm.js';

/** What a ctx needs from its device runtime (implemented by `device/device.ts`). */
export interface ProcessHost {
  readonly id: DeviceId;
  readonly hostname: string;
  readonly model: DeviceModel;
  /** Time of the event currently being dispatched. */
  readonly now: SimTime;
  readonly ports: ReadonlyMap<PortId, PortState>;
  readonly tables: DeviceTables;
  readonly running: ConfigAst;
  readonly trace: TraceSink;
  readonly pdus: PduFactory;
  /** Effective capabilities (model plus installed modules), in CAPABILITIES order. */
  readonly capabilities: readonly Capability[];
  /** RF view of this device, or undefined when it has no radio ports or the simulation provides none. */
  readonly air: AirView | undefined;
  /** Store a DebugEvent in the per-process ring (the ctx emits the trace event itself). */
  recordDebug(ev: DebugEvent): void;
}

/** Compact trace description of a PDU (optional keys omitted when unset). */
export function pduSummary(pdu: Pdu): PduSummary {
  const s: PduSummary = { id: pdu.id, proto: pdu.topProto(), size: pdu.size, summary: pdu.summary() };
  if (pdu.meta.parent !== undefined) s.parent = pdu.meta.parent;
  if (pdu.meta.flow !== undefined) s.flow = pdu.meta.flow;
  if (pdu.meta.tag !== undefined) s.tag = pdu.meta.tag;
  return s;
}

// ── IPv6 helpers (P1, §4.6 / §4.8) ──────────────────────────────────────────

/** Source-selection scope class (§4.8 "same scope first"; unique-local is kept apart from global as §4.8 asks). */
export type SourceScope6 = 'link-local' | 'unique-local' | 'global';

/**
 * §4.8 step 4 origin rank: manual < eui64 < slaac < dhcpv6. `auto-link-local` ranks last; link-local addresses only
 * compete in step 3, where the first preferred one is taken.
 */
export const SOURCE_ORIGIN_RANK6: Readonly<Record<Ipv6PortAddress['origin'], number>> = Object.freeze({
  manual: 0,
  eui64: 1,
  slaac: 2,
  dhcpv6: 3,
  'auto-link-local': 4,
});

/** Number of leading bits (0..128) on which two 16-byte addresses agree. */
function commonBits6(a: Uint8Array, b: Uint8Array): number {
  for (let i = 0; i < 16; i++) {
    const d = (a[i] as number) ^ (b[i] as number);
    if (d !== 0) return i * 8 + (Math.clz32(d) - 24);
  }
  return 128;
}

/** True when the first `len` bits of two 16-byte addresses are equal; `len` outside 0..128 never matches. */
function prefixEqual6(a: Uint8Array, b: Uint8Array, len: number): boolean {
  if (!Number.isInteger(len) || len < 0 || len > 128) return false;
  return commonBits6(a, b) >= len;
}

/** fe80::/10. */
function isLinkLocalBytes(b: Uint8Array): boolean {
  return b[0] === 0xfe && ((b[1] as number) & 0xc0) === 0x80;
}

/** Link-scoped destination: fe80::/10, or multicast whose scope nibble is interface-local or link-local (at most 2). */
function isLinkScopedBytes(b: Uint8Array): boolean {
  if (isLinkLocalBytes(b)) return true;
  return b[0] === 0xff && ((b[1] as number) & 0x0f) <= 2;
}

/**
 * Scope class of an address (16 bytes). Unicast: fe80::/10 → link-local, fc00::/7 → unique-local, anything else →
 * global. Multicast by its scope nibble (RFC 4291 §2.7): up to 2 → link-local, 0xe and above → global, the admin/site/
 * organisation scopes in between → unique-local (they stay inside the site, like ULA traffic).
 */
function scopeClassBytes(b: Uint8Array): SourceScope6 {
  if (b[0] === 0xff) {
    const scope = (b[1] as number) & 0x0f;
    if (scope <= 2) return 'link-local';
    return scope >= 0xe ? 'global' : 'unique-local';
  }
  if (isLinkLocalBytes(b)) return 'link-local';
  if (((b[0] as number) & 0xfe) === 0xfc) return 'unique-local';
  return 'global';
}

/** Source-selection scope class of IPv6 text, or undefined when it does not parse. */
export function sourceScope6(a: Ipv6Address): SourceScope6 | undefined {
  const b = parseIpv6(a);
  return b === null ? undefined : scopeClassBytes(b);
}

/**
 * RFC 6724-lite choice among the addresses of the egress port (ARCHITECTURE-P1 §4.8 steps 2–4). Pure.
 *  2. Only PREFERRED addresses are candidates (tentative, deprecated and duplicate ones never source traffic).
 *  3. A link-scoped destination (fe80::/10, ff02::/16 and other link-scope multicast) takes the first link-local
 *     candidate.
 *  4. Otherwise the non-link-local candidates are ordered by: same scope class as `dst` first (RFC 6724 rule 2);
 *     longest common prefix with `dst` (rule 8); origin rank manual < eui64 < slaac < dhcpv6; list order.
 * Returns undefined when `dst` does not parse or no candidate qualifies.
 */
export function selectSource6(addresses: readonly Ipv6PortAddress[], dst: Ipv6Address): Ipv6PortAddress | undefined {
  const d = parseIpv6(dst);
  if (d === null) return undefined;
  if (isLinkScopedBytes(d)) {
    for (const a of addresses) {
      if (a.state !== 'preferred') continue;
      const b = parseIpv6(a.address);
      if (b !== null && isLinkLocalBytes(b)) return a;
    }
    return undefined;
  }
  const dstScope = scopeClassBytes(d);
  const ranked: { a: Ipv6PortAddress; same: number; common: number; origin: number; index: number }[] = [];
  addresses.forEach((a, index) => {
    if (a.state !== 'preferred') return;
    const b = parseIpv6(a.address);
    if (b === null || isLinkLocalBytes(b)) return;
    ranked.push({ a, same: scopeClassBytes(b) === dstScope ? 0 : 1, common: commonBits6(b, d), origin: SOURCE_ORIGIN_RANK6[a.origin], index });
  });
  ranked.sort((x, y) => x.same - y.same || y.common - x.common || x.origin - y.origin || x.index - y.index);
  return ranked[0]?.a;
}

/**
 * Longest-prefix match of `dst` over rib6 rows given in table insertion order (the final tie-break): candidates are
 * ordered by prefixLen desc, AD asc, metric asc, insertion (the `Lpm6Result` contract). Rows or destinations that
 * do not parse never match; nothing throws.
 */
function lpm6Over(rows: readonly Route6Row[], dst: Ipv6Address): Lpm6Result {
  const d = parseIpv6(dst);
  if (d === null) return { candidates: [] };
  const candidates: Route6Row[] = [];
  for (const r of rows) {
    const n = parseIpv6(r.network);
    if (n !== null && prefixEqual6(d, n, r.prefixLen)) candidates.push(r);
  }
  // Array.prototype.sort is stable, so equal keys keep insertion order.
  candidates.sort((a, b) => b.prefixLen - a.prefixLen || a.ad - b.ad || a.metric - b.metric);
  const winner = candidates[0];
  return winner === undefined ? { candidates } : { winner, candidates };
}

/** The rib6 rows of a table set, in insertion order (none when the device has no rib6 table). */
function rib6Rows(tables: DeviceTables): readonly Route6Row[] {
  return tables.get<Route6Row>('rib6')?.rows() ?? [];
}

/**
 * §4.8 "Names": the resolver query order of a dual-stack lookup. AAAA comes first when the device has a PREFERRED
 * global or unique-local address on an oper-up port AND a rib6 route to the destination: to `dst` when it is known,
 * otherwise any non-local (not L) route beyond link scope. Otherwise A comes first.
 */
export function dualStackQueryOrder(
  view: { readonly ports: ReadonlyMap<PortId, PortView>; readonly tables: DeviceTables },
  dst?: Ipv6Address,
): readonly ['AAAA', 'A'] | readonly ['A', 'AAAA'] {
  let global = false;
  for (const p of view.ports.values()) {
    if (!p.operUp) continue;
    for (const a of p.l3.ipv6 ?? []) {
      if (a.state !== 'preferred') continue;
      const b = parseIpv6(a.address);
      if (b !== null && !isLinkLocalBytes(b)) global = true;
    }
  }
  if (!global) return ['A', 'AAAA'];
  const rows = rib6Rows(view.tables);
  const routed = dst !== undefined
    ? lpm6Over(rows, dst).winner !== undefined
    : rows.some((r) => {
      if (r.source === 'L') return false;
      const n = parseIpv6(r.network);
      return n !== null && !(r.prefixLen >= 10 && isLinkLocalBytes(n)) && !(r.prefixLen >= 16 && isLinkScopedBytes(n));
    });
  return routed ? ['AAAA', 'A'] : ['A', 'AAAA'];
}

/** Build the ctx for process `name` on `host`, with the process's private rng sub-stream. */
export function createProcessCtx(host: ProcessHost, name: ProcessName, rng: Rng): ProcessCtx {
  const ports = host.ports as ReadonlyMap<PortId, PortView>;

  const emitNewMutations = (pdu: Pdu, from: number): void => {
    const prov = pdu.provenance;
    for (let i = from; i < prov.length; i++) {
      host.trace.emit({ t: host.now, kind: 'mutation', pdu: pdu.id, mutation: prov[i] as NonNullable<typeof prov[number]> });
    }
  };

  const ownAddress = (ip: Ipv4Address): PortId | undefined => {
    for (const p of host.ports.values()) {
      if (p.l3.ipv4 !== undefined && p.l3.ipv4.address === ip) return p.id;
    }
    return undefined;
  };

  const connectedPortFor = (ip: Ipv4Address): PortId | undefined => {
    for (const p of host.ports.values()) {
      const l3 = p.l3.ipv4;
      if (l3 === undefined || !p.operUp) continue;
      if (inSubnet(ip, l3.address, l3.prefixLen)) return p.id;
    }
    return undefined;
  };

  // ── IPv6 (P1) ──

  const lpm6 = (dst: Ipv6Address): Lpm6Result => lpm6Over(rib6Rows(host.tables), dst);

  const ownAddress6 = (ip: Ipv6Address): PortId | undefined => {
    const canon = normalizeIpv6(ip);
    if (canon === null) return undefined;
    for (const p of host.ports.values()) {
      for (const a of p.l3.ipv6 ?? []) if (a.address === canon) return p.id;
    }
    return undefined;
  };

  /** Oper-up port with a finished (preferred or deprecated) non-link-local address whose prefix contains `b`. */
  const onLink6 = (p: PortState, b: Uint8Array): boolean => {
    if (!p.operUp) return false;
    for (const a of p.l3.ipv6 ?? []) {
      if (a.state !== 'preferred' && a.state !== 'deprecated') continue;
      const ab = parseIpv6(a.address);
      if (ab === null || isLinkLocalBytes(ab)) continue;
      if (prefixEqual6(ab, b, a.prefixLen)) return true;
    }
    return false;
  };

  const connectedPortFor6 = (ip: Ipv6Address, hint?: PortId): PortId | undefined => {
    const b = parseIpv6(ip);
    if (b === null) return undefined;
    if (isLinkScopedBytes(b)) {
      if (hint === undefined) return undefined;
      const p = host.ports.get(hint);
      if (p === undefined || !p.operUp) return undefined;
      return p.l3.ipv6Enabled === true || (p.l3.ipv6 ?? []).length > 0 ? hint : undefined;
    }
    if (hint !== undefined) {
      const p = host.ports.get(hint);
      if (p !== undefined && onLink6(p, b)) return hint;
    }
    for (const p of host.ports.values()) if (onLink6(p, b)) return p.id;
    return undefined;
  };

  // Cached child streams (ProcessCtx.stream): one ctx per process instance, so draws advance across handlers.
  const streams = new Map<string, Rng>();

  const ctx: ProcessCtx = {
    get now(): SimTime {
      return host.now;
    },
    deviceId: host.id,
    get hostname(): string {
      return host.hostname;
    },
    model: host.model,
    ports,
    tables: host.tables,
    get config(): ConfigAst {
      return host.running;
    },
    rng,
    stream(label: string): Rng {
      let s = streams.get(label);
      if (s === undefined) {
        s = rng.split(label);
        streams.set(label, s);
      }
      return s;
    },
    debug(category: string, message: string, data?: Record<string, unknown>): void {
      const ev: DebugEvent = data === undefined
        ? { at: host.now, device: host.id, process: name, category, message }
        : { at: host.now, device: host.id, process: name, category, message, data };
      host.recordDebug(ev);
      host.trace.emit({ t: host.now, kind: 'debug', event: ev });
    },
    newPdu(layers: readonly LayerSpec[], meta?: Partial<PduMeta>): Pdu {
      const full: PduMeta = { born: host.now, origin: host.id, ...(meta ?? {}) };
      const pdu = host.pdus.build(layers, full);
      host.trace.emit({ t: host.now, kind: 'pduCreated', pdu: pduSummary(pdu), device: host.id, process: name });
      return pdu;
    },
    mutate(pdu: Pdu, field: string, after: FieldValue, reason: MutationReason, cause?: string): void {
      const from = pdu.provenance.length;
      pdu.mutate({ now: host.now, device: host.id }, field, after, reason, cause);
      emitNewMutations(pdu, from);
    },
    encapsulate(pdu: Pdu, outer: LayerSpec, cause?: string): void {
      const from = pdu.provenance.length;
      pdu.encapsulate({ now: host.now, device: host.id }, outer, cause);
      emitNewMutations(pdu, from);
    },
    rewrap(pdu: Pdu, op: RewrapOp, cause?: string): void {
      const from = pdu.provenance.length;
      pdu.rewrap({ now: host.now, device: host.id }, op, cause);
      emitNewMutations(pdu, from);
    },
    clone(pdu: Pdu): Pdu {
      return host.pdus.clone(pdu, host.now);
    },
    lpm(dst: Ipv4Address): LpmResult {
      return lpm(host.tables.rib, dst);
    },
    ownAddress,
    isLocalDestination(ip: Ipv4Address, inPort?: PortId): boolean {
      // Only addresses on oper-up ports are local: while a port is down its C/L routes
      // are withdrawn, so the address must not answer (ownAddress stays config-level).
      for (const p of host.ports.values()) if (p.operUp && p.l3.ipv4?.address === ip) return true;
      if (isIpv4Broadcast(ip)) return true;
      if (inPort !== undefined) {
        const p = host.ports.get(inPort);
        const l3 = p?.operUp ? p.l3.ipv4 : undefined;
        if (l3 !== undefined && broadcastOf(l3.address, l3.prefixLen) === ip) return true;
      }
      return false;
    },
    connectedPortFor,
    sourceFor(dst: Ipv4Address): { address: Ipv4Address; iface: PortId } | undefined {
      const r = lpm(host.tables.rib, dst);
      const route = r.winner;
      if (route === undefined) return undefined;
      let iface: PortId | undefined = route.iface;
      if (iface === undefined && route.nextHop !== undefined) iface = connectedPortFor(route.nextHop);
      if (iface === undefined) return undefined;
      const l3 = host.ports.get(iface)?.l3.ipv4;
      if (l3 === undefined) return undefined;
      return { address: l3.address, iface };
    },
    macOf(port: PortId): MacAddress {
      const p = host.ports.get(port);
      if (p === undefined) throw new Error(`macOf: unknown port ${port} on ${host.id}`);
      return p.mac;
    },
    hasCapability(cap: Capability): boolean {
      return host.capabilities.includes(cap);
    },
    get air(): AirView | undefined {
      return host.air;
    },
    lpm6,
    ownAddress6,
    isLocalDestination6(ip: Ipv6Address, inPort?: PortId): boolean {
      const canon = normalizeIpv6(ip);
      if (canon === null) return false;
      const b = parseIpv6(canon) as Uint8Array;
      if (b[0] === 0xff) {
        if (inPort !== undefined) return host.ports.get(inPort)?.l3.groups6?.includes(canon) === true;
        for (const p of host.ports.values()) if (p.l3.groups6?.includes(canon) === true) return true;
        return false;
      }
      // link-local addresses are zoned to their link (RFC 4007): with an ingress port, only that port's count
      const zoned = isLinkLocalBytes(b) && inPort !== undefined;
      for (const p of host.ports.values()) {
        if (!p.operUp || (zoned && p.id !== inPort)) continue;
        for (const a of p.l3.ipv6 ?? []) if (a.state === 'preferred' && a.address === canon) return true;
      }
      return false;
    },
    connectedPortFor6,
    sourceFor6(dst: Ipv6Address, iface?: PortId): { address: Ipv6Address; iface: PortId } | undefined {
      if (parseIpv6(dst) === null) return undefined;
      let egress = iface;
      if (egress === undefined) {
        const route = lpm6(dst).winner;
        if (route === undefined) return undefined;
        egress = route.iface;
        if (egress === undefined && route.nextHop !== undefined) egress = connectedPortFor6(route.nextHop);
      }
      if (egress === undefined) return undefined;
      const port = host.ports.get(egress);
      if (port === undefined) return undefined;
      const chosen = selectSource6(port.l3.ipv6 ?? [], dst);
      return chosen === undefined ? undefined : { address: chosen.address, iface: egress };
    },
  };
  return ctx;
}
