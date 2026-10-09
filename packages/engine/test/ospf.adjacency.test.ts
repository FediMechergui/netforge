/**
 * ospf.adjacency — neighbours and adjacencies of the ospf daemon on `staged.world` (ARCHITECTURE-P3 D7, D9, §3.1,
 * §3.2 step 1, §4.2, §4.3; §7 W2 ospf): point-to-point (GigE and serial) and broadcast networks; the hello reply 1 s
 * after a neighbour goes Down → Init (coalesced); the DR-change hello and §3.1's R1 sequence Waiting → DROther → Backup;
 * ExStart with the D9 DD sequence number and the higher router id as master; a DBD received from a neighbour in Init
 * (§3.1 step 7); priority 0; DROthers at 2-Way with each other; dead-interval expiry and DR failover; silence unless
 * configured; `clear ip ospf process` applying a new router id. Routers are configured through `startupConfig` and
 * `applyConfigLine` (rule 13).
 */
import { describe, expect, it } from 'vitest';
import { ipv4ToU32 } from '../src/contracts/addr.js';
import type { Simulation } from '../src/contracts/simulation.js';
import { SEC } from '../src/contracts/time.js';
import type { TraceEvent } from '../src/contracts/trace.js';
import { OSPF_DD_FLAG } from '../src/pdu/codecs/ospf.js';
import { createOspf } from '../src/protocols/ospf.js';
import { dbdVerdict, ospfDdSeqInitial } from '../src/protocols/ospf/nsm.js';
import {
  addRouter,
  adminPort,
  cursor,
  debugLines,
  eventsSince,
  fsmOf,
  GI0,
  iface,
  ifRow,
  LO0,
  lsdbRows,
  MS_NS,
  nbrRows,
  ospfCreated,
  ospfRoutes,
  ospfView,
  ospfWorld,
  portUpAt,
  SE0,
  setLine,
  startup,
  tableEvents,
} from './ospf.harness.js';
import { createStagedSimulation } from './staged.world.js';

const P2P = ['ip ospf network point-to-point'];

/** Two NF-2911 on a GigE link with `ip ospf network point-to-point`, loopbacks n.n.n.n; Gi0/0 shut until `up()`. */
function p2pPair(): { sim: Simulation; up: () => { evs: () => TraceEvent[]; U: () => number } } {
  const sim = ospfWorld(11);
  for (const n of [1, 2]) {
    addRouter(sim, `r${n}`, `R${n}`, [
      iface(GI0, `10.0.12.${n}`, '255.255.255.252', P2P, false),
      iface(LO0, `${n}.${n}.${n}.${n}`, '255.255.255.255'),
      ['router ospf 1', ` router-id ${n}.${n}.${n}.${n}`, ' network 10.0.12.0 0.0.0.3 area 0', ` network ${n}.${n}.${n}.${n} 0.0.0.0 area 0`],
    ]);
  }
  sim.addLink({ a: { device: 'r1', port: GI0 }, b: { device: 'r2', port: GI0 } });
  sim.runFor(60 * SEC);
  return {
    sim,
    up: () => {
      const c = cursor(sim);
      adminPort(sim, 'r1', GI0, true);
      adminPort(sim, 'r2', GI0, true);
      const evs = (): TraceEvent[] => eventsSince(sim, c);
      return { evs, U: () => portUpAt(evs(), 'r1', GI0)! };
    },
  };
}

/** §3.1: SW1 (PortFast on Fa0/1–3) with R1, R2, R3 (router ids n.n.n.n) on 10.0.123.0/24; every Gi0/0 shut at first. */
function lan(priorities: readonly number[] = [1, 1, 1, 1], routers = 3): Simulation {
  const sim = ospfWorld(5);
  const ports = Array.from({ length: routers }, (_, k) => k + 1);
  sim.addDevice({
    id: 'sw1',
    type: 'switch.nfc2960',
    name: 'SW1',
    startupConfig: startup([['hostname SW1'], ...ports.map((k) => [`interface FastEthernet0/${k}`, ' spanning-tree portfast'])]),
  });
  for (const n of ports) {
    const pri = priorities[n - 1] ?? 1;
    addRouter(sim, `r${n}`, `R${n}`, [
      iface(GI0, `10.0.123.${n}`, '255.255.255.0', pri === 1 ? [] : [`ip ospf priority ${pri}`], false),
      ['router ospf 1', ` router-id ${n}.${n}.${n}.${n}`, ' network 10.0.123.0 0.0.0.255 area 0'],
    ]);
    sim.addLink({ a: { device: `r${n}`, port: GI0 }, b: { device: 'sw1', port: `FastEthernet0/${n}` } });
  }
  sim.runFor(100 * SEC);
  return sim;
}

const hellosOf = (evs: readonly TraceEvent[], device: string) => ospfCreated(evs, device).filter((p) => p.kind === 'hello');

describe('ospf.adjacency: point-to-point networks (§3.2 step 1)', () => {
  it('a GigE point-to-point pair: Hello, the hello reply 1 s later, DBD I|M|MS ×2, the exchange, LSR, LSU, LSAck; Full within link-up + 1.5 s; no DR', () => {
    const { sim, up } = p2pPair();
    const run = up();
    sim.runToIdle();
    const evs = run.evs();
    const U = run.U();
    expect(portUpAt(evs, 'r2', GI0)).toBe(U);
    // the packet order of the acceptance row (both routers' packets, by creation)
    const packets = ospfCreated(evs).filter((p) => p.t < U + 2 * SEC);
    expect(packets.map((p) => p.kind)).toEqual(['hello', 'hello', 'hello', 'hello', 'dbd', 'dbd', 'dbd', 'dbd', 'dbd', 'lsr', 'lsr', 'lsu', 'lsu', 'lsack', 'lsack']);
    // every packet of a point-to-point network goes to AllSPFRouters (RFC 2328 §8.1)
    expect(new Set(packets.map((p) => p.dst))).toEqual(new Set(['224.0.0.5']));
    for (const d of ['r1', 'r2']) {
      const nbr = fsmOf(evs, d, 'ospf-nbr');
      expect(nbr.map((f) => `${f.from}>${f.to}`)).toEqual(['down>init', 'init>2way', '2way>exstart', 'exstart>exchange', 'exchange>loading', 'loading>full']);
      expect(nbr.at(-1)!.t).toBeLessThan(U + 1500 * MS_NS);
      expect(nbr.at(-1)!.t).toBeGreaterThan(U + SEC);
      expect(fsmOf(evs, d, 'ospf-if')).toMatchObject([{ subject: GI0, from: 'down', to: 'point-to-point', cause: 'InterfaceUp' }]);
      const row = ifRow(sim, d, GI0)!;
      expect(row).toMatchObject({ networkType: 'point-to-point', state: 'point-to-point', neighbors: 1, adjacent: 1, cost: 1, costSource: 'bandwidth' });
      expect(row.dr).toBeUndefined();
      expect(row.bdr).toBeUndefined();
    }
    expect(nbrRows(sim, 'r1')).toMatchObject([{ key: `${GI0}|2.2.2.2`, routerId: '2.2.2.2', address: '10.0.12.2', state: 'full', role: 'none', dr: '0.0.0.0', bdr: '0.0.0.0' }]);
    // the loopbacks are /32 host stubs: R1 reaches 2.2.2.2/32 at cost 1 + 1
    expect(ospfRoutes(sim, 'r1').map((r) => [r.key, r.metric, r.nextHop, r.iface])).toEqual([['2.2.2.2/32', 2, '10.0.12.2', GI0]]);
  });

  it('the hello reply: one extra hello 1 s after the neighbour went Down → Init; the periodic hello keeps its 10 s grid', () => {
    const { sim, up } = p2pPair();
    const run = up();
    sim.runFor(25 * SEC);
    const evs = run.evs();
    const U = run.U();
    const init = fsmOf(evs, 'r1', 'ospf-nbr').find((f) => f.to === 'init')!;
    expect(hellosOf(evs, 'r1').map((h) => h.t)).toEqual([U, init.t + SEC, U + 10 * SEC, U + 20 * SEC]);
    // the reply lists the neighbour, the first hello does not
    const neighbours = debugLines(evs, 'r1', 'ip ospf hello').filter((l) => l.message.includes('hello sent')).map((l) => l.message.replace(/^.*neighbours /, ''));
    expect(neighbours).toEqual(['none', '2.2.2.2', '2.2.2.2', '2.2.2.2']);
  });

  it('ExStart: the D9 DD sequence number, the higher router id is master, the slave adopts and echoes its sequence', () => {
    const { sim, up } = p2pPair();
    const run = up();
    sim.runToIdle();
    const evs = run.evs();
    const seq0 = ospfDdSeqInitial('1.1.1.1', '2.2.2.2', 0);
    expect(seq0).toBe((ipv4ToU32('1.1.1.1') ^ ipv4ToU32('2.2.2.2')) & 0x7fffffff);
    const dbds = ospfCreated(evs).filter((p) => p.kind === 'dbd').map((p) => `${p.device} ${p.summary.replace(/^.*, seq /, 'seq ')}`);
    expect(dbds).toEqual([
      `r1 seq ${seq0}, flags I M MS`,
      `r2 seq ${seq0}, flags I M MS`,
      `r1 seq ${seq0}`, // R1, the slave: MS clear, its LSA header, M clear
      `r2 seq ${seq0 + 1}, flags MS`, // R2, the master: seq + 1 with its header
      `r1 seq ${seq0 + 1}`, // the slave's echo; both M clear: ExchangeDone
    ]);
    expect(nbrRows(sim, 'r1')[0]!.master).toBe(true); // R1's view: the neighbour 2.2.2.2 is master
    expect(nbrRows(sim, 'r2')[0]!.master).toBe(false);
    expect(fsmOf(evs, 'r1', 'ospf-nbr').find((f) => f.to === 'exchange')!.cause).toBe('NegotiationDone');
  });

  it('a DBD received from a neighbour in Init is 2-WayReceived first (RFC 2328 §10.6): R2 restarts, R1 holds it in Init', () => {
    const { sim, up } = p2pPair();
    up();
    sim.runToIdle();
    sim.runFor(3 * SEC);
    const before = lsdbRows(sim, 'r1').find((r) => r.key === '0.0.0.0|1|2.2.2.2|2.2.2.2')!.seq;
    const c = cursor(sim);
    sim.device('r2')!.applyActions('sim', [{ type: 'request', to: 'ospf', req: { kind: 'ospf.clear' } }], sim.now);
    sim.runToIdle();
    const evs = eventsSince(sim, c);
    // R2's restart hello lists nobody: 1-WayReceived on R1, which keeps listing R2 in its hellos
    const r1nbr = fsmOf(evs, 'r1', 'ospf-nbr', `${GI0} 2.2.2.2`);
    expect(r1nbr.map((f) => `${f.from}>${f.to}:${f.cause}`)).toEqual([
      'full>init:1-WayReceived',
      'init>2way:2-WayReceived',
      '2way>exstart:AdjOK?',
      'exstart>exchange:NegotiationDone',
      'exchange>full:ExchangeDone', // R1 already holds every LSA R2 describes (R2's restarted copies are older)
    ]);
    // the 2-WayReceived came with R2's first DBD (R1's periodic hello made R2 2-Way, R2's reply is 1 s later)
    const dbd = sim.pdu(r1nbr[1]!.pdu!)!;
    expect(dbd.summary()).toMatch(/^OSPF database description from 2\.2\.2\.2 area 0\.0\.0\.0, seq \d+, flags I M MS$/);
    const firstDbd = ospfCreated(evs, 'r2').find((p) => p.kind === 'dbd')!;
    expect(firstDbd.t).toBeLessThan(r1nbr[1]!.t);
    expect(ospfCreated(evs, 'r2').filter((p) => p.kind === 'hello' && p.t > firstDbd.t - SEC && p.t < r1nbr[1]!.t)).toEqual([]);
    // R2 learnt its own router-LSA of the previous run from R1 (newer than its restarted 0x80000001) and, once Full
    // again, wants exactly that content: both databases hold the same instance
    const after = lsdbRows(sim, 'r1').find((r) => r.key === '0.0.0.0|1|2.2.2.2|2.2.2.2')!;
    expect(after.seq).toBeGreaterThanOrEqual(before);
    expect(lsdbRows(sim, 'r2').find((r) => r.key === after.key)).toMatchObject({ seq: after.seq, checksum: after.checksum, self: true });
    expect(after.links!.filter((l) => l.kind === 'p2p')).toEqual([{ kind: 'p2p', id: '1.1.1.1', data: '10.0.12.2', metric: 1 }]);
    expect(ospfRoutes(sim, 'r1').map((r) => [r.key, r.metric])).toEqual([['2.2.2.2/32', 2]]);
  });

  it('a serial HDLC link is point-to-point by role (no network line needed); its cost is 64 (1544 kb/s)', () => {
    const sim = ospfWorld(3);
    for (const n of [1, 2]) {
      addRouter(sim, `r${n}`, `R${n}`, [
        iface(SE0, `10.0.13.${n}`, '255.255.255.252', n === 1 ? ['clock rate 64000'] : []),
        iface(LO0, `${n}.${n}.${n}.${n}`, '255.255.255.255'),
        ['router ospf 1', ` router-id ${n}.${n}.${n}.${n}`, ' network 0.0.0.0 255.255.255.255 area 0'],
      ]);
    }
    sim.addLink({ a: { device: 'r1', port: SE0 }, b: { device: 'r2', port: SE0 }, media: 'serial-dce' });
    sim.runToIdle();
    expect(ifRow(sim, 'r1', SE0)).toMatchObject({ networkType: 'point-to-point', state: 'point-to-point', cost: 64, adjacent: 1 });
    expect(nbrRows(sim, 'r1').map((r) => [r.routerId, r.state])).toEqual([['2.2.2.2', 'full']]);
    expect(ifRow(sim, 'r1', LO0)).toMatchObject({ networkType: 'loopback', state: 'loopback', cost: 1, neighbors: 0 });
    expect(ospfRoutes(sim, 'r1').map((r) => [r.key, r.metric, r.nextHop, r.iface])).toEqual([['2.2.2.2/32', 65, '10.0.13.2', SE0]]);
  });
});

describe('ospf.adjacency: broadcast networks and the DR election (§3.1)', () => {
  it('§3.1 steps 1–6: R2 DR at U + 40 s, R1 Waiting → DROther → Backup within 1 ms on the DR-change hello, Full, one hello per (DR, BDR) change', () => {
    const sim = lan();
    const c = cursor(sim);
    adminPort(sim, 'r1', GI0, true);
    adminPort(sim, 'r2', GI0, true);
    sim.runToIdle();
    const evs = eventsSince(sim, c);
    const U = portUpAt(evs, 'r1', GI0)!;
    expect(portUpAt(evs, 'r2', GI0)).toBe(U);
    // step 1: Waiting with the draining bar, a hello at once, 224.0.0.5 joined
    expect(fsmOf(evs, 'r1', 'ospf-if')[0]).toMatchObject({ t: U, from: 'down', to: 'waiting', cause: 'InterfaceUp' });
    expect(tableEvents(evs, 'r1', 'ospf-interfaces').find((e) => e.kind === 'tableWrite' && e.row.state === 'waiting')!.row.waitUntil).toBe(U + 40 * SEC);
    expect(sim.device('r1')!.portView(GI0)!.l3.groups4).toEqual(['224.0.0.5', '224.0.0.6']);
    expect(sim.device('r2')!.portView(GI0)!.l3.groups4).toEqual(['224.0.0.5', '224.0.0.6']);
    // step 3: 2-Way at U + 1 s (the hello replies), no election yet
    const r1nbr = fsmOf(evs, 'r1', 'ospf-nbr', `${GI0} 2.2.2.2`);
    expect(r1nbr.find((f) => f.to === '2way')!.t).toBeLessThan(U + SEC + MS_NS);
    // step 4: the elections
    const r1if = fsmOf(evs, 'r1', 'ospf-if');
    expect(r1if.map((f) => `${f.from}>${f.to}:${f.cause}`)).toEqual(['down>waiting:InterfaceUp', 'waiting>drother:WaitTimer', 'drother>backup:NeighborChange']);
    expect(r1if[1]!.t).toBe(U + 40 * SEC);
    expect(r1if[2]!.t - r1if[1]!.t).toBeLessThan(MS_NS);
    expect(fsmOf(evs, 'r2', 'ospf-if').map((f) => `${f.from}>${f.to}`)).toEqual(['down>waiting', 'waiting>dr']);
    expect(fsmOf(evs, 'r2', 'ospf-if')[1]!.t).toBe(U + 40 * SEC);
    const elections = debugLines(evs, 'r1', 'ip ospf adj').filter((l) => l.message.includes('election'));
    expect(elections.map((l) => l.message)).toEqual([
      'GigabitEthernet0/0 election: DR 2.2.2.2 (10.0.123.2), BDR 2.2.2.2 (10.0.123.2)',
      'GigabitEthernet0/0 election: DR 2.2.2.2 (10.0.123.2), BDR 1.1.1.1 (10.0.123.1)',
    ]);
    // the run ends with the second election line: no later adj line of R1 in that instant
    const lastAdj = debugLines(evs, 'r1', 'ip ospf adj').filter((l) => l.t <= r1if[2]!.t);
    expect(lastAdj.at(-1)!.message).toBe(elections[1]!.message);
    // exactly one hello from each router after each change of its (DR, BDR) pair
    const afterElection = (d: string) => hellosOf(evs, d).filter((h) => h.t >= U + 40 * SEC && h.t < U + 41 * SEC).map((h) => h.summary.slice(h.summary.indexOf(', DR ') + 2));
    expect(afterElection('r2')).toEqual(['DR 10.0.123.2, BDR 10.0.123.1']);
    expect(afterElection('r1')).toEqual(['DR 10.0.123.2, BDR 10.0.123.2', 'DR 10.0.123.2, BDR 10.0.123.1']);
    // step 5: ExStart at U + 40 s with unicast DBDs, Full a few ms later
    expect(ospfCreated(evs, 'r1').find((p) => p.kind === 'dbd')).toMatchObject({ t: U + 40 * SEC, dst: '10.0.123.2' });
    const full = r1nbr.find((f) => f.to === 'full')!;
    expect(full.t - (U + 40 * SEC)).toBeLessThan(10 * MS_NS);
    // step 6: transit links, the network-LSA from the DR only, the first SPF with the LAN at U + 45 s + ε
    const db = lsdbRows(sim, 'r1');
    expect(db.filter((r) => r.type === 2).map((r) => [r.lsid, r.advRouter, r.attached])).toEqual([['10.0.123.2', '2.2.2.2', ['2.2.2.2', '1.1.1.1']]]);
    expect(db.find((r) => r.key === '0.0.0.0|1|1.1.1.1|1.1.1.1')!.links).toEqual([{ kind: 'transit', id: '10.0.123.2', data: '10.0.123.1', metric: 1 }]);
    const spf = debugLines(evs, 'r1', 'ip ospf spf').filter((l) => l.message.startsWith('SPF run') && l.t > U + 40 * SEC);
    expect(spf[0]!.t - (U + 45 * SEC)).toBeGreaterThanOrEqual(0);
    expect(spf[0]!.t - (U + 45 * SEC)).toBeLessThan(10 * MS_NS);
    expect(ospfView(sim, 'r1').trees[0]!.tree.vertices.map((v) => v.key)).toEqual(['R:1.1.1.1', 'N:10.0.123.2', 'R:2.2.2.2']);
    // rows
    expect(ifRow(sim, 'r1', GI0)).toMatchObject({ state: 'backup', dr: '2.2.2.2', drAddress: '10.0.123.2', bdr: '1.1.1.1', bdrAddress: '10.0.123.1', neighbors: 1, adjacent: 1 });
    expect(nbrRows(sim, 'r1')).toMatchObject([{ routerId: '2.2.2.2', state: 'full', role: 'dr', dr: '10.0.123.2', bdr: '10.0.123.1' }]);
    expect(ifRow(sim, 'r1', GI0)!.waitUntil).toBeUndefined();
  });

  it('§3.1 step 7: a late higher router id stays DROther (BackupSeen from the BDR\'s reply) and is Full with the DR and the BDR', () => {
    const sim = lan();
    adminPort(sim, 'r1', GI0, true);
    adminPort(sim, 'r2', GI0, true);
    sim.runFor(65 * SEC);
    const c = cursor(sim);
    adminPort(sim, 'r3', GI0, true);
    sim.runToIdle();
    const evs = eventsSince(sim, c);
    const U3 = portUpAt(evs, 'r3', GI0)!;
    // R1 and R2 answer with their hello replies 1 s after R3's hello made it Init at them
    for (const d of ['r1', 'r2']) {
      const init = fsmOf(evs, d, 'ospf-nbr', `${GI0} 3.3.3.3`).find((f) => f.to === 'init')!;
      expect(hellosOf(evs, d).filter((h) => h.t < U3 + 2 * SEC).map((h) => h.t)).toEqual([init.t + SEC]);
    }
    // R3 elects at once on the BackupSeen (no 40 s wait) and stays DROther
    const r3if = fsmOf(evs, 'r3', 'ospf-if');
    expect(r3if.map((f) => `${f.from}>${f.to}:${f.cause}`)).toEqual(['down>waiting:InterfaceUp', 'waiting>drother:BackupSeen']);
    expect(r3if[1]!.t - U3).toBeLessThan(SEC + 10 * MS_NS);
    expect(ifRow(sim, 'r3', GI0)).toMatchObject({ state: 'drother', dr: '2.2.2.2', bdr: '1.1.1.1', adjacent: 2 });
    expect(ifRow(sim, 'r3', GI0)!.waitUntil).toBeUndefined();
    // R3 goes to ExStart with the DR and the BDR (unicast DBDs) and is Full with both a few ms after the replies. Its
    // first DBD needs an ARP round trip, so R3's DR-change hello (multicast) usually makes it 2-Way at R1 and R2 first;
    // the DBD-in-Init path is pinned on a point-to-point link below.
    const r3dbds = ospfCreated(evs, 'r3').filter((p) => p.kind === 'dbd');
    expect(r3dbds.filter((p) => p.summary.endsWith('flags I M MS')).map((p) => p.dst).sort()).toEqual(['10.0.123.1', '10.0.123.2']);
    for (const d of ['r1', 'r2']) {
      const nbr = fsmOf(evs, d, 'ospf-nbr', `${GI0} 3.3.3.3`);
      expect(nbr.map((f) => `${f.from}>${f.to}:${f.cause}`)).toEqual([
        'down>init:HelloReceived',
        'init>2way:2-WayReceived',
        '2way>exstart:AdjOK?',
        'exstart>exchange:NegotiationDone',
        'exchange>loading:ExchangeDone',
        'loading>full:LoadingDone',
      ]);
      expect(nbr.at(-1)!.t - U3).toBeLessThan(SEC + 10 * MS_NS);
    }
    // show ip ospf neighbor on R3: 2.2.2.2 FULL/DR, 1.1.1.1 FULL/BDR; on R1: 3.3.3.3 FULL/DROTHER
    expect(nbrRows(sim, 'r3').map((r) => [r.routerId, r.state, r.role])).toEqual(expect.arrayContaining([['2.2.2.2', 'full', 'dr'], ['1.1.1.1', 'full', 'bdr']]));
    expect(nbrRows(sim, 'r1').find((r) => r.routerId === '3.3.3.3')).toMatchObject({ state: 'full', role: 'drother' });
    // the DR adds 3.3.3.3 to its network-LSA
    expect(lsdbRows(sim, 'r3').find((r) => r.type === 2)!.attached).toEqual(['2.2.2.2', '1.1.1.1', '3.3.3.3']);
  });

  it('a priority-0 router is never DR or BDR; two DROthers stay 2-Way with each other', () => {
    const sim = lan([0, 1, 1, 1], 4);
    for (const n of [1, 2, 3, 4]) adminPort(sim, `r${n}`, GI0, true);
    sim.runToIdle();
    expect(ifRow(sim, 'r1', GI0)).toMatchObject({ state: 'drother', priority: 0, dr: '4.4.4.4', bdr: '3.3.3.3' });
    expect(ifRow(sim, 'r2', GI0)).toMatchObject({ state: 'drother', dr: '4.4.4.4', bdr: '3.3.3.3' });
    expect(ifRow(sim, 'r4', GI0)!.state).toBe('dr');
    expect(ifRow(sim, 'r3', GI0)!.state).toBe('backup');
    expect(nbrRows(sim, 'r1').map((r) => [r.routerId, r.state, r.role]).sort()).toEqual([
      ['2.2.2.2', '2way', 'drother'],
      ['3.3.3.3', 'full', 'bdr'],
      ['4.4.4.4', 'full', 'dr'],
    ]);
    expect(nbrRows(sim, 'r4').find((r) => r.routerId === '1.1.1.1')).toMatchObject({ priority: 0, state: 'full', role: 'drother' });
  });

  it('DR failure: dead after 30–40 s, the BDR becomes DR and a DROther BDR; the new DR originates its network-LSA', () => {
    const sim = lan();
    for (const n of [1, 2]) adminPort(sim, `r${n}`, GI0, true);
    sim.runFor(65 * SEC);
    adminPort(sim, 'r3', GI0, true);
    sim.runToIdle();
    sim.runFor(3 * SEC);
    const c = cursor(sim);
    const T = sim.now;
    sim.setPower('r2', false);
    sim.runFor(60 * SEC);
    const evs = eventsSince(sim, c);
    const dead = fsmOf(evs, 'r1', 'ospf-nbr', `${GI0} 2.2.2.2`).find((f) => f.to === 'down')!;
    expect(dead.cause).toBe('InactivityTimer');
    expect(dead.t - T).toBeGreaterThanOrEqual(30 * SEC);
    expect(dead.t - T).toBeLessThanOrEqual(40 * SEC);
    expect(fsmOf(evs, 'r1', 'ospf-if').map((f) => `${f.from}>${f.to}`)).toEqual(['backup>dr']);
    expect(fsmOf(evs, 'r3', 'ospf-if').map((f) => `${f.from}>${f.to}`)).toEqual(['drother>backup']);
    expect(tableEvents(evs, 'r1', 'ospf-neighbors').find((e) => e.kind === 'tableExpire')).toMatchObject({ key: `${GI0}|2.2.2.2`, reason: 'aged' });
    expect(ifRow(sim, 'r1', GI0)).toMatchObject({ state: 'dr', dr: '1.1.1.1', bdr: '3.3.3.3', adjacent: 1 });
    expect(lsdbRows(sim, 'r3').filter((r) => r.type === 2 && r.advRouter === '1.1.1.1').map((r) => [r.lsid, r.attached])).toEqual([['10.0.123.1', ['1.1.1.1', '3.3.3.3']]]);
    // R2's stale LSAs stay until MaxAge, but SPF ignores them (the bidirectional check)
    expect(lsdbRows(sim, 'r3').filter((r) => r.advRouter === '2.2.2.2').map((r) => r.type).sort()).toEqual([1, 2]);
    expect(ospfView(sim, 'r3').trees[0]!.tree.vertices.map((v) => v.key)).toEqual(['R:3.3.3.3', 'N:10.0.123.1', 'R:1.1.1.1']);
  });
});

describe('ospf.adjacency: hello checks, silence and the process', () => {
  it('a hello with another area or hello interval is refused: no neighbour, the rejected reason, an ip ospf hello line', () => {
    const sim = ospfWorld(9);
    addRouter(sim, 'r1', 'R1', [iface(GI0, '10.0.12.1', '255.255.255.0'), ['router ospf 1', ' router-id 1.1.1.1', ' network 10.0.12.0 0.0.0.255 area 0']]);
    addRouter(sim, 'r2', 'R2', [iface(GI0, '10.0.12.2', '255.255.255.0'), ['router ospf 1', ' router-id 2.2.2.2', ' network 10.0.12.0 0.0.0.255 area 1']]);
    sim.addLink({ a: { device: 'r1', port: GI0 }, b: { device: 'r2', port: GI0 } });
    const c = cursor(sim);
    expect(sim.runToIdle().stopped).toBeUndefined();
    const evs = eventsSince(sim, c);
    expect(nbrRows(sim, 'r1')).toEqual([]);
    expect(ifRow(sim, 'r1', GI0)!.rejected).toMatchObject({ from: '10.0.12.2', routerId: '2.2.2.2', reason: "area 0.0.0.1 does not match this interface's area 0.0.0.0" });
    expect(debugLines(evs, 'r1', 'ip ospf hello').some((l) => l.message === "GigabitEthernet0/0: hello from 2.2.2.2 (10.0.12.2) refused: area 0.0.0.1 does not match this interface's area 0.0.0.0")).toBe(true);
    const drop = evs.find((e) => e.kind === 'drop' && e.device === 'r1' && e.pdu.summary.startsWith('OSPF hello'));
    expect(drop).toMatchObject({ reason: 'other', background: true });
    // a hello interval mismatch, typed on R2 later
    setLine(sim, 'r2', [['router', 'ospf', '1']], ['network', '10.0.12.0', '0.0.0.255', 'area', '1'], true);
    setLine(sim, 'r2', [['router', 'ospf', '1']], ['network', '10.0.12.0', '0.0.0.255', 'area', '0']);
    setLine(sim, 'r2', [['interface', GI0]], ['ip', 'ospf', 'hello-interval', '5']);
    sim.runFor(20 * SEC);
    expect(nbrRows(sim, 'r1')).toEqual([]);
    expect(ifRow(sim, 'r1', GI0)!.rejected!.reason).toBe("hello interval 5 s does not match this interface's 10 s");
  });

  it('silent unless configured: routers without `router ospf` send nothing, write no row and arm no ribWatch; a passive interface sends no hello', () => {
    const sim = ospfWorld(4);
    addRouter(sim, 'r1', 'R1', [iface(GI0, '10.0.12.1', '255.255.255.0')]);
    addRouter(sim, 'r2', 'R2', [iface(GI0, '10.0.12.2', '255.255.255.0'), ['router ospf 1', ' router-id 2.2.2.2', ' passive-interface GigabitEthernet0/0', ' network 10.0.12.0 0.0.0.255 area 0']]);
    sim.addLink({ a: { device: 'r1', port: GI0 }, b: { device: 'r2', port: GI0 } });
    const c = cursor(sim);
    sim.runFor(120 * SEC);
    const evs = eventsSince(sim, c);
    expect(sim.device('r1')!.processes.has('ospf')).toBe(true);
    const fromOspf = (d: string) => evs.filter((e) => (e.kind === 'pduCreated' && e.process === 'ospf' && e.device === d) || (e.kind === 'debug' && e.event.process === 'ospf' && e.event.device === d) || ((e.kind === 'tableWrite' || e.kind === 'tableExpire') && e.device === d && e.table.startsWith('ospf')));
    expect(fromOspf('r1')).toEqual([]);
    expect(ospfView(sim, 'r1')).toEqual({ spf: { runs: 0 }, interfaces: [], neighbors: [], trees: [] });
    // R2: configured, its only interface passive: rows, no packet, no group
    expect(ospfCreated(evs, 'r2')).toEqual([]);
    expect(ifRow(sim, 'r2', GI0)).toMatchObject({ passive: true, state: 'dr', neighbors: 0 });
    expect(sim.device('r2')!.portView(GI0)!.l3.groups4).toBeUndefined();
    expect(lsdbRows(sim, 'r2').map((r) => [r.key, r.links])).toEqual([['0.0.0.0|1|2.2.2.2|2.2.2.2', [{ kind: 'stub', id: '10.0.12.0', data: '255.255.255.0', metric: 1 }]]]);
  });

  it('a P3 world without the ospf factory never runs the daemon (staged.world filters the name)', () => {
    // ARCHITECTURE-P3 §9.2 W4 (the catalog flip registered ospf): a world without the factory removes it through the
    // overlay (staged.world's documented way to model a daemon without a factory)
    const sim = createStagedSimulation({ seed: 1, stage: 'P3', factories: { ospf: undefined } });
    expect(sim.catalog.get('router.nf2911')!.processes).not.toContain('ospf');
    const withOspf = createStagedSimulation({ seed: 1, stage: 'P3', factories: { ospf: createOspf } });
    expect(withOspf.catalog.get('router.nf2911')!.processes).toContain('ospf');
    expect(withOspf.catalog.get('router.nf2911')!.tables).toEqual(expect.arrayContaining(['ospf-interfaces', 'ospf-neighbors', 'ospf-lsdb']));
  });

  it('the router id in use stays until `clear ip ospf process`; a new one is shown as configured meanwhile', () => {
    const { sim, up } = p2pPair();
    up();
    sim.runToIdle();
    setLine(sim, 'r1', [['router', 'ospf', '1']], ['router-id', '9.9.9.9']);
    sim.runFor(SEC);
    expect(ifRow(sim, 'r1', GI0)!.routerId).toBe('1.1.1.1');
    expect(ospfView(sim, 'r1').process).toMatchObject({ pid: 1, routerId: '1.1.1.1', configuredRouterId: '9.9.9.9' });
    const dev = sim.device('r1')!;
    dev.applyActions('sim', [{ type: 'request', to: 'ospf', req: { kind: 'ospf.clear' } }], sim.now);
    sim.runToIdle();
    expect(ifRow(sim, 'r1', GI0)!.routerId).toBe('9.9.9.9');
    expect(ospfView(sim, 'r1').process!.configuredRouterId).toBeUndefined();
    expect(nbrRows(sim, 'r2').map((r) => [r.routerId, r.state])).toEqual([['9.9.9.9', 'full']]);
    // the old router-LSA was flushed; R2 routes to 1.1.1.1/32 through the new id
    expect(lsdbRows(sim, 'r2').some((r) => r.advRouter === '1.1.1.1' && r.maxAge !== true)).toBe(false);
    expect(ospfRoutes(sim, 'r2').map((r) => [r.key, r.metric])).toEqual([['1.1.1.1/32', 2]]);
  });
});

describe('ospf.adjacency: the database description rules (pure, RFC 2328 §10.6)', () => {
  const base = { ownRouterId: '1.1.1.1', ddSeq: 100, master: true } as const;
  it('ExStart: I|M|MS empty from a higher id → slave; MS clear with our sequence from a lower id → master; else ignore', () => {
    const IMMS = OSPF_DD_FLAG.I | OSPF_DD_FLAG.M | OSPF_DD_FLAG.MS;
    expect(dbdVerdict({ ...base, state: 'exstart' }, { flags: IMMS, ddSeq: 7, routerId: '2.2.2.2', empty: true })).toBe('slave');
    expect(dbdVerdict({ ...base, state: 'exstart' }, { flags: IMMS, ddSeq: 7, routerId: '0.0.0.9', empty: true })).toBe('ignore');
    expect(dbdVerdict({ ...base, state: 'exstart' }, { flags: 0, ddSeq: 100, routerId: '0.0.0.9', empty: false })).toBe('master');
    expect(dbdVerdict({ ...base, state: 'exstart' }, { flags: 0, ddSeq: 99, routerId: '0.0.0.9', empty: false })).toBe('ignore');
    expect(dbdVerdict({ ...base, state: '2way' }, { flags: IMMS, ddSeq: 7, routerId: '2.2.2.2', empty: true })).toBe('ignore');
  });
  it('Exchange, Loading, Full: duplicates, the expected sequence, and SeqNumberMismatch', () => {
    const last = { flags: 0, ddSeq: 100 };
    expect(dbdVerdict({ ...base, state: 'exchange', lastReceived: last }, { flags: 0, ddSeq: 100, routerId: '0.0.0.9', empty: false })).toBe('duplicate');
    expect(dbdVerdict({ ...base, state: 'exchange' }, { flags: 0, ddSeq: 100, routerId: '0.0.0.9', empty: false })).toBe('accept');
    expect(dbdVerdict({ ...base, state: 'exchange' }, { flags: OSPF_DD_FLAG.MS, ddSeq: 100, routerId: '0.0.0.9', empty: false })).toBe('mismatch');
    expect(dbdVerdict({ ...base, state: 'exchange' }, { flags: OSPF_DD_FLAG.I, ddSeq: 100, routerId: '0.0.0.9', empty: false })).toBe('mismatch');
    expect(dbdVerdict({ ...base, master: false, state: 'exchange' }, { flags: OSPF_DD_FLAG.MS, ddSeq: 101, routerId: '2.2.2.2', empty: false })).toBe('accept');
    expect(dbdVerdict({ ...base, master: false, state: 'exchange' }, { flags: OSPF_DD_FLAG.MS, ddSeq: 102, routerId: '2.2.2.2', empty: false })).toBe('mismatch');
    expect(dbdVerdict({ ...base, state: 'full', lastReceived: last }, { flags: 0, ddSeq: 100, routerId: '0.0.0.9', empty: false })).toBe('duplicate');
    expect(dbdVerdict({ ...base, state: 'loading', lastReceived: last }, { flags: 0, ddSeq: 101, routerId: '0.0.0.9', empty: false })).toBe('mismatch');
  });
  it('the D9 sequence number: (u32(own) ^ u32(nbr) ^ (attempt << 16)) & 0x7fffffff, the same on both ends', () => {
    expect(ospfDdSeqInitial('1.1.1.1', '2.2.2.2', 0)).toBe(0x03030303);
    expect(ospfDdSeqInitial('2.2.2.2', '1.1.1.1', 0)).toBe(0x03030303);
    expect(ospfDdSeqInitial('1.1.1.1', '2.2.2.2', 1)).toBe(0x03020303);
    expect(ospfDdSeqInitial('255.1.1.1', '1.1.1.1', 0)).toBe(0x7e000000);
  });
});
