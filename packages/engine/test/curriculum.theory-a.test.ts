/**
 * The first-half theory bodies (`curriculum/ccna1/theory-a.ts`) are the right lessons, the right length and inside
 * the markdown subset the lab parser allows.
 *
 * The subset is a security boundary (apps/web/src/labs/markdown.ts): raw HTML is never parsed, and a link target
 * outside `concept:subnetting` / `concept:ipv6` / `https://…` is rendered as literal text rather than a link. This
 * test pins both from the engine side with plain regexes, so the prose can never be the reason a body degrades into
 * visible markup — and the web parser is not imported, because the engine package does not depend on the app.
 *
 * ponytail: a word is a whitespace-separated token holding at least one letter or digit, so `##` and `-` do not pad
 * the count while `192.168.1.0/24` counts as the one word a reader sees.
 */
import { describe, expect, it } from 'vitest';
import { CCNA1_MODULES } from '../src/curriculum/ccna1/lessons.js';
import { THEORY_A } from '../src/curriculum/ccna1/theory-a.js';

/** Every CCNA 1 lesson id in teaching order. */
const IDS = CCNA1_MODULES.flatMap((m) => m.lessons.map((l) => l.id));
/** The first half of the course, which is this file's half. */
const FIRST_HALF = IDS.slice(0, Math.ceil(IDS.length / 2));

/** The five sections every body carries, in this order. */
const SECTIONS = [
  '## The idea in one breath',
  '## Why it exists',
  '## How it actually works',
  '## What trips people up',
  '## See it in NetForge',
];

const MIN_WORDS = 250;
const MAX_WORDS = 450;

/** Link targets the lab markdown parser turns into links; anything else must not appear as a link. */
const ALLOWED_LINK = /^(?:concept:subnetting|concept:ipv6|https:\/\/[^\s<>"'`\\]+)$/;
const LINK = /\[[^\]\n]*\]\(([^()\s]*)\)/g;
/** Names this course never prints (§1.6 original wording, no vendors). */
const VENDORS = /\b(?:cisco|ios|packet\s*tracer|netacad|juniper|huawei)\b/i;

function words(body: string): number {
  return body.split(/\s+/).filter((w) => /[A-Za-z0-9]/.test(w)).length;
}

describe('CCNA 1 theory, first half', () => {
  it('covers exactly the first half of the lesson list, in order', () => {
    expect(Object.keys(THEORY_A)).toEqual(FIRST_HALF);
  });

  it('every key is a lesson of the skeleton', () => {
    expect(Object.keys(THEORY_A).filter((id) => !IDS.includes(id))).toEqual([]);
  });

  it('every body is between 250 and 450 words', () => {
    const wrong = Object.entries(THEORY_A)
      .map(([id, body]) => [id, words(body)] as const)
      .filter(([, n]) => n < MIN_WORDS || n > MAX_WORDS);
    expect(wrong).toEqual([]);
  });

  it('every body has the five sections, in order', () => {
    for (const [id, body] of Object.entries(THEORY_A)) {
      const found = body.split('\n').filter((line) => SECTIONS.includes(line));
      expect(found, id).toEqual(SECTIONS);
    }
  });

  it('every link target is one the lab parser allows', () => {
    for (const [id, body] of Object.entries(THEORY_A)) {
      for (const m of body.matchAll(LINK)) expect(m[1], `${id}: ${m[0]}`).toMatch(ALLOWED_LINK);
    }
  });

  it('no raw markup, no insecure links and no images', () => {
    for (const [id, body] of Object.entries(THEORY_A)) {
      expect(body, id).not.toMatch(/[<>]/);
      expect(body, id).not.toMatch(/http:\/\//i);
      expect(body, id).not.toMatch(/!\[/);
      expect(body, id).not.toMatch(/&[a-z]+;/i);
    }
  });

  it('names no vendor', () => {
    for (const [id, body] of Object.entries(THEORY_A)) expect(body, id).not.toMatch(VENDORS);
  });

  it('opens with a heading and closes without trailing blank lines', () => {
    for (const [id, body] of Object.entries(THEORY_A)) {
      expect(body.startsWith(SECTIONS[0]!), id).toBe(true);
      expect(body, id).toBe(body.trim());
    }
  });
});
