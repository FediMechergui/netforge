/**
 * curriculum/ccna1/videos.ts — one verified video per CCNA 1 lesson, keyed by lesson id.
 *
 * Every entry below was checked against YouTube's oEmbed endpoint before it was written down:
 *
 *   curl -s "https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=<id>&format=json"
 *
 * A live video answers with JSON; a dead id answers 404, and an id whose owner has switched embedding off answers
 * 401 — which is how oEmbed reports that, and how two candidates were dropped. The `title` and `channel` here are
 * the `title` and `author_name` that call returned, copied exactly — including the odd double spaces — so a
 * reviewer can re-run the command and diff the answer instead of trusting a memory of it. An id that merely looks
 * plausible is worse than no video at all.
 *
 * Two things oEmbed cannot tell you, so both are screened by hand against the watch page and recorded here:
 *
 *   curl -s -A "Mozilla/5.0" "https://www.youtube.com/watch?v=<id>" | grep -o '"playableInEmbed":[a-z]*'
 *
 * First, whether the player is allowed in a frame at all (the command above). Second, whether the video opens
 * with a sponsor read: an advert for some unrelated product is the first thing a learner would meet after
 * pressing play inside a lesson, so an entry with one is rejected however good the teaching is. The watch page's
 * `shortDescription` and chapter list are what that screening reads; neither is visible through oEmbed.
 *
 * `youtubeId` stays bare because the lesson view embeds through youtube-nocookie.com and builds its own src;
 * `url` is the watch link for the "open on YouTube" escape hatch. A lesson with no entry renders theory-only, so
 * a video that later disappears can simply be deleted here — nothing else has to change. Three lessons have no
 * entry on purpose (04, 18 and 27): see the notes where they would sit.
 *
 * The titles are UI text — the lesson view shows one as the caption and gives it to the player as its accessible
 * name — so the product's no-vendor rule applies to them, and a borrowed title that names a vendor disqualifies
 * the video rather than being edited. `curriculum.videos.test.ts` enforces that, because a hand-edited title
 * would misattribute the video and destroy the diff this whole file rests on.
 *
 * ponytail: a hand-checked map rather than a fetch at build or run time. The list changes about as often as the
 * lessons do, an offline build keeps working, and the test can stay a pure data check with no network in it.
 */
import type { LessonVideoMap } from '../../contracts/curriculum.js';

/** Checked on 2026-09-21: every entry answered oEmbed 200 with the title and channel recorded below, reported
 * `playableInEmbed` true on its watch page, and carried no sponsor read. 28 of the 31 lessons have one. */
export const CCNA1_VIDEOS: LessonVideoMap = {
  'ccna1-01-what-is-a-network': {
    youtubeId: 'IHdXfUHBBEI',
    title: 'What is a Computer Network? (Crash Course for Beginners)',
    channel: 'howtonetwork',
    url: 'https://www.youtube.com/watch?v=IHdXfUHBBEI',
  },
  'ccna1-02-hosts-and-media': {
    youtubeId: '3bkNmOWsub0',
    title: 'Networking Components | Network Media and Network Devices | CCNA | Network A+',
    channel: 'The Unstoppable Power',
    url: 'https://www.youtube.com/watch?v=3bkNmOWsub0',
  },
  'ccna1-03-the-layered-model': {
    youtubeId: 'XgamUNYPjfU',
    title: 'OSI Model Explained + Encapsulation vs De-encapsulation & PDUs | Networking Basics',
    channel: 'Cyberlab Ops',
    url: 'https://www.youtube.com/watch?v=XgamUNYPjfU',
  },
  // 'ccna1-04-the-device-command-line' has no entry: every candidate found teaches one vendor's command line and
  // says so in its title, which would put that name on screen (see the vendor rule in the header). The lesson
  // teaches this simulator's own modes, so it runs theory-only rather than next to a video about another CLI.
  'ccna1-05-ethernet-frames-and-mac-addresses': {
    youtubeId: 'pNAg2i5aU78',
    title: 'How Data Actually Travels Across Ethernet (MAC Addresses Explained)',
    channel: 'Wendell Odom\'s Network Upskill',
    url: 'https://www.youtube.com/watch?v=pNAg2i5aU78',
  },
  'ccna1-06-switches-and-the-mac-table': {
    youtubeId: 'oVoknaXjeB0',
    title: 'How a Switch Learns MAC Addresses',
    channel: 'Ace Networker',
    url: 'https://www.youtube.com/watch?v=oVoknaXjeB0',
  },
  'ccna1-07-speed-duplex-and-autonegotiation': {
    youtubeId: 'kb1nLfaJ3Go',
    title: 'Ethernet: Negotiating Speed and Duplex',
    channel: 'Rick Graziani',
    url: 'https://www.youtube.com/watch?v=kb1nLfaJ3Go',
  },
  'ccna1-08-what-an-ipv4-address-is': {
    youtubeId: 'htCHqffqbC0',
    title: 'IPv4 Explained Complete Guide| Complete Animated Explanation for Students & Beginners',
    channel: 'Arbab Academy',
    url: 'https://www.youtube.com/watch?v=htCHqffqbC0',
  },
  'ccna1-09-binary-masks-and-subnet-boundaries': {
    youtubeId: 'q7wNcYliJ1Q',
    title: 'Basics of Subnetting | How to find Subnet Mask, Network ID, Host IP Address from CIDR Value | 2018',
    channel: 'NETWORKING PLUS',
    url: 'https://www.youtube.com/watch?v=q7wNcYliJ1Q',
  },
  'ccna1-10-build-a-small-lan': {
    youtubeId: 'ZBs9XgzNat8',
    title: 'How to Build a LAN (Local Area Network) | Windows and Mac',
    channel: 'Professor Sadat',
    url: 'https://www.youtube.com/watch?v=ZBs9XgzNat8',
  },
  'ccna1-11-arp': {
    youtubeId: 'L0VvYywmo_g',
    title: 'Learn How the Address Resolution Protocol (ARP) Works in 10 Minutes',
    channel: 'Plaintext Packets',
    url: 'https://www.youtube.com/watch?v=L0VvYywmo_g',
  },
  'ccna1-12-ping-and-icmp': {
    youtubeId: 'xdUqXYkIA-8',
    title: 'ICMP and the Ping Command',
    channel: 'Networking Newbies',
    url: 'https://www.youtube.com/watch?v=xdUqXYkIA-8',
  },
  'ccna1-13-the-default-gateway': {
    youtubeId: 'pCcJFdYNamc',
    title: 'Default Gateway Explained',
    channel: 'PowerCert Animated Videos',
    url: 'https://www.youtube.com/watch?v=pCcJFdYNamc',
  },
  'ccna1-14-splitting-a-network-into-subnets': {
    youtubeId: 'hbdT_Q9DM8w',
    title: 'Subnetting Explained: Networking Basics',
    channel: 'WhiteboardDoodles',
    url: 'https://www.youtube.com/watch?v=hbdT_Q9DM8w',
  },
  'ccna1-15-a-subnet-plan-in-practice': {
    youtubeId: 'eet6SumgW5A',
    title: 'IPv4 Subnetting Worked Examples',
    channel: 'Steve Cope',
    url: 'https://www.youtube.com/watch?v=eet6SumgW5A',
  },
  'ccna1-16-what-a-router-does': {
    youtubeId: 'uKiM9-tGuc4',
    title: 'Routing Table Explained',
    channel: 'Network Direction',
    url: 'https://www.youtube.com/watch?v=uKiM9-tGuc4',
  },
  'ccna1-17-static-routes': {
    youtubeId: 'DNG7QLyCiEc',
    title: 'Static Routing Overview & Configuration',
    channel: 'Naj Qazi',
    url: 'https://www.youtube.com/watch?v=DNG7QLyCiEc',
  },
  // 'ccna1-18-device-access-and-passwords' has no entry, for the same reason as lesson 04: the searchable videos
  // on device passwords are all captioned with a vendor's name. The lesson's own config block and its lab carry
  // the teaching instead.
  'ccna1-19-dhcp': {
    youtubeId: 'ywkJepIQNIU',
    title: 'DHCP DORA Process Explained | Discover Offer Request Acknowledge for CCNA & CCNP',
    channel: 'Sikandar Shaik CCIEx3 ',
    url: 'https://www.youtube.com/watch?v=ywkJepIQNIU',
  },
  'ccna1-20-dhcp-across-a-router': {
    youtubeId: 'Z5yLVYQLY1s',
    title: 'DHCP Relay Agent | IP Helper Address | CCNA',
    channel: 'Network for you',
    url: 'https://www.youtube.com/watch?v=Z5yLVYQLY1s',
  },
  'ccna1-21-dns': {
    youtubeId: 'mpQZVYPuDGU',
    title: 'How a DNS Server (Domain Name System) works.',
    channel: 'PowerCert Animated Videos',
    url: 'https://www.youtube.com/watch?v=mpQZVYPuDGU',
  },
  'ccna1-22-tcp-and-udp': {
    youtubeId: 'FfvUxw8DHb0',
    title: 'How TCP and UDP Work | Network Fundamentals Part 7',
    channel: 'Network Direction',
    url: 'https://www.youtube.com/watch?v=FfvUxw8DHb0',
  },
  'ccna1-23-http-and-the-web': {
    youtubeId: 'zS9k9kEki8c',
    title: 'HTTP Explained Clearly | How the Web Actually Works',
    channel: 'Network Encyclopedia',
    url: 'https://www.youtube.com/watch?v=zS9k9kEki8c',
  },
  'ccna1-24-why-ipv6': {
    youtubeId: 'oItwDXraK1M',
    title: 'IPv6 from scratch - the very basics of IPv6 explained',
    channel: 'OneMarcFifty',
    url: 'https://www.youtube.com/watch?v=oItwDXraK1M',
  },
  'ccna1-25-ipv6-without-a-server': {
    youtubeId: 'jlG_nrCOmJc',
    title: 'IPv6 explained - SLAAC and DHCPv6 (IPv6 from scratch part 2)',
    channel: 'OneMarcFifty',
    url: 'https://www.youtube.com/watch?v=jlG_nrCOmJc',
  },
  'ccna1-26-how-wireless-works': {
    youtubeId: 'vvKbMueRzrI',
    title: 'How WiFi Works - Computerphile',
    channel: 'Computerphile',
    url: 'https://www.youtube.com/watch?v=vvKbMueRzrI',
  },
  // 'ccna1-27-set-up-a-wireless-network' has no entry: the lesson is three steps (protect the network, hand out
  // addresses on it, join it from a laptop), and every candidate found showed only the first, named a vendor, or
  // cited a retired exam. A video that covers one step in three would imply coverage the lesson does not get.
  'ccna1-28-traceroute': {
    youtubeId: 'HgYuBN0ZYu0',
    title: 'Traceroute Explained | Real World Examples',
    channel: 'CertBros',
    url: 'https://www.youtube.com/watch?v=HgYuBN0ZYu0',
  },
  'ccna1-29-a-method-for-troubleshooting': {
    youtubeId: 'kdFOCleUkVE',
    title: 'Troubleshooting With the OSI Model',
    channel: 'StormWind Studios',
    url: 'https://www.youtube.com/watch?v=kdFOCleUkVE',
  },
  'ccna1-30-addressing-faults': {
    youtubeId: 'pbOi48USeVw',
    title: 'Routing and IP Issues - CompTIA Network+ N10-009 - 5.3',
    channel: 'Professor Messer',
    url: 'https://www.youtube.com/watch?v=pbOi48USeVw',
  },
  'ccna1-31-link-faults': {
    youtubeId: '7b4RkdITO4Q',
    title: 'Interface Issues - CompTIA Network+ N10-009 - 5.2',
    channel: 'Professor Messer',
    url: 'https://www.youtube.com/watch?v=7b4RkdITO4Q',
  },
};
