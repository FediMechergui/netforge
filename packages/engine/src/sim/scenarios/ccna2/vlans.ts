/**
 * sim/scenarios/ccna2/vlans.ts — the CCNA 2 VLAN labs (ARCHITECTURE-P2 §11.1, §11.2).
 *
 *   • `ccna2-switch-management` — lesson 02 "Managing a switch" (module "Switches, revisited"): give a switch an
 *     address on the interface of its management VLAN and a default gateway, so it answers a technician on its own
 *     subnet and an administrator in another one, and make its remote lines ask for a local user.
 *   • `ccna2-vlan-access-ports` — lesson 05 "Access ports and the VLAN list" (module "VLANs"): create and name two
 *     VLANs, put access ports in them, and retire a leftover VLAN without stranding the port that still used it
 *     (VTP stays theory: the lesson explains it, no lab touches it).
 *
 * Both are P2-profile worlds (`topology(…, { profile: 'P2' })`): the switches boot with spanning tree on. Neither
 * lesson is about spanning tree, so every port facing a host or a router is an edge port (`spanning-tree portfast`)
 * in the startup configuration and forwards the moment its link comes up (§11.2). Tasks read structured state only
 * (sim/lab-checks.ts: `port`, `config`, `vlan`, `switchport`, `connectivity`), and every lab carries a reference
 * `solution` that `Simulation.configure` accepts as written (test/labs.ccna2.solutions.test.ts). All wording is
 * original (§0 rule 6).
 *
 * A lab file imports only the contracts, `../kit.js` and `../templates.js` — never `./index.js`, `../index.js` or
 * the engine barrel — so the catalogue stays an acyclic graph of data modules (the arrays are read at module scope).
 *
 * ponytail: the management lab gives the management VLAN and its two ports in the startup configuration (VLANs are
 * built by hand only from lesson 05 on), so its tasks are exactly the lesson's: the VLAN interface, the gateway and
 * the remote login. The unsolved worlds carry no answer, so every task that needs the student fails before they start.
 */
import type { ScenarioInfo } from '../../../contracts/scenario.js';
import { MASK24, PC, ROUTER, SWITCH, accessPort, configText, device, link, section, topology, vlanSections } from '../kit.js';
import { pcConfig, routerConfig } from '../templates.js';

// ── managing a switch ───────────────────────────────────────────────────────

/** The management VLAN of the switch-management lab. */
export const SWITCH_MGMT_VLAN = 99;
/** Name of the management VLAN (given in the startup configuration). */
export const SWITCH_MGMT_VLAN_NAME = 'MGMT';
/** Management address the reference solution gives SW1. */
export const SWITCH_MGMT_ADDRESS = '192.168.99.2';
/** Router address on the management subnet: the switch's default gateway. */
export const SWITCH_MGMT_GATEWAY = '192.168.99.1';
/** Local user the remote lines check (a teaching value). */
export const SWITCH_MGMT_USER = 'netadmin';
/** Password of that user (a teaching value). */
export const SWITCH_MGMT_USER_SECRET = 'granite-orbit-42';

/** SW1 before the lab: the management VLAN and its two edge ports, nothing else. */
function managementSwitchConfig(): string {
  return configText([
    ['hostname SW1'],
    ...vlanSections([{ id: SWITCH_MGMT_VLAN, name: SWITCH_MGMT_VLAN_NAME }]),
    accessPort('GigabitEthernet0/1', SWITCH_MGMT_VLAN, { portfast: true }),
    accessPort('FastEthernet0/24', SWITCH_MGMT_VLAN, { portfast: true }),
  ]);
}

/** A switch in its own management VLAN, a technician on the same subnet and an administrator one router away. */
export const ccna2SwitchManagement: ScenarioInfo = {
  name: 'ccna2-switch-management',
  category: 'ccna2-lab',
  labType: 'guided',
  course: 'CCNA 2',
  topic: 'Switches, revisited',
  title: 'Manage a switch from another subnet',
  description:
    'A new access switch already carries a management VLAN, but nobody can reach it. Address its VLAN interface, give it a default gateway so an administrator behind the router gets answers, and make remote sessions ask for a user.',
  objectives: [
    'Address the VLAN interface a switch is managed through and bring it up',
    'Explain why a switch that does not route still needs a default gateway',
    'Tell a management check from the same subnet from one across a router',
    'Make the remote lines of a switch ask for a local user name and password',
  ],
  tags: ['switch management', 'svi', 'default gateway', 'vty', 'management vlan'],
  difficulty: 1,
  estimatedMinutes: 20,
  requires: [PC, ROUTER, SWITCH],
  seed: 202,
  instructions: [
    '## What you have',
    '',
    `SW1 is an access switch whose management VLAN is ready: VLAN ${SWITCH_MGMT_VLAN} (\`${SWITCH_MGMT_VLAN_NAME}\`) holds the port toward R1 (\`GigabitEthernet0/1\`) and the port of the technician bench (\`FastEthernet0/24\`). TECH1 sits on that bench in \`192.168.99.0/24\`. ADMIN1 works in \`192.168.50.0/24\`, on the other side of R1, which routes between the two subnets and owns \`${SWITCH_MGMT_GATEWAY}\`.`,
    '',
    '## What to do',
    '',
    `- Create \`interface Vlan${SWITCH_MGMT_VLAN}\`, give it \`${SWITCH_MGMT_ADDRESS}/24\` and bring it up. Ping the switch from TECH1.`,
    '- Ping the switch from ADMIN1 before you go on: the requests arrive, but the switch has no way to send its replies to another subnet.',
    `- Set \`ip default-gateway ${SWITCH_MGMT_GATEWAY}\` on SW1 and ping it from ADMIN1 again.`,
    `- Create the local user \`${SWITCH_MGMT_USER}\` with a secret, and make \`line vty 0 4\` log users in against it (\`login local\`).`,
    '',
    '*A layer-2 switch never routes: its default gateway is used only by the traffic the switch itself sends, such as the replies to an administrator.*',
  ].join('\n'),
  build: () =>
    topology(
      202,
      [
        device('admin1', PC, 'ADMIN1', 100, 320, pcConfig('ADMIN1', '192.168.50.10', MASK24, '192.168.50.1')),
        device(
          'r1',
          ROUTER,
          'R1',
          300,
          160,
          routerConfig('R1', [
            { port: 'GigabitEthernet0/0', address: SWITCH_MGMT_GATEWAY, mask: MASK24 },
            { port: 'GigabitEthernet0/1', address: '192.168.50.1', mask: MASK24 },
          ]),
        ),
        device('sw1', SWITCH, 'SW1', 520, 160, managementSwitchConfig()),
        device('tech1', PC, 'TECH1', 700, 320, pcConfig('TECH1', '192.168.99.20', MASK24, SWITCH_MGMT_GATEWAY)),
      ],
      [
        link('l_admin1_r1', 'admin1', 'GigabitEthernet0', 'r1', 'GigabitEthernet0/1'),
        link('l_r1_sw1', 'r1', 'GigabitEthernet0/0', 'sw1', 'GigabitEthernet0/1'),
        link('l_tech1_sw1', 'tech1', 'GigabitEthernet0', 'sw1', 'FastEthernet0/24'),
      ],
      ['Address the management interface of SW1', 'Give SW1 a default gateway', 'Reach SW1 from both subnets', 'Protect the remote lines'],
      `SW1 is managed through interface Vlan${SWITCH_MGMT_VLAN}; like any host, it needs a gateway to answer anyone outside its own subnet.`,
      { profile: 'P2' },
    ),
  tasks: [
    {
      id: 'management-address',
      title: 'Address the management interface',
      description: `Vlan${SWITCH_MGMT_VLAN} carries ${SWITCH_MGMT_ADDRESS}/24 and is up.`,
      points: 15,
      hint: `The VLAN interface is created by selecting it: interface vlan ${SWITCH_MGMT_VLAN}.`,
      assertions: [
        { kind: 'port', device: 'SW1', port: `Vlan${SWITCH_MGMT_VLAN}`, field: 'ipv4', equals: `${SWITCH_MGMT_ADDRESS}/24` },
        { kind: 'port', device: 'SW1', port: `Vlan${SWITCH_MGMT_VLAN}`, field: 'operUp', equals: true },
      ],
      feedbackOnFail: `A VLAN interface starts shut, and it only comes up while VLAN ${SWITCH_MGMT_VLAN} exists and one of its ports is up.`,
    },
    {
      id: 'bench-reach',
      title: 'Reach the switch from its own subnet',
      description: 'TECH1 gets replies from the switch.',
      points: 10,
      dependsOn: ['management-address'],
      assertions: [{ kind: 'connectivity', from: 'TECH1', to: 'SW1', expect: 'success' }],
      feedbackOnFail: `TECH1 shares the management subnet, so it needs nothing but a working Vlan${SWITCH_MGMT_VLAN} interface.`,
    },
    {
      id: 'default-gateway',
      title: 'Give the switch a way out',
      description: `SW1 sends traffic for other subnets to ${SWITCH_MGMT_GATEWAY}.`,
      points: 15,
      hint: 'The gateway of a switch is a global configuration line, not an interface setting.',
      assertions: [{ kind: 'config', device: 'SW1', path: 'ip.default-gateway', equals: SWITCH_MGMT_GATEWAY }],
    },
    {
      id: 'remote-reach',
      title: 'Reach the switch from another subnet',
      description: 'ADMIN1, one router away, gets replies from the switch.',
      points: 20,
      dependsOn: ['management-address', 'default-gateway'],
      assertions: [{ kind: 'connectivity', from: 'ADMIN1', to: 'SW1', expect: 'success' }],
      feedbackOnFail: 'The requests reach the switch either way; its replies to another subnet leave only through the default gateway.',
    },
    {
      id: 'remote-login',
      title: 'Ask remote sessions for a user',
      description: `The user ${SWITCH_MGMT_USER} exists and the remote lines log users in against the local user list.`,
      points: 15,
      hint: 'Two pieces: a username line in global configuration, and login local under the vty lines.',
      assertions: [
        { kind: 'config', device: 'SW1', path: `username.${SWITCH_MGMT_USER}`, exists: true },
        { kind: 'config', device: 'SW1', path: 'line.vty.login', equals: 'local' },
      ],
      feedbackOnFail: 'A plain login on the vty lines asks for the line password; login local asks for a user from the local list instead.',
    },
  ],
  solution: {
    SW1: [
      `interface Vlan${SWITCH_MGMT_VLAN}`,
      `ip address ${SWITCH_MGMT_ADDRESS} ${MASK24}`,
      'no shutdown',
      'exit',
      `ip default-gateway ${SWITCH_MGMT_GATEWAY}`,
      `username ${SWITCH_MGMT_USER} secret ${SWITCH_MGMT_USER_SECRET}`,
      'line vty 0 4',
      'login local',
      'exit',
    ],
  },
};

// ── access ports and the VLAN list ──────────────────────────────────────────

/** SW1 before the lab: a leftover project VLAN still holding one port, and every host port an edge port. */
function flatSwitchConfig(): string {
  const edge = (port: string): string[] => section(`interface ${port}`, ['spanning-tree portfast']);
  return configText([
    ['hostname SW1'],
    ...vlanSections([{ id: 30, name: 'PROJECT' }]),
    edge('FastEthernet0/1'),
    edge('FastEthernet0/2'),
    edge('FastEthernet0/3'),
    edge('FastEthernet0/4'),
    accessPort('FastEthernet0/5', 30, { portfast: true }),
  ]);
}

/** Five PCs on one switch that is still flat, apart from a VLAN nobody needs any more. */
export const ccna2VlanAccessPorts: ScenarioInfo = {
  name: 'ccna2-vlan-access-ports',
  category: 'ccna2-lab',
  labType: 'build',
  course: 'CCNA 2',
  topic: 'VLANs',
  title: 'Create VLANs and assign access ports',
  description:
    'One switch serves a sales team and a staff team, and still carries the VLAN of a finished project. Build and name the two team VLANs, place every PC in its VLAN, and retire the old VLAN without leaving its port stranded.',
  objectives: [
    'Create VLANs and give them names',
    'Make a port an access port and choose its VLAN',
    'Read the VLAN list to see which ports each VLAN holds',
    'Remove a VLAN safely by moving its ports first, and explain what happens to a port whose VLAN disappears',
  ],
  tags: ['vlan', 'access port', 'vlan database', 'show vlan'],
  difficulty: 1,
  estimatedMinutes: 20,
  requires: [PC, SWITCH],
  seed: 205,
  instructions: [
    '## What you have',
    '',
    'SW1 serves five PCs. PC1 and PC2 belong to sales and already use `192.168.10.0/24`; PC3, PC4 and PC5 belong to staff and use `192.168.20.0/24`. Every port except one is still in VLAN 1. The exception is `FastEthernet0/5` (PC5), left in VLAN 30 (`PROJECT`) by a project that has ended.',
    '',
    '## What to do',
    '',
    '- Create VLAN 10 named `SALES` and VLAN 20 named `STAFF`.',
    '- Make `FastEthernet0/1` and `FastEthernet0/2` access ports in VLAN 10.',
    '- Make `FastEthernet0/3`, `FastEthernet0/4` and `FastEthernet0/5` access ports in VLAN 20; `interface range` saves typing.',
    '- Remove VLAN 30, then check `show vlan brief`: VLAN 20 should list three ports and VLAN 30 should be gone.',
    '- Ping inside each team: PC1 to PC2, PC3 to PC4 and PC5 to PC3.',
    '',
    '*Delete a VLAN before you move its ports and those ports stay in a VLAN that no longer exists: they stop forwarding until you give them a new one.*',
  ].join('\n'),
  build: () =>
    topology(
      205,
      [
        device('sw1', SWITCH, 'SW1', 400, 140, flatSwitchConfig()),
        device('pc1', PC, 'PC1', 100, 330, pcConfig('PC1', '192.168.10.11', MASK24)),
        device('pc2', PC, 'PC2', 250, 380, pcConfig('PC2', '192.168.10.12', MASK24)),
        device('pc3', PC, 'PC3', 400, 400, pcConfig('PC3', '192.168.20.13', MASK24)),
        device('pc4', PC, 'PC4', 550, 380, pcConfig('PC4', '192.168.20.14', MASK24)),
        device('pc5', PC, 'PC5', 700, 330, pcConfig('PC5', '192.168.20.15', MASK24)),
      ],
      [
        link('l_pc1_sw1', 'pc1', 'GigabitEthernet0', 'sw1', 'FastEthernet0/1'),
        link('l_pc2_sw1', 'pc2', 'GigabitEthernet0', 'sw1', 'FastEthernet0/2'),
        link('l_pc3_sw1', 'pc3', 'GigabitEthernet0', 'sw1', 'FastEthernet0/3'),
        link('l_pc4_sw1', 'pc4', 'GigabitEthernet0', 'sw1', 'FastEthernet0/4'),
        link('l_pc5_sw1', 'pc5', 'GigabitEthernet0', 'sw1', 'FastEthernet0/5'),
      ],
      ['Create and name the sales and staff VLANs', 'Put every PC in its VLAN', 'Retire the project VLAN'],
      'Each VLAN is its own broadcast domain and its own subnet: a port belongs to exactly one VLAN, and a VLAN that is deleted takes nothing with it but its name.',
      { profile: 'P2' },
    ),
  tasks: [
    {
      id: 'create-vlans',
      title: 'Create and name the VLANs',
      description: 'VLAN 10 exists as SALES and VLAN 20 as STAFF.',
      points: 15,
      hint: 'A VLAN is created in global configuration; its name is set inside it.',
      assertions: [
        { kind: 'vlan', device: 'SW1', vlan: 10, name: 'SALES' },
        { kind: 'vlan', device: 'SW1', vlan: 20, name: 'STAFF' },
      ],
      feedbackOnFail: 'A VLAN created through an access port exists but keeps its automatic name; name it inside the VLAN itself.',
    },
    {
      id: 'sales-ports',
      title: 'Place the sales PCs',
      description: 'FastEthernet0/1 and FastEthernet0/2 are access ports of VLAN 10, and PC1 reaches PC2.',
      points: 20,
      dependsOn: ['create-vlans'],
      assertions: [
        { kind: 'switchport', device: 'SW1', port: 'FastEthernet0/1', mode: 'access', accessVlan: 10 },
        { kind: 'switchport', device: 'SW1', port: 'FastEthernet0/2', mode: 'access', accessVlan: 10 },
        { kind: 'vlan', device: 'SW1', vlan: 10, accessPorts: ['FastEthernet0/1', 'FastEthernet0/2'], match: 'exactly' },
        { kind: 'connectivity', from: 'PC1', to: 'PC2', expect: 'success' },
      ],
      feedbackOnFail: 'Fix the port as an access port first, then choose its VLAN; a port left to negotiate can still end up somewhere else.',
    },
    {
      id: 'staff-ports',
      title: 'Place the staff PCs',
      description: 'FastEthernet0/3 and FastEthernet0/4 are access ports of VLAN 20, and PC3 reaches PC4.',
      points: 20,
      dependsOn: ['create-vlans'],
      assertions: [
        { kind: 'switchport', device: 'SW1', port: 'FastEthernet0/3', mode: 'access', accessVlan: 20 },
        { kind: 'switchport', device: 'SW1', port: 'FastEthernet0/4', mode: 'access', accessVlan: 20 },
        { kind: 'vlan', device: 'SW1', vlan: 20, accessPorts: ['FastEthernet0/3', 'FastEthernet0/4'] },
        { kind: 'connectivity', from: 'PC3', to: 'PC4', expect: 'success' },
      ],
    },
    {
      id: 'retire-project',
      title: 'Retire the project VLAN',
      description: 'VLAN 30 is gone, PC5 has moved to VLAN 20 with the rest of the staff, and PC5 reaches PC3.',
      points: 25,
      dependsOn: ['staff-ports'],
      hint: 'Move the port before you delete the VLAN, or move it straight after.',
      assertions: [
        { kind: 'vlan', device: 'SW1', vlan: 30, exists: false },
        { kind: 'switchport', device: 'SW1', port: 'FastEthernet0/5', mode: 'access', accessVlan: 20 },
        { kind: 'vlan', device: 'SW1', vlan: 20, accessPorts: ['FastEthernet0/3', 'FastEthernet0/4', 'FastEthernet0/5'], match: 'exactly' },
        { kind: 'connectivity', from: 'PC5', to: 'PC3', expect: 'success' },
      ],
      feedbackOnFail: 'A port whose VLAN was deleted keeps pointing at it and forwards nothing until it is given a VLAN that exists.',
    },
  ],
  solution: {
    SW1: [
      'vlan 10',
      'name SALES',
      'exit',
      'vlan 20',
      'name STAFF',
      'exit',
      'interface range FastEthernet0/1 - 2',
      'switchport mode access',
      'switchport access vlan 10',
      'exit',
      'interface range FastEthernet0/3 - 5',
      'switchport mode access',
      'switchport access vlan 20',
      'exit',
      'no vlan 30',
    ],
  },
};

/** The VLAN labs, in course order. */
export const CCNA2_VLAN_LABS: readonly ScenarioInfo[] = [ccna2SwitchManagement, ccna2VlanAccessPorts];
