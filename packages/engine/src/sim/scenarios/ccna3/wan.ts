/**
 * sim/scenarios/ccna3/wan.ts — the CCNA 3 point-to-point WAN lab (ARCHITECTURE-P3 §11.1 lesson 22, §11.2, §3.9, §5.7;
 * [S19]).
 *
 *   • `ccna3-serial-links` — lesson 22 "Point-to-point links" (module "Wide area networks"): two sites joined by one
 *     serial cable. First the HDLC link: R1 holds the DCE end and has to supply the clock before the line protocol
 *     can come up. Then PPP with CHAP [S19]: both ends switch to PPP, LCP opens, each router challenges the other with
 *     the shared secret, and IPCP opens — except that the user R2 was given for R1 carries a secret typed with the
 *     wrong case, so CHAP fails until the learner finds the line and fixes it.
 *
 * The world is a P3-profile world (`topology(…, { profile: 'P3' })`, schema 1.3). The hosts are cabled straight to the
 * routers, so there is no switch and no spanning tree to wait for (§11.2's PortFast rule has no port to apply to).
 * Tasks read structured state only (sim/lab-checks.ts): `config` reads the clock, user and encapsulation lines,
 * `port` the serial port's address and admin state, `neighbor {protocol: 'ppp'}` and the `ppp.*` facts the `ppp` rows
 * (the LCP and IPCP automata and the authentication each end requires, sim/lab-checks/wan.ts), `table ppp` the
 * outcome of the authentication each end performed, and `connectivity` pings in the grader's clone. The clock task
 * reads configuration, not the line state, because a refused CHAP also takes the line protocol down (§3.9 step 6) and
 * the clock is not what is wrong then. The HDLC task is graded where it still exists once the lab is done: in a clone
 * whose two serial ports are put back on HDLC by `LabFault config` (§2.10), so the clock and the addresses are proved
 * to carry an HDLC link on their own, whatever PPP is doing. All wording is original (§0 rule 6); addresses come from
 * the private ranges.
 *
 * A lab file imports only the contracts, `../kit.js` and `../templates.js` — never `./index.js`, `../index.js` or the
 * engine barrel — so the catalogue stays an acyclic graph of data modules (the arrays are read at module scope).
 *
 * ponytail: the wrong secret is in R2's startup configuration, not a hidden fault: lesson 22 is a build lab, and the
 * line is there from the start for the learner to find with `show running-config` once CHAP refuses the link. A
 * learner who switches authentication off to get the link up does not pass the CHAP task (`ppp.auth` must read
 * `chap` on both ends and both ends must have verified their peer).
 */
import type { ScenarioInfo } from '../../../contracts/scenario.js';
import { MASK24, MASK30, PC, ROUTER, cable, configText, device, link, section, topology } from '../kit.js';
import { SERIAL_PAIR_CLOCK_RATE_BPS, pcConfig } from '../templates.js';

/** The serial interface of both routers. */
const SERIAL = 'Serial0/0/0';
/** The CHAP secret both routers are meant to share (case matters). */
export const SERIAL_LINKS_SECRET = 'LinkKey22';
/** The secret R2 was given for R1 before the lab: the right letters in the wrong case. */
export const SERIAL_LINKS_WRONG_SECRET = 'linkkey22';
/** The /30 of the serial link: R1 is .1 (DCE), R2 is .2. */
const R1_SERIAL = '10.0.12.1';
const R2_SERIAL = '10.0.12.2';

/** R1: its LAN is ready; its serial port (the DCE end) has not been configured at all. */
function r1Config(): string {
  return configText([
    ['hostname R1'],
    section('interface GigabitEthernet0/0', [`ip address 10.1.0.1 ${MASK24}`, 'no shutdown']),
    [`ip route 10.2.0.0 ${MASK24} ${R2_SERIAL}`],
  ]);
}

/** R2: LAN and serial port ready on HDLC, and a local user for R1 whose secret is in the wrong case. */
function r2Config(): string {
  return configText([
    ['hostname R2'],
    [`username R1 password ${SERIAL_LINKS_WRONG_SECRET}`],
    section('interface GigabitEthernet0/0', [`ip address 10.2.0.1 ${MASK24}`, 'no shutdown']),
    section(`interface ${SERIAL}`, [`ip address ${R2_SERIAL} ${MASK30}`, 'no shutdown']),
    [`ip route 10.1.0.0 ${MASK24} ${R1_SERIAL}`],
  ]);
}

/** The lines that put one serial port back on HDLC inside the grader's clone (pasted-configuration form). */
const BACK_TO_HDLC: readonly string[] = [`interface ${SERIAL}`, ' encapsulation hdlc'];

/** Two sites, one serial cable; R1 holds the DCE end. */
export const ccna3SerialLinks: ScenarioInfo = {
  name: 'ccna3-serial-links',
  category: 'ccna3-lab',
  labType: 'build',
  course: 'CCNA 3',
  topic: 'Wide area networks',
  title: 'Bring up a serial link with HDLC, then PPP and CHAP',
  description:
    'Two sites share one serial cable. Clock the line and bring it up with HDLC, then move both ends to PPP, make each router prove itself to the other with CHAP, and find out why the first attempt is refused.',
  objectives: [
    'Supply the clock from the DCE end of a serial cable and bring the line protocol up',
    'Read the encapsulation, the line state and the DCE or DTE role of a serial interface',
    'Move both ends of a link from HDLC to PPP and follow LCP and IPCP as they open',
    'Authenticate each end of a PPP link with CHAP and a shared secret',
    'Find and fix the reason an authentication fails',
  ],
  tags: ['wan', 'serial', 'hdlc', 'ppp', 'lcp', 'ipcp', 'chap', 'authentication', 'clock rate'],
  difficulty: 2,
  estimatedMinutes: 30,
  requires: [PC, ROUTER],
  seed: 322,
  instructions: [
    '## What you have',
    '',
    `PC1 (\`10.1.0.10\`) sits on R1's LAN \`10.1.0.0/24\` and PC2 (\`10.2.0.10\`) on R2's LAN \`10.2.0.0/24\`. One serial cable joins R1 \`${SERIAL}\` to R2 \`${SERIAL}\` on the subnet \`10.0.12.0/30\`, and R1 holds its DCE end. Each router already has a static route to the other LAN. R2's serial interface is configured (\`${R2_SERIAL}/30\`); R1's has not been touched.`,
    '',
    '## Part 1: an HDLC link',
    '',
    `- On R1, give \`${SERIAL}\` the address \`${R1_SERIAL}/30\`, enable it and, because R1 holds the DCE end, supply the clock: \`clock rate ${SERIAL_PAIR_CLOCK_RATE_BPS}\`.`,
    `- Check the result with \`show controllers serial\` (which end is DCE, and the clock), \`show interfaces ${SERIAL}\` (the encapsulation is HDLC, the line protocol is up) and \`show ip interface brief\`.`,
    '- Ping PC2 from PC1.',
    '',
    '## Part 2: PPP with CHAP',
    '',
    '- Change both serial interfaces to `encapsulation ppp`. While only one end has changed, the line protocol stays down: the two framings do not understand each other.',
    `- With PPP on both ends, watch LCP and then IPCP open (\`show interfaces ${SERIAL}\`, \`debug ppp negotiation\`), and ping PC2 again.`,
    `- Now make each router prove itself with CHAP. On R1, create a local user named after the other router, \`username R2 password ${SERIAL_LINKS_SECRET}\`, and add \`ppp authentication chap\` to its serial interface. A colleague has already created R2's user for R1; add \`ppp authentication chap\` to R2's serial interface too.`,
    '- The link does not come back. Find out why with `debug ppp authentication` and `show interfaces`, then look for the cause in the configuration of both routers and fix it. Do not switch authentication off.',
    '- When the link is up again, ping PC2 from PC1 once more.',
    '',
    '*The routers take about 45 s to boot. Once the DCE end supplies the clock, HDLC brings the line protocol up at once; PPP negotiates in well under a second. After a refused authentication both ends wait and try again every 10 s, so allow about 10 s after you correct a secret. CHAP secrets are case-sensitive, and the user name each router looks up is the host name of the other one.*',
  ].join('\n'),
  build: () =>
    topology(
      322,
      [
        device('pc1', PC, 'PC1', 80, 320, pcConfig('PC1', '10.1.0.10', MASK24, '10.1.0.1')),
        device('r1', ROUTER, 'R1', 280, 160, r1Config()),
        device('r2', ROUTER, 'R2', 560, 160, r2Config()),
        device('pc2', PC, 'PC2', 760, 320, pcConfig('PC2', '10.2.0.10', MASK24, '10.2.0.1')),
      ],
      [
        link('l_pc1_r1', 'pc1', 'GigabitEthernet0', 'r1', 'GigabitEthernet0/0'),
        cable('l_r1_r2', 'r1', SERIAL, 'r2', SERIAL, 'serial-dce'),
        link('l_r2_pc2', 'r2', 'GigabitEthernet0/0', 'pc2', 'GigabitEthernet0'),
      ],
      ['Clock the serial line and bring it up with HDLC', 'Move the link to PPP and open LCP and IPCP', 'Authenticate both ends with CHAP and fix the refused secret'],
      'The DCE end of a serial cable sets the pace of the line. HDLC and PPP both frame the traffic on it, but only PPP negotiates the link, authenticates the far end and agrees on the addresses it carries.',
      { profile: 'P3' },
    ),
  tasks: [
    {
      id: 'clock-the-line',
      title: 'Clock and address the serial line',
      description: `R1 ${SERIAL} has ${R1_SERIAL}/30, supplies the clock at ${SERIAL_PAIR_CLOCK_RATE_BPS} b/s and is enabled.`,
      points: 20,
      hint: 'Only the end that holds the DCE connector supplies the clock; `show controllers serial` tells you which end that is.',
      assertions: [
        { kind: 'port', device: 'R1', port: SERIAL, field: 'ipv4', equals: `${R1_SERIAL}/30` },
        {
          kind: 'config',
          device: 'R1',
          path: `interface.${SERIAL}.clock`,
          equals: ['rate', String(SERIAL_PAIR_CLOCK_RATE_BPS)],
          feedback: 'R1 holds the DCE end of the cable, so the clock has to come from R1.',
          misconception: 'serial-clock-on-dte',
        },
        { kind: 'port', device: 'R1', port: SERIAL, field: 'adminUp', equals: true },
      ],
      feedbackOnFail: 'The DCE end of the cable has to supply the clock, and the interface has to be enabled, before the line protocol can come up.',
    },
    {
      id: 'hdlc-link',
      title: 'The line carries traffic with HDLC',
      description: 'With both serial interfaces on HDLC, PC1 reaches PC2 across the serial link.',
      points: 15,
      hint: 'HDLC is the default framing of a serial interface: the clock and the addresses are all it needs.',
      assertions: [
        {
          kind: 'connectivity',
          from: 'PC1',
          to: 'PC2',
          expect: 'success',
          after: [{ config: { device: 'R1', lines: BACK_TO_HDLC } }, { config: { device: 'R2', lines: BACK_TO_HDLC } }],
          feedback: 'The grader put both serial interfaces back on HDLC and PC1 still could not reach PC2: check the clock, the addresses and that both interfaces are enabled.',
        },
      ],
      feedbackOnFail: 'A serial link needs a clock from its DCE end and an address on each end in one subnet; the framing comes after that.',
    },
    {
      id: 'ppp-framing',
      title: 'Both ends run PPP and LCP is open',
      description: 'Both serial interfaces use PPP, and LCP is open between R1 and R2.',
      points: 20,
      dependsOn: ['clock-the-line'],
      hint: 'Change the framing on both ends: with PPP at one end and HDLC at the other the line protocol stays down.',
      assertions: [
        { kind: 'config', device: 'R1', path: `interface.${SERIAL}.encapsulation`, equals: 'ppp' },
        { kind: 'config', device: 'R2', path: `interface.${SERIAL}.encapsulation`, equals: 'ppp' },
        { kind: 'neighbor', device: 'R1', protocol: 'ppp', neighbor: 'R2', iface: SERIAL, state: 'opened' },
        { kind: 'neighbor', device: 'R2', protocol: 'ppp', neighbor: 'R1', iface: SERIAL, state: 'opened' },
      ],
      feedbackOnFail: 'LCP opens only when both ends speak PPP and, when authentication is required, only after it succeeds.',
    },
    {
      id: 'chap',
      title: 'Each router proves itself with CHAP',
      description: 'Both serial interfaces require CHAP, and each router has verified the other with the shared secret.',
      points: 25,
      dependsOn: ['ppp-framing'],
      hint: 'Each router looks up the host name of the other one among its local users; the secret on both sides has to match exactly, case included.',
      assertions: [
        { kind: 'fact', device: 'R1', fact: 'ppp.auth', subject: SERIAL, equals: 'chap', feedback: 'R1 does not require CHAP on its serial interface.' },
        { kind: 'fact', device: 'R2', fact: 'ppp.auth', subject: SERIAL, equals: 'chap', feedback: 'R2 does not require CHAP on its serial interface.' },
        { kind: 'config', device: 'R1', path: 'username.R2', exists: true },
        { kind: 'config', device: 'R2', path: 'username.R1', exists: true },
        {
          kind: 'table',
          device: 'R1',
          table: 'ppp',
          where: { authLocal: 'chap', authLocalState: 'success' },
          exists: true,
          feedback: 'R1 has not accepted the CHAP answer of R2: the secrets of the two users do not match.',
          misconception: 'chap-secret-mismatch',
        },
        {
          kind: 'table',
          device: 'R2',
          table: 'ppp',
          where: { authLocal: 'chap', authLocalState: 'success' },
          exists: true,
          feedback: 'R2 has not accepted the CHAP answer of R1: the secrets of the two users do not match.',
          misconception: 'chap-secret-mismatch',
        },
      ],
      feedbackOnFail: 'CHAP never sends the secret: each end proves it knows the same secret, so one wrong letter, or the wrong case, refuses the link.',
    },
    {
      id: 'ipcp',
      title: 'IPCP is open and the sites reach each other over PPP',
      description: 'IPCP is open on both ends, and PC1 reaches PC2 across the PPP link.',
      points: 20,
      dependsOn: ['chap'],
      hint: 'IPCP is the network control protocol of IPv4 on a PPP link; it opens after LCP and authentication.',
      assertions: [
        { kind: 'fact', device: 'R1', fact: 'ppp.ipcp', subject: SERIAL, equals: 'opened' },
        { kind: 'fact', device: 'R2', fact: 'ppp.ipcp', subject: SERIAL, equals: 'opened' },
        { kind: 'connectivity', from: 'PC1', to: 'PC2', expect: 'success' },
      ],
      feedbackOnFail: 'IPv4 crosses a PPP link only once LCP, the authentication and IPCP have all completed.',
    },
  ],
  solution: {
    R1: [
      `interface ${SERIAL}`,
      `ip address ${R1_SERIAL} ${MASK30}`,
      `clock rate ${SERIAL_PAIR_CLOCK_RATE_BPS}`,
      'no shutdown',
      'exit',
      `username R2 password ${SERIAL_LINKS_SECRET}`,
      `interface ${SERIAL}`,
      'encapsulation ppp',
      'ppp authentication chap',
      'exit',
    ],
    R2: [`username R1 password ${SERIAL_LINKS_SECRET}`, `interface ${SERIAL}`, 'encapsulation ppp', 'ppp authentication chap', 'exit'],
  },
};

/** The WAN labs of CCNA 3 (lesson 22), in course order. */
export const CCNA3_WAN_LABS: readonly ScenarioInfo[] = [ccna3SerialLinks];
