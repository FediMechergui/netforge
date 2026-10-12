/**
 * curriculum/ccna3/theory.ts — the plain-language body of every CCNA 3 lesson, keyed by lesson id
 * (ARCHITECTURE-P3 §7 W6 course, §11.1, §11.3).
 *
 * The bodies are written in parts so each file stays readable: `theory-a.ts` carries modules 1-4 (lessons 01-10:
 * routing concepts, one OSPF area, growing OSPF, EIGRP), `theory-b.ts` modules 5-8 (lessons 11-22) and `theory-c.ts`
 * modules 9-13 (lessons 23-36). Module 14 (lessons 37-40, `theory-d.ts`) is written in W7, after the automation
 * grammar, and joins here then. This file is only the join; the key sets are disjoint, and a lesson with no entry
 * simply shows no theory.
 *
 * DETACHED like `ccna3/lessons.ts` until the W7 course flip: `curriculum/index.ts` joins it onto the CCNA 3 skeleton
 * then (§11.3). Until that change `test/curriculum.ccna3.commands.test.ts` reads it directly.
 */
import type { LessonTheoryMap } from '../../contracts/curriculum.js';
import { CCNA3_THEORY_A } from './theory-a.js';
import { CCNA3_THEORY_B } from './theory-b.js';
import { CCNA3_THEORY_C } from './theory-c.js';

export const CCNA3_THEORY: LessonTheoryMap = { ...CCNA3_THEORY_A, ...CCNA3_THEORY_B, ...CCNA3_THEORY_C };
