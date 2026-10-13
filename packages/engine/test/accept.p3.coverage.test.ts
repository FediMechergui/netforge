/**
 * P3 acceptance — coverage of the §10.1 table (ARCHITECTURE-P3 §10.1 `accept.p3.coverage`; §7 W7 qa).
 *
 *   "Reads this table by the rule above; fails when a listed file is missing, when a row does not name exactly one
 *    file, or when an `accept.p3.*.test.ts` file is not listed."
 *
 * The table in docs/ARCHITECTURE-P3.md §10.1 is the contract, read with the rule `accept.p2.coverage.test.ts` uses:
 * EVERY line of the section that starts with `|` is a row, except the header (`| Test |`) and the separator (`|---`),
 * and each row's first column is exactly one back-ticked file name matching `^accept\.p3\.[a-z0-9-]+\.test\.ts$`,
 * optionally followed by one wave tag `(Wn)` or one item tag `[Sn]` / `[Cn]` — one file per row, no brace expansions,
 * so a row that names no file, two files or a pattern fails loudly instead of being skipped.
 *
 * A row tagged `[Sn]` or `[Cn]` is required only when that item is approved: the approved list of §8.5 P1 and P2 is
 * the exact array written in W0 (`test/p3-approved-items.ts`, proved equal to §8.5 by `p3-approved-items.test.ts`),
 * and the same array is printed in the paragraph above the table. Every other row is required. So:
 *   • every required row has its file directly in packages/engine/test/;
 *   • the rows of unapproved items stay listed as the designs of their stage and must NOT exist as files in P3a;
 *   • the paragraph's two lists agree with the table, so the prose and the table cannot drift apart either: the
 *     unapproved items are exactly the unapproved row tags, every approved row tag is in the required list, and every
 *     required item is a row's tag or a clause of a required row ([S25] lives in the [S24] syslog row);
 *   • every `accept.p3.*.test.ts` file anywhere under packages/engine/test/ sits directly in test/, is well formed, and
 *     is named by a row (helpers such as `accept.p3.qos.harness.ts` are not test files and are not rows).
 * The reader and each of the three file checks also run on a synthetic table (the probes), so a check that could never
 * fail is caught. The pass conditions themselves live in the named files.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { P3_APPROVED_ITEMS } from './p3-approved-items.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const BRIEF = join(HERE, '..', '..', '..', 'docs', 'ARCHITECTURE-P3.md');

/** An acceptance file name of this stage (§10.1). */
const ACCEPT_P3 = /^accept\.p3\.[a-z0-9-]+\.test\.ts$/;

/**
 * A row: `| ` + exactly one back-ticked name + an optional ` (Wn)` or ` [Sn]` / ` [Cn]` + ` |`. The name inside the
 * back-ticks is checked against `ACCEPT_P3` separately, so a brace expansion or a misnamed file says what is wrong.
 */
const ROW = /^\| `([^`]+)`(?: \((W\d+)\)| \[([SC]\d+)\])? \|/;

/** The approved SHOULD and COULD items of §8.5 P1 and P2, as the exact array written in W0. */
const APPROVED = ['S1', 'S2', 'S3', 'S9', 'S13', 'S18', 'S19', 'S20', 'S21', 'S24', 'S25', 'S32', 'S37', 'C1', 'C13'] as const;

/** One row of the table. */
interface Row {
  /** The file it names. */
  readonly file: string;
  /** Its wave tag (`W4`), if any. */
  readonly wave?: string;
  /** Its item tag (`S13`, `C1`), if any. */
  readonly item?: string;
}

/** The brief's text with Windows line ends normalised. */
function brief(): string {
  return readFileSync(BRIEF, 'utf8').replace(/\r\n/g, '\n');
}

/** The body of §10.1: from its heading to the next heading. */
function section101(): string {
  const text = brief();
  const start = text.indexOf('### 10.1 Engine acceptance');
  expect(start, '§10.1 heading in the brief').toBeGreaterThan(0);
  const end = text.indexOf('\n### ', start + 1);
  expect(end, 'the heading after §10.1').toBeGreaterThan(start);
  return text.slice(start, end);
}

/**
 * Every body row of a §10.1-shaped table, in table order. EVERY line that starts with `|` is a row except the header
 * and the separator, so a row whose first column is not exactly one back-ticked acceptance file name fails.
 */
function tableRows(body: string): Row[] {
  expect(body).toMatch(/^\| Test \| Scenario and pass condition \|$/m);
  const lines = body.split('\n').filter((l) => l.startsWith('|') && !/^\| Test \|/.test(l) && !/^\|\s*-+/.test(l));
  const out: Row[] = [];
  for (const line of lines) {
    const m = ROW.exec(line);
    expect(m, `a table row whose first column is not exactly one file name: ${line.slice(0, 80)}`).not.toBeNull();
    const [, file, wave, item] = m!;
    expect(file, 'a table row names one accept.p3 test file').toMatch(ACCEPT_P3);
    out.push({ file: file!, ...(wave === undefined ? {} : { wave }), ...(item === undefined ? {} : { item }) });
  }
  return out;
}

/** The rows of the §10.1 table, in table order. */
function listedRows(): Row[] {
  return tableRows(section101());
}

/** Whether a row must have its file in P3a: untagged by an item, or tagged by an approved one. */
const required = (r: Row): boolean => r.item === undefined || (P3_APPROVED_ITEMS as readonly string[]).includes(r.item);

/** The paragraph above the table, on one line (its wording wraps across lines in the brief). */
function preamble(): string {
  const body = section101();
  return body.slice(0, body.indexOf('\n| Test |')).replace(/\s+/g, ' ');
}

/** The `[Sn]` / `[Cn]` ids in a stretch of prose, in order. */
const tagsIn = (text: string): string[] => [...text.matchAll(/\[([SC]\d+)\]/g)].map((m) => m[1]!);

/** The required rows whose file is not among `present` (the names directly in test/). */
const missingOf = (rows: readonly Row[], present: ReadonlySet<string>): string[] => rows.filter(required).map((r) => r.file).filter((f) => !present.has(f));

/** The rows of items that are not approved whose file nevertheless exists among `present`. */
const unapprovedPresentOf = (rows: readonly Row[], present: ReadonlySet<string>): string[] =>
  rows.filter((r) => !required(r)).map((r) => r.file).filter((f) => present.has(f));

/** The acceptance files `onDisk` (paths relative to test/) that are misplaced, misnamed or named by no row. */
function unlistedOf(rows: readonly Row[], onDisk: readonly string[]): { misnamed: string[]; unlisted: string[] } {
  const listed = new Set(rows.map((r) => r.file));
  return { misnamed: onDisk.filter((f) => !ACCEPT_P3.test(f)), unlisted: onDisk.filter((f) => ACCEPT_P3.test(f) && !listed.has(f)) };
}

/** Every `accept.p3.*.test.ts` under `dir`, as paths relative to the engine's test directory. */
function acceptFilesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...acceptFilesUnder(path));
    else if (entry.isFile() && /^accept\.p3\./.test(entry.name) && entry.name.endsWith('.test.ts')) out.push(relative(HERE, path).split('\\').join('/'));
  }
  return out;
}

describe('P3 acceptance: the §10.1 table and the suite name the same files', () => {
  it('reads exactly one file name per row of the §10.1 table, each once', () => {
    const rows = listedRows();
    const files = rows.map((r) => r.file);
    expect(files.length).toBeGreaterThanOrEqual(60);
    expect(new Set(files).size, 'no file is listed twice').toBe(files.length);
    // the table lists the three W7 qa rows, this test among them
    for (const f of ['accept.p3.coverage.test.ts', 'accept.p3.labs.test.ts', 'accept.p3.determinism.test.ts']) {
      expect(rows.find((r) => r.file === f), f).toEqual({ file: f, wave: 'W7' });
    }
    // every pipe line of the section is the header, the separator or a row this reader returned
    const pipes = section101().split('\n').filter((l) => l.startsWith('|'));
    expect(rows.length).toBe(pipes.length - 2);
  });

  it('fails on a row that does not name exactly one acceptance file, instead of skipping it', () => {
    const header = '| Test | Scenario and pass condition |\n|---|---|\n';
    const good = '| `accept.p3.coverage.test.ts` (W7) | Reads this table. |\n';
    expect(tableRows(`${header}${good}`)).toEqual([{ file: 'accept.p3.coverage.test.ts', wave: 'W7' }]);
    expect(tableRows(`${header}| \`accept.p3.vty.test.ts\` [S13] | a tagged row |\n| \`accept.p3.eigrp.test.ts\` [C1] | a COULD row |\n`)).toEqual([
      { file: 'accept.p3.vty.test.ts', item: 'S13' },
      { file: 'accept.p3.eigrp.test.ts', item: 'C1' },
    ]);
    expect(tableRows(`${header}| \`accept.p3.untagged.test.ts\` | an untagged row |\n`)).toEqual([{ file: 'accept.p3.untagged.test.ts' }]);
    // a listed file written without back-ticks
    expect(() => tableRows(`${header}${good}| accept.p3.missing-probe.test.ts | a row written without back-ticks |\n`)).toThrow(/not exactly one file name/);
    // two files in one row
    expect(() => tableRows(`${header}| \`accept.p3.a.test.ts\`, \`accept.p3.b.test.ts\` (W7) | two files |\n`)).toThrow(/not exactly one file name/);
    expect(() => tableRows(`${header}| \`accept.p3.a.test.ts\` \`accept.p3.b.test.ts\` | two files |\n`)).toThrow(/not exactly one file name/);
    // a brace expansion
    expect(() => tableRows(`${header}| \`accept.p3.{labs,coverage}.test.ts\` (W7) | a pattern |\n`)).toThrow(/names one accept\.p3 test file/);
    // not an acceptance file of this stage, or a tag of another shape
    expect(() => tableRows(`${header}| \`accept.p2.coverage.test.ts\` | another stage |\n`)).toThrow(/names one accept\.p3 test file/);
    expect(() => tableRows(`${header}| \`notes.md\` | not an acceptance file |\n`)).toThrow(/names one accept\.p3 test file/);
    expect(() => tableRows(`${header}| \`accept.p3.x.test.ts\` [M3] | a MUST tag |\n`)).toThrow(/not exactly one file name/);
    expect(() => tableRows(`${header}| \`accept.p3.x.test.ts\` (W4) [S13] | two tags |\n`)).toThrow(/not exactly one file name/);
  });

  it('carries the approved list of §8.5 P1 and P2 as the exact array written in W0, the one the paragraph prints', () => {
    expect([...P3_APPROVED_ITEMS]).toEqual([...APPROVED]);
    const printed = /`\[((?:'[SC]\d+',?\s*)+)\]`/.exec(preamble());
    expect(printed, 'the approved array in the paragraph above the table').not.toBeNull();
    expect([...printed![1]!.matchAll(/'([SC]\d+)'/g)].map((m) => m[1])).toEqual([...APPROVED]);
  });

  it('requires a tagged row only when its item is approved; the paragraph\'s two lists agree with the table\'s tags', () => {
    const rows = listedRows();
    const text = preamble();
    const requiredPart = /so the rows of (.*?) are required/.exec(text);
    const unapprovedPart = /the rows of unapproved items \((.*?)\)/.exec(text);
    expect(requiredPart, 'the paragraph lists the required tagged rows').not.toBeNull();
    expect(unapprovedPart, 'the paragraph lists the unapproved items').not.toBeNull();
    const requiredTags = tagsIn(requiredPart![1]!);
    const unapprovedTags = tagsIn(unapprovedPart![1]!);

    // every item tag of the table, in order of first appearance, split by approval
    const tagged = [...new Set(rows.flatMap((r) => (r.item === undefined ? [] : [r.item])))];
    const approvedInTable = tagged.filter((t) => (P3_APPROVED_ITEMS as readonly string[]).includes(t));
    const unapprovedInTable = tagged.filter((t) => !(P3_APPROVED_ITEMS as readonly string[]).includes(t));
    // the unapproved items are exactly the unapproved row tags
    expect([...unapprovedTags].sort()).toEqual([...unapprovedInTable].sort());
    expect(unapprovedTags.length).toBeGreaterThan(0);
    for (const t of unapprovedTags) expect(APPROVED, t).not.toContain(t);
    // every approved row tag is a required one; a required item without a row of its own is proved inside a required
    // row ([S25]'s syslog server and extended logging are clauses of the [S24] `accept.p3.syslog` row)
    for (const t of approvedInTable) expect(requiredTags, t).toContain(t);
    const requiredText = section101()
      .split('\n')
      .filter((l) => {
        const m = ROW.exec(l);
        return m !== null && required({ file: m[1]!, ...(m[3] === undefined ? {} : { item: m[3] }) });
      })
      .join('\n');
    for (const t of requiredTags) {
      expect(APPROVED, t).toContain(t);
      expect(approvedInTable.includes(t) || requiredText.includes(`[${t}]`), `[${t}] is the tag of a row or a clause of a required row`).toBe(true);
    }
    // a wave-tagged or untagged row is always required
    for (const r of rows) if (r.item === undefined) expect(required(r), r.file).toBe(true);
  });

  it('reports a missing required file, a file of an unapproved item and an unlisted or misplaced file (probes)', () => {
    const rows: Row[] = [
      { file: 'accept.p3.here.test.ts', wave: 'W4' },
      { file: 'accept.p3.gone.test.ts', wave: 'W7' },
      { file: 'accept.p3.approved.test.ts', item: 'S13' },
      { file: 'accept.p3.approved-gone.test.ts', item: 'C1' },
      { file: 'accept.p3.later.test.ts', item: 'S4' },
    ];
    const present = new Set(['accept.p3.here.test.ts', 'accept.p3.approved.test.ts', 'accept.p3.later.test.ts', 'accept.p3.stray.test.ts']);
    expect(missingOf(rows, present)).toEqual(['accept.p3.gone.test.ts', 'accept.p3.approved-gone.test.ts']);
    expect(unapprovedPresentOf(rows, present)).toEqual(['accept.p3.later.test.ts']);
    expect(unlistedOf(rows, ['accept.p3.here.test.ts', 'accept.p3.stray.test.ts', 'sub/accept.p3.here.test.ts'])).toEqual({
      misnamed: ['sub/accept.p3.here.test.ts'],
      unlisted: ['accept.p3.stray.test.ts'],
    });
  });

  it('has a file in packages/engine/test/ for every required row of the table', () => {
    expect(missingOf(listedRows(), new Set(readdirSync(HERE))), 'files the §10.1 table requires that do not exist').toEqual([]);
  });

  it('has no file for a row of an item that is not approved (the design of its stage)', () => {
    const rows = listedRows();
    expect(rows.filter((r) => !required(r)).length).toBeGreaterThan(0);
    expect(unapprovedPresentOf(rows, new Set(readdirSync(HERE))), 'files of items that are not approved').toEqual([]);
  });

  it('lists every accept.p3.*.test.ts file of the engine suite in the table', () => {
    const onDisk = acceptFilesUnder(HERE);
    expect(onDisk.length).toBeGreaterThan(0);
    // every acceptance file sits directly in test/ with a well-formed name, and the table names it
    const { misnamed, unlisted } = unlistedOf(listedRows(), onDisk);
    expect(misnamed, 'accept.p3 files misplaced or misnamed').toEqual([]);
    expect(unlisted, 'accept.p3 files the §10.1 table does not list').toEqual([]);
  });
});
