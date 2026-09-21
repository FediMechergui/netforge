/**
 * learn/LearnShell.tsx — the host of the course layer (P2): which learn surface is up, what it shows, and the
 * three doors out of it (the sandbox, a concept tool, a lab).
 *
 * The shell covers the window while `store.view` is a learn surface; App keeps the sandbox grid mounted and
 * hidden behind it, so the canvas scene, the open consoles and the dock are all exactly as they were when the
 * learner goes back (the rule concept tools already follow, ARCHITECTURE-P1 §4.13).
 *
 * Opening a lab is the one place this layer talks to the engine: the scenario catalogue is read on demand,
 * `loadLab` (labs/LabPanel) rebuilds the world at the lab's seed, the Labs tab is brought up on the dock, and
 * the view switches to the topology — theory, then video, then practice, one click each. A lab the catalogue
 * does not have says so instead of leaving a dead button.
 *
 * The scroll region is this page's ONLY `main` landmark — while the course layer is up the sandbox's own `main`
 * is inside the hidden grid and so out of the accessibility tree. The three surfaces swap inside it, which means
 * React keeps the same element across a move, so the shell resets its scroll and puts focus on it whenever the
 * surface changes; without that a lesson opens part-scrolled and focus falls back to the document body.
 *
 * ponytail: the course catalogue is plain data in the engine package (`COURSES`), so it is imported directly —
 * no worker round trip and nothing of it copied into the store, which holds two ids and nothing more.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { COURSES, courseById, lessonById, lessonsOf, type Course, type Lesson, type ScenarioMeta } from '@netforge/engine';
import { engine } from '../bridge/client';
import { loadLab } from '../labs/LabPanel';
import { showDockTab } from '../shared/openDeviceSurface';
import { useStore } from '../store/store';
import { CourseView } from './CourseView';
import { Landing } from './Landing';
import { LessonView, type LessonLink } from './LessonView';
import './learn.css';

/** The lessons either side of one, in course order; nulls at the two ends. */
export function neighbours(course: Course | undefined, lessonId: string): { readonly previous: LessonLink | null; readonly next: LessonLink | null } {
  const lessons = course === undefined ? [] : lessonsOf(course);
  const at = lessons.findIndex((l) => l.id === lessonId);
  const link = (l: Lesson | undefined): LessonLink | null => (l === undefined ? null : { id: l.id, title: l.title });
  return at < 0 ? { previous: null, next: null } : { previous: link(lessons[at - 1]), next: link(lessons[at + 1]) };
}

/** The course that holds a lesson, for a lesson opened without one (a restored id, a direct link). */
function courseOfLesson(lessonId: string): Course | undefined {
  return COURSES.find((c) => lessonsOf(c).some((l) => l.id === lessonId));
}

export function LearnShell() {
  const view = useStore((s) => s.view);
  const learn = useStore((s) => s.learn);
  const showLearn = useStore((s) => s.showLearn);
  const setView = useStore((s) => s.setView);
  const setLab = useStore((s) => s.setLab);
  const [scenarios, setScenarios] = useState<readonly ScenarioMeta[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const scroll = useRef<HTMLElement | null>(null);

  const lesson = view === 'lesson' && learn?.lessonId != null ? lessonById(learn.lessonId) : undefined;
  const course = (learn?.courseId != null ? courseById(learn.courseId) : undefined) ?? (lesson === undefined ? undefined : courseOfLesson(lesson.id));
  const labName = lesson?.lab;

  // Same element, different page: React reuses `main.learn-scroll` across a move between surfaces, so its
  // scrollTop survives and the button that was clicked is unmounted under the pointer. Start the new page at the
  // top and give it focus, which is also where a screen reader begins reading and where Tab resumes.
  useEffect(() => {
    const el = scroll.current;
    if (el === null) return;
    el.scrollTop = 0;
    el.focus();
  }, [view, learn?.courseId, learn?.lessonId]);

  // The catalogue is only needed to describe a lab and to load it; a lesson without one never asks for it.
  useEffect(() => {
    if (labName === undefined || scenarios.length > 0) return;
    let alive = true;
    engine
      .listScenarios()
      .then((list) => {
        if (alive) setScenarios(list);
      })
      .catch(() => {
        /* The lab button still works: loadLab reports its own refusal. */
      });
    return () => {
      alive = false;
    };
  }, [labName, scenarios.length]);

  // The sandbox shortcuts belong to a workspace that is not on screen: Space plays the simulation, digits switch
  // dock tabs, Delete removes a device — and Space is also how you scroll a page you are reading. While the
  // course layer covers the window, an unmodified key press stops in the capture phase, before the global
  // handler (app/hotkeys.ts) sees it; Ctrl/Cmd combinations (save, open a project) still pass. Default actions
  // are untouched, so scrolling, Tab and Enter on a button all behave normally.
  useEffect(() => {
    const swallow = (e: KeyboardEvent): void => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      e.stopPropagation();
    };
    window.addEventListener('keydown', swallow, true);
    window.addEventListener('keyup', swallow, true);
    return () => {
      window.removeEventListener('keydown', swallow, true);
      window.removeEventListener('keyup', swallow, true);
    };
  }, []);

  const openLesson = useCallback(
    (lessonId: string): void => {
      setMessage(null);
      showLearn?.('lesson', { lessonId, courseId: courseOfLesson(lessonId)?.id ?? learn?.courseId ?? null });
    },
    [showLearn, learn?.courseId],
  );

  const openLab = useCallback(
    async (name: string): Promise<void> => {
      setBusy(true);
      setMessage(null);
      const meta = scenarios.find((s) => s.name === name) ?? (await engine.listScenarios().catch(() => [])).find((s) => s.name === name);
      if (meta === undefined) {
        setMessage('That lab is not part of this release yet.');
        setBusy(false);
        return;
      }
      const result = await loadLab(meta);
      if (result.ok) {
        setLab?.({ active: meta, browserOpen: false });
        showDockTab('labs');
        setView?.('topology');
      }
      setMessage(result.ok ? null : result.message);
      setBusy(false);
    },
    [scenarios, setLab, setView],
  );

  const lab = labName === undefined ? null : (scenarios.find((s) => s.name === labName) ?? null);
  const crumbs: { readonly label: string; readonly onClick: () => void }[] = [];
  if (view !== 'landing') crumbs.push({ label: 'All levels', onClick: () => showLearn?.('landing') });
  if (view === 'lesson' && course !== undefined) crumbs.push({ label: course.level, onClick: () => showLearn?.('course', { courseId: course.id }) });

  return (
    <div className="learn">
      <header className="learn-bar">
        <span className="brand">NetForge</span>
        <nav aria-label="Where you are" className="learn-crumbs">
          {crumbs.map((c) => (
            <button key={c.label} type="button" className="btn btn-ghost" onClick={c.onClick}>
              <span aria-hidden="true">← </span>
              {c.label}
            </button>
          ))}
        </nav>
        <span className="spacer" />
        <button type="button" className="btn" onClick={() => setView?.('topology')}>
          Open the sandbox
        </button>
      </header>

      {/* Mounted before there is a message, so a screen reader hears why a lab did not open (§16). */}
      <p className={`insp-note${message === null ? ' is-empty' : ''}`} role="status" aria-live="polite">
        {message}
      </p>

      <main className="learn-scroll" ref={scroll} tabIndex={-1}>
        {lesson !== undefined ? (
          <LessonView
            lesson={lesson}
            lab={lab}
            busy={busy}
            onOpenLab={(name) => void openLab(name)}
            onConcept={(tool) => setView?.('concept', tool)}
            onOpenLesson={openLesson}
            {...neighbours(course, lesson.id)}
          />
        ) : view === 'course' && course !== undefined ? (
          <CourseView course={course} onOpenLesson={openLesson} currentLessonId={learn?.lessonId ?? null} />
        ) : (
          <Landing
            onOpenCourse={(courseId) => showLearn?.('course', { courseId })}
            onOpenSandbox={() => setView?.('topology')}
          />
        )}
      </main>
    </div>
  );
}
