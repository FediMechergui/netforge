/**
 * protocols/dhcpv6-client.ts — the DHCPv6 client (RFC 8415 stateful and stateless; ARCHITECTURE-P2 D16, §3.11, §4).
 *
 * Silent unless an interface asks for it (§4.3):
 *  • `ipv6 address dhcp` on the interface → a STATEFUL exchange as soon as the link is up, without waiting for a
 *    router advertisement (a router interface as client, §3.11 "Stateful" 3);
 *  • `ipv6 address autoconfig` on the interface and the router last heard advertises M = 1 → stateful, or O = 1 →
 *    STATELESS (ipv6 forwards the flags as the ProcessEvent `ipv6.ra` whenever they change, §2.5); M = O = 0 → no
 *    exchange, so every P1 world (its RAs carry M = O = 0) sees no DHCPv6 datagram.
 * Per such interface: socket `dhcpv6-client#<iface>` (family 6, port 546, receive restricted to the interface, opened
 * only while the interface wants DHCPv6), DUID-LL from the interface MAC, IAID = the port ordinal.
 *
 * Exchanges (every message goes from the link-local address to ff02::1:2 port 547 out the interface):
 *  • stateless: after a delay of 0–1 s drawn from `ctx.stream('sol-delay:<iface>')` an INFORMATION-REQUEST (11,
 *    `oro` 23,24, `elapsedTimeCs`), answered by a REPLY (7) whose DNS servers and domain go to dns-client as
 *    `dhcp.lease {family: 6, op: 'bound'}`; the periodic `info-refresh:<iface>` (86 400 s) repeats the request;
 *  • stateful: SOLICIT (1) → ADVERTISE (2, the first one wins) → REQUEST (3) → REPLY (7): the leased address is
 *    bound through `ipv6.lease bind {prefixLen 128, preferredUntil, validUntil, server}` (ipv6 adds it with origin
 *    'dhcpv6', tentative, then DAD), the periodic `t1:*` / `t2:*` / `valid:*` timers follow the reply's lifetimes
 *    (T1 and T2 default to half and four fifths of the preferred lifetime), the DNS data goes to dns-client, syslog 6;
 *    T1 → RENEW (5, with the server id), T2 → REBIND (6, without), one message each; a REPLY re-binds; the valid
 *    lifetime end → unbind, `dhcp.lease lost`, a new cycle. `no ipv6 address dhcp`, the flags going to M = O = 0 and
 *    power-off send a RELEASE (8) for a bound address.
 * The transaction id of every message exchange (SOLICIT/ADVERTISE, REQUEST/REPLY, RENEW, REBIND, RELEASE,
 * INFORMATION-REQUEST) is one 24-bit draw from `ctx.stream('xid6:<iface>')` (§4.1); retransmits keep it. The
 * retransmit timer `sol:<iface>` (non-periodic) runs 1 s doubling to 120 s for at most DHCPV6_SOL_TRIES sends of a
 * SOLICIT, REQUEST or INFORMATION-REQUEST, then the periodic `dhcpv6-restart:<iface>` pause (60 s) starts a new
 * cycle, so an unanswered client never holds `runToIdle` (§4.2). `sol:<iface>` also carries the initial delay. An
 * interface without a usable link-local address yet (still tentative) is polled at 1 s for at most DHCPV6_SOL_TRIES
 * attempts, then the same pause applies (a duplicate link-local never becomes usable): the wait is bounded.
 *
 * Debug category 'ipv6 dhcp'; every state change is a `ctx.transition` of machine 'dhcpv6' (subject = the
 * interface). stateSnapshot: { clients: [{ iface, mode, state, xid, server, address, dns, domain }] }.
 *
 * ponytail: no rapid commit, no CONFIRM / DECLINE, RENEW and REBIND are sent once each (no retransmit), the first
 * ADVERTISE is taken (no preference), one IA_NA with one address per interface.
 */
import { IPV6_ANY, type Ipv6Address } from '../contracts/addr.js';
import type { ConfigDelta } from '../contracts/config.js';
import type { PduId, PortId } from '../contracts/ids.js';
import { DHCPV6_ALL_AGENTS, UDP_PORT_DHCPV6_CLIENT, UDP_PORT_DHCPV6_SERVER, type FieldValue, type Pdu } from '../contracts/pdu.js';
import type { Action, DebugEvent, FsmTransition, Process, ProcessCtx, ProcessRequest, StateView } from '../contracts/process.js';
import { MS, SEC, type SimTime } from '../contracts/time.js';
import type { LeaseEvent, ProcessEvent } from '../contracts/transport.js';
import { normalizeIpv6 } from '../core/addr6.js';
import {
  DHCPV6_ADVERTISE,
  DHCPV6_INFORMATION_REQUEST,
  DHCPV6_REBIND,
  DHCPV6_RELEASE,
  DHCPV6_RENEW,
  DHCPV6_REPLY,
  DHCPV6_REQUEST,
  DHCPV6_SOLICIT,
  dhcpv6MessageName,
  duidLlFromMac,
} from '../pdu/codecs/dhcpv6.js';
import { interfaceIpv6Lines, isLinkLocal6, isMulticast6, isUnspecified6, preferredLinkLocal } from './ipv6.js';

const NAME = 'dhcpv6-client';
/** Debug category (§5.4): `debug ipv6 dhcp` (the cli grammar names the same string). */
const CAT = 'ipv6 dhcp';
const DEBUG_RING = 256;

/** Option request: DNS recursive name servers (23) and the domain search list (24). */
export const DHCPV6_ORO = '23,24';
/** Longest initial delay before the first SOLICIT / INFORMATION-REQUEST of a cycle (RFC 8415 SOL_MAX_DELAY, INF_MAX_DELAY). */
export const DHCPV6_SOL_DELAY_MAX_MS = 1000;
/** First retransmit interval; doubles up to DHCPV6_SOL_MAX_NS. */
export const DHCPV6_SOL_INITIAL_NS: SimTime = 1 * SEC;
export const DHCPV6_SOL_MAX_NS: SimTime = 120 * SEC;
/** Sends of one message before the client pauses. */
export const DHCPV6_SOL_TRIES = 5;
/** Pause between cycles after DHCPV6_SOL_TRIES unanswered sends (periodic, §4.2). */
export const DHCPV6_RESTART_PAUSE_NS: SimTime = 60 * SEC;
/** Stateless information refresh (RFC 8415 IRT_DEFAULT). */
export const DHCPV6_INFO_REFRESH_NS: SimTime = 86_400 * SEC;
/** Status codes the client acts on (RFC 8415 §21.13). */
export const DHCPV6_STATUS_SUCCESS = 0;
export const DHCPV6_STATUS_NO_ADDRS_AVAIL = 2;
export const DHCPV6_STATUS_NO_BINDING = 3;
export const DHCPV6_STATUS_NOT_ON_LINK = 4;

export type Dhcpv6ClientMode = 'stateful' | 'stateless';
export type Dhcpv6ClientState = 'idle' | 'delay' | 'soliciting' | 'requesting' | 'inforeq' | 'bound' | 'renewing' | 'rebinding' | 'paused';

interface Lease6 {
  address: Ipv6Address;
  preferredS: number;
  validS: number;
  boundAt: SimTime;
}

interface Client {
  readonly iface: PortId;
  mode: Dhcpv6ClientMode;
  state: Dhcpv6ClientState;
  xid: number;
  /** Sends of the current message in this exchange. */
  attempt: number;
  /** First send of the current exchange (for `elapsedTimeCs`). */
  startedAt: SimTime;
  server?: { duid: string; address: Ipv6Address };
  offer?: { address: Ipv6Address; preferredS: number; validS: number; t1S: number; t2S: number };
  lease?: Lease6;
  dns: string[];
  domain?: string;
}

/** The DHCPv6 layer of a received datagram. */
function dhcpv6Of(pdu: Pdu): Readonly<Record<string, FieldValue>> | undefined {
  return pdu.layers.find((l) => l.proto === 'dhcpv6')?.fields;
}

function splitList(v: FieldValue | undefined): string[] {
  return typeof v === 'string' && v !== '' ? v.split(',').map((s) => s.trim()).filter((s) => s !== '') : [];
}

const num = (v: FieldValue | undefined, dflt = 0): number => (typeof v === 'number' && Number.isFinite(v) ? v : dflt);

export function createDhcpv6Client(): Process {
  const clients = new Map<PortId, Client>();
  /** The M/O flags last reported by ipv6 per interface (`ipv6.ra`). */
  const raFlags = new Map<PortId, { managed: boolean; other: boolean }>();
  const ring: DebugEvent[] = [];

  function record(ctx: ProcessCtx, message: string, data?: Record<string, unknown>): void {
    const ev: DebugEvent = data
      ? { at: ctx.now, device: ctx.deviceId, process: NAME, category: CAT, message, data }
      : { at: ctx.now, device: ctx.deviceId, process: NAME, category: CAT, message };
    ring.push(ev);
    if (ring.length > DEBUG_RING) ring.splice(0, ring.length - DEBUG_RING);
  }

  function debug(ctx: ProcessCtx, message: string, data?: Record<string, unknown>): void {
    ctx.debug(CAT, message, data);
    record(ctx, message, data);
  }

  const socketOf = (c: Client): string => `${NAME}#${c.iface}`;
  const duidOf = (ctx: ProcessCtx, iface: PortId): string => duidLlFromMac(ctx.macOf(iface));
  const iaidOf = (ctx: ProcessCtx, iface: PortId): number => ctx.ports.get(iface)?.ordinal ?? 0;
  const timer = (key: string, delay: SimTime, periodic = false): Action => (periodic ? { type: 'timer', key, delay, periodic: true } : { type: 'timer', key, delay });
  const cancel = (key: string): Action => ({ type: 'cancelTimer', key });
  const portUp = (ctx: ProcessCtx, iface: PortId): boolean => ctx.ports.get(iface)?.operUp === true;

  function setState(ctx: ProcessCtx, c: Client, to: Dhcpv6ClientState, cause: string, pdu?: PduId): void {
    if (c.state === to) return;
    const fsm: FsmTransition = { machine: 'dhcpv6', subject: c.iface, port: c.iface, from: c.state, to, cause, ...(pdu !== undefined ? { pdu } : {}) };
    const message = `${c.iface}: ${c.state} -> ${to} (${cause})`;
    ctx.transition(CAT, message, fsm, { iface: c.iface, mode: c.mode });
    record(ctx, message, { iface: c.iface, mode: c.mode, fsm });
    c.state = to;
  }

  /** What the interface wants: the `ipv6 address dhcp` line forces stateful; else the last RA flags on an autoconfig interface. */
  function modeFor(ctx: ProcessCtx, iface: PortId): Dhcpv6ClientMode | undefined {
    let dhcp = false;
    let autoconfig = false;
    for (const l of interfaceIpv6Lines(ctx, iface)) {
      if (l[1] !== 'address') continue;
      if (l[2] === 'dhcp') dhcp = true;
      else if (l[2] === 'autoconfig') autoconfig = true;
    }
    if (dhcp) return 'stateful';
    if (!autoconfig) return undefined;
    const flags = raFlags.get(iface);
    if (flags === undefined) return undefined;
    if (flags.managed) return 'stateful';
    return flags.other ? 'stateless' : undefined;
  }

  // ── sending ───────────────────────────────────────────────────────────────

  function send(ctx: ProcessCtx, c: Client, msgType: number, fields: Record<string, FieldValue>, tag: string, triggeredBy?: PduId): Action {
    const all: Record<string, FieldValue> = { msgType, transactionId: c.xid, clientDuid: duidOf(ctx, c.iface), ...fields };
    debug(ctx, `${c.iface}: send ${dhcpv6MessageName(msgType)} xid 0x${c.xid.toString(16).padStart(6, '0')} to ${DHCPV6_ALL_AGENTS}`, { iface: c.iface, msgType, xid: c.xid });
    const req: Extract<ProcessRequest, { kind: 'udp.send' }> = {
      kind: 'udp.send',
      socket: socketOf(c),
      dst: DHCPV6_ALL_AGENTS,
      dstPort: UDP_PORT_DHCPV6_SERVER,
      iface: c.iface,
      tag,
      app: [{ proto: 'dhcpv6', fields: all }],
    };
    if (triggeredBy !== undefined) req.triggeredBy = triggeredBy;
    return { type: 'request', to: 'udp', req };
  }

  const elapsedCs = (ctx: ProcessCtx, c: Client): number => Math.min(0xffff, Math.floor((ctx.now - c.startedAt) / (10 * MS)));

  /** Retransmit delay for `attempt` (1-based): 1 s doubling, capped. */
  function retransmitDelay(c: Client): SimTime {
    let d = DHCPV6_SOL_INITIAL_NS;
    for (let i = 1; i < c.attempt; i++) d = Math.min(d * 2, DHCPV6_SOL_MAX_NS);
    return d;
  }

  function solicit(ctx: ProcessCtx, c: Client): Action[] {
    return [
      send(ctx, c, DHCPV6_SOLICIT, { iaid: iaidOf(ctx, c.iface), t1S: 0, t2S: 0, oro: DHCPV6_ORO, elapsedTimeCs: elapsedCs(ctx, c) }, 'dhcpv6-solicit'),
      timer(`sol:${c.iface}`, retransmitDelay(c)),
    ];
  }

  function inforeq(ctx: ProcessCtx, c: Client): Action[] {
    return [send(ctx, c, DHCPV6_INFORMATION_REQUEST, { oro: DHCPV6_ORO, elapsedTimeCs: elapsedCs(ctx, c) }, 'dhcpv6-inforeq'), timer(`sol:${c.iface}`, retransmitDelay(c))];
  }

  function request(ctx: ProcessCtx, c: Client, triggeredBy?: PduId): Action[] {
    const o = c.offer!;
    const s = c.server!;
    return [
      send(
        ctx,
        c,
        DHCPV6_REQUEST,
        { serverDuid: s.duid, iaid: iaidOf(ctx, c.iface), t1S: 0, t2S: 0, iaAddress: o.address, preferredLifetimeS: o.preferredS, validLifetimeS: o.validS, oro: DHCPV6_ORO, elapsedTimeCs: elapsedCs(ctx, c) },
        'dhcpv6-request',
        triggeredBy,
      ),
      timer(`sol:${c.iface}`, retransmitDelay(c)),
    ];
  }

  /** One 24-bit transaction id draw from the interface's `xid6:` sub-stream (§4.1). */
  function newXid(ctx: ProcessCtx, c: Client): void {
    c.xid = ctx.stream(`xid6:${c.iface}`).nextU32() & 0xffffff;
  }

  /** Start a new exchange: one xid draw, attempt 1, the elapsed-time clock reset. */
  function beginExchange(ctx: ProcessCtx, c: Client): void {
    newXid(ctx, c);
    c.attempt = 1;
    c.startedAt = ctx.now;
  }

  /** A new cycle: the initial delay, then SOLICIT or INFORMATION-REQUEST. */
  function start(ctx: ProcessCtx, c: Client, why: string): Action[] {
    delete c.offer;
    if (!portUp(ctx, c.iface)) {
      setState(ctx, c, 'idle', `${why}; waiting for link`);
      return [cancel(`sol:${c.iface}`), cancel(`dhcpv6-restart:${c.iface}`)];
    }
    const delayMs = ctx.stream(`sol-delay:${c.iface}`).nextInt(0, DHCPV6_SOL_DELAY_MAX_MS);
    c.attempt = 0;
    setState(ctx, c, 'delay', why);
    debug(ctx, `${c.iface}: first message in ${delayMs} ms`, { iface: c.iface, delayMs });
    return [cancel(`dhcpv6-restart:${c.iface}`), timer(`sol:${c.iface}`, delayMs * MS)];
  }

  /** The initial delay ended (or the link-local address was not ready): send the first message of the exchange. */
  function firstMessage(ctx: ProcessCtx, c: Client): Action[] {
    if (preferredLinkLocal(ctx.ports.get(c.iface)) === undefined) {
      // a tentative link-local address becomes usable within a few seconds; a duplicate never does. The wait counts
      // as an attempt so the non-periodic `sol:` timer is re-armed at most DHCPV6_SOL_TRIES times before the
      // periodic restart pause (which does not hold runToIdle, §4.2) takes over.
      if (c.attempt >= DHCPV6_SOL_TRIES) return pause(ctx, c, 'no usable link-local address');
      c.attempt++;
      debug(ctx, `${c.iface}: no usable link-local address yet; waiting`, { iface: c.iface, attempt: c.attempt });
      return [timer(`sol:${c.iface}`, DHCPV6_SOL_INITIAL_NS)];
    }
    beginExchange(ctx, c);
    if (c.mode === 'stateless') {
      setState(ctx, c, 'inforeq', 'information request');
      return inforeq(ctx, c);
    }
    setState(ctx, c, 'soliciting', 'solicit');
    return solicit(ctx, c);
  }

  function pause(ctx: ProcessCtx, c: Client, why: string): Action[] {
    setState(ctx, c, 'paused', why);
    return [timer(`dhcpv6-restart:${c.iface}`, DHCPV6_RESTART_PAUSE_NS, true)];
  }

  // ── binding ───────────────────────────────────────────────────────────────

  function leaseEvent(c: Client, op: LeaseEvent['op']): Action {
    const ev: LeaseEvent = { kind: 'dhcp.lease', family: 6, iface: c.iface, op, dnsServers: [...c.dns] };
    if (c.domain !== undefined) ev.domainName = c.domain;
    return { type: 'event', to: 'dns-client', ev };
  }

  function takeInfo(c: Client, f: Readonly<Record<string, FieldValue>>): void {
    c.dns = splitList(f.dnsServers).map((a) => normalizeIpv6(a)).filter((a): a is Ipv6Address => a !== null);
    const domains = splitList(f.domainList);
    if (domains[0] !== undefined) c.domain = domains[0];
    else delete c.domain;
  }

  /** Drop the lease: unbind, lease timers off, `dhcp.lease lost`. */
  function unbind(ctx: ProcessCtx, c: Client, why: string): Action[] {
    const out: Action[] = [cancel(`t1:${c.iface}`), cancel(`t2:${c.iface}`), cancel(`valid:${c.iface}`), cancel(`info-refresh:${c.iface}`)];
    const l = c.lease;
    const hadInfo = c.dns.length > 0 || c.domain !== undefined;
    if (l !== undefined) {
      debug(ctx, `${c.iface}: leased address ${l.address} removed (${why})`, { iface: c.iface, address: l.address, why });
      out.push({ type: 'request', to: 'ipv6', req: { kind: 'ipv6.lease', op: 'unbind', iface: c.iface, address: l.address } });
    }
    if (l !== undefined || hadInfo) out.push(leaseEvent(c, 'lost'));
    delete c.lease;
    c.dns = [];
    delete c.domain;
    return out;
  }

  /** RELEASE a bound address (stateful only), then unbind. */
  function release(ctx: ProcessCtx, c: Client, why: string): Action[] {
    const out: Action[] = [cancel(`sol:${c.iface}`), cancel(`dhcpv6-restart:${c.iface}`)];
    const l = c.lease;
    const s = c.server;
    if (l !== undefined && s !== undefined) {
      beginExchange(ctx, c);
      out.push(send(ctx, c, DHCPV6_RELEASE, { serverDuid: s.duid, iaid: iaidOf(ctx, c.iface), t1S: 0, t2S: 0, iaAddress: l.address, elapsedTimeCs: 0 }, 'dhcpv6-release'));
    }
    out.push(...unbind(ctx, c, why));
    return out;
  }

  function bind(ctx: ProcessCtx, c: Client, f: Readonly<Record<string, FieldValue>>, from: Ipv6Address, pdu: Pdu): Action[] {
    const address = typeof f.iaAddress === 'string' ? normalizeIpv6(f.iaAddress) : null;
    if (address === null || isMulticast6(address) || isLinkLocal6(address) || isUnspecified6(address)) {
      debug(ctx, `${c.iface}: REPLY without a usable address (pdu ${pdu.id})`, { iface: c.iface, pdu: pdu.id });
      return [cancel(`sol:${c.iface}`), ...pause(ctx, c, 'reply carried no address')];
    }
    const preferredS = num(f.preferredLifetimeS, 0);
    const validS = num(f.validLifetimeS, 0);
    if (validS <= 0) {
      debug(ctx, `${c.iface}: REPLY with a zero valid lifetime for ${address} (pdu ${pdu.id})`, { iface: c.iface, pdu: pdu.id });
      return [cancel(`sol:${c.iface}`), ...unbind(ctx, c, 'valid lifetime zero'), ...pause(ctx, c, 'address withdrawn')];
    }
    const t1S = num(f.t1S, 0) > 0 ? num(f.t1S, 0) : Math.floor(preferredS / 2);
    const t2S = num(f.t2S, 0) > 0 ? num(f.t2S, 0) : Math.floor((preferredS * 4) / 5);
    const renewed = c.lease?.address === address;
    c.lease = { address, preferredS, validS, boundAt: ctx.now };
    if (typeof f.serverDuid === 'string') c.server = { duid: f.serverDuid, address: from };
    takeInfo(c, f);
    delete c.offer;
    setState(ctx, c, 'bound', `REPLY from ${from}`, pdu.id);
    const req: Extract<ProcessRequest, { kind: 'ipv6.lease' }> = {
      kind: 'ipv6.lease',
      op: 'bind',
      iface: c.iface,
      address,
      prefixLen: 128,
      validUntil: ctx.now + validS * SEC,
      server: from,
    };
    if (preferredS > 0) req.preferredUntil = ctx.now + preferredS * SEC;
    const out: Action[] = [cancel(`sol:${c.iface}`), cancel(`dhcpv6-restart:${c.iface}`), { type: 'request', to: 'ipv6', req }];
    out.push(timer(`valid:${c.iface}`, validS * SEC, true));
    if (t1S > 0 && t1S < validS) out.push(timer(`t1:${c.iface}`, t1S * SEC, true));
    else out.push(cancel(`t1:${c.iface}`));
    if (t2S > t1S && t2S < validS) out.push(timer(`t2:${c.iface}`, t2S * SEC, true));
    else out.push(cancel(`t2:${c.iface}`));
    out.push(leaseEvent(c, renewed ? 'renewed' : 'bound'));
    if (!renewed) out.push({ type: 'log', severity: 6, facility: 'DHCPV6', message: `Interface ${c.iface} received address ${address}/128 from ${from}` });
    debug(ctx, `${c.iface}: bound ${address}/128 for ${validS} s (preferred ${preferredS} s, pdu ${pdu.id})`, { iface: c.iface, address, validS, preferredS, pdu: pdu.id });
    return out;
  }

  function bindInfo(ctx: ProcessCtx, c: Client, f: Readonly<Record<string, FieldValue>>, from: Ipv6Address, pdu: Pdu): Action[] {
    const first = c.state !== 'bound';
    takeInfo(c, f);
    setState(ctx, c, 'bound', `REPLY from ${from}`, pdu.id);
    debug(ctx, `${c.iface}: information from ${from}: DNS ${c.dns.join(', ') || 'none'}${c.domain !== undefined ? `, domain ${c.domain}` : ''} (pdu ${pdu.id})`, {
      iface: c.iface, dns: c.dns, domain: c.domain, pdu: pdu.id,
    });
    return [cancel(`sol:${c.iface}`), cancel(`dhcpv6-restart:${c.iface}`), timer(`info-refresh:${c.iface}`, DHCPV6_INFO_REFRESH_NS, true), leaseEvent(c, first ? 'bound' : 'renewed')];
  }

  // ── receive ───────────────────────────────────────────────────────────────

  function onReply(ctx: ProcessCtx, c: Client, from: Ipv6Address, pdu: Pdu): Action[] {
    const f = dhcpv6Of(pdu);
    if (f === undefined || f.transactionId !== c.xid || f.clientDuid !== duidOf(ctx, c.iface)) {
      debug(ctx, `${c.iface}: ignored a datagram from ${from} that is not an answer to xid 0x${c.xid.toString(16).padStart(6, '0')} (pdu ${pdu.id})`, { iface: c.iface, pdu: pdu.id });
      return [];
    }
    const type = num(f.msgType, 0);
    const status = num(f.statusCode, DHCPV6_STATUS_SUCCESS);
    if (type === DHCPV6_ADVERTISE && c.state === 'soliciting') {
      const address = typeof f.iaAddress === 'string' ? normalizeIpv6(f.iaAddress) : null;
      if (status !== DHCPV6_STATUS_SUCCESS || address === null || typeof f.serverDuid !== 'string') {
        debug(ctx, `${c.iface}: ADVERTISE from ${from} offers no address (status ${status})`, { iface: c.iface, status, pdu: pdu.id });
        return [];
      }
      c.server = { duid: f.serverDuid, address: from };
      c.offer = { address, preferredS: num(f.preferredLifetimeS, 0), validS: num(f.validLifetimeS, 0), t1S: num(f.t1S, 0), t2S: num(f.t2S, 0) };
      // REQUEST/REPLY is a new exchange with its own transaction id (RFC 8415 §18.2.2); the elapsed time keeps
      // counting from the first SOLICIT (§21.9), so only the id is drawn again
      newXid(ctx, c);
      c.attempt = 1;
      setState(ctx, c, 'requesting', `ADVERTISE ${address} from ${from}`, pdu.id);
      return request(ctx, c, pdu.id);
    }
    if (type !== DHCPV6_REPLY) return [];
    if (c.state === 'inforeq') return bindInfo(ctx, c, f, from, pdu);
    const waiting = c.state === 'requesting' || c.state === 'renewing' || c.state === 'rebinding';
    if (!waiting) return [];
    if (status !== DHCPV6_STATUS_SUCCESS) {
      debug(ctx, `${c.iface}: REPLY from ${from} refused the address (status ${status})`, { iface: c.iface, status, pdu: pdu.id });
      return [cancel(`sol:${c.iface}`), ...unbind(ctx, c, `status ${status}`), ...start(ctx, c, `status ${status} from the server`)];
    }
    return bind(ctx, c, f, from, pdu);
  }

  // ── lifecycle ─────────────────────────────────────────────────────────────

  function add(ctx: ProcessCtx, iface: PortId, mode: Dhcpv6ClientMode): Action[] {
    const c: Client = { iface, mode, state: 'idle', xid: 0, attempt: 0, startedAt: ctx.now, dns: [] };
    clients.set(iface, c);
    debug(ctx, `${iface}: DHCPv6 client enabled (${mode})`, { iface, mode });
    return [
      { type: 'request', to: 'udp', req: { kind: 'udp.open', owner: NAME, socket: socketOf(c), family: 6, localAddr: IPV6_ANY, localPort: UDP_PORT_DHCPV6_CLIENT, iface } },
      ...start(ctx, c, 'enabled'),
    ];
  }

  function remove(ctx: ProcessCtx, c: Client, why: string): Action[] {
    const out = release(ctx, c, why);
    setState(ctx, c, 'idle', why);
    out.push({ type: 'request', to: 'udp', req: { kind: 'udp.close', socket: socketOf(c) } });
    clients.delete(c.iface);
    debug(ctx, `${c.iface}: DHCPv6 client disabled (${why})`, { iface: c.iface, why });
    return out;
  }

  /** Reconcile the clients with what every interface wants now. */
  function sync(ctx: ProcessCtx): Action[] {
    const out: Action[] = [];
    for (const c of [...clients.values()]) {
      const want = modeFor(ctx, c.iface);
      if (want === undefined || !ctx.ports.has(c.iface)) out.push(...remove(ctx, c, want === undefined ? 'DHCPv6 no longer wanted' : 'interface removed'));
      else if (want !== c.mode) {
        debug(ctx, `${c.iface}: mode ${c.mode} -> ${want}`, { iface: c.iface, from: c.mode, to: want });
        out.push(...release(ctx, c, `mode changed to ${want}`));
        c.mode = want;
        out.push(...start(ctx, c, `mode ${want}`));
      }
    }
    for (const iface of ctx.ports.keys()) {
      if (clients.has(iface)) continue;
      const want = modeFor(ctx, iface);
      if (want !== undefined) out.push(...add(ctx, iface, want));
    }
    return out;
  }

  return {
    name: NAME,

    init(ctx: ProcessCtx): Action[] {
      return sync(ctx);
    },

    onPdu(_ctx: ProcessCtx, pdu: Pdu, port: PortId): Action[] {
      return [{ type: 'drop', pdu, reason: 'unsupported-protocol', detail: 'dhcpv6-client takes datagrams from its udp socket', port }];
    },

    onConfig(ctx: ProcessCtx, delta: ConfigDelta): Action[] {
      if (delta.context[0]?.[0] !== 'interface' || delta.line[0] !== 'ipv6' || delta.line[1] !== 'address') return [];
      return sync(ctx);
    },

    onLinkChange(ctx: ProcessCtx, port: PortId, up: boolean): Action[] {
      const c = clients.get(port);
      if (c === undefined) return [];
      if (up) return c.state === 'idle' ? start(ctx, c, 'link up') : [];
      if (c.state === 'delay' || c.state === 'soliciting' || c.state === 'requesting' || c.state === 'inforeq' || c.state === 'paused') {
        setState(ctx, c, 'idle', 'link down');
        return [cancel(`sol:${c.iface}`), cancel(`dhcpv6-restart:${c.iface}`)];
      }
      return [];
    },

    onTimer(ctx: ProcessCtx, key: string): Action[] {
      const i = key.indexOf(':');
      const kind = key.slice(0, i);
      const c = clients.get(key.slice(i + 1));
      if (c === undefined) return [];
      switch (kind) {
        case 'sol':
          if (c.state === 'delay') return firstMessage(ctx, c);
          if (c.state === 'soliciting' || c.state === 'inforeq') {
            if (c.attempt >= DHCPV6_SOL_TRIES) return pause(ctx, c, `${DHCPV6_SOL_TRIES} ${c.state === 'inforeq' ? 'information requests' : 'solicits'} unanswered`);
            c.attempt++;
            return c.state === 'inforeq' ? inforeq(ctx, c) : solicit(ctx, c);
          }
          if (c.state === 'requesting') {
            if (c.attempt >= DHCPV6_SOL_TRIES) return start(ctx, c, 'request unanswered');
            c.attempt++;
            return request(ctx, c);
          }
          return [];
        case 'dhcpv6-restart':
          return c.state === 'paused' ? start(ctx, c, 'retry after pause') : [];
        case 't1': {
          const l = c.lease;
          const s = c.server;
          if (c.state !== 'bound' || l === undefined || s === undefined) return [];
          beginExchange(ctx, c);
          setState(ctx, c, 'renewing', 'T1');
          return [send(ctx, c, DHCPV6_RENEW, { serverDuid: s.duid, iaid: iaidOf(ctx, c.iface), t1S: 0, t2S: 0, iaAddress: l.address, preferredLifetimeS: l.preferredS, validLifetimeS: l.validS, oro: DHCPV6_ORO, elapsedTimeCs: 0 }, 'dhcpv6-renew')];
        }
        case 't2': {
          const l = c.lease;
          if ((c.state !== 'renewing' && c.state !== 'bound') || l === undefined) return [];
          beginExchange(ctx, c);
          setState(ctx, c, 'rebinding', 'T2');
          return [send(ctx, c, DHCPV6_REBIND, { iaid: iaidOf(ctx, c.iface), t1S: 0, t2S: 0, iaAddress: l.address, preferredLifetimeS: l.preferredS, validLifetimeS: l.validS, oro: DHCPV6_ORO, elapsedTimeCs: 0 }, 'dhcpv6-rebind')];
        }
        case 'valid':
          return [...unbind(ctx, c, 'valid lifetime expired'), ...start(ctx, c, 'valid lifetime expired')];
        case 'info-refresh':
          if (c.state !== 'bound' || c.mode !== 'stateless') return [];
          beginExchange(ctx, c);
          setState(ctx, c, 'inforeq', 'information refresh');
          return inforeq(ctx, c);
        default:
          return [];
      }
    },

    onEvent(ctx: ProcessCtx, ev: ProcessEvent): Action[] {
      if (ev.kind === 'ipv6.ra') {
        raFlags.set(ev.iface, { managed: ev.managed, other: ev.other });
        return sync(ctx);
      }
      if (ev.kind === 'sock.datagram') {
        for (const c of clients.values()) if (ev.socket === socketOf(c)) return onReply(ctx, c, ev.from, ev.pdu);
        return [];
      }
      if (ev.kind === 'sock.error') debug(ctx, `socket ${ev.socket}: ${ev.code}${ev.detail !== undefined ? ` (${ev.detail})` : ''}`, { socket: ev.socket, code: ev.code });
      return [];
    },

    onRequest(): Action[] {
      return [];
    },

    onShutdown(ctx: ProcessCtx): Action[] {
      const out: Action[] = [];
      for (const c of clients.values()) if (c.lease !== undefined) out.push(...release(ctx, c, 'shutdown'));
      return out;
    },

    stateSnapshot(): StateView {
      return {
        process: NAME,
        state: {
          clients: [...clients.values()].map((c) => ({
            iface: c.iface,
            mode: c.mode,
            state: c.state,
            xid: c.xid,
            server: c.server?.address ?? null,
            address: c.lease?.address ?? null,
            dns: [...c.dns],
            domain: c.domain ?? null,
          })),
        },
      };
    },

    debugEvents(): readonly DebugEvent[] {
      return ring;
    },
  };
}
