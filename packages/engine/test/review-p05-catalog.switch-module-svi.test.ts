/**
 * Review P0.5 (catalog lens): a router with a switch module (NF-EHWIC-4ESG / NF-NIM-ES2-4) gains `switching` but no
 * Vlan family, so its module switchports are an L2 island the router can never address or route for.
 */
import { describe, expect, it } from 'vitest';
import { createSimulation } from '../src/sim/simulation.js';
import { SEC } from '../src/contracts/time.js';
import { VIRTUAL_PORT_MESSAGES } from '../src/device/ports.js';
import { ALL_MODELS, ALL_MODULES, CATALOG_STAGE } from '../src/device/catalog/index.js';
import { validateCatalog } from '../src/device/catalog/validate.js';

describe('review P0.5: routers with a switch module can address the module switchports through Vlan1', () => {
  for (const [type, slot, mod] of [
    ['router.nf1941', '0/1', 'mod.ehwic-4esg'],
    ['router.nf4331', '0/1', 'mod.nim-es2-4'],
  ] as const) {
    it(`${type} + ${mod}: interface Vlan1 takes an address`, () => {
      const sim = createSimulation({ seed: 1 });
      sim.addDevice({ id: 'r', type, name: 'R' });
      sim.setPower('r', false);
      expect(sim.insertModule('r', slot, mod)).toEqual({ ok: true });
      sim.setPower('r', true);
      sim.runFor(120 * SEC);
      const r = sim.configure('r', ['interface Vlan1', 'ip address 192.168.10.1 255.255.255.0', 'no shutdown']);
      expect(r.lines.map((l) => l.error?.message ?? null)).toEqual([null, null, null]);
      expect(sim.device('r')!.port('Vlan1')?.l3.ipv4).toEqual({ address: '192.168.10.1', prefixLen: 24 });
    });
  }

  for (const type of ['router.nf1941', 'router.nf4331'] as const) {
    it(`${type} without a switch module refuses interface Vlan1 with the needs-a-module message`, () => {
      const sim = createSimulation({ seed: 1 });
      sim.addDevice({ id: 'r', type, name: 'R', modules: [] });
      sim.runFor(120 * SEC);
      const r = sim.configure('r', ['interface Vlan1']);
      expect(r.lines[0]?.error?.message).toContain(VIRTUAL_PORT_MESSAGES.needsSwitchModule);
      expect(sim.device('r')!.port('Vlan1')).toBeUndefined();
      // the chassis keeps its fixed port list (no auto Vlan1)
      expect([...sim.device('r')!.ports.keys()]).toEqual(sim.device('r')!.model.ports.map((p) => p.name));
    });
  }

  it('derives a non-auto Vlan1 family (before Loopback) and the eth-switch SVI owner, and the catalog validates', () => {
    for (const type of ['router.nf1941', 'router.nf4331', 'router.nf4451']) {
      const model = ALL_MODELS.find((m) => m.type === type)!;
      expect(model.virtualFamilies?.map((f) => f.family)).toEqual(['Vlan', 'Loopback']);
      expect(model.virtualFamilies?.[0]).toEqual({ family: 'Vlan', short: 'Vl', role: 'svi', min: 1, max: 1, defaultAdminUp: false });
      expect(model.portOwners?.svi).toBe('eth-switch');
      expect(model.processes).not.toContain('eth-switch');
    }
    expect(validateCatalog(ALL_MODELS, ALL_MODULES, { stage: CATALOG_STAGE })).toEqual([]);
  });
});
