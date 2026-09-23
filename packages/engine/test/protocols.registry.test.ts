/**
 * Process registry (protocols/index.ts, ARCHITECTURE-P1 §8.1 W4 l2l3, §8.2 W5 l2l3; ARCHITECTURE-P2 §7 W4 catalog,
 * §9.2 W4 item 14): every daemon of PROCESS_ORDER — the P0 five, the four P0.5 ones, the twelve P1 ones and the
 * eight P2 ones the W4 flip registered — is registered in canonical daemon order, each factory builds a fresh process whose name matches its key, and every daemon a catalog model lists
 * at CATALOG_STAGE resolves to a factory.
 */
import { describe, expect, it } from 'vitest';
import {
  PROCESS_FACTORIES,
  REGISTERED_PROCESSES,
  createArp,
  createCellClient,
  createDhcpClient,
  createDhcpServer,
  createDhcpv6Client,
  createDhcpv6Server,
  createDnsClient,
  createDnsServer,
  createDtp,
  createEthSwitch,
  createEtherchannel,
  createHdlc,
  createHost,
  createHsrp,
  createHttpClient,
  createHttpServer,
  createIcmpv4,
  createIcmpv6,
  createIpv4,
  createIpv6,
  createNat,
  createNd,
  createStp,
  createTcp,
  createTraceroute,
  createUdp,
  createVlan,
  createWlanAp,
  createWlanClient,
  processFactory,
} from '../src/protocols/index.js';
import { ALL_MODELS, ALL_MODULES, CATALOG_STAGE, createCatalog } from '../src/device/catalog/index.js';
import { validateCatalog } from '../src/device/catalog/validate.js';
import { PROCESS_ORDER } from '../src/contracts/catalog.js';
import { HDLC_PROCESS } from '../src/protocols/hdlc.js';
import { WLAN_AP_PROCESS } from '../src/protocols/wlan-ap.js';
import { WLAN_CLIENT_PROCESS } from '../src/protocols/wlan-client.js';
import { CELL_CLIENT } from '../src/protocols/cell-client.js';

/** P1 W5: the registry holds every daemon PROCESS_ORDER names, in that order. */
const EXPECTED = [...PROCESS_ORDER];

describe('protocols registry', () => {
  it('registers every daemon of PROCESS_ORDER, in canonical daemon order', () => {
    expect(REGISTERED_PROCESSES).toEqual(EXPECTED);
    expect(Object.keys(PROCESS_FACTORIES)).toEqual(EXPECTED);
    expect(PROCESS_ORDER.filter((name) => REGISTERED_PROCESSES.includes(name))).toEqual(EXPECTED);
    expect(Object.isFrozen(PROCESS_FACTORIES)).toBe(true);
    expect(Object.isFrozen(REGISTERED_PROCESSES)).toBe(true);
  });

  it('maps each name to the daemon module factory', () => {
    expect(PROCESS_FACTORIES).toEqual({
      'wlan-ap': createWlanAp,
      'wlan-client': createWlanClient,
      'cell-client': createCellClient,
      hdlc: createHdlc,
      'eth-switch': createEthSwitch,
      // ARCHITECTURE-P2 §9.2 W4 item 14: the eight P2 daemons at their §2.1 positions
      vlan: createVlan,
      dtp: createDtp,
      etherchannel: createEtherchannel,
      stp: createStp,
      arp: createArp,
      ipv4: createIpv4,
      nat: createNat,
      icmpv4: createIcmpv4,
      host: createHost,
      ipv6: createIpv6,
      nd: createNd,
      icmpv6: createIcmpv6,
      udp: createUdp,
      tcp: createTcp,
      hsrp: createHsrp,
      'dhcp-client': createDhcpClient,
      'dhcp-server': createDhcpServer,
      'dhcpv6-client': createDhcpv6Client,
      'dhcpv6-server': createDhcpv6Server,
      'dns-client': createDnsClient,
      'dns-server': createDnsServer,
      'http-client': createHttpClient,
      'http-server': createHttpServer,
      traceroute: createTraceroute,
    });
    expect([HDLC_PROCESS, WLAN_AP_PROCESS, WLAN_CLIENT_PROCESS, CELL_CLIENT].every((n) => REGISTERED_PROCESSES.includes(n))).toBe(true);
  });

  it('each factory builds a fresh process named after its key', () => {
    for (const name of REGISTERED_PROCESSES) {
      const factory = processFactory(name);
      expect(factory, name).toBeDefined();
      const a = factory!();
      const b = factory!();
      expect(a.name, name).toBe(name);
      expect(a).not.toBe(b);
      expect(typeof a.onPdu, name).toBe('function');
      expect(typeof a.onTimer, name).toBe('function');
      expect(typeof a.onConfig, name).toBe('function');
      expect(typeof a.stateSnapshot, name).toBe('function');
    }
  });

  it('processFactory returns undefined for unknown and inherited names', () => {
    expect(processFactory('ppp')).toBeUndefined();
    expect(processFactory('ospf')).toBeUndefined();
    expect(processFactory('toString')).toBeUndefined();
    expect(processFactory('__proto__')).toBeUndefined();
  });

  it('every daemon of every catalog model resolves through the registry', () => {
    const issues = validateCatalog(ALL_MODELS, ALL_MODULES, { stage: CATALOG_STAGE, processNames: REGISTERED_PROCESSES });
    expect(issues.filter((i) => i.code === 'bad-processes')).toEqual([]);
    const catalog = createCatalog(PROCESS_FACTORIES);
    const missing: string[] = [];
    for (const model of catalog.list()) {
      for (const name of model.processes) if (catalog.process(name) === undefined) missing.push(`${model.type}:${name}`);
    }
    expect(missing).toEqual([]);
    expect(catalog.process('hdlc')).toBe(createHdlc);
    expect(catalog.process('wlan-ap')).toBe(createWlanAp);
    expect(catalog.process('wlan-client')).toBe(createWlanClient);
    expect(catalog.process('cell-client')).toBe(createCellClient);
    expect(catalog.process('http-server')).toBe(createHttpServer);
    expect(catalog.process('tcp')).toBe(createTcp);
  });

  it('the router, access point, wireless client and cellular client models reach the new daemons', () => {
    const using = (name: string): number => ALL_MODELS.filter((m) => m.processes.includes(name)).length;
    expect(using('hdlc')).toBeGreaterThan(0);
    expect(using('wlan-ap')).toBeGreaterThan(0);
    expect(using('wlan-client')).toBeGreaterThan(0);
    expect(using('cell-client')).toBeGreaterThan(0);
    for (const name of ['ipv6', 'nd', 'icmpv6', 'udp', 'tcp', 'dhcp-client', 'dhcp-server', 'dns-client', 'dns-server', 'http-client', 'http-server', 'traceroute']) {
      expect(using(name), name).toBeGreaterThan(0);
    }
  });
});
