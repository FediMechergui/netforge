/**
 * sim/scenarios/ccna2/fhrp.ts — the CCNA 2 first-hop redundancy lab [SHOULD S2] (ARCHITECTURE-P2 §11.1, §11.2, D15,
 * §3.10).
 *
 *   • `ccna2-hsrp-gateway` — lesson 21 "Hot-standby gateways" (module "Gateway redundancy"): two routers share a
 *     user LAN and a server LAN. The server LAN already has a complete standby pair (group 20, R1 active); on the user
 *     LAN R2 stands alone in group 10 and the hosts still point at R1's own address, so they lose the network with R1.
 *     The student joins R1 to group 10 with a higher priority and preemption — R1 then takes the active role away from
 *     R2, which it can do only because it preempts — points the hosts at the virtual address, and proves that R2
 *     carries the LAN when R1 loses power.
 *
 * The world is P2-profile (`topology(…, { profile: 'P2' })`); the lesson is not about spanning tree, so every switch
 * port facing a host or a router is an edge port (`spanning-tree portfast`) in the startup configuration (§11.2) —
 * which is also what lets a router that joins a group hear its peer at once (accept.p2.hsrp). Tasks read structured
 * state only (sim/lab-checks.ts): `fhrp` (state, virtual address, priority, preemption of a group), `table` for the
 * protocol version of the row, `route` for the gateway a host installed, and `connectivity` — with `then` (R1 active
 * in the settled copy, so the failover really moves the role) and, after R1 is powered off, `then` (R2 active in that
 * clone) for the failover. All wording is original (§0 rule 6); the protocol is
 * named only as the CCNA vocabulary names it.
 *
 * A lab file imports only the contracts, `../kit.js` and `../templates.js` — never `./index.js`, `../index.js` or
 * the engine barrel — so the catalogue stays an acyclic graph of data modules (the arrays are read at module scope).
 *
 * ponytail: the failover check powers R1 off instead of shutting its user-LAN interface. With only that interface
 * down R1 would stay active on the server LAN (group 20) and route the replies to a user LAN it no longer reaches —
 * keeping the two groups in step needs object tracking, which NetForge defers (ARCHITECTURE-P2 §12.1). A power loss
 * moves both groups to R2 together, which is the failure this lesson is about.
 */
import type { ScenarioInfo } from '../../../contracts/scenario.js';
import { MASK24, PC, ROUTER, SERVER, SWITCH, accessPort, configText, device, link, section, topology } from '../kit.js';
import { pcConfig } from '../templates.js';

/** The standby group of the user LAN, and its virtual gateway address. */
export const HSRP_USER_GROUP = 10;
export const HSRP_USER_VIRTUAL = '192.168.10.1';
/** The standby group of the server LAN (complete in the startup configuration), and its virtual gateway address. */
export const HSRP_SERVER_GROUP = 20;
export const HSRP_SERVER_VIRTUAL = '192.168.20.1';
/** R1's own address on the user LAN: the hosts' gateway before the lab (a single point of failure). */
export const HSRP_R1_USER_ADDRESS = '192.168.10.2';
/** The priority that makes R1 the preferred router (the default is 100). */
export const HSRP_R1_PRIORITY = 110;

/** A switch whose listed ports face hosts or routers, so each is an edge port (the lesson is not about spanning tree). */
function edgeSwitch(hostname: string, ports: readonly string[]): string {
  return configText([[`hostname ${hostname}`], ...ports.map((p) => accessPort(p, 1, { portfast: true }))]);
}

/** R1 before the lab: addressed on both LANs, active router of the server group, not yet in the user group. */
function r1Config(): string {
  return configText([
    ['hostname R1'],
    section('interface GigabitEthernet0/0', [`ip address ${HSRP_R1_USER_ADDRESS} ${MASK24}`, 'no shutdown']),
    section('interface GigabitEthernet0/1', [
      `ip address 192.168.20.2 ${MASK24}`,
      'standby version 2',
      `standby ${HSRP_SERVER_GROUP} ip ${HSRP_SERVER_VIRTUAL}`,
      `standby ${HSRP_SERVER_GROUP} priority ${HSRP_R1_PRIORITY}`,
      `standby ${HSRP_SERVER_GROUP} preempt`,
      'no shutdown',
    ]),
  ]);
}

/** R2 before the lab: the only member of the user group (so it is active there), standby router of the server group. */
function r2Config(): string {
  return configText([
    ['hostname R2'],
    section('interface GigabitEthernet0/0', [`ip address 192.168.10.3 ${MASK24}`, 'standby version 2', `standby ${HSRP_USER_GROUP} ip ${HSRP_USER_VIRTUAL}`, 'no shutdown']),
    section('interface GigabitEthernet0/1', [`ip address 192.168.20.3 ${MASK24}`, 'standby version 2', `standby ${HSRP_SERVER_GROUP} ip ${HSRP_SERVER_VIRTUAL}`, 'no shutdown']),
  ]);
}

/** Two routers on two LANs: the server LAN has its standby pair, the user LAN only half of one. */
export const ccna2HsrpGateway: ScenarioInfo = {
  name: 'ccna2-hsrp-gateway',
  category: 'ccna2-lab',
  labType: 'guided',
  course: 'CCNA 2',
  topic: 'Gateway redundancy',
  title: 'A gateway that survives a router',
  description:
    'Two routers serve a user LAN, but the hosts use one of them as their gateway and lose the network when it fails. Finish the standby group the second router started, let the preferred router take the active role, and move the hosts to the virtual gateway address.',
  objectives: [
    'Join a router to a standby group with a shared virtual address',
    'Choose the active router with a priority, and let it take the role back with preemption',
    'Point hosts at a virtual gateway address instead of a router of their own',
    'Watch the standby router take over when the active one fails',
  ],
  tags: ['first-hop redundancy', 'hsrp', 'standby group', 'virtual gateway', 'preemption', 'failover'],
  difficulty: 2,
  estimatedMinutes: 20,
  requires: [PC, ROUTER, SERVER, SWITCH],
  seed: 221,
  instructions: [
    '## What you have',
    '',
    `PC1 and PC2 share the user LAN \`192.168.10.0/24\` (SW1) with two routers: R1 (\`.2\`) and R2 (\`.3\`). Both routers also reach the server LAN \`192.168.20.0/24\` (SW2), where SRV (\`192.168.20.100\`) uses the virtual gateway \`${HSRP_SERVER_VIRTUAL}\` of standby group ${HSRP_SERVER_GROUP}: that pair is complete, R1 active and R2 standby.`,
    '',
    `The user LAN is only half done. R2 stands alone in standby group ${HSRP_USER_GROUP} with the virtual address \`${HSRP_USER_VIRTUAL}\`, so it is the active router there, while the PCs still use R1's own address \`${HSRP_R1_USER_ADDRESS}\` as their gateway: if R1 fails, so does their network.`,
    '',
    '## What to do',
    '',
    `- Read \`show standby brief\` on both routers: group ${HSRP_SERVER_GROUP} has two members, group ${HSRP_USER_GROUP} one.`,
    `- On R1 \`GigabitEthernet0/0\`, join group ${HSRP_USER_GROUP} with the virtual address \`${HSRP_USER_VIRTUAL}\`. Use version 2, as R2 does: two versions never hear each other.`,
    `- Give R1 priority ${HSRP_R1_PRIORITY} and let it preempt. Without preemption it would wait as standby behind R2, which became active first.`,
    `- Point PC1 and PC2 at the virtual gateway \`${HSRP_USER_VIRTUAL}\`.`,
    '- Ping SRV from PC1. Then switch R1 off and ping again: after a few lost replies R2 answers for both virtual addresses, and the PCs never notice which router it is. Switch R1 back on and watch it take the active role back.',
    '',
    '*The virtual address comes with a virtual MAC address, so the hosts keep the same gateway entry whichever router is active.*',
  ].join('\n'),
  build: () =>
    topology(
      221,
      [
        device('pc1', PC, 'PC1', 80, 170, pcConfig('PC1', '192.168.10.10', MASK24, HSRP_R1_USER_ADDRESS)),
        device('pc2', PC, 'PC2', 80, 390, pcConfig('PC2', '192.168.10.11', MASK24, HSRP_R1_USER_ADDRESS)),
        device('sw1', SWITCH, 'SW1', 260, 280, edgeSwitch('SW1', ['FastEthernet0/1', 'FastEthernet0/2', 'GigabitEthernet0/1', 'GigabitEthernet0/2'])),
        device('r1', ROUTER, 'R1', 460, 170, r1Config()),
        device('r2', ROUTER, 'R2', 460, 390, r2Config()),
        device('sw2', SWITCH, 'SW2', 660, 280, edgeSwitch('SW2', ['FastEthernet0/1', 'GigabitEthernet0/1', 'GigabitEthernet0/2'])),
        device('srv', SERVER, 'SRV', 850, 280, pcConfig('SRV', '192.168.20.100', MASK24, HSRP_SERVER_VIRTUAL)),
      ],
      [
        link('l_pc1_sw1', 'pc1', 'GigabitEthernet0', 'sw1', 'FastEthernet0/1'),
        link('l_pc2_sw1', 'pc2', 'GigabitEthernet0', 'sw1', 'FastEthernet0/2'),
        link('l_sw1_r1', 'sw1', 'GigabitEthernet0/1', 'r1', 'GigabitEthernet0/0'),
        link('l_sw1_r2', 'sw1', 'GigabitEthernet0/2', 'r2', 'GigabitEthernet0/0'),
        link('l_r1_sw2', 'r1', 'GigabitEthernet0/1', 'sw2', 'GigabitEthernet0/1'),
        link('l_r2_sw2', 'r2', 'GigabitEthernet0/1', 'sw2', 'GigabitEthernet0/2'),
        link('l_srv_sw2', 'srv', 'GigabitEthernet0', 'sw2', 'FastEthernet0/1'),
      ],
      ['Complete the standby group of the user LAN', 'Make R1 the preferred active router', 'Move the hosts to the virtual gateway', 'Survive the loss of R1'],
      'Two routers share one virtual address and a virtual MAC; the active one answers for them, the standby one waits for its hellos to stop.',
      { profile: 'P2' },
    ),
  tasks: [
    {
      id: 'join-group',
      title: 'Join R1 to the user group',
      description: `R1 GigabitEthernet0/0 is a version 2 member of group ${HSRP_USER_GROUP} with the virtual address ${HSRP_USER_VIRTUAL}.`,
      points: 20,
      hint: `The group number comes first: standby ${HSRP_USER_GROUP} ip …`,
      assertions: [
        { kind: 'fhrp', device: 'R1', iface: 'GigabitEthernet0/0', group: HSRP_USER_GROUP, virtualIp: HSRP_USER_VIRTUAL },
        { kind: 'table', device: 'R1', table: 'hsrp', where: { iface: 'GigabitEthernet0/0', group: HSRP_USER_GROUP, version: 2 }, exists: true },
      ],
      feedbackOnFail: 'Both routers of a group need the same group number, the same virtual address and the same version.',
    },
    {
      id: 'preferred-active',
      title: 'Make R1 the active router',
      description: `R1 runs group ${HSRP_USER_GROUP} with priority ${HSRP_R1_PRIORITY} and preemption, and has taken the active role; R2 is its standby.`,
      points: 25,
      dependsOn: ['join-group'],
      hint: 'A higher priority alone does not unseat a router that is already active: that takes preemption.',
      assertions: [
        { kind: 'fhrp', device: 'R1', iface: 'GigabitEthernet0/0', group: HSRP_USER_GROUP, state: 'active', priority: HSRP_R1_PRIORITY, preempt: true },
        { kind: 'fhrp', device: 'R2', iface: 'GigabitEthernet0/0', group: HSRP_USER_GROUP, state: 'standby' },
      ],
      feedbackOnFail: 'If R2 is still active, R1 either does not preempt, has not a higher priority, or does not hear R2 (check the version).',
    },
    {
      id: 'virtual-gateway',
      title: 'Point the hosts at the virtual gateway',
      description: `PC1 and PC2 send everything off their LAN to ${HSRP_USER_VIRTUAL}.`,
      points: 15,
      assertions: [
        { kind: 'route', device: 'PC1', destination: '192.168.20.100', network: '0.0.0.0/0', nextHop: HSRP_USER_VIRTUAL },
        { kind: 'route', device: 'PC2', destination: '192.168.20.100', network: '0.0.0.0/0', nextHop: HSRP_USER_VIRTUAL },
      ],
      feedbackOnFail: 'A host that points at the real address of one router loses its gateway with that router.',
    },
    {
      id: 'survive-failure',
      title: 'Survive the loss of R1',
      description: 'PC1 reaches SRV while R1 is the active router of the user group, and still does once R1 has lost power: R2 has become the active router.',
      points: 40,
      dependsOn: ['preferred-active', 'virtual-gateway'],
      assertions: [
        // before the failure R1 carries the user LAN, so the power-off below really moves the active role to R2
        {
          kind: 'connectivity',
          from: 'PC1',
          to: 'SRV',
          expect: 'success',
          then: [{ kind: 'fhrp', device: 'R1', iface: 'GigabitEthernet0/0', group: HSRP_USER_GROUP, state: 'active' }],
        },
        {
          kind: 'connectivity',
          from: 'PC1',
          to: 'SRV',
          expect: 'success',
          after: [{ powerOff: 'R1' }],
          then: [{ kind: 'fhrp', device: 'R2', iface: 'GigabitEthernet0/0', group: HSRP_USER_GROUP, state: 'active' }],
        },
        { kind: 'connectivity', from: 'PC2', to: 'SRV', expect: 'success', after: [{ powerOff: 'R1' }] },
      ],
      feedbackOnFail: 'When R1 goes down, only a host whose gateway is the virtual address follows R2.',
    },
  ],
  solution: {
    R1: [
      'interface GigabitEthernet0/0',
      'standby version 2',
      `standby ${HSRP_USER_GROUP} ip ${HSRP_USER_VIRTUAL}`,
      `standby ${HSRP_USER_GROUP} priority ${HSRP_R1_PRIORITY}`,
      `standby ${HSRP_USER_GROUP} preempt`,
      'exit',
    ],
    PC1: [`ip address 192.168.10.10 ${MASK24} ${HSRP_USER_VIRTUAL}`],
    PC2: [`ip address 192.168.10.11 ${MASK24} ${HSRP_USER_VIRTUAL}`],
  },
};

/** The first-hop redundancy labs, in course order. */
export const CCNA2_FHRP_LABS: readonly ScenarioInfo[] = [ccna2HsrpGateway];
