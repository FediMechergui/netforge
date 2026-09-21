/**
 * learn/Landing.tsx — the first page of the product (P2 course layer): what this is in one line, the levels you
 * can pick from, and the door straight into the sandbox for someone who only wants to build something.
 *
 * Presentational: the courses come in as plain data (`COURSES` by default) and every action is a callback, so
 * the page renders in a test with no store, no worker and no engine. The counts under a level are derived here
 * rather than written into the catalogue, so a lesson or a lab added upstream is counted the moment it lands.
 *
 * A level that is not written yet is announced as such: no button, no disabled control to tab into — a chip with
 * a glyph AND the word "planned", plus a line saying what it will cover. Availability is never a colour.
 *
 * ponytail: one flat list of level cards, in catalogue order. No hero image, no marketing section, no router —
 * the shell owns which surface is up, this page only says what there is to pick.
 */
import { COURSES, lessonsOf, type Course } from '@netforge/engine';

export interface LandingProps {
  readonly courses?: readonly Course[];
  /** Open a level (only called for a course whose `status` is 'available'). */
  readonly onOpenCourse: (courseId: string) => void;
  /** Leave the course layer for the simulator as it is. */
  readonly onOpenSandbox: () => void;
}

/** What a level is worth, counted from its lessons. */
export interface CourseFacts {
  readonly modules: number;
  readonly lessons: number;
  /** Lessons that carry a lab to practise in. */
  readonly labs: number;
  /** Reading and watching minutes, the labs' own time not included. */
  readonly minutes: number;
}

export function courseFacts(course: Course): CourseFacts {
  const lessons = lessonsOf(course);
  return {
    modules: course.modules.length,
    lessons: lessons.length,
    labs: lessons.filter((l) => l.lab !== undefined).length,
    minutes: lessons.reduce((total, l) => total + (l.estimatedMinutes ?? 0), 0),
  };
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** "7 modules · 31 lessons · 15 of them with a lab · about 6 h of reading" — the facts as words. */
export function courseFactsText(course: Course): string {
  const f = courseFacts(course);
  if (f.lessons === 0) return 'No lessons in this release.';
  const hours = f.minutes >= 90 ? `about ${Math.round(f.minutes / 60)} h of reading and watching` : `about ${f.minutes} min of reading and watching`;
  return [plural(f.modules, 'module'), plural(f.lessons, 'lesson'), `${f.labs} of them with a lab`, hours].join(' · ');
}

/** Availability as a glyph and a word, so the state never rests on colour. */
export function courseMark(course: Course): { readonly glyph: string; readonly label: string } {
  return course.status === 'available' ? { glyph: '▣', label: 'available' } : { glyph: '◷', label: 'planned' };
}

function LevelCard({ course, onOpen }: { readonly course: Course; readonly onOpen: (id: string) => void }) {
  const mark = courseMark(course);
  const open = course.status === 'available' && course.modules.length > 0;
  return (
    <li className="learn-card">
      <div className="learn-card-top">
        <span className="chip">{course.level}</span>
        <span className="chip">
          <span aria-hidden="true">{mark.glyph} </span>
          {mark.label}
        </span>
      </div>
      <h3>{course.title}</h3>
      <p className="learn-card-sub">{course.subtitle}</p>
      <p className="dim">{course.description}</p>
      <p className="dim">{courseFactsText(course)}</p>
      {open ? (
        <button type="button" className="btn btn-primary" onClick={() => onOpen(course.id)}>
          Start {course.level}
        </button>
      ) : (
        <p className="insp-note">
          <span aria-hidden="true">◷ </span>
          Not available yet — there is nothing to open on this level in this release.
        </p>
      )}
    </li>
  );
}

export function Landing({ courses = COURSES, onOpenCourse, onOpenSandbox }: LandingProps) {
  return (
    <div className="learn-page">
      {/* A div, not a header: the shell's own learn-bar is this page's banner, and a second one would make
          landmark navigation ambiguous. The h1 below already names the page. */}
      <div className="learn-hero">
        <h1>Learn a network by building one</h1>
        <p className="learn-lead">
          Every idea is explained in plain words, shown in a short video, then built by you in a simulator that
          grades your work. Nothing is installed and nothing leaves this browser.
        </p>
        <div className="learn-actions">
          <button type="button" className="btn" onClick={onOpenSandbox}>
            Open the sandbox
          </button>
          <span className="dim">The full simulator with an empty canvas: every device, no lesson attached.</span>
        </div>
      </div>

      <section aria-label="Levels">
        <h2>Pick a level</h2>
        <ul className="learn-cards">
          {courses.map((course) => (
            <LevelCard key={course.id} course={course} onOpen={onOpenCourse} />
          ))}
        </ul>
      </section>
    </div>
  );
}
