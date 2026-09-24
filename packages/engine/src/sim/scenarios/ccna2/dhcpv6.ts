/**
 * sim/scenarios/ccna2/dhcpv6.ts — the CCNA 2 DHCPv6 lab (ARCHITECTURE-P2 §11.1, §11.2, D16, §3.11).
 *
 *   • `ccna2-dhcpv6` — lesson 19 "SLAAC and DHCPv6" (module "Addressing services"): one router, two LANs, two ways
 *     for an IPv6 host to get what it needs. The office LAN goes STATELESS — the hosts keep building their addresses
 *     from the router advertisements (SLAAC) and ask DHCPv6 only for the name server and the domain, because the
 *     advertisements carry the other-configuration flag. The lab LAN goes STATEFUL — the managed-configuration flag
 *     sends the hosts to DHCPv6 for their address as well, leased from a pool.
 *
 * The world is P2-profile (`topology(…, { profile: 'P2' })`) with no switch: each PC is cabled straight to its router
 * interface, so nothing waits on spanning tree. Both PCs run `ipv6 address autoconfig` from the start, as any host
 * would; what they do is decided by the flags R1 advertises. Tasks read structured state only (sim/lab-checks.ts):
 * `config` for the pools and the two flags (a host-side `ipv6 address dhcp` could fake a stateful client, but not the
 * flag the lesson is about), `process` for the DHCPv6 client of each PC (mode and state), the name servers its
 * `dns-client` learned and the origin of its SLAAC address, `port` for the leased address, `table` for the binding on
 * R1, and `connectivity` with `then` to prove that a cold start of the saved configuration leases again. All wording
 * is original (§0 rule 6); the prefixes come from the documentation range.
 *
 * A lab file imports only the contracts, `../kit.js` and `../templates.js` — never `./index.js`, `../index.js` or
 * the engine barrel — so the catalogue stays an acyclic graph of data modules (the arrays are read at module scope).
 *
 * ponytail: the leased address is exactly `2001:db8:b::2` — the server leases the lowest free address of the prefix
 * from `::2`, skipping its own `::1` (§3.11) — and there is one host per LAN, so no draw decides who gets which address.
 * The name server `2001:db8:a::53` is handed out as data: no host in this topology answers at that address. A host
 * learns new flags only from the next advertisement — the periodic one (every 200 s) or one it solicits — and R1 sends
 * nothing extra when its flags change, so the reference solution restarts each PC's adapter (a solicitation at
 * link-up) and the instructions tell the student to do the same.
 */
import type { ScenarioInfo } from '../../../contracts/scenario.js';
import { PC, ROUTER, configText, device, link, section, topology } from '../kit.js';

/** Pool of the office LAN (stateless: options only). */
export const DHCPV6_STATELESS_POOL = 'OFFICE';
/** Pool of the lab LAN (stateful: addresses and options). */
export const DHCPV6_STATEFUL_POOL = 'LAB';
/** The name server and domain both pools hand out. */
export const DHCPV6_DNS_SERVER = '2001:db8:a::53';
export const DHCPV6_DOMAIN = 'lab.nf';
/** The prefix of the lab LAN, and the address PC2 leases from it. */
export const DHCPV6_LAB_PREFIX = '2001:db8:b::/64';
export const DHCPV6_LEASED_ADDRESS = '2001:db8:b::2';

/** An IPv6 host that listens to router advertisements, as every host does out of the box. */
function autoconfigHost(hostname: string): string {
  return configText([[`hostname ${hostname}`], section('interface GigabitEthernet0', ['ipv6 address autoconfig'])]);
}

/** R1 before the lab: IPv6 forwarding and one prefix per LAN, advertised with both flags clear. */
function routerConfig(): string {
  return configText([
    ['hostname R1', 'ipv6 unicast-routing'],
    section('interface GigabitEthernet0/0', ['ipv6 address 2001:db8:a::1/64', 'no shutdown']),
    section('interface GigabitEthernet0/1', ['ipv6 address 2001:db8:b::1/64', 'no shutdown']),
  ]);
}

/** One router, an office LAN and a lab LAN; both hosts build SLAAC addresses and nothing else yet. */
export const ccna2Dhcpv6: ScenarioInfo = {
  name: 'ccna2-dhcpv6',
  category: 'ccna2-lab',
  labType: 'guided',
  course: 'CCNA 2',
  topic: 'Addressing services',
  title: 'Stateless and stateful DHCPv6',
  description:
    'Both LANs of a router hand out IPv6 prefixes, but no host learns a name server. Serve the office LAN stateless DHCPv6 next to SLAAC, lease the lab LAN its addresses with stateful DHCPv6, and set the advertisement flags that send each host the right way.',
  objectives: [
    'Build a DHCPv6 pool that hands out only a name server and a domain',
    'Build a DHCPv6 pool that leases addresses from a prefix',
    'Set the managed and other-configuration flags that tell hosts which method to use',
    'Tell a SLAAC address from a leased one on a host, and find the lease on the router',
  ],
  tags: ['ipv6', 'dhcpv6', 'slaac', 'stateless', 'stateful', 'router advertisement flags'],
  difficulty: 2,
  estimatedMinutes: 25,
  requires: [PC, ROUTER],
  seed: 219,
  instructions: [
    '## What you have',
    '',
    'R1 routes IPv6 between the office LAN `2001:db8:a::/64` (PC1, on `GigabitEthernet0/0`) and the lab LAN `2001:db8:b::/64` (PC2, on `GigabitEthernet0/1`), and advertises both prefixes. Each PC builds its own address from those advertisements, but the advertisements say nothing about DHCPv6, so no host learns a name server.',
    '',
    '## What to do',
    '',
    `- **Office LAN, stateless.** Create the DHCPv6 pool \`${DHCPV6_STATELESS_POOL}\` with the name server \`${DHCPV6_DNS_SERVER}\` and the domain \`${DHCPV6_DOMAIN}\`, and no addresses. Serve it on \`GigabitEthernet0/0\` and set the **other-configuration** flag there: PC1 keeps its own address and asks DHCPv6 only for the rest.`,
    `- **Lab LAN, stateful.** Create the pool \`${DHCPV6_STATEFUL_POOL}\` that leases addresses from \`${DHCPV6_LAB_PREFIX}\`, with the same name server and domain. Serve it on \`GigabitEthernet0/1\` and set the **managed-configuration** flag there: PC2 now leases its address.`,
    '- A host learns the flags from the next advertisement it hears. R1 sends one every 200 seconds, and one at once to a host that asks for it, as a host does when its link comes up: restart the adapter of each PC (`adapter GigabitEthernet0 down`, then `adapter GigabitEthernet0 up`).',
    '- Run `ipv6config` on each PC and compare where the addresses came from. PC2 keeps its SLAAC address beside the lease: R1 still advertises the prefix for autoconfiguration, and the managed flag adds DHCPv6 on top of it. On R1, `show ipv6 dhcp binding` lists the lease.',
    '- Ping PC1 from PC2 over IPv6 (`ping -6`).',
    '',
    '*Neither flag set means SLAAC only; the other-configuration flag adds stateless DHCPv6; the managed flag sends hosts to DHCPv6 for their address as well.*',
  ].join('\n'),
  build: () =>
    topology(
      219,
      [
        device('pc1', PC, 'PC1', 100, 280, autoconfigHost('PC1')),
        device('r1', ROUTER, 'R1', 400, 180, routerConfig()),
        device('pc2', PC, 'PC2', 700, 280, autoconfigHost('PC2')),
      ],
      [link('l_pc1_r1', 'pc1', 'GigabitEthernet0', 'r1', 'GigabitEthernet0/0'), link('l_r1_pc2', 'r1', 'GigabitEthernet0/1', 'pc2', 'GigabitEthernet0')],
      ['Serve the office LAN stateless DHCPv6', 'Lease the lab LAN its addresses with stateful DHCPv6', 'Set the advertisement flag of each LAN'],
      'The router advertisement tells a host how to configure itself: build its own address, ask DHCPv6 for the options, or ask DHCPv6 for everything.',
      { profile: 'P2' },
    ),
  tasks: [
    {
      id: 'stateless-pool',
      title: 'Build the options-only pool',
      description: `Pool ${DHCPV6_STATELESS_POOL} hands out the name server ${DHCPV6_DNS_SERVER} and the domain ${DHCPV6_DOMAIN}, and no addresses.`,
      points: 15,
      hint: 'A stateless pool has name server and domain lines, and no address prefix line.',
      assertions: [
        { kind: 'config', device: 'R1', path: `ipv6.dhcp.pool.${DHCPV6_STATELESS_POOL}.dns-server`, equals: DHCPV6_DNS_SERVER },
        { kind: 'config', device: 'R1', path: `ipv6.dhcp.pool.${DHCPV6_STATELESS_POOL}.domain-name`, equals: DHCPV6_DOMAIN },
        { kind: 'config', device: 'R1', path: `ipv6.dhcp.pool.${DHCPV6_STATELESS_POOL}.address`, exists: false },
      ],
    },
    {
      id: 'stateless-office',
      title: 'Stateless DHCPv6 on the office LAN',
      description: 'GigabitEthernet0/0 advertises the other-configuration flag; PC1 keeps its SLAAC address and learns the name server from a stateless exchange.',
      points: 25,
      dependsOn: ['stateless-pool'],
      hint: 'The pool is served on the interface, and the flag is an ipv6 nd line on the same interface.',
      assertions: [
        { kind: 'config', device: 'R1', path: 'interface.GigabitEthernet0/0.ipv6.nd.other-config-flag', exists: true },
        { kind: 'process', device: 'PC1', process: 'dhcpv6-client', path: 'clients.iface=GigabitEthernet0.mode', equals: 'stateless' },
        { kind: 'process', device: 'PC1', process: 'dhcpv6-client', path: 'clients.iface=GigabitEthernet0.state', equals: 'bound' },
        { kind: 'process', device: 'PC1', process: 'dns-client', path: 'servers.0', equals: DHCPV6_DNS_SERVER },
        { kind: 'process', device: 'PC1', process: 'ipv6', path: 'interfaces.port=GigabitEthernet0.addresses.origin=slaac.state', equals: 'preferred' },
      ],
      feedbackOnFail: 'With the managed flag set, or with no pool served on the interface, the office host never runs a stateless exchange.',
    },
    {
      id: 'stateful-pool',
      title: 'Build the leasing pool',
      description: `Pool ${DHCPV6_STATEFUL_POOL} leases addresses from ${DHCPV6_LAB_PREFIX} and hands out the name server ${DHCPV6_DNS_SERVER}.`,
      points: 15,
      hint: 'The address prefix line is what makes a pool lease addresses.',
      assertions: [
        { kind: 'config', device: 'R1', path: `ipv6.dhcp.pool.${DHCPV6_STATEFUL_POOL}.address`, contains: DHCPV6_LAB_PREFIX },
        { kind: 'config', device: 'R1', path: `ipv6.dhcp.pool.${DHCPV6_STATEFUL_POOL}.dns-server`, equals: DHCPV6_DNS_SERVER },
      ],
    },
    {
      id: 'stateful-lab',
      title: 'Stateful DHCPv6 on the lab LAN',
      description: `GigabitEthernet0/1 advertises the managed-configuration flag; PC2 leases ${DHCPV6_LEASED_ADDRESS} and R1 records the binding.`,
      points: 30,
      dependsOn: ['stateful-pool'],
      hint: 'The managed flag is the one that sends hosts to DHCPv6 for their address.',
      assertions: [
        { kind: 'config', device: 'R1', path: 'interface.GigabitEthernet0/1.ipv6.nd.managed-config-flag', exists: true },
        { kind: 'process', device: 'PC2', process: 'dhcpv6-client', path: 'clients.iface=GigabitEthernet0.mode', equals: 'stateful' },
        { kind: 'process', device: 'PC2', process: 'dhcpv6-client', path: 'clients.iface=GigabitEthernet0.state', equals: 'bound' },
        { kind: 'port', device: 'PC2', port: 'GigabitEthernet0', field: 'ipv6', equals: DHCPV6_LEASED_ADDRESS },
        { kind: 'table', device: 'R1', table: 'dhcpv6-bindings', where: { pool: DHCPV6_STATEFUL_POOL, address: DHCPV6_LEASED_ADDRESS }, exists: true },
      ],
      feedbackOnFail: 'The other-configuration flag alone gives a host its options but never an address; a lease needs the managed flag and a pool with an address prefix.',
    },
    {
      id: 'cold-start',
      title: 'Both LANs work from a cold start',
      description: 'Started again from its saved configuration, the network leases PC2 its address again, answers PC1 again, and PC2 reaches PC1 over IPv6.',
      points: 15,
      dependsOn: ['stateless-office', 'stateful-lab'],
      assertions: [
        {
          kind: 'connectivity',
          from: 'PC2',
          to: 'PC1',
          family: 6,
          expect: 'success',
          then: [
            { kind: 'table', device: 'R1', table: 'dhcpv6-bindings', where: { pool: DHCPV6_STATEFUL_POOL, address: DHCPV6_LEASED_ADDRESS }, exists: true },
            { kind: 'process', device: 'PC1', process: 'dhcpv6-client', path: 'clients.iface=GigabitEthernet0.state', equals: 'bound' },
          ],
        },
      ],
    },
  ],
  solution: {
    R1: [
      `ipv6 dhcp pool ${DHCPV6_STATELESS_POOL}`,
      `dns-server ${DHCPV6_DNS_SERVER}`,
      `domain-name ${DHCPV6_DOMAIN}`,
      'exit',
      `ipv6 dhcp pool ${DHCPV6_STATEFUL_POOL}`,
      `address prefix ${DHCPV6_LAB_PREFIX}`,
      `dns-server ${DHCPV6_DNS_SERVER}`,
      `domain-name ${DHCPV6_DOMAIN}`,
      'exit',
      'interface GigabitEthernet0/0',
      `ipv6 dhcp server ${DHCPV6_STATELESS_POOL}`,
      'ipv6 nd other-config-flag',
      'exit',
      'interface GigabitEthernet0/1',
      `ipv6 dhcp server ${DHCPV6_STATEFUL_POOL}`,
      'ipv6 nd managed-config-flag',
      'exit',
    ],
    // each host asks for a fresh advertisement (a router solicitation at link-up) instead of waiting up to 200 s
    PC1: ['adapter GigabitEthernet0 down', 'adapter GigabitEthernet0 up'],
    PC2: ['adapter GigabitEthernet0 down', 'adapter GigabitEthernet0 up'],
  },
};

/** The DHCPv6 labs, in course order. */
export const CCNA2_DHCPV6_LABS: readonly ScenarioInfo[] = [ccna2Dhcpv6];
