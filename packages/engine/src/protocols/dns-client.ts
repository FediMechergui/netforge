/**
 * protocols/dns-client.ts — the stub resolver (RFC 1035 §7, RFC 2308 negative caching; ARCHITECTURE-P1 §4.4).
 *
 * Requests:
 *  • `dns.resolve {owner, token, name, qtype, server?}` → ProcessEvent `dns.result` (ResolveEvent) to `owner`;
 *  • `dns.lookup {session, name, server?, qtype?}` (nslookup job) → cliOutput lines in original wording, then cliDone;
 *  • `job.abort {session}` → that session's lookup stops (timer off, socket closed, one line, cliDone).
 * A literal address answers itself, and a name the codec cannot encode (empty label, over 63 chars, non-ASCII, ';')
 * answers NXDOMAIN without touching the wire. Without an explicit server the 'dns-cache' table answers next: live rows only,
 * CNAME rows are followed, a 'negative' row answers NXDOMAIN (`fromCache`). Otherwise the wire:
 *  • servers = `req.server`, else every `ip name-server` address in config order, then the DHCP-learned ones
 *    (`dhcp.lease` events: bound/renewed set the iface's list, lost removes it); none → NO-SERVER;
 *  • query n: socket 'dns-client#q<n>' (ephemeral port, the server's family), txid = one draw from
 *    `ctx.stream('dns-id')` for the whole query, `dns-query` to server:53 with rd, timer `q:<n>` (one-shot);
 *    replies match (socket, txid);
 *  • a timeout or a `sock.error` (port unreachable, no route) is a failed try: DNS_CLIENT_RETRIES more tries on the
 *    same server, then the next server, then TIMEOUT; SERVFAIL (or any other error rcode) moves on at once;
 *  • an answer closes the socket, caches its records per name/type (source 'answer'; NXDOMAIN → a 'negative' row for
 *    DNS_NEGATIVE_TTL_S) and reports the addresses after CNAME chasing.
 * `ip host NAME ADDR…` lines are 'static' rows without expiry, rewritten on every config change. The periodic
 * `dns-sweep` (DNS_SWEEP_NS) runs `expire(now)` while non-static rows exist.
 *
 * The cache and record helpers here are shared with dns-server.
 *
 * Debug category 'dns'. stateSnapshot: { servers, pending: [{ n, name, qtype, id, server, tries }], queries, answers,
 * failures, cacheHits }.
 *
 * ponytail: no search domains, no coalescing of identical queries, NODATA answers are not negative-cached, the
 * negative row is checked for the queried name only, and an explicit server always goes to the wire.
 */
import type { IpAddress, IpFamily } from '../contracts/addr.js';
import type { ConfigNode } from '../contracts/config.js';
import type { PortId, ProcessName, SessionId } from '../contracts/ids.js';
import type { FieldValue } from '../contracts/pdu.js';
import type { Action, DebugEvent, Process, ProcessCtx, ProcessRequest, StateView } from '../contracts/process.js';
import {
  DNS_CLIENT_RETRIES,
  DNS_CLIENT_TIMEOUT_NS,
  DNS_DEFAULT_TTL_S,
  DNS_MAX_CNAME_CHAIN,
  DNS_NEGATIVE_TTL_S,
  DNS_SWEEP_NS,
  type DnsRecord,
  type DnsType,
} from '../contracts/services.js';
import { dnsCacheKey, type DnsCacheRow, type Table } from '../contracts/tables.js';
import { SEC, type SimTime } from '../contracts/time.js';
import type { ProcessEvent, ResolveEvent } from '../contracts/transport.js';
import { configTextLinesOf } from '../cli/config-text.js';
import { ipFamily, normalizeIp } from '../core/addr6.js';
import { dnsRcodeName, isValidDnsName, normalizeDnsName, parseDnsRecords } from '../pdu/codecs/dns.js';

const NAME = 'dns-client';
const CAT = 'dns';
const DEBUG_RING = 256;
const SWEEP = 'dns-sweep';
const CACHED_TYPES: ReadonlySet<string> = new Set(['A', 'AAAA', 'CNAME', 'MX', 'PTR', 'NS']);

// ── helpers shared with dns-server ─────────────────────────────────────────────

/** A/AAAA records of the global `ip host NAME ADDR…` lines (DNS_DEFAULT_TTL_S). */
export function dnsHostRecords(root: ConfigNode): DnsRecord[] {
  const out: DnsRecord[] = [];
  for (const l of configTextLinesOf(root)) {
    const t = l.tokens;
    if (l.context.length !== 0 || t[0] !== 'ip' || t[1] !== 'host' || t[2] === undefined || !isValidDnsName(t[2])) continue;
    const name = normalizeDnsName(t[2]);
    for (const a of t.slice(3)) {
      const ip = normalizeIp(a);
      if (ip !== null) out.push({ name, type: ipFamily(ip) === 4 ? 'A' : 'AAAA', ttl: DNS_DEFAULT_TTL_S, data: ip });
    }
  }
  return out;
}

/** Addresses of the global `ip name-server A [B…]` lines, in config order, without duplicates. */
export function dnsNameServers(root: ConfigNode): IpAddress[] {
  const out: IpAddress[] = [];
  for (const l of configTextLinesOf(root)) {
    const t = l.tokens;
    if (l.context.length !== 0 || t[0] !== 'ip' || t[1] !== 'name-server') continue;
    for (const a of t.slice(2)) {
      const ip = normalizeIp(a);
      if (ip !== null && !out.includes(ip)) out.push(ip);
    }
  }
  return out;
}

/**
 * Follow CNAMEs from `name` (at most DNS_MAX_CNAME_CHAIN) through `find`. `records` = the CNAMEs followed plus the
 * records of `type` at `final` (none when the chain ends without them).
 */
export function chaseCname(name: string, type: string, find: (name: string, type: string) => DnsRecord[]): { records: DnsRecord[]; final: string } {
  const records: DnsRecord[] = [];
  let cur = name;
  for (let i = 0; ; i++) {
    const hits = find(cur, type);
    if (hits.length > 0) return { records: [...records, ...hits], final: cur };
    const c = i < DNS_MAX_CNAME_CHAIN ? find(cur, 'CNAME')[0] : undefined;
    if (c === undefined) return { records, final: cur };
    records.push(c);
    cur = c.data;
  }
}

/** A cache answer: NOERROR with the chain and records (remaining TTL), or NXDOMAIN from a negative row. */
export interface DnsCacheHit {
  rcode: 'NOERROR' | 'NXDOMAIN';
  records: DnsRecord[];
  final: string;
}

/** Look `name`/`type` up in the dns-cache table; undefined on a miss. Expired rows are ignored. */
export function dnsCacheLookup(t: Table<DnsCacheRow> | undefined, name: string, type: string, now: SimTime): DnsCacheHit | undefined {
  if (t === undefined) return undefined;
  const live = (n: string, ty: string): DnsCacheRow | undefined => {
    const r = t.get(dnsCacheKey(n, ty));
    return r !== undefined && (r.expiresAt === undefined || r.expiresAt > now) ? r : undefined;
  };
  const c = chaseCname(name, type, (n, ty) => {
    const r = live(n, ty);
    if (r === undefined) return [];
    const ttl = r.expiresAt === undefined ? r.ttl : Math.floor((r.expiresAt - now) / SEC);
    return r.data.split(';').map((data) => ({ name: n, type: ty as DnsType, ttl, data }));
  });
  if (c.records.some((r) => r.type === type)) return { rcode: 'NOERROR', ...c };
  return live(name, 'NXDOMAIN') !== undefined ? { rcode: 'NXDOMAIN', records: [], final: name } : undefined;
}

/** Records grouped into cache rows (one per name/type, data ';'-joined in answer order). */
function cacheRows(records: readonly DnsRecord[], now: SimTime, source: 'static' | 'answer', server?: IpAddress): Map<string, DnsCacheRow> {
  const rows = new Map<string, DnsCacheRow>();
  for (const r of records) {
    if (!CACHED_TYPES.has(r.type)) continue;
    const key = dnsCacheKey(r.name, r.type);
    const row = rows.get(key);
    if (row !== undefined) row.data += `;${r.data}`;
    else {
      const n: DnsCacheRow = { key, name: r.name, type: r.type as DnsCacheRow['type'], data: r.data, ttl: r.ttl, source, updatedAt: now };
      if (source === 'answer') n.expiresAt = now + r.ttl * SEC;
      if (server !== undefined) n.server = server;
      rows.set(key, n);
    }
  }
  return rows;
}

/** Cache an answer's records and, for NXDOMAIN, a negative row for `nxName`. Static rows are never replaced. Returns the rows written. */
export function dnsCacheWrite(t: Table<DnsCacheRow> | undefined, now: SimTime, server: IpAddress, records: readonly DnsRecord[], nxName?: string): number {
  const rows = cacheRows(records, now, 'answer', server);
  if (nxName !== undefined) {
    const key = dnsCacheKey(nxName, 'NXDOMAIN');
    rows.set(key, { key, name: nxName, type: 'NXDOMAIN', data: '', ttl: DNS_NEGATIVE_TTL_S, expiresAt: now + DNS_NEGATIVE_TTL_S * SEC, source: 'negative', server, updatedAt: now });
  }
  let n = 0;
  for (const row of rows.values()) {
    if (t === undefined || t.get(row.key)?.source === 'static') continue;
    t.set(row);
    n++;
  }
  return n;
}

// ── the resolver ───────────────────────────────────────────────────────────────

type Job = { owner: ProcessName; token: string } | { session: SessionId };
type Result = Pick<ResolveEvent, 'addresses' | 'rcode' | 'server' | 'fromCache' | 'cname'>;

interface Query {
  readonly n: number;
  readonly id: number;
  readonly name: string;
  readonly qtype: 'A' | 'AAAA';
  readonly servers: IpAddress[];
  readonly job: Job;
  /** Index of the server being asked. */
  si: number;
  /** Sends to the current server. */
  tries: number;
  /** Family of the open socket. */
  family?: IpFamily;
}

/** nslookup-style job output (original wording). */
function lookupText(name: string, qtype: string, r: Result): string {
  if (r.rcode === 'NO-SERVER') return `No DNS server is configured; cannot look up ${name}\n`;
  const via = r.server !== undefined ? ` at ${r.server}` : r.fromCache ? ' in the local cache' : '';
  const lines = [`Looking up ${name} (${qtype})${via}`];
  if (r.rcode === 'NOERROR') {
    if (r.cname !== undefined) lines.push(`  canonical name: ${r.cname}`);
    if (r.addresses.length === 0) lines.push(`  no ${qtype} record found`);
    for (const a of r.addresses) lines.push(`  address: ${a}`);
  } else if (r.rcode === 'NXDOMAIN') lines.push('  no such name (NXDOMAIN)');
  else if (r.rcode === 'SERVFAIL') lines.push('  the server could not complete the lookup (SERVFAIL)');
  else lines.push('  no answer before the timeout (TIMEOUT)');
  return `${lines.join('\n')}\n`;
}

export function createDnsClient(): Process {
  const queries = new Map<number, Query>();
  const dhcpServers = new Map<PortId, IpAddress[]>();
  const ring: DebugEvent[] = [];
  let configured: IpAddress[] = [];
  let count = 0;
  let sweepArmed = false;
  let sent = 0;
  let answers = 0;
  let failures = 0;
  let cacheHits = 0;

  function debug(ctx: ProcessCtx, message: string, data?: Record<string, unknown>): void {
    ctx.debug(CAT, message, data);
    const ev: DebugEvent = data
      ? { at: ctx.now, device: ctx.deviceId, process: NAME, category: CAT, message, data }
      : { at: ctx.now, device: ctx.deviceId, process: NAME, category: CAT, message };
    ring.push(ev);
    if (ring.length > DEBUG_RING) ring.splice(0, ring.length - DEBUG_RING);
  }

  const table = (ctx: ProcessCtx): Table<DnsCacheRow> | undefined => ctx.tables.get<DnsCacheRow>('dns-cache');
  const socketOf = (q: Query): string => `${NAME}#q${q.n}`;
  const servers = (): IpAddress[] => [...new Set([...configured, ...[...dhcpServers.values()].flat()])];

  function armSweep(): Action[] {
    if (sweepArmed) return [];
    sweepArmed = true;
    return [{ type: 'timer', key: SWEEP, delay: DNS_SWEEP_NS, periodic: true }];
  }

  /** `ip host` → static rows; `ip name-server` → configured servers. */
  function syncConfig(ctx: ProcessCtx): void {
    configured = dnsNameServers(ctx.config.root);
    const t = table(ctx);
    if (t === undefined) return;
    const want = cacheRows(dnsHostRecords(ctx.config.root), ctx.now, 'static');
    for (const r of t.find((x) => x.source === 'static')) if (!want.has(r.key)) t.delete(r.key, 'cleared');
    for (const r of want.values()) {
      const cur = t.get(r.key);
      if (cur?.source !== 'static' || cur.data !== r.data) t.set(r);
    }
    debug(ctx, `${want.size} static host entr${want.size === 1 ? 'y' : 'ies'}, ${configured.length} configured server(s)`, { hosts: want.size, servers: configured });
  }

  /** Deliver a result to the job's owner or session. */
  function report(ctx: ProcessCtx, job: Job, name: string, qtype: 'A' | 'AAAA', r: Result): Action[] {
    debug(ctx, `${name} ${qtype}: ${r.rcode}${r.addresses.length > 0 ? ` ${r.addresses.join(', ')}` : ''}${r.fromCache ? ' (from cache)' : ''}`, { name, qtype, ...r });
    if ('session' in job) {
      return [
        { type: 'cliOutput', session: job.session, text: lookupText(name, qtype, r) },
        { type: 'cliDone', session: job.session },
      ];
    }
    return [{ type: 'event', to: job.owner, ev: { kind: 'dns.result', token: job.token, name, qtype, ...r } }];
  }

  /** One try to the current server (the socket is (re)opened when the family changes). Timer first: a synchronous sock.error may finish the query. */
  function send(ctx: ProcessCtx, q: Query): Action[] {
    const server = q.servers[q.si]!;
    const family: IpFamily = ipFamily(server) === 6 ? 6 : 4;
    const out: Action[] = [];
    if (q.family !== family) {
      if (q.family !== undefined) out.push({ type: 'request', to: 'udp', req: { kind: 'udp.close', socket: socketOf(q) } });
      out.push({ type: 'request', to: 'udp', req: { kind: 'udp.open', owner: NAME, socket: socketOf(q), family } });
      q.family = family;
    }
    q.tries++;
    sent++;
    debug(ctx, `query ${q.n} id 0x${q.id.toString(16)}: ${q.name} ${q.qtype} to ${server} (try ${q.tries})`, { n: q.n, id: q.id, name: q.name, server, tries: q.tries });
    out.push(
      { type: 'timer', key: `q:${q.n}`, delay: DNS_CLIENT_TIMEOUT_NS },
      {
        type: 'request',
        to: 'udp',
        req: { kind: 'udp.send', socket: socketOf(q), dst: server, dstPort: 53, tag: 'dns-query', app: [{ proto: 'dns', fields: { id: q.id, rd: true, questions: `${q.name} ${q.qtype}` } }] },
      },
    );
    return out;
  }

  function finish(ctx: ProcessCtx, q: Query, r: Result): Action[] {
    queries.delete(q.n);
    return [
      { type: 'cancelTimer', key: `q:${q.n}` },
      { type: 'request', to: 'udp', req: { kind: 'udp.close', socket: socketOf(q) } },
      ...report(ctx, q.job, q.name, q.qtype, r),
    ];
  }

  /** A failed try: retry the same server (timeouts only), else the next server, else give up with `rcode`. */
  function failed(ctx: ProcessCtx, q: Query, rcode: 'TIMEOUT' | 'SERVFAIL', why: string): Action[] {
    const server = q.servers[q.si]!;
    if (rcode === 'TIMEOUT' && q.tries <= DNS_CLIENT_RETRIES) {
      debug(ctx, `query ${q.n}: ${why} from ${server}; retrying`, { n: q.n, server, why });
      return send(ctx, q);
    }
    if (q.si + 1 < q.servers.length) {
      q.si++;
      q.tries = 0;
      debug(ctx, `query ${q.n}: ${why} from ${server}; trying ${q.servers[q.si]!}`, { n: q.n, server, why });
      return send(ctx, q);
    }
    failures++;
    return finish(ctx, q, { rcode, addresses: [], server, fromCache: false });
  }

  function answer(ctx: ProcessCtx, q: Query, f: Readonly<Record<string, FieldValue>>, from: IpAddress): Action[] {
    const rcode = Number(f.rcode ?? 0);
    if (rcode !== 0 && rcode !== 3) return failed(ctx, q, 'SERVFAIL', dnsRcodeName(rcode));
    answers++;
    const records = parseDnsRecords(f.answers);
    const out: Action[] = [];
    if (dnsCacheWrite(table(ctx), ctx.now, from, records, rcode === 3 ? q.name : undefined) > 0) out.push(...armSweep());
    if (rcode === 3) return [...out, ...finish(ctx, q, { rcode: 'NXDOMAIN', addresses: [], server: from, fromCache: false })];
    const c = chaseCname(q.name, q.qtype, (n, t) => records.filter((r) => r.name === n && r.type === t));
    const r: Result = { rcode: 'NOERROR', addresses: c.records.filter((x) => x.type === q.qtype).map((x) => x.data), server: from, fromCache: false };
    if (c.final !== q.name) r.cname = c.final;
    return [...out, ...finish(ctx, q, r)];
  }

  function start(ctx: ProcessCtx, rawName: string, qtype: 'A' | 'AAAA', server: IpAddress | undefined, job: Job): Action[] {
    const literal = normalizeIp(rawName.trim());
    if (literal !== null) return report(ctx, job, literal, qtype, { rcode: 'NOERROR', addresses: [literal], fromCache: false });
    const name = normalizeDnsName(rawName);
    // a name the codec cannot encode (empty label, > 63 chars, non-ASCII, ';') never reaches the wire
    if (!isValidDnsName(name)) {
      debug(ctx, `${name} is not a usable DNS name`, { name });
      return report(ctx, job, name, qtype, { rcode: 'NXDOMAIN', addresses: [], fromCache: false });
    }
    if (server === undefined) {
      const hit = dnsCacheLookup(table(ctx), name, qtype, ctx.now);
      if (hit !== undefined) {
        cacheHits++;
        const r: Result = { rcode: hit.rcode, addresses: hit.records.filter((x) => x.type === qtype).map((x) => x.data), fromCache: true };
        if (hit.final !== name) r.cname = hit.final;
        return report(ctx, job, name, qtype, r);
      }
    }
    const list = server !== undefined ? [normalizeIp(server)].filter((s): s is IpAddress => s !== null) : servers();
    if (list.length === 0) return report(ctx, job, name, qtype, { rcode: 'NO-SERVER', addresses: [], fromCache: false });
    const q: Query = { n: ++count, id: ctx.stream('dns-id').nextU32() & 0xffff, name, qtype, servers: list, job, si: 0, tries: 0 };
    queries.set(q.n, q);
    return send(ctx, q);
  }

  return {
    name: NAME,

    init(ctx: ProcessCtx): Action[] {
      syncConfig(ctx);
      return [];
    },

    onPdu(_ctx, pdu, port): Action[] {
      return [{ type: 'drop', pdu, reason: 'unsupported-protocol', detail: 'dns-client takes datagrams from its udp sockets', port }];
    },

    onConfig(ctx, delta): Action[] {
      if (delta.context.length === 0 && delta.line[0] === 'ip' && (delta.line[1] === 'host' || delta.line[1] === 'name-server')) syncConfig(ctx);
      return [];
    },

    onTimer(ctx, key): Action[] {
      if (key === SWEEP) {
        const t = table(ctx);
        for (const r of t?.expire(ctx.now) ?? []) debug(ctx, `cache entry ${r.name} ${r.type} expired`, { name: r.name, type: r.type });
        sweepArmed = (t?.rows() ?? []).some((r) => r.source !== 'static');
        return sweepArmed ? [{ type: 'timer', key: SWEEP, delay: DNS_SWEEP_NS, periodic: true }] : [];
      }
      const q = key.startsWith('q:') ? queries.get(Number(key.slice(2))) : undefined;
      return q === undefined ? [] : failed(ctx, q, 'TIMEOUT', 'no answer');
    },

    onEvent(ctx, ev: ProcessEvent): Action[] {
      if (ev.kind === 'dhcp.lease') {
        if (ev.op === 'lost') dhcpServers.delete(ev.iface);
        else dhcpServers.set(ev.iface, ev.dnsServers.map((a) => normalizeIp(a)).filter((a): a is IpAddress => a !== null));
        debug(ctx, `${ev.iface}: DHCP ${ev.op}, DNS servers ${dhcpServers.get(ev.iface)?.join(', ') || 'none'}`, { iface: ev.iface, op: ev.op });
        return [];
      }
      if (ev.kind !== 'sock.datagram' && ev.kind !== 'sock.error') return [];
      const q = [...queries.values()].find((x) => socketOf(x) === ev.socket);
      if (q === undefined) return [];
      if (ev.kind === 'sock.error') return failed(ctx, q, 'TIMEOUT', ev.code);
      const f = ev.pdu.layers.find((l) => l.proto === 'dns')?.fields;
      if (f === undefined || f.qr !== true || f.id !== q.id) {
        debug(ctx, `query ${q.n}: ignored a datagram from ${ev.from} that is not its answer`, { n: q.n, pdu: ev.pdu.id });
        return [];
      }
      return answer(ctx, q, f, ev.from);
    },

    onRequest(ctx, req: ProcessRequest): Action[] {
      if (req.kind === 'dns.resolve') return start(ctx, req.name, req.qtype, req.server, { owner: req.owner, token: req.token });
      if (req.kind === 'dns.lookup') return start(ctx, req.name, req.qtype ?? 'A', req.server, { session: req.session });
      if (req.kind !== 'job.abort') return [];
      const q = [...queries.values()].find((x) => 'session' in x.job && x.job.session === req.session);
      if (q === undefined) return [];
      queries.delete(q.n);
      debug(ctx, `query ${q.n}: aborted`, { n: q.n });
      return [
        { type: 'cancelTimer', key: `q:${q.n}` },
        { type: 'request', to: 'udp', req: { kind: 'udp.close', socket: socketOf(q) } },
        { type: 'cliOutput', session: req.session, text: `Lookup of ${q.name} aborted\n` },
        { type: 'cliDone', session: req.session },
      ];
    },

    stateSnapshot(): StateView {
      return {
        process: NAME,
        state: {
          servers: servers(),
          pending: [...queries.values()].map((q) => ({ n: q.n, name: q.name, qtype: q.qtype, id: q.id, server: q.servers[q.si], tries: q.tries })),
          queries: sent,
          answers,
          failures,
          cacheHits,
        },
      };
    },

    debugEvents(): readonly DebugEvent[] {
      return ring;
    },
  };
}
