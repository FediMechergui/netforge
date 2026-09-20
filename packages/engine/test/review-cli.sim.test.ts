/**
 * Review (CLI lens) regression tests: each case exposed a confirmed bug.
 */
import { strFromU8, unzipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { NETFORGE_FORMAT_VERSION } from '../src/contracts/topology.js';
import { configEntryName, readNetforge, runningConfigEntryName, writeNetforge } from '../src/io/netforge-file.js';
import { pcRouterPc } from '../src/sim/scenarios.js';
import { createSimulation } from '../src/sim/simulation.js';
import { BOOT_NS, booted } from './sim.harness.js';

function r1Priv() {
  const sim = booted(pcRouterPc(), 3);
  const s = sim.cli.open('r1', 'console');
  return { sim, s, x: (l: string) => sim.cli.exec(s, l) };
}

function reloadFromExport(sim: ReturnType<typeof createSimulation>) {
  const sim2 = createSimulation({ seed: 3 });
  sim2.loadTopology(JSON.parse(JSON.stringify(sim.exportTopology())));
  sim2.runFor(BOOT_NS);
  const s = sim2.cli.open('r1', 'console');
  sim2.cli.exec(s, 'en');
  return (l: string) => sim2.cli.exec(s, l);
}

describe('review/cli', () => {
  it('user-exec (privilege 1) must not read the running-config (it carries the enable secret)', () => {
    const { x } = r1Priv();
    x('en');
    x('conf t');
    x('enable secret s3cr3t');
    x('end');
    x('disable');
    expect(x('show running-config').output).not.toContain('s3cr3t');
  });

  it('do exit in config mode does not close the console session', () => {
    const { sim, s, x } = r1Priv();
    x('en');
    x('conf t');
    expect(x('do exit').closed).toBeFalsy();
    expect(sim.cli.session(s)).toBeDefined();
    expect(sim.cli.session(s)!.mode).toBe('config');
  });

  it('do disable in config mode is rejected and keeps config mode at privilege 15', () => {
    const { sim, s, x } = r1Priv();
    x('en');
    x('conf t');
    const r = x('do disable');
    expect(r.error).toBeDefined();
    const sess = sim.cli.session(s)!;
    expect(sess.mode).toBe('config');
    expect(sess.privilege).toBe(15);
  });

  it('export/load keeps the saved startup-config distinct from unsaved running changes', () => {
    const { sim, x } = r1Priv();
    x('en');
    x('conf t');
    x('hostname Saved');
    x('end');
    x('write');
    x('conf t');
    x('hostname Unsaved');
    x('end');
    const y = reloadFromExport(sim);
    expect(y('show startup-config').output).toContain('hostname Saved');
  });

  it('erase startup-config survives export/load', () => {
    const { sim, x } = r1Priv();
    x('en');
    x('erase startup-config');
    const y = reloadFromExport(sim);
    expect(y('show startup-config').output).not.toContain('hostname');
  });

  it('export/load keeps unsaved running-config changes in the running-config', () => {
    const { sim, x } = r1Priv();
    x('en');
    x('conf t');
    x('hostname Saved');
    x('end');
    x('write');
    x('conf t');
    x('hostname Unsaved');
    x('end');
    const y = reloadFromExport(sim);
    expect(y('show running-config').output).toContain('hostname Unsaved');
    expect(y('show startup-config').output).not.toContain('hostname Unsaved');
  });

  it('export/load through a .netforge archive keeps startup and running configs apart', () => {
    const { sim, x } = r1Priv();
    x('en');
    x('conf t');
    x('hostname Saved');
    x('end');
    x('write');
    x('conf t');
    x('hostname Unsaved');
    x('end');
    const bytes = writeNetforge({
      manifest: { format: NETFORGE_FORMAT_VERSION, app: 'netforge/0.0.1', created: '2026-09-14T00:00:00.000Z', modified: '2026-09-14T00:00:00.000Z' },
      topology: sim.exportTopology(),
      configs: {},
    });
    const files = unzipSync(bytes);
    expect(strFromU8(files[configEntryName('r1')]!)).toContain('hostname Saved');
    expect(strFromU8(files[runningConfigEntryName('r1')]!)).toContain('hostname Unsaved');
    const sim2 = createSimulation({ seed: 3 });
    sim2.loadTopology(readNetforge(bytes).topology);
    sim2.runFor(BOOT_NS);
    const s = sim2.cli.open('r1', 'console');
    sim2.cli.exec(s, 'en');
    expect(sim2.cli.exec(s, 'show running-config').output).toContain('hostname Unsaved');
    expect(sim2.cli.exec(s, 'show startup-config').output).toContain('hostname Saved');
  });
});
