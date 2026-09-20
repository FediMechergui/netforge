/**
 * protocols/tcp.ts — the TCP daemon (RFC 9293; RFC 6298 RTO; RFC 5681 Reno; RFC 1122 §4.2.2.17 persist;
 * ARCHITECTURE-P1 §4.2, §4.5; contracts/transport.ts).
 *
 * Requests: `tcp.listen` (LISTEN row + `sock.opened`), `tcp.connect` (SYN, `sock.connected` once established),
 * `tcp.send` (queue bytes), `tcp.close` (FIN after the queued data), `tcp.abort` (RST now, `sock.closed`).
 * Events to owners: `sock.accepted` (child '<listenId>/<n>' reached ESTABLISHED), `sock.data`, `sock.drained`,
 * `sock.peerClosed` (CLOSE_WAIT), `sock.closed` (CLOSED or TIME_WAIT reached), `sock.error` (connection gone).
 *
 * Receive: match the 4-tuple, else a LISTEN socket for a SYN, else RST ('R' seq=SEG.ACK when the segment had ACK,
 * else 'RA' ack=SEG.SEQ+SEG.LEN) and drop 'tcp port N closed'. Never a RST for a RST, and never anything for a
 * segment sent to a broadcast or multicast address (RFC 1122 §4.2.3.10): it is dropped 'not-for-me'.
 * Owner events (sock.data, sock.peerClosed) are handed over after our own ACK is built, so an owner that closes
 * synchronously produces the textbook FIN / ACK / FIN / ACK.
 *
 * Sending: segment = min(MSS, cwnd, peer window − in flight); Nagle holds sub-MSS segments while data is unacked.
 * Retransmissions (RTO go-back-N, fast retransmit after 3 duplicate ACKs) are NEW pdus tagged 'tcp-retransmit'
 * with `triggeredBy` the first transmission of that sequence number. RTO: RFC 6298 in integer ns, doubled per
 * expiry (max 60 s); 3 SYN retries, 5 data retransmits, then RST + `sock.error timeout`. Data-less segments (pure
 * ACKs, RSTs) leave at SND.MAX, which go-back-N may have moved past SND.NXT. Zero peer window → persist
 * probes (pure ACK at SND.NXT−1) with backoff, aborting after TCP_PERSIST_MAX_PROBES. Delayed ACK 200 ms (every
 * second in-order segment and anything out of order or carrying FIN is ACKed at once). TIME_WAIT lasts 2 × MSL.
 *
 * Determinism: ISN = `ctx.stream('isn').nextU32()` once per connection; ephemeral base drawn once per lifetime from
 * the process stream (same walk as udp). All arithmetic is integer.
 *
 * Timers (never periodic): `rto:<id>`, `dack:<id>`, `persist:<id>`, `timewait:<id>`.
 * Debug category 'tcp': every state change logs `{from, to, trigger, pdu}` and rewrites the socket row.
 *
 * ponytail: one file (the brief's tcp/{fsm,sender,receiver,congestion}.ts split is not needed at this size). Skipped:
 * window scaling, SACK, timestamps, simultaneous open, `tcp.connect.timeoutNs`, RFC 5961 challenge ACKs; our receive
 * window is always 65535 because data goes straight to the owner. Add when a lab needs them.
 */
import { isIpv4, isIpv4Broadcast, isIpv4Multicast, type IpAddress, type IpFamily } from '../contracts/addr.js';
import type { PduId, PortId, ProcessName } from '../contracts/ids.js';
import type { DropReason } from '../contracts/link.js';
import { IPPROTO_TCP, type FieldValue, type LayerSpec, type LayerView, type Pdu, type PduMeta } from '../contracts/pdu.js';
import type { Action, DebugEvent, Process, ProcessCtx, ProcessRequest, StateView } from '../contracts/process.js';
import { socketKey, type SocketRow, type Table } from '../contracts/tables.js';
import type { SimTime } from '../contracts/time.js';
import {
  EPHEMERAL_PORT_MAX,
  EPHEMERAL_PORT_MIN,
  TCP_DEFAULT_WINDOW,
  TCP_DELAYED_ACK_NS,
  TCP_DUPACK_THRESHOLD,
  TCP_INITIAL_RTO_NS,
  TCP_LISTEN_BACKLOG,
  TCP_MAX_RETRANSMITS,
  TCP_MAX_RTO_NS,
  TCP_MIN_RTO_NS,
  TCP_MSL_NS,
  TCP_MSS_IPV4,
  TCP_MSS_IPV6,
  TCP_PERSIST_MAX_PROBES,
  TCP_PERSIST_MIN_NS,
  TCP_SEND_BUFFER,
  TCP_SYN_RETRIES,
  type ProcessEvent,
  type SocketErrorCode,
  type SocketId,
  type TcpState,
} from '../contracts/transport.js';
import { flowKey, parseIpv6 } from '../core/addr6.js';
import { canonical, flowEndpoint, ipIndexFrom, nextEphemeralPort, udpBindsConflict, udpErrorCodeFor, udpWildcard, upperIndex } from './udp.js';

const NAME = 'tcp';
const CAT = 'tcp';
const DEBUG_RING = 256;
const EPHEMERAL_SPAN = EPHEMERAL_PORT_MAX - EPHEMERAL_PORT_MIN + 1;
/** States in which queued data and the FIN may be (re)transmitted. */
const SENDING: ReadonlySet<TcpState> = new Set(['ESTABLISHED', 'CLOSE_WAIT', 'FIN_WAIT_1', 'CLOSING', 'LAST_ACK']);
/** States that still accept new data from the peer. */
const RECEIVING: ReadonlySet<TcpState> = new Set(['ESTABLISHED', 'FIN_WAIT_1', 'FIN_WAIT_2']);

/** a + n in sequence space. */
const seqAdd = (a: number, n: number): number => (a + n) >>> 0;
/** a − b in sequence space (signed 32-bit). */
const seqDiff = (a: number, b: number): number => (a - b) | 0;

interface Listener {
  readonly id: SocketId;
  readonly owner: ProcessName;
  readonly family: IpFamily;
  readonly localAddr: IpAddress;
  readonly localPort: number;
  readonly backlog: number;
  children: number;
}

interface Conn {
  readonly id: SocketId;
  readonly owner: ProcessName;
  readonly family: IpFamily;
  readonly localAddr: IpAddress;
  readonly localPort: number;
  readonly remoteAddr: IpAddress;
  readonly remotePort: number;
  /** Passive open: the listener this child came from. */
  readonly listener?: SocketId;
  state: TcpState;
  iss: number;
  sndUna: number;
  sndNxt: number;
  /** Highest SND.NXT ever sent; a segment starting below it is a retransmission. */
  sndMax: number;
  sndWnd: number;
  irs: number;
  rcvNxt: number;
  mss: number;
  /** Bytes from SND.UNA on (unacked, then unsent). */
  buf: Uint8Array;
  /** tcp.close received: send the FIN once the buffer is out. */
  closing: boolean;
  finSeq?: number;
  cwnd: number;
  ssthresh: number;
  dupAcks: number;
  /** In Reno fast recovery. */
  recovering: boolean;
  rto: SimTime;
  srtt?: SimTime;
  rttvar: SimTime;
  /** One RTT measurement at a time (Karn: cleared on retransmission). */
  timing?: { seq: number; at: SimTime };
  retries: number;
  probes: number;
  rtoArmed: boolean;
  persistArmed: boolean;
  dack: boolean;
  drainWanted: boolean;
  /** ICMP soft error reported if the connection later times out. */
  softError?: SocketErrorCode;
  /** First transmission pdu per starting sequence number (triggeredBy of retransmissions). */
  readonly sent: Map<number, PduId>;
  /** Out-of-order segments by sequence number. */
  readonly ooo: Map<number, { data: Uint8Array; fin: boolean; pdu: Pdu }>;
}

interface Seg {
  seq: number;
  ack: number;
  flags: string;
  win: number;
  data: Uint8Array;
  mss?: number;
  pdu: Pdu;
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

/**
 * Create the TCP daemon. Reached via `deliver` (segments from ipv4/ipv6, ICMP errors quoting TCP from
 * icmpv4/icmpv6), requests and its own timers; it sends nothing unsolicited.
 */
export function createTcp(): Process {
  const listeners = new Map<SocketId, Listener>();
  const conns = new Map<SocketId, Conn>();
  const ring: DebugEvent[] = [];
  let ephemeralNext: number | undefined;
  let ipId = 0;
  let segmentsIn = 0;
  let segmentsOut = 0;
  let retransmits = 0;
  let resetsOut = 0;
  let checksumErrors = 0;

  function debug(ctx: ProcessCtx, message: string, data?: Record<string, unknown>): void {
    ctx.debug(CAT, message, data);
    const ev: DebugEvent = data
      ? { at: ctx.now, device: ctx.deviceId, process: NAME, category: CAT, message, data }
      : { at: ctx.now, device: ctx.deviceId, process: NAME, category: CAT, message };
    ring.push(ev);
    if (ring.length > DEBUG_RING) ring.splice(0, ring.length - DEBUG_RING);
  }

  const event = (to: ProcessName, ev: ProcessEvent): Action => ({ type: 'event', to, ev });

  function sockError(ctx: ProcessCtx, owner: ProcessName, socket: SocketId, code: SocketErrorCode, detail: string): Action {
    debug(ctx, `socket ${socket}: ${code} (${detail})`, { socket, code, owner });
    return event(owner, { kind: 'sock.error', socket, code, detail });
  }

  function drop(ctx: ProcessCtx, pdu: Pdu, reason: DropReason, detail: string, port: PortId): Action {
    debug(ctx, `drop pdu ${pdu.id}: ${reason} (${detail})`, { pdu: pdu.id, reason, detail, port });
    return { type: 'drop', pdu, reason, detail, port };
  }

  const table = (ctx: ProcessCtx): Table<SocketRow> | undefined => ctx.tables.get<SocketRow>('sockets');

  function writeRow(ctx: ProcessCtx, c: Conn): void {
    const row: SocketRow = {
      key: socketKey('tcp', c.id),
      id: c.id,
      proto: 'tcp',
      family: c.family,
      localAddr: c.localAddr,
      localPort: c.localPort,
      remoteAddr: c.remoteAddr,
      remotePort: c.remotePort,
      state: c.state,
      owner: c.owner,
      updatedAt: ctx.now,
    };
    if (c.state === 'TIME_WAIT') row.expiresAt = ctx.now + 2 * TCP_MSL_NS;
    table(ctx)?.set(row);
  }

  function setState(ctx: ProcessCtx, c: Conn, to: TcpState, trigger: string, pdu?: Pdu): void {
    const from = c.state;
    c.state = to;
    debug(ctx, `${c.id} ${from} -> ${to} (${trigger})`, { socket: c.id, from, to, trigger, pdu: pdu?.id });
    writeRow(ctx, c);
  }

  /** Forget a connection: row, timers, map entry. */
  function remove(ctx: ProcessCtx, c: Conn, trigger: string, pdu?: Pdu): Action[] {
    if (c.state !== 'CLOSED') debug(ctx, `${c.id} ${c.state} -> CLOSED (${trigger})`, { socket: c.id, from: c.state, to: 'CLOSED', trigger, pdu: pdu?.id });
    c.state = 'CLOSED';
    conns.delete(c.id);
    table(ctx)?.delete(socketKey('tcp', c.id), 'cleared');
    return ['rto', 'dack', 'persist', 'timewait'].map((t): Action => ({ type: 'cancelTimer', key: `${t}:${c.id}` }));
  }

  /** Every bound (family, addr, port) that a new bind must not overlap: listeners and active opens. */
  function bindConflict(family: IpFamily, localAddr: IpAddress, localPort: number): SocketId | undefined {
    for (const l of listeners.values()) if (udpBindsConflict(l, { family, localAddr, localPort })) return l.id;
    for (const c of conns.values()) if (c.listener === undefined && udpBindsConflict(c, { family, localAddr, localPort })) return c.id;
    return undefined;
  }

  /** A TIME_WAIT connection gives its id up to a new socket; any other holder refuses it. */
  function idBusy(ctx: ProcessCtx, id: SocketId, out: Action[]): boolean {
    if (listeners.has(id)) return true;
    const c = conns.get(id);
    if (c === undefined) return false;
    if (c.state !== 'TIME_WAIT') return true;
    out.push(...remove(ctx, c, 'id reused'));
    return false;
  }

  const ourMss = (family: IpFamily): number => (family === 4 ? TCP_MSS_IPV4 : TCP_MSS_IPV6);

  // ── segments out ──────────────────────────────────────────────────────────

  function emit(
    ctx: ProcessCtx,
    family: IpFamily,
    src: IpAddress,
    dst: IpAddress,
    srcPort: number,
    dstPort: number,
    fields: Record<string, FieldValue>,
    data: Uint8Array | undefined,
    meta: Partial<PduMeta>,
  ): Action {
    let ip: LayerSpec;
    if (family === 4) {
      ipId = (ipId + 1) & 0xffff;
      ip = { proto: 'ipv4', fields: { src, dst, protocol: IPPROTO_TCP, ttl: ctx.model.ipDefaults.ttl, id: ipId } };
    } else {
      ip = { proto: 'ipv6', fields: { src, dst, nextHeader: IPPROTO_TCP, hopLimit: ctx.model.ipDefaults.hopLimit } };
    }
    const layers: LayerSpec[] = [ip, { proto: 'tcp', fields: { srcPort, dstPort, window: TCP_DEFAULT_WINDOW, ...fields } }];
    if (data !== undefined && data.length > 0) layers.push({ proto: 'payload', fields: { data } });
    const pdu = ctx.newPdu(layers, { flow: flowKey(family, src, dst, 'tcp', srcPort, dstPort), ...meta });
    segmentsOut++;
    return family === 4 ? { type: 'request', to: 'ipv4', req: { kind: 'ipv4.send', pdu } } : { type: 'request', to: 'ipv6', req: { kind: 'ipv6.send', pdu } };
  }

  /** First transmission covering `seq` (largest recorded start ≤ seq). */
  function originalOf(c: Conn, seq: number): PduId | undefined {
    let best: number | undefined;
    for (const s of c.sent.keys()) if (seqDiff(seq, s) >= 0 && (best === undefined || seqDiff(s, best) > 0)) best = s;
    return best === undefined ? undefined : c.sent.get(best);
  }

  /** Send one segment of connection `c` at `seq`; retransmissions are tagged and linked to the original. */
  function segment(ctx: ProcessCtx, c: Conn, seq: number, flags: string, data?: Uint8Array, extra: Record<string, FieldValue> = {}, tag?: string): Action[] {
    const retx = seqDiff(c.sndMax, seq) > 0 && (data !== undefined || flags.includes('S') || flags.includes('F'));
    let meta: Partial<PduMeta> = tag !== undefined ? { tag } : {};
    if (retx) {
      retransmits++;
      const orig = originalOf(c, seq);
      meta = orig !== undefined ? { tag: 'tcp-retransmit', triggeredBy: orig } : { tag: 'tcp-retransmit' };
    }
    const fields: Record<string, FieldValue> = { seq, flags, ...extra };
    if (flags.includes('A')) fields.ack = c.rcvNxt;
    const out: Action[] = [emit(ctx, c.family, c.localAddr, c.remoteAddr, c.localPort, c.remotePort, fields, data, meta)];
    const req = out[0] as Extract<Action, { type: 'request' }>;
    const pdu = (req.req as { pdu: Pdu }).pdu;
    if (!retx && (data !== undefined || flags.includes('S') || flags.includes('F'))) c.sent.set(seq, pdu.id);
    if (flags.includes('A') && c.dack) {
      c.dack = false;
      out.push({ type: 'cancelTimer', key: `dack:${c.id}` });
    }
    return out;
  }

  /** A data-less segment leaves at SND.MAX, as BSD does: go-back-N may have pulled SND.NXT below it. */
  function ackNow(ctx: ProcessCtx, c: Conn): Action[] {
    return segment(ctx, c, c.sndMax, 'A');
  }

  function armRto(c: Conn): Action {
    c.rtoArmed = true;
    return { type: 'timer', key: `rto:${c.id}`, delay: c.rto };
  }

  function armPersist(c: Conn): Action[] {
    if (c.persistArmed) return [];
    c.persistArmed = true;
    let delay = Math.max(TCP_PERSIST_MIN_NS, c.rto);
    for (let i = 0; i < c.probes; i++) delay = Math.min(delay * 2, TCP_MAX_RTO_NS);
    return [{ type: 'timer', key: `persist:${c.id}`, delay }];
  }

  /** One segment at `seq`: buffered data (≤ maxLen bytes), else the FIN when it sits there. Returns seq space used. */
  function sendAt(ctx: ProcessCtx, c: Conn, seq: number, maxLen: number, out: Action[]): number {
    const off = seqDiff(seq, c.sndUna);
    const avail = c.buf.length - off;
    let used = 0;
    if (avail > 0) {
      used = Math.min(maxLen, avail);
      out.push(...segment(ctx, c, seq, off + used === c.buf.length ? 'PA' : 'A', c.buf.subarray(off, off + used)));
    } else if (c.closing && avail === 0) {
      used = 1;
      out.push(...segment(ctx, c, seq, 'FA'));
      if (c.finSeq === undefined) {
        c.finSeq = seq;
        setState(ctx, c, c.state === 'CLOSE_WAIT' ? 'LAST_ACK' : 'FIN_WAIT_1', 'close');
      }
    } else return 0;
    const end = seqAdd(seq, used);
    if (seqDiff(end, c.sndMax) > 0) {
      if (c.timing === undefined) c.timing = { seq: end, at: ctx.now };
      c.sndMax = end;
    }
    if (!c.rtoArmed) out.push(armRto(c));
    return used;
  }

  /** Transmit whatever window, cwnd and Nagle allow, then the FIN if closing. */
  function output(ctx: ProcessCtx, c: Conn): Action[] {
    const out: Action[] = [];
    if (!SENDING.has(c.state)) return out;
    for (;;) {
      const off = seqDiff(c.sndNxt, c.sndUna);
      const unsent = c.buf.length - off;
      let len: number;
      if (unsent > 0) {
        if (c.sndWnd === 0) {
          if (off === 0) out.push(...armPersist(c));
          break;
        }
        len = Math.min(c.mss, unsent, Math.min(c.cwnd, c.sndWnd) - off);
        if (len <= 0 || (len < c.mss && off > 0)) break;
      } else if (unsent === 0 && c.closing) len = 1;
      else break;
      const used = sendAt(ctx, c, c.sndNxt, len, out);
      if (used === 0) break;
      c.sndNxt = seqAdd(c.sndNxt, used);
    }
    return out;
  }

  // ── requests ──────────────────────────────────────────────────────────────

  function allocateEphemeral(ctx: ProcessCtx, family: IpFamily, localAddr: IpAddress): number | undefined {
    if (ephemeralNext === undefined) {
      ephemeralNext = EPHEMERAL_PORT_MIN + ctx.rng.nextInt(0, EPHEMERAL_SPAN - 1);
      debug(ctx, `ephemeral ports start at ${ephemeralNext}`, { base: ephemeralNext });
    }
    const port = nextEphemeralPort(ephemeralNext, (p) => bindConflict(family, localAddr, p) === undefined);
    if (port !== undefined) ephemeralNext = port === EPHEMERAL_PORT_MAX ? EPHEMERAL_PORT_MIN : port + 1;
    return port;
  }

  function isOwn(ctx: ProcessCtx, family: IpFamily, addr: IpAddress): boolean {
    return family === 4 ? ctx.ownAddress(addr) !== undefined : ctx.ownAddress6(addr) !== undefined;
  }

  function listen(ctx: ProcessCtx, req: Extract<ProcessRequest, { kind: 'tcp.listen' }>): Action[] {
    const { owner, socket, family } = req;
    const out: Action[] = [];
    if (idBusy(ctx, socket, out)) return [sockError(ctx, owner, socket, 'addr-in-use', `socket id ${socket} is already open`)];
    if (family !== 4 && family !== 6) return [sockError(ctx, owner, socket, 'bad-socket', `unknown address family ${String(family)}`)];
    let localAddr = udpWildcard(family);
    if (req.localAddr !== undefined) {
      const a = canonical(family, req.localAddr);
      if (a === null) return [sockError(ctx, owner, socket, 'bad-socket', `${req.localAddr} is not an IPv${family} address`)];
      if (a !== localAddr && !isOwn(ctx, family, a)) return [sockError(ctx, owner, socket, 'no-address', `${a} is not an address of this device`)];
      localAddr = a;
    }
    let localPort = req.localPort;
    if (localPort === 0) {
      const p = allocateEphemeral(ctx, family, localAddr);
      if (p === undefined) return [sockError(ctx, owner, socket, 'addr-in-use', 'every ephemeral port is in use')];
      localPort = p;
    } else if (!Number.isInteger(localPort) || localPort < 1 || localPort > 0xffff) {
      return [sockError(ctx, owner, socket, 'bad-socket', `port ${String(localPort)} is outside 1-65535`)];
    }
    const clash = bindConflict(family, localAddr, localPort);
    if (clash !== undefined) return [sockError(ctx, owner, socket, 'addr-in-use', `port ${localPort} is already bound by ${clash}`)];
    const backlog = Math.max(1, Math.min(req.backlog ?? TCP_LISTEN_BACKLOG, TCP_LISTEN_BACKLOG));
    listeners.set(socket, { id: socket, owner, family, localAddr, localPort, backlog, children: 0 });
    table(ctx)?.set({ key: socketKey('tcp', socket), id: socket, proto: 'tcp', family, localAddr, localPort, state: 'LISTEN', owner, updatedAt: ctx.now });
    debug(ctx, `${socket} CLOSED -> LISTEN on ${flowEndpoint(family, localAddr, localPort)} for ${owner}`, { socket, from: 'CLOSED', to: 'LISTEN', trigger: 'listen' });
    out.push(event(owner, { kind: 'sock.opened', socket, proto: 'tcp', family, localAddr, localPort }));
    return out;
  }

  function newConn(
    p: Pick<Conn, 'id' | 'owner' | 'family' | 'localAddr' | 'localPort' | 'remoteAddr' | 'remotePort'> & { listener?: SocketId },
    iss: number,
  ): Conn {
    const mss = ourMss(p.family);
    const c: Conn = {
      ...p,
      state: 'CLOSED',
      iss,
      sndUna: iss,
      sndNxt: iss,
      sndMax: iss,
      sndWnd: 0,
      irs: 0,
      rcvNxt: 0,
      mss,
      buf: new Uint8Array(0),
      closing: false,
      cwnd: Math.min(4 * mss, Math.max(2 * mss, 4380)),
      ssthresh: TCP_SEND_BUFFER,
      dupAcks: 0,
      recovering: false,
      rto: TCP_INITIAL_RTO_NS,
      rttvar: 0,
      retries: 0,
      probes: 0,
      rtoArmed: false,
      persistArmed: false,
      dack: false,
      drainWanted: false,
      sent: new Map(),
      ooo: new Map(),
    };
    conns.set(c.id, c);
    return c;
  }

  const isn = (ctx: ProcessCtx): number => ctx.stream('isn').nextU32();

  function sendSyn(ctx: ProcessCtx, c: Conn): Action[] {
    const out: Action[] = [];
    const flags = c.state === 'SYN_SENT' ? 'S' : 'SA';
    out.push(...segment(ctx, c, c.iss, flags, undefined, { mss: ourMss(c.family) }, flags === 'S' ? 'tcp-syn' : undefined));
    if (c.sndMax === c.iss) {
      c.sndNxt = c.sndMax = seqAdd(c.iss, 1);
      c.timing = { seq: c.sndMax, at: ctx.now };
    }
    out.push(armRto(c));
    return out;
  }

  function connect(ctx: ProcessCtx, req: Extract<ProcessRequest, { kind: 'tcp.connect' }>): Action[] {
    const { owner, socket } = req;
    const out: Action[] = [];
    if (idBusy(ctx, socket, out)) return [sockError(ctx, owner, socket, 'addr-in-use', `socket id ${socket} is already open`)];
    const family: IpFamily = isIpv4(req.dst) ? 4 : 6;
    const dst = canonical(family, req.dst);
    if (dst === null) return [sockError(ctx, owner, socket, 'bad-socket', `${req.dst} is not an IP address`)];
    if (!Number.isInteger(req.dstPort) || req.dstPort < 1 || req.dstPort > 0xffff) {
      return [sockError(ctx, owner, socket, 'bad-socket', `destination port ${String(req.dstPort)} is outside 1-65535`)];
    }
    let src: IpAddress;
    if (req.src !== undefined) {
      const a = canonical(family, req.src);
      if (a === null || !isOwn(ctx, family, a)) return [sockError(ctx, owner, socket, 'no-address', `${req.src} is not an IPv${family} address of this device`)];
      src = a;
    } else {
      const sel = family === 4 ? ctx.sourceFor(dst) : ctx.sourceFor6(dst);
      if (sel === undefined) {
        const routed = family === 4 ? ctx.lpm(dst).winner !== undefined : ctx.lpm6(dst).winner !== undefined;
        return [sockError(ctx, owner, socket, routed ? 'no-address' : 'no-route', routed ? `no usable source address towards ${dst}` : `no route to ${dst}`)];
      }
      src = sel.address;
    }
    const localPort = allocateEphemeral(ctx, family, src);
    if (localPort === undefined) return [sockError(ctx, owner, socket, 'addr-in-use', 'every ephemeral port is in use')];
    const c = newConn({ id: socket, owner, family, localAddr: src, localPort, remoteAddr: dst, remotePort: req.dstPort }, isn(ctx));
    setState(ctx, c, 'SYN_SENT', 'connect');
    out.push(...sendSyn(ctx, c));
    return out;
  }

  function send(ctx: ProcessCtx, req: Extract<ProcessRequest, { kind: 'tcp.send' }>): Action[] {
    const c = conns.get(req.socket);
    if (c === undefined || c.closing || !(c.state === 'SYN_SENT' || c.state === 'SYN_RECEIVED' || c.state === 'ESTABLISHED' || c.state === 'CLOSE_WAIT')) {
      const owner = c?.owner ?? listeners.get(req.socket)?.owner;
      if (owner === undefined) return [];
      return [sockError(ctx, owner, req.socket, 'bad-socket', 'the connection is not open for sending')];
    }
    if (c.buf.length + req.data.length > TCP_SEND_BUFFER) return [sockError(ctx, c.owner, c.id, 'bad-socket', 'send buffer full')];
    if (req.data.length === 0) return [];
    c.buf = concat(c.buf, req.data);
    c.drainWanted = true;
    return output(ctx, c);
  }

  function closeListener(ctx: ProcessCtx, l: Listener): Action[] {
    listeners.delete(l.id);
    table(ctx)?.delete(socketKey('tcp', l.id), 'cleared');
    debug(ctx, `${l.id} LISTEN -> CLOSED (close)`, { socket: l.id, from: 'LISTEN', to: 'CLOSED', trigger: 'close' });
    return [event(l.owner, { kind: 'sock.closed', socket: l.id })];
  }

  function close(ctx: ProcessCtx, req: Extract<ProcessRequest, { kind: 'tcp.close' }>): Action[] {
    const l = listeners.get(req.socket);
    if (l !== undefined) return closeListener(ctx, l);
    const c = conns.get(req.socket);
    if (c === undefined || c.closing) return [];
    if (c.state === 'SYN_SENT') return [...remove(ctx, c, 'close'), event(c.owner, { kind: 'sock.closed', socket: c.id })];
    c.closing = true;
    return output(ctx, c);
  }

  function abort(ctx: ProcessCtx, req: Extract<ProcessRequest, { kind: 'tcp.abort' }>): Action[] {
    const l = listeners.get(req.socket);
    if (l !== undefined) return closeListener(ctx, l);
    const c = conns.get(req.socket);
    if (c === undefined) return [];
    const out: Action[] = [];
    if (c.state !== 'SYN_SENT' && c.state !== 'TIME_WAIT') {
      resetsOut++;
      out.push(...segment(ctx, c, c.sndMax, 'R'));
    }
    const wasTimeWait = c.state === 'TIME_WAIT';
    out.push(...remove(ctx, c, 'abort'));
    if (!wasTimeWait) out.push(event(c.owner, { kind: 'sock.closed', socket: c.id }));
    return out;
  }

  /** Give up on a connection: RST (when synchronized) + sock.error. */
  function fail(ctx: ProcessCtx, c: Conn, code: SocketErrorCode, detail: string, rst: boolean): Action[] {
    const out: Action[] = [];
    if (rst) {
      resetsOut++;
      out.push(...segment(ctx, c, c.sndMax, 'R'));
    }
    out.push(...remove(ctx, c, code));
    out.push(sockError(ctx, c.owner, c.id, code, detail));
    return out;
  }

  // ── receive ───────────────────────────────────────────────────────────────

  function findConn(family: IpFamily, local: IpAddress, localPort: number, remote: IpAddress, remotePort: number): Conn | undefined {
    for (const c of conns.values()) {
      if (c.family === family && c.localPort === localPort && c.remotePort === remotePort && c.localAddr === local && c.remoteAddr === remote) return c;
    }
    return undefined;
  }

  function findListener(family: IpFamily, dst: IpAddress, port: number): Listener | undefined {
    let wild: Listener | undefined;
    for (const l of listeners.values()) {
      if (l.family !== family || l.localPort !== port) continue;
      if (l.localAddr === dst) return l;
      if (wild === undefined && l.localAddr === udpWildcard(family)) wild = l;
    }
    return wild;
  }

  function rtt(c: Conn, r: SimTime): void {
    if (c.srtt === undefined) {
      c.srtt = r;
      c.rttvar = Math.floor(r / 2);
    } else {
      c.rttvar = Math.floor((3 * c.rttvar + Math.abs(c.srtt - r)) / 4);
      c.srtt = Math.floor((7 * c.srtt + r) / 8);
    }
    // + the peer's delayed-ACK allowance, so a lone segment's delayed ACK never races the RTO on a LAN (RTT ≈ 0)
    c.rto = Math.min(TCP_MAX_RTO_NS, Math.max(TCP_MIN_RTO_NS, c.srtt + 4 * c.rttvar) + TCP_DELAYED_ACK_NS);
  }

  function passiveOpen(ctx: ProcessCtx, l: Listener, family: IpFamily, dst: IpAddress, src: IpAddress, srcPort: number, s: Seg, port: PortId): Action[] {
    let pending = 0;
    for (const c of conns.values()) if (c.listener === l.id && c.state === 'SYN_RECEIVED') pending++;
    if (pending >= l.backlog) return [drop(ctx, s.pdu, 'queue-full', `listen backlog of ${l.id} is full`, port)];
    // a re-opened listener starts counting again, so skip ids a live child still holds
    do {
      l.children++;
    } while (conns.has(`${l.id}/${l.children}`));
    const c = newConn({ id: `${l.id}/${l.children}`, owner: l.owner, family, localAddr: dst, localPort: l.localPort, remoteAddr: src, remotePort: srcPort, listener: l.id }, isn(ctx));
    c.irs = s.seq;
    c.rcvNxt = seqAdd(s.seq, 1);
    c.sndWnd = s.win;
    c.mss = Math.min(c.mss, s.mss ?? (family === 4 ? 536 : 1220));
    setState(ctx, c, 'SYN_RECEIVED', 'syn', s.pdu);
    return [{ type: 'consume', pdu: s.pdu }, ...sendSyn(ctx, c)];
  }

  /** RST for a segment that matched no socket (RFC 9293 §3.10.7.1). */
  function resetFor(ctx: ProcessCtx, family: IpFamily, src: IpAddress, dst: IpAddress, srcPort: number, dstPort: number, s: Seg): Action {
    resetsOut++;
    const meta: Partial<PduMeta> = { triggeredBy: s.pdu.id };
    if (s.flags.includes('A')) return emit(ctx, family, dst, src, dstPort, srcPort, { seq: s.ack, flags: 'R', window: 0 }, undefined, meta);
    const len = s.data.length + (s.flags.includes('S') ? 1 : 0) + (s.flags.includes('F') ? 1 : 0);
    return emit(ctx, family, dst, src, dstPort, srcPort, { seq: 0, ack: seqAdd(s.seq, len), flags: 'RA', window: 0 }, undefined, meta);
  }

  function enterTimeWait(ctx: ProcessCtx, c: Conn, pdu: Pdu, out: Action[]): void {
    setState(ctx, c, 'TIME_WAIT', 'fin', pdu);
    c.rtoArmed = c.persistArmed = false;
    out.push({ type: 'cancelTimer', key: `rto:${c.id}` }, { type: 'cancelTimer', key: `persist:${c.id}` });
    out.push({ type: 'timer', key: `timewait:${c.id}`, delay: 2 * TCP_MSL_NS });
    out.push(event(c.owner, { kind: 'sock.closed', socket: c.id }));
  }

  /** ACK field processing for a synchronized connection. */
  function onAck(ctx: ProcessCtx, c: Conn, s: Seg, out: Action[]): void {
    if (seqDiff(s.ack, c.sndMax) > 0) {
      out.push(...ackNow(ctx, c));
      return;
    }
    const fin = s.flags.includes('F');
    if (seqDiff(s.ack, c.sndUna) > 0) {
      const dataAcked = Math.min(seqDiff(s.ack, c.sndUna), c.buf.length);
      c.buf = c.buf.subarray(dataAcked);
      c.sndUna = s.ack;
      if (seqDiff(s.ack, c.sndNxt) > 0) c.sndNxt = s.ack;
      if (c.timing !== undefined && seqDiff(s.ack, c.timing.seq) >= 0) {
        rtt(c, ctx.now - c.timing.at);
        c.timing = undefined;
      }
      c.retries = 0;
      if (c.recovering) {
        c.cwnd = c.ssthresh;
        c.recovering = false;
      } else if (c.cwnd < c.ssthresh) c.cwnd += Math.min(dataAcked, c.mss);
      else c.cwnd += Math.max(1, Math.floor((c.mss * c.mss) / c.cwnd));
      c.dupAcks = 0;
      // keep only the last fully-or-partly acked start (a later retransmission from SND.UNA may still need it)
      let keep: number | undefined;
      for (const k of c.sent.keys()) if (seqDiff(c.sndUna, k) > 0 && (keep === undefined || seqDiff(k, keep) > 0)) keep = k;
      for (const k of [...c.sent.keys()]) if (seqDiff(c.sndUna, k) > 0 && k !== keep) c.sent.delete(k);
      if (c.sndUna === c.sndMax) {
        c.rtoArmed = false;
        out.push({ type: 'cancelTimer', key: `rto:${c.id}` });
      } else out.push(armRto(c));
      if (dataAcked > 0 && c.buf.length === 0 && c.drainWanted) {
        c.drainWanted = false;
        out.push(event(c.owner, { kind: 'sock.drained', socket: c.id }));
      }
    } else if (s.ack === c.sndUna && s.data.length === 0 && !fin && s.win === c.sndWnd && c.sndMax !== c.sndUna) {
      c.dupAcks++;
      if (c.dupAcks === TCP_DUPACK_THRESHOLD) {
        c.ssthresh = Math.max(Math.floor(seqDiff(c.sndMax, c.sndUna) / 2), 2 * c.mss);
        c.recovering = true;
        c.timing = undefined;
        debug(ctx, `${c.id} fast retransmit at seq ${c.sndUna} after ${c.dupAcks} duplicate ACKs`, { socket: c.id, seq: c.sndUna, pdu: s.pdu.id });
        sendAt(ctx, c, c.sndUna, c.mss, out);
        c.cwnd = c.ssthresh + 3 * c.mss;
      } else if (c.dupAcks > TCP_DUPACK_THRESHOLD && c.recovering) c.cwnd += c.mss;
    }
    c.sndWnd = s.win;
    if (s.win > 0 && (c.persistArmed || c.probes > 0)) {
      c.probes = 0;
      c.persistArmed = false;
      out.push({ type: 'cancelTimer', key: `persist:${c.id}` });
    }
  }

  function deliver(c: Conn, data: Uint8Array, pdu: Pdu, out: Action[]): void {
    c.rcvNxt = seqAdd(c.rcvNxt, data.length);
    if (data.length > 0) out.push(event(c.owner, { kind: 'sock.data', socket: c.id, data, pdu }));
  }

  /** A segment for an existing connection. */
  function onSegment(ctx: ProcessCtx, c: Conn, s: Seg): Action[] {
    const out: Action[] = [{ type: 'consume', pdu: s.pdu }];
    const has = (f: string): boolean => s.flags.includes(f);

    if (c.state === 'SYN_SENT') {
      if (has('A') && s.ack !== seqAdd(c.iss, 1)) {
        if (!has('R')) out.push(resetFor(ctx, c.family, c.remoteAddr, c.localAddr, c.remotePort, c.localPort, s));
        return out;
      }
      if (has('R')) {
        if (has('A')) out.push(...fail(ctx, c, 'refused', `connection refused by ${c.remoteAddr}`, false));
        return out;
      }
      if (!has('S') || !has('A')) return out; // ponytail: no simultaneous open
      c.irs = s.seq;
      c.rcvNxt = seqAdd(s.seq, 1);
      c.mss = Math.min(c.mss, s.mss ?? (c.family === 4 ? 536 : 1220));
      c.sndUna = s.ack;
      c.sndWnd = s.win;
      if (c.timing !== undefined) rtt(c, ctx.now - c.timing.at);
      c.timing = undefined;
      c.retries = 0;
      c.rtoArmed = false;
      out.push({ type: 'cancelTimer', key: `rto:${c.id}` });
      setState(ctx, c, 'ESTABLISHED', 'syn-ack', s.pdu);
      out.push(...ackNow(ctx, c));
      out.push(event(c.owner, { kind: 'sock.connected', socket: c.id, localAddr: c.localAddr, localPort: c.localPort, remoteAddr: c.remoteAddr, remotePort: c.remotePort }));
      out.push(...output(ctx, c));
      return out;
    }

    const d = seqDiff(s.seq, c.rcvNxt);
    if (has('R')) {
      if (d !== 0) return out;
      if (c.state === 'SYN_RECEIVED' && c.listener !== undefined) {
        out.push(...remove(ctx, c, 'reset', s.pdu));
      } else if (c.state === 'CLOSING' || c.state === 'LAST_ACK' || c.state === 'TIME_WAIT') {
        const wasTimeWait = c.state === 'TIME_WAIT';
        out.push(...remove(ctx, c, 'reset', s.pdu));
        if (!wasTimeWait) out.push(event(c.owner, { kind: 'sock.closed', socket: c.id }));
      } else {
        out.push(...remove(ctx, c, 'reset', s.pdu));
        out.push(sockError(ctx, c.owner, c.id, 'reset', `connection reset by ${c.remoteAddr}`));
      }
      return out;
    }
    if (has('S')) {
      if (c.state === 'SYN_RECEIVED' && s.seq === c.irs) out.push(...sendSyn(ctx, c));
      else out.push(...ackNow(ctx, c));
      return out;
    }
    if (!has('A')) return out;

    if (c.state === 'SYN_RECEIVED') {
      if (s.ack !== seqAdd(c.iss, 1)) {
        out.push(resetFor(ctx, c.family, c.remoteAddr, c.localAddr, c.remotePort, c.localPort, s));
        return out;
      }
      setState(ctx, c, 'ESTABLISHED', 'ack', s.pdu);
      out.push(
        event(c.owner, { kind: 'sock.accepted', socket: c.id, listener: c.listener ?? c.id, remoteAddr: c.remoteAddr, remotePort: c.remotePort, localAddr: c.localAddr, localPort: c.localPort }),
      );
    }

    const len = s.data.length + (has('F') ? 1 : 0);
    // ACK field: only for segments that reach RCV.NXT (old duplicates are just re-ACKed).
    if (seqDiff(seqAdd(s.seq, Math.max(len, 1)), c.rcvNxt) > 0) onAck(ctx, c, s, out);
    if (!conns.has(c.id)) return out;

    // our FIN acknowledged?
    if (c.finSeq !== undefined && seqDiff(c.sndUna, c.finSeq) > 0) {
      if (c.state === 'FIN_WAIT_1') setState(ctx, c, 'FIN_WAIT_2', 'ack of fin', s.pdu);
      else if (c.state === 'CLOSING') enterTimeWait(ctx, c, s.pdu, out);
      else if (c.state === 'LAST_ACK') {
        out.push(...remove(ctx, c, 'ack of fin', s.pdu));
        out.push(event(c.owner, { kind: 'sock.closed', socket: c.id }));
        return out;
      }
    }

    if (len === 0) {
      if (d < 0 && c.state !== 'TIME_WAIT') out.push(...ackNow(ctx, c)); // window probe / old duplicate
      out.push(...output(ctx, c));
      return out;
    }
    if (!RECEIVING.has(c.state)) {
      if (c.state === 'TIME_WAIT' && has('F')) out.push({ type: 'timer', key: `timewait:${c.id}`, delay: 2 * TCP_MSL_NS });
      out.push(...ackNow(ctx, c));
      return out;
    }

    let data = s.data;
    let immediate = false;
    // the owner's events wait until our ACK is built: a synchronous tcp.close then gives FIN / ACK / FIN / ACK
    const evs: Action[] = [];
    if (d > 0) {
      c.ooo.set(s.seq, { data, fin: has('F'), pdu: s.pdu });
      out.push(...ackNow(ctx, c));
      out.push(...output(ctx, c));
      return out;
    }
    if (d < 0) {
      if (seqDiff(seqAdd(s.seq, len), c.rcvNxt) <= 0) {
        out.push(...ackNow(ctx, c));
        return out;
      }
      data = data.subarray(Math.min(-d, data.length));
    }
    deliver(c, data, s.pdu, evs);
    let fin = has('F');
    let finPdu = s.pdu;
    // drain queued out-of-order segments that are now contiguous
    while (!fin && c.ooo.size > 0) {
      let next: number | undefined;
      for (const k of c.ooo.keys()) {
        const e = c.ooo.get(k)!;
        if (seqDiff(seqAdd(k, e.data.length + (e.fin ? 1 : 0)), c.rcvNxt) <= 0) c.ooo.delete(k);
        else if (seqDiff(k, c.rcvNxt) <= 0) next = k;
      }
      if (next === undefined) break;
      const e = c.ooo.get(next)!;
      c.ooo.delete(next);
      immediate = true;
      deliver(c, e.data.subarray(Math.min(seqDiff(c.rcvNxt, next), e.data.length)), e.pdu, evs);
      if (e.fin) {
        fin = true;
        finPdu = e.pdu;
      }
    }
    if (fin) {
      c.rcvNxt = seqAdd(c.rcvNxt, 1);
      c.ooo.clear();
      if (c.state === 'ESTABLISHED') {
        setState(ctx, c, 'CLOSE_WAIT', 'fin', finPdu);
        evs.push(event(c.owner, { kind: 'sock.peerClosed', socket: c.id }));
      } else if (c.state === 'FIN_WAIT_1') setState(ctx, c, 'CLOSING', 'fin', finPdu);
      else if (c.state === 'FIN_WAIT_2') enterTimeWait(ctx, c, finPdu, evs);
      immediate = true;
    }
    if (immediate || c.dack || c.ooo.size > 0) out.push(...ackNow(ctx, c));
    else {
      c.dack = true;
      out.push({ type: 'timer', key: `dack:${c.id}`, delay: TCP_DELAYED_ACK_NS });
    }
    out.push(...output(ctx, c), ...evs);
    return out;
  }

  function receiveSegment(ctx: ProcessCtx, pdu: Pdu, ipLayer: LayerView, t: LayerView, port: PortId): Action[] {
    const family: IpFamily = ipLayer.proto === 'ipv4' ? 4 : 6;
    const f = t.fields;
    if (t.error !== undefined || typeof f.srcPort !== 'number' || typeof f.dstPort !== 'number' || typeof f.dataOffset !== 'number') {
      return [drop(ctx, pdu, 'other', t.error ?? 'TCP header truncated', port)];
    }
    if (f.checksumValid === false) {
      checksumErrors++;
      return [drop(ctx, pdu, 'bad-checksum', 'TCP checksum mismatch', port)];
    }
    segmentsIn++;
    const src = String(ipLayer.fields.src);
    const dst = String(ipLayer.fields.dst);
    const start = t.offset + f.dataOffset * 4;
    const s: Seg = {
      seq: Number(f.seq) >>> 0,
      ack: Number(f.ack ?? 0) >>> 0,
      flags: typeof f.flags === 'string' ? f.flags : '',
      win: Number(f.window ?? 0),
      data: pdu.bytes.slice(start, Math.max(start, t.offset + t.length)),
      pdu,
    };
    if (typeof f.mss === 'number') s.mss = f.mss;
    const c = findConn(family, dst, f.dstPort, src, f.srcPort);
    if (c !== undefined) return onSegment(ctx, c, s);
    // RFC 1122 §4.2.3.10: a segment to a broadcast or multicast address is discarded in silence — no listener, no RST
    const unicast = family === 4 ? ctx.ownAddress(dst) !== undefined && !isIpv4Broadcast(dst) && !isIpv4Multicast(dst) : parseIpv6(dst)?.[0] !== 0xff;
    if (!unicast) return [drop(ctx, pdu, 'not-for-me', `tcp segment to ${dst} is not a unicast address of this device`, port)];
    if (s.flags.includes('S') && !s.flags.includes('A') && !s.flags.includes('R')) {
      const l = findListener(family, dst, f.dstPort);
      if (l !== undefined) return passiveOpen(ctx, l, family, dst, src, f.srcPort, s, port);
    }
    const out: Action[] = [drop(ctx, pdu, 'unsupported-protocol', `tcp port ${f.dstPort} closed`, port)];
    if (!s.flags.includes('R')) out.push(resetFor(ctx, family, src, dst, f.srcPort, f.dstPort, s));
    return out;
  }

  function receiveError(ctx: ProcessCtx, pdu: Pdu, ipLayer: LayerView, errIdx: number): Action[] {
    const layers = pdu.layers;
    const err = layers[errIdx]!;
    const family: IpFamily = err.proto === 'icmpv4' ? 4 : 6;
    const type = Number(err.fields.type);
    const code = Number(err.fields.code);
    const from = String(ipLayer.fields.src);
    const qIpIdx = ipIndexFrom(layers, errIdx + 1);
    const qIp = qIpIdx < 0 ? undefined : layers[qIpIdx];
    const qTcpIdx = qIpIdx < 0 ? -1 : upperIndex(layers, qIpIdx);
    const qTcp = qTcpIdx < 0 ? undefined : layers[qTcpIdx];
    const out: Action[] = [{ type: 'consume', pdu }];
    if (qIp === undefined || qTcp?.proto !== 'tcp' || typeof qTcp.fields.srcPort !== 'number' || typeof qTcp.fields.dstPort !== 'number') return out;
    const qFamily: IpFamily = qIp.proto === 'ipv4' ? 4 : 6;
    const c = findConn(qFamily, String(qIp.fields.src), qTcp.fields.srcPort, String(qIp.fields.dst), qTcp.fields.dstPort);
    const sockCode = udpErrorCodeFor(family, type, code);
    if (c === undefined || sockCode === undefined) return out;
    const hard = sockCode === 'port-unreachable' || sockCode === 'proto-unreachable';
    if (c.state === 'SYN_SENT' && hard) {
      out.push(...fail(ctx, c, sockCode, `${sockCode} reported by ${from}`, false));
      return out;
    }
    c.softError = sockCode;
    debug(ctx, `${c.id}: soft error ${sockCode} from ${from} (type ${type} code ${code})`, { socket: c.id, pdu: pdu.id, type, code });
    return out;
  }

  // ── timers ────────────────────────────────────────────────────────────────

  function onRto(ctx: ProcessCtx, c: Conn): Action[] {
    c.rtoArmed = false;
    const timeout = (): Action[] => fail(ctx, c, c.softError ?? 'timeout', `no answer from ${c.remoteAddr}`, c.state !== 'SYN_SENT' && c.state !== 'SYN_RECEIVED');
    if (c.state === 'SYN_SENT' || c.state === 'SYN_RECEIVED') {
      if (c.retries >= TCP_SYN_RETRIES) {
        if (c.listener !== undefined) return remove(ctx, c, 'syn-ack timeout');
        return timeout();
      }
      c.retries++;
      c.rto = Math.min(c.rto * 2, TCP_MAX_RTO_NS);
      c.timing = undefined;
      return sendSyn(ctx, c);
    }
    if (!SENDING.has(c.state) || c.sndUna === c.sndMax) return [];
    if (c.retries >= TCP_MAX_RETRANSMITS) return timeout();
    c.retries++;
    c.ssthresh = Math.max(Math.floor(seqDiff(c.sndMax, c.sndUna) / 2), 2 * c.mss);
    c.cwnd = c.mss;
    c.dupAcks = 0;
    c.recovering = false;
    c.rto = Math.min(c.rto * 2, TCP_MAX_RTO_NS);
    c.timing = undefined;
    c.sndNxt = c.sndUna; // go-back-N
    debug(ctx, `${c.id} retransmission timeout, resending from seq ${c.sndUna} (rto now ${c.rto} ns)`, { socket: c.id, seq: c.sndUna, retries: c.retries });
    const out = output(ctx, c);
    if (!c.rtoArmed && c.sndUna !== c.sndMax) out.push(armRto(c));
    return out;
  }

  function onPersist(ctx: ProcessCtx, c: Conn): Action[] {
    c.persistArmed = false;
    if (c.sndWnd > 0) return output(ctx, c);
    if (c.probes >= TCP_PERSIST_MAX_PROBES) return fail(ctx, c, 'timeout', `peer window stayed closed after ${c.probes} probes`, true);
    c.probes++;
    const out = segment(ctx, c, seqAdd(c.sndNxt, -1), 'A', undefined, {}, 'tcp-window-probe');
    out.push(...armPersist(c));
    return out;
  }

  // ── the process ───────────────────────────────────────────────────────────

  return {
    name: NAME,

    init(): Action[] {
      return [];
    },

    onPdu(ctx: ProcessCtx, pdu: Pdu, port: PortId): Action[] {
      const layers = pdu.layers;
      const ipIdx = ipIndexFrom(layers, 0);
      const upIdx = ipIdx < 0 ? -1 : upperIndex(layers, ipIdx);
      if (ipIdx < 0 || upIdx < 0) return [drop(ctx, pdu, 'unsupported-protocol', 'not a TCP segment', port)];
      const upper = layers[upIdx]!;
      if (upper.proto === 'tcp') return receiveSegment(ctx, pdu, layers[ipIdx]!, upper, port);
      if (upper.proto === 'icmpv4' || upper.proto === 'icmpv6') return receiveError(ctx, pdu, layers[ipIdx]!, upIdx);
      return [drop(ctx, pdu, 'unsupported-protocol', 'not a TCP segment', port)];
    },

    onTimer(ctx: ProcessCtx, key: string): Action[] {
      const i = key.indexOf(':');
      const kind = key.slice(0, i);
      const c = conns.get(key.slice(i + 1));
      if (c === undefined) return [];
      switch (kind) {
        case 'rto':
          return onRto(ctx, c);
        case 'persist':
          return onPersist(ctx, c);
        case 'dack':
          return c.dack ? ackNow(ctx, c) : [];
        case 'timewait':
          return c.state === 'TIME_WAIT' ? remove(ctx, c, '2MSL timeout') : [];
        default:
          return [];
      }
    },

    onConfig(): Action[] {
      return [];
    },

    onRequest(ctx: ProcessCtx, req: ProcessRequest): Action[] {
      switch (req.kind) {
        case 'tcp.listen':
          return listen(ctx, req);
        case 'tcp.connect':
          return connect(ctx, req);
        case 'tcp.send':
          return send(ctx, req);
        case 'tcp.close':
          return close(ctx, req);
        case 'tcp.abort':
          return abort(ctx, req);
        default:
          return [];
      }
    },

    stateSnapshot(): StateView {
      return {
        process: NAME,
        state: {
          listeners: [...listeners.values()].map((l) => ({ id: l.id, owner: l.owner, family: l.family, localAddr: l.localAddr, localPort: l.localPort, backlog: l.backlog })),
          connections: [...conns.values()].map((c) => ({
            id: c.id,
            owner: c.owner,
            state: c.state,
            local: flowEndpoint(c.family, c.localAddr, c.localPort),
            remote: flowEndpoint(c.family, c.remoteAddr, c.remotePort),
            sndUna: c.sndUna,
            sndNxt: c.sndNxt,
            rcvNxt: c.rcvNxt,
            sndWnd: c.sndWnd,
            mss: c.mss,
            cwnd: c.cwnd,
            ssthresh: c.ssthresh,
            rtoNs: c.rto,
            srttNs: c.srtt ?? null,
            queued: c.buf.length,
          })),
          ephemeralNext: ephemeralNext ?? null,
          segmentsIn,
          segmentsOut,
          retransmits,
          resetsOut,
          checksumErrors,
        },
      };
    },

    debugEvents(): readonly DebugEvent[] {
      return ring;
    },
  };
}
