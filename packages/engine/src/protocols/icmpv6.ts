/**
 * protocols/icmpv6.ts — the ICMPv6 daemon (ARCHITECTURE-P1 §4.2, §4.6, §4.7; RFC 4443).
 *
 * Jobs
 *  • Echo responder: an echo request (128) delivered by ipv6 is answered with an echo reply (129) with the same
 *    identifier, sequence and data (`meta.triggeredBy` = the request), sourced from the destination when it is an own
 *    unicast address, otherwise from the address selected for the requester on the ingress port (multicast pings).
 *  • Error generation (`icmp6.error` from ipv6 and nd): destination unreachable (1), packet too big (2, `param` =
 *    MTU), time exceeded (3), parameter problem (4, `param` = pointer), quoting as much of the invoking packet as fits
 *    in the 1280-byte minimum MTU. Never sent (RFC 4443 §2.4 e) in answer to an ICMPv6 error, to a packet from the
 *    unspecified or a multicast source, or to a packet sent to a multicast group or a link-layer group address —
 *    except packet too big and parameter problem code 2 for the last two.
 *  • The ping job (`icmp6.ping` from the CLI, `ping -6`): one state machine per CLI session sending `count` echo
 *    requests (hop limit `hopLimit` or the device default) — the next one right after an answer, or after
 *    `timeoutNs` — printing `!` (reply), `.` (timeout), `U` (unreachable, packet too big, parameter problem) or `T`
 *    (hop limit exceeded), then a statistics line and `cliDone`. `job.abort` (or `icmp.abort`) ends it early.
 *  • Probes (`icmp6.probe`, traceroute ICMP mode over IPv6): one echo request with the given hop limit, timer
 *    `probe:<token>`; the answer (reply, time exceeded, unreachable) goes to the owner as ProcessEvent `icmp.result`.
 *    A probe that meets its timer is reported with outcome `timeout` and forgotten; no source → `no-route` at once.
 *  • Error fan-back (§4.2): an error quoting UDP or TCP is delivered to the `udp` / `tcp` daemon (when the model runs
 *    it), which reads the error layer and the quoted datagram; errors quoting echo requests go to the ping jobs and
 *    probes.
 *
 * Originated packets use `model.ipDefaults.hopLimit` (routers 255, hosts 64) unless a job gives one.
 * `sizeBytes` of a ping is the IPv6 packet length (40-byte header + 8-byte echo header + data; minimum 48).
 *
 * Timer keys: `ping6:<session>` (send the next echo), `ping6-timeout:<session>`, `probe:<token>`.
 * Debug category: 'ipv6 icmp'.
 *
 * stateSnapshot():
 *   { process: 'icmpv6', state: { jobs: [{ session, target, sent, received, lost, seq }], probes: [{ token, target,
 *     hopLimit }], repliesSent, errorsSent, errorsSuppressed } }
 */
import { isMulticastMac, type Ipv6Address } from '../contracts/addr.js';
import type { PortId, ProcessName, SessionId } from '../contracts/ids.js';
import {
  ICMPV6_DEST_UNREACHABLE,
  ICMPV6_ECHO_REPLY,
  ICMPV6_ECHO_REQUEST,
  ICMPV6_PACKET_TOO_BIG,
  ICMPV6_PARAM_PROBLEM,
  ICMPV6_TIME_EXCEEDED,
  IPPROTO_ICMPV6,
  IPV6_HEADER,
  IPV6_MIN_MTU,
  type LayerView,
  type Pdu,
  type PduMeta,
} from '../contracts/pdu.js';
import type { Action, DebugEvent, Process, ProcessCtx, ProcessRequest, StateView } from '../contracts/process.js';
import { MS, SEC, type SimTime } from '../contracts/time.js';
import type { ProbeResultEvent } from '../contracts/transport.js';
import { flowKey, normalizeIpv6 } from '../core/addr6.js';
import { isIcmpv6Error } from '../pdu/codecs/icmpv6.js';
import { hasProcess, ipv6Helpers, isLinkScoped6, isMulticast6, isUnspecified6, originatedHopLimit, preferredLinkLocal } from './ipv6.js';

/** Process name, as registered in the protocol registry. */
const NAME = 'icmpv6';
/** Debug category. */
const CAT = 'ipv6 icmp';
/** Number of DebugEvents retained by `debugEvents()`. */
const DEBUG_RING = 256;
/** ICMPv6 header of an echo message. */
const ECHO_HEADER = 8;
/** IPv6 header + echo header: what `sizeBytes` covers besides the data. */
export const ICMPV6_ECHO_OVERHEAD = IPV6_HEADER + ECHO_HEADER;
/** An error message must fit the minimum MTU (RFC 4443 §2.4 c): the quote gets what is left. */
export const ICMPV6_MAX_QUOTE = IPV6_MIN_MTU - IPV6_HEADER - ECHO_HEADER;
/** First identifier of traceroute probes (ping job identifiers count up from 1). */
const PROBE_ID_BASE = 0x8000;
const TIMER_PING = 'ping6:';
const TIMER_PING_TIMEOUT = 'ping6-timeout:';
const TIMER_PROBE = 'probe:';

/** One ping job (per CLI session). */
interface PingJob {
  session: SessionId;
  target: Ipv6Address;
  count: number;
  timeoutNs: SimTime;
  sizeBytes: number;
  id: number;
  seq: number;
  sent: number;
  received: number;
  lost: number;
  rtts: SimTime[];
  sentAt: SimTime;
  outstanding: boolean;
  source?: Ipv6Address;
  hopLimit?: number;
}

/** One outstanding traceroute probe. */
interface Probe {
  token: string;
  owner: ProcessName;
  target: Ipv6Address;
  hopLimit: number;
  id: number;
  seq: number;
  sentAt: SimTime;
}

/** Where an echo leaves from: the source address and, for link-scoped targets, the egress port. */
interface EchoRoute {
  src: Ipv6Address;
  iface?: PortId;
}

/** Nanoseconds → milliseconds with two decimals (`1.25`). */
function formatMs(ns: SimTime): string {
  return (ns / MS).toFixed(2);
}

/** Seconds for the header line: whole seconds as an integer, otherwise two decimals. */
function formatSeconds(ns: SimTime): string {
  const s = ns / SEC;
  return Number.isInteger(s) ? String(s) : s.toFixed(2);
}

/** Deterministic echo data: bytes 0x00, 0x01, … wrapping at 0xff. */
function pattern(n: number): Uint8Array {
  const out = new Uint8Array(Math.max(0, n));
  for (let i = 0; i < out.length; i++) out[i] = i & 0xff;
  return out;
}

/** Index of the first ipv6 layer, or -1. */
function ipIndexOf(pdu: Pdu): number {
  for (let i = 0; i < pdu.layers.length; i++) if (pdu.layers[i]!.proto === 'ipv6') return i;
  return -1;
}

/** Index of the first icmpv6 layer after `from`, or -1. */
function icmpIndexAfter(pdu: Pdu, from: number): number {
  for (let i = from + 1; i < pdu.layers.length; i++) if (pdu.layers[i]!.proto === 'icmpv6') return i;
  return -1;
}

/** Echo data following the echo layer at `idx`. */
function echoData(pdu: Pdu, idx: number): Uint8Array {
  const next = pdu.layers[idx + 1];
  if (next && next.proto === 'payload' && next.fields.data instanceof Uint8Array) return next.fields.data;
  const l = pdu.layers[idx]!;
  const start = l.offset + l.headerLength;
  const end = l.offset + l.length - (l.trailerLength ?? 0);
  return pdu.bytes.slice(start, Math.max(start, end));
}

/** The quoted datagram of an error at `errIdx`: its ipv6 header and first upper layer (icmpv6, udp or tcp). */
function quotedOf(pdu: Pdu, errIdx: number): { ip?: LayerView; upper?: LayerView } {
  let ip: LayerView | undefined;
  for (let i = errIdx + 1; i < pdu.layers.length; i++) {
    const l = pdu.layers[i]!;
    if (ip === undefined) {
      if (l.proto === 'ipv6') ip = l;
      continue;
    }
    if (l.proto === 'icmpv6' || l.proto === 'udp' || l.proto === 'tcp') return { ip, upper: l };
  }
  return ip === undefined ? {} : { ip };
}

/** Error type → the tag of the error PDU. */
function errorTag(type: number): string {
  switch (type) {
    case ICMPV6_DEST_UNREACHABLE:
      return 'icmp6-unreachable';
    case ICMPV6_PACKET_TOO_BIG:
      return 'icmp6-packet-too-big';
    case ICMPV6_TIME_EXCEEDED:
      return 'icmp6-time-exceeded';
    case ICMPV6_PARAM_PROBLEM:
      return 'icmp6-parameter-problem';
    default:
      return `icmp6-type-${type}`;
  }
}

/**
 * Create the ICMPv6 daemon. Reached only via `deliver` (from ipv6) and requests (`icmp6.ping`, `icmp6.probe`,
 * `icmp6.error`, `job.abort`); it has no wire selector.
 */
export function createIcmpv6(): Process {
  const jobs = new Map<SessionId, PingJob>();
  const probes = new Map<string, Probe>();
  const ring: DebugEvent[] = [];
  let nextJobId = 1;
  let nextProbe = 0;
  let repliesSent = 0;
  let errorsSent = 0;
  let errorsSuppressed = 0;

  function debug(ctx: ProcessCtx, message: string, data?: Record<string, unknown>): void {
    ctx.debug(CAT, message, data);
    const ev: DebugEvent = data
      ? { at: ctx.now, device: ctx.deviceId, process: NAME, category: CAT, message, data }
      : { at: ctx.now, device: ctx.deviceId, process: NAME, category: CAT, message };
    ring.push(ev);
    if (ring.length > DEBUG_RING) ring.splice(0, ring.length - DEBUG_RING);
  }

  /** Source (and, for link-scoped targets, the egress port) of an echo to `target`. */
  function echoRoute(ctx: ProcessCtx, target: Ipv6Address, source?: Ipv6Address): EchoRoute | undefined {
    if (isLinkScoped6(target)) {
      for (const view of ctx.ports.values()) {
        if (!view.operUp || view.l3.ipv6Enabled !== true) continue;
        const ll = preferredLinkLocal(view);
        if (ll !== undefined) return { src: source ?? ll, iface: view.id };
      }
      return undefined;
    }
    const r = ipv6Helpers(ctx).sourceFor6(target);
    if (r === undefined) return undefined;
    return { src: source ?? r.address };
  }

  /** Build an echo request and the `ipv6.send` for it. */
  function echoRequest(ctx: ProcessCtx, route: EchoRoute, target: Ipv6Address, id: number, seq: number, sizeBytes: number, hopLimit: number, tag: string, cause: string): { pdu: Pdu; action: Action } {
    const pdu = ctx.newPdu(
      [
        { proto: 'ipv6', fields: { src: route.src, dst: target, nextHeader: IPPROTO_ICMPV6, hopLimit } },
        { proto: 'icmpv6', fields: { type: ICMPV6_ECHO_REQUEST, code: 0, id, seq } },
        { proto: 'payload', fields: { data: pattern(sizeBytes - ICMPV6_ECHO_OVERHEAD) } },
      ],
      { flow: flowKey(6, route.src, target, 'icmpv6'), tag },
    );
    const req: ProcessRequest = { kind: 'ipv6.send', pdu, cause };
    if (route.iface !== undefined) req.iface = route.iface;
    return { pdu, action: { type: 'request', to: 'ipv6', req } };
  }

  // ── ping job ────────────────────────────────────────────────────────────

  function statsLine(job: PingJob): string {
    const pct = job.sent === 0 ? 0 : Math.round((job.lost * 100) / job.sent);
    let line = `\nSent ${job.sent}, received ${job.received}, lost ${job.lost} (${pct}% loss)`;
    if (job.received > 0) {
      let min = job.rtts[0]!;
      let max = min;
      let sum = 0;
      for (const r of job.rtts) {
        if (r < min) min = r;
        if (r > max) max = r;
        sum += r;
      }
      const avg = Math.round(sum / job.rtts.length);
      line += `, round-trip min/avg/max = ${formatMs(min)}/${formatMs(avg)}/${formatMs(max)} ms`;
    }
    return `${line}\n`;
  }

  function finish(ctx: ProcessCtx, job: PingJob, why: string): Action[] {
    if (job.outstanding) {
      job.outstanding = false;
      job.lost++;
    }
    jobs.delete(job.session);
    debug(ctx, `ping ${job.target} finished (${why}): sent ${job.sent} received ${job.received} lost ${job.lost}`, {
      session: job.session, target: job.target, sent: job.sent, received: job.received, lost: job.lost,
    });
    return [
      { type: 'cancelTimer', key: `${TIMER_PING_TIMEOUT}${job.session}` },
      { type: 'cancelTimer', key: `${TIMER_PING}${job.session}` },
      { type: 'cliOutput', session: job.session, text: statsLine(job) },
      { type: 'cliDone', session: job.session },
    ];
  }

  function sendNext(ctx: ProcessCtx, job: PingJob): Action[] {
    if (job.seq >= job.count) return finish(ctx, job, 'complete');
    const route = echoRoute(ctx, job.target, job.source);
    if (route === undefined) {
      debug(ctx, `ping ${job.target}: no IPv6 route from this device`, { session: job.session, target: job.target });
      const actions: Action[] = [{ type: 'cliOutput', session: job.session, text: `No IPv6 route to ${job.target} from this device.\n` }];
      if (job.sent > 0) return actions.concat(finish(ctx, job, 'no route'));
      jobs.delete(job.session);
      actions.push({ type: 'cliDone', session: job.session });
      return actions;
    }
    job.seq++;
    const { pdu, action } = echoRequest(ctx, route, job.target, job.id, job.seq, job.sizeBytes, job.hopLimit ?? originatedHopLimit(ctx), `ping6#${job.seq}`, `ping ${job.target}`);
    job.sent++;
    job.sentAt = ctx.now;
    job.outstanding = true;
    debug(ctx, `echo request ${route.src} > ${job.target} id=${job.id} seq=${job.seq}`, { session: job.session, pdu: pdu.id, id: job.id, seq: job.seq });
    return [action, { type: 'timer', key: `${TIMER_PING_TIMEOUT}${job.session}`, delay: job.timeoutNs }];
  }

  function advance(ctx: ProcessCtx, job: PingJob, mark: string): Action[] {
    job.outstanding = false;
    const actions: Action[] = [{ type: 'cliOutput', session: job.session, text: mark }, { type: 'cancelTimer', key: `${TIMER_PING_TIMEOUT}${job.session}` }];
    if (job.seq >= job.count) return actions.concat(finish(ctx, job, 'complete'));
    actions.push({ type: 'timer', key: `${TIMER_PING}${job.session}`, delay: 0 });
    return actions;
  }

  function matchJob(id: number, seq: number): PingJob | undefined {
    for (const job of jobs.values()) if (job.outstanding && job.id === id && job.seq === seq) return job;
    return undefined;
  }

  function matchProbe(id: number, seq: number): Probe | undefined {
    for (const p of probes.values()) if (p.id === id && p.seq === seq) return p;
    return undefined;
  }

  function startPing(ctx: ProcessCtx, req: Extract<ProcessRequest, { kind: 'icmp6.ping' }>): Action[] {
    const actions: Action[] = [];
    const existing = jobs.get(req.session);
    if (existing) actions.push(...finish(ctx, existing, 'replaced'));
    const target = normalizeIpv6(req.target);
    if (target === null) {
      actions.push({ type: 'cliOutput', session: req.session, text: `${req.target} is not an IPv6 address.\n` }, { type: 'cliDone', session: req.session });
      return actions;
    }
    const job: PingJob = {
      session: req.session,
      target,
      count: Math.max(1, Math.floor(req.count)),
      timeoutNs: req.timeoutNs,
      sizeBytes: Math.max(ICMPV6_ECHO_OVERHEAD, Math.floor(req.sizeBytes)),
      id: nextJobId++ & 0x7fff,
      seq: 0,
      sent: 0,
      received: 0,
      lost: 0,
      rtts: [],
      sentAt: ctx.now,
      outstanding: false,
    };
    if (req.source !== undefined) {
      const s = normalizeIpv6(req.source);
      if (s !== null) job.source = s;
    }
    if (req.hopLimit !== undefined) job.hopLimit = Math.max(1, Math.min(255, Math.floor(req.hopLimit)));
    jobs.set(job.session, job);
    debug(ctx, `ping ${target} started: ${job.count} echoes, ${job.sizeBytes} bytes, timeout ${formatSeconds(job.timeoutNs)} s`, { session: job.session, target, id: job.id });
    if (echoRoute(ctx, target, job.source) !== undefined) {
      actions.push({
        type: 'cliOutput',
        session: job.session,
        text: `Sending ${job.count} echo requests to ${target}, ${job.sizeBytes}-byte packets, timeout ${formatSeconds(job.timeoutNs)} s:\n`,
      });
    }
    return actions.concat(sendNext(ctx, job));
  }

  // ── probes ──────────────────────────────────────────────────────────────

  function result(probe: Probe, outcome: ProbeResultEvent['outcome'], extra: Partial<ProbeResultEvent>): Action {
    const ev: ProbeResultEvent = { kind: 'icmp.result', token: probe.token, outcome, sentAt: probe.sentAt, ...extra };
    return { type: 'event', to: probe.owner, ev };
  }

  function startProbe(ctx: ProcessCtx, req: Extract<ProcessRequest, { kind: 'icmp6.probe' }>): Action[] {
    const out: Action[] = [];
    const previous = probes.get(req.token);
    if (previous !== undefined) {
      probes.delete(req.token);
      out.push({ type: 'cancelTimer', key: `${TIMER_PROBE}${req.token}` });
    }
    const n = nextProbe++;
    const target = normalizeIpv6(req.target) ?? req.target;
    const probe: Probe = {
      token: req.token,
      owner: req.owner,
      target,
      hopLimit: Math.max(1, Math.min(255, Math.floor(req.hopLimit))),
      id: PROBE_ID_BASE + ((n >>> 16) & 0x7fff),
      seq: n & 0xffff,
      sentAt: ctx.now,
    };
    const route = normalizeIpv6(req.target) === null ? undefined : echoRoute(ctx, target);
    if (route === undefined) {
      debug(ctx, `probe ${req.token} to ${target}: no IPv6 route`, { token: req.token, target });
      out.push(result(probe, 'no-route', {}));
      return out;
    }
    const size = Math.max(ICMPV6_ECHO_OVERHEAD, Math.floor(req.sizeBytes ?? ICMPV6_ECHO_OVERHEAD + 32));
    const { pdu, action } = echoRequest(ctx, route, target, probe.id, probe.seq, size, probe.hopLimit, `probe6 ${req.token}`, `trace ${target}`);
    probes.set(req.token, probe);
    debug(ctx, `probe ${req.token} to ${target} hop limit ${probe.hopLimit}`, { token: req.token, pdu: pdu.id, id: probe.id, seq: probe.seq });
    out.push(action, { type: 'timer', key: `${TIMER_PROBE}${req.token}`, delay: req.timeoutNs });
    return out;
  }

  function settleProbe(probe: Probe, out: Action[]): void {
    probes.delete(probe.token);
    out.push({ type: 'cancelTimer', key: `${TIMER_PROBE}${probe.token}` });
  }

  // ── responder and receive ───────────────────────────────────────────────

  function replyTo(ctx: ProcessCtx, pdu: Pdu, ip: LayerView, idx: number, port: PortId): Action[] {
    const h = ipv6Helpers(ctx);
    const icmp = pdu.layers[idx]!;
    const reqSrc = normalizeIpv6(String(ip.fields.src)) ?? String(ip.fields.src);
    const reqDst = normalizeIpv6(String(ip.fields.dst)) ?? String(ip.fields.dst);
    if (isUnspecified6(reqSrc)) {
      return [{ type: 'drop', pdu, reason: 'other', detail: 'echo request from the unspecified address', port }];
    }
    let src: Ipv6Address | undefined = !isMulticast6(reqDst) && h.ownAddress6(reqDst) !== undefined ? reqDst : undefined;
    src ??= h.sourceFor6(reqSrc, port)?.address ?? h.sourceFor6(reqSrc)?.address;
    if (src === undefined) {
      debug(ctx, `echo request ${reqSrc} > ${reqDst} on ${port}: no address to answer from`, { pdu: pdu.id, port });
      return [{ type: 'drop', pdu, reason: 'no-l3-address', detail: `no IPv6 address on ${port} to answer from`, port }];
    }
    const id = Number(icmp.fields.id ?? 0);
    const seq = Number(icmp.fields.seq ?? 0);
    const meta: Partial<PduMeta> = { triggeredBy: pdu.id, flow: pdu.meta.flow ?? flowKey(6, reqSrc, reqDst, 'icmpv6'), tag: 'echo6-reply' };
    const reply = ctx.newPdu(
      [
        { proto: 'ipv6', fields: { src, dst: reqSrc, nextHeader: IPPROTO_ICMPV6, hopLimit: originatedHopLimit(ctx) } },
        { proto: 'icmpv6', fields: { type: ICMPV6_ECHO_REPLY, code: 0, id, seq } },
        { proto: 'payload', fields: { data: echoData(pdu, idx) } },
      ],
      meta,
    );
    repliesSent++;
    debug(ctx, `echo request ${reqSrc} > ${reqDst} id=${id} seq=${seq}: reply ${src} > ${reqSrc}`, { request: pdu.id, reply: reply.id, id, seq, port });
    const req: ProcessRequest = { kind: 'ipv6.send', pdu: reply, cause: 'echo reply' };
    if (isLinkScoped6(reqSrc)) req.iface = port;
    return [{ type: 'consume', pdu }, { type: 'request', to: 'ipv6', req }];
  }

  function onEchoReply(ctx: ProcessCtx, pdu: Pdu, ip: LayerView, icmp: LayerView): Action[] {
    const id = Number(icmp.fields.id ?? -1);
    const seq = Number(icmp.fields.seq ?? -1);
    const from = String(ip.fields.src);
    const out: Action[] = [{ type: 'consume', pdu }];
    const job = matchJob(id, seq);
    if (job !== undefined) {
      const rtt = ctx.now - job.sentAt;
      job.received++;
      job.rtts.push(rtt);
      debug(ctx, `echo reply from ${from} id=${id} seq=${seq} rtt ${formatMs(rtt)} ms`, { pdu: pdu.id, session: job.session, id, seq, rtt });
      return out.concat(advance(ctx, job, '!'));
    }
    const probe = matchProbe(id, seq);
    if (probe !== undefined) {
      settleProbe(probe, out);
      debug(ctx, `probe ${probe.token}: echo reply from ${from}`, { pdu: pdu.id, token: probe.token });
      out.push(result(probe, 'reply', { from, type: ICMPV6_ECHO_REPLY, code: 0, pdu }));
      return out;
    }
    debug(ctx, `echo reply from ${from} id=${id} seq=${seq}: no matching ping or probe`, { pdu: pdu.id, id, seq });
    return out;
  }

  function onError(ctx: ProcessCtx, pdu: Pdu, ip: LayerView, idx: number, port: PortId): Action[] {
    const icmp = pdu.layers[idx]!;
    const type = Number(icmp.fields.type);
    const code = Number(icmp.fields.code ?? 0);
    const from = String(ip.fields.src);
    const quoted = quotedOf(pdu, idx);
    const upper = quoted.upper;
    if (upper !== undefined && upper.proto === 'icmpv6' && Number(upper.fields.type) === ICMPV6_ECHO_REQUEST) {
      const id = Number(upper.fields.id ?? -1);
      const seq = Number(upper.fields.seq ?? -1);
      const out: Action[] = [{ type: 'consume', pdu }];
      const job = matchJob(id, seq);
      if (job !== undefined) {
        job.lost++;
        debug(ctx, `error type ${type} code ${code} from ${from} for id=${id} seq=${seq}`, { pdu: pdu.id, session: job.session, type, code });
        return out.concat(advance(ctx, job, type === ICMPV6_TIME_EXCEEDED ? 'T' : 'U'));
      }
      const probe = matchProbe(id, seq);
      if (probe !== undefined) {
        settleProbe(probe, out);
        debug(ctx, `probe ${probe.token}: error type ${type} code ${code} from ${from}`, { pdu: pdu.id, token: probe.token, type, code });
        out.push(result(probe, type === ICMPV6_TIME_EXCEEDED ? 'ttl-exceeded' : 'unreachable', { from, type, code, pdu }));
        return out;
      }
      debug(ctx, `error type ${type} code ${code} from ${from}: no matching ping or probe`, { pdu: pdu.id, type, code });
      return out;
    }
    if (upper !== undefined && (upper.proto === 'udp' || upper.proto === 'tcp')) {
      if (hasProcess(ctx, upper.proto)) {
        debug(ctx, `error type ${type} code ${code} from ${from} quoting ${upper.proto}: passed to ${upper.proto}`, { pdu: pdu.id, type, code });
        return [{ type: 'deliver', to: upper.proto, pdu, port }];
      }
    }
    debug(ctx, `error type ${type} code ${code} from ${from}: nobody to tell`, { pdu: pdu.id, type, code });
    return [{ type: 'consume', pdu }];
  }

  // ── error generation ────────────────────────────────────────────────────

  function buildError(ctx: ProcessCtx, req: Extract<ProcessRequest, { kind: 'icmp6.error' }>): Action[] {
    const original = req.original;
    const ipIdx = ipIndexOf(original);
    if (ipIdx < 0) return [];
    const ip = original.layers[ipIdx]!;
    const origSrc = normalizeIpv6(String(ip.fields.src)) ?? String(ip.fields.src);
    const origDst = normalizeIpv6(String(ip.fields.dst)) ?? String(ip.fields.dst);
    const suppress = (why: string): Action[] => {
      errorsSuppressed++;
      debug(ctx, `no error type ${req.type} for ${origSrc} > ${origDst}: ${why}`, { original: original.id, type: req.type, code: req.code });
      return [];
    };
    if (isUnspecified6(origSrc) || isMulticast6(origSrc)) return suppress('the source is not a unicast address');
    const multicastException = req.type === ICMPV6_PACKET_TOO_BIG || (req.type === ICMPV6_PARAM_PROBLEM && req.code === 2);
    if (isMulticast6(origDst) && !multicastException) return suppress('the packet was sent to a multicast group');
    const link = ipIdx > 0 ? original.layers[0] : undefined;
    if (link !== undefined && link.proto === 'ethernet' && typeof link.fields.dst === 'string' && isMulticastMac(link.fields.dst) && !multicastException) {
      return suppress('the frame was sent to a link-layer group address');
    }
    const upperIdx = icmpIndexAfter(original, ipIdx);
    if (upperIdx >= 0 && isIcmpv6Error(Number(original.layers[upperIdx]!.fields.type))) {
      // only the first ICMPv6 layer of the packet itself counts, not one quoted deeper inside
      const quotedAt = original.layers.findIndex((l, i) => i > ipIdx && l.proto === 'ipv6');
      if (quotedAt < 0 || upperIdx < quotedAt) return suppress('the packet is itself an ICMPv6 error');
    }
    const h = ipv6Helpers(ctx);
    const src = (req.inPort !== undefined ? h.sourceFor6(origSrc, req.inPort)?.address : undefined) ?? h.sourceFor6(origSrc)?.address;
    if (src === undefined) return suppress('no source address toward the sender');
    const bytes = original.bytes;
    const quoteEnd = Math.min(ip.offset + ip.length, ip.offset + ICMPV6_MAX_QUOTE, bytes.length);
    const quote = bytes.slice(ip.offset, quoteEnd);
    const fields: Record<string, number> = { type: req.type, code: req.code };
    if (req.type === ICMPV6_PACKET_TOO_BIG) fields.mtu = req.param ?? IPV6_MIN_MTU;
    else if (req.type === ICMPV6_PARAM_PROBLEM) fields.pointer = req.param ?? 0;
    else fields.unused = 0;
    const tag = errorTag(req.type);
    const meta: Partial<PduMeta> = original.meta.flow !== undefined ? { triggeredBy: original.id, tag, flow: original.meta.flow } : { triggeredBy: original.id, tag };
    const error = ctx.newPdu(
      [
        { proto: 'ipv6', fields: { src, dst: origSrc, nextHeader: IPPROTO_ICMPV6, hopLimit: originatedHopLimit(ctx) } },
        { proto: 'icmpv6', fields },
        { proto: 'payload', fields: { data: quote } },
      ],
      meta,
    );
    errorsSent++;
    debug(ctx, `error type ${req.type} code ${req.code} ${src} > ${origSrc} quoting ${origSrc} > ${origDst}`, { original: original.id, error: error.id, type: req.type, code: req.code });
    const send: ProcessRequest = { kind: 'ipv6.send', pdu: error, cause: `icmpv6 ${tag}` };
    if (isLinkScoped6(origSrc) && req.inPort !== undefined) send.iface = req.inPort;
    return [{ type: 'request', to: 'ipv6', req: send }];
  }

  // ── the process ─────────────────────────────────────────────────────────

  return {
    name: NAME,

    onPdu(ctx: ProcessCtx, pdu: Pdu, port: PortId): Action[] {
      const ipIdx = ipIndexOf(pdu);
      const idx = ipIdx < 0 ? -1 : icmpIndexAfter(pdu, ipIdx);
      if (ipIdx < 0 || idx < 0) return [{ type: 'drop', pdu, reason: 'unsupported-protocol', detail: 'not an ICMPv6 message', port }];
      const ip = pdu.layers[ipIdx]!;
      const icmp = pdu.layers[idx]!;
      if (icmp.fields.checksumValid === false) {
        debug(ctx, `bad checksum on ICMPv6 type ${String(icmp.fields.type)} from ${String(ip.fields.src)}`, { pdu: pdu.id, port });
        return [{ type: 'drop', pdu, reason: 'bad-checksum', detail: 'ICMPv6 checksum mismatch', port }];
      }
      const type = Number(icmp.fields.type);
      if (type === ICMPV6_ECHO_REQUEST) return replyTo(ctx, pdu, ip, idx, port);
      if (type === ICMPV6_ECHO_REPLY) return onEchoReply(ctx, pdu, ip, icmp);
      if (isIcmpv6Error(type)) return onError(ctx, pdu, ip, idx, port);
      debug(ctx, `ignored ICMPv6 type ${type} from ${String(ip.fields.src)}`, { pdu: pdu.id, type, port });
      return [{ type: 'consume', pdu }];
    },

    onTimer(ctx: ProcessCtx, key: string): Action[] {
      if (key.startsWith(TIMER_PROBE)) {
        const token = key.slice(TIMER_PROBE.length);
        const probe = probes.get(token);
        if (probe === undefined) return [];
        probes.delete(token);
        debug(ctx, `probe ${token} to ${probe.target}: no answer in time`, { token });
        return [result(probe, 'timeout', {})];
      }
      if (key.startsWith(TIMER_PING_TIMEOUT)) {
        const session = key.slice(TIMER_PING_TIMEOUT.length);
        const job = jobs.get(session);
        if (job === undefined || !job.outstanding) return [];
        job.lost++;
        job.outstanding = false;
        debug(ctx, `echo request id=${job.id} seq=${job.seq} to ${job.target} timed out`, { session, id: job.id, seq: job.seq });
        const actions: Action[] = [{ type: 'cliOutput', session, text: '.' }];
        return actions.concat(sendNext(ctx, job));
      }
      if (key.startsWith(TIMER_PING)) {
        const job = jobs.get(key.slice(TIMER_PING.length));
        return job === undefined ? [] : sendNext(ctx, job);
      }
      return [];
    },

    onConfig(): Action[] {
      return [];
    },

    onRequest(ctx: ProcessCtx, req: ProcessRequest): Action[] {
      switch (req.kind) {
        case 'icmp6.ping':
          return startPing(ctx, req);
        case 'icmp6.probe':
          return startProbe(ctx, req);
        case 'icmp6.error':
          return buildError(ctx, req);
        case 'job.abort':
        case 'icmp.abort': {
          const job = jobs.get(req.session);
          return job === undefined ? [] : finish(ctx, job, 'aborted');
        }
        default:
          return [];
      }
    },

    stateSnapshot(): StateView {
      const list: Record<string, unknown>[] = [];
      for (const j of jobs.values()) list.push({ session: j.session, target: j.target, sent: j.sent, received: j.received, lost: j.lost, seq: j.seq });
      const pr: Record<string, unknown>[] = [];
      for (const p of probes.values()) pr.push({ token: p.token, target: p.target, hopLimit: p.hopLimit });
      return { process: NAME, state: { jobs: list, probes: pr, repliesSent, errorsSent, errorsSuppressed } };
    },

    debugEvents(): readonly DebugEvent[] {
      return ring;
    },
  };
}
