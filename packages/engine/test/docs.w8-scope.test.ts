/**
 * W8 exit gate — the docs agree with the code they describe (ARCHITECTURE-P3 §7 W8 "update docs and docs/CATALOG.md",
 * rulings R61 (a), R62 (a)–(e); the W8 review's scope-docs, contracts-tidy and README findings).
 *
 * Each block reads a doc and the source it must match, so a later edit of either side that breaks the agreement fails
 * here:
 *  • README.md: the stage it states and the briefs it names, the model and module counts, the category table (each
 *    row exactly the display names the catalog files under that palette category) and the course and lab counts;
 *  • docs/CATALOG.md: the fidelity table's "Lesson" cell of R2 (11), (15) and (28) names the CCNA 3 lesson that states
 *    the deviation (R62 (e)), and the P0.5 capabilities' "Daemons" cells equal CAPABILITY_PROCESSES;
 *  • docs/ARCHITECTURE-P3.md: §2.15 lists R62 (a)'s four members, `FacadeCounters.remote` under journal.ts (R62 (c)),
 *    the `tls` flags as declared in process.ts, `ConfigAst.apply`'s `opts.seq` (marked OBM in §2.11 too) and the
 *    members that became required; §2.4 lists every sanctioned `ext.*` request and the required
 *    `ProcessCtx.protect`; §2.3 documents `PduMeta.innerProtectedBy`; §10.2 names the shipped [S13] web tests; R62 (e)
 *    orders no second RSA sentence;
 *  • docs/W8-SCOPE-AUDIT.md: gap 7 does not list R2 (11) as unstated.
 *
 * Read-only: nothing here builds a world.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CAPABILITY_PROCESSES, DEVICE_CATEGORIES, type Capability } from '../src/contracts/catalog.js';
import { lessonsOf } from '../src/contracts/curriculum.js';
import { SANCTIONED_EXT_REQUESTS } from '../src/contracts/process.js';
import { CCNA3_THEORY } from '../src/curriculum/ccna3/theory.js';
import { courseById } from '../src/curriculum/index.js';
import { ALL_MODELS, ALL_MODULES } from '../src/device/catalog/index.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const read = (p: string): string => readFileSync(join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');
const flat = (s: string): string => s.replace(/\s+/g, ' ');

/** The text from `start` to the next `end` after it (to the end of `text` when `toEnd` and `end` is absent). */
function section(text: string, start: string, end: string, toEnd = false): string {
  const s = text.indexOf(start);
  if (s < 0) throw new Error(`marker not found: ${start}`);
  const e = text.indexOf(end, s + start.length);
  if (e < 0 && !toEnd) throw new Error(`end marker not found after ${start}: ${end}`);
  return text.slice(s, e < 0 ? text.length : e);
}

/** Body rows of the markdown tables in `body`, as arrays of trimmed cells (separator rows dropped). */
function rowsOf(body: string): string[][] {
  return body
    .split('\n')
    .filter((l) => l.startsWith('|') && !/^\|\s*-/.test(l))
    .map((l) => l.slice(1, l.lastIndexOf('|')).split('|').map((c) => c.trim()));
}

const README = read('README.md');
const CATALOG = read('docs/CATALOG.md');
const ARCH = read('docs/ARCHITECTURE-P3.md');
const AUDIT = read('docs/W8-SCOPE-AUDIT.md');

const LESSON_19 = CCNA3_THEORY['ccna3-19-locking-down-device-access'] ?? '';
const LESSON_27 = CCNA3_THEORY['ccna3-27-marking-queuing-and-policing'] ?? '';

describe('README.md describes the shipped stage (W8 review, README finding)', () => {
  it('states P3a and names the P2 and P3 briefs as the later binding ones', () => {
    const status = flat(section(README, 'Status:', '\n\n'));
    expect(status).toContain('P3a');
    expect(status).toContain('`docs/ARCHITECTURE-P2.md`');
    expect(status).toContain('`docs/ARCHITECTURE-P3.md`');
    expect(status).toContain('the later one wins');
    expect(status).not.toMatch(/P1 — CCNA 1: complete/);
  });

  it('counts every catalog model and module, in both places', () => {
    expect(README).not.toMatch(/\b54 device models\b/);
    expect(README.match(new RegExp(`\\b${ALL_MODELS.length} device models\\b`, 'g'))?.length).toBe(2);
    expect(README).toContain(`${DEVICE_CATEGORIES.length} palette categories, plus ${ALL_MODULES.length} installable modules`);
  });

  it('lists, per palette category, exactly the models the catalog files there', () => {
    const table = rowsOf(section(README, '| Category | Models |', '\n\n')).slice(1);
    const label = (s: string): string => s.replace(/ \/ /g, ' & ');
    expect(table.map((r) => label(r[0]!))).toEqual(DEVICE_CATEGORIES.map((c) => c.label));
    for (const [cell0, cell1] of table) {
      const cat = DEVICE_CATEGORIES.find((c) => c.label === label(cell0!));
      const listed = [...(cell1 ?? '').matchAll(/NF-[A-Z0-9-]+/g)].map((m) => m[0]).sort();
      const filed = ALL_MODELS.filter((m) => m.category === cat?.id).map((m) => m.model).sort();
      expect(listed, cell0).toEqual(filed);
    }
  });

  it('gives each available course its lesson and lab counts', () => {
    let labs = 0;
    for (const [id, name] of [['ccna1', 'CCNA 1'], ['ccna2', 'CCNA 2'], ['ccna3', 'CCNA 3']] as const) {
      const course = courseById(id);
      expect(course?.status).toBe('available');
      const lessons = course === undefined ? [] : lessonsOf(course);
      const courseLabs = new Set(lessons.map((l) => l.lab).filter((l) => l !== undefined)).size;
      labs += courseLabs;
      expect(flat(README)).toContain(`${name} (${lessons.length} lessons, ${courseLabs} labs)`);
    }
    expect(flat(README)).toContain(`Three courses and ${labs} labs`);
  });
});

describe('docs/CATALOG.md fidelity table names the lesson that states each deviation (R62 (e))', () => {
  const fidelity = rowsOf(section(CATALOG, '### P3a (CCNA 3)', '\n## ', true).replace(/^[\s\S]*?\n\| # \|/, '| # |'));
  const lessonCell = (n: number): string | undefined => fidelity.find((r) => r[0] === String(n))?.[2];

  it('R2 (11), the RSA key kept as a configuration line: lesson 19', () => {
    expect(LESSON_19).toContain('keeps the RSA key as a line of the configuration');
    expect(lessonCell(11)).toBe('19');
  });

  it('R2 (15), the discard sink on UDP 9: lesson 27', () => {
    expect(LESSON_27).toMatch(/UDP port 9/);
    expect(LESSON_27).toMatch(/port-unreachable/);
    expect(lessonCell(15)).toBe('27');
  });

  it('R2 (28), a vty session opened on the device takes the first line vty section: lesson 19', () => {
    expect(LESSON_19).toMatch(/first line vty section/);
    expect(lessonCell(28)).toBe('19');
  });

  it('R2 (27) stays recorded only (a P2 behaviour), and R62 (e) orders no second RSA sentence', () => {
    expect(lessonCell(27)).toBe('—');
    const r62e = section(ARCH, '  - (e) Each listed deviation a learner could notice', '\n\n### 9.3');
    const bullets = r62e.split('\n').filter((l) => /^ {4}- R2 \(\d+\)/.test(l));
    expect(bullets.some((l) => l.includes('R2 (11)'))).toBe(false);
    expect(bullets.some((l) => l.includes('R2 (15)') && l.includes('lesson 27'))).toBe(true);
    expect(bullets.some((l) => l.includes('R2 (28)') && l.includes('lesson 19'))).toBe(true);
  });

  it('the scope audit does not list R2 (11) among the unstated deviations', () => {
    const gap7 = flat(section(AUDIT, '7. **Lessons that do not state a listed deviation.**', '\n8. '));
    const unstated = /No CCNA 3 lesson states (.*?); the others/.exec(gap7);
    expect(unstated).not.toBeNull();
    expect(unstated?.[1]).not.toMatch(/\(11\)/);
  });
});

describe('docs/CATALOG.md capabilities table (P0.5 rows) equals CAPABILITY_PROCESSES', () => {
  it.each(['repeater', 'wifi-ap', 'wifi-client', 'radio-bridge', 'cellular-cell', 'cellular-client', 'modem', 'cloud'] as const)(
    '%s',
    (cap: Capability) => {
      const rows = rowsOf(section(CATALOG, '| Capability | Meaning | Daemons |', '\n\n## ')).slice(1);
      const row = rows.find((r) => r[0] === `\`${cap}\``);
      expect(row, cap).toBeDefined();
      const cell = (row?.[2] ?? '').replace(/\([^)]*\)/g, '').replace(/;\s*all P0\.5\s*$/, '');
      const listed = cell.split(',').map((s) => s.trim()).filter((s) => s !== '' && s !== '—');
      expect(listed).toEqual(CAPABILITY_PROCESSES[cap].map((p) => p.process));
    },
  );
});

describe('docs/ARCHITECTURE-P3.md §2 agrees with the contracts (R61 (a), R62 (a)–(d))', () => {
  const s215 = section(ARCH, '### 2.15 Members that stay optional', '\n### 2.16');
  const t215 = rowsOf(s215.slice(s215.indexOf('| Contract |')).split('\n\n')[0]!).slice(1);
  const rowFor = (prefix: string): string[][] => t215.filter((r) => r[0]!.startsWith(prefix));

  it('§2.15 lists R62 (a)\'s four members as optional by meaning', () => {
    expect(rowFor('scenario.ts').some((r) => r[1]!.includes('`LabCheckResult.misconception`'))).toBe(true);
    expect(rowFor('process.ts').some((r) => r[1]!.includes('`LoggerStateView.syslog`'))).toBe(true);
    expect(rowFor('snapshot.ts').some((r) => r[1]!.includes('`PortTxQueueView`') && r[1]!.includes('dscp'))).toBe(true);
    expect(rowFor('trace.ts').some((r) => r[1]!.includes('`PduSummary.tunnel`') && r[1]!.includes("'gre'") && r[1]!.includes("'ipsec'"))).toBe(true);
  });

  it('§2.15 files FacadeCounters.remote under journal.ts, where it is declared (R62 (c))', () => {
    expect(read('packages/engine/src/contracts/journal.ts')).toMatch(/readonly remote\?: number;/);
    expect(rowFor('journal.ts').some((r) => r[1]!.includes('`FacadeCounters.remote`'))).toBe(true);
    expect(rowFor('cli.ts').some((r) => r[1]!.includes('FacadeCounters.remote'))).toBe(false);
  });

  it('§2.15 says the tls flags are declared on the ProcessRequest arms of process.ts', () => {
    expect(read('packages/engine/src/contracts/process.ts')).toMatch(/tls\?: true; service\?: true \}/);
    const row = t215.find((r) => r[1]!.includes('`tcp.listen.tls`'));
    expect(row).toBeDefined();
    expect(row?.join(' ')).toMatch(/process\.ts/);
    expect(row?.join(' ')).toMatch(/ProcessRequest/);
  });

  it('§2.15 and §2.11 carry ConfigAst.apply\'s `opts.seq` as optional by meaning, as the contract tags it', () => {
    expect(read('packages/engine/src/contracts/config.ts')).toMatch(/@since P3 \(optional by meaning\)[^\n]*`opts\.seq`/);
    expect(rowFor('cli.ts / config.ts').some((r) => r[1]!.includes('`opts.seq` of `ConfigAst.apply`'))).toBe(true);
    const s211 = flat(section(ARCH, '### 2.11 `contracts/cli.ts` and `contracts/config.ts`', '\n### 2.12'));
    expect(s211).toMatch(/`ConfigAst\.apply\(…, opts\)` opts `\+= seq\?: number` \(OBM/);
  });

  it('§2.15 "become required" names protect, qosCounters, egressQueues and onLogEvent', () => {
    const req = flat(section(s215, 'Members that DO become required', '\n\n', true));
    for (const m of ['`ProcessCtx.protect`', '`CommandCtx.qosCounters`', '`CommandCtx.egressQueues`', '`CliRuntime.onLogEvent`']) {
      expect(req).toContain(m);
    }
  });

  it('§2.4 lists every sanctioned ext.* request and the required ProcessCtx.protect', () => {
    const s24 = section(ARCH, '### 2.4 `contracts/process.ts`', '\n### 2.5');
    expect(SANCTIONED_EXT_REQUESTS.length).toBe(3);
    expect(s24).toContain('SANCTIONED_EXT_REQUESTS');
    for (const kind of SANCTIONED_EXT_REQUESTS) expect(s24).toContain(`'${kind}'`);
    expect(s24).toMatch(/protect\(pdu: Pdu, by: NonNullable<PduMeta\['protectedBy'\]> \| null\): void/);
    expect(read('packages/engine/src/contracts/process.ts')).toMatch(/\n {2}protect\(pdu: Pdu, by: NonNullable<PduMeta\['protectedBy'\]> \| null\): void;/);
  });

  it('§2.3 documents PduMeta.innerProtectedBy with the contract\'s values', () => {
    const s23 = section(ARCH, '### 2.3 `contracts/pdu.ts`', '\n### 2.4');
    expect(s23).toContain("innerProtectedBy?: 'dtls' | 'tls' | 'ssh' | 'esp' | 'ike'");
    expect(read('packages/engine/src/contracts/pdu.ts')).toContain("readonly innerProtectedBy?: 'dtls' | 'tls' | 'ssh' | 'esp' | 'ike';");
  });

  it('§10.2 names the shipped [S13] web tests, which exist (R62 (d))', () => {
    const s102 = flat(section(ARCH, '### 10.2 Web acceptance', '\n### 10.3'));
    expect(s102).not.toContain('`terminal.remote.test.ts`');
    for (const f of ['terminal.remote-session.test.ts', 'line-editor.secret.test.ts']) {
      expect(s102).toContain(`\`${f}\``);
      expect(existsSync(join(ROOT, 'apps', 'web', 'test', f))).toBe(true);
    }
  });
});
