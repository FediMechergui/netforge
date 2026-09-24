/**
 * sim/scenarios/ccna2/intervlan.ts — the CCNA 2 inter-VLAN routing labs (ARCHITECTURE-P2 §11.1, §11.2).
 *
 *   • `ccna2-router-on-a-stick` — lesson 09 "One router port per VLAN, then one for all" (module "Routing between
 *     VLANs"): one router port, one trunk, one subinterface per VLAN (`encapsulation dot1Q <vid>`) and the native
 *     VLAN on a subinterface of its own (`encapsulation dot1Q <vid> native`), §3.4.
 *   • `ccna2-l3-switch-svis`    — lesson 10 "Multilayer switching" (module "Routing between VLANs"; includes a
 *     routed-port uplink task): VLAN interfaces as the gateways, `ip routing` (a P2 multilayer switch boots with
 *     `no ip routing`, §3.5), a routed uplink port (`no switchport`) with a default route, and a DHCP relay on every
 *     VLAN interface so the hosts of both VLANs lease addresses from the router upstream (lesson 18 is practised here).
 *
 * P2-profile worlds (`topology(…, { profile: 'P2' })`). Neither lesson is about spanning tree: every host port is an
 * edge port in the startup configuration (§11.2), and the one switch-to-router trunk of the stick lab — a port that
 * listens and learns for 30 s once it starts trunking — is named in its instructions. Tasks read structured state
 * only (sim/lab-checks.ts: `port`, `switchport`, `route`, `config`, `process`, `table`, `connectivity`), and every lab
 * carries a reference `solution` that `Simulation.configure` accepts as written (test/labs.ccna2.solutions.test.ts).
 * All wording is original (§0 rule 6).
 *
 * A lab file imports only the contracts, `../kit.js` and `../templates.js` — never `./index.js`, `../index.js` or
 * the engine barrel — so the catalogue stays an acyclic graph of data modules (the arrays are read at module scope).
 *
 * ponytail: a dotted config path cannot name a subinterface (its name holds a dot), and the `port` kind has no
 * 802.1Q field, so each subinterface's VLAN is graded by what it decides: its address and state (`port`), its
 * connected route (`route`), and pings that only a correct VLAN number lets through. The native subinterface is
 * graded by the management traffic SW1 itself originates — untagged frames that reach the router only through a
 * subinterface marked `native`.
 */
import type { ScenarioInfo } from '../../../contracts/scenario.js';
import { MASK24, MASK30, MLSWITCH, PC, ROUTER, SERVER, SWITCH, accessPort, configText, device, link, section, topology, vlanSections } from '../kit.js';
import { pcConfig, routerConfig } from '../templates.js';

/** A host that has nothing but its name (it asks for an address once the student sets it to DHCP). */
function bareHost(hostname: string): string {
  return configText([[`hostname ${hostname}`]]);
}

// ── router-on-a-stick ───────────────────────────────────────────────────────

/** The native (management) VLAN of the stick lab. */
export const STICK_NATIVE_VLAN = 99;

/** SW1 of the stick lab: its VLANs, two edge access ports and a management address in the native VLAN. */
function stickSwitchConfig(): string {
  return configText([
    ['hostname SW1'],
    ...vlanSections([
      { id: 10, name: 'SALES' },
      { id: 20, name: 'STAFF' },
      { id: STICK_NATIVE_VLAN, name: 'MGMT' },
    ]),
    accessPort('FastEthernet0/1', 10, { portfast: true }),
    accessPort('FastEthernet0/2', 20, { portfast: true }),
    section(`interface Vlan${STICK_NATIVE_VLAN}`, [`ip address 192.168.99.2 ${MASK24}`, 'no shutdown']),
    ['ip default-gateway 192.168.99.1'],
  ]);
}

/** A switch with two VLANs, a router with one free port toward it, and a server behind the router. */
export const ccna2RouterOnAStick: ScenarioInfo = {
  name: 'ccna2-router-on-a-stick',
  category: 'ccna2-lab',
  labType: 'build',
  course: 'CCNA 2',
  topic: 'Routing between VLANs',
  title: 'Route between VLANs on a stick',
  description:
    'Sales and staff sit in their own VLANs and cannot reach each other or the server. With one cable between the switch and the router, build a trunk, one subinterface per VLAN and a native subinterface for the switch management VLAN.',
  objectives: [
    'Explain why one router port per VLAN does not scale, and what a trunk to the router replaces it with',
    'Create one router subinterface per VLAN with its 802.1Q encapsulation and its gateway address',
    'Carry the native VLAN on a subinterface of its own',
    'Follow a routed packet between VLANs: tag removed at the router, TTL decremented, tag of the other VLAN added',
  ],
  tags: ['inter-vlan routing', 'router-on-a-stick', 'subinterface', '802.1q', 'native vlan'],
  difficulty: 2,
  estimatedMinutes: 30,
  requires: [PC, ROUTER, SERVER, SWITCH],
  seed: 209,
  instructions: [
    '## What you have',
    '',
    `SW1 holds VLANs 10 (\`SALES\`, PC1 in \`192.168.10.0/24\`), 20 (\`STAFF\`, PC2 in \`192.168.20.0/24\`) and ${STICK_NATIVE_VLAN} (\`MGMT\`), where SW1 itself is managed at \`192.168.99.2\` with gateway \`192.168.99.1\`. Its \`GigabitEthernet0/1\` is cabled to R1 \`GigabitEthernet0/0\`, which is still shut. R1 already reaches SRV1 (\`172.16.1.10\`) on \`GigabitEthernet0/1\`. Each host uses the \`.1\` address of its subnet as its gateway.`,
    '',
    '## What to do',
    '',
    `- On SW1, make \`GigabitEthernet0/1\` a trunk with native VLAN ${STICK_NATIVE_VLAN}. A router does not negotiate trunks, so switch negotiation off on that port too.`,
    '- On R1, enable `GigabitEthernet0/0` without giving it an address.',
    '- Create `GigabitEthernet0/0.10` with `encapsulation dot1Q 10` and `192.168.10.1/24`, and `GigabitEthernet0/0.20` with VLAN 20 and `192.168.20.1/24`. The encapsulation line comes before the address.',
    `- Create \`GigabitEthernet0/0.99\` for the native VLAN (\`encapsulation dot1Q ${STICK_NATIVE_VLAN} native\`) with \`192.168.99.1/24\`.`,
    '- Ping PC2 and SRV1 from PC1, and SRV1 from SW1. Open an echo request from PC1 to PC2 in the provenance view: R1 removes the VLAN 10 tag, routes the packet and adds a VLAN 20 tag.',
    '',
    '*Spanning tree runs on SW1: once its port toward R1 is up and trunking, it listens and learns for 30 s before it forwards, so give it half a minute before your first ping.*',
  ].join('\n'),
  build: () =>
    topology(
      209,
      [
        device('pc1', PC, 'PC1', 100, 340, pcConfig('PC1', '192.168.10.10', MASK24, '192.168.10.1')),
        device('pc2', PC, 'PC2', 320, 380, pcConfig('PC2', '192.168.20.10', MASK24, '192.168.20.1')),
        device('sw1', SWITCH, 'SW1', 210, 180, stickSwitchConfig()),
        device('r1', ROUTER, 'R1', 480, 120, routerConfig('R1', [{ port: 'GigabitEthernet0/1', address: '172.16.1.1', mask: MASK24 }])),
        device('srv1', SERVER, 'SRV1', 740, 180, pcConfig('SRV1', '172.16.1.10', MASK24, '172.16.1.1')),
      ],
      [
        link('l_pc1_sw1', 'pc1', 'GigabitEthernet0', 'sw1', 'FastEthernet0/1'),
        link('l_pc2_sw1', 'pc2', 'GigabitEthernet0', 'sw1', 'FastEthernet0/2'),
        link('l_sw1_r1', 'sw1', 'GigabitEthernet0/1', 'r1', 'GigabitEthernet0/0'),
        link('l_r1_srv1', 'r1', 'GigabitEthernet0/1', 'srv1', 'GigabitEthernet0'),
      ],
      ['Trunk the switch port facing the router', 'Build one subinterface per VLAN', 'Carry the native VLAN on its own subinterface', 'Route between the VLANs and to the server'],
      'Each subinterface is the gateway of one VLAN: frames of that VLAN arrive tagged on the shared port, lose their tag at the subinterface, are routed, and leave tagged with the VLAN of the next hop.',
      { profile: 'P2' },
    ),
  tasks: [
    {
      id: 'switch-trunk',
      title: 'Trunk the port facing the router',
      description: `SW1 GigabitEthernet0/1 is a static trunk with native VLAN ${STICK_NATIVE_VLAN} that sends no negotiation messages.`,
      points: 10,
      hint: 'Negotiation can only be switched off once the mode is fixed.',
      assertions: [
        { kind: 'switchport', device: 'SW1', port: 'GigabitEthernet0/1', mode: 'trunk', nativeVlan: STICK_NATIVE_VLAN },
        // negotiation off: the line itself (a negotiating trunk keeps no row either while R1's port is still shut)…
        { kind: 'config', device: 'SW1', path: 'interface.GigabitEthernet0/1.switchport.nonegotiate', exists: true },
        // …and its effect: no negotiation state on the port
        { kind: 'table', device: 'SW1', table: 'dtp', where: { port: 'GigabitEthernet0/1' }, exists: false },
      ],
    },
    {
      id: 'parent-up',
      title: 'Enable the shared router port',
      description: 'R1 GigabitEthernet0/0 is enabled and up, and SW1 runs its end of the link as a trunk.',
      points: 10,
      dependsOn: ['switch-trunk'],
      assertions: [
        { kind: 'port', device: 'R1', port: 'GigabitEthernet0/0', field: 'adminUp', equals: true },
        { kind: 'port', device: 'R1', port: 'GigabitEthernet0/0', field: 'operUp', equals: true },
        { kind: 'switchport', device: 'SW1', port: 'GigabitEthernet0/1', oper: 'trunk' },
      ],
      feedbackOnFail: 'A router port starts shut, and its subinterfaces are down for as long as it is.',
    },
    {
      id: 'vlan-subinterfaces',
      title: 'One subinterface per VLAN',
      description:
        'GigabitEthernet0/0.10 carries 192.168.10.1/24 and GigabitEthernet0/0.20 carries 192.168.20.1/24, both are up, R1 reaches each VLAN through its own subinterface, and each PC reaches the router through its gateway.',
      points: 25,
      dependsOn: ['parent-up'],
      hint: 'Give each subinterface its encapsulation before its address; the router refuses the address otherwise.',
      assertions: [
        { kind: 'port', device: 'R1', port: 'GigabitEthernet0/0.10', field: 'ipv4', equals: '192.168.10.1/24' },
        { kind: 'port', device: 'R1', port: 'GigabitEthernet0/0.10', field: 'operUp', equals: true },
        { kind: 'port', device: 'R1', port: 'GigabitEthernet0/0.20', field: 'ipv4', equals: '192.168.20.1/24' },
        { kind: 'port', device: 'R1', port: 'GigabitEthernet0/0.20', field: 'operUp', equals: true },
        { kind: 'route', device: 'R1', destination: '192.168.10.10', source: 'C', iface: 'GigabitEthernet0/0.10' },
        { kind: 'route', device: 'R1', destination: '192.168.20.10', source: 'C', iface: 'GigabitEthernet0/0.20' },
        { kind: 'connectivity', from: 'PC1', to: 'R1', expect: 'success' },
        { kind: 'connectivity', from: 'PC2', to: 'R1', expect: 'success' },
      ],
      feedbackOnFail: 'A subinterface takes only the frames tagged with its own VLAN number: swap two numbers and each gateway sits in the wrong VLAN.',
    },
    {
      id: 'native-subinterface',
      title: 'Carry the native VLAN on its own subinterface',
      description: `GigabitEthernet0/0.99 carries 192.168.99.1/24 for the untagged VLAN ${STICK_NATIVE_VLAN}, and SW1 reaches SRV1 through it.`,
      points: 20,
      dependsOn: ['parent-up'],
      assertions: [
        { kind: 'port', device: 'R1', port: `GigabitEthernet0/0.${STICK_NATIVE_VLAN}`, field: 'ipv4', equals: '192.168.99.1/24' },
        { kind: 'port', device: 'R1', port: `GigabitEthernet0/0.${STICK_NATIVE_VLAN}`, field: 'operUp', equals: true },
        { kind: 'connectivity', from: 'SW1', to: 'SRV1', expect: 'success' },
      ],
      feedbackOnFail: 'SW1 sends its native VLAN untagged; only a subinterface marked native receives untagged frames, every other one waits for its tag.',
    },
    {
      id: 'routed',
      title: 'Route between the VLANs',
      description: 'PC1 reaches PC2 in the other VLAN, and PC2 reaches SRV1 behind the router.',
      points: 25,
      dependsOn: ['vlan-subinterfaces'],
      assertions: [
        { kind: 'connectivity', from: 'PC1', to: 'PC2', expect: 'success' },
        { kind: 'connectivity', from: 'PC2', to: 'SRV1', expect: 'success' },
      ],
      feedbackOnFail: 'Each PC needs its own gateway subinterface, and the router needs both to forward from one VLAN to the other.',
    },
  ],
  solution: {
    SW1: ['interface GigabitEthernet0/1', 'switchport mode trunk', `switchport trunk native vlan ${STICK_NATIVE_VLAN}`, 'switchport nonegotiate', 'exit'],
    R1: [
      'interface GigabitEthernet0/0',
      'no shutdown',
      'exit',
      'interface GigabitEthernet0/0.10',
      'encapsulation dot1Q 10',
      `ip address 192.168.10.1 ${MASK24}`,
      'exit',
      'interface GigabitEthernet0/0.20',
      'encapsulation dot1Q 20',
      `ip address 192.168.20.1 ${MASK24}`,
      'exit',
      `interface GigabitEthernet0/0.${STICK_NATIVE_VLAN}`,
      `encapsulation dot1Q ${STICK_NATIVE_VLAN} native`,
      `ip address 192.168.99.1 ${MASK24}`,
      'exit',
    ],
  },
};

// ── multilayer switching ────────────────────────────────────────────────────

/** The router's side of the multilayer lab: the uplink, the server LAN, both DHCP pools and the routes back. */
function coreRouterConfig(): string {
  const pool = (name: string, network: string, gateway: string): string[] =>
    section(`ip dhcp pool ${name}`, [`network ${network} ${MASK24}`, `default-router ${gateway}`]);
  return configText([
    ['hostname R1'],
    ['ip dhcp excluded-address 192.168.10.1 192.168.10.10', 'ip dhcp excluded-address 192.168.20.1 192.168.20.10'],
    pool('SALES', '192.168.10.0', '192.168.10.1'),
    pool('STAFF', '192.168.20.0', '192.168.20.1'),
    section('interface GigabitEthernet0/0', [`ip address 10.0.0.2 ${MASK30}`, 'no shutdown']),
    section('interface GigabitEthernet0/1', [`ip address 172.16.1.1 ${MASK24}`, 'no shutdown']),
    [`ip route 192.168.10.0 ${MASK24} 10.0.0.1`, `ip route 192.168.20.0 ${MASK24} 10.0.0.1`],
  ]);
}

/** MLS1 before the lab: its VLANs and two edge access ports; no VLAN interface, routing still off. */
function multilayerConfig(): string {
  return configText([
    ['hostname MLS1'],
    ...vlanSections([
      { id: 10, name: 'SALES' },
      { id: 20, name: 'STAFF' },
    ]),
    accessPort('GigabitEthernet1/0/1', 10, { portfast: true }),
    accessPort('GigabitEthernet1/0/2', 20, { portfast: true }),
  ]);
}

/** A multilayer switch with two VLANs and hosts waiting for leases, cabled to the router that holds the pools. */
export const ccna2L3SwitchSvis: ScenarioInfo = {
  name: 'ccna2-l3-switch-svis',
  category: 'ccna2-lab',
  labType: 'build',
  course: 'CCNA 2',
  topic: 'Routing between VLANs',
  title: 'Route between VLANs on a multilayer switch',
  description:
    'A multilayer switch holds two VLANs whose hosts have no address yet, and the router with their address pools sits one routed link away. Give each VLAN a gateway interface, switch routing on, turn the uplink into a routed port and relay the address requests.',
  objectives: [
    'Give each VLAN a VLAN interface as its gateway and switch routing on',
    'Turn a switch port into a routed port with an address of its own',
    'Point a multilayer switch at the next router with a default route',
    'Relay address requests from every VLAN to a server in another subnet, and explain why each VLAN interface needs its own relay',
  ],
  tags: ['multilayer switch', 'svi', 'ip routing', 'routed port', 'dhcp relay'],
  difficulty: 3,
  estimatedMinutes: 30,
  requires: [MLSWITCH, PC, ROUTER, SERVER],
  seed: 210,
  instructions: [
    '## What you have',
    '',
    'MLS1 holds VLAN 10 (`SALES`, PC1 on `GigabitEthernet1/0/1`) and VLAN 20 (`STAFF`, PC2 on `GigabitEthernet1/0/2`). Neither PC has an address yet. MLS1 `GigabitEthernet1/0/24` is cabled to R1 `GigabitEthernet0/0` (`10.0.0.2/30`). R1 already holds the address pools `SALES` and `STAFF`, the routes back to both VLANs through `10.0.0.1`, and reaches SRV1 (`172.16.1.10`).',
    '',
    '## What to do',
    '',
    '- Create `interface Vlan10` with `192.168.10.1/24` and `interface Vlan20` with `192.168.20.1/24`, and bring both up.',
    '- Switch routing on: a multilayer switch starts with `no ip routing` and only answers for its own addresses until you type `ip routing`.',
    '- Make `GigabitEthernet1/0/24` a routed port (`no switchport`), give it `10.0.0.1/30`, and add a default route to `10.0.0.2`.',
    '- On each VLAN interface, relay address requests to R1 with `ip helper-address 10.0.0.2`.',
    '- Set both PCs to DHCP, check the leases with `ipconfig`, then ping PC2 and SRV1 from PC1.',
    '',
    '*A broadcast never crosses a routed interface: each VLAN interface relays the requests of its own VLAN, and the server picks the pool from the relay address it is given.*',
  ].join('\n'),
  build: () =>
    topology(
      210,
      [
        device('pc1', PC, 'PC1', 100, 340, bareHost('PC1')),
        device('pc2', PC, 'PC2', 320, 380, bareHost('PC2')),
        device('mls1', MLSWITCH, 'MLS1', 220, 170, multilayerConfig()),
        device('r1', ROUTER, 'R1', 480, 120, coreRouterConfig()),
        device('srv1', SERVER, 'SRV1', 740, 180, pcConfig('SRV1', '172.16.1.10', MASK24, '172.16.1.1')),
      ],
      [
        link('l_pc1_mls1', 'pc1', 'GigabitEthernet0', 'mls1', 'GigabitEthernet1/0/1'),
        link('l_pc2_mls1', 'pc2', 'GigabitEthernet0', 'mls1', 'GigabitEthernet1/0/2'),
        link('l_mls1_r1', 'mls1', 'GigabitEthernet1/0/24', 'r1', 'GigabitEthernet0/0'),
        link('l_r1_srv1', 'r1', 'GigabitEthernet0/1', 'srv1', 'GigabitEthernet0'),
      ],
      ['Give each VLAN a gateway interface', 'Switch routing on', 'Uplink through a routed port', 'Relay address requests from both VLANs'],
      'A multilayer switch routes between its VLAN interfaces once routing is on; a routed port is a switch port turned into a router interface, with an address and no VLAN.',
      { profile: 'P2' },
    ),
  tasks: [
    {
      id: 'vlan-interfaces',
      title: 'A gateway interface per VLAN',
      description: 'Vlan10 carries 192.168.10.1/24 and Vlan20 carries 192.168.20.1/24, and both are up.',
      points: 15,
      assertions: [
        { kind: 'port', device: 'MLS1', port: 'Vlan10', field: 'ipv4', equals: '192.168.10.1/24' },
        { kind: 'port', device: 'MLS1', port: 'Vlan10', field: 'operUp', equals: true },
        { kind: 'port', device: 'MLS1', port: 'Vlan20', field: 'ipv4', equals: '192.168.20.1/24' },
        { kind: 'port', device: 'MLS1', port: 'Vlan20', field: 'operUp', equals: true },
      ],
      feedbackOnFail: 'A VLAN interface starts shut, and it only comes up while its VLAN exists and one of its ports is forwarding.',
    },
    {
      id: 'ip-routing',
      title: 'Switch routing on',
      description: 'MLS1 forwards packets between its interfaces.',
      points: 10,
      hint: 'One global configuration line; it replaces the no ip routing this switch started with.',
      assertions: [
        { kind: 'config', device: 'MLS1', path: 'ip.routing', exists: true },
        { kind: 'process', device: 'MLS1', process: 'ipv4', path: 'forwarding', equals: true },
      ],
    },
    {
      id: 'routed-uplink',
      title: 'Uplink through a routed port',
      description: 'GigabitEthernet1/0/24 is a routed port with 10.0.0.1/30, and MLS1 sends everything it has no other route for to R1.',
      points: 20,
      hint: 'no switchport turns the port into a router interface; the default route points at the far end of that link.',
      assertions: [
        { kind: 'port', device: 'MLS1', port: 'GigabitEthernet1/0/24', field: 'role', equals: 'routed' },
        { kind: 'port', device: 'MLS1', port: 'GigabitEthernet1/0/24', field: 'ipv4', equals: '10.0.0.1/30' },
        { kind: 'port', device: 'MLS1', port: 'GigabitEthernet1/0/24', field: 'operUp', equals: true },
        { kind: 'route', device: 'MLS1', destination: '172.16.1.10', network: '0.0.0.0/0', source: 'S', nextHop: '10.0.0.2', iface: 'GigabitEthernet1/0/24' },
      ],
      feedbackOnFail: 'A switched port has no address of its own: the port has to stop switching before it can carry one.',
    },
    {
      id: 'relay',
      title: 'Relay address requests from both VLANs',
      description: 'Both VLAN interfaces forward address requests to 10.0.0.2, and both PCs hold a lease that R1 handed out through the relay of their own VLAN.',
      points: 25,
      dependsOn: ['vlan-interfaces', 'routed-uplink'],
      assertions: [
        { kind: 'config', device: 'MLS1', path: 'interface.Vlan10.ip.helper-address', equals: '10.0.0.2' },
        { kind: 'config', device: 'MLS1', path: 'interface.Vlan20.ip.helper-address', equals: '10.0.0.2' },
        { kind: 'process', device: 'PC1', process: 'dhcp-client', path: 'clients.iface=GigabitEthernet0.state', equals: 'BOUND' },
        { kind: 'process', device: 'PC2', process: 'dhcp-client', path: 'clients.iface=GigabitEthernet0.state', equals: 'BOUND' },
        { kind: 'table', device: 'R1', table: 'dhcp-bindings', where: { pool: 'SALES', state: 'bound', relay: '192.168.10.1' }, exists: true },
        { kind: 'table', device: 'R1', table: 'dhcp-bindings', where: { pool: 'STAFF', state: 'bound', relay: '192.168.20.1' }, exists: true },
      ],
      feedbackOnFail: 'A request that no VLAN interface relays never leaves its VLAN, and a PC only asks once its adapter is set to DHCP.',
    },
    {
      id: 'end-to-end',
      title: 'Route between the VLANs and beyond',
      description: 'PC1 reaches PC2 in the other VLAN, and PC2 reaches SRV1 behind R1.',
      points: 20,
      dependsOn: ['ip-routing', 'relay'],
      assertions: [
        { kind: 'connectivity', from: 'PC1', to: 'PC2', expect: 'success' },
        { kind: 'connectivity', from: 'PC2', to: 'SRV1', expect: 'success' },
      ],
      feedbackOnFail: 'Without ip routing the switch still answers for its own addresses, but it forwards nothing between them.',
    },
  ],
  solution: {
    MLS1: [
      'ip routing',
      'interface Vlan10',
      `ip address 192.168.10.1 ${MASK24}`,
      'ip helper-address 10.0.0.2',
      'no shutdown',
      'exit',
      'interface Vlan20',
      `ip address 192.168.20.1 ${MASK24}`,
      'ip helper-address 10.0.0.2',
      'no shutdown',
      'exit',
      'interface GigabitEthernet1/0/24',
      'no switchport',
      `ip address 10.0.0.1 ${MASK30}`,
      'no shutdown',
      'exit',
      'ip route 0.0.0.0 0.0.0.0 10.0.0.2',
    ],
    PC1: ['ip address dhcp'],
    PC2: ['ip address dhcp'],
  },
};

/** The inter-VLAN routing labs, in course order. */
export const CCNA2_INTERVLAN_LABS: readonly ScenarioInfo[] = [ccna2RouterOnAStick, ccna2L3SwitchSvis];
