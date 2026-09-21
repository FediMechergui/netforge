// Course layer entry (P2 learn/): the landing page that lists the levels, the course view that lists the modules
// and their lessons in order with the non-colour markers, and the store side of it — the view a visit starts on,
// the ids a learn surface carries, and the escape into the sandbox.
import { beforeEach, describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { COURSES, courseById, lessonsOf } from '@netforge/engine';
import type { Course, Lesson } from '@netforge/engine';
import { Landing, courseFacts, courseFactsText, courseMark } from '../src/learn/Landing';
import { CourseView, lessonMarks } from '../src/learn/CourseView';
import { ENTRY_VIEW_KEY, entryViewOf, store } from '../src/store/store';

function text(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ');
}

const noop = (): void => undefined;

function lesson(id: string, extra: Partial<Lesson> = {}): Lesson {
  return { id, title: `Lesson ${id}`, outcome: `Outcome ${id}`, theory: '', estimatedMinutes: 10, topic: 'Network basics', ...extra };
}

/** A two-module course with one lesson of each shape: plain, with a video, with a lab. */
const FIXTURE: Course = {
  id: 'fx',
  level: 'FX 1',
  title: 'A short level',
  subtitle: 'Two modules',
  description: 'A fixture course.',
  status: 'available',
  modules: [
    {
      id: 'm1',
      title: 'First module',
      summary: 'The first run of lessons.',
      lessons: [lesson('a'), lesson('b', { video: { youtubeId: 'abcdef12345', title: 'A video', channel: 'A channel', url: 'https://example.test/v' } })],
    },
    { id: 'm2', title: 'Second module', summary: 'The second run.', lessons: [lesson('c', { lab: 'ccna1-switched-lan', estimatedMinutes: 20 })] },
  ],
};

const CCNA1 = courseById('ccna1') as Course;

describe('the landing page', () => {
  it('lists every level, with the counts of the one that is available', () => {
    const html = renderToStaticMarkup(createElement(Landing, { onOpenCourse: noop, onOpenSandbox: noop }));
    const t = text(html);
    for (const course of COURSES) expect(t).toContain(course.title);
    expect(t).toContain('CCNA 1');
    expect(t).toContain(`${CCNA1.modules.length} modules`);
    expect(t).toContain(`${lessonsOf(CCNA1).length} lessons`);
    expect(t).toContain(`${lessonsOf(CCNA1).filter((l) => l.lab !== undefined).length} of them with a lab`);
  });

  it('starts the available level and marks the planned ones as not available', () => {
    const t = text(renderToStaticMarkup(createElement(Landing, { onOpenCourse: noop, onOpenSandbox: noop })));
    expect(t).toContain('Start CCNA 1');
    expect(t).not.toContain('Start CCNA 2');
    expect(t).not.toContain('Start CCNA 3');
    expect(t).toContain('Not available yet');
    // The state is a word, not a colour, and the glyph is decoration beside it.
    expect(t).toContain('available');
    expect(t).toContain('planned');
    expect(courseMark(CCNA1)).toEqual({ glyph: '▣', label: 'available' });
    expect(courseMark(COURSES.find((c) => c.status === 'planned') as Course).label).toBe('planned');
  });

  it('offers no control at all for a level that has nothing to open', () => {
    const planned = COURSES.filter((c) => c.status === 'planned');
    expect(planned.length).toBeGreaterThan(0);
    const html = renderToStaticMarkup(createElement(Landing, { courses: planned, onOpenCourse: noop, onOpenSandbox: noop }));
    // The only button on a page of planned levels is the way into the sandbox.
    expect(html.match(/<button/g) ?? []).toHaveLength(1);
    expect(text(html)).toContain('Open the sandbox');
  });

  // The shell's own bar is this page's banner. A second `<header>` here would map to a second `banner` role and
  // make landmark navigation ambiguous; the hero's h1 already names the page.
  it('adds no second banner of its own', () => {
    const html = renderToStaticMarkup(createElement(Landing, { onOpenCourse: noop, onOpenSandbox: noop }));
    expect(html).not.toContain('<header');
    expect(html).toContain('<h1>');
  });

  it('counts what a level is worth from its lessons, not from a written-down number', () => {
    expect(courseFacts(FIXTURE)).toEqual({ modules: 2, lessons: 3, labs: 1, minutes: 40 });
    expect(courseFactsText(FIXTURE)).toContain('2 modules · 3 lessons · 1 of them with a lab');
    expect(courseFactsText(COURSES.find((c) => c.status === 'planned') as Course)).toBe('No lessons in this release.');
  });
});

describe('the course view', () => {
  it('lists the modules and their lessons in teaching order', () => {
    const t = text(renderToStaticMarkup(createElement(CourseView, { course: FIXTURE, onOpenLesson: noop })));
    const order = ['First module', 'Lesson a', 'Lesson b', 'Second module', 'Lesson c'];
    let at = -1;
    for (const part of order) {
      const next = t.indexOf(part);
      expect(next, part).toBeGreaterThan(at);
      at = next;
    }
    expect(t).toContain('Outcome a');
  });

  it('marks a lesson that has a video and one that has a lab, in words', () => {
    expect(lessonMarks(lesson('a')).map((m) => m.label)).toEqual(['10 min']);
    expect(lessonMarks(lesson('b', { video: { youtubeId: 'abcdef12345', title: 't', channel: 'c', url: 'https://example.test/v' } })).map((m) => m.label)).toEqual(['10 min', 'video']);
    expect(lessonMarks(lesson('c', { lab: 'ccna1-switched-lan' })).map((m) => m.label)).toEqual(['10 min', 'lab']);
    const t = text(renderToStaticMarkup(createElement(CourseView, { course: FIXTURE, onOpenLesson: noop })));
    expect(t).toContain('video');
    expect(t).toContain('lab');
  });

  it('gives every lesson one real button to open it', () => {
    const html = renderToStaticMarkup(createElement(CourseView, { course: FIXTURE, onOpenLesson: noop }));
    expect(html.match(/<button type="button"/g) ?? []).toHaveLength(3);
  });

  it('says so when a level has no lessons yet', () => {
    const planned = COURSES.find((c) => c.status === 'planned') as Course;
    expect(text(renderToStaticMarkup(createElement(CourseView, { course: planned, onOpenLesson: noop })))).toContain('no lessons in this release');
  });

  it('shows the real CCNA 1 course as modules of lessons', () => {
    const html = renderToStaticMarkup(createElement(CourseView, { course: CCNA1, onOpenLesson: noop }));
    expect(CCNA1.modules.length).toBeGreaterThan(0);
    expect(html.match(/<button type="button"/g) ?? []).toHaveLength(lessonsOf(CCNA1).length);
    for (const module of CCNA1.modules) expect(text(html)).toContain(module.title);
  });
});

describe('the entry view', () => {
  beforeEach(() => {
    store.getState().showLearn('landing', { courseId: null, lessonId: null });
  });

  it('opens on the landing page for a visitor with nothing stored', () => {
    // No storage in this environment, so the store started where a first visit starts.
    expect(entryViewOf(null)).toBe('landing');
    expect(entryViewOf('lesson')).toBe('landing');
    expect(ENTRY_VIEW_KEY).toBe('netforge.entry.v1');
  });

  it('brings a visitor who left from the sandbox back to the sandbox', () => {
    expect(entryViewOf('topology')).toBe('topology');
    expect(entryViewOf('concept')).toBe('topology');
    expect(entryViewOf('nonsense-from-storage')).toBe('landing');
  });

  it('carries the course and the lesson a surface shows, and keeps ids it is not given', () => {
    const s = store.getState();
    s.showLearn('course', { courseId: 'ccna1' });
    expect(store.getState().view).toBe('course');
    expect(store.getState().learn.courseId).toBe('ccna1');

    s.showLearn('lesson', { lessonId: 'ccna1-01-what-is-a-network' });
    expect(store.getState().view).toBe('lesson');
    expect(store.getState().learn.courseId).toBe('ccna1');
    expect(store.getState().learn.lessonId).toBe('ccna1-01-what-is-a-network');
  });

  it('escapes into the sandbox and back without losing where the learner was', () => {
    const s = store.getState();
    s.showLearn('lesson', { courseId: 'ccna1', lessonId: 'ccna1-01-what-is-a-network' });
    s.setView('topology');
    expect(store.getState().view).toBe('topology');
    expect(store.getState().learn.lessonId).toBe('ccna1-01-what-is-a-network');

    store.getState().showLearn('lesson');
    expect(store.getState().view).toBe('lesson');
    expect(store.getState().learn.lessonId).toBe('ccna1-01-what-is-a-network');
  });
});
