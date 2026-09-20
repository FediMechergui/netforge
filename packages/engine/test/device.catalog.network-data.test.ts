import { describe, expect, it } from 'vitest';
import { NF_2911, NF_C2960 } from '../src/device/catalog.js';
import { defineModel, modulePortSpecs, type ModelInput } from '../src/device/catalog/define.js';
import { validateCatalog, findBannedWords, formatCatalogIssues } from '../src/device/catalog/validate.js';
import { ROUTER_INPUTS, ROUTER_MODELS } from '../src/device/catalog/routers.js';
import { SWITCH_INPUTS, SWITCH_MODELS } from '../src/device/catalog/switches.js';
import { MULTILAYER_INPUTS, MULTILAYER_MODELS } from '../src/device/catalog/multilayer.js';
import { DATACENTRE_INPUTS, DATACENTRE_MODELS } from '../src/device/catalog/datacentre.js';
import { LEGACY_INPUTS, LEGACY_MODELS } from '../src/device/catalog/legacy.js';
import { SECURITY_INPUTS, SECURITY_MODELS } from '../src/device/catalog/security.js';
import { MODULE_MODELS } from '../src/device/catalog/modules.js';
import { DEVICE_CATEGORIES, MAX_SLOTS, SLOT_ACCEPTS, type DeviceCategory } from '../src/contracts/catalog.js';
import type { DeviceModel } from '../src/contracts/device.js';

const GROUPS: [DeviceCategory, readonly ModelInput[], readonly DeviceModel[]][] = [
  ['routers', ROUTER_INPUTS, ROUTER_MODELS],
  ['switches', SWITCH_INPUTS, SWITCH_MODELS],
  ['multilayer-switches', MULTILAYER_INPUTS, MULTILAYER_MODELS],
  ['data-centre', DATACENTRE_INPUTS, DATACENTRE_MODELS],
  ['legacy', LEGACY_INPUTS, LEGACY_MODELS],
  ['security', SECURITY_INPUTS, SECURITY_MODELS],
];
const MODELS: readonly DeviceModel[] = GROUPS.flatMap(([, , m]) => m);
const byType = (type: string): DeviceModel => {
  const m = MODELS.find((x) => x.type === type);
  if (!m) throw new Error(`missing ${type}`);
  return m;
};
const names = (type: string): string[] => byType(type).ports.map((p) => p.name);
const seq = (family: string, prefix: string, first: number, count: number): string[] => Array.from({ length: count }, (_, i) => `${family}${prefix}${first + i}`);

describe('network catalog data (routers, switches, multilayer, data centre, legacy, security, modules)', () => {
  it('validates with zero issues at P0.5 and at P1', () => {
    // §8.2 W5: the exported arrays are derived at 'P1'; the same inputs must also validate at P0.5.
    const p05 = GROUPS.flatMap(([, inputs]) => inputs.map((i) => defineModel(i, 'P0.5')));
    expect(formatCatalogIssues(validateCatalog(p05, MODULE_MODELS, { stage: 'P0.5' }))).toBe('');
    expect(formatCatalogIssues(validateCatalog(MODELS, MODULE_MODELS, { stage: 'P1' }))).toBe('');
  });

  it('lists every CATALOG.md model in order, each in its category, arrays equal to their inputs', () => {
    expect(MODELS.map((m) => m.type)).toEqual([
      'router.nf1941', 'router.nf2911', 'router.nf4331', 'router.nf4451', 'router.nfgeneric',
      'switch.nfc2960-8', 'switch.nfc2960', 'switch.nfc2960-48', 'switch.nfc2960-24pg', 'switch.nfc9200-48',
      'mlswitch.nfc3650-24', 'mlswitch.nfc9300-48',
      'dcswitch.nfn9k-48', 'dcswitch.nfn9k-32',
      'hub.nfhub4', 'hub.nfhub8', 'hub.nfcoax', 'repeater.nfrep', 'bridge.nfbr2', 'bridge.nfbr4',
      'firewall.nfasa5506', 'firewall.nfngfw1120', 'ids.nfsensor',
    ]);
    expect(MODELS.map((m) => m.model)).toEqual([
      'NF-1941', 'NF-2911', 'NF-4331', 'NF-4451', 'NF-RTR-EMPTY',
      'NF-C2960-8TC', 'NF-C2960', 'NF-C2960-48TT', 'NF-C2960-24PG', 'NF-C9200-48P',
      'NF-C3650-24', 'NF-C9300-48U', 'NF-N9K-48X', 'NF-N9K-32F',
      'NF-HUB-4', 'NF-HUB-8', 'NF-COAX-TAP', 'NF-REPEATER', 'NF-BRIDGE-2', 'NF-BRIDGE-4',
      'NF-FW-5506', 'NF-NGFW-1120', 'NF-IDS-SENSOR',
    ]);
    for (const [category, inputs, models] of GROUPS) {
      expect(DEVICE_CATEGORIES.some((c) => c.id === category)).toBe(true);
      expect(models).toHaveLength(inputs.length);
      models.forEach((m, i) => {
        expect(m.category).toBe(category);
        expect(m).toEqual(defineModel(inputs[i] as ModelInput, 'P1'));
        expect(Object.isFrozen(m)).toBe(true);
        expect(JSON.parse(JSON.stringify(m))).toEqual(m);
      });
    }
  });

  it('keeps the P0 NF-2911 and NF-C2960 fields (NF-2911 gains hdlc at P0.5)', () => {
    const fields = ['type', 'model', 'kind', 'description', 'hostnamePrefix', 'portsDefaultUp', 'bootNs', 'ipForwarding', 'processingNs'] as const;
    for (const p0 of [NF_2911, NF_C2960]) {
      const m = byType(p0.type);
      for (const f of fields) expect(m[f]).toEqual(p0[f]);
      expect(m.ports).toHaveLength(p0.ports.length);
      p0.ports.forEach((port, i) => expect(m.ports[i]).toMatchObject(port));
    }
    expect(byType('router.nf2911').processes).toEqual(['hdlc', 'arp', 'ipv4', 'icmpv4', 'ipv6', 'nd', 'icmpv6', 'udp', 'tcp', 'dhcp-client', 'dhcp-server', 'dns-client', 'dns-server', 'http-server', 'traceroute']);
    expect(byType('switch.nfc2960').processes).toEqual(['eth-switch', 'arp', 'ipv4', 'icmpv4', 'host']);
  });

  it('has the CATALOG.md port lists', () => {
    expect(names('router.nf1941')).toEqual(['GigabitEthernet0/0', 'GigabitEthernet0/1', 'Console', 'Aux']);
    expect(names('router.nf4331')).toEqual([...seq('GigabitEthernet', '0/0/', 0, 3), 'Console', 'Aux']);
    expect(names('router.nf4451')).toEqual([...seq('GigabitEthernet', '0/0/', 0, 4), 'TenGigabitEthernet0/1/0', 'TenGigabitEthernet0/1/1', 'Console']);
    expect(names('router.nfgeneric')).toEqual(['Console']);
    expect(names('switch.nfc2960-8')).toEqual([...seq('FastEthernet', '0/', 1, 8), 'GigabitEthernet0/1']);
    expect(names('switch.nfc2960-48')).toEqual([...seq('FastEthernet', '0/', 1, 48), ...seq('GigabitEthernet', '0/', 1, 2)]);
    expect(names('switch.nfc2960-24pg')).toEqual(seq('GigabitEthernet', '0/', 1, 28));
    expect(names('switch.nfc9200-48')).toEqual([...seq('GigabitEthernet', '1/0/', 1, 48), ...seq('TenGigabitEthernet', '1/1/', 1, 4)]);
    expect(names('mlswitch.nfc3650-24')).toEqual([...seq('GigabitEthernet', '1/0/', 1, 24), ...seq('GigabitEthernet', '1/1/', 1, 4)]);
    expect(names('mlswitch.nfc9300-48')).toEqual([...seq('GigabitEthernet', '1/0/', 1, 48), ...seq('TenGigabitEthernet', '1/1/', 1, 8)]);
    expect(names('dcswitch.nfn9k-48')).toEqual([...seq('Ethernet', '1/', 1, 48), ...seq('FortyGigabitEthernet', '1/', 49, 6)]);
    expect(names('dcswitch.nfn9k-32')).toEqual(seq('FortyGigabitEthernet', '1/', 1, 32));
    expect(names('hub.nfhub4')).toEqual(seq('Ethernet', '', 0, 4));
    expect(names('hub.nfhub8')).toEqual(seq('Ethernet', '', 0, 8));
    expect(names('hub.nfcoax')).toEqual(seq('Coax', '', 0, 4));
    expect(names('repeater.nfrep')).toEqual(seq('Ethernet', '', 0, 2));
    expect(names('bridge.nfbr2')).toEqual(seq('Ethernet', '', 0, 2));
    expect(names('bridge.nfbr4')).toEqual(seq('Ethernet', '', 0, 4));
    expect(names('firewall.nfasa5506')).toEqual([...seq('GigabitEthernet', '1/', 1, 8), 'Console']);
    expect(names('firewall.nfngfw1120')).toEqual([...seq('GigabitEthernet', '1/', 1, 12), 'Console']);
    expect(names('ids.nfsensor')).toEqual(seq('GigabitEthernet', '0/', 0, 3));
    expect(byType('dcswitch.nfn9k-48').ports[0]?.speedBps).toBe(10_000_000_000);
    expect(byType('dcswitch.nfn9k-32').ports[0]?.speedBps).toBe(40_000_000_000);
  });

  it('derives the expected capabilities, daemons, CLI and roles', () => {
    const summary = (type: string): unknown => {
      const m = byType(type);
      return { caps: m.capabilities, processes: m.processes, shell: m.cli?.shell, gui: m.gui, families: m.virtualFamilies?.map((f) => f.family), up: m.portsDefaultUp };
    };
    expect(summary('router.nf1941')).toEqual({ caps: ['routing', 'modular'], processes: ['hdlc', 'arp', 'ipv4', 'icmpv4', 'ipv6', 'nd', 'icmpv6', 'udp', 'tcp', 'dhcp-client', 'dhcp-server', 'dns-client', 'dns-server', 'http-server', 'traceroute'], shell: 'nfos', gui: ['physical'], families: ['Vlan', 'Loopback'], up: false });
    expect(summary('mlswitch.nfc9300-48')).toEqual({ caps: ['switching', 'routing', 'layer3-switch', 'poe-source'], processes: ['hdlc', 'eth-switch', 'arp', 'ipv4', 'icmpv4', 'host', 'ipv6', 'nd', 'icmpv6', 'udp', 'tcp', 'dhcp-client', 'dhcp-server', 'dns-client', 'dns-server', 'http-server', 'traceroute'], shell: 'nfos', gui: ['physical'], families: ['Vlan', 'Loopback'], up: true });
    expect(summary('hub.nfhub8')).toEqual({ caps: ['repeater'], processes: [], shell: 'none', gui: ['physical'], families: [], up: true });
    // P1 W5 (catalog): everything that bridges and boots the host stack carries the management Vlan1 family, so a
    // bridge can take a management address like an access switch (§9.2 "L2 switches and APs get the Vlan family").
    expect(summary('bridge.nfbr4')).toEqual({ caps: ['switching'], processes: ['eth-switch', 'arp', 'ipv4', 'icmpv4', 'host'], shell: 'nfos', gui: ['physical'], families: ['Vlan'], up: true });
    expect(summary('firewall.nfngfw1120')).toEqual({ caps: ['routing', 'firewall'], processes: ['hdlc', 'arp', 'ipv4', 'icmpv4', 'ipv6', 'nd', 'icmpv6', 'udp', 'tcp', 'dhcp-client', 'dhcp-server', 'dns-client', 'dns-server', 'http-server', 'traceroute'], shell: 'nfos', gui: ['physical'], families: ['Loopback'], up: false });
    expect(summary('ids.nfsensor')).toEqual({ caps: ['host'], processes: ['arp', 'ipv4', 'icmpv4', 'host', 'ipv6', 'nd', 'icmpv6', 'udp', 'tcp', 'dhcp-client', 'dns-client', 'http-client', 'traceroute'], shell: 'host', gui: ['physical', 'desktop.ip-config', 'desktop.command-prompt', 'desktop.web-browser'], families: [], up: true });

    for (const m of [...MULTILAYER_MODELS, ...DATACENTRE_MODELS]) {
      for (const p of m.ports) expect([p.role, p.allowedRoles]).toEqual(['switched', ['switched', 'routed']]);
      expect(m.portOwners).toEqual({ svi: 'eth-switch' });
    }
    for (const type of ['hub.nfhub4', 'hub.nfhub8', 'hub.nfcoax', 'repeater.nfrep']) {
      for (const p of byType(type).ports) expect(p.role).toBe('repeater');
    }
    expect(byType('hub.nfhub4').ports.map((p) => p.wiring)).toEqual(['MDI-X', 'MDI-X', 'MDI-X', 'MDI-X']);
    expect(byType('bridge.nfbr2').ports.map((p) => [p.role, p.wiring])).toEqual([['switched', 'MDI-X'], ['switched', 'MDI-X']]);
    expect(byType('router.nf4451').ports.map((p) => [p.role, p.connector ?? null])).toEqual([
      ['routed', 'rj45'], ['routed', 'rj45'], ['routed', 'rj45'], ['routed', 'rj45'], ['routed', 'sfp+'], ['routed', 'sfp+'], ['console', 'rj45-console'],
    ]);
    const ids = byType('ids.nfsensor');
    expect(ids.ports.map((p) => [p.role, p.promiscuous ?? false])).toEqual([['mgmt', false], ['routed', true], ['routed', true]]);
    expect(ids.hostPorts).toEqual(['GigabitEthernet0/0']);
    for (const p of DATACENTRE_MODELS.flatMap((m) => m.ports)) expect(p.mtu).toBe(9216);
  });

  it('declares PoE budgets and cage slots', () => {
    expect(MODELS.filter((m) => m.poeBudgetW !== undefined).map((m) => [m.type, m.poeBudgetW])).toEqual([
      ['switch.nfc2960-24pg', 370], ['switch.nfc9200-48', 740], ['mlswitch.nfc9300-48', 1100],
    ]);
    for (const m of MODELS) {
      expect((m.slots ?? []).length).toBeLessThanOrEqual(MAX_SLOTS);
      const cagePorts = m.ports.filter((p) => p.connector === 'sfp' || p.connector === 'sfp+').map((p) => p.name);
      const cages = (m.slots ?? []).filter((s) => s.type === 'sfp' || s.type === 'sfp+').map((s) => s.cage);
      expect(cages).toEqual(cagePorts);
    }
    expect(byType('router.nf1941').slots?.map((s) => [s.id, s.type, s.numbering])).toEqual([['0/0', 'ehwic', '0/0'], ['0/1', 'ehwic', '0/1']]);
    expect(byType('router.nfgeneric').slots?.map((s) => s.type)).toEqual(Array(8).fill('generic'));
    expect(byType('router.nf4331').slots?.map((s) => s.id)).toEqual(['0/1', '0/2', 'sfp0/0/2']);
  });

  it('every module fits each compatible slot with unique names and ordinals', () => {
    let checked = 0;
    for (const model of MODELS) {
      const taken = new Set(model.ports.flatMap((p) => [p.name.toLowerCase(), p.short.toLowerCase()]));
      const fixedOrdinals = new Set(model.ports.map((p) => p.ordinal));
      for (const slot of model.slots ?? []) {
        for (const module of MODULE_MODELS) {
          if (!SLOT_ACCEPTS[slot.type].includes(module.fits)) continue;
          const specs = modulePortSpecs(model, slot, module);
          if (module.transceiver) {
            expect(specs).toEqual([]);
            continue;
          }
          checked++;
          const seen = new Set<string>();
          for (const s of specs) {
            expect(taken.has(s.name.toLowerCase()) || taken.has(s.short.toLowerCase())).toBe(false);
            expect(seen.has(s.name)).toBe(false);
            seen.add(s.name);
            expect(fixedOrdinals.has(s.ordinal)).toBe(false);
            expect(s.ordinal).toBeLessThanOrEqual(255);
            expect(s).toMatchObject({ slot: slot.id, module: module.type });
          }
          expect(new Set(specs.map((s) => s.ordinal)).size).toBe(specs.length);
        }
      }
    }
    expect(checked).toBeGreaterThan(0);
    const rt = byType('router.nf1941');
    const slot = rt.slots?.[1];
    const serial = MODULE_MODELS.find((m) => m.type === 'mod.ehwic-2t');
    const sw = MODULE_MODELS.find((m) => m.type === 'mod.ehwic-4esg');
    if (!slot || !serial || !sw) throw new Error('fixture');
    expect(modulePortSpecs(rt, slot, serial).map((p) => [p.name, p.short, p.role, p.encap, p.ordinal])).toEqual([
      ['Serial0/1/0', 'Se0/1/0', 'wan', 'hdlc', 144],
      ['Serial0/1/1', 'Se0/1/1', 'wan', 'hdlc', 145],
    ]);
    expect(modulePortSpecs(rt, slot, sw).map((p) => [p.name, p.role])).toEqual(seq('GigabitEthernet', '0/1/', 0, 4).map((n) => [n, 'switched']));
  });

  it('has the CATALOG.md modules and uses original wording only', () => {
    expect(MODULE_MODELS.map((m) => [m.type, m.model, m.fits])).toEqual([
      ['mod.ehwic-2t', 'NF-EHWIC-2T', 'ehwic'],
      ['mod.ehwic-4esg', 'NF-EHWIC-4ESG', 'ehwic'],
      ['mod.nim-2t', 'NF-NIM-2T', 'nim'],
      ['mod.nim-es2-4', 'NF-NIM-ES2-4', 'nim'],
      ['mod.nim-2ge', 'NF-NIM-2GE', 'nim'],
      ['mod.sfp-1g-sx', 'NF-SFP-1G-SX', 'sfp'],
      ['mod.sfp-1g-lx', 'NF-SFP-1G-LX', 'sfp'],
      ['mod.sfp-10g-sr', 'NF-SFP-10G-SR', 'sfp+'],
      ['mod.wlan-card', 'NF-WLAN-CARD', 'host-expansion'],
    ]);
    const text = JSON.stringify([MODELS, MODULE_MODELS]);
    expect(findBannedWords(text)).toEqual([]);
    expect(text).not.toMatch(/cisco|\bIOS\b|nexus|catalyst/i);
  });
});
