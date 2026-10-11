/**
 * sim/scenarios/ccna3/hardening.ts — the CCNA 3 hardening labs (ARCHITECTURE-P3 §11.1 module 7 "Hardening", §11.2;
 * §3.4, §3.14, D13, D14, [S13]; rulings R45 and R47).
 *
 *   • `ccna3-secure-device-access` — lesson 19 "Locking down device access": R1 still takes telnet with one shared line
 *     password. The learner gives it a domain name and an RSA key, turns on SSH version 2, creates a local user, makes
 *     the remote lines check that user (`login local`), accept SSH only (`transport input ssh`) and admit only the
 *     admin PC (standard list 10 bound with `access-class 10 in`), then shuts SW1's unused ports. It is graded twice
 *     over (§3.14 step 8, §11.2 "graded live through the remote terminal"): LIVE, from the learner's own attempts — an
 *     SSH login from PC1 and a refused one from PC2 in R1's `vty-logins`, and the refusal counted on a deny row of list
 *     10 bound to the vty lines (the implicit deny, or an explicit `deny any`: the row is read by its action, not its
 *     sequence) — and in the grader's CLONE with the [S13] `service` kind, which logs in by
 *     itself (PC1 over SSH: success; PC1 over telnet: refused; PC2 over SSH: refused), so the configuration is
 *     confirmed independently of the learner's attempts.
 *   • `ccna3-dhcp-snooping-dai` — lesson 20 "Guarding the access layer" (§3.4): ROGUE, a home router on SW1's `Fa0/24`
 *     serving 10.66.0.0/24 with gateway .1, is up in 15 s and leases PC1 and ATTACKER their addresses long before R1
 *     (45 s) can. The learner turns on DHCP snooping for VLAN 10, trusts only the trunk to R1, configures (and reads
 *     about, D13: no task grades it) a DHCP rate limit on the access ports, gives back PC1's lease and asks again so
 *     the switch records its binding, turns on dynamic ARP inspection, keeps the statically addressed SRV1 working with
 *     an `ip source binding` (§3.4 step 8, the gotcha of the lesson), and finally plays the attacker: ATTACKER claims
 *     R1's address and its gratuitous ARP is dropped (§3.4 step 6). Ruling R45: the trunk toward R1 carries
 *     `spanning-tree portfast trunk` from the start, so the grader clone's PC1 leases from R1 while the clone settles
 *     (§3.4 step 9). §3.4's ROGUE is a router; here it is a home router (same pool and gateway), because a rogue that
 *     boots as slowly as R1 loses the first race and the unsolved world would not show the attack.
 *
 * P3-profile worlds (`topology(…, {profile: 'P3'})`, schema 1.3). Neither lesson is about spanning tree: host ports and
 * router-facing access ports are PortFast in the startup configuration (§11.2). Tasks read structured state only (the
 * §2.10 kinds: `fact`, `acl`, `aclDecision`, `table`, `port`, `config`, `connectivity`, `service`), and each lab
 * carries a reference `solution` that `Simulation.configure` accepts as written. The live-login task of lab 19 needs
 * the learner's own logins, which no configuration line can make (a headless configure session refuses jobs), so the
 * logins a learner types before Check are data too: `SECURE_ACCESS_LOGINS` (what the solutions test types on the PCs'
 * consoles after the solution). All wording is original (§0 rule 6, D22); no vendor is named.
 *
 * A lab file imports only the contracts, `../kit.js` and `../templates.js` (rule 12: the catalogue reads the arrays at
 * module scope, so no lab file may import it back).
 *
 * ponytail: SRV1's MAC address (the `ip source binding` of lab 20's solution) is computed with the contract's own
 * derivation (`portMac(deviceMacBase(id), 1)`, D8: from the device id alone, independent of the seed), so the solution
 * names exactly the address the learner reads with `ipconfig /all` on SRV1 or `show mac address-table` on SW1.
 */
import { deviceMacBase, portMac } from '../../../contracts/addr.js';
import type { LabAssertion, ScenarioInfo } from '../../../contracts/scenario.js';
import { HOME_ROUTER, MASK24, PC, ROUTER, SERVER, SWITCH, accessPort, configText, device, link, section, topology, trunkPort, vlanSections } from '../kit.js';
import { pcConfig } from '../templates.js';

// ── lab 19: secure device access ─────────────────────────────────────────────

/** The admin PC (the one host list 10 permits), the other PC, R1 and SW1's management address (§3.14). */
export const SECURE_ACCESS_ADDRESSES = Object.freeze({ r1: '192.168.10.1', sw1: '192.168.10.2', pc1: '192.168.10.10', pc2: '192.168.10.11' });
/** The local user the lab asks for, and its password (a lab value, printed in the instructions). */
export const SECURE_ACCESS_USER = 'admin';
export const SECURE_ACCESS_SECRET = 'Lock-Down19';
/** The shared line password R1 starts with (the weakness the lab removes). */
export const SECURE_ACCESS_OLD_LINE_PASSWORD = 'letmein';

/** SW1's unused ports: FastEthernet0/3 to FastEthernet0/24 and GigabitEthernet0/2. */
const SECURE_ACCESS_UNUSED: readonly string[] = [...Array.from({ length: 22 }, (_, i) => `FastEthernet0/${i + 3}`), 'GigabitEthernet0/2'];

/**
 * @since P3 The learner's own logins lab 19 asks for before Check (§11.2: one admitted, one refused), as the lines a
 * learner types on each PC's console — a remote login is a job, which `Simulation.configure` refuses, so the reference
 * solution cannot hold them. Each `lines` entry is one console line; the password line answers the client's
 * password question. PC1 logs in over SSH and logs out; PC2 is refused by `access-class 10`.
 */
export const SECURE_ACCESS_LOGINS: readonly { readonly from: string; readonly lines: readonly string[] }[] = Object.freeze([
  { from: 'PC1', lines: [`ssh -l ${SECURE_ACCESS_USER} ${SECURE_ACCESS_ADDRESSES.r1}`, SECURE_ACCESS_SECRET, 'exit'] },
  { from: 'PC2', lines: [`ssh -l ${SECURE_ACCESS_USER} ${SECURE_ACCESS_ADDRESSES.r1}`, SECURE_ACCESS_SECRET] },
]);

/** R1: an address toward SW1 and remote lines open to telnet with one shared password. */
function secureAccessR1Config(): string {
  return configText([
    ['hostname R1'],
    section('interface GigabitEthernet0/0', [`ip address ${SECURE_ACCESS_ADDRESSES.r1} ${MASK24}`, 'no shutdown']),
    section('line vty 0 4', [`password ${SECURE_ACCESS_OLD_LINE_PASSWORD}`, 'login']),
  ]);
}

/** SW1: two PortFast host ports, a PortFast port toward R1 (a router sends no BPDU) and a management address. */
function secureAccessSw1Config(): string {
  return configText([
    ['hostname SW1'],
    accessPort('FastEthernet0/1', 1, { portfast: true }),
    accessPort('FastEthernet0/2', 1, { portfast: true }),
    accessPort('GigabitEthernet0/1', 1, { portfast: true }),
    section('interface Vlan1', [`ip address ${SECURE_ACCESS_ADDRESSES.sw1} ${MASK24}`, 'no shutdown']),
    [`ip default-gateway ${SECURE_ACCESS_ADDRESSES.r1}`],
  ]);
}

/** An SSH probe of the grader's clone toward R1 (§3.14 step 8). */
function sshProbe(from: string, expect: 'success' | 'refused'): LabAssertion {
  return { kind: 'service', from, to: 'R1', service: 'ssh', user: SECURE_ACCESS_USER, password: SECURE_ACCESS_SECRET, expect };
}

/** R1 behind SW1 with an admin PC and a second PC; R1 takes telnet from anyone with one shared password. */
export const ccna3SecureDeviceAccess: ScenarioInfo = {
  name: 'ccna3-secure-device-access',
  category: 'ccna3-lab',
  labType: 'build',
  course: 'CCNA 3',
  topic: 'Hardening',
  title: 'SSH-only management with a vty access list',
  description:
    'R1 can be managed by anyone who knows one shared telnet password. Turn on SSH, give each administrator an account, accept SSH only and only from the admin PC, prove it with your own logins, then shut the switch ports nobody uses.',
  objectives: [
    'Prepare a router for SSH: a domain name, an RSA key and version 2',
    'Check administrators against local user accounts instead of a shared line password',
    'Accept only SSH on the remote terminal lines',
    'Admit remote logins from one management host with a standard list on the vty lines',
    'Shut the switch ports nobody uses',
  ],
  tags: ['ssh', 'telnet', 'login local', 'transport input', 'access-class', 'vty', 'hardening', 'unused ports'],
  difficulty: 2,
  estimatedMinutes: 35,
  requires: [PC, ROUTER, SWITCH],
  seed: 319,
  instructions: [
    '## What you have',
    '',
    `PC1 (\`${SECURE_ACCESS_ADDRESSES.pc1}\`, the admin PC) and PC2 (\`${SECURE_ACCESS_ADDRESSES.pc2}\`) sit on SW1 with R1 (\`GigabitEthernet0/0\`, \`${SECURE_ACCESS_ADDRESSES.r1}/24\`). SW1 is managed at \`${SECURE_ACCESS_ADDRESSES.sw1}\`. The PC ports and the port toward R1 are PortFast, so they forward as soon as the link is up.`,
    '',
    `R1's remote lines (\`line vty 0 4\`) accept telnet from anyone who knows the shared password \`${SECURE_ACCESS_OLD_LINE_PASSWORD}\`. Try it from PC2: \`telnet ${SECURE_ACCESS_ADDRESSES.r1}\`, and look at the capture: telnet carries the password in clear, one character per frame.`,
    '',
    '*R1 takes about 45 s to boot and SW1 about 30 s, so give the world about a minute before the first login.*',
    '',
    '## What to do',
    '',
    '- **SSH on R1.** Give R1 the domain name `lab.nf`, generate an RSA key of 1024 bits (`crypto key generate rsa modulus 1024`) and allow SSH version 2 only. The key needs a hostname and a domain name first.',
    `- **Local users.** Create the user \`${SECURE_ACCESS_USER}\` with the secret \`${SECURE_ACCESS_SECRET}\`, and make \`line vty 0 4\` check user accounts (\`login local\`) instead of the line password.`,
    '- **SSH only.** On the same lines, accept SSH and nothing else (`transport input ssh`).',
    '- **Only the admin PC.** Write standard list 10 that permits PC1 alone, and bind it to the remote lines (`access-class 10 in`). Every other source falls through to the implicit deny at the end of the list.',
    `- **Prove it.** Before you press Check, log in from PC1 (\`ssh -l ${SECURE_ACCESS_USER} ${SECURE_ACCESS_ADDRESSES.r1}\`, then the secret; \`exit\` logs out), and try the same from PC2, which must be refused. \`show users\`, \`show ip ssh\` and \`show access-lists\` on R1 show what happened.`,
    '- **Unused ports.** Shut every SW1 port that nothing is plugged into: `FastEthernet0/3` to `FastEthernet0/24` and `GigabitEthernet0/2` (`interface range` helps).',
    '',
    'The grader also opens its own sessions in a copy of your network: SSH from PC1 must log in, telnet from PC1 and SSH from PC2 must be refused.',
    '',
    '*The SSH cryptography is simulated: the headers and the version strings are real, and the protected payload is shown decoded under a banner in the inspector.*',
  ].join('\n'),
  build: () =>
    topology(
      319,
      [
        device('r1', ROUTER, 'R1', 520, 120, secureAccessR1Config()),
        device('sw1', SWITCH, 'SW1', 360, 280, secureAccessSw1Config()),
        device('pc1', PC, 'PC1', 180, 420, pcConfig('PC1', SECURE_ACCESS_ADDRESSES.pc1, MASK24, SECURE_ACCESS_ADDRESSES.r1)),
        device('pc2', PC, 'PC2', 540, 440, pcConfig('PC2', SECURE_ACCESS_ADDRESSES.pc2, MASK24, SECURE_ACCESS_ADDRESSES.r1)),
      ],
      [
        link('l_r1_sw1', 'r1', 'GigabitEthernet0/0', 'sw1', 'GigabitEthernet0/1'),
        link('l_pc1_sw1', 'pc1', 'GigabitEthernet0', 'sw1', 'FastEthernet0/1'),
        link('l_pc2_sw1', 'pc2', 'GigabitEthernet0', 'sw1', 'FastEthernet0/2'),
      ],
      ['Turn on SSH', 'Use local accounts', 'Accept SSH only', 'Admit the admin PC only', 'Prove it with your own logins', 'Shut the unused ports'],
      'Telnet sends every keystroke, the password included, in clear; SSH protects the session. A remote line that checks local accounts knows who logged in, and an access class on the lines decides which hosts may try at all.',
      { profile: 'P3' },
    ),
  tasks: [
    {
      id: 'ssh-ready',
      title: 'R1 can run SSH version 2',
      description: 'R1 has a domain name, an RSA key of at least 1024 bits and accepts SSH version 2.',
      points: 15,
      hint: 'The key needs a hostname other than the default and a domain name; version 2 needs a key of at least 768 bits.',
      assertions: [
        { kind: 'config', device: 'R1', path: 'ip.domain-name', exists: true },
        { kind: 'fact', device: 'R1', fact: 'ssh.enabled', equals: true, feedback: 'R1 has no RSA key yet.' },
        { kind: 'fact', device: 'R1', fact: 'ssh.keyBits', atLeast: 1024 },
        { kind: 'fact', device: 'R1', fact: 'ssh.version', equals: 2 },
      ],
    },
    {
      id: 'local-users',
      title: 'Administrators log in with their own account',
      description: `The user ${SECURE_ACCESS_USER} exists on R1, the remote lines check user accounts, and the grader logs in as ${SECURE_ACCESS_USER} from PC1 over SSH.`,
      points: 15,
      hint: 'login local replaces the line password with the user name table.',
      assertions: [
        { kind: 'config', device: 'R1', path: `username.${SECURE_ACCESS_USER}`, exists: true },
        { kind: 'fact', device: 'R1', fact: 'vty.loginLocal', equals: true, misconception: 'line-password-is-enough' },
        sshProbe('PC1', 'success'),
      ],
      feedbackOnFail: 'A shared line password cannot tell administrators apart; a local account per person can.',
    },
    {
      id: 'ssh-only',
      title: 'The remote lines accept SSH only',
      description: 'R1 accepts SSH and nothing else on its remote lines: a telnet from PC1 is refused.',
      points: 15,
      assertions: [
        { kind: 'fact', device: 'R1', fact: 'vty.transport', equals: 'ssh', misconception: 'transport-defaults-to-ssh' },
        // with the right credentials, so a refusal can only come from the transport (and the client never answers a
        // login prompt with nothing)
        {
          kind: 'service',
          from: 'PC1',
          to: 'R1',
          service: 'telnet',
          user: SECURE_ACCESS_USER,
          password: SECURE_ACCESS_SECRET,
          expect: 'refused',
          feedback: 'Telnet still reaches the remote lines.',
        },
      ],
      feedbackOnFail: 'Without a transport input line the remote lines accept both telnet and SSH.',
    },
    {
      id: 'admin-pc-only',
      title: 'Only the admin PC may log in',
      description: 'Standard list 10 permits PC1 alone (PC2 and every other source are denied), it is bound to the remote lines, and an SSH login from PC2 is refused.',
      points: 20,
      hint: 'access-class binds a standard list to the vty lines in the inbound direction.',
      assertions: [
        { kind: 'acl', device: 'R1', list: '10', type: 'standard', applied: [{ vty: true, dir: 'in' }] },
        { kind: 'fact', device: 'R1', fact: 'vty.accessClass', equals: '10' },
        { kind: 'aclDecision', device: 'R1', list: '10', packet: { proto: 'tcp', src: SECURE_ACCESS_ADDRESSES.pc1, dst: SECURE_ACCESS_ADDRESSES.r1, dstPort: 22 }, expect: 'permit' },
        {
          kind: 'aclDecision',
          device: 'R1',
          list: '10',
          packet: { proto: 'tcp', src: SECURE_ACCESS_ADDRESSES.pc2, dst: SECURE_ACCESS_ADDRESSES.r1, dstPort: 22 },
          expect: 'deny',
          misconception: 'permit-the-whole-subnet',
        },
        // a third source (SW1's management address): 'deny PC2, permit any' admits it
        {
          kind: 'aclDecision',
          device: 'R1',
          list: '10',
          packet: { proto: 'tcp', src: SECURE_ACCESS_ADDRESSES.sw1, dst: SECURE_ACCESS_ADDRESSES.r1, dstPort: 22 },
          expect: 'deny',
          feedback: 'Permit PC1 alone: every other source must fall to the implicit deny.',
          misconception: 'deny-one-permit-the-rest',
        },
        sshProbe('PC2', 'refused'),
      ],
      feedbackOnFail: 'A standard list matches the source address only: permit PC1 and let the implicit deny refuse everyone else.',
    },
    {
      id: 'own-logins',
      title: 'Your own logins prove it',
      description: 'R1 recorded an SSH login from PC1 and a refused attempt from PC2, and list 10 counted the refusal on a deny entry (its implicit deny) on the remote lines.',
      points: 20,
      hint: 'Log in from PC1 and try from PC2 after the configuration is complete; show users and show access-lists on R1 show the result.',
      assertions: [
        {
          kind: 'table',
          device: 'R1',
          table: 'vty-logins',
          where: { proto: 'ssh', peer: SECURE_ACCESS_ADDRESSES.pc1, user: SECURE_ACCESS_USER, result: 'success' },
          exists: true,
          feedback: 'R1 has not seen an SSH login from PC1 yet.',
        },
        {
          kind: 'table',
          device: 'R1',
          table: 'vty-logins',
          where: { proto: 'ssh', peer: SECURE_ACCESS_ADDRESSES.pc2, result: 'refused' },
          exists: true,
          feedback: 'R1 has not refused an SSH attempt from PC2 yet.',
        },
        { kind: 'acl', device: 'R1', list: '10', applied: [{ vty: true, dir: 'in' }] },
        // the refusal counted on a deny row of list 10 on the remote lines: the implicit deny or an explicit `deny any`
        {
          kind: 'table',
          device: 'R1',
          table: 'acl',
          where: { list: '10', action: 'deny', lastIface: 'vty' },
          whereOps: { matches: { op: 'ge', value: 1 } },
          exists: true,
          feedback: 'List 10 has not yet refused a login on the remote lines.',
        },
      ],
    },
    {
      id: 'unused-ports',
      title: 'Unused switch ports are shut',
      description: 'FastEthernet0/3 to FastEthernet0/24 and GigabitEthernet0/2 of SW1 are administratively down.',
      points: 15,
      assertions: SECURE_ACCESS_UNUSED.map((port) => ({ kind: 'port', device: 'SW1', port, field: 'adminUp', equals: false }) as const),
      feedbackOnFail: 'An open port that nobody uses is a free way into the network.',
    },
  ],
  solution: {
    R1: [
      'ip domain-name lab.nf',
      'crypto key generate rsa modulus 1024',
      'ip ssh version 2',
      `username ${SECURE_ACCESS_USER} secret ${SECURE_ACCESS_SECRET}`,
      `access-list 10 permit host ${SECURE_ACCESS_ADDRESSES.pc1}`,
      'line vty 0 4',
      'login local',
      'transport input ssh',
      'access-class 10 in',
      'exit',
    ],
    SW1: ['interface range FastEthernet0/3 - 24', 'shutdown', 'exit', 'interface GigabitEthernet0/2', 'shutdown', 'exit'],
  },
};

// ── lab 20: DHCP snooping and dynamic ARP inspection ─────────────────────────

/** The user VLAN of the lab. */
const SNOOP_VLANS = [{ id: 10, name: 'USERS' }] as const;
/** R1's gateway address on VLAN 10, the static server, the rogue router's lure. */
export const SNOOPING_ADDRESSES = Object.freeze({ r1: '192.168.10.1', srv1: '192.168.10.5', rogue: '10.66.0.1' });
/** The topology id of SRV1 (its MAC address derives from it, D8). */
const SRV1_ID = 'srv1';
/** SRV1's MAC address: the first port of the device `srv1` (D8: `portMac(deviceMacBase(id), 1)`, seed-independent). */
export const SNOOPING_SRV1_MAC: string = portMac(deviceMacBase(SRV1_ID), 1);
/** The DHCP rate limit the lab configures on the access ports (explained, never stress-tested: D13). */
export const SNOOPING_RATE_LIMIT = 10;

/** SW1's access ports: PC1, SRV1, ATTACKER and the rogue router (a router is an edge too: PortFast). */
const SNOOP_ACCESS = ['FastEthernet0/1', 'FastEthernet0/2', 'FastEthernet0/5', 'FastEthernet0/24'] as const;

/** SW1: VLAN 10, four PortFast access ports and the trunk to R1 (PortFast trunk, ruling R45). */
function snoopingSw1Config(): string {
  return configText([
    ['hostname SW1'],
    ...vlanSections(SNOOP_VLANS),
    ...SNOOP_ACCESS.map((port) => accessPort(port, 10, { portfast: true })),
    [...trunkPort('GigabitEthernet0/1'), ' spanning-tree portfast trunk'],
  ]);
}

/** R1: the gateway and DHCP server of VLAN 10 on a subinterface (.1 to .10 kept back for static hosts). */
function snoopingR1Config(): string {
  return configText([
    ['hostname R1'],
    section('interface GigabitEthernet0/0', ['no shutdown']),
    section('interface GigabitEthernet0/0.10', ['encapsulation dot1Q 10', `ip address ${SNOOPING_ADDRESSES.r1} ${MASK24}`]),
    ['ip dhcp excluded-address 192.168.10.1 192.168.10.10'],
    section('ip dhcp pool USERS', ['network 192.168.10.0 255.255.255.0', `default-router ${SNOOPING_ADDRESSES.r1}`]),
  ]);
}

/**
 * ROGUE: a home router somebody plugged into a wall port, its LAN serving its own pool. It boots in 15 s, long before
 * R1 (45 s), so it answers the PCs' first DHCP requests: the unsolved world opens with PC1 and ATTACKER on its lure.
 */
function rogueConfig(): string {
  return configText([
    ['hostname ROGUE'],
    section('interface Vlan1', [`ip address ${SNOOPING_ADDRESSES.rogue} ${MASK24}`]),
    section('ip dhcp pool LURE', ['network 10.66.0.0 255.255.255.0', `default-router ${SNOOPING_ADDRESSES.rogue}`]),
  ]);
}

/** A host that asks a DHCP server for its address from boot. */
function dhcpHost(hostname: string): string {
  return configText([[`hostname ${hostname}`], section('interface GigabitEthernet0', ['ip address dhcp'])]);
}

/** SW1 with PC1, a static server, an attacker and a rogue DHCP server; R1 behind a trunk serves VLAN 10. */
export const ccna3DhcpSnoopingDai: ScenarioInfo = {
  name: 'ccna3-dhcp-snooping-dai',
  category: 'ccna3-lab',
  labType: 'build',
  course: 'CCNA 3',
  topic: 'Hardening',
  title: 'DHCP snooping and dynamic ARP inspection',
  description:
    'A home router somebody plugged into a wall port answers DHCP before the real server can. Let only the uplink speak for DHCP servers, record who leased what, then use those records to drop forged ARP messages, without locking out the server that has a fixed address.',
  objectives: [
    'Stop a rogue DHCP server with DHCP snooping and a trusted uplink',
    'Read the bindings snooping records from DHCP exchanges',
    'Drop forged ARP messages with dynamic ARP inspection',
    'Keep a statically addressed host working under inspection with a static binding',
  ],
  tags: ['dhcp snooping', 'trusted port', 'binding', 'dynamic arp inspection', 'dai', 'ip source binding', 'rogue dhcp', 'arp spoofing'],
  difficulty: 3,
  estimatedMinutes: 40,
  requires: [HOME_ROUTER, PC, ROUTER, SERVER, SWITCH],
  seed: 320,
  instructions: [
    '## What you have',
    '',
    `SW1 holds VLAN 10 (\`USERS\`, \`192.168.10.0/24\`). R1 is its gateway (\`${SNOOPING_ADDRESSES.r1}\`, on \`GigabitEthernet0/0.10\`) and its DHCP server, behind the trunk on SW1 \`GigabitEthernet0/1\`. PC1 (\`Fa0/1\`) and ATTACKER (\`Fa0/5\`) ask for their addresses by DHCP; SRV1 (\`Fa0/2\`) has the fixed address \`${SNOOPING_ADDRESSES.srv1}\`. On \`Fa0/24\` somebody plugged in ROGUE, a home router whose LAN hands out addresses from \`10.66.0.0/24\`. Every access port is PortFast and so is the trunk, so nothing waits for spanning tree.`,
    '',
    'Run `ipconfig` on PC1: which server gave it its address? Can it ping R1?',
    '',
    '*ROGUE is up after about 15 s, SW1 after about 30 s and R1 after about 45 s; a PC that hears no server asks again a few seconds later, so allow about a minute before the leases settle.*',
    '',
    '## What to do',
    '',
    '- **Snooping.** On SW1 turn DHCP snooping on, globally and for VLAN 10. Trust the trunk to R1 (`ip dhcp snooping trust`), and only the trunk: server messages arriving on any other port are dropped.',
    `- **Rate limit.** Limit the DHCP messages each access port may send to ${SNOOPING_RATE_LIMIT} per second (\`ip dhcp snooping limit rate ${SNOOPING_RATE_LIMIT}\`). A port that sends more is shut down (error-disabled) until it is recovered. Nothing in this network sends that much, so this part is not graded; \`show ip dhcp snooping\` shows the limit.`,
    '- **Bindings.** Give back PC1\'s lease and ask again: `ipconfig /release`, then `ipconfig /renew` (or `no ip address dhcp`, then `ip address dhcp`). A renewal alone would ask ROGUE again, whose answer is now dropped. PC1 should now lease from R1, and `show ip dhcp snooping binding` on SW1 lists its MAC address, its address, VLAN 10 and `Fa0/1`.',
    '- **ARP inspection.** Turn on dynamic ARP inspection for VLAN 10 and trust the trunk for it too (`ip arp inspection trust`). An ARP message on an untrusted port must now match a binding.',
    '- **The server.** SRV1 has no lease, so no binding, and inspection drops every ARP it sends. Give SW1 a static binding for it: `ip source binding <SRV1 MAC> vlan 10 ' + `${SNOOPING_ADDRESSES.srv1} interface FastEthernet0/2\` (\`ipconfig /all\` on SRV1 shows its MAC address). Trusting its port would work too, but would let SRV1 claim any address.`,
    `- **Play the attacker.** Give ATTACKER the address of R1 (\`ip address ${SNOOPING_ADDRESSES.r1} 255.255.255.0\`). Its announcement claims R1's address and matches no binding: SW1 drops it (\`show ip arp inspection\` counts it), and PC1 keeps reaching R1.`,
  ].join('\n'),
  build: () =>
    topology(
      320,
      [
        device('sw1', SWITCH, 'SW1', 380, 280, snoopingSw1Config()),
        device('r1', ROUTER, 'R1', 380, 90, snoopingR1Config()),
        device('rogue', HOME_ROUTER, 'ROGUE', 640, 300, rogueConfig()),
        device('pc1', PC, 'PC1', 150, 420, dhcpHost('PC1')),
        device(SRV1_ID, SERVER, 'SRV1', 330, 480, pcConfig('SRV1', SNOOPING_ADDRESSES.srv1, MASK24, SNOOPING_ADDRESSES.r1)),
        device('attacker', PC, 'ATTACKER', 560, 470, dhcpHost('ATTACKER')),
      ],
      [
        link('l_r1_sw1', 'r1', 'GigabitEthernet0/0', 'sw1', 'GigabitEthernet0/1'),
        link('l_pc1_sw1', 'pc1', 'GigabitEthernet0', 'sw1', 'FastEthernet0/1'),
        link('l_srv1_sw1', SRV1_ID, 'GigabitEthernet0', 'sw1', 'FastEthernet0/2'),
        link('l_attacker_sw1', 'attacker', 'GigabitEthernet0', 'sw1', 'FastEthernet0/5'),
        link('l_rogue_sw1', 'rogue', 'GigabitEthernet1', 'sw1', 'FastEthernet0/24'),
      ],
      ['Stop the rogue DHCP server', 'Record the bindings', 'Inspect ARP', 'Keep the static server working', 'Drop a forged ARP'],
      'DHCP snooping splits ports into trusted ones, where server messages may arrive, and untrusted ones, where only clients may speak; from the exchanges it lets through it records which address each client leased on which port. Dynamic ARP inspection checks every ARP message on an untrusted port against those records.',
      { profile: 'P3' },
    ),
  tasks: [
    {
      id: 'snooping-on',
      title: 'DHCP snooping guards VLAN 10',
      description: 'SW1 runs DHCP snooping for VLAN 10.',
      points: 15,
      hint: 'Snooping needs both the global line and the VLAN line.',
      assertions: [{ kind: 'fact', device: 'SW1', fact: 'snooping.enabled', subject: '10', equals: true, misconception: 'snooping-global-line-only' }],
    },
    {
      id: 'trust-uplink',
      title: 'Only the uplink is trusted',
      description: 'The trunk to R1 is trusted for DHCP; the access ports, the rogue router\'s port among them, are not.',
      points: 15,
      assertions: [
        { kind: 'fact', device: 'SW1', fact: 'snooping.trusted', subject: 'GigabitEthernet0/1', equals: true, feedback: 'R1\'s answers arrive on the trunk.' },
        ...SNOOP_ACCESS.map((port) => ({ kind: 'fact', device: 'SW1', fact: 'snooping.trusted', subject: port, equals: false, misconception: 'trust-every-port' }) as const),
      ],
      feedbackOnFail: 'A trusted port may carry server messages; trust only the ports that lead to your real server.',
    },
    {
      id: 'pc1-bound',
      title: 'PC1 leases from R1 and is bound to its port',
      description: 'SW1 holds a binding for PC1 on FastEthernet0/1, and PC1 reaches R1.',
      points: 20,
      hint: 'A binding is written when a lease is granted through a trusted port: give back PC1\'s lease and ask again once snooping is on.',
      assertions: [
        { kind: 'fact', device: 'SW1', fact: 'snooping.bindingPort', subject: 'PC1', equals: 'FastEthernet0/1', feedback: 'SW1 has no binding for PC1 yet.' },
        { kind: 'connectivity', from: 'PC1', to: 'R1', toAddress: SNOOPING_ADDRESSES.r1, expect: 'success' },
      ],
    },
    {
      id: 'dai-on',
      title: 'ARP inspection guards VLAN 10',
      description: 'SW1 inspects ARP on VLAN 10 and trusts the trunk to R1 for it.',
      points: 15,
      assertions: [
        { kind: 'fact', device: 'SW1', fact: 'dai.enabled', subject: '10', equals: true },
        { kind: 'fact', device: 'SW1', fact: 'dai.trusted', subject: 'GigabitEthernet0/1', equals: true, feedback: 'R1\'s ARP messages arrive on the trunk, where no binding can match them.' },
      ],
    },
    {
      id: 'static-server',
      title: 'SRV1 keeps working under inspection',
      description: 'With ARP inspection on, SW1 holds a static binding for SRV1 on FastEthernet0/2 (its port stays untrusted) and SRV1 reaches R1.',
      points: 15,
      hint: 'A host with a fixed address never leases, so snooping never learns it: write its binding yourself.',
      assertions: [
        { kind: 'fact', device: 'SW1', fact: 'dai.enabled', subject: '10', equals: true },
        { kind: 'table', device: 'SW1', table: 'dhcp-snooping', where: { kind: 'static', ip: SNOOPING_ADDRESSES.srv1, port: 'FastEthernet0/2', vlan: 10 }, exists: true },
        { kind: 'fact', device: 'SW1', fact: 'dai.trusted', subject: 'FastEthernet0/2', equals: false, misconception: 'trust-the-static-host' },
        { kind: 'connectivity', from: 'SRV1', to: 'R1', toAddress: SNOOPING_ADDRESSES.r1, expect: 'success' },
      ],
    },
    {
      id: 'spoof-dropped',
      title: 'A forged ARP is dropped',
      description: 'ATTACKER claims R1\'s address, SW1 dropped at least one ARP message on VLAN 10 that matched no binding, and PC1 still reaches R1.',
      points: 20,
      hint: 'Give ATTACKER R1\'s address once inspection is on: it announces the address at once.',
      assertions: [
        // the attack itself: SRV1's own unbound ARPs also count as dropped, so the forged claim must have been made
        { kind: 'port', device: 'ATTACKER', port: 'GigabitEthernet0', field: 'ipv4', equals: SNOOPING_ADDRESSES.r1, feedback: "ATTACKER has not claimed R1's address yet." },
        { kind: 'fact', device: 'SW1', fact: 'dai.dropped', subject: '10', atLeast: 1, feedback: 'SW1 has not dropped an ARP message on VLAN 10 yet.' },
        { kind: 'connectivity', from: 'PC1', to: 'R1', toAddress: SNOOPING_ADDRESSES.r1, expect: 'success' },
      ],
    },
  ],
  solution: {
    SW1: [
      'ip dhcp snooping',
      'ip dhcp snooping vlan 10',
      'interface GigabitEthernet0/1',
      'ip dhcp snooping trust',
      'ip arp inspection trust',
      'exit',
      'interface range FastEthernet0/1 - 2 , FastEthernet0/5 , FastEthernet0/24',
      `ip dhcp snooping limit rate ${SNOOPING_RATE_LIMIT}`,
      'exit',
      `ip source binding ${SNOOPING_SRV1_MAC} vlan 10 ${SNOOPING_ADDRESSES.srv1} interface FastEthernet0/2`,
      'ip arp inspection vlan 10',
    ],
    PC1: ['no ip address dhcp', 'ip address dhcp'],
    ATTACKER: [`ip address ${SNOOPING_ADDRESSES.r1} 255.255.255.0`],
  },
};

/** The CCNA 3 hardening labs (lessons 19 and 20), in course order. */
export const CCNA3_HARDENING_LABS: readonly ScenarioInfo[] = Object.freeze([ccna3SecureDeviceAccess, ccna3DhcpSnoopingDai]);
