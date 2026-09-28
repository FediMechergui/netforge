/**
 * curriculum/ccna2/videos.ts — one verified video per CCNA 2 lesson, keyed by lesson id.
 *
 * Same rule as `curriculum/ccna1/videos.ts` (ARCHITECTURE-P2 §11.3), and the header there explains why each step
 * exists. Candidates came from a web search and from YouTube's own results page; none of the ids below was typed
 * from memory. Every entry was then checked by hand, on the date written above the map, with three calls:
 *
 *   curl -s "https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=<id>&format=json"
 *   curl -s -A "Mozilla/5.0" "https://www.youtube.com/watch?v=<id>" | grep -o '"playableInEmbed":[a-z]*'
 *   curl -s "https://sponsor.ajay.app/api/skipSegments?videoID=<id>&categories=%5B%22sponsor%22%2C%22selfpromo%22%5D"
 *
 * The first must answer 200 with JSON, and its `title` and `author_name` are copied below exactly as returned —
 * including the trailing space in one channel name — so a reviewer can re-run it and diff. The second must print
 * `"playableInEmbed":true`. The third asks the community skip list for sponsor and self-promotion segments: 404
 * means none is on record. That list only knows what viewers have marked, so the watch page's description and
 * chapter list were read as well, as in CCNA 1. Links to a course or a donation page in a description are not a
 * read; a spoken advert is, and one anywhere near the start disqualifies the video.
 *
 * What was turned away, so nobody re-proposes it: three videos with a marked sponsor or self-promotion segment in
 * their first minute and a half, and one with a paid read later on; every candidate whose title or channel names a
 * vendor (most videos on trunk negotiation, voice VLANs, port security and address translation are captioned that
 * way); one whose description says it was generated from a textbook chapter; and a run of numbered uploads ("114 …",
 * "115 …") scattered over unrelated channels, which look like pieces of a paid course posted by someone else.
 *
 * Scope: every lesson, 01-34. The non-wireless lessons 01-24 and 29-34 were checked in W6; the wireless lessons 25-28
 * were checked in W7 with the same three calls, on the date written above their block. Wireless candidates add their
 * own traps: most controller and WLAN videos name the controller's maker or a vendor simulator in the title; two runs
 * of short uploads with no description, or with the exact titles of a course's own videos, looked like pieces of a
 * paid course posted by someone else; one CAPWAP video linked to an exam-answers site; and a well-known complete
 * course runs its WLAN configuration episode for 46 minutes, over the cap, and opens its lab episode with a
 * four-minute introduction. All of them were turned away.
 *
 * Length: the shortest video runs 3:55 and the longest 37:38 (lesson 27, a full walk-through of the lab's task in
 * another simulator; its chapters let a learner skip the switch and router set-up of its first 18 minutes). Each
 * lesson's minutes cover its video plus its theory read at 238 words a minute, and none passes the 45-minute cap of
 * §11.1 (pinned by `curriculum.ccna2.accuracy.test.ts` for the lessons measured in W6 and by `curriculum.test.ts` for
 * 25-28).
 *
 * The titles are UI text — the lesson view shows one as the caption and gives it to the player as its accessible
 * name — so the no-vendor rule reaches them, and a title that names a vendor disqualifies the video rather than
 * being edited. `curriculum.ccna2.videos.test.ts` enforces that, with no network in the test.
 */
import type { LessonVideoMap } from '../../contracts/curriculum.js';

/** Checked on 2026-09-27 (lessons 01-24 and 29-34) and 2026-09-28 (lessons 25-28): every entry answered oEmbed 200
 * with the title and channel recorded below, reported `playableInEmbed` true on its watch page, had no sponsor or
 * self-promotion segment on record, and carried no sponsor read in its description or chapters. 34 of the 34 lessons
 * have one. */
export const CCNA2_VIDEOS: LessonVideoMap = {
  'ccna2-01-how-a-switch-forwards': {
    youtubeId: 'sdYDLip2ANI',
    title: 'How a Switch Forwards and Builds the MAC Address Table',
    channel: 'danscourses',
    url: 'https://www.youtube.com/watch?v=sdYDLip2ANI',
  },
  'ccna2-02-managing-a-switch': {
    youtubeId: 'EOhZvNUL6EE',
    title: 'Management VLAN Explained | Switch Management Best Practices | CCNA 200-301',
    channel: 'Sikandar Shaik CCIEx3 ',
    url: 'https://www.youtube.com/watch?v=EOhZvNUL6EE',
  },
  'ccna2-03-speed-duplex-and-cabling': {
    youtubeId: 'mwVX62wx6jo',
    title: 'Why Speed & Duplex Mismatch Breaks Networks! | Auto-Negotiation Explained | Free CCNA 200-301 course',
    channel: 'NETWORKING WITH H',
    url: 'https://www.youtube.com/watch?v=mwVX62wx6jo',
  },
  'ccna2-04-why-split-a-lan': {
    youtubeId: 'jC6MJTh9fRE',
    title: 'VLAN Explained',
    channel: 'PowerCert Animated Videos',
    url: 'https://www.youtube.com/watch?v=jC6MJTh9fRE',
  },
  // Lesson 05 practises VLANs and access ports in its lab; the video covers the part it cannot, the VTP modes and
  // the revision number, which stay theory-only in NetForge (§11.4).
  'ccna2-05-access-ports-and-the-vlan-list': {
    youtubeId: '59LIOPaaQVA',
    title: 'VLAN Trunking Protocol (VTP)',
    channel: 'Sunny Classroom',
    url: 'https://www.youtube.com/watch?v=59LIOPaaQVA',
  },
  'ccna2-06-trunks-and-tags': {
    youtubeId: '8Ccuxf3ZKm4',
    title: 'Native VLAN and Limiting VLANs on Trunks',
    channel: 'Rick Graziani',
    url: 'https://www.youtube.com/watch?v=8Ccuxf3ZKm4',
  },
  'ccna2-07-trunk-negotiation': {
    youtubeId: 'a703v4g-w50',
    title: 'dynamic auto vs dynamic desirable',
    channel: 'Ethernet Soundoff',
    url: 'https://www.youtube.com/watch?v=a703v4g-w50',
  },
  'ccna2-08-voice-vlans': {
    youtubeId: 'MlKL5JuQ2uE',
    title: 'FREE CCNA 200-301 | 25.Voice VLAN',
    channel: 'ABY Design and Tech',
    url: 'https://www.youtube.com/watch?v=MlKL5JuQ2uE',
  },
  'ccna2-09-router-on-a-stick': {
    youtubeId: 'NmkFzDrZsXM',
    title: 'InterVLAN Routing: 3 options',
    channel: 'Sunny Classroom',
    url: 'https://www.youtube.com/watch?v=NmkFzDrZsXM',
  },
  'ccna2-10-multilayer-switching': {
    youtubeId: 'UjPLa3jvXLY',
    title: 'SVI Inter-VLAN Routing on Layer 3 Switch | Switched Virtual Interface | CCNA 200-301',
    channel: 'Sikandar Shaik CCIEx3 ',
    url: 'https://www.youtube.com/watch?v=UjPLa3jvXLY',
  },
  'ccna2-11-fixing-inter-vlan-routing': {
    youtubeId: '7PcsQuHsqWA',
    title: 'Troubleshooting Inter VLAN Routing Part ONE',
    channel: 'Greg South',
    url: 'https://www.youtube.com/watch?v=7PcsQuHsqWA',
  },
  'ccna2-12-what-a-loop-does': {
    youtubeId: 'liRdZ5p1Xp4',
    title: 'What are Switching Loops?',
    channel: 'ACI Learning',
    url: 'https://www.youtube.com/watch?v=liRdZ5p1Xp4',
  },
  'ccna2-13-electing-a-root': {
    youtubeId: 'BkGEwrzIK4g',
    title: 'How STP Elects Root Bridge with Hello BPDU?',
    channel: 'Sunny Classroom',
    url: 'https://www.youtube.com/watch?v=BkGEwrzIK4g',
  },
  'ccna2-14-port-roles-states-and-timers': {
    youtubeId: 'dJsXKHbjzYw',
    title: 'Spanning Tree Protocol (IEEE 802.1D): STP Port Roles and States | STP Tutorial (Part 3)',
    channel: 'COMNET Protocols',
    url: 'https://www.youtube.com/watch?v=dJsXKHbjzYw',
  },
  'ccna2-15-rapid-spanning-tree': {
    youtubeId: 'N_gBudULCu0',
    title: 'Rapid Spanning Tree Protocol (IEEE802.1W)',
    channel: 'Sunny Classroom',
    url: 'https://www.youtube.com/watch?v=N_gBudULCu0',
  },
  'ccna2-16-edge-ports-and-guards': {
    youtubeId: 'V10HIvEgDJQ',
    title: 'Free CCNA 200-301 Course 25-11: Portfast, BPDU Guard and Root Guard',
    channel: 'Flackbox',
    url: 'https://www.youtube.com/watch?v=V10HIvEgDJQ',
  },
  'ccna2-17-bundling-links': {
    youtubeId: 'j6-kadxwIFQ',
    title: 'EtherChannel Explained | Concept & Configuration',
    channel: 'CertBros',
    url: 'https://www.youtube.com/watch?v=j6-kadxwIFQ',
  },
  'ccna2-18-dhcp-across-vlans': {
    youtubeId: 'IbPj58Q8AEA',
    title: 'DHCP Relay Agent || IP Helper Address || DHCP 7',
    channel: 'Physical Logik',
    url: 'https://www.youtube.com/watch?v=IbPj58Q8AEA',
  },
  'ccna2-19-slaac-and-dhcpv6': {
    youtubeId: '6g_DEcwNgp0',
    title: 'IPv6 - How DHCPv6 works?',
    channel: 'Sunny Classroom',
    url: 'https://www.youtube.com/watch?v=6g_DEcwNgp0',
  },
  'ccna2-20-one-gateway-one-point-of-failure': {
    youtubeId: 'diULMkbm1tQ',
    title: 'Introducing FHRP',
    channel: 'Rick Graziani',
    url: 'https://www.youtube.com/watch?v=diULMkbm1tQ',
  },
  'ccna2-21-hot-standby-gateways': {
    youtubeId: 'kxhdPI1jh6I',
    title: 'MicroNugget: How to Use "HSRP" for High Availability',
    channel: 'CBT Nuggets',
    url: 'https://www.youtube.com/watch?v=kxhdPI1jh6I',
  },
  'ccna2-22-threats-at-layer-2': {
    youtubeId: 'jYpxJPUQJDQ',
    title: 'Switch Attacks Explained: MAC Flooding, ARP Spoofing, VLAN Hopping & More',
    channel: 'Cyber connect',
    url: 'https://www.youtube.com/watch?v=jYpxJPUQJDQ',
  },
  'ccna2-23-port-security': {
    youtubeId: 'WfcJMc-z7NI',
    title: 'Port SECURITY On a Switch?',
    channel: 'Ace Networker',
    url: 'https://www.youtube.com/watch?v=WfcJMc-z7NI',
  },
  // Lesson 24's three habits (unused ports shut, native VLAN moved off VLAN 1, trunk negotiation off) are the
  // defences against the two ways of hopping VLANs, which is how this video teaches them.
  'ccna2-24-hardening-switch-ports': {
    youtubeId: 'a6yVV6dD6F0',
    title: 'CCNA LANs 11-4: VLAN Hopping',
    channel: 'TechKnowSurge',
    url: 'https://www.youtube.com/watch?v=a6yVV6dD6F0',
  },
  // Lessons 25-28 (wireless at scale), checked on 2026-09-28 with the same three calls: oEmbed 200 with the title and
  // channel below, `playableInEmbed` true, no sponsor or self-promotion segment on record (404), and no sponsor read in
  // the description or chapters. Lengths from the watch page (`lengthSeconds`): 887, 558, 2258 and 654 s.
  // Lesson 25: the chapters run through controllers, joining and management, roaming, CAPWAP and split MAC, traffic
  // flow and local switching, which is the lesson's outcome plus the roaming theory NetForge does not build (§11.4).
  'ccna2-25-controllers-and-lightweight-aps': {
    youtubeId: 'ttdjSSmfLDI',
    title: 'Free CCNA 200-301 Course 37-04: Wireless LAN Controllers and CAPWAP',
    channel: 'Flackbox',
    url: 'https://www.youtube.com/watch?v=ttdjSSmfLDI',
  },
  // Lesson 26: why a channel is a range of frequencies, channel widths, then the non-overlapping channels; the lesson
  // adds the 6 GHz band, which the video does not reach.
  'ccna2-26-channels-and-overlap': {
    youtubeId: 'uZyrJTfetNg',
    title: 'Wi-Fi Channels Explained: 2.4GHz, 5GHz & Overlap | CCNA Prep',
    channel: 'CBT Nuggets',
    url: 'https://www.youtube.com/watch?v=uZyrJTfetNg',
  },
  // Lesson 27: the lab's own task in another simulator: management and client VLANs, one controller interface per
  // VLAN, WLANs mapped to them, a lightweight access point, and a laptop joining each WLAN.
  'ccna2-27-wlans-on-a-controller': {
    youtubeId: 'XJaw7PkzEvA',
    title: 'WLAN Configuration with VLANs using Wireless LAN Controller and Lightweight Access Point | Lab 46',
    channel: 'Tech Acad',
    url: 'https://www.youtube.com/watch?v=XJaw7PkzEvA',
  },
  // Lesson 28: the encryption generations, then personal and enterprise authentication with 802.1X, EAP and RADIUS;
  // a certification-course title, like the CCNA 1 entries of the same channel.
  'ccna2-28-securing-a-wlan': {
    youtubeId: 'KaqKoKNEKnE',
    title: 'Wireless Security Settings - CompTIA Security+ SY0-701 - 4.1',
    channel: 'Professor Messer',
    url: 'https://www.youtube.com/watch?v=KaqKoKNEKnE',
  },
  'ccna2-29-how-a-router-chooses': {
    youtubeId: 'PDcwijVC4XE',
    title: 'Route Precedence -- How does a Router choose a path when multiple paths exist?',
    channel: 'Practical Networking',
    url: 'https://www.youtube.com/watch?v=PDcwijVC4XE',
  },
  'ccna2-30-static-route-forms': {
    youtubeId: 'x0W0BPB-eBo',
    title: '6.1.a. Routing - Configuring Directly Attached, Recursive and Fully Specified Static Routes Example',
    channel: 'Quecca Tech',
    url: 'https://www.youtube.com/watch?v=x0W0BPB-eBo',
  },
  'ccna2-31-default-and-floating-routes': {
    youtubeId: 'jEd5PnhpCKA',
    title: 'Floating Static Routes',
    channel: 'Kevin Wallace Training, LLC',
    url: 'https://www.youtube.com/watch?v=jEd5PnhpCKA',
  },
  'ccna2-32-ipv6-static-routes': {
    youtubeId: 'DqhniICh3kc',
    title: 'IPv6 Link-Local Next Hop',
    channel: 'StormWind Studios',
    url: 'https://www.youtube.com/watch?v=DqhniICh3kc',
  },
  'ccna2-33-address-translation': {
    youtubeId: 'KA56kj23RPU',
    title: 'NAT vs PAT, Static vs Dynamic -- demystified! -- Network Address Translation',
    channel: 'Practical Networking',
    url: 'https://www.youtube.com/watch?v=KA56kj23RPU',
  },
  'ccna2-34-finding-faults': {
    youtubeId: 'PYX-JKUSPC0',
    title: 'How to Troubleshoot a real Network problem using the OSI model',
    channel: 'MysterySystems',
    url: 'https://www.youtube.com/watch?v=PYX-JKUSPC0',
  },
};
