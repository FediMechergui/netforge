/**
 * protocols/udp.ts — the UDP daemon and its socket layer (RFC 768; RFC 1122 §4.1.3; RFC 8200 §8.1;
 * ARCHITECTURE-P1 §4.2, contracts/transport.ts).
 *
 * Applications never build UDP headers themselves. They talk to this daemon with ProcessRequests and receive
 * ProcessEvents through `Action {type:'event'}`:
 *  • `udp.open {owner, socket, family, localAddr?, localPort?, iface?}` binds a socket and answers `sock.opened`.
 *    The socket id is chosen by the owner, so it may send right away. A duplicate id or a conflicting bind answers
 *    `sock.error addr-in-use` (the socket never opened). A localPort of 0 or none takes an ephemeral port.
 *  • `udp.send {socket, dst, dstPort, src?, iface?, ttl?, cause?, tag?, triggeredBy?, data | app}` builds
 *    `[ipv4|ipv6, udp, app… | payload]` and hands it to `ipv4.send` / `ipv6.send`. Send-time failures
 *    (no source address, no route, family mismatch) answer `sock.error`; the socket stays open.
 *  • `udp.close {socket}` removes the socket and answers `sock.closed`. It is the ONLY way a UDP socket closes.
 *
 * Binding (contracts/transport.ts header): the conflict key is (proto, family, localAddr, localPort, iface ?? '*').
 * Two binds conflict only when family and port match, the addresses are equal (or either is the wildcard) and the
 * ifaces are equal (or either is unrestricted). A specific localAddr must be one of this device's addresses.
 *
 * Ephemeral ports: the first ephemeral bind draws ONE value from the process stream (`process:udp`, §5.1):
 * `49152 + rng.nextInt(0, 16383)`. Later binds walk sequentially from the last port handed out, wrapping from
 * 65535 to 49152 and skipping ports whose bind would conflict. No other draw is ever made, so a device whose
 * applications never bind an ephemeral port never touches the stream.
 *
 * Receive (`onPdu`, delivered by ipv4/ipv6 for protocol 17, and by icmpv4/icmpv6 for errors quoting UDP):
 *  • A datagram: a malformed header is dropped `other`; a checksum mismatch is dropped `bad-checksum` (IPv4: a
 *    transmitted 0 means "no checksum" and is accepted; IPv6: the checksum is mandatory, so 0 is a mismatch).
 *    The socket is matched on the destination port, then in the order exact address + iface, exact address,
 *    wildcard + iface, wildcard (a socket restricted to another iface never matches). A match consumes the PDU
 *    and sends `sock.datagram` to the owner. No match: drop `unsupported-protocol` with detail
 *    'udp port N closed', plus `icmp.error(3,3)` / `icmp6.error(1,4)` when the destination was unicast
 *    (RFC 1122 §4.1.3.1; never for broadcast or multicast).
 *  • An ICMP error (v4 types 3/11, v6 types 1/3, and v6 parameter problem code 1): the quoted UDP header names the
 *    local socket (quoted source address and port). The owner receives `sock.error` with the mapped code,
 *    `from` (the reporting node) and `icmp {type, code, quotedDstPort, quotedTtl, pdu}`. The socket stays open
 *    (review finding 7): traceroute keeps probing through time-exceeded and port-unreachable replies.
 *
 * Silence (§5.3): this daemon sends nothing by itself; it only answers requests and received datagrams.
 *
 * P2 tunnel sockets (ARCHITECTURE-P2 §2.4 `udp.open` `tunnel`, §3.12 steps 7–8; W5 wireless): `udp.open {…, tunnel:
 * true}` binds exactly like any other socket (same conflict key, same `sockets` row), but a datagram matched to it is
 * delivered as `sock.datagram` WITHOUT the `consume` action: the owner takes over the PDU's lifecycle (it rewraps and
 * forwards the same PduId, or consumes or drops it itself). Only capwap-ac and capwap-wtp open one, for the CAPWAP data
 * channel (5247), so a tunnelled frame keeps one PduId end to end and shows no `pduConsumed` before the station or the
 * gateway. Every other path — the checksum check, the closed-port drop, ICMP errors reported as `sock.error`, the
 * counters — is the same for tunnel and ordinary sockets. A socket without `tunnel` behaves exactly as before, so no
 * P1 trace or StateView changes (the `tunnel` key appears in the StateView only for a tunnel socket).
 *
 * Debug category: 'udp'.
 *
 * stateSnapshot():
 *   { process: 'udp', state: { sockets: [{ id, owner, family, localAddr, localPort, iface?, tunnel? }], ephemeralNext,
 *     datagramsIn, datagramsOut, noPort, checksumErrors, icmpErrors } }
 *   `ephemeralNext` is null until the first ephemeral bind; `tunnel: true` only on a tunnel socket.
 */
import { IPV4_ANY, IPV6_ANY, isIpv4, isIpv4Broadcast, isIpv4Multicast, type IpAddress, type IpFamily } from '../contracts/addr.js';
import type { PortId, ProcessName } from '../contracts/ids.js';
import type { DropReason } from '../contracts/link.js';
import {
  ICMP_DEST_UNREACHABLE,
  ICMP_TIME_EXCEEDED,
  ICMP_UNREACH_PORT,
  ICMP_UNREACH_PROTOCOL,
  ICMPV6_DEST_UNREACHABLE,
  ICMPV6_PARAM_PROBLEM,
  ICMPV6_TIME_EXCEEDED,
  ICMPV6_UNREACH_NO_ROUTE,
  ICMPV6_UNREACH_PORT,
  IPPROTO_UDP,
  UDP_HEADER,
  type LayerSpec,
  type LayerView,
  type Pdu,
  type PduMeta,
} from '../contracts/pdu.js';
import type { Action, DebugEvent, Process, ProcessCtx, ProcessRequest, StateView } from '../contracts/process.js';
import { socketKey, type SocketRow, type Table } from '../contracts/tables.js';
import {
  EPHEMERAL_PORT_MAX,
  EPHEMERAL_PORT_MIN,
  type ProcessEvent,
  type SocketErrorCode,
  type SocketId,
} from '../contracts/transport.js';
import { flowKey, normalizeIpv6, parseIpv6 } from '../core/addr6.js';

/** Process name, as registered in the protocol registry. */
const NAME = 'udp';
/** Debug category (`debug udp`). */
const CAT = 'udp';
/** Number of DebugEvents retained by `debugEvents()`. */
const DEBUG_RING = 256;
/** Size of the ephemeral range (49152..65535). */
const EPHEMERAL_SPAN = EPHEMERAL_PORT_MAX - EPHEMERAL_PORT_MIN + 1;
/** IPv6 extension headers skipped when looking for the upper-layer header. */
const IPV6_EXTENSIONS: ReadonlySet<string> = new Set(['ipv6-hopopts', 'ipv6-route', 'ipv6-frag', 'ipv6-dstopts']);

/** A bound UDP socket. */
export interface UdpSocket {
  readonly id: SocketId;
  readonly owner: ProcessName;
  readonly family: IpFamily;
  /** Canonical text; '0.0.0.0' / '::' for a wildcard bind. */
  readonly localAddr: IpAddress;
  readonly localPort: number;
  /** Receive restricted to this port (DHCP client sockets). */
  readonly iface?: PortId;
  /**
   * @since P2 (wireless) A tunnel socket (`udp.open {tunnel: true}`, §2.4): a matched datagram is handed to the owner
   * without the `consume` action, so the owner carries the same PduId on. Absent on every ordinary socket.
   */
  readonly tunnel?: true;
}

/** The part of a bind that decides conflicts. */
export interface UdpBindKey {
  readonly family: IpFamily;
  readonly localAddr: IpAddress;
  readonly localPort: number;
  readonly iface?: PortId;
}

/** Wildcard address of a family. */
export function udpWildcard(family: IpFamily): IpAddress {
  return family === 4 ? IPV4_ANY : IPV6_ANY;
}

/** True when `addr` is the wildcard address of `family`. */
function isWildcard(family: IpFamily, addr: IpAddress): boolean {
  return addr === udpWildcard(family);
}

/**
 * Do two binds conflict? Only when family and port match, the addresses are equal (or either is the wildcard)
 * and the ifaces are equal (or either is unrestricted) — the contracts/transport.ts conflict key.
 */
export function udpBindsConflict(a: UdpBindKey, b: UdpBindKey): boolean {
  if (a.family !== b.family || a.localPort !== b.localPort) return false;
  const addrOverlap = a.localAddr === b.localAddr || isWildcard(a.family, a.localAddr) || isWildcard(b.family, b.localAddr);
  if (!addrOverlap) return false;
  return a.iface === undefined || b.iface === undefined || a.iface === b.iface;
}

/**
 * Ephemeral port search: starting at `start` (inside 49152..65535), the first port for which `isFree` holds,
 * walking upwards and wrapping from 65535 to 49152. Undefined when the whole range is in use.
 */
export function nextEphemeralPort(start: number, isFree: (port: number) => boolean): number | undefined {
  const origin = start >= EPHEMERAL_PORT_MIN && start <= EPHEMERAL_PORT_MAX ? start - EPHEMERAL_PORT_MIN : 0;
  for (let i = 0; i < EPHEMERAL_SPAN; i++) {
    const port = EPHEMERAL_PORT_MIN + ((origin + i) % EPHEMERAL_SPAN);
    if (isFree(port)) return port;
  }
  return undefined;
}

/** Rank of a socket for a received datagram (lower wins), or undefined when it does not match at all. */
function receiveRank(s: UdpSocket, dst: IpAddress, port: PortId): number | undefined {
  if (s.iface !== undefined && s.iface !== port) return undefined;
  const exact = s.localAddr === dst;
  if (!exact && !isWildcard(s.family, s.localAddr)) return undefined;
  if (exact) return s.iface !== undefined ? 0 : 1;
  return s.iface !== undefined ? 2 : 3;
}

/**
 * Pick the socket that receives a datagram for (family, dst, dstPort) arriving on `port`: exact address + iface,
 * exact address, wildcard + iface, wildcard; ties go to the earlier bind (insertion order).
 */
export function matchUdpSocket(sockets: Iterable<UdpSocket>, family: IpFamily, dst: IpAddress, dstPort: number, port: PortId): UdpSocket | undefined {
  let best: UdpSocket | undefined;
  let bestRank = Number.POSITIVE_INFINITY;
  for (const s of sockets) {
    if (s.family !== family || s.localPort !== dstPort) continue;
    const rank = receiveRank(s, dst, port);
    if (rank !== undefined && rank < bestRank) {
      best = s;
      bestRank = rank;
    }
  }
  return best;
}

/**
 * Socket error code for an ICMP / ICMPv6 error, or undefined for messages that do not concern a UDP sender
 * (packet too big, other parameter problems).
 *  v4 3/0,6,9,11 → net-unreachable; 3/2 → proto-unreachable; 3/3 → port-unreachable; other 3/x → host-unreachable;
 *  11/x → ttl-exceeded. v6 1/0 → net-unreachable; 1/4 → port-unreachable; other 1/x (3 address unreachable, 1 prohibited) →
 *  host-unreachable;
 *  3/x → ttl-exceeded; 4/1 (unrecognised next header) → proto-unreachable.
 */
export function udpErrorCodeFor(family: IpFamily, type: number, code: number): SocketErrorCode | undefined {
  if (family === 4) {
    if (type === ICMP_TIME_EXCEEDED) return 'ttl-exceeded';
    if (type !== ICMP_DEST_UNREACHABLE) return undefined;
    if (code === ICMP_UNREACH_PORT) return 'port-unreachable';
    if (code === ICMP_UNREACH_PROTOCOL) return 'proto-unreachable';
    if (code === 0 || code === 6 || code === 9 || code === 11) return 'net-unreachable';
    return 'host-unreachable';
  }
  if (type === ICMPV6_TIME_EXCEEDED) return 'ttl-exceeded';
  if (type === ICMPV6_DEST_UNREACHABLE) {
    if (code === ICMPV6_UNREACH_PORT) return 'port-unreachable';
    if (code === ICMPV6_UNREACH_NO_ROUTE) return 'net-unreachable';
    return 'host-unreachable';
  }
  if (type === ICMPV6_PARAM_PROBLEM && code === 1) return 'proto-unreachable';
  return undefined;
}

/** Plain-words label of a socket error code, for details and debug lines. */
function errorWords(code: SocketErrorCode): string {
  switch (code) {
    case 'ttl-exceeded':
      return 'time to live exceeded in transit';
    case 'port-unreachable':
      return 'port unreachable';
    case 'proto-unreachable':
      return 'protocol unreachable';
    case 'net-unreachable':
      return 'network unreachable';
    case 'host-unreachable':
      return 'host unreachable';
    default:
      return code;
  }
}

/** Canonical form of `addr` in `family`, or null when it does not belong to that family. */
export function canonical(family: IpFamily, addr: string): IpAddress | null {
  if (family === 4) return isIpv4(addr) ? addr : null;
  return normalizeIpv6(addr);
}

/** Is an IPv6 address multicast (ff00::/8)? */
function isMulticast6(addr: IpAddress): boolean {
  const b = parseIpv6(addr);
  return b !== null && b[0] === 0xff;
}

/** Is an IPv6 address link-scoped (fe80::/10, or multicast of link scope or narrower)? */
function isLinkScoped6(addr: IpAddress): boolean {
  const b = parseIpv6(addr);
  if (b === null) return false;
  if (b[0] === 0xfe && (b[1]! & 0xc0) === 0x80) return true;
  return b[0] === 0xff && (b[1]! & 0x0f) <= 2;
}

/** Index of the first IP layer (ipv4/ipv6) at or after `from`, or -1. */
export function ipIndexFrom(layers: readonly LayerView[], from: number): number {
  for (let i = from; i < layers.length; i++) {
    const p = layers[i]!.proto;
    if (p === 'ipv4' || p === 'ipv6') return i;
  }
  return -1;
}

/** Index of the upper-layer header after the IP layer at `ipIdx` (IPv6 extension headers skipped), or -1. */
export function upperIndex(layers: readonly LayerView[], ipIdx: number): number {
  let i = ipIdx + 1;
  if (layers[ipIdx]?.proto === 'ipv6') while (i < layers.length && IPV6_EXTENSIONS.has(layers[i]!.proto)) i++;
  return i < layers.length ? i : -1;
}

/**
 * Create the UDP daemon. Reached via `deliver` (datagrams from ipv4/ipv6, ICMP errors quoting UDP from
 * icmpv4/icmpv6) and requests (`udp.open`, `udp.send`, `udp.close`); it has no wire selector and sends nothing
 * unsolicited.
 */
export function createUdp(): Process {
  const sockets = new Map<SocketId, UdpSocket>();
  const ring: DebugEvent[] = [];
  /** Next ephemeral port to try; undefined until the one per-lifetime draw. */
  let ephemeralNext: number | undefined;
  let ipId = 0;
  let datagramsIn = 0;
  let datagramsOut = 0;
  let noPort = 0;
  let checksumErrors = 0;
  let icmpErrors = 0;

  function debug(ctx: ProcessCtx, message: string, data?: Record<string, unknown>): void {
    ctx.debug(CAT, message, data);
    const ev: DebugEvent = data
      ? { at: ctx.now, device: ctx.deviceId, process: NAME, category: CAT, message, data }
      : { at: ctx.now, device: ctx.deviceId, process: NAME, category: CAT, message };
    ring.push(ev);
    if (ring.length > DEBUG_RING) ring.splice(0, ring.length - DEBUG_RING);
  }

  function event(to: ProcessName, ev: ProcessEvent): Action {
    return { type: 'event', to, ev };
  }

  function sockError(ctx: ProcessCtx, owner: ProcessName, socket: SocketId, code: SocketErrorCode, detail: string): Action {
    debug(ctx, `socket ${socket}: ${code} (${detail})`, { socket, code, owner });
    return event(owner, { kind: 'sock.error', socket, code, detail });
  }

  function drop(ctx: ProcessCtx, pdu: Pdu, reason: DropReason, detail: string, port: PortId): Action {
    debug(ctx, `drop pdu ${pdu.id}: ${reason} (${detail})`, { pdu: pdu.id, reason, detail, port });
    return { type: 'drop', pdu, reason, detail, port };
  }

  function table(ctx: ProcessCtx): Table<SocketRow> | undefined {
    return ctx.tables.get<SocketRow>('sockets');
  }

  function writeRow(ctx: ProcessCtx, s: UdpSocket): void {
    const row: SocketRow = {
      key: socketKey('udp', s.id),
      id: s.id,
      proto: 'udp',
      family: s.family,
      localAddr: s.localAddr,
      localPort: s.localPort,
      state: 'BOUND',
      owner: s.owner,
      updatedAt: ctx.now,
    };
    if (s.iface !== undefined) row.iface = s.iface;
    table(ctx)?.set(row);
  }

  function conflicts(key: UdpBindKey): UdpSocket | undefined {
    for (const s of sockets.values()) if (udpBindsConflict(s, key)) return s;
    return undefined;
  }

  /** Allocate an ephemeral port for a bind of (family, localAddr, iface); draws the base once per lifetime. */
  function allocateEphemeral(ctx: ProcessCtx, family: IpFamily, localAddr: IpAddress, iface: PortId | undefined): number | undefined {
    if (ephemeralNext === undefined) {
      ephemeralNext = EPHEMERAL_PORT_MIN + ctx.rng.nextInt(0, EPHEMERAL_SPAN - 1);
      debug(ctx, `ephemeral ports start at ${ephemeralNext}`, { base: ephemeralNext });
    }
    const port = nextEphemeralPort(ephemeralNext, (p) => {
      const key: UdpBindKey = iface === undefined ? { family, localAddr, localPort: p } : { family, localAddr, localPort: p, iface };
      return conflicts(key) === undefined;
    });
    if (port !== undefined) ephemeralNext = port === EPHEMERAL_PORT_MAX ? EPHEMERAL_PORT_MIN : port + 1;
    return port;
  }

  /** Is `addr` (canonical, family-checked) one of this device's own addresses? */
  function isOwnAddress(ctx: ProcessCtx, family: IpFamily, addr: IpAddress): boolean {
    if (family === 4) return ctx.ownAddress(addr) !== undefined;
    return ctx.ownAddress6(addr) !== undefined;
  }

  // ── requests ──────────────────────────────────────────────────────────────

  function open(ctx: ProcessCtx, req: Extract<ProcessRequest, { kind: 'udp.open' }>): Action[] {
    const { owner, socket, family } = req;
    if (sockets.has(socket)) return [sockError(ctx, owner, socket, 'addr-in-use', `socket id ${socket} is already open`)];
    if (family !== 4 && family !== 6) return [sockError(ctx, owner, socket, 'bad-socket', `unknown address family ${String(family)}`)];
    let localAddr: IpAddress = udpWildcard(family);
    if (req.localAddr !== undefined) {
      const c = canonical(family, req.localAddr);
      if (c === null) return [sockError(ctx, owner, socket, 'bad-socket', `${req.localAddr} is not an IPv${family} address`)];
      if (!isWildcard(family, c) && !isOwnAddress(ctx, family, c)) {
        return [sockError(ctx, owner, socket, 'no-address', `${c} is not an address of this device`)];
      }
      localAddr = c;
    }
    const iface = req.iface;
    if (iface !== undefined && !ctx.ports.has(iface)) return [sockError(ctx, owner, socket, 'bad-socket', `no interface ${iface} on this device`)];
    let localPort: number;
    if (req.localPort === undefined || req.localPort === 0) {
      const p = allocateEphemeral(ctx, family, localAddr, iface);
      if (p === undefined) return [sockError(ctx, owner, socket, 'addr-in-use', 'every ephemeral port is in use')];
      localPort = p;
    } else {
      if (!Number.isInteger(req.localPort) || req.localPort < 1 || req.localPort > 0xffff) {
        return [sockError(ctx, owner, socket, 'bad-socket', `port ${String(req.localPort)} is outside 1-65535`)];
      }
      localPort = req.localPort;
      const key: UdpBindKey = iface === undefined ? { family, localAddr, localPort } : { family, localAddr, localPort, iface };
      const clash = conflicts(key);
      if (clash !== undefined) {
        return [sockError(ctx, owner, socket, 'addr-in-use', `port ${localPort} is already bound by ${clash.id}`)];
      }
    }
    const bound: UdpSocket = iface === undefined ? { id: socket, owner, family, localAddr, localPort } : { id: socket, owner, family, localAddr, localPort, iface };
    // P2 (§2.4): a tunnel socket carries the flag; an ordinary socket is built exactly as before (no extra key)
    const s: UdpSocket = req.tunnel === true ? { ...bound, tunnel: true } : bound;
    sockets.set(socket, s);
    writeRow(ctx, s);
    if (s.tunnel === true) {
      debug(ctx, `socket ${socket} bound to ${flowEndpoint(family, localAddr, localPort)}${iface !== undefined ? ` on ${iface}` : ''} for ${owner} as a tunnel socket`, {
        socket,
        owner,
        family,
        localAddr,
        localPort,
        iface,
        tunnel: true,
      });
    } else {
      debug(ctx, `socket ${socket} bound to ${flowEndpoint(family, localAddr, localPort)}${iface !== undefined ? ` on ${iface}` : ''} for ${owner}`, {
        socket,
        owner,
        family,
        localAddr,
        localPort,
        iface,
      });
    }
    return [event(owner, { kind: 'sock.opened', socket, proto: 'udp', family, localAddr, localPort })];
  }

  function close(ctx: ProcessCtx, req: Extract<ProcessRequest, { kind: 'udp.close' }>): Action[] {
    const s = sockets.get(req.socket);
    if (s === undefined) {
      debug(ctx, `close of unknown socket ${req.socket} ignored`, { socket: req.socket });
      return [];
    }
    sockets.delete(req.socket);
    table(ctx)?.delete(socketKey('udp', s.id), 'cleared');
    debug(ctx, `socket ${s.id} closed (port ${s.localPort})`, { socket: s.id, owner: s.owner, localPort: s.localPort });
    return [event(s.owner, { kind: 'sock.closed', socket: s.id })];
  }

  /** Source address for a send, or an error code + detail. */
  function sourceFor(
    ctx: ProcessCtx,
    s: UdpSocket,
    dst: IpAddress,
    iface: PortId | undefined,
  ): { address: IpAddress } | { code: SocketErrorCode; detail: string } {
    if (!isWildcard(s.family, s.localAddr)) return { address: s.localAddr };
    if (s.family === 4) {
      if (iface !== undefined) {
        const a = ctx.ports.get(iface)?.l3.ipv4?.address;
        if (a !== undefined) return { address: a };
        return { code: 'no-address', detail: `no IPv4 address on ${iface} to send from` };
      }
      if (isIpv4Broadcast(dst)) return { code: 'no-route', detail: 'limited broadcast needs an egress interface' };
      const sel = ctx.sourceFor(dst);
      if (sel !== undefined) return { address: sel.address };
      if (ctx.lpm(dst).winner !== undefined) return { code: 'no-address', detail: `the interface towards ${dst} has no IPv4 address` };
      return { code: 'no-route', detail: `no route to ${dst}` };
    }
    if (iface === undefined && (isLinkScoped6(dst) || isMulticast6(dst))) {
      return { code: 'no-route', detail: `${dst} is link-scoped or multicast and needs an egress interface` };
    }
    const sel = ctx.sourceFor6(dst, iface);
    if (sel !== undefined) return { address: sel.address };
    if (iface !== undefined || ctx.lpm6(dst).winner !== undefined) {
      return { code: 'no-address', detail: `no usable IPv6 source address towards ${dst}` };
    }
    return { code: 'no-route', detail: `no route to ${dst}` };
  }

  function send(ctx: ProcessCtx, req: Extract<ProcessRequest, { kind: 'udp.send' }>): Action[] {
    const s = sockets.get(req.socket);
    if (s === undefined) {
      debug(ctx, `send on unknown socket ${req.socket} ignored`, { socket: req.socket });
      return [];
    }
    const dst = canonical(s.family, req.dst);
    if (dst === null) return [sockError(ctx, s.owner, s.id, 'bad-socket', `${req.dst} is not an IPv${s.family} address`)];
    if (!Number.isInteger(req.dstPort) || req.dstPort < 1 || req.dstPort > 0xffff) {
      return [sockError(ctx, s.owner, s.id, 'bad-socket', `destination port ${String(req.dstPort)} is outside 1-65535`)];
    }
    if (req.ttl !== undefined && (!Number.isInteger(req.ttl) || req.ttl < 1 || req.ttl > 255)) {
      return [sockError(ctx, s.owner, s.id, 'bad-socket', `time to live ${String(req.ttl)} is outside 1-255`)];
    }
    const iface = req.iface ?? s.iface;
    if (iface !== undefined && !ctx.ports.has(iface)) return [sockError(ctx, s.owner, s.id, 'bad-socket', `no interface ${iface} on this device`)];
    let src: IpAddress;
    if (req.src !== undefined) {
      const c = canonical(s.family, req.src);
      if (c === null) return [sockError(ctx, s.owner, s.id, 'bad-socket', `${req.src} is not an IPv${s.family} address`)];
      src = c;
    } else {
      const sel = sourceFor(ctx, s, dst, iface);
      if ('code' in sel) return [sockError(ctx, s.owner, s.id, sel.code, sel.detail)];
      src = sel.address;
    }

    const upper: LayerSpec[] = [];
    if (req.app !== undefined) upper.push(...req.app);
    else if (req.data !== undefined && req.data.length > 0) upper.push({ proto: 'payload', fields: { data: req.data } });
    const udp: LayerSpec = { proto: 'udp', fields: { srcPort: s.localPort, dstPort: req.dstPort } };
    let ip: LayerSpec;
    if (s.family === 4) {
      ipId = (ipId + 1) & 0xffff;
      ip = { proto: 'ipv4', fields: { src, dst, protocol: IPPROTO_UDP, ttl: req.ttl ?? ctx.model.ipDefaults.ttl, id: ipId } };
    } else {
      ip = { proto: 'ipv6', fields: { src, dst, nextHeader: IPPROTO_UDP, hopLimit: req.ttl ?? ctx.model.ipDefaults.hopLimit } };
    }
    const meta: Partial<PduMeta> = {
      flow: flowKey(s.family, src, dst, 'udp', s.localPort, req.dstPort),
      ...(req.tag !== undefined ? { tag: req.tag } : {}),
      ...(req.triggeredBy !== undefined ? { triggeredBy: req.triggeredBy } : {}),
    };
    const pdu = ctx.newPdu([ip, udp, ...upper], meta);
    datagramsOut++;
    debug(ctx, `send ${flowEndpoint(s.family, src, s.localPort)} > ${flowEndpoint(s.family, dst, req.dstPort)} from socket ${s.id}`, {
      socket: s.id,
      pdu: pdu.id,
      iface,
    });
    if (s.family === 4) {
      const r: Extract<ProcessRequest, { kind: 'ipv4.send' }> = { kind: 'ipv4.send', pdu };
      if (req.cause !== undefined) r.cause = req.cause;
      if (iface !== undefined) r.iface = iface;
      return [{ type: 'request', to: 'ipv4', req: r }];
    }
    const r: Extract<ProcessRequest, { kind: 'ipv6.send' }> = { kind: 'ipv6.send', pdu };
    if (req.cause !== undefined) r.cause = req.cause;
    if (iface !== undefined) r.iface = iface;
    return [{ type: 'request', to: 'ipv6', req: r }];
  }

  // ── receive ───────────────────────────────────────────────────────────────

  function receiveDatagram(ctx: ProcessCtx, pdu: Pdu, ipLayer: LayerView, udpLayer: LayerView, port: PortId): Action[] {
    const family: IpFamily = ipLayer.proto === 'ipv4' ? 4 : 6;
    if (udpLayer.error !== undefined || typeof udpLayer.fields.dstPort !== 'number' || typeof udpLayer.fields.srcPort !== 'number') {
      return [drop(ctx, pdu, 'other', udpLayer.error ?? 'UDP header truncated', port)];
    }
    if (udpLayer.fields.checksumValid === false) {
      checksumErrors++;
      return [drop(ctx, pdu, 'bad-checksum', 'UDP checksum mismatch', port)];
    }
    const src = String(ipLayer.fields.src);
    const dst = String(ipLayer.fields.dst);
    const srcPort = udpLayer.fields.srcPort;
    const dstPort = udpLayer.fields.dstPort;
    const s = matchUdpSocket(sockets.values(), family, dst, dstPort, port);
    if (s === undefined) {
      noPort++;
      const actions: Action[] = [drop(ctx, pdu, 'unsupported-protocol', `udp port ${dstPort} closed`, port)];
      const unicast = family === 4 ? !isIpv4Broadcast(dst) && !isIpv4Multicast(dst) && ctx.ownAddress(dst) !== undefined : !isMulticast6(dst);
      if (unicast) {
        if (family === 4) actions.push({ type: 'request', to: 'icmpv4', req: { kind: 'icmp.error', original: pdu, type: ICMP_DEST_UNREACHABLE, code: ICMP_UNREACH_PORT, inPort: port } });
        else actions.push({ type: 'request', to: 'icmpv6', req: { kind: 'icmp6.error', original: pdu, type: ICMPV6_DEST_UNREACHABLE, code: ICMPV6_UNREACH_PORT, inPort: port } });
      }
      return actions;
    }
    const start = udpLayer.offset + UDP_HEADER;
    const end = udpLayer.offset + udpLayer.length;
    const data = pdu.bytes.slice(start, Math.max(start, end));
    datagramsIn++;
    const datagram = event(s.owner, { kind: 'sock.datagram', socket: s.id, from: src, fromPort: srcPort, to: dst, iface: port, data, pdu });
    if (s.tunnel === true) {
      // P2 (§2.4): a tunnel socket's owner takes the PDU over (same PduId on, or its own consume/drop): no consume here
      debug(ctx, `receive ${flowEndpoint(family, src, srcPort)} > ${flowEndpoint(family, dst, dstPort)} on ${port}: ${data.length} bytes handed to tunnel socket ${s.id}`, {
        socket: s.id,
        pdu: pdu.id,
        port,
      });
      return [datagram];
    }
    debug(ctx, `receive ${flowEndpoint(family, src, srcPort)} > ${flowEndpoint(family, dst, dstPort)} on ${port}: ${data.length} bytes to socket ${s.id}`, {
      socket: s.id,
      pdu: pdu.id,
      port,
    });
    return [{ type: 'consume', pdu }, datagram];
  }

  function receiveError(ctx: ProcessCtx, pdu: Pdu, ipLayer: LayerView, errIdx: number, port: PortId): Action[] {
    const layers = pdu.layers;
    const err = layers[errIdx]!;
    const family: IpFamily = err.proto === 'icmpv4' ? 4 : 6;
    if (err.fields.checksumValid === false) return [drop(ctx, pdu, 'bad-checksum', `${family === 4 ? 'ICMP' : 'ICMPv6'} checksum mismatch`, port)];
    const type = Number(err.fields.type);
    const code = Number(err.fields.code);
    const from = String(ipLayer.fields.src);
    const qIpIdx = ipIndexFrom(layers, errIdx + 1);
    const qUdpIdx = qIpIdx < 0 ? -1 : upperIndex(layers, qIpIdx);
    const qIp = qIpIdx < 0 ? undefined : layers[qIpIdx];
    const qUdp = qUdpIdx < 0 ? undefined : layers[qUdpIdx];
    if (qIp === undefined || qUdp === undefined || qUdp.proto !== 'udp' || typeof qUdp.fields.srcPort !== 'number') {
      debug(ctx, `error type ${type} code ${code} from ${from} does not quote a UDP header; ignored`, { pdu: pdu.id, type, code });
      return [{ type: 'consume', pdu }];
    }
    const qFamily: IpFamily = qIp.proto === 'ipv4' ? 4 : 6;
    const sockCode = udpErrorCodeFor(family, type, code);
    const localPort = qUdp.fields.srcPort;
    const localAddr = String(qIp.fields.src);
    const quotedDstPort = typeof qUdp.fields.dstPort === 'number' ? qUdp.fields.dstPort : undefined;
    const ttlField = qFamily === 4 ? qIp.fields.ttl : qIp.fields.hopLimit;
    const quotedTtl = typeof ttlField === 'number' ? ttlField : undefined;
    let s: UdpSocket | undefined;
    for (const cand of sockets.values()) {
      if (cand.family !== qFamily || cand.localPort !== localPort) continue;
      if (cand.localAddr === localAddr) {
        s = cand;
        break;
      }
      if (s === undefined && isWildcard(cand.family, cand.localAddr)) s = cand;
    }
    if (sockCode === undefined || s === undefined) {
      const why = sockCode === undefined ? 'not reported to UDP sockets' : `no socket on port ${localPort}`;
      debug(ctx, `error type ${type} code ${code} from ${from} quoting port ${localPort}: ${why}`, { pdu: pdu.id, type, code, localPort });
      return [{ type: 'consume', pdu }];
    }
    icmpErrors++;
    const icmp: { type: number; code: number; quotedDstPort?: number; quotedTtl?: number; pdu: Pdu } = { type, code, pdu };
    if (quotedDstPort !== undefined) icmp.quotedDstPort = quotedDstPort;
    if (quotedTtl !== undefined) icmp.quotedTtl = quotedTtl;
    const detail = `${errorWords(sockCode)} reported by ${from}`;
    debug(ctx, `socket ${s.id}: ${sockCode} from ${from} (type ${type} code ${code}, quoted port ${String(quotedDstPort)}); socket stays open`, {
      socket: s.id,
      pdu: pdu.id,
      type,
      code,
      from,
    });
    return [
      { type: 'consume', pdu },
      event(s.owner, { kind: 'sock.error', socket: s.id, code: sockCode, detail, from, icmp }),
    ];
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
      if (ipIdx < 0 || upIdx < 0) return [drop(ctx, pdu, 'unsupported-protocol', 'not a UDP datagram', port)];
      const ipLayer = layers[ipIdx]!;
      const upper = layers[upIdx]!;
      if (upper.proto === 'udp') return receiveDatagram(ctx, pdu, ipLayer, upper, port);
      if (upper.proto === 'icmpv4' || upper.proto === 'icmpv6') return receiveError(ctx, pdu, ipLayer, upIdx, port);
      return [drop(ctx, pdu, 'unsupported-protocol', 'not a UDP datagram', port)];
    },

    onTimer(): Action[] {
      return [];
    },

    onConfig(): Action[] {
      return [];
    },

    onRequest(ctx: ProcessCtx, req: ProcessRequest): Action[] {
      switch (req.kind) {
        case 'udp.open':
          return open(ctx, req);
        case 'udp.send':
          return send(ctx, req);
        case 'udp.close':
          return close(ctx, req);
        default:
          return [];
      }
    },

    stateSnapshot(): StateView {
      const list: Record<string, unknown>[] = [];
      for (const s of sockets.values()) {
        const row: Record<string, unknown> = { id: s.id, owner: s.owner, family: s.family, localAddr: s.localAddr, localPort: s.localPort };
        if (s.iface !== undefined) row.iface = s.iface;
        if (s.tunnel === true) row.tunnel = true;
        list.push(row);
      }
      return {
        process: NAME,
        state: { sockets: list, ephemeralNext: ephemeralNext ?? null, datagramsIn, datagramsOut, noPort, checksumErrors, icmpErrors },
      };
    },

    debugEvents(): readonly DebugEvent[] {
      return ring;
    },
  };
}

/** `10.0.0.1:53` / `[2001:db8::1]:53` for debug lines. */
export function flowEndpoint(family: IpFamily, addr: IpAddress, port: number): string {
  return family === 6 ? `[${addr}]:${port}` : `${addr}:${port}`;
}
