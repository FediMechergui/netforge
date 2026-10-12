/**
 * automation/CodeEditor.tsx — [S32] the script editor of the automation workspace (ARCHITECTURE-P3 §6 "Automation
 * workspace": a textarea editor with a gutter and an overlay highlighter from the pure NF-Py tokenizer, live syntax
 * marks; §7 W6 web-desktop).
 *
 * The text lives in a plain `<textarea>` (the one control: native caret, selection, clipboard, undo and screen reader
 * support). Behind it, a decorative `<pre>` draws the same text coloured by `py-highlight.tsx`, with the live syntax
 * marks underlined; the textarea's own text is transparent, so the colours show through and the caret and selection
 * stay native. A gutter at the left numbers the lines and flags a line with a glyph — `✕` for a syntax mark, `!` for
 * the line a run failed on — never with colour alone. The three layers scroll together.
 *
 * Keys (said in the hint the textarea is described by): Tab indents (four spaces, or every selected line), Shift+Tab
 * dedents, Enter keeps the line's indentation (one level more after a line ending in `:`, one less after `return`,
 * `pass`, `break`, `continue` or `raise`); Escape then Tab leaves the editor (so the keyboard is never trapped);
 * Ctrl+S saves and Ctrl+Enter runs. Each edit goes through the browser's own text insertion where it exists, so undo
 * keeps working; the pure edit helpers below compute it (and are what the tests exercise).
 */
import { useEffect, useId, useLayoutEffect, useMemo, useRef, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { PyHighlight, lineStarts, type PySyntaxMark } from './py-highlight';

/** A layout effect in the browser (the caret moves before paint), a plain effect where there is no DOM. */
const useBrowserLayoutEffect = typeof document === 'undefined' ? useEffect : useLayoutEffect;

/** Spaces of one indentation level (NF-Py follows Python's four). */
export const PY_INDENT = '    ';

/** A text change: replace `[from, to)` with `insert`, then select `[selStart, selEnd)` of the new text. */
export interface TextEdit {
  readonly from: number;
  readonly to: number;
  readonly insert: string;
  readonly selStart: number;
  readonly selEnd: number;
}

/** The text after `edit`. */
export function applyTextEdit(text: string, edit: Pick<TextEdit, 'from' | 'to' | 'insert'>): string {
  return text.slice(0, edit.from) + edit.insert + text.slice(edit.to);
}

/** Offset of the start of the line holding `at`. */
function lineStartAt(text: string, at: number): number {
  let k = Math.min(Math.max(0, at), text.length);
  while (k > 0 && text[k - 1] !== '\n' && text[k - 1] !== '\r') k--;
  return k;
}

/** Offset of the end of the line holding `at` (before its line break). */
function lineEndAt(text: string, at: number): number {
  let k = Math.min(Math.max(0, at), text.length);
  while (k < text.length && text[k] !== '\n' && text[k] !== '\r') k++;
  return k;
}

/** The whole lines a selection covers: a selection ending at the very start of a line leaves that line out. */
function coveredLines(text: string, start: number, end: number): { from: number; to: number } {
  const from = lineStartAt(text, start);
  const last = end > start && lineStartAt(text, end) === end ? end - 1 : end;
  return { from, to: lineEndAt(text, Math.max(start, last)) };
}

/** Map every line of `block` through `fn` (keeping its line breaks). */
function mapLines(block: string, fn: (line: string) => string): string {
  return block
    .split(/(\r\n|\n|\r)/)
    .map((piece, i) => (i % 2 === 1 ? piece : fn(piece)))
    .join('');
}

/**
 * Tab: with a caret (or a selection inside one line that is empty), spaces up to the next multiple of four; with a
 * selection, one level more on every selected line that has text.
 */
export function indentEdit(text: string, start: number, end: number): TextEdit {
  const a = Math.min(start, end);
  const b = Math.max(start, end);
  if (a === b) {
    const col = a - lineStartAt(text, a);
    const pad = ' '.repeat(PY_INDENT.length - (col % PY_INDENT.length));
    return { from: a, to: a, insert: pad, selStart: a + pad.length, selEnd: a + pad.length };
  }
  const { from, to } = coveredLines(text, a, b);
  const block = text.slice(from, to);
  const insert = mapLines(block, (line) => (line.trim() === '' ? line : PY_INDENT + line));
  // a selection that starts inside the first line moves with its text; one that starts at the line start stays there
  const firstHasText = text.slice(from, lineEndAt(text, from)).trim() !== '';
  const selStart = firstHasText && a > from ? a + PY_INDENT.length : a;
  return { from, to, insert, selStart, selEnd: b + (insert.length - block.length) };
}

/** Leading white space a dedent removes from `line`: up to one level of spaces, or one tab. */
function dedentWidth(line: string): number {
  if (line.startsWith('\t')) return 1;
  let n = 0;
  while (n < PY_INDENT.length && line[n] === ' ') n++;
  return n;
}

/** Shift+Tab: one level less on every line the caret or selection touches. */
export function dedentEdit(text: string, start: number, end: number): TextEdit {
  const a = Math.min(start, end);
  const b = Math.max(start, end);
  const { from, to } = coveredLines(text, a, b);
  const block = text.slice(from, to);
  const insert = mapLines(block, (line) => line.slice(dedentWidth(line)));
  // a caret inside the removed spaces lands at the line start; one after them moves back with the text
  const firstCut = dedentWidth(text.slice(from, lineEndAt(text, from)));
  const selStart = Math.max(from, a - firstCut);
  const selEnd = a === b ? selStart : Math.max(selStart, b - (block.length - insert.length));
  return { from, to, insert, selStart, selEnd };
}

/** Statements after which the next line goes one level back. */
const BLOCK_ENDERS = /^(?:return|pass|break|continue|raise)\b/;

/**
 * Enter: a line break plus the current line's indentation — one level more after a line ending in `:` (a comment
 * after it ignored), one level less after a block-ending statement. Replaces a selection.
 */
export function newlineEdit(text: string, start: number, end: number): TextEdit {
  const a = Math.min(start, end);
  const b = Math.max(start, end);
  const lineStart = lineStartAt(text, a);
  const before = text.slice(lineStart, a);
  const indent = /^[ \t]*/.exec(before)?.[0] ?? '';
  const code = before.replace(/#[^'"]*$/, '').trimEnd();
  let next = indent;
  if (code.endsWith(':')) next = indent + PY_INDENT;
  else if (BLOCK_ENDERS.test(code.trimStart())) next = indent.slice(0, Math.max(0, indent.length - dedentWidth(indent)));
  const insert = `\n${next}`;
  return { from: a, to: b, insert, selStart: a + insert.length, selEnd: a + insert.length };
}

/** One line of the gutter. */
export interface GutterLine {
  /** 1-based line number. */
  readonly n: number;
  /** `✕` for a syntax mark, `!` for the line a run failed on, else empty. */
  readonly glyph: '' | '✕' | '!';
  /** What the glyph means, in words (a tooltip; the status line and the traceback say it for screen readers). */
  readonly title?: string;
}

/** The gutter of `text`: one entry per line, flagged by the syntax marks and the failing line of the last run. */
export function gutterLines(text: string, marks: readonly Pick<PySyntaxMark, 'line' | 'text'>[] = [], failedLine?: number, failedText?: string): GutterLine[] {
  const count = lineStarts(text).length;
  const syntax = new Map<number, string>();
  for (const m of marks) if (!syntax.has(m.line)) syntax.set(m.line, m.text);
  const out: GutterLine[] = [];
  for (let n = 1; n <= count; n++) {
    const s = syntax.get(n);
    if (s !== undefined) out.push({ n, glyph: '✕', title: s });
    else if (failedLine === n) out.push({ n, glyph: '!', title: failedText ?? 'The last run stopped on this line.' });
    else out.push({ n, glyph: '' });
  }
  return out;
}

/** The hint the editor is described by. */
export const CODE_EDITOR_HINT =
  'Tab indents and Shift+Tab dedents; Enter keeps the indentation. Press Escape, then Tab, to leave the editor. Ctrl+S saves, Ctrl+Enter runs.';

/** What the workspace can ask of the editor. */
export interface CodeEditorHandle {
  /** Focus the editor with line `n` (1-based) selected. */
  revealLine(n: number): void;
}

export interface CodeEditorProps {
  readonly value: string;
  readonly onChange: (value: string) => void;
  /** The accessible name of the textarea. */
  readonly label: string;
  /** Ids of other elements that describe the editor (the syntax status line). */
  readonly describedBy?: string;
  readonly marks?: readonly PySyntaxMark[];
  /** The line the last run of this file failed on, and its last traceback line. */
  readonly failedLine?: number;
  readonly failedText?: string;
  readonly readOnly?: boolean;
  readonly onSave?: () => void;
  readonly onRun?: () => void;
  /** Receives the handle once mounted (null when unmounted). */
  readonly handleRef?: (h: CodeEditorHandle | null) => void;
}

/** Apply `edit` to the textarea through the browser's text insertion (undo keeps it), else through `onChange`. */
function applyToTextarea(ta: HTMLTextAreaElement, edit: TextEdit, onChange: (v: string) => void, pending: { current: TextEdit | null }): void {
  const expected = applyTextEdit(ta.value, edit);
  ta.setSelectionRange(edit.from, edit.to);
  let inserted = false;
  try {
    // an empty insertion would be a no-op command in some browsers: let the fallback delete instead
    inserted = edit.insert !== '' && typeof document !== 'undefined' && typeof document.execCommand === 'function' && document.execCommand('insertText', false, edit.insert);
  } catch {
    inserted = false;
  }
  if (inserted && ta.value === expected) {
    ta.setSelectionRange(edit.selStart, edit.selEnd);
    return;
  }
  pending.current = edit;
  onChange(expected);
}

export function CodeEditor(props: CodeEditorProps) {
  const { value, onChange, label, describedBy, marks = [], failedLine, failedText, readOnly = false, onSave, onRun, handleRef } = props;
  const uid = useId();
  const taRef = useRef<HTMLTextAreaElement>(null);
  const hlRef = useRef<HTMLPreElement>(null);
  const gutterRef = useRef<HTMLDivElement>(null);
  const tabLeaves = useRef(false);
  const pendingSel = useRef<TextEdit | null>(null);
  const gutter = useMemo(() => gutterLines(value, marks, failedLine, failedText), [value, marks, failedLine, failedText]);
  const hintId = `${uid}-hint`;

  // a programmatic edit (no browser insertion) puts the caret back once React has written the new value
  useBrowserLayoutEffect(() => {
    const p = pendingSel.current;
    const ta = taRef.current;
    if (p === null || ta === null) return;
    pendingSel.current = null;
    ta.setSelectionRange(p.selStart, p.selEnd);
  }, [value]);

  useEffect(() => {
    if (handleRef === undefined) return;
    handleRef({
      revealLine(n: number) {
        const ta = taRef.current;
        if (ta === null) return;
        const starts = lineStarts(ta.value);
        const from = starts[Math.min(Math.max(1, n), starts.length) - 1] ?? 0;
        ta.focus();
        ta.setSelectionRange(from, lineEndAt(ta.value, from));
      },
    });
    return () => handleRef(null);
  }, [handleRef]);

  const syncScroll = (): void => {
    const ta = taRef.current;
    if (ta === null) return;
    if (hlRef.current !== null) {
      hlRef.current.scrollTop = ta.scrollTop;
      hlRef.current.scrollLeft = ta.scrollLeft;
    }
    if (gutterRef.current !== null) gutterRef.current.scrollTop = ta.scrollTop;
  };

  const onKeyDown = (e: ReactKeyboardEvent<HTMLTextAreaElement>): void => {
    const ta = e.currentTarget;
    const mod = e.ctrlKey || e.metaKey;
    if (e.key === 'Escape') {
      tabLeaves.current = true;
      return;
    }
    const leave = tabLeaves.current;
    tabLeaves.current = false;
    if (mod && (e.key === 's' || e.key === 'S')) {
      e.preventDefault();
      onSave?.();
      return;
    }
    if (mod && e.key === 'Enter') {
      e.preventDefault();
      onRun?.();
      return;
    }
    if (readOnly || e.altKey || mod || e.nativeEvent.isComposing) return;
    if (e.key === 'Tab') {
      if (leave) return; // Escape, then Tab: the browser moves focus on
      e.preventDefault();
      const edit = e.shiftKey ? dedentEdit(ta.value, ta.selectionStart, ta.selectionEnd) : indentEdit(ta.value, ta.selectionStart, ta.selectionEnd);
      applyToTextarea(ta, edit, onChange, pendingSel);
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      applyToTextarea(ta, newlineEdit(ta.value, ta.selectionStart, ta.selectionEnd), onChange, pendingSel);
    }
  };

  return (
    <div className={`auto-editor ${marks.length > 0 ? 'has-marks' : ''}`}>
      <div ref={gutterRef} className="auto-gutter" aria-hidden="true">
        {gutter.map((g) => (
          <div key={g.n} className={`auto-gutter-line ${g.glyph === '✕' ? 'is-syntax' : g.glyph === '!' ? 'is-failed' : ''}`} title={g.title}>
            <span className="auto-gutter-glyph">{g.glyph}</span>
            {g.n}
          </div>
        ))}
      </div>
      <div className="auto-code">
        <pre ref={hlRef} className="auto-hl" aria-hidden="true">
          <PyHighlight source={value} marks={marks} />
          {'\n'}
        </pre>
        <textarea
          ref={taRef}
          className="auto-input"
          value={value}
          readOnly={readOnly}
          wrap="off"
          spellCheck={false}
          autoCapitalize="off"
          autoComplete="off"
          autoCorrect="off"
          aria-label={label}
          aria-invalid={marks.length > 0}
          aria-describedby={[hintId, describedBy ?? ''].filter((x) => x !== '').join(' ')}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={onKeyDown}
          onScroll={syncScroll}
        />
      </div>
      <span id={hintId} className="auto-visually-hidden">
        {CODE_EDITOR_HINT}
      </span>
    </div>
  );
}
