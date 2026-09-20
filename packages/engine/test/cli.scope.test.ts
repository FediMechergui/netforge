/**
 * cli/scope.ts and the P0.5 scope surface of cli/parser.ts (ARCHITECTURE-P1 D2, §3.13): mode class selectors,
 * grammars, capability gates, the legacy kinds gate, the scope cache key and eviction, per-port requirements
 * (hidden from `?`/Tab, mismatch message at the first literal), hidden specs, `do` refusal by session effect,
 * interface resolution through `resolvePort` (virtual only for mode-entering specs, `interface vlan 1` joining),
 * and the arg constraints `pattern` / `maxLength` / `portFilter` / `completion`.
 */
import { describe, expect, it } from 'vitest';
import { BRIDGING_CAPABILITIES, CAPABILITIES, L3_ROLES, type Capability } from '../src/contracts/catalog.js';
import { CLI_MESSAGES, type CliMode, type CommandSpec, type PrivilegeLevel } from '../src/contracts/cli.js';
import type { PortResolution } from '../src/contracts/device.js';
import type { PortView } from '../src/contracts/port.js';
import { GRAMMAR, HANDLERS } from '../src/cli/grammar.js';
import {
  complete,
  help,
  isPortFamilyWord,
  matchCommand,
  MSG_BAD_FORM,
  MSG_INCOMPLETE,
  MSG_INTERFACE_NOT_ALLOWED,
  MSG_INTERFACE_NOT_CREATED,
  MSG_TOO_LONG,
  MSG_UNKNOWN_INTERFACE,
  refusedThroughDo,
  usableSpecs,
  type MatchContext,
} from '../src/cli/parser.js';
import {
  capabilityKey,
  createScopeCache,
  effectiveRole,
  portMismatchMessage,
  portRequirementMet,
  SCOPE_CACHE_LIMIT,
  scopedSpecs,
  scopeKey,
  specInScope,
  specPortAllowed,
  type ScopeInput,
} from '../src/cli/scope.js';
import { cliProfile, modelPortView, P0_CLI_MODELS, testPortView } from './cli.parser.fixture.js';
import { testPortSpec } from './port.fixtures.js';

const spec = (over: Partial<CommandSpec> & Pick<CommandSpec, 'path'>): CommandSpec => ({
  mode: 'priv-exec',
  privilege: 15,
  help: 'A test command',
  handler: `test.${over.path.join('-')}`,
  ...over,
});

const input = (over: Partial<ScopeInput> = {}): ScopeInput => ({ grammar: 'nfos', mode: 'priv-exec', privilege: 15, capabilities: ['routing'], ...over });

const ETH = { name: 'GigabitEthernet1/0/1', short: 'Gi1/0/1', kind: 'ethernet', speedBps: 1e9 } as const;
const SERIAL = { name: 'Serial0/0/0', short: 'Se0/0/0', kind: 'serial', speedBps: 2e6 } as const;

describe('specInScope', () => {
  it('accepts mode names, mode lists and class selectors', () => {
    const exec = spec({ path: ['a'], mode: '@exec', privilege: 1 });
    const cfg = spec({ path: ['b'], mode: '@config' });
    const all = spec({ path: ['c'], mode: '@all', privilege: 1 });
    const auth = spec({ path: ['d'], mode: '@auth', privilege: 0 });
    const list = spec({ path: ['e'], mode: ['config-if', 'config-line'] });
    expect(specInScope(exec, input({ mode: 'user-exec' }))).toBe(true);
    expect(specInScope(exec, input({ mode: 'config' }))).toBe(false);
    for (const mode of ['config', 'config-if', 'config-line', 'dhcp-config'] as CliMode[]) expect(specInScope(cfg, input({ mode })), mode).toBe(true);
    expect(specInScope(cfg, input({ mode: 'priv-exec' }))).toBe(false);
    for (const mode of ['user-exec', 'priv-exec', 'config', 'config-if', 'login'] as CliMode[]) expect(specInScope(all, input({ mode })), mode).toBe(true);
    expect(specInScope(auth, input({ mode: 'login' }))).toBe(true);
    expect(specInScope(auth, input({ mode: 'user-exec' }))).toBe(false);
    expect(specInScope(list, input({ mode: 'config-line' }))).toBe(true);
    expect(specInScope(list, input({ mode: 'config' }))).toBe(false);
  });

  it('refuses modes that do not exist in the device grammar', () => {
    const any = spec({ path: ['x'], mode: '@all', privilege: 1 });
    expect(specInScope(any, input({ grammar: 'host', mode: 'user-exec' }))).toBe(true);
    expect(specInScope(any, input({ grammar: 'host', mode: 'config' }))).toBe(false);
    expect(specInScope(any, input({ grammar: undefined, mode: 'config' }))).toBe(true);
  });

  it('applies privilege', () => {
    const s = spec({ path: ['reload'] });
    expect(specInScope(s, input({ privilege: 1 }))).toBe(false);
    expect(specInScope(s, input({ privilege: 15 }))).toBe(true);
  });

  it('defaults grammars to nfos and host, and honours explicit grammars', () => {
    const shared = spec({ path: ['ping'], mode: '@exec', privilege: 1 });
    const hostOnly = spec({ path: ['ipconfig'], mode: 'user-exec', grammars: ['host'] });
    const nfosOnly = spec({ path: ['enable'], mode: 'user-exec', privilege: 1, grammars: ['nfos'] });
    expect(specInScope(shared, input({ grammar: 'host', mode: 'user-exec' }))).toBe(true);
    expect(specInScope(shared, input({ grammar: 'nfos', mode: 'user-exec' }))).toBe(true);
    expect(specInScope(hostOnly, input({ grammar: 'host', mode: 'user-exec' }))).toBe(true);
    expect(specInScope(hostOnly, input({ grammar: 'nfos', mode: 'user-exec' }))).toBe(false);
    expect(specInScope(nfosOnly, input({ grammar: 'host', mode: 'user-exec' }))).toBe(false);
  });

  it('requires every `requires` capability and one `requiresAny` capability', () => {
    const all = spec({ path: ['x'], requires: ['switching', 'routing'] });
    const any = spec({ path: ['y'], requiresAny: BRIDGING_CAPABILITIES });
    expect(specInScope(all, input({ capabilities: ['switching', 'routing', 'layer3-switch'] }))).toBe(true);
    expect(specInScope(all, input({ capabilities: ['routing'] }))).toBe(false);
    expect(specInScope(any, input({ capabilities: ['wifi-ap'] }))).toBe(true);
    expect(specInScope(any, input({ capabilities: new Set<Capability>(['modem']) }))).toBe(true);
    expect(specInScope(any, input({ capabilities: ['routing'] }))).toBe(false);
    expect(specInScope(any, input({ capabilities: undefined }))).toBe(false);
    expect(specInScope(spec({ path: ['z'], requiresAny: [] }), input())).toBe(false);
  });

  it('scopes by capability data only: the P0 device-kind gate is gone (P0.5 exit gate)', () => {
    const s = spec({ path: ['show', 'mac'], requiresAny: ['switching'] });
    expect(specInScope(s, input({ capabilities: ['switching'] }))).toBe(true);
    expect(specInScope(s, input({ capabilities: ['routing'] }))).toBe(false);
    expect(specInScope(s, input({ capabilities: undefined }))).toBe(false);
    expect('kinds' in s).toBe(false);
  });

  it('scopedSpecs keeps table order', () => {
    const table = [spec({ path: ['b'] }), spec({ path: ['a'], privilege: 1 }), spec({ path: ['c'], requires: ['modem'] }), spec({ path: ['d'] })];
    expect(scopedSpecs(table, input()).map((s) => s.path[0])).toEqual(['b', 'a', 'd']);
  });
});

describe('scope cache', () => {
  it('keys on grammar, mode, privilege, capability set and portsVersion (no device kind since the P0.5 exit gate)', () => {
    expect(capabilityKey(['routing', 'switching'])).toBe(capabilityKey(new Set<Capability>(['switching', 'routing'])));
    expect(capabilityKey([...CAPABILITIES].reverse())).toBe(CAPABILITIES.join(','));
    const base = scopeKey(input());
    for (const over of [{ grammar: 'host' as const }, { mode: 'config' }, { privilege: 1 as PrivilegeLevel }, { capabilities: ['switching'] as Capability[] }, { portsVersion: 1 }]) {
      expect(scopeKey(input(over)), JSON.stringify(over)).not.toBe(base);
    }
    expect(scopeKey(input({ portsVersion: 0 }))).toBe(base);
    expect(scopeKey(input()).split('|')).toHaveLength(5);
  });

  it('returns the same frozen array on a hit and recomputes when portsVersion changes', () => {
    const cache = createScopeCache();
    const table = [spec({ path: ['a'] }), spec({ path: ['b'], requires: ['switching'] })];
    const r1 = cache.scopedSpecs(table, input());
    const r2 = cache.scopedSpecs(table, input({ capabilities: new Set<Capability>(['routing']) }));
    expect(r2).toBe(r1);
    expect(Object.isFrozen(r1)).toBe(true);
    expect(r1.map((s) => s.path[0])).toEqual(['a']);
    const r3 = cache.scopedSpecs(table, input({ portsVersion: 2 }));
    expect(r3).not.toBe(r1);
    expect(r3).toEqual(r1);
    expect(cache.size(table)).toBe(2);
    expect(cache.size([])).toBe(0);
  });

  it('separates spec tables and evicts the oldest key past the limit', () => {
    const cache = createScopeCache(2);
    const t1 = [spec({ path: ['a'] })];
    const t2 = [spec({ path: ['a'] }), spec({ path: ['b'] })];
    expect(cache.scopedSpecs(t2, input()).length).toBe(2);
    const first = cache.scopedSpecs(t1, input({ portsVersion: 1 }));
    cache.scopedSpecs(t1, input({ portsVersion: 2 }));
    cache.scopedSpecs(t1, input({ portsVersion: 3 }));
    expect(cache.size(t1)).toBe(2);
    expect(cache.size(t2)).toBe(1);
    expect(cache.scopedSpecs(t1, input({ portsVersion: 1 }))).not.toBe(first);
    cache.clear();
    expect(cache.size(t1)).toBe(0);
    expect(SCOPE_CACHE_LIMIT).toBeGreaterThan(0);
    expect(() => createScopeCache(0)).toThrow(RangeError);
  });

  it('the parser uses the cache from the match context', () => {
    const cache = createScopeCache();
    const c: MatchContext = { mode: 'priv-exec', privilege: 15, ...cliProfile('router'), portsVersion: 7, scope: cache, resolveInterface: () => undefined };
    expect(matchCommand(GRAMMAR, c, 'show version').ok).toBe(true);
    help(GRAMMAR, c, 'show ');
    expect(cache.size(GRAMMAR)).toBe(1);
    matchCommand(GRAMMAR, { ...c, portsVersion: 8 }, 'show version');
    expect(cache.size(GRAMMAR)).toBe(2);
  });
});

describe('port requirements', () => {
  it('uses the live role, which starts as the spec role derived from the model capabilities', () => {
    expect(effectiveRole(testPortView(testPortSpec(ETH, ['switching'])))).toBe('switched');
    expect(effectiveRole(testPortView(testPortSpec(ETH, ['routing'])))).toBe('routed');
    expect(effectiveRole(testPortView(ETH))).toBe('routed');
    expect(effectiveRole(testPortView({ ...ETH, role: 'switched' }))).toBe('switched');
    expect(effectiveRole(testPortView({ ...ETH, role: 'switched' }, { role: 'routed' }))).toBe('routed');
  });

  it('checks roles, kinds and the DCE end', () => {
    const switched = testPortView({ ...ETH, role: 'switched', allowedRoles: ['switched', 'routed'] });
    const routed = testPortView({ ...ETH, role: 'switched' }, { role: 'routed' });
    const l3 = { roles: L3_ROLES };
    expect(portRequirementMet(l3, switched)).toBe(false);
    expect(portRequirementMet(l3, routed)).toBe(true);
    expect(portRequirementMet({ kinds: ['serial'] }, routed)).toBe(false);
    expect(portRequirementMet({ kinds: ['serial'] }, testPortView(SERIAL))).toBe(true);
    expect(portRequirementMet({ dce: true }, testPortView(SERIAL, { dce: true }))).toBe(true);
    expect(portRequirementMet({ dce: true }, testPortView(SERIAL, { dce: false }))).toBe(false);
    expect(portRequirementMet({ dce: false }, testPortView(SERIAL, { dce: false }))).toBe(true);
    expect(portRequirementMet({ dce: false }, testPortView(SERIAL))).toBe(false);
    expect(portRequirementMet({}, undefined)).toBe(false);
    expect(specPortAllowed({}, undefined)).toBe(true);
    expect(specPortAllowed({ portRequires: { kinds: ['serial'] } }, undefined)).toBe(false);
  });

  it('mismatch message defaults to the contract wording', () => {
    expect(portMismatchMessage({ portRequires: {} })).toBe(CLI_MESSAGES.portUnsupported);
    expect(portMismatchMessage({ portRequires: { mismatch: CLI_MESSAGES.switchedPort } })).toBe(CLI_MESSAGES.switchedPort);
  });
});

// ── parser integration on a small P0.5-style grammar ──────────────────────────

const IP_ADDRESS: CommandSpec = {
  path: ['ip', 'address', '<address>', '<mask>'],
  mode: 'config-if',
  privilege: 15,
  help: 'Set the interface IPv4 address',
  args: { address: { type: 'ipv4', help: 'Address' }, mask: { type: 'ipv4-mask', help: 'Mask' } },
  handler: 'if.ip-address',
  allowNo: true,
  noArgsOptional: true,
  requiresAny: ['routing'],
  portRequires: { roles: L3_ROLES, mismatch: CLI_MESSAGES.switchedPort },
};
const CLOCK_RATE: CommandSpec = {
  path: ['clock', 'rate', '<bps>'],
  mode: 'config-if',
  privilege: 15,
  help: 'Set the line clock of a DCE serial end',
  args: { bps: { type: 'int', help: 'Bits per second', min: 1200, max: 8000000 } },
  handler: 'if.clock-rate',
  allowNo: true,
  portRequires: { kinds: ['serial'] },
};
const SHUTDOWN: CommandSpec = { path: ['shutdown'], mode: 'config-if', privilege: 15, help: 'Disable the interface', handler: 'if.shutdown', allowNo: true };
const EXIT: CommandSpec = { path: ['exit'], mode: '@all', privilege: 1, help: 'Leave the current mode', handler: 'exec.exit', sessionEffect: 'close' };
const END: CommandSpec = { path: ['end'], mode: '@config', privilege: 15, help: 'Return to privileged mode', handler: 'exec.end', entersMode: 'priv-exec' };
const SHOW_MAC: CommandSpec = { path: ['show', 'mac'], mode: '@exec', privilege: 1, help: 'The MAC table', handler: 'show.mac', filterable: true, requiresAny: BRIDGING_CAPABILITIES, grammars: ['nfos'] };
const SHOW_VER: CommandSpec = { path: ['show', 'version'], mode: '@exec', privilege: 1, help: 'Software version', handler: 'show.version', filterable: true };
const IPCONFIG: CommandSpec = { path: ['ipconfig'], mode: 'user-exec', privilege: 15, help: 'Adapter settings', handler: 'pc.ipconfig', grammars: ['host'] };
const LEGACY_ALIAS: CommandSpec = { path: ['sh-ver'], mode: '@exec', privilege: 1, help: 'Old alias', handler: 'show.version', hidden: true };
const INTERFACE: CommandSpec = {
  path: ['interface', '<iface>'],
  mode: 'config',
  privilege: 15,
  help: 'Select an interface to configure',
  args: { iface: { type: 'interface', help: 'Interface name' } },
  handler: 'config.interface',
  entersMode: 'config-if',
};
const SHOW_IF: CommandSpec = {
  path: ['show', 'interfaces', '<iface>'],
  mode: '@exec',
  privilege: 1,
  help: 'Interface counters',
  args: { iface: { type: 'interface', help: 'Interface name', optional: true } },
  handler: 'show.interfaces',
  filterable: true,
};
const SERIAL_ONLY: CommandSpec = {
  path: ['show', 'controllers', '<iface>'],
  mode: '@exec',
  privilege: 1,
  help: 'Serial line detail',
  args: { iface: { type: 'interface', help: 'Serial interface', portFilter: { kinds: ['serial'], mismatch: '% Only serial interfaces have line controllers.' } } },
  handler: 'show.controllers',
  filterable: true,
};
const SSID: CommandSpec = {
  path: ['ssid', '<name>'],
  mode: 'config-if',
  privilege: 15,
  help: 'Network name',
  args: { name: { type: 'word', help: 'Network name', maxLength: 8, pattern: '[A-Za-z0-9-]+', completion: 'ssids-seen' } },
  handler: 'if.ssid',
};
const BANNER: CommandSpec = { path: ['banner', '<text>'], mode: 'config', privilege: 15, help: 'Banner', args: { text: { type: 'rest', help: 'Banner text', maxLength: 10 } }, handler: 'config.banner' };

const TABLE: readonly CommandSpec[] = [IP_ADDRESS, CLOCK_RATE, SHUTDOWN, EXIT, END, SHOW_MAC, SHOW_VER, IPCONFIG, LEGACY_ALIAS, INTERFACE, SHOW_IF, SERIAL_ONLY, SSID, BANNER];

/** A multilayer switch with Gi1/0/1-2, Serial0/0/0 (for filter tests), Vlan1 and a creatable Vlan family. */
const ML_PORTS: Record<string, PortView> = {
  'GigabitEthernet1/0/1': testPortView({ ...ETH, role: 'switched', allowedRoles: ['switched', 'routed'] }),
  'GigabitEthernet1/0/2': testPortView({ ...ETH, name: 'GigabitEthernet1/0/2', short: 'Gi1/0/2', role: 'switched' }, { role: 'routed' }),
  'Serial0/0/0': testPortView({ ...SERIAL, role: 'wan' }, { dce: true }),
  Vlan1: testPortView({ name: 'Vlan1', short: 'Vl1', kind: 'virtual', speedBps: 1e9, role: 'svi' }),
};

function resolveMl(name: string): PortResolution {
  const lower = name.toLowerCase();
  for (const id of Object.keys(ML_PORTS)) if (id.toLowerCase() === lower) return { kind: 'existing', port: id };
  const m = /^(?:v|vl|vla|vlan)(\d+)$/.exec(lower);
  if (m !== null) return { kind: 'virtual', port: `Vlan${Number(m[1])}`, family: 'Vlan' };
  if (/^g(?:i|igabitethernet)?1\/0\/1$/.test(lower)) return { kind: 'existing', port: 'GigabitEthernet1/0/1' };
  if (/^g(?:i|igabitethernet)?1\/0\/2$/.test(lower)) return { kind: 'existing', port: 'GigabitEthernet1/0/2' };
  if (lower === 'se0/0/0') return { kind: 'existing', port: 'Serial0/0/0' };
  if (lower === 'x0') return { kind: 'ambiguous', candidates: ['GigabitEthernet1/0/1', 'Serial0/0/0'] };
  return { kind: 'unknown' };
}

function ml(mode: CliMode, iface?: string, privilege: PrivilegeLevel = 15): MatchContext {
  const c: MatchContext = {
    mode,
    privilege,
    grammar: 'nfos',
    capabilities: ['switching', 'routing', 'layer3-switch'],
    resolveInterface: () => undefined,
    resolvePort: resolveMl,
    portView: (id) => ML_PORTS[id],
    listInterfaces: () => Object.keys(ML_PORTS),
    completions: (source) => (source === 'ssids-seen' ? ['LAB', 'LAB-GUEST', 'HOME'] : []),
  };
  if (iface !== undefined) c.iface = ML_PORTS[iface];
  return c;
}

const tokens = (c: { items: { token: string }[] }): string[] => c.items.map((i) => i.token);

describe('parser: portRequires', () => {
  const switched = ml('config-if', 'GigabitEthernet1/0/1');
  const routed = ml('config-if', 'GigabitEthernet1/0/2');

  it('a spec failing the selected interface is hidden from help and completion', () => {
    expect(tokens(help(TABLE, switched, ''))).toEqual(['do', 'end', 'exit', 'no', 'shutdown', 'ssid']);
    expect(tokens(help(TABLE, routed, ''))).toEqual(['do', 'end', 'exit', 'ip', 'no', 'shutdown', 'ssid']);
    expect(tokens(help(TABLE, switched, 'no '))).toEqual(['shutdown']);
    expect(complete(TABLE, switched, 'i').error?.column).toBe(0);
    expect(complete(TABLE, routed, 'i').insert).toBe('p ');
  });

  it('a line typed in full reports the mismatch at the first literal', () => {
    expect(matchCommand(TABLE, switched, 'ip address 10.1.1.1 255.255.255.0')).toEqual({
      ok: false,
      kind: 'port-unsupported',
      error: { message: CLI_MESSAGES.switchedPort, column: 0 },
    });
    expect(matchCommand(TABLE, switched, '  no ip address')).toEqual({
      ok: false,
      kind: 'port-unsupported',
      error: { message: CLI_MESSAGES.switchedPort, column: 5 },
    });
    expect(matchCommand(TABLE, routed, 'clock rate 64000')).toEqual({
      ok: false,
      kind: 'port-unsupported',
      error: { message: CLI_MESSAGES.portUnsupported, column: 0 },
    });
    expect(matchCommand(TABLE, ml('config-if', 'Serial0/0/0'), 'clock rate 64000')).toMatchObject({ ok: true, args: { bps: '64000' } });
    expect(matchCommand(TABLE, routed, 'ip address 10.1.1.1 255.255.255.0')).toMatchObject({ ok: true, spec: { handler: 'if.ip-address' } });
  });

  it('partial lines of a hidden spec read as unknown; on a matching port they keep their arg and incomplete errors', () => {
    expect(matchCommand(TABLE, routed, 'ip address 10.1.1.1 255.0.255.0')).toMatchObject({ ok: false, kind: 'invalid-arg', error: { column: 20 } });
    expect(matchCommand(TABLE, routed, 'ip address 10.1.1')).toMatchObject({ ok: false, kind: 'invalid-arg', error: { column: 11 } });
    expect(matchCommand(TABLE, routed, 'ip address')).toEqual({ ok: false, kind: 'incomplete', error: { message: MSG_INCOMPLETE } });
    expect(matchCommand(TABLE, switched, 'ip address 10.1.1')).toMatchObject({ ok: false, kind: 'unrecognized', error: { column: 0 } });
    expect(matchCommand(TABLE, switched, 'ip address')).toMatchObject({ ok: false, kind: 'unrecognized', error: { column: 0 } });
    expect(matchCommand(TABLE, switched, 'bogus')).toMatchObject({ ok: false, kind: 'unrecognized', error: { column: 0 } });
  });

  it('no selected interface fails every port requirement', () => {
    expect(matchCommand(TABLE, ml('config-if'), 'ip address 10.1.1.1 255.255.255.0')).toMatchObject({ ok: false, kind: 'port-unsupported' });
    expect(usableSpecs(TABLE, ml('config-if')).map((s) => s.handler)).not.toContain('if.ip-address');
  });

  it('capability gates hide the spec before the port check (P0.5 L2 switch keeps unrecognized)', () => {
    const l2: MatchContext = { ...switched, capabilities: ['switching'] };
    expect(matchCommand(TABLE, l2, 'ip address 10.1.1.1 255.255.255.0')).toMatchObject({ ok: false, kind: 'unrecognized', error: { column: 0 } });
  });
});

describe('parser: grammars, capabilities, class selectors, hidden and do', () => {
  it('requiresAny bridging capabilities and grammars pick the specs', () => {
    expect(matchCommand(TABLE, ml('priv-exec'), 'show mac').ok).toBe(true);
    const router: MatchContext = { ...ml('priv-exec'), capabilities: ['routing'] };
    expect(matchCommand(TABLE, router, 'show mac')).toMatchObject({ ok: false, kind: 'unrecognized', error: { column: 5 } });
    const host: MatchContext = { ...ml('user-exec'), grammar: 'host', capabilities: ['host'] };
    expect(matchCommand(TABLE, host, 'ipconfig').ok).toBe(true);
    expect(matchCommand(TABLE, host, 'show mac').ok).toBe(false);
    expect(matchCommand(TABLE, ml('user-exec'), 'ipconfig').ok).toBe(false);
    expect(tokens(help(TABLE, host, 'show '))).toEqual(['controllers', 'interfaces', 'version']);
  });

  it('class selectors place exit in every mode and end in config modes only', () => {
    for (const mode of ['user-exec', 'priv-exec', 'config', 'config-if', 'config-line'] as CliMode[]) {
      expect(matchCommand(TABLE, ml(mode, 'GigabitEthernet1/0/2'), 'exit').ok, mode).toBe(true);
    }
    expect(matchCommand(TABLE, ml('config-line'), 'end').ok).toBe(true);
    expect(matchCommand(TABLE, ml('priv-exec'), 'end').ok).toBe(false);
  });

  it('hidden specs execute but are not listed', () => {
    expect(matchCommand(TABLE, ml('priv-exec'), 'sh-ver')).toMatchObject({ ok: true, spec: { handler: 'show.version' } });
    expect(tokens(help(TABLE, ml('priv-exec'), ''))).not.toContain('sh-ver');
    expect(complete(TABLE, ml('priv-exec'), 'sh-').error?.column).toBe(0);
  });

  it('do is offered in config-class modes and refuses specs with a session effect or a mode change', () => {
    const conf = ml('config');
    expect(matchCommand(TABLE, conf, 'do show version')).toMatchObject({ ok: true, doPrefix: true });
    expect(matchCommand(TABLE, conf, 'do exit').ok).toBe(false);
    expect(matchCommand(TABLE, ml('config-line'), 'do show mac')).toMatchObject({ ok: true, doPrefix: true });
    expect(tokens(help(TABLE, ml('priv-exec'), ''))).not.toContain('do');
    expect(refusedThroughDo(EXIT)).toBe(true);
    expect(refusedThroughDo(END)).toBe(true);
    expect(refusedThroughDo(SHOW_VER)).toBe(false);
    for (const h of [HANDLERS.execExit, HANDLERS.execLogout, HANDLERS.execEnable]) {
      expect(refusedThroughDo(GRAMMAR.find((g) => g.handler === h)!), h).toBe(true);
    }
  });
});

describe('parser: interface arguments', () => {
  const conf = ml('config');

  it('resolves existing ports and accepts virtual ones only for mode-entering specs', () => {
    expect(matchCommand(TABLE, conf, 'interface gi1/0/2')).toMatchObject({ ok: true, args: { iface: 'GigabitEthernet1/0/2' } });
    expect(matchCommand(TABLE, conf, 'interface Vlan10')).toMatchObject({ ok: true, args: { iface: 'Vlan10' } });
    expect(matchCommand(TABLE, ml('priv-exec'), 'show interfaces vlan10')).toEqual({
      ok: false,
      kind: 'invalid-arg',
      error: { message: MSG_INTERFACE_NOT_CREATED, column: 16 },
    });
    expect(matchCommand(TABLE, ml('priv-exec'), 'show interfaces vlan1')).toMatchObject({ ok: true, args: { iface: 'Vlan1' } });
    expect(matchCommand(TABLE, conf, 'interface q9')).toEqual({ ok: false, kind: 'invalid-arg', error: { message: MSG_UNKNOWN_INTERFACE, column: 10 } });
    const amb = matchCommand(TABLE, conf, 'interface x0');
    expect(amb).toMatchObject({ ok: false, kind: 'invalid-arg', error: { column: 10 } });
    if (!amb.ok) expect(amb.error.message).toContain('GigabitEthernet1/0/1, Serial0/0/0');
  });

  it("joins a family word with the following number ('interface vlan 1')", () => {
    expect(isPortFamilyWord('vlan')).toBe(true);
    expect(isPortFamilyWord('Gi')).toBe(true);
    expect(isPortFamilyWord('GigabitEthernet')).toBe(true);
    expect(isPortFamilyWord('frob')).toBe(false);
    expect(isPortFamilyWord('vlan1')).toBe(false);
    expect(matchCommand(TABLE, conf, 'interface vlan 1')).toMatchObject({ ok: true, args: { iface: 'Vlan1' } });
    expect(matchCommand(TABLE, conf, 'interface Vlan 20')).toMatchObject({ ok: true, args: { iface: 'Vlan20' } });
    expect(matchCommand(TABLE, conf, 'interface GigabitEthernet 1/0/1')).toMatchObject({ ok: true, args: { iface: 'GigabitEthernet1/0/1' } });
    expect(matchCommand(TABLE, ml('priv-exec'), 'show interfaces gi 1/0/2 | include up')).toMatchObject({
      ok: true,
      args: { iface: 'GigabitEthernet1/0/2' },
      filter: { kind: 'include', pattern: 'up' },
    });
  });

  it('a family word alone is incomplete; a bad joined name points at the family word', () => {
    expect(matchCommand(TABLE, conf, 'interface vlan')).toEqual({ ok: false, kind: 'incomplete', error: { message: MSG_INCOMPLETE } });
    expect(matchCommand(TABLE, conf, 'interface gi 9/9/9')).toEqual({ ok: false, kind: 'invalid-arg', error: { message: MSG_UNKNOWN_INTERFACE, column: 10 } });
    expect(matchCommand(TABLE, conf, 'interface frob 1')).toEqual({ ok: false, kind: 'invalid-arg', error: { message: MSG_UNKNOWN_INTERFACE, column: 10 } });
  });

  it('help after a family word offers the matching numbers', () => {
    expect(tokens(help(TABLE, conf, 'interface gi '))).toEqual(['1/0/1', '1/0/2']);
    expect(tokens(help(TABLE, conf, 'interface vlan '))).toEqual(['1']);
    expect(help(TABLE, { ...conf, listInterfaces: undefined }, 'interface vlan ').items).toEqual([{ token: 'NUMBER', help: 'Interface name', isArg: true }]);
    expect(complete(TABLE, conf, 'interface gi 1/0/').insert).toBeUndefined();
    expect(complete(TABLE, conf, 'interface vlan ').insert).toBe('1 ');
    expect(tokens(complete(TABLE, conf, 'interface gi 1/0/'))).toEqual(['1/0/1', '1/0/2']);
  });

  it('portFilter restricts accepted and completed interfaces', () => {
    const priv = ml('priv-exec');
    expect(matchCommand(TABLE, priv, 'show controllers se0/0/0')).toMatchObject({ ok: true, args: { iface: 'Serial0/0/0' } });
    expect(matchCommand(TABLE, priv, 'show controllers gi1/0/1')).toEqual({
      ok: false,
      kind: 'invalid-arg',
      error: { message: '% Only serial interfaces have line controllers.', column: 17 },
    });
    expect(tokens(help(TABLE, priv, 'show controllers '))).toEqual(['Serial0/0/0']);
    const noMsg: CommandSpec = { ...SERIAL_ONLY, args: { iface: { type: 'interface', help: 'x', portFilter: { kinds: ['serial'] } } } };
    expect(matchCommand([noMsg], priv, 'show controllers gi1/0/1')).toMatchObject({ ok: false, error: { message: MSG_INTERFACE_NOT_ALLOWED } });
  });
});

describe('parser: arg constraints and completion sources', () => {
  const wlan = ml('config-if', 'GigabitEthernet1/0/2');

  it('maxLength and pattern', () => {
    expect(matchCommand(TABLE, wlan, 'ssid LAB-1')).toMatchObject({ ok: true, args: { name: 'LAB-1' } });
    expect(matchCommand(TABLE, wlan, 'ssid TOO-LONG-NAME')).toEqual({ ok: false, kind: 'invalid-arg', error: { message: MSG_TOO_LONG(8), column: 5 } });
    expect(matchCommand(TABLE, wlan, 'ssid lab_1')).toEqual({ ok: false, kind: 'invalid-arg', error: { message: MSG_BAD_FORM, column: 5 } });
    expect(matchCommand(TABLE, ml('config'), 'banner hello all')).toMatchObject({ ok: true, args: { text: 'hello all' } });
    expect(matchCommand(TABLE, ml('config'), 'banner hello everyone')).toEqual({ ok: false, kind: 'invalid-arg', error: { message: MSG_TOO_LONG(10), column: 7 } });
  });

  it('dynamic completion values plus the placeholder', () => {
    expect(tokens(help(TABLE, wlan, 'ssid '))).toEqual(['HOME', 'LAB', 'LAB-GUEST', 'WORD']);
    expect(complete(TABLE, wlan, 'ssid L')).toMatchObject({ insert: 'AB' });
  });
});

describe('P0 models through the scope', () => {
  it('derived grammars and capabilities are those of the re-authored P0 models', () => {
    expect(cliProfile('pc')).toEqual({ grammar: 'host', capabilities: ['host'] });
    expect(cliProfile('switch')).toEqual({ grammar: 'nfos', capabilities: ['switching'] });
    expect(cliProfile('router')).toEqual({ grammar: 'nfos', capabilities: ['routing'] });
    expect(P0_CLI_MODELS.switch.ports.length).toBe(26);
  });

  it('the P0 grammar without a kind still scopes by grammar and mode', () => {
    const pcNoKind: MatchContext = { mode: 'user-exec', privilege: 15, ...cliProfile('pc'), resolveInterface: () => undefined };
    expect(matchCommand(GRAMMAR, pcNoKind, 'show version').ok).toBe(true);
    expect(matchCommand(GRAMMAR, { ...pcNoKind, mode: 'config' }, 'hostname R1')).toMatchObject({ ok: false, kind: 'unrecognized' });
    const sw: MatchContext = { mode: 'config-if', privilege: 15, ...cliProfile('switch'), iface: modelPortView('switch', 'FastEthernet0/1'), resolveInterface: () => undefined };
    expect(matchCommand(GRAMMAR, sw, 'shutdown').ok).toBe(true);
    expect(effectiveRole(sw.iface!)).toBe('switched');
  });
});
