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
 *
 * P2 (ARCHITECTURE-P2 D15; W2 device): `isLocalDestination` also accepts a local virtual address (`PortL3.virtual4`
 * with `local: true`) on an oper-up port and [S2] a joined IPv4 group (`PortL3.groups4`, on `inPort` when given).
 * No P1 port carries either member, so every P1 answer is unchanged.
 *
 * P2 members (ARCHITECTURE-P2 §2.4, D2, D19; W1 device):
 *  - `profile`: the world's defaults profile, read ONLY for invisible defaults (P2: proxy ARP). It comes from the
 *    host (`DeviceSpec.profile`); a hand-built host that names none is a P1 world;
 *  - `transition(category, message, fsm, data?)`: exactly ONE debug event, emitted and recorded like `ctx.debug`,
 *    whose `DebugEvent.fsm` is a copy of the transition. `category` is the daemon's §5.4 debug category, so the CLI
 *    prints the line under `debug <category>`. P0/P1 daemons never call it, so their debug bytes are unchanged.
 *
 * P2 wireless member (ARCHITECTURE-P2 §2.4, §3.12 step 4; W4 device):
 *  - `radioSettings(port)`: the ONE radio settings renderer — the host's `radioSettings` (device/device.ts: the local
 *    interface lines overlaid by the controller profile a `radio-profile` action stored), so wlan-ap and the air
 *    medium read the same answer; undefined for a port that is not a radio. It is present on the ctx exactly when the
 *    host offers a renderer (the device runtime always does); a hand-built host without one gives a ctx without the
 *    member (optional by meaning, §2.15), so a daemon may fall back to its own reader there.
 *
 * P3 members (ARCHITECTURE-P3 §2.4, D19, D21; W1 device), required on every ctx:
 *  - `clock()`: the device clock at `now` — the host's `clockView(now)` (device/device.ts). A hand-built host without
 *    one gets the clock the device would boot with (`bootClockBase`: true time on a host, unset on a network device);
 *  - [S32] `files(fs)` / `readFile(fs, path)`: the host's `files:` store (hosts only; empty elsewhere and on a
 *    hand-built host without a store).
 * The pure clock helpers live here too (`bootClockBase`, `clockViewAt`, `rebaseClockBase`, `clockTimezoneOf`), so the
 * runtime and the ctx compute one clock: integer nanoseconds and milliseconds only (no BigInt, no floating division
 * whose floor could round the wrong way), `base + (now − baseAt)` (D19).
 *
 * P3 [S18] (§2.7): `pduSummary` tags a framed GRE leg (`[frame, ipv4, gre, …]`) `tunnel: 'gre'`; P1/P2 PDUs carry no
 * `gre` layer, so their summaries are unchanged.
 */
import { broadcastOf, inSubnet, isIpv4Broadcast, type Ipv4Address, type Ipv6Address, type MacAddress } from '../contracts/addr.js';
import type { Capability, DefaultsProfile } from '../contracts/catalog.js';
import { NF_CLOCK_UNSET_UNIX_MS, NF_WORLD_EPOCH_UNIX_MS, type ClockSource, type DeviceClockView } from '../contracts/clock.js';
import type { ConfigAst, ConfigNode } from '../contracts/config.js';
import type { DeviceModel } from '../contracts/device.js';
import type { DeviceId, PortId, ProcessName } from '../contracts/ids.js';
import type { AirView } from '../contracts/medium.js';
import type { FieldValue, LayerSpec, MutationReason, Pdu, PduFactory, PduMeta, RewrapOp } from '../contracts/pdu.js';
import type { Ipv6PortAddress, PortState, PortView } from '../contracts/port.js';
import type { ClockAction, DebugEvent, FsmTransition, ProcessCtx } from '../contracts/process.js';
import type { RadioSettings } from '../contracts/rf.js';
import type { Rng } from '../contracts/rng.js';
import type { FileSystemId, StoredFile, StoredFileMeta } from '../contracts/storage.js';
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
  /**
   * @since P2 The world's defaults profile (ARCHITECTURE-P2 D2). Optional here so hand-built hosts (test harnesses)
   * keep compiling: an absent value is the P1 profile. The device runtime always provides it.
   */
  readonly profile?: DefaultsProfile;
  /**
   * @since P2 (wireless; W4 device) The radio settings renderer (`DeviceRuntime.radioSettings`: local lines overlaid
   * by the controller profile). Optional so hand-built hosts keep compiling; the device runtime always provides it,
   * and `ctx.radioSettings` exists exactly when it does.
   */
  radioSettings?(port: PortId): RadioSettings | undefined;
  /**
   * @since P3 The device clock at `now` (D19; `DeviceRuntime.clockView`). Optional so hand-built hosts keep compiling:
   * without it `ctx.clock()` is the clock the device would boot with. The device runtime always provides it.
   */
  clockView?(now: SimTime): DeviceClockView;
  /** @since P3 [S32] The files of the host's store (`DeviceRuntimeImpl.files`); absent = an empty store. */
  files?(fs: FileSystemId): readonly StoredFileMeta[];
  /** @since P3 [S32] One file of the host's store, or undefined; absent = an empty store. */
  readFile?(fs: FileSystemId, path: string): StoredFile | undefined;
}

// ── the device clock (P3, ARCHITECTURE-P3 D19; W1 device) ──────────────────────

/** @since P3 Nanoseconds per millisecond (module-private: the clock helpers split ns into ms and a remainder). */
const NS_PER_MS = 1_000_000;

/** @since P3 The time zone of a device clock with no `clock timezone` line. */
export const DEVICE_CLOCK_UTC: DeviceClockView['tz'] = Object.freeze({ name: 'UTC', offsetMin: 0 });

/**
 * @since P3 The stored state of a device clock (D19): the value `unixMs` + `subMsNs` at SimTime `at`, where it came
 * from, and the NTP stratum and reference when a synchronisation or `ntp master` set it. The value at `now` is
 * `base + (now − at)` (`clockViewAt`). Integers only.
 */
export interface DeviceClockBase {
  readonly unixMs: number;
  /** 0 … 999 999. */
  readonly subMsNs: number;
  readonly at: SimTime;
  readonly source: ClockSource;
  readonly stratum?: number;
  readonly reference?: string;
}

/**
 * @since P3 Does a device with these (effective) capabilities keep true time from boot (D19)? Hosts and servers do
 * (source `host`: `host` without `routing`, the host-shell rule); every network device boots unset.
 */
export function isHostClock(capabilities: readonly Capability[]): boolean {
  return capabilities.includes('host') && !capabilities.includes('routing');
}

/**
 * @since P3 The clock a device has after boot and until something sets it (D19): on a host, true time
 * (`NF_WORLD_EPOCH_UNIX_MS` at SimTime 0, source `host`); on a network device, unset — `NF_CLOCK_UNSET_UNIX_MS` plus
 * uptime (at `bootedAt`; while not booted, at `now`, i.e. uptime 0), source `unset`.
 */
export function bootClockBase(capabilities: readonly Capability[], bootedAt: SimTime | undefined, now: SimTime): DeviceClockBase {
  if (isHostClock(capabilities)) return { unixMs: NF_WORLD_EPOCH_UNIX_MS, subMsNs: 0, at: 0, source: 'host' };
  return { unixMs: NF_CLOCK_UNSET_UNIX_MS, subMsNs: 0, at: bootedAt ?? now, source: 'unset' };
}

/** Split an integer count of nanoseconds into whole milliseconds (floored) and the 0 … 999 999 remainder, exactly. */
function splitNs(ns: number): { ms: number; sub: number } {
  const sub = ((ns % NS_PER_MS) + NS_PER_MS) % NS_PER_MS;
  return { ms: (ns - sub) / NS_PER_MS, sub };
}

/**
 * @since P3 The clock view of `base` at `now` (D19): `base + (now − base.at)`, not authoritative (a leading `*`) only
 * while the source is `unset`; `stratum` and `reference` copied when set; `tz` as given.
 */
export function clockViewAt(base: DeviceClockBase, now: SimTime, tz: DeviceClockView['tz'] = DEVICE_CLOCK_UTC): DeviceClockView {
  const { ms, sub } = splitNs(base.subMsNs + (now - base.at));
  const view: { -readonly [K in keyof DeviceClockView]: DeviceClockView[K] } = {
    source: base.source,
    authoritative: base.source !== 'unset',
    unixMs: base.unixMs + ms,
    subMsNs: sub,
    tz: { name: tz.name, offsetMin: tz.offsetMin },
  };
  if (base.stratum !== undefined) view.stratum = base.stratum;
  if (base.reference !== undefined) view.reference = base.reference;
  return view;
}

/** A decimal nanosecond count (`ClockAction.offsetNs`): optional minus sign, digits. */
const OFFSET_NS_RE = /^(-?)([0-9]+)$/;

/**
 * @since P3 The clock after a `clock` action at `now` (D19), from its value at `now` (`current`):
 *  - `step`: `current + offsetNs` (a decimal string, may be negative and beyond 2⁵³ ns: it is split into whole
 *    milliseconds and a sub-millisecond remainder, never converted whole); no `offsetNs` = a zero step;
 *  - `set`: exactly `unixMs` (sub-millisecond 0); no `unixMs` keeps the current value;
 * then `source` from the action, `stratum` and `reference` from the action (absent = cleared). Undefined when the
 * action is malformed (an `offsetNs` that is not a decimal integer, a millisecond part or `unixMs` beyond the safe
 * integers, a stratum that is not an integer 0–16): the runtime then leaves the clock as it was.
 */
export function rebaseClockBase(current: Pick<DeviceClockView, 'unixMs' | 'subMsNs'>, a: ClockAction, now: SimTime): DeviceClockBase | undefined {
  let unixMs = current.unixMs;
  let subMsNs = current.subMsNs;
  if (a.op === 'step') {
    if (a.offsetNs !== undefined) {
      const m = OFFSET_NS_RE.exec(a.offsetNs);
      if (m === null) return undefined;
      const digits = m[2] as string;
      const sign = m[1] === '-' ? -1 : 1;
      const msText = digits.length > 6 ? digits.slice(0, digits.length - 6) : '0';
      const msPart = Number(msText);
      const subPart = Number(digits.length > 6 ? digits.slice(digits.length - 6) : digits);
      if (!Number.isSafeInteger(msPart)) return undefined;
      const { ms, sub } = splitNs(subMsNs + sign * subPart);
      unixMs = unixMs + sign * msPart + ms;
      subMsNs = sub;
      if (!Number.isSafeInteger(unixMs)) return undefined;
    }
  } else if (a.unixMs !== undefined) {
    if (!Number.isSafeInteger(a.unixMs)) return undefined;
    unixMs = a.unixMs;
    subMsNs = 0;
  }
  if (a.stratum !== undefined && (!Number.isInteger(a.stratum) || a.stratum < 0 || a.stratum > 16)) return undefined;
  const base: { -readonly [K in keyof DeviceClockBase]: DeviceClockBase[K] } = { unixMs, subMsNs, at: now, source: a.source };
  if (a.stratum !== undefined) base.stratum = a.stratum;
  if (a.reference !== undefined) base.reference = a.reference;
  return base;
}

/** `clock timezone` hours: an optional sign and one or two digits. */
const TZ_HOURS_RE = /^([+-]?)([0-9]{1,2})$/;
/** `clock timezone` minutes: one or two digits. */
const TZ_MINUTES_RE = /^[0-9]{1,2}$/;

/**
 * @since P3 The time zone the global `clock timezone <name> <±hours> [<minutes>]` line of a running configuration
 * sets (§5.5): `offsetMin = sign · (|hours| · 60 + minutes)`, hours −23…23 and minutes 0…59. Read from the root's
 * `clock` nodes whether the line is stored flat (`clock` with args `timezone …`) or folded (`clock` → `timezone …`).
 * UTC (`DEVICE_CLOCK_UTC`) when the line is absent or malformed.
 */
export function clockTimezoneOf(root: Pick<ConfigNode, 'children'>): DeviceClockView['tz'] {
  for (const node of root.children) {
    if (node.key !== 'clock') continue;
    let args: readonly string[] | undefined;
    if (node.args[0] === 'timezone') args = node.args.slice(1);
    else args = node.children.find((c) => c.key === 'timezone')?.args;
    if (args === undefined) continue;
    const name = args[0];
    const hours = args[1] === undefined ? undefined : TZ_HOURS_RE.exec(args[1]);
    if (name === undefined || name === '' || hours === null || hours === undefined || args.length > 3) return DEVICE_CLOCK_UTC;
    const h = Number(hours[2]);
    const minutesText = args[2];
    if (minutesText !== undefined && !TZ_MINUTES_RE.test(minutesText)) return DEVICE_CLOCK_UTC;
    const m = minutesText === undefined ? 0 : Number(minutesText);
    if (h > 23 || m > 59) return DEVICE_CLOCK_UTC;
    const total = h * 60 + m;
    return { name, offsetMin: hours[1] === '-' ? -total : total };
  }
  return DEVICE_CLOCK_UTC;
}

/**
 * @since P2 How many longest matches `sourceFor`/`sourceFor6` follow for a next hop that is not directly connected
 * (the D13 recursion depth of protocols/ipv4.ts `STATIC_RECURSION_MAX`, kept local so the device layer does not
 * import a protocol module).
 */
export const SOURCE_RECURSION_MAX = 8;

/** Compact trace description of a PDU (optional keys omitted when unset). */
export function pduSummary(pdu: Pdu): PduSummary {
  const s: PduSummary = { id: pdu.id, proto: pdu.topProto(), size: pdu.size, summary: pdu.summary() };
  if (pdu.meta.parent !== undefined) s.parent = pdu.meta.parent;
  if (pdu.meta.flow !== undefined) s.flow = pdu.meta.flow;
  if (pdu.meta.tag !== undefined) s.tag = pdu.meta.tag;
  // P2 (§2.7): the outermost 802.1Q VID of a tagged frame; absent for every untagged frame (P1 bytes unchanged)
  const l1 = pdu.layers[1];
  if (l1 !== undefined && l1.proto === 'dot1q' && typeof l1.fields.vid === 'number') s.vlan = l1.fields.vid;
  // P2 (§2.7, §3.12 step 6): a station frame inside a CAPWAP tunnel — a capwap layer followed by the frame it
  // carries. Control messages and keep-alives carry no frame; P0/P1 PDUs never hold a capwap layer (bytes unchanged).
  // A tunnelled frame has at least five layers (frame, ipv4, udp, capwap, inner frame): shorter PDUs, the hot path
  // of every frame event, skip the walk.
  // P3 [S18] (§2.7): a GRE leg — a gre layer after the frame and the outer ipv4, followed by the packet it carries —
  // is tagged 'gre' (the first tunnel layer found decides). A framed GRE leg also has at least five layers.
  const ls = pdu.layers;
  if (ls.length >= 5) {
    for (let i = 1; i < ls.length - 1; i++) {
      const proto = ls[i]!.proto;
      if (proto === 'gre') {
        s.tunnel = 'gre';
        break;
      }
      // P3 [C13] (ruling R36): an ESP leg of a VTI — an esp layer after the frame and the outer ipv4 — is tagged 'ipsec'
      if (proto === 'esp') {
        s.tunnel = 'ipsec';
        break;
      }
      if (proto !== 'capwap') continue;
      const inner = ls[i + 1]!.proto;
      if (inner === 'dot11' || inner === 'ethernet') s.tunnel = 'capwap';
      break;
    }
  }
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

  /**
   * P2 (D13): the egress port of the longest match for `dst`, following a next hop that is not directly connected
   * through its own longest match — the way protocols/ipv4.ts `resolveVia` forwards transit traffic — at most
   * `SOURCE_RECURSION_MAX` deep, stopping at an `L` row or a route already on the path. With equal-cost paths [S6]
   * the first path is taken (deterministic; the source address is the same for every path out of one port only when
   * they share it, as a real router picks the egress once). Undefined when nothing resolves.
   */
  const egressOf4 = (dst: Ipv4Address): PortId | undefined => {
    let route = lpm(host.tables.rib, dst).winner;
    const visiting = new Set<string>();
    for (let depth = 0; route !== undefined && depth <= SOURCE_RECURSION_MAX; depth++) {
      visiting.add(route.key);
      const path = route.paths !== undefined && route.paths.length > 1 ? route.paths[0]! : route;
      if (path.iface !== undefined) return path.iface;
      if (path.nextHop === undefined) return undefined;
      const direct = connectedPortFor(path.nextHop);
      if (direct !== undefined) return direct;
      const inner = lpm(host.tables.rib, path.nextHop).candidates.find((r) => !visiting.has(r.key));
      if (inner === undefined || inner.source === 'L') return undefined;
      route = inner;
    }
    return undefined;
  };

  // ── IPv6 (P1) ──

  const lpm6 = (dst: Ipv6Address): Lpm6Result => lpm6Over(rib6Rows(host.tables), dst);

  /** The IPv6 twin of `egressOf4` over rib6 (`lpm6`, `connectedPortFor6`). */
  const egressOf6 = (dst: Ipv6Address): PortId | undefined => {
    let route = lpm6(dst).winner;
    const visiting = new Set<string>();
    for (let depth = 0; route !== undefined && depth <= SOURCE_RECURSION_MAX; depth++) {
      visiting.add(route.key);
      const path = route.paths !== undefined && route.paths.length > 1 ? route.paths[0]! : route;
      if (path.iface !== undefined) return path.iface;
      if (path.nextHop === undefined) return undefined;
      const direct = connectedPortFor6(path.nextHop);
      if (direct !== undefined) return direct;
      const inner = lpm6(path.nextHop).candidates.find((r) => !visiting.has(r.key));
      if (inner === undefined || inner.source === 'L') return undefined;
      route = inner;
    }
    return undefined;
  };

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

  // P2 wireless (§2.4): the host's renderer, when it has one (`?.()` keeps the host as `this`)
  const radioSettings = host.radioSettings === undefined
    ? undefined
    : (port: PortId): RadioSettings | undefined => host.radioSettings?.(port);

  // P3 (§2.4, D19, D21): the device clock and [S32] the host's `files:` store, read live from the host
  const clock = (): DeviceClockView => {
    if (host.clockView !== undefined) return host.clockView(host.now);
    return clockViewAt(bootClockBase(host.capabilities, undefined, host.now), host.now);
  };
  const files = (fs: FileSystemId): readonly StoredFileMeta[] => host.files?.(fs) ?? [];
  const readFile = (fs: FileSystemId, path: string): StoredFile | undefined => host.readFile?.(fs, path);

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
    get profile(): DefaultsProfile {
      return host.profile ?? 'P1';
    },
    transition(category: string, message: string, fsm: FsmTransition, data?: Record<string, unknown>): void {
      // Exactly ONE debug event, emitted and recorded like ctx.debug, carrying the transition (D19). The transition is
      // copied so a daemon that reuses its object cannot change an event already in the trace.
      const copy: FsmTransition = { ...fsm };
      const ev: DebugEvent = data === undefined
        ? { at: host.now, device: host.id, process: name, category, message, fsm: copy }
        : { at: host.now, device: host.id, process: name, category, message, data, fsm: copy };
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
      // P2 (D15): a LOCAL virtual address (`virtual4` with `local: true`, HSRP active) counts like an own address;
      // an ARP-only one (NAT pool) does not.
      for (const p of host.ports.values()) {
        if (!p.operUp) continue;
        if (p.l3.ipv4?.address === ip) return true;
        if (p.l3.virtual4 !== undefined && p.l3.virtual4.some((v) => v.local && v.address === ip)) return true;
      }
      if (isIpv4Broadcast(ip)) return true;
      if (inPort !== undefined) {
        const p = host.ports.get(inPort);
        const l3 = p?.operUp ? p.l3.ipv4 : undefined;
        if (l3 !== undefined && broadcastOf(l3.address, l3.prefixLen) === ip) return true;
      }
      // [S2] a joined IPv4 group (`groups4`, written by ipv4 on `ipv4.group`): on `inPort` when given, else any port
      if (inPort !== undefined) return host.ports.get(inPort)?.l3.groups4?.includes(ip) === true;
      for (const p of host.ports.values()) if (p.l3.groups4?.includes(ip) === true) return true;
      // [/S2]
      return false;
    },
    connectedPortFor,
    sourceFor(dst: Ipv4Address): { address: Ipv4Address; iface: PortId } | undefined {
      const iface = egressOf4(dst);
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
      const egress = iface ?? egressOf6(dst);
      if (egress === undefined) return undefined;
      const port = host.ports.get(egress);
      if (port === undefined) return undefined;
      const chosen = selectSource6(port.l3.ipv6 ?? [], dst);
      return chosen === undefined ? undefined : { address: chosen.address, iface: egress };
    },
    ...(radioSettings !== undefined ? { radioSettings } : {}),
    clock,
    files,
    readFile,
  };
  return ctx;
}
