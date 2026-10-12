/**
 * The CCNA 3 twin of curriculum.ccna2.videos.test.ts (ARCHITECTURE-P3 §11.3): every video must be reachable — keyed
 * by a CCNA 3 lesson that exists, with an id of YouTube's shape and a watch url that agrees with it — must put no
 * vendor, controller product or vendor certification name on screen, must not repeat a video any course already
 * shows, and must fit its lesson's minutes together with the lesson's theory.
 *
 * That each id is a live, embeddable video with no sponsor read was proved with the calls written in the header of
 * ccna3/videos.ts before the entries were written. This file deliberately does not re-run them: a test that needs the
 * network would fail offline and would make the suite depend on YouTube staying up. The lengths below are the watch
 * pages' `lengthSeconds` from the same check, so the minutes rule can be held without the network.
 *
 * No minimum coverage is asserted: §11.3 lets a lesson with no verified video run theory-only.
 *
 * The last block pins what the W6a review corrected in the theory-c.ts bodies that the videos are read beside (the
 * commands those bodies print are parsed by curriculum.ccna3.commands.test.ts; this block pins the facts).
 */
import { describe, expect, it } from 'vitest';
import { lessonsOf } from '../src/contracts/curriculum.js';
import { IPSEC_OVERHEAD } from '../src/contracts/pdu.js';
import { QOS_ADMISSION_PERCENT } from '../src/link/qos/scheduler.js';
import { ccna3QosVoiceFirst } from '../src/sim/scenarios/ccna3/qos.js';
import { courseById, withContent } from '../src/curriculum/index.js';
import { CCNA1_VIDEOS } from '../src/curriculum/ccna1/videos.js';
import { CCNA2_VIDEOS } from '../src/curriculum/ccna2/videos.js';
import { CCNA3_MODULES } from '../src/curriculum/ccna3/lessons.js';
import { CCNA3_THEORY_C } from '../src/curriculum/ccna3/theory-c.js';
import { CCNA3_VIDEOS } from '../src/curriculum/ccna3/videos.js';

/** A YouTube video id: eleven characters of the URL-safe alphabet, nothing else. */
const YOUTUBE_ID = /^[A-Za-z0-9_-]{11}$/;

/**
 * The guard of the CCNA 3 skeleton (curriculum.ccna3.test.ts: vendors, controller products, vendor certifications,
 * vendor tools), the CCNA 2 videos' `mikrotik`, and the platform and cloud vendors a virtualisation or cloud video
 * would name. The video rule (§11.3) reads it on the title and the channel, both shown on screen.
 */
const VENDORS =
  /\b(?:cisco|ios|ios-xe|nx-os|packet\s*tracer|netacad|juniper|junos|huawei|catalyst|meraki|aruba|nexus|ansible|netflow|dna\s*center|apic|sd-access|devnet|ccna|ccnp|ccie(?:x\d+)?|wireshark|mikrotik|vmware|esxi|vsphere|hyper-v|azure|aws|amazon|google|microsoft|ibm|fortinet|fortigate|palo\s*alto|pfsense|ubiquiti|unifi|arista)\b/i;

/** Reading speed the lesson minutes are planned at (§11.3, curriculum.ccna2.accuracy.test.ts). */
const WPM = 238;
/**
 * Words a lesson body may take when it is not in this file's reach (theory-a and theory-b are other owners' files):
 * the 500-word ceiling of a body (the CCNA 2 bodies' rule) plus room for punctuation-only tokens.
 */
const MAX_BODY_WORDS = 540;

/**
 * Each video's length in seconds, from its watch page (`lengthSeconds`) when the entries were checked on 2026-10-12.
 * A new entry needs its measured length here, and a replaced video its new one.
 */
const MEASURED: Readonly<Record<string, { readonly youtubeId: string; readonly seconds: number }>> = {
  'ccna3-01-why-routers-share-routes': { youtubeId: 'htweWjG8Ny4', seconds: 402 },
  'ccna3-02-how-ospf-maps-a-network': { youtubeId: '_ThYOX1wX_4', seconds: 754 },
  'ccna3-03-neighbours-and-the-designated-router': { youtubeId: 'gPt64UE3x6o', seconds: 497 },
  'ccna3-04-switching-ospf-on': { youtubeId: 'dOks3EUiVIE', seconds: 687 },
  'ccna3-05-cost-and-the-best-path': { youtubeId: '6aZy29Tfz6s', seconds: 391 },
  'ccna3-06-default-routes-and-timers': { youtubeId: 'VL3m7QRTfFs', seconds: 545 },
  'ccna3-07-fixing-ospf': { youtubeId: 'cmAD1h1ySwQ', seconds: 709 },
  'ccna3-08-more-than-one-area': { youtubeId: 'CM9BlFHB3q4', seconds: 503 },
  'ccna3-09-ospf-for-ipv6': { youtubeId: 'XeNCyPG9yQs', seconds: 323 },
  'ccna3-10-eigrp-and-its-metric': { youtubeId: 'TOzB1qIjxKI', seconds: 378 },
  'ccna3-11-the-language-of-security': { youtubeId: 'AngQoKJ18BA', seconds: 436 },
  'ccna3-12-how-attacks-unfold': { youtubeId: 'S8MoTiexPHg', seconds: 485 },
  'ccna3-13-layers-of-defence': { youtubeId: 'IiWFMIgKaqQ', seconds: 319 },
  'ccna3-14-how-an-acl-decides': { youtubeId: 'fHyNZpnc_PY', seconds: 372 },
  'ccna3-15-standard-acls': { youtubeId: 'FV8pQfbMODs', seconds: 612 },
  'ccna3-16-extended-acls': { youtubeId: 'IwW9htwr3Tc', seconds: 794 },
  'ccna3-17-editing-and-reading-acls': { youtubeId: '7JdsrLW5Tvw', seconds: 299 },
  'ccna3-18-translation-at-the-edge': { youtubeId: 'EhCzKyojkNs', seconds: 425 },
  'ccna3-19-locking-down-device-access': { youtubeId: 'tZop-zjYkrU', seconds: 300 },
  'ccna3-20-guarding-the-access-layer': { youtubeId: '8KDocvwoRW8', seconds: 524 },
  'ccna3-21-joining-distant-sites': { youtubeId: 'TAIMfKLbZIg', seconds: 582 },
  'ccna3-22-point-to-point-links': { youtubeId: '5-kVix07PeI', seconds: 379 },
  'ccna3-23-private-paths-over-public-networks': { youtubeId: 'BCrRfyigvYE', seconds: 517 },
  'ccna3-24-gre-tunnels': { youtubeId: 'ytAqv7qHGyU', seconds: 440 },
  'ccna3-25-site-to-site-ipsec': { youtubeId: 'XwkkgJuugRU', seconds: 394 },
  'ccna3-26-why-traffic-needs-priority': { youtubeId: 'BZFMKvvRkeY', seconds: 681 },
  'ccna3-27-marking-queuing-and-policing': { youtubeId: 'ii7SxMSms80', seconds: 445 },
  'ccna3-28-who-is-next-door': { youtubeId: 'e7fINxRrtTg', seconds: 532 },
  'ccna3-29-time-and-logs': { youtubeId: 'BAo5C2qbLq8', seconds: 640 },
  'ccna3-30-watching-the-network': { youtubeId: 'vWZefoGNk5g', seconds: 658 },
  'ccna3-31-looking-after-files-and-images': { youtubeId: 'pdMVoeGS6eY', seconds: 229 },
  'ccna3-32-designing-networks-that-grow': { youtubeId: 'Xudj2So6XF4', seconds: 312 },
  'ccna3-33-a-method-for-enterprise-faults': { youtubeId: 'dovuPm3dGhc', seconds: 483 },
  'ccna3-34-finding-faults-across-layers': { youtubeId: 'D8i6WcV0Tsg', seconds: 518 },
  'ccna3-35-clouds-and-virtual-machines': { youtubeId: 'wB6Lfdo2m1Q', seconds: 570 },
  'ccna3-36-software-defined-networking': { youtubeId: 'wSMKEKh17Bw', seconds: 258 },
};

const LESSONS = CCNA3_MODULES.flatMap((m) => m.lessons);
const LESSON_IDS = LESSONS.map((l) => l.id);
const ENTRIES = Object.entries(CCNA3_VIDEOS);

/** Words as the lesson-minute rule counts them (curriculum.ccna2.accuracy.test.ts). */
const words = (text: string): number => text.split(/\s+/).filter((w) => w.length > 0).length;

describe('ccna3 videos', () => {
  it('keys every video by a CCNA 3 lesson that exists', () => {
    const known = new Set(LESSON_IDS);
    const orphans = ENTRIES.map(([id]) => id).filter((id) => !known.has(id));
    expect(orphans, `video keyed by a lesson that does not exist: ${orphans.join(', ')}`).toEqual([]);
    expect(ENTRIES.length).toBeLessThanOrEqual(LESSON_IDS.length);
  });

  it('gives every entry a well-formed id, title and channel', () => {
    for (const [lessonId, video] of ENTRIES) {
      expect(video.youtubeId, `${lessonId} has a malformed video id`).toMatch(YOUTUBE_ID);
      expect(video.title.trim().length, `${lessonId} has no video title`).toBeGreaterThan(0);
      expect(video.channel.trim().length, `${lessonId} has no channel`).toBeGreaterThan(0);
    }
  });

  it('points the watch url at the embedded id', () => {
    for (const [lessonId, video] of ENTRIES) {
      expect(video.url, `${lessonId} watch url disagrees with its id`).toBe(`https://www.youtube.com/watch?v=${video.youtubeId}`);
    }
  });

  // `title` is the caption and the player's accessible name, and `channel` is credited beside it, so both are
  // product text. They are verbatim oEmbed values and cannot be edited to comply: a video whose title or channel
  // names a vendor, a controller product or a vendor certification is not usable, and its lesson runs theory-only.
  it('puts no vendor, product or certification name on screen', () => {
    const named = ENTRIES.filter(([, v]) => VENDORS.test(v.title) || VENDORS.test(v.channel)).map(([lessonId, v]) => `${lessonId} :: ${v.title} :: ${v.channel}`);
    expect(named, `video text naming a vendor:\n${named.join('\n')}`).toEqual([]);
  });

  it('applies the guard to the names it must refuse', () => {
    for (const bad of ['Free CCNA | OSPF Part 1', 'Configure SSH on a Cisco router', 'Packet Tracer lab', 'Sikandar Shaik CCIEx3', 'AWS VPC basics']) {
      expect(VENDORS.test(bad), bad).toBe(true);
    }
    for (const ok of ['How GRE Tunnels Work | VPN Tunnels Part 1', 'Network Troubleshooting Methodology - CompTIA Network+ N10-009 - 5.1', 'IaaS PaaS  SaaS: 3 cloud computing service models']) {
      expect(VENDORS.test(ok), ok).toBe(false);
    }
  });

  it('never shows the same video twice, within CCNA 3 or across CCNA 1, 2 and 3', () => {
    const owners = new Map<string, string[]>();
    for (const [lessonId, video] of [...Object.entries(CCNA1_VIDEOS), ...Object.entries(CCNA2_VIDEOS), ...ENTRIES]) {
      owners.set(video.youtubeId, [...(owners.get(video.youtubeId) ?? []), lessonId]);
    }
    const repeated = [...owners].filter(([, lessons]) => lessons.length > 1).map(([id, l]) => `${id}: ${l.join(', ')}`);
    expect(repeated, `a video is used twice:\n${repeated.join('\n')}`).toEqual([]);
  });

  it('records the measured length of exactly the videos it shows', () => {
    expect(Object.keys(MEASURED).sort()).toEqual(ENTRIES.map(([id]) => id).sort());
    for (const [lessonId, video] of ENTRIES) {
      expect(MEASURED[lessonId]?.youtubeId, `${lessonId}: the measured length is for another video`).toBe(video.youtubeId);
      expect(Number.isInteger(MEASURED[lessonId]?.seconds), lessonId).toBe(true);
    }
  });

  // §11.3: the video fits the lesson's minutes at 238 words a minute and stays within 45 minutes. A body written in
  // theory-c.ts is counted as it is; any other lesson is given the longest body a lesson may carry.
  it('fits each video and its lesson theory in the lesson minutes, never over 45', () => {
    const over: string[] = [];
    for (const lesson of LESSONS) {
      const measured = MEASURED[lesson.id];
      if (measured === undefined) continue;
      const body = CCNA3_THEORY_C[lesson.id];
      const bodyWords = body === undefined ? MAX_BODY_WORDS : words(body);
      const needed = measured.seconds / 60 + bodyWords / WPM;
      if (needed > lesson.estimatedMinutes) over.push(`${lesson.id}: ${needed.toFixed(1)} min needed, ${lesson.estimatedMinutes} planned`);
      expect(measured.seconds / 60, lesson.id).toBeLessThanOrEqual(45);
    }
    expect(over, `videos that do not fit their lesson:\n${over.join('\n')}`).toEqual([]);
  });

  it('merges onto the skeleton by lesson id', () => {
    const merged = withContent(CCNA3_MODULES, {}, CCNA3_VIDEOS).flatMap((m) => m.lessons);
    expect(merged.map((l) => l.id)).toEqual(LESSON_IDS);
    for (const lesson of merged) {
      expect(lesson.video, `${lesson.id} lost or gained a video in the merge`).toEqual(CCNA3_VIDEOS[lesson.id]);
    }
  });

  // The CCNA 3 skeleton is detached until the W7 course flip (§11.3), so `COURSES` lists CCNA 3 with no lessons and
  // this loop has nothing to walk yet; from W7 it walks all 40 lessons, and a lesson whose video went missing in the
  // join fails here.
  it('reaches the assembled course once the skeleton is attached', () => {
    const course = courseById('ccna3');
    if (course === undefined) throw new Error('no ccna3 course in COURSES');
    for (const lesson of lessonsOf(course)) {
      expect(lesson.video, `${lesson.id} does not carry the video recorded for it`).toEqual(CCNA3_VIDEOS[lesson.id]);
    }
  });
});

/** The W6a review of theory-c.ts: each statement the review found wrong or missing, as the lesson now says it. */
describe('what lessons 23-36 say (theory-c.ts, W6a review)', () => {
  const body = (id: string): string => CCNA3_THEORY_C[id] ?? '';
  /** The text of one of the five sections of a body, without its heading. */
  const section = (id: string, heading: string): string => body(id).split(`## ${heading}\n`)[1]?.split('\n## ')[0] ?? '';
  /** The non-empty lines of every plain (CLI) fence of a text. */
  const fenceLines = (text: string): string[][] =>
    [...text.matchAll(/^```\n([\s\S]*?)\n```$/gm)].map((m) => (m[1] ?? '').split('\n').map((l) => l.trim()).filter((l) => l !== ''));
  const L25 = 'ccna3-25-site-to-site-ipsec';
  const L27 = 'ccna3-27-marking-queuing-and-policing';
  const L28 = 'ccna3-28-who-is-next-door';
  const L29 = 'ccna3-29-time-and-logs';
  const L33 = 'ccna3-33-a-method-for-enterprise-faults';

  it('lesson 29: a trap level sends its own severity and every more severe one', () => {
    expect(body(L29)).toMatch(/trap level of notifications sends 0 to 5 and never 6 or 7\./);
    expect(body(L29)).not.toMatch(/never 5 to 7/);
  });

  it('lesson 29 says what a syslog facility is', () => {
    expect(section(L29, 'How it actually works')).toMatch(/The facility names the part of the device that raised the message/);
    expect(section(L29, 'How it actually works')).toMatch(/syslog facility, local7 unless configured otherwise/);
  });

  it("lesson 27 gives the admission ceiling as the engine computes it, not the example's reservation", () => {
    const ceiling = Math.floor((1544 * QOS_ADMISSION_PERCENT) / 100);
    expect(body(L27)).toContain(`at most ${QOS_ADMISSION_PERCENT} % of the interface bandwidth, ${ceiling} of 1544 kb/s here; this policy reserves 768.`);
    expect(body(L27)).not.toMatch(/768 of 1544/);
  });

  it("lesson 27 shows how to mark, inbound, in the shape of lab 27's marking lines and with its own names", () => {
    const how = section(L27, 'How it actually works');
    expect(how).toMatch(/Mark inbound, at the trust boundary; queue outbound, where the queue forms\./);
    const marking = fenceLines(how).find((lines) => lines.includes('set dscp ef'));
    expect(marking, 'no fence sets DSCP ef').toBeDefined();
    const lines = marking ?? [];
    for (const head of ['ip access-list extended ', 'match access-group name ', 'service-policy input ']) {
      expect(lines.some((l) => l.startsWith(head)), head).toBe(true);
    }
    // the same form as the lab's reference solution (which the lab accepts), names and the port aside
    const shape = (l: string): string =>
      l.trim().replace(/\b(?:GigabitEthernet|FastEthernet|Serial)\d+(?:\/\d+)*\b/g, 'IF').replace(/\b[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)*\b/g, 'NAME');
    const solution = new Set((ccna3QosVoiceFirst.solution?.R1 ?? []).map(shape));
    expect(lines.filter((l) => !solution.has(shape(l))), "lines that are not of lab 27's form").toEqual([]);
    // its own names, so the lesson never types the lab's answer
    for (const labName of ['VOICE-PORTS', 'VOIP', 'MARK']) expect(lines.join('\n')).not.toMatch(new RegExp(`\\b${labName}\\b`));
  });

  it('lesson 25 says IKEv1, transform sets and crypto maps are not modelled (its video uses them)', () => {
    expect(body(L25)).toMatch(/NetForge models only IKEv2 profiles on a tunnel interface, so IKEv1, transform sets and crypto maps are not available\./);
  });

  it("lesson 25 gives the tunnel's inner size as NetForge's figure, not as a property of IPsec", () => {
    const inner = 1500 - IPSEC_OVERHEAD;
    expect(section(L25, 'How it actually works')).not.toContain(String(inner));
    expect(body(L25)).toMatch(new RegExp(`NetForge's ESP[^.]*inner packets of up to ${inner} bytes; real routers with this proposal take a little less`));
  });

  it("lesson 28 finds the switch CDP cannot see in SW1's LLDP table, not in SW2's own", () => {
    expect(body(L28)).not.toMatch(/on SW2 finds the switch CDP could not see/);
    expect(body(L28)).toMatch(/`show lldp neighbors` on SW2 lists SW1 at once, and on SW1 it lists SW2, the switch CDP could not see, after SW2's next announcement/);
  });

  it('lesson 33 names the tools of every layer and proposes a cause before testing a change', () => {
    const how = section(L33, 'How it actually works');
    expect(how).toMatch(/eliminate, propose a cause, test one change at a time, document/);
    const layers = how.split('\n').filter((l) => /^- \*\*(?:Physical|Data link|Network|Above)\*\*/.test(l));
    expect(layers).toHaveLength(4);
    for (const line of layers) expect(line, line).toMatch(/ Tools: /);
    const dataLink = layers.find((l) => l.startsWith('- **Data link**')) ?? '';
    for (const cmd of ['show vlan brief', 'show interfaces trunk', 'show spanning-tree', 'show mac address-table']) expect(dataLink).toContain(`\`${cmd}\``);
    const above = layers.find((l) => l.startsWith('- **Above**')) ?? '';
    for (const cmd of ['show access-lists', 'show ip nat translations']) expect(above).toContain(`\`${cmd}\``);
  });
});
