/**
 * curriculum/ccna2/theory.ts — the plain-language body of every CCNA 2 lesson, keyed by lesson id.
 *
 * The bodies are written in three parts so each file stays readable: `theory-a.ts` carries lessons 01-11,
 * `theory-b.ts` 12-21 and `theory-c.ts` 22-24 and 29-34 (the wireless lessons 25-28 follow in W7). This file is only
 * the join of the three; the key sets are disjoint, and a lesson with no entry simply shows no theory yet.
 * `curriculum/index.ts` imports it when the CCNA 2 course is attached (W7, ARCHITECTURE-P2 §11.3).
 */
import type { LessonTheoryMap } from '../../contracts/curriculum.js';
import { THEORY_A } from './theory-a.js';
import { THEORY_B } from './theory-b.js';
import { THEORY_C } from './theory-c.js';

export const CCNA2_THEORY: LessonTheoryMap = { ...THEORY_A, ...THEORY_B, ...THEORY_C };
