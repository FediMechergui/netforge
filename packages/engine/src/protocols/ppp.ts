/**
 * protocols/ppp.ts — the PPP daemon [S19] (ARCHITECTURE-P3 D17, §2.3, §2.6 `PppRow`, §2.7, §3.9, §4.1–§4.3, §5.7, §5.8;
 * §7 W3 wan). RFC 1661 link control, RFC 1334 PAP, RFC 1994 CHAP with real MD5 (core/md5.ts), RFC 1332 IPCP with the
 * peer route, RFC 5072 IPv6CP, over the one pure RFC 1661 automaton of protocols/ppp/fsm.ts (one per protocol per
 * port). It runs on every router serial port (role `wan`) whose effective encapsulation is `ppp`; `hdlc` keeps every
 * other serial port (its keepalives are disarmed when a port leaves HDLC, protocols/hdlc.ts).
 *
 * Silence (§4.3): a device with no `ppp` port sends nothing, arms nothing and writes no row. A `ppp` port has a row in
 * the `ppp` table (key = the port) from the moment it is `ppp`, and sends nothing until its serial line is READY.
 *
 * The line (D17, §2.7): the link model tells both ends of a link with a `ppp` end `serial-line {ready}` (carrier, clock,
 * one encapsulation). Ready is the RFC Up event of LCP (after the administrative Open every `ppp` port gets), not
 * ready its Down. At `init` the daemon reads the same readiness from `phy` (carrier up, no `no-clock`, no
 * `encapsulation-mismatch`). The line protocol of each end is this daemon's report, MediumOp `ppp-link`: `up: true` in
 * the Network phase (LCP opened and every authentication passed, §3.9 step 4: before the NCPs, which is why arp and nd
 * hold IP back until IPCP and IPv6CP are opened), otherwise down with `ppp-auth-failed` (the last attempt failed
 * authentication, kept through the retries until one succeeds), `keepalive-missed` (LCP echoes went unanswered) or no
 * reason (negotiating). A report is sent only when it changes; the link model forgets it when the line stops being
 * ready, and so does this daemon.
 *
 * LCP (§3.9 step 3): Configure-Request `{authProto, magic}` — `authProto` is the first protocol of `ppp authentication`
 * (chap → 'chap-md5'), absent without the line; the magic number is FNV-derived per negotiation (§4.1). A peer's
 * request is acceptable when its authentication protocol is absent or 'chap-md5' (this end always answers CHAP), or
 * 'pap' while this port has `ppp pap sent-username` (the WAN map's PAP row, §10.1 `accept.p3.ppp-pap`); otherwise it
 * is naked with 'chap-md5', and once Max-Failure Naks went out without a Configure-Ack in between (RFC 1661 §4.6,
 * `pppNakBecomesReject`) the option is rejected instead and this end ends the attempt as an authentication failure
 * (so a PAP-only authenticator facing a peer without `sent-username` stops after Max-Failure on both ends, and
 * `runToIdle` returns). A Nak naming a protocol of our own list switches to it; a Nak naming another is answered by
 * asking again for ours (the peer rejects it at its Max-Failure); a Reject of the option (the peer will not
 * authenticate) fails the attempt as an authentication failure; a Reject of the magic number drops it; more than
 * Max-Failure Naks or Rejects in one attempt fail it as a negotiation failure.
 * Echo-Requests every `keepalive` seconds (default 10, 0 = none) while Opened, background with tag `lcp-echo`; four
 * unanswered → `keepalive-missed` and a renegotiation on the next tick, five intervals after the last answered echo
 * (§10.1 `accept.p3.ppp-keepalive`: "after 5 intervals"). Identifiers count per protocol from 1; replies must match the
 * outstanding request's identifier. A Protocol-Reject of IPCP or IPv6CP is that NCP's RXJ− (it stops); an NCP packet
 * this port does not run (IPCP without an IPv4 address, IPv6CP without IPv6) is answered with a Protocol-Reject in the
 * Network phase; control packets of a later phase are discarded (RFC 1661 §3).
 *
 * Authentication (§3.9 steps 4 and 6), both directions independent: `authLocal` is what this end requires (the
 * protocol its acknowledged request carried), `authPeer` what the peer requires (the protocol this end acknowledged).
 *   - CHAP authenticator: Challenge `{id, value: 16 FNV-derived bytes, name: hostname}`, repeated unchanged every 2 s
 *     (`chap-retry:<p>`, at most 10 sends); a Response is checked against MD5(id ‖ password ‖ challenge) with the
 *     password of `username <name> password <pw>` → Success, or Failure `the response does not match` (or `no password
 *     is configured for <name>`), a severity-5 log and the end of the attempt. W3 fix (RFC 1994 §4.2): after Success, a
 *     repeated Response to the same challenge (its Success was lost) is answered with Success again, no state change.
 *   - CHAP peer: answers a Challenge with MD5(id ‖ password ‖ challenge) and its hostname, the password being the one
 *     configured for the challenger's name; with none it does not answer (the authenticator then gives up). W3 fix:
 *     while it waits for the verdict it resends the same Response every 2 s (`chap-response:<p>`, never periodic, at
 *     most 10 sends; a new challenge id starts the count again), so a lost Success never leaves the line in the
 *     Authenticate phase; after the last send it gives up as the PAP peer does (authentication failed, end of the
 *     attempt). Success, Failure, LCP down and the line going down stop the timer.
 *   - PAP peer (only with `ppp pap sent-username`, which LCP requires before it acknowledges PAP): Authenticate-Request
 *     `{peerId, password}` from that line, resent every 2 s with a new identifier (`pap-retry:<p>`, at most 10
 *     sends). The password travels in the clear, on purpose.
 *   - PAP authenticator: compares the pair with `username <peerId> password <pw>` → Ack, or Nak `the user name or
 *     password does not match`, the log and the end of the attempt.
 *   A failed attempt (detected here) is LCP's RXJ− with the Terminate-Request reason `authentication failed` (Opened →
 *   Stopping → Stopped), so both ends end Stopped; a failure reported by the peer (CHAP Failure, PAP Nak) waits for the
 *   peer's Terminate-Request. The secret never appears in a PDU (CHAP); PAP carries it on purpose.
 *
 * Retry (§4.2, rule 19): when LCP finishes (Stopped or Closed) on a ready line, the periodic `ppp-retry:<p>` (10 s)
 * restarts it with the RFC restart option (Down, then Up) and a fresh magic number; the per-attempt timers
 * (`lcp-restart`, `ipcp-restart`, `ipv6cp-restart`: 2 s, Max-Configure 10, Max-Terminate 2; `chap-retry`,
 * `chap-response`, `pap-retry`)
 * are never periodic and are all stopped in Stopped, so `runToIdle` returns. A change of `ppp authentication` on a
 * ready line renegotiates at once (Down, then Up); other lines (`username`, `ppp pap sent-username`) are read when
 * used, so a corrected password is used by the next retry.
 *
 * NCPs (§3.9 step 5): IPCP runs while the port has a primary IPv4 address (Configure-Request `{ipAddress}`); IPv6CP
 * while IPv6 is configured on it (`{interfaceId}`: the low 64 bits of the configured link-local address, else the
 * modified EUI-64 of the port MAC). Both are Opened administratively and come Up in the Network phase. A peer request
 * is always acceptable; its address (interface id) is recorded when acknowledged and shown as `peerAddress`. While
 * IPCP is Opened with a peer address and the port keeps `peer neighbor-route` (the default), ppp offers ipv4 the peer
 * route `C <peer>/32` on the port (`ipv4.routes {owner: 'ppp'}`, the whole set of every port each time it changes). An
 * address change renegotiates the NCP; removing the address (or IPv6) closes it.
 *
 * The `ppp` row (rule 20): rewritten only when a displayed column changes; `phase` is derived (Dead without a ready
 * line or with LCP Initial, Starting, Closed or Stopped; Establish while LCP negotiates; Authenticate and Network once
 * Opened; Terminate in Closing and Stopping); `since` is the time of the last phase change. FSM transitions (§2.4):
 * `ppp-lcp` (subject the port), `ppp-auth` (pending → success | failed, and back to pending on the next attempt),
 * `ppp-ncp` (subjects 'Serial0/0/0 IPCP' and 'Serial0/0/0 IPv6CP').
 *
 * Debug categories (§5.8): `ppp negotiation` (LCP, IPCP and IPv6CP packets and transitions), `ppp authentication`.
 * No randomness: magic numbers and challenges are FNV-1a over (device, port, a per-process counter) (§4.1).
 *
 * stateSnapshot(): { process: 'ppp', state: { ports: [{ port, lineReady, phase, lcp, ipcp, ipv6cp, authLocal,
 *   authPeer, echoOutstanding, retryArmed, sent, received }], sent, received } } — ports in the order they became PPP.
 *
 * Every wording here is original.
 */
import type { Ipv4Address } from '../contracts/addr.js';
import { defaultRoleFor, KIND_ENCAP, type PortEncap, type PortRole } from '../contracts/catalog.js';
import type { ConfigDelta } from '../contracts/config.js';
import type { PortId } from '../contracts/ids.js';
import type { MediumEvent, MediumOp } from '../contracts/medium.js';
import { PPP_ADDRESS, PPP_CONTROL, PPP_PROTO, type FieldValue, type Pdu, type PduMeta } from '../contracts/pdu.js';
import type { PortView } from '../contracts/port.js';
import type { Action, DebugEvent, DemuxSelector, FsmTransition, Process, ProcessCtx, StateView } from '../contracts/process.js';
import { routeKey, type PppPhase, type PppRow, type RouteRow, type Table } from '../contracts/tables.js';
import { SEC, type SimTime } from '../contracts/time.js';
import { chapMd5Response } from '../core/md5.js';
import { PPP_CP_CODE } from '../pdu/codecs/ppp.js';
import {
  PPP_INITIAL_AUTOMATON,
  PPP_MAX_FAILURE,
  PPP_RESTART_NS,
  pppFsmApply,
  pppNakBecomesReject,
  pppTimeoutEvent,
  type PppAutomaton,
  type PppFsmEvent,
} from './ppp/fsm.js';
import {
  pppChallengeValue,
  pppInterfaceId,
  pppMagicNumber,
  pppUserPassword,
  readPppPortConfig,
  samePppPortConfig,
  type PppPortConfig,
} from './ppp/config.js';

// ── constants ──────────────────────────────────────────────────────────────────────────────────────────────────────

/** Process name (the W4 flip registers it after `hdlc`). */
export const PPP_PROCESS = 'ppp';
/** Debug category of LCP, IPCP and IPv6CP (`debug ppp negotiation`). */
export const PPP_DEBUG_NEGOTIATION = 'ppp negotiation';
/** Debug category of PAP and CHAP (`debug ppp authentication`). */
export const PPP_DEBUG_AUTHENTICATION = 'ppp authentication';
/** The periodic retry after a failed or finished attempt (§4.2 `ppp-retry:<p>`). */
export const PPP_RETRY_NS: SimTime = 10 * SEC;
/** Interval of CHAP challenge and PAP request retransmissions (§4.2 `chap-retry:<p>`). */
export const PPP_AUTH_RETRY_NS: SimTime = 2 * SEC;
/** Challenges (or PAP requests) sent before the attempt is given up. */
export const PPP_AUTH_MAX_SENDS = 10;
/**
 * Unanswered LCP Echo-Requests before the line is declared down (`keepalive-missed`): the tick that finds four outstanding
 * reports, five keepalive intervals after the last answered echo (§10.1 `accept.p3.ppp-keepalive`, "after 5 intervals").
 */
export const PPP_ECHO_MISSES = 4;
/** Severity of the authentication-failure log (§3.9 step 6). */
export const PPP_LOG_SEVERITY = 5;
/** Facility of PPP logs. */
export const PPP_LOG_FACILITY = 'PPP';
/** Roles whose serial ports run PPP (a router's serial interface; access lines stay HDLC-only, D17). */
export const PPP_ROLES: readonly PortRole[] = Object.freeze(['wan'] as PortRole[]);
/** `PduMeta.tag` of LCP Echo-Requests and Echo-Replies (background traffic). */
export const PPP_ECHO_TAG = 'lcp-echo';

/** Timer key prefixes (§4.2); each key is `<prefix><port>`. */
export const PPP_TIMER = Object.freeze({
  lcpRestart: 'lcp-restart:',
  ipcpRestart: 'ipcp-restart:',
  ipv6cpRestart: 'ipv6cp-restart:',
  echo: 'lcp-echo:',
  retry: 'ppp-retry:',
  chapRetry: 'chap-retry:',
  /** W3 fix (finding 0): the CHAP peer's Response retransmission (2 s, at most 10 sends, not periodic). */
  chapResponse: 'chap-response:',
  papRetry: 'pap-retry:',
});

/** Texts carried in packets and logs (original wording). */
export const PPP_TEXT = Object.freeze({
  chapSuccess: 'authenticated',
  chapMismatch: 'the response does not match',
  papSuccess: 'authenticated',
  papMismatch: 'the user name or password does not match',
  terminateAuth: 'authentication failed',
  terminateNegotiation: 'the link options could not be agreed',
  terminateClose: 'the link is closing',
});

/** The text of a CHAP Failure (and PAP Nak) when no password is configured for the peer's name. */
export function pppNoPasswordText(name: string): string {
  return `no password is configured for ${name}`;
}

/** Wire selectors: the five PPP control protocols on serial WAN ports. */
export const PPP_HANDLES: readonly DemuxSelector[] = Object.freeze(
  [PPP_PROTO.lcp, PPP_PROTO.pap, PPP_PROTO.chap, PPP_PROTO.ipcp, PPP_PROTO.ipv6cp].map((ethertype) =>
    Object.freeze({ layer: 'ppp', ethertype, roles: PPP_ROLES }),
  ),
) as readonly DemuxSelector[];

/** Timer key of `prefix` on `port`. */
export function pppTimerKey(prefix: string, port: PortId): string {
  return `${prefix}${port}`;
}

const DEBUG_RING = 256;

type CpName = 'lcp' | 'ipcp' | 'ipv6cp';
type NcpName = 'ipcp' | 'ipv6cp';
type Auth = 'none' | 'pap' | 'chap';
type AuthState = 'pending' | 'success' | 'failed';

const CP_LABEL: Readonly<Record<CpName, string>> = Object.freeze({ lcp: 'LCP', ipcp: 'IPCP', ipv6cp: 'IPv6CP' });
const RESTART_PREFIX: Readonly<Record<CpName, string>> = Object.freeze({ lcp: PPP_TIMER.lcpRestart, ipcp: PPP_TIMER.ipcpRestart, ipv6cp: PPP_TIMER.ipv6cpRestart });
const CODE_TEXT: Readonly<Record<number, string>> = Object.freeze({
  1: 'configure-request', 2: 'configure-ack', 3: 'configure-nak', 4: 'configure-reject', 5: 'terminate-request', 6: 'terminate-ack',
  7: 'code-reject', 8: 'protocol-reject', 9: 'echo-request', 10: 'echo-reply', 11: 'discard-request',
});
const CHAP_CODE = Object.freeze({ challenge: 1, response: 2, success: 3, failure: 4 });
const PAP_CODE = Object.freeze({ request: 1, ack: 2, nak: 3 });

/** One automaton and its identifiers. */
interface Cp {
  a: PppAutomaton;
  /** The last identifier this end used for a packet it originated. */
  id: number;
  /** The identifier of the outstanding Configure-Request. */
  reqId?: number;
  /** Configure-Naks and Configure-Rejects received in this attempt (the loop guard). */
  naks: number;
}

/** A received control packet (what the reply actions need). */
interface Rx {
  readonly code: number;
  readonly id: number;
  readonly fields: Readonly<Record<string, FieldValue>>;
}

/** PPP state of one serial port. */
interface Line {
  readonly port: PortId;
  cfg: PppPortConfig;
  /** The serial line is ready (the RFC Up of LCP). */
  lowerUp: boolean;
  lcp: Cp;
  ipcp: Cp;
  ipv6cp: Cp;
  magic: number;
  magicRejected: boolean;
  peerMagic?: number;
  /** What our next Configure-Request asks the peer to authenticate with. */
  wantAuth: Auth;
  /** What our outstanding Configure-Request carries. */
  reqAuth: Auth;
  /** What the peer acknowledged of our request (valid from rca). */
  ackedAuth: Auth;
  /** What this end acknowledged of the peer's request. */
  peerAuth: Auth;
  /** Shown and negotiated: what this end requires of the peer. */
  authLocal: Auth;
  /** What the peer requires of this end (negotiated at LCP open). */
  authPeer: Auth;
  authLocalState?: AuthState;
  authPeerState?: AuthState;
  /** The ppp-auth machine's state (undefined before the first authentication). */
  authFsm?: AuthState;
  /** Every authentication of the current LCP open passed (the Network phase). */
  authDone: boolean;
  peerName?: string;
  chapId: number;
  challenge?: Uint8Array;
  chapSends: number;
  /** CHAP peer: the Response last sent (resent unchanged while the verdict is pending). */
  chapResponse?: { readonly id: number; readonly value: Uint8Array };
  /** CHAP peer: Responses sent for the current challenge id. */
  chapResponseSends: number;
  papId: number;
  papSends: number;
  peerAddress?: Ipv4Address;
  peerInterfaceId?: string;
  phase: PppPhase;
  since: SimTime;
  failures: number;
  lastFailure?: string;
  /** This attempt already counted a failure. */
  attemptFailed: boolean;
  /** Why the line protocol is down while not in the Network phase (absent = negotiating). */
  downReason?: 'ppp-auth-failed' | 'keepalive-missed';
  /** The last `ppp-link` state reported ('up' or the down reason; 'ppp-negotiating' = the link model's default). */
  reported: string;
  /** The reason text the next Terminate-Request carries. */
  termReason?: string;
  /**
   * Set while an LCP event is handled when this end rejected the peer's authentication protocol at Max-Failure (the
   * failure text): the attempt is ended once the automaton has applied the event (never inside it).
   */
  authRejected?: string;
  echoArmed: boolean;
  echoOutstanding: number;
  retryArmed: boolean;
  chapArmed: boolean;
  /** CHAP peer: `chap-response:<p>` is armed. */
  chapResponseArmed: boolean;
  papArmed: boolean;
  /** The last row written (its displayed columns), to write only on change. */
  written?: string;
  sent: number;
  received: number;
}

// ── small helpers ──────────────────────────────────────────────────────────────────────────────────────────────────

function roleOf(ctx: ProcessCtx, view: PortView): PortRole {
  return view.role ?? view.spec.role ?? defaultRoleFor(view.spec.kind, ctx.model.capabilities ?? []);
}

function encapOf(view: PortView): PortEncap {
  return view.encap ?? view.spec.encap ?? KIND_ENCAP[view.spec.kind];
}

/** Does this daemon run PPP on `view`? (a serial WAN port whose effective encapsulation is `ppp`) */
function isPppPort(ctx: ProcessCtx, view: PortView | undefined): view is PortView {
  return view !== undefined && view.spec.kind === 'serial' && encapOf(view) === 'ppp' && PPP_ROLES.includes(roleOf(ctx, view));
}

/** The line under a port is ready (carrier, clock, one encapsulation), read from its `phy` (used at `init`). */
function phyReady(view: PortView): boolean {
  const phy = view.phy;
  if (phy?.carrier !== true) return false;
  return phy.lineProtocolReason !== 'no-clock' && phy.lineProtocolReason !== 'encapsulation-mismatch';
}

const authOf = (proto: FieldValue | undefined): Auth => (proto === 'chap-md5' ? 'chap' : proto === 'pap' ? 'pap' : 'none');
const authProtoOf = (a: Auth): string | undefined => (a === 'chap' ? 'chap-md5' : a === 'pap' ? 'pap' : undefined);
const hex32 = (v: number): string => `0x${(v >>> 0).toString(16).padStart(8, '0')}`;
const num = (v: FieldValue | undefined): number | undefined => (typeof v === 'number' ? v : undefined);
const str = (v: FieldValue | undefined): string | undefined => (typeof v === 'string' ? v : undefined);
const nextId = (cp: Cp): number => {
  cp.id = (cp.id + 1) & 0xff;
  return cp.id;
};

/** Equality of two byte arrays. */
function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** The text of a control packet's options, for debug lines. */
function optionText(fields: Readonly<Record<string, FieldValue>>): string {
  const parts: string[] = [];
  if (typeof fields.authProto === 'string') parts.push(`auth ${fields.authProto}`);
  if (typeof fields.magic === 'number') parts.push(`magic ${hex32(fields.magic)}`);
  if (typeof fields.mru === 'number') parts.push(`mru ${fields.mru}`);
  if (typeof fields.ipAddress === 'string') parts.push(`address ${fields.ipAddress}`);
  if (typeof fields.interfaceId === 'string') parts.push(`interface id ${fields.interfaceId}`);
  if (typeof fields.rejected === 'string') parts.push(`rejects ${fields.rejected}`);
  if (typeof fields.reason === 'string' && fields.reason !== '') parts.push(`"${fields.reason}"`);
  return parts.length === 0 ? '' : ` (${parts.join(', ')})`;
}

// ── the daemon ─────────────────────────────────────────────────────────────────────────────────────────────────────

/** Create the PPP daemon (`name: 'ppp'`, `handles: PPP_HANDLES`). One instance per routing device. */
export function createPpp(): Process {
  const lines = new Map<PortId, Line>();
  const ring: DebugEvent[] = [];
  let started = false;
  /** The per-process counter of the FNV derivations (§4.1). */
  let seq = 0;
  /** The peer-route set last offered to ipv4 (keys and ports joined; '' = none). */
  let offered = '';
  let sentTotal = 0;
  let receivedTotal = 0;

  function remember(ev: DebugEvent): void {
    ring.push(ev);
    if (ring.length > DEBUG_RING) ring.splice(0, ring.length - DEBUG_RING);
  }

  function debug(ctx: ProcessCtx, category: string, message: string, data?: Record<string, unknown>): void {
    ctx.debug(category, message, data);
    remember(data ? { at: ctx.now, device: ctx.deviceId, process: PPP_PROCESS, category, message, data } : { at: ctx.now, device: ctx.deviceId, process: PPP_PROCESS, category, message });
  }

  function transition(ctx: ProcessCtx, category: string, message: string, fsm: FsmTransition): void {
    ctx.transition(category, message, fsm);
    remember({ at: ctx.now, device: ctx.deviceId, process: PPP_PROCESS, category, message, data: { fsm }, fsm });
  }

  const table = (ctx: ProcessCtx): Table<PppRow> | undefined => ctx.tables.get<PppRow>('ppp');

  // ── lines ──

  function newLine(ctx: ProcessCtx, port: PortId): Line {
    const cfg = readPppPortConfig(ctx.config, port);
    const line: Line = {
      port, cfg, lowerUp: false,
      lcp: { a: PPP_INITIAL_AUTOMATON, id: 0, naks: 0 },
      ipcp: { a: PPP_INITIAL_AUTOMATON, id: 0, naks: 0 },
      ipv6cp: { a: PPP_INITIAL_AUTOMATON, id: 0, naks: 0 },
      magic: pppMagicNumber(ctx.deviceId, port, seq++), magicRejected: false,
      wantAuth: cfg.auth[0] ?? 'none', reqAuth: 'none', ackedAuth: 'none', peerAuth: 'none',
      authLocal: cfg.auth[0] ?? 'none', authPeer: 'none', authDone: false,
      chapId: 0, chapSends: 0, chapResponseSends: 0, papId: 0, papSends: 0,
      phase: 'dead', since: ctx.now, failures: 0, attemptFailed: false, reported: 'ppp-negotiating',
      echoArmed: false, echoOutstanding: 0, retryArmed: false, chapArmed: false, chapResponseArmed: false, papArmed: false,
      sent: 0, received: 0,
    };
    lines.set(port, line);
    return line;
  }

  /** A port became PPP: its row, LCP Opened administratively (Initial → Starting), its NCPs Opened when enabled. */
  function adopt(ctx: ProcessCtx, port: PortId, out: Action[]): Line {
    const line = newLine(ctx, port);
    debug(ctx, PPP_DEBUG_NEGOTIATION, `${port}: PPP runs on this interface`, { port });
    drive(ctx, line, 'lcp', 'open', 'PPP is configured on the interface', out);
    for (const n of ['ipcp', 'ipv6cp'] as const) if (ncpEnabled(line, n)) drive(ctx, line, n, 'open', 'the protocol is configured on the interface', out);
    return line;
  }

  /** A port left PPP: every timer cancelled, the row removed, nothing sent. */
  function release(ctx: ProcessCtx, line: Line, out: Action[]): void {
    for (const prefix of Object.values(PPP_TIMER)) out.push({ type: 'cancelTimer', key: pppTimerKey(prefix, line.port) });
    lines.delete(line.port);
    table(ctx)?.delete(line.port, 'cleared');
    debug(ctx, PPP_DEBUG_NEGOTIATION, `${line.port}: PPP no longer runs on this interface`, { port: line.port });
  }

  const ncpEnabled = (line: Line, n: NcpName): boolean => (n === 'ipcp' ? line.cfg.ipv4 !== undefined : line.cfg.ipv6);
  const lcpOpened = (line: Line): boolean => line.lcp.a.state === 'opened';
  const inNetwork = (line: Line): boolean => lcpOpened(line) && line.authDone;

  /** A fresh LCP attempt: new magic number, our authentication preference, counters reset. */
  function beginAttempt(ctx: ProcessCtx, line: Line): void {
    line.magic = pppMagicNumber(ctx.deviceId, line.port, seq++);
    line.magicRejected = false;
    line.wantAuth = line.cfg.auth[0] ?? 'none';
    line.reqAuth = 'none';
    line.ackedAuth = 'none';
    line.peerAuth = 'none';
    line.lcp.naks = 0;
    line.attemptFailed = false;
    line.authDone = false;
    abandonPendingAuth(line);
  }

  // ── sending ──

  function send(ctx: ProcessCtx, line: Line, proto: CpName | 'pap' | 'chap', fields: Record<string, FieldValue>, out: Action[], meta?: Partial<PduMeta>): Pdu {
    const pdu = ctx.newPdu(
      [
        { proto: 'ppp', fields: { address: PPP_ADDRESS, control: PPP_CONTROL, protocol: PPP_PROTO[proto] } },
        { proto, fields },
      ],
      meta ?? { tag: proto },
    );
    line.sent++;
    sentTotal++;
    out.push({ type: 'send', port: line.port, pdu });
    return pdu;
  }

  function sendCp(ctx: ProcessCtx, line: Line, cp: CpName, fields: Record<string, FieldValue>, out: Action[], meta?: Partial<PduMeta>): void {
    const pdu = send(ctx, line, cp, fields, out, meta);
    const code = num(fields.code) ?? 0;
    const msg = `${line.port} ${CP_LABEL[cp]}: sent ${CODE_TEXT[code] ?? `code ${code}`} id ${String(fields.id)}${optionText(fields)}`;
    debug(ctx, PPP_DEBUG_NEGOTIATION, msg, { port: line.port, pdu: pdu.id, protocol: cp, code, id: fields.id });
  }

  function sendConfReq(ctx: ProcessCtx, line: Line, cp: CpName, out: Action[]): void {
    const c = line[cp];
    const id = nextId(c);
    c.reqId = id;
    const fields: Record<string, FieldValue> = { code: PPP_CP_CODE.configureRequest, id };
    if (cp === 'lcp') {
      line.reqAuth = line.wantAuth;
      const proto = authProtoOf(line.wantAuth);
      if (proto !== undefined) fields.authProto = proto;
      if (!line.magicRejected) fields.magic = line.magic;
    } else if (cp === 'ipcp') {
      if (line.cfg.ipv4 !== undefined) fields.ipAddress = line.cfg.ipv4;
    } else {
      fields.interfaceId = pppInterfaceId(ctx.macOf(line.port), line.cfg.linkLocal);
    }
    sendCp(ctx, line, cp, fields, out);
  }

  /** The options of a received configure packet that a reply echoes (RFC 1661 §5.2: an Ack repeats them). */
  function echoedOptions(cp: CpName, rx: Rx): Record<string, FieldValue> {
    const out: Record<string, FieldValue> = {};
    const keys = cp === 'lcp' ? ['mru', 'authProto', 'magic'] : cp === 'ipcp' ? ['ipAddress'] : ['interfaceId'];
    for (const k of keys) {
      const v = rx.fields[k];
      if (v !== undefined && v !== null) out[k] = v;
    }
    return out;
  }

  function sendConfAck(ctx: ProcessCtx, line: Line, cp: CpName, rx: Rx | undefined, out: Action[]): void {
    if (rx === undefined) return;
    const opts = echoedOptions(cp, rx);
    if (cp === 'lcp') {
      line.peerAuth = authOf(rx.fields.authProto);
      const magic = num(rx.fields.magic);
      if (magic !== undefined) line.peerMagic = magic;
    } else if (cp === 'ipcp') {
      const a = str(rx.fields.ipAddress);
      if (a !== undefined && a !== '0.0.0.0') line.peerAddress = a;
      else delete line.peerAddress;
    } else {
      const id = str(rx.fields.interfaceId);
      if (id !== undefined) line.peerInterfaceId = id;
      else delete line.peerInterfaceId;
    }
    sendCp(ctx, line, cp, { code: PPP_CP_CODE.configureAck, id: rx.id, ...opts }, out);
  }

  function sendConfNak(ctx: ProcessCtx, line: Line, cp: CpName, rx: Rx | undefined, out: Action[]): void {
    if (rx === undefined) return;
    // only LCP ever finds a request unacceptable here: an authentication protocol this end cannot answer
    if (cp !== 'lcp') {
      debug(ctx, PPP_DEBUG_NEGOTIATION, `${line.port} ${CP_LABEL[cp]}: nothing to nak in request id ${rx.id}`, { port: line.port, id: rx.id });
      return;
    }
    // RFC 1661 §4.6: once Max-Failure Naks went out without a Configure-Ack in between, the option is rejected instead
    // (the automaton already counted this one, so the Naks sent before it are `failures - 1`); this end then gives up
    // the attempt (`authRejected`, acted on after the event)
    const asked = rx.fields.authProto;
    if (pppNakBecomesReject({ ...line.lcp.a, failures: line.lcp.a.failures - 1 })) {
      const text = asked === 'pap' ? 'the peer asks for PAP, and no ppp pap sent-username is configured here' : `the peer asks for authentication by ${String(asked)}`;
      if (asked === 'pap' || asked === 'chap-md5') sendCp(ctx, line, cp, { code: PPP_CP_CODE.configureReject, id: rx.id, rejected: 'auth-proto', authProto: asked }, out);
      line.authRejected = text;
      return;
    }
    // this end always answers CHAP (§5.7 `username <peer> password`), so that is what it suggests
    sendCp(ctx, line, cp, { code: PPP_CP_CODE.configureNak, id: rx.id, authProto: 'chap-md5' }, out);
  }

  function sendTermReq(ctx: ProcessCtx, line: Line, cp: CpName, out: Action[]): void {
    const fields: Record<string, FieldValue> = { code: PPP_CP_CODE.terminateRequest, id: nextId(line[cp]) };
    if (cp === 'lcp') fields.reason = line.termReason ?? PPP_TEXT.terminateClose;
    sendCp(ctx, line, cp, fields, out);
  }

  function sendTermAck(ctx: ProcessCtx, line: Line, cp: CpName, rx: Rx | undefined, out: Action[]): void {
    sendCp(ctx, line, cp, { code: PPP_CP_CODE.terminateAck, id: rx?.id ?? nextId(line[cp]) }, out);
  }

  // ── the automata ──

  /** Apply `event` to the `cp` automaton of `line` and perform its actions (RFC 1661 §4). */
  function drive(ctx: ProcessCtx, line: Line, cp: CpName, event: PppFsmEvent, why: string, out: Action[], rx?: Rx): void {
    const c = line[cp];
    const r = pppFsmApply(c.a, event);
    if (r.illegal) {
      debug(ctx, PPP_DEBUG_NEGOTIATION, `${line.port} ${CP_LABEL[cp]}: ${event} is ignored in state ${c.a.state}`, { port: line.port, protocol: cp, event, state: c.a.state });
      return;
    }
    c.a = r.automaton;
    if (r.actions.includes('irc')) c.naks = 0;
    const to = r.automaton.state;
    if (to !== r.from) {
      const fsm: FsmTransition =
        cp === 'lcp'
          ? { machine: 'ppp-lcp', subject: line.port, port: line.port, from: r.from, to, cause: why }
          : { machine: 'ppp-ncp', subject: `${line.port} ${CP_LABEL[cp]}`, port: line.port, from: r.from, to, cause: why };
      transition(ctx, PPP_DEBUG_NEGOTIATION, `${line.port} ${CP_LABEL[cp]}: ${r.from} -> ${to} (${why})`, fsm);
    }
    for (const act of r.actions) {
      switch (act) {
        case 'tlu':
          if (cp === 'lcp') lcpUp(ctx, line, out);
          else ncpUp(ctx, line, cp, out);
          break;
        case 'tld':
          if (cp === 'lcp') lcpDown(ctx, line, why, out);
          else ncpDown(ctx, line, cp);
          break;
        case 'tlf':
          if (cp === 'lcp') lcpFinished(ctx, line, out);
          else debug(ctx, PPP_DEBUG_NEGOTIATION, `${line.port} ${CP_LABEL[cp]}: finished`, { port: line.port, protocol: cp });
          break;
        case 'scr':
          sendConfReq(ctx, line, cp, out);
          break;
        case 'sca':
          sendConfAck(ctx, line, cp, rx, out);
          break;
        case 'scn':
          sendConfNak(ctx, line, cp, rx, out);
          break;
        case 'str':
          sendTermReq(ctx, line, cp, out);
          break;
        case 'sta':
          sendTermAck(ctx, line, cp, rx, out);
          break;
        case 'scj':
          sendCp(ctx, line, cp, { code: PPP_CP_CODE.codeReject, id: nextId(c) }, out);
          break;
        case 'ser':
          if (cp === 'lcp' && rx?.code === PPP_CP_CODE.echoRequest) {
            sendCp(ctx, line, 'lcp', { code: PPP_CP_CODE.echoReply, id: rx.id, echoMagic: line.magic }, out, { tag: PPP_ECHO_TAG, background: true });
          }
          break;
        default:
          break;
      }
    }
    // the restart timer, after the packets of this event
    const key = pppTimerKey(RESTART_PREFIX[cp], line.port);
    if (r.timer === 'start') out.push({ type: 'timer', key, delay: PPP_RESTART_NS });
    else if (r.timer === 'stop' && r.from !== to) out.push({ type: 'cancelTimer', key });
  }

  /** The RFC restart option: Down, then Up (a fresh attempt). Used by the retry, renegotiations and echo failures. */
  function restart(ctx: ProcessCtx, line: Line, why: string, out: Action[]): void {
    const s = line.lcp.a.state;
    if (s !== 'initial' && s !== 'starting') drive(ctx, line, 'lcp', 'down', why, out);
    if (line.lcp.a.state === 'initial') drive(ctx, line, 'lcp', 'open', why, out);
    beginAttempt(ctx, line);
    drive(ctx, line, 'lcp', 'up', why, out);
  }

  // ── LCP layer events ──

  function lcpUp(ctx: ProcessCtx, line: Line, out: Action[]): void {
    cancelRetry(line, out);
    line.authLocal = line.ackedAuth;
    line.authPeer = line.peerAuth;
    line.authDone = false;
    debug(ctx, PPP_DEBUG_NEGOTIATION, `${line.port} LCP: the link is open (this end requires ${line.authLocal}, the peer requires ${line.authPeer})`, {
      port: line.port, authLocal: line.authLocal, authPeer: line.authPeer, magic: line.magic, peerMagic: line.peerMagic ?? null,
    });
    startEcho(line, out);
    if (line.authLocal === 'none' && line.authPeer === 'none') {
      delete line.authLocalState;
      delete line.authPeerState;
      enterNetwork(ctx, line, out);
      return;
    }
    if (line.authLocal !== 'none') line.authLocalState = 'pending';
    else delete line.authLocalState;
    if (line.authPeer !== 'none') line.authPeerState = 'pending';
    else delete line.authPeerState;
    authMachine(ctx, line, 'pending', 'the link is open; authentication starts');
    if (line.authLocal === 'chap') {
      line.chapId = (line.chapId + 1) & 0xff;
      line.challenge = pppChallengeValue(ctx.deviceId, line.port, seq++);
      line.chapSends = 0;
      sendChallenge(ctx, line, out);
    }
    if (line.authPeer === 'pap') {
      line.papSends = 0;
      sendPapRequest(ctx, line, out);
    }
  }

  function lcpDown(ctx: ProcessCtx, line: Line, why: string, out: Action[]): void {
    stopEcho(line, out);
    stopAuthTimers(line, out);
    line.authDone = false;
    for (const n of ['ipcp', 'ipv6cp'] as const) ncpLowerDown(ctx, line, n, why, out);
    debug(ctx, PPP_DEBUG_NEGOTIATION, `${line.port} LCP: the link is no longer open (${why})`, { port: line.port });
  }

  /** An authentication still pending when the attempt ends is abandoned (a result, success or failure, stays shown). */
  function abandonPendingAuth(line: Line): void {
    if (line.authLocalState === 'pending') delete line.authLocalState;
    if (line.authPeerState === 'pending') delete line.authPeerState;
  }

  function lcpFinished(ctx: ProcessCtx, line: Line, out: Action[]): void {
    abandonPendingAuth(line);
    debug(ctx, PPP_DEBUG_NEGOTIATION, `${line.port} LCP: finished`, { port: line.port });
    const s = line.lcp.a.state;
    if (line.lowerUp && (s === 'stopped' || s === 'closed') && !line.retryArmed) {
      line.retryArmed = true;
      out.push({ type: 'timer', key: pppTimerKey(PPP_TIMER.retry, line.port), delay: PPP_RETRY_NS, periodic: true });
      debug(ctx, PPP_DEBUG_NEGOTIATION, `${line.port}: trying again in ${PPP_RETRY_NS / SEC} s`, { port: line.port });
    }
  }

  function enterNetwork(ctx: ProcessCtx, line: Line, out: Action[]): void {
    line.authDone = true;
    delete line.downReason;
    line.attemptFailed = false;
    debug(ctx, PPP_DEBUG_NEGOTIATION, `${line.port}: network phase`, { port: line.port });
    for (const n of ['ipcp', 'ipv6cp'] as const) {
      if (!ncpEnabled(line, n)) continue;
      if (line[n].a.state === 'initial') drive(ctx, line, n, 'open', 'the protocol is configured on the interface', out);
      if (line[n].a.state === 'starting') drive(ctx, line, n, 'up', 'the network phase began', out);
    }
  }

  // ── NCP layer events ──

  function ncpUp(ctx: ProcessCtx, line: Line, n: NcpName, _out: Action[]): void {
    const peer = n === 'ipcp' ? line.peerAddress : line.peerInterfaceId;
    debug(ctx, PPP_DEBUG_NEGOTIATION, `${line.port} ${CP_LABEL[n]}: open${peer === undefined ? '' : `, peer ${peer}`}`, { port: line.port, protocol: n, peer: peer ?? null });
  }

  function ncpDown(ctx: ProcessCtx, line: Line, n: NcpName): void {
    if (n === 'ipcp') delete line.peerAddress;
    else delete line.peerInterfaceId;
    debug(ctx, PPP_DEBUG_NEGOTIATION, `${line.port} ${CP_LABEL[n]}: no longer open`, { port: line.port, protocol: n });
  }

  /** LCP left Opened (or the line went down): the NCP's Down, then its Open again when it is still enabled. */
  function ncpLowerDown(ctx: ProcessCtx, line: Line, n: NcpName, why: string, out: Action[]): void {
    const s = line[n].a.state;
    if (s !== 'initial' && s !== 'starting') drive(ctx, line, n, 'down', why, out);
    if (line[n].a.state === 'initial' && ncpEnabled(line, n)) drive(ctx, line, n, 'open', 'the protocol is configured on the interface', out);
    if (n === 'ipcp') delete line.peerAddress;
    else delete line.peerInterfaceId;
  }

  function ncpEnable(ctx: ProcessCtx, line: Line, n: NcpName, out: Action[]): void {
    const s = line[n].a.state;
    if (s === 'initial' || s === 'closed' || s === 'closing' || s === 'stopped') drive(ctx, line, n, 'open', 'the protocol is configured on the interface', out);
    if (inNetwork(line) && line[n].a.state === 'starting') drive(ctx, line, n, 'up', 'the network phase is on', out);
  }

  function ncpDisable(ctx: ProcessCtx, line: Line, n: NcpName, out: Action[]): void {
    const s = line[n].a.state;
    if (s === 'initial' || s === 'closed') return;
    drive(ctx, line, n, 'close', 'the protocol was removed from the interface', out);
  }

  /** The NCP's own address changed while it runs: Down, then Up (it asks again). */
  function ncpRenegotiate(ctx: ProcessCtx, line: Line, n: NcpName, out: Action[]): void {
    if (!inNetwork(line)) return;
    const s = line[n].a.state;
    if (s !== 'initial' && s !== 'starting') drive(ctx, line, n, 'down', 'the address changed', out);
    if (line[n].a.state === 'initial') drive(ctx, line, n, 'open', 'the address changed', out);
    if (line[n].a.state === 'starting') drive(ctx, line, n, 'up', 'the address changed', out);
  }

  // ── authentication ──

  function authMachine(ctx: ProcessCtx, line: Line, to: AuthState, why: string): void {
    const from = line.authFsm;
    line.authFsm = to;
    if (from === undefined || from === to) {
      debug(ctx, PPP_DEBUG_AUTHENTICATION, `${line.port}: authentication ${to} (${why})`, { port: line.port, state: to });
      return;
    }
    transition(ctx, PPP_DEBUG_AUTHENTICATION, `${line.port}: authentication ${from} -> ${to} (${why})`, {
      machine: 'ppp-auth', subject: line.port, port: line.port, from, to, cause: why,
    });
  }

  function sendChallenge(ctx: ProcessCtx, line: Line, out: Action[]): void {
    if (line.challenge === undefined) return;
    line.chapSends++;
    const pdu = send(ctx, line, 'chap', { code: CHAP_CODE.challenge, id: line.chapId, value: line.challenge, name: ctx.hostname }, out);
    debug(ctx, PPP_DEBUG_AUTHENTICATION, `${line.port} CHAP: sent challenge id ${line.chapId} as ${ctx.hostname}`, { port: line.port, pdu: pdu.id, id: line.chapId, sends: line.chapSends });
    line.chapArmed = true;
    out.push({ type: 'timer', key: pppTimerKey(PPP_TIMER.chapRetry, line.port), delay: PPP_AUTH_RETRY_NS });
  }

  function sendPapRequest(ctx: ProcessCtx, line: Line, out: Action[]): void {
    line.papSends++;
    line.papId = (line.papId + 1) & 0xff;
    const peerId = line.cfg.papUser ?? ctx.hostname;
    const pdu = send(ctx, line, 'pap', { code: PAP_CODE.request, id: line.papId, peerId, password: line.cfg.papPassword ?? '' }, out);
    debug(ctx, PPP_DEBUG_AUTHENTICATION, `${line.port} PAP: sent authenticate-request id ${line.papId} as ${peerId}`, { port: line.port, pdu: pdu.id, id: line.papId, sends: line.papSends });
    line.papArmed = true;
    out.push({ type: 'timer', key: pppTimerKey(PPP_TIMER.papRetry, line.port), delay: PPP_AUTH_RETRY_NS });
  }

  /** CHAP peer: (re)send the stored Response and arm its retransmission (`chap-response:<p>`, W3 fix). */
  function sendChapResponse(ctx: ProcessCtx, line: Line, out: Action[]): Pdu | undefined {
    const r = line.chapResponse;
    if (r === undefined) return undefined;
    line.chapResponseSends++;
    const sent = send(ctx, line, 'chap', { code: CHAP_CODE.response, id: r.id, value: r.value, name: ctx.hostname }, out);
    line.chapResponseArmed = true;
    out.push({ type: 'timer', key: pppTimerKey(PPP_TIMER.chapResponse, line.port), delay: PPP_AUTH_RETRY_NS });
    return sent;
  }

  /** CHAP peer: stop resending the Response (a verdict arrived, or the attempt ended). */
  function stopChapResponse(line: Line, out: Action[]): void {
    if (!line.chapResponseArmed) return;
    line.chapResponseArmed = false;
    out.push({ type: 'cancelTimer', key: pppTimerKey(PPP_TIMER.chapResponse, line.port) });
  }

  function stopAuthTimers(line: Line, out: Action[]): void {
    if (line.chapArmed) {
      line.chapArmed = false;
      out.push({ type: 'cancelTimer', key: pppTimerKey(PPP_TIMER.chapRetry, line.port) });
    }
    stopChapResponse(line, out);
    if (line.papArmed) {
      line.papArmed = false;
      out.push({ type: 'cancelTimer', key: pppTimerKey(PPP_TIMER.papRetry, line.port) });
    }
  }

  /** Count one failure per attempt; `lastFailure` keeps the attempt's first (most telling) reason. */
  function countFailure(line: Line, text: string): void {
    if (line.attemptFailed) return;
    line.attemptFailed = true;
    line.failures++;
    line.lastFailure = text;
  }

  /** Both directions passed? Then the Network phase. */
  function checkAuthDone(ctx: ProcessCtx, line: Line, out: Action[]): void {
    const local = line.authLocal === 'none' || line.authLocalState === 'success';
    const peer = line.authPeer === 'none' || line.authPeerState === 'success';
    if (!local || !peer || !lcpOpened(line)) return;
    authMachine(ctx, line, 'success', 'every authentication passed');
    enterNetwork(ctx, line, out);
  }

  /** This end refused the peer (or gave up on it): log, and end the attempt (RXJ−: Terminate-Request, then Stopped). */
  function localAuthFailed(ctx: ProcessCtx, line: Line, proto: 'CHAP' | 'PAP', peer: string, reason: string, out: Action[]): void {
    line.authLocalState = 'failed';
    if (line.chapArmed) {
      line.chapArmed = false;
      out.push({ type: 'cancelTimer', key: pppTimerKey(PPP_TIMER.chapRetry, line.port) });
    }
    out.push({ type: 'log', severity: PPP_LOG_SEVERITY, facility: PPP_LOG_FACILITY, message: `${line.port}: ${proto} authentication of ${peer} failed: ${reason}` });
    authMachine(ctx, line, 'failed', `${proto}: ${reason}`);
    endAttempt(ctx, line, `${proto} authentication of ${peer} failed: ${reason}`, true, out);
  }

  /** The peer refused this end: remember it and wait for the peer's Terminate-Request. */
  function peerAuthFailed(ctx: ProcessCtx, line: Line, proto: 'CHAP' | 'PAP', message: string, out: Action[]): void {
    line.authPeerState = 'failed';
    if (line.papArmed) {
      line.papArmed = false;
      out.push({ type: 'cancelTimer', key: pppTimerKey(PPP_TIMER.papRetry, line.port) });
    }
    countFailure(line, `the peer refused this end's ${proto} credentials${message === '' ? '' : `: ${message}`}`);
    line.downReason = 'ppp-auth-failed';
    authMachine(ctx, line, 'failed', `${proto}: the peer refused this end${message === '' ? '' : ` (${message})`}`);
  }

  /** End the attempt: LCP's RXJ− (Opened → Stopping: Terminate-Request; Req-Sent and others → Stopped). */
  function endAttempt(ctx: ProcessCtx, line: Line, text: string, auth: boolean, out: Action[]): void {
    countFailure(line, text);
    if (auth) line.downReason = 'ppp-auth-failed';
    line.termReason = auth ? PPP_TEXT.terminateAuth : PPP_TEXT.terminateNegotiation;
    drive(ctx, line, 'lcp', 'rxj-', auth ? PPP_TEXT.terminateAuth : text, out);
  }

  // ── echo and retry timers ──

  function startEcho(line: Line, out: Action[]): void {
    line.echoOutstanding = 0;
    if (line.cfg.keepaliveNs <= 0) return;
    line.echoArmed = true;
    out.push({ type: 'timer', key: pppTimerKey(PPP_TIMER.echo, line.port), delay: line.cfg.keepaliveNs, periodic: true });
  }

  function stopEcho(line: Line, out: Action[]): void {
    line.echoOutstanding = 0;
    if (!line.echoArmed) return;
    line.echoArmed = false;
    out.push({ type: 'cancelTimer', key: pppTimerKey(PPP_TIMER.echo, line.port) });
  }

  function cancelRetry(line: Line, out: Action[]): void {
    if (!line.retryArmed) return;
    line.retryArmed = false;
    out.push({ type: 'cancelTimer', key: pppTimerKey(PPP_TIMER.retry, line.port) });
  }

  function echoTick(ctx: ProcessCtx, line: Line, out: Action[]): void {
    if (!line.echoArmed || !lcpOpened(line)) {
      line.echoArmed = false;
      return;
    }
    if (line.echoOutstanding >= PPP_ECHO_MISSES) {
      line.echoArmed = false;
      countFailure(line, `${PPP_ECHO_MISSES} LCP echo requests went unanswered`);
      line.downReason = 'keepalive-missed';
      debug(ctx, PPP_DEBUG_NEGOTIATION, `${line.port} LCP: ${PPP_ECHO_MISSES} echo requests went unanswered; negotiating again`, { port: line.port });
      restart(ctx, line, 'LCP echoes went unanswered', out);
      return;
    }
    line.echoOutstanding++;
    sendCp(ctx, line, 'lcp', { code: PPP_CP_CODE.echoRequest, id: nextId(line.lcp), echoMagic: line.magic }, out, { tag: PPP_ECHO_TAG, background: true });
    out.push({ type: 'timer', key: pppTimerKey(PPP_TIMER.echo, line.port), delay: line.cfg.keepaliveNs, periodic: true });
  }

  // ── receiving ──

  function receiveLcp(ctx: ProcessCtx, line: Line, rx: Rx, out: Action[]): void {
    const f = rx.fields;
    const c = line.lcp;
    switch (rx.code) {
      case PPP_CP_CODE.configureRequest: {
        // the peer restarts a finished link: a fresh attempt here too
        if (c.a.state === 'stopped') beginAttempt(ctx, line);
        const proto = f.authProto;
        // CHAP is always answered; PAP only with `ppp pap sent-username` on this port (the WAN map's PAP row)
        const acceptable = proto === undefined || proto === null || proto === 'chap-md5' || (proto === 'pap' && line.cfg.papUser !== undefined);
        const why = acceptable
          ? 'received an acceptable configure-request'
          : proto === 'pap'
            ? 'the peer asked for PAP, and no ppp pap sent-username is configured'
            : `the peer asked for authentication by ${String(proto)}`;
        delete line.authRejected;
        drive(ctx, line, 'lcp', acceptable ? 'rcr+' : 'rcr-', why, out, rx);
        const rejected = line.authRejected;
        if (rejected !== undefined) {
          delete line.authRejected;
          debug(ctx, PPP_DEBUG_NEGOTIATION, `${line.port} LCP: ${PPP_MAX_FAILURE} naks went unheeded; rejected the authentication option and stopped`, { port: line.port });
          endAttempt(ctx, line, rejected, true, out);
        }
        return;
      }
      case PPP_CP_CODE.configureAck:
        if (rx.id !== c.reqId) {
          debug(ctx, PPP_DEBUG_NEGOTIATION, `${line.port} LCP: configure-ack id ${rx.id} does not answer request ${String(c.reqId)}; ignored`, { port: line.port, id: rx.id });
          return;
        }
        line.ackedAuth = line.reqAuth;
        drive(ctx, line, 'lcp', 'rca', 'the peer acknowledged our request', out, rx);
        return;
      case PPP_CP_CODE.configureNak:
      case PPP_CP_CODE.configureReject: {
        if (rx.id !== c.reqId) {
          debug(ctx, PPP_DEBUG_NEGOTIATION, `${line.port} LCP: ${CODE_TEXT[rx.code]} id ${rx.id} does not answer request ${String(c.reqId)}; ignored`, { port: line.port, id: rx.id });
          return;
        }
        c.naks++;
        const nak = rx.code === PPP_CP_CODE.configureNak;
        const rejected = nak ? [] : (str(f.rejected) ?? '').split(',').map((x) => x.trim());
        if (nak && f.authProto !== undefined && f.authProto !== null) {
          const asked = authOf(f.authProto);
          if (asked !== 'none' && line.cfg.auth.includes(asked)) line.wantAuth = asked;
          else {
            // a protocol this end does not accept: ask again for ours (the peer rejects it at its Max-Failure, and that
            // Reject ends the attempt below)
            debug(ctx, PPP_DEBUG_NEGOTIATION, `${line.port} LCP: the peer suggests ${String(f.authProto)}, which this end does not accept; asking again for ${authProtoOf(line.wantAuth) ?? 'no authentication'}`, {
              port: line.port, id: rx.id,
            });
          }
        }
        if (nak && num(f.magic) !== undefined) line.magic = pppMagicNumber(ctx.deviceId, line.port, seq++);
        if (rejected.includes('auth-proto') && line.wantAuth !== 'none') {
          endAttempt(ctx, line, 'the peer refuses to authenticate', true, out);
          return;
        }
        if (rejected.includes('magic')) line.magicRejected = true;
        if (c.naks > PPP_MAX_FAILURE) {
          endAttempt(ctx, line, PPP_TEXT.terminateNegotiation, false, out);
          return;
        }
        drive(ctx, line, 'lcp', 'rcn', nak ? 'the peer asked for other options' : 'the peer rejected an option', out, rx);
        return;
      }
      case PPP_CP_CODE.terminateRequest:
        drive(ctx, line, 'lcp', 'rtr', `the peer is closing the link${str(f.reason) ? `: ${str(f.reason)}` : ''}`, out, rx);
        return;
      case PPP_CP_CODE.terminateAck:
        drive(ctx, line, 'lcp', 'rta', 'the peer acknowledged the end of the link', out, rx);
        return;
      case PPP_CP_CODE.codeReject:
        drive(ctx, line, 'lcp', 'rxj+', 'the peer rejected a code', out, rx);
        return;
      case PPP_CP_CODE.protocolReject: {
        const rejected = Number(str(f.rejected) ?? 'NaN');
        if (rejected === PPP_PROTO.ipcp || rejected === PPP_PROTO.ipv6cp) {
          const n: NcpName = rejected === PPP_PROTO.ipcp ? 'ipcp' : 'ipv6cp';
          drive(ctx, line, n, 'rxj-', `the peer does not run ${CP_LABEL[n]}`, out, rx);
        } else if (rejected === PPP_PROTO.chap || rejected === PPP_PROTO.pap) {
          endAttempt(ctx, line, 'the peer does not run the authentication protocol', true, out);
        } else {
          drive(ctx, line, 'lcp', 'rxj+', `the peer rejected protocol ${str(f.rejected) ?? '?'}`, out, rx);
        }
        return;
      }
      case PPP_CP_CODE.echoRequest:
      case PPP_CP_CODE.echoReply:
      case PPP_CP_CODE.discardRequest:
        if (rx.code === PPP_CP_CODE.echoReply) line.echoOutstanding = 0;
        drive(ctx, line, 'lcp', 'rxr', `received ${CODE_TEXT[rx.code]}`, out, rx);
        return;
      default:
        drive(ctx, line, 'lcp', 'ruc', `received an unknown code ${rx.code}`, out, rx);
    }
  }

  function receiveNcp(ctx: ProcessCtx, line: Line, n: NcpName, rx: Rx, pdu: Pdu, out: Action[]): boolean {
    if (!inNetwork(line)) {
      out.push({ type: 'drop', pdu, reason: 'other', detail: `${CP_LABEL[n]} packet before the network phase`, port: line.port });
      return false;
    }
    if (!ncpEnabled(line, n) && (line[n].a.state === 'initial' || line[n].a.state === 'closed')) {
      // this port does not run the protocol: LCP Protocol-Reject (RFC 1661 §5.7)
      sendCp(ctx, line, 'lcp', { code: PPP_CP_CODE.protocolReject, id: nextId(line.lcp), rejected: `0x${PPP_PROTO[n].toString(16).padStart(4, '0')}` }, out);
      return true;
    }
    const c = line[n];
    switch (rx.code) {
      case PPP_CP_CODE.configureRequest:
        drive(ctx, line, n, 'rcr+', 'received a configure-request', out, rx);
        return true;
      case PPP_CP_CODE.configureAck:
        if (rx.id !== c.reqId) {
          debug(ctx, PPP_DEBUG_NEGOTIATION, `${line.port} ${CP_LABEL[n]}: configure-ack id ${rx.id} does not answer request ${String(c.reqId)}; ignored`, { port: line.port, id: rx.id });
          return true;
        }
        drive(ctx, line, n, 'rca', 'the peer acknowledged our request', out, rx);
        return true;
      case PPP_CP_CODE.configureNak:
      case PPP_CP_CODE.configureReject:
        if (rx.id !== c.reqId) return true;
        c.naks++;
        if (c.naks > PPP_MAX_FAILURE) {
          drive(ctx, line, n, 'close', `${CP_LABEL[n]} options could not be agreed`, out, rx);
          return true;
        }
        drive(ctx, line, n, 'rcn', 'the peer asked for other options', out, rx);
        return true;
      case PPP_CP_CODE.terminateRequest:
        drive(ctx, line, n, 'rtr', 'the peer is closing the protocol', out, rx);
        return true;
      case PPP_CP_CODE.terminateAck:
        drive(ctx, line, n, 'rta', 'the peer acknowledged the end of the protocol', out, rx);
        return true;
      case PPP_CP_CODE.codeReject:
        drive(ctx, line, n, 'rxj+', 'the peer rejected a code', out, rx);
        return true;
      default:
        drive(ctx, line, n, 'ruc', `received an unknown code ${rx.code}`, out, rx);
        return true;
    }
  }

  function receiveChap(ctx: ProcessCtx, line: Line, rx: Rx, pdu: Pdu, out: Action[]): boolean {
    const f = rx.fields;
    const name = str(f.name) ?? '';
    switch (rx.code) {
      case CHAP_CODE.challenge: {
        if (!lcpOpened(line) || line.authPeer !== 'chap') {
          out.push({ type: 'drop', pdu, reason: 'other', detail: 'CHAP challenge outside the authentication phase', port: line.port });
          return false;
        }
        line.peerName = name;
        const password = pppUserPassword(ctx.config, name);
        if (password === undefined) {
          debug(ctx, PPP_DEBUG_AUTHENTICATION, `${line.port} CHAP: challenge id ${rx.id} from ${name}: ${pppNoPasswordText(name)}; no response`, { port: line.port, id: rx.id, name });
          return true;
        }
        const value = f.value instanceof Uint8Array ? f.value : new Uint8Array(0);
        const response = chapMd5Response(rx.id, password, value);
        // W3 fix: keep the Response and resend it until a verdict arrives; a new challenge id starts the count again
        if (line.chapResponse === undefined || line.chapResponse.id !== rx.id) line.chapResponseSends = 0;
        line.chapResponse = { id: rx.id, value: response };
        const sent = sendChapResponse(ctx, line, out);
        debug(ctx, PPP_DEBUG_AUTHENTICATION, `${line.port} CHAP: answered challenge id ${rx.id} from ${name} as ${ctx.hostname}`, { port: line.port, pdu: sent?.id, id: rx.id, name });
        return true;
      }
      case CHAP_CODE.response: {
        // W3 fix (RFC 1994 §4.2): a repeated Response to the challenge this end already accepted means the peer lost
        // the Success: answer it with Success again, with no state change (as the PAP Ack resend does)
        if (lcpOpened(line) && line.authLocal === 'chap' && line.authLocalState === 'success' && rx.id === line.chapId && line.challenge !== undefined) {
          const pw = pppUserPassword(ctx.config, name);
          const got = f.value instanceof Uint8Array ? f.value : new Uint8Array(0);
          if (pw !== undefined && sameBytes(chapMd5Response(rx.id, pw, line.challenge), got)) {
            send(ctx, line, 'chap', { code: CHAP_CODE.success, id: rx.id, message: PPP_TEXT.chapSuccess }, out);
            debug(ctx, PPP_DEBUG_AUTHENTICATION, `${line.port} CHAP: ${name} repeated response id ${rx.id}; sent success again`, { port: line.port, id: rx.id, name });
            return true;
          }
        }
        if (!lcpOpened(line) || line.authLocal !== 'chap' || line.authLocalState !== 'pending' || rx.id !== line.chapId || line.challenge === undefined) {
          out.push({ type: 'drop', pdu, reason: 'other', detail: 'CHAP response to no outstanding challenge', port: line.port });
          return false;
        }
        line.peerName = name;
        if (line.chapArmed) {
          line.chapArmed = false;
          out.push({ type: 'cancelTimer', key: pppTimerKey(PPP_TIMER.chapRetry, line.port) });
        }
        const password = pppUserPassword(ctx.config, name);
        const value = f.value instanceof Uint8Array ? f.value : new Uint8Array(0);
        const expected = password === undefined ? undefined : chapMd5Response(rx.id, password, line.challenge);
        if (expected !== undefined && sameBytes(expected, value)) {
          line.authLocalState = 'success';
          send(ctx, line, 'chap', { code: CHAP_CODE.success, id: rx.id, message: PPP_TEXT.chapSuccess }, out);
          debug(ctx, PPP_DEBUG_AUTHENTICATION, `${line.port} CHAP: ${name} passed (response id ${rx.id})`, { port: line.port, id: rx.id, name });
          checkAuthDone(ctx, line, out);
          return true;
        }
        const reason = password === undefined ? pppNoPasswordText(name) : PPP_TEXT.chapMismatch;
        send(ctx, line, 'chap', { code: CHAP_CODE.failure, id: rx.id, message: reason }, out);
        debug(ctx, PPP_DEBUG_AUTHENTICATION, `${line.port} CHAP: ${name} failed (response id ${rx.id}): ${reason}`, { port: line.port, id: rx.id, name });
        localAuthFailed(ctx, line, 'CHAP', name === '' ? 'the peer' : name, reason, out);
        return true;
      }
      case CHAP_CODE.success:
      case CHAP_CODE.failure: {
        if (line.authPeer !== 'chap' || line.authPeerState !== 'pending') {
          debug(ctx, PPP_DEBUG_AUTHENTICATION, `${line.port} CHAP: ${rx.code === CHAP_CODE.success ? 'success' : 'failure'} id ${rx.id} ignored: nothing is pending`, { port: line.port, id: rx.id });
          return true;
        }
        const message = str(f.message) ?? '';
        stopChapResponse(line, out);
        if (rx.code === CHAP_CODE.success) {
          line.authPeerState = 'success';
          debug(ctx, PPP_DEBUG_AUTHENTICATION, `${line.port} CHAP: the peer accepted this end`, { port: line.port, id: rx.id });
          checkAuthDone(ctx, line, out);
        } else {
          debug(ctx, PPP_DEBUG_AUTHENTICATION, `${line.port} CHAP: the peer refused this end${message === '' ? '' : `: ${message}`}`, { port: line.port, id: rx.id });
          peerAuthFailed(ctx, line, 'CHAP', message, out);
        }
        return true;
      }
      default:
        out.push({ type: 'drop', pdu, reason: 'other', detail: `unknown CHAP code ${rx.code}`, port: line.port });
        return false;
    }
  }

  function receivePap(ctx: ProcessCtx, line: Line, rx: Rx, pdu: Pdu, out: Action[]): boolean {
    const f = rx.fields;
    switch (rx.code) {
      case PAP_CODE.request: {
        if (!lcpOpened(line) || line.authLocal !== 'pap') {
          out.push({ type: 'drop', pdu, reason: 'other', detail: 'PAP request outside the authentication phase', port: line.port });
          return false;
        }
        const peerId = str(f.peerId) ?? '';
        line.peerName = peerId;
        if (line.authLocalState === 'success') {
          // our Ack was lost: acknowledge the repeated request again
          send(ctx, line, 'pap', { code: PAP_CODE.ack, id: rx.id, message: PPP_TEXT.papSuccess }, out);
          return true;
        }
        if (line.authLocalState !== 'pending') return true;
        const password = pppUserPassword(ctx.config, peerId);
        if (password !== undefined && password === (str(f.password) ?? '')) {
          line.authLocalState = 'success';
          send(ctx, line, 'pap', { code: PAP_CODE.ack, id: rx.id, message: PPP_TEXT.papSuccess }, out);
          debug(ctx, PPP_DEBUG_AUTHENTICATION, `${line.port} PAP: ${peerId} passed (request id ${rx.id})`, { port: line.port, id: rx.id, name: peerId });
          checkAuthDone(ctx, line, out);
          return true;
        }
        const reason = password === undefined ? pppNoPasswordText(peerId) : PPP_TEXT.papMismatch;
        send(ctx, line, 'pap', { code: PAP_CODE.nak, id: rx.id, message: reason }, out);
        debug(ctx, PPP_DEBUG_AUTHENTICATION, `${line.port} PAP: ${peerId} failed (request id ${rx.id}): ${reason}`, { port: line.port, id: rx.id, name: peerId });
        localAuthFailed(ctx, line, 'PAP', peerId === '' ? 'the peer' : peerId, reason, out);
        return true;
      }
      case PAP_CODE.ack:
      case PAP_CODE.nak: {
        if (line.authPeer !== 'pap' || line.authPeerState !== 'pending' || rx.id !== line.papId) {
          debug(ctx, PPP_DEBUG_AUTHENTICATION, `${line.port} PAP: ${rx.code === PAP_CODE.ack ? 'ack' : 'nak'} id ${rx.id} ignored: nothing is pending`, { port: line.port, id: rx.id });
          return true;
        }
        if (line.papArmed) {
          line.papArmed = false;
          out.push({ type: 'cancelTimer', key: pppTimerKey(PPP_TIMER.papRetry, line.port) });
        }
        const message = str(f.message) ?? '';
        if (rx.code === PAP_CODE.ack) {
          line.authPeerState = 'success';
          debug(ctx, PPP_DEBUG_AUTHENTICATION, `${line.port} PAP: the peer accepted this end`, { port: line.port, id: rx.id });
          checkAuthDone(ctx, line, out);
        } else {
          debug(ctx, PPP_DEBUG_AUTHENTICATION, `${line.port} PAP: the peer refused this end${message === '' ? '' : `: ${message}`}`, { port: line.port, id: rx.id });
          peerAuthFailed(ctx, line, 'PAP', message, out);
        }
        return true;
      }
      default:
        out.push({ type: 'drop', pdu, reason: 'other', detail: `unknown PAP code ${rx.code}`, port: line.port });
        return false;
    }
  }

  // ── the line and the configuration ──

  function lineUp(ctx: ProcessCtx, line: Line, out: Action[]): void {
    if (line.lowerUp) return;
    line.lowerUp = true;
    line.reported = 'ppp-negotiating';
    delete line.downReason;
    debug(ctx, PPP_DEBUG_NEGOTIATION, `${line.port}: the serial line is ready`, { port: line.port });
    if (line.lcp.a.state === 'initial') drive(ctx, line, 'lcp', 'open', 'PPP is configured on the interface', out);
    beginAttempt(ctx, line);
    drive(ctx, line, 'lcp', 'up', 'the serial line is ready', out);
  }

  function lineDown(ctx: ProcessCtx, line: Line, out: Action[]): void {
    if (!line.lowerUp) return;
    line.lowerUp = false;
    debug(ctx, PPP_DEBUG_NEGOTIATION, `${line.port}: the serial line is not ready`, { port: line.port });
    cancelRetry(line, out);
    stopEcho(line, out);
    stopAuthTimers(line, out);
    const s = line.lcp.a.state;
    if (s !== 'initial' && s !== 'starting') drive(ctx, line, 'lcp', 'down', 'the serial line is not ready', out);
    if (line.lcp.a.state === 'initial') drive(ctx, line, 'lcp', 'open', 'PPP is configured on the interface', out);
    for (const n of ['ipcp', 'ipv6cp'] as const) ncpLowerDown(ctx, line, n, 'the serial line is not ready', out);
    line.authDone = false;
    abandonPendingAuth(line);
    delete line.downReason;
    line.reported = 'ppp-negotiating';
    delete line.peerMagic;
  }

  /** Re-read the port's PPP lines and act on what changed. */
  function syncConfig(ctx: ProcessCtx, line: Line, out: Action[]): void {
    const cfg = readPppPortConfig(ctx.config, line.port);
    const old = line.cfg;
    if (samePppPortConfig(old, cfg)) return;
    line.cfg = cfg;
    if (old.auth.join(' ') !== cfg.auth.join(' ')) {
      if (!lcpOpened(line)) line.authLocal = cfg.auth[0] ?? 'none';
      if (line.lowerUp) {
        debug(ctx, PPP_DEBUG_NEGOTIATION, `${line.port}: the authentication settings changed; negotiating again`, { port: line.port });
        restart(ctx, line, 'the authentication settings changed', out);
      }
    }
    if (old.keepaliveNs !== cfg.keepaliveNs && lcpOpened(line)) {
      stopEcho(line, out);
      startEcho(line, out);
    }
    for (const n of ['ipcp', 'ipv6cp'] as const) {
      const was = n === 'ipcp' ? old.ipv4 !== undefined : old.ipv6;
      const now = ncpEnabled(line, n);
      if (now && !was) ncpEnable(ctx, line, n, out);
      else if (!now && was) ncpDisable(ctx, line, n, out);
      else if (now && was && (n === 'ipcp' ? old.ipv4 !== cfg.ipv4 : old.linkLocal !== cfg.linkLocal)) ncpRenegotiate(ctx, line, n, out);
    }
  }

  // ── after every handler: rows, reports, routes ──

  function derivePhase(line: Line): PppPhase {
    if (!line.lowerUp) return 'dead';
    switch (line.lcp.a.state) {
      case 'closing':
      case 'stopping':
        return 'terminate';
      case 'req-sent':
      case 'ack-rcvd':
      case 'ack-sent':
        return 'establish';
      case 'opened':
        return line.authDone ? 'network' : 'authenticate';
      default:
        return 'dead';
    }
  }

  function rowOf(ctx: ProcessCtx, line: Line): PppRow {
    const row: PppRow = {
      key: line.port, port: line.port, phase: line.phase, lcp: line.lcp.a.state, authLocal: line.authLocal, authPeer: line.authPeer,
      ipcp: line.ipcp.a.state, magic: line.magic, failures: line.failures, since: line.since, updatedAt: ctx.now,
    };
    if (line.authLocalState !== undefined) row.authLocalState = line.authLocalState;
    if (line.authPeerState !== undefined) row.authPeerState = line.authPeerState;
    if (line.peerName !== undefined) row.peerName = line.peerName;
    if (line.peerAddress !== undefined) row.peerAddress = line.peerAddress;
    if (line.cfg.ipv6 || line.ipv6cp.a.state !== 'initial') row.ipv6cp = line.ipv6cp.a.state;
    if (line.peerMagic !== undefined) row.peerMagic = line.peerMagic;
    if (line.lastFailure !== undefined) row.lastFailure = line.lastFailure;
    return row;
  }

  function settleLine(ctx: ProcessCtx, line: Line, out: Action[]): void {
    const phase = derivePhase(line);
    if (phase !== line.phase) {
      line.phase = phase;
      line.since = ctx.now;
    }
    const row = rowOf(ctx, line);
    const { updatedAt: _u, ...shown } = row;
    const fp = JSON.stringify(shown);
    if (fp !== line.written) {
      line.written = fp;
      table(ctx)?.set(row);
    }
    if (!line.lowerUp) return;
    const desired = phase === 'network' ? 'up' : (line.downReason ?? 'ppp-negotiating');
    if (desired === line.reported) return;
    line.reported = desired;
    const op: MediumOp = desired === 'up' ? { op: 'ppp-link', up: true } : desired === 'ppp-negotiating' ? { op: 'ppp-link', up: false } : { op: 'ppp-link', up: false, reason: line.downReason };
    out.push({ type: 'medium', port: line.port, op });
    debug(ctx, PPP_DEBUG_NEGOTIATION, `${line.port}: line protocol ${desired === 'up' ? 'up' : `down (${desired})`}`, { port: line.port, state: desired });
  }

  /** The peer routes of every port (`peer neighbor-route`), offered to ipv4 as one set when it changes. */
  function settleRoutes(ctx: ProcessCtx, out: Action[]): void {
    const rows: RouteRow[] = [];
    for (const line of lines.values()) {
      const peer = line.peerAddress;
      if (peer === undefined || line.ipcp.a.state !== 'opened' || !line.cfg.neighborRoute || peer === line.cfg.ipv4) continue;
      rows.push({ key: routeKey(peer, 32), network: peer, prefixLen: 32, source: 'C', iface: line.port, ad: 0, metric: 0, updatedAt: ctx.now });
    }
    const fp = rows.map((r) => `${r.key}@${r.iface ?? ''}`).join(';');
    if (fp === offered) return;
    offered = fp;
    if (!ctx.model.processes.includes('ipv4')) return;
    out.push({ type: 'request', to: 'ipv4', req: { kind: 'ipv4.routes', owner: PPP_PROCESS, rows } });
  }

  function settle(ctx: ProcessCtx, out: Action[]): Action[] {
    for (const line of lines.values()) settleLine(ctx, line, out);
    settleRoutes(ctx, out);
    return out;
  }

  // ── the process ──

  return {
    name: PPP_PROCESS,
    handles: PPP_HANDLES,

    init(ctx: ProcessCtx): Action[] {
      started = true;
      const out: Action[] = [];
      for (const view of ctx.ports.values()) {
        if (!isPppPort(ctx, view)) continue;
        const line = adopt(ctx, view.id, out);
        if (phyReady(view)) lineUp(ctx, line, out);
      }
      return settle(ctx, out);
    },

    onPdu(ctx: ProcessCtx, pdu: Pdu, port: PortId): Action[] {
      const line = lines.get(port);
      const inner = pdu.layers[1];
      if (line === undefined) {
        return [{ type: 'drop', pdu, reason: 'other', detail: `PPP does not run on ${port}`, port }];
      }
      if (inner === undefined || inner.error !== undefined || typeof inner.fields.code !== 'number' || typeof inner.fields.id !== 'number') {
        debug(ctx, PPP_DEBUG_NEGOTIATION, `${port}: malformed ${inner?.proto ?? 'PPP'} packet dropped`, { port, pdu: pdu.id });
        return [{ type: 'drop', pdu, reason: 'other', detail: `malformed ${inner?.proto ?? 'PPP'} packet`, port }];
      }
      line.received++;
      receivedTotal++;
      const rx: Rx = { code: inner.fields.code, id: inner.fields.id, fields: inner.fields };
      const out: Action[] = [];
      const proto = inner.proto as string;
      let consumed = true;
      if (proto === 'lcp' || proto === 'ipcp' || proto === 'ipv6cp') {
        const msg = `${port} ${CP_LABEL[proto]}: received ${CODE_TEXT[rx.code] ?? `code ${rx.code}`} id ${rx.id}${optionText(rx.fields)}`;
        debug(ctx, PPP_DEBUG_NEGOTIATION, msg, { port, pdu: pdu.id, protocol: proto, code: rx.code, id: rx.id });
      }
      if (proto === 'lcp') {
        if (!line.lowerUp) {
          out.push({ type: 'drop', pdu, reason: 'other', detail: 'LCP packet while the serial line is not ready', port });
          consumed = false;
        } else receiveLcp(ctx, line, rx, out);
      } else if (proto === 'ipcp' || proto === 'ipv6cp') consumed = receiveNcp(ctx, line, proto, rx, pdu, out);
      else if (proto === 'chap') consumed = receiveChap(ctx, line, rx, pdu, out);
      else if (proto === 'pap') consumed = receivePap(ctx, line, rx, pdu, out);
      else {
        out.push({ type: 'drop', pdu, reason: 'other', detail: `not a PPP control protocol (${proto})`, port });
        consumed = false;
      }
      if (consumed) out.unshift({ type: 'consume', pdu });
      return settle(ctx, out);
    },

    onTimer(ctx: ProcessCtx, key: string): Action[] {
      const out: Action[] = [];
      const match = (prefix: string): Line | undefined => (key.startsWith(prefix) ? lines.get(key.slice(prefix.length)) : undefined);
      for (const cp of ['lcp', 'ipcp', 'ipv6cp'] as const) {
        const line = match(RESTART_PREFIX[cp]);
        if (line === undefined) continue;
        const c = line[cp];
        if (cp !== 'lcp' && !inNetwork(line)) return settle(ctx, out);
        const ev = pppTimeoutEvent(c.a);
        const negotiating = c.a.state === 'req-sent' || c.a.state === 'ack-rcvd' || c.a.state === 'ack-sent';
        drive(ctx, line, cp, ev, ev === 'to+' ? 'the restart timer expired' : 'the peer did not answer', out);
        if (cp === 'lcp' && ev === 'to-' && negotiating) countFailure(line, 'the peer did not answer the link negotiation');
        return settle(ctx, out);
      }
      let line = match(PPP_TIMER.echo);
      if (line !== undefined) {
        echoTick(ctx, line, out);
        return settle(ctx, out);
      }
      line = match(PPP_TIMER.retry);
      if (line !== undefined) {
        line.retryArmed = false;
        const s = line.lcp.a.state;
        if (line.lowerUp && (s === 'stopped' || s === 'closed')) {
          debug(ctx, PPP_DEBUG_NEGOTIATION, `${line.port}: trying the link again`, { port: line.port });
          restart(ctx, line, 'retrying the link', out);
        }
        return settle(ctx, out);
      }
      line = match(PPP_TIMER.chapRetry);
      if (line !== undefined) {
        line.chapArmed = false;
        if (line.authLocal === 'chap' && line.authLocalState === 'pending' && lcpOpened(line)) {
          if (line.chapSends >= PPP_AUTH_MAX_SENDS) localAuthFailed(ctx, line, 'CHAP', line.peerName ?? 'the peer', 'no response to the challenge', out);
          else sendChallenge(ctx, line, out);
        }
        return settle(ctx, out);
      }
      line = match(PPP_TIMER.chapResponse);
      if (line !== undefined) {
        line.chapResponseArmed = false;
        if (line.authPeer === 'chap' && line.authPeerState === 'pending' && lcpOpened(line)) {
          if (line.chapResponseSends >= PPP_AUTH_MAX_SENDS) {
            line.authPeerState = 'failed';
            authMachine(ctx, line, 'failed', 'CHAP: the peer never gave a verdict');
            endAttempt(ctx, line, 'the peer never answered the CHAP response', true, out);
          } else {
            const again = sendChapResponse(ctx, line, out);
            const id = line.chapResponse?.id;
            debug(ctx, PPP_DEBUG_AUTHENTICATION, `${line.port} CHAP: no verdict yet; sent the response id ${id} again`, { port: line.port, pdu: again?.id, id, sends: line.chapResponseSends });
          }
        }
        return settle(ctx, out);
      }
      line = match(PPP_TIMER.papRetry);
      if (line !== undefined) {
        line.papArmed = false;
        if (line.authPeer === 'pap' && line.authPeerState === 'pending' && lcpOpened(line)) {
          if (line.papSends >= PPP_AUTH_MAX_SENDS) {
            line.authPeerState = 'failed';
            authMachine(ctx, line, 'failed', 'PAP: the peer never answered');
            endAttempt(ctx, line, 'the peer never answered the PAP request', true, out);
          } else sendPapRequest(ctx, line, out);
        }
        return settle(ctx, out);
      }
      return [];
    },

    onConfig(ctx: ProcessCtx, delta: ConfigDelta): Action[] {
      if (!started) return [];
      const head = delta.context[0];
      if (delta.context.length === 0 || head === undefined || head[0] !== 'interface' || head[1] === undefined) return [];
      const port = head[1];
      const view = ctx.ports.get(port);
      const line = lines.get(port);
      const ppp = isPppPort(ctx, view);
      if (line === undefined && !ppp) return [];
      const out: Action[] = [];
      if (line !== undefined && !ppp) release(ctx, line, out);
      else if (line === undefined && ppp) adopt(ctx, port, out);
      else if (line !== undefined) syncConfig(ctx, line, out);
      return settle(ctx, out);
    },

    onMediumEvent(ctx: ProcessCtx, port: PortId, ev: MediumEvent): Action[] {
      if (ev.kind !== 'serial-line') return [];
      const line = lines.get(port);
      if (line === undefined) return [];
      const out: Action[] = [];
      if (ev.ready) lineUp(ctx, line, out);
      else lineDown(ctx, line, out);
      return settle(ctx, out);
    },

    onEvent(): Action[] {
      return [];
    },

    stateSnapshot(): StateView {
      const ports: Record<string, unknown>[] = [];
      for (const l of lines.values()) {
        ports.push({
          port: l.port, lineReady: l.lowerUp, phase: l.phase, lcp: l.lcp.a.state, ipcp: l.ipcp.a.state, ipv6cp: l.ipv6cp.a.state,
          authLocal: l.authLocal, authPeer: l.authPeer, echoOutstanding: l.echoOutstanding, retryArmed: l.retryArmed, sent: l.sent, received: l.received,
        });
      }
      return { process: PPP_PROCESS, state: { ports, sent: sentTotal, received: receivedTotal } };
    },

    debugEvents(): readonly DebugEvent[] {
      return ring;
    },
  };
}
