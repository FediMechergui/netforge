import { describe, expect, it } from 'vitest';
import { WIRELESS_INPUTS, WIRELESS_MODELS } from '../src/device/catalog/wireless.js';
import { HOME_INPUTS, HOME_MODELS } from '../src/device/catalog/home.js';
import { RADIO_INPUTS, RADIO_MODELS } from '../src/device/catalog/radios.js';
import { WAN_INPUTS, WAN_MODELS } from '../src/device/catalog/wan.js';
import { HOME_ROUTER_VLAN_FAMILY, defineModel } from '../src/device/catalog/define.js';
import { findBannedWords, formatCatalogIssues, validateCatalog } from '../src/device/catalog/validate.js';
import { assessRfLink, type RfLinkEnd } from '../src/link/rf/mcs.js';
import { pathLossClassOf } from '../src/link/rf/pathloss.js';
import { HOST_IP_DEFAULTS, ROUTER_IP_DEFAULTS, ROLE_TRAITS, radioModeOf } from '../src/contracts/index.js';
import { MEDIA } from '../src/contracts/link.js';
import type { DeviceModel } from '../src/contracts/device.js';
import type { PortSpec } from '../src/contracts/port.js';
import type { ChannelWidthMhz, RadioPortSpec, RfBand } from '../src/contracts/rf.js';

const ALL: readonly DeviceModel[] = [...WIRELESS_MODELS, ...HOME_MODELS, ...RADIO_MODELS, ...WAN_MODELS];
const byType = (type: string): DeviceModel => {
  const m = ALL.find((x) => x.type === type);
  if (!m) throw new Error(`missing ${type}`);
  return m;
};
const port = (m: DeviceModel, name: string): PortSpec => {
  const p = m.ports.find((x) => x.name === name);
  if (!p) throw new Error(`missing ${m.type} ${name}`);
  return p;
};
const radioOf = (m: DeviceModel, name: string): RadioPortSpec => {
  const r = port(m, name).radio;
  if (!r) throw new Error(`no radio on ${m.type} ${name}`);
  return r;
};
const end = (r: RadioPortSpec): RfLinkEnd => ({ txPowerDbm: r.maxTxPowerDbm, antennaGainDbi: r.antennaGainDbi, generations: r.generations, streams: r.streams });

/** A typical laptop Wi-Fi adapter (the end-device files own the real one). */
const STATION: RfLinkEnd = { txPowerDbm: 17, antennaGainDbi: 2, generations: ['b', 'g', 'n', 'ac', 'ax'], streams: 2 };
/** A typical phone cellular adapter. */
const UE: RfLinkEnd = { txPowerDbm: 23, antennaGainDbi: 0, generations: ['lte'], streams: 2 };

function assess(band: RfBand, cls: 'wifi' | 'ptp' | 'cell', widthMhz: ChannelWidthMhz, metres: number, a: RfLinkEnd, b: RfLinkEnd) {
  return assessRfLink({ band, cls, widthMhz, distanceMm: metres * 1000, a, b });
}

describe('wireless and WAN catalog data', () => {
  it('validates with zero issues at P0.5 and P1', () => {
    // §8.2 W5: the exported arrays are derived at 'P1'; the same inputs must also validate at P0.5.
    const inputs = [...WIRELESS_INPUTS, ...HOME_INPUTS, ...RADIO_INPUTS, ...WAN_INPUTS];
    const p05 = validateCatalog(inputs.map((i) => defineModel(i, 'P0.5')), [], { stage: 'P0.5' });
    expect(formatCatalogIssues(p05)).toBe('');
    expect(formatCatalogIssues(validateCatalog(ALL, [], { stage: 'P1' }))).toBe('');
  });

  it('lists every CATALOG.md model of the four categories in table order', () => {
    expect(WIRELESS_MODELS.map((m) => [m.type, m.model, m.category, m.icon])).toEqual([
      ['ap.nfap-auto', 'NF-AP-2600', 'wireless', 'ap'],
      ['ap.nfap-lw', 'NF-AP-1832', 'wireless', 'ap'],
      ['ap.nfap-mesh', 'NF-AP-1562', 'wireless', 'ap-outdoor'],
      ['ap.nfap-ax', 'NF-AP-9120', 'wireless', 'ap'],
      ['wlc.nfwlc3504', 'NF-WLC-3504', 'wireless', 'wlc'],
    ]);
    expect(HOME_MODELS.map((m) => [m.type, m.model, m.category, m.icon])).toEqual([
      ['wrouter.nfhome', 'NF-HOMEROUTER', 'home-soho', 'home-router'],
      ['wrouter.nfhome-ax', 'NF-HOMEROUTER-AX', 'home-soho', 'home-router'],
    ]);
    expect(RADIO_MODELS.map((m) => [m.type, m.model, m.category, m.icon])).toEqual([
      ['radio.nfptp5', 'NF-RADIO-PTP5', 'radios', 'radio-ptp'],
      ['radio.nfptp60', 'NF-RADIO-PTP60', 'radios', 'radio-ptp'],
      ['cell.nftower', 'NF-CELL-TOWER', 'radios', 'cell-tower'],
    ]);
    expect(WAN_MODELS.map((m) => [m.type, m.model, m.category, m.icon])).toEqual([
      ['modem.nfdsl', 'NF-DSL-MODEM', 'wan-isp', 'modem-dsl'],
      ['modem.nfcable', 'NF-CABLE-MODEM', 'wan-isp', 'modem-cable'],
      ['modem.nfont', 'NF-FIBER-ONT', 'wan-isp', 'ont'],
      ['csu.nfcsu', 'NF-CSU-DSU', 'wan-isp', 'csu'],
      ['cloud.nfinternet', 'NF-INTERNET', 'wan-isp', 'cloud'],
    ]);
  });

  it('models are frozen and JSON / structured-clone safe', () => {
    for (const m of ALL) {
      expect(Object.isFrozen(m)).toBe(true);
      expect(Object.isFrozen(m.ports[0]?.radio ?? m.ports[0])).toBe(true);
      expect(JSON.parse(JSON.stringify(m))).toEqual(m);
      expect(structuredClone(m)).toEqual(m);
    }
  });

  it('uses original wording in every text field and port name', () => {
    for (const m of ALL) {
      const texts = [m.model, m.description, m.family ?? '', m.variant ?? '', ...(m.tags ?? []), ...m.ports.map((p) => p.name)];
      for (const t of texts) expect(findBannedWords(t), `${m.type}: ${t}`).toEqual([]);
    }
  });
});

describe('derived summaries', () => {
  const summary = (m: DeviceModel) => ({
    capabilities: m.capabilities,
    processes: m.processes,
    shell: m.cli?.shell,
    grammar: m.cli?.grammar,
    gui: m.gui,
    owners: m.portOwners,
    families: (m.virtualFamilies ?? []).map((f) => f.family),
    hostPorts: m.hostPorts,
    ports: m.ports.map((p) => `${p.short}:${p.role}:${p.encap}:${p.connector}`),
  });

  it('access points bridge a switched uplink with wireless-bss radios', () => {
    expect(summary(byType('ap.nfap-auto'))).toEqual({
      capabilities: ['wifi-ap', 'poe-powered'],
      processes: ['wlan-ap', 'eth-switch', 'arp', 'ipv4', 'icmpv4', 'host'],
      shell: 'nfos',
      grammar: 'nfos',
      gui: ['physical', 'wireless.ap'],
      // P1 W5 (catalog): an AP boots arp/ipv4/icmpv4/host, so it derives the same management Vlan1 the L2 switches
      // carry as data — without it `ip default-gateway` on an AP could never do anything (§9.2 CLI bullet).
      owners: { svi: 'eth-switch' },
      families: ['Vlan'],
      hostPorts: [],
      ports: ['Gi0:switched:ethernet:rj45', 'Wl0:wireless-bss:dot11:antenna', 'Wl1:wireless-bss:dot11:antenna'],
    });
    expect(port(byType('ap.nfap-auto'), 'GigabitEthernet0').poe).toEqual({ pd: { standard: 'at', drawW: 25.5 } });
    expect(port(byType('ap.nfap-mesh'), 'GigabitEthernet0').poe).toBeUndefined();
    const ax = byType('ap.nfap-ax');
    expect(ax.ports.map((p) => [p.short, p.radio?.defaultBand ?? null, p.ordinal])).toEqual([['Gi0', null, 1], ['Wl0', '2.4', 2], ['Wl1', '5', 3], ['Wl2', '6', 4]]);
    expect(ax.ipDefaults).toEqual(ROUTER_IP_DEFAULTS);
  });

  it('the controller is an end system with a host shell', () => {
    const wlc = byType('wlc.nfwlc3504');
    expect(summary(wlc)).toMatchObject({
      capabilities: ['host'],
      processes: ['arp', 'ipv4', 'icmpv4', 'host', 'ipv6', 'nd', 'icmpv6', 'udp', 'tcp', 'dhcp-client', 'dns-client', 'http-client', 'traceroute'],
      shell: 'host',
      gui: ['physical', 'desktop.ip-config', 'desktop.command-prompt', 'desktop.web-browser'],
      hostPorts: ['GigabitEthernet0/1', 'GigabitEthernet0/2', 'GigabitEthernet0/3', 'GigabitEthernet0/4'],
    });
    expect(wlc.ipDefaults).toEqual(HOST_IP_DEFAULTS);
    expect(port(wlc, 'Console')).toMatchObject({ role: 'console', group: 'console' });
  });

  it('home routers: routed MDI Internet port, switched LAN, access radios, auto Vlan1, GUI-only', () => {
    for (const type of ['wrouter.nfhome', 'wrouter.nfhome-ax']) {
      const m = byType(type);
      expect(summary(m)).toMatchObject({
        capabilities: ['switching', 'routing', 'wifi-ap', 'nat-gateway', 'dhcp-server'],
        processes: ['wlan-ap', 'hdlc', 'eth-switch', 'arp', 'ipv4', 'icmpv4', 'host', 'ipv6', 'nd', 'icmpv6', 'udp', 'tcp', 'dhcp-client', 'dhcp-server', 'dns-client', 'dns-server', 'http-server', 'traceroute'],
        shell: 'none',
        grammar: 'nfos',
        gui: ['physical', 'home-router.setup'],
        owners: { svi: 'eth-switch' },
        families: ['Vlan'],
      });
      expect(m.virtualFamilies).toEqual([HOME_ROUTER_VLAN_FAMILY]);
      expect(m.cli?.consoleVia).toEqual([]);
      expect(port(m, 'Internet')).toMatchObject({ short: 'Inet', role: 'wan', wiring: 'MDI', autoMdix: false, ordinal: 1 });
      for (let n = 1; n <= 4; n++) expect(port(m, `GigabitEthernet${n}`)).toMatchObject({ role: 'switched', wiring: 'MDI-X', autoMdix: true });
      expect(port(m, 'Wlan0')).toMatchObject({ role: 'wireless-bss', encap: 'dot11', group: 'radio' });
      expect(m.portsDefaultUp).toBe(true);
      expect(m.ipForwarding).toBe(true);
    }
    expect(byType('wrouter.nfhome').ports.map((p) => p.short)).toEqual(['Inet', 'Gi1', 'Gi2', 'Gi3', 'Gi4', 'Wl0', 'Wl1']);
    expect(byType('wrouter.nfhome-ax').ports.map((p) => p.short)).toEqual(['Inet', 'Gi1', 'Gi2', 'Gi3', 'Gi4', 'Wl0', 'Wl1', 'Wl2']);
  });

  it('radio bridges and the tower bridge a wired port with their radio, without a shell', () => {
    for (const type of ['radio.nfptp5', 'radio.nfptp60']) {
      expect(summary(byType(type))).toEqual({
        capabilities: ['radio-bridge'],
        processes: ['eth-switch'],
        shell: 'none',
        grammar: 'nfos',
        gui: ['physical', 'radio.link'],
        owners: {},
        families: [],
        hostPorts: [],
        ports: ['Gi0:switched:ethernet:rj45', 'Rd0:radio-ptp:ethernet:antenna'],
      });
    }
    const tower = byType('cell.nftower');
    expect(summary(tower)).toMatchObject({
      capabilities: ['cellular-cell'],
      processes: ['eth-switch'],
      shell: 'none',
      gui: ['physical', 'cell.tower'],
      ports: ['Gi0:switched:ethernet:rj45', 'Ce0:wireless-bss:ethernet:antenna'],
    });
    const ce0 = port(tower, 'Cellular0');
    expect(radioModeOf(ce0.kind, ce0.role ?? 'cellular')).toBe('tower');
    expect(ROLE_TRAITS[ce0.role ?? 'cellular'].hairpin).toBe(true);
    const rd0 = port(byType('radio.nfptp5'), 'Radio0');
    expect(radioModeOf(rd0.kind, rd0.role ?? 'routed')).toBe('ptp');
    expect(ROLE_TRAITS[rd0.role ?? 'routed'].linkable).toBe(true);
  });

  it('WAN devices are shell-less bridges with access-line ports', () => {
    expect(summary(byType('modem.nfdsl'))).toEqual({
      capabilities: ['modem'],
      processes: ['eth-switch'],
      shell: 'none',
      grammar: 'nfos',
      gui: ['physical', 'modem.status'],
      owners: {},
      families: [],
      hostPorts: [],
      ports: ['Gi0:switched:ethernet:rj45', 'Ph0:access-line:ethernet:rj11'],
    });
    expect(summary(byType('modem.nfcable')).ports).toEqual(['Gi0:switched:ethernet:rj45', 'Cx0:access-line:ethernet:f-type']);
    expect(summary(byType('modem.nfont')).ports).toEqual(['Gi0:switched:ethernet:rj45', 'Fb0:access-line:ethernet:sc']);
    expect(summary(byType('csu.nfcsu'))).toMatchObject({ processes: ['eth-switch'], shell: 'none', gui: ['physical', 'modem.status'], ports: ['Se0:access-line:hdlc:db60', 'Se1:access-line:hdlc:db60'] });
    const cloud = byType('cloud.nfinternet');
    expect(summary(cloud)).toMatchObject({ capabilities: ['cloud'], processes: ['eth-switch'], shell: 'none', gui: ['physical'] });
    expect(cloud.ports.map((p) => p.short)).toEqual([
      'Gi0', 'Gi1', 'Gi2', 'Gi3', 'Gi4', 'Gi5', 'Gi6', 'Gi7',
      'Ph0', 'Ph1', 'Ph2', 'Ph3', 'Cx0', 'Cx1', 'Cx2', 'Cx3', 'Fb0', 'Fb1', 'Fb2', 'Fb3', 'Se0', 'Se1', 'Se2', 'Se3',
    ]);
    expect(cloud.ports.map((p) => p.ordinal)).toEqual(Array.from({ length: 24 }, (_, i) => i + 1));
    expect(cloud.ports.slice(8).every((p) => p.role === 'access-line')).toBe(true);
  });
});

describe('physical pairing', () => {
  it('each modem line port mates with the matching provider cloud port (kind, connector, speed)', () => {
    const cloud = byType('cloud.nfinternet');
    const pairs: [string, string, string][] = [['modem.nfdsl', 'Phone0', 'Phone0'], ['modem.nfcable', 'Coax0', 'Coax0'], ['modem.nfont', 'Fiber0', 'Fiber0']];
    for (const [type, local, remote] of pairs) {
      const a = port(byType(type), local);
      const b = port(cloud, remote);
      expect([a.kind, a.connector, a.speedBps]).toEqual([b.kind, b.connector, b.speedBps]);
      const media = Object.values(MEDIA).find((s) => s.portKinds.length === 1 && s.portKinds[0] === a.kind);
      expect(media, `${a.kind} media`).toBeDefined();
      const mates = (media?.connectors ?? []).some((c) => c.a.includes(a.connector ?? 'none') && c.b.includes(b.connector ?? 'none'));
      expect(mates).toBe(true);
    }
  });

  it('the line unit clocks the customer side; provider serial ports clock their lines', () => {
    const csu = byType('csu.nfcsu');
    expect(port(csu, 'Serial0').clockSource).toBe(true);
    expect(port(csu, 'Serial1').clockSource).toBeUndefined();
    for (const p of byType('cloud.nfinternet').ports.filter((x) => x.kind === 'serial')) expect(p.clockSource).toBe(true);
  });

  it('the home router Internet port is the only port outside the LAN bridge', () => {
    const m = byType('wrouter.nfhome');
    expect(m.ports.filter((p) => !ROLE_TRAITS[p.role ?? 'routed'].bridged).map((p) => p.name)).toEqual(['Internet']);
  });
});

describe('RF link budgets', () => {
  it('NF-RADIO-PTP5 pairs at 10 km with a real rate and stops at its 15 km cut-off', () => {
    const r = radioOf(byType('radio.nfptp5'), 'Radio0');
    const at10k = assess('5', pathLossClassOf('ptp'), 20, 10_000, end(r), end(r));
    expect(at10k.canConnect).toBe(true);
    expect(at10k.rateBps).toBeGreaterThan(0);
    expect(at10k.rssiDbm).toBeGreaterThan(-60);
    expect(r.maxRangeM).toBe(15_000);
  });

  it('NF-RADIO-PTP60 pairs at 1 km and is out of range at 1.5 km', () => {
    const r = radioOf(byType('radio.nfptp60'), 'Radio0');
    const at1k = assess('60', 'ptp', 2160, 1_000, end(r), end(r));
    expect(at1k.canConnect).toBe(true);
    expect(at1k.rateBps).toBeGreaterThan(1_000_000_000);
    expect(1_500 > r.maxRangeM).toBe(true);
  });

  it('home router radios serve a laptop at 40 m and cover 120 m on 2.4 GHz', () => {
    const m = byType('wrouter.nfhome');
    const wl0 = radioOf(m, 'Wlan0');
    const wl1 = radioOf(m, 'Wlan1');
    const near24 = assess('2.4', pathLossClassOf('ap'), 20, 40, end(wl0), STATION);
    const near5 = assess('5', 'wifi', 20, 40, end(wl1), STATION);
    expect(near24.canConnect && near5.canConnect).toBe(true);
    const far24 = assess('2.4', 'wifi', 20, 120, end(wl0), STATION);
    expect(far24.belowDrop).toBe(false);
    expect(far24.bars).toBeLessThan(near24.bars);
    expect(far24.rateBps).toBeLessThan(near24.rateBps);
    for (const r of [wl0, wl1]) expect(r.maxRangeM).toBeGreaterThan(120);
  });

  it('every AP radio reaches a station at 30 m on its default band', () => {
    for (const m of ALL) {
      for (const p of m.ports) {
        if (p.kind !== 'wlan' || !p.radio) continue;
        const a = assess(p.radio.defaultBand, 'wifi', 20, 30, end(p.radio), STATION);
        expect(a.canConnect, `${m.type} ${p.name}`).toBe(true);
      }
    }
  });

  it('the tower attaches a phone at 500 m', () => {
    const r = radioOf(byType('cell.nftower'), 'Cellular0');
    const a = assess('cell', pathLossClassOf('tower'), 20, 500, end(r), UE);
    expect(a.canConnect).toBe(true);
    expect(a.rateBps).toBeGreaterThan(0);
  });
});
