/**
 * sim/scenarios/ccna2/stp.ts — the CCNA 2 spanning-tree labs (ARCHITECTURE-P2 §3.6, §11.1, §11.2).
 *
 *   • `ccna2-stp-root-placement` — lesson 13 "Electing a root" (module "Spanning tree"): the access switch with the
 *     lowest address wins every election; move the root of VLAN 10 to DS1 and of VLAN 20 to DS2, each the backup of
 *     the other, and read which port blocks as a result.
 *   • `ccna2-rapid-stp`          — lesson 15 "Rapid spanning tree" (module "Spanning tree"): a rapid core switch
 *     speaks classic spanning tree to two older access switches; move them to rapid mode and prove a cut link heals
 *     in about a second instead of thirty.
 *   • `ccna2-stp-guards`         — lesson 16 "Edge ports and guards" (module "Spanning tree"): PortFast on the host
 *     ports, BPDU guard against a desk switch that claims the root, root guard against a neighbouring building's
 *     switch, and a port a guard shut down brought back.
 *
 * Every world is a P2 profile (spanning tree on by default, §4.4) built with the kit, with a fixed seed. Device ids
 * are chosen for their base MAC (`deviceMacBase`): with equal priorities the lowest MAC wins, and the root-placement
 * lab needs the access switch (`acc1`, 02:01:…) to win below both distribution switches (`dist1` 02:1b:…, `dist2`
 * 02:f5:…) — that is what makes the default election land on the wrong switch and what makes a missing backup root
 * visible (without `root secondary` the access switch, not the other distribution switch, takes over).
 *
 * Tasks read structured state only (sim/lab-checks.ts): the `stp` kind (root, root bridge by name, port role, state
 * and edge flag, mode), `table` rows of `stp` for what the `stp` kind does not carry (the port protocol, a root
 * inconsistency), `port` (errDisabled, operUp) and `connectivity` — with `after` faults for the failover checks and
 * `then` to read the tree the failover left. All wording is original (§1.6, D22).
 *
 * ponytail: the failover checks run in the grader's fault clones (one per fault set), so a backup root or a rapid
 * tree is proved by what happens when a switch or cable is lost, not by the line that configures it.
 */
import type { ScenarioInfo } from '../../../contracts/scenario.js';
import { MASK24, MLSWITCH_RAPID, PC, SERVER, SWITCH, accessPort, configText, device, errDisableFault, link, section, topology, trunkPort, vlanSections } from '../kit.js';
import { pcConfig } from '../templates.js';

/** The sentence every spanning-tree lab repeats: a port that is not an edge port waits through two 15 s phases. */
const FORWARD_DELAY_NOTE =
  '*Spanning tree runs on every switch here. A port that comes up, or changes role, listens for 15 s and learns for 15 s before it forwards — so give the network half a minute after each change before you test it.*';

// ── root placement ──────────────────────────────────────────────────────────

/** VLANs of the root-placement lab (both carried on every trunk, nothing else). */
const ROOT_VLANS = [
  { id: 10, name: 'OFFICE' },
  { id: 20, name: 'LAB' },
] as const;

/** A trunk of the root-placement triangle: carries exactly VLANs 10 and 20. */
const rootTrunk = (port: string): string[] => trunkPort(port, { allowed: '10,20' });

/** A distribution or access switch of the triangle: its VLANs, its two trunks and its host ports. */
function triangleSwitch(hostname: string, hosts: readonly (readonly [port: string, vlan: number])[]): string {
  return configText([
    [`hostname ${hostname}`],
    ...vlanSections(ROOT_VLANS),
    rootTrunk('GigabitEthernet0/1'),
    rootTrunk('GigabitEthernet0/2'),
    ...hosts.map(([port, vlan]) => accessPort(port, vlan)),
  ]);
}

/** DS1, DS2 and AS1 in a triangle of trunks; every switch keeps its default priority, so AS1 wins by its address. */
export const ccna2StpRootPlacement: ScenarioInfo = {
  name: 'ccna2-stp-root-placement',
  category: 'ccna2-lab',
  labType: 'build',
  course: 'CCNA 2',
  topic: 'Spanning tree',
  title: 'Put the root where it belongs',
  description:
    'Three switches in a triangle elect a root for each VLAN, and with every priority left alone the access switch wins both elections. Move the root of VLAN 10 to DS1 and of VLAN 20 to DS2, make each distribution switch the backup of the other, and read which port blocks.',
  objectives: [
    'Predict the root bridge from bridge priorities and addresses',
    'Place the root of a VLAN with a priority or the root macro',
    'Choose a backup root that takes over when the root fails',
    'Work out which port blocks once the roots are in place',
  ],
  tags: ['spanning tree', 'root bridge', 'bridge priority', 'pvst', 'per-vlan', 'root primary', 'root secondary'],
  difficulty: 2,
  estimatedMinutes: 25,
  requires: [PC, SWITCH],
  seed: 213,
  instructions: [
    '## What you have',
    '',
    'DS1 and DS2 are distribution switches, AS1 is an access switch. The three are joined by trunks that carry VLAN 10 (`OFFICE`, `192.168.10.0/24`) and VLAN 20 (`LAB`, `192.168.20.0/24`). PC1 (VLAN 10) and PC2 (VLAN 20) sit on AS1, PC3 (VLAN 10) on DS2 and PC4 (VLAN 20) on DS1.',
    '',
    'Nobody has touched a priority, so every bridge id starts with `32768` plus the VLAN number, and the lowest MAC address decides. Run `show spanning-tree vlan 10` on each switch and find the root before you change anything.',
    '',
    '## What to do',
    '',
    '- Make DS1 the root of VLAN 10 and DS2 the root of VLAN 20 (`spanning-tree vlan <v> root primary`, or a priority below 32768 in steps of 4096).',
    '- Make DS2 the backup root of VLAN 10 and DS1 the backup root of VLAN 20 (`root secondary`), so that losing one distribution switch never hands a VLAN to the access switch.',
    '- Read the result on AS1: for each VLAN, which uplink is the root port and which one is blocked?',
    '',
    FORWARD_DELAY_NOTE,
  ].join('\n'),
  build: () =>
    topology(
      213,
      [
        device('dist1', SWITCH, 'DS1', 230, 130, triangleSwitch('DS1', [['FastEthernet0/1', 20]])),
        device('dist2', SWITCH, 'DS2', 590, 130, triangleSwitch('DS2', [['FastEthernet0/1', 10]])),
        device('acc1', SWITCH, 'AS1', 410, 320, triangleSwitch('AS1', [['FastEthernet0/1', 10], ['FastEthernet0/2', 20]])),
        device('pc1', PC, 'PC1', 300, 450, pcConfig('PC1', '192.168.10.11', MASK24)),
        device('pc2', PC, 'PC2', 520, 450, pcConfig('PC2', '192.168.20.12', MASK24)),
        device('pc3', PC, 'PC3', 760, 60, pcConfig('PC3', '192.168.10.13', MASK24)),
        device('pc4', PC, 'PC4', 60, 60, pcConfig('PC4', '192.168.20.14', MASK24)),
      ],
      [
        link('l_ds1_ds2', 'dist1', 'GigabitEthernet0/1', 'dist2', 'GigabitEthernet0/1'),
        link('l_ds1_as1', 'dist1', 'GigabitEthernet0/2', 'acc1', 'GigabitEthernet0/1'),
        link('l_ds2_as1', 'dist2', 'GigabitEthernet0/2', 'acc1', 'GigabitEthernet0/2'),
        link('l_pc1_as1', 'pc1', 'GigabitEthernet0', 'acc1', 'FastEthernet0/1'),
        link('l_pc2_as1', 'pc2', 'GigabitEthernet0', 'acc1', 'FastEthernet0/2'),
        link('l_pc3_ds2', 'pc3', 'GigabitEthernet0', 'dist2', 'FastEthernet0/1'),
        link('l_pc4_ds1', 'pc4', 'GigabitEthernet0', 'dist1', 'FastEthernet0/1'),
      ],
      ['Find the root of each VLAN', 'Move the roots to the distribution switches', 'Give each VLAN a backup root', 'Read the blocked ports'],
      'Each VLAN elects its own root: the lowest priority wins, and with equal priorities the lowest MAC address. Left alone, that is an accident of manufacturing, not a design.',
      { profile: 'P2' },
    ),
  tasks: [
    {
      id: 'vlan10-root',
      title: 'DS1 is the root of VLAN 10',
      description: 'DS1 is the root bridge of VLAN 10, and AS1 and DS2 agree.',
      points: 25,
      hint: 'A priority only wins the election when it is lower than every other bridge id in that VLAN.',
      assertions: [
        { kind: 'stp', device: 'DS1', vlan: 10, root: true },
        { kind: 'stp', device: 'AS1', vlan: 10, rootBridge: 'DS1' },
        { kind: 'stp', device: 'DS2', vlan: 10, rootBridge: 'DS1' },
      ],
      feedbackOnFail: 'Every bridge of the VLAN has to see the same root. Check the priority on DS1 with show spanning-tree vlan 10.',
    },
    {
      id: 'vlan20-root',
      title: 'DS2 is the root of VLAN 20',
      description: 'DS2 is the root bridge of VLAN 20, and AS1 and DS1 agree.',
      points: 25,
      assertions: [
        { kind: 'stp', device: 'DS2', vlan: 20, root: true },
        { kind: 'stp', device: 'AS1', vlan: 20, rootBridge: 'DS2' },
        { kind: 'stp', device: 'DS1', vlan: 20, rootBridge: 'DS2' },
      ],
      feedbackOnFail: 'The trees of VLAN 10 and VLAN 20 are separate elections; a priority set for one VLAN does nothing for the other.',
    },
    {
      id: 'blocked-ports',
      title: 'AS1 blocks the uplink that is not needed',
      description: 'On AS1, VLAN 10 blocks the uplink to DS2 and VLAN 20 blocks the uplink to DS1.',
      points: 20,
      dependsOn: ['vlan10-root', 'vlan20-root'],
      hint: 'On the link between the backup root and AS1 both ends are one hop from the root; the lower bridge id wins that segment.',
      assertions: [
        { kind: 'stp', device: 'AS1', vlan: 10, port: 'GigabitEthernet0/1', role: 'root', state: 'forwarding' },
        { kind: 'stp', device: 'AS1', vlan: 10, port: 'GigabitEthernet0/2', role: 'alternate', state: 'blocking' },
        { kind: 'stp', device: 'AS1', vlan: 20, port: 'GigabitEthernet0/2', role: 'root', state: 'forwarding' },
        { kind: 'stp', device: 'AS1', vlan: 20, port: 'GigabitEthernet0/1', role: 'alternate', state: 'blocking' },
      ],
      feedbackOnFail: 'While AS1 has a lower bridge id than the backup root, AS1 wins the link between them and the backup root blocks instead.',
    },
    {
      id: 'backup-roots',
      title: 'A lost root is replaced by the other distribution switch',
      description: 'DS1 is the root of VLAN 10 and DS2 of VLAN 20. With DS1 switched off, DS2 becomes the root of VLAN 10 and PC1 still reaches PC3; with DS2 switched off, DS1 becomes the root of VLAN 20 and PC2 still reaches PC4.',
      points: 30,
      dependsOn: ['vlan10-root', 'vlan20-root'],
      hint: 'root secondary sets a priority between the root and the default, so the backup beats every untouched switch.',
      assertions: [
        // the switch each failover powers off really is the root it replaces (not a swapped or missing primary)
        { kind: 'stp', device: 'DS1', vlan: 10, root: true },
        { kind: 'stp', device: 'DS2', vlan: 20, root: true },
        {
          kind: 'connectivity',
          from: 'PC1',
          to: 'PC3',
          expect: 'success',
          after: [{ powerOff: 'DS1' }],
          then: [
            { kind: 'stp', device: 'DS2', vlan: 10, root: true },
            { kind: 'stp', device: 'AS1', vlan: 10, rootBridge: 'DS2' },
          ],
        },
        {
          kind: 'connectivity',
          from: 'PC2',
          to: 'PC4',
          expect: 'success',
          after: [{ powerOff: 'DS2' }],
          then: [
            { kind: 'stp', device: 'DS1', vlan: 20, root: true },
            { kind: 'stp', device: 'AS1', vlan: 20, rootBridge: 'DS1' },
          ],
        },
      ],
      feedbackOnFail: 'When the root disappears the next-lowest bridge id takes over. With default priorities that is AS1, whose address is the lowest.',
    },
  ],
  solution: {
    DS1: ['spanning-tree vlan 10 root primary', 'spanning-tree vlan 20 root secondary'],
    DS2: ['spanning-tree vlan 20 root primary', 'spanning-tree vlan 10 root secondary'],
  },
};

// ── rapid spanning tree ─────────────────────────────────────────────────────

/** An access switch of the rapid lab: its PC port is already an edge port. */
function rapidAccessSwitch(hostname: string): string {
  return configText([[`hostname ${hostname}`], accessPort('FastEthernet0/1', 1, { portfast: true })]);
}

/** CORE1 (NF-C9300, rapid by default, the root) with SW1 and SW2 (NF-C2960, classic by default) in a triangle. */
export const ccna2RapidStp: ScenarioInfo = {
  name: 'ccna2-rapid-stp',
  category: 'ccna2-lab',
  labType: 'guided',
  course: 'CCNA 2',
  topic: 'Spanning tree',
  title: 'Move a network to rapid spanning tree',
  description:
    'The core switch already runs the rapid version of spanning tree, but the two access switches still run the classic one, so the core falls back to the old protocol on every link it shares with them. Move both switches to rapid mode and prove that a cut link now heals in about a second.',
  objectives: [
    'Recognise a rapid switch that has fallen back to classic spanning tree',
    'Switch a network to rapid per-VLAN spanning tree',
    'Compare classic and rapid convergence after a link failure',
  ],
  tags: ['spanning tree', 'rapid spanning tree', 'rapid-pvst', 'convergence', 'protocol migration'],
  difficulty: 2,
  estimatedMinutes: 20,
  requires: [MLSWITCH_RAPID, PC, SWITCH],
  seed: 215,
  instructions: [
    '## What you have',
    '',
    'CORE1 is a newer multilayer switch whose spanning tree runs in rapid mode out of the box; it is the root (priority 4096). SW1 and SW2 are older access switches still in classic mode. The three form a triangle, and PC1 (SW1) and PC2 (SW2) share `192.168.15.0/24`. Their host ports are already edge ports.',
    '',
    '- Run `show spanning-tree` on CORE1. The ports towards SW1 and SW2 show that they speak the classic protocol: a rapid switch falls back, port by port, when its neighbour only understands the old one.',
    '- On SW1 one uplink is blocked. If the other uplink fails, a classic switch needs 30 s before the blocked one forwards.',
    '',
    '## What to do',
    '',
    '- Put SW1 and SW2 in rapid mode (`spanning-tree mode rapid-pvst`).',
    '- Check CORE1 again: its ports should now speak the rapid protocol. A port that stays on the classic one can be told to test its neighbour again with `clear spanning-tree detected-protocols`.',
    '- Think about what happens now when the cable between CORE1 and SW1 fails, and why the blocked port can take over without waiting.',
    '',
    FORWARD_DELAY_NOTE,
  ].join('\n'),
  build: () =>
    topology(
      215,
      [
        device('core1', MLSWITCH_RAPID, 'CORE1', 410, 110, configText([['hostname CORE1'], ['spanning-tree vlan 1 priority 4096']])),
        device('sw1', SWITCH, 'SW1', 230, 290, rapidAccessSwitch('SW1')),
        device('sw2', SWITCH, 'SW2', 590, 290, rapidAccessSwitch('SW2')),
        device('pc1', PC, 'PC1', 150, 440, pcConfig('PC1', '192.168.15.11', MASK24)),
        device('pc2', PC, 'PC2', 670, 440, pcConfig('PC2', '192.168.15.12', MASK24)),
      ],
      [
        link('l_core1_sw1', 'core1', 'GigabitEthernet1/0/1', 'sw1', 'GigabitEthernet0/1'),
        link('l_core1_sw2', 'core1', 'GigabitEthernet1/0/2', 'sw2', 'GigabitEthernet0/1'),
        link('l_sw1_sw2', 'sw1', 'GigabitEthernet0/2', 'sw2', 'GigabitEthernet0/2'),
        link('l_pc1_sw1', 'pc1', 'GigabitEthernet0', 'sw1', 'FastEthernet0/1'),
        link('l_pc2_sw2', 'pc2', 'GigabitEthernet0', 'sw2', 'FastEthernet0/1'),
      ],
      ['Spot the classic fallback on the core', 'Run rapid spanning tree everywhere', 'Survive a cut link in about a second'],
      'Rapid spanning tree replaces the listening and learning timers with a handshake between neighbours, but only where both ends speak it; facing a classic switch, a rapid port speaks the classic protocol too.',
      { profile: 'P2' },
    ),
  tasks: [
    {
      id: 'sw1-rapid',
      title: 'SW1 runs rapid spanning tree',
      description: 'The spanning tree of SW1 runs in rapid-pvst mode.',
      points: 20,
      assertions: [{ kind: 'stp', device: 'SW1', vlan: 1, mode: 'rapid-pvst' }],
    },
    {
      id: 'sw2-rapid',
      title: 'SW2 runs rapid spanning tree',
      description: 'The spanning tree of SW2 runs in rapid-pvst mode.',
      points: 20,
      assertions: [{ kind: 'stp', device: 'SW2', vlan: 1, mode: 'rapid-pvst' }],
    },
    {
      id: 'no-fallback',
      title: 'No link falls back to the classic protocol',
      description: 'CORE1 speaks the rapid protocol on both ports towards the access switches, and so do SW1 and SW2 on the link between them.',
      points: 20,
      dependsOn: ['sw1-rapid', 'sw2-rapid'],
      hint: 'show spanning-tree lists the protocol each port speaks; clear spanning-tree detected-protocols makes a port test its neighbour again.',
      assertions: [
        { kind: 'table', device: 'CORE1', table: 'stp', where: { vlan: 1, port: 'GigabitEthernet1/0/1', protocol: 'rstp' }, exists: true },
        { kind: 'table', device: 'CORE1', table: 'stp', where: { vlan: 1, port: 'GigabitEthernet1/0/2', protocol: 'rstp' }, exists: true },
        { kind: 'table', device: 'SW1', table: 'stp', where: { vlan: 1, port: 'GigabitEthernet0/2', protocol: 'rstp' }, exists: true },
        { kind: 'table', device: 'SW2', table: 'stp', where: { vlan: 1, port: 'GigabitEthernet0/2', protocol: 'rstp' }, exists: true },
      ],
      feedbackOnFail: 'A rapid port keeps speaking the classic protocol for as long as it hears classic BPDUs from its neighbour.',
    },
    {
      id: 'fast-failover',
      title: 'A cut uplink heals in about a second',
      description: 'Two seconds after the cable between CORE1 and SW1 is cut, PC1 already reaches PC2 over the link between SW1 and SW2, which is now the root port of SW1.',
      points: 40,
      dependsOn: ['sw1-rapid', 'sw2-rapid'],
      hint: 'A classic switch needs 30 s before a blocked port forwards; a rapid switch turns its alternate port into the root port at once.',
      assertions: [
        {
          kind: 'connectivity',
          from: 'PC1',
          to: 'PC2',
          expect: 'success',
          after: [{ cut: { a: 'CORE1', b: 'SW1' } }],
          settleMs: 2000,
          then: [{ kind: 'stp', device: 'SW1', vlan: 1, port: 'GigabitEthernet0/2', role: 'root', state: 'forwarding' }],
        },
      ],
      feedbackOnFail: 'Two seconds after the cut the blocked uplink is still listening, which is what classic spanning tree does on any switch of the path.',
    },
  ],
  solution: {
    SW1: ['spanning-tree mode rapid-pvst'],
    SW2: ['spanning-tree mode rapid-pvst'],
  },
};

// ── edge ports and guards ───────────────────────────────────────────────────

/**
 * Time the hidden fault err-disables PC3's port: at once, so the port is down from the first moment the learner looks
 * (it stays error-disabled through AS1's boot) and no check can see it healthy before the fault lands.
 */
const GUARDS_FAULT_AT = 0;

/** An access port of AS1 (VLAN 1) with extra interface lines. */
const hostPort = (port: string, extra: readonly string[] = []): string[] => section(`interface ${port}`, ['switchport mode access', ...extra]);

/**
 * DS1 (NF-C9300, rapid, priority 8192) with AS1 below it (rapid), a building-B switch beside it (priority 4096) and a
 * desk switch under AS1 set to win every election (priority 0). PC3's port was shut by BPDU guard before the lab starts.
 */
export const ccna2StpGuards: ScenarioInfo = {
  name: 'ccna2-stp-guards',
  category: 'ccna2-lab',
  labType: 'build',
  course: 'CCNA 2',
  topic: 'Spanning tree',
  title: 'Edge ports and spanning-tree guards',
  description:
    'A switch on a desk has taken over the root of the whole network, the switch of the building next door is waiting to do the same, and one office port was shut down by a guard yesterday. Make the host ports edge ports, stop both intruders with the right guard and bring the office port back.',
  objectives: [
    'Make host ports edge ports that forward at once',
    'Shut out a switch plugged into an access port with BPDU guard',
    'Keep the root on your side of a link with root guard',
    'Bring back a port that a guard error-disabled',
  ],
  tags: ['spanning tree', 'portfast', 'edge port', 'bpdu guard', 'root guard', 'err-disabled', 'rapid-pvst'],
  difficulty: 3,
  estimatedMinutes: 25,
  requires: [MLSWITCH_RAPID, PC, SERVER, SWITCH],
  seed: 216,
  instructions: [
    '## What you have',
    '',
    'DS1 is meant to be the root (priority 8192) and serves SRV. AS1 hangs below it with PC1, PC2 and PC3 on `FastEthernet0/1–3`; all hosts share `192.168.16.0/24`. Every switch runs rapid spanning tree.',
    '',
    '- Someone plugged DESK-SW into `FastEthernet0/4` of AS1, and it was set up with priority 0: run `show spanning-tree` on AS1 and see where the root is now.',
    '- BLDG-B, the switch of the building next door, is trunked to DS1 on `GigabitEthernet1/0/2` and has priority 4096. It must stay connected, but it must never become your root.',
    '- `FastEthernet0/3` was shut down by BPDU guard yesterday. The switch that caused it has gone and PC3 is plugged in now, but the port is still error-disabled.',
    '',
    '## What to do',
    '',
    '- Make the PC ports of AS1 edge ports (`spanning-tree portfast`).',
    '- Protect the access ports of AS1, including the one DESK-SW is on, with BPDU guard (`spanning-tree bpduguard enable`).',
    '- Put root guard on the DS1 port that faces BLDG-B (`spanning-tree guard root`).',
    '- Bring `FastEthernet0/3` back with `shutdown` followed by `no shutdown`, and ping SRV from PC3.',
    '',
    '*A port that is not an edge port waits 30 s before it forwards, in rapid mode too, because a host never answers the rapid handshake.*',
  ].join('\n'),
  build: () =>
    topology(
      216,
      [
        device(
          'dist1',
          MLSWITCH_RAPID,
          'DS1',
          410,
          110,
          configText([
            ['hostname DS1'],
            ['spanning-tree vlan 1 priority 8192'],
            trunkPort('GigabitEthernet1/0/1'),
            trunkPort('GigabitEthernet1/0/2'),
            accessPort('GigabitEthernet1/0/3', 1, { portfast: true }),
          ]),
        ),
        device(
          'acc1',
          SWITCH,
          'AS1',
          410,
          290,
          configText([
            ['hostname AS1'],
            ['spanning-tree mode rapid-pvst'],
            trunkPort('GigabitEthernet0/1'),
            hostPort('FastEthernet0/1'),
            hostPort('FastEthernet0/2'),
            hostPort('FastEthernet0/3', ['spanning-tree portfast', 'spanning-tree bpduguard enable']),
            hostPort('FastEthernet0/4'),
          ]),
        ),
        device('partner', SWITCH, 'BLDG-B', 690, 110, configText([['hostname BLDG-B'], ['spanning-tree mode rapid-pvst'], ['spanning-tree vlan 1 priority 4096'], trunkPort('GigabitEthernet0/1')])),
        device('desk', SWITCH, 'DESK-SW', 690, 400, configText([['hostname DESK-SW'], ['spanning-tree mode rapid-pvst'], ['spanning-tree vlan 1 priority 0']])),
        device('srv', SERVER, 'SRV', 150, 110, pcConfig('SRV', '192.168.16.100', MASK24)),
        device('pc1', PC, 'PC1', 190, 440, pcConfig('PC1', '192.168.16.11', MASK24)),
        device('pc2', PC, 'PC2', 340, 460, pcConfig('PC2', '192.168.16.12', MASK24)),
        device('pc3', PC, 'PC3', 490, 460, pcConfig('PC3', '192.168.16.13', MASK24)),
      ],
      [
        link('l_ds1_as1', 'dist1', 'GigabitEthernet1/0/1', 'acc1', 'GigabitEthernet0/1'),
        link('l_ds1_bldgb', 'dist1', 'GigabitEthernet1/0/2', 'partner', 'GigabitEthernet0/1'),
        link('l_srv_ds1', 'srv', 'GigabitEthernet0', 'dist1', 'GigabitEthernet1/0/3'),
        link('l_pc1_as1', 'pc1', 'GigabitEthernet0', 'acc1', 'FastEthernet0/1'),
        link('l_pc2_as1', 'pc2', 'GigabitEthernet0', 'acc1', 'FastEthernet0/2'),
        link('l_pc3_as1', 'pc3', 'GigabitEthernet0', 'acc1', 'FastEthernet0/3'),
        link('l_desk_as1', 'desk', 'GigabitEthernet0/1', 'acc1', 'FastEthernet0/4'),
      ],
      ['Make the host ports edge ports', 'Shut out the desk switch', 'Keep the root away from building B', 'Bring back the port a guard shut down'],
      'BPDU guard belongs on ports where no switch should ever be: one BPDU and the port is error-disabled. Root guard belongs on ports where a switch is welcome but a better root is not: the port blocks while the superior BPDUs keep coming.',
      { profile: 'P2' },
    ),
  faults: [errDisableFault(GUARDS_FAULT_AT, 'acc1', 'FastEthernet0/3', 'bpduguard')],
  tasks: [
    {
      id: 'edge-ports',
      title: 'The PC ports are edge ports',
      description: 'FastEthernet0/1 and FastEthernet0/2 of AS1 are edge ports and forward.',
      points: 20,
      assertions: [
        { kind: 'stp', device: 'AS1', vlan: 1, port: 'FastEthernet0/1', edge: true, state: 'forwarding' },
        { kind: 'stp', device: 'AS1', vlan: 1, port: 'FastEthernet0/2', edge: true, state: 'forwarding' },
      ],
      feedbackOnFail: 'An edge port forwards at link-up; any other port waits for the handshake or the timers first.',
    },
    {
      id: 'bpdu-guard',
      title: 'The desk switch is shut out',
      description: 'BPDU guard error-disabled FastEthernet0/4 of AS1, where DESK-SW is plugged in.',
      points: 25,
      hint: 'Root guard would only block the port while the BPDUs last; BPDU guard shuts it down at the first one.',
      assertions: [{ kind: 'port', device: 'AS1', port: 'FastEthernet0/4', field: 'errDisabled', equals: 'bpduguard' }],
      feedbackOnFail: 'FastEthernet0/4 still accepts BPDUs, so DESK-SW keeps taking part in the election.',
    },
    {
      id: 'root-guard',
      title: 'The root stays on DS1',
      description: 'DS1 is the root, AS1 agrees, and DS1 blocks GigabitEthernet1/0/2 as root-inconsistent while BLDG-B claims a better root.',
      points: 30,
      dependsOn: ['bpdu-guard'],
      hint: 'Root guard goes on the DS1 port that faces BLDG-B, not on the switch that makes the claim.',
      assertions: [
        { kind: 'stp', device: 'DS1', vlan: 1, root: true },
        { kind: 'stp', device: 'AS1', vlan: 1, rootBridge: 'DS1' },
        { kind: 'table', device: 'DS1', table: 'stp', where: { vlan: 1, port: 'GigabitEthernet1/0/2', inconsistent: 'root' }, exists: true },
      ],
      feedbackOnFail: 'With a lower priority than DS1, BLDG-B wins the election unless the port it arrives on refuses superior BPDUs.',
    },
    {
      id: 'recover-port',
      title: 'PC3 is back online',
      description: 'FastEthernet0/3 of AS1 is no longer error-disabled, is up, and PC3 reaches SRV.',
      points: 25,
      hint: 'An error-disabled port comes back when it is shut down and enabled again.',
      assertions: [
        { kind: 'port', device: 'AS1', port: 'FastEthernet0/3', field: 'errDisabled', equals: false },
        { kind: 'port', device: 'AS1', port: 'FastEthernet0/3', field: 'operUp', equals: true },
        { kind: 'connectivity', from: 'PC3', to: 'SRV', expect: 'success' },
      ],
    },
  ],
  solution: {
    AS1: [
      'interface range FastEthernet0/1 - 2',
      'spanning-tree portfast',
      'spanning-tree bpduguard enable',
      'exit',
      'interface FastEthernet0/4',
      'spanning-tree portfast',
      'spanning-tree bpduguard enable',
      'exit',
      'interface FastEthernet0/3',
      'shutdown',
      'no shutdown',
      'exit',
    ],
    DS1: ['interface GigabitEthernet1/0/2', 'spanning-tree guard root', 'exit'],
  },
};

/** The spanning-tree labs, in course order. */
export const CCNA2_STP_LABS: readonly ScenarioInfo[] = [ccna2StpRootPlacement, ccna2RapidStp, ccna2StpGuards];
