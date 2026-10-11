/**
 * sim/scenarios/ccna3/troubleshooting.ts — the CCNA 3 enterprise fault-finding lab (ARCHITECTURE-P3 §11.1 lesson 34,
 * §11.2, §2.10).
 *
 *   • `ccna3-troubleshoot-enterprise` — lesson 34 "Finding faults across layers" (module "Designing and fixing"): a
 *     head office and a branch joined by a serial link that runs OSPF, the head office translating both sites to the
 *     provider, an access list that decides what the branch may use on the head-office server, and a chain of clocks
 *     from the server to both routers. A round of changes shortly after start-up breaks it in four places, one per
 *     area of the course: a routing fault (R2's serial interface was made passive along with its LAN, so R2 sends no
 *     hello there and OSPF drops the adjacency), an ACL fault (the entry that lets the branch browse the server moved
 *     below the entry that denies the branch everything else on it), a
 *     translation fault (the head-office line of the NAT list was retyped with the wrong network) and a time fault
 *     (R2 asks the wrong address for the time).
 *
 * The world is a P3-profile world (`topology(…, { profile: 'P3' })`, schema 1.3). The faults are hidden configuration
 * changes the worker injects after the load (§11.2, the kit's `configFragmentFault`), each at its own instant once
 * every router has booted (45 s), and each saved with `do write memory`, so a power cycle does not undo it and the
 * startup configuration does not give it away. Until the last one has landed, `evaluateLab` grades no task (the
 * "still being prepared" detail), so the healthy world before the faults never scores.
 *
 * Tasks read structured state only (sim/lab-checks.ts and the area adapters), one task per fault plus one end to end,
 * and each fault task passes on its own repair whatever the state of the others:
 *   routing — `neighbor {protocol: 'ospf', state: 'full'}` both ways, the `ospf.passive` fact of R2's two interfaces
 *             (the serial link active, the LAN passive, as designed), the branch LAN as an `O` route on R1 and the
 *             default route as an `E2` route on R2, and a ping between the two LANs (the branch list permits it);
 *   ACL     — the list's entries in order and its binding (`acl`), the decisions it takes (`aclDecision`), and real
 *             traffic in a grader clone whose routing fault the grader repairs first with `LabFault config` (§2.10):
 *             a branch host opens TCP 80 on the server, and its ping to the server is dropped by the list at R2;
 *   NAT     — the NAT list holds both designed entries in any order (`acl`, `includes`), matches no network outside the
 *             plan (`aclDecision`), and a ping from the head office to the internet server leaves a translation row
 *             (`connectivity.then` + `nat`);
 *   time    — the `ntp.*` and `clock.source` facts of R2 (`ntp-peers`, `clock`), and the wrong server gone. After the
 *             fault R2's clock source is `user` though nobody typed `clock set` (ntp keeps the value when the server
 *             line goes), so its feedback names the device's own clock, never a hand-set one (W5 fix #24).
 * The provider router ISP knows no private network, so every reply from EXT proves the head office translated it.
 * All wording is original (§0 rule 6); addresses come from the private and documentation ranges.
 *
 * A lab file imports only the contracts, `../kit.js` and `../templates.js` — never `./index.js`, `../index.js` or the
 * engine barrel — so the catalogue stays an acyclic graph of data modules (the arrays are read at module scope).
 *
 * ponytail: the switches carry hosts and one router each and the lesson is not about spanning tree, so every switch
 * port in use is an edge port (`spanning-tree portfast`, §11.2). No fault needs a cable repaired: each is repaired
 * from the CLI, so the reference `solution` (lines for `Simulation.configure`) can prove the lab solvable.
 */
import type { LabFault, ScenarioInfo } from '../../../contracts/scenario.js';
import { SEC } from '../../../contracts/time.js';
import { MASK24, MASK30, PC, ROUTER, SERVER, SWITCH, accessPort, cable, configFragmentFault, configText, device, link, section, topology, type ScheduledFault } from '../kit.js';
import { SERIAL_PAIR_CLOCK_RATE_BPS, pcConfig } from '../templates.js';

/** When the four hidden changes land: one per instant, once every router has booted (45 s). */
const FAULT_ROUTING_AT = 50 * SEC;
const FAULT_ACL_AT = 51 * SEC;
const FAULT_NAT_AT = 52 * SEC;
const FAULT_TIME_AT = 53 * SEC;

/** A hidden configuration change that is saved too, so a power cycle keeps it (the last line runs in global mode). */
function savedFragment(at: number, device: string, lines: readonly string[]): ScheduledFault {
  return configFragmentFault(at, device, [...lines, 'do write memory']);
}

/** The head-office server: web page for the branch, and the time source of the network (stratum 1). */
export const ENTERPRISE_SERVER = '192.168.10.100';
/** R1's outside address, which both LANs share through PAT. */
export const ENTERPRISE_OUTSIDE = '203.0.113.1';
/** The internet server behind the provider. */
export const ENTERPRISE_EXT = '198.51.100.10';
/** The serial link: R1 (DCE) .1, R2 .2. */
const R1_SERIAL = '10.0.12.1';
const R2_SERIAL = '10.0.12.2';
/** The address R2 is told to ask for the time after the fault (two digits swapped). */
export const ENTERPRISE_WRONG_NTP = '10.0.21.1';
const SERIAL = 'Serial0/0/0';

/** The branch policy, in its designed order: browse the server, nothing else on it, everything else open. */
const BRANCH_POLICY = 'BRANCH-POLICY';
const POLICY_WEB = `permit tcp 192.168.20.0 0.0.0.255 host ${ENTERPRISE_SERVER} eq www`;
const POLICY_SERVER = `deny ip 192.168.20.0 0.0.0.255 host ${ENTERPRISE_SERVER}`;
const POLICY_REST = 'permit ip 192.168.20.0 0.0.0.255 any';

/** The NAT list: both LANs share R1's outside address. */
const NAT_LIST = 'NAT-LANS';
const NAT_HQ = 'permit 192.168.10.0 0.0.0.255';
const NAT_BRANCH = 'permit 192.168.20.0 0.0.0.255';

/** A site switch: the ports facing its hosts and its router are edge ports (the lesson is not about spanning tree). */
function siteSwitch(hostname: string, ports: readonly string[]): string {
  return configText([[`hostname ${hostname}`], ...ports.map((p) => accessPort(p, 1, { portfast: true }))]);
}

/** SRV1: the intranet page and the stratum-1 time source. */
function serverConfig(): string {
  return configText([
    ['hostname SRV1'],
    section('interface GigabitEthernet0', [`ip address ${ENTERPRISE_SERVER} ${MASK24}`]),
    ['ip default-gateway 192.168.10.1'],
    ['ip http server'],
    ['ntp master 1'],
  ]);
}

/** R1, the head-office edge: OSPF with the default route, PAT for both LANs, time from SRV1. */
function r1Config(): string {
  return configText([
    ['hostname R1'],
    section('interface GigabitEthernet0/0', [`ip address 192.168.10.1 ${MASK24}`, 'ip nat inside', 'no shutdown']),
    section('interface GigabitEthernet0/1', [`ip address ${ENTERPRISE_OUTSIDE} ${MASK24}`, 'ip nat outside', 'no shutdown']),
    section(`interface ${SERIAL}`, [`ip address ${R1_SERIAL} ${MASK30}`, 'ip nat inside', `clock rate ${SERIAL_PAIR_CLOCK_RATE_BPS}`, 'no shutdown']),
    section('router ospf 1', ['router-id 1.1.1.1', 'passive-interface GigabitEthernet0/0', 'network 192.168.10.0 0.0.0.255 area 0', 'network 10.0.12.0 0.0.0.3 area 0', 'default-information originate']),
    ['ip route 0.0.0.0 0.0.0.0 203.0.113.254'],
    section(`ip access-list standard ${NAT_LIST}`, [NAT_HQ, NAT_BRANCH]),
    [`ip nat inside source list ${NAT_LIST} interface GigabitEthernet0/1 overload`],
    [`ntp server ${ENTERPRISE_SERVER}`],
  ]);
}

/** R2, the branch: OSPF, the branch policy on its LAN, time from R1. */
function r2Config(): string {
  return configText([
    ['hostname R2'],
    section(`ip access-list extended ${BRANCH_POLICY}`, ['remark the branch may browse SRV1 and use nothing else on it', POLICY_WEB, POLICY_SERVER, POLICY_REST]),
    section('interface GigabitEthernet0/0', [`ip address 192.168.20.1 ${MASK24}`, `ip access-group ${BRANCH_POLICY} in`, 'no shutdown']),
    section(`interface ${SERIAL}`, [`ip address ${R2_SERIAL} ${MASK30}`, 'no shutdown']),
    section('router ospf 1', ['router-id 2.2.2.2', 'passive-interface GigabitEthernet0/0', 'network 192.168.20.0 0.0.0.255 area 0', 'network 10.0.12.0 0.0.0.3 area 0']),
    [`ntp server ${R1_SERIAL}`],
  ]);
}

/** ISP: the link to R1 and the internet LAN of EXT; no route to any private network. */
function providerConfig(): string {
  return configText([
    ['hostname ISP'],
    section('interface GigabitEthernet0/0', [`ip address 203.0.113.254 ${MASK24}`, 'no shutdown']),
    section('interface GigabitEthernet0/1', [`ip address 198.51.100.1 ${MASK24}`, 'no shutdown']),
  ]);
}

/** The grader's own repair of the routing fault, applied in the clone that grades the ACL with real traffic. */
const ROUTING_REPAIRED: readonly LabFault[] = [{ config: { device: 'R2', lines: ['router ospf 1', ` no passive-interface ${SERIAL}`] } }];

/** Head office (R1, SW1, PC1, SRV1), branch (R2, SW2, PC2) and the provider (ISP, EXT); four hidden faults. */
export const ccna3TroubleshootEnterprise: ScenarioInfo = {
  name: 'ccna3-troubleshoot-enterprise',
  category: 'ccna3-lab',
  labType: 'troubleshoot',
  course: 'CCNA 3',
  topic: 'Designing and fixing',
  title: 'Find the faults across an enterprise network',
  description:
    'A head office and a branch share OSPF routes, an access policy, address translation to the internet and one source of time. Shortly after start-up a round of changes broke all four. Work through the layers, find each fault on the device that holds it and repair it without changing the design.',
  objectives: [
    'Compare a working design with what the devices really do, one area at a time',
    'Find why two OSPF routers no longer become neighbours',
    'Read the order and the match counts of an access list and restore the intended policy',
    'Check which addresses a translation list matches and repair it',
    'Follow a chain of time servers and repair a client that asks the wrong one',
  ],
  tags: ['troubleshooting', 'layered method', 'ospf', 'passive interface', 'extended acl', 'nat', 'pat', 'ntp', 'clock'],
  difficulty: 3,
  estimatedMinutes: 40,
  requires: [PC, ROUTER, SERVER, SWITCH],
  seed: 334,
  instructions: [
    '## The design',
    '',
    `- **Head office**: PC1 (\`192.168.10.11\`) and SRV1 (\`${ENTERPRISE_SERVER}\`) on SW1, behind R1 (\`192.168.10.1\`, \`GigabitEthernet0/0\`).`,
    '- **Branch**: PC2 (`192.168.20.21`) on SW2, behind R2 (`192.168.20.1`, `GigabitEthernet0/0`).',
    `- **WAN**: R1 \`${SERIAL}\` (\`${R1_SERIAL}/30\`, the DCE end) to R2 \`${SERIAL}\` (\`${R2_SERIAL}/30\`), HDLC.`,
    `- **Internet**: R1 \`GigabitEthernet0/1\` (\`${ENTERPRISE_OUTSIDE}/24\`) to the provider router ISP, which knows no private network; EXT (\`${ENTERPRISE_EXT}\`) is a server on the internet.`,
    '- **Routing**: OSPF process 1, area 0, on both routers, with the default timers everywhere; the LAN interfaces are passive; R1 holds a static default route to the provider and passes it on to R2 through OSPF.',
    `- **Branch policy**: the extended list \`${BRANCH_POLICY}\`, inbound on R2 \`GigabitEthernet0/0\`, lets the branch open the intranet web page on SRV1, denies the branch everything else on SRV1, and leaves every other destination open, in that order.`,
    `- **Translation**: R1 translates both LANs, matched by the standard list \`${NAT_LIST}\`, to its outside address (PAT).`,
    '- **Time**: SRV1 serves the time at stratum 1; R1 takes it from SRV1 and R2 from R1, across the serial link.',
    '',
    '## What the users report',
    '',
    '- The branch reaches nothing at the head office and nothing on the internet.',
    '- Even before that, branch staff could no longer open the intranet page on SRV1, although nobody meant to change who may use it.',
    '- Nobody at the head office reaches the internet, while the head-office LAN itself works.',
    `- R2's clock no longer follows the head office, so the times in its logs cannot be compared with R1's.`,
    '',
    '## What to do',
    '',
    'Work one area at a time and repair each fault on the device that holds it; the design above is right, so put each device back in line with it rather than adding anything new.',
    '',
    '- Routing: `show ip ospf neighbor`, `show ip ospf interface` and `show ip route` on both routers.',
    '- The branch policy: `show access-lists` on R2. Read the order of the entries and their match counts.',
    '- Translation: `show ip nat translations` and `show access-lists` on R1, after a ping from PC1 to EXT.',
    '- Time: `show ntp associations`, `show ntp status` and `show clock detail` on R2, then on R1.',
    '- Prove the result: PC2 reaches EXT and opens the web page on SRV1, and a ping from PC2 to SRV1 is still refused.',
    '',
    '*The routers take about 45 s to boot, and the changes landed a few seconds later. On the serial link, a point-to-point link, OSPF installs its routes about 15 s after the link comes up or the adjacency is repaired, so allow about a minute after start-up before the first ping, and about 15 s after a repair; a neighbour that stops sending hellos is dropped 40 s after its last one. A router polls a newly configured time server at once, then every 64 s.*',
  ].join('\n'),
  build: () =>
    topology(
      334,
      [
        device('pc1', PC, 'PC1', 70, 300, pcConfig('PC1', '192.168.10.11', MASK24, '192.168.10.1')),
        device('srv1', SERVER, 'SRV1', 70, 470, serverConfig()),
        device('sw1', SWITCH, 'SW1', 220, 380, siteSwitch('SW1', ['FastEthernet0/1', 'FastEthernet0/2', 'GigabitEthernet0/1'])),
        device('r1', ROUTER, 'R1', 380, 230, r1Config()),
        device('r2', ROUTER, 'R2', 660, 230, r2Config()),
        device('sw2', SWITCH, 'SW2', 800, 380, siteSwitch('SW2', ['FastEthernet0/1', 'GigabitEthernet0/1'])),
        device('pc2', PC, 'PC2', 930, 470, pcConfig('PC2', '192.168.20.21', MASK24, '192.168.20.1')),
        device('isp', ROUTER, 'ISP', 380, 60, providerConfig()),
        device('ext', SERVER, 'EXT', 640, 60, pcConfig('EXT', ENTERPRISE_EXT, MASK24, '198.51.100.1')),
      ],
      [
        link('l_pc1_sw1', 'pc1', 'GigabitEthernet0', 'sw1', 'FastEthernet0/1'),
        link('l_srv1_sw1', 'srv1', 'GigabitEthernet0', 'sw1', 'FastEthernet0/2'),
        link('l_sw1_r1', 'sw1', 'GigabitEthernet0/1', 'r1', 'GigabitEthernet0/0'),
        cable('l_r1_r2', 'r1', SERIAL, 'r2', SERIAL, 'serial-dce'),
        link('l_r2_sw2', 'r2', 'GigabitEthernet0/0', 'sw2', 'GigabitEthernet0/1'),
        link('l_pc2_sw2', 'pc2', 'GigabitEthernet0', 'sw2', 'FastEthernet0/1'),
        link('l_r1_isp', 'r1', 'GigabitEthernet0/1', 'isp', 'GigabitEthernet0/0'),
        link('l_isp_ext', 'isp', 'GigabitEthernet0/1', 'ext', 'GigabitEthernet0'),
      ],
      ['Restore the OSPF adjacency', 'Restore the branch policy', 'Repair the translation list', 'Put R2 back on the time chain', 'Reach the internet and the intranet page from the branch'],
      'A fault shows itself far from where it lies: work from the symptom to the device, then to the one line that differs from the design.',
      { profile: 'P3' },
    ),
  faults: [
    savedFragment(FAULT_ROUTING_AT, 'r2', ['router ospf 1', ` passive-interface ${SERIAL}`]),
    // the remark holds sequence 10, so the web entry is 20: it moves to 35, between the deny (30) and the rest (40)
    savedFragment(FAULT_ACL_AT, 'r2', [`ip access-list extended ${BRANCH_POLICY}`, ' no 20', ` 35 ${POLICY_WEB}`]),
    savedFragment(FAULT_NAT_AT, 'r1', [`ip access-list standard ${NAT_LIST}`, ' no 10', ' 10 permit 192.168.1.0 0.0.0.255']),
    savedFragment(FAULT_TIME_AT, 'r2', [`no ntp server ${R1_SERIAL}`, `ntp server ${ENTERPRISE_WRONG_NTP}`]),
  ],
  tasks: [
    {
      id: 'routing',
      title: 'R1 and R2 are OSPF neighbours again',
      description: 'R1 and R2 are fully adjacent over the serial link, R2 sends hellos on that link and none on its LAN, R1 has the branch LAN as an OSPF route, R2 has the default route from R1, and PC1 reaches PC2.',
      points: 20,
      hint: 'A router sends no hello on a passive interface, so it can never find a neighbour there.',
      assertions: [
        { kind: 'neighbor', device: 'R1', protocol: 'ospf', neighbor: 'R2', state: 'full' },
        { kind: 'neighbor', device: 'R2', protocol: 'ospf', neighbor: 'R1', state: 'full' },
        {
          kind: 'fact',
          device: 'R2',
          fact: 'ospf.passive',
          subject: SERIAL,
          equals: false,
          feedback: `R2 sends no hello on ${SERIAL}, so R1 can never become its neighbour there.`,
          misconception: 'ospf-passive-wan',
        },
        { kind: 'fact', device: 'R2', fact: 'ospf.passive', subject: 'GigabitEthernet0/0', equals: true, feedback: 'The design keeps the branch LAN passive: no router listens there.' },
        { kind: 'route', device: 'R1', destination: '192.168.20.21', source: 'O', network: '192.168.20.0/24', nextHop: R2_SERIAL },
        { kind: 'route', device: 'R2', destination: ENTERPRISE_EXT, source: 'O', network: '0.0.0.0/0', routeType: 'E2' },
        { kind: 'connectivity', from: 'PC1', to: 'PC2', expect: 'success' },
      ],
      feedbackOnFail: 'Without an adjacency there is no route between the sites: compare the OSPF settings of the two ends of the link.',
    },
    {
      id: 'branch-policy',
      title: 'The branch policy works as designed',
      description: `${BRANCH_POLICY} holds its three entries in the designed order and is still applied inbound on R2 GigabitEthernet0/0; a branch host opens TCP port 80 on SRV1, and its ping to SRV1 is dropped by the list at R2.`,
      points: 20,
      hint: 'An access list is read from the top and the first match wins: a permit placed below a deny that matches the same packets is never reached.',
      assertions: [
        {
          kind: 'acl',
          device: 'R2',
          list: BRANCH_POLICY,
          type: 'extended',
          entries: [POLICY_WEB, POLICY_SERVER, POLICY_REST],
          match: 'exactly',
          applied: [{ iface: 'GigabitEthernet0/0', dir: 'in' }],
          misconception: 'acl-order',
        },
        { kind: 'aclDecision', device: 'R2', list: BRANCH_POLICY, packet: { proto: 'tcp', src: 'PC2', dst: 'SRV1', dstPort: 80 }, expect: 'permit' },
        { kind: 'aclDecision', device: 'R2', list: BRANCH_POLICY, packet: { proto: 'icmp', src: 'PC2', dst: 'SRV1' }, expect: 'deny', feedback: 'The branch must still be kept away from everything on SRV1 but its web page.' },
        { kind: 'connectivity', from: 'PC2', to: 'SRV1', proto: 'tcp', port: 80, expect: 'success', after: ROUTING_REPAIRED },
        { kind: 'connectivity', from: 'PC2', to: 'SRV1', expect: 'fail', droppedAt: 'R2', dropReason: 'acl-deny', after: ROUTING_REPAIRED },
      ],
      feedbackOnFail: 'Restore the policy rather than removing it: the branch may use the web page of SRV1 and nothing else on that server.',
    },
    {
      id: 'translation',
      title: 'The head office is translated again',
      description: `${NAT_LIST} matches both LANs again, and PC1 reaches EXT through a PAT row on R1 that borrows ${ENTERPRISE_OUTSIDE}.`,
      points: 20,
      hint: 'A translation rule only translates the inside addresses its list permits; compare the networks in the list with the addressing plan.',
      assertions: [
        // the effect, not the exact repair line (W5 fix #22): two disjoint permits match the same in any order, so an
        // appended repair (`no 10` then `permit …`, numbered 30) earns the task; a leftover wrong line or a `permit any`
        // still fails on the decision below
        { kind: 'acl', device: 'R1', list: NAT_LIST, type: 'standard', entries: [NAT_HQ, NAT_BRANCH], match: 'includes' },
        { kind: 'aclDecision', device: 'R1', list: NAT_LIST, packet: { proto: 'ip', src: '192.168.1.10', dst: ENTERPRISE_EXT }, expect: 'deny', feedback: 'The list still matches a network the plan does not have.' },
        {
          kind: 'connectivity',
          from: 'PC1',
          to: 'EXT',
          expect: 'success',
          then: [{ kind: 'nat', device: 'R1', insideLocal: '192.168.10.11', insideGlobal: ENTERPRISE_OUTSIDE, proto: 'icmp', kindOf: 'overload' }],
        },
      ],
      feedbackOnFail: 'The provider drops every packet addressed to a private network, so a host the list does not match never gets a reply from the internet.',
    },
    {
      id: 'time',
      title: 'R2 takes its time from R1 again',
      description: `R2 is synchronised to R1 at stratum 3, its clock follows NTP, and it no longer asks ${ENTERPRISE_WRONG_NTP}.`,
      points: 20,
      hint: 'Compare the address R2 asks for the time with the addresses R1 really has.',
      assertions: [
        { kind: 'fact', device: 'R2', fact: 'ntp.synced', equals: true },
        { kind: 'fact', device: 'R2', fact: 'ntp.peer', equals: 'R1' },
        { kind: 'fact', device: 'R2', fact: 'ntp.stratum', equals: 3 },
        {
          kind: 'fact',
          device: 'R2',
          fact: 'clock.source',
          equals: 'ntp',
          // 'user' has two causes and the fault is the one nobody typed (W5 fix #24): name the effect, not `clock set`
          feedback: 'R2 runs on its own clock and follows no time server (a clock keeps its time when its server is removed; `clock set` does not synchronise it either).',
        },
        { kind: 'table', device: 'R2', table: 'ntp-peers', where: { address: ENTERPRISE_WRONG_NTP }, exists: false, feedback: `R2 still asks ${ENTERPRISE_WRONG_NTP} for the time.` },
      ],
      feedbackOnFail: 'A clock is only as good as the server it follows: R2 must ask R1, which follows SRV1.',
    },
    {
      id: 'end-to-end',
      title: 'The branch reaches the internet and the intranet page',
      description: 'PC2 reaches EXT through the translation on R1, opens TCP port 80 on SRV1, and reaches PC1.',
      points: 20,
      dependsOn: ['routing', 'branch-policy', 'translation'],
      assertions: [
        {
          kind: 'connectivity',
          from: 'PC2',
          to: 'EXT',
          expect: 'success',
          then: [{ kind: 'nat', device: 'R1', insideLocal: '192.168.20.21', insideGlobal: ENTERPRISE_OUTSIDE, proto: 'icmp', kindOf: 'overload' }],
        },
        { kind: 'connectivity', from: 'PC2', to: 'SRV1', proto: 'tcp', port: 80, expect: 'success' },
        { kind: 'connectivity', from: 'PC2', to: 'PC1', expect: 'success' },
      ],
      feedbackOnFail: 'A branch packet to the internet crosses the branch list, OSPF over the serial link and the translation at R1, and the reply needs all three on the way back.',
    },
  ],
  solution: {
    R2: [
      'router ospf 1',
      `no passive-interface ${SERIAL}`,
      'exit',
      `ip access-list extended ${BRANCH_POLICY}`,
      'no 35',
      `20 ${POLICY_WEB}`,
      'exit',
      `no ntp server ${ENTERPRISE_WRONG_NTP}`,
      `ntp server ${R1_SERIAL}`,
    ],
    R1: [`ip access-list standard ${NAT_LIST}`, 'no 10', `10 ${NAT_HQ}`, 'exit'],
  },
};

/** The fault-finding labs of CCNA 3 (lesson 34), in course order. */
export const CCNA3_TROUBLESHOOTING_LABS: readonly ScenarioInfo[] = [ccna3TroubleshootEnterprise];
