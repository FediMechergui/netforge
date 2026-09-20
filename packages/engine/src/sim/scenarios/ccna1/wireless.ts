/**
 * sim/scenarios/ccna1/wireless.ts — the CCNA 1 home wireless lab (ARCHITECTURE-P1 §3.6, §4.3, §4.13, §8.2 W6).
 *
 *   • `ccna1-home-wifi` — set up a wireless network on a home router and join it from a laptop.
 *
 * Wording and the teaching passphrase are our own (§1.6).
 *
 * ponytail: the laptop takes its address by lease because the host shell writes a static address on the default
 * (wired) adapter; the DHCP form is the one that takes an adapter name, and a home network hands out addresses
 * anyway.
 */
import type { ScenarioInfo } from '../../../contracts/scenario.js';
import { HOME_ROUTER, LAPTOP, MASK24, PC, configText, device, link, section, topology } from '../kit.js';
import { pcConfig } from '../templates.js';
import { bareHost } from './foundations.js';

/** Network name the reference solution creates. */
export const HOME_LAB_SSID = 'HOMELAB';
/** Passphrase of that network (a teaching value). */
export const HOME_LAB_PASSPHRASE = 'sunny-harbour-41';
/** Pool name of the home router. */
export const HOME_LAB_POOL = 'HOME';
/** Canvas distance between the home router and the laptop: 120 units × 0.25 m = 30 m. */
export const HOME_LAB_LAPTOP_UNITS = 120;

/** A home router with its LAN address but no wireless network, and a laptop that has joined nothing. */
export const ccna1HomeWifi: ScenarioInfo = {
  name: 'ccna1-home-wifi',
  category: 'ccna1-lab',
  labType: 'build',
  course: 'CCNA 1',
  topic: 'Wireless',
  title: 'Set up a home wireless network',
  description: 'The home router carries the LAN but its radio is silent. Create a protected wireless network, hand out addresses on it and join from a laptop across the room.',
  objectives: [
    'Create a wireless network with a name and personal security',
    'Lease addresses to wireless clients',
    'Join a protected network from a client and check the association',
    'Confirm that wireless and wired hosts share one local network',
  ],
  tags: ['wireless', 'wifi', 'wpa2', 'dhcp', 'home network'],
  difficulty: 2,
  estimatedMinutes: 25,
  requires: [PC, LAPTOP, HOME_ROUTER],
  seed: 113,
  instructions: [
    '## What you have',
    '',
    'HOME1 carries `192.168.1.1/24` on its LAN, PC1 is cabled to it, and LAPTOP1 sits about 30 m away with nothing configured.',
    '',
    '## What to do',
    '',
    `- On the \`Wlan0\` radio of HOME1, set the network name \`${HOME_LAB_SSID}\`, personal WPA2 security and the passphrase \`${HOME_LAB_PASSPHRASE}\`.`,
    `- Reserve \`192.168.1.1\` to \`192.168.1.20\` and add the pool \`${HOME_LAB_POOL}\` for \`192.168.1.0/24\` with default gateway \`192.168.1.1\`.`,
    '- On LAPTOP1, list the networks in range, join yours with the passphrase, then ask the wireless adapter for an address.',
    '- Ping PC1 from the laptop: the wired and the wireless side are one network.',
  ].join('\n'),
  build: () => {
    const routerX = 320;
    const routerY = 160;
    return topology(
      113,
      [
        device('home1', HOME_ROUTER, 'HOME1', routerX, routerY, configText([['hostname HOME1'], section('interface Vlan1', [`ip address 192.168.1.1 ${MASK24}`])])),
        device('pc1', PC, 'PC1', 120, 330, pcConfig('PC1', '192.168.1.10', MASK24, '192.168.1.1')),
        device('laptop1', LAPTOP, 'LAPTOP1', routerX + HOME_LAB_LAPTOP_UNITS, routerY, bareHost('LAPTOP1')),
      ],
      [link('l_pc1_home1', 'pc1', 'GigabitEthernet0', 'home1', 'GigabitEthernet1')],
      ['Create a protected wireless network', 'Lease addresses to the clients', 'Join from the laptop and reach the wired host'],
      'A home router bridges its radio and its LAN ports into one network, so a wireless client ends up in the same subnet as the cabled hosts.',
    );
  },
  tasks: [
    {
      id: 'wireless-network',
      title: 'Create the wireless network',
      description: `The radio announces ${HOME_LAB_SSID} with personal WPA2 security and a passphrase.`,
      points: 20,
      hint: 'The three lines belong under the Wlan0 interface.',
      assertions: [
        { kind: 'config', device: 'HOME1', path: 'interface.Wlan0.ssid', equals: HOME_LAB_SSID },
        { kind: 'config', device: 'HOME1', path: 'interface.Wlan0.security', equals: 'wpa2-psk' },
        { kind: 'config', device: 'HOME1', path: 'interface.Wlan0.passphrase', exists: true },
      ],
    },
    {
      id: 'address-pool',
      title: 'Hand out addresses',
      description: `The pool ${HOME_LAB_POOL} serves 192.168.1.0/24 and keeps the first twenty addresses free.`,
      points: 20,
      assertions: [
        { kind: 'config', device: 'HOME1', path: `ip.dhcp.pool.${HOME_LAB_POOL}.network`, equals: ['192.168.1.0', MASK24] },
        { kind: 'config', device: 'HOME1', path: `ip.dhcp.pool.${HOME_LAB_POOL}.default-router`, equals: '192.168.1.1' },
        { kind: 'config', device: 'HOME1', path: 'ip.dhcp.excluded-address', equals: ['excluded-address', '192.168.1.1', '192.168.1.20'] },
      ],
    },
    {
      id: 'joined',
      title: 'Join from the laptop',
      description: 'The laptop is associated with the network and its wireless adapter is up.',
      points: 25,
      dependsOn: ['wireless-network'],
      assertions: [
        { kind: 'config', device: 'LAPTOP1', path: 'interface.Wlan0.ssid', equals: HOME_LAB_SSID },
        { kind: 'port', device: 'LAPTOP1', port: 'Wlan0', field: 'operUp', equals: true },
        { kind: 'table', device: 'HOME1', table: 'dot11-assoc', where: { ssid: HOME_LAB_SSID, state: 'associated' }, exists: true },
      ],
      feedbackOnFail: 'A station joins only when the name, the security mode and the passphrase all match what the access point announces.',
    },
    {
      id: 'wireless-lease',
      title: 'Take an address and reach the LAN',
      description: 'The laptop holds a lease on its wireless adapter and reaches the wired host.',
      points: 25,
      dependsOn: ['address-pool', 'joined'],
      assertions: [
        { kind: 'process', device: 'LAPTOP1', process: 'dhcp-client', path: 'clients.iface=Wlan0.state', equals: 'BOUND' },
        { kind: 'connectivity', from: 'LAPTOP1', to: 'PC1', expect: 'success' },
      ],
    },
  ],
  solution: {
    HOME1: [
      'interface Wlan0',
      `ssid ${HOME_LAB_SSID}`,
      'security wpa2-psk',
      `passphrase ${HOME_LAB_PASSPHRASE}`,
      'exit',
      'ip dhcp excluded-address 192.168.1.1 192.168.1.20',
      `ip dhcp pool ${HOME_LAB_POOL}`,
      `network 192.168.1.0 ${MASK24}`,
      'default-router 192.168.1.1',
      'exit',
    ],
    LAPTOP1: [`wifi connect ${HOME_LAB_SSID} key ${HOME_LAB_PASSPHRASE}`, 'ip address dhcp Wlan0'],
  },
};
