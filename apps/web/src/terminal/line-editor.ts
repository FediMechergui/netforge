/**
 * Client-side console line editor (spec §7.1: the line editor lives in the terminal
 * adapter; the engine only ever receives whole lines and completion/help queries).
 *
 * Pure and DOM-free so it can be unit tested: `handleKey` mutates the editor model and
 * returns the exact byte sequences a VT-compatible terminal (xterm.js) needs to show the
 * edit, including mid-line edits and input that wraps across rows.
 *
 * Screen model: the prompt starts at column 0 of a row; buffer index `i` sits at absolute
 * offset `promptLength + i`, i.e. row `floor(p / columns)`, column `p % columns`. The editor
 * never leaves the terminal in the "pending wrap" state (cursor parked past the last column):
 * whenever a write ends exactly on a row boundary it emits ` \r` so the physical cursor is
 * really at column 0 of the next row, and the following erase removes the spacer.
 *
 * Answer modes (P1, ARCHITECTURE-P1 §4.10). When a `CliResult` asks for input, the next line is an ANSWER, not a
 * command: it is never recalled, never remembered, and Tab and `?` are ordinary characters rather than completion
 * and help, because a password may contain them.
 *   • 'secret' also masks: the buffer grows but nothing is echoed, so the line occupies no screen columns at all.
 *     The cursor therefore stays at the end, motion keys do nothing, and Backspace / Ctrl+U edit the buffer in
 *     silence. Nothing typed in this mode can reach the scrollback, the history or storage.
 *   • 'confirm' masks nothing (a y/n answer is not a secret) but is still an answer, not a command.
 *
 * ponytail: masking is "the line is zero columns wide" rather than a second screen model — every write helper
 * already positions by column, so one early return per helper covers wrapping, erasing and redrawing.
 */

export interface KeyEventLike {
  key: string;
  code?: string;
  ctrlKey: boolean;
  altKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
}

export type EditorAction =
  | { type: 'none'; writes: string[] }
  | { type: 'edit'; writes: string[] }
  | { type: 'submit'; line: string; writes: string[] }
  | { type: 'complete'; partial: string; writes: string[] }
  | { type: 'help'; partial: string; writes: string[] }
  | { type: 'interrupt'; writes: string[] };

/**
 * @since P1 What the next submitted line is. 'normal' = a command; 'confirm' = an answer shown as typed;
 * 'secret' = an answer nothing echoes (`CliInputRequest.kind`, §4.10).
 */
export type EditorMode = 'normal' | 'confirm' | 'secret';

/** The editor mode a pending `CliInputRequest` puts the line in ('text' is answered in the clear). */
export function editorModeFor(kind: 'secret' | 'text' | 'confirm' | undefined): EditorMode {
  if (kind === 'secret') return 'secret';
  if (kind === 'text' || kind === 'confirm') return 'confirm';
  return 'normal';
}

/**
 * @since P1 The line shown while a job (ping, tracert, renew) holds the console (§4.10, CliSessionView.job).
 * Original wording; the key is named in text, never by colour alone.
 */
export function jobStatusLine(label: string): string {
  const name = label.trim() === '' ? 'The command' : label.trim();
  return `${name} is running — press Ctrl+C to stop it.`;
}

/** Lines remembered for ↑/↓ recall (matches the engine's per-session history limit). */
export const EDITOR_HISTORY_LIMIT = 50;

const CSI = '\x1b[';

type Command = 'left' | 'right' | 'home' | 'end' | 'prev' | 'next' | 'backspace' | 'delete' | 'word' | 'kill-start' | 'kill-end';

const NAMED_KEYS: Readonly<Record<string, Command>> = {
  ArrowLeft: 'left',
  ArrowRight: 'right',
  ArrowUp: 'prev',
  ArrowDown: 'next',
  Home: 'home',
  End: 'end',
  Backspace: 'backspace',
  Delete: 'delete',
};

const CTRL_LETTERS: Readonly<Record<string, Command>> = {
  a: 'home',
  e: 'end',
  b: 'left',
  f: 'right',
  p: 'prev',
  n: 'next',
  h: 'backspace',
  d: 'delete',
  w: 'word',
  u: 'kill-start',
  k: 'kill-end',
};

/** Raw sequences as xterm reports them in `onKey().key` (fallback when the DOM key is unhelpful). */
const SEQUENCES: Readonly<Record<string, Command>> = {
  '\x01': 'home',
  '\x05': 'end',
  '\x02': 'left',
  '\x06': 'right',
  '\x10': 'prev',
  '\x0e': 'next',
  '\x08': 'backspace',
  '\x7f': 'backspace',
  '\x04': 'delete',
  '\x17': 'word',
  '\x15': 'kill-start',
  '\x0b': 'kill-end',
  '\x1b[D': 'left',
  '\x1bOD': 'left',
  '\x1b[C': 'right',
  '\x1bOC': 'right',
  '\x1b[A': 'prev',
  '\x1bOA': 'prev',
  '\x1b[B': 'next',
  '\x1bOB': 'next',
  '\x1b[H': 'home',
  '\x1bOH': 'home',
  '\x1b[1~': 'home',
  '\x1b[F': 'end',
  '\x1bOF': 'end',
  '\x1b[4~': 'end',
  '\x1b[3~': 'delete',
};

/** ^C, ^^ (Ctrl+Shift+6) — abort the running command. Ctrl+Shift+C is left for copy. */
export function isInterruptKey(key: string, ev: KeyEventLike): boolean {
  if (key === '\x03' || key === '\x1e') return true;
  if (!ev.ctrlKey || ev.altKey || ev.metaKey) return false;
  if (ev.key.toLowerCase() === 'c' && !ev.shiftKey) return true;
  if (ev.key === '^') return true;
  return ev.shiftKey && (ev.key === '6' || ev.code === 'Digit6');
}

function isPrintableKey(key: string, ev: KeyEventLike): boolean {
  if (key.length === 0 || ev.metaKey) return false;
  // Ctrl alone is a control chord; Ctrl+Alt is AltGr on many layouts and yields real characters.
  if (ev.ctrlKey && !ev.altKey) return false;
  // A multi-character key equal to the DOM key name is a named key ("Shift", "F5"), not text.
  if (key.length > 1 && key === ev.key) return false;
  for (const ch of key) {
    const c = ch.codePointAt(0) ?? 0;
    if (c < 0x20 || c === 0x7f || (c >= 0x80 && c < 0xa0)) return false;
  }
  return true;
}

/** Strip control characters from inserted text (paste, completion); tabs become spaces. */
export function sanitizeInsert(text: string): string {
  return text.replace(/\t/g, ' ').replace(/[\x00-\x1f\x7f]/g, '');
}

export class LineEditor {
  buffer = '';
  cursor = 0;
  history: string[] = [];
  /** Index into `history` of the recalled line; `history.length` means "the line being typed". */
  historyIndex = 0;
  promptLength = 0;
  columns = Number.POSITIVE_INFINITY;
  /** @since P1 What the next submitted line is (§4.10). */
  mode: EditorMode = 'normal';
  private draft = '';

  /** Nothing of the line is on screen. */
  private get masked(): boolean {
    return this.mode === 'secret';
  }

  /** The line answers a question: no recall, no completion, and it is never remembered. */
  private get answering(): boolean {
    return this.mode !== 'normal';
  }

  /** @since P1 Start (or end) an answer. The half-typed line is dropped, so no command leaks into an answer. */
  setMode(mode: EditorMode): void {
    if (mode === this.mode) return;
    this.mode = mode;
    this.clear();
  }

  setColumns(cols: number): void {
    if (Number.isFinite(cols) && cols > 0) this.columns = Math.floor(cols);
  }

  setPromptLength(n: number): void {
    this.promptLength = Math.max(0, Math.floor(n));
  }

  /** Text before the cursor — what `?` help and Tab completion look at. */
  before(): string {
    return this.buffer.slice(0, this.cursor);
  }

  handleKey(key: string, ev: KeyEventLike): EditorAction {
    if (isInterruptKey(key, ev)) return { type: 'interrupt', writes: this.moveToEnd() };
    if (ev.key === 'Enter' || key === '\r' || key === '\n') return this.submit();
    // While answering a question, Tab is not completion: it is simply not a character a line may contain.
    if (ev.key === 'Tab' || key === '\t') return this.answering ? { type: 'none', writes: [] } : { type: 'complete', partial: this.before(), writes: [] };

    let cmd: Command | undefined;
    if (ev.ctrlKey && !ev.altKey && !ev.metaKey) cmd = CTRL_LETTERS[ev.key.toLowerCase()];
    if (cmd === undefined) cmd = NAMED_KEYS[ev.key];
    if (cmd === undefined) cmd = SEQUENCES[key];
    if (cmd !== undefined) {
      // Recall would put an earlier command into an answer (and show it), so it is off while answering.
      if (this.answering && (cmd === 'prev' || cmd === 'next')) return { type: 'none', writes: [] };
      return this.run(cmd);
    }

    // `?` is help on a command line and an ordinary character inside an answer (passwords may contain it).
    if (key === '?' && !ev.ctrlKey && !ev.metaKey && !this.answering) return { type: 'help', partial: this.before(), writes: [] };
    if (isPrintableKey(key, ev)) return { type: 'edit', writes: this.insert(key) };
    return { type: 'none', writes: [] };
  }

  /** Insert text at the cursor (typed characters, a completion suffix, a pasted fragment). */
  insert(text: string): string[] {
    const clean = sanitizeInsert(text);
    if (clean === '') return [];
    const at = this.cursor;
    this.buffer = this.buffer.slice(0, at) + clean + this.buffer.slice(at);
    return this.redrawFrom(at, at + clean.length);
  }

  /** Accept the current line (Enter, or a pasted line). */
  submitLine(): { line: string; writes: string[] } {
    if (this.masked) {
      const secret = this.buffer;
      this.clear();
      return { line: secret, writes: ['\r\n'] };
    }
    const line = this.buffer;
    const end = this.buffer.length;
    let out = this.move(this.cursor, end);
    // At an exact row boundary the cursor already sits at column 0 of a fresh row.
    if (!this.atWrapBoundary(end)) out += '\r\n';
    this.remember(line);
    this.clear();
    return { line, writes: out === '' ? [] : [out] };
  }

  /** Forget the line being edited (after ^C, a new prompt, a closed session). */
  clear(): void {
    this.buffer = '';
    this.cursor = 0;
    this.historyIndex = this.history.length;
    this.draft = '';
  }

  /**
   * Print `prompt` followed by the buffer and put the cursor back where it was. Assumes the
   * terminal cursor is at column 0 of an empty row.
   */
  redrawAll(prompt: string): string[] {
    this.setPromptLength(prompt.length);
    // Masked: the line is zero columns wide, so the prompt is the whole picture.
    if (this.masked) {
      this.cursor = this.buffer.length;
      return prompt === '' ? [] : [prompt];
    }
    let out = prompt + this.buffer;
    if (out.length > 0 && this.atWrapBoundary(this.buffer.length)) out += ` \r${CSI}K`;
    out += this.move(this.buffer.length, this.cursor);
    return out === '' ? [] : [out];
  }

  /** Erase the prompt and buffer from the screen (cursor ends at column 0 of the prompt row). */
  eraseForOutput(): string[] {
    const from = this.masked ? 0 : this.cursor;
    return [`${this.move(from, -this.promptLength)}\r${CSI}J`];
  }

  moveToEnd(): string[] {
    return this.moveTo(this.buffer.length);
  }

  moveTo(index: number): string[] {
    // Nothing is on screen to move through: the masked cursor is always at the end of the buffer.
    if (this.masked) {
      this.cursor = this.buffer.length;
      return [];
    }
    const target = Math.max(0, Math.min(this.buffer.length, index));
    const out = this.move(this.cursor, target);
    this.cursor = target;
    return out === '' ? [] : [out];
  }

  // ── internals ────────────────────────────────────────────────────────────

  private run(cmd: Command): EditorAction {
    switch (cmd) {
      case 'left':
        return { type: 'edit', writes: this.moveTo(this.cursor - 1) };
      case 'right':
        return { type: 'edit', writes: this.moveTo(this.cursor + 1) };
      case 'home':
        return { type: 'edit', writes: this.moveTo(0) };
      case 'end':
        return { type: 'edit', writes: this.moveToEnd() };
      case 'prev':
        return this.historyPrev();
      case 'next':
        return this.historyNext();
      case 'backspace':
        return { type: 'edit', writes: this.backspace() };
      case 'delete':
        return { type: 'edit', writes: this.deleteForward() };
      case 'word':
        return { type: 'edit', writes: this.deleteWordBefore() };
      case 'kill-start':
        return { type: 'edit', writes: this.killToStart() };
      case 'kill-end':
        return { type: 'edit', writes: this.killToEnd() };
    }
  }

  private submit(): EditorAction {
    const { line, writes } = this.submitLine();
    return { type: 'submit', line, writes };
  }

  private remember(line: string): void {
    // An answer is never recallable — a password must not be one ↑ away (§4.10).
    if (this.answering) return;
    const t = line.trim();
    if (t === '') return;
    if (this.history[this.history.length - 1] !== t) this.history.push(t);
    if (this.history.length > EDITOR_HISTORY_LIMIT) this.history.splice(0, this.history.length - EDITOR_HISTORY_LIMIT);
  }

  private historyPrev(): EditorAction {
    if (this.history.length === 0 || this.historyIndex <= 0) return { type: 'none', writes: [] };
    if (this.historyIndex >= this.history.length) this.draft = this.buffer;
    this.historyIndex = Math.min(this.historyIndex, this.history.length) - 1;
    return { type: 'edit', writes: this.replace(this.history[this.historyIndex] ?? '') };
  }

  private historyNext(): EditorAction {
    if (this.historyIndex >= this.history.length) return { type: 'none', writes: [] };
    this.historyIndex += 1;
    const text = this.historyIndex >= this.history.length ? this.draft : (this.history[this.historyIndex] ?? '');
    return { type: 'edit', writes: this.replace(text) };
  }

  private replace(text: string): string[] {
    this.buffer = text;
    return this.redrawFrom(0, text.length);
  }

  private backspace(): string[] {
    const c = this.cursor;
    if (c === 0) return [];
    this.buffer = this.buffer.slice(0, c - 1) + this.buffer.slice(c);
    return this.redrawFrom(c - 1, c - 1);
  }

  private deleteForward(): string[] {
    const c = this.cursor;
    if (c >= this.buffer.length) return [];
    this.buffer = this.buffer.slice(0, c) + this.buffer.slice(c + 1);
    return this.redrawFrom(c, c);
  }

  private deleteWordBefore(): string[] {
    let i = this.cursor;
    while (i > 0 && this.buffer[i - 1] === ' ') i--;
    while (i > 0 && this.buffer[i - 1] !== ' ') i--;
    if (i === this.cursor) return [];
    this.buffer = this.buffer.slice(0, i) + this.buffer.slice(this.cursor);
    return this.redrawFrom(i, i);
  }

  private killToStart(): string[] {
    if (this.cursor === 0) return [];
    this.buffer = this.buffer.slice(this.cursor);
    return this.redrawFrom(0, 0);
  }

  private killToEnd(): string[] {
    if (this.cursor >= this.buffer.length) return [];
    this.buffer = this.buffer.slice(0, this.cursor);
    return this.redrawFrom(this.cursor, this.cursor);
  }

  /**
   * The buffer has already been edited. Move from the physical cursor (`this.cursor`, an index
   * into the OLD layout, which is identical up to `from`) to `from`, rewrite the tail, clear
   * whatever the old, longer line left behind, and park the cursor on `target`.
   */
  private redrawFrom(from: number, target: number): string[] {
    // Masked: the edit happened, but there is nothing on screen to repaint.
    if (this.masked) {
      this.cursor = this.buffer.length;
      return [];
    }
    const end = this.buffer.length;
    const tail = this.buffer.slice(from);
    let out = this.move(this.cursor, from) + tail;
    if (tail.length > 0 && this.atWrapBoundary(end)) out += ' \r';
    out += `${CSI}J`;
    out += this.move(end, target);
    this.cursor = target;
    return [out];
  }

  private atWrapBoundary(index: number): boolean {
    const p = this.promptLength + index;
    return Number.isFinite(this.columns) && p > 0 && p % this.columns === 0;
  }

  /** Cursor motion between two buffer indices (index may be negative down to -promptLength). */
  private move(fromIndex: number, toIndex: number): string {
    if (fromIndex === toIndex) return '';
    const cols = this.columns;
    const pa = this.promptLength + fromIndex;
    const pb = this.promptLength + toIndex;
    const ra = Number.isFinite(cols) ? Math.floor(pa / cols) : 0;
    const rb = Number.isFinite(cols) ? Math.floor(pb / cols) : 0;
    const ca = Number.isFinite(cols) ? pa % cols : pa;
    const cb = Number.isFinite(cols) ? pb % cols : pb;
    let out = '';
    if (rb < ra) out += `${CSI}${ra - rb}A`;
    else if (rb > ra) out += `${CSI}${rb - ra}B`;
    if (ra === rb) {
      if (cb < ca) out += `${CSI}${ca - cb}D`;
      else if (cb > ca) out += `${CSI}${cb - ca}C`;
    } else {
      out += '\r';
      if (cb > 0) out += `${CSI}${cb}C`;
    }
    return out;
  }
}
