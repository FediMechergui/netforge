/**
 * curriculum/ccna1/lessons.ts — the CCNA 1 arc as 31 lessons in 7 modules, in teaching order.
 *
 * This file is the skeleton only: id, title, outcome, topic, minutes and, where one of the built-in labs practises
 * exactly this lesson, the `name` of that lab. `theory` is left empty and no lesson carries a video here — both
 * arrive from `ccna1/theory.ts` and `ccna1/videos.ts` and are merged in `curriculum/index.ts`, so three people can
 * work on structure, prose and videos without ever editing the same file.
 *
 * The order is the order the ideas depend on each other: you meet a network, then the local segment, then
 * addresses, then how to leave the subnet, then the services that make it usable, then IPv6 and wireless, then
 * fault finding — a lesson is never placed before something it needs. A lab is attached only when its tasks are
 * exactly this lesson's practice; lessons with nothing matching simply have no lab (all fifteen labs land, and
 * `test/curriculum.test.ts` fails if one stops being reachable).
 *
 * ponytail: lesson minutes cover the reading and the video alone. The lab's own `estimatedMinutes` is already in
 * the scenario catalogue, so the UI adds the two instead of this file restating a number that could drift.
 */
import type { CourseModule } from '../../contracts/curriculum.js';

/** Topics reuse `ScenarioMeta.topic` strings so a lesson and its lab file under one heading. */
export const CCNA1_MODULES: readonly CourseModule[] = [
  {
    id: 'ccna1-m1-how-networks-work',
    title: 'How networks work',
    summary: 'What a network actually is, what carries the signals, and how you talk to a device.',
    lessons: [
      {
        id: 'ccna1-01-what-is-a-network',
        title: 'What a network is',
        outcome: 'Describe a network as machines that agree on how to reach each other, and name the parts of a small one.',
        theory: '',
        estimatedMinutes: 10,
        topic: 'Network basics',
      },
      {
        id: 'ccna1-02-hosts-and-media',
        title: 'Hosts, the boxes between them, and the media',
        outcome: 'Tell a host from an intermediary device and say which medium suits a given link.',
        theory: '',
        estimatedMinutes: 12,
        topic: 'Network basics',
      },
      {
        id: 'ccna1-03-the-layered-model',
        title: 'Layers, headers and payloads',
        outcome: 'Follow one message down the layers and back up, and say which header each layer adds.',
        theory: '',
        estimatedMinutes: 14,
        topic: 'Network basics',
      },
      {
        id: 'ccna1-04-the-device-command-line',
        title: 'Talking to a device',
        outcome: 'Move between the command modes of a switch or router, name a device and read its running settings.',
        theory: '',
        estimatedMinutes: 12,
        topic: 'Device access',
      },
    ],
  },
  {
    id: 'ccna1-m2-the-local-network',
    title: 'The local network',
    summary: 'Frames, hardware addresses, and what a switch learns from the traffic it carries.',
    lessons: [
      {
        id: 'ccna1-05-ethernet-frames-and-mac-addresses',
        title: 'Frames and hardware addresses',
        outcome: 'Read a frame header and explain what a hardware address identifies and where it stops being useful.',
        theory: '',
        estimatedMinutes: 12,
        topic: 'Ethernet LANs',
      },
      {
        id: 'ccna1-06-switches-and-the-mac-table',
        title: 'How a switch learns',
        outcome: 'Predict whether a switch floods or forwards a frame by reading its address table.',
        theory: '',
        estimatedMinutes: 14,
        topic: 'Ethernet LANs',
      },
      {
        id: 'ccna1-07-speed-duplex-and-autonegotiation',
        title: 'Speed, duplex and negotiation',
        outcome: 'Explain what two ends negotiate on a link and what breaks when one end is pinned and the other is not.',
        theory: '',
        estimatedMinutes: 10,
        topic: 'Ethernet LANs',
      },
    ],
  },
  {
    id: 'ccna1-m3-ipv4-addresses',
    title: 'Addresses that cross networks',
    summary: 'The address, the mask, the first working LAN, and the two protocols that prove it works.',
    lessons: [
      {
        id: 'ccna1-08-what-an-ipv4-address-is',
        title: 'What an IPv4 address is',
        outcome: 'Split an address into its network part and its host part and say what each one is for.',
        theory: '',
        estimatedMinutes: 12,
        topic: 'IPv4 addressing',
      },
      {
        id: 'ccna1-09-binary-masks-and-subnet-boundaries',
        title: 'Binary, masks and the edges of a subnet',
        outcome: 'Work out the network address, the usable range and the broadcast address from an address and a mask.',
        theory: '',
        estimatedMinutes: 18,
        topic: 'IPv4 addressing',
      },
      {
        id: 'ccna1-10-build-a-small-lan',
        title: 'Build a small LAN',
        outcome: 'Address two hosts in one subnet, name the switch and prove the segment carries traffic.',
        theory: '',
        lab: 'ccna1-switched-lan',
        estimatedMinutes: 8,
        topic: 'Ethernet LANs',
      },
      {
        id: 'ccna1-11-arp',
        title: 'Finding the hardware address behind an address',
        outcome: 'Describe the request and reply that let a host fill in the frame header for a neighbour.',
        theory: '',
        estimatedMinutes: 12,
        topic: 'Ethernet LANs',
      },
      {
        id: 'ccna1-12-ping-and-icmp',
        title: 'Ping and the messages behind it',
        outcome: 'Use a ping and read what its answer, or its silence, tells you about the path.',
        theory: '',
        estimatedMinutes: 12,
        topic: 'Troubleshooting',
      },
    ],
  },
  {
    id: 'ccna1-m4-leaving-the-subnet',
    title: 'Leaving the subnet',
    summary: 'Gateways, splitting a block into subnets, routers, static routes and locking a device down.',
    lessons: [
      {
        id: 'ccna1-13-the-default-gateway',
        title: 'The default gateway',
        outcome: 'Say when a host delivers a packet itself and when it hands it to its gateway, and configure one.',
        theory: '',
        lab: 'ccna1-default-gateway',
        estimatedMinutes: 12,
        topic: 'IPv4 addressing',
      },
      {
        id: 'ccna1-14-splitting-a-network-into-subnets',
        title: 'Splitting a network into subnets',
        outcome: 'Divide one address block into equal subnets and list the range each subnet owns.',
        theory: '',
        estimatedMinutes: 20,
        topic: 'Subnetting',
      },
      {
        id: 'ccna1-15-a-subnet-plan-in-practice',
        title: 'A subnet plan in practice',
        outcome: 'Turn a written subnet plan into addresses on real interfaces and hosts.',
        theory: '',
        lab: 'ccna1-subnetting-plan',
        estimatedMinutes: 10,
        topic: 'Subnetting',
      },
      {
        id: 'ccna1-16-what-a-router-does',
        title: 'What a router does',
        outcome: 'Read a routing table, recognise the routes an addressed interface creates and route between two subnets.',
        theory: '',
        lab: 'ccna1-two-subnets',
        estimatedMinutes: 14,
        topic: 'Routing',
      },
      {
        id: 'ccna1-17-static-routes',
        title: 'Static routes',
        outcome: 'Write the routes a chain of routers needs so traffic reaches a network none of them touches directly.',
        theory: '',
        lab: 'ccna1-static-routes',
        estimatedMinutes: 16,
        topic: 'Routing',
      },
      {
        id: 'ccna1-18-device-access-and-passwords',
        title: 'Device access and passwords',
        outcome: 'Protect privileged mode and the console, post a login notice and give a switch a reachable management address.',
        theory: '',
        lab: 'ccna1-device-hardening',
        estimatedMinutes: 14,
        topic: 'Device access',
      },
    ],
  },
  {
    id: 'ccna1-m5-services',
    title: 'The services that make it usable',
    summary: 'Addresses on request, names instead of numbers, the two transports and the web.',
    lessons: [
      {
        id: 'ccna1-19-dhcp',
        title: 'Addresses on request',
        outcome: 'Explain the four messages of an address lease and set up a pool that hands out addresses.',
        theory: '',
        lab: 'ccna1-dhcpv4-server',
        estimatedMinutes: 14,
        topic: 'Address services',
      },
      {
        id: 'ccna1-20-dhcp-across-a-router',
        title: 'Leases across a router',
        outcome: 'Say why a broadcast request stops at a router and forward it to a central server instead.',
        theory: '',
        lab: 'ccna1-dhcp-relay',
        estimatedMinutes: 12,
        topic: 'Address services',
      },
      {
        id: 'ccna1-21-dns',
        title: 'Names instead of numbers',
        outcome: 'Follow a name lookup from the client to the answer and publish records for your own servers.',
        theory: '',
        lab: 'ccna1-dns-records',
        estimatedMinutes: 14,
        topic: 'Application layer',
      },
      {
        id: 'ccna1-22-tcp-and-udp',
        title: 'Two ways to carry data',
        outcome: 'Choose between the connection-based transport and the lightweight one, and read a port number.',
        theory: '',
        estimatedMinutes: 16,
        topic: 'Transport layer',
      },
      {
        id: 'ccna1-23-http-and-the-web',
        title: 'The web on top of it all',
        outcome: 'Trace a page request from the browser to the server and publish a page of your own.',
        theory: '',
        lab: 'ccna1-web-server',
        estimatedMinutes: 12,
        topic: 'Application layer',
      },
    ],
  },
  {
    id: 'ccna1-m6-ipv6-and-wireless',
    title: 'IPv6 and wireless',
    summary: 'The larger address space, how hosts build their own address, and networks with no cable.',
    lessons: [
      {
        id: 'ccna1-24-why-ipv6',
        title: 'Why IPv6, and how it is written',
        outcome: 'Shorten and expand an IPv6 address and name the parts of a unicast one.',
        theory: '',
        estimatedMinutes: 16,
        topic: 'IPv6',
      },
      {
        id: 'ccna1-25-ipv6-without-a-server',
        title: 'Addresses a host builds itself',
        outcome: 'Advertise a prefix on a router and explain how each host turns it into a full address and a default route.',
        theory: '',
        lab: 'ccna1-ipv6-slaac',
        estimatedMinutes: 16,
        topic: 'IPv6',
      },
      {
        id: 'ccna1-26-how-wireless-works',
        title: 'How wireless works',
        outcome: 'Describe how a client finds and joins a wireless network, and what a channel and a passphrase do.',
        theory: '',
        estimatedMinutes: 14,
        topic: 'Wireless',
      },
      {
        id: 'ccna1-27-set-up-a-wireless-network',
        title: 'Set up a wireless network',
        outcome: 'Create a protected wireless network, hand out addresses on it and join it from a laptop.',
        theory: '',
        lab: 'ccna1-home-wifi',
        estimatedMinutes: 12,
        topic: 'Wireless',
      },
    ],
  },
  {
    id: 'ccna1-m7-finding-faults',
    title: 'Finding faults',
    summary: 'See the path, work through a method, and repair three networks that boot broken.',
    lessons: [
      {
        id: 'ccna1-28-traceroute',
        title: 'Seeing the path hop by hop',
        outcome: 'Read a hop-by-hop trace and tell where a path stops or turns back on itself.',
        theory: '',
        lab: 'ccna1-traceroute-path',
        estimatedMinutes: 14,
        topic: 'Troubleshooting',
      },
      {
        id: 'ccna1-29-a-method-for-troubleshooting',
        title: 'A method that finds the fault',
        outcome: 'Work a fault from the bottom layer up, testing one thing at a time instead of guessing.',
        theory: '',
        estimatedMinutes: 12,
        topic: 'Troubleshooting',
      },
      {
        id: 'ccna1-30-addressing-faults',
        title: 'A wrong mask and a wrong gateway',
        outcome: 'Spot addresses that look right but put hosts in different subnets, and repair them.',
        theory: '',
        lab: 'ccna1-troubleshoot-addressing',
        estimatedMinutes: 12,
        topic: 'Troubleshooting',
      },
      {
        id: 'ccna1-31-link-faults',
        title: 'A dead port and a bad link',
        outcome: 'Find a disabled port and a link whose two ends disagree, and bring both back to health.',
        theory: '',
        lab: 'ccna1-troubleshoot-ports',
        estimatedMinutes: 12,
        topic: 'Troubleshooting',
      },
    ],
  },
];
