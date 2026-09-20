// Pure entry import lint (ARCHITECTURE-P1 D14, §8.2 W2 stack): nothing reachable from src/pure.ts may import
// `sim/`, `device/`, `link/` or `protocols/`, nor the main entry src/index.ts. The walk follows every static
// `import … from`, `export … from`, side-effect `import '…'` and dynamic `import('…')` transitively.
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as pure from '../src/pure.js';

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '../src');
const ENTRY = resolve(SRC, 'pure.ts');
const FORBIDDEN_DIRS = ['sim', 'device', 'link', 'protocols'];

const SPECIFIER_RE = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)['"]([^'"]+)['"]/g;

/** Strip block and line comments so specifiers quoted in JSDoc are not followed. */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"])\/\/.*$/gm, '$1');
}

function resolveSpecifier(from: string, spec: string): string | null {
  if (!spec.startsWith('.')) return null;
  const base = resolve(dirname(from), spec);
  const candidates = [base.replace(/\.js$/, '.ts'), base, `${base}.ts`, resolve(base, 'index.ts')];
  for (const c of candidates) if (existsSync(c) && c.endsWith('.ts')) return c;
  throw new Error(`unresolved import '${spec}' in ${relative(SRC, from)}`);
}

/** Every source file reachable from `entry`, with the edge that first reached it. */
function closure(entry: string): Map<string, string> {
  const seen = new Map<string, string>([[entry, '(entry)']]);
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.shift()!;
    const text = stripComments(readFileSync(file, 'utf8'));
    for (const m of text.matchAll(SPECIFIER_RE)) {
      const target = resolveSpecifier(file, m[1]!);
      if (target === null || seen.has(target)) continue;
      seen.set(target, relative(SRC, file));
      queue.push(target);
    }
  }
  return seen;
}

describe('pure entry import lint', () => {
  const files = closure(ENTRY);
  const rel = Array.from(files.keys()).map((f) => relative(SRC, f).split(sep).join('/'));

  it('reaches only contracts, core, capture/filter and cli/format', () => {
    const offending = rel.filter((f) => FORBIDDEN_DIRS.some((d) => f.startsWith(`${d}/`)));
    expect(offending).toEqual([]);
    expect(rel).not.toContain('index.ts');
    for (const f of rel) {
      expect(
        f === 'pure.ts' || f.startsWith('contracts/') || f.startsWith('core/') || f.startsWith('capture/filter/') || f === 'cli/format.ts',
        `unexpected module in the pure closure: ${f}`,
      ).toBe(true);
    }
  });

  it('actually walks the re-exported modules', () => {
    expect(rel).toEqual(expect.arrayContaining([
      'core/addr6.ts', 'capture/filter/parser.ts', 'capture/filter/eval.ts', 'capture/filter/complete.ts',
      'capture/filter/fields.ts', 'capture/filter/lexer.ts', 'cli/format.ts', 'contracts/addr.ts',
    ]));
  });

  it('the lint itself catches a forbidden import', () => {
    const fake = 'import { x } from \'../sim/simulation.js\';\nexport { y } from "./device/device.js";\nconst z = import(\'../link/link.js\');';
    const specs = Array.from(stripComments(fake).matchAll(SPECIFIER_RE)).map((m) => m[1]);
    expect(specs).toEqual(['../sim/simulation.js', './device/device.js', '../link/link.js']);
  });

  it('exports the address helpers, the display filter and the formatters', () => {
    expect(pure.normalizeIpv6('2001:0db8:0000:0000:0000:ff00:0042:8329')).toBe('2001:db8::ff00:42:8329');
    expect(pure.usableHostRange('192.168.1.130', 26)).toMatchObject({ network: '192.168.1.128', broadcast: '192.168.1.191', count: 62 });
    expect(pure.prefixLenToWildcard(26)).toBe('0.0.0.63');
    const f = pure.compileDisplayFilter('ip.src == 10.0.0.1 and tcp.port == 80');
    expect(f.error).toBeUndefined();
    expect(pure.parseDisplayFilter('ip.src ==').ok).toBe(false);
    expect(pure.lookupDisplayField('ipv6.src')).toBeDefined();
    expect(pure.completeDisplayFilter('ipv').items.length).toBeGreaterThan(0);
    expect(pure.formatSimTime(1_500_000_000)).toBe('00:00:01.500000');
    expect(pure.fmtBps(100_000_000)).toBe('100 Mb/s');
    expect(pure.table([['a', 'bb'], ['ccc', 'd']])).toBe('a    bb\nccc  d');
  });
});

describe('package exports', () => {
  it('declares the "." and "./pure" subpaths', () => {
    const pkg = JSON.parse(readFileSync(resolve(SRC, '../package.json'), 'utf8')) as { exports: Record<string, string> };
    expect(pkg.exports).toEqual({ '.': './src/index.ts', './pure': './src/pure.ts' });
  });
});
