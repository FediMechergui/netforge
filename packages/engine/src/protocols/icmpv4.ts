/**
 * protocols/icmpv4.ts — the ICMPv4 daemon (spec §2.1 "Troubleshooting (ping)",
 * §4.8 process model, §9.3 provenance: replies and errors carry `triggeredBy`).
 *
 * Jobs:
 *  • Echo responder: an echo request delivered by ipv4 is answered with an echo reply
 *    (addresses swapped, same id/seq/payload, `meta.triggeredBy` = the request) and the
 *    request is consumed.
 *  • Error generation (`icmp.error` requests from ipv4 and udp): destination unreachable /
 *    time exceeded quoting the original IPv4 header plus the first 8 payload bytes (RFC 792).
 *    Never generated for broadcast/multicast destinations, for a source of 0.0.0.0 or in answer
 *    to another ICMP error (RFC 1122 §3.2.2). The error's source is the original destination
 *    when that is one of our addresses (protocol / port unreachable), else the address of the
 *    ingress port, else the address towards the original source.
 *  • Error fan-back (ARCHITECTURE-P1 §4.2): a received error is dispatched on the QUOTED datagram —
 *    quoted ICMP → the ping job or probe that sent it; quoted UDP / TCP → delivered (the whole error
 *    PDU) to the `udp` / `tcp` daemon through the protocols/ip-upper.ts table, which turns it into a
 *    `sock.error` for the socket; anything else is consumed.
 *  • Name targets (`icmp.ping` with a name instead of an address, §4.7-§4.8): the name goes to dns-client as
 *    `dns.resolve` and the job starts on the `dns.result` with the FIRST address only; an empty answer prints one
 *    original line and ends the session.
 *  • The ping job (`icmp.ping` from the CLI): one state machine per CLI session that
 *    sends `count` echo requests — the next one immediately after a reply, or after
 *    `timeoutNs` — prints `!` / `.` / `U` / `T` progress, then a statistics line and
 *    `cliDone`. `icmp.abort` finishes the job early with the statistics so far. An optional
 *    `ttl` sets the IPv4 TTL of the requests.
 *  • Probes (`icmp.probe`, traceroute ICMP mode §4.7): one echo request with the given TTL; the
 *    echo reply, a time-exceeded or an unreachable quoting it, or the `probe:<token>` timeout, is
 *    reported to the owner as ProcessEvent `icmp.result` (outcome reply / ttl-exceeded /
 *    unreachable / timeout; no-route at once when there is no source address).
 *
 * Echo identifiers come from one per-device counter shared by ping jobs and probes, so replies
 * never match the wrong requester. Probe sequence numbers count the probes sent (1-based).
 *
 * Originated packets (echo requests, replies, errors) use `model.ipDefaults.ttl` (see `originatedTtl`).
 *
 * Timer keys: `ping:<session>` (send the next echo), `ping-timeout:<session>`, `probe:<token>` (never periodic).
 * Debug category: 'ip icmp'.
 *
 * stateSnapshot():
 *   { process: 'icmpv4', state: { jobs: [{ session, target, sent, received, lost, seq }],
 *     repliesSent, errorsSent, probes? } }   (`probes` = outstanding [{ token, owner, target, ttl }], only when any)
 */
import { isIpv4Broadcast, isIpv4Multicast, parseIpv4, type Ipv4Address } from '../contracts/addr.js';
import { ipDefaultsFor } from '../contracts/catalog.js';
import type { PortId, ProcessName, SessionId } from '../contracts/ids.js';
import {
  ICMP_DEST_UNREACHABLE,
  ICMP_ECHO_REPLY,
  ICMP_ECHO_REQUEST,
  ICMP_QUOTE_PAYLOAD_BYTES,
  ICMP_TIME_EXCEEDED,
  IPPROTO_ICMP,
  type LayerView,
  type Pdu,
  type PduMeta,
} from '../contracts/pdu.js';
import type { Action, DebugEvent, Process, ProcessCtx, ProcessRequest, StateView } from '../contracts/process.js';
import { MS, SEC, type SimTime } from '../contracts/time.js';
import type { ProbeResultEvent, ProcessEvent } from '../contracts/transport.js';
import { icmpErrorTarget } from './ip-upper.js';

/** Process name, as registered in the protocol registry. */
const NAME = 'icmpv4';
/** Debug category. */
const CAT = 'ip icmp';
/** Number of DebugEvents retained by `debugEvents()`. */
const DEBUG_RING = 256;
/** IPv4 header (20) + ICMP echo header (8): what `sizeBytes` covers besides the payload. */
const ECHO_OVERHEAD = 28;
/** Default IPv4 total length of a probe (20 header + 8 ICMP + 32 data bytes). */
export const ICMP_PROBE_DEFAULT_SIZE = 60;

/** One ping job (per CLI session). */
interface PingJob {
  session: SessionId;
  target: Ipv4Address;
  count: number;
  timeoutNs: SimTime;
  sizeBytes: number;
  /** ICMP identifier, per-job counter starting at 1 within the device. */
  id: number;
  /** Sequence number of the last request sent (0 before the first). */
  seq: number;
  sent: number;
  received: number;
  lost: number;
  rtts: SimTime[];
  sentAt: SimTime;
  /** True while a request is waiting for its reply or timeout. */
  outstanding: boolean;
  source?: Ipv4Address;
  /** IPv4 TTL of the requests (default: the device's originated TTL). */
  ttl?: number;
}

/** One outstanding probe (`icmp.probe`). */
interface Probe {
  owner: ProcessName;
  token: string;
  target: Ipv4Address;
  ttl: number;
  /** ICMP identifier (shared counter with ping jobs). */
  id: number;
  /** ICMP sequence number (probe count). */
  seq: number;
  sentAt: SimTime;
}

/** Timer key for "send the next echo". */
const nextKey = (session: SessionId): string => `ping:${session}`;
/** Timer key for "the outstanding echo timed out". */
const timeoutKey = (session: SessionId): string => `ping-timeout:${session}`;

/** Timer key of a probe's timeout. */
const probeKey = (token: string): string => `probe:${token}`;

/** `ipv4:<src>><dst>:icmp` flow key (colour by conversation). */
const flowKey = (src: Ipv4Address, dst: Ipv4Address): string => `ipv4:${src}>${dst}:icmp`;

/**
 * Default TTL of packets this device originates: `model.ipDefaults.ttl` (routing devices 255, hosts 128), else the
 * capability-derived default (`ipDefaultsFor`). Never keyed on the device kind.
 */
export function originatedTtl(ctx: Pick<ProcessCtx, 'model'>): number {
  return ctx.model.ipDefaults?.ttl ?? ipDefaultsFor(ctx.model.capabilities ?? []).ttl;
}

/** Default TTL of packets this device originates (see `originatedTtl`). */
function ttlFor(ctx: ProcessCtx): number {
  return originatedTtl(ctx);
}

/** Nanoseconds → milliseconds with two decimals (`1.25`). */
function formatMs(ns: SimTime): string {
  return (ns / MS).toFixed(2);
}

/** Seconds for the ping header line: whole seconds print as an integer, otherwise two decimals. */
function formatSeconds(ns: SimTime): string {
  const s = ns / SEC;
  return Number.isInteger(s) ? String(s) : s.toFixed(2);
}

/** The layer following the FIRST icmpv4 layer when it is a `payload` (echo data), else undefined. */
function echoPayload(pdu: Pdu, icmpIndex: number): Uint8Array {
  const next = pdu.layers[icmpIndex + 1];
  if (next && next.proto === 'payload' && next.fields.data instanceof Uint8Array) return next.fields.data;
  const icmp = pdu.layers[icmpIndex]!;
  const start = icmp.offset + icmp.headerLength;
  const end = icmp.offset + icmp.length - (icmp.trailerLength ?? 0);
  return pdu.bytes.subarray(start, Math.max(start, end));
}

/** Index of the first icmpv4 layer, or -1. */
function icmpIndexOf(pdu: Pdu): number {
  const ls = pdu.layers;
  for (let i = 0; i < ls.length; i++) if (ls[i]!.proto === 'icmpv4') return i;
  return -1;
}

/** The icmpv4 layer quoted inside an ICMP error (the one after the error layer), if any. */
function quotedIcmp(pdu: Pdu, errorIndex: number): LayerView | undefined {
  const ls = pdu.layers;
  for (let i = errorIndex + 1; i < ls.length; i++) if (ls[i]!.proto === 'icmpv4') return ls[i];
  return undefined;
}

/** The IPv4 header quoted inside an ICMP error (the first ipv4 layer after the error layer), if decoded. */
function quotedIpv4(pdu: Pdu, errorIndex: number): LayerView | undefined {
  const ls = pdu.layers;
  for (let i = errorIndex + 1; i < ls.length; i++) if (ls[i]!.proto === 'ipv4') return ls[i];
  return undefined;
}

/** Deterministic echo payload: bytes 0x00, 0x01, … wrapping at 0xff. */
function pattern(n: number): Uint8Array {
  const out = new Uint8Array(Math.max(0, n));
  for (let i = 0; i < out.length; i++) out[i] = i & 0xff;
  return out;
}

/**
 * Create the ICMPv4 daemon. Reached only via `deliver` (from ipv4) and requests
 * (`icmp.ping`, `icmp.abort`, `icmp.error`); it has no wire selector.
 */
export function createIcmpv4(): Process {
  const jobs = new Map<SessionId, PingJob>();
  const probes = new Map<string, Probe>();
  /** Pings whose target is a name, by session: the request waiting for its `dns.result`. */
  const resolving = new Map<SessionId, Extract<ProcessRequest, { kind: 'icmp.ping' }>>();
  const ring: DebugEvent[] = [];
  let nextJobId = 1;
  let probesSent = 0;
  let repliesSent = 0;
  let errorsSent = 0;

  function debug(ctx: ProcessCtx, message: string, data?: Record<string, unknown>): void {
    ctx.debug(CAT, message, data);
    const ev: DebugEvent = data
      ? { at: ctx.now, device: ctx.deviceId, process: NAME, category: CAT, message, data }
      : { at: ctx.now, device: ctx.deviceId, process: NAME, category: CAT, message };
    ring.push(ev);
    if (ring.length > DEBUG_RING) ring.splice(0, ring.length - DEBUG_RING);
  }

  // ── ping job ──────────────────────────────────────────────────────────────

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

  /** Print the statistics, unblock the session and forget the job. */
  function finish(ctx: ProcessCtx, job: PingJob, why: string): Action[] {
    if (job.outstanding) {
      job.outstanding = false;
      job.lost++;
    }
    jobs.delete(job.session);
    debug(ctx, `ping ${job.target} finished (${why}): sent ${job.sent} received ${job.received} lost ${job.lost}`, {
      session: job.session,
      target: job.target,
      sent: job.sent,
      received: job.received,
      lost: job.lost,
    });
    return [
      { type: 'cancelTimer', key: timeoutKey(job.session) },
      { type: 'cancelTimer', key: nextKey(job.session) },
      { type: 'cliOutput', session: job.session, text: statsLine(job) },
      { type: 'cliDone', session: job.session },
    ];
  }

  /** Send the next echo request, or finish when `count` is reached. */
  function sendNext(ctx: ProcessCtx, job: PingJob): Action[] {
    if (job.seq >= job.count) return finish(ctx, job, 'complete');
    const src = job.source ?? ctx.sourceFor(job.target)?.address;
    if (src === undefined) {
      debug(ctx, `ping ${job.target}: no route from this device`, { session: job.session, target: job.target });
      const actions: Action[] = [{ type: 'cliOutput', session: job.session, text: `No route to ${job.target} from this device.\n` }];
      if (job.sent > 0) return actions.concat(finish(ctx, job, 'no route'));
      jobs.delete(job.session);
      actions.push({ type: 'cliDone', session: job.session });
      return actions;
    }
    job.seq++;
    const seq = job.seq;
    const pdu = ctx.newPdu(
      [
        { proto: 'ipv4', fields: { src, dst: job.target, protocol: IPPROTO_ICMP, ttl: job.ttl ?? ttlFor(ctx), id: seq } },
        { proto: 'icmpv4', fields: { type: ICMP_ECHO_REQUEST, code: 0, id: job.id, seq } },
        { proto: 'payload', fields: { data: pattern(job.sizeBytes - ECHO_OVERHEAD) } },
      ],
      { flow: flowKey(src, job.target), tag: `ping#${seq}` },
    );
    job.sent++;
    job.sentAt = ctx.now;
    job.outstanding = true;
    debug(ctx, `echo request ${src} > ${job.target} id=${job.id} seq=${seq}`, { session: job.session, pdu: pdu.id, id: job.id, seq });
    return [
      { type: 'request', to: 'ipv4', req: { kind: 'ipv4.send', pdu, cause: `ping ${job.target}` } },
      { type: 'timer', key: timeoutKey(job.session), delay: job.timeoutNs },
    ];
  }

  /** Progress after the outstanding echo was answered, errored or timed out. */
  function advance(ctx: ProcessCtx, job: PingJob, mark: string): Action[] {
    job.outstanding = false;
    const actions: Action[] = [{ type: 'cliOutput', session: job.session, text: mark }, { type: 'cancelTimer', key: timeoutKey(job.session) }];
    if (job.seq >= job.count) return actions.concat(finish(ctx, job, 'complete'));
    actions.push({ type: 'timer', key: nextKey(job.session), delay: 0 });
    return actions;
  }

  /** The job whose outstanding request carries (id, seq), in insertion order. */
  function matchJob(id: number, seq: number): PingJob | undefined {
    for (const job of jobs.values()) if (job.outstanding && job.id === id && job.seq === seq) return job;
    return undefined;
  }

  function startPing(ctx: ProcessCtx, req: Extract<ProcessRequest, { kind: 'icmp.ping' }>): Action[] {
    const existing = jobs.get(req.session);
    const actions: Action[] = [];
    if (existing) actions.push(...finish(ctx, existing, 'replaced'));
    // A new ping also replaces a lookup still in flight, so a late answer can never start a second job.
    resolving.delete(req.session);
    if (parseIpv4(req.target) === null) {
      // A name target: dns-client answers with `dns.result` and the job starts on the first address (§4.8).
      resolving.set(req.session, req);
      debug(ctx, `ping ${req.target}: resolving the name`, { session: req.session, name: req.target });
      actions.push({ type: 'request', to: 'dns-client', req: { kind: 'dns.resolve', owner: NAME, token: req.session, name: req.target, qtype: 'A' } });
      return actions;
    }
    const job: PingJob = {
      session: req.session,
      target: req.target,
      count: Math.max(1, Math.floor(req.count)),
      timeoutNs: req.timeoutNs,
      sizeBytes: Math.max(ECHO_OVERHEAD, Math.floor(req.sizeBytes)),
      id: nextJobId++,
      seq: 0,
      sent: 0,
      received: 0,
      lost: 0,
      rtts: [],
      sentAt: ctx.now,
      outstanding: false,
    };
    if (req.source !== undefined) job.source = req.source;
    if (req.ttl !== undefined) job.ttl = Math.max(1, Math.min(255, Math.floor(req.ttl)));
    jobs.set(job.session, job);
    debug(ctx, `ping ${job.target} started: ${job.count} echoes, ${job.sizeBytes} bytes, timeout ${formatSeconds(job.timeoutNs)} s`, {
      session: job.session,
      target: job.target,
      id: job.id,
    });
    // The header only appears when an echo can actually leave: with no route, sendNext
    // prints the single "No route to …" line instead.
    const routable = (job.source ?? ctx.sourceFor(job.target)?.address) !== undefined;
    if (routable) {
      actions.push({
        type: 'cliOutput',
        session: job.session,
        text: `Sending ${job.count} echo requests to ${job.target}, ${job.sizeBytes}-byte datagrams, timeout ${formatSeconds(job.timeoutNs)} s:\n`,
      });
    }
    return actions.concat(sendNext(ctx, job));
  }

  // ── responder ─────────────────────────────────────────────────────────────

  function replyTo(ctx: ProcessCtx, pdu: Pdu, ip: LayerView, icmpIndex: number, port: PortId): Action[] {
    const icmp = pdu.layers[icmpIndex]!;
    const reqSrc = String(ip.fields.src);
    const reqDst = String(ip.fields.dst);
    let src: Ipv4Address | undefined = ctx.ownAddress(reqDst) !== undefined ? reqDst : undefined;
    if (src === undefined) src = ctx.ports.get(port)?.l3.ipv4?.address ?? ctx.sourceFor(reqSrc)?.address;
    if (src === undefined) {
      debug(ctx, `echo request ${reqSrc} > ${reqDst} on ${port}: no address to reply from`, { pdu: pdu.id, port });
      return [{ type: 'drop', pdu, reason: 'no-l3-address', detail: `no IPv4 address on ${port} to answer from`, port }];
    }
    const id = Number(icmp.fields.id ?? 0);
    const seq = Number(icmp.fields.seq ?? 0);
    const meta: Partial<PduMeta> = { triggeredBy: pdu.id, flow: pdu.meta.flow ?? flowKey(reqSrc, reqDst), tag: 'echo-reply' };
    const reply = ctx.newPdu(
      [
        { proto: 'ipv4', fields: { src, dst: reqSrc, protocol: IPPROTO_ICMP, ttl: ttlFor(ctx), id: Number(ip.fields.id ?? 0) } },
        { proto: 'icmpv4', fields: { type: ICMP_ECHO_REPLY, code: 0, id, seq } },
        { proto: 'payload', fields: { data: echoPayload(pdu, icmpIndex) } },
      ],
      meta,
    );
    repliesSent++;
    debug(ctx, `echo request ${reqSrc} > ${reqDst} id=${id} seq=${seq}: reply ${src} > ${reqSrc}`, { request: pdu.id, reply: reply.id, id, seq, port });
    return [
      { type: 'consume', pdu },
      { type: 'request', to: 'ipv4', req: { kind: 'ipv4.send', pdu: reply, cause: 'echo reply' } },
    ];
  }

  // ── probes (traceroute ICMP mode) ─────────────────────────────────────────

  /** The outstanding probe whose request carries (id, seq), in insertion order. */
  function matchProbe(id: number, seq: number): Probe | undefined {
    for (const p of probes.values()) if (p.id === id && p.seq === seq) return p;
    return undefined;
  }

  /** Report a probe's outcome to its owner and forget it. */
  function finishProbe(ctx: ProcessCtx, probe: Probe, outcome: ProbeResultEvent['outcome'], extra: Partial<ProbeResultEvent>): Action[] {
    probes.delete(probe.token);
    const ev: ProbeResultEvent = { kind: 'icmp.result', token: probe.token, outcome, sentAt: probe.sentAt, ...extra };
    debug(ctx, `probe ${probe.token} to ${probe.target} ttl ${probe.ttl}: ${outcome}${extra.from !== undefined ? ` from ${extra.from}` : ''}`, {
      token: probe.token, owner: probe.owner, outcome, from: extra.from, type: extra.type, code: extra.code,
    });
    return [
      { type: 'cancelTimer', key: probeKey(probe.token) },
      { type: 'event', to: probe.owner, ev },
    ];
  }

  function startProbe(ctx: ProcessCtx, req: Extract<ProcessRequest, { kind: 'icmp.probe' }>): Action[] {
    const actions: Action[] = [];
    const existing = probes.get(req.token);
    if (existing !== undefined) {
      probes.delete(req.token);
      actions.push({ type: 'cancelTimer', key: probeKey(req.token) });
    }
    const src = ctx.sourceFor(req.target)?.address;
    if (src === undefined) {
      debug(ctx, `probe ${req.token} to ${req.target}: no route from this device`, { token: req.token, owner: req.owner, target: req.target });
      const ev: ProbeResultEvent = { kind: 'icmp.result', token: req.token, outcome: 'no-route', sentAt: ctx.now };
      actions.push({ type: 'event', to: req.owner, ev });
      return actions;
    }
    const ttl = Math.max(1, Math.min(255, Math.floor(req.ttl)));
    const sizeBytes = Math.max(ECHO_OVERHEAD, Math.floor(req.sizeBytes ?? ICMP_PROBE_DEFAULT_SIZE));
    probesSent++;
    const probe: Probe = { owner: req.owner, token: req.token, target: req.target, ttl, id: nextJobId++, seq: probesSent & 0xffff, sentAt: ctx.now };
    probes.set(probe.token, probe);
    const pdu = ctx.newPdu(
      [
        { proto: 'ipv4', fields: { src, dst: req.target, protocol: IPPROTO_ICMP, ttl, id: probe.seq } },
        { proto: 'icmpv4', fields: { type: ICMP_ECHO_REQUEST, code: 0, id: probe.id, seq: probe.seq } },
        { proto: 'payload', fields: { data: pattern(sizeBytes - ECHO_OVERHEAD) } },
      ],
      { flow: flowKey(src, req.target), tag: 'icmp-probe' },
    );
    debug(ctx, `probe ${probe.token}: echo request ${src} > ${req.target} ttl ${ttl} id=${probe.id} seq=${probe.seq}`, {
      token: probe.token, owner: probe.owner, pdu: pdu.id, id: probe.id, seq: probe.seq, ttl,
    });
    actions.push(
      { type: 'request', to: 'ipv4', req: { kind: 'ipv4.send', pdu, cause: `probe ${req.target} ttl ${ttl}` } },
      { type: 'timer', key: probeKey(probe.token), delay: Math.max(0, req.timeoutNs) },
    );
    return actions;
  }

  function onEchoReply(ctx: ProcessCtx, pdu: Pdu, ip: LayerView, icmp: LayerView): Action[] {
    const id = Number(icmp.fields.id ?? -1);
    const seq = Number(icmp.fields.seq ?? -1);
    const job = matchJob(id, seq);
    if (!job) {
      const probe = matchProbe(id, seq);
      if (probe !== undefined) {
        return [{ type: 'consume', pdu }, ...finishProbe(ctx, probe, 'reply', { from: String(ip.fields.src), type: ICMP_ECHO_REPLY, code: 0, pdu })];
      }
      debug(ctx, `echo reply ${String(ip.fields.src)} > ${String(ip.fields.dst)} id=${id} seq=${seq}: no matching ping job`, { pdu: pdu.id, id, seq });
      return [{ type: 'consume', pdu }];
    }
    const rtt = ctx.now - job.sentAt;
    job.received++;
    job.rtts.push(rtt);
    debug(ctx, `echo reply from ${String(ip.fields.src)} id=${id} seq=${seq} rtt ${formatMs(rtt)} ms`, { pdu: pdu.id, session: job.session, id, seq, rtt });
    return [{ type: 'consume', pdu }, ...advance(ctx, job, '!')];
  }

  function onError(ctx: ProcessCtx, pdu: Pdu, ip: LayerView, icmpIndex: number, port: PortId): Action[] {
    const icmp = pdu.layers[icmpIndex]!;
    const type = Number(icmp.fields.type);
    const code = Number(icmp.fields.code);
    const what = type === ICMP_TIME_EXCEEDED ? 'time exceeded' : 'destination unreachable';
    const quoted = quotedIpv4(pdu, icmpIndex);
    const quotedProto = quoted !== undefined ? Number(quoted.fields.protocol) : -1;
    if (quoted !== undefined && quotedProto !== IPPROTO_ICMP) {
      const target = icmpErrorTarget(ctx.model, quotedProto);
      const about = `${String(quoted.fields.src)} > ${String(quoted.fields.dst)} proto ${quotedProto}`;
      if (target === undefined) {
        debug(ctx, `${what} (code ${code}) from ${String(ip.fields.src)} about ${about}: nothing to tell`, { pdu: pdu.id, type, code, protocol: quotedProto });
        return [{ type: 'consume', pdu }];
      }
      debug(ctx, `${what} (code ${code}) from ${String(ip.fields.src)} about ${about}: passed to ${target}`, { pdu: pdu.id, type, code, protocol: quotedProto, to: target });
      return [{ type: 'deliver', to: target, pdu, port }];
    }
    const inner = quotedIcmp(pdu, icmpIndex);
    const id = inner && typeof inner.fields.id === 'number' ? inner.fields.id : -1;
    const seq = inner && typeof inner.fields.seq === 'number' ? inner.fields.seq : -1;
    const job = matchJob(id, seq);
    if (!job) {
      const probe = matchProbe(id, seq);
      if (probe !== undefined) {
        const outcome = type === ICMP_TIME_EXCEEDED ? 'ttl-exceeded' : 'unreachable';
        return [{ type: 'consume', pdu }, ...finishProbe(ctx, probe, outcome, { from: String(ip.fields.src), type, code, pdu })];
      }
      debug(ctx, `${what} (code ${code}) from ${String(ip.fields.src)}: no matching ping job`, { pdu: pdu.id, type, code, id, seq });
      return [{ type: 'consume', pdu }];
    }
    job.lost++;
    debug(ctx, `${what} (code ${code}) from ${String(ip.fields.src)} for id=${id} seq=${seq}`, { pdu: pdu.id, session: job.session, type, code, id, seq });
    return [{ type: 'consume', pdu }, ...advance(ctx, job, type === ICMP_TIME_EXCEEDED ? 'T' : 'U')];
  }

  // ── error generation ──────────────────────────────────────────────────────

  function buildError(ctx: ProcessCtx, req: Extract<ProcessRequest, { kind: 'icmp.error' }>): Action[] {
    const original = req.original;
    const ip = original.layer('ipv4');
    if (!ip) return [];
    const origSrc = String(ip.fields.src);
    const origDst = String(ip.fields.dst);
    if (isIpv4Broadcast(origDst) || isIpv4Multicast(origDst) || isIpv4Broadcast(origSrc) || isIpv4Multicast(origSrc) || origSrc === '0.0.0.0') {
      debug(ctx, `suppressed error type ${req.type} for ${origSrc} > ${origDst}: broadcast or multicast`, { original: original.id });
      return [];
    }
    if (Number(ip.fields.protocol) === IPPROTO_ICMP) {
      const idx = icmpIndexOf(original);
      const t = idx >= 0 ? Number(original.layers[idx]!.fields.type) : -1;
      if (t !== ICMP_ECHO_REQUEST && t !== ICMP_ECHO_REPLY) {
        debug(ctx, `suppressed error type ${req.type} for ${origSrc} > ${origDst}: original is not an echo`, { original: original.id });
        return [];
      }
    }
    // RFC 1122 §3.2.2 / RFC 1812 §4.3.2.4: answer from the address the original was sent to when it is ours.
    const src =
      (ctx.ownAddress(origDst) !== undefined ? origDst : undefined) ??
      (req.inPort !== undefined ? ctx.ports.get(req.inPort)?.l3.ipv4?.address : undefined) ??
      ctx.sourceFor(origSrc)?.address;
    if (src === undefined) {
      debug(ctx, `suppressed error type ${req.type} for ${origSrc} > ${origDst}: no source address`, { original: original.id });
      return [];
    }
    const bytes = original.bytes;
    const quoteEnd = Math.min(ip.offset + ip.headerLength + ICMP_QUOTE_PAYLOAD_BYTES, ip.offset + ip.length, bytes.length);
    const quote = bytes.slice(ip.offset, quoteEnd);
    const tag = req.type === ICMP_TIME_EXCEEDED ? 'ttl-exceeded' : req.type === ICMP_DEST_UNREACHABLE ? 'unreachable' : `icmp-type-${req.type}`;
    const meta: Partial<PduMeta> =
      original.meta.flow !== undefined ? { triggeredBy: original.id, tag, flow: original.meta.flow } : { triggeredBy: original.id, tag };
    const error = ctx.newPdu(
      [
        { proto: 'ipv4', fields: { src, dst: origSrc, protocol: IPPROTO_ICMP, ttl: ttlFor(ctx) } },
        { proto: 'icmpv4', fields: { type: req.type, code: req.code, unused: 0 } },
        { proto: 'payload', fields: { data: quote } },
      ],
      meta,
    );
    errorsSent++;
    debug(ctx, `error type ${req.type} code ${req.code} ${src} > ${origSrc} quoting ${origSrc} > ${origDst}`, {
      original: original.id,
      error: error.id,
      type: req.type,
      code: req.code,
    });
    return [{ type: 'request', to: 'ipv4', req: { kind: 'ipv4.send', pdu: error, cause: `icmp ${tag}` } }];
  }

  // ── the process ───────────────────────────────────────────────────────────

  return {
    name: NAME,

    onPdu(ctx: ProcessCtx, pdu: Pdu, port: PortId): Action[] {
      const ip = pdu.layer('ipv4');
      const idx = icmpIndexOf(pdu);
      if (!ip || idx < 0) {
        return [{ type: 'drop', pdu, reason: 'unsupported-protocol', detail: 'not an ICMP message', port }];
      }
      const icmp = pdu.layers[idx]!;
      if (icmp.fields.checksumValid === false) {
        debug(ctx, `bad checksum on ICMP type ${String(icmp.fields.type)} from ${String(ip.fields.src)}`, { pdu: pdu.id, port });
        return [{ type: 'drop', pdu, reason: 'bad-checksum', detail: 'ICMP checksum mismatch', port }];
      }
      const type = Number(icmp.fields.type);
      switch (type) {
        case ICMP_ECHO_REQUEST:
          return replyTo(ctx, pdu, ip, idx, port);
        case ICMP_ECHO_REPLY:
          return onEchoReply(ctx, pdu, ip, icmp);
        case ICMP_DEST_UNREACHABLE:
        case ICMP_TIME_EXCEEDED:
          return onError(ctx, pdu, ip, idx, port);
        default:
          debug(ctx, `ignored ICMP type ${type} from ${String(ip.fields.src)}`, { pdu: pdu.id, type, port });
          return [{ type: 'consume', pdu }];
      }
    },

    onTimer(ctx: ProcessCtx, key: string): Action[] {
      const colon = key.indexOf(':');
      if (colon < 0) return [];
      const kind = key.slice(0, colon);
      const session = key.slice(colon + 1);
      if (kind === 'probe') {
        const probe = probes.get(session);
        return probe === undefined ? [] : finishProbe(ctx, probe, 'timeout', {});
      }
      const job = jobs.get(session);
      if (!job) return [];
      if (kind === 'ping') return sendNext(ctx, job);
      if (kind === 'ping-timeout') {
        if (!job.outstanding) return [];
        job.lost++;
        debug(ctx, `echo request id=${job.id} seq=${job.seq} to ${job.target} timed out`, { session, id: job.id, seq: job.seq });
        job.outstanding = false;
        const actions: Action[] = [{ type: 'cliOutput', session, text: '.' }];
        return actions.concat(sendNext(ctx, job));
      }
      return [];
    },

    onConfig(): Action[] {
      return [];
    },

    onEvent(ctx: ProcessCtx, ev: ProcessEvent): Action[] {
      if (ev.kind !== 'dns.result') return [];
      const req = resolving.get(ev.token);
      if (req === undefined) return [];
      resolving.delete(ev.token);
      const address = ev.addresses[0];
      if (address === undefined) {
        debug(ctx, `ping ${req.target}: cannot resolve (${ev.rcode})`, { session: req.session, name: req.target, rcode: ev.rcode });
        return [
          { type: 'cliOutput', session: req.session, text: `Cannot resolve ${req.target} (${ev.rcode}).\n` },
          { type: 'cliDone', session: req.session },
        ];
      }
      debug(ctx, `ping ${req.target}: resolved to ${address}`, { session: req.session, name: req.target, address });
      return startPing(ctx, { ...req, target: address });
    },

    onRequest(ctx: ProcessCtx, req: ProcessRequest): Action[] {
      switch (req.kind) {
        case 'icmp.ping':
          return startPing(ctx, req);
        case 'icmp.abort': {
          if (resolving.delete(req.session)) {
            return [{ type: 'cliOutput', session: req.session, text: 'Ping aborted.\n' }, { type: 'cliDone', session: req.session }];
          }
          const job = jobs.get(req.session);
          if (!job) return [];
          return finish(ctx, job, 'aborted');
        }
        case 'icmp.error':
          return buildError(ctx, req);
        case 'icmp.probe':
          return startProbe(ctx, req);
        default:
          return [];
      }
    },

    stateSnapshot(): StateView {
      const list: Record<string, unknown>[] = [];
      for (const j of jobs.values()) list.push({ session: j.session, target: j.target, sent: j.sent, received: j.received, lost: j.lost, seq: j.seq });
      const state: Record<string, unknown> = { jobs: list, repliesSent, errorsSent };
      if (probes.size > 0) {
        const outstanding: Record<string, unknown>[] = [];
        for (const p of probes.values()) outstanding.push({ token: p.token, owner: p.owner, target: p.target, ttl: p.ttl });
        state.probes = outstanding;
      }
      return { process: NAME, state };
    },

    debugEvents(): readonly DebugEvent[] {
      return ring;
    },
  };
}
