/**
 * P3 acceptance — OSPF on a point-to-point link (ARCHITECTURE-P3 §10.1 `accept.p3.ospf-p2p`; D7, D9, §3.2 step 1,
 * §4.2, §5.8; §7 W4 qa).
 *
 * Two NF-2911 on a GigE link typed `ip ospf network point-to-point`, plus a serial (HDLC) variant, each router with a
 * Loopback0 n.n.n.n/32 in area 0, booted before the cable is plugged in (so every previous origination is more than
 * 5 s old, §3.2). Pinned, from the cable's `linkState up` (U):
 *   • both neighbours FULL within U + 1.5 s; no DR (the interface rows carry no DR/BDR, the neighbour role is `none`,
 *     every hello declares DR 0.0.0.0 and BDR 0.0.0.0, the interface machine goes Down → Point-to-point only);
 *   • the packet order exactly Hello, Hello (the reply), DBD (I/M/MS) ×2, DBD …, LSR, LSU, LSAck;
 *   • the router-LSA with the point-to-point link originated at U + 5 s (MinLSInterval after the origination at U);
 *   • the route installed by the SPF at U + 15 s ± 10 ms (§3.2 step 1);
 *   • `show ip route`: `O    2.2.2.2/32  via 10.0.12.2 [110/2] GigabitEthernet0/0` (serial `[110/65]`).
 * Worlds: `staged.world` at stage P3 with the flip's daemons (ospf.accept.harness.ts).
 */
import { describe, expect, it } from 'vitest';
import type { LinkId } from '../src/contracts/ids.js';
import type { Simulation } from '../src/contracts/simulation.js';
import type { RouteRow } from '../src/contracts/tables.js';
import { SEC, type SimTime } from '../src/contracts/time.js';
import type { TraceEvent } from '../src/contracts/trace.js';
import { acceptWorld, linkUpAt, showLines, traceSince } from './ospf.accept.harness.js';
import { addRouter, cursor, fsmOf, GI0, iface, ifRow, LO0, MS_NS, nbrRows, ospfCreated, ospfRoutes, SE0, tableEvents } from './ospf.harness.js';

const MASK30 = '255.255.255.252';

interface Pair {
  readonly sim: Simulation;
  readonly link: LinkId;
  readonly U: SimTime;
  readonly evs: TraceEvent[];
  readonly port: string;
}

/** R1–R2 on GigE (point-to-point by `ip ospf network`) or serial (HDLC, point-to-point by role, DCE on R1). */
function pair(media: 'gige' | 'serial', seed: number): Pair {
  const sim = acceptWorld(seed);
  const port = media === 'gige' ? GI0 : SE0;
  for (const n of [1, 2]) {
    const extra = media === 'gige' ? ['ip ospf network point-to-point'] : n === 1 ? ['clock rate 64000'] : [];
    addRouter(sim, `r${n}`, `R${n}`, [
      iface(port, `10.0.12.${n}`, MASK30, extra),
      iface(LO0, `${n}.${n}.${n}.${n}`, '255.255.255.255'),
      ['router ospf 1', ` router-id ${n}.${n}.${n}.${n}`, ' network 10.0.12.0 0.0.0.3 area 0', ` network ${n}.${n}.${n}.${n} 0.0.0.0 area 0`],
    ]);
  }
  sim.runFor(90 * SEC);
  const c = cursor(sim);
  const link = sim.addLink(media === 'gige' ? { a: { device: 'r1', port }, b: { device: 'r2', port } } : { a: { device: 'r1', port }, b: { device: 'r2', port }, media: 'serial-dce' });
  expect(sim.runToIdle().stopped).toBeUndefined();
  const evs = traceSince(sim, c);
  return { sim, link, U: linkUpAt(evs, link), evs, port };
}

const routeLine = (lines: readonly string[], key: string): string | undefined => lines.find((l) => l.startsWith('O') && l.includes(` ${key} `));

describe.each([
  { media: 'gige' as const, seed: 21, cost: 1, metric: 2, line: 'O    2.2.2.2/32  via 10.0.12.2 [110/2] GigabitEthernet0/0' },
  { media: 'serial' as const, seed: 22, cost: 64, metric: 65, line: 'O    2.2.2.2/32  via 10.0.12.2 [110/65] Serial0/0/0' },
])('accept.p3.ospf-p2p ($media)', ({ media, seed, cost, metric, line }) => {
  it('FULL within link-up + 1.5 s, with no DR', () => {
    const { sim, U, evs, port } = pair(media, seed);
    for (const d of ['r1', 'r2']) {
      const nbr = fsmOf(evs, d, 'ospf-nbr');
      expect(nbr.map((f) => `${f.from}>${f.to}`)).toEqual(['down>init', 'init>2way', '2way>exstart', 'exstart>exchange', 'exchange>loading', 'loading>full']);
      expect(nbr.at(-1)!.t).toBeGreaterThan(U);
      expect(nbr.at(-1)!.t).toBeLessThan(U + 1500 * MS_NS);
      // no DR on a point-to-point network: Down → Point-to-point only, no DR/BDR anywhere
      expect(fsmOf(evs, d, 'ospf-if', port).map((f) => `${f.from}>${f.to}:${f.cause}`)).toEqual(['down>point-to-point:InterfaceUp']);
      const row = ifRow(sim, d, port)!;
      expect(row).toMatchObject({ networkType: 'point-to-point', state: 'point-to-point', neighbors: 1, adjacent: 1, cost });
      expect(row.dr).toBeUndefined();
      expect(row.bdr).toBeUndefined();
      expect(nbrRows(sim, d)).toMatchObject([{ state: 'full', role: 'none', dr: '0.0.0.0', bdr: '0.0.0.0' }]);
      const hellos = ospfCreated(evs, d).filter((p) => p.kind === 'hello');
      expect(hellos.length).toBeGreaterThan(0);
      for (const h of hellos) expect(h.summary).toContain(', DR 0.0.0.0, BDR 0.0.0.0');
    }
    // show ip ospf neighbor: FULL with no role (`FULL/-`)
    const row = showLines(sim, 'r1', 'show ip ospf neighbor').find((l) => l.startsWith('2.2.2.2 '))!;
    expect(row.split(/ +/).slice(0, 3)).toEqual(['2.2.2.2', '1', 'FULL/-']);
    expect(row.endsWith(` 10.0.12.2     ${port}`) || row.endsWith(port)).toBe(true);
  });

  it('the packet order is exactly Hello, Hello (reply), DBD (I/M/MS) ×2, DBD …, LSR, LSU, LSAck', () => {
    const { U, evs } = pair(media, seed);
    const packets = ospfCreated(evs).filter((p) => p.t < U + 2 * SEC);
    expect(packets.map((p) => p.kind)).toEqual(['hello', 'hello', 'hello', 'hello', 'dbd', 'dbd', 'dbd', 'dbd', 'dbd', 'lsr', 'lsr', 'lsu', 'lsu', 'lsack', 'lsack']);
    // the first two DBDs are the empty I|M|MS of ExStart, one from each router; the rest carry no I flag
    const dbds = packets.filter((p) => p.kind === 'dbd');
    expect(dbds.slice(0, 2).map((p) => [p.device, p.summary.endsWith('flags I M MS')])).toEqual([['r1', true], ['r2', true]]);
    for (const p of dbds.slice(2)) expect(p.summary).not.toMatch(/flags I/);
    for (const d of ['r1', 'r2']) {
      const own = ospfCreated(evs, d).filter((p) => p.t < U + 2 * SEC).map((p) => p.kind);
      // per router: Hello, Hello (reply), DBD (I/M/MS), DBD …, LSR, LSU, LSAck
      expect(own.slice(0, 3)).toEqual(['hello', 'hello', 'dbd']);
      expect(own.slice(-3)).toEqual(['lsr', 'lsu', 'lsack']);
      expect(new Set(own.slice(3, -3))).toEqual(new Set(['dbd']));
      // the hello at link-up, the reply 1 s after the neighbour went Down → Init
      const hellos = ospfCreated(evs, d).filter((p) => p.kind === 'hello' && p.t < U + 2 * SEC);
      const init = fsmOf(evs, d, 'ospf-nbr').find((f) => f.to === 'init')!;
      expect(hellos.map((h) => h.t)).toEqual([U, init.t + SEC]);
      // every packet of a point-to-point network goes to AllSPFRouters (RFC 2328 §8.1)
      expect(new Set(ospfCreated(evs, d).map((p) => p.dst))).toEqual(new Set(['224.0.0.5']));
    }
  });

  it('the point-to-point link is originated at link-up + 5 s; the route is installed by the SPF at link-up + 15 s ± 10 ms', () => {
    const { sim, U, evs, port } = pair(media, seed);
    for (const [d, self, peer] of [['r1', '1.1.1.1', '2.2.2.2'], ['r2', '2.2.2.2', '1.1.1.1']] as const) {
      const own = tableEvents(evs, d, 'ospf-lsdb').filter((e) => e.kind === 'tableWrite' && e.key === `0.0.0.0|1|${self}|${self}`);
      const links = (e: (typeof own)[number]) => (e.row.links as { kind: string; id: string }[]).map((l) => `${l.kind}:${l.id}`);
      // at U: the new stub link only (immediate); at U + 5 s: the point-to-point link (MinLSInterval)
      expect(own.map((e) => e.t - U)).toEqual([0, 5 * SEC]);
      expect(links(own[0]!)).not.toContain(`p2p:${peer}`);
      expect(links(own[0]!)).toContain('stub:10.0.12.0');
      expect(links(own[1]!)).toContain(`p2p:${peer}`);
      // the route to the peer's loopback: installed once, at U + 15 s ± 10 ms
      const writes = tableEvents(evs, d, 'rib').filter((e) => e.kind === 'tableWrite' && e.key === `${peer}/32`);
      expect(writes).toHaveLength(1);
      expect(Math.abs(writes[0]!.t - (U + 15 * SEC))).toBeLessThanOrEqual(10 * MS_NS);
      expect(writes[0]!.row as unknown as RouteRow).toMatchObject({ source: 'O', ad: 110, metric, iface: port, nextHop: `10.0.12.${d === 'r1' ? 2 : 1}` });
    }
    expect(ospfRoutes(sim, 'r1').map((r) => [r.key, r.ad, r.metric])).toEqual([['2.2.2.2/32', 110, metric]]);
  });

  it(`show ip route: O … [110/${metric}]`, () => {
    const { sim } = pair(media, seed);
    const out = showLines(sim, 'r1', 'show ip route');
    expect(out.slice(0, 2)).toEqual([
      'Route source codes: C - connected, L - local, S - static, * - candidate default route',
      'Dynamic sources: O - OSPF, IA - OSPF inter area, E1/E2 - OSPF external type 1/2',
    ]);
    expect(routeLine(out, '2.2.2.2/32')).toBe(line);
    expect(out.filter((l) => l.startsWith('O'))).toEqual([line]);
  });
});
