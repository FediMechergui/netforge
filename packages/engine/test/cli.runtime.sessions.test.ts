/**
 * cli/runtime.ts — sessions, prompts and mode transitions, caret errors, config
 * flow through `applyConfigLine`, `do`, history, output filters, completion/help.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('../src/cli/handlers/index.js', async () => {
  const exec = await import('../src/cli/handlers/exec.js');
  const config = await import('../src/cli/handlers/config.js');
  return { HANDLER_REGISTRY: { ...exec.execHandlers, ...config.configHandlers } };
});

import type { CommandHandler } from '../src/contracts/cli.js';
import { HANDLERS } from '../src/cli/grammar.js';
import { MSG_INCOMPLETE, MSG_UNRECOGNIZED } from '../src/cli/parser.js';
import { createRuntimeHandlers, execHandlers } from '../src/cli/handlers/exec.js';
import { MSG_NO_TRACEROUTE, tracerouteHandlers } from '../src/cli/handlers/traceroute.js';
import { configHandlers, MSG_BAD_HOSTNAME, MSG_BAD_MASK, MSG_NO_INTERFACE_SELECTED, MSG_ROUTE_HOST_BITS, MSG_BAD_NEXT_HOP, stripBannerDelimiters } from '../src/cli/handlers/config.js';
import { applyOutputFilter, createCliRuntime, HISTORY_LIMIT, MSG_NO_HANDLER, MSG_NO_SESSION, renderCliError, verifySecret } from '../src/cli/runtime.js';
import { harness, showStub, SHOW_STUB_OUTPUT } from './cli.runtime.fake.js';

const REGISTRY: Record<string, CommandHandler> = {
  ...execHandlers,
  ...configHandlers,
  ...tracerouteHandlers,
  [HANDLERS.showVersion]: showStub,
  [HANDLERS.showRunning]: showStub,
};

function routerSession() {
  const h = harness();
  const dev = h.add('d_r1', 'router', 'R1');
  const cli = createCliRuntime(h.deps, REGISTRY);
  const id = cli.open('d_r1', 'console');
  return { h, dev, cli, id };
}

describe('cli/runtime sessions and prompts', () => {
  it('opens sessions with sequential ids, user-exec at privilege 1 and a cliPrompt event', () => {
    const { h, cli, id } = routerSession();
    expect(id).toBe('s_1');
    const v = cli.session(id)!;
    expect(v.mode).toBe('user-exec');
    expect(v.privilege).toBe(1);
    expect(v.prompt).toBe('R1>');
    expect(v.via).toBe('console');
    expect(v.busy).toBe(false);
    expect(h.trace.of('cliPrompt')).toEqual([{ t: 0, kind: 'cliPrompt', session: 's_1', prompt: 'R1>', busy: false }]);
    expect(cli.open('d_r1', 'vty')).toBe('s_2');
    expect(cli.sessions().map((s) => s.id)).toEqual(['s_1', 's_2']);
  });

  it('PC sessions start in user-exec at privilege 15 and have no enable', () => {
    const h = harness();
    h.add('d_pc', 'pc', 'PC1');
    const cli = createCliRuntime(h.deps, REGISTRY);
    const id = cli.open('d_pc', 'console');
    const v = cli.session(id)!;
    expect(v.privilege).toBe(15);
    expect(v.prompt).toBe('PC1>');
    const r = cli.exec(id, 'enable');
    expect(r.error?.column).toBe(0);
    expect(r.mode).toBe('user-exec');
  });

  it('throws when opening a console on an unknown device', () => {
    const h = harness();
    const cli = createCliRuntime(h.deps, REGISTRY);
    expect(() => cli.open('nope', 'console')).toThrow(/unknown device/);
  });

  it('walks enable → configure terminal → interface → end → exit with the right prompts', () => {
    const { cli, id } = routerSession();
    let r = cli.exec(id, 'enable');
    expect(r).toMatchObject({ output: '', mode: 'priv-exec', prompt: 'R1#', busy: false });
    expect(cli.session(id)!.privilege).toBe(15);

    r = cli.exec(id, 'conf t');
    expect(r).toMatchObject({ mode: 'config', prompt: 'R1(config)#' });

    r = cli.exec(id, 'int g0/0');
    expect(r).toMatchObject({ mode: 'config-if', prompt: 'R1(config-if)#' });
    expect(cli.session(id)!.iface).toBe('GigabitEthernet0/0');

    r = cli.exec(id, 'exit');
    expect(r).toMatchObject({ mode: 'config', prompt: 'R1(config)#' });
    expect(cli.session(id)!.iface).toBeUndefined();

    cli.exec(id, 'interface GigabitEthernet 0/1');
    r = cli.exec(id, 'end');
    expect(r).toMatchObject({ mode: 'priv-exec', prompt: 'R1#' });

    r = cli.exec(id, 'disable');
    expect(r).toMatchObject({ mode: 'user-exec', prompt: 'R1>' });
    expect(cli.session(id)!.privilege).toBe(1);

    r = cli.exec(id, 'exit');
    expect(r.closed).toBe(true);
    expect(cli.session(id)).toBeUndefined();
    expect(cli.sessions()).toEqual([]);
  });

  it('logout closes the session and later lines report a closed session', () => {
    const { cli, id } = routerSession();
    expect(cli.exec(id, 'logout').closed).toBe(true);
    const r = cli.exec(id, 'enable');
    expect(r.closed).toBe(true);
    expect(r.output).toBe(MSG_NO_SESSION);
  });

  it('emits a cliPrompt trace event after every non-empty line but not for blank lines', () => {
    const { h, cli, id } = routerSession();
    h.trace.clear();
    cli.exec(id, '   ');
    expect(h.trace.events).toEqual([]);
    cli.exec(id, 'enable');
    expect(h.trace.of('cliPrompt')).toEqual([{ t: 0, kind: 'cliPrompt', session: id, prompt: 'R1#', busy: false }]);
  });

  it('refuses lines while the device is off or still booting', () => {
    const { dev, cli, id } = routerSession();
    dev.bootedAt = undefined;
    expect(cli.exec(id, 'enable').error?.message).toMatch(/starting up/);
    dev.power = false;
    expect(cli.exec(id, 'enable').error?.message).toMatch(/powered off/);
  });
});

describe('cli/runtime error rendering', () => {
  it('renders a caret under the offending token, offset by the prompt', () => {
    const { cli, id } = routerSession();
    const r = cli.exec(id, 'shw version');
    expect(r.error).toEqual({ message: MSG_UNRECOGNIZED, column: 0 });
    expect(r.output).toBe(' '.repeat('R1>'.length) + '^\n' + MSG_UNRECOGNIZED);
    expect(r.mode).toBe('user-exec');

    cli.exec(id, 'enable');
    const r2 = cli.exec(id, 'ping 10.0.0.999');
    expect(r2.error?.column).toBe(5);
    expect(r2.output.startsWith(' '.repeat('R1#'.length + 5) + '^\n')).toBe(true);
  });

  it('renders incomplete commands as the message alone', () => {
    const { cli, id } = routerSession();
    cli.exec(id, 'enable');
    const r = cli.exec(id, 'configure');
    expect(r.error).toEqual({ message: MSG_INCOMPLETE });
    expect(r.output).toBe(MSG_INCOMPLETE);
  });

  it('renderCliError is a pure helper', () => {
    expect(renderCliError({ message: 'x', column: 2 }, 3)).toBe('     ^\nx');
    expect(renderCliError({ message: 'x' }, 3)).toBe('x');
  });

  it('reports a missing handler without throwing', () => {
    const h = harness();
    h.add('d_r1', 'router', 'R1');
    const cli = createCliRuntime(h.deps, { [HANDLERS.execEnable]: execHandlers[HANDLERS.execEnable]! });
    const id = cli.open('d_r1', 'console');
    cli.exec(id, 'enable');
    const r = cli.exec(id, 'show version');
    expect(r.output).toBe(MSG_NO_HANDLER);
    expect(r.error?.message).toBe(MSG_NO_HANDLER);
  });

  it('appends a handler error to its output and mirrors it in error', () => {
    // P1 (§9.2): `traceroute` is a real job; without the traceroute daemon it refuses with its own line.
    const { dev, cli, id } = routerSession();
    dev.processes.delete('traceroute');
    const r = cli.exec(id, 'traceroute 10.0.0.2');
    expect(r.output).toBe(MSG_NO_TRACEROUTE);
    expect(r.error).toEqual({ message: MSG_NO_TRACEROUTE });
  });
});

describe('cli/runtime config flow', () => {
  it('routes no shutdown through applyConfigLine with the interface context', () => {
    const { dev, cli, id } = routerSession();
    cli.exec(id, 'enable');
    cli.exec(id, 'conf t');
    cli.exec(id, 'int g0/0');
    dev.configCalls.length = 0;
    expect(cli.exec(id, 'no shut').output).toBe('');
    expect(dev.configCalls).toEqual([{ context: [['interface', 'GigabitEthernet0/0']], line: ['shutdown'], negate: true }]);
    expect(dev.ports.get('GigabitEthernet0/0')!.adminUp).toBe(true);
    cli.exec(id, 'shutdown');
    expect(dev.configCalls[1]).toEqual({ context: [['interface', 'GigabitEthernet0/0']], line: ['shutdown'], negate: false });
  });

  it('interface commands need a selected interface', () => {
    const { cli, id } = routerSession();
    cli.exec(id, 'enable');
    cli.exec(id, 'conf t');
    // config-if handlers are unreachable from config mode through the grammar; call directly.
    const r = configHandlers[HANDLERS.ifShutdown]!(
      { session: { mode: 'config' }, context: [] } as never,
      {},
      false,
    );
    expect(r.error).toBe(MSG_NO_INTERFACE_SELECTED);
    expect(cli.exec(id, 'shutdown').error?.column).toBe(0);
  });

  it('ip address validates the host part and writes the canonical line', () => {
    const { dev, cli, id } = routerSession();
    cli.exec(id, 'enable');
    cli.exec(id, 'conf t');
    cli.exec(id, 'int g0/0');
    dev.configCalls.length = 0;
    expect(cli.exec(id, 'ip address 10.0.0.0 255.255.255.0').error?.message).toBe(MSG_BAD_MASK);
    expect(cli.exec(id, 'ip address 10.0.0.255 255.255.255.0').error?.message).toBe(MSG_BAD_MASK);
    expect(cli.exec(id, 'ip address 127.0.0.1 255.0.0.0').error?.message).toMatch(/Invalid interface address/);
    expect(dev.configCalls).toEqual([]);
    expect(cli.exec(id, 'ip address 10.0.0.1 255.255.255.0').output).toBe('');
    expect(dev.configCalls).toEqual([{ context: [['interface', 'GigabitEthernet0/0']], line: ['ip', 'address', '10.0.0.1', '255.255.255.0'], negate: false }]);
    expect(dev.running.get('interface.GigabitEthernet0/0.ip.address')).toEqual(['10.0.0.1', '255.255.255.0']);
    // /31 and /32 have no network/broadcast address to protect.
    expect(cli.exec(id, 'ip address 10.0.1.0 255.255.255.254').error).toBeUndefined();
    cli.exec(id, 'no ip address');
    expect(dev.configCalls.at(-1)).toEqual({ context: [['interface', 'GigabitEthernet0/0']], line: ['ip', 'address'], negate: true });
  });

  it('rejects an address whose subnet overlaps another interface', () => {
    const { dev, cli, id } = routerSession();
    dev.ports.get('GigabitEthernet0/1')!.l3 = { ipv4: { address: '10.0.0.2', prefixLen: 24 } };
    cli.exec(id, 'enable');
    cli.exec(id, 'conf t');
    cli.exec(id, 'int g0/0');
    const r = cli.exec(id, 'ip address 10.0.0.7 255.255.255.0');
    expect(r.error?.message).toMatch(/overlaps .* GigabitEthernet0\/1/);
    expect(cli.exec(id, 'ip address 10.0.1.7 255.255.255.0').error).toBeUndefined();
  });

  it('hostname validates and updates the prompt; no hostname restores the default', () => {
    const { dev, cli, id } = routerSession();
    cli.exec(id, 'enable');
    cli.exec(id, 'conf t');
    expect(cli.exec(id, 'hostname 9lives').error?.message).toBe(MSG_BAD_HOSTNAME);
    const r = cli.exec(id, 'hostname Core-1');
    expect(r.prompt).toBe('Core-1(config)#');
    expect(dev.configCalls.at(-1)).toEqual({ context: [], line: ['hostname', 'Core-1'], negate: false });
    expect(cli.exec(id, 'no hostname').prompt).toBe('Router(config)#');
  });

  it('surfaces a rejected config line as the command error', () => {
    const { dev, cli, id } = routerSession();
    cli.exec(id, 'enable');
    cli.exec(id, 'conf t');
    dev.rejectConfig = '% Not on this platform.';
    expect(cli.exec(id, 'banner motd #hi#').error?.message).toBe('% Not on this platform.');
  });

  it('ip route validates network bits and resolves interface next hops', () => {
    const { dev, cli, id } = routerSession();
    cli.exec(id, 'enable');
    cli.exec(id, 'conf t');
    expect(cli.exec(id, 'ip route 10.1.1.5 255.255.255.0 10.0.0.2').error?.message).toBe(MSG_ROUTE_HOST_BITS);
    expect(cli.exec(id, 'ip route 10.1.1.0 255.255.255.0 nowhere').error?.message).toBe(MSG_BAD_NEXT_HOP);
    dev.configCalls.length = 0;
    cli.exec(id, 'ip route 10.1.1.0 255.255.255.0 10.0.0.2');
    cli.exec(id, 'ip route 0.0.0.0 0.0.0.0 gi0/1');
    cli.exec(id, 'no ip route 10.1.1.0 255.255.255.0 10.0.0.2');
    expect(dev.configCalls).toEqual([
      { context: [], line: ['ip', 'route', '10.1.1.0', '255.255.255.0', '10.0.0.2'], negate: false },
      { context: [], line: ['ip', 'route', '0.0.0.0', '0.0.0.0', 'GigabitEthernet0/1'], negate: false },
      { context: [], line: ['ip', 'route', '10.1.1.0', '255.255.255.0', '10.0.0.2'], negate: true },
    ]);
  });

  it('banner motd strips delimiters and is shown when a console opens', () => {
    expect(stripBannerDelimiters('#Authorized use only#')).toBe('Authorized use only');
    expect(stripBannerDelimiters('^C hi there ^C')).toBe(' hi there ');
    expect(stripBannerDelimiters('#')).toBe('#');
    expect(stripBannerDelimiters('plain words')).toBe('plain words');
    const { h, dev, cli, id } = routerSession();
    cli.exec(id, 'enable');
    cli.exec(id, 'conf t');
    cli.exec(id, 'banner motd #Lab router - be careful#');
    expect(dev.running.get('banner')).toEqual(['motd', 'Lab router - be careful']);
    h.trace.clear();
    const id2 = cli.open('d_r1', 'vty');
    expect(h.trace.events).toEqual([
      { t: 0, kind: 'cliOutput', session: id2, text: 'Lab router - be careful' },
      { t: 0, kind: 'cliPrompt', session: id2, prompt: 'R1>', busy: false },
    ]);
  });

  it('enable secret, description, duplex, speed and mac-address are stored as config lines', () => {
    const { dev, cli, id } = routerSession();
    cli.exec(id, 'enable');
    cli.exec(id, 'conf t');
    cli.exec(id, 'enable secret s3cret');
    cli.exec(id, 'int g0/1');
    dev.configCalls.length = 0;
    cli.exec(id, 'description Link to the core');
    cli.exec(id, 'duplex full');
    cli.exec(id, 'speed 100');
    cli.exec(id, 'mac-address 0011.2233.4455');
    cli.exec(id, 'no duplex');
    const ifc = [['interface', 'GigabitEthernet0/1']];
    expect(dev.configCalls).toEqual([
      { context: ifc, line: ['description', 'Link to the core'], negate: false },
      { context: ifc, line: ['duplex', 'full'], negate: false },
      { context: ifc, line: ['speed', '100'], negate: false },
      { context: ifc, line: ['mac-address', '00:11:22:33:44:55'], negate: false },
      { context: ifc, line: ['duplex'], negate: true },
    ]);
    // P1 §4.10: the secret is stored hashed as the two tokens `nf1 <hash>`, never in the clear.
    const stored = dev.running.get('enable')!;
    expect(stored.slice(0, 2)).toEqual(['secret', 'nf1']);
    expect(verifySecret('d_r1', stored.slice(1).join(' '), 's3cret')).toBe(true);
  });

  it('write / copy / erase / reload / clear go through the device operations', () => {
    const { dev, cli, id } = routerSession();
    cli.exec(id, 'enable');
    expect(cli.exec(id, 'write memory').output).toMatch(/saved to startup-config/);
    expect(cli.exec(id, 'copy running-config startup-config').output).toMatch(/saved/);
    expect(dev.startup).toBeDefined();
    expect(cli.exec(id, 'erase startup-config').output).toMatch(/erased/);
    expect(dev.startup).toBeUndefined();
    cli.exec(id, 'clear arp-cache');
    expect(dev.tables.arp.cleared).toEqual(['cleared']);
    expect(dev.ops).toEqual(['saveConfig', 'saveConfig', 'eraseStartup']);
    const r = cli.exec(id, 'reload');
    expect(r.closed).toBe(true);
    expect(dev.ops.at(-1)).toBe('reload 0');
    expect(cli.session(id)).toBeUndefined();
  });

  it('clear mac address-table dynamic clears the CAM on a switch', () => {
    const h = harness();
    const sw = h.add('d_sw', 'switch', 'SW1');
    const cli = createCliRuntime(h.deps, REGISTRY);
    const id = cli.open('d_sw', 'console');
    cli.exec(id, 'enable');
    expect(cli.exec(id, 'clear mac address-table dynamic').error).toBeUndefined();
    expect(sw.tables.cam.cleared).toEqual(['cleared']);
  });
});

describe('cli/runtime do, history, filters, completion', () => {
  it('runs privileged commands from configuration modes with do without leaving the mode', () => {
    const { cli, id } = routerSession();
    cli.exec(id, 'enable');
    cli.exec(id, 'conf t');
    cli.exec(id, 'int g0/0');
    const r = cli.exec(id, 'do show version');
    expect(r.output).toBe(SHOW_STUB_OUTPUT);
    expect(r.mode).toBe('config-if');
    expect(r.prompt).toBe('R1(config-if)#');
    expect(cli.exec(id, 'do').error?.message).toBe(MSG_INCOMPLETE);
  });

  it('do combines with output filters and errors keep the full-line column', () => {
    const { cli, id } = routerSession();
    cli.exec(id, 'enable');
    cli.exec(id, 'conf t');
    expect(cli.exec(id, 'do show version | include hostname').output).toBe('hostname R1');
    const r = cli.exec(id, 'do show bogus');
    expect(r.error?.column).toBe(8);
    expect(r.mode).toBe('config');
  });

  it('the exec.do fallback handler re-executes the rest of the line in priv-exec', () => {
    const calls: [string, string, string][] = [];
    const bound = createRuntimeHandlers({
      debugEnable: () => {},
      debugDisable: () => {},
      debugDisableAll: () => {},
      debugEnabled: () => [],
      exec: (session, line, mode) => {
        calls.push([session, line, mode]);
        return { output: 'ran' };
      },
    });
    const ctx = { session: { id: 's_7' }, deviceId: 'd_r1' } as never;
    expect(bound[HANDLERS.execDo]!(ctx, { command: '  show version ' }, false)).toEqual({ output: 'ran' });
    expect(calls).toEqual([['s_7', 'show version', 'priv-exec']]);
    expect(bound[HANDLERS.execDo]!(ctx, { command: '' }, false).error).toMatch(/after "do"/);
  });

  it('keeps the last 50 lines of history, including failed ones', () => {
    const { cli, id } = routerSession();
    for (let i = 0; i < HISTORY_LIMIT + 5; i++) cli.exec(id, `bogus${i}`);
    const hist = cli.session(id)!.history;
    expect(hist).toHaveLength(HISTORY_LIMIT);
    expect(hist[0]).toBe('bogus5');
    expect(hist.at(-1)).toBe(`bogus${HISTORY_LIMIT + 4}`);
  });

  it('applies include / exclude / begin / section filters to show output', () => {
    const { cli, id } = routerSession();
    expect(cli.exec(id, 'show version | include shutdown').output).toBe(' no shutdown\n shutdown');
    expect(cli.exec(id, 'show version | exclude shutdown').output).toBe(
      ['interface GigabitEthernet0/0', ' ip address 10.0.0.1 255.255.255.0', 'interface GigabitEthernet0/1', 'hostname R1'].join('\n'),
    );
    expect(cli.exec(id, 'show version | begin 0/1').output).toBe(['interface GigabitEthernet0/1', ' shutdown', 'hostname R1'].join('\n'));
    expect(cli.exec(id, 'show run | section interface').output).toBe(
      ['interface GigabitEthernet0/0', ' ip address 10.0.0.1 255.255.255.0', ' no shutdown', 'interface GigabitEthernet0/1', ' shutdown'].join('\n'),
    );
    expect(cli.exec(id, 'show run | section 0/1').output).toBe(['interface GigabitEthernet0/1', ' shutdown'].join('\n'));
    expect(cli.exec(id, 'show version | include nothing-here').output).toBe('');
  });

  it('applyOutputFilter falls back to a literal match for invalid regexes and keeps trailing newlines', () => {
    expect(applyOutputFilter('a(\nb\n', { kind: 'include', pattern: 'a(' })).toBe('a(\n');
    expect(applyOutputFilter('', { kind: 'include', pattern: 'x' })).toBe('');
  });

  it('delegates completion and help to the parser with the device interfaces', () => {
    const { cli, id } = routerSession();
    expect(cli.complete(id, 'sh')).toMatchObject({ insert: 'ow ' });
    cli.exec(id, 'enable');
    cli.exec(id, 'conf t');
    const h = cli.help(id, 'interface ');
    expect(h.items.map((i) => i.token)).toEqual(['GigabitEthernet0/0', 'GigabitEthernet0/1']);
    expect(cli.complete(id, 'interface g')).toMatchObject({ insert: 'igabitEthernet0/' });
    expect(cli.help('s_99', 'x').error?.message).toBe(MSG_NO_SESSION);
  });
});
