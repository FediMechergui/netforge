/**
 * protocols/traffic.ts — the deterministic traffic generator and its receiver (ARCHITECTURE-P3 D16 M13, §2.4
 * `traffic.start` / `traffic.stop` / TrafficFlowSpec, §2.5 the discard rule and `traffic.rx`, §2.6 `flows`, §3.5,
 * §4.1, §4.2, §4.3, §5.4).
 *
 * Sender. `traffic.start {flow, session?}` (the host shell's `flow` job, the Traffic generator app through
 * `hostRequest`) plans the flow (`planTrafficFlow`, pure): IPv4 unicast destination, port (default 9, discard), IP
 * datagram size 60–1500 bytes, exactly one of a rate in kb/s or a packet rate (or a voice preset: G.729 50 pps × 60 B,
 * G.711 50 pps × 200 B, DSCP 46), DSCP 0–63, a count, a duration or neither (continuous). Caps: at most 8 running
 * flows per device, 2 Mb/s and 1000 packets per second per flow, and every flow ends at most
 * TRAFFIC_MAX_DURATION_MS (5 minutes) after it starts — a count or duration beyond that is refused with
 * `trafficFlowCap`. Pacing is fixed: `floor(size · 8 · 10⁹ / bps)` ns for a rate, `floor(10⁹ / pps)` for a packet rate
 * (no jitter, no draw). Every flow is a number of datagrams: the count; ceil(duration / pace); for a continuous flow
 * ceil(5 min / pace) — datagram k leaves at start + k · pace and the last one carries the final flag.
 *  • The flow opens socket `traffic#<id>` through `udp.open` (its ephemeral port from udp's cached stream, drawn only
 *    when a flow starts, §4.1), so the port has a `sockets` row and ICMP errors reach the flow. The datagrams are
 *    built here, `[ipv4 {dscp}, udp, payload]`, and handed to `ipv4.send`: `udp.send` carries no DSCP (reported as a
 *    contract gap); every other field is what udp would write.
 *  • Datagram 0 leaves when udp answers `sock.opened` (in the same dispatch), then the pacing timer `flow:<id>` —
 *    non-periodic for a bounded flow (count or duration: `runToIdle` waits for its end), periodic for a continuous one
 *    (its datagrams commit non-periodic link events, so such a flow is used under `runFor`, rule 19). The cap timer
 *    `flow-cap:<id>` (5 min) is armed for every flow and cancelled when it ends; by construction the last datagram
 *    leaves before it fires. W4 (§4.2's consequences, §10.1 `accept.p3.traffic-bounded`: "an uncongested or finished
 *    flow does not hold `runToIdle`"): the cap timer is non-periodic for a bounded flow and periodic for a continuous
 *    one, whose datagram count is the real cap — so a continuous flow over an uncongested path never holds
 *    `runToIdle`, while one over a congested link still does through its committed link events, until the cap.
 *  • `traffic.stop {id}` ends a running flow at once (no final datagram). With a session, start and stop print one
 *    line (or the refusal) and end the job with `cliDone` (the dhcp-client renew precedent).
 *
 * Payload (the traffic header, original): the marker `NFTG`, the flow id (u8 length + ASCII, 1–14 characters), a u32
 * sequence number, the send time as a u64 of SimTime ns (two u32, high first) and a flags byte whose bit 0 marks the
 * flow's final datagram and (W4) bit 1 a datagram of a continuous flow; zero padding to the datagram size.
 * `decodeTrafficHeader` reads it; `isTrafficPayload` is what udp's discard rule asks. A bounded flow's datagrams carry
 * exactly the W2 bytes (bit 1 clear).
 *
 * Receiver. udp hands over, as `traffic.rx`, a generated datagram that reaches a port with no socket on a device that
 * runs this daemon (the discard rule, §2.5: no port-unreachable). Per (source, flow) the daemon keeps received, the
 * highest sequence, one-way delay (now − send time: min, max, integer average) and RFC 3550 integer jitter (scaled by
 * 16 as in its appendix A.8), and writes the `flows` row (key `${src}|${flow}`): at the first datagram of each received
 * sim-time second, plus one final write by `flow-flush:<key>` (re-armed at every datagram, 1 s after the last one) when
 * something changed since. The flush is non-periodic (`runToIdle` waits for the final write), except after a non-final
 * datagram of a continuous flow (flags bit 1, W4): re-armed at every datagram while such a flow runs, a non-periodic
 * flush would hold `runToIdle` until the cap. `lost` = (highest + 1) − received, so datagrams lost after the highest one
 * received count only once the final datagram arrives; `ended` = the final datagram arrived. A datagram with sequence 0
 * after the key's flow ended or fell silent for 1 s starts a new instance of that flow (the stats restart).
 *
 * Silence (§4.3): nothing is sent without a started flow; a device that only receives writes rows, sends nothing.
 * Debug category `traffic` (a NetForge extension, §5.8): one line per flow event (start, refusal, stop, end, the
 * first datagram of a received flow, the first socket error of a flow) — never one per datagram.
 *
 * stateSnapshot: { flows: [{ id, dst, dstPort, sizeBytes, dscp, paceNs, mode, limit, sent, errors, state, startedAt,
 *   endedAt? }] (running flows, then up to 8 finished ones, newest last), receiving, received }.
 */
import { IPV4_ANY, isIpv4, isIpv4Broadcast, isIpv4Multicast, type IpAddress, type Ipv4Address } from '../contracts/addr.js';
import { CLI_MESSAGES } from '../contracts/cli.js';
import type { ProcessName, SessionId } from '../contracts/ids.js';
import { IPPROTO_UDP, UDP_HEADER, UDP_PORT_DISCARD, type LayerSpec, type Pdu } from '../contracts/pdu.js';
import {
  TRAFFIC_MAX_DURATION_MS,
  type Action,
  type DebugEvent,
  type Process,
  type ProcessCtx,
  type ProcessRequest,
  type StateView,
  type TrafficFlowSpec,
} from '../contracts/process.js';
import type { FlowRow, Table } from '../contracts/tables.js';
import { MS, SEC, type SimTime } from '../contracts/time.js';
import type { ProcessEvent, TrafficRxEvent } from '../contracts/transport.js';
import { flowKey } from '../core/addr6.js';

const NAME: ProcessName = 'traffic';
/** Debug category (§5.8, a NetForge extension). */
export const TRAFFIC_DEBUG = 'traffic';
const DEBUG_RING = 256;
/** The process udp's discard rule hands generated datagrams to. */
export const TRAFFIC_PROCESS: ProcessName = NAME;
/** The traffic header's marker. */
export const TRAFFIC_MARKER = 'NFTG';
const MARKER_BYTES = [0x4e, 0x46, 0x54, 0x47] as const;
/** Flags bit 0: the flow's final datagram. */
export const TRAFFIC_FLAG_FINAL = 0x01;
/** @since P3 W4 Flags bit 1: a datagram of a continuous flow (the receiver's flush after it is periodic). */
export const TRAFFIC_FLAG_CONTINUOUS = 0x02;
/** Caps (§2.4): flows per device, bits and packets per second per flow. */
export const TRAFFIC_MAX_FLOWS = 8;
export const TRAFFIC_MAX_BPS = 2_000_000;
export const TRAFFIC_MAX_PPS = 1000;
/** IP datagram size bounds (§2.4). */
export const TRAFFIC_MIN_BYTES = 60;
export const TRAFFIC_MAX_BYTES = 1500;
/** IPv4 + UDP headers: the payload is the datagram size minus these. */
export const TRAFFIC_IP_UDP_OVERHEAD = 20 + UDP_HEADER;
/** Longest flow id the header carries in the smallest datagram. */
export const TRAFFIC_MAX_ID_LENGTH = 14;
/** The receiver's final write comes this long after the last datagram it saw. */
export const TRAFFIC_FLUSH_NS: SimTime = SEC;
/** Every flow's hard cap, in ns. */
export const TRAFFIC_MAX_DURATION_NS: SimTime = TRAFFIC_MAX_DURATION_MS * MS;
/** Finished flows kept in the StateView. */
const FINISHED_KEPT = 8;
/** The voice presets (§2.4, §5.4: `flow voice <dst> [g711]`). */
export const TRAFFIC_VOICE_PRESETS: Readonly<Record<NonNullable<TrafficFlowSpec['preset']>, { readonly pps: number; readonly sizeBytes: number; readonly dscp: number }>> =
  Object.freeze({
    'voice-g729': Object.freeze({ pps: 50, sizeBytes: 60, dscp: 46 }),
    'voice-g711': Object.freeze({ pps: 50, sizeBytes: 200, dscp: 46 }),
  });
const FLOW_ID = /^[A-Za-z0-9_-]{1,14}$/;

// ── the traffic header ───────────────────────────────────────────────────────

/** One decoded traffic header. */
export interface TrafficHeader {
  readonly flow: string;
  readonly seq: number;
  /** SimTime ns at the sender when the datagram was built. */
  readonly sentAt: SimTime;
  readonly final: boolean;
  /** @since P3 W4 A datagram of a continuous flow (flags bit 1); absent for a bounded flow's datagrams. */
  readonly continuous?: true;
}

/** Header length for a flow id of `idLength` characters. */
export function trafficHeaderLength(idLength: number): number {
  return 4 + 1 + idLength + 4 + 8 + 1;
}

function writeU32(out: Uint8Array, at: number, v: number): void {
  out[at] = (v >>> 24) & 0xff;
  out[at + 1] = (v >>> 16) & 0xff;
  out[at + 2] = (v >>> 8) & 0xff;
  out[at + 3] = v & 0xff;
}

function readU32(b: Uint8Array, at: number): number {
  return ((b[at]! << 24) | (b[at + 1]! << 16) | (b[at + 2]! << 8) | b[at + 3]!) >>> 0;
}

/** The payload of a generated datagram: the header, then zeros up to `payloadBytes` (at least the header). */
export function encodeTrafficPayload(h: TrafficHeader, payloadBytes: number): Uint8Array {
  const id = h.flow;
  const out = new Uint8Array(Math.max(payloadBytes, trafficHeaderLength(id.length)));
  out.set(MARKER_BYTES, 0);
  out[4] = id.length;
  for (let i = 0; i < id.length; i++) out[5 + i] = id.charCodeAt(i) & 0x7f;
  let at = 5 + id.length;
  writeU32(out, at, h.seq >>> 0);
  at += 4;
  const hi = Math.floor(h.sentAt / 4_294_967_296);
  writeU32(out, at, hi);
  writeU32(out, at + 4, h.sentAt - hi * 4_294_967_296);
  at += 8;
  out[at] = (h.final ? TRAFFIC_FLAG_FINAL : 0) | (h.continuous === true ? TRAFFIC_FLAG_CONTINUOUS : 0);
  return out;
}

/** The traffic header at `bytes[start, end)`, or undefined when those bytes do not start with one. */
export function decodeTrafficHeader(bytes: Uint8Array, start = 0, end = bytes.length): TrafficHeader | undefined {
  if (end - start < trafficHeaderLength(1) || end > bytes.length) return undefined;
  for (let i = 0; i < 4; i++) if (bytes[start + i] !== MARKER_BYTES[i]) return undefined;
  const n = bytes[start + 4]!;
  if (n < 1 || n > TRAFFIC_MAX_ID_LENGTH || end - start < trafficHeaderLength(n)) return undefined;
  let flow = '';
  for (let i = 0; i < n; i++) flow += String.fromCharCode(bytes[start + 5 + i]!);
  if (!FLOW_ID.test(flow)) return undefined;
  let at = start + 5 + n;
  const seq = readU32(bytes, at);
  at += 4;
  const sentAt = readU32(bytes, at) * 4_294_967_296 + readU32(bytes, at + 4);
  at += 8;
  const flags = bytes[at]!;
  const final = (flags & TRAFFIC_FLAG_FINAL) !== 0;
  return (flags & TRAFFIC_FLAG_CONTINUOUS) !== 0 ? { flow, seq, sentAt, final, continuous: true } : { flow, seq, sentAt, final };
}

/** Does `bytes[start, end)` start with the traffic header (udp's discard rule, §2.5)? */
export function isTrafficPayload(bytes: Uint8Array, start: number, end: number): boolean {
  return decodeTrafficHeader(bytes, start, end) !== undefined;
}

// ── planning (pure) ──────────────────────────────────────────────────────────

/** A flow as the sender runs it. */
export interface TrafficFlowPlan {
  readonly id: string;
  readonly dst: Ipv4Address;
  readonly dstPort: number;
  readonly sizeBytes: number;
  readonly dscp: number;
  /** Fixed spacing of the datagrams, ns. */
  readonly paceNs: SimTime;
  /** How many datagrams the flow sends in all (the last one carries the final flag). */
  readonly limit: number;
  readonly mode: 'count' | 'duration' | 'continuous';
  /** What the rate was given as: kb/s, or packets per second. */
  readonly rateKbps?: number;
  readonly pps?: number;
}

/** A CLI message with its `{name}` placeholders filled. */
function fill(text: string, values: Readonly<Record<string, string | number>>): string {
  let out = text;
  for (const [k, v] of Object.entries(values)) out = out.split(`{${k}}`).join(String(v));
  return out;
}

/** The lowest free `f<n>`. */
function freeId(busy: ReadonlySet<string>): string {
  for (let n = 1; ; n++) if (!busy.has(`f${n}`)) return `f${n}`;
}

const isWhole = (v: unknown, min: number, max: number): v is number => typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;

/**
 * Check a flow request against the caps and work out its pacing and datagram count (§2.4, D16). `busy` = the ids of the
 * device's running flows. A refusal carries the CLI's text (original wording; `trafficFlowCap` and
 * `trafficTooManyFlows` from CLI_MESSAGES).
 */
export function planTrafficFlow(spec: TrafficFlowSpec, busy: ReadonlySet<string>): { ok: true; plan: TrafficFlowPlan } | { ok: false; error: string } {
  const no = (error: string): { ok: false; error: string } => ({ ok: false, error });
  if (busy.size >= TRAFFIC_MAX_FLOWS) return no(fill(CLI_MESSAGES.trafficTooManyFlows, { max: TRAFFIC_MAX_FLOWS }));
  const id = spec.id ?? freeId(busy);
  if (!FLOW_ID.test(id)) return no(`% A flow name is 1 to ${TRAFFIC_MAX_ID_LENGTH} letters, digits, '-' or '_'.`);
  if (busy.has(id)) return no(`% A flow named ${id} is already running. Stop it first (flow stop ${id}).`);
  const dst = spec.dst;
  if (!isIpv4(dst) || dst === IPV4_ANY || isIpv4Broadcast(dst) || isIpv4Multicast(dst)) return no(`% A flow needs a unicast IPv4 destination; ${dst} is not one.`);
  const dstPort = spec.dstPort ?? UDP_PORT_DISCARD;
  if (!isWhole(dstPort, 1, 0xffff)) return no('% Ports run from 1 to 65535.');
  const preset = spec.preset !== undefined ? TRAFFIC_VOICE_PRESETS[spec.preset] : undefined;
  if (spec.preset !== undefined && preset === undefined) return no(`% There is no voice preset named ${spec.preset}.`);
  const sizeBytes = preset?.sizeBytes ?? spec.sizeBytes;
  if (!isWhole(sizeBytes, TRAFFIC_MIN_BYTES, TRAFFIC_MAX_BYTES)) return no(`% A flow's packets are ${TRAFFIC_MIN_BYTES} to ${TRAFFIC_MAX_BYTES} bytes long.`);
  if (sizeBytes - TRAFFIC_IP_UDP_OVERHEAD < trafficHeaderLength(id.length)) return no(`% The flow name ${id} does not fit in ${sizeBytes}-byte packets; use a shorter name.`);
  const dscp = spec.dscp ?? preset?.dscp ?? 0;
  if (!isWhole(dscp, 0, 63)) return no('% DSCP values run from 0 to 63.');
  let pps = preset?.pps ?? spec.pps;
  let rateKbps = preset !== undefined ? undefined : spec.rateKbps;
  if (preset === undefined && (pps === undefined) === (rateKbps === undefined)) return no('% Give exactly one of a rate (kb/s) or a packet rate (packets per second).');
  const tooFast = `% A flow sends at most ${TRAFFIC_MAX_BPS / 1000} kb/s and ${TRAFFIC_MAX_PPS} packets per second.`;
  let paceNs: number;
  if (rateKbps !== undefined) {
    if (!isWhole(rateKbps, 1, TRAFFIC_MAX_BPS / 1000)) return no(tooFast);
    paceNs = Math.floor((sizeBytes * 8_000_000) / rateKbps);
    if (paceNs < SEC / TRAFFIC_MAX_PPS) return no(tooFast);
    pps = undefined;
  } else {
    if (!isWhole(pps, 1, TRAFFIC_MAX_PPS) || pps * sizeBytes * 8 > TRAFFIC_MAX_BPS) return no(tooFast);
    paceNs = Math.floor(SEC / pps);
    rateKbps = undefined;
  }
  const cap = fill(CLI_MESSAGES.trafficFlowCap, { minutes: TRAFFIC_MAX_DURATION_MS / 60_000 });
  if (spec.count !== undefined && spec.durationMs !== undefined) return no('% Give a packet count or a duration, not both.');
  let limit: number;
  let mode: TrafficFlowPlan['mode'];
  if (spec.count !== undefined) {
    if (!isWhole(spec.count, 1, Number.MAX_SAFE_INTEGER)) return no('% A flow sends at least one packet.');
    if (spec.count > Math.floor(TRAFFIC_MAX_DURATION_NS / paceNs)) return no(cap);
    limit = spec.count;
    mode = 'count';
  } else if (spec.durationMs !== undefined) {
    if (!isWhole(spec.durationMs, 1, Number.MAX_SAFE_INTEGER)) return no('% A flow sends at least one packet.');
    if (spec.durationMs > TRAFFIC_MAX_DURATION_MS) return no(cap);
    limit = Math.ceil((spec.durationMs * MS) / paceNs);
    mode = 'duration';
  } else {
    limit = Math.ceil(TRAFFIC_MAX_DURATION_NS / paceNs);
    mode = 'continuous';
  }
  const plan: { -readonly [K in keyof TrafficFlowPlan]: TrafficFlowPlan[K] } = { id, dst, dstPort, sizeBytes, dscp, paceNs, limit, mode };
  if (rateKbps !== undefined) plan.rateKbps = rateKbps;
  if (pps !== undefined) plan.pps = pps;
  return { ok: true, plan };
}

/** The one line a started flow prints (original wording). */
export function trafficStartedText(p: TrafficFlowPlan): string {
  const rate = p.rateKbps !== undefined ? `${p.rateKbps} kb/s` : `${p.pps ?? 0} packets per second`;
  const how =
    p.mode === 'count'
      ? `${p.limit} packets`
      : p.mode === 'duration'
        ? `${p.limit} packets over ${Math.round((p.limit * p.paceNs) / MS) / 1000} s`
        : `until stopped (at most ${TRAFFIC_MAX_DURATION_MS / 60_000} minutes)`;
  return `Flow ${p.id} started: ${rate} of ${p.sizeBytes}-byte packets to ${p.dst} port ${p.dstPort}, DSCP ${p.dscp}, ${how}.`;
}

// ── the daemon ───────────────────────────────────────────────────────────────

/** A flow this device sends. */
interface SendFlow extends TrafficFlowPlan {
  readonly socket: string;
  readonly startedAt: SimTime;
  srcPort?: number;
  sent: number;
  errors: number;
  state: 'starting' | 'running' | 'ended' | 'stopped';
  endedAt?: SimTime;
}

/** A flow this device receives, keyed `${src}|${flow}`. */
interface RxFlow {
  readonly key: string;
  readonly flow: string;
  readonly src: IpAddress;
  dst: IpAddress;
  dstPort: number;
  dscp: number;
  received: number;
  highest: number;
  delayMin: number;
  delayMax: number;
  delaySum: number;
  /** RFC 3550 jitter scaled by 16 (appendix A.8). */
  jitter16: number;
  lastTransit: number;
  firstAt: SimTime;
  lastAt: SimTime;
  ended: boolean;
  /** Sim-time second of the last row write (−1: none yet). */
  lastWriteSec: number;
  dirty: boolean;
}

const flowTimer = (id: string): string => `flow:${id}`;
const capTimer = (id: string): string => `flow-cap:${id}`;
const flushTimer = (key: string): string => `flow-flush:${key}`;

/** Create the traffic daemon (silent until a flow starts or a generated datagram arrives). */
export function createTraffic(): Process {
  const flows = new Map<string, SendFlow>();
  const finished: SendFlow[] = [];
  const rx = new Map<string, RxFlow>();
  const ring: DebugEvent[] = [];
  let ipId = 0;
  let received = 0;

  function debug(ctx: ProcessCtx, message: string, data?: Record<string, unknown>): void {
    ctx.debug(TRAFFIC_DEBUG, message, data);
    const ev: DebugEvent = data
      ? { at: ctx.now, device: ctx.deviceId, process: NAME, category: TRAFFIC_DEBUG, message, data }
      : { at: ctx.now, device: ctx.deviceId, process: NAME, category: TRAFFIC_DEBUG, message };
    ring.push(ev);
    if (ring.length > DEBUG_RING) ring.splice(0, ring.length - DEBUG_RING);
  }

  /** One line to a session, then the end of its job. */
  function reply(session: SessionId | undefined, text: string): Action[] {
    return session === undefined ? [] : [{ type: 'cliOutput', session, text: `${text}\n` }, { type: 'cliDone', session }];
  }

  // ── sending ──

  function endFlow(ctx: ProcessCtx, f: SendFlow, state: 'ended' | 'stopped', why: string): Action[] {
    flows.delete(f.id);
    f.state = state;
    f.endedAt = ctx.now;
    finished.push(f);
    if (finished.length > FINISHED_KEPT) finished.splice(0, finished.length - FINISHED_KEPT);
    debug(ctx, `flow ${f.id} ${why} after ${f.sent} packets`, { flow: f.id, sent: f.sent, state });
    return [
      { type: 'cancelTimer', key: flowTimer(f.id) },
      { type: 'cancelTimer', key: capTimer(f.id) },
      { type: 'request', to: 'udp', req: { kind: 'udp.close', socket: f.socket } },
    ];
  }

  /** Send the next datagram of `f` and arm the next one (or end the flow after its final datagram). */
  function sendNext(ctx: ProcessCtx, f: SendFlow): Action[] {
    const seq = f.sent;
    const final = seq === f.limit - 1;
    f.sent++;
    const out: Action[] = [];
    const sel = ctx.sourceFor(f.dst);
    if (sel === undefined || f.srcPort === undefined) {
      if (f.errors++ === 0) debug(ctx, `flow ${f.id}: no route to ${f.dst}; packet ${seq} not sent`, { flow: f.id, seq });
    } else {
      ipId = (ipId + 1) & 0xffff;
      const header: TrafficHeader = f.mode === 'continuous' ? { flow: f.id, seq, sentAt: ctx.now, final, continuous: true } : { flow: f.id, seq, sentAt: ctx.now, final };
      const payload = encodeTrafficPayload(header, f.sizeBytes - TRAFFIC_IP_UDP_OVERHEAD);
      const layers: LayerSpec[] = [
        { proto: 'ipv4', fields: { src: sel.address, dst: f.dst, protocol: IPPROTO_UDP, ttl: ctx.model.ipDefaults.ttl, id: ipId, dscp: f.dscp } },
        { proto: 'udp', fields: { srcPort: f.srcPort, dstPort: f.dstPort } },
        { proto: 'payload', fields: { data: payload } },
      ];
      const pdu = ctx.newPdu(layers, { flow: flowKey(4, sel.address, f.dst, 'udp', f.srcPort, f.dstPort), tag: 'traffic' });
      out.push({ type: 'request', to: 'ipv4', req: { kind: 'ipv4.send', pdu, cause: `flow ${f.id}` } });
    }
    if (final) out.push(...endFlow(ctx, f, 'ended', f.mode === 'continuous' ? 'reached the 5-minute cap' : 'finished'));
    else out.push({ type: 'timer', key: flowTimer(f.id), delay: f.paceNs, ...(f.mode === 'continuous' ? { periodic: true } : {}) });
    return out;
  }

  function start(ctx: ProcessCtx, req: Extract<ProcessRequest, { kind: 'traffic.start' }>): Action[] {
    const r = planTrafficFlow(req.flow, new Set(flows.keys()));
    if (!r.ok) {
      debug(ctx, `flow refused: ${r.error.replace(/^% /, '')}`, { dst: req.flow.dst });
      return reply(req.session, r.error);
    }
    const p = r.plan;
    if (ctx.ownAddress(p.dst) !== undefined) return reply(req.session, `% ${p.dst} is this device; a flow goes to another device.`);
    if (ctx.sourceFor(p.dst) === undefined) {
      debug(ctx, `flow ${p.id} refused: no route to ${p.dst}`, { flow: p.id, dst: p.dst });
      return reply(req.session, `% There is no route to ${p.dst}; the flow did not start.`);
    }
    const f: SendFlow = { ...p, socket: `traffic#${p.id}`, startedAt: ctx.now, sent: 0, errors: 0, state: 'starting' };
    flows.set(f.id, f);
    debug(ctx, `flow ${f.id} to ${f.dst} port ${f.dstPort}: ${f.limit} packets of ${f.sizeBytes} bytes every ${f.paceNs} ns, DSCP ${f.dscp} (${f.mode})`, {
      flow: f.id,
      paceNs: f.paceNs,
      limit: f.limit,
    });
    // datagram 0 leaves when udp answers sock.opened, inside this dispatch. W4: so the cap timer is armed BEFORE the
    // socket opens — a flow whose final datagram leaves at once (count 1) has already ended, and cancelled the cap, when
    // a later timer action would arm it: a stray 5-minute timer that held runToIdle. The cap of a continuous flow is
    // periodic (file header).
    return [
      f.mode === 'continuous'
        ? { type: 'timer', key: capTimer(f.id), delay: TRAFFIC_MAX_DURATION_NS, periodic: true }
        : { type: 'timer', key: capTimer(f.id), delay: TRAFFIC_MAX_DURATION_NS },
      { type: 'request', to: 'udp', req: { kind: 'udp.open', owner: NAME, socket: f.socket, family: 4 } },
      ...reply(req.session, trafficStartedText(p)),
    ];
  }

  function stop(ctx: ProcessCtx, req: Extract<ProcessRequest, { kind: 'traffic.stop' }>): Action[] {
    const f = flows.get(req.id);
    if (f === undefined) return reply(req.session, `% There is no running flow named ${req.id}.`);
    const out = endFlow(ctx, f, 'stopped', 'stopped');
    out.push(...reply(req.session, `Flow ${f.id} stopped after ${f.sent} packets.`));
    return out;
  }

  const flowOfSocket = (socket: string): SendFlow | undefined => {
    for (const f of flows.values()) if (f.socket === socket) return f;
    return undefined;
  };

  // ── receiving ──

  function rowOf(s: RxFlow, now: SimTime): FlowRow {
    return {
      key: s.key,
      updatedAt: now,
      flow: s.flow,
      src: s.src,
      dst: s.dst,
      dstPort: s.dstPort,
      dscp: s.dscp,
      received: s.received,
      lost: Math.max(0, s.highest + 1 - s.received),
      delayMinNs: s.delayMin,
      delayMaxNs: s.delayMax,
      delayAvgNs: Math.floor(s.delaySum / s.received),
      jitterNs: Math.floor(s.jitter16 / 16),
      firstAt: s.firstAt,
      lastAt: s.lastAt,
      ended: s.ended,
    };
  }

  function write(ctx: ProcessCtx, s: RxFlow): void {
    s.dirty = false;
    s.lastWriteSec = Math.floor(ctx.now / SEC);
    ctx.tables.get<FlowRow>('flows')?.set(rowOf(s, ctx.now));
  }

  function receive(ctx: ProcessCtx, ev: TrafficRxEvent): Action[] {
    const pdu: Pdu = ev.pdu;
    const udp = pdu.layers.find((l) => l.proto === 'udp');
    if (udp === undefined) return [];
    const h = decodeTrafficHeader(pdu.bytes, udp.offset + UDP_HEADER, udp.offset + udp.length);
    if (h === undefined) return [];
    received++;
    const ip = pdu.layers.find((l) => l.proto === 'ipv4' || l.proto === 'ipv6');
    const dst = String(ip?.fields.dst ?? '');
    const dscp = typeof ip?.fields.dscp === 'number' ? ip.fields.dscp : 0;
    const key = `${ev.from}|${h.flow}`;
    let s = rx.get(key);
    if (s !== undefined && h.seq === 0 && s.received > 0 && (s.ended || ctx.now - s.lastAt >= TRAFFIC_FLUSH_NS)) s = undefined;
    const transit = ctx.now - h.sentAt;
    if (s === undefined) {
      s = {
        key, flow: h.flow, src: ev.from, dst, dstPort: ev.dstPort, dscp, received: 0, highest: -1,
        delayMin: transit, delayMax: transit, delaySum: 0, jitter16: 0, lastTransit: transit,
        firstAt: ctx.now, lastAt: ctx.now, ended: false, lastWriteSec: -1, dirty: false,
      };
      rx.set(key, s);
      debug(ctx, `receiving flow ${h.flow} from ${ev.from} on port ${ev.dstPort}`, { flow: h.flow, from: ev.from, pdu: pdu.id });
    }
    s.received++;
    if (h.seq > s.highest) s.highest = h.seq;
    s.dst = dst;
    s.dstPort = ev.dstPort;
    s.dscp = dscp;
    s.lastAt = ctx.now;
    if (transit < s.delayMin) s.delayMin = transit;
    if (transit > s.delayMax) s.delayMax = transit;
    s.delaySum += transit;
    if (s.received > 1) s.jitter16 += Math.abs(transit - s.lastTransit) - Math.floor((s.jitter16 + 8) / 16);
    s.lastTransit = transit;
    if (h.final) s.ended = true;
    s.dirty = true;
    if (Math.floor(ctx.now / SEC) !== s.lastWriteSec) write(ctx, s);
    // W4: after a non-final datagram of a continuous flow the flush is periodic (file header)
    return h.continuous === true && !h.final
      ? [{ type: 'timer', key: flushTimer(key), delay: TRAFFIC_FLUSH_NS, periodic: true }]
      : [{ type: 'timer', key: flushTimer(key), delay: TRAFFIC_FLUSH_NS }];
  }

  // ── the process ──

  return {
    name: NAME,

    init(): Action[] {
      return [];
    },

    onPdu(_ctx, pdu, port): Action[] {
      return [{ type: 'drop', pdu, reason: 'unsupported-protocol', detail: 'traffic takes datagrams from udp', port }];
    },

    onConfig(): Action[] {
      return [];
    },

    onTimer(ctx, key): Action[] {
      if (key.startsWith('flow-flush:')) {
        const s = rx.get(key.slice('flow-flush:'.length));
        if (s !== undefined && s.dirty) write(ctx, s);
        return [];
      }
      if (key.startsWith('flow-cap:')) {
        const f = flows.get(key.slice('flow-cap:'.length));
        return f === undefined ? [] : endFlow(ctx, f, 'ended', 'reached the 5-minute cap');
      }
      if (key.startsWith('flow:')) {
        const f = flows.get(key.slice('flow:'.length));
        return f === undefined || f.state !== 'running' ? [] : sendNext(ctx, f);
      }
      return [];
    },

    onEvent(ctx, ev: ProcessEvent): Action[] {
      if (ev.kind === 'traffic.rx') return receive(ctx, ev);
      if (ev.kind === 'sock.opened') {
        const f = flowOfSocket(ev.socket);
        if (f === undefined || f.state !== 'starting') return [];
        f.srcPort = ev.localPort;
        f.state = 'running';
        return sendNext(ctx, f);
      }
      if (ev.kind === 'sock.error') {
        const f = flowOfSocket(ev.socket);
        if (f === undefined) return [];
        if (f.state === 'starting') return endFlow(ctx, f, 'stopped', `could not open its socket (${ev.code})`);
        if (f.errors++ === 0) debug(ctx, `flow ${f.id}: ${ev.code}${ev.from !== undefined ? ` reported by ${ev.from}` : ''}`, { flow: f.id, code: ev.code });
      }
      return [];
    },

    onRequest(ctx, req): Action[] {
      if (req.kind === 'traffic.start') return start(ctx, req);
      if (req.kind === 'traffic.stop') return stop(ctx, req);
      return [];
    },

    stateSnapshot(): StateView {
      const view = (f: SendFlow): Record<string, unknown> => {
        const o: Record<string, unknown> = {
          id: f.id, dst: f.dst, dstPort: f.dstPort, sizeBytes: f.sizeBytes, dscp: f.dscp, paceNs: f.paceNs, mode: f.mode,
          limit: f.limit, sent: f.sent, errors: f.errors, state: f.state, startedAt: f.startedAt,
        };
        if (f.endedAt !== undefined) o.endedAt = f.endedAt;
        return o;
      };
      return { process: NAME, state: { flows: [...[...flows.values()].map(view), ...finished.map(view)], receiving: rx.size, received } };
    },

    debugEvents(): readonly DebugEvent[] {
      return ring;
    },
  };
}
