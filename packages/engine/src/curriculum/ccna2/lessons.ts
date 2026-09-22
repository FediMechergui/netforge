/**
 * curriculum/ccna2/lessons.ts — the CCNA 2 arc as 34 lessons in 11 modules, in teaching order (ARCHITECTURE-P2 §11).
 *
 * Skeleton only, exactly like `ccna1/lessons.ts`: id, title, outcome, topic, minutes and, where one of the CCNA 2
 * labs practises exactly this lesson, the `name` of that lab. `theory` is empty and no lesson carries a video: the
 * bodies arrive in W6/W7 (`ccna2/theory-*.ts`, `ccna2/videos.ts`) and are joined in `curriculum/index.ts`.
 *
 * DETACHED until W7 (§7 W1 course, §11.3): `curriculum/index.ts` does not import this file, so the CCNA 2 course keeps
 * status `planned` with no modules and the planned-course pins of `curriculum.test.ts` stay green. The W7 course item
 * attaches it. `test/curriculum.ccna2.test.ts` imports the skeleton directly.
 *
 * Content decisions (§8.5, §11.1):
 * - A lab is attached only when its lab exists in the approved scope: the 19 MUST labs plus `ccna2-hsrp-gateway`
 *   (S2). Lesson 08 (voice VLANs, S4) has no lab of its own in §11.1; lessons 26 (S12) and 28 (S11) run theory-only
 *   because those items are not built. Lesson 18 is practised in lesson 10's lab and lesson 24 inside the
 *   port-security lab, so neither names a lab (a lab is attached to exactly one lesson).
 * - `topic` is the module title (§11.2: a CCNA 2 lab's `topic` is its module title), so a lesson and its lab file
 *   under the same heading.
 * - Lesson minutes cover reading and watching only; a lab adds its own `estimatedMinutes`. None exceeds 45 (§11.1).
 *
 * All wording is original and names no vendor (§0 rule 6); protocol names that are CCNA vocabulary (VTP, HSRP, CAPWAP,
 * LACP) appear as names only.
 */
import type { CourseModule } from '../../contracts/curriculum.js';

/** The CCNA 2 modules in teaching order. */
export const CCNA2_MODULES: readonly CourseModule[] = [
  {
    id: 'ccna2-m1-switches-revisited',
    title: 'Switches, revisited',
    summary: 'How a switch really forwards, how you reach it for management, and what its ports agree on.',
    lessons: [
      {
        id: 'ccna2-01-how-a-switch-forwards',
        title: 'How a switch forwards',
        outcome: 'Explain how a switch learns, floods, filters and ages out addresses, keeping a separate address table for each VLAN.',
        theory: '',
        estimatedMinutes: 12,
        topic: 'Switches, revisited',
      },
      {
        id: 'ccna2-02-managing-a-switch',
        title: 'Managing a switch',
        outcome: 'Reach a switch through a management VLAN interface and give it a default gateway so it can be managed from another subnet.',
        theory: '',
        lab: 'ccna2-switch-management',
        estimatedMinutes: 12,
        topic: 'Switches, revisited',
      },
      {
        id: 'ccna2-03-speed-duplex-and-cabling',
        title: 'Speed, duplex and cabling',
        outcome: 'Set speed and duplex on a switch port, recognise the symptoms of a duplex mismatch and say when automatic crossover saves you a cable.',
        theory: '',
        estimatedMinutes: 10,
        topic: 'Switches, revisited',
      },
    ],
  },
  {
    id: 'ccna2-m2-vlans',
    title: 'VLANs',
    summary: 'Splitting one switched network into several, carrying them between switches, and negotiating the links that do.',
    lessons: [
      {
        id: 'ccna2-04-why-split-a-lan',
        title: 'Why split a LAN',
        outcome: 'Say what a VLAN separates (broadcasts, address tables, the reach of a fault) and what it leaves shared.',
        theory: '',
        estimatedMinutes: 10,
        topic: 'VLANs',
      },
      {
        id: 'ccna2-05-access-ports-and-the-vlan-list',
        title: 'Access ports and the VLAN list',
        outcome: 'Create and name VLANs, put access ports in them, and explain what the VTP modes do and why a higher revision number can wipe a VLAN list.',
        theory: '',
        lab: 'ccna2-vlan-access-ports',
        estimatedMinutes: 16,
        topic: 'VLANs',
      },
      {
        id: 'ccna2-06-trunks-and-tags',
        title: 'Trunks and tags',
        outcome: 'Build an 802.1Q trunk, choose its native VLAN and allowed list, and find the tag a switch added in the provenance view.',
        theory: '',
        lab: 'ccna2-trunk-native-allowed',
        estimatedMinutes: 16,
        topic: 'VLANs',
      },
      {
        id: 'ccna2-07-trunk-negotiation',
        title: 'Trunk negotiation',
        outcome: 'Predict what any two negotiation modes produce on a link, and switch negotiation off where it is not wanted.',
        theory: '',
        lab: 'ccna2-dtp-modes',
        estimatedMinutes: 12,
        topic: 'VLANs',
      },
      {
        id: 'ccna2-08-voice-vlans',
        title: 'Voice VLANs',
        outcome: 'Carry the traffic of a phone in its own VLAN on the same switch port as the computer plugged in behind it.',
        theory: '',
        estimatedMinutes: 10,
        topic: 'VLANs',
      },
    ],
  },
  {
    id: 'ccna2-m3-routing-between-vlans',
    title: 'Routing between VLANs',
    summary: 'Three ways to let VLANs talk to each other, and how to find out why they do not.',
    lessons: [
      {
        id: 'ccna2-09-router-on-a-stick',
        title: 'One router port per VLAN, then one for all',
        outcome: 'Route between VLANs first with one router port per VLAN, then with subinterfaces sharing a single trunk.',
        theory: '',
        lab: 'ccna2-router-on-a-stick',
        estimatedMinutes: 18,
        topic: 'Routing between VLANs',
      },
      {
        id: 'ccna2-10-multilayer-switching',
        title: 'Multilayer switching',
        outcome: 'Route between VLANs on a multilayer switch with VLAN interfaces and routing turned on, uplink it through a routed port, and relay address requests from every VLAN.',
        theory: '',
        lab: 'ccna2-l3-switch-svis',
        estimatedMinutes: 18,
        topic: 'Routing between VLANs',
      },
      {
        id: 'ccna2-11-fixing-inter-vlan-routing',
        title: 'Fixing inter-VLAN routing',
        outcome: 'Find a port in the wrong VLAN, a VLAN missing from a trunk or a subinterface that is down, and fix each one.',
        theory: '',
        lab: 'ccna2-troubleshoot-vlans',
        estimatedMinutes: 14,
        topic: 'Routing between VLANs',
      },
    ],
  },
  {
    id: 'ccna2-m4-spanning-tree',
    title: 'Spanning tree',
    summary: 'Why redundant links loop, how switches elect a root and block the extra paths, and how to speed it up and protect it.',
    lessons: [
      {
        id: 'ccna2-12-what-a-loop-does',
        title: 'What a loop does',
        outcome: 'Explain how a switching loop turns one broadcast into a storm, and watch spanning tree prevent it.',
        theory: '',
        estimatedMinutes: 12,
        topic: 'Spanning tree',
      },
      {
        id: 'ccna2-13-electing-a-root',
        title: 'Electing a root',
        outcome: 'Predict which switch becomes the root for each VLAN, and move the root to the switch you choose.',
        theory: '',
        lab: 'ccna2-stp-root-placement',
        estimatedMinutes: 16,
        topic: 'Spanning tree',
      },
      {
        id: 'ccna2-14-port-roles-states-and-timers',
        title: 'Port roles, states and timers',
        outcome: 'Name the role and state of every port in a looped topology and explain why a port waits 30 seconds before it forwards.',
        theory: '',
        estimatedMinutes: 16,
        topic: 'Spanning tree',
      },
      {
        id: 'ccna2-15-rapid-spanning-tree',
        title: 'Rapid spanning tree',
        outcome: 'Compare classic and rapid convergence, switch a network to rapid mode, watch a rapid switch fall back beside an older one, and say what multiple instances add.',
        theory: '',
        lab: 'ccna2-rapid-stp',
        estimatedMinutes: 18,
        topic: 'Spanning tree',
      },
      {
        id: 'ccna2-16-edge-ports-and-guards',
        title: 'Edge ports and guards',
        outcome: 'Protect the tree with edge ports, BPDU guard and root guard, and bring back a port a guard has shut down.',
        theory: '',
        lab: 'ccna2-stp-guards',
        estimatedMinutes: 14,
        topic: 'Spanning tree',
      },
    ],
  },
  {
    id: 'ccna2-m5-etherchannel',
    title: 'EtherChannel',
    summary: 'Turning parallel links into one logical link that spanning tree does not block.',
    lessons: [
      {
        id: 'ccna2-17-bundling-links',
        title: 'Bundling links',
        outcome: 'Bundle two links with LACP, see how traffic is spread over them, and tell bundled, individual and suspended members apart to spot a misconfigured bundle.',
        theory: '',
        lab: 'ccna2-etherchannel-lacp',
        estimatedMinutes: 18,
        topic: 'EtherChannel',
      },
    ],
  },
  {
    id: 'ccna2-m6-addressing-services',
    title: 'Addressing services',
    summary: 'Handing out addresses across VLANs, and the two ways IPv6 hosts get theirs.',
    lessons: [
      {
        id: 'ccna2-18-dhcp-across-vlans',
        title: 'DHCP across VLANs',
        outcome: 'Explain why every VLAN interface needs a relay to reach a central DHCP server, and what the relay changes in the request.',
        theory: '',
        estimatedMinutes: 10,
        topic: 'Addressing services',
      },
      {
        id: 'ccna2-19-slaac-and-dhcpv6',
        title: 'SLAAC and DHCPv6',
        outcome: 'Configure stateless and stateful DHCPv6 and set the router advertisement flags that tell hosts which one to use.',
        theory: '',
        lab: 'ccna2-dhcpv6',
        estimatedMinutes: 18,
        topic: 'Addressing services',
      },
    ],
  },
  {
    id: 'ccna2-m7-gateway-redundancy',
    title: 'Gateway redundancy',
    summary: 'Keeping a subnet connected when its default gateway fails.',
    lessons: [
      {
        id: 'ccna2-20-one-gateway-one-point-of-failure',
        title: 'One gateway, one point of failure',
        outcome: 'Explain what a first-hop redundancy protocol adds to a subnet that has two routers.',
        theory: '',
        estimatedMinutes: 10,
        topic: 'Gateway redundancy',
      },
      {
        id: 'ccna2-21-hot-standby-gateways',
        title: 'Hot-standby gateways',
        outcome: 'Configure a standby group with a shared virtual address and watch the standby router take over when the active one fails.',
        theory: '',
        lab: 'ccna2-hsrp-gateway',
        estimatedMinutes: 16,
        topic: 'Gateway redundancy',
      },
    ],
  },
  {
    id: 'ccna2-m8-access-layer-security',
    title: 'Access-layer security',
    summary: 'The attacks that start at a switch port, and the settings that stop them.',
    lessons: [
      {
        id: 'ccna2-22-threats-at-layer-2',
        title: 'Threats at layer 2',
        outcome: 'Name the layer 2 attacks that port security and the spanning-tree guards stop, and say how each one works.',
        theory: '',
        estimatedMinutes: 12,
        topic: 'Access-layer security',
      },
      {
        id: 'ccna2-23-port-security',
        title: 'Port security',
        outcome: 'Limit and pin the addresses allowed on a port, choose what a violation does, and bring an error-disabled port back.',
        theory: '',
        lab: 'ccna2-port-security',
        estimatedMinutes: 16,
        topic: 'Access-layer security',
      },
      {
        id: 'ccna2-24-hardening-switch-ports',
        title: 'Hardening switch ports',
        outcome: 'Shut unused ports, move the native VLAN away from VLAN 1 and switch trunk negotiation off.',
        theory: '',
        estimatedMinutes: 10,
        topic: 'Access-layer security',
      },
    ],
  },
  {
    id: 'ccna2-m9-wireless-at-scale',
    title: 'Wireless at scale',
    summary: 'Many access points run from one controller, the channels they share, and how a WLAN is secured.',
    lessons: [
      {
        id: 'ccna2-25-controllers-and-lightweight-aps',
        title: 'Controllers and lightweight access points',
        outcome: 'Describe how a lightweight access point joins a controller over CAPWAP, what split MAC and central switching mean, and which parts NetForge simplifies.',
        theory: '',
        estimatedMinutes: 14,
        topic: 'Wireless at scale',
      },
      {
        id: 'ccna2-26-channels-and-overlap',
        title: 'Channels and overlap',
        outcome: 'Plan channels that do not overlap in the 2.4, 5 and 6 GHz bands.',
        theory: '',
        estimatedMinutes: 12,
        topic: 'Wireless at scale',
      },
      {
        id: 'ccna2-27-wlans-on-a-controller',
        title: 'WLANs on a controller',
        outcome: 'Create a controller interface and a WLAN on it, then connect a client through a lightweight access point.',
        theory: '',
        lab: 'ccna2-wlc-wlan',
        estimatedMinutes: 18,
        topic: 'Wireless at scale',
      },
      {
        id: 'ccna2-28-securing-a-wlan',
        title: 'Securing a WLAN',
        outcome: 'Choose between personal and enterprise security for a WLAN and explain what each one checks before a client may send.',
        theory: '',
        estimatedMinutes: 12,
        topic: 'Wireless at scale',
      },
    ],
  },
  {
    id: 'ccna2-m10-static-routing',
    title: 'Static routing',
    summary: 'How a router picks a route, every way to write a static one, and a backup that takes over by itself.',
    lessons: [
      {
        id: 'ccna2-29-how-a-router-chooses',
        title: 'How a router chooses',
        outcome: 'Apply longest match, administrative distance and recursive lookup, and explain how equal-cost paths share the load.',
        theory: '',
        estimatedMinutes: 16,
        topic: 'Static routing',
      },
      {
        id: 'ccna2-30-static-route-forms',
        title: 'Static route forms',
        outcome: 'Write next-hop, exit-interface, fully specified and host static routes, and say when each form fits.',
        theory: '',
        lab: 'ccna2-static-routes',
        estimatedMinutes: 16,
        topic: 'Static routing',
      },
      {
        id: 'ccna2-31-default-and-floating-routes',
        title: 'Default and floating routes',
        outcome: 'Add a default route and a backup route that takes over when the main link fails.',
        theory: '',
        lab: 'ccna2-floating-static',
        estimatedMinutes: 14,
        topic: 'Static routing',
      },
      {
        id: 'ccna2-32-ipv6-static-routes',
        title: 'IPv6 static routes',
        outcome: 'Route IPv6 with global and link-local next hops on a dual-stack network.',
        theory: '',
        lab: 'ccna2-ipv6-static',
        estimatedMinutes: 14,
        topic: 'Static routing',
      },
    ],
  },
  {
    id: 'ccna2-m11-translation-and-fault-finding',
    title: 'Translation and fault finding',
    summary: 'Sharing public addresses through translation, and a method for finding what is broken.',
    lessons: [
      {
        id: 'ccna2-33-address-translation',
        title: 'Address translation',
        outcome: 'Configure static NAT, a dynamic pool and PAT, read inside, outside, local and global addresses, and forward a port to an inside server.',
        theory: '',
        lab: 'ccna2-nat-pat',
        estimatedMinutes: 20,
        topic: 'Translation and fault finding',
      },
      {
        id: 'ccna2-34-finding-faults',
        title: 'Finding faults',
        outcome: 'Troubleshoot a switched and routed network one layer at a time instead of guessing.',
        theory: '',
        lab: 'ccna2-troubleshoot-routing',
        estimatedMinutes: 16,
        topic: 'Translation and fault finding',
      },
    ],
  },
];
