/**
 * disc.cdp-native-subif — ruling R47 (ARCHITECTURE-P3 §9.2, W5 disc item; §3.6 step 2): a router whose only address is
 * on the native subinterface of the port it announces on advertises that address in CDP, from the frame sent at the
 * port's link-up on (that frame is built before the subinterface comes up with its parent, so before the ruling it
 * carried no address and the address appeared only with the 60 s periodic frame). The native subinterface also wins
 * over another subinterface of the port; an administratively down one is skipped. LLDP shares the management-address
 * rule (protocols/cdp.ts `discoveryManagementAddress`), so it advertises the same address.
 */
import { describe, expect, it } from 'vitest';
import type { DeviceId } from '../src/contracts/ids.js';
import type { PortView } from '../src/contracts/port.js';
import type { Simulation } from '../src/contracts/simulation.js';
import type { CdpNeighbourRow, LldpNeighbourRow } from '../src/contracts/tables.js';
import { MS, SEC } from '../src/contracts/time.js';
import { discoveryManagementAddress } from '../src/protocols/cdp.js';
import { createSimulation } from '../src/sim/simulation.js';

function startup(sections: readonly (readonly string[])[]): string {
  const out: string[] = [];
  for (const s of sections) out.push(...s, '!');
  out.push('end', '');
  return out.join('\n');
}

/** R1 Gi0/0 (no address of its own; `subifs` under it) ↔ SW1 Gi0/1 (a trunk), in a P3 world (CDP on by default). */
function world(subifs: readonly (readonly string[])[], extra: { lldp?: boolean } = {}): Simulation {
  const sim = createSimulation({ seed: 4_728, profile: 'P3' });
  const lldp = extra.lldp === true ? [['lldp run']] : [];
  sim.addDevice({
    id: 'r1',
    type: 'router.nf2911',
    name: 'R1',
    startupConfig: startup([['hostname R1'], ...lldp, ['interface GigabitEthernet0/0', ' no shutdown'], ...subifs]),
  });
  sim.addDevice({ id: 'sw1', type: 'switch.nfc2960', name: 'SW1', startupConfig: startup([['hostname SW1'], ...lldp, ['interface GigabitEthernet0/1', ' switchport mode trunk']]) });
  sim.addLink({ a: { device: 'r1', port: 'GigabitEthernet0/0' }, b: { device: 'sw1', port: 'GigabitEthernet0/1' } });
  return sim;
}

const NATIVE = ['interface GigabitEthernet0/0.1', ' encapsulation dot1Q 1 native', ' ip address 10.0.12.1 255.255.255.0'];
const TAGGED = ['interface GigabitEthernet0/0.10', ' encapsulation dot1Q 10', ' ip address 10.0.10.1 255.255.255.0'];

const cdpRow = (sim: Simulation, dev: DeviceId, neighbour: string): CdpNeighbourRow | undefined =>
  sim.device(dev)!.tables.get<CdpNeighbourRow>('cdp-neighbours')?.rows().find((r) => r.deviceId === neighbour);
const lldpRow = (sim: Simulation, dev: DeviceId, neighbour: string): LldpNeighbourRow | undefined =>
  sim.device(dev)!.tables.get<LldpNeighbourRow>('lldp-neighbours')?.rows().find((r) => r.systemName === neighbour);

describe('ruling R47: a native subinterface address in CDP', () => {
  it('the frame at link-up already carries the address of the only addressed interface, the native subinterface', () => {
    const sim = world([NATIVE]);
    // R1 boots at 45 s; its link-up frame reaches SW1 within the first millisecond or two
    sim.runUntil(45 * SEC + 100 * MS);
    const row = cdpRow(sim, 'sw1', 'R1');
    expect(row).toBeDefined();
    expect(row!.updatedAt).toBeLessThan(45 * SEC + 100 * MS);
    expect(row!.addresses).toBe('10.0.12.1');
    // and every later frame keeps it
    sim.runFor(70 * SEC);
    expect(cdpRow(sim, 'sw1', 'R1')!.addresses).toBe('10.0.12.1');
  });

  it('the native subinterface wins over another subinterface of the port, whatever their order', () => {
    const sim = world([TAGGED, NATIVE]);
    sim.runUntil(45 * SEC + 100 * MS);
    expect(cdpRow(sim, 'sw1', 'R1')!.addresses).toBe('10.0.12.1');
    sim.runFor(70 * SEC);
    expect(cdpRow(sim, 'sw1', 'R1')!.addresses).toBe('10.0.12.1');
  });

  it('LLDP advertises the same management address', () => {
    const sim = world([NATIVE], { lldp: true });
    sim.runUntil(45 * SEC + 100 * MS);
    expect(lldpRow(sim, 'sw1', 'R1')?.mgmtAddress).toBe('10.0.12.1');
  });

  it('the rule itself: own address first, then an enabled native subinterface of the port, then the first up virtual port', () => {
    const view = (id: string, extra: Partial<Record<string, unknown>>): PortView =>
      ({ id, spec: { id, kind: 'virtual' }, role: 'subif', operUp: false, adminUp: true, l3: {}, ...extra }) as unknown as PortView;
    const parent = view('GigabitEthernet0/0', { spec: { id: 'GigabitEthernet0/0', kind: 'ethernet' }, role: 'routed', operUp: true });
    const native = view('GigabitEthernet0/0.1', { spec: { id: 'GigabitEthernet0/0.1', kind: 'virtual', parent: 'GigabitEthernet0/0' }, dot1q: { vid: 1, native: true }, l3: { ipv4: { address: '10.0.12.1', prefixLen: 24 } } });
    const tagged = view('GigabitEthernet0/0.10', { spec: { id: 'GigabitEthernet0/0.10', kind: 'virtual', parent: 'GigabitEthernet0/0' }, dot1q: { vid: 10, native: false }, operUp: true, l3: { ipv4: { address: '10.0.10.1', prefixLen: 24 } } });
    const model = { capabilities: ['routing'] } as never;
    const ctx = (ports: readonly PortView[]) => ({ model, ports: new Map(ports.map((p) => [p.id, p])) });
    expect(discoveryManagementAddress(ctx([parent, tagged, native]), 'GigabitEthernet0/0')).toBe('10.0.12.1');
    // an administratively down native subinterface is skipped: the first up virtual port answers, as before the ruling
    const shut = { ...native, adminUp: false } as PortView;
    expect(discoveryManagementAddress(ctx([parent, tagged, shut]), 'GigabitEthernet0/0')).toBe('10.0.10.1');
    // the native subinterface of ANOTHER port is not this port's
    expect(discoveryManagementAddress(ctx([parent, native]), 'GigabitEthernet0/1')).toBeUndefined();
    // the port's own address always comes first
    const addressed = { ...parent, l3: { ipv4: { address: '10.0.0.1', prefixLen: 24 } } } as PortView;
    expect(discoveryManagementAddress(ctx([addressed, native]), 'GigabitEthernet0/0')).toBe('10.0.0.1');
  });
});
