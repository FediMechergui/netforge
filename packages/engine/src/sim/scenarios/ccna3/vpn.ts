/**
 * sim/scenarios/ccna3/vpn.ts — the CCNA 3 tunnel and VPN labs (ARCHITECTURE-P3 §11.1, §11.2, §3.10, §3.13, D17, D27).
 *
 *   • `ccna3-gre-tunnel` [S18] — lesson 24 "GRE tunnels" (module "Tunnels and VPNs"): two sites reach the internet
 *     through a provider that knows only public networks. The learner builds a GRE tunnel between the two edge routers
 *     and routes each site's LAN through it; graded by the tunnel's row (`fact tunnel.up`), the routes, a ping in the
 *     grader's clone and the `path` kind with `tunnelAt {device: 'ISP', tunnel: 'gre'}` — every frame of the probe the
 *     provider receives is a GRE leg — while the provider still has no private route (`route none`).
 *   • `ccna3-ipsec-site-to-site` [C13] — lesson 25 "Site-to-site IPsec" (same module): the same two sites start with
 *     the working GRE tunnel of lesson 24 (routes through Tunnel0, §3.13's form). The learner adds the IKEv2 keyring,
 *     the IKEv2 profile and the IPsec profile, then turns Tunnel0 into a protected VTI. Graded by the configuration,
 *     `fact ipsec.sa` and `fact tunnel.up` on both ends, a ping in the clone and `path {tunnelAt: {device: 'ISP',
 *     tunnel: 'ipsec'}}`: only ESP crosses the provider (§3.13 step 12).
 *
 * The world is §3.10's: PC1 192.168.1.10 — R1 Gi0/0; R1 Se0/0/0 209.165.200.225/30 — ISP — R2 Se0/0/0
 * 209.165.200.230/30; R2 Gi0/0 — PC2 192.168.2.10. The ISP is the DCE end of both serial links and has no private
 * route; each edge router's default route points at it, so before the tunnel a ping between the sites dies at the
 * ISP ("destination unreachable") and every ping that succeeds afterwards PROVES the tunnel carried it. Both labs are
 * P3-profile worlds (`topology(…, {profile: 'P3'})`, schema 1.3). No lab has a switch: each host is cabled straight to
 * its router, so there is no access port to make an edge port (§11.2's PortFast rule holds vacuously). The routers
 * take 45 s to boot; nothing in these labs waits on a protocol timer (no routing protocol; IKE completes within about a
 * second once both ends are configured — its four messages take a few milliseconds of serial time, and an end that has
 * been retransmitting to an unready peer sends its request again as soon as the peer starts its own (W5 fix #13) — and
 * retries every 10 s after a failure, §3.13 step 10), so the timing sentence is "about a minute".
 *
 * Addresses come from the private and documentation ranges; the pre-shared key is a lab value; all wording is
 * original (§0 rule 6). A lab file imports only the contracts, `../kit.js` and `../templates.js` — never `./index.js`,
 * `../index.js` or the engine barrel — so the catalogue stays an acyclic graph of data modules (rule 12).
 *
 * ponytail: lab 25 starts from lab 24's goal with the routes written through `Tunnel0` (§3.13's setup), not
 * through the far tunnel address: a route that names a down tunnel interface is unusable, so while IKE has not
 * finished (or has failed) a site's traffic follows the default route and dies at the ISP, which is the lesson of
 * §3.13 step 10. Lab 24's route task accepts either form (it reads the exit interface of the installed route, which
 * both forms resolve to Tunnel0). The configuration checks pin the names the instructions give (the keyring, the two
 * profiles: each is referenced by name from the next), the IKEv2 profile's remote identity (the other router's public
 * address) and its two pre-share authentication lines (W5 fix #12: the daemon does not refuse a profile without them),
 * but not the keyring's peer label, which nothing references. Lab 24's build task reads the tunnels row, which holds
 * the resolved source address, so a tunnel sourced from the LAN interface fails it (W5 fix #14).
 * Every task of both labs holds an assertion that only the learner's work makes true, so an unsolved world fails
 * every task — lab 25's working GRE ping included, whose frames at the ISP are GRE legs, not ESP.
 */
import type { LabAssertion, ScenarioInfo } from '../../../contracts/scenario.js';
import type { Topology } from '../../../contracts/topology.js';
import { MASK24, MASK30, PC, ROUTER, cable, configText, device, link, section, topology } from '../kit.js';
import { pcConfig } from '../templates.js';

// ── names and addresses (§3.10, §3.13) ───────────────────────────────────────────────────────────────────────────

/** The tunnel interface both labs build. */
export const VPN_TUNNEL = 'Tunnel0';
/** Each edge router's WAN interface toward the provider (the tunnel source). */
export const VPN_WAN_PORT = 'Serial0/0/0';
/** R1's and R2's public addresses (the tunnel endpoints). */
export const VPN_R1_PUBLIC = '209.165.200.225';
export const VPN_R2_PUBLIC = '209.165.200.230';
/** The provider's addresses toward R1 and R2 (the edge routers' default gateways). */
export const VPN_ISP_TO_R1 = '209.165.200.226';
export const VPN_ISP_TO_R2 = '209.165.200.229';
/** The tunnel's own subnet and its two ends. */
export const VPN_TUNNEL_R1 = '172.16.0.1';
export const VPN_TUNNEL_R2 = '172.16.0.2';
/** The two site LANs and their hosts. */
export const VPN_SITE1_LAN = '192.168.1.0';
export const VPN_SITE2_LAN = '192.168.2.0';
export const VPN_PC1 = '192.168.1.10';
export const VPN_PC2 = '192.168.2.10';
/** The serial clock the provider supplies on both links (it is the DCE end). */
export const VPN_CLOCK_RATE_BPS = 2_000_000;
/** Lab 25: the IKEv2 keyring, the IKEv2 profile and the IPsec profile, and the pre-shared key (a lab value). */
export const VPN_IPSEC_KEYRING = 'SITE-KEYS';
export const VPN_IKE_PROFILE = 'SITE-IKE';
export const VPN_IPSEC_PROFILE = 'SITE-VPN';
export const VPN_IPSEC_KEY = 'Harbour-Link-2525';

/** One interface of a router's startup configuration: its lines, `no shutdown` appended. */
interface RouterPort {
  readonly port: string;
  readonly lines: readonly string[];
}

/** A router's startup configuration: host name, interfaces (each enabled), then extra sections (routes, tunnel …). */
function routerText(hostname: string, ports: readonly RouterPort[], extra: readonly (readonly string[])[] = []): string {
  const sections: string[][] = [[`hostname ${hostname}`]];
  for (const p of ports) sections.push(section(`interface ${p.port}`, [...p.lines, 'no shutdown']));
  for (const s of extra) sections.push([...s]);
  return configText(sections);
}

/** The provider: the DCE end of both serial links, public networks only. */
function ispConfig(): string {
  const clock = `clock rate ${VPN_CLOCK_RATE_BPS}`;
  return routerText('ISP', [
    { port: 'Serial0/0/0', lines: [`ip address ${VPN_ISP_TO_R1} ${MASK30}`, clock] },
    { port: 'Serial0/0/1', lines: [`ip address ${VPN_ISP_TO_R2} ${MASK30}`, clock] },
  ]);
}

/** One site's edge router as both labs see it. */
interface EdgeSite {
  readonly name: string;
  readonly lan: string;
  readonly wan: string;
  readonly gateway: string;
  readonly tunnelAddress: string;
  readonly peerPublic: string;
  readonly peerTunnel: string;
  readonly remoteLan: string;
}

const SITE1: EdgeSite = {
  name: 'R1',
  lan: '192.168.1.1',
  wan: VPN_R1_PUBLIC,
  gateway: VPN_ISP_TO_R1,
  tunnelAddress: VPN_TUNNEL_R1,
  peerPublic: VPN_R2_PUBLIC,
  peerTunnel: VPN_TUNNEL_R2,
  remoteLan: VPN_SITE2_LAN,
};
const SITE2: EdgeSite = {
  name: 'R2',
  lan: '192.168.2.1',
  wan: VPN_R2_PUBLIC,
  gateway: VPN_ISP_TO_R2,
  tunnelAddress: VPN_TUNNEL_R2,
  peerPublic: VPN_R1_PUBLIC,
  peerTunnel: VPN_TUNNEL_R1,
  remoteLan: VPN_SITE1_LAN,
};

/** An edge router: LAN and WAN addressed and up, a default route to the provider, and the lab's `extra` sections. */
function edgeConfig(site: EdgeSite, extra: readonly (readonly string[])[] = []): string {
  return routerText(
    site.name,
    [
      { port: 'GigabitEthernet0/0', lines: [`ip address ${site.lan} ${MASK24}`] },
      { port: VPN_WAN_PORT, lines: [`ip address ${site.wan} ${MASK30}`] },
    ],
    [[`ip route 0.0.0.0 0.0.0.0 ${site.gateway}`], ...extra],
  );
}

/** The plain GRE tunnel of lab 24's goal: address, source and destination (mode `gre ip` is the default). */
function greTunnelLines(site: EdgeSite): string[] {
  return [`ip address ${site.tunnelAddress} ${MASK30}`, `tunnel source ${VPN_WAN_PORT}`, `tunnel destination ${site.peerPublic}`];
}

/** The two sites, the provider and the two hosts; `r1` / `r2` are the edge routers' startup configurations. */
function vpnWorld(seed: number, r1: string, r2: string, objectives: readonly string[], notes: string): Topology {
  return topology(
    seed,
    [
      device('pc1', PC, 'PC1', 80, 260, pcConfig('PC1', VPN_PC1, MASK24, SITE1.lan)),
      device('r1', ROUTER, 'R1', 260, 260, r1),
      device('isp', ROUTER, 'ISP', 470, 140, ispConfig()),
      device('r2', ROUTER, 'R2', 680, 260, r2),
      device('pc2', PC, 'PC2', 860, 260, pcConfig('PC2', VPN_PC2, MASK24, SITE2.lan)),
    ],
    [
      link('l_pc1_r1', 'pc1', 'GigabitEthernet0', 'r1', 'GigabitEthernet0/0'),
      cable('l_isp_r1', 'isp', 'Serial0/0/0', 'r1', VPN_WAN_PORT, 'serial-dce'),
      cable('l_isp_r2', 'isp', 'Serial0/0/1', 'r2', VPN_WAN_PORT, 'serial-dce'),
      link('l_r2_pc2', 'r2', 'GigabitEthernet0/0', 'pc2', 'GigabitEthernet0'),
    ],
    objectives,
    notes,
    { profile: 'P3' },
  );
}

/** The provider is left as it is: no route to either private LAN (both labs' last task; §3.10's "no private routes"). */
const PROVIDER_HAS_NO_PRIVATE_ROUTE: readonly LabAssertion[] = [
  { kind: 'route', device: 'ISP', destination: VPN_PC1, none: true, feedback: 'The provider must stay as it is: the tunnel, not a route at the ISP, carries the private networks.' },
  { kind: 'route', device: 'ISP', destination: VPN_PC2, none: true, feedback: 'The provider must stay as it is: the tunnel, not a route at the ISP, carries the private networks.' },
];

// ── lab 24: a GRE tunnel [S18] ────────────────────────────────────────────────────────────────────────────────────

/** Lab 24 seed. */
export const VPN_GRE_LAB_SEED = 324;

/** Two sites behind a provider with public routes only; the learner builds and routes through a GRE tunnel. */
export const ccna3GreTunnel: ScenarioInfo = {
  name: 'ccna3-gre-tunnel',
  category: 'ccna3-lab',
  labType: 'build',
  course: 'CCNA 3',
  topic: 'Tunnels and VPNs',
  title: 'A GRE tunnel between two sites',
  description:
    'Two sites share a provider that carries only public addresses, so their private LANs cannot reach each other. Build a GRE tunnel between the edge routers, route each LAN through it, and see what the provider can read.',
  objectives: [
    'Create a tunnel interface with an address, a source and a destination',
    'Route a remote private network through the tunnel',
    'Explain why the provider forwards tunnelled packets it has no route for',
    'Show that GRE on its own hides nothing from the provider',
  ],
  tags: ['GRE', 'tunnel', 'overlay', 'static routing', 'site-to-site'],
  difficulty: 2,
  estimatedMinutes: 25,
  requires: [PC, ROUTER],
  seed: VPN_GRE_LAB_SEED,
  instructions: [
    '## What you have',
    '',
    `Site 1 (R1, PC1 in \`${VPN_SITE1_LAN}/24\`) and Site 2 (R2, PC2 in \`${VPN_SITE2_LAN}/24\`) each reach the internet through the provider router ISP over a serial link: R1 is \`${VPN_R1_PUBLIC}\`, R2 is \`${VPN_R2_PUBLIC}\`, and each edge router has a default route to the ISP. The ISP knows only its public networks. A ping from PC1 to PC2 therefore reaches the ISP and stops there: it has no route to a private address.`,
    '',
    'The routers take about a minute to start after the lab loads (each needs 45 s to boot). Wait for their prompts before you begin.',
    '',
    '## What to do',
    '',
    `- On R1, create \`interface ${VPN_TUNNEL}\` with the address \`${VPN_TUNNEL_R1}/30\`. Its **source** is \`${VPN_WAN_PORT}\` and its **destination** is R2's public address \`${VPN_R2_PUBLIC}\`. Do the mirror image on R2 (\`${VPN_TUNNEL_R2}/30\`, destination \`${VPN_R1_PUBLIC}\`).`,
    `- Check \`show interfaces ${VPN_TUNNEL}\` on both routers: the line protocol comes up as soon as the router has a route to the destination, and the tunnel can carry at most 1476 bytes of IP, 24 fewer than the serial link.`,
    `- On R1, route \`${VPN_SITE2_LAN}/24\` to the far end of the tunnel, \`${VPN_TUNNEL_R2}\`. On R2, route \`${VPN_SITE1_LAN}/24\` to \`${VPN_TUNNEL_R1}\`. (Naming \`${VPN_TUNNEL}\` as the exit interface works too: the tunnel has exactly one router at its far end.) Leave the ISP exactly as it is.`,
    '- Ping PC2 from PC1. The routers wrap each private packet in a new IPv4 header between the two public addresses (protocol 47, GRE), so the ISP forwards it with the public routes it already has.',
    '- Capture on the ISP and open one of the tunnelled packets: the ICMP message and both private addresses are there in plain view. GRE builds a path; it does not keep a secret.',
    '',
    '*A tunnel is a virtual point-to-point link drawn over another network. Routing treats it like any other interface.*',
  ].join('\n'),
  build: () =>
    vpnWorld(
      VPN_GRE_LAB_SEED,
      edgeConfig(SITE1),
      edgeConfig(SITE2),
      ['Build a GRE tunnel between the two edge routers', 'Route each site LAN through the tunnel', 'Ping across the provider without changing it'],
      'The ISP routes only public addresses. A GRE tunnel carries the private packets inside public ones.',
    ),
  tasks: [
    {
      id: 'build-tunnel',
      title: 'Tunnel0 up on both edge routers',
      description: `R1 and R2 each have ${VPN_TUNNEL} with its /30 address, sourced from the serial link to the provider and aimed at the other router's public address, and the tunnel is up.`,
      points: 30,
      hint: 'A tunnel needs three things besides its address: an interface to leave from, an address to go to, and a route to that address.',
      assertions: [
        { kind: 'port', device: 'R1', port: VPN_TUNNEL, field: 'ipv4', equals: `${VPN_TUNNEL_R1}/30` },
        { kind: 'port', device: 'R2', port: VPN_TUNNEL, field: 'ipv4', equals: `${VPN_TUNNEL_R2}/30` },
        { kind: 'config', device: 'R1', path: `interface.${VPN_TUNNEL}.tunnel.destination`, equals: ['destination', VPN_R2_PUBLIC] },
        { kind: 'config', device: 'R2', path: `interface.${VPN_TUNNEL}.tunnel.destination`, equals: ['destination', VPN_R1_PUBLIC] },
        // the tunnels row holds the RESOLVED source address, so `tunnel source Serial0/0/0` and the address form both pass
        { kind: 'table', device: 'R1', table: 'tunnels', where: { port: VPN_TUNNEL, source: VPN_R1_PUBLIC, destination: VPN_R2_PUBLIC }, exists: true, feedback: "The tunnel must leave from the serial link to the provider and aim at the other router's public address." },
        { kind: 'table', device: 'R2', table: 'tunnels', where: { port: VPN_TUNNEL, source: VPN_R2_PUBLIC, destination: VPN_R1_PUBLIC }, exists: true, feedback: "The tunnel must leave from the serial link to the provider and aim at the other router's public address." },
        { kind: 'fact', device: 'R1', fact: 'tunnel.up', subject: VPN_TUNNEL, equals: true, feedback: 'Check the source interface and the destination address: the router must reach the destination without the tunnel.' },
        { kind: 'fact', device: 'R2', fact: 'tunnel.up', subject: VPN_TUNNEL, equals: true, feedback: 'Check the source interface and the destination address: the router must reach the destination without the tunnel.' },
      ],
    },
    {
      id: 'route-through-tunnel',
      title: 'Each LAN routed through the tunnel',
      description: `R1 sends ${VPN_SITE2_LAN}/24 and R2 sends ${VPN_SITE1_LAN}/24 out of ${VPN_TUNNEL}, toward the far end of the tunnel.`,
      points: 30,
      hint: 'The next hop of the remote LAN is the address of the far end of the tunnel, not a public address.',
      dependsOn: ['build-tunnel'],
      assertions: [
        // either form passes: the far tunnel address as next hop (the instructions' form) or Tunnel0 as exit interface
        { kind: 'route', device: 'R1', destination: VPN_PC2, network: `${VPN_SITE2_LAN}/24`, iface: VPN_TUNNEL },
        { kind: 'route', device: 'R2', destination: VPN_PC1, network: `${VPN_SITE1_LAN}/24`, iface: VPN_TUNNEL },
      ],
    },
    {
      id: 'site-to-site',
      title: 'PC1 reaches PC2 through the tunnel',
      description: 'A ping from PC1 to PC2 succeeds, every packet of it that the ISP receives is a GRE packet, and the ISP still has no route to either private LAN.',
      points: 40,
      hint: 'If the ping fails, ping the far tunnel address from each router first, then check the routes back.',
      dependsOn: ['route-through-tunnel'],
      assertions: [
        { kind: 'connectivity', from: 'PC1', to: 'PC2', expect: 'success' },
        {
          kind: 'path',
          from: 'PC1',
          to: 'PC2',
          via: ['R1', 'R2'],
          tunnelAt: { device: 'ISP', tunnel: 'gre' },
          feedback: 'The ISP must see only tunnelled packets between the two public addresses.',
        },
        ...PROVIDER_HAS_NO_PRIVATE_ROUTE,
      ],
    },
  ],
  solution: {
    R1: ['interface Tunnel0', ...greTunnelLines(SITE1), 'exit', `ip route ${SITE1.remoteLan} ${MASK24} ${SITE1.peerTunnel}`],
    R2: ['interface Tunnel0', ...greTunnelLines(SITE2), 'exit', `ip route ${SITE2.remoteLan} ${MASK24} ${SITE2.peerTunnel}`],
  },
};

// ── lab 25: site-to-site IPsec [C13] ──────────────────────────────────────────────────────────────────────────────

/** Lab 25 seed. */
export const VPN_IPSEC_LAB_SEED = 325;

/** The working GRE tunnel lab 25 starts from, with the remote LAN routed through Tunnel0 (§3.13's form). */
function greStart(site: EdgeSite): string[][] {
  return [section(`interface ${VPN_TUNNEL}`, greTunnelLines(site)), [`ip route ${site.remoteLan} ${MASK24} ${VPN_TUNNEL}`]];
}

/** Lab 25's solution on one end: keyring, IKEv2 profile, IPsec profile, then the tunnel turned into a protected VTI. */
function ipsecSolution(site: EdgeSite, peerName: string): string[] {
  return [
    `crypto ikev2 keyring ${VPN_IPSEC_KEYRING}`,
    `peer ${peerName}`,
    `address ${site.peerPublic}`,
    `pre-shared-key ${VPN_IPSEC_KEY}`,
    'exit',
    'exit',
    `crypto ikev2 profile ${VPN_IKE_PROFILE}`,
    `match identity remote address ${site.peerPublic} 255.255.255.255`,
    'authentication remote pre-share',
    'authentication local pre-share',
    `keyring local ${VPN_IPSEC_KEYRING}`,
    'exit',
    `crypto ipsec profile ${VPN_IPSEC_PROFILE}`,
    `set ikev2-profile ${VPN_IKE_PROFILE}`,
    'exit',
    `interface ${VPN_TUNNEL}`,
    'tunnel mode ipsec ipv4',
    `tunnel protection ipsec profile ${VPN_IPSEC_PROFILE}`,
    'exit',
  ];
}

/** The two sites already joined by plain GRE; the learner protects the tunnel with IKEv2 and ESP. */
export const ccna3IpsecSiteToSite: ScenarioInfo = {
  name: 'ccna3-ipsec-site-to-site',
  category: 'ccna3-lab',
  labType: 'build',
  course: 'CCNA 3',
  topic: 'Tunnels and VPNs',
  title: 'Protecting the tunnel with IPsec',
  description:
    'The two sites already talk through a GRE tunnel, and the provider can read every packet. Turn the tunnel into an IPsec virtual tunnel interface, let IKEv2 agree the keys, and prove that only ESP crosses the provider.',
  objectives: [
    'Store a pre-shared key for a peer in an IKEv2 keyring',
    'Tie the keyring to the peer in an IKEv2 profile and the profile to an IPsec profile',
    'Turn a GRE tunnel into a protected virtual tunnel interface',
    'Read the security association and prove that the provider sees only ESP',
  ],
  tags: ['IPsec', 'IKEv2', 'ESP', 'VTI', 'site-to-site VPN', 'pre-shared key'],
  difficulty: 3,
  estimatedMinutes: 30,
  requires: [PC, ROUTER],
  seed: VPN_IPSEC_LAB_SEED,
  instructions: [
    '## What you have',
    '',
    `The network of the GRE lab, finished: R1 and R2 are joined by \`${VPN_TUNNEL}\` (\`${VPN_TUNNEL_R1}\` and \`${VPN_TUNNEL_R2}\`, between the public addresses \`${VPN_R1_PUBLIC}\` and \`${VPN_R2_PUBLIC}\`), and each router sends the other site's LAN out of \`${VPN_TUNNEL}\`. PC1 can ping PC2, and the ISP still knows only public networks. Capture on the ISP and ping once: every tunnelled packet shows its ICMP message and private addresses to anyone on the provider's path.`,
    '',
    'The routers take about a minute to start after the lab loads (each needs 45 s to boot). Wait for their prompts before you begin.',
    '',
    '## What to do',
    '',
    `- On R1, create the IKEv2 keyring \`${VPN_IPSEC_KEYRING}\` with one peer, \`R2\`, at \`${VPN_R2_PUBLIC}\`, and the pre-shared key \`${VPN_IPSEC_KEY}\`.`,
    `- Create the IKEv2 profile \`${VPN_IKE_PROFILE}\`: it matches the remote identity \`${VPN_R2_PUBLIC} 255.255.255.255\`, authenticates both ends with the pre-shared key, and takes its keys from \`${VPN_IPSEC_KEYRING}\`.`,
    `- Create the IPsec profile \`${VPN_IPSEC_PROFILE}\` that uses \`${VPN_IKE_PROFILE}\`.`,
    `- On \`${VPN_TUNNEL}\`, change the tunnel mode to \`ipsec ipv4\` and protect it with \`${VPN_IPSEC_PROFILE}\`. The tunnel goes down until IKEv2 has agreed the keys with the other end.`,
    `- Do the mirror image on R2: its peer \`R1\` is \`${VPN_R1_PUBLIC}\`, with the same key. As soon as both ends are ready the tunnel comes back up, usually within a second: the four IKEv2 messages themselves take a few milliseconds, and an end that has been waiting for its peer sends its request again as soon as the peer starts its own. If the keys differ, both ends report a failed negotiation and try again every 10 seconds.`,
    `- Read \`show crypto ikev2 sa\` and \`show crypto ipsec sa\`, then ping PC2 from PC1. Capture on the ISP again: every tunnelled packet is now IPv4 protocol 50 (ESP), and the filter \`esp\` matches them all.`,
    '',
    '*The cryptography is simulated: the IKEv2 and ESP headers are real, and the protected packet is shown decoded under an "Encrypted (ESP, simulated)" banner so you can follow it. The key itself never appears in a packet.*',
  ].join('\n'),
  build: () =>
    vpnWorld(
      VPN_IPSEC_LAB_SEED,
      edgeConfig(SITE1, greStart(SITE1)),
      edgeConfig(SITE2, greStart(SITE2)),
      ['Configure IKEv2 with a pre-shared key on both edge routers', 'Protect the tunnel with an IPsec profile', 'Prove that only ESP crosses the provider'],
      'A GRE tunnel already joins the two sites. IPsec keeps the same tunnel and routes, and hides what it carries.',
    ),
  tasks: [
    {
      id: 'ike-setup',
      title: 'IKEv2 keyring, profile and IPsec profile on both ends',
      description: `Each router has the keyring ${VPN_IPSEC_KEYRING} with the other router's public address, the IKEv2 profile ${VPN_IKE_PROFILE} that matches it, authenticates both ends with the pre-shared key and uses that keyring, and the IPsec profile ${VPN_IPSEC_PROFILE} that uses ${VPN_IKE_PROFILE}.`,
      points: 20,
      hint: 'Three sections chain together: the IPsec profile names the IKEv2 profile, which names the keyring, which holds the peer and its key.',
      assertions: [
        { kind: 'config', device: 'R1', path: `crypto.ikev2.keyring.${VPN_IPSEC_KEYRING}.peer.address`, equals: VPN_R2_PUBLIC },
        { kind: 'config', device: 'R1', path: `crypto.ikev2.keyring.${VPN_IPSEC_KEYRING}.peer.pre-shared-key`, exists: true },
        { kind: 'config', device: 'R1', path: `crypto.ikev2.profile.${VPN_IKE_PROFILE}.keyring.local`, equals: ['local', VPN_IPSEC_KEYRING] },
        { kind: 'config', device: 'R1', path: `crypto.ikev2.profile.${VPN_IKE_PROFILE}.match.identity.remote.address`, contains: `address ${VPN_R2_PUBLIC}`, feedback: "R1's profile must match R2's public address as the remote identity." },
        { kind: 'config', device: 'R1', path: `crypto.ikev2.profile.${VPN_IKE_PROFILE}.authentication.local`, equals: ['local', 'pre-share'] },
        { kind: 'config', device: 'R1', path: `crypto.ikev2.profile.${VPN_IKE_PROFILE}.authentication.remote`, equals: ['remote', 'pre-share'] },
        { kind: 'config', device: 'R1', path: `crypto.ipsec.profile.${VPN_IPSEC_PROFILE}.set.ikev2-profile`, equals: ['ikev2-profile', VPN_IKE_PROFILE] },
        { kind: 'config', device: 'R2', path: `crypto.ikev2.keyring.${VPN_IPSEC_KEYRING}.peer.address`, equals: VPN_R1_PUBLIC },
        { kind: 'config', device: 'R2', path: `crypto.ikev2.keyring.${VPN_IPSEC_KEYRING}.peer.pre-shared-key`, exists: true },
        { kind: 'config', device: 'R2', path: `crypto.ikev2.profile.${VPN_IKE_PROFILE}.keyring.local`, equals: ['local', VPN_IPSEC_KEYRING] },
        { kind: 'config', device: 'R2', path: `crypto.ikev2.profile.${VPN_IKE_PROFILE}.match.identity.remote.address`, contains: `address ${VPN_R1_PUBLIC}`, feedback: "R2's profile must match R1's public address as the remote identity." },
        { kind: 'config', device: 'R2', path: `crypto.ikev2.profile.${VPN_IKE_PROFILE}.authentication.local`, equals: ['local', 'pre-share'] },
        { kind: 'config', device: 'R2', path: `crypto.ikev2.profile.${VPN_IKE_PROFILE}.authentication.remote`, equals: ['remote', 'pre-share'] },
        { kind: 'config', device: 'R2', path: `crypto.ipsec.profile.${VPN_IPSEC_PROFILE}.set.ikev2-profile`, equals: ['ikev2-profile', VPN_IKE_PROFILE] },
      ],
    },
    {
      id: 'protect-tunnel',
      title: 'Tunnel0 is a protected VTI on both ends',
      description: `${VPN_TUNNEL} on R1 and R2 runs in IPsec mode and is protected by the IPsec profile ${VPN_IPSEC_PROFILE}.`,
      points: 20,
      hint: 'Two lines on the tunnel interface: one changes its mode, the other names the IPsec profile.',
      assertions: [
        { kind: 'config', device: 'R1', path: `interface.${VPN_TUNNEL}.tunnel.mode.ipsec.ipv4`, exists: true },
        { kind: 'config', device: 'R1', path: `interface.${VPN_TUNNEL}.tunnel.protection.ipsec.profile.${VPN_IPSEC_PROFILE}`, exists: true },
        { kind: 'config', device: 'R2', path: `interface.${VPN_TUNNEL}.tunnel.mode.ipsec.ipv4`, exists: true },
        { kind: 'config', device: 'R2', path: `interface.${VPN_TUNNEL}.tunnel.protection.ipsec.profile.${VPN_IPSEC_PROFILE}`, exists: true },
      ],
    },
    {
      id: 'sa-established',
      title: 'The security association is up',
      description: `IKEv2 has finished on both routers: the IPsec SA of ${VPN_TUNNEL} is established and the tunnel is up again.`,
      points: 25,
      hint: 'A failed negotiation usually means the two keys differ, or a peer address or identity names the wrong router.',
      dependsOn: ['ike-setup', 'protect-tunnel'],
      assertions: [
        { kind: 'fact', device: 'R1', fact: 'ipsec.sa', subject: VPN_TUNNEL, equals: 'established', feedback: 'Compare the keys and peer addresses on the two routers.' },
        { kind: 'fact', device: 'R2', fact: 'ipsec.sa', subject: VPN_TUNNEL, equals: 'established', feedback: 'Compare the keys and peer addresses on the two routers.' },
        { kind: 'fact', device: 'R1', fact: 'tunnel.up', subject: VPN_TUNNEL, equals: true },
        { kind: 'fact', device: 'R2', fact: 'tunnel.up', subject: VPN_TUNNEL, equals: true },
      ],
    },
    {
      id: 'only-esp',
      title: 'Only ESP crosses the provider',
      description: 'A ping from PC1 to PC2 succeeds, every packet of it that the ISP receives is an ESP packet of the protected tunnel, and the ISP still has no route to either private LAN.',
      points: 35,
      hint: 'If the ping works but this task fails, the tunnel still runs plain GRE: look at its mode and protection lines.',
      dependsOn: ['sa-established'],
      assertions: [
        { kind: 'connectivity', from: 'PC1', to: 'PC2', expect: 'success' },
        {
          kind: 'path',
          from: 'PC1',
          to: 'PC2',
          tunnelAt: { device: 'ISP', tunnel: 'ipsec' },
          feedback: 'Every packet between the sites must reach the ISP as ESP: check that both ends protect the tunnel.',
        },
        ...PROVIDER_HAS_NO_PRIVATE_ROUTE,
      ],
    },
  ],
  solution: {
    R1: ipsecSolution(SITE1, 'R2'),
    R2: ipsecSolution(SITE2, 'R1'),
  },
};

/** The CCNA 3 tunnel and VPN labs (lessons 24 and 25), in course order. */
export const CCNA3_VPN_LABS: readonly ScenarioInfo[] = Object.freeze([ccna3GreTunnel, ccna3IpsecSiteToSite]);
