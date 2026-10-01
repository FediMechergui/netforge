/**
 * [S32] The NF-Py tokenizer and parser (ARCHITECTURE-P3 D21, §7 W1 auto): the language subset, the syntax tree the
 * compiler consumes, positions, and every error with its class, line and column.
 */
import { describe, expect, it } from 'vitest';
import { lexPy, PY_KEYWORDS, type PyToken } from '../src/automation/py/lexer.js';
import { parsePy, parsePyExpression, PY_MAX_NESTING, type PyExpr, type PyModule, type PyStmt } from '../src/automation/py/parser.js';

function mod(src: string): PyModule {
  const r = parsePy(src);
  if (!r.ok) throw new Error(`${r.error.type} ${r.error.line}:${r.error.column} ${r.error.message}`);
  return r.module;
}

function expr(src: string): PyExpr {
  const r = parsePyExpression(src);
  if (!r.ok) throw new Error(`${r.error.type} ${r.error.line}:${r.error.column} ${r.error.message}`);
  return r.expr;
}

/** A tree without positions, for comparing shapes. */
function bare(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(bare);
  if (v !== null && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) if (k !== 'span') out[k] = bare(x);
    return out;
  }
  return v;
}

const kinds = (tokens: readonly PyToken[]): string[] => tokens.map((t) => (t.kind === 'op' || t.kind === 'keyword' || t.kind === 'name' ? t.text : t.kind));

/** Lab 40's inventory script, as a learner would write it. */
const INVENTORY = `# Inventory the access switches through their API
import requests
import json

SWITCHES = ["10.0.99.11", "10.0.99.12", "10.0.99.13"]
AUTH = ("admin", "NetForge1")
HEADERS = {"Accept": "application/yang-data+json"}


def interfaces_of(address, timeout=5):
    url = f"https://{address}/restconf/data/ietf-interfaces:interfaces"
    reply = requests.get(url, auth=AUTH, headers=HEADERS, verify=False, timeout=timeout)
    if reply.status_code != 200:
        raise RuntimeError(f"{address} answered {reply.status_code}")
    data = reply.json()
    return data["ietf-interfaces:interfaces"]["interface"]


up = 0
for sw in SWITCHES:
    try:
        rows = interfaces_of(sw)
    except RuntimeError as err:
        print("skipped:", err)
        continue
    names = [row["name"] for row in rows if row.get("enabled", True)]
    up += len(names)
    print(f"{sw:<15} {len(names):>3} up  {', '.join(sorted(names))!s}")
print("total up:", up)
`;

describe('NF-Py tokens', () => {
  it('reads names, keywords, numbers, strings, operators, comments and the line structure', () => {
    const r = lexPy('if x >= 0x1F:  # check\n    y = 1_000 + .5e1\n');
    expect(r.errors).toEqual([]);
    expect(kinds(r.tokens)).toEqual(['if', 'x', '>=', 'number', ':', 'comment', 'newline', 'indent', 'y', '=', 'number', '+', 'number', 'newline', 'dedent', 'eof']);
    expect(r.tokens[3]).toMatchObject({ value: 31, numberType: 'int', start: { line: 1, column: 9 }, end: { line: 1, column: 13 } });
    expect(r.tokens[10]).toMatchObject({ value: 1000, numberType: 'int' });
    expect(r.tokens[12]).toMatchObject({ value: 5, numberType: 'float', start: { line: 2, column: 17 } });
    expect(PY_KEYWORDS).toContain('lambda');
    expect(PY_KEYWORDS).not.toContain('print');
  });

  it('decodes string escapes and prefixes as Python does', () => {
    const values = (src: string): unknown[] => lexPy(src).tokens.filter((t) => t.kind === 'string').map((t) => t.value);
    expect(values(String.raw`'a\tb' "q\"" '\x41\u00e9\101' '\d' r'\d\n' u'x'`)).toEqual(['a\tb', 'q"', 'A\u00e9A', '\\d', '\\d\\n', 'x']);
    expect(values('"""one\ntwo"""\n\'\'\'x\'\'\'')).toEqual(['one\ntwo', 'x']);
    expect(values("'a\\\nb'")).toEqual(['ab']);
  });

  it('ignores line breaks inside brackets and after a backslash, and blank or comment-only lines', () => {
    const r = lexPy('x = [1,\n     2]\ny = 1 + \\\n    2\n\n# note\n   \nz = 3\n');
    expect(r.errors).toEqual([]);
    expect(kinds(r.tokens).filter((k) => k === 'newline' || k === 'indent' || k === 'dedent')).toEqual(['newline', 'newline', 'newline']);
  });

  it('locates the fields of an f-string in the source', () => {
    const src = 'f"{a!r:>8} and {{literal}} {b[\'k\']}"';
    const t = lexPy(src).tokens[0] as PyToken;
    expect(t.kind).toBe('fstring');
    expect(t.parts).toEqual([
      { kind: 'field', from: 3, to: 4, conversion: 'r', spec: '>8' },
      { kind: 'text', value: ' and {literal} ' },
      { kind: 'field', from: 28, to: 34 },
    ]);
    expect(src.slice(28, 34)).toBe("b['k']");
  });

  it('never throws: bad text becomes error tokens and lexing goes on (for the highlighter)', () => {
    const r = lexPy('x = $ + 1\ns = "open\nt = 2\n');
    expect(r.errors.map((e) => [e.line, e.column])).toEqual([[1, 5], [2, 5]]);
    expect(r.tokens.filter((t) => t.kind === 'error').map((t) => t.text)).toEqual(['$', '"open']);
    expect(kinds(r.tokens).slice(-5)).toEqual(['t', '=', 'number', 'newline', 'eof']);
  });
});

describe('NF-Py syntax tree', () => {
  it('parses lab 40\'s inventory script', () => {
    const m = mod(INVENTORY);
    expect(m.body.map((s) => s.kind)).toEqual(['import', 'import', 'assign', 'assign', 'assign', 'def', 'assign', 'for', 'expr']);
    const def = m.body[5] as Extract<PyStmt, { kind: 'def' }>;
    expect(bare(def.params)).toEqual([{ name: 'address' }, { name: 'timeout', default: { kind: 'const', type: 'int', value: 5 } }]);
    expect(def.body.map((s) => s.kind)).toEqual(['assign', 'assign', 'if', 'assign', 'return']);
    const call = (def.body[1] as Extract<PyStmt, { kind: 'assign' }>).value;
    expect(call.kind === 'call' && call.keywords.map((k) => k.name)).toEqual(['auth', 'headers', 'verify', 'timeout']);
    const loop = m.body[7] as Extract<PyStmt, { kind: 'for' }>;
    expect(loop.body.map((s) => s.kind)).toEqual(['try', 'assign', 'augassign', 'expr']);
    const tryStmt = loop.body[0] as Extract<PyStmt, { kind: 'try' }>;
    expect(tryStmt.handlers[0]).toMatchObject({ name: 'err', type: { kind: 'name', id: 'RuntimeError' } });
    const names = (loop.body[1] as Extract<PyStmt, { kind: 'assign' }>).value;
    expect(names).toMatchObject({ kind: 'comp', type: 'list', generators: [{ target: { kind: 'name', id: 'row' }, ifs: [{ kind: 'call' }] }] });
    expect(loop.span.start).toMatchObject({ line: 20, column: 1 });
    expect(loop.body[3]?.span.start).toMatchObject({ line: 28, column: 5 });
  });

  it('builds the f-string pieces with parsed expressions, conversions and specs', () => {
    const e = expr('f"{sw:<15} {len(names):>3} up" "!" f"{x!r}"');
    expect(bare(e)).toEqual({
      kind: 'fstring',
      parts: [
        { kind: 'field', expr: { kind: 'name', id: 'sw' }, spec: '<15' },
        { kind: 'text', value: ' ' },
        { kind: 'field', expr: { kind: 'call', func: { kind: 'name', id: 'len' }, args: [{ kind: 'name', id: 'names' }], keywords: [] }, spec: '>3' },
        { kind: 'text', value: ' up!' },
        { kind: 'field', expr: { kind: 'name', id: 'x' }, conversion: 'r' },
      ],
    });
    const f = expr('f"a{b}"');
    expect(f.kind === 'fstring' && f.parts[1]?.kind === 'field' && f.parts[1].expr.span.start).toMatchObject({ line: 1, column: 5 });
    expect(bare(expr('"a" \'b\''))).toEqual({ kind: 'const', type: 'str', value: 'ab' });
  });

  it('follows Python\'s precedence and associativity', () => {
    expect(bare(expr('1 + 2 * 3 ** -2 ** 2'))).toEqual({
      kind: 'binary', op: '+', left: { kind: 'const', type: 'int', value: 1 },
      right: {
        kind: 'binary', op: '*', left: { kind: 'const', type: 'int', value: 2 },
        right: {
          kind: 'binary', op: '**', left: { kind: 'const', type: 'int', value: 3 },
          right: { kind: 'unary', op: '-', operand: { kind: 'binary', op: '**', left: { kind: 'const', type: 'int', value: 2 }, right: { kind: 'const', type: 'int', value: 2 } } },
        },
      },
    });
    expect(bare(expr('not a == b or c and d'))).toEqual({
      kind: 'boolop', op: 'or',
      values: [
        { kind: 'unary', op: 'not', operand: { kind: 'compare', left: { kind: 'name', id: 'a' }, ops: ['=='], comparators: [{ kind: 'name', id: 'b' }] } },
        { kind: 'boolop', op: 'and', values: [{ kind: 'name', id: 'c' }, { kind: 'name', id: 'd' }] },
      ],
    });
    expect(bare(expr('1 < x <= 10 is not None not in y'))).toMatchObject({ kind: 'compare', ops: ['<', '<=', 'is not', 'not in'] });
    expect(bare(expr('a - b - c'))).toMatchObject({ kind: 'binary', op: '-', left: { kind: 'binary', op: '-' }, right: { kind: 'name', id: 'c' } });
    expect(bare(expr('x | y ^ z & w << 1 >> 2 // 3 % 4'))).toMatchObject({ kind: 'binary', op: '|', right: { kind: 'binary', op: '^', right: { kind: 'binary', op: '&' } } });
    expect(bare(expr('a if b else c if d else e'))).toMatchObject({ kind: 'ifexp', test: { id: 'b' }, orelse: { kind: 'ifexp', test: { id: 'd' } } });
  });

  it('parses displays, comprehensions, lambdas, calls, attributes, indexes and slices', () => {
    expect(bare(expr('(1,)'))).toEqual({ kind: 'tuple', items: [{ kind: 'const', type: 'int', value: 1 }] });
    expect(bare(expr('()'))).toEqual({ kind: 'tuple', items: [] });
    expect(bare(expr('(1)'))).toEqual({ kind: 'const', type: 'int', value: 1 });
    expect(bare(expr('{}'))).toEqual({ kind: 'dict', entries: [] });
    expect(bare(expr('{1, 2,}'))).toMatchObject({ kind: 'set', items: [{}, {}] });
    expect(bare(expr('{"a": 1, "b": [None, True]}'))).toMatchObject({ kind: 'dict', entries: [{ key: { value: 'a' } }, { value: { kind: 'list', items: [{ type: 'none' }, { type: 'bool', value: true }] } }] });
    expect(bare(expr('{k: v for k, v in d.items() if v}'))).toMatchObject({
      kind: 'comp', type: 'dict', elt: { id: 'k' }, value: { id: 'v' },
      generators: [{ target: { kind: 'tuple', items: [{ id: 'k' }, { id: 'v' }] }, iter: { kind: 'call', func: { kind: 'attribute', attr: 'items' } }, ifs: [{ id: 'v' }] }],
    });
    expect(bare(expr('sum(x * 2 for x in range(3) for y in z)'))).toMatchObject({ kind: 'call', args: [{ kind: 'comp', type: 'generator', generators: [{}, {}] }] });
    expect(bare(expr('{x for x in s}'))).toMatchObject({ kind: 'comp', type: 'set' });
    expect(bare(expr('sorted(rows, key=lambda r: r["name"], reverse=True)'))).toMatchObject({
      kind: 'call', args: [{ id: 'rows' }],
      keywords: [{ name: 'key', value: { kind: 'lambda', params: [{ name: 'r' }], body: { kind: 'subscript' } } }, { name: 'reverse' }],
    });
    expect(bare(expr('a[1:2]'))).toMatchObject({ kind: 'subscript', index: { kind: 'slice', lower: { value: 1 }, upper: { value: 2 } } });
    expect(bare(expr('a[::-1]'))).toEqual({ kind: 'subscript', value: { kind: 'name', id: 'a' }, index: { kind: 'slice', step: { kind: 'unary', op: '-', operand: { kind: 'const', type: 'int', value: 1 } } } });
    expect(bare(expr('a[:]'))).toEqual({ kind: 'subscript', value: { kind: 'name', id: 'a' }, index: { kind: 'slice' } });
    expect(bare(expr('m[1, 2]'))).toMatchObject({ kind: 'subscript', index: { kind: 'tuple', items: [{}, {}] } });
    expect(bare(expr('x.y.z(1)[0].w'))).toMatchObject({ kind: 'attribute', attr: 'w', value: { kind: 'subscript', value: { kind: 'call', func: { kind: 'attribute', attr: 'z' } } } });
    expect(bare(expr('lambda: 0'))).toEqual({ kind: 'lambda', params: [], body: { kind: 'const', type: 'int', value: 0 } });
  });

  it('parses every statement of the subset', () => {
    const m = mod([
      'a = b = 0', 'x, (y, z) = 1, (2, 3)', 'd["k"] = v.w = 1', 'n += 1; n **= 2', 'del d["k"], x',
      'from time import sleep as pause, time', 'import os.path as p', 'global counter',
      'if a:', '    pass', 'elif b:', '    pass', 'else:', '    pass',
      'while True:', '    if a: break', '    continue',
      'def f(): return', 'try:', '    raise ValueError("x")', 'except (KeyError, ValueError) as e:', '    raise',
      'except:', '    pass', 'else:', '    pass', 'finally:', '    pass', 'assert x > 0, "must be positive"', '',
    ].join('\n'));
    expect(m.body.map((s) => s.kind)).toEqual([
      'assign', 'assign', 'assign', 'augassign', 'augassign', 'del', 'importfrom', 'import', 'global', 'if', 'while', 'def', 'try', 'assert',
    ]);
    expect(bare(m.body[0])).toEqual({ kind: 'assign', targets: [{ kind: 'name', id: 'a' }, { kind: 'name', id: 'b' }], value: { kind: 'const', type: 'int', value: 0 } });
    expect(bare(m.body[1])).toMatchObject({ targets: [{ kind: 'tuple', items: [{ id: 'x' }, { kind: 'tuple' }] }], value: { kind: 'tuple' } });
    expect(bare(m.body[4])).toMatchObject({ kind: 'augassign', op: '**', target: { id: 'n' } });
    expect(bare(m.body[6])).toEqual({ kind: 'importfrom', module: 'time', names: [{ name: 'sleep', asname: 'pause' }, { name: 'time' }] });
    expect(bare(m.body[7])).toEqual({ kind: 'import', names: [{ name: 'os.path', asname: 'p' }] });
    expect(bare(m.body[9])).toMatchObject({ kind: 'if', orelse: [{ kind: 'if', test: { id: 'b' }, orelse: [{ kind: 'pass' }] }] });
    const t = m.body[12] as Extract<PyStmt, { kind: 'try' }>;
    expect(t.handlers.map((h) => [h.type?.kind, h.name])).toEqual([['tuple', 'e'], [undefined, undefined]]);
    expect([t.orelse.length, t.finalbody.length]).toEqual([1, 1]);
  });

  it('ends a program without a final line break, and keeps comments out of the tree', () => {
    expect(mod('x = 1  # one').body).toHaveLength(1);
    expect(mod('if x:\n    y = 1\n    # done').body).toHaveLength(1);
    expect(mod('').body).toEqual([]);
    expect(mod('# only a comment\n\n').body).toEqual([]);
  });
});

describe('NF-Py syntax errors', () => {
  const cases: [string, string, number, number, RegExp][] = [
    ['if x\n    pass\n', 'SyntaxError', 1, 5, /Expected ":" at the end of the "if" line/],
    ['if x = 1:\n    pass\n', 'SyntaxError', 1, 6, /Use "==" to compare/],
    ['for i in range(3):\nprint(i)\n', 'IndentationError', 2, 1, /Expected an indented block after the "for" on line 1/],
    ['x = 1\n    y = 2\n', 'IndentationError', 2, 5, /indented/],
    ['if x:\n        a = 1\n    b = 2\n', 'IndentationError', 3, 5, /matches no enclosing block/],
    ['if x:\n\tif y:\n        pass\n', 'TabError', 3, 9, /Tabs and spaces/],
    ['print "hello"\n', 'SyntaxError', 1, 7, /print is a function/],
    ['s = "open\n', 'SyntaxError', 1, 5, /never closed on its line/],
    ['s = """open\n\nmore', 'SyntaxError', 1, 5, /never closed \(the file ends on line 3\)/],
    ['x = (1, 2\ny = 3\n', 'SyntaxError', 1, 5, /"\(" is never closed/],
    ['x = [1, 2)\n', 'SyntaxError', 1, 10, /does not match the "\[" opened on line 1/],
    ['x = 1)\n', 'SyntaxError', 1, 6, /closes nothing/],
    ['1 = x\n', 'SyntaxError', 1, 1, /Cannot assign to a literal/],
    ['f() = 3\n', 'SyntaxError', 1, 1, /function call/],
    ['None = 3\n', 'SyntaxError', 1, 1, /Cannot assign to None/],
    ['a + 1 += 2\n', 'SyntaxError', 1, 1, /Cannot assign to this expression/],
    ['x, y += 1\n', 'SyntaxError', 1, 6, /not on several/],
    ['break\n', 'SyntaxError', 1, 1, /inside a loop/],
    ['def f():\n    for x in y:\n        pass\n    continue\n', 'SyntaxError', 4, 5, /inside a loop/],
    ['return 1\n', 'SyntaxError', 1, 1, /inside a function/],
    ['class A:\n    pass\n', 'SyntaxError', 1, 1, /Classes are not part of NF-Py/],
    ['with open("f") as f:\n    pass\n', 'SyntaxError', 1, 1, /"with" is not part/],
    ['@wrap\ndef f(): pass\n', 'SyntaxError', 1, 1, /Decorators/],
    ['def f(*args): pass\n', 'SyntaxError', 1, 7, /"\*args"/],
    ['def f(a=1, b): pass\n', 'SyntaxError', 1, 12, /needs a default value/],
    ['def f(a, a): pass\n', 'SyntaxError', 1, 10, /appears twice/],
    ['f(a=1, 2)\n', 'SyntaxError', 1, 8, /positional argument cannot follow/],
    ['f(a=1, a=2)\n', 'SyntaxError', 1, 8, /given twice/],
    ['f(*xs)\n', 'SyntaxError', 1, 3, /Unpacking arguments/],
    ['x = y if z\n', 'SyntaxError', 1, 11, /needs "else"/],
    ['if x:\n    pass\nelse if y:\n    pass\n', 'SyntaxError', 3, 6, /elif/],
    ['else:\n    pass\n', 'SyntaxError', 1, 1, /must follow an "if"/],
    ['try:\n    pass\nx = 1\n', 'SyntaxError', 3, 1, /needs an "except" or a "finally"/],
    ['try:\n    pass\nexcept:\n    pass\nexcept ValueError:\n    pass\n', 'SyntaxError', 5, 1, /bare "except:" must be the last/],
    ['while x:\n    pass\nelse:\n    pass\n', 'SyntaxError', 3, 1, /"else" after a loop/],
    ['x = 1j\n', 'SyntaxError', 1, 5, /Complex numbers/],
    ['x = b"raw"\n', 'SyntaxError', 1, 5, /Bytes literals/],
    ['x = 012\n', 'SyntaxError', 1, 5, /cannot start with 0/],
    ['x = 1_\n', 'SyntaxError', 1, 6, /underscore/],
    ['x = 9007199254740992\n', 'SyntaxError', 1, 5, /larger than NF-Py handles exactly/],
    ['x = f"{}"\n', 'SyntaxError', 1, 7, /needs an expression/],
    ['x = f"{a!x}"\n', 'SyntaxError', 1, 9, /comes s, r or a/],
    ['x = f"a}b"\n', 'SyntaxError', 1, 8, /must be doubled/],
    ['x = f"{a:{w}}"\n', 'SyntaxError', 1, 10, /Nested fields/],
    ['x = f"{a +}"\n', 'SyntaxError', 1, 11, /Expected a value here/],
    ['x = f"{x=}"\n', 'SyntaxError', 1, 9, /"=" form/],
    ['x = "\\N{DASH}"\n', 'SyntaxError', 1, 6, /Named escapes/],
    ['x = a ! b\n', 'SyntaxError', 1, 7, /"!" alone/],
    ['x = y :=\n', 'SyntaxError', 1, 7, /Type annotations|":="/],
    ['x = [*a]\n', 'SyntaxError', 1, 6, /Starred/],
    ['x = ...\n', 'SyntaxError', 1, 5, /"\.\.\." is not part/],
    ['from . import x\n', 'SyntaxError', 1, 6, /Relative imports/],
    ['from m import *\n', 'SyntaxError', 1, 15, /import \*/],
    ['x: int = 1\n', 'SyntaxError', 1, 2, /Type annotations/],
    ['yield x\n', 'SyntaxError', 1, 1, /"yield"/],
    ['x = 1 2\n', 'SyntaxError', 1, 7, /operator or a comma missing/],
    ['x = = 1\n', 'SyntaxError', 1, 5, /Expected a value here, found "="/],
    ['def f(x) -> int:\n    pass\n', 'SyntaxError', 1, 10, /Type annotations/],
    ['x = \u00a7\n', 'SyntaxError', 1, 5, /cannot appear in NF-Py code/],
    ['if True:\n    x = 1\n  y = 2\nz = (\n', 'IndentationError', 3, 3, /matches no enclosing block/],
  ];

  it('reports the first error with its class, line and column', () => {
    for (const [src, type, line, column, message] of cases) {
      const r = parsePy(src);
      expect(r.ok, src).toBe(false);
      if (r.ok) continue;
      expect({ src, type: r.error.type, line: r.error.line, column: r.error.column }).toEqual({ src, type, line, column });
      expect(r.error.message, src).toMatch(message);
    }
  });

  it('marks the extent of an error when it covers more than one character', () => {
    const r = parsePy('x = f() = 1\n');
    expect(r.ok === false && r.error).toMatchObject({ line: 1, column: 5, endLine: 1, endColumn: 8 });
  });

  it('refuses nesting deeper than the limit instead of exhausting the stack', () => {
    const deep = `x = ${'('.repeat(PY_MAX_NESTING + 5)}1${')'.repeat(PY_MAX_NESTING + 5)}\n`;
    const r = parsePy(deep);
    expect(r.ok === false && r.error.message).toMatch(/nests more than/);
    expect(parsePy(`x = ${'-'.repeat(PY_MAX_NESTING + 5)}1\n`).ok).toBe(false);
    expect(parsePy(`x = ${'('.repeat(30)}1${')'.repeat(30)}\n`).ok).toBe(true);
  });

  it('parses the same text to the same tree every time (pure)', () => {
    expect(JSON.stringify(parsePy(INVENTORY))).toBe(JSON.stringify(parsePy(INVENTORY)));
    expect(JSON.stringify(lexPy(INVENTORY))).toBe(JSON.stringify(lexPy(INVENTORY)));
  });
});
