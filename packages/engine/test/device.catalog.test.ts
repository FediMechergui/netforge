import { describe, expect, it } from 'vitest';
import { NF_2911, NF_C2960, NF_PC, P0_MODELS, canonicalPort, createCatalog } from '../src/device/catalog.js';
import { DEVICE_CATEGORIES } from '../src/contracts/catalog.js';
import { SPEED_100M, SPEED_1G } from '../src/contracts/port.js';
import { SEC } from '../src/contracts/time.js';

describe('device/catalog models', () => {
  it('lists the three P0 models with original names, in DEVICE_CATEGORIES order', () => {
    const cat = createCatalog({});
    const types = cat.list().map((m) => m.type);
    for (const t of ['pc.nfpc', 'switch.nfc2960', 'router.nf2911']) expect(types).toContain(t);
    expect(P0_MODELS.map((m) => m.model)).toEqual(['NF-PC', 'NF-C2960', 'NF-2911']);
    for (const m of P0_MODELS) expect(cat.get(m.type)).toBe(m);
    const order = cat.list().map((m) => DEVICE_CATEGORIES.findIndex((c) => c.id === m.category));
    expect(order.every((c) => c >= 0)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(cat.get('router.nf2911')).toBe(NF_2911);
    expect(cat.get('nope')).toBeUndefined();
    for (const m of P0_MODELS) {
      const text = JSON.stringify(m);
      expect(text).not.toMatch(/cisco/i);
      expect(text).not.toMatch(/\bIOS\b/);
    }
  });

  it('NF-PC: one gigabit port, host processes, boots in 2 s', () => {
    expect(NF_PC.kind).toBe('pc');
    expect(NF_PC.ports.map((p) => [p.name, p.short, p.speedBps, p.autoMdix])).toEqual([['GigabitEthernet0', 'Gi0', SPEED_1G, false]]);
    // §9.2 'NF-2911 processes gain hdlc (P0.5); P1 adds the stack': the shim entries are derived at CATALOG_STAGE.
    // ARCHITECTURE-P2 §9.2 W4 item 13: a host gains dhcpv6-client at its final PROCESS_ORDER position.
    expect(NF_PC.processes).toEqual(['arp', 'ipv4', 'icmpv4', 'host', 'ipv6', 'nd', 'icmpv6', 'udp', 'tcp', 'dhcp-client', 'dhcpv6-client', 'dns-client', 'http-client', 'traceroute']);
    expect(NF_PC.hostnamePrefix).toBe('PC');
    expect(NF_PC.portsDefaultUp).toBe(true);
    expect(NF_PC.bootNs).toBe(2 * SEC);
    expect(NF_PC.ipForwarding).toBe(false);
    expect(NF_PC.processingNs).toBe(0);
  });

  it('NF-C2960: 24 fast-ethernet + 2 gigabit MDI-X ports, eth-switch, boots in 30 s', () => {
    expect(NF_C2960.kind).toBe('switch');
    expect(NF_C2960.ports).toHaveLength(26);
    expect(NF_C2960.ports[0]).toMatchObject({ name: 'FastEthernet0/1', short: 'Fa0/1', speedBps: SPEED_100M, autoMdix: true, kind: 'ethernet' });
    expect(NF_C2960.ports[23]).toMatchObject({ name: 'FastEthernet0/24', short: 'Fa0/24' });
    expect(NF_C2960.ports[24]).toMatchObject({ name: 'GigabitEthernet0/1', short: 'Gi0/1', speedBps: SPEED_1G, autoMdix: true });
    expect(NF_C2960.ports[25]).toMatchObject({ name: 'GigabitEthernet0/2', short: 'Gi0/2' });
    // ARCHITECTURE-P2 §9.2 W4 item 13: a managed switch gains vlan, dtp, etherchannel, stp right after eth-switch.
    expect(NF_C2960.processes).toEqual(['eth-switch', 'vlan', 'dtp', 'etherchannel', 'stp', 'arp', 'ipv4', 'icmpv4', 'host']);
    expect(NF_C2960.hostnamePrefix).toBe('Switch');
    expect(NF_C2960.portsDefaultUp).toBe(true);
    expect(NF_C2960.bootNs).toBe(30 * SEC);
    expect(NF_C2960.ipForwarding).toBe(false);
  });

  it('NF-2911: 2 gigabit + 2 serial + console, router processes, ports default down, forwards IPv4', () => {
    expect(NF_2911.kind).toBe('router');
    expect(NF_2911.ports.map((p) => [p.name, p.kind])).toEqual([
      ['GigabitEthernet0/0', 'ethernet'],
      ['GigabitEthernet0/1', 'ethernet'],
      ['Serial0/0/0', 'serial'],
      ['Serial0/0/1', 'serial'],
      ['Console', 'console'],
    ]);
    expect(NF_2911.ports[0]?.autoMdix).toBe(false);
    expect(NF_2911.ports[2]?.speedBps).toBe(2_000_000);
    // §9.2: NF-2911 gains the hdlc daemon at P0.5 and the P1 stack at P1. ARCHITECTURE-P2 §9.2 W4 item 13: nat after
    // ipv4, hsrp [S2] after tcp, dhcpv6-client and dhcpv6-server after dhcp-server.
    expect(NF_2911.processes).toEqual(['hdlc', 'arp', 'ipv4', 'nat', 'icmpv4', 'ipv6', 'nd', 'icmpv6', 'udp', 'tcp', 'hsrp', 'dhcp-client', 'dhcp-server', 'dhcpv6-client', 'dhcpv6-server', 'dns-client', 'dns-server', 'http-server', 'traceroute']);
    expect(NF_2911.hostnamePrefix).toBe('Router');
    expect(NF_2911.portsDefaultUp).toBe(false);
    expect(NF_2911.bootNs).toBe(45 * SEC);
    expect(NF_2911.ipForwarding).toBe(true);
  });

  it('process() resolves factories from the registry', () => {
    const factory = () => ({ name: 'arp', onPdu: () => [], onTimer: () => [], onConfig: () => [], stateSnapshot: () => ({ process: 'arp', state: {} }), debugEvents: () => [] });
    const cat = createCatalog({ arp: factory });
    expect(cat.process('arp')).toBe(factory);
    expect(cat.process('ipv4')).toBeUndefined();
  });
});

describe('device/catalog canonicalPort', () => {
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
    expect(canonicalPort(model, input)).toBe(expected);
  });

  it('the catalog object resolves the same names against a live port set (resolvePort)', () => {
    const cat = createCatalog({});
    const ports = new Map(NF_2911.ports.map((spec) => [spec.name, { spec }] as const));
    expect(cat.resolvePort({ model: NF_2911, ports }, ' gi0/0 ')).toEqual({ kind: 'existing', port: 'GigabitEthernet0/0' });
  });
});
