/**
 * sim/scenarios/index.ts — the scenario catalogue (ARCHITECTURE-P1 §4.13, §8.2 W6; ARCHITECTURE-P2 §7 W5, §11.2).
 *
 * `SCENARIOS` is what the worker lists (`listScenarios` → `scenarioMeta`) and looks a lab up in
 * (`loadScenario`): the nine "New from template" worlds first, in their menu order, then the CCNA 1 labs in course
 * order, then the CCNA 2 labs in course order (P2 W5: `CCNA2_LABS`, P2-profile worlds of category `ccna2-lab`). A
 * template is a starting point with no grading; a lab carries objectives, instructions, tasks with declarative
 * assertions and a reference `solution` (contracts/scenario.ts).
 *
 * ponytail: one flat list, because the UI groups by `category` itself (FileMenu) and `loadScenario` only needs a
 * name lookup. The file re-exports the template builders (sim/scenarios.ts is a shim onto this module, so every
 * existing import keeps resolving) but not kit.ts, whose names are deliberately internal. Appending the CCNA 2 labs
 * after the CCNA 1 labs keeps every existing index (templates and CCNA 1 labs keep their positions).
 */
import type { ScenarioInfo } from '../../contracts/scenario.js';
import { TEMPLATES } from './templates.js';
import { CCNA1_LABS } from './ccna1/index.js';
import { CCNA2_LABS } from './ccna2/index.js';

export * from './templates.js';
export { CCNA1_LABS } from './ccna1/index.js';
export { CCNA2_LABS } from './ccna2/index.js';

/** Every built-in scenario: templates first (menu order), then the CCNA 1 labs, then the CCNA 2 labs (course order). */
export const SCENARIOS: readonly ScenarioInfo[] = [...TEMPLATES, ...CCNA1_LABS, ...CCNA2_LABS];
