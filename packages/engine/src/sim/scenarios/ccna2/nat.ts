/**
 * sim/scenarios/ccna2/nat.ts — the CCNA 2 address translation lab (ARCHITECTURE-P2 §11.1, §11.2, D14, §3.9).
 *
 *   • `ccna2-nat-pat` — lesson 33 "Address translation" (module "Translation and fault finding"): one office LAN
 *     behind an edge router, translated four ways at once — a static translation that publishes the mail server,
 *     PAT that lets the office desks share the router's outside address, a dynamic pool that lends each test-bench
 *     host a public address of its own, and ([SHOULD S9]) a port forward that sends TCP 8080 of the outside address
 *     to the web server's port 80.
 *
 * The world is P2-profile (`topology(…, { profile: 'P2' })`); the lesson is not about spanning tree, so every port of
 * the office switch faces a host or the router and is an edge port (`spanning-tree portfast`) in its startup
 * configuration (§11.2). The provider router ISP knows only public networks, and the internet server EXT answers
 * through it: a reply addressed to a private address dies at ISP (no route), so every successful ping from the
 * office to EXT PROVES that R1 translated it. The grader pings in its clone and reads the translation rows each ping
 * created there with `connectivity.then` (`nat` kind: inside local, inside global, kind); the static translation and
 * the port forward are rows the configuration writes by itself, read in the live world (`nat`, and `table` for the
 * two port numbers the `nat` kind does not carry). All addresses come from the private and documentation ranges;
 * all wording is original (§0 rule 6).
 *
 * A lab file imports only the contracts, `../kit.js` and `../templates.js` — never `./index.js`, `../index.js` or
 * the engine barrel — so the catalogue stays an acyclic graph of data modules (the arrays are read at module scope).
 *
 * ponytail: the two servers sit outside both access lists on purpose — MAIL (.100) is reached only through its
 * static line and WEB (.80) only through its port forward — so a missing or mistyped static line cannot hide behind
 * PAT. A connectivity check can only ping a device's own first address, so the port forward (TCP) is graded from its
 * row and the inbound half of the static translation from the static row; the student tests both from EXT by hand.
 */
import type { ScenarioInfo } from '../../../contracts/scenario.js';
import { MASK24, PC, ROUTER, SERVER, SWITCH, accessPort, configText, device, link, section, topology } from '../kit.js';
import { pcConfig } from '../templates.js';

/** R1's outside address: the one PAT shares and the port forward listens on. */
export const NAT_OUTSIDE_ADDRESS = '203.0.113.1';
/** The public address the mail server is published at. */
export const NAT_MAIL_GLOBAL = '203.0.113.100';
/** The mail server's own (inside local) address. */
export const NAT_MAIL_LOCAL = '192.168.1.100';
/** The web server behind the port forward. */
export const NAT_WEB_LOCAL = '192.168.1.80';
/** Outside port of the forward, and the web server's own port. */
export const NAT_FORWARD_PORT = 8080;
export const NAT_WEB_PORT = 80;
/** Name and range of the test-bench pool. */
export const NAT_POOL_NAME = 'BENCH';
export const NAT_POOL_FIRST = '203.0.113.20';
export const NAT_POOL_LAST = '203.0.113.23';
/** The internet server every check pings. */
export const NAT_EXT_ADDRESS = '198.51.100.10';

/** SW1: every port faces a host or the router, so every one is an edge port (the lesson is not about spanning tree). */
function officeSwitchConfig(): string {
  return configText([
    ['hostname SW1'],
    ...['FastEthernet0/1', 'FastEthernet0/2', 'FastEthernet0/3', 'FastEthernet0/4', 'FastEthernet0/5', 'GigabitEthernet0/1'].map((p) => accessPort(p, 1, { portfast: true })),
  ]);
}

/** R1 before the lab: both interfaces addressed and up, a default route to the provider, no translation at all. */
function edgeRouterConfig(): string {
  return configText([
    ['hostname R1'],
    section('interface GigabitEthernet0/0', [`ip address 192.168.1.1 ${MASK24}`, 'no shutdown']),
    section('interface GigabitEthernet0/1', [`ip address ${NAT_OUTSIDE_ADDRESS} ${MASK24}`, 'no shutdown']),
    ['ip route 0.0.0.0 0.0.0.0 203.0.113.254'],
  ]);
}

/** The provider router: the link to R1 and the internet LAN of EXT; it has no route to any private network. */
function providerConfig(): string {
  return configText([
    ['hostname ISP'],
    section('interface GigabitEthernet0/0', [`ip address 203.0.113.254 ${MASK24}`, 'no shutdown']),
    section('interface GigabitEthernet0/1', [`ip address 198.51.100.1 ${MASK24}`, 'no shutdown']),
  ]);
}

/** One office LAN, one public link and no translation yet. */
export const ccna2NatPat: ScenarioInfo = {
  name: 'ccna2-nat-pat',
  category: 'ccna2-lab',
  labType: 'guided',
  course: 'CCNA 2',
  topic: 'Translation and fault finding',
  title: 'Translate an office to the internet',
  description:
    'An office LAN uses private addresses, and the provider drops everything addressed to them. Translate it four ways on the edge router: publish the mail server, let the desks share one address, lend the test bench addresses from a pool, and forward a port to the web server.',
  objectives: [
    'Mark the inside and the outside of a translating router',
    'Publish one inside host at a fixed public address with static NAT',
    'Let many hosts share one address with port address translation',
    'Lend public addresses from a pool, one per inside host',
    'Forward one outside port to a server on the inside',
    'Read inside local, inside global and outside global addresses in the translation table',
  ],
  tags: ['nat', 'pat', 'overload', 'static nat', 'nat pool', 'port forwarding', 'access list'],
  difficulty: 3,
  estimatedMinutes: 30,
  requires: [PC, ROUTER, SERVER, SWITCH],
  seed: 233,
  instructions: [
    '## What you have',
    '',
    `The office LAN \`192.168.1.0/24\` sits behind the edge router R1. Its outside interface \`GigabitEthernet0/1\` carries the public address \`${NAT_OUTSIDE_ADDRESS}\` on the provider link \`203.0.113.0/24\`, and the whole of that block belongs to the office. EXT (\`${NAT_EXT_ADDRESS}\`) is a server on the internet, behind the provider router ISP, which knows no private network: until R1 translates, no office host gets a reply from EXT.`,
    '',
    '- PC1 (`.10`) and PC2 (`.11`) are office desks in the block `192.168.1.0/26`.',
    '- PC3 (`.70`) is the test bench, in the block `192.168.1.64/28`.',
    `- MAIL (\`.100\`) is the mail server; it must be reachable from outside at \`${NAT_MAIL_GLOBAL}\`.`,
    `- WEB (\`.80\`) is the web server; the outside must reach its port ${NAT_WEB_PORT} at \`${NAT_OUTSIDE_ADDRESS}\`, port ${NAT_FORWARD_PORT}.`,
    '',
    '## What to do',
    '',
    '- Mark `GigabitEthernet0/0` as the inside and `GigabitEthernet0/1` as the outside of the translation.',
    `- **Static NAT**: tie MAIL to \`${NAT_MAIL_GLOBAL}\` for good.`,
    '- **PAT**: match the office block with standard access list 1 and let it share the address of `GigabitEthernet0/1` (overload).',
    `- **Dynamic pool**: match the bench block with standard access list 2, create the pool \`${NAT_POOL_NAME}\` from \`${NAT_POOL_FIRST}\` to \`${NAT_POOL_LAST}\` (mask \`${MASK24}\`) and translate list 2 to it, one address per host (no overload).`,
    `- **Port forward**: send TCP port ${NAT_FORWARD_PORT} of \`GigabitEthernet0/1\` to port ${NAT_WEB_PORT} of WEB.`,
    '- Ping EXT from PC1, PC2, PC3 and MAIL, then read `show ip nat translations` on R1: which host borrowed which address, and which ports did PAT use?',
    '',
    '*A standard access list matches with a wildcard mask, the inverse of the subnet mask: a /26 block is `0.0.0.63`, a /28 block `0.0.0.15`.*',
  ].join('\n'),
  build: () =>
    topology(
      233,
      [
        device('pc1', PC, 'PC1', 80, 150, pcConfig('PC1', '192.168.1.10', MASK24, '192.168.1.1')),
        device('pc2', PC, 'PC2', 80, 270, pcConfig('PC2', '192.168.1.11', MASK24, '192.168.1.1')),
        device('pc3', PC, 'PC3', 80, 390, pcConfig('PC3', '192.168.1.70', MASK24, '192.168.1.1')),
        device('mail', SERVER, 'MAIL', 230, 470, pcConfig('MAIL', NAT_MAIL_LOCAL, MASK24, '192.168.1.1')),
        device('web', SERVER, 'WEB', 370, 470, pcConfig('WEB', NAT_WEB_LOCAL, MASK24, '192.168.1.1')),
        device('sw1', SWITCH, 'SW1', 280, 280, officeSwitchConfig()),
        device('r1', ROUTER, 'R1', 480, 280, edgeRouterConfig()),
        device('isp', ROUTER, 'ISP', 680, 280, providerConfig()),
        device('ext', SERVER, 'EXT', 860, 280, pcConfig('EXT', NAT_EXT_ADDRESS, MASK24, '198.51.100.1')),
      ],
      [
        link('l_pc1_sw1', 'pc1', 'GigabitEthernet0', 'sw1', 'FastEthernet0/1'),
        link('l_pc2_sw1', 'pc2', 'GigabitEthernet0', 'sw1', 'FastEthernet0/2'),
        link('l_pc3_sw1', 'pc3', 'GigabitEthernet0', 'sw1', 'FastEthernet0/3'),
        link('l_mail_sw1', 'mail', 'GigabitEthernet0', 'sw1', 'FastEthernet0/4'),
        link('l_web_sw1', 'web', 'GigabitEthernet0', 'sw1', 'FastEthernet0/5'),
        link('l_sw1_r1', 'sw1', 'GigabitEthernet0/1', 'r1', 'GigabitEthernet0/0'),
        link('l_r1_isp', 'r1', 'GigabitEthernet0/1', 'isp', 'GigabitEthernet0/0'),
        link('l_isp_ext', 'isp', 'GigabitEthernet0/1', 'ext', 'GigabitEthernet0'),
      ],
      ['Mark the inside and the outside', 'Translate with a static line, PAT and a pool', 'Forward one port to the web server'],
      'Inside local is the address a host really has, inside global the public address it appears as, outside global the address of the far host.',
      { profile: 'P2' },
    ),
  tasks: [
    {
      id: 'inside-outside',
      title: 'Mark the inside and the outside',
      description: 'GigabitEthernet0/0 is the inside of the translation and GigabitEthernet0/1 the outside.',
      points: 10,
      hint: 'Both are interface lines; nothing is translated until a packet crosses from an inside to an outside interface.',
      assertions: [
        { kind: 'config', device: 'R1', path: 'interface.GigabitEthernet0/0.ip.nat', equals: 'inside' },
        { kind: 'config', device: 'R1', path: 'interface.GigabitEthernet0/1.ip.nat', equals: 'outside' },
      ],
    },
    {
      id: 'static-nat',
      title: 'Publish the mail server',
      description: `MAIL is translated to ${NAT_MAIL_GLOBAL} by a static line, and reaches EXT with it.`,
      points: 20,
      dependsOn: ['inside-outside'],
      hint: 'A static line names the inside local address first, then the inside global one.',
      assertions: [
        { kind: 'nat', device: 'R1', insideLocal: NAT_MAIL_LOCAL, insideGlobal: NAT_MAIL_GLOBAL, kindOf: 'static' },
        { kind: 'connectivity', from: 'MAIL', to: 'EXT', expect: 'success' },
      ],
      feedbackOnFail: 'MAIL is in neither access list, so only its own static line can translate it.',
    },
    {
      id: 'pat',
      title: 'Share one address among the desks',
      description: `PC1 and PC2 reach EXT, both translated to ${NAT_OUTSIDE_ADDRESS} by overload rows.`,
      points: 25,
      dependsOn: ['inside-outside'],
      hint: 'Standard list 1 matches 192.168.1.0 with the wildcard 0.0.0.63; the rule names the outside interface and ends with overload.',
      assertions: [
        {
          kind: 'connectivity',
          from: 'PC1',
          to: 'EXT',
          expect: 'success',
          then: [{ kind: 'nat', device: 'R1', insideLocal: '192.168.1.10', insideGlobal: NAT_OUTSIDE_ADDRESS, proto: 'icmp', kindOf: 'overload' }],
        },
        {
          kind: 'connectivity',
          from: 'PC2',
          to: 'EXT',
          expect: 'success',
          then: [
            { kind: 'nat', device: 'R1', insideLocal: '192.168.1.11', insideGlobal: NAT_OUTSIDE_ADDRESS, proto: 'icmp', kindOf: 'overload' },
            { kind: 'nat', device: 'R1', insideGlobal: NAT_OUTSIDE_ADDRESS, kindOf: 'overload', minCount: 2 },
          ],
        },
      ],
      feedbackOnFail: 'Overload lets many hosts share one address: the router tells their flows apart by port (or ICMP id).',
    },
    {
      id: 'pool',
      title: 'Lend the bench an address from the pool',
      description: `PC3 reaches EXT through a dynamic row that lends it ${NAT_POOL_FIRST}, the first address of pool ${NAT_POOL_NAME}.`,
      points: 25,
      dependsOn: ['inside-outside'],
      hint: 'Standard list 2 matches 192.168.1.64 with the wildcard 0.0.0.15; the rule translates list 2 to the pool without overload.',
      assertions: [
        {
          kind: 'connectivity',
          from: 'PC3',
          to: 'EXT',
          expect: 'success',
          then: [{ kind: 'nat', device: 'R1', insideLocal: '192.168.1.70', insideGlobal: NAT_POOL_FIRST, kindOf: 'dynamic' }],
        },
      ],
      feedbackOnFail: 'Without overload a pool lends one whole address per host, the lowest free one first; a bench host that shares the outside address was matched by the office list instead.',
    },
    {
      id: 'port-forward',
      title: 'Forward a port to the web server',
      description: `TCP port ${NAT_FORWARD_PORT} of ${NAT_OUTSIDE_ADDRESS} leads to port ${NAT_WEB_PORT} of WEB.`,
      points: 20,
      dependsOn: ['inside-outside'],
      hint: 'A static line for TCP names the inside address and port, then the outside interface and port.',
      assertions: [
        { kind: 'nat', device: 'R1', insideLocal: NAT_WEB_LOCAL, insideGlobal: NAT_OUTSIDE_ADDRESS, proto: 'tcp', kindOf: 'static' },
        {
          kind: 'table',
          device: 'R1',
          table: 'nat',
          where: { proto: 'tcp', insideLocal: NAT_WEB_LOCAL, insideLocalPort: NAT_WEB_PORT, insideGlobalPort: NAT_FORWARD_PORT },
          exists: true,
        },
      ],
      feedbackOnFail: `The forward belongs to one protocol and one pair of ports: TCP, ${NAT_FORWARD_PORT} outside, ${NAT_WEB_PORT} inside.`,
    },
  ],
  solution: {
    R1: [
      'interface GigabitEthernet0/0',
      'ip nat inside',
      'exit',
      'interface GigabitEthernet0/1',
      'ip nat outside',
      'exit',
      `ip nat inside source static ${NAT_MAIL_LOCAL} ${NAT_MAIL_GLOBAL}`,
      'access-list 1 permit 192.168.1.0 0.0.0.63',
      'ip nat inside source list 1 interface GigabitEthernet0/1 overload',
      'access-list 2 permit 192.168.1.64 0.0.0.15',
      `ip nat pool ${NAT_POOL_NAME} ${NAT_POOL_FIRST} ${NAT_POOL_LAST} netmask ${MASK24}`,
      `ip nat inside source list 2 pool ${NAT_POOL_NAME}`,
      `ip nat inside source static tcp ${NAT_WEB_LOCAL} ${NAT_WEB_PORT} interface GigabitEthernet0/1 ${NAT_FORWARD_PORT}`,
    ],
  },
};

/** The address translation labs, in course order. */
export const CCNA2_NAT_LABS: readonly ScenarioInfo[] = [ccna2NatPat];
