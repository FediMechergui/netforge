/**
 * Review P1 W5 (catalog lens): every device that boots the IPv4 host stack without routing — the L2 access
 * switches, the learning bridges and the access points — carries the management `Vlan1` family, so it can take the
 * address its `ip default-gateway` line has always been allowed to name (ARCHITECTURE-P1 §6 "global (AP / switch
 * management)", §9.2 "once L2 switches and APs get the Vlan family (P1 W5)").
 *
 * Vlan1 stays administratively down until `no shutdown`, so a freshly placed device still sends nothing (§5.3).
 */
import { describe, expect, it } from 'vitest';
import { SEC } from '../src/contracts/time.js';
import { MSG_NO_TRACEROUTE } from '../src/cli/handlers/traceroute.js';
import { ALL_MODELS } from '../src/device/catalog/index.js';
import { createSimulation } from '../src/sim/simulation.js';
import type { Simulation } from '../src/contracts/simulation.js';

/** Every model whose management SVI this change added, plus the NF-C2960 that already had it. */
const MANAGED = [
  'switch.nfc2960',
  'switch.nfc2960-8',
  'switch.nfc2960-48',
  'switch.nfc2960-24pg',
  'switch.nfc9200-48',
  'bridge.nfbr2',
  'bridge.nfbr4',
  'ap.nfap-auto',
  'ap.nfap-ax',
  'ap.nfap-lw',
  'ap.nfap-mesh',
] as const;

/** One booted device of `type`. */
function booted(type: string): Simulation {
  const sim = createSimulation({ seed: 3 });
  sim.addDevice({ id: 'd1', type, name: 'D1' });
  sim.runFor(60 * SEC);
  return sim;
}

describe('review P1 W5: the management Vlan of switches, bridges and access points', () => {
  for (const type of MANAGED) {
    it(`${type} boots Vlan1 administratively down and takes a management address`, () => {
      const sim = booted(type);
      const before = sim.device('d1')!.port('Vlan1');
      expect([type, before?.adminUp, before?.operUp]).toEqual([type, false, false]);

      const r = sim.configure('d1', ['interface Vlan1', 'ip address 10.0.0.5 255.255.255.0', 'no shutdown']);
      expect(r.lines.map((l) => l.error?.message ?? null)).toEqual([null, null, null]);
      const port = sim.device('d1')!.port('Vlan1')!;
      expect([type, port.l3.ipv4]).toEqual([type, { address: '10.0.0.5', prefixLen: 24 }]);
      expect(port.adminUp).toBe(true);
      // the gateway line of §6 now has an interface to be reached from
      expect(sim.configure('d1', ['ip default-gateway 10.0.0.254']).ok).toBe(true);
    });
  }

  it('the family is data on the bridging models and derived on the access points, always Vlan1 and down', () => {
    for (const type of MANAGED) {
      const model = ALL_MODELS.find((m) => m.type === type)!;
      expect([type, model.virtualFamilies?.map((f) => f.family)]).toEqual([type, ['Vlan']]);
      expect([type, model.virtualFamilies?.[0]]).toEqual([
        type,
        { family: 'Vlan', short: 'Vl', role: 'svi', min: 1, max: 1, defaultAdminUp: false, auto: [1] },
      ]);
      expect([type, model.portOwners?.svi]).toEqual([type, 'eth-switch']);
    }
  });

  it('a device with an IP stack but no path-trace daemon says so without denying the stack', () => {
    const sim = booted('switch.nfc2960');
    const session = sim.cli.open('d1', 'console');
    sim.cli.exec(session, 'enable');
    expect(sim.cli.exec(session, 'traceroute 10.0.0.1').error?.message).toBe(MSG_NO_TRACEROUTE);
    expect(MSG_NO_TRACEROUTE).not.toContain('IP stack');
  });
});
