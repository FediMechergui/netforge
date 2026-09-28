/**
 * sim/scenarios/ccna2/wireless.ts — the CCNA 2 wireless controller lab (ARCHITECTURE-P2 §3.12, §5.3, D17, §11.1,
 * §11.2).
 *
 *   • `ccna2-wlc-wlan` — lesson 27 "WLANs on a controller" (module "Wireless at scale"): give the controller its
 *     management interface so the lightweight access point can join it, create the controller interface the staff
 *     clients reach the wired network through (name, VLAN, address, gateway, DHCP server), then the WLAN on that
 *     interface, and connect a laptop that leases an address in the staff VLAN and reaches its gateway through the
 *     access point's tunnel to the controller.
 *
 * The world is the §3.12 setup, P2-profile (`topology(…, { profile: 'P2' })`): WLC1 (NF-WLC-9800) on a trunk of SW1,
 * the lightweight access point LAP1 (NF-AP-1832) on an access port of the AP management VLAN 99, R1 as the gateway
 * and DHCP server of VLAN 99 (the access points) and VLAN 20 (the staff clients), each on an access port of its VLAN,
 * and LAPTOP1 about 15 m from the access point. The access point boots with the P2 profile lines (`capwap enable`,
 * DHCP on Vlan1): it leases its address from R1 and searches its subnet for a controller that is not answering yet,
 * because WLC1 starts with nothing but its name. Nothing waits on spanning tree: the edge ports and the trunk to the
 * controller (which runs no spanning tree, D17) are PortFast in the startup configuration (§11.2).
 *
 * The controller lines of the reference solution are the §5.3 `wlc-interface` / `wlan` lines, exactly what the
 * controller panel's Interfaces and WLANs pages write (the controller has no console); the laptop's are the host
 * shell's Wi-Fi lines (`wifi connect … key …`, `ip address dhcp Wlan0`). Tasks read structured state only
 * (sim/lab-checks.ts): `config` for the controller's sections and the laptop's adapter, `port` for the controller
 * interface the handler keeps up, `table` for the controller link rows (`capwap-aps` and `wlan-clients` on the
 * controller, `capwap` on the access point) and `connectivity` — the controller reaching the access point in the AP
 * VLAN, the laptop reaching its gateway. The rows that need the whole chain (the access point joined, the WLAN pushed,
 * the laptop reported in VLAN 20) are read in the grader's clone right after its ping (`then`): the clone boots the
 * saved configuration from scratch, so those rows prove the configuration works from a cold start, and grading never
 * waits on the access point's periodic discovery tick (§4.2), which `runToIdle` does not wait for in the live world.
 * Every assertion fails a plausible wrong answer: the management interface in the staff VLAN, a wrong address,
 * gateway or DHCP server, the access point pointed at a controller that does not exist, another network name or
 * security mode, a WLAN left on the management interface (the laptop then leases in VLAN 99 and still reaches R1)
 * or shut down, the laptop on another network or with a static address. All wording is original (§0 rule 6); the
 * addresses are the §3.12 ones.
 *
 * A lab file imports only the contracts and `../kit.js` — never `./index.js`, `../index.js` or the engine barrel — so
 * the catalogue stays an acyclic graph of data modules (the arrays are read at module scope).
 *
 * The controller's `dhcp-server` line is stored, shown and graded but not used to relay (deviation (15), §12.2): the
 * clients' DHCP is bridged into VLAN 20, where R1 serves it, which is what the instructions say. The WLAN's profile
 * name and SSID are graded through its section line (`wlan.1.STAFF.LabNet`; a dotted path could not name an SSID
 * holding a dot, and this one holds none).
 *
 * ponytail: the controller pings the access point, not the other way round: a connectivity check pings a device's
 * FIRST address, and the controller's first interface is the staff VLAN's once it exists, so a ping towards the
 * controller would grade the staff interface inside the management task.
 */
import type { ScenarioInfo } from '../../../contracts/scenario.js';
import { LAPTOP, LIGHTWEIGHT_AP, MASK24, ROUTER, SWITCH, WLC, accessPort, configText, device, link, section, topology, vlanSections } from '../kit.js';

/** The AP management VLAN (the controller's management interface and the access points). */
export const WLC_LAB_AP_VLAN = 99;
/** The staff client VLAN (the controller interface the WLAN points at). */
export const WLC_LAB_CLIENT_VLAN = 20;
/** The controller's management address and the router of the AP VLAN. */
export const WLC_LAB_MGMT_ADDRESS = '192.168.99.5';
export const WLC_LAB_AP_GATEWAY = '192.168.99.1';
/** The controller interface of the staff clients: its name, address and the router (and DHCP server) of VLAN 20. */
export const WLC_LAB_CLIENT_INTERFACE = 'STAFF-IF';
export const WLC_LAB_CLIENT_ADDRESS = '192.168.20.5';
export const WLC_LAB_CLIENT_GATEWAY = '192.168.20.1';
/** The WLAN: number, profile name, network name and passphrase (a teaching value). */
export const WLC_LAB_WLAN_ID = 1;
export const WLC_LAB_PROFILE = 'STAFF';
export const WLC_LAB_SSID = 'LabNet';
export const WLC_LAB_PASSPHRASE = 'quiet-meadow-27';

/** SW1: the two VLANs, the trunk to the controller and PortFast access ports for the AP and the router. */
function switchConfig(): string {
  return configText([
    ['hostname SW1'],
    ...vlanSections([
      { id: WLC_LAB_CLIENT_VLAN, name: 'STAFF' },
      { id: WLC_LAB_AP_VLAN, name: 'AP-MGMT' },
    ]),
    // the controller neither negotiates nor runs spanning tree: a static trunk that forwards at once
    section('interface GigabitEthernet0/1', ['switchport mode trunk', 'switchport nonegotiate', 'spanning-tree portfast trunk']),
    accessPort('FastEthernet0/2', WLC_LAB_AP_VLAN, { portfast: true }),
    accessPort('FastEthernet0/3', WLC_LAB_CLIENT_VLAN, { portfast: true }),
    accessPort('FastEthernet0/4', WLC_LAB_AP_VLAN, { portfast: true }),
  ]);
}

/** R1: the gateway of both VLANs and their DHCP pools (the first addresses of each subnet kept out of the pools). */
function routerConfig(): string {
  return configText([
    ['hostname R1'],
    ['ip dhcp excluded-address 192.168.99.1 192.168.99.19'],
    ['ip dhcp excluded-address 192.168.20.1 192.168.20.9'],
    section('ip dhcp pool APS', [`network 192.168.99.0 ${MASK24}`, `default-router ${WLC_LAB_AP_GATEWAY}`]),
    section('ip dhcp pool STAFF', [`network 192.168.20.0 ${MASK24}`, `default-router ${WLC_LAB_CLIENT_GATEWAY}`]),
    section('interface GigabitEthernet0/0', [`ip address ${WLC_LAB_CLIENT_GATEWAY} ${MASK24}`, 'no shutdown']),
    section('interface GigabitEthernet0/1', [`ip address ${WLC_LAB_AP_GATEWAY} ${MASK24}`, 'no shutdown']),
  ]);
}

/** A device that has nothing but its name. */
function named(hostname: string): string {
  return configText([[`hostname ${hostname}`]]);
}

/** A controller with nothing configured, a lightweight AP looking for it, a router serving both VLANs, a laptop. */
export const ccna2WlcWlan: ScenarioInfo = {
  name: 'ccna2-wlc-wlan',
  category: 'ccna2-lab',
  labType: 'build',
  course: 'CCNA 2',
  topic: 'Wireless at scale',
  title: 'A WLAN on a wireless LAN controller',
  description:
    'A lightweight access point is looking for a controller that has not been set up. Give the controller its management interface so the access point joins, create the interface of the staff VLAN and a WLAN on it, then connect a laptop.',
  objectives: [
    'Give a controller the management interface that lightweight access points join',
    'Create a controller interface with its VLAN, address, gateway and DHCP server',
    'Create a WLAN with personal security and map it to a controller interface',
    'Connect a client through a lightweight access point and follow its traffic into the right VLAN',
  ],
  tags: ['wireless', 'wlc', 'controller', 'capwap', 'lightweight ap', 'wlan', 'wpa2', 'dhcp'],
  difficulty: 2,
  estimatedMinutes: 30,
  requires: [LAPTOP, LIGHTWEIGHT_AP, ROUTER, SWITCH, WLC],
  seed: 227,
  instructions: [
    '## What you have',
    '',
    `SW1 carries two VLANs: ${WLC_LAB_AP_VLAN} (\`AP-MGMT\`, \`192.168.99.0/24\`) for the access points and ${WLC_LAB_CLIENT_VLAN} (\`STAFF\`, \`192.168.20.0/24\`) for the staff clients. R1 is the gateway of both, \`${WLC_LAB_AP_GATEWAY}\` and \`${WLC_LAB_CLIENT_GATEWAY}\`, and hands out addresses in both. WLC1 sits on a trunk of SW1 (\`GigabitEthernet0/1\`); the lightweight access point LAP1 sits on an access port of VLAN ${WLC_LAB_AP_VLAN}, has leased its address from R1 and is searching its subnet for a controller. LAPTOP1 is about 15 m from LAP1 and has joined nothing.`,
    '',
    'WLC1 has no console: open its controller panel and use the Interfaces and WLANs pages. Run `show capwap` on LAP1 to follow its search.',
    '',
    '## What to do',
    '',
    `- **Management interface.** Give the built-in \`management\` interface of WLC1 VLAN ${WLC_LAB_AP_VLAN}, the address \`${WLC_LAB_MGMT_ADDRESS}/24\` and the gateway \`${WLC_LAB_AP_GATEWAY}\`. LAP1 searches again every ten seconds: it finds the controller, joins it and shows up on its Access points page.`,
    `- **Staff interface.** Create the controller interface \`${WLC_LAB_CLIENT_INTERFACE}\` in VLAN ${WLC_LAB_CLIENT_VLAN} with the address \`${WLC_LAB_CLIENT_ADDRESS}/24\`, the gateway \`${WLC_LAB_CLIENT_GATEWAY}\` and the DHCP server \`${WLC_LAB_CLIENT_GATEWAY}\`.`,
    `- **WLAN.** Create WLAN ${WLC_LAB_WLAN_ID} with the profile name \`${WLC_LAB_PROFILE}\` and the network name \`${WLC_LAB_SSID}\`, personal WPA2 security, the passphrase \`${WLC_LAB_PASSPHRASE}\`, on the interface \`${WLC_LAB_CLIENT_INTERFACE}\`. The controller pushes it to LAP1, which starts announcing it.`,
    `- **Client.** On LAPTOP1, join \`${WLC_LAB_SSID}\` with the passphrase and ask the wireless adapter for an address (\`ip address dhcp Wlan0\`). It should lease an address in \`192.168.20.0/24\`; ping \`${WLC_LAB_CLIENT_GATEWAY}\`.`,
    '- Open one of the laptop\'s echo requests in the provenance view: LAP1 wraps it in the tunnel to the controller, and WLC1 unwraps it and tags it with VLAN 20.',
    '',
    '*A WLAN reaches a VLAN only through its controller interface: left on `management`, the laptop would land in the access point VLAN.*',
  ].join('\n'),
  build: () =>
    topology(
      227,
      [
        device('wlc1', WLC, 'WLC1', 140, 120, named('WLC1')),
        device('sw1', SWITCH, 'SW1', 380, 220, switchConfig()),
        device('r1', ROUTER, 'R1', 380, 420, routerConfig()),
        device('lap1', LIGHTWEIGHT_AP, 'LAP1', 620, 220, named('LAP1')),
        // 60 canvas units at 0.25 m each: the laptop is 15 m from the access point
        device('laptop1', LAPTOP, 'LAPTOP1', 680, 220, named('LAPTOP1')),
      ],
      [
        link('l_wlc1_sw1', 'wlc1', 'GigabitEthernet0/1', 'sw1', 'GigabitEthernet0/1'),
        link('l_lap1_sw1', 'lap1', 'GigabitEthernet0', 'sw1', 'FastEthernet0/2'),
        link('l_r1_sw1_staff', 'r1', 'GigabitEthernet0/0', 'sw1', 'FastEthernet0/3'),
        link('l_r1_sw1_aps', 'r1', 'GigabitEthernet0/1', 'sw1', 'FastEthernet0/4'),
      ],
      ['Give the controller its management interface', 'Create the staff controller interface', 'Create the WLAN on it', 'Connect a laptop through the access point'],
      'A lightweight access point forwards nothing on its own: it joins a controller over CAPWAP, takes its WLANs from it and tunnels its clients\' traffic to it, and the controller bridges each WLAN into the VLAN of its controller interface.',
      { profile: 'P2' },
    ),
  tasks: [
    {
      id: 'management',
      title: 'Give the controller its management interface',
      description: `The management interface of WLC1 is in VLAN ${WLC_LAB_AP_VLAN} with ${WLC_LAB_MGMT_ADDRESS}/24 and the gateway ${WLC_LAB_AP_GATEWAY}, and LAP1 has joined it.`,
      points: 25,
      hint: 'The access point searches its own subnet, so the controller must answer in the access point VLAN.',
      assertions: [
        { kind: 'config', device: 'WLC1', path: 'wlc-interface.management.vlan', equals: String(WLC_LAB_AP_VLAN) },
        { kind: 'config', device: 'WLC1', path: 'wlc-interface.management.address', equals: [WLC_LAB_MGMT_ADDRESS, MASK24] },
        { kind: 'config', device: 'WLC1', path: 'wlc-interface.management.gateway', equals: WLC_LAB_AP_GATEWAY },
        {
          kind: 'connectivity',
          from: 'WLC1',
          to: 'LAP1',
          expect: 'success',
          then: [{ kind: 'table', device: 'WLC1', table: 'capwap-aps', where: { name: 'LAP1', state: 'run' }, exists: true }],
        },
      ],
      feedbackOnFail: 'An access point that finds no controller in its subnet keeps searching; the management interface must sit in the access point VLAN with an address of that subnet.',
    },
    {
      id: 'staff-interface',
      title: 'Create the staff controller interface',
      description: `WLC1 has the interface ${WLC_LAB_CLIENT_INTERFACE} in VLAN ${WLC_LAB_CLIENT_VLAN} with ${WLC_LAB_CLIENT_ADDRESS}/24, the gateway ${WLC_LAB_CLIENT_GATEWAY} and the DHCP server ${WLC_LAB_CLIENT_GATEWAY}.`,
      points: 20,
      hint: 'A controller interface is a name for a VLAN, an address in it and the router of that subnet.',
      assertions: [
        { kind: 'config', device: 'WLC1', path: `wlc-interface.${WLC_LAB_CLIENT_INTERFACE}.vlan`, equals: String(WLC_LAB_CLIENT_VLAN) },
        { kind: 'config', device: 'WLC1', path: `wlc-interface.${WLC_LAB_CLIENT_INTERFACE}.address`, equals: [WLC_LAB_CLIENT_ADDRESS, MASK24] },
        { kind: 'config', device: 'WLC1', path: `wlc-interface.${WLC_LAB_CLIENT_INTERFACE}.gateway`, equals: WLC_LAB_CLIENT_GATEWAY },
        { kind: 'config', device: 'WLC1', path: `wlc-interface.${WLC_LAB_CLIENT_INTERFACE}.dhcp-server`, equals: WLC_LAB_CLIENT_GATEWAY },
        // the interface the handler keeps for it: up in VLAN 20 with its address
        { kind: 'port', device: 'WLC1', port: `Vlan${WLC_LAB_CLIENT_VLAN}`, field: 'ipv4', equals: WLC_LAB_CLIENT_ADDRESS },
        { kind: 'port', device: 'WLC1', port: `Vlan${WLC_LAB_CLIENT_VLAN}`, field: 'operUp', equals: true },
      ],
    },
    {
      id: 'wlan',
      title: 'Create the WLAN on the staff interface',
      description: `WLAN ${WLC_LAB_WLAN_ID} (profile ${WLC_LAB_PROFILE}, network ${WLC_LAB_SSID}) uses personal WPA2 security with a passphrase, maps to ${WLC_LAB_CLIENT_INTERFACE}, and LAP1 has received it.`,
      points: 25,
      dependsOn: ['management', 'staff-interface'],
      hint: 'Without an interface line a WLAN uses the management interface.',
      assertions: [
        { kind: 'config', device: 'WLC1', path: `wlan.${WLC_LAB_WLAN_ID}.${WLC_LAB_PROFILE}.${WLC_LAB_SSID}`, exists: true },
        { kind: 'config', device: 'WLC1', path: `wlan.${WLC_LAB_WLAN_ID}.security`, equals: 'wpa2-psk' },
        { kind: 'config', device: 'WLC1', path: `wlan.${WLC_LAB_WLAN_ID}.passphrase`, exists: true },
        { kind: 'config', device: 'WLC1', path: `wlan.${WLC_LAB_WLAN_ID}.interface`, equals: WLC_LAB_CLIENT_INTERFACE },
        { kind: 'config', device: 'WLC1', path: `wlan.${WLC_LAB_WLAN_ID}.shutdown`, exists: false },
        {
          kind: 'connectivity',
          from: 'WLC1',
          to: 'LAP1',
          expect: 'success',
          then: [{ kind: 'table', device: 'LAP1', table: 'capwap', where: { controller: WLC_LAB_MGMT_ADDRESS, state: 'run', wlans: 1 }, exists: true }],
        },
      ],
      feedbackOnFail: 'The controller pushes a WLAN to its access points only while the WLAN is enabled.',
    },
    {
      id: 'client',
      title: 'Connect the laptop through the access point',
      description: `LAPTOP1 has joined ${WLC_LAB_SSID}, leased an address and reaches its gateway ${WLC_LAB_CLIENT_GATEWAY}; WLC1 lists it as a client of VLAN ${WLC_LAB_CLIENT_VLAN} on ${WLC_LAB_CLIENT_INTERFACE}.`,
      points: 30,
      dependsOn: ['wlan'],
      hint: 'Join the network with its passphrase, then ask the wireless adapter for an address.',
      assertions: [
        { kind: 'config', device: 'LAPTOP1', path: 'interface.Wlan0.ssid', equals: WLC_LAB_SSID },
        // the lease is asked for on the wireless adapter (the host shell's static form writes the wired one)
        { kind: 'config', device: 'LAPTOP1', path: 'interface.Wlan0.ip.address', equals: 'dhcp' },
        {
          kind: 'connectivity',
          from: 'LAPTOP1',
          to: 'R1',
          expect: 'success',
          then: [
            {
              kind: 'table',
              device: 'WLC1',
              table: 'wlan-clients',
              where: { ssid: WLC_LAB_SSID, vlan: WLC_LAB_CLIENT_VLAN, iface: WLC_LAB_CLIENT_INTERFACE },
              exists: true,
            },
          ],
        },
      ],
      feedbackOnFail: 'The laptop lands in the VLAN of the WLAN\'s controller interface: check the interface the WLAN is mapped to.',
    },
  ],
  solution: {
    WLC1: [
      'wlc-interface management',
      `vlan ${WLC_LAB_AP_VLAN}`,
      `address ${WLC_LAB_MGMT_ADDRESS} ${MASK24}`,
      `gateway ${WLC_LAB_AP_GATEWAY}`,
      'exit',
      `wlc-interface ${WLC_LAB_CLIENT_INTERFACE}`,
      `vlan ${WLC_LAB_CLIENT_VLAN}`,
      `address ${WLC_LAB_CLIENT_ADDRESS} ${MASK24}`,
      `gateway ${WLC_LAB_CLIENT_GATEWAY}`,
      `dhcp-server ${WLC_LAB_CLIENT_GATEWAY}`,
      'exit',
      `wlan ${WLC_LAB_WLAN_ID} ${WLC_LAB_PROFILE} ${WLC_LAB_SSID}`,
      'security wpa2-psk',
      `passphrase ${WLC_LAB_PASSPHRASE}`,
      `interface ${WLC_LAB_CLIENT_INTERFACE}`,
      'no shutdown',
      'exit',
    ],
    LAPTOP1: [`wifi connect ${WLC_LAB_SSID} key ${WLC_LAB_PASSPHRASE}`, 'ip address dhcp Wlan0'],
  },
};

/** The wireless labs, in course order. */
export const CCNA2_WIRELESS_LABS: readonly ScenarioInfo[] = [ccna2WlcWlan];
