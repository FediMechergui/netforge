/**
 * sim/scenarios/ccna3/ospf.ts — the CCNA 3 OSPF labs (ARCHITECTURE-P3 §7 W5 "ospf", §11.1, §11.2, §2.10, §3.1, §3.2,
 * §4.2, §5.1, D7–D10).
 *
 *   • `ccna3-ospf-dr-election`     — lesson 03 "Neighbours and the designated router" (module "Routers that learn"):
 *     three routers share one switched segment whose router ports are still shut. The learner chooses the designated
 *     and backup designated router with priorities BEFORE the segment comes up (the election never preempts), keeps a
 *     small router out of both roles with priority 0, turns the two-router link to R4 into a point-to-point network
 *     (no election, no 40 s wait), and watches the backup take over when the designated router fails.
 *   • `ccna3-ospf-single-area`     — lesson 04 "Switching OSPF on" (module "One OSPF area"): R2 already runs OSPF; R1
 *     joins with network statements and R3 with interface lines, both with a fixed router ID, and both keep their host
 *     LANs passive. One shared map (router and network advertisements) and an end-to-end ping prove it.
 *   • `ccna3-ospf-cost`            — lesson 05 "Cost and the best path": a triangle of two gigabit hops and a serial
 *     line. The learner raises the reference bandwidth everywhere, declares the 100 Mb/s carrier circuit behind one
 *     gigabit port with `bandwidth`, derives the serial cost that makes both paths equal, and proves the load sharing
 *     (two equal-cost paths) and the failover cost.
 *   • `ccna3-ospf-default-route`   — lesson 06 "Default routes and timers": an edge router with a static default toward
 *     a provider that runs no OSPF. One side of the R1–R2 link was tuned to 5 s hellos, so the two never peer; the
 *     learner matches the timers, then advertises R1's default into OSPF (an external type-2 route of cost 1 on every
 *     other router) so the hosts reach the provider's server.
 *   • `ccna3-troubleshoot-ospf`    — lesson 07 "Fixing OSPF" (troubleshoot): three hidden changes, one per router — a
 *     network statement whose wildcard matches no interface (R1's LAN disappears), an interface moved into another area
 *     (R1 and R2 never peer) and a router that started OSPF with the router ID of its neighbour (R3 uses R2's, so the
 *     two refuse each other's hellos). Each fault has a task that reads the setting to repair on the router that holds
 *     it, so the repairs score one by one in any order; the last task proves the whole path.
 *
 * ponytail (lab 07's duplicate): the duplicate is between NEIGHBOURS on purpose. Neighbours refuse each other's hellos
 * (hello check 8), so the fault shows in the neighbour and interface views the instructions point at, and no repair
 * order of this lab ever lets their advertisements meet. (Two routers with one ID that are not neighbours fight over
 * one router advertisement instead; that war once kept `runToIdle` from returning — fixed in W5 integration, the
 * daemon now gives up after OSPF_SELF_WAR_MAX_COPIES lost rounds, test/ospf.self-war-bounded.test.ts.)
 *
 * Every world is P3-profile (`topology(…, { profile: 'P3' })`, schema 1.3), so CDP and the P3 logging defaults run as
 * on any P3 device. Switch ports facing hosts and routers are edge ports (`spanning-tree portfast`, §11.2): no lesson
 * here is about spanning tree. The instructions carry §11.2's timing sentences (routers boot in 45 s; a broadcast
 * segment waits 40 s before its election and runs its first SPF 5 s later — "allow about 90 s before the first
 * ping"; a point-to-point link brings its routes 15 s after it comes up — "about a minute").
 *
 * Tasks read structured state only (§2.10, rule 20): `neighbor` (ospf-neighbors: state and role), `fact ospf.*`
 * (ospf-interfaces, the configuration, ospf-lsdb), `table` rows of `ospf-interfaces` and `ospf-lsdb`, `route` (source,
 * route type, metric, equal-cost paths), `config` and `connectivity` (with `after` and `then` in the grader's clone).
 * Router IDs are graded LIVE with `fact ospf.routerId` (the id in use, §11.2): a clone boots from the export and would
 * apply a configured router ID the live router has not applied yet.
 *
 * A lab file imports only the contracts, `../kit.js` and `../templates.js` — never `./index.js`, `../index.js` or the
 * engine barrel — so the catalogue stays an acyclic graph of data modules (rule 12).
 *
 * ponytail (reference solutions): `clear ip ospf process` asks for a confirmation, which `Simulation.configure` refuses
 * in a headless run, so a solution cannot use it. Where a solution must give a running router a new router ID (lab
 * 07, R3) it removes the process and creates it again (`no router ospf 1`, `router ospf 1`): `no router ospf`
 * destroys the process at once, so the new one starts with the configured ID in the same instant, still process 1 as
 * the design says. A learner types `clear ip ospf process`, as the instructions say. Lab 04's solution sets the router
 * ID in the same call that starts the process, so the ID is in place before OSPF first picks one; typed line by line,
 * `clear ip ospf process` applies it (the instructions say so). Lab 03 starts with the three router ports of the shared segment shut, so the priorities
 * are in place before the first election: the reference solution enables all three in one instant.
 */
import type { ScenarioInfo } from '../../../contracts/scenario.js';
import { SEC } from '../../../contracts/time.js';
import { MASK24, MASK30, PC, ROUTER, SERVER, SWITCH, accessPort, cable, configFragmentFault, configText, device, link, section, topology, type ScheduledFault } from '../kit.js';
import { pcConfig } from '../templates.js';

/** The module titles of the lessons these labs belong to (curriculum/ccna3/lessons.ts, §11.1). */
const TOPIC_ROUTERS_THAT_LEARN = 'Routers that learn';
const TOPIC_ONE_AREA = 'One OSPF area';

/** The clock rate every DCE end of a serial line in these labs supplies (bits per second). */
const SERIAL_CLOCK_BPS = 128_000;

/** An interface section: address, extra lines, then `no shutdown` (or `shutdown` when `shut`). */
function routedPort(port: string, address: string, mask: string, extra: readonly string[] = [], shut = false): string[] {
  return section(`interface ${port}`, [`ip address ${address} ${mask}`, ...extra, shut ? 'shutdown' : 'no shutdown']);
}

/** A `router ospf 1` section with its children (§5.1 child order: router-id, auto-cost, passive, network, default). */
function ospfSection(children: readonly string[]): string[] {
  return section('router ospf 1', children);
}

// ── lab 03: the designated router ───────────────────────────────────────────

/** The priorities lab 03 asks for on the shared segment. */
export const DR_ELECTION_PRIORITIES = { R1: 200, R2: 100, R3: 0 } as const;

/** SW1: the three router-facing ports of the shared segment are edge ports. */
function drSwitchConfig(): string {
  return configText([
    ['hostname SW1'],
    accessPort('FastEthernet0/1', 1, { portfast: true }),
    accessPort('FastEthernet0/2', 1, { portfast: true }),
    accessPort('FastEthernet0/3', 1, { portfast: true }),
  ]);
}

/** A router of the segment: its segment port shut, OSPF ready with a fixed router ID over every 10.x network. */
function drRouterConfig(name: string, rid: string, segmentAddress: string, others: readonly string[][], passive: readonly string[]): string {
  return configText([
    [`hostname ${name}`],
    routedPort('GigabitEthernet0/0', segmentAddress, MASK24, [], true),
    ...others,
    ospfSection([`router-id ${rid}`, ...passive.map((p) => `passive-interface ${p}`), 'network 10.0.0.0 0.255.255.255 area 0']),
  ]);
}

/** R1, R2 and R3 on one switched segment (ports shut), R3 joined to R4 by a gigabit link, a host behind R1 and R4. */
export const ccna3OspfDrElection: ScenarioInfo = {
  name: 'ccna3-ospf-dr-election',
  category: 'ccna3-lab',
  labType: 'guided',
  course: 'CCNA 3',
  topic: TOPIC_ROUTERS_THAT_LEARN,
  title: 'Choosing the designated router',
  description:
    'Three routers are about to share a switched segment, and the router that will speak for it should be R1, with R2 as its backup and the small R3 in neither role. Set the priorities before the segment comes up, turn the two-router link to R4 into a point-to-point network, and check what happens when the designated router fails.',
  objectives: [
    'Predict the designated and backup designated router of a shared segment from priorities and router IDs',
    'Steer the election with interface priorities, and keep a router out of it with priority 0',
    'Explain why an election that has finished is not repeated when a better router appears',
    'Run a two-router link as a point-to-point network, without an election or a wait',
  ],
  tags: ['ospf', 'designated router', 'backup designated router', 'priority', 'election', 'point-to-point', 'broadcast network'],
  difficulty: 2,
  estimatedMinutes: 25,
  requires: [PC, ROUTER, SWITCH],
  seed: 303,
  instructions: [
    '## What you have',
    '',
    'R1 (`10.0.123.1`), R2 (`.2`) and R3 (`.3`) are cabled to SW1 with their `GigabitEthernet0/0` ports in the segment `10.0.123.0/24`, but all three ports are still shut. R3 `GigabitEthernet0/1` (`10.0.34.1/30`) is cabled straight to R4 `GigabitEthernet0/0` (`10.0.34.2/30`). PC1 (`10.1.0.10`) sits behind R1 and PC4 (`10.4.0.10`) behind R4.',
    '',
    'OSPF process 1 already runs on every router, in area 0, with the router IDs `1.1.1.1`, `2.2.2.2`, `3.3.3.3` and `4.4.4.4`, and every priority is still the default 1. The host LANs are passive.',
    '',
    '## What to do',
    '',
    '- Predict first: with priority 1 everywhere, which router would become the designated router (DR) of the segment, and which the backup (BDR)? Higher priority wins; on a tie, the higher router ID.',
    `- Before you enable any port of the segment, give \`GigabitEthernet0/0\` the priority ${DR_ELECTION_PRIORITIES.R1} on R1, ${DR_ELECTION_PRIORITIES.R2} on R2 and ${DR_ELECTION_PRIORITIES.R3} on R3 (\`ip ospf priority\`). A router with priority 0 never takes either role.`,
    '- Then enable the three ports (`no shutdown`). Read `show ip ospf neighbor` and `show ip ospf interface` on each router: R1 is DR, R2 is BDR, and R3 is a DROTHER that is fully adjacent to both of them.',
    '- The election does not preempt: once a DR is in place, a router with a higher priority that arrives later does not take over. If the roles come out wrong, shut the three segment ports, check the priorities, and enable them again (or restart OSPF on the three routers with `clear ip ospf process`).',
    '- The R3–R4 link is a broadcast network too, so it waits and elects as well, although only two routers can ever sit on it. Make it a point-to-point network on both ends (`ip ospf network point-to-point`): `show ip ospf neighbor` then shows no DR or BDR on that link.',
    '- Ping PC4 from PC1.',
    '',
    '*Timing: routers take 45 s to boot. When the segment comes up, the election waits 40 s and the first SPF runs 5 s later, so allow about 90 s before the first ping. A point-to-point link brings its routes about 15 s after it comes up: allow about a minute after that change.*',
  ].join('\n'),
  build: () =>
    topology(
      303,
      [
        device('pc1', PC, 'PC1', 60, 140, pcConfig('PC1', '10.1.0.10', MASK24, '10.1.0.1')),
        device(
          'r1',
          ROUTER,
          'R1',
          220,
          140,
          drRouterConfig('R1', '1.1.1.1', '10.0.123.1', [routedPort('GigabitEthernet0/1', '10.1.0.1', MASK24)], ['GigabitEthernet0/1']),
        ),
        device('sw1', SWITCH, 'SW1', 400, 260, drSwitchConfig()),
        device('r2', ROUTER, 'R2', 400, 420, drRouterConfig('R2', '2.2.2.2', '10.0.123.2', [], [])),
        device(
          'r3',
          ROUTER,
          'R3',
          580,
          140,
          drRouterConfig('R3', '3.3.3.3', '10.0.123.3', [routedPort('GigabitEthernet0/1', '10.0.34.1', MASK30)], []),
        ),
        device(
          'r4',
          ROUTER,
          'R4',
          760,
          140,
          configText([
            ['hostname R4'],
            routedPort('GigabitEthernet0/0', '10.0.34.2', MASK30),
            routedPort('GigabitEthernet0/1', '10.4.0.1', MASK24),
            ospfSection(['router-id 4.4.4.4', 'passive-interface GigabitEthernet0/1', 'network 10.0.0.0 0.255.255.255 area 0']),
          ]),
        ),
        device('pc4', PC, 'PC4', 920, 140, pcConfig('PC4', '10.4.0.10', MASK24, '10.4.0.1')),
      ],
      [
        link('l_pc1_r1', 'pc1', 'GigabitEthernet0', 'r1', 'GigabitEthernet0/1'),
        link('l_r1_sw1', 'r1', 'GigabitEthernet0/0', 'sw1', 'FastEthernet0/1'),
        link('l_r2_sw1', 'r2', 'GigabitEthernet0/0', 'sw1', 'FastEthernet0/2'),
        link('l_r3_sw1', 'r3', 'GigabitEthernet0/0', 'sw1', 'FastEthernet0/3'),
        link('l_r3_r4', 'r3', 'GigabitEthernet0/1', 'r4', 'GigabitEthernet0/0'),
        link('l_r4_pc4', 'r4', 'GigabitEthernet0/1', 'pc4', 'GigabitEthernet0'),
      ],
      ['Make R1 the designated router and R2 its backup', 'Keep R3 out of the election', 'Run the R3–R4 link as point-to-point', 'Reach PC4 from PC1'],
      'On a shared segment every router becomes fully adjacent only to the designated router and its backup; the others stay in two-way state with each other. The election runs once and is never repeated just because a better router arrives.',
      { profile: 'P3' },
    ),
  tasks: [
    {
      id: 'priorities',
      title: 'Set the priorities of the segment',
      description: `GigabitEthernet0/0 has priority ${DR_ELECTION_PRIORITIES.R1} on R1, ${DR_ELECTION_PRIORITIES.R2} on R2 and ${DR_ELECTION_PRIORITIES.R3} on R3.`,
      points: 20,
      hint: 'The priority is an interface setting, so it can differ from one segment to the next on the same router.',
      assertions: [
        { kind: 'fact', device: 'R1', fact: 'ospf.ifacePriority', subject: 'GigabitEthernet0/0', equals: DR_ELECTION_PRIORITIES.R1 },
        { kind: 'fact', device: 'R2', fact: 'ospf.ifacePriority', subject: 'GigabitEthernet0/0', equals: DR_ELECTION_PRIORITIES.R2 },
        {
          kind: 'fact',
          device: 'R3',
          fact: 'ospf.ifacePriority',
          subject: 'GigabitEthernet0/0',
          equals: DR_ELECTION_PRIORITIES.R3,
          feedback: 'Only priority 0 keeps a router out of both roles; a low priority still lets it become the backup.',
        },
      ],
      feedbackOnFail: 'Set the priorities before the segment comes up: the election uses what each router announces when it runs.',
    },
    {
      id: 'elected',
      title: 'R1 is the DR, R2 the BDR',
      description: 'On the segment R1 is the designated router, R2 the backup and R3 a DROTHER, and R3 is fully adjacent to both R1 and R2.',
      points: 25,
      dependsOn: ['priorities'],
      hint: 'If R3 or R2 took a role first, the election will not hand it to R1 on its own: restart the segment.',
      assertions: [
        { kind: 'fact', device: 'R1', fact: 'ospf.ifaceState', subject: 'GigabitEthernet0/0', equals: 'dr' },
        { kind: 'fact', device: 'R2', fact: 'ospf.ifaceState', subject: 'GigabitEthernet0/0', equals: 'backup' },
        { kind: 'fact', device: 'R3', fact: 'ospf.ifaceState', subject: 'GigabitEthernet0/0', equals: 'drother' },
        { kind: 'neighbor', device: 'R3', protocol: 'ospf', neighbor: 'R1', iface: 'GigabitEthernet0/0', state: 'full', role: 'dr' },
        { kind: 'neighbor', device: 'R3', protocol: 'ospf', neighbor: 'R2', iface: 'GigabitEthernet0/0', state: 'full', role: 'bdr' },
        { kind: 'neighbor', device: 'R1', protocol: 'ospf', neighbor: 'R3', iface: 'GigabitEthernet0/0', state: 'full', role: 'drother' },
      ],
      feedbackOnFail: 'The election is not preemptive: a router that became DR keeps the role until it fails or the segment restarts.',
    },
    {
      id: 'point-to-point',
      title: 'R3 and R4 run a point-to-point network',
      description: 'R3 GigabitEthernet0/1 and R4 GigabitEthernet0/0 are point-to-point OSPF networks, and the two routers are fully adjacent over them.',
      points: 20,
      hint: 'Change the network type on both ends: two ends that disagree do not build a usable adjacency.',
      assertions: [
        { kind: 'fact', device: 'R3', fact: 'ospf.ifaceNetworkType', subject: 'GigabitEthernet0/1', equals: 'point-to-point' },
        { kind: 'fact', device: 'R4', fact: 'ospf.ifaceNetworkType', subject: 'GigabitEthernet0/0', equals: 'point-to-point' },
        { kind: 'fact', device: 'R3', fact: 'ospf.ifaceState', subject: 'GigabitEthernet0/1', equals: 'point-to-point' },
        { kind: 'neighbor', device: 'R3', protocol: 'ospf', neighbor: 'R4', iface: 'GigabitEthernet0/1', state: 'full' },
        { kind: 'neighbor', device: 'R4', protocol: 'ospf', neighbor: 'R3', iface: 'GigabitEthernet0/0', state: 'full' },
      ],
      feedbackOnFail: 'Only two routers can ever share this link, so a designated router adds nothing but a 40 s wait.',
    },
    {
      id: 'end-to-end',
      title: 'PC1 reaches PC4',
      description: 'R1 reaches the LAN of PC4 through R3 on the segment, and PC1 pings PC4.',
      points: 15,
      dependsOn: ['elected', 'point-to-point'],
      assertions: [
        { kind: 'route', device: 'R1', destination: '10.4.0.10', source: 'O', network: '10.4.0.0/24', nextHop: '10.0.123.3' },
        { kind: 'connectivity', from: 'PC1', to: 'PC4', expect: 'success' },
      ],
      feedbackOnFail: 'Every router learns the routes, whatever its role: R3 is a DROTHER but still forwards for the segment.',
    },
    {
      id: 'dr-fails',
      title: 'The backup takes over',
      description: 'With R1 powered off, R2 becomes the designated router of the segment, R3 stays a DROTHER, and R2 still reaches PC4.',
      points: 20,
      dependsOn: ['elected'],
      hint: 'The routers notice a silent DR only when its dead interval (40 s) runs out.',
      assertions: [
        {
          kind: 'connectivity',
          from: 'R2',
          to: 'PC4',
          expect: 'success',
          after: [{ powerOff: 'R1' }],
          settleMs: 60_000,
          then: [
            { kind: 'fact', device: 'R2', fact: 'ospf.ifaceState', subject: 'GigabitEthernet0/0', equals: 'dr' },
            { kind: 'fact', device: 'R3', fact: 'ospf.ifaceState', subject: 'GigabitEthernet0/0', equals: 'drother' },
          ],
        },
      ],
      feedbackOnFail: 'When the DR fails the BDR takes over at once, and a new backup is elected only among routers whose priority is above 0.',
    },
  ],
  solution: {
    R1: ['interface GigabitEthernet0/0', `ip ospf priority ${DR_ELECTION_PRIORITIES.R1}`, 'no shutdown', 'exit'],
    R2: ['interface GigabitEthernet0/0', `ip ospf priority ${DR_ELECTION_PRIORITIES.R2}`, 'no shutdown', 'exit'],
    R3: [
      'interface GigabitEthernet0/0',
      `ip ospf priority ${DR_ELECTION_PRIORITIES.R3}`,
      'no shutdown',
      'exit',
      'interface GigabitEthernet0/1',
      'ip ospf network point-to-point',
      'exit',
    ],
    R4: ['interface GigabitEthernet0/0', 'ip ospf network point-to-point', 'exit'],
  },
};

// ── lab 04: one area, two ways to switch OSPF on ─────────────────────────────

/** SW1 of lab 04: the two host ports and the port facing R1 are edge ports. */
function singleAreaSwitchConfig(): string {
  return configText([
    ['hostname SW1'],
    accessPort('FastEthernet0/1', 1, { portfast: true }),
    accessPort('FastEthernet0/2', 1, { portfast: true }),
    accessPort('GigabitEthernet0/1', 1, { portfast: true }),
  ]);
}

/** R1 (two LANs) — R2 (the core, OSPF already on) — R3 over a serial line; R1 and R3 run no OSPF yet. */
export const ccna3OspfSingleArea: ScenarioInfo = {
  name: 'ccna3-ospf-single-area',
  category: 'ccna3-lab',
  labType: 'build',
  course: 'CCNA 3',
  topic: TOPIC_ONE_AREA,
  title: 'Switching OSPF on',
  description:
    'R2 already runs OSPF, but the two routers beside it do not. Bring R1 in with network statements and R3 with interface lines, fix both router IDs, keep the hellos off the host LANs, and prove that the three routers share one map of the area.',
  objectives: [
    'Turn OSPF on with network statements and their wildcard masks',
    'Turn OSPF on per interface with an interface line',
    'Fix the router ID, and apply a new one to a running process',
    'Keep hellos off LANs where no router listens, while still advertising them',
    'Read the router and network advertisements every router of the area holds',
  ],
  tags: ['ospf', 'single area', 'network statement', 'wildcard mask', 'router id', 'passive interface', 'lsdb'],
  difficulty: 2,
  estimatedMinutes: 30,
  requires: [PC, ROUTER, SWITCH],
  seed: 304,
  instructions: [
    '## What you have',
    '',
    'PC1 (`192.168.1.11`) and PC2 (`.12`) sit on SW1 in `192.168.1.0/24` behind R1 `GigabitEthernet0/0` (`192.168.1.1`). R1 `GigabitEthernet0/1` (`10.0.12.1/30`) is cabled to R2 `GigabitEthernet0/0` (`10.0.12.2/30`). R2 `Serial0/0/0` (`10.0.23.1/30`, the clocking end) is cabled to R3 `Serial0/0/0` (`10.0.23.2/30`), and PC3 (`192.168.3.10`) sits behind R3 `GigabitEthernet0/0` (`192.168.3.1`).',
    '',
    'R2 already runs OSPF process 1 in area 0 with the router ID `2.2.2.2` on both of its links. R1 and R3 run no routing protocol yet.',
    '',
    '## What to do',
    '',
    '- On R1, start OSPF process 1 and give it the router ID `1.1.1.1` first. Then add network statements in area 0 for its two networks (`network 10.0.12.0 0.0.0.3 area 0` is one).',
    '- On R3, start OSPF process 1 with the router ID `3.3.3.3`, but add no network statement: switch OSPF on in each interface instead (`ip ospf 1 area 0` on `Serial0/0/0` and `GigabitEthernet0/0`).',
    '- A router picks its ID as soon as the process starts. If `show ip protocols` shows another ID than the one you typed, apply yours with `clear ip ospf process` (answer yes).',
    '- No router listens on the two host LANs, so make R1 `GigabitEthernet0/0` and R3 `GigabitEthernet0/0` passive (`passive-interface`). A passive LAN sends no hello but is still advertised.',
    '- Compare `show ip ospf database` on the three routers: each holds one router advertisement per router, and the R1–R2 link, a broadcast network, also has a network advertisement from its designated router.',
    '- Ping PC3 from PC1 and from PC2.',
    '',
    '*Timing: routers take 45 s to boot. The R1–R2 link is a broadcast network, which waits 40 s before its election and runs its first SPF 5 s later, so allow about 90 s before the first ping. The serial link is point-to-point and brings its routes about 15 s after it comes up: about a minute.*',
  ].join('\n'),
  build: () =>
    topology(
      304,
      [
        device('pc1', PC, 'PC1', 60, 140, pcConfig('PC1', '192.168.1.11', MASK24, '192.168.1.1')),
        device('pc2', PC, 'PC2', 60, 340, pcConfig('PC2', '192.168.1.12', MASK24, '192.168.1.1')),
        device('sw1', SWITCH, 'SW1', 200, 240, singleAreaSwitchConfig()),
        device(
          'r1',
          ROUTER,
          'R1',
          360,
          240,
          configText([['hostname R1'], routedPort('GigabitEthernet0/0', '192.168.1.1', MASK24), routedPort('GigabitEthernet0/1', '10.0.12.1', MASK30)]),
        ),
        device(
          'r2',
          ROUTER,
          'R2',
          540,
          240,
          configText([
            ['hostname R2'],
            routedPort('GigabitEthernet0/0', '10.0.12.2', MASK30),
            routedPort('Serial0/0/0', '10.0.23.1', MASK30, [`clock rate ${SERIAL_CLOCK_BPS}`]),
            ospfSection(['router-id 2.2.2.2', 'network 10.0.12.0 0.0.0.3 area 0', 'network 10.0.23.0 0.0.0.3 area 0']),
          ]),
        ),
        device(
          'r3',
          ROUTER,
          'R3',
          720,
          240,
          configText([['hostname R3'], routedPort('Serial0/0/0', '10.0.23.2', MASK30), routedPort('GigabitEthernet0/0', '192.168.3.1', MASK24)]),
        ),
        device('pc3', PC, 'PC3', 880, 240, pcConfig('PC3', '192.168.3.10', MASK24, '192.168.3.1')),
      ],
      [
        link('l_pc1_sw1', 'pc1', 'GigabitEthernet0', 'sw1', 'FastEthernet0/1'),
        link('l_pc2_sw1', 'pc2', 'GigabitEthernet0', 'sw1', 'FastEthernet0/2'),
        link('l_sw1_r1', 'sw1', 'GigabitEthernet0/1', 'r1', 'GigabitEthernet0/0'),
        link('l_r1_r2', 'r1', 'GigabitEthernet0/1', 'r2', 'GigabitEthernet0/0'),
        cable('l_r2_r3', 'r2', 'Serial0/0/0', 'r3', 'Serial0/0/0', 'serial-dce'),
        link('l_r3_pc3', 'r3', 'GigabitEthernet0/0', 'pc3', 'GigabitEthernet0'),
      ],
      ['Bring R1 into OSPF with network statements', 'Bring R3 into OSPF with interface lines', 'Fix both router IDs', 'Keep hellos off the host LANs', 'Reach PC3 from both PCs'],
      'Two ways switch OSPF on for an interface: a network statement matches its address with a wildcard mask, an interface line names the area directly. Either way the interface is advertised; passive only stops the hellos.',
      { profile: 'P3' },
    ),
  tasks: [
    {
      id: 'r1-network-statements',
      title: 'R1 runs OSPF with network statements',
      description: 'R1 runs OSPF on both of its networks in area 0 through network statements, and is fully adjacent to R2.',
      points: 20,
      hint: 'A wildcard mask is the inverse of the subnet mask: /30 is 0.0.0.3, /24 is 0.0.0.255.',
      assertions: [
        { kind: 'config', device: 'R1', path: 'router.ospf.network', exists: true },
        // `.ip.ospf.1` matches only an `ip ospf 1 area …` line, never `ip ospf cost` / `priority` / `hello-interval`.
        { kind: 'config', device: 'R1', path: 'interface.GigabitEthernet0/0.ip.ospf.1', exists: false, feedback: 'R1 should switch OSPF on with network statements only.' },
        { kind: 'config', device: 'R1', path: 'interface.GigabitEthernet0/1.ip.ospf.1', exists: false, feedback: 'R1 should switch OSPF on with network statements only.' },
        { kind: 'fact', device: 'R1', fact: 'ospf.ifaceArea', subject: 'GigabitEthernet0/0', equals: '0.0.0.0' },
        { kind: 'fact', device: 'R1', fact: 'ospf.ifaceArea', subject: 'GigabitEthernet0/1', equals: '0.0.0.0' },
        { kind: 'neighbor', device: 'R1', protocol: 'ospf', neighbor: 'R2', iface: 'GigabitEthernet0/1', state: 'full' },
      ],
      feedbackOnFail: 'A network statement switches OSPF on for every interface whose address it matches, in the area it names.',
    },
    {
      id: 'r3-interface-lines',
      title: 'R3 runs OSPF with interface lines',
      description: 'R3 runs OSPF on Serial0/0/0 and GigabitEthernet0/0 in area 0 without any network statement, and is fully adjacent to R2.',
      points: 20,
      hint: 'Under the interface, `ip ospf 1 area 0` names the process and the area; the process itself still has to exist.',
      assertions: [
        { kind: 'config', device: 'R3', path: 'router.ospf', exists: true },
        { kind: 'config', device: 'R3', path: 'router.ospf.network', exists: false, feedback: 'R3 should switch OSPF on per interface, without network statements.' },
        { kind: 'fact', device: 'R3', fact: 'ospf.ifaceArea', subject: 'Serial0/0/0', equals: '0.0.0.0' },
        { kind: 'fact', device: 'R3', fact: 'ospf.ifaceArea', subject: 'GigabitEthernet0/0', equals: '0.0.0.0' },
        { kind: 'neighbor', device: 'R3', protocol: 'ospf', neighbor: 'R2', iface: 'Serial0/0/0', state: 'full' },
      ],
      feedbackOnFail: 'An interface line wins over any network statement for that interface, so each interface says exactly which area it is in.',
    },
    {
      id: 'router-ids',
      title: 'Both router IDs are fixed',
      description: 'R1 uses the router ID 1.1.1.1 and R3 uses 3.3.3.3 — the IDs in use, not only the configured ones.',
      points: 20,
      hint: '`show ip protocols` names the router ID in use. A new ID typed after the process started waits for `clear ip ospf process`.',
      assertions: [
        { kind: 'fact', device: 'R1', fact: 'ospf.routerId', equals: '1.1.1.1', misconception: 'router-id-applies-at-once' },
        { kind: 'fact', device: 'R3', fact: 'ospf.routerId', equals: '3.3.3.3', misconception: 'router-id-applies-at-once' },
      ],
      feedbackOnFail: 'Without a router-id line a router takes the highest address of a loopback, else of any interface that is up — and keeps it until the process restarts.',
    },
    {
      id: 'passive-lans',
      title: 'The host LANs are passive but advertised',
      description: 'R1 GigabitEthernet0/0 and R3 GigabitEthernet0/0 are passive, and each router still has an OSPF route to the LAN of the other.',
      points: 20,
      hint: 'Passive is set under the routing process, by interface name.',
      assertions: [
        { kind: 'fact', device: 'R1', fact: 'ospf.passive', subject: 'GigabitEthernet0/0', equals: true },
        { kind: 'fact', device: 'R3', fact: 'ospf.passive', subject: 'GigabitEthernet0/0', equals: true },
        { kind: 'route', device: 'R1', destination: '192.168.3.10', source: 'O', network: '192.168.3.0/24' },
        { kind: 'route', device: 'R3', destination: '192.168.1.11', source: 'O', network: '192.168.1.0/24' },
      ],
      feedbackOnFail: 'A passive interface is still part of OSPF: it simply sends no hello and forms no neighbour.',
    },
    {
      id: 'one-map',
      title: 'One map, and a path across it',
      description: 'R1 holds the same database as every other router of area 0 — three router advertisements and the network advertisement of the R1–R2 link — and PC1 and PC2 reach PC3.',
      points: 20,
      dependsOn: ['r1-network-statements', 'r3-interface-lines', 'passive-lans'],
      assertions: [
        { kind: 'fact', device: 'R1', fact: 'ospf.lsdbSynced', subject: '0.0.0.0', equals: true },
        { kind: 'table', device: 'R1', table: 'ospf-lsdb', where: { type: 1 }, exists: true, minCount: 3 },
        { kind: 'table', device: 'R1', table: 'ospf-lsdb', where: { type: 2 }, exists: true },
        { kind: 'connectivity', from: 'PC1', to: 'PC3', expect: 'success' },
        { kind: 'connectivity', from: 'PC2', to: 'PC3', expect: 'success' },
      ],
      feedbackOnFail: 'Every router of an area holds the same advertisements and runs SPF on them; only the root of the tree differs.',
    },
  ],
  solution: {
    R1: [
      'router ospf 1',
      'router-id 1.1.1.1',
      'passive-interface GigabitEthernet0/0',
      'network 192.168.1.0 0.0.0.255 area 0',
      'network 10.0.12.0 0.0.0.3 area 0',
      'exit',
    ],
    R3: [
      'router ospf 1',
      'router-id 3.3.3.3',
      'passive-interface GigabitEthernet0/0',
      'exit',
      'interface Serial0/0/0',
      'ip ospf 1 area 0',
      'exit',
      'interface GigabitEthernet0/0',
      'ip ospf 1 area 0',
      'exit',
    ],
  },
};

// ── lab 05: cost and the best path ──────────────────────────────────────────

/** The reference bandwidth lab 05 asks for (Mb/s), the bandwidth of the carrier circuit (kb/s), and the serial cost that equals the two paths. */
export const OSPF_COST_REFERENCE_MBPS = 1000;
export const OSPF_COST_CIRCUIT_KBPS = 100_000;
export const OSPF_COST_SERIAL = 11;

/** A router of the triangle: the given ports, OSPF with a fixed ID over 10.x, its host LAN passive. */
function costRouterConfig(name: string, rid: string, ports: readonly string[][], passive: string | undefined): string {
  return configText([
    [`hostname ${name}`],
    ...ports,
    ospfSection([`router-id ${rid}`, ...(passive === undefined ? [] : [`passive-interface ${passive}`]), 'network 10.0.0.0 0.255.255.255 area 0']),
  ]);
}

/** R1 and R3 joined twice: over R2 (two gigabit point-to-point hops) and straight over a serial line. */
export const ccna3OspfCost: ScenarioInfo = {
  name: 'ccna3-ospf-cost',
  category: 'ccna3-lab',
  labType: 'build',
  course: 'CCNA 3',
  topic: TOPIC_ONE_AREA,
  title: 'Cost and the best path',
  description:
    'R1 reaches R3 over two gigabit hops through R2 or straight over a serial line, and OSPF sends everything through R2. Make the costs tell the truth about the links, then choose the serial cost that lets OSPF share the load over both paths.',
  objectives: [
    'Work out an interface cost from its bandwidth and the reference bandwidth',
    'Raise the reference bandwidth on every router of an area',
    'Declare the real bandwidth of a link that runs slower than its port',
    'Set a cost directly and predict which path or paths a router installs',
  ],
  tags: ['ospf', 'cost', 'reference bandwidth', 'bandwidth', 'equal-cost paths', 'load sharing', 'metric'],
  difficulty: 3,
  estimatedMinutes: 25,
  requires: [PC, ROUTER],
  seed: 305,
  instructions: [
    '## What you have',
    '',
    'PC1 (`10.1.0.10`) sits behind R1 and PC3 (`10.3.0.10`) behind R3; both host LANs are `/24` and passive. R1 `GigabitEthernet0/0` (`10.0.12.1/30`) is cabled to R2 `GigabitEthernet0/0` (`.2`), and R2 `GigabitEthernet0/1` (`10.0.23.1/30`) to R3 `GigabitEthernet0/0` (`.2`); both links run as point-to-point networks. R1 `Serial0/0/0` (`10.0.13.1/30`, the clocking end) is cabled to R3 `Serial0/0/0` (`.2`).',
    '',
    'All three routers run OSPF process 1 in area 0. The R2–R3 link is a gigabit port on both ends, but behind it runs a carrier circuit of only 100 Mb/s.',
    '',
    '## What to do',
    '',
    '- Read the costs with `show ip ospf interface brief`. Cost = reference bandwidth ÷ interface bandwidth, never less than 1. With the default reference of 100 Mb/s every port of 100 Mb/s or faster costs 1, and a serial port counts as 1544 kb/s (cost 64), whatever clock rate the line runs at.',
    `- On all three routers, raise the reference bandwidth to ${OSPF_COST_REFERENCE_MBPS} Mb/s (\`auto-cost reference-bandwidth ${OSPF_COST_REFERENCE_MBPS}\`). Every router of the area must use the same reference, or their costs stop being comparable.`,
    `- Tell OSPF the real speed of the carrier circuit: \`bandwidth ${OSPF_COST_CIRCUIT_KBPS}\` (kb/s) on R2 \`GigabitEthernet0/1\` and on R3 \`GigabitEthernet0/0\`. Work out the new cost of those two ports.`,
    '- Add up the cost of the path from R1 to the LAN of R3 through R2 (the LAN itself adds the cost of R3 `GigabitEthernet0/1`). Then give the serial line, on both ends, the cost (`ip ospf cost`) that makes the direct path exactly as expensive.',
    '- `show ip route ospf` on R1 and R3 now lists two paths to the LAN at the other end. Ping PC3 from PC1.',
    '',
    '*Timing: routers take 45 s to boot, and every link here is point-to-point, so the routes come about 15 s after a link comes up: about a minute before the first ping. A cost change reaches the routing tables 5 to 15 s after you type it.*',
  ].join('\n'),
  build: () =>
    topology(
      305,
      [
        device('pc1', PC, 'PC1', 60, 300, pcConfig('PC1', '10.1.0.10', MASK24, '10.1.0.1')),
        device(
          'r1',
          ROUTER,
          'R1',
          240,
          300,
          costRouterConfig(
            'R1',
            '1.1.1.1',
            [
              routedPort('GigabitEthernet0/0', '10.0.12.1', MASK30, ['ip ospf network point-to-point']),
              routedPort('GigabitEthernet0/1', '10.1.0.1', MASK24),
              routedPort('Serial0/0/0', '10.0.13.1', MASK30, [`clock rate ${SERIAL_CLOCK_BPS}`]),
            ],
            'GigabitEthernet0/1',
          ),
        ),
        device(
          'r2',
          ROUTER,
          'R2',
          440,
          120,
          costRouterConfig(
            'R2',
            '2.2.2.2',
            [
              routedPort('GigabitEthernet0/0', '10.0.12.2', MASK30, ['ip ospf network point-to-point']),
              routedPort('GigabitEthernet0/1', '10.0.23.1', MASK30, ['ip ospf network point-to-point']),
            ],
            undefined,
          ),
        ),
        device(
          'r3',
          ROUTER,
          'R3',
          640,
          300,
          costRouterConfig(
            'R3',
            '3.3.3.3',
            [
              routedPort('GigabitEthernet0/0', '10.0.23.2', MASK30, ['ip ospf network point-to-point']),
              routedPort('GigabitEthernet0/1', '10.3.0.1', MASK24),
              routedPort('Serial0/0/0', '10.0.13.2', MASK30),
            ],
            'GigabitEthernet0/1',
          ),
        ),
        device('pc3', PC, 'PC3', 820, 300, pcConfig('PC3', '10.3.0.10', MASK24, '10.3.0.1')),
      ],
      [
        link('l_pc1_r1', 'pc1', 'GigabitEthernet0', 'r1', 'GigabitEthernet0/1'),
        link('l_r1_r2', 'r1', 'GigabitEthernet0/0', 'r2', 'GigabitEthernet0/0'),
        link('l_r2_r3', 'r2', 'GigabitEthernet0/1', 'r3', 'GigabitEthernet0/0'),
        cable('l_r1_r3', 'r1', 'Serial0/0/0', 'r3', 'Serial0/0/0', 'serial-dce'),
        link('l_r3_pc3', 'r3', 'GigabitEthernet0/1', 'pc3', 'GigabitEthernet0'),
      ],
      ['Raise the reference bandwidth everywhere', 'Declare the speed of the carrier circuit', 'Make both paths cost the same', 'Keep PC3 reachable when a path fails'],
      'OSPF adds up the cost of every outgoing interface along a path and installs the cheapest; paths that tie are all installed, and the traffic is shared between them.',
      { profile: 'P3' },
    ),
  tasks: [
    {
      id: 'reference-bandwidth',
      title: 'One reference bandwidth for the whole area',
      description: `R1, R2 and R3 use the reference bandwidth ${OSPF_COST_REFERENCE_MBPS} Mb/s, so a gigabit port costs 1 (and a serial port 647, until you give it a cost of its own).`,
      points: 25,
      hint: 'For the serial port: 1 000 000 kb/s ÷ 1544 kb/s, rounded down.',
      assertions: [
        { kind: 'fact', device: 'R1', fact: 'ospf.referenceBandwidthMbps', equals: OSPF_COST_REFERENCE_MBPS },
        { kind: 'fact', device: 'R2', fact: 'ospf.referenceBandwidthMbps', equals: OSPF_COST_REFERENCE_MBPS },
        { kind: 'fact', device: 'R3', fact: 'ospf.referenceBandwidthMbps', equals: OSPF_COST_REFERENCE_MBPS, feedback: 'The reference must be the same on every router of the area.' },
        { kind: 'fact', device: 'R1', fact: 'ospf.ifaceCost', subject: 'GigabitEthernet0/0', equals: 1 },
        { kind: 'fact', device: 'R2', fact: 'ospf.ifaceCost', subject: 'GigabitEthernet0/0', equals: 1 },
      ],
      feedbackOnFail: 'With a reference of 100 Mb/s a gigabit port and a 100 Mb/s port both cost 1, so OSPF cannot tell them apart.',
    },
    {
      id: 'circuit-bandwidth',
      title: 'The carrier circuit costs what it is worth',
      description: `R2 GigabitEthernet0/1 and R3 GigabitEthernet0/0 declare ${OSPF_COST_CIRCUIT_KBPS} kb/s and cost 10.`,
      points: 20,
      hint: '`bandwidth` is in kilobits per second and changes no speed: it only tells OSPF what to count.',
      assertions: [
        { kind: 'config', device: 'R2', path: 'interface.GigabitEthernet0/1.bandwidth', equals: String(OSPF_COST_CIRCUIT_KBPS) },
        { kind: 'config', device: 'R3', path: 'interface.GigabitEthernet0/0.bandwidth', equals: String(OSPF_COST_CIRCUIT_KBPS) },
        { kind: 'fact', device: 'R2', fact: 'ospf.ifaceCost', subject: 'GigabitEthernet0/1', equals: 10 },
        { kind: 'fact', device: 'R3', fact: 'ospf.ifaceCost', subject: 'GigabitEthernet0/0', equals: 10 },
      ],
      feedbackOnFail: 'Each router counts the cost of its own outgoing interface, so both ends of the circuit need the bandwidth line.',
    },
    {
      id: 'equal-cost',
      title: 'Two equal paths',
      description: `The serial line costs ${OSPF_COST_SERIAL} on both ends, and R1 and R3 each reach the LAN of the other over two equal-cost paths of cost ${OSPF_COST_SERIAL + 1}.`,
      points: 30,
      dependsOn: ['reference-bandwidth', 'circuit-bandwidth'],
      hint: 'Through R2: 1 (R1 to R2) + 10 (R2 to R3) + 1 (the LAN). Straight: the serial cost + 1 (the LAN).',
      assertions: [
        { kind: 'fact', device: 'R1', fact: 'ospf.ifaceCost', subject: 'Serial0/0/0', equals: OSPF_COST_SERIAL },
        { kind: 'fact', device: 'R3', fact: 'ospf.ifaceCost', subject: 'Serial0/0/0', equals: OSPF_COST_SERIAL },
        { kind: 'route', device: 'R1', destination: '10.3.0.10', source: 'O', network: '10.3.0.0/24', metric: OSPF_COST_SERIAL + 1, minPaths: 2 },
        { kind: 'route', device: 'R3', destination: '10.1.0.10', source: 'O', network: '10.1.0.0/24', metric: OSPF_COST_SERIAL + 1, minPaths: 2, misconception: 'cost-counted-on-one-end' },
        { kind: 'connectivity', from: 'PC1', to: 'PC3', expect: 'success' },
      ],
      feedbackOnFail: 'Only paths whose total costs are exactly equal are installed side by side; one point of difference leaves a single path.',
    },
    {
      id: 'lose-a-path',
      title: 'The serial line carries on alone',
      description: `When the R2–R3 circuit fails, PC1 still reaches PC3, and R1 then sends everything over the serial line at cost ${OSPF_COST_SERIAL + 1}.`,
      points: 25,
      dependsOn: ['equal-cost'],
      assertions: [
        // The live state before the cut: both paths are installed (dependsOn is metadata, never graded).
        { kind: 'route', device: 'R1', destination: '10.3.0.10', source: 'O', network: '10.3.0.0/24', metric: OSPF_COST_SERIAL + 1, minPaths: 2, feedback: 'Before the cut, R1 must already hold both equal-cost paths to PC3.' },
        {
          kind: 'connectivity',
          from: 'PC1',
          to: 'PC3',
          expect: 'success',
          after: [{ cut: { a: 'R2', b: 'R3' } }],
          then: [{ kind: 'route', device: 'R1', destination: '10.3.0.10', source: 'O', nextHop: '10.0.13.2', iface: 'Serial0/0/0', metric: OSPF_COST_SERIAL + 1 }],
        },
      ],
      feedbackOnFail: 'Both paths were already installed, so losing one leaves the other in place with the cost you gave it.',
    },
  ],
  solution: {
    R1: ['router ospf 1', `auto-cost reference-bandwidth ${OSPF_COST_REFERENCE_MBPS}`, 'exit', 'interface Serial0/0/0', `ip ospf cost ${OSPF_COST_SERIAL}`, 'exit'],
    R2: ['router ospf 1', `auto-cost reference-bandwidth ${OSPF_COST_REFERENCE_MBPS}`, 'exit', 'interface GigabitEthernet0/1', `bandwidth ${OSPF_COST_CIRCUIT_KBPS}`, 'exit'],
    R3: [
      'router ospf 1',
      `auto-cost reference-bandwidth ${OSPF_COST_REFERENCE_MBPS}`,
      'exit',
      'interface GigabitEthernet0/0',
      `bandwidth ${OSPF_COST_CIRCUIT_KBPS}`,
      'exit',
      'interface Serial0/0/0',
      `ip ospf cost ${OSPF_COST_SERIAL}`,
      'exit',
    ],
  },
};

// ── lab 06: a default route and the hello timers ────────────────────────────

/** The hello interval R1 was tuned to on its link to R2, and the dead interval that follows from it (4 × hello). */
export const OSPF_DEFAULT_LAB_HELLO_S = 5;
export const OSPF_DEFAULT_LAB_DEAD_S = 20;

/** The provider's server every host should reach. */
export const OSPF_DEFAULT_LAB_SERVER = '203.0.113.10';

/** An internal router of lab 06: its link to R1, its host LAN (passive), OSPF with a fixed ID. */
function defaultLabInternalConfig(name: string, rid: string, uplink: string[], lan: string): string {
  return configText([
    [`hostname ${name}`],
    uplink,
    routedPort('GigabitEthernet0/1', lan, MASK24),
    ospfSection([`router-id ${rid}`, 'passive-interface GigabitEthernet0/1', 'network 10.0.0.0 0.255.255.255 area 0']),
  ]);
}

/** R1 at the edge (a static default toward ISP), R2 and R3 inside with a host each; ISP runs no OSPF. */
export const ccna3OspfDefaultRoute: ScenarioInfo = {
  name: 'ccna3-ospf-default-route',
  category: 'ccna3-lab',
  labType: 'build',
  course: 'CCNA 3',
  topic: TOPIC_ONE_AREA,
  title: 'A way out for the whole area',
  description:
    'R1 knows the way to the provider, but nobody else in the area does, and R2 does not even peer with R1 since a change to its hello timer. Match the timers on the R1–R2 link, then let R1 advertise its default route into OSPF so both hosts reach the provider\'s server.',
  objectives: [
    'Explain why two neighbours with different hello or dead intervals never become adjacent',
    'Match the hello and dead intervals on both ends of a link',
    'Advertise an edge router\'s default route into OSPF',
    'Read an external type-2 route and its cost on the other routers',
  ],
  tags: ['ospf', 'default route', 'default-information originate', 'external route', 'hello interval', 'dead interval', 'timers'],
  difficulty: 2,
  estimatedMinutes: 25,
  requires: [PC, ROUTER, SERVER],
  seed: 306,
  instructions: [
    '## What you have',
    '',
    `R1 is the edge router: \`GigabitEthernet0/0\` (\`198.51.100.1/30\`) leads to the provider router ISP (\`198.51.100.2\`), behind which the server SRV answers at \`${OSPF_DEFAULT_LAB_SERVER}\`. R1 holds a static default route to ISP; ISP runs no OSPF and routes \`10.0.0.0/8\` back to R1.`,
    '',
    'Inside, R1 `GigabitEthernet0/1` (`10.0.12.1/30`) is cabled to R2 `GigabitEthernet0/0` (`.2`), a point-to-point network, and R1 `Serial0/0/0` (`10.0.13.1/30`, the clocking end) to R3 `Serial0/0/0` (`.2`). PC2 (`10.2.0.10`) sits behind R2 and PC3 (`10.3.0.10`) behind R3. R1, R2 and R3 run OSPF process 1 in area 0 with the router IDs `1.1.1.1`, `2.2.2.2` and `3.3.3.3`.',
    '',
    `To notice a failure sooner, R1 \`GigabitEthernet0/1\` was set to send a hello every ${OSPF_DEFAULT_LAB_HELLO_S} s, which also shortens its dead interval to ${OSPF_DEFAULT_LAB_DEAD_S} s (four hellos). R2 was not changed.`,
    '',
    '## What to do',
    '',
    '- Read `show ip ospf neighbor` on R1 and R2, then `show ip ospf interface` on both ends of the link: the hello and dead intervals differ, so each router refuses the hellos of the other and they never become neighbours.',
    `- Finish the change: R2 \`GigabitEthernet0/0\` sends a hello every ${OSPF_DEFAULT_LAB_HELLO_S} s too (\`ip ospf hello-interval ${OSPF_DEFAULT_LAB_HELLO_S}\`), so both ends agree on ${OSPF_DEFAULT_LAB_HELLO_S} s and ${OSPF_DEFAULT_LAB_DEAD_S} s.`,
    '- On R1, advertise the default route into OSPF with `default-information originate` (without `always`: R1 should advertise it only while it has one itself).',
    '- On R2 and R3, `show ip route` now shows the default as an external route (`O*E2`). An external type-2 route keeps the cost R1 gave it (1), however far away R1 is.',
    `- Ping SRV (\`${OSPF_DEFAULT_LAB_SERVER}\`) from PC2 and from PC3.`,
    '',
    '*Timing: routers take 45 s to boot, and every OSPF link here is point-to-point, so the routes come about 15 s after a link comes up: about a minute before the first ping.*',
  ].join('\n'),
  build: () =>
    topology(
      306,
      [
        device('srv', SERVER, 'SRV', 60, 120, pcConfig('SRV', OSPF_DEFAULT_LAB_SERVER, MASK24, '203.0.113.1')),
        device(
          'isp',
          ROUTER,
          'ISP',
          220,
          120,
          configText([
            ['hostname ISP'],
            routedPort('GigabitEthernet0/0', '198.51.100.2', MASK30),
            routedPort('GigabitEthernet0/1', '203.0.113.1', MASK24),
            ['ip route 10.0.0.0 255.0.0.0 198.51.100.1'],
          ]),
        ),
        device(
          'r1',
          ROUTER,
          'R1',
          420,
          120,
          configText([
            ['hostname R1'],
            routedPort('GigabitEthernet0/0', '198.51.100.1', MASK30),
            routedPort('GigabitEthernet0/1', '10.0.12.1', MASK30, ['ip ospf network point-to-point', `ip ospf hello-interval ${OSPF_DEFAULT_LAB_HELLO_S}`]),
            routedPort('Serial0/0/0', '10.0.13.1', MASK30, [`clock rate ${SERIAL_CLOCK_BPS}`]),
            ospfSection(['router-id 1.1.1.1', 'network 10.0.0.0 0.255.255.255 area 0']),
            ['ip route 0.0.0.0 0.0.0.0 198.51.100.2'],
          ]),
        ),
        device(
          'r2',
          ROUTER,
          'R2',
          600,
          40,
          defaultLabInternalConfig('R2', '2.2.2.2', routedPort('GigabitEthernet0/0', '10.0.12.2', MASK30, ['ip ospf network point-to-point']), '10.2.0.1'),
        ),
        device('r3', ROUTER, 'R3', 600, 260, defaultLabInternalConfig('R3', '3.3.3.3', routedPort('Serial0/0/0', '10.0.13.2', MASK30), '10.3.0.1')),
        device('pc2', PC, 'PC2', 780, 40, pcConfig('PC2', '10.2.0.10', MASK24, '10.2.0.1')),
        device('pc3', PC, 'PC3', 780, 260, pcConfig('PC3', '10.3.0.10', MASK24, '10.3.0.1')),
      ],
      [
        link('l_srv_isp', 'srv', 'GigabitEthernet0', 'isp', 'GigabitEthernet0/1'),
        link('l_isp_r1', 'isp', 'GigabitEthernet0/0', 'r1', 'GigabitEthernet0/0'),
        link('l_r1_r2', 'r1', 'GigabitEthernet0/1', 'r2', 'GigabitEthernet0/0'),
        cable('l_r1_r3', 'r1', 'Serial0/0/0', 'r3', 'Serial0/0/0', 'serial-dce'),
        link('l_r2_pc2', 'r2', 'GigabitEthernet0/1', 'pc2', 'GigabitEthernet0'),
        link('l_r3_pc3', 'r3', 'GigabitEthernet0/1', 'pc3', 'GigabitEthernet0'),
      ],
      ['Match the hello and dead intervals of R1 and R2', 'Advertise R1\'s default route into OSPF', 'Give every router the way out', 'Reach the provider\'s server from both hosts'],
      'Neighbours must agree on their hello and dead intervals before anything else happens. A default route learned from outside OSPF enters the area only when the edge router is told to advertise it.',
      { profile: 'P3' },
    ),
  tasks: [
    {
      id: 'matching-timers',
      title: 'R1 and R2 agree on their timers',
      description: `Both ends of the R1–R2 link send a hello every ${OSPF_DEFAULT_LAB_HELLO_S} s with a dead interval of ${OSPF_DEFAULT_LAB_DEAD_S} s, and R1 and R2 are fully adjacent.`,
      points: 25,
      hint: 'Without a dead-interval line, the dead interval follows the hello interval: four times as long.',
      assertions: [
        { kind: 'table', device: 'R1', table: 'ospf-interfaces', where: { port: 'GigabitEthernet0/1', helloS: OSPF_DEFAULT_LAB_HELLO_S, deadS: OSPF_DEFAULT_LAB_DEAD_S }, exists: true },
        { kind: 'table', device: 'R2', table: 'ospf-interfaces', where: { port: 'GigabitEthernet0/0', helloS: OSPF_DEFAULT_LAB_HELLO_S, deadS: OSPF_DEFAULT_LAB_DEAD_S }, exists: true },
        { kind: 'neighbor', device: 'R1', protocol: 'ospf', neighbor: 'R2', iface: 'GigabitEthernet0/1', state: 'full' },
        { kind: 'neighbor', device: 'R2', protocol: 'ospf', neighbor: 'R1', iface: 'GigabitEthernet0/0', state: 'full' },
      ],
      feedbackOnFail: 'A hello that carries other intervals than the receiving interface is refused, so no neighbour is ever created.',
    },
    {
      id: 'originate-default',
      title: 'R1 advertises its default route',
      description: 'R1 advertises the default route into OSPF while it holds one (an external advertisement for 0.0.0.0).',
      points: 25,
      hint: 'The command lives under the routing process. `always` would advertise the default even with no way out.',
      assertions: [
        { kind: 'fact', device: 'R1', fact: 'ospf.defaultOriginate', equals: 'on', feedback: 'Advertise the default only while R1 has one: no `always`.' },
        { kind: 'table', device: 'R1', table: 'ospf-lsdb', where: { type: 5, lsid: '0.0.0.0', advRouter: '1.1.1.1' }, exists: true },
      ],
      feedbackOnFail: 'A static route is not part of OSPF until the router is told to advertise it.',
    },
    {
      id: 'default-everywhere',
      title: 'R2 and R3 know the way out',
      description: 'R2 and R3 reach the provider through an external type-2 default route of cost 1 learned from R1.',
      points: 25,
      dependsOn: ['matching-timers', 'originate-default'],
      assertions: [
        { kind: 'route', device: 'R2', destination: OSPF_DEFAULT_LAB_SERVER, source: 'O', routeType: 'E2', network: '0.0.0.0/0', nextHop: '10.0.12.1', metric: 1 },
        { kind: 'route', device: 'R3', destination: OSPF_DEFAULT_LAB_SERVER, source: 'O', routeType: 'E2', network: '0.0.0.0/0', nextHop: '10.0.13.1', metric: 1, misconception: 'e2-adds-path-cost' },
      ],
      feedbackOnFail: 'An external type-2 route keeps the cost its advertising router gave it; the path to that router is only used to break ties.',
    },
    {
      id: 'reach-the-server',
      title: 'Both hosts reach the server',
      description: `PC2 and PC3 ping SRV (${OSPF_DEFAULT_LAB_SERVER}).`,
      points: 25,
      dependsOn: ['default-everywhere'],
      assertions: [
        { kind: 'connectivity', from: 'PC2', to: 'SRV', expect: 'success' },
        { kind: 'connectivity', from: 'PC3', to: 'SRV', expect: 'success' },
      ],
      feedbackOnFail: 'A ping needs a way out and a way back: ISP routes 10.0.0.0/8 to R1, and R1 knows every LAN inside through OSPF.',
    },
  ],
  solution: {
    R2: ['interface GigabitEthernet0/0', `ip ospf hello-interval ${OSPF_DEFAULT_LAB_HELLO_S}`, 'exit'],
    R1: ['router ospf 1', 'default-information originate', 'exit'],
  },
};

// ── lab 07: fixing OSPF ─────────────────────────────────────────────────────

/** When the hidden changes land: after every router of the lab has booted (45 s). */
const TROUBLE_FAULTS_AT = 50 * SEC;

/** A hidden configuration change that is saved too, so a power cycle keeps it (the last line runs in global mode). */
function savedFragment(device: string, lines: readonly string[]): ScheduledFault {
  return configFragmentFault(TROUBLE_FAULTS_AT, device, [...lines, 'do write memory']);
}

/** The router ID R3 took by mistake (R2's, its neighbour's). */
export const TROUBLE_DUPLICATE_RID = '2.2.2.2';

/** PC1 – R1 – R2 – R3 – PC3, both router links point-to-point; R3 starts without OSPF (a hidden change adds it). */
export const ccna3TroubleshootOspf: ScenarioInfo = {
  name: 'ccna3-troubleshoot-ospf',
  category: 'ccna3-lab',
  labType: 'troubleshoot',
  course: 'CCNA 3',
  topic: TOPIC_ONE_AREA,
  title: 'Why OSPF will not work',
  description:
    'Three routers in a row ran OSPF happily until a round of changes shortly after start-up. Now no router has a neighbour and a LAN has dropped out of OSPF altogether. Find each fault with the neighbour, interface and database views, and repair it where it lies.',
  objectives: [
    'Find why two routers will not become neighbours from the interface and neighbour views',
    'Find why a network is missing from the routing tables of the other routers',
    'Recognise a duplicate router ID, and apply a corrected one to a running process',
    'Prove the repair from end to end',
  ],
  tags: ['ospf', 'troubleshooting', 'neighbours', 'area mismatch', 'wildcard mask', 'router id', 'lsdb'],
  difficulty: 3,
  estimatedMinutes: 30,
  requires: [PC, ROUTER],
  seed: 307,
  instructions: [
    '## What you see',
    '',
    'PC1 (`10.1.0.10`) sits behind R1 `GigabitEthernet0/0` (`10.1.0.1/24`). R1 `GigabitEthernet0/1` (`10.0.12.1/30`) is cabled to R2 `GigabitEthernet0/0` (`.2`), and R2 `GigabitEthernet0/1` (`10.0.23.1/30`) to R3 `GigabitEthernet0/0` (`.2`); both router links are point-to-point networks. PC3 (`10.3.0.10`) sits behind R3 `GigabitEthernet0/1` (`10.3.0.1/24`).',
    '',
    'The design: every router runs OSPF process 1 with every interface in area 0, the router IDs are `1.1.1.1`, `2.2.2.2` and `3.3.3.3`, and the two host LANs are passive. Since a round of changes shortly after start-up:',
    '',
    '- R1 and R2 do not become neighbours, and neither do R2 and R3.',
    '- The LAN of PC1 is not advertised: even with every neighbour back, the other routers would have no route to it.',
    '',
    '## What to do',
    '',
    'Repair each fault on the router where it lies; add nothing the design does not have.',
    '',
    '- Will not peer: `show ip ospf neighbor`, then `show ip ospf interface` on both ends of each router link. The interface view names the last hello the interface refused, and why. Both ends of a link must be in the same area, and no two routers may share a router ID.',
    '- Missing route: `show ip ospf interface brief` on R1 lists the interfaces OSPF runs on. Check the wildcard of each network statement against the address it should match.',
    '- Router ID: `show ip protocols` names the ID each router uses. After you correct a router ID, apply it with `clear ip ospf process` (answer yes): until then the router keeps the old one.',
    '- Prove the result: ping PC3 from PC1, and compare `show ip ospf database` on the three routers.',
    '',
    '*Timing: routers take 45 s to boot, and both router links are point-to-point, so the routes come about 15 s after a neighbour forms: about a minute after each repair.*',
  ].join('\n'),
  build: () =>
    topology(
      307,
      [
        device('pc1', PC, 'PC1', 60, 220, pcConfig('PC1', '10.1.0.10', MASK24, '10.1.0.1')),
        device(
          'r1',
          ROUTER,
          'R1',
          240,
          220,
          configText([
            ['hostname R1'],
            routedPort('GigabitEthernet0/0', '10.1.0.1', MASK24),
            routedPort('GigabitEthernet0/1', '10.0.12.1', MASK30, ['ip ospf network point-to-point']),
            ospfSection(['router-id 1.1.1.1', 'passive-interface GigabitEthernet0/0', 'network 10.1.0.0 0.0.0.255 area 0', 'network 10.0.12.0 0.0.0.3 area 0']),
          ]),
        ),
        device(
          'r2',
          ROUTER,
          'R2',
          440,
          220,
          configText([
            ['hostname R2'],
            routedPort('GigabitEthernet0/0', '10.0.12.2', MASK30, ['ip ospf network point-to-point']),
            routedPort('GigabitEthernet0/1', '10.0.23.1', MASK30, ['ip ospf network point-to-point']),
            ospfSection(['router-id 2.2.2.2', 'network 10.0.12.0 0.0.0.3 area 0', 'network 10.0.23.0 0.0.0.3 area 0']),
          ]),
        ),
        device(
          'r3',
          ROUTER,
          'R3',
          640,
          220,
          configText([
            ['hostname R3'],
            routedPort('GigabitEthernet0/0', '10.0.23.2', MASK30, ['ip ospf network point-to-point']),
            routedPort('GigabitEthernet0/1', '10.3.0.1', MASK24),
          ]),
        ),
        device('pc3', PC, 'PC3', 820, 220, pcConfig('PC3', '10.3.0.10', MASK24, '10.3.0.1')),
      ],
      [
        link('l_pc1_r1', 'pc1', 'GigabitEthernet0', 'r1', 'GigabitEthernet0/0'),
        link('l_r1_r2', 'r1', 'GigabitEthernet0/1', 'r2', 'GigabitEthernet0/0'),
        link('l_r2_r3', 'r2', 'GigabitEthernet0/1', 'r3', 'GigabitEthernet0/0'),
        link('l_r3_pc3', 'r3', 'GigabitEthernet0/1', 'pc3', 'GigabitEthernet0'),
      ],
      ['Make R1 and R2 neighbours again', 'Advertise the LAN of PC1 again', 'Give R3 its own router ID', 'Reach PC3 from PC1'],
      'Work from the neighbours to the interfaces to the database: routers that are not neighbours exchange nothing, an interface OSPF does not run on is not advertised, and two routers with one ID fight over one advertisement.',
      { profile: 'P3' },
    ),
  faults: [
    // R1: the LAN's network statement retyped with a host wildcard that matches no interface address
    savedFragment('r1', ['router ospf 1', ' no network 10.1.0.0 0.0.0.255 area 0', ' network 10.1.0.0 0.0.0.0 area 0']),
    // R2: its link to R1 moved into another area by an interface line (which wins over the network statement)
    savedFragment('r2', ['interface GigabitEthernet0/0', ' ip ospf 1 area 1']),
    // R3: OSPF started with the router ID of its neighbour R2 — the process starts in the same instant, so the ID is the
    // one in use; R2 and R3 refuse each other's hellos, so no LSA of the two ever meets the other (no flooding war)
    savedFragment('r3', [
      'router ospf 1',
      ` router-id ${TROUBLE_DUPLICATE_RID}`,
      ' passive-interface GigabitEthernet0/1',
      ' network 10.0.23.0 0.0.0.3 area 0',
      ' network 10.3.0.0 0.0.0.255 area 0',
    ]),
  ],
  tasks: [
    {
      id: 'neighbours',
      title: 'R1 and R2 are neighbours again',
      description: 'R2 GigabitEthernet0/0 is back in area 0, and R1 and R2 are fully adjacent.',
      points: 25,
      hint: 'An interface line under the interface wins over every network statement for that interface.',
      assertions: [
        { kind: 'fact', device: 'R2', fact: 'ospf.ifaceArea', subject: 'GigabitEthernet0/0', equals: '0.0.0.0' },
        { kind: 'neighbor', device: 'R1', protocol: 'ospf', neighbor: 'R2', iface: 'GigabitEthernet0/1', state: 'full' },
        { kind: 'neighbor', device: 'R2', protocol: 'ospf', neighbor: 'R1', iface: 'GigabitEthernet0/0', state: 'full' },
      ],
      feedbackOnFail: 'Two ends of one link in different areas refuse each other\'s hellos, so no neighbour ever forms.',
    },
    {
      id: 'lan-advertised',
      title: 'The LAN of PC1 is advertised again',
      description: 'R1 runs OSPF on GigabitEthernet0/0 in area 0, and the interface stays passive.',
      points: 25,
      hint: 'A wildcard of 0.0.0.0 matches one address exactly.',
      assertions: [
        { kind: 'fact', device: 'R1', fact: 'ospf.ifaceArea', subject: 'GigabitEthernet0/0', equals: '0.0.0.0' },
        { kind: 'fact', device: 'R1', fact: 'ospf.passive', subject: 'GigabitEthernet0/0', equals: true },
      ],
      feedbackOnFail: 'A network statement switches OSPF on only for the interfaces whose address it matches.',
    },
    {
      id: 'router-ids',
      title: 'Every router has its own ID',
      description: 'R3 uses the router ID 3.3.3.3 and R2 still uses 2.2.2.2 — the IDs in use, not only the configured ones — and the two are fully adjacent.',
      points: 25,
      hint: 'A corrected router-id line waits for `clear ip ospf process` before the router uses it.',
      assertions: [
        { kind: 'fact', device: 'R3', fact: 'ospf.routerId', equals: '3.3.3.3', misconception: 'router-id-applies-at-once' },
        { kind: 'fact', device: 'R2', fact: 'ospf.routerId', equals: '2.2.2.2' },
        { kind: 'neighbor', device: 'R2', protocol: 'ospf', neighbor: '3.3.3.3', iface: 'GigabitEthernet0/1', state: 'full' },
        { kind: 'neighbor', device: 'R3', protocol: 'ospf', neighbor: 'R2', iface: 'GigabitEthernet0/0', state: 'full' },
      ],
      feedbackOnFail: 'A router refuses every hello that carries its own router ID, so two neighbours with one ID never peer.',
    },
    {
      id: 'end-to-end',
      title: 'PC1 reaches PC3',
      description: 'The three routers hold the same database for area 0, each LAN is known at the other end, and PC1 pings PC3.',
      points: 25,
      dependsOn: ['neighbours', 'lan-advertised', 'router-ids'],
      assertions: [
        { kind: 'fact', device: 'R1', fact: 'ospf.lsdbSynced', subject: '0.0.0.0', equals: true },
        { kind: 'route', device: 'R1', destination: '10.3.0.10', source: 'O', network: '10.3.0.0/24', nextHop: '10.0.12.2' },
        { kind: 'route', device: 'R3', destination: '10.1.0.10', source: 'O', network: '10.1.0.0/24', nextHop: '10.0.23.1' },
        { kind: 'connectivity', from: 'PC1', to: 'PC3', expect: 'success' },
      ],
      feedbackOnFail: 'Each fault alone is enough to break the path; check the neighbours, the interfaces and the database again on every router.',
    },
  ],
  solution: {
    R1: ['router ospf 1', 'no network 10.1.0.0 0.0.0.0 area 0', 'network 10.1.0.0 0.0.0.255 area 0', 'exit'],
    R2: ['interface GigabitEthernet0/0', 'no ip ospf 1 area 1', 'exit'],
    // removing the process and creating it again restarts OSPF with the corrected ID in one call (the file header:
    // `clear ip ospf process` asks for a confirmation, which a headless run refuses)
    R3: [
      'no router ospf 1',
      'router ospf 1',
      'router-id 3.3.3.3',
      'passive-interface GigabitEthernet0/1',
      'network 10.0.23.0 0.0.0.3 area 0',
      'network 10.3.0.0 0.0.0.255 area 0',
      'exit',
    ],
  },
};

/** The CCNA 3 OSPF labs, in course order (lessons 03–07). */
export const CCNA3_OSPF_LABS: readonly ScenarioInfo[] = Object.freeze([
  ccna3OspfDrElection,
  ccna3OspfSingleArea,
  ccna3OspfCost,
  ccna3OspfDefaultRoute,
  ccna3TroubleshootOspf,
]);
