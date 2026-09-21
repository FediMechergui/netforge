/**
 * learn/CourseView.tsx — one level, module by module (P2 course layer): what each module is for and the lessons
 * inside it in teaching order, each a button that opens the lesson.
 *
 * Presentational, like `labs/LabBrowser`: the course comes in as data and picking a lesson is a callback. A row
 * carries the title, the outcome, the minutes and the markers for "has a video" and "has a lab" — every marker is
 * a glyph AND a word, so none of them depends on colour.
 *
 * ponytail: the row is one button with the whole row inside it, not a heading plus a separate "open" control —
 * one tab stop per lesson, and the accessible name is the title and the outcome, which is what you are choosing.
 */
import { lessonsOf, type Course, type Lesson } from '@netforge/engine';
import { courseFactsText } from './Landing';

export interface CourseViewProps {
  readonly course: Course;
  readonly onOpenLesson: (lessonId: string) => void;
  /** Lesson shown as the one you are on, when the learner came back from it. */
  readonly currentLessonId?: string | null;
}

/** A marker on a lesson row: a glyph for the eye, a word for everything else. */
export interface LessonMark {
  readonly glyph: string;
  readonly label: string;
}

/** What a lesson offers, in a fixed order: the time, then the video, then the lab. */
export function lessonMarks(lesson: Lesson): readonly LessonMark[] {
  const marks: LessonMark[] = [{ glyph: '◔', label: `${lesson.estimatedMinutes} min` }];
  if (lesson.video !== undefined) marks.push({ glyph: '▶', label: 'video' });
  if (lesson.lab !== undefined) marks.push({ glyph: '▣', label: 'lab' });
  return marks;
}

export function LessonRow({ lesson, current, onOpen }: { readonly lesson: Lesson; readonly current: boolean; readonly onOpen: () => void }) {
  return (
    <li>
      <button type="button" className={`learn-lesson${current ? ' is-current' : ''}`} onClick={onOpen}>
        <span className="learn-lesson-title">
          {lesson.title}
          {current && <span className="dim"> — where you left off</span>}
        </span>
        <span className="learn-marks">
          {lessonMarks(lesson).map((m) => (
            <span key={m.label} className="chip">
              <span aria-hidden="true">{m.glyph} </span>
              {m.label}
            </span>
          ))}
        </span>
        <span className="dim learn-lesson-outcome">{lesson.outcome}</span>
      </button>
    </li>
  );
}

export function CourseView({ course, onOpenLesson, currentLessonId = null }: CourseViewProps) {
  const empty = lessonsOf(course).length === 0;
  return (
    <div className="learn-page">
      <p className="chip">{course.level}</p>
      <h1>{course.title}</h1>
      <p className="learn-lead">{course.subtitle}</p>
      <p className="dim">{course.description}</p>
      <p className="dim">{courseFactsText(course)}</p>

      {empty ? (
        <p className="empty-hint">This level has no lessons in this release yet.</p>
      ) : (
        course.modules.map((module, i) => (
          <section key={module.id} aria-label={module.title} className="learn-module">
            <h2>
              <span className="dim">{i + 1}. </span>
              {module.title}
            </h2>
            <p className="dim">{module.summary}</p>
            <ol className="learn-lessons">
              {module.lessons.map((lesson) => (
                <LessonRow key={lesson.id} lesson={lesson} current={lesson.id === currentLessonId} onOpen={() => onOpenLesson(lesson.id)} />
              ))}
            </ol>
          </section>
        ))
      )}
    </div>
  );
}
