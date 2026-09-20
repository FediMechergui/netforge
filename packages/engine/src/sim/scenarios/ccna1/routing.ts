/**
 * sim/scenarios/ccna1/routing.ts — the CCNA 1 routing and subnetting labs (ARCHITECTURE-P1 §4.13, §8.2 W6).
 *
 *   • `ccna1-two-subnets`      — one router joins two LANs; its interfaces start down and unaddressed.
 *   • `ccna1-static-routes`    — three routers know only their own links until static routes are written.
 *   • `ccna1-subnetting-plan`  — apply a /26 plan taken from one /24 (opens the subnetting concept view).
 *   • `ccna1-traceroute-path`  — a wrong next hop sends packets back where they came from; trace and repair it.
 *
 * All addressing is documentation space, all wording is our own (§1.6).
 *
 * ponytail: the transit links are /30, so each one carries exactly two usable addresses (.1 and .2) — the third
 * is the broadcast address and is never assigned. The trace lab reuses the chain of the static-routing lab with one
 * route pointed the wrong way, rather than inventing a second five-device world.
 */
import type { ScenarioInfo } from '../../../contracts/scenario.js';
import { MASK24, MASK26, MASK30, PC, ROUTER, SWITCH, device, link, topology } from '../kit.js';
import { pcConfig, routerConfig } from '../templates.js';
import { bareHost } from './foundations.js';

/** A router that carries nothing but its name (interfaces stay down and unaddressed). */
function bareRouter(hostname: string): string {
  return [`hostname ${hostname}`, '!', 'end', ''].join('\n');
}

// ── two subnets through one router ──────────────────────────────────────────

/** PC1 – SW1 – R1 – SW2 – PC2 with both router interfaces still shut. */
export const ccna1TwoSubnets: ScenarioInfo = {
  name: 'ccna1-two-subnets',
  category: 'ccna1-lab',
  labType: 'build',
  course: 'CCNA 1',
  topic: 'Routing',
  title: 'Join two subnets with a router',
  description: 'Two LANs are cabled to the same router, but its interfaces are down and have no addresses. Bring them up and let the hosts talk.',
  objectives: [
    'Address a router interface and enable it',
    'Recognise the connected routes an addressed interface creates',
    'Explain why a router is needed between two subnets',
  ],
  tags: ['routing', 'interfaces', 'connected routes', 'no shutdown'],
  difficulty: 2,
  estimatedMinutes: 20,
  requires: [PC, SWITCH, ROUTER],
  seed: 104,
  instructions: [
    '## What you have',
    '',
    'PC1 is in `192.168.11.0/24` and PC2 in `192.168.12.0/24`. Both hosts already point at the gateway address of their own subnet. R1 has neither address nor an enabled interface.',
    '',
    '## What to do',
    '',
    '- Give `GigabitEthernet0/0` the address `192.168.11.1/24` and enable it.',
    '- Give `GigabitEthernet0/1` the address `192.168.12.1/24` and enable it.',
    '- Check the routing table: two connected networks should appear.',
    '- Ping PC2 from PC1.',
  ].join('\n'),
  build: () =>
    topology(
      104,
      [
        device('pc1', PC, 'PC1', 100, 330, pcConfig('PC1', '192.168.11.10', MASK24, '192.168.11.1')),
        device('sw1', SWITCH, 'SW1', 260, 230),
        device('r1', ROUTER, 'R1', 420, 140, bareRouter('R1')),
        device('sw2', SWITCH, 'SW2', 580, 230),
        device('pc2', PC, 'PC2', 740, 330, pcConfig('PC2', '192.168.12.10', MASK24, '192.168.12.1')),
      ],
      [
        link('l_pc1_sw1', 'pc1', 'GigabitEthernet0', 'sw1', 'FastEthernet0/1'),
        link('l_sw1_r1', 'sw1', 'GigabitEthernet0/1', 'r1', 'GigabitEthernet0/0'),
        link('l_r1_sw2', 'r1', 'GigabitEthernet0/1', 'sw2', 'GigabitEthernet0/1'),
        link('l_sw2_pc2', 'sw2', 'FastEthernet0/1', 'pc2', 'GigabitEthernet0'),
      ],
      ['Address and enable both router interfaces', 'Ping between the two subnets'],
      'Each router interface belongs to one subnet and becomes the gateway of the hosts on it.',
    ),
  tasks: [
    {
      id: 'left-interface',
      title: 'Bring up the first LAN interface',
      description: 'GigabitEthernet0/0 carries 192.168.11.1/24 and is up.',
      points: 15,
      hint: 'A router interface stays down until it is enabled.',
      assertions: [
        { kind: 'port', device: 'R1', port: 'GigabitEthernet0/0', field: 'ipv4', equals: '192.168.11.1/24' },
        { kind: 'port', device: 'R1', port: 'GigabitEthernet0/0', field: 'operUp', equals: true },
      ],
    },
    {
      id: 'right-interface',
      title: 'Bring up the second LAN interface',
      description: 'GigabitEthernet0/1 carries 192.168.12.1/24 and is up.',
      points: 15,
      assertions: [
        { kind: 'port', device: 'R1', port: 'GigabitEthernet0/1', field: 'ipv4', equals: '192.168.12.1/24' },
        { kind: 'port', device: 'R1', port: 'GigabitEthernet0/1', field: 'operUp', equals: true },
      ],
    },
    {
      id: 'connected-routes',
      title: 'Find the connected networks',
      description: 'The routing table of R1 holds both LANs as connected networks.',
      points: 10,
      dependsOn: ['left-interface', 'right-interface'],
      assertions: [
        { kind: 'table', device: 'R1', table: 'rib', where: { network: '192.168.11.0', source: 'C' }, exists: true },
        { kind: 'table', device: 'R1', table: 'rib', where: { network: '192.168.12.0', source: 'C' }, exists: true },
      ],
    },
    {
      id: 'end-to-end',
      title: 'Ping across the router',
      description: 'PC1 gets replies from PC2.',
      points: 20,
      dependsOn: ['connected-routes'],
      assertions: [{ kind: 'connectivity', from: 'PC1', to: 'PC2', expect: 'success' }],
    },
  ],
  solution: {
    R1: [
      'interface GigabitEthernet0/0',
      `ip address 192.168.11.1 ${MASK24}`,
      'no shutdown',
      'exit',
      'interface GigabitEthernet0/1',
      `ip address 192.168.12.1 ${MASK24}`,
      'no shutdown',
      'exit',
    ],
  },
};

// ── static routes across three routers ──────────────────────────────────────

/** PC1 – R1 – R2 – R3 – PC3, every interface up, not one static route written. */
export const ccna1StaticRoutes: ScenarioInfo = {
  name: 'ccna1-static-routes',
  category: 'ccna1-lab',
  labType: 'build',
  course: 'CCNA 1',
  topic: 'Routing',
  title: 'Static routes across three routers',
  description: 'Three routers each know only the networks they touch. Write the static routes that carry traffic from one end of the chain to the other.',
  objectives: [
    'Write a static route to a network the router is not attached to',
    'See that a path must work in both directions',
    'Read the routing table and tell connected from static entries',
  ],
  tags: ['static routing', 'next hop', 'routing table', 'wan'],
  difficulty: 2,
  estimatedMinutes: 25,
  requires: [PC, ROUTER],
  seed: 105,
  instructions: [
    '## What you have',
    '',
    'PC1 (`10.1.0.0/24`) sits behind R1, PC3 (`10.3.0.0/24`) behind R3. The transit links are `10.0.12.0/30` between R1 and R2 and `10.0.23.0/30` between R2 and R3. Every interface is up.',
    '',
    '## What to do',
    '',
    '- On each router, add a static route for every network it cannot see from its own interfaces.',
    '- Remember the way back: a reply needs a route too.',
    '- Ping PC3 from PC1 and check the routing tables when it works.',
  ].join('\n'),
  build: () =>
    topology(
      105,
      [
        device('pc1', PC, 'PC1', 80, 330, pcConfig('PC1', '10.1.0.10', MASK24, '10.1.0.1')),
        device('r1', ROUTER, 'R1', 240, 170, routerConfig('R1', [
          { port: 'GigabitEthernet0/0', address: '10.1.0.1', mask: MASK24 },
          { port: 'GigabitEthernet0/1', address: '10.0.12.1', mask: MASK30 },
        ])),
        device('r2', ROUTER, 'R2', 430, 110, routerConfig('R2', [
          { port: 'GigabitEthernet0/0', address: '10.0.12.2', mask: MASK30 },
          { port: 'GigabitEthernet0/1', address: '10.0.23.1', mask: MASK30 },
        ])),
        device('r3', ROUTER, 'R3', 620, 170, routerConfig('R3', [
          { port: 'GigabitEthernet0/0', address: '10.0.23.2', mask: MASK30 },
          { port: 'GigabitEthernet0/1', address: '10.3.0.1', mask: MASK24 },
        ])),
        device('pc3', PC, 'PC3', 780, 330, pcConfig('PC3', '10.3.0.10', MASK24, '10.3.0.1')),
      ],
      [
        link('l_pc1_r1', 'pc1', 'GigabitEthernet0', 'r1', 'GigabitEthernet0/0'),
        link('l_r1_r2', 'r1', 'GigabitEthernet0/1', 'r2', 'GigabitEthernet0/0'),
        link('l_r2_r3', 'r2', 'GigabitEthernet0/1', 'r3', 'GigabitEthernet0/0'),
        link('l_r3_pc3', 'r3', 'GigabitEthernet0/1', 'pc3', 'GigabitEthernet0'),
      ],
      ['Write the static routes each router is missing', 'Ping from one end of the chain to the other'],
      'A router forwards only to networks it has a route for; static routing means writing every one of them by hand.',
    ),
  tasks: [
    {
      id: 'r1-routes',
      title: 'Give R1 a way east',
      description: 'R1 has a static route to 10.3.0.0/24.',
      points: 15,
      assertions: [{ kind: 'table', device: 'R1', table: 'rib', where: { network: '10.3.0.0', source: 'S', nextHop: '10.0.12.2' }, exists: true }],
    },
    {
      id: 'r2-routes',
      title: 'Give R2 both directions',
      description: 'R2 has static routes to 10.1.0.0/24 and 10.3.0.0/24.',
      points: 20,
      assertions: [
        { kind: 'table', device: 'R2', table: 'rib', where: { network: '10.1.0.0', source: 'S', nextHop: '10.0.12.1' }, exists: true },
        { kind: 'table', device: 'R2', table: 'rib', where: { network: '10.3.0.0', source: 'S', nextHop: '10.0.23.2' }, exists: true },
      ],
    },
    {
      id: 'r3-routes',
      title: 'Give R3 a way west',
      description: 'R3 has a static route to 10.1.0.0/24.',
      points: 15,
      assertions: [{ kind: 'table', device: 'R3', table: 'rib', where: { network: '10.1.0.0', source: 'S', nextHop: '10.0.23.1' }, exists: true }],
    },
    {
      id: 'end-to-end',
      title: 'Cross the whole chain',
      description: 'PC1 reaches PC3, and PC3 reaches PC1.',
      points: 25,
      dependsOn: ['r1-routes', 'r2-routes', 'r3-routes'],
      assertions: [
        { kind: 'connectivity', from: 'PC1', to: 'PC3', expect: 'success' },
        { kind: 'connectivity', from: 'PC3', to: 'PC1', expect: 'success' },
      ],
      feedbackOnFail: 'A ping needs a route on every router it passes, in both directions.',
    },
  ],
  solution: {
    R1: [`ip route 10.0.23.0 ${MASK30} 10.0.12.2`, `ip route 10.3.0.0 ${MASK24} 10.0.12.2`],
    R2: [`ip route 10.1.0.0 ${MASK24} 10.0.12.1`, `ip route 10.3.0.0 ${MASK24} 10.0.23.2`],
    R3: [`ip route 10.1.0.0 ${MASK24} 10.0.23.1`, `ip route 10.0.12.0 ${MASK30} 10.0.23.1`],
  },
};

// ── subnetting plan ─────────────────────────────────────────────────────────

/** Apply a four-way /26 split of one /24 to a router and three hosts. */
export const ccna1SubnettingPlan: ScenarioInfo = {
  name: 'ccna1-subnetting-plan',
  category: 'ccna1-lab',
  labType: 'concept',
  course: 'CCNA 1',
  topic: 'Subnetting',
  title: 'Apply a subnetting plan',
  description: 'One 192.168.60.0/24 is split into four equal subnets. Put the first two to work: address the router and the hosts so each side lands in the right block.',
  objectives: [
    'Split an address block into equal subnets and read their boundaries',
    'Pick usable host addresses inside a subnet',
    'Work out which subnet an address falls in from its mask',
  ],
  tags: ['subnetting', 'mask', 'addressing', 'planning'],
  difficulty: 2,
  estimatedMinutes: 25,
  requires: [PC, SWITCH, ROUTER],
  seed: 106,
  concept: 'subnetting',
  instructions: [
    '## The plan',
    '',
    'Borrow two bits from `192.168.60.0/24` and you get four subnets of 62 usable addresses, each with mask `255.255.255.192`:',
    '',
    '- subnet 1: `192.168.60.0/26`',
    '- subnet 2: `192.168.60.64/26`',
    '- subnet 3: `192.168.60.128/26`',
    '- subnet 4: `192.168.60.192/26`',
    '',
    '## What to do',
    '',
    '- Put PC1 (`.10`) and PC2 (`.11`) in subnet 1, with the router at `.1`.',
    '- Put PC3 (`.74`) in subnet 2, with the router at `.65`.',
    '- Use mask `255.255.255.192` everywhere and enable both router interfaces.',
    '- Open the [subnetting view](concept:subnetting) to check a boundary when you are unsure.',
  ].join('\n'),
  build: () =>
    topology(
      106,
      [
        device('pc1', PC, 'PC1', 90, 330, bareHost('PC1')),
        device('pc2', PC, 'PC2', 230, 380, bareHost('PC2')),
        device('sw1', SWITCH, 'SW1', 250, 230),
        device('r1', ROUTER, 'R1', 430, 140, bareRouter('R1')),
        device('sw2', SWITCH, 'SW2', 610, 230),
        device('pc3', PC, 'PC3', 760, 330, bareHost('PC3')),
      ],
      [
        link('l_pc1_sw1', 'pc1', 'GigabitEthernet0', 'sw1', 'FastEthernet0/1'),
        link('l_pc2_sw1', 'pc2', 'GigabitEthernet0', 'sw1', 'FastEthernet0/2'),
        link('l_sw1_r1', 'sw1', 'GigabitEthernet0/1', 'r1', 'GigabitEthernet0/0'),
        link('l_r1_sw2', 'r1', 'GigabitEthernet0/1', 'sw2', 'GigabitEthernet0/1'),
        link('l_sw2_pc3', 'sw2', 'FastEthernet0/1', 'pc3', 'GigabitEthernet0'),
      ],
      ['Address two /26 subnets from one /24', 'Prove each side lands in its own block'],
      'Two borrowed bits turn one /24 into four /26 blocks that start at .0, .64, .128 and .192.',
    ),
  tasks: [
    {
      id: 'router-subnet1',
      title: 'Router interface in subnet 1',
      description: 'GigabitEthernet0/0 carries 192.168.60.1 with mask 255.255.255.192 and is up.',
      points: 15,
      assertions: [
        { kind: 'port', device: 'R1', port: 'GigabitEthernet0/0', field: 'ipv4', equals: '192.168.60.1/26' },
        { kind: 'port', device: 'R1', port: 'GigabitEthernet0/0', field: 'operUp', equals: true },
      ],
    },
    {
      id: 'router-subnet2',
      title: 'Router interface in subnet 2',
      description: 'GigabitEthernet0/1 carries 192.168.60.65 with mask 255.255.255.192 and is up.',
      points: 15,
      hint: 'The second block starts 64 addresses after the first.',
      assertions: [
        { kind: 'port', device: 'R1', port: 'GigabitEthernet0/1', field: 'ipv4', equals: '192.168.60.65/26' },
        { kind: 'port', device: 'R1', port: 'GigabitEthernet0/1', field: 'operUp', equals: true },
      ],
    },
    {
      id: 'hosts-subnet1',
      title: 'Hosts of subnet 1',
      description: 'PC1 and PC2 carry .10 and .11 with a /26 mask and reach each other.',
      points: 20,
      assertions: [
        { kind: 'port', device: 'PC1', port: 'GigabitEthernet0', field: 'ipv4', equals: '192.168.60.10/26' },
        { kind: 'port', device: 'PC2', port: 'GigabitEthernet0', field: 'ipv4', equals: '192.168.60.11/26' },
        { kind: 'connectivity', from: 'PC1', to: 'PC2', expect: 'success' },
      ],
    },
    {
      id: 'across-subnets',
      title: 'Across the two subnets',
      description: 'PC3 carries .74/26 and exchanges traffic with PC1 through the router.',
      points: 25,
      dependsOn: ['router-subnet1', 'router-subnet2'],
      assertions: [
        { kind: 'port', device: 'PC3', port: 'GigabitEthernet0', field: 'ipv4', equals: '192.168.60.74/26' },
        { kind: 'connectivity', from: 'PC1', to: 'PC3', expect: 'success' },
      ],
      feedbackOnFail: 'With a /26 mask, .10 and .74 are in different blocks: each host needs the gateway of its own block.',
    },
  ],
  solution: {
    R1: [
      'interface GigabitEthernet0/0',
      `ip address 192.168.60.1 ${MASK26}`,
      'no shutdown',
      'exit',
      'interface GigabitEthernet0/1',
      `ip address 192.168.60.65 ${MASK26}`,
      'no shutdown',
      'exit',
    ],
    PC1: [`ip address 192.168.60.10 ${MASK26} 192.168.60.1`],
    PC2: [`ip address 192.168.60.11 ${MASK26} 192.168.60.1`],
    PC3: [`ip address 192.168.60.74 ${MASK26} 192.168.60.65`],
  },
};

// ── traceroute and a wrong next hop ─────────────────────────────────────────

/** A three-router chain whose middle router points the far LAN back where it came from. */
export const ccna1TraceroutePath: ScenarioInfo = {
  name: 'ccna1-traceroute-path',
  category: 'ccna1-lab',
  labType: 'troubleshoot',
  course: 'CCNA 1',
  topic: 'Troubleshooting',
  title: 'Trace the path and fix a wrong next hop',
  description: 'A ping across the chain never arrives. Trace the path, find the router that sends packets back where they came from and correct its route.',
  objectives: [
    'Follow a path hop by hop with a trace',
    'Read a next hop in the routing table and judge whether it points forward',
    'Replace a wrong static route without breaking the working ones',
  ],
  tags: ['traceroute', 'static routing', 'troubleshooting', 'next hop'],
  difficulty: 3,
  estimatedMinutes: 25,
  requires: [PC, ROUTER],
  seed: 107,
  instructions: [
    '## What you see',
    '',
    'PC1 cannot reach PC3. Every interface is up and every router has routes, so the addressing is not the problem.',
    '',
    '## What to do',
    '',
    '- Run `tracert 10.3.0.10` on PC1 and watch where the path stops making progress.',
    '- Look at the static routes of that router and compare the next hop with the link it should use.',
    '- Remove the wrong route and write the right one.',
    '- Trace again: the path should list each router once and end at PC3.',
  ].join('\n'),
  build: () =>
    topology(
      107,
      [
        device('pc1', PC, 'PC1', 80, 330, pcConfig('PC1', '10.1.0.10', MASK24, '10.1.0.1')),
        device('r1', ROUTER, 'R1', 240, 170, routerConfig('R1', [
          { port: 'GigabitEthernet0/0', address: '10.1.0.1', mask: MASK24 },
          { port: 'GigabitEthernet0/1', address: '10.0.12.1', mask: MASK30 },
        ], [`10.0.23.0 ${MASK30} 10.0.12.2`, `10.3.0.0 ${MASK24} 10.0.12.2`])),
        device('r2', ROUTER, 'R2', 430, 110, routerConfig('R2', [
          { port: 'GigabitEthernet0/0', address: '10.0.12.2', mask: MASK30 },
          { port: 'GigabitEthernet0/1', address: '10.0.23.1', mask: MASK30 },
        ], [`10.1.0.0 ${MASK24} 10.0.12.1`, `10.3.0.0 ${MASK24} 10.0.12.1`])),
        device('r3', ROUTER, 'R3', 620, 170, routerConfig('R3', [
          { port: 'GigabitEthernet0/0', address: '10.0.23.2', mask: MASK30 },
          { port: 'GigabitEthernet0/1', address: '10.3.0.1', mask: MASK24 },
        ], [`10.1.0.0 ${MASK24} 10.0.23.1`, `10.0.12.0 ${MASK30} 10.0.23.1`])),
        device('pc3', PC, 'PC3', 780, 330, pcConfig('PC3', '10.3.0.10', MASK24, '10.3.0.1')),
      ],
      [
        link('l_pc1_r1', 'pc1', 'GigabitEthernet0', 'r1', 'GigabitEthernet0/0'),
        link('l_r1_r2', 'r1', 'GigabitEthernet0/1', 'r2', 'GigabitEthernet0/0'),
        link('l_r2_r3', 'r2', 'GigabitEthernet0/1', 'r3', 'GigabitEthernet0/0'),
        link('l_r3_pc3', 'r3', 'GigabitEthernet0/1', 'pc3', 'GigabitEthernet0'),
      ],
      ['Trace the path from PC1', 'Find and repair the wrong next hop'],
      'One static route points at the wrong neighbour, so packets for the far LAN keep bouncing between two routers until their hop budget runs out.',
    ),
  tasks: [
    {
      id: 'wrong-route-gone',
      title: 'Remove the wrong route',
      description: 'R2 no longer sends 10.3.0.0/24 back towards R1.',
      points: 20,
      hint: 'The next hop of that route is on the link the packet just arrived on.',
      assertions: [{ kind: 'table', device: 'R2', table: 'rib', where: { network: '10.3.0.0', nextHop: '10.0.12.1' }, exists: false }],
    },
    {
      id: 'right-route',
      title: 'Point the route forward',
      description: 'R2 reaches 10.3.0.0/24 through R3 at 10.0.23.2.',
      points: 20,
      assertions: [{ kind: 'table', device: 'R2', table: 'rib', where: { network: '10.3.0.0', source: 'S', nextHop: '10.0.23.2' }, exists: true }],
    },
    {
      id: 'path-complete',
      title: 'The path completes',
      description: 'PC1 reaches PC3, and PC3 reaches PC1.',
      points: 30,
      dependsOn: ['right-route'],
      assertions: [
        { kind: 'connectivity', from: 'PC1', to: 'PC3', expect: 'success' },
        { kind: 'connectivity', from: 'PC3', to: 'PC1', expect: 'success' },
      ],
    },
  ],
  solution: {
    R2: [`no ip route 10.3.0.0 ${MASK24} 10.0.12.1`, `ip route 10.3.0.0 ${MASK24} 10.0.23.2`],
  },
};
