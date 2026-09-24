/**
 * cli/grammar/vlan.ts and cli/handlers/vlan.ts (ARCHITECTURE-P2 §3.1, §5.1, §5.4, D3; §7 W2 cli): `vlan <list>` as a
 * section (one stored section per VLAN, `name` applied to each), the built-in VLANs, `show vlan [brief | id <v>]`
 * from the `vlans` table or the running config, the `managed-switch` scope, and the shape of the P2 fragments
 * assembled beside the P1 table (`P2_GRAMMAR`, `P2_HANDLERS`, `BUILTIN_GRAMMAR`).
 */
import { describe, expect, it } from 'vitest';
import type { CommandHandler, CommandOutcome } from '../src/contracts/cli.js';
import type { TableRow, VlanRow } from '../src/contracts/tables.js';
import { findBannedWords } from '../src/device/catalog/validate.js';
import { createTable } from '../src/core/table.js';
import { BUILTIN_GRAMMAR, GRAMMAR, GRAMMAR_FRAGMENTS, HANDLERS, P2_GRAMMAR, P2_GRAMMAR_FRAGMENTS, P2_HANDLERS } from '../src/cli/grammar/index.js';
import { HANDLER_REGISTRY, P2_HANDLER_REGISTRY } from '../src/cli/handlers/index.js';
import {
  accessPortsOf,
  defaultVlanName,
  MSG_BAD_VLAN_NAME,
  MSG_NO_SUCH_VLAN,
  MSG_NO_VLAN_SELECTED,
  MSG_VLAN_RESERVED,
  VLAN_PORTS_MIN_WRAP,
  VLAN_TABLE_WIDTH,
  vlanExists,
  vlanListings,
  vlanNameOf,
  wrapPortList,
} from '../src/cli/handlers/vlan.js';
import { isArgToken, matchCommand } from '../src/cli/parser.js';
import { specModeAllows } from '../src/cli/modes.js';
import { catalogModel, commandCtxFor, matchContextFor, type CommandCtxOptions, type RecordingCtx } from './cli.p05.fixture.js';
import { p1SwitchModel, p2Model } from './cli.p2.fixture.js';

function handler(id: string): CommandHandler {
  const h = HANDLER_REGISTRY[id];
  if (h === undefined) throw new Error(`no handler ${id}`);
  return h;
}

function run(rec: RecordingCtx, id: string, args: Record<string, string> = {}, negate = false): CommandOutcome {
  return handler(id)(rec.ctx, args, negate);
}

const SW2960 = p2Model('switch.nfc2960');

function sw(opts: CommandCtxOptions = {}): RecordingCtx {
  return commandCtxFor(SW2960, opts);
}

/** A `vlans` table attached to the recording context (the vlan daemon is its writer; the tests write rows). */
function withVlansTable(rec: RecordingCtx): ReturnType<typeof createTable<VlanRow>> {
  const t = createTable<VlanRow>({ name: 'vlans', device: 'd_1', sink: { emit: () => undefined }, now: () => 0 });
  rec.extra.set('vlans', t as unknown as ReturnType<typeof createTable<TableRow>>);
  return t;
}

const lines = (s: string | undefined): string[] => (s ?? '').split('\n');

describe('vlan <list> and name', () => {
  it('writes one section per VLAN of the list and enters config-vlan with the typed list', () => {
    const r = sw();
    expect(run(r, P2_HANDLERS.configVlan, { vlans: '10,20' })).toEqual({});
    expect(r.configCalls).toEqual([{ line: ['vlan', '10,20'], negate: false, context: [] }]);
    expect(r.enterModeCalls).toEqual([{ mode: 'config-vlan', opts: { context: [['vlan', '10,20']] } }]);
    const text = r.running.render();
    expect(text).toContain('vlan 10\n');
    expect(text).toContain('vlan 20\n');
    expect(text).not.toContain('vlan 10,20');
  });

  it('refuses the built-in VLANs, and no vlan removes every section of the list', () => {
    const r = sw();
    expect(run(r, P2_HANDLERS.configVlan, { vlans: '1' }).error).toBe(MSG_VLAN_RESERVED.replace('{vlan}', '1'));
    expect(run(r, P2_HANDLERS.configVlan, { vlans: '10,1002' }).error).toBe(MSG_VLAN_RESERVED.replace('{vlan}', '1002'));
    expect(r.configCalls).toEqual([]);
    run(r, P2_HANDLERS.configVlan, { vlans: '10,20' });
    expect(run(r, P2_HANDLERS.configVlan, { vlans: '10,20' }, true)).toEqual({});
    expect(r.running.render()).not.toContain('vlan 10');
    expect(r.enterModeCalls).toHaveLength(1);
  });

  it('name applies to every VLAN of the section list and is validated', () => {
    const r = sw({ mode: 'config-vlan', context: [['vlan', '10,20']] });
    r.running.set([], ['vlan', '10,20']);
    expect(run(r, P2_HANDLERS.vlanName, { name: 'SALES' })).toEqual({});
    expect(r.running.render()).toContain('vlan 10\n name SALES');
    expect(r.running.render()).toContain('vlan 20\n name SALES');
    expect(run(r, P2_HANDLERS.vlanName, { name: 'two words' }).error).toBe(MSG_BAD_VLAN_NAME);
    expect(run(r, P2_HANDLERS.vlanName, { name: 'x'.repeat(33) }).error).toBe(MSG_BAD_VLAN_NAME);
    expect(run(r, P2_HANDLERS.vlanName, {}, true)).toEqual({});
    expect(r.running.render()).not.toContain('name SALES');
    expect(run(sw({ mode: 'config' }), P2_HANDLERS.vlanName, { name: 'X' }).error).toBe(MSG_NO_VLAN_SELECTED);
  });
});

describe('VLAN existence and names', () => {
  it('reads the vlans table first, then the running config, and names the built-in VLANs', () => {
    const r = sw();
    expect(vlanExists(r.ctx, 1)).toBe(true);
    expect(vlanExists(r.ctx, 1005)).toBe(true);
    expect(vlanExists(r.ctx, 10)).toBe(false);
    r.running.set([], ['vlan', '10']);
    expect(vlanExists(r.ctx, 10)).toBe(true);
    expect(vlanNameOf(r.ctx, 10)).toBe(defaultVlanName(10));
    expect(defaultVlanName(10)).toBe('VLAN0010');
    r.running.set([['vlan', '10']], ['name', 'SALES']);
    expect(vlanNameOf(r.ctx, 10)).toBe('SALES');
    expect(vlanNameOf(r.ctx, 1)).toBe('default');
    const t = withVlansTable(r);
    t.set({ key: '30', vlan: 30, name: 'GUEST', status: 'active', source: 'config', updatedAt: 0 });
    expect(vlanExists(r.ctx, 30)).toBe(true);
    expect(vlanNameOf(r.ctx, 30)).toBe('GUEST');
    expect(vlanListings(r.ctx).map((v) => [v.vlan, v.name, v.status])).toEqual([
      [1, 'default', 'active'],
      [10, 'SALES', 'active'],
      [30, 'GUEST', 'active'],
      [1002, 'fddi-default', 'reserved'],
      [1003, 'token-ring-default', 'reserved'],
      [1004, 'fddinet-default', 'reserved'],
      [1005, 'trnet-default', 'reserved'],
    ]);
  });
});

describe('show vlan', () => {
  function configured(): RecordingCtx {
    const r = sw();
    r.running.set([], ['vlan', '10']);
    r.running.set([['vlan', '10']], ['name', 'SALES']);
    r.running.set([['interface', 'FastEthernet0/1']], ['switchport', 'mode', 'access']);
    r.running.set([['interface', 'FastEthernet0/1']], ['switchport', 'access', 'vlan', '10']);
    r.running.set([['interface', 'FastEthernet0/2']], ['switchport', 'access', 'vlan', '10']);
    r.running.set([['interface', 'GigabitEthernet0/1']], ['switchport', 'mode', 'trunk']);
    return r;
  }

  it('lists every VLAN with its access ports, trunks in none, reserved VLANs last', () => {
    const r = configured();
    const out = lines(run(r, P2_HANDLERS.showVlan, { form: 'brief' }).output);
    expect(out[0]).toMatch(/^VLAN\s+Name\s+Status\s+Ports$/);
    // ARCHITECTURE-P2 §7 W5 cli (W4 browser-gate polish, ruling restated 2026-09-24): VLAN 1's 23 access ports wrap on
    // a ', ' boundary so that every line fits 80 columns — the Ports column starts at 36, so the cell wraps at 44 —
    // the continuation lines indented under the Ports column, so the VLAN 10 row moves from line 2 to 6, VLAN 1002
    // from 3 to 7, and the output from 7 lines to 11
    expect(out[1]).toMatch(/^\s+1\s+default\s+active\s+Fa0\/3, Fa0\/4, /);
    expect(out.slice(1, 6)).toEqual([
      '   1  default             active    Fa0/3, Fa0/4, Fa0/5, Fa0/6, Fa0/7, Fa0/8',
      '                                    Fa0/9, Fa0/10, Fa0/11, Fa0/12, Fa0/13',
      '                                    Fa0/14, Fa0/15, Fa0/16, Fa0/17, Fa0/18',
      '                                    Fa0/19, Fa0/20, Fa0/21, Fa0/22, Fa0/23',
      '                                    Fa0/24, Gi0/2',
    ]);
    expect(out.slice(1, 6).join('\n')).not.toContain('Gi0/1');
    expect(out[6]).toMatch(/^\s+10\s+SALES\s+active\s+Fa0\/1, Fa0\/2$/);
    expect(out[7]).toMatch(/^1002\s+fddi-default\s+reserved$/);
    expect(out).toHaveLength(11);
    expect(accessPortsOf(r.ctx, 10)).toEqual(['Fa0/1', 'Fa0/2']);
    expect(run(r, P2_HANDLERS.showVlan).output).toBe(run(r, P2_HANDLERS.showVlan, { form: 'brief' }).output);
  });

  it('wraps the Ports cell on a ", " boundary so every line fits 80 columns, continuation lines under the Ports column', () => {
    const out = lines(run(configured(), P2_HANDLERS.showVlan, { form: 'brief' }).output);
    const column = out[0]!.indexOf('Ports');
    expect(column).toBe(36);
    for (const line of out) expect(line.length, line).toBeLessThanOrEqual(VLAN_TABLE_WIDTH);
    for (const line of out.slice(1, 6)) {
      const cell = line.slice(column);
      expect(cell.length, line).toBeLessThanOrEqual(VLAN_TABLE_WIDTH - column);
      expect(cell, line).toMatch(/^Fa0\/\d+(?:, (?:Fa|Gi)0\/\d+)*$/);
    }
    for (const line of out.slice(2, 6)) expect(line.slice(0, column), line).toBe(' '.repeat(column));
    expect(VLAN_TABLE_WIDTH).toBe(80);
    expect(VLAN_PORTS_MIN_WRAP).toBe(20);
    expect(wrapPortList([], 48)).toEqual(['']);
    expect(wrapPortList(['Fa0/1'], 48)).toEqual(['Fa0/1']);
    // a line that would pass the width breaks at the last ', ' before it (the separator is dropped at the break)
    const six = ['Gi1/0/1', 'Gi1/0/2', 'Gi1/0/3', 'Gi1/0/4', 'Gi1/0/5', 'Gi1/0/6'];
    expect(six.join(', ')).toHaveLength(52);
    expect(wrapPortList(six, 48)).toEqual(['Gi1/0/1, Gi1/0/2, Gi1/0/3, Gi1/0/4, Gi1/0/5', 'Gi1/0/6']);
    // exactly the width stays on one line; one more character does not
    expect(wrapPortList(['a'.repeat(23), 'b'.repeat(23)], 48)).toEqual([`${'a'.repeat(23)}, ${'b'.repeat(23)}`]);
    expect(wrapPortList(['a'.repeat(23), 'b'.repeat(24)], 48)).toEqual(['a'.repeat(23), 'b'.repeat(24)]);
    // a single name longer than the width stands alone
    expect(wrapPortList(['x'.repeat(50), 'Fa0/1'], 48)).toEqual(['x'.repeat(50), 'Fa0/1']);
  });

  it('a longer VLAN name moves the Ports column right and narrows the wrap, so lines still fit 80 columns', () => {
    const r = configured();
    r.running.set([['vlan', '10']], ['name', 'ENGINEERING-AND-OPERATIONS-LAB-A']); // 32 characters, the longest name
    const out = lines(run(r, P2_HANDLERS.showVlan, { form: 'brief' }).output);
    const column = out[0]!.indexOf('Ports');
    expect(column).toBe(4 + 2 + 32 + 2 + 8 + 2);
    for (const line of out) expect(line.length, line).toBeLessThanOrEqual(VLAN_TABLE_WIDTH);
    // 80 − 50 leaves 30 characters: 'Fa0/3, Fa0/4, Fa0/5, Fa0/6' is 26, and ', Fa0/7' would make it 33
    expect(out[1]!.slice(column)).toBe('Fa0/3, Fa0/4, Fa0/5, Fa0/6');
  });

  it('show vlan id prints one VLAN or refuses a missing one', () => {
    const r = configured();
    const out = lines(run(r, P2_HANDLERS.showVlan, { form: 'id', vlan: '10' }).output);
    expect(out).toHaveLength(2);
    expect(out[1]).toMatch(/^\s+10\s+SALES\s+active\s+Fa0\/1, Fa0\/2$/);
    expect(run(r, P2_HANDLERS.showVlan, { form: 'id', vlan: '20' }).error).toBe(MSG_NO_SUCH_VLAN.replace('{vlan}', '20'));
  });
});

describe('scope', () => {
  it('the VLAN lines exist on a managed switch only, and parse to their handlers', () => {
    const ok = (m: ReturnType<typeof matchCommand>) => (m.ok ? m.spec.handler : m.error.message);
    expect(ok(matchCommand(BUILTIN_GRAMMAR, matchContextFor(SW2960, 'config'), 'vlan 10,20'))).toBe(P2_HANDLERS.configVlan);
    expect(ok(matchCommand(BUILTIN_GRAMMAR, matchContextFor(SW2960, 'config-vlan'), 'name SALES'))).toBe(P2_HANDLERS.vlanName);
    expect(ok(matchCommand(BUILTIN_GRAMMAR, matchContextFor(SW2960, 'user-exec'), 'show vlan brief'))).toBe(P2_HANDLERS.showVlan);
    expect(matchCommand(BUILTIN_GRAMMAR, matchContextFor(SW2960, 'user-exec'), 'show vlan id 10')).toMatchObject({ ok: true, args: { form: 'id', vlan: '10' } });
    expect(matchCommand(BUILTIN_GRAMMAR, matchContextFor(SW2960, 'config'), 'no vlan 10')).toMatchObject({ ok: true, negated: true, args: { vlans: '10' } });
    // the P1 switch and the router are not VLAN-aware (D5)
    expect(matchCommand(BUILTIN_GRAMMAR, matchContextFor(p1SwitchModel(), 'config'), 'vlan 10').ok).toBe(false);
    expect(matchCommand(BUILTIN_GRAMMAR, matchContextFor(catalogModel('router.nf2911'), 'user-exec'), 'show vlan').ok).toBe(false);
  });
});

describe('the P2 fragments folded into the table (ARCHITECTURE-P2 §7 W2 cli; §9.2 W4 item 18)', () => {
  it('the P1 fragments come first, unchanged; the P2 fragments follow them; the P2 handler ids are in HANDLERS; the runtime table is GRAMMAR', () => {
    const P1_KEYS = [
      'core-exec', 'show', 'config-global', 'config-if', 'svi', 'switchport', 'serial', 'wireless', 'modules',
      'ipv6', 'dhcp', 'dns', 'services', 'transport', 'traceroute', 'line-auth', 'host-shell',
    ];
    // W2 fragments, then the W3 cli fragments (spanning tree, EtherChannel, port security, err-disable, NAT, ACL, DHCPv6, [S2] HSRP),
    // then the W5 cli fragment (the wireless controller and lightweight access point lines)
    const P2_KEYS = [
      'vlan', 'switchport-p2', 'subif', 'routing',
      'spanning-tree', 'etherchannel', 'port-security', 'errdisable', 'nat', 'acl', 'dhcpv6', 'hsrp',
      'wlc',
    ];
    expect(Object.keys(GRAMMAR_FRAGMENTS)).toEqual([...P1_KEYS, ...P2_KEYS]);
    expect(Object.keys(P2_GRAMMAR_FRAGMENTS)).toEqual(P2_KEYS);
    for (const k of P2_KEYS) expect(GRAMMAR_FRAGMENTS[k], k).toBe(P2_GRAMMAR_FRAGMENTS[k]);
    for (const id of Object.values(P2_HANDLERS)) expect(Object.values(HANDLERS), id).toContain(id);
    expect(P2_GRAMMAR).toEqual(Object.values(P2_GRAMMAR_FRAGMENTS).flat());
    // the table is the P1 fragments followed by the P2 specs, the order the runtime table always had
    expect(GRAMMAR).toEqual([...P1_KEYS.flatMap((k) => GRAMMAR_FRAGMENTS[k] ?? []), ...P2_GRAMMAR]);
    expect(BUILTIN_GRAMMAR).toBe(GRAMMAR);
  });

  it('every P2 spec uses a P2 handler id, every id is used and registered, and every spec is well formed', () => {
    const ids = new Set<string>(Object.values(P2_HANDLERS));
    const used = new Set<string>();
    for (const s of P2_GRAMMAR) {
      expect(ids.has(s.handler), s.path.join(' ')).toBe(true);
      used.add(s.handler);
      expect(s.since, s.path.join(' ')).toBe('P2');
      expect(s.help.length, s.path.join(' ')).toBeGreaterThan(0);
      expect(s.objectives?.length ?? 0, s.path.join(' ')).toBeGreaterThan(0);
      expect(isArgToken(s.path[0]!)).toBe(false);
      const named = new Set<string>();
      for (const el of s.path) {
        if (!isArgToken(el)) {
          expect(el, s.path.join(' ')).toMatch(/^[a-z0-9|-]+$/);
          continue;
        }
        named.add(el.slice(1, -1));
        expect(s.args?.[el.slice(1, -1)]?.help.length ?? 0, `${s.path.join(' ')} ${el}`).toBeGreaterThan(0);
      }
      for (const k of Object.keys(s.args ?? {})) expect(named.has(k), `${s.path.join(' ')} unused arg ${k}`).toBe(true);
      if (s.path[0] === 'show') expect(s.filterable, s.path.join(' ')).toBe(true);
      expect(s.privilege, s.path.join(' ')).toBe(specModeAllows(s.mode, 'user-exec') ? 1 : 15);
      expect('kinds' in s).toBe(false);
    }
    for (const id of ids) {
      expect(used.has(id), id).toBe(true);
      expect(P2_HANDLER_REGISTRY[id], id).toBeDefined();
      expect(HANDLER_REGISTRY[id], id).toBe(P2_HANDLER_REGISTRY[id]);
    }
  });

  it('uses original wording in help, args and messages', () => {
    const texts: [string, string][] = [];
    for (const s of P2_GRAMMAR) {
      texts.push([s.path.join(' '), s.help]);
      for (const [k, a] of Object.entries(s.args ?? {})) texts.push([`${s.path.join(' ')} <${k}>`, a.help]);
    }
    for (const t of [MSG_VLAN_RESERVED, MSG_NO_VLAN_SELECTED, MSG_BAD_VLAN_NAME, MSG_NO_SUCH_VLAN]) texts.push(['vlan message', t]);
    for (const [where, t] of texts) expect(findBannedWords(t), where).toEqual([]);
  });
});
