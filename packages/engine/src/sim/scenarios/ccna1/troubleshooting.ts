/**
 * sim/scenarios/ccna1/troubleshooting.ts — the CCNA 1 fault-finding labs (ARCHITECTURE-P1 §4.9, §4.13, §8.2 W6).
 *
 *   • `ccna1-troubleshoot-addressing` — one host has the wrong mask, another the wrong gateway.
 *   • `ccna1-troubleshoot-ports`      — one switch port is shut, another is pinned to settings the host cannot match.
 *
 * The faults live in the startup configuration of the broken devices, so the world boots broken and the student
 * repairs it from the CLI. Wording is our own (§1.6).
 *
 * ponytail: the faults are written into the startup configs rather than injected as `FaultSpec`s, so the world
 * boots broken, the student sees the same running-config they would on real kit, and the repair is an ordinary
 * configuration change.
 */
import type { ScenarioInfo } from '../../../contracts/scenario.js';
import { MASK24, MASK26, PC, ROUTER, SWITCH, configText, device, link, section, topology } from '../kit.js';
import { pcConfig, routerConfig } from '../templates.js';

// ── wrong mask, wrong gateway ───────────────────────────────────────────────

/** Two hosts on one LAN, each broken in a different way. */
export const ccna1TroubleshootAddressing: ScenarioInfo = {
  name: 'ccna1-troubleshoot-addressing',
  category: 'ccna1-lab',
  labType: 'troubleshoot',
  course: 'CCNA 1',
  topic: 'Troubleshooting',
  title: 'A wrong mask and a wrong gateway',
  description: 'Two workstations on the same cable cannot reach each other, and one of them cannot leave the subnet either. The addresses look right; read them with their masks.',
  objectives: [
    'Work out which subnet an address falls in once the mask is applied',
    'Recognise a gateway that is not the router',
    'Test a repair locally and then beyond the subnet',
  ],
  tags: ['troubleshooting', 'mask', 'default gateway', 'addressing'],
  difficulty: 2,
  estimatedMinutes: 20,
  requires: [PC, SWITCH, ROUTER],
  seed: 114,
  instructions: [
    '## What you see',
    '',
    'PC1 and PC2 are both plugged into SW1 in `192.168.30.0/24`, where R1 carries `192.168.30.1`. PC3 sits in `192.168.31.0/24` behind the router.',
    '',
    '- PC2 cannot ping PC1, although they share one cable segment.',
    '- PC1 cannot reach PC3 at all.',
    '',
    '## What to do',
    '',
    '- Read the address *and the mask* of each host with `ipconfig`, and work out the subnet each one believes it is in.',
    '- Check which gateway each host was given.',
    '- Repair both hosts, then ping locally and across the router.',
  ].join('\n'),
  build: () =>
    topology(
      114,
      [
        device('pc1', PC, 'PC1', 110, 340, pcConfig('PC1', '192.168.30.10', MASK24, '192.168.30.9')),
        device('pc2', PC, 'PC2', 260, 390, pcConfig('PC2', '192.168.30.80', MASK26, '192.168.30.65')),
        device('sw1', SWITCH, 'SW1', 300, 240),
        device('r1', ROUTER, 'R1', 500, 150, routerConfig('R1', [
          { port: 'GigabitEthernet0/0', address: '192.168.30.1', mask: MASK24 },
          { port: 'GigabitEthernet0/1', address: '192.168.31.1', mask: MASK24 },
        ])),
        device('pc3', PC, 'PC3', 720, 330, pcConfig('PC3', '192.168.31.10', MASK24, '192.168.31.1')),
      ],
      [
        link('l_pc1_sw1', 'pc1', 'GigabitEthernet0', 'sw1', 'FastEthernet0/1'),
        link('l_pc2_sw1', 'pc2', 'GigabitEthernet0', 'sw1', 'FastEthernet0/2'),
        link('l_sw1_r1', 'sw1', 'GigabitEthernet0/1', 'r1', 'GigabitEthernet0/0'),
        link('l_r1_pc3', 'r1', 'GigabitEthernet0/1', 'pc3', 'GigabitEthernet0'),
      ],
      ['Find the host with the wrong mask', 'Find the host with the wrong gateway', 'Prove both repairs'],
      'A mask decides which destinations a host treats as local; a gateway decides where everything else goes. Either one, set wrongly, looks like a cable fault.',
    ),
  tasks: [
    {
      id: 'mask',
      title: 'Repair the mask',
      description: 'PC2 uses a 24-bit mask, so 192.168.30.80 lands in the same subnet as the others.',
      points: 25,
      hint: 'Work out where the /26 boundary falls and which addresses that leaves out.',
      assertions: [{ kind: 'port', device: 'PC2', port: 'GigabitEthernet0', field: 'ipv4', equals: '192.168.30.80/24' }],
    },
    {
      id: 'gateway',
      title: 'Repair the gateway',
      description: 'PC1 points at the router address 192.168.30.1.',
      points: 25,
      assertions: [{ kind: 'config', device: 'PC1', path: 'ip.default-gateway', equals: '192.168.30.1' }],
    },
    {
      id: 'local',
      title: 'The LAN works again',
      description: 'PC2 gets replies from PC1.',
      points: 25,
      dependsOn: ['mask'],
      assertions: [{ kind: 'connectivity', from: 'PC2', to: 'PC1', expect: 'success' }],
      feedbackOnFail: 'With a longer mask a host treats a neighbour as remote and hands the packet to a gateway that is not there.',
    },
    {
      id: 'remote',
      title: 'The far subnet works again',
      description: 'PC1 gets replies from PC3 behind the router.',
      points: 25,
      dependsOn: ['gateway'],
      assertions: [{ kind: 'connectivity', from: 'PC1', to: 'PC3', expect: 'success' }],
    },
  ],
  solution: {
    PC1: [`ip address 192.168.30.10 ${MASK24} 192.168.30.1`],
    PC2: [`ip address 192.168.30.80 ${MASK24} 192.168.30.1`],
  },
};

// ── a shut port and a pinned port ───────────────────────────────────────────

/** Switch startup config with one disabled port and one pinned to fixed speed and duplex. */
function brokenSwitchConfig(): string {
  return configText([
    ['hostname SW1'],
    section('interface FastEthernet0/1', ['duplex full', 'speed 100']),
    section('interface FastEthernet0/2', ['shutdown']),
  ]);
}

/** One host cut off by a disabled port, one host talking to a port that will not negotiate. */
export const ccna1TroubleshootPorts: ScenarioInfo = {
  name: 'ccna1-troubleshoot-ports',
  category: 'ccna1-lab',
  labType: 'troubleshoot',
  course: 'CCNA 1',
  topic: 'Troubleshooting',
  title: 'A dead port and a duplex mismatch',
  description: 'One host is completely offline and the other is on a link that works badly. Find the disabled port and the port whose fixed settings the host cannot match.',
  objectives: [
    'Tell an administratively disabled port from a cabling fault',
    'Recognise a link where only one end negotiates',
    'Return a port to automatic speed and duplex and confirm the result',
  ],
  tags: ['troubleshooting', 'shutdown', 'duplex', 'speed', 'autonegotiation'],
  difficulty: 2,
  estimatedMinutes: 20,
  requires: [PC, SWITCH],
  seed: 115,
  instructions: [
    '## What you see',
    '',
    'PC1 and PC2 are addressed in `192.168.35.0/24` and cabled to SW1. PC2 has no link at all, and PC1 reports a half-duplex link on an adapter that should do better.',
    '',
    '## What to do',
    '',
    '- Look at the state of the two switch ports and at what the host adapters negotiated.',
    '- Enable the port that was switched off.',
    '- Return the pinned port to automatic speed and duplex so both ends agree.',
    '- Ping PC2 from PC1 when both links are healthy.',
    '',
    '*When one end is fixed and the other negotiates, the negotiating end falls back to half duplex and the link works badly rather than not at all.*',
  ].join('\n'),
  build: () =>
    topology(
      115,
      [
        device('pc1', PC, 'PC1', 120, 330, pcConfig('PC1', '192.168.35.11', MASK24)),
        device('sw1', SWITCH, 'SW1', 330, 180, brokenSwitchConfig()),
        device('pc2', PC, 'PC2', 540, 330, pcConfig('PC2', '192.168.35.12', MASK24)),
      ],
      [link('l_pc1_sw1', 'pc1', 'GigabitEthernet0', 'sw1', 'FastEthernet0/1'), link('l_pc2_sw1', 'pc2', 'GigabitEthernet0', 'sw1', 'FastEthernet0/2')],
      ['Enable the disabled port', 'Let the other port negotiate again', 'Ping across a healthy LAN'],
      'A disabled port never comes up whatever the cable does; a port pinned to fixed settings comes up, but the far end guesses the duplex and usually guesses half.',
    ),
  tasks: [
    {
      id: 'enable-port',
      title: 'Enable the dead port',
      description: 'FastEthernet0/2 is enabled and the link to PC2 is up.',
      points: 30,
      assertions: [
        { kind: 'port', device: 'SW1', port: 'FastEthernet0/2', field: 'adminUp', equals: true },
        { kind: 'link', a: 'PC2', b: 'SW1', up: true },
      ],
    },
    {
      id: 'negotiate',
      title: 'Let the other port negotiate',
      description: 'FastEthernet0/1 is back on automatic settings and PC1 runs full duplex.',
      points: 35,
      hint: 'Both the speed and the duplex line have to go back to automatic.',
      assertions: [
        { kind: 'config', device: 'SW1', path: 'interface.FastEthernet0/1.duplex', equals: 'auto' },
        { kind: 'config', device: 'SW1', path: 'interface.FastEthernet0/1.speed', equals: 'auto' },
        { kind: 'port', device: 'PC1', port: 'GigabitEthernet0', field: 'duplex', equals: 'full' },
      ],
      feedbackOnFail: 'The host end only reaches full duplex when the switch end negotiates too.',
    },
    {
      id: 'lan-healthy',
      title: 'The LAN is healthy',
      description: 'PC1 gets replies from PC2.',
      points: 35,
      dependsOn: ['enable-port', 'negotiate'],
      assertions: [{ kind: 'connectivity', from: 'PC1', to: 'PC2', expect: 'success' }],
    },
  ],
  solution: {
    SW1: [
      'interface FastEthernet0/2',
      'no shutdown',
      'exit',
      'interface FastEthernet0/1',
      'duplex auto',
      'speed auto',
      'exit',
    ],
  },
};
