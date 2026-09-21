// A lesson (P2 learn/): the theory rendered through the LAB renderers (so lesson prose can no more become markup
// than lab instructions can), the video embedded only when the lesson has one, the lab action only when it names
// a lab, and the ordering the previous / next footer walks.
import { describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { SCENARIOS, courseById, lessonsOf, scenarioMeta } from '@netforge/engine';
import type { Course, Lesson, LessonVideo, ScenarioMeta } from '@netforge/engine';

const api = vi.hoisted(() => ({ listScenarios: vi.fn(), loadScenario: vi.fn(), checkLab: vi.fn() }));
vi.mock('../src/bridge/client', () => ({ engine: api }));
vi.mock('../src/store/store', () => {
  const state: Record<string, unknown> = {};
  const useStore = Object.assign((selector: (s: Record<string, unknown>) => unknown) => selector(state), {
    getState: () => state,
    setState: (patch: Record<string, unknown>) => Object.assign(state, patch),
    subscribe: () => () => undefined,
  });
  return { useStore, store: useStore };
});

import { useStore } from '../src/store/store';
import { LessonView, lessonTimeText } from '../src/learn/LessonView';
import { VIDEO_EMBED_HOST, VideoEmbed, videoEmbedUrl, videoWatchUrl } from '../src/learn/VideoEmbed';
import { LearnShell, neighbours } from '../src/learn/LearnShell';

const setState = (useStore as unknown as { setState(p: Record<string, unknown>): void }).setState;

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

const VIDEO: LessonVideo = { youtubeId: 'dQw4w9WgXcQ', title: 'How a switch learns', channel: 'The Wire Shed', url: 'https://example.test/watch' };

// A section of a body is a `##`, the way every written body in curriculum/ccna1/theory-*.ts starts one. The
// fixture has to match that, because the heading level the view asks for is only correct relative to it.
const THEORY = [
  '## What a switch does',
  '',
  'A switch keeps a list of **which port** a machine answered on, and sends the next frame only there.',
  '',
  '- it learns from the sender of every frame',
  '- it floods what it has not learned yet',
  '',
  'Try the [subnetting workbench](concept:subnetting) when the addresses stop making sense.',
  '',
  'Text with <script>alert(1)</script> in it stays text.',
].join('\n');

function lesson(extra: Partial<Lesson> = {}): Lesson {
  return {
    id: 'fx-01',
    title: 'What a switch does',
    outcome: 'Say what a switch keeps in its table and why it floods the first frame.',
    theory: THEORY,
    estimatedMinutes: 12,
    topic: 'Ethernet LANs',
    ...extra,
  };
}

const LAB: ScenarioMeta = SCENARIOS.map(scenarioMeta).find((s) => s.category !== 'template') as ScenarioMeta;

describe('the theory of a lesson', () => {
  it('renders the body through the shared markdown subset', () => {
    const t = text(renderToStaticMarkup(createElement(LessonView, { lesson: lesson() })));
    expect(t).toContain('What a switch does');
    expect(t).toContain('which port');
    expect(t).toContain('it floods what it has not learned yet');
    expect(t).toContain('subnetting workbench');
  });

  it('keeps lesson prose as text, never as markup', () => {
    const html = renderToStaticMarkup(createElement(LessonView, { lesson: lesson() }));
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('opens a concept link as a button, not as a page link', () => {
    const html = renderToStaticMarkup(createElement(LessonView, { lesson: lesson(), onConcept: () => undefined }));
    expect(html).toContain('class="link-btn"');
    expect(html).not.toContain('href="concept:subnetting"');
  });

  it('says the explanation is missing rather than showing an empty page', () => {
    expect(text(renderToStaticMarkup(createElement(LessonView, { lesson: lesson({ theory: '' }) })))).toContain('not ready yet');
  });

  it('puts the lesson title above the section headings', () => {
    const html = renderToStaticMarkup(createElement(LessonView, { lesson: lesson({ video: VIDEO, lab: LAB.name }) }));
    expect(html.indexOf('<h1>')).toBeGreaterThan(-1);
    expect(html.indexOf('<h1>')).toBeLessThan(html.indexOf('<h2>'));
    // The body's own headings nest under the section heading.
    expect(html).toContain('<h3');
    expect(html).not.toContain('<h1 class="panel-title"');
  });

  // A `##` section of the body has to land one step under the `<h2>` that names the section, which is one step
  // under the lesson's `<h1>`. Getting `baseLevel` wrong skips a level on every page at once, and a skipped level
  // is exactly what a screen-reader user navigating by heading hears as a missing section.
  it('leaves no gap in the heading ladder', () => {
    const html = renderToStaticMarkup(createElement(LessonView, { lesson: lesson() }));
    const levels = [...html.matchAll(/<h([1-6])[\s>]/g)].map((m) => Number(m[1]));
    expect(levels[0], 'the page does not start at h1').toBe(1);
    for (let i = 1; i < levels.length; i += 1) {
      expect(levels[i] as number, `heading ${i} jumps from h${levels[i - 1]} to h${levels[i]}`).toBeLessThanOrEqual((levels[i - 1] as number) + 1);
    }
    expect(levels, 'a `##` body section should render as h3').toContain(3);
    expect(html, 'nothing in a lesson body goes as deep as h4').not.toContain('<h4');
  });
});

describe('the video of a lesson', () => {
  it('embeds the no-cookie player, lazily, with a title and a credit', () => {
    const html = renderToStaticMarkup(createElement(LessonView, { lesson: lesson({ video: VIDEO }) }));
    expect(html).toContain(`src="${VIDEO_EMBED_HOST}dQw4w9WgXcQ"`);
    expect(html).toContain('loading="lazy"');
    expect(html).toContain('allowfullscreen');
    expect(html).toContain('title="How a switch learns"');
    const t = text(html);
    expect(t).toContain('The Wire Shed');
    expect(t).toContain('Open the video in a new tab');
    expect(html).toContain('href="https://example.test/watch"');
  });

  it('loads nothing from anywhere for a lesson with no video', () => {
    const html = renderToStaticMarkup(createElement(LessonView, { lesson: lesson() }));
    expect(html).not.toContain('<iframe');
    expect(html).not.toContain('youtube');
    expect(text(html)).not.toContain('Watch it');
  });

  it('builds a player URL only from something that is an id', () => {
    expect(videoEmbedUrl('dQw4w9WgXcQ')).toBe(`${VIDEO_EMBED_HOST}dQw4w9WgXcQ`);
    expect(videoEmbedUrl('../../evil')).toBeNull();
    expect(videoEmbedUrl('abc')).toBeNull();
    expect(videoEmbedUrl('id?autoplay=1')).toBeNull();
    expect(videoEmbedUrl('" onload="x')).toBeNull();
  });

  it('falls back to a link the browser can open, and refuses a target that is not https', () => {
    expect(videoWatchUrl({ ...VIDEO, url: 'http://example.test/watch' })).toBe('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
    expect(videoWatchUrl({ ...VIDEO, url: 'javascript:alert(1)' })).toBe('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
    expect(videoWatchUrl({ youtubeId: 'nope', title: 't', channel: 'c', url: 'ftp://x' })).toBeNull();
  });

  it('keeps the credit and the link when the id cannot be embedded', () => {
    const html = renderToStaticMarkup(createElement(VideoEmbed, { video: { ...VIDEO, youtubeId: 'no' } }));
    expect(html).not.toContain('<iframe');
    expect(text(html)).toContain('The Wire Shed');
    expect(html).toContain('href="https://example.test/watch"');
  });
});

describe('the lab of a lesson', () => {
  it('offers the lab only when the lesson names one', () => {
    expect(text(renderToStaticMarkup(createElement(LessonView, { lesson: lesson(), onOpenLab: () => undefined })))).not.toContain('Open the lab');
    const t = text(renderToStaticMarkup(createElement(LessonView, { lesson: lesson({ lab: LAB.name }), onOpenLab: () => undefined })));
    expect(t).toContain('Practise it');
    expect(t).toContain('Open the lab');
  });

  it('describes the lab from the scenario catalogue when the host has read it', () => {
    const t = text(renderToStaticMarkup(createElement(LessonView, { lesson: lesson({ lab: LAB.name }), lab: LAB, onOpenLab: () => undefined })));
    expect(t).toContain(LAB.description);
    expect(lessonTimeText(lesson(), LAB)).toBe(`about 12 min to read and watch, then about ${LAB.estimatedMinutes} min in the lab`);
    expect(lessonTimeText(lesson(), null)).toBe('about 12 min to read and watch');
  });

  it('shows no lab action at all when the host cannot open one', () => {
    const t = text(renderToStaticMarkup(createElement(LessonView, { lesson: lesson({ lab: LAB.name }) })));
    expect(t).toContain('Practise it');
    expect(t).not.toContain('Open the lab');
  });

  it('says the lab is loading instead of letting it be pressed twice', () => {
    const html = renderToStaticMarkup(createElement(LessonView, { lesson: lesson({ lab: LAB.name }), onOpenLab: () => undefined, busy: true }));
    expect(html).toContain('disabled');
    expect(text(html)).toContain('Opening the lab');
  });
});

describe('the shell that hosts the surfaces', () => {
  it('opens on the landing page, with the way into the sandbox always in the bar', () => {
    setState({ view: 'landing', learn: { courseId: null, lessonId: null } });
    const t = text(renderToStaticMarkup(createElement(LearnShell)));
    expect(t).toContain('Pick a level');
    expect(t).toContain('Open the sandbox');
    expect(t).toContain('Start CCNA 1');
  });

  it('shows the course a learner picked, with the way back to the levels', () => {
    setState({ view: 'course', learn: { courseId: 'ccna1', lessonId: null } });
    const t = text(renderToStaticMarkup(createElement(LearnShell)));
    expect(t).toContain('All levels');
    expect(t).toContain((courseById('ccna1') as Course).title);
  });

  it('shows a lesson under its own course, and asks for nothing from the worker without a lab', () => {
    const first = lessonsOf(courseById('ccna1') as Course)[0] as Lesson;
    setState({ view: 'lesson', learn: { courseId: null, lessonId: first.id } });
    const t = text(renderToStaticMarkup(createElement(LearnShell)));
    expect(t).toContain(first.title);
    expect(t).toContain('CCNA 1'); // the crumb back to the course it belongs to
    expect(api.listScenarios).not.toHaveBeenCalled();
  });

  it('falls back to the landing page when the stored ids name nothing', () => {
    setState({ view: 'lesson', learn: { courseId: 'gone', lessonId: 'gone' } });
    expect(text(renderToStaticMarkup(createElement(LearnShell)))).toContain('Pick a level');
  });

  // While the course layer is up it IS the page: the sandbox's own `main` is inside the hidden grid and out of
  // the accessibility tree, so jumping to the main region has to land here. One banner, because two make landmark
  // navigation ambiguous.
  it('offers one main region and one banner on every surface', () => {
    const first = lessonsOf(courseById('ccna1') as Course)[0] as Lesson;
    for (const state of [
      { view: 'landing', learn: { courseId: null, lessonId: null } },
      { view: 'course', learn: { courseId: 'ccna1', lessonId: null } },
      { view: 'lesson', learn: { courseId: 'ccna1', lessonId: first.id } },
    ]) {
      setState(state);
      const html = renderToStaticMarkup(createElement(LearnShell));
      expect(html.match(/<main[\s>]/g) ?? [], `${state.view} has no main region`).toHaveLength(1);
      expect(html.match(/<header[\s>]/g) ?? [], `${state.view} does not have exactly one banner`).toHaveLength(1);
    }
  });

  // The whole point of the layer: the prose written in curriculum/ccna1/theory-*.ts has to come out the far end.
  // A map that is never merged looks fine from every unit test and renders the empty-state hint on all 31 pages.
  it('renders the written theory of a real lesson, not the empty-state hint', () => {
    for (const lsn of lessonsOf(courseById('ccna1') as Course)) {
      setState({ view: 'lesson', learn: { courseId: 'ccna1', lessonId: lsn.id } });
      const t = text(renderToStaticMarkup(createElement(LearnShell)));
      expect(t, `${lsn.id} renders the empty-state hint`).not.toContain('not ready yet');
      expect(t, `${lsn.id} has no body text`).toContain('The idea in one breath');
    }
  });
});

describe('moving between lessons', () => {
  const course = {
    id: 'fx',
    level: 'FX 1',
    title: 'A short level',
    subtitle: '',
    description: '',
    status: 'available' as const,
    modules: [
      { id: 'm1', title: 'One', summary: '', lessons: [lesson({ id: 'a', title: 'Lesson A' }), lesson({ id: 'b', title: 'Lesson B' })] },
      { id: 'm2', title: 'Two', summary: '', lessons: [lesson({ id: 'c', title: 'Lesson C' })] },
    ],
  };

  it('walks the lessons of a course across module boundaries', () => {
    expect(neighbours(course, 'a').previous).toBeNull();
    expect(neighbours(course, 'a').next?.id).toBe('b');
    expect(neighbours(course, 'b').next?.id).toBe('c');
    expect(neighbours(course, 'c').next).toBeNull();
    expect(neighbours(course, 'missing')).toEqual({ previous: null, next: null });
    expect(neighbours(undefined, 'a')).toEqual({ previous: null, next: null });
  });

  it('shows the footer only when the host can act on it', () => {
    const links = neighbours(course, 'b');
    const alone = renderToStaticMarkup(createElement(LessonView, { lesson: lesson({ id: 'b', title: 'Lesson B' }), ...links }));
    expect(text(alone)).not.toContain('Lesson A');

    const html = renderToStaticMarkup(createElement(LessonView, { lesson: lesson({ id: 'b', title: 'Lesson B' }), onOpenLesson: () => undefined, ...links }));
    expect(html).toContain('aria-label="Lessons either side of this one"');
    expect(text(html)).toContain('Lesson A');
    expect(text(html)).toContain('Lesson C');
  });
});
