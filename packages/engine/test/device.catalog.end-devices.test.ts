import { describe, expect, it } from 'vitest';
import { NF_PC } from '../src/device/catalog.js';
import { defineModule, modulePortSpecs } from '../src/device/catalog/define.js';
import { findBannedWords, jsonCloneProblem, validateCatalog } from '../src/device/catalog/validate.js';
import {
  CELLULAR_UE_RADIO,
  COMPUTER_MODELS,
  END_DEVICE_STAGE,
  WIFI4_IOT_RADIO,
  WIFI5_COMPUTER_RADIO,
  WIFI6_HANDHELD_RADIO,
  hostSpeeds,
  radioTopRateBps,
} from '../src/device/catalog/computers.js';
import { SERVER_MODELS } from '../src/device/catalog/servers.js';
import { MOBILE_MODELS } from '../src/device/catalog/mobile.js';
import { VOICE_MODELS } from '../src/device/catalog/voice.js';
import { HOME_END_DEVICE_MODELS, PERIPHERAL_MODELS } from '../src/device/catalog/peripherals.js';
import { IOT_MODELS } from '../src/device/catalog/iot.js';
import { DEVICE_CATEGORIES, HOST_IP_DEFAULTS, type ModuleModel } from '../src/contracts/catalog.js';
import type { DeviceModel } from '../src/contracts/device.js';
import { SPEED_100M, SPEED_10G, SPEED_10M, SPEED_1G } from '../src/contracts/port.js';

const ALL: readonly DeviceModel[] = [
  ...COMPUTER_MODELS,
  ...SERVER_MODELS,
  ...MOBILE_MODELS,
  ...VOICE_MODELS,
  ...PERIPHERAL_MODELS,
  ...HOME_END_DEVICE_MODELS,
  ...IOT_MODELS,
];

/** A host-expansion Wi-Fi card fixture (the real one lives in modules.ts, another W2 file). */
const WLAN_CARD: ModuleModel = defineModule({
  type: 'mod.test-wlan-card',
  model: 'NF-TEST-WLAN-CARD',
  description: 'Test wireless expansion card',
  fits: 'host-expansion',
  ports: [{ family: 'Wlan', count: 1, absolute: true, spec: { kind: 'wlan', speedBps: 780_000_000, radio: WIFI5_COMPUTER_RADIO } }],
  capabilitiesAdded: ['wifi-client'],
});

/** docs/CATALOG.md "End devices": id → [category, declared capabilities (expanded), fixed port short names]. */
const CATALOG_TABLE: Record<string, [string, string[], string[]]> = {
  'pc.nfpc': ['computers', ['host'], ['Gi0']],
  'pc.nfpc-wifi': ['computers', ['host', 'wifi-client'], ['Gi0', 'Wl0']],
  'laptop.nflaptop': ['computers', ['host', 'wifi-client'], ['Gi0', 'Wl0', 'Usb0']],
  'server.nfserver': ['servers', ['host', 'server'], ['Gi0', 'Gi1']],
  'server.nfrack': ['servers', ['host', 'server'], ['Gi0', 'Gi1', 'Gi2', 'Gi3', 'Te0', 'Te1']],
  'phone.nfsmartphone': ['mobile', ['host', 'wifi-client', 'cellular-client'], ['Wl0', 'Ce0']],
  'tablet.nftablet': ['mobile', ['host', 'wifi-client'], ['Wl0']],
  'tablet.nftablet-lte': ['mobile', ['host', 'wifi-client', 'cellular-client'], ['Wl0', 'Ce0']],
  'ipphone.nfphone': ['voice', ['host', 'switching', 'poe-powered'], ['Fa0', 'Fa1']],
  'printer.nfprinter': ['peripherals', ['host', 'wifi-client'], ['Fa0', 'Wl0']],
  'tv.nfsmarttv': ['home-soho', ['host', 'wifi-client'], ['Fa0', 'Wl0']],
  'iot.nfsensor': ['iot', ['host', 'wifi-client'], ['Wl0']],
  'iot.nfcamera': ['iot', ['host', 'poe-powered'], ['Fa0']],
  'iot.nfthermostat': ['iot', ['host', 'wifi-client'], ['Wl0']],
  'iot.nfplug': ['iot', ['host', 'wifi-client'], ['Wl0']],
  'iot.nfgateway': ['iot', ['host', 'wifi-client'], ['Gi0', 'Wl0']],
};

/** Daemons the `host` capability contributes at P1, in PROCESS_ORDER. */
const HOST_STACK = ['arp', 'ipv4', 'icmpv4', 'host', 'ipv6', 'nd', 'icmpv6', 'udp', 'tcp', 'dhcp-client', 'dns-client', 'http-client', 'traceroute'];

const byType = (type: string): DeviceModel => {
  const m = ALL.find((x) => x.type === type);
  if (!m) throw new Error(`missing ${type}`);
  return m;
};

describe('end-device catalog data', () => {
  it('validates with zero issues at the end-device stage (with a host-expansion card in the module list)', () => {
    expect(END_DEVICE_STAGE).toBe('P1');
    expect(validateCatalog(ALL, [WLAN_CARD], { stage: END_DEVICE_STAGE })).toEqual([]);
  });

  it('covers exactly the end devices of docs/CATALOG.md with their categories, capabilities and ports', () => {
    expect(ALL.map((m) => m.type).sort()).toEqual(Object.keys(CATALOG_TABLE).sort());
    for (const [type, [category, caps, shorts]] of Object.entries(CATALOG_TABLE)) {
      const m = byType(type);
      expect(m.category, type).toBe(category);
      expect([...(m.capabilities ?? [])].sort(), type).toEqual([...caps].sort());
      expect(m.ports.map((p) => p.short), type).toEqual(shorts);
      expect(m.model.startsWith('NF-'), type).toBe(true);
    }
  });

  it('keeps every category in the end-devices group except the television (Home & SOHO)', () => {
    for (const m of ALL) {
      const group = DEVICE_CATEGORIES.find((c) => c.id === m.category)?.group;
      expect(group, m.type).toBe(m.type === 'tv.nfsmarttv' ? 'network' : 'end-devices');
    }
  });

  it('keeps the P0 NF-PC identity, port and daemons', () => {
    const pc = byType('pc.nfpc');
    for (const f of ['type', 'model', 'kind', 'description', 'hostnamePrefix', 'portsDefaultUp', 'bootNs', 'ipForwarding', 'processingNs', 'processes', 'defaultConfig'] as const) {
      expect(pc[f], f).toEqual(NF_PC[f]);
    }
    expect(pc.ports).toHaveLength(1);
    expect(pc.ports[0]).toMatchObject(NF_PC.ports[0] as object);
    expect(pc.ports[0]).toMatchObject({ role: 'routed', ordinal: 1, wiring: 'MDI', connector: 'rj45', encap: 'ethernet' });
    expect(pc.hostPorts).toEqual(['GigabitEthernet0']);
    expect(pc.slots).toEqual([{ id: 'exp0', label: 'Expansion card bay', type: 'host-expansion', numbering: '', slotIndex: 0 }]);
  });

  it('the expansion bay turns the Wi-Fi card into a wireless client adapter', () => {
    const pc = byType('pc.nfpc');
    const slot = pc.slots?.[0];
    if (!slot) throw new Error('no slot');
    expect(modulePortSpecs(pc, slot, WLAN_CARD)[0]).toMatchObject({ name: 'Wlan0', short: 'Wl0', role: 'wireless-client', encap: 'dot11', ordinal: 128 });
  });

  it('every end device is a host shell end system with host IP defaults and at least one adapter', () => {
    for (const m of ALL) {
      expect(m.cli, m.type).toEqual({ shell: 'host', grammar: 'host', initialPrivilege: 15, consoleVia: ['console'] });
      expect(m.ipDefaults, m.type).toEqual(HOST_IP_DEFAULTS);
      expect(m.ipForwarding, m.type).toBe(false);
      expect(m.portsDefaultUp, m.type).toBe(true);
      expect((m.hostPorts ?? []).length, m.type).toBeGreaterThan(0);
      // §8.2 W5: the catalog is derived at 'P1', so every end device runs the whole host stack in PROCESS_ORDER
      expect(m.processes.filter((x) => HOST_STACK.includes(x)), m.type).toEqual(HOST_STACK);
    }
  });

  it('Wi-Fi and cellular clients get their daemons, roles and desktop panels', () => {
    const phone = byType('phone.nfsmartphone');
    expect(phone.processes).toEqual(['wlan-client', 'cell-client', ...HOST_STACK]);
    expect(phone.ports.map((p) => [p.name, p.role, p.encap, p.group])).toEqual([
      ['Wlan0', 'wireless-client', 'dot11', 'radio'],
      ['Cellular0', 'cellular', 'ethernet', 'radio'],
    ]);
    expect(phone.hostPorts).toEqual(['Wlan0', 'Cellular0']);
    expect(phone.gui).toEqual(['physical', 'desktop.ip-config', 'desktop.wifi', 'desktop.cellular', 'desktop.command-prompt', 'desktop.web-browser']);
    const laptop = byType('laptop.nflaptop');
    expect(laptop.processes).toEqual(['wlan-client', ...HOST_STACK]);
    expect(laptop.hostPorts).toEqual(['GigabitEthernet0', 'Wlan0']);
    expect(laptop.gui).toEqual(['physical', 'desktop.ip-config', 'desktop.wifi', 'desktop.command-prompt', 'desktop.web-browser']);
  });

  it('the IP phone bridges its two ports and addresses its auto Vlan1', () => {
    const ph = byType('ipphone.nfphone');
    expect(ph.processes).toEqual(['eth-switch', ...HOST_STACK]);
    expect(ph.ports.map((p) => [p.name, p.role, p.wiring, p.autoMdix])).toEqual([
      ['FastEthernet0', 'switched', 'MDI', false],
      ['FastEthernet1', 'switched', 'MDI-X', false],
    ]);
    expect(ph.ports[0]?.poe).toEqual({ pd: { standard: 'af', drawW: 6.5 } });
    expect(ph.ports[1]?.poe).toBeUndefined();
    expect(ph.virtualFamilies).toEqual([{ family: 'Vlan', short: 'Vl', role: 'svi', min: 1, max: 1, defaultAdminUp: true, auto: [1] }]);
    expect(ph.hostPorts).toEqual(['Vlan1']);
    expect(ph.portOwners).toEqual({ svi: 'eth-switch' });
    expect(ph.poeBudgetW).toBeUndefined();
  });

  it('the camera draws PoE and servers expose all adapters', () => {
    expect(byType('iot.nfcamera').ports[0]?.poe).toEqual({ pd: { standard: 'af', drawW: 5 } });
    const rack = byType('server.nfrack');
    expect(rack.hostPorts).toEqual(['GigabitEthernet0', 'GigabitEthernet1', 'GigabitEthernet2', 'GigabitEthernet3', 'TenGigabitEthernet0', 'TenGigabitEthernet1']);
    expect(rack.ports[4]).toMatchObject({ speedBps: SPEED_10G, speeds: [SPEED_10G, SPEED_1G, SPEED_100M], group: 'uplink' });
    expect(rack.processes).toEqual(['arp', 'ipv4', 'icmpv4', 'host', 'ipv6', 'nd', 'icmpv6', 'udp', 'tcp', 'dhcp-client', 'dhcp-server', 'dns-client', 'dns-server', 'http-client', 'http-server', 'traceroute']);
  });

  it('derives nominal radio rates from the rate tables', () => {
    expect(radioTopRateBps(WIFI5_COMPUTER_RADIO)).toBe(780_300_000);
    expect(radioTopRateBps(WIFI6_HANDHELD_RADIO)).toBe(1_290_600_000);
    expect(radioTopRateBps(WIFI4_IOT_RADIO)).toBe(65_000_000);
    expect(radioTopRateBps(CELLULAR_UE_RADIO)).toBe(220_000_000);
    expect(hostSpeeds(SPEED_100M)).toEqual([SPEED_100M, SPEED_10M]);
  });

  it('is frozen, JSON-cloneable, uses unique hostnames prefixes that validate and original wording', () => {
    for (const m of ALL) {
      expect(Object.isFrozen(m), m.type).toBe(true);
      expect(Object.isFrozen(m.ports[0]), m.type).toBe(true);
      expect(jsonCloneProblem(m), m.type).toBeUndefined();
      expect(JSON.parse(JSON.stringify(m)), m.type).toEqual(m);
      for (const text of [m.model, m.description, m.hostnamePrefix, ...(m.tags ?? [])]) expect(findBannedWords(text), text).toEqual([]);
    }
  });
});
