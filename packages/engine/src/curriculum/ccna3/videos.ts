/**
 * curriculum/ccna3/videos.ts — one verified video per CCNA 3 lesson, keyed by lesson id (ARCHITECTURE-P3 §11.3, the
 * video rule unchanged from P2).
 *
 * Same rule as `curriculum/ccna1/videos.ts` and `curriculum/ccna2/videos.ts`, whose headers explain why each step
 * exists. Candidates came from YouTube's own results pages; none of the ids below was typed from memory. Every entry
 * was then checked on the date written above the map, with the requests these three calls make:
 *
 *   curl -s "https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=<id>&format=json"
 *   curl -s -A "Mozilla/5.0" "https://www.youtube.com/watch?v=<id>" | grep -o '"playableInEmbed":[a-z]*'
 *   curl -s "https://sponsor.ajay.app/api/skipSegments?videoID=<id>&categories=%5B%22sponsor%22%2C%22selfpromo%22%5D"
 *
 * The first must answer 200 with JSON, and its `title` and `author_name` are copied below exactly as returned —
 * including the double spaces in two titles — so a reviewer can re-run it and diff. The second must print
 * `"playableInEmbed":true`; the same page gave each video's `lengthSeconds` (recorded in
 * `curriculum.ccna3.videos.test.ts`, which checks the lesson minutes with them). The third asks the community skip
 * list for sponsor and self-promotion segments: 404 means none is on record. That list only knows what viewers have
 * marked, so each watch page's description and chapter list were read as well. Links to a course, a book or a
 * donation page in a description are not a read; a sponsor named in the description or the chapters is, and
 * disqualifies the video.
 *
 * What was turned away, so nobody re-proposes it: two videos whose sponsor-segment lookup answered 200 (one of them
 * also names an audiobook sponsor in its description); two whose description or chapters name a paid partner (a
 * maths-course trial, an identity-protection service); one video CCNA 1 already shows; one title written with
 * look-alike Greek capitals, which a screen reader would spell out; one in French; a run of uploads whose descriptions
 * read as summaries generated from a document; and numbered uploads that open a paid course's own syllabus. The
 * CCNA 3 vendor rule is wider than CCNA 2's (§11.3: no vendor, controller product or vendor
 * certification programme), so every candidate whose title or channel names a vendor, a vendor simulator or a vendor
 * certification (most titles in this syllabus say so, and nearly every candidate for the lesson on files and images)
 * was turned away rather than edited, as were channels whose name carries a certification.
 *
 * Scope: all 14 modules. Modules 1-13 (lessons 01-36) were checked in W6; module 14 (lessons 37-40, automation) in
 * W7, with the same three calls on the date written above the map. Expected hazard (§11.3): automation, SDN and QoS
 * videos mostly come from vendor channels; theory-only is allowed, and a lesson with no entry renders without a video.
 *
 * Module 14 (W7): the candidates came from the results pages of fourteen searches (data formats, REST and HTTP verbs,
 * RESTCONF and YANG, configuration management, infrastructure as code, agent and push models, Python requests).
 * Turned away there: nearly every RESTCONF, YANG and NETCONF video (a vendor, a vendor's certification or its
 * developer programme in the title or the channel, or longer than the lesson), the one RESTCONF tutorial from a
 * network-automation software maker's own channel (a product channel credited on screen), every video whose title
 * names a configuration-management tool, one whose description points to a site that copies a course's module 14
 * material, numbered uploads of course series, one whose chapters advertise books, one that is not embeddable
 * (oEmbed 401), three in French or Korean, and two whose titles end with an emoji a screen reader would read out.
 * Lesson 38's video teaches REST itself (verbs, CRUD, status codes) and lesson 40's calls a public web API rather than
 * a device; the lessons carry RESTCONF, YANG and the device side.
 *
 * Length: the shortest video runs 3:49 (lesson 31) and the longest 13:14 (lesson 16). Each lesson's minutes cover
 * its video plus its theory read at 238 words a minute, and none passes the 45-minute cap of §11.1 (pinned by
 * `curriculum.ccna3.videos.test.ts`, which counts the bodies of `theory-c.ts` and `theory-d.ts` and gives every other
 * lesson the longest body a lesson may carry, since lessons 01-22 were written alongside these entries).
 *
 * The titles are UI text — the lesson view shows one as the caption and gives it to the player as its accessible
 * name — so the no-vendor rule reaches them, and a title that names a vendor disqualifies the video rather than
 * being edited. A video may still show a vendor's simulator or command line on screen, as the CCNA 2 entries do; a
 * comment says so where the lesson's own syntax differs. `curriculum.ccna3.videos.test.ts` enforces the text rules,
 * with no network in the test.
 */
import type { LessonVideoMap } from '../../contracts/curriculum.js';

/** Checked on 2026-10-12 (W6 course, lessons 01-36) and on 2026-10-13 (W7 course, lessons 37-40): every entry answered
 * oEmbed 200 with the title and channel recorded below, reported `playableInEmbed` true on its watch page, had no
 * sponsor or self-promotion segment on record (404), and carried no sponsor in its description or chapters. 36 of the
 * 36 lessons of modules 1-13 have one, and 4 of the 4 lessons of module 14. */
export const CCNA3_VIDEOS: LessonVideoMap = {
  'ccna3-01-why-routers-share-routes': {
    youtubeId: 'htweWjG8Ny4',
    title: 'static vs dynamic routing & routing metrics',
    channel: 'Sunny Classroom',
    url: 'https://www.youtube.com/watch?v=htweWjG8Ny4',
  },
  'ccna3-02-how-ospf-maps-a-network': {
    youtubeId: '_ThYOX1wX_4',
    title: 'OSPF Framework & OSPF Packets:  LSDB, LSA, Hello, DBD, LSR, LSU, LSAck',
    channel: 'Practical Networking',
    url: 'https://www.youtube.com/watch?v=_ThYOX1wX_4',
  },
  'ccna3-03-neighbours-and-the-designated-router': {
    youtubeId: 'gPt64UE3x6o',
    title: 'OSPF DR/BDR Election',
    channel: 'telecomTech',
    url: 'https://www.youtube.com/watch?v=gPt64UE3x6o',
  },
  'ccna3-04-switching-ospf-on': {
    youtubeId: 'dOks3EUiVIE',
    title: 'OSPF Router IDs, Hello & Dead Intervals, and Passive Interfaces',
    channel: 'telecomTech',
    url: 'https://www.youtube.com/watch?v=dOks3EUiVIE',
  },
  'ccna3-05-cost-and-the-best-path': {
    youtubeId: '6aZy29Tfz6s',
    title: 'How To Configure OSPF Cost',
    channel: 'Network Direction',
    url: 'https://www.youtube.com/watch?v=6aZy29Tfz6s',
  },
  'ccna3-06-default-routes-and-timers': {
    youtubeId: 'VL3m7QRTfFs',
    title: 'OSPF Default Route Explained | OSPF Default-Information Originate & Redistribution',
    channel: 'telecomTech',
    url: 'https://www.youtube.com/watch?v=VL3m7QRTfFs',
  },
  'ccna3-07-fixing-ospf': {
    youtubeId: 'cmAD1h1ySwQ',
    title: 'OSPF Neighbor Troubleshooting',
    channel: 'JD\'s Network Training',
    url: 'https://www.youtube.com/watch?v=cmAD1h1ySwQ',
  },
  'ccna3-08-more-than-one-area': {
    youtubeId: 'CM9BlFHB3q4',
    title: 'OSPF Areas and OSPF Types of Routers - Practical OSPF - Lesson 2',
    channel: 'Practical Networking',
    url: 'https://www.youtube.com/watch?v=CM9BlFHB3q4',
  },
  // Lesson 09 is theory-only ([S6] not approved, §11.4); the video compares how the two versions describe routers,
  // links and prefixes in their advertisements, which is the lesson's comparison.
  'ccna3-09-ospf-for-ipv6': {
    youtubeId: 'XeNCyPG9yQs',
    title: 'OSPFv2 vs OSPFv3: How They Handle LSAs',
    channel: 'CBT Nuggets',
    url: 'https://www.youtube.com/watch?v=XeNCyPG9yQs',
  },
  'ccna3-10-eigrp-and-its-metric': {
    youtubeId: 'TOzB1qIjxKI',
    title: 'Introduction to EIGRP: Feasible Successor',
    channel: 'Networklessons.com',
    url: 'https://www.youtube.com/watch?v=TOzB1qIjxKI',
  },
  'ccna3-11-the-language-of-security': {
    youtubeId: 'AngQoKJ18BA',
    title: 'CIA Triad Explained: Internal Threats, Vulnerabilities, & Zero-Day Attacks',
    channel: 'Cyber connect',
    url: 'https://www.youtube.com/watch?v=AngQoKJ18BA',
  },
  'ccna3-12-how-attacks-unfold': {
    youtubeId: 'S8MoTiexPHg',
    title: 'Every Network Attack Simply Explained',
    channel: 'Prime Explained',
    url: 'https://www.youtube.com/watch?v=S8MoTiexPHg',
  },
  'ccna3-13-layers-of-defence': {
    youtubeId: 'IiWFMIgKaqQ',
    title: 'Network Security | Defense in Depth',
    channel: 'Network Direction',
    url: 'https://www.youtube.com/watch?v=IiWFMIgKaqQ',
  },
  'ccna3-14-how-an-acl-decides': {
    youtubeId: 'fHyNZpnc_PY',
    title: 'Wild Card Masks',
    channel: 'Rick Graziani',
    url: 'https://www.youtube.com/watch?v=fHyNZpnc_PY',
  },
  'ccna3-15-standard-acls': {
    youtubeId: 'FV8pQfbMODs',
    title: 'ACL Placement: Closer to the Source or Destination? -- Access Control Lists (ACLs) -- Part 8 of 8',
    channel: 'Practical Networking',
    url: 'https://www.youtube.com/watch?v=FV8pQfbMODs',
  },
  'ccna3-16-extended-acls': {
    youtubeId: 'IwW9htwr3Tc',
    title: 'Creating an Extended ACL',
    channel: 'David Dalton',
    url: 'https://www.youtube.com/watch?v=IwW9htwr3Tc',
  },
  'ccna3-17-editing-and-reading-acls': {
    youtubeId: '7JdsrLW5Tvw',
    title: 'Named ACL Syntax -- Access Control Lists (ACLs) -- Part 4 of 8',
    channel: 'Practical Networking',
    url: 'https://www.youtube.com/watch?v=7JdsrLW5Tvw',
  },
  'ccna3-18-translation-at-the-edge': {
    youtubeId: 'EhCzKyojkNs',
    title: 'IPv4 to IPv6 transition - Translation with NAT64',
    channel: 'Sunny Classroom',
    url: 'https://www.youtube.com/watch?v=EhCzKyojkNs',
  },
  'ccna3-19-locking-down-device-access': {
    youtubeId: 'tZop-zjYkrU',
    title: 'Telnet vs SSH Explained',
    channel: 'PowerCert Animated Videos',
    url: 'https://www.youtube.com/watch?v=tZop-zjYkrU',
  },
  'ccna3-20-guarding-the-access-layer': {
    youtubeId: '8KDocvwoRW8',
    title: 'What is DHCP Snooping and Dynamic ARP Inspection?',
    channel: 'Naj Qazi',
    url: 'https://www.youtube.com/watch?v=8KDocvwoRW8',
  },
  'ccna3-21-joining-distant-sites': {
    youtubeId: 'TAIMfKLbZIg',
    title: 'WAN Technologies Explained | MPLS, Dedicated Links, SD-WAN & Hybrid WAN',
    channel: 'BlueHat CyberSec Academy: Learn. Think. Defend.',
    url: 'https://www.youtube.com/watch?v=TAIMfKLbZIg',
  },
  'ccna3-22-point-to-point-links': {
    youtubeId: '5-kVix07PeI',
    title: 'PPP Authentication PAP and CHAP',
    channel: 'Rick Graziani',
    url: 'https://www.youtube.com/watch?v=5-kVix07PeI',
  },
  'ccna3-23-private-paths-over-public-networks': {
    youtubeId: 'BCrRfyigvYE',
    title: 'IPsec Explained Simply: A Deep Dive into VPN Security Protocols (IKE, AH, ESP, Tunnel Modes)',
    channel: 'LevelUP I.T.',
    url: 'https://www.youtube.com/watch?v=BCrRfyigvYE',
  },
  'ccna3-24-gre-tunnels': {
    youtubeId: 'ytAqv7qHGyU',
    title: 'How GRE Tunnels Work | VPN Tunnels Part 1',
    channel: 'Network Direction',
    url: 'https://www.youtube.com/watch?v=ytAqv7qHGyU',
  },
  // Lesson 25: the same design as the lab (a protected tunnel interface between two sites), built with a phase 1
  // policy and a transform set of the older key exchange; the lesson and its lab use IKEv2 profiles, and the lesson
  // says IKEv1 is not modelled.
  'ccna3-25-site-to-site-ipsec': {
    youtubeId: 'XwkkgJuugRU',
    title: 'MicroNugget: How to Build IPsec Site-to-Site Tunnels Using VTIs',
    channel: 'CBT Nuggets',
    url: 'https://www.youtube.com/watch?v=XwkkgJuugRU',
  },
  'ccna3-26-why-traffic-needs-priority': {
    youtubeId: 'BZFMKvvRkeY',
    title: 'What is Latency, Packet Loss, and Jitter?',
    channel: 'CBT Nuggets',
    url: 'https://www.youtube.com/watch?v=BZFMKvvRkeY',
  },
  'ccna3-27-marking-queuing-and-policing': {
    youtubeId: 'ii7SxMSms80',
    title: 'Quality of Service (QoS), DSCP, & LLQ Visually Explained',
    channel: 'Visual Net',
    url: 'https://www.youtube.com/watch?v=ii7SxMSms80',
  },
  'ccna3-28-who-is-next-door': {
    youtubeId: 'e7fINxRrtTg',
    title: 'CDP vs LLDP EXPLAINED in Simple Terms for Network Beginners',
    channel: 'Networking with SHABY',
    url: 'https://www.youtube.com/watch?v=e7fINxRrtTg',
  },
  // Lesson 29: the video covers NTP, the strata included; the lesson's theory carries the syslog half.
  'ccna3-29-time-and-logs': {
    youtubeId: 'BAo5C2qbLq8',
    title: 'Network Time Protocol (NTP) - Computerphile',
    channel: 'Computerphile',
    url: 'https://www.youtube.com/watch?v=BAo5C2qbLq8',
  },
  'ccna3-30-watching-the-network': {
    youtubeId: 'vWZefoGNk5g',
    title: 'How SNMP Works | Network Fundamentals Part 24',
    channel: 'Network Direction',
    url: 'https://www.youtube.com/watch?v=vWZefoGNk5g',
  },
  // Lesson 31 is theory-only ([S29] not approved): nearly every candidate names a vendor in its title; this one
  // explains where the image and the two configurations live, the first part of the lesson.
  'ccna3-31-looking-after-files-and-images': {
    youtubeId: 'pdMVoeGS6eY',
    title: 'Inside the Brain of a Router: RAM, ROM, Flash & NVRAM Explained',
    channel: 'Visual Net',
    url: 'https://www.youtube.com/watch?v=pdMVoeGS6eY',
  },
  'ccna3-32-designing-networks-that-grow': {
    youtubeId: 'Xudj2So6XF4',
    title: 'What is 3 Tier Network Architecture?',
    channel: 'Naj Qazi',
    url: 'https://www.youtube.com/watch?v=Xudj2So6XF4',
  },
  'ccna3-33-a-method-for-enterprise-faults': {
    youtubeId: 'dovuPm3dGhc',
    title: 'Network Troubleshooting Methodology - CompTIA Network+ N10-009 - 5.1',
    channel: 'Professor Messer',
    url: 'https://www.youtube.com/watch?v=dovuPm3dGhc',
  },
  'ccna3-34-finding-faults-across-layers': {
    youtubeId: 'D8i6WcV0Tsg',
    title: 'Master Network Troubleshooting: L1 to L7 OSI Model (Real-World Examples)',
    channel: 'BlueHat CyberSec Academy: Learn. Think. Defend.',
    url: 'https://www.youtube.com/watch?v=D8i6WcV0Tsg',
  },
  'ccna3-35-clouds-and-virtual-machines': {
    youtubeId: 'wB6Lfdo2m1Q',
    title: 'IaaS PaaS  SaaS: 3 cloud computing service models',
    channel: 'Sunny Classroom',
    url: 'https://www.youtube.com/watch?v=wB6Lfdo2m1Q',
  },
  'ccna3-36-software-defined-networking': {
    youtubeId: 'wSMKEKh17Bw',
    title: 'SDN Explained | Traditional Networking vs SDN | Northbound & Southbound Interface Made Simple',
    channel: 'Cyber connect',
    url: 'https://www.youtube.com/watch?v=wSMKEKh17Bw',
  },
  // Module 14 (W7). Lesson 37 is theory with the data-formats playground; the video compares the three formats side by
  // side. Its description links the channel's own course, which is not a sponsor read.
  'ccna3-37-data-a-machine-can-read': {
    youtubeId: 'dx4jItJQRPM',
    title: 'Network Automation for Beginners: XML, JSON & YAML Explained',
    channel: 'IT Boost by Formip',
    url: 'https://www.youtube.com/watch?v=dx4jItJQRPM',
  },
  // Lesson 38: REST itself (what an API is, the verbs and CRUD, status codes); the lesson carries RESTCONF and YANG.
  'ccna3-38-talking-to-devices-through-apis': {
    youtubeId: '-mN3VyJuCjM',
    title: 'What Is REST API? Examples And How To Use It: Crash Course System Design #3',
    channel: 'ByteByteGo',
    url: 'https://www.youtube.com/watch?v=-mN3VyJuCjM',
  },
  // Lesson 39 is theory-only ([C22] not approved): playbooks, automation use cases and source control, the lesson's
  // pieces, from a vendor-neutral certification course that names no tool in its title.
  'ccna3-39-configuration-as-code': {
    youtubeId: 'n6jIaKWixF4',
    title: 'Infrastructure as Code - CompTIA Network+ N10-009 - 1.8',
    channel: 'Professor Messer',
    url: 'https://www.youtube.com/watch?v=n6jIaKWixF4',
  },
  // Lesson 40: a Python script that calls a web API and reads its JSON as dictionaries; the lesson's script and lab
  // call a device's RESTCONF API the same way.
  'ccna3-40-scripting-the-network': {
    youtubeId: 'hpc5jyVpUpw',
    title: 'Working with APIs in Python - Code in 10 Minutes',
    channel: 'VideoLab',
    url: 'https://www.youtube.com/watch?v=hpc5jyVpUpw',
  },
};
