/**
 * Console line editor in answer mode (ARCHITECTURE-P1 §4.10, §10.2 "Web P1": line-editor secret mode).
 *
 * The editor is pure, so this drives it directly: what it echoes, what it remembers and what it reports back to the
 * terminal. The rule under test is that a secret answer leaves no trace anywhere — not on screen, not in the recall
 * history, not in a completion query.
 */
import { describe, expect, it } from 'vitest';
import { EDITOR_HISTORY_LIMIT, LineEditor, editorModeFor, isInterruptKey, jobStatusLine, type EditorAction, type KeyEventLike } from '../src/terminal/line-editor';

const key = (k: string, mods: Partial<KeyEventLike> = {}): KeyEventLike => ({ key: k, ctrlKey: false, altKey: false, metaKey: false, shiftKey: false, ...mods });

/** Type `text` one character at a time; returns every action the editor produced. */
function type(ed: LineEditor, text: string): EditorAction[] {
  return [...text].map((ch) => ed.handleKey(ch, key(ch)));
}

const writesOf = (actions: readonly EditorAction[]): string[] => actions.flatMap((a) => a.writes);

function press(ed: LineEditor, k: string, mods: Partial<KeyEventLike> = {}): EditorAction {
  return ed.handleKey(k.length === 1 && mods.ctrlKey !== true ? k : '', key(k, mods));
}

describe('editorModeFor', () => {
  it('maps the input kinds the CLI can ask for', () => {
    expect(editorModeFor('secret')).toBe('secret');
    expect(editorModeFor('confirm')).toBe('confirm');
    expect(editorModeFor('text')).toBe('confirm');
    expect(editorModeFor(undefined)).toBe('normal');
  });
});

describe('secret answers', () => {
  it('echoes nothing at all while the buffer fills', () => {
    const ed = new LineEditor();
    ed.setPromptLength('Password: '.length);
    ed.setMode('secret');
    const actions = type(ed, 'nf-secret');
    expect(writesOf(actions)).toEqual([]);
    expect(actions.every((a) => a.type === 'edit')).toBe(true);
    expect(ed.buffer).toBe('nf-secret');
    expect(ed.cursor).toBe(ed.buffer.length);
  });

  it('treats ? and Tab as characters, not as help and completion', () => {
    const ed = new LineEditor();
    ed.setMode('secret');
    const q = ed.handleKey('?', key('?'));
    expect(q.type).toBe('edit');
    expect(q.writes).toEqual([]);
    const tab = ed.handleKey('\t', key('Tab'));
    expect(tab).toEqual({ type: 'none', writes: [] });
    expect(ed.buffer).toBe('?');
  });

  it('submits the answer, prints only the line break and remembers nothing', () => {
    const ed = new LineEditor();
    ed.setMode('secret');
    type(ed, 'hunter2');
    const done = ed.handleKey('\r', key('Enter'));
    expect(done).toEqual({ type: 'submit', line: 'hunter2', writes: ['\r\n'] });
    expect(ed.history).toEqual([]);
    expect(ed.buffer).toBe('');
  });

  it('never recalls: the arrows do nothing and earlier commands stay out of reach', () => {
    const ed = new LineEditor();
    type(ed, 'enable');
    ed.handleKey('\r', key('Enter'));
    expect(ed.history).toEqual(['enable']);
    ed.setMode('secret');
    expect(press(ed, 'ArrowUp')).toEqual({ type: 'none', writes: [] });
    expect(press(ed, 'ArrowDown')).toEqual({ type: 'none', writes: [] });
    expect(ed.buffer).toBe('');
  });

  it('edits in silence: Backspace drops the last character and Ctrl+U clears the answer', () => {
    const ed = new LineEditor();
    ed.setMode('secret');
    type(ed, 'abcd');
    expect(press(ed, 'Backspace').writes).toEqual([]);
    expect(ed.buffer).toBe('abc');
    expect(ed.handleKey('', key('u', { ctrlKey: true })).writes).toEqual([]);
    expect(ed.buffer).toBe('');
  });

  it('draws the question alone and erases it without counting typed columns', () => {
    const ed = new LineEditor();
    ed.setColumns(20);
    ed.setMode('secret');
    type(ed, 'a-very-long-password-that-would-wrap');
    expect(ed.redrawAll('Password: ')).toEqual(['Password: ']);
    // The erase walks back over the prompt only: nothing of the answer is on screen.
    const erase = ed.eraseForOutput().join('');
    expect(erase).not.toContain('A'); // no cursor-up: the line never wrapped
    expect(erase.endsWith('\r\x1b[J')).toBe(true);
  });

  it('still reports ^C, so the terminal can drop the question', () => {
    const ed = new LineEditor();
    ed.setMode('secret');
    type(ed, 'half');
    const action = ed.handleKey('\x03', key('c', { ctrlKey: true }));
    expect(action.type).toBe('interrupt');
    expect(action.writes).toEqual([]);
    expect(isInterruptKey('\x03', key('c', { ctrlKey: true }))).toBe(true);
  });

  it('drops a half-typed command when a question arrives, and restores normal editing after it', () => {
    const ed = new LineEditor();
    type(ed, 'show run');
    ed.setMode('secret');
    expect(ed.buffer).toBe('');
    type(ed, 'pw');
    ed.handleKey('\r', key('Enter'));
    ed.setMode('normal');
    const echoed = type(ed, 'exit');
    expect(writesOf(echoed).join('')).toContain('e');
    ed.handleKey('\r', key('Enter'));
    expect(ed.history).toEqual(['exit']);
  });
});

describe('confirm answers', () => {
  it('echo as typed but are still answers, not commands', () => {
    const ed = new LineEditor();
    ed.setMode('confirm');
    const actions = type(ed, 'yes');
    expect(writesOf(actions).join('')).toContain('y');
    expect(ed.handleKey('\t', key('Tab'))).toEqual({ type: 'none', writes: [] });
    const done = ed.handleKey('\r', key('Enter'));
    expect(done.type).toBe('submit');
    expect(done.type === 'submit' && done.line).toBe('yes');
    expect(ed.history).toEqual([]);
  });

  it('keeps ordinary commands recallable once the question is answered', () => {
    const ed = new LineEditor();
    type(ed, 'ping 10.0.0.2');
    ed.handleKey('\r', key('Enter'));
    ed.setMode('confirm');
    type(ed, 'n');
    ed.handleKey('\r', key('Enter'));
    ed.setMode('normal');
    const recalled = press(ed, 'ArrowUp');
    expect(recalled.type).toBe('edit');
    expect(ed.buffer).toBe('ping 10.0.0.2');
    expect(ed.history.length).toBeLessThanOrEqual(EDITOR_HISTORY_LIMIT);
  });
});

describe('job status line', () => {
  it('names the job and the key that stops it, in text', () => {
    expect(jobStatusLine('ping')).toBe('ping is running — press Ctrl+C to stop it.');
    expect(jobStatusLine('  tracert ')).toBe('tracert is running — press Ctrl+C to stop it.');
  });

  it('falls back to wording that still works without a label', () => {
    expect(jobStatusLine('')).toBe('The command is running — press Ctrl+C to stop it.');
  });
});
