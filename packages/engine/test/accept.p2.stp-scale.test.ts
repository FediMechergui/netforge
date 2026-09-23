/**
 * P2 acceptance — spanning tree at scale (ARCHITECTURE-P2 §3.6, §4.2, §4.5, §10.1 row `accept.p2.stp-scale`), on a
 * real P2-profile world of `test/p2.world.ts`.
 *
 * Eight NF-C2960 in a ring (Gi0/2 → the next switch's Gi0/1) with two cross links (SW1–SW5 and SW3–SW7 on Fa0/24),
 * 20 VLANs (10–29), every inter-switch link a static trunk, ten access ports (Fa0/1–10) per switch up with a PC
 * behind each, spread over the 20 VLANs. After convergence, `runFor(60 s)` dispatches fewer than 100 000 events, no
 * drop has detail `action-budget`, and the `stp-bridge` row of every VLAN names the same root on all eight switches.
 */
import { describe, expect, it } from 'vitest';
import type { PortId } from '../src/contracts/ids.js';
import type { Simulation } from '../src/contracts/simulation.js';
import { stpKey, vlanKey, type StpBridgeRow, type StpPortRow } from '../src/contracts/tables.js';
import { SEC } from '../src/contracts/time.js';
import type { TraceEvent } from '../src/contracts/trace.js';
import { configText, section } from '../src/sim/scenarios/kit.js';
import { pcConfig } from '../src/sim/scenarios/templates.js';
import { createP2Simulation } from './p2.world.js';
import { ofKind } from './sim.harness.js';

const SWITCH = 'switch.nfc2960';
const PC = 'pc.nfpc';
const GI1: PortId = 'GigabitEthernet0/1';
const GI2: PortId = 'GigabitEthernet0/2';
const FA24: PortId = 'FastEthernet0/24';
const SWITCHES = 8;
const ACCESS_PORTS = 10;
/** The 20 VLANs of the world. */
const VLANS: readonly number[] = Array.from({ length: 20 }, (_, i) => 10 + i);
/** Every VLAN instance a trunk carries here: VLAN 1 (native) and the 20 configured ones. */
const INSTANCES: readonly number[] = [1, ...VLANS];
const CROSS: readonly [string, string][] = [['sw1', 'sw5'], ['sw3', 'sw7']];
/** Switches boot at 30 s, ports forward at 60 s, the boot TC windows end by 95 s. */
const CONVERGED = 130 * SEC;

const swId = (i: number): string => `sw${i}`;
const accessVlan = (s: number, k: number): number => VLANS[(s + k) % VLANS.length]!;

function scaleWorld(): { sim: Simulation; events: TraceEvent[] } {
  const sim = createP2Simulation({ seed: 7, profile: 'P2' });
  const events: TraceEvent[] = [];
  sim.onTrace((ev) => events.push(ev));
  for (let s = 1; s <= SWITCHES; s++) {
    const sections: string[][] = [[`hostname SW${s}`], ...VLANS.map((v) => [`vlan ${v}`])];
    for (const trunk of [GI1, GI2, FA24]) sections.push(section(`interface ${trunk}`, ['switchport mode trunk']));
    for (let k = 1; k <= ACCESS_PORTS; k++) sections.push(section(`interface FastEthernet0/${k}`, ['switchport mode access', `switchport access vlan ${accessVlan(s, k)}`]));
    sim.addDevice({ id: swId(s), type: SWITCH, name: `SW${s}`, startupConfig: configText(sections) });
    for (let k = 1; k <= ACCESS_PORTS; k++) {
      const id = `pc${s}_${k}`;
      sim.addDevice({ id, type: PC, name: id.toUpperCase(), startupConfig: pcConfig(id.toUpperCase(), `10.${s}.${k}.1`, '255.255.255.0') });
      sim.addLink({ id: `l_${id}`, a: { device: id, port: 'GigabitEthernet0' }, b: { device: swId(s), port: `FastEthernet0/${k}` } });
    }
  }
  for (let s = 1; s <= SWITCHES; s++) {
    const next = s === SWITCHES ? 1 : s + 1;
    sim.addLink({ id: `ring_${s}`, a: { device: swId(s), port: GI2 }, b: { device: swId(next), port: GI1 } });
  }
  for (const [a, b] of CROSS) sim.addLink({ id: `cross_${a}_${b}`, a: { device: a, port: FA24 }, b: { device: b, port: FA24 } });
  return { sim, events };
}

const bridgeRow = (sim: Simulation, dev: string, vlan: number): StpBridgeRow | undefined => sim.device(dev)!.tables.get<StpBridgeRow>('stp-bridge')!.get(vlanKey(vlan));
const portRow = (sim: Simulation, dev: string, vlan: number, port: PortId): StpPortRow | undefined => sim.device(dev)!.tables.get<StpPortRow>('stp')!.get(stpKey(vlan, port));

describe('accept P2 stp-scale', () => {
  it('8 switches, 2 cross links, 20 VLANs, 80 host ports: a quiet steady state and one root per VLAN everywhere', () => {
    const { sim, events } = scaleWorld();
    sim.runUntil(CONVERGED);
    // every inter-switch link is up and trunking (an stp row for a non-native VLAN exists only on a trunk)
    for (let s = 1; s <= SWITCHES; s++) {
      expect(sim.link(`ring_${s}`)!.up, `ring_${s}`).toBe(true);
      for (const port of [GI1, GI2]) expect(portRow(sim, swId(s), 10, port), `${swId(s)} ${port}`).toBeDefined();
      for (let k = 1; k <= ACCESS_PORTS; k++) {
        expect(sim.link(`l_pc${s}_${k}`)!.up, `l_pc${s}_${k}`).toBe(true);
        expect(portRow(sim, swId(s), accessVlan(s, k), `FastEthernet0/${k}`), `${swId(s)} Fa0/${k}`).toMatchObject({ state: 'forwarding' });
      }
    }
    for (const [a, b] of CROSS) {
      expect(sim.link(`cross_${a}_${b}`)!.up).toBe(true);
      expect(portRow(sim, a, 10, FA24)).toBeDefined();
      expect(portRow(sim, b, 10, FA24)).toBeDefined();
    }
    // the steady state: fewer than 100 000 events in 60 s, no daemon ran out of its action budget
    const window = sim.runFor(60 * SEC);
    expect(window.stopped).toBeUndefined();
    expect(window.events).toBeLessThan(100_000);
    expect(window.events).toBeGreaterThan(0);
    expect(ofKind(events, 'drop').filter((e) => e.detail === 'action-budget')).toEqual([]);
    // one root per VLAN, agreed by all eight switches
    for (const vlan of INSTANCES) {
      const rows = Array.from({ length: SWITCHES }, (_, i) => bridgeRow(sim, swId(i + 1), vlan));
      for (const [i, r] of rows.entries()) expect(r, `${swId(i + 1)} VLAN ${vlan}`).toBeDefined();
      const roots = new Set(rows.map((r) => r!.rootId));
      expect(roots.size, `VLAN ${vlan} roots: ${[...roots].join(', ')}`).toBe(1);
      const claimants = rows.filter((r) => r!.isRoot);
      expect(claimants, `VLAN ${vlan}`).toHaveLength(1);
      expect(claimants[0]!.bridgeId).toBe([...roots][0]);
      for (const r of rows) expect(r!.mode).toBe('pvst');
    }
    // the rows are complete: 21 instances on every switch, every non-root switch has a root port
    for (let s = 1; s <= SWITCHES; s++) {
      expect(sim.device(swId(s))!.tables.get<StpBridgeRow>('stp-bridge')!.size, swId(s)).toBe(INSTANCES.length);
      for (const vlan of INSTANCES) {
        const r = bridgeRow(sim, swId(s), vlan)!;
        if (!r.isRoot) expect(r.rootPort, `${swId(s)} VLAN ${vlan}`).toBeDefined();
      }
    }
    // no port is left in a transient state
    for (let s = 1; s <= SWITCHES; s++) {
      for (const r of sim.device(swId(s))!.tables.get<StpPortRow>('stp')!.rows()) {
        expect(['forwarding', 'blocking'], `${swId(s)} VLAN ${r.vlan} ${r.port}`).toContain(r.state);
        expect(r.nextTransitionAt, `${swId(s)} VLAN ${r.vlan} ${r.port}`).toBeUndefined();
      }
    }
  });
});
