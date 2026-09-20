import { describe, expect, it } from 'vitest';
import { createSimulation } from '../src/sim/simulation.js';
import { SEC } from '../src/contracts/time.js';

function booted() {
  const sim = createSimulation({ seed: 1 });
  sim.addDevice({ id: 'r1', type: 'router.nf2911', name: 'R1' });
  sim.addDevice({ id: 'hub', type: 'hub.nfhub4', name: 'HUB' });
  sim.addDevice({ id: 'pc1', type: 'pc.nfpc', name: 'PC1' });
  sim.runFor(60 * SEC);
  return sim;
}

describe('review P0.5: configure startContext / startMode get the same validation as the CLI', () => {
  it('refuses a start context on a port the CLI will not enter (console line)', () => {
    const sim = booted();
    const r = sim.configure('r1', ['shutdown'], { startContext: [['interface', 'Console']] });
    expect(r.ok).toBe(false);
    expect(sim.device('r1')!.running.render()).not.toContain('interface Console');
  });
  it('refuses a start context on a repeater port (hub)', () => {
    const sim = booted();
    const r = sim.configure('hub', ['shutdown'], { startContext: [['interface', 'Ethernet0']] });
    expect(r.ok).toBe(false);
    expect(sim.device('hub')!.port('Ethernet0')!.adminUp).toBe(true);
  });
});
