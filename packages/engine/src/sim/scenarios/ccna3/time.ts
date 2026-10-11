/**
 * sim/scenarios/ccna3/time.ts — the CCNA 3 time and logging lab (ARCHITECTURE-P3 §11.1 lesson 29, §11.2, §3.7, §5.5,
 * §5.7; owner svc, W5; with the approved [S24] local-logging and [S25] syslog tasks).
 *
 *   • `ccna3-time-and-logs` — lesson 29 "Time and logs" (module "Managing the network"): an NTP chain as in §3.7 — the
 *     server SRV1 is the reference (`service ntp on`, stratum 1), R1 follows it (stratum 2) and SW1 follows R1
 *     (stratum 3; its `ntp server` line wakes the switch's dormant transport, D22) — then [S24] a log buffer on R1 that
 *     keeps everything but debugging, stamped with the local time and its zone, and [S25] the warnings and worse sent
 *     to SRV1's syslog receiver, proved by a link change of R1's whose `%LINK-3-UPDOWN` line reaches the server.
 *
 * A P3-profile world (`topology(…, { profile: 'P3' })`, schema 1.3): routers and managed switches replay the two [S24]
 * `service timestamps … datetime msec` lines and log link, line-protocol and configuration changes (the [S25] default).
 * The lesson is not about spanning tree, so SW1's ports toward the router and the server are edge ports (§11.2). Tasks
 * read structured state only (§2.10, rule 20): the `ntp.*` and `clock.source` facts read the `ntp-peers` and `clock`
 * tables, the `logging.*` facts and `config` read the configuration, and the syslog task reads SRV1's
 * `syslog-messages` table live (the learner's own link change). The first poll, the kicks and the six fast retries of
 * an unsynchronised client are not periodic (D19), so a solved world synchronises under `runToIdle`. The reference
 * `solution` is accepted by `Simulation.configure` as written: it bounces R1's PC-facing port (`shutdown`, then
 * `no shutdown`) to make the link change the syslog task looks for. Addresses are §3.7's; all wording is original.
 *
 * A lab file imports only the contracts, `../kit.js` and `../templates.js` (rule 12: no cycle with the catalogue).
 */
import type { ScenarioInfo } from '../../../contracts/scenario.js';
import { MASK24, PC, ROUTER, SERVER, SWITCH, accessPort, configText, device, link, section, topology } from '../kit.js';
import { pcConfig } from '../templates.js';

/** §3.7's addresses: R1 on the server LAN, SW1's management address and the time and syslog server. */
export const TIME_R1_ADDRESS = '10.0.0.1';
export const TIME_SW1_ADDRESS = '10.0.0.2';
export const TIME_SERVER_ADDRESS = '10.0.0.10';
/** The time zone the lab sets on R1 (one hour east of UTC) and shows in its log stamps. */
export const TIME_ZONE_NAME = 'CET';
export const TIME_ZONE_OFFSET_HOURS = 1;
/** The level R1's log buffer keeps (everything but debugging) and the level it sends to the server. */
export const TIME_BUFFER_LEVEL = 'informational';
export const TIME_TRAP_LEVEL = 'warnings';
/** The line the syslog task looks for on the server: a link change of R1's (severity 3). */
export const TIME_LINK_LOG = '%LINK-3-UPDOWN';

/** R1: the server LAN on GigabitEthernet0/1, PC1's LAN on GigabitEthernet0/0. No time, no log settings yet. */
function r1Config(): string {
  return configText([
    ['hostname R1'],
    section('interface GigabitEthernet0/0', [`ip address 10.0.1.1 ${MASK24}`, 'no shutdown']),
    section('interface GigabitEthernet0/1', [`ip address ${TIME_R1_ADDRESS} ${MASK24}`, 'no shutdown']),
  ]);
}

/** SW1: managed on Vlan1; its ports toward R1 and SRV1 are edge ports. */
function sw1Config(): string {
  return configText([
    ['hostname SW1'],
    accessPort('GigabitEthernet0/1', 1, { portfast: true }),
    accessPort('FastEthernet0/1', 1, { portfast: true }),
    section('interface Vlan1', [`ip address ${TIME_SW1_ADDRESS} ${MASK24}`, 'no shutdown']),
    [`ip default-gateway ${TIME_R1_ADDRESS}`],
  ]);
}

/** Lab 29: an NTP chain, then local logging with timestamps [S24] and a syslog server [S25]. */
export const ccna3TimeAndLogs: ScenarioInfo = {
  name: 'ccna3-time-and-logs',
  category: 'ccna3-lab',
  labType: 'build',
  course: 'CCNA 3',
  topic: 'Managing the network',
  title: 'Time and logs',
  description:
    'Logs are only as useful as the time they carry. Build an NTP chain from a server through the router to the switch, give the router a log buffer stamped with local time, and send its warnings and errors to a syslog server, where a link going down and up again should arrive with the right time.',
  objectives: [
    'Make a server the time reference and chain a router and a switch to it with NTP',
    'Read the stratum, the peer and the clock source with show ntp associations, show ntp status and show clock detail',
    'Keep a local log buffer at a chosen level and stamp log lines with the local time and time zone',
    'Send messages up to a chosen severity to a syslog server and recognise the severity in a message',
  ],
  tags: ['ntp', 'stratum', 'clock', 'syslog', 'severity levels', 'timestamps'],
  difficulty: 2,
  estimatedMinutes: 30,
  requires: [PC, ROUTER, SERVER, SWITCH],
  seed: 3029,
  instructions: [
    '## What you have',
    '',
    `R1 joins two LANs: \`10.0.0.0/24\` with SW1 (\`${TIME_SW1_ADDRESS}\`) and the server SRV1 (\`${TIME_SERVER_ADDRESS}\`), and \`10.0.1.0/24\` with PC1. SRV1 keeps the true time but serves nothing yet. R1 and SW1 start with an unset clock: \`show clock\` marks it with \`*\`, and so does every log stamp.`,
    '',
    '## What to do',
    '',
    `- On SRV1's command line, start the time service with \`service ntp on\`: the server becomes a stratum 1 reference.`,
    `- Point R1 at SRV1 with \`ntp server ${TIME_SERVER_ADDRESS}\`, then point SW1 at R1 with \`ntp server ${TIME_R1_ADDRESS}\`. Check with \`show ntp associations\` and \`show ntp status\`: R1 should be at stratum 2 and SW1 at stratum 3, each following the device above it.`,
    `- On R1, set the time zone with \`clock timezone ${TIME_ZONE_NAME} ${TIME_ZONE_OFFSET_HOURS}\`, stamp log lines with \`service timestamps log datetime msec localtime show-timezone\`, and keep a buffer of everything but debugging: \`logging buffered 16384 ${TIME_BUFFER_LEVEL}\`. Read it with \`show logging\`.`,
    `- Start SRV1's syslog receiver with \`service syslog on\`. On R1, send logs to it with \`logging host ${TIME_SERVER_ADDRESS}\`, limited to warnings and worse with \`logging trap ${TIME_TRAP_LEVEL}\`.`,
    `- Make a link change R1 must report: unplug PC1's cable and plug it back, or \`shutdown\` and then \`no shutdown\` R1 \`GigabitEthernet0/0\`. The \`${TIME_LINK_LOG}\` line (severity 3, an error) reaches SRV1; the line-protocol line (severity 5) stays in R1's buffer. SRV1's Services panel lists every message its syslog receiver kept.`,
    '',
    '## Timing',
    '',
    'Allow about a minute for the routers to start. A clock follows its server within a few seconds of the `ntp server` line: an unanswered poll is tried again after 1, 2, 4, 8, 16 and 32 s, then every 64 s. SW1 can only synchronise once R1 has, so its first answer may say stratum 16 (not synchronised) before the next poll succeeds.',
    '',
    '*The severities run from 0 (emergencies) to 7 (debugging): `logging trap warnings` sends 0 to 4.*',
  ].join('\n'),
  build: () =>
    topology(
      3029,
      [
        device('srv1', SERVER, 'SRV1', 170, 170, pcConfig('SRV1', TIME_SERVER_ADDRESS, MASK24, TIME_R1_ADDRESS)),
        device('sw1', SWITCH, 'SW1', 390, 170, sw1Config()),
        device('r1', ROUTER, 'R1', 610, 170, r1Config()),
        device('pc1', PC, 'PC1', 830, 170, pcConfig('PC1', '10.0.1.10', MASK24, '10.0.1.1')),
      ],
      [
        link('l_srv1_sw1', 'srv1', 'GigabitEthernet0', 'sw1', 'FastEthernet0/1'),
        link('l_sw1_r1', 'sw1', 'GigabitEthernet0/1', 'r1', 'GigabitEthernet0/1'),
        link('l_r1_pc1', 'r1', 'GigabitEthernet0/0', 'pc1', 'GigabitEthernet0'),
      ],
      ['Make SRV1 the time reference', 'Chain R1 and SW1 to it', 'Keep stamped logs on R1', 'Send warnings and worse to SRV1'],
      'Every device takes its time from the one above it; every log line carries that time to the buffer and to the syslog server.',
      { profile: 'P3' },
    ),
  tasks: [
    {
      id: 'r1-time',
      title: 'R1 takes its time from SRV1',
      description: 'R1 is synchronised to SRV1 at stratum 2, and its clock source is NTP.',
      points: 25,
      hint: 'A server serves time only once its service is on; the router needs one ntp server line.',
      assertions: [
        { kind: 'fact', device: 'R1', fact: 'ntp.synced', equals: true, feedback: 'R1 follows no time server yet.', misconception: 'ntp-server-not-serving' },
        { kind: 'fact', device: 'R1', fact: 'ntp.peer', equals: 'SRV1', feedback: 'R1 follows another source than SRV1.' },
        { kind: 'fact', device: 'R1', fact: 'ntp.stratum', equals: 2 },
        { kind: 'fact', device: 'R1', fact: 'clock.source', equals: 'ntp' },
      ],
      feedbackOnFail: 'show ntp associations on R1 marks the server it follows with *; an unanswered server stays at reach 0.',
    },
    {
      id: 'sw1-time',
      title: 'SW1 takes its time from R1',
      description: 'SW1 is synchronised to R1 at stratum 3, and its clock source is NTP.',
      points: 25,
      dependsOn: ['r1-time'],
      hint: 'A switch can follow a router: the router serves the time it follows, one stratum lower.',
      assertions: [
        { kind: 'fact', device: 'SW1', fact: 'ntp.synced', equals: true, feedback: 'SW1 follows no time server yet.' },
        {
          kind: 'fact',
          device: 'SW1',
          fact: 'ntp.peer',
          equals: 'R1',
          feedback: 'SW1 follows another source than R1.',
          misconception: 'every-device-to-the-reference',
        },
        { kind: 'fact', device: 'SW1', fact: 'ntp.stratum', equals: 3 },
        { kind: 'fact', device: 'SW1', fact: 'clock.source', equals: 'ntp' },
      ],
      feedbackOnFail: 'Each step down the chain adds one to the stratum: SRV1 is 1, R1 2, SW1 3.',
    },
    {
      id: 'local-logs',
      title: 'Stamped logs in R1\'s buffer',
      description: `R1 uses the ${TIME_ZONE_NAME} time zone (UTC+${TIME_ZONE_OFFSET_HOURS}), stamps log lines with the local date and time, milliseconds and the zone, and buffers every severity but debugging.`,
      points: 20,
      hint: 'The buffer level is the most detailed severity it keeps: informational is 6.',
      assertions: [
        { kind: 'fact', device: 'R1', fact: 'logging.buffered', equals: TIME_BUFFER_LEVEL, feedback: `R1's buffer keeps a different level than ${TIME_BUFFER_LEVEL}.` },
        { kind: 'config', device: 'R1', path: 'clock.timezone', equals: `timezone ${TIME_ZONE_NAME} ${TIME_ZONE_OFFSET_HOURS}`, feedback: 'R1 has no clock timezone line for this zone.' },
        { kind: 'config', device: 'R1', path: 'service.timestamps.log', equals: 'timestamps log datetime msec localtime show-timezone', feedback: 'R1 stamps log lines without the local time and the zone.' },
      ],
      feedbackOnFail: 'localtime turns the stamp from UTC to the zone of clock timezone, and show-timezone prints its name.',
    },
    {
      id: 'syslog',
      title: 'Warnings and worse reach SRV1',
      description: `R1 sends its logs up to warnings to SRV1, and SRV1 has received R1's ${TIME_LINK_LOG} line for a link change.`,
      points: 30,
      dependsOn: ['r1-time'],
      hint: 'The receiver must be on before the message is sent; then bring a link of R1 down and up again.',
      assertions: [
        { kind: 'fact', device: 'R1', fact: 'logging.trap', equals: TIME_TRAP_LEVEL, feedback: `R1 sends up to another level than ${TIME_TRAP_LEVEL}.`, misconception: 'trap-level-reversed' },
        {
          kind: 'table',
          device: 'SRV1',
          table: 'syslog-messages',
          where: { hostname: 'R1' },
          whereOps: { message: { op: 'contains', value: TIME_LINK_LOG } },
          exists: true,
          feedback: `SRV1 has not received a ${TIME_LINK_LOG} line from R1 yet: is its receiver on, does R1 send to ${TIME_SERVER_ADDRESS}, and did a link of R1 change after that?`,
        },
      ],
      feedbackOnFail: 'A syslog server keeps only what reached it: a message sent before the receiver was on, or above the trap level, is not there.',
    },
  ],
  solution: {
    SRV1: ['service ntp on', 'service syslog on'],
    R1: [
      `ntp server ${TIME_SERVER_ADDRESS}`,
      `clock timezone ${TIME_ZONE_NAME} ${TIME_ZONE_OFFSET_HOURS}`,
      'service timestamps log datetime msec localtime show-timezone',
      `logging buffered 16384 ${TIME_BUFFER_LEVEL}`,
      `logging host ${TIME_SERVER_ADDRESS}`,
      `logging trap ${TIME_TRAP_LEVEL}`,
      'interface GigabitEthernet0/0',
      'shutdown',
      'no shutdown',
    ],
    SW1: [`ntp server ${TIME_R1_ADDRESS}`],
  },
};

/** The CCNA 3 time and logging labs (lesson 29). */
export const CCNA3_TIME_LABS: readonly ScenarioInfo[] = [ccna3TimeAndLogs];
