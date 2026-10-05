/**
 * P3 acceptance [C1] — EIGRP neighbours, metrics, the topology table and the mismatches (ARCHITECTURE-P3 §10.1 row
 * `accept.p3.eigrp`; §3.12 steps 1–2 and 6, D26, D11, §2.16, §5.1, §5.8; §7 W4 qa).
 *
 * Built on `staged.world` at stage P3 with the registry the W4 flip writes (`accept.p3.eigrp.world.ts`): the §3.12
 * world, every router configured through the grammar (`Simulation.configure`) before the cables go in at one instant,
 * so "link-up" is that instant. The row, clause by clause:
 *   • step 1: the neighbour sequence on R1–R2 — hello (at link-up), hello reply, init update, acknowledgement — with
 *     exact packets (every field), the 224.0.0.10 join, the `eigrp-nbr` transitions and the neighbour row (written at
 *     pending and once at up with SRTT and RTO, never again), the full topology as a reliable Update with EOT; every
 *     neighbour of every router up within link-up + 10 ms;
 *   • step 2: every metric of §3.12 (3328, 3072, 28672, computed in the test from D26's formula), the
 *     `eigrp-topology[10.4.0.0/24]` row exactly, one rib write for the prefix (one `ipv4.routes` batch), `show ip
 *     eigrp topology` and `show ip route` exactly (the `D` code, AD 90, the second legend line), every EIGRP route
 *     within link-up + 50 ms, and R1 reaching PC4;
 *   • D11: with a DHCP-learned `D*` default in the same table, the legend sentence follows (R4); without one it does not;
 *   • equal-cost `maximum-paths`: two successors share the rib row (one row, two paths, the continuation line);
 *     `maximum-paths 1` typed at run time keeps one, and the other becomes a feasible successor;
 *   • a passive interface sends no hello and forms no neighbour, but its network is advertised (R2 learns it via R1);
 *   • step 6: `metric weights 0 1 1 1 0 0` on R2 only — every router facing R2 and R2 itself refuse, log once at
 *     severity 5, and never form (60 s); `router eigrp 200` on R2 — its hellos are ignored with a debug line, no log;
 *   • `auto-summary` refused with `eigrpAutoSummary` (`no auto-summary` accepted, not rendered); a second AS refused;
 *   • golden bytes against RFC 7868: the hello, the init update and the acknowledgement as hand-computed hex, the
 *     internal-route TLV of 10.4.0.0/24 as R2 advertises it, the IP and Ethernet framing of a hello, and every EIGRP
 *     packet of the run re-encoded by an independent RFC 7868 encoder written here.
 */
import { describe, expect, it } from 'vitest';
import { AD_EIGRP } from '../src/contracts/tables.js';
import { CLI_MESSAGES } from '../src/contracts/cli.js';
import { EIGRP_GROUP, IPPROTO_EIGRP } from '../src/contracts/pdu.js';
import { MS, SEC } from '../src/contracts/time.js';
import type { TraceEvent } from '../src/contracts/trace.js';
import {
  GI0,
  GI1,
  LAN,
  PC4,
  R1,
  R2,
  R3,
  R4,
  R4_UPLINK,
  eigrpAcceptWorld,
  eigrpCreated,
  eigrpFields,
  eventsFrom,
  neighborRows,
  ribRow,
  ribWrites,
  shown,
  topologyRow,
  transitions,
  typed,
  upAt,
  type Created,
  type Debug,
  type Log,
} from './accept.p3.eigrp.world.js';

// ── D26's composite metric, written out (K 1 0 1 0 0) ─────────────────────────────────────────────────────────────

/** 256 × (floor(10⁷ / minimum bandwidth kb/s) + floor(Σ delay µs / 10)). */
const classic = (minBwKbps: number, delayUs: number): number => 256 * (Math.floor(10_000_000 / minBwKbps) + Math.floor(delayUs / 10));
const GIGE = { bw: 1_000_000, delay: 10 };
const SLOW = { bw: 100_000, delay: 100 };

// ── an independent RFC 7868 encoder (header, parameter TLV, classic IPv4 internal-route TLV) ─────────────────────

function onesComplement(b: Uint8Array): number {
  let s = 0;
  for (let i = 0; i < b.length; i += 2) s += (b[i]! << 8) | (b[i + 1] ?? 0);
  while (s > 0xffff) s = (s & 0xffff) + Math.floor(s / 0x10000);
  return ~s & 0xffff;
}

/** The RFC 7868 bytes of a packet given its decoded fields (the codec's `routes` text form for the route TLVs). */
function rfc7868(f: Readonly<Record<string, unknown>>): Uint8Array {
  const out: number[] = [];
  const u8 = (v: number): void => void out.push(v & 0xff);
  const u16 = (v: number): void => (u8(Math.floor(v / 0x100)), u8(v));
  const u32 = (v: number): void => (u16(Math.floor(v / 0x10000)), u16(v % 0x10000));
  u8(2); // version
  u8(Number(f['opcode']));
  u16(0); // checksum, filled below
  u32(Number(f['flags'] ?? 0));
  u32(Number(f['seq'] ?? 0));
  u32(Number(f['ack'] ?? 0));
  u16(0); // virtual router id
  u16(Number(f['as']));
  if (typeof f['kValues'] === 'string') {
    u16(0x0001); // parameter TLV
    u16(12);
    for (const k of f['kValues'].split(',')) u8(Number(k));
    u8(0); // K6, reserved
    u16(Number(f['holdS']));
  }
  const routes = typeof f['routes'] === 'string' ? f['routes'] : '';
  for (const entry of routes === '' ? [] : routes.split(';')) {
    const [prefix, delay, bw, mtu, hops, rel, load, nextHop] = entry.split(',') as [string, string, string, string, string, string, string, string];
    const [net, lenText] = prefix.split('/') as [string, string];
    const len = Number(lenText);
    const n = Math.ceil(len / 8);
    u16(0x0102); // IPv4 internal route
    u16(25 + n);
    for (const o of nextHop.split('.')) u8(Number(o));
    u32(delay === 'inf' ? 0xffffffff : Math.floor(Number(delay) / 10) * 256);
    u32(Number(bw) === 0 ? 0 : Math.floor(10_000_000 / Number(bw)) * 256);
    u8(Math.floor(Number(mtu) / 0x10000));
    u16(Number(mtu) % 0x10000);
    u8(Number(hops));
    u8(Number(rel));
    u8(Number(load));
    u8(0); // route tag
    u8(0); // flags
    u8(len);
    for (const o of net.split('.').slice(0, n)) u8(Number(o));
  }
  const bytes = Uint8Array.from(out);
  const sum = onesComplement(bytes);
  bytes[2] = sum >>> 8;
  bytes[3] = sum & 0xff;
  return bytes;
}

const hex = (b: Uint8Array): string => Buffer.from(b).toString('hex');

/** The eigrp layer's bytes of a created packet, as the wire carried it. */
function eigrpBytes(sim: ReturnType<typeof eigrpAcceptWorld>['sim'], c: Created): Uint8Array {
  const p = sim.pdu(c.pdu.id)!;
  const l = p.layer('eigrp')!;
  return p.bytes.subarray(l.offset, l.offset + l.length);
}

/** The world of the row, run to idle from the cabling; with its events and link-up. */
function converged(opts: Parameters<typeof eigrpAcceptWorld>[0] = {}) {
  const w = eigrpAcceptWorld(opts);
  const stats = w.sim.runToIdle();
  const evs = eventsFrom(w.sim, w.cursor);
  return { ...w, stats, evs, linkUp: upAt(evs, R1, GI0) };
}

const logsOf = (evs: readonly TraceEvent[], facility: string): Log[] => evs.filter((e): e is Log => e.kind === 'log' && e.facility === facility);

describe('accept.p3.eigrp [C1]: §3.12 step 1, neighbours', () => {
  it('hello, hello reply, init update, acknowledgement — exact packets; every neighbour up within link-up + 10 ms', () => {
    const { sim, evs, linkUp, stats, cabledAt } = converged();
    expect(stats.stopped).toBeUndefined();
    expect(linkUp).toBe(cabledAt);
    // R1 joined 224.0.0.10 on both enabled interfaces
    for (const p of [GI0, GI1]) expect(sim.device(R1)!.ports.get(p)!.l3.groups4).toEqual([EIGRP_GROUP]);

    // R1's packets on the R1–R2 link, in order: the first four are the neighbour sequence of §3.12 step 1
    const onLink = eigrpCreated(evs, R1).filter((c) => (c.pdu.flow ?? '').startsWith('ipv4:10.0.12.1>'));
    const hello = { version: 2, opcode: 5, flags: 0, seq: 0, ack: 0, vrid: 0, as: 100, kValues: '1,0,1,0,0', holdS: 15 };
    const strip = (f: Record<string, unknown>): Record<string, unknown> => {
      const { checksum: _c, checksumValid, ...rest } = f;
      expect(checksumValid).toBe(true);
      return rest;
    };
    const seq = onLink.slice(0, 4).map((c) => [c.pdu.tag, c.pdu.flow, strip(eigrpFields(sim, c))]);
    expect(seq).toEqual([
      ['eigrp-hello', `ipv4:10.0.12.1>${EIGRP_GROUP}:eigrp`, hello],
      ['eigrp-hello', `ipv4:10.0.12.1>${EIGRP_GROUP}:eigrp`, hello],
      ['eigrp-update', 'ipv4:10.0.12.1>10.0.12.2:eigrp', { version: 2, opcode: 1, flags: 1, seq: 1, ack: 0, vrid: 0, as: 100 }],
      ['eigrp-ack', 'ipv4:10.0.12.1>10.0.12.2:eigrp', { version: 2, opcode: 5, flags: 0, seq: 0, ack: 1, vrid: 0, as: 100 }],
    ]);
    // the hello at link-up; the hello reply and the init update at the instant R2's hello creates the pending neighbour
    const nbr = transitions(evs, R1, 'eigrp-nbr').filter((t) => t.subject === `${GI0} 10.0.12.2`);
    expect(nbr.map((t) => [t.from, t.to, t.cause])).toEqual([
      ['down', 'pending', 'hello received'],
      ['pending', 'up', 'init update acknowledged'],
    ]);
    expect(onLink[0]!.t).toBe(linkUp);
    expect(onLink[1]!.t).toBe(nbr[0]!.t);
    expect(onLink[2]!.t).toBe(nbr[0]!.t);
    expect(onLink[3]!.t).toBeGreaterThan(onLink[2]!.t);
    // R2 does the same toward R1 (the exchange is symmetric)
    const r2 = eigrpCreated(evs, R2).filter((c) => (c.pdu.flow ?? '').startsWith('ipv4:10.0.12.2>')).slice(0, 4);
    expect(r2.map((c) => [c.pdu.tag, eigrpFields(sim, c)['seq'], eigrpFields(sim, c)['ack'], eigrpFields(sim, c)['flags']])).toEqual([
      ['eigrp-hello', 0, 0, 0],
      ['eigrp-hello', 0, 0, 0],
      ['eigrp-update', 1, 0, 1],
      ['eigrp-ack', 0, 1, 0],
    ]);
    // then the whole topology as a reliable update with EOT, the next sequence number, once the neighbour is up
    const full = onLink[4]!;
    expect(full.t).toBe(nbr[1]!.t);
    expect(eigrpFields(sim, full)).toMatchObject({ opcode: 1, flags: 8, seq: 2, ack: 0 });
    expect(String(eigrpFields(sim, full)['routes']).split(';').map((r) => r.split(',')[0])).toEqual(['10.0.12.0/24', '10.0.13.0/24']);

    // the neighbour row: written at pending and once at up, with SRTT and RTO measured once
    const key = `${GI0}|10.0.12.2`;
    const writes = evs.filter((e): e is Extract<TraceEvent, { kind: 'tableWrite' }> => e.kind === 'tableWrite' && e.device === R1 && e.table === 'eigrp-neighbors' && e.key === key);
    expect(writes.map((w) => ({ ...w.row, updatedAt: undefined }))).toEqual([
      { key, iface: GI0, address: '10.0.12.2', as: 100, state: 'pending', holdS: 15, srttMs: 0, rtoMs: 200, updatedAt: undefined },
      { key, iface: GI0, address: '10.0.12.2', as: 100, state: 'up', holdS: 15, srttMs: 1, rtoMs: 200, upSince: nbr[1]!.t, updatedAt: undefined },
    ]);
    expect(sim.device(R1)!.tables.get('eigrp-neighbors')!.get(key)).toMatchObject({ state: 'up', upSince: nbr[1]!.t });

    // every neighbour of every router is up within link-up + 10 ms
    const ups = [R1, R2, R3, R4].flatMap((d) => transitions(evs, d, 'eigrp-nbr').filter((t) => t.to === 'up').map((t) => ({ d, subject: t.subject, dt: t.t - linkUp })));
    expect(ups.map((u) => `${u.d} ${u.subject}`).sort()).toEqual([
      `r1 ${GI0} 10.0.12.2`,
      `r1 ${GI1} 10.0.13.3`,
      `r2 ${GI0} 10.0.12.1`,
      `r2 ${GI1} 10.0.24.4`,
      `r3 ${GI0} 10.0.13.1`,
      `r3 ${GI1} 10.0.34.4`,
      'r4 GigabitEthernet0/0/0 10.0.24.2',
      'r4 GigabitEthernet0/0/1 10.0.34.3',
    ]);
    for (const u of ups) expect(u.dt, `${u.d} ${u.subject}`).toBeLessThan(10 * MS);

    // a minute of hellos rewrites no neighbour row (rule 20: the hold countdown lives in the StateView)
    const later = sim.trace(0).next;
    sim.runFor(60 * SEC);
    expect(eventsFrom(sim, later).filter((e) => e.kind === 'tableWrite' && e.table === 'eigrp-neighbors')).toEqual([]);
    expect(neighborRows(sim, R1).map((r) => [r.address, r.state])).toEqual([['10.0.12.2', 'up'], ['10.0.13.3', 'up']]);
  });
});

describe('accept.p3.eigrp [C1]: §3.12 step 2, metrics and tables', () => {
  it('3328, 3072 and 28672; the topology row; show ip eigrp topology and show ip route exactly; routes within link-up + 50 ms', () => {
    const { sim, evs, linkUp } = converged();
    // D26's numbers for 10.4.0.0/24 at R1
    const viaR2 = classic(GIGE.bw, GIGE.delay * 3); // R1 Gi0/0 + R2 → R4 + R4's LAN
    const rdR2 = classic(GIGE.bw, GIGE.delay * 2);
    const viaR3 = classic(SLOW.bw, SLOW.delay + GIGE.delay * 2);
    const rdR3 = classic(GIGE.bw, GIGE.delay * 2);
    expect([viaR2, rdR2, viaR3, rdR3]).toEqual([3328, 3072, 28672, 3072]);
    expect(topologyRow(sim, R1, LAN)).toEqual({
      key: LAN,
      updatedAt: expect.any(Number),
      prefix: LAN,
      state: 'passive',
      fd: viaR2,
      successors: [{ nextHop: '10.0.12.2', iface: GI0, metric: viaR2, rd: rdR2 }],
      feasible: [{ nextHop: '10.0.13.3', iface: GI1, metric: viaR3, rd: rdR3 }],
      others: [],
    });
    // R3 is a feasible successor: its reported distance is below the feasible distance
    expect(rdR3).toBeLessThan(viaR2);
    // one ipv4.routes batch: the prefix written once, as EIGRP, AD 90
    expect(ribWrites(evs, R1, LAN)).toHaveLength(1);
    const row = ribRow(sim, R1, LAN)!;
    expect(row).toMatchObject({ network: '10.4.0.0', prefixLen: 24, source: 'EIGRP', ad: AD_EIGRP, metric: viaR2, nextHop: '10.0.12.2', iface: GI0, owner: 'eigrp' });
    expect(AD_EIGRP).toBe(90);
    expect(row.paths).toBeUndefined();
    expect(shown(sim, R1, 'show ip eigrp topology')).toEqual([
      'EIGRP topology, AS 100, router ID 10.0.13.1',
      'Codes: P passive, A active, U update, Q query, R reply',
      '',
      'P 10.0.12.0/24, 1 successor, FD 2816',
      `        via Connected, ${GI0}`,
      'P 10.0.13.0/24, 1 successor, FD 28160',
      `        via Connected, ${GI1}`,
      'P 10.0.24.0/24, 1 successor, FD 3072',
      `        via 10.0.12.2 (3072/2816), ${GI0}`,
      'P 10.0.34.0/24, 1 successor, FD 3328',
      `        via 10.0.12.2 (3328/3072), ${GI0}`,
      `        via 10.0.13.3 (28416/2816), ${GI1}`,
      'P 10.4.0.0/24, 1 successor, FD 3328',
      `        via 10.0.12.2 (3328/3072), ${GI0}`,
      `        via 10.0.13.3 (28672/3072), ${GI1}`,
    ]);
    expect(shown(sim, R1, 'show ip route')).toEqual([
      'Route source codes: C - connected, L - local, S - static, * - candidate default route',
      'Dynamic sources: D - EIGRP',
      '',
      'Default route: none configured',
      '',
      `C    10.0.12.0/24  connected  ${GI0}`,
      `L    10.0.12.1/32  connected  ${GI0}`,
      `C    10.0.13.0/24  connected  ${GI1}`,
      `L    10.0.13.1/32  connected  ${GI1}`,
      `D    10.0.24.0/24  via 10.0.12.2 [90/3072] ${GI0}`,
      `D    10.0.34.0/24  via 10.0.12.2 [90/3328] ${GI0}`,
      `D    10.4.0.0/24  via 10.0.12.2 [90/3328] ${GI0}`,
    ]);
    // every EIGRP route of every router is in by link-up + 50 ms
    const eigrpWrites = evs.filter((e): e is Extract<TraceEvent, { kind: 'tableWrite' }> => e.kind === 'tableWrite' && e.table === 'rib' && e.row['source'] === 'EIGRP');
    expect(new Set(eigrpWrites.map((w) => w.device))).toEqual(new Set([R1, R2, R3, R4]));
    for (const w of eigrpWrites) expect(w.t - linkUp, `${w.device} ${w.key}`).toBeLessThan(50 * MS);
    // and the routes carry traffic: R1 reaches PC4
    const s = sim.cli.open(R1, 'console');
    const cursor = sim.trace(0).next;
    sim.cli.exec(s, 'ping 10.4.0.10');
    sim.runFor(15 * SEC);
    const out = eventsFrom(sim, cursor).flatMap((e) => (e.kind === 'cliOutput' && e.session === s ? [e.text] : []));
    expect(out.join('')).toContain('Sent 5, received 5, lost 0 (0% loss)');
    expect(sim.device(PC4)!.ports.get('GigabitEthernet0')!.counters.inPackets).toBeGreaterThan(0);
  });

  it('D11: a DHCP D* default in the same table brings the legend sentence; EIGRP stays the machine source EIGRP', () => {
    const { sim } = eigrpAcceptWorld({ dhcpUplink: true });
    sim.runFor(30 * SEC);
    sim.runToIdle();
    expect(ribRow(sim, R4, '0.0.0.0/0')).toMatchObject({ source: 'D', ad: 254, nextHop: '192.168.99.1', iface: R4_UPLINK, isDefault: true });
    expect(ribRow(sim, R4, '10.0.12.0/24')).toMatchObject({ source: 'EIGRP', ad: 90, metric: 3072 });
    expect(shown(sim, R4, 'show ip route')).toEqual([
      'Route source codes: C - connected, L - local, S - static, * - candidate default route',
      'Dynamic sources: D - EIGRP',
      'A D* route at distance 254 was learned by DHCP.',
      '',
      'Default route: via 192.168.99.1 (D*)',
      '',
      `D*   0.0.0.0/0  via 192.168.99.1 [254/0] ${R4_UPLINK}`,
      'D    10.0.12.0/24  via 10.0.24.2 [90/3072] GigabitEthernet0/0/0',
      'D    10.0.13.0/24  via 10.0.34.3 [90/28416] GigabitEthernet0/0/1',
      'C    10.0.24.0/24  connected  GigabitEthernet0/0/0',
      'L    10.0.24.4/32  connected  GigabitEthernet0/0/0',
      'C    10.0.34.0/24  connected  GigabitEthernet0/0/1',
      'L    10.0.34.4/32  connected  GigabitEthernet0/0/1',
      'C    10.4.0.0/24  connected  GigabitEthernet0/1/0',
      'L    10.4.0.1/32  connected  GigabitEthernet0/1/0',
      `C    192.168.99.0/24  connected  ${R4_UPLINK}`,
      `L    192.168.99.2/32  connected  ${R4_UPLINK}`,
    ]);
    // R1 has no DHCP default: the second legend line alone
    expect(shown(sim, R1, 'show ip route').slice(0, 3)).toEqual([
      'Route source codes: C - connected, L - local, S - static, * - candidate default route',
      'Dynamic sources: D - EIGRP',
      '',
    ]);
  });
});

describe('accept.p3.eigrp [C1]: maximum-paths and passive interfaces', () => {
  it('equal-cost successors share one rib row up to maximum-paths; maximum-paths 1 keeps one', () => {
    const { sim } = converged({ variant: 'ecmp' });
    expect(topologyRow(sim, R1, LAN)).toMatchObject({
      fd: 3328,
      successors: [
        { nextHop: '10.0.12.2', iface: GI0, metric: 3328, rd: 3072 },
        { nextHop: '10.0.13.3', iface: GI1, metric: 3328, rd: 3072 },
      ],
      feasible: [],
    });
    const row = ribRow(sim, R1, LAN)!;
    expect(row).toMatchObject({ source: 'EIGRP', nextHop: '10.0.12.2', iface: GI0, metric: 3328 });
    expect(row.paths?.map((p) => [p.nextHop, p.iface])).toEqual([['10.0.12.2', GI0], ['10.0.13.3', GI1]]);
    const route = shown(sim, R1, 'show ip route');
    expect(route.slice(-2)).toEqual([`D    10.4.0.0/24  via 10.0.12.2 [90/3328] ${GI0}`, `                  via 10.0.13.3 [90/3328] ${GI1}`]);
    expect(shown(sim, R1, 'show ip eigrp topology').slice(-3)).toEqual([
      'P 10.4.0.0/24, 2 successors, FD 3328',
      `        via 10.0.12.2 (3328/3072), ${GI0}`,
      `        via 10.0.13.3 (3328/3072), ${GI1}`,
    ]);
    // maximum-paths 1, typed at run time
    typed(sim, R1, ['router eigrp 100', 'maximum-paths 1', 'exit']);
    sim.runToIdle();
    expect(topologyRow(sim, R1, LAN)).toMatchObject({
      fd: 3328,
      successors: [{ nextHop: '10.0.12.2', iface: GI0, metric: 3328, rd: 3072 }],
      feasible: [{ nextHop: '10.0.13.3', iface: GI1, metric: 3328, rd: 3072 }],
    });
    expect(ribRow(sim, R1, LAN)!.paths).toBeUndefined();
    expect(shown(sim, R1, 'show ip route').at(-1)).toBe(`D    10.4.0.0/24  via 10.0.12.2 [90/3328] ${GI0}`);
    expect(shown(sim, R1, 'show running-config | include maximum-paths')).toEqual([' maximum-paths 1', '']);
  });

  it('passive-interface Gi0/1 on R1: no hello out of it and no neighbour there, but its network is advertised', () => {
    const w = eigrpAcceptWorld({ process: { [R1]: ['router eigrp 100', 'network 10.0.0.0', `passive-interface ${GI1}`] } });
    const { sim } = w;
    const cursor = sim.trace(0).next;
    sim.runToIdle();
    sim.runFor(30 * SEC);
    const evs = eventsFrom(sim, cursor);
    // nothing leaves R1 on Gi0/1, and the group is not joined there
    expect(eigrpCreated(evs, R1).filter((c) => (c.pdu.flow ?? '').startsWith('ipv4:10.0.13.1>'))).toEqual([]);
    expect(eigrpCreated(evs, R1).filter((c) => c.pdu.tag === 'eigrp-hello').length).toBeGreaterThan(5);
    expect(sim.device(R1)!.ports.get(GI1)!.l3.groups4).toBeUndefined();
    expect(neighborRows(sim, R1).map((r) => r.address)).toEqual(['10.0.12.2']);
    expect(neighborRows(sim, R3).map((r) => r.address)).toEqual(['10.0.34.4']);
    // the passive network is still in R1's topology and advertised: R2 reaches it through R1 (100 Mb/s, 100 + 10 µs)
    expect(topologyRow(sim, R1, '10.0.13.0/24')).toMatchObject({ state: 'passive', connected: GI1, fd: classic(SLOW.bw, SLOW.delay) });
    expect(ribRow(sim, R2, '10.0.13.0/24')).toMatchObject({ source: 'EIGRP', nextHop: '10.0.12.1', iface: GI0, metric: classic(SLOW.bw, SLOW.delay + GIGE.delay) });
    expect(shown(sim, R1, 'show ip eigrp interfaces')).toEqual([
      'EIGRP interfaces, AS 100',
      'Interface  Peers  Hello (s)  Hold (s)  Bandwidth (kb/s)  Delay (usec)  Passive',
      'Gi0/0      1      5          15        1000000           10            no',
      'Gi0/1      0      5          15        100000            100           yes',
    ]);
    expect(shown(sim, R1, 'show ip protocols')).toContain(`  Passive interfaces: ${GI1}`);
  });
});

describe('accept.p3.eigrp [C1]: §3.12 step 6, mismatches', () => {
  it('metric weights 0 1 1 1 0 0 on R2 only: R1, R4 and R2 refuse each other, log once at severity 5, never form', () => {
    const w = eigrpAcceptWorld({ process: { [R2]: ['router eigrp 100', 'network 10.0.0.0', 'metric weights 0 1 1 1 0 0'] } });
    const { sim } = w;
    const cursor = sim.trace(0).next;
    const stats = sim.runToIdle();
    expect(stats.stopped).toBeUndefined();
    sim.runFor(60 * SEC);
    const evs = eventsFrom(sim, cursor);
    const logs = logsOf(evs, 'EIGRP').map((l) => [l.device, l.severity, l.message]);
    expect(logs.sort()).toEqual([
      [R1, 5, `EIGRP 100: neighbour 10.0.12.2 (${GI0}) refused: K-value mismatch (theirs 1 1 1 0 0, ours 1 0 1 0 0)`],
      [R2, 5, `EIGRP 100: neighbour 10.0.12.1 (${GI0}) refused: K-value mismatch (theirs 1 0 1 0 0, ours 1 1 1 0 0)`],
      [R2, 5, `EIGRP 100: neighbour 10.0.24.4 (${GI1}) refused: K-value mismatch (theirs 1 0 1 0 0, ours 1 1 1 0 0)`],
      [R4, 5, 'EIGRP 100: neighbour 10.0.24.2 (GigabitEthernet0/0/0) refused: K-value mismatch (theirs 1 1 1 0 0, ours 1 0 1 0 0)'],
    ].sort());
    // every hello of R2 is refused with the reason (twelve or more in a minute), and never forms a neighbour
    const refused = evs.filter((e) => e.kind === 'drop' && e.device === R1 && e.port === GI0 && e.detail === 'K-value mismatch with 10.0.12.2: theirs 1 1 1 0 0, ours 1 0 1 0 0');
    expect(refused.length).toBeGreaterThanOrEqual(12);
    expect(transitions(evs, R1, 'eigrp-nbr').filter((t) => t.subject === `${GI0} 10.0.12.2`)).toEqual([]);
    expect(neighborRows(sim, R1).map((r) => r.address)).toEqual(['10.0.13.3']);
    expect(neighborRows(sim, R2)).toEqual([]);
    expect(neighborRows(sim, R4).map((r) => r.address)).toEqual(['10.0.34.3']);
    // R1 still reaches 10.4.0.0/24, through R3
    expect(ribRow(sim, R1, LAN)).toMatchObject({ source: 'EIGRP', nextHop: '10.0.13.3', metric: 28672 });
  });

  it('router eigrp 200 on R2: its hellos are ignored with a debug line; no log, no neighbour', () => {
    const w = eigrpAcceptWorld({ process: { [R2]: ['router eigrp 200', 'network 10.0.0.0'] } });
    const { sim } = w;
    const cursor = sim.trace(0).next;
    expect(sim.runToIdle().stopped).toBeUndefined();
    sim.runFor(20 * SEC);
    const evs = eventsFrom(sim, cursor);
    const ignored = evs.filter((e): e is Debug => e.kind === 'debug' && e.event.device === R1 && e.event.category === 'eigrp packets' && e.event.message === `ignored hello from 10.0.12.2 on ${GI0}: AS 200, this router runs AS 100`);
    expect(ignored.length).toBeGreaterThanOrEqual(4);
    expect(evs.some((e) => e.kind === 'drop' && e.device === R1 && e.detail === 'EIGRP hello for AS 200 ignored: this router runs AS 100')).toBe(true);
    expect(logsOf(evs, 'EIGRP')).toEqual([]);
    expect(neighborRows(sim, R1).map((r) => r.address)).toEqual(['10.0.13.3']);
    expect(neighborRows(sim, R2)).toEqual([]);
  });

  it('auto-summary is refused; no auto-summary is accepted and not rendered; a second AS is refused', () => {
    const { sim } = eigrpAcceptWorld();
    const r = sim.configure(R1, ['router eigrp 100', 'auto-summary'], { stopOnError: false });
    expect(r.lines.map((l) => [l.line, l.ok, l.error?.message])).toEqual([
      ['router eigrp 100', true, undefined],
      ['auto-summary', false, CLI_MESSAGES.eigrpAutoSummary],
    ]);
    typed(sim, R1, ['router eigrp 100', 'no auto-summary', 'exit']);
    expect(shown(sim, R1, 'show running-config | section router eigrp')).toEqual(['router eigrp 100', ' network 10.0.0.0', '']);
    const second = sim.configure(R1, ['router eigrp 200']);
    expect(second.lines[0]).toMatchObject({ ok: false, error: { message: CLI_MESSAGES.eigrpOneProcess.replace(/\{as\}/g, '100') } });
  });
});

describe('accept.p3.eigrp [C1]: golden bytes against RFC 7868', () => {
  it('the hello, the init update, the acknowledgement and a route TLV are the hand-computed bytes; every packet re-encodes', () => {
    const { sim, evs } = converged();
    const r1 = eigrpCreated(evs, R1).filter((c) => (c.pdu.flow ?? '').startsWith('ipv4:10.0.12.1>'));
    // version 2, opcode 5, checksum, flags 0, seq 0, ack 0, vrid 0, AS 100; parameter TLV (type 1, length 12) K 1 0 1 0 0,
    // K6 0, hold 15
    expect(hex(eigrpBytes(sim, r1[0]!))).toBe('0205fb7a' + '00000000' + '00000000' + '00000000' + '0000' + '0064' + '0001000c' + '0100010000' + '00' + '000f');
    // the init update: opcode 1, flags 1 (init), seq 1, no TLV
    expect(hex(eigrpBytes(sim, r1[2]!))).toBe('0201fd98' + '00000001' + '00000001' + '00000000' + '0000' + '0064');
    // the acknowledgement: a hello with ack 1 and no TLV
    expect(hex(eigrpBytes(sim, r1[3]!))).toBe('0205fd95' + '00000000' + '00000000' + '00000001' + '0000' + '0064');
    // the IP and Ethernet framing of the hello: protocol 88, TTL 2, TOS 0xc0 (CS6), to 224.0.0.10 at 01:00:5e:00:00:0a
    const frame = sim.pdu(r1[0]!.pdu.id)!;
    expect(frame.layer('ipv4')!.fields).toMatchObject({ src: '10.0.12.1', dst: EIGRP_GROUP, protocol: IPPROTO_EIGRP, ttl: 2, dscp: 48 });
    expect(IPPROTO_EIGRP).toBe(88);
    const ip = frame.layer('ipv4')!;
    expect(frame.bytes[ip.offset + 1]).toBe(0xc0);
    expect(frame.bytes[ip.offset + 8]).toBe(2);
    expect(frame.bytes[ip.offset + 9]).toBe(88);
    expect(frame.layer('ethernet')!.fields['dst']).toBe('01:00:5e:00:00:0a');

    // R2's update to R1 carries 10.4.0.0/24 as it learned it from R4: next hop 0.0.0.0 (the sender), delay 20 µs
    // (2 × 256), bandwidth 10⁷ / 1 000 000 (10 × 256), MTU 1500, 1 hop, reliability 255, load 1, tag 0, flags 0, /24
    const tlv = '0102001c' + '00000000' + '00000200' + '00000a00' + '0005dc' + '01' + 'ff' + '01' + '00' + '00' + '18' + '0a0400';
    const carrying = eigrpCreated(evs, R2, 'ipv4:10.0.12.2>10.0.12.1:eigrp').filter((c) => hex(eigrpBytes(sim, c)).includes(tlv));
    expect(carrying.length).toBeGreaterThanOrEqual(1);
    expect(eigrpFields(sim, carrying[0]!)['opcode']).toBe(1);

    // every EIGRP packet of the run: the bytes on the wire are the RFC 7868 bytes of its decoded fields
    const all = [R1, R2, R3, R4].flatMap((d) => eigrpCreated(evs, d));
    expect(all.length).toBeGreaterThan(40);
    for (const c of all) expect(hex(eigrpBytes(sim, c)), `${c.device} ${c.pdu.summary}`).toBe(hex(rfc7868(eigrpFields(sim, c))));
  });
});
