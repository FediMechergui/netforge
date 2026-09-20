/**
 * sim — headless configure through the facade (ARCHITECTURE-P1 D9, §3.12): console-identical results, no CLI trace
 * and no listed session, error columns and skipped lines, stopOnError false, atomic revert, power/boot refusal, job
 * refusal, clock sync, shell-less devices, config-fragment faults through the indentation walker.
 */
import { describe, expect, it } from 'vitest';
import { CLI_MESSAGES } from '../src/contracts/cli.js';
import { SEC } from '../src/contracts/time.js';
import { MSG_BOOTING, MSG_POWERED_OFF } from '../src/cli/runtime.js';
import { createSimulation } from '../src/sim/simulation.js';
import { BOOT_NS, console, ofKind } from './sim.harness.js';

function bootedSim(seed = 1) {
  const sim = createSimulation({ seed });
  sim.addDevice({ id: 'pc1', type: 'pc.nfpc', name: 'PC1' });
  sim.addDevice({ id: 'r1', type: 'router.nf2911', name: 'R1' });
  sim.runFor(BOOT_NS);
  return sim;
}

describe('sim: configure (D9)', () => {
  it('produces the running-config of console typing, with configChange events only and no listed session', () => {
    const gui = bootedSim();
    const typed = bootedSim();
    const cursor = gui.trace(0).next;
    const r = gui.configure('pc1', ['ip address 10.0.0.1 255.255.255.0 10.0.0.254']);
    expect(r).toMatchObject({ ok: true, finalMode: 'user-exec' });
    expect(r.applied).toBeGreaterThan(0);
    const evs = gui.trace(cursor).events;
    expect(ofKind(evs, 'configChange').length).toBe(r.applied);
    expect(evs.filter((e) => e.kind === 'cliPrompt' || e.kind === 'cliOutput')).toEqual([]);
    expect(gui.cli.sessions()).toEqual([]);

    console(typed, 'pc1', ['ip address 10.0.0.1 255.255.255.0 10.0.0.254']);
    expect(gui.device('pc1')!.running.render()).toBe(typed.device('pc1')!.running.render());
    expect(gui.snapshot().devices.find((d) => d.id === 'pc1')!.runningConfig).toBe(typed.device('pc1')!.running.render());
  });

  it('reports the error column, skips later lines, or continues with stopOnError false', () => {
    const sim = bootedSim();
    const lines = ['interface GigabitEthernet0/0', 'ip address 10.0.0.1 255.255.300.0', 'description uplink'];
    const stop = sim.configure('r1', lines);
    expect(stop.ok).toBe(false);
    expect(stop.lines.map((l) => [l.ok, l.skipped === true])).toEqual([[true, false], [false, false], [false, true]]);
    expect(stop.lines[1]!.error!.column).toBe('ip address 10.0.0.1 '.length);
    expect(sim.device('r1')!.running.render()).not.toContain('description uplink');

    const go = sim.configure('r1', lines, { stopOnError: false });
    expect(go.lines.map((l) => l.ok)).toEqual([true, false, true]);
    expect(go.lines.some((l) => l.skipped === true)).toBe(false);
    expect(sim.device('r1')!.running.render()).toContain(' description uplink');
  });

  it('reverts every applied change atomically when a line fails', () => {
    const sim = bootedSim();
    const before = sim.device('r1')!.running.render();
    const r = sim.configure('r1', ['hostname Other', 'interface GigabitEthernet0/1', 'ip address 10.9.9.1 255.255.255.0', 'no shutdown', 'frobnicate now'], { atomic: true });
    expect(r.ok).toBe(false);
    expect(r.reverted).toBe(true);
    expect(sim.device('r1')!.running.render()).toBe(before);
    expect(sim.device('r1')!.hostname).toBe('R1');
    expect(sim.device('r1')!.port('GigabitEthernet0/1')!.adminUp).toBe(false);
    expect(sim.snapshot().devices.find((d) => d.id === 'r1')!.runningConfig).toBe(before);
  });

  it('fails every line on a device that is off or still booting, and refuses jobs', () => {
    const sim = createSimulation({ seed: 1 });
    sim.addDevice({ id: 'r1', type: 'router.nf2911', name: 'R1', power: false });
    const off = sim.configure('r1', ['hostname A', 'hostname B'], { stopOnError: false });
    expect(off.lines.map((l) => l.error?.message)).toEqual([MSG_POWERED_OFF, MSG_POWERED_OFF]);
    expect(off.applied).toBe(0);
    sim.setPower('r1', true);
    const booting = sim.configure('r1', ['hostname A']);
    expect(booting.lines[0]!.error!.message).toBe(MSG_BOOTING);

    sim.runFor(BOOT_NS);
    const job = sim.configure('r1', ['do ping 10.0.0.9']);
    expect(job.ok).toBe(false);
    expect(job.lines[0]!.error!.message).toBe(CLI_MESSAGES.notHeadless);
    expect(() => sim.configure('ghost', ['hostname X'])).toThrow(/No device/);
  });

  it('syncs the device clock before applying the lines', () => {
    const sim = bootedSim();
    sim.runFor(123_456);
    const cursor = sim.trace(0).next;
    sim.configure('r1', ['hostname Timed']);
    const change = ofKind(sim.trace(cursor).events, 'configChange');
    expect(change.map((e) => e.t)).toEqual([sim.now]);
  });

  it('configures a device without a command line (shell none) through its grammar', () => {
    const sim = createSimulation({ seed: 1 });
    sim.addDevice({ id: 'home', type: 'wrouter.nfhome', name: 'Home1' });
    sim.runToIdle();
    expect(sim.cli.canOpen('home', 'console')).toEqual({ ok: false, reason: CLI_MESSAGES.noShell });
    expect(() => sim.cli.open('home', 'console')).toThrow(CLI_MESSAGES.noShell);
    const r = sim.configure('home', ['hostname Gateway']);
    expect(r).toMatchObject({ ok: true, finalMode: 'config' });
    expect(sim.device('home')!.hostname).toBe('Gateway');
  });

  it('applies config-fragment faults with pasted-config indentation and keeps going after a bad line', () => {
    const sim = bootedSim();
    sim.injectFault(sim.now, {
      id: 'frag',
      kind: 'config-fragment',
      target: { device: 'r1' },
      params: { config: 'interface Gi0/1\n description to lab\n not a command\n shutdown\nhostname R9\n' },
    });
    sim.runFor(1);
    const dev = sim.device('r1')!;
    expect(dev.hostname).toBe('R9');
    expect(dev.running.render()).toContain('interface GigabitEthernet0/1\n description to lab');
    expect(dev.port('GigabitEthernet0/1')!.adminUp).toBe(false);
    expect(sim.cli.sessions()).toEqual([]);
    sim.runFor(SEC);
  });
});
