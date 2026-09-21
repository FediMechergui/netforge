/**
 * curriculum/ccna1/theory.ts — the plain-language body of every CCNA 1 lesson, keyed by lesson id.
 *
 * The bodies are written in two halves so each file stays readable: `theory-a.ts` carries lessons 01…16 and
 * `theory-b.ts` carries 17…31. This file is only the join of the two, under the name `curriculum/index.ts`
 * imports; the key sets are disjoint and together cover every id in `ccna1/lessons.ts`, and a lesson with no
 * entry here simply shows no theory yet.
 *
 * Each value is markdown in the subset the labs already use (headings, lists, emphasis, code, and links limited to
 * `concept:subnetting`, `concept:ipv6` and https). No raw HTML: the parser treats that as a security boundary.
 * All prose is original and names no vendor.
 *
 * ponytail: a spread of the two halves rather than a re-export of either — the merge is the whole file, so a
 * third half would be one more line and nothing else has to move.
 */
import type { LessonTheoryMap } from '../../contracts/curriculum.js';
import { THEORY_A } from './theory-a.js';
import { THEORY_B } from './theory-b.js';

export const CCNA1_THEORY: LessonTheoryMap = { ...THEORY_A, ...THEORY_B };
