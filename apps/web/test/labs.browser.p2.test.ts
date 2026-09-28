// The labs browser in P2 (ARCHITECTURE-P2 §6, §11.2, §9.2 item 22c; W6 web-learn): labs grouped by course, then by
// topic inside the course (the CCNA 2 labs under their own course), and the busy state that keeps a long lab check
// from looking like a hang.
import { describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { SCENARIOS, scenarioMeta } from '@netforge/engine';
import type { ScenarioMeta } from '@netforge/engine';

vi.mock('../src/bridge/client', () => ({ engine: { listScenarios: vi.fn(), loadScenario: vi.fn(), checkLab: vi.fn() } }));
vi.mock('../src/store/store', () => {
  const state: Record<string, unknown> = {};
  const useStore = Object.assign((selector: (s: Record<string, unknown>) => unknown) => selector(state), {
    getState: () => state,
    setState: (patch: Record<string, unknown>) => Object.assign(state, patch),
    subscribe: () => () => undefined,
  });
  return { useStore, store: useStore };
});

import {
  LAB_CHECK_ANNOUNCEMENT,
  LAB_CHECK_BLOCKS_OPEN,
  LAB_CHECK_SLOW_S,
  LabBrowser,
  LabWorkingNote,
  OTHER_COURSE,
  OTHER_TOPIC,
  isLab,
  labCountText,
  labWorkText,
  labsByCourse,
  labsByTopic,
} from '../src/labs/LabBrowser';
import { LabPanel } from '../src/labs/LabPanel';

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

/** The shipped scenarios, as the worker reports them. */
const SHIPPED: ScenarioMeta[] = SCENARIOS.map(scenarioMeta);

function lab(name: string, category: string, course?: string, topic?: string): ScenarioMeta {
  return { name, title: name.toUpperCase(), description: `About ${name}.`, category, ...(course === undefined ? {} : { course }), ...(topic === undefined ? {} : { topic }) };
}

describe('labs by course, then topic', () => {
  it('keep courses, topics and labs in list order, a shared topic name apart per course, and name the missing ones', () => {
    const groups = labsByCourse([
      lab('t', 'template', 'Course A', 'Switching'),
      lab('a1', 'ccna1-lab', 'Course A', 'Switching'),
      lab('b1', 'ccna2-lab', 'Course B', 'Switching'),
      lab('a2', 'ccna1-lab', 'Course A', 'Routing'),
      lab('n1', 'extra-lab'),
      lab('a3', 'ccna1-lab', 'Course A', 'Switching'),
      lab('b2', 'ccna2-lab', 'Course B'),
      lab('n2', 'extra-lab', '  ', 'Odd'),
    ]);
    expect(groups.map((g) => [g.course, g.count, g.topics.map((t) => [t.topic, t.labs.map((l) => l.name)])])).toEqual([
      ['Course A', 3, [['Switching', ['a1', 'a3']], ['Routing', ['a2']]]],
      ['Course B', 2, [['Switching', ['b1']], [OTHER_TOPIC, ['b2']]]],
      [OTHER_COURSE, 2, [[OTHER_TOPIC, ['n1']], ['Odd', ['n2']]]],
    ]);
    expect(labsByCourse([])).toEqual([]);
    expect(labsByCourse([lab('t', 'template', 'Course A', 'Switching')])).toEqual([]);
  });

  it('put every shipped CCNA 2 lab under the CCNA 2 course, after CCNA 1, and lose no lab', () => {
    const groups = labsByCourse(SHIPPED);
    const courses = groups.map((g) => g.course);
    expect(courses.slice(0, 2)).toEqual(['CCNA 1', 'CCNA 2']);
    const labsOf = (course: string): string[] => groups.find((g) => g.course === course)!.topics.flatMap((t) => t.labs.map((l) => l.name));
    const ccna2 = SHIPPED.filter((s) => s.category === 'ccna2-lab').map((s) => s.name);
    expect(ccna2.length).toBeGreaterThan(0);
    expect([...labsOf('CCNA 2')].sort()).toEqual([...ccna2].sort());
    expect([...labsOf('CCNA 1')].sort()).toEqual(SHIPPED.filter((s) => s.category === 'ccna1-lab').map((s) => s.name).sort());
    // every lab exactly once, templates never
    const all = groups.flatMap((g) => g.topics.flatMap((t) => t.labs.map((l) => l.name)));
    expect([...all].sort()).toEqual(SHIPPED.filter(isLab).map((s) => s.name).sort());
    expect(groups.reduce((n, g) => n + g.count, 0)).toBe(all.length);
    // inside a course the topics are the course's own, in list order (the per-topic grouping of its labs)
    for (const course of ['CCNA 1', 'CCNA 2']) {
      expect(groups.find((g) => g.course === course)!.topics).toEqual(labsByTopic(SHIPPED.filter((s) => s.course === course)));
    }
    // a topic of CCNA 1 that comes back later in the list gathers its labs under its first place
    const ccna1Topics = groups.find((g) => g.course === 'CCNA 1')!.topics.map((t) => t.topic);
    expect(new Set(ccna1Topics).size).toBe(ccna1Topics.length);
  });

  it('render a heading per course with its count and a heading per topic under it', () => {
    const html = renderToStaticMarkup(
      createElement(LabBrowser, {
        scenarios: [lab('a1', 'ccna1-lab', 'CCNA 1', 'Routing'), lab('b1', 'ccna2-lab', 'CCNA 2', 'Static routing'), lab('b2', 'ccna2-lab', 'CCNA 2', 'Static routing')],
        onOpen: () => undefined,
      }),
    );
    expect(html).toContain('<h4 class="panel-title">CCNA 1 <span class="dim">· 1 lab</span></h4>');
    expect(html).toContain('<h4 class="panel-title">CCNA 2 <span class="dim">· 2 labs</span></h4>');
    expect(html).toContain('<h5 class="panel-title">Static routing</h5>');
    expect(html).toContain('aria-label="CCNA 2: Static routing"');
    const t = text(html);
    expect(t.indexOf('CCNA 1')).toBeLessThan(t.indexOf('Routing'));
    expect(t.indexOf('CCNA 2')).toBeLessThan(t.indexOf('Static routing'));
    expect(t.indexOf('Static routing')).toBeLessThan(t.indexOf('Open B1'));
    expect(t.indexOf('Open A1')).toBeLessThan(t.indexOf('CCNA 2'));
    expect(labCountText(1)).toBe('1 lab');
    expect(labCountText(19)).toBe('19 labs');
  });
});

describe('the busy state', () => {
  it('says what runs, and past a few seconds of checking, for how long and why', () => {
    expect(labWorkText('idle')).toBe('');
    expect(labWorkText('loading')).toBe('Loading the lab…');
    expect(labWorkText('checking')).toBe('Checking your work…');
    expect(labWorkText('checking', LAB_CHECK_SLOW_S - 0.5)).toBe('Checking your work…');
    expect(labWorkText('checking', 17)).toBe(
      'Still checking your work (17 s so far). The grader runs a copy of your network until it goes quiet; a network that keeps changing takes longest.',
    );
    expect(LAB_CHECK_SLOW_S).toBe(5);
    expect(LAB_CHECK_ANNOUNCEMENT).toBe('Checking your work. A check usually takes a few seconds, sometimes up to half a minute.');
  });

  it('shows a named progress bar with the words while busy, and nothing while idle', () => {
    expect(renderToStaticMarkup(createElement(LabWorkingNote, { work: 'idle' }))).toBe('');
    const checking = renderToStaticMarkup(createElement(LabWorkingNote, { work: 'checking', elapsedS: 12 }));
    expect(checking).toContain('<progress aria-label="Checking your work"');
    expect(checking).toContain('data-work="checking"');
    expect(text(checking)).toContain('Still checking your work (12 s so far).');
    // not a live region: the panel announces the start and the result once, never every second
    expect(checking).not.toContain('aria-live');
    const loading = renderToStaticMarkup(createElement(LabWorkingNote, { work: 'loading' }));
    expect(loading).toContain('<progress aria-label="Loading the lab"');
    expect(text(loading)).toContain('Loading the lab…');
  });

  it('disables every load button while a check runs, and says why', () => {
    const list = [lab('a1', 'ccna1-lab', 'CCNA 1', 'Routing'), lab('b1', 'ccna2-lab', 'CCNA 2', 'VLANs')];
    const idle = renderToStaticMarkup(createElement(LabBrowser, { scenarios: list, onOpen: () => undefined }));
    expect(idle).not.toContain('disabled');
    expect(idle).toContain('aria-busy="false"');
    expect(text(idle)).not.toContain(LAB_CHECK_BLOCKS_OPEN);

    const checking = renderToStaticMarkup(createElement(LabBrowser, { scenarios: list, work: 'checking', onOpen: () => undefined }));
    expect(checking.match(/<button[^>]*disabled=""/g)).toHaveLength(2);
    expect(checking).toContain('aria-busy="true"');
    expect(text(checking)).toContain('A check is running. The labs can be opened again when it ends.');

    const loading = renderToStaticMarkup(createElement(LabBrowser, { scenarios: list, work: 'loading', onOpen: () => undefined }));
    expect(loading.match(/<button[^>]*disabled=""/g)).toHaveLength(2);
    expect(text(loading)).not.toContain(LAB_CHECK_BLOCKS_OPEN);
    // the P1 flag still disables them
    const busy = renderToStaticMarkup(createElement(LabBrowser, { scenarios: list, busy: true, onOpen: () => undefined }));
    expect(busy.match(/<button[^>]*disabled=""/g)).toHaveLength(2);
  });

  it('is absent from the panel while nothing runs', () => {
    const html = renderToStaticMarkup(createElement(LabPanel));
    expect(html).not.toContain('<progress');
    expect(text(html)).toContain('Pick a lab to load it.');
  });
});
