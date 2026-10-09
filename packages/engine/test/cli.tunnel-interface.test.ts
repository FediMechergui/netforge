/**
 * [S18] `interface Tunnel<n>` typed on the shipped (flipped) catalog (ARCHITECTURE-P3 §3.10 step 1, §3.13, §5.7; the
 * W4b fix step, finding 0). Since the W4 flip every routing model that is not a home router carries the Tunnel family
 * (`TUNNEL_FAMILY`, role `tunnel`), and the line creates the virtual port on the console and through the GUI/grader
 * path `Simulation.configure`, as `interface Loopback1` does: config-if mode, the `interface Tunnel0` section, the
 * port. A model without the family (NF-C2960) still answers the unknown-interface error, and the profile never gates
 * the line (a P1-profile world creates the port too: DefaultsProfile never gates a feature).
 */
import { describe, expect, it } from 'vitest';
import type { Simulation } from '../src/contracts/simulation.js';
import { SEC } from '../src/contracts/time.js';
import { CATALOG_STAGE } from '../src/device/catalog/index.js';
import { createSimulation } from '../src/sim/simulation.js';

/** R1 (NF-2911) and SW1 (NF-C2960) on the real catalog, booted. */
function booted(profile: 'P1' | 'P3'): Simulation {
  const sim = createSimulation({ seed: 1, profile });
  sim.addDevice({ id: 'r1', type: 'router.nf2911', name: 'R1' });
  sim.addDevice({ id: 'sw1', type: 'switch.nfc2960', name: 'SW1' });
  sim.runFor(60 * SEC);
  return sim;
}

/** Type `lines` on a fresh console session of `device`; each result as [mode, output, error message]. */
function typed(sim: Simulation, device: string, lines: readonly string[]): [string, string, string | undefined][] {
  const session = sim.cli.open(device, 'console');
  return lines.map((l) => {
    const r = sim.cli.exec(session, l);
    return [r.mode, r.output, r.error?.message];
  });
}

describe('[S18] interface Tunnel<n> on the real catalog (W4b fix step, finding 0)', () => {
  it('the shipped catalog is the flipped one and the NF-2911 carries the Tunnel family', () => {
    const sim = booted('P3');
    expect(CATALOG_STAGE).toBe('P3');
    expect(sim.device('r1')!.model.virtualFamilies?.map((f) => [f.family, f.role])).toContainEqual(['Tunnel', 'tunnel']);
  });

  for (const profile of ['P3', 'P1'] as const) {
    it(`typed on the console in a ${profile} world: Tunnel0, Tu1 and tunnel2 enter config-if and create their ports`, () => {
      const sim = booted(profile);
      expect(
        typed(sim, 'r1', ['enable', 'configure terminal', 'interface Tunnel0', 'ip address 172.16.0.1 255.255.255.252', 'exit', 'interface Tu1', 'exit', 'interface tunnel2', 'end']),
      ).toEqual([
        ['priv-exec', '', undefined],
        ['config', '', undefined],
        ['config-if', '', undefined],
        ['config-if', '', undefined],
        ['config', '', undefined],
        ['config-if', '', undefined],
        ['config', '', undefined],
        ['config-if', '', undefined],
        ['priv-exec', '', undefined],
      ]);
      const r1 = sim.device('r1')!;
      const render = r1.running.render();
      expect(render).toContain('interface Tunnel0\n ip address 172.16.0.1 255.255.255.252\n');
      expect(render).toContain('interface Tunnel1\n');
      expect(render).toContain('interface Tunnel2\n');
      for (const name of ['Tunnel0', 'Tunnel1', 'Tunnel2']) expect(r1.port(name)?.spec.role).toBe('tunnel');
      expect(r1.port('Tunnel0')!.l3.ipv4).toEqual({ address: '172.16.0.1', prefixLen: 30 });
    });
  }

  it('through Simulation.configure (the GUI and grader path)', () => {
    const sim = booted('P3');
    const result = sim.configure('r1', ['interface Tunnel5', 'ip address 10.1.1.1 255.255.255.252']);
    expect(result).toMatchObject({ ok: true, applied: 2, finalMode: 'config-if' });
    expect(result.lines.map((l) => [l.ok, l.mode])).toEqual([
      [true, 'config-if'],
      [true, 'config-if'],
    ]);
    expect(sim.device('r1')!.running.render()).toContain('interface Tunnel5\n ip address 10.1.1.1 255.255.255.252\n');
    expect(sim.device('r1')!.port('Tunnel5')?.spec.role).toBe('tunnel');
  });

  it('a model without the Tunnel family still refuses the line, exactly as before', () => {
    const sim = booted('P3');
    expect(typed(sim, 'sw1', ['enable', 'configure terminal', 'interface Tunnel0'])).toEqual([
      ['priv-exec', '', undefined],
      ['config', '', undefined],
      ['config', '                      ^\n% Unknown interface name at the marked position.', '% Unknown interface name at the marked position.'],
    ]);
    expect(sim.device('sw1')!.port('Tunnel0')).toBeUndefined();
  });
});
