/**
 * protocols/dhcpv6-server.ts — the DHCPv6 server (RFC 8415; DNS options RFC 3646; ARCHITECTURE-P2 D16, §3.11, §4).
 *
 * Answers only (§4.3). It owns the socket `dhcpv6-server#547` (family 6, port 547) only while an interface carries
 * `ipv6 dhcp server <pool>` (ipv6 joins ff02::1:2 on that interface itself, §3.11), so no P1 world shows a `sockets`
 * row. Pools: `ipv6 dhcp pool NAME` with `address prefix P/len [lifetime <valid> <preferred>]` (stateful; defaults
 * 2 592 000 s and 604 800 s), `dns-server A` (several) and `domain-name D`. A client message is served from the pool
 * of the interface it arrived on; a message on an interface without the line is ignored.
 *
 *  • INFORMATION-REQUEST (11) → REPLY (7) carrying the pool's DNS servers and domain (stateless).
 *  • SOLICIT (1) → ADVERTISE (2) with the client's existing binding for the same DUID and IAID, else the lowest free
 *    address of the prefix starting at `<prefix>::2` (skipping the server's own addresses, bound addresses and
 *    addresses offered to other clients), else status 2 (no address available). An offer is remembered in memory
 *    (no table row, no timer) until the client requests or solicits again.
 *  • REQUEST (3, naming this server) → REPLY (7): the `dhcpv6-bindings` row `{address, duid, iaid, pool,
 *    preferredUntil, expiresAt}` (key `<pool>|<address>`) and the periodic `binding6:<key>` timer (the valid
 *    lifetime), which deletes the row 'aged'. RENEW (5) / REBIND (6) extend a matching binding (status 3 when none).
 *    RELEASE (8) deletes it ('cleared'). T1 and T2 in the replies are half and four fifths of the preferred lifetime.
 * Replies are unicast to the client's link-local address, port 546, out the ingress interface, `triggeredBy` the
 * client's message. The server DUID is the DUID-LL of the ingress interface's MAC. No randomness is used (§4.1).
 *
 * Debug category 'ipv6 dhcp'. stateSnapshot: { open, bindings, offers, advertises, replies }.
 *
 * ponytail: no relay (S8 is not approved), no rapid commit, no reconfigure, one IA_NA per client, no prefix
 * delegation, no DECLINE handling.
 */
import { IPV6_ANY, type Ipv6Address } from '../contracts/addr.js';
import type { ConfigDelta, ConfigNode } from '../contracts/config.js';
import type { PortId } from '../contracts/ids.js';
import { UDP_PORT_DHCPV6_CLIENT, UDP_PORT_DHCPV6_SERVER, type FieldValue, type Pdu } from '../contracts/pdu.js';
import type { Action, DebugEvent, Process, ProcessCtx, ProcessRequest, StateView } from '../contracts/process.js';
import type { Dhcpv6BindingRow, Table } from '../contracts/tables.js';
import { SEC } from '../contracts/time.js';
import type { ProcessEvent } from '../contracts/transport.js';
import { configTextLinesOf } from '../cli/config-text.js';
import { bytesToIpv6, ipv6NetworkOf, ipv6ToBytes, isIpv6, normalizeIpv6, parseCidr6 } from '../core/addr6.js';
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
import { DHCPV6_STATUS_NO_ADDRS_AVAIL, DHCPV6_STATUS_NO_BINDING, DHCPV6_STATUS_SUCCESS } from './dhcpv6-client.js';

const NAME = 'dhcpv6-server';
/** Debug category (§5.4): `debug ipv6 dhcp`, shared with the client. */
const CAT = 'ipv6 dhcp';
const DEBUG_RING = 256;
/** The server socket id. */
export const DHCPV6_SERVER_SOCKET = 'dhcpv6-server#547';
/** Default lifetimes of `address prefix` without `lifetime` (RFC 4861 §6.2.1 style defaults: 30 days, 7 days). */
export const DHCPV6_DEFAULT_VALID_S = 2_592_000;
export const DHCPV6_DEFAULT_PREFERRED_S = 604_800;
/** First host offered from a prefix (`<prefix>::2`; `::1` is left to the router, §3.11). */
export const DHCPV6_FIRST_HOST = 2;
/** Longest walk over a prefix when looking for a free address. */
export const DHCPV6_ALLOCATION_LIMIT = 65_536;

/** One `ipv6 dhcp pool` section, parsed. */
export interface Dhcpv6Pool {
  name: string;
  /** Canonical network of `address prefix`, when stateful. */
  prefix?: Ipv6Address;
  prefixLen?: number;
  validS: number;
  preferredS: number;
  dns: Ipv6Address[];
  domain?: string;
}

/** Pools and the interfaces serving them, from the running config. */
export function dhcpv6ServerConfig(root: ConfigNode): { pools: Dhcpv6Pool[]; interfaces: Map<PortId, string> } {
  const pools = new Map<string, Dhcpv6Pool>();
  const interfaces = new Map<PortId, string>();
  for (const l of configTextLinesOf(root)) {
    const t = l.tokens;
    const head = l.context[0];
    if (l.context.length === 0) {
      if (t[0] === 'ipv6' && t[1] === 'dhcp' && t[2] === 'pool' && t[3] !== undefined && !pools.has(t[3])) {
        pools.set(t[3], { name: t[3], validS: DHCPV6_DEFAULT_VALID_S, preferredS: DHCPV6_DEFAULT_PREFERRED_S, dns: [] });
      }
      continue;
    }
    if (l.context.length === 1 && head?.[0] === 'interface' && head[1] !== undefined && t[0] === 'ipv6' && t[1] === 'dhcp' && t[2] === 'server' && t[3] !== undefined) {
      interfaces.set(head[1], t[3]);
      continue;
    }
    if (head?.[0] !== 'ipv6' || head[1] !== 'dhcp' || head[2] !== 'pool' || head[3] === undefined) continue;
    const p = pools.get(head[3]);
    if (p === undefined) continue;
    switch (t[0]) {
      case 'address': {
        if (t[1] !== 'prefix') break;
        const cidr = t[2] !== undefined ? parseCidr6(t[2]) : null;
        if (cidr === null || cidr.prefixLen > 126) break;
        p.prefix = ipv6NetworkOf(cidr.network, cidr.prefixLen);
        p.prefixLen = cidr.prefixLen;
        if (t[3] === 'lifetime') {
          const valid = Number(t[4]);
          const preferred = Number(t[5]);
          if (Number.isInteger(valid) && valid > 0 && valid <= 0xffffffff) p.validS = valid;
          if (Number.isInteger(preferred) && preferred > 0 && preferred <= p.validS) p.preferredS = preferred;
          else if (p.preferredS > p.validS) p.preferredS = p.validS;
        }
        break;
      }
      case 'dns-server': {
        const a = t[1] !== undefined ? normalizeIpv6(t[1]) : null;
        if (a !== null && !p.dns.includes(a)) p.dns.push(a);
        break;
      }
      case 'domain-name':
        if (t[1] !== undefined) p.domain = t[1];
        break;
      default:
        break;
    }
  }
  return { pools: [...pools.values()], interfaces };
}

/** `prefix` plus `n` (big-endian add over the 16 bytes). */
export function ipv6Plus(prefix: Ipv6Address, n: number): Ipv6Address {
  const b = ipv6ToBytes(prefix);
  let carry = n;
  for (let i = 15; i >= 0 && carry > 0; i--) {
    const v = b[i]! + (carry & 0xff);
    b[i] = v & 0xff;
    carry = Math.floor(carry / 256) + (v > 0xff ? 1 : 0);
  }
  return bytesToIpv6(b);
}

const dhcpv6Of = (pdu: Pdu): Readonly<Record<string, FieldValue>> | undefined => pdu.layers.find((l) => l.proto === 'dhcpv6')?.fields;
const num = (v: FieldValue | undefined, dflt = 0): number => (typeof v === 'number' && Number.isFinite(v) ? v : dflt);
const bindingKey6 = (pool: string, address: Ipv6Address): string => `${pool}|${address}`;
const clientKey = (duid: string, iaid: number): string => `${duid}|${iaid}`;

/** Pool summary for `show ipv6 dhcp pool`. */
export interface Dhcpv6PoolView {
  name: string;
  prefix?: string;
  validS: number;
  preferredS: number;
  dns: Ipv6Address[];
  domain?: string;
  bound: number;
  interfaces: PortId[];
}

export function dhcpv6PoolViews(ctx: Pick<ProcessCtx, 'config' | 'tables'>): Dhcpv6PoolView[] {
  const cfg = dhcpv6ServerConfig(ctx.config.root);
  const rows = ctx.tables.get<Dhcpv6BindingRow>('dhcpv6-bindings')?.rows() ?? [];
  return cfg.pools.map((p) => {
    const v: Dhcpv6PoolView = {
      name: p.name,
      validS: p.validS,
      preferredS: p.preferredS,
      dns: [...p.dns],
      bound: rows.filter((r) => r.pool === p.name).length,
      interfaces: [...cfg.interfaces].filter(([, pool]) => pool === p.name).map(([iface]) => iface),
    };
    if (p.prefix !== undefined && p.prefixLen !== undefined) v.prefix = `${p.prefix}/${p.prefixLen}`;
    if (p.domain !== undefined) v.domain = p.domain;
    return v;
  });
}

export function createDhcpv6Server(): Process {
  const bindings = new Map<string, Dhcpv6BindingRow>();
  /** Addresses offered but not yet requested: client key → { pool, address }. */
  const offers = new Map<string, { pool: string; address: Ipv6Address }>();
  const ring: DebugEvent[] = [];
  let open = false;
  let advertises = 0;
  let replies = 0;

  function debug(ctx: ProcessCtx, message: string, data?: Record<string, unknown>): void {
    ctx.debug(CAT, message, data);
    const ev: DebugEvent = data
      ? { at: ctx.now, device: ctx.deviceId, process: NAME, category: CAT, message, data }
      : { at: ctx.now, device: ctx.deviceId, process: NAME, category: CAT, message };
    ring.push(ev);
    if (ring.length > DEBUG_RING) ring.splice(0, ring.length - DEBUG_RING);
  }

  const table = (ctx: ProcessCtx): Table<Dhcpv6BindingRow> | undefined => ctx.tables.get<Dhcpv6BindingRow>('dhcpv6-bindings');

  function setBinding(ctx: ProcessCtx, b: Dhcpv6BindingRow): void {
    bindings.set(b.key, b);
    table(ctx)?.set(b);
  }

  function dropBinding(ctx: ProcessCtx, key: string, reason: 'aged' | 'cleared'): Action[] {
    if (!bindings.delete(key)) return [];
    table(ctx)?.delete(key, reason);
    return [{ type: 'cancelTimer', key: `binding6:${key}` }];
  }

  const byClient = (pool: string, duid: string, iaid: number): Dhcpv6BindingRow | undefined =>
    [...bindings.values()].find((b) => b.pool === pool && b.duid === duid && b.iaid === iaid);

  function syncSocket(ctx: ProcessCtx): Action[] {
    const want = dhcpv6ServerConfig(ctx.config.root).interfaces.size > 0;
    if (want === open) return [];
    open = want;
    debug(ctx, want ? 'DHCPv6 service started' : 'DHCPv6 service stopped');
    return want
      ? [{ type: 'request', to: 'udp', req: { kind: 'udp.open', owner: NAME, socket: DHCPV6_SERVER_SOCKET, family: 6, localAddr: IPV6_ANY, localPort: UDP_PORT_DHCPV6_SERVER } }]
      : [{ type: 'request', to: 'udp', req: { kind: 'udp.close', socket: DHCPV6_SERVER_SOCKET } }];
  }

  /** Lowest address of the prefix from `<prefix>::2` that is not ours, not bound and not offered to another client. */
  function lowestFree(ctx: ProcessCtx, p: Dhcpv6Pool, client: string): Ipv6Address | undefined {
    const hostBits = 128 - p.prefixLen!;
    const last = hostBits >= 17 ? DHCPV6_ALLOCATION_LIMIT : Math.min(2 ** hostBits - 1, DHCPV6_ALLOCATION_LIMIT);
    for (let i = DHCPV6_FIRST_HOST; i <= last; i++) {
      const a = ipv6Plus(p.prefix!, i);
      if (ctx.ownAddress6(a) !== undefined || bindings.has(bindingKey6(p.name, a))) continue;
      let offered = false;
      for (const [k, o] of offers) if (k !== client && o.pool === p.name && o.address === a) offered = true;
      if (offered) continue;
      return a;
    }
    return undefined;
  }

  function reply(
    ctx: ProcessCtx,
    msgType: number,
    f: Readonly<Record<string, FieldValue>>,
    p: Dhcpv6Pool,
    extra: Record<string, FieldValue>,
    to: { from: Ipv6Address; iface: PortId; pdu: Pdu },
  ): Action {
    const fields: Record<string, FieldValue> = {
      msgType,
      transactionId: num(f.transactionId, 0),
      clientDuid: String(f.clientDuid),
      serverDuid: duidLlFromMac(ctx.macOf(to.iface)),
      ...extra,
    };
    if (p.dns.length > 0) fields.dnsServers = p.dns.join(',');
    if (p.domain !== undefined) fields.domainList = p.domain;
    if (msgType === DHCPV6_ADVERTISE) advertises++;
    else replies++;
    debug(ctx, `${dhcpv6MessageName(msgType)}${typeof extra.iaAddress === 'string' ? ` ${extra.iaAddress}` : ''} to ${to.from} on ${to.iface} (pdu ${to.pdu.id})`, { msgType, iface: to.iface, to: to.from, pdu: to.pdu.id, ...extra });
    const req: Extract<ProcessRequest, { kind: 'udp.send' }> = {
      kind: 'udp.send',
      socket: DHCPV6_SERVER_SOCKET,
      dst: to.from,
      dstPort: UDP_PORT_DHCPV6_CLIENT,
      iface: to.iface,
      tag: `dhcpv6-${dhcpv6MessageName(msgType).toLowerCase()}`,
      triggeredBy: to.pdu.id,
      app: [{ proto: 'dhcpv6', fields }],
    };
    return { type: 'request', to: 'udp', req };
  }

  /** IA_NA fields of an address with the pool's lifetimes. */
  function iaFields(p: Dhcpv6Pool, iaid: number, address: Ipv6Address): Record<string, FieldValue> {
    return {
      iaid,
      t1S: Math.floor(p.preferredS / 2),
      t2S: Math.floor((p.preferredS * 4) / 5),
      iaAddress: address,
      preferredLifetimeS: p.preferredS,
      validLifetimeS: p.validS,
    };
  }

  function bind(ctx: ProcessCtx, p: Dhcpv6Pool, duid: string, iaid: number, address: Ipv6Address): Action[] {
    const key = bindingKey6(p.name, address);
    const row: Dhcpv6BindingRow = { key, address, duid, iaid, pool: p.name, preferredUntil: ctx.now + p.preferredS * SEC, expiresAt: ctx.now + p.validS * SEC, updatedAt: ctx.now };
    setBinding(ctx, row);
    offers.delete(clientKey(duid, iaid));
    return [{ type: 'timer', key: `binding6:${key}`, delay: p.validS * SEC, periodic: true }];
  }

  function onClientMessage(ctx: ProcessCtx, f: Readonly<Record<string, FieldValue>>, from: Ipv6Address, iface: PortId, pdu: Pdu): Action[] {
    const cfg = dhcpv6ServerConfig(ctx.config.root);
    const poolName = cfg.interfaces.get(iface);
    const p = poolName === undefined ? undefined : cfg.pools.find((x) => x.name === poolName);
    const type = num(f.msgType, 0);
    if (p === undefined) {
      debug(ctx, `ignored ${dhcpv6MessageName(type)} from ${from} on ${iface}: ${poolName === undefined ? 'no DHCPv6 server on the interface' : `pool ${poolName} does not exist`}`, { iface, pdu: pdu.id });
      return [];
    }
    if (typeof f.clientDuid !== 'string' || f.clientDuid === '') {
      debug(ctx, `ignored ${dhcpv6MessageName(type)} from ${from} on ${iface}: no client identifier`, { iface, pdu: pdu.id });
      return [];
    }
    const duid = f.clientDuid;
    const iaid = num(f.iaid, 0);
    const ck = clientKey(duid, iaid);
    const to = { from, iface, pdu };
    const ours = typeof f.serverDuid === 'string' && f.serverDuid === duidLlFromMac(ctx.macOf(iface));
    const stateful = p.prefix !== undefined && p.prefixLen !== undefined;

    if (type === DHCPV6_INFORMATION_REQUEST) return [reply(ctx, DHCPV6_REPLY, f, p, {}, to)];

    if (type === DHCPV6_SOLICIT) {
      if (!stateful) return [reply(ctx, DHCPV6_ADVERTISE, f, p, { iaid, statusCode: DHCPV6_STATUS_NO_ADDRS_AVAIL }, to)];
      const mine = byClient(p.name, duid, iaid);
      const address = mine?.address ?? offers.get(ck)?.address ?? lowestFree(ctx, p, ck);
      if (address === undefined) {
        debug(ctx, `pool ${p.name} exhausted; no address for ${duid}`, { pool: p.name, duid, pdu: pdu.id });
        return [reply(ctx, DHCPV6_ADVERTISE, f, p, { iaid, statusCode: DHCPV6_STATUS_NO_ADDRS_AVAIL }, to)];
      }
      if (mine === undefined) offers.set(ck, { pool: p.name, address });
      return [reply(ctx, DHCPV6_ADVERTISE, f, p, iaFields(p, iaid, address), to)];
    }

    if (type === DHCPV6_REQUEST) {
      if (!ours) {
        // the client chose another server
        offers.delete(ck);
        return [];
      }
      if (!stateful) return [reply(ctx, DHCPV6_REPLY, f, p, { iaid, statusCode: DHCPV6_STATUS_NO_ADDRS_AVAIL }, to)];
      const mine = byClient(p.name, duid, iaid);
      const address = mine?.address ?? offers.get(ck)?.address ?? lowestFree(ctx, p, ck);
      if (address === undefined) return [reply(ctx, DHCPV6_REPLY, f, p, { iaid, statusCode: DHCPV6_STATUS_NO_ADDRS_AVAIL }, to)];
      const out = mine !== undefined && mine.address !== address ? dropBinding(ctx, mine.key, 'cleared') : [];
      out.push(...bind(ctx, p, duid, iaid, address));
      debug(ctx, `${duid} bound to ${address} in pool ${p.name} for ${p.validS} s`, { pool: p.name, duid, iaid, address, pdu: pdu.id });
      out.push(reply(ctx, DHCPV6_REPLY, f, p, iaFields(p, iaid, address), to));
      return out;
    }

    if (type === DHCPV6_RENEW || type === DHCPV6_REBIND) {
      if (type === DHCPV6_RENEW && !ours) return [];
      const mine = byClient(p.name, duid, iaid);
      const wanted = typeof f.iaAddress === 'string' ? normalizeIpv6(f.iaAddress) : null;
      if (!stateful || mine === undefined || wanted === null || mine.address !== wanted) {
        debug(ctx, `${dhcpv6MessageName(type)} from ${duid} for ${wanted ?? '(none)'}: no binding`, { pool: p.name, duid, iaid, pdu: pdu.id });
        return [reply(ctx, DHCPV6_REPLY, f, p, { iaid, statusCode: DHCPV6_STATUS_NO_BINDING }, to)];
      }
      const out = bind(ctx, p, duid, iaid, mine.address);
      debug(ctx, `${duid} renewed ${mine.address} in pool ${p.name} for ${p.validS} s`, { pool: p.name, duid, iaid, address: mine.address, pdu: pdu.id });
      out.push(reply(ctx, DHCPV6_REPLY, f, p, iaFields(p, iaid, mine.address), to));
      return out;
    }

    if (type === DHCPV6_RELEASE) {
      if (!ours) return [];
      const mine = byClient(p.name, duid, iaid);
      const out: Action[] = [];
      if (mine !== undefined) {
        debug(ctx, `${duid} released ${mine.address} in pool ${p.name}`, { pool: p.name, duid, iaid, address: mine.address, pdu: pdu.id });
        out.push(...dropBinding(ctx, mine.key, 'cleared'));
      }
      offers.delete(ck);
      out.push(reply(ctx, DHCPV6_REPLY, f, p, { iaid, statusCode: DHCPV6_STATUS_SUCCESS }, to));
      return out;
    }
    return [];
  }

  return {
    name: NAME,

    init(ctx: ProcessCtx): Action[] {
      return syncSocket(ctx);
    },

    onPdu(_ctx: ProcessCtx, pdu: Pdu, port: PortId): Action[] {
      return [{ type: 'drop', pdu, reason: 'unsupported-protocol', detail: 'dhcpv6-server takes datagrams from its udp socket', port }];
    },

    onConfig(ctx: ProcessCtx, delta: ConfigDelta): Action[] {
      const head = delta.context[0];
      const touches = (delta.line[0] === 'ipv6' && delta.line[1] === 'dhcp') || (head?.[0] === 'ipv6' && head[1] === 'dhcp');
      return touches ? syncSocket(ctx) : [];
    },

    onTimer(ctx: ProcessCtx, key: string): Action[] {
      if (!key.startsWith('binding6:')) return [];
      const b = bindings.get(key.slice('binding6:'.length));
      if (b === undefined) return [];
      debug(ctx, `binding ${b.address} of ${b.duid} in pool ${b.pool} expired`, { pool: b.pool, duid: b.duid, address: b.address });
      return dropBinding(ctx, b.key, 'aged');
    },

    onEvent(ctx: ProcessCtx, ev: ProcessEvent): Action[] {
      if (ev.kind !== 'sock.datagram' || ev.socket !== DHCPV6_SERVER_SOCKET) return [];
      const f = dhcpv6Of(ev.pdu);
      if (f === undefined) return [];
      const from = isIpv6(ev.from) ? normalizeIpv6(ev.from) : null;
      if (from === null) return [];
      return onClientMessage(ctx, f, from, ev.iface, ev.pdu);
    },

    onRequest(): Action[] {
      return [];
    },

    stateSnapshot(): StateView {
      return {
        process: NAME,
        state: {
          open,
          bindings: [...bindings.values()],
          offers: [...offers.entries()].map(([client, o]) => ({ client, pool: o.pool, address: o.address })),
          advertises,
          replies,
        },
      };
    },

    debugEvents(): readonly DebugEvent[] {
      return ring;
    },
  };
}
