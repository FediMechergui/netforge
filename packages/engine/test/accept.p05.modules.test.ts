/**
 * P0.5 acceptance — modules (ARCHITECTURE-P1 §10.1 `accept.p05.modules`; D7, D8, §3.3, §3.11).
 *
 * A powered-on `router.nf1941` refuses `mod.ehwic-2t` with the HARDWARE_MESSAGES wording. Powered off, the card adds
 * Serial0/0/0–1 after the fixed ports with ordinals 128/129 and their D8 MACs, emits `topologyChanged module add` and
 * bumps topologyVersion; `mod.nim-2t` does not fit and a second card finds the slot occupied. After power-on the new
 * ports are configurable. Removing a cabled module removes its link first. Modules round-trip through export and load;
 * `modules: []` gives an empty chassis and an absent list gives the model's default modules. A switch module
 * (NF-EHWIC-4ESG) lets the router address its switchports through Vlan1 (§3.10 SVI data path) and route between
 * them and a routed port; without the module `interface Vlan1` is refused.
 */
import { describe, expect, it } from 'vitest';
import { deviceMacBase, portMac } from '../src/contracts/addr.js';
import { HARDWARE_MESSAGES, type ModuleInstall } from '../src/contracts/catalog.js';
import { SEC } from '../src/contracts/time.js';
import { TOPOLOGY_SCHEMA_ID, type Topology } from '../src/contracts/topology.js';
import { VIRTUAL_PORT_MESSAGES } from '../src/device/ports.js';
import { pcConfig } from '../src/sim/scenarios.js';
import { createSimulation } from '../src/sim/simulation.js';
import { console, ofKind, ping } from './sim.harness.js';
import { MASK24, cable, configText, device, topology } from './accept.p05.harness.js';

const R1941 = 'router.nf1941';

/** Substitute the `{key}` fields of a HARDWARE_MESSAGES template. */
function fill(template: string, values: Readonly<Record<string, string>>): string {
  return template.replace(/\{(\w+)\}/g, (whole, key: string) => values[key] ?? whole);
}

describe('accept P0.5: modules', () => {
  it('refuses an insert while powered on, then adds Serial0/0/0–1 after the fixed ports while powered off', () => {
    const sim = createSimulation({ seed: 8 });
    sim.addDevice({ id: 'r1', type: R1941, name: 'R1' });
    sim.runFor(60 * SEC);
    const dev = sim.device('r1')!;
    const fixed = dev.model.ports.map((p) => p.name);
    expect([...dev.ports.keys()]).toEqual(fixed);

    expect(sim.insertModule('r1', '0/0', 'mod.ehwic-2t')).toEqual({ ok: false, code: 'powered-on', error: fill(HARDWARE_MESSAGES['powered-on'], { device: 'R1' }) });
    expect([...dev.ports.keys()]).toEqual(fixed);

    sim.setPower('r1', false);
    const version = sim.snapshot().topologyVersion;
    const cursor = sim.trace(0).next;
    expect(sim.insertModule('r1', '0/0', 'mod.ehwic-2t')).toEqual({ ok: true });
    expect([...dev.ports.keys()]).toEqual([...fixed, 'Serial0/0/0', 'Serial0/0/1']);
    expect(['Serial0/0/0', 'Serial0/0/1'].map((p) => [dev.port(p)!.ordinal, dev.port(p)!.mac])).toEqual([
      [128, portMac(deviceMacBase('r1'), 128)],
      [129, portMac(deviceMacBase('r1'), 129)],
    ]);
    expect(ofKind(sim.trace(cursor).events, 'topologyChanged')).toEqual([{ t: sim.now, kind: 'topologyChanged', what: 'module', id: 'r1/0/0', op: 'add' }]);
    expect(sim.snapshot().topologyVersion).toBe(version + 1);

    expect(sim.insertModule('r1', '0/1', 'mod.nim-2t')).toEqual({
      ok: false,
      code: 'does-not-fit',
      error: fill(HARDWARE_MESSAGES['does-not-fit'], { module: 'NF-NIM-2T', slotType: 'ehwic' }),
    });
    expect(sim.insertModule('r1', '0/0', 'mod.ehwic-2t')).toEqual({
      ok: false,
      code: 'slot-occupied',
      error: fill(HARDWARE_MESSAGES['slot-occupied'], { slot: '0/0', module: 'NF-EHWIC-2T' }),
    });
    expect(sim.snapshot().topologyVersion).toBe(version + 1);

    sim.setPower('r1', true);
    sim.runFor(60 * SEC);
    expect(console(sim, 'r1', ['show inventory']).results[0]!.output).toContain('NF-EHWIC-2T');
    console(sim, 'r1', ['enable', 'configure terminal', 'interface Serial0/0/1', 'ip address 10.0.99.1 255.255.255.252', 'no shutdown', 'end']);
    expect(dev.port('Serial0/0/1')).toMatchObject({ adminUp: true, role: 'wan', encap: 'hdlc', l3: { ipv4: { address: '10.0.99.1', prefixLen: 30 } } });
  });

  it('removes a cabled module only after removing its link', () => {
    const sim = createSimulation({ seed: 8 });
    sim.addDevice({ id: 'r1', type: R1941, name: 'R1', modules: [{ slot: '0/0', module: 'mod.ehwic-2t' }] });
    sim.addDevice({ id: 'r2', type: 'router.nf2911', name: 'R2' });
    const link = sim.addLink({ a: { device: 'r1', port: 'Serial0/0/0' }, b: { device: 'r2', port: 'Serial0/0/0' }, media: 'serial-dce' });
    sim.runFor(60 * SEC);

    expect(sim.removeModule('r1', '0/0')).toMatchObject({ ok: false, code: 'powered-on' });
    expect(sim.link(link)).toBeDefined();

    sim.setPower('r1', false);
    const version = sim.snapshot().topologyVersion;
    const cursor = sim.trace(0).next;
    expect(sim.removeModule('r1', '0/0')).toEqual({ ok: true });
    expect(ofKind(sim.trace(cursor).events, 'topologyChanged').map((e) => [e.what, e.id, e.op])).toEqual([
      ['link', link, 'remove'],
      ['module', 'r1/0/0', 'remove'],
    ]);
    expect(sim.snapshot().topologyVersion).toBe(version + 2);
    expect(sim.link(link)).toBeUndefined();
    expect(sim.device('r1')!.port('Serial0/0/0')).toBeUndefined();
    expect(sim.device('r2')!.port('Serial0/0/0')!.link).toBeUndefined();
    expect(sim.removeModule('r1', '0/0')).toEqual({ ok: false, code: 'slot-empty', error: fill(HARDWARE_MESSAGES['slot-empty'], { slot: '0/0' }) });
  });

  it('round-trips modules; [] is an empty chassis and an absent list applies the default modules', () => {
    const sim = createSimulation({ seed: 8 });
    sim.addDevice({ id: 'r1', type: R1941, name: 'R1', modules: [{ slot: '0/1', module: 'mod.ehwic-4esg' }, { slot: '0/0', module: 'mod.ehwic-2t' }] });
    const exported = sim.exportTopology();
    expect(exported.devices[0]!.modules).toEqual([
      { slot: '0/0', module: 'mod.ehwic-2t' },
      { slot: '0/1', module: 'mod.ehwic-4esg' },
    ]);
    const again = createSimulation({ seed: 99 });
    again.loadTopology(exported);
    const portsOf = (s: typeof sim): [string, string][] => [...s.device('r1')!.ports.values()].map((p) => [p.id, p.mac]);
    expect(portsOf(again)).toEqual(portsOf(sim));
    // the export carries the simulation's own seed; the modules and everything else reproduce exactly
    expect(again.exportTopology()).toEqual({ ...exported, seed: 99 });

    const doc = (modules?: ModuleInstall[]): Topology => ({
      schema: TOPOLOGY_SCHEMA_ID,
      seed: 1,
      devices: [{ id: 'r9', type: R1941, name: 'R9', position: { logical: [0, 0] }, ...(modules === undefined ? {} : { modules }) }],
      links: [],
    });
    const empty = createSimulation({ seed: 1 });
    empty.loadTopology(doc([]));
    const bare = empty.device('r9')!;
    expect(bare.spec.modules).toEqual([]);
    expect(bare.modules?.size).toBe(0);
    expect([...bare.ports.keys()]).toEqual(bare.model.ports.map((p) => p.name));
    expect(empty.exportTopology().devices[0]!.modules).toEqual([]);

    const defaults = createSimulation({ seed: 1 });
    defaults.loadTopology(doc());
    const dev = defaults.device('r9')!;
    const expected = (dev.model.slots ?? []).filter((s) => s.defaultModule !== undefined).map((s) => ({ slot: s.id, module: s.defaultModule as string }));
    expect(dev.spec.modules).toEqual(expected);
    expect([...(dev.modules ?? new Map<string, string>())].map(([slot, module]) => ({ slot, module }))).toEqual(expected);
    expect(defaults.exportTopology().devices[0]!.modules).toEqual(expected);
  });

  it('routes between a switch-module Vlan1 and a routed port (§3.10 SVI data path), and needs the module for Vlan1', () => {
    const R1_CONFIG = configText([
      ['hostname R1'],
      ['interface GigabitEthernet0/0', ' ip address 10.20.0.1 255.255.255.0', ' no shutdown'],
      // module ports follow the router's portsDefaultUp (administratively down) like its fixed ports
      ['interface GigabitEthernet0/1/0', ' no shutdown'],
      ['interface Vlan1', ' ip address 192.168.10.1 255.255.255.0', ' no shutdown'],
    ]);
    const sim = createSimulation({ seed: 8 });
    sim.loadTopology(
      topology(
        [
          { ...device('r1', R1941, 'R1', 300, 150, R1_CONFIG), modules: [{ slot: '0/1', module: 'mod.ehwic-4esg' }] },
          device('pc1', 'pc.nfpc', 'PC1', 100, 320, pcConfig('PC1', '192.168.10.10', MASK24, '192.168.10.1')),
          device('pc2', 'pc.nfpc', 'PC2', 500, 320, pcConfig('PC2', '10.20.0.10', MASK24, '10.20.0.1')),
        ],
        [
          cable('l_pc1_r1', 'pc1', 'GigabitEthernet0', 'r1', 'GigabitEthernet0/1/0'),
          cable('l_pc2_r1', 'pc2', 'GigabitEthernet0', 'r1', 'GigabitEthernet0/0'),
        ],
      ),
    );
    sim.runFor(120 * SEC);
    const r1 = sim.device('r1')!;
    expect(r1.port('GigabitEthernet0/1/0')!.role).toBe('switched');
    expect(r1.port('Vlan1')).toMatchObject({ adminUp: true, operUp: true, l3: { ipv4: { address: '192.168.10.1', prefixLen: 24 } } });

    // PC1 → its gateway (eth-switch ingress to Vlan1, then the onEgress CAM send back to Gi0/1/0)
    const gw = ping(sim, 'pc1', '192.168.10.1');
    expect(gw.text).toMatch(/received [45], /);
    const sviTx = ofKind(gw.evs, 'frameTx').filter((e) => e.from.device === 'r1');
    expect(sviTx.length).toBeGreaterThan(0);
    expect(new Set(sviTx.map((e) => e.from.port))).toEqual(new Set(['GigabitEthernet0/1/0']));

    // across the router: module switchport subnet ↔ routed Gi0/0 subnet, both ways
    expect(ping(sim, 'pc1', '10.20.0.10').text).toMatch(/received [45], /);
    expect(ping(sim, 'pc2', '192.168.10.10').text).toMatch(/received [45], /);

    // the same router without the module refuses Vlan1 with the original message
    const bare = createSimulation({ seed: 8 });
    bare.addDevice({ id: 'r9', type: R1941, name: 'R9', modules: [] });
    bare.runFor(120 * SEC);
    const refused = bare.configure('r9', ['interface Vlan1']);
    expect(refused.lines[0]?.error?.message).toContain(VIRTUAL_PORT_MESSAGES.needsSwitchModule);
    expect(bare.device('r9')!.port('Vlan1')).toBeUndefined();
  });
});
