/**
 * sim/scenarios/ccna1/ipv6.ts — the CCNA 1 IPv6 lab (ARCHITECTURE-P1 §4.6, §4.13, §8.2 W6).
 *
 *   • `ccna1-ipv6-slaac` — a router advertises a prefix on each LAN and the hosts build their own addresses.
 *
 * The lab is IPv6 only on purpose: nothing here has an IPv4 address, so a host that reaches the far side has done
 * it with a link-local neighbour, a prefix from an advertisement and a default route learned from it. Wording is
 * our own (§1.6) and the prefixes come from the documentation range.
 *
 * ponytail: the last task reads state instead of pinging. A `connectivity` check runs in the grader's clone, and
 * that clone is only run to idle after boot — about a second, while the first router advertisement is up to twenty
 * seconds away — so a clone ping of a SLAAC world always starts before the hosts have a global address. The state
 * the task reads (a slaac address on each host, a learned default route, the router forwarding, advertisements in
 * the trace) is exactly what the ping would prove, and the student still pings from the terminal.
 */
import type { ScenarioInfo } from '../../../contracts/scenario.js';
import { PC, ROUTER, SWITCH, configText, device, link, topology } from '../kit.js';
import { bareHost } from './foundations.js';

/** Address the router carries on the first LAN (the prefix it advertises there). */
export const SLAAC_ADDRESS_LEFT = '2001:db8:1::1/64';
/** Address the router carries on the second LAN. */
export const SLAAC_ADDRESS_RIGHT = '2001:db8:2::1/64';

/** Two LANs, one router, nothing addressed: every address in this lab is built by the hosts themselves. */
export const ccna1Ipv6Slaac: ScenarioInfo = {
  name: 'ccna1-ipv6-slaac',
  category: 'ccna1-lab',
  labType: 'build',
  course: 'CCNA 1',
  topic: 'IPv6',
  title: 'IPv6 addresses without a server',
  description: 'Give the router one prefix per LAN, let it advertise them, and watch both hosts build a global address and find their default router on their own.',
  objectives: [
    'Enable IPv6 forwarding and address a router interface with a prefix',
    'Let a host build its address from an advertised prefix',
    'Recognise the link-local address a router advertises itself with',
    'Check an IPv6 host: its two addresses and the router it heard',
  ],
  tags: ['ipv6', 'slaac', 'router advertisement', 'neighbour discovery'],
  difficulty: 2,
  estimatedMinutes: 25,
  requires: [PC, SWITCH, ROUTER],
  seed: 112,
  concept: 'ipv6',
  instructions: [
    '## What you have',
    '',
    'PC1 and PC2 sit on two LANs joined by R1. No device has an address of any kind.',
    '',
    '## What to do',
    '',
    '- Switch IPv6 forwarding on at R1, so it advertises its prefixes.',
    '- Give `GigabitEthernet0/0` the address `2001:db8:1::1/64` and `GigabitEthernet0/1` the address `2001:db8:2::1/64`, and enable both.',
    '- On each host, ask the adapter to build its address from the advertisements.',
    '- Run `ipv6config` on a host: it should show a link-local address, a global address and the router it heard.',
    '- Ping PC2 from PC1 with the IPv6 form of the ping command: `ping -6 <address>`, using the address `ipv6config` shows on PC2.',
    '',
    '*The host part of the address comes from the adapter itself, which is why no two hosts collide.*',
  ].join('\n'),
  build: () =>
    topology(
      112,
      [
        device('pc1', PC, 'PC1', 100, 330, bareHost('PC1')),
        device('sw1', SWITCH, 'SW1', 260, 230),
        device('r1', ROUTER, 'R1', 430, 140, configText([['hostname R1']])),
        device('sw2', SWITCH, 'SW2', 600, 230),
        device('pc2', PC, 'PC2', 760, 330, bareHost('PC2')),
      ],
      [
        link('l_pc1_sw1', 'pc1', 'GigabitEthernet0', 'sw1', 'FastEthernet0/1'),
        link('l_sw1_r1', 'sw1', 'GigabitEthernet0/1', 'r1', 'GigabitEthernet0/0'),
        link('l_r1_sw2', 'r1', 'GigabitEthernet0/1', 'sw2', 'GigabitEthernet0/1'),
        link('l_sw2_pc2', 'sw2', 'FastEthernet0/1', 'pc2', 'GigabitEthernet0'),
      ],
      ['Advertise one prefix per LAN', 'Let both hosts build their own addresses', 'Ping across the router over IPv6'],
      'A router that forwards IPv6 advertises its prefixes; a host adds its own interface identifier and takes the sender of the advertisement as its default router.',
    ),
  tasks: [
    {
      id: 'forwarding',
      title: 'Let the router forward IPv6',
      description: 'R1 forwards IPv6 and therefore advertises its prefixes.',
      points: 15,
      hint: 'Without this global line a router keeps its prefixes to itself.',
      assertions: [{ kind: 'config', device: 'R1', path: 'ipv6.unicast-routing', exists: true }],
    },
    {
      id: 'prefixes',
      title: 'Address both LAN interfaces',
      description: 'Each interface carries the global address of its LAN and is up.',
      points: 25,
      assertions: [
        { kind: 'port', device: 'R1', port: 'GigabitEthernet0/0', field: 'ipv6', equals: '2001:db8:1::1' },
        { kind: 'port', device: 'R1', port: 'GigabitEthernet0/1', field: 'ipv6', equals: '2001:db8:2::1' },
        { kind: 'port', device: 'R1', port: 'GigabitEthernet0/0', field: 'operUp', equals: true },
        { kind: 'port', device: 'R1', port: 'GigabitEthernet0/1', field: 'operUp', equals: true },
      ],
    },
    {
      id: 'host-addresses',
      title: 'The hosts build their addresses',
      description: 'PC1 has the LAN prefix as a connected route, a default route it learned, and the router in its neighbour cache.',
      points: 30,
      dependsOn: ['forwarding', 'prefixes'],
      assertions: [
        { kind: 'table', device: 'PC1', table: 'rib6', where: { network: '2001:db8:1::', prefixLen: 64, source: 'C' }, exists: true },
        { kind: 'table', device: 'PC1', table: 'rib6', where: { network: '::', source: 'ND' }, exists: true },
        { kind: 'table', device: 'PC1', table: 'nd', where: { isRouter: true }, exists: true },
        { kind: 'table', device: 'PC2', table: 'rib6', where: { network: '2001:db8:2::', prefixLen: 64, source: 'C' }, exists: true },
      ],
      feedbackOnFail: 'A host builds nothing until its adapter is told to listen for advertisements and a router is sending them.',
    },
    {
      id: 'both-lans-ready',
      title: 'Both LANs are ready to talk',
      description: 'Each host holds a global address it built itself, the router forwards between the two LANs, and its advertisements are in the trace.',
      points: 30,
      dependsOn: ['host-addresses'],
      assertions: [
        { kind: 'process', device: 'PC1', process: 'ipv6', path: 'interfaces.0.addresses.1.origin', equals: 'slaac' },
        { kind: 'process', device: 'PC2', process: 'ipv6', path: 'interfaces.0.addresses.1.origin', equals: 'slaac' },
        { kind: 'table', device: 'PC2', table: 'rib6', where: { network: '::', source: 'ND' }, exists: true },
        { kind: 'process', device: 'R1', process: 'ipv6', path: 'forwarding', equals: true },
        { kind: 'traceSeen', filter: { kinds: ['frameTx'], tags: ['nd-ra'], includeBackground: true }, min: 1 },
      ],
      feedbackOnFail: 'Each host needs an address built from the advertisement of its own LAN, and the router has to forward between them.',
    },
  ],
  solution: {
    R1: [
      'ipv6 unicast-routing',
      'interface GigabitEthernet0/0',
      `ipv6 address ${SLAAC_ADDRESS_LEFT}`,
      'no shutdown',
      'exit',
      'interface GigabitEthernet0/1',
      `ipv6 address ${SLAAC_ADDRESS_RIGHT}`,
      'no shutdown',
      'exit',
    ],
    PC1: ['ipv6 autoconfig'],
    PC2: ['ipv6 autoconfig'],
  },
};
