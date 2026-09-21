/**
 * learn/LessonView.tsx — one lesson (P2 course layer): the idea in plain words, the video that shows it, and the
 * lab that makes you do it. Theory → video → practice, one click each.
 *
 * The theory is the SAME markdown subset the labs use and goes through the SAME parser and renderers
 * (`labs/markdown.ts` + `Markdown` from `labs/LabPanel`), so lesson prose can no more become markup than lab
 * instructions can, and a `concept:` link opens the concept tool exactly as it does inside a lab. A body starts
 * its sections at `##`, and `baseLevel={2}` renders those as h3 — one step under the h2 that names the section,
 * which is itself one step under the lesson's h1. Changing either end of that without the other leaves a gap in
 * the heading ladder, which is what a screen-reader user navigates by.
 *
 * Nothing is faked: a lesson with no video renders no player and loads nothing from anywhere, and a lesson with
 * no lab has no "Open the lab" button to press. The lab's own facts come from the scenario catalogue when the
 * host has read it, so the minutes and task count are never restated here.
 *
 * ponytail: presentational — the host does the engine call and the view switch; this file decides only what a
 * lesson looks like. Previous / next are optional, so the view renders on its own in a test.
 */
import type { Lesson, ScenarioMeta } from '@netforge/engine';
import { labFacts } from '../labs/LabBrowser';
import { Markdown } from '../labs/LabPanel';
import { parseMarkdown, type ConceptLinkTool } from '../labs/markdown';
import { VideoEmbed } from './VideoEmbed';

/** A neighbour lesson, as much of it as the footer needs. */
export interface LessonLink {
  readonly id: string;
  readonly title: string;
}

export interface LessonViewProps {
  readonly lesson: Lesson;
  /** The lab `lesson.lab` names, once the host has read the scenario catalogue. */
  readonly lab?: ScenarioMeta | null;
  /** Load the lab and leave for the sandbox; absent while the host cannot. */
  readonly onOpenLab?: ((labName: string) => void) | undefined;
  readonly onConcept?: ((tool: ConceptLinkTool) => void) | undefined;
  readonly onOpenLesson?: ((lessonId: string) => void) | undefined;
  readonly previous?: LessonLink | null;
  readonly next?: LessonLink | null;
  /** True while the lab is loading; the action says so and is disabled. */
  readonly busy?: boolean;
}

/** "about 12 min to read and watch, then about 25 min in the lab" — the time a lesson asks for, as words. */
export function lessonTimeText(lesson: Lesson, lab?: ScenarioMeta | null): string {
  const head = `about ${lesson.estimatedMinutes} min to read and watch`;
  const labMinutes = lab?.estimatedMinutes;
  return labMinutes === undefined ? head : `${head}, then about ${labMinutes} min in the lab`;
}

export function LessonView({ lesson, lab = null, onOpenLab, onConcept, onOpenLesson, previous = null, next = null, busy = false }: LessonViewProps) {
  const blocks = parseMarkdown(lesson.theory ?? '');
  const labName = lesson.lab;

  return (
    <article className="learn-page">
      <p className="chip">{lesson.topic}</p>
      <h1>{lesson.title}</h1>
      <p className="learn-lead">{lesson.outcome}</p>
      <p className="dim">{lessonTimeText(lesson, lab)}</p>

      <section aria-label="The idea" className="learn-section">
        <h2>The idea</h2>
        <div className="learn-body">
          {blocks.length === 0 ? <p className="empty-hint">The written explanation for this lesson is not ready yet.</p> : <Markdown blocks={blocks} onConcept={onConcept} baseLevel={2} />}
        </div>
      </section>

      {lesson.video !== undefined && (
        <section aria-label="Watch it" className="learn-section">
          <h2>Watch it</h2>
          <VideoEmbed video={lesson.video} />
        </section>
      )}

      {labName !== undefined && (
        <section aria-label="Practise it" className="learn-section">
          <h2>Practise it</h2>
          <p>{lab === null ? 'This lesson has a lab: the workspace opens with the equipment in place and grades your work as you go.' : lab.description}</p>
          {lab !== null && labFacts(lab) !== '' && <p className="dim">{labFacts(lab)}</p>}
          {onOpenLab !== undefined && (
            <button type="button" className="btn btn-primary" disabled={busy} onClick={() => onOpenLab(labName)}>
              {busy ? 'Opening the lab…' : 'Open the lab'}
            </button>
          )}
        </section>
      )}

      {(previous !== null || next !== null) && onOpenLesson !== undefined && (
        <nav className="learn-nav" aria-label="Lessons either side of this one">
          {previous !== null && (
            <button type="button" className="btn" onClick={() => onOpenLesson(previous.id)}>
              <span aria-hidden="true">← </span>
              {previous.title}
            </button>
          )}
          {next !== null && (
            <button type="button" className="btn" onClick={() => onOpenLesson(next.id)}>
              {next.title}
              <span aria-hidden="true"> →</span>
            </button>
          )}
        </nav>
      )}
    </article>
  );
}
