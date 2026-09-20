// Labs browser and lab panel (ARCHITECTURE-P1 §4.13, §7 "Labs browser", §8.2 W7 web-learn): the catalogue
// grouped by topic, unavailable labs, the engine round trips (loadScenario / checkLab) and the rendered panel —
// including the proof that instruction text is rendered as ESCAPED TEXT, never as markup.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { SCENARIOS, scenarioMeta } from '@netforge/engine';
import type { LabStatus, ScenarioMeta } from '@netforge/engine';

const api = vi.hoisted(() => ({
  listScenarios: vi.fn(),
  loadScenario: vi.fn(),
  checkLab: vi.fn(),
}));
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
import { LabBrowser, OTHER_TOPIC, isLab, labAvailability, labFacts, labsByTopic } from '../src/labs/LabBrowser';
import { LabPanel, Markdown, checkLabNow, labScoreText, labTaskRows, loadLab, renderInline } from '../src/labs/LabPanel';
import { parseMarkdown } from '../src/labs/markdown';

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

/** The shipped labs, as the worker reports them. */
const LABS: ScenarioMeta[] = SCENARIOS.map(scenarioMeta);
const subnettingLab = LABS.find((s) => s.concept === 'subnetting') as ScenarioMeta;

beforeEach(() => {
  const s = (useStore as unknown as { getState(): Record<string, unknown> }).getState();
  for (const k of Object.keys(s)) delete s[k];
  for (const f of Object.values(api)) f.mockReset();
});

describe('lab catalogue', () => {
  it('keeps labs and drops the starting templates', () => {
    expect(LABS.some((s) => s.category === 'template')).toBe(true);
    expect(labsByTopic(LABS).flatMap((g) => g.labs).every(isLab)).toBe(true);
    expect(labsByTopic(LABS).flatMap((g) => g.labs).some((s) => s.category === 'template')).toBe(false);
  });

  it('groups by topic in list order and names a topic for labs without one', () => {
    const groups = labsByTopic([
      { name: 'a', title: 'A', description: '', category: 'ccna1-lab', topic: 'Addressing' },
      { name: 'b', title: 'B', description: '', category: 'ccna1-lab' },
      { name: 'c', title: 'C', description: '', category: 'ccna1-lab', topic: 'Addressing' },
      { name: 't', title: 'T', description: '', category: 'template', topic: 'Addressing' },
    ]);
    expect(groups.map((g) => g.topic)).toEqual(['Addressing', OTHER_TOPIC]);
    expect(groups[0]!.labs.map((l) => l.name)).toEqual(['a', 'c']);
    expect(groups[1]!.labs.map((l) => l.name)).toEqual(['b']);
    expect(labsByTopic([])).toEqual([]);
  });

  it('marks a lab unavailable when the build lacks its equipment', () => {
    expect(labAvailability({ name: 'a', title: 'A', description: '', category: 'ccna1-lab' })).toEqual({ ok: true });
    expect(labAvailability({ name: 'a', title: 'A', description: '', category: 'ccna1-lab', missingTypes: [] })).toEqual({ ok: true });
    const missing = labAvailability({ name: 'a', title: 'A', description: '', category: 'ccna1-lab', missingTypes: ['router.nf4331', 'ap.nfap'] });
    expect(missing.ok).toBe(false);
    expect(!missing.ok && missing.reason).toContain('router.nf4331, ap.nfap');
    // Every shipped lab is available in this build.
    expect(LABS.filter((l) => !labAvailability(l).ok)).toEqual([]);
  });

  it('writes the facts of a lab in words', () => {
    expect(labFacts({ name: 'a', title: 'A', description: '', category: 'ccna1-lab', estimatedMinutes: 25, difficulty: 2, tasks: [] })).toBe(
      'about 25 min · difficulty 2 of 3 · 0 tasks',
    );
    expect(labFacts({ name: 'a', title: 'A', description: '', category: 'ccna1-lab' })).toBe('');
  });

  it('renders the catalogue with a load button per lab and a reason for the ones it cannot load', () => {
    const list: ScenarioMeta[] = [
      { name: 'ok', title: 'Lease addresses', description: 'Set up a pool.', category: 'ccna1-lab', topic: 'Address services', estimatedMinutes: 25 },
      { name: 'gone', title: 'Wireless bridge', description: 'Pair two radios.', category: 'ccna1-lab', topic: 'Wireless', missingTypes: ['radio.nfbridge'] },
    ];
    const html = renderToStaticMarkup(createElement(LabBrowser, { scenarios: list, activeName: 'ok', onOpen: () => undefined }));
    const t = text(html);
    expect(t).toContain('Address services');
    expect(t).toContain('Wireless');
    expect(t).toContain('Reload Lease addresses');
    expect(t).toContain('open now');
    expect(t).toContain('unavailable');
    expect(t).toContain('radio.nfbridge');
    // The unavailable lab offers no button at all.
    expect(t).not.toContain('Open Wireless bridge');
    expect(text(renderToStaticMarkup(createElement(LabBrowser, { scenarios: [], onOpen: () => undefined })))).toContain('No labs are available');
  });
});

describe('lab status', () => {
  const meta: ScenarioMeta = {
    name: 'demo',
    title: 'Demo',
    description: '',
    category: 'ccna1-lab',
    tasks: [
      { id: 'one', title: 'Address the router', description: 'R1 has .1', points: 10, hint: 'Use the LAN side.' },
      { id: 'two', title: 'Ping across', description: 'PC1 reaches PC2', points: 20, hint: 'Check the mask on both PCs.' },
      { id: 'three', title: 'Not graded yet', description: 'later', points: 5 },
    ],
  };
  const status: LabStatus = {
    lab: 'demo',
    checkedAt: 0,
    score: 10,
    total: 35,
    results: [
      { task: 'one', pass: true, points: 10, assertions: [{ index: 0, pass: true }] },
      { task: 'two', pass: false, points: 0, assertions: [{ index: 0, pass: false, detail: 'PC1 got no reply from 192.168.1.20.' }] },
    ],
  };

  it('marks each task with a glyph and a word, and keeps unchecked tasks visible', () => {
    expect(labTaskRows(meta, status).map((r) => [r.task.id, r.mark, r.state, r.points])).toEqual([
      ['one', '✓', 'passed', 10],
      ['two', '✗', 'not yet', 0],
      ['three', '·', 'not checked', 0],
    ]);
    expect(labTaskRows(meta, status)[1]!.details).toEqual(['PC1 got no reply from 192.168.1.20.']);
    expect(labTaskRows(meta, null).every((r) => r.mark === '·')).toBe(true);
    expect(labTaskRows(null, status)).toEqual([]);
    expect(labScoreText(status)).toBe('10 of 35 points');
    expect(labScoreText(null)).toBe('Not checked yet.');
  });

  it('renders the instructions, the tasks and the score of the loaded lab', () => {
    setState({ lab: { active: { ...meta, instructions: '## Step one\n\n- Give R1 `192.168.1.1`.', objectives: ['Address a router'] }, status, browserOpen: false } });
    const t = text(renderToStaticMarkup(createElement(LabPanel)));
    expect(t).toContain('Step one');
    expect(t).toContain('Give R1 192.168.1.1');
    expect(t).toContain('Address a router');
    expect(t).toContain('Address the router');
    expect(t).toContain('passed, 10 of 10 points');
    expect(t).toContain('not yet, 0 of 20 points');
    expect(t).toContain('PC1 got no reply');
    expect(t).toContain('10 of 35 points');
    expect(t).toContain('✓');
    expect(t).toContain('✗');
    // The hint is only offered while the task has not passed.
    expect(t).toContain('Hint: Check the mask on both PCs.');
    expect(t).not.toContain('Hint: Use the LAN side.');
  });

  it('shows the catalogue when no lab is loaded', () => {
    setState({});
    const t = text(renderToStaticMarkup(createElement(LabPanel)));
    expect(t).toContain('Pick a lab to load it.');
    expect(t).toContain('No labs are available in this release.'); // the effect that fetches them does not run in a static render
  });

  // The worker may report another lab (File ▸ New from a template, a reopened project): its results grade
  // other task ids, so they must never be shown against these tasks.
  it('ignores a status that belongs to a different lab', () => {
    setState({ lab: { active: meta, status: { ...status, lab: 'another-lab' }, browserOpen: false } });
    const t = text(renderToStaticMarkup(createElement(LabPanel)));
    expect(t).toContain('Not checked yet.');
    expect(t).not.toContain('10 of 35 points');
    expect(t).toContain('not checked');
    expect(t).not.toContain('passed, 10 of 10 points');
  });

  // The message box is the only answer to "Check my work", so it has to be announced (§16).
  it('keeps the message in a live region that exists before there is a message', () => {
    setState({ lab: { active: meta, status, browserOpen: false } });
    const html = renderToStaticMarkup(createElement(LabPanel));
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain('is-empty');
  });
});

describe('engine round trips', () => {
  it('loads a lab through loadScenario and keeps the engine wording on a refusal', async () => {
    api.loadScenario.mockResolvedValueOnce(undefined);
    const ok = await loadLab(subnettingLab);
    expect(api.loadScenario).toHaveBeenCalledWith(subnettingLab.name);
    expect(ok.ok).toBe(true);
    expect(ok.message).toContain(subnettingLab.title);

    api.loadScenario.mockRejectedValueOnce(new Error('This lab needs equipment this build does not have.'));
    const bad = await loadLab(subnettingLab);
    expect(bad.ok).toBe(false);
    expect(bad.message).toContain('This lab needs equipment this build does not have.');
  });

  it('grades through checkLab, and says so when there is no lab or no call', async () => {
    const status: LabStatus = { lab: 'demo', checkedAt: 5, score: 3, total: 4, results: [] };
    api.checkLab.mockResolvedValueOnce(status);
    expect(await checkLabNow()).toEqual({ ok: true, status, message: 'Checked: 3 of 4 points.' });

    api.checkLab.mockResolvedValueOnce(null);
    expect((await checkLabNow()).message).toContain('No lab is loaded');

    api.checkLab.mockRejectedValueOnce(new Error('the worker is busy'));
    expect((await checkLabNow()).message).toContain('the worker is busy');
  });
});

describe('instruction rendering', () => {
  it('renders a concept link as a button and an https link as a link', () => {
    const block = parseMarkdown('Open the [subnetting view](concept:subnetting) or [the notes](https://example.org/a).')[0]!;
    expect(block.kind).toBe('paragraph');
    const opened: string[] = [];
    const nodes = renderInline(block.kind === 'paragraph' ? block.children : [], (t) => opened.push(t));
    const html = renderToStaticMarkup(createElement('div', null, ...nodes));
    expect(html).toContain('<button type="button" class="link-btn">subnetting view</button>');
    expect(html).toContain('<a href="https://example.org/a" target="_blank" rel="noopener noreferrer"');
    expect(opened).toEqual([]); // nothing is opened until the button is pressed
  });

  it('escapes instruction text instead of rendering it as markup', () => {
    const nasty = ['# <script>alert("x")</script>', '', '<img src=x onerror="steal()">', '', '- see [x](javascript:alert(1)) and `a & b`'].join('\n');
    const html = renderToStaticMarkup(createElement(Markdown, { blocks: parseMarkdown(nasty) }));
    // No element and no attribute was formed: every dangerous character came out escaped.
    expect(html).not.toContain('<script');
    expect(html).not.toContain('<img');
    expect(html).not.toContain('onerror="steal()"');
    expect(html).not.toContain('href="javascript:');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('&lt;img src=x onerror=&quot;steal()&quot;&gt;');
    expect(html).toContain('a &amp; b');
    // The characters are all still readable to the student.
    const t = text(html);
    expect(t).toContain('<script>alert("x")</script>');
    expect(t).toContain('[x](javascript:alert(1))');
  });

  it('renders headings, lists and code blocks under the panel heading level', () => {
    const html = renderToStaticMarkup(createElement(Markdown, { blocks: parseMarkdown('# Top\n\n## Next\n\n1. one\n\n```\nip route\n```') }));
    expect(html).toContain('<h4 class="panel-title">Top</h4>');
    expect(html).toContain('<h5 class="panel-title">Next</h5>');
    expect(html).toContain('<ol class="help-list"><li>one</li></ol>');
    expect(html).toContain('<pre class="mono">ip route</pre>');
  });
});
