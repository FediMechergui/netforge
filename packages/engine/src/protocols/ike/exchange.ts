/**
 * protocols/ike/exchange.ts — IKEv2-lite, the pure exchange of one protected tunnel [C13] (ARCHITECTURE-P3 D27, §2.17,
 * §3.13, §4.2, §4.5; §7 W1 wan).
 *
 * The W3 `ike` daemon keeps one `IkeTunnel` per tunnel port and drives it with three calls: `ikeStart` (the
 * `ike-kick:<port>` and the periodic `ike-retry:<port>`), `ikeReceive` (an IKEv2 message from the peer, already
 * matched to the tunnel by its addresses) and `ikeTimeout` (`ike-rexmt:<port>`). Each returns the next state and what
 * to do: the message to send, the timer to arm or cancel, the `ike` FSM transition, the `tunnel.sa` request for the
 * tunnel owner, and a debug note for a message it discards. Messages are field records of the `ikev2` layer
 * (`contracts/fields.ts`: `spiI`, `spiR`, `exchange`, `flags`, `messageId`, and the payload strings); the codec derives
 * `nextPayload`, `version` and `length`, and the daemon marks IKE_AUTH messages `meta.protected` with `protectedBy:
 * 'ike'`.
 *
 * The four messages (§3.13 steps 2–5):
 *   1. IKE_SA_INIT request: `{spiI, spiR 0…0, exchange 34, flags I, messageId 0, sa, ke, nonce}`;
 *   2. IKE_SA_INIT response: `{spiI, spiR, exchange 34, flags R, messageId 0, sa, ke, nonce}` — or `notify
 *      NO_PROPOSAL_CHOSEN` when the responder has no keyring peer for the initiator's address or the proposal is not
 *      the one fixed proposal;
 *   3. IKE_AUTH request: `{spiI, spiR, exchange 35, flags I, messageId 1, idi, auth, sa (child: the initiator's
 *      inbound ESP SPI), tsi, tsr}`;
 *   4. IKE_AUTH response: `{…, flags R, messageId 1, idr, auth, sa (child: the responder's inbound ESP SPI), tsi,
 *      tsr}` — or `notify AUTHENTICATION_FAILED` when the initiator's proof does not match the responder's key.
 *
 * Rules (D27):
 *   - Crossing initiations: an IKE_SA_INIT request that arrives while this end's own request is outstanding is
 *     answered only when the peer's tunnel source address is the lower one (u32); this end then abandons its own
 *     exchange and becomes the responder. Otherwise the request is discarded with a note. The outcome is the same
 *     whichever request arrives first.
 *   - Retransmission: an unanswered request is sent again after 1, 2 and 4 s (`IKE_REXMT_DELAYS_NS`: three
 *     retransmissions); if the third is unanswered too, the exchange fails with `ike-no-response` after a final wait of
 *     `IKE_NO_RESPONSE_WAIT_NS` (8 s, the next doubling). Never periodic; a failed exchange is retried by the
 *     daemon's periodic 10 s `ike-retry` (rule 19). A responder never retransmits: it answers a repeated request
 *     (same SPIs, same message id) with the response it sent before.
 *   - A new IKE_SA_INIT from a peer with an established SA replaces that SA (the peer reloaded): the SA goes down with
 *     reason `ike-negotiating` and this end answers as the responder.
 *   - Derived values (`proof.ts`) take the daemon's per-process counter (§4.1); a step that starts a new exchange
 *     (as initiator or as responder) reports `consumedCounter`, and the daemon then increments the counter.
 *
 * Pure: no module state, no randomness, no clock.
 */
import type { Ipv4Address } from '../../contracts/addr.js';
import { ipv4ToU32 } from '../../contracts/addr.js';
import type { PortId } from '../../contracts/ids.js';
import type { IpsecSaRow } from '../../contracts/tables.js';
import { SEC } from '../../contracts/time.js';
import type { SimTime } from '../../contracts/time.js';
import { espSpiOf, ikeAuthProof, ikeKeOf, ikeNonceOf, ikeSpiOf, ipsecKeyIdOf, type IkeProofInputs } from './proof.js';

/** Exchange types (RFC 7296 §3.1). */
export const IKE_SA_INIT = 34;
export const IKE_AUTH = 35;
/** Header flags (RFC 7296 §3.1): the original initiator's messages carry I; every response carries R. */
export const IKE_FLAG_INITIATOR = 0x08;
export const IKE_FLAG_RESPONSE = 0x20;
/** The responder SPI of a first request. */
export const IKE_SPI_ZERO = '0000000000000000';
/** The one IKE SA proposal (named on the wire and in the shows, never computed; D27). */
export const IKE_PROPOSAL = 'enc=aes-cbc-256,integ=sha256,prf=sha256,dh=14';
/** `IpsecSaRow.proposal` once chosen. */
export const IKE_PROPOSAL_LABEL = 'aes-cbc-256 sha256 group14';
/** The child SA proposal before its `spi=` term. */
export const IKE_CHILD_PROPOSAL_PREFIX = 'esp:enc=aes-cbc-256,integ=sha256';
/** A VTI's traffic selectors (`tsi`, `tsr`). */
export const IKE_TRAFFIC_SELECTOR = '0.0.0.0/0';
/** Notify payloads. */
export const IKE_NOTIFY_AUTHENTICATION_FAILED = 'AUTHENTICATION_FAILED';
export const IKE_NOTIFY_NO_PROPOSAL_CHOSEN = 'NO_PROPOSAL_CHOSEN';
/** Waits before the first, second and third retransmission of an unanswered request (§4.2 `ike-rexmt`). */
export const IKE_REXMT_DELAYS_NS: readonly SimTime[] = Object.freeze([1 * SEC, 2 * SEC, 4 * SEC]);
/** The wait after the third retransmission before the exchange fails with `ike-no-response`. */
export const IKE_NO_RESPONSE_WAIT_NS: SimTime = 8 * SEC;
/** The periodic retry of a failed exchange (§4.2 `ike-retry`). */
export const IKE_RETRY_NS: SimTime = 10 * SEC;

/** One IKEv2 message as the fields of an `ikev2` layer (the codec derives nextPayload, version and length). */
export interface IkeMessage {
  readonly spiI: string;
  readonly spiR: string;
  readonly exchange: number;
  readonly flags: number;
  readonly messageId: number;
  readonly sa?: string;
  readonly ke?: string;
  readonly nonce?: string;
  readonly idi?: string;
  readonly idr?: string;
  readonly auth?: string;
  readonly tsi?: string;
  readonly tsr?: string;
  readonly notify?: string;
}

/** The `ike` FSM states (§2.17). */
export type IkeState = 'idle' | 'init-sent' | 'init-answered' | 'auth-sent' | 'established' | 'failed';
/** Why an exchange failed (`IpsecSaRow.reason`). */
export type IkeFailure = NonNullable<IpsecSaRow['reason']>;

/** The pure state of one protected tunnel. */
export interface IkeTunnel {
  readonly state: IkeState;
  readonly role: 'initiator' | 'responder';
  readonly reason?: IkeFailure;
  readonly spiI?: string;
  readonly spiR?: string;
  readonly nonceI?: string;
  readonly nonceR?: string;
  /** This end's inbound ESP SPI (derived when the exchange starts, sent in IKE_AUTH). */
  readonly espSpiIn?: number;
  /** The peer's inbound ESP SPI (learned from its IKE_AUTH message). */
  readonly espSpiOut?: number;
  readonly keyId?: number;
  /** Initiator: the request waiting for its response. */
  readonly outstanding?: IkeMessage;
  /** Retransmissions of `outstanding` so far (0–3). */
  readonly retransmits: number;
  /** Responder: the last response sent, sent again when the same request arrives again. */
  readonly lastResponse?: IkeMessage;
}

/** A tunnel before its first exchange. */
export const IKE_IDLE: IkeTunnel = Object.freeze({ state: 'idle', role: 'initiator', retransmits: 0 });

/** What the daemon knows when it drives a tunnel. */
export interface IkeEnv {
  readonly device: string;
  readonly port: PortId;
  /** The tunnel source address (this end). */
  readonly local: Ipv4Address;
  /** The tunnel destination (the peer). */
  readonly peer: Ipv4Address;
  /** The pre-shared key of the keyring peer whose address is `peer`; undefined when the keyring has none. */
  readonly key?: string;
  /** The daemon's per-process counter (§4.1). */
  readonly counter: number;
}

/** The `tunnel.sa` request for the tunnel owner. */
export type IkeSaSignal =
  | { readonly op: 'up'; readonly spiIn: number; readonly spiOut: number; readonly keyId: number }
  | { readonly op: 'down'; readonly reason: 'ike-negotiating' | IkeFailure };

/** What one call does. */
export interface IkeStep {
  readonly tunnel: IkeTunnel;
  /** The message to send to the peer (UDP 500 → 500). */
  readonly send?: IkeMessage;
  /** `ike-rexmt:<port>`: arm it (replacing any armed one) or cancel it. */
  readonly timer?: { readonly op: 'arm'; readonly delayNs: SimTime } | { readonly op: 'cancel' };
  /** The `ike` FSM transition (absent when the state did not change). */
  readonly transition?: { readonly from: IkeState; readonly to: IkeState; readonly cause: string };
  readonly sa?: IkeSaSignal;
  /** The step started an exchange with the counter: increment it. */
  readonly consumedCounter?: true;
  /** Why a message was discarded (a `crypto ikev2` debug line; original wording). */
  readonly note?: string;
}

// ── messages ────────────────────────────────────────────────────────────────

/** The child SA proposal carrying `spi` (`…,spi=0x0000abcd`). */
export function ikeChildProposal(spi: number): string {
  return `${IKE_CHILD_PROPOSAL_PREFIX},spi=0x${(spi >>> 0).toString(16).padStart(8, '0')}`;
}

/** The SPI of a child SA proposal; undefined when `sa` is not one. */
export function ikeChildSpiOf(sa: string | undefined): number | undefined {
  if (sa === undefined || !sa.startsWith(`${IKE_CHILD_PROPOSAL_PREFIX},spi=0x`)) return undefined;
  const hex = sa.slice(IKE_CHILD_PROPOSAL_PREFIX.length + ',spi=0x'.length);
  if (!/^[0-9a-f]{8}$/.test(hex)) return undefined;
  return parseInt(hex, 16) >>> 0;
}

export function ikeInitRequest(m: { spiI: string; ke: string; nonce: string }): IkeMessage {
  return { spiI: m.spiI, spiR: IKE_SPI_ZERO, exchange: IKE_SA_INIT, flags: IKE_FLAG_INITIATOR, messageId: 0, sa: IKE_PROPOSAL, ke: m.ke, nonce: m.nonce };
}

export function ikeInitResponse(m: { spiI: string; spiR: string; ke: string; nonce: string }): IkeMessage {
  return { spiI: m.spiI, spiR: m.spiR, exchange: IKE_SA_INIT, flags: IKE_FLAG_RESPONSE, messageId: 0, sa: IKE_PROPOSAL, ke: m.ke, nonce: m.nonce };
}

export function ikeAuthRequest(m: { spiI: string; spiR: string; idi: Ipv4Address; auth: string; espSpi: number }): IkeMessage {
  return {
    spiI: m.spiI,
    spiR: m.spiR,
    exchange: IKE_AUTH,
    flags: IKE_FLAG_INITIATOR,
    messageId: 1,
    idi: m.idi,
    auth: m.auth,
    sa: ikeChildProposal(m.espSpi),
    tsi: IKE_TRAFFIC_SELECTOR,
    tsr: IKE_TRAFFIC_SELECTOR,
  };
}

export function ikeAuthResponse(m: { spiI: string; spiR: string; idr: Ipv4Address; auth: string; espSpi: number }): IkeMessage {
  return {
    spiI: m.spiI,
    spiR: m.spiR,
    exchange: IKE_AUTH,
    flags: IKE_FLAG_RESPONSE,
    messageId: 1,
    idr: m.idr,
    auth: m.auth,
    sa: ikeChildProposal(m.espSpi),
    tsi: IKE_TRAFFIC_SELECTOR,
    tsr: IKE_TRAFFIC_SELECTOR,
  };
}

/** A refusal: a response carrying only a notify payload. */
export function ikeNotifyResponse(m: { spiI: string; spiR: string; exchange: number; messageId: number; notify: string }): IkeMessage {
  return { spiI: m.spiI, spiR: m.spiR, exchange: m.exchange, flags: IKE_FLAG_RESPONSE, messageId: m.messageId, notify: m.notify };
}

/** A response (R flag) rather than a request. */
export function ikeIsResponse(msg: IkeMessage): boolean {
  return (msg.flags & IKE_FLAG_RESPONSE) !== 0;
}

/**
 * The crossing rule (D27): when both ends' IKE_SA_INIT requests cross, the exchange started by the lower tunnel source
 * address (u32) continues. True when this end keeps its own exchange and discards the peer's request.
 */
export function ikeKeepsOwnExchange(local: Ipv4Address, peer: Ipv4Address): boolean {
  return ipv4ToU32(local) < ipv4ToU32(peer);
}

/** The `ipsec-sa` row state of an `ike` state. */
export function ipsecSaStateOf(state: IkeState): IpsecSaRow['state'] {
  if (state === 'established') return 'established';
  if (state === 'failed') return 'failed';
  return 'negotiating';
}

// ── steps ───────────────────────────────────────────────────────────────────

const moved = (from: IkeState, to: IkeState, cause: string): IkeStep['transition'] => (from === to ? undefined : { from, to, cause });

function proofInputs(t: IkeTunnel, key: string): IkeProofInputs {
  return { key, spiI: t.spiI ?? '', spiR: t.spiR ?? '', nonceI: t.nonceI ?? '', nonceR: t.nonceR ?? '' };
}

/** An established SA replaced by a new exchange goes down while the new one negotiates. */
function saDownFrom(t: IkeTunnel, reason: 'ike-negotiating'): IkeSaSignal | undefined {
  return t.state === 'established' ? { op: 'down', reason } : undefined;
}

/**
 * The tunnel fails: state `failed` with `reason`, the retransmission timer cancelled when a request was outstanding,
 * and `tunnel.sa {op: 'down', reason}` so the tunnel owner shows why (§3.13 step 10). `send` is the refusal a
 * responder answers with.
 */
function fail(t: IkeTunnel, reason: IkeFailure, cause: string, send?: IkeMessage): IkeStep {
  const next: IkeTunnel = { ...t, state: 'failed', reason, outstanding: undefined, retransmits: 0, ...(send ? { lastResponse: send } : {}) };
  return {
    tunnel: next,
    ...(send ? { send } : {}),
    ...(t.outstanding !== undefined ? { timer: { op: 'cancel' } as const } : {}),
    transition: moved(t.state, 'failed', cause),
    sa: { op: 'down', reason },
  };
}

/**
 * Start an exchange as the initiator (the kick, or the periodic retry after a failure). Only an idle or failed tunnel
 * starts; any other state is left alone. Without a keyring peer for the destination the tunnel fails at once with
 * `ike-no-proposal` and sends nothing.
 */
export function ikeStart(t: IkeTunnel, env: IkeEnv): IkeStep {
  if (t.state !== 'idle' && t.state !== 'failed') return { tunnel: t };
  if (env.key === undefined) {
    if (t.state === 'failed' && t.reason === 'ike-no-proposal') return { tunnel: t };
    return fail({ ...t, role: 'initiator' }, 'ike-no-proposal', 'no keyring peer for the tunnel destination');
  }
  const spiI = ikeSpiOf(env.device, env.port, env.counter, 'I');
  const nonceI = ikeNonceOf(env.device, env.port, env.counter, 'I');
  const ke = ikeKeOf(env.device, env.port, env.counter, 'I');
  const request = ikeInitRequest({ spiI, ke, nonce: nonceI });
  const next: IkeTunnel = {
    state: 'init-sent',
    role: 'initiator',
    spiI,
    nonceI,
    espSpiIn: espSpiOf(env.device, env.port, env.counter),
    outstanding: request,
    retransmits: 0,
  };
  return {
    tunnel: next,
    send: request,
    timer: { op: 'arm', delayNs: IKE_REXMT_DELAYS_NS[0]! },
    transition: moved(t.state, 'init-sent', 'exchange started'),
    consumedCounter: true,
  };
}

/** Answer an IKE_SA_INIT request as the responder (a new exchange). */
function respondToInit(t: IkeTunnel, msg: IkeMessage, env: IkeEnv, cause: string): IkeStep {
  if (env.key === undefined || msg.sa !== IKE_PROPOSAL || msg.nonce === undefined || msg.ke === undefined) {
    const refusal = ikeNotifyResponse({ spiI: msg.spiI, spiR: IKE_SPI_ZERO, exchange: IKE_SA_INIT, messageId: 0, notify: IKE_NOTIFY_NO_PROPOSAL_CHOSEN });
    const responder: IkeTunnel = { ...IKE_IDLE, state: t.state, role: 'responder', spiI: msg.spiI, outstanding: t.outstanding };
    return fail(responder, 'ike-no-proposal', env.key === undefined ? 'no keyring peer for the initiator address' : 'proposal not supported', refusal);
  }
  const cancel = t.outstanding !== undefined ? ({ op: 'cancel' } as const) : undefined;
  const spiR = ikeSpiOf(env.device, env.port, env.counter, 'R');
  const nonceR = ikeNonceOf(env.device, env.port, env.counter, 'R');
  const ke = ikeKeOf(env.device, env.port, env.counter, 'R');
  const response = ikeInitResponse({ spiI: msg.spiI, spiR, ke, nonce: nonceR });
  const next: IkeTunnel = {
    state: 'init-answered',
    role: 'responder',
    spiI: msg.spiI,
    spiR,
    nonceI: msg.nonce,
    nonceR,
    espSpiIn: espSpiOf(env.device, env.port, env.counter),
    retransmits: 0,
    lastResponse: response,
  };
  const sa = saDownFrom(t, 'ike-negotiating');
  return {
    tunnel: next,
    send: response,
    ...(cancel ? { timer: cancel } : {}),
    transition: moved(t.state, 'init-answered', cause),
    ...(sa ? { sa } : {}),
    consumedCounter: true,
  };
}

/** A request from the peer. */
function receiveRequest(t: IkeTunnel, msg: IkeMessage, env: IkeEnv): IkeStep {
  if (msg.exchange === IKE_SA_INIT) {
    if (msg.messageId !== 0 || msg.spiR !== IKE_SPI_ZERO) return { tunnel: t, note: 'IKE_SA_INIT request with a responder SPI or a message id: discarded' };
    switch (t.state) {
      case 'init-sent':
      case 'auth-sent':
        if (ikeKeepsOwnExchange(env.local, env.peer)) {
          return { tunnel: t, note: `crossing IKE_SA_INIT from ${env.peer} discarded: the lower address ${env.local} keeps its own exchange` };
        }
        return respondToInit(t, msg, env, `crossing request from the lower address ${env.peer}`);
      case 'init-answered':
        if (msg.spiI === t.spiI && t.lastResponse !== undefined) return { tunnel: t, send: t.lastResponse, note: 'repeated IKE_SA_INIT request: response sent again' };
        return respondToInit(t, msg, env, 'the peer restarted the exchange');
      case 'established':
        return respondToInit(t, msg, env, 'new exchange from the peer replaces the SA');
      case 'failed':
      case 'idle':
        if (t.state === 'failed' && t.role === 'responder' && msg.spiI === t.spiI && t.lastResponse?.exchange === IKE_SA_INIT) {
          return { tunnel: t, send: t.lastResponse, note: 'repeated IKE_SA_INIT request: refusal sent again' };
        }
        return respondToInit(t, msg, env, 'IKE_SA_INIT request received');
    }
  }
  if (msg.exchange === IKE_AUTH) {
    const same = msg.spiI === t.spiI && msg.spiR === t.spiR && msg.messageId === 1;
    if (!same || t.role !== 'responder') return { tunnel: t, note: 'IKE_AUTH request for no exchange of this tunnel: discarded' };
    if (t.state === 'established' || t.state === 'failed') {
      return t.lastResponse !== undefined && t.lastResponse.exchange === IKE_AUTH
        ? { tunnel: t, send: t.lastResponse, note: 'repeated IKE_AUTH request: response sent again' }
        : { tunnel: t, note: 'IKE_AUTH request out of sequence: discarded' };
    }
    if (t.state !== 'init-answered') return { tunnel: t, note: 'IKE_AUTH request out of sequence: discarded' };
    const spiOut = ikeChildSpiOf(msg.sa);
    if (env.key === undefined || msg.auth !== ikeAuthProof(proofInputs(t, env.key), 'I') || spiOut === undefined) {
      const refusal = ikeNotifyResponse({ spiI: msg.spiI, spiR: msg.spiR, exchange: IKE_AUTH, messageId: 1, notify: IKE_NOTIFY_AUTHENTICATION_FAILED });
      return fail(t, 'ike-failed', 'the initiator proof does not match the pre-shared key', refusal);
    }
    const keyId = ipsecKeyIdOf(proofInputs(t, env.key));
    const response = ikeAuthResponse({
      spiI: msg.spiI,
      spiR: msg.spiR,
      idr: env.local,
      auth: ikeAuthProof(proofInputs(t, env.key), 'R'),
      espSpi: t.espSpiIn ?? 0,
    });
    const next: IkeTunnel = { ...t, state: 'established', reason: undefined, espSpiOut: spiOut, keyId, lastResponse: response };
    return {
      tunnel: next,
      send: response,
      transition: moved(t.state, 'established', 'initiator authenticated'),
      sa: { op: 'up', spiIn: t.espSpiIn ?? 0, spiOut, keyId },
    };
  }
  return { tunnel: t, note: `exchange type ${msg.exchange} not supported: discarded` };
}

/** A response to this end's outstanding request. */
function receiveResponse(t: IkeTunnel, msg: IkeMessage, env: IkeEnv): IkeStep {
  const out = t.outstanding;
  if (out === undefined || msg.spiI !== out.spiI || msg.exchange !== out.exchange || msg.messageId !== out.messageId) {
    return { tunnel: t, note: 'response to no outstanding request: discarded' };
  }
  if (msg.exchange === IKE_SA_INIT) {
    if (msg.notify === IKE_NOTIFY_NO_PROPOSAL_CHOSEN) return fail(t, 'ike-no-proposal', 'the responder chose no proposal');
    if (msg.sa !== IKE_PROPOSAL || msg.nonce === undefined || msg.spiR === IKE_SPI_ZERO) return fail(t, 'ike-no-proposal', 'the responder chose no proposal');
    if (env.key === undefined) return fail(t, 'ike-no-proposal', 'no keyring peer for the tunnel destination');
    const answered: IkeTunnel = { ...t, spiR: msg.spiR, nonceR: msg.nonce };
    const request = ikeAuthRequest({
      spiI: msg.spiI,
      spiR: msg.spiR,
      idi: env.local,
      auth: ikeAuthProof(proofInputs(answered, env.key), 'I'),
      espSpi: t.espSpiIn ?? 0,
    });
    return {
      tunnel: { ...answered, state: 'auth-sent', outstanding: request, retransmits: 0 },
      send: request,
      timer: { op: 'arm', delayNs: IKE_REXMT_DELAYS_NS[0]! },
      transition: moved(t.state, 'auth-sent', 'IKE_SA_INIT answered'),
    };
  }
  if (msg.spiR !== t.spiR) return { tunnel: t, note: 'IKE_AUTH response with another responder SPI: discarded' };
  if (msg.notify === IKE_NOTIFY_AUTHENTICATION_FAILED) return fail(t, 'ike-failed', 'the responder refused the proof');
  const spiOut = ikeChildSpiOf(msg.sa);
  if (env.key === undefined || msg.auth !== ikeAuthProof(proofInputs(t, env.key), 'R') || spiOut === undefined) {
    return fail(t, 'ike-failed', 'the responder proof does not match the pre-shared key');
  }
  const keyId = ipsecKeyIdOf(proofInputs(t, env.key));
  const next: IkeTunnel = { ...t, state: 'established', reason: undefined, espSpiOut: spiOut, keyId, outstanding: undefined, retransmits: 0 };
  return {
    tunnel: next,
    timer: { op: 'cancel' },
    transition: moved(t.state, 'established', 'responder authenticated'),
    sa: { op: 'up', spiIn: t.espSpiIn ?? 0, spiOut, keyId },
  };
}

/** An IKEv2 message from the tunnel's peer. */
export function ikeReceive(t: IkeTunnel, msg: IkeMessage, env: IkeEnv): IkeStep {
  return ikeIsResponse(msg) ? receiveResponse(t, msg, env) : receiveRequest(t, msg, env);
}

/** `ike-rexmt:<port>` expired: retransmit the outstanding request, or fail after the third retransmission. */
export function ikeTimeout(t: IkeTunnel): IkeStep {
  const out = t.outstanding;
  if (out === undefined) return { tunnel: t };
  if (t.retransmits >= IKE_REXMT_DELAYS_NS.length) return fail(t, 'ike-no-response', 'no response from the peer');
  const retransmits = t.retransmits + 1;
  const delayNs = retransmits < IKE_REXMT_DELAYS_NS.length ? IKE_REXMT_DELAYS_NS[retransmits]! : IKE_NO_RESPONSE_WAIT_NS;
  return { tunnel: { ...t, retransmits }, send: out, timer: { op: 'arm', delayNs } };
}

/** The tunnel was disconnected (`ike.disconnect`): back to idle, the timer cancelled. The daemon deletes the row. */
export function ikeStop(t: IkeTunnel): IkeStep {
  return {
    tunnel: IKE_IDLE,
    ...(t.outstanding !== undefined ? { timer: { op: 'cancel' } as const } : {}),
    transition: moved(t.state, 'idle', 'tunnel disconnected'),
  };
}
