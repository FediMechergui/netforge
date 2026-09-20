import { describe, expect, it } from 'vitest';
import { NF_2911, NF_C2960, NF_PC } from '../src/device/catalog.js';
import {
  CATEGORY_BOOT_NS,
  DEVICE_KINDS,
  HOME_ROUTER_VLAN_FAMILY,
  KIND_HOSTNAME_PREFIX,
  L3_SWITCH_VLAN_FAMILY,
  LOOPBACK_FAMILY,
  defineModel,
  defineModule,
  deriveCliSpec,
  deriveProcesses,
  deriveTables,
  modulePortSpecs,
  type ModelInput,
} from '../src/device/catalog/define.js';
import { validateCatalog } from '../src/device/catalog/validate.js';
import { DEVICE_CATEGORIES, HOST_IP_DEFAULTS, ROUTER_IP_DEFAULTS, type ModuleModel, type SlotSpec } from '../src/contracts/catalog.js';
import type { DeviceModel } from '../src/contracts/device.js';
import { SEC } from '../src/contracts/time.js';
import { NF_2911_INPUT, NF_C2960_INPUT, NF_PC_INPUT, P0_INPUTS, ethInput, ethRangeInput } from './device.catalog.p0-inputs.js';

const P0_FIELDS = ['type', 'model', 'kind', 'description', 'hostnamePrefix', 'portsDefaultUp', 'bootNs', 'ipForwarding', 'processingNs', 'processes', 'defaultConfig'] as const;

const WLAN_RADIO = {
  bands: ['2.4', '5'],
  generations: ['n', 'ac'],
  defaultBand: '5',
  defaultChannel: 36,
  maxTxPowerDbm: 20,
  antennaGainDbi: 3,
  streams: 2,
  maxWidthMhz: 80,
  maxRangeM: 150,
} as const;

/** Daemon lists the three P0 models derive at the earlier stages (the shim entries are CATALOG_STAGE, §9.2). */
const P0_PROCESSES: Record<string, string[]> = {
  'pc.nfpc': ['arp', 'ipv4', 'icmpv4', 'host'],
  'switch.nfc2960': ['eth-switch'],
  'router.nf2911': ['arp', 'ipv4', 'icmpv4'],
};
const P05_PROCESSES: Record<string, string[]> = {
  'pc.nfpc': ['arp', 'ipv4', 'icmpv4', 'host'],
  'switch.nfc2960': ['eth-switch'],
  'router.nf2911': ['hdlc', 'arp', 'ipv4', 'icmpv4'],
};

describe('defineModel: P0 models re-authored', () => {
  const pairs: [DeviceModel, ModelInput][] = [[NF_PC, NF_PC_INPUT], [NF_C2960, NF_C2960_INPUT], [NF_2911, NF_2911_INPUT]];

  it.each(pairs)('%s keeps every P0 field at stage P0', (p0, input) => {
    const m = defineModel(input, 'P0');
    for (const f of P0_FIELDS) {
      // §9.2: the shim entries are derived at CATALOG_STAGE ('P1'); at stage P0 the daemons are the P0 list.
      if (f === 'processes') expect(m.processes).toEqual(P0_PROCESSES[p0.type]);
      else expect(m[f]).toEqual(p0[f]);
    }
    expect(m.ports).toHaveLength(p0.ports.length);
    p0.ports.forEach((port, i) => expect(m.ports[i]).toMatchObject(port));
  });

  it.each(pairs)('%s keeps its P0 fields at P0.5 except the NF-2911 hdlc daemon', (p0, input) => {
    const m = defineModel(input, 'P0.5');
    for (const f of P0_FIELDS) {
      if (f === 'processes') continue;
      expect(m[f]).toEqual(p0[f]);
    }
    expect(m.processes).toEqual(P05_PROCESSES[p0.type]);
  });

  it('fills every P0.5 member for the PC', () => {
    const pc = defineModel(NF_PC_INPUT, 'P0.5');
    expect(pc).toMatchObject({
      category: 'computers',
      family: 'nf-pc',
      variant: 'NF-PC',
      icon: 'pc',
      tags: [],
      capabilities: ['host'],
      cli: { shell: 'host', grammar: 'host', initialPrivilege: 15, consoleVia: ['console'] },
      gui: ['physical', 'desktop.ip-config', 'desktop.command-prompt'],
      slots: [],
      virtualFamilies: [],
      hostPorts: ['GigabitEthernet0'],
      portOwners: {},
      tables: ['cam', 'arp', 'rib'],
      ipDefaults: HOST_IP_DEFAULTS,
    });
    expect(pc.ports[0]).toEqual({
      name: 'GigabitEthernet0', short: 'Gi0', kind: 'ethernet', speedBps: 1_000_000_000,
      speeds: [1_000_000_000, 100_000_000, 10_000_000], autoMdix: false,
      role: 'routed', allowedRoles: ['routed'], encap: 'ethernet', ordinal: 1, connector: 'rj45', wiring: 'MDI', group: 'front',
    });
    expect(pc.poeBudgetW).toBeUndefined();
  });

  it('derives switch and router port data', () => {
    const sw = defineModel(NF_C2960_INPUT, 'P0.5');
    expect(sw.ports.map((p) => p.ordinal)).toEqual(Array.from({ length: 26 }, (_, i) => i + 1));
    expect(sw.ports[25]).toMatchObject({ short: 'Gi0/2', role: 'switched', allowedRoles: ['switched'], wiring: 'MDI-X' });
    expect(sw).toMatchObject({ cli: { shell: 'nfos', grammar: 'nfos', initialPrivilege: 1, consoleVia: ['console', 'vty'] }, gui: ['physical'], virtualFamilies: [], hostPorts: [], ipDefaults: ROUTER_IP_DEFAULTS });

    const rt = defineModel(NF_2911_INPUT, 'P0.5');
    expect(rt.ports.map((p) => [p.name, p.role, p.encap, p.connector, p.ordinal, p.wiring ?? null, p.group])).toEqual([
      ['GigabitEthernet0/0', 'routed', 'ethernet', 'rj45', 1, 'MDI', 'front'],
      ['GigabitEthernet0/1', 'routed', 'ethernet', 'rj45', 2, 'MDI', 'front'],
      ['Serial0/0/0', 'wan', 'hdlc', 'smart-serial', 3, null, 'front'],
      ['Serial0/0/1', 'wan', 'hdlc', 'smart-serial', 4, null, 'front'],
      ['Console', 'console', 'none', 'rj45-console', 5, null, 'console'],
    ]);
    expect(rt.virtualFamilies).toEqual([LOOPBACK_FAMILY]);
    expect(rt.portOwners).toEqual({});
  });

  it('re-authored P0 models validate cleanly', () => {
    expect(validateCatalog(P0_INPUTS.map((i) => defineModel(i, 'P0.5')), [], { stage: 'P0.5' })).toEqual([]);
    expect(validateCatalog(P0_INPUTS.map((i) => defineModel(i, 'P1')), [], { stage: 'P1' })).toEqual([]);
  });
});

describe('defineModel: derivations', () => {
  it('adds the P1 stack, tables and panels at stage P1', () => {
    const pc = defineModel(NF_PC_INPUT, 'P1');
    expect(pc.processes).toEqual(['arp', 'ipv4', 'icmpv4', 'host', 'ipv6', 'nd', 'icmpv6', 'udp', 'tcp', 'dhcp-client', 'dns-client', 'http-client', 'traceroute']);
    expect(pc.tables).toEqual(['cam', 'arp', 'rib', 'rib6', 'nd', 'sockets', 'dns-cache']);
    expect(pc.gui).toEqual(['physical', 'desktop.ip-config', 'desktop.command-prompt', 'desktop.web-browser']);
    const sw = defineModel(NF_C2960_INPUT, 'P1');
    expect(sw.processes).toEqual(['eth-switch', 'arp', 'ipv4', 'icmpv4', 'host']);
    expect(deriveProcesses(['server', 'host'], 'P1')).toContain('http-server');
    expect(deriveTables(['wlan-ap', 'wlan-client', 'dhcp-server'])).toEqual(['cam', 'arp', 'rib', 'dot11-assoc', 'dhcp-bindings']);
  });

  it('multilayer switch: switched ports may route, Vlan1 and Loopback families, SVI owner', () => {
    const m = defineModel(
      {
        type: 'mlswitch.t24',
        model: 'NF-ML-T24',
        description: 'Test multilayer switch',
        category: 'multilayer-switches',
        icon: 'mlswitch',
        capabilities: ['layer3-switch'],
        ports: [...ethRangeInput('GigabitEthernet', '1/0', 1, 2, 1_000_000_000, true), { ...ethInput('GigabitEthernet1/1/1', 1_000_000_000, false), connector: 'sfp' }],
      },
      'P0.5',
    );
    expect(m.capabilities).toEqual(['switching', 'routing', 'layer3-switch']);
    expect(m.processes).toEqual(['hdlc', 'eth-switch', 'arp', 'ipv4', 'icmpv4']);
    expect(m.ports[0]).toMatchObject({ role: 'switched', allowedRoles: ['switched', 'routed'], wiring: 'MDI-X' });
    expect(m.ports[2]?.wiring).toBeUndefined();
    expect(m.virtualFamilies).toEqual([L3_SWITCH_VLAN_FAMILY, LOOPBACK_FAMILY]);
    expect(m.portOwners).toEqual({ svi: 'eth-switch' });
    expect(m.portsDefaultUp).toBe(true);
    expect(m.ipForwarding).toBe(true);
    expect(m.bootNs).toBe(CATEGORY_BOOT_NS['multilayer-switches']);
    expect(m.hostnamePrefix).toBe('MLSwitch');
  });

  it('home router: GUI-only appliance with an auto Vlan1 that starts up', () => {
    const m = defineModel(
      {
        type: 'wrouter.thome',
        model: 'NF-HOME-T',
        description: 'Test home router',
        category: 'home-soho',
        icon: 'home-router',
        capabilities: ['wifi-ap', 'switching', 'routing', 'dhcp-server', 'nat-gateway'],
        ports: [
          { ...ethInput('Internet', 1_000_000_000, false), role: 'wan' },
          ethInput('GigabitEthernet1', 1_000_000_000, true),
          { name: 'Wlan0', kind: 'wlan', speedBps: 300_000_000, radio: WLAN_RADIO },
        ],
      },
      'P0.5',
    );
    expect(m.capabilities).toEqual(['switching', 'routing', 'wifi-ap', 'nat-gateway', 'dhcp-server']);
    expect(m.cli).toEqual({ shell: 'none', grammar: 'nfos', initialPrivilege: 1, consoleVia: [] });
    expect(m.gui).toEqual(['physical', 'home-router.setup']);
    expect(m.processes).toEqual(['wlan-ap', 'hdlc', 'eth-switch', 'arp', 'ipv4', 'icmpv4', 'host']);
    expect(m.tables).toEqual(['cam', 'arp', 'rib', 'dot11-assoc']);
    expect(m.virtualFamilies).toEqual([HOME_ROUTER_VLAN_FAMILY]);
    expect(m.portOwners).toEqual({ svi: 'eth-switch' });
    expect(m.ports.map((p) => [p.short, p.role, p.encap, p.connector, p.wiring ?? null, p.group])).toEqual([
      ['Inet', 'wan', 'ethernet', 'rj45', 'MDI', 'front'],
      ['Gi1', 'switched', 'ethernet', 'rj45', 'MDI-X', 'front'],
      ['Wl0', 'wireless-bss', 'dot11', 'antenna', null, 'radio'],
    ]);
    expect(m.portsDefaultUp).toBe(true);
  });

  it('laptop: host shell, Wi-Fi panel, wired then wireless adapters', () => {
    const m = defineModel(
      {
        type: 'laptop.tl',
        model: 'NF-LAPTOP-T',
        description: 'Test laptop',
        category: 'computers',
        icon: 'laptop',
        tags: ['Portable', 'portable', ' wifi '],
        capabilities: ['host', 'wifi-client'],
        ports: [ethInput('GigabitEthernet0', 1_000_000_000, true), { name: 'Wlan0', kind: 'wlan', speedBps: 300_000_000, radio: WLAN_RADIO }],
      },
      'P0.5',
    );
    expect(m.processes).toEqual(['wlan-client', 'arp', 'ipv4', 'icmpv4', 'host']);
    expect(m.gui).toEqual(['physical', 'desktop.ip-config', 'desktop.wifi', 'desktop.command-prompt']);
    expect(m.hostPorts).toEqual(['GigabitEthernet0', 'Wlan0']);
    expect(m.ports[1]).toMatchObject({ role: 'wireless-client', encap: 'dot11' });
    expect(m.tags).toEqual(['portable', 'wifi']);
    expect(m.tables).toEqual(['cam', 'arp', 'rib', 'dot11-assoc']);
  });

  it('CLI rule table', () => {
    expect(deriveCliSpec(['repeater']).shell).toBe('none');
    expect(deriveCliSpec(['switching', 'modem']).shell).toBe('nfos');
    expect(deriveCliSpec(['modem']).shell).toBe('none');
    expect(deriveCliSpec(['wifi-ap']).shell).toBe('nfos');
    expect(deriveCliSpec(['host', 'switching']).shell).toBe('host');
    expect(deriveCliSpec(['routing', 'firewall']).grammar).toBe('nfos');
  });

  it('input values override derivations', () => {
    const m = defineModel(
      { ...NF_PC_INPUT, hostnamePrefix: 'WS', bootNs: 7 * SEC, portsDefaultUp: false, family: 'nf-pc', variant: 'Tower', gui: ['physical'], hostPorts: [], poeBudgetW: 15, defaultConfig: ['hostname X'] },
      'P0.5',
    );
    expect(m).toMatchObject({ hostnamePrefix: 'WS', bootNs: 7 * SEC, portsDefaultUp: false, variant: 'Tower', gui: ['physical'], hostPorts: [], poeBudgetW: 15, defaultConfig: ['hostname X'] });
  });

  it('has a hostname prefix for every kind and a boot time for every category', () => {
    expect(DEVICE_KINDS).toHaveLength(26);
    for (const k of DEVICE_KINDS) expect(KIND_HOSTNAME_PREFIX[k]).toMatch(/^[A-Za-z]+$/);
    for (const c of DEVICE_CATEGORIES) expect(Number.isSafeInteger(CATEGORY_BOOT_NS[c.id])).toBe(true);
  });

  it('output is deeply frozen and structured-clone / JSON safe', () => {
    const m = defineModel(NF_2911_INPUT, 'P0.5');
    expect(Object.isFrozen(m)).toBe(true);
    expect(Object.isFrozen(m.ports)).toBe(true);
    expect(Object.isFrozen(m.ports[0])).toBe(true);
    expect(Object.isFrozen(m.cli)).toBe(true);
    expect(structuredClone(m)).toEqual(m);
    expect(JSON.parse(JSON.stringify(m))).toEqual(m);
    expect(JSON.stringify(defineModel(NF_2911_INPUT, 'P0.5'))).toBe(JSON.stringify(m));
  });
});

describe('modulePortSpecs', () => {
  const router = defineModel({ ...NF_2911_INPUT, type: 'router.tmod', model: 'NF-TMOD', capabilities: ['routing', 'modular'] }, 'P0.5');
  const ehwic2t: ModuleModel = defineModule({
    type: 'mod.t-2t',
    model: 'NF-T-2T',
    description: 'Two serial ports',
    fits: 'ehwic',
    ports: [{ family: 'Serial', count: 2, spec: { kind: 'serial', speedBps: 2_000_000 } }],
  });

  it('names, numbers and stamps module ports after the slot', () => {
    const slot: SlotSpec = { id: '0/1', label: 'Card slot 1', type: 'ehwic', numbering: '0/1', slotIndex: 1 };
    expect(modulePortSpecs(router, slot, ehwic2t)).toEqual([
      { kind: 'serial', speedBps: 2_000_000, name: 'Serial0/1/0', short: 'Se0/1/0', ordinal: 144, slot: '0/1', module: 'mod.t-2t', group: 'slot:0/1', role: 'wan', allowedRoles: ['wan'], encap: 'hdlc', connector: 'smart-serial' },
      { kind: 'serial', speedBps: 2_000_000, name: 'Serial0/1/1', short: 'Se0/1/1', ordinal: 145, slot: '0/1', module: 'mod.t-2t', group: 'slot:0/1', role: 'wan', allowedRoles: ['wan'], encap: 'hdlc', connector: 'smart-serial' },
    ]);
    const slot0: SlotSpec = { ...slot, id: '0/0', numbering: '0/0', slotIndex: 0 };
    expect(modulePortSpecs(router, slot0, ehwic2t).map((p) => [p.name, p.ordinal])).toEqual([['Serial0/0/0', 128], ['Serial0/0/1', 129]]);
  });

  it('counts ordinals across templates, honours firstIndex, absolute names and added capabilities', () => {
    const pc = defineModel(NF_PC_INPUT, 'P0.5');
    const card = defineModule({
      type: 'mod.t-card',
      model: 'NF-T-CARD',
      description: 'Wireless card',
      fits: 'host-expansion',
      ports: [{ family: 'Wlan', count: 1, absolute: true, spec: { kind: 'wlan', speedBps: 300_000_000, radio: WLAN_RADIO } }],
      capabilitiesAdded: ['wifi-client'],
    });
    const bay: SlotSpec = { id: 'exp0', label: 'Expansion bay', type: 'host-expansion', numbering: '', slotIndex: 0 };
    expect(modulePortSpecs(pc, bay, card)[0]).toMatchObject({ name: 'Wlan0', short: 'Wl0', ordinal: 128, role: 'wireless-client', encap: 'dot11', group: 'slot:exp0' });

    const mixed = defineModule({
      type: 'mod.t-mix',
      model: 'NF-T-MIX',
      description: 'Mixed card',
      fits: 'nim',
      ports: [
        { family: 'GigabitEthernet', count: 2, firstIndex: 1, spec: { kind: 'ethernet', speedBps: 1_000_000_000 } },
        { family: 'Serial', count: 1, spec: { kind: 'serial', speedBps: 2_000_000 } },
      ],
    });
    const nim: SlotSpec = { id: '0/2', label: 'Module slot 2', type: 'nim', numbering: '0/2', slotIndex: 2 };
    expect(modulePortSpecs(router, nim, mixed).map((p) => [p.name, p.ordinal, p.role])).toEqual([
      ['GigabitEthernet0/2/1', 160, 'routed'],
      ['GigabitEthernet0/2/2', 161, 'routed'],
      ['Serial0/2/0', 162, 'wan'],
    ]);
  });

  it('transceivers add no ports; modules are frozen', () => {
    const sfp = defineModule({
      type: 'mod.t-sfp',
      model: 'NF-T-SFP',
      description: 'Fibre transceiver',
      fits: 'sfp',
      ports: [],
      transceiver: { connector: 'lc', mode: 'mm', speedBps: 1_000_000_000, maxLengthM: 550, wavelengthNm: 850 },
    });
    const cage: SlotSpec = { id: 'sfp0', label: 'Cage', type: 'sfp', numbering: '', slotIndex: 0, cage: 'GigabitEthernet0/0' };
    expect(modulePortSpecs(router, cage, sfp)).toEqual([]);
    expect(Object.isFrozen(sfp.transceiver)).toBe(true);
    expect(sfp).not.toHaveProperty('capabilitiesAdded');
  });
});
