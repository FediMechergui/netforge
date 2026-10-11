/**
 * sim/scenarios/index.ts — the scenario catalogue (ARCHITECTURE-P1 §4.13, §8.2 W6; ARCHITECTURE-P2 §7 W5, §11.2;
 * ARCHITECTURE-P3 §7 W5, §11.2).
 *
 * `SCENARIOS` is what the worker lists (`listScenarios` → `scenarioMeta`) and looks a lab up in
 * (`loadScenario`): the nine "New from template" worlds first, in their menu order, then the CCNA 1 labs in course
 * order, then the CCNA 2 labs in course order (P2 W5: `CCNA2_LABS`, P2-profile worlds of category `ccna2-lab`), then
 * the CCNA 3 labs in course order (P3 W5: `CCNA3_LABS`, P3-profile worlds of category `ccna3-lab`, sorted by
 * `CCNA3_LAB_ORDER` in sim/scenarios/ccna3/index.ts). A template is a starting point with no grading; a lab carries
 * objectives, instructions, tasks with declarative assertions and a reference `solution` (contracts/scenario.ts).
 *
 * ponytail: one flat list, because the UI groups by `category` itself (FileMenu) and `loadScenario` only needs a
 * name lookup. The file re-exports the template builders (sim/scenarios.ts is a shim onto this module, so every
 * existing import keeps resolving) but not kit.ts, whose names are deliberately internal. Each course's labs are
 * appended after the previous course's, so every existing index keeps its position (templates, CCNA 1 and CCNA 2
 * labs); the W6 automation labs join `CCNA3_LABS` itself, so they move nothing here either.
 */
import type { ScenarioInfo } from '../../contracts/scenario.js';
import { TEMPLATES } from './templates.js';
import { CCNA1_LABS } from './ccna1/index.js';
import { CCNA2_LABS } from './ccna2/index.js';
import { CCNA3_LABS } from './ccna3/index.js';

export * from './templates.js';
export { CCNA1_LABS } from './ccna1/index.js';
export { CCNA2_LABS } from './ccna2/index.js';
export { CCNA3_LABS } from './ccna3/index.js';

/**
 * Every built-in scenario: templates first (menu order), then the CCNA 1 labs, then the CCNA 2 labs, then the CCNA 3
 * labs (each in course order).
 */
export const SCENARIOS: readonly ScenarioInfo[] = [...TEMPLATES, ...CCNA1_LABS, ...CCNA2_LABS, ...CCNA3_LABS];
