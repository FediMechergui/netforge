/**
 * cli/runtime.ts P0.5 — context stack and modes, parent-mode fallback, scope inputs (grammar, capabilities,
 * selected-interface portRequires, portsVersion), CliJob and interrupt, canOpen / shell none, initial
 * privilege from the CliSpec, onPortsRemoved (ARCHITECTURE-P1 §3.11, §3.13).
 */
import { describe, expect, it } from 'vitest';
import { CLI_MESSAGES } from '../src/contracts/cli.js';
import {
  cliSpecOf,
  contextForMode,
  defaultStartMode,
  indentationLevels,
  pingJob,
  promptSuffix,
  selectedInterface,
} from '../src/cli/runtime.js';
import { deriveCliSpec } from '../src/device/catalog/define.js';
import { p05Harness, stateOf } from './cli.runtime.p05.fixture.js';

const ROUTER = 'router.nf2911';
const PC = 'pc.nfpc';
const HOME = 'wrouter.nfhome';

function routerInConfig() {
  const h = p05Harness();
  const dev = h.add('d_r1', ROUTER, 'R1');
  const id = h.cli.open('d_r1', 'console');
  h.cli.exec(id, 'enable');
  h.cli.exec(id, 'configure terminal');
  return { h, dev, id };
}

describe('runtime pure helpers', () => {
  it('contextForMode keeps, replaces and pushes entries by the mode depth', () => {
    const ifc = [['interface', 'GigabitEthernet0/0']];
    expect(contextForMode(ifc, 'priv-exec')).toEqual([]);
    expect(contextForMode(ifc, 'config')).toEqual([]);
    expect(contextForMode([], 'config-if', { iface: 'Serial0/0/0' })).toEqual([['interface', 'Serial0/0/0']]);
    expect(contextForMode(ifc, 'config-if', { iface: 'Serial0/0/0' })).toEqual([['interface', 'Serial0/0/0']]);
    expect(contextForMode(ifc, 'config-if')).toEqual(ifc);
    expect(contextForMode(ifc, 'dhcp-config', { push: ['ip', 'dhcp', 'pool', 'LAN'] })).toEqual([['ip', 'dhcp', 'pool', 'LAN']]);
    expect(contextForMode([], 'config', { context: [['line', 'vty', '0', '4']] })).toEqual([['line', 'vty', '0', '4']]);
    const copy = contextForMode(ifc, 'config-if');
    copy[0]![1] = 'changed';
    expect(ifc[0]![1]).toBe('GigabitEthernet0/0');
  });

  it('selectedInterface reads the innermost interface entry', () => {
    expect(selectedInterface([])).toBeUndefined();
    expect(selectedInterface([['ip', 'dhcp', 'pool', 'LAN']])).toBeUndefined();
    expect(selectedInterface([['interface', 'Gi0/0']])).toBe('Gi0/0');
  });

  it('job, start mode, CLI spec and prompt helpers', () => {
    expect(pingJob('s_3')).toEqual({ process: 'icmpv4', abort: { kind: 'icmp.abort', session: 's_3' }, label: 'ping' });
    expect(defaultStartMode('nfos')).toBe('config');
    expect(defaultStartMode('host')).toBe('user-exec');
    // the P0 network-OS default (privilege 1 over console and vty) is what defineModel derives for a router
    const routerCli = deriveCliSpec(['routing']);
    expect(cliSpecOf({ cli: routerCli })).toBe(routerCli);
    expect(routerCli).toEqual({ shell: 'nfos', grammar: 'nfos', initialPrivilege: 1, consoleVia: ['console', 'vty'] });
    expect(promptSuffix('dhcp-config')).toBe('(dhcp-config)#');
    expect(promptSuffix('config-custom')).toBe('(config-custom)#');
  });

  it('indentationLevels follows the shared walker and skips comments, blanks, end and version', () => {
    const levels = indentationLevels(['! note', 'interface Gi0/0', ' shutdown', '', 'ip dhcp pool LAN', ' network 10.0.0.0 255.0.0.0', 'end', 'version 1.0']);
    expect([...levels.entries()]).toEqual([
      [1, 0],
      [2, 1],
      [4, 0],
      [5, 1],
    ]);
  });
});

describe('runtime context stack', () => {
  it('interface and pool sub-modes carry their context entry in the view and the command context', () => {
    const { h, id } = routerInConfig();
    let r = h.cli.exec(id, 'interface g0/1');
    expect(r).toMatchObject({ mode: 'config-if', prompt: 'R1(config-if)#' });
    const v = h.cli.session(id)!;
    expect(v.context).toEqual([['interface', 'GigabitEthernet0/1']]);
    expect(v.iface).toBe('GigabitEthernet0/1');
    expect(v.grammar).toBe('nfos');
    expect(stateOf(h.cli.exec(id, 'do show state').output)).toMatchObject({ mode: 'priv-exec', context: [], iface: null, headless: false, grammar: 'nfos' });

    h.cli.exec(id, 'exit');
    r = h.cli.exec(id, 'ip dhcp pool LAN');
    expect(r).toMatchObject({ mode: 'dhcp-config', prompt: 'R1(dhcp-config)#' });
    expect(h.cli.session(id)!.context).toEqual([['ip', 'dhcp', 'pool', 'LAN']]);
    expect(h.cli.session(id)!.iface).toBeUndefined();

    const dev = h.devices.get('d_r1')!;
    dev.configCalls.length = 0;
    h.cli.exec(id, 'network 10.1.0.0 255.255.255.0');
    expect(dev.configCalls).toEqual([{ context: [['ip', 'dhcp', 'pool', 'LAN']], line: ['network', '10.1.0.0', '255.255.255.0'], negate: false }]);

    r = h.cli.exec(id, 'exit');
    expect(r.mode).toBe('config');
    expect(h.cli.session(id)!.context).toEqual([]);
    h.cli.exec(id, 'interface Serial0/0/0');
    r = h.cli.exec(id, 'end');
    expect(r).toMatchObject({ mode: 'priv-exec', prompt: 'R1#' });
    expect(h.cli.session(id)!.context).toBeUndefined();
    expect(h.cli.session(id)!.iface).toBeUndefined();
  });

  it('virtual interfaces resolve through the device and bump portsVersion', () => {
    const { h, dev, id } = routerInConfig();
    const r = h.cli.exec(id, 'interface Loopback0');
    expect(r.error).toBeUndefined();
    expect(r.mode).toBe('config-if');
    expect(dev.portsVersion).toBe(1);
    expect(h.cli.session(id)!.iface).toBe('Loopback0');
    expect(stateOf(h.cli.exec(id, 'do show state').output).iface).toBeNull();
    h.cli.exec(id, 'exit');
    h.cli.exec(id, 'interface loopback 0');
    expect(dev.portsVersion).toBe(1);
    expect(h.cli.session(id)!.iface).toBe('Loopback0');
  });
});

describe('runtime parent-mode fallback', () => {
  it('a global command typed in a sub-mode runs in config with the context truncated', () => {
    const { h, dev, id } = routerInConfig();
    h.cli.exec(id, 'interface g0/0');
    dev.configCalls.length = 0;
    const r = h.cli.exec(id, 'hostname Edge');
    expect(r.error).toBeUndefined();
    expect(r).toMatchObject({ mode: 'config', prompt: 'Edge(config)#' });
    expect(h.cli.session(id)!.context).toEqual([]);
    expect(dev.configCalls).toEqual([{ context: [], line: ['hostname', 'Edge'], negate: false }]);
  });

  it('a mode-entering command from another sub-mode moves to the new sub-mode', () => {
    const { h, id } = routerInConfig();
    h.cli.exec(id, 'ip dhcp pool LAN');
    const r = h.cli.exec(id, 'interface g0/1');
    expect(r).toMatchObject({ mode: 'config-if' });
    expect(h.cli.session(id)!.context).toEqual([['interface', 'GigabitEthernet0/1']]);
  });

  it('an unrecognized line everywhere keeps the sub-mode and reports the sub-mode error', () => {
    const { h, id } = routerInConfig();
    h.cli.exec(id, 'interface g0/0');
    const r = h.cli.exec(id, 'frobnicate now');
    expect(r.error?.column).toBe(0);
    expect(r.output.startsWith(' '.repeat('R1(config-if)#'.length) + '^')).toBe(true);
    expect(r.mode).toBe('config-if');
    expect(h.cli.session(id)!.context).toEqual([['interface', 'GigabitEthernet0/0']]);
  });

  it('help and completion list only the current mode', () => {
    const { h, id } = routerInConfig();
    h.cli.exec(id, 'interface g0/0');
    const tokens = h.cli.help(id, '').items.map((i) => i.token);
    expect(tokens).toContain('shutdown');
    expect(tokens).not.toContain('hostname');
    expect(h.cli.complete(id, 'hostn').error?.column).toBe(0);
  });
});

describe('runtime scope inputs', () => {
  it('portRequires is checked against the selected interface', () => {
    const { h, dev, id } = routerInConfig();
    h.cli.exec(id, 'interface g0/0');
    const bad = h.cli.exec(id, 'clock rate 64000');
    expect(bad.error).toEqual({ message: CLI_MESSAGES.portUnsupported, column: 0 });
    expect(h.cli.help(id, '').items.map((i) => i.token)).not.toContain('clock');

    h.cli.exec(id, 'interface Serial0/0/0');
    dev.configCalls.length = 0;
    expect(h.cli.exec(id, 'clock rate 64000').error).toBeUndefined();
    expect(dev.configCalls).toEqual([{ context: [['interface', 'Serial0/0/0']], line: ['clock', 'rate', '64000'], negate: false }]);
    expect(h.cli.help(id, '').items.map((i) => i.token)).toContain('clock');
  });

  it('grammar and capabilities come from the model: the host shell starts at 15 and sees host specs only', () => {
    const h = p05Harness();
    const pc = h.add('d_pc', PC, 'PC1');
    h.add('d_r1', ROUTER, 'R1');
    const sp = h.cli.open('d_pc', 'console');
    expect(h.cli.session(sp)).toMatchObject({ privilege: 15, mode: 'user-exec', prompt: 'PC1>', grammar: 'host' });
    expect(h.cli.session(sp)!.context).toBeUndefined();
    expect(h.cli.exec(sp, 'enable').error?.column).toBe(0);
    expect(h.cli.exec(sp, 'ip address 10.0.0.5 255.255.255.0').error).toBeUndefined();
    expect(pc.configCalls.at(-1)).toEqual({ context: [['interface', pc.model.hostPorts![0]!]], line: ['ip', 'address', '10.0.0.5', '255.255.255.0'], negate: false });

    const sr = h.cli.open('d_r1', 'console');
    expect(h.cli.session(sr)).toMatchObject({ privilege: 1, grammar: 'nfos' });
    expect(h.cli.exec(sr, 'ip address 10.0.0.1 255.255.255.0').error?.column).toBe(0);
  });

  it('dynamic completion sources read live device state', () => {
    const { h, id } = routerInConfig();
    h.cli.exec(id, 'ip dhcp pool LAN');
    h.cli.exec(id, 'end');
    const items = h.cli.help(id, 'show pool ').items.map((i) => i.token);
    expect(items).toContain('LAN');
  });
});

describe('runtime jobs', () => {
  it('a declared job is shown in the view and interrupt sends its abort to its process', () => {
    const { h, dev, id } = routerInConfig();
    h.cli.exec(id, 'end');
    const r = h.cli.exec(id, 'trace');
    expect(r.busy).toBe(true);
    expect(h.cli.session(id)!.job).toEqual({ process: 'traceroute', label: 'traceroute' });
    h.clock.now = 7;
    h.trace.clear();
    h.cli.interrupt(id);
    expect(dev.actionCalls.at(-1)).toEqual({ process: 'cli', now: 7, actions: [{ type: 'request', to: 'traceroute', req: { kind: 'job.abort', session: id } }] });
    expect(h.cli.session(id)!.busy).toBe(false);
    expect(h.cli.session(id)!.job).toBeUndefined();
    expect(h.trace.of('cliPrompt')).toEqual([{ t: 7, kind: 'cliPrompt', session: id, prompt: 'R1#', busy: false }]);
  });

  it('a bare block keeps the P0 ping job and onDone clears it', () => {
    const { h, id } = routerInConfig();
    h.cli.exec(id, 'end');
    h.cli.exec(id, 'wait');
    expect(h.cli.session(id)!.job).toEqual({ process: 'icmpv4', label: 'ping' });
    h.cli.onDone(id, 3);
    expect(h.cli.session(id)!.job).toBeUndefined();
    expect(h.cli.session(id)!.busy).toBe(false);
  });

  it('a command asking a question at a console waits for the answer (P1 input channel, §4.10)', () => {
    const { h, id } = routerInConfig();
    h.cli.exec(id, 'end');
    const r = h.cli.exec(id, 'confirm');
    expect(r.error).toBeUndefined();
    expect(r.input).toEqual({ kind: 'confirm', prompt: 'Proceed? ' });
    expect(r.busy).toBe(false);
    expect(h.cli.session(id)!.input).toEqual({ kind: 'confirm', prompt: 'Proceed? ' });
    const a = h.cli.exec(id, 'y');
    expect(a.input).toBeUndefined();
    expect(a.error).toBeUndefined();
    expect(h.cli.session(id)!.history).toEqual(['enable', 'configure terminal', 'end', 'confirm']);
  });
});

describe('runtime access', () => {
  it('shell none refuses consoles; canOpen explains why', () => {
    const h = p05Harness();
    h.add('d_home', HOME, 'Home1');
    h.add('d_r1', ROUTER, 'R1');
    expect(h.cli.canOpen!('d_home', 'console')).toEqual({ ok: false, reason: CLI_MESSAGES.noShell });
    expect(() => h.cli.open('d_home', 'console')).toThrow(CLI_MESSAGES.noShell);
    expect(h.cli.sessions()).toEqual([]);
    expect(h.cli.canOpen!('d_r1', 'vty')).toEqual({ ok: true });
    const none = h.cli.canOpen!('d_nope', 'console');
    expect(none.ok).toBe(false);
  });
});

describe('runtime onPortsRemoved', () => {
  it('drops only sessions whose context names a removed port, with a new prompt', () => {
    const h = p05Harness();
    h.add('d_r1', ROUTER, 'R1');
    h.add('d_r2', ROUTER, 'R2');
    const open = (dev: string, iface: string): string => {
      const id = h.cli.open(dev, 'console');
      h.cli.exec(id, 'enable');
      h.cli.exec(id, 'configure terminal');
      h.cli.exec(id, `interface ${iface}`);
      return id;
    };
    const s1 = open('d_r1', 'Serial0/0/1');
    const s2 = open('d_r1', 'GigabitEthernet0/0');
    const s3 = open('d_r2', 'Serial0/0/1');
    h.clock.now = 42;
    h.trace.clear();
    h.cli.onPortsRemoved!('d_r1', ['Serial0/0/0', 'Serial0/0/1']);
    expect(h.cli.session(s1)).toMatchObject({ mode: 'config', context: [], prompt: 'R1(config)#' });
    expect(h.cli.session(s1)!.iface).toBeUndefined();
    expect(h.cli.session(s2)).toMatchObject({ mode: 'config-if', iface: 'GigabitEthernet0/0' });
    expect(h.cli.session(s3)).toMatchObject({ mode: 'config-if', iface: 'Serial0/0/1' });
    expect(h.trace.events).toEqual([{ t: 42, kind: 'cliPrompt', session: s1, prompt: 'R1(config)#', busy: false }]);
  });
});
