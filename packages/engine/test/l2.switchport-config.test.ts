/**
 * W1 l2 (ARCHITECTURE-P2 §2.2, D6, §5.1): `readSwitchport` is the one reader of a port's switchport lines.
 *
 * Configurations are built in the stored form of cli/config-ast.ts (key = first token, args = the rest) with
 * `configAstFromJson`, so these tests do not depend on the rule table the same wave's cli item changes.
 */
import { describe, expect, it } from 'vitest';
import { configAstFromJson } from '../src/cli/config-ast.js';
import type { ConfigAst, ConfigNode } from '../src/contracts/config.js';
import { CONTROLLER_PORT_SWITCHPORT, DEFAULT_SWITCHPORT } from '../src/contracts/port.js';
import {
  SWITCHPORT_MEMBERSHIP_PREFIXES,
  interfaceOfContext,
  isControllerModel,
  isDefaultSwitchport,
  isMembershipLine,
  parseSwitchportMode,
  readAllSwitchports,
  readSwitchport,
  switchportModeText,
  trunkAllows,
} from '../src/protocols/l2/switchport-config.js';

function lineNode(text: string): ConfigNode {
  const t = text.split(' ');
  return { key: t[0] as string, args: t.slice(1), children: [] };
}

/** A running configuration with the given interface sections (lines in order) and global lines. */
function cfg(sections: Readonly<Record<string, readonly string[]>>, globals: readonly string[] = []): ConfigAst {
  const root: ConfigNode = { key: '', args: [], children: [] };
  for (const g of globals) root.children.push(lineNode(g));
  for (const [port, lines] of Object.entries(sections)) {
    root.children.push({ key: 'interface', args: [port], children: lines.map(lineNode) });
  }
  return configAstFromJson(root);
}

const FA1 = 'FastEthernet0/1';
const GI1 = 'GigabitEthernet0/1';

describe('readSwitchport defaults (D3)', () => {
  it('a port with no section, an empty section or only unrelated lines reads DEFAULT_SWITCHPORT', () => {
    expect(readSwitchport(cfg({}), FA1)).toBe(DEFAULT_SWITCHPORT);
    expect(readSwitchport(cfg({ [FA1]: [] }), FA1)).toBe(DEFAULT_SWITCHPORT);
    expect(readSwitchport(cfg({ [FA1]: ['description uplink', 'shutdown', 'speed 100'] }), FA1)).toBe(DEFAULT_SWITCHPORT);
    expect(DEFAULT_SWITCHPORT).toEqual({ mode: 'dynamic-auto', negotiate: true, accessVlan: 1, nativeVlan: 1, allowed: '1-4094' });
    expect(isDefaultSwitchport(DEFAULT_SWITCHPORT)).toBe(true);
  });

  it('reads only the named port, never a neighbour or a global line', () => {
    const c = cfg({ [FA1]: ['switchport mode access'], 'FastEthernet0/2': [] }, ['switchport mode trunk']);
    expect(readSwitchport(c, 'FastEthernet0/2')).toBe(DEFAULT_SWITCHPORT);
    expect(readSwitchport(c, FA1).mode).toBe('access');
  });
});

describe('readSwitchport lines (§5.1)', () => {
  it('reads every mode', () => {
    expect(readSwitchport(cfg({ [FA1]: ['switchport mode access'] }), FA1).mode).toBe('access');
    expect(readSwitchport(cfg({ [FA1]: ['switchport mode trunk'] }), FA1).mode).toBe('trunk');
    expect(readSwitchport(cfg({ [FA1]: ['switchport mode dynamic auto'] }), FA1).mode).toBe('dynamic-auto');
    expect(readSwitchport(cfg({ [FA1]: ['switchport mode dynamic desirable'] }), FA1).mode).toBe('dynamic-desirable');
  });

  it('reads the full access port of §3.1 and the full trunk of §3.2', () => {
    expect(readSwitchport(cfg({ [FA1]: ['switchport mode access', 'switchport access vlan 10'] }), FA1)).toEqual({
      mode: 'access', negotiate: true, accessVlan: 10, nativeVlan: 1, allowed: '1-4094',
    });
    const trunk = cfg({
      [GI1]: ['switchport trunk native vlan 99', 'switchport trunk allowed vlan 1,10,20,99', 'switchport mode trunk'],
    });
    expect(readSwitchport(trunk, GI1)).toEqual({
      mode: 'trunk', negotiate: true, accessVlan: 1, nativeVlan: 99, allowed: '1,10,20,99',
    });
  });

  it('nonegotiate switches negotiation off only in access or trunk mode', () => {
    expect(readSwitchport(cfg({ [GI1]: ['switchport mode trunk', 'switchport nonegotiate'] }), GI1).negotiate).toBe(false);
    expect(readSwitchport(cfg({ [GI1]: ['switchport mode access', 'switchport nonegotiate'] }), GI1).negotiate).toBe(false);
    // the grammar refuses it in dynamic modes; a stale line left behind by a mode change has no effect
    expect(readSwitchport(cfg({ [GI1]: ['switchport nonegotiate'] }), GI1)).toEqual({ ...DEFAULT_SWITCHPORT });
    expect(readSwitchport(cfg({ [GI1]: ['switchport nonegotiate', 'switchport mode dynamic desirable'] }), GI1).negotiate).toBe(true);
  });

  it('the allowed list is canonical: ascending, merged, runs of 3+ as `a-b`, pairs as two ids; none is empty', () => {
    const allowed = (list: string): string => readSwitchport(cfg({ [GI1]: [`switchport trunk allowed vlan ${list}`] }), GI1).allowed;
    expect(allowed('1,10,20,99')).toBe('1,10,20,99');
    expect(allowed('99,20,10,1')).toBe('1,10,20,99');
    expect(allowed('10,11,12,20')).toBe('10-12,20');
    expect(allowed('10,11')).toBe('10,11');
    expect(allowed('10-11,20')).toBe('10,11,20');
    expect(allowed('30-35,10,31-40')).toBe('10,30-40');
    expect(allowed('5,4094,4093,4092')).toBe('5,4092-4094');
    expect(allowed('none')).toBe('');
    expect(allowed('all')).toBe('1-4094');
    expect(allowed('1-4094')).toBe('1-4094');
  });

  it('keyword forms found in a stored line resolve against every VLAN', () => {
    const allowed = (rest: string): string => readSwitchport(cfg({ [GI1]: [`switchport trunk allowed vlan ${rest}`] }), GI1).allowed;
    expect(allowed('add 30')).toBe('1-4094');
    expect(allowed('remove 30')).toBe('1-29,31-4094');
    expect(allowed('except 1-10,4094')).toBe('11-4093');
    expect(allowed('except 3-4094')).toBe('1,2');
  });

  it('ignores lines whose value does not parse and keeps the default', () => {
    const c = cfg({
      [GI1]: [
        'switchport access vlan 0',
        'switchport access vlan 4095',
        'switchport access vlan ten',
        'switchport trunk native vlan 5000',
        'switchport trunk allowed vlan 10-5',
        'switchport trunk allowed vlan 1,,2',
        'switchport mode sideways',
        'switchport mode dynamic',
      ],
    });
    expect(readSwitchport(c, GI1)).toBe(DEFAULT_SWITCHPORT);
  });

  it('the last valid line of a slot wins (a hand-built tree with two lines)', () => {
    const c = cfg({ [FA1]: ['switchport access vlan 10', 'switchport access vlan 20', 'switchport access vlan 9999'] });
    expect(readSwitchport(c, FA1).accessVlan).toBe(20);
  });

  it('reads a stored `switchport` group node the same way (defensive storage form)', () => {
    const root: ConfigNode = {
      key: '', args: [], children: [{
        key: 'interface', args: [FA1], children: [{
          key: 'switchport', args: [], children: [
            { key: 'mode', args: ['access'], children: [] },
            { key: 'access', args: ['vlan', '30'], children: [] },
          ],
        }],
      }],
    };
    expect(readSwitchport(configAstFromJson(root), FA1)).toEqual({
      mode: 'access', negotiate: true, accessVlan: 30, nativeVlan: 1, allowed: '1-4094',
    });
  });

  it('a Port-channel is read from its own section', () => {
    const c = cfg({ 'Port-channel1': ['switchport mode trunk', 'switchport trunk native vlan 99'], [GI1]: ['switchport mode access'] });
    expect(readSwitchport(c, 'Port-channel1')).toEqual({
      mode: 'trunk', negotiate: true, accessVlan: 1, nativeVlan: 99, allowed: '1-4094',
    });
  });

  it('returns frozen values', () => {
    const v = readSwitchport(cfg({ [FA1]: ['switchport mode access'] }), FA1);
    expect(Object.isFrozen(v)).toBe(true);
  });
});

describe('CONTROLLER_PORT_SWITCHPORT (D17)', () => {
  const controller = { capabilities: ['switching', 'wireless-controller'] as const };

  it('every port of a wireless-controller model reads the intrinsic trunk, whatever its section says', () => {
    const c = cfg({ [GI1]: ['switchport mode access', 'switchport access vlan 10'] });
    expect(readSwitchport(c, GI1, controller)).toBe(CONTROLLER_PORT_SWITCHPORT);
    expect(readSwitchport(c, 'GigabitEthernet0/2', controller)).toBe(CONTROLLER_PORT_SWITCHPORT);
    expect(CONTROLLER_PORT_SWITCHPORT).toEqual({ mode: 'trunk', negotiate: false, accessVlan: 1, nativeVlan: 1, allowed: '1-4094' });
    expect(isControllerModel(controller)).toBe(true);
  });

  it('a managed switch (or no model) reads its lines', () => {
    const c = cfg({ [GI1]: ['switchport mode access'] });
    expect(readSwitchport(c, GI1, { capabilities: ['switching', 'managed-switch'] }).mode).toBe('access');
    expect(readSwitchport(c, GI1).mode).toBe('access');
    expect(isControllerModel(undefined)).toBe(false);
  });

  it('readAllSwitchports reads every interface section in one pass', () => {
    const c = cfg({ [FA1]: ['switchport mode access', 'switchport access vlan 10'], [GI1]: ['switchport mode trunk'], Vlan1: ['shutdown'] });
    const all = readAllSwitchports(c);
    expect([...all.keys()]).toEqual([FA1, GI1, 'Vlan1']);
    expect(all.get(FA1)).toEqual(readSwitchport(c, FA1));
    expect(all.get(GI1)).toEqual(readSwitchport(c, GI1));
    expect(all.get('Vlan1')).toBe(DEFAULT_SWITCHPORT);
    const ctl = readAllSwitchports(c, controller);
    expect([...ctl.values()].every((v) => v === CONTROLLER_PORT_SWITCHPORT)).toBe(true);
  });
});

describe('helpers', () => {
  it('trunkAllows reads the canonical list (the native VLAN is not special)', () => {
    const c = readSwitchport(cfg({ [GI1]: ['switchport trunk allowed vlan 10,20-30', 'switchport trunk native vlan 99'] }), GI1);
    expect([1, 9, 10, 11, 20, 25, 30, 31, 99].map((v) => trunkAllows(c, v))).toEqual([false, false, true, false, true, true, true, false, false]);
    expect(trunkAllows(DEFAULT_SWITCHPORT, 1)).toBe(true);
    expect(trunkAllows(DEFAULT_SWITCHPORT, 4094)).toBe(true);
    expect(trunkAllows({ ...DEFAULT_SWITCHPORT, allowed: '' }, 1)).toBe(false);
  });

  it('membership lines are the §3.0 CAM-flush triggers and never a port-security line', () => {
    expect(SWITCHPORT_MEMBERSHIP_PREFIXES.map((p) => p.join(' '))).toEqual([
      'switchport mode', 'switchport access vlan', 'switchport trunk native vlan', 'switchport trunk allowed vlan',
      'switchport voice vlan', 'switchport nonegotiate',
    ]);
    for (const l of [
      'switchport mode access', 'switchport mode dynamic desirable', 'switchport access vlan 10',
      'switchport trunk native vlan 99', 'switchport trunk allowed vlan 1,10', 'switchport voice vlan 20', 'switchport nonegotiate',
    ]) expect(isMembershipLine(l.split(' '))).toBe(true);
    for (const l of [
      'switchport', 'switchport port-security', 'switchport port-security mac-address sticky 02:00:00:00:00:01',
      'switchport port-security maximum 2', 'spanning-tree portfast', 'shutdown', 'switchport access',
    ]) expect(isMembershipLine(l.split(' '))).toBe(false);
  });

  it('interfaceOfContext names the interface of a context', () => {
    expect(interfaceOfContext([['interface', FA1]])).toBe(FA1);
    expect(interfaceOfContext([])).toBeUndefined();
    expect(interfaceOfContext([['vlan', '10']])).toBeUndefined();
  });

  it('mode text and parsing round-trip', () => {
    for (const m of ['access', 'trunk', 'dynamic-auto', 'dynamic-desirable'] as const) {
      expect(parseSwitchportMode(switchportModeText(m).split(' '))).toBe(m);
    }
    expect(switchportModeText('dynamic-auto')).toBe('dynamic auto');
    expect(parseSwitchportMode(['dynamic'])).toBeUndefined();
    expect(parseSwitchportMode(['trunk', 'extra'])).toBeUndefined();
  });
});
