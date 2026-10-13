/**
 * curriculum/index.ts — the course catalogue the landing page lists (P2 course layer).
 *
 * The lessons of each course arrive as a skeleton (`ccnaN/lessons.ts`: order, titles, outcomes, lab links), the prose
 * as a map of bodies (`ccnaN/theory.ts`) and the videos as a map of verified links (`ccnaN/videos.ts`), all three
 * keyed by lesson id. `withContent` joins them, so a missing body or a lesson with no video degrades to an empty
 * theory and no video instead of breaking the catalogue. CCNA 2 is attached since P2 W7 (ARCHITECTURE-P2 §11.3), when
 * every lesson had its theory and every lab of the approved scope existed; CCNA 3 since P3 W7 (ARCHITECTURE-P3 §7 W7
 * course, §11.3), when its 40 lessons had their theory and the 21 labs of the approved plan existed. That change is
 * also the profile flip (§8.5 P15): `LATEST_DEFAULTS_PROFILE` became 'P3' with it, and the web's `profileForCourse`
 * reads `Course.profile` from then on. The next level, the security track, is announced as a planned card with no
 * lessons (§8.5 P11).
 *
 * `COURSES` is plain data all the way down and can be posted from the worker as is.
 *
 * ponytail: one flat exported list, like `SCENARIOS` — the landing page groups by `status` and `level` itself, and
 * a lookup only ever needs an id. Planned levels are listed with no modules rather than with invented lessons.
 * The content maps are joined at module scope, for CCNA 2 and CCNA 3 exactly as for CCNA 1: that is safe
 * (ARCHITECTURE-P2 §0 rule 12 guards against import cycles) because every `ccnaN/*` file imports only contract types
 * and its own siblings, so none of them can reach back into this module.
 */
import type { Course, CourseModule, Lesson, LessonTheoryMap, LessonVideoMap } from '../contracts/curriculum.js';
import { lessonsOf } from '../contracts/curriculum.js';
import { CCNA1_MODULES } from './ccna1/lessons.js';
import { CCNA1_THEORY } from './ccna1/theory.js';
import { CCNA1_VIDEOS } from './ccna1/videos.js';
import { CCNA2_MODULES } from './ccna2/lessons.js';
import { CCNA2_THEORY } from './ccna2/theory.js';
import { CCNA2_VIDEOS } from './ccna2/videos.js';
import { CCNA3_MODULES } from './ccna3/lessons.js';
import { CCNA3_THEORY } from './ccna3/theory.js';
import { CCNA3_VIDEOS } from './ccna3/videos.js';

export { CCNA1_MODULES } from './ccna1/lessons.js';

/** Join a lesson skeleton with the theory bodies and videos written for it. */
export function withContent(
  modules: readonly CourseModule[],
  theory: LessonTheoryMap,
  videos: LessonVideoMap,
): readonly CourseModule[] {
  return modules.map((module) => ({
    ...module,
    lessons: module.lessons.map((lesson): Lesson => {
      const body = theory[lesson.id];
      const video = videos[lesson.id];
      return {
        ...lesson,
        theory: body ?? lesson.theory,
        ...(video === undefined ? {} : { video }),
      };
    }),
  }));
}

const CCNA1: Course = {
  id: 'ccna1',
  level: 'CCNA 1',
  title: 'Networks from the ground up',
  subtitle: 'Cables, addresses, routing and the services that sit on top',
  description:
    'Start with nothing and finish able to build a small routed network, hand out addresses, publish a name and a page, and find a fault instead of guessing at it. Every idea is explained in plain language, shown in a short video and then practised in a lab that grades itself.',
  status: 'available',
  modules: withContent(CCNA1_MODULES, CCNA1_THEORY, CCNA1_VIDEOS),
  // P3 (ARCHITECTURE-P3 D2, §7 W0 course, §9.2 W0 item 12): data since W0; read by the web's profileForCourse since the
  // W7 course flip, so a CCNA 1 lesson keeps opening classic worlds.
  profile: 'P1',
};

const CCNA2: Course = {
  id: 'ccna2',
  level: 'CCNA 2',
  title: 'Switching, routing and wireless at scale',
  subtitle: 'VLANs, spanning tree, redundancy, static routes and wireless controllers',
  description:
    'Grow from one switch to a campus: split it into VLANs and route between them, let spanning tree tame redundant links, bundle links and share a gateway, lock down the access ports, run many access points from one controller, and write every kind of static route and address translation. Every idea is explained in plain language, shown in a short video and practised in a lab that grades itself.',
  status: 'available',
  modules: withContent(CCNA2_MODULES, CCNA2_THEORY, CCNA2_VIDEOS),
  profile: 'P2',
};

const CCNA3: Course = {
  id: 'ccna3',
  level: 'CCNA 3',
  title: 'Wide area networks and automation',
  subtitle: 'Links between sites, access control and scripted configuration',
  description:
    'Run the network of a whole organisation: let OSPF and EIGRP find the routes for you, decide who may reach what with access lists, lock down device logins and the access ports, join distant sites over serial links, tunnels and IPsec, put voice ahead of bulk traffic, keep every clock and log in step, and change devices through their API and a short script. Every idea is explained in plain language, and most come with a short video and a lab that grades itself.',
  status: 'available',
  modules: withContent(CCNA3_MODULES, CCNA3_THEORY, CCNA3_VIDEOS),
  // P3 W7: read by the web's profileForCourse from this change on, so a CCNA 3 lesson opens a P3 world
  profile: 'P3',
};

/**
 * The next level (ARCHITECTURE-P3 §8.5 P11): the security track planned for P4, announced with no lessons so the
 * landing page keeps one planned card. Its worlds would take the newest defaults; required at W8 ('P3').
 */
const SECURITY: Course = {
  id: 'security',
  level: 'Security',
  title: 'Defending the network',
  subtitle: 'Firewalls, intrusion prevention, remote-access VPNs and incident response',
  description:
    'The next level: watch attacks unfold on a practice range and learn to stop them with firewalls, intrusion prevention, remote-access VPNs and logs gathered in one place, then follow a calm method when something gets through. Not written yet.',
  status: 'planned',
  modules: [],
  profile: 'P3',
};

/** Every course, in level order: the ones you can take, then the one that is coming. */
export const COURSES: readonly Course[] = [CCNA1, CCNA2, CCNA3, SECURITY];

export function courseById(id: string): Course | undefined {
  return COURSES.find((c) => c.id === id);
}

/** The lesson with this id, from whichever course holds it. */
export function lessonById(id: string): Lesson | undefined {
  for (const course of COURSES) {
    const lesson = lessonsOf(course).find((l) => l.id === id);
    if (lesson !== undefined) return lesson;
  }
  return undefined;
}
