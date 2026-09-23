/**
 * device.catalog.data.test.ts — the assembled catalog (device/catalog/index.ts, §8.1 W2): zero validation issues,
 * palette order, the per-model derived summary (processes, roles, cli, gui, owners), module × fitting-slot
 * uniqueness, and the DeviceCatalog lookups built by `createCatalog`.
 */
import { describe, expect, it } from 'vitest';
import {
  ALL_MODEL_INPUTS,
  ALL_MODELS,
  ALL_MODULES,
  CATALOG_STAGE,
  CatalogValidationError,
  builtInCatalogIssues,
  createCatalog,
} from '../src/device/catalog/index.js';
import * as shim from '../src/device/catalog.js';
import { defineModel, modulePortSpecs } from '../src/device/catalog/define.js';
import { virtualPortName } from '../src/device/catalog/names.js';
import { formatCatalogIssues, validateCatalog } from '../src/device/catalog/validate.js';
import { ROUTER_DATA_STAGE } from '../src/device/catalog/routers.js';
import { SWITCH_DATA_STAGE } from '../src/device/catalog/switches.js';
import { MULTILAYER_DATA_STAGE } from '../src/device/catalog/multilayer.js';
import { DATACENTRE_DATA_STAGE } from '../src/device/catalog/datacentre.js';
import { LEGACY_DATA_STAGE } from '../src/device/catalog/legacy.js';
import { SECURITY_DATA_STAGE } from '../src/device/catalog/security.js';
import { END_DEVICE_STAGE } from '../src/device/catalog/computers.js';
import { WIRELESS_MODELS } from '../src/device/catalog/wireless.js';
import { HOME_MODELS } from '../src/device/catalog/home.js';
import { RADIO_MODELS } from '../src/device/catalog/radios.js';
import { WAN_MODELS } from '../src/device/catalog/wan.js';
import { DEVICE_CATEGORIES, L3_ROLES, MAX_FIXED_PORT_ORDINAL, SLOT_ACCEPTS, type ModuleModel } from '../src/contracts/catalog.js';
import type { DeviceModel, PortNameSource } from '../src/contracts/device.js';
import type { PortSpec } from '../src/contracts/port.js';

/** Run-length summary of the default roles of a model's fixed ports: `routed×2 wan×2 console`. */
function roleSummary(model: DeviceModel): string {
  const out: string[] = [];
  let last = '';
  let count = 0;
  const flush = (): void => {
    if (count > 0) out.push(count === 1 ? last : `${last}×${count}`);
  };
  for (const p of model.ports) {
    const role = p.role ?? '?';
    if (role === last) count++;
    else {
      flush();
      last = role;
      count = 1;
    }
  }
  flush();
  return out.join(' ');
}

/** One-line derived summary of a model (the fields later waves rely on). */
function summary(model: DeviceModel): string {
  const cli = model.cli;
  const owners = Object.entries(model.portOwners ?? {}).map(([r, p]) => `${r}:${p}`).join(',');
  const virtual = (model.virtualFamilies ?? []).map((f) => `${f.family}${f.auto ? `[${f.auto.join(',')}]` : ''}`).join(',');
  return [
    `caps=${(model.capabilities ?? []).join(',')}`,
    `proc=${model.processes.join(',')}`,
    `roles=${roleSummary(model)}`,
    `cli=${cli ? `${cli.shell}/${cli.grammar}/${cli.initialPrivilege}/${cli.consoleVia.join('+')}` : '?'}`,
    `gui=${(model.gui ?? []).join(',')}`,
    `owners=${owners}`,
    `host=${(model.hostPorts ?? []).join(',')}`,
    `virtual=${virtual}`,
    `up=${model.portsDefaultUp}`,
  ].join(' | ');
}

describe('catalog index', () => {
  it('validates with zero issues at CATALOG_STAGE, and the inputs also validate at P1', () => {
    // §9.2 "P1 W5 (catalog)": the catalog was derived for P1 from that wave on; ARCHITECTURE-P2 §9.2 W4 item 13: for P2
    // since the W4 flip.
    expect(CATALOG_STAGE).toBe('P2');
    expect(formatCatalogIssues(validateCatalog(ALL_MODELS, ALL_MODULES, { stage: CATALOG_STAGE }))).toBe('');
    expect(builtInCatalogIssues()).toEqual([]);
    const p1 = ALL_MODEL_INPUTS.map((i) => defineModel(i, 'P1'));
    expect(formatCatalogIssues(validateCatalog(p1, ALL_MODULES, { stage: 'P1' }))).toBe('');
  });

  it('every data file is authored for CATALOG_STAGE', () => {
    for (const stage of [ROUTER_DATA_STAGE, SWITCH_DATA_STAGE, MULTILAYER_DATA_STAGE, DATACENTRE_DATA_STAGE, LEGACY_DATA_STAGE, SECURITY_DATA_STAGE, END_DEVICE_STAGE]) {
      expect(stage).toBe(CATALOG_STAGE);
    }
    // wireless/home/radios/wan keep a file-local stage: their model arrays must equal the catalog entries.
    for (const m of [...WIRELESS_MODELS, ...HOME_MODELS, ...RADIO_MODELS, ...WAN_MODELS]) {
      expect(ALL_MODELS.find((x) => x.type === m.type)).toEqual(m);
    }
  });

  it('lists every model once, in DEVICE_CATEGORIES order, each category populated', () => {
    expect(ALL_MODELS).toHaveLength(54);
    expect(ALL_MODULES).toHaveLength(9);
    expect(new Set(ALL_MODELS.map((m) => m.type)).size).toBe(ALL_MODELS.length);
    expect(new Set(ALL_MODELS.map((m) => m.model)).size).toBe(ALL_MODELS.length);
    const order = ALL_MODELS.map((m) => DEVICE_CATEGORIES.findIndex((c) => c.id === m.category));
    expect(order.every((c) => c >= 0)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    for (const c of DEVICE_CATEGORIES) expect(ALL_MODELS.some((m) => m.category === c.id)).toBe(true);
    ALL_MODELS.forEach((m, i) => {
      expect(m).toEqual(defineModel(ALL_MODEL_INPUTS[i]!, CATALOG_STAGE));
      expect(Object.isFrozen(m)).toBe(true);
      expect(JSON.parse(JSON.stringify(m))).toEqual(m);
    });
    expect(Object.isFrozen(ALL_MODELS)).toBe(true);
    // the home-soho end device follows the home routers
    const home = ALL_MODELS.filter((m) => m.category === 'home-soho').map((m) => m.type);
    expect(home).toEqual(['wrouter.nfhome', 'wrouter.nfhome-ax', 'tv.nfsmarttv']);
  });

  it('per-model derived summary', () => {
    const table = Object.fromEntries(ALL_MODELS.map((m) => [m.type, summary(m)]));
    expect(table).toMatchInlineSnapshot(`
      {
        "ap.nfap-auto": "caps=wifi-ap,poe-powered | proc=wlan-ap,eth-switch,arp,ipv4,icmpv4,host | roles=switched wireless-bss×2 | cli=nfos/nfos/1/console+vty | gui=physical,wireless.ap | owners=svi:eth-switch | host= | virtual=Vlan[1] | up=true",
        "ap.nfap-ax": "caps=wifi-ap,poe-powered | proc=wlan-ap,eth-switch,arp,ipv4,icmpv4,host | roles=switched wireless-bss×3 | cli=nfos/nfos/1/console+vty | gui=physical,wireless.ap | owners=svi:eth-switch | host= | virtual=Vlan[1] | up=true",
        "ap.nfap-lw": "caps=wifi-ap,poe-powered | proc=wlan-ap,eth-switch,arp,ipv4,icmpv4,host | roles=switched wireless-bss×2 | cli=nfos/nfos/1/console+vty | gui=physical,wireless.ap | owners=svi:eth-switch | host= | virtual=Vlan[1] | up=true",
        "ap.nfap-mesh": "caps=wifi-ap | proc=wlan-ap,eth-switch,arp,ipv4,icmpv4,host | roles=switched wireless-bss×2 | cli=nfos/nfos/1/console+vty | gui=physical,wireless.ap | owners=svi:eth-switch | host= | virtual=Vlan[1] | up=true",
        "bridge.nfbr2": "caps=switching | proc=eth-switch,arp,ipv4,icmpv4,host | roles=switched×2 | cli=nfos/nfos/1/console+vty | gui=physical | owners=svi:eth-switch | host= | virtual=Vlan[1] | up=true",
        "bridge.nfbr4": "caps=switching | proc=eth-switch,arp,ipv4,icmpv4,host | roles=switched×4 | cli=nfos/nfos/1/console+vty | gui=physical | owners=svi:eth-switch | host= | virtual=Vlan[1] | up=true",
        "cell.nftower": "caps=cellular-cell | proc=eth-switch | roles=switched wireless-bss | cli=none/nfos/1/ | gui=physical,cell.tower | owners= | host= | virtual= | up=true",
        "cloud.nfinternet": "caps=cloud | proc=eth-switch | roles=switched×8 access-line×16 | cli=none/nfos/1/ | gui=physical | owners= | host= | virtual= | up=true",
        "csu.nfcsu": "caps=modem | proc=eth-switch | roles=access-line×2 | cli=none/nfos/1/ | gui=physical,modem.status | owners= | host= | virtual= | up=true",
        "dcswitch.nfn9k-32": "caps=switching,routing,layer3-switch,managed-switch | proc=hdlc,eth-switch,vlan,dtp,etherchannel,stp,arp,ipv4,nat,icmpv4,host,ipv6,nd,icmpv6,udp,tcp,hsrp,dhcp-client,dhcp-server,dhcpv6-client,dhcpv6-server,dns-client,dns-server,http-server,traceroute | roles=switched×32 | cli=nfos/nfos/1/console+vty | gui=physical | owners=svi:eth-switch,channel:etherchannel | host= | virtual=Vlan[1],Port-channel,Loopback | up=true",
        "dcswitch.nfn9k-48": "caps=switching,routing,layer3-switch,managed-switch | proc=hdlc,eth-switch,vlan,dtp,etherchannel,stp,arp,ipv4,nat,icmpv4,host,ipv6,nd,icmpv6,udp,tcp,hsrp,dhcp-client,dhcp-server,dhcpv6-client,dhcpv6-server,dns-client,dns-server,http-server,traceroute | roles=switched×54 | cli=nfos/nfos/1/console+vty | gui=physical | owners=svi:eth-switch,channel:etherchannel | host= | virtual=Vlan[1],Port-channel,Loopback | up=true",
        "firewall.nfasa5506": "caps=routing,firewall | proc=hdlc,arp,ipv4,nat,icmpv4,ipv6,nd,icmpv6,udp,tcp,hsrp,dhcp-client,dhcp-server,dhcpv6-client,dhcpv6-server,dns-client,dns-server,http-server,traceroute | roles=routed×8 console | cli=nfos/nfos/1/console+vty | gui=physical | owners= | host= | virtual=Loopback | up=false",
        "firewall.nfngfw1120": "caps=routing,firewall | proc=hdlc,arp,ipv4,nat,icmpv4,ipv6,nd,icmpv6,udp,tcp,hsrp,dhcp-client,dhcp-server,dhcpv6-client,dhcpv6-server,dns-client,dns-server,http-server,traceroute | roles=routed×12 console | cli=nfos/nfos/1/console+vty | gui=physical | owners= | host= | virtual=Loopback | up=false",
        "hub.nfcoax": "caps=repeater | proc= | roles=repeater×4 | cli=none/nfos/1/ | gui=physical | owners= | host= | virtual= | up=true",
        "hub.nfhub4": "caps=repeater | proc= | roles=repeater×4 | cli=none/nfos/1/ | gui=physical | owners= | host= | virtual= | up=true",
        "hub.nfhub8": "caps=repeater | proc= | roles=repeater×8 | cli=none/nfos/1/ | gui=physical | owners= | host= | virtual= | up=true",
        "ids.nfsensor": "caps=host | proc=arp,ipv4,icmpv4,host,ipv6,nd,icmpv6,udp,tcp,dhcp-client,dhcpv6-client,dns-client,http-client,traceroute | roles=mgmt routed×2 | cli=host/host/15/console | gui=physical,desktop.ip-config,desktop.command-prompt,desktop.web-browser | owners= | host=GigabitEthernet0/0 | virtual= | up=true",
        "iot.nfcamera": "caps=host,poe-powered | proc=arp,ipv4,icmpv4,host,ipv6,nd,icmpv6,udp,tcp,dhcp-client,dhcpv6-client,dns-client,http-client,traceroute | roles=routed | cli=host/host/15/console | gui=physical,desktop.ip-config,desktop.command-prompt,desktop.web-browser | owners= | host=FastEthernet0 | virtual= | up=true",
        "iot.nfgateway": "caps=host,wifi-client | proc=wlan-client,arp,ipv4,icmpv4,host,ipv6,nd,icmpv6,udp,tcp,dhcp-client,dhcpv6-client,dns-client,http-client,traceroute | roles=routed wireless-client | cli=host/host/15/console | gui=physical,desktop.ip-config,desktop.wifi,desktop.command-prompt,desktop.web-browser | owners= | host=GigabitEthernet0,Wlan0 | virtual= | up=true",
        "iot.nfplug": "caps=host,wifi-client | proc=wlan-client,arp,ipv4,icmpv4,host,ipv6,nd,icmpv6,udp,tcp,dhcp-client,dhcpv6-client,dns-client,http-client,traceroute | roles=wireless-client | cli=host/host/15/console | gui=physical,desktop.ip-config,desktop.wifi,desktop.command-prompt,desktop.web-browser | owners= | host=Wlan0 | virtual= | up=true",
        "iot.nfsensor": "caps=host,wifi-client | proc=wlan-client,arp,ipv4,icmpv4,host,ipv6,nd,icmpv6,udp,tcp,dhcp-client,dhcpv6-client,dns-client,http-client,traceroute | roles=wireless-client | cli=host/host/15/console | gui=physical,desktop.ip-config,desktop.wifi,desktop.command-prompt,desktop.web-browser | owners= | host=Wlan0 | virtual= | up=true",
        "iot.nfthermostat": "caps=host,wifi-client | proc=wlan-client,arp,ipv4,icmpv4,host,ipv6,nd,icmpv6,udp,tcp,dhcp-client,dhcpv6-client,dns-client,http-client,traceroute | roles=wireless-client | cli=host/host/15/console | gui=physical,desktop.ip-config,desktop.wifi,desktop.command-prompt,desktop.web-browser | owners= | host=Wlan0 | virtual= | up=true",
        "ipphone.nfphone": "caps=host,switching,poe-powered | proc=eth-switch,arp,ipv4,icmpv4,host,ipv6,nd,icmpv6,udp,tcp,dhcp-client,dhcpv6-client,dns-client,http-client,traceroute | roles=switched×2 | cli=host/host/15/console | gui=physical,desktop.ip-config,desktop.command-prompt,desktop.web-browser | owners=svi:eth-switch | host=Vlan1 | virtual=Vlan[1] | up=true",
        "laptop.nflaptop": "caps=host,wifi-client | proc=wlan-client,arp,ipv4,icmpv4,host,ipv6,nd,icmpv6,udp,tcp,dhcp-client,dhcpv6-client,dns-client,http-client,traceroute | roles=routed wireless-client console | cli=host/host/15/console | gui=physical,desktop.ip-config,desktop.wifi,desktop.command-prompt,desktop.web-browser | owners= | host=GigabitEthernet0,Wlan0 | virtual= | up=true",
        "mlswitch.nfc3650-24": "caps=switching,routing,layer3-switch,managed-switch | proc=hdlc,eth-switch,vlan,dtp,etherchannel,stp,arp,ipv4,nat,icmpv4,host,ipv6,nd,icmpv6,udp,tcp,hsrp,dhcp-client,dhcp-server,dhcpv6-client,dhcpv6-server,dns-client,dns-server,http-server,traceroute | roles=switched×28 | cli=nfos/nfos/1/console+vty | gui=physical | owners=svi:eth-switch,channel:etherchannel | host= | virtual=Vlan[1],Port-channel,Loopback | up=true",
        "mlswitch.nfc9300-48": "caps=switching,routing,layer3-switch,poe-source,managed-switch | proc=hdlc,eth-switch,vlan,dtp,etherchannel,stp,arp,ipv4,nat,icmpv4,host,ipv6,nd,icmpv6,udp,tcp,hsrp,dhcp-client,dhcp-server,dhcpv6-client,dhcpv6-server,dns-client,dns-server,http-server,traceroute | roles=switched×56 | cli=nfos/nfos/1/console+vty | gui=physical | owners=svi:eth-switch,channel:etherchannel | host= | virtual=Vlan[1],Port-channel,Loopback | up=true",
        "modem.nfcable": "caps=modem | proc=eth-switch | roles=switched access-line | cli=none/nfos/1/ | gui=physical,modem.status | owners= | host= | virtual= | up=true",
        "modem.nfdsl": "caps=modem | proc=eth-switch | roles=switched access-line | cli=none/nfos/1/ | gui=physical,modem.status | owners= | host= | virtual= | up=true",
        "modem.nfont": "caps=modem | proc=eth-switch | roles=switched access-line | cli=none/nfos/1/ | gui=physical,modem.status | owners= | host= | virtual= | up=true",
        "pc.nfpc": "caps=host | proc=arp,ipv4,icmpv4,host,ipv6,nd,icmpv6,udp,tcp,dhcp-client,dhcpv6-client,dns-client,http-client,traceroute | roles=routed | cli=host/host/15/console | gui=physical,desktop.ip-config,desktop.command-prompt,desktop.web-browser | owners= | host=GigabitEthernet0 | virtual= | up=true",
        "pc.nfpc-wifi": "caps=host,wifi-client | proc=wlan-client,arp,ipv4,icmpv4,host,ipv6,nd,icmpv6,udp,tcp,dhcp-client,dhcpv6-client,dns-client,http-client,traceroute | roles=routed wireless-client | cli=host/host/15/console | gui=physical,desktop.ip-config,desktop.wifi,desktop.command-prompt,desktop.web-browser | owners= | host=GigabitEthernet0,Wlan0 | virtual= | up=true",
        "phone.nfsmartphone": "caps=host,wifi-client,cellular-client | proc=wlan-client,cell-client,arp,ipv4,icmpv4,host,ipv6,nd,icmpv6,udp,tcp,dhcp-client,dhcpv6-client,dns-client,http-client,traceroute | roles=wireless-client cellular | cli=host/host/15/console | gui=physical,desktop.ip-config,desktop.wifi,desktop.cellular,desktop.command-prompt,desktop.web-browser | owners= | host=Wlan0,Cellular0 | virtual= | up=true",
        "printer.nfprinter": "caps=host,wifi-client | proc=wlan-client,arp,ipv4,icmpv4,host,ipv6,nd,icmpv6,udp,tcp,dhcp-client,dhcpv6-client,dns-client,http-client,traceroute | roles=routed wireless-client | cli=host/host/15/console | gui=physical,desktop.ip-config,desktop.wifi,desktop.command-prompt,desktop.web-browser | owners= | host=FastEthernet0,Wlan0 | virtual= | up=true",
        "radio.nfptp5": "caps=radio-bridge | proc=eth-switch | roles=switched radio-ptp | cli=none/nfos/1/ | gui=physical,radio.link | owners= | host= | virtual= | up=true",
        "radio.nfptp60": "caps=radio-bridge | proc=eth-switch | roles=switched radio-ptp | cli=none/nfos/1/ | gui=physical,radio.link | owners= | host= | virtual= | up=true",
        "repeater.nfrep": "caps=repeater | proc= | roles=repeater×2 | cli=none/nfos/1/ | gui=physical | owners= | host= | virtual= | up=true",
        "router.nf1941": "caps=routing,modular | proc=hdlc,arp,ipv4,nat,icmpv4,ipv6,nd,icmpv6,udp,tcp,hsrp,dhcp-client,dhcp-server,dhcpv6-client,dhcpv6-server,dns-client,dns-server,http-server,traceroute | roles=routed×2 console×2 | cli=nfos/nfos/1/console+vty | gui=physical | owners=svi:eth-switch | host= | virtual=Vlan,Loopback | up=false",
        "router.nf2911": "caps=routing | proc=hdlc,arp,ipv4,nat,icmpv4,ipv6,nd,icmpv6,udp,tcp,hsrp,dhcp-client,dhcp-server,dhcpv6-client,dhcpv6-server,dns-client,dns-server,http-server,traceroute | roles=routed×2 wan×2 console | cli=nfos/nfos/1/console+vty | gui=physical | owners= | host= | virtual=Loopback | up=false",
        "router.nf4331": "caps=routing,modular | proc=hdlc,arp,ipv4,nat,icmpv4,ipv6,nd,icmpv6,udp,tcp,hsrp,dhcp-client,dhcp-server,dhcpv6-client,dhcpv6-server,dns-client,dns-server,http-server,traceroute | roles=routed×3 console×2 | cli=nfos/nfos/1/console+vty | gui=physical | owners=svi:eth-switch | host= | virtual=Vlan,Loopback | up=false",
        "router.nf4451": "caps=routing,modular | proc=hdlc,arp,ipv4,nat,icmpv4,ipv6,nd,icmpv6,udp,tcp,hsrp,dhcp-client,dhcp-server,dhcpv6-client,dhcpv6-server,dns-client,dns-server,http-server,traceroute | roles=routed×6 console | cli=nfos/nfos/1/console+vty | gui=physical | owners=svi:eth-switch | host= | virtual=Vlan,Loopback | up=false",
        "router.nfgeneric": "caps=routing,modular | proc=hdlc,arp,ipv4,nat,icmpv4,ipv6,nd,icmpv6,udp,tcp,hsrp,dhcp-client,dhcp-server,dhcpv6-client,dhcpv6-server,dns-client,dns-server,http-server,traceroute | roles=console | cli=nfos/nfos/1/console+vty | gui=physical | owners=svi:eth-switch | host= | virtual=Vlan,Loopback | up=false",
        "server.nfrack": "caps=host,server | proc=arp,ipv4,icmpv4,host,ipv6,nd,icmpv6,udp,tcp,dhcp-client,dhcp-server,dhcpv6-client,dns-client,dns-server,http-client,http-server,traceroute | roles=routed×6 | cli=host/host/15/console | gui=physical,desktop.ip-config,desktop.command-prompt,desktop.web-browser,services | owners= | host=GigabitEthernet0,GigabitEthernet1,GigabitEthernet2,GigabitEthernet3,TenGigabitEthernet0,TenGigabitEthernet1 | virtual= | up=true",
        "server.nfserver": "caps=host,server | proc=arp,ipv4,icmpv4,host,ipv6,nd,icmpv6,udp,tcp,dhcp-client,dhcp-server,dhcpv6-client,dns-client,dns-server,http-client,http-server,traceroute | roles=routed×2 | cli=host/host/15/console | gui=physical,desktop.ip-config,desktop.command-prompt,desktop.web-browser,services | owners= | host=GigabitEthernet0,GigabitEthernet1 | virtual= | up=true",
        "switch.nfc2960": "caps=switching,managed-switch | proc=eth-switch,vlan,dtp,etherchannel,stp,arp,ipv4,icmpv4,host | roles=switched×26 | cli=nfos/nfos/1/console+vty | gui=physical | owners=svi:eth-switch,channel:etherchannel | host= | virtual=Vlan[1],Port-channel | up=true",
        "switch.nfc2960-24pg": "caps=switching,poe-source,managed-switch | proc=eth-switch,vlan,dtp,etherchannel,stp,arp,ipv4,icmpv4,host | roles=switched×28 | cli=nfos/nfos/1/console+vty | gui=physical | owners=svi:eth-switch,channel:etherchannel | host= | virtual=Vlan[1],Port-channel | up=true",
        "switch.nfc2960-48": "caps=switching,managed-switch | proc=eth-switch,vlan,dtp,etherchannel,stp,arp,ipv4,icmpv4,host | roles=switched×50 | cli=nfos/nfos/1/console+vty | gui=physical | owners=svi:eth-switch,channel:etherchannel | host= | virtual=Vlan[1],Port-channel | up=true",
        "switch.nfc2960-8": "caps=switching,managed-switch | proc=eth-switch,vlan,dtp,etherchannel,stp,arp,ipv4,icmpv4,host | roles=switched×9 | cli=nfos/nfos/1/console+vty | gui=physical | owners=svi:eth-switch,channel:etherchannel | host= | virtual=Vlan[1],Port-channel | up=true",
        "switch.nfc9200-48": "caps=switching,poe-source,managed-switch | proc=eth-switch,vlan,dtp,etherchannel,stp,arp,ipv4,icmpv4,host | roles=switched×52 | cli=nfos/nfos/1/console+vty | gui=physical | owners=svi:eth-switch,channel:etherchannel | host= | virtual=Vlan[1],Port-channel | up=true",
        "tablet.nftablet": "caps=host,wifi-client | proc=wlan-client,arp,ipv4,icmpv4,host,ipv6,nd,icmpv6,udp,tcp,dhcp-client,dhcpv6-client,dns-client,http-client,traceroute | roles=wireless-client | cli=host/host/15/console | gui=physical,desktop.ip-config,desktop.wifi,desktop.command-prompt,desktop.web-browser | owners= | host=Wlan0 | virtual= | up=true",
        "tablet.nftablet-lte": "caps=host,wifi-client,cellular-client | proc=wlan-client,cell-client,arp,ipv4,icmpv4,host,ipv6,nd,icmpv6,udp,tcp,dhcp-client,dhcpv6-client,dns-client,http-client,traceroute | roles=wireless-client cellular | cli=host/host/15/console | gui=physical,desktop.ip-config,desktop.wifi,desktop.cellular,desktop.command-prompt,desktop.web-browser | owners= | host=Wlan0,Cellular0 | virtual= | up=true",
        "tv.nfsmarttv": "caps=host,wifi-client | proc=wlan-client,arp,ipv4,icmpv4,host,ipv6,nd,icmpv6,udp,tcp,dhcp-client,dhcpv6-client,dns-client,http-client,traceroute | roles=routed wireless-client | cli=host/host/15/console | gui=physical,desktop.ip-config,desktop.wifi,desktop.command-prompt,desktop.web-browser | owners= | host=FastEthernet0,Wlan0 | virtual= | up=true",
        "wlc.nfwlc3504": "caps=host | proc=arp,ipv4,icmpv4,host,ipv6,nd,icmpv6,udp,tcp,dhcp-client,dhcpv6-client,dns-client,http-client,traceroute | roles=routed×4 console | cli=host/host/15/console | gui=physical,desktop.ip-config,desktop.command-prompt,desktop.web-browser | owners= | host=GigabitEthernet0/1,GigabitEthernet0/2,GigabitEthernet0/3,GigabitEthernet0/4 | virtual= | up=true",
        "wrouter.nfhome": "caps=switching,routing,wifi-ap,nat-gateway,dhcp-server | proc=wlan-ap,hdlc,eth-switch,arp,ipv4,nat,icmpv4,host,ipv6,nd,icmpv6,udp,tcp,hsrp,dhcp-client,dhcp-server,dhcpv6-client,dhcpv6-server,dns-client,dns-server,http-server,traceroute | roles=wan switched×4 wireless-bss×2 | cli=none/nfos/1/ | gui=physical,home-router.setup | owners=svi:eth-switch | host= | virtual=Vlan[1] | up=true",
        "wrouter.nfhome-ax": "caps=switching,routing,wifi-ap,nat-gateway,dhcp-server | proc=wlan-ap,hdlc,eth-switch,arp,ipv4,nat,icmpv4,host,ipv6,nd,icmpv6,udp,tcp,hsrp,dhcp-client,dhcp-server,dhcpv6-client,dhcpv6-server,dns-client,dns-server,http-server,traceroute | roles=wan switched×4 wireless-bss×3 | cli=none/nfos/1/ | gui=physical,home-router.setup | owners=svi:eth-switch | host= | virtual=Vlan[1] | up=true",
      }
    `);
  });

  it('every model that boots the IPv4 host stack has somewhere to hold an address', () => {
    // P1 W5 (catalog, §9.2 "L2 switches and APs get the Vlan family"): a device with arp/ipv4/icmpv4/host must have
    // a fixed L3 port or a virtual family that takes one — otherwise its `ip default-gateway` line can do nothing.
    const addressable = (m: DeviceModel): boolean =>
      m.ports.some((p) => L3_ROLES.includes(p.role ?? 'switched') || (p.allowedRoles ?? []).some((r) => L3_ROLES.includes(r))) ||
      (m.virtualFamilies ?? []).some((f) => L3_ROLES.includes(f.role));
    for (const model of ALL_MODELS) {
      if (!(model.processes ?? []).includes('ipv4')) continue;
      expect([model.type, addressable(model)]).toEqual([model.type, true]);
    }
  });

  it('every module × fitting slot adds unique port names and ordinals on every model', () => {
    let checked = 0;
    for (const model of ALL_MODELS) {
      const fixedNames = new Set<string>();
      const fixedOrdinals = new Set<number>();
      for (const p of model.ports) {
        fixedNames.add(p.name.toLowerCase());
        fixedNames.add(p.short.toLowerCase());
        if (p.ordinal !== undefined) fixedOrdinals.add(p.ordinal);
      }
      for (const f of model.virtualFamilies ?? []) for (const n of f.auto ?? []) fixedNames.add(virtualPortName(f, n).toLowerCase());
      expect([...fixedOrdinals].every((o) => o >= 1 && o <= MAX_FIXED_PORT_ORDINAL)).toBe(true);

      /** Names each slot can ever generate (union over its fitting modules), for the cross-slot check. */
      const perSlot: Set<string>[] = [];
      for (const slot of model.slots ?? []) {
        const accepts = SLOT_ACCEPTS[slot.type];
        const union = new Set<string>();
        for (const module of ALL_MODULES) {
          if (!accepts.includes(module.fits)) continue;
          checked++;
          const specs: readonly PortSpec[] = modulePortSpecs(model, slot, module);
          if (module.transceiver !== undefined) {
            expect(specs).toEqual([]);
            expect(model.ports.some((p) => p.name === slot.cage)).toBe(true);
            continue;
          }
          const names = new Set<string>();
          const ordinals = new Set<number>();
          for (const s of specs) {
            const lower = s.name.toLowerCase();
            expect(fixedNames.has(lower), `${model.type} ${slot.id} ${module.type} ${s.name}`).toBe(false);
            expect(fixedNames.has(s.short.toLowerCase())).toBe(false);
            expect(names.has(lower)).toBe(false);
            names.add(lower);
            expect(s.ordinal).toBeDefined();
            const o = s.ordinal as number;
            expect(o).toBeGreaterThan(MAX_FIXED_PORT_ORDINAL);
            expect(o).toBeLessThanOrEqual(255);
            expect(fixedOrdinals.has(o) || ordinals.has(o)).toBe(false);
            ordinals.add(o);
            expect(s.slot).toBe(slot.id);
            expect(s.module).toBe(module.type);
            union.add(lower);
          }
        }
        perSlot.push(union);
        if (slot.defaultModule !== undefined) {
          const def = ALL_MODULES.find((m) => m.type === slot.defaultModule);
          expect(def && accepts.includes(def.fits)).toBe(true);
        }
      }
      for (let a = 0; a < perSlot.length; a++) {
        for (let b = a + 1; b < perSlot.length; b++) {
          const shared = [...perSlot[a]!].filter((n) => perSlot[b]!.has(n));
          expect(shared, `${model.type} slots ${a} and ${b}`).toEqual([]);
        }
      }
    }
    expect(checked).toBeGreaterThan(0);
  });
});

describe('createCatalog', () => {
  it('builds lookups over the built-in lists', () => {
    const factory = () => ({ name: 'arp', onPdu: () => [], onTimer: () => [], onConfig: () => [], stateSnapshot: () => ({ process: 'arp', state: {} }), debugEvents: () => [] });
    const cat = createCatalog({ arp: factory });
    expect(cat.list()).toBe(ALL_MODELS);
    expect(cat.get('router.nf2911')).toBe(ALL_MODELS.find((m) => m.type === 'router.nf2911'));
    expect(cat.get('router.nope')).toBeUndefined();
    expect(cat.process('arp')).toBe(factory);
    expect(cat.process('hdlc')).toBeUndefined();
    expect(cat.modules?.()).toBe(ALL_MODULES);
    expect(cat.module?.('mod.ehwic-2t')?.model).toBe('NF-EHWIC-2T');
    expect(cat.module?.('mod.nope')).toBeUndefined();
    expect(shim.canonicalPort(shim.NF_2911, 'se0/0/1')).toBe('Serial0/0/1');
    expect(cat.resolvePort({ model: shim.NF_2911, ports: new Map(shim.NF_2911.ports.map((spec) => [spec.name, { spec }] as const)) }, 'se0/0/1')).toEqual({ kind: 'existing', port: 'Serial0/0/1' });
  });

  it('resolvePort covers module and virtual ports of a live source', () => {
    const cat = createCatalog({});
    const model = cat.get('router.nf1941') as DeviceModel;
    const slot = (model.slots ?? [])[0]!;
    const module = cat.module?.('mod.ehwic-2t') as ModuleModel;
    const specs = [...model.ports, ...modulePortSpecs(model, slot, module)];
    const source: PortNameSource = { model, ports: new Map(specs.map((s) => [s.name, { spec: s }])) };
    const serial = specs.find((s) => s.kind === 'serial')!;
    expect(cat.resolvePort?.(source, serial.short.toLowerCase())).toEqual({ kind: 'existing', port: serial.name });
    expect(cat.resolvePort?.(source, 'lo 3')).toEqual({ kind: 'virtual', port: 'Loopback3', family: 'Loopback' });
    expect(cat.resolvePort?.(source, 'bogus9')).toEqual({ kind: 'unknown' });
  });

  it('refuses an invalid catalog with every issue', () => {
    const pc = ALL_MODELS.find((m) => m.type === 'pc.nfpc')!;
    const dup = [pc, pc];
    expect(() => createCatalog({}, { models: dup })).toThrow(CatalogValidationError);
    try {
      createCatalog({}, { models: dup });
    } catch (e) {
      const err = e as CatalogValidationError;
      expect(err.issues.map((i) => i.code)).toContain('duplicate-type');
      expect(err.message).toContain('[duplicate-type]');
    }
    expect(() => createCatalog({}, { models: [pc], modules: [] })).not.toThrow();
  });

  it('the shim re-exports the catalog and the P0 models are catalog entries', () => {
    expect(shim.createCatalog).toBe(createCatalog);
    expect(shim.ALL_MODELS).toBe(ALL_MODELS);
    expect(shim.P0_MODELS.map((m) => m.type)).toEqual(['pc.nfpc', 'switch.nfc2960', 'router.nf2911']);
    for (const m of shim.P0_MODELS) expect(ALL_MODELS).toContain(m);
    expect(shim.SPEED_SERIAL_2M).toBe(2_000_000);
    expect(shim.SPEED_CONSOLE).toBe(9_600);
  });
});
