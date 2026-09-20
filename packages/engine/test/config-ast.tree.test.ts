/**
 * ConfigAst tree semantics: set/replace/before, multi-valued lines, unset
 * variants, query/get paths, clone/toJSON (spec §7.4, §12.4).
 */
import { describe, expect, it } from 'vitest';
import { ifaceContext } from '../src/contracts/config.js';
import { configAstFromJson, createConfigAst } from '../src/cli/config-ast.js';

const GI0 = ifaceContext('GigabitEthernet0/0');
const GI1 = ifaceContext('GigabitEthernet0/1');

describe('ConfigAst set', () => {
  it('stores a single-valued global line and replaces it with before', () => {
    const ast = createConfigAst();
    const first = ast.set([], ['hostname', 'R1']);
    expect(first).toEqual({ op: 'set', context: [], line: ['hostname', 'R1'] });
    expect(ast.get('hostname')).toEqual(['R1']);

    expect(ast.set([], ['hostname', 'R1'])).toBeUndefined();

    const second = ast.set([], ['hostname', 'Core']);
    expect(second).toEqual({ op: 'set', context: [], line: ['hostname', 'Core'], before: ['R1'] });
    expect(ast.query('hostname')).toHaveLength(1);
    expect(ast.get('hostname')).toEqual(['Core']);
  });

  it('stores ip address under the interface as ip -> address and replaces it', () => {
    const ast = createConfigAst();
    const d = ast.set(GI0, ['ip', 'address', '10.0.0.1', '255.255.255.0']);
    expect(d).toEqual({
      op: 'set',
      context: [['interface', 'GigabitEthernet0/0']],
      line: ['ip', 'address', '10.0.0.1', '255.255.255.0'],
    });
    expect(ast.get('interface.GigabitEthernet0/0.ip.address')).toEqual(['10.0.0.1', '255.255.255.0']);

    const iface = ast.query('interface.GigabitEthernet0/0')[0];
    expect(iface?.children.map((c) => c.key)).toEqual(['ip']);
    expect(iface?.children[0]?.children.map((c) => c.key)).toEqual(['address']);

    expect(ast.set(GI0, ['ip', 'address', '10.0.0.1', '255.255.255.0'])).toBeUndefined();
    const replaced = ast.set(GI0, ['ip', 'address', '10.0.0.2', '255.255.255.0']);
    expect(replaced?.before).toEqual(['10.0.0.1', '255.255.255.0']);
    expect(ast.query('interface.GigabitEthernet0/0.ip.address')).toHaveLength(1);
  });

  it('does not share nodes between two interfaces', () => {
    const ast = createConfigAst();
    ast.set(GI0, ['ip', 'address', '10.0.0.1', '255.255.255.0']);
    ast.set(GI1, ['ip', 'address', '10.0.1.1', '255.255.255.0']);
    expect(ast.query('interface')).toHaveLength(2);
    expect(ast.get('interface.GigabitEthernet0/0.ip.address')).toEqual(['10.0.0.1', '255.255.255.0']);
    expect(ast.get('interface.GigabitEthernet0/1.ip.address')).toEqual(['10.0.1.1', '255.255.255.0']);
    expect(ast.query('interface.ip.address')).toHaveLength(2);
  });

  it('accumulates distinct static routes and dedups identical ones', () => {
    const ast = createConfigAst();
    expect(ast.set([], ['ip', 'route', '0.0.0.0', '0.0.0.0', '10.0.0.254'])).toBeDefined();
    expect(ast.set([], ['ip', 'route', '192.168.1.0', '255.255.255.0', '10.0.0.2'])).toBeDefined();
    expect(ast.set([], ['ip', 'route', '0.0.0.0', '0.0.0.0', '10.0.0.254'])).toBeUndefined();
    const routes = ast.query('ip.route');
    expect(routes.map((r) => r.args)).toEqual([
      ['0.0.0.0', '0.0.0.0', '10.0.0.254'],
      ['192.168.1.0', '255.255.255.0', '10.0.0.2'],
    ]);
  });

  it('replaces enable secret, banner motd and ip default-gateway (single-valued)', () => {
    const ast = createConfigAst();
    ast.set([], ['enable', 'secret', 'one']);
    const d = ast.set([], ['enable', 'secret', 'two']);
    expect(d?.before).toEqual(['one']);
    expect(ast.query('enable')).toHaveLength(1);
    expect(ast.get('enable')).toEqual(['secret', 'two']);

    ast.set([], ['banner', 'motd', '^CWelcome to R1^C']);
    expect(ast.get('banner')).toEqual(['motd', 'Welcome to R1']);
    const b = ast.set([], ['banner', 'motd', 'Authorized', 'access', 'only']);
    expect(b?.line).toEqual(['banner', 'motd', 'Authorized access only']);
    expect(b?.before).toEqual(['Welcome to R1']);

    ast.set([], ['ip', 'default-gateway', '10.0.0.254']);
    const g = ast.set([], ['ip', 'default-gateway', '10.0.0.1']);
    expect(g?.before).toEqual(['10.0.0.254']);
    expect(ast.get('ip.default-gateway')).toEqual(['10.0.0.1']);
  });

  it('treats shutdown as a flag line and description as single text arg', () => {
    const ast = createConfigAst();
    expect(ast.set(GI0, ['shutdown'])).toEqual({
      op: 'set',
      context: [['interface', 'GigabitEthernet0/0']],
      line: ['shutdown'],
    });
    expect(ast.set(GI0, ['shutdown'])).toBeUndefined();
    expect(ast.get('interface.GigabitEthernet0/0.shutdown')).toEqual([]);

    ast.set(GI0, ['description', 'Link', 'to', 'SW1']);
    expect(ast.get('interface.GigabitEthernet0/0.description')).toEqual(['Link to SW1']);
    expect(ast.set(GI0, ['description', 'Link to SW1'])).toBeUndefined();
  });

  it('ignores empty lines', () => {
    const ast = createConfigAst();
    expect(ast.set([], [])).toBeUndefined();
    expect(ast.unset([], [])).toBeUndefined();
  });
});

describe('ConfigAst unset', () => {
  it('removes ip address with or without args and reports before', () => {
    const ast = createConfigAst();
    ast.set(GI0, ['ip', 'address', '10.0.0.1', '255.255.255.0']);
    const d = ast.unset(GI0, ['ip', 'address']);
    expect(d).toEqual({
      op: 'unset',
      context: [['interface', 'GigabitEthernet0/0']],
      line: ['ip', 'address'],
      before: ['10.0.0.1', '255.255.255.0'],
    });
    expect(ast.get('interface.GigabitEthernet0/0.ip.address')).toBeUndefined();
    // the empty ip group is gone but the interface node stays
    expect(ast.query('interface.GigabitEthernet0/0')[0]?.children).toEqual([]);
    expect(ast.unset(GI0, ['ip', 'address'])).toBeUndefined();

    ast.set(GI0, ['ip', 'address', '10.0.0.1', '255.255.255.0']);
    expect(ast.unset(GI0, ['ip', 'address', '10.0.0.9', '255.255.255.0'])).toBeUndefined();
    expect(ast.unset(GI0, ['ip', 'address', '10.0.0.1', '255.255.255.0'])?.before).toEqual([
      '10.0.0.1',
      '255.255.255.0',
    ]);
  });

  it('removes one route by args or all routes without args', () => {
    const ast = createConfigAst();
    ast.set([], ['ip', 'route', '0.0.0.0', '0.0.0.0', '10.0.0.254']);
    ast.set([], ['ip', 'route', '192.168.1.0', '255.255.255.0', '10.0.0.2']);
    ast.set([], ['ip', 'default-gateway', '10.0.0.254']);

    expect(ast.unset([], ['ip', 'route', '1.1.1.0', '255.255.255.0', '10.0.0.2'])).toBeUndefined();
    const d = ast.unset([], ['ip', 'route', '0.0.0.0', '0.0.0.0', '10.0.0.254']);
    expect(d?.before).toEqual(['0.0.0.0', '0.0.0.0', '10.0.0.254']);
    expect(ast.query('ip.route').map((r) => r.args)).toEqual([['192.168.1.0', '255.255.255.0', '10.0.0.2']]);

    ast.set([], ['ip', 'route', '0.0.0.0', '0.0.0.0', '10.0.0.254']);
    expect(ast.unset([], ['ip', 'route'])?.before).toEqual(['192.168.1.0', '255.255.255.0', '10.0.0.2']);
    expect(ast.query('ip.route')).toEqual([]);
    expect(ast.get('ip.default-gateway')).toEqual(['10.0.0.254']);
  });

  it('removes shutdown, hostname, enable secret and the default gateway', () => {
    const ast = createConfigAst();
    ast.set(GI0, ['shutdown']);
    expect(ast.unset(GI0, ['shutdown'])).toEqual({
      op: 'unset',
      context: [['interface', 'GigabitEthernet0/0']],
      line: ['shutdown'],
      before: [],
    });
    expect(ast.unset(GI0, ['shutdown'])).toBeUndefined();

    ast.set([], ['hostname', 'R1']);
    expect(ast.unset([], ['hostname'])?.before).toEqual(['R1']);
    expect(ast.get('hostname')).toBeUndefined();

    ast.set([], ['enable', 'secret', 'pw']);
    expect(ast.unset([], ['enable', 'secret'])?.before).toEqual(['pw']);
    expect(ast.query('enable')).toEqual([]);

    ast.set([], ['ip', 'default-gateway', '10.0.0.254']);
    expect(ast.unset([], ['ip', 'default-gateway'])?.before).toEqual(['10.0.0.254']);
    expect(ast.query('ip')).toEqual([]);
  });

  it('is a no-op for a missing context or line', () => {
    const ast = createConfigAst();
    expect(ast.unset(GI0, ['ip', 'address'])).toBeUndefined();
    expect(ast.query('interface')).toEqual([]);
    ast.set([], ['hostname', 'R1']);
    expect(ast.unset([], ['description'])).toBeUndefined();
    expect(ast.unset([], ['ip', 'route'])).toBeUndefined();
  });
});

describe('ConfigAst query', () => {
  it('walks dotted paths with args[0] discriminators', () => {
    const ast = createConfigAst();
    ast.set([], ['hostname', 'R1']);
    ast.set([], ['interface', 'GigabitEthernet0/0']);
    ast.set([], ['interface', 'GigabitEthernet0/1']);
    ast.set(GI1, ['shutdown']);
    ast.set([], ['line', 'con', '0']);
    ast.set([['line', 'con', '0']], ['logging', 'synchronous']);

    expect(ast.query('interface').map((n) => n.args[0])).toEqual(['GigabitEthernet0/0', 'GigabitEthernet0/1']);
    expect(ast.query('interface.GigabitEthernet0/1')[0]?.args).toEqual(['GigabitEthernet0/1']);
    expect(ast.query('interface.GigabitEthernet0/1.shutdown')).toHaveLength(1);
    expect(ast.query('interface.GigabitEthernet0/0.shutdown')).toHaveLength(0);
    expect(ast.query('interface.GigabitEthernet0/2')).toEqual([]);
    expect(ast.query('line.con.logging')[0]?.args).toEqual(['synchronous']);
    expect(ast.query('nothing')).toEqual([]);
    expect(ast.query('')).toEqual([]);
    expect(ast.get('hostname.R1')).toEqual(['R1']);
  });

  it('get returns a copy of args', () => {
    const ast = createConfigAst();
    ast.set([], ['hostname', 'R1']);
    const args = ast.get('hostname') as string[];
    args.push('x');
    expect(ast.get('hostname')).toEqual(['R1']);
  });
});

describe('ConfigAst clone / toJSON', () => {
  it('clones deeply and round-trips through JSON', () => {
    const ast = createConfigAst();
    ast.set([], ['hostname', 'R1']);
    ast.set(GI0, ['ip', 'address', '10.0.0.1', '255.255.255.0']);
    const copy = ast.clone();
    copy.set([], ['hostname', 'R2']);
    copy.unset(GI0, ['ip', 'address']);
    expect(ast.get('hostname')).toEqual(['R1']);
    expect(ast.get('interface.GigabitEthernet0/0.ip.address')).toEqual(['10.0.0.1', '255.255.255.0']);

    const json = JSON.parse(JSON.stringify(ast.toJSON()));
    const rebuilt = configAstFromJson(json);
    expect(rebuilt.render()).toBe(ast.render());
    expect(rebuilt.toJSON()).toEqual(ast.toJSON());

    const single = configAstFromJson({ key: 'hostname', args: ['X'], children: [] });
    expect(single.get('hostname')).toEqual(['X']);
  });
});
