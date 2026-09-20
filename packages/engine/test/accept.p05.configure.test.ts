/**
 * P0.5 acceptance — headless configure (ARCHITECTURE-P1 §10.1 `accept.p05.configure`; D9, §3.12).
 *
 * `configure(pc1, ['ip address 10.0.0.1 255.255.255.0 10.0.0.254'])` produces the running-config of console typing,
 * with configChange events only and no session listed. A bad mask reports its error column and skips the later lines;
 * `stopOnError: false` continues; `atomic` reverts to the identical render text. A device that is off or booting fails
 * every line, and a ping line is refused as not headless. Pasted configuration with indentation lands in its sections,
 * and an `ip dhcp pool` section renders once with its children. (The pool commands are P1 grammar, so the section comes
 * from startup-config text, read by the same indentation walker that `configure({ indentation })` uses.)
 */
import { describe, expect, it } from 'vitest';
import { CLI_MESSAGES } from '../src/contracts/cli.js';
import type { Simulation } from '../src/contracts/simulation.js';
import { SEC } from '../src/contracts/time.js';
import { MSG_BOOTING, MSG_POWERED_OFF } from '../src/cli/runtime.js';
import { createSimulation } from '../src/sim/simulation.js';
import { console, ofKind } from './sim.harness.js';
import { configText, section } from './accept.p05.harness.js';

/** PC1 and R1, booted. */
function booted(): Simulation {
  const sim = createSimulation({ seed: 1 });
  sim.addDevice({ id: 'pc1', type: 'pc.nfpc', name: 'PC1' });
  sim.addDevice({ id: 'r1', type: 'router.nf2911', name: 'R1' });
  sim.runFor(60 * SEC);
  return sim;
}

describe('accept P0.5: headless configure', () => {
  it('produces the running-config of console typing, with configChange events only and no session listed', () => {
    const gui = booted();
    const typed = booted();
    const cursor = gui.trace(0).next;
    const result = gui.configure('pc1', ['ip address 10.0.0.1 255.255.255.0 10.0.0.254']);
    const consoleLine = console(typed, 'pc1', ['ip address 10.0.0.1 255.255.255.0 10.0.0.254']).results[0]!;
    expect(result).toMatchObject({ ok: true, applied: 2, finalMode: 'user-exec' });
    expect(consoleLine.output).toContain('10.0.0.1/24');
    expect(result.lines).toEqual([{ index: 0, line: 'ip address 10.0.0.1 255.255.255.0 10.0.0.254', ok: true, output: consoleLine.output, mode: consoleLine.mode }]);
    const evs = gui.trace(cursor).events;
    expect(ofKind(evs, 'configChange').map((e) => [e.device, e.line, e.negate, e.context])).toEqual([
      ['pc1', 'ip address 10.0.0.1 255.255.255.0', false, [['interface', 'GigabitEthernet0']]],
      ['pc1', 'ip default-gateway 10.0.0.254', false, []],
    ]);
    expect(evs.filter((e) => e.kind === 'cliPrompt' || e.kind === 'cliOutput')).toEqual([]);
    expect(gui.cli.sessions()).toEqual([]);

    const render = gui.device('pc1')!.running.render();
    expect(render).toBe(typed.device('pc1')!.running.render());
    expect(render).toContain('interface GigabitEthernet0\n ip address 10.0.0.1 255.255.255.0\n');
    expect(render).toContain('ip default-gateway 10.0.0.254\n');
    const snapshotConfig = (s: Simulation): string => s.snapshot().devices.find((d) => d.id === 'pc1')!.runningConfig;
    expect(snapshotConfig(gui)).toBe(snapshotConfig(typed));
    expect(gui.device('pc1')!.port('GigabitEthernet0')!.l3.ipv4).toEqual({ address: '10.0.0.1', prefixLen: 24 });
  });

  it('reports the error column and skips the later lines, continues with stopOnError false, and reverts atomically', () => {
    const sim = booted();
    const lines = ['interface GigabitEthernet0/0', 'ip address 10.0.0.1 255.255.0.255', 'description uplink'];
    const stop = sim.configure('r1', lines);
    expect(stop).toMatchObject({ ok: false, applied: 0 });
    expect(stop.lines.map((l) => [l.ok, l.skipped === true])).toEqual([
      [true, false],
      [false, false],
      [false, true],
    ]);
    expect(stop.lines[1]!.error).toMatchObject({ column: 'ip address 10.0.0.1 '.length });
    expect(stop.lines[1]!.error!.message).toContain('mask');
    expect(sim.device('r1')!.running.render()).not.toContain('description uplink');

    const go = sim.configure('r1', lines, { stopOnError: false });
    expect(go.lines.map((l) => l.ok)).toEqual([true, false, true]);
    expect(go.lines.some((l) => l.skipped === true)).toBe(false);
    expect(sim.device('r1')!.running.render()).toContain(' description uplink\n');

    const before = sim.device('r1')!.running.render();
    const atomic = sim.configure(
      'r1',
      ['hostname Edge', 'interface GigabitEthernet0/1', 'ip address 10.9.9.1 255.255.255.0', 'no shutdown', 'ip address 10.9.9.1 255.255.300.0'],
      { atomic: true },
    );
    expect(atomic).toMatchObject({ ok: false, reverted: true });
    expect(atomic.lines.map((l) => l.ok)).toEqual([true, true, true, true, false]);
    const r1 = sim.device('r1')!;
    expect(r1.running.render()).toBe(before);
    expect(r1.hostname).toBe('R1');
    expect(r1.port('GigabitEthernet0/1')!.adminUp).toBe(false);
    expect(r1.port('GigabitEthernet0/1')!.l3.ipv4).toBeUndefined();
    expect(sim.snapshot().devices.find((d) => d.id === 'r1')!.runningConfig).toBe(before);
  });

  it('fails every line of a device that is off or booting and refuses job lines as not headless', () => {
    const sim = createSimulation({ seed: 1 });
    sim.addDevice({ id: 'r1', type: 'router.nf2911', name: 'R1', power: false });
    sim.addDevice({ id: 'pc1', type: 'pc.nfpc', name: 'PC1' });

    const off = sim.configure('r1', ['hostname A', 'interface GigabitEthernet0/0', 'no shutdown'], { stopOnError: false });
    expect(off).toMatchObject({ ok: false, applied: 0 });
    expect(off.lines.map((l) => l.error?.message)).toEqual([MSG_POWERED_OFF, MSG_POWERED_OFF, MSG_POWERED_OFF]);
    const stopped = sim.configure('r1', ['hostname A', 'hostname B']);
    expect(stopped.lines.map((l) => [l.ok, l.skipped === true])).toEqual([
      [false, false],
      [false, true],
    ]);

    sim.setPower('r1', true);
    expect(sim.configure('r1', ['hostname A']).lines[0]!.error!.message).toBe(MSG_BOOTING);
    sim.runFor(60 * SEC);
    expect(sim.device('r1')!.hostname).toBe('R1');

    const ping = sim.configure('pc1', ['ping 10.0.0.1']);
    expect(ping).toMatchObject({ ok: false, applied: 0 });
    expect(ping.lines[0]).toMatchObject({ ok: false, error: { message: CLI_MESSAGES.notHeadless } });
    expect(sim.configure('r1', ['do ping 10.0.0.1']).lines[0]!.error!.message).toBe(CLI_MESSAGES.notHeadless);
    expect(sim.cli.sessions()).toEqual([]);
  });

  it('applies pasted configuration with indentation: children into their section, depth-0 lines globally', () => {
    const sim = booted();
    const result = sim.configure('r1', ['interface GigabitEthernet0/1', ' description lab uplink', ' no shutdown', 'hostname R9'], { indentation: true });
    expect(result).toMatchObject({ ok: true, applied: 3, finalMode: 'config' });
    expect(result.lines.map((l) => l.mode)).toEqual(['config-if', 'config-if', 'config-if', 'config']);
    const r1 = sim.device('r1')!;
    expect(r1.hostname).toBe('R9');
    expect(r1.port('GigabitEthernet0/1')!.adminUp).toBe(true);
    expect(r1.running.render()).toContain('interface GigabitEthernet0/1\n description lab uplink\n!');
  });

  it('renders an ip dhcp pool section once, with its children, through boot, save and reload', () => {
    const pool = ['network 192.168.1.0 255.255.255.0', 'default-router 192.168.1.1', 'dns-server 192.168.1.10'];
    const sim = createSimulation({ seed: 1 });
    sim.addDevice({ id: 'r1', type: 'router.nf2911', name: 'R1', startupConfig: configText([['hostname R1'], section('ip dhcp pool LAN', pool)]) });
    sim.runFor(60 * SEC);

    const running = sim.device('r1')!.running;
    const text = running.render();
    const block = `${section('ip dhcp pool LAN', pool).join('\n')}\n`;
    expect(text.split('ip dhcp pool').length - 1).toBe(1);
    expect(text).toContain(`${block}!\n`);
    expect(running.query('ip.dhcp.pool.LAN').map((n) => [n.key, n.args, n.children.map((c) => [c.key, ...c.args].join(' '))])).toEqual([
      ['ip', ['dhcp', 'pool', 'LAN'], pool],
    ]);
    expect(running.get('ip.dhcp.pool.LAN.network')).toEqual(['192.168.1.0', '255.255.255.0']);
    expect(console(sim, 'r1', ['enable', 'show running-config | section dhcp']).results[1]!.output).toBe(block);

    console(sim, 'r1', ['enable', 'copy running-config startup-config']);
    expect(sim.device('r1')!.startup!.render()).toBe(text);
    const again = createSimulation({ seed: 1 });
    again.loadTopology(sim.exportTopology());
    again.runFor(60 * SEC);
    expect(again.device('r1')!.running.render()).toBe(text);
  });
});
