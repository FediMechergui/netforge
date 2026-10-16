/**
 * The bundle split's import lint (ARCHITECTURE-P3C §7 W0h web-shell, D11, §10.2).
 *
 * The bare `@netforge/engine` entry evaluates the whole engine (every daemon, codec, grammar fragment, lab and course),
 * so a value imported from it on the main thread put all of it in the main chunk (4.09 MB before W0h). The main thread
 * reads values only from the narrow entries `@netforge/engine/pure`, `/contracts`, `/curriculum` and `/web`
 * (packages/engine/package.json `exports`); a type-only import of the bare entry is fine, since it is erased. The engine
 * worker (`src/bridge/worker/**`) is the one place that imports the full engine.
 *
 * Second rule, the lazy course layer: the course catalogue (every lesson's text) is a chunk of its own. Only the course
 * layer (`COURSE_LAYER`, mounted lazily by app/App.tsx after `loadCurriculum`) imports `@netforge/engine/curriculum`
 * statically, and no other main-thread file imports a course-layer file for a value; everything else reaches the
 * catalogue through src/curriculum-loader.ts.
 *
 * The walk parses every `.ts` / `.tsx` file under src with the TypeScript parser: `import` and `export … from`
 * declarations, side-effect imports and dynamic `import()` calls (a `typeof import('…')` type is not a call).
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const WEB = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(WEB, 'src');
const WORKER_DIR = 'src/bridge/worker/';
const BARE = '@netforge/engine';
const CURRICULUM = '@netforge/engine/curriculum';
/** The entries the main thread may take values from (packages/engine/package.json `exports`, minus the bare one). */
const NARROW_ENTRIES = ['@netforge/engine/pure', '@netforge/engine/contracts', CURRICULUM, '@netforge/engine/web'];
/** The lazily mounted course layer: the only main-thread files that import the catalogue statically. */
const COURSE_LAYER = ['src/learn/LearnShell.tsx', 'src/learn/Landing.tsx', 'src/learn/CourseView.tsx', 'src/learn/LessonView.tsx'];

interface ImportSite {
  readonly spec: string;
  /** True when nothing of the import survives compilation (`import type`, or every named binding is `type`). */
  readonly typeOnly: boolean;
  readonly dynamic: boolean;
  readonly line: number;
}

/** Every import site of one source text. */
function importSites(fileName: string, text: string): ImportSite[] {
  const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const out: ImportSite[] = [];
  const line = (n: ts.Node): number => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const ic = node.importClause;
      let typeOnly = false;
      if (ic !== undefined) {
        const nb = ic.namedBindings;
        typeOnly = ic.isTypeOnly || (ic.name === undefined && nb !== undefined && ts.isNamedImports(nb) && nb.elements.length > 0 && nb.elements.every((e) => e.isTypeOnly));
      }
      out.push({ spec: node.moduleSpecifier.text, typeOnly, dynamic: false, line: line(node) });
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier !== undefined && ts.isStringLiteral(node.moduleSpecifier)) {
      const ec = node.exportClause;
      const typeOnly = node.isTypeOnly || (ec !== undefined && ts.isNamedExports(ec) && ec.elements.length > 0 && ec.elements.every((e) => e.isTypeOnly));
      out.push({ spec: node.moduleSpecifier.text, typeOnly, dynamic: false, line: line(node) });
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const arg = node.arguments[0];
      out.push({ spec: arg !== undefined && ts.isStringLiteralLike(arg) ? arg.text : '(computed)', typeOnly: false, dynamic: true, line: line(node) });
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

function walk(dir: string): string[] {
  const files: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) files.push(...walk(p));
    else if (/\.tsx?$/.test(e.name) && !e.name.endsWith('.d.ts')) files.push(p);
  }
  return files;
}

const rel = (abs: string): string => relative(WEB, abs).split(sep).join('/');

/** Resolve a relative specifier of `from` to a web source file (rel path), or null. */
function resolveLocal(from: string, spec: string, known: ReadonlySet<string>): string | null {
  if (!spec.startsWith('.')) return null;
  const base = rel(resolve(dirname(join(WEB, from)), spec));
  for (const c of [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`]) if (known.has(c)) return c;
  return null;
}

const FILES = walk(SRC).map((abs) => ({ path: rel(abs), sites: importSites(abs, readFileSync(abs, 'utf8')) }));
const MAIN = FILES.filter((f) => !f.path.startsWith(WORKER_DIR));

describe('bundle split: main-thread engine imports (W0h)', () => {
  it('walks the main-thread sources and leaves the worker out', () => {
    expect(MAIN.length).toBeGreaterThan(150);
    expect(MAIN.some((f) => f.path === 'src/main.tsx')).toBe(true);
    expect(FILES.some((f) => f.path === 'src/bridge/worker/index.ts')).toBe(true);
    expect(MAIN.some((f) => f.path.startsWith(WORKER_DIR))).toBe(false);
  });

  it('no main-thread file takes a value from the bare engine entry', () => {
    const offending = MAIN.flatMap((f) => f.sites.filter((s) => s.spec === BARE && !s.typeOnly).map((s) => `${f.path}:${s.line}${s.dynamic ? ' (import())' : ''}`));
    expect(offending).toEqual([]);
  });

  it('only the known engine entries are used, and no file reaches into the engine sources', () => {
    const allowed = new Set([BARE, ...NARROW_ENTRIES]);
    const offending = MAIN.flatMap((f) =>
      f.sites
        .filter((s) => (s.spec.startsWith('@netforge/') && !allowed.has(s.spec)) || /packages[\\/]engine/.test(s.spec))
        .map((s) => `${f.path}:${s.line} ${s.spec}`),
    );
    expect(offending).toEqual([]);
  });

  it('the narrow entries are really used (the lint is not vacuous)', () => {
    for (const entry of NARROW_ENTRIES) expect(MAIN.some((f) => f.sites.some((s) => s.spec === entry && !s.typeOnly)), entry).toBe(true);
    // the worker is the one place that imports the full engine for values
    expect(FILES.some((f) => f.path.startsWith(WORKER_DIR) && f.sites.some((s) => s.spec === BARE && !s.typeOnly))).toBe(true);
  });

  it('the course catalogue is imported statically only by the lazy course layer', () => {
    const offending = MAIN.filter((f) => !COURSE_LAYER.includes(f.path)).flatMap((f) =>
      f.sites.filter((s) => s.spec === CURRICULUM && !s.typeOnly && !s.dynamic).map((s) => `${f.path}:${s.line}`),
    );
    expect(offending).toEqual([]);
    const loader = MAIN.find((f) => f.path === 'src/curriculum-loader.ts');
    expect(loader?.sites.some((s) => s.spec === CURRICULUM && s.dynamic)).toBe(true);
  });

  it('no main-thread file outside the course layer imports a course-layer file for a value', () => {
    const known = new Set(FILES.map((f) => f.path));
    const offending = MAIN.filter((f) => !COURSE_LAYER.includes(f.path)).flatMap((f) =>
      f.sites
        .filter((s) => !s.typeOnly && !s.dynamic)
        .map((s) => ({ s, target: resolveLocal(f.path, s.spec, known) }))
        .filter(({ target }) => target !== null && COURSE_LAYER.includes(target))
        .map(({ s, target }) => `${f.path}:${s.line} -> ${target}`),
    );
    expect(offending).toEqual([]);
    for (const f of COURSE_LAYER) expect(known.has(f), f).toBe(true);
  });

  it('the lint itself tells a value import from a type-only one', () => {
    const fake = [
      "import type { A } from '@netforge/engine';",
      "import { type B, type C } from '@netforge/engine';",
      "import { D, type E } from '@netforge/engine';",
      "import '@netforge/engine';",
      "export { F } from '@netforge/engine';",
      "export type { G } from '@netforge/engine';",
      "type M = typeof import('@netforge/engine');",
      "const m = import('@netforge/engine');",
    ].join('\n');
    const sites = importSites('fake.ts', fake).map((s) => [s.spec, s.typeOnly, s.dynamic, s.line]);
    expect(sites).toEqual([
      [BARE, true, false, 1],
      [BARE, true, false, 2],
      [BARE, false, false, 3],
      [BARE, false, false, 4],
      [BARE, false, false, 5],
      [BARE, true, false, 6],
      [BARE, false, true, 8],
    ]);
  });
});
