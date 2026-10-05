/**
 * The parent-mode fallback from a list section (W4a fix of a defect qa-qos reported; `cli/runtime.ts` `matchLine`).
 *
 * The entries of a list section that start with their sequence number (`15 permit …`, `cli/grammar/acl.ts` `seqLead`)
 * take any first word as a sequence number, so a global line typed in `config-ext-nacl` / `config-std-nacl` was refused
 * with the sequence-number message instead of falling back to global configuration, as an unrecognized line does in
 * every other sub-mode. Now a line refused at its first command word is retried in the ancestor modes; when none takes
 * it, the section's own error stands.
 */
import { describe, expect, it } from 'vitest';
import type { Simulation } from '../src/contracts/simulation.js';
import { SEC } from '../src/contracts/time.js';
import { createStagedSimulation } from './staged.world.js';

function router(): { sim: Simulation; session: string } {
  const sim = createStagedSimulation({ seed: 3, stage: 'P3' });
  sim.addDevice({ id: 'r1', type: 'router.nf2911', name: 'R1' });
  sim.runFor(60 * SEC);
  const session = sim.cli.open('r1', 'console');
  for (const line of ['enable', 'configure terminal']) expect(sim.cli.exec(session, line).error).toBeUndefined();
  return { sim, session };
}

describe('a global line typed in a list section runs globally (the parent-mode fallback)', () => {
  for (const kind of ['extended', 'standard'] as const) {
    it(`${kind}: hostname, class-map and another list leave the section; a bad first word keeps the section's error`, () => {
      const { sim, session } = router();
      const enter = sim.cli.exec(session, `ip access-list ${kind} EDGE`);
      expect(enter.error).toBeUndefined();
      expect(enter.prompt).toBe(`R1(config-${kind === 'extended' ? 'ext' : 'std'}-nacl)#`);
      expect(sim.cli.exec(session, kind === 'extended' ? 'permit ip any any' : 'permit any').error).toBeUndefined();
      // a line no global command takes either: the section's own sequence-number error, still in the section
      const bad = sim.cli.exec(session, 'abc permit any');
      expect(bad.error?.message).toMatch(/^% Expected a whole number between 1 and 2147483647/);
      expect(bad.prompt).toBe(enter.prompt);
      // a global line: runs globally and leaves the section
      const host = sim.cli.exec(session, 'hostname EDGE1');
      expect(host.error).toBeUndefined();
      expect(host.prompt).toBe('EDGE1(config)#');
      expect(sim.cli.exec(session, `ip access-list ${kind} EDGE`).error).toBeUndefined();
      const cmap = sim.cli.exec(session, 'class-map match-all VOIP');
      expect(cmap.error).toBeUndefined();
      expect(cmap.prompt).toBe('EDGE1(config-cmap)#');
      expect(sim.cli.exec(session, `ip access-list ${kind} EDGE`).error).toBeUndefined();
      const other = sim.cli.exec(session, 'ip access-list extended OTHER');
      expect(other.error).toBeUndefined();
      expect(other.prompt).toBe('EDGE1(config-ext-nacl)#');
      // `no` + a global line falls back too
      expect(sim.cli.exec(session, 'no ip domain-lookup').error).toBeUndefined();
      const run = sim.cli.exec(session, 'do show running-config').output;
      expect(run).toContain('hostname EDGE1');
      expect(run).toContain('class-map match-all VOIP');
      expect(run).toContain('no ip domain-lookup');
      // the section kept its entry
      expect(run).toContain(`ip access-list ${kind} EDGE`);
    });
  }
});
