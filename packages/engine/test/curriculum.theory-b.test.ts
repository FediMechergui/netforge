/**
 * The second half of the CCNA 1 theory (`curriculum/ccna1/theory-b.ts`): every body belongs to a lesson that
 * exists, is the right length, keeps to the markdown subset the lab parser allows, and only ever tells the reader
 * to type a command the CLI grammar actually ships.
 *
 * The last check is the one that earns its place: prose drifts away from the product silently, so the command
 * lines inside the code of each body are matched against `GRAMMAR` literal prefixes. A command that is renamed or
 * dropped fails here instead of teaching a reader something that no longer works.
 *
 * ponytail: the markdown rules are re-stated as small regexes rather than imported, because the parser lives in
 * `apps/web` and the engine package may not depend on it. They are deliberately stricter than the parser: this
 * file is checking what we wrote, not what the parser would survive.
 */
import { describe, expect, it } from 'vitest';
import { CCNA1_MODULES } from '../src/curriculum/ccna1/lessons.js';
import { THEORY_B } from '../src/curriculum/ccna1/theory-b.js';
import { GRAMMAR } from '../src/cli/grammar/index.js';

/** Every CCNA 1 lesson id in teaching order. */
const ORDER: readonly string[] = CCNA1_MODULES.flatMap((m) => m.lessons.map((l) => l.id));

/** The half this file owns: `ceil(n / 2) + 1` … `n`, as ids. */
const SECOND_HALF: readonly string[] = ORDER.slice(Math.ceil(ORDER.length / 2));

const MIN_WORDS = 250;
const MAX_WORDS = 450;

/** The five sections every body carries, in order. */
const SECTIONS = [
  '## The idea in one breath',
  '## Why it exists',
  '## How it actually works',
  '## What trips people up',
  '## See it in NetForge',
];

/** Names that may never appear in the prose (original wording, no vendor). */
const FORBIDDEN = ['cisco', 'ios', 'packet tracer', 'netacad', 'juniper', 'mikrotik'];

/** Words of a body: whitespace-separated runs that hold at least one letter or digit. */
function words(text: string): number {
  return text.split(/\s+/).filter((t) => /[A-Za-z0-9]/.test(t)).length;
}

/** Every `[text](target)` target in a body. */
function linkTargets(text: string): string[] {
  return [...text.matchAll(/\[[^\]\n]*\]\(([^()\s]*)\)/g)].map((m) => m[1] ?? '');
}

/** The lines inside fenced code blocks, and the text of every inline code span. */
function codeRuns(text: string): string[] {
  const out: string[] = [];
  let fenced = false;
  for (const line of text.split('\n')) {
    if (line.startsWith('```')) {
      fenced = !fenced;
      continue;
    }
    if (fenced) {
      if (line.trim() !== '') out.push(line.trim());
      continue;
    }
    for (const m of line.matchAll(/`([^`\n]+)`/g)) out.push((m[1] ?? '').trim());
  }
  expect(fenced, 'an unclosed code fence').toBe(false);
  return out;
}

/** First literal words of a command spec, up to its first `<arg>` placeholder. */
function literalPrefix(path: readonly string[]): string[] {
  const out: string[] = [];
  for (const part of path) {
    if (part.startsWith('<')) break;
    out.push(part);
  }
  return out;
}

const PREFIXES: readonly string[][] = GRAMMAR.map((s) => literalPrefix(s.path)).filter((p) => p.length > 0);
/** Words a real command may start with; anything else in code is an address, a name or a value. */
const COMMAND_WORDS = new Set(PREFIXES.map((p) => p[0] as string));

/** Whether some grammar spec's literal prefix opens this command line. */
function isKnownCommand(line: string): boolean {
  const said = line.split(/\s+/);
  const body = said[0] === 'no' ? said.slice(1) : said;
  if (body.length === 0) return false;
  return PREFIXES.some((prefix) => prefix.length <= body.length && prefix.every((w, i) => w === body[i]));
}

describe('CCNA 1 theory, second half', () => {
  it('covers exactly the second half of the lesson list, and nothing else', () => {
    expect(Object.keys(THEORY_B)).toEqual([...SECOND_HALF]);
    expect(SECOND_HALF.length).toBeGreaterThan(0);
    for (const id of Object.keys(THEORY_B)) {
      expect(ORDER, `${id} is not a lesson of CCNA 1`).toContain(id);
    }
  });

  it('keeps every body inside the word range', () => {
    for (const [id, text] of Object.entries(THEORY_B)) {
      const n = words(text);
      expect(n, `${id} is ${n} words, under ${MIN_WORDS}`).toBeGreaterThanOrEqual(MIN_WORDS);
      expect(n, `${id} is ${n} words, over ${MAX_WORDS}`).toBeLessThanOrEqual(MAX_WORDS);
    }
  });

  it('gives every body the same five sections in the same order', () => {
    for (const [id, text] of Object.entries(THEORY_B)) {
      const headings = text.split('\n').filter((l) => l.startsWith('#'));
      expect(headings, `${id} has the wrong sections`).toEqual(SECTIONS);
    }
  });

  it('links only to the allowlisted targets', () => {
    for (const [id, text] of Object.entries(THEORY_B)) {
      for (const target of linkTargets(text)) {
        const allowed = target === 'concept:subnetting' || target === 'concept:ipv6' || /^https:\/\/[^\s<>"'`\\]+$/i.test(target);
        expect(allowed, `${id} links to ${target}`).toBe(true);
      }
    }
  });

  it('holds no raw HTML and no vendor name', () => {
    for (const [id, text] of Object.entries(THEORY_B)) {
      expect(/<[a-zA-Z/!?]/.test(text), `${id} contains something that looks like markup`).toBe(false);
      const lower = text.toLowerCase();
      for (const name of FORBIDDEN) {
        expect(lower.includes(name), `${id} names ${name}`).toBe(false);
      }
    }
  });

  it('only shows commands the CLI grammar really has', () => {
    let checked = 0;
    for (const [id, text] of Object.entries(THEORY_B)) {
      for (const run of codeRuns(text)) {
        const first = run.split(/\s+/)[0] ?? '';
        const head = first === 'no' ? (run.split(/\s+/)[1] ?? '') : first;
        if (!COMMAND_WORDS.has(head)) continue; // an address, a name, a path or a value, not a command
        checked++;
        expect(isKnownCommand(run), `${id} shows "${run}", which no command spec matches`).toBe(true);
      }
    }
    // The check is only worth anything if it saw most of the command lines; a filter that swallowed them silently
    // would pass an empty loop.
    expect(checked, 'too few command lines were recognised as commands at all').toBeGreaterThan(60);
  });
});
