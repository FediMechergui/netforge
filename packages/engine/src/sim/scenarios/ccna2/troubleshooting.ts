/**
 * sim/scenarios/ccna2/troubleshooting.ts — the CCNA 2 fault-finding labs (ARCHITECTURE-P2 §11.1, §11.2).
 *
 *   • `ccna2-troubleshoot-vlans`   — lesson 11 "Fixing inter-VLAN routing" (module "Routing between VLANs"): a router
 *     on a stick serves three VLANs over two switches, and three hidden changes break it — a host port moved into the
 *     wrong VLAN, a VLAN dropped from the trunk between the switches, and the subinterface of the server VLAN shut.
 *   • `ccna2-troubleshoot-routing` — lesson 34 "Finding faults" (module "Translation and fault finding"): two sites
 *     joined by two routers with static routes, broken once per layer — a server port error-disabled by BPDU guard,
 *     the two ends of the router link re-addressed into different subnets, and the static route to the branch
 *     retyped with the wrong network.
 *
 * Both worlds are broken by hidden faults the worker injects right after the load (§11.2): the `err-disable` is
 * scheduled at t = 0 (the port stays error-disabled through the boot, as the grader's clone relies on too), and the
 * `config-fragment` changes land at FAULTS_AT, once every router has booted (a router takes 45 s; a fragment sent to
 * a device that has not booted is dropped). Each fragment ends with `do write memory`, so the change is in the
 * startup configuration as well as the running one: a power cycle does not undo it, and `show startup-config` does
 * not give it away. The grader reads the live state and the running configurations its clones copy
 * (sim/lab-checks.ts), so an unrepaired fault is graded as broken; until the last fault has landed, `evaluateLab`
 * fails every task with a "still being prepared" detail, so the healthy world before the faults never scores.
 *
 * Neither lesson is about spanning tree: every host port (and every switch port facing a router in the routing lab)
 * is an edge port in the startup configuration (§11.2), and the VLAN lab's instructions say that a trunk which starts
 * carrying a VLAN again waits 30 s before it forwards in it. Tasks read structured state only: `switchport`, `vlan`,
 * `port` (address, admin and oper state, errDisabled), `route`, `table` rows of `rib`, and `connectivity`. Each fault
 * has a task that reads the setting to repair on the device that holds it (a host that was re-addressed around a
 * fault still fails it), most with a ping that only that repair lets through, and a last task pings across the whole
 * network. All wording is original (§0 rule 6).
 *
 * A lab file imports only the contracts, `../kit.js` and `../templates.js` — never `./index.js`, `../index.js` or
 * the engine barrel — so the catalogue stays an acyclic graph of data modules (the arrays are read at module scope).
 *
 * ponytail: no `cable-cut` fault. The only repair a learner has for a cut cable is to delete it in the link inspector
 * and draw a new one, which a reference `solution` (lines for `Simulation.configure`) cannot express, so a lab
 * that needs it could never be proved solvable by test/labs.ccna2.solutions.test.ts. Every fault here is repaired
 * from the CLI.
 */
import type { ScenarioInfo } from '../../../contracts/scenario.js';
import { SEC } from '../../../contracts/time.js';
import { MASK24, MASK30, PC, ROUTER, SERVER, SWITCH, accessPort, configFragmentFault, configText, device, errDisableFault, link, section, topology, trunkPort, vlanSections, type ScheduledFault } from '../kit.js';
import { pcConfig, routerConfig } from '../templates.js';

/** When the hidden configuration changes land: after every router of the lab has booted (45 s). */
const FAULTS_AT = 50 * SEC;

/** When the hidden err-disable lands: at once — the port stays error-disabled through the switch's boot. */
const ERR_DISABLE_AT = 0;

/** A hidden configuration change that is saved too, so a power cycle keeps it (the last line runs in global mode). */
function savedFragment(device: string, lines: readonly string[]): ScheduledFault {
  return configFragmentFault(FAULTS_AT, device, [...lines, 'do write memory']);
}

// ── inter-VLAN routing ──────────────────────────────────────────────────────

/** The three VLANs of the router on a stick; both trunks carry exactly these. */
const STICK_VLANS = [
  { id: 10, name: 'SALES' },
  { id: 20, name: 'STAFF' },
  { id: 30, name: 'SERVERS' },
] as const;

/** The allowed list both trunks are designed with. */
const STICK_TRUNK_VLANS = '10,20,30';

/** R1: the trunk port enabled without an address, one subinterface per VLAN with the `.1` gateway address. */
function stickRouterConfig(): string {
  return configText([
    ['hostname R1'],
    section('interface GigabitEthernet0/0', ['no shutdown']),
    ...STICK_VLANS.map((v) => section(`interface GigabitEthernet0/0.${v.id}`, [`encapsulation dot1Q ${v.id}`, `ip address 192.168.${v.id}.1 ${MASK24}`])),
  ]);
}

/** SW1: the VLANs, a trunk to R1 and a trunk to SW2 (both pruned to the three VLANs), and three edge access ports. */
function vlanSw1Config(): string {
  return configText([
    ['hostname SW1'],
    ...vlanSections(STICK_VLANS),
    trunkPort('GigabitEthernet0/1', { allowed: STICK_TRUNK_VLANS, nonegotiate: true }),
    trunkPort('GigabitEthernet0/2', { allowed: STICK_TRUNK_VLANS }),
    accessPort('FastEthernet0/1', 10, { portfast: true }),
    accessPort('FastEthernet0/2', 20, { portfast: true }),
    accessPort('FastEthernet0/3', 30, { portfast: true }),
  ]);
}

/** SW2: the VLANs, its trunk to SW1 and two edge access ports. */
function vlanSw2Config(): string {
  return configText([
    ['hostname SW2'],
    ...vlanSections(STICK_VLANS),
    trunkPort('GigabitEthernet0/1', { allowed: STICK_TRUNK_VLANS }),
    accessPort('FastEthernet0/1', 10, { portfast: true }),
    accessPort('FastEthernet0/2', 20, { portfast: true }),
  ]);
}

/** R1 on a stick above SW1 (PC1, PC2, SRV) and SW2 (PC3, PC4); three hidden changes break one VLAN path each. */
export const ccna2TroubleshootVlans: ScenarioInfo = {
  name: 'ccna2-troubleshoot-vlans',
  category: 'ccna2-lab',
  labType: 'troubleshoot',
  course: 'CCNA 2',
  topic: 'Routing between VLANs',
  title: 'Repair inter-VLAN routing',
  description:
    'Three VLANs used to reach each other through a router on a stick, until a round of changes shortly after start-up. One PC now reaches nobody, another reaches only its own switch, and nobody reaches the server. Find the port in the wrong VLAN, the VLAN missing from a trunk and the subinterface that is down.',
  objectives: [
    'Check the VLAN of an access port against the address of the host behind it',
    'Compare the VLANs a trunk carries at both of its ends',
    'Recognise a router subinterface that has been shut down',
    'Work from a symptom to the device and the line that cause it',
  ],
  tags: ['troubleshooting', 'inter-vlan routing', 'vlan', 'trunk', 'allowed vlans', 'subinterface', 'router-on-a-stick'],
  difficulty: 2,
  estimatedMinutes: 25,
  requires: [PC, ROUTER, SERVER, SWITCH],
  seed: 211,
  instructions: [
    '## What you see',
    '',
    'R1 routes between three VLANs over one trunk to SW1: VLAN 10 (`SALES`, `192.168.10.0/24`), VLAN 20 (`STAFF`, `192.168.20.0/24`) and VLAN 30 (`SERVERS`, `192.168.30.0/24`). The gateway of each VLAN is the `.1` address on subinterface `GigabitEthernet0/0.<vlan>`. SW1 holds PC1 (VLAN 10), PC2 (VLAN 20) and SRV (VLAN 30); SW2 holds PC3 (VLAN 10) and PC4 (VLAN 20). By design both trunks carry VLANs 10, 20 and 30 and nothing else.',
    '',
    'Shortly after start-up somebody made a few changes. Since then:',
    '',
    '- PC3 reaches nobody, not even PC1 in its own VLAN.',
    '- PC4 cannot reach its gateway, although PC2 in the same VLAN can.',
    '- No PC reaches SRV.',
    '',
    '## What to do',
    '',
    '- Start at the host: read its address, then the VLAN of the switch port it is plugged into (`show vlan brief`).',
    '- Compare each trunk at both ends (`show interfaces trunk`): the VLANs it allows and forwards must match.',
    '- Check the subinterfaces of R1 (`show ip interface brief`).',
    '- Repair each fault on the device where it lies, without touching any host, then ping across every VLAN.',
    '',
    '*The host ports are edge ports and forward at once. A trunk that starts carrying a VLAN again joins the spanning tree of that VLAN first: it listens for 15 s and learns for 15 s before it forwards, so wait half a minute before you test it.*',
  ].join('\n'),
  build: () =>
    topology(
      211,
      [
        device('r1', ROUTER, 'R1', 410, 70, stickRouterConfig()),
        device('sw1', SWITCH, 'SW1', 250, 230, vlanSw1Config()),
        device('sw2', SWITCH, 'SW2', 590, 230, vlanSw2Config()),
        device('pc1', PC, 'PC1', 90, 380, pcConfig('PC1', '192.168.10.11', MASK24, '192.168.10.1')),
        device('pc2', PC, 'PC2', 230, 420, pcConfig('PC2', '192.168.20.12', MASK24, '192.168.20.1')),
        device('srv', SERVER, 'SRV', 70, 180, pcConfig('SRV', '192.168.30.100', MASK24, '192.168.30.1')),
        device('pc3', PC, 'PC3', 540, 420, pcConfig('PC3', '192.168.10.13', MASK24, '192.168.10.1')),
        device('pc4', PC, 'PC4', 730, 380, pcConfig('PC4', '192.168.20.14', MASK24, '192.168.20.1')),
      ],
      [
        link('l_r1_sw1', 'r1', 'GigabitEthernet0/0', 'sw1', 'GigabitEthernet0/1'),
        link('l_sw1_sw2', 'sw1', 'GigabitEthernet0/2', 'sw2', 'GigabitEthernet0/1'),
        link('l_pc1_sw1', 'pc1', 'GigabitEthernet0', 'sw1', 'FastEthernet0/1'),
        link('l_pc2_sw1', 'pc2', 'GigabitEthernet0', 'sw1', 'FastEthernet0/2'),
        link('l_srv_sw1', 'srv', 'GigabitEthernet0', 'sw1', 'FastEthernet0/3'),
        link('l_pc3_sw2', 'pc3', 'GigabitEthernet0', 'sw2', 'FastEthernet0/1'),
        link('l_pc4_sw2', 'pc4', 'GigabitEthernet0', 'sw2', 'FastEthernet0/2'),
      ],
      ['Find the port in the wrong VLAN', 'Find the VLAN missing from a trunk', 'Find the subinterface that is down', 'Route between every VLAN again'],
      'A frame only reaches its gateway when every step agrees on its VLAN: the access port, each trunk on the way, and the subinterface that carries that VLAN on the router.',
      { profile: 'P2' },
    ),
  faults: [
    savedFragment('sw2', ['interface FastEthernet0/1', ' switchport access vlan 20']),
    savedFragment('sw1', ['interface GigabitEthernet0/2', ' switchport trunk allowed vlan 10,30']),
    savedFragment('r1', ['interface GigabitEthernet0/0.30', ' shutdown']),
  ],
  tasks: [
    {
      id: 'wrong-vlan',
      title: 'PC3 is back in its VLAN',
      description: 'SW2 FastEthernet0/1 is an access port of VLAN 10 again, PC3 keeps its address, and PC3 reaches PC1.',
      points: 25,
      hint: 'The address of a host tells you which VLAN its switch port belongs in.',
      assertions: [
        { kind: 'switchport', device: 'SW2', port: 'FastEthernet0/1', mode: 'access', accessVlan: 10 },
        { kind: 'vlan', device: 'SW2', vlan: 10, accessPorts: ['FastEthernet0/1'] },
        { kind: 'port', device: 'PC3', port: 'GigabitEthernet0', field: 'ipv4', equals: '192.168.10.13/24' },
        { kind: 'connectivity', from: 'PC3', to: 'PC1', expect: 'success' },
      ],
      feedbackOnFail: 'A host in the wrong VLAN reaches nobody: its subnet and its gateway live in another VLAN. Moving the host to the subnet of the wrong VLAN only hides the fault.',
    },
    {
      id: 'trunk-vlan',
      title: 'VLAN 20 crosses the trunk again',
      description: 'Both ends of the trunk between SW1 and SW2 carry VLANs 10, 20 and 30, and PC4 reaches PC2.',
      points: 25,
      hint: 'An allowed list typed without `add` replaces the whole list.',
      assertions: [
        { kind: 'switchport', device: 'SW1', port: 'GigabitEthernet0/2', oper: 'trunk', allowedVlans: [10, 20, 30] },
        { kind: 'switchport', device: 'SW2', port: 'GigabitEthernet0/1', oper: 'trunk', allowedVlans: [10, 20, 30] },
        { kind: 'connectivity', from: 'PC4', to: 'PC2', expect: 'success' },
      ],
      feedbackOnFail: 'A trunk drops the frames of every VLAN its allowed list leaves out, and it takes one end to leave a VLAN out.',
    },
    {
      id: 'subinterface',
      title: 'The server VLAN has its gateway back',
      description: 'R1 GigabitEthernet0/0.30 is enabled and up with 192.168.30.1/24, R1 reaches VLAN 30 through it, and PC1 reaches SRV.',
      points: 25,
      hint: 'A subinterface can be shut on its own while its parent port stays up.',
      assertions: [
        { kind: 'port', device: 'R1', port: 'GigabitEthernet0/0.30', field: 'adminUp', equals: true },
        { kind: 'port', device: 'R1', port: 'GigabitEthernet0/0.30', field: 'operUp', equals: true },
        { kind: 'port', device: 'R1', port: 'GigabitEthernet0/0.30', field: 'ipv4', equals: '192.168.30.1/24' },
        { kind: 'route', device: 'R1', destination: '192.168.30.100', source: 'C', iface: 'GigabitEthernet0/0.30' },
        { kind: 'connectivity', from: 'PC1', to: 'SRV', expect: 'success' },
      ],
      feedbackOnFail: 'While its subinterface is down, R1 has no route to VLAN 30, and the hosts there have no gateway.',
    },
    {
      id: 'every-vlan',
      title: 'Every VLAN reaches every other',
      description: 'PC3 reaches SRV and PC4 reaches PC1, both through R1.',
      points: 25,
      dependsOn: ['wrong-vlan', 'trunk-vlan', 'subinterface'],
      assertions: [
        { kind: 'connectivity', from: 'PC3', to: 'SRV', expect: 'success' },
        { kind: 'connectivity', from: 'PC4', to: 'PC1', expect: 'success' },
      ],
      feedbackOnFail: 'A packet between two VLANs crosses the access port, both trunks and two subinterfaces; each one has to be right.',
    },
  ],
  solution: {
    SW2: ['interface FastEthernet0/1', 'switchport access vlan 10', 'exit'],
    SW1: ['interface GigabitEthernet0/2', 'switchport trunk allowed vlan add 20', 'exit'],
    R1: ['interface GigabitEthernet0/0.30', 'no shutdown', 'exit'],
  },
};

// ── a routed network, one layer at a time ───────────────────────────────────

/** A LAN switch of the routing lab: its host ports and the port facing its router are edge ports. */
function siteSwitchConfig(hostname: string, guarded: boolean): string {
  const hostPort = (port: string): string[] =>
    section(`interface ${port}`, ['switchport mode access', 'spanning-tree portfast', ...(guarded ? ['spanning-tree bpduguard enable'] : [])]);
  return configText([[`hostname ${hostname}`], hostPort('FastEthernet0/1'), hostPort('FastEthernet0/2'), accessPort('GigabitEthernet0/1', 1, { portfast: true })]);
}

/** HQ (R1, SW1, PC1, PC2) and a branch (R2, SW2, PC3, SRV) joined by one routed link; three faults, one per layer. */
export const ccna2TroubleshootRouting: ScenarioInfo = {
  name: 'ccna2-troubleshoot-routing',
  category: 'ccna2-lab',
  labType: 'troubleshoot',
  course: 'CCNA 2',
  topic: 'Translation and fault finding',
  title: 'Find the faults one layer at a time',
  description:
    'Headquarters and a branch office are joined by two routers with static routes, and since a round of changes almost nothing crosses between them. Work up from the switch ports to the addresses to the routes, and repair each fault where you find it.',
  objectives: [
    'Troubleshoot from the bottom up: ports first, then addresses, then routes',
    'Recognise and recover a port that a guard error-disabled',
    'Spot the two ends of a link that no longer share a subnet',
    'Read a routing table and repair a static route that names the wrong network',
  ],
  tags: ['troubleshooting', 'layered method', 'err-disabled', 'addressing', 'static routing', 'routing table'],
  difficulty: 3,
  estimatedMinutes: 30,
  requires: [PC, ROUTER, SERVER, SWITCH],
  seed: 234,
  instructions: [
    '## What you see',
    '',
    'At HQ, PC1 and PC2 sit on SW1 in `192.168.10.0/24` behind R1 (`192.168.10.1`). At the branch, PC3 and the server SRV sit on SW2 in `192.168.20.0/24` behind R2 (`192.168.20.1`). R1 `GigabitEthernet0/1` (`10.0.12.1/30`) is cabled to R2 `GigabitEthernet0/0` (`10.0.12.2/30`), and each router holds one static route to the LAN of the other site, through the address of the other router on that link. The host ports of SW2 are protected by BPDU guard.',
    '',
    'The addressing plan above is right; since a round of changes shortly after start-up, the network is not:',
    '',
    '- PC3 cannot reach SRV, although both sit on SW2.',
    '- R1 cannot ping R2 across the link between them.',
    '- PC1 cannot reach the branch, and R1 answers that it knows no way there.',
    '',
    '## What to do',
    '',
    'Work one layer at a time and repair each fault on the device where it lies:',
    '',
    '- Ports: is every port up? `show interfaces status` on the switches, and `show interfaces status err-disabled`.',
    '- Addresses: do both ends of each link sit in the same subnet? `show ip interface brief` on both routers.',
    '- Routes: does each router know the way to the LAN of the other site? `show ip route`.',
    '- Prove the result from end to end: ping SRV from PC1 and PC3 from PC2.',
    '',
    '*Repair what is broken rather than adding to it: no new route is needed, a default route included. Every switch port here is an edge port and forwards as soon as it comes up.*',
  ].join('\n'),
  build: () =>
    topology(
      234,
      [
        device('pc1', PC, 'PC1', 70, 300, pcConfig('PC1', '192.168.10.11', MASK24, '192.168.10.1')),
        device('pc2', PC, 'PC2', 70, 460, pcConfig('PC2', '192.168.10.12', MASK24, '192.168.10.1')),
        device('sw1', SWITCH, 'SW1', 210, 380, siteSwitchConfig('SW1', false)),
        device(
          'r1',
          ROUTER,
          'R1',
          330,
          200,
          routerConfig(
            'R1',
            [
              { port: 'GigabitEthernet0/0', address: '192.168.10.1', mask: MASK24 },
              { port: 'GigabitEthernet0/1', address: '10.0.12.1', mask: MASK30 },
            ],
            [`192.168.20.0 ${MASK24} 10.0.12.2`],
          ),
        ),
        device(
          'r2',
          ROUTER,
          'R2',
          570,
          200,
          routerConfig(
            'R2',
            [
              { port: 'GigabitEthernet0/0', address: '10.0.12.2', mask: MASK30 },
              { port: 'GigabitEthernet0/1', address: '192.168.20.1', mask: MASK24 },
            ],
            [`192.168.10.0 ${MASK24} 10.0.12.1`],
          ),
        ),
        device('sw2', SWITCH, 'SW2', 690, 380, siteSwitchConfig('SW2', true)),
        device('pc3', PC, 'PC3', 830, 300, pcConfig('PC3', '192.168.20.13', MASK24, '192.168.20.1')),
        device('srv', SERVER, 'SRV', 830, 460, pcConfig('SRV', '192.168.20.100', MASK24, '192.168.20.1')),
      ],
      [
        link('l_pc1_sw1', 'pc1', 'GigabitEthernet0', 'sw1', 'FastEthernet0/1'),
        link('l_pc2_sw1', 'pc2', 'GigabitEthernet0', 'sw1', 'FastEthernet0/2'),
        link('l_sw1_r1', 'sw1', 'GigabitEthernet0/1', 'r1', 'GigabitEthernet0/0'),
        link('l_r1_r2', 'r1', 'GigabitEthernet0/1', 'r2', 'GigabitEthernet0/0'),
        link('l_r2_sw2', 'r2', 'GigabitEthernet0/1', 'sw2', 'GigabitEthernet0/1'),
        link('l_pc3_sw2', 'pc3', 'GigabitEthernet0', 'sw2', 'FastEthernet0/1'),
        link('l_srv_sw2', 'srv', 'GigabitEthernet0', 'sw2', 'FastEthernet0/2'),
      ],
      ['Bring back the port that was shut down', 'Put both ends of the router link in one subnet', 'Repair the route to the branch', 'Reach the branch from HQ'],
      'Troubleshooting from the bottom up saves guessing: a route cannot work over a link whose ends disagree on the subnet, and nothing works over a port that is down.',
      { profile: 'P2' },
    ),
  faults: [
    errDisableFault(ERR_DISABLE_AT, 'sw2', 'FastEthernet0/2', 'bpduguard'),
    savedFragment('r2', ['interface GigabitEthernet0/0', ` ip address 10.0.12.6 ${MASK30}`]),
    savedFragment('r1', [`no ip route 192.168.20.0 ${MASK24} 10.0.12.2`, `ip route 192.168.2.0 ${MASK24} 10.0.12.2`]),
  ],
  tasks: [
    {
      id: 'server-port',
      title: 'SRV is back on its switch port',
      description: 'SW2 FastEthernet0/2 is no longer error-disabled, is up, and PC3 reaches SRV.',
      points: 25,
      hint: 'An error-disabled port stays down until it is shut down and enabled again.',
      assertions: [
        { kind: 'port', device: 'SW2', port: 'FastEthernet0/2', field: 'errDisabled', equals: false },
        { kind: 'port', device: 'SW2', port: 'FastEthernet0/2', field: 'operUp', equals: true },
        { kind: 'connectivity', from: 'PC3', to: 'SRV', expect: 'success' },
      ],
      feedbackOnFail: 'Two hosts on one switch that cannot reach each other point at a port, not at a route.',
    },
    {
      id: 'link-subnet',
      title: 'The routers share a subnet again',
      description: 'R1 GigabitEthernet0/1 has 10.0.12.1/30 and R2 GigabitEthernet0/0 has 10.0.12.2/30, R1 reaches R2 across the link, and the route of R2 back to HQ leaves through GigabitEthernet0/0 again.',
      points: 25,
      hint: 'Work out the /30 subnet of each end: two addresses that look close can still sit in different subnets.',
      assertions: [
        { kind: 'port', device: 'R1', port: 'GigabitEthernet0/1', field: 'ipv4', equals: '10.0.12.1/30' },
        { kind: 'port', device: 'R2', port: 'GigabitEthernet0/0', field: 'ipv4', equals: '10.0.12.2/30' },
        { kind: 'connectivity', from: 'R1', to: 'R2', expect: 'success' },
        { kind: 'route', device: 'R2', destination: '192.168.10.11', source: 'S', network: '192.168.10.0/24', nextHop: '10.0.12.1', iface: 'GigabitEthernet0/0' },
      ],
      feedbackOnFail: 'A static route is only used while its next hop sits in a subnet the router is connected to.',
    },
    {
      id: 'branch-route',
      title: 'R1 routes to the branch LAN',
      description: 'R1 reaches 192.168.20.0/24 through the next hop 10.0.12.2, and the mistyped route is gone.',
      points: 25,
      hint: 'Compare the network of each static route with the addressing plan, digit by digit.',
      assertions: [
        { kind: 'route', device: 'R1', destination: '192.168.20.100', source: 'S', network: '192.168.20.0/24', nextHop: '10.0.12.2' },
        { kind: 'table', device: 'R1', table: 'rib', where: { network: '192.168.2.0', prefixLen: 24 }, exists: false },
      ],
      feedbackOnFail: 'A route to the wrong network is worse than none: it looks right at a glance and sends nothing where it is needed.',
    },
    {
      id: 'end-to-end',
      title: 'HQ and the branch reach each other',
      description: 'PC1 reaches SRV and PC2 reaches PC3.',
      points: 25,
      dependsOn: ['server-port', 'link-subnet', 'branch-route'],
      assertions: [
        { kind: 'connectivity', from: 'PC1', to: 'SRV', expect: 'success' },
        { kind: 'connectivity', from: 'PC2', to: 'PC3', expect: 'success' },
      ],
      feedbackOnFail: 'A reply needs a way back as much as the request needs a way out: check both routers, not only the first one.',
    },
  ],
  solution: {
    SW2: ['interface FastEthernet0/2', 'shutdown', 'no shutdown', 'exit'],
    R2: ['interface GigabitEthernet0/0', `ip address 10.0.12.2 ${MASK30}`, 'exit'],
    R1: [`no ip route 192.168.2.0 ${MASK24} 10.0.12.2`, `ip route 192.168.20.0 ${MASK24} 10.0.12.2`],
  },
};

/** The fault-finding labs, in course order. */
export const CCNA2_TROUBLESHOOTING_LABS: readonly ScenarioInfo[] = [ccna2TroubleshootVlans, ccna2TroubleshootRouting];
