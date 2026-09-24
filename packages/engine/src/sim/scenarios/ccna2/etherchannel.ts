/**
 * sim/scenarios/ccna2/etherchannel.ts — the CCNA 2 EtherChannel lab (ARCHITECTURE-P2 §3.7, D10, §11.1, §11.2).
 *
 *   • `ccna2-etherchannel-lacp` — lesson 17 "Bundling links" (module "EtherChannel"): SW2 already offers an LACP
 *     bundle on its two uplinks, but passively, and one of its members was left as an access port. Start the
 *     negotiation from SW1, find the member that is then suspended, spread the traffic by both addresses, and prove
 *     the bundle rides out the loss of a cable.
 *
 * The lab walks through the three member states the lesson names (§3.7 steps 8–9). Unsolved, both members of SW2 run
 * `individual` (a passive port never starts LACP, so nobody answers it) and spanning tree blocks one of the two
 * parallel links. Once SW1 negotiates actively, GigabitEthernet0/1 bundles and GigabitEthernet0/2 is `suspended`
 * (`switchport mode access` differs from Port-channel1's trunk); repaired, both are `bundled`. Host ports are PortFast
 * from the start (§11.2: the lesson is not about spanning tree), and the instructions say the inter-switch links wait
 * 30 s.
 *
 * Tasks read structured state (sim/lab-checks.ts): `etherchannel` (protocol, bundle up, bundled members), `table` rows
 * of `etherchannel` (member mode) and `stp` (no member takes part on its own), `stp` (Port-channel1 forwards),
 * `switchport` (the repaired member's mode), `config` (the load-balancing method) and a `connectivity` check whose
 * `after` shuts one member down and whose `then` reads the bundle it left. All wording is original (§1.6, D22).
 *
 * ponytail: the redundancy check gives the clone one second after the member goes down — plenty for a bundle, which
 * simply rehashes, and far too little for two separate links, where spanning tree would wait 30 s before the blocked
 * one forwards. That is the difference the lesson is about.
 */
import type { ScenarioInfo } from '../../../contracts/scenario.js';
import { MASK24, PC, SWITCH, accessPort, configText, device, link, section, topology, vlanSections } from '../kit.js';
import { pcConfig } from '../templates.js';

/** The one user VLAN of the lab. */
const STAFF = [{ id: 10, name: 'STAFF' }] as const;

/** SW1: its two PCs only; its uplinks are untouched (`dynamic auto`). */
function sw1Config(): string {
  return configText([
    ['hostname SW1'],
    ...vlanSections(STAFF),
    accessPort('FastEthernet0/1', 10, { portfast: true }),
    accessPort('FastEthernet0/2', 10, { portfast: true }),
  ]);
}

/** SW2: a passive LACP bundle whose second member was left as an access port. */
function sw2Config(): string {
  return configText([
    ['hostname SW2'],
    ...vlanSections(STAFF),
    accessPort('FastEthernet0/1', 10, { portfast: true }),
    accessPort('FastEthernet0/2', 10, { portfast: true }),
    section('interface Port-channel1', ['switchport mode trunk']),
    section('interface GigabitEthernet0/1', ['switchport mode trunk', 'channel-group 1 mode passive']),
    section('interface GigabitEthernet0/2', ['switchport mode access', 'channel-group 1 mode passive']),
  ]);
}

/** SW1 and SW2 joined by two parallel cables; two PCs in VLAN 10 on each switch. */
export const ccna2EtherchannelLacp: ScenarioInfo = {
  name: 'ccna2-etherchannel-lacp',
  category: 'ccna2-lab',
  labType: 'build',
  course: 'CCNA 2',
  topic: 'EtherChannel',
  title: 'Bundle two links with LACP',
  description:
    'Two switches are joined by two cables, yet spanning tree lets only one carry traffic. SW2 already offers an LACP bundle, passively and with one member set up wrongly. Negotiate the bundle from SW1, repair the odd member, choose how traffic is spread and show the bundle survives a lost cable.',
  objectives: [
    'Bundle parallel links into one logical link with LACP',
    'Tell bundled, individual and suspended members apart',
    'Find the setting that keeps a member out of its bundle',
    'Choose how frames are spread over the members',
  ],
  tags: ['etherchannel', 'lacp', 'port-channel', 'link aggregation', 'load balancing', 'spanning tree'],
  difficulty: 2,
  estimatedMinutes: 25,
  requires: [PC, SWITCH],
  seed: 217,
  instructions: [
    '## What you have',
    '',
    'SW1 and SW2 are joined by two cables: `GigabitEthernet0/1` to `GigabitEthernet0/1` and `GigabitEthernet0/2` to `GigabitEthernet0/2`. PC1 and PC2 on SW1 and PC3 and PC4 on SW2 are all in VLAN 10 (`STAFF`, `192.168.17.0/24`).',
    '',
    '- SW2 has put both cables in channel group 1 in passive LACP mode: it answers a partner but never starts a negotiation. Run `show etherchannel summary` on SW2: with nobody to negotiate with, both members run on their own (individual).',
    '- SW1 has no bundle yet, so spanning tree sees two parallel links and blocks one of them.',
    '',
    '## What to do',
    '',
    '- On SW1, make both uplinks trunks and put them in channel group 1 in active LACP mode (`interface range`, `switchport mode trunk`, `channel-group 1 mode active`).',
    '- Look at SW2 again: one member joins the bundle, the other is suspended. Find the setting that differs and give that member the same switchport settings as the bundle.',
    '- On both switches, spread frames by source and destination address (`port-channel load-balance src-dst-mac`).',
    '- Check that spanning tree now sees one port, `Port-channel1`, and that it forwards.',
    '',
    '*Spanning tree still runs on the links between the switches: a port that comes up listens and learns for 30 s before it forwards. The PC ports are edge ports and forward at once.*',
  ].join('\n'),
  build: () =>
    topology(
      217,
      [
        device('sw1', SWITCH, 'SW1', 250, 220, sw1Config()),
        device('sw2', SWITCH, 'SW2', 570, 220, sw2Config()),
        device('pc1', PC, 'PC1', 110, 90, pcConfig('PC1', '192.168.17.11', MASK24)),
        device('pc2', PC, 'PC2', 110, 380, pcConfig('PC2', '192.168.17.12', MASK24)),
        device('pc3', PC, 'PC3', 710, 90, pcConfig('PC3', '192.168.17.13', MASK24)),
        device('pc4', PC, 'PC4', 710, 380, pcConfig('PC4', '192.168.17.14', MASK24)),
      ],
      [
        link('l_sw1_sw2_a', 'sw1', 'GigabitEthernet0/1', 'sw2', 'GigabitEthernet0/1'),
        link('l_sw1_sw2_b', 'sw1', 'GigabitEthernet0/2', 'sw2', 'GigabitEthernet0/2'),
        link('l_pc1_sw1', 'pc1', 'GigabitEthernet0', 'sw1', 'FastEthernet0/1'),
        link('l_pc2_sw1', 'pc2', 'GigabitEthernet0', 'sw1', 'FastEthernet0/2'),
        link('l_pc3_sw2', 'pc3', 'GigabitEthernet0', 'sw2', 'FastEthernet0/1'),
        link('l_pc4_sw2', 'pc4', 'GigabitEthernet0', 'sw2', 'FastEthernet0/2'),
      ],
      ['Negotiate an LACP bundle', 'Repair the suspended member', 'Spread traffic over both members', 'Survive the loss of one cable'],
      'A bundle is one port to spanning tree and to the MAC table, so both cables carry traffic at once. Every member must be configured like the bundle, or it is suspended.',
      { profile: 'P2' },
    ),
  tasks: [
    {
      id: 'lacp-active',
      title: 'SW1 negotiates with LACP',
      description: 'Both uplinks of SW1 are members of channel group 1 in active LACP mode.',
      points: 20,
      hint: 'Passive against passive never forms a bundle: one side has to start the negotiation.',
      assertions: [
        { kind: 'etherchannel', device: 'SW1', group: 1, protocol: 'lacp' },
        { kind: 'table', device: 'SW1', table: 'etherchannel', where: { port: 'GigabitEthernet0/1', group: 1, mode: 'active' }, exists: true },
        { kind: 'table', device: 'SW1', table: 'etherchannel', where: { port: 'GigabitEthernet0/2', group: 1, mode: 'active' }, exists: true },
      ],
    },
    {
      id: 'fix-member',
      title: 'The suspended member rejoins',
      description: 'GigabitEthernet0/2 of SW2 is a trunk like the rest of the bundle, and both members of SW2 are bundled.',
      points: 20,
      hint: 'show etherchannel summary gives the reason a member is suspended.',
      assertions: [
        { kind: 'switchport', device: 'SW2', port: 'GigabitEthernet0/2', mode: 'trunk' },
        { kind: 'etherchannel', device: 'SW2', group: 1, bundled: ['GigabitEthernet0/1', 'GigabitEthernet0/2'] },
      ],
      feedbackOnFail: 'A member whose switchport settings differ from its Port-channel is suspended and carries nothing.',
    },
    {
      id: 'one-logical-link',
      title: 'Spanning tree sees one link',
      description: 'Port-channel1 of SW1 is up with both members bundled, and so is the one of SW2; it forwards in VLAN 10, and neither member takes part in spanning tree on its own.',
      points: 20,
      dependsOn: ['lacp-active', 'fix-member'],
      assertions: [
        { kind: 'etherchannel', device: 'SW1', group: 1, up: true, bundled: ['GigabitEthernet0/1', 'GigabitEthernet0/2'] },
        // a bundle has two ends: SW1 bundling on its own (mode on against SW2's lone LACP members) is not one link
        { kind: 'etherchannel', device: 'SW2', group: 1, up: true },
        { kind: 'stp', device: 'SW1', vlan: 10, port: 'Port-channel1', state: 'forwarding' },
        { kind: 'table', device: 'SW1', table: 'stp', where: { port: 'GigabitEthernet0/1' }, exists: false },
        { kind: 'table', device: 'SW1', table: 'stp', where: { port: 'GigabitEthernet0/2' }, exists: false },
      ],
    },
    {
      id: 'load-balance',
      title: 'Traffic is spread by both addresses',
      description: 'Both switches choose the member of a frame from its source and destination MAC addresses.',
      points: 10,
      assertions: [
        { kind: 'config', device: 'SW1', path: 'port-channel.load-balance', equals: 'load-balance src-dst-mac' },
        { kind: 'config', device: 'SW2', path: 'port-channel.load-balance', equals: 'load-balance src-dst-mac' },
      ],
    },
    {
      id: 'lose-a-cable',
      title: 'The bundle survives a lost cable',
      description: 'One second after GigabitEthernet0/1 of SW1 is shut down, PC1 still reaches PC3, and Port-channel1 is still up.',
      points: 30,
      dependsOn: ['lacp-active', 'fix-member'],
      hint: 'Two separate links would leave the job to spanning tree, which needs 30 s to open the blocked one.',
      assertions: [
        {
          kind: 'connectivity',
          from: 'PC1',
          to: 'PC3',
          expect: 'success',
          after: [{ shutdown: { device: 'SW1', port: 'GigabitEthernet0/1' } }],
          settleMs: 1000,
          then: [
            { kind: 'etherchannel', device: 'SW1', group: 1, up: true, bundled: ['GigabitEthernet0/2'] },
            { kind: 'etherchannel', device: 'SW2', group: 1, up: true },
          ],
        },
      ],
      feedbackOnFail: 'Losing a member of a healthy bundle only moves its flows to the other member; nothing has to reconverge.',
    },
  ],
  solution: {
    SW1: [
      'interface range GigabitEthernet0/1 - 2',
      'switchport mode trunk',
      'channel-group 1 mode active',
      'exit',
      'port-channel load-balance src-dst-mac',
    ],
    SW2: ['interface GigabitEthernet0/2', 'switchport mode trunk', 'exit', 'port-channel load-balance src-dst-mac'],
  },
};

/** The EtherChannel labs, in course order. */
export const CCNA2_ETHERCHANNEL_LABS: readonly ScenarioInfo[] = [ccna2EtherchannelLacp];
