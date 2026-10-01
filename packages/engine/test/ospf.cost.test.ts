// protocols/ospf/{cost,config} (ARCHITECTURE-P3 D7, §3.2, §4.5, §5.1; §7 W1 ospf): the routing bandwidth order and the
// integer cost — reference 100 Mb/s: GigE 1, FastE 1, serial 64; reference 1000: GigE 1, FastE 10, serial 647 — and
// the process configuration the cost and the daemon read: reference bandwidth, `ip ospf cost`, `bandwidth`,
// enablement by network and interface lines, passive interfaces, the router id order, areas as integers or dotted.
import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { ConfigNode } from '../src/contracts/config.js';
import {
  isOspfPassive,
  ospfEnabledInterfaces,
  parseOspfArea,
  readOspfConfig,
  selectOspfRouterId,
} from '../src/protocols/ospf/config.js';
import {
  OSPF_COST_MAX,
  OSPF_REFERENCE_MBPS_DEFAULT,
  ospfCostFor,
  ospfInterfaceCost,
  routingBandwidthKbps,
} from '../src/protocols/ospf/cost.js';

const n = (key: string, args: string[] = [], children: ConfigNode[] = []): ConfigNode => ({ key, args, children });
const GIGE = 1_000_000_000;
const FASTE = 100_000_000;
const cost = (ref: number, p: Parameters<typeof routingBandwidthKbps>[0]): number => ospfCostFor(ref, routingBandwidthKbps(p));

describe('ospf/cost: the reference bandwidth rule', () => {
  it('reference 100 Mb/s (the default): GigE 1, FastE 1, serial 64 (1544 kb/s), 10 Mb/s 10', () => {
    expect(OSPF_REFERENCE_MBPS_DEFAULT).toBe(100);
    expect(cost(100, { role: 'routed', speedBps: GIGE })).toBe(1);
    expect(cost(100, { role: 'routed', speedBps: FASTE })).toBe(1);
    expect(cost(100, { role: 'wan', speedBps: 128_000 })).toBe(64);
    expect(cost(100, { role: 'routed', speedBps: 10_000_000 })).toBe(10);
    expect(cost(100, { role: 'routed', speedBps: 10 * GIGE })).toBe(1);
  });

  it('reference 1000 Mb/s: GigE 1, FastE 10, serial 647', () => {
    expect(cost(1000, { role: 'routed', speedBps: GIGE })).toBe(1);
    expect(cost(1000, { role: 'routed', speedBps: FASTE })).toBe(10);
    expect(cost(1000, { role: 'subif', speedBps: FASTE })).toBe(10);
    expect(cost(1000, { role: 'wan', speedBps: 2_000_000 })).toBe(647);
    expect(cost(10_000, { role: 'routed', speedBps: GIGE })).toBe(10);
  });

  it('the routing bandwidth order: `bandwidth` line > serial 1544 / tunnel 100 / loopback > speed > SVI or fallback', () => {
    expect(routingBandwidthKbps({ role: 'wan', speedBps: 64_000 })).toBe(1544);
    expect(routingBandwidthKbps({ role: 'wan', speedBps: 64_000, configuredKbps: 128 })).toBe(128);
    expect(routingBandwidthKbps({ role: 'routed', speedBps: GIGE, configuredKbps: 10_000 })).toBe(10_000);
    expect(routingBandwidthKbps({ role: 'tunnel' })).toBe(100);
    expect(routingBandwidthKbps({ role: 'virtual' })).toBe(8_000_000);
    expect(routingBandwidthKbps({ role: 'svi' })).toBe(1_000_000);
    expect(routingBandwidthKbps({ role: 'svi', speedBps: FASTE })).toBe(100_000);
    expect(routingBandwidthKbps({ role: 'routed' })).toBe(100_000);
    expect(routingBandwidthKbps({ role: 'routed', configuredKbps: 0 })).toBe(100_000);
    // loopback 1, tunnel 1000 (D17), a `bandwidth 128` serial 781
    expect(cost(100, { role: 'virtual' })).toBe(1);
    expect(cost(100, { role: 'tunnel' })).toBe(1000);
    expect(cost(100, { role: 'wan', configuredKbps: 128 })).toBe(781);
  });

  it('never below 1, never above 65 535', () => {
    expect(ospfCostFor(1, 10_000_000)).toBe(1);
    expect(ospfCostFor(4_294_967, 64)).toBe(OSPF_COST_MAX);
    expect(ospfCostFor(100, 0)).toBe(OSPF_COST_MAX);
  });

  it('`ip ospf cost` wins over the bandwidth', () => {
    expect(ospfInterfaceCost({ configuredCost: 10, referenceMbps: 100, bandwidthKbps: 1_000_000 })).toEqual({ cost: 10, costSource: 'configured' });
    expect(ospfInterfaceCost({ referenceMbps: 100, bandwidthKbps: 1544 })).toEqual({ cost: 64, costSource: 'bandwidth' });
    expect(ospfInterfaceCost({ configuredCost: 0, referenceMbps: 100, bandwidthKbps: 1544 })).toEqual({ cost: 64, costSource: 'bandwidth' });
  });
});

describe('ospf/config: the process configuration', () => {
  const root = n('', [], [
    n('hostname', ['R1']),
    n('interface', ['GigabitEthernet0/0'], [n('ip', ['address', '10.0.12.1', '255.255.255.252']), n('ip', ['ospf', 'cost', '10']), n('bandwidth', ['100000'])]),
    n('interface', ['GigabitEthernet0/1'], [n('ip', [], [n('address', ['10.1.0.1', '255.255.255.0']), n('ospf', ['1', 'area', '51'])])]),
    n('interface', ['GigabitEthernet0/2'], [n('ip', ['ospf', '2', 'area', '0'])]),
    n('router', ['ospf', '1'], [
      n('router-id', ['1.1.1.1']),
      n('auto-cost', ['reference-bandwidth', '1000']),
      n('passive-interface', ['default']),
      n('no', ['passive-interface', 'GigabitEthernet0/0']),
      n('network', ['10.0.0.0', '0.255.255.255', 'area', '0']),
      n('network', ['10.0.12.2', '0.0.0.3', 'area', '0.0.0.12']),
      n('network', ['10.0.12.0', '0.0.0.3', 'area', '13']),
      n('network', ['10.9.0.0', '0.0.255.255', 'area', 'x']),
      n('default-information', ['originate', 'always']),
      n('maximum-paths', ['2']),
    ]),
    n('router', ['ospf', '7'], [n('router-id', ['7.7.7.7'])]),
  ]);
  const cfg = readOspfConfig({ root });

  it('reads the router ospf section (the first one) with its defaults', () => {
    expect(cfg.process).toEqual({
      pid: 1,
      routerId: '1.1.1.1',
      networks: [
        { address: '10.0.0.0', wildcard: '0.255.255.255', area: '0.0.0.0' },
        { address: '10.0.12.0', wildcard: '0.0.0.3', area: '0.0.0.12' },
        { address: '10.0.12.0', wildcard: '0.0.0.3', area: '0.0.0.13' },
      ],
      passiveDefault: true,
      passive: [],
      notPassive: ['GigabitEthernet0/0'],
      referenceBandwidthMbps: 1000,
      defaultOriginate: 'always',
      maximumPaths: 2,
    });
    const bare = readOspfConfig({ root: n('', [], [n('router', ['ospf', '5'])]) }).process;
    expect(bare).toEqual({ pid: 5, networks: [], passiveDefault: false, passive: [], notPassive: [], referenceBandwidthMbps: 100, maximumPaths: 4 });
    expect(readOspfConfig({ root: n('', [], [n('router', ['ospf', '5'], [n('default-information', ['originate'])])]) }).process!.defaultOriginate).toBe('on');
    expect(readOspfConfig({ root: n('', [], [n('router', ['eigrp', '100'])]) }).process).toBeUndefined();
  });

  it('reads the interface lines: cost, bandwidth and the interface area line', () => {
    expect(cfg.interfaces.get('GigabitEthernet0/0')).toEqual({ port: 'GigabitEthernet0/0', cost: 10, bandwidthKbps: 100_000 });
    expect(cfg.interfaces.get('GigabitEthernet0/1')).toEqual({ port: 'GigabitEthernet0/1', area: { pid: 1, area: '0.0.0.51' } });
    expect(cfg.interfaces.get('GigabitEthernet0/2')).toEqual({ port: 'GigabitEthernet0/2', area: { pid: 2, area: '0.0.0.0' } });
    // the cost the daemon derives for Gi0/0: configured; with the line gone, the bandwidth line at reference 1000
    const g0 = cfg.interfaces.get('GigabitEthernet0/0')!;
    expect(ospfInterfaceCost({ configuredCost: g0.cost, referenceMbps: 1000, bandwidthKbps: routingBandwidthKbps({ role: 'routed', speedBps: GIGE, configuredKbps: g0.bandwidthKbps }) })).toEqual({ cost: 10, costSource: 'configured' });
    expect(ospfInterfaceCost({ referenceMbps: 1000, bandwidthKbps: routingBandwidthKbps({ role: 'routed', speedBps: GIGE, configuredKbps: g0.bandwidthKbps }) })).toEqual({ cost: 10, costSource: 'bandwidth' });
  });

  it('areas typed as integers or dotted are dotted', () => {
    expect(['0', '1', '51', '256', '4294967295', '0.0.0.0', '10.0.0.1', '4294967296', '-1', 'x', undefined].map(parseOspfArea)).toEqual(
      ['0.0.0.0', '0.0.0.1', '0.0.0.51', '0.0.1.0', '255.255.255.255', '0.0.0.0', '10.0.0.1', undefined, undefined, undefined, undefined],
    );
  });

  it('enablement: the interface line wins, else the most specific network line, then configuration order', () => {
    const on = ospfEnabledInterfaces(cfg, [
      { port: 'GigabitEthernet0/0', address: '10.0.12.1' },
      { port: 'GigabitEthernet0/1', address: '10.1.0.1' },
      { port: 'GigabitEthernet0/2', address: '10.2.0.1' },
      { port: 'GigabitEthernet0/3', address: '192.168.1.1' },
      { port: 'GigabitEthernet0/4' },
      { port: 'Serial0/0/0', address: '10.0.13.1' },
    ]);
    expect(on).toEqual([
      // /30 lines are more specific than 10.0.0.0/8; of the two /30 lines, the first
      { port: 'GigabitEthernet0/0', area: '0.0.0.12', via: 'network', network: { address: '10.0.12.0', wildcard: '0.0.0.3', area: '0.0.0.12' } },
      { port: 'GigabitEthernet0/1', area: '0.0.0.51', via: 'interface' },
      // Gi0/2 names another process: no network line applies to it; Gi0/3 matches none; Gi0/4 has no address
      { port: 'Serial0/0/0', area: '0.0.0.0', via: 'network', network: { address: '10.0.0.0', wildcard: '0.255.255.255', area: '0.0.0.0' } },
    ]);
    expect(ospfEnabledInterfaces({ interfaces: new Map() }, [{ port: 'Gi0/0', address: '10.0.0.1' }])).toEqual([]);
  });

  it('passive interfaces, with and without passive-interface default', () => {
    expect(isOspfPassive(cfg.process!, 'GigabitEthernet0/0')).toBe(false);
    expect(isOspfPassive(cfg.process!, 'GigabitEthernet0/1')).toBe(true);
    const plain = readOspfConfig({ root: n('', [], [n('router', ['ospf', '1'], [n('passive-interface', ['GigabitEthernet0/1'])])]) }).process!;
    expect(isOspfPassive(plain, 'GigabitEthernet0/1')).toBe(true);
    expect(isOspfPassive(plain, 'GigabitEthernet0/0')).toBe(false);
  });

  it('router id: router-id > highest up loopback > highest up interface address', () => {
    const ports = [
      { role: 'routed' as const, operUp: true, address: '10.0.12.1' },
      { role: 'routed' as const, operUp: true, address: '192.168.1.1' },
      { role: 'virtual' as const, operUp: true, address: '1.1.1.1' },
      { role: 'virtual' as const, operUp: true, address: '9.0.0.1' },
      { role: 'virtual' as const, operUp: false, address: '99.99.99.99' },
      { role: 'routed' as const, operUp: false, address: '200.0.0.1' },
    ];
    expect(selectOspfRouterId('3.3.3.3', ports)).toEqual({ routerId: '3.3.3.3', source: 'configured' });
    expect(selectOspfRouterId(undefined, ports)).toEqual({ routerId: '9.0.0.1', source: 'loopback' });
    expect(selectOspfRouterId(undefined, ports.filter((p) => p.role === 'routed'))).toEqual({ routerId: '192.168.1.1', source: 'interface' });
    expect(selectOspfRouterId('0.0.0.0', ports.slice(0, 1))).toEqual({ routerId: '10.0.12.1', source: 'interface' });
    expect(selectOspfRouterId(undefined, [{ role: 'routed', operUp: false, address: '10.0.0.1' }, { role: 'routed', operUp: true }])).toBeUndefined();
    // highest as a number: 10.0.0.1 over 9.255.255.255
    expect(selectOspfRouterId(undefined, [{ role: 'routed', operUp: true, address: '9.255.255.255' }, { role: 'routed', operUp: true, address: '10.0.0.1' }])!.routerId).toBe('10.0.0.1');
  });
});

describe('ospf: integer discipline (§4.5)', () => {
  it('protocols/ospf uses no floating-point maths, exponentiation, randomness or clocks', () => {
    const BANNED = /Math\.(log10|log2|log|pow|exp|random)\s*\(|Date\.now|performance\.now|new Date\(|setTimeout|[\w)\]]\s*\*\*\s*[\w(]/;
    const dir = new URL('../src/protocols/ospf/', import.meta.url);
    const files = readdirSync(dir).filter((f) => f.endsWith('.ts')).sort();
    expect(files).toEqual(expect.arrayContaining(['config.ts', 'cost.ts', 'dr.ts', 'hello-check.ts', 'ism.ts']));
    for (const f of files) expect(readFileSync(new URL(f, dir), 'utf8'), f).not.toMatch(BANNED);
  });
});
