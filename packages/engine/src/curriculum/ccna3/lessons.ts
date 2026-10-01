/**
 * curriculum/ccna3/lessons.ts — the CCNA 3 arc as 40 lessons in 14 modules, in teaching order (ARCHITECTURE-P3 §11.1).
 *
 * Skeleton only, exactly like `ccna1/lessons.ts` and `ccna2/lessons.ts`: id, title, outcome, topic, minutes and, where
 * a lab of the approved plan practises this lesson, the `name` of that lab. `theory` is empty and no lesson carries a
 * video: the bodies (`ccna3/theory-a` … `theory-d`, W6 for modules 1–13 and W7 for module 14) and the videos
 * (`ccna3/videos.ts`) are joined onto it in `curriculum/index.ts`.
 *
 * DETACHED until the W7 course flip (§7 W1 course, §11.3): `curriculum/index.ts` does not import this file, so CCNA 3
 * stays `planned` with no modules and the planned-course pins stay green. `test/curriculum.ccna3.test.ts` imports the
 * skeleton directly. Lab-name existence is checked against `SCENARIOS` from W5 (W6 for the automation labs).
 *
 * Content decisions (§8.4, §8.5, §11.1):
 * - The lesson ids are the ones §11.1 froze at W0 (overlay owners key on them): `ccna3-NN-slug`.
 * - A lab is attached only when it belongs to the approved plan: the 16 MUST labs (lessons 03, 04, 05, 06, 07, 15, 16,
 *   17, 19, 20, 22, 27, 28, 29, 34, 38), [S18] lesson 24, [S32] lesson 40, [C1] lessons 10 and 33, [C13] lesson 25 —
 *   21 labs, each reachable from exactly one lesson. The lessons of items that are not approved (08 [S4], 09 [S6],
 *   30 [S33]/[S34], 31 [S29], 39 [C22]) run theory-only and name no lab; their hands-on part is recorded `later:P3c` in
 *   `ccna3/objectives.ts`. Lesson 18 is practised in lesson 34's lab, and lessons 14, 26 and 37 have a concept tool,
 *   not a lab, so none of them names one.
 * - `topic` is the module title (§11.2: a CCNA 3 lab's `topic` is its module title), so a lesson and its lab file
 *   under the same heading.
 * - Lesson minutes cover reading and watching only (about 610 in all); a lab adds its own `estimatedMinutes`. None
 *   exceeds 45 (§11.1). The outcomes of the theory-only lessons promise what the lesson can deliver without a lab.
 *
 * All wording is original and names no vendor, controller product or certification programme (§0 rule 6, §11.3);
 * protocol names that are course vocabulary (OSPF, EIGRP, CDP, GRE, RESTCONF) appear as names only.
 */
import type { CourseModule } from '../../contracts/curriculum.js';

/** The CCNA 3 modules in teaching order. */
export const CCNA3_MODULES: readonly CourseModule[] = [
  {
    id: 'ccna3-m1-routers-that-learn',
    title: 'Routers that learn',
    summary: 'Why routers exchange what they know, and how OSPF turns what its neighbours report into one shared map.',
    lessons: [
      {
        id: 'ccna3-01-why-routers-share-routes',
        title: 'Why routers share routes',
        outcome: 'Say what dynamic routing automates that static routes cannot, and contrast how distance-vector and link-state protocols learn their routes.',
        theory: '',
        estimatedMinutes: 12,
        topic: 'Routers that learn',
      },
      {
        id: 'ccna3-02-how-ospf-maps-a-network',
        title: 'How OSPF maps a network',
        outcome: 'Follow a router from its first hello to a full adjacency, and explain how the advertisements routers flood become one shared map from which each of them computes its shortest paths.',
        theory: '',
        estimatedMinutes: 16,
        topic: 'Routers that learn',
      },
      {
        id: 'ccna3-03-neighbours-and-the-designated-router',
        title: 'Neighbours and the designated router',
        outcome: 'Predict which routers become the designated and backup designated router on a shared segment, steer the election with priority, and tell broadcast behaviour from point-to-point behaviour.',
        theory: '',
        lab: 'ccna3-ospf-dr-election',
        estimatedMinutes: 16,
        topic: 'Routers that learn',
      },
    ],
  },
  {
    id: 'ccna3-m2-one-ospf-area',
    title: 'One OSPF area',
    summary: 'Switching OSPF on, steering its choice of path, sharing a way out, and finding out why it will not work.',
    lessons: [
      {
        id: 'ccna3-04-switching-ospf-on',
        title: 'Switching OSPF on',
        outcome: 'Turn OSPF on with network statements and with interface lines, fix the router ID, and keep hellos off LANs where no other router listens.',
        theory: '',
        lab: 'ccna3-ospf-single-area',
        estimatedMinutes: 18,
        topic: 'One OSPF area',
      },
      {
        id: 'ccna3-05-cost-and-the-best-path',
        title: 'Cost and the best path',
        outcome: 'Work out the cost of an interface from its bandwidth and the reference bandwidth, change it, and predict the path or paths a router installs.',
        theory: '',
        lab: 'ccna3-ospf-cost',
        estimatedMinutes: 14,
        topic: 'One OSPF area',
      },
      {
        id: 'ccna3-06-default-routes-and-timers',
        title: 'Default routes and timers',
        outcome: 'Advertise a default route into OSPF, and explain what happens when two neighbours disagree on their hello or dead timers.',
        theory: '',
        lab: 'ccna3-ospf-default-route',
        estimatedMinutes: 14,
        topic: 'One OSPF area',
      },
      {
        id: 'ccna3-07-fixing-ospf',
        title: 'Fixing OSPF',
        outcome: 'Use the neighbour, interface and database views to find out why two routers will not peer or why a route is missing.',
        theory: '',
        lab: 'ccna3-troubleshoot-ospf',
        estimatedMinutes: 16,
        topic: 'One OSPF area',
      },
    ],
  },
  {
    id: 'ccna3-m3-growing-ospf',
    title: 'Growing OSPF',
    summary: 'What changes when OSPF spans several areas, and when it carries IPv6.',
    lessons: [
      {
        id: 'ccna3-08-more-than-one-area',
        title: 'More than one area',
        outcome: 'Explain why a large OSPF network is split into areas, what an area border router passes between them, and what each type of link-state advertisement carries.',
        theory: '',
        estimatedMinutes: 16,
        topic: 'Growing OSPF',
      },
      {
        id: 'ccna3-09-ospf-for-ipv6',
        title: 'OSPF for IPv6',
        outcome: 'Describe how OSPF for IPv6 runs beside OSPF for IPv4, and compare how the two name their neighbours and links.',
        theory: '',
        estimatedMinutes: 14,
        topic: 'Growing OSPF',
      },
    ],
  },
  {
    id: 'ccna3-m4-eigrp',
    title: 'EIGRP',
    summary: 'A distance-vector protocol with a composite metric and a backup path ready before it is needed.',
    lessons: [
      {
        id: 'ccna3-10-eigrp-and-its-metric',
        title: 'EIGRP and its metric',
        outcome: 'Form EIGRP neighbours, read the composite metric, find the successor and the feasible successor, watch a failover with and without one, and say what stub routing, summarisation and unequal-cost sharing change.',
        theory: '',
        lab: 'ccna3-eigrp-feasible-successor',
        estimatedMinutes: 18,
        topic: 'EIGRP',
      },
    ],
  },
  {
    id: 'ccna3-m5-thinking-like-a-defender',
    title: 'Thinking like a defender',
    summary: 'The vocabulary of security, the ways attacks unfold, and defences stacked in layers.',
    lessons: [
      {
        id: 'ccna3-11-the-language-of-security',
        title: 'The language of security',
        outcome: 'Describe confidentiality, integrity and availability, tell a threat from a vulnerability, an exploit and a risk, and say who attacks networks and why.',
        theory: '',
        estimatedMinutes: 12,
        topic: 'Thinking like a defender',
      },
      {
        id: 'ccna3-12-how-attacks-unfold',
        title: 'How attacks unfold',
        outcome: 'Describe what reconnaissance, access and denial-of-service attacks and the main families of malware do to a network.',
        theory: '',
        estimatedMinutes: 14,
        topic: 'Thinking like a defender',
      },
      {
        id: 'ccna3-13-layers-of-defence',
        title: 'Layers of defence',
        outcome: 'Place firewalls, intrusion prevention, AAA, 802.1X and encryption in layers of defence, and say what hashing, symmetric and public-key cryptography each provide.',
        theory: '',
        estimatedMinutes: 16,
        topic: 'Thinking like a defender',
      },
    ],
  },
  {
    id: 'ccna3-m6-access-control-lists',
    title: 'Access control lists',
    summary: 'Lists that permit or deny traffic: how they decide, how to write and place them, and how to see what they match.',
    lessons: [
      {
        id: 'ccna3-14-how-an-acl-decides',
        title: 'How an ACL decides',
        outcome: 'Follow an access list from the top down to its first match and the silent deny at its end, and read any wildcard mask bit by bit.',
        theory: '',
        estimatedMinutes: 14,
        topic: 'Access control lists',
      },
      {
        id: 'ccna3-15-standard-acls',
        title: 'Standard ACLs',
        outcome: 'Write numbered and named standard access lists, apply them in the right direction close to the destination, and guard the virtual terminal lines with one.',
        theory: '',
        lab: 'ccna3-acl-standard',
        estimatedMinutes: 16,
        topic: 'Access control lists',
      },
      {
        id: 'ccna3-16-extended-acls',
        title: 'Extended ACLs',
        outcome: 'Filter by protocol, address and port with extended access lists, let replies back in with the established keyword, and place the lists close to the source.',
        theory: '',
        lab: 'ccna3-acl-extended',
        estimatedMinutes: 18,
        topic: 'Access control lists',
      },
      {
        id: 'ccna3-17-editing-and-reading-acls',
        title: 'Editing and reading ACLs',
        outcome: 'Insert and remove entries by sequence number, add remarks, and use match counters and logging to see what a list is doing.',
        theory: '',
        lab: 'ccna3-acl-edit-verify',
        estimatedMinutes: 14,
        topic: 'Access control lists',
      },
      {
        id: 'ccna3-18-translation-at-the-edge',
        title: 'Translation at the edge',
        outcome: 'Explain how address translation and access lists work together at the edge of a network, and what NAT64 is for.',
        theory: '',
        estimatedMinutes: 10,
        topic: 'Access control lists',
      },
    ],
  },
  {
    id: 'ccna3-m7-hardening',
    title: 'Hardening',
    summary: 'Locking down how a device is managed, and protecting the access layer from forged traffic.',
    lessons: [
      {
        id: 'ccna3-19-locking-down-device-access',
        title: 'Locking down device access',
        outcome: 'Allow only SSH for management, with local user accounts and an access list on the virtual terminal lines, and say what an exec timeout and a login lockout add.',
        theory: '',
        lab: 'ccna3-secure-device-access',
        estimatedMinutes: 16,
        topic: 'Hardening',
      },
      {
        id: 'ccna3-20-guarding-the-access-layer',
        title: 'Guarding the access layer',
        outcome: 'Stop a rogue DHCP server with DHCP snooping and forged ARP replies with dynamic ARP inspection, and say what storm control and IP source guard add.',
        theory: '',
        lab: 'ccna3-dhcp-snooping-dai',
        estimatedMinutes: 18,
        topic: 'Hardening',
      },
    ],
  },
  {
    id: 'ccna3-m8-wide-area-networks',
    title: 'Wide area networks',
    summary: 'The ways distant sites are joined, and the serial links and protocols that carry traffic between them.',
    lessons: [
      {
        id: 'ccna3-21-joining-distant-sites',
        title: 'Joining distant sites',
        outcome: 'Compare leased lines, MPLS, metro Ethernet and DSL, cable, fibre and cellular access, and choose a connection for each site.',
        theory: '',
        estimatedMinutes: 16,
        topic: 'Wide area networks',
      },
      {
        id: 'ccna3-22-point-to-point-links',
        title: 'Point-to-point links',
        outcome: 'Bring up a serial link with HDLC and then with PPP, following its link and network control phases and authenticating with PAP or CHAP.',
        theory: '',
        lab: 'ccna3-serial-links',
        estimatedMinutes: 16,
        topic: 'Wide area networks',
      },
    ],
  },
  {
    id: 'ccna3-m9-tunnels-and-vpns',
    title: 'Tunnels and VPNs',
    summary: 'Carrying private traffic across a public network, first in a plain tunnel, then protected.',
    lessons: [
      {
        id: 'ccna3-23-private-paths-over-public-networks',
        title: 'Private paths over public networks',
        outcome: 'Tell site-to-site from remote-access VPNs, and describe what AH, ESP and the two phases of key exchange each do.',
        theory: '',
        estimatedMinutes: 16,
        topic: 'Tunnels and VPNs',
      },
      {
        id: 'ccna3-24-gre-tunnels',
        title: 'GRE tunnels',
        outcome: 'Build a GRE tunnel, route traffic through it, and explain why GRE on its own keeps nothing private.',
        theory: '',
        lab: 'ccna3-gre-tunnel',
        estimatedMinutes: 16,
        topic: 'Tunnels and VPNs',
      },
      {
        id: 'ccna3-25-site-to-site-ipsec',
        title: 'Site-to-site IPsec',
        outcome: 'Protect the traffic between two sites with IPsec, and prove that only encrypted packets cross the provider network.',
        theory: '',
        lab: 'ccna3-ipsec-site-to-site',
        estimatedMinutes: 16,
        topic: 'Tunnels and VPNs',
      },
    ],
  },
  {
    id: 'ccna3-m10-quality-of-service',
    title: 'Quality of service',
    summary: 'Why some traffic needs priority, and the marking, queuing and policing that give it.',
    lessons: [
      {
        id: 'ccna3-26-why-traffic-needs-priority',
        title: 'Why traffic needs priority',
        outcome: 'Explain how delay, jitter and loss hurt different kinds of traffic, and compare first-in first-out, weighted fair, class-based and low-latency queuing.',
        theory: '',
        estimatedMinutes: 14,
        topic: 'Quality of service',
      },
      {
        id: 'ccna3-27-marking-queuing-and-policing',
        title: 'Marking, queuing and policing',
        outcome: 'Mark traffic with CoS and DSCP at a trust boundary, give voice a priority queue, and tell policing from shaping.',
        theory: '',
        lab: 'ccna3-qos-voice-first',
        estimatedMinutes: 16,
        topic: 'Quality of service',
      },
    ],
  },
  {
    id: 'ccna3-m11-managing-the-network',
    title: 'Managing the network',
    summary: 'Discovering neighbours, keeping time and logs, watching traffic, and looking after files and images.',
    lessons: [
      {
        id: 'ccna3-28-who-is-next-door',
        title: 'Who is next door',
        outcome: 'Map an unknown network with CDP and LLDP, and turn discovery off on the ports where it gives too much away.',
        theory: '',
        lab: 'ccna3-discover-neighbours',
        estimatedMinutes: 14,
        topic: 'Managing the network',
      },
      {
        id: 'ccna3-29-time-and-logs',
        title: 'Time and logs',
        outcome: 'Set every clock from a hierarchy of NTP sources, and read syslog severities, facilities and servers.',
        theory: '',
        lab: 'ccna3-time-and-logs',
        estimatedMinutes: 16,
        topic: 'Managing the network',
      },
      {
        id: 'ccna3-30-watching-the-network',
        title: 'Watching the network',
        outcome: 'Describe how SNMP versions 2c and 3 poll devices and raise traps, what flow records show, and how a SPAN session copies traffic to an analyser.',
        theory: '',
        estimatedMinutes: 16,
        topic: 'Managing the network',
      },
      {
        id: 'ccna3-31-looking-after-files-and-images',
        title: 'Looking after files and images',
        outcome: 'Describe the file systems of a device, how its configuration is backed up and restored, how its software image is upgraded, and how password recovery works.',
        theory: '',
        estimatedMinutes: 16,
        topic: 'Managing the network',
      },
    ],
  },
  {
    id: 'ccna3-m12-designing-and-fixing',
    title: 'Designing and fixing',
    summary: 'Designing networks that can grow, and a method for finding the faults in them.',
    lessons: [
      {
        id: 'ccna3-32-designing-networks-that-grow',
        title: 'Designing networks that grow',
        outcome: 'Compare three-tier and collapsed-core designs, and choose switches and routers by ports, speed, power over Ethernet and redundancy.',
        theory: '',
        estimatedMinutes: 14,
        topic: 'Designing and fixing',
      },
      {
        id: 'ccna3-33-a-method-for-enterprise-faults',
        title: 'A method for enterprise faults',
        outcome: 'Start from documentation, baselines and symptoms, then work layer by layer with the right tool at each layer to find a fault.',
        theory: '',
        lab: 'ccna3-troubleshoot-eigrp',
        estimatedMinutes: 14,
        topic: 'Designing and fixing',
      },
      {
        id: 'ccna3-34-finding-faults-across-layers',
        title: 'Finding faults across layers',
        outcome: 'Troubleshoot a network of several sites with routing, access list, translation and time faults.',
        theory: '',
        lab: 'ccna3-troubleshoot-enterprise',
        estimatedMinutes: 16,
        topic: 'Designing and fixing',
      },
    ],
  },
  {
    id: 'ccna3-m13-virtual-networks',
    title: 'Virtual networks',
    summary: 'Clouds, virtual machines, and networks run by software controllers.',
    lessons: [
      {
        id: 'ccna3-35-clouds-and-virtual-machines',
        title: 'Clouds and virtual machines',
        outcome: 'Describe the cloud service and deployment models, what a hypervisor does, and how virtual switches connect virtual machines.',
        theory: '',
        estimatedMinutes: 14,
        topic: 'Virtual networks',
      },
      {
        id: 'ccna3-36-software-defined-networking',
        title: 'Software-defined networking',
        outcome: 'Describe the three planes of a network device, what a controller takes over, its northbound and southbound interfaces, and what intent-based networking adds.',
        theory: '',
        estimatedMinutes: 14,
        topic: 'Virtual networks',
      },
    ],
  },
  {
    id: 'ccna3-m14-automating-the-network',
    title: 'Automating the network',
    summary: 'Data a machine can read, device APIs, configuration as code, and scripts that talk to devices.',
    lessons: [
      {
        id: 'ccna3-37-data-a-machine-can-read',
        title: 'Data a machine can read',
        outcome: 'Write the same data as JSON, XML and YAML, and find the error in a broken document.',
        theory: '',
        estimatedMinutes: 14,
        topic: 'Automating the network',
      },
      {
        id: 'ccna3-38-talking-to-devices-through-apis',
        title: 'Talking to devices through APIs',
        outcome: 'Use REST verbs, URIs, status codes and credentials to read and change a device through RESTCONF with an IETF YANG model.',
        theory: '',
        lab: 'ccna3-restconf-change',
        estimatedMinutes: 18,
        topic: 'Automating the network',
      },
      {
        id: 'ccna3-39-configuration-as-code',
        title: 'Configuration as code',
        outcome: 'Compare configuration-management tools, and describe what a playbook run across many devices does.',
        theory: '',
        estimatedMinutes: 16,
        topic: 'Automating the network',
      },
      {
        id: 'ccna3-40-scripting-the-network',
        title: 'Scripting the network',
        outcome: 'Write a short script that takes an inventory of devices through their API.',
        theory: '',
        lab: 'ccna3-script-inventory',
        estimatedMinutes: 16,
        topic: 'Automating the network',
      },
    ],
  },
];
