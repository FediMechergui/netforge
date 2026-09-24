/**
 * sim/scenarios/ccna2/trunks.ts — the CCNA 2 trunk labs (ARCHITECTURE-P2 §11.1, §11.2).
 *
 *   • `ccna2-trunk-native-allowed` — lesson 06 "Trunks and tags" (module "VLANs"): join two switches with a static
 *     802.1Q trunk, move its native VLAN off VLAN 1, trim its allowed list to the VLANs in use, and see the tag a
 *     switch adds in the provenance view (§3.2).
 *   • `ccna2-dtp-modes`            — lesson 07 "Trunk negotiation" (module "VLANs"): three links, three outcomes of
 *     trunk negotiation — a trunk one end asks for, a fixed trunk with negotiation off on both ends, and a port that
 *     refuses the trunk a visiting switch keeps asking for (§3.3).
 *
 * P2-profile worlds (`topology(…, { profile: 'P2' })`): spanning tree runs, so host ports are edge ports in the
 * startup configuration, and the instructions warn that a switch-to-switch port that starts trunking listens and
 * learns for 30 s before it forwards (§11.2). Tasks read structured state only (sim/lab-checks.ts: `switchport`
 * reads the configuration and the negotiated mode, `table` reads the `dtp` rows, `connectivity` pings in the
 * grader's clone), and every lab carries a reference `solution` that `Simulation.configure` accepts as written
 * (test/labs.ccna2.solutions.test.ts). All wording is original (§0 rule 6); DTP is named as CCNA vocabulary only.
 *
 * A lab file imports only the contracts, `../kit.js` and `../templates.js` — never `./index.js`, `../index.js` or
 * the engine barrel — so the catalogue stays an acyclic graph of data modules (the arrays are read at module scope).
 *
 * ponytail: "negotiation off" is graded by the absence of a `dtp` row — a `switchport nonegotiate` port keeps none,
 * while a static trunk that still negotiates has one from link-up and an access port has one as soon as it hears a
 * neighbour (§3.3, §4.3). Reading the tag in the provenance view is a guided step of the trunk lab, not a graded
 * one: a trace filter cannot select frames by VLAN (TraceFilter has no VLAN key, and trace summaries carry no layer
 * stack for `protos: ['dot1q']` to match), so the tag is graded through what it implies — the native VLAN is 99 on
 * both ends and VLANs 10 and 20 still reach the far switch.
 */
import type { ScenarioInfo } from '../../../contracts/scenario.js';
import { MASK24, PC, SWITCH, accessPort, configText, device, link, section, topology, vlanSections } from '../kit.js';
import { pcConfig } from '../templates.js';

// ── trunk, native VLAN, allowed list ────────────────────────────────────────

/** The VLANs both switches of the trunk lab carry in their database. */
const TRUNK_LAB_VLANS = [
  { id: 10, name: 'SALES' },
  { id: 20, name: 'STAFF' },
  { id: 30, name: 'BENCH' },
  { id: 99, name: 'NATIVE' },
] as const;

/** The native VLAN the trunk lab moves to. */
export const TRUNK_LAB_NATIVE_VLAN = 99;
/** The allowed list of the trunk lab, as the student types it. */
export const TRUNK_LAB_ALLOWED = '10,20,99';

/** One switch of the trunk lab: the VLANs, three edge access ports and a management address in the native VLAN. */
function trunkLabSwitch(name: string, managementAddress: string): string {
  return configText([
    [`hostname ${name}`],
    ...vlanSections(TRUNK_LAB_VLANS),
    accessPort('FastEthernet0/1', 10, { portfast: true }),
    accessPort('FastEthernet0/2', 20, { portfast: true }),
    accessPort('FastEthernet0/3', 30, { portfast: true }),
    section(`interface Vlan${TRUNK_LAB_NATIVE_VLAN}`, [`ip address ${managementAddress} ${MASK24}`, 'no shutdown']),
  ]);
}

/** The reference trunk lines of one end. */
const TRUNK_SOLUTION: readonly string[] = [
  'interface GigabitEthernet0/1',
  'switchport mode trunk',
  `switchport trunk native vlan ${TRUNK_LAB_NATIVE_VLAN}`,
  `switchport trunk allowed vlan ${TRUNK_LAB_ALLOWED}`,
  'exit',
];

/** Two access switches with matching VLANs, joined by a cable that is not a trunk yet. */
export const ccna2TrunkNativeAllowed: ScenarioInfo = {
  name: 'ccna2-trunk-native-allowed',
  category: 'ccna2-lab',
  labType: 'build',
  course: 'CCNA 2',
  topic: 'VLANs',
  title: 'Build a trunk: native VLAN and allowed list',
  description:
    'Two switches share the same VLANs, but the cable between them carries only VLAN 1. Turn it into an 802.1Q trunk, move the native VLAN to 99, let only the VLANs that must cross use it, and find the tag in a crossing frame.',
  objectives: [
    'Make a switch port a static 802.1Q trunk',
    'Choose the native VLAN of a trunk and keep it the same on both ends',
    'Limit a trunk to the VLANs that have to cross it',
    'Find the VLAN tag a switch adds to a frame, and the switch that removes it, in the provenance view',
  ],
  tags: ['trunk', '802.1q', 'native vlan', 'allowed vlans', 'tagging'],
  difficulty: 2,
  estimatedMinutes: 25,
  requires: [PC, SWITCH],
  seed: 206,
  instructions: [
    '## What you have',
    '',
    'SW1 and SW2 both know VLANs 10 (`SALES`), 20 (`STAFF`), 30 (`BENCH`) and 99 (`NATIVE`), and each has one PC in VLANs 10, 20 and 30. Each switch also has a management address in VLAN 99: SW1 `192.168.99.11`, SW2 `192.168.99.12`. The two are cabled `GigabitEthernet0/1` to `GigabitEthernet0/1`, but that link still runs as an access port in VLAN 1, so nothing but VLAN 1 crosses it.',
    '',
    '## What to do',
    '',
    '- On both ends of the link, make `GigabitEthernet0/1` a trunk with `switchport mode trunk`.',
    `- Set the native VLAN to ${TRUNK_LAB_NATIVE_VLAN} on both ends; a native VLAN that differs between the two ends is a fault the switches report.`,
    `- Allow only VLANs \`${TRUNK_LAB_ALLOWED}\` on both ends. VLAN 30 is a test bench on each floor and must stay on its own switch.`,
    '- Ping PC3 from PC1, then open one of the echo requests in the provenance view: find the switch that added the VLAN 10 tag and the one that removed it.',
    '- Check `show interfaces trunk` on both switches.',
    '',
    '*Spanning tree runs on these switches: a port that starts trunking listens and learns for 30 s before it forwards, so give the link half a minute before you ping across it.*',
  ].join('\n'),
  build: () =>
    topology(
      206,
      [
        device('sw1', SWITCH, 'SW1', 260, 150, trunkLabSwitch('SW1', '192.168.99.11')),
        device('sw2', SWITCH, 'SW2', 620, 150, trunkLabSwitch('SW2', '192.168.99.12')),
        device('pc1', PC, 'PC1', 100, 340, pcConfig('PC1', '192.168.10.11', MASK24)),
        device('pc2', PC, 'PC2', 230, 380, pcConfig('PC2', '192.168.20.12', MASK24)),
        device('pc5', PC, 'PC5', 360, 340, pcConfig('PC5', '192.168.30.15', MASK24)),
        device('pc3', PC, 'PC3', 520, 340, pcConfig('PC3', '192.168.10.13', MASK24)),
        device('pc4', PC, 'PC4', 650, 380, pcConfig('PC4', '192.168.20.14', MASK24)),
        device('pc6', PC, 'PC6', 780, 340, pcConfig('PC6', '192.168.30.16', MASK24)),
      ],
      [
        link('l_sw1_sw2', 'sw1', 'GigabitEthernet0/1', 'sw2', 'GigabitEthernet0/1'),
        link('l_pc1_sw1', 'pc1', 'GigabitEthernet0', 'sw1', 'FastEthernet0/1'),
        link('l_pc2_sw1', 'pc2', 'GigabitEthernet0', 'sw1', 'FastEthernet0/2'),
        link('l_pc5_sw1', 'pc5', 'GigabitEthernet0', 'sw1', 'FastEthernet0/3'),
        link('l_pc3_sw2', 'pc3', 'GigabitEthernet0', 'sw2', 'FastEthernet0/1'),
        link('l_pc4_sw2', 'pc4', 'GigabitEthernet0', 'sw2', 'FastEthernet0/2'),
        link('l_pc6_sw2', 'pc6', 'GigabitEthernet0', 'sw2', 'FastEthernet0/3'),
      ],
      ['Trunk the link between the switches', 'Move the native VLAN to 99', 'Allow only VLANs 10, 20 and 99', 'Read the tag of a crossing frame'],
      'On a trunk every VLAN but the native one travels with an 802.1Q tag naming its VLAN; the native VLAN travels untagged, so both ends must agree on it.',
      { profile: 'P2' },
    ),
  tasks: [
    {
      id: 'trunk-up',
      title: 'Trunk the link',
      description: 'GigabitEthernet0/1 is a static trunk on both switches and operates as one.',
      points: 15,
      hint: 'Configure the mode on both ends; a trunk that only one side asked for is left to negotiation.',
      assertions: [
        { kind: 'switchport', device: 'SW1', port: 'GigabitEthernet0/1', mode: 'trunk', oper: 'trunk' },
        { kind: 'switchport', device: 'SW2', port: 'GigabitEthernet0/1', mode: 'trunk', oper: 'trunk' },
      ],
    },
    {
      id: 'native-vlan',
      title: 'Move the native VLAN',
      description: `Both ends send VLAN ${TRUNK_LAB_NATIVE_VLAN} untagged, and the switches reach each other on their management addresses in it.`,
      points: 20,
      dependsOn: ['trunk-up'],
      assertions: [
        { kind: 'switchport', device: 'SW1', port: 'GigabitEthernet0/1', nativeVlan: TRUNK_LAB_NATIVE_VLAN },
        { kind: 'switchport', device: 'SW2', port: 'GigabitEthernet0/1', nativeVlan: TRUNK_LAB_NATIVE_VLAN },
        { kind: 'connectivity', from: 'SW1', to: 'SW2', expect: 'success' },
      ],
      feedbackOnFail: 'When the two ends disagree on the native VLAN, spanning tree blocks both VLANs involved on that port and the management addresses fall silent.',
    },
    {
      id: 'allowed-list',
      title: 'Carry only the VLANs in use',
      description: `The trunk carries VLANs ${TRUNK_LAB_ALLOWED} and nothing else on both ends, so the bench PCs of VLAN 30 cannot reach each other.`,
      points: 20,
      dependsOn: ['trunk-up'],
      assertions: [
        { kind: 'switchport', device: 'SW1', port: 'GigabitEthernet0/1', allowedVlans: [10, 20, 99] },
        { kind: 'switchport', device: 'SW2', port: 'GigabitEthernet0/1', allowedVlans: [10, 20, 99] },
        { kind: 'connectivity', from: 'PC5', to: 'PC6', expect: 'fail' },
      ],
      feedbackOnFail: 'By default a trunk carries every VLAN; the allowed list replaces that with exactly the VLANs you name.',
    },
    {
      id: 'vlans-across',
      title: 'Carry VLANs 10 and 20 across',
      description: 'PC1 reaches PC3 in VLAN 10 and PC2 reaches PC4 in VLAN 20, each crossing the trunk tagged with its VLAN.',
      points: 25,
      dependsOn: ['trunk-up'],
      assertions: [
        { kind: 'connectivity', from: 'PC1', to: 'PC3', expect: 'success' },
        { kind: 'connectivity', from: 'PC2', to: 'PC4', expect: 'success' },
      ],
      feedbackOnFail: 'A VLAN reaches the far switch only if the trunk allows it, the far switch knows it and the port there is in it.',
    },
  ],
  solution: {
    SW1: [...TRUNK_SOLUTION],
    SW2: [...TRUNK_SOLUTION],
  },
};

// ── trunk negotiation ───────────────────────────────────────────────────────

/** A switch of the negotiation lab: VLAN 10 and one edge access port for its PC, plus `extra` sections. */
function negotiationSwitch(name: string, extra: readonly (readonly string[])[] = []): string {
  return configText([[`hostname ${name}`], ...vlanSections([{ id: 10, name: 'SALES' }]), accessPort('FastEthernet0/1', 10, { portfast: true }), ...extra]);
}

/** A distribution switch with three uplinks left at their defaults, and a visiting switch that asks for a trunk. */
export const ccna2DtpModes: ScenarioInfo = {
  name: 'ccna2-dtp-modes',
  category: 'ccna2-lab',
  labType: 'guided',
  course: 'CCNA 2',
  topic: 'VLANs',
  title: 'Negotiate trunks, and refuse one',
  description:
    'Three links leave SW1 and none of them does what it should: two stay access links, and the third became a trunk to a visiting switch nobody approved. Predict each outcome, then make one trunk by negotiation, one fixed trunk that does not negotiate, and shut the visitor out.',
  objectives: [
    'Predict the result of every pair of trunk negotiation modes',
    'Form a trunk by negotiation from one end',
    'Build a fixed trunk and switch negotiation off on both of its ends',
    'Stop a port from ever becoming a trunk, whatever the device at the far end asks for',
  ],
  tags: ['dtp', 'trunk negotiation', 'dynamic desirable', 'dynamic auto', 'nonegotiate'],
  difficulty: 2,
  estimatedMinutes: 25,
  requires: [PC, SWITCH],
  seed: 207,
  instructions: [
    '## What you have',
    '',
    'SW1 is joined to SW2 (`GigabitEthernet0/1`), SW3 (`GigabitEthernet0/2`) and SW4 (`FastEthernet0/24`). Every switch has one PC in VLAN 10 (`192.168.10.0/24`). All ports are still at the default mode, `dynamic auto`, except the uplink of SW4: someone plugged that switch in with its port set to `dynamic desirable`.',
    '',
    '## Predict first',
    '',
    '- Before you change anything, write down what each link of SW1 should be running, then check it with `show interfaces trunk` and, port by port, `show dtp interface fa0/24`. Two ports that both wait to be asked never trunk; one that asks turns a waiting port into a trunk.',
    '',
    '## What to do',
    '',
    '- SW2 must stay as it is. Set SW1 `GigabitEthernet0/1` to `dynamic desirable` and watch the link to SW2 negotiate a trunk.',
    '- The link to SW3 must be a trunk that never negotiates: on both ends make the port a trunk and add `switchport nonegotiate`.',
    '- SW4 is not yours to configure. Make SW1 `FastEthernet0/24` an access port and switch negotiation off on it, so SW4 can ask as often as it likes and never gets a trunk.',
    '- Ping PC2 and PC3 from PC1. PC4 must no longer reach PC1.',
    '',
    '*Spanning tree runs on these switches: a port that starts trunking listens and learns for 30 s before it forwards, so give each new trunk half a minute before you ping across it.*',
  ].join('\n'),
  build: () =>
    topology(
      207,
      [
        device('sw1', SWITCH, 'SW1', 420, 120, negotiationSwitch('SW1')),
        device('sw2', SWITCH, 'SW2', 160, 260, negotiationSwitch('SW2')),
        device('sw3', SWITCH, 'SW3', 420, 300, negotiationSwitch('SW3')),
        device('sw4', SWITCH, 'SW4', 680, 260, negotiationSwitch('SW4', [section('interface GigabitEthernet0/1', ['switchport mode dynamic desirable'])])),
        device('pc1', PC, 'PC1', 560, 40, pcConfig('PC1', '192.168.10.11', MASK24)),
        device('pc2', PC, 'PC2', 100, 420, pcConfig('PC2', '192.168.10.12', MASK24)),
        device('pc3', PC, 'PC3', 420, 460, pcConfig('PC3', '192.168.10.13', MASK24)),
        device('pc4', PC, 'PC4', 740, 420, pcConfig('PC4', '192.168.10.14', MASK24)),
      ],
      [
        link('l_sw1_sw2', 'sw1', 'GigabitEthernet0/1', 'sw2', 'GigabitEthernet0/1'),
        link('l_sw1_sw3', 'sw1', 'GigabitEthernet0/2', 'sw3', 'GigabitEthernet0/1'),
        link('l_sw1_sw4', 'sw1', 'FastEthernet0/24', 'sw4', 'GigabitEthernet0/1'),
        link('l_pc1_sw1', 'pc1', 'GigabitEthernet0', 'sw1', 'FastEthernet0/1'),
        link('l_pc2_sw2', 'pc2', 'GigabitEthernet0', 'sw2', 'FastEthernet0/1'),
        link('l_pc3_sw3', 'pc3', 'GigabitEthernet0', 'sw3', 'FastEthernet0/1'),
        link('l_pc4_sw4', 'pc4', 'GigabitEthernet0', 'sw4', 'FastEthernet0/1'),
      ],
      ['Negotiate a trunk to SW2', 'Fix a trunk to SW3 with negotiation off', 'Refuse the trunk SW4 asks for'],
      'A trunk forms by negotiation only when one end asks for it (desirable, or a fixed trunk that still negotiates) and the other end is willing (auto or desirable); an end fixed as access never trunks, and a port with negotiation off neither asks nor answers.',
      { profile: 'P2' },
    ),
  tasks: [
    {
      id: 'negotiated-trunk',
      title: 'Negotiate a trunk to SW2',
      description: 'SW1 asks for a trunk on GigabitEthernet0/1, SW2 keeps its default mode, the link runs as a trunk on both ends, and PC1 reaches PC2.',
      points: 25,
      hint: 'Only one end needs to ask; the other end is already willing.',
      assertions: [
        { kind: 'switchport', device: 'SW1', port: 'GigabitEthernet0/1', mode: 'dynamic-desirable', oper: 'trunk' },
        { kind: 'switchport', device: 'SW2', port: 'GigabitEthernet0/1', mode: 'dynamic-auto', oper: 'trunk' },
        { kind: 'connectivity', from: 'PC1', to: 'PC2', expect: 'success' },
      ],
      feedbackOnFail: 'Two ports in dynamic auto both wait to be asked, so the link stays an access link in VLAN 1.',
    },
    {
      id: 'fixed-trunk',
      title: 'A fixed trunk to SW3, negotiation off',
      description: 'Both ends of the SW1–SW3 link are static trunks that send no negotiation messages, and PC1 reaches PC3.',
      points: 30,
      hint: 'Negotiation can only be switched off on a port whose mode is fixed, and it has to be off on both ends.',
      assertions: [
        { kind: 'switchport', device: 'SW1', port: 'GigabitEthernet0/2', mode: 'trunk', oper: 'trunk' },
        { kind: 'switchport', device: 'SW3', port: 'GigabitEthernet0/1', mode: 'trunk', oper: 'trunk' },
        { kind: 'table', device: 'SW1', table: 'dtp', where: { port: 'GigabitEthernet0/2' }, exists: false },
        { kind: 'table', device: 'SW3', table: 'dtp', where: { port: 'GigabitEthernet0/1' }, exists: false },
        { kind: 'connectivity', from: 'PC1', to: 'PC3', expect: 'success' },
      ],
      feedbackOnFail: 'A trunk that does not negotiate never tells the far end what it is: the far end has to be a static trunk as well.',
    },
    {
      id: 'refuse-trunk',
      title: 'Refuse the visiting switch a trunk',
      description: 'SW1 FastEthernet0/24 is a static access port that does not negotiate, the link to SW4 runs as an access link on both ends, and PC4 no longer reaches PC1.',
      points: 25,
      hint: 'Fix the mode first; negotiation can be switched off only afterwards.',
      assertions: [
        { kind: 'switchport', device: 'SW1', port: 'FastEthernet0/24', mode: 'access', oper: 'access' },
        { kind: 'table', device: 'SW1', table: 'dtp', where: { port: 'FastEthernet0/24' }, exists: false },
        { kind: 'switchport', device: 'SW4', port: 'GigabitEthernet0/1', oper: 'access' },
        { kind: 'connectivity', from: 'PC4', to: 'PC1', expect: 'fail' },
      ],
      feedbackOnFail: 'A port left in dynamic auto answers any neighbour that asks for a trunk, and a trunk carries every VLAN.',
    },
  ],
  solution: {
    SW1: [
      'interface GigabitEthernet0/1',
      'switchport mode dynamic desirable',
      'exit',
      'interface GigabitEthernet0/2',
      'switchport mode trunk',
      'switchport nonegotiate',
      'exit',
      'interface FastEthernet0/24',
      'switchport mode access',
      'switchport nonegotiate',
      'exit',
    ],
    SW3: ['interface GigabitEthernet0/1', 'switchport mode trunk', 'switchport nonegotiate', 'exit'],
  },
};

/** The trunk labs, in course order. */
export const CCNA2_TRUNK_LABS: readonly ScenarioInfo[] = [ccna2TrunkNativeAllowed, ccna2DtpModes];
