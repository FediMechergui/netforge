/**
 * P3 acceptance — hello mismatches and a duplicate router id (ARCHITECTURE-P3 §10.1 `accept.p3.ospf-mismatch`; §3.1
 * step 2, D9, §4.2, §5.8; RFC 2328 §10.5; §0 rule 19; §7 W4 qa).
 *
 * R1 and R2 (NF-2911) on one GigE cable (a broadcast network), plugged in after boot, with `debug ip ospf hello` on a
 * console of each. Each mismatch — area, hello interval, dead interval and (broadcast only) the network mask — refuses
 * the hello on both ends: no neighbour row, the interface row's `rejected` with the exact reason, the `ip ospf hello`
 * debug line (in the trace and printed on the console), the hello dropped as `other` (background), and `runToIdle`
 * returns; the mask check does not apply on a point-to-point network. A duplicate router id is logged once, between
 * neighbours (the hello refused) and across a third router (the self-originated LSA war moves to the periodic
 * `self-war:<lsa>`), and `runToIdle` returns.
 * Worlds: `staged.world` at stage P3 with the flip's daemons (ospf.accept.harness.ts).
 */
import { describe, expect, it } from 'vitest';
import type { SessionId } from '../src/contracts/ids.js';
import type { Simulation } from '../src/contracts/simulation.js';
import { SEC } from '../src/contracts/time.js';
import type { TraceEvent } from '../src/contracts/trace.js';
import { acceptWorld, traceSince } from './ospf.accept.harness.js';
import { addRouter, cursor, debugLines, GI0, GI1, iface, ifRow, nbrRows } from './ospf.harness.js';

const MASK24 = '255.255.255.0';

interface Side {
  readonly mask?: string;
  readonly area?: number;
  readonly extra?: readonly string[];
  readonly routerId?: string;
}

/** R1 and R2 on one cable (plugged in after boot), `debug ip ospf hello` on a console of each. */
function pair(seed: number, r1: Side, r2: Side): { sim: Simulation; sessions: Record<string, SessionId>; evs: TraceEvent[]; events: number } {
  const sim = acceptWorld(seed);
  for (const [n, s] of [[1, r1], [2, r2]] as const) {
    addRouter(sim, `r${n}`, `R${n}`, [
      iface(GI0, `10.0.12.${n}`, s.mask ?? MASK24, s.extra ?? []),
      ['router ospf 1', ` router-id ${s.routerId ?? `${n}.${n}.${n}.${n}`}`, ` network 10.0.12.0 0.0.0.255 area ${s.area ?? 0}`],
    ]);
  }
  sim.runFor(90 * SEC);
  const sessions: Record<string, SessionId> = {};
  for (const d of ['r1', 'r2']) {
    const s = sim.cli.open(d, 'console');
    sim.cli.exec(s, 'enable');
    expect(sim.cli.exec(s, 'debug ip ospf hello').output).toBe('Debugging enabled for ip ospf hello.');
    sessions[d] = s;
  }
  const c = cursor(sim);
  sim.addLink({ a: { device: 'r1', port: GI0 }, b: { device: 'r2', port: GI0 } });
  const run = sim.runToIdle();
  expect(run.stopped).toBeUndefined();
  return { sim, sessions, evs: traceSince(sim, c), events: run.events };
}

const consoleText = (evs: readonly TraceEvent[], s: SessionId): string => evs.filter((e) => e.kind === 'cliOutput' && e.session === s).map((e) => (e as { text: string }).text).join('');

describe.each([
  {
    what: 'area',
    r2: { area: 1 },
    r1Reason: "area 0.0.0.1 does not match this interface's area 0.0.0.0",
    r2Reason: "area 0.0.0.0 does not match this interface's area 0.0.0.1",
  },
  {
    what: 'hello interval',
    r2: { extra: ['ip ospf hello-interval 5'] },
    r1Reason: "hello interval 5 s does not match this interface's 10 s",
    r2Reason: "hello interval 10 s does not match this interface's 5 s",
  },
  {
    what: 'dead interval',
    r2: { extra: ['ip ospf dead-interval 30'] },
    r1Reason: "dead interval 30 s does not match this interface's 40 s",
    r2Reason: "dead interval 40 s does not match this interface's 30 s",
  },
  {
    what: 'network mask (broadcast)',
    r2: { mask: '255.255.255.128' },
    r1Reason: "network mask /25 does not match this interface's /24",
    r2Reason: "network mask /24 does not match this interface's /25",
  },
])('accept.p3.ospf-mismatch: $what', ({ r2, r1Reason, r2Reason }) => {
  it('no neighbour row, the rejected reason, the ip ospf hello debug line on both ends; runToIdle returns', () => {
    const { sim, sessions, evs } = pair(51, {}, r2);
    sim.runFor(120 * SEC); // more hellos change nothing
    const all = traceSince(sim, 0);
    for (const [d, peer, peerAddr, reason] of [['r1', '2.2.2.2', '10.0.12.2', r1Reason], ['r2', '1.1.1.1', '10.0.12.1', r2Reason]] as const) {
      expect(nbrRows(sim, d)).toEqual([]);
      expect(all.some((e) => e.kind === 'tableWrite' && e.device === d && e.table === 'ospf-neighbors')).toBe(false);
      const row = ifRow(sim, d, GI0)!;
      expect(row.rejected).toMatchObject({ from: peerAddr, routerId: peer, reason });
      expect(row).toMatchObject({ neighbors: 0, adjacent: 0 });
      const line = `GigabitEthernet0/0: hello from ${peer} (${peerAddr}) refused: ${reason}`;
      expect(debugLines(evs, d, 'ip ospf hello').some((l) => l.message === line)).toBe(true);
      expect(consoleText(evs, sessions[d]!)).toContain(line);
      const drop = evs.find((e) => e.kind === 'drop' && e.device === d && e.pdu.summary.startsWith('OSPF hello'));
      expect(drop).toMatchObject({ reason: 'other', detail: `OSPF hello refused: ${reason}`, background: true });
      // no adjacency machine ever ran
      expect(all.some((e) => e.kind === 'debug' && e.event.device === d && e.event.fsm?.machine === 'ospf-nbr')).toBe(false);
    }
  });
});

describe('accept.p3.ospf-mismatch: the mask check is a broadcast-network check', () => {
  it('the same /24 and /25 on a point-to-point network form an adjacency', () => {
    const p2p = ['ip ospf network point-to-point'];
    const { sim } = pair(52, { extra: p2p }, { mask: '255.255.255.128', extra: p2p });
    expect(nbrRows(sim, 'r1').map((r) => [r.routerId, r.state])).toEqual([['2.2.2.2', 'full']]);
    expect(nbrRows(sim, 'r2').map((r) => [r.routerId, r.state])).toEqual([['1.1.1.1', 'full']]);
    expect(ifRow(sim, 'r1', GI0)!.rejected).toBeUndefined();
  });
});

describe('accept.p3.ospf-mismatch: a duplicate router id', () => {
  const logsOf = (evs: readonly TraceEvent[], d: string) => evs.filter((e) => e.kind === 'log' && e.device === d && e.facility === 'OSPF').map((e) => (e as { message: string }).message);

  it('between neighbours: the hello is refused, the conflict is logged once, runToIdle returns', () => {
    const { sim, evs } = pair(53, { routerId: '1.1.1.1' }, { routerId: '1.1.1.1' });
    sim.runFor(120 * SEC);
    const all = traceSince(sim, 0);
    for (const [d, peerAddr] of [['r1', '10.0.12.2'], ['r2', '10.0.12.1']] as const) {
      expect(nbrRows(sim, d)).toEqual([]);
      expect(ifRow(sim, d, GI0)!.rejected).toMatchObject({ from: peerAddr, routerId: '1.1.1.1', reason: "the neighbour uses this router's own router ID 1.1.1.1" });
      expect(logsOf(all, d)).toEqual([`OSPF process 1: ${peerAddr} on GigabitEthernet0/0 uses this router's own router ID 1.1.1.1; no adjacency forms with it.`]);
      expect(debugLines(evs, d, 'ip ospf hello').some((l) => l.message === `GigabitEthernet0/0: hello from 1.1.1.1 (${peerAddr}) refused: the neighbour uses this router's own router ID 1.1.1.1`)).toBe(true);
    }
  });

  it('across a third router: the LSA war is logged once per router and runToIdle returns; ten more minutes stay bounded', () => {
    const sim = acceptWorld(54);
    const p2p = ['ip ospf network point-to-point'];
    addRouter(sim, 'r1', 'R1', [iface(GI0, '10.0.12.1', '255.255.255.252', p2p), ['router ospf 1', ' router-id 1.1.1.1', ' network 10.0.0.0 0.255.255.255 area 0']]);
    addRouter(sim, 'r2', 'R2', [
      iface(GI0, '10.0.12.2', '255.255.255.252', p2p),
      iface(GI1, '10.0.23.1', '255.255.255.252', p2p),
      ['router ospf 1', ' router-id 2.2.2.2', ' network 10.0.0.0 0.255.255.255 area 0'],
    ]);
    addRouter(sim, 'r3', 'R3', [iface(GI0, '10.0.23.2', '255.255.255.252', p2p), ['router ospf 1', ' router-id 1.1.1.1', ' network 10.0.0.0 0.255.255.255 area 0']]);
    sim.runFor(90 * SEC);
    const c = cursor(sim);
    sim.addLink({ a: { device: 'r1', port: GI0 }, b: { device: 'r2', port: GI0 } });
    sim.addLink({ a: { device: 'r2', port: GI1 }, b: { device: 'r3', port: GI0 } });
    const idle = sim.runToIdle();
    expect(idle.stopped).toBeUndefined();
    expect(idle.events).toBeLessThan(5000);
    const war = 'OSPF process 1: another router also uses router ID 1.1.1.1; its link-state advertisements keep replacing this router\'s own.';
    const evs = traceSince(sim, c);
    const logged = ['r1', 'r3'].flatMap((d) => logsOf(evs, d).map((m) => [d, m]));
    expect(logged.length).toBeGreaterThan(0);
    for (const [, m] of logged) expect(m).toBe(war);
    expect(new Set(logged.map(([d]) => d)).size).toBe(logged.length); // once per router
    // both adjacencies are Full: the conflict is in the database, not in the hellos
    expect(nbrRows(sim, 'r2').map((r) => [r.routerId, r.state]).sort()).toEqual([['1.1.1.1', 'full'], ['1.1.1.1', 'full']]);
    // ten more minutes: the war stays on the periodic timer, a bounded number of events, and each of the two routers
    // has logged the conflict exactly once
    const more = sim.runFor(600 * SEC);
    expect(more.events).toBeLessThan(50_000);
    const all = traceSince(sim, c);
    expect(logsOf(all, 'r1')).toEqual([war]);
    expect(logsOf(all, 'r3')).toEqual([war]);
    expect(logsOf(all, 'r2')).toEqual([]);
    expect(sim.runToIdle().stopped).toBeUndefined();
  });
});
