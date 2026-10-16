/**
 * P3c acceptance — coverage of the §10.1 table (ARCHITECTURE-P3C §0 rule 28, §7 W0, §10.1 `accept.p3c.coverage`).
 *
 *   "Every row of this table names exactly one file; every `accept.p3c.*.test.ts` file is named by a row (this one
 *    included); a row whose Arrives wave is later than `P3C_CURRENT_WAVE` is pending (its file absent, or present and
 *    named); every non-pending row of an approved id (§8.5c) exists, and no row of an unapproved item exists as a file;
 *    at W7 no row is pending."
 *
 * The table in docs/ARCHITECTURE-P3C.md §10.1 is the contract, read with the rule of P3a's `accept.p3.coverage`,
 * adapted: EVERY line of the section that starts with `|` is a row, except the header (`| Test | Arrives | … |`) and the
 * separator; each row's first column is exactly one back-ticked name matching `^accept\.p3c\.[a-z0-9-]+\.test\.ts$`
 * followed by one wave tag (`(W0)`, `(W0h)`, `(W4b)`, `(W5b)`) or one item tag `[Sn]`, `[Cn]` (with `a`/`b` splits) or
 * `[R63d]`; its second column, **Arrives**, is the wave of §7 in which the file is written.
 *
 * A row is required (its file must exist) when its Arrives wave has been reached (`P3C_CURRENT_WAVE`, the constant
 * the lead advances) and it is wave-tagged or tagged with an approved id (`P3C_APPROVED_ITEMS`, proved equal to §8.5c by
 * `p3c-approved-items.test.ts`); a row of an item that is not approved must not exist as a file; a pending row's file
 * may be absent, or present (it is then named by its row and, like any test, must pass). So the six checks stay green
 * from W0 (rule 4), and at W7 every approved row must exist. The reader and each file check also run on a synthetic
 * table (the probes), so a check that could never fail is caught. P3a's `accept.p3.coverage`, `P3_APPROVED_ITEMS` and
 * their tests are not touched (D4).
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { P3C_APPROVED_ITEMS, P3C_CURRENT_WAVE, P3C_WAVES, type P3cWave } from './p3c-approved-items.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const BRIEF = join(HERE, '..', '..', '..', 'docs', 'ARCHITECTURE-P3C.md');

/** An acceptance file name of this stage (§10.1, rule 28). */
const ACCEPT_P3C = /^accept\.p3c\.[a-z0-9-]+\.test\.ts$/;

/** The wave tags a first column may carry (§10.1). */
const WAVE_TAGS = ['W0', 'W0h', 'W4b', 'W5b'] as const;

/**
 * A row: `| ` + exactly one back-ticked name + one ` (W…)` wave tag or one ` [id]` item tag + ` | ` + the Arrives wave +
 * ` |`. The name inside the back-ticks is checked against `ACCEPT_P3C` separately, so a brace expansion or a misnamed
 * file says what is wrong.
 */
const ROW = /^\| `([^`]+)` (?:\((W\d+[a-z]?)\)|\[((?:[SC]\d+[ab]?|R63d))\]) \| (W\d+[a-z]?) \|/;

/** One row of the table. */
interface Row {
  /** The file it names. */
  readonly file: string;
  /** Its Arrives wave. */
  readonly arrives: P3cWave;
  /** Its wave tag (`W0`), if any. */
  readonly wave?: string;
  /** Its item tag (`S40`, `R63d`), if any. */
  readonly item?: string;
}

/** The body of §10.1: from its heading to the next heading. */
function section101(): string {
  const text = readFileSync(BRIEF, 'utf8').replace(/\r\n/g, '\n');
  const start = text.indexOf('### 10.1 Engine acceptance');
  expect(start, '§10.1 heading in the brief').toBeGreaterThan(0);
  const end = text.indexOf('\n### ', start + 1);
  expect(end, 'the heading after §10.1').toBeGreaterThan(start);
  return text.slice(start, end);
}

/** The position of a wave in build order. */
const order = (w: P3cWave): number => P3C_WAVES.indexOf(w);

/**
 * Every body row of a §10.1-shaped table, in table order. EVERY line that starts with `|` is a row except the header and
 * the separator, so a row whose first column is not exactly one tagged acceptance file name, or whose Arrives cell is not
 * a wave, fails.
 */
function tableRows(body: string): Row[] {
  expect(body).toMatch(/^\| Test \| Arrives \| Scenario and pass condition \|$/m);
  const lines = body.split('\n').filter((l) => l.startsWith('|') && !/^\| Test \|/.test(l) && !/^\|\s*-+/.test(l));
  const out: Row[] = [];
  for (const line of lines) {
    const m = ROW.exec(line);
    expect(m, `a table row whose first column is not exactly one tagged file name: ${line.slice(0, 80)}`).not.toBeNull();
    const [, file, wave, item, arrives] = m!;
    expect(file, 'a table row names one accept.p3c test file').toMatch(ACCEPT_P3C);
    expect(P3C_WAVES as readonly string[], `the Arrives wave of ${file}`).toContain(arrives);
    if (wave !== undefined) {
      expect(WAVE_TAGS as readonly string[], `the wave tag of ${file}`).toContain(wave);
      expect(wave, `the wave tag of ${file} is its Arrives wave`).toBe(arrives);
    }
    out.push({ file: file!, arrives: arrives as P3cWave, ...(wave === undefined ? {} : { wave }), ...(item === undefined ? {} : { item }) });
  }
  return out;
}

/** The rows of the §10.1 table, in table order. */
const listedRows = (): Row[] => tableRows(section101());

/** Whether a row belongs to P3c's scope: wave-tagged, or tagged with an approved id. */
const inScope = (r: Row, approved: readonly string[] = P3C_APPROVED_ITEMS): boolean => r.item === undefined || approved.includes(r.item);

/** Whether a row is pending at `current`: its Arrives wave is later. */
const pending = (r: Row, current: P3cWave = P3C_CURRENT_WAVE): boolean => order(r.arrives) > order(current);

/** The in-scope, non-pending rows whose file is not among `present` (the names directly in test/). */
const missingOf = (rows: readonly Row[], present: ReadonlySet<string>, current: P3cWave = P3C_CURRENT_WAVE, approved: readonly string[] = P3C_APPROVED_ITEMS): string[] =>
  rows.filter((r) => inScope(r, approved) && !pending(r, current)).map((r) => r.file).filter((f) => !present.has(f));

/** The rows of items that are not approved whose file nevertheless exists among `present`. */
const unapprovedPresentOf = (rows: readonly Row[], present: ReadonlySet<string>, approved: readonly string[] = P3C_APPROVED_ITEMS): string[] =>
  rows.filter((r) => !inScope(r, approved)).map((r) => r.file).filter((f) => present.has(f));

/** The acceptance files `onDisk` (paths relative to test/) that are misplaced, misnamed or named by no row. */
function unlistedOf(rows: readonly Row[], onDisk: readonly string[]): { misnamed: string[]; unlisted: string[] } {
  const listed = new Set(rows.map((r) => r.file));
  return { misnamed: onDisk.filter((f) => !ACCEPT_P3C.test(f)), unlisted: onDisk.filter((f) => ACCEPT_P3C.test(f) && !listed.has(f)) };
}

/** Every `accept.p3c.*.test.ts` under `dir`, as paths relative to the engine's test directory. */
function acceptFilesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...acceptFilesUnder(path));
    else if (entry.isFile() && /^accept\.p3c\./.test(entry.name) && entry.name.endsWith('.test.ts')) out.push(relative(HERE, path).split('\\').join('/'));
  }
  return out;
}

describe('P3c acceptance: the §10.1 table and the suite name the same files', () => {
  it('reads exactly one file name per row of the §10.1 table, each once, with its Arrives wave', () => {
    const rows = listedRows();
    const files = rows.map((r) => r.file);
    expect(files.length).toBeGreaterThanOrEqual(40);
    expect(new Set(files).size, 'no file is listed twice').toBe(files.length);
    // the W0 rows: the recorded goldens' shards and checks (D3), and this file
    for (const f of ['accept.p3c.p3-digests-templates.test.ts', 'accept.p3c.p3-exports.test.ts', 'accept.p3c.lab-status-p3.test.ts', 'accept.p3c.coverage.test.ts']) {
      expect(rows.find((r) => r.file === f), f).toEqual({ file: f, arrives: 'W0', wave: 'W0' });
    }
    expect(rows.find((r) => r.file === 'accept.p3c.hot-path.test.ts')).toEqual({ file: 'accept.p3c.hot-path.test.ts', arrives: 'W0h', item: 'S40' });
    // every pipe line of the section is the header, the separator or a row this reader returned
    const pipes = section101().split('\n').filter((l) => l.startsWith('|'));
    expect(rows.length).toBe(pipes.length - 2);
  });

  it('fails on a row that does not name exactly one tagged acceptance file with a wave, instead of skipping it', () => {
    const header = '| Test | Arrives | Scenario and pass condition |\n|---|---|---|\n';
    const good = '| `accept.p3c.coverage.test.ts` (W0) | W0 | Reads this table. |\n';
    expect(tableRows(`${header}${good}`)).toEqual([{ file: 'accept.p3c.coverage.test.ts', arrives: 'W0', wave: 'W0' }]);
    expect(tableRows(`${header}| \`accept.p3c.mtu-df.test.ts\` [S17a] | W4a | a split id |\n| \`accept.p3c.debug-midline.test.ts\` [R63d] | W4a | R63 (d) |\n`)).toEqual([
      { file: 'accept.p3c.mtu-df.test.ts', arrives: 'W4a', item: 'S17a' },
      { file: 'accept.p3c.debug-midline.test.ts', arrives: 'W4a', item: 'R63d' },
    ]);
    // no tag, two tags, no back-ticks, two files, a brace expansion
    expect(() => tableRows(`${header}| \`accept.p3c.untagged.test.ts\` | W4a | no tag |\n`)).toThrow(/not exactly one tagged file name/);
    expect(() => tableRows(`${header}| \`accept.p3c.x.test.ts\` (W4b) [S4] | W4b | two tags |\n`)).toThrow(/not exactly one tagged file name/);
    expect(() => tableRows(`${header}| accept.p3c.x.test.ts (W0) | W0 | no back-ticks |\n`)).toThrow(/not exactly one tagged file name/);
    expect(() => tableRows(`${header}| \`accept.p3c.a.test.ts\`, \`accept.p3c.b.test.ts\` (W0) | W0 | two files |\n`)).toThrow(/not exactly one tagged file name/);
    expect(() => tableRows(`${header}| \`accept.p3c.{a,b}.test.ts\` (W0) | W0 | a pattern |\n`)).toThrow(/names one accept\.p3c test file/);
    // another stage's name, a tag of another shape, a missing or unknown Arrives wave, a wave tag that is not Arrives
    expect(() => tableRows(`${header}| \`accept.p3.coverage.test.ts\` (W0) | W0 | P3a's name |\n`)).toThrow(/names one accept\.p3c test file/);
    expect(() => tableRows(`${header}| \`accept.p3c.x.test.ts\` [M3] | W4a | a MUST row id |\n`)).toThrow(/not exactly one tagged file name/);
    expect(() => tableRows(`${header}| \`accept.p3c.x.test.ts\` [S4] | soon | no wave |\n`)).toThrow(/not exactly one tagged file name/);
    expect(() => tableRows(`${header}| \`accept.p3c.x.test.ts\` [S4] | W9 | an unknown wave |\n`)).toThrow(/Arrives wave/);
    expect(() => tableRows(`${header}| \`accept.p3c.x.test.ts\` (W2a) | W2a | a wave tag §10.1 does not use |\n`)).toThrow(/wave tag/);
    expect(() => tableRows(`${header}| \`accept.p3c.x.test.ts\` (W0) | W4b | a wave tag that is not its Arrives wave |\n`)).toThrow(/is its Arrives wave/);
  });

  it('carries the approved ids of §8.5c, and every item tag of the table is one of them (the web-only items have no row)', () => {
    const tags = listedRows().flatMap((r) => (r.item === undefined ? [] : [r.item]));
    for (const t of tags) expect(P3C_APPROVED_ITEMS as readonly string[], t).toContain(t);
    // §10.1: the web-only items have §10.2 rows and no §10.1 row
    for (const t of ['S7', 'S22', 'S26', 'S27', 'S28', 'C26']) expect(tags, t).not.toContain(t);
  });

  it('decides pending, required and unapproved rows by the Arrives wave and the approved list (probes)', () => {
    const rows: Row[] = [
      { file: 'accept.p3c.here.test.ts', arrives: 'W0', wave: 'W0' },
      { file: 'accept.p3c.gone.test.ts', arrives: 'W0', wave: 'W0' },
      { file: 'accept.p3c.later-absent.test.ts', arrives: 'W4a', item: 'S4' },
      { file: 'accept.p3c.later-present.test.ts', arrives: 'W0h', item: 'S40' },
      { file: 'accept.p3c.unapproved.test.ts', arrives: 'W4a', item: 'S17b' },
      { file: 'accept.p3c.flip.test.ts', arrives: 'W4b', wave: 'W4b' },
    ];
    const present = new Set(['accept.p3c.here.test.ts', 'accept.p3c.later-present.test.ts', 'accept.p3c.unapproved.test.ts', 'accept.p3c.stray.test.ts']);
    const approved = ['S4', 'S40'];
    // at W0 the later rows are pending: absent is fine, present is fine (and named)
    expect(missingOf(rows, present, 'W0', approved)).toEqual(['accept.p3c.gone.test.ts']);
    // from a row's wave on its file must exist; at W7 every approved row
    expect(missingOf(rows, present, 'W4a', approved)).toEqual(['accept.p3c.gone.test.ts', 'accept.p3c.later-absent.test.ts']);
    expect(missingOf(rows, present, 'W7', approved)).toEqual(['accept.p3c.gone.test.ts', 'accept.p3c.later-absent.test.ts', 'accept.p3c.flip.test.ts']);
    // a row of an item that is not approved must not exist as a file, whatever the wave
    expect(unapprovedPresentOf(rows, present, approved)).toEqual(['accept.p3c.unapproved.test.ts']);
    expect(unlistedOf(rows, ['accept.p3c.here.test.ts', 'accept.p3c.stray.test.ts', 'sub/accept.p3c.here.test.ts'])).toEqual({
      misnamed: ['sub/accept.p3c.here.test.ts'],
      unlisted: ['accept.p3c.stray.test.ts'],
    });
    expect(pending(rows[2]!, 'W0')).toBe(true);
    expect(pending(rows[2]!, 'W4a')).toBe(false);
  });

  it('has a file in packages/engine/test/ for every required row that is not pending', () => {
    expect(missingOf(listedRows(), new Set(readdirSync(HERE))), 'files the §10.1 table requires by now that do not exist').toEqual([]);
  });

  it('has no file for a row of an item that is not approved', () => {
    expect(unapprovedPresentOf(listedRows(), new Set(readdirSync(HERE))), 'files of items that are not approved').toEqual([]);
  });

  it('lists every accept.p3c.*.test.ts file of the engine suite in the table', () => {
    const onDisk = acceptFilesUnder(HERE);
    expect(onDisk).toContain('accept.p3c.coverage.test.ts');
    const { misnamed, unlisted } = unlistedOf(listedRows(), onDisk);
    expect(misnamed, 'accept.p3c files misplaced or misnamed').toEqual([]);
    expect(unlisted, 'accept.p3c files the §10.1 table does not list').toEqual([]);
  });

  it('at W7 leaves no approved row pending', () => {
    const rows = listedRows();
    expect(rows.filter((r) => inScope(r) && pending(r, 'W7')), 'every Arrives wave is at or before W7').toEqual([]);
    if (P3C_CURRENT_WAVE === 'W7') expect(missingOf(rows, new Set(readdirSync(HERE)))).toEqual([]);
  });
});
