/**
 * curriculum/ccna3/objectives.ts — the CCNA 3 objectives as data, each traced to the lesson that teaches it and to
 * the lab where it is practised (ARCHITECTURE-P3 §11.4; spec §2.3 and the §2.8 traceability).
 *
 * One row per objective of the §11.4 table, cluster by cluster in its order; a fragment of that table that names two
 * lessons or two labs with different hands-on states is split into one row each (for example LSA types 1 and 2 in
 * lesson 04's lab, type 5 in lesson 06's). Ids are `CCNA3.<cluster>.<n>`, numbered from 1 inside each cluster.
 *
 * `handsOn` (§11.4):
 * - `'lab'` — practised in a lab: a lab of the approved plan (§8.5), or, for the rows §11.4 traces to CCNA 2 lessons
 *   (BPDU guard, the native VLAN and trunk negotiation), the CCNA 2 lab that practises them. `lab` names that lab.
 * - `'theory'` — the objective is describe-level and its lesson meets it (a concept tool may illustrate it).
 * - `'later:P3c'` — the hands-on part needs a SHOULD or COULD item outside the approved plan; recorded for P3c, the
 *   follow-up content stage (§12.1). The lesson teaches the idea; the tool is never "taught as theory".
 * - `'untaught:P4'`, `'untaught:P5'` — the stage that takes it.
 * `lab` is present exactly when `handsOn` is `'lab'`. `lesson` is the lesson §11.4 names first for the objective.
 *
 * DETACHED like `ccna3/lessons.ts` until the W7 course flip: nothing imports this file but its test,
 * `test/curriculum.ccna3.test.ts`, which fails when an objective has no row and lists every row that is not `'lab'`
 * as the spec §2.8 `coverage-gap` warning.
 *
 * All wording is original and paraphrases the objectives; it names no vendor, product or certification programme
 * (§0 rule 6, §11.3). Flow export is named by its open standard (IPFIX) only.
 */

/** Where an objective's hands-on part lives (§11.4). */
export type ObjectiveHandsOn = 'lab' | 'theory' | 'later:P3c' | 'untaught:P4' | 'untaught:P5';

/** Every `handsOn` value, in the order §11.4 lists them. */
export const OBJECTIVE_HANDS_ON: readonly ObjectiveHandsOn[] = ['lab', 'theory', 'later:P3c', 'untaught:P4', 'untaught:P5'];

/** One curriculum objective and where it is taught (§11.4). Plain data, like the lessons. */
export interface CourseObjective {
  /** `CCNA3.<cluster>.<n>`. */
  readonly id: string;
  /** The objective in original wording (a paraphrase). */
  readonly text: string;
  /** Id of the lesson that teaches it (a CCNA 3 lesson, or a CCNA 2 lesson where §11.4 says so). */
  readonly lesson: string;
  /** `ScenarioInfo.name` of the lab that practises it; present exactly when `handsOn` is `'lab'`. */
  readonly lab?: string;
  readonly handsOn: ObjectiveHandsOn;
}

/** The objective clusters: the nine topic clusters of spec §2.3, then the course modules beyond it (§11.4). */
export const CCNA3_OBJECTIVE_CLUSTERS: readonly { readonly id: string; readonly title: string }[] = [
  { id: 'ospf', title: 'OSPF' },
  { id: 'eigrp', title: 'EIGRP' },
  { id: 'acl', title: 'Access control lists' },
  { id: 'security', title: 'Security concepts' },
  { id: 'hardening', title: 'Device hardening' },
  { id: 'wan', title: 'Wide area networks' },
  { id: 'qos', title: 'Quality of service' },
  { id: 'management', title: 'Network management' },
  { id: 'automation', title: 'Automation' },
  { id: 'course', title: 'Beyond the engine list: course modules' },
];

/** Every CCNA 3 objective, cluster by cluster in the §11.4 order. */
export const CCNA3_OBJECTIVES: readonly CourseObjective[] = [
  // OSPF
  { id: 'CCNA3.ospf.1', text: 'Run OSPFv2 in a single area', lesson: 'ccna3-04-switching-ospf-on', lab: 'ccna3-ospf-single-area', handsOn: 'lab' },
  { id: 'CCNA3.ospf.2', text: 'Predict and steer the designated and backup designated router election', lesson: 'ccna3-03-neighbours-and-the-designated-router', lab: 'ccna3-ospf-dr-election', handsOn: 'lab' },
  { id: 'CCNA3.ospf.3', text: 'Tell how OSPF behaves on broadcast segments and on point-to-point links', lesson: 'ccna3-03-neighbours-and-the-designated-router', lab: 'ccna3-ospf-dr-election', handsOn: 'lab' },
  { id: 'CCNA3.ospf.4', text: 'Match hello and dead intervals between neighbours', lesson: 'ccna3-06-default-routes-and-timers', lab: 'ccna3-ospf-default-route', handsOn: 'lab' },
  { id: 'CCNA3.ospf.5', text: 'Derive interface cost from bandwidth and the reference bandwidth', lesson: 'ccna3-05-cost-and-the-best-path', lab: 'ccna3-ospf-cost', handsOn: 'lab' },
  { id: 'CCNA3.ospf.6', text: 'Keep hellos off interfaces where no router listens', lesson: 'ccna3-04-switching-ospf-on', lab: 'ccna3-ospf-single-area', handsOn: 'lab' },
  { id: 'CCNA3.ospf.7', text: 'Choose and fix the router ID', lesson: 'ccna3-04-switching-ospf-on', lab: 'ccna3-ospf-single-area', handsOn: 'lab' },
  { id: 'CCNA3.ospf.8', text: 'Read the link-state database and the shortest-path tree computed from it', lesson: 'ccna3-02-how-ospf-maps-a-network', handsOn: 'theory' },
  { id: 'CCNA3.ospf.9', text: 'Split an OSPF network into several areas', lesson: 'ccna3-08-more-than-one-area', handsOn: 'later:P3c' },
  { id: 'CCNA3.ospf.10', text: 'Run OSPFv3 for IPv6', lesson: 'ccna3-09-ospf-for-ipv6', handsOn: 'later:P3c' },
  { id: 'CCNA3.ospf.11', text: 'Run OSPF over non-broadcast multi-access networks', lesson: 'ccna3-03-neighbours-and-the-designated-router', handsOn: 'untaught:P5' },
  { id: 'CCNA3.ospf.12', text: 'Read router and network advertisements (LSA types 1 and 2)', lesson: 'ccna3-04-switching-ospf-on', lab: 'ccna3-ospf-single-area', handsOn: 'lab' },
  { id: 'CCNA3.ospf.13', text: 'Read external advertisements (LSA type 5)', lesson: 'ccna3-06-default-routes-and-timers', lab: 'ccna3-ospf-default-route', handsOn: 'lab' },
  { id: 'CCNA3.ospf.14', text: 'Read the summary advertisements an area border router sends (LSA types 3 and 4)', lesson: 'ccna3-08-more-than-one-area', handsOn: 'later:P3c' },
  { id: 'CCNA3.ospf.15', text: 'Read the external advertisements of a not-so-stubby area (LSA type 7)', lesson: 'ccna3-08-more-than-one-area', handsOn: 'untaught:P5' },
  { id: 'CCNA3.ospf.16', text: 'Authenticate OSPF neighbours', lesson: 'ccna3-07-fixing-ospf', handsOn: 'later:P3c' },

  // EIGRP
  { id: 'CCNA3.eigrp.1', text: 'Read the neighbour and topology tables', lesson: 'ccna3-10-eigrp-and-its-metric', lab: 'ccna3-eigrp-feasible-successor', handsOn: 'lab' },
  { id: 'CCNA3.eigrp.2', text: 'Find the successor and the feasible successor with the feasibility condition', lesson: 'ccna3-10-eigrp-and-its-metric', lab: 'ccna3-eigrp-feasible-successor', handsOn: 'lab' },
  { id: 'CCNA3.eigrp.3', text: 'Compose the metric from its parts and match the K values', lesson: 'ccna3-10-eigrp-and-its-metric', lab: 'ccna3-eigrp-feasible-successor', handsOn: 'lab' },
  { id: 'CCNA3.eigrp.4', text: 'Find why EIGRP neighbours will not form', lesson: 'ccna3-33-a-method-for-enterprise-faults', lab: 'ccna3-troubleshoot-eigrp', handsOn: 'lab' },
  { id: 'CCNA3.eigrp.5', text: 'Use stub routing, summarisation and unequal-cost load sharing', lesson: 'ccna3-10-eigrp-and-its-metric', handsOn: 'untaught:P5' },

  // Access control lists
  { id: 'CCNA3.acl.1', text: 'Write standard access lists', lesson: 'ccna3-15-standard-acls', lab: 'ccna3-acl-standard', handsOn: 'lab' },
  { id: 'CCNA3.acl.2', text: 'Write extended access lists', lesson: 'ccna3-16-extended-acls', lab: 'ccna3-acl-extended', handsOn: 'lab' },
  { id: 'CCNA3.acl.3', text: 'Write numbered and named access lists', lesson: 'ccna3-15-standard-acls', lab: 'ccna3-acl-standard', handsOn: 'lab' },
  { id: 'CCNA3.acl.4', text: 'Read a wildcard mask bit by bit', lesson: 'ccna3-14-how-an-acl-decides', handsOn: 'theory' },
  { id: 'CCNA3.acl.5', text: 'Let replies back in with the established keyword', lesson: 'ccna3-16-extended-acls', lab: 'ccna3-acl-extended', handsOn: 'lab' },
  { id: 'CCNA3.acl.6', text: 'Place each kind of list at the right end of the path', lesson: 'ccna3-15-standard-acls', handsOn: 'later:P3c' },
  { id: 'CCNA3.acl.7', text: 'Read the match counters of a list', lesson: 'ccna3-17-editing-and-reading-acls', lab: 'ccna3-acl-edit-verify', handsOn: 'lab' },
  { id: 'CCNA3.acl.8', text: 'Log the packets an entry matches', lesson: 'ccna3-17-editing-and-reading-acls', lab: 'ccna3-acl-edit-verify', handsOn: 'lab' },
  { id: 'CCNA3.acl.9', text: 'Guard the virtual terminal lines with an access list', lesson: 'ccna3-15-standard-acls', lab: 'ccna3-acl-standard', handsOn: 'lab' },
  { id: 'CCNA3.acl.10', text: 'Filter IPv6 traffic with an access list', lesson: 'ccna3-17-editing-and-reading-acls', handsOn: 'later:P3c' },
  { id: 'CCNA3.acl.11', text: 'Apply an access list only at certain times', lesson: 'ccna3-17-editing-and-reading-acls', handsOn: 'untaught:P4' },

  // Security concepts
  { id: 'CCNA3.security.1', text: 'Describe confidentiality, integrity and availability, and tell a threat, a vulnerability, an exploit and a risk apart', lesson: 'ccna3-11-the-language-of-security', handsOn: 'theory' },
  { id: 'CCNA3.security.2', text: 'Sort attacks into families by what they do to a network', lesson: 'ccna3-12-how-attacks-unfold', handsOn: 'theory' },
  { id: 'CCNA3.security.3', text: 'Stack defences in layers', lesson: 'ccna3-13-layers-of-defence', handsOn: 'theory' },
  { id: 'CCNA3.security.4', text: 'Check administrators against local user accounts', lesson: 'ccna3-19-locking-down-device-access', lab: 'ccna3-secure-device-access', handsOn: 'lab' },
  { id: 'CCNA3.security.5', text: 'Check administrators against a central AAA server', lesson: 'ccna3-13-layers-of-defence', handsOn: 'untaught:P4' },
  { id: 'CCNA3.security.6', text: 'Admit devices at the port with 802.1X', lesson: 'ccna3-13-layers-of-defence', handsOn: 'untaught:P4' },

  // Device hardening
  { id: 'CCNA3.hardening.1', text: 'Allow only SSH for device management', lesson: 'ccna3-19-locking-down-device-access', lab: 'ccna3-secure-device-access', handsOn: 'lab' },
  { id: 'CCNA3.hardening.2', text: 'Shut the ports nobody uses', lesson: 'ccna3-19-locking-down-device-access', lab: 'ccna3-secure-device-access', handsOn: 'lab' },
  { id: 'CCNA3.hardening.3', text: 'Stop rogue DHCP servers with DHCP snooping', lesson: 'ccna3-20-guarding-the-access-layer', lab: 'ccna3-dhcp-snooping-dai', handsOn: 'lab' },
  { id: 'CCNA3.hardening.4', text: 'Stop forged ARP replies with dynamic ARP inspection', lesson: 'ccna3-20-guarding-the-access-layer', lab: 'ccna3-dhcp-snooping-dai', handsOn: 'lab' },
  { id: 'CCNA3.hardening.5', text: 'Drop spoofed source addresses with IP source guard', lesson: 'ccna3-20-guarding-the-access-layer', handsOn: 'later:P3c' },
  { id: 'CCNA3.hardening.6', text: 'Limit floods with storm control', lesson: 'ccna3-20-guarding-the-access-layer', handsOn: 'later:P3c' },
  { id: 'CCNA3.hardening.7', text: 'Shut an edge port that receives a BPDU (BPDU guard)', lesson: 'ccna2-16-edge-ports-and-guards', lab: 'ccna2-stp-guards', handsOn: 'lab' },
  { id: 'CCNA3.hardening.8', text: 'Move the native VLAN away from VLAN 1 and switch trunk negotiation off', lesson: 'ccna2-24-hardening-switch-ports', lab: 'ccna2-port-security', handsOn: 'lab' },

  // Wide area networks
  { id: 'CCNA3.wan.1', text: 'Compare leased lines, broadband, MPLS and metro Ethernet', lesson: 'ccna3-21-joining-distant-sites', handsOn: 'later:P3c' },
  { id: 'CCNA3.wan.2', text: 'Run HDLC on a serial link', lesson: 'ccna3-22-point-to-point-links', lab: 'ccna3-serial-links', handsOn: 'lab' },
  { id: 'CCNA3.wan.3', text: 'Bring PPP up through its link and network control phases and authenticate with CHAP', lesson: 'ccna3-22-point-to-point-links', lab: 'ccna3-serial-links', handsOn: 'lab' },
  { id: 'CCNA3.wan.4', text: 'Explain what PAP sends and why CHAP is preferred', lesson: 'ccna3-22-point-to-point-links', handsOn: 'theory' },
  { id: 'CCNA3.wan.5', text: 'Describe the kinds of virtual private network and what each protects', lesson: 'ccna3-23-private-paths-over-public-networks', handsOn: 'theory' },
  { id: 'CCNA3.wan.6', text: 'Carry traffic between sites in a GRE tunnel', lesson: 'ccna3-24-gre-tunnels', lab: 'ccna3-gre-tunnel', handsOn: 'lab' },
  { id: 'CCNA3.wan.7', text: 'Protect site-to-site traffic with IPsec', lesson: 'ccna3-25-site-to-site-ipsec', lab: 'ccna3-ipsec-site-to-site', handsOn: 'lab' },
  { id: 'CCNA3.wan.8', text: 'Build IPsec with crypto maps and IKEv1, and remote-access VPNs', lesson: 'ccna3-25-site-to-site-ipsec', handsOn: 'untaught:P4' },

  // Quality of service
  { id: 'CCNA3.qos.1', text: 'Classify and mark traffic with CoS, DSCP and IP precedence', lesson: 'ccna3-27-marking-queuing-and-policing', lab: 'ccna3-qos-voice-first', handsOn: 'lab' },
  { id: 'CCNA3.qos.2', text: 'Compare first-in first-out, weighted fair, class-based and low-latency queuing', lesson: 'ccna3-26-why-traffic-needs-priority', lab: 'ccna3-qos-voice-first', handsOn: 'lab' },
  { id: 'CCNA3.qos.3', text: 'Tell policing from shaping', lesson: 'ccna3-27-marking-queuing-and-policing', lab: 'ccna3-qos-voice-first', handsOn: 'lab' },
  { id: 'CCNA3.qos.4', text: 'Watch a link congest and its queue fill', lesson: 'ccna3-27-marking-queuing-and-policing', lab: 'ccna3-qos-voice-first', handsOn: 'lab' },

  // Network management
  { id: 'CCNA3.management.1', text: 'Discover neighbouring devices with CDP and LLDP', lesson: 'ccna3-28-who-is-next-door', lab: 'ccna3-discover-neighbours', handsOn: 'lab' },
  { id: 'CCNA3.management.2', text: 'Set clocks from a hierarchy of NTP strata', lesson: 'ccna3-29-time-and-logs', lab: 'ccna3-time-and-logs', handsOn: 'lab' },
  { id: 'CCNA3.management.3', text: 'Log by severity, locally and to a syslog server', lesson: 'ccna3-29-time-and-logs', lab: 'ccna3-time-and-logs', handsOn: 'lab' },
  { id: 'CCNA3.management.4', text: 'Poll devices and receive traps with SNMPv2c', lesson: 'ccna3-30-watching-the-network', handsOn: 'later:P3c' },
  { id: 'CCNA3.management.5', text: 'Poll devices securely with SNMPv3', lesson: 'ccna3-30-watching-the-network', handsOn: 'later:P3c' },
  { id: 'CCNA3.management.6', text: 'Export flow records (IPFIX)', lesson: 'ccna3-30-watching-the-network', handsOn: 'untaught:P4' },
  { id: 'CCNA3.management.7', text: 'Copy the traffic of a port to an analyser with SPAN', lesson: 'ccna3-30-watching-the-network', handsOn: 'later:P3c' },
  { id: 'CCNA3.management.8', text: 'Copy the traffic of a port to an analyser on another switch with RSPAN', lesson: 'ccna3-30-watching-the-network', handsOn: 'untaught:P4' },
  { id: 'CCNA3.management.9', text: 'Work with the device file system, and back up and upgrade the software image', lesson: 'ccna3-31-looking-after-files-and-images', handsOn: 'later:P3c' },
  { id: 'CCNA3.management.10', text: 'Recover access to a device whose password is lost', lesson: 'ccna3-31-looking-after-files-and-images', handsOn: 'later:P3c' },

  // Automation
  { id: 'CCNA3.automation.1', text: 'Read and write the same data as JSON, XML and YAML', lesson: 'ccna3-37-data-a-machine-can-read', lab: 'ccna3-restconf-change', handsOn: 'lab' },
  { id: 'CCNA3.automation.2', text: 'Call the REST API of a device', lesson: 'ccna3-38-talking-to-devices-through-apis', lab: 'ccna3-restconf-change', handsOn: 'lab' },
  { id: 'CCNA3.automation.3', text: 'Read and change a device through RESTCONF and a YANG model', lesson: 'ccna3-38-talking-to-devices-through-apis', lab: 'ccna3-restconf-change', handsOn: 'lab' },
  { id: 'CCNA3.automation.4', text: 'Browse a YANG model node by node', lesson: 'ccna3-38-talking-to-devices-through-apis', handsOn: 'later:P3c' },
  { id: 'CCNA3.automation.5', text: 'Manage a device through NETCONF', lesson: 'ccna3-38-talking-to-devices-through-apis', handsOn: 'later:P3c' },
  { id: 'CCNA3.automation.6', text: 'Run a configuration playbook across many devices', lesson: 'ccna3-39-configuration-as-code', handsOn: 'later:P3c' },
  { id: 'CCNA3.automation.7', text: 'Script the network in Python', lesson: 'ccna3-40-scripting-the-network', lab: 'ccna3-script-inventory', handsOn: 'lab' },
  { id: 'CCNA3.automation.8', text: 'Describe controller-based, software-defined and intent-based networking', lesson: 'ccna3-36-software-defined-networking', handsOn: 'later:P3c' },

  // Beyond the engine list: course modules
  { id: 'CCNA3.course.1', text: 'Combine address translation and access lists at the edge of a network', lesson: 'ccna3-18-translation-at-the-edge', lab: 'ccna3-troubleshoot-enterprise', handsOn: 'lab' },
  { id: 'CCNA3.course.2', text: 'Design a network that can grow', lesson: 'ccna3-32-designing-networks-that-grow', handsOn: 'theory' },
  { id: 'CCNA3.course.3', text: 'Find a fault with a layered method', lesson: 'ccna3-33-a-method-for-enterprise-faults', lab: 'ccna3-troubleshoot-eigrp', handsOn: 'lab' },
  { id: 'CCNA3.course.4', text: 'Find faults across several layers and sites', lesson: 'ccna3-34-finding-faults-across-layers', lab: 'ccna3-troubleshoot-enterprise', handsOn: 'lab' },
  { id: 'CCNA3.course.5', text: 'Describe cloud services and virtualisation', lesson: 'ccna3-35-clouds-and-virtual-machines', handsOn: 'theory' },
];
