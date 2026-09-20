/**
 * One console: an xterm.js instance bound to one CLI session.
 *
 * All terminal work for a session (keystrokes, command execution, completion/help queries,
 * pastes, streamed output) runs through ONE serial task queue so writes never interleave.
 * Exec protocol: after `cliExec` resolves, its `output` is printed (parse errors already
 * carry the caret line), then the tab waits for the `cliPrompt` event the runtime emits at
 * the end of every non-empty exec — that event is the delimiter which says whether the
 * session is busy (a ping streams `cliOutput` until a `cliPrompt` with busy:false arrives).
 *
 * Input requests (P1, ARCHITECTURE-P1 §4.10): a `CliResult` or a `cliPrompt` event may carry `input`, meaning the
 * next line is an ANSWER. The request's own prompt ("Password: ") replaces the session prompt and the line editor
 * switches mode: a 'secret' answer echoes nothing, enters no history and is never written anywhere; a 'confirm'
 * answer is shown as typed but is still not a command. `^C` at such a prompt drops the question through
 * `cliInterrupt`. A login session asks before any command is typed, so the replay in `boot()` honours it too.
 *
 * Jobs (§4.10): while a job holds the console the tab prints one status line naming the key that stops it, and
 * `^C` sends `cliInterrupt` straight away (never through the serial queue, which may be parked on that very job).
 */
import { useCallback, useEffect, useRef } from 'react';
import { Terminal, type IDisposable, type ITheme } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import type { CliCompletion, CliInputRequest, SessionId } from '@netforge/engine';
import { engine } from '../bridge/client';
import { store, useStore } from '../store/store';
import type { TerminalTab as TerminalTabInfo } from '../store/types';
import { LineEditor, editorModeFor, isInterruptKey, jobStatusLine, sanitizeInsert, type KeyEventLike } from './line-editor';
import { nextStoreChange, useSessionOutput, type SessionCursor } from './use-session-output';
import './terminal.css';

const SCROLLBACK = 2000;
/** How long to wait for an exec's closing `cliPrompt` before trusting `CliResult.busy`. */
const DELIMITER_WAIT_MS = 1500;
/** Wall time "Session closed." stays visible before the tab goes away. */
const CLOSE_DELAY_MS = 700;
const BELL = '\x07';

type ConsoleState = 'idle' | 'busy' | 'closed';

function cssVar(name: string, fallback: string): string {
  if (typeof document === 'undefined') return fallback;
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v === '' ? fallback : v;
}

function readTheme(): ITheme {
  const bg = cssVar('--bg', '#0f1216');
  const text = cssVar('--text', '#e6e9ef');
  return {
    background: bg,
    foreground: text,
    cursor: cssVar('--accent', '#56b4e9'),
    cursorAccent: bg,
    selectionBackground: cssVar('--sel-strong', 'rgba(86, 180, 233, 0.35)'),
    black: bg,
    red: cssVar('--err', '#d55e00'),
    green: cssVar('--ok', '#009e73'),
    yellow: cssVar('--warn', '#e69f00'),
    blue: cssVar('--blue-deep', '#0072b2'),
    magenta: cssVar('--purple', '#cc79a7'),
    cyan: cssVar('--accent', '#56b4e9'),
    white: cssVar('--text-dim', '#8a93a5'),
    brightBlack: cssVar('--text-faint', '#5d6678'),
    brightWhite: text,
  };
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function toTerminal(text: string): string {
  return text.replace(/\r?\n/g, '\r\n');
}

/** Candidate tokens laid out in columns that fit `cols`. */
function formatColumns(tokens: readonly string[], cols: number): string {
  const width = tokens.reduce((w, t) => Math.max(w, t.length), 0) + 2;
  const perRow = Math.max(1, Math.floor(Math.max(cols, width) / width));
  const lines: string[] = [];
  for (let i = 0; i < tokens.length; i += perRow) {
    const row = tokens.slice(i, i + perRow);
    lines.push(row.map((t, j) => (j === row.length - 1 ? t : t.padEnd(width))).join(''));
  }
  return lines.join('\n');
}

/** The `?` table: token column padded, then its help text; `<cr>` when the line can run as is. */
function formatHelp(res: CliCompletion): string {
  const rows: [string, string][] = res.items.map((i) => [i.token, i.help]);
  if (res.cr) rows.push(['<cr>', 'Run the command as typed']);
  if (rows.length === 0) return '% Nothing further can be entered at this point.';
  const width = rows.reduce((w, [t]) => Math.max(w, t.length), 0);
  return rows.map(([t, h]) => `  ${t.padEnd(width)}  ${h}`.trimEnd()).join('\n');
}

class ConsoleController {
  private readonly term: Terminal;
  private readonly fitAddon = new FitAddon();
  private readonly editor = new LineEditor();
  private readonly disposables: IDisposable[] = [];
  private readonly resizeObserver: ResizeObserver;
  private readonly themeObserver: MutationObserver;
  private readonly pending: SessionEventQueue = [];
  private queue: Promise<void> = Promise.resolve();
  private state: ConsoleState = 'idle';
  private prompt = '';
  /** The question the session is waiting for an answer to (§4.10), if any. */
  private input: CliInputRequest | undefined;
  /** The last character written was a newline (or nothing has been written). */
  private atLineStart = true;
  /** The prompt and the editable line are currently on screen. */
  private lineVisible = false;
  /** No prompt known yet (the session's first `cliPrompt` has not arrived). */
  private awaitingFirstPrompt = false;
  private drainQueued = false;
  private pasteAborted = false;
  private closeTimer: ReturnType<typeof setTimeout> | undefined;
  private disposed = false;
  /** Set by onKey: xterm fires onData synchronously right after onKey for the same keystroke. */
  private skipNextData = false;

  constructor(
    private readonly host: HTMLElement,
    private readonly session: SessionId,
    hostname: string,
    private readonly cursor: SessionCursor,
  ) {
    this.term = new Terminal({
      scrollback: SCROLLBACK,
      fontFamily: cssVar('--mono', 'monospace'),
      fontSize: 13,
      lineHeight: 1.15,
      cursorBlink: true,
      allowTransparency: false,
      theme: readTheme(),
    });
    this.term.loadAddon(this.fitAddon);
    this.term.open(host);
    this.fit();

    this.term.attachCustomKeyEventHandler((ev) => this.filterKey(ev));
    this.disposables.push(
      this.term.onKey(({ key, domEvent }) => {
        this.skipNextData = true;
        queueMicrotask(() => {
          this.skipNextData = false;
        });
        this.onKey(key, domEvent);
      }),
      this.term.onData((data) => this.onData(data)),
      this.term.onResize(({ cols }) => this.editor.setColumns(cols)),
    );
    host.addEventListener('paste', this.onPaste, true);

    this.resizeObserver = new ResizeObserver(() => this.fit());
    this.resizeObserver.observe(host);
    this.themeObserver = new MutationObserver(() => {
      this.term.options.theme = readTheme();
    });
    this.themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

    this.boot(hostname);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.closeTimer !== undefined) {
      clearTimeout(this.closeTimer);
      this.closeTimer = undefined;
      void engine.cliClose(this.session).catch(() => undefined);
    }
    this.host.removeEventListener('paste', this.onPaste, true);
    this.resizeObserver.disconnect();
    this.themeObserver.disconnect();
    for (const d of this.disposables) d.dispose();
    this.term.dispose();
  }

  fit(): void {
    if (this.disposed || this.host.clientWidth === 0 || this.host.clientHeight === 0) return;
    try {
      this.fitAddon.fit();
    } catch {
      /* the renderer is not measurable yet (hidden ancestor) — the next resize retries */
    }
    this.editor.setColumns(this.term.cols);
  }

  focus(): void {
    if (!this.disposed) this.term.focus();
  }

  /** Called when the store brings new events for this session. Coalesced into one queued drain. */
  scheduleDrain(): void {
    if (this.drainQueued || this.disposed) return;
    this.drainQueued = true;
    this.enqueue(() => {
      this.drainQueued = false;
      this.drainNow();
    });
  }

  // ── start-up ───────────────────────────────────────────────────────────────

  private boot(hostname: string): void {
    this.cursor.reset();
    this.writeText(`Console connected to ${hostname}.\n`);
    // Replay what the session printed before this terminal existed (the login banner) and
    // pick up its prompt — including a question it is already waiting on (console login).
    for (const ev of this.cursor.take()) {
      if (ev.kind === 'cliOutput') this.writeText(ev.text);
      else {
        if (ev.prompt !== '') this.prompt = ev.prompt;
        this.applyInput(ev.input);
      }
    }
    const view = store.getState().snapshot?.sessions.find((s) => s.id === this.session);
    if (view !== undefined) {
      if (this.prompt === '') this.prompt = view.prompt;
      if (this.input === undefined) this.applyInput(view.input);
    }
    if (this.prompt === '' && this.input === undefined) {
      this.awaitingFirstPrompt = true;
      return;
    }
    this.newPrompt();
  }

  /**
   * Start or end an answer (§4.10): the request's own prompt replaces the session prompt and the editor switches
   * between command editing, a visible answer and a masked one.
   */
  private applyInput(next: CliInputRequest | undefined): void {
    this.input = next === undefined ? undefined : { ...next };
    this.editor.setMode(editorModeFor(next?.kind));
  }

  /** What the editable line is prefixed with: a pending question, otherwise the session prompt. */
  private promptText(): string {
    return this.input === undefined ? this.prompt : this.input.prompt;
  }

  // ── output primitives ──────────────────────────────────────────────────────

  private emit(chunks: readonly string[]): void {
    const data = chunks.join('');
    if (data === '' || this.disposed) return;
    this.term.write(data);
    this.atLineStart = data.endsWith('\n');
  }

  private writeText(text: string): void {
    this.emit([toTerminal(text)]);
  }

  private ensureNewline(): void {
    if (this.lineVisible) {
      this.emit(this.editor.moveToEnd());
      this.lineVisible = false;
      this.atLineStart = false;
    }
    if (!this.atLineStart) this.emit(['\r\n']);
  }

  /** Fresh prompt with an empty line. */
  private newPrompt(): void {
    this.ensureNewline();
    this.editor.clear();
    this.emit(this.editor.redrawAll(this.promptText()));
    this.lineVisible = true;
  }

  /** Prompt again with the line the user had typed (after help, candidates, async output). */
  private restorePrompt(): void {
    this.ensureNewline();
    this.emit(this.editor.redrawAll(this.promptText()));
    this.lineVisible = true;
  }

  /** Output that arrives while the user is at the prompt (debug lines): print above the line. */
  private printAboveLine(text: string): void {
    if (this.lineVisible) {
      this.emit(this.editor.eraseForOutput());
      this.atLineStart = true;
      this.lineVisible = false;
      this.writeText(text);
      this.restorePrompt();
    } else {
      this.writeText(text);
    }
  }

  private report(err: unknown): void {
    if (this.disposed) return;
    this.ensureNewline();
    this.writeText(`% The console could not complete that request: ${errorText(err)}\n`);
    if (this.state === 'idle') this.restorePrompt();
  }

  // ── serial queue ───────────────────────────────────────────────────────────

  private enqueue(task: () => void | Promise<void>): void {
    this.queue = this.queue
      .then(async () => {
        if (!this.disposed) await task();
      })
      .catch((err: unknown) => this.report(err));
  }

  /** Pull and render every unconsumed session event according to the current state. */
  private drainNow(): void {
    if (this.disposed) return;
    this.pending.push(...this.cursor.take());
    let idleText = '';
    const flushIdleText = (): void => {
      if (idleText !== '') {
        this.printAboveLine(idleText);
        idleText = '';
      }
    };
    while (this.pending.length > 0) {
      const ev = this.pending.shift();
      if (ev === undefined) break;
      if (this.state === 'closed') continue;
      if (this.state === 'busy') {
        if (ev.kind === 'cliOutput') {
          this.writeText(ev.text);
        } else {
          if (ev.prompt !== '') this.prompt = ev.prompt;
          this.applyInput(ev.input);
          if (!ev.busy) {
            this.state = 'idle';
            this.newPrompt();
          }
        }
        continue;
      }
      // idle
      if (ev.kind === 'cliOutput') {
        idleText += ev.text.endsWith('\n') ? ev.text : `${ev.text}\n`;
        continue;
      }
      flushIdleText();
      if (ev.prompt !== '') this.prompt = ev.prompt;
      this.applyInput(ev.input);
      if (this.awaitingFirstPrompt && this.promptText() !== '') {
        this.awaitingFirstPrompt = false;
        this.newPrompt();
      }
    }
    flushIdleText();
  }

  // ── keyboard ───────────────────────────────────────────────────────────────

  private filterKey(ev: KeyboardEvent): boolean {
    if (ev.type !== 'keydown') return true;
    const k = ev.key.toLowerCase();
    // Let the browser run its native paste / copy so our paste listener and xterm's copy work.
    if ((ev.ctrlKey || ev.metaKey) && k === 'v') return false;
    if ((ev.ctrlKey && ev.shiftKey && k === 'c') || (ev.metaKey && k === 'c')) return false;
    if (ev.ctrlKey && !ev.shiftKey && k === 'c' && this.term.hasSelection()) return false;
    // Ctrl+Shift+6 does not map to a control code on every layout; handle it here.
    if (ev.ctrlKey && !ev.altKey && (ev.key === '^' || (ev.shiftKey && (ev.key === '6' || ev.code === 'Digit6')))) {
      ev.preventDefault();
      this.onKey('\x1e', ev);
      return false;
    }
    return true;
  }

  /**
   * Text xterm could not tie to a keydown/keypress: IME and composition results, dead-key
   * characters, tablet virtual keyboards, text inserted by assistive tools. xterm reports it only
   * through onData, so it is fed to the line editor one character at a time. Keystrokes that already
   * went through onKey are skipped via `skipNextData`.
   */
  private onData(data: string): void {
    if (this.skipNextData) {
      this.skipNextData = false;
      return;
    }
    if (this.disposed || this.state === 'closed') return;
    for (const ch of data) {
      const ev: KeyEventLike = {
        key: ch === '\r' ? 'Enter' : ch,
        ctrlKey: false,
        altKey: false,
        metaKey: false,
        shiftKey: false,
      };
      this.enqueue(() => this.handleKey(ch, ev));
    }
  }

  private onKey(key: string, ev: KeyEventLike): void {
    if (this.disposed || this.state === 'closed') return;
    if (this.state === 'busy' && isInterruptKey(key, ev)) {
      // Not queued: the queue may be parked inside a paste waiting for this very job.
      this.pasteAborted = true;
      engine.cliInterrupt(this.session).catch((err: unknown) => this.report(err));
      return;
    }
    const snapshot: KeyEventLike = {
      key: ev.key,
      ctrlKey: ev.ctrlKey,
      altKey: ev.altKey,
      metaKey: ev.metaKey,
      shiftKey: ev.shiftKey,
    };
    if (ev.code !== undefined) snapshot.code = ev.code;
    this.enqueue(() => this.handleKey(key, snapshot));
  }

  private async handleKey(key: string, ev: KeyEventLike): Promise<void> {
    if (this.state !== 'idle') return;
    const action = this.editor.handleKey(key, ev);
    switch (action.type) {
      case 'none':
      case 'edit':
        this.emit(action.writes);
        return;
      case 'submit':
        this.emit(action.writes);
        this.atLineStart = true;
        this.lineVisible = false;
        await this.runLine(action.line);
        return;
      case 'complete':
        await this.complete(action.partial);
        return;
      case 'help':
        await this.help(action.partial);
        return;
      case 'interrupt':
        this.emit(action.writes);
        this.lineVisible = false;
        this.emit(['^C\r\n']);
        if (this.input !== undefined) {
          // §4.10: the engine drops the question; its `cliPrompt` brings the ordinary prompt back.
          this.applyInput(undefined);
          await engine.cliInterrupt(this.session).catch((err: unknown) => this.report(err));
          if (this.disposed) return;
        }
        this.newPrompt();
        return;
    }
  }

  // ── commands ───────────────────────────────────────────────────────────────

  private async runLine(line: string): Promise<void> {
    // An empty ANSWER is still an answer (a wrong password costs an attempt); an empty command is not.
    if (line.trim() === '' && this.input === undefined) {
      this.newPrompt();
      return;
    }
    // Anything that arrived before this command belongs above it.
    this.drainNow();

    let result;
    try {
      result = await engine.cliExec(this.session, line);
    } catch (err) {
      if (this.disposed) return;
      this.ensureNewline();
      this.writeText(`% The simulator did not answer: ${errorText(err)}\n`);
      this.newPrompt();
      return;
    }
    if (this.disposed) return;
    if (result.prompt !== '') this.prompt = result.prompt;
    this.applyInput(result.input);
    if (result.output !== '') this.writeText(result.output);
    if (result.closed) {
      this.closeSession();
      return;
    }

    const busy = await this.awaitDelimiter(result.busy);
    if (this.disposed || this.state === 'closed') return;
    if (busy) {
      this.state = 'busy';
      this.ensureNewline();
      this.writeText(`${jobStatusLine(this.jobLabel())}
`);
    } else {
      this.newPrompt();
    }
    this.drainNow();
  }

  /**
   * Consume session events up to the `cliPrompt` that closes the exec. `cliOutput` before it
   * (output a job printed synchronously) is written in order. Returns the delimiter's busy flag,
   * or `fallback` if the delimiter does not show up in time.
   */
  private async awaitDelimiter(fallback: boolean): Promise<boolean> {
    const deadline = performance.now() + DELIMITER_WAIT_MS;
    for (;;) {
      this.pending.push(...this.cursor.take());
      while (this.pending.length > 0) {
        const ev = this.pending.shift();
        if (ev === undefined) break;
        if (ev.kind === 'cliOutput') {
          this.writeText(ev.text);
          continue;
        }
        if (ev.prompt !== '') this.prompt = ev.prompt;
        this.applyInput(ev.input);
        return ev.busy;
      }
      const left = deadline - performance.now();
      if (left <= 0 || this.disposed) return fallback;
      await nextStoreChange(left);
    }
  }

  /** Label of the job holding this session, from the mirrored session view ('ping', 'tracert', …). */
  private jobLabel(): string {
    return store.getState().snapshot?.sessions.find((s) => s.id === this.session)?.job?.label ?? '';
  }

  private async complete(partial: string): Promise<void> {
    let res: CliCompletion;
    try {
      res = await engine.cliComplete(this.session, partial);
    } catch (err) {
      this.report(err);
      return;
    }
    if (this.disposed || this.state !== 'idle') return;
    if (res.error === undefined && res.insert !== undefined && res.insert !== '') {
      this.emit(this.editor.insert(res.insert));
      return;
    }
    if (res.error === undefined && res.items.length > 1) {
      this.ensureNewline();
      this.writeText(`${formatColumns(res.items.map((i) => i.token), this.term.cols)}\n`);
      this.restorePrompt();
      return;
    }
    this.emit([BELL]);
  }

  private async help(partial: string): Promise<void> {
    this.emit(this.editor.moveToEnd());
    this.emit(['?\r\n']);
    this.lineVisible = false;
    let res: CliCompletion;
    try {
      res = await engine.cliHelp(this.session, partial);
    } catch (err) {
      this.report(err);
      return;
    }
    if (this.disposed || this.state !== 'idle') return;
    if (res.error !== undefined) {
      if (res.error.column !== undefined) {
        this.writeText(`${' '.repeat(this.prompt.length + res.error.column)}^\n`);
      }
      this.writeText(`${res.error.message}\n`);
    } else {
      this.writeText(`${formatHelp(res)}\n`);
    }
    this.restorePrompt();
  }

  private closeSession(): void {
    this.state = 'closed';
    this.ensureNewline();
    this.writeText('Session closed.\n');
    this.editor.clear();
    this.lineVisible = false;
    this.closeTimer = setTimeout(() => {
      this.closeTimer = undefined;
      void engine.cliClose(this.session).catch(() => undefined);
      store.getState().removeTerminal(this.session);
    }, CLOSE_DELAY_MS);
  }

  // ── paste (spec §7.6 paste-a-config) ─────────────────────────────────────────

  private readonly onPaste = (e: ClipboardEvent): void => {
    const text = e.clipboardData?.getData('text/plain') ?? '';
    e.preventDefault();
    e.stopPropagation();
    if (text === '' || this.disposed || this.state === 'closed') return;
    this.pasteAborted = false;
    this.enqueue(() => this.paste(text));
  };

  /** Every complete line is executed in order, each awaited (jobs included); a trailing fragment is left on the line. */
  private async paste(text: string): Promise<void> {
    const lines = text.replace(/\r\n?/g, '\n').split('\n');
    for (let i = 0; i < lines.length; i++) {
      await this.waitUntilIdle();
      if (this.disposed || this.pasteAborted || this.state !== 'idle') return;
      const piece = sanitizeInsert(lines[i] ?? '');
      if (piece !== '') this.emit(this.editor.insert(piece));
      if (i === lines.length - 1) return;
      const { line, writes } = this.editor.submitLine();
      this.emit(writes);
      this.atLineStart = true;
      this.lineVisible = false;
      await this.runLine(line);
    }
  }

  private async waitUntilIdle(): Promise<void> {
    while (this.state === 'busy' && !this.disposed && !this.pasteAborted) {
      this.drainNow();
      if (this.state !== 'busy') return;
      await nextStoreChange(1000);
    }
  }
}

type SessionEventQueue = ReturnType<SessionCursor['take']>;

export interface TerminalTabProps {
  tab: TerminalTabInfo;
  active: boolean;
}

export function TerminalTab({ tab, active }: TerminalTabProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const controllerRef = useRef<ConsoleController | null>(null);
  const deviceName = useStore((s) => s.snapshot?.devices.find((d) => d.id === tab.device)?.name);
  const hostname = deviceName ?? tab.title;
  const hostnameRef = useRef(hostname);

  useEffect(() => {
    hostnameRef.current = hostname;
  }, [hostname]);

  const onNew = useCallback(() => controllerRef.current?.scheduleDrain(), []);
  const cursor = useSessionOutput(tab.session, onNew);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return undefined;
    const controller = new ConsoleController(host, tab.session, hostnameRef.current, cursor);
    controllerRef.current = controller;
    return () => {
      controllerRef.current = null;
      controller.dispose();
    };
  }, [tab.session, cursor]);

  useEffect(() => {
    if (!active) return undefined;
    const raf = requestAnimationFrame(() => {
      controllerRef.current?.fit();
      controllerRef.current?.focus();
    });
    return () => cancelAnimationFrame(raf);
  }, [active]);

  return (
    <div
      ref={hostRef}
      className={`terminal-host ${active ? '' : 'is-hidden'}`}
      role="tabpanel"
      aria-label={`Console on ${hostname}`}
    />
  );
}
