/**
 * curriculum/ccna3/theory.ts — the plain-language body of every CCNA 3 lesson, keyed by lesson id
 * (ARCHITECTURE-P3 §7 W6 and W7 course, §11.1, §11.3).
 *
 * The bodies are written in parts so each file stays readable: `theory-a.ts` carries modules 1-4 (lessons 01-10:
 * routing concepts, one OSPF area, growing OSPF, EIGRP), `theory-b.ts` modules 5-8 (lessons 11-22), `theory-c.ts`
 * modules 9-13 (lessons 23-36) and `theory-d.ts` module 14 (lessons 37-40, written in W7 after the automation
 * grammar). This file is only the join; the key sets are disjoint, and a lesson with no entry simply shows no theory.
 *
 * Attached since the W7 course flip (§7 W7, §11.3): `curriculum/index.ts` joins this map onto the CCNA 3 skeleton
 * (`ccna3/lessons.ts`) with the videos, as it does for CCNA 1 and CCNA 2. `test/curriculum.ccna3.commands.test.ts`
 * still reads the map directly, so every body is checked whoever wrote it.
 */
import type { LessonTheoryMap } from '../../contracts/curriculum.js';
import { CCNA3_THEORY_A } from './theory-a.js';
import { CCNA3_THEORY_B } from './theory-b.js';
import { CCNA3_THEORY_C } from './theory-c.js';
import { CCNA3_THEORY_D } from './theory-d.js';

export const CCNA3_THEORY: LessonTheoryMap = { ...CCNA3_THEORY_A, ...CCNA3_THEORY_B, ...CCNA3_THEORY_C, ...CCNA3_THEORY_D };
