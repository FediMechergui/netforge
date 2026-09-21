/**
 * curriculum/index.ts — the course catalogue the landing page lists (P2 course layer).
 *
 * The lessons arrive as a skeleton (`ccna1/lessons.ts`: order, titles, outcomes, lab links), the prose as a map of
 * bodies (`ccna1/theory.ts`) and the videos as a map of verified links (`ccna1/videos.ts`), all three keyed by
 * lesson id. `withContent` joins them, so a missing body or a lesson with no video degrades to an empty theory
 * and no video instead of breaking the catalogue.
 *
 * `COURSES` is plain data all the way down and can be posted from the worker as is.
 *
 * ponytail: one flat exported list, like `SCENARIOS` — the landing page groups by `status` and `level` itself, and
 * a lookup only ever needs an id. Planned levels are listed with no modules rather than with invented lessons.
 */
import type { Course, CourseModule, Lesson, LessonTheoryMap, LessonVideoMap } from '../contracts/curriculum.js';
import { lessonsOf } from '../contracts/curriculum.js';
import { CCNA1_MODULES } from './ccna1/lessons.js';
import { CCNA1_THEORY } from './ccna1/theory.js';
import { CCNA1_VIDEOS } from './ccna1/videos.js';

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
  subtitle: 'VLANs, trunking, dynamic routing and redundancy',
  description:
    'The next level: many switches instead of one, traffic separated into VLANs, routers that learn their routes instead of being told them, and networks built to survive a failed link. Not written yet.',
  status: 'planned',
  modules: [],
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

/** Every course, in level order: the one you can take, then the ones that are coming. */
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
