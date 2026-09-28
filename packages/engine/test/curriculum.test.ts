/**
 * The course layer holds together: the lessons point at labs that exist, the ids are unique and stable, every one
 * of the CCNA 1 labs is reachable from a lesson, and a planned level pretends nothing.
 *
 * The skeleton (`ccna1/lessons.ts`) is checked through the assembled `COURSES`, so a merge that dropped a lesson
 * or a content map keyed by a typo fails here too. Since P2 W7 the same holds for CCNA 2 (`ccna2/lessons.ts`,
 * attached in `curriculum/index.ts`, ARCHITECTURE-P2 §9.2 item 28): its pins are the last describe block below.
 */
import { describe, expect, it } from 'vitest';
import type { Course, Lesson } from '../src/contracts/curriculum.js';
import { labLessonMap, lessonsOf } from '../src/contracts/curriculum.js';
import { COURSES, courseById, lessonById, withContent } from '../src/curriculum/index.js';
import { CCNA1_MODULES } from '../src/curriculum/ccna1/lessons.js';
import { CCNA2_MODULES } from '../src/curriculum/ccna2/lessons.js';
import { CCNA2_VIDEOS } from '../src/curriculum/ccna2/videos.js';
import { CCNA1_LABS } from '../src/sim/scenarios/ccna1/index.js';
import { CCNA2_LABS } from '../src/sim/scenarios/ccna2/index.js';
import { SCENARIOS } from '../src/sim/scenarios/index.js';
import { GRAMMAR } from '../src/cli/grammar/index.js';
import { matchCommand } from '../src/cli/parser.js';
import { SPEED_1G } from '../src/contracts/port.js';
import { negotiate } from '../src/link/negotiation.js';
import { catalogModel, matchContextFor } from './cli.p05.fixture.js';

const KEBAB = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function ccna1(): Course {
  const course = courseById('ccna1');
  if (course === undefined) throw new Error('no ccna1 course in COURSES');
  return course;
}

/** Every lesson of every course, so the checks below cover any level that becomes available later. */
function allLessons(): Lesson[] {
  return COURSES.flatMap((c) => [...lessonsOf(c)]);
}

/** The lesson order the UI and the deep links depend on; a reorder has to be a deliberate edit here too. */
const CCNA1_ORDER = [
  'ccna1-01-what-is-a-network',
  'ccna1-02-hosts-and-media',
  'ccna1-03-the-layered-model',
  'ccna1-04-the-device-command-line',
  'ccna1-05-ethernet-frames-and-mac-addresses',
  'ccna1-06-switches-and-the-mac-table',
  'ccna1-07-speed-duplex-and-autonegotiation',
  'ccna1-08-what-an-ipv4-address-is',
  'ccna1-09-binary-masks-and-subnet-boundaries',
  'ccna1-10-build-a-small-lan',
  'ccna1-11-arp',
  'ccna1-12-ping-and-icmp',
  'ccna1-13-the-default-gateway',
  'ccna1-14-splitting-a-network-into-subnets',
  'ccna1-15-a-subnet-plan-in-practice',
  'ccna1-16-what-a-router-does',
  'ccna1-17-static-routes',
  'ccna1-18-device-access-and-passwords',
  'ccna1-19-dhcp',
  'ccna1-20-dhcp-across-a-router',
  'ccna1-21-dns',
  'ccna1-22-tcp-and-udp',
  'ccna1-23-http-and-the-web',
  'ccna1-24-why-ipv6',
  'ccna1-25-ipv6-without-a-server',
  'ccna1-26-how-wireless-works',
  'ccna1-27-set-up-a-wireless-network',
  'ccna1-28-traceroute',
  'ccna1-29-a-method-for-troubleshooting',
  'ccna1-30-addressing-faults',
  'ccna1-31-link-faults',
];

describe('curriculum catalogue', () => {
  it('lists CCNA 1 and CCNA 2 as available with modules, and CCNA 3 as planned with none', () => {
    expect(COURSES.map((c) => c.id)).toEqual(['ccna1', 'ccna2', 'ccna3']);
    for (const course of COURSES) {
      expect(course.level.length).toBeGreaterThan(0);
      expect(course.title.length).toBeGreaterThan(0);
      expect(course.subtitle.length).toBeGreaterThan(0);
      expect(course.description.length).toBeGreaterThan(0);
      if (course.status === 'planned') {
        expect(course.modules, `${course.id} is planned but carries modules`).toEqual([]);
        expect(lessonsOf(course)).toEqual([]);
      } else {
        expect(course.modules.length, `${course.id} is available but empty`).toBeGreaterThan(0);
      }
    }
    expect(ccna1().status).toBe('available');
    expect(courseById('ccna2')?.status).toBe('available');
    expect(courseById('ccna3')?.status).toBe('planned');
  });

  it('keeps ids unique and kebab-case', () => {
    const ids: string[] = [];
    for (const course of COURSES) {
      expect(course.id).toMatch(KEBAB);
      ids.push(course.id);
      for (const module of course.modules) {
        expect(module.id, `module id ${module.id}`).toMatch(KEBAB);
        expect(module.title.length).toBeGreaterThan(0);
        expect(module.summary.length).toBeGreaterThan(0);
        expect(module.lessons.length, `module ${module.id} has no lessons`).toBeGreaterThan(0);
        ids.push(module.id);
      }
    }
    for (const lesson of allLessons()) {
      expect(lesson.id, `lesson id ${lesson.id}`).toMatch(KEBAB);
      ids.push(lesson.id);
    }
    expect(new Set(ids).size, `duplicate id among ${ids.length} ids`).toBe(ids.length);
  });

  it('gives every lesson an outcome, a topic and a sane length', () => {
    for (const lesson of allLessons()) {
      expect(lesson.title.length, `${lesson.id} has no title`).toBeGreaterThan(0);
      expect(lesson.outcome.trim().length, `${lesson.id} has no outcome`).toBeGreaterThan(0);
      expect(lesson.topic.trim().length, `${lesson.id} has no topic`).toBeGreaterThan(0);
      expect(lesson.estimatedMinutes, `${lesson.id} takes no time`).toBeGreaterThan(0);
      expect(lesson.estimatedMinutes, `${lesson.id} claims a whole afternoon`).toBeLessThanOrEqual(45);
    }
  });

  it('holds the CCNA 1 lessons in a stable order', () => {
    expect(lessonsOf(ccna1()).map((l) => l.id)).toEqual(CCNA1_ORDER);
  });

  it('only ever names a lab that exists', () => {
    const names = new Set(SCENARIOS.map((s) => s.name));
    for (const lesson of allLessons()) {
      if (lesson.lab === undefined) continue;
      expect(names.has(lesson.lab), `lesson ${lesson.id} points at unknown lab ${lesson.lab}`).toBe(true);
    }
  });

  it('reaches every CCNA 1 lab from a lesson', () => {
    const placed = labLessonMap(ccna1());
    const missing = CCNA1_LABS.filter((lab) => !placed.has(lab.name)).map((lab) => `${lab.name} (${lab.title})`);
    expect(missing, `labs no lesson opens: ${missing.join(', ')}`).toEqual([]);
    expect(placed.size).toBe(CCNA1_LABS.length);
  });

  it('attaches each lab to one lesson only', () => {
    const used = lessonsOf(ccna1())
      .map((l) => l.lab)
      .filter((name): name is string => name !== undefined);
    expect(new Set(used).size, `a lab is attached twice: ${used.join(', ')}`).toBe(used.length);
  });
});

/**
 * The content maps are joined onto the skeleton in `curriculum/index.ts`, and a join that silently does nothing
 * is invisible from either side: the halves assert themselves in their own files, and the merge below is exercised
 * with a fixture. Only the assembled catalogue can say whether the prose actually reaches a reader, which is why
 * these run over `COURSES` rather than over any map.
 */
describe('assembled courses carry their content', () => {
  it('gives every lesson of an available course a written body', () => {
    for (const course of COURSES.filter((c) => c.status === 'available')) {
      const empty = lessonsOf(course)
        .filter((l) => l.theory.trim() === '')
        .map((l) => l.id);
      expect(empty, `${course.id}: lessons reaching the reader with no theory: ${empty.join(', ')}`).toEqual([]);
    }
  });

  it('announces no lessons on a course that is only planned', () => {
    for (const course of COURSES.filter((c) => c.status !== 'available')) {
      expect(lessonsOf(course), `${course.id} is planned but ships lessons`).toEqual([]);
    }
  });
});

/**
 * A command a lesson prints is one a learner will type, so it has to do what the prose says in this simulator.
 * The worked examples may sketch a topology of their own for routes, but an address line is what goes into the
 * attached lab's hosts — so it must be the lab's own line, or the learner fails a task with no hint why.
 */
describe('lesson commands agree with the engine and the attached lab', () => {
  const body = (id: string): string => lessonById(id)?.theory ?? '';

  it('prints only address lines the attached lab itself uses', () => {
    const ADDRESS_LINE = /(?:ipv6 address|ip address|ip default-gateway) [^`\n']+/g;
    const wrong: string[] = [];
    for (const lesson of lessonsOf(ccna1())) {
      const solution = SCENARIOS.find((s) => s.name === lesson.lab)?.solution;
      if (solution === undefined) continue;
      const lines = new Set(Object.values(solution).flat().map((l) => l.trim()));
      for (const [line] of lesson.theory.matchAll(ADDRESS_LINE)) {
        const cmd = line.trim().replace(/\.$/, '');
        if (!lines.has(cmd)) wrong.push(`${lesson.id} :: ${cmd}`);
      }
    }
    expect(wrong, `address lines the attached lab would not accept:\n${wrong.join('\n')}`).toEqual([]);
  });

  it('pins the duplex setting that really produces the mismatch lesson 07 describes', () => {
    const m = /`speed (\d+)` and `duplex (full|half)`, leave the other on auto/.exec(body('ccna1-07-speed-duplex-and-autonegotiation'));
    if (m === null) throw new Error('lesson 07 no longer tells the learner which end to pin');
    const speed = Number(m[1]) * 1e6;
    const pinned = { kind: 'ethernet', role: 'switched', speedBps: speed, settings: { speed, duplex: m[2] as 'full' | 'half' } } as const;
    const auto = { kind: 'ethernet', role: 'routed', speedBps: SPEED_1G } as const;
    const r = negotiate(pinned, auto);
    expect(r.ok && r.mismatch, `speed ${m[1]} duplex ${m[2]} against auto`).toBe('duplex');
  });

  it('offers clear arp-cache only where it exists, on a switch or router and not at a host prompt', () => {
    const offered = body('ccna1-11-arp').split('\n').filter((l) => l.includes('`clear arp-cache`'));
    expect(offered.length).toBeGreaterThan(0);
    for (const line of offered) expect(line, 'clear arp-cache offered without saying where').toMatch(/switch or router/);
    expect(matchCommand(GRAMMAR, matchContextFor(catalogModel('pc.nfpc'), 'user-exec'), 'clear arp-cache').ok).toBe(false);
    expect(matchCommand(GRAMMAR, matchContextFor(catalogModel('router.nf2911'), 'priv-exec'), 'clear arp-cache').ok).toBe(true);
  });
});

describe('curriculum helpers', () => {
  it('finds a course and a lesson by id, and nothing for an unknown one', () => {
    expect(courseById('ccna1')?.level).toBe('CCNA 1');
    expect(courseById('ccna9')).toBeUndefined();
    expect(lessonById('ccna1-11-arp')?.title.length).toBeGreaterThan(0);
    expect(lessonById('ccna1-99-nothing')).toBeUndefined();
  });

  it('merges theory and videos by lesson id and leaves the rest alone', () => {
    const first = CCNA1_MODULES[0]?.lessons[0];
    if (first === undefined) throw new Error('no first CCNA 1 lesson');
    const video = { youtubeId: 'x'.repeat(11), title: 'A video', channel: 'A channel', url: 'https://example.invalid/watch' };
    const merged = withContent(CCNA1_MODULES, { [first.id]: '# Body' }, { [first.id]: video });
    const lesson = merged[0]?.lessons[0];
    expect(lesson?.id).toBe(first.id);
    expect(lesson?.theory).toBe('# Body');
    expect(lesson?.video).toEqual(video);
    const untouched = merged[0]?.lessons[1];
    expect(untouched?.theory).toBe('');
    expect(untouched?.video).toBeUndefined();
    expect(first.theory, 'the skeleton was mutated').toBe('');
  });
});


/**
 * CCNA 2, attached in P2 W7 (ARCHITECTURE-P2 §7 W7 course, §9.2 item 28, §11.3). The skeleton, the four theory parts
 * and the videos have tests of their own (curriculum.ccna2*.test.ts); these pins are about what reaches the reader
 * once `curriculum/index.ts` joins them: the order, the labs, the rules of §11.3 that the CCNA 1 bodies are held to
 * (the five sections, the markdown subset, no vendor), the minutes of the wireless lessons, and the course text.
 */
describe('the CCNA 2 course, attached', () => {
  const ccna2 = (): Course => {
    const course = courseById('ccna2');
    if (course === undefined) throw new Error('no ccna2 course in COURSES');
    return course;
  };
  const body = (id: string): string => lessonById(id)?.theory ?? '';

  /** The five sections of every body, in this order (the CCNA 1 theory tests hold the same list). */
  const SECTIONS = ['## The idea in one breath', '## Why it exists', '## How it actually works', '## What trips people up', '## See it in NetForge'];
  /** Link targets the lab markdown parser turns into links (apps/web/src/labs/markdown.ts). */
  const ALLOWED_LINK = /^(?:concept:subnetting|concept:ipv6|https:\/\/[^\s<>"'`\\]+)$/;
  const LINK = /\[[^\]\n]*\]\(([^()\s]*)\)/g;
  /** Names the course never prints (§0 rule 6), the union of the CCNA 1 and CCNA 2 guards. */
  const VENDORS = /\b(?:cisco|ios|packet\s*tracer|netacad|juniper|huawei|catalyst|meraki|aruba|mikrotik)\b/i;
  /** A word as the lesson-minute rule counts it (curriculum.ccna2.accuracy.test.ts). */
  const words = (text: string): number => text.split(/\s+/).filter((w) => w.length > 0).length;

  it('is the skeleton in teaching order: 11 modules, 34 lessons, each with a written body', () => {
    const course = ccna2();
    expect(course.modules.map((m) => m.id)).toEqual(CCNA2_MODULES.map((m) => m.id));
    expect(lessonsOf(course).map((l) => l.id)).toEqual(CCNA2_MODULES.flatMap((m) => m.lessons.map((l) => l.id)));
    expect(course.modules).toHaveLength(11);
    expect(lessonsOf(course)).toHaveLength(34);
    for (const lesson of lessonsOf(course)) expect(lesson.theory.trim().length, lesson.id).toBeGreaterThan(0);
  });

  it('reaches every CCNA 2 lab from exactly one lesson, the wireless lab of lesson 27 included', () => {
    const placed = labLessonMap(ccna2());
    const missing = CCNA2_LABS.filter((lab) => !placed.has(lab.name)).map((lab) => lab.name);
    expect(missing, `CCNA 2 labs no lesson opens: ${missing.join(', ')}`).toEqual([]);
    expect(placed.size).toBe(CCNA2_LABS.length);
    expect(placed.size).toBe(20);
    expect(placed.get('ccna2-wlc-wlan')?.id).toBe('ccna2-27-wlans-on-a-controller');
    const used = lessonsOf(ccna2()).flatMap((l) => (l.lab === undefined ? [] : [l.lab]));
    expect(new Set(used).size, `a lab is attached twice: ${used.join(', ')}`).toBe(used.length);
  });

  it('gives every body the five sections in order and no other heading', () => {
    for (const lesson of lessonsOf(ccna2())) {
      const headings = lesson.theory.split('\n').filter((line) => line.startsWith('#'));
      expect(headings, lesson.id).toEqual(SECTIONS);
      expect(lesson.theory.startsWith(SECTIONS[0]!), lesson.id).toBe(true);
      expect(lesson.theory, lesson.id).toBe(lesson.theory.trim());
    }
  });

  it('keeps every body inside the markdown subset, with no vendor name and a sane length', () => {
    for (const lesson of lessonsOf(ccna2())) {
      const text = lesson.theory;
      expect(text, lesson.id).not.toMatch(/[<>]/);
      expect(text, lesson.id).not.toMatch(/http:\/\//i);
      expect(text, lesson.id).not.toMatch(/!\[/);
      expect(text, lesson.id).not.toMatch(/&[a-z]+;/i);
      for (const m of text.matchAll(LINK)) expect(m[1], `${lesson.id}: ${m[0]}`).toMatch(ALLOWED_LINK);
      expect(text, lesson.id).not.toMatch(VENDORS);
      const n = text.split(/\s+/).filter((w) => /[A-Za-z0-9]/.test(w)).length;
      expect(n, `${lesson.id}: ${n} words`).toBeGreaterThanOrEqual(250);
      expect(n, `${lesson.id}: ${n} words`).toBeLessThanOrEqual(500);
    }
  });

  it('carries the video recorded for each lesson, and no lesson runs over 45 minutes', () => {
    for (const lesson of lessonsOf(ccna2())) {
      expect(lesson.video, lesson.id).toEqual(CCNA2_VIDEOS[lesson.id]);
      expect(lesson.estimatedMinutes, lesson.id).toBeLessThanOrEqual(45);
    }
  });

  /** The wireless videos, with the length each watch page gave (`lengthSeconds`) when they were checked in W7. */
  const WIRELESS_VIDEOS: Readonly<Record<string, { readonly youtubeId: string; readonly seconds: number }>> = {
    'ccna2-25-controllers-and-lightweight-aps': { youtubeId: 'ttdjSSmfLDI', seconds: 887 },
    'ccna2-26-channels-and-overlap': { youtubeId: 'uZyrJTfetNg', seconds: 558 },
    'ccna2-27-wlans-on-a-controller': { youtubeId: 'XJaw7PkzEvA', seconds: 2258 },
    'ccna2-28-securing-a-wlan': { youtubeId: 'KaqKoKNEKnE', seconds: 654 },
  };

  it('gives each wireless lesson the minutes its video and its theory need (238 words a minute)', () => {
    for (const [id, video] of Object.entries(WIRELESS_VIDEOS)) {
      const lesson = lessonById(id);
      expect(lesson?.video?.youtubeId, `${id} still shows the measured video`).toBe(video.youtubeId);
      const needed = video.seconds / 60 + words(body(id)) / 238;
      expect(lesson?.estimatedMinutes, `${id}: ${needed.toFixed(1)} min needed`).toBeGreaterThanOrEqual(needed);
    }
  });

  it('prints for lesson 27 only controller lines its lab types (address, gateway and DHCP server)', () => {
    const solution = SCENARIOS.find((s) => s.name === 'ccna2-wlc-wlan')?.solution;
    if (solution === undefined) throw new Error('ccna2-wlc-wlan has no reference solution');
    const lines = new Set(Object.values(solution).flat().map((l) => l.trim()));
    const printed = [...body('ccna2-27-wlans-on-a-controller').matchAll(/^ ?((?:address|gateway|dhcp-server) \d[^`\n]*)$/gm)].map((m) => (m[1] ?? '').trim());
    expect(printed.length, 'lesson 27 no longer shows the controller interface lines').toBeGreaterThanOrEqual(3);
    expect(printed.filter((l) => !lines.has(l))).toEqual([]);
  });

  it('says plainly what NetForge simplifies in the wireless lessons (§11.1, D17)', () => {
    const l25 = body('ccna2-25-controllers-and-lightweight-aps');
    expect(l25).toMatch(/answers association and the key handshake itself, then reports the client to the controller/);
    expect(l25).toMatch(/encryption is shown, not computed/);
    // §11.4: the Roaming objective is taught as theory in lesson 25 (C5 not built), so the body explains it — who
    // decides, where the client goes, why it keeps its address — and then says it is theory only (W7 review fix)
    const roaming = l25.split('\n').find((line) => line.startsWith('**Roaming.**')) ?? '';
    expect(roaming, 'lesson 25 has no Roaming paragraph under How it actually works').not.toBe('');
    expect(l25.indexOf(roaming)).toBeGreaterThan(l25.indexOf('## How it actually works'));
    expect(l25.indexOf(roaming)).toBeLessThan(l25.indexOf('## What trips people up'));
    expect(roaming).toMatch(/client, not the network, decides/);
    expect(roaming).toMatch(/same network name/);
    expect(roaming).toMatch(/keeps its address/);
    expect(roaming).toMatch(/mobility group/);
    expect(l25).toMatch(/Roaming is theory only\./);
    expect(body('ccna2-26-channels-and-overlap')).toMatch(/NetForge compares radios by main channel only/);
    expect(body('ccna2-28-securing-a-wlan')).toMatch(/enterprise security is theory here/);
    for (const id of ['ccna2-26-channels-and-overlap', 'ccna2-28-securing-a-wlan']) expect(lessonById(id)?.lab, id).toBeUndefined();
  });

  it('describes CCNA 2 in its own words, without promising the routing protocols of CCNA 3', () => {
    const course = ccna2();
    for (const text of [course.title, course.subtitle, course.description]) {
      expect(text).not.toMatch(/learn their routes|dynamic routing|not written yet/i);
      expect(text).not.toMatch(VENDORS);
    }
    expect(course.description).toMatch(/VLANs/);
    expect(course.description).toMatch(/spanning tree/);
    expect(course.description).toMatch(/controller/);
  });
});
