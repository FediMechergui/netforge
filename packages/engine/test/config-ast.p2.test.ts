/**
 * The P2 config rule table and the completeness rule (ARCHITECTURE-P2 §5, D2; §7 W1 cli).
 *
 * Covers: the identity of every canonical §5.1 line (and the §5.2/§5.3 lines the same wave adds); the two rule-table
 * corrections (`switchport` names only the one-token line, `ip routing` is `bothForms`); VLAN lists stored one line
 * per VLAN; `slotKeyOf` / `defaultSlotsOf` / `apply` with a hand-given `DefaultSlots`; and that `apply` without
 * `defaults` is exactly today's `set` / `unset`.
 */
import { describe, expect, it } from 'vitest';
import type { ConfigAst, DefaultSlots } from '../src/contracts/config.js';
import { ifaceContext } from '../src/contracts/config.js';
import {
  CONFIG_LINE_RULES,
  DEFAULT_CONFIG_RULES,
  expandVlanListContext,
  expandVlanListLine,
  ruleIdentity,
} from '../src/cli/config-rules.js';
import { createConfigAst, defaultSlotsOf, parseConfigText, slotKeyOf } from '../src/cli/config-ast.js';
import { configTextLinesOf } from '../src/cli/config-text.js';

const GLOBAL: string[][] = [];
const GI1 = ifaceContext('GigabitEthernet0/1');
const VLAN10 = [['vlan', '10']];
const rf = DEFAULT_CONFIG_RULES.ruleFor;

/** Identity length and cardinality of a line under the rule table. */
function shape(context: readonly (readonly string[])[], line: readonly string[]): string {
  const rule = rf(context, line);
  if (rule === undefined) return 'none';
  const section = rule.section === undefined ? '' : `/section:${rule.section.mode}`;
  return `${ruleIdentity(rule, line)}/${rule.cardinality}${section}`;
}

function lines(ast: ConfigAst): string[] {
  return configTextLinesOf(ast.root).map((l) => `${l.negate ? 'no ' : ''}${l.tokens.join(' ')}@${l.context.map((e) => e.join(' ')).join('|')}`);
}

describe('§5 identity table', () => {
  it('gives every canonical §5.1 switching line its own identity', () => {
    const table: [readonly (readonly string[])[], string, string][] = [
      [GLOBAL, 'vlan 10', '2/single/section:config-vlan'],
      [VLAN10, 'name SALES', '1/single'],
      [GI1, 'switchport mode access', '2/single'],
      [GI1, 'switchport mode dynamic auto', '2/single'],
      [GI1, 'switchport access vlan 10', '3/single'],
      [GI1, 'switchport voice vlan 20', '3/single'],
      [GI1, 'switchport trunk native vlan 99', '4/single'],
      [GI1, 'switchport trunk allowed vlan 1,10,20,99', '4/single'],
      [GI1, 'switchport nonegotiate', '2/single'],
      [GI1, 'switchport port-security', '2/single'],
      [GI1, 'switchport port-security maximum 2', '3/single'],
      [GI1, 'switchport port-security violation restrict', '3/single'],
      [GI1, 'switchport port-security mac-address 00:11:22:33:44:55', '3/multi'],
      [GI1, 'switchport port-security mac-address sticky', '4/single'],
      [GI1, 'switchport port-security mac-address sticky 00:11:22:33:44:55', '5/multi'],
      [GI1, 'spanning-tree portfast', '2/single'],
      [GI1, 'spanning-tree portfast trunk', '2/single'],
      [GI1, 'spanning-tree bpduguard enable', '2/single'],
      [GI1, 'spanning-tree guard root', '2/single'],
      [GI1, 'spanning-tree cost 19', '2/single'],
      [GI1, 'spanning-tree port-priority 64', '2/single'],
      [GI1, 'spanning-tree vlan 10 cost 19', '4/single'],
      [GI1, 'spanning-tree vlan 10 port-priority 64', '4/single'],
      [GI1, 'channel-group 1 mode active', '1/single'],
      [GLOBAL, 'spanning-tree mode pvst', '2/single'],
      [GLOBAL, 'spanning-tree extend system-id', '2/single'],
      [GLOBAL, 'spanning-tree vlan 10 priority 4096', '4/single'],
      [GLOBAL, 'spanning-tree vlan 10', '3/single'],
      [GLOBAL, 'port-channel load-balance src-dst-ip', '2/single'],
      [GLOBAL, 'errdisable recovery cause psecure-violation', '3/multi'],
      [GLOBAL, 'errdisable recovery interval 30', '3/single'],
      [GLOBAL, 'mac address-table static 00:11:22:33:44:55 vlan 10 interface FastEthernet0/2', '3/multi'],
      [GLOBAL, 'mac address-table aging-time 300', '3/single'],
    ];
    for (const [context, text, expected] of table) {
      expect(shape(context, text.split(' ')), text).toBe(expected);
    }
  });

  it('gives the §5.2 and §5.3 lines their identities', () => {
    const table: [readonly (readonly string[])[], string, string][] = [
      [GLOBAL, 'ip routing', '2/single'],
      [GLOBAL, 'ip nat pool LAB 203.0.113.20 203.0.113.30 netmask 255.255.255.0', '4/single'],
      [GLOBAL, 'ip nat inside source list 1 interface GigabitEthernet0/1 overload', '6/single'],
      [GLOBAL, 'ip nat inside source static 192.168.1.5 203.0.113.5', '5/multi'],
      [GLOBAL, 'ip nat inside source static tcp 192.168.1.5 80 203.0.113.5 8080', '5/multi'],
      [GLOBAL, 'ip nat translation timeout 300', '4/single'],
      [GLOBAL, 'access-list 1 permit 192.168.1.0 0.0.0.255', '2/multi'],
      [GLOBAL, 'ip access-list standard LAB', '4/single/section:config-std-nacl'],
      [GLOBAL, 'ipv6 dhcp pool LAB6', '4/single/section:config-dhcpv6'],
      [[['ip', 'access-list', 'standard', 'LAB']], 'permit 10.0.0.0 0.0.0.255', '1/multi'],
      [[['ipv6', 'dhcp', 'pool', 'LAB6']], 'address prefix 2001:db8:1::/64', '2/single'],
      [[['ipv6', 'dhcp', 'pool', 'LAB6']], 'dns-server 2001:db8:1::10', '1/multi'],
      [GI1, 'ip nat inside', '2/single'],
      [GI1, 'ip proxy-arp', '2/single'],
      [GI1, 'ipv6 address dhcp', '3/single'],
      [GI1, 'ipv6 dhcp server LAB6', '3/single'],
      [GI1, 'ipv6 nd managed-config-flag', '3/single'],
      [GI1, 'standby version 2', '2/single'],
      [GI1, 'standby 1 ip 192.168.1.1', '3/single'],
      [GI1, 'standby ip 192.168.1.1', '2/single'],
      [GI1, 'standby 1 priority 110', '3/single'],
      [GI1, 'standby 1 preempt delay minimum 30', '3/single'],
      [GI1, 'standby 1 timers 1 3', '3/single'],
      [GLOBAL, 'capwap enable', '2/single'],
      [GLOBAL, 'capwap controller 10.0.0.5', '2/multi'],
      [GLOBAL, 'wlc-interface management', '2/single/section:config-wlc-if'],
      [GLOBAL, 'wlan 1 CORP corp-net', '4/single/section:config-wlan'],
      [[['wlc-interface', 'management']], 'vlan 20', '1/single'],
      [[['wlc-interface', 'management']], 'address 192.168.20.5 255.255.255.0', '1/single'],
      [[['wlan', '1', 'CORP', 'corp-net']], 'security wpa2-psk', '1/single'],
      [[['wlan', '1', 'CORP', 'corp-net']], 'interface management', '1/single'],
    ];
    for (const [context, text, expected] of table) {
      expect(shape(context, text.split(' ')), text).toBe(expected);
    }
  });

  it('replaces a line of the same identity and keeps lines of another', () => {
    const ast = createConfigAst();
    ast.set(GLOBAL, ['interface', 'GigabitEthernet0/1']);
    ast.set(GI1, ['switchport', 'mode', 'access']);
    ast.set(GI1, ['switchport', 'access', 'vlan', '10']);
    ast.set(GI1, ['switchport', 'port-security']);
    ast.set(GI1, ['switchport', 'port-security', 'maximum', '2']);
    // same identity replaces …
    expect(ast.set(GI1, ['switchport', 'mode', 'trunk'])?.before).toEqual(['access']);
    expect(ast.set(GI1, ['switchport', 'port-security', 'maximum', '4'])?.before).toEqual(['2']);
    // … a different identity does not
    expect(ast.query('interface.GigabitEthernet0/1')[0]?.children.map((c) => [c.key, ...c.args].join(' '))).toEqual([
      'switchport mode trunk',
      'switchport access vlan 10',
      'switchport port-security',
      'switchport port-security maximum 4',
    ]);
    // `no switchport port-security` leaves the other port-security lines alone
    expect(ast.unset(GI1, ['switchport', 'port-security'])?.before).toEqual([]);
    expect(ast.query('interface.GigabitEthernet0/1')[0]?.children.map((c) => [c.key, ...c.args].join(' '))).toEqual([
      'switchport mode trunk',
      'switchport access vlan 10',
      'switchport port-security maximum 4',
    ]);
  });

  it('keeps every rule well formed', () => {
    for (const r of CONFIG_LINE_RULES) {
      expect(r.identity).toBeGreaterThanOrEqual(1);
      expect(r.contexts.length).toBeGreaterThan(0);
      if (r.section !== undefined) expect(r.group).toBeUndefined();
      if (r.bothForms === true) expect(r.storeNegation).toBeUndefined();
      if (r.negationRestoresDefault === true) expect(r.pattern.slice(0, 2)).toEqual(['spanning-tree', 'mode']);
    }
  });
});

describe('the bare switchport line (§5 correction)', () => {
  it('names only the one-token line', () => {
    expect(rf(GI1, ['switchport'])?.storeNegation).toBe(true);
    expect(rf(GI1, ['switchport', 'mode', 'access'])?.storeNegation).toBeUndefined();
    expect(rf(GI1, ['switchport', 'access', 'vlan', '10'])?.storeNegation).toBeUndefined();
  });

  it('no longer removes the switchport children, and switchport mode no longer cancels no switchport', () => {
    const ast = createConfigAst();
    ast.set(GLOBAL, ['interface', 'GigabitEthernet0/1']);
    ast.set(GI1, ['switchport', 'mode', 'access']);
    ast.set(GI1, ['switchport', 'access', 'vlan', '10']);
    expect(ast.set(GI1, ['switchport'])).toBeUndefined();
    expect(ast.query('interface.GigabitEthernet0/1')[0]?.children).toHaveLength(2);

    // `no switchport` (the routed role) does remove every switchport child, as IOS does
    ast.unset(GI1, ['switchport']);
    expect(ast.query('interface.GigabitEthernet0/1')[0]?.children.map((c) => [c.key, ...c.args].join(' '))).toEqual(['no switchport']);
    // and a switchport line typed below it does not cancel the stored negation
    ast.set(GI1, ['switchport', 'mode', 'access']);
    expect(ast.query('interface.GigabitEthernet0/1.no')[0]?.args).toEqual(['switchport']);
    // only the bare line does
    ast.set(GI1, ['switchport']);
    expect(ast.query('interface.GigabitEthernet0/1.no')).toEqual([]);
    expect(ast.query('interface.GigabitEthernet0/1')[0]?.children.map((c) => [c.key, ...c.args].join(' '))).toEqual(['switchport mode access']);
  });
});

describe('ip routing (bothForms, §5)', () => {
  it('stores each form as typed in one slot', () => {
    const ast = createConfigAst();
    expect(ast.set(GLOBAL, ['ip', 'routing'])).toEqual({ op: 'set', context: [], line: ['ip', 'routing'] });
    expect(ast.render()).toContain('ip routing');

    expect(ast.unset(GLOBAL, ['ip', 'routing'])).toEqual({ op: 'unset', context: [], line: ['ip', 'routing'], before: [] });
    expect(ast.get('ip.routing')).toBeUndefined();
    expect(ast.query('no')[0]?.args).toEqual(['ip', 'routing']);
    expect(ast.render()).toContain('no ip routing');
    expect(ast.unset(GLOBAL, ['ip', 'routing'])).toBeUndefined();

    // back to `ip routing`: the negation goes and the positive line is stored
    expect(ast.set(GLOBAL, ['ip', 'routing'])).toEqual({ op: 'set', context: [], line: ['ip', 'routing'] });
    expect(ast.query('no')).toEqual([]);
    expect(ast.get('ip.routing')).toEqual([]);
  });

  it('survives render, parse and replay in both forms', () => {
    const off = createConfigAst();
    off.set(GLOBAL, ['hostname', 'MLS1']);
    off.unset(GLOBAL, ['ip', 'routing']);
    const reloaded = parseConfigText(off.render());
    expect(reloaded.render()).toBe(off.render());
    expect(lines(reloaded)).toContain('no ip routing@');

    const on = parseConfigText(['hostname MLS1', 'ip routing'].join('\n'));
    expect(on.render()).toContain('ip routing');
    expect(on.query('no')).toEqual([]);
  });

  it('stores only the negation for the interface line ip proxy-arp [S7]', () => {
    const ast = createConfigAst();
    ast.set(GLOBAL, ['interface', 'GigabitEthernet0/1']);
    ast.unset(GI1, ['ip', 'proxy-arp']);
    expect(ast.query('interface.GigabitEthernet0/1.no')[0]?.args).toEqual(['ip', 'proxy-arp']);
    const reloaded = parseConfigText(ast.render());
    expect(reloaded.render()).toBe(ast.render());
    // §5.2 binds `storeNegation`, not `bothForms`: the positive form clears the slot and stores NOTHING, so no
    // redundant `ip proxy-arp` line reaches show running-config or an exported startup-config. Proxy ARP is an
    // invisible default (§D2, line 154): with the slot empty the arp reader takes the value from `ctx.profile`.
    ast.set(GI1, ['ip', 'proxy-arp']);
    expect(ast.query('interface.GigabitEthernet0/1.no')).toEqual([]);
    expect(ast.get('interface.GigabitEthernet0/1.ip.proxy-arp')).toBeUndefined();
    const pristine = createConfigAst();
    pristine.set(GLOBAL, ['interface', 'GigabitEthernet0/1']);
    expect(ast.render()).toBe(pristine.render());
  });
});

describe('VLAN lists (§5)', () => {
  it('stores vlan 10,20 as two sections and applies their children to each', () => {
    const ast = createConfigAst();
    const delta = ast.set(GLOBAL, ['vlan', '10,20']);
    expect(delta).toEqual({ op: 'set', context: [], line: ['vlan', '10,20'] });
    expect(ast.root.children.map((c) => [c.key, ...c.args].join(' '))).toEqual(['vlan 10', 'vlan 20']);

    ast.set([['vlan', '10,20']], ['name', 'SALES']);
    expect(ast.get('vlan.10.name')).toEqual(['SALES']);
    expect(ast.get('vlan.20.name')).toEqual(['SALES']);
    expect(ast.render()).toContain(['vlan 10', ' name SALES', '!', 'vlan 20', ' name SALES', '!'].join('\n'));
    expect(parseConfigText(ast.render()).render()).toBe(ast.render());

    // one VLAN behaves exactly as a plain section
    expect(ast.set(GLOBAL, ['vlan', '10'])).toBeUndefined();
    expect(ast.unset(GLOBAL, ['vlan', '20'])).toEqual({ op: 'unset', context: [], line: ['vlan', '20'], before: [] });
    expect(ast.root.children.map((c) => [c.key, ...c.args].join(' '))).toEqual(['vlan 10']);
  });

  it('expands ranges ascending, ignores non-lists and keeps other rules untouched', () => {
    expect(expandVlanListLine(GLOBAL, ['vlan', '30,10-12'])).toEqual([
      ['vlan', '10'],
      ['vlan', '11'],
      ['vlan', '12'],
      ['vlan', '30'],
    ]);
    expect(expandVlanListLine(GLOBAL, ['vlan', 'internal'])).toEqual([['vlan', 'internal']]);
    expect(expandVlanListLine(GLOBAL, ['vlan', '4095'])).toEqual([['vlan', '4095']]);
    expect(expandVlanListLine(GLOBAL, ['hostname', 'SW1'])).toEqual([['hostname', 'SW1']]);
    expect(expandVlanListContext([['vlan', '10,20']])).toEqual([[['vlan', '10']], [['vlan', '20']]]);
    expect(expandVlanListContext(GI1)).toEqual([GI1]);
  });

  it('stores one spanning-tree line per VLAN and one stored negation per VLAN', () => {
    const ast = createConfigAst();
    ast.set(GLOBAL, ['spanning-tree', 'vlan', '1,10', 'priority', '4096']);
    expect(ast.render()).toContain(['spanning-tree vlan 1 priority 4096', 'spanning-tree vlan 10 priority 4096'].join('\n'));
    // the same VLAN replaces, another VLAN is its own line
    expect(ast.set(GLOBAL, ['spanning-tree', 'vlan', '10', 'priority', '0'])?.before).toEqual(['4096']);
    expect(ast.render()).toContain(['spanning-tree vlan 1 priority 4096', 'spanning-tree vlan 10 priority 0'].join('\n'));

    ast.unset(GLOBAL, ['spanning-tree', 'vlan', '10,20']);
    expect(ast.root.children.filter((c) => c.key === 'no').map((c) => c.args.join(' '))).toEqual([
      'spanning-tree vlan 10',
      'spanning-tree vlan 20',
    ]);
    // disabling a VLAN's spanning tree keeps the priority of the other VLANs
    expect(ast.render()).toContain('spanning-tree vlan 1 priority 4096');
    ast.set(GLOBAL, ['spanning-tree', 'vlan', '10']);
    expect(ast.root.children.filter((c) => c.key === 'no').map((c) => c.args.join(' '))).toEqual(['spanning-tree vlan 20']);
  });
});

// ── the completeness rule (D2, §5) ────────────────────────────────────────────

/** The default lines D of a P2 access point and multilayer switch, as the runtime replays them. */
const AP_DEFAULTS = ['capwap enable', 'interface Vlan1', ' ip address dhcp', ' no shutdown'].join('\n');
const MLS_DEFAULTS = ['spanning-tree mode pvst', 'spanning-tree extend system-id', 'no ip routing'].join('\n');

function defaultsOf(text: string): DefaultSlots {
  return defaultSlotsOf(parseConfigText(text));
}

/** A device whose running config starts as the replay of its default lines D (as the runtime boots it). */
function booted(text: string): { ast: ConfigAst; defaults: DefaultSlots } {
  const defaults = defaultsOf(text);
  const ast = createConfigAst();
  for (const l of configTextLinesOf(parseConfigText(text).root)) ast.apply(l.context, l.tokens, l.negate, { defaults });
  return { ast, defaults };
}

/** Export, reload and replay D first, then the saved lines — the boot the grader's clone runs. */
function roundTrip(ast: ConfigAst, defaultsText: string): ConfigAst {
  const defaults = defaultsOf(defaultsText);
  const saved = parseConfigText(ast.render(), DEFAULT_CONFIG_RULES, { defaults });
  const out = createConfigAst();
  for (const l of configTextLinesOf(parseConfigText(defaultsText).root)) out.apply(l.context, l.tokens, l.negate, { defaults });
  for (const l of configTextLinesOf(saved.root)) out.apply(l.context, l.tokens, l.negate, { defaults });
  return out;
}

describe('slotKeyOf and defaultSlotsOf', () => {
  it('keys a line on its context and identity, and a negation on the same slot', () => {
    expect(slotKeyOf(GLOBAL, ['ip', 'routing'])).toBe(slotKeyOf(GLOBAL, ['no', 'ip', 'routing']));
    expect(slotKeyOf(GI1, ['ip', 'address', '10.0.0.1', '255.255.255.0'])).toBe(slotKeyOf(GI1, ['ip', 'address', 'dhcp']));
    expect(slotKeyOf(GI1, ['ip', 'address', 'dhcp'])).not.toBe(slotKeyOf(ifaceContext('Vlan1'), ['ip', 'address', 'dhcp']));
    expect(slotKeyOf(GLOBAL, ['spanning-tree', 'mode', 'pvst'])).toBe(slotKeyOf(GLOBAL, ['spanning-tree', 'mode', 'rapid-pvst']));
    // multi-valued lines and sections key on the whole line
    expect(slotKeyOf(GLOBAL, ['ip', 'route', '10.0.0.0', '255.0.0.0', '10.9.9.1'])).not.toBe(
      slotKeyOf(GLOBAL, ['ip', 'route', '10.1.0.0', '255.255.0.0', '10.9.9.1']),
    );
  });

  it('records one slot per default line, sections excluded', () => {
    const ap = defaultsOf(AP_DEFAULTS);
    expect(ap.get(slotKeyOf(GLOBAL, ['capwap', 'enable']))).toEqual(['capwap', 'enable']);
    expect(ap.get(slotKeyOf(ifaceContext('Vlan1'), ['ip', 'address']))).toEqual(['ip', 'address', 'dhcp']);
    expect(ap.get(slotKeyOf(GLOBAL, ['interface', 'Vlan1']))).toBeUndefined();
    expect(ap.get(slotKeyOf(ifaceContext('Vlan1'), ['shutdown']))).toBeUndefined();

    const mls = defaultsOf(MLS_DEFAULTS);
    expect(mls.get(slotKeyOf(GLOBAL, ['spanning-tree', 'mode']))).toEqual(['spanning-tree', 'mode', 'pvst']);
    expect(mls.get(slotKeyOf(GLOBAL, ['spanning-tree', 'extend', 'system-id']))).toEqual(['spanning-tree', 'extend', 'system-id']);
    expect(mls.get(slotKeyOf(GLOBAL, ['ip', 'routing']))).toEqual(['no', 'ip', 'routing']);
  });
});

describe('apply with defaults (the completeness rule)', () => {
  it('stores the no form of a default line explicitly and survives export, reload and replay', () => {
    const { ast, defaults } = booted(AP_DEFAULTS);
    expect(ast.get('interface.Vlan1.ip.address')).toEqual(['dhcp']);
    expect(ast.get('capwap.enable')).toEqual(['enable']);
    expect(ast.render()).toContain('capwap enable');

    const vlan1 = ifaceContext('Vlan1');
    expect(ast.apply(vlan1, ['ip', 'address'], true, { defaults })).toBeDefined();
    expect(ast.query('interface.Vlan1.ip')).toEqual([]);
    expect(ast.query('interface.Vlan1.no')[0]?.args).toEqual(['ip', 'address']);

    expect(ast.apply(GLOBAL, ['capwap', 'enable'], true, { defaults })).toBeDefined();
    expect(ast.render()).not.toContain('\ncapwap enable');
    expect(ast.render()).toContain('no capwap enable');
    // typing it again changes nothing
    expect(ast.apply(GLOBAL, ['capwap', 'enable'], true, { defaults })).toBeUndefined();

    const clone = roundTrip(ast, AP_DEFAULTS);
    expect(clone.render()).toBe(ast.render());
    expect(clone.toJSON()).toEqual(ast.toJSON());
  });

  it('cancels the explicit negation when the line is typed again', () => {
    const { ast, defaults } = booted(AP_DEFAULTS);
    ast.apply(GLOBAL, ['capwap', 'enable'], true, { defaults });
    expect(ast.apply(GLOBAL, ['capwap', 'enable'], false, { defaults })).toBeDefined();
    expect(ast.query('no')).toEqual([]);
    expect(ast.render()).toContain('capwap enable');
    expect(roundTrip(ast, AP_DEFAULTS).render()).toBe(ast.render());

    const vlan1 = ifaceContext('Vlan1');
    ast.apply(vlan1, ['ip', 'address'], true, { defaults });
    expect(ast.apply(vlan1, ['ip', 'address', '10.0.0.9', '255.255.255.0'], false, { defaults })).toBeDefined();
    expect(ast.query('interface.Vlan1.no')).toEqual([]);
    expect(ast.get('interface.Vlan1.ip.address')).toEqual(['10.0.0.9', '255.255.255.0']);
    expect(roundTrip(ast, AP_DEFAULTS).render()).toBe(ast.render());
  });

  it('restores the device default for no spanning-tree mode, and clears the slot without one', () => {
    const { ast, defaults } = booted(MLS_DEFAULTS);
    expect(ast.get('spanning-tree.mode')).toEqual(['mode', 'pvst']);
    expect(ast.render()).toContain('spanning-tree mode pvst');

    ast.apply(GLOBAL, ['spanning-tree', 'mode', 'rapid-pvst'], false, { defaults });
    expect(ast.render()).toContain('spanning-tree mode rapid-pvst');
    const restored = ast.apply(GLOBAL, ['spanning-tree', 'mode'], true, { defaults });
    expect(restored).toEqual({ op: 'set', context: [], line: ['spanning-tree', 'mode', 'pvst'], before: ['rapid-pvst'] });
    expect(ast.render()).toContain('spanning-tree mode pvst');
    expect(roundTrip(ast, MLS_DEFAULTS).render()).toBe(ast.render());

    // a P1 world replays nothing, so the same line clears the slot (spanning tree off)
    const p1 = createConfigAst();
    const none: DefaultSlots = new Map();
    p1.apply(GLOBAL, ['spanning-tree', 'mode', 'pvst'], false, { defaults: none });
    expect(p1.apply(GLOBAL, ['spanning-tree', 'mode'], true, { defaults: none })?.op).toBe('unset');
    expect(p1.render()).not.toContain('spanning-tree mode');
  });

  it('keeps ip routing complete in a P2 world through export and reload', () => {
    const { ast, defaults } = booted(MLS_DEFAULTS);
    expect(ast.render()).toContain('no ip routing');
    expect(ast.apply(GLOBAL, ['ip', 'routing'], false, { defaults })).toBeDefined();
    expect(ast.render()).toContain('ip routing');
    expect(ast.render()).not.toContain('no ip routing');

    const clone = roundTrip(ast, MLS_DEFAULTS);
    expect(clone.render()).toBe(ast.render());
    expect(clone.get('ip.routing')).toEqual([]);
    expect(clone.query('no')).toEqual([]);
  });

  it('stores the default state of a stored-negation slot explicitly', () => {
    // a hand-given D that makes a port routed and gives a serial link a keepalive value
    const D = ['interface GigabitEthernet0/1', ' no switchport', 'interface Serial0/0/0', ' keepalive 5'].join('\n');
    const { ast, defaults } = booted(D);
    expect(ast.query('interface.GigabitEthernet0/1.no')[0]?.args).toEqual(['switchport']);

    expect(ast.apply(GI1, ['switchport'], false, { defaults })).toBeDefined();
    expect(ast.query('interface.GigabitEthernet0/1.no')).toEqual([]);
    expect(ast.query('interface.GigabitEthernet0/1')[0]?.children.map((c) => [c.key, ...c.args].join(' '))).toEqual(['switchport']);
    expect(ast.apply(GI1, ['switchport'], false, { defaults })).toBeUndefined();

    const serial = ifaceContext('Serial0/0/0');
    expect(ast.apply(serial, ['keepalive', '5'], true, { defaults })?.before).toEqual(['5']);
    expect(ast.query('interface.Serial0/0/0')[0]?.children.map((c) => [c.key, ...c.args].join(' '))).toEqual(['keepalive']);

    const clone = roundTrip(ast, D);
    expect(clone.render()).toBe(ast.render());
    expect(clone.toJSON()).toEqual(ast.toJSON());
  });

  it('leaves slots outside D exactly as they are today', () => {
    const { ast, defaults } = booted(MLS_DEFAULTS);
    ast.apply(GLOBAL, ['interface', 'GigabitEthernet0/1'], false, { defaults });
    ast.apply(GI1, ['ip', 'address', '10.0.0.1', '255.255.255.0'], false, { defaults });
    expect(ast.apply(GI1, ['ip', 'address'], true, { defaults })?.before).toEqual(['10.0.0.1', '255.255.255.0']);
    expect(ast.query('interface.GigabitEthernet0/1')[0]?.children).toEqual([]);
    expect(ast.apply(GI1, ['shutdown'], true, { defaults })).toBeUndefined();
  });
});

describe('apply without defaults', () => {
  it('is exactly set and unset', () => {
    const script: [readonly (readonly string[])[], string[], boolean][] = [
      [GLOBAL, ['hostname', 'SW1'], false],
      [GLOBAL, ['interface', 'GigabitEthernet0/1'], false],
      [GI1, ['switchport', 'mode', 'access'], false],
      [GI1, ['switchport', 'access', 'vlan', '10'], false],
      [GI1, ['switchport'], true],
      [GI1, ['ip', 'address', '10.0.0.1', '255.255.255.0'], false],
      [GI1, ['ip', 'address'], true],
      [GI1, ['shutdown'], true],
      [GLOBAL, ['vlan', '10,20'], false],
      [[['vlan', '10,20']], ['name', 'SALES'], false],
      [GLOBAL, ['ip', 'routing'], true],
      [GLOBAL, ['spanning-tree', 'mode', 'pvst'], false],
      [GLOBAL, ['spanning-tree', 'mode'], true],
      [GLOBAL, ['ip', 'route', '10.0.0.0', '255.0.0.0', '10.9.9.1'], false],
    ];
    const byApply = createConfigAst();
    const bySetUnset = createConfigAst();
    for (const [context, line, negate] of script) {
      const a = byApply.apply(context, line, negate);
      const b = negate ? bySetUnset.unset(context, line) : bySetUnset.set(context, line);
      expect(a, line.join(' ')).toEqual(b);
    }
    expect(byApply.toJSON()).toEqual(bySetUnset.toJSON());
    expect(byApply.render()).toBe(bySetUnset.render());
  });
});
