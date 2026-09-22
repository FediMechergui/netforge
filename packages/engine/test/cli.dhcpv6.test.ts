/**
 * cli/grammar/dhcpv6.ts and cli/handlers/dhcpv6.ts (ARCHITECTURE-P2 §3.11, §5.2, §5.4, D16; §7 W3 cli): the
 * `ipv6 dhcp pool` section (mode `config-dhcpv6`) and its lines, the interface lines (server, RA flags, client), and
 * `show ipv6 dhcp pool|binding|interface` against a fake `dhcpv6-bindings` table and leased port addresses.
 */
import { describe, expect, it } from 'vitest';
import type { CommandHandler, CommandOutcome } from '../src/contracts/cli.js';
import type { Dhcpv6BindingRow, Table, TableRow } from '../src/contracts/tables.js';
import { createTable } from '../src/core/table.js';
import { BUILTIN_GRAMMAR, P2_HANDLERS } from '../src/cli/grammar/index.js';
import { HANDLER_REGISTRY } from '../src/cli/handlers/index.js';
import {
  dhcpv6Pools,
  MSG_BAD_LIFETIME,
  MSG_BAD_PREFIX6,
  MSG_NO_BINDING6,
  MSG_NO_DHCPV6_INTERFACE,
  MSG_NO_POOL6,
  MSG_NO_POOL6_SELECTED,
  MSG_POOL6_MISSING,
} from '../src/cli/handlers/dhcpv6.js';
import { modeForContext } from '../src/cli/modes.js';
import { help, matchCommand } from '../src/cli/parser.js';
import { catalogModel, commandCtxFor, devicePortViews, matchContextFor, type CommandCtxOptions, type RecordingCtx } from './cli.p05.fixture.js';
import { p2Model } from './cli.p2.fixture.js';

const ROUTER = p2Model('router.nf2911');
const GI0 = 'GigabitEthernet0/0';
const GI1 = 'GigabitEthernet0/1';
const POOL = [['ipv6', 'dhcp', 'pool', 'LAB6']];
const SEC = 1_000_000_000;

function handler(id: string): CommandHandler {
  const h = HANDLER_REGISTRY[id];
  if (h === undefined) throw new Error(`no handler ${id}`);
  return h;
}

function run(rec: RecordingCtx, id: string, args: Record<string, string> = {}, negate = false): CommandOutcome {
  return handler(id)(rec.ctx, args, negate);
}

function router(opts: CommandCtxOptions = {}): RecordingCtx {
  return commandCtxFor(ROUTER, opts);
}

function attach<R extends TableRow>(rec: RecordingCtx, name: string): Table<R> {
  const t = createTable<R>({ name, device: 'd_1', sink: { emit: () => undefined }, now: () => 0 });
  rec.extra.set(name, t as unknown as Table<TableRow>);
  return t;
}

const lines = (s: string | undefined): string[] => (s ?? '').split('\n');

describe('parsing and modes', () => {
  it('parses the pool section, its lines, the interface lines and the show commands', () => {
    const cfg = matchContextFor(ROUTER, 'config');
    expect(matchCommand(BUILTIN_GRAMMAR, cfg, 'ipv6 dhcp pool LAB6')).toMatchObject({ ok: true, spec: { handler: P2_HANDLERS.configIpv6DhcpPool, entersMode: 'config-dhcpv6' }, args: { name: 'LAB6' } });
    const pool = matchContextFor(ROUTER, 'config-dhcpv6');
    expect(matchCommand(BUILTIN_GRAMMAR, pool, 'address prefix 2001:db8:1::/64')).toMatchObject({ ok: true, spec: { handler: P2_HANDLERS.pool6AddressPrefix }, args: { prefix: '2001:db8:1::/64' } });
    expect(matchCommand(BUILTIN_GRAMMAR, pool, 'address prefix 2001:db8:1::/64 lifetime 86400 3600')).toMatchObject({ ok: true, args: { valid: '86400', preferred: '3600' } });
    expect(matchCommand(BUILTIN_GRAMMAR, pool, 'address prefix 2001:db8:1::/64 lifetime infinite infinite')).toMatchObject({ ok: true, args: { valid: 'infinite', preferred: 'infinite' } });
    expect(matchCommand(BUILTIN_GRAMMAR, pool, 'address prefix 2001:db8:1::/64 lifetime forever 1').ok).toBe(false);
    expect(matchCommand(BUILTIN_GRAMMAR, pool, 'dns-server 2001:db8:1::53')).toMatchObject({ ok: true, spec: { handler: P2_HANDLERS.pool6DnsServer } });
    expect(matchCommand(BUILTIN_GRAMMAR, pool, 'domain-name lab.nf')).toMatchObject({ ok: true, spec: { handler: P2_HANDLERS.pool6DomainName } });
    expect(help(BUILTIN_GRAMMAR, pool, '').items.map((i) => i.token)).toEqual(['address', 'dns-server', 'do', 'domain-name', 'end', 'exit', 'no']);
    const ifc = matchContextFor(ROUTER, 'config-if', { iface: GI0 });
    expect(matchCommand(BUILTIN_GRAMMAR, ifc, 'ipv6 dhcp server LAB6')).toMatchObject({ ok: true, spec: { handler: P2_HANDLERS.ifIpv6DhcpServer } });
    expect(matchCommand(BUILTIN_GRAMMAR, ifc, 'ipv6 nd managed-config-flag')).toMatchObject({ ok: true, spec: { handler: P2_HANDLERS.ifIpv6NdManagedFlag } });
    expect(matchCommand(BUILTIN_GRAMMAR, ifc, 'ipv6 nd other-config-flag')).toMatchObject({ ok: true, spec: { handler: P2_HANDLERS.ifIpv6NdOtherFlag } });
    expect(matchCommand(BUILTIN_GRAMMAR, ifc, 'ipv6 address dhcp')).toMatchObject({ ok: true, spec: { handler: P2_HANDLERS.ifIpv6AddressDhcp } });
    // the P1 address line still wins for a real prefix
    expect(matchCommand(BUILTIN_GRAMMAR, ifc, 'ipv6 address 2001:db8::1/64')).toMatchObject({ ok: true, spec: { handler: 'if.ipv6-address' } });
    // [S8] relay is not built
    expect(matchCommand(BUILTIN_GRAMMAR, ifc, 'ipv6 dhcp relay destination 2001:db8:9::5').ok).toBe(false);
    const exec = matchContextFor(ROUTER, 'user-exec');
    for (const [word, id] of [['pool', P2_HANDLERS.showIpv6DhcpPool], ['binding', P2_HANDLERS.showIpv6DhcpBinding], ['interface', P2_HANDLERS.showIpv6DhcpInterface]] as const) {
      expect(matchCommand(BUILTIN_GRAMMAR, exec, `show ipv6 dhcp ${word}`), word).toMatchObject({ ok: true, spec: { handler: id } });
    }
    // the server lines need routing; the client line follows the ipv6 daemon (an L3 switch SVI can lease)
    expect(matchCommand(BUILTIN_GRAMMAR, matchContextFor(catalogModel('pc.nfpc'), 'user-exec'), 'show ipv6 dhcp pool').ok).toBe(false);
    expect(matchCommand(BUILTIN_GRAMMAR, matchContextFor(p2Model('switch.nfc2960'), 'config'), 'ipv6 dhcp pool X').ok).toBe(false);
    expect(modeForContext([['ipv6', 'dhcp', 'pool', 'LAB6']])).toBe('config-dhcpv6');
  });
});

describe('the pool section', () => {
  it('enters the section, stores the canonical prefix and lifetimes, servers and domain, and validates', () => {
    const r = router();
    expect(run(r, P2_HANDLERS.configIpv6DhcpPool, { name: 'LAB6' })).toEqual({});
    expect(r.enterModeCalls).toEqual([{ mode: 'config-dhcpv6', opts: { context: POOL } }]);
    const inside = commandCtxFor(ROUTER, { mode: 'config-dhcpv6', context: POOL, running: r.running });
    expect(run(inside, P2_HANDLERS.pool6AddressPrefix, { prefix: '2001:DB8:1:0::/64' })).toEqual({});
    expect(r.running.render()).toContain('ipv6 dhcp pool LAB6\n address prefix 2001:db8:1::/64\n');
    expect(run(inside, P2_HANDLERS.pool6AddressPrefix, { prefix: '2001:db8:1::/64', valid: '86400', preferred: '3600' })).toEqual({});
    expect(r.running.render()).toContain(' address prefix 2001:db8:1::/64 lifetime 86400 3600');
    expect(run(inside, P2_HANDLERS.pool6AddressPrefix, { prefix: '2001:db8:1::/64', valid: '3600', preferred: '86400' }).error).toBe(MSG_BAD_LIFETIME);
    expect(run(inside, P2_HANDLERS.pool6AddressPrefix, { prefix: '2001:db8:1::/64', valid: 'infinite', preferred: '3600' })).toEqual({});
    expect(run(inside, P2_HANDLERS.pool6AddressPrefix, { prefix: 'nope' }).error).toBe(MSG_BAD_PREFIX6);
    expect(run(inside, P2_HANDLERS.pool6DnsServer, { address: '2001:DB8:1::53' })).toEqual({});
    expect(run(inside, P2_HANDLERS.pool6DnsServer, { address: '2001:db8:1::54' })).toEqual({});
    expect(run(inside, P2_HANDLERS.pool6DnsServer, { address: '10.0.0.1' }).error).toContain('IPv6');
    expect(run(inside, P2_HANDLERS.pool6DomainName, { name: 'lab.nf' })).toEqual({});
    expect(dhcpv6Pools(r.ctx)).toEqual([{ name: 'LAB6', prefix: '2001:db8:1::/64', validLifetime: 'infinite', preferredLifetime: '3600', dnsServers: ['2001:db8:1::53', '2001:db8:1::54'], domainName: 'lab.nf', interfaces: [] }]);
    expect(run(inside, P2_HANDLERS.pool6DnsServer, { address: '2001:db8:1::53' }, true)).toEqual({});
    expect(dhcpv6Pools(r.ctx)[0]?.dnsServers).toEqual(['2001:db8:1::54']);
    expect(run(inside, P2_HANDLERS.pool6AddressPrefix, {}, true)).toEqual({});
    expect(dhcpv6Pools(r.ctx)[0]?.prefix).toBeUndefined();
    for (const id of [P2_HANDLERS.pool6AddressPrefix, P2_HANDLERS.pool6DnsServer, P2_HANDLERS.pool6DomainName]) {
      expect(run(router(), id, { prefix: '2001:db8::/64', address: '2001:db8::1', name: 'x' }).error, id).toBe(MSG_NO_POOL6_SELECTED);
    }
    expect(run(r, P2_HANDLERS.configIpv6DhcpPool, { name: 'LAB6' }, true)).toEqual({});
    expect(dhcpv6Pools(r.ctx)).toEqual([]);
  });

  it('stores the interface lines, noting a pool that does not exist yet', () => {
    const r = router({ iface: GI0 });
    expect(run(r, P2_HANDLERS.ifIpv6DhcpServer, { pool: 'LAB6' })).toEqual({ output: MSG_POOL6_MISSING.replace('{pool}', 'LAB6') });
    r.running.set([], ['ipv6', 'dhcp', 'pool', 'LAB6']);
    expect(run(r, P2_HANDLERS.ifIpv6DhcpServer, { pool: 'LAB6' })).toEqual({});
    expect(run(r, P2_HANDLERS.ifIpv6NdManagedFlag)).toEqual({});
    expect(run(r, P2_HANDLERS.ifIpv6NdOtherFlag)).toEqual({});
    expect(run(r, P2_HANDLERS.ifIpv6AddressDhcp)).toEqual({});
    expect(r.running.render()).toContain(`interface ${GI0}\n ipv6 dhcp server LAB6\n ipv6 nd managed-config-flag\n ipv6 nd other-config-flag\n ipv6 address dhcp`);
    expect(run(r, P2_HANDLERS.ifIpv6NdOtherFlag, {}, true)).toEqual({});
    expect(run(r, P2_HANDLERS.ifIpv6DhcpServer, {}, true)).toEqual({});
    expect(r.running.render()).not.toContain('other-config-flag');
    expect(r.running.render()).not.toContain('dhcp server');
    expect(run(router(), P2_HANDLERS.ifIpv6DhcpServer, { pool: 'LAB6' }).error).toContain('interface');
  });
});

describe('show ipv6 dhcp', () => {
  function configured(): RecordingCtx {
    const ports = devicePortViews(ROUTER, { patch: { [GI1]: { l3: { ipv6: [{ address: '2001:db8:2::2', prefixLen: 128, scope: 'global', origin: 'dhcpv6', state: 'preferred', validUntil: 3600 * SEC }] } } } });
    const r = commandCtxFor(ROUTER, { ports });
    r.running.set([], ['ipv6', 'dhcp', 'pool', 'LAB6']);
    r.running.set(POOL, ['address', 'prefix', '2001:db8:1::/64', 'lifetime', '86400', '3600']);
    r.running.set(POOL, ['dns-server', '2001:db8:1::53']);
    r.running.set(POOL, ['domain-name', 'lab.nf']);
    r.running.set([], ['ipv6', 'dhcp', 'pool', 'STATELESS']);
    r.running.set([['ipv6', 'dhcp', 'pool', 'STATELESS']], ['dns-server', '2001:db8:1::53']);
    r.running.set([['interface', GI0]], ['ipv6', 'dhcp', 'server', 'LAB6']);
    r.running.set([['interface', GI0]], ['ipv6', 'nd', 'managed-config-flag']);
    r.running.set([['interface', GI1]], ['ipv6', 'address', 'dhcp']);
    return r;
  }

  it('pool describes every pool with its serving interfaces and active leases', () => {
    expect(run(router(), P2_HANDLERS.showIpv6DhcpPool)).toEqual({ output: MSG_NO_POOL6 });
    const r = configured();
    const t = attach<Dhcpv6BindingRow>(r, 'dhcpv6-bindings');
    t.set({ key: 'LAB6|2001:db8:1::2', updatedAt: 0, expiresAt: 86_400 * SEC, address: '2001:db8:1::2', duid: '00:03:00:01:02:00:00:00:00:01', iaid: 1, pool: 'LAB6', preferredUntil: 3600 * SEC });
    expect(lines(run(r, P2_HANDLERS.showIpv6DhcpPool).output)).toEqual([
      'Pool LAB6',
      '  Addresses from: 2001:db8:1::/64   valid 86400 s, preferred 3600 s',
      '  Name servers: 2001:db8:1::53',
      '  Domain name: lab.nf',
      `  Served on: ${GI0}`,
      '  Active leases: 1',
      '',
      'Pool STATELESS',
      '  Addresses: none (stateless: settings only)',
      '  Name servers: 2001:db8:1::53',
      '  Domain name: none',
      '  Served on: no interface',
      '  Active leases: 0',
    ]);
    const binding = lines(run(r, P2_HANDLERS.showIpv6DhcpBinding).output);
    expect(binding[0]).toMatch(/^Address\s+Client identifier\s+IAID\s+Pool\s+Preferred for\s+Valid for$/);
    expect(binding[1]).toMatch(/^2001:db8:1::2\s+00:03:00:01:02:00:00:00:00:01\s+1\s+LAB6\s+01:00:00\s+24:00:00$/);
    expect(run(router(), P2_HANDLERS.showIpv6DhcpBinding)).toEqual({ output: MSG_NO_BINDING6 });
  });

  it('interface lists the server, client and RA-flag roles', () => {
    expect(run(router(), P2_HANDLERS.showIpv6DhcpInterface)).toEqual({ output: MSG_NO_DHCPV6_INTERFACE });
    expect(lines(run(configured(), P2_HANDLERS.showIpv6DhcpInterface).output)).toEqual([
      GI0,
      '  Server: pool LAB6',
      '  Advertised flags: managed address (M)',
      '',
      GI1,
      '  Client: 2001:db8:2::2 (preferred, valid for 01:00:00)',
    ]);
  });
});
