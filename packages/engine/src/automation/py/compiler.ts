/**
 * The NF-Py bytecode compiler (ARCHITECTURE-P3 D21 "[S32] NF-Py", §4.1, §7 W2 auto [S32]).
 *
 * Turns the syntax tree of `parser.ts` into code objects for the resumable stack machine of `vm.ts`. Pure: no clock, no
 * random source, no state outside a call. Everything that parses compiles (the parser's node types are the language).
 *
 * SCOPES (Python 3 rules): the module body binds globals; each `def`, `lambda` and comprehension is a function scope
 * whose locals are the names it binds (parameters, assignment, `for` and comprehension targets, `import` aliases, `def`
 * names, `except … as` names, `del` targets) unless it declares them `global`. A name a scope reads without binding
 * resolves to the nearest enclosing FUNCTION scope that binds it (a free variable, shared through a cell, so closures
 * see later assignments), else to the module globals and then the builtins. The module scope never lends its names as
 * cells: inner functions read module names as globals. A comprehension evaluates its first iterable in the enclosing
 * scope and receives it as the hidden parameter `.0`; a generator expression is computed as a list and handed out as an
 * iterator (deterministic, and the language has no `yield`).
 *
 * CODE OBJECTS hold parallel arrays (`ops`, `args`, `lines`), the constants, the global/attribute names, the fast
 * locals (`varnames`, parameters first), the cell variables and the free variables. Jumps are absolute instruction
 * indexes. `try` blocks compile to SETUP_EXCEPT / SETUP_FINALLY with a handler address; a `finally` body is compiled on
 * the normal path, on the exception path (followed by RERAISE) and inline before every `break`, `continue` or
 * `return` that leaves it, as CPython does.
 */
import type { SourceSpan } from '../data/json.js';
import type { PySyntaxError } from './lexer.js';
import {
  parsePy,
  type PyBinaryOp,
  type PyComp,
  type PyCompareOp,
  type PyExpr,
  type PyModule,
  type PyParam,
  type PySlice,
  type PyStmt,
  type PyTarget,
  type PyTry,
  type PyUnaryOp,
} from './parser.js';

// ── instruction set ─────────────────────────────────────────────────────────

/** The opcodes of the NF-Py virtual machine (values are the numbers stored in `PyCode.ops`). */
export const PY_OP = Object.freeze({
  NOP: 0,
  POP_TOP: 1,
  DUP_TOP: 2,
  DUP_TOP_TWO: 3,
  ROT_TWO: 4,
  ROT_THREE: 5,
  LOAD_CONST: 10,
  LOAD_FAST: 11,
  STORE_FAST: 12,
  DELETE_FAST: 13,
  LOAD_DEREF: 14,
  STORE_DEREF: 15,
  DELETE_DEREF: 16,
  LOAD_CLOSURE: 17,
  LOAD_GLOBAL: 18,
  STORE_GLOBAL: 19,
  DELETE_GLOBAL: 20,
  LOAD_ATTR: 21,
  STORE_ATTR: 22,
  DELETE_ATTR: 23,
  LOAD_SUBSCR: 24,
  STORE_SUBSCR: 25,
  DELETE_SUBSCR: 26,
  BUILD_SLICE: 27,
  BINARY: 30,
  INPLACE: 31,
  UNARY: 32,
  COMPARE: 33,
  JUMP: 40,
  POP_JUMP_IF_FALSE: 41,
  POP_JUMP_IF_TRUE: 42,
  JUMP_IF_FALSE_OR_POP: 43,
  JUMP_IF_TRUE_OR_POP: 44,
  GET_ITER: 45,
  FOR_ITER: 46,
  BUILD_LIST: 50,
  BUILD_TUPLE: 51,
  BUILD_SET: 52,
  BUILD_MAP: 53,
  LIST_APPEND: 54,
  SET_ADD: 55,
  MAP_ADD: 56,
  BUILD_STRING: 57,
  FORMAT_VALUE: 58,
  UNPACK_SEQUENCE: 59,
  MAKE_FUNCTION: 60,
  CALL: 61,
  CALL_KW: 62,
  RETURN_VALUE: 63,
  IMPORT_NAME: 70,
  IMPORT_FROM: 71,
  SETUP_EXCEPT: 80,
  SETUP_FINALLY: 81,
  POP_BLOCK: 82,
  EXC_MATCH: 83,
  BEGIN_HANDLER: 84,
  END_HANDLER: 85,
  LOAD_EXC: 86,
  RAISE: 87,
  RERAISE: 88,
  LOAD_ASSERTION_ERROR: 89,
});

/** Binary operators by the index the BINARY and INPLACE instructions carry. */
export const PY_BINARY_OPS: readonly PyBinaryOp[] = Object.freeze(['+', '-', '*', '/', '//', '%', '**', '<<', '>>', '&', '|', '^']);
/** Unary operators by the index UNARY carries. */
export const PY_UNARY_OPS: readonly PyUnaryOp[] = Object.freeze(['-', '+', '~', 'not']);
/** Comparison operators by the index COMPARE carries. */
export const PY_COMPARE_OPS: readonly PyCompareOp[] = Object.freeze(['==', '!=', '<', '<=', '>', '>=', 'in', 'not in', 'is', 'is not']);

/** FORMAT_VALUE flags: the low two bits are the conversion (0 none, 1 !s, 2 !r, 3 !a); bit 2 = a spec is on the stack. */
export const PY_FORMAT_HAS_SPEC = 4;
/** MAKE_FUNCTION flags. */
export const PY_FN_DEFAULTS = 1;
export const PY_FN_CLOSURE = 2;

/** A constant of a code object: numbers (ints), `{float}` (a float literal), strings, booleans, None, code, keyword names. */
export type PyConstant = null | boolean | number | string | { readonly float: number } | { readonly kwnames: readonly string[] } | PyCode;

/** One compiled function, lambda, comprehension or module body. */
export interface PyCode {
  readonly kind: 'code';
  /** `<module>`, the function name, `<lambda>`, `<listcomp>`, `<setcomp>`, `<dictcomp>`, `<genexpr>`. */
  readonly name: string;
  readonly filename: string;
  /** Positional parameters, in order (they are the first `varnames`). */
  readonly params: readonly string[];
  /** How many trailing parameters have defaults. */
  readonly ndefaults: number;
  /** Fast locals: parameters first. */
  readonly varnames: readonly string[];
  /** Locals shared with inner scopes (stored only in cells). */
  readonly cellvars: readonly string[];
  /** For each cell variable that is also a parameter: its parameter index, else -1. */
  readonly cellParams: readonly number[];
  /** Variables of enclosing scopes this code reads through cells (after the cell variables in the cell array). */
  readonly freevars: readonly string[];
  /** Global, attribute and module names. */
  readonly names: readonly string[];
  readonly consts: readonly PyConstant[];
  readonly ops: readonly number[];
  readonly args: readonly number[];
  /** 1-based source line of each instruction. */
  readonly lines: readonly number[];
  /** First line of the definition. */
  readonly firstLine: number;
}

/** A whole program: the module code and its source (for tracebacks). */
export interface PyProgram {
  readonly code: PyCode;
  readonly filename: string;
  readonly source: string;
}

export type PyCompileResult = { readonly ok: true; readonly program: PyProgram } | { readonly ok: false; readonly error: PySyntaxError };

// ── scopes ──────────────────────────────────────────────────────────────────

interface Scope {
  readonly kind: 'module' | 'function';
  readonly parent?: Scope;
  readonly params: readonly string[];
  readonly bound: Set<string>;
  readonly globals: Set<string>;
  readonly used: Set<string>;
  readonly cells: Set<string>;
  readonly free: Set<string>;
}

type ScopeOwner = PyModule | Extract<PyStmt, { kind: 'def' }> | Extract<PyExpr, { kind: 'lambda' }> | PyComp;

// The parser refuses these first (with the same original wording); the compiler keeps the guards so a tree built by
// other means can never compile into a jump to nowhere or a return from the module frame.
export const MSG_BREAK_OUTSIDE = '"break" can only be used inside a loop.';
export const MSG_CONTINUE_OUTSIDE = '"continue" can only be used inside a loop.';
export const MSG_RETURN_OUTSIDE = '"return" can only be used inside a function.';

class CompileFail extends Error {
  constructor(readonly span: SourceSpan, message: string) {
    super(message);
  }
}

/** Collects every scope of a program with its bindings and uses. */
class ScopeCollector {
  readonly scopes = new Map<ScopeOwner, Scope>();

  private make(owner: ScopeOwner, kind: Scope['kind'], parent: Scope | undefined, params: readonly string[]): Scope {
    const s: Scope = { kind, ...(parent !== undefined ? { parent } : {}), params, bound: new Set(params), globals: new Set(), used: new Set(), cells: new Set(), free: new Set() };
    this.scopes.set(owner, s);
    return s;
  }

  module(m: PyModule): void {
    const s = this.make(m, 'module', undefined, []);
    this.stmts(m.body, s);
  }

  private bindTarget(t: PyTarget, s: Scope): void {
    switch (t.kind) {
      case 'name':
        s.bound.add(t.id);
        return;
      case 'tuple':
      case 'list':
        for (const i of t.items) this.bindTarget(i as PyTarget, s);
        return;
      case 'attribute':
        this.expr(t.value, s);
        return;
      case 'subscript':
        this.expr(t.value, s);
        this.index(t.index, s);
        return;
    }
  }

  private index(i: PyExpr | PySlice, s: Scope): void {
    if (i.kind === 'slice') {
      if (i.lower !== undefined) this.expr(i.lower, s);
      if (i.upper !== undefined) this.expr(i.upper, s);
      if (i.step !== undefined) this.expr(i.step, s);
    } else this.expr(i, s);
  }

  private stmts(body: readonly PyStmt[], s: Scope): void {
    for (const st of body) this.stmt(st, s);
  }

  private stmt(st: PyStmt, s: Scope): void {
    switch (st.kind) {
      case 'expr':
        this.expr(st.value, s);
        return;
      case 'assign':
        this.expr(st.value, s);
        for (const t of st.targets) this.bindTarget(t, s);
        return;
      case 'augassign':
        this.expr(st.value, s);
        if (st.target.kind === 'name') {
          s.used.add(st.target.id);
          s.bound.add(st.target.id);
        } else this.bindTarget(st.target, s);
        return;
      case 'if':
        this.expr(st.test, s);
        this.stmts(st.body, s);
        this.stmts(st.orelse, s);
        return;
      case 'while':
        this.expr(st.test, s);
        this.stmts(st.body, s);
        return;
      case 'for':
        this.expr(st.iter, s);
        this.bindTarget(st.target, s);
        this.stmts(st.body, s);
        return;
      case 'break':
      case 'continue':
      case 'pass':
        return;
      case 'def': {
        for (const p of st.params) if (p.default !== undefined) this.expr(p.default, s);
        s.bound.add(st.name);
        const inner = this.make(st, 'function', s, st.params.map((p) => p.name));
        this.stmts(st.body, inner);
        return;
      }
      case 'return':
        if (st.value !== undefined) this.expr(st.value, s);
        return;
      case 'import':
        for (const a of st.names) s.bound.add(a.asname ?? (a.name.split('.')[0] as string));
        return;
      case 'importfrom':
        for (const a of st.names) s.bound.add(a.asname ?? a.name);
        return;
      case 'try':
        this.stmts(st.body, s);
        for (const h of st.handlers) {
          if (h.type !== undefined) this.expr(h.type, s);
          if (h.name !== undefined) s.bound.add(h.name);
          this.stmts(h.body, s);
        }
        this.stmts(st.orelse, s);
        this.stmts(st.finalbody, s);
        return;
      case 'raise':
        if (st.exc !== undefined) this.expr(st.exc, s);
        return;
      case 'global':
        for (const n of st.names) {
          if (s.kind === 'function' && s.params.includes(n)) throw new CompileFail(st.span, `The name "${n}" is a parameter and cannot also be declared global.`);
          s.globals.add(n);
        }
        return;
      case 'del':
        for (const t of st.targets) this.bindTarget(t, s);
        return;
      case 'assert':
        this.expr(st.test, s);
        if (st.msg !== undefined) this.expr(st.msg, s);
        return;
    }
  }

  private expr(e: PyExpr, s: Scope): void {
    switch (e.kind) {
      case 'name':
        s.used.add(e.id);
        return;
      case 'const':
        return;
      case 'fstring':
        for (const p of e.parts) if (p.kind === 'field') this.expr(p.expr, s);
        return;
      case 'list':
      case 'tuple':
      case 'set':
        for (const i of e.items) this.expr(i, s);
        return;
      case 'dict':
        for (const en of e.entries) {
          this.expr(en.key, s);
          this.expr(en.value, s);
        }
        return;
      case 'comp': {
        const first = e.generators[0];
        if (first !== undefined) this.expr(first.iter, s);
        const inner = this.make(e, 'function', s, ['.0']);
        e.generators.forEach((g, i) => {
          if (i > 0) this.expr(g.iter, inner);
          this.bindTarget(g.target, inner);
          for (const c of g.ifs) this.expr(c, inner);
        });
        this.expr(e.elt, inner);
        if (e.value !== undefined) this.expr(e.value, inner);
        return;
      }
      case 'unary':
        this.expr(e.operand, s);
        return;
      case 'binary':
        this.expr(e.left, s);
        this.expr(e.right, s);
        return;
      case 'boolop':
        for (const v of e.values) this.expr(v, s);
        return;
      case 'compare':
        this.expr(e.left, s);
        for (const c of e.comparators) this.expr(c, s);
        return;
      case 'ifexp':
        this.expr(e.test, s);
        this.expr(e.body, s);
        this.expr(e.orelse, s);
        return;
      case 'lambda': {
        for (const p of e.params) if (p.default !== undefined) this.expr(p.default, s);
        const inner = this.make(e, 'function', s, e.params.map((p) => p.name));
        this.expr(e.body, inner);
        return;
      }
      case 'attribute':
        this.expr(e.value, s);
        return;
      case 'subscript':
        this.expr(e.value, s);
        this.index(e.index, s);
        return;
      case 'call':
        this.expr(e.func, s);
        for (const a of e.args) this.expr(a, s);
        for (const k of e.keywords) this.expr(k.value, s);
        return;
    }
  }

  /** Decides, for every use, whether a name is local, a cell, free, or global (see the file header). */
  resolve(): void {
    for (const s of this.scopes.values()) {
      if (s.kind !== 'function') continue;
      for (const n of s.used) {
        if (s.globals.has(n) || s.bound.has(n)) continue;
        const chain: Scope[] = [s];
        for (let p = s.parent; p !== undefined && p.kind === 'function'; p = p.parent) {
          if (p.globals.has(n)) break;
          if (p.bound.has(n)) {
            p.cells.add(n);
            for (const c of chain) c.free.add(n);
            break;
          }
          chain.push(p);
        }
      }
    }
  }
}

// ── code generation ─────────────────────────────────────────────────────────

/** What a `break`, `continue` or `return` passes on its way out (innermost last). */
type FBlock =
  | { readonly kind: 'loop'; readonly loop: 'for' | 'while'; readonly continueAt: number; readonly breaks: number[] }
  | { readonly kind: 'except-body' }
  | { readonly kind: 'handler'; readonly name?: string }
  | { readonly kind: 'finally-body'; readonly body: readonly PyStmt[] }
  | { readonly kind: 'finally-exc' };

type Access = 'fast' | 'cell' | 'free' | 'global';

class CodeBuilder {
  readonly ops: number[] = [];
  readonly args: number[] = [];
  readonly lines: number[] = [];
  readonly consts: PyConstant[] = [];
  readonly names: string[] = [];
  readonly varnames: string[];
  readonly cellvars: string[];
  readonly freevars: string[];
  readonly fblocks: FBlock[] = [];
  line: number;
  private readonly constIndex = new Map<string, number>();

  constructor(readonly codeName: string, readonly scope: Scope, readonly firstLine: number, readonly ndefaults: number) {
    this.line = firstLine;
    this.cellvars = [...scope.cells].sort();
    const locals = scope.kind === 'function' ? [...scope.params] : [];
    if (scope.kind === 'function') {
      for (const n of [...scope.bound].sort()) if (!locals.includes(n) && !scope.globals.has(n) && !scope.cells.has(n)) locals.push(n);
    }
    this.varnames = locals;
    this.freevars = [...scope.free].sort();
  }

  emit(op: number, arg = 0): number {
    this.ops.push(op);
    this.args.push(arg);
    this.lines.push(this.line);
    return this.ops.length - 1;
  }

  get here(): number {
    return this.ops.length;
  }

  patch(at: number, target = this.here): void {
    this.args[at] = target;
  }

  constant(v: PyConstant): number {
    let key: string | undefined;
    if (v === null) key = 'N';
    else if (typeof v === 'boolean') key = v ? 'T' : 'F';
    else if (typeof v === 'number') key = Object.is(v, -0) ? 'i-0' : `i${v}`;
    else if (typeof v === 'string') key = `s${v}`;
    else if ('float' in v) key = Object.is(v.float, -0) ? 'f-0' : `f${v.float}`;
    else if ('kwnames' in v) key = `k${JSON.stringify(v.kwnames)}`;
    if (key !== undefined) {
      const found = this.constIndex.get(key);
      if (found !== undefined) return found;
      this.constIndex.set(key, this.consts.length);
    }
    this.consts.push(v);
    return this.consts.length - 1;
  }

  name(n: string): number {
    const i = this.names.indexOf(n);
    if (i >= 0) return i;
    this.names.push(n);
    return this.names.length - 1;
  }

  /** How this code reaches name `n`. */
  access(n: string): Access {
    const s = this.scope;
    if (s.kind === 'module' || s.globals.has(n)) return 'global';
    if (s.cells.has(n)) return 'cell';
    if (s.free.has(n)) return 'free';
    if (s.bound.has(n)) return 'fast';
    return 'global';
  }

  /** Index of `n` in the frame's cell array (cell variables first, then free variables). */
  cellIndex(n: string): number {
    const c = this.cellvars.indexOf(n);
    return c >= 0 ? c : this.cellvars.length + this.freevars.indexOf(n);
  }

  build(filename: string): PyCode {
    const params = this.scope.kind === 'function' ? [...this.scope.params] : [];
    return Object.freeze({
      kind: 'code' as const,
      name: this.codeName,
      filename,
      params,
      ndefaults: this.ndefaults,
      varnames: this.varnames,
      cellvars: this.cellvars,
      cellParams: this.cellvars.map((c) => params.indexOf(c)),
      freevars: this.freevars,
      names: this.names,
      consts: this.consts,
      ops: this.ops,
      args: this.args,
      lines: this.lines,
      firstLine: this.firstLine,
    });
  }
}

const OP = PY_OP;

class Compiler {
  constructor(private readonly filename: string, private readonly scopes: ReadonlyMap<ScopeOwner, Scope>) {}

  private scopeOf(owner: ScopeOwner): Scope {
    const s = this.scopes.get(owner);
    if (s === undefined) throw new Error('nf-py: a scope was not collected');
    return s;
  }

  module(m: PyModule): PyCode {
    const b = new CodeBuilder('<module>', this.scopeOf(m), 1, 0);
    this.body(b, m.body);
    b.emit(OP.LOAD_CONST, b.constant(null));
    b.emit(OP.RETURN_VALUE);
    return b.build(this.filename);
  }

  private at(b: CodeBuilder, span: SourceSpan): void {
    b.line = span.start.line;
  }

  private body(b: CodeBuilder, body: readonly PyStmt[]): void {
    for (const st of body) this.stmt(b, st);
  }

  // ── names ──

  private load(b: CodeBuilder, n: string): void {
    switch (b.access(n)) {
      case 'fast':
        b.emit(OP.LOAD_FAST, b.varnames.indexOf(n));
        return;
      case 'cell':
      case 'free':
        b.emit(OP.LOAD_DEREF, b.cellIndex(n));
        return;
      case 'global':
        b.emit(OP.LOAD_GLOBAL, b.name(n));
        return;
    }
  }

  private store(b: CodeBuilder, n: string): void {
    switch (b.access(n)) {
      case 'fast':
        b.emit(OP.STORE_FAST, b.varnames.indexOf(n));
        return;
      case 'cell':
      case 'free':
        b.emit(OP.STORE_DEREF, b.cellIndex(n));
        return;
      case 'global':
        b.emit(OP.STORE_GLOBAL, b.name(n));
        return;
    }
  }

  private del(b: CodeBuilder, n: string): void {
    switch (b.access(n)) {
      case 'fast':
        b.emit(OP.DELETE_FAST, b.varnames.indexOf(n));
        return;
      case 'cell':
      case 'free':
        b.emit(OP.DELETE_DEREF, b.cellIndex(n));
        return;
      case 'global':
        b.emit(OP.DELETE_GLOBAL, b.name(n));
        return;
    }
  }

  /** Store the value on top of the stack into a target. */
  private storeTarget(b: CodeBuilder, t: PyTarget): void {
    switch (t.kind) {
      case 'name':
        this.store(b, t.id);
        return;
      case 'attribute':
        this.expr(b, t.value);
        b.emit(OP.STORE_ATTR, b.name(t.attr));
        return;
      case 'subscript':
        this.expr(b, t.value);
        this.index(b, t.index);
        b.emit(OP.STORE_SUBSCR);
        return;
      case 'tuple':
      case 'list':
        b.emit(OP.UNPACK_SEQUENCE, t.items.length);
        for (const i of t.items) this.storeTarget(b, i as PyTarget);
        return;
    }
  }

  private deleteTarget(b: CodeBuilder, t: PyTarget): void {
    switch (t.kind) {
      case 'name':
        this.del(b, t.id);
        return;
      case 'attribute':
        this.expr(b, t.value);
        b.emit(OP.DELETE_ATTR, b.name(t.attr));
        return;
      case 'subscript':
        this.expr(b, t.value);
        this.index(b, t.index);
        b.emit(OP.DELETE_SUBSCR);
        return;
      case 'tuple':
      case 'list':
        for (const i of t.items) this.deleteTarget(b, i as PyTarget);
        return;
    }
  }

  // ── statements ──

  private stmt(b: CodeBuilder, st: PyStmt): void {
    this.at(b, st.span);
    switch (st.kind) {
      case 'expr':
        this.expr(b, st.value);
        b.emit(OP.POP_TOP);
        return;
      case 'assign':
        this.expr(b, st.value);
        st.targets.forEach((t, i) => {
          if (i < st.targets.length - 1) b.emit(OP.DUP_TOP);
          this.storeTarget(b, t);
        });
        return;
      case 'augassign':
        this.augassign(b, st);
        return;
      case 'if': {
        this.expr(b, st.test);
        const toElse = b.emit(OP.POP_JUMP_IF_FALSE);
        this.body(b, st.body);
        if (st.orelse.length === 0) {
          b.patch(toElse);
          return;
        }
        const toEnd = b.emit(OP.JUMP);
        b.patch(toElse);
        this.body(b, st.orelse);
        b.patch(toEnd);
        return;
      }
      case 'while': {
        const top = b.here;
        this.expr(b, st.test);
        const exit = b.emit(OP.POP_JUMP_IF_FALSE);
        const loop: FBlock = { kind: 'loop', loop: 'while', continueAt: top, breaks: [] };
        b.fblocks.push(loop);
        this.body(b, st.body);
        b.fblocks.pop();
        b.emit(OP.JUMP, top);
        b.patch(exit);
        for (const j of loop.breaks) b.patch(j);
        return;
      }
      case 'for': {
        this.expr(b, st.iter);
        b.emit(OP.GET_ITER);
        const top = b.here;
        const exit = b.emit(OP.FOR_ITER);
        this.storeTarget(b, st.target);
        const loop: FBlock = { kind: 'loop', loop: 'for', continueAt: top, breaks: [] };
        b.fblocks.push(loop);
        this.body(b, st.body);
        b.fblocks.pop();
        this.at(b, st.span);
        b.emit(OP.JUMP, top);
        b.patch(exit);
        for (const j of loop.breaks) b.patch(j);
        return;
      }
      case 'break':
      case 'continue':
        this.leaveLoop(b, st.kind, st.span);
        return;
      case 'pass':
        return;
      case 'def':
        this.makeFunction(b, st, st.name, st.params, (inner) => {
          this.body(inner, st.body);
          inner.emit(OP.LOAD_CONST, inner.constant(null));
          inner.emit(OP.RETURN_VALUE);
        });
        this.store(b, st.name);
        return;
      case 'return':
        if (b.scope.kind === 'module') throw new CompileFail(st.span, MSG_RETURN_OUTSIDE);
        this.ret(b, st.value);
        return;
      case 'import':
        for (const a of st.names) {
          b.emit(OP.IMPORT_NAME, b.name(a.name));
          if (a.asname !== undefined) this.store(b, a.asname);
          else {
            const top = a.name.split('.')[0] as string;
            if (top !== a.name) {
              b.emit(OP.POP_TOP);
              b.emit(OP.IMPORT_NAME, b.name(top));
            }
            this.store(b, top);
          }
        }
        return;
      case 'importfrom':
        b.emit(OP.IMPORT_NAME, b.name(st.module));
        for (const a of st.names) {
          b.emit(OP.IMPORT_FROM, b.name(a.name));
          this.store(b, a.asname ?? a.name);
        }
        b.emit(OP.POP_TOP);
        return;
      case 'try':
        this.tryStmt(b, st);
        return;
      case 'raise':
        if (st.exc !== undefined) {
          this.expr(b, st.exc);
          b.emit(OP.RAISE, 1);
        } else b.emit(OP.RAISE, 0);
        return;
      case 'global':
        return;
      case 'del':
        for (const t of st.targets) this.deleteTarget(b, t);
        return;
      case 'assert': {
        this.expr(b, st.test);
        const ok = b.emit(OP.POP_JUMP_IF_TRUE);
        b.emit(OP.LOAD_ASSERTION_ERROR);
        if (st.msg !== undefined) {
          this.expr(b, st.msg);
          b.emit(OP.CALL, 1);
        }
        b.emit(OP.RAISE, 1);
        b.patch(ok);
        return;
      }
    }
  }

  private augassign(b: CodeBuilder, st: Extract<PyStmt, { kind: 'augassign' }>): void {
    const op = PY_BINARY_OPS.indexOf(st.op);
    const t = st.target;
    if (t.kind === 'name') {
      this.load(b, t.id);
      this.expr(b, st.value);
      b.emit(OP.INPLACE, op);
      this.store(b, t.id);
    } else if (t.kind === 'attribute') {
      this.expr(b, t.value);
      b.emit(OP.DUP_TOP);
      b.emit(OP.LOAD_ATTR, b.name(t.attr));
      this.expr(b, st.value);
      b.emit(OP.INPLACE, op);
      b.emit(OP.ROT_TWO);
      b.emit(OP.STORE_ATTR, b.name(t.attr));
    } else {
      this.expr(b, t.value);
      this.index(b, t.index);
      b.emit(OP.DUP_TOP_TWO);
      b.emit(OP.LOAD_SUBSCR);
      this.expr(b, st.value);
      b.emit(OP.INPLACE, op);
      b.emit(OP.ROT_THREE);
      b.emit(OP.STORE_SUBSCR);
    }
  }

  /**
   * The exit code of the blocks between here and (excluding) `stopAt`: POP_BLOCK for a `try` body, END_HANDLER (and the
   * `as` name's deletion) for a handler, the `finally` body inline, the exception left on the stack by an exception-path
   * `finally`. `popLoops`: also drop the iterator of each `for` passed (a `break` from it is handled by the caller).
   */
  private unwind(b: CodeBuilder, stopAt: number): void {
    for (let i = b.fblocks.length - 1; i > stopAt; i--) {
      const f = b.fblocks[i] as FBlock;
      switch (f.kind) {
        case 'loop':
          // only `return` passes a loop; the frame ends, so its iterator needs no pop
          break;
        case 'except-body':
          b.emit(OP.POP_BLOCK);
          break;
        case 'handler':
          b.emit(OP.END_HANDLER);
          if (f.name !== undefined) this.clearName(b, f.name);
          break;
        case 'finally-body': {
          b.emit(OP.POP_BLOCK);
          // the finally body runs with the blocks outside it, then the exit goes on
          const saved = b.fblocks.splice(i);
          this.body(b, f.body);
          b.fblocks.push(...saved);
          break;
        }
        case 'finally-exc':
          b.emit(OP.POP_TOP);
          break;
      }
    }
  }

  private clearName(b: CodeBuilder, name: string): void {
    b.emit(OP.LOAD_CONST, b.constant(null));
    this.store(b, name);
    this.del(b, name);
  }

  private leaveLoop(b: CodeBuilder, how: 'break' | 'continue', span: SourceSpan): void {
    let at = b.fblocks.length - 1;
    while (at >= 0 && (b.fblocks[at] as FBlock).kind !== 'loop') at--;
    const loop = b.fblocks[at] as Extract<FBlock, { kind: 'loop' }> | undefined;
    if (loop === undefined) throw new CompileFail(span, how === 'break' ? MSG_BREAK_OUTSIDE : MSG_CONTINUE_OUTSIDE);
    this.unwind(b, at);
    if (how === 'continue') {
      b.emit(OP.JUMP, loop.continueAt);
      return;
    }
    if (loop.loop === 'for') b.emit(OP.POP_TOP);
    loop.breaks.push(b.emit(OP.JUMP));
  }

  private ret(b: CodeBuilder, value: PyExpr | undefined): void {
    if (value !== undefined) this.expr(b, value);
    else b.emit(OP.LOAD_CONST, b.constant(null));
    if (b.fblocks.some((f) => f.kind !== 'loop')) {
      // keep the value safe while the blocks are left (a finally body may run here)
      const slot = this.hiddenLocal(b, '.return');
      b.emit(OP.STORE_FAST, slot);
      this.unwind(b, -1);
      b.emit(OP.LOAD_FAST, slot);
    }
    b.emit(OP.RETURN_VALUE);
  }

  private hiddenLocal(b: CodeBuilder, name: string): number {
    let i = b.varnames.indexOf(name);
    if (i < 0) {
      b.varnames.push(name);
      i = b.varnames.length - 1;
    }
    return i;
  }

  private tryStmt(b: CodeBuilder, st: PyTry): void {
    if (st.finalbody.length === 0) {
      this.tryExcept(b, st);
      return;
    }
    const setup = b.emit(OP.SETUP_FINALLY);
    b.fblocks.push({ kind: 'finally-body', body: st.finalbody });
    if (st.handlers.length > 0) this.tryExcept(b, st);
    else this.body(b, st.body);
    b.fblocks.pop();
    b.emit(OP.POP_BLOCK);
    this.body(b, st.finalbody);
    const toEnd = b.emit(OP.JUMP);
    b.patch(setup);
    b.fblocks.push({ kind: 'finally-exc' });
    this.body(b, st.finalbody);
    b.fblocks.pop();
    b.emit(OP.RERAISE);
    b.patch(toEnd);
  }

  private tryExcept(b: CodeBuilder, st: PyTry): void {
    const setup = b.emit(OP.SETUP_EXCEPT);
    b.fblocks.push({ kind: 'except-body' });
    this.body(b, st.body);
    b.fblocks.pop();
    b.emit(OP.POP_BLOCK);
    this.body(b, st.orelse);
    const ends: number[] = [b.emit(OP.JUMP)];
    b.patch(setup);
    for (const h of st.handlers) {
      this.at(b, h.span);
      let next: number | undefined;
      if (h.type !== undefined) {
        b.emit(OP.DUP_TOP);
        this.expr(b, h.type);
        b.emit(OP.EXC_MATCH);
        next = b.emit(OP.POP_JUMP_IF_FALSE);
      }
      b.emit(OP.BEGIN_HANDLER);
      if (h.name !== undefined) {
        b.emit(OP.LOAD_EXC);
        this.store(b, h.name);
      }
      b.fblocks.push(h.name !== undefined ? { kind: 'handler', name: h.name } : { kind: 'handler' });
      this.body(b, h.body);
      b.fblocks.pop();
      b.emit(OP.END_HANDLER);
      if (h.name !== undefined) this.clearName(b, h.name);
      ends.push(b.emit(OP.JUMP));
      if (next !== undefined) b.patch(next);
    }
    b.emit(OP.RERAISE);
    for (const e of ends) b.patch(e);
  }

  /** Build a function object on the stack: defaults, closure, code, MAKE_FUNCTION. */
  private makeFunction(b: CodeBuilder, owner: ScopeOwner, name: string, params: readonly PyParam[], fill: (inner: CodeBuilder) => void): void {
    const defaults = params.filter((p) => p.default !== undefined);
    for (const p of defaults) this.expr(b, p.default as PyExpr);
    let flags = 0;
    if (defaults.length > 0) {
      b.emit(OP.BUILD_TUPLE, defaults.length);
      flags |= PY_FN_DEFAULTS;
    }
    const scope = this.scopeOf(owner);
    const inner = new CodeBuilder(name, scope, owner.span.start.line, defaults.length);
    fill(inner);
    const code = inner.build(this.filename);
    if (code.freevars.length > 0) {
      for (const f of code.freevars) b.emit(OP.LOAD_CLOSURE, b.cellIndex(f));
      b.emit(OP.BUILD_TUPLE, code.freevars.length);
      flags |= PY_FN_CLOSURE;
    }
    b.emit(OP.LOAD_CONST, b.constant(code));
    b.emit(OP.MAKE_FUNCTION, flags);
  }

  // ── expressions ──

  private index(b: CodeBuilder, i: PyExpr | PySlice): void {
    if (i.kind !== 'slice') {
      this.expr(b, i);
      return;
    }
    for (const part of [i.lower, i.upper, i.step]) {
      if (part === undefined) b.emit(OP.LOAD_CONST, b.constant(null));
      else this.expr(b, part);
    }
    b.emit(OP.BUILD_SLICE, 3);
  }

  private expr(b: CodeBuilder, e: PyExpr): void {
    const line = b.line;
    if (e.span.start.line > line) b.line = e.span.start.line;
    this.exprAt(b, e);
    b.line = line;
  }

  private exprAt(b: CodeBuilder, e: PyExpr): void {
    switch (e.kind) {
      case 'name':
        this.load(b, e.id);
        return;
      case 'const':
        b.emit(OP.LOAD_CONST, b.constant(e.type === 'float' ? { float: e.value as number } : e.value));
        return;
      case 'fstring': {
        for (const p of e.parts) {
          if (p.kind === 'text') {
            b.emit(OP.LOAD_CONST, b.constant(p.value));
            continue;
          }
          this.expr(b, p.expr);
          let flags = p.conversion === 's' ? 1 : p.conversion === 'r' ? 2 : p.conversion === 'a' ? 3 : 0;
          if (p.spec !== undefined) {
            b.emit(OP.LOAD_CONST, b.constant(p.spec));
            flags |= PY_FORMAT_HAS_SPEC;
          }
          b.emit(OP.FORMAT_VALUE, flags);
        }
        b.emit(OP.BUILD_STRING, e.parts.length);
        return;
      }
      case 'list':
      case 'tuple':
      case 'set':
        for (const i of e.items) this.expr(b, i);
        b.emit(e.kind === 'list' ? OP.BUILD_LIST : e.kind === 'tuple' ? OP.BUILD_TUPLE : OP.BUILD_SET, e.items.length);
        return;
      case 'dict':
        for (const en of e.entries) {
          this.expr(b, en.key);
          this.expr(b, en.value);
        }
        b.emit(OP.BUILD_MAP, e.entries.length);
        return;
      case 'comp':
        this.comprehension(b, e);
        return;
      case 'unary':
        this.expr(b, e.operand);
        b.emit(OP.UNARY, PY_UNARY_OPS.indexOf(e.op));
        return;
      case 'binary':
        this.expr(b, e.left);
        this.expr(b, e.right);
        b.emit(OP.BINARY, PY_BINARY_OPS.indexOf(e.op));
        return;
      case 'boolop': {
        const jumps: number[] = [];
        e.values.forEach((v, i) => {
          this.expr(b, v);
          if (i < e.values.length - 1) jumps.push(b.emit(e.op === 'and' ? OP.JUMP_IF_FALSE_OR_POP : OP.JUMP_IF_TRUE_OR_POP));
        });
        for (const j of jumps) b.patch(j);
        return;
      }
      case 'compare': {
        this.expr(b, e.left);
        const n = e.ops.length;
        if (n === 1) {
          this.expr(b, e.comparators[0] as PyExpr);
          b.emit(OP.COMPARE, PY_COMPARE_OPS.indexOf(e.ops[0] as PyCompareOp));
          return;
        }
        const cleanups: number[] = [];
        for (let i = 0; i < n - 1; i++) {
          this.expr(b, e.comparators[i] as PyExpr);
          b.emit(OP.DUP_TOP);
          b.emit(OP.ROT_THREE);
          b.emit(OP.COMPARE, PY_COMPARE_OPS.indexOf(e.ops[i] as PyCompareOp));
          cleanups.push(b.emit(OP.JUMP_IF_FALSE_OR_POP));
        }
        this.expr(b, e.comparators[n - 1] as PyExpr);
        b.emit(OP.COMPARE, PY_COMPARE_OPS.indexOf(e.ops[n - 1] as PyCompareOp));
        const toEnd = b.emit(OP.JUMP);
        for (const c of cleanups) b.patch(c);
        b.emit(OP.ROT_TWO);
        b.emit(OP.POP_TOP);
        b.patch(toEnd);
        return;
      }
      case 'ifexp': {
        this.expr(b, e.test);
        const toElse = b.emit(OP.POP_JUMP_IF_FALSE);
        this.expr(b, e.body);
        const toEnd = b.emit(OP.JUMP);
        b.patch(toElse);
        this.expr(b, e.orelse);
        b.patch(toEnd);
        return;
      }
      case 'lambda':
        this.makeFunction(b, e, '<lambda>', e.params, (inner) => {
          this.expr(inner, e.body);
          inner.emit(OP.RETURN_VALUE);
        });
        return;
      case 'attribute':
        this.expr(b, e.value);
        b.emit(OP.LOAD_ATTR, b.name(e.attr));
        return;
      case 'subscript':
        this.expr(b, e.value);
        this.index(b, e.index);
        b.emit(OP.LOAD_SUBSCR);
        return;
      case 'call': {
        this.expr(b, e.func);
        for (const a of e.args) this.expr(b, a);
        if (e.keywords.length === 0) {
          b.emit(OP.CALL, e.args.length);
          return;
        }
        for (const k of e.keywords) this.expr(b, k.value);
        b.emit(OP.LOAD_CONST, b.constant({ kwnames: e.keywords.map((k) => k.name) }));
        b.emit(OP.CALL_KW, e.args.length + e.keywords.length);
        return;
      }
    }
  }

  /** A comprehension: a function of `.0` (the first iterator) that builds the list, set or dict. */
  private comprehension(b: CodeBuilder, e: PyComp): void {
    const names = { list: '<listcomp>', set: '<setcomp>', dict: '<dictcomp>', generator: '<genexpr>' } as const;
    this.makeFunction(b, e, names[e.type], [], (inner) => {
      inner.emit(e.type === 'set' ? OP.BUILD_SET : e.type === 'dict' ? OP.BUILD_MAP : OP.BUILD_LIST, 0);
      const exits: { top: number; exit: number }[] = [];
      e.generators.forEach((g, i) => {
        if (i === 0) inner.emit(OP.LOAD_FAST, inner.varnames.indexOf('.0'));
        else {
          this.expr(inner, g.iter);
          inner.emit(OP.GET_ITER);
        }
        const top = inner.here;
        const exit = inner.emit(OP.FOR_ITER);
        exits.push({ top, exit });
        this.storeTarget(inner, g.target);
        for (const c of g.ifs) {
          this.expr(inner, c);
          inner.emit(OP.POP_JUMP_IF_FALSE, top);
        }
      });
      const depth = e.generators.length;
      if (e.type === 'dict') {
        this.expr(inner, e.elt);
        this.expr(inner, e.value as PyExpr);
        inner.emit(OP.MAP_ADD, depth);
      } else {
        this.expr(inner, e.elt);
        inner.emit(e.type === 'set' ? OP.SET_ADD : OP.LIST_APPEND, depth);
      }
      for (let i = exits.length - 1; i >= 0; i--) {
        const x = exits[i] as { top: number; exit: number };
        inner.emit(OP.JUMP, x.top);
        inner.patch(x.exit);
      }
      inner.emit(OP.RETURN_VALUE);
    });
    const first = e.generators[0];
    if (first !== undefined) this.expr(b, first.iter);
    b.emit(OP.GET_ITER);
    b.emit(OP.CALL, 1);
    if (e.type === 'generator') b.emit(OP.GET_ITER);
  }
}

/**
 * Compiles an NF-Py program. A syntax error (from the parser, or a scope rule the compiler checks) comes back with
 * Python's error class, an original message and its line and column.
 */
export function compilePy(source: string, filename = '<script>'): PyCompileResult {
  const parsed = parsePy(source);
  if (!parsed.ok) return { ok: false, error: parsed.error };
  try {
    const collector = new ScopeCollector();
    collector.module(parsed.module);
    collector.resolve();
    const code = new Compiler(filename, collector.scopes).module(parsed.module);
    return { ok: true, program: Object.freeze({ code, filename, source }) };
  } catch (e) {
    if (!(e instanceof CompileFail)) throw e;
    return { ok: false, error: { type: 'SyntaxError', message: e.message, line: e.span.start.line, column: e.span.start.column, offset: e.span.start.offset } };
  }
}

/** One instruction as text (`LOAD_CONST 3`), for tests and the debugger view. */
export function disassemblePy(code: PyCode): string[] {
  const byNumber = new Map<number, string>(Object.entries(PY_OP).map(([k, v]) => [v, k]));
  return code.ops.map((op, i) => `${String(i).padStart(4)} ${String(code.lines[i]).padStart(4)} ${byNumber.get(op) ?? `?${op}`} ${code.args[i]}`);
}
