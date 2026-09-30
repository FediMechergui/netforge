/**
 * P2 acceptance — coverage of the §10.1 table (ARCHITECTURE-P2 §10.1 `accept.p2.coverage`; §7 W7 qa).
 *
 *   "Reads this table; fails when a listed file is missing or an `accept.p2.*.test.ts` file is not listed."
 *
 * The table in docs/ARCHITECTURE-P2.md §10.1 is the contract: every row names one acceptance file in its first column
 * (a wave or SHOULD tag such as `(W0)` or `[S2]` may follow the name). This test reads the table from the brief, so the
 * table and the suite cannot drift apart: a row without its file fails, and so does an `accept.p2.*.test.ts` file
 * anywhere under packages/engine/test/ that no row names. The pass conditions themselves live in the named files.
 *
 * ARCHITECTURE-P3 §9.2 W0 item 8: P3 split `accept.p2.replay-exact` into shards by category. The P2 brief is closed
 * and not edited, so this test carries one explicit shard record (`SHARDS`): the row `accept.p2.replay-exact.test.ts`
 * is satisfied by exactly its three shards, each of which must exist, and every `accept.p2.*.test.ts` file must be a
 * listed file or one of its shards (both directions kept).
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const BRIEF = join(HERE, '..', '..', '..', 'docs', 'ARCHITECTURE-P2.md');

/** An acceptance file name of this stage. */
const ACCEPT_P2 = /^accept\.p2\.[a-z0-9-]+\.test\.ts$/;

/**
 * Rows of the closed P2 brief that a later stage split into shards (ARCHITECTURE-P3 §9.2 W0 item 8), with the exact
 * files that satisfy each row. A sharded row is satisfied by its shards only: the unsplit file must not remain.
 */
const SHARDS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  'accept.p2.replay-exact.test.ts': Object.freeze([
    'accept.p2.replay-exact-templates.test.ts',
    'accept.p2.replay-exact-ccna1.test.ts',
    'accept.p2.replay-exact-ccna2.test.ts',
  ]),
});

/** The files that satisfy a row of the table: its shards when it was split, else the file it names. */
function filesOfRow(name: string): readonly string[] {
  return Object.prototype.hasOwnProperty.call(SHARDS, name) ? (SHARDS[name] as readonly string[]) : [name];
}

/** The body of §10.1: from its heading to the next heading. */
function section101(): string {
  const text = readFileSync(BRIEF, 'utf8');
  const start = text.indexOf('### 10.1 Engine acceptance');
  expect(start, '§10.1 heading in the brief').toBeGreaterThan(0);
  const end = text.indexOf('\n### ', start + 1);
  expect(end, 'the heading after §10.1').toBeGreaterThan(start);
  return text.slice(start, end);
}

/**
 * The file named in the first column of every body row of a §10.1-shaped table, in table order. EVERY line that starts
 * with `|` is a row, except the header (`| Test |`) and the separator (`|---`), so a row whose first column is not a
 * back-ticked file name fails loudly instead of being skipped (W7 review fix: rows used to be selected by a leading
 * back-tick, so a listed-but-missing file written without back-ticks passed).
 */
function tableFiles(body: string): string[] {
  expect(body).toMatch(/^\| Test \| Scenario and pass condition \|\r?$/m);
  const rows = body
    .split('\n')
    .map((l) => l.replace(/\r$/, ''))
    .filter((l) => l.startsWith('|') && !/^\| Test \|/.test(l) && !/^\|\s*-+/.test(l));
  const out: string[] = [];
  for (const row of rows) {
    const m = /^\| `([^`]+)`[^|]*\|/.exec(row);
    expect(m, `a table row whose first column is not a file name: ${row.slice(0, 80)}`).not.toBeNull();
    const name = m![1]!;
    expect(name, 'a table row names an accept.p2 test file').toMatch(ACCEPT_P2);
    out.push(name);
  }
  return out;
}

/** The file named in the first column of every row of the §10.1 table, in table order. */
function listedFiles(): string[] {
  return tableFiles(section101());
}

/** Every `accept.p2.*.test.ts` under `dir`, as paths relative to the engine's test directory. */
function acceptFilesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...acceptFilesUnder(path));
    else if (entry.isFile() && /^accept\.p2\./.test(entry.name) && entry.name.endsWith('.test.ts')) out.push(relative(HERE, path).split('\\').join('/'));
  }
  return out;
}

describe('P2 acceptance: the §10.1 table and the suite name the same files', () => {
  it('reads one file name per row of the §10.1 table, each once', () => {
    const listed = listedFiles();
    expect(listed.length).toBeGreaterThanOrEqual(25);
    expect(new Set(listed).size, 'no file is listed twice').toBe(listed.length);
    // the table lists this test too
    expect(listed).toContain('accept.p2.coverage.test.ts');
    // every pipe line of the section is the header, the separator or a row this reader returned
    const pipes = section101().split('\n').filter((l) => l.startsWith('|'));
    expect(listed.length).toBe(pipes.length - 2);
  });

  it('fails on a row whose first column is not a back-ticked file name, instead of skipping it', () => {
    const header = '| Test | Scenario and pass condition |\n|---|---|\n';
    const good = '| `accept.p2.coverage.test.ts` | Reads this table. |\n';
    expect(tableFiles(`${header}${good}`)).toEqual(['accept.p2.coverage.test.ts']);
    expect(tableFiles(`${header}| \`accept.p2.hsrp.test.ts\` [S2] | a tagged row |\n`)).toEqual(['accept.p2.hsrp.test.ts']);
    // the W7 review probe: a listed file written without back-ticks
    expect(() => tableFiles(`${header}${good}| accept.p2.missing-probe.test.ts | a row written without back-ticks |\n`)).toThrow(/first column is not a file name/);
    expect(() => tableFiles(`${header}| \`notes.md\` | not an acceptance file |\n`)).toThrow(/names an accept\.p2 test file/);
  });

  it('carries one shard record per split row, naming rows of the table and well-formed shard files (P3 §9.2 W0 item 8)', () => {
    const listed = listedFiles();
    expect(Object.keys(SHARDS)).toEqual(['accept.p2.replay-exact.test.ts']);
    for (const [row, shards] of Object.entries(SHARDS)) {
      expect(listed, 'a shard record names a row of the §10.1 table').toContain(row);
      expect(shards.length, row).toBeGreaterThan(1);
      expect(new Set(shards).size, row).toBe(shards.length);
      for (const s of shards) {
        expect(s, 'a shard is an accept.p2 test file').toMatch(ACCEPT_P2);
        expect(listed, 'a shard is not a row of its own').not.toContain(s);
      }
    }
  });

  it('has a file in packages/engine/test/ for every row of the table (every shard of a split row)', () => {
    const present = new Set(readdirSync(HERE));
    const missing = listedFiles().flatMap((f) => filesOfRow(f)).filter((f) => !present.has(f));
    expect(missing, 'files the §10.1 table lists (or the shards of a split row) that do not exist').toEqual([]);
  });

  it('lists every accept.p2.*.test.ts file of the engine suite in the table (a split row by its shards)', () => {
    const listed = new Set(listedFiles().flatMap((f) => filesOfRow(f)));
    const onDisk = acceptFilesUnder(HERE);
    expect(onDisk.length).toBeGreaterThan(0);
    // every acceptance file sits directly in test/ with a well-formed name, and the table names it
    expect(onDisk.filter((f) => !ACCEPT_P2.test(f)), 'accept.p2 files misplaced or misnamed').toEqual([]);
    expect(onDisk.filter((f) => !listed.has(f)), 'accept.p2 files the §10.1 table does not list').toEqual([]);
  });
});
