/**
 * sim/scenarios/ccna3/acl.ts — the CCNA 3 access-list labs (ARCHITECTURE-P3 §11.1 module 6 "Access control lists",
 * §11.2; §3.3, §3.14, D12, D14, §5.2, [S13]).
 *
 *   • `ccna3-acl-standard` — lesson 15 "Standard ACLs": two routers join a staff LAN, a guest LAN, a server LAN and an
 *     information LAN everyone may use. The learner writes a NUMBERED standard list on R2 that keeps everything but the
 *     staff off the server LAN and a NAMED standard list on R1 that keeps the guests off the staff LAN, each applied
 *     outbound on the interface that faces the protected LAN (near the destination), so the guests still reach INFO;
 *     then guards R1's remote lines with standard list 10 bound by `access-class 10 in` (§3.14). SSH itself is already
 *     configured on R1 (lesson 19 teaches it). The remote-line work is graded twice over (§3.14 step 8, §11.2 "graded
 *     live through the remote terminal"): LIVE, from the learner's own attempts — an SSH login from PC1 and one refused
 *     by the access class in R1's `vty-logins`, both counted on the vty rows of list 10 (a permit row and a deny row,
 *     read by action rather than sequence number, so a remark or an explicit `deny any` changes no verdict) — and in
 *     the grader's CLONE with the [S13] `service` kind, which logs in by itself (PC1: success; PC2:
 *     refused), so the configuration is confirmed independently of the learner's attempts.
 *   • `ccna3-acl-extended` — lesson 16 "Extended ACLs" (§3.3's world): PC1 must not open the web server while every
 *     other desk may and PC1 may still ping it (`NO-WEB-PC1`, inbound on R1 `GigabitEthernet0/0`, near the source);
 *     the server LAN may only answer — TCP segments of connections the staff opened (`established`) and echo replies —
 *     never open anything toward the staff (`FROM-SERVERS`, inbound on R1 `GigabitEthernet0/1`, near that source).
 *   • `ccna3-acl-edit-verify` — lesson 17 "Editing and reading ACLs" (troubleshoot): a colleague's edit of R1's list
 *     `SERVERS-IN`, a hidden configuration change that lands once R1 has booted, appended the kiosk's deny below the
 *     permit that already matches it (so it never counts) and retyped the ping entry with a /29 wildcard (so no desk
 *     can ping the servers). The learner reads the match counters, inserts the deny as entry 5 with `log`, replaces
 *     entry 20 in place, removes the dead entry and adds a remark — all by sequence number, without retyping the list.
 *
 * P3-profile worlds (`topology(…, {profile: 'P3'})`, schema 1.3); no lesson here is about spanning tree, so host
 * ports and router-facing access ports are PortFast in the startup configuration (§11.2). Routes are static, so the
 * only timing the instructions name is the routers' 45 s boot ("about a minute"), and in lab 17 the hidden change
 * that lands at 50 s. Tasks read structured state with the §2.10 kinds: `acl` (type, bindings read from the
 * configuration, exact entries, the hit count of one entry from the `acl` table), `aclDecision` (pure: the CONFIGURED
 * list evaluated against a probe), `connectivity` (ICMP and TCP probes in the clone, `droppedAt` / `dropReason` from
 * the clone trace, and the clone's counters through `then`), `table` (`vty-logins`, live), `config` (the remark) and
 * [S13] `service`. Every lab carries a reference `solution` that `Simulation.configure` accepts as written. The
 * live-login task of lab 15 needs the learner's own logins, which no configuration line can make (a remote login is a
 * job, which a headless configure session refuses), so the logins a learner types before Check are data too:
 * `ACL_STANDARD_LOGINS`, in the shape `ccna3/hardening.ts` gives lab 19's (what a solutions test types on the PCs'
 * consoles after the solution). All wording is original (§0 rule 6); no vendor is named.
 *
 * A lab file imports only the contracts, `../kit.js` and `../templates.js` (rule 12: the catalogue reads the arrays at
 * module scope, so no lab file may import it back). Every exported name carries an `ACL_` or `ccna3Acl` prefix, since
 * `ccna3/index.ts` re-exports every lab file with `export *`.
 *
 * ponytail: the counters of lab 17 are graded in the grader's clone (`connectivity.then` reads the `acl` rows after
 * the probe, the P2 NAT-lab pattern), not in the live world: a live count needs traffic the learner makes, which a
 * reference solution of configuration lines cannot hold. Lab 15's live task is the one exception the brief asks for.
 * The clone's rows are found by their entry TEXT: the clone boots from the export, whose lists carry no sequence
 * numbers, so its entries are numbered 10, 20, 30 … again (D12, exactly as a reload does); the numbers the learner
 * chose are graded live, by `aclDecision`, and the instructions warn that a reload renumbers.
 */
import type { LabAssertion, ScenarioInfo } from '../../../contracts/scenario.js';
import { SEC } from '../../../contracts/time.js';
import { MASK24, MASK30, PC, ROUTER, SERVER, SWITCH, accessPort, cable, configFragmentFault, configText, device, link, section, topology } from '../kit.js';
import { pcConfig } from '../templates.js';

/** The module that holds lessons 14-18 (§11.1): every lab's `topic`. */
const ACL_TOPIC = 'Access control lists';

/** The timing sentence of the labs whose routers boot with the world (§11.2: the 45 s router boot). */
const ROUTER_BOOT_NOTE = '*The routers take about 45 s to boot: allow about a minute after the lab loads before the first ping or login.*';

// ── lab 15: standard ACLs and the remote lines ───────────────────────────────

/** The addresses of lab 15: four LANs and the serial link between R1 and R2. */
export const ACL_STANDARD_ADDRESSES = Object.freeze({
  r1Staff: '192.168.10.1',
  r1Guest: '192.168.20.1',
  r1Wan: '10.0.12.1',
  r2Wan: '10.0.12.2',
  r2Servers: '192.168.30.1',
  r2Info: '192.168.40.1',
  pc1: '192.168.10.10',
  pc2: '192.168.10.11',
  guest: '192.168.20.10',
  srv: '192.168.30.100',
  info: '192.168.40.100',
});
/** The local user R1 already accepts over SSH, and its password (a lab value, printed in the instructions). */
export const ACL_STANDARD_USER = 'admin';
export const ACL_STANDARD_SECRET = 'Vty-Guard15';
/** The numbered list of the server LAN (R2), the named list of the staff LAN (R1) and the vty list (R1, §3.14). */
export const ACL_STANDARD_SERVER_LIST = '30';
export const ACL_STANDARD_STAFF_LIST = 'NO-GUESTS';
export const ACL_STANDARD_VTY_LIST = '10';
/** The clock rate R1 gives the serial link (it holds the DCE end). */
export const ACL_STANDARD_CLOCK_RATE_BPS = 128_000;

/**
 * @since P3 The learner's own logins lab 15 asks for before Check (§11.2: one admitted, one refused), as the lines a
 * learner types on each PC's console — a remote login is a job, which `Simulation.configure` refuses, so the reference
 * solution cannot hold them. Each `lines` entry is one console line; the password line answers the client's password
 * question. PC1 logs in over SSH and logs out; PC2 is refused by `access-class 10`. (Same shape as lab 19's
 * `SECURE_ACCESS_LOGINS`.)
 */
export const ACL_STANDARD_LOGINS: readonly { readonly from: string; readonly lines: readonly string[] }[] = Object.freeze([
  { from: 'PC1', lines: [`ssh -l ${ACL_STANDARD_USER} ${ACL_STANDARD_ADDRESSES.r1Staff}`, ACL_STANDARD_SECRET, 'exit'] },
  { from: 'PC2', lines: [`ssh -l ${ACL_STANDARD_USER} ${ACL_STANDARD_ADDRESSES.r1Staff}`, ACL_STANDARD_SECRET] },
]);

const A15 = ACL_STANDARD_ADDRESSES;

/** SW1: the two staff PCs and R1, all edge ports (a router sends no BPDU). */
function standardSw1Config(): string {
  return configText([
    ['hostname SW1'],
    accessPort('FastEthernet0/1', 1, { portfast: true }),
    accessPort('FastEthernet0/2', 1, { portfast: true }),
    accessPort('GigabitEthernet0/1', 1, { portfast: true }),
  ]);
}

/** R1: the staff and guest LANs, the DCE end of the serial link, routes to R2's LANs, and SSH for `admin` already on. */
function standardR1Config(): string {
  return configText([
    ['hostname R1'],
    ['ip domain-name lab.nf'],
    ['crypto key generate rsa modulus 1024'],
    ['ip ssh version 2'],
    [`username ${ACL_STANDARD_USER} secret ${ACL_STANDARD_SECRET}`],
    section('interface GigabitEthernet0/0', [`ip address ${A15.r1Staff} ${MASK24}`, 'no shutdown']),
    section('interface GigabitEthernet0/1', [`ip address ${A15.r1Guest} ${MASK24}`, 'no shutdown']),
    section('interface Serial0/0/0', [`ip address ${A15.r1Wan} ${MASK30}`, `clock rate ${ACL_STANDARD_CLOCK_RATE_BPS}`, 'no shutdown']),
    [`ip route 192.168.30.0 ${MASK24} ${A15.r2Wan}`, `ip route 192.168.40.0 ${MASK24} ${A15.r2Wan}`],
    section('line vty 0 4', ['login local', 'transport input ssh']),
  ]);
}

/** R2: the server and information LANs, the DTE end of the serial link, routes back to R1's LANs. */
function standardR2Config(): string {
  return configText([
    ['hostname R2'],
    section('interface GigabitEthernet0/0', [`ip address ${A15.r2Servers} ${MASK24}`, 'no shutdown']),
    section('interface GigabitEthernet0/1', [`ip address ${A15.r2Info} ${MASK24}`, 'no shutdown']),
    section('interface Serial0/0/0', [`ip address ${A15.r2Wan} ${MASK30}`, 'no shutdown']),
    [`ip route 192.168.10.0 ${MASK24} ${A15.r1Wan}`, `ip route 192.168.20.0 ${MASK24} ${A15.r1Wan}`],
  ]);
}

/** An SSH login of the grader's clone toward R1 (§3.14 step 8). */
function sshProbe(from: string, expect: 'success' | 'refused'): LabAssertion {
  return { kind: 'service', from, to: 'R1', service: 'ssh', user: ACL_STANDARD_USER, password: ACL_STANDARD_SECRET, expect };
}

/** Four LANs on two routers, no list anywhere: every host reaches every other one. */
export const ccna3AclStandard: ScenarioInfo = {
  name: 'ccna3-acl-standard',
  category: 'ccna3-lab',
  labType: 'guided',
  course: 'CCNA 3',
  topic: ACL_TOPIC,
  title: 'Standard lists near the destination',
  description:
    'Keep the guests off the server LAN and off the staff LAN with standard access lists, one numbered and one named, each placed next to the LAN it protects so the guests can still reach the information server. Then let only the administrator log in to R1 remotely.',
  objectives: [
    'Write a numbered standard access list and a named one',
    'Apply a standard list outbound, next to the LAN it protects',
    'Explain why a standard list placed near the source blocks too much',
    'Guard the remote lines of a router with access-class',
    'Read the logins a router admitted and refused',
  ],
  tags: ['acl', 'standard acl', 'named acl', 'wildcard', 'access-group', 'access-class', 'vty', 'ssh'],
  difficulty: 2,
  estimatedMinutes: 30,
  requires: [PC, ROUTER, SERVER, SWITCH],
  seed: 315,
  instructions: [
    '## What you have',
    '',
    `R1 serves two LANs: the staff LAN \`192.168.10.0/24\` on \`GigabitEthernet0/0\` (PC1 \`${A15.pc1}\`, the administrator's PC, and PC2 \`${A15.pc2}\`, both behind SW1) and the guest LAN \`192.168.20.0/24\` on \`GigabitEthernet0/1\` (GUEST \`${A15.guest}\`). Across the serial link \`10.0.12.0/30\`, R2 serves the server LAN \`192.168.30.0/24\` on \`GigabitEthernet0/0\` (SRV \`${A15.srv}\`) and the information LAN \`192.168.40.0/24\` on \`GigabitEthernet0/1\` (INFO \`${A15.info}\`), which everybody may use. The static routes are in place, so today every host reaches every other one.`,
    '',
    `R1 already accepts SSH logins for the local user \`${ACL_STANDARD_USER}\` (password \`${ACL_STANDARD_SECRET}\`) from anywhere.`,
    '',
    '## What to do',
    '',
    `- **A numbered list on R2.** Only the staff LAN may reach the server LAN. Write standard list ${ACL_STANDARD_SERVER_LIST} that permits \`192.168.10.0 0.0.0.255\` and apply it **outbound** on R2 \`GigabitEthernet0/0\`, the interface that faces SRV. GUEST must still reach INFO.`,
    `- **A named list on R1.** The guests must not reach the staff LAN. Write the standard list \`${ACL_STANDARD_STAFF_LIST}\` that denies the guest LAN and permits everything else, and apply it **outbound** on R1 \`GigabitEthernet0/0\`, toward the staff.`,
    `- **The remote lines.** Only PC1 may log in to R1. Write standard list ${ACL_STANDARD_VTY_LIST} that permits the single host \`${A15.pc1}\` and bind it to \`line vty 0 4\` with \`access-class ${ACL_STANDARD_VTY_LIST} in\`.`,
    `- **Try it before you check.** On PC1 type \`ssh -l ${ACL_STANDARD_USER} ${A15.r1Staff}\` and give the password: you reach \`R1>\` (type \`exit\` to leave). Do the same on PC2: R1 must refuse it. The remote-line task reads R1's record of these two attempts.`,
    `- Ping SRV and INFO from GUEST and from PC1, read \`show access-lists\` on both routers and watch which entry counts each packet. A list that denies a packet also answers with an ICMP "administratively prohibited" message.`,
    '',
    'A standard list looks only at the source address, so it belongs next to the destination: placed near the source it would also cut that source off from everything else. Its wildcard mask marks the bits that may differ, `0.0.0.255` for a whole /24; the [wildcard view](concept:wildcard) shows them bit by bit.',
    '',
    ROUTER_BOOT_NOTE,
  ].join('\n'),
  build: () =>
    topology(
      315,
      [
        device('pc1', PC, 'PC1', 80, 110, pcConfig('PC1', A15.pc1, MASK24, A15.r1Staff)),
        device('pc2', PC, 'PC2', 80, 270, pcConfig('PC2', A15.pc2, MASK24, A15.r1Staff)),
        device('sw1', SWITCH, 'SW1', 240, 190, standardSw1Config()),
        device('r1', ROUTER, 'R1', 420, 190, standardR1Config()),
        device('guest', PC, 'GUEST', 420, 370, pcConfig('GUEST', A15.guest, MASK24, A15.r1Guest)),
        device('r2', ROUTER, 'R2', 640, 190, standardR2Config()),
        device('srv', SERVER, 'SRV', 820, 110, pcConfig('SRV', A15.srv, MASK24, A15.r2Servers)),
        device('info', SERVER, 'INFO', 820, 270, pcConfig('INFO', A15.info, MASK24, A15.r2Info)),
      ],
      [
        link('l_pc1_sw1', 'pc1', 'GigabitEthernet0', 'sw1', 'FastEthernet0/1'),
        link('l_pc2_sw1', 'pc2', 'GigabitEthernet0', 'sw1', 'FastEthernet0/2'),
        link('l_sw1_r1', 'sw1', 'GigabitEthernet0/1', 'r1', 'GigabitEthernet0/0'),
        link('l_guest_r1', 'guest', 'GigabitEthernet0', 'r1', 'GigabitEthernet0/1'),
        cable('l_r1_r2', 'r1', 'Serial0/0/0', 'r2', 'Serial0/0/0', 'serial-dce'),
        link('l_r2_srv', 'r2', 'GigabitEthernet0/0', 'srv', 'GigabitEthernet0'),
        link('l_r2_info', 'r2', 'GigabitEthernet0/1', 'info', 'GigabitEthernet0'),
      ],
      ['Keep the guests off the server and staff LANs', 'Place each standard list next to the LAN it protects', 'Let only the administrator log in to R1'],
      'A standard list matches the source address only. Applied outbound next to the protected LAN, it stops nothing else.',
      { profile: 'P3' },
    ),
  tasks: [
    {
      id: 'server-list',
      title: 'Keep the server LAN for the staff',
      description: `Standard list ${ACL_STANDARD_SERVER_LIST} on R2 admits only the staff LAN to SRV, applied outbound on GigabitEthernet0/0; GUEST still reaches INFO.`,
      points: 25,
      hint: `A numbered standard list takes a number from 1 to 99. Bind it with \`ip access-group ${ACL_STANDARD_SERVER_LIST} out\` on the interface that faces SRV.`,
      assertions: [
        { kind: 'acl', device: 'R2', list: ACL_STANDARD_SERVER_LIST, type: 'standard', applied: [{ iface: 'GigabitEthernet0/0', dir: 'out' }] },
        { kind: 'aclDecision', device: 'R2', list: ACL_STANDARD_SERVER_LIST, packet: { proto: 'ip', src: 'PC2', dst: 'SRV' }, expect: 'permit' },
        { kind: 'aclDecision', device: 'R2', list: ACL_STANDARD_SERVER_LIST, packet: { proto: 'ip', src: 'GUEST', dst: 'SRV' }, expect: 'deny' },
        // every source but the staff LAN: 'deny the guests, permit any' lets INFO through
        { kind: 'aclDecision', device: 'R2', list: ACL_STANDARD_SERVER_LIST, packet: { proto: 'ip', src: 'INFO', dst: 'SRV' }, expect: 'deny', feedback: 'Only the staff LAN may reach SRV: every other source falls to the implicit deny.' },
        // the whole staff LAN, not only the two PCs
        { kind: 'aclDecision', device: 'R2', list: ACL_STANDARD_SERVER_LIST, packet: { proto: 'ip', src: '192.168.10.99', dst: 'SRV' }, expect: 'permit', feedback: 'Permit the whole staff LAN with a wildcard mask, not single hosts.' },
        { kind: 'connectivity', from: 'PC1', to: 'SRV', expect: 'success' },
        {
          kind: 'connectivity',
          from: 'GUEST',
          to: 'SRV',
          expect: 'fail',
          droppedAt: 'R2',
          dropReason: 'acl-deny',
          feedback: 'The guest packets must die at R2, by the list that guards the server LAN.',
        },
        {
          kind: 'connectivity',
          from: 'GUEST',
          to: 'INFO',
          expect: 'success',
          feedback: 'A standard list sees only the source: placed anywhere but next to SRV, it also cuts the guests off from INFO.',
          misconception: 'standard-acl-near-source',
        },
      ],
      feedbackOnFail: 'Write the list on R2 and apply it outbound on the interface that faces SRV.',
    },
    {
      id: 'staff-list',
      title: 'Keep the guests off the staff LAN',
      description: `The named standard list ${ACL_STANDARD_STAFF_LIST} on R1 denies the guest LAN and permits everything else, applied outbound on GigabitEthernet0/0.`,
      points: 25,
      hint: `\`ip access-list standard ${ACL_STANDARD_STAFF_LIST}\` opens the list; without a final permit its implicit deny would refuse every other source too.`,
      assertions: [
        { kind: 'acl', device: 'R1', list: ACL_STANDARD_STAFF_LIST, type: 'standard', applied: [{ iface: 'GigabitEthernet0/0', dir: 'out' }] },
        { kind: 'aclDecision', device: 'R1', list: ACL_STANDARD_STAFF_LIST, packet: { proto: 'ip', src: 'GUEST', dst: 'PC2' }, expect: 'deny' },
        { kind: 'aclDecision', device: 'R1', list: ACL_STANDARD_STAFF_LIST, packet: { proto: 'ip', src: '192.168.20.77', dst: 'PC2' }, expect: 'deny', feedback: 'Deny the whole guest LAN, not only the one guest host.' },
        {
          kind: 'aclDecision',
          device: 'R1',
          list: ACL_STANDARD_STAFF_LIST,
          packet: { proto: 'ip', src: 'SRV', dst: 'PC2' },
          expect: 'permit',
          feedback: 'Every list ends with an implicit deny: permit everything that is not a guest.',
          misconception: 'implicit-deny-forgotten',
        },
        { kind: 'connectivity', from: 'GUEST', to: 'PC2', expect: 'fail', droppedAt: 'R1', dropReason: 'acl-deny' },
        { kind: 'connectivity', from: 'INFO', to: 'PC2', expect: 'success' },
        { kind: 'connectivity', from: 'GUEST', to: 'INFO', expect: 'success' },
      ],
      feedbackOnFail: 'Apply the named list outbound on the interface that faces the staff LAN.',
    },
    {
      id: 'vty-list',
      title: 'Let only PC1 reach the remote lines',
      description: `Standard list ${ACL_STANDARD_VTY_LIST} permits PC1 alone and is bound to R1's vty lines inbound; in the grader's copy PC1 logs in over SSH and PC2 is refused.`,
      points: 20,
      hint: `Remote lines take a list with \`access-class ${ACL_STANDARD_VTY_LIST} in\` under \`line vty 0 4\`, not with ip access-group.`,
      assertions: [
        { kind: 'acl', device: 'R1', list: ACL_STANDARD_VTY_LIST, type: 'standard', applied: [{ vty: true, dir: 'in' }] },
        { kind: 'aclDecision', device: 'R1', list: ACL_STANDARD_VTY_LIST, packet: { proto: 'ip', src: 'PC1', dst: A15.r1Staff }, expect: 'permit' },
        { kind: 'aclDecision', device: 'R1', list: ACL_STANDARD_VTY_LIST, packet: { proto: 'ip', src: 'PC2', dst: A15.r1Staff }, expect: 'deny' },
        // three more sources, one per LAN the list could leave open: 'deny PC2, permit any' admits all three; adding the
        // guest LAN's deny still admits INFO and any other staff host; 'deny PC2, permit the staff LAN' admits the latter
        { kind: 'aclDecision', device: 'R1', list: ACL_STANDARD_VTY_LIST, packet: { proto: 'ip', src: 'GUEST', dst: A15.r1Guest }, expect: 'deny', feedback: 'Permit PC1 alone and let the implicit deny refuse every other host.', misconception: 'deny-one-permit-the-rest' },
        { kind: 'aclDecision', device: 'R1', list: ACL_STANDARD_VTY_LIST, packet: { proto: 'ip', src: 'INFO', dst: A15.r1Staff }, expect: 'deny', feedback: 'Permit PC1 alone and let the implicit deny refuse every other host.', misconception: 'deny-one-permit-the-rest' },
        { kind: 'aclDecision', device: 'R1', list: ACL_STANDARD_VTY_LIST, packet: { proto: 'ip', src: '192.168.10.99', dst: A15.r1Staff }, expect: 'deny', feedback: 'Permit PC1 alone and let the implicit deny refuse every other host.', misconception: 'deny-one-permit-the-rest' },
        sshProbe('PC1', 'success'),
        sshProbe('PC2', 'refused'),
      ],
    },
    {
      id: 'vty-logins',
      title: 'Prove it with real logins',
      description: 'R1 recorded an SSH login from PC1 and a login refused by the access class, and list 10 counted both on its vty rows.',
      points: 30,
      dependsOn: ['vty-list'],
      hint: `Log in from PC1 with \`ssh -l ${ACL_STANDARD_USER} ${A15.r1Staff}\`, then try the same from PC2, after list ${ACL_STANDARD_VTY_LIST} is bound to the lines.`,
      assertions: [
        { kind: 'table', device: 'R1', table: 'vty-logins', where: { proto: 'ssh', result: 'success', peer: A15.pc1 }, exists: true },
        { kind: 'table', device: 'R1', table: 'vty-logins', where: { proto: 'ssh', result: 'refused', reason: `access-class ${ACL_STANDARD_VTY_LIST}` }, exists: true },
        { kind: 'acl', device: 'R1', list: ACL_STANDARD_VTY_LIST, applied: [{ vty: true, dir: 'in' }] },
        // the list counted both logins on its vty rows, whatever their sequence numbers (a remark takes a number) and
        // whether the refusal fell to the implicit deny or to an explicit `deny any`
        {
          kind: 'table',
          device: 'R1',
          table: 'acl',
          where: { list: ACL_STANDARD_VTY_LIST, action: 'permit', lastIface: 'vty' },
          whereOps: { matches: { op: 'ge', value: 1 } },
          exists: true,
          feedback: `List ${ACL_STANDARD_VTY_LIST} has not yet counted PC1's login on the remote lines.`,
        },
        {
          kind: 'table',
          device: 'R1',
          table: 'acl',
          where: { list: ACL_STANDARD_VTY_LIST, action: 'deny', lastIface: 'vty' },
          whereOps: { matches: { op: 'ge', value: 1 } },
          exists: true,
          feedback: `List ${ACL_STANDARD_VTY_LIST} has not yet refused a login on the remote lines.`,
        },
      ],
      feedbackOnFail: 'Check reads the logins you made: log in from PC1 and try from PC2 once the access class is in place.',
    },
  ],
  solution: {
    R2: [`access-list ${ACL_STANDARD_SERVER_LIST} permit 192.168.10.0 0.0.0.255`, 'interface GigabitEthernet0/0', `ip access-group ${ACL_STANDARD_SERVER_LIST} out`, 'exit'],
    R1: [
      `ip access-list standard ${ACL_STANDARD_STAFF_LIST}`,
      'deny 192.168.20.0 0.0.0.255',
      'permit any',
      'exit',
      'interface GigabitEthernet0/0',
      `ip access-group ${ACL_STANDARD_STAFF_LIST} out`,
      'exit',
      `access-list ${ACL_STANDARD_VTY_LIST} permit host ${A15.pc1}`,
      'line vty 0 4',
      `access-class ${ACL_STANDARD_VTY_LIST} in`,
      'exit',
    ],
  },
};

// ── lab 16: extended ACLs (§3.3) ─────────────────────────────────────────────

/** The addresses of lab 16 (§3.3's world). */
export const ACL_EXTENDED_ADDRESSES = Object.freeze({ r1Staff: '192.168.10.1', r1Servers: '192.168.20.1', pc1: '192.168.10.10', pc2: '192.168.10.11', srv: '192.168.20.100' });
/** The list near the staff (§3.3) and the list near the servers. */
export const ACL_EXTENDED_STAFF_LIST = 'NO-WEB-PC1';
export const ACL_EXTENDED_SERVER_LIST = 'FROM-SERVERS';

const A16 = ACL_EXTENDED_ADDRESSES;

/** SW1: the two desks and R1, all edge ports. */
function extendedSw1Config(): string {
  return configText([
    ['hostname SW1'],
    accessPort('FastEthernet0/1', 1, { portfast: true }),
    accessPort('FastEthernet0/2', 1, { portfast: true }),
    accessPort('GigabitEthernet0/1', 1, { portfast: true }),
  ]);
}

/** R1: the staff LAN and the server LAN, no list yet. */
function extendedR1Config(): string {
  return configText([
    ['hostname R1'],
    section('interface GigabitEthernet0/0', [`ip address ${A16.r1Staff} ${MASK24}`, 'no shutdown']),
    section('interface GigabitEthernet0/1', [`ip address ${A16.r1Servers} ${MASK24}`, 'no shutdown']),
  ]);
}

/** SRV: the web server of the server LAN. */
function extendedSrvConfig(): string {
  return configText([['hostname SRV'], section('interface GigabitEthernet0', [`ip address ${A16.srv} ${MASK24}`]), [`ip default-gateway ${A16.r1Servers}`, 'ip http server']]);
}

/** §3.3's world: two desks and a web server on either side of R1, no list anywhere. */
export const ccna3AclExtended: ScenarioInfo = {
  name: 'ccna3-acl-extended',
  category: 'ccna3-lab',
  labType: 'build',
  course: 'CCNA 3',
  topic: ACL_TOPIC,
  title: 'Extended lists near the source',
  description:
    'Keep one desk off the web server while it can still ping it, and let the server LAN only answer the staff, never open a connection of its own: two extended access lists, each matching protocol, addresses and ports, each placed next to the traffic it filters.',
  objectives: [
    'Match protocol, source, destination and port in an extended access list',
    'Apply an extended list inbound, close to the source of the traffic',
    'Let only replies back in with the established keyword',
    'Match ICMP messages by type',
  ],
  tags: ['acl', 'extended acl', 'named acl', 'established', 'icmp', 'tcp', 'access-group'],
  difficulty: 2,
  estimatedMinutes: 30,
  requires: [PC, ROUTER, SERVER, SWITCH],
  seed: 316,
  instructions: [
    '## What you have',
    '',
    `R1 joins the staff LAN \`192.168.10.0/24\` on \`GigabitEthernet0/0\` (PC1 \`${A16.pc1}\` and PC2 \`${A16.pc2}\`, behind SW1) and the server LAN \`192.168.20.0/24\` on \`GigabitEthernet0/1\`, where SRV (\`${A16.srv}\`) runs a web server. Nothing is filtered yet.`,
    '',
    '## What to do',
    '',
    `- **No web for PC1.** Write the extended list \`${ACL_EXTENDED_STAFF_LIST}\`: deny TCP from the host PC1 to the host SRV on port 80 (\`www\`), then permit all other IP traffic. Apply it **inbound** on R1 \`GigabitEthernet0/0\`, where PC1's packets enter: an extended list can tell this one flow apart, so it goes next to the source and the denied packets never cross the router. PC1 must still ping SRV, and PC2 must still browse it.`,
    `- **The servers only answer.** Write the extended list \`${ACL_EXTENDED_SERVER_LIST}\` and apply it **inbound** on R1 \`GigabitEthernet0/1\`: permit TCP segments of connections that are already open (\`established\`: the segment carries ACK, which the first segment of a new connection never does), permit ICMP echo replies (\`echo-reply\`) so the staff's pings come back, and nothing else. SRV must not be able to open a connection to a desk or ping one.`,
    '- Test both ways: browse SRV from PC1 and PC2 (or type `telnet 192.168.20.100 80` on their consoles: a refused attempt says "administratively prohibited", and Ctrl+C leaves a connection that opened), ping SRV from the desks and the desks from SRV, and read `show access-lists` on R1 between tries.',
    '',
    '*`established` works for TCP only; any other protocol whose answers must come back needs entries of its own, as the echo replies do here.*',
    '',
    ROUTER_BOOT_NOTE,
  ].join('\n'),
  build: () =>
    topology(
      316,
      [
        device('pc1', PC, 'PC1', 80, 130, pcConfig('PC1', A16.pc1, MASK24, A16.r1Staff)),
        device('pc2', PC, 'PC2', 80, 290, pcConfig('PC2', A16.pc2, MASK24, A16.r1Staff)),
        device('sw1', SWITCH, 'SW1', 250, 210, extendedSw1Config()),
        device('r1', ROUTER, 'R1', 450, 210, extendedR1Config()),
        device('srv', SERVER, 'SRV', 650, 210, extendedSrvConfig()),
      ],
      [
        link('l_pc1_sw1', 'pc1', 'GigabitEthernet0', 'sw1', 'FastEthernet0/1'),
        link('l_pc2_sw1', 'pc2', 'GigabitEthernet0', 'sw1', 'FastEthernet0/2'),
        link('l_sw1_r1', 'sw1', 'GigabitEthernet0/1', 'r1', 'GigabitEthernet0/0'),
        link('l_r1_srv', 'r1', 'GigabitEthernet0/1', 'srv', 'GigabitEthernet0'),
      ],
      ['Deny one flow and keep the rest', 'Let only replies come back from the server LAN', 'Place each extended list next to its source'],
      'An extended list matches protocol, addresses and ports, so it can sit next to the source without blocking anything else.',
      { profile: 'P3' },
    ),
  tasks: [
    {
      id: 'no-web-for-pc1',
      title: 'Keep PC1 off the web server',
      description: `${ACL_EXTENDED_STAFF_LIST} denies PC1's web traffic to SRV and nothing else, applied inbound on R1 GigabitEthernet0/0.`,
      points: 40,
      hint: 'Name the protocol, the source host, the destination host and the port: `deny tcp host … host … eq www`, then `permit ip any any`.',
      assertions: [
        { kind: 'acl', device: 'R1', list: ACL_EXTENDED_STAFF_LIST, type: 'extended', applied: [{ iface: 'GigabitEthernet0/0', dir: 'in' }] },
        { kind: 'aclDecision', device: 'R1', list: ACL_EXTENDED_STAFF_LIST, packet: { proto: 'tcp', src: 'PC1', dst: 'SRV', dstPort: 80 }, expect: 'deny' },
        { kind: 'aclDecision', device: 'R1', list: ACL_EXTENDED_STAFF_LIST, packet: { proto: 'tcp', src: 'PC2', dst: 'SRV', dstPort: 80 }, expect: 'permit' },
        { kind: 'aclDecision', device: 'R1', list: ACL_EXTENDED_STAFF_LIST, packet: { proto: 'tcp', src: 'PC1', dst: 'SRV', dstPort: 23 }, expect: 'permit', feedback: 'Name the port: only the web flow is denied.' },
        {
          kind: 'aclDecision',
          device: 'R1',
          list: ACL_EXTENDED_STAFF_LIST,
          packet: { proto: 'icmp', src: 'PC1', dst: 'SRV' },
          expect: 'permit',
          feedback: 'Deny only the web flow: PC1 may still ping SRV.',
        },
        {
          kind: 'connectivity',
          from: 'PC1',
          to: 'SRV',
          proto: 'tcp',
          port: 80,
          expect: 'fail',
          droppedAt: 'R1',
          dropReason: 'acl-deny',
          feedback: 'The first segment of PC1 toward port 80 must be denied as it enters R1.',
        },
      ],
      feedbackOnFail: 'Apply the list inbound on the interface where PC1 enters R1.',
    },
    {
      id: 'replies-only',
      title: 'Let the server LAN only answer',
      description: `${ACL_EXTENDED_SERVER_LIST} admits only the segments of connections the staff opened, applied inbound on R1 GigabitEthernet0/1: PC2 still browses SRV, and SRV cannot open a connection to a desk.`,
      points: 35,
      hint: '`permit tcp any any established` matches every segment that carries ACK, which the first segment of a connection never does.',
      assertions: [
        { kind: 'acl', device: 'R1', list: ACL_EXTENDED_SERVER_LIST, type: 'extended', applied: [{ iface: 'GigabitEthernet0/1', dir: 'in' }] },
        {
          kind: 'aclDecision',
          device: 'R1',
          list: ACL_EXTENDED_SERVER_LIST,
          packet: { proto: 'tcp', src: 'SRV', dst: 'PC2', srcPort: 80, dstPort: 49152, established: true },
          expect: 'permit',
        },
        { kind: 'aclDecision', device: 'R1', list: ACL_EXTENDED_SERVER_LIST, packet: { proto: 'tcp', src: 'SRV', dst: 'PC2', dstPort: 80 }, expect: 'deny' },
        // a first segment (no ACK) sent FROM port 80: matching the source port is not `established`
        {
          kind: 'aclDecision',
          device: 'R1',
          list: ACL_EXTENDED_SERVER_LIST,
          packet: { proto: 'tcp', src: 'SRV', dst: 'PC2', srcPort: 80, dstPort: 49152 },
          expect: 'deny',
          feedback: 'A segment from port 80 can still open a connection: only established admits nothing but replies.',
          misconception: 'established-allows-new',
        },
        { kind: 'connectivity', from: 'PC2', to: 'SRV', proto: 'tcp', port: 80, expect: 'success', feedback: 'The answers of SRV carry ACK: established must let them back in.' },
        {
          kind: 'connectivity',
          from: 'SRV',
          to: 'PC2',
          proto: 'tcp',
          port: 80,
          expect: 'fail',
          droppedAt: 'R1',
          dropReason: 'acl-deny',
          feedback: 'A connection opened from the server LAN must stop at R1.',
          misconception: 'established-allows-new',
        },
      ],
      feedbackOnFail: 'Apply the list inbound on the interface that faces the server LAN.',
    },
    {
      id: 'echo-replies',
      title: 'Let pings come back, one way only',
      description: 'The desks can ping SRV, and SRV cannot ping a desk: only the echo replies come in from the server LAN.',
      points: 25,
      dependsOn: ['replies-only'],
      hint: 'ICMP has no connection to be established: permit the message type `echo-reply` from the server LAN.',
      assertions: [
        { kind: 'connectivity', from: 'PC2', to: 'SRV', expect: 'success', feedback: 'The echo replies of SRV must be let back in.' },
        { kind: 'connectivity', from: 'PC1', to: 'SRV', expect: 'success' },
        {
          kind: 'connectivity',
          from: 'SRV',
          to: 'PC1',
          expect: 'fail',
          droppedAt: 'R1',
          dropReason: 'acl-deny',
          feedback: 'Permit the echo replies only: an echo request from SRV must be denied at R1.',
        },
      ],
    },
  ],
  solution: {
    R1: [
      `ip access-list extended ${ACL_EXTENDED_STAFF_LIST}`,
      `deny tcp host ${A16.pc1} host ${A16.srv} eq www`,
      'permit ip any any',
      'exit',
      'interface GigabitEthernet0/0',
      `ip access-group ${ACL_EXTENDED_STAFF_LIST} in`,
      'exit',
      `ip access-list extended ${ACL_EXTENDED_SERVER_LIST}`,
      'permit tcp any any established',
      'permit icmp any any echo-reply',
      'exit',
      'interface GigabitEthernet0/1',
      `ip access-group ${ACL_EXTENDED_SERVER_LIST} in`,
      'exit',
    ],
  },
};

// ── lab 17: editing and reading ACLs (troubleshoot) ──────────────────────────

/** The addresses of lab 17. */
export const ACL_EDIT_ADDRESSES = Object.freeze({ r1Staff: '192.168.10.1', r1Servers: '192.168.20.1', pc1: '192.168.10.10', pc2: '192.168.10.11', kiosk: '192.168.10.12', srv: '192.168.20.100' });
/** The list a colleague edited. */
export const ACL_EDIT_LIST = 'SERVERS-IN';
/** When the colleague's change lands: once R1 has booted (45 s); a fragment sent earlier would be lost. */
export const ACL_EDIT_FAULT_AT = 50 * SEC;

const A17 = ACL_EDIT_ADDRESSES;

/** The kiosk's deny, as the list must end up holding it (entry 5, logged). */
const KIOSK_DENY = `deny tcp host ${A17.kiosk} host ${A17.srv} eq www`;
/** The web entry of the original list (entry 10). */
const DESKS_WEB = `permit tcp 192.168.10.0 0.0.0.255 host ${A17.srv} eq www`;
/** The ping entry of the original list (entry 20), and the one the colleague typed instead (a /29 wildcard). */
const DESKS_PING = 'permit icmp 192.168.10.0 0.0.0.255 192.168.20.0 0.0.0.255';
const DESKS_PING_BROKEN = 'permit icmp 192.168.10.0 0.0.0.7 192.168.20.0 0.0.0.255';

/**
 * A clone check (`connectivity.then`): an entry of SERVERS-IN with this action and text counted the probe. The row is
 * found by its text, never its number: the grader's clone boots from the export, whose list carries no numbers, so
 * its entries are numbered 10, 20, 30 … again (D12, as a reload does), while the sequence numbers the learner chose
 * are graded live by `aclDecision`.
 */
function countedOn(action: 'permit' | 'deny', entry: string | { readonly op: 'contains'; readonly value: string }): LabAssertion {
  const byText = typeof entry === 'string';
  return {
    kind: 'table',
    device: 'R1',
    table: 'acl',
    where: { list: ACL_EDIT_LIST, action, ...(byText ? { entry } : {}) },
    whereOps: { matches: { op: 'ge', value: 1 }, ...(byText ? {} : { entry }) },
    exists: true,
  };
}

/** SW1: the three desks and R1, all edge ports. */
function editSw1Config(): string {
  return configText([
    ['hostname SW1'],
    accessPort('FastEthernet0/1', 1, { portfast: true }),
    accessPort('FastEthernet0/2', 1, { portfast: true }),
    accessPort('FastEthernet0/3', 1, { portfast: true }),
    accessPort('GigabitEthernet0/1', 1, { portfast: true }),
  ]);
}

/** R1 as it was last month: SERVERS-IN lets the desks browse SRV and ping the server LAN (entries 10 and 20). */
function editR1Config(): string {
  return configText([
    ['hostname R1'],
    section('interface GigabitEthernet0/0', [`ip address ${A17.r1Staff} ${MASK24}`, `ip access-group ${ACL_EDIT_LIST} in`, 'no shutdown']),
    section('interface GigabitEthernet0/1', [`ip address ${A17.r1Servers} ${MASK24}`, 'no shutdown']),
    section(`ip access-list extended ${ACL_EDIT_LIST}`, [DESKS_WEB, DESKS_PING]),
  ]);
}

/** SRV: the web server of the server LAN. */
function editSrvConfig(): string {
  return configText([['hostname SRV'], section('interface GigabitEthernet0', [`ip address ${A17.srv} ${MASK24}`]), [`ip default-gateway ${A17.r1Servers}`, 'ip http server']]);
}

/**
 * The colleague's edit (hidden, saved): entry 20 retyped with a /29 wildcard, and the kiosk's deny appended as entry
 * 30, below the permit that already matches the kiosk's web traffic.
 */
const COLLEAGUE_EDIT = configFragmentFault(ACL_EDIT_FAULT_AT, 'r1', [
  `ip access-list extended ${ACL_EDIT_LIST}`,
  ' no 20',
  ` 20 ${DESKS_PING_BROKEN}`,
  ` ${KIOSK_DENY}`,
  'do write memory',
]);

/** Three desks, R1 and a web server; a colleague's edit of SERVERS-IN lands once R1 has booted. */
export const ccna3AclEditVerify: ScenarioInfo = {
  name: 'ccna3-acl-edit-verify',
  category: 'ccna3-lab',
  labType: 'troubleshoot',
  course: 'CCNA 3',
  topic: ACL_TOPIC,
  title: 'Edit a list by its numbers',
  description:
    'A colleague changed an access list to keep the kiosk off the web server. The kiosk still browses, and now nobody can ping the servers. Read the match counters to see which entries really match, then repair the list by sequence number, make it log the kiosk, and leave a remark for the next person.',
  objectives: [
    'Read the match counters of an access list',
    'Insert an entry at a chosen place with a sequence number',
    'Replace and remove entries by sequence number',
    'Log the packets an entry denies',
    'Document a list with a remark',
  ],
  tags: ['acl', 'extended acl', 'sequence numbers', 'remark', 'log', 'counters', 'troubleshooting'],
  difficulty: 3,
  estimatedMinutes: 25,
  requires: [PC, ROUTER, SERVER, SWITCH],
  seed: 317,
  faults: [COLLEAGUE_EDIT],
  instructions: [
    '## What you have',
    '',
    `R1 filters what the staff LAN \`192.168.10.0/24\` (PC1 \`${A17.pc1}\`, PC2 \`${A17.pc2}\` and the kiosk KIOSK \`${A17.kiosk}\`, behind SW1) sends to the server LAN with the extended list \`${ACL_EDIT_LIST}\`, applied inbound on \`GigabitEthernet0/0\`. Until today it held two entries: the desks may browse SRV (\`${A17.srv}\`), and they may ping the server LAN.`,
    '',
    'A colleague has just edited it to keep the kiosk off the web server, and saved the change. Since then:',
    '',
    '- the kiosk still opens the web page of SRV;',
    '- no desk can ping the server LAN any more.',
    '',
    '## What to do',
    '',
    `- Read \`show access-lists ${ACL_EDIT_LIST}\` on R1. Clear the counters (\`clear access-list counters ${ACL_EDIT_LIST}\`), browse SRV from the kiosk (its browser, or \`telnet ${A17.srv} 80\` on its console; Ctrl+C leaves a connection that opened), ping SRV from PC2, and read the counters again: which entry counted each attempt, and which entry never counts anything?`,
    '- Repair the list **in place**, by sequence number, in its configuration mode; do not delete it and type it again:',
    '  - remove the entry that can never match (`no` followed by its number);',
    `  - insert the kiosk's deny as **entry 5**, so it is checked before the web permit, and make it **log** what it denies;`,
    '  - replace **entry 20** with an entry that lets the whole staff LAN ping the server LAN, keeping the number 20 (`no 20`, then `20 …`);',
    '  - add a **remark** that says what the list is for.',
    '- Try again and read the counters: the kiosk is refused (and R1 logs it), the desks browse and ping, and each attempt counts on the entry you expect.',
    '',
    '*The sequence numbers live only in the running list: the saved configuration does not keep them, so a reload numbers the entries again from 10 in steps of 10. Make the repair without reloading R1.*',
    '',
    `*R1 takes about 45 s to boot, and the colleague's change reaches it about ${ACL_EDIT_FAULT_AT / SEC} s after the lab loads: allow about a minute before you start. Until then Check says the lab is still being prepared.*`,
  ].join('\n'),
  build: () =>
    topology(
      317,
      [
        device('pc1', PC, 'PC1', 80, 100, pcConfig('PC1', A17.pc1, MASK24, A17.r1Staff)),
        device('pc2', PC, 'PC2', 80, 210, pcConfig('PC2', A17.pc2, MASK24, A17.r1Staff)),
        device('kiosk', PC, 'KIOSK', 80, 320, pcConfig('KIOSK', A17.kiosk, MASK24, A17.r1Staff)),
        device('sw1', SWITCH, 'SW1', 250, 210, editSw1Config()),
        device('r1', ROUTER, 'R1', 450, 210, editR1Config()),
        device('srv', SERVER, 'SRV', 650, 210, editSrvConfig()),
      ],
      [
        link('l_pc1_sw1', 'pc1', 'GigabitEthernet0', 'sw1', 'FastEthernet0/1'),
        link('l_pc2_sw1', 'pc2', 'GigabitEthernet0', 'sw1', 'FastEthernet0/2'),
        link('l_kiosk_sw1', 'kiosk', 'GigabitEthernet0', 'sw1', 'FastEthernet0/3'),
        link('l_sw1_r1', 'sw1', 'GigabitEthernet0/1', 'r1', 'GigabitEthernet0/0'),
        link('l_r1_srv', 'r1', 'GigabitEthernet0/1', 'srv', 'GigabitEthernet0'),
      ],
      ['Find the entries that never match', 'Repair the list by sequence number', 'Log the kiosk and leave a remark'],
      'A list is read from the lowest number up and stops at the first match; the counters show which entry really decides.',
      { profile: 'P3' },
    ),
  tasks: [
    {
      id: 'kiosk-first',
      title: 'Stop the kiosk before the web permit',
      description: `Entry 5 of ${ACL_EDIT_LIST} denies the kiosk's web traffic to SRV and counts it; the other desks still browse, counted on entry 10.`,
      points: 30,
      hint: `In \`ip access-list extended ${ACL_EDIT_LIST}\`, an entry typed with a number goes to that place: \`5 deny tcp host … host … eq www\`.`,
      assertions: [
        { kind: 'aclDecision', device: 'R1', list: ACL_EDIT_LIST, packet: { proto: 'tcp', src: 'KIOSK', dst: 'SRV', dstPort: 80 }, expect: 'deny', entry: 5 },
        { kind: 'aclDecision', device: 'R1', list: ACL_EDIT_LIST, packet: { proto: 'tcp', src: 'PC2', dst: 'SRV', dstPort: 80 }, expect: 'permit', entry: 10 },
        {
          kind: 'connectivity',
          from: 'KIOSK',
          to: 'SRV',
          proto: 'tcp',
          port: 80,
          expect: 'fail',
          droppedAt: 'R1',
          dropReason: 'acl-deny',
          then: [countedOn('deny', { op: 'contains', value: KIOSK_DENY })],
          feedback: 'The first entry that matches decides: a deny below a permit that matches the same packets never counts.',
          misconception: 'acl-order-ignored',
        },
        {
          kind: 'connectivity',
          from: 'PC1',
          to: 'SRV',
          proto: 'tcp',
          port: 80,
          expect: 'success',
          then: [countedOn('permit', DESKS_WEB)],
        },
      ],
      feedbackOnFail: 'Entry 10 permits the whole staff LAN, the kiosk included: the kiosk deny must come before it.',
    },
    {
      id: 'log-kiosk',
      title: 'Log the kiosk',
      description: "The kiosk's deny ends with log, so R1 reports every web attempt the kiosk makes.",
      points: 10,
      dependsOn: ['kiosk-first'],
      hint: 'The keyword log goes at the very end of the entry.',
      assertions: [{ kind: 'acl', device: 'R1', list: ACL_EDIT_LIST, entries: [`${KIOSK_DENY} log`], match: 'includes' }],
    },
    {
      id: 'ping-servers',
      title: 'Let every desk ping the server LAN',
      description: 'Entry 20 again permits ICMP from the whole staff LAN to the server LAN, and PC2 pings SRV through it.',
      points: 25,
      hint: 'The wildcard 0.0.0.7 covers only .0 to .7; a whole /24 is 0.0.0.255. Remove entry 20 and type it again with its number.',
      assertions: [
        { kind: 'aclDecision', device: 'R1', list: ACL_EDIT_LIST, packet: { proto: 'icmp', src: 'PC2', dst: 'SRV' }, expect: 'permit', entry: 20 },
        { kind: 'aclDecision', device: 'R1', list: ACL_EDIT_LIST, packet: { proto: 'icmp', src: 'KIOSK', dst: 'SRV' }, expect: 'permit', entry: 20 },
        {
          kind: 'connectivity',
          from: 'PC2',
          to: 'SRV',
          expect: 'success',
          then: [countedOn('permit', DESKS_PING)],
          feedback: 'Read the wildcard of entry 20 bit by bit: which host addresses does it leave out?',
          misconception: 'wildcard-misread',
        },
      ],
    },
    {
      id: 'remark',
      title: 'Leave a remark',
      description: `${ACL_EDIT_LIST} carries a remark that says what it is for.`,
      points: 10,
      hint: 'In the list mode, `remark` followed by any text adds a comment that never matches a packet.',
      assertions: [{ kind: 'config', device: 'R1', path: `ip.access-list.extended.${ACL_EDIT_LIST}.remark`, exists: true }],
    },
    {
      id: 'no-dead-entries',
      title: 'Keep only entries that can match',
      description: `${ACL_EDIT_LIST} holds exactly the logged kiosk deny, the web permit and the ping permit, in that order, and is still applied inbound on GigabitEthernet0/0.`,
      points: 25,
      dependsOn: ['kiosk-first', 'ping-servers'],
      hint: 'The deny the colleague appended below the web permit can never match: `no` with its number removes it.',
      assertions: [
        {
          kind: 'acl',
          device: 'R1',
          list: ACL_EDIT_LIST,
          type: 'extended',
          entries: [`${KIOSK_DENY} log`, DESKS_WEB, DESKS_PING],
          match: 'exactly',
          applied: [{ iface: 'GigabitEthernet0/0', dir: 'in' }],
        },
      ],
      feedbackOnFail: 'Compare show access-lists with the three entries the list should hold, in order.',
    },
  ],
  solution: {
    R1: [
      `ip access-list extended ${ACL_EDIT_LIST}`,
      'no 30',
      `5 ${KIOSK_DENY} log`,
      'no 20',
      `20 ${DESKS_PING}`,
      'remark desks browse and ping the servers; the kiosk may not browse',
      'exit',
    ],
  },
};

/** The CCNA 3 access-list labs (lessons 15-17), in course order. */
export const CCNA3_ACL_LABS: readonly ScenarioInfo[] = Object.freeze([ccna3AclStandard, ccna3AclExtended, ccna3AclEditVerify]);
