/**
 * cli/runtime.ts P0.5 — headless configure (D9, ARCHITECTURE-P1 §3.12): transient `h_<n>` sessions at privilege
 * 15, default start modes per grammar, per-line results with caret columns, stopOnError / skipped, atomic revert
 * through diffTree, power and boot refusal, job / interactive refusal, indentation through the shared walker,
 * startMode / startContext, `applied` counting, no trace and no listed session.
 */
import { describe, expect, it } from 'vitest';
import { CLI_MESSAGES } from '../src/contracts/cli.js';
import { MSG_BOOTING, MSG_POWERED_OFF } from '../src/cli/runtime.js';
import { MSG_UNRECOGNIZED } from '../src/cli/parser.js';
import { p05Harness, stateOf } from './cli.runtime.p05.fixture.js';

const ROUTER = 'router.nf2911';

function router() {
  const h = p05Harness();
  const dev = h.add('d_r1', ROUTER, 'R1');
  return { h, dev };
}

describe('configure basics', () => {
  it('runs nfos lines from global configuration in a transient privileged session that is never listed', () => {
    const { h, dev } = router();
    const r = h.cli.configure!('d_r1', ['hostname R2', 'hostname R2', 'interface g0/0', 'no shutdown', 'show state']);
    // `show state` is an exec command: not reachable from config-if (or its parent) without `do`
    expect(r.ok).toBe(false);
    expect(r.finalMode).toBe('config-if');
    expect(r.lines.map((l) => [l.index, l.ok, l.mode])).toEqual([
      [0, true, 'config'],
      [1, true, 'config'],
      [2, true, 'config-if'],
      [3, true, 'config-if'],
      [4, false, 'config-if'],
    ]);
    expect(r.lines[4]!.error).toEqual({ message: MSG_UNRECOGNIZED, column: 0 });
    expect(dev.configCalls.map((c) => [c.context, c.line, c.negate])).toEqual([
      [[], ['hostname', 'R2'], false],
      [[], ['hostname', 'R2'], false],
      [[], ['interface', 'GigabitEthernet0/0'], false],
      [[['interface', 'GigabitEthernet0/0']], ['shutdown'], true],
    ]);
    expect(h.cli.sessions()).toEqual([]);
    expect(h.trace.events).toEqual([]);
  });

  it('counts applied changes, captures output, and numbers headless sessions separately', () => {
    const { h, dev } = router();
    const r = h.cli.configure!('d_r1', ['hostname R2', 'hostname R2', 'interface g0/1', 'shutdown', 'do show state']);
    expect(r.ok).toBe(true);
    expect(r.applied).toBe(3);
    const state = stateOf(r.lines[4]!.output);
    expect(state).toMatchObject({ session: 'h_1', mode: 'priv-exec', headless: true, grammar: 'nfos' });
    expect(r.lines[4]!.mode).toBe('config-if');
    expect(dev.hostname).toBe('R2');

    const id = h.cli.open('d_r1', 'console');
    expect(id).toBe('s_1');
    const again = h.cli.configure!('d_r1', ['do show state']);
    expect(stateOf(again.lines[0]!.output).session).toBe('h_2');
    expect(again.applied).toBe(0);
    expect(h.cli.sessions().map((s) => s.id)).toEqual(['s_1']);
  });

  it('the host grammar starts in user EXEC and writes through the adapter', () => {
    const h = p05Harness();
    const pc = h.add('d_pc', 'pc.nfpc', 'PC1');
    const r = h.cli.configure!('d_pc', ['ip address 10.0.0.5 255.255.255.0']);
    expect(r).toMatchObject({ ok: true, finalMode: 'user-exec', applied: 1 });
    expect(pc.configCalls).toEqual([{ context: [['interface', pc.model.hostPorts![0]!]], line: ['ip', 'address', '10.0.0.5', '255.255.255.0'], negate: false }]);
  });

  it('works on a device whose shell is none (grammar nfos)', () => {
    const h = p05Harness();
    const home = h.add('d_home', 'wrouter.nfhome', 'Home1');
    expect(h.cli.canOpen!('d_home', 'console').ok).toBe(false);
    const r = h.cli.configure!('d_home', ['hostname Gateway']);
    expect(r).toMatchObject({ ok: true, applied: 1, finalMode: 'config' });
    expect(home.hostname).toBe('Gateway');
  });

  it('throws for an unknown device', () => {
    const { h } = router();
    expect(() => h.cli.configure!('d_none', ['hostname X'])).toThrow(/unknown device/);
  });
});

describe('configure errors', () => {
  it('reports the caret column and skips the rest by default', () => {
    const { h, dev } = router();
    const r = h.cli.configure!('d_r1', ['interface g0/0', 'ip address 10.0.0.999 255.255.255.0', 'no shutdown']);
    expect(r.ok).toBe(false);
    expect(r.lines[1]).toMatchObject({ index: 1, ok: false, output: '', mode: 'config-if' });
    expect(r.lines[1]!.error?.column).toBe(11);
    expect(r.lines[2]).toEqual({ index: 2, line: 'no shutdown', ok: false, output: '', mode: 'config-if', skipped: true });
    expect(dev.configCalls.some((c) => c.line[0] === 'shutdown')).toBe(false);
  });

  it('stopOnError false keeps going and handler errors carry their message', () => {
    const { h, dev } = router();
    const r = h.cli.configure!('d_r1', ['refuse', 'bogus words', 'hostname R7'], { stopOnError: false });
    expect(r.ok).toBe(false);
    expect(r.lines[0]!.error).toEqual({ message: '% Refused by the test grammar.' });
    expect(r.lines[1]!.error).toEqual({ message: MSG_UNRECOGNIZED, column: 0 });
    expect(r.lines[2]).toMatchObject({ ok: true });
    expect(r.lines.some((l) => l.skipped === true)).toBe(false);
    expect(dev.hostname).toBe('R7');
  });

  it('a rejected configuration line fails its command', () => {
    const { h, dev } = router();
    dev.rejectLine = (line) => (line[0] === 'hostname' ? '% Not here.' : undefined);
    const r = h.cli.configure!('d_r1', ['hostname X']);
    expect(r.lines[0]!.error).toEqual({ message: '% Not here.' });
    expect(r.applied).toBe(0);
  });

  it('refuses jobs and interactive commands without starting them', () => {
    const { h, dev } = router();
    const r = h.cli.configure!('d_r1', ['do ping 10.0.0.2', 'do wait', 'do confirm'], { stopOnError: false });
    expect(r.lines.map((l) => l.error)).toEqual([
      { message: CLI_MESSAGES.notHeadless },
      { message: CLI_MESSAGES.notHeadless },
      { message: CLI_MESSAGES.notHeadless },
    ]);
    expect(dev.actionCalls).toEqual([]);
    expect(h.trace.events).toEqual([]);
  });

  it('fails every line on a powered-off or booting device', () => {
    const { h, dev } = router();
    dev.power = false;
    let r = h.cli.configure!('d_r1', ['hostname A', 'hostname B']);
    expect(r.lines[0]!.error).toEqual({ message: MSG_POWERED_OFF });
    expect(r.lines[1]!.skipped).toBe(true);
    r = h.cli.configure!('d_r1', ['hostname A', 'hostname B'], { stopOnError: false });
    expect(r.lines.map((l) => l.error?.message)).toEqual([MSG_POWERED_OFF, MSG_POWERED_OFF]);
    dev.power = true;
    dev.bootedAt = undefined;
    r = h.cli.configure!('d_r1', ['hostname A'], { atomic: true });
    expect(r.lines[0]!.error).toEqual({ message: MSG_BOOTING });
    expect(r.reverted).toBeUndefined();
    expect(dev.configCalls).toEqual([]);
  });
});

describe('configure atomic', () => {
  it('reverts every applied change through applyConfigLine and restores identical text', () => {
    const { h, dev } = router();
    dev.applyConfigLine([], ['hostname', 'R1'], false);
    dev.applyConfigLine([], ['interface', 'GigabitEthernet0/0'], false);
    dev.applyConfigLine([['interface', 'GigabitEthernet0/0']], ['ip', 'address', '10.0.0.1', '255.255.255.0'], false);
    const before = dev.running.render();
    dev.configCalls.length = 0;
    const r = h.cli.configure!('d_r1', ['hostname R9', 'interface g0/1', 'shutdown', 'interface g0/0', 'ip address 10.9.9.1 255.255.255.0', 'refuse', 'hostname Z'], {
      atomic: true,
      stopOnError: false,
    });
    expect(r.ok).toBe(false);
    expect(r.reverted).toBe(true);
    expect(r.lines[6]!.skipped).toBe(true);
    expect(dev.running.render()).toBe(before);
    // five forward calls; `interface g0/0` re-selects an existing section, so four of them change the tree
    const forwardCalls = 5;
    const forwardApplied = 4;
    const reverts = dev.configCalls.slice(forwardCalls);
    expect(reverts.length).toBeGreaterThan(0);
    expect(r.applied).toBe(forwardApplied + reverts.length);
    expect(reverts.some((c) => c.negate)).toBe(true);
  });

  it('reports no revert when every line succeeds', () => {
    const { h, dev } = router();
    const r = h.cli.configure!('d_r1', ['hostname R3'], { atomic: true });
    expect(r.ok).toBe(true);
    expect(r.reverted).toBeUndefined();
    expect(dev.hostname).toBe('R3');
  });
});

describe('configure indentation and start state', () => {
  it('pastes indented text: depth selects the context, comments and end are skipped', () => {
    const { h, dev } = router();
    const cmds = [
      '! branch fragment',
      'hostname R3',
      'interface GigabitEthernet0/1',
      ' shutdown',
      'ip dhcp pool LAN',
      ' network 10.1.0.0 255.255.255.0',
      'interface Gi0/0',
      ' no shutdown',
      '',
      'end',
    ];
    const r = h.cli.configure!('d_r1', cmds, { indentation: true });
    expect(r.ok).toBe(true);
    expect(r.lines).toHaveLength(cmds.length);
    expect(r.lines[0]).toEqual({ index: 0, line: '! branch fragment', ok: true, output: '', mode: 'config' });
    expect(r.finalMode).toBe('config-if');
    expect(dev.configCalls.map((c) => [c.context, c.line.join(' '), c.negate])).toEqual([
      [[], 'hostname R3', false],
      [[], 'interface GigabitEthernet0/1', false],
      [[['interface', 'GigabitEthernet0/1']], 'shutdown', false],
      [[], 'ip dhcp pool LAN', false],
      [[['ip', 'dhcp', 'pool', 'LAN']], 'network 10.1.0.0 255.255.255.0', false],
      [[], 'interface GigabitEthernet0/0', false],
      [[['interface', 'GigabitEthernet0/0']], 'shutdown', true],
    ]);
  });

  it('a less indented line pops back to its parent context before it runs', () => {
    const indented = router();
    const a = indented.h.cli.configure!('d_r1', ['interface g0/0', ' shutdown', 'shutdown'], { indentation: true, stopOnError: false });
    expect(a.lines.map((l) => l.ok)).toEqual([true, true, false]);
    expect(a.lines[2]!.mode).toBe('config');

    const plain = router();
    const b = plain.h.cli.configure!('d_r1', ['interface g0/0', ' shutdown', 'shutdown']);
    expect(b.lines.map((l) => l.ok)).toEqual([true, true, true]);
    expect(b.finalMode).toBe('config-if');
  });

  it('startContext without startMode enters the matching mode; startMode is honoured', () => {
    const { h, dev } = router();
    const r = h.cli.configure!('d_r1', ['shutdown'], { startContext: [['interface', 'GigabitEthernet0/1']] });
    expect(r).toMatchObject({ ok: true, finalMode: 'config-if' });
    expect(dev.configCalls).toEqual([{ context: [['interface', 'GigabitEthernet0/1']], line: ['shutdown'], negate: false }]);

    const exec = h.cli.configure!('d_r1', ['show state'], { startMode: 'priv-exec' });
    expect(stateOf(exec.lines[0]!.output)).toMatchObject({ mode: 'priv-exec', context: [] });
    expect(exec.finalMode).toBe('priv-exec');
  });
});
