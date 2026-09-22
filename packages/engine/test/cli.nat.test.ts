/**
 * cli/grammar/{nat,acl}.ts and their handlers (ARCHITECTURE-P2 §3.9, §5.2, §5.4, D14; §7 W3 cli): the NAT interface
 * sides, pools, dynamic and static rules, `show ip nat translations [verbose]` / `statistics` against a fake `nat`
 * table, `clear ip nat translation *`, the standard access lists (numbered and named, canonical entries, the
 * `config-std-nacl` mode) and `show access-lists`; and the §9.2 W3 expectation that `access-list` (and [S2]
 * `standby`) join the router's help lists, checked on the P2 table.
 */
import { describe, expect, it } from 'vitest';
import type { CommandHandler, CommandOutcome } from '../src/contracts/cli.js';
import type { NatRow, Table, TableRow } from '../src/contracts/tables.js';
import { createTable } from '../src/core/table.js';
import { readStandardAcls } from '../src/core/acl.js';
import { BUILTIN_GRAMMAR, P2_HANDLERS } from '../src/cli/grammar/index.js';
import { HANDLER_REGISTRY } from '../src/cli/handlers/index.js';
import { MSG_ACL_ENTRY, MSG_ACL_NUMBER, MSG_NO_ACL, MSG_NO_ACL_SELECTED } from '../src/cli/handlers/acl.js';
import {
  isAclReference,
  MSG_BAD_ACL_REF,
  MSG_NO_TRANSLATION,
  MSG_POOL_INCOMPLETE,
  MSG_POOL_RANGE_NETWORK,
  MSG_POOL_RANGE_ORDER,
  MSG_SOURCE_LIST_INCOMPLETE,
  MSG_STATIC_SAME,
  natPools,
  natSideOf,
} from '../src/cli/handlers/nat.js';
import { modeForContext } from '../src/cli/modes.js';
import { help, matchCommand } from '../src/cli/parser.js';
import { catalogModel, commandCtxFor, matchContextFor, type CommandCtxOptions, type RecordingCtx } from './cli.p05.fixture.js';
import { p2Model } from './cli.p2.fixture.js';

const ROUTER = p2Model('router.nf2911');
const GI0 = 'GigabitEthernet0/0';
const GI1 = 'GigabitEthernet0/1';
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
const tokens = (ctx: ReturnType<typeof matchContextFor>, partial: string): string[] => help(BUILTIN_GRAMMAR, ctx, partial).items.map((i) => i.token);

describe('parsing and scope', () => {
  it('parses every NAT and access-list form on a routing device and hides them elsewhere', () => {
    const ifc = matchContextFor(ROUTER, 'config-if', { iface: GI0 });
    expect(matchCommand(BUILTIN_GRAMMAR, ifc, 'ip nat inside')).toMatchObject({ ok: true, spec: { handler: P2_HANDLERS.ifIpNat }, args: { side: 'inside' } });
    expect(matchCommand(BUILTIN_GRAMMAR, ifc, 'no ip nat')).toMatchObject({ ok: true, negated: true });
    const cfg = matchContextFor(ROUTER, 'config');
    expect(matchCommand(BUILTIN_GRAMMAR, cfg, 'ip nat pool P 203.0.113.20 203.0.113.29 netmask 255.255.255.0')).toMatchObject({ ok: true, args: { form: 'netmask', name: 'P', start: '203.0.113.20', end: '203.0.113.29', mask: '255.255.255.0' } });
    expect(matchCommand(BUILTIN_GRAMMAR, cfg, 'ip nat pool P 203.0.113.20 203.0.113.29 prefix-length 24')).toMatchObject({ ok: true, args: { form: 'prefix-length', length: '24' } });
    expect(matchCommand(BUILTIN_GRAMMAR, cfg, 'no ip nat pool P')).toMatchObject({ ok: true, negated: true, args: { name: 'P' } });
    expect(matchCommand(BUILTIN_GRAMMAR, cfg, 'ip nat inside source list 1 pool P')).toMatchObject({ ok: true, args: { via: 'pool', acl: '1', pool: 'P' } });
    expect(matchCommand(BUILTIN_GRAMMAR, cfg, 'ip nat inside source list 1 pool P overload')).toMatchObject({ ok: true, args: { via: 'pool', acl: '1', pool: 'P', overload: 'overload' } });
    expect(matchCommand(BUILTIN_GRAMMAR, cfg, 'ip nat inside source list LAN interface gi0/1 overload')).toMatchObject({ ok: true, args: { via: 'interface', acl: 'LAN', iface: GI1 } });
    expect(matchCommand(BUILTIN_GRAMMAR, cfg, 'no ip nat inside source list 1')).toMatchObject({ ok: true, negated: true, args: { acl: '1' } });
    expect(matchCommand(BUILTIN_GRAMMAR, cfg, 'ip nat inside source static 192.168.1.10 203.0.113.5')).toMatchObject({ ok: true, spec: { handler: P2_HANDLERS.configIpNatStatic }, args: { local: '192.168.1.10', global: '203.0.113.5' } });
    expect(matchCommand(BUILTIN_GRAMMAR, cfg, 'access-list 1 permit 192.168.1.0 0.0.0.255')).toMatchObject({ ok: true, spec: { handler: P2_HANDLERS.configAccessList }, args: { form: 'address', number: '1', action: 'permit', address: '192.168.1.0', wildcard: '0.0.0.255' } });
    expect(matchCommand(BUILTIN_GRAMMAR, cfg, 'access-list 1 deny host 10.0.0.1')).toMatchObject({ ok: true, args: { form: 'host', action: 'deny', address: '10.0.0.1' } });
    expect(matchCommand(BUILTIN_GRAMMAR, cfg, 'access-list 1300 permit any')).toMatchObject({ ok: true, args: { form: 'any', number: '1300', action: 'permit' } });
    expect(matchCommand(BUILTIN_GRAMMAR, cfg, 'access-list 1 permit 10.0.0.1')).toMatchObject({ ok: true, args: { form: 'address', address: '10.0.0.1' } });
    expect(matchCommand(BUILTIN_GRAMMAR, cfg, 'no access-list 1')).toMatchObject({ ok: true, negated: true, args: { number: '1' } });
    expect(matchCommand(BUILTIN_GRAMMAR, cfg, 'ip access-list standard LAN')).toMatchObject({ ok: true, spec: { handler: P2_HANDLERS.configIpAccessListStandard, entersMode: 'config-std-nacl' } });
    const nacl = matchContextFor(ROUTER, 'config-std-nacl');
    expect(matchCommand(BUILTIN_GRAMMAR, nacl, 'permit 10.0.0.0 0.0.0.255')).toMatchObject({ ok: true, spec: { handler: P2_HANDLERS.naclEntry }, args: { action: 'permit', form: 'address' } });
    expect(matchCommand(BUILTIN_GRAMMAR, nacl, 'deny any')).toMatchObject({ ok: true, args: { action: 'deny', form: 'any' } });
    expect(matchCommand(BUILTIN_GRAMMAR, nacl, 'permit host 10.0.0.1')).toMatchObject({ ok: true, args: { action: 'permit', form: 'host', address: '10.0.0.1' } });
    expect(tokens(nacl, '')).toEqual(['deny', 'do', 'end', 'exit', 'no', 'permit']);
    const exec = matchContextFor(ROUTER, 'user-exec');
    expect(matchCommand(BUILTIN_GRAMMAR, exec, 'show ip nat translations')).toMatchObject({ ok: true, spec: { handler: P2_HANDLERS.showIpNatTranslations }, args: {} });
    expect(matchCommand(BUILTIN_GRAMMAR, exec, 'show ip nat translations verbose')).toMatchObject({ ok: true, args: { verbose: 'verbose' } });
    expect(matchCommand(BUILTIN_GRAMMAR, exec, 'show ip nat statistics')).toMatchObject({ ok: true, spec: { handler: P2_HANDLERS.showIpNatStatistics } });
    expect(matchCommand(BUILTIN_GRAMMAR, exec, 'show access-lists')).toMatchObject({ ok: true, spec: { handler: P2_HANDLERS.showAccessLists } });
    expect(matchCommand(BUILTIN_GRAMMAR, matchContextFor(ROUTER, 'priv-exec'), 'clear ip nat translation *')).toMatchObject({ ok: true, spec: { handler: P2_HANDLERS.execClearIpNat } });
    // not on a switch, and not on the P1 router before the flip's grammar fold either
    expect(matchCommand(BUILTIN_GRAMMAR, matchContextFor(p2Model('switch.nfc2960'), 'config'), 'access-list 1 permit any').ok).toBe(false);
    expect(matchCommand(BUILTIN_GRAMMAR, matchContextFor(catalogModel('pc.nfpc'), 'user-exec'), 'show ip nat translations').ok).toBe(false);
    // the modes W3 entered are reachable (§9.2 W2 item 12b, W3 part)
    expect(modeForContext([['ip', 'access-list', 'standard', 'LAN']])).toBe('config-std-nacl');
  });

  it('adds access-list and standby to the P2 router help lists (§9.2 item 12, on the P2 table)', () => {
    const cfg = tokens(matchContextFor(ROUTER, 'config'), '');
    expect(cfg).toContain('access-list');
    expect(cfg).toEqual([...cfg].sort());
    expect(cfg.filter((t) => ['banner', 'do', 'enable', 'end', 'exit', 'hostname', 'interface', 'ip', 'ipv6', 'line', 'no', 'service', 'username'].includes(t)))
      .toEqual(['banner', 'do', 'enable', 'end', 'exit', 'hostname', 'interface', 'ip', 'ipv6', 'line', 'no', 'service', 'username']);
    const ifc = tokens(matchContextFor(ROUTER, 'config-if', { iface: GI0 }), '');
    expect(ifc).toContain('standby');
    expect(tokens(matchContextFor(ROUTER, 'config'), 'ip nat ')).toEqual(['inside', 'pool', 'translation']);
    expect(tokens(matchContextFor(ROUTER, 'priv-exec'), 'show ip nat ')).toEqual(['statistics', 'translations']);
  });
});

describe('NAT configuration lines', () => {
  it('stores the interface side, and no ip nat clears it', () => {
    const r = router({ iface: GI0 });
    expect(run(r, P2_HANDLERS.ifIpNat, { side: 'inside' })).toEqual({});
    expect(natSideOf(r.ctx, GI0)).toBe('inside');
    expect(run(r, P2_HANDLERS.ifIpNat, { side: 'outside' })).toEqual({});
    expect(natSideOf(r.ctx, GI0)).toBe('outside');
    expect(r.running.render()).not.toContain('ip nat inside');
    expect(run(r, P2_HANDLERS.ifIpNat, {}, true)).toEqual({});
    expect(natSideOf(r.ctx, GI0)).toBeUndefined();
    expect(run(r, P2_HANDLERS.ifIpNat, { side: 'sideways' }).error).toContain('inside or outside');
  });

  it('validates a pool and stores it in both mask forms; no ip nat pool <name> removes it', () => {
    const r = router();
    expect(run(r, P2_HANDLERS.configIpNatPool, { name: 'P', start: '203.0.113.20', end: '203.0.113.29', form: 'netmask', mask: '255.255.255.0' })).toEqual({});
    expect(r.running.render()).toContain('ip nat pool P 203.0.113.20 203.0.113.29 netmask 255.255.255.0');
    expect(run(r, P2_HANDLERS.configIpNatPool, { name: 'Q', start: '10.0.0.1', end: '10.0.0.9', form: 'prefix-length', length: '24' })).toEqual({});
    expect(r.running.render()).toContain('ip nat pool Q 10.0.0.1 10.0.0.9 prefix-length 24');
    expect(natPools(r.ctx)).toEqual([
      { name: 'P', start: '203.0.113.20', end: '203.0.113.29', mask: '255.255.255.0', size: 10 },
      { name: 'Q', start: '10.0.0.1', end: '10.0.0.9', mask: '255.255.255.0', size: 9 },
    ]);
    expect(run(r, P2_HANDLERS.configIpNatPool, { name: 'X', start: '10.0.0.9', end: '10.0.0.1', form: 'netmask', mask: '255.255.255.0' }).error).toBe(MSG_POOL_RANGE_ORDER);
    expect(run(r, P2_HANDLERS.configIpNatPool, { name: 'X', start: '10.0.0.1', end: '10.0.1.1', form: 'netmask', mask: '255.255.255.0' }).error).toBe(MSG_POOL_RANGE_NETWORK);
    expect(run(r, P2_HANDLERS.configIpNatPool, { name: 'X', start: '10.0.0.1', end: '10.0.0.9', form: 'netmask', mask: '255.0.255.0' }).error).toContain('contiguous');
    expect(run(r, P2_HANDLERS.configIpNatPool, { name: 'X' }).error).toBe(MSG_POOL_INCOMPLETE);
    expect(run(r, P2_HANDLERS.configIpNatPool, { name: 'P' }, true)).toEqual({});
    expect(natPools(r.ctx).map((p) => p.name)).toEqual(['Q']);
  });

  it('stores the dynamic rules with the canonical interface name and the static line, with their no forms', () => {
    const r = router();
    expect(run(r, P2_HANDLERS.configIpNatSourceList, { acl: '1', via: 'pool', pool: 'P' })).toEqual({});
    expect(r.running.render()).toContain('ip nat inside source list 1 pool P\n');
    expect(run(r, P2_HANDLERS.configIpNatSourceList, { acl: '1', via: 'pool', pool: 'P', overload: 'overload' })).toEqual({});
    expect(r.running.render()).toContain('ip nat inside source list 1 pool P overload');
    expect(r.running.render()).not.toContain('pool P\n');
    expect(run(r, P2_HANDLERS.configIpNatSourceList, { acl: 'LAN', via: 'interface', iface: 'gi0/1' })).toEqual({});
    expect(r.running.render()).toContain(`ip nat inside source list LAN interface ${GI1} overload`);
    expect(run(r, P2_HANDLERS.configIpNatSourceList, { acl: '100', via: 'pool', pool: 'P' }).error).toBe(MSG_BAD_ACL_REF);
    expect(run(r, P2_HANDLERS.configIpNatSourceList, { acl: '1', via: 'interface', iface: 'nope' }).error).toContain('nope');
    expect(run(r, P2_HANDLERS.configIpNatSourceList, { acl: '2' }).error).toBe(MSG_SOURCE_LIST_INCOMPLETE);
    expect(isAclReference('99')).toBe(true);
    expect(isAclReference('100')).toBe(false);
    expect(isAclReference('1999')).toBe(true);
    expect(isAclReference('LAN-users')).toBe(true);
    expect(run(r, P2_HANDLERS.configIpNatStatic, { local: '192.168.1.10', global: '203.0.113.5' })).toEqual({});
    expect(run(r, P2_HANDLERS.configIpNatStatic, { local: '192.168.1.11', global: '203.0.113.6' })).toEqual({});
    expect(run(r, P2_HANDLERS.configIpNatStatic, { local: '192.168.1.11', global: '192.168.1.11' }).error).toBe(MSG_STATIC_SAME);
    expect(r.running.render()).toContain('ip nat inside source static 192.168.1.10 203.0.113.5\nip nat inside source static 192.168.1.11 203.0.113.6');
    expect(run(r, P2_HANDLERS.configIpNatStatic, { local: '192.168.1.10', global: '203.0.113.5' }, true)).toEqual({});
    expect(r.running.render()).not.toContain('192.168.1.10 203.0.113.5');
    expect(r.running.render()).toContain('192.168.1.11 203.0.113.6');
    expect(run(r, P2_HANDLERS.configIpNatSourceList, { acl: '1' }, true)).toEqual({});
    expect(r.running.render()).not.toContain('list 1 ');
    expect(r.running.render()).toContain('list LAN interface');
  });
});

describe('show ip nat and clear', () => {
  function translating(): RecordingCtx {
    const r = router();
    r.running.set([['interface', GI0]], ['ip', 'nat', 'inside']);
    r.running.set([['interface', GI1]], ['ip', 'nat', 'outside']);
    r.running.set([], ['ip', 'nat', 'pool', 'P', '203.0.113.20', '203.0.113.29', 'netmask', '255.255.255.0']);
    r.running.set([], ['ip', 'nat', 'inside', 'source', 'list', '1', 'pool', 'P']);
    r.running.set([], ['ip', 'nat', 'inside', 'source', 'list', '2', 'interface', GI1, 'overload']);
    r.running.set([], ['ip', 'nat', 'inside', 'source', 'static', '192.168.1.10', '203.0.113.5']);
    const t = attach<NatRow>(r, 'nat');
    t.set({ key: 'any|203.0.113.5|*', updatedAt: 0, proto: 'any', insideLocal: '192.168.1.10', insideGlobal: '203.0.113.5', kind: 'static', rule: 'ip nat inside source static 192.168.1.10 203.0.113.5' });
    t.set({ key: 'any|203.0.113.20|*', updatedAt: 0, expiresAt: 86_400 * SEC, proto: 'any', insideLocal: '192.168.1.12', insideGlobal: '203.0.113.20', kind: 'dynamic', rule: 'ip nat inside source list 1 pool P' });
    t.set({
      key: 'icmp|203.0.113.1|2', updatedAt: 0, expiresAt: 60 * SEC, proto: 'icmp', insideLocal: '192.168.1.11', insideLocalPort: 1, insideGlobal: '203.0.113.1', insideGlobalPort: 2,
      outsideLocal: '203.0.113.10', outsideLocalPort: 2, outsideGlobal: '203.0.113.10', outsideGlobalPort: 2, kind: 'overload', rule: `ip nat inside source list 2 interface ${GI1} overload`,
    });
    return r;
  }

  it('lists the translations, verbose adds kind, lifetime and rule', () => {
    expect(run(router(), P2_HANDLERS.showIpNatTranslations)).toEqual({ output: MSG_NO_TRANSLATION });
    const r = translating();
    const out = lines(run(r, P2_HANDLERS.showIpNatTranslations).output);
    expect(out[0]).toMatch(/^Proto\s+Inside global\s+Inside local\s+Outside local\s+Outside global$/);
    expect(out[1]).toMatch(/^---\s+203\.0\.113\.5\s+192\.168\.1\.10\s+---\s+---$/);
    expect(out[2]).toMatch(/^---\s+203\.0\.113\.20\s+192\.168\.1\.12\s+---\s+---$/);
    expect(out[3]).toMatch(/^icmp\s+203\.0\.113\.1:2\s+192\.168\.1\.11:1\s+203\.0\.113\.10:2\s+203\.0\.113\.10:2$/);
    const verbose = lines(run(r, P2_HANDLERS.showIpNatTranslations, { verbose: 'verbose' }).output);
    expect(verbose[0]).toMatch(/Outside global\s+Kind\s+Expires\s+Rule$/);
    expect(verbose[1]).toMatch(/static\s+never\s+ip nat inside source static 192\.168\.1\.10 203\.0\.113\.5$/);
    expect(verbose[2]).toMatch(/dynamic\s+in 24:00:00\s+ip nat inside source list 1 pool P$/);
    expect(verbose[3]).toMatch(/overload\s+in 00:01:00\s+ip nat inside source list 2 interface GigabitEthernet0\/1 overload$/);
  });

  it('statistics counts by kind and lists interfaces, rules and pools with their use', () => {
    const r = translating();
    expect(lines(run(r, P2_HANDLERS.showIpNatStatistics).output)).toEqual([
      'Translations: 3 (1 static, 1 dynamic, 1 shared by port)',
      `Inside interfaces: ${GI0}`,
      `Outside interfaces: ${GI1}`,
      'Rules:',
      '  ip nat inside source list 1 pool P',
      `  ip nat inside source list 2 interface ${GI1} overload`,
      '  ip nat inside source static 192.168.1.10 203.0.113.5',
      'Pools:',
      '  P: 203.0.113.20 - 203.0.113.29 (mask 255.255.255.0), 10 addresses, 1 in use',
    ]);
    const empty = lines(run(router(), P2_HANDLERS.showIpNatStatistics).output);
    expect(empty).toEqual(['Translations: 0 (0 static, 0 dynamic, 0 shared by port)', 'Inside interfaces: none', 'Outside interfaces: none', 'Rules: none', 'Pools: none']);
  });

  it('clear ip nat translation * asks the nat daemon', () => {
    const r = router({ mode: 'priv-exec' });
    expect(run(r, P2_HANDLERS.execClearIpNat, { which: '*' })).toEqual({});
    expect(r.requests).toEqual([{ to: 'nat', req: { kind: 'nat.clear', session: 's_1' } }]);
  });
});

describe('access lists', () => {
  it('stores numbered entries in canonical form, refuses non-standard numbers, and removes entries or whole lists', () => {
    const r = router();
    expect(run(r, P2_HANDLERS.configAccessList, { number: '1', action: 'permit', form: 'address', address: '192.168.1.5', wildcard: '0.0.0.255' })).toEqual({});
    expect(run(r, P2_HANDLERS.configAccessList, { number: '1', action: 'deny', form: 'host', address: '10.0.0.1' })).toEqual({});
    expect(run(r, P2_HANDLERS.configAccessList, { number: '01', action: 'permit', form: 'any' })).toEqual({});
    expect(run(r, P2_HANDLERS.configAccessList, { number: '1300', action: 'permit', form: 'address', address: '10.1.1.1' })).toEqual({});
    expect(run(r, P2_HANDLERS.configAccessList, { number: '100', action: 'permit', form: 'any' }).error).toBe(MSG_ACL_NUMBER);
    expect(run(r, P2_HANDLERS.configAccessList, { number: '1', action: 'permit', form: 'address', address: 'x' }).error).toBe(MSG_ACL_ENTRY);
    expect(run(r, P2_HANDLERS.configAccessList, { number: '1' }).error).toBe(MSG_ACL_ENTRY);
    expect(r.running.render()).toContain('access-list 1 permit 192.168.1.0 0.0.0.255\naccess-list 1 deny 10.0.0.1\naccess-list 1 permit any\naccess-list 1300 permit 10.1.1.1');
    const lists = readStandardAcls(r.running);
    expect([...lists.keys()]).toEqual(['1', '1300']);
    expect(lists.get('1')?.entries).toHaveLength(3);
    expect(run(r, P2_HANDLERS.configAccessList, { number: '1', action: 'deny', form: 'host', address: '10.0.0.1' }, true)).toEqual({});
    expect(readStandardAcls(r.running).get('1')?.entries).toHaveLength(2);
    expect(run(r, P2_HANDLERS.configAccessList, { number: '1' }, true)).toEqual({});
    expect(readStandardAcls(r.running).has('1')).toBe(false);
    expect(readStandardAcls(r.running).has('1300')).toBe(true);
  });

  it('named lists are sections entered in config-std-nacl; entries need the section', () => {
    const r = router();
    expect(run(r, P2_HANDLERS.configIpAccessListStandard, { name: 'LAN' })).toEqual({});
    expect(r.enterModeCalls).toEqual([{ mode: 'config-std-nacl', opts: { context: [['ip', 'access-list', 'standard', 'LAN']] } }]);
    const inside = commandCtxFor(ROUTER, { mode: 'config-std-nacl', context: [['ip', 'access-list', 'standard', 'LAN']], running: r.running });
    expect(run(inside, P2_HANDLERS.naclEntry, { action: 'permit', form: 'address', address: '10.0.0.0', wildcard: '0.0.0.255' })).toEqual({});
    expect(run(inside, P2_HANDLERS.naclEntry, { action: 'deny', form: 'any' })).toEqual({});
    expect(r.running.render()).toContain('ip access-list standard LAN\n permit 10.0.0.0 0.0.0.255\n deny any');
    expect(readStandardAcls(r.running).get('LAN')?.entries.map((e) => e.action)).toEqual(['permit', 'deny']);
    expect(run(inside, P2_HANDLERS.naclEntry, { action: 'deny', form: 'any' }, true)).toEqual({});
    expect(readStandardAcls(r.running).get('LAN')?.entries).toHaveLength(1);
    expect(run(router(), P2_HANDLERS.naclEntry, { action: 'permit', form: 'any' }).error).toBe(MSG_NO_ACL_SELECTED);
    expect(run(r, P2_HANDLERS.configIpAccessListStandard, { name: 'LAN' }, true)).toEqual({});
    expect(readStandardAcls(r.running).has('LAN')).toBe(false);
  });

  it('show access-lists renders every list with numbered entries', () => {
    const r = router();
    expect(run(r, P2_HANDLERS.showAccessLists)).toEqual({ output: MSG_NO_ACL });
    r.running.set([], ['access-list', '1', 'permit', '192.168.1.0', '0.0.0.255']);
    r.running.set([], ['access-list', '1', 'deny', 'any']);
    r.running.set([], ['ip', 'access-list', 'standard', 'LAN']);
    r.running.set([['ip', 'access-list', 'standard', 'LAN']], ['permit', '10.0.0.1']);
    expect(lines(run(r, P2_HANDLERS.showAccessLists).output)).toEqual([
      'Standard access list 1',
      '    10 permit 192.168.1.0 0.0.0.255',
      '    20 deny any',
      'Standard access list LAN',
      '    10 permit 10.0.0.1',
    ]);
  });
});
