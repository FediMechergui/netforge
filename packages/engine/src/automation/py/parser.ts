/**
 * The NF-Py parser (ARCHITECTURE-P3 D21 "[S32] NF-Py", §7 W1 auto [S32]).
 *
 * Builds the syntax tree of an NF-Py program from the tokens of `lexer.ts`. Pure, exported through
 * `@netforge/engine/pure` (the automation workspace's live syntax marks), and the input of the W2 compiler: the node
 * types below are the whole language, so whatever parses here the compiler must run.
 *
 * THE LANGUAGE (a teaching subset of Python 3):
 *  - statements: expression statements; assignment (chained `a = b = 0`, unpacking `k, v = pair`, to names,
 *    attributes and subscripts); augmented assignment (`+=` `-=` `*=` `/=` `//=` `%=` `**=` `<<=` `>>=` `&=` `|=` `^=`);
 *    `if`/`elif`/`else`; `while`; `for … in …`; `break`; `continue`; `pass`; `def` with positional parameters and
 *    defaults; `return`; `import m [as n]`; `from m import n [as k]`; `try` with `except [E [as e]]`, `else`, `finally`;
 *    `raise [E]`; `global`; `del`; `assert`;
 *  - expressions: literals (int, float, str with adjacent concatenation, f-strings, True/False/None), lists, tuples,
 *    dicts, sets, list/set/dict comprehensions and generator expressions, `lambda`, `x if c else y`, `or`/`and`/`not`,
 *    chained comparisons (`== != < <= > >= in not in is is not`), `| ^ & << >> + - * / // % **`, unary `- + ~`,
 *    attribute access, calls with positional and keyword arguments, indexing and slices.
 * Refused with a message that names the construct: classes, `with`, `async`/`await`, `yield`, decorators, `nonlocal`,
 * `*args`/`**kwargs` and starred expressions, `:=`, `@`, type annotations, `else` on loops, `raise … from`, relative
 * and star imports, `...`.
 *
 * Errors carry Python's error class (SyntaxError, IndentationError, TabError), an original message and the 1-based
 * line and column; the first error in source order is reported.
 */
import { textPositions, type SourcePos, type SourceSpan } from '../data/json.js';
import { lexPy, lexPyExpression, type PyFStringToken, type PySyntaxError, type PySyntaxErrorType, type PyToken } from './lexer.js';

// ── the syntax tree ──────────────────────────────────────────────────────────

interface PyNodeBase {
  readonly span: SourceSpan;
}

export interface PyName extends PyNodeBase {
  readonly kind: 'name';
  readonly id: string;
}

export interface PyConst extends PyNodeBase {
  readonly kind: 'const';
  readonly type: 'int' | 'float' | 'str' | 'bool' | 'none';
  readonly value: number | string | boolean | null;
}

/** A replacement field of an f-string: `{expr!conversion:spec}`. */
export interface PyFStringField {
  readonly kind: 'field';
  readonly expr: PyExpr;
  readonly conversion?: 's' | 'r' | 'a';
  readonly spec?: string;
}

/** An f-string (adjacent plain strings joined in as text). */
export interface PyFString extends PyNodeBase {
  readonly kind: 'fstring';
  readonly parts: readonly ({ readonly kind: 'text'; readonly value: string } | PyFStringField)[];
}

export interface PyList extends PyNodeBase {
  readonly kind: 'list';
  readonly items: readonly PyExpr[];
}

export interface PyTuple extends PyNodeBase {
  readonly kind: 'tuple';
  readonly items: readonly PyExpr[];
}

export interface PySet extends PyNodeBase {
  readonly kind: 'set';
  readonly items: readonly PyExpr[];
}

export interface PyDict extends PyNodeBase {
  readonly kind: 'dict';
  readonly entries: readonly { readonly key: PyExpr; readonly value: PyExpr }[];
}

/** One `for target in iter [if cond]…` clause of a comprehension. */
export interface PyComprehension {
  readonly target: PyTarget;
  readonly iter: PyExpr;
  readonly ifs: readonly PyExpr[];
}

/** `[elt for …]`, `{elt for …}`, `(elt for …)`, `{key: value for …}` (`elt` is the key of a dict comprehension). */
export interface PyComp extends PyNodeBase {
  readonly kind: 'comp';
  readonly type: 'list' | 'set' | 'generator' | 'dict';
  readonly elt: PyExpr;
  /** Dict comprehensions only. */
  readonly value?: PyExpr;
  readonly generators: readonly PyComprehension[];
}

export type PyUnaryOp = '-' | '+' | '~' | 'not';

export interface PyUnary extends PyNodeBase {
  readonly kind: 'unary';
  readonly op: PyUnaryOp;
  readonly operand: PyExpr;
}

export type PyBinaryOp = '+' | '-' | '*' | '/' | '//' | '%' | '**' | '<<' | '>>' | '&' | '|' | '^';

export interface PyBinary extends PyNodeBase {
  readonly kind: 'binary';
  readonly op: PyBinaryOp;
  readonly left: PyExpr;
  readonly right: PyExpr;
}

export interface PyBoolOp extends PyNodeBase {
  readonly kind: 'boolop';
  readonly op: 'and' | 'or';
  readonly values: readonly PyExpr[];
}

export type PyCompareOp = '==' | '!=' | '<' | '<=' | '>' | '>=' | 'in' | 'not in' | 'is' | 'is not';

/** A comparison chain: `a < b <= c` is `{left: a, ops: ['<', '<='], comparators: [b, c]}`. */
export interface PyCompare extends PyNodeBase {
  readonly kind: 'compare';
  readonly left: PyExpr;
  readonly ops: readonly PyCompareOp[];
  readonly comparators: readonly PyExpr[];
}

export interface PyIfExp extends PyNodeBase {
  readonly kind: 'ifexp';
  readonly test: PyExpr;
  readonly body: PyExpr;
  readonly orelse: PyExpr;
}

/** A parameter of `def` or `lambda`. */
export interface PyParam {
  readonly name: string;
  readonly default?: PyExpr;
  readonly span: SourceSpan;
}

export interface PyLambda extends PyNodeBase {
  readonly kind: 'lambda';
  readonly params: readonly PyParam[];
  readonly body: PyExpr;
}

export interface PyAttribute extends PyNodeBase {
  readonly kind: 'attribute';
  readonly value: PyExpr;
  readonly attr: string;
}

/** `lower:upper:step` inside brackets; each part optional. */
export interface PySlice extends PyNodeBase {
  readonly kind: 'slice';
  readonly lower?: PyExpr;
  readonly upper?: PyExpr;
  readonly step?: PyExpr;
}

export interface PySubscript extends PyNodeBase {
  readonly kind: 'subscript';
  readonly value: PyExpr;
  readonly index: PyExpr | PySlice;
}

export interface PyKeyword {
  readonly name: string;
  readonly value: PyExpr;
  readonly span: SourceSpan;
}

export interface PyCall extends PyNodeBase {
  readonly kind: 'call';
  readonly func: PyExpr;
  readonly args: readonly PyExpr[];
  readonly keywords: readonly PyKeyword[];
}

export type PyExpr =
  | PyName
  | PyConst
  | PyFString
  | PyList
  | PyTuple
  | PySet
  | PyDict
  | PyComp
  | PyUnary
  | PyBinary
  | PyBoolOp
  | PyCompare
  | PyIfExp
  | PyLambda
  | PyAttribute
  | PySubscript
  | PyCall;

/** What can be assigned to: a name, an attribute, a subscript, or a tuple/list of targets (unpacking). */
export type PyTarget = PyName | PyAttribute | PySubscript | PyTuple | PyList;

export interface PyExprStmt extends PyNodeBase {
  readonly kind: 'expr';
  readonly value: PyExpr;
}

/** `t1 = t2 = value` has two targets, assigned left to right. */
export interface PyAssign extends PyNodeBase {
  readonly kind: 'assign';
  readonly targets: readonly PyTarget[];
  readonly value: PyExpr;
}

export interface PyAugAssign extends PyNodeBase {
  readonly kind: 'augassign';
  readonly target: PyName | PyAttribute | PySubscript;
  readonly op: PyBinaryOp;
  readonly value: PyExpr;
}

/** `elif` is an `if` alone in `orelse`. */
export interface PyIf extends PyNodeBase {
  readonly kind: 'if';
  readonly test: PyExpr;
  readonly body: readonly PyStmt[];
  readonly orelse: readonly PyStmt[];
}

export interface PyWhile extends PyNodeBase {
  readonly kind: 'while';
  readonly test: PyExpr;
  readonly body: readonly PyStmt[];
}

export interface PyFor extends PyNodeBase {
  readonly kind: 'for';
  readonly target: PyTarget;
  readonly iter: PyExpr;
  readonly body: readonly PyStmt[];
}

export interface PySimpleStmt extends PyNodeBase {
  readonly kind: 'break' | 'continue' | 'pass';
}

export interface PyDef extends PyNodeBase {
  readonly kind: 'def';
  readonly name: string;
  readonly params: readonly PyParam[];
  readonly body: readonly PyStmt[];
}

export interface PyReturn extends PyNodeBase {
  readonly kind: 'return';
  readonly value?: PyExpr;
}

/** `import a.b as c`: `name` is the dotted module name. */
export interface PyAlias {
  readonly name: string;
  readonly asname?: string;
  readonly span: SourceSpan;
}

export interface PyImport extends PyNodeBase {
  readonly kind: 'import';
  readonly names: readonly PyAlias[];
}

export interface PyImportFrom extends PyNodeBase {
  readonly kind: 'importfrom';
  readonly module: string;
  readonly names: readonly PyAlias[];
}

export interface PyExceptHandler {
  /** Absent for a bare `except:`. */
  readonly type?: PyExpr;
  readonly name?: string;
  readonly body: readonly PyStmt[];
  readonly span: SourceSpan;
}

export interface PyTry extends PyNodeBase {
  readonly kind: 'try';
  readonly body: readonly PyStmt[];
  readonly handlers: readonly PyExceptHandler[];
  readonly orelse: readonly PyStmt[];
  readonly finalbody: readonly PyStmt[];
}

export interface PyRaise extends PyNodeBase {
  readonly kind: 'raise';
  readonly exc?: PyExpr;
}

export interface PyGlobal extends PyNodeBase {
  readonly kind: 'global';
  readonly names: readonly string[];
}

export interface PyDel extends PyNodeBase {
  readonly kind: 'del';
  readonly targets: readonly PyTarget[];
}

export interface PyAssert extends PyNodeBase {
  readonly kind: 'assert';
  readonly test: PyExpr;
  readonly msg?: PyExpr;
}

export type PyStmt =
  | PyExprStmt
  | PyAssign
  | PyAugAssign
  | PyIf
  | PyWhile
  | PyFor
  | PySimpleStmt
  | PyDef
  | PyReturn
  | PyImport
  | PyImportFrom
  | PyTry
  | PyRaise
  | PyGlobal
  | PyDel
  | PyAssert;

export interface PyModule extends PyNodeBase {
  readonly kind: 'module';
  readonly body: readonly PyStmt[];
}

export type PyParseResult = { readonly ok: true; readonly module: PyModule } | { readonly ok: false; readonly error: PySyntaxError };

/** Deepest nesting of expressions or blocks the parser accepts. */
export const PY_MAX_NESTING = 100;

// ── the parser ───────────────────────────────────────────────────────────────

class ParseFail extends Error {
  constructor(readonly at: SourcePos, message: string, readonly type: PySyntaxErrorType = 'SyntaxError', readonly to?: SourcePos) {
    super(message);
  }
}

const AUG_OPS: Readonly<Record<string, PyBinaryOp>> = {
  '+=': '+', '-=': '-', '*=': '*', '/=': '/', '//=': '//', '%=': '%', '**=': '**', '<<=': '<<', '>>=': '>>', '&=': '&', '|=': '|', '^=': '^',
};

/** Words that start a statement NF-Py does not have, with the reason given. */
const UNSUPPORTED_STATEMENTS: Readonly<Record<string, string>> = {
  class: 'Classes are not part of NF-Py; use functions, dicts and lists.',
  with: '"with" is not part of NF-Py.',
  async: '"async" is not part of NF-Py.',
  await: '"await" is not part of NF-Py.',
  yield: '"yield" is not part of NF-Py.',
  nonlocal: '"nonlocal" is not part of NF-Py.',
};

/** Tokens after which an expression cannot continue (the end of a tuple display without parentheses). */
const EXPRESSION_ENDS = new Set([')', ']', '}', '=', ':', ';', ...Object.keys(AUG_OPS)]);

class Parser {
  private k = 0;
  private prevEnd: SourcePos;
  private loops = 0;
  private functions = 0;
  private depth = 0;

  /**
   * @param endOfInput what the last token closes, for messages: a program ends at the end of the text; an f-string
   *   field at its `}` or `:`; a lone expression at its end.
   */
  constructor(
    private readonly toks: readonly PyToken[],
    private readonly src: string,
    private readonly pos: (offset: number) => SourcePos,
    private readonly lexErrors: readonly PySyntaxError[],
    private readonly endOfInput: 'program' | 'field' | 'expression' = 'program',
  ) {
    this.prevEnd = toks[0]?.start ?? pos(0);
  }

  // ── token helpers ──

  private peek(n = 0): PyToken {
    return this.toks[Math.min(this.k + n, this.toks.length - 1)] as PyToken;
  }

  private next(): PyToken {
    const t = this.peek();
    if (t.kind === 'error') this.lexError(t);
    if (this.k < this.toks.length - 1) this.k++;
    this.prevEnd = t.end;
    return t;
  }

  /** Reaching a token the lexer could not read reports the lexer's error. */
  private lexError(t: PyToken): never {
    const e = this.lexErrors.find((x) => x.offset >= t.start.offset && x.offset < Math.max(t.end.offset, t.start.offset + 1)) ?? this.lexErrors[0];
    if (e !== undefined) throw new ParseFail({ line: e.line, column: e.column, offset: e.offset }, e.message, e.type);
    throw new ParseFail(t.start, 'This text cannot be read as NF-Py.');
  }

  private isOp(text: string, n = 0): boolean {
    const t = this.peek(n);
    return t.kind === 'op' && t.text === text;
  }

  private isKw(text: string, n = 0): boolean {
    const t = this.peek(n);
    return t.kind === 'keyword' && t.text === text;
  }

  private acceptOp(text: string): boolean {
    if (!this.isOp(text)) return false;
    this.next();
    return true;
  }

  private acceptKw(text: string): boolean {
    if (!this.isKw(text)) return false;
    this.next();
    return true;
  }

  private expectOp(text: string, message: string): PyToken {
    if (!this.isOp(text)) this.fail(this.peek(), message);
    return this.next();
  }

  private fail(t: PyToken, message: string, type: PySyntaxErrorType = 'SyntaxError'): never {
    if (t.kind === 'error') this.lexError(t);
    throw new ParseFail(t.start, message, type, t.end.offset > t.start.offset ? t.end : undefined);
  }

  private span(start: SourcePos): SourceSpan {
    return { start, end: this.prevEnd };
  }

  private nest<T>(t: PyToken, f: () => T): T {
    this.depth++;
    if (this.depth > PY_MAX_NESTING) this.fail(t, `This program nests more than ${PY_MAX_NESTING} levels deep.`);
    try {
      return f();
    } finally {
      this.depth--;
    }
  }

  private describe(t: PyToken): string {
    switch (t.kind) {
      case 'newline':
        return 'the end of the line';
      case 'eof':
        return this.endOfInput === 'program' ? 'the end of the program' : this.endOfInput === 'field' ? 'the end of the f-string field' : 'the end of the expression';
      case 'indent':
        return 'an indented line';
      case 'dedent':
        return 'the end of the block';
      default:
        return `"${t.text}"`;
    }
  }

  // ── module and statements ──

  module(): PyModule {
    const start = this.peek().start;
    const body: PyStmt[] = [];
    for (;;) {
      const t = this.peek();
      if (t.kind === 'eof') break;
      if (t.kind === 'newline') {
        this.next();
        continue;
      }
      if (t.kind === 'indent') this.fail(t, 'This line is indented, but nothing above opens a block; remove the indentation.', 'IndentationError');
      body.push(...this.statement());
    }
    return { kind: 'module', body, span: { start, end: this.peek().end } };
  }

  private statement(): PyStmt[] {
    const t = this.peek();
    if (t.kind === 'keyword') {
      switch (t.text) {
        case 'if':
          return [this.ifStatement()];
        case 'while':
          return [this.whileStatement()];
        case 'for':
          return [this.forStatement()];
        case 'def':
          return [this.defStatement()];
        case 'try':
          return [this.tryStatement()];
        case 'elif':
        case 'else':
          this.fail(t, `"${t.text}" must follow an "if" block${t.text === 'else' ? ' (or a try block)' : ''} at the same indentation.`);
          break;
        case 'except':
        case 'finally':
          this.fail(t, `"${t.text}" must follow a "try" block at the same indentation.`);
          break;
        default: {
          const why = UNSUPPORTED_STATEMENTS[t.text];
          if (why !== undefined) this.fail(t, why);
        }
      }
    }
    if (this.isOp('@')) this.fail(t, 'Decorators (@…) are not part of NF-Py.');
    if (t.kind === 'indent') this.fail(t, 'This line is indented more than the line above, which does not open a block.', 'IndentationError');
    return this.simpleStatements();
  }

  private simpleStatements(): PyStmt[] {
    const out: PyStmt[] = [this.simpleStatement()];
    while (this.acceptOp(';')) {
      if (this.peek().kind === 'newline' || this.peek().kind === 'eof') break;
      out.push(this.simpleStatement());
    }
    this.endOfStatement();
    return out;
  }

  private endOfStatement(): void {
    const t = this.peek();
    if (t.kind === 'newline') {
      this.next();
      return;
    }
    if (t.kind === 'eof' || t.kind === 'dedent') return;
    if (t.kind === 'op' && t.text === '=') this.fail(t, 'This cannot be assigned to.');
    this.fail(t, `Unexpected ${this.describe(t)}: is an operator or a comma missing before it?`);
  }

  private simpleStatement(): PyStmt {
    const t = this.peek();
    const start = t.start;
    if (t.kind === 'keyword') {
      switch (t.text) {
        case 'pass':
          this.next();
          return { kind: 'pass', span: this.span(start) };
        case 'break':
        case 'continue':
          this.next();
          if (this.loops === 0) this.fail(t, `"${t.text}" can only be used inside a loop.`);
          return { kind: t.text, span: this.span(start) };
        case 'return': {
          this.next();
          if (this.functions === 0) this.fail(t, '"return" can only be used inside a function.');
          if (this.atStatementEnd()) return { kind: 'return', span: this.span(start) };
          return { kind: 'return', value: this.expressions(), span: this.span(start) };
        }
        case 'raise': {
          this.next();
          if (this.atStatementEnd()) return { kind: 'raise', span: this.span(start) };
          const exc = this.expression();
          if (this.isKw('from')) this.fail(this.peek(), '"raise … from …" is not part of NF-Py.');
          return { kind: 'raise', exc, span: this.span(start) };
        }
        case 'global': {
          this.next();
          const names = [this.name('a variable name after "global"')];
          while (this.acceptOp(',')) names.push(this.name('a variable name'));
          return { kind: 'global', names, span: this.span(start) };
        }
        case 'del': {
          this.next();
          const list = this.expressions();
          const items = list.kind === 'tuple' && !this.parenthesized(list) ? list.items : [list];
          return { kind: 'del', targets: items.map((e) => this.target(e, 'delete')), span: this.span(start) };
        }
        case 'assert': {
          this.next();
          const test = this.expression();
          const msg = this.acceptOp(',') ? this.expression() : undefined;
          return { kind: 'assert', test, ...(msg !== undefined ? { msg } : {}), span: this.span(start) };
        }
        case 'import':
          return this.importStatement();
        case 'from':
          return this.fromStatement();
        default:
          break;
      }
    }
    const first = this.expressions();
    if (first.kind === 'name' && (first.id === 'print' || first.id === 'exec') && this.startsExpression(this.peek())) {
      this.fail(this.peek(), `In Python 3 ${first.id} is a function: write ${first.id}(…) with parentheses.`);
    }
    if (this.isOp('=')) {
      const parts: PyExpr[] = [first];
      while (this.acceptOp('=')) {
        if (this.isKw('yield')) this.fail(this.peek(), '"yield" is not part of NF-Py.');
        if (this.atStatementEnd()) this.fail(this.peek(), 'A value is missing after "=".');
        parts.push(this.expressions());
      }
      const value = parts.pop() as PyExpr;
      return { kind: 'assign', targets: parts.map((p) => this.target(p, 'assign')), value, span: this.span(start) };
    }
    const aug = this.peek();
    if (aug.kind === 'op' && AUG_OPS[aug.text] !== undefined) {
      this.next();
      const target = this.target(first, 'augment');
      if (target.kind === 'tuple' || target.kind === 'list') this.fail(aug, `"${aug.text}" works on one variable, attribute or item, not on several.`);
      if (this.atStatementEnd()) this.fail(this.peek(), `A value is missing after "${aug.text}".`);
      const value = this.expressions();
      return { kind: 'augassign', target, op: AUG_OPS[aug.text] as PyBinaryOp, value, span: this.span(start) };
    }
    if (this.isOp(':')) this.fail(this.peek(), 'Type annotations are not part of NF-Py.');
    if (this.isOp('@=')) this.fail(this.peek(), 'The "@=" operator is not part of NF-Py.');
    return { kind: 'expr', value: first, span: this.span(start) };
  }

  private atStatementEnd(): boolean {
    const t = this.peek();
    return t.kind === 'newline' || t.kind === 'eof' || t.kind === 'dedent' || (t.kind === 'op' && t.text === ';');
  }

  private name(what: string): string {
    const t = this.peek();
    if (t.kind !== 'name') this.fail(t, t.kind === 'keyword' ? `"${t.text}" is a reserved word and cannot be used as a name.` : `Expected ${what} here.`);
    this.next();
    return t.text;
  }

  private dottedName(what: string): string {
    let n = this.name(what);
    while (this.acceptOp('.')) n += `.${this.name('a name after "."')}`;
    return n;
  }

  private importStatement(): PyImport {
    const start = this.next().start;
    const names: PyAlias[] = [];
    do {
      const s = this.peek().start;
      const name = this.dottedName('a module name after "import"');
      const asname = this.acceptKw('as') ? this.name('a name after "as"') : undefined;
      names.push({ name, ...(asname !== undefined ? { asname } : {}), span: this.span(s) });
    } while (this.acceptOp(','));
    return { kind: 'import', names, span: this.span(start) };
  }

  private fromStatement(): PyImportFrom {
    const start = this.next().start;
    if (this.isOp('.') || this.isOp('...')) this.fail(this.peek(), 'Relative imports (from . import …) are not part of NF-Py.');
    const module = this.dottedName('a module name after "from"');
    if (!this.acceptKw('import')) this.fail(this.peek(), `Expected "import" after "from ${module}".`);
    if (this.isOp('*')) this.fail(this.peek(), '"from … import *" is not part of NF-Py; name what you import.');
    const paren = this.acceptOp('(');
    const names: PyAlias[] = [];
    do {
      if (paren && this.isOp(')')) break;
      const s = this.peek().start;
      const name = this.name('a name to import');
      const asname = this.acceptKw('as') ? this.name('a name after "as"') : undefined;
      names.push({ name, ...(asname !== undefined ? { asname } : {}), span: this.span(s) });
    } while (this.acceptOp(','));
    if (paren) this.expectOp(')', 'Expected ")" to close the list of imported names.');
    if (names.length === 0) this.fail(this.peek(), 'Name at least one thing to import.');
    return { kind: 'importfrom', module, names, span: this.span(start) };
  }

  /** `:` then a block: an indented suite, or simple statements on the same line. */
  private block(header: PyToken, what: string): PyStmt[] {
    if (!this.isOp(':')) {
      const t = this.peek();
      if (t.kind === 'op' && t.text === '=') this.fail(t, 'Use "==" to compare; a single "=" assigns.');
      this.fail(t, `Expected ":" at the end of the "${what}" line.`);
    }
    this.next();
    if (this.peek().kind !== 'newline') return this.nest(header, () => this.simpleStatements());
    this.next();
    if (this.peek().kind !== 'indent') this.fail(this.peek(), `Expected an indented block after the "${what}" on line ${header.start.line}.`, 'IndentationError');
    this.next();
    return this.nest(header, () => {
      const body: PyStmt[] = [];
      while (this.peek().kind !== 'dedent' && this.peek().kind !== 'eof') {
        if (this.peek().kind === 'newline') {
          this.next();
          continue;
        }
        body.push(...this.statement());
      }
      if (this.peek().kind === 'dedent') this.next();
      return body;
    });
  }

  private ifStatement(): PyIf {
    const head = this.next();
    const test = this.namedTest();
    const body = this.block(head, head.text);
    let orelse: PyStmt[] = [];
    if (this.isKw('elif')) orelse = [this.ifStatement()];
    else if (this.isKw('else')) {
      const e = this.next();
      if (this.isKw('if')) this.fail(this.peek(), 'Write "elif" instead of "else if".');
      orelse = this.block(e, 'else');
    }
    return { kind: 'if', test, body, orelse, span: this.span(head.start) };
  }

  /** A condition (`if`, `elif`, `while`), with a hint for `=` written instead of `==`. */
  private namedTest(): PyExpr {
    const test = this.expression();
    if (this.isOp(':=')) this.fail(this.peek(), 'The ":=" operator is not part of NF-Py.');
    return test;
  }

  private whileStatement(): PyWhile {
    const head = this.next();
    const test = this.namedTest();
    this.loops++;
    const saved = this.loops;
    let body: PyStmt[];
    try {
      body = this.block(head, 'while');
    } finally {
      this.loops = saved - 1;
    }
    if (this.isKw('else')) this.fail(this.peek(), '"else" after a loop is not part of NF-Py.');
    return { kind: 'while', test, body, span: this.span(head.start) };
  }

  private forStatement(): PyFor {
    const head = this.next();
    const target = this.targetList();
    if (!this.acceptKw('in')) this.fail(this.peek(), 'Expected "in" after the loop variable ("for x in …").');
    const iter = this.expressions();
    this.loops++;
    const saved = this.loops;
    let body: PyStmt[];
    try {
      body = this.block(head, 'for');
    } finally {
      this.loops = saved - 1;
    }
    if (this.isKw('else')) this.fail(this.peek(), '"else" after a loop is not part of NF-Py.');
    return { kind: 'for', target, iter, body, span: this.span(head.start) };
  }

  private defStatement(): PyDef {
    const head = this.next();
    const name = this.name('a function name after "def"');
    this.expectOp('(', `Expected "(" after the function name "${name}".`);
    const params = this.params(')');
    this.expectOp(')', 'Expected ")" to close the parameter list.');
    if (this.isOp('->')) this.fail(this.peek(), 'Type annotations are not part of NF-Py.');
    const loops = this.loops;
    this.loops = 0;
    this.functions++;
    let body: PyStmt[];
    try {
      body = this.block(head, 'def');
    } finally {
      this.functions--;
      this.loops = loops;
    }
    return { kind: 'def', name, params, body, span: this.span(head.start) };
  }

  /** Parameters up to (not including) `close`: names with optional defaults. */
  private params(close: string): PyParam[] {
    const params: PyParam[] = [];
    let defaults = false;
    while (!this.isOp(close)) {
      const t = this.peek();
      if (t.kind === 'op' && (t.text === '*' || t.text === '**' || t.text === '/')) this.fail(t, '"*args", "**kwargs" and "/" or "*" markers are not part of NF-Py.');
      const name = this.name('a parameter name');
      if (params.some((p) => p.name === name)) this.fail(t, `The parameter "${name}" appears twice.`);
      if (this.isOp(':') && close === ')') this.fail(this.peek(), 'Type annotations are not part of NF-Py.');
      let def: PyExpr | undefined;
      if (this.acceptOp('=')) {
        def = this.expression();
        defaults = true;
      } else if (defaults) this.fail(t, `The parameter "${name}" needs a default value, because a parameter before it has one.`);
      params.push({ name, ...(def !== undefined ? { default: def } : {}), span: this.span(t.start) });
      if (!this.acceptOp(',')) break;
    }
    return params;
  }

  private tryStatement(): PyTry {
    const head = this.next();
    const body = this.block(head, 'try');
    const handlers: PyExceptHandler[] = [];
    while (this.isKw('except')) {
      const h = this.next();
      if (this.isOp('*')) this.fail(this.peek(), '"except*" is not part of NF-Py.');
      if (handlers.length > 0 && handlers[handlers.length - 1]?.type === undefined) this.fail(h, 'A bare "except:" must be the last handler.');
      let type: PyExpr | undefined;
      let name: string | undefined;
      if (!this.isOp(':')) {
        type = this.expression();
        if (this.acceptKw('as')) name = this.name('a name after "as"');
        else if (this.isOp(',')) this.fail(this.peek(), 'To catch several exceptions write them in parentheses: except (A, B):');
      }
      const hbody = this.block(h, 'except');
      handlers.push({ ...(type !== undefined ? { type } : {}), ...(name !== undefined ? { name } : {}), body: hbody, span: this.span(h.start) });
    }
    let orelse: PyStmt[] = [];
    if (this.isKw('else')) {
      const e = this.next();
      if (handlers.length === 0) this.fail(e, '"else" after "try" needs at least one "except" before it.');
      orelse = this.block(e, 'else');
    }
    let finalbody: PyStmt[] = [];
    if (this.isKw('finally')) {
      const f = this.next();
      finalbody = this.block(f, 'finally');
    }
    if (handlers.length === 0 && finalbody.length === 0) this.fail(this.peek(), 'A "try" block needs an "except" or a "finally" after it.');
    return { kind: 'try', body, handlers, orelse, finalbody, span: this.span(head.start) };
  }

  // ── targets ──

  /** Loop and comprehension variables: names (and unpacking) up to `in`. */
  private targetList(): PyTarget {
    const start = this.peek().start;
    const first = this.bitOr();
    if (!this.isOp(',')) return this.target(first, 'for');
    const items: PyExpr[] = [first];
    while (this.acceptOp(',')) {
      if (this.isKw('in')) break;
      items.push(this.bitOr());
    }
    return this.target({ kind: 'tuple', items, span: this.span(start) }, 'for');
  }

  private parenthesized(e: PyExpr): boolean {
    return this.src[e.span.start.offset] === '(';
  }

  /** Checks that an expression can be assigned to (or deleted), and says why not. */
  private target(e: PyExpr, use: 'assign' | 'augment' | 'for' | 'delete'): PyTarget {
    const verb = use === 'delete' ? 'delete' : 'assign to';
    switch (e.kind) {
      case 'name':
        return e;
      case 'attribute':
      case 'subscript':
        return e;
      case 'tuple':
      case 'list':
        if (use === 'augment') return e;
        for (const item of e.items) this.target(item, use);
        return e;
      case 'const':
        throw new ParseFail(e.span.start, e.type === 'none' || e.type === 'bool' ? `Cannot ${verb} ${String(e.value === null ? 'None' : e.value ? 'True' : 'False')}.` : `Cannot ${verb} a literal value.${use === 'assign' ? ' To compare, use "==".' : ''}`, 'SyntaxError', e.span.end);
      case 'call':
        throw new ParseFail(e.span.start, `Cannot ${verb} a function call.`, 'SyntaxError', e.span.end);
      default:
        throw new ParseFail(e.span.start, `Cannot ${verb} this expression.${use === 'assign' && e.kind === 'compare' ? ' To compare, use "==".' : ''}`, 'SyntaxError', e.span.end);
    }
  }

  // ── expressions ──

  private startsExpression(t: PyToken): boolean {
    if (t.kind === 'name' || t.kind === 'number' || t.kind === 'string' || t.kind === 'fstring') return true;
    if (t.kind === 'keyword') return ['True', 'False', 'None', 'not', 'lambda'].includes(t.text);
    return t.kind === 'op' && ['(', '[', '{', '-', '+', '~'].includes(t.text);
  }

  /** One expression, or several separated by commas (a tuple without parentheses). */
  expressions(): PyExpr {
    const start = this.peek().start;
    const first = this.expression();
    if (!this.isOp(',')) return first;
    const items: PyExpr[] = [first];
    while (this.acceptOp(',')) {
      const t = this.peek();
      if (t.kind === 'newline' || t.kind === 'eof' || (t.kind === 'op' && EXPRESSION_ENDS.has(t.text)) || (t.kind === 'keyword' && t.text === 'in')) break;
      items.push(this.expression());
    }
    return { kind: 'tuple', items, span: this.span(start) };
  }

  expression(): PyExpr {
    const t = this.peek();
    return this.nest(t, () => {
      if (this.isKw('lambda')) return this.lambda();
      if (this.isKw('yield')) this.fail(t, '"yield" is not part of NF-Py.');
      if (this.isKw('await')) this.fail(t, '"await" is not part of NF-Py.');
      const body = this.disjunction();
      if (!this.isKw('if')) return body;
      this.next();
      const test = this.disjunction();
      if (!this.acceptKw('else')) this.fail(this.peek(), 'A conditional expression needs "else": value_if_true if condition else value_if_false.');
      const orelse = this.expression();
      return { kind: 'ifexp', test, body, orelse, span: this.span(t.start) };
    });
  }

  private lambda(): PyLambda {
    const head = this.next();
    const params = this.params(':');
    this.expectOp(':', 'Expected ":" after the parameters of "lambda".');
    const loops = this.loops;
    this.loops = 0;
    const body = this.expression();
    this.loops = loops;
    return { kind: 'lambda', params, body, span: this.span(head.start) };
  }

  private disjunction(): PyExpr {
    const start = this.peek().start;
    const first = this.conjunction();
    if (!this.isKw('or')) return first;
    const values = [first];
    while (this.acceptKw('or')) values.push(this.conjunction());
    return { kind: 'boolop', op: 'or', values, span: this.span(start) };
  }

  private conjunction(): PyExpr {
    const start = this.peek().start;
    const first = this.inversion();
    if (!this.isKw('and')) return first;
    const values = [first];
    while (this.acceptKw('and')) values.push(this.inversion());
    return { kind: 'boolop', op: 'and', values, span: this.span(start) };
  }

  private inversion(): PyExpr {
    const t = this.peek();
    if (this.acceptKw('not')) {
      const operand = this.nest(t, () => this.inversion());
      return { kind: 'unary', op: 'not', operand, span: this.span(t.start) };
    }
    return this.comparison();
  }

  private comparison(): PyExpr {
    const start = this.peek().start;
    const left = this.bitOr();
    const ops: PyCompareOp[] = [];
    const comparators: PyExpr[] = [];
    for (;;) {
      const t = this.peek();
      let op: PyCompareOp | undefined;
      if (t.kind === 'op' && ['==', '!=', '<', '<=', '>', '>='].includes(t.text)) {
        this.next();
        op = t.text as PyCompareOp;
      } else if (this.isKw('in')) {
        this.next();
        op = 'in';
      } else if (this.isKw('not') && this.isKw('in', 1)) {
        this.next();
        this.next();
        op = 'not in';
      } else if (this.isKw('is')) {
        this.next();
        op = this.acceptKw('not') ? 'is not' : 'is';
      }
      if (op === undefined) break;
      ops.push(op);
      comparators.push(this.bitOr());
    }
    if (ops.length === 0) return left;
    return { kind: 'compare', left, ops, comparators, span: this.span(start) };
  }

  private binaryLevel(ops: readonly string[], operand: () => PyExpr): PyExpr {
    const start = this.peek().start;
    let left = operand();
    for (;;) {
      const t = this.peek();
      if (t.kind !== 'op' || !ops.includes(t.text)) return left;
      this.next();
      const right = operand();
      left = { kind: 'binary', op: t.text as PyBinaryOp, left, right, span: this.span(start) };
    }
  }

  private bitOr(): PyExpr {
    return this.binaryLevel(['|'], () => this.bitXor());
  }

  private bitXor(): PyExpr {
    return this.binaryLevel(['^'], () => this.bitAnd());
  }

  private bitAnd(): PyExpr {
    return this.binaryLevel(['&'], () => this.shift());
  }

  private shift(): PyExpr {
    return this.binaryLevel(['<<', '>>'], () => this.sum());
  }

  private sum(): PyExpr {
    return this.binaryLevel(['+', '-'], () => this.term());
  }

  private term(): PyExpr {
    const e = this.binaryLevel(['*', '/', '//', '%'], () => this.factor());
    if (this.isOp('@')) this.fail(this.peek(), 'The "@" operator is not part of NF-Py.');
    return e;
  }

  private factor(): PyExpr {
    const t = this.peek();
    if (t.kind === 'op' && (t.text === '-' || t.text === '+' || t.text === '~')) {
      this.next();
      const operand = this.nest(t, () => this.factor());
      return { kind: 'unary', op: t.text as PyUnaryOp, operand, span: this.span(t.start) };
    }
    return this.power();
  }

  private power(): PyExpr {
    const start = this.peek().start;
    const base = this.primary();
    if (!this.isOp('**')) return base;
    const t = this.next();
    const exponent = this.nest(t, () => this.factor());
    return { kind: 'binary', op: '**', left: base, right: exponent, span: this.span(start) };
  }

  private primary(): PyExpr {
    const start = this.peek().start;
    let e = this.atom();
    for (;;) {
      if (this.isOp('.')) {
        this.next();
        const t = this.peek();
        if (t.kind !== 'name' && t.kind !== 'keyword') this.fail(t, 'Expected a name after ".".');
        this.next();
        e = { kind: 'attribute', value: e, attr: t.text, span: this.span(start) };
        continue;
      }
      if (this.isOp('(')) {
        const open = this.next();
        e = this.nest(open, () => this.call(e, start));
        continue;
      }
      if (this.isOp('[')) {
        const open = this.next();
        const index = this.nest(open, () => this.subscript());
        this.expectOp(']', 'Expected "]" to close the index.');
        e = { kind: 'subscript', value: e, index, span: this.span(start) };
        continue;
      }
      return e;
    }
  }

  private call(func: PyExpr, start: SourcePos): PyCall {
    const args: PyExpr[] = [];
    const keywords: PyKeyword[] = [];
    while (!this.isOp(')')) {
      const t = this.peek();
      if (t.kind === 'op' && (t.text === '*' || t.text === '**')) this.fail(t, `Unpacking arguments with "${t.text}" is not part of NF-Py.`);
      if (t.kind === 'name' && this.isOp('=', 1)) {
        this.next();
        this.next();
        if (keywords.some((k) => k.name === t.text)) this.fail(t, `The keyword argument "${t.text}" is given twice.`);
        const value = this.expression();
        keywords.push({ name: t.text, value, span: this.span(t.start) });
      } else {
        let value = this.expression();
        if (this.isKw('for')) {
          if (args.length > 0 || keywords.length > 0 || !this.isComprehensionAlone()) this.fail(t, 'A generator expression as an argument needs its own parentheses unless it is the only argument.');
          value = this.comprehension('generator', value, undefined, t.start);
        }
        if (keywords.length > 0) this.fail(t, 'A positional argument cannot follow a keyword argument.');
        args.push(value);
      }
      if (!this.acceptOp(',')) break;
    }
    this.expectOp(')', `Expected "," or ")" in the call; found ${this.describe(this.peek())}.`);
    return { kind: 'call', func, args, keywords, span: this.span(start) };
  }

  /** Whether a `for` clause here runs to the closing `)` of the call (so the generator is the only argument). */
  private isComprehensionAlone(): boolean {
    let depth = 0;
    for (let n = 0; ; n++) {
      const t = this.peek(n);
      if (t.kind === 'eof') return false;
      if (t.kind !== 'op') continue;
      if (t.text === '(' || t.text === '[' || t.text === '{') depth++;
      else if (t.text === ')' || t.text === ']' || t.text === '}') {
        if (depth === 0) return t.text === ')';
        depth--;
      } else if (t.text === ',' && depth === 0) return false;
    }
  }

  private subscript(): PyExpr | PySlice {
    const start = this.peek().start;
    const lower = this.isOp(':') ? undefined : this.expression();
    if (!this.isOp(':')) {
      if (!this.isOp(',') || lower === undefined) return lower as PyExpr;
      const items: PyExpr[] = [lower];
      while (this.acceptOp(',')) {
        if (this.isOp(']')) break;
        items.push(this.expression());
        if (this.isOp(':')) this.fail(this.peek(), 'Slices inside a tuple index are not part of NF-Py.');
      }
      return { kind: 'tuple', items, span: this.span(start) };
    }
    this.next();
    const upper = this.isOp(':') || this.isOp(']') ? undefined : this.expression();
    let step: PyExpr | undefined;
    if (this.acceptOp(':')) step = this.isOp(']') ? undefined : this.expression();
    if (this.isOp(',')) this.fail(this.peek(), 'Slices inside a tuple index are not part of NF-Py.');
    return {
      kind: 'slice',
      ...(lower !== undefined ? { lower } : {}),
      ...(upper !== undefined ? { upper } : {}),
      ...(step !== undefined ? { step } : {}),
      span: this.span(start),
    };
  }

  private atom(): PyExpr {
    const t = this.peek();
    switch (t.kind) {
      case 'name':
        this.next();
        return { kind: 'name', id: t.text, span: this.span(t.start) };
      case 'number':
        this.next();
        return { kind: 'const', type: t.numberType === 'float' ? 'float' : 'int', value: t.value as number, span: this.span(t.start) };
      case 'string':
      case 'fstring':
        return this.strings();
      case 'keyword':
        if (t.text === 'True' || t.text === 'False') {
          this.next();
          return { kind: 'const', type: 'bool', value: t.text === 'True', span: this.span(t.start) };
        }
        if (t.text === 'None') {
          this.next();
          return { kind: 'const', type: 'none', value: null, span: this.span(t.start) };
        }
        if (t.text === 'lambda') return this.lambda();
        if (UNSUPPORTED_STATEMENTS[t.text] !== undefined && t.text !== 'class' && t.text !== 'with') this.fail(t, UNSUPPORTED_STATEMENTS[t.text] as string);
        this.fail(t, `"${t.text}" is a reserved word and cannot be used here.`);
        break;
      case 'op':
        if (t.text === '(') return this.parens();
        if (t.text === '[') return this.listDisplay();
        if (t.text === '{') return this.braceDisplay();
        if (t.text === '...') this.fail(t, '"..." is not part of NF-Py; use "pass" for an empty block.');
        if (t.text === '*' || t.text === '**') this.fail(t, 'Starred expressions are not part of NF-Py.');
        break;
      default:
        break;
    }
    if (t.kind === 'indent') this.fail(t, 'Unexpected indentation.', 'IndentationError');
    const lineEnds = t.kind === 'newline' || (t.kind === 'eof' && this.endOfInput === 'program');
    this.fail(t, lineEnds ? 'The line ends where a value is expected.' : `Expected a value here, found ${this.describe(t)}.`);
  }

  private parens(): PyExpr {
    const open = this.next();
    return this.nest(open, () => {
      if (this.acceptOp(')')) return { kind: 'tuple', items: [], span: this.span(open.start) } as PyTuple;
      if (this.isKw('yield')) this.fail(this.peek(), '"yield" is not part of NF-Py.');
      const first = this.expression();
      if (this.isKw('for')) {
        const g = this.comprehension('generator', first, undefined, open.start);
        this.expectOp(')', 'Expected ")" to close the generator expression.');
        return { ...g, span: this.span(open.start) };
      }
      if (this.isOp(':=')) this.fail(this.peek(), 'The ":=" operator is not part of NF-Py.');
      if (!this.isOp(',')) {
        this.expectOp(')', `Expected ")" here, found ${this.describe(this.peek())}.`);
        return first;
      }
      const items: PyExpr[] = [first];
      while (this.acceptOp(',')) {
        if (this.isOp(')')) break;
        items.push(this.expression());
      }
      this.expectOp(')', `Expected "," or ")" here, found ${this.describe(this.peek())}.`);
      return { kind: 'tuple', items, span: this.span(open.start) };
    });
  }

  private listDisplay(): PyExpr {
    const open = this.next();
    return this.nest(open, () => {
      if (this.acceptOp(']')) return { kind: 'list', items: [], span: this.span(open.start) } as PyList;
      const first = this.expression();
      if (this.isKw('for')) {
        const c = this.comprehension('list', first, undefined, open.start);
        this.expectOp(']', 'Expected "]" to close the list comprehension.');
        return { ...c, span: this.span(open.start) };
      }
      const items: PyExpr[] = [first];
      while (this.acceptOp(',')) {
        if (this.isOp(']')) break;
        items.push(this.expression());
      }
      this.expectOp(']', `Expected "," or "]" in the list, found ${this.describe(this.peek())}.`);
      return { kind: 'list', items, span: this.span(open.start) };
    });
  }

  private braceDisplay(): PyExpr {
    const open = this.next();
    return this.nest(open, () => {
      if (this.acceptOp('}')) return { kind: 'dict', entries: [], span: this.span(open.start) } as PyDict;
      if (this.isOp('**')) this.fail(this.peek(), 'Unpacking a dict with "**" is not part of NF-Py.');
      const first = this.expression();
      if (this.acceptOp(':')) {
        const value = this.expression();
        if (this.isKw('for')) {
          const c = this.comprehension('dict', first, value, open.start);
          this.expectOp('}', 'Expected "}" to close the dict comprehension.');
          return { ...c, span: this.span(open.start) };
        }
        const entries = [{ key: first, value }];
        while (this.acceptOp(',')) {
          if (this.isOp('}')) break;
          if (this.isOp('**')) this.fail(this.peek(), 'Unpacking a dict with "**" is not part of NF-Py.');
          const key = this.expression();
          this.expectOp(':', 'Expected ":" between a key and its value.');
          entries.push({ key, value: this.expression() });
        }
        this.expectOp('}', `Expected "," or "}" in the dict, found ${this.describe(this.peek())}.`);
        return { kind: 'dict', entries, span: this.span(open.start) };
      }
      if (this.isKw('for')) {
        const c = this.comprehension('set', first, undefined, open.start);
        this.expectOp('}', 'Expected "}" to close the set comprehension.');
        return { ...c, span: this.span(open.start) };
      }
      const items: PyExpr[] = [first];
      while (this.acceptOp(',')) {
        if (this.isOp('}')) break;
        items.push(this.expression());
        if (this.isOp(':')) this.fail(this.peek(), 'Mix of set items and dict entries: give every item a value, or none.');
      }
      this.expectOp('}', `Expected "," or "}" in the set, found ${this.describe(this.peek())}.`);
      return { kind: 'set', items, span: this.span(open.start) };
    });
  }

  private comprehension(type: PyComp['type'], elt: PyExpr, value: PyExpr | undefined, start: SourcePos): PyComp {
    const generators: PyComprehension[] = [];
    const loops = this.loops;
    this.loops = 0;
    while (this.isKw('for')) {
      this.next();
      if (this.isKw('async')) this.fail(this.peek(), '"async" is not part of NF-Py.');
      const target = this.targetList();
      if (!this.acceptKw('in')) this.fail(this.peek(), 'Expected "in" in the comprehension ("for x in …").');
      const iter = this.disjunction();
      const ifs: PyExpr[] = [];
      while (this.acceptKw('if')) ifs.push(this.disjunction());
      generators.push({ target, iter, ifs });
    }
    this.loops = loops;
    return { kind: 'comp', type, elt, ...(value !== undefined ? { value } : {}), generators, span: this.span(start) };
  }

  /** Adjacent string literals, joined; an f-string among them makes the whole an f-string. */
  private strings(): PyExpr {
    const start = this.peek().start;
    const toks: PyToken[] = [];
    while (this.peek().kind === 'string' || this.peek().kind === 'fstring') toks.push(this.next());
    if (toks.every((t) => t.kind === 'string')) {
      return { kind: 'const', type: 'str', value: toks.map((t) => t.value as string).join(''), span: this.span(start) };
    }
    const parts: PyFString['parts'][number][] = [];
    const addText = (value: string): void => {
      if (value === '') return;
      const last = parts[parts.length - 1];
      if (last !== undefined && last.kind === 'text') parts[parts.length - 1] = { kind: 'text', value: last.value + value };
      else parts.push({ kind: 'text', value });
    };
    for (const t of toks) {
      if (t.kind === 'string') {
        addText(t.value as string);
        continue;
      }
      for (const p of t.parts ?? []) {
        if (p.kind === 'text') addText(p.value);
        else parts.push(this.field(p));
      }
    }
    return { kind: 'fstring', parts, span: this.span(start) };
  }

  /** Parses the expression of an f-string field from its place in the source. */
  private field(p: Extract<PyFStringToken, { kind: 'field' }>): PyFStringField {
    const lexed = lexPyExpression(this.src, p.from, p.to, this.pos);
    const sub = new Parser(lexed.tokens, this.src, this.pos, lexed.errors, 'field');
    sub.depth = this.depth;
    const expr = sub.parseAll(() => sub.expressions(), 'the f-string field');
    return { kind: 'field', expr, ...(p.conversion !== undefined ? { conversion: p.conversion } : {}), ...(p.spec !== undefined ? { spec: p.spec } : {}) };
  }

  /** Runs `f` and requires that it consumed every token (a sub-expression). */
  parseAll<T>(f: () => T, what: string): T {
    const v = f();
    const t = this.peek();
    if (t.kind !== 'eof') this.fail(t, `Unexpected ${this.describe(t)} in ${what}.`);
    return v;
  }
}

function toError(e: ParseFail): PySyntaxError {
  return {
    type: e.type, message: e.message, line: e.at.line, column: e.at.column, offset: e.at.offset,
    ...(e.to !== undefined && e.to.offset > e.at.offset ? { endLine: e.to.line, endColumn: e.to.column } : {}),
  };
}

/**
 * Parses an NF-Py program. The first error in source order is reported — a tokenizer problem (an unclosed string or
 * bracket, a bad indentation) or a grammar one — with Python's error class.
 */
export function parsePy(source: string): PyParseResult {
  const pos = textPositions(source);
  const lexed = lexPy(source);
  const tokens = lexed.tokens.filter((t) => t.kind !== 'comment');
  const parser = new Parser(tokens, source, pos, lexed.errors);
  let parseError: PySyntaxError | undefined;
  let module: PyModule | undefined;
  try {
    module = parser.module();
  } catch (e) {
    if (!(e instanceof ParseFail)) throw e;
    parseError = toError(e);
  }
  const lexFirst = lexed.errors[0];
  if (lexFirst !== undefined && (parseError === undefined || lexFirst.offset <= parseError.offset)) return { ok: false, error: lexFirst };
  if (parseError !== undefined) return { ok: false, error: parseError };
  return { ok: true, module: module as PyModule };
}

/** Parses one expression (a REPL line, a watch in the workspace). */
export function parsePyExpression(source: string): { readonly ok: true; readonly expr: PyExpr } | { readonly ok: false; readonly error: PySyntaxError } {
  const pos = textPositions(source);
  const lexed = lexPyExpression(source, 0, source.length, pos);
  const parser = new Parser(lexed.tokens.filter((t) => t.kind !== 'comment'), source, pos, lexed.errors, 'expression');
  try {
    const expr = parser.parseAll(() => parser.expressions(), 'the expression');
    const lexFirst = lexed.errors[0];
    if (lexFirst !== undefined) return { ok: false, error: lexFirst };
    return { ok: true, expr };
  } catch (e) {
    if (!(e instanceof ParseFail)) throw e;
    const err = toError(e);
    const lexFirst = lexed.errors[0];
    return { ok: false, error: lexFirst !== undefined && lexFirst.offset <= err.offset ? lexFirst : err };
  }
}
