/**
 * ConfigAst P0.5 (ARCHITECTURE-P1 §3.12, §6, §8.1 W1 cli): section storage (the `ip dhcp pool`
 * round-trip), stored negation (`no switchport`, `no keepalive`), rule-driven identity, render slots,
 * dotted queries over section args, replay lines and `diffTree`.
 */
import { describe, expect, it } from 'vitest';
import { ifaceContext } from '../src/contracts/config.js';
import type { ConfigAst, ConfigTreeChange } from '../src/contracts/config.js';
import { applyConfigChange, createConfigAst, parseConfigText } from '../src/cli/config-ast.js';
import { configTextLinesOf } from '../src/cli/config-text.js';

const GI0 = ifaceContext('GigabitEthernet0/0');
const GI1 = ifaceContext('GigabitEthernet0/1');
const POOL_LAN = [['ip', 'dhcp', 'pool', 'LAN']];

function dhcpRouter(): ConfigAst {
  const ast = createConfigAst();
  ast.set([], ['hostname', 'R1']);
  ast.set([], ['interface', 'GigabitEthernet0/0']);
  ast.set(GI0, ['ip', 'address', '192.168.1.1', '255.255.255.0']);
  ast.set([], ['ip', 'dhcp', 'excluded-address', '192.168.1.1', '192.168.1.10']);
  ast.set([], ['ip', 'dhcp', 'pool', 'LAN']);
  ast.set(POOL_LAN, ['default-router', '192.168.1.1']);
  ast.set(POOL_LAN, ['network', '192.168.1.0', '255.255.255.0']);
  ast.set(POOL_LAN, ['dns-server', '192.168.1.10']);
  ast.set([], ['ip', 'route', '0.0.0.0', '0.0.0.0', '192.168.1.254']);
  return ast;
}

const DHCP_TEXT = [
  '! NetForge NFOS configuration',
  'version 1.0',
  '!',
  'hostname R1',
  '!',
  'ip dhcp excluded-address 192.168.1.1 192.168.1.10',
  '!',
  'ip dhcp pool LAN',
  ' network 192.168.1.0 255.255.255.0',
  ' default-router 192.168.1.1',
  ' dns-server 192.168.1.10',
  '!',
  'interface GigabitEthernet0/0',
  ' ip address 192.168.1.1 255.255.255.0',
  '!',
  'ip route 0.0.0.0 0.0.0.0 192.168.1.254',
  '!',
  'end',
  '',
].join('\n');

/** Apply changes in order to a copy of `from`. */
function applied(from: ConfigAst, changes: readonly ConfigTreeChange[]): ConfigAst {
  const work = from.clone();
  for (const c of changes) applyConfigChange(work, c);
  return work;
}

describe('ip dhcp pool sections', () => {
  it('stores the pool as one full-token section node and renders it once with its children', () => {
    const ast = dhcpRouter();
    expect(ast.render()).toBe(DHCP_TEXT);
    const pools = ast.root.children.filter((c) => c.key === 'ip' && c.args[0] === 'dhcp' && c.args[1] === 'pool');
    expect(pools).toHaveLength(1);
    expect(pools[0]?.args).toEqual(['dhcp', 'pool', 'LAN']);
    expect(pools[0]?.children.map((c) => c.key)).toEqual(['default-router', 'network', 'dns-server']);
    expect(ast.render().split('\n').filter((l) => l === 'ip dhcp pool LAN')).toHaveLength(1);
  });

  it('round-trips through text byte for byte and at the tree level', () => {
    const parsed = parseConfigText(DHCP_TEXT);
    expect(parsed.render()).toBe(DHCP_TEXT);
    expect(parseConfigText(parsed.render()).toJSON()).toEqual(parsed.toJSON());
    expect(parsed.get('ip.dhcp.pool.LAN.network')).toEqual(['192.168.1.0', '255.255.255.0']);
    expect(parsed.get('ip.dhcp.pool.LAN.default-router')).toEqual(['192.168.1.1']);
    expect(parsed.query('ip.dhcp.pool')).toHaveLength(1);
    expect(parsed.get('interface.GigabitEthernet0/0.ip.address')).toEqual(['192.168.1.1', '255.255.255.0']);
  });

  it('keeps exclusions and pools apart: identity is three tokens for excluded-address', () => {
    const ast = dhcpRouter();
    ast.set([], ['ip', 'dhcp', 'excluded-address', '192.168.1.200']);
    expect(ast.query('ip.dhcp').filter((n) => n.args[0] === 'excluded-address')).toHaveLength(2);

    const d = ast.unset([], ['ip', 'dhcp', 'excluded-address']);
    expect(d?.before).toEqual(['192.168.1.1', '192.168.1.10']);
    expect(ast.render()).not.toContain('excluded-address');
    expect(ast.get('ip.dhcp.pool.LAN.network')).toEqual(['192.168.1.0', '255.255.255.0']);

    expect(ast.set([], ['ip', 'dhcp', 'pool', 'LAN'])).toBeUndefined();
    const removed = ast.unset([], ['ip', 'dhcp', 'pool', 'LAN']);
    expect(removed).toEqual({ op: 'unset', context: [], line: ['ip', 'dhcp', 'pool', 'LAN'], before: [] });
    expect(ast.render()).not.toContain('network');
    expect(ast.unset([], ['ip', 'dhcp', 'pool', 'LAN'])).toBeUndefined();
  });

  it('replaces single-valued pool lines with before', () => {
    const ast = dhcpRouter();
    const d = ast.set(POOL_LAN, ['default-router', '192.168.1.254']);
    expect(d).toEqual({ op: 'set', context: POOL_LAN, line: ['default-router', '192.168.1.254'], before: ['192.168.1.1'] });
    expect(ast.query('ip.dhcp.pool.LAN.default-router')).toHaveLength(1);
  });

  it('replays the pool children under the pool context', () => {
    const lines = configTextLinesOf(parseConfigText(DHCP_TEXT).root);
    const pool = lines.filter((l) => l.context.length === 1 && l.context[0]?.[0] === 'ip');
    expect(pool.map((l) => l.tokens)).toEqual([
      ['network', '192.168.1.0', '255.255.255.0'],
      ['default-router', '192.168.1.1'],
      ['dns-server', '192.168.1.10'],
    ]);
    expect(pool.every((l) => l.context[0]?.join(' ') === 'ip dhcp pool LAN')).toBe(true);
  });
});

describe('stored negation', () => {
  it('no switchport persists in the interface section and survives save/reload', () => {
    const ast = createConfigAst();
    ast.set([], ['interface', 'GigabitEthernet1/0/24']);
    const ctx = ifaceContext('GigabitEthernet1/0/24');
    expect(ast.unset(ctx, ['switchport'])).toEqual({ op: 'unset', context: ctx, line: ['switchport'] });
    expect(ast.unset(ctx, ['switchport'])).toBeUndefined();
    ast.set(ctx, ['ip', 'address', '10.1.1.1', '255.255.255.0']);
    ast.set(ctx, ['description', 'uplink']);

    const text = ast.render();
    expect(text).toContain(
      ['interface GigabitEthernet1/0/24', ' description uplink', ' no switchport', ' ip address 10.1.1.1 255.255.255.0', '!'].join('\n'),
    );
    const reloaded = parseConfigText(text);
    expect(reloaded.render()).toBe(text);
    expect(reloaded.query('interface.GigabitEthernet1/0/24.no')[0]?.args).toEqual(['switchport']);

    const replay = configTextLinesOf(reloaded.root);
    expect(replay).toContainEqual(expect.objectContaining({ context: [ctx[0]], tokens: ['switchport'], negate: true }));
  });

  it('switchport restores the default: the negation goes and nothing is stored', () => {
    const ast = createConfigAst();
    const ctx = ifaceContext('GigabitEthernet1/0/1');
    ast.set([], ['interface', 'GigabitEthernet1/0/1']);
    expect(ast.set(ctx, ['switchport'])).toBeUndefined();
    ast.unset(ctx, ['switchport']);
    expect(ast.set(ctx, ['switchport'])).toEqual({ op: 'set', context: ctx, line: ['switchport'] });
    expect(ast.query('interface.GigabitEthernet1/0/1')[0]?.children).toEqual([]);
  });

  it('keepalive values and no keepalive exclude each other', () => {
    const ast = createConfigAst();
    ast.set([], ['interface', 'Serial0/0/0']);
    const ctx = ifaceContext('Serial0/0/0');
    ast.set(ctx, ['keepalive', '5']);
    const off = ast.unset(ctx, ['keepalive']);
    expect(off?.before).toEqual(['5']);
    expect(ast.render()).toContain('interface Serial0/0/0\n no keepalive\n!');

    expect(ast.set(ctx, ['keepalive', '10'])).toEqual({ op: 'set', context: ctx, line: ['keepalive', '10'] });
    expect(ast.render()).toContain('interface Serial0/0/0\n keepalive 10\n!');

    // exact removal of a value returns to the default without storing a negation
    expect(ast.unset(ctx, ['keepalive', '10'])?.before).toEqual(['10']);
    expect(ast.query('interface.Serial0/0/0')[0]?.children).toEqual([]);
  });

  it('still drops a sub-mode no line for rules without storeNegation (P0 pin)', () => {
    const ast = parseConfigText(['interface GigabitEthernet0/0', ' no shutdown', ' no description', 'line con 0', ' no logging synchronous'].join('\n'));
    expect(ast.query('interface.GigabitEthernet0/0')[0]?.children).toEqual([]);
    expect(ast.query('line.con')[0]?.children).toEqual([]);
  });
});

describe('rule-driven identity and render slots', () => {
  it('places global lines by slot and orders interface children canonically', () => {
    const ast = createConfigAst();
    ast.set([], ['ipv6', 'route', '::/0', '2001:db8::1']);
    ast.set([], ['interface', 'Serial0/0/0']);
    ast.set(ifaceContext('Serial0/0/0'), ['keepalive', '20']);
    ast.set(ifaceContext('Serial0/0/0'), ['clock', 'rate', '64000']);
    ast.set(ifaceContext('Serial0/0/0'), ['ip', 'address', '10.0.0.1', '255.255.255.252']);
    ast.set(ifaceContext('Serial0/0/0'), ['encapsulation', 'hdlc']);
    ast.set([], ['ipv6', 'unicast-routing']);
    ast.set([], ['ip', 'http', 'server']);
    ast.set([], ['ip', 'name-server', '10.0.0.10']);
    ast.set([], ['service', 'password-encryption']);
    ast.set([], ['hostname', 'R1']);
    expect(ast.render()).toBe(
      [
        '! NetForge NFOS configuration',
        'version 1.0',
        '!',
        'service password-encryption',
        '!',
        'hostname R1',
        '!',
        'ip name-server 10.0.0.10',
        '!',
        'ipv6 unicast-routing',
        '!',
        'interface Serial0/0/0',
        ' encapsulation hdlc',
        ' clock rate 64000',
        ' keepalive 20',
        ' ip address 10.0.0.1 255.255.255.252',
        '!',
        'ip http server',
        '!',
        'ipv6 route ::/0 2001:db8::1',
        '!',
        'end',
        '',
      ].join('\n'),
    );
    expect(parseConfigText(ast.render()).render()).toBe(ast.render());
  });

  it('single-valued multi-token identities replace, free text folds, secrets stay one value', () => {
    const ast = createConfigAst();
    ast.set([], ['interface', 'Wlan0']);
    const wl = ifaceContext('Wlan0');
    ast.set(wl, ['ssid', 'Lab', 'Net']);
    expect(ast.get('interface.Wlan0.ssid')).toEqual(['Lab Net']);
    expect(ast.set(wl, ['ssid', 'Lab Net'])).toBeUndefined();
    expect(ast.set(wl, ['passphrase', 'correct', 'horse'])?.line).toEqual(['passphrase', 'correct horse']);
    expect(ast.set(wl, ['clock', 'rate', '64000'])).toBeDefined();
    expect(ast.set(wl, ['clock', 'rate', '128000'])?.before).toEqual(['64000']);
    expect(ast.set([], ['ip', 'host', 'www.lab.nf', '192.168.1.80'])).toBeDefined();
    expect(ast.set([], ['ip', 'host', 'mail.lab.nf', '192.168.1.25'])).toBeDefined();
    expect(ast.set([], ['ip', 'host', 'www.lab.nf', '192.168.1.81'])?.before).toEqual(['192.168.1.80']);
    expect(ast.query('ip.host')).toHaveLength(2);
  });

  it('a banner of another type is single-valued per type', () => {
    const ast = createConfigAst();
    ast.set([], ['banner', 'motd', 'Hello']);
    ast.set([], ['banner', 'login', '^CAuthorized only^C']);
    expect(ast.set([], ['banner', 'login', 'Staff', 'only'])?.before).toEqual(['Authorized only']);
    expect(ast.query('banner')).toHaveLength(2);
  });

  it('interface sections replay an implied no shutdown only when shutdown is absent', () => {
    const ast = createConfigAst();
    ast.set([], ['interface', 'GigabitEthernet0/0']);
    ast.set([], ['interface', 'GigabitEthernet0/1']);
    ast.set(GI1, ['shutdown']);
    const lines = configTextLinesOf(ast.root).map((l) => `${l.negate ? 'no ' : ''}${l.tokens.join(' ')}@${l.context.length}`);
    expect(lines).toEqual(['interface GigabitEthernet0/0@0', 'no shutdown@1', 'interface GigabitEthernet0/1@0', 'shutdown@1']);
  });
});

describe('diffTree', () => {
  function edited(): ConfigAst {
    const ast = dhcpRouter().clone();
    ast.set([], ['hostname', 'Edge']);
    ast.set([], ['ip', 'route', '10.0.0.0', '255.0.0.0', '192.168.1.2']);
    ast.unset([], ['ip', 'route', '0.0.0.0', '0.0.0.0', '192.168.1.254']);
    ast.set(GI0, ['ip', 'address', '192.168.1.2', '255.255.255.0']);
    ast.unset(GI0, ['switchport']);
    ast.set([], ['interface', 'GigabitEthernet0/1']);
    ast.set(GI1, ['shutdown']);
    ast.unset(POOL_LAN, ['dns-server']);
    ast.set([], ['ip', 'dhcp', 'pool', 'GUEST']);
    ast.set([['ip', 'dhcp', 'pool', 'GUEST']], ['network', '10.9.0.0', '255.255.255.0']);
    ast.set([], ['no', 'ip', 'domain-lookup']);
    return ast;
  }

  it('returns no changes for equal trees', () => {
    expect(dhcpRouter().diffTree(dhcpRouter())).toEqual([]);
  });

  it('turns one tree into the other in both directions (text and tree exact)', () => {
    const before = dhcpRouter();
    const after = edited();
    const forward = before.diffTree(after);
    expect(applied(before, forward).render()).toBe(after.render());
    expect(applied(before, forward).toJSON()).toEqual(after.toJSON());

    const revert = after.diffTree(before);
    expect(applied(after, revert).render()).toBe(before.render());
    expect(applied(after, revert).toJSON()).toEqual(before.toJSON());
  });

  it('replaces single-valued lines in place with one set and carries contexts', () => {
    const forward = dhcpRouter().diffTree(edited());
    expect(forward).toContainEqual({ op: 'set', context: [], line: ['hostname', 'Edge'] });
    expect(forward).toContainEqual({ op: 'set', context: GI0, line: ['ip', 'address', '192.168.1.2', '255.255.255.0'] });
    expect(forward.some((c) => c.op === 'unset' && c.line[0] === 'hostname')).toBe(false);
    expect(forward).toContainEqual({ op: 'unset', context: GI0, line: ['switchport'] });
    expect(forward).toContainEqual({ op: 'unset', context: POOL_LAN, line: ['dns-server', '192.168.1.10'] });

    const revert = edited().diffTree(dhcpRouter());
    expect(revert).toContainEqual({ op: 'set', context: GI0, line: ['switchport'] });
    expect(revert).toContainEqual({ op: 'unset', context: [], line: ['ip', 'dhcp', 'pool', 'GUEST'] });
    expect(revert).toContainEqual({ op: 'unset', context: [], line: ['no', 'ip', 'domain-lookup'] });
  });

  it('keeps multi-valued order exact when a middle entry is removed or re-added', () => {
    const three = createConfigAst();
    for (const n of ['1', '2', '3']) three.set([], ['ip', 'route', `10.${n}.0.0`, '255.255.0.0', '192.0.2.1']);
    const two = three.clone();
    two.unset([], ['ip', 'route', '10.2.0.0', '255.255.0.0', '192.0.2.1']);
    expect(applied(two, two.diffTree(three)).toJSON()).toEqual(three.toJSON());
    expect(applied(three, three.diffTree(two)).toJSON()).toEqual(two.toJSON());
    expect(three.diffTree(two)).toEqual([{ op: 'unset', context: [], line: ['ip', 'route', '10.2.0.0', '255.255.0.0', '192.0.2.1'] }]);
  });

  it('reorders sections by removing and re-adding the tail', () => {
    const a = createConfigAst();
    a.set([], ['interface', 'Loopback0']);
    a.set([['interface', 'Loopback0']], ['ip', 'address', '1.1.1.1', '255.255.255.255']);
    a.set([], ['interface', 'Loopback1']);
    const b = createConfigAst();
    b.set([], ['interface', 'Loopback1']);
    b.set([], ['interface', 'Loopback0']);
    b.set([['interface', 'Loopback0']], ['ip', 'address', '1.1.1.1', '255.255.255.255']);
    expect(applied(a, a.diffTree(b)).toJSON()).toEqual(b.toJSON());
    expect(applied(b, b.diffTree(a)).toJSON()).toEqual(a.toJSON());
  });
});
