/**
 * W4 catalog — the flip (ARCHITECTURE-P2 §7 W4 catalog, §2.1, §9.2 W4 items 13–15): `CATALOG_STAGE` is 'P2' and every
 * data file is authored for it; `PROCESS_ORDER` carries the eight approved P2 daemons at their §2.1 positions and
 * the registry maps each of them to its factory; the `CAPABILITY_PROCESSES` rows of the flip are `since: 'P2'`
 * (so a P0.5/P1-stage model never derives them, and the P1-profile digest guard can normalise them away); the
 * derived summaries of NF-C2960, NF-C3650-24 and NF-2911 are exactly what the flip makes them; exactly the nine
 * managed switches carry `managed-switch`; and the W1 helper's claim holds — with the default registry the `p2.world`
 * catalog equals the real one (for every wired model since W4, for every model since the W6 catalog item made the two
 * wireless models real data).
 *
 * The W6 catalog item (§7 W6, §2.1, §9.2 items 23–24) moved the pins that described "before W6" to their W6 values
 * with the same strength: PROCESS_ORDER is the §2.1 final order (capwap-wtp after wlan-client, capwap-ac last), the
 * lightweight-ap and wireless-controller rows are the §2.1 rows, the controller is the one VLAN-aware model that is
 * not a managed switch (D17: it bridges through `vlan`), and the helper equals the real catalog model for model.
 */
import { describe, expect, it } from 'vitest';
import {
  CAPABILITIES,
  CAPABILITY_PROCESSES,
  L2_PROCESSES,
  PROCESS_ORDER,
  isVlanAware,
  type Capability,
} from '../src/contracts/catalog.js';
import type { DeviceModel } from '../src/contracts/device.js';
import type { ProcessName } from '../src/contracts/ids.js';
import { SEC } from '../src/contracts/time.js';
import { NF_2911, NF_C2960, NF_PC } from '../src/device/catalog.js';
import { ALL_MODELS, ALL_MODULES, CATALOG_STAGE, createCatalog } from '../src/device/catalog/index.js';
import { LOOPBACK_FAMILY, MANAGED_SWITCH_VLAN_FAMILY, PORT_CHANNEL_FAMILY, SUBINTERFACE_MAX } from '../src/device/catalog/define.js';
import { validateCatalog } from '../src/device/catalog/validate.js';
import { ROUTER_DATA_STAGE } from '../src/device/catalog/routers.js';
import { SWITCH_DATA_STAGE } from '../src/device/catalog/switches.js';
import { MULTILAYER_DATA_STAGE } from '../src/device/catalog/multilayer.js';
import { DATACENTRE_DATA_STAGE } from '../src/device/catalog/datacentre.js';
import { LEGACY_DATA_STAGE } from '../src/device/catalog/legacy.js';
import { SECURITY_DATA_STAGE } from '../src/device/catalog/security.js';
import { END_DEVICE_STAGE } from '../src/device/catalog/computers.js';
import {
  PROCESS_FACTORIES,
  REGISTERED_PROCESSES,
  createCapwapAc,
  createCapwapWtp,
  createDhcpv6Client,
  createDhcpv6Server,
  createDtp,
  createEtherchannel,
  createHsrp,
  createNat,
  createStp,
  createVlan,
} from '../src/protocols/index.js';
import { NF_WLC_9800_INPUT } from '../src/device/catalog/wireless.js';
import { NF_WLC_9800_TEST_INPUT, P2_WIRELESS_MODEL_DELTAS, createP2Catalog, p2Registry } from './p2.world.js';

/** The §2.1 final order without the two W6 names (`capwap-wtp`, `capwap-ac`); vtp and radius-server are not approved. */
const P2_ORDER_AFTER_W4: readonly ProcessName[] = [
  'wlan-ap', 'wlan-client', 'cell-client', 'hdlc',
  'eth-switch', 'vlan', 'dtp', 'etherchannel', 'stp',
  'arp', 'ipv4', 'nat', 'icmpv4', 'host', 'ipv6', 'nd', 'icmpv6', 'udp', 'tcp', 'hsrp',
  'dhcp-client', 'dhcp-server', 'dhcpv6-client', 'dhcpv6-server', 'dns-client', 'dns-server',
  'http-client', 'http-server', 'traceroute',
];
/** The §2.1 final order (vtp and radius-server are not approved): the W4 order with the two W6 names in their places. */
const P2_ORDER_AFTER_W6: readonly ProcessName[] = [
  'wlan-ap', 'wlan-client', 'capwap-wtp', 'cell-client', 'hdlc',
  'eth-switch', 'vlan', 'dtp', 'etherchannel', 'stp',
  'arp', 'ipv4', 'nat', 'icmpv4', 'host', 'ipv6', 'nd', 'icmpv6', 'udp', 'tcp', 'hsrp',
  'dhcp-client', 'dhcp-server', 'dhcpv6-client', 'dhcpv6-server', 'dns-client', 'dns-server',
  'http-client', 'http-server', 'traceroute', 'capwap-ac',
];
/** The daemons the W4 flip registered. */
const W4_DAEMONS: readonly ProcessName[] = ['vlan', 'dtp', 'etherchannel', 'stp', 'nat', 'hsrp', 'dhcpv6-client', 'dhcpv6-server'];
/** The daemons the W6 catalog item registered. */
const W6_DAEMONS: readonly ProcessName[] = ['capwap-wtp', 'capwap-ac'];
/** Every host runs this list since the flip (dhcpv6-client after dhcp-client). */
const HOST_STACK: readonly ProcessName[] = ['arp', 'ipv4', 'icmpv4', 'host', 'ipv6', 'nd', 'icmpv6', 'udp', 'tcp', 'dhcp-client', 'dhcpv6-client', 'dns-client', 'http-client', 'traceroute'];
/** Every routing device runs this list since the flip (§9.2 W4 item 13, with S2). */
const ROUTER_STACK: readonly ProcessName[] = ['hdlc', 'arp', 'ipv4', 'nat', 'icmpv4', 'ipv6', 'nd', 'icmpv6', 'udp', 'tcp', 'hsrp', 'dhcp-client', 'dhcp-server', 'dhcpv6-client', 'dhcpv6-server', 'dns-client', 'dns-server', 'http-server', 'traceroute'];
/** The tables the L2 control daemons bring to a managed switch, in PROCESS_TABLES order of their daemons. */
const L2_TABLES = ['vlans', 'port-security', 'dtp', 'etherchannel', 'stp', 'stp-bridge'];

const byType = (type: string): DeviceModel => {
  const m = ALL_MODELS.find((x) => x.type === type);
  if (m === undefined) throw new Error(`missing ${type}`);
  return m;
};
const NF_C3650 = byType('mlswitch.nfc3650-24');

describe('the W4 catalog flip: stage, order and registry', () => {
  it('CATALOG_STAGE is P2, every data file is authored for it, and the built-in catalog validates against the registry', () => {
    expect(CATALOG_STAGE).toBe('P2');
    for (const stage of [ROUTER_DATA_STAGE, SWITCH_DATA_STAGE, MULTILAYER_DATA_STAGE, DATACENTRE_DATA_STAGE, LEGACY_DATA_STAGE, SECURITY_DATA_STAGE, END_DEVICE_STAGE]) {
      expect(stage).toBe('P2');
    }
    expect(validateCatalog(ALL_MODELS, ALL_MODULES, { stage: 'P2', processNames: REGISTERED_PROCESSES })).toEqual([]);
    expect(() => createCatalog(PROCESS_FACTORIES)).not.toThrow();
  });

  it('PROCESS_ORDER holds the eight W4 daemons and the two W6 daemons at their §2.1 positions and nothing unapproved', () => {
    // §9.2 W6 (§0 rule 3): the W6 catalog item inserted capwap-wtp and capwap-ac with their factories; the W4 order
    // is kept exactly around them
    expect(PROCESS_ORDER).toEqual(P2_ORDER_AFTER_W6);
    expect(PROCESS_ORDER.filter((n) => !W6_DAEMONS.includes(n))).toEqual(P2_ORDER_AFTER_W4);
    for (const name of ['vtp', 'radius-server']) expect(PROCESS_ORDER).not.toContain(name);
    // constraints §2.1 relies upon: eth-switch before every L2 control daemon, ipv4 before nat, udp before hsrp,
    // dhcpv6 and capwap-ac, wlan-ap before capwap-wtp (an EAPOL frame that ties at score 2 goes to wlan-ap)
    const at = (n: ProcessName): number => PROCESS_ORDER.indexOf(n);
    for (const n of ['vlan', 'dtp', 'etherchannel', 'stp']) expect(at(n)).toBeGreaterThan(at('eth-switch'));
    expect(at('nat')).toBeGreaterThan(at('ipv4'));
    for (const n of ['hsrp', 'dhcpv6-client', 'dhcpv6-server', 'capwap-ac']) expect(at(n)).toBeGreaterThan(at('udp'));
    expect(at('capwap-wtp')).toBeGreaterThan(at('wlan-ap'));
    // the L2 change signal fans out in PROCESS_ORDER order (D6)
    expect(PROCESS_ORDER.filter((n) => L2_PROCESSES.includes(n))).toEqual([...L2_PROCESSES]);
  });

  it('the registry maps every PROCESS_ORDER name, the W4 factories build processes named after their keys', () => {
    expect(REGISTERED_PROCESSES).toEqual(PROCESS_ORDER);
    const w4 = { vlan: createVlan, dtp: createDtp, etherchannel: createEtherchannel, stp: createStp, nat: createNat, hsrp: createHsrp, 'dhcpv6-client': createDhcpv6Client, 'dhcpv6-server': createDhcpv6Server };
    // and the two daemons of the W6 catalog item
    const w6 = { 'capwap-wtp': createCapwapWtp, 'capwap-ac': createCapwapAc };
    for (const [name, factory] of [...Object.entries(w4), ...Object.entries(w6)]) {
      expect(PROCESS_FACTORIES[name], name).toBe(factory);
      expect(factory().name, name).toBe(name);
    }
  });

  it('the CAPABILITY_PROCESSES rows of the flip are exactly the §2.1 rows, every one since P2', () => {
    const p2 = (process: ProcessName) => ({ process, since: 'P2' });
    expect(CAPABILITY_PROCESSES['managed-switch']).toEqual([p2('vlan'), p2('dtp'), p2('etherchannel'), p2('stp')]);
    expect(CAPABILITY_PROCESSES.routing.slice(-4)).toEqual([p2('nat'), p2('dhcpv6-client'), p2('dhcpv6-server'), p2('hsrp')]);
    expect(CAPABILITY_PROCESSES.host.slice(-1)).toEqual([p2('dhcpv6-client')]);
    expect(CAPABILITY_PROCESSES['nat-gateway']).toEqual([p2('nat')]);
    // §9.2 W6: the W6 catalog item added the wireless rows with their daemons (they were empty before)
    expect(CAPABILITY_PROCESSES['lightweight-ap']).toEqual([p2('capwap-wtp'), p2('udp'), p2('dhcp-client')]);
    expect(CAPABILITY_PROCESSES['wireless-controller']).toEqual([p2('vlan'), p2('udp'), p2('capwap-ac')]);
    // no W4 or W6 daemon is derived before stage P2 anywhere (the P1-profile digest guard relies on this)
    for (const cap of CAPABILITIES) {
      for (const row of CAPABILITY_PROCESSES[cap]) {
        if (W4_DAEMONS.includes(row.process) || W6_DAEMONS.includes(row.process)) expect([cap, row.process, row.since]).toEqual([cap, row.process, 'P2']);
      }
    }
  });
});

describe('the W4 catalog flip: derived summaries', () => {
  it('NF-C2960 is a managed switch: the L2 control daemons, their tables, the 1–4094 Vlan and Port-channel families, pvst', () => {
    expect(NF_C2960.capabilities).toEqual(['switching', 'managed-switch']);
    expect(NF_C2960.processes).toEqual(['eth-switch', 'vlan', 'dtp', 'etherchannel', 'stp', 'arp', 'ipv4', 'icmpv4', 'host']);
    expect(isVlanAware(NF_C2960)).toBe(true);
    expect(NF_C2960.tables).toEqual(['cam', 'arp', 'rib', ...L2_TABLES]);
    expect(NF_C2960.virtualFamilies).toEqual([
      { family: 'Vlan', short: 'Vl', role: 'svi', min: 1, max: 4094, defaultAdminUp: false, auto: [1] },
      { family: 'Port-channel', short: 'Po', role: 'channel', min: 1, max: 48, defaultAdminUp: true },
    ]);
    expect(NF_C2960.virtualFamilies).toEqual([MANAGED_SWITCH_VLAN_FAMILY, PORT_CHANNEL_FAMILY]);
    expect(NF_C2960.portOwners).toEqual({ svi: 'eth-switch', channel: 'etherchannel' });
    expect(NF_C2960.stpDefaultMode).toBe('pvst');
    expect(NF_C2960.profileConfig).toEqual({ P2: ['spanning-tree mode pvst', 'spanning-tree extend system-id'] });
    expect(NF_C2960.subinterfaces).toBeUndefined();
    // unchanged P0 facts
    expect(NF_C2960.ports).toHaveLength(26);
    expect([NF_C2960.kind, NF_C2960.bootNs, NF_C2960.ipForwarding, NF_C2960.portsDefaultUp, NF_C2960.gui]).toEqual(['switch', 30 * SEC, false, true, ['physical']]);
  });

  it('NF-C3650-24 lists managed-switch beside layer3-switch: L2 control plus the routing daemons, no ip routing by default, subinterfaces', () => {
    expect(NF_C3650.capabilities).toEqual(['switching', 'routing', 'layer3-switch', 'managed-switch']);
    expect(NF_C3650.processes).toEqual(['hdlc', 'eth-switch', 'vlan', 'dtp', 'etherchannel', 'stp', 'arp', 'ipv4', 'nat', 'icmpv4', 'host', 'ipv6', 'nd', 'icmpv6', 'udp', 'tcp', 'hsrp', 'dhcp-client', 'dhcp-server', 'dhcpv6-client', 'dhcpv6-server', 'dns-client', 'dns-server', 'http-server', 'traceroute']);
    expect(isVlanAware(NF_C3650)).toBe(true);
    expect(NF_C3650.tables).toEqual(['cam', 'arp', 'rib', ...L2_TABLES, 'nat', 'rib6', 'nd', 'sockets', 'hsrp', 'dhcp-bindings', 'dhcpv6-bindings', 'dns-cache']);
    expect(NF_C3650.virtualFamilies?.map((f) => [f.family, f.min, f.max, f.role])).toEqual([['Vlan', 1, 4094, 'svi'], ['Port-channel', 1, 48, 'channel'], ['Loopback', 0, LOOPBACK_FAMILY.max, 'virtual']]);
    expect(NF_C3650.virtualFamilies?.[0]).toMatchObject({ defaultAdminUp: false, auto: [1] });
    expect(NF_C3650.portOwners).toEqual({ svi: 'eth-switch', channel: 'etherchannel' });
    expect(NF_C3650.stpDefaultMode).toBe('pvst');
    expect(NF_C3650.profileConfig).toEqual({ P2: ['spanning-tree mode pvst', 'spanning-tree extend system-id', 'no ip routing'] });
    expect(NF_C3650.subinterfaces).toEqual({ roles: ['routed'], max: SUBINTERFACE_MAX });
    for (const p of NF_C3650.ports) expect([p.role, p.allowedRoles]).toEqual(['switched', ['switched', 'routed']]);
    expect([NF_C3650.ipForwarding, NF_C3650.portsDefaultUp]).toEqual([true, true]);
  });

  it('NF-C9300 defaults to rapid spanning tree (model data); the data-centre switches are managed too', () => {
    const c9300 = byType('mlswitch.nfc9300-48');
    expect(c9300.capabilities).toEqual(['switching', 'routing', 'layer3-switch', 'poe-source', 'managed-switch']);
    expect(c9300.stpDefaultMode).toBe('rapid-pvst');
    expect(c9300.profileConfig).toEqual({ P2: ['spanning-tree mode rapid-pvst', 'spanning-tree extend system-id', 'no ip routing'] });
    for (const type of ['dcswitch.nfn9k-48', 'dcswitch.nfn9k-32']) {
      const m = byType(type);
      expect([type, m.capabilities]).toEqual([type, ['switching', 'routing', 'layer3-switch', 'managed-switch']]);
      expect([type, m.stpDefaultMode, m.profileConfig?.P2?.[0]]).toEqual([type, 'pvst', 'spanning-tree mode pvst']);
      expect(m.processes).toEqual(NF_C3650.processes);
    }
  });

  it('NF-2911 gains nat, hsrp, dhcpv6-client and dhcpv6-server with their tables and routed subinterfaces, and no switch member', () => {
    expect(NF_2911.capabilities).toEqual(['routing']);
    expect(NF_2911.processes).toEqual(ROUTER_STACK);
    expect(isVlanAware(NF_2911)).toBe(false);
    expect(NF_2911.tables).toEqual(['cam', 'arp', 'rib', 'nat', 'rib6', 'nd', 'sockets', 'hsrp', 'dhcp-bindings', 'dhcpv6-bindings', 'dns-cache']);
    expect(NF_2911.virtualFamilies).toEqual([LOOPBACK_FAMILY]);
    expect(Object.keys(NF_2911.portOwners ?? {})).toEqual([]);
    expect(NF_2911.subinterfaces).toEqual({ roles: ['routed'], max: SUBINTERFACE_MAX });
    for (const k of ['stpDefaultMode', 'profileConfig']) expect(Object.keys(NF_2911)).not.toContain(k);
    expect([NF_2911.kind, NF_2911.bootNs, NF_2911.ipForwarding, NF_2911.portsDefaultUp]).toEqual(['router', 45 * SEC, true, false]);
  });

  it('a host gains dhcpv6-client and no table; a home router gains nat through nat-gateway and keeps its GUI-only shell', () => {
    expect(NF_PC.processes).toEqual(HOST_STACK);
    expect(NF_PC.tables).toEqual(['cam', 'arp', 'rib', 'rib6', 'nd', 'sockets', 'dns-cache']);
    for (const k of ['subinterfaces', 'stpDefaultMode', 'profileConfig']) expect(Object.keys(NF_PC)).not.toContain(k);
    const home = byType('wrouter.nfhome');
    expect(home.capabilities).toContain('nat-gateway');
    for (const n of ['nat', 'hsrp', 'dhcpv6-client', 'dhcpv6-server']) expect(home.processes, n).toContain(n);
    expect(home.cli?.shell).toBe('none');
  });

  it('exactly the nine managed switches carry managed-switch; bridges, phones and access points are not VLAN-aware', () => {
    const managed = ALL_MODELS.filter((m) => (m.capabilities ?? []).includes('managed-switch')).map((m) => m.type);
    expect(managed).toEqual([
      'switch.nfc2960-8', 'switch.nfc2960', 'switch.nfc2960-48', 'switch.nfc2960-24pg', 'switch.nfc9200-48',
      'mlswitch.nfc3650-24', 'mlswitch.nfc9300-48',
      'dcswitch.nfn9k-48', 'dcswitch.nfn9k-32',
    ]);
    for (const m of ALL_MODELS) {
      const caps: readonly Capability[] = m.capabilities ?? [];
      // §9.2 W6: the NF-WLC-9800 controller bridges VLAN-aware through `vlan` too (D17, §2.1 wireless-controller row)
      expect([m.type, isVlanAware(m)]).toEqual([m.type, caps.includes('managed-switch') || caps.includes('wireless-controller')]);
      expect([m.type, m.virtualFamilies?.some((f) => f.family === 'Port-channel') ?? false]).toEqual([m.type, caps.includes('managed-switch')]);
      // every routing model runs the four routing daemons of the flip, every host runs dhcpv6-client, nobody else does
      for (const n of ['nat', 'hsrp', 'dhcpv6-server']) expect([m.type, n, m.processes.includes(n)]).toEqual([m.type, n, caps.includes('routing')]);
      expect([m.type, m.processes.includes('dhcpv6-client')]).toEqual([m.type, caps.includes('routing') || caps.includes('host')]);
    }
    for (const type of ['bridge.nfbr2', 'ipphone.nfphone', 'ap.nfap-auto']) expect([type, byType(type).processes.includes('vlan')]).toEqual([type, false]);
  });

  it('the p2.world helper equals the real catalog for EVERY model with the default registry (its W1 header claim, complete since the W6 catalog item)', () => {
    // §7 W1 qa: "after the W4 and W6 flips the helper equals the real catalog". After W4 it held for every wired model;
    // the W6 catalog item made the helper's TEST-ONLY wireless data (NF-AP-1832 with `lightweight-ap`, NF-WLC-9800) the
    // real data, so it now holds model for model, in palette order.
    expect(p2Registry()).toEqual(PROCESS_FACTORIES);
    const helper = createP2Catalog();
    const wireless = new Set<string>([...Object.keys(P2_WIRELESS_MODEL_DELTAS), NF_WLC_9800_TEST_INPUT.type]);
    expect([...wireless].sort()).toEqual(['ap.nfap-lw', 'wlc.nfwlc9800']);
    for (const m of ALL_MODELS) expect(helper.get(m.type), m.type).toEqual(m);
    expect(helper.list()).toEqual(ALL_MODELS);
    // the real catalog carries the controller and the lightweight capability; the helper's copies are the same data
    const live = createCatalog(PROCESS_FACTORIES);
    expect(NF_WLC_9800_TEST_INPUT).toBe(NF_WLC_9800_INPUT);
    expect(live.get(NF_WLC_9800_TEST_INPUT.type)).toEqual(helper.get(NF_WLC_9800_TEST_INPUT.type));
    expect(live.get('ap.nfap-lw')?.capabilities).toContain('lightweight-ap');
    expect(helper.get('ap.nfap-lw')?.capabilities).toContain('lightweight-ap');
    for (const name of PROCESS_ORDER) expect(helper.process(name)).toBe(PROCESS_FACTORIES[name]);
  });
});
