/**
 * ConfigAst text side: render golden output, parse -> render round-trip,
 * `| section|include|exclude|begin` filters, diff, PC config shape
 * (spec §7.4; ARCHITECTURE "P0 CLI surface").
 */
import { describe, expect, it } from 'vitest';
import { ifaceContext } from '../src/contracts/config.js';
import type { ConfigAst } from '../src/contracts/config.js';
import { configNodeToText, createConfigAst, parseConfigText } from '../src/cli/config-ast.js';

function router(): ConfigAst {
  const ast = createConfigAst();
  // the device runtime pre-creates interface nodes in port order
  ast.set([], ['interface', 'GigabitEthernet0/0']);
  ast.set([], ['interface', 'GigabitEthernet0/1']);
  ast.set(ifaceContext('GigabitEthernet0/1'), ['shutdown']);
  ast.set([], ['hostname', 'R1']);
  ast.set([], ['enable', 'secret', 'lab']);
  ast.set(ifaceContext('GigabitEthernet0/0'), ['ip', 'address', '10.0.0.1', '255.255.255.0']);
  ast.set(ifaceContext('GigabitEthernet0/0'), ['description', 'Link to SW1']);
  ast.set(ifaceContext('GigabitEthernet0/0'), ['duplex', 'auto']);
  ast.set([], ['ip', 'route', '0.0.0.0', '0.0.0.0', '10.0.0.254']);
  ast.set([], ['ip', 'route', '192.168.1.0', '255.255.255.0', '10.0.0.2']);
  ast.set([], ['banner', 'motd', 'Lab router - authorized use only']);
  ast.set([], ['line', 'con', '0']);
  ast.set([['line', 'con', '0']], ['logging', 'synchronous']);
  return ast;
}

const ROUTER_TEXT = [
  '! NetForge NFOS configuration',
  'version 1.0',
  '!',
  'hostname R1',
  '!',
  'enable secret lab',
  '!',
  'interface GigabitEthernet0/0',
  ' description Link to SW1',
  ' ip address 10.0.0.1 255.255.255.0',
  ' duplex auto',
  '!',
  'interface GigabitEthernet0/1',
  ' shutdown',
  '!',
  'ip route 0.0.0.0 0.0.0.0 10.0.0.254',
  'ip route 192.168.1.0 255.255.255.0 10.0.0.2',
  '!',
  'banner motd ^CLab router - authorized use only^C',
  '!',
  'line con 0',
  ' logging synchronous',
  '!',
  'end',
  '',
].join('\n');

describe('ConfigAst render', () => {
  it('renders the golden router config', () => {
    expect(router().render()).toBe(ROUTER_TEXT);
  });

  it('renders an empty config as header + end', () => {
    expect(createConfigAst().render()).toBe('! NetForge NFOS configuration\nversion 1.0\n!\nend\n');
  });

  it('renders the canonical PC shape', () => {
    const ast = createConfigAst();
    ast.set([], ['interface', 'GigabitEthernet0']);
    ast.set([], ['hostname', 'PC1']);
    ast.set([['interface', 'GigabitEthernet0']], ['ip', 'address', '10.0.0.1', '255.255.255.0'], );
    ast.set([], ['ip', 'default-gateway', '10.0.0.254']);
    expect(ast.render()).toBe(
      [
        '! NetForge NFOS configuration',
        'version 1.0',
        '!',
        'hostname PC1',
        '!',
        'interface GigabitEthernet0',
        ' ip address 10.0.0.1 255.255.255.0',
        '!',
        'ip default-gateway 10.0.0.254',
        '!',
        'end',
        '',
      ].join('\n'),
    );
    expect(ast.get('ip.default-gateway')).toEqual(['10.0.0.254']);
  });

  it('keeps empty interface sections and orders interfaces by insertion', () => {
    const ast = createConfigAst();
    ast.set([], ['interface', 'FastEthernet0/2']);
    ast.set([], ['interface', 'FastEthernet0/1']);
    const lines = ast.render().split('\n');
    expect(lines.indexOf('interface FastEthernet0/2')).toBeLessThan(lines.indexOf('interface FastEthernet0/1'));
    expect(lines.filter((l) => l === '!')).toHaveLength(3);
  });

  it('places non-routing ip lines and unknown keys in their slots', () => {
    const ast = createConfigAst();
    ast.set([], ['logging', 'buffered', '4096']);
    ast.set([], ['ip', 'domain-lookup']);
    ast.set([], ['no', 'ip', 'domain-lookup']);
    ast.set([], ['hostname', 'R1']);
    ast.set([], ['interface', 'GigabitEthernet0/0']);
    ast.set([], ['ip', 'route', '0.0.0.0', '0.0.0.0', '10.0.0.254']);
    expect(ast.render()).toBe(
      [
        '! NetForge NFOS configuration',
        'version 1.0',
        '!',
        'hostname R1',
        '!',
        'no ip domain-lookup',
        '!',
        'ip domain-lookup',
        '!',
        'interface GigabitEthernet0/0',
        '!',
        'ip route 0.0.0.0 0.0.0.0 10.0.0.254',
        '!',
        'logging buffered 4096',
        '!',
        'end',
        '',
      ].join('\n'),
    );
  });

  it('configNodeToText renders a subtree with indentation', () => {
    const ast = router();
    const iface = ast.query('interface.GigabitEthernet0/0')[0]!;
    expect(configNodeToText(iface, 0)).toBe(
      'interface GigabitEthernet0/0\n description Link to SW1\n ip address 10.0.0.1 255.255.255.0\n duplex auto',
    );
    expect(configNodeToText(iface.children.find((c) => c.key === 'ip')!, 1)).toBe(
      ' ip address 10.0.0.1 255.255.255.0',
    );
    expect(configNodeToText(ast.root)).toBe(configNodeToText(ast.root, 0));
  });
});

describe('parseConfigText', () => {
  it('round-trips the golden router config byte for byte', () => {
    const parsed = parseConfigText(ROUTER_TEXT);
    expect(parsed.render()).toBe(ROUTER_TEXT);
    expect(parsed.get('interface.GigabitEthernet0/0.ip.address')).toEqual(['10.0.0.1', '255.255.255.0']);
    expect(parsed.get('interface.GigabitEthernet0/1.shutdown')).toEqual([]);
    expect(parsed.get('banner')).toEqual(['motd', 'Lab router - authorized use only']);
    expect(parsed.query('ip.route')).toHaveLength(2);
    expect(parsed.get('line.con.logging')).toEqual(['synchronous']);
    // parse -> render -> parse is a fixed point at the tree level too
    expect(parseConfigText(parsed.render()).toJSON()).toEqual(parsed.toJSON());
  });

  it('round-trips the PC shape and a config with unknown lines', () => {
    const pc = createConfigAst();
    pc.set([], ['interface', 'GigabitEthernet0']);
    pc.set([['interface', 'GigabitEthernet0']], ['ip', 'address', '10.0.0.1', '255.255.255.0']);
    pc.set([], ['ip', 'default-gateway', '10.0.0.254']);
    expect(parseConfigText(pc.render()).render()).toBe(pc.render());

    const odd = createConfigAst();
    odd.set([], ['no', 'ip', 'domain-lookup']);
    odd.set([], ['logging', 'buffered', '4096']);
    odd.set([], ['line', 'vty', '0', '4']);
    odd.set([['line', 'vty', '0', '4']], ['login']);
    expect(parseConfigText(odd.render()).render()).toBe(odd.render());
  });

  it('applies "no" lines, ignores noise and tolerates CRLF and odd indentation', () => {
    const text = [
      '',
      '! comment',
      'version 15.2\r',
      'hostname R9\r',
      'interface GigabitEthernet0/0',
      '   ip address 10.0.0.1 255.255.255.0',
      ' shutdown',
      ' no shutdown',
      ' no ip address',
      '   description   Spaced   out',
      'no ip domain-lookup',
      'end',
    ].join('\n');
    const ast = parseConfigText(text);
    expect(ast.get('hostname')).toEqual(['R9']);
    expect(ast.get('interface.GigabitEthernet0/0.shutdown')).toBeUndefined();
    expect(ast.get('interface.GigabitEthernet0/0.ip.address')).toBeUndefined();
    expect(ast.get('interface.GigabitEthernet0/0.description')).toEqual(['Spaced out']);
    expect(ast.get('no')).toEqual(['ip', 'domain-lookup']);
    expect(ast.query('version')).toEqual([]);
    expect(ast.query('end')).toEqual([]);
  });
});

describe('renderFiltered', () => {
  it('section keeps matching top-level lines with their children', () => {
    expect(router().renderFiltered({ kind: 'section', pattern: 'interface' })).toBe(
      [
        'interface GigabitEthernet0/0',
        ' description Link to SW1',
        ' ip address 10.0.0.1 255.255.255.0',
        ' duplex auto',
        'interface GigabitEthernet0/1',
        ' shutdown',
      ].join('\n'),
    );
    expect(router().renderFiltered({ kind: 'section', pattern: 'Gigabit.*0/1' })).toBe(
      'interface GigabitEthernet0/1\n shutdown',
    );
    expect(router().renderFiltered({ kind: 'section', pattern: 'nomatch' })).toBe('');
  });

  it('include / exclude / begin operate on rendered lines', () => {
    const ast = router();
    expect(ast.renderFiltered({ kind: 'include', pattern: 'ip route' })).toBe(
      'ip route 0.0.0.0 0.0.0.0 10.0.0.254\nip route 192.168.1.0 255.255.255.0 10.0.0.2',
    );
    const excluded = ast.renderFiltered({ kind: 'exclude', pattern: '^!' });
    expect(excluded).not.toContain('!\n');
    expect(excluded.split('\n')[0]).toBe('version 1.0');
    expect(ast.renderFiltered({ kind: 'begin', pattern: 'line con' })).toBe(
      'line con 0\n logging synchronous\n!\nend',
    );
    expect(ast.renderFiltered({ kind: 'begin', pattern: 'nomatch' })).toBe('');
  });

  it('falls back to a literal match for invalid regular expressions', () => {
    const ast = createConfigAst();
    ast.set([], ['hostname', 'R1(']);
    expect(ast.renderFiltered({ kind: 'include', pattern: 'R1(' })).toBe('hostname R1(');
  });
});

describe('diff', () => {
  it('reports added and removed lines from this to other', () => {
    const startup = router();
    const running = startup.clone();
    running.set([], ['hostname', 'Edge']);
    running.unset(ifaceContext('GigabitEthernet0/1'), ['shutdown']);
    running.set(ifaceContext('GigabitEthernet0/1'), ['ip', 'address', '10.0.1.1', '255.255.255.0']);
    running.unset([], ['ip', 'route', '192.168.1.0', '255.255.255.0', '10.0.0.2']);

    expect(startup.diff(running)).toEqual({
      added: ['hostname Edge', ' ip address 10.0.1.1 255.255.255.0'],
      removed: ['hostname R1', ' shutdown', 'ip route 192.168.1.0 255.255.255.0 10.0.0.2'],
    });
    expect(running.diff(startup)).toEqual({
      added: ['hostname R1', ' shutdown', 'ip route 192.168.1.0 255.255.255.0 10.0.0.2'],
      removed: ['hostname Edge', ' ip address 10.0.1.1 255.255.255.0'],
    });
    expect(startup.diff(startup.clone())).toEqual({ added: [], removed: [] });
  });

  it('distinguishes identical child lines under different sections', () => {
    const a = createConfigAst();
    a.set([], ['interface', 'GigabitEthernet0/0']);
    a.set([], ['interface', 'GigabitEthernet0/1']);
    a.set(ifaceContext('GigabitEthernet0/0'), ['shutdown']);
    const b = a.clone();
    b.unset(ifaceContext('GigabitEthernet0/0'), ['shutdown']);
    b.set(ifaceContext('GigabitEthernet0/1'), ['shutdown']);
    expect(a.diff(b)).toEqual({ added: [' shutdown'], removed: [' shutdown'] });
  });
});
