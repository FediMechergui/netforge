/**
 * sim/scenarios/ccna2/routing.ts — the CCNA 2 static routing labs (ARCHITECTURE-P2 §11.1, §11.2, D13).
 *
 *   • `ccna2-static-routes`   — lesson 30 "Static route forms" (module "Static routing"): one route of each form —
 *     next hop over an Ethernet link, exit interface over a serial link, fully specified on the way back, and a /32
 *     host route that lets a partner site reach exactly one server.
 *   • `ccna2-floating-static` — lesson 31 "Default and floating routes" (module "Static routing"): a branch default
 *     route and a return route over the main link, each with a floating twin (distance 5) over a slow serial link
 *     that takes over when the main link goes down.
 *   • `ccna2-ipv6-static`     — lesson 32 "IPv6 static routes" (module "Static routing"): on a dual-stack pair whose
 *     IPv4 routes already work, an IPv6 default route to a global next hop and a return route to a link-local next
 *     hop, which only works with its exit interface named.
 *
 * All three are P2-profile worlds (`topology(…, { profile: 'P2' })`). None is about spanning tree, so the one switch
 * (the HQ LAN of the route-forms lab) has every port toward a host or a router as an edge port
 * (`spanning-tree portfast`) in its startup configuration (§11.2); the other two labs cable their hosts straight to
 * the routers. Tasks read structured state only (sim/lab-checks.ts): `route` checks the longest-prefix winner (its
 * network, next hop, exit interface and distance), `table` pins the shape of a static row where the FORM of the line
 * is the point (a next-hop line stores no interface, an exit-interface line no next hop), and `connectivity` pings in
 * the grader's clone — with `after` (the main link shut) and `then` (the routes installed in that clone) for the
 * floating routes. Every lab carries a reference `solution` that `Simulation.configure` accepts as written. Addresses
 * come from the private and documentation ranges; all wording is original (§0 rule 6).
 *
 * A lab file imports only the contracts, `../kit.js` and `../templates.js` — never `./index.js`, `../index.js` or
 * the engine barrel — so the catalogue stays an acyclic graph of data modules (the arrays are read at module scope).
 *
 * ponytail: the floating lab fails its main link with a `shutdown` of R1's Ethernet interface, not a cable `cut`:
 * a `cut {a, b}` fault cuts EVERY cable between the two devices, which here would take the serial backup down with
 * the main link. A shutdown takes the link down at both ends (each router withdraws its connected route, so each one's
 * main static stops being usable), which is exactly the failure a floating route is for.
 */
import type { ScenarioInfo } from '../../../contracts/scenario.js';
import { MASK24, MASK30, PC, ROUTER, SERVER, SWITCH, accessPort, cable, configText, device, link, section, topology } from '../kit.js';
import { SERIAL_PAIR_CLOCK_RATE_BPS, pcConfig } from '../templates.js';

/** One interface of a router's startup configuration: its lines, `no shutdown` appended. */
interface RouterPort {
  readonly port: string;
  readonly lines: readonly string[];
}

/** A router's startup configuration: host name, global lines after it, interfaces (each enabled), then routes. */
function routerText(hostname: string, ports: readonly RouterPort[], routes: readonly string[] = [], globals: readonly string[] = []): string {
  const sections: string[][] = [[`hostname ${hostname}`, ...globals]];
  for (const p of ports) sections.push(section(`interface ${p.port}`, [...p.lines, 'no shutdown']));
  if (routes.length > 0) sections.push([...routes]);
  return configText(sections);
}

/** A dual-stack host: a static IPv4 address with its gateway, and an IPv6 address built from router advertisements. */
function dualStackHost(hostname: string, address: string, gateway: string): string {
  return configText([[`hostname ${hostname}`], section('interface GigabitEthernet0', [`ip address ${address} ${MASK24}`, 'ipv6 address autoconfig']), [`ip default-gateway ${gateway}`]]);
}

/** The DCE end of a serial link supplies the clock. */
const CLOCK = `clock rate ${SERIAL_PAIR_CLOCK_RATE_BPS}`;

// ── static route forms ──────────────────────────────────────────────────────

/** The HQ file server the partner site may reach, and nothing else at HQ. */
export const STATIC_FORMS_SERVER = '10.1.0.100';

/** SW1 of the HQ LAN: its host ports and the port toward R1 are edge ports (the lesson is not about spanning tree). */
function hqSwitchConfig(): string {
  return configText([
    ['hostname SW1'],
    accessPort('FastEthernet0/1', 1, { portfast: true }),
    accessPort('FastEthernet0/2', 1, { portfast: true }),
    accessPort('GigabitEthernet0/1', 1, { portfast: true }),
  ]);
}

/** HQ (R1) with an Ethernet link to Branch 2 (R2) and a serial link to the partner site (R3); no static route yet. */
export const ccna2StaticRoutes: ScenarioInfo = {
  name: 'ccna2-static-routes',
  category: 'ccna2-lab',
  labType: 'build',
  course: 'CCNA 2',
  topic: 'Static routing',
  title: 'Four ways to write a static route',
  description:
    'Headquarters, a branch and a partner site know only their own networks. Connect them with one static route of each form: next hop, exit interface, fully specified, and a host route that opens exactly one server to the partner.',
  objectives: [
    'Write a static route that names the next-hop address',
    'Write a static route that names only the exit interface, and say where that form fits',
    'Write a fully specified route with both the exit interface and the next hop',
    'Use a /32 host route to reach one host without routing its whole subnet',
  ],
  tags: ['static routing', 'next hop', 'exit interface', 'fully specified route', 'host route', 'longest match'],
  difficulty: 2,
  estimatedMinutes: 25,
  requires: [PC, ROUTER, SERVER, SWITCH],
  seed: 230,
  instructions: [
    '## What you have',
    '',
    `HQ router R1 serves \`10.1.0.0/24\`, where PC1 and the file server SRV1 (\`${STATIC_FORMS_SERVER}\`) sit behind SW1. Branch 2 (R2, PC2 in \`10.2.0.0/24\`) is joined to HQ by the Ethernet link \`10.0.12.0/30\`. The partner site (R3, PC3 in \`10.3.0.0/24\`) is joined by the serial link \`10.0.13.0/30\`. Every interface is up, and no router has a single static route.`,
    '',
    '## What to do',
    '',
    '- On R1, reach the Branch 2 LAN with a **next-hop** route: name the address of R2 on the Ethernet link, and no interface.',
    '- On R1, reach the partner LAN with an **exit-interface** route: name `Serial0/0/0` and no address. A point-to-point link has one device at the far end, so the interface says it all.',
    '- On R2, write the way back to the HQ LAN as a **fully specified** route: the exit interface *and* the next hop. On an Ethernet link, which could hold many neighbours, this names the one to hand packets to.',
    `- The partner may reach SRV1 and nothing else at HQ. On R3, write a **host route** (mask \`255.255.255.255\`) to \`${STATIC_FORMS_SERVER}\` alone.`,
    '- Check each router with `show ip route static`, then ping PC2 from PC1 and SRV1 from PC3. A ping from PC3 to PC1 must still fail.',
    '',
    '*The longest matching prefix always wins: a /32 for one host beats any shorter route that also covers it.*',
  ].join('\n'),
  build: () =>
    topology(
      230,
      [
        device('pc1', PC, 'PC1', 90, 300, pcConfig('PC1', '10.1.0.10', MASK24, '10.1.0.1')),
        device('srv1', SERVER, 'SRV1', 90, 440, pcConfig('SRV1', STATIC_FORMS_SERVER, MASK24, '10.1.0.1')),
        device('sw1', SWITCH, 'SW1', 240, 370, hqSwitchConfig()),
        device(
          'r1',
          ROUTER,
          'R1',
          420,
          260,
          routerText('R1', [
            { port: 'GigabitEthernet0/0', lines: [`ip address 10.1.0.1 ${MASK24}`] },
            { port: 'GigabitEthernet0/1', lines: [`ip address 10.0.12.1 ${MASK30}`] },
            { port: 'Serial0/0/0', lines: [`ip address 10.0.13.1 ${MASK30}`, CLOCK] },
          ]),
        ),
        device(
          'r2',
          ROUTER,
          'R2',
          640,
          130,
          routerText('R2', [
            { port: 'GigabitEthernet0/0', lines: [`ip address 10.0.12.2 ${MASK30}`] },
            { port: 'GigabitEthernet0/1', lines: [`ip address 10.2.0.1 ${MASK24}`] },
          ]),
        ),
        device('pc2', PC, 'PC2', 820, 130, pcConfig('PC2', '10.2.0.10', MASK24, '10.2.0.1')),
        device(
          'r3',
          ROUTER,
          'R3',
          640,
          400,
          routerText('R3', [
            { port: 'Serial0/0/0', lines: [`ip address 10.0.13.2 ${MASK30}`] },
            { port: 'GigabitEthernet0/0', lines: [`ip address 10.3.0.1 ${MASK24}`] },
          ]),
        ),
        device('pc3', PC, 'PC3', 820, 400, pcConfig('PC3', '10.3.0.10', MASK24, '10.3.0.1')),
      ],
      [
        link('l_pc1_sw1', 'pc1', 'GigabitEthernet0', 'sw1', 'FastEthernet0/1'),
        link('l_srv1_sw1', 'srv1', 'GigabitEthernet0', 'sw1', 'FastEthernet0/2'),
        link('l_sw1_r1', 'sw1', 'GigabitEthernet0/1', 'r1', 'GigabitEthernet0/0'),
        link('l_r1_r2', 'r1', 'GigabitEthernet0/1', 'r2', 'GigabitEthernet0/0'),
        link('l_r2_pc2', 'r2', 'GigabitEthernet0/1', 'pc2', 'GigabitEthernet0'),
        cable('l_r1_r3', 'r1', 'Serial0/0/0', 'r3', 'Serial0/0/0', 'serial-dce'),
        link('l_r3_pc3', 'r3', 'GigabitEthernet0/0', 'pc3', 'GigabitEthernet0'),
      ],
      ['Write one static route of each form', 'Open exactly one HQ server to the partner site', 'Ping across every link that has a route'],
      'A static route names the destination and where to send it: a next-hop address, an exit interface, or both. A /32 route names one host.',
      { profile: 'P2' },
    ),
  tasks: [
    {
      id: 'next-hop-route',
      title: 'A next-hop route to Branch 2',
      description: 'R1 reaches 10.2.0.0/24 with a line that names the next hop 10.0.12.2 and no interface.',
      points: 15,
      hint: 'The next hop is the address of the neighbouring router on the link you share with it.',
      assertions: [
        { kind: 'route', device: 'R1', destination: '10.2.0.10', source: 'S', network: '10.2.0.0/24', nextHop: '10.0.12.2' },
        // the next-hop FORM: a line that also names the interface is the fully specified form (R2's task)
        { kind: 'table', device: 'R1', table: 'rib', where: { network: '10.2.0.0', prefixLen: 24, source: 'S', iface: 'GigabitEthernet0/1' }, exists: false },
      ],
      feedbackOnFail: 'This route names the next-hop address alone; with the interface in front of it the line becomes the fully specified form, which R2 practises.',
    },
    {
      id: 'exit-interface-route',
      title: 'An exit-interface route over the serial link',
      description: 'R1 reaches 10.3.0.0/24 with a line that names Serial0/0/0 as the exit interface and no next-hop address.',
      points: 15,
      hint: 'Put the interface name where the next-hop address would go.',
      assertions: [
        { kind: 'route', device: 'R1', destination: '10.3.0.10', source: 'S', network: '10.3.0.0/24', iface: 'Serial0/0/0' },
        { kind: 'table', device: 'R1', table: 'rib', where: { network: '10.3.0.0', prefixLen: 24, source: 'S', iface: 'Serial0/0/0' }, exists: true },
        // the exit-interface FORM: no next-hop address in the line
        { kind: 'table', device: 'R1', table: 'rib', where: { network: '10.3.0.0', prefixLen: 24, source: 'S', nextHop: '10.0.13.2' }, exists: false },
      ],
      feedbackOnFail: 'This route names the interface alone: a next-hop address, on its own or after the interface, makes it another form.',
    },
    {
      id: 'fully-specified-route',
      title: 'A fully specified route back to HQ',
      description: 'R2 reaches 10.1.0.0/24 out GigabitEthernet0/0 through the next hop 10.0.12.1, both named in one line.',
      points: 20,
      hint: 'Give the interface first, then the next-hop address.',
      assertions: [
        { kind: 'route', device: 'R2', destination: '10.1.0.10', source: 'S', network: '10.1.0.0/24', nextHop: '10.0.12.1', iface: 'GigabitEthernet0/0' },
        {
          kind: 'table',
          device: 'R2',
          table: 'rib',
          where: { network: '10.1.0.0', prefixLen: 24, source: 'S', iface: 'GigabitEthernet0/0', nextHop: '10.0.12.1' },
          exists: true,
        },
      ],
      feedbackOnFail: 'A fully specified route carries both parts: the exit interface and the next-hop address.',
    },
    {
      id: 'host-route',
      title: 'A host route to one server',
      description: `R3 routes ${STATIC_FORMS_SERVER}/32 and has no route to the rest of the HQ LAN.`,
      points: 20,
      hint: 'A host route has the mask 255.255.255.255.',
      assertions: [
        { kind: 'route', device: 'R3', destination: STATIC_FORMS_SERVER, source: 'S', network: `${STATIC_FORMS_SERVER}/32` },
        { kind: 'route', device: 'R3', destination: '10.1.0.10', none: true },
      ],
      feedbackOnFail: 'A route for the whole 10.1.0.0/24, or a default route, would open every HQ host to the partner.',
    },
    {
      id: 'traffic',
      title: 'Traffic follows the routes',
      description: 'PC1 reaches PC2, PC3 reaches SRV1, and PC3 still cannot reach PC1.',
      points: 30,
      dependsOn: ['next-hop-route', 'exit-interface-route', 'fully-specified-route', 'host-route'],
      assertions: [
        { kind: 'connectivity', from: 'PC1', to: 'PC2', expect: 'success' },
        { kind: 'connectivity', from: 'PC3', to: 'SRV1', expect: 'success' },
        { kind: 'connectivity', from: 'PC3', to: 'PC1', expect: 'fail' },
      ],
      feedbackOnFail: 'Every ping needs a route in both directions: the request on the way out and the reply on the way back.',
    },
  ],
  solution: {
    R1: [`ip route 10.2.0.0 ${MASK24} 10.0.12.2`, `ip route 10.3.0.0 ${MASK24} Serial0/0/0`],
    R2: [`ip route 10.1.0.0 ${MASK24} GigabitEthernet0/0 10.0.12.1`],
    R3: [`ip route ${STATIC_FORMS_SERVER} 255.255.255.255 Serial0/0/0`],
  },
};

// ── default and floating routes ─────────────────────────────────────────────

/** Administrative distance the floating routes are written with (above the default 1 of a static route). */
export const FLOATING_DISTANCE = 5;
/** The HQ server the branch reaches. */
export const FLOATING_SERVER = '198.51.100.10';

/** A branch with a fast main link and a slow serial backup to HQ, and no route on either router. */
export const ccna2FloatingStatic: ScenarioInfo = {
  name: 'ccna2-floating-static',
  category: 'ccna2-lab',
  labType: 'build',
  course: 'CCNA 2',
  topic: 'Static routing',
  title: 'A default route with a backup that waits',
  description:
    'A branch reaches headquarters over a fast Ethernet link and has a slow serial link that nobody uses. Send the branch traffic to HQ with a default route, route the replies back, and give both routes a floating backup over the serial link.',
  objectives: [
    'Send every unknown destination to one neighbour with a default route',
    'Write a floating static route whose higher distance keeps it out of the table while the main route works',
    'Predict which route a router installs when two routes lead to the same network',
    'Prove that the backup takes over when the main link goes down',
  ],
  tags: ['static routing', 'default route', 'floating static route', 'administrative distance', 'backup link'],
  difficulty: 2,
  estimatedMinutes: 20,
  requires: [PC, ROUTER, SERVER],
  seed: 231,
  instructions: [
    '## What you have',
    '',
    `The branch router R1 serves PC1 in \`192.168.10.0/24\`. HQ router R2 serves the server SRV (\`${FLOATING_SERVER}\`) in \`198.51.100.0/24\`. The two routers share a fast Ethernet link (\`10.0.0.0/30\`, R1 \`.1\`, R2 \`.2\`) and a slow serial link (\`10.0.0.4/30\`, R1 \`.5\`, R2 \`.6\`). Neither router has a route to the other side.`,
    '',
    '## What to do',
    '',
    '- On R1, add a **default route** (`0.0.0.0 0.0.0.0`) through R2 on the Ethernet link. The branch sends everything it does not know to HQ.',
    '- On R2, add a route back to `192.168.10.0/24` through R1 on the Ethernet link.',
    `- On both routers, add the same route again through the serial link, with an administrative distance of **${FLOATING_DISTANCE}**. Look at \`show ip route\`: only the Ethernet routes are there, because the lower distance wins.`,
    '- Ping SRV from PC1. Then shut `GigabitEthernet0/1` on R1, look at the routing tables again and ping once more: the serial routes have taken over.',
    '- Bring the Ethernet interface back up when you are done, and watch the main routes return.',
    '',
    '*A floating route is an ordinary static route with a worse distance: it floats above the table until the better route disappears.*',
  ].join('\n'),
  build: () =>
    topology(
      231,
      [
        device('pc1', PC, 'PC1', 90, 300, pcConfig('PC1', '192.168.10.10', MASK24, '192.168.10.1')),
        device(
          'r1',
          ROUTER,
          'R1',
          300,
          260,
          routerText('R1', [
            { port: 'GigabitEthernet0/0', lines: [`ip address 192.168.10.1 ${MASK24}`] },
            { port: 'GigabitEthernet0/1', lines: [`ip address 10.0.0.1 ${MASK30}`] },
            { port: 'Serial0/0/0', lines: [`ip address 10.0.0.5 ${MASK30}`, CLOCK] },
          ]),
        ),
        device(
          'r2',
          ROUTER,
          'R2',
          560,
          260,
          routerText('R2', [
            { port: 'GigabitEthernet0/0', lines: [`ip address 10.0.0.2 ${MASK30}`] },
            { port: 'Serial0/0/0', lines: [`ip address 10.0.0.6 ${MASK30}`] },
            { port: 'GigabitEthernet0/1', lines: [`ip address 198.51.100.1 ${MASK24}`] },
          ]),
        ),
        device('srv', SERVER, 'SRV', 770, 300, pcConfig('SRV', FLOATING_SERVER, MASK24, '198.51.100.1')),
      ],
      [
        link('l_pc1_r1', 'pc1', 'GigabitEthernet0', 'r1', 'GigabitEthernet0/0'),
        link('l_main', 'r1', 'GigabitEthernet0/1', 'r2', 'GigabitEthernet0/0'),
        cable('l_backup', 'r1', 'Serial0/0/0', 'r2', 'Serial0/0/0', 'serial-dce'),
        link('l_r2_srv', 'r2', 'GigabitEthernet0/1', 'srv', 'GigabitEthernet0'),
      ],
      ['Send the branch traffic to HQ with a default route', 'Route the replies back to the branch', 'Keep a floating backup on both routers'],
      'Two routes to one destination: the router installs the one with the lower administrative distance and keeps the other waiting.',
      { profile: 'P2' },
    ),
  tasks: [
    {
      id: 'default-route',
      title: 'Send the branch traffic to HQ',
      description: 'R1 has a default route through 10.0.0.2 with the distance of an ordinary static route, and uses it for any destination.',
      points: 20,
      hint: 'A default route matches every destination: network 0.0.0.0 with mask 0.0.0.0.',
      assertions: [
        { kind: 'route', device: 'R1', destination: FLOATING_SERVER, source: 'S', network: '0.0.0.0/0', nextHop: '10.0.0.2', ad: 1 },
        { kind: 'route', device: 'R1', destination: '192.0.2.77', network: '0.0.0.0/0' },
      ],
      feedbackOnFail: 'A route to the server network alone is not a default route: an address the branch has never heard of must match too.',
    },
    {
      id: 'return-route',
      title: 'Route the replies back',
      description: 'R2 reaches 192.168.10.0/24 through 10.0.0.1 with the distance of an ordinary static route.',
      points: 15,
      assertions: [{ kind: 'route', device: 'R2', destination: '192.168.10.10', source: 'S', network: '192.168.10.0/24', nextHop: '10.0.0.1', ad: 1 }],
    },
    {
      id: 'main-path',
      title: 'The branch reaches HQ',
      description: 'PC1 gets replies from SRV over the Ethernet link.',
      points: 20,
      dependsOn: ['default-route', 'return-route'],
      assertions: [
        {
          kind: 'connectivity',
          from: 'PC1',
          to: 'SRV',
          expect: 'success',
          // over the Ethernet link: both directions follow the distance-1 routes through the Ethernet next hops
          then: [
            { kind: 'route', device: 'R1', destination: FLOATING_SERVER, network: '0.0.0.0/0', nextHop: '10.0.0.2', ad: 1 },
            { kind: 'route', device: 'R2', destination: '192.168.10.10', nextHop: '10.0.0.1', ad: 1 },
          ],
        },
      ],
      feedbackOnFail: 'The main path is the Ethernet link: the routes through it need the distance of an ordinary static route.',
    },
    {
      id: 'floating-backup',
      title: 'The backup takes over',
      description: `While the Ethernet link works both routers use their distance-1 routes over it; with R1's GigabitEthernet0/1 shut, both install their serial routes (distance ${FLOATING_DISTANCE}) and PC1 still reaches SRV.`,
      points: 45,
      dependsOn: ['main-path'],
      hint: `Add each route a second time through the serial link, with the distance ${FLOATING_DISTANCE} at the end of the line.`,
      assertions: [
        // while the Ethernet link works the distance-1 routes are the ones installed: the serial routes only float
        { kind: 'route', device: 'R1', destination: FLOATING_SERVER, network: '0.0.0.0/0', iface: 'GigabitEthernet0/1', ad: 1 },
        { kind: 'route', device: 'R2', destination: '192.168.10.10', network: '192.168.10.0/24', iface: 'GigabitEthernet0/0', ad: 1 },
        {
          kind: 'connectivity',
          from: 'PC1',
          to: 'SRV',
          expect: 'success',
          after: [{ shutdown: { device: 'R1', port: 'GigabitEthernet0/1' } }],
          then: [
            { kind: 'route', device: 'R1', destination: FLOATING_SERVER, network: '0.0.0.0/0', iface: 'Serial0/0/0', ad: FLOATING_DISTANCE },
            { kind: 'route', device: 'R2', destination: '192.168.10.10', network: '192.168.10.0/24', iface: 'Serial0/0/0', ad: FLOATING_DISTANCE },
          ],
        },
      ],
      feedbackOnFail: `A backup needs a route in each direction, and a distance of ${FLOATING_DISTANCE}: with the same distance as the main route both would be used at once.`,
    },
  ],
  solution: {
    R1: ['ip route 0.0.0.0 0.0.0.0 10.0.0.2', `ip route 0.0.0.0 0.0.0.0 10.0.0.6 ${FLOATING_DISTANCE}`],
    R2: [`ip route 192.168.10.0 ${MASK24} 10.0.0.1`, `ip route 192.168.10.0 ${MASK24} 10.0.0.5 ${FLOATING_DISTANCE}`],
  },
};

// ── IPv6 static routes ──────────────────────────────────────────────────────

/** Link-local address R1 carries on the transit link (a fixed one is easier to read than one built from a MAC). */
export const IPV6_STATIC_R1_LINK_LOCAL = 'fe80::1';
/** Link-local address R2 carries on the transit link. */
export const IPV6_STATIC_R2_LINK_LOCAL = 'fe80::2';

/** A dual-stack branch (R1) and HQ (R2) whose IPv4 routes work and whose IPv6 routes are missing. */
export const ccna2Ipv6Static: ScenarioInfo = {
  name: 'ccna2-ipv6-static',
  category: 'ccna2-lab',
  labType: 'build',
  course: 'CCNA 2',
  topic: 'Static routing',
  title: 'Static routes for IPv6',
  description:
    'Two routers already route IPv4 between their LANs, and their hosts already have IPv6 addresses, but no IPv6 packet crosses the transit link. Write the IPv6 routes: a default route to a global next hop, and a return route to a link-local next hop.',
  objectives: [
    'Write an IPv6 default route to a global next-hop address',
    'Write an IPv6 static route to a link-local next hop, and explain why it needs its exit interface',
    'Read the IPv6 routing table next to the IPv4 one on a dual-stack router',
  ],
  tags: ['ipv6', 'static routing', 'link-local', 'default route', 'dual stack'],
  difficulty: 2,
  estimatedMinutes: 20,
  requires: [PC, ROUTER],
  seed: 232,
  instructions: [
    '## What you have',
    '',
    'Branch router R1 serves PC1 (`192.168.1.0/24` and `2001:db8:1::/64`); HQ router R2 serves PC2 (`192.168.2.0/24` and `2001:db8:2::/64`). They share the transit link `10.0.12.0/30` and `2001:db8:12::/64`, where R1 is `::1` and R2 is `::2`.',
    '',
    `Both routers forward IPv6 and advertise their LAN prefixes, so each PC has built its own IPv6 address. On the transit link the routers also carry the short link-local addresses \`${IPV6_STATIC_R1_LINK_LOCAL}\` (R1) and \`${IPV6_STATIC_R2_LINK_LOCAL}\` (R2). The IPv4 routes are in place; there is no IPv6 static route yet.`,
    '',
    '## What to do',
    '',
    '- On R1, add an IPv6 **default route** (`::/0`) to the global address of R2 on the transit link.',
    `- On R2, add a route to \`2001:db8:1::/64\` whose next hop is the **link-local** address of R1 (\`${IPV6_STATIC_R1_LINK_LOCAL}\`). The same link-local address can exist on every link of a router, so this form of route must also name its exit interface, \`GigabitEthernet0/0\`.`,
    '- Compare `show ipv6 route` with `show ip route` on each router.',
    '- Run `ipv6config` on PC2 to read its address, then `ping -6` it from PC1. Ping over IPv4 too: both families now cross the link.',
    '',
    '*A link-local next hop means something only together with its exit interface: without the interface a router cannot use the route.*',
  ].join('\n'),
  build: () =>
    topology(
      232,
      [
        device('pc1', PC, 'PC1', 90, 300, dualStackHost('PC1', '192.168.1.10', '192.168.1.1')),
        device(
          'r1',
          ROUTER,
          'R1',
          300,
          200,
          routerText(
            'R1',
            [
              { port: 'GigabitEthernet0/0', lines: [`ip address 192.168.1.1 ${MASK24}`, 'ipv6 address 2001:db8:1::1/64'] },
              {
                port: 'GigabitEthernet0/1',
                lines: [`ip address 10.0.12.1 ${MASK30}`, 'ipv6 address 2001:db8:12::1/64', `ipv6 address ${IPV6_STATIC_R1_LINK_LOCAL} link-local`],
              },
            ],
            ['ip route 0.0.0.0 0.0.0.0 10.0.12.2'],
            ['ipv6 unicast-routing'],
          ),
        ),
        device(
          'r2',
          ROUTER,
          'R2',
          560,
          200,
          routerText(
            'R2',
            [
              {
                port: 'GigabitEthernet0/0',
                lines: [`ip address 10.0.12.2 ${MASK30}`, 'ipv6 address 2001:db8:12::2/64', `ipv6 address ${IPV6_STATIC_R2_LINK_LOCAL} link-local`],
              },
              { port: 'GigabitEthernet0/1', lines: [`ip address 192.168.2.1 ${MASK24}`, 'ipv6 address 2001:db8:2::1/64'] },
            ],
            [`ip route 192.168.1.0 ${MASK24} 10.0.12.1`],
            ['ipv6 unicast-routing'],
          ),
        ),
        device('pc2', PC, 'PC2', 770, 300, dualStackHost('PC2', '192.168.2.10', '192.168.2.1')),
      ],
      [
        link('l_pc1_r1', 'pc1', 'GigabitEthernet0', 'r1', 'GigabitEthernet0/0'),
        link('l_r1_r2', 'r1', 'GigabitEthernet0/1', 'r2', 'GigabitEthernet0/0'),
        link('l_r2_pc2', 'r2', 'GigabitEthernet0/1', 'pc2', 'GigabitEthernet0'),
      ],
      ['Give the branch an IPv6 default route', 'Route IPv6 back through a link-local next hop', 'Ping across in both address families'],
      'An IPv6 static route names a global next hop, or a link-local next hop together with the interface it lives on.',
      { profile: 'P2' },
    ),
  tasks: [
    {
      id: 'ipv6-default',
      title: 'An IPv6 default route on the branch',
      description: 'R1 sends every IPv6 destination it does not know to 2001:db8:12::2.',
      points: 25,
      hint: 'The IPv6 default route is written ::/0.',
      assertions: [
        { kind: 'route', device: 'R1', family: 6, destination: '2001:db8:2::10', source: 'S', network: '::/0', nextHop: '2001:db8:12::2' },
        { kind: 'route', device: 'R1', family: 6, destination: '2001:db8:77::1', network: '::/0' },
      ],
    },
    {
      id: 'link-local-next-hop',
      title: 'A route to a link-local next hop',
      description: `R2 reaches 2001:db8:1::/64 through ${IPV6_STATIC_R1_LINK_LOCAL} out GigabitEthernet0/0.`,
      points: 30,
      hint: 'Name the interface first, then the link-local address.',
      assertions: [
        {
          kind: 'route',
          device: 'R2',
          family: 6,
          destination: '2001:db8:1::10',
          source: 'S',
          network: '2001:db8:1::/64',
          nextHop: IPV6_STATIC_R1_LINK_LOCAL,
          iface: 'GigabitEthernet0/0',
        },
      ],
      feedbackOnFail: 'A link-local next hop is valid only on one link, so the route has to say which interface that link is on.',
    },
    {
      id: 'both-families',
      title: 'Both address families cross',
      description: 'PC1 and PC2 reach each other over IPv6, and IPv4 still works.',
      points: 45,
      dependsOn: ['ipv6-default', 'link-local-next-hop'],
      assertions: [
        { kind: 'connectivity', from: 'PC1', to: 'PC2', family: 6, expect: 'success' },
        { kind: 'connectivity', from: 'PC2', to: 'PC1', family: 6, expect: 'success' },
        { kind: 'connectivity', from: 'PC1', to: 'PC2', expect: 'success' },
      ],
      feedbackOnFail: 'An IPv6 reply needs its own route back: the default route on R1 carries only the requests.',
    },
  ],
  solution: {
    R1: ['ipv6 route ::/0 2001:db8:12::2'],
    R2: [`ipv6 route 2001:db8:1::/64 GigabitEthernet0/0 ${IPV6_STATIC_R1_LINK_LOCAL}`],
  },
};

/** The static routing labs, in course order. */
export const CCNA2_ROUTING_LABS: readonly ScenarioInfo[] = [ccna2StaticRoutes, ccna2FloatingStatic, ccna2Ipv6Static];
