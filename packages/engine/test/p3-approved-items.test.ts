/**
 * The approved-item list of `accept.p3.coverage` (ARCHITECTURE-P3 §7 W0, §10.1) equals the product owner's decision
 * record (§8.5 rows P1 and P2), and no file of an item that is not approved exists in P3a (§10.1: "the rows of
 * unapproved items … stay listed as the designs of their stage and must not exist as files in P3a").
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { P3_APPROVED_ITEMS } from './p3-approved-items.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const BRIEF = join(HERE, '..', '..', '..', 'docs', 'ARCHITECTURE-P3.md');

/** The body of a section of the brief: from its heading to the next heading of that level or higher. */
function section(heading: string): string {
  const text = readFileSync(BRIEF, 'utf8').replace(/\r\n/g, '\n');
  const start = text.indexOf(heading);
  expect(start, heading).toBeGreaterThan(0);
  const end = text.indexOf('\n### ', start + 1);
  return text.slice(start, end < 0 ? undefined : end);
}

/** The item ids in the bold "Recorded" text of the §8.5 row `id`. */
function recordedItems(id: string): string[] {
  const row = section('### 8.5 Decision record')
    .split('\n')
    .find((l) => l.startsWith(`| ${id} |`));
  expect(row, `§8.5 row ${id}`).toBeDefined();
  const cells = (row as string).split('|').map((c) => c.trim());
  const recorded = cells[4] ?? '';
  const bold = /\*\*([^*]+)\*\*/.exec(recorded);
  expect(bold, `bold decision of §8.5 row ${id}`).not.toBeNull();
  return (bold as RegExpExecArray)[1]!.match(/\b[SC]\d+\b/g) ?? [];
}

describe('P3 approved items (the list accept.p3.coverage carries)', () => {
  it('is exactly the SHOULD items of §8.5 P1 followed by the COULD items of §8.5 P2', () => {
    expect([...P3_APPROVED_ITEMS]).toEqual([...recordedItems('P1'), ...recordedItems('P2')]);
    expect([...P3_APPROVED_ITEMS]).toEqual(['S1', 'S2', 'S3', 'S9', 'S13', 'S18', 'S19', 'S20', 'S21', 'S24', 'S25', 'S32', 'S37', 'C1', 'C13']);
  });

  it('finds no acceptance file of an item that is not approved', () => {
    const approved = new Set<string>(P3_APPROVED_ITEMS);
    const rows = section('### 10.1 Engine acceptance')
      .split('\n')
      .filter((l) => l.startsWith('| `accept.p3.'));
    const unapproved: string[] = [];
    for (const row of rows) {
      const m = /^\| `([^`]+)`\s*\[([SC]\d+)\]/.exec(row);
      if (m !== null && !approved.has(m[2]!)) unapproved.push(m[1]!);
    }
    expect(unapproved.length).toBeGreaterThan(0);
    const present = new Set(readdirSync(HERE));
    expect(unapproved.filter((f) => present.has(f)), 'files of items that are not approved').toEqual([]);
  });
});
