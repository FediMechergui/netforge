/**
 * The NF-Py tokenizer (ARCHITECTURE-P3 D21 "[S32] NF-Py", §7 W1 auto [S32]).
 *
 * NF-Py is a teaching subset of Python 3 written in the engine. This file turns source text into tokens with their
 * positions; `parser.ts` builds the syntax tree the W2 compiler consumes. Pure and dependency-free, exported through
 * `@netforge/engine/pure`: the automation workspace's highlighter and live syntax marks run it on every keystroke, so
 * it never throws — an unreadable character becomes an `error` token and the lexing goes on, with every problem listed
 * in `errors` (the parser reports the first).
 *
 * WHAT IT READS (Python 3 lexical rules, restricted):
 *  - names (Unicode letters, digits, `_`) and the Python 3 keywords;
 *  - integers (decimal without leading zeros, `0x`, `0o`, `0b`, `_` between digits) up to 2^53 − 1, the range NF-Py
 *    integers are exact in; floats (`1.5`, `.5`, `5.`, `1e-3`);
 *  - strings with the `r`, `u` and `f` prefixes (any case, `rf`/`fr`), in single, double and triple quotes, with the
 *    Python escapes (an unknown escape keeps its backslash, as Python does); an f-string becomes one `fstring` token
 *    whose replacement fields (`{expr!r:>8}`) are located in the source, so the parser reads their expressions with
 *    exact positions;
 *  - operators and delimiters; comments; explicit (`\`) and implicit (inside brackets) line joining;
 *  - indentation as INDENT/DEDENT tokens, with Python's rule for tabs (TabError when tabs and spaces disagree).
 * Refused with a message that says so: bytes literals, complex numbers (`1j`), `\N{…}` escapes, nested replacement
 * fields in an f-string's format spec, and characters Python does not accept.
 */
import { textPositions, type SourcePos } from '../data/json.js';

export type PyTokenKind =
  | 'name'
  | 'keyword'
  | 'number'
  | 'string'
  | 'fstring'
  | 'op'
  | 'comment'
  | 'newline'
  | 'indent'
  | 'dedent'
  | 'eof'
  | 'error';

/** One piece of an f-string: literal text, or a replacement field whose expression is at `[from, to)` of the source. */
export type PyFStringToken =
  | { readonly kind: 'text'; readonly value: string }
  | {
      readonly kind: 'field';
      /** Offsets of the expression text in the source (the parser lexes exactly that range). */
      readonly from: number;
      readonly to: number;
      readonly conversion?: 's' | 'r' | 'a';
      /** The format spec after `:`, escapes decoded (no nested fields in NF-Py). */
      readonly spec?: string;
    };

export interface PyToken {
  readonly kind: PyTokenKind;
  /** The source text of the token (empty for indent, dedent and eof). */
  readonly text: string;
  readonly start: SourcePos;
  readonly end: SourcePos;
  /** `number`: its value; `string`: the decoded text. */
  readonly value?: number | string;
  /** `number`: int or float. */
  readonly numberType?: 'int' | 'float';
  /** `fstring`: its pieces, in order. */
  readonly parts?: readonly PyFStringToken[];
}

export type PySyntaxErrorType = 'SyntaxError' | 'IndentationError' | 'TabError';

/** A syntax error as NF-Py reports it: the Python error class, an original message, and where (1-based). */
export interface PySyntaxError {
  readonly type: PySyntaxErrorType;
  readonly message: string;
  readonly line: number;
  readonly column: number;
  readonly offset: number;
  /** Where the marked text ends (exclusive), when the error covers more than one character. */
  readonly endLine?: number;
  readonly endColumn?: number;
}

export interface PyLexResult {
  readonly tokens: readonly PyToken[];
  /** Every problem found, in source order (empty for a valid program). */
  readonly errors: readonly PySyntaxError[];
}

/** The Python 3 keywords (soft keywords such as `match` are names). */
export const PY_KEYWORDS: readonly string[] = Object.freeze([
  'False', 'None', 'True', 'and', 'as', 'assert', 'async', 'await', 'break', 'class', 'continue', 'def', 'del', 'elif',
  'else', 'except', 'finally', 'for', 'from', 'global', 'if', 'import', 'in', 'is', 'lambda', 'nonlocal', 'not', 'or',
  'pass', 'raise', 'return', 'try', 'while', 'with', 'yield',
]);

/** Operators and delimiters, longest first. */
const OPERATORS: readonly string[] = [
  '**=', '//=', '>>=', '<<=', '...',
  '**', '//', '>>', '<<', '<=', '>=', '==', '!=', '->', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', ':=', '@=',
  '+', '-', '*', '/', '%', '&', '|', '^', '~', '<', '>', '(', ')', '[', ']', '{', '}', ',', ':', '.', ';', '@', '=',
];

const OPENERS: Readonly<Record<string, string>> = { '(': ')', '[': ']', '{': '}' };
const NAME_START = /[\p{L}\p{Nl}_]/u;
const NAME_CHAR = /[\p{L}\p{Nl}\p{Mn}\p{Mc}\p{Nd}\p{Pc}_]/u;
const STRING_PREFIX = /^(?:[rRuUfFbB]|[rR][fFbB]|[fFbB][rR])$/;
const MAX_INT = Number.MAX_SAFE_INTEGER;

class LexFail extends Error {
  constructor(readonly at: number, message: string, readonly type: PySyntaxErrorType = 'SyntaxError', readonly to?: number) {
    super(message);
  }
}

interface Options {
  /** Read `[from, to)` as one expression: no indentation, line breaks are spaces (an f-string field). */
  readonly expression?: { readonly from: number; readonly to: number };
}

class Lexer {
  private i: number;
  private readonly end: number;
  private readonly tokens: PyToken[] = [];
  private readonly errors: PySyntaxError[] = [];
  /** Indentation stack: [columns with tab size 8, columns with tab size 1]. */
  private readonly indents: [number, number][] = [[0, 0]];
  private readonly brackets: { char: string; at: number }[] = [];
  private atLineStart = true;
  private readonly pos: (offset: number) => SourcePos;

  constructor(private readonly src: string, private readonly opts: Options, pos?: (offset: number) => SourcePos) {
    this.pos = pos ?? textPositions(src);
    this.i = opts.expression?.from ?? 0;
    this.end = opts.expression?.to ?? src.length;
    if (opts.expression !== undefined) this.atLineStart = false;
  }

  run(): PyLexResult {
    while (this.i < this.end) {
      try {
        this.step();
      } catch (e) {
        if (!(e instanceof LexFail)) throw e;
        this.fail(e);
      }
    }
    this.finish();
    return { tokens: this.tokens, errors: this.errors };
  }

  /** Records a problem (no token). */
  private record(e: LexFail): void {
    const at = this.pos(e.at);
    const to = e.to !== undefined ? this.pos(e.to) : undefined;
    this.errors.push({
      type: e.type, message: e.message, line: at.line, column: at.column, offset: at.offset,
      ...(to !== undefined && to.offset > at.offset ? { endLine: to.line, endColumn: to.column } : {}),
    });
  }

  /**
   * Records a problem and recovers: the bad text becomes an `error` token and lexing goes on after it. An indentation
   * problem consumes nothing (the line's tokens follow).
   */
  private fail(e: LexFail): void {
    this.record(e);
    if (e.type !== 'SyntaxError') return;
    const stop = Math.min(this.end, Math.max(e.to ?? e.at + 1, e.at + 1));
    this.push('error', e.at, stop);
    this.i = Math.max(this.i, stop);
  }

  private push(kind: PyTokenKind, from: number, to: number, extra: Partial<PyToken> = {}): void {
    this.tokens.push({ kind, text: this.src.slice(from, to), start: this.pos(from), end: this.pos(to), ...extra });
  }

  private step(): void {
    const s = this.src;
    if (this.atLineStart && this.brackets.length === 0 && this.opts.expression === undefined) {
      this.indentation();
      if (this.i >= this.end) return;
    }
    const c = s[this.i] as string;
    if (c === ' ' || c === '\t' || c === '\f') {
      this.i++;
      return;
    }
    if (c === '\r' || c === '\n') {
      const from = this.i;
      this.i += c === '\r' && s[this.i + 1] === '\n' ? 2 : 1;
      if (this.opts.expression !== undefined || this.brackets.length > 0) return;
      const last = this.tokens[this.tokens.length - 1];
      if (last !== undefined && last.kind !== 'newline' && last.kind !== 'indent' && last.kind !== 'dedent' && last.kind !== 'comment') {
        this.push('newline', from, this.i);
      } else if (last?.kind === 'comment' && this.hasCodeOnLine(last)) this.push('newline', from, this.i);
      this.atLineStart = true;
      return;
    }
    if (c === '#') {
      const from = this.i;
      while (this.i < this.end && s[this.i] !== '\n' && s[this.i] !== '\r') this.i++;
      this.push('comment', from, this.i);
      return;
    }
    if (c === '\\') {
      const n = s[this.i + 1];
      if (n === '\n' || n === '\r') {
        this.i += n === '\r' && s[this.i + 2] === '\n' ? 3 : 2;
        if (this.i >= this.end && this.opts.expression === undefined) throw new LexFail(this.i - 1, 'The file ends right after a line-continuation backslash.');
        return;
      }
      throw new LexFail(this.i, 'A backslash outside a string must be the last character of the line (it continues the line).');
    }
    if (c >= '0' && c <= '9') {
      this.number();
      return;
    }
    if (c === '.' && /[0-9]/.test(s[this.i + 1] ?? '')) {
      this.number();
      return;
    }
    if (c === '"' || c === "'") {
      this.string(this.i, '');
      return;
    }
    const cp = s.codePointAt(this.i) as number;
    const ch = String.fromCodePoint(cp);
    if (NAME_START.test(ch)) {
      const from = this.i;
      this.i += ch.length;
      while (this.i < this.end) {
        const d = String.fromCodePoint(s.codePointAt(this.i) as number);
        if (!NAME_CHAR.test(d)) break;
        this.i += d.length;
      }
      const word = s.slice(from, this.i);
      const q = s[this.i];
      if ((q === '"' || q === "'") && STRING_PREFIX.test(word)) {
        this.string(from, word);
        return;
      }
      this.push(PY_KEYWORDS.includes(word) ? 'keyword' : 'name', from, this.i);
      return;
    }
    for (const op of OPERATORS) {
      if (s.startsWith(op, this.i) && this.i + op.length <= this.end) {
        const from = this.i;
        this.i += op.length;
        this.bracket(op, from);
        this.push('op', from, this.i);
        return;
      }
    }
    if (c === '!') throw new LexFail(this.i, '"!" alone is not an operator; "not" negates, and "!=" means "not equal".');
    const hex = cp.toString(16).toUpperCase().padStart(4, '0');
    throw new LexFail(this.i, `The character "${ch}" (U+${hex}) cannot appear in NF-Py code outside a string or a comment.`, 'SyntaxError', this.i + ch.length);
  }

  /** Whether the line of a comment token also holds code (then its line break ends a logical line). */
  private hasCodeOnLine(comment: PyToken): boolean {
    const prev = this.tokens[this.tokens.length - 2];
    return prev !== undefined && prev.end.line === comment.start.line && prev.kind !== 'newline' && prev.kind !== 'indent' && prev.kind !== 'dedent';
  }

  private bracket(op: string, at: number): void {
    if (OPENERS[op] !== undefined) {
      this.brackets.push({ char: op, at });
      return;
    }
    if (op !== ')' && op !== ']' && op !== '}') return;
    const open = this.brackets.pop();
    if (open === undefined) throw new LexFail(at, `This "${op}" closes nothing.`, 'SyntaxError', at + 1);
    if (OPENERS[open.char] !== op) {
      const where = this.pos(open.at);
      throw new LexFail(at, `This "${op}" does not match the "${open.char}" opened on line ${where.line}.`, 'SyntaxError', at + 1);
    }
  }

  /** At a line start outside brackets: measures the indentation, emits INDENT/DEDENT for a line that holds code. */
  private indentation(): void {
    const s = this.src;
    let j = this.i;
    let col8 = 0;
    let col1 = 0;
    for (;;) {
      const c = s[j];
      if (c === ' ') {
        col8++;
        col1++;
      } else if (c === '\t') {
        col8 = (Math.floor(col8 / 8) + 1) * 8;
        col1++;
      } else if (c === '\f') {
        col8 = 0;
        col1 = 0;
      } else break;
      j++;
    }
    const c = s[j];
    this.i = j;
    // Blank and comment-only lines do not change the indentation.
    if (j >= this.end || c === '\n' || c === '\r' || c === '#') {
      if (c === '#') this.atLineStart = false;
      return;
    }
    if (c === '\\' && (s[j + 1] === '\n' || s[j + 1] === '\r')) return;
    this.atLineStart = false;
    const top = this.indents[this.indents.length - 1] as [number, number];
    if (col8 === top[0]) {
      if (col1 !== top[1]) throw new LexFail(j, 'Tabs and spaces are mixed in the indentation in a way that makes it ambiguous; indent with spaces only.', 'TabError');
      return;
    }
    if (col8 > top[0]) {
      if (col1 <= top[1]) throw new LexFail(j, 'Tabs and spaces are mixed in the indentation in a way that makes it ambiguous; indent with spaces only.', 'TabError');
      this.indents.push([col8, col1]);
      this.push('indent', j, j);
      return;
    }
    while ((this.indents[this.indents.length - 1] as [number, number])[0] > col8) {
      this.indents.pop();
      this.push('dedent', j, j);
    }
    const now = this.indents[this.indents.length - 1] as [number, number];
    if (now[0] !== col8) throw new LexFail(j, 'This line\'s indentation matches no enclosing block; line it up with the block it belongs to.', 'IndentationError');
    if (now[1] !== col1) throw new LexFail(j, 'Tabs and spaces are mixed in the indentation in a way that makes it ambiguous; indent with spaces only.', 'TabError');
  }

  private lineStart(at: number): number {
    let j = at;
    while (j > 0 && this.src[j - 1] !== '\n' && this.src[j - 1] !== '\r') j--;
    return j;
  }

  private finish(): void {
    if (this.brackets.length > 0) {
      const open = this.brackets[0] as { char: string; at: number };
      this.record(new LexFail(open.at, `This "${open.char}" is never closed.`, 'SyntaxError', open.at + 1));
      this.brackets.length = 0;
    }
    const at = this.end;
    if (this.opts.expression === undefined) {
      const last = this.tokens[this.tokens.length - 1];
      if (last !== undefined && last.kind !== 'newline' && last.kind !== 'dedent' && last.kind !== 'indent' && !(last.kind === 'comment' && !this.hasCodeOnLine(last))) {
        this.push('newline', at, at);
      }
      while (this.indents.length > 1) {
        this.indents.pop();
        this.push('dedent', at, at);
      }
    }
    this.push('eof', at, at);
  }

  // ── numbers ──

  private number(): void {
    const s = this.src;
    const from = this.i;
    const digits = (re: RegExp): string => {
      const start = this.i;
      while (this.i < this.end && (re.test(s[this.i] as string) || (s[this.i] === '_' && re.test(s[this.i + 1] ?? '') && this.i > start))) this.i++;
      return s.slice(start, this.i);
    };
    const radix = s[this.i] === '0' ? (s[this.i + 1] ?? '').toLowerCase() : '';
    if (radix === 'x' || radix === 'o' || radix === 'b') {
      this.i += 2;
      const re = radix === 'x' ? /[0-9a-fA-F]/ : radix === 'o' ? /[0-7]/ : /[01]/;
      const body = digits(re);
      if (body === '') throw new LexFail(from, `The number "${s.slice(from, this.i + 1)}" has no digits after its prefix.`, 'SyntaxError', this.i + 1);
      this.afterNumber(from);
      const value = parseInt(body.replace(/_/g, ''), radix === 'x' ? 16 : radix === 'o' ? 8 : 2);
      if (value > MAX_INT) throw new LexFail(from, `This integer is larger than NF-Py handles exactly (${MAX_INT}).`, 'SyntaxError', this.i);
      this.push('number', from, this.i, { value, numberType: 'int' });
      return;
    }
    const intPart = s[this.i] === '.' ? '' : digits(/[0-9]/);
    let float = false;
    if (s[this.i] === '.' && !(s[this.i + 1] === '.' && s[this.i + 2] === '.')) {
      float = true;
      this.i++;
      if (/[0-9]/.test(s[this.i] ?? '')) digits(/[0-9]/);
    }
    if ((s[this.i] === 'e' || s[this.i] === 'E') && /[0-9+-]/.test(s[this.i + 1] ?? '')) {
      const save = this.i;
      this.i++;
      if (s[this.i] === '+' || s[this.i] === '-') this.i++;
      if (digits(/[0-9]/) === '') this.i = save;
      else float = true;
    }
    if (s[this.i] === 'j' || s[this.i] === 'J') throw new LexFail(from, 'Complex numbers are not part of NF-Py.', 'SyntaxError', this.i + 1);
    this.afterNumber(from);
    const text = s.slice(from, this.i).replace(/_/g, '');
    if (!float && intPart.length > 1 && /^0+[0-9]/.test(intPart) && !/^0+$/.test(intPart.replace(/_/g, ''))) {
      throw new LexFail(from, 'A decimal integer cannot start with 0 (write 0o17 for an octal number).', 'SyntaxError', this.i);
    }
    const value = Number(text);
    if (!float && value > MAX_INT) throw new LexFail(from, `This integer is larger than NF-Py handles exactly (${MAX_INT}).`, 'SyntaxError', this.i);
    this.push('number', from, this.i, { value, numberType: float ? 'float' : 'int' });
  }

  private afterNumber(from: number): void {
    const n = this.src[this.i] ?? '';
    if (n === '_') throw new LexFail(this.i, 'An underscore in a number must sit between two digits.', 'SyntaxError', this.i + 1);
    if (n !== '' && NAME_CHAR.test(n)) throw new LexFail(from, `"${this.src.slice(from, this.i + 1)}" is not a valid number; a name cannot start with a digit.`, 'SyntaxError', this.i + 1);
  }

  // ── strings ──

  /** A string literal whose prefix starts at `from` and whose quote is at `i`. */
  private string(from: number, prefix: string): void {
    const s = this.src;
    const p = prefix.toLowerCase();
    if (p.includes('b')) {
      const endAt = this.scanStringEnd(this.i, s[this.i] as string, s.startsWith((s[this.i] as string).repeat(3), this.i));
      throw new LexFail(from, 'Bytes literals (b"…") are not part of NF-Py.', 'SyntaxError', endAt);
    }
    const raw = p.includes('r');
    const fmt = p.includes('f');
    const q = s[this.i] as string;
    const triple = s.startsWith(q.repeat(3), this.i);
    const bodyStart = this.i + (triple ? 3 : 1);
    const closeAt = this.findClose(bodyStart, q, triple, raw, from);
    const bodyEnd = closeAt;
    this.i = closeAt + (triple ? 3 : 1);
    try {
      if (fmt) {
        const parts = this.fstringParts(bodyStart, bodyEnd, raw, q, triple);
        this.push('fstring', from, this.i, { parts });
        return;
      }
      const value = raw ? s.slice(bodyStart, bodyEnd).replace(/\r\n?/g, '\n') : this.decode(bodyStart, bodyEnd);
      this.push('string', from, this.i, { value });
    } catch (e) {
      // A bad escape or field: the whole literal is one error token.
      if (!(e instanceof LexFail)) throw e;
      this.record(e);
      this.push('error', from, this.i);
    }
  }

  /** Where the closing quote of a string is; throws for an unterminated string. */
  private findClose(bodyStart: number, q: string, triple: boolean, raw: boolean, from: number): number {
    const s = this.src;
    let j = bodyStart;
    for (;;) {
      if (j >= this.end) {
        const line = this.pos(this.end).line;
        throw new LexFail(from, triple ? `This triple-quoted string is never closed (the file ends on line ${line}).` : 'This string is never closed on its line; add the closing quote.', 'SyntaxError', triple ? this.end : this.lineEnd(from));
      }
      const c = s[j];
      if (c === '\\') {
        j += 2;
        if (!raw && (s[j - 1] === '\r') && s[j] === '\n') j++;
        continue;
      }
      if (!triple && (c === '\n' || c === '\r')) {
        throw new LexFail(from, 'This string is never closed on its line; add the closing quote (use triple quotes for text over several lines).', 'SyntaxError', j);
      }
      if (c === q && (!triple || s.startsWith(q.repeat(3), j))) return j;
      j++;
    }
  }

  private scanStringEnd(at: number, q: string, triple: boolean): number {
    try {
      return this.findClose(at + (triple ? 3 : 1), q, triple, false, at) + (triple ? 3 : 1);
    } catch {
      return this.lineEnd(at);
    }
  }

  private lineEnd(at: number): number {
    let j = at;
    while (j < this.end && this.src[j] !== '\n' && this.src[j] !== '\r') j++;
    return j;
  }

  /** Decodes the escapes of a non-raw string body `[from, to)`. */
  private decode(from: number, to: number): string {
    const s = this.src;
    let out = '';
    let j = from;
    while (j < to) {
      const c = s[j] as string;
      if (c === '\r') {
        out += '\n';
        j += s[j + 1] === '\n' ? 2 : 1;
        continue;
      }
      if (c !== '\\') {
        out += c;
        j++;
        continue;
      }
      const e = s[j + 1] ?? '';
      const simple: Readonly<Record<string, string>> = { '\\': '\\', "'": "'", '"': '"', a: '\x07', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v' };
      if (Object.prototype.hasOwnProperty.call(simple, e)) {
        out += simple[e] as string;
        j += 2;
        continue;
      }
      if (e === '\n') {
        j += 2;
        continue;
      }
      if (e === '\r') {
        j += s[j + 2] === '\n' ? 3 : 2;
        continue;
      }
      if (/[0-7]/.test(e)) {
        let k = j + 1;
        while (k < j + 4 && k < to && /[0-7]/.test(s[k] as string)) k++;
        out += String.fromCharCode(parseInt(s.slice(j + 1, k), 8));
        j = k;
        continue;
      }
      if (e === 'x' || e === 'u' || e === 'U') {
        const width = e === 'x' ? 2 : e === 'u' ? 4 : 8;
        const hex = s.slice(j + 2, j + 2 + width);
        if (hex.length !== width || !/^[0-9A-Fa-f]+$/.test(hex) || j + 2 + width > to) {
          throw new LexFail(j, `The escape \\${e} needs exactly ${width} hexadecimal digits.`, 'SyntaxError', Math.min(j + 2 + width, to));
        }
        const code = parseInt(hex, 16);
        if (code > 0x10ffff) throw new LexFail(j, 'That escape names no Unicode character.', 'SyntaxError', j + 2 + width);
        out += String.fromCodePoint(code);
        j += 2 + width;
        continue;
      }
      if (e === 'N') throw new LexFail(j, 'Named escapes (\\N{…}) are not part of NF-Py; use \\u with the character\'s code.', 'SyntaxError', j + 2);
      // Python keeps an unknown escape as written.
      out += c;
      j++;
    }
    return out;
  }

  /** Splits an f-string body into text and replacement fields. */
  private fstringParts(from: number, to: number, raw: boolean, q: string, triple: boolean): PyFStringToken[] {
    const s = this.src;
    const parts: PyFStringToken[] = [];
    let textFrom = from;
    let j = from;
    const flushText = (end: number): void => {
      if (end <= textFrom) return;
      const chunk = raw ? s.slice(textFrom, end).replace(/\r\n?/g, '\n') : this.decode(textFrom, end);
      const text = chunk.replace(/\{\{/g, '{').replace(/\}\}/g, '}');
      const last = parts[parts.length - 1];
      if (last !== undefined && last.kind === 'text') parts[parts.length - 1] = { kind: 'text', value: last.value + text };
      else if (text !== '') parts.push({ kind: 'text', value: text });
    };
    while (j < to) {
      const c = s[j];
      if (c === '\\' && !raw) {
        j += 2;
        continue;
      }
      if (c === '{' && s[j + 1] === '{') {
        j += 2;
        continue;
      }
      if (c === '}') {
        if (s[j + 1] === '}') {
          j += 2;
          continue;
        }
        throw new LexFail(j, 'A single "}" in an f-string must be doubled ("}}") to print it.', 'SyntaxError', j + 1);
      }
      if (c !== '{') {
        j++;
        continue;
      }
      flushText(j);
      const field = this.fstringField(j, to, q, triple);
      parts.push(field.part);
      j = field.next;
      textFrom = j;
    }
    flushText(to);
    return parts;
  }

  /** One replacement field starting at `open` (the `{`); returns it and the offset after its `}`. */
  private fstringField(open: number, to: number, q: string, triple: boolean): { part: PyFStringToken; next: number } {
    const s = this.src;
    let j = open + 1;
    const depth: string[] = [];
    let conversion: 's' | 'r' | 'a' | undefined;
    let exprEnd = -1;
    for (;;) {
      if (j >= to) throw new LexFail(open, 'This f-string field is never closed: a "}" is missing.', 'SyntaxError', to);
      const c = s[j] as string;
      if (c === '\\') throw new LexFail(j, 'The expression inside an f-string field cannot contain a backslash.', 'SyntaxError', j + 1);
      if (c === '#') throw new LexFail(j, 'The expression inside an f-string field cannot contain "#".', 'SyntaxError', j + 1);
      if (c === "'" || c === '"') {
        if (c === q && !triple) throw new LexFail(j, `Inside this f-string, write strings with the other quote (${q === '"' ? "'" : '"'}).`, 'SyntaxError', j + 1);
        const inner = s.startsWith(c.repeat(3), j);
        let k = j + (inner ? 3 : 1);
        while (k < to && !(s[k] === c && (!inner || s.startsWith(c.repeat(3), k)))) k += s[k] === '\\' ? 2 : 1;
        if (k >= to) throw new LexFail(j, 'A string inside this f-string field is never closed.', 'SyntaxError', to);
        j = k + (inner ? 3 : 1);
        continue;
      }
      if (c === '(' || c === '[' || c === '{') {
        depth.push(c);
        j++;
        continue;
      }
      if ((c === ')' || c === ']' || c === '}') && depth.length > 0) {
        depth.pop();
        j++;
        continue;
      }
      if (depth.length === 0) {
        if (c === '!' && s[j + 1] !== '=') {
          exprEnd = j;
          const conv = s[j + 1];
          if (conv !== 's' && conv !== 'r' && conv !== 'a') throw new LexFail(j, 'After "!" in an f-string field comes s, r or a.', 'SyntaxError', j + 2);
          conversion = conv;
          j += 2;
          if (s[j] !== ':' && s[j] !== '}') throw new LexFail(j, 'After the conversion (!r, !s or !a) comes ":" or "}".', 'SyntaxError', j + 1);
          break;
        }
        if (c === ':' || c === '}') {
          exprEnd = j;
          break;
        }
        if (c === '=' && s[j + 1] !== '=' && !'=!<>'.includes(s[j - 1] ?? '')) {
          throw new LexFail(j, 'The "=" form of f-string fields ({x=}) is not part of NF-Py.', 'SyntaxError', j + 1);
        }
      }
      if ((c === '\n' || c === '\r') && !triple) throw new LexFail(open, 'This f-string field is never closed: a "}" is missing.', 'SyntaxError', j);
      j++;
    }
    if (s.slice(open + 1, exprEnd).trim() === '') throw new LexFail(open, 'An f-string field needs an expression between "{" and "}".', 'SyntaxError', exprEnd + 1);
    let spec: string | undefined;
    if (s[j] === ':') {
      const specFrom = j + 1;
      let k = specFrom;
      while (k < to && s[k] !== '}') {
        if (s[k] === '{') throw new LexFail(k, 'Nested fields inside a format spec are not part of NF-Py.', 'SyntaxError', k + 1);
        k++;
      }
      if (k >= to) throw new LexFail(open, 'This f-string field is never closed: a "}" is missing.', 'SyntaxError', to);
      spec = this.decode(specFrom, k);
      j = k;
    }
    // s[j] === '}'
    const part: PyFStringToken = {
      kind: 'field', from: open + 1, to: exprEnd,
      ...(conversion !== undefined ? { conversion } : {}),
      ...(spec !== undefined ? { spec } : {}),
    };
    return { part, next: j + 1 };
  }
}

/** Tokenizes NF-Py source. Never throws: problems are in `errors`, and each becomes an `error` token. */
export function lexPy(source: string): PyLexResult {
  return new Lexer(source, {}).run();
}

/**
 * Tokenizes `[from, to)` of `source` as one expression (an f-string field): no indentation tokens, line breaks are
 * spaces, positions are those of `source`.
 */
export function lexPyExpression(source: string, from: number, to: number, positions?: (offset: number) => SourcePos): PyLexResult {
  return new Lexer(source, { expression: { from, to } }, positions).run();
}
