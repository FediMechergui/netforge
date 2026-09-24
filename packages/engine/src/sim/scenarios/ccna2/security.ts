/**
 * sim/scenarios/ccna2/security.ts — the CCNA 2 access-layer security lab (ARCHITECTURE-P2 §3.8, D12, §11.1, §11.2).
 *
 *   • `ccna2-port-security` — lesson 23 "Port security", with the tasks of lesson 24 "Hardening switch ports" (module
 *     "Access-layer security"): pin PC1's address with a sticky entry, allow the two PCs behind a meeting-room hub and
 *     only count strangers there, bring back the port that a stale secure address shut down, then harden the switch:
 *     shut the unused ports, move the trunk's native VLAN off VLAN 1 and switch trunk negotiation off.
 *
 * The unsolved world boots with a real violation: FastEthernet0/3 keeps the configured secure address of a
 * workstation that has since been replaced, so PC4's first frame (its gratuitous ARP at link-up, which meets a PortFast
 * port) violates, and the default `shutdown` mode error-disables the port (§3.8 step 3). The student reads the reason
 * with `show port-security interface`, removes the stale address, lets the port learn by itself (sticky) and brings it
 * back with `shutdown` / `no shutdown` (§3.8 step 5).
 *
 * Tasks read structured state (sim/lab-checks.ts): `portSecurity` (enabled, maximum, violation mode, status, sticky
 * address — named by device so no derived MAC is written here), `port` (errDisabled, operUp, adminUp), `vlan`,
 * `switchport` (operating mode, native VLAN), `config` (the `switchport nonegotiate` line) and `connectivity`. A sticky
 * address is learned from a frame, and the reference solution sends none on the ports it secures, so the sticky
 * checks read the grader's clone after its ping (`then`), where each PC announces itself at link-up — which also
 * makes the grade independent of the order in which the student typed sticky learning and the recovery. The unused
 * ports are checked one by one, all 22 of them. All wording is original (§1.6, D22).
 *
 * ponytail: the meeting-room PCs sit behind a hub (NF-HUB-4) because a hub is the one catalog device that puts two
 * hosts' frames on one switch port without being a switch itself — the textbook case for `maximum 2`.
 */
import type { ScenarioInfo } from '../../../contracts/scenario.js';
import { HUB, MASK24, PC, SERVER, SWITCH, accessPort, configText, device, link, section, topology, trunkPort, vlanSections } from '../kit.js';
import { pcConfig } from '../templates.js';

/** The user VLAN of the lab. */
const STAFF = [{ id: 10, name: 'STAFF' }] as const;

/** The secure address FastEthernet0/3 still holds: the workstation PC4 replaced (a locally administered MAC). */
export const STALE_SECURE_MAC = '02:00:00:5e:10:04';

/** SW1's unused ports: FastEthernet0/4 to FastEthernet0/24 and GigabitEthernet0/2 (the lesson 24 hardening task). */
const UNUSED_PORTS: readonly string[] = [...Array.from({ length: 21 }, (_, i) => `FastEthernet0/${i + 4}`), 'GigabitEthernet0/2'];

/** SW1: three PortFast host ports in VLAN 10, a stale secure address on the third, a negotiating trunk to SW2. */
function sw1Config(): string {
  return configText([
    ['hostname SW1'],
    ...vlanSections(STAFF),
    accessPort('FastEthernet0/1', 10, { portfast: true }),
    accessPort('FastEthernet0/2', 10, { portfast: true }),
    section('interface FastEthernet0/3', [
      'switchport mode access',
      'switchport access vlan 10',
      'spanning-tree portfast',
      'switchport port-security',
      `switchport port-security mac-address ${STALE_SECURE_MAC}`,
    ]),
    trunkPort('GigabitEthernet0/1'),
  ]);
}

/** SW2: the server port and the other end of the trunk. */
function sw2Config(): string {
  return configText([['hostname SW2'], ...vlanSections(STAFF), accessPort('FastEthernet0/1', 10, { portfast: true }), trunkPort('GigabitEthernet0/1')]);
}

/** SW1 (access) with PC1, a hub holding PC2 and PC3, and PC4; SW2 with SRV; one trunk between the switches. */
export const ccna2PortSecurity: ScenarioInfo = {
  name: 'ccna2-port-security',
  category: 'ccna2-lab',
  labType: 'build',
  course: 'CCNA 2',
  topic: 'Access-layer security',
  title: 'Port security and port hardening',
  description:
    'An access switch with its ports wide open: secure the office ports so only known devices get through, choose what a violation does, bring back a port that a stale secure address shut down, then close the unused ports and harden the trunk.',
  objectives: [
    'Limit the addresses a port accepts and pin them with sticky learning',
    'Choose between the protect, restrict and shutdown violation modes',
    'Bring an error-disabled port back once the cause is fixed',
    'Shut unused ports, move the native VLAN and switch trunk negotiation off',
  ],
  tags: ['port security', 'sticky', 'violation', 'err-disabled', 'native vlan', 'nonegotiate', 'hardening'],
  difficulty: 2,
  estimatedMinutes: 30,
  requires: [HUB, PC, SERVER, SWITCH],
  seed: 223,
  instructions: [
    '## What you have',
    '',
    'SW1 is an access switch in VLAN 10 (`STAFF`, `192.168.23.0/24`): PC1 on `FastEthernet0/1`, a meeting-room hub with PC2 and PC3 on `FastEthernet0/2`, and PC4 on `FastEthernet0/3`. SW2 holds SRV. The two switches share a trunk on `GigabitEthernet0/1`. The PC ports are PortFast.',
    '',
    '`FastEthernet0/3` is down. Run `show port-security interface FastEthernet0/3` and `show interfaces status err-disabled` to find out why.',
    '',
    '## What to do',
    '',
    '- `FastEthernet0/1`: turn port security on, allow one address, learn it sticky and shut the port down on a violation.',
    '- `FastEthernet0/2`: allow the two meeting-room PCs, and on a violation drop and count the frames of any third device without shutting the port (`restrict`).',
    '- `FastEthernet0/3`: remove the secure address of the old workstation, let the port learn its address sticky, and bring the port back with `shutdown` and `no shutdown`.',
    '- Shut down every port that is not in use: `FastEthernet0/4` to `FastEthernet0/24` and `GigabitEthernet0/2` (`interface range` helps).',
    '- On the trunk, at both ends: create VLAN 99, make it the native VLAN, and switch negotiation off (`switchport nonegotiate`).',
    '',
    '*A sticky address is learned from the first frame the device sends: a ping from the PC is enough. The PC ports forward at once; the trunk waits 30 s after it comes up while spanning tree checks it.*',
  ].join('\n'),
  build: () =>
    topology(
      223,
      [
        device('sw1', SWITCH, 'SW1', 330, 230, sw1Config()),
        device('sw2', SWITCH, 'SW2', 620, 230, sw2Config()),
        device('hub1', HUB, 'HUB1', 190, 410),
        device('pc1', PC, 'PC1', 150, 110, pcConfig('PC1', '192.168.23.11', MASK24)),
        device('pc2', PC, 'PC2', 80, 470, pcConfig('PC2', '192.168.23.12', MASK24)),
        device('pc3', PC, 'PC3', 250, 520, pcConfig('PC3', '192.168.23.13', MASK24)),
        device('pc4', PC, 'PC4', 420, 440, pcConfig('PC4', '192.168.23.14', MASK24)),
        device('srv', SERVER, 'SRV', 760, 110, pcConfig('SRV', '192.168.23.100', MASK24)),
      ],
      [
        link('l_sw1_sw2', 'sw1', 'GigabitEthernet0/1', 'sw2', 'GigabitEthernet0/1'),
        link('l_pc1_sw1', 'pc1', 'GigabitEthernet0', 'sw1', 'FastEthernet0/1'),
        link('l_hub1_sw1', 'hub1', 'Ethernet1', 'sw1', 'FastEthernet0/2'),
        link('l_pc2_hub1', 'pc2', 'GigabitEthernet0', 'hub1', 'Ethernet2'),
        link('l_pc3_hub1', 'pc3', 'GigabitEthernet0', 'hub1', 'Ethernet3'),
        link('l_pc4_sw1', 'pc4', 'GigabitEthernet0', 'sw1', 'FastEthernet0/3'),
        link('l_srv_sw2', 'srv', 'GigabitEthernet0', 'sw2', 'FastEthernet0/1'),
      ],
      ['Secure the office ports', 'Recover the error-disabled port', 'Shut the unused ports', 'Harden the trunk'],
      'Port security counts the source addresses a port has seen: under the maximum a new one is learned, at the maximum it is a violation, and the violation mode decides whether frames are dropped quietly, dropped and counted, or the port is error-disabled.',
      { profile: 'P2' },
    ),
  tasks: [
    {
      id: 'pin-pc1',
      title: 'PC1 is the only device on its port',
      description: 'FastEthernet0/1 allows one address, shuts down on a violation and has pinned PC1 as a sticky address; PC1 still reaches SRV.',
      points: 20,
      hint: 'switchport port-security needs a fixed access mode, which this port already has.',
      assertions: [
        { kind: 'portSecurity', device: 'SW1', port: 'FastEthernet0/1', enabled: true, max: 1, violation: 'shutdown' },
        {
          kind: 'connectivity',
          from: 'PC1',
          to: 'SRV',
          expect: 'success',
          then: [{ kind: 'portSecurity', device: 'SW1', port: 'FastEthernet0/1', stickyMac: 'PC1' }],
        },
      ],
      feedbackOnFail: 'Without sticky learning the address is kept only until the link goes down; with it, the address becomes a line of the running configuration.',
    },
    {
      id: 'meeting-room',
      title: 'Both meeting-room PCs work, strangers are counted',
      description: 'FastEthernet0/2 allows two addresses and restricts any other; PC2 and PC3 both reach SRV.',
      points: 20,
      hint: 'Two hosts behind one port are two source addresses.',
      assertions: [
        { kind: 'portSecurity', device: 'SW1', port: 'FastEthernet0/2', enabled: true, max: 2, violation: 'restrict' },
        { kind: 'connectivity', from: 'PC2', to: 'SRV', expect: 'success' },
        { kind: 'connectivity', from: 'PC3', to: 'SRV', expect: 'success' },
      ],
      feedbackOnFail: 'With a maximum of one, the second PC behind the hub is refused as soon as it sends.',
    },
    {
      id: 'recover-pc4',
      title: 'PC4 is back online',
      description: 'FastEthernet0/3 is no longer error-disabled, is up with port security healthy and one address allowed, pins PC4 as a sticky address, and PC4 reaches SRV.',
      points: 20,
      hint: 'Recovering the port without removing the old address only repeats the violation.',
      assertions: [
        { kind: 'port', device: 'SW1', port: 'FastEthernet0/3', field: 'errDisabled', equals: false },
        { kind: 'port', device: 'SW1', port: 'FastEthernet0/3', field: 'operUp', equals: true },
        // one address: keeping the old workstation's address beside PC4 (a maximum of 2) is not a repair
        { kind: 'portSecurity', device: 'SW1', port: 'FastEthernet0/3', status: 'secure-up', max: 1 },
        {
          kind: 'connectivity',
          from: 'PC4',
          to: 'SRV',
          expect: 'success',
          then: [{ kind: 'portSecurity', device: 'SW1', port: 'FastEthernet0/3', stickyMac: 'PC4' }],
        },
      ],
      feedbackOnFail: 'The port allows one address and still holds the old workstation, so PC4 is a violation every time it sends.',
    },
    {
      id: 'unused-ports',
      title: 'Unused ports are shut',
      description: 'FastEthernet0/4 to FastEthernet0/24 and GigabitEthernet0/2 of SW1 are administratively down.',
      points: 10,
      assertions: UNUSED_PORTS.map((port) => ({ kind: 'port', device: 'SW1', port, field: 'adminUp', equals: false }) as const),
    },
    {
      id: 'native-vlan',
      title: 'The native VLAN is VLAN 99',
      description: 'VLAN 99 exists on both switches, and the trunk still trunks with native VLAN 99 at both ends.',
      points: 15,
      assertions: [
        { kind: 'vlan', device: 'SW1', vlan: 99 },
        { kind: 'vlan', device: 'SW2', vlan: 99 },
        { kind: 'switchport', device: 'SW1', port: 'GigabitEthernet0/1', oper: 'trunk', nativeVlan: 99 },
        { kind: 'switchport', device: 'SW2', port: 'GigabitEthernet0/1', oper: 'trunk', nativeVlan: 99 },
      ],
      feedbackOnFail: 'Both ends of a trunk must agree on the native VLAN, or spanning tree blocks it as inconsistent.',
    },
    {
      id: 'no-negotiation',
      title: 'The trunk does not negotiate',
      description: 'Both ends of the trunk have trunk negotiation switched off.',
      points: 15,
      assertions: [
        { kind: 'config', device: 'SW1', path: 'interface.GigabitEthernet0/1.switchport.nonegotiate', exists: true },
        { kind: 'config', device: 'SW2', path: 'interface.GigabitEthernet0/1.switchport.nonegotiate', exists: true },
        { kind: 'switchport', device: 'SW1', port: 'GigabitEthernet0/1', oper: 'trunk', mode: 'trunk' },
      ],
    },
  ],
  solution: {
    SW1: [
      'interface FastEthernet0/1',
      'switchport port-security',
      'switchport port-security maximum 1',
      'switchport port-security violation shutdown',
      'switchport port-security mac-address sticky',
      'exit',
      'interface FastEthernet0/2',
      'switchport port-security',
      'switchport port-security maximum 2',
      'switchport port-security violation restrict',
      'exit',
      'interface FastEthernet0/3',
      `no switchport port-security mac-address ${STALE_SECURE_MAC}`,
      'switchport port-security mac-address sticky',
      'shutdown',
      'no shutdown',
      'exit',
      'interface range FastEthernet0/4 - 24',
      'shutdown',
      'exit',
      'interface GigabitEthernet0/2',
      'shutdown',
      'exit',
      'vlan 99',
      'name NATIVE',
      'exit',
      'interface GigabitEthernet0/1',
      'switchport trunk native vlan 99',
      'switchport nonegotiate',
      'exit',
    ],
    SW2: ['vlan 99', 'name NATIVE', 'exit', 'interface GigabitEthernet0/1', 'switchport trunk native vlan 99', 'switchport nonegotiate', 'exit'],
  },
};

/** The access-layer security labs, in course order. */
export const CCNA2_SECURITY_LABS: readonly ScenarioInfo[] = [ccna2PortSecurity];
