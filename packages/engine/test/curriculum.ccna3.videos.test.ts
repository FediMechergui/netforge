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
 * The two last blocks pin facts of the bodies the videos are read beside (the commands those bodies print are parsed
 * by curriculum.ccna3.commands.test.ts; these blocks pin what the prose and the samples claim): what the W6a review
 * corrected in theory-c.ts, and, since W7, what theory-d.ts (module 14) says about data formats, the device API and
 * scripts, each checked against the engine's own parsers, YANG model and NF-Py, and against the two automation labs,
 * with the statements the W7 review of theory-d.ts corrected (YAML indentation, the API root, POST to the parent, the
 * media types lab 38's API reads and answers in, the tools of lesson 39, the media types lesson 40's script names).
 */
import { describe, expect, it } from 'vitest';
import { lessonsOf } from '../src/contracts/curriculum.js';
import { IPSEC_OVERHEAD } from '../src/contracts/pdu.js';
import { SEC } from '../src/contracts/time.js';
import type { TraceEvent } from '../src/contracts/trace.js';
import { createSimulation } from '../src/sim/simulation.js';
import { QOS_ADMISSION_PERCENT } from '../src/link/qos/scheduler.js';
import { ccna3QosVoiceFirst } from '../src/sim/scenarios/ccna3/qos.js';
import {
  RESTCONF_LAB_ADDRESSES,
  RESTCONF_LAB_SECRET,
  RESTCONF_LAB_USER,
  SCRIPT_LAB_FILE,
  SCRIPT_LAB_RUNS,
  ccna3RestconfChange,
  ccna3ScriptInventory,
  restconfLabGetInterfaces,
} from '../src/sim/scenarios/ccna3/automation.js';
import { courseById, withContent } from '../src/curriculum/index.js';
import { CCNA1_VIDEOS } from '../src/curriculum/ccna1/videos.js';
import { CCNA2_VIDEOS } from '../src/curriculum/ccna2/videos.js';
import { CCNA3_MODULES } from '../src/curriculum/ccna3/lessons.js';
import { CCNA3_THEORY_C } from '../src/curriculum/ccna3/theory-c.js';
import { CCNA3_THEORY_D } from '../src/curriculum/ccna3/theory-d.js';
import { CCNA3_VIDEOS } from '../src/curriculum/ccna3/videos.js';
import { dataAt, formatDataPath, parseJson, type DataValue } from '../src/automation/data/json.js';
import { parseYaml, stringifyYaml } from '../src/automation/data/yaml.js';
import { dataToXml, parseXml, serializeXml, xmlToData } from '../src/automation/data/xml.js';
import { RESTCONF_ROOT, parseRestconfTarget } from '../src/automation/yang/path.js';
import { planYangWrite, readYang, resolveYangOperation, resolveYangPath, yangNode, type YangDeviceView, type YangStep } from '../src/automation/yang/model.js';
import { parsePy } from '../src/automation/py/parser.js';
import { startPyScript } from '../src/automation/py/lib.js';
import type { PyIoRequest, PyIoResult } from '../src/automation/py/vm.js';
import { basicCredentials, restconfErrorBody, restconfReason, MSG_RESTCONF_LOGIN_FAILED, RESTCONF_JSON_TYPE } from '../src/protocols/restconf.js';
import { parseConfigText } from '../src/cli/config-ast.js';

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
 * Each video's length in seconds, from its watch page (`lengthSeconds`) when the entries were checked: on 2026-10-12
 * for lessons 01-36 (W6), on 2026-10-13 for lessons 37-40 (W7). A new entry needs its measured length here, and a
 * replaced video its new one.
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
  'ccna3-37-data-a-machine-can-read': { youtubeId: 'dx4jItJQRPM', seconds: 350 },
  'ccna3-38-talking-to-devices-through-apis': { youtubeId: '-mN3VyJuCjM', seconds: 321 },
  'ccna3-39-configuration-as-code': { youtubeId: 'n6jIaKWixF4', seconds: 499 },
  'ccna3-40-scripting-the-network': { youtubeId: 'hpc5jyVpUpw', seconds: 521 },
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
  // theory-c.ts or theory-d.ts is counted as it is; any other lesson is given the longest body a lesson may carry.
  it('fits each video and its lesson theory in the lesson minutes, never over 45', () => {
    const over: string[] = [];
    for (const lesson of LESSONS) {
      const measured = MEASURED[lesson.id];
      if (measured === undefined) continue;
      const body = CCNA3_THEORY_C[lesson.id] ?? CCNA3_THEORY_D[lesson.id];
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

/**
 * W7: what lessons 37-40 (theory-d.ts, module 14) claim, checked against the engine itself — the parsers and converters
 * the data-formats playground uses, the YANG model and write planner the RESTCONF API answers with, NF-Py — and against
 * the two automation labs whose lines the "See it in NetForge" sections print.
 */
describe('what lessons 37-40 say (theory-d.ts, W7)', () => {
  const L37 = 'ccna3-37-data-a-machine-can-read';
  const L38 = 'ccna3-38-talking-to-devices-through-apis';
  const L39 = 'ccna3-39-configuration-as-code';
  const L40 = 'ccna3-40-scripting-the-network';
  const body = (id: string): string => CCNA3_THEORY_D[id] ?? '';
  const lesson = (id: string) => LESSONS.find((l) => l.id === id);
  /** The fenced blocks of a body with this info string ('' = a plain CLI fence), in order. */
  const fences = (id: string, info: string): string[] =>
    [...body(id).matchAll(/^```(\w*)\n([\s\S]*?)\n```$/gm)].filter((m) => m[1] === info).map((m) => m[2] ?? '');
  const one = (id: string, info: string): string => {
    const found = fences(id, info);
    expect(found, `${id}: one ${info || 'plain'} fence`).toHaveLength(1);
    return found[0] ?? '';
  };
  const json = (text: string): DataValue => {
    const r = parseJson(text);
    if (!r.ok) throw new Error(`line ${r.error.line}: ${r.error.message}`);
    return r.value;
  };
  /** A switch as the RESTCONF API sees it: its hostname and running configuration (no ports needed here). */
  const view = (hostname: string, config: string): YangDeviceView => ({ hostname, config: parseConfigText(config).root, interfaces: [] });
  /** The model nodes a RESTCONF data target names. */
  const steps = (target: string): readonly YangStep[] => {
    const t = parseRestconfTarget(target);
    if (!t.ok || t.resource.kind !== 'data') throw new Error(`not a data target: ${target}`);
    const r = resolveYangPath(t.resource.path);
    if (!r.ok) throw new Error(`${target}: ${r.error.message}`);
    return r.steps;
  };
  type HttpIo = Extract<PyIoRequest, { kind: 'http' }>;
  type HttpAnswer = Extract<PyIoResult, { kind: 'http' }>;
  /** Runs an NF-Py script to its end as the script host does, answering each HTTP call with `http`. */
  const runPy = (source: string, http: (io: HttpIo) => HttpAnswer = () => ({ kind: 'http', status: 200, reason: 'OK', headers: [], body: '{}' })) => {
    const vm = startPyScript(source, { file: 'lesson.py' });
    const requests: HttpIo[] = [];
    let output = '';
    let clock = { unixMs: 1_700_000_000_000, monotonicNs: 0 };
    let s = vm.run({ clock });
    for (let slices = 0; ; slices++) {
      output += s.output;
      if (s.state === 'waiting' && s.io !== undefined) {
        if (s.io.kind === 'http') {
          requests.push(s.io);
          vm.resume(http(s.io));
        } else vm.resume({ kind: 'sleep' });
      } else if (s.state !== 'running') break;
      if (slices > 10_000) throw new Error('the script did not end');
      clock = { ...clock, monotonicNs: clock.monotonicNs + 1_000_000 };
      s = vm.run({ clock });
    }
    return { state: s.state, output, requests, error: s.error };
  };

  it('writes the four lessons of module 14, in teaching order, and nothing else', () => {
    const ids = (CCNA3_MODULES[13]?.lessons ?? []).map((l) => l.id);
    expect(ids).toEqual([L37, L38, L39, L40]);
    expect(Object.keys(CCNA3_THEORY_D)).toEqual(ids);
  });

  it('points 38 and 40 at their labs by title and name, 37 at its concept tool, and 39 at no lab', () => {
    for (const [id, lab] of [[L38, ccna3RestconfChange], [L40, ccna3ScriptInventory]] as const) {
      expect(lesson(id)?.lab, id).toBe(lab.name);
      expect(body(id), id).toContain(`Load **${lab.title}** (\`${lab.name}\`) from the **Labs** tab`);
    }
    expect(lesson(L37)?.lab).toBeUndefined();
    expect(body(L37)).toContain('[data-formats playground](concept:data-formats)');
    expect(body(L37)).toMatch(/Nothing there is graded: you read a real device's JSON in lesson 38's lab/);
    // theory-only ([C22] not approved, §11.3): it says so, and what the hands-on part would have shown
    expect(lesson(L39)?.lab).toBeUndefined();
    expect(body(L39)).toMatch(
      /NetForge does not run playbooks yet, so this lesson has no lab\. Its hands-on part, running a playbook over a lab's switches and reading ok, changed or failed for each one, is planned for a later stage/,
    );
    for (const id of [L37, L39]) expect(body(id), id).not.toMatch(/`ccna3-[a-z0-9-]+`/);
  });

  it('lesson 37: the JSON, YAML and XML samples are one record, as the playground converts it', () => {
    const value = json(one(L37, 'json'));
    const yaml = one(L37, 'yaml');
    const xml = one(L37, 'xml');
    // the playground's "Show it as" (the engine's writers) gives exactly the lesson's YAML and XML
    expect(stringifyYaml(value).trimEnd()).toBe(yaml);
    const asXml = dataToXml(value);
    expect(asXml.ok && serializeXml(asXml.element).trimEnd()).toBe(xml);
    // and reading them back gives the same data
    const y = parseYaml(yaml);
    expect(y.ok && y.value).toEqual(value);
    const x = parseXml(xml);
    expect(x.ok && xmlToData(x.document.root)).toEqual(value);
    // the path the lesson follows, in both forms the playground shows
    const path = ['switch', 'vlans', 1, 'name'];
    expect(dataAt(value, path)).toBe('PRINTERS');
    expect(body(L37)).toContain(`\`${formatDataPath(path)}\``);
    expect(body(L37)).toContain(`\`data${formatDataPath(path, 'index')}\``);
  });

  it('lesson 37: the broken document has exactly three mistakes, and the parser stops where the lesson says', () => {
    const broken = one(L37, 'text');
    const r = parseJson(broken);
    expect(r.ok).toBe(false);
    if (!r.ok) expect([r.error.line, r.error.column]).toEqual([3, 14]);
    expect(body(L37)).toContain('line 3, column 14');
    const fixes = [(s: string) => s.replace('True', 'true'), (s: string) => s.replace("'STAFF'", '"STAFF"'), (s: string) => s.replace(/,(\s*\])/, '$1')];
    expect(parseJson(fixes.reduce((s, f) => f(s), broken)).ok, 'all three fixes mend it').toBe(true);
    for (let i = 0; i < fixes.length; i++) {
      const others = fixes.filter((_, j) => j !== i);
      expect(parseJson(others.reduce((s, f) => f(s), broken)).ok, `fix ${i} is needed`).toBe(false);
    }
  });

  it('lesson 37: NetForge reads YAML 1.2 (yes and no stay strings) and refuses what its subset leaves out', () => {
    const r = parseYaml('a: yes\nb: no');
    expect(r.ok && r.value).toEqual({ a: 'yes', b: 'no' });
    for (const refused of ['a: &x 1\nb: *x', 'a: !!str 1', 'a: 1\n---\nb: 2', 'a:\n\tb: 1']) expect(parseYaml(refused).ok, refused).toBe(false);
    expect(body(L37)).toMatch(/NetForge reads YAML 1\.2, where `yes` and `no` are strings/);
    expect(body(L37)).toMatch(/anchors, aliases, tags and several documents in one text are refused/);
    expect(body(L37)).toMatch(/a tab is an error/);
  });

  it('lesson 38: the PUT is what the API plans (201, then 204) and a GET of the same URI answers the entry', () => {
    const [request, response] = fences(L38, 'http');
    const lines = (request ?? '').split('\n');
    const target = /^PUT (\S+) HTTP\/1\.1$/.exec(lines[0] ?? '')?.[1] ?? '';
    const blank = lines.indexOf('');
    const headers = lines.slice(1, blank);
    const put = { method: 'PUT' as const, steps: steps(target), body: json(lines.slice(blank + 1).join('\n')) };
    expect(planYangWrite(view('BRANCH-SW', 'hostname BRANCH-SW'), put)).toEqual({ ok: true, lines: ['vlan 50', ' name PRINTERS'], status: 201 });
    const after = view('BRANCH-SW', 'hostname BRANCH-SW\nvlan 50\n name PRINTERS');
    expect(planYangWrite(after, put)).toEqual({ ok: true, lines: [], status: 204 });
    expect(readYang(after, put.steps)).toEqual({ ok: true, value: { 'nf-native:vlan-list': [{ id: 50, name: 'PRINTERS' }] } });
    expect((response ?? '').split('\n')[0]).toBe(`HTTP/1.1 201 ${restconfReason(201)}`);
    expect(body(L38)).toContain('`vlan 50` and then `name PRINTERS`');
    expect(body(L38)).toContain(`The same PUT again changes nothing and answers \`204 ${restconfReason(204)}\``);
    // the credentials are the worked example's own, and the URI in the prose is the request's
    const auth = headers.find((h) => h.startsWith('Authorization: '))?.slice('Authorization: '.length);
    expect(basicCredentials(auth)).toEqual({ user: 'netops', password: 'Example-7' });
    expect(headers).toContain('Host: 192.0.2.21');
    expect(body(L38)).toContain(`\`https://192.0.2.21${target}\``);
  });

  it("lesson 38: the YANG excerpt is nf-native's VLAN list as the model defines it", () => {
    expect(yangNode('nf-native:native/vlan')?.kind).toBe('container');
    expect(yangNode('nf-native:native/vlan/vlan-list')?.keys).toEqual(['id']);
    expect(yangNode('nf-native:native/vlan/vlan-list/id')).toMatchObject({ type: 'uint16', range: [1, 4094] });
    expect(yangNode('nf-native:native/vlan/vlan-list/name')?.type).toBe('string');
    const text = one(L38, 'text');
    for (const line of ['container vlan {', 'list vlan-list {', 'key "id";', 'leaf id   { type uint16 { range "1..4094"; } }', 'leaf name { type string; }']) {
      expect(text).toContain(line);
    }
  });

  it("lesson 38: every status code it names carries the API's reason phrase, and NetForge's 401 covers privilege", () => {
    const named = [...body(L38).matchAll(/`(\d{3}) ([A-Z][A-Za-z ]+)`/g)];
    expect(named.length).toBeGreaterThanOrEqual(8);
    for (const [, code, reason] of named) expect(restconfReason(Number(code)), `${code}`).toBe(reason);
    expect(MSG_RESTCONF_LOGIN_FAILED).toMatch(/privilege 15/);
    expect(body(L38)).toMatch(/answers 401 to every refused login, a user without privilege 15 included/);
    expect(body(L38)).toMatch(/NETCONF and a YANG browser are not built yet, so the model is shown here as text/);
  });

  it("lesson 38: the lines it prints from lab 38 are the lab's own", () => {
    expect(body(L38)).toContain(`\`${restconfLabGetInterfaces(RESTCONF_LAB_ADDRESSES.sw2)}\``);
    const username = /`(username [^`]+)`/.exec(body(L38))?.[1] ?? '(none)';
    const switches = ccna3RestconfChange.build().devices.filter((d) => d.type === 'switch.nfc2960');
    expect(switches).toHaveLength(3);
    for (const sw of switches) {
      const config = (sw.config ?? '').split('\n').map((l) => l.trim());
      for (const line of [username, 'ip http secure-server', 'ip http authentication local', 'restconf']) expect(config, `${sw.name}: ${line}`).toContain(line);
    }
  });

  it('lesson 40: the script reports the switches that lack VLAN 50, and skips one that refuses the login', () => {
    const source = one(L40, 'python');
    expect(parsePy(source).ok).toBe(true);
    const switches: Record<string, YangDeviceView> = {
      '192.0.2.21': view('ACC-1', 'hostname ACC-1\nvlan 10\n name STAFF\nvlan 50\n name PRINTERS'),
      '192.0.2.22': view('ACC-2', 'hostname ACC-2'),
    };
    const run = runPy(source, (io) => {
      const host = /^https:\/\/([^/]+)\//.exec(io.url)?.[1] ?? '';
      const sw = switches[host];
      if (sw === undefined) {
        return { kind: 'http', status: 401, reason: restconfReason(401), headers: [['Content-Type', 'application/yang-data+json']], body: restconfErrorBody('protocol', 'access-denied', MSG_RESTCONF_LOGIN_FAILED) };
      }
      const r = readYang(sw, steps(io.url));
      if (!r.ok) throw new Error(r.error.message);
      return { kind: 'http', status: 200, reason: 'OK', headers: [['Content-Type', 'application/yang-data+json']], body: JSON.stringify(r.value) };
    });
    expect(run.state, run.error?.traceback).toBe('completed');
    const out = run.output.trimEnd().split('\n');
    expect(out[0]).toBe('ACC-1 has VLANs [10, 50]');
    expect(out[1]).toBe('ACC-2 has VLANs []');
    expect(out[2]).toBe('192.0.2.23 skipped: 401 Client Error: Unauthorized for url: https://192.0.2.23/restconf/data/nf-native:native');
    expect(out[3]).toBe("Missing VLAN 50: ['ACC-2']");
    // one GET per switch, in order, with the worked example's credentials (lesson 38's Authorization header)
    expect(run.requests.map((r) => `${r.method} ${r.url}`)).toEqual(['21', '22', '23'].map((n) => `GET https://192.0.2.${n}/restconf/data/nf-native:native`));
    const l38Auth = /^Authorization: (.+)$/m.exec(fences(L38, 'http')[0] ?? '')?.[1];
    for (const r of run.requests) expect(r.headers.find(([k]) => k === 'Authorization')?.[1]).toBe(l38Auth);
  });

  it("lesson 40: the lab lines it prints are lab 40's own, and NF-Py is the subset it describes", () => {
    expect(body(L40)).toContain(`\`type ${SCRIPT_LAB_FILE}\``);
    expect(body(L40)).toContain(`\`${SCRIPT_LAB_RUNS[0]?.lines[0] ?? '(none)'}\``);
    expect(ccna3ScriptInventory.build().devices.find((d) => d.name === 'DEV1')?.files?.map((f) => f.path)).toEqual([SCRIPT_LAB_FILE]);
    // no classes, no `with`
    for (const refused of ['class Switch:\n    pass\n', 'with x as y:\n    pass\n']) expect(parsePy(refused).ok, refused).toBe(false);
    // the five modules, and nothing else
    expect(runPy('import json\nimport requests\nimport time\nimport sys\nimport math\n').state).toBe('completed');
    const os = runPy('import os\n');
    expect(os.state).toBe('failed');
    expect(os.error?.type).toBe('ModuleNotFoundError');
    // whole numbers below 2**53
    expect(runPy('x = 9007199254740991\n').state).toBe('completed');
    const over = runPy('x = 9007199254740991 + 1\n');
    expect(over.state).toBe('failed');
    expect(over.error?.type).toBe('OverflowError');
    expect(body(L40)).toMatch(/only the modules `json`, `requests`, `time`, `sys` and `math`/);
    expect(body(L40)).toMatch(/whole numbers below 2⁵³/);
  });

  // ── the W7 review of theory-d.ts: each statement the review found wrong or missing, as the lesson now says it ──

  /** The text of one of the five sections of a body, without its heading. */
  const section = (id: string, heading: string): string => body(id).split(`## ${heading}\n`)[1]?.split('\n## ')[0] ?? '';

  it('lesson 37: a YAML key indented further than its siblings is an error under a value and nests under a key with none (W7 review)', () => {
    // the line above holds a value: an error, in a mapping and in a list item alike
    for (const text of ['switch:\n  hostname: BRANCH-SW\n   managed: true', 'vlans:\n  - id: 10\n     name: STAFF']) {
      const r = parseYaml(text);
      expect(r.ok, text).toBe(false);
      if (!r.ok) expect(r.error.line, text).toBe(3);
    }
    // the line above is a key with no value: the key moves under it
    const nested = parseYaml('switch:\n  hostname: BRANCH-SW\n  vlans:\n   id: 10');
    expect(nested.ok && nested.value).toEqual({ switch: { hostname: 'BRANCH-SW', vlans: { id: 10 } } });
    expect(body(L37)).toContain(
      'a YAML key indented further than its siblings is an error when the line above already has a value, and moves under that line when it has none; a tab is an error.',
    );
    expect(body(L37)).not.toMatch(/indented one space too far belongs to the item above/);
  });

  it('lesson 38: the API root is /restconf, with data and operations under it (W7 review)', () => {
    const kind = (target: string): string => {
      const r = parseRestconfTarget(target);
      return r.ok ? r.resource.kind : 'refused';
    };
    expect(kind(RESTCONF_ROOT)).toBe('root');
    expect(kind(`${RESTCONF_ROOT}/data`)).toBe('data');
    const save = parseRestconfTarget(`${RESTCONF_ROOT}/operations/nf-native:save-config`);
    expect(save.ok && save.resource.kind === 'operations' && resolveYangOperation(save.resource.path).ok).toBe(true);
    expect(body(L38)).toContain(
      `A RESTCONF URI starts at the API root, \`${RESTCONF_ROOT}\`; data lives under \`${RESTCONF_ROOT}/data\` and operations under \`${RESTCONF_ROOT}/operations\`, and \`list=key\` picks one entry: \`https://192.0.2.21${RESTCONF_ROOT}/data/nf-native:native/vlan/vlan-list=50\` names VLAN 50`,
    );
    expect(body(L38)).not.toMatch(/API root, `\/restconf\/data`/);
  });

  it("lesson 38: POST creates under the parent (201, then 409), and a POST to a new entry's own URI is 404 (W7 review)", () => {
    const parent = `${RESTCONF_ROOT}/data/nf-native:native/vlan`;
    const entry = `${parent}/vlan-list=50`;
    const entryBody = json('{"nf-native:vlan-list": [{"id": 50, "name": "PRINTERS"}]}');
    const before = view('BRANCH-SW', 'hostname BRANCH-SW\nvlan 10\n name STAFF');
    const after = view('BRANCH-SW', 'hostname BRANCH-SW\nvlan 10\n name STAFF\nvlan 50\n name PRINTERS');
    const post = (target: string) => ({ method: 'POST' as const, steps: steps(target), body: entryBody });
    expect(planYangWrite(before, post(parent))).toEqual({ ok: true, lines: ['vlan 50', ' name PRINTERS'], status: 201 });
    expect(planYangWrite(after, post(parent))).toMatchObject({ ok: false, error: { status: 409 } });
    for (const dev of [before, view('BRANCH-SW', 'hostname BRANCH-SW')]) expect(planYangWrite(dev, post(entry))).toMatchObject({ ok: false, error: { status: 404 } });
    const how = section(L38, 'How it actually works');
    expect(how).toContain(
      `- **Create**: POST to the parent, such as \`${parent}\`, with the new entry in the body (\`201 Created\`, or \`409 Conflict\` if the entry exists). PUT, GET, PATCH and DELETE name the entry itself.`,
    );
    expect(how).not.toMatch(/\*\*Create\*\*: POST \(/);
    expect(section(L38, 'What trips people up')).toContain('a POST to the URI of an entry that does not exist yet gets 404: POST names the parent.');
  });

  it("lesson 38: lab 38's API takes JSON as yang-data+json or plain application/json, refuses no Content-Type or XML with 415, and answers JSON whatever Accept asks (W7 review)", () => {
    const lab = ccna3RestconfChange;
    const sim = createSimulation({ seed: lab.seed ?? 1 });
    sim.loadTopology({ ...lab.build(), lab: { name: lab.name, version: lab.version ?? 1 } });
    sim.runFor(90 * SEC);
    sim.runToIdle();
    const pc1 = sim.devices().find((d) => d.spec.name === 'PC1')?.id;
    if (pc1 === undefined) throw new Error('lab 38 has no PC1');
    /** A `rest` job typed on a fresh console of PC1, run until it ends: its status and printed text. */
    const rest = (line: string): { status?: number; text: string } => {
      const s = sim.cli.open(pc1, 'console');
      const cursor = sim.trace(0).next;
      expect(sim.cli.exec(s, line).busy, line).toBe(true);
      let done = false;
      for (let i = 0; i < 200 && !done; i++) {
        sim.runFor(SEC / 20);
        done = sim.trace(cursor).events.some((e) => e.kind === 'cliPrompt' && e.session === s && !e.busy);
      }
      expect(done, line).toBe(true);
      const text = sim
        .trace(cursor)
        .events.filter((e): e is Extract<TraceEvent, { kind: 'cliOutput' }> => e.kind === 'cliOutput' && e.session === s)
        .map((e) => e.text)
        .join('');
      sim.cli.close(s);
      const m = /^HTTP\/1\.1 (\d{3}) /.exec(text);
      return m === null ? { text } : { status: Number(m[1]), text };
    };
    const url = (id: number): string => `https://${RESTCONF_LAB_ADDRESSES.sw2}${RESTCONF_ROOT}/data/nf-native:native/vlan/vlan-list=${id}`;
    const auth = `-u ${RESTCONF_LAB_USER}:${RESTCONF_LAB_SECRET}`;
    const put = (id: number, type?: string): number | undefined =>
      rest(`rest PUT ${url(id)} ${auth}${type === undefined ? '' : ` -H "Content-Type: ${type}"`} -d {"nf-native:vlan-list":[{"id":${id},"name":"V${id}"}]}`).status;
    expect(put(71, RESTCONF_JSON_TYPE)).toBe(201);
    expect(put(72, 'application/json')).toBe(201);
    expect(put(73)).toBe(415);
    expect(put(74, 'application/yang-data+xml')).toBe(415);
    const get = rest(`rest GET ${url(71)} ${auth} -H "Accept: application/yang-data+xml"`);
    expect(get.status, get.text).toBe(200);
    expect(get.text).toContain(`Content-Type: ${RESTCONF_JSON_TYPE}`);
    expect(get.text).toContain('"nf-native:vlan-list"');
    // what the lesson says, as the API behaves
    expect(section(L38, 'The idea in one breath')).toMatch(/answers with a status code and data in JSON or XML\./);
    const trips = section(L38, 'What trips people up');
    expect(trips).toContain(
      "- A write whose body has no `Content-Type`, or a type that is not JSON (XML included), gets 415; RESTCONF's JSON type is `application/yang-data+json`, the type to send.",
    );
    expect(trips).not.toMatch(/A write without `Content-Type: application\/yang-data\+json` gets 415/);
    expect(trips).toContain('Its API reads JSON bodies only (XML gets 415) and also takes plain `application/json`, answers in JSON whatever `Accept` asks for, ignores query parameters');
  }, 60_000);

  it('lesson 39: tells the tools apart by their traits without counting them, the master-and-minions tool and the provisioning tool included (W7 review)', () => {
    const how = section(L39, 'How it actually works');
    expect(body(L39)).not.toMatch(/\bthree\b/);
    // the push or pull, agentless or agent-based framing stays, and so do the three tools it already described
    for (const kept of ['**Push or pull**', '**Agentless or agent-based**', 'One is agentless and pushes YAML playbooks over SSH from a control node', 'Two are agent-based and pull from a central server']) {
      expect(how).toContain(kept);
    }
    expect(how).toContain('Another is agent-based but pushes by default: a master sends the desired state, kept in YAML files, to agents called minions; it is written in Python too.');
    expect(how).toContain(
      'A provisioning tool works a level lower, building the infrastructure itself. It is declarative and agentless: it reads files in its own configuration language, calls device and cloud APIs to build what they describe, keeps a state file of what it built, and shows a plan of every change before it applies one.',
    );
  });

  it('lesson 40: the script names the RESTCONF media types on every GET, and the change call it shows keeps them (W7 review)', () => {
    const source = one(L40, 'python');
    const headersLine = source.split('\n').find((l) => l.startsWith('HEADERS = ')) ?? '';
    expect(headersLine, 'the script defines HEADERS').not.toBe('');
    const named = (headers: readonly (readonly [string, string])[], name: string): (readonly [string, string])[] => headers.filter(([k]) => k.toLowerCase() === name);
    const run = runPy(source, () => ({ kind: 'http', status: 200, reason: 'OK', headers: [['Content-Type', RESTCONF_JSON_TYPE]], body: '{"nf-native:native": {"hostname": "ACC-1"}}' }));
    expect(run.state, run.error?.traceback).toBe('completed');
    expect(run.requests).toHaveLength(3);
    for (const r of run.requests) expect(named(r.headers, 'accept'), r.url).toEqual([['Accept', RESTCONF_JSON_TYPE]]);
    // the change sentence's call, run in NF-Py with the script's own HEADERS: the body goes as RESTCONF's JSON type
    const call = /`(requests\.put\([^`]+\))`/.exec(body(L40))?.[1] ?? '';
    expect(call).toBe('requests.put(url, json=body, auth=AUTH, headers=HEADERS)');
    const change = runPy(
      [
        'import requests',
        'AUTH = ("netops", "Example-7")',
        headersLine,
        'url = "https://192.0.2.21/restconf/data/nf-native:native/vlan/vlan-list=50"',
        'body = {"nf-native:vlan-list": [{"id": 50, "name": "PRINTERS"}]}',
        `r = ${call}`,
        '',
      ].join('\n'),
      () => ({ kind: 'http', status: 201, reason: restconfReason(201), headers: [], body: '' }),
    );
    expect(change.state, change.error?.traceback).toBe('completed');
    expect(change.requests.map((r) => `${r.method} ${r.url}`)).toEqual(['PUT https://192.0.2.21/restconf/data/nf-native:native/vlan/vlan-list=50']);
    const sent = change.requests[0]?.headers ?? [];
    expect(named(sent, 'content-type')).toEqual([['Content-Type', RESTCONF_JSON_TYPE]]);
    expect(named(sent, 'accept')).toEqual([['Accept', RESTCONF_JSON_TYPE]]);
    expect(body(L40)).toContain('`HEADERS` names the RESTCONF media types: without them a device may answer in XML, or refuse a body sent as plain `application/json` with 415.');
  });
});
