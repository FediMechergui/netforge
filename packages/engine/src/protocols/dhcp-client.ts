/**
 * protocols/dhcp-client.ts — the DHCPv4 client (RFC 2131 §4.4; RFC 3927 link-local fallback; ARCHITECTURE-P1 §4.3).
 *
 * Silent unless an interface has `ip address dhcp`. Per such interface: socket 'dhcp-client#<iface>'
 * (0.0.0.0:68, receive restricted to the iface), then on link up:
 *   INIT → SELECTING (DISCOVER, xid from `ctx.stream('xid:<iface>')`) → REQUESTING (first OFFER → broadcast REQUEST)
 *   → BOUND (ACK → `ipv4.lease bind`, periodic timers t1/t2/lease, `dhcp.lease` event to dns-client, syslog 6).
 * T1 → RENEWING (unicast REQUEST with ciaddr), T2 → REBINDING (broadcast), expiry → unbind, `dhcp.lease lost`, restart.
 * NAK → unbind and restart. Retransmit timer `dhcp:<iface>` (one-shot) 4, 8, 16, 32 s with ±1 s jitter from
 * `ctx.stream('dhcp-jitter:<iface>')`. After DHCP_DISCOVER_RETRIES unanswered DISCOVERs: APIPA — candidate
 * 169.254.[1..254].[0..255] from `ctx.stream('apipa:<iface>')`, `arp.probe`, a conflict draws the next candidate,
 * else `ipv4.lease bind {prefixLen 16, origin 'apipa'}` — then the periodic `dhcp-restart:<iface>` pause (60 s)
 * starts a new DISCOVER cycle; a later ACK replaces the APIPA address.
 * `no ip address dhcp`, `dhcp.client release` and shutdown send a unicast RELEASE, then unbind.
 * `dhcp.client renew|release` with a session prints one line and ends the job with cliDone; `job.abort {session}`
 * (^C) ends a waiting renew at once with its own line, and the state machine carries on.
 *
 * Debug category 'dhcp' (`debug ip dhcp client`).
 *
 * ponytail: RENEWING/REBINDING send one REQUEST each (at T1 and T2, no retransmits); no INIT-REBOOT, DECLINE or
 * INFORM. Add when a lab needs them.
 */
import { IPV4_ANY, IPV4_BROADCAST, maskToPrefixLen, type Ipv4Address } from '../contracts/addr.js';
import type { PduId, PortId, SessionId } from '../contracts/ids.js';
import type { ConfigDelta } from '../contracts/config.js';
import { MS, SEC } from '../contracts/time.js';
import type { FieldValue, Pdu } from '../contracts/pdu.js';
import type { Action, DebugEvent, Process, ProcessCtx, ProcessRequest, StateView } from '../contracts/process.js';
import {
  DHCP_DEFAULT_LEASE_S,
  DHCP_DISCOVER_RETRIES,
  DHCP_RESTART_PAUSE_NS,
  DHCP_RETRANSMIT_INITIAL_NS,
  DHCP_RETRANSMIT_MAX_NS,
  DHCP_T1_PERMILLE,
  DHCP_T2_PERMILLE,
  type DhcpClientState,
} from '../contracts/services.js';
import type { ProcessEvent } from '../contracts/transport.js';
import { configTextLinesOf } from '../cli/config-text.js';

const NAME = 'dhcp-client';
const CAT = 'dhcp';
const DEBUG_RING = 256;
const PRL = '1,3,6,15,51';

interface Lease {
  address: Ipv4Address;
  prefixLen: number;
  router?: Ipv4Address;
  server: Ipv4Address;
  dns: string[];
  domain?: string;
  leaseS: number;
  boundAt: number;
}

interface Client {
  readonly iface: PortId;
  state: DhcpClientState;
  xid: number;
  /** Transmissions of the current message in this cycle. */
  attempt: number;
  offer?: { address: Ipv4Address; server: Ipv4Address };
  lease?: Lease;
  /** Bound link-local fallback address. */
  apipa?: Ipv4Address;
  session?: SessionId;
}

/** Interfaces with `ip address dhcp` in the running config, in config order. */
function dhcpInterfaces(ctx: ProcessCtx): PortId[] {
  const out: PortId[] = [];
  for (const l of configTextLinesOf(ctx.config.root)) {
    const head = l.context[0];
    if (l.context.length === 1 && head?.[0] === 'interface' && head[1] !== undefined && l.tokens.join(' ') === 'ip address dhcp' && ctx.ports.has(head[1])) {
      out.push(head[1]);
    }
  }
  return out;
}

/** The DHCP layer of a received datagram. */
function dhcpOf(pdu: Pdu): Readonly<Record<string, FieldValue>> | undefined {
  return pdu.layers.find((l) => l.proto === 'dhcp')?.fields;
}

export function createDhcpClient(): Process {
  const clients = new Map<PortId, Client>();
  const ring: DebugEvent[] = [];

  function debug(ctx: ProcessCtx, message: string, data?: Record<string, unknown>): void {
    ctx.debug(CAT, message, data);
    const ev: DebugEvent = data
      ? { at: ctx.now, device: ctx.deviceId, process: NAME, category: CAT, message, data }
      : { at: ctx.now, device: ctx.deviceId, process: NAME, category: CAT, message };
    ring.push(ev);
    if (ring.length > DEBUG_RING) ring.splice(0, ring.length - DEBUG_RING);
  }

  const socketOf = (c: Client): string => `${NAME}#${c.iface}`;

  function setState(ctx: ProcessCtx, c: Client, to: DhcpClientState, why: string): void {
    if (c.state === to) return;
    debug(ctx, `${c.iface}: ${c.state} -> ${to} (${why})`, { iface: c.iface, from: c.state, to, trigger: why });
    c.state = to;
  }

  function send(
    ctx: ProcessCtx,
    c: Client,
    type: string,
    fields: Record<string, FieldValue>,
    to: { dst: Ipv4Address; src: Ipv4Address; tag: string; triggeredBy?: PduId },
  ): Action {
    const dhcp = { op: 1, htype: 1, hlen: 6, xid: c.xid, chaddr: ctx.macOf(c.iface), messageType: type, hostname: ctx.hostname, ...fields };
    debug(ctx, `${c.iface}: send ${type} xid 0x${c.xid.toString(16)} to ${to.dst}`, { iface: c.iface, type, xid: c.xid });
    return {
      type: 'request',
      to: 'udp',
      req: {
        kind: 'udp.send',
        socket: socketOf(c),
        dst: to.dst,
        dstPort: 67,
        src: to.src,
        iface: c.iface,
        tag: to.tag,
        ...(to.triggeredBy !== undefined ? { triggeredBy: to.triggeredBy } : {}),
        app: [{ proto: 'dhcp', fields: dhcp }],
      },
    };
  }

  /** Retransmit delay for `attempt` (1-based): 4 s doubling up to 64 s, ±1 s jitter (one draw). */
  function retransmitDelay(ctx: ProcessCtx, c: Client): number {
    let base = DHCP_RETRANSMIT_INITIAL_NS;
    for (let i = 1; i < c.attempt; i++) base = Math.min(base * 2, DHCP_RETRANSMIT_MAX_NS);
    const jitter = ctx.stream(`dhcp-jitter:${c.iface}`).nextInt(0, 2000) - 1000;
    return base + jitter * MS;
  }

  const timer = (key: string, delay: number, periodic = false): Action => (periodic ? { type: 'timer', key, delay, periodic: true } : { type: 'timer', key, delay });
  const cancel = (key: string): Action => ({ type: 'cancelTimer', key });

  function discover(ctx: ProcessCtx, c: Client): Action[] {
    return [
      send(ctx, c, 'DISCOVER', { broadcastFlag: true, parameterRequestList: PRL }, { dst: IPV4_BROADCAST, src: IPV4_ANY, tag: 'dhcp-discover' }),
      timer(`dhcp:${c.iface}`, retransmitDelay(ctx, c)),
    ];
  }

  function request(ctx: ProcessCtx, c: Client, triggeredBy?: PduId): Action[] {
    const o = c.offer!;
    const to: { dst: Ipv4Address; src: Ipv4Address; tag: string; triggeredBy?: PduId } = { dst: IPV4_BROADCAST, src: IPV4_ANY, tag: 'dhcp-request' };
    if (triggeredBy !== undefined) to.triggeredBy = triggeredBy;
    return [
      send(ctx, c, 'REQUEST', { broadcastFlag: true, requestedIp: o.address, serverId: o.server, parameterRequestList: PRL }, to),
      timer(`dhcp:${c.iface}`, retransmitDelay(ctx, c)),
    ];
  }

  /** New DISCOVER cycle. */
  function start(ctx: ProcessCtx, c: Client, why: string): Action[] {
    if (ctx.ports.get(c.iface)?.operUp !== true) {
      setState(ctx, c, 'INIT', `${why}; waiting for link`);
      return [];
    }
    c.xid = ctx.stream(`xid:${c.iface}`).nextU32();
    c.attempt = 1;
    delete c.offer;
    setState(ctx, c, 'SELECTING', why);
    return discover(ctx, c);
  }

  function leaseEvent(c: Client, op: 'bound' | 'renewed' | 'lost'): Action {
    const ev: ProcessEvent = { kind: 'dhcp.lease', iface: c.iface, op, dnsServers: c.lease?.dns ?? [] };
    if (c.lease?.domain !== undefined) ev.domainName = c.lease.domain;
    return { type: 'event', to: 'dns-client', ev };
  }

  function finishJob(c: Client, text: string): Action[] {
    const s = c.session;
    if (s === undefined) return [];
    delete c.session;
    return [
      { type: 'cliOutput', session: s, text: `${text}\n` },
      { type: 'cliDone', session: s },
    ];
  }

  /** Attach a new job to the client; a job still waiting on this interface is ended first, so no session is left blocked. */
  function takeSession(c: Client, session: SessionId | undefined): Action[] {
    if (session === undefined) return [];
    const out = c.session !== undefined && c.session !== session ? finishJob(c, `${c.iface}: renew interrupted`) : [];
    c.session = session;
    return out;
  }

  /** Drop the lease (or APIPA address): unbind, lease timers off, `dhcp.lease lost`. */
  function unbind(ctx: ProcessCtx, c: Client, why: string): Action[] {
    const out: Action[] = [cancel(`t1:${c.iface}`), cancel(`t2:${c.iface}`), cancel(`lease:${c.iface}`), cancel(`dhcp-restart:${c.iface}`)];
    if (c.lease === undefined && c.apipa === undefined) return out;
    debug(ctx, `${c.iface}: address ${c.lease?.address ?? c.apipa} removed (${why})`, { iface: c.iface, why });
    out.push({ type: 'request', to: 'ipv4', req: { kind: 'ipv4.lease', op: 'unbind', iface: c.iface, address: (c.lease?.address ?? c.apipa)! } });
    if (c.lease !== undefined) out.push(leaseEvent(c, 'lost'));
    delete c.lease;
    delete c.apipa;
    return out;
  }

  function release(ctx: ProcessCtx, c: Client, why: string): Action[] {
    const out: Action[] = [cancel(`dhcp:${c.iface}`)];
    const l = c.lease;
    if (l !== undefined) out.push(send(ctx, c, 'RELEASE', { ciaddr: l.address, serverId: l.server }, { dst: l.server, src: l.address, tag: 'dhcp-release' }));
    out.push(...unbind(ctx, c, why));
    setState(ctx, c, 'INIT', why);
    return out;
  }

  function bind(ctx: ProcessCtx, c: Client, f: Readonly<Record<string, FieldValue>>, pdu: Pdu): Action[] {
    const address = String(f.yiaddr);
    const prefixLen = maskToPrefixLen(String(f.subnetMask ?? '255.255.255.0')) ?? 24;
    const server = String(f.serverId ?? c.offer?.server ?? c.lease?.server ?? IPV4_ANY);
    const leaseS = typeof f.leaseTimeS === 'number' ? f.leaseTimeS : DHCP_DEFAULT_LEASE_S;
    const t1S = typeof f.renewalTimeS === 'number' ? f.renewalTimeS : Math.floor((leaseS * DHCP_T1_PERMILLE) / 1000);
    const t2S = typeof f.rebindingTimeS === 'number' ? f.rebindingTimeS : Math.floor((leaseS * DHCP_T2_PERMILLE) / 1000);
    const renewed = c.lease?.address === address;
    const lease: Lease = { address, prefixLen, server, dns: typeof f.dnsServers === 'string' && f.dnsServers !== '' ? f.dnsServers.split(',') : [], leaseS, boundAt: ctx.now };
    if (typeof f.router === 'string' && f.router !== IPV4_ANY) lease.router = f.router;
    if (typeof f.domainName === 'string' && f.domainName !== '') lease.domain = f.domainName;
    c.lease = lease;
    delete c.apipa;
    delete c.offer;
    setState(ctx, c, 'BOUND', `ACK from ${server}`);
    const req: Extract<ProcessRequest, { kind: 'ipv4.lease' }> = {
      kind: 'ipv4.lease',
      op: 'bind',
      iface: c.iface,
      address,
      prefixLen,
      leaseExpiresAt: ctx.now + leaseS * SEC,
      server,
      origin: 'dhcp',
    };
    if (lease.router !== undefined) req.router = lease.router;
    const infinite = leaseS >= 0xffffffff;
    if (infinite) delete req.leaseExpiresAt;
    // the previous lease's timers always go, or a finite lease renewed as infinite would still expire on the old clock
    const out: Action[] = [
      cancel(`dhcp:${c.iface}`),
      cancel(`dhcp-restart:${c.iface}`),
      cancel(`t1:${c.iface}`),
      cancel(`t2:${c.iface}`),
      cancel(`lease:${c.iface}`),
      { type: 'request', to: 'ipv4', req },
    ];
    if (!infinite) out.push(timer(`t1:${c.iface}`, t1S * SEC, true), timer(`t2:${c.iface}`, t2S * SEC, true), timer(`lease:${c.iface}`, leaseS * SEC, true));
    out.push(leaseEvent(c, renewed ? 'renewed' : 'bound'));
    if (!renewed) out.push({ type: 'log', severity: 6, facility: 'DHCP', message: `Interface ${c.iface} received address ${address}/${prefixLen} from ${server}` });
    debug(ctx, `${c.iface}: bound ${address}/${prefixLen} for ${leaseS} s (pdu ${pdu.id})`, { iface: c.iface, address, prefixLen, pdu: pdu.id });
    out.push(...finishJob(c, `${c.iface}: ${address}/${prefixLen} leased from ${server}`));
    return out;
  }

  // ── APIPA ─────────────────────────────────────────────────────────────────

  function probeNext(ctx: ProcessCtx, c: Client): Action[] {
    const r = ctx.stream(`apipa:${c.iface}`);
    const v = r.nextInt(0, 254 * 256 - 1); // one draw per pick (§5.1) over 169.254.[1..254].[0..255]
    const address = `169.254.${1 + Math.floor(v / 256)}.${v % 256}`;
    debug(ctx, `${c.iface}: no DHCP answer, probing link-local ${address}`, { iface: c.iface, address });
    return [{ type: 'request', to: 'arp', req: { kind: 'arp.probe', owner: NAME, token: `apipa:${c.iface}`, iface: c.iface, address } }];
  }

  function apipaStart(ctx: ProcessCtx, c: Client): Action[] {
    setState(ctx, c, 'APIPA', `${DHCP_DISCOVER_RETRIES} DISCOVERs unanswered`);
    if (c.apipa !== undefined) return [timer(`dhcp-restart:${c.iface}`, DHCP_RESTART_PAUSE_NS, true)];
    return probeNext(ctx, c);
  }

  function apipaResult(ctx: ProcessCtx, c: Client, ev: Extract<ProcessEvent, { kind: 'arp.probeResult' }>): Action[] {
    if (c.state !== 'APIPA') return [];
    if (ev.conflict) return probeNext(ctx, c);
    c.apipa = ev.address;
    debug(ctx, `${c.iface}: using link-local ${ev.address}/16`, { iface: c.iface, address: ev.address });
    return [
      { type: 'request', to: 'ipv4', req: { kind: 'ipv4.lease', op: 'bind', iface: c.iface, address: ev.address, prefixLen: 16, origin: 'apipa' } },
      timer(`dhcp-restart:${c.iface}`, DHCP_RESTART_PAUSE_NS, true),
      ...finishJob(c, `${c.iface}: no DHCP server answered; using ${ev.address}/16`),
    ];
  }

  // ── receive ───────────────────────────────────────────────────────────────

  function onReply(ctx: ProcessCtx, c: Client, pdu: Pdu): Action[] {
    const f = dhcpOf(pdu);
    if (f === undefined || f.op !== 2 || f.xid !== c.xid || f.chaddr !== ctx.macOf(c.iface)) return [];
    const type = String(f.messageType);
    if (type === 'OFFER' && c.state === 'SELECTING') {
      c.offer = { address: String(f.yiaddr), server: String(f.serverId ?? ipOfSender(pdu)) };
      c.attempt = 1;
      setState(ctx, c, 'REQUESTING', `OFFER ${c.offer.address} from ${c.offer.server}`);
      return request(ctx, c, pdu.id);
    }
    const waiting = c.state === 'REQUESTING' || c.state === 'RENEWING' || c.state === 'REBINDING';
    if (type === 'ACK' && waiting) return bind(ctx, c, f, pdu);
    if (type === 'NAK' && waiting) {
      debug(ctx, `${c.iface}: NAK from ${String(f.serverId ?? ipOfSender(pdu))}`, { iface: c.iface, pdu: pdu.id });
      // the new cycle waits for the retransmit timer: a server that NAKs every offer cannot spin the simulation
      setState(ctx, c, 'INIT', 'NAK');
      return [...unbind(ctx, c, 'NAK'), timer(`dhcp:${c.iface}`, DHCP_RETRANSMIT_INITIAL_NS)];
    }
    return [];
  }

  function ipOfSender(pdu: Pdu): string {
    return String(pdu.layers.find((l) => l.proto === 'ipv4')?.fields.src ?? IPV4_ANY);
  }

  // ── lifecycle ─────────────────────────────────────────────────────────────

  function add(ctx: ProcessCtx, iface: PortId): Action[] {
    const c: Client = { iface, state: 'INIT', xid: 0, attempt: 0 };
    clients.set(iface, c);
    debug(ctx, `${iface}: DHCP client enabled`, { iface });
    return [
      { type: 'request', to: 'udp', req: { kind: 'udp.open', owner: NAME, socket: socketOf(c), family: 4, localAddr: IPV4_ANY, localPort: 68, iface } },
      ...start(ctx, c, 'enabled'),
    ];
  }

  function removeClient(ctx: ProcessCtx, c: Client, why: string): Action[] {
    // (a static address that replaced the lease is safe: ipv4 only unbinds leased entries)
    const out = release(ctx, c, why);
    out.push({ type: 'request', to: 'udp', req: { kind: 'udp.close', socket: socketOf(c) } }, ...finishJob(c, `${c.iface}: DHCP client disabled`));
    clients.delete(c.iface);
    return out;
  }

  function sync(ctx: ProcessCtx): Action[] {
    const want = dhcpInterfaces(ctx);
    const out: Action[] = [];
    for (const c of [...clients.values()]) if (!want.includes(c.iface)) out.push(...removeClient(ctx, c, 'no ip address dhcp'));
    for (const iface of want) if (!clients.has(iface)) out.push(...add(ctx, iface));
    return out;
  }

  return {
    name: NAME,

    init(ctx: ProcessCtx): Action[] {
      return sync(ctx);
    },

    onPdu(_ctx: ProcessCtx, pdu: Pdu, port: PortId): Action[] {
      return [{ type: 'drop', pdu, reason: 'unsupported-protocol', detail: 'dhcp-client takes datagrams from its udp socket', port }];
    },

    onConfig(ctx: ProcessCtx, delta: ConfigDelta): Action[] {
      if (delta.line[0] !== 'ip' || delta.line[1] !== 'address' || delta.context[0]?.[0] !== 'interface') return [];
      return sync(ctx);
    },

    onLinkChange(ctx: ProcessCtx, port: PortId, up: boolean): Action[] {
      const c = clients.get(port);
      if (c === undefined) return [];
      if (up) return c.state === 'INIT' ? start(ctx, c, 'link up') : [];
      if (c.state === 'SELECTING' || c.state === 'REQUESTING') {
        setState(ctx, c, 'INIT', 'link down');
        return [cancel(`dhcp:${c.iface}`)];
      }
      return [];
    },

    onTimer(ctx: ProcessCtx, key: string): Action[] {
      const i = key.indexOf(':');
      const kind = key.slice(0, i);
      const c = clients.get(key.slice(i + 1));
      if (c === undefined) return [];
      switch (kind) {
        case 'dhcp':
          if (c.state === 'INIT') return start(ctx, c, 'restart after NAK');
          if (c.state === 'SELECTING') {
            if (c.attempt >= DHCP_DISCOVER_RETRIES) return apipaStart(ctx, c);
            c.attempt++;
            return discover(ctx, c);
          }
          if (c.state === 'REQUESTING') {
            if (c.attempt >= DHCP_DISCOVER_RETRIES) return start(ctx, c, 'REQUEST unanswered');
            c.attempt++;
            return request(ctx, c);
          }
          return [];
        case 'dhcp-restart':
          return c.state === 'APIPA' ? start(ctx, c, 'retry after link-local fallback') : [];
        case 't1': {
          const l = c.lease;
          if (c.state !== 'BOUND' || l === undefined) return [];
          setState(ctx, c, 'RENEWING', 'T1');
          return [send(ctx, c, 'REQUEST', { ciaddr: l.address, parameterRequestList: PRL }, { dst: l.server, src: l.address, tag: 'dhcp-request' })];
        }
        case 't2': {
          const l = c.lease;
          if ((c.state !== 'RENEWING' && c.state !== 'BOUND') || l === undefined) return [];
          setState(ctx, c, 'REBINDING', 'T2');
          return [send(ctx, c, 'REQUEST', { ciaddr: l.address, parameterRequestList: PRL }, { dst: IPV4_BROADCAST, src: l.address, tag: 'dhcp-request' })];
        }
        case 'lease':
          return [...unbind(ctx, c, 'lease expired'), ...start(ctx, c, 'lease expired')];
        default:
          return [];
      }
    },

    onEvent(ctx: ProcessCtx, ev: ProcessEvent): Action[] {
      if (ev.kind === 'sock.datagram') {
        for (const c of clients.values()) if (ev.socket === socketOf(c)) return onReply(ctx, c, ev.pdu);
        return [];
      }
      if (ev.kind === 'arp.probeResult') {
        const c = clients.get(ev.iface);
        return c !== undefined && ev.token === `apipa:${c.iface}` ? apipaResult(ctx, c, ev) : [];
      }
      if (ev.kind === 'sock.error') debug(ctx, `socket ${ev.socket}: ${ev.code}${ev.detail !== undefined ? ` (${ev.detail})` : ''}`, { socket: ev.socket, code: ev.code });
      return [];
    },

    onRequest(ctx: ProcessCtx, req: ProcessRequest): Action[] {
      if (req.kind === 'job.abort') {
        // ^C on a blocking /renew: end the job now, or its late line and cliDone would land in whatever runs next
        const c = [...clients.values()].find((x) => x.session === req.session);
        if (c === undefined) return [];
        debug(ctx, `${c.iface}: renew job aborted`, { iface: c.iface, session: req.session });
        return finishJob(c, `${c.iface}: renew aborted`);
      }
      if (req.kind !== 'dhcp.client') return [];
      const c = clients.get(req.iface);
      if (c === undefined) {
        return req.session === undefined
          ? []
          : [
              { type: 'cliOutput', session: req.session, text: `${req.iface} is not configured for DHCP\n` },
              { type: 'cliDone', session: req.session },
            ];
      }
      if (req.op === 'release') {
        const out = [...takeSession(c, req.session), ...release(ctx, c, 'release requested')];
        out.push(...finishJob(c, `${c.iface}: address released`));
        return out;
      }
      const out = takeSession(c, req.session);
      const l = c.lease;
      if (c.state === 'BOUND' && l !== undefined) {
        setState(ctx, c, 'RENEWING', 'renew requested');
        out.push(send(ctx, c, 'REQUEST', { ciaddr: l.address, parameterRequestList: PRL }, { dst: l.server, src: l.address, tag: 'dhcp-request' }));
        return out;
      }
      return [...out, cancel(`dhcp:${c.iface}`), ...start(ctx, c, 'renew requested')];
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
            state: c.state,
            xid: c.xid,
            offer: c.offer ?? null,
            lease: c.lease ?? null,
            apipa: c.apipa ?? null,
          })),
        },
      };
    },

    debugEvents(): readonly DebugEvent[] {
      return ring;
    },
  };
}
