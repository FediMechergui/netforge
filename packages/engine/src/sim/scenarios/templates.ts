/**
 * sim/scenarios/templates.ts — the built-in "New from template" worlds (spec §19 P0 exit criterion, §13.2 topology
 * schema; ARCHITECTURE-P1 §8.1 W5, §8.2 W6).
 *
 * Each builder returns a fresh `Topology` whose devices carry startup configs, so loading it
 * into a Simulation and letting the devices boot yields a working network:
 *   • `twoPcsAndSwitch` — PC1 and PC2 on one switch (the P0 acceptance lab: ping + ARP).
 *   • `pcRouterPc`      — two subnets joined by a router (TTL decrement, gateway ARP).
 *   • `threeRouters`    — PC – R1 – R2 – R3 – PC chain with static routes on every router.
 *
 * P0.5 templates (the §10.1 acceptance worlds):
 *   • `homeWifi`          — a home wireless router (WPA2 network LAB) with a wired PC and a laptop 40 m away.
 *   • `hubCollision`      — three PCs on a 10 Mb hub: one shared collision domain.
 *   • `serialPair`        — two branch routers on a serial cable whose DCE end sets `clock rate 64000`.
 *   • `multilayerRouted`  — a layer-3 switch with a routed uplink port and a loopback, reached by a router.
 *   • `radioBridge`       — two wired LANs joined by 5 GHz point-to-point radios 10 km apart.
 *   • `cellularPhones`    — two smartphones attached to a cell tower whose backhaul reaches a server.
 *
 * Every builder keeps the body it had before the P1 split: the topologies these produce are byte-identical, because
 * the P0/P0.5 acceptance tests compare their traces event for event. Only the shared builders moved out (kit.ts),
 * and the list of entries is now `TEMPLATES`, which sim/scenarios/index.ts puts first in `SCENARIOS`. All wording is
 * original (§1.6, D13).
 *
 * ponytail: the builders were moved, not rewritten — the only edits are the header, the shared helpers that now
 * come from kit.ts, and the renamed list. Anything else here would change a trace an acceptance test pins.
 */
import { TOPOLOGY_SCHEMA_ID, type Topology } from '../../contracts/topology.js';
import type { ScenarioInfo } from '../../contracts/scenario.js';
import {
  CELL_TOWER, HOME_ROUTER, HUB, LAPTOP, MASK24, MASK30, MASK32, MLSWITCH, PC, RADIO_PTP5, ROUTER, SERVER, SMARTPHONE, SWITCH,
  cable, configText, device, link, radioLink, section,
} from './kit.js';

/** Default seed stamped into template topologies (the Simulation keeps its own seed). */
export const SCENARIO_SEED = 1;

/** Startup config of a PC: hostname, the NIC address and an optional default gateway. */
export function pcConfig(hostname: string, address: string, mask: string, gateway?: string): string {
  const sections: string[][] = [[`hostname ${hostname}`], ['interface GigabitEthernet0', ` ip address ${address} ${mask}`]];
  if (gateway !== undefined) sections.push([`ip default-gateway ${gateway}`]);
  return configText(sections);
}

/** Startup config of a router: hostname, enabled addressed interfaces and static routes. */
export function routerConfig(
  hostname: string,
  interfaces: readonly { port: string; address: string; mask: string }[],
  routes: readonly string[] = [],
): string {
  const sections: string[][] = [[`hostname ${hostname}`]];
  for (const i of interfaces) {
    sections.push([`interface ${i.port}`, ` ip address ${i.address} ${i.mask}`, ' no shutdown']);
  }
  if (routes.length > 0) sections.push(routes.map((r) => `ip route ${r}`));
  return configText(sections);
}

/** Two PCs (10.0.0.1/24, 10.0.0.2/24) on one access switch. */
export function twoPcsAndSwitch(): Topology {
  return {
    schema: TOPOLOGY_SCHEMA_ID,
    seed: SCENARIO_SEED,
    devices: [
      device('pc1', PC, 'PC1', 100, 300, pcConfig('PC1', '10.0.0.1', MASK24)),
      device('sw1', SWITCH, 'SW1', 300, 150, configText([['hostname SW1']])),
      device('pc2', PC, 'PC2', 500, 300, pcConfig('PC2', '10.0.0.2', MASK24)),
    ],
    links: [link('l_pc1_sw1', 'pc1', 'GigabitEthernet0', 'sw1', 'FastEthernet0/1'), link('l_pc2_sw1', 'pc2', 'GigabitEthernet0', 'sw1', 'FastEthernet0/2')],
    objectives: ['Ping PC2 from PC1 and watch the ARP exchange'],
    notes: 'Both PCs share the 10.0.0.0/24 subnet; the switch learns their MAC addresses as frames pass.',
  };
}

/** PC1 (10.0.0.1/24) – R1 – PC2 (10.0.1.1/24), each PC using the router as its gateway. */
export function pcRouterPc(): Topology {
  return {
    schema: TOPOLOGY_SCHEMA_ID,
    seed: SCENARIO_SEED,
    devices: [
      device('pc1', PC, 'PC1', 100, 300, pcConfig('PC1', '10.0.0.1', MASK24, '10.0.0.254')),
      device(
        'r1',
        ROUTER,
        'R1',
        300,
        150,
        routerConfig('R1', [
          { port: 'GigabitEthernet0/0', address: '10.0.0.254', mask: MASK24 },
          { port: 'GigabitEthernet0/1', address: '10.0.1.254', mask: MASK24 },
        ]),
      ),
      device('pc2', PC, 'PC2', 500, 300, pcConfig('PC2', '10.0.1.1', MASK24, '10.0.1.254')),
    ],
    links: [link('l_pc1_r1', 'pc1', 'GigabitEthernet0', 'r1', 'GigabitEthernet0/0'), link('l_r1_pc2', 'r1', 'GigabitEthernet0/1', 'pc2', 'GigabitEthernet0')],
    objectives: ['Ping PC2 from PC1 through the router', 'Find the TTL decrement in the packet provenance'],
    notes: 'The router joins 10.0.0.0/24 and 10.0.1.0/24; both subnets are directly connected.',
  };
}

/**
 * PC1 (10.1.0.10/24) – R1 – R2 – R3 – PC3 (10.3.0.10/24). Transit subnets 10.0.12.0/24
 * (R1–R2) and 10.0.23.0/24 (R2–R3); every router has static routes to the networks it is
 * not attached to.
 */
export function threeRouters(): Topology {
  return {
    schema: TOPOLOGY_SCHEMA_ID,
    seed: SCENARIO_SEED,
    devices: [
      device('pc1', PC, 'PC1', 80, 320, pcConfig('PC1', '10.1.0.10', MASK24, '10.1.0.1')),
      device(
        'r1',
        ROUTER,
        'R1',
        220,
        160,
        routerConfig(
          'R1',
          [
            { port: 'GigabitEthernet0/0', address: '10.1.0.1', mask: MASK24 },
            { port: 'GigabitEthernet0/1', address: '10.0.12.1', mask: MASK24 },
          ],
          [`10.0.23.0 ${MASK24} 10.0.12.2`, `10.3.0.0 ${MASK24} 10.0.12.2`],
        ),
      ),
      device(
        'r2',
        ROUTER,
        'R2',
        400,
        100,
        routerConfig(
          'R2',
          [
            { port: 'GigabitEthernet0/0', address: '10.0.12.2', mask: MASK24 },
            { port: 'GigabitEthernet0/1', address: '10.0.23.2', mask: MASK24 },
          ],
          [`10.1.0.0 ${MASK24} 10.0.12.1`, `10.3.0.0 ${MASK24} 10.0.23.3`],
        ),
      ),
      device(
        'r3',
        ROUTER,
        'R3',
        580,
        160,
        routerConfig(
          'R3',
          [
            { port: 'GigabitEthernet0/0', address: '10.0.23.3', mask: MASK24 },
            { port: 'GigabitEthernet0/1', address: '10.3.0.1', mask: MASK24 },
          ],
          [`10.1.0.0 ${MASK24} 10.0.23.2`, `10.0.12.0 ${MASK24} 10.0.23.2`],
        ),
      ),
      device('pc3', PC, 'PC3', 720, 320, pcConfig('PC3', '10.3.0.10', MASK24, '10.3.0.1')),
    ],
    links: [
      link('l_pc1_r1', 'pc1', 'GigabitEthernet0', 'r1', 'GigabitEthernet0/0'),
      link('l_r1_r2', 'r1', 'GigabitEthernet0/1', 'r2', 'GigabitEthernet0/0'),
      link('l_r2_r3', 'r2', 'GigabitEthernet0/1', 'r3', 'GigabitEthernet0/0'),
      link('l_r3_pc3', 'r3', 'GigabitEthernet0/1', 'pc3', 'GigabitEthernet0'),
    ],
    objectives: ['Ping PC3 from PC1 across three routers', 'Read each router\'s static routes'],
    notes: 'Static routing only: each router needs a route to every subnet it is not connected to.',
  };
}

// ── P0.5 templates ────────────────────────────────────────────────

/** SSID of the home Wi-Fi template. */
export const HOME_WIFI_SSID = 'LAB';
/** Pre-shared passphrase of the home Wi-Fi template (teaching value). */
export const HOME_WIFI_PASSPHRASE = 'lab-wireless-2468';
/** Canvas distance between the home router and the laptop: 160 units × 0.25 m = 40 m. */
export const HOME_WIFI_LAPTOP_UNITS = 160;
/** Clock rate the serial pair's DCE end supplies, in bits per second. */
export const SERIAL_PAIR_CLOCK_RATE_BPS = 64_000;
/** Distance override of the radio bridge link, in metres. */
export const RADIO_BRIDGE_DISTANCE_M = 10_000;
/** 5 GHz channel both bridge radios use. */
export const RADIO_BRIDGE_CHANNEL = 149;
/** Pairing key both bridge radios share (teaching value). */
export const RADIO_BRIDGE_PEER_KEY = 'ridge-link-7';

/** The Wlan lines that select the home Wi-Fi network (identical on the access point and the station). */
function homeWifiLines(): string[] {
  return [`ssid ${HOME_WIFI_SSID}`, 'security wpa2-psk', `passphrase ${HOME_WIFI_PASSPHRASE}`];
}

/**
 * Home Wi-Fi: HOME1 (`wrouter.nfhome`, LAN SVI Vlan1 192.168.1.1/24, WPA2 network LAB on Wlan0), PC1
 * (192.168.1.10/24) cabled to its LAN port GigabitEthernet1, and LAPTOP1 (192.168.1.20/24 on Wlan0) 40 m away.
 */
export function homeWifi(): Topology {
  const routerX = 300;
  const routerY = 150;
  return {
    schema: TOPOLOGY_SCHEMA_ID,
    seed: SCENARIO_SEED,
    devices: [
      device(
        'home1',
        HOME_ROUTER,
        'HOME1',
        routerX,
        routerY,
        configText([['hostname HOME1'], section('interface Vlan1', [`ip address 192.168.1.1 ${MASK24}`]), section('interface Wlan0', homeWifiLines())]),
      ),
      device('pc1', PC, 'PC1', 100, 300, pcConfig('PC1', '192.168.1.10', MASK24, '192.168.1.1')),
      device(
        'laptop1',
        LAPTOP,
        'LAPTOP1',
        routerX + HOME_WIFI_LAPTOP_UNITS,
        routerY,
        configText([['hostname LAPTOP1'], section('interface Wlan0', [`ip address 192.168.1.20 ${MASK24}`, ...homeWifiLines()]), ['ip default-gateway 192.168.1.1']]),
      ),
    ],
    links: [link('l_pc1_home1', 'pc1', 'GigabitEthernet0', 'home1', 'GigabitEthernet1')],
    objectives: ['Watch LAPTOP1 scan, join and finish the key handshake', 'Ping PC1 from LAPTOP1 and find the framing change'],
    notes: 'The home router bridges its Wi-Fi radio and LAN ports into one 192.168.1.0/24 network. The laptop joins network LAB with the shared passphrase.',
  };
}

/** Hub collision demo: PC1–PC3 (10.0.0.1–3/24) on Ethernet0–2 of a 4-port 10 Mb hub. */
export function hubCollision(): Topology {
  return {
    schema: TOPOLOGY_SCHEMA_ID,
    seed: SCENARIO_SEED,
    devices: [
      device('pc1', PC, 'PC1', 100, 300, pcConfig('PC1', '10.0.0.1', MASK24)),
      device('hub1', HUB, 'HUB1', 300, 150),
      device('pc2', PC, 'PC2', 300, 340, pcConfig('PC2', '10.0.0.2', MASK24)),
      device('pc3', PC, 'PC3', 500, 300, pcConfig('PC3', '10.0.0.3', MASK24)),
    ],
    links: [
      link('l_pc1_hub1', 'pc1', 'GigabitEthernet0', 'hub1', 'Ethernet0'),
      link('l_pc2_hub1', 'pc2', 'GigabitEthernet0', 'hub1', 'Ethernet1'),
      link('l_pc3_hub1', 'pc3', 'GigabitEthernet0', 'hub1', 'Ethernet2'),
    ],
    objectives: ['Ping PC3 from PC1 and see that PC2 gets the frames too', 'Ping from PC1 and PC2 together and look for collisions'],
    notes: 'A hub repeats every signal to all of its other ports, so the three PCs share one half-duplex collision domain at 10 Mb/s.',
  };
}

/**
 * Serial pair: PC1 (10.1.0.10/24) – R1 – R2 – PC2 (10.2.0.10/24). R1 Serial0/0/0 holds the DCE end of the serial
 * cable and sets `clock rate 64000`; the serial subnet is 10.0.12.0/30 and each router has a static route to the far
 * LAN.
 */
export function serialPair(): Topology {
  return {
    schema: TOPOLOGY_SCHEMA_ID,
    seed: SCENARIO_SEED,
    devices: [
      device('pc1', PC, 'PC1', 80, 320, pcConfig('PC1', '10.1.0.10', MASK24, '10.1.0.1')),
      device(
        'r1',
        ROUTER,
        'R1',
        260,
        150,
        configText([
          ['hostname R1'],
          section('interface GigabitEthernet0/0', [`ip address 10.1.0.1 ${MASK24}`, 'no shutdown']),
          section('interface Serial0/0/0', [`ip address 10.0.12.1 ${MASK30}`, `clock rate ${SERIAL_PAIR_CLOCK_RATE_BPS}`, 'no shutdown']),
          [`ip route 10.2.0.0 ${MASK24} 10.0.12.2`],
        ]),
      ),
      device(
        'r2',
        ROUTER,
        'R2',
        540,
        150,
        configText([
          ['hostname R2'],
          section('interface GigabitEthernet0/0', [`ip address 10.2.0.1 ${MASK24}`, 'no shutdown']),
          section('interface Serial0/0/0', [`ip address 10.0.12.2 ${MASK30}`, 'no shutdown']),
          [`ip route 10.1.0.0 ${MASK24} 10.0.12.1`],
        ]),
      ),
      device('pc2', PC, 'PC2', 720, 320, pcConfig('PC2', '10.2.0.10', MASK24, '10.2.0.1')),
    ],
    links: [
      link('l_pc1_r1', 'pc1', 'GigabitEthernet0', 'r1', 'GigabitEthernet0/0'),
      cable('l_r1_r2', 'r1', 'Serial0/0/0', 'r2', 'Serial0/0/0', 'serial-dce'),
      link('l_r2_pc2', 'r2', 'GigabitEthernet0/0', 'pc2', 'GigabitEthernet0'),
    ],
    objectives: ['Remove the clock rate on R1 and see the line protocol drop', 'Ping PC2 from PC1 across the serial link'],
    notes: 'The end of the serial cable with the DCE connector (R1) must supply the clock. The link runs HDLC framing with keepalives every 10 seconds.',
  };
}

/**
 * Multilayer switch routed port: MLS1 (`mlswitch.nfc3650-24`) turns GigabitEthernet1/0/24 into a routed port
 * (10.1.1.1/24) facing R1 (10.1.1.2/24) and answers on Loopback0 (10.9.9.1/32). PC2 and PC3 (10.5.0.2–3/24) stay on
 * switchports GigabitEthernet1/0/1–2. PC1 (10.2.0.10/24) sits behind R1, which has a host route to the loopback.
 */
export function multilayerRouted(): Topology {
  return {
    schema: TOPOLOGY_SCHEMA_ID,
    seed: SCENARIO_SEED,
    devices: [
      device('pc2', PC, 'PC2', 100, 320, pcConfig('PC2', '10.5.0.2', MASK24)),
      device('pc3', PC, 'PC3', 260, 360, pcConfig('PC3', '10.5.0.3', MASK24)),
      device(
        'mls1',
        MLSWITCH,
        'MLS1',
        300,
        150,
        configText([
          ['hostname MLS1'],
          section('interface GigabitEthernet1/0/24', ['no switchport', `ip address 10.1.1.1 ${MASK24}`]),
          section('interface Loopback0', [`ip address 10.9.9.1 ${MASK32}`]),
          [`ip route 10.2.0.0 ${MASK24} 10.1.1.2`],
        ]),
      ),
      device(
        'r1',
        ROUTER,
        'R1',
        560,
        150,
        routerConfig(
          'R1',
          [
            { port: 'GigabitEthernet0/0', address: '10.1.1.2', mask: MASK24 },
            { port: 'GigabitEthernet0/1', address: '10.2.0.1', mask: MASK24 },
          ],
          [`10.9.9.1 ${MASK32} 10.1.1.1`],
        ),
      ),
      device('pc1', PC, 'PC1', 740, 320, pcConfig('PC1', '10.2.0.10', MASK24, '10.2.0.1')),
    ],
    links: [
      link('l_pc2_mls1', 'pc2', 'GigabitEthernet0', 'mls1', 'GigabitEthernet1/0/1'),
      link('l_pc3_mls1', 'pc3', 'GigabitEthernet0', 'mls1', 'GigabitEthernet1/0/2'),
      link('l_mls1_r1', 'mls1', 'GigabitEthernet1/0/24', 'r1', 'GigabitEthernet0/0'),
      link('l_r1_pc1', 'r1', 'GigabitEthernet0/1', 'pc1', 'GigabitEthernet0'),
    ],
    objectives: ['Ping 10.1.1.1 and the loopback 10.9.9.1 from PC1', 'Return Gi1/0/24 to switching and watch its routes go'],
    notes: 'On a layer-3 switch every copper port starts as a switchport. "no switchport" makes GigabitEthernet1/0/24 a routed port with its own address, while the other ports keep bridging.',
  };
}

/**
 * Radio bridge: PC1 (10.0.0.1/24) – SW1 – RADIO1 ~ 10 km ~ RADIO2 – SW2 – PC2 (10.0.0.2/24). Both
 * `radio.nfptp5` units use channel 149 and the same pairing key; the radio link carries a 10 000 m distance override.
 */
export function radioBridge(): Topology {
  const radioLines = [`channel ${RADIO_BRIDGE_CHANNEL}`, `peer-key ${RADIO_BRIDGE_PEER_KEY}`];
  return {
    schema: TOPOLOGY_SCHEMA_ID,
    seed: SCENARIO_SEED,
    devices: [
      device('pc1', PC, 'PC1', 60, 320, pcConfig('PC1', '10.0.0.1', MASK24)),
      device('sw1', SWITCH, 'SW1', 200, 200, configText([['hostname SW1']])),
      device('radio1', RADIO_PTP5, 'RADIO1', 340, 120, configText([['hostname RADIO1'], section('interface Radio0', radioLines)])),
      device('radio2', RADIO_PTP5, 'RADIO2', 660, 120, configText([['hostname RADIO2'], section('interface Radio0', radioLines)])),
      device('sw2', SWITCH, 'SW2', 800, 200, configText([['hostname SW2']])),
      device('pc2', PC, 'PC2', 940, 320, pcConfig('PC2', '10.0.0.2', MASK24)),
    ],
    links: [
      link('l_pc1_sw1', 'pc1', 'GigabitEthernet0', 'sw1', 'FastEthernet0/1'),
      link('l_sw1_radio1', 'sw1', 'GigabitEthernet0/1', 'radio1', 'GigabitEthernet0'),
      radioLink('l_radio1_radio2', 'radio1', 'Radio0', 'radio2', 'Radio0', RADIO_BRIDGE_DISTANCE_M),
      link('l_radio2_sw2', 'radio2', 'GigabitEthernet0', 'sw2', 'GigabitEthernet0/1'),
      link('l_sw2_pc2', 'sw2', 'FastEthernet0/1', 'pc2', 'GigabitEthernet0'),
    ],
    objectives: ['Ping PC2 from PC1 across the radio link', 'Change one radio pairing key and read why the link drops'],
    notes: 'Each radio bridges its wired port and its radio, so both switches and PCs end up in one 10.0.0.0/24 network. The link comes up only when band, channel and key match and the far radio is in range.',
  };
}

/**
 * Cellular phones: SRV1 (10.20.0.100/24) on the GigabitEthernet0 backhaul of TOWER1 (`cell.nftower`); PHONE1 and
 * PHONE2 (10.20.0.11–12/24 on Cellular0) about 50 m from the tower.
 */
export function cellularPhones(): Topology {
  return {
    schema: TOPOLOGY_SCHEMA_ID,
    seed: SCENARIO_SEED,
    devices: [
      device('srv1', SERVER, 'SRV1', 100, 150, configText([['hostname SRV1'], section('interface GigabitEthernet0', [`ip address 10.20.0.100 ${MASK24}`])])),
      device('tower1', CELL_TOWER, 'TOWER1', 300, 150, configText([['hostname TOWER1'], section('interface Cellular0', ['no shutdown'])])),
      device('phone1', SMARTPHONE, 'PHONE1', 460, 270, configText([['hostname PHONE1'], section('interface Cellular0', [`ip address 10.20.0.11 ${MASK24}`])])),
      device('phone2', SMARTPHONE, 'PHONE2', 460, 30, configText([['hostname PHONE2'], section('interface Cellular0', [`ip address 10.20.0.12 ${MASK24}`])])),
    ],
    links: [link('l_srv1_tower1', 'srv1', 'GigabitEthernet0', 'tower1', 'GigabitEthernet0')],
    objectives: ['Watch both phones search for the tower and attach', 'Ping SRV1 from PHONE1, then ping PHONE2 through the tower'],
    notes: 'The tower bridges its cellular radio and its wired backhaul, so the phones and the server share 10.20.0.0/24. A phone attaches to the strongest tower in range.',
  };
}

/** Templates offered by the UI, in menu order; `SCENARIOS` (sim/scenarios/index.ts) lists them first. */
export const TEMPLATES: readonly ScenarioInfo[] = [
  {
    name: 'two-pcs-and-switch',
    category: 'template',
    title: 'Two PCs and a switch',
    description: 'Two hosts on one subnet behind an access switch. Ping between them and watch ARP and MAC learning.',
    build: twoPcsAndSwitch,
  },
  {
    name: 'pc-router-pc',
    category: 'template',
    title: 'PC, router, PC',
    description: 'Two subnets joined by a router. Follow a ping through the gateway and see the TTL drop by one.',
    build: pcRouterPc,
  },
  {
    name: 'three-routers',
    category: 'template',
    title: 'Three routers in a row',
    description: 'A chain of three routers with static routes between two hosts. Good for route troubleshooting.',
    build: threeRouters,
  },
  {
    name: 'home-wifi',
    category: 'template',
    title: 'Home Wi-Fi',
    description: 'A home wireless router with a wired PC and a laptop 40 m away on a WPA2 network. Watch the laptop scan, join and exchange keys.',
    tags: ['wifi', 'wireless', 'home', 'association', 'wpa2'],
    difficulty: 1,
    requires: [HOME_ROUTER, PC, LAPTOP],
    build: homeWifi,
  },
  {
    name: 'hub-collision',
    category: 'template',
    title: 'Hub and collisions',
    description: 'Three PCs share one 10 Mb hub. Every frame reaches every station, and simultaneous senders collide and back off.',
    tags: ['hub', 'legacy', 'collision domain', 'half duplex', 'csma/cd'],
    difficulty: 1,
    requires: [PC, HUB],
    build: hubCollision,
  },
  {
    name: 'serial-pair',
    category: 'template',
    title: 'Serial pair with clocking',
    description: 'Two routers joined by a serial cable. The DCE end supplies the clock rate that brings the line protocol up.',
    tags: ['serial', 'wan', 'dce', 'clock rate', 'keepalive', 'static routing'],
    difficulty: 2,
    requires: [PC, ROUTER],
    build: serialPair,
  },
  {
    name: 'multilayer-routed-port',
    category: 'template',
    title: 'Multilayer switch routed port',
    description: 'A layer-3 switch turns one port into a routed uplink towards a router and answers on a loopback, while its other ports keep switching.',
    tags: ['multilayer switch', 'layer 3', 'routed port', 'no switchport', 'loopback'],
    difficulty: 2,
    requires: [PC, MLSWITCH, ROUTER],
    build: multilayerRouted,
  },
  {
    name: 'radio-bridge',
    category: 'template',
    title: 'Radio bridge between two LANs',
    description: 'Two wired networks 10 km apart joined by a pair of 5 GHz point-to-point radios sharing a channel and a pairing key.',
    tags: ['radio', 'point-to-point', 'wireless bridge', 'backhaul'],
    difficulty: 2,
    requires: [PC, SWITCH, RADIO_PTP5],
    build: radioBridge,
  },
  {
    name: 'cellular-phones',
    category: 'template',
    title: 'Cellular phones',
    description: 'Two smartphones attach to a cell tower and reach a server on the tower backhaul.',
    tags: ['cellular', 'mobile', 'attach', 'tower'],
    difficulty: 1,
    requires: [SERVER, CELL_TOWER, SMARTPHONE],
    build: cellularPhones,
  },
];
