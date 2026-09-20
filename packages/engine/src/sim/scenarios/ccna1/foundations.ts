/**
 * sim/scenarios/ccna1/foundations.ts — the first CCNA 1 labs (ARCHITECTURE-P1 §4.13, §8.2 W6; §1.6 original wording).
 *
 *   • `ccna1-switched-lan`      — address two hosts on one switch and prove the LAN works.
 *   • `ccna1-default-gateway`   — a host leaves its own subnet only when it knows a gateway.
 *   • `ccna1-device-hardening`  — name a switch, protect its lines and give it a management address.
 *
 * Every lab ships with a reference `solution` written in the command lines `Simulation.configure` accepts (host
 * shell on the PCs, the device CLI on the switch), and tasks whose assertions read structured state only
 * (sim/lab-checks.ts). Objectives are our own paraphrase of what the course teaches at this point, never text
 * copied from a blueprint.
 *
 * ponytail: unsolved worlds carry only a hostname, so every task of every lab fails before the student starts;
 * that is what makes the tasks discriminate (labs.solutions test).
 */
import type { ScenarioInfo } from '../../../contracts/scenario.js';
import { MASK24, PC, ROUTER, SWITCH, configText, device, link, topology } from '../kit.js';
import { pcConfig, routerConfig } from '../templates.js';

/** A host that has nothing but its name (what an unconfigured PC looks like in a build lab). */
export function bareHost(hostname: string): string {
  return configText([[`hostname ${hostname}`]]);
}

// ── switched LAN ────────────────────────────────────────────────────────────

/** Switch name the reference solution gives SW1. */
export const SWITCHED_LAN_HOSTNAME = 'LAB-SW1';

/** PC1 and PC2 cabled to an access switch, both without an address. */
export const ccna1SwitchedLan: ScenarioInfo = {
  name: 'ccna1-switched-lan',
  category: 'ccna1-lab',
  labType: 'build',
  course: 'CCNA 1',
  topic: 'Ethernet LANs',
  title: 'Build a switched LAN',
  description: 'Two workstations and an access switch are cabled but silent. Give the hosts addresses in one subnet, name the switch and prove the LAN carries traffic.',
  objectives: [
    'Give a host an IPv4 address and a mask from the host shell',
    'Recognise when two hosts share a subnet',
    'Name a switch so its prompt identifies it',
    'Confirm a LAN with a ping and the tables it fills',
  ],
  tags: ['ethernet', 'switch', 'addressing', 'ping', 'arp'],
  difficulty: 1,
  estimatedMinutes: 15,
  requires: [PC, SWITCH],
  seed: 101,
  instructions: [
    '## What you have',
    '',
    'PC1 and PC2 are cabled to an access switch. The cables are good and the switch is running, but neither host has an address yet.',
    '',
    '## What to do',
    '',
    '- Open the shell of each PC and set an address in `192.168.10.0/24`: PC1 gets `.11`, PC2 gets `.12`, both with mask `255.255.255.0`.',
    '- Name the switch `LAB-SW1` from its configuration mode.',
    '- Ping PC2 from PC1, then look at `arp -a` on PC1 and the MAC address table of the switch.',
    '',
    '*Both hosts are in one subnet, so no gateway is needed here.*',
  ].join('\n'),
  build: () =>
    topology(
      101,
      [
        device('pc1', PC, 'PC1', 120, 320, bareHost('PC1')),
        device('sw1', SWITCH, 'SW1', 320, 160),
        device('pc2', PC, 'PC2', 520, 320, bareHost('PC2')),
      ],
      [link('l_pc1_sw1', 'pc1', 'GigabitEthernet0', 'sw1', 'FastEthernet0/1'), link('l_pc2_sw1', 'pc2', 'GigabitEthernet0', 'sw1', 'FastEthernet0/2')],
      ['Address both hosts in one subnet', 'Name the switch', 'Ping across the LAN'],
      'One switch, one subnet: the switch forwards by MAC address and never looks at the IP header.',
    ),
  tasks: [
    {
      id: 'pc1-address',
      title: 'Address PC1',
      description: 'PC1 carries 192.168.10.11 with mask 255.255.255.0.',
      points: 10,
      hint: 'In the PC shell: ip address <address> <mask>.',
      assertions: [{ kind: 'port', device: 'PC1', port: 'GigabitEthernet0', field: 'ipv4', equals: '192.168.10.11/24' }],
      feedbackOnFail: 'PC1 has no usable address yet; check the address and the mask you typed.',
    },
    {
      id: 'pc2-address',
      title: 'Address PC2',
      description: 'PC2 carries 192.168.10.12 with mask 255.255.255.0.',
      points: 10,
      assertions: [{ kind: 'port', device: 'PC2', port: 'GigabitEthernet0', field: 'ipv4', equals: '192.168.10.12/24' }],
      feedbackOnFail: 'PC2 has no usable address yet; check the address and the mask you typed.',
    },
    {
      id: 'switch-name',
      title: 'Name the switch',
      description: `The switch answers to ${SWITCHED_LAN_HOSTNAME}.`,
      points: 5,
      hint: 'The hostname line lives in global configuration mode.',
      assertions: [{ kind: 'config', device: 'SW1', path: 'hostname', equals: SWITCHED_LAN_HOSTNAME }],
    },
    {
      id: 'lan-reachable',
      title: 'Prove the LAN works',
      description: 'PC1 gets replies from PC2, and both links are up.',
      points: 15,
      dependsOn: ['pc1-address', 'pc2-address'],
      assertions: [
        { kind: 'link', a: 'PC1', b: 'SW1', up: true },
        { kind: 'link', a: 'PC2', b: 'SW1', up: true },
        { kind: 'connectivity', from: 'PC1', to: 'PC2', expect: 'success' },
      ],
      feedbackOnFail: 'The ping got no answer. Two hosts reach each other directly only when their addresses and masks put them in the same subnet.',
    },
  ],
  solution: {
    PC1: ['ip address 192.168.10.11 255.255.255.0'],
    PC2: ['ip address 192.168.10.12 255.255.255.0'],
    SW1: [`hostname ${SWITCHED_LAN_HOSTNAME}`],
  },
};

// ── default gateway ─────────────────────────────────────────────────────────

/** PC1 unconfigured on a LAN whose router already reaches a second subnet. */
export const ccna1DefaultGateway: ScenarioInfo = {
  name: 'ccna1-default-gateway',
  category: 'ccna1-lab',
  labType: 'guided',
  course: 'CCNA 1',
  topic: 'IPv4 addressing',
  title: 'Static address and default gateway',
  description: 'The router and the far host are ready; PC1 is not. Address PC1, point it at its gateway and reach a host in another subnet.',
  objectives: [
    'Set a host address, mask and default gateway in one command',
    'Tell a local destination from a remote one',
    'Read the default route a gateway creates in the host routing table',
  ],
  tags: ['addressing', 'default gateway', 'routing', 'ping'],
  difficulty: 1,
  estimatedMinutes: 15,
  requires: [PC, SWITCH, ROUTER],
  seed: 102,
  instructions: [
    '## What you have',
    '',
    'PC1 sits on `192.168.20.0/24` behind SW1. R1 joins that subnet to `192.168.21.0/24`, where PC2 already works.',
    '',
    '## What to do',
    '',
    '- Give PC1 the address `192.168.20.10`, mask `255.255.255.0` and gateway `192.168.20.1`.',
    '- Ping the gateway first, then PC2 at `192.168.21.10`.',
    '- Compare the two pings: one stays in the subnet, the other leaves it.',
  ].join('\n'),
  build: () =>
    topology(
      102,
      [
        device('pc1', PC, 'PC1', 120, 320, bareHost('PC1')),
        device('sw1', SWITCH, 'SW1', 300, 220),
        device(
          'r1',
          ROUTER,
          'R1',
          480,
          140,
          routerConfig('R1', [
            { port: 'GigabitEthernet0/0', address: '192.168.20.1', mask: MASK24 },
            { port: 'GigabitEthernet0/1', address: '192.168.21.1', mask: MASK24 },
          ]),
        ),
        device('pc2', PC, 'PC2', 700, 320, pcConfig('PC2', '192.168.21.10', MASK24, '192.168.21.1')),
      ],
      [
        link('l_pc1_sw1', 'pc1', 'GigabitEthernet0', 'sw1', 'FastEthernet0/1'),
        link('l_sw1_r1', 'sw1', 'GigabitEthernet0/1', 'r1', 'GigabitEthernet0/0'),
        link('l_r1_pc2', 'r1', 'GigabitEthernet0/1', 'pc2', 'GigabitEthernet0'),
      ],
      ['Address PC1 with a gateway', 'Reach a host in the next subnet'],
      'Without a gateway a host can only talk to its own subnet: the router is the way out.',
    ),
  tasks: [
    {
      id: 'pc1-address',
      title: 'Address PC1',
      description: 'PC1 carries 192.168.20.10/24.',
      points: 10,
      assertions: [{ kind: 'port', device: 'PC1', port: 'GigabitEthernet0', field: 'ipv4', equals: '192.168.20.10/24' }],
    },
    {
      id: 'pc1-gateway',
      title: 'Point PC1 at its gateway',
      description: 'PC1 uses 192.168.20.1 as its default gateway and keeps a default route.',
      points: 10,
      hint: 'The gateway is the third value of the host shell address command.',
      assertions: [
        { kind: 'config', device: 'PC1', path: 'ip.default-gateway', equals: '192.168.20.1' },
        { kind: 'table', device: 'PC1', table: 'rib', where: { network: '0.0.0.0', source: 'S' }, exists: true },
      ],
    },
    {
      id: 'reach-gateway',
      title: 'Reach the gateway',
      description: 'PC1 gets replies from the router interface on its own subnet.',
      points: 5,
      dependsOn: ['pc1-address'],
      assertions: [{ kind: 'connectivity', from: 'PC1', to: 'R1', expect: 'success' }],
    },
    {
      id: 'reach-remote',
      title: 'Reach the far subnet',
      description: 'PC1 gets replies from PC2 in 192.168.21.0/24.',
      points: 15,
      dependsOn: ['pc1-gateway'],
      assertions: [{ kind: 'connectivity', from: 'PC1', to: 'PC2', expect: 'success' }],
      feedbackOnFail: 'Packets for another subnet are handed to the default gateway; without one the host drops them before they reach a cable.',
    },
  ],
  solution: {
    PC1: ['ip address 192.168.20.10 255.255.255.0 192.168.20.1'],
  },
};

// ── device hardening ────────────────────────────────────────────────────────

/** Hostname the reference solution gives the access switch. */
export const HARDENING_HOSTNAME = 'LAB-ACCESS1';
/** Privileged-mode secret of the hardening lab (a teaching value). */
export const HARDENING_ENABLE_SECRET = 'quiet-harbour-77';
/** Console password of the hardening lab (a teaching value). */
export const HARDENING_CONSOLE_PASSWORD = 'copper-lantern-5';

/** A fresh switch with no name, no passwords and no management address. */
export const ccna1DeviceHardening: ScenarioInfo = {
  name: 'ccna1-device-hardening',
  category: 'ccna1-lab',
  labType: 'guided',
  course: 'CCNA 1',
  topic: 'Device access',
  title: 'Basic switch setup and access control',
  description: 'A switch straight out of the box: name it, protect privileged mode and the console line, post a notice and give it a management address an administrator can reach.',
  objectives: [
    'Name a device and post a notice before login',
    'Protect privileged mode with a stored secret',
    'Ask for a password on the console line',
    'Give a switch a management address and a gateway',
  ],
  tags: ['device access', 'passwords', 'banner', 'management address', 'switch'],
  difficulty: 1,
  estimatedMinutes: 20,
  requires: [PC, SWITCH, ROUTER],
  seed: 103,
  instructions: [
    '## What you have',
    '',
    'A new switch, an administrator workstation on `192.168.50.0/24` and a router that already carries `192.168.50.1`.',
    '',
    '## What to do',
    '',
    '- Name the switch `LAB-ACCESS1`.',
    '- Set a secret for privileged mode and a password with `login` on `line con 0`.',
    '- Post a short notice with `banner motd`.',
    '- Address the management interface `Vlan1` as `192.168.50.2/24`, bring it up and set the default gateway `192.168.50.1`.',
    '- Ping the switch from ADMIN1.',
    '',
    '*A layer-2 switch does not route: its address exists only so you can manage it.*',
  ].join('\n'),
  build: () =>
    topology(
      103,
      [
        device('admin1', PC, 'ADMIN1', 120, 320, pcConfig('ADMIN1', '192.168.50.10', MASK24, '192.168.50.1')),
        device('sw1', SWITCH, 'SW1', 320, 180),
        device('r1', ROUTER, 'R1', 540, 140, routerConfig('R1', [{ port: 'GigabitEthernet0/0', address: '192.168.50.1', mask: MASK24 }])),
      ],
      [link('l_admin1_sw1', 'admin1', 'GigabitEthernet0', 'sw1', 'FastEthernet0/1'), link('l_sw1_r1', 'sw1', 'GigabitEthernet0/1', 'r1', 'GigabitEthernet0/0')],
      ['Name and protect the switch', 'Give it a management address'],
      'The management address lives on the Vlan1 interface, which starts administratively down on a new switch.',
    ),
  tasks: [
    {
      id: 'hostname',
      title: 'Name the switch',
      description: `The switch answers to ${HARDENING_HOSTNAME}.`,
      points: 5,
      assertions: [{ kind: 'config', device: 'SW1', path: 'hostname', equals: HARDENING_HOSTNAME }],
    },
    {
      id: 'enable-secret',
      title: 'Protect privileged mode',
      description: 'A secret is stored for privileged mode (it is never shown again in the configuration).',
      points: 10,
      hint: 'Use the secret form, not the plain password form.',
      assertions: [{ kind: 'config', device: 'SW1', path: 'enable.secret', exists: true }],
    },
    {
      id: 'console-login',
      title: 'Ask for a password on the console',
      description: 'The console line has a password and is set to ask for it.',
      points: 10,
      assertions: [
        { kind: 'config', device: 'SW1', path: 'line.con.0.password', exists: true },
        { kind: 'config', device: 'SW1', path: 'line.con.0.login', exists: true },
      ],
      feedbackOnFail: 'A password on the line is only asked for once the line is told to log users in.',
    },
    {
      id: 'banner',
      title: 'Post a notice',
      description: 'A message of the day is shown before login.',
      points: 5,
      assertions: [{ kind: 'config', device: 'SW1', path: 'banner.motd', exists: true }],
    },
    {
      id: 'management',
      title: 'Make the switch manageable',
      description: 'Vlan1 carries 192.168.50.2/24, is up, has a default gateway and answers the administrator.',
      points: 20,
      dependsOn: ['hostname'],
      assertions: [
        { kind: 'port', device: 'SW1', port: 'Vlan1', field: 'ipv4', equals: '192.168.50.2/24' },
        { kind: 'port', device: 'SW1', port: 'Vlan1', field: 'operUp', equals: true },
        { kind: 'config', device: 'SW1', path: 'ip.default-gateway', equals: '192.168.50.1' },
        { kind: 'connectivity', from: 'ADMIN1', to: 'SW1', expect: 'success' },
      ],
      feedbackOnFail: 'Vlan1 starts administratively down on a new switch; an address alone does not bring it up.',
    },
  ],
  solution: {
    SW1: [
      `hostname ${HARDENING_HOSTNAME}`,
      `enable secret ${HARDENING_ENABLE_SECRET}`,
      'banner motd Study network: authorised use only',
      'line con 0',
      `password ${HARDENING_CONSOLE_PASSWORD}`,
      'login',
      'exit',
      'interface Vlan1',
      `ip address 192.168.50.2 ${MASK24}`,
      'no shutdown',
      'exit',
      'ip default-gateway 192.168.50.1',
    ],
  },
};
