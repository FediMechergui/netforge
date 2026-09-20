/**
 * P0.5 acceptance — stable MACs (ARCHITECTURE-P1 §10.1 `accept.p05.mac-stability`; D8, §3.3 step 4, contracts/addr.ts).
 *
 * Worlds built in different orders and with different seeds give identical MACs per device id, matching the D8
 * vectors (`portMac(deviceMacBase(id), ordinal)`, virtual ports on ordinal 0, BSSIDs from the radio MAC). A forced MAC
 * base collision persists `hardware.macSalt: 1` and reloads identically.
 */
import { describe, expect, it } from 'vitest';
import { bssidFor, deviceMacBase, portMac } from '../src/contracts/addr.js';
import type { ModuleInstall } from '../src/contracts/catalog.js';
import type { Simulation } from '../src/contracts/simulation.js';
import { SEC } from '../src/contracts/time.js';
import { homeWifi } from '../src/sim/scenarios.js';
import { createSimulation } from '../src/sim/simulation.js';

/** device id → [port id, MAC] in canonical port order. */
function macsOf(sim: Simulation): Record<string, [string, string][]> {
  const out: Record<string, [string, string][]> = {};
  for (const d of sim.devices()) out[d.id] = [...d.ports.values()].map((p) => [p.id, p.mac]);
  return out;
}

/** A mixed world: [id, catalog type, modules]. */
const WORLD: readonly [string, string, ModuleInstall[] | undefined][] = [
  ['pc1', 'pc.nfpc', undefined],
  ['sw1', 'switch.nfc2960', undefined],
  ['r1', 'router.nf1941', [{ slot: '0/1', module: 'mod.ehwic-2t' }]],
  ['mls1', 'mlswitch.nfc3650-24', undefined],
  ['home1', 'wrouter.nfhome', undefined],
  ['laptop1', 'laptop.nflaptop', undefined],
  ['hub1', 'hub.nfhub4', undefined],
  ['tower1', 'cell.nftower', undefined],
];

describe('accept P0.5: stable MACs', () => {
  it('gives identical MACs per device id whatever the seed and the build order, as the D8 vectors say', () => {
    const forward = createSimulation({ seed: 1 });
    for (const [id, type, modules] of WORLD) forward.addDevice({ id, type, modules });
    const backward = createSimulation({ seed: 987_654_321 });
    for (const [id, type, modules] of [...WORLD].reverse()) backward.addDevice({ id, type, modules });
    expect(macsOf(backward)).toEqual(macsOf(forward));

    // the published vectors (contracts/addr.ts)
    expect(deviceMacBase('d_0001')).toBe(0x4e59e8af);
    expect(deviceMacBase('d_0002')).toBe(0xdc527974);
    expect(deviceMacBase('pc1')).toBe(0x56459757);
    expect(deviceMacBase('sw1')).toBe(0xe76329c8);
    expect(deviceMacBase('d_0001', 1)).toBe(0xd21db925);
    expect(portMac(deviceMacBase('d_0001'), 1)).toBe('02:4e:59:e8:af:01');

    for (const dev of forward.devices()) {
      for (const p of dev.ports.values()) expect(p.mac, `${dev.id} ${p.id}`).toBe(portMac(deviceMacBase(dev.id), p.ordinal ?? 0));
    }
    expect(forward.device('pc1')!.port('GigabitEthernet0')!.mac).toBe('02:56:45:97:57:01');
    expect(forward.device('sw1')!.port('FastEthernet0/1')!.mac).toBe('02:e7:63:29:c8:01');
    expect(forward.device('r1')!.port('Serial0/1/0')!.mac).toBe(portMac(deviceMacBase('r1'), 144));
    expect(forward.device('mls1')!.port('Vlan1')).toMatchObject({ ordinal: 0, mac: portMac(deviceMacBase('mls1'), 0) });
    expect(forward.snapshot().devices.find((d) => d.id === 'home1')!.baseMac).toBe(portMac(deviceMacBase('home1'), 0));

    const generated = createSimulation({ seed: 5 });
    expect(generated.addDevice({ type: 'pc.nfpc' })).toBe('d_0001');
    expect(generated.device('d_0001')!.port('GigabitEthernet0')!.mac).toBe('02:4e:59:e8:af:01');
  });

  it('keeps the MACs and the BSSID of a loaded template when the file lists its devices in another order', () => {
    const inOrder = createSimulation({ seed: 1 });
    inOrder.loadTopology(homeWifi());
    const reversed = homeWifi();
    reversed.devices.reverse();
    const outOfOrder = createSimulation({ seed: 424_242 });
    outOfOrder.loadTopology(reversed);
    expect(macsOf(outOfOrder)).toEqual(macsOf(inOrder));

    inOrder.runFor(60 * SEC);
    outOfOrder.runFor(60 * SEC);
    const bssid = bssidFor(portMac(deviceMacBase('home1'), inOrder.device('home1')!.port('Wlan0')!.ordinal!), 0);
    for (const sim of [inOrder, outOfOrder]) {
      expect(sim.snapshot().media!.associations.map((a) => [a.station.device, a.state, a.bssid])).toEqual([['laptop1', 'associated', bssid]]);
    }
  });

  it('persists a forced MAC base collision as hardware.macSalt 1 and reloads identically', () => {
    const sim = createSimulation({ seed: 5 });
    // salt 1 of "lab" hashes "lab#1", which is exactly the salt-0 base of the device id "lab#1"
    sim.addDevice({ id: 'lab', type: 'pc.nfpc', macSalt: 1 });
    sim.addDevice({ id: 'lab#1', type: 'pc.nfpc' });
    sim.addDevice({ id: 'lab2', type: 'switch.nfc2960' });
    expect(deviceMacBase('lab', 1)).toBe(deviceMacBase('lab#1', 0));
    expect(sim.device('lab')!.spec.macSalt).toBe(1);
    expect(sim.device('lab#1')!.spec.macSalt).toBe(1);
    expect(sim.device('lab2')!.spec.macSalt).toBe(0);
    expect(sim.device('lab#1')!.port('GigabitEthernet0')!.mac).toBe(portMac(deviceMacBase('lab#1', 1), 1));
    const physical = sim.devices().flatMap((d) => [...d.ports.values()].filter((p) => p.spec.kind !== 'virtual').map((p) => p.mac));
    expect(new Set(physical).size).toBe(physical.length);

    const exported = sim.exportTopology();
    expect(exported.devices.map((d) => [d.id, d.hardware])).toEqual([
      ['lab', { macSalt: 1 }],
      ['lab#1', { macSalt: 1 }],
      ['lab2', undefined],
    ]);
    expect(Object.keys(exported.devices[2]!)).not.toContain('hardware');

    const reloaded = createSimulation({ seed: 77 });
    reloaded.loadTopology(exported);
    expect(macsOf(reloaded)).toEqual(macsOf(sim));
    // the export carries the simulation's own seed; everything else reproduces exactly
    expect(reloaded.exportTopology()).toEqual({ ...exported, seed: 77 });
  });
});
