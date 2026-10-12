/**
 * automation/py-highlight.tsx — [S32] the automation workspace's syntax colouring and live syntax marks
 * (ARCHITECTURE-P3 §6 "Automation workspace", D21; §7 W6 web-desktop).
 *
 * Both are read from the engine's own NF-Py tokenizer and parser (`lexPy`, `lexPyExpression`, `parsePy` from
 * `@netforge/engine/pure`), so the editor colours exactly the tokens the script host will compile and marks exactly
 * the error a run would report. The tokenizer never throws: an unreadable character is an `error` token and the rest
 * of the text is still coloured.
 *
 *  - `highlightPy(source, marks)` cuts the whole text into segments, in order and without gaps, each with a class
 *    (`keyword`, `builtin`, `name`, `number`, `string`, `comment`, `op`, `error`, or plain `text` for the white space
 *    between tokens); an f-string's replacement fields are coloured as code, its literal text as a string. A segment
 *    inside a syntax mark carries `mark`, so the overlay can underline it.
 *  - `pySyntaxMarks(source)` lists every problem the tokenizer found plus the parser's first error (the one a run
 *    reports), each as a character range of the source, in source order; a problem at the end of a line or of the text
 *    marks the last character before it, so the mark is never empty when the line has text.
 *  - `PyHighlight` renders the segments as spans (classes `py-<class>`, `py-mark`) for the overlay behind the editor's
 *    textarea; it is decorative (the textarea holds the text, the status line says the error in words).
 *
 * Every class keeps a non-colour channel in the stylesheet (keywords bold, comments italic, errors and marks
 * underlined), and the error itself is always said in words beside the editor. Wording is original.
 */
import type { ReactNode } from 'react';
import { lexPy, lexPyExpression, parsePy, textPositions } from '@netforge/engine/pure';
import type { PySyntaxError, PySyntaxErrorType, PyToken } from '@netforge/engine/pure';

/** What a highlighted segment is. */
export type PyHighlightClass = 'keyword' | 'builtin' | 'name' | 'number' | 'string' | 'comment' | 'op' | 'error' | 'text';

/** One coloured piece of the source: `[from, to)`. */
export interface PyHighlightSegment {
  readonly from: number;
  readonly to: number;
  readonly cls: PyHighlightClass;
  /** Inside a syntax mark. */
  readonly mark?: true;
}

/** A character range of the source. */
export interface PySourceRange {
  readonly from: number;
  readonly to: number;
}

/** One live syntax mark: where, which error class, and the message (original wording, from the engine). */
export interface PySyntaxMark extends PySourceRange {
  readonly type: PySyntaxErrorType;
  readonly message: string;
  /** 1-based line and column of the problem. */
  readonly line: number;
  readonly column: number;
  /** The mark in words: `Line 3, column 5: SyntaxError: …`. */
  readonly text: string;
}

/**
 * Names coloured as built-ins: the NF-Py builtins and the modules a script may import (display only; the library in
 * the engine decides what exists).
 */
export const PY_BUILTIN_NAMES: ReadonlySet<string> = new Set([
  'abs', 'all', 'any', 'ascii', 'bin', 'bool', 'callable', 'chr', 'dict', 'divmod', 'enumerate', 'exit', 'filter',
  'float', 'format', 'getattr', 'hasattr', 'hex', 'input', 'int', 'isinstance', 'iter', 'len', 'list', 'map', 'max',
  'min', 'next', 'object', 'oct', 'open', 'ord', 'pow', 'print', 'quit', 'range', 'repr', 'reversed', 'round', 'set',
  'sorted', 'str', 'sum', 'tuple', 'type', 'zip',
  'json', 'time', 'sys', 'math', 'requests', 'nfrequests',
]);

const KIND_CLASS: Readonly<Record<PyToken['kind'], PyHighlightClass | null>> = {
  name: 'name',
  keyword: 'keyword',
  number: 'number',
  string: 'string',
  fstring: 'string',
  op: 'op',
  comment: 'comment',
  newline: 'text',
  indent: null,
  dedent: null,
  eof: null,
  error: 'error',
};

function classOf(t: PyToken): PyHighlightClass | null {
  const cls = KIND_CLASS[t.kind];
  if (cls === 'name' && PY_BUILTIN_NAMES.has(t.text)) return 'builtin';
  return cls;
}

/** Base segments of `tokens` over `[from, to)` of `source`, gaps as `fill`. */
function tokenSegments(source: string, tokens: readonly PyToken[], from: number, to: number, fill: PyHighlightClass, out: PyHighlightSegment[]): void {
  let at = from;
  const push = (a: number, b: number, cls: PyHighlightClass): void => {
    if (b > a) out.push({ from: a, to: b, cls });
  };
  for (const t of tokens) {
    const s = t.start.offset;
    const e = t.end.offset;
    const cls = classOf(t);
    if (cls === null || e <= s || s < at || e > to) continue;
    push(at, s, fill);
    if (t.kind === 'fstring' && t.parts !== undefined) {
      // literal text and braces as a string; each replacement field's expression as code
      let k = s;
      for (const part of t.parts) {
        if (part.kind !== 'field' || part.from < k || part.to > e) continue;
        push(k, part.from, 'string');
        tokenSegments(source, lexPyExpression(source, part.from, part.to).tokens, part.from, part.to, 'text', out);
        k = part.to;
      }
      push(k, e, 'string');
    } else {
      push(s, e, cls);
    }
    at = e;
  }
  push(at, to, fill);
}

/** Cut `segments` at the edges of `marks` and flag the pieces inside one. */
function applyMarks(segments: readonly PyHighlightSegment[], marks: readonly PySourceRange[]): PyHighlightSegment[] {
  const ranges = marks.filter((m) => m.to > m.from).slice().sort((a, b) => a.from - b.from || a.to - b.to);
  if (ranges.length === 0) return [...segments];
  const out: PyHighlightSegment[] = [];
  for (const seg of segments) {
    const cuts = new Set<number>([seg.from, seg.to]);
    for (const r of ranges) {
      if (r.to <= seg.from || r.from >= seg.to) continue;
      cuts.add(Math.max(seg.from, r.from));
      cuts.add(Math.min(seg.to, r.to));
    }
    const points = [...cuts].sort((a, b) => a - b);
    for (let i = 0; i + 1 < points.length; i++) {
      const a = points[i] as number;
      const b = points[i + 1] as number;
      const inside = ranges.some((r) => r.from <= a && r.to >= b);
      out.push(inside ? { from: a, to: b, cls: seg.cls, mark: true } : { from: a, to: b, cls: seg.cls });
    }
  }
  return out;
}

/** Join neighbours of the same class and mark (fewer spans to draw). */
function merge(segments: readonly PyHighlightSegment[]): PyHighlightSegment[] {
  const out: PyHighlightSegment[] = [];
  for (const s of segments) {
    const last = out[out.length - 1];
    if (last !== undefined && last.cls === s.cls && last.mark === s.mark && last.to === s.from) {
      out[out.length - 1] = s.mark === true ? { from: last.from, to: s.to, cls: s.cls, mark: true } : { from: last.from, to: s.to, cls: s.cls };
    } else {
      out.push(s);
    }
  }
  return out;
}

/**
 * The coloured segments of `source`: in order, without gaps or overlaps, covering `[0, source.length)` exactly; the
 * pieces inside one of `marks` carry `mark`.
 */
export function highlightPy(source: string, marks: readonly PySourceRange[] = []): PyHighlightSegment[] {
  const base: PyHighlightSegment[] = [];
  tokenSegments(source, lexPy(source).tokens, 0, source.length, 'text', base);
  return merge(applyMarks(base, marks));
}

/** Offsets where each line of `text` starts (a line ends at LF, CR LF or a lone CR, as the tokenizer counts). */
export function lineStarts(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 10) starts.push(i + 1);
    else if (c === 13) {
      if (text.charCodeAt(i + 1) === 10) i++;
      starts.push(i + 1);
    }
  }
  return starts;
}

/** Offset of 1-based `line` / `column` (clamped to the text). */
export function offsetOf(text: string, starts: readonly number[], line: number, column: number): number {
  const lineStart = starts[Math.min(Math.max(1, line), starts.length) - 1] ?? 0;
  return Math.min(text.length, Math.max(0, lineStart + Math.max(1, column) - 1));
}

const isBreak = (text: string, at: number): boolean => at >= text.length || text[at] === '\n' || text[at] === '\r';

/** The range a syntax error marks: its own span, else one character, moved back off a line end when it can. */
function markRange(text: string, starts: readonly number[], e: PySyntaxError): PySourceRange {
  const from = Math.min(text.length, Math.max(0, e.offset));
  if (e.endLine !== undefined && e.endColumn !== undefined) {
    // a span never ends with the line break it may reach (an error on a line's end token)
    let to = offsetOf(text, starts, e.endLine, e.endColumn);
    while (to > from && (text[to - 1] === '\n' || text[to - 1] === '\r')) to--;
    if (to > from) return { from, to };
  }
  if (!isBreak(text, from)) return { from, to: from + 1 };
  // at a line end or the end of the text: the last character of that line, if it has one
  const lineStart = starts[Math.min(Math.max(1, e.line), starts.length) - 1] ?? 0;
  let k = from - 1;
  while (k >= lineStart && (text[k] === ' ' || text[k] === '\t')) k--;
  return k >= lineStart && !isBreak(text, k) ? { from: k, to: k + 1 } : { from, to: from };
}

/** The mark of one syntax error. */
export function syntaxMarkOf(text: string, starts: readonly number[], e: PySyntaxError): PySyntaxMark {
  return {
    ...markRange(text, starts, e),
    type: e.type,
    message: e.message,
    line: e.line,
    column: e.column,
    text: `Line ${e.line}, column ${e.column}: ${e.type}: ${e.message}`,
  };
}

/**
 * The live syntax marks of `source`: the parser's first error (what a run reports) and every problem the tokenizer
 * found, one per position, in source order. Empty for a script that compiles.
 */
export function pySyntaxMarks(source: string): PySyntaxMark[] {
  const starts = lineStarts(source);
  const errors: PySyntaxError[] = [...lexPy(source).errors];
  const parsed = parsePy(source);
  if (!parsed.ok && !errors.some((e) => e.offset === parsed.error.offset && e.message === parsed.error.message)) errors.push(parsed.error);
  const seen = new Set<number>();
  const marks: PySyntaxMark[] = [];
  for (const e of [...errors].sort((a, b) => a.offset - b.offset)) {
    if (seen.has(e.offset)) continue;
    seen.add(e.offset);
    marks.push(syntaxMarkOf(source, starts, e));
  }
  return marks;
}

/** The error a run of `source` would stop on (the parser's first), or undefined when the script compiles. */
export function firstSyntaxError(source: string): PySyntaxMark | undefined {
  const parsed = parsePy(source);
  return parsed.ok ? undefined : syntaxMarkOf(source, lineStarts(source), parsed.error);
}

/** 1-based line of `offset` in `source`. */
export function lineOfOffset(source: string, offset: number): number {
  return textPositions(source)(offset).line;
}

/** The CSS classes of a segment. */
export function segmentClassName(s: Pick<PyHighlightSegment, 'cls' | 'mark'>): string {
  return s.mark === true ? `py-${s.cls} py-mark` : `py-${s.cls}`;
}

/**
 * The highlighted text (decorative: the overlay behind the editor's textarea). Plain white space is not wrapped in a
 * span unless a mark covers it.
 */
export function PyHighlight({ source, marks }: { source: string; marks?: readonly PySourceRange[] }): ReactNode {
  const segments = highlightPy(source, marks);
  return (
    <>
      {segments.map((s) =>
        s.cls === 'text' && s.mark !== true ? (
          source.slice(s.from, s.to)
        ) : (
          <span key={s.from} className={segmentClassName(s)}>
            {source.slice(s.from, s.to)}
          </span>
        ),
      )}
    </>
  );
}
