/**
 * protocols/dhcp-server.ts — the DHCPv4 server and relay agent (RFC 2131 §4.3, RFC 1542 relay; ARCHITECTURE-P1 §4.3).
 *
 * Silent unless the config has an `ip dhcp pool` or an `ip helper-address`; then it owns socket 'dhcp-server#67'
 * (0.0.0.0:67). Pools: `ip dhcp pool NAME` with `network A MASK|/N`, `default-router`, `dns-server …`, `domain-name`,
 * `lease D [H [M]] | infinite` (default 1 day); `ip dhcp excluded-address LOW [HIGH]`.
 *
 * Client messages (op 1) arriving on an interface:
 *  • pool = the one containing giaddr (relayed), else ciaddr (a unicast renew or release, RFC 2131 §4.3.2), else the
 *    ingress interface address; none + `ip helper-address` on the interface → relay: a NEW pdu (`triggeredBy` the
 *    original) with giaddr = the interface address, hops + 1 (dropped past DHCP_MAX_HOPS), unicast to every helper:67.
 *  • DISCOVER → the chaddr's existing binding while it still fits the pool (else it is dropped), otherwise the lowest
 *    free address (not excluded, not one of ours, not bound) → binding `offered` for DHCP_OFFER_HOLD_NS
 *    (`offer-hold:<key>`) → OFFER.
 *  • REQUEST naming our serverId → ACK when it matches the chaddr's binding (binding `bound` until the lease end,
 *    periodic `binding:<key>`), else NAK; naming another server → our offer to that chaddr is withdrawn silently.
 *    Without serverId (renew / rebind / reboot): ACK when the address is the chaddr's or free, NAK when another
 *    client holds it, silence when it is outside the pool.
 *  • RELEASE → the binding is removed.
 * Replies go from the serverId: unicast to giaddr:67 when relayed, unicast to ciaddr when set (routed normally, so a
 * renew from behind a relay is answered), else broadcast out the ingress interface. Server replies (op 2) whose giaddr is one of our addresses are relayed back as a broadcast out
 * that interface.
 *
 * Bindings live in the 'dhcp-bindings' table (DhcpBindingRow). Debug category 'dhcp' (`debug ip dhcp server`).
 *
 * ponytail: no DECLINE/INFORM handling, no ping-before-offer (DHCP_PING_CHECK is off), no manual bindings.
 */
import { IPV4_ANY, IPV4_BROADCAST, inSubnet, ipv4ToU32, isIpv4, maskToPrefixLen, prefixLenToMask, u32ToIpv4, type Ipv4Address } from '../contracts/addr.js';
import type { ConfigDelta } from '../contracts/config.js';
import type { PortId } from '../contracts/ids.js';
import type { FieldValue, Pdu } from '../contracts/pdu.js';
import type { Action, DebugEvent, Process, ProcessCtx, ProcessRequest, StateView } from '../contracts/process.js';
import { DHCP_DEFAULT_LEASE_S, DHCP_MAX_HOPS, DHCP_OFFER_HOLD_NS, DHCP_T1_PERMILLE, DHCP_T2_PERMILLE, type DhcpPoolView } from '../contracts/services.js';
import { dhcpBindingKey, type DhcpBindingRow, type Table } from '../contracts/tables.js';
import { SEC } from '../contracts/time.js';
import type { ProcessEvent } from '../contracts/transport.js';
import { configTextLinesOf } from '../cli/config-text.js';

const NAME = 'dhcp-server';
const CAT = 'dhcp';
const DEBUG_RING = 256;
const SOCKET = 'dhcp-server#67';
/** Lease time meaning "infinite" (RFC 2131 §3.3). */
export const DHCP_INFINITE_LEASE = 0xffffffff;

export interface DhcpPool {
  name: string;
  network?: Ipv4Address;
  prefixLen?: number;
  router?: Ipv4Address;
  dns: Ipv4Address[];
  domain?: string;
  leaseS: number;
}

/** Pools, exclusions and helpers from the running config. */
export function dhcpServerConfig(root: Parameters<typeof configTextLinesOf>[0]): {
  pools: DhcpPool[];
  excluded: [number, number][];
  helpers: Map<PortId, Ipv4Address[]>;
} {
  const pools = new Map<string, DhcpPool>();
  const excluded: [number, number][] = [];
  const helpers = new Map<PortId, Ipv4Address[]>();
  for (const l of configTextLinesOf(root)) {
    const t = l.tokens;
    const head = l.context[0];
    if (l.context.length === 0) {
      if (t[0] === 'ip' && t[1] === 'dhcp' && t[2] === 'pool' && t[3] !== undefined && !pools.has(t[3])) pools.set(t[3], { name: t[3], dns: [], leaseS: DHCP_DEFAULT_LEASE_S });
      if (t[0] === 'ip' && t[1] === 'dhcp' && t[2] === 'excluded-address' && isIpv4(t[3] ?? '')) {
        const lo = ipv4ToU32(t[3]!);
        const hi = isIpv4(t[4] ?? '') ? ipv4ToU32(t[4]!) : lo;
        excluded.push([lo, hi]);
      }
      continue;
    }
    if (head?.[0] === 'interface' && head[1] !== undefined && t[0] === 'ip' && t[1] === 'helper-address' && isIpv4(t[2] ?? '')) {
      helpers.set(head[1], [...(helpers.get(head[1]) ?? []), t[2]!]);
      continue;
    }
    if (head?.[0] !== 'ip' || head[1] !== 'dhcp' || head[2] !== 'pool' || head[3] === undefined) continue;
    const p = pools.get(head[3]);
    if (p === undefined) continue;
    switch (t[0]) {
      case 'network': {
        const len = t[2]?.startsWith('/') ? Number(t[2].slice(1)) : maskToPrefixLen(t[2] ?? '');
        if (isIpv4(t[1] ?? '') && len !== null && Number.isInteger(len) && len >= 0 && len <= 30) {
          p.network = t[1]!;
          p.prefixLen = len;
        }
        break;
      }
      case 'default-router':
        if (isIpv4(t[1] ?? '')) p.router = t[1]!;
        break;
      case 'dns-server':
        p.dns = t.slice(1).filter(isIpv4);
        break;
      case 'domain-name':
        if (t[1] !== undefined) p.domain = t[1];
        break;
      case 'lease':
        if (t[1] === 'infinite') p.leaseS = DHCP_INFINITE_LEASE;
        else {
          const [d, h, m] = [Number(t[1] ?? 0), Number(t[2] ?? 0), Number(t[3] ?? 0)];
          const s = ((d * 24 + h) * 60 + m) * 60;
          if (Number.isInteger(s) && s > 0) p.leaseS = s;
        }
        break;
      default:
        break;
    }
  }
  return { pools: [...pools.values()], excluded, helpers };
}

const dhcpOf = (pdu: Pdu): Readonly<Record<string, FieldValue>> | undefined => pdu.layers.find((l) => l.proto === 'dhcp')?.fields;

export function createDhcpServer(): Process {
  const bindings = new Map<string, DhcpBindingRow>();
  const ring: DebugEvent[] = [];
  let open = false;
  let offers = 0;
  let acks = 0;
  let naks = 0;
  let relayed = 0;

  function debug(ctx: ProcessCtx, message: string, data?: Record<string, unknown>): void {
    ctx.debug(CAT, message, data);
    const ev: DebugEvent = data
      ? { at: ctx.now, device: ctx.deviceId, process: NAME, category: CAT, message, data }
      : { at: ctx.now, device: ctx.deviceId, process: NAME, category: CAT, message };
    ring.push(ev);
    if (ring.length > DEBUG_RING) ring.splice(0, ring.length - DEBUG_RING);
  }

  const table = (ctx: ProcessCtx): Table<DhcpBindingRow> | undefined => ctx.tables.get<DhcpBindingRow>('dhcp-bindings');

  function setBinding(ctx: ProcessCtx, b: DhcpBindingRow): void {
    bindings.set(b.key, b);
    table(ctx)?.set(b);
  }

  function dropBinding(ctx: ProcessCtx, key: string, reason: 'aged' | 'cleared'): Action[] {
    if (!bindings.delete(key)) return [];
    table(ctx)?.delete(key, reason);
    return [
      { type: 'cancelTimer', key: `offer-hold:${key}` },
      { type: 'cancelTimer', key: `binding:${key}` },
    ];
  }

  const byMac = (pool: string, mac: string): DhcpBindingRow | undefined => [...bindings.values()].find((b) => b.pool === pool && b.mac === mac);

  function syncSocket(ctx: ProcessCtx): Action[] {
    const cfg = dhcpServerConfig(ctx.config.root);
    const want = cfg.pools.length > 0 || cfg.helpers.size > 0;
    if (want === open) return [];
    open = want;
    debug(ctx, want ? 'DHCP service started' : 'DHCP service stopped');
    return want
      ? [{ type: 'request', to: 'udp', req: { kind: 'udp.open', owner: NAME, socket: SOCKET, family: 4, localAddr: IPV4_ANY, localPort: 67 } }]
      : [{ type: 'request', to: 'udp', req: { kind: 'udp.close', socket: SOCKET } }];
  }

  function lowestFree(ctx: ProcessCtx, p: DhcpPool, excluded: [number, number][]): Ipv4Address | undefined {
    const net = ipv4ToU32(p.network!);
    const size = 2 ** (32 - p.prefixLen!);
    for (let i = 1; i < size - 1; i++) {
      const u = (net + i) >>> 0;
      if (excluded.some(([lo, hi]) => u >= lo && u <= hi)) continue;
      const ip = u32ToIpv4(u);
      if (ctx.ownAddress(ip) !== undefined || bindings.has(dhcpBindingKey(p.name, ip))) continue;
      return ip;
    }
    return undefined;
  }

  function reply(
    ctx: ProcessCtx,
    type: 'OFFER' | 'ACK' | 'NAK',
    f: Readonly<Record<string, FieldValue>>,
    p: DhcpPool,
    yiaddr: Ipv4Address,
    serverId: Ipv4Address,
    iface: PortId,
    pdu: Pdu,
  ): Action {
    const giaddr = String(f.giaddr ?? IPV4_ANY);
    const ciaddr = String(f.ciaddr ?? IPV4_ANY);
    const fields: Record<string, FieldValue> = {
      op: 2,
      htype: 1,
      hlen: 6,
      xid: f.xid ?? 0,
      broadcastFlag: f.broadcastFlag === true,
      ciaddr: type === 'NAK' ? IPV4_ANY : ciaddr,
      yiaddr: type === 'NAK' ? IPV4_ANY : yiaddr,
      giaddr,
      chaddr: f.chaddr ?? '00:00:00:00:00:00',
      messageType: type,
      serverId,
    };
    if (type !== 'NAK') {
      fields.leaseTimeS = p.leaseS;
      if (p.leaseS !== DHCP_INFINITE_LEASE) {
        fields.renewalTimeS = Math.floor((p.leaseS * DHCP_T1_PERMILLE) / 1000);
        fields.rebindingTimeS = Math.floor((p.leaseS * DHCP_T2_PERMILLE) / 1000);
      }
      fields.subnetMask = prefixLenToMask(p.prefixLen!);
      if (p.router !== undefined) fields.router = p.router;
      if (p.dns.length > 0) fields.dnsServers = p.dns.join(',');
      if (p.domain !== undefined) fields.domainName = p.domain;
    }
    const viaRelay = giaddr !== IPV4_ANY;
    const unicast = !viaRelay && type !== 'NAK' && ciaddr !== IPV4_ANY;
    const dst = viaRelay ? giaddr : unicast ? ciaddr : IPV4_BROADCAST;
    const req: Extract<ProcessRequest, { kind: 'udp.send' }> = {
      kind: 'udp.send',
      socket: SOCKET,
      dst,
      dstPort: viaRelay ? 67 : 68,
      src: serverId,
      tag: `dhcp-${type.toLowerCase()}`,
      triggeredBy: pdu.id,
      app: [{ proto: 'dhcp', fields }],
    };
    // a broadcast has to name its egress interface; a unicast to ciaddr is routed normally (it may be behind a relay)
    if (dst === IPV4_BROADCAST) req.iface = iface;
    debug(ctx, `${type} ${yiaddr} to ${String(f.chaddr)} via ${dst}`, { type, yiaddr, chaddr: f.chaddr, pdu: pdu.id });
    return { type: 'request', to: 'udp', req };
  }

  /** Forward a client message to the helpers (a new pdu per helper). */
  function relay(ctx: ProcessCtx, f: Readonly<Record<string, FieldValue>>, iface: PortId, helpers: Ipv4Address[], pdu: Pdu): Action[] {
    const own = ctx.ports.get(iface)?.l3.ipv4?.address;
    const hops = Number(f.hops ?? 0) + 1;
    if (own === undefined || hops > DHCP_MAX_HOPS) {
      debug(ctx, `not relaying from ${iface}: ${own === undefined ? 'no interface address' : 'hop limit reached'}`, { iface, pdu: pdu.id });
      return [];
    }
    const giaddr = String(f.giaddr ?? IPV4_ANY) === IPV4_ANY ? own : String(f.giaddr);
    const fields: Record<string, FieldValue> = { ...f, giaddr, hops };
    return helpers.map((h): Action => {
      relayed++;
      debug(ctx, `relay ${String(f.messageType)} from ${iface} to ${h} (giaddr ${giaddr})`, { iface, helper: h, pdu: pdu.id });
      return { type: 'request', to: 'udp', req: { kind: 'udp.send', socket: SOCKET, dst: h, dstPort: 67, src: own, tag: 'dhcp-relay', triggeredBy: pdu.id, app: [{ proto: 'dhcp', fields }] } };
    });
  }

  function onClientMessage(ctx: ProcessCtx, f: Readonly<Record<string, FieldValue>>, iface: PortId, pdu: Pdu): Action[] {
    const cfg = dhcpServerConfig(ctx.config.root);
    const giaddr = String(f.giaddr ?? IPV4_ANY);
    const ciaddr = String(f.ciaddr ?? IPV4_ANY);
    const ingress = ctx.ports.get(iface)?.l3.ipv4?.address;
    // RFC 2131 §4.3.2: a RENEWING request (and a RELEASE) is unicast with ciaddr and no giaddr, so ciaddr names the pool
    const anchor = giaddr !== IPV4_ANY ? giaddr : ciaddr !== IPV4_ANY ? ciaddr : ingress;
    const p = anchor === undefined ? undefined : cfg.pools.find((x) => x.network !== undefined && inSubnet(anchor, x.network, x.prefixLen!));
    if (p === undefined) {
      const helpers = cfg.helpers.get(iface);
      return helpers !== undefined && giaddr === IPV4_ANY ? relay(ctx, f, iface, helpers, pdu) : [];
    }
    const serverId = giaddr !== IPV4_ANY ? ctx.sourceFor(giaddr)?.address : ciaddr !== IPV4_ANY ? (ctx.sourceFor(ciaddr)?.address ?? ingress) : ingress;
    if (serverId === undefined) return [];
    const mac = String(f.chaddr);
    const mine = byMac(p.name, mac);
    const type = String(f.messageType);
    const hostname = typeof f.hostname === 'string' && f.hostname !== '' ? f.hostname : undefined;
    const isExcluded = (addr: Ipv4Address): boolean => {
      const u = ipv4ToU32(addr);
      return cfg.excluded.some(([lo, hi]) => u >= lo && u <= hi);
    };
    const bind = (ip: Ipv4Address, state: 'offered' | 'bound'): DhcpBindingRow => {
      const b: DhcpBindingRow = { key: dhcpBindingKey(p.name, ip), ip, mac, pool: p.name, state, updatedAt: ctx.now };
      if (hostname !== undefined) b.hostname = hostname;
      if (giaddr !== IPV4_ANY) b.relay = giaddr;
      return b;
    };

    if (type === 'DISCOVER') {
      // an old binding outside the pool's current network (renumbering) is dropped, never re-offered: it would only be NAKed
      const reuse = mine !== undefined && inSubnet(mine.ip, p.network!, p.prefixLen!) && !isExcluded(mine.ip) && ctx.ownAddress(mine.ip) === undefined;
      const out: Action[] = mine !== undefined && !reuse ? dropBinding(ctx, mine.key, 'cleared') : [];
      const ip = reuse ? mine!.ip : lowestFree(ctx, p, cfg.excluded);
      if (ip === undefined) {
        debug(ctx, `pool ${p.name} exhausted; no offer for ${mac}`, { pool: p.name, mac });
        return out;
      }
      const b = reuse && mine!.state === 'bound' ? mine! : { ...bind(ip, 'offered'), expiresAt: ctx.now + DHCP_OFFER_HOLD_NS };
      setBinding(ctx, b);
      offers++;
      if (b.state === 'offered') out.push({ type: 'timer', key: `offer-hold:${b.key}`, delay: DHCP_OFFER_HOLD_NS });
      out.push(reply(ctx, 'OFFER', f, p, ip, serverId, iface, pdu));
      return out;
    }

    if (type === 'REQUEST') {
      const sid = typeof f.serverId === 'string' ? f.serverId : undefined;
      if (sid !== undefined && ctx.ownAddress(sid) === undefined) {
        // the client chose another server
        return mine?.state === 'offered' ? dropBinding(ctx, mine.key, 'cleared') : [];
      }
      const ip = sid !== undefined ? String(f.requestedIp ?? ciaddr) : ciaddr !== IPV4_ANY ? ciaddr : String(f.requestedIp ?? IPV4_ANY);
      if (!isIpv4(ip) || !inSubnet(ip, p.network!, p.prefixLen!)) return sid !== undefined ? [nak()] : [];
      const holder = bindings.get(dhcpBindingKey(p.name, ip));
      const ok = sid !== undefined ? mine !== undefined && mine.ip === ip : holder === undefined ? lowestFreeOk(ip) : holder.mac === mac;
      if (!ok) return [nak()];
      const out: Action[] = [];
      if (mine !== undefined && mine.ip !== ip) out.push(...dropBinding(ctx, mine.key, 'cleared'));
      const b = bind(ip, 'bound');
      if (p.leaseS !== DHCP_INFINITE_LEASE) b.expiresAt = ctx.now + p.leaseS * SEC;
      setBinding(ctx, b);
      acks++;
      out.push({ type: 'cancelTimer', key: `offer-hold:${b.key}` });
      // an infinite lease has no expiry, so a previous finite lease's timer has to go (it would drop a live binding)
      out.push(b.expiresAt !== undefined ? { type: 'timer', key: `binding:${b.key}`, delay: p.leaseS * SEC, periodic: true } : { type: 'cancelTimer', key: `binding:${b.key}` });
      out.push(reply(ctx, 'ACK', f, p, ip, serverId, iface, pdu));
      return out;

      function lowestFreeOk(addr: Ipv4Address): boolean {
        return !isExcluded(addr) && ctx.ownAddress(addr) === undefined;
      }
    }

    if (type === 'RELEASE') {
      if (mine !== undefined && mine.ip === ciaddr) {
        debug(ctx, `${mac} released ${ciaddr}`, { mac, ip: ciaddr, pdu: pdu.id });
        return dropBinding(ctx, mine.key, 'cleared');
      }
    }
    return [];

    function nak(): Action {
      naks++;
      return reply(ctx, 'NAK', f, p!, IPV4_ANY, serverId!, iface, pdu);
    }
  }

  /** A server reply for a client behind one of our interfaces (we are its relay). */
  function relayBack(ctx: ProcessCtx, f: Readonly<Record<string, FieldValue>>, pdu: Pdu): Action[] {
    const giaddr = String(f.giaddr ?? IPV4_ANY);
    const iface = giaddr === IPV4_ANY ? undefined : ctx.ownAddress(giaddr);
    if (iface === undefined) return [];
    relayed++;
    debug(ctx, `relay ${String(f.messageType)} back out ${iface}`, { iface, pdu: pdu.id });
    return [
      {
        type: 'request',
        to: 'udp',
        req: { kind: 'udp.send', socket: SOCKET, dst: IPV4_BROADCAST, dstPort: 68, src: giaddr, iface, tag: 'dhcp-relay', triggeredBy: pdu.id, app: [{ proto: 'dhcp', fields: { ...f } }] },
      },
    ];
  }

  return {
    name: NAME,

    init(ctx: ProcessCtx): Action[] {
      return syncSocket(ctx);
    },

    onPdu(_ctx: ProcessCtx, pdu: Pdu, port: PortId): Action[] {
      return [{ type: 'drop', pdu, reason: 'unsupported-protocol', detail: 'dhcp-server takes datagrams from its udp socket', port }];
    },

    onConfig(ctx: ProcessCtx, delta: ConfigDelta): Action[] {
      const head = delta.context[0];
      const touches = (delta.line[0] === 'ip' && (delta.line[1] === 'dhcp' || delta.line[1] === 'helper-address')) || (head?.[0] === 'ip' && head[1] === 'dhcp');
      return touches ? syncSocket(ctx) : [];
    },

    onTimer(ctx: ProcessCtx, key: string): Action[] {
      const i = key.indexOf(':');
      const kind = key.slice(0, i);
      const b = bindings.get(key.slice(i + 1));
      if (b === undefined) return [];
      if (kind === 'offer-hold' && b.state === 'offered') return dropBinding(ctx, b.key, 'aged');
      if (kind === 'binding' && b.state === 'bound') return dropBinding(ctx, b.key, 'aged');
      return [];
    },

    onEvent(ctx: ProcessCtx, ev: ProcessEvent): Action[] {
      if (ev.kind !== 'sock.datagram' || ev.socket !== SOCKET) return [];
      const f = dhcpOf(ev.pdu);
      if (f === undefined) return [];
      if (f.op === 2) return relayBack(ctx, f, ev.pdu);
      if (f.op === 1) return onClientMessage(ctx, f, ev.iface, ev.pdu);
      return [];
    },

    onRequest(): Action[] {
      return [];
    },

    stateSnapshot(): StateView {
      return {
        process: NAME,
        state: { open, bindings: [...bindings.values()], offers, acks, naks, relayed },
      };
    },

    debugEvents(): readonly DebugEvent[] {
      return ring;
    },
  };
}

/** Pool summary for `show ip dhcp pool` (free = hosts − excluded − bindings). */
export function dhcpPoolViews(ctx: Pick<ProcessCtx, 'config' | 'tables'>): DhcpPoolView[] {
  const cfg = dhcpServerConfig(ctx.config.root);
  const rows = ctx.tables.get<DhcpBindingRow>('dhcp-bindings')?.rows() ?? [];
  return cfg.pools
    .filter((p) => p.network !== undefined)
    .map((p) => {
      const net = ipv4ToU32(p.network!);
      const first = net + 1;
      const last = net + 2 ** (32 - p.prefixLen!) - 2;
      let excludedCount = 0;
      for (const [lo, hi] of cfg.excluded) excludedCount += Math.max(0, Math.min(hi, last) - Math.max(lo, first) + 1);
      const bound = rows.filter((r) => r.pool === p.name).length;
      const v: DhcpPoolView = {
        name: p.name,
        network: p.network!,
        prefixLen: p.prefixLen!,
        dns: p.dns,
        leaseS: p.leaseS,
        excluded: cfg.excluded.map(([lo, hi]) => (lo === hi ? u32ToIpv4(lo) : `${u32ToIpv4(lo)}-${u32ToIpv4(hi)}`)),
        free: Math.max(0, last - first + 1 - excludedCount - bound),
        bound,
      };
      if (p.router !== undefined) v.router = p.router;
      if (p.domain !== undefined) v.domain = p.domain;
      return v;
    });
}
