/**
 * protocols/dns-server.ts — the DNS server with optional forwarding (RFC 1035 §4.3.2, §6; ARCHITECTURE-P1 §4.4).
 *
 * Silent unless the config has `ip dns server`; then it owns socket 'dns-server#53' (0.0.0.0:53).
 * Records: `ip host NAME ADDR…` (A / AAAA, DNS_DEFAULT_TTL_S) and `ip dns record NAME TYPE DATA TTL` (A, AAAA, CNAME,
 * NS, PTR). Forwarders: the IPv4 `ip name-server` addresses, in config order.
 * A query (qr 0; the first question is answered):
 *  • a name it holds → aa answer, CNAME chains followed up to DNS_MAX_CNAME_CHAIN; NOERROR without answers when the
 *    name has no record of that type;
 *  • else a live 'dns-cache' row (an earlier relayed answer) → answer without aa (NXDOMAIN for a negative row);
 *  • else rd and a forwarder → a new query (id from `ctx.stream('dns-fwd-id')`) to the first forwarder that is not one
 *    of our own addresses, timer `fwd:<n>` (DNS_CLIENT_TIMEOUT_NS, one-shot) → SERVFAIL to the client on timeout. The
 *    forwarder's answer is cached (source 'answer'; NXDOMAIN → a 'negative' row for DNS_NEGATIVE_TTL_S) and relayed
 *    with the client's id, `triggeredBy` that answer. A question already being forwarded is answered SERVFAIL at once,
 *    which ends forwarding loops of any length (two servers naming each other, a server naming itself);
 *  • else NXDOMAIN.
 * Replies echo id, rd and the question, set ra when forwarders exist, go back to the query's source address and port
 * with tag 'dns-response' and leave from the address the query was sent to (RFC 2181 §4.1), `triggeredBy` the query.
 * Additionals are never sent (relays drop them), so lab-sized replies stay within DNS_UDP_MAX; tc is never set.
 * The rows cached from a forwarder are swept by a periodic `dns-sweep` (DNS_SWEEP_NS), armed at the first write and
 * re-armed while non-static rows remain.
 *
 * Debug category 'dns'. stateSnapshot: { enabled, records, forwarders, queries, answered, nxdomain, forwarded }.
 *
 * ponytail: one forwarder is asked (no failover or retries), IPv4 only, no zones/SOA/delegation, answers are not
 * trimmed to 512 B, MX/SOA records cannot be configured (their data has spaces), and a second client asking a
 * question already in flight gets SERVFAIL instead of waiting for the shared answer.
 */
import { isIpv4, type IpAddress, type Ipv4Address } from '../contracts/addr.js';
import type { ConfigNode } from '../contracts/config.js';
import type { PduId } from '../contracts/ids.js';
import type { FieldValue } from '../contracts/pdu.js';
import type { Action, DebugEvent, Process, ProcessCtx, ProcessRequest, StateView } from '../contracts/process.js';
import { DNS_CLIENT_TIMEOUT_NS, DNS_SWEEP_NS, type DnsRecord, type DnsType } from '../contracts/services.js';
import type { DnsCacheRow, Table } from '../contracts/tables.js';
import type { ProcessEvent } from '../contracts/transport.js';
import { configTextLinesOf } from '../cli/config-text.js';
import { normalizeIpv6 } from '../core/addr6.js';
import { dnsRcodeName, formatDnsRecords, isValidDnsName, normalizeDnsName, parseDnsQuestions, parseDnsRecords } from '../pdu/codecs/dns.js';
import { chaseCname, dnsCacheLookup, dnsCacheWrite, dnsHostRecords, dnsNameServers } from './dns-client.js';

const NAME = 'dns-server';
const CAT = 'dns';
const DEBUG_RING = 256;
const SOCKET = 'dns-server#53';
const SWEEP = 'dns-sweep';
const RECORD_TYPES: ReadonlySet<string> = new Set(['A', 'AAAA', 'CNAME', 'NS', 'PTR']);

export interface DnsServerConfig {
  enabled: boolean;
  records: DnsRecord[];
  forwarders: Ipv4Address[];
}

/** One `ip dns record` line as a record, or undefined when it is not valid. */
function recordOf(name: string, type: string, data: string, ttl: string): DnsRecord | undefined {
  const ty = type.toUpperCase();
  const n = Number(ttl);
  if (!RECORD_TYPES.has(ty) || !Number.isInteger(n) || n < 0 || n > 0x7fffffff || !isValidDnsName(name)) return undefined;
  // a name the codec cannot encode would throw while the reply is built, so the line is ignored instead
  const d = ty === 'A' ? (isIpv4(data) ? data : null) : ty === 'AAAA' ? normalizeIpv6(data) : isValidDnsName(data) ? normalizeDnsName(data) : null;
  return d === null ? undefined : { name: normalizeDnsName(name), type: ty as DnsType, ttl: n, data: d };
}

/** Service switch, records and forwarders from the running config. */
export function dnsServerConfig(root: ConfigNode): DnsServerConfig {
  const records = dnsHostRecords(root);
  let enabled = false;
  for (const l of configTextLinesOf(root)) {
    const t = l.tokens;
    if (l.context.length !== 0 || t[0] !== 'ip' || t[1] !== 'dns') continue;
    if (t[2] === 'server') enabled = true;
    const r = t[2] === 'record' && t.length === 7 ? recordOf(t[3]!, t[4]!, t[5]!, t[6]!) : undefined;
    if (r !== undefined) records.push(r);
  }
  return { enabled, records, forwarders: dnsNameServers(root).filter(isIpv4) };
}

/** A query waiting for the forwarder. `reply` is the answer template for the client (its id, rd, question). */
interface Forward {
  readonly n: number;
  readonly id: number;
  readonly server: Ipv4Address;
  readonly name: string;
  readonly type: string;
  readonly client: IpAddress;
  readonly clientPort: number;
  /** The address the client queried: the answer goes back from it (RFC 2181 §4.1). */
  readonly local?: IpAddress;
  readonly query: PduId;
  readonly reply: Record<string, FieldValue>;
}

export function createDnsServer(): Process {
  const pending = new Map<number, Forward>();
  const ring: DebugEvent[] = [];
  let cfg: DnsServerConfig = { enabled: false, records: [], forwarders: [] };
  let open = false;
  let sweepArmed = false;
  let count = 0;
  let queries = 0;
  let answered = 0;
  let nxdomain = 0;
  let forwarded = 0;

  function debug(ctx: ProcessCtx, message: string, data?: Record<string, unknown>): void {
    ctx.debug(CAT, message, data);
    const ev: DebugEvent = data
      ? { at: ctx.now, device: ctx.deviceId, process: NAME, category: CAT, message, data }
      : { at: ctx.now, device: ctx.deviceId, process: NAME, category: CAT, message };
    ring.push(ev);
    if (ring.length > DEBUG_RING) ring.splice(0, ring.length - DEBUG_RING);
  }

  const table = (ctx: ProcessCtx): Table<DnsCacheRow> | undefined => ctx.tables.get<DnsCacheRow>('dns-cache');

  function sync(ctx: ProcessCtx): Action[] {
    cfg = dnsServerConfig(ctx.config.root);
    if (cfg.enabled === open) return [];
    open = cfg.enabled;
    debug(ctx, open ? 'DNS service started' : 'DNS service stopped', { records: cfg.records.length, forwarders: cfg.forwarders });
    if (open) return [{ type: 'request', to: 'udp', req: { kind: 'udp.open', owner: NAME, socket: SOCKET, family: 4, localAddr: '0.0.0.0', localPort: 53 } }];
    const out: Action[] = [...pending.keys()].map((n): Action => ({ type: 'cancelTimer', key: `fwd:${n}` }));
    pending.clear();
    out.push({ type: 'request', to: 'udp', req: { kind: 'udp.close', socket: SOCKET } });
    return out;
  }

  function reply(ctx: ProcessCtx, dst: IpAddress, dstPort: number, fields: Record<string, FieldValue>, triggeredBy: PduId, src?: IpAddress): Action {
    const rcode = Number(fields.rcode);
    if (rcode === 0) answered++;
    if (rcode === 3) nxdomain++;
    debug(ctx, `reply ${dnsRcodeName(rcode)} id 0x${Number(fields.id).toString(16)} to ${dst}: ${String(fields.answers ?? '') || 'no answers'}`, { dst, rcode, triggeredBy });
    const req: Extract<ProcessRequest, { kind: 'udp.send' }> = { kind: 'udp.send', socket: SOCKET, dst, dstPort, tag: 'dns-response', triggeredBy, app: [{ proto: 'dns', fields }] };
    if (src !== undefined) req.src = src;
    return { type: 'request', to: 'udp', req };
  }

  /** The queried address, when it is one of ours: replies leave from it, whatever interface they take. */
  const localOf = (ctx: ProcessCtx, to: IpAddress): IpAddress | undefined => (ctx.ownAddress(to) !== undefined ? to : undefined);

  /** Periodic sweep of the rows we cached from a forwarder (dns-client arms the same timer for its own rows). */
  function armSweep(): Action[] {
    if (sweepArmed) return [];
    sweepArmed = true;
    return [{ type: 'timer', key: SWEEP, delay: DNS_SWEEP_NS, periodic: true }];
  }

  function onQuery(ctx: ProcessCtx, f: Readonly<Record<string, FieldValue>>, ev: Extract<ProcessEvent, { kind: 'sock.datagram' }>): Action[] {
    queries++;
    const q = parseDnsQuestions(f.questions)[0];
    if (q === undefined) {
      debug(ctx, `query from ${ev.from} without a question ignored`, { pdu: ev.pdu.id });
      return [];
    }
    const local = localOf(ctx, ev.to);
    const base: Record<string, FieldValue> = { id: Number(f.id), qr: true, opcode: 0, aa: true, tc: false, rd: f.rd === true, ra: cfg.forwarders.length > 0, rcode: 0, questions: `${q.name} ${q.type}` };
    const answer = (records: DnsRecord[], aa: boolean, rcode: number): Action[] => [
      reply(ctx, ev.from, ev.fromPort, { ...base, aa, rcode, answers: formatDnsRecords(records) }, ev.pdu.id, local),
    ];
    if (cfg.records.some((r) => r.name === q.name)) return answer(chaseCname(q.name, q.type, (n, t) => cfg.records.filter((r) => r.name === n && r.type === t)).records, true, 0);
    const hit = dnsCacheLookup(table(ctx), q.name, q.type, ctx.now);
    if (hit !== undefined) return answer(hit.records, false, hit.rcode === 'NXDOMAIN' ? 3 : 0);
    // never forward to ourselves, and never twice for the same question: that ends forwarding loops of any length
    const server = cfg.forwarders.find((a) => ctx.ownAddress(a) === undefined);
    if (base.rd !== true || server === undefined) return answer([], true, 3);
    if ([...pending.values()].some((x) => x.name === q.name && x.type === q.type)) {
      debug(ctx, `${q.name} ${q.type} is already being forwarded; SERVFAIL to ${ev.from}`, { name: q.name, type: q.type, pdu: ev.pdu.id });
      return answer([], false, 2);
    }

    const fw: Forward = {
      n: ++count,
      id: ctx.stream('dns-fwd-id').nextU32() & 0xffff,
      server,
      name: q.name,
      type: q.type,
      client: ev.from,
      clientPort: ev.fromPort,
      ...(local !== undefined ? { local } : {}),
      query: ev.pdu.id,
      reply: base,
    };
    pending.set(fw.n, fw);
    forwarded++;
    debug(ctx, `forward ${q.name} ${q.type} to ${server} as id 0x${fw.id.toString(16)}`, { n: fw.n, id: fw.id, server, pdu: ev.pdu.id });
    return [
      { type: 'timer', key: `fwd:${fw.n}`, delay: DNS_CLIENT_TIMEOUT_NS },
      {
        type: 'request',
        to: 'udp',
        req: { kind: 'udp.send', socket: SOCKET, dst: server, dstPort: 53, tag: 'dns-query', triggeredBy: ev.pdu.id, app: [{ proto: 'dns', fields: { id: fw.id, rd: true, questions: base.questions! } }] },
      },
    ];
  }

  /** The forwarder answered: cache, then relay to the client with its own id. */
  function onForwarderAnswer(ctx: ProcessCtx, f: Readonly<Record<string, FieldValue>>, ev: Extract<ProcessEvent, { kind: 'sock.datagram' }>): Action[] {
    const fw = [...pending.values()].find((x) => x.id === f.id && x.server === ev.from);
    if (fw === undefined) {
      debug(ctx, `unexpected answer from ${ev.from} ignored`, { pdu: ev.pdu.id });
      return [];
    }
    pending.delete(fw.n);
    const rcode = Number(f.rcode ?? 0);
    const out: Action[] = [{ type: 'cancelTimer', key: `fwd:${fw.n}` }];
    if ((rcode === 0 || rcode === 3) && dnsCacheWrite(table(ctx), ctx.now, ev.from, parseDnsRecords(f.answers), rcode === 3 ? fw.name : undefined) > 0) out.push(...armSweep());
    out.push(reply(ctx, fw.client, fw.clientPort, { ...fw.reply, aa: false, rcode, answers: f.answers ?? '', authorities: f.authorities ?? '' }, ev.pdu.id, fw.local));
    return out;
  }

  return {
    name: NAME,

    init(ctx): Action[] {
      return sync(ctx);
    },

    onPdu(_ctx, pdu, port): Action[] {
      return [{ type: 'drop', pdu, reason: 'unsupported-protocol', detail: 'dns-server takes datagrams from its udp socket', port }];
    },

    onConfig(ctx, delta): Action[] {
      const k = delta.line[1];
      return delta.context.length === 0 && delta.line[0] === 'ip' && (k === 'dns' || k === 'host' || k === 'name-server') ? sync(ctx) : [];
    },

    onTimer(ctx, key): Action[] {
      if (key === SWEEP) {
        const t = table(ctx);
        for (const r of t?.expire(ctx.now) ?? []) debug(ctx, `cache entry ${r.name} ${r.type} expired`, { name: r.name, type: r.type });
        sweepArmed = (t?.rows() ?? []).some((r) => r.source !== 'static');
        return sweepArmed ? [{ type: 'timer', key: SWEEP, delay: DNS_SWEEP_NS, periodic: true }] : [];
      }
      const fw = key.startsWith('fwd:') ? pending.get(Number(key.slice(4))) : undefined;
      if (fw === undefined) return [];
      pending.delete(fw.n);
      debug(ctx, `forwarder ${fw.server} did not answer ${fw.name}`, { n: fw.n, server: fw.server });
      return [reply(ctx, fw.client, fw.clientPort, { ...fw.reply, aa: false, rcode: 2, answers: '' }, fw.query, fw.local)];
    },

    onEvent(ctx, ev: ProcessEvent): Action[] {
      if (ev.kind === 'sock.error' && ev.socket === SOCKET) debug(ctx, `socket error ${ev.code}${ev.detail !== undefined ? ` (${ev.detail})` : ''}`, { code: ev.code });
      if (ev.kind !== 'sock.datagram' || ev.socket !== SOCKET) return [];
      const f = ev.pdu.layers.find((l) => l.proto === 'dns')?.fields;
      if (f === undefined) return [];
      return f.qr === true ? onForwarderAnswer(ctx, f, ev) : onQuery(ctx, f, ev);
    },

    onRequest(): Action[] {
      return [];
    },

    stateSnapshot(): StateView {
      return { process: NAME, state: { enabled: open, records: cfg.records, forwarders: cfg.forwarders, queries, answered, nxdomain, forwarded } };
    },

    debugEvents(): readonly DebugEvent[] {
      return ring;
    },
  };
}
