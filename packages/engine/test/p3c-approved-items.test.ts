/**
 * The approved list of P3c (ARCHITECTURE-P3C §0 rule 28, §7 W0, §8.5c): `P3C_APPROVED_ITEMS` equals the **Approved ids**
 * row of §8.5c, its bold array read with the regex `\b(?:[SC]\d+[ab]?|R63d)\b`, and `P3C_CURRENT_WAVE` is a wave of §7.
 * P3a's list (`p3-approved-items.ts`) and its test read ARCHITECTURE-P3 §8.5 and are untouched.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { P3C_APPROVED_ITEMS, P3C_CURRENT_WAVE, P3C_WAVES } from './p3c-approved-items.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const BRIEF = join(HERE, '..', '..', '..', 'docs', 'ARCHITECTURE-P3C.md');

/** An approved id of P3c (rule 28): `S17a`, `S36a`, `S36b` and `R63d` included. */
const ID = /\b(?:[SC]\d+[ab]?|R63d)\b/g;

/** The body of a section of the brief: from its heading to the next heading of level 2 up to `depth`. */
function section(heading: string, depth = 4): string {
  const text = readFileSync(BRIEF, 'utf8').replace(/\r\n/g, '\n');
  const start = text.indexOf(heading);
  expect(start, heading).toBeGreaterThan(0);
  const end = text.slice(start + heading.length).search(new RegExp(`\\n#{2,${depth}} `));
  return end < 0 ? text.slice(start) : text.slice(start, start + heading.length + end);
}

/** The ids of a bold array, in order. */
const idsIn = (text: string): string[] => text.match(ID) ?? [];

/** The ids of the bold array in the `Approved ids` row of §8.5c. */
function approvedRow(): string[] {
  const rows = section('#### 8.5c Approved ids (machine-read)')
    .split('\n')
    .filter((l) => l.startsWith('| Approved ids |'));
  expect(rows, 'exactly one Approved ids row in §8.5c').toHaveLength(1);
  const cells = rows[0]!.split('|').map((c) => c.trim());
  const bold = /^\*\*([^*]+)\*\*$/.exec(cells[2] ?? '');
  expect(bold, 'the Ids cell of the Approved ids row is one bold array').not.toBeNull();
  return idsIn(bold![1]!);
}

describe('P3c approved items (the list accept.p3c.coverage carries)', () => {
  it('is exactly the Approved ids row of §8.5c, in its order', () => {
    const row = approvedRow();
    expect(row.length).toBeGreaterThan(0);
    expect([...P3C_APPROVED_ITEMS]).toEqual(row);
    expect(new Set(P3C_APPROVED_ITEMS).size, 'no id twice').toBe(P3C_APPROVED_ITEMS.length);
  });

  it('reads the split ids that P3a\'s regex cannot read', () => {
    expect(idsIn('S17a, S36a, S36b, R63d, C8, S4')).toEqual(['S17a', 'S36a', 'S36b', 'R63d', 'C8', 'S4']);
    expect('S17a, S36a, R63d'.match(/\b[SC]\d+\b/g)).toBeNull();
    for (const id of ['S17a', 'S36a', 'S36b', 'R63d']) expect(P3C_APPROVED_ITEMS as readonly string[], id).toContain(id);
    // R63 alone, an X/A/M/W row id or a P3a-style H item is not an approved id
    expect(idsIn('R63, X-5, A-3, M-23, W-2, H1')).toEqual([]);
  });

  it('names a current wave of §7, W0 at this wave', () => {
    expect(P3C_WAVES as readonly string[]).toContain(P3C_CURRENT_WAVE);
    expect(P3C_CURRENT_WAVE).toBe('W0');
    // every wave of the list has its heading in §7 (W3a by its run headings W3a1 / W3a2 under it)
    const s7 = section('## 7. Module map and build waves', 2);
    for (const w of P3C_WAVES) expect(s7, w).toMatch(new RegExp(`\\n#{3,4} ${w}\\b`));
  });
});
