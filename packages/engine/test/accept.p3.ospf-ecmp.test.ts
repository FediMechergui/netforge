/**
 * P3 acceptance — equal-cost OSPF paths (ARCHITECTURE-P3 §10.1 `accept.p3.ospf-ecmp`; D8, §3.0 (a) step 5, §4.5,
 * §5.1; ARCHITECTURE-P2 [S6] `ecmpIndex`; §7 W4 qa).
 *
 * A square of GigE point-to-point links: R1 (NF-4451) Gi0/0/0 – R2 – R4 and R1 Gi0/0/1 – R3 – R4, every link cost 1,
 * R4's Loopback0 4.4.4.4/32 in area 0; PCs on SW1 behind R1's Gi0/0/2 (10.1.0.0/24, a passive interface). Pinned:
 *   • R1 holds ONE rib row for 4.4.4.4/32 with 2 paths (via R2 and via R3, canonical port order), `[110/3]`, and
 *     `show ip route` prints the row and its second path;
 *   • flows split by `ecmpIndex`: each PC's echo requests leave R1 by the path `ecmpIndex(src, 4.4.4.4, 2)` picks, with
 *     that path's cause on the TTL decrement, the two PCs chosen so both paths carry a flow, and every echo is answered;
 *   • `maximum-paths 1` (typed) gives one path, the first in port order, and every flow takes it; `maximum-paths 4`
 *     (the default) restores both.
 * Worlds: `staged.world` at stage P3 with the flip's daemons (ospf.accept.harness.ts).
 */
import { describe, expect, it } from 'vitest';
import type { DeviceId, SessionId } from '../src/contracts/ids.js';
import type { Simulation } from '../src/contracts/simulation.js';
import { SEC } from '../src/contracts/time.js';
import type { TraceEvent } from '../src/contracts/trace.js';
import { ecmpIndex } from '../src/protocols/ipv4.js';
import { acceptWorld, configureOk, showLines, traceSince } from './ospf.accept.harness.js';
import { addRouter, cursor, debugLines, GI0, GI1, iface, ribRow, startup, tableEvents } from './ospf.harness.js';

const P2P = ['ip ospf network point-to-point'];
const MASK30 = '255.255.255.252';
const DST = '4.4.4.4';
const R1_TO_R2 = 'GigabitEthernet0/0/0';
const R1_TO_R3 = 'GigabitEthernet0/0/1';
const R1_LAN = 'GigabitEthernet0/0/2';

/** Two PC addresses of 10.1.0.0/24 whose flows to 4.4.4.4 hash to path 0 and to path 1. */
function sources(): readonly [string, string] {
  const cands = Array.from({ length: 40 }, (_, k) => `10.1.0.${10 + k}`);
  const a = cands.find((s) => ecmpIndex(s, DST, 2) === 0)!;
  const b = cands.find((s) => ecmpIndex(s, DST, 2) === 1)!;
  return [a, b];
}

/** The square, converged; PCs `pc0` and `pc1` at the two source addresses. */
function square(seed: number): { sim: Simulation; srcs: readonly [string, string] } {
  const sim = acceptWorld(seed);
  const ospf = (n: number, extra: readonly string[] = []) => ['router ospf 1', ` router-id ${n}.${n}.${n}.${n}`, ...extra, ' network 0.0.0.0 255.255.255.255 area 0'];
  sim.addDevice({
    id: 'r1',
    type: 'router.nf4451',
    name: 'R1',
    startupConfig: startup([['hostname R1'], iface(R1_TO_R2, '10.0.12.1', MASK30, P2P), iface(R1_TO_R3, '10.0.13.1', MASK30, P2P), iface(R1_LAN, '10.1.0.1', '255.255.255.0'), ospf(1, [` passive-interface ${R1_LAN}`])]),
  });
  addRouter(sim, 'r2', 'R2', [iface(GI0, '10.0.12.2', MASK30, P2P), iface(GI1, '10.0.24.1', MASK30, P2P), ospf(2)]);
  addRouter(sim, 'r3', 'R3', [iface(GI0, '10.0.13.2', MASK30, P2P), iface(GI1, '10.0.34.1', MASK30, P2P), ospf(3)]);
  addRouter(sim, 'r4', 'R4', [iface(GI0, '10.0.24.2', MASK30, P2P), iface(GI1, '10.0.34.2', MASK30, P2P), iface('Loopback0', DST, '255.255.255.255'), ospf(4)]);
  sim.addDevice({ id: 'sw1', type: 'switch.nfc2960', name: 'SW1', startupConfig: startup([['hostname SW1'], ...[1, 2, 3].map((k) => [`interface FastEthernet0/${k}`, ' spanning-tree portfast'])]) });
  const srcs = sources();
  srcs.forEach((addr, k) => {
    sim.addDevice({ id: `pc${k}`, type: 'pc.nfpc', name: `PC${k}`, startupConfig: startup([[`hostname PC${k}`], ['interface GigabitEthernet0', ` ip address ${addr} 255.255.255.0`], ['ip default-gateway 10.1.0.1']]) });
    sim.addLink({ a: { device: `pc${k}`, port: 'GigabitEthernet0' }, b: { device: 'sw1', port: `FastEthernet0/${k + 1}` } });
  });
  sim.addLink({ a: { device: 'r1', port: R1_LAN }, b: { device: 'sw1', port: 'FastEthernet0/3' } });
  sim.addLink({ a: { device: 'r1', port: R1_TO_R2 }, b: { device: 'r2', port: GI0 } });
  sim.addLink({ a: { device: 'r1', port: R1_TO_R3 }, b: { device: 'r3', port: GI0 } });
  sim.addLink({ a: { device: 'r2', port: GI1 }, b: { device: 'r4', port: GI0 } });
  sim.addLink({ a: { device: 'r3', port: GI1 }, b: { device: 'r4', port: GI1 } });
  sim.runFor(90 * SEC);
  expect(sim.runToIdle().stopped).toBeUndefined();
  return { sim, srcs };
}

/** `ping 4.4.4.4` from `pc` to idle: the egress port of R1 for each echo request, the TTL causes at R1, the output. */
function pingFrom(sim: Simulation, pc: DeviceId): { egress: string[]; causes: string[]; text: string } {
  const c = cursor(sim);
  const s: SessionId = sim.cli.open(pc, 'console');
  sim.cli.exec(s, `ping ${DST}`);
  expect(sim.runToIdle().stopped).toBeUndefined();
  const evs: TraceEvent[] = traceSince(sim, c);
  const requests = new Set(evs.filter((e) => e.kind === 'pduCreated' && e.device === pc && e.process === 'icmpv4').map((e) => (e as { pdu: { id: number } }).pdu.id));
  expect(requests.size).toBe(5);
  const egress = evs.filter((e) => e.kind === 'frameTx' && e.from.device === 'r1' && requests.has(e.pdu.id)).map((e) => (e as { from: { port: string } }).from.port);
  const causes = evs
    .filter((e) => e.kind === 'mutation' && requests.has(e.pdu) && e.mutation.device === 'r1' && e.mutation.reason === 'TtlDecrement')
    .map((e) => (e as { mutation: { cause?: string } }).mutation.cause ?? '');
  const text = evs.filter((e) => e.kind === 'cliOutput' && e.session === s).map((e) => (e as { text: string }).text).join('');
  return { egress, causes, text };
}

const PATHS = [
  { port: R1_TO_R2, hop: '10.0.12.2' },
  { port: R1_TO_R3, hop: '10.0.13.2' },
] as const;

describe('accept.p3.ospf-ecmp', () => {
  it('one rib row with 2 paths; flows split by ecmpIndex', () => {
    const { sim, srcs } = square(81);
    const row = ribRow(sim, 'r1', '4.4.4.4/32')!;
    expect(row).toMatchObject({ source: 'O', ad: 110, metric: 3, nextHop: '10.0.12.2', iface: R1_TO_R2 });
    expect(row.paths!.map((p) => [p.nextHop, p.iface])).toEqual(PATHS.map((p) => [p.hop, p.port]));
    expect(sim.device('r1')!.tables.rib.rows().filter((r) => r.key === '4.4.4.4/32')).toHaveLength(1);
    const out = showLines(sim, 'r1', 'show ip route');
    const at = out.findIndex((l) => l.includes(' 4.4.4.4/32 '));
    expect(out.slice(at, at + 2)).toEqual([
      'O    4.4.4.4/32  via 10.0.12.2 [110/3] GigabitEthernet0/0/0',
      '                 via 10.0.13.2 [110/3] GigabitEthernet0/0/1',
    ]);
    // each source's flow leaves R1 by the path its hash picks, with that path's cause
    srcs.forEach((src, k) => {
      const idx = ecmpIndex(src, DST, 2);
      expect(idx).toBe(k);
      const { egress, causes, text } = pingFrom(sim, `pc${k}`);
      expect(egress).toEqual(Array(5).fill(PATHS[idx]!.port));
      expect(causes).toEqual(Array(5).fill(`ospf 1: O 4.4.4.4/32 [110/3] via ${PATHS[idx]!.hop}`));
      expect(text).toContain('Sent 5, received 5, lost 0');
    });
  });

  it('`maximum-paths 1` gives one path (the first in port order) and every flow takes it; the default restores both', () => {
    const { sim } = square(82);
    sim.runFor(30 * SEC); // past the SPF hold of the convergence
    const c = cursor(sim);
    const T = sim.now;
    configureOk(sim, 'r1', ['router ospf 1', 'maximum-paths 1']);
    expect(sim.runToIdle().stopped).toBeUndefined();
    // the change moves no LSA; it is applied by the next SPF (5 s after the change, D9), in one rib rewrite
    const evs = traceSince(sim, c);
    expect(debugLines(evs, 'r1', 'ip ospf spf').filter((l) => l.message.startsWith('SPF scheduled')).map((l) => [l.t - T, l.message])).toEqual([
      [0, 'SPF scheduled in 5 s: maximum-paths changed to 1'],
    ]);
    expect(tableEvents(evs, 'r1', 'rib').filter((e) => e.key === '4.4.4.4/32').map((e) => [e.kind, e.t - T])).toEqual([['tableWrite', 5 * SEC]]);
    expect(evs.some((e) => e.kind === 'tableWrite' && e.table === 'ospf-lsdb')).toBe(false);
    const row = ribRow(sim, 'r1', '4.4.4.4/32')!;
    expect(row).toMatchObject({ source: 'O', metric: 3, nextHop: '10.0.12.2', iface: R1_TO_R2 });
    expect(row.paths).toBeUndefined();
    const out = showLines(sim, 'r1', 'show ip route');
    const at = out.findIndex((l) => l.includes(' 4.4.4.4/32 '));
    expect(out[at]).toBe('O    4.4.4.4/32  via 10.0.12.2 [110/3] GigabitEthernet0/0/0');
    expect(out[at + 1]!.trimStart().startsWith('via ')).toBe(false);
    for (const k of [0, 1]) {
      const { egress, text } = pingFrom(sim, `pc${k}`);
      expect(egress).toEqual(Array(5).fill(R1_TO_R2));
      expect(text).toContain('Sent 5, received 5, lost 0');
    }
    // the default (4) again: both paths
    configureOk(sim, 'r1', ['router ospf 1', 'no maximum-paths 1']);
    sim.runFor(30 * SEC);
    expect(sim.runToIdle().stopped).toBeUndefined();
    expect(ribRow(sim, 'r1', '4.4.4.4/32')!.paths!.map((p) => p.iface)).toEqual([R1_TO_R2, R1_TO_R3]);
  });
});
