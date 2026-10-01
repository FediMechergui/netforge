// protocols/eigrp/{metric,config}.ts [C1] (ARCHITECTURE-P3 D26, §3.12, §4.5, §5.1; §7 W1 eigrp): the integer composite
// metric with every §3.12 number, K5 ≠ 0, the interface defaults (the tunnel's 100 kb/s and 50 000 µs included), and
// the configuration reader the metric and DUAL are fed from (classful networks, K values, interface delay and
// bandwidth, hello and hold per AS). Also the §4.5 grep ban over protocols/eigrp/.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { EIGRP_HELLO_S, EIGRP_HOLD_S, EIGRP_INFINITY } from '../src/contracts/pdu.js';
import { parseConfigText } from '../src/cli/config-ast.js';
import {
  EIGRP_DEFAULT_MAXIMUM_PATHS,
  eigrpClassfulWildcard,
  eigrpInterfaceEnabled,
  eigrpInterfacePassive,
  eigrpNetworkMatches,
  eigrpNetworkOf,
  eigrpRouterIdOf,
  readEigrpInterface,
  readEigrpInterfaces,
  readEigrpProcess,
} from '../src/protocols/eigrp/config.js';
import {
  EIGRP_DEFAULT_K_VALUES,
  EIGRP_DELAY_UNREACHABLE,
  eigrpBandwidthKbps,
  eigrpConnectedVector,
  eigrpDefaultDelayUs,
  eigrpDelayUs,
  eigrpKValuesMatch,
  eigrpMetric,
  eigrpUnreachable,
  eigrpUnreachableVector,
  eigrpVectorThrough,
  type EigrpKValues,
  type EigrpLink,
  type EigrpPortInfo,
} from '../src/protocols/eigrp/metric.js';

const GIG: EigrpPortInfo = { kind: 'ethernet', role: 'routed', speedBps: 1_000_000_000 };
const FAST: EigrpPortInfo = { kind: 'ethernet', role: 'routed', speedBps: 100_000_000 };
const TEN_M: EigrpPortInfo = { kind: 'ethernet', role: 'routed', speedBps: 10_000_000 };
const SERIAL: EigrpPortInfo = { kind: 'serial', role: 'wan', speedBps: 64_000 };
const LOOPBACK: EigrpPortInfo = { kind: 'virtual', role: 'virtual', speedBps: 1_000_000_000 };
const SVI: EigrpPortInfo = { kind: 'virtual', role: 'svi', speedBps: 1_000_000_000 };
const TUNNEL: EigrpPortInfo = { kind: 'virtual', role: 'tunnel', speedBps: 1_000_000_000 };

/** An interface as the daemon will build it: routing bandwidth and delay from the port and its lines. */
const link = (port: EigrpPortInfo, lines: { bandwidthKbps?: number; delayTens?: number } = {}): EigrpLink => ({
  bwKbps: eigrpBandwidthKbps(port, lines.bandwidthKbps),
  delayUs: eigrpDelayUs(port, lines.delayTens),
});

describe('eigrp metric: the §3.12 numbers', () => {
  // R4's LAN (GigE), R2–R4 and R3–R4 (GigE); R1–R2 GigE; R1–R3 `bandwidth 100000` / `delay 10` on both ends.
  const gige = link(GIG);
  const r1r3 = link(GIG, { bandwidthKbps: 100_000, delayTens: 10 });

  it('the interface values: GigE 1 000 000 kb/s and 10 µs; the R1–R3 lines give 100 000 kb/s and 100 µs', () => {
    expect(gige).toEqual({ bwKbps: 1_000_000, delayUs: 10 });
    expect(r1r3).toEqual({ bwKbps: 100_000, delayUs: 100 });
  });

  it('R4 advertises its LAN; R2 reports 3072; R1 computes 3328 via R2 and 28672 via R3 (RD 3072)', () => {
    const lan = eigrpConnectedVector(gige);
    expect(eigrpMetric(lan)).toBe(256 * (10 + 1));
    const atR2 = eigrpVectorThrough(lan, gige);
    const atR3 = eigrpVectorThrough(lan, gige);
    expect(eigrpMetric(atR2)).toBe(3072);
    expect(eigrpMetric(atR3)).toBe(3072);
    const viaR2 = eigrpVectorThrough(atR2, gige);
    const viaR3 = eigrpVectorThrough(atR3, r1r3);
    expect(viaR2).toMatchObject({ delayUs: 30, bwKbps: 1_000_000, hops: 2 });
    expect(eigrpMetric(viaR2)).toBe(3328);
    expect(viaR3).toMatchObject({ delayUs: 120, bwKbps: 100_000, hops: 2 });
    expect(eigrpMetric(viaR3)).toBe(28672);
    // R3 is a feasible successor: its reported distance is below the feasible distance.
    expect(eigrpMetric(atR3) < eigrpMetric(viaR2)).toBe(true);
  });

  it('the variant without a feasible successor: R3 reports 28416 and R1 computes 30976 (not 31616)', () => {
    const lan = eigrpConnectedVector(gige);
    const atR3 = eigrpVectorThrough(lan, link(GIG, { bandwidthKbps: 100_000, delayTens: 10 }));
    expect(eigrpMetric(atR3)).toBe(28416);
    const viaR3 = eigrpVectorThrough(atR3, r1r3);
    expect(eigrpMetric(viaR3)).toBe(30976);
    expect(eigrpMetric(atR3) >= 3328).toBe(true);
  });

  it('is 256 · (floor(10^7 / min bw) + floor(Σ delay / 10)) with the default K values', () => {
    expect(EIGRP_DEFAULT_K_VALUES).toEqual([1, 0, 1, 0, 0]);
    expect(eigrpMetric({ delayUs: 20_000, bwKbps: 1544 })).toBe(256 * (6476 + 2000));
    expect(eigrpMetric({ delayUs: 25, bwKbps: 3 })).toBe(256 * (3_333_333 + 2));
    expect(eigrpMetric({ delayUs: 10, bwKbps: 40_000_000 })).toBe(256 * (0 + 1));
  });
});

describe('eigrp metric: K values', () => {
  const v = { delayUs: 30, bwKbps: 1_000_000 };

  it('K2 adds floor(K2 · BW / (256 − load)) with load 1; K1 and K3 weigh bandwidth and delay', () => {
    expect(eigrpMetric(v, [1, 1, 1, 0, 0])).toBe(256 * (10 + Math.floor(10 / 255) + 3));
    expect(eigrpMetric({ delayUs: 30, bwKbps: 1000 }, [1, 1, 1, 0, 0])).toBe(256 * (10_000 + Math.floor(10_000 / 255) + 3));
    expect(eigrpMetric(v, [0, 0, 1, 0, 0])).toBe(256 * 3);
    expect(eigrpMetric(v, [1, 0, 0, 0, 0])).toBe(256 * 10);
    expect(eigrpMetric(v, [2, 0, 3, 0, 0])).toBe(256 * (20 + 9));
  });

  it('K5 ≠ 0 scales by K5 / (reliability + K4) with reliability 255, floored, after the sum', () => {
    expect(eigrpMetric(v, [1, 0, 1, 0, 1])).toBe(Math.floor((3328 * 1) / 255));
    expect(eigrpMetric(v, [1, 0, 1, 0, 1])).toBe(13);
    expect(eigrpMetric(v, [1, 0, 1, 1, 2])).toBe(Math.floor((3328 * 2) / 256));
    expect(eigrpMetric(v, [1, 0, 1, 1, 2])).toBe(26);
    expect(eigrpMetric({ delayUs: 120, bwKbps: 100_000 }, [1, 0, 1, 5, 255])).toBe(Math.floor((28672 * 255) / 260));
    // K5 = 0 ignores K4.
    expect(eigrpMetric(v, [1, 0, 1, 9, 0])).toBe(3328);
  });

  it('neighbours match only on equal K values', () => {
    expect(eigrpKValuesMatch([1, 0, 1, 0, 0], EIGRP_DEFAULT_K_VALUES)).toBe(true);
    expect(eigrpKValuesMatch([1, 1, 1, 0, 0], EIGRP_DEFAULT_K_VALUES)).toBe(false);
    expect(eigrpKValuesMatch([1, 0, 1, 0, 1], EIGRP_DEFAULT_K_VALUES)).toBe(false);
  });
});

describe('eigrp metric: unreachable and bounds', () => {
  it('an unreachable vector has the infinite metric 2^32 − 1, and stays unreachable through any link', () => {
    const inf = eigrpUnreachableVector();
    expect(eigrpUnreachable(inf)).toBe(true);
    expect(eigrpMetric(inf)).toBe(EIGRP_INFINITY);
    expect(EIGRP_INFINITY).toBe(4_294_967_295);
    const through = eigrpVectorThrough(inf, link(GIG));
    expect(through.delayUs).toBe(EIGRP_DELAY_UNREACHABLE);
    expect(eigrpMetric(through)).toBe(EIGRP_INFINITY);
  });

  it('a finite metric that would reach 2^32 − 1 is capped there; every value is a safe integer', () => {
    const huge = { delayUs: 167_772_150 * 20, bwKbps: 1 };
    expect(eigrpMetric(huge)).toBe(EIGRP_INFINITY);
    const k: EigrpKValues = [255, 255, 255, 255, 255];
    const m = eigrpMetric({ delayUs: 1_000_000, bwKbps: 9 }, k);
    expect(Number.isSafeInteger(m)).toBe(true);
    expect(m).toBeLessThanOrEqual(EIGRP_INFINITY);
  });

  it('a vector through a link takes the minimum bandwidth and MTU and counts a hop', () => {
    const adv = { delayUs: 110, bwKbps: 100_000, mtu: 1500, hops: 1, reliability: 255, load: 1 };
    expect(eigrpVectorThrough(adv, { delayUs: 20_000, bwKbps: 1544, mtu: 1400 })).toEqual({
      delayUs: 20_110, bwKbps: 1544, mtu: 1400, hops: 2, reliability: 255, load: 1,
    });
  });
});

describe('eigrp metric: interface defaults (D26, D17)', () => {
  it('bandwidth: the line, else serial 1544, tunnel 100, else the port speed', () => {
    expect(eigrpBandwidthKbps(GIG)).toBe(1_000_000);
    expect(eigrpBandwidthKbps(FAST)).toBe(100_000);
    expect(eigrpBandwidthKbps(SERIAL)).toBe(1544);
    expect(eigrpBandwidthKbps(TUNNEL)).toBe(100);
    expect(eigrpBandwidthKbps(LOOPBACK)).toBe(1_000_000);
    expect(eigrpBandwidthKbps(SERIAL, 64)).toBe(64);
    expect(eigrpBandwidthKbps(TUNNEL, 2000)).toBe(2000);
    expect(eigrpBandwidthKbps(GIG, 100_000)).toBe(100_000);
  });

  it('delay: the line in tens of µs, else GigE 10, FastE 100, 10 Mb/s 1000, serial 20 000, loopback 5 000, SVI 10, tunnel 50 000 µs', () => {
    expect([GIG, FAST, TEN_M, SERIAL, LOOPBACK, SVI, TUNNEL].map((p) => eigrpDefaultDelayUs(p))).toEqual([10, 100, 1000, 20_000, 5000, 10, 50_000]);
    expect(eigrpDelayUs(GIG, 10)).toBe(100);
    expect(eigrpDelayUs(TUNNEL, 1)).toBe(10);
    expect(eigrpDelayUs(SERIAL)).toBe(20_000);
    expect(eigrpDelayUs({ kind: 'ethernet', role: 'routed', speedBps: 10_000_000_000 })).toBe(10);
  });

  it('a route over a tunnel adds the tunnel defaults: 100 kb/s and 50 000 µs', () => {
    const lan = eigrpConnectedVector(link(GIG));
    const viaTunnel = eigrpVectorThrough(lan, link(TUNNEL));
    expect(viaTunnel).toMatchObject({ delayUs: 50_010, bwKbps: 100 });
    expect(eigrpMetric(viaTunnel)).toBe(256 * (100_000 + 5001));
    expect(eigrpMetric(viaTunnel)).toBe(26_880_256);
    // `bandwidth` and `delay` on the tunnel override both defaults.
    const tuned = eigrpVectorThrough(lan, link(TUNNEL, { bandwidthKbps: 1_000_000, delayTens: 1 }));
    expect(eigrpMetric(tuned)).toBe(256 * (10 + 2));
  });

  it('a serial link at its default routing bandwidth', () => {
    const lan = eigrpConnectedVector(link(GIG));
    expect(eigrpMetric(eigrpVectorThrough(lan, link(SERIAL)))).toBe(256 * (6476 + 2001));
    expect(eigrpMetric(eigrpVectorThrough(lan, link(SERIAL)))).toBe(2_170_112);
  });
});

describe('eigrp config reader (§5.1)', () => {
  const R1 = [
    'hostname R1',
    'interface GigabitEthernet0/0',
    ' ip address 10.0.12.1 255.255.255.0',
    '!',
    'interface GigabitEthernet0/1',
    ' bandwidth 100000',
    ' delay 10',
    ' ip address 10.0.13.1 255.255.255.0',
    ' ip hello-interval eigrp 100 2',
    ' ip hold-time eigrp 100 6',
    ' ip hello-interval eigrp 200 1',
    '!',
    'interface GigabitEthernet0/2',
    ' ip address 192.168.1.1 255.255.255.0',
    '!',
    'router eigrp 100',
    ' network 10.0.0.0',
    ' network 192.168.1.0 0.0.0.255',
    ' eigrp router-id 1.1.1.1',
    ' metric weights 0 1 0 1 0 0',
    ' passive-interface GigabitEthernet0/2',
    ' maximum-paths 2',
    ' no auto-summary',
    '!',
  ].join('\n');

  it('reads the process: AS, classful and wildcard networks, router id, K values, passive, maximum-paths', () => {
    const cfg = readEigrpProcess(parseConfigText(R1).root);
    expect(cfg).toEqual({
      as: 100,
      routerId: '1.1.1.1',
      networks: [
        { address: '10.0.0.0', wildcard: '0.255.255.255', classful: true },
        { address: '192.168.1.0', wildcard: '0.0.0.255', classful: false },
      ],
      passiveDefault: false,
      passiveInterfaces: ['GigabitEthernet0/2'],
      activeInterfaces: [],
      kValues: [1, 0, 1, 0, 0],
      maximumPaths: 2,
    });
    expect(eigrpInterfacePassive(cfg!, 'GigabitEthernet0/2')).toBe(true);
    expect(eigrpInterfacePassive(cfg!, 'GigabitEthernet0/0')).toBe(false);
    expect(eigrpInterfaceEnabled(cfg!, '10.0.12.1')).toBe(true);
    expect(eigrpInterfaceEnabled(cfg!, '10.200.0.1')).toBe(true);
    expect(eigrpInterfaceEnabled(cfg!, '192.168.1.1')).toBe(true);
    expect(eigrpInterfaceEnabled(cfg!, '192.168.2.1')).toBe(false);
    expect(eigrpInterfaceEnabled(cfg!, '11.0.0.1')).toBe(false);
  });

  it('reads the interface lines the metric uses, hello and hold for this AS only', () => {
    const root = parseConfigText(R1).root;
    const all = readEigrpInterfaces(root, 100);
    expect(all.get('GigabitEthernet0/1')).toEqual({ delayTens: 10, bandwidthKbps: 100_000, helloS: 2, holdS: 6 });
    expect(all.get('GigabitEthernet0/0')).toEqual({ helloS: EIGRP_HELLO_S, holdS: EIGRP_HOLD_S });
    expect(readEigrpInterface(root, 'GigabitEthernet0/1', 200)).toEqual({ delayTens: 10, bandwidthKbps: 100_000, helloS: 1, holdS: 15 });
    expect(readEigrpInterface(root, 'Serial0/0/0', 100)).toEqual({ helloS: 5, holdS: 15 });
    // Fed to the metric, the Gi0/1 lines give the §3.12 link.
    const g = all.get('GigabitEthernet0/1')!;
    expect(link(GIG, g)).toEqual({ bwKbps: 100_000, delayUs: 100 });
  });

  it('defaults: K 1 0 1 0 0, maximum-paths 4, not passive; no process without `router eigrp`', () => {
    const cfg = readEigrpProcess(parseConfigText('router eigrp 7\n network 172.16.0.0\n!').root)!;
    expect(cfg.kValues).toEqual(EIGRP_DEFAULT_K_VALUES);
    expect(cfg.maximumPaths).toBe(EIGRP_DEFAULT_MAXIMUM_PATHS);
    expect(cfg.networks).toEqual([{ address: '172.16.0.0', wildcard: '0.0.255.255', classful: true }]);
    expect(cfg.routerId).toBeUndefined();
    expect(readEigrpProcess(parseConfigText('hostname R9\nrouter ospf 1\n network 10.0.0.0 0.255.255.255 area 0\n!').root)).toBeUndefined();
    expect(readEigrpProcess(parseConfigText('router eigrp 0\n!').root)).toBeUndefined();
  });

  it('passive-interface default with an exemption stored as a negation', () => {
    const root = parseConfigText('router eigrp 1\n passive-interface default\n network 10.0.0.0\n!').root;
    const section = root.children.find((n) => n.key === 'router')!;
    section.children.push({ key: 'no', args: ['passive-interface', 'GigabitEthernet0/1'], children: [] });
    const cfg = readEigrpProcess(root)!;
    expect(cfg.passiveDefault).toBe(true);
    expect(cfg.activeInterfaces).toEqual(['GigabitEthernet0/1']);
    expect(eigrpInterfacePassive(cfg, 'GigabitEthernet0/0')).toBe(true);
    expect(eigrpInterfacePassive(cfg, 'GigabitEthernet0/1')).toBe(false);
  });

  it('network statements: classful classes, wildcard matching, a mask typed as a wildcard, invalid forms', () => {
    expect(['10.9.8.7', '172.16.5.4', '192.168.3.2', '224.0.0.10', '240.0.0.1'].map(eigrpClassfulWildcard)).toEqual([
      '0.255.255.255', '0.0.255.255', '0.0.0.255', undefined, undefined,
    ]);
    expect(eigrpNetworkOf(['10.1.2.3'])).toEqual({ address: '10.0.0.0', wildcard: '0.255.255.255', classful: true });
    expect(eigrpNetworkOf(['10.0.12.9', '0.0.0.255'])).toEqual({ address: '10.0.12.0', wildcard: '0.0.0.255', classful: false });
    expect(eigrpNetworkOf(['10.0.12.0', '255.255.255.0'])).toEqual({ address: '10.0.12.0', wildcard: '0.0.0.255', classful: false });
    expect(eigrpNetworkOf(['0.0.0.0', '255.255.255.255'])).toEqual({ address: '0.0.0.0', wildcard: '255.255.255.255', classful: false });
    expect(eigrpNetworkOf(['10.0.12.1', '0.0.0.0'])).toEqual({ address: '10.0.12.1', wildcard: '0.0.0.0', classful: false });
    expect(eigrpNetworkOf(['224.0.0.0'])).toBeUndefined();
    expect(eigrpNetworkOf(['ten'])).toBeUndefined();
    expect(eigrpNetworkOf([])).toBeUndefined();
    const host = eigrpNetworkOf(['10.0.12.1', '0.0.0.0'])!;
    expect(eigrpNetworkMatches(host, '10.0.12.1')).toBe(true);
    expect(eigrpNetworkMatches(host, '10.0.12.2')).toBe(false);
    expect(eigrpNetworkMatches(eigrpNetworkOf(['0.0.0.0', '255.255.255.255'])!, '203.0.113.9')).toBe(true);
  });

  it('router id: configured, else highest up loopback, else highest up interface', () => {
    const cands = [
      { address: '10.0.12.1', loopback: false, up: true },
      { address: '10.0.13.1', loopback: false, up: true },
      { address: '192.168.9.1', loopback: false, up: false },
      { address: '1.1.1.1', loopback: true, up: true },
      { address: '9.9.9.9', loopback: true, up: false },
    ];
    expect(eigrpRouterIdOf({ routerId: '7.7.7.7' }, cands)).toBe('7.7.7.7');
    expect(eigrpRouterIdOf({}, cands)).toBe('1.1.1.1');
    expect(eigrpRouterIdOf({}, cands.filter((c) => !c.loopback))).toBe('10.0.13.1');
    expect(eigrpRouterIdOf({}, [])).toBeUndefined();
  });
});

describe('eigrp: the §4.5 grep ban', () => {
  it('protocols/eigrp/ uses no floating-point maths, exponentiation, randomness or clocks', () => {
    const BANNED = /Math\.(log10|log2|log|pow|exp|random)\s*\(|Date\.now|performance\.now|new Date\(|setTimeout|[\w)\]]\s*\*\*\s*[\w(]/;
    const dir = fileURLToPath(new URL('../src/protocols/eigrp/', import.meta.url));
    const files = readdirSync(dir).filter((f) => f.endsWith('.ts')).sort();
    expect(files).toEqual(expect.arrayContaining(['config.ts', 'dual.ts', 'metric.ts']));
    for (const f of files) expect(readFileSync(join(dir, f), 'utf8'), f).not.toMatch(BANNED);
  });
});
