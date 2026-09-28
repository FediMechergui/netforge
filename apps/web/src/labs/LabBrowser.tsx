/**
 * Labs catalogue (ARCHITECTURE-P1 §4.13, §7 "Labs browser"): the scenarios `EngineApi.listScenarios` reports,
 * grouped by their topic, each with what it is about, how long it takes and a button that loads it.
 *
 * A lab whose `missingTypes` is non-empty is listed as unavailable with the equipment this build lacks, because
 * `loadScenario` would refuse it. Availability is shown as a lettered badge plus words, never colour alone, and
 * the whole list is ordinary buttons and headings, so it works from the keyboard and reads as a document.
 *
 * @since P2 (W6 web-learn, ARCHITECTURE-P2 §6, §11.2) The labs are grouped by COURSE first (`ScenarioMeta.course`:
 * the CCNA 1 labs, then the CCNA 2 labs, in the engine's catalogue order), then by topic inside each course, so two
 * courses that share a topic name keep their labs apart. The busy state says what the panel is doing (`LabWork`):
 * a check can run for a long time — a network that never goes quiet (a wrong EtherChannel answer, §9.2 item 22c)
 * keeps the grader's copy busy for about 17 s — so while one runs the panel shows a progress bar, the seconds so far
 * and, after a few seconds, why it can take a while (`LabWorkingNote`), and every load button stays disabled with the
 * reason. The seconds are wall time in the UI only; nothing here reaches the engine.
 *
 * Presentational only: LabPanel owns the engine calls and passes the list and the busy state in. Wording is
 * original (§1.6).
 *
 * ponytail: no search box and no sort — a few dozen labs under course and topic headings are read, not searched —
 * and the groups keep the order `listScenarios` gave them, which is the engine's own catalogue order.
 */
import { useEffect, useState } from 'react';
import type { ScenarioMeta } from '@netforge/engine';

/** Heading of a group of labs and the labs in it, in list order. */
export interface LabTopicGroup {
  readonly topic: string;
  readonly labs: readonly ScenarioMeta[];
}

/** @since P2 A course, its topics (in list order) and how many labs they hold. */
export interface LabCourseGroup {
  readonly course: string;
  readonly topics: readonly LabTopicGroup[];
  readonly count: number;
}

/** Topic shown for a lab that names none. */
export const OTHER_TOPIC = 'Other labs';

/** @since P2 Course heading of the labs that name no course. */
export const OTHER_COURSE = 'More labs';

/** Scenarios that are labs (a starting template is not one). */
export function isLab(meta: ScenarioMeta): boolean {
  return meta.category !== 'template';
}

/** Labs grouped by topic, topics and labs in the order `listScenarios` returned them. */
export function labsByTopic(scenarios: readonly ScenarioMeta[]): readonly LabTopicGroup[] {
  const groups = new Map<string, ScenarioMeta[]>();
  for (const meta of scenarios) {
    if (!isLab(meta)) continue;
    const topic = meta.topic ?? OTHER_TOPIC;
    const list = groups.get(topic);
    if (list === undefined) groups.set(topic, [meta]);
    else list.push(meta);
  }
  return [...groups].map(([topic, labs]) => ({ topic, labs }));
}

/**
 * @since P2 Labs grouped by course, then by topic inside the course: courses, topics and labs in the order
 * `listScenarios` returned them (a course or topic appears where its first lab does).
 */
export function labsByCourse(scenarios: readonly ScenarioMeta[]): readonly LabCourseGroup[] {
  const courses = new Map<string, ScenarioMeta[]>();
  for (const meta of scenarios) {
    if (!isLab(meta)) continue;
    const course = meta.course !== undefined && meta.course.trim() !== '' ? meta.course : OTHER_COURSE;
    const list = courses.get(course);
    if (list === undefined) courses.set(course, [meta]);
    else list.push(meta);
  }
  return [...courses].map(([course, labs]) => ({ course, topics: labsByTopic(labs), count: labs.length }));
}

/** Whether this build can load a lab, with the reason when it cannot. */
export function labAvailability(meta: ScenarioMeta): { readonly ok: true } | { readonly ok: false; readonly reason: string } {
  const missing = meta.missingTypes ?? [];
  if (missing.length === 0) return { ok: true };
  return { ok: false, reason: `This lab needs equipment this release does not have yet: ${missing.join(', ')}.` };
}

/** "25 min · 2 of 3 in difficulty" — the facts under a lab title, as words. */
export function labFacts(meta: ScenarioMeta): string {
  const parts: string[] = [];
  if (meta.estimatedMinutes !== undefined) parts.push(`about ${meta.estimatedMinutes} min`);
  if (meta.difficulty !== undefined) parts.push(`difficulty ${meta.difficulty} of 3`);
  if (meta.tasks !== undefined) parts.push(`${meta.tasks.length} task${meta.tasks.length === 1 ? '' : 's'}`);
  return parts.join(' · ');
}

// ── the busy state (§9.2 item 22c) ───────────────────────────────────────────

/** @since P2 What the labs panel is doing: nothing, loading a lab, or checking the learner's work. */
export type LabWork = 'idle' | 'loading' | 'checking';

/** Seconds after which a running check says why it can take a while. */
export const LAB_CHECK_SLOW_S = 5;

/** What the live region says once when a check starts (the running note is not live, so it never repeats). */
export const LAB_CHECK_ANNOUNCEMENT = 'Checking your work. A check usually takes a few seconds, sometimes up to half a minute.';

/** Why the load buttons are disabled while a check runs. */
export const LAB_CHECK_BLOCKS_OPEN = 'A check is running. The labs can be opened again when it ends.';

/** "1 lab" / "19 labs". */
export function labCountText(n: number): string {
  return `${n} lab${n === 1 ? '' : 's'}`;
}

/**
 * The words of the busy state: what is running and, for a check past `LAB_CHECK_SLOW_S`, the seconds so far and why
 * it can take a while. Empty when idle.
 */
export function labWorkText(work: LabWork, elapsedS = 0): string {
  switch (work) {
    case 'idle':
      return '';
    case 'loading':
      return 'Loading the lab…';
    case 'checking': {
      const s = Math.max(0, Math.floor(elapsedS));
      if (s < LAB_CHECK_SLOW_S) return 'Checking your work…';
      return `Still checking your work (${s} s so far). The grader runs a copy of your network until it goes quiet; a network that keeps changing takes longest.`;
    }
  }
}

/** Whole seconds since `work` last left 'idle' (0 while idle). Wall time, UI only. */
export function useWorkElapsed(work: LabWork): number {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    setElapsed(0);
    if (work === 'idle') return undefined;
    const started = Date.now();
    const timer = setInterval(() => setElapsed(Math.floor((Date.now() - started) / 1000)), 1000);
    return () => clearInterval(timer);
  }, [work]);
  return elapsed;
}

/**
 * The running note: an indeterminate progress bar and the words of `labWorkText`. Not a live region (the panel
 * announces the start and the result once); the bar is a named progress indicator a screen reader can find.
 */
export function LabWorkingNote({ work, elapsedS = 0 }: { readonly work: LabWork; readonly elapsedS?: number }) {
  if (work === 'idle') return null;
  const label = work === 'checking' ? 'Checking your work' : 'Loading the lab';
  return (
    <div className="insp-note lab-working" data-work={work}>
      <progress aria-label={label} style={{ display: 'block', width: '100%', marginBottom: 4 }} />
      <span>{labWorkText(work, elapsedS)}</span>
    </div>
  );
}

// ── the catalogue ────────────────────────────────────────────────────────────

export interface LabBrowserProps {
  readonly scenarios: readonly ScenarioMeta[];
  /** Lab currently loaded, so the list can say which one it is. */
  readonly activeName?: string | undefined;
  /** True while a lab is loading; every load button is disabled meanwhile. */
  readonly busy?: boolean;
  /** @since P2 What the panel is doing; anything but 'idle' disables the load buttons too, a check with its reason. */
  readonly work?: LabWork;
  readonly onOpen: (meta: ScenarioMeta) => void;
}

export function LabBrowser({ scenarios, activeName, busy = false, work = 'idle', onOpen }: LabBrowserProps) {
  const courses = labsByCourse(scenarios);
  if (courses.length === 0) return <p className="empty-hint">No labs are available in this release.</p>;
  const disabled = busy || work !== 'idle';
  return (
    <div className="dock-scroll" aria-busy={disabled}>
      {work === 'checking' && (
        <p className="insp-note">
          <span aria-hidden="true">⧗ </span>
          {LAB_CHECK_BLOCKS_OPEN}
        </p>
      )}
      {courses.map((course) => (
        <section key={course.course} aria-label={course.course}>
          <h4 className="panel-title">
            {course.course} <span className="dim">· {labCountText(course.count)}</span>
          </h4>
          {course.topics.map((group) => (
            <section key={group.topic} aria-label={`${course.course}: ${group.topic}`}>
              <h5 className="panel-title">{group.topic}</h5>
              <ul className="help-list">
                {group.labs.map((meta) => (
                  <LabRow key={meta.name} meta={meta} active={meta.name === activeName} disabled={disabled} onOpen={onOpen} />
                ))}
              </ul>
            </section>
          ))}
        </section>
      ))}
    </div>
  );
}

function LabRow({ meta, active, disabled, onOpen }: { meta: ScenarioMeta; active: boolean; disabled: boolean; onOpen: (meta: ScenarioMeta) => void }) {
  const availability = labAvailability(meta);
  const facts = labFacts(meta);
  return (
    <li>
      <div>
        <strong>{meta.title}</strong>
        {active && (
          <span className="chip">
            <span aria-hidden="true">▣ </span>open now
          </span>
        )}
        {!availability.ok && (
          <span className="chip">
            <span aria-hidden="true">⊘ </span>unavailable
          </span>
        )}
      </div>
      <div className="dim">{meta.description}</div>
      {facts !== '' && <div className="dim">{facts}</div>}
      {availability.ok ? (
        <button type="button" className="btn" disabled={disabled} onClick={() => onOpen(meta)}>
          {active ? `Reload ${meta.title}` : `Open ${meta.title}`}
        </button>
      ) : (
        <p className="insp-note">
          <span aria-hidden="true">⊘ </span>
          {availability.reason}
        </p>
      )}
    </li>
  );
}
