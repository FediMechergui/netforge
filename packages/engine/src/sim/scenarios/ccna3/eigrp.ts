/**
 * sim/scenarios/ccna3/eigrp.ts — the CCNA 3 EIGRP labs [C1] (ARCHITECTURE-P3 §11.1, §11.2, D26, §2.10, §2.16, §3.12,
 * §5.1; owner: the W5 eigrp item, rule 18).
 *
 *   • `ccna3-eigrp-feasible-successor` — lesson 10 "EIGRP and its metric" (module "EIGRP"), a build lab on §3.12's
 *     world: R1 reaches R4's LAN through R2 over gigabit links and through R3, whose link to R1 is a rented 100 Mb/s
 *     circuit with 100 µs of delay. The learner runs EIGRP 100 on the four routers, tells EIGRP the truth about the
 *     slow circuit (`bandwidth 100000`, `delay 10` on both ends), reads the composite metric (3328 through R2, 28672
 *     through R3), finds the successor (R2) and the feasible successor (R3: its reported distance 3072 is below the
 *     feasible distance 3328), and sees both failovers that one cut cable causes: 10.4.0.0/24 moves to its feasible
 *     successor at once, while the R2–R4 link 10.0.24.0/24 has none (R3 reports 3072, equal to the FD 3072, and the
 *     condition is strict), so R1 queries R3 before it installs the path. Both failovers land at 28672 via 10.0.13.3.
 *   • `ccna3-troubleshoot-eigrp` — lesson 33 "A method for enterprise faults" (module "Designing and fixing"): an HQ
 *     router with three branches, all in EIGRP 100, broken by four hidden changes, one per router — R2 moved to AS 200,
 *     R3 given other K values (`metric weights 0 1 1 1 0 0`), R4's uplink made passive, and R1's `network` line for the
 *     HQ LAN removed. The learner works layer by layer: links and addresses (all fine), then neighbours (three faults,
 *     each with its own symptom: silence, a logged K-value mismatch, no hellos at all), then routes (the HQ LAN is
 *     missing once a branch peers again).
 *
 * Both are P3-profile worlds (`topology(…, { profile: 'P3' })`, schema 1.3) with a fixed seed. EIGRP needs no
 * timing warning (§11.2): neighbours and routes form within milliseconds of link-up (§3.12), so the instructions say
 * "about a minute" only for the 45 s router boot. R4 of lab 10 and R1 of lab 33 are NF-4331s with an NF-NIM-2GE in
 * slot 0/1 (§3.12's R4), which gives them the third and fourth gigabit port. The only switch (SW1 of lab 33) has every
 * host port and its router-facing port as an edge port (`spanning-tree portfast`, §11.2).
 *
 * Tasks read structured state with the §2.10 kinds only: `neighbor {protocol: 'eigrp', state: 'up'}` (the
 * `eigrp-neighbors` rows), `route {source: 'EIGRP', nextHop, metric}` (the rib rows the daemon offered), the facts
 * `eigrp.successor`, `eigrp.feasibleSuccessor`, `eigrp.fd` (eigrp-topology; subject a prefix) and `eigrp.kValues`
 * (configuration), `table eigrp-topology`, `config` lines, and `connectivity` — with `after: [{cut: {a: 'R1', b: 'R2',
 * aPort}}]` and `then` route checks for the failovers (one grading clone for both, §3.12's grading). The troubleshooting
 * lab's faults are scheduled `config-fragment` faults (§11.2, the kit's helper) that land at FAULTS_AT, after every
 * router has booted, and end with `do write memory`, so a power cycle keeps them; until they have landed the grader
 * grades nothing (sim/lab-checks.ts). Each fault task reads the repaired setting on the router that holds it, with a
 * ping from R1 that only that repair lets through, so partial repairs earn exactly their share; the last task pings
 * the HQ server from every branch.
 *
 * All wording is original (§0 rule 6). A lab file imports only the contracts, `../kit.js` and `../templates.js` —
 * never `./index.js`, `../index.js` or the engine barrel — so the catalogue stays an acyclic graph of data modules.
 *
 * ponytail: the "failover without a feasible successor" is graded by its outcome in the clone (the path via R3 at
 * 28672), not by the query itself: no §2.10 kind reads an `eigrp-route` transition, and a `fact` cannot assert that a
 * feasible successor is absent. The instructions have the learner watch the query live (`debug eigrp fsm`).
 */
import type { ModuleInstall } from '../../../contracts/catalog.js';
import type { ScenarioInfo } from '../../../contracts/scenario.js';
import { SEC } from '../../../contracts/time.js';
import type { TopologyDevice } from '../../../contracts/topology.js';
import { MASK24, PC, ROUTER, SERVER, SWITCH, accessPort, configFragmentFault, configText, device, link, section, topology, type ScheduledFault } from '../kit.js';
import { pcConfig } from '../templates.js';

/** NF-4331, the router with network module slots (§3.12's R4). */
const ROUTER_4331 = 'router.nf4331';
/** Its two-port gigabit network module in slot 0/1 (GigabitEthernet0/1/0 and 0/1/1). */
const NIM_2GE: readonly ModuleInstall[] = [{ slot: '0/1', module: 'mod.nim-2ge' }];

/** The autonomous system of both labs. */
export const EIGRP_LAB_AS = 100;

/** A device with modules installed in its slots. */
function withModules(d: TopologyDevice, modules: readonly ModuleInstall[]): TopologyDevice {
  return { ...d, modules: [...modules] };
}

/** One routed interface of a startup configuration: address, extra lines, enabled. */
function routedPort(port: string, address: string, extra: readonly string[] = []): string[] {
  return section(`interface ${port}`, [`ip address ${address} ${MASK24}`, ...extra, 'no shutdown']);
}

// ── lab 10: successor, feasible successor and failover (§3.12) ─────────────

/** The slow R1–R3 circuit as EIGRP must be told about it: 100 Mb/s and 100 µs (delay in tens of µs). */
const SLOW_CIRCUIT: readonly string[] = ['bandwidth 100000', 'delay 10'];

/** R4's LAN, the destination of §3.12, and the R2–R4 link, the destination without a feasible successor. */
const FS_LAN = '10.4.0.0/24';
const NO_FS_LINK = '10.0.24.0/24';

/** §3.12's metrics at R1 (D26: 256 × (floor(10⁷ / slowest kb/s) + floor(Σ delay µs / 10))). */
const METRIC_VIA_R2 = 3328; // 10.4.0.0/24: 256 × (10 + 3)
const METRIC_VIA_R3 = 28672; // 10.4.0.0/24 and 10.0.24.0/24 through R3: 256 × (100 + 12)
const FD_R2_R4_LINK = 3072; // 10.0.24.0/24 through R2: 256 × (10 + 2)

/** The cut every failover check of lab 10 makes in its grading copy: the R1–R2 cable on R1 GigabitEthernet0/0. */
const CUT_R1_R2 = [{ cut: { a: 'R1', b: 'R2', aPort: 'GigabitEthernet0/0' } }] as const;

/** The EIGRP lines lab 10's solution types on every router. */
const EIGRP_100: readonly string[] = [`router eigrp ${EIGRP_LAB_AS}`, 'network 10.0.0.0', 'exit'];

/** Four routers, two ways from R1 to R4's LAN; EIGRP is not configured yet and the slow circuit is undescribed. */
export const ccna3EigrpFeasibleSuccessor: ScenarioInfo = {
  name: 'ccna3-eigrp-feasible-successor',
  category: 'ccna3-lab',
  labType: 'build',
  course: 'CCNA 3',
  topic: 'EIGRP',
  title: 'A backup path that is ready before it is needed',
  description:
    'R1 can reach the LAN behind R4 through R2 over gigabit links or through R3 over a slower rented circuit. Run EIGRP on all four routers, describe the slow circuit, read the composite metric, and find the successor and the feasible successor — then see what happens to each route when the cable to R2 is cut.',
  objectives: [
    'Run EIGRP in one autonomous system and confirm every neighbour',
    'Set the bandwidth and delay that EIGRP uses for a link',
    'Work out the composite metric from the slowest bandwidth and the total delay',
    'Find the successor and the feasible successor of a route, and say why another path is not feasible',
    'Compare a failover to a feasible successor with one that needs a query',
  ],
  tags: ['eigrp', 'dual', 'composite metric', 'successor', 'feasible successor', 'failover'],
  difficulty: 2,
  estimatedMinutes: 35,
  requires: [PC, ROUTER, ROUTER_4331],
  seed: 310,
  instructions: [
    '## The network',
    '',
    'Every link is a /24, and every interface is addressed and up:',
    '',
    '- R1 `GigabitEthernet0/0` `10.0.12.1` — R2 `GigabitEthernet0/0` `10.0.12.2`',
    '- R1 `GigabitEthernet0/1` `10.0.13.1` — R3 `GigabitEthernet0/0` `10.0.13.3`: a rented circuit of **100 Mb/s with 100 µs of delay**, although both ports are gigabit',
    '- R2 `GigabitEthernet0/1` `10.0.24.2` — R4 `GigabitEthernet0/0/0` `10.0.24.4`',
    '- R3 `GigabitEthernet0/1` `10.0.34.3` — R4 `GigabitEthernet0/0/1` `10.0.34.4`',
    '- R4 `GigabitEthernet0/1/0` `10.4.0.1` — PC4 `10.4.0.10`',
    '',
    'The routers take about a minute to start. After that EIGRP needs no waiting: neighbours and routes form within a few milliseconds of a link coming up.',
    '',
    '## What to do',
    '',
    '1. On each of the four routers, start EIGRP in autonomous system 100 and enable it on every 10.x interface: `router eigrp 100`, then `network 10.0.0.0`.',
    '2. Check the neighbours with `show ip eigrp neighbors`: R1 and R4 should each list two. Then look at `show ip route eigrp` on R1 — as far as EIGRP knows, both ways to `10.4.0.0/24` are gigabit, so it uses both.',
    '3. Describe the rented circuit on both of its ends, R1 `GigabitEthernet0/1` and R3 `GigabitEthernet0/0`: `bandwidth 100000` (in kb/s) and `delay 10` (in tens of microseconds).',
    '4. Work out the metric R1 should compute for `10.4.0.0/24` on each path, with the default weights: 256 × (10 000 000 ÷ the slowest bandwidth in kb/s + the total delay in µs ÷ 10), each division rounded down. The total delay adds up the interfaces the traffic leaves by: R1\'s exit interface, the exit interface of each router after it, and R4\'s LAN interface — 10 µs for each gigabit one. Compare your numbers with `show ip route` and `show ip eigrp topology`.',
    '5. In `show ip eigrp topology`, the feasible distance (FD) is the metric of the best path, and each path shows two numbers in parentheses: its metric through that neighbour, then the distance the neighbour itself reports (RD). A neighbour whose RD is lower than the FD cannot be looping back through R1: it is a **feasible successor**, kept ready as a backup. Find it for `10.4.0.0/24`.',
    '6. Now look at `10.0.24.0/24` with `show ip eigrp topology all-links`. R3 offers a path, but its RD only equals the FD — and the condition is strictly lower — so R1 has no feasible successor for that link.',
    '7. Watch both failovers: `debug eigrp fsm` on R1, then `shutdown` and `no shutdown` on R1 `GigabitEthernet0/0`. `10.4.0.0/24` moves to R3 in the same instant; `10.0.24.0/24` goes active, R1 queries R3, and the route returns only with R3\'s reply — a few microseconds later here, but in a large network a query can travel far. Turn debugging off with `undebug all`.',
    '',
    '*The checker cuts the R1–R2 cable in its own copy of the network, so leave R1 `GigabitEthernet0/0` up when you check.*',
  ].join('\n'),
  build: () =>
    topology(
      310,
      [
        device(
          'r1',
          ROUTER,
          'R1',
          150,
          250,
          configText([['hostname R1'], routedPort('GigabitEthernet0/0', '10.0.12.1'), routedPort('GigabitEthernet0/1', '10.0.13.1')]),
        ),
        device(
          'r2',
          ROUTER,
          'R2',
          400,
          110,
          configText([['hostname R2'], routedPort('GigabitEthernet0/0', '10.0.12.2'), routedPort('GigabitEthernet0/1', '10.0.24.2')]),
        ),
        device(
          'r3',
          ROUTER,
          'R3',
          400,
          390,
          configText([['hostname R3'], routedPort('GigabitEthernet0/0', '10.0.13.3'), routedPort('GigabitEthernet0/1', '10.0.34.3')]),
        ),
        withModules(
          device(
            'r4',
            ROUTER_4331,
            'R4',
            650,
            250,
            configText([
              ['hostname R4'],
              routedPort('GigabitEthernet0/0/0', '10.0.24.4'),
              routedPort('GigabitEthernet0/0/1', '10.0.34.4'),
              routedPort('GigabitEthernet0/1/0', '10.4.0.1'),
            ]),
          ),
          NIM_2GE,
        ),
        device('pc4', PC, 'PC4', 860, 250, pcConfig('PC4', '10.4.0.10', MASK24, '10.4.0.1')),
      ],
      [
        link('l_r1_r2', 'r1', 'GigabitEthernet0/0', 'r2', 'GigabitEthernet0/0'),
        link('l_r1_r3', 'r1', 'GigabitEthernet0/1', 'r3', 'GigabitEthernet0/0'),
        link('l_r2_r4', 'r2', 'GigabitEthernet0/1', 'r4', 'GigabitEthernet0/0/0'),
        link('l_r3_r4', 'r3', 'GigabitEthernet0/1', 'r4', 'GigabitEthernet0/0/1'),
        link('l_r4_pc4', 'r4', 'GigabitEthernet0/1/0', 'pc4', 'GigabitEthernet0'),
      ],
      ['Form every EIGRP neighbour', 'Describe the slow circuit', 'Find the successor and the feasible successor', 'Fail over with and without a feasible successor'],
      'EIGRP keeps a backup path only when the neighbour offering it is provably closer to the destination than the best path is: its reported distance must be lower than the feasible distance.',
      { profile: 'P3' },
    ),
  tasks: [
    {
      id: 'neighbours',
      title: 'Every router peers in AS 100',
      description: 'R1, R2, R3 and R4 run EIGRP in autonomous system 100; R1 is up with R2 and R3, and R4 is up with R2 and R3.',
      points: 20,
      hint: 'Routers peer only inside the same autonomous system, and only on interfaces that a `network` line enables.',
      assertions: [
        ...['R1', 'R2', 'R3', 'R4'].map((d) => ({ kind: 'config' as const, device: d, path: 'router.eigrp', equals: `eigrp ${EIGRP_LAB_AS}` })),
        { kind: 'neighbor', device: 'R1', protocol: 'eigrp', neighbor: 'R2', state: 'up' },
        { kind: 'neighbor', device: 'R1', protocol: 'eigrp', neighbor: 'R3', state: 'up' },
        { kind: 'neighbor', device: 'R4', protocol: 'eigrp', neighbor: 'R2', state: 'up' },
        { kind: 'neighbor', device: 'R4', protocol: 'eigrp', neighbor: 'R3', state: 'up' },
      ],
      feedbackOnFail: 'A router that runs EIGRP on an interface sends hellos there; two routers on one link become neighbours when both do so in the same autonomous system.',
    },
    {
      id: 'slow-circuit',
      title: 'EIGRP knows the circuit is slow',
      description: 'R1 GigabitEthernet0/1 and R3 GigabitEthernet0/0 both say bandwidth 100000 and delay 10.',
      points: 15,
      hint: 'EIGRP never measures a link: it takes bandwidth and delay from the interface configuration, and only the port speed when there is none.',
      assertions: [
        { kind: 'config', device: 'R1', path: 'interface.GigabitEthernet0/1.bandwidth', equals: '100000' },
        { kind: 'config', device: 'R1', path: 'interface.GigabitEthernet0/1.delay', equals: '10' },
        { kind: 'config', device: 'R3', path: 'interface.GigabitEthernet0/0.bandwidth', equals: '100000' },
        { kind: 'config', device: 'R3', path: 'interface.GigabitEthernet0/0.delay', equals: '10' },
      ],
      feedbackOnFail: 'Set both values on both ends of the circuit: each router computes its own metric from the interface it receives the route on.',
    },
    {
      id: 'successor',
      title: 'R2 is the successor at metric 3328',
      description: 'R1 routes 10.4.0.0/24 by EIGRP through 10.0.12.2 at metric 3328, which is also its feasible distance.',
      points: 20,
      hint: 'Through R2 the slowest link is gigabit and the delay is three gigabit interfaces.',
      assertions: [
        { kind: 'route', device: 'R1', destination: '10.4.0.10', network: FS_LAN, source: 'EIGRP', ad: 90, nextHop: '10.0.12.2', iface: 'GigabitEthernet0/0', metric: METRIC_VIA_R2 },
        { kind: 'fact', device: 'R1', fact: 'eigrp.successor', subject: FS_LAN, equals: 'R2' },
        { kind: 'fact', device: 'R1', fact: 'eigrp.fd', subject: FS_LAN, equals: METRIC_VIA_R2 },
      ],
      feedbackOnFail: 'The successor is the neighbour on the path with the lowest metric, and that metric is the feasible distance.',
    },
    {
      id: 'feasible-successor',
      title: 'R3 waits as the feasible successor',
      description:
        'R1 keeps R3 as the feasible successor of 10.4.0.0/24, and when the R1–R2 cable is cut R1 still reaches PC4, now through 10.0.13.3 at metric 28672.',
      points: 25,
      dependsOn: ['neighbours', 'slow-circuit'],
      hint: 'R3 reports a distance of 3072 to 10.4.0.0/24; compare it with the feasible distance.',
      assertions: [
        {
          kind: 'fact',
          device: 'R1',
          fact: 'eigrp.feasibleSuccessor',
          subject: FS_LAN,
          equals: 'R3',
          misconception: 'eigrp-fs-needs-unequal-metric',
          feedback: 'While both paths cost the same, R3 is a second successor, not a feasible successor.',
        },
        {
          kind: 'connectivity',
          from: 'R1',
          to: 'PC4',
          expect: 'success',
          after: CUT_R1_R2,
          settleMs: 5000,
          then: [{ kind: 'route', device: 'R1', destination: '10.4.0.10', network: FS_LAN, source: 'EIGRP', nextHop: '10.0.13.3', iface: 'GigabitEthernet0/1', metric: METRIC_VIA_R3 }],
        },
      ],
      feedbackOnFail: 'A feasible successor is a neighbour whose reported distance is strictly lower than the feasible distance; DUAL promotes it the moment the successor is lost, without asking anyone.',
    },
    {
      id: 'no-feasible-successor',
      title: 'The R2–R4 link fails over by a query',
      description:
        'R1 routes 10.0.24.0/24 through R2 with feasible distance 3072, and when the R1–R2 cable is cut R1 still reaches R4 at 10.0.24.4, through 10.0.13.3 at metric 28672.',
      points: 20,
      dependsOn: ['neighbours', 'slow-circuit'],
      hint: 'R3 reports 3072 for this link too — exactly the feasible distance, which is not enough.',
      assertions: [
        { kind: 'fact', device: 'R1', fact: 'eigrp.successor', subject: NO_FS_LINK, equals: 'R2' },
        { kind: 'fact', device: 'R1', fact: 'eigrp.fd', subject: NO_FS_LINK, equals: FD_R2_R4_LINK },
        {
          kind: 'connectivity',
          from: 'R1',
          to: 'R4',
          toAddress: '10.0.24.4',
          expect: 'success',
          after: CUT_R1_R2,
          settleMs: 5000,
          then: [{ kind: 'route', device: 'R1', destination: '10.0.24.4', network: NO_FS_LINK, source: 'EIGRP', nextHop: '10.0.13.3', iface: 'GigabitEthernet0/1', metric: METRIC_VIA_R3 }],
        },
      ],
      feedbackOnFail: 'Without a feasible successor the route goes active: R1 queries its neighbours and installs the best path their replies offer.',
    },
  ],
  solution: {
    R1: [...EIGRP_100, 'interface GigabitEthernet0/1', ...SLOW_CIRCUIT, 'exit'],
    R2: [...EIGRP_100],
    R3: [...EIGRP_100, 'interface GigabitEthernet0/0', ...SLOW_CIRCUIT, 'exit'],
    R4: [...EIGRP_100],
  },
};

// ── lab 33: the layered method on an EIGRP network ──────────────────────────

/** When the hidden changes land: after every router has booted (45 s). */
const FAULTS_AT = 50 * SEC;

/** A hidden change, saved as well so a power cycle keeps it (the last line runs in global mode). */
function savedChange(deviceId: string, lines: readonly string[]): ScheduledFault {
  return configFragmentFault(FAULTS_AT, deviceId, [...lines, 'do write memory']);
}

/** The HQ LAN: outside 10.0.0.0/8, so it needs a `network` line of its own. */
const HQ_LAN = '192.168.1.0/24';

/** A branch router: uplink to R1 on Gi0/0, its LAN (no router there, so passive) on Gi0/1. */
function branchConfig(hostname: string, uplink: string, lan: string): string {
  return configText([
    [`hostname ${hostname}`],
    routedPort('GigabitEthernet0/0', uplink),
    routedPort('GigabitEthernet0/1', lan),
    section(`router eigrp ${EIGRP_LAB_AS}`, ['network 10.0.0.0', 'passive-interface GigabitEthernet0/1']),
  ]);
}

/** HQ (R1 with SW1, PC1 and SRV1) and three branches (R2, R3, R4, each with one PC); four hidden faults, one per router. */
export const ccna3TroubleshootEigrp: ScenarioInfo = {
  name: 'ccna3-troubleshoot-eigrp',
  category: 'ccna3-lab',
  labType: 'troubleshoot',
  course: 'CCNA 3',
  topic: 'Designing and fixing',
  title: 'Layer by layer through a broken EIGRP network',
  description:
    'Head office and three branches share their routes with EIGRP, and since a round of changes no branch reaches the server at head office. Work up the layers — links, addresses, neighbours, routes — and repair each fault on the router that holds it.',
  objectives: [
    'Apply a layered method: rule out the links and the addressing before the routing protocol',
    'Explain why two routers will not become EIGRP neighbours: another autonomous system, other K values, a passive interface',
    'Use the log, the neighbour table and the protocol summary to tell those causes apart',
    'Find a network that EIGRP does not advertise because no network line enables it',
  ],
  tags: ['troubleshooting', 'layered method', 'eigrp', 'autonomous system', 'k values', 'passive interface', 'network statement'],
  difficulty: 3,
  estimatedMinutes: 35,
  requires: [PC, ROUTER, ROUTER_4331, SERVER, SWITCH],
  seed: 333,
  instructions: [
    '## The network as documented',
    '',
    'Every router runs EIGRP in autonomous system 100 with the default K values (`1 0 1 0 0`). Every interface is addressed and should be up:',
    '',
    '- HQ: R1 `GigabitEthernet0/1/1` `192.168.1.1/24` on SW1, with PC1 `192.168.1.10` and the server SRV1 `192.168.1.20`. R1 enables 10.x with `network 10.0.0.0` and the HQ LAN with `network 192.168.1.0`; its HQ port is passive, since no router listens there.',
    '- Branch 2: R1 `GigabitEthernet0/0/0` `10.0.12.1` — R2 `GigabitEthernet0/0` `10.0.12.2`; R2 `GigabitEthernet0/1` `10.2.0.1/24` with PC2 `10.2.0.10`.',
    '- Branch 3: R1 `GigabitEthernet0/0/1` `10.0.13.1` — R3 `GigabitEthernet0/0` `10.0.13.3`; R3 `GigabitEthernet0/1` `10.3.0.1/24` with PC3 `10.3.0.10`.',
    '- Branch 4: R1 `GigabitEthernet0/1/0` `10.0.14.1` — R4 `GigabitEthernet0/0` `10.0.14.4`; R4 `GigabitEthernet0/1` `10.4.0.1/24` with PC4 `10.4.0.10`.',
    '- Each branch router enables 10.x with `network 10.0.0.0` and makes its LAN port passive.',
    '',
    'The documentation above is right. Shortly after start-up, a round of changes broke the network: no branch PC reaches SRV1, and R1 hears from none of its branches.',
    '',
    '## What to do',
    '',
    'The routers take about a minute to start; after that, EIGRP forms a neighbour within milliseconds of the two routers agreeing. Work from the bottom up and repair each fault where it lies:',
    '',
    '- Links and addresses: `show ip interface brief` on every router, and a ping from R1 to each branch router across its link. If these work, the fault is above them.',
    '- Neighbours: `show ip eigrp neighbors` on R1 and on each branch. For a missing neighbour compare `show ip protocols` on both ends (the autonomous system, the K values, the passive interfaces) and read `show logging` on R1.',
    '- Routes: once a branch peers again, does it learn every network? `show ip route eigrp` and `show ip eigrp topology` on the branch, and the `network` lines in `show running-config` on the router that should advertise what is missing.',
    '- Prove the result from end to end: ping SRV1 from PC2, PC3 and PC4.',
    '',
    '*Repair what is broken rather than working around it: no static route and no change of autonomous system on the healthy routers is needed.*',
  ].join('\n'),
  build: () =>
    topology(
      333,
      [
        withModules(
          device(
            'r1',
            ROUTER_4331,
            'R1',
            450,
            320,
            configText([
              ['hostname R1'],
              routedPort('GigabitEthernet0/0/0', '10.0.12.1'),
              routedPort('GigabitEthernet0/0/1', '10.0.13.1'),
              routedPort('GigabitEthernet0/1/0', '10.0.14.1'),
              routedPort('GigabitEthernet0/1/1', '192.168.1.1'),
              section(`router eigrp ${EIGRP_LAB_AS}`, ['network 10.0.0.0', 'network 192.168.1.0', 'passive-interface GigabitEthernet0/1/1']),
            ]),
          ),
          NIM_2GE,
        ),
        device(
          'sw1',
          SWITCH,
          'SW1',
          450,
          460,
          configText([['hostname SW1'], accessPort('GigabitEthernet0/1', 1, { portfast: true }), accessPort('FastEthernet0/1', 1, { portfast: true }), accessPort('FastEthernet0/2', 1, { portfast: true })]),
        ),
        device('pc1', PC, 'PC1', 340, 590, pcConfig('PC1', '192.168.1.10', MASK24, '192.168.1.1')),
        device('srv1', SERVER, 'SRV1', 560, 590, pcConfig('SRV1', '192.168.1.20', MASK24, '192.168.1.1')),
        device('r2', ROUTER, 'R2', 150, 170, branchConfig('R2', '10.0.12.2', '10.2.0.1')),
        device('r3', ROUTER, 'R3', 450, 150, branchConfig('R3', '10.0.13.3', '10.3.0.1')),
        device('r4', ROUTER, 'R4', 750, 170, branchConfig('R4', '10.0.14.4', '10.4.0.1')),
        device('pc2', PC, 'PC2', 150, 40, pcConfig('PC2', '10.2.0.10', MASK24, '10.2.0.1')),
        device('pc3', PC, 'PC3', 450, 20, pcConfig('PC3', '10.3.0.10', MASK24, '10.3.0.1')),
        device('pc4', PC, 'PC4', 750, 40, pcConfig('PC4', '10.4.0.10', MASK24, '10.4.0.1')),
      ],
      [
        link('l_r1_r2', 'r1', 'GigabitEthernet0/0/0', 'r2', 'GigabitEthernet0/0'),
        link('l_r1_r3', 'r1', 'GigabitEthernet0/0/1', 'r3', 'GigabitEthernet0/0'),
        link('l_r1_r4', 'r1', 'GigabitEthernet0/1/0', 'r4', 'GigabitEthernet0/0'),
        link('l_r1_sw1', 'r1', 'GigabitEthernet0/1/1', 'sw1', 'GigabitEthernet0/1'),
        link('l_pc1_sw1', 'pc1', 'GigabitEthernet0', 'sw1', 'FastEthernet0/1'),
        link('l_srv1_sw1', 'srv1', 'GigabitEthernet0', 'sw1', 'FastEthernet0/2'),
        link('l_r2_pc2', 'r2', 'GigabitEthernet0/1', 'pc2', 'GigabitEthernet0'),
        link('l_r3_pc3', 'r3', 'GigabitEthernet0/1', 'pc3', 'GigabitEthernet0'),
        link('l_r4_pc4', 'r4', 'GigabitEthernet0/1', 'pc4', 'GigabitEthernet0'),
      ],
      ['Bring back the branch in the wrong autonomous system', 'Match the K values', 'Let the uplink send hellos again', 'Advertise the HQ LAN', 'Reach the HQ server from every branch'],
      'Two EIGRP routers become neighbours only when they share a link, an autonomous system and their K values, and both send hellos there; a route exists only for a network some router enables.',
      { profile: 'P3' },
    ),
  faults: [
    savedChange('r2', [`no router eigrp ${EIGRP_LAB_AS}`, 'router eigrp 200', ' network 10.0.0.0', ' passive-interface GigabitEthernet0/1']),
    savedChange('r3', [`router eigrp ${EIGRP_LAB_AS}`, ' metric weights 0 1 1 1 0 0']),
    savedChange('r4', [`router eigrp ${EIGRP_LAB_AS}`, ' passive-interface GigabitEthernet0/0']),
    savedChange('r1', [`router eigrp ${EIGRP_LAB_AS}`, ' no network 192.168.1.0']),
  ],
  tasks: [
    {
      id: 'autonomous-system',
      title: 'Branch 2 is back in AS 100',
      description: 'R2 runs EIGRP in autonomous system 100, R1 is up with R2, and R1 reaches PC2.',
      points: 20,
      hint: 'Hellos from another autonomous system are ignored without a word: compare the number after `router eigrp` on both ends.',
      assertions: [
        { kind: 'config', device: 'R2', path: 'router.eigrp', equals: `eigrp ${EIGRP_LAB_AS}` },
        { kind: 'neighbor', device: 'R1', protocol: 'eigrp', neighbor: 'R2', state: 'up' },
        { kind: 'connectivity', from: 'R1', to: 'PC2', expect: 'success' },
      ],
      feedbackOnFail: 'The autonomous system number is not a local label: every router of one EIGRP domain must use the same one.',
    },
    {
      id: 'k-values',
      title: 'Branch 3 uses the same K values',
      description: 'R3 uses the K values 1 0 1 0 0 again, R1 is up with R3, and R1 reaches PC3.',
      points: 20,
      hint: 'R1 logs why it refuses a neighbour; `show ip protocols` lists the K values each router uses.',
      assertions: [
        { kind: 'fact', device: 'R3', fact: 'eigrp.kValues', equals: '1 0 1 0 0' },
        { kind: 'neighbor', device: 'R1', protocol: 'eigrp', neighbor: 'R3', state: 'up' },
        { kind: 'connectivity', from: 'R1', to: 'PC3', expect: 'success' },
      ],
      feedbackOnFail: 'Routers that weigh the metric differently could compute loops, so EIGRP refuses to peer until the K values match.',
    },
    {
      id: 'passive-uplink',
      title: 'Branch 4 says hello on its uplink',
      description: 'R4 sends hellos on GigabitEthernet0/0 again, R1 and R4 are up with each other, and R1 reaches PC4.',
      points: 20,
      hint: 'A passive interface still has its network advertised, but it neither sends nor accepts hellos.',
      assertions: [
        { kind: 'neighbor', device: 'R4', protocol: 'eigrp', neighbor: 'R1', iface: 'GigabitEthernet0/0', state: 'up' },
        { kind: 'neighbor', device: 'R1', protocol: 'eigrp', neighbor: 'R4', state: 'up' },
        { kind: 'connectivity', from: 'R1', to: 'PC4', expect: 'success' },
      ],
      feedbackOnFail: 'Make passive only the ports where no router listens, such as a LAN of hosts; an uplink must stay active.',
    },
    {
      id: 'hq-network',
      title: 'R1 advertises the HQ LAN',
      description: 'A network line on R1 enables 192.168.1.0/24 again, so the HQ LAN is in R1\'s EIGRP topology table as a connected network.',
      points: 20,
      hint: '`network 10.0.0.0` covers only the 10.x interfaces: the HQ LAN needs a line of its own.',
      assertions: [{ kind: 'table', device: 'R1', table: 'eigrp-topology', where: { prefix: HQ_LAN, connected: 'GigabitEthernet0/1/1' }, exists: true }],
      feedbackOnFail: 'EIGRP advertises a connected network only when a network line matches the address of its interface.',
    },
    {
      id: 'end-to-end',
      title: 'Every branch reaches the HQ server',
      description: 'PC2, PC3 and PC4 each reach SRV1.',
      points: 20,
      dependsOn: ['autonomous-system', 'k-values', 'passive-uplink', 'hq-network'],
      assertions: [
        { kind: 'connectivity', from: 'PC2', to: 'SRV1', expect: 'success' },
        { kind: 'connectivity', from: 'PC3', to: 'SRV1', expect: 'success' },
        { kind: 'connectivity', from: 'PC4', to: 'SRV1', expect: 'success' },
      ],
      feedbackOnFail: 'A branch needs a route to the HQ LAN and the server needs one back: each depends on a neighbour that is up and on a network that is advertised.',
    },
  ],
  solution: {
    R2: ['no router eigrp 200', `router eigrp ${EIGRP_LAB_AS}`, 'network 10.0.0.0', 'passive-interface GigabitEthernet0/1', 'exit'],
    R3: [`router eigrp ${EIGRP_LAB_AS}`, 'no metric weights', 'exit'],
    R4: [`router eigrp ${EIGRP_LAB_AS}`, 'no passive-interface GigabitEthernet0/0', 'exit'],
    R1: [`router eigrp ${EIGRP_LAB_AS}`, 'network 192.168.1.0', 'exit'],
  },
};

/** The CCNA 3 EIGRP labs [C1], in course order (lessons 10 and 33). */
export const CCNA3_EIGRP_LABS: readonly ScenarioInfo[] = Object.freeze([ccna3EigrpFeasibleSuccessor, ccna3TroubleshootEigrp]);
