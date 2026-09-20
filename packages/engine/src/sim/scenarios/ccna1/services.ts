/**
 * sim/scenarios/ccna1/services.ts — the CCNA 1 address and application service labs (ARCHITECTURE-P1 §4.3, §4.4,
 * §4.5, §4.13, §8.2 W6).
 *
 *   • `ccna1-dhcpv4-server` — a router leases addresses to its own LAN (pool, excluded range, options).
 *   • `ccna1-dhcp-relay`    — the server sits one subnet away, so the router relays the broadcasts.
 *   • `ccna1-dns-records`   — a server answers name lookups; a host is told which server to ask.
 *   • `ccna1-web-server`    — the same server publishes a page that a host fetches by name.
 *
 * The services are configured where the course configures them: a router through its CLI, a server through the
 * `service …` lines of the host shell. All wording is our own (§1.6).
 *
 * ponytail: grading reads the daemons and the configuration, never a fetch — `hostRequest` belongs to the browser
 * panel, and a lab check may not drive the live simulation. A name that resolves and answers a ping proves the path
 * the fetch would take.
 */
import type { ScenarioInfo } from '../../../contracts/scenario.js';
import { MASK24, MASK30, PC, ROUTER, SERVER, SWITCH, configText, device, link, section, topology } from '../kit.js';
import { pcConfig, routerConfig } from '../templates.js';
import { bareHost } from './foundations.js';

/** Startup config of a server: hostname and a static address on its first adapter. */
function serverConfig(hostname: string, address: string, mask: string, gateway?: string): string {
  const sections: string[][] = [[`hostname ${hostname}`], section('interface GigabitEthernet0', [`ip address ${address} ${mask}`])];
  if (gateway !== undefined) sections.push([`ip default-gateway ${gateway}`]);
  return configText(sections);
}

/** Domain the service labs hand out and resolve in. */
export const LAB_DOMAIN = 'lab.nf';
/** Name the DNS and web labs publish. */
export const LAB_WEB_NAME = `www.${LAB_DOMAIN}`;
/** Second name the DNS lab publishes. */
export const LAB_FILES_NAME = `files.${LAB_DOMAIN}`;

// ── DHCP server on the router ───────────────────────────────────────────────

/** Address pool name the reference solution writes. */
export const DHCP_POOL_NAME = 'LAN15';

/** Two hosts with no address at all and a router that does not lease yet. */
export const ccna1DhcpServer: ScenarioInfo = {
  name: 'ccna1-dhcpv4-server',
  category: 'ccna1-lab',
  labType: 'guided',
  course: 'CCNA 1',
  topic: 'Address services',
  title: 'Lease addresses with DHCP',
  description: 'Stop typing addresses by hand: set up an address pool on the router, keep the infrastructure addresses out of it and let both hosts ask for a lease.',
  objectives: [
    'Reserve the addresses a pool must never hand out',
    'Define a pool with its network, gateway and domain',
    'Ask for an address from a host and read the lease it got',
    'Follow the four messages that make up an address request',
  ],
  tags: ['dhcp', 'pool', 'lease', 'excluded addresses'],
  difficulty: 2,
  estimatedMinutes: 25,
  requires: [PC, SWITCH, ROUTER],
  seed: 108,
  instructions: [
    '## What you have',
    '',
    'R1 already carries `192.168.15.1/24` on the LAN. PC1 and PC2 have no address.',
    '',
    '## What to do',
    '',
    '- Reserve `192.168.15.1` to `192.168.15.10` so the pool never hands them out.',
    `- Create the pool \`${DHCP_POOL_NAME}\` for network \`192.168.15.0/24\`, with the router as the default gateway and \`${LAB_DOMAIN}\` as the domain name.`,
    '- On each PC, ask for an address with the DHCP form of the address command.',
    '- Check the lease with `ipconfig /all` and the bindings on the router.',
  ].join('\n'),
  build: () =>
    topology(
      108,
      [
        device('pc1', PC, 'PC1', 120, 340, bareHost('PC1')),
        device('pc2', PC, 'PC2', 280, 390, bareHost('PC2')),
        device('sw1', SWITCH, 'SW1', 300, 230),
        device('r1', ROUTER, 'R1', 500, 140, routerConfig('R1', [{ port: 'GigabitEthernet0/0', address: '192.168.15.1', mask: MASK24 }])),
      ],
      [
        link('l_pc1_sw1', 'pc1', 'GigabitEthernet0', 'sw1', 'FastEthernet0/1'),
        link('l_pc2_sw1', 'pc2', 'GigabitEthernet0', 'sw1', 'FastEthernet0/2'),
        link('l_sw1_r1', 'sw1', 'GigabitEthernet0/1', 'r1', 'GigabitEthernet0/0'),
      ],
      ['Build an address pool on the router', 'Let both hosts take a lease'],
      'A host with no address asks with a broadcast; the server offers one from its pool and remembers the binding.',
    ),
  tasks: [
    {
      id: 'excluded',
      title: 'Reserve the fixed addresses',
      description: 'The range 192.168.15.1 to 192.168.15.10 is excluded from leasing.',
      points: 10,
      hint: 'Exclusions are written before the pool, at the global level.',
      assertions: [{ kind: 'config', device: 'R1', path: 'ip.dhcp.excluded-address', equals: ['excluded-address', '192.168.15.1', '192.168.15.10'] }],
    },
    {
      id: 'pool',
      title: 'Define the pool',
      description: `Pool ${DHCP_POOL_NAME} serves 192.168.15.0/24 with the router as default gateway.`,
      points: 20,
      assertions: [
        { kind: 'config', device: 'R1', path: `ip.dhcp.pool.${DHCP_POOL_NAME}.network`, equals: ['192.168.15.0', MASK24] },
        { kind: 'config', device: 'R1', path: `ip.dhcp.pool.${DHCP_POOL_NAME}.default-router`, equals: '192.168.15.1' },
        { kind: 'config', device: 'R1', path: `ip.dhcp.pool.${DHCP_POOL_NAME}.domain-name`, equals: LAB_DOMAIN },
      ],
    },
    {
      id: 'leases',
      title: 'Both hosts take a lease',
      description: 'PC1 and PC2 are bound to leases the router recorded, and the exchange is visible in the trace.',
      points: 25,
      dependsOn: ['pool'],
      assertions: [
        { kind: 'process', device: 'PC1', process: 'dhcp-client', path: 'clients.iface=GigabitEthernet0.state', equals: 'BOUND' },
        { kind: 'process', device: 'PC2', process: 'dhcp-client', path: 'clients.iface=GigabitEthernet0.state', equals: 'BOUND' },
        { kind: 'table', device: 'R1', table: 'dhcp-bindings', where: { pool: DHCP_POOL_NAME, state: 'bound', hostname: 'PC1' }, exists: true },
        { kind: 'table', device: 'R1', table: 'dhcp-bindings', where: { pool: DHCP_POOL_NAME, state: 'bound', hostname: 'PC2' }, exists: true },
        { kind: 'traceSeen', filter: { kinds: ['frameTx'], protos: ['dhcp'] }, min: 4 },
      ],
      feedbackOnFail: 'A host only asks for a lease once its adapter is set to DHCP, and it only gets one if the pool covers the subnet it is on.',
    },
    {
      id: 'reachable',
      title: 'The leased addresses work',
      description: 'PC1 reaches the router and PC2 with the address it was given.',
      points: 20,
      dependsOn: ['leases'],
      assertions: [
        { kind: 'connectivity', from: 'PC1', to: 'R1', expect: 'success' },
        { kind: 'connectivity', from: 'PC1', to: 'PC2', expect: 'success' },
      ],
    },
  ],
  solution: {
    R1: [
      'ip dhcp excluded-address 192.168.15.1 192.168.15.10',
      `ip dhcp pool ${DHCP_POOL_NAME}`,
      `network 192.168.15.0 ${MASK24}`,
      'default-router 192.168.15.1',
      'dns-server 192.168.15.1',
      `domain-name ${LAB_DOMAIN}`,
      'exit',
    ],
    PC1: ['ip address dhcp'],
    PC2: ['ip address dhcp'],
  },
};

// ── DHCP relay ──────────────────────────────────────────────────────────────

/** Pool name of the relay lab. */
export const RELAY_POOL_NAME = 'BRANCH16';

/** Hosts on one subnet, the address server on another: the router in between must relay. */
export const ccna1DhcpRelay: ScenarioInfo = {
  name: 'ccna1-dhcp-relay',
  category: 'ccna1-lab',
  labType: 'build',
  course: 'CCNA 1',
  topic: 'Address services',
  title: 'Relay DHCP to a central server',
  description: 'The address server lives in the data centre subnet, and broadcasts do not cross a router. Point the branch interface at the server and watch the requests arrive with the relay address filled in.',
  objectives: [
    'Explain why an address request stops at the first router',
    'Forward address requests to a server in another subnet',
    'Recognise the relay address the router adds to a forwarded request',
  ],
  tags: ['dhcp', 'relay', 'helper address', 'broadcast'],
  difficulty: 3,
  estimatedMinutes: 25,
  requires: [PC, SWITCH, ROUTER],
  seed: 109,
  instructions: [
    '## What you have',
    '',
    'PC1 and PC2 sit in the branch subnet `192.168.16.0/24` behind R1. R2 is the central router in `192.168.40.0/24`, reached over the `10.10.0.0/30` link. Both routers already have routes to each other.',
    '',
    '## What to do',
    '',
    `- On R2, reserve \`192.168.16.1\` to \`192.168.16.10\` and build the pool \`${RELAY_POOL_NAME}\` for \`192.168.16.0/24\` with default gateway \`192.168.16.1\`.`,
    '- On R1, forward address requests arriving on `GigabitEthernet0/0` to `10.10.0.2`.',
    '- Ask for a lease on both hosts and look at the bindings: each one records the address of the interface that relayed it.',
  ].join('\n'),
  build: () =>
    topology(
      109,
      [
        device('pc1', PC, 'PC1', 90, 340, bareHost('PC1')),
        device('pc2', PC, 'PC2', 240, 390, bareHost('PC2')),
        device('sw1', SWITCH, 'SW1', 260, 240),
        device('r1', ROUTER, 'R1', 440, 160, routerConfig('R1', [
          { port: 'GigabitEthernet0/0', address: '192.168.16.1', mask: MASK24 },
          { port: 'GigabitEthernet0/1', address: '10.10.0.1', mask: MASK30 },
        ], [`192.168.40.0 ${MASK24} 10.10.0.2`])),
        device('r2', ROUTER, 'R2', 660, 160, routerConfig('R2', [
          { port: 'GigabitEthernet0/0', address: '10.10.0.2', mask: MASK30 },
          { port: 'GigabitEthernet0/1', address: '192.168.40.1', mask: MASK24 },
        ], [`192.168.16.0 ${MASK24} 10.10.0.1`])),
      ],
      [
        link('l_pc1_sw1', 'pc1', 'GigabitEthernet0', 'sw1', 'FastEthernet0/1'),
        link('l_pc2_sw1', 'pc2', 'GigabitEthernet0', 'sw1', 'FastEthernet0/2'),
        link('l_sw1_r1', 'sw1', 'GigabitEthernet0/1', 'r1', 'GigabitEthernet0/0'),
        link('l_r1_r2', 'r1', 'GigabitEthernet0/1', 'r2', 'GigabitEthernet0/0'),
      ],
      ['Build the branch pool on the central router', 'Relay the requests from the branch interface'],
      'A relayed request keeps the client hardware address but gains the address of the interface that forwarded it, which is how the server picks the right pool.',
    ),
  tasks: [
    {
      id: 'central-pool',
      title: 'Build the branch pool centrally',
      description: `R2 holds the pool ${RELAY_POOL_NAME} for the branch subnet, with its exclusions.`,
      points: 20,
      assertions: [
        { kind: 'config', device: 'R2', path: `ip.dhcp.pool.${RELAY_POOL_NAME}.network`, equals: ['192.168.16.0', MASK24] },
        { kind: 'config', device: 'R2', path: `ip.dhcp.pool.${RELAY_POOL_NAME}.default-router`, equals: '192.168.16.1' },
        { kind: 'config', device: 'R2', path: 'ip.dhcp.excluded-address', equals: ['excluded-address', '192.168.16.1', '192.168.16.10'] },
      ],
    },
    {
      id: 'helper',
      title: 'Forward the requests',
      description: 'The branch interface of R1 forwards address requests to 10.10.0.2.',
      points: 20,
      hint: 'The forwarding address belongs on the interface the clients are on.',
      assertions: [{ kind: 'config', device: 'R1', path: 'interface.GigabitEthernet0/0.ip.helper-address', equals: '10.10.0.2' }],
    },
    {
      id: 'relayed-leases',
      title: 'Leases arrive through the relay',
      description: 'Both hosts are bound, and R2 records bindings stamped with the relay address.',
      points: 30,
      dependsOn: ['central-pool', 'helper'],
      assertions: [
        { kind: 'process', device: 'PC1', process: 'dhcp-client', path: 'clients.iface=GigabitEthernet0.state', equals: 'BOUND' },
        { kind: 'process', device: 'PC2', process: 'dhcp-client', path: 'clients.iface=GigabitEthernet0.state', equals: 'BOUND' },
        { kind: 'table', device: 'R2', table: 'dhcp-bindings', where: { pool: RELAY_POOL_NAME, state: 'bound', relay: '192.168.16.1' }, exists: true },
      ],
      feedbackOnFail: 'Without a forwarding address the request dies at R1: a broadcast is never routed.',
    },
    {
      id: 'reachable',
      title: 'The branch reaches the centre',
      description: 'PC1 reaches the central router with its leased address.',
      points: 15,
      dependsOn: ['relayed-leases'],
      assertions: [{ kind: 'connectivity', from: 'PC1', to: 'R2', expect: 'success' }],
    },
  ],
  solution: {
    R2: [
      'ip dhcp excluded-address 192.168.16.1 192.168.16.10',
      `ip dhcp pool ${RELAY_POOL_NAME}`,
      `network 192.168.16.0 ${MASK24}`,
      'default-router 192.168.16.1',
      `domain-name ${LAB_DOMAIN}`,
      'exit',
    ],
    R1: ['interface GigabitEthernet0/0', 'ip helper-address 10.10.0.2', 'exit'],
    PC1: ['ip address dhcp'],
    PC2: ['ip address dhcp'],
  },
};

// ── DNS records ─────────────────────────────────────────────────────────────

/** A name server with no zone and a host that does not know where to ask. */
export const ccna1DnsRecords: ScenarioInfo = {
  name: 'ccna1-dns-records',
  category: 'ccna1-lab',
  labType: 'guided',
  course: 'CCNA 1',
  topic: 'Application layer',
  title: 'Names instead of addresses',
  description: 'Two servers answer at their addresses but have no names. Publish the records on the name server, point the host at it and reach both servers by name.',
  objectives: [
    'Switch on a name service and publish address records',
    'Tell a host which server resolves names for it',
    'Follow a lookup from question to answer before the traffic starts',
  ],
  tags: ['dns', 'records', 'name resolution', 'servers'],
  difficulty: 2,
  estimatedMinutes: 20,
  requires: [PC, SWITCH, SERVER],
  seed: 110,
  instructions: [
    '## What you have',
    '',
    `SRV1 (\`192.168.25.53\`) will be the name server, SRV2 (\`192.168.25.60\`) the file server, PC1 (\`192.168.25.10\`) the client. All three are in one subnet.`,
    '',
    '## What to do',
    '',
    '- On SRV1, switch the name service on.',
    `- Publish \`${LAB_WEB_NAME}\` for \`192.168.25.53\` and \`${LAB_FILES_NAME}\` for \`192.168.25.60\`, both as address records.`,
    '- On PC1, set `192.168.25.53` as the name server.',
    `- Look a name up with \`nslookup ${LAB_FILES_NAME}\`, then ping it.`,
  ].join('\n'),
  build: () =>
    topology(
      110,
      [
        device('pc1', PC, 'PC1', 120, 340, pcConfig('PC1', '192.168.25.10', MASK24)),
        device('sw1', SWITCH, 'SW1', 320, 230),
        device('srv1', SERVER, 'SRV1', 520, 150, serverConfig('SRV1', '192.168.25.53', MASK24)),
        device('srv2', SERVER, 'SRV2', 520, 340, serverConfig('SRV2', '192.168.25.60', MASK24)),
      ],
      [
        link('l_pc1_sw1', 'pc1', 'GigabitEthernet0', 'sw1', 'FastEthernet0/1'),
        link('l_srv1_sw1', 'srv1', 'GigabitEthernet0', 'sw1', 'FastEthernet0/2'),
        link('l_srv2_sw1', 'srv2', 'GigabitEthernet0', 'sw1', 'FastEthernet0/3'),
      ],
      ['Publish two address records', 'Reach a server by name'],
      'A name server keeps a small table of names and addresses; a client that knows no server cannot resolve anything.',
    ),
  tasks: [
    {
      id: 'service-on',
      title: 'Start the name service',
      description: 'SRV1 answers name lookups.',
      points: 15,
      assertions: [
        { kind: 'process', device: 'SRV1', process: 'dns-server', path: 'enabled', equals: true },
        { kind: 'table', device: 'SRV1', table: 'sockets', where: { proto: 'udp', localPort: 53 }, exists: true },
      ],
    },
    {
      id: 'records',
      title: 'Publish both names',
      description: 'The zone holds address records for the web server and the file server.',
      points: 25,
      assertions: [
        { kind: 'config', device: 'SRV1', path: 'ip.dns.record', contains: `${LAB_WEB_NAME} A 192.168.25.53` },
        { kind: 'config', device: 'SRV1', path: 'ip.dns.record', contains: `${LAB_FILES_NAME} A 192.168.25.60` },
      ],
    },
    {
      id: 'client',
      title: 'Point the client at the server',
      description: 'PC1 asks 192.168.25.53 to resolve names.',
      points: 15,
      assertions: [{ kind: 'config', device: 'PC1', path: 'ip.name-server', contains: '192.168.25.53' }],
    },
    {
      id: 'resolve',
      title: 'Reach both servers by name',
      description: 'PC1 resolves and pings both published names.',
      points: 25,
      dependsOn: ['service-on', 'records', 'client'],
      assertions: [
        { kind: 'connectivity', from: 'PC1', to: LAB_WEB_NAME, byName: true, expect: 'success' },
        { kind: 'connectivity', from: 'PC1', to: LAB_FILES_NAME, byName: true, expect: 'success' },
      ],
      feedbackOnFail: 'A name is resolved before the first packet leaves: no server, no answer, no traffic.',
    },
  ],
  solution: {
    SRV1: [
      'service dns on',
      `service dns record ${LAB_WEB_NAME} A 192.168.25.53 3600`,
      `service dns record ${LAB_FILES_NAME} A 192.168.25.60 3600`,
    ],
    PC1: ['ip dns 192.168.25.53'],
  },
};

// ── web server ──────────────────────────────────────────────────────────────

/** Path the web lab publishes. */
export const LAB_WEB_PATH = '/index.html';

/** A server that holds no page yet and a client that cannot resolve its name. */
export const ccna1WebServer: ScenarioInfo = {
  name: 'ccna1-web-server',
  category: 'ccna1-lab',
  labType: 'guided',
  course: 'CCNA 1',
  topic: 'Application layer',
  title: 'Publish a web page',
  description: 'Turn a plain server into a web server: publish a page, give it a name and open it from the browser of a workstation.',
  objectives: [
    'Start a web service and give one path a page',
    'See the listening socket a service opens',
    'Reach a service by name rather than by address',
    'Follow a page request from the name lookup to the answer',
  ],
  tags: ['http', 'web server', 'dns', 'tcp', 'sockets'],
  difficulty: 2,
  estimatedMinutes: 20,
  requires: [PC, SWITCH, SERVER],
  seed: 111,
  instructions: [
    '## What you have',
    '',
    'SRV1 (`192.168.26.80`) and PC1 (`192.168.26.10`) share one subnet. Nothing is published and PC1 knows no name server.',
    '',
    '## What to do',
    '',
    '- On SRV1, switch the name service and the web service on.',
    `- Publish \`${LAB_WEB_NAME}\` for \`192.168.26.80\` and put a short text at \`${LAB_WEB_PATH}\`.`,
    '- On PC1, set `192.168.26.80` as the name server.',
    `- Open \`http://${LAB_WEB_NAME}${LAB_WEB_PATH}\` from the browser of PC1 and watch the lookup, the connection and the answer.`,
  ].join('\n'),
  build: () =>
    topology(
      111,
      [
        device('pc1', PC, 'PC1', 120, 340, pcConfig('PC1', '192.168.26.10', MASK24)),
        device('sw1', SWITCH, 'SW1', 320, 230),
        device('srv1', SERVER, 'SRV1', 520, 230, serverConfig('SRV1', '192.168.26.80', MASK24)),
      ],
      [link('l_pc1_sw1', 'pc1', 'GigabitEthernet0', 'sw1', 'FastEthernet0/1'), link('l_srv1_sw1', 'srv1', 'GigabitEthernet0', 'sw1', 'FastEthernet0/2')],
      ['Publish a page and a name', 'Fetch the page from the workstation'],
      'A web service listens on a well-known port; the browser finds it by name first and then opens a connection to that port.',
    ),
  tasks: [
    {
      id: 'web-service',
      title: 'Start the web service',
      description: 'SRV1 answers web requests and listens on the web port.',
      points: 20,
      assertions: [
        { kind: 'process', device: 'SRV1', process: 'http-server', path: 'enabled', equals: true },
        { kind: 'table', device: 'SRV1', table: 'sockets', where: { proto: 'tcp', localPort: 80, state: 'LISTEN' }, exists: true },
      ],
    },
    {
      id: 'page',
      title: 'Publish the page',
      description: `The server holds a page at ${LAB_WEB_PATH}.`,
      points: 20,
      assertions: [
        { kind: 'process', device: 'SRV1', process: 'http-server', path: 'pages.0.path', equals: LAB_WEB_PATH },
        { kind: 'config', device: 'SRV1', path: 'ip.http.page', contains: LAB_WEB_PATH },
      ],
    },
    {
      id: 'name',
      title: 'Give the server a name',
      description: `The name service answers for ${LAB_WEB_NAME}, and PC1 knows which server to ask.`,
      points: 25,
      assertions: [
        { kind: 'process', device: 'SRV1', process: 'dns-server', path: 'enabled', equals: true },
        { kind: 'config', device: 'SRV1', path: 'ip.dns.record', contains: `${LAB_WEB_NAME} A 192.168.26.80` },
        { kind: 'config', device: 'PC1', path: 'ip.name-server', contains: '192.168.26.80' },
      ],
    },
    {
      id: 'reachable',
      title: 'Reach the site by name',
      description: 'PC1 resolves the site name and reaches the server behind it.',
      points: 20,
      dependsOn: ['web-service', 'name'],
      assertions: [{ kind: 'connectivity', from: 'PC1', to: LAB_WEB_NAME, byName: true, expect: 'success' }],
    },
  ],
  solution: {
    SRV1: [
      'service dns on',
      `service dns record ${LAB_WEB_NAME} A 192.168.26.80 3600`,
      'service http on',
      `service http page ${LAB_WEB_PATH} This page is served by the practice web server.`,
    ],
    PC1: ['ip dns 192.168.26.80'],
  },
};
