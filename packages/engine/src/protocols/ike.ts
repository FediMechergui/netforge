/**
 * protocols/ike.ts — the IKEv2-lite daemon [C13] (ARCHITECTURE-P3 D27, §2.17, §3.13, §4.1–§4.3, §4.5; §7 W3 wan).
 *
 * One `IkeTunnel` (the W1 pure exchange, `protocols/ike/exchange.ts`) per protected tunnel port, driven over UDP port
 * 500 with the W1 `ikev2` codec. The tunnel owner (`gre`, in ipsec mode) is the only caller:
 *   - `ike.connect {port, local, peer, profile}` (the tunnel's underlay became ready, or its addresses or protection
 *     profile changed): open `ike#500` if it is not open, write `ipsec-sa[port] {state 'negotiating', role
 *     'initiator'}` and arm `ike-kick:<port>` (0 ns, coalesced). A connect for a port already connected with other
 *     values replaces that tunnel (its exchange is abandoned);
 *   - `ike.disconnect {port}` (the underlay went, the mode left ipsec, the protection line or the tunnel was removed):
 *     cancel the tunnel's timers, delete its row, close `ike#500` with the last tunnel. No `tunnel.sa` is sent back
 *     (the tunnel owner dropped the SA itself).
 * and the only callee: every SA change is a `tunnel.sa` request to `gre` — `{op: 'up', spiIn, spiOut, keyId}` when an
 * exchange completes, `{op: 'down', reason}` when it fails or an established SA is replaced by the peer's new exchange.
 *
 * The exchange (§3.13 steps 2–5, 10): at `ike-kick` (and at the periodic `ike-retry` of a failed tunnel) the key is
 * looked up (`protocols/ike/config.ts`: IPsec profile → IKEv2 profile → keyring peer of the tunnel destination) and
 * `ikeStart` runs; while the IPsec profile does not exist the tunnel waits, sends nothing and stays negotiating, and a
 * configuration change that creates it kicks the tunnel again. A received IKEv2 message is matched to the tunnel whose
 * source and destination are its destination and source (no match: a `crypto ikev2` debug line, discarded) and fed
 * to `ikeReceive`; `ike-rexmt:<port>` feeds `ikeTimeout`. Each step's message is built with `ctx.newPdu` — `[ipv4
 * {local → peer, protocol 17}, udp {500 → 500}, ikev2]`, IKE_AUTH messages marked `meta.protected` with `protectedBy:
 * 'ike'` (which `udp.send` cannot set; the CAPWAP precedent) — and handed to ipv4 with `ipv4.send`.
 *
 * Timers (§4.2): `ike-kick:<port>` (0 ns, non-periodic), `ike-rexmt:<port>` (1, 2, 4 s, then the 8 s final wait:
 * non-periodic), `ike-retry:<port>` (10 s, PERIODIC: armed whenever the tunnel is failed, so a wrong key or a silent
 * peer never holds `runToIdle`). No randomness: SPIs, nonces, KE values and ESP SPIs are FNV-derived from (device,
 * port, the per-process counter) (§4.1).
 *
 * The `ipsec-sa` row (key = the tunnel port; writer ike) is rewritten only when a displayed value changes (rule 20):
 * state, role and reason while negotiating or failed; the IKE and ESP SPIs and the proposal once established. The
 * pre-shared key is never in a row, a view, a debug line or a PDU byte (D27).
 *
 * Silence (§4.3): nothing is opened, written or sent before the first `ike.connect`. A severity-4 log on both ends
 * reports an authentication failure (`AUTHENTICATION_FAILED`). Debug category `crypto ikev2` (§5.8): each message
 * sent and received, the crossing rule, proofs accepted or refused, SA up and down; FSM machine `ike` (subject: the
 * tunnel port).
 *
 * stateSnapshot(): `IkeStateView` — `{ exchanges: [{ port, messageId, retriesLeft, nextAt? }] }` for every tunnel with
 * a request waiting for its response, in canonical port order.
 */
import type { Ipv4Address } from '../contracts/addr.js';
import type { ConfigDelta } from '../contracts/config.js';
import type { PduId, PortId } from '../contracts/ids.js';
import { IPPROTO_UDP, UDP_PORT_IKE, type FieldValue, type LayerSpec, type PduMeta } from '../contracts/pdu.js';
import type { Action, DebugEvent, FsmTransition, Process, ProcessCtx, ProcessRequest, StateView } from '../contracts/process.js';
import type { IkeStateView, IpsecSaRow, Table } from '../contracts/tables.js';
import type { SimTime } from '../contracts/time.js';
import type { ProcessEvent } from '../contracts/transport.js';
import { flowKey } from '../core/addr6.js';
import { ikeKeyFor, readIkeConfig, type IkeKeyLookup } from './ike/config.js';
import {
  IKE_AUTH,
  IKE_IDLE,
  IKE_PROPOSAL_LABEL,
  IKE_REXMT_DELAYS_NS,
  IKE_RETRY_NS,
  IKE_SA_INIT,
  IKE_SPI_ZERO,
  ikeIsResponse,
  ikeReceive,
  ikeStart,
  ikeStop,
  ikeTimeout,
  ipsecSaStateOf,
  type IkeEnv,
  type IkeMessage,
  type IkeStep,
  type IkeTunnel,
} from './ike/exchange.js';

const NAME = 'ike';
const DEBUG_RING = 256;

/** Debug category of the daemon (§5.8; `debug crypto ikev2`). */
export const IKE_DEBUG = 'crypto ikev2';
/** Facility of the authentication-failure log (original wording). */
export const IKE_LOG_FACILITY = 'IKE';
/** Severity of the authentication-failure log (§3.13 step 10). */
export const IKE_AUTH_FAILURE_SEVERITY = 4;
/** The daemon's one UDP socket (port 500 on every address, opened with the first tunnel). */
export const IKE_SOCKET = 'ike#500';
/** Timer keys (§4.2). */
export const IKE_KICK_PREFIX = 'ike-kick:';
export const IKE_REXMT_PREFIX = 'ike-rexmt:';
export const IKE_RETRY_PREFIX = 'ike-retry:';

/** The PDU tag of an IKEv2 message (`ike-init` for IKE_SA_INIT, `ike-auth` for IKE_AUTH). */
export function ikeTagOf(exchange: number): string {
  return exchange === IKE_AUTH ? 'ike-auth' : 'ike-init';
}

/** The authentication-failure log text (original wording). */
export function ikeAuthFailureMessage(port: PortId, peer: Ipv4Address): string {
  return `${port}: IKEv2 authentication with ${peer} failed; the pre-shared keys of the two ends differ, so the tunnel stays down`;
}

/** One message in words, for debug lines: 'IKE_SA_INIT request (message 0)', 'IKE_AUTH response (message 1, AUTHENTICATION_FAILED)'. */
export function ikeDescribe(msg: IkeMessage): string {
  const ex = msg.exchange === IKE_SA_INIT ? 'IKE_SA_INIT' : msg.exchange === IKE_AUTH ? 'IKE_AUTH' : `exchange ${msg.exchange}`;
  const notify = msg.notify !== undefined ? `, ${msg.notify}` : '';
  return `${ex} ${ikeIsResponse(msg) ? 'response' : 'request'} (message ${msg.messageId}${notify})`;
}

/** The fields of an `ikev2` layer carrying `msg` (the codec derives nextPayload, version and length). */
export function ikeMessageFields(msg: IkeMessage): Record<string, FieldValue> {
  const f: Record<string, FieldValue> = { spiI: msg.spiI, spiR: msg.spiR, exchange: msg.exchange, flags: msg.flags, messageId: msg.messageId };
  for (const k of ['notify', 'idi', 'idr', 'auth', 'sa', 'ke', 'nonce', 'tsi', 'tsr'] as const) {
    const v = msg[k];
    if (v !== undefined) f[k] = v;
  }
  return f;
}

/** The message an `ikev2` layer's decoded fields carry. */
export function ikeMessageOf(f: Readonly<Record<string, FieldValue>>): IkeMessage {
  const str = (k: string): string | undefined => (typeof f[k] === 'string' ? (f[k] as string) : undefined);
  const num = (k: string): number => (typeof f[k] === 'number' ? (f[k] as number) : -1);
  const out: { -readonly [K in keyof IkeMessage]: IkeMessage[K] } = {
    spiI: str('spiI') ?? '',
    spiR: str('spiR') ?? IKE_SPI_ZERO,
    exchange: num('exchange'),
    flags: num('flags') < 0 ? 0 : num('flags'),
    messageId: num('messageId'),
  };
  for (const k of ['notify', 'idi', 'idr', 'auth', 'sa', 'ke', 'nonce', 'tsi', 'tsr'] as const) {
    const v = str(k);
    if (v !== undefined) out[k] = v;
  }
  return out;
}

/** One protected tunnel. */
interface Tun {
  readonly port: PortId;
  readonly local: Ipv4Address;
  readonly peer: Ipv4Address;
  readonly profile: string;
  t: IkeTunnel;
  /** The IPsec profile did not exist at the last start: nothing sent until a configuration change creates it. */
  waiting: boolean;
  /** `ike-rexmt` is armed until this time. */
  rexmtAt?: SimTime;
  /** `ike-retry` is armed (periodic). */
  retryArmed: boolean;
  /** The last row written: its displayed values (fingerprint), its state and since. */
  rowFp?: string;
  rowState?: IpsecSaRow['state'];
  since: SimTime;
}

export function createIke(): Process {
  const tunnels = new Map<PortId, Tun>();
  /** The per-process counter of the derived values (§4.1). */
  let counter = 0;
  let socketOpen = false;
  /** The canonical port order last seen (the StateView, which has no ctx, lists exchanges in it). */
  let portOrder = new Map<PortId, number>();
  const ring: DebugEvent[] = [];

  const kickKey = (port: PortId): string => `${IKE_KICK_PREFIX}${port}`;
  const rexmtKey = (port: PortId): string => `${IKE_REXMT_PREFIX}${port}`;
  const retryKey = (port: PortId): string => `${IKE_RETRY_PREFIX}${port}`;
  const table = (ctx: ProcessCtx): Table<IpsecSaRow> | undefined => ctx.tables.get<IpsecSaRow>('ipsec-sa');

  function pushRing(ev: DebugEvent): void {
    ring.push(ev);
    if (ring.length > DEBUG_RING) ring.splice(0, ring.length - DEBUG_RING);
  }

  function debug(ctx: ProcessCtx, message: string, data?: Record<string, unknown>): void {
    ctx.debug(IKE_DEBUG, message, data);
    pushRing(data ? { at: ctx.now, device: ctx.deviceId, process: NAME, category: IKE_DEBUG, message, data } : { at: ctx.now, device: ctx.deviceId, process: NAME, category: IKE_DEBUG, message });
  }

  function lookup(ctx: ProcessCtx, tun: Tun): IkeKeyLookup {
    return ikeKeyFor(readIkeConfig(ctx.config.root), tun.profile, tun.peer);
  }

  function envOf(ctx: ProcessCtx, tun: Tun, look: IkeKeyLookup = lookup(ctx, tun)): IkeEnv {
    const env: IkeEnv = { device: ctx.deviceId, port: tun.port, local: tun.local, peer: tun.peer, counter };
    return look.status === 'ok' ? { ...env, key: look.key } : env;
  }

  /** Write the tunnel's row when a displayed value changed (rule 20). */
  function writeRow(ctx: ProcessCtx, tun: Tun): void {
    const state = ipsecSaStateOf(tun.t.state);
    const row: IpsecSaRow = { key: tun.port, port: tun.port, local: tun.local, peer: tun.peer, profile: tun.profile, role: tun.t.role, state, since: tun.since, updatedAt: ctx.now };
    if (state === 'failed' && tun.t.reason !== undefined) row.reason = tun.t.reason;
    if (state === 'established') {
      if (tun.t.spiI !== undefined) row.ikeSpiI = tun.t.spiI;
      if (tun.t.spiR !== undefined) row.ikeSpiR = tun.t.spiR;
      if (tun.t.espSpiIn !== undefined) row.espSpiIn = tun.t.espSpiIn;
      if (tun.t.espSpiOut !== undefined) row.espSpiOut = tun.t.espSpiOut;
      row.proposal = IKE_PROPOSAL_LABEL;
    }
    const fp = JSON.stringify([row.local, row.peer, row.profile, row.role, row.state, row.reason ?? null, row.ikeSpiI ?? null, row.ikeSpiR ?? null, row.espSpiIn ?? null, row.espSpiOut ?? null, row.proposal ?? null]);
    if (fp === tun.rowFp) return;
    if (tun.rowState !== state) {
      tun.since = ctx.now;
      row.since = ctx.now;
    }
    tun.rowFp = fp;
    tun.rowState = state;
    table(ctx)?.set(row);
  }

  /** The PDU of one IKEv2 message from the tunnel source to its destination (§3.13 steps 2 and 4). */
  function messageAction(ctx: ProcessCtx, tun: Tun, msg: IkeMessage, triggeredBy?: PduId): Action {
    const layers: LayerSpec[] = [
      { proto: 'ipv4', fields: { src: tun.local, dst: tun.peer, protocol: IPPROTO_UDP, ttl: ctx.model.ipDefaults.ttl } },
      { proto: 'udp', fields: { srcPort: UDP_PORT_IKE, dstPort: UDP_PORT_IKE } },
      { proto: 'ikev2', fields: ikeMessageFields(msg) },
    ];
    const meta: Partial<PduMeta> = {
      tag: ikeTagOf(msg.exchange),
      flow: flowKey(4, tun.local, tun.peer, 'udp', UDP_PORT_IKE, UDP_PORT_IKE),
      ...(msg.exchange === IKE_AUTH ? { protected: true as const, protectedBy: 'ike' as const } : {}),
      ...(triggeredBy !== undefined ? { triggeredBy } : {}),
    };
    const pdu = ctx.newPdu(layers, meta);
    return { type: 'request', to: 'ipv4', req: { kind: 'ipv4.send', pdu } };
  }

  /** Apply one pure step: state, counter, transition, notes, message, timers, the SA signal, the retry, the row. */
  function apply(ctx: ProcessCtx, tun: Tun, step: IkeStep, opts: { triggeredBy?: PduId; retransmit?: boolean } = {}): Action[] {
    const out: Action[] = [];
    const before = tun.t;
    tun.t = step.tunnel;
    if (step.consumedCounter === true) counter++;
    if (step.transition !== undefined) {
      const { from, to, cause } = step.transition;
      const fsm: FsmTransition = opts.triggeredBy !== undefined
        ? { machine: 'ike', subject: tun.port, port: tun.port, from, to, cause, pdu: opts.triggeredBy }
        : { machine: 'ike', subject: tun.port, port: tun.port, from, to, cause };
      const message = `${tun.port}: ${from} -> ${to} (${cause})`;
      ctx.transition(IKE_DEBUG, message, fsm);
      pushRing({ at: ctx.now, device: ctx.deviceId, process: NAME, category: IKE_DEBUG, message, data: { fsm } });
    }
    if (step.note !== undefined) debug(ctx, `${tun.port}: ${step.note}`, { port: tun.port, ...(opts.triggeredBy !== undefined ? { pdu: opts.triggeredBy } : {}) });
    if (step.send !== undefined) {
      debug(ctx, `${tun.port}: ${opts.retransmit === true ? 'retransmitted' : 'sent'} ${ikeDescribe(step.send)} to ${tun.peer}`, { port: tun.port, exchange: step.send.exchange, messageId: step.send.messageId });
      out.push(messageAction(ctx, tun, step.send, opts.triggeredBy));
    }
    if (step.timer !== undefined) {
      if (step.timer.op === 'arm') {
        out.push({ type: 'timer', key: rexmtKey(tun.port), delay: step.timer.delayNs });
        tun.rexmtAt = ctx.now + step.timer.delayNs;
      } else {
        out.push({ type: 'cancelTimer', key: rexmtKey(tun.port) });
        delete tun.rexmtAt;
      }
    }
    if (step.sa !== undefined) {
      const sa = step.sa;
      if (sa.op === 'up') {
        debug(ctx, `${tun.port}: SA with ${tun.peer} is up (inbound SPI 0x${hex32(sa.spiIn)}, outbound SPI 0x${hex32(sa.spiOut)})`, { port: tun.port });
        out.push({ type: 'request', to: 'gre', req: { kind: 'tunnel.sa', port: tun.port, op: 'up', spiIn: sa.spiIn, spiOut: sa.spiOut, keyId: sa.keyId } });
      } else {
        debug(ctx, `${tun.port}: SA with ${tun.peer} is down (${sa.reason})`, { port: tun.port, reason: sa.reason });
        out.push({ type: 'request', to: 'gre', req: { kind: 'tunnel.sa', port: tun.port, op: 'down', reason: sa.reason } });
      }
    }
    const to = step.transition?.to;
    if (to === 'failed') {
      if (tun.t.reason === 'ike-failed') out.push({ type: 'log', severity: IKE_AUTH_FAILURE_SEVERITY, facility: IKE_LOG_FACILITY, message: ikeAuthFailureMessage(tun.port, tun.peer) });
      if (!tun.retryArmed) out.push(armRetry(tun));
    } else if (to !== undefined && before.state === 'failed' && tun.retryArmed) {
      tun.retryArmed = false;
      out.push({ type: 'cancelTimer', key: retryKey(tun.port) });
    }
    writeRow(ctx, tun);
    return out;
  }

  function armRetry(tun: Tun): Action {
    tun.retryArmed = true;
    return { type: 'timer', key: retryKey(tun.port), delay: IKE_RETRY_NS, periodic: true };
  }

  /** Start (or restart) the exchange: the kick and the periodic retry. */
  function start(ctx: ProcessCtx, tun: Tun): Action[] {
    const look = lookup(ctx, tun);
    if (look.status === 'no-ipsec-profile') {
      if (!tun.waiting) debug(ctx, `${tun.port}: IPsec profile ${tun.profile} does not exist; waiting for it`, { port: tun.port, profile: tun.profile });
      tun.waiting = true;
      return [];
    }
    tun.waiting = false;
    if (look.status !== 'ok' && (tun.t.state === 'idle' || (tun.t.state === 'failed' && tun.t.reason !== 'ike-no-proposal'))) {
      debug(ctx, `${tun.port}: no pre-shared key for ${tun.peer} (${look.status})`, { port: tun.port, why: look.status });
    }
    const out = apply(ctx, tun, ikeStart(tun.t, envOf(ctx, tun, look)));
    if (tun.t.state === 'failed' && !tun.retryArmed) out.push(armRetry(tun));
    return out;
  }

  /** Forget a tunnel: its timers and its row (`ike.disconnect`, or a connect that replaces it). */
  function stop(ctx: ProcessCtx, tun: Tun, deleteRow: boolean): Action[] {
    const out: Action[] = [{ type: 'cancelTimer', key: kickKey(tun.port) }];
    const step = ikeStop(tun.t);
    if (step.transition !== undefined) {
      const { from, to, cause } = step.transition;
      const fsm: FsmTransition = { machine: 'ike', subject: tun.port, port: tun.port, from, to, cause };
      const message = `${tun.port}: ${from} -> ${to} (${cause})`;
      ctx.transition(IKE_DEBUG, message, fsm);
      pushRing({ at: ctx.now, device: ctx.deviceId, process: NAME, category: IKE_DEBUG, message, data: { fsm } });
    }
    tun.t = step.tunnel;
    if (step.timer !== undefined || tun.rexmtAt !== undefined) out.push({ type: 'cancelTimer', key: rexmtKey(tun.port) });
    delete tun.rexmtAt;
    if (tun.retryArmed) {
      tun.retryArmed = false;
      out.push({ type: 'cancelTimer', key: retryKey(tun.port) });
    }
    tunnels.delete(tun.port);
    if (deleteRow && table(ctx)?.has(tun.port) === true) table(ctx)?.delete(tun.port, 'cleared');
    return out;
  }

  function connect(ctx: ProcessCtx, req: Extract<ProcessRequest, { kind: 'ike.connect' }>): Action[] {
    portOrder = new Map([...ctx.ports.keys()].map((id, i) => [id, i]));
    const prev = tunnels.get(req.port);
    if (prev !== undefined && prev.local === req.local && prev.peer === req.peer && prev.profile === req.profile) return [];
    const out: Action[] = [];
    if (prev !== undefined) out.push(...stop(ctx, prev, false));
    if (!socketOpen) {
      socketOpen = true;
      out.push({ type: 'request', to: 'udp', req: { kind: 'udp.open', owner: NAME, socket: IKE_SOCKET, family: 4, localAddr: '0.0.0.0', localPort: UDP_PORT_IKE } });
    }
    const tun: Tun = { port: req.port, local: req.local, peer: req.peer, profile: req.profile, t: IKE_IDLE, waiting: false, retryArmed: false, since: ctx.now };
    tunnels.set(req.port, tun);
    debug(ctx, `${req.port}: protect the tunnel ${req.local} to ${req.peer} with IPsec profile ${req.profile}`, { port: req.port, local: req.local, peer: req.peer, profile: req.profile });
    writeRow(ctx, tun);
    out.push({ type: 'timer', key: kickKey(req.port), delay: 0 });
    return out;
  }

  function disconnect(ctx: ProcessCtx, port: PortId): Action[] {
    const tun = tunnels.get(port);
    if (tun === undefined) return [];
    debug(ctx, `${port}: protection released`, { port });
    const out = stop(ctx, tun, true);
    if (tunnels.size === 0 && socketOpen) {
      socketOpen = false;
      out.push({ type: 'request', to: 'udp', req: { kind: 'udp.close', socket: IKE_SOCKET } });
    }
    return out;
  }

  /** A datagram on `ike#500`. */
  function receive(ctx: ProcessCtx, ev: Extract<ProcessEvent, { kind: 'sock.datagram' }>): Action[] {
    const f = ev.pdu.layer('ikev2')?.fields;
    if (f === undefined) {
      debug(ctx, `datagram from ${ev.from} is not an IKEv2 message; discarded`, { from: ev.from, pdu: ev.pdu.id });
      return [];
    }
    const msg = ikeMessageOf(f);
    let tun: Tun | undefined;
    for (const t of tunnels.values()) {
      if (t.local === ev.to && t.peer === ev.from) {
        tun = t;
        break;
      }
    }
    if (tun === undefined) {
      debug(ctx, `${ikeDescribe(msg)} from ${ev.from} to ${ev.to} matches no protected tunnel; discarded`, { from: ev.from, pdu: ev.pdu.id });
      return [];
    }
    debug(ctx, `${tun.port}: received ${ikeDescribe(msg)} from ${ev.from}`, { port: tun.port, exchange: msg.exchange, messageId: msg.messageId, pdu: ev.pdu.id });
    const look = lookup(ctx, tun);
    const out = apply(ctx, tun, ikeReceive(tun.t, msg, envOf(ctx, tun, look)), { triggeredBy: ev.pdu.id });
    if (tun.t.state === 'failed' && !tun.retryArmed && tunnels.get(tun.port) === tun) out.push(armRetry(tun));
    return out;
  }

  const portOf = (key: string, prefix: string): PortId | undefined => (key.startsWith(prefix) ? key.slice(prefix.length) : undefined);

  return {
    name: NAME,

    init(): Action[] {
      return [];
    },

    onConfig(ctx: ProcessCtx, _delta: ConfigDelta): Action[] {
      if (tunnels.size === 0) return [];
      const out: Action[] = [];
      for (const tun of tunnels.values()) {
        // a waiting tunnel starts as soon as its IPsec profile exists (ipsecProfileMissing, §2.17)
        if (tun.waiting && lookup(ctx, tun).status !== 'no-ipsec-profile') out.push({ type: 'timer', key: kickKey(tun.port), delay: 0 });
      }
      return out;
    },

    onRequest(ctx: ProcessCtx, req: ProcessRequest): Action[] {
      if (req.kind === 'ike.connect') return connect(ctx, req);
      if (req.kind === 'ike.disconnect') return disconnect(ctx, req.port);
      return [];
    },

    onTimer(ctx: ProcessCtx, key: string): Action[] {
      let port = portOf(key, IKE_KICK_PREFIX);
      if (port !== undefined) {
        const tun = tunnels.get(port);
        return tun === undefined ? [] : start(ctx, tun);
      }
      port = portOf(key, IKE_REXMT_PREFIX);
      if (port !== undefined) {
        const tun = tunnels.get(port);
        if (tun === undefined) return [];
        delete tun.rexmtAt;
        return apply(ctx, tun, ikeTimeout(tun.t), { retransmit: true });
      }
      port = portOf(key, IKE_RETRY_PREFIX);
      if (port !== undefined) {
        const tun = tunnels.get(port);
        if (tun === undefined) return [];
        tun.retryArmed = false;
        // a tunnel that left `failed` meanwhile (it answered the peer's new exchange) is not restarted
        if (tun.t.state !== 'failed' && tun.t.state !== 'idle') return [];
        return start(ctx, tun);
      }
      return [];
    },

    onEvent(ctx: ProcessCtx, ev: ProcessEvent): Action[] {
      if (ev.kind === 'sock.error' && ev.socket === IKE_SOCKET) {
        debug(ctx, `socket error ${ev.code}${ev.detail !== undefined ? ` (${ev.detail})` : ''}`, { code: ev.code });
        return [];
      }
      if (ev.kind !== 'sock.datagram' || ev.socket !== IKE_SOCKET) return [];
      return receive(ctx, ev);
    },

    onPdu(): Action[] {
      return [];
    },

    stateSnapshot(): StateView {
      const exchanges: IkeStateView['exchanges'] = [...tunnels.values()]
        .filter((t) => t.t.outstanding !== undefined)
        .sort((a, b) => (portOrder.get(a.port) ?? Number.MAX_SAFE_INTEGER) - (portOrder.get(b.port) ?? Number.MAX_SAFE_INTEGER))
        .map((t) => {
          const e: { port: PortId; messageId: number; retriesLeft: number; nextAt?: SimTime } = {
            port: t.port,
            messageId: t.t.outstanding!.messageId,
            retriesLeft: Math.max(0, IKE_REXMT_DELAYS_NS.length - t.t.retransmits),
          };
          if (t.rexmtAt !== undefined) e.nextAt = t.rexmtAt;
          return e;
        });
      const view: IkeStateView = { exchanges };
      return { process: NAME, state: { exchanges: view.exchanges } };
    },

    debugEvents(): readonly DebugEvent[] {
      return ring;
    },
  };
}

function hex32(v: number): string {
  return (v >>> 0).toString(16).padStart(8, '0');
}
