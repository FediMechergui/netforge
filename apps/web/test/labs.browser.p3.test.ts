// The labs browser in P3 (ARCHITECTURE-P3 §6, §11.2; W5 web-shell): the CCNA 3 labs (`ccna3-lab`, `course: 'CCNA 3'`,
// `topic` = the title of the module that holds the lesson) are grouped by course, then by topic, like the CCNA 1 and 2
// labs: the CCNA 3 course follows CCNA 2, its topics follow the course order of the labs, and a topic name another
// course also uses keeps its labs apart.
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

import { LabBrowser, isLab, labsByCourse, labsByTopic } from '../src/labs/LabBrowser';

function text(html: string): string {
  return html.replace(/<[^>]+>/g, ' ').replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ');
}

/** The shipped scenarios, as the worker reports them. */
const SHIPPED: ScenarioMeta[] = SCENARIOS.map(scenarioMeta);

function lab(name: string, category: string, course: string, topic: string): ScenarioMeta {
  return { name, title: name.toUpperCase(), description: `About ${name}.`, category, course, topic };
}

/** A catalogue in the engine's order: a template, CCNA 1, CCNA 2, then CCNA 3 in course order (§11.1). */
const LIST: ScenarioMeta[] = [
  lab('tpl', 'template', 'CCNA 1', 'Switching'),
  lab('c1-a', 'ccna1-lab', 'CCNA 1', 'Basic configuration'),
  lab('c2-a', 'ccna2-lab', 'CCNA 2', 'Access control lists'),
  lab('c2-b', 'ccna2-lab', 'CCNA 2', 'Static routing'),
  lab('ccna3-ospf-dr-election', 'ccna3-lab', 'CCNA 3', 'Routers that learn'),
  lab('ccna3-ospf-single-area', 'ccna3-lab', 'CCNA 3', 'One OSPF area'),
  lab('ccna3-ospf-cost', 'ccna3-lab', 'CCNA 3', 'One OSPF area'),
  lab('ccna3-eigrp-feasible-successor', 'ccna3-lab', 'CCNA 3', 'EIGRP'),
  lab('ccna3-acl-standard', 'ccna3-lab', 'CCNA 3', 'Access control lists'),
  lab('ccna3-acl-extended', 'ccna3-lab', 'CCNA 3', 'Access control lists'),
  lab('ccna3-troubleshoot-eigrp', 'ccna3-lab', 'CCNA 3', 'Designing and fixing'),
  lab('ccna3-troubleshoot-enterprise', 'ccna3-lab', 'CCNA 3', 'Designing and fixing'),
];

describe('the CCNA 3 labs in the labs browser', () => {
  it('group under the CCNA 3 course after CCNA 2, then by module title, in course order', () => {
    const groups = labsByCourse(LIST);
    expect(groups.map((g) => [g.course, g.count, g.topics.map((t) => [t.topic, t.labs.map((l) => l.name)])])).toEqual([
      ['CCNA 1', 1, [['Basic configuration', ['c1-a']]]],
      ['CCNA 2', 2, [['Access control lists', ['c2-a']], ['Static routing', ['c2-b']]]],
      [
        'CCNA 3',
        8,
        [
          ['Routers that learn', ['ccna3-ospf-dr-election']],
          ['One OSPF area', ['ccna3-ospf-single-area', 'ccna3-ospf-cost']],
          ['EIGRP', ['ccna3-eigrp-feasible-successor']],
          ['Access control lists', ['ccna3-acl-standard', 'ccna3-acl-extended']],
          ['Designing and fixing', ['ccna3-troubleshoot-eigrp', 'ccna3-troubleshoot-enterprise']],
        ],
      ],
    ]);
  });

  it('render the CCNA 3 heading with its count after the CCNA 2 labs, and a heading per module under it', () => {
    const html = renderToStaticMarkup(createElement(LabBrowser, { scenarios: LIST, onOpen: () => undefined }));
    expect(html).toContain('<h4 class="panel-title">CCNA 3 <span class="dim">· 8 labs</span></h4>');
    expect(html).toContain('<h5 class="panel-title">One OSPF area</h5>');
    expect(html).toContain('aria-label="CCNA 3: Access control lists"');
    expect(html).toContain('aria-label="CCNA 2: Access control lists"');
    const t = text(html);
    expect(t.indexOf('Open C2-B')).toBeLessThan(t.indexOf('CCNA 3'));
    expect(t.indexOf('CCNA 3')).toBeLessThan(t.indexOf('Routers that learn'));
    expect(t.indexOf('Open CCNA3-OSPF-DR-ELECTION')).toBeLessThan(t.indexOf('One OSPF area'));
    expect(t.indexOf('Open CCNA3-ACL-EXTENDED')).toBeLessThan(t.indexOf('Designing and fixing'));
  });

  it('put every shipped CCNA 3 lab under the CCNA 3 course, after CCNA 1 and CCNA 2, in course order, losing none', () => {
    const ccna3 = SHIPPED.filter((s) => s.category === 'ccna3-lab');
    expect(ccna3.length, 'the CCNA 3 labs are in SCENARIOS (W5 sim, §9.2 item 38)').toBeGreaterThan(0);
    for (const s of ccna3) expect(s.course, s.name).toBe('CCNA 3');
    const groups = labsByCourse(SHIPPED);
    expect(groups.map((g) => g.course)).toEqual(['CCNA 1', 'CCNA 2', 'CCNA 3']);
    const course = groups.find((g) => g.course === 'CCNA 3')!;
    expect(course.count).toBe(ccna3.length);
    // the topics are the course's own, in list order, and each module's labs sit together: the browser keeps the
    // course order of the labs (`CCNA3_LAB_ORDER`)
    expect(course.topics).toEqual(labsByTopic(ccna3));
    expect(course.topics.flatMap((t) => t.labs.map((l) => l.name))).toEqual(ccna3.map((s) => s.name));
    // every lab exactly once, templates never
    const all = groups.flatMap((g) => g.topics.flatMap((t) => t.labs.map((l) => l.name)));
    expect([...all].sort()).toEqual(SHIPPED.filter(isLab).map((s) => s.name).sort());
  });
});
