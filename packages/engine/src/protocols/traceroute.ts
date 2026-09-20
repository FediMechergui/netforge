/**
 * protocols/traceroute.ts — the traceroute job daemon (ARCHITECTURE-P1 §4.7; §4.8 "first address only").
 *
 * Requests:
 *  • `trace.start {session, target, family?, mode, maxHops?, probes?, timeoutNs?, source?}` starts one job per CLI
 *    session (several sessions may trace at once). A literal address starts at once; a name is resolved first with
 *    `dns.resolve {token: '<session>#<n>', qtype: family 6 ? AAAA : A}` — one token per job, so an aborted job's late
 *    answer is ignored — and the first address is used, or a failure line ends the job.
 *  • `job.abort {session}` cancels the job, closes its socket, prints a partial footer and cliDone.
 *
 * Probes are sequential: hop h = 1..maxHops, probe p = 0..probes-1; the next probe leaves when the current one is
 * answered or timed out.
 *  • UDP mode (router `traceroute`): socket 'traceroute#<session>' (ephemeral port, bound to `source` when given);
 *    the first probe leaves on `sock.opened`, so a failed open ends the job before any hop line is printed.
 *    Probe (h, p) = 12 zero bytes to port 33434 + (h−1)·probes + p with TTL / hop limit h, tag 'trace h.p', and the
 *    one-shot timer 'trace:<session>' at timeoutNs. A udp `sock.error` whose icmp.quotedDstPort is the current port
 *    answers it: ttl-exceeded → RTT; port-unreachable → destination reached; any other ICMP error → !N / !H / !A
 *    (v4 3/0, 3/1, 3/13; v6 1/0, 1/3, 1/1; other codes !<code>) and the trace stops after this hop. Errors quoting
 *    older ports are stale and ignored. A send-time error (no route, no source address) ends the job at once.
 *  • ICMP mode (host `tracert`): `icmp.probe` / `icmp6.probe` with token '<session>:h:p'. The icmp daemon owns the
 *    timeout and answers `icmp.result`: reply → reached, ttl-exceeded → RTT, unreachable → flag, timeout → *,
 *    no-route → the job ends.
 *
 * Output (original wording): a header line, then per hop `  h <address> <ms> msec | * | !X …` (the address printed
 * once, at the hop's first answer; RTT = round((now − sentAt) / 1 ms)), then a completion line and cliDone.
 *
 * Silence: sends nothing unless asked. Timer keys: 'trace:<session>' (never periodic). Debug category 'traceroute'.
 *
 * stateSnapshot():
 *   { process: 'traceroute', state: { jobs: [{ session, target, address, mode, hop, probe, done }] } }
 *   A finished job stays listed (done: true) until its session starts another trace.
 *
 * ponytail: `source` only binds the UDP socket (icmp.probe has no source field); one address per hop line even if
 * different routers answer its probes; a name is resolved with a single query (A, or AAAA for family 6).
 */
import type { IpAddress, IpFamily } from '../contracts/addr.js';
import type { PortId, SessionId } from '../contracts/ids.js';
import type { Pdu } from '../contracts/pdu.js';
import type { Action, DebugEvent, Process, ProcessCtx, ProcessRequest, StateView } from '../contracts/process.js';
import { TRACEROUTE_MAX_HOPS, TRACEROUTE_PROBES, TRACEROUTE_TIMEOUT_NS } from '../contracts/services.js';
import { MS, type SimTime } from '../contracts/time.js';
import type { ProcessEvent } from '../contracts/transport.js';
import { ipFamily, normalizeIp } from '../core/addr6.js';

const NAME = 'traceroute';
const CAT = 'traceroute';
const DEBUG_RING = 256;
/** Destination port of the first UDP probe. */
const BASE_PORT = 33434;
/** UDP probe payload (zero bytes). */
const PROBE_BYTES = 12;
/** Unreachable flag letters by ICMP code (v4 type 3, v6 type 1). */
const FLAGS: Readonly<Record<IpFamily, Readonly<Record<number, string>>>> = { 4: { 0: 'N', 1: 'H', 13: 'A' }, 6: { 0: 'N', 3: 'H', 1: 'A' } };

interface Job {
  readonly session: SessionId;
  /** Resolve token, unique per job: a stale answer from an aborted trace never starts the next one. */
  readonly token: string;
  readonly target: string;
  readonly mode: 'udp' | 'icmp';
  readonly family: IpFamily;
  readonly maxHops: number;
  readonly probes: number;
  readonly timeoutNs: SimTime;
  readonly source?: IpAddress;
  /** Destination address; undefined while the name resolves. */
  dst?: IpAddress;
  /** Current hop (0 while resolving) and probe index. */
  hop: number;
  probe: number;
  sentAt: SimTime;
  /** Address printed on the current hop line. */
  from?: IpAddress;
  /** Set by an answer: the trace ends after this hop's probes. */
  end?: 'reached' | 'unreachable';
  /** A hop line is printed without its newline yet. */
  lineOpen: boolean;
  done: boolean;
}

const socketOf = (j: Job): string => `${NAME}#${j.session}`;
const timerOf = (j: Job): string => `trace:${j.session}`;
const tokenOf = (j: Job): string => `${j.session}:${j.hop}:${j.probe}`;
const portOf = (j: Job): number => BASE_PORT + (j.hop - 1) * j.probes + j.probe;
const clampInt = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, Math.floor(v)));

export function createTraceroute(): Process {
  const jobs = new Map<SessionId, Job>();
  const ring: DebugEvent[] = [];
  let seq = 0;

  function debug(ctx: ProcessCtx, message: string, data?: Record<string, unknown>): void {
    ctx.debug(CAT, message, data);
    const ev: DebugEvent = data
      ? { at: ctx.now, device: ctx.deviceId, process: NAME, category: CAT, message, data }
      : { at: ctx.now, device: ctx.deviceId, process: NAME, category: CAT, message };
    ring.push(ev);
    if (ring.length > DEBUG_RING) ring.splice(0, ring.length - DEBUG_RING);
  }

  const cli = (j: Job, text: string): Action => ({ type: 'cliOutput', session: j.session, text });
  const active = (pred: (j: Job) => boolean): Job | undefined => [...jobs.values()].find((j) => !j.done && j.dst !== undefined && pred(j));

  /** Timer off and socket closed (UDP mode, once probing started). */
  function cleanup(j: Job): Action[] {
    if (j.mode !== 'udp' || j.dst === undefined) return [];
    return [
      { type: 'cancelTimer', key: timerOf(j) },
      { type: 'request', to: 'udp', req: { kind: 'udp.close', socket: socketOf(j) } },
    ];
  }

  function finish(ctx: ProcessCtx, j: Job, text: string): Action[] {
    j.done = true;
    debug(ctx, `session ${j.session}: trace to ${j.target} done at hop ${j.hop} (${text})`, { session: j.session, hop: j.hop, end: j.end });
    const out: Action[] = [...cleanup(j), cli(j, `${j.lineOpen ? '\n' : ''}${text}\n`), { type: 'cliDone', session: j.session }];
    j.lineOpen = false;
    return out;
  }

  function sendProbe(ctx: ProcessCtx, j: Job): Action[] {
    const out: Action[] = [];
    if (j.probe === 0) {
      out.push(cli(j, String(j.hop).padStart(3)));
      j.lineOpen = true;
      delete j.from;
    }
    j.sentAt = ctx.now;
    const dst = j.dst!;
    const h = j.hop;
    debug(ctx, `session ${j.session}: probe ${h}.${j.probe} to ${dst}`, { session: j.session, hop: h, probe: j.probe, mode: j.mode });
    if (j.mode === 'icmp') {
      const token = tokenOf(j);
      const req: ProcessRequest =
        j.family === 4
          ? { kind: 'icmp.probe', owner: NAME, token, target: dst, ttl: h, timeoutNs: j.timeoutNs }
          : { kind: 'icmp6.probe', owner: NAME, token, target: dst, hopLimit: h, timeoutNs: j.timeoutNs };
      out.push({ type: 'request', to: j.family === 4 ? 'icmpv4' : 'icmpv6', req });
      return out;
    }
    // Timer first: a send-time sock.error comes back synchronously and must be able to cancel it.
    out.push(
      { type: 'timer', key: timerOf(j), delay: j.timeoutNs },
      {
        type: 'request',
        to: 'udp',
        req: { kind: 'udp.send', socket: socketOf(j), dst, dstPort: portOf(j), ttl: h, data: new Uint8Array(PROBE_BYTES), tag: `trace ${h}.${j.probe}` },
      },
    );
    return out;
  }

  /** The current probe's outcome `mark` (answered by `from`); then the next probe, hop, or the end. */
  function settle(ctx: ProcessCtx, j: Job, mark: string, from?: IpAddress, end?: 'reached' | 'unreachable'): Action[] {
    const first = from !== undefined && j.from === undefined;
    if (first) j.from = from;
    if (end !== undefined) j.end ??= end;
    debug(ctx, `session ${j.session}: probe ${j.hop}.${j.probe} ${mark}${from !== undefined ? ` from ${from}` : ''}`, {
      session: j.session, hop: j.hop, probe: j.probe, from, end,
    });
    const out: Action[] = [cli(j, `${first ? ` ${from}` : ''} ${mark}`)];
    if (++j.probe < j.probes) return [...out, ...sendProbe(ctx, j)];
    out.push(cli(j, '\n'));
    j.lineOpen = false;
    if (j.end === 'reached') return [...out, ...finish(ctx, j, `Reached ${j.dst} in ${j.hop} hops.`)];
    if (j.end === 'unreachable') return [...out, ...finish(ctx, j, `Stopped at hop ${j.hop}: ${j.dst} is unreachable.`)];
    if (j.hop >= j.maxHops) return [...out, ...finish(ctx, j, `${j.dst} was not reached within ${j.maxHops} hops.`)];
    j.hop++;
    j.probe = 0;
    return [...out, ...sendProbe(ctx, j)];
  }

  function begin(ctx: ProcessCtx, j: Job, dst: IpAddress): Action[] {
    j.dst = dst;
    j.hop = 1;
    j.probe = 0;
    debug(ctx, `session ${j.session}: tracing ${dst} by ${j.mode}`, { session: j.session, dst, mode: j.mode });
    const label = dst === j.target ? dst : `${j.target} (${dst})`;
    const out: Action[] = [cli(j, `Route trace to ${label}, up to ${j.maxHops} hops\n`)];
    if (j.mode !== 'udp') return [...out, ...sendProbe(ctx, j)];
    // the first probe waits for `sock.opened`: a failed open (a `source` we do not own) answers sock.error
    // synchronously, and the job must end before any hop line or probe timer exists
    const open: Extract<ProcessRequest, { kind: 'udp.open' }> = { kind: 'udp.open', owner: NAME, socket: socketOf(j), family: j.family };
    if (j.source !== undefined) open.localAddr = j.source;
    out.push({ type: 'request', to: 'udp', req: open });
    return out;
  }

  function start(ctx: ProcessCtx, req: Extract<ProcessRequest, { kind: 'trace.start' }>): Action[] {
    const old = jobs.get(req.session);
    const out = old !== undefined && !old.done ? cleanup(old) : [];
    const literal = normalizeIp(req.target);
    const j: Job = {
      session: req.session,
      token: `${req.session}#${++seq}`,
      target: req.target,
      mode: req.mode,
      family: literal !== null ? ipFamily(literal)! : (req.family ?? 4),
      maxHops: clampInt(req.maxHops ?? TRACEROUTE_MAX_HOPS, 1, 255),
      probes: clampInt(req.probes ?? TRACEROUTE_PROBES, 1, 10),
      timeoutNs: req.timeoutNs ?? TRACEROUTE_TIMEOUT_NS,
      ...(req.source !== undefined ? { source: req.source } : {}),
      hop: 0,
      probe: 0,
      sentAt: ctx.now,
      lineOpen: false,
      done: false,
    };
    jobs.set(j.session, j);
    if (literal !== null) return [...out, ...begin(ctx, j, literal)];
    debug(ctx, `session ${j.session}: resolving ${j.target}`, { session: j.session, name: j.target });
    out.push({ type: 'request', to: 'dns-client', req: { kind: 'dns.resolve', owner: NAME, token: j.token, name: j.target, qtype: j.family === 6 ? 'AAAA' : 'A' } });
    return out;
  }

  const rtt = (ctx: ProcessCtx, sentAt: SimTime): string => `${Math.round((ctx.now - sentAt) / MS)} msec`;
  const flag = (j: Job, code: number | undefined): string => `!${FLAGS[j.family][code ?? -1] ?? code ?? '?'}`;

  return {
    name: NAME,

    onPdu(_ctx: ProcessCtx, pdu: Pdu, port: PortId): Action[] {
      return [{ type: 'drop', pdu, reason: 'unsupported-protocol', detail: 'traceroute takes answers from udp and icmp', port }];
    },

    onTimer(ctx: ProcessCtx, key: string): Action[] {
      const j = key.startsWith('trace:') ? jobs.get(key.slice('trace:'.length)) : undefined;
      if (j === undefined || j.done || j.mode !== 'udp' || j.dst === undefined) return [];
      return settle(ctx, j, '*');
    },

    onConfig(): Action[] {
      return [];
    },

    onRequest(ctx: ProcessCtx, req: ProcessRequest): Action[] {
      if (req.kind === 'trace.start') return start(ctx, req);
      if (req.kind !== 'job.abort') return [];
      const j = jobs.get(req.session);
      if (j === undefined || j.done) return [];
      return finish(ctx, j, `Trace aborted${j.hop > 0 ? ` at hop ${j.hop}` : ''}.`);
    },

    onEvent(ctx: ProcessCtx, ev: ProcessEvent): Action[] {
      if (ev.kind === 'dns.result') {
        const j = [...jobs.values()].find((x) => x.token === ev.token);
        if (j === undefined || j.done || j.dst !== undefined) return [];
        const dst = ev.addresses[0];
        if (dst === undefined) return finish(ctx, j, `Cannot resolve ${j.target} (${ev.rcode}).`);
        return begin(ctx, j, dst);
      }
      if (ev.kind === 'icmp.result') {
        const j = active((x) => x.mode === 'icmp' && tokenOf(x) === ev.token);
        if (j === undefined) return [];
        switch (ev.outcome) {
          case 'reply':
            return settle(ctx, j, rtt(ctx, ev.sentAt), ev.from, 'reached');
          case 'ttl-exceeded':
            return settle(ctx, j, rtt(ctx, ev.sentAt), ev.from);
          case 'unreachable':
            return settle(ctx, j, flag(j, ev.code), ev.from, 'unreachable');
          case 'timeout':
            return settle(ctx, j, '*');
          default:
            return finish(ctx, j, `Cannot trace to ${j.dst}: no route.`);
        }
      }
      if (ev.kind === 'sock.opened') {
        const j = active((x) => x.mode === 'udp' && socketOf(x) === ev.socket && x.hop === 1 && x.probe === 0);
        return j === undefined ? [] : sendProbe(ctx, j);
      }
      if (ev.kind === 'sock.error') {
        const j = active((x) => x.mode === 'udp' && socketOf(x) === ev.socket);
        if (j === undefined) return [];
        if (ev.icmp === undefined) return finish(ctx, j, `Cannot trace to ${j.dst}: ${ev.detail ?? ev.code}.`);
        if (ev.icmp.quotedDstPort !== portOf(j)) {
          debug(ctx, `session ${j.session}: stale ${ev.code} for port ${String(ev.icmp.quotedDstPort)} ignored`, { session: j.session, code: ev.code });
          return [];
        }
        if (ev.code === 'ttl-exceeded') return settle(ctx, j, rtt(ctx, j.sentAt), ev.from);
        if (ev.code === 'port-unreachable') return settle(ctx, j, rtt(ctx, j.sentAt), ev.from, 'reached');
        return settle(ctx, j, flag(j, ev.icmp.code), ev.from, 'unreachable');
      }
      return [];
    },

    stateSnapshot(): StateView {
      return {
        process: NAME,
        state: {
          jobs: [...jobs.values()].map((j) => ({ session: j.session, target: j.target, address: j.dst ?? null, mode: j.mode, hop: j.hop, probe: j.probe, done: j.done })),
        },
      };
    },

    debugEvents(): readonly DebugEvent[] {
      return ring;
    },
  };
}
