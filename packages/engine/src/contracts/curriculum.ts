/**
 * contracts/curriculum.ts — the course layer that wraps the labs (course layer).
 *
 * A `Course` is a level (CCNA 1) split into modules, each a short run of lessons. A `Lesson` carries the plain
 * language explanation (`theory`, in the markdown subset the labs already use), an optional verified video and,
 * when one of the built-in labs practises exactly that lesson, the `name` of that `ScenarioInfo` — never a copy of
 * the lab, just a pointer the UI resolves through the scenario catalogue it already loads.
 *
 * Everything here is plain data: strings, numbers and arrays only, so the whole catalogue survives a
 * `postMessage` from the worker (the same rule `ScenarioMeta` follows). The helpers are pure and derived, so they
 * stay out of the cloned payload.
 *
 * ponytail: the lesson is the unit of content and the lab is a reference, not an embedded copy — a lab edited in
 * sim/scenarios is automatically the lab the lesson opens, and nothing has to be kept in sync by hand.
 */

import type { DefaultsProfile } from './catalog.js';

/** One published video that explains a lesson. `url` is the full watch link (https only, no raw HTML anywhere). */
export interface LessonVideo {
  youtubeId: string;
  title: string;
  channel: string;
  url: string;
}

export interface Lesson {
  /** Stable kebab-case id, ordered inside the course ('ccna1-01-what-is-a-network'). */
  id: string;
  title: string;
  /** One sentence: what the learner can do after this lesson. */
  outcome: string;
  /** Plain-language body in the markdown subset; filled by the theory files. */
  theory: string;
  /** Verified YouTube video, or undefined when none was found. */
  video?: LessonVideo;
  /** `ScenarioInfo.name` of the lab that practises this lesson, when one exists. */
  lab?: string;
  /**
   * @since P3c (optional by meaning) A second verified video on the lesson's hands-on part (ARCHITECTURE-P3C D5, ruling
   * X-5): the lessons that gain a lab in P3c (08, 09, 30, 31, 39) carry one when a candidate passes the P3a verification
   * rule; absent otherwise, and on every P1, P2 and P3a lesson. The lesson minutes include it.
   */
  labVideo?: LessonVideo;
  /** Reading and watching time for this lesson alone; the lab adds its own `estimatedMinutes`. */
  estimatedMinutes: number;
  /** Topic cluster, shared with `ScenarioMeta.topic` so a lesson and its lab file under the same heading. */
  topic: string;
}

export interface CourseModule {
  id: string;
  title: string;
  summary: string;
  lessons: readonly Lesson[];
}

/** 'available' courses have modules and can be opened; 'planned' ones are announced with no lessons. */
export type CourseStatus = 'available' | 'planned';

export interface Course {
  id: string;
  /** Short level badge for the landing page ('CCNA 1'). */
  level: string;
  title: string;
  subtitle: string;
  description: string;
  status: CourseStatus;
  modules: readonly CourseModule[];
  /**
   * @since P3 The defaults profile a world opened from this course takes (ARCHITECTURE-P3 D2): data from W0 (ccna1 'P1',
   * ccna2 'P2', ccna3 'P3'). Read since the W7 course flip: `profileForCourse(id) = courseById(id)?.profile ??
   * LATEST_DEFAULTS_PROFILE` (the fallback only for an unknown id). Required since the P3a exit gate (W8 item 45).
   */
  profile: DefaultsProfile;
}

/** Theory bodies by lesson id (markdown subset), contributed by `curriculum/<course>/theory.ts`. */
export type LessonTheoryMap = Readonly<Record<string, string>>;

/** Verified videos by lesson id, contributed by `curriculum/<course>/videos.ts`. */
export type LessonVideoMap = Readonly<Record<string, LessonVideo>>;

/** Every lesson of a course in teaching order, modules flattened away. */
export function lessonsOf(course: Course): readonly Lesson[] {
  return course.modules.flatMap((m) => m.lessons);
}

/** Lab name → the first lesson that practises it, so a lab view can link back to its lesson. */
export function labLessonMap(course: Course): ReadonlyMap<string, Lesson> {
  const map = new Map<string, Lesson>();
  for (const lesson of lessonsOf(course)) {
    if (lesson.lab !== undefined && !map.has(lesson.lab)) map.set(lesson.lab, lesson);
  }
  return map;
}
