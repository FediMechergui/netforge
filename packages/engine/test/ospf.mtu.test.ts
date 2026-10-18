/**
 * ospf.mtu — the DBD MTU check (ARCHITECTURE-P3C §3.2 step 4, §4.3, §4.4; RFC 2328 §10.6–10.8; §7 W2a ospf [C7]):
 * `ip mtu` and `ip ospf mtu-ignore` read by protocols/ospf/config.ts; the DBD announcing the interface's IP MTU (`ip
 * mtu`, else the port MTU); a DBD whose MTU exceeds the receiving interface's IP MTU refused with the `ip ospf adj`
 * line; the outcome by router-id order (the lower-MTU side with the higher id: ExStart there, Exchange on the other;
 * the higher-MTU side with the higher id: ExStart on both); `mtu-ignore` giving Full; a jumbo data-centre port against
 * a 1500-byte router sticking the same way (the listed P3 change); a GRE tunnel announcing its port MTU whatever its
 * `ip mtu`; `runToIdle` returning in a stuck world.
 */
import { describe, expect, it } from 'vitest';
import type { Simulation } from '../src/contracts/simulation.js';
import { SEC } from '../src/contracts/time.js';
import type { TraceEvent } from '../src/contracts/trace.js';
import { parseConfigText } from '../src/cli/config-ast.js';
import { readOspfConfig } from '../src/protocols/ospf/config.js';
import { addRouter, cursor, debugLines, eventsSince, fsmOf, GI0, iface, nbrRows, ospfWorld, setLine, startup } from './ospf.harness.js';

const P2P = ['ip ospf network point-to-point'];
const ADJ = 'ip ospf adj';

/** R1 and R2 on a point-to-point GigE link in area 0 with the given router ids and extra interface lines. */
function pair(o: { rid1: string; rid2: string; r1If?: string[]; r2If?: string[] }, seed = 17): { sim: Simulation; dbdMtus: Map<string, number[]> } {
  const sim = ospfWorld(seed);
  const dbdMtus = new Map<string, number[]>([['r1', []], ['r2', []]]);
  sim.onTrace((e) => {
    if (e.kind !== 'pduCreated' || e.process !== 'ospf' || e.pdu.tag !== 'ospf-dbd') return;
    const v = sim.pdu(e.pdu.id);
    if (v !== undefined) dbdMtus.get(e.device)?.push(v.layer('ospf')!.fields.mtu as number);
  });
  const rids = [o.rid1, o.rid2];
  for (const n of [1, 2]) {
    addRouter(sim, `r${n}`, `R${n}`, [
      iface(GI0, `10.0.12.${n}`, '255.255.255.252', [...P2P, ...((n === 1 ? o.r1If : o.r2If) ?? [])]),
      ['router ospf 1', ` router-id ${rids[n - 1]!}`, ' network 10.0.12.0 0.0.0.3 area 0'],
    ]);
  }
  sim.addLink({ a: { device: 'r1', port: GI0 }, b: { device: 'r2', port: GI0 } });
  sim.runFor(90 * SEC);
  return { sim, dbdMtus };
}

const stateOf = (sim: Simulation, device: string): string | undefined => nbrRows(sim, device)[0]?.state;
const refusedLine = (rid: string, addr: string, theirs: number, own: number): string =>
  `${GI0}: database description from ${rid} (${addr}) refused: its database description MTU ${theirs} is larger than this interface's IP MTU ${own}`;
const reached = (evs: readonly TraceEvent[], device: string, to: string): boolean => fsmOf(evs, device, 'ospf-nbr').some((f) => f.to === to);

describe('[C7] the configuration lines', () => {
  it('reads `ip mtu` and `ip ospf mtu-ignore` (stored through the config rules)', () => {
    const text = startup([['interface GigabitEthernet0/0', ' ip mtu 1400', ' ip ospf mtu-ignore'], ['interface GigabitEthernet0/1', ' ip mtu 40'], ['router ospf 1']]);
    const cfg = readOspfConfig(parseConfigText(text));
    expect(cfg.interfaces.get(GI0)).toEqual({ port: GI0, ipMtu: 1400, mtuIgnore: true });
    // out of range: not read
    expect(cfg.interfaces.get('GigabitEthernet0/1')).toBeUndefined();
  });
});

describe('[C7] the DBD MTU check (RFC 2328 §10.6)', () => {
  it('equal MTUs: Full; every DBD announces the port MTU (P3a behaviour)', () => {
    const { sim, dbdMtus } = pair({ rid1: '1.1.1.1', rid2: '2.2.2.2' });
    expect(stateOf(sim, 'r1')).toBe('full');
    expect(stateOf(sim, 'r2')).toBe('full');
    expect(new Set([...dbdMtus.get('r1')!, ...dbdMtus.get('r2')!])).toEqual(new Set([1500]));
  });

  it('the lower-MTU side has the higher router id: ExStart on it, Exchange on the other', () => {
    // R2 (1400) is L with the higher id 2.2.2.2, so L is master: H accepts L's initial DBD and becomes slave
    const { sim, dbdMtus } = pair({ rid1: '1.1.1.1', rid2: '2.2.2.2', r2If: ['ip mtu 1400'] });
    const evs = eventsSince(sim, 0);
    expect(dbdMtus.get('r2')!.length).toBeGreaterThan(0);
    expect(new Set(dbdMtus.get('r2'))).toEqual(new Set([1400]));
    expect(new Set(dbdMtus.get('r1'))).toEqual(new Set([1500]));
    expect(stateOf(sim, 'r2')).toBe('exstart');
    expect(stateOf(sim, 'r1')).toBe('exchange');
    expect(reached(evs, 'r2', 'exchange')).toBe(false);
    expect(debugLines(evs, 'r2', ADJ).map((l) => l.message)).toContain(refusedLine('1.1.1.1', '10.0.12.1', 1500, 1400));
    expect(debugLines(evs, 'r1', ADJ).some((l) => l.message.includes('refused'))).toBe(false);
    const drop = evs.find((e) => e.kind === 'drop' && e.device === 'r2' && e.pdu.summary.startsWith('OSPF database description'));
    expect(drop).toMatchObject({ reason: 'other', detail: 'OSPF database description refused: its database description MTU 1500 is larger than this interface\'s IP MTU 1400' });
    // it never holds runToIdle (P3a rule 19), and the outcome stands
    sim.runToIdle();
    expect(stateOf(sim, 'r2')).toBe('exstart');
  });

  it('the higher-MTU side has the higher router id: both stay in ExStart', () => {
    // R1 (1400) is L with the lower id 1.1.1.1: H is master and never hears a slave's answer
    const { sim } = pair({ rid1: '1.1.1.1', rid2: '2.2.2.2', r1If: ['ip mtu 1400'] });
    const evs = eventsSince(sim, 0);
    expect(stateOf(sim, 'r1')).toBe('exstart');
    expect(stateOf(sim, 'r2')).toBe('exstart');
    expect(reached(evs, 'r1', 'exchange')).toBe(false);
    expect(reached(evs, 'r2', 'exchange')).toBe(false);
    expect(debugLines(evs, 'r1', ADJ).map((l) => l.message)).toContain(refusedLine('2.2.2.2', '10.0.12.2', 1500, 1400));
    sim.runToIdle();
    expect(stateOf(sim, 'r1')).toBe('exstart');
    expect(stateOf(sim, 'r2')).toBe('exstart');
  });

  it('`ip ospf mtu-ignore` on the lower side gives Full; removing `ip mtu` later is read at once', () => {
    const { sim } = pair({ rid1: '1.1.1.1', rid2: '2.2.2.2', r1If: ['ip mtu 1400', 'ip ospf mtu-ignore'] });
    expect(stateOf(sim, 'r1')).toBe('full');
    expect(stateOf(sim, 'r2')).toBe('full');
    // a stuck pair recovers once the MTUs agree
    const stuck = pair({ rid1: '1.1.1.1', rid2: '2.2.2.2', r1If: ['ip mtu 1400'] });
    expect(stateOf(stuck.sim, 'r1')).toBe('exstart');
    setLine(stuck.sim, 'r1', [['interface', GI0]], ['ip', 'mtu', '1400'], true);
    stuck.sim.runFor(120 * SEC);
    expect(stateOf(stuck.sim, 'r1')).toBe('full');
    expect(stateOf(stuck.sim, 'r2')).toBe('full');
  });

  it('a GRE tunnel announces its port MTU whatever its `ip mtu` (a listed fidelity gap)', () => {
    const sim = ospfWorld(19);
    const mtus: number[] = [];
    sim.onTrace((e) => {
      if (e.kind !== 'pduCreated' || e.process !== 'ospf' || e.pdu.tag !== 'ospf-dbd' || e.device !== 'r1') return;
      const v = sim.pdu(e.pdu.id);
      if (v !== undefined) mtus.push(v.layer('ospf')!.fields.mtu as number);
    });
    for (const n of [1, 2]) {
      const peer = 3 - n;
      addRouter(sim, `r${n}`, `R${n}`, [
        iface(GI0, `10.0.12.${n}`, '255.255.255.252'),
        [`interface Tunnel0`, ` ip address 172.16.0.${n} 255.255.255.252`, ...(n === 1 ? [' ip mtu 1400'] : []), ` tunnel source ${GI0}`, ` tunnel destination 10.0.12.${peer}`],
        ['router ospf 1', ` router-id ${n}.${n}.${n}.${n}`, ' network 172.16.0.0 0.0.0.3 area 0'],
      ]);
    }
    sim.addLink({ a: { device: 'r1', port: GI0 }, b: { device: 'r2', port: GI0 } });
    sim.runFor(120 * SEC);
    expect(nbrRows(sim, 'r1').map((r) => [r.port, r.state])).toEqual([['Tunnel0', 'full']]);
    expect(mtus.length).toBeGreaterThan(0);
    expect(new Set(mtus)).toEqual(new Set([1500]));
  });

  it('a 9216-byte jumbo data-centre port against a 1500-byte router sticks in ExStart (the listed P3 change)', () => {
    const sim = ospfWorld(23);
    sim.addDevice({
      id: 'leaf',
      type: 'dcswitch.nfn9k-48',
      name: 'LEAF1',
      startupConfig: startup([
        ['hostname LEAF1'],
        ['ip routing'],
        ['interface Ethernet1/1', ' no switchport', ' ip address 10.0.12.2 255.255.255.252', ' ip ospf network point-to-point', ' no shutdown'],
        ['router ospf 1', ' router-id 9.9.9.9', ' network 10.0.12.0 0.0.0.3 area 0'],
      ]),
    });
    addRouter(sim, 'r1', 'R1', [iface(GI0, '10.0.12.1', '255.255.255.252', P2P), ['router ospf 1', ' router-id 1.1.1.1', ' network 10.0.12.0 0.0.0.3 area 0']]);
    sim.addLink({ a: { device: 'r1', port: GI0 }, b: { device: 'leaf', port: 'Ethernet1/1' } });
    const c = cursor(sim);
    sim.runFor(120 * SEC);
    const evs = eventsSince(sim, c);
    // the jumbo side (higher id 9.9.9.9) is master; the router (lower MTU) refuses its DBDs and never answers as slave
    expect(stateOf(sim, 'r1')).toBe('exstart');
    expect(stateOf(sim, 'leaf')).toBe('exstart');
    expect(debugLines(evs, 'r1', ADJ).map((l) => l.message)).toContain(refusedLine('9.9.9.9', '10.0.12.2', 9216, 1500));
  });
});
