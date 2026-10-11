/**
 * sim/scenarios/ccna3/discovery.ts — the CCNA 3 discovery lab (ARCHITECTURE-P3 §11.1 lesson 28, §11.2, §3.6, §5.5;
 * owner disc, W5).
 *
 *   • `ccna3-discover-neighbours` — lesson 28 "Who is next door" (module "Managing the network"): map a small network
 *     from the devices' own announcements — CDP, which the routers and switches of a P3 world run by default (D2), and
 *     LLDP, which a switch from another maker speaks instead — and write the map into the interface descriptions; then
 *     stop the announcements where they leak: toward the provider's router and on the user ports.
 *
 * A P3-profile world (`topology(…, { profile: 'P3' })`, schema 1.3). The lesson is not about spanning tree, so every
 * switch port toward a host or a router is an edge port (`spanning-tree portfast`) in the startup configuration
 * (§11.2); the link between the two switches is not. Tasks read structured state only (§2.10): the `neighbor` kind
 * over the `cdp-neighbours` and `lldp-neighbours` tables, the `cdp.enabled` / `lldp.enabled` facts (configuration and
 * profile, sim/lab-checks/discovery.ts) and `config` lines for the descriptions. Discovery state forms without any
 * waiting the grader cannot do: CDP rows exist from the first link-up, and SW1's `lldp run` sends at once, so SW2's
 * row for SW1 is there as soon as the line is typed (SW1's own row for SW2 waits for SW2's next 30 s announcement, so
 * the lab grades the LLDP map on SW2). The reference `solution` is accepted by `Simulation.configure` as written.
 * Addresses come from the private and documentation ranges; all wording is original (§0 rule 6): CDP is a name only.
 *
 * A lab file imports only the contracts, `../kit.js` and `../templates.js` (rule 12: no cycle with the catalogue).
 */
import type { ScenarioInfo } from '../../../contracts/scenario.js';
import { MASK24, MASK30, PC, ROUTER, SWITCH, accessPort, configText, device, link, section, topology } from '../kit.js';
import { pcConfig } from '../templates.js';

/** The LAN of the lab (R1, both switches' management VLAN and the three PCs). */
export const DISCOVERY_LAN = '10.28.0.0/24';
/** R1's address on the LAN, the hosts' gateway. */
export const DISCOVERY_GATEWAY = '10.28.0.1';
/** The provider link (a documentation range): the provider's router, then R1. */
export const DISCOVERY_ISP_ADDRESS = '203.0.113.1';
export const DISCOVERY_R1_WAN_ADDRESS = '203.0.113.2';

/** A switch whose listed ports face hosts or routers, so each is an edge port; `extra` are further global lines. */
function edgeSwitch(hostname: string, managementAddress: string, edgePorts: readonly string[], extra: readonly string[] = []): string {
  return configText([
    [`hostname ${hostname}`],
    ...extra.map((l) => [l]),
    ...edgePorts.map((p) => accessPort(p, 1, { portfast: true })),
    section('interface Vlan1', [`ip address ${managementAddress} ${MASK24}`, 'no shutdown']),
    [`ip default-gateway ${DISCOVERY_GATEWAY}`],
  ]);
}

/** R1: the LAN on GigabitEthernet0/0, the provider on GigabitEthernet0/1, a default route toward it. */
function r1Config(): string {
  return configText([
    ['hostname R1'],
    section('interface GigabitEthernet0/0', [`ip address ${DISCOVERY_GATEWAY} ${MASK24}`, 'no shutdown']),
    section('interface GigabitEthernet0/1', [`ip address ${DISCOVERY_R1_WAN_ADDRESS} ${MASK30}`, 'no shutdown']),
    [`ip route 0.0.0.0 0.0.0.0 ${DISCOVERY_ISP_ADDRESS}`],
  ]);
}

/** The provider's router: its end of the provider link and a route back to the lab LAN. */
function ispConfig(): string {
  return configText([
    ['hostname ISP'],
    section('interface GigabitEthernet0/0', [`ip address ${DISCOVERY_ISP_ADDRESS} ${MASK30}`, 'no shutdown']),
    [`ip route 10.28.0.0 ${MASK24} ${DISCOVERY_R1_WAN_ADDRESS}`],
  ]);
}

/** Lab 28: map a network with CDP and LLDP, then turn discovery off where it leaks. */
export const ccna3DiscoverNeighbours: ScenarioInfo = {
  name: 'ccna3-discover-neighbours',
  category: 'ccna3-lab',
  labType: 'guided',
  course: 'CCNA 3',
  topic: 'Managing the network',
  title: 'Who is next door',
  description:
    'Nobody wrote down how this small office is cabled. Ask the routers and switches themselves: CDP and LLDP announce each device to its neighbours. Write the map into the interface descriptions, find the switch that CDP cannot see, then stop the announcements on the ports where strangers could read them.',
  objectives: [
    'Read the neighbours a device has learned with show cdp neighbors and show lldp neighbors',
    'Explain why a device that speaks only LLDP is missing from the CDP map, and switch LLDP on to find it',
    'Document links in interface descriptions from what discovery reports',
    'Turn CDP and LLDP off on a port facing the provider or a user, while keeping them on the links between your own devices',
  ],
  tags: ['cdp', 'lldp', 'neighbour discovery', 'network documentation', 'device hardening'],
  difficulty: 1,
  estimatedMinutes: 25,
  requires: [PC, ROUTER, SWITCH],
  seed: 3028,
  instructions: [
    '## What you have',
    '',
    `An office LAN \`${DISCOVERY_LAN}\` with a router (R1, \`${DISCOVERY_GATEWAY}\`), two switches and three PCs. R1 also connects to the provider's router (ISP) over \`203.0.113.0/30\`. ISP belongs to the provider: look, but do not change it.`,
    '',
    'In this world the routers and switches run CDP from the moment they start, as real devices do. SW2 came from another maker: it speaks only LLDP, the standard discovery protocol, and LLDP is off everywhere else.',
    '',
    '## What to do',
    '',
    '- On R1 and SW1 run `show cdp neighbors` and `show cdp neighbors detail`. Note who sits behind each port, which of *their* ports faces you, and the address and platform they announce. SW2 is missing: CDP cannot see a device that does not speak it.',
    '- Give each link a description that names the device at its far end, for example `description link to SW1 Gi0/1` on R1 `GigabitEthernet0/0`. Do it on R1 (both ports) and on SW1 `GigabitEthernet0/1`.',
    '- Switch LLDP on on SW1 with `lldp run`, read `show lldp neighbors` on SW1 and SW2, and describe the link between the two switches at both ends.',
    "- CDP tells anyone at the other end your device name, platform, software and addresses. Stop it on R1's port toward ISP with `no cdp enable`, without switching CDP off for the whole router.",
    '- Stop discovery on the user ports: on SW1 `FastEthernet0/1` and `FastEthernet0/2`, `no cdp enable` plus `no lldp transmit` and `no lldp receive`; on SW2 `FastEthernet0/1`, the two LLDP lines. The links between your own devices keep announcing.',
    '',
    '## Timing',
    '',
    "Allow about a minute for the routers to start. CDP announces a port as soon as its link comes up and then every 60 s; LLDP every 30 s once it is switched on. A neighbour stays listed until its hold time runs out (180 s for CDP, 120 s for LLDP) or its link goes down, so a device you silenced may stay in your neighbour's table for a while: the grader reads the configuration and the tables of the device you changed.",
    '',
    '*`show cdp entry SW1` prints everything one neighbour announced; `show lldp interface` shows where LLDP transmits and receives.*',
  ].join('\n'),
  build: () =>
    topology(
      3028,
      [
        device('isp', ROUTER, 'ISP', 860, 120, ispConfig()),
        device('r1', ROUTER, 'R1', 640, 120, r1Config()),
        device('sw1', SWITCH, 'SW1', 420, 230, edgeSwitch('SW1', '10.28.0.2', ['FastEthernet0/1', 'FastEthernet0/2', 'GigabitEthernet0/1'])),
        device('sw2', SWITCH, 'SW2', 190, 330, edgeSwitch('SW2', '10.28.0.3', ['FastEthernet0/1'], ['no cdp run', 'lldp run'])),
        device('pc1', PC, 'PC1', 330, 420, pcConfig('PC1', '10.28.0.11', MASK24, DISCOVERY_GATEWAY)),
        device('pc2', PC, 'PC2', 520, 420, pcConfig('PC2', '10.28.0.12', MASK24, DISCOVERY_GATEWAY)),
        device('pc3', PC, 'PC3', 90, 450, pcConfig('PC3', '10.28.0.13', MASK24, DISCOVERY_GATEWAY)),
      ],
      [
        link('l_r1_isp', 'r1', 'GigabitEthernet0/1', 'isp', 'GigabitEthernet0/0'),
        link('l_sw1_r1', 'sw1', 'GigabitEthernet0/1', 'r1', 'GigabitEthernet0/0'),
        link('l_sw1_sw2', 'sw1', 'GigabitEthernet0/2', 'sw2', 'GigabitEthernet0/1'),
        link('l_pc1_sw1', 'pc1', 'GigabitEthernet0', 'sw1', 'FastEthernet0/1'),
        link('l_pc2_sw1', 'pc2', 'GigabitEthernet0', 'sw1', 'FastEthernet0/2'),
        link('l_pc3_sw2', 'pc3', 'GigabitEthernet0', 'sw2', 'FastEthernet0/1'),
      ],
      ['Map the neighbours CDP reports', 'Find the LLDP-only switch', 'Silence discovery toward the provider', 'Silence discovery on the user ports'],
      'CDP and LLDP announce each device to the devices next to it: useful for mapping your own network, and for anyone else who can listen.',
      { profile: 'P3' },
    ),
  tasks: [
    {
      id: 'cdp-map',
      title: 'Write the CDP map into the descriptions',
      description: "R1 GigabitEthernet0/0 names SW1, R1 GigabitEthernet0/1 names ISP and SW1 GigabitEthernet0/1 names R1 in their descriptions: the neighbours CDP reports on those ports.",
      points: 25,
      hint: 'show cdp neighbors lists the local port first, then the neighbour and the port it uses.',
      assertions: [
        { kind: 'neighbor', device: 'SW1', protocol: 'cdp', neighbor: 'R1', iface: 'GigabitEthernet0/1' },
        { kind: 'neighbor', device: 'R1', protocol: 'cdp', neighbor: 'SW1', iface: 'GigabitEthernet0/0' },
        {
          kind: 'config',
          device: 'R1',
          path: 'interface.GigabitEthernet0/0.description',
          contains: 'SW1',
          feedback: 'R1 GigabitEthernet0/0 needs a description naming SW1, the neighbour CDP reports there.',
        },
        {
          kind: 'config',
          device: 'R1',
          path: 'interface.GigabitEthernet0/1.description',
          contains: 'ISP',
          feedback: 'R1 GigabitEthernet0/1 needs a description naming ISP.',
        },
        {
          kind: 'config',
          device: 'SW1',
          path: 'interface.GigabitEthernet0/1.description',
          contains: 'R1',
          feedback: 'SW1 GigabitEthernet0/1 needs a description naming R1.',
          misconception: 'description-on-wrong-port',
        },
      ],
      feedbackOnFail: 'Read the local port in the first columns of show cdp neighbors: the description goes on that port, and names the device in the Device ID column.',
    },
    {
      id: 'lldp-map',
      title: 'Find the switch CDP cannot see',
      description: 'SW1 runs LLDP, SW2 lists SW1 as its LLDP neighbour on GigabitEthernet0/1, and both ends of the link between the switches name the switch at the other end.',
      points: 25,
      hint: 'LLDP is off until lldp run; SW2 already runs it.',
      assertions: [
        {
          kind: 'fact',
          device: 'SW1',
          fact: 'lldp.enabled',
          equals: true,
          feedback: 'SW1 does not run LLDP yet.',
          misconception: 'cdp-sees-every-device',
        },
        { kind: 'neighbor', device: 'SW2', protocol: 'lldp', neighbor: 'SW1', iface: 'GigabitEthernet0/1' },
        { kind: 'config', device: 'SW1', path: 'interface.GigabitEthernet0/2.description', contains: 'SW2', feedback: 'SW1 GigabitEthernet0/2 needs a description naming SW2.' },
        { kind: 'config', device: 'SW2', path: 'interface.GigabitEthernet0/1.description', contains: 'SW1', feedback: 'SW2 GigabitEthernet0/1 needs a description naming SW1.' },
      ],
      feedbackOnFail: 'Two devices see each other only when they speak the same discovery protocol: SW2 has no CDP, so both switches need LLDP.',
    },
    {
      id: 'quiet-edge',
      title: 'Say nothing to the provider',
      description: 'R1 sends neither CDP nor LLDP toward ISP on GigabitEthernet0/1, still runs CDP, and still lists SW1 on GigabitEthernet0/0.',
      points: 25,
      hint: 'no cdp enable is an interface line; no cdp run would switch CDP off for the whole router.',
      assertions: [
        {
          kind: 'fact',
          device: 'R1',
          fact: 'cdp.enabled',
          subject: 'GigabitEthernet0/1',
          equals: false,
          feedback: 'R1 still announces itself to ISP on GigabitEthernet0/1.',
        },
        { kind: 'fact', device: 'R1', fact: 'lldp.enabled', subject: 'GigabitEthernet0/1', equals: false, feedback: 'R1 runs LLDP toward ISP: stop it on GigabitEthernet0/1 as well.' },
        {
          kind: 'fact',
          device: 'R1',
          fact: 'cdp.enabled',
          equals: true,
          feedback: 'CDP is off for the whole of R1: the LAN side lost its map too.',
          misconception: 'discovery-off-globally',
        },
        { kind: 'neighbor', device: 'R1', protocol: 'cdp', neighbor: 'SW1', iface: 'GigabitEthernet0/0' },
        { kind: 'neighbor', device: 'R1', protocol: 'cdp', iface: 'GigabitEthernet0/1', exists: false },
      ],
      feedbackOnFail: 'Switch discovery off on the one port that faces a network you do not manage, and keep it on the ports toward your own devices.',
    },
    {
      id: 'quiet-users',
      title: 'Say nothing on the user ports',
      description:
        'SW1 FastEthernet0/1 and FastEthernet0/2 run neither CDP nor LLDP, nor does SW2 FastEthernet0/1; SW1 still runs CDP, and LLDP still runs on the link between the switches.',
      points: 25,
      hint: 'LLDP is switched off on a port in two directions: no lldp transmit and no lldp receive.',
      assertions: [
        { kind: 'fact', device: 'SW1', fact: 'cdp.enabled', subject: 'FastEthernet0/1', equals: false, feedback: 'SW1 FastEthernet0/1 still sends CDP to PC1.' },
        { kind: 'fact', device: 'SW1', fact: 'cdp.enabled', subject: 'FastEthernet0/2', equals: false, feedback: 'SW1 FastEthernet0/2 still sends CDP to PC2.' },
        { kind: 'fact', device: 'SW1', fact: 'lldp.enabled', subject: 'FastEthernet0/1', equals: false, feedback: 'LLDP still runs on SW1 FastEthernet0/1 (transmit, receive or both).' },
        { kind: 'fact', device: 'SW1', fact: 'lldp.enabled', subject: 'FastEthernet0/2', equals: false, feedback: 'LLDP still runs on SW1 FastEthernet0/2 (transmit, receive or both).' },
        { kind: 'fact', device: 'SW2', fact: 'lldp.enabled', subject: 'FastEthernet0/1', equals: false, feedback: 'LLDP still runs on SW2 FastEthernet0/1 (transmit, receive or both).' },
        { kind: 'fact', device: 'SW1', fact: 'cdp.enabled', equals: true, feedback: 'CDP is off for the whole of SW1.', misconception: 'discovery-off-globally' },
        { kind: 'fact', device: 'SW1', fact: 'lldp.enabled', subject: 'GigabitEthernet0/2', equals: true, feedback: 'LLDP no longer runs on the link between the switches.' },
        // both ends of the link between the switches (W5 fix #20): `no lldp run` on SW2 is the same mistake
        { kind: 'fact', device: 'SW2', fact: 'lldp.enabled', subject: 'GigabitEthernet0/1', equals: true, feedback: "LLDP no longer runs on SW2's end of the link between the switches.", misconception: 'discovery-off-globally' },
      ],
      feedbackOnFail: 'A user port never needs discovery: anyone who plugs a laptop in could read what the switch announces.',
    },
  ],
  solution: {
    R1: ['interface GigabitEthernet0/0', 'description link to SW1 Gi0/1', 'interface GigabitEthernet0/1', 'description link to ISP Gi0/0', 'no cdp enable'],
    SW1: [
      'lldp run',
      'interface GigabitEthernet0/1',
      'description link to R1 Gi0/0',
      'interface GigabitEthernet0/2',
      'description link to SW2 Gi0/1',
      'interface FastEthernet0/1',
      'no cdp enable',
      'no lldp transmit',
      'no lldp receive',
      'interface FastEthernet0/2',
      'no cdp enable',
      'no lldp transmit',
      'no lldp receive',
    ],
    SW2: ['interface GigabitEthernet0/1', 'description link to SW1 Gi0/2', 'interface FastEthernet0/1', 'no lldp transmit', 'no lldp receive'],
  },
};

/** The CCNA 3 discovery labs (lesson 28). */
export const CCNA3_DISCOVERY_LABS: readonly ScenarioInfo[] = [ccna3DiscoverNeighbours];
