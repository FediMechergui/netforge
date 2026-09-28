/**
 * curriculum/index.ts — the course catalogue the landing page lists (P2 course layer).
 *
 * The lessons of each course arrive as a skeleton (`ccna1/lessons.ts`, `ccna2/lessons.ts`: order, titles, outcomes,
 * lab links), the prose as a map of bodies (`ccna1/theory.ts`, `ccna2/theory.ts`) and the videos as a map of
 * verified links (`ccna1/videos.ts`, `ccna2/videos.ts`), all three keyed by lesson id. `withContent` joins them, so
 * a missing body or a lesson with no video degrades to an empty theory and no video instead of breaking the
 * catalogue. CCNA 2 is attached since P2 W7 (ARCHITECTURE-P2 §11.3), when every lesson had its theory and every lab
 * of the approved scope existed.
 *
 * `COURSES` is plain data all the way down and can be posted from the worker as is.
 *
 * ponytail: one flat exported list, like `SCENARIOS` — the landing page groups by `status` and `level` itself, and
 * a lookup only ever needs an id. Planned levels are listed with no modules rather than with invented lessons.
 * The content maps are joined at module scope, for CCNA 2 exactly as for CCNA 1: that is safe (ARCHITECTURE-P2 §0
 * rule 12 guards against import cycles) because every `ccnaN/*` file imports only contract types and its own siblings,
 * so none of them can reach back into this module.
 */
import type { Course, CourseModule, Lesson, LessonTheoryMap, LessonVideoMap } from '../contracts/curriculum.js';
import { lessonsOf } from '../contracts/curriculum.js';
import { CCNA1_MODULES } from './ccna1/lessons.js';
import { CCNA1_THEORY } from './ccna1/theory.js';
import { CCNA1_VIDEOS } from './ccna1/videos.js';
import { CCNA2_MODULES } from './ccna2/lessons.js';
import { CCNA2_THEORY } from './ccna2/theory.js';
import { CCNA2_VIDEOS } from './ccna2/videos.js';

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
};

const CCNA3: Course = {
  id: 'ccna3',
  level: 'CCNA 3',
  title: 'Wide area networks and automation',
  subtitle: 'Links between sites, access control and scripted configuration',
  description:
    'The last level: joining sites over long links, controlling who may reach what, and letting a script do the configuration you would otherwise type. Not written yet.',
  status: 'planned',
  modules: [],
};

/** Every course, in level order: the ones you can take, then the one that is coming. */
export const COURSES: readonly Course[] = [CCNA1, CCNA2, CCNA3];

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
