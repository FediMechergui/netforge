/**
 * `interface range` and the `config-if-range` session mode of cli/runtime.ts (ARCHITECTURE-P2 §2.11, §5.1; §7 W2
 * cli): the session holds the port list, every `config-if` line runs once per port with that port's own context,
 * per-port errors are reported by name, mode navigation and the parent-mode fallback run once, and the pure helpers
 * (`selectedInterface`, `rangePortsOf`, `matchModeOf`).
 */
import { describe, expect, it } from 'vitest';
import type { CliRuntime } from '../src/contracts/cli.js';
import { MSG_INTERFACE_NOT_CONFIGURABLE } from '../src/cli/grammar/index.js';
import { MSG_RANGE_EMPTY } from '../src/cli/handlers/subif.js';
import { INTERFACE_RANGE_KEYWORD } from '../src/cli/modes.js';
import { createCliRuntime, matchModeOf, rangePortsOf, selectedInterface } from '../src/cli/runtime.js';
import { ArrayTrace, fakeCatalog, INERT_RF_VIEWS } from './cli.runtime.fake.js';
import { catalogModel, P05Device } from './cli.runtime.p05.fixture.js';
import { p2Model } from './cli.p2.fixture.js';

const FA = (n: number): string => `FastEthernet0/${n}`;

/** A runtime over the built-in grammar and handlers with one P0.5-fixture switch in global configuration. */
function switchInConfig(type = 'switch.nfc2960', p2 = false): { cli: CliRuntime; dev: P05Device; id: string } {
  const devices = new Map<string, P05Device>();
  const trace = new ArrayTrace();
  const cli = createCliRuntime({ device: (id) => devices.get(id), catalog: fakeCatalog, trace, now: () => 0, ...INERT_RF_VIEWS });
  const dev = new P05Device('d_sw', p2 ? p2Model(type) : catalogModel(type), 'SW1');
  devices.set('d_sw', dev);
  const id = cli.open('d_sw', 'console');
  cli.exec(id, 'enable');
  cli.exec(id, 'configure terminal');
  return { cli, dev, id };
}

describe('pure helpers', () => {
  it('selectedInterface skips a range entry, rangePortsOf lists its ports, matchModeOf aliases the two modes', () => {
    const range = [['interface', INTERFACE_RANGE_KEYWORD, FA(1), FA(2)]];
    expect(selectedInterface(range)).toBeUndefined();
    expect(rangePortsOf(range)).toEqual([FA(1), FA(2)]);
    expect(rangePortsOf([['interface', FA(1)]])).toBeUndefined();
    expect(selectedInterface([['interface', FA(1)]])).toBe(FA(1));
    expect(matchModeOf('config-if-range')).toBe('config-if');
    expect(matchModeOf('config-subif')).toBe('config-if');
    expect(matchModeOf('config-if')).toBe('config-if');
    expect(matchModeOf('config')).toBe('config');
  });
});

describe('interface range', () => {
  it('enters config-if-range with the resolved port list and applies each line to each port', () => {
    const { cli, dev, id } = switchInConfig();
    const r = cli.exec(id, 'interface range fa0/1 - 3, gi0/1');
    expect(r.error).toBeUndefined();
    expect(r.mode).toBe('config-if-range');
    expect(r.prompt).toBe('SW1(config-if-range)#');
    const view = cli.session(id)!;
    expect(view.context).toEqual([['interface', 'range', FA(1), FA(2), FA(3), 'GigabitEthernet0/1']]);
    expect(view.iface).toBeUndefined();
    expect(dev.configCalls.map((c) => c.line)).toEqual([['interface', FA(1)], ['interface', FA(2)], ['interface', FA(3)], ['interface', 'GigabitEthernet0/1']]);

    expect(cli.exec(id, 'shutdown')).toMatchObject({ output: '', mode: 'config-if-range' });
    for (const p of [FA(1), FA(2), FA(3), 'GigabitEthernet0/1']) expect(dev.ports.get(p)?.adminUp, p).toBe(false);
    expect(dev.ports.get(FA(4))?.adminUp).toBe(true);
    expect(cli.exec(id, 'description uplinks').error).toBeUndefined();
    const text = dev.running.render();
    for (const p of [FA(1), FA(2), FA(3), 'GigabitEthernet0/1']) expect(text).toContain(`interface ${p}\n description uplinks\n shutdown`);
    expect(dev.configCalls.filter((c) => c.line[0] === 'description').map((c) => c.context)).toEqual([[['interface', FA(1)]], [['interface', FA(2)]], [['interface', FA(3)]], [['interface', 'GigabitEthernet0/1']]]);
  });

  it('reports a port that refuses the line by name and still configures the others', () => {
    const { cli, dev, id } = switchInConfig();
    cli.exec(id, 'interface range fa0/1 - 3');
    dev.rejectLine = (line) => (line[0] === 'description' && dev.configCalls.filter((c) => c.line[0] === 'description').length === 2 ? 'the second port says no' : undefined);
    const r = cli.exec(id, 'description lab');
    expect(r.error?.message).toBe(`${FA(2)}: the second port says no`);
    expect(r.output).toBe(`${FA(2)}: the second port says no`);
    const text = dev.running.render();
    expect(text).toContain(`interface ${FA(1)}\n description lab`);
    expect(text).not.toContain(`interface ${FA(2)}\n description lab`);
    expect(text).toContain(`interface ${FA(3)}\n description lab`);
  });

  it('runs mode navigation, do and a global line once, in the real mode', () => {
    const { cli, dev, id } = switchInConfig();
    cli.exec(id, 'interface range fa0/1 - 2');
    const shown = cli.exec(id, 'do show ip interface brief');
    expect(shown.error).toBeUndefined();
    expect(shown.output).toContain(FA(1));
    expect(shown.mode).toBe('config-if-range');
    // a global line typed here falls back to global configuration (once)
    expect(cli.exec(id, 'hostname CORE')).toMatchObject({ mode: 'config', prompt: 'CORE(config)#' });
    expect(dev.hostname).toBe('CORE');
    cli.exec(id, 'interface range fa0/1 - 2');
    expect(cli.exec(id, 'exit')).toMatchObject({ mode: 'config' });
    cli.exec(id, 'interface range fa0/1 - 2');
    expect(cli.exec(id, 'end')).toMatchObject({ mode: 'priv-exec' });
    expect(cli.session(id)?.context).toBeUndefined();
  });

  it('refuses a missing port and a reversed range before entering the mode', () => {
    const { cli, dev, id } = switchInConfig();
    const missing = cli.exec(id, 'interface range fa0/1 - 99');
    // the switch has 24 FastEthernet ports: the first missing one is named
    expect(missing.error?.message).toBe('% FastEthernet0/25 does not exist on this device.');
    expect(missing.mode).toBe('config');
    expect(cli.exec(id, 'interface range fa0/5 - 2').error).toBeDefined();
    expect(cli.exec(id, 'interface range nothing0').error?.message).toBe('% Unknown interface name at the marked position.');
    expect(dev.configCalls).toEqual([]);
    expect(cli.session(id)?.mode).toBe('config');
    expect(MSG_RANGE_EMPTY).toContain('at least one interface');
    expect(MSG_INTERFACE_NOT_CONFIGURABLE.length).toBeGreaterThan(0);
  });

  it('offers the config-if commands in help, and a removed port drops the session to config', () => {
    const { cli, id } = switchInConfig();
    cli.exec(id, 'interface range fa0/1 - 2');
    const tokens = cli.help(id, '').items.map((i) => i.token);
    for (const t of ['shutdown', 'description', 'duplex', 'speed', 'exit', 'end', 'do']) expect(tokens, t).toContain(t);
    expect(tokens).not.toContain('hostname');
    cli.onPortsRemoved('d_sw', [FA(2)]);
    expect(cli.session(id)?.mode).toBe('config');
  });

  it('works in a headless configure with indentation', () => {
    const { cli, dev } = switchInConfig();
    const r = cli.configure('d_sw', ['interface range fa0/3 - 4', ' shutdown', 'interface fa0/5', ' shutdown'], { indentation: true });
    expect(r.ok).toBe(true);
    expect(r.lines.map((l) => l.mode)).toEqual(['config-if-range', 'config-if-range', 'config-if', 'config-if']);
    for (const p of [FA(3), FA(4), FA(5)]) expect(dev.ports.get(p)?.adminUp, p).toBe(false);
    expect(r.applied).toBeGreaterThanOrEqual(3);
  });

  it('applies the P2 switchport lines per port on a managed switch', () => {
    const { cli, dev, id } = switchInConfig('switch.nfc2960', true);
    cli.exec(id, 'interface range fa0/1 - 2');
    expect(cli.exec(id, 'switchport mode access').error).toBeUndefined();
    const r = cli.exec(id, 'switchport access vlan 10');
    expect(r.error).toBeUndefined();
    // the first port creates VLAN 10 and says so; the second finds it
    expect(r.output).toBe(`${FA(1)}: % VLAN 10 did not exist, so it has been created.`);
    const text = dev.running.render();
    expect(text).toContain('vlan 10\n');
    expect(text).toContain(`interface ${FA(1)}\n switchport mode access\n switchport access vlan 10`);
    expect(text).toContain(`interface ${FA(2)}\n switchport mode access\n switchport access vlan 10`);
    const vlan = cli.exec(id, 'do show vlan brief');
    expect(vlan.output).toMatch(/\n\s*10\s+VLAN0010\s+active\s+Fa0\/1, Fa0\/2/);
  });
});
