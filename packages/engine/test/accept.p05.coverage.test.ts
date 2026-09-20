/**
 * P0.5 exit gate (ARCHITECTURE-P1 §8.1 W7, §10.1): every acceptance test named in the brief's §10.1 table exists
 * in this directory, and every `accept.p05.*.test.ts` file here is named by that table (so the table and the suite
 * cannot drift apart). The pass conditions themselves live in the named files.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const BRIEF = join(HERE, '..', '..', '..', 'docs', 'ARCHITECTURE-P1.md');

/** Test file names in the first column of the §10.1 table. */
function briefAcceptanceFiles(): string[] {
  const text = readFileSync(BRIEF, 'utf8');
  const start = text.indexOf('### 10.1 P0.5 acceptance tests');
  const end = text.indexOf('### 10.2', start);
  expect(start).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(start);
  const out: string[] = [];
  for (const m of text.slice(start, end).matchAll(/^\| `(accept\.p05\.[a-z0-9-]+\.test\.ts)` \|/gm)) out.push(m[1]!);
  return out;
}

describe('accept P0.5: §10.1 coverage', () => {
  it('has a test file for every row of the §10.1 table, and no unlisted acceptance file', () => {
    const listed = briefAcceptanceFiles();
    expect(listed).toHaveLength(12);
    const present = readdirSync(HERE).filter((f) => /^accept\.p05\.[a-z0-9-]+\.test\.ts$/.test(f) && f !== 'accept.p05.coverage.test.ts');
    expect([...present].sort()).toEqual([...listed].sort());
  });
});
