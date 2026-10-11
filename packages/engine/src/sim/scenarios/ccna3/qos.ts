/**
 * sim/scenarios/ccna3/qos.ts — the CCNA 3 quality-of-service lab (ARCHITECTURE-P3 §11.1, §11.2, §2.10, §3.5, §3.11,
 * D16; §7 W5 qos; rulings R44 and R26).
 *
 *   • `ccna3-qos-voice-first` — lesson 27 "Marking, queuing and policing" (module "Quality of service"): two desks
 *     share a 128 kb/s serial link to a far site. The learner marks the voice flow EF at the trust boundary (R1's LAN
 *     interface, §3.5), sees the marking arrive (graded live, below), watches the FIFO serial line congest under a bulk
 *     flow, then puts voice first with a low-latency queue on the serial port ([S20], §3.11) and, last, polices the bulk
 *     traffic at the LAN edge ([S21], §3.11 step 6).
 *
 * The world is §3.5's: PC-V (voice) and PC-D (bulk data) on SW1 → R1 Gi0/0; R1 Se0/0/0 (DCE, `clock rate 128000`)
 * 10.0.0.1/30 ↔ R2 Se0/0/0 10.0.0.2/30; R2 Gi0/0 → PC-S. It is P3-profile (`topology(…, { profile: 'P3' })`, schema
 * 1.3); the lesson is not about spanning tree, so every SW1 port faces a host or the router and is an edge port
 * (`spanning-tree portfast`, §11.2). Addresses and static routes are in place, so the network works before the lab
 * starts: the lab is about what the traffic meets, not about reaching the far site.
 *
 * Grading (§2.10's QoS rows, §3.5 step 8, §3.11):
 *   • marking — the list VOICE-PORTS (`acl`) and what it decides (`aclDecision`: the first and the last voice port
 *     permitted, the bulk data's port 9 denied), the class-map match and the `set dscp ef` action (`config`; the CLI
 *     stores `set dscp 46` as `ef`, so an exact `dscp ef` accepts both and refuses CS6 = 48), and the input policy on
 *     Gi0/0 (`fact qos.inputPolicy`), and — §3.5 step 8 — the live `flows` row of PC-S (`{src: PC-V, flow: 'f1',
 *     dscp: 46}`, exact: `ge 46` would pass CS6 = 48). That row exists only after the learner's own bounded voice burst
 *     (step 2 of the text, required before Check): `Simulation.configure` refuses `flow start` (a job), so the lab
 *     gives the burst as data (`QOS_LEARNER_FLOWS`, the shape of lab 15's `ACL_STANDARD_LOGINS`) and the solutions
 *     test types it on PC-V's console after the reference solution. A bounded flow (`count 100`) ends, so
 *     `runToIdle` sees its final row (R44). The config checks alone cannot prove the marking: `config equals` passes
 *     when ANY node at the path matches, so an extra match line that keeps VOIP from ever matching is invisible there;
 *   • LLQ — the class-map, the priority rate and the serial port's bandwidth (`config`), the output policy and its
 *     admission (`fact qos.outputPolicy`, `qos.admitted`), and the `traffic` kind in the grader's clone: an unmarked
 *     voice flow and a 200 kb/s bulk flow run together under `runFor` (R44: continuous flows, never `runToIdle`) and the
 *     voice must arrive whole and within 100 ms (about 50 ms with LLQ: one data frame on the wire plus its own; seconds
 *     and about a tenth lost on the FIFO line; about a tenth lost when the voice is left unmarked in a fair-queued
 *     class-default). This traffic check proves LLQ only while the serial line is congested, i.e. before MARK's
 *     policer exists: once the bulk flow is policed to 64 kb/s at the edge the line never congests in the clone, and
 *     unmarked voice crosses class-default in time too. So this task also carries the marking's own proof (the
 *     `set dscp ef` line, MARK inbound on Gi0/0 and the live EF row at PC-S). An extra match line under VOICE that keeps
 *     the priority class empty is not gradeable with the §2.10 kinds (the traffic kind has no `after` to remove the
 *     policer, and `config` cannot count nodes): reported to the architect (W5 integration, finding #18);
 *   • policing — the policer line of MARK's class-default (`config`), a ping from PC-D that still gets through
 *     (`connectivity`: a policer that drops even conforming packets fails it — it drops the desks' ARP too, since
 *     class-default holds every frame that is not control traffic) and the same two flows in the clone, where the bulk
 *     flow's datagrams now cross the serial line within 300 ms because the excess is dropped at the edge instead of
 *     queued (about 100 ms policed; seconds with LLQ alone, waiting in class-default).
 * test/labs.ccna3.qos.test.ts proves each of these wrong answers with the real checkers.
 *
 * A lab file imports only the contracts, `../kit.js` and `../templates.js` — never `./index.js`, `../index.js` or the
 * engine barrel — so the catalogue stays an acyclic graph of data modules (rule 12).
 *
 * ponytail: the "watch the FIFO link congest" step is an observation, not a task: its evidence (a voice delay above a
 * second) is a live reading that the LLQ step rightly erases, so a task built on it would fail again once the learner
 * fixes the link. The clone's flows carry their own ids, so an expectation names one flow without the source address
 * the live `f1` rows need; the two tasks use different ids (`voice`/`bulk`, `edge-voice`/`edge-bulk`), so their
 * receiver rows never mix, whether the grader runs them in one clone or in two.
 */
import type { LabAssertion, ScenarioInfo } from '../../../contracts/scenario.js';
import { MASK24, MASK30, PC, ROUTER, SWITCH, accessPort, cable, configText, device, link, section, topology } from '../kit.js';
import { pcConfig } from '../templates.js';

/** PC-V, the voice desk. */
export const QOS_LAB_VOICE_IP = '192.168.1.10';
/** PC-D, the bulk-data desk. */
export const QOS_LAB_DATA_IP = '192.168.1.20';
/** PC-S, the far site's receiver. */
export const QOS_LAB_SERVER_IP = '192.168.2.10';
/** The serial line's clock rate (b/s) and its `bandwidth` (kb/s). */
export const QOS_LAB_LINE_BPS = 128_000;
/** The voice port range the marking list matches, and the port the voice flows use. */
export const QOS_LAB_VOICE_PORT_FIRST = 16384;
export const QOS_LAB_VOICE_PORT_LAST = 32767;
/** The priority rate of the voice class (kb/s) and the police rate of the bulk traffic (b/s). */
export const QOS_LAB_PRIORITY_KBPS = 32;
export const QOS_LAB_POLICE_BPS = 64_000;
/** How long the grader's clone runs the two flows (sim time, ms). */
export const QOS_LAB_TRAFFIC_RUN_MS = 10_000;

/** The longest one-way delay the voice flow may see in the grader's clone (ms): one data frame on the wire plus its own. */
export const QOS_LAB_VOICE_MAX_DELAY_MS = 100;
/** The longest one-way delay the bulk flow may see once it is policed at the edge (ms); unpoliced it waits seconds. */
export const QOS_LAB_BULK_MAX_DELAY_MS = 300;

/** A flow of the grader's clone (the `traffic` kind's flow: the spec plus the sending and receiving device names). */
type CloneFlow = Extract<LabAssertion, { kind: 'traffic' }>['flows'][number];

/** Unmarked voice from PC-V (G.729-sized: 50 datagrams of 60 bytes per second, ≈ 26 kb/s on the serial line). */
const voiceFlow = (id: string): CloneFlow => ({ id, from: 'PC-V', to: 'PC-S', dst: QOS_LAB_SERVER_IP, dstPort: QOS_LAB_VOICE_PORT_FIRST, pps: 50, sizeBytes: 60 });
/** 200 kb/s of 1000-byte bulk datagrams from PC-D to the discard port. */
const bulkFlow = (id: string): CloneFlow => ({ id, from: 'PC-D', to: 'PC-S', dst: QOS_LAB_SERVER_IP, rateKbps: 200, sizeBytes: 1000 });

/**
 * The voice burst the learner sends from PC-V before Check (step 2 of the instructions): bounded (`count 100`, 2 s),
 * so it ends and `runToIdle` sees its final row (R44). Data in the shape of lab 15's `ACL_STANDARD_LOGINS`: the
 * console lines typed on each host after the reference solution (`Simulation.configure` refuses a job).
 */
export const QOS_LEARNER_FLOWS: readonly { readonly from: string; readonly lines: readonly string[] }[] = Object.freeze([
  Object.freeze({ from: 'PC-V', lines: Object.freeze([`flow start ${QOS_LAB_SERVER_IP} pps 50 size 60 port ${QOS_LAB_VOICE_PORT_FIRST} count 100`]) }),
]);

/**
 * The live proof of the marking (§3.5 step 8, §2.10's QoS row): PC-S's `flows` row of PC-V's flow `f1` shows DSCP 46
 * exactly (`ge 46` would pass CS6 = 48). The row holds the DSCP of the last datagram received.
 */
function voiceArrivedEf(): LabAssertion {
  return {
    kind: 'table',
    device: 'PC-S',
    table: 'flows',
    where: { src: QOS_LAB_VOICE_IP, flow: 'f1', dscp: 46 },
    exists: true,
    feedback: 'Send the voice burst from PC-V after MARK is attached (step 2): PC-S must see it arrive as EF (46).',
  };
}

/** SW1: every port faces a host or the router, so every one is an edge port (the lesson is not about spanning tree). */
function lanSwitchConfig(): string {
  return configText([['hostname SW1'], ...['FastEthernet0/1', 'FastEthernet0/2', 'GigabitEthernet0/1'].map((p) => accessPort(p, 1, { portfast: true }))]);
}

/** R1: the LAN gateway and the DCE end of the 128 kb/s serial line, with a route to the far site; no QoS yet. */
function edgeRouterConfig(): string {
  return configText([
    ['hostname R1'],
    section('interface GigabitEthernet0/0', [`ip address 192.168.1.1 ${MASK24}`, 'no shutdown']),
    section('interface Serial0/0/0', [`ip address 10.0.0.1 ${MASK30}`, `clock rate ${QOS_LAB_LINE_BPS}`, 'no shutdown']),
    [`ip route 192.168.2.0 ${MASK24} 10.0.0.2`],
  ]);
}

/** R2: the far end of the serial line and the gateway of PC-S. */
function farRouterConfig(): string {
  return configText([
    ['hostname R2'],
    section('interface Serial0/0/0', [`ip address 10.0.0.2 ${MASK30}`, 'no shutdown']),
    section('interface GigabitEthernet0/0', [`ip address 192.168.2.1 ${MASK24}`, 'no shutdown']),
    [`ip route 192.168.1.0 ${MASK24} 10.0.0.1`],
  ]);
}

/** Voice before bulk on a slow serial line: mark at the edge, queue voice first, police the bulk traffic. */
export const ccna3QosVoiceFirst: ScenarioInfo = {
  name: 'ccna3-qos-voice-first',
  category: 'ccna3-lab',
  labType: 'guided',
  course: 'CCNA 3',
  topic: 'Quality of service',
  title: 'Put voice first on a slow link',
  description:
    'A voice desk and a bulk-data desk share a 128 kb/s serial line to the far site. Mark the voice at the trust boundary, watch the line congest with first-in first-out queuing, then give voice a priority queue and police the bulk traffic at the LAN edge.',
  objectives: [
    'Classify traffic with an access list and a class map, and mark it with DSCP EF at the trust boundary',
    'Confirm the marking where the traffic arrives',
    'Explain why marking alone does not protect voice on a congested first-in first-out link',
    'Give voice a low-latency priority queue on the serial port, within the bandwidth the port can admit',
    'Police bulk traffic at the network edge, and tell policing from shaping',
  ],
  tags: ['qos', 'dscp', 'marking', 'trust boundary', 'class-map', 'policy-map', 'llq', 'priority queue', 'policing', 'congestion'],
  difficulty: 3,
  estimatedMinutes: 35,
  requires: [PC, ROUTER, SWITCH],
  seed: 327,
  instructions: [
    '## What you have',
    '',
    `PC-V (\`${QOS_LAB_VOICE_IP}\`) carries voice and PC-D (\`${QOS_LAB_DATA_IP}\`) sends bulk data, both through SW1 to R1. R1 reaches the far site over the serial line \`Serial0/0/0\` (\`10.0.0.0/30\`), which R1 clocks at ${QOS_LAB_LINE_BPS / 1000} kb/s, and R2 delivers to PC-S (\`${QOS_LAB_SERVER_IP}\`). The addresses and routes are already in place. The routers take about 45 s to boot: allow about a minute after the lab loads before the first ping or flow.`,
    '',
    'The desks have a traffic generator in their shell. A flow started without `count` or `for` runs until `flow stop <id>` or for at most 5 minutes; `flow show` lists the flows of a desk, and PC-S keeps one row per received flow in its `flows` table (DSCP, received, lost, delay and jitter).',
    '',
    '## 1. Mark voice at the trust boundary',
    '',
    `R1's \`GigabitEthernet0/0\` is the trust boundary: decide there what each packet is worth, and do not trust what the desks claim.`,
    '',
    `- Create the extended access list \`VOICE-PORTS\` that permits UDP from any source to any destination on ports ${QOS_LAB_VOICE_PORT_FIRST} to ${QOS_LAB_VOICE_PORT_LAST}.`,
    '- Create the class map `VOIP` (match all) that matches that access list by name.',
    '- Create the policy map `MARK` whose class `VOIP` sets DSCP `ef`, and attach it to `GigabitEthernet0/0` in the input direction.',
    '',
    '## 2. See the marking arrive',
    '',
    `Once \`MARK\` is attached, send a short voice-like burst from PC-V to PC-S: \`${QOS_LEARNER_FLOWS[0]!.lines[0]!}\` (100 datagrams in 2 s). Its packets leave PC-V with DSCP 0; read PC-S's \`flows\` table: the row of \`${QOS_LAB_VOICE_IP}\` and \`f1\` should show DSCP 46 (EF). **Check reads this row**, so send the burst before you check (and again if you change the marking). On R1, \`show policy-map interface GigabitEthernet0/0\` counts what the class matched and marked.`,
    '',
    '## 3. Watch a first-in first-out link congest',
    '',
    `Start a continuous voice flow on PC-V (\`flow start ${QOS_LAB_SERVER_IP} pps 50 size 60 port ${QOS_LAB_VOICE_PORT_FIRST}\`), then the bulk flow on PC-D: \`flow start ${QOS_LAB_SERVER_IP} rate 200 size 1000\`. That is 200 kb/s of data plus about 26 kb/s of voice offered to a 128 kb/s line. Turn on the QoS overlay and watch the queue build at R1 \`Serial0/0/0\`, then read PC-S's \`flows\` table again: within a few seconds the voice delay climbs past one second, and within about 30 s the queue is full and both flows lose packets. The voice is marked, but a first-in first-out queue ignores the marking. Stop both flows when you have seen it (\`flow stop f1\` on each desk). The [queueing sandbox](concept:queueing) replays the same two arrival patterns through every queuing method.`,
    '',
    '## 4. Put voice first',
    '',
    '- Create the class map `VOICE` (match all) that matches DSCP `ef`.',
    `- Create the policy map \`WAN-EDGE\` whose class \`VOICE\` gets a priority queue of ${QOS_LAB_PRIORITY_KBPS} kb/s. Optionally give \`class-default\` a fair queue.`,
    `- On \`Serial0/0/0\`, set the interface bandwidth to ${QOS_LAB_LINE_BPS / 1000} kb/s so the router admits the policy against the real line rate, and attach \`WAN-EDGE\` in the output direction.`,
    '',
    'Run both flows again: the voice delay now stays below about 70 ms, one data packet on the wire plus its own, while the bulk data waits and drops in its own queue.',
    '',
    '## 5. Police the bulk traffic at the edge',
    '',
    `Give \`MARK\`'s \`class-default\` a policer of ${QOS_LAB_POLICE_BPS} b/s that transmits conforming packets and drops the excess. The excess bulk traffic is now dropped as it enters R1, before it can fill the serial queue; \`show policy-map interface GigabitEthernet0/0\` counts the conforming and exceeding packets. A shaper would have queued the excess and sent it later instead of dropping it.`,
    '',
    `*Check also runs its own voice and bulk flows in a copy of your network for ${QOS_LAB_TRAFFIC_RUN_MS / 1000} s of simulated time, so apart from the voice burst of step 2 your own flows are for watching only: you do not need to leave them running before you check.*`,
  ].join('\n'),
  build: () =>
    topology(
      327,
      [
        device('pcv', PC, 'PC-V', 80, 170, pcConfig('PC-V', QOS_LAB_VOICE_IP, MASK24, '192.168.1.1')),
        device('pcd', PC, 'PC-D', 80, 330, pcConfig('PC-D', QOS_LAB_DATA_IP, MASK24, '192.168.1.1')),
        device('sw1', SWITCH, 'SW1', 250, 250, lanSwitchConfig()),
        device('r1', ROUTER, 'R1', 440, 250, edgeRouterConfig()),
        device('r2', ROUTER, 'R2', 660, 250, farRouterConfig()),
        device('pcs', PC, 'PC-S', 860, 250, pcConfig('PC-S', QOS_LAB_SERVER_IP, MASK24, '192.168.2.1')),
      ],
      [
        link('l_pcv_sw1', 'pcv', 'GigabitEthernet0', 'sw1', 'FastEthernet0/1'),
        link('l_pcd_sw1', 'pcd', 'GigabitEthernet0', 'sw1', 'FastEthernet0/2'),
        link('l_sw1_r1', 'sw1', 'GigabitEthernet0/1', 'r1', 'GigabitEthernet0/0'),
        cable('l_r1_r2', 'r1', 'Serial0/0/0', 'r2', 'Serial0/0/0', 'serial-dce'),
        link('l_r2_pcs', 'r2', 'GigabitEthernet0/0', 'pcs', 'GigabitEthernet0'),
      ],
      ['Mark voice EF at the trust boundary', 'Give voice a priority queue on the serial line', 'Police the bulk traffic at the LAN edge'],
      'Marking says what a packet is worth; queuing decides who goes first when the line is busy; policing drops what exceeds a rate, where shaping would delay it.',
      { profile: 'P3' },
    ),
  tasks: [
    {
      id: 'mark-voice',
      title: 'Mark voice EF at the trust boundary',
      description: `R1 classifies UDP ports ${QOS_LAB_VOICE_PORT_FIRST}-${QOS_LAB_VOICE_PORT_LAST} with the extended list VOICE-PORTS and the class map VOIP, and the policy map MARK, attached to GigabitEthernet0/0 inbound, sets DSCP EF on that class.`,
      points: 30,
      hint: 'Three pieces chain together: the access list says which packets, the class map names them, and the policy map says what to do with the class. Nothing happens until the policy is attached to an interface.',
      assertions: [
        { kind: 'acl', device: 'R1', list: 'VOICE-PORTS', type: 'extended' },
        {
          kind: 'aclDecision',
          device: 'R1',
          list: 'VOICE-PORTS',
          packet: { proto: 'udp', src: 'PC-V', dst: 'PC-S', dstPort: QOS_LAB_VOICE_PORT_FIRST },
          expect: 'permit',
          feedback: `VOICE-PORTS must permit UDP to port ${QOS_LAB_VOICE_PORT_FIRST}, the first voice port.`,
        },
        {
          kind: 'aclDecision',
          device: 'R1',
          list: 'VOICE-PORTS',
          packet: { proto: 'udp', src: 'PC-V', dst: 'PC-S', dstPort: QOS_LAB_VOICE_PORT_LAST },
          expect: 'permit',
          feedback: `VOICE-PORTS must permit UDP to port ${QOS_LAB_VOICE_PORT_LAST}, the last voice port.`,
        },
        {
          kind: 'aclDecision',
          device: 'R1',
          list: 'VOICE-PORTS',
          packet: { proto: 'udp', src: 'PC-D', dst: 'PC-S', dstPort: 9 },
          expect: 'deny',
          feedback: 'The bulk data (UDP port 9) must not match VOICE-PORTS, or it would be marked as voice too.',
        },
        {
          kind: 'aclDecision',
          device: 'R1',
          list: 'VOICE-PORTS',
          packet: { proto: 'udp', src: 'PC-D', dst: 'PC-S', dstPort: QOS_LAB_VOICE_PORT_FIRST - 1 },
          expect: 'deny',
          feedback: `VOICE-PORTS must match only the voice ports ${QOS_LAB_VOICE_PORT_FIRST}-${QOS_LAB_VOICE_PORT_LAST}.`,
        },
        {
          kind: 'aclDecision',
          device: 'R1',
          list: 'VOICE-PORTS',
          packet: { proto: 'udp', src: 'PC-D', dst: 'PC-S', dstPort: QOS_LAB_VOICE_PORT_LAST + 1 },
          expect: 'deny',
          feedback: `VOICE-PORTS must match only the voice ports ${QOS_LAB_VOICE_PORT_FIRST}-${QOS_LAB_VOICE_PORT_LAST}.`,
        },
        { kind: 'config', device: 'R1', path: 'class-map.match-all.VOIP.match', equals: 'access-group name VOICE-PORTS' },
        {
          kind: 'config',
          device: 'R1',
          path: 'policy-map.MARK.class.VOIP.set',
          equals: 'dscp ef',
          feedback: 'Voice is marked EF (DSCP 46). CS6 (48) and the AF classes mean something else to every queue on the way.',
        },
        {
          kind: 'fact',
          device: 'R1',
          fact: 'qos.inputPolicy',
          subject: 'GigabitEthernet0/0',
          equals: 'MARK',
          feedback: 'Mark where the traffic enters the network you trust: inbound on the LAN interface, before any routing decision.',
        },
        voiceArrivedEf(),
      ],
      feedbackOnFail: 'A marking policy does nothing until it is attached, and it marks only what its class matches.',
    },
    {
      id: 'voice-first',
      title: 'Put voice first on the serial line',
      description: `R1 Serial0/0/0 has a bandwidth of ${QOS_LAB_LINE_BPS / 1000} kb/s and the output policy WAN-EDGE, whose class VOICE (DSCP EF) gets a ${QOS_LAB_PRIORITY_KBPS} kb/s priority queue; with voice and 200 kb/s of bulk data offered together, every voice packet arrives within ${QOS_LAB_VOICE_MAX_DELAY_MS} ms.`,
      points: 40,
      dependsOn: ['mark-voice'],
      hint: 'Queuing happens where packets wait: on the way out of the slow serial interface. Match the voice by the DSCP that R1 has just written.',
      assertions: [
        // the marking the priority class relies on: the traffic check below cannot tell once the bulk is policed
        { kind: 'config', device: 'R1', path: 'policy-map.MARK.class.VOIP.set', equals: 'dscp ef', feedback: 'The priority class matches EF, so the voice must be marked EF at the edge.' },
        { kind: 'fact', device: 'R1', fact: 'qos.inputPolicy', subject: 'GigabitEthernet0/0', equals: 'MARK' },
        voiceArrivedEf(),
        { kind: 'config', device: 'R1', path: 'class-map.match-all.VOICE.match', equals: 'dscp ef' },
        { kind: 'config', device: 'R1', path: 'policy-map.WAN-EDGE.class.VOICE.priority', equals: String(QOS_LAB_PRIORITY_KBPS) },
        {
          kind: 'config',
          device: 'R1',
          path: 'interface.Serial0/0/0.bandwidth',
          equals: String(QOS_LAB_LINE_BPS / 1000),
          feedback: 'The bandwidth line tells the router how fast the line really is; the clock rate alone does not.',
        },
        {
          kind: 'fact',
          device: 'R1',
          fact: 'qos.outputPolicy',
          subject: 'Serial0/0/0',
          equals: 'WAN-EDGE',
          feedback: 'A queuing policy works only in the output direction, on the interface where the queue forms.',
        },
        {
          kind: 'fact',
          device: 'R1',
          fact: 'qos.admitted',
          subject: 'Serial0/0/0',
          equals: true,
          feedback: 'The router reserves at most 75 % of the interface bandwidth for priority and bandwidth classes.',
        },
        {
          kind: 'traffic',
          flows: [voiceFlow('voice'), bulkFlow('bulk')],
          runMs: QOS_LAB_TRAFFIC_RUN_MS,
          expect: [{ receiver: 'PC-S', flow: 'voice', maxLossPct: 0, maxDelayMs: QOS_LAB_VOICE_MAX_DELAY_MS }],
          feedback: 'While the line is congested, voice keeps its delay only in a priority queue big enough for it.',
        },
      ],
      feedbackOnFail: 'Marking alone does not protect voice: on a first-in first-out queue a voice packet waits behind every data packet ahead of it.',
    },
    {
      id: 'police-bulk',
      title: 'Police the bulk traffic at the edge',
      description: `MARK's class-default polices to ${QOS_LAB_POLICE_BPS} b/s, transmitting what conforms and dropping the excess, so PC-D still reaches PC-S and its bulk data crosses the serial line within ${QOS_LAB_BULK_MAX_DELAY_MS} ms instead of queuing for seconds.`,
      points: 30,
      dependsOn: ['mark-voice'],
      hint: 'Everything the VOIP class does not match falls into class-default of the same policy map; give that class a policer.',
      assertions: [
        {
          kind: 'config',
          device: 'R1',
          path: `policy-map.MARK.class.class-default.police.${QOS_LAB_POLICE_BPS}`,
          contains: 'conform-action transmit',
          feedback: `Police class-default of MARK at ${QOS_LAB_POLICE_BPS} b/s and transmit what conforms.`,
        },
        {
          kind: 'config',
          device: 'R1',
          path: `policy-map.MARK.class.class-default.police.${QOS_LAB_POLICE_BPS}`,
          contains: 'exceed-action drop',
          feedback: 'A policer drops what exceeds the rate; a shaper would hold it back and send it later.',
        },
        {
          kind: 'connectivity',
          from: 'PC-D',
          to: 'PC-S',
          expect: 'success',
          feedback: 'A ping from PC-D falls in class-default too: a policer that drops even conforming packets cuts the desk off.',
        },
        {
          kind: 'traffic',
          flows: [voiceFlow('edge-voice'), bulkFlow('edge-bulk')],
          runMs: QOS_LAB_TRAFFIC_RUN_MS,
          expect: [
            { receiver: 'PC-S', flow: 'edge-bulk', maxDelayMs: QOS_LAB_BULK_MAX_DELAY_MS },
            { receiver: 'PC-S', flow: 'edge-voice', maxLossPct: 0 },
          ],
          feedback: 'Dropped at the edge, the excess bulk data never reaches the serial queue, so what is left of it crosses quickly.',
        },
      ],
      feedbackOnFail: 'Policing drops the traffic above a rate where it enters; it does not delay it.',
    },
  ],
  solution: {
    R1: [
      'ip access-list extended VOICE-PORTS',
      `permit udp any any range ${QOS_LAB_VOICE_PORT_FIRST} ${QOS_LAB_VOICE_PORT_LAST}`,
      'exit',
      'class-map match-all VOIP',
      'match access-group name VOICE-PORTS',
      'exit',
      'policy-map MARK',
      'class VOIP',
      'set dscp ef',
      'exit',
      'class class-default',
      `police ${QOS_LAB_POLICE_BPS} conform-action transmit exceed-action drop`,
      'exit',
      'exit',
      'interface GigabitEthernet0/0',
      'service-policy input MARK',
      'exit',
      'class-map match-all VOICE',
      'match dscp ef',
      'exit',
      'policy-map WAN-EDGE',
      'class VOICE',
      `priority ${QOS_LAB_PRIORITY_KBPS}`,
      'exit',
      'class class-default',
      'fair-queue',
      'exit',
      'exit',
      'interface Serial0/0/0',
      `bandwidth ${QOS_LAB_LINE_BPS / 1000}`,
      'service-policy output WAN-EDGE',
    ],
  },
};

/** The quality-of-service labs, in course order. */
export const CCNA3_QOS_LABS: readonly ScenarioInfo[] = [ccna3QosVoiceFirst];

