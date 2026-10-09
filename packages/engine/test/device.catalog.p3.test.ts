/**
 * W4 catalog — the P3 flip (ARCHITECTURE-P3 §7 W4 step 2, §0 rules 3 and 14, §2.1, §2.6, D2, D22; §9.2 W4 items 31–36):
 * `CATALOG_STAGE` is 'P3' while `LATEST_DEFAULTS_PROFILE` stays 'P2' (W7); `PROCESS_ORDER` is the §2.1 final order
 * restricted to the approved names, with the fifteen daemons of the flip (seven MUST, eight approved) registered with
 * their factories; the `CAPABILITY_PROCESSES` rows of the flip are exactly the §2.1 rows, every one `since: 'P3'` (the
 * dormant udp and tcp on `managed-switch`, D22); `PROCESS_TABLES` gains the tables of the flip's daemons and
 * `STAGED_PROCESS_TABLES` the stage-filtered snooping tables, which `deriveTables` applies only at stage P3 and only to
 * `managed-switch` models — never the controller; [S24] `profileConfig.P3` holds the two `service timestamps` lines on
 * routers, managed switches and the controller (the `cdpDefault` set) and on no other model, while no P1/P2 profile
 * list moves; and the derived summaries of NF-C2960, NF-C3650-24, NF-2911 and NF-WLC-9800 are exactly what the flip
 * makes them. (The P2 layer stays pinned, computed at stage P2, in device.catalog.p2.test.ts.)
 */
import { describe, expect, it } from 'vitest';
import {
  CAPABILITIES,
  CAPABILITY_PROCESSES,
  L2_PROCESSES,
  LATEST_DEFAULTS_PROFILE,
  PROCESS_ORDER,
  isVlanAware,
  type Capability,
  type CapabilityProcess,
} from '../src/contracts/catalog.js';
import type { DeviceModel } from '../src/contracts/device.js';
import type { ProcessName } from '../src/contracts/ids.js';
import { PROCESS_TABLES, STAGED_PROCESS_TABLES } from '../src/contracts/tables.js';
import { SEC } from '../src/contracts/time.js';
import { ALL_MODEL_INPUTS, ALL_MODELS, ALL_MODULES, CATALOG_STAGE, builtInCatalogIssues } from '../src/device/catalog/index.js';
import {
  CAPWAP_TUNNEL_FAMILY,
  CONTROLLER_VLAN_FAMILY,
  LOOPBACK_FAMILY,
  MANAGED_SWITCH_VLAN_FAMILY,
  PORT_CHANNEL_FAMILY,
  SUBINTERFACE_MAX,
  TIMESTAMPS_PROFILE_LINES,
  TUNNEL_FAMILY,
  defineModel,
  deriveCliSpec,
  deriveProfileConfig,
  deriveTables,
} from '../src/device/catalog/define.js';
import { validateCatalog } from '../src/device/catalog/validate.js';
import { PROCESS_FACTORIES, REGISTERED_PROCESSES, processFactory } from '../src/protocols/index.js';

/** The §2.1 final daemon order restricted to the approved names, without the W6 flip's [S32] `script-host`. */
const P3_ORDER: readonly ProcessName[] = [
  'wlan-ap', 'wlan-client', 'capwap-wtp', 'cell-client', 'hdlc', 'ppp',
  'eth-switch', 'vlan', 'dtp', 'etherchannel', 'stp', 'cdp', 'lldp',
  'arp', 'ipv4', 'nat', 'acl', 'gre', 'icmpv4', 'host', 'ipv6', 'nd', 'icmpv6', 'udp', 'tcp',
  'vty', 'vty-client', 'logger', 'ntp', 'syslog-server', 'hsrp', 'ospf', 'eigrp', 'ike',
  'dhcp-client', 'dhcp-server', 'dhcpv6-client', 'dhcpv6-server', 'dns-client', 'dns-server',
  'http-client', 'http-server', 'restconf', 'traceroute', 'traffic', 'capwap-ac',
];
/** The fifteen daemons the flip registers: the seven MUST ones, then the approved items' ones (§7 W4 step 2). */
const MUST_DAEMONS: readonly ProcessName[] = ['ospf', 'acl', 'cdp', 'lldp', 'ntp', 'restconf', 'traffic'];
const APPROVED_DAEMONS: readonly ProcessName[] = ['ppp', 'gre', 'vty', 'vty-client', 'logger', 'syslog-server', 'eigrp', 'ike'];
const FLIP_DAEMONS: readonly ProcessName[] = [...MUST_DAEMONS, ...APPROVED_DAEMONS];

/** The two [S24] lines (D2). */
const TIMESTAMPS = ['service timestamps debug datetime msec', 'service timestamps log datetime msec'];

const p3 = (process: ProcessName): CapabilityProcess => ({ process, since: 'P3' });
const p3Rows = (cap: Capability): readonly CapabilityProcess[] => CAPABILITY_PROCESSES[cap].filter((r) => r.since === 'P3');

const byType = (type: string): DeviceModel => {
  const m = ALL_MODELS.find((x) => x.type === type);
  if (m === undefined) throw new Error(`missing ${type}`);
  return m;
};

const NF_C2960 = byType('switch.nfc2960');
const NF_C3650 = byType('mlswitch.nfc3650-24');
const NF_2911 = byType('router.nf2911');
const NF_WLC_9800 = byType('wlc.nfwlc9800');

describe('the P3 catalog flip: stage, order, registry and contract rows', () => {
  it('CATALOG_STAGE is P3, LATEST_DEFAULTS_PROFILE stays P2, and the built-in catalog validates against the registry', () => {
    expect(CATALOG_STAGE).toBe('P3');
    // §7 W4: the defaults profile flips with the course (W7), never here
    expect(LATEST_DEFAULTS_PROFILE).toBe('P2');
    expect(builtInCatalogIssues()).toEqual([]);
    expect(validateCatalog(ALL_MODELS, ALL_MODULES, { stage: 'P3', processNames: REGISTERED_PROCESSES })).toEqual([]);
    ALL_MODELS.forEach((m, i) => expect(m).toEqual(defineModel(ALL_MODEL_INPUTS[i]!, 'P3')));
  });

  it('PROCESS_ORDER is the §2.1 final order of the approved names, the flip inserting its fifteen daemons only', () => {
    // §9.2 W4 item 32: PROCESS_ORDER itself is pinned here
    expect(PROCESS_ORDER).toEqual(P3_ORDER);
    expect(Object.isFrozen(PROCESS_ORDER)).toBe(true);
    for (const n of FLIP_DAEMONS) expect(PROCESS_ORDER, n).toContain(n);
    // never inserted in P3a: the unapproved items' daemons; [S32] script-host waits for the W6 flip
    for (const n of ['ospfv3', 'tftp', 'snmp-agent', 'snmp-manager', 'script-host']) expect(PROCESS_ORDER).not.toContain(n);
    // the constraints §2.1 relies upon
    const at = (n: ProcessName): number => PROCESS_ORDER.indexOf(n);
    expect(at('ppp')).toBeGreaterThan(at('hdlc'));
    for (const n of ['cdp', 'lldp']) expect(at(n)).toBeGreaterThan(at('eth-switch'));
    for (const n of ['acl', 'gre']) expect(at(n)).toBeGreaterThan(at('ipv4'));
    for (const n of ['ntp', 'logger', 'syslog-server', 'ike']) expect(at(n)).toBeGreaterThan(at('udp'));
    for (const n of ['vty', 'restconf']) expect(at(n)).toBeGreaterThan(at('tcp'));
    // cdp and lldp take no part in the L2 change signal
    for (const n of ['cdp', 'lldp']) expect(L2_PROCESSES).not.toContain(n);
  });

  it('the registry maps the fifteen daemons to their factories, in PROCESS_ORDER', () => {
    expect(REGISTERED_PROCESSES).toEqual(PROCESS_ORDER);
    for (const name of FLIP_DAEMONS) {
      const factory = processFactory(name);
      expect(factory, name).toBeDefined();
      expect(PROCESS_FACTORIES[name], name).toBe(factory);
      expect(factory!().name, name).toBe(name);
    }
  });

  it('the CAPABILITY_PROCESSES rows of the flip are exactly the §2.1 rows, every one since P3', () => {
    expect(p3Rows('routing')).toEqual([
      p3('ppp'), p3('cdp'), p3('lldp'), p3('acl'), p3('gre'), p3('vty'), p3('vty-client'), p3('logger'), p3('ntp'),
      p3('ospf'), p3('eigrp'), p3('ike'), p3('restconf'),
    ]);
    // D22: the managed switch's udp and tcp are rows of the flip (dormant until a P3 service is configured)
    expect(p3Rows('managed-switch')).toEqual([
      p3('cdp'), p3('lldp'), p3('acl'), p3('udp'), p3('tcp'), p3('vty'), p3('vty-client'), p3('logger'), p3('ntp'), p3('restconf'),
    ]);
    expect(p3Rows('wireless-controller')).toEqual([p3('cdp'), p3('logger'), p3('ntp')]);
    expect(p3Rows('server')).toEqual([p3('ntp'), p3('syslog-server')]);
    expect(p3Rows('host')).toEqual([p3('vty-client'), p3('traffic')]);
    // every other capability has no P3 row: the lightweight AP none (no receive path, D2, D18); [S32] programmable gets
    // script-host at the W6 flip only
    const withRows: readonly Capability[] = ['host', 'server', 'routing', 'managed-switch', 'wireless-controller'];
    for (const cap of CAPABILITIES) if (!withRows.includes(cap)) expect([cap, p3Rows(cap)]).toEqual([cap, []]);
    expect(CAPABILITY_PROCESSES.programmable).toEqual([]);
    // every row naming a flip daemon is since P3, so no P1/P2-stage model derives one
    for (const cap of CAPABILITIES) {
      for (const row of CAPABILITY_PROCESSES[cap]) if (FLIP_DAEMONS.includes(row.process)) expect([cap, row.process, row.since]).toEqual([cap, row.process, 'P3']);
    }
  });

  it('PROCESS_TABLES gains the tables of the flip daemons; STAGED_PROCESS_TABLES holds the snooping row', () => {
    const tablesOf = Object.fromEntries(FLIP_DAEMONS.map((d) => [d, PROCESS_TABLES[d]]));
    expect(tablesOf).toEqual({
      ospf: ['ospf-interfaces', 'ospf-neighbors', 'ospf-lsdb'],
      acl: ['acl'],
      cdp: ['cdp-neighbours'],
      lldp: ['lldp-neighbours'],
      ntp: ['ntp-peers', 'clock'],
      restconf: ['restconf-log'],
      traffic: ['flows'],
      ppp: ['ppp'],
      gre: ['tunnels'],
      vty: ['vty-logins'],
      'vty-client': undefined,
      logger: undefined,
      'syslog-server': ['syslog-messages'],
      eigrp: ['eigrp-neighbors', 'eigrp-topology'],
      ike: ['ipsec-sa'],
    });
    expect(PROCESS_TABLES['script-host']).toBeUndefined();
    // the P2 vlan row is unchanged: the snooping tables are never plain vlan rows
    expect(PROCESS_TABLES.vlan).toEqual(['vlans', 'port-security']);
    expect(STAGED_PROCESS_TABLES).toEqual([{ process: 'vlan', tables: ['dhcp-snooping', 'arp-inspection'], since: 'P3', requires: 'managed-switch' }]);
    expect(Object.isFrozen(STAGED_PROCESS_TABLES)).toBe(true);
  });
});

describe('the P3 catalog flip: deriveTables and the stage filter', () => {
  const vlanSwitch: readonly ProcessName[] = ['eth-switch', 'vlan', 'dtp'];

  it('applies a staged row only at its stage and only with its capability; without a stage it is the P2 derivation', () => {
    expect(deriveTables(vlanSwitch)).toEqual(['cam', 'arp', 'rib', 'vlans', 'port-security', 'dtp']);
    expect(deriveTables(vlanSwitch, ['switching', 'managed-switch'])).toEqual(['cam', 'arp', 'rib', 'vlans', 'port-security', 'dtp']);
    expect(deriveTables(vlanSwitch, ['switching', 'managed-switch'], 'P2')).toEqual(['cam', 'arp', 'rib', 'vlans', 'port-security', 'dtp']);
    expect(deriveTables(vlanSwitch, ['switching', 'managed-switch'], 'P3')).toEqual([
      'cam', 'arp', 'rib', 'vlans', 'port-security', 'dhcp-snooping', 'arp-inspection', 'dtp',
    ]);
    // the controller runs vlan but is no managed switch
    expect(deriveTables(['eth-switch', 'vlan'], ['switching', 'wireless-controller'], 'P3')).toEqual(['cam', 'arp', 'rib', 'vlans', 'port-security']);
  });

  it('exactly the managed switches declare the snooping tables, never the controller; no P2-stage model does', () => {
    const snooping = (m: DeviceModel): boolean => m.tables?.includes('dhcp-snooping') === true || m.tables?.includes('arp-inspection') === true;
    expect(ALL_MODELS.filter(snooping).map((m) => m.type)).toEqual(ALL_MODELS.filter((m) => m.capabilities?.includes('managed-switch')).map((m) => m.type));
    expect(ALL_MODELS.filter(snooping).map((m) => m.type)).toEqual([
      'switch.nfc2960-8', 'switch.nfc2960', 'switch.nfc2960-48', 'switch.nfc2960-24pg', 'switch.nfc9200-48',
      'mlswitch.nfc3650-24', 'mlswitch.nfc9300-48', 'dcswitch.nfn9k-48', 'dcswitch.nfn9k-32',
    ]);
    expect(snooping(NF_WLC_9800)).toBe(false);
    for (const input of ALL_MODEL_INPUTS) expect([input.type, snooping(defineModel(input, 'P2'))]).toEqual([input.type, false]);
  });
});

describe('the P3 catalog flip: [S24] profileConfig.P3 and the CDP default (D2)', () => {
  it('routers, managed switches and the controller replay the two service timestamps lines in a P3 world; no other model', () => {
    expect([...TIMESTAMPS_PROFILE_LINES]).toEqual(TIMESTAMPS);
    expect(Object.isFrozen(TIMESTAMPS_PROFILE_LINES)).toBe(true);
    const withP3 = ALL_MODELS.filter((m) => m.profileConfig?.P3 !== undefined).map((m) => m.type);
    expect(withP3).toEqual([
      'router.nf1941', 'router.nf2911', 'router.nf4331', 'router.nf4451', 'router.nfgeneric',
      'switch.nfc2960-8', 'switch.nfc2960', 'switch.nfc2960-48', 'switch.nfc2960-24pg', 'switch.nfc9200-48',
      'mlswitch.nfc3650-24', 'mlswitch.nfc9300-48', 'dcswitch.nfn9k-48', 'dcswitch.nfn9k-32',
      'firewall.nfasa5506', 'firewall.nfngfw1120',
      'wlc.nfwlc9800',
    ]);
    // the D2 set: exactly the models that run CDP by default in a P3 world
    expect(ALL_MODELS.filter((m) => m.cdpDefault === true).map((m) => m.type)).toEqual(withP3);
    for (const m of ALL_MODELS) if (m.profileConfig?.P3 !== undefined) expect([m.type, m.profileConfig.P3]).toEqual([m.type, TIMESTAMPS]);
    // never home routers, access points or hosts
    for (const type of ['wrouter.nfhome', 'wrouter.nfhome-ax', 'ap.nfap-lw', 'ap.nfap-auto', 'pc.nfpc', 'server.nfserver', 'wlc.nfwlc3504']) {
      expect([type, byType(type).profileConfig?.P3, byType(type).cdpDefault]).toEqual([type, undefined, undefined]);
    }
  });

  it('no P1 or P2 profile list moves: every model keeps exactly its P2-stage lists beside the new P3 key', () => {
    for (const input of ALL_MODEL_INPUTS) {
      const now = byType(input.type).profileConfig ?? {};
      const before = defineModel(input, 'P2').profileConfig ?? {};
      expect([input.type, now.P1, now.P2]).toEqual([input.type, before.P1, before.P2]);
      expect([input.type, before.P3]).toEqual([input.type, undefined]);
    }
  });

  it('deriveProfileConfig adds the P3 key only at stage P3 and only for the cdpDefault set', () => {
    const nfos = deriveCliSpec(['routing']);
    expect(deriveProfileConfig(['routing'], undefined)).toBeUndefined();
    expect(deriveProfileConfig(['routing'], undefined, 'P2', nfos)).toBeUndefined();
    expect(deriveProfileConfig(['routing'], undefined, 'P3')).toBeUndefined();
    expect(deriveProfileConfig(['routing'], undefined, 'P3', nfos)).toEqual({ P3: TIMESTAMPS });
    expect(deriveProfileConfig(['switching', 'managed-switch'], 'pvst', 'P3', nfos)).toEqual({
      P2: ['spanning-tree mode pvst', 'spanning-tree extend system-id'],
      P3: TIMESTAMPS,
    });
    // a home router (shell none, nat-gateway) and a host get none
    const homeCaps: readonly Capability[] = ['switching', 'routing', 'wifi-ap', 'nat-gateway', 'dhcp-server'];
    expect(deriveProfileConfig(homeCaps, undefined, 'P3', deriveCliSpec(homeCaps))).toBeUndefined();
    expect(deriveProfileConfig(['host'], undefined, 'P3', deriveCliSpec(['host']))).toBeUndefined();
  });
});

describe('the P3 catalog flip: derived summaries', () => {
  it('NF-C2960: the managed-switch rows, the dormant transport, the snooping tables, CDP by default, the timestamps lines', () => {
    expect(NF_C2960.capabilities).toEqual(['switching', 'managed-switch']);
    expect(NF_C2960.processes).toEqual([
      'eth-switch', 'vlan', 'dtp', 'etherchannel', 'stp', 'cdp', 'lldp', 'arp', 'ipv4', 'acl', 'icmpv4', 'host',
      'udp', 'tcp', 'vty', 'vty-client', 'logger', 'ntp', 'restconf',
    ]);
    expect(isVlanAware(NF_C2960)).toBe(true);
    expect(NF_C2960.tables).toEqual([
      'cam', 'arp', 'rib', 'vlans', 'port-security', 'dhcp-snooping', 'arp-inspection', 'dtp', 'etherchannel', 'stp', 'stp-bridge',
      'cdp-neighbours', 'lldp-neighbours', 'acl', 'sockets', 'vty-logins', 'ntp-peers', 'clock', 'restconf-log',
    ]);
    expect(NF_C2960.virtualFamilies).toEqual([MANAGED_SWITCH_VLAN_FAMILY, PORT_CHANNEL_FAMILY]);
    expect(NF_C2960.portOwners).toEqual({ svi: 'eth-switch', channel: 'etherchannel' });
    expect(NF_C2960.stpDefaultMode).toBe('pvst');
    expect(NF_C2960.profileConfig).toEqual({ P2: ['spanning-tree mode pvst', 'spanning-tree extend system-id'], P3: TIMESTAMPS });
    expect(NF_C2960.cdpDefault).toBe(true);
    expect(NF_C2960.subinterfaces).toBeUndefined();
    expect([NF_C2960.kind, NF_C2960.bootNs, NF_C2960.ipForwarding, NF_C2960.portsDefaultUp, NF_C2960.gui]).toEqual(['switch', 30 * SEC, false, true, ['physical']]);
  });

  it('NF-C3650-24: routing and managed-switch rows together, the Tunnel family with its gre owner, the snooping tables', () => {
    expect(NF_C3650.capabilities).toEqual(['switching', 'routing', 'layer3-switch', 'managed-switch']);
    expect(NF_C3650.processes).toEqual([
      'hdlc', 'ppp', 'eth-switch', 'vlan', 'dtp', 'etherchannel', 'stp', 'cdp', 'lldp', 'arp', 'ipv4', 'nat', 'acl', 'gre',
      'icmpv4', 'host', 'ipv6', 'nd', 'icmpv6', 'udp', 'tcp', 'vty', 'vty-client', 'logger', 'ntp', 'hsrp', 'ospf', 'eigrp',
      'ike', 'dhcp-client', 'dhcp-server', 'dhcpv6-client', 'dhcpv6-server', 'dns-client', 'dns-server', 'http-server',
      'restconf', 'traceroute',
    ]);
    expect(NF_C3650.tables).toEqual([
      'cam', 'arp', 'rib', 'ppp', 'vlans', 'port-security', 'dhcp-snooping', 'arp-inspection', 'dtp', 'etherchannel', 'stp',
      'stp-bridge', 'cdp-neighbours', 'lldp-neighbours', 'nat', 'acl', 'tunnels', 'rib6', 'nd', 'sockets', 'vty-logins',
      'ntp-peers', 'clock', 'hsrp', 'ospf-interfaces', 'ospf-neighbors', 'ospf-lsdb', 'eigrp-neighbors', 'eigrp-topology',
      'ipsec-sa', 'dhcp-bindings', 'dhcpv6-bindings', 'dns-cache', 'restconf-log',
    ]);
    expect(NF_C3650.virtualFamilies?.map((f) => f.family)).toEqual(['Vlan', 'Port-channel', 'Loopback', 'Tunnel']);
    expect(NF_C3650.virtualFamilies?.at(-1)).toEqual(TUNNEL_FAMILY);
    expect(NF_C3650.portOwners).toEqual({ svi: 'eth-switch', channel: 'etherchannel', tunnel: 'gre' });
    expect(NF_C3650.profileConfig).toEqual({ P2: ['spanning-tree mode pvst', 'spanning-tree extend system-id', 'no ip routing'], P3: TIMESTAMPS });
    expect(NF_C3650.cdpDefault).toBe(true);
    expect(NF_C3650.subinterfaces).toEqual({ roles: ['routed'], max: SUBINTERFACE_MAX });
  });

  it('NF-2911: the routing rows and their tables, the Tunnel family with its gre owner, the timestamps lines', () => {
    expect(NF_2911.capabilities).toEqual(['routing']);
    expect(NF_2911.processes).toEqual([
      'hdlc', 'ppp', 'cdp', 'lldp', 'arp', 'ipv4', 'nat', 'acl', 'gre', 'icmpv4', 'ipv6', 'nd', 'icmpv6', 'udp', 'tcp', 'vty',
      'vty-client', 'logger', 'ntp', 'hsrp', 'ospf', 'eigrp', 'ike', 'dhcp-client', 'dhcp-server', 'dhcpv6-client',
      'dhcpv6-server', 'dns-client', 'dns-server', 'http-server', 'restconf', 'traceroute',
    ]);
    expect(isVlanAware(NF_2911)).toBe(false);
    expect(NF_2911.tables).toEqual([
      'cam', 'arp', 'rib', 'ppp', 'cdp-neighbours', 'lldp-neighbours', 'nat', 'acl', 'tunnels', 'rib6', 'nd', 'sockets',
      'vty-logins', 'ntp-peers', 'clock', 'hsrp', 'ospf-interfaces', 'ospf-neighbors', 'ospf-lsdb', 'eigrp-neighbors',
      'eigrp-topology', 'ipsec-sa', 'dhcp-bindings', 'dhcpv6-bindings', 'dns-cache', 'restconf-log',
    ]);
    expect(NF_2911.virtualFamilies).toEqual([LOOPBACK_FAMILY, TUNNEL_FAMILY]);
    expect(NF_2911.portOwners).toEqual({ tunnel: 'gre' });
    expect(NF_2911.profileConfig).toEqual({ P3: TIMESTAMPS });
    expect(NF_2911.cdpDefault).toBe(true);
    expect(NF_2911.subinterfaces).toEqual({ roles: ['routed'], max: SUBINTERFACE_MAX });
    expect(Object.keys(NF_2911)).not.toContain('stpDefaultMode');
    expect([NF_2911.kind, NF_2911.bootNs, NF_2911.ipForwarding, NF_2911.portsDefaultUp, NF_2911.gui]).toEqual(['router', 45 * SEC, true, false, ['physical']]);
  });

  it('NF-WLC-9800: cdp, logger and ntp with exactly their tables — the controller has no snooping table', () => {
    expect(NF_WLC_9800.capabilities).toEqual(['switching', 'wireless-controller']);
    expect(NF_WLC_9800.processes).toEqual(['eth-switch', 'vlan', 'cdp', 'arp', 'ipv4', 'icmpv4', 'host', 'udp', 'logger', 'ntp', 'capwap-ac']);
    expect(isVlanAware(NF_WLC_9800)).toBe(true);
    expect(NF_WLC_9800.tables).toEqual(['cam', 'arp', 'rib', 'vlans', 'port-security', 'cdp-neighbours', 'sockets', 'ntp-peers', 'clock', 'capwap-aps', 'wlan-clients']);
    for (const t of ['dhcp-snooping', 'arp-inspection'] as const) expect(NF_WLC_9800.tables).not.toContain(t);
    expect(NF_WLC_9800.virtualFamilies).toEqual([CONTROLLER_VLAN_FAMILY, CAPWAP_TUNNEL_FAMILY]);
    expect(NF_WLC_9800.portOwners).toEqual({ svi: 'eth-switch', 'wlan-tunnel': 'capwap-ac' });
    expect(NF_WLC_9800.profileConfig).toEqual({ P3: TIMESTAMPS });
    expect(NF_WLC_9800.cdpDefault).toBe(true);
    expect(NF_WLC_9800.cli).toEqual({ shell: 'none', grammar: 'nfos', initialPrivilege: 1, consoleVia: [] });
    expect(NF_WLC_9800.gui).toEqual(['physical', 'wlc.controller']);
    for (const k of ['defaultConfig', 'stpDefaultMode', 'subinterfaces']) expect(Object.keys(NF_WLC_9800)).not.toContain(k);
  });

  it('home routers derive the routing rows silently (no CLI, no CDP default, no Tunnel family); the lightweight AP gains nothing', () => {
    for (const type of ['wrouter.nfhome', 'wrouter.nfhome-ax']) {
      const m = byType(type);
      for (const n of [...MUST_DAEMONS.filter((d) => d !== 'traffic'), ...APPROVED_DAEMONS.filter((d) => d !== 'syslog-server')]) {
        expect([type, n, m.processes.includes(n)]).toEqual([type, n, true]);
      }
      expect([m.cli?.shell, m.cdpDefault, m.virtualFamilies?.some((f) => f.family === 'Tunnel')]).toEqual(['none', undefined, false]);
    }
    const ap = byType('ap.nfap-lw');
    expect(ap).toEqual(defineModel(ALL_MODEL_INPUTS.find((i) => i.type === 'ap.nfap-lw')!, 'P2'));
  });
});
