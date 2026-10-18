/**
 * protocols/tftp.ts — [S29] the TFTP daemon: the client of a `copy … tftp:` job and the server of `service tftp on`
 * (an NF-SERVER's `files:` store) and `tftp-server flash:<f>` (one flash file of a router or switch). RFC 1350, with
 * the RFC 2347 option extension and the RFC 2349 transfer size option `tsize`, the only option modelled
 * (ARCHITECTURE-P3C D10, §2.4 `tftp.transfer`, §2.5 `tftp.result`, §3.4, §4.1–§4.3; §7 W2a svc; ruling RC6 (b)).
 *
 * Silence (§4.3): with neither `service tftp on` nor a `tftp-server` line, and no `tftp.transfer` job, the daemon opens
 * no socket, arms no timer and sends nothing. An idle server only listens: it owns `tftp#69` (0.0.0.0:69) and arms
 * nothing until a request arrives.
 *
 * Transfer ids. The client sends its request from an ephemeral port (udp's deterministic allocator, §4.1: no rng
 * draw of its own) to port 69; the server answers from a fresh ephemeral port of its own and both sides lock to the
 * pair. A packet from any other port draws ERROR 5 from the receiving socket and aborts nothing. DATA and ACK between
 * two ephemeral ports are not port-dispatched by udp (RC6 (b)), so the daemon decodes every datagram of its sockets
 * itself (`tftpCodec`), whatever layers the received PDU carries. Every packet it sends is built as a `tftp` layer.
 *
 * Lock-step (§3.4 steps 1–2). The sender of the unacknowledged packet (a request, an OACK, a DATA block) retransmits
 * it after TFTP_RETRANSMIT_NS on the one-shot timer `tftp-rxmt:<token>`; the receiver re-acknowledges a duplicate DATA
 * (never storing it twice) and does not retransmit its ACK on its own (a lost ACK is repaired by the sender's
 * retransmission; a duplicate ACK is ignored, so no "sorcerer's apprentice" doubling). The receiver arms the same timer
 * to count silence. The sixth silence in a row ends the transfer (TFTP_RETRIES retransmissions): a dead server ends a
 * job 12 s after its first packet with `tftpTimeout`. After the final ACK the receiver dallies for
 * TFTP_DALLY_NS (one timer), re-acknowledging a retransmitted final block, then closes its socket.
 *
 * The client (`tftp.transfer {owner, token, session?, op, server, remote, local, image?}`):
 *  • `put` sends WRQ, then DATA 1…n of the local content (`running`: the rendered running configuration; a file of
 *    `files:` or `flash:`; `startup`: `readFile('nvram', 'startup-config')`, which the device does not serve in this
 *    build: a reported gap, so the job answers fileNotFound), n = ⌊length / 512⌋ + 1;
 *  • `get` sends RRQ; a copy into `flash:` (or an `image` copy) asks `tsize 0`, and the server's OACK size is checked
 *    against the flash before any DATA moves: for a name ending `.bin` the check counts `tsize × IMAGE_TRANSFER_SCALE`
 *    (the nominal size its image header will carry), else `tsize`. A copy that does not fit answers the OACK with
 *    ERROR 3 and ends with `flashFull`; no DATA moves. A server that ignores the option is checked as blocks arrive
 *    (the image header's nominal size once DATA 1 holds it) and aborted with ERROR 3 at the first block that would
 *    overflow. The rule is the device's own (`flashWriteProblem`, device/device.ts);
 *  • the received file goes to the store through the `storage` action, or (`running`) is applied line by line through
 *    the `configure` action with `origin {via: 'tftp', address: server}`: a merge (D10, M-6). `startup` is refused before
 *    any packet (the device keeps nvram's startup-config out of the storage action in this build: a reported gap);
 *  • a transfer of more than TFTP_MAX_BLOCKS blocks is refused before it starts;
 *  • on a managed switch whose transport is dormant (D22) the job holds it awake through `ext.ipv4.transportHold
 *    {owner: 'tftp', key: <token>, hold: true}` for its lifetime (dally included) and releases it at the end;
 *  • the job ends with `tftp.result {token, ok, bytes, blocks, error?}` to `owner`; for the CLI (`owner: 'cli'` with a
 *    `session`) the daemon prints the progress (one `!` per block) and the outcome, then `cliDone`.
 *
 * The server: an RRQ is answered from a new session socket — OACK `tsize` when the request asked it, else DATA 1; a
 * WRQ (only `service tftp on` on a device with `files:`) with ACK 0, the file written (created or replaced) when the
 * last block arrives. Refusals (from `tftp#69`): ERROR 0 for a mode other than `octet`, for more than
 * TFTP_SERVER_SESSIONS sessions and for a file over TFTP_MAX_BLOCKS blocks; ERROR 1 for a file it does not serve;
 * ERROR 2 for a WRQ it does not accept. A retransmitted request of a running session is not a new session.
 *
 * Debug category: `tftp` (one line per job and session start and end, refusals and retransmissions).
 *
 * stateSnapshot (kind 'tftp'): { listening, transfers: [{ token, role, op, peer, peerPort?, file, block, bytes, phase }],
 *   results: [{ token, ok, bytes, blocks, error? }] (newest last, at most TFTP_RESULTS_KEPT), served, stored }.
 *
 * ponytail: IPv4 only; `octet` mode only; no `blksize`, `timeout` or `windowsize` option; a server serves `files:`
 * (hosts) or the listed flash files, never `nvram:`.
 */
import { isIpv4, type IpAddress } from '../contracts/addr.js';
import { CLI_MESSAGES } from '../contracts/cli.js';
import type { ConfigNode } from '../contracts/config.js';
import type { ProcessName, SessionId } from '../contracts/ids.js';
import { UDP_PORT_TFTP, type FieldValue } from '../contracts/pdu.js';
import type { Action, DebugEvent, Process, ProcessCtx, ProcessRequest, StateView } from '../contracts/process.js';
import { IMAGE_HEADER_BYTES, IMAGE_TRANSFER_SCALE, type FileSystemId } from '../contracts/storage.js';
import { SEC, type SimTime } from '../contracts/time.js';
import type { ProcessEvent, SocketErrorCode, SocketId, TftpResultEvent } from '../contracts/transport.js';
import { configTextLinesOf } from '../cli/config-text.js';
import { flashUsedBytes, flashWriteProblem } from '../device/device.js';
import { imageHeaderNominalBytes } from '../io/schema.js';
import { TFTP_ERROR, TFTP_MODE_OCTET, TFTP_OPCODE, tftpCodec } from '../pdu/codecs/tftp.js';
import { dormantTransportEligible, transportHoldRequest } from './ip-upper.js';

const NAME: ProcessName = 'tftp';
/** @since P3c [S29] The daemon's name (`PROCESS_ORDER`: after ntp, §2.1; derived from the W4b flip on). */
export const TFTP_DAEMON: ProcessName = NAME;
/** @since P3c [S29] Debug category. */
export const TFTP_DEBUG = 'tftp';
/** @since P3c [S29] The server's listening socket: 0.0.0.0:69. */
export const TFTP_LISTEN_SOCKET: SocketId = 'tftp#69';
/** @since P3c [S29] The DATA block size (RFC 1350; no `blksize` option). */
export const TFTP_BLOCK_BYTES = 512;
/** @since P3c [S29] Retransmission interval of an unacknowledged packet (§3.4, §4.2). */
export const TFTP_RETRANSMIT_NS: SimTime = 2 * SEC;
/** @since P3c [S29] Retransmissions per packet; the next silence ends the transfer (rule 19). */
export const TFTP_RETRIES = 5;
/** @since P3c [S29] Server sessions per device; more requests are answered ERROR 0. */
export const TFTP_SERVER_SESSIONS = 8;
/** @since P3c [S29] The most DATA blocks of one transfer (the block number is a u16). */
export const TFTP_MAX_BLOCKS = 65535;
/** @since P3c [S29] How long a receiver keeps its socket after the final ACK (the sender's whole retry budget). */
export const TFTP_DALLY_NS: SimTime = TFTP_RETRANSMIT_NS * (TFTP_RETRIES + 1);
/** @since P3c [S29] Job outcomes kept in the StateView (newest last). */
export const TFTP_RESULTS_KEPT = 16;
/** @since P3c [S29] The timer of one transfer (§4.2). */
export const tftpTimerKey = (token: string): string => `tftp-rxmt:${token}`;
const TIMER_PREFIX = 'tftp-rxmt:';
const DEBUG_RING = 256;

// ── texts (original wording) ─────────────────────────────────────────────────

/** @since P3c [S29] ERROR packet messages (original wording; the codes are RFC 1350's). */
export const TFTP_ERROR_TEXT = Object.freeze({
  mode: 'only octet mode is served here',
  busy: 'too many transfers in progress, try again later',
  tooLarge: 'the file is too large for TFTP',
  notFound: 'no such file on this server',
  noWrite: 'this server does not accept files',
  badName: 'that file name cannot be stored here',
  diskFull: 'not enough room for the file',
  unknownTid: 'this port is not part of your transfer',
  illegal: 'unexpected packet for this transfer',
});

const fill = (template: string, values: Readonly<Record<string, string | number>>): string =>
  template.replace(/\{(\w+)\}/g, (m, k: string) => (Object.prototype.hasOwnProperty.call(values, k) ? String(values[k]) : m));

/** @since P3c [S29] The CLI's first words of a job (no line end: the `!` marks follow). */
export const tftpStartText = (op: 'get' | 'put', server: IpAddress, remote: string): string =>
  op === 'put' ? `Copying to tftp://${server}/${remote} ` : `Copying from tftp://${server}/${remote} `;
/** @since P3c [S29] The CLI's last line of a job that worked. */
export const tftpDoneText = (bytes: number, blocks: number, ns: SimTime): string =>
  `${bytes} bytes copied in ${blocks} block${blocks === 1 ? '' : 's'}, ${seconds(ns)} s`;
/** @since P3c [S29] A job whose transfer is larger than TFTP can number. */
export const TFTP_TOO_LARGE_TEXT = `% The file is too large for TFTP (at most ${TFTP_MAX_BLOCKS} blocks of ${TFTP_BLOCK_BYTES} bytes).`;
/** @since P3c [S29] A job whose local side is not a file system of this device. */
export const tftpNoFileSystemText = (fs: string): string => `% This device has no ${fs}: file system to copy with.`;
/** @since P3c [S29] A copy into nvram's startup-config (not reachable through the storage action in this build). */
export const TFTP_STARTUP_WRITE_TEXT = '% A copy into startup-config over TFTP is not available on this device.';
/** @since P3c [S29] A server that cannot be reached at all (no route, no address, an ICMP error). */
export const tftpUnreachableText = (server: IpAddress, why: string): string => `% The TFTP server ${server} cannot be reached: ${why}.`;
/** @since P3c [S29] Some lines of a restored configuration were not accepted. */
export const tftpConfigRejectedText = (n: number): string => `% ${n} line${n === 1 ? '' : 's'} of the file ${n === 1 ? 'was' : 'were'} not accepted.`;
/** @since P3c [S29] A local flash write the device refuses (the running image's name). */
export const tftpLocalRefusedText = (problem: string): string => `% The copy cannot be stored: ${problem}.`;
/** @since P3c [S29] A job token already in use. */
export const tftpBusyTokenText = (token: string): string => `% A TFTP job named ${token} is already running.`;
/** @since P3c [S29] A server address that is not IPv4. */
export const tftpIpv4OnlyText = (server: string): string => `% TFTP copies use IPv4 servers; ${server} is not one.`;

/** Seconds with milliseconds, from integer ns. */
function seconds(ns: SimTime): string {
  const ms = Math.max(0, Math.floor(ns / 1_000_000));
  return `${Math.floor(ms / 1000)}.${String(ms % 1000).padStart(3, '0')}`;
}

const UNREACHABLE_WORDS: Readonly<Partial<Record<SocketErrorCode, string>>> = Object.freeze({
  'host-unreachable': 'host unreachable',
  'net-unreachable': 'network unreachable',
  'port-unreachable': 'port unreachable (no TFTP server there)',
  'proto-unreachable': 'protocol unreachable',
  'admin-prohibited': 'administratively prohibited',
  'ttl-exceeded': 'time to live exceeded',
  'no-route': 'no route',
  'no-address': 'no address on this device can reach it',
});

// ── configuration ────────────────────────────────────────────────────────────

/** @since P3c [S29] What the server lines of a running configuration ask for. */
export interface TftpServerConfig {
  /** `service tftp on` (a host's server line): serve, and accept files into, `files:`. */
  readonly service: boolean;
  /** `tftp-server flash:<f>` (or a bare `<f>`), in configuration order, each name once. */
  readonly flash: readonly string[];
}

/** @since P3c [S29] Read `service tftp on|off` (the last line wins) and the global `tftp-server` lines of `root`. */
export function tftpServerConfigOf(root: ConfigNode): TftpServerConfig {
  let service = false;
  const flash: string[] = [];
  for (const l of configTextLinesOf(root)) {
    const t = l.tokens;
    if (l.context.length !== 0) continue;
    if (t[0] === 'service' && t[1] === 'tftp') service = !l.negate && t[2] !== 'off';
    else if (t[0] === 'tftp-server' && !l.negate && t[1] !== undefined) {
      const m = /^(?:([a-z]+):)?(.+)$/.exec(t[1]);
      if (m === null || (m[1] !== undefined && m[1] !== 'flash')) continue;
      const name = m[2] as string;
      if (!flash.includes(name)) flash.push(name);
    }
  }
  return { service, flash };
}

/** Does this device keep the file system `fs` (the device's `hasFileStore` rule, read through the ctx)? */
function hasStore(ctx: ProcessCtx, fs: FileSystemId): boolean {
  if (fs === 'files') return ctx.hasCapability('host');
  return ctx.model.storage !== undefined;
}

const UTF8_ENCODER = new TextEncoder();

/** The blocks a payload of `n` bytes takes (a multiple of 512 ends with an empty block). */
const blocksOf = (n: number): number => Math.floor(n / TFTP_BLOCK_BYTES) + 1;

// ── the daemon ───────────────────────────────────────────────────────────────

type TransferRequest = Extract<ProcessRequest, { kind: 'tftp.transfer' }>;
type Datagram = Extract<ProcessEvent, { kind: 'sock.datagram' }>;
type Fields = Record<string, FieldValue>;

interface Transfer {
  readonly token: string;
  readonly socket: SocketId;
  readonly role: 'client' | 'server';
  /** True when this side sends the DATA blocks. */
  readonly sends: boolean;
  readonly peer: IpAddress;
  /** The peer's transfer id (port); undefined until a client hears the server's first answer. */
  peerPort: number | undefined;
  /** The source address of every packet (a server answers from the address the client asked). */
  readonly src?: IpAddress;
  /** The remote file name. */
  readonly file: string;
  readonly startedAt: SimTime;
  /** Sender: the bytes to send. */
  readonly payload?: Uint8Array;
  /** Receiver: the blocks received, in order. */
  readonly chunks: Uint8Array[];
  received: number;
  /** Sender: the block awaiting its ACK (0 = the WRQ, or the server's OACK). Receiver: the last block received. */
  block: number;
  /** Sender: true once the final block was sent. */
  finalSent: boolean;
  /** The last packet sent and whether the timer retransmits it (requests, OACKs and DATA; never an ACK). */
  last: Fields | undefined;
  lastResend: boolean;
  retries: number;
  phase: 'active' | 'dally';
  /** Client: the job. */
  readonly req?: TransferRequest;
  /** Client get into flash: the size the OACK announced (bytes on the wire). */
  tsize?: number;
  /** Client get into flash: the nominal size of DATA 1's image header, when it carries one. */
  nominal?: number | undefined;
  /** Client: the job holds the dormant transport. */
  held: boolean;
  /** Client: the result was sent (a dallying transfer has one). */
  answered: boolean;
}

/** Create the TFTP daemon ([S29]; silent until a job or a server line). */
export function createTftp(): Process {
  const bySocket = new Map<SocketId, Transfer>();
  const byToken = new Map<string, Transfer>();
  /** configure token → the job waiting for its config.result. */
  const configuring = new Map<string, { readonly req: TransferRequest; readonly bytes: number; readonly blocks: number; readonly startedAt: SimTime }>();
  const results: TftpResultEvent[] = [];
  const ring: DebugEvent[] = [];
  let cfg: TftpServerConfig = { service: false, flash: [] };
  let listening = false;
  let nextSocket = 0;
  let nextSession = 0;
  let served = 0;
  let stored = 0;

  function debug(ctx: ProcessCtx, message: string, data?: Record<string, unknown>): void {
    ctx.debug(TFTP_DEBUG, message, data);
    const ev: DebugEvent = data
      ? { at: ctx.now, device: ctx.deviceId, process: NAME, category: TFTP_DEBUG, message, data }
      : { at: ctx.now, device: ctx.deviceId, process: NAME, category: TFTP_DEBUG, message };
    ring.push(ev);
    if (ring.length > DEBUG_RING) ring.splice(0, ring.length - DEBUG_RING);
  }

  const toUdp = (req: ProcessRequest): Action => ({ type: 'request', to: 'udp', req });

  /** One packet on `socket` to (dst, port). */
  function packet(socket: SocketId, dst: IpAddress, port: number, fields: Fields, src?: IpAddress): Action {
    const req: Extract<ProcessRequest, { kind: 'udp.send' }> = { kind: 'udp.send', socket, dst, dstPort: port, app: [{ proto: 'tftp', fields }] };
    if (src !== undefined) req.src = src;
    return toUdp(req);
  }

  const errorFields = (code: number, msg: string): Fields => ({ opcode: TFTP_OPCODE.error, errorCode: code, errorMsg: msg });

  /** Send `fields` on the transfer and (re)arm its timer; `resend` marks a packet the timer retransmits. */
  function send(t: Transfer, fields: Fields, resend: boolean): Action[] {
    t.last = fields;
    t.lastResend = resend;
    return [
      packet(t.socket, t.peer, t.peerPort ?? UDP_PORT_TFTP, fields, t.src),
      { type: 'timer', key: tftpTimerKey(t.token), delay: TFTP_RETRANSMIT_NS },
    ];
  }

  /** DATA block `n` of a sender. */
  function dataBlock(t: Transfer, n: number): Fields {
    const payload = t.payload as Uint8Array;
    const from = (n - 1) * TFTP_BLOCK_BYTES;
    const data = payload.slice(from, Math.min(payload.length, from + TFTP_BLOCK_BYTES));
    if (data.length < TFTP_BLOCK_BYTES) t.finalSent = true;
    return { opcode: TFTP_OPCODE.data, block: n, data };
  }

  /** Forget the transfer: cancel its timer, close its socket, release the transport hold. */
  function close(t: Transfer): Action[] {
    if (bySocket.get(t.socket) !== t) return [];
    bySocket.delete(t.socket);
    if (byToken.get(t.token) === t) byToken.delete(t.token);
    const out: Action[] = [{ type: 'cancelTimer', key: tftpTimerKey(t.token) }, toUdp({ kind: 'udp.close', socket: t.socket })];
    if (t.held) {
      t.held = false;
      out.push({ type: 'request', to: 'ipv4', req: transportHoldRequest(NAME, t.token, false) });
    }
    return out;
  }

  /** The receiver's dally after the final ACK (one timer, then close). */
  function dally(t: Transfer): Action[] {
    t.phase = 'dally';
    return [{ type: 'timer', key: tftpTimerKey(t.token), delay: TFTP_DALLY_NS }];
  }

  /** The job's end: the result to its owner (or the CLI text and `cliDone`), kept in the StateView. */
  function answer(ctx: ProcessCtx, req: TransferRequest, startedAt: SimTime, ok: boolean, bytes: number, blocks: number, error?: string, note?: string): Action[] {
    const ev: TftpResultEvent = { kind: 'tftp.result', token: req.token, ok, bytes, blocks };
    if (error !== undefined) ev.error = error;
    results.push(ev);
    if (results.length > TFTP_RESULTS_KEPT) results.splice(0, results.length - TFTP_RESULTS_KEPT);
    debug(ctx, `job ${req.token} ${ok ? 'done' : 'failed'}: ${bytes} bytes in ${blocks} blocks${error !== undefined ? ` (${error})` : ''}`, { token: req.token, ok, bytes, blocks });
    if (req.owner !== 'cli') return [{ type: 'event', to: req.owner, ev }];
    const session: SessionId | undefined = req.session;
    if (session === undefined) return [];
    const lines: string[] = [ok ? tftpDoneText(bytes, blocks, ctx.now - startedAt) : (error ?? '')];
    if (note !== undefined) lines.push(note);
    return [
      { type: 'cliOutput', session, text: `\n${lines.join('\n')}\n` },
      { type: 'cliDone', session },
    ];
  }

  /** A client transfer ends (the result once; the socket closes unless it dallies). */
  function finishClient(ctx: ProcessCtx, t: Transfer, ok: boolean, error?: string): Action[] {
    const out: Action[] = [];
    if (!t.answered && t.req !== undefined) {
      t.answered = true;
      const total = t.payload?.length ?? 0;
      // a sender counts what was acknowledged: every block on success, the blocks before the one in flight otherwise
      const acked = ok ? t.block : Math.max(0, t.block - 1);
      const bytes = t.sends ? (ok ? total : Math.min(total, acked * TFTP_BLOCK_BYTES)) : t.received;
      const blocks = t.sends ? acked : t.block;
      out.push(...answer(ctx, t.req, t.startedAt, ok, bytes, blocks, error));
    }
    if (t.phase !== 'dally') out.push(...close(t));
    return out;
  }

  /** A job refused before any packet. */
  function refuse(ctx: ProcessCtx, req: TransferRequest, error: string): Action[] {
    return answer(ctx, req, ctx.now, false, 0, 0, error);
  }

  /** Flash room for `bytes` at `path`: undefined, or the CLI message and the ERROR code to send. */
  function flashProblem(ctx: ProcessCtx, path: string, bytes: number): { message: string; code: number } | undefined {
    const storage = ctx.model.storage;
    if (storage === undefined) return undefined;
    const files = ctx.files('flash');
    const problem = flashWriteProblem(storage, files, path, bytes);
    if (problem === undefined) return undefined;
    if (path === storage.image.file) return { message: tftpLocalRefusedText(problem), code: TFTP_ERROR.accessViolation };
    const free = Math.max(0, storage.flashBytes - flashUsedBytes(storage, files.filter((f) => f.path !== path)));
    return { message: fill(CLI_MESSAGES.flashFull, { needed: bytes, free }), code: TFTP_ERROR.diskFull };
  }

  // ── the client ──

  function start(ctx: ProcessCtx, req: TransferRequest): Action[] {
    if (byToken.has(req.token) || configuring.has(`tftp:${req.token}`)) return refuse(ctx, req, tftpBusyTokenText(req.token));
    if (!isIpv4(req.server)) return refuse(ctx, req, tftpIpv4OnlyText(req.server));
    const local = req.local;
    let payload: Uint8Array | undefined;
    if ('fs' in local) {
      if (!hasStore(ctx, local.fs)) return refuse(ctx, req, tftpNoFileSystemText(local.fs));
      if (req.op === 'put') {
        const f = ctx.readFile(local.fs, local.path);
        if (f === undefined) return refuse(ctx, req, fill(CLI_MESSAGES.fileNotFound, { file: `${local.fs}:${local.path}` }));
        payload = UTF8_ENCODER.encode(f.content);
      } else if (local.fs === 'nvram') {
        return refuse(ctx, req, TFTP_STARTUP_WRITE_TEXT);
      }
    } else if (req.op === 'put') {
      if (local.config === 'running') payload = UTF8_ENCODER.encode(ctx.config.render());
      else {
        const f = hasStore(ctx, 'nvram') ? ctx.readFile('nvram', 'startup-config') : undefined;
        if (f === undefined) return refuse(ctx, req, fill(CLI_MESSAGES.fileNotFound, { file: 'nvram:startup-config' }));
        payload = UTF8_ENCODER.encode(f.content);
      }
    } else if (local.config === 'startup') {
      return refuse(ctx, req, TFTP_STARTUP_WRITE_TEXT);
    }
    if (payload !== undefined && blocksOf(payload.length) > TFTP_MAX_BLOCKS) return refuse(ctx, req, TFTP_TOO_LARGE_TEXT);

    nextSocket++;
    const socket = `${NAME}#${nextSocket}`;
    const t: Transfer = {
      token: req.token,
      socket,
      role: 'client',
      sends: req.op === 'put',
      peer: req.server,
      peerPort: undefined,
      file: req.remote,
      startedAt: ctx.now,
      ...(payload !== undefined ? { payload } : {}),
      chunks: [],
      received: 0,
      block: 0,
      finalSent: false,
      last: undefined,
      lastResend: true,
      retries: 0,
      phase: 'active',
      req,
      held: false,
      answered: false,
    };
    bySocket.set(socket, t);
    byToken.set(req.token, t);
    const out: Action[] = [];
    // D22: a job on a managed switch wakes its dormant transport for its own life (the vty-client precedent, R17/R27)
    if (dormantTransportEligible(ctx.model, 'udp')) {
      t.held = true;
      out.push({ type: 'request', to: 'ipv4', req: transportHoldRequest(NAME, req.token, true) });
    }
    out.push(toUdp({ kind: 'udp.open', owner: NAME, socket, family: 4 }));
    const asksTsize = req.op === 'get' && ((('fs' in local) && local.fs === 'flash') || req.image === true);
    const request: Fields = { opcode: req.op === 'put' ? TFTP_OPCODE.wrq : TFTP_OPCODE.rrq, filename: req.remote, mode: TFTP_MODE_OCTET };
    if (asksTsize) request.tsize = 0;
    debug(ctx, `job ${req.token}: ${req.op === 'put' ? 'write' : 'read'} ${req.remote} ${req.op === 'put' ? 'to' : 'from'} ${req.server} from ${socket}`, { token: req.token, socket });
    if (req.owner === 'cli' && req.session !== undefined) out.push({ type: 'cliOutput', session: req.session, text: tftpStartText(req.op, req.server, req.remote) });
    out.push(...send(t, request, true));
    return out;
  }

  /** A `!` for the CLI per block moved. */
  function mark(t: Transfer): Action[] {
    const req = t.req;
    if (req === undefined || req.owner !== 'cli' || req.session === undefined) return [];
    return [{ type: 'cliOutput', session: req.session, text: '!' }];
  }

  /** The local flash path of a client get into flash, else undefined. */
  function flashTarget(t: Transfer): string | undefined {
    const local = t.req?.local;
    return local !== undefined && 'fs' in local && local.fs === 'flash' ? local.path : undefined;
  }

  /** A client get: the whole file arrived (the final ACK is sent; the socket dallies). */
  function clientComplete(ctx: ProcessCtx, t: Transfer): Action[] {
    const req = t.req as TransferRequest;
    const content = new TextDecoder('utf-8', { fatal: false }).decode(concat(t.chunks, t.received));
    const local = req.local;
    if ('fs' in local) {
      if (local.fs === 'flash') {
        const p = flashProblem(ctx, local.path, imageHeaderNominalBytes(content) ?? t.received);
        if (p !== undefined) return finishClient(ctx, t, false, p.message);
      }
      stored++;
      return [{ type: 'storage', op: 'write', fs: local.fs, path: local.path, file: { content } }, ...finishClient(ctx, t, true)];
    }
    // `running`: a merge through the configure seam (D10, M-6); the job ends at its config.result
    t.answered = true;
    const lines = content.split(/\r?\n/).filter((l) => l.trim() !== '' && !l.trimStart().startsWith('!') && l.trim() !== 'end');
    const token = `tftp:${req.token}`;
    configuring.set(token, { req, bytes: t.received, blocks: t.block, startedAt: t.startedAt });
    return [{ type: 'configure', token, lines, indentation: true, origin: { via: 'tftp', address: req.server } }];
  }

  // ── the server ──

  function sync(ctx: ProcessCtx): Action[] {
    cfg = tftpServerConfigOf(ctx.config.root);
    const want = cfg.service || cfg.flash.length > 0;
    if (want === listening) return [];
    listening = want;
    if (want) {
      debug(ctx, `serving TFTP on UDP ${UDP_PORT_TFTP}`, { socket: TFTP_LISTEN_SOCKET });
      return [toUdp({ kind: 'udp.open', owner: NAME, socket: TFTP_LISTEN_SOCKET, family: 4, localAddr: '0.0.0.0', localPort: UDP_PORT_TFTP })];
    }
    debug(ctx, 'stopped serving TFTP', { socket: TFTP_LISTEN_SOCKET });
    return [toUdp({ kind: 'udp.close', socket: TFTP_LISTEN_SOCKET })];
  }

  /** A refusal from the listening socket. */
  function refuseRequest(ctx: ProcessCtx, ev: Datagram, code: number, msg: string): Action[] {
    debug(ctx, `refused a request from ${ev.from}:${ev.fromPort}: ${msg}`, { from: ev.from, code });
    return [packet(TFTP_LISTEN_SOCKET, ev.from, ev.fromPort, errorFields(code, msg), ownTarget(ctx, ev.to))];
  }

  /** The content a read request names, or undefined. */
  function servedContent(ctx: ProcessCtx, name: string): string | undefined {
    if (cfg.service && hasStore(ctx, 'files')) {
      const f = ctx.readFile('files', name);
      if (f !== undefined) return f.content;
    }
    if (cfg.flash.includes(name) && hasStore(ctx, 'flash')) return ctx.readFile('flash', name)?.content;
    return undefined;
  }

  function serverRequest(ctx: ProcessCtx, ev: Datagram, f: Readonly<Record<string, FieldValue>>): Action[] {
    // a retransmitted request of a running session: its own timer answers; a receiver re-sends its ACK 0
    for (const t of bySocket.values()) {
      if (t.role !== 'server' || t.peer !== ev.from || t.peerPort !== ev.fromPort) continue;
      if (!t.lastResend && t.last !== undefined && t.phase === 'active') return [packet(t.socket, t.peer, ev.fromPort, t.last, t.src)];
      return [];
    }
    const name = typeof f.filename === 'string' ? f.filename : '';
    if (typeof f.mode !== 'string' || f.mode.toLowerCase() !== TFTP_MODE_OCTET) return refuseRequest(ctx, ev, TFTP_ERROR.undefined, TFTP_ERROR_TEXT.mode);
    let sessions = 0;
    for (const t of bySocket.values()) if (t.role === 'server') sessions++;
    if (sessions >= TFTP_SERVER_SESSIONS) return refuseRequest(ctx, ev, TFTP_ERROR.undefined, TFTP_ERROR_TEXT.busy);
    const rrq = f.opcode === TFTP_OPCODE.rrq;
    let payload: Uint8Array | undefined;
    if (rrq) {
      const content = servedContent(ctx, name);
      if (content === undefined) return refuseRequest(ctx, ev, TFTP_ERROR.fileNotFound, TFTP_ERROR_TEXT.notFound);
      payload = UTF8_ENCODER.encode(content);
      if (blocksOf(payload.length) > TFTP_MAX_BLOCKS) return refuseRequest(ctx, ev, TFTP_ERROR.undefined, TFTP_ERROR_TEXT.tooLarge);
    } else {
      if (!cfg.service || !hasStore(ctx, 'files')) return refuseRequest(ctx, ev, TFTP_ERROR.accessViolation, TFTP_ERROR_TEXT.noWrite);
      if (name === '' || /[/\\:\s]/.test(name)) return refuseRequest(ctx, ev, TFTP_ERROR.accessViolation, TFTP_ERROR_TEXT.badName);
    }
    nextSocket++;
    nextSession++;
    const socket = `${NAME}#${nextSocket}`;
    const src = ownTarget(ctx, ev.to);
    const t: Transfer = {
      token: `srv-${nextSession}`,
      socket,
      role: 'server',
      sends: rrq,
      peer: ev.from,
      peerPort: ev.fromPort,
      ...(src !== undefined ? { src } : {}),
      file: name,
      startedAt: ctx.now,
      ...(payload !== undefined ? { payload } : {}),
      chunks: [],
      received: 0,
      block: 0,
      finalSent: false,
      last: undefined,
      lastResend: true,
      retries: 0,
      phase: 'active',
      held: false,
      answered: true,
    };
    bySocket.set(socket, t);
    byToken.set(t.token, t);
    debug(ctx, `session ${t.token}: ${rrq ? 'read' : 'write'} ${name} for ${ev.from}:${ev.fromPort} from ${socket}`, { token: t.token, socket, from: ev.from });
    const out: Action[] = [toUdp({ kind: 'udp.open', owner: NAME, socket, family: 4 })];
    if (!rrq) out.push(...send(t, { opcode: TFTP_OPCODE.ack, block: 0 }, false));
    else if (f.tsize !== undefined) out.push(...send(t, { opcode: TFTP_OPCODE.oack, tsize: (payload as Uint8Array).length }, true));
    else {
      t.block = 1;
      out.push(...send(t, dataBlock(t, 1), true));
    }
    return out;
  }

  // ── both sides ──

  /** An ERROR or a refusal ends the transfer. */
  function abort(ctx: ProcessCtx, t: Transfer, error: string): Action[] {
    if (t.role === 'client') return finishClient(ctx, t, false, error);
    debug(ctx, `session ${t.token} ended: ${error}`, { token: t.token });
    return close(t);
  }

  function onTransferPacket(ctx: ProcessCtx, t: Transfer, ev: Datagram, f: Readonly<Record<string, FieldValue>>): Action[] {
    const op = f.opcode;
    if (op === TFTP_OPCODE.error) {
      const msg = typeof f.errorMsg === 'string' && f.errorMsg !== '' ? f.errorMsg : `error ${String(f.errorCode ?? '?')}`;
      if (t.phase === 'dally') return close(t);
      return abort(ctx, t, fill(CLI_MESSAGES.tftpRefused, { server: t.peer, reason: msg }));
    }
    if (t.sends) {
      // the sender: an ACK of the block in flight moves on; any other ACK is a duplicate and ignored
      if (op !== TFTP_OPCODE.ack || f.block !== t.block) return [];
      t.retries = 0;
      if (t.role === 'server' && t.block > 0 && t.finalSent) {
        served++;
        debug(ctx, `session ${t.token}: sent ${t.file} (${t.payload?.length ?? 0} bytes)`, { token: t.token });
        return close(t);
      }
      if (t.role === 'client' && t.finalSent) return [...mark(t), ...finishClient(ctx, t, true)];
      const out = t.role === 'client' && t.block > 0 ? mark(t) : [];
      t.block++;
      return [...out, ...send(t, dataBlock(t, t.block), true)];
    }
    // the receiver
    if (op === TFTP_OPCODE.oack && t.role === 'client' && t.block === 0) {
      if (t.last !== undefined && t.last.opcode === TFTP_OPCODE.ack) return send(t, t.last, false); // a duplicate OACK
      t.retries = 0;
      const tsize = typeof f.tsize === 'number' ? f.tsize : undefined;
      const path = flashTarget(t);
      if (tsize !== undefined) {
        t.tsize = tsize;
        if (blocksOf(tsize) > TFTP_MAX_BLOCKS) return [packet(t.socket, t.peer, t.peerPort as number, errorFields(TFTP_ERROR.undefined, TFTP_ERROR_TEXT.tooLarge)), ...finishClient(ctx, t, false, TFTP_TOO_LARGE_TEXT)];
        if (path !== undefined) {
          const needed = path.endsWith('.bin') ? tsize * IMAGE_TRANSFER_SCALE : tsize;
          const p = flashProblem(ctx, path, needed);
          if (p !== undefined) {
            debug(ctx, `job ${t.token}: ${t.file} (${tsize} bytes) does not fit in flash`, { token: t.token, tsize, needed });
            return [packet(t.socket, t.peer, t.peerPort as number, errorFields(p.code, TFTP_ERROR_TEXT.diskFull)), ...finishClient(ctx, t, false, p.message)];
          }
        }
      }
      return send(t, { opcode: TFTP_OPCODE.ack, block: 0 }, false);
    }
    if (op !== TFTP_OPCODE.data || typeof f.block !== 'number') {
      if (op === TFTP_OPCODE.oack) return [];
      return [packet(t.socket, ev.from, ev.fromPort, errorFields(TFTP_ERROR.illegalOperation, TFTP_ERROR_TEXT.illegal), t.src)];
    }
    const data = f.data instanceof Uint8Array ? f.data : new Uint8Array(0);
    if (f.block === t.block && t.block > 0) return [packet(t.socket, t.peer, t.peerPort as number, { opcode: TFTP_OPCODE.ack, block: t.block }, t.src)]; // a duplicate
    if (t.phase === 'dally' || f.block !== t.block + 1) return [];
    t.retries = 0;
    // a client get into flash: checked as blocks arrive (a server that ignored tsize; the header's nominal size)
    const path = t.role === 'client' ? flashTarget(t) : undefined;
    if (path !== undefined) {
      // the image header (16 bytes) arrives with DATA 1
      if (t.received === 0) t.nominal = imageHeaderNominalBytes(latin1(data.subarray(0, IMAGE_HEADER_BYTES)));
      const p = flashProblem(ctx, path, t.nominal ?? t.received + data.length);
      if (p !== undefined) {
        debug(ctx, `job ${t.token}: block ${f.block} would overflow flash`, { token: t.token, block: f.block });
        return [packet(t.socket, t.peer, t.peerPort as number, errorFields(p.code, TFTP_ERROR_TEXT.diskFull)), ...finishClient(ctx, t, false, p.message)];
      }
    }
    t.chunks.push(data);
    t.received += data.length;
    t.block = f.block;
    const out: Action[] = [...mark(t), ...send(t, { opcode: TFTP_OPCODE.ack, block: t.block }, false)];
    if (data.length >= TFTP_BLOCK_BYTES) return out;
    out.push(...dally(t));
    if (t.role === 'client') return [...out, ...clientComplete(ctx, t)];
    // the server: write the file (create or replace)
    const content = new TextDecoder('utf-8', { fatal: false }).decode(concat(t.chunks, t.received));
    stored++;
    debug(ctx, `session ${t.token}: stored ${t.file} (${t.received} bytes)`, { token: t.token });
    return [...out, { type: 'storage', op: 'write', fs: 'files', path: t.file, file: { content } }];
  }

  function onDatagram(ctx: ProcessCtx, ev: Datagram): Action[] {
    const layer = tftpCodec.decode(ev.data, 0, ev.data.length);
    const f = layer.fields;
    if (ev.socket === TFTP_LISTEN_SOCKET) {
      if (!listening || layer.error !== undefined || (f.opcode !== TFTP_OPCODE.rrq && f.opcode !== TFTP_OPCODE.wrq)) {
        debug(ctx, `ignored a packet on port ${UDP_PORT_TFTP} from ${ev.from}:${ev.fromPort}${layer.error !== undefined ? ` (${layer.error})` : ''}`, { from: ev.from });
        return [];
      }
      return serverRequest(ctx, ev, f);
    }
    const t = bySocket.get(ev.socket);
    if (t === undefined) return [];
    if (t.peerPort === undefined) {
      if (ev.from !== t.peer) return [packet(t.socket, ev.from, ev.fromPort, errorFields(TFTP_ERROR.unknownTransferId, TFTP_ERROR_TEXT.unknownTid))];
      t.peerPort = ev.fromPort; // the server's transfer id: both sides lock to it
    } else if (ev.from !== t.peer || ev.fromPort !== t.peerPort) {
      debug(ctx, `${t.token}: a packet from ${ev.from}:${ev.fromPort} is not part of the transfer`, { token: t.token, from: ev.from, port: ev.fromPort });
      return [packet(t.socket, ev.from, ev.fromPort, errorFields(TFTP_ERROR.unknownTransferId, TFTP_ERROR_TEXT.unknownTid), t.src)];
    }
    if (layer.error !== undefined) {
      debug(ctx, `${t.token}: malformed packet ignored (${layer.error})`, { token: t.token });
      return [];
    }
    return onTransferPacket(ctx, t, ev, f);
  }

  function onTimerFired(ctx: ProcessCtx, token: string): Action[] {
    const t = byToken.get(token);
    if (t === undefined) return [];
    if (t.phase === 'dally') return close(t);
    t.retries++;
    if (t.retries > TFTP_RETRIES) {
      debug(ctx, `${t.token}: no answer after ${TFTP_RETRIES} retransmissions`, { token: t.token });
      return abort(ctx, t, fill(CLI_MESSAGES.tftpTimeout, { server: t.peer }));
    }
    if (!t.lastResend || t.last === undefined) return [{ type: 'timer', key: tftpTimerKey(t.token), delay: TFTP_RETRANSMIT_NS }];
    debug(ctx, `${t.token}: retransmission ${t.retries} of ${describe(t.last)}`, { token: t.token, retry: t.retries });
    return send(t, t.last, true);
  }

  function onSocketError(ctx: ProcessCtx, ev: Extract<ProcessEvent, { kind: 'sock.error' }>): Action[] {
    if (ev.socket === TFTP_LISTEN_SOCKET) {
      debug(ctx, `socket error ${ev.code}${ev.detail !== undefined ? ` (${ev.detail})` : ''}`, { code: ev.code });
      if (ev.code === 'addr-in-use') listening = false;
      return [];
    }
    const t = bySocket.get(ev.socket);
    if (t === undefined) return [];
    if (t.phase === 'dally') return close(t);
    return abort(ctx, t, tftpUnreachableText(t.peer, UNREACHABLE_WORDS[ev.code] ?? ev.code));
  }

  function onConfigResult(ctx: ProcessCtx, ev: Extract<ProcessEvent, { kind: 'config.result' }>): Action[] {
    const job = configuring.get(ev.token);
    if (job === undefined) return [];
    configuring.delete(ev.token);
    const rejected = ev.result.lines.filter((l) => !l.ok).length;
    return answer(ctx, job.req, job.startedAt, true, job.bytes, job.blocks, undefined, rejected > 0 ? tftpConfigRejectedText(rejected) : undefined);
  }

  return {
    name: NAME,

    init(ctx): Action[] {
      return sync(ctx);
    },

    onPdu(_ctx, pdu, port): Action[] {
      return [{ type: 'drop', pdu, reason: 'unsupported-protocol', detail: 'tftp takes datagrams from its udp sockets', port }];
    },

    onConfig(ctx, delta): Action[] {
      if (delta.context.length !== 0) return [];
      const w = delta.line[0];
      return w === 'tftp-server' || (w === 'service' && delta.line[1] === 'tftp') ? sync(ctx) : [];
    },

    onTimer(ctx, key): Action[] {
      return key.startsWith(TIMER_PREFIX) ? onTimerFired(ctx, key.slice(TIMER_PREFIX.length)) : [];
    },

    onRequest(ctx, req): Action[] {
      return req.kind === 'tftp.transfer' ? start(ctx, req) : [];
    },

    onEvent(ctx, ev: ProcessEvent): Action[] {
      switch (ev.kind) {
        case 'sock.datagram':
          return onDatagram(ctx, ev);
        case 'sock.error':
          return onSocketError(ctx, ev);
        case 'config.result':
          return onConfigResult(ctx, ev);
        default:
          return [];
      }
    },

    stateSnapshot(): StateView {
      const transfers = [...bySocket.values()].map((t) => {
        const row: Record<string, unknown> = { token: t.token, role: t.role, op: t.sends === (t.role === 'client') ? 'put' : 'get', peer: t.peer };
        if (t.peerPort !== undefined) row.peerPort = t.peerPort;
        row.file = t.file;
        row.block = t.block;
        row.bytes = t.sends ? Math.min(t.payload?.length ?? 0, t.block * TFTP_BLOCK_BYTES) : t.received;
        row.phase = t.phase;
        return row;
      });
      return { process: NAME, state: { listening, transfers, results: results.map((r) => ({ ...r })), served, stored } };
    },

    debugEvents(): readonly DebugEvent[] {
      return ring;
    },
  };
}

/** The address a request was sent to, when it is one of this device's own (a reply leaves from it). */
function ownTarget(ctx: ProcessCtx, to: IpAddress): IpAddress | undefined {
  return isIpv4(to) && ctx.ownAddress(to) !== undefined ? to : undefined;
}

/** The blocks received, as one byte array. */
function concat(chunks: readonly Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

/** Bytes as Latin-1 text (the image header is ASCII). */
function latin1(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return s;
}

/** A packet's words for the debug line. */
function describe(f: Readonly<Record<string, FieldValue>>): string {
  switch (f.opcode) {
    case TFTP_OPCODE.rrq:
      return 'the read request';
    case TFTP_OPCODE.wrq:
      return 'the write request';
    case TFTP_OPCODE.oack:
      return 'the option acknowledgement';
    case TFTP_OPCODE.data:
      return `data block ${String(f.block)}`;
    default:
      return 'the last packet';
  }
}
