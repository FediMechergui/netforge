/**
 * A YAML subset with positions (ARCHITECTURE-P3 D21 "Data formats", §7 W1 auto; §11.3 lesson code samples).
 *
 * Pure and dependency-free, exported through `@netforge/engine/pure`. It reads the YAML a CCNA learner meets in
 * configuration-management examples and produces the shared data model of `json.ts` (so any YAML here converts to
 * JSON and back).
 *
 * THE SUBSET (YAML 1.2, core schema):
 *  - one document, with an optional `---` before it and an optional `...` after it; `#` comments;
 *  - block mappings (`key: value`), block sequences (`- item`, also compact `- key: value` and `- - item`, and a
 *    sequence at the same indentation as its key), nesting by spaces;
 *  - flow collections `[a, b]` and `{a: 1, b: 2}`, which may span lines (so every JSON document is accepted);
 *  - plain scalars (also folded over more-indented lines), single-quoted (`''` is a quote) and double-quoted scalars
 *    (the YAML escapes), both of which may span lines; literal `|` and folded `>` block scalars with the chomping (`-`,
 *    `+`) and indentation (1-9) indicators;
 *  - plain scalars resolve as the core schema says: `null`, `~` and nothing → null; `true`/`false` (also `True`,
 *    `TRUE` …) → boolean; decimal, `0o` and `0x` integers and decimal floats → number; everything else is a string
 *    (so `yes`, `no`, `on` and `off` are strings, as in YAML 1.2).
 * Not in the subset, each refused with an error naming its line and column: anchors and aliases (`&`, `*`), tags
 * (`!`), directives (`%YAML`), several documents in one text, complex keys (`?`), keys that are collections, tabs used
 * for indentation, a key written twice in one mapping, and `.inf` / `.nan` (the data model holds finite numbers only).
 */
import {
  DATA_MAX_DEPTH,
  dataValueOf,
  isDataObject,
  textPositions,
  type DataEntry,
  type DataNode,
  type DataParseResult,
  type DataSyntaxError,
  type DataValue,
  type SourcePos,
  type SourceSpan,
} from './json.js';

class YamlFail extends Error {
  constructor(readonly at: number, message: string) {
    super(message);
  }
}

const NULL_WORDS = /^(?:~|null|Null|NULL)$/;
const TRUE_WORDS = /^(?:true|True|TRUE)$/;
const FALSE_WORDS = /^(?:false|False|FALSE)$/;
const INT_DEC = /^[-+]?[0-9]+$/;
const INT_OCT = /^0o[0-7]+$/;
const INT_HEX = /^0x[0-9a-fA-F]+$/;
const FLOAT = /^[-+]?(?:\.[0-9]+|[0-9]+(?:\.[0-9]*)?)(?:[eE][-+]?[0-9]+)?$/;
const SPECIAL_FLOAT = /^(?:[-+]?\.(?:inf|Inf|INF)|\.(?:nan|NaN|NAN))$/;

const isBreak = (c: string | undefined): boolean => c === '\n' || c === '\r';
const isBlank = (c: string | undefined): boolean => c === ' ' || c === '\t';
const isSpaceOrEnd = (c: string | undefined): boolean => c === undefined || isBlank(c) || isBreak(c);
const FLOW_INDICATORS = ',[]{}';

type Scalar = { kind: 'null'; value: null } | { kind: 'boolean'; value: boolean } | { kind: 'number'; value: number; raw: string } | { kind: 'string'; value: string };

/** How a plain scalar resolves under the core schema; throws for the special floats and an overflowing number. */
function resolvePlain(text: string, at: number): Scalar {
  if (text === '' || NULL_WORDS.test(text)) return { kind: 'null', value: null };
  if (TRUE_WORDS.test(text)) return { kind: 'boolean', value: true };
  if (FALSE_WORDS.test(text)) return { kind: 'boolean', value: false };
  let n: number | undefined;
  if (INT_OCT.test(text)) n = parseInt(text.slice(2), 8);
  else if (INT_HEX.test(text)) n = parseInt(text.slice(2), 16);
  else if (INT_DEC.test(text) || FLOAT.test(text)) n = Number(text);
  if (n !== undefined) {
    if (!Number.isFinite(n)) throw new YamlFail(at, 'The number is too large to represent.');
    return { kind: 'number', value: n === 0 ? 0 : n, raw: text };
  }
  if (SPECIAL_FLOAT.test(text)) throw new YamlFail(at, `"${text}" is an infinite or not-a-number value, which this YAML subset (and JSON) cannot hold.`);
  return { kind: 'string', value: text };
}

class YamlParser {
  private i = 0;
  /** Offsets of the open flow collections, innermost last (for the "never closed" error). */
  private readonly flowOpen: number[] = [];
  private readonly t: string;
  private readonly pos: (offset: number) => SourcePos;

  constructor(text: string) {
    this.t = text;
    this.pos = textPositions(text);
    if (text.charCodeAt(0) === 0xfeff) this.i = 1;
  }

  error(e: YamlFail): DataSyntaxError {
    const p = this.pos(e.at);
    return { message: e.message, line: p.line, column: p.column, offset: p.offset };
  }

  private span(start: number, end = this.i): SourceSpan {
    return { start: this.pos(start), end: this.pos(end) };
  }

  // ── lines ──

  /** Offset of the start of the line holding `at`. */
  private lineStartOf(at: number): number {
    let j = at;
    while (j > 0 && !isBreak(this.t[j - 1])) j--;
    return j;
  }

  /** Offset of the line break (or the end) of the line holding `at`. */
  private lineEndOf(at: number): number {
    let j = at;
    while (j < this.t.length && !isBreak(this.t[j])) j++;
    return j;
  }

  /** Offset just after the line break at `at` (which must be a break or the end). */
  private afterBreak(at: number): number {
    if (this.t[at] === '\r' && this.t[at + 1] === '\n') return at + 2;
    return at < this.t.length ? at + 1 : at;
  }

  private columnOf(at: number): number {
    return at - this.lineStartOf(at);
  }

  private atEnd(): boolean {
    return this.i >= this.t.length;
  }

  /** From a line start: the number of leading spaces. */
  private indentAt(lineStart: number): number {
    let j = lineStart;
    while (this.t[j] === ' ') j++;
    return j - lineStart;
  }

  /** Whether the line at `lineStart` holds only blanks and possibly a comment. */
  private isBlankLine(lineStart: number): boolean {
    let j = lineStart;
    while (isBlank(this.t[j])) j++;
    return j >= this.t.length || isBreak(this.t[j]) || this.t[j] === '#';
  }

  /** Whether a document marker (`---` or `...`) starts the line at `lineStart`. */
  private isMarker(lineStart: number, marker?: string): boolean {
    const m = this.t.slice(lineStart, lineStart + 3);
    if (m !== '---' && m !== '...') return false;
    if (marker !== undefined && m !== marker) return false;
    return isSpaceOrEnd(this.t[lineStart + 3]);
  }

  /** Moves `i` (a line start) past blank and comment-only lines. Refuses a tab used to indent a content line. */
  private skipBlankLines(): void {
    for (;;) {
      if (this.atEnd()) return;
      const start = this.i;
      if (!this.isBlankLine(start)) {
        const ind = this.indentAt(start);
        if (this.t[start + ind] === '\t') throw new YamlFail(start + ind, 'YAML does not allow tabs for indentation; use spaces.');
        return;
      }
      this.i = this.afterBreak(this.lineEndOf(start));
    }
  }

  /** After a node on this line: allows blanks and a comment, then consumes the line break. */
  private endOfLine(what: string): void {
    while (isBlank(this.t[this.i])) this.i++;
    const c = this.t[this.i];
    if (c === '#') {
      if (!isBlank(this.t[this.i - 1])) throw new YamlFail(this.i, 'A comment must be separated from the text before it by a space.');
      this.i = this.lineEndOf(this.i);
    } else if (c !== undefined && !isBreak(c)) {
      if (c === ':') throw new YamlFail(this.i, 'A ":" here would start a key, which cannot follow a value on the same line.');
      throw new YamlFail(this.i, `Unexpected text after ${what}.`);
    }
    this.i = this.afterBreak(this.i);
  }

  // ── documents ──

  parse(): DataNode {
    this.skipBlankLines();
    if (!this.atEnd() && this.t[this.i] === '%') throw new YamlFail(this.i, 'Directives such as %YAML are not part of this YAML subset.');
    let node: DataNode | undefined;
    if (!this.atEnd() && this.isMarker(this.i, '---')) {
      this.i += 3;
      while (isBlank(this.t[this.i])) this.i++;
      if (this.t[this.i] !== undefined && !isBreak(this.t[this.i]) && this.t[this.i] !== '#') node = this.inlineValue(-1, 0);
      else this.endOfLine('"---"');
    }
    if (node === undefined) {
      this.skipBlankLines();
      node = this.blockNode(-1, 0);
    }
    this.skipBlankLines();
    if (!this.atEnd() && this.isMarker(this.i, '...')) {
      this.i += 3;
      this.endOfLine('"..."');
      this.skipBlankLines();
    }
    if (!this.atEnd()) {
      if (this.isMarker(this.i, '---')) throw new YamlFail(this.i, 'Several documents in one text are not part of this YAML subset.');
      const ind = this.indentAt(this.i);
      throw new YamlFail(this.i + ind, 'Unexpected text here: check the indentation of this line.');
    }
    return node;
  }

  /** The node whose lines start at `i` (a line start after blank lines), indented more than `parent`; null if none. */
  private blockNode(parent: number, depth: number): DataNode {
    if (this.atEnd() || this.isMarker(this.i)) return { kind: 'null', value: null, span: this.span(this.i, this.i) };
    const ind = this.indentAt(this.i);
    if (ind <= parent) return { kind: 'null', value: null, span: this.span(this.i, this.i) };
    this.i += ind;
    return this.nodeAt(ind, parent, depth);
  }

  /** The node whose first character is at `i`, in column `col` (its indentation), inside a parent indented `parent`. */
  private nodeAt(col: number, parent: number, depth: number): DataNode {
    if (depth >= DATA_MAX_DEPTH) throw new YamlFail(this.i, `The document nests more than ${DATA_MAX_DEPTH} levels deep.`);
    const c = this.t[this.i];
    if (c === '-' && isSpaceOrEnd(this.t[this.i + 1])) return this.blockSequence(col, depth);
    if (c === '?' && isSpaceOrEnd(this.t[this.i + 1])) throw new YamlFail(this.i, 'Complex keys ("? ") are not part of this YAML subset.');
    if (this.lineHasKey(this.i)) return this.blockMapping(col, depth);
    return this.value(parent, depth);
  }

  /** Whether the text from `from` to the end of its line starts with a `key:` (plain or quoted, one line). */
  private lineHasKey(from: number): boolean {
    const t = this.t;
    let j = from;
    const end = this.lineEndOf(from);
    const q = t[j];
    if (q === '"' || q === "'") {
      j++;
      while (j < end) {
        if (t[j] === '\\' && q === '"') {
          j += 2;
          continue;
        }
        if (t[j] === q) {
          if (q === "'" && t[j + 1] === "'") {
            j += 2;
            continue;
          }
          break;
        }
        j++;
      }
      if (j >= end) return false;
      j++;
      while (isBlank(t[j])) j++;
      return t[j] === ':' && isSpaceOrEnd(t[j + 1]);
    }
    if (q === '[' || q === '{') return false;
    for (; j < end; j++) {
      const c = t[j];
      if (c === ':' && isSpaceOrEnd(t[j + 1])) return true;
      if (c === '#' && j > from && isBlank(t[j - 1])) return false;
    }
    return false;
  }

  // ── block collections ──

  private blockSequence(col: number, depth: number): DataNode {
    const start = this.i;
    const items: DataNode[] = [];
    let end = this.i;
    for (;;) {
      this.i++; // '-'
      while (this.t[this.i] === ' ') this.i++;
      if (this.t[this.i] === '\t') throw new YamlFail(this.i, 'YAML does not allow tabs for indentation; use spaces.');
      let item: DataNode;
      if (this.t[this.i] === undefined || isBreak(this.t[this.i]) || this.t[this.i] === '#') {
        this.endOfLine('"-"');
        this.skipBlankLines();
        item = this.blockNode(col, depth + 1);
      } else {
        item = this.nodeAt(this.columnOf(this.i), col, depth + 1);
      }
      items.push(item);
      end = Math.max(end, item.span.end.offset);
      this.skipBlankLines();
      if (this.atEnd() || this.isMarker(this.i)) break;
      const ind = this.indentAt(this.i);
      const lead = this.i + ind;
      if (ind === col && this.t[lead] === '-' && isSpaceOrEnd(this.t[lead + 1])) {
        this.i = lead;
        continue;
      }
      if (ind > col) throw new YamlFail(lead, 'The indentation of this line matches none of the list items above it.');
      break;
    }
    return { kind: 'array', items, span: this.span(start, end) };
  }

  private blockMapping(col: number, depth: number): DataNode {
    const start = this.i;
    const entries: DataEntry[] = [];
    const seen = new Set<string>();
    let end = this.i;
    for (;;) {
      const keyStart = this.i;
      const key = this.readKey();
      const keySpan = this.span(keyStart);
      if (seen.has(key)) throw new YamlFail(keyStart, `The key "${key}" appears twice in the same mapping.`);
      seen.add(key);
      while (isBlank(this.t[this.i])) this.i++;
      this.i++; // ':'
      while (isBlank(this.t[this.i])) this.i++;
      let value: DataNode;
      if (this.t[this.i] === undefined || isBreak(this.t[this.i]) || this.t[this.i] === '#') {
        const colonEnd = this.i;
        this.endOfLine('the ":"');
        this.skipBlankLines();
        if (this.atEnd() || this.isMarker(this.i)) value = { kind: 'null', value: null, span: this.span(colonEnd, colonEnd) };
        else {
          const ind = this.indentAt(this.i);
          const lead = this.i + ind;
          if (ind > col) value = this.blockNode(col, depth + 1);
          else if (ind === col && this.t[lead] === '-' && isSpaceOrEnd(this.t[lead + 1])) {
            this.i = lead;
            value = this.blockSequence(col, depth + 1);
          } else value = { kind: 'null', value: null, span: this.span(colonEnd, colonEnd) };
        }
      } else {
        value = this.inlineValue(col, depth + 1);
      }
      entries.push({ key, keySpan, value });
      end = Math.max(end, value.span.end.offset, keySpan.end.offset);
      this.skipBlankLines();
      if (this.atEnd() || this.isMarker(this.i)) break;
      const ind = this.indentAt(this.i);
      const lead = this.i + ind;
      if (ind === col) {
        this.i = lead;
        if (this.t[lead] === '-' && isSpaceOrEnd(this.t[lead + 1])) throw new YamlFail(lead, 'A list item cannot follow a key: value line at the same indentation; put the list under a key.');
        if (!this.lineHasKey(lead)) throw new YamlFail(lead, 'Expected "key: value" at this indentation, like the lines above it.');
        continue;
      }
      if (ind > col) throw new YamlFail(lead, 'The indentation of this line matches none of the keys above it.');
      break;
    }
    return { kind: 'object', entries, span: this.span(start, end) };
  }

  /** A mapping key on this line (plain or quoted), leaving `i` before the `:`. */
  private readKey(): string {
    const c = this.t[this.i];
    if (c === '"' || c === "'") return this.quoted(true);
    if (c === '[' || c === '{') throw new YamlFail(this.i, 'A key cannot be a list or a mapping in this YAML subset.');
    this.checkPlainStart();
    const start = this.i;
    while (!(this.t[this.i] === ':' && isSpaceOrEnd(this.t[this.i + 1]))) this.i++;
    return this.t.slice(start, this.i).replace(/[ \t]+$/, '');
  }

  /** A value that starts on the line of its key or list dash, inside a parent indented `parent`. */
  private inlineValue(parent: number, depth: number): DataNode {
    const c = this.t[this.i];
    if (c === '-' && isSpaceOrEnd(this.t[this.i + 1])) throw new YamlFail(this.i, 'A list cannot start on the same line as its key; put each "- item" on its own line below the key.');
    if (this.lineHasKey(this.i)) throw new YamlFail(this.i, 'A mapping cannot start on the same line as another key; put it on the next line, indented.');
    return this.value(parent, depth);
  }

  // ── values ──

  private checkPlainStart(): void {
    const c = this.t[this.i] ?? '';
    if (c === '&' || c === '*') throw new YamlFail(this.i, 'Anchors and aliases (& and *) are not part of this YAML subset.');
    if (c === '!') throw new YamlFail(this.i, 'Tags (!) are not part of this YAML subset.');
    if (c === '%' || c === '@' || c === '`') throw new YamlFail(this.i, `"${c}" cannot start a plain value; put the value in quotes.`);
    if (c === ',' || c === ']' || c === '}') throw new YamlFail(this.i, `Unexpected "${c}".`);
    if (c === '\t') throw new YamlFail(this.i, 'YAML does not allow tabs for indentation; use spaces.');
  }

  /** A scalar, flow collection or block scalar at `i`, inside a parent indented `parent`; ends at a line start. */
  private value(parent: number, depth: number): DataNode {
    const c = this.t[this.i];
    const start = this.i;
    if (c === '|' || c === '>') return this.blockScalar(parent);
    if (c === '[' || c === '{') {
      const node = this.flow(depth);
      this.endOfLine(c === '[' ? 'the closing "]"' : 'the closing "}"');
      return node;
    }
    if (c === '"' || c === "'") {
      const value = this.quoted(false);
      const node: DataNode = { kind: 'string', value, span: this.span(start) };
      this.endOfLine('the closing quote');
      return node;
    }
    return this.plainBlock(parent);
  }

  /** A plain scalar in block context: this line up to a comment, folded with the more-indented lines that follow. */
  private plainBlock(parent: number): DataNode {
    this.checkPlainStart();
    const start = this.i;
    const t = this.t;
    const readLine = (from: number): { text: string; end: number; comment: boolean } => {
      const lineEnd = this.lineEndOf(from);
      let j = from;
      let comment = false;
      for (; j < lineEnd; j++) {
        if (t[j] === '#' && j > from && isBlank(t[j - 1])) {
          comment = true;
          break;
        }
      }
      let e = j;
      while (e > from && isBlank(t[e - 1])) e--;
      return { text: t.slice(from, e), end: e, comment };
    };
    const first = readLine(this.i);
    let text = first.text;
    let end = first.end;
    let lineEnd = this.lineEndOf(this.i);
    let stop = first.comment;
    for (;;) {
      if (stop) break;
      let next = this.afterBreak(lineEnd);
      let empties = 0;
      while (next < t.length && this.isBlankLine(next) && t[next + this.indentAt(next)] !== '#') {
        empties++;
        next = this.afterBreak(this.lineEndOf(next));
      }
      if (next >= t.length || this.isMarker(next)) break;
      const ind = this.indentAt(next);
      if (ind <= parent || t[next + ind] === '#') break;
      if (t[next + ind] === '\t') throw new YamlFail(next + ind, 'YAML does not allow tabs for indentation; use spaces.');
      const line = readLine(next + ind);
      if (line.text === '') break;
      const colon = /:(?:[ \t]|$)/.exec(line.text);
      if (colon !== null) throw new YamlFail(next + ind, 'This line is indented under a value, so it cannot start a new key; check its indentation.');
      text += empties > 0 ? '\n'.repeat(empties) : ' ';
      text += line.text;
      end = line.end;
      lineEnd = this.lineEndOf(next);
      stop = line.comment;
    }
    this.i = this.afterBreak(lineEnd);
    return this.scalarNode(resolvePlain(text, start), start, end);
  }

  private scalarNode(s: Scalar, start: number, end: number): DataNode {
    return { ...s, span: this.span(start, end) } as DataNode;
  }

  /** A quoted scalar at `i` (either quote); `key` refuses a line break inside it. Leaves `i` after the closing quote. */
  private quoted(key: boolean): string {
    const t = this.t;
    const q = t[this.i] as string;
    const open = this.i;
    this.i++;
    let out = '';
    for (;;) {
      const c = t[this.i];
      if (c === undefined) throw new YamlFail(open, `This string is never closed: a ${q} is missing.`);
      if (c === q) {
        if (q === "'" && t[this.i + 1] === "'") {
          out += "'";
          this.i += 2;
          continue;
        }
        this.i++;
        return out;
      }
      if (isBreak(c)) {
        if (key) throw new YamlFail(open, 'A key must fit on one line.');
        out = out.replace(/[ \t]+$/, '');
        this.i = this.afterBreak(this.i);
        let empties = 0;
        for (;;) {
          while (isBlank(t[this.i])) this.i++;
          if (isBreak(t[this.i])) {
            empties++;
            this.i = this.afterBreak(this.i);
            continue;
          }
          break;
        }
        out += empties > 0 ? '\n'.repeat(empties) : ' ';
        continue;
      }
      if (c === '\\' && q === '"') {
        const e = t[this.i + 1];
        if (isBreak(e)) {
          if (key) throw new YamlFail(open, 'A key must fit on one line.');
          this.i = this.afterBreak(this.i + 1);
          while (isBlank(t[this.i])) this.i++;
          continue;
        }
        out += this.escape();
        continue;
      }
      out += c;
      this.i++;
    }
  }

  /** One double-quoted escape at `i` (the backslash); advances past it. */
  private escape(): string {
    const t = this.t;
    const e = t[this.i + 1] ?? '';
    const simple: Record<string, string> = {
      '0': '\0', a: '\x07', b: '\b', t: '\t', '\t': '\t', n: '\n', v: '\v', f: '\f', r: '\r', e: '\x1b', ' ': ' ',
      '"': '"', '/': '/', '\\': '\\', N: '\x85', _: '\xa0', L: '\u2028', P: '\u2029',
    };
    const s = Object.prototype.hasOwnProperty.call(simple, e) ? simple[e] : undefined;
    if (s !== undefined) {
      this.i += 2;
      return s;
    }
    const width = e === 'x' ? 2 : e === 'u' ? 4 : e === 'U' ? 8 : 0;
    if (width === 0) throw new YamlFail(this.i, e === '' ? 'This string is never closed: a " is missing.' : `Unknown escape "\\${e}" in a double-quoted string.`);
    const hex = t.slice(this.i + 2, this.i + 2 + width);
    if (hex.length !== width || !/^[0-9A-Fa-f]+$/.test(hex)) throw new YamlFail(this.i, `The escape \\${e} needs exactly ${width} hexadecimal digits.`);
    const code = parseInt(hex, 16);
    if (code > 0x10ffff) throw new YamlFail(this.i, 'That escape names no Unicode character.');
    this.i += 2 + width;
    return e === 'U' ? String.fromCodePoint(code) : String.fromCharCode(code);
  }

  /** A literal (`|`) or folded (`>`) block scalar whose header is at `i`, inside a parent indented `parent`. */
  private blockScalar(parent: number): DataNode {
    const t = this.t;
    const start = this.i;
    const folded = t[this.i] === '>';
    this.i++;
    let chomp: 'clip' | 'strip' | 'keep' = 'clip';
    let explicit = 0;
    for (let k = 0; k < 2; k++) {
      const c = t[this.i];
      if ((c === '-' || c === '+') && chomp === 'clip') {
        chomp = c === '-' ? 'strip' : 'keep';
        this.i++;
      } else if (c !== undefined && c >= '1' && c <= '9' && explicit === 0) {
        explicit = Number(c);
        this.i++;
      }
    }
    this.endOfLine(`the "${folded ? '>' : '|'}" header`);
    // Content indentation: from the indicator, or from the first line that is not blank. Blank lines are empty lines
    // of the scalar (a whitespace-only line keeps no spaces in this subset).
    const isWhite = (ls: number): boolean => /^[ \t]*$/.test(t.slice(ls, this.lineEndOf(ls)));
    let contentIndent: number;
    if (explicit > 0) contentIndent = Math.max(parent, 0) + explicit;
    else {
      contentIndent = -1;
      let j = this.i;
      while (j < t.length && isWhite(j)) j = this.afterBreak(this.lineEndOf(j));
      if (j < t.length) contentIndent = this.indentAt(j);
      if (contentIndent <= parent) contentIndent = -1;
    }
    const lines: string[] = [];
    let end = this.i;
    let lastContent = -1;
    while (this.i < t.length) {
      const ls = this.i;
      if (contentIndent === 0 && this.isMarker(ls)) break;
      const le = this.lineEndOf(ls);
      const raw = t.slice(ls, le);
      if (isWhite(ls)) {
        lines.push('');
        this.i = this.afterBreak(le);
        continue;
      }
      if (contentIndent < 0 || this.indentAt(ls) < contentIndent) break;
      lines.push(raw.slice(contentIndent));
      lastContent = lines.length - 1;
      end = le;
      this.i = this.afterBreak(le);
    }
    // Blank lines after the last content line belong to the scalar only for chomping; never consume past them.
    const body = lines.slice(0, lastContent + 1);
    const trailing = lines.length - body.length;
    let text: string;
    if (folded) {
      text = '';
      let empty = 0;
      let prevMore = false;
      let first = true;
      for (const line of body) {
        if (line === '') {
          empty++;
          continue;
        }
        const more = line[0] === ' ' || line[0] === '\t';
        if (first) text += '\n'.repeat(empty);
        else if (!more && !prevMore) text += empty === 0 ? ' ' : '\n'.repeat(empty);
        else text += '\n'.repeat(empty + 1);
        text += line;
        empty = 0;
        prevMore = more;
        first = false;
      }
    } else {
      text = body.join('\n');
    }
    if (body.length > 0) {
      if (chomp === 'clip') text += '\n';
      else if (chomp === 'keep') text += '\n'.repeat(1 + trailing);
    } else if (chomp === 'keep') text = '\n'.repeat(trailing);
    return { kind: 'string', value: text, span: this.span(start, Math.max(end, start + 1)) };
  }

  // ── flow collections ──

  /** Skips blanks, line breaks and comments inside a flow collection. */
  private flowSpace(): void {
    const t = this.t;
    for (;;) {
      const c = t[this.i];
      if (isBlank(c)) this.i++;
      else if (isBreak(c)) this.i = this.afterBreak(this.i);
      else if (c === '#' && (this.i === 0 || isBlank(t[this.i - 1]) || isBreak(t[this.i - 1]))) this.i = this.lineEndOf(this.i);
      else return;
    }
  }

  private flow(depth: number): DataNode {
    if (depth >= DATA_MAX_DEPTH) throw new YamlFail(this.i, `The document nests more than ${DATA_MAX_DEPTH} levels deep.`);
    const t = this.t;
    const open = this.i;
    const seq = t[this.i] === '[';
    const close = seq ? ']' : '}';
    this.i++;
    this.flowOpen.push(open);
    const items: DataNode[] = [];
    const entries: DataEntry[] = [];
    const seen = new Set<string>();
    for (;;) {
      this.flowSpace();
      const c = t[this.i];
      if (c === undefined) throw new YamlFail(open, `This ${seq ? 'list' : 'mapping'} is never closed: a "${close}" is missing.`);
      if (c === close) {
        this.i++;
        break;
      }
      if (c === ',') throw new YamlFail(this.i, 'Unexpected ",": a value is missing here.');
      if (seq) {
        items.push(this.flowNode(depth + 1));
        this.flowSpace();
        if (t[this.i] === ':') throw new YamlFail(this.i, 'A "key: value" pair inside [ ] is not part of this YAML subset; use { } for a mapping.');
      } else {
        const keyStart = this.i;
        let key: string;
        if (c === '"' || c === "'") key = this.quoted(true);
        else if (c === '[' || c === '{') throw new YamlFail(this.i, 'A key cannot be a list or a mapping in this YAML subset.');
        else key = this.flowPlainText();
        const keySpan = this.span(keyStart);
        if (seen.has(key)) throw new YamlFail(keyStart, `The key "${key}" appears twice in the same mapping.`);
        seen.add(key);
        this.flowSpace();
        let value: DataNode;
        if (t[this.i] === ':') {
          this.i++;
          this.flowSpace();
          if (t[this.i] === ',' || t[this.i] === close) value = { kind: 'null', value: null, span: this.span(this.i, this.i) };
          else value = this.flowNode(depth + 1);
        } else value = { kind: 'null', value: null, span: this.span(this.i, this.i) };
        entries.push({ key, keySpan, value });
      }
      this.flowSpace();
      const d = t[this.i];
      if (d === ',') {
        this.i++;
        continue;
      }
      if (d === close) {
        this.i++;
        break;
      }
      if (d === undefined) throw new YamlFail(open, `This ${seq ? 'list' : 'mapping'} is never closed: a "${close}" is missing.`);
      throw new YamlFail(this.i, `Expected "," or "${close}"; found "${d}".`);
    }
    this.flowOpen.pop();
    return seq ? { kind: 'array', items, span: this.span(open) } : { kind: 'object', entries, span: this.span(open) };
  }

  private flowNode(depth: number): DataNode {
    const c = this.t[this.i];
    const start = this.i;
    if (c === '[' || c === '{') return this.flow(depth);
    if (c === '"' || c === "'") {
      const value = this.quoted(false);
      return { kind: 'string', value, span: this.span(start) };
    }
    if (c === '|' || c === '>') throw new YamlFail(this.i, 'A block scalar (| or >) cannot appear inside [ ] or { }.');
    if (c === '-' && isSpaceOrEnd(this.t[this.i + 1])) throw new YamlFail(this.i, 'A "- item" cannot appear inside [ ] or { }; separate items with ",".');
    const text = this.flowPlainText();
    return this.scalarNode(resolvePlain(text, start), start, start + text.length);
  }

  /** A plain scalar inside a flow collection (one line), leaving `i` after it. */
  private flowPlainText(): string {
    this.checkPlainStart();
    const t = this.t;
    const start = this.i;
    for (;;) {
      const c = t[this.i];
      if (c === undefined || isBreak(c) || FLOW_INDICATORS.includes(c)) break;
      if (c === ':' && (isSpaceOrEnd(t[this.i + 1]) || FLOW_INDICATORS.includes(t[this.i + 1] as string))) break;
      if (c === '#' && isBlank(t[this.i - 1])) break;
      this.i++;
    }
    let e = this.i;
    while (e > start && isBlank(t[e - 1])) e--;
    const text = t.slice(start, e);
    if (text === '') throw new YamlFail(start, 'A value is missing here.');
    if (isBreak(t[this.i])) {
      let j = this.afterBreak(this.i);
      while (isBlank(t[j])) j++;
      const n = t[j];
      if (n !== undefined && !isBreak(n) && n !== '#' && !FLOW_INDICATORS.includes(n) && n !== ':') {
        // A next line that reads like a block key means the collection was never closed.
        if (this.lineHasKey(j)) {
          const open = this.flowOpen[this.flowOpen.length - 1] ?? start;
          const seq = t[open] === '[';
          throw new YamlFail(open, `This ${seq ? 'list' : 'mapping'} is never closed: a "${seq ? ']' : '}'}" is missing.`);
        }
        throw new YamlFail(j, 'An unquoted value inside [ ] or { } must fit on one line; put it in quotes to continue it.');
      }
    }
    return text;
  }
}

/** Parses a document of the YAML subset described at the top of this file. An empty document is null. */
export function parseYaml(text: string): DataParseResult {
  const p = new YamlParser(text);
  try {
    const node = p.parse();
    return { ok: true, value: dataValueOf(node), node };
  } catch (e) {
    if (e instanceof YamlFail) return { ok: false, error: p.error(e) };
    throw e;
  }
}

// ── writing ──

/** Whether `s` can be written without quotes and read back as the same string. */
function plainSafe(s: string): boolean {
  if (s === '') return false;
  if (resolvePlainKind(s) !== 'string') return false;
  if (/^[\s]|[\s]$/.test(s)) return false;
  if (/[\u0000-\u001f\u007f-\u009f\u2028\u2029\uFEFF]/.test(s)) return false;
  if ('-?:,[]{}#&*!|>\'"%@`'.includes(s[0] as string)) return false;
  if (s.includes(': ') || s.includes(' #') || s.endsWith(':')) return false;
  if (s.startsWith('---') || s.startsWith('...')) return false;
  return true;
}

function resolvePlainKind(s: string): string {
  if (NULL_WORDS.test(s) || TRUE_WORDS.test(s) || FALSE_WORDS.test(s)) return 'other';
  if (INT_DEC.test(s) || INT_OCT.test(s) || INT_HEX.test(s) || FLOAT.test(s) || SPECIAL_FLOAT.test(s)) return 'other';
  return 'string';
}

function scalarText(v: DataValue): string {
  if (v === null) return 'null';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new RangeError('YAML output here cannot hold a non-finite number');
    return String(v);
  }
  if (typeof v === 'string') return plainSafe(v) ? v : JSON.stringify(v);
  if (Array.isArray(v)) return '[]';
  return '{}';
}

const isEmptyCollection = (v: DataValue): boolean =>
  (Array.isArray(v) && v.length === 0) || (isDataObject(v) && Object.keys(v).length === 0);
const isScalarLike = (v: DataValue): boolean => v === null || typeof v !== 'object' || isEmptyCollection(v);

/** Options of `stringifyYaml`. */
export interface YamlStringifyOptions {
  /** Spaces per mapping level (list items under a key are indented by the same amount). Default 2. */
  readonly indent?: number;
}

/**
 * Writes a data value as block-style YAML of the subset (keys in insertion order, lists indented under their key,
 * strings quoted only when they would otherwise read back as something else). Ends with a line break.
 */
export function stringifyYaml(value: DataValue, opts: YamlStringifyOptions = {}): string {
  const step = Math.max(1, opts.indent ?? 2);
  const lines: string[] = [];
  const emit = (v: DataValue, pad: number): void => {
    const sp = ' '.repeat(pad);
    if (Array.isArray(v)) {
      for (const item of v) {
        if (isScalarLike(item)) lines.push(`${sp}- ${scalarText(item)}`);
        else {
          const at = lines.length;
          emit(item, pad + 2);
          lines[at] = `${sp}- ${(lines[at] as string).slice(pad + 2)}`;
        }
      }
      return;
    }
    if (isDataObject(v)) {
      for (const k of Object.keys(v)) {
        const item = v[k] as DataValue;
        const key = plainSafe(k) ? k : JSON.stringify(k);
        if (isScalarLike(item)) lines.push(`${sp}${key}: ${scalarText(item)}`);
        else {
          lines.push(`${sp}${key}:`);
          emit(item, pad + step);
        }
      }
    }
  };
  if (isScalarLike(value)) return `${scalarText(value)}\n`;
  emit(value, 0);
  return `${lines.join('\n')}\n`;
}
