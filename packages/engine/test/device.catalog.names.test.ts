import { describe, expect, it } from 'vitest';
import { NF_2911, NF_C2960, NF_PC } from '../src/device/catalog.js';
import {
  canonicalPortName,
  matchPortName,
  modulePortName,
  parseTypedPortName,
  portFamilyOf,
  resolvePortName,
  shortPortName,
  splitPortName,
  virtualPortName,
} from '../src/device/catalog/names.js';
import { defineModel, modulePortSpecs } from '../src/device/catalog/define.js';
import type { DeviceModel, PortNameSource } from '../src/contracts/device.js';
import type { PortSpec } from '../src/contracts/port.js';
import type { ModuleModel } from '../src/contracts/catalog.js';
import { NF_2911_INPUT, NF_C2960_INPUT, NF_PC_INPUT, ethRangeInput } from './device.catalog.p0-inputs.js';

/** A live-device source over explicit specs (fixed + module + virtual). */
function sourceOf(model: DeviceModel, specs: readonly Pick<PortSpec, 'name' | 'short'>[]): PortNameSource {
  return { model, ports: new Map(specs.map((s) => [s.name, { spec: s }])) };
}

describe('device/catalog/names canonicalPortName (P0 canonicalPort table, verbatim)', () => {
  const cases: [typeof NF_PC, string, string | undefined][] = [
    [NF_2911, 'GigabitEthernet0/0', 'GigabitEthernet0/0'],
    [NF_2911, 'gigabitethernet0/1', 'GigabitEthernet0/1'],
    [NF_2911, 'GigabitEthernet 0/0', 'GigabitEthernet0/0'],
    [NF_2911, 'Gi0/0', 'GigabitEthernet0/0'],
    [NF_2911, 'gi 0/1', 'GigabitEthernet0/1'],
    [NF_2911, 'g0/0', 'GigabitEthernet0/0'],
    [NF_2911, 'GIG0/1', 'GigabitEthernet0/1'],
    [NF_2911, 'Gi0/2', undefined],
    [NF_2911, 's0/0/0', 'Serial0/0/0'],
    [NF_2911, 'Se0/0/1', 'Serial0/0/1'],
    [NF_2911, 'Serial 0/0/1', 'Serial0/0/1'],
    [NF_2911, 'serial0/0/2', undefined],
    [NF_2911, 'con', 'Console'],
    [NF_2911, 'Console', 'Console'],
    [NF_2911, 'console0', undefined],
    [NF_2911, 'Gi', undefined],
    [NF_2911, '0/0', undefined],
    [NF_2911, 'Gi0/0/0', undefined],
    [NF_2911, 'FastEthernet0/1', undefined],
    [NF_2911, '', undefined],
    [NF_C2960, 'fa0/1', 'FastEthernet0/1'],
    [NF_C2960, 'F0/24', 'FastEthernet0/24'],
    [NF_C2960, 'Fa 0/1', 'FastEthernet0/1'],
    [NF_C2960, 'fas0/2', 'FastEthernet0/2'],
    [NF_C2960, 'fa0/25', undefined],
    [NF_C2960, 'gi0/1', 'GigabitEthernet0/1'],
    [NF_C2960, 'g0/2', 'GigabitEthernet0/2'],
    [NF_C2960, 'gi0/3', undefined],
    [NF_C2960, 'fa1', undefined],
    [NF_PC, 'Gi0', 'GigabitEthernet0'],
    [NF_PC, 'g0', 'GigabitEthernet0'],
    [NF_PC, 'GigabitEthernet0', 'GigabitEthernet0'],
    [NF_PC, 'gigabitethernet 0', 'GigabitEthernet0'],
    [NF_PC, 'Gi0/0', undefined],
    [NF_PC, 'fa0', undefined],
  ];

  it.each(cases)('%o: %s → %s', (model, input, expected) => {
    expect(canonicalPortName(model, input)).toBe(expected);
  });

  const defined = new Map<string, DeviceModel>(
    [NF_PC_INPUT, NF_C2960_INPUT, NF_2911_INPUT].map((i) => [i.type, defineModel(i, 'P0.5')]),
  );
  it.each(cases)('re-authored %o: %s → %s', (model, input, expected) => {
    const m = defined.get(model.type) as DeviceModel;
    expect(canonicalPortName(m, input)).toBe(expected);
    const live = resolvePortName(sourceOf(m, m.ports), input);
    if (expected === undefined) expect(live.kind === 'existing').toBe(false);
    else expect(live).toEqual({ kind: 'existing', port: expected });
  });

  it('trims surrounding whitespace like the P0 catalog', () => {
    expect(canonicalPortName(NF_2911, ' gi0/0 ')).toBe('GigabitEthernet0/0');
  });
});

describe('device/catalog/names helpers', () => {
  it('splits typed and canonical names', () => {
    expect(parseTypedPortName(' Fa 0/1 ')).toEqual({ family: 'fa', number: '0/1' });
    expect(parseTypedPortName('Console')).toEqual({ family: 'console', number: '' });
    expect(parseTypedPortName('0/1')).toBeUndefined();
    expect(parseTypedPortName('Gi0/0-1')).toBeUndefined();
    expect(splitPortName('TenGigabitEthernet1/1/4')).toEqual({ family: 'TenGigabitEthernet', number: '1/1/4' });
    expect(splitPortName('Gi 0')).toBeUndefined();
  });

  it('maps canonical names to PORT_FAMILIES and short forms', () => {
    expect(portFamilyOf('Internet')).toMatchObject({ long: 'Internet', short: 'Inet', kind: 'ethernet' });
    expect(portFamilyOf('Wlan0')?.kind).toBe('wlan');
    expect(portFamilyOf('Gig0')).toBeUndefined();
    expect(shortPortName('GigabitEthernet1/0/24')).toBe('Gi1/0/24');
    expect(shortPortName('Coax3')).toBe('Cx3');
    expect(shortPortName('Aux')).toBe('Aux');
    expect(shortPortName('Bogus0')).toBeUndefined();
  });

  it('names module and virtual ports', () => {
    expect(modulePortName('Serial', { numbering: '0/1' }, 0, false)).toBe('Serial0/1/0');
    expect(modulePortName('Wlan', { numbering: '0/1' }, 0, true)).toBe('Wlan0');
    expect(modulePortName('Wlan', { numbering: '' }, 2, false)).toBe('Wlan2');
    expect(virtualPortName({ family: 'Loopback' }, 7)).toBe('Loopback7');
  });

  it('prefers an exact family match over a prefix match', () => {
    const ports = [
      { name: 'Ethernet1/1', short: 'Et1/1' },
      { name: 'Ethernetxyz1/1', short: 'Ex1/1' },
    ];
    expect(matchPortName(ports, 'ethernet1/1')).toEqual({ kind: 'existing', port: 'Ethernet1/1' });
    expect(matchPortName(ports, 'eth1/1')).toEqual({ kind: 'ambiguous', candidates: ['Ethernet1/1', 'Ethernetxyz1/1'] });
    expect(matchPortName(ports, 'ex1/1')).toEqual({ kind: 'existing', port: 'Ethernetxyz1/1' });
  });

  it('matches short families that are not prefixes of the long family', () => {
    const ports = [{ name: 'Internet', short: 'Inet' }, { name: 'Coax0', short: 'Cx0' }, { name: 'Cellular0', short: 'Ce0' }];
    expect(matchPortName(ports, 'inet')).toEqual({ kind: 'existing', port: 'Internet' });
    expect(matchPortName(ports, 'cx0')).toEqual({ kind: 'existing', port: 'Coax0' });
    expect(matchPortName(ports, 'c0')).toEqual({ kind: 'ambiguous', candidates: ['Coax0', 'Cellular0'] });
  });
});

describe('device/catalog/names resolvePortName (fixed, module, virtual)', () => {
  const l3 = defineModel(
    {
      type: 'mlswitch.test',
      model: 'NF-ML-TEST',
      description: 'Test multilayer switch',
      category: 'multilayer-switches',
      icon: 'mlswitch',
      capabilities: ['layer3-switch'],
      ports: ethRangeInput('GigabitEthernet', '1/0', 1, 4, 1_000_000_000, true),
    },
    'P0.5',
  );

  it('resolves fixed ports and creatable virtual interfaces', () => {
    const src = sourceOf(l3, l3.ports);
    expect(resolvePortName(src, 'gi1/0/4')).toEqual({ kind: 'existing', port: 'GigabitEthernet1/0/4' });
    expect(resolvePortName(src, 'vlan 1')).toEqual({ kind: 'virtual', port: 'Vlan1', family: 'Vlan' });
    expect(resolvePortName(src, 'Vl10')).toEqual({ kind: 'virtual', port: 'Vlan10', family: 'Vlan' });
    expect(resolvePortName(src, 'lo0')).toEqual({ kind: 'virtual', port: 'Loopback0', family: 'Loopback' });
    expect(resolvePortName(src, 'loopback007')).toEqual({ kind: 'virtual', port: 'Loopback7', family: 'Loopback' });
    expect(resolvePortName(src, 'vlan0')).toEqual({ kind: 'unknown' });
    expect(resolvePortName(src, 'vlan4095')).toEqual({ kind: 'unknown' });
    expect(resolvePortName(src, 'vlan1/1')).toEqual({ kind: 'unknown' });
    expect(resolvePortName(src, 'gi1/0/9')).toEqual({ kind: 'unknown' });
    expect(resolvePortName(src, '???')).toEqual({ kind: 'unknown' });
  });

  it('reports an already created virtual port as existing, even with leading zeros', () => {
    const src = sourceOf(l3, [...l3.ports, { name: 'Vlan1', short: 'Vl1' }]);
    expect(resolvePortName(src, 'interface'.slice(0, 0) + 'vlan1')).toEqual({ kind: 'existing', port: 'Vlan1' });
    expect(resolvePortName(src, 'vlan01')).toEqual({ kind: 'existing', port: 'Vlan1' });
  });

  it('resolves module ports present in the live map', () => {
    const router = defineModel({ ...NF_2911_INPUT, type: 'router.test', model: 'NF-RT-TEST', capabilities: ['routing', 'modular'] }, 'P0.5');
    const module: ModuleModel = {
      type: 'mod.test-2t',
      model: 'NF-TEST-2T',
      description: 'Two serial ports',
      fits: 'ehwic',
      ports: [{ family: 'Serial', count: 2, spec: { kind: 'serial', speedBps: 2_000_000 } }],
    };
    const slot = { id: '0/1', label: 'Card slot 1', type: 'ehwic' as const, numbering: '0/1', slotIndex: 1 };
    const src = sourceOf(router, [...router.ports, ...modulePortSpecs(router, slot, module)]);
    expect(resolvePortName(src, 'se0/1/1')).toEqual({ kind: 'existing', port: 'Serial0/1/1' });
    expect(resolvePortName(src, 's0/0/0')).toEqual({ kind: 'existing', port: 'Serial0/0/0' });
    expect(resolvePortName(sourceOf(router, router.ports), 'se0/1/1')).toEqual({ kind: 'unknown' });
  });

  it('reports ambiguity between virtual families sharing a prefix', () => {
    const odd: DeviceModel = {
      ...l3,
      virtualFamilies: [
        { family: 'Vlan', short: 'Vl', role: 'svi', min: 1, max: 10, defaultAdminUp: false },
        { family: 'Vlanx', short: 'Vx', role: 'svi', min: 1, max: 10, defaultAdminUp: false },
      ],
    };
    expect(resolvePortName(sourceOf(odd, odd.ports), 'vla2')).toEqual({ kind: 'ambiguous', candidates: ['Vlan2', 'Vlanx2'] });
    expect(resolvePortName(sourceOf(odd, odd.ports), 'vlan2')).toEqual({ kind: 'virtual', port: 'Vlan2', family: 'Vlan' });
  });

  it('never creates virtual ports on models without families (P0 literal models)', () => {
    // The shim's NF-2911 is now the catalog entry with a derived Loopback family; a P0 literal has none.
    const p0Literal: DeviceModel = { ...NF_2911, virtualFamilies: [] };
    expect(resolvePortName(sourceOf(p0Literal, p0Literal.ports), 'loopback0')).toEqual({ kind: 'unknown' });
    expect(resolvePortName(sourceOf(NF_2911, NF_2911.ports), 'loopback0')).toEqual({ kind: 'virtual', port: 'Loopback0', family: 'Loopback' });
  });
});
