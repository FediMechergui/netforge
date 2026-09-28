// The File menu's template list (spec §13.1; ARCHITECTURE-P2 §6, §11.2, W6 web-shell): scenarios grouped by
// category — templates, the CCNA 1 labs, the CCNA 2 labs ("Labs: CCNA 2"), then any other category alphabetically —
// with list order kept inside each group. `groupScenarios` is pure.
import { describe, expect, it, vi } from 'vitest';
import { SCENARIOS, scenarioMeta } from '@netforge/engine';
import type { ScenarioMeta } from '@netforge/engine';

vi.mock('../src/bridge/client', () => ({ engine: {}, defaultSeed: () => 1, fmtSimTime: () => '' }));
vi.mock('../src/store/store', () => {
  const state: Record<string, unknown> = {};
  const useStore = Object.assign((selector: (s: Record<string, unknown>) => unknown) => selector(state), {
    getState: () => state,
    setState: (patch: Record<string, unknown>) => Object.assign(state, patch),
    subscribe: () => () => undefined,
  });
  return { useStore, store: useStore };
});

import { CATEGORY_ORDER, groupScenarios, scenarioSubtitle } from '../src/app/FileMenu';

const SHIPPED: ScenarioMeta[] = SCENARIOS.map(scenarioMeta);

function meta(name: string, category: string, course?: string): ScenarioMeta {
  return { name, title: name, description: `About ${name}.`, category, ...(course === undefined ? {} : { course }) };
}

describe('File menu groups', () => {
  it('place templates, then the CCNA 1 labs, then the CCNA 2 labs', () => {
    expect(CATEGORY_ORDER).toEqual(['template', 'ccna1-lab', 'ccna2-lab']);
    const groups = groupScenarios(SHIPPED);
    expect(groups.map((g) => [g.category, g.label])).toEqual([
      ['template', 'Templates'],
      ['ccna1-lab', 'Labs: CCNA 1'],
      ['ccna2-lab', 'Labs: CCNA 2'],
    ]);
    for (const g of groups) expect(g.items.map((m) => m.name)).toEqual(SHIPPED.filter((m) => m.category === g.category).map((m) => m.name));
  });

  it('put any other category after them alphabetically, keep list order inside, and label course labs by their course', () => {
    const groups = groupScenarios([
      meta('z1', 'zeta'),
      meta('c2a', 'ccna2-lab', 'CCNA 2'),
      meta('x1', 'alpha-extra'),
      meta('c3a', 'ccna3-lab', 'CCNA 3'),
      meta('t1', 'template'),
      meta('c1a', 'ccna1-lab', 'CCNA 1'),
      meta('t2', ''),
      meta('c2b', 'ccna2-lab', 'CCNA 2'),
      meta('z2', 'zeta'),
    ]);
    expect(groups.map((g) => [g.category, g.label, g.items.map((m) => m.name)])).toEqual([
      ['template', 'Templates', ['t1', 't2']],
      ['ccna1-lab', 'Labs: CCNA 1', ['c1a']],
      ['ccna2-lab', 'Labs: CCNA 2', ['c2a', 'c2b']],
      ['alpha-extra', 'Alpha extra', ['x1']],
      ['ccna3-lab', 'Labs: CCNA 3', ['c3a']],
      ['zeta', 'Zeta', ['z1', 'z2']],
    ]);
  });

  it('fall back to a generic label for course labs that name no course', () => {
    expect(groupScenarios([meta('a', 'ccna2-lab'), meta('b', 'ccna1-lab', ' ')]).map((g) => g.label)).toEqual(['Course labs', 'Course labs']);
    expect(groupScenarios([])).toEqual([]);
  });

  it('write a CCNA 2 lab entry with its level, time and topic', () => {
    const lab = SHIPPED.find((m) => m.category === 'ccna2-lab' && m.difficulty !== undefined && m.estimatedMinutes !== undefined && m.topic !== undefined);
    expect(lab).toBeDefined();
    expect(scenarioSubtitle(lab!)).toBe(`${lab!.description} (Level ${lab!.difficulty} of 3 · about ${lab!.estimatedMinutes} min · ${lab!.topic})`);
  });
});
