/**
 * protocols/ntp.ts — the NTP daemon: client, server and master (RFC 5905 NTPv4 over UDP 123; ARCHITECTURE-P3 D19,
 * §2.4 `ntp.clockSet` and the `clock` action, §2.6 `ntp-peers` / `clock` / NtpStateView, §3.7, §4.2, §4.3, §5.5).
 *
 * Configuration (global lines, read through `configTextLinesOf`):
 *  • `ntp server <address> [prefer] [source <if>]` (one line per server; a name is not resolved and the line is
 *    ignored with an `ntp events` line); `ntp source <if>` (the source interface of every request without its own);
 *  • `ntp master [<1-15>]` — serve the device's own clock at that stratum, 8 when omitted, even an unset clock (D19).
 *    A server's host line `service ntp on` expands to `ntp master 1` (the CLI's job).
 * Silence (§4.3): with neither line the daemon opens no socket, writes no row and emits nothing. With either, it owns
 * socket `ntp#123` (0.0.0.0:123; fixed port 123 on both ends, no ephemeral draw, §4.1).
 *
 * The clock (D19). The runtime keeps the clock; ntp is its only writer, through the `clock` action, and keeps its own
 * copy of the source, stratum and reference (it issued every change). "Synchronised" (for a client) means source
 * `ntp`; a server answers with a stratum when the source is `ntp` or `master`, else stratum 16, leap 3, refId `INIT`.
 * The one-row `clock` table (key `clock`) is written when a synchronisation, `ntp master` or `clock set` changes the
 * source, stratum, reference or offset (rule 20); it is absent while the clock was never set.
 *  • A valid reply (origin = our last T1, leap ≠ 3, 0 < stratum < 15) while the device is not synchronised by NTP —
 *    and, under `ntp master n`, only when it would give a lower stratum than n — STEPS the clock at once (listed
 *    deviation: no filtering, no slew): θ = floor(((T2 − T1) + (T3 − T4)) / 2) and δ = (T4 − T1) − (T3 − T2) in
 *    exact integer nanoseconds (BigInt inside, decimal strings outside), the action `clock {op: 'step', offsetNs: θ,
 *    source: 'ntp', stratum: s + 1, reference: server}`. Later replies of a synchronised client update the peer row only.
 *  • `ntp master n` (when not synchronised by NTP) is a zero step with source `master`, stratum n and reference
 *    `LOCL` (stratum 1) or `127.127.1.1` (the local-clock address a stratum 2–15 refId must be on the wire).
 *  • `ntp.clockSet {unixMs}` (the CLI's `clock set`) is `clock {op: 'set', unixMs, source: 'user'}`.
 *  • Losing the source — the sys-peer's `ntp server` line or the `ntp master` line removed — is a zero step to
 *    `master` (when `ntp master` is still configured) or to `user` (the value kept, no longer synchronised); the other
 *    servers are kicked.
 *
 * Polling (D19, §4.2). A configured server is polled at once (at configuration or boot), then every 64 s on the
 * periodic `ntp-poll:<server>`. While the device is not synchronised by NTP it also
 *  (1) re-polls at once through a 0 ns coalesced `ntp-kick:<server>` when any of its ports comes up, and when the
 *      longest match toward the server changes (`ipv4.ribWatch {owner: 'ntp', lpm: [servers]}`, registered while
 *      unsynchronised and dropped at synchronisation; the answer ipv4 gives at registration only records the route);
 *  (2) after an unanswered or rejected poll retries on the fixed schedule 1, 2, 4, 8, 16, 32 s (`ntp-retry:<server>`,
 *      non-periodic, six retries, 63 s in all). The first poll and every kick restart the schedule; the periodic poll
 *      never arms it, so after the sixth retry only the periodic poll remains and `runToIdle` returns (rule 19).
 * Requests (mode 3) carry only the transmit timestamp T1 = the device clock; a reply's T4 is the clock at receipt.
 * Reach is the u8 shift register of RFC 5905: a valid reply shifts in a 1; a poll that got no valid answer by the time
 * the next one leaves (or a rejected reply) shifts in a 0. Selection: `sys-peer` (the server the clock follows),
 * `candidate` (valid, not followed), `reject` (the last reply was refused), `unreached` (reach 0).
 * The `ntp-peers` row (key = the configured address) exists while the line does, and is rewritten only when a column
 * other than `updatedAt` changes.
 *
 * Server (mode 4): every request on `ntp#123` is answered at once from the request's destination address: T2 = T3 =
 * the device clock, origin = the request's T1, the poll echoed, version 3 or 4 echoed.
 *
 * Debug categories (§5.8): `ntp packets` (one line per packet sent, received or answered), `ntp events` (servers
 * added and removed, master, kicks, retries, rejections, steps, clock set). The `ntp` FSM transition
 * (unsynchronised ⇄ synchronised, category `ntp events`) is the runtime's, emitted when it applies the `clock` action.
 *
 * stateSnapshot (kind 'ntp', NtpStateView): { peers: [{ address, nextPollAt?, retriesLeft, lastSentAt?, lastReject? }],
 *   master?: { stratum }, served }.
 *
 * ponytail: IPv4 servers only; `prefer` is stored but the first valid reply wins; no authentication (C25), no
 * broadcast or symmetric modes, no drift model (a clock whose server went away keeps its last step).
 */
import { isIpv4, type Ipv4Address } from '../contracts/addr.js';
import { NF_WORLD_EPOCH_UNIX_MS, ntpTimestamp, type ClockSource } from '../contracts/clock.js';
import type { ConfigNode } from '../contracts/config.js';
import type { PortId, ProcessName } from '../contracts/ids.js';
import type { FieldValue } from '../contracts/pdu.js';
import { UDP_PORT_NTP } from '../contracts/pdu.js';
import type { Action, ClockAction, DebugEvent, Process, ProcessCtx, ProcessRequest, StateView } from '../contracts/process.js';
import type { ClockRow, NtpPeerRow, NtpStateView, RouteRow, Table } from '../contracts/tables.js';
import { SEC, type SimTime } from '../contracts/time.js';
import type { ProcessEvent } from '../contracts/transport.js';
import { configTextLinesOf } from '../cli/config-text.js';
import { NTP_LEAP_ALARM, NTP_STRATUM_UNSYNCHRONISED } from '../pdu/codecs/ntp.js';

const NAME: ProcessName = 'ntp';
/** Debug categories (§5.8). */
export const NTP_DEBUG_PACKETS = 'ntp packets';
export const NTP_DEBUG_EVENTS = 'ntp events';
const DEBUG_RING = 256;
/** The daemon's one socket: 0.0.0.0:123 (fixed port on both ends, §4.1). */
export const NTP_SOCKET = 'ntp#123';
/** The poll exponent carried in every packet (2⁶ = 64 s). */
export const NTP_POLL_EXPONENT = 6;
/** The periodic poll interval, in seconds and ns (D19). */
export const NTP_POLL_S = 64;
export const NTP_POLL_NS: SimTime = NTP_POLL_S * SEC;
/** The fast retry schedule of an unsynchronised client: 1, 2, 4, 8, 16 and 32 s (D19, §4.2). */
export const NTP_RETRY_SCHEDULE_NS: readonly SimTime[] = Object.freeze([1, 2, 4, 8, 16, 32].map((s) => s * SEC));
/** `ntp master` without a stratum (D19, as real devices). */
export const NTP_MASTER_DEFAULT_STRATUM = 8;
/** Reference id of a stratum-1 server that serves its own clock. */
export const NTP_REFID_LOCAL = 'LOCL';
/** Reference id of a server that is not synchronised. */
export const NTP_REFID_INIT = 'INIT';
/** Reference of a stratum 2–15 master: the local-clock address (a refId of those strata is an IPv4 address on the wire). */
export const NTP_LOCAL_CLOCK_ADDRESS = '127.127.1.1';
/** Precision announced in every packet (2⁻²⁰ s ≈ 1 µs). */
export const NTP_PRECISION = -20;
/** The text of a zero NTP timestamp. */
const ZERO_TS = '0.000000000';
/** u8 reach register mask. */
const REACH_MASK = 0xff;

const NS_PER_MS_N = 1_000_000n;
const NS_PER_S_N = 1_000_000_000n;
const NTP_UNIX_OFFSET_NS_N = 2_208_988_800n * NS_PER_S_N;
const TIMESTAMP_TEXT = /^(\d{1,10})(?:\.(\d{1,9}))?$/;

// ── configuration ────────────────────────────────────────────────────────────

/** One `ntp server` line. */
export interface NtpServerConfig {
  readonly address: Ipv4Address;
  readonly prefer: boolean;
  /** `source <if>` on the line (overrides `ntp source`). */
  readonly source?: string;
}

/** What the ntp lines of a running configuration ask for. */
export interface NtpConfig {
  /** In configuration order, each address once. */
  readonly servers: readonly NtpServerConfig[];
  /** `ntp master [n]`: the stratum served (8 when omitted). */
  readonly master?: number;
  /** `ntp source <if>`. */
  readonly source?: string;
  /** `ntp server <name>` lines whose target is not an IPv4 address (not resolved). */
  readonly ignored: readonly string[];
}

/** Read the global `ntp …` lines of `root` (§5.5). A malformed `ntp master` stratum is ignored (the line counts as absent). */
export function ntpConfigOf(root: ConfigNode): NtpConfig {
  const servers: NtpServerConfig[] = [];
  const ignored: string[] = [];
  let master: number | undefined;
  let source: string | undefined;
  for (const l of configTextLinesOf(root)) {
    const t = l.tokens;
    if (l.context.length !== 0 || l.negate || t[0] !== 'ntp') continue;
    if (t[1] === 'server' && t[2] !== undefined) {
      if (!isIpv4(t[2])) {
        ignored.push(t[2]);
        continue;
      }
      if (servers.some((s) => s.address === t[2])) continue;
      let prefer = false;
      let src: string | undefined;
      for (let i = 3; i < t.length; i++) {
        if (t[i] === 'prefer') prefer = true;
        else if (t[i] === 'source' && t[i + 1] !== undefined) src = t[++i];
      }
      servers.push(src === undefined ? { address: t[2], prefer } : { address: t[2], prefer, source: src });
    } else if (t[1] === 'master') {
      const n = t[2] === undefined ? NTP_MASTER_DEFAULT_STRATUM : Number(t[2]);
      if (Number.isInteger(n) && n >= 1 && n <= 15) master = n;
    } else if (t[1] === 'source' && t[2] !== undefined) {
      source = t[2];
    }
  }
  const out: { -readonly [K in keyof NtpConfig]: NtpConfig[K] } = { servers, ignored };
  if (master !== undefined) out.master = master;
  if (source !== undefined) out.source = source;
  return out;
}

// ── NTP maths (BigInt inside, decimal strings and safe integers outside; §4.5) ──

/** Nanoseconds since 1900 of an NTP timestamp text (era 0). */
export function ntpNs(text: string): bigint {
  const m = TIMESTAMP_TEXT.exec(text.trim());
  if (m === null) throw new Error(`ntp: "${text}" is not an NTP timestamp`);
  return BigInt(m[1] as string) * NS_PER_S_N + BigInt((m[2] ?? '').padEnd(9, '0'));
}

/** Floor division of BigInts (toward −∞). */
function floorDiv(a: bigint, b: bigint): bigint {
  const q = a / b;
  return (a % b !== 0n && (a < 0n) !== (b < 0n)) ? q - 1n : q;
}

/** A signed nanosecond count split as the tables carry it: whole ms (floored) and 0 … 999 999 ns. */
export function splitOffsetNs(ns: bigint): { offsetMs: number; offsetSubMsNs: number } {
  const ms = floorDiv(ns, NS_PER_MS_N);
  return { offsetMs: Number(ms), offsetSubMsNs: Number(ns - ms * NS_PER_MS_N) };
}

/** The four timestamps of one exchange → offset θ and round-trip delay δ, in integer ns (RFC 5905 §8; θ floored). */
export function ntpOffsetAndDelay(t1: string, t2: string, t3: string, t4: string): { theta: bigint; delta: bigint } {
  const a = ntpNs(t1);
  const b = ntpNs(t2);
  const c = ntpNs(t3);
  const d = ntpNs(t4);
  return { theta: floorDiv(b - a + (c - d), 2n), delta: d - a - (c - b) };
}

/** Clock value at `now` minus true time at `now`, in ns: (unixMs·10⁶ + subMsNs) − (epoch·10⁶ + now). */
function offsetFromTrue(unixMs: number, subMsNs: number, now: SimTime): bigint {
  return BigInt(unixMs) * NS_PER_MS_N + BigInt(subMsNs) - (BigInt(NF_WORLD_EPOCH_UNIX_MS) * NS_PER_MS_N + BigInt(now));
}

/** The NTP text of `ns` nanoseconds since 1900 (non-negative). */
function ntpText(ns: bigint): string {
  const v = ns < 0n ? 0n : ns;
  return `${(v / NS_PER_S_N).toString()}.${(v % NS_PER_S_N).toString().padStart(9, '0')}`;
}

// ── the daemon ──────────────────────────────────────────────────────────────

/** One configured server, as the client sees it. */
interface Peer {
  readonly address: Ipv4Address;
  prefer: boolean;
  source?: string;
  reach: number;
  stratum: number;
  refId: string;
  /** T1 of the last request that has had no reply yet. */
  outstanding?: string;
  lastSentAt?: SimTime;
  lastRxAt?: SimTime;
  lastReject?: string;
  delayNs?: number;
  offsetMs?: number;
  offsetSubMsNs?: number;
  selected: NtpPeerRow['selected'];
  /** Fast retries sent since the last kick; the next delay is NTP_RETRY_SCHEDULE_NS[retries]. */
  retries: number;
  retryArmed: boolean;
  nextPollAt?: SimTime;
  /** Fingerprint of the last longest-match answer seen for this server (undefined until the first answer). */
  lpm?: string;
}

/** The clock as ntp last set it (or found it at boot). */
interface ClockState {
  source: ClockSource;
  stratum?: number;
  reference?: string;
  /** When ntp last set it (for the reference timestamp of replies). */
  refAt?: SimTime;
}

const pollKey = (a: Ipv4Address): string => `ntp-poll:${a}`;
const retryKey = (a: Ipv4Address): string => `ntp-retry:${a}`;
const kickKey = (a: Ipv4Address): string => `ntp-kick:${a}`;

/** Fingerprint of a longest-match answer (what decides "the route toward the server changed"). */
function lpmFingerprint(row: RouteRow | undefined): string {
  if (row === undefined) return 'none';
  return `${row.key}|${row.source}|${row.ad}|${row.nextHop ?? ''}|${row.iface ?? ''}`;
}

/** The reference a master serves at stratum `n` (also its on-the-wire refId). */
export function ntpMasterReference(n: number): string {
  return n <= 1 ? NTP_REFID_LOCAL : NTP_LOCAL_CLOCK_ADDRESS;
}

/** Create the ntp daemon (silent until an `ntp server` or `ntp master` line exists). */
export function createNtp(): Process {
  const peers = new Map<Ipv4Address, Peer>();
  const ring: DebugEvent[] = [];
  let cfg: NtpConfig = { servers: [], ignored: [] };
  let open = false;
  let clk: ClockState = { source: 'unset' };
  /** The lpm list registered with ipv4 (comma-joined; '' = no watch). */
  let watched = '';
  let served = 0;

  function debug(ctx: ProcessCtx, category: string, message: string, data?: Record<string, unknown>): void {
    ctx.debug(category, message, data);
    const ev: DebugEvent = data
      ? { at: ctx.now, device: ctx.deviceId, process: NAME, category, message, data }
      : { at: ctx.now, device: ctx.deviceId, process: NAME, category, message };
    ring.push(ev);
    if (ring.length > DEBUG_RING) ring.splice(0, ring.length - DEBUG_RING);
  }

  const peerTable = (ctx: ProcessCtx): Table<NtpPeerRow> | undefined => ctx.tables.get<NtpPeerRow>('ntp-peers');
  const clockTable = (ctx: ProcessCtx): Table<ClockRow> | undefined => ctx.tables.get<ClockRow>('clock');
  /** Synchronised by NTP: the state that turns the kicks, the retries and the RIB watch off. */
  const synchronised = (): boolean => clk.source === 'ntp';
  /** Does this device serve a stratum (otherwise it answers 16)? */
  const serving = (): boolean => clk.source === 'ntp' || clk.source === 'master';

  // ── rows ──

  /** Write `p`'s row when a column other than updatedAt changed (rule 20). */
  function writePeer(ctx: ProcessCtx, p: Peer): void {
    const t = peerTable(ctx);
    if (t === undefined) return;
    const row: NtpPeerRow = {
      key: p.address,
      updatedAt: ctx.now,
      address: p.address,
      configured: true,
      refId: p.refId,
      stratum: p.stratum,
      pollS: NTP_POLL_S,
      reach: p.reach,
      selected: p.selected,
    };
    if (p.lastRxAt !== undefined) row.lastRxAt = p.lastRxAt;
    if (p.delayNs !== undefined) row.delayNs = p.delayNs;
    if (p.offsetMs !== undefined) row.offsetMs = p.offsetMs;
    if (p.offsetSubMsNs !== undefined) row.offsetSubMsNs = p.offsetSubMsNs;
    const prev = t.get(p.address);
    if (prev !== undefined && sameRow(prev, row)) return;
    t.set(row);
  }

  /** Write the `clock` row for the clock as `clk` says, `offset` ns from true time, when anything shown changed. */
  function writeClock(ctx: ProcessCtx, offset: bigint): void {
    const t = clockTable(ctx);
    if (t === undefined || (clk.source !== 'ntp' && clk.source !== 'master' && clk.source !== 'user')) return;
    const { offsetMs, offsetSubMsNs } = splitOffsetNs(offset);
    const row: ClockRow = { key: 'clock', updatedAt: ctx.now, source: clk.source, offsetMs, offsetSubMsNs, since: ctx.now };
    if (clk.stratum !== undefined) row.stratum = clk.stratum;
    if (clk.reference !== undefined) row.reference = clk.reference;
    const prev = t.get('clock');
    if (prev !== undefined && sameRow({ ...prev, since: 0 }, { ...row, since: 0 })) return;
    t.set(row);
  }

  // ── the clock ──

  /** The device clock's offset from true time now, in ns. */
  function currentOffset(ctx: ProcessCtx): bigint {
    const v = ctx.clock();
    return offsetFromTrue(v.unixMs, v.subMsNs, ctx.now);
  }

  /** A zero step to `source` (master or user): the value is kept, the source, stratum and reference change. */
  function zeroStep(ctx: ProcessCtx, source: 'master' | 'user', stratum?: number): Action[] {
    const offset = currentOffset(ctx);
    const a: ClockAction = { type: 'clock', op: 'step', offsetNs: '0', source };
    if (source === 'master' && stratum !== undefined) {
      a.stratum = stratum;
      a.reference = ntpMasterReference(stratum);
      clk = { source, stratum, reference: a.reference, refAt: ctx.now };
    } else {
      clk = { source, refAt: ctx.now };
    }
    writeClock(ctx, offset);
    return [a];
  }

  /** The clock lost its source (the sys-peer or master line removed): master if configured, else a user clock. */
  function loseSource(ctx: ProcessCtx, why: string): Action[] {
    debug(ctx, NTP_DEBUG_EVENTS, `${why}; the clock keeps its value`, { why });
    const out = cfg.master !== undefined ? zeroStep(ctx, 'master', cfg.master) : zeroStep(ctx, 'user');
    for (const p of peers.values()) {
      if (p.selected === 'sys-peer') {
        p.selected = p.reach === 0 ? 'unreached' : 'candidate';
        writePeer(ctx, p);
      }
      out.push(armKick(p));
    }
    return out;
  }

  // ── polling ──

  /** Record the result of the poll that was outstanding (or of a reply) in reach and selection, then the row. */
  function recordResult(ctx: ProcessCtx, p: Peer, valid: boolean): void {
    p.reach = ((p.reach << 1) | (valid ? 1 : 0)) & REACH_MASK;
    if (!valid && p.reach === 0 && p.selected !== 'reject') p.selected = 'unreached';
    writePeer(ctx, p);
  }

  function sourceAddress(ctx: ProcessCtx, p: Peer): Ipv4Address | undefined {
    const ifName = p.source ?? cfg.source;
    if (ifName === undefined) return undefined;
    return ctx.ports.get(ifName as PortId)?.l3.ipv4?.address;
  }

  /** Send one client request (mode 3) to `p`; the previous one, if still unanswered, counts as a 0 in reach. */
  function sendPoll(ctx: ProcessCtx, p: Peer, why: string): Action[] {
    if (p.outstanding !== undefined) {
      p.outstanding = undefined;
      recordResult(ctx, p, false);
    }
    const t1 = ntpTimestamp(ctx.clock());
    p.outstanding = t1;
    p.lastSentAt = ctx.now;
    const fields: Record<string, FieldValue> = {
      leap: 0,
      version: 4,
      mode: 3,
      stratum: 0,
      poll: NTP_POLL_EXPONENT,
      precision: NTP_PRECISION,
      rootDelay: 0,
      rootDispersion: 0,
      refId: '',
      refTimestamp: ZERO_TS,
      originTimestamp: ZERO_TS,
      receiveTimestamp: ZERO_TS,
      transmitTimestamp: t1,
    };
    const req: Extract<ProcessRequest, { kind: 'udp.send' }> = {
      kind: 'udp.send',
      socket: NTP_SOCKET,
      dst: p.address,
      dstPort: UDP_PORT_NTP,
      tag: 'ntp-request',
      app: [{ proto: 'ntp', fields }],
    };
    const src = sourceAddress(ctx, p);
    if (src !== undefined) req.src = src;
    debug(ctx, NTP_DEBUG_PACKETS, `sent a request to ${p.address} (${why}), transmit ${t1}`, { server: p.address, why, t1 });
    return [{ type: 'request', to: 'udp', req }];
  }

  function armPoll(ctx: ProcessCtx, p: Peer): Action {
    p.nextPollAt = ctx.now + NTP_POLL_NS;
    return { type: 'timer', key: pollKey(p.address), delay: NTP_POLL_NS, periodic: true };
  }

  function armRetry(p: Peer): Action {
    p.retryArmed = true;
    return { type: 'timer', key: retryKey(p.address), delay: NTP_RETRY_SCHEDULE_NS[p.retries] as SimTime };
  }

  function cancelRetry(p: Peer): Action[] {
    if (!p.retryArmed) return [];
    p.retryArmed = false;
    return [{ type: 'cancelTimer', key: retryKey(p.address) }];
  }

  function armKick(p: Peer): Action {
    return { type: 'timer', key: kickKey(p.address), delay: 0 };
  }

  /** A poll that restarts the fast retry schedule (the first poll and every kick), while not synchronised. */
  function pollAndRestart(ctx: ProcessCtx, p: Peer, why: string): Action[] {
    const out = sendPoll(ctx, p, why);
    if (synchronised()) return out;
    out.push(...cancelRetry(p));
    p.retries = 0;
    out.push(armRetry(p));
    return out;
  }

  /** Register or drop the longest-match watch on the servers (only while not synchronised; D8, D19). */
  function updateWatch(): Action[] {
    const list = synchronised() ? [] : [...peers.keys()];
    const key = list.join(',');
    if (key === watched) return [];
    watched = key;
    if (list.length === 0) for (const p of peers.values()) delete p.lpm;
    return [{ type: 'request', to: 'ipv4', req: { kind: 'ipv4.ribWatch', owner: NAME, lpm: list } }];
  }

  // ── configuration ──

  function addPeer(ctx: ProcessCtx, s: NtpServerConfig): Action[] {
    const p: Peer = {
      address: s.address,
      prefer: s.prefer,
      reach: 0,
      stratum: NTP_STRATUM_UNSYNCHRONISED,
      refId: NTP_REFID_INIT,
      selected: 'unreached',
      retries: 0,
      retryArmed: false,
    };
    if (s.source !== undefined) p.source = s.source;
    peers.set(s.address, p);
    debug(ctx, NTP_DEBUG_EVENTS, `server ${s.address} configured`, { server: s.address });
    writePeer(ctx, p);
    const out = pollAndRestart(ctx, p, 'first poll');
    out.push(armPoll(ctx, p));
    return out;
  }

  function removePeer(ctx: ProcessCtx, p: Peer): Action[] {
    peers.delete(p.address);
    const out: Action[] = [
      { type: 'cancelTimer', key: pollKey(p.address) },
      { type: 'cancelTimer', key: kickKey(p.address) },
      ...cancelRetry(p),
    ];
    peerTable(ctx)?.delete(p.address, 'cleared');
    debug(ctx, NTP_DEBUG_EVENTS, `server ${p.address} removed`, { server: p.address });
    if (clk.source === 'ntp' && clk.reference === p.address) out.push(...loseSource(ctx, `the clock followed ${p.address}, which was removed`));
    return out;
  }

  function masterChanged(ctx: ProcessCtx, before: number | undefined): Action[] {
    const n = cfg.master;
    if (n !== undefined) {
      if (synchronised()) {
        debug(ctx, NTP_DEBUG_EVENTS, `master at stratum ${n} configured; the clock keeps following ${clk.reference ?? 'its server'}`, { stratum: n });
        return [];
      }
      debug(ctx, NTP_DEBUG_EVENTS, `serving the device clock as master at stratum ${n}`, { stratum: n });
      return zeroStep(ctx, 'master', n);
    }
    if (before !== undefined && clk.source === 'master') return loseSource(ctx, 'master removed');
    return [];
  }

  /** Re-read the ntp lines and converge: socket, servers, master, watch. */
  function sync(ctx: ProcessCtx): Action[] {
    const next = ntpConfigOf(ctx.config.root);
    const out: Action[] = [];
    const wantOpen = next.servers.length > 0 || next.master !== undefined;
    if (wantOpen && !open) {
      open = true;
      out.push({ type: 'request', to: 'udp', req: { kind: 'udp.open', owner: NAME, socket: NTP_SOCKET, family: 4, localAddr: '0.0.0.0', localPort: UDP_PORT_NTP } });
    }
    for (const name of next.ignored) if (!cfg.ignored.includes(name)) debug(ctx, NTP_DEBUG_EVENTS, `server ${name} ignored: give the server's address`, { server: name });
    const before = cfg.master;
    cfg = next;
    for (const p of [...peers.values()]) if (!next.servers.some((s) => s.address === p.address)) out.push(...removePeer(ctx, p));
    if (next.master !== before) out.push(...masterChanged(ctx, before));
    for (const s of next.servers) {
      const p = peers.get(s.address);
      if (p === undefined) {
        out.push(...addPeer(ctx, s));
        continue;
      }
      p.prefer = s.prefer;
      if (s.source !== undefined) p.source = s.source;
      else delete p.source;
    }
    if (!wantOpen && open) {
      open = false;
      out.push({ type: 'request', to: 'udp', req: { kind: 'udp.close', socket: NTP_SOCKET } });
    }
    out.push(...updateWatch());
    return out;
  }

  // ── packets ──

  /** Answer one client request (mode 4) at once. */
  function serve(ctx: ProcessCtx, f: Readonly<Record<string, FieldValue>>, ev: Extract<ProcessEvent, { kind: 'sock.datagram' }>): Action[] {
    const now = ntpTimestamp(ctx.clock());
    const ok = serving();
    const stratum = ok ? (clk.stratum ?? NTP_STRATUM_UNSYNCHRONISED) : NTP_STRATUM_UNSYNCHRONISED;
    let refId = NTP_REFID_INIT;
    let refTs = ZERO_TS;
    if (ok) {
      refId = clk.source === 'master' ? ntpMasterReference(stratum) : (clk.reference ?? NTP_REFID_INIT);
      const at = clk.refAt ?? ctx.now;
      refTs = ntpText(ntpNs(now) - BigInt(ctx.now - at));
    }
    const fields: Record<string, FieldValue> = {
      leap: ok ? 0 : NTP_LEAP_ALARM,
      version: f.version === 3 ? 3 : 4,
      mode: 4,
      stratum,
      poll: typeof f.poll === 'number' ? f.poll : NTP_POLL_EXPONENT,
      precision: NTP_PRECISION,
      rootDelay: 0,
      rootDispersion: 0,
      refId,
      refTimestamp: refTs,
      originTimestamp: typeof f.transmitTimestamp === 'string' ? f.transmitTimestamp : ZERO_TS,
      receiveTimestamp: now,
      transmitTimestamp: now,
    };
    served++;
    debug(ctx, NTP_DEBUG_PACKETS, `answered ${ev.from} at stratum ${stratum}${ok ? '' : ' (not synchronised)'}`, { client: ev.from, stratum, pdu: ev.pdu.id });
    const req: Extract<ProcessRequest, { kind: 'udp.send' }> = {
      kind: 'udp.send',
      socket: NTP_SOCKET,
      dst: ev.from,
      dstPort: ev.fromPort,
      tag: 'ntp-response',
      triggeredBy: ev.pdu.id,
      app: [{ proto: 'ntp', fields }],
    };
    if (ctx.ownAddress(ev.to) !== undefined) req.src = ev.to;
    return [{ type: 'request', to: 'udp', req }];
  }

  /** A server's reply (mode 4) to one of our requests. */
  function onReply(ctx: ProcessCtx, f: Readonly<Record<string, FieldValue>>, ev: Extract<ProcessEvent, { kind: 'sock.datagram' }>): Action[] {
    const p = peers.get(ev.from);
    if (p === undefined) {
      debug(ctx, NTP_DEBUG_PACKETS, `reply from ${ev.from}, which is not a configured server, ignored`, { from: ev.from, pdu: ev.pdu.id });
      return [];
    }
    const origin = typeof f.originTimestamp === 'string' ? f.originTimestamp : '';
    if (p.outstanding === undefined || origin !== p.outstanding) {
      debug(ctx, NTP_DEBUG_PACKETS, `reply from ${p.address} does not answer the last request (origin ${origin}); ignored`, { server: p.address, pdu: ev.pdu.id });
      return [];
    }
    const t1 = p.outstanding;
    const t4 = ntpTimestamp(ctx.clock());
    p.outstanding = undefined;
    p.lastRxAt = ctx.now;
    const stratum = typeof f.stratum === 'number' ? f.stratum : NTP_STRATUM_UNSYNCHRONISED;
    const leap = typeof f.leap === 'number' ? f.leap : 0;
    p.stratum = stratum;
    p.refId = typeof f.refId === 'string' ? f.refId : '';
    debug(ctx, NTP_DEBUG_PACKETS, `received a reply from ${p.address}: stratum ${stratum}, reference ${p.refId}`, { server: p.address, stratum, pdu: ev.pdu.id });
    let why: string | undefined;
    if (leap === NTP_LEAP_ALARM) why = 'the server is not synchronised (leap alarm)';
    else if (stratum === 0 || stratum >= NTP_STRATUM_UNSYNCHRONISED) why = `the server is at stratum ${stratum}, which means not synchronised`;
    else if (stratum + 1 >= NTP_STRATUM_UNSYNCHRONISED) why = `stratum ${stratum} is too high to follow`;
    if (why !== undefined) {
      p.lastReject = why;
      p.selected = 'reject';
      recordResult(ctx, p, false);
      debug(ctx, NTP_DEBUG_EVENTS, `rejected the reply from ${p.address}: ${why}`, { server: p.address, stratum, leap });
      return [];
    }
    const t2 = typeof f.receiveTimestamp === 'string' ? f.receiveTimestamp : ZERO_TS;
    const t3 = typeof f.transmitTimestamp === 'string' ? f.transmitTimestamp : ZERO_TS;
    const { theta, delta } = ntpOffsetAndDelay(t1, t2, t3, t4);
    const split = splitOffsetNs(theta);
    p.delayNs = Number(delta);
    p.offsetMs = split.offsetMs;
    p.offsetSubMsNs = split.offsetSubMsNs;
    delete p.lastReject;
    const out: Action[] = [...cancelRetry(p)];
    const newStratum = stratum + 1;
    const step = !synchronised() && (clk.source !== 'master' || newStratum < (clk.stratum ?? NTP_STRATUM_UNSYNCHRONISED));
    if (step) {
      for (const q of peers.values()) {
        if (q !== p && q.selected === 'sys-peer') {
          q.selected = 'candidate';
          writePeer(ctx, q);
        }
      }
      p.selected = 'sys-peer';
      recordResult(ctx, p, true);
      const before = clk.source;
      clk = { source: 'ntp', stratum: newStratum, reference: p.address, refAt: ctx.now };
      // the clock after the step: T4 + θ (ns since 1900) → ns since 1970 → minus true time
      const after = ntpNs(t4) + theta - NTP_UNIX_OFFSET_NS_N;
      writeClock(ctx, after - (BigInt(NF_WORLD_EPOCH_UNIX_MS) * NS_PER_MS_N + BigInt(ctx.now)));
      debug(ctx, NTP_DEBUG_EVENTS, `stepped the clock by ${theta.toString()} ns to follow ${p.address} at stratum ${newStratum} (was ${before})`, {
        server: p.address,
        offsetMs: split.offsetMs,
        offsetSubMsNs: split.offsetSubMsNs,
        delayNs: p.delayNs,
      });
      out.push({ type: 'clock', op: 'step', offsetNs: theta.toString(), source: 'ntp', stratum: newStratum, reference: p.address });
      for (const q of peers.values()) out.push(...cancelRetry(q), { type: 'cancelTimer', key: kickKey(q.address) });
      out.push(...updateWatch());
      return out;
    }
    p.selected = clk.source === 'ntp' && clk.reference === p.address ? 'sys-peer' : 'candidate';
    recordResult(ctx, p, true);
    return out;
  }

  // ── requests ──

  function clockSet(ctx: ProcessCtx, req: Extract<ProcessRequest, { kind: 'ntp.clockSet' }>): Action[] {
    if (!Number.isSafeInteger(req.unixMs) || req.unixMs < 0) {
      debug(ctx, NTP_DEBUG_EVENTS, `clock set to ${String(req.unixMs)} refused: not a time the clock can hold`, { unixMs: req.unixMs });
      return req.session !== undefined ? [{ type: 'cliOutput', session: req.session, text: '% That time cannot be set on this clock.\n' }] : [];
    }
    clk = { source: 'user', refAt: ctx.now };
    writeClock(ctx, BigInt(req.unixMs) * NS_PER_MS_N - (BigInt(NF_WORLD_EPOCH_UNIX_MS) * NS_PER_MS_N + BigInt(ctx.now)));
    debug(ctx, NTP_DEBUG_EVENTS, `clock set by the user to ${req.unixMs} ms after 1970`, { unixMs: req.unixMs });
    for (const p of peers.values()) {
      if (p.selected === 'sys-peer') {
        p.selected = p.reach === 0 ? 'unreached' : 'candidate';
        writePeer(ctx, p);
      }
    }
    return [{ type: 'clock', op: 'set', unixMs: req.unixMs, source: 'user' }, ...updateWatch()];
  }

  // ── the process ──

  return {
    name: NAME,

    init(ctx): Action[] {
      const v = ctx.clock();
      clk = { source: v.source };
      if (v.stratum !== undefined) clk.stratum = v.stratum;
      if (v.reference !== undefined) clk.reference = v.reference;
      return sync(ctx);
    },

    onPdu(_ctx, pdu, port): Action[] {
      return [{ type: 'drop', pdu, reason: 'unsupported-protocol', detail: 'ntp takes datagrams from its udp socket', port }];
    },

    onConfig(ctx, delta): Action[] {
      return delta.context.length === 0 && delta.line[0] === 'ntp' ? sync(ctx) : [];
    },

    onLinkChange(_ctx, _port, up): Action[] {
      if (!up || synchronised() || peers.size === 0) return [];
      return [...peers.values()].map((p) => armKick(p));
    },

    onTimer(ctx, key): Action[] {
      const i = key.indexOf(':');
      const kind = key.slice(0, i);
      const p = peers.get(key.slice(i + 1));
      if (p === undefined) return [];
      switch (kind) {
        case 'ntp-poll': {
          const out = sendPoll(ctx, p, 'periodic poll');
          out.push(armPoll(ctx, p));
          return out;
        }
        case 'ntp-kick':
          if (synchronised()) return [];
          debug(ctx, NTP_DEBUG_EVENTS, `polling ${p.address} again now (a port came up or the route changed)`, { server: p.address });
          return pollAndRestart(ctx, p, 'kick');
        case 'ntp-retry': {
          p.retryArmed = false;
          if (synchronised()) return [];
          p.retries++;
          const out = sendPoll(ctx, p, `retry ${p.retries}`);
          if (p.retries < NTP_RETRY_SCHEDULE_NS.length) out.push(armRetry(p));
          else debug(ctx, NTP_DEBUG_EVENTS, `no answer from ${p.address} after ${p.retries} retries; waiting for the periodic poll`, { server: p.address });
          return out;
        }
        default:
          return [];
      }
    },

    onEvent(ctx, ev: ProcessEvent): Action[] {
      if (ev.kind === 'ipv4.ribChanged') {
        if (ev.lpm === undefined) return [];
        const p = peers.get(ev.lpm.address);
        if (p === undefined) return [];
        const fp = lpmFingerprint(ev.lpm.row);
        const first = p.lpm === undefined;
        const changed = p.lpm !== fp;
        p.lpm = fp;
        if (first || !changed || synchronised()) return [];
        return [armKick(p)];
      }
      if (ev.kind === 'sock.error' && ev.socket === NTP_SOCKET) {
        debug(ctx, NTP_DEBUG_PACKETS, `socket error ${ev.code}${ev.detail !== undefined ? ` (${ev.detail})` : ''}`, { code: ev.code });
        return [];
      }
      if (ev.kind !== 'sock.datagram' || ev.socket !== NTP_SOCKET) return [];
      const f = ev.pdu.layers.find((l) => l.proto === 'ntp')?.fields;
      if (f === undefined) return [];
      if (f.mode === 3) return serve(ctx, f, ev);
      if (f.mode === 4) return onReply(ctx, f, ev);
      debug(ctx, NTP_DEBUG_PACKETS, `mode ${String(f.mode)} packet from ${ev.from} ignored`, { from: ev.from, pdu: ev.pdu.id });
      return [];
    },

    onRequest(ctx, req): Action[] {
      return req.kind === 'ntp.clockSet' ? clockSet(ctx, req) : [];
    },

    stateSnapshot(): StateView {
      const view: NtpStateView = {
        peers: [...peers.values()].map((p) => {
          const row: { -readonly [K in keyof NtpStateView['peers'][number]]: NtpStateView['peers'][number][K] } = {
            address: p.address,
            retriesLeft: p.retryArmed ? NTP_RETRY_SCHEDULE_NS.length - p.retries : 0,
          };
          if (p.nextPollAt !== undefined) row.nextPollAt = p.nextPollAt;
          if (p.lastSentAt !== undefined) row.lastSentAt = p.lastSentAt;
          if (p.lastReject !== undefined) row.lastReject = p.lastReject;
          return row;
        }),
        served,
      };
      const state: Record<string, unknown> = { peers: view.peers };
      if (cfg.master !== undefined) state.master = { stratum: cfg.master };
      state.served = served;
      return { process: NAME, state };
    },

    debugEvents(): readonly DebugEvent[] {
      return ring;
    },
  };
}

/** Do two rows hold the same values, `updatedAt` aside (key order independent)? */
function sameRow(a: object, b: object): boolean {
  const ra = a as Record<string, unknown>;
  const rb = b as Record<string, unknown>;
  const keys = new Set([...Object.keys(ra), ...Object.keys(rb)]);
  for (const k of keys) {
    if (k === 'updatedAt') continue;
    if (ra[k] !== rb[k]) return false;
  }
  return true;
}
