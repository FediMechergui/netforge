/**
 * [S32] The automation workspace (ARCHITECTURE-P3 §6 "Automation workspace", §3.8 step 8, §5.9, §10.2 "[S32] editor
 * highlight and error marker"; §7 W6 web-desktop), against fake snapshots.
 *
 * Under test: the highlighter colours every token the NF-Py tokenizer reads and covers the text exactly; the live
 * syntax marks sit where the parser and tokenizer say, with the error in words; the editor's indentation helpers and
 * gutter; the workspace model (files, the script host's StateView and the `script-runs` table, the request list's
 * words and NetScope filters, file-name rules, arguments); the exact `hostRequest`s of Save, Delete, Run and Stop; the
 * NetScope link; the rendered workspace (output, traceback, requests, history, notes, labelled controls); and the
 * registration as a lazy window of the Desktop tab for programmable hosts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { parseDisplayFilter } from '@netforge/engine';
import type { DeviceSnapshot, ScriptHostStateView, ScriptRunRow, StoredFileMeta, Topology } from '@netforge/engine';

const api = vi.hoisted(() => ({
  hostRequest: vi.fn(),
  exportTopology: vi.fn(),
}));
vi.mock('../src/bridge/client', () => ({ engine: api }));
// the window layer's command prompt draws a terminal, which needs a browser; it only has to be present here
vi.mock('../src/terminal/TerminalTab', () => ({
  TerminalTab: ({ tab }: { tab: { session: string } }) => createElement('div', { 'data-terminal': tab.session }),
}));
vi.mock('../src/store/store', () => {
  const state: Record<string, unknown> = {};
  const useStore = Object.assign((selector: (s: Record<string, unknown>) => unknown) => selector(state), {
    getState: () => state,
    setState: (patch: Record<string, unknown>) => Object.assign(state, patch),
    subscribe: () => () => undefined,
  });
  return { useStore, store: useStore, DESKTOP_WINDOW_DEFAULT: Object.freeze({ w: 520, h: 380 }) };
});

import { useStore } from '../src/store/store';
import {
  CODE_EDITOR_HINT,
  CodeEditor,
  PY_INDENT,
  applyTextEdit,
  dedentEdit,
  gutterLines,
  indentEdit,
  newlineEdit,
  type TextEdit,
} from '../src/automation/CodeEditor';
import { PyHighlight, firstSyntaxError, highlightPy, lineStarts, offsetOf, pySyntaxMarks, segmentClassName } from '../src/automation/py-highlight';
import {
  AUTOMATION_PROCESS,
  chooseRun,
  contentProblem,
  deleteHostFile,
  fileContentOf,
  fileNameProblem,
  fmtBytes,
  fmtSimSeconds,
  fmtTook,
  hostFiles,
  loadHostFile,
  newScriptText,
  parseRequestUrl,
  parseScriptArgs,
  refusalOf,
  requestCaptureFilter,
  requestResultText,
  requestTook,
  runDetails,
  runHeadline,
  runHostScript,
  runNumber,
  runStateText,
  runsScriptHost,
  saveHostFile,
  scriptHostView,
  scriptRunRows,
  showInNetScope,
  stopHostScript,
} from '../src/automation/workspace-model';
import { AutomationApp, AutomationWorkspace, RunView, initialFile, moveDeleteFocus, runPanelChoice, type Focusable } from '../src/automation/AutomationWorkspace';
import { DOCK_MIN_HEIGHT, DOCK_OPEN_HEIGHT } from '../src/dock/registry';
import { AutomationWindow, DesktopAppGlyph, desktopAppAvailability, desktopAppsFor } from '../src/desktop/DesktopTab';
import { desktopWindowApp } from '../src/desktop/WindowLayer';
import { device, port, snapshot } from './canvas-fixtures';

const state = (useStore as unknown as { getState(): Record<string, unknown> }).getState;
const setState = (useStore as unknown as { setState(p: Record<string, unknown>): void }).setState;

function text(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ');
}

/** Every input in `html` is named by a `<label for>` or an aria-label. */
function unlabelledControls(html: string): string[] {
  const labelled = new Set([...html.matchAll(/<label[^>]*for="([^"]+)"/g)].map((m) => m[1] as string));
  const out: string[] = [];
  for (const m of html.matchAll(/<(input|select|textarea)\b[^>]*>/g)) {
    const tag = m[0];
    if (/aria-label="/.test(tag)) continue;
    const id = /\bid="([^"]+)"/.exec(tag)?.[1];
    if (id === undefined || !labelled.has(id)) out.push(tag);
  }
  return out;
}

/** The text of every segment, joined: must give back the source. */
const rebuilt = (src: string): string => highlightPy(src).map((s) => src.slice(s.from, s.to)).join('');
/** The class of the segment that holds `needle` (its first occurrence). */
function classAt(src: string, needle: string, from = 0): string | undefined {
  const at = src.indexOf(needle, from);
  return highlightPy(src).find((s) => s.from <= at && s.to > at)?.cls;
}

const SEC = 1_000_000_000;

const INVENTORY = [
  'import requests',
  '',
  'SWITCHES = ["10.0.99.11", "10.0.99.12"]',
  'for ip in SWITCHES:',
  '    r = requests.get(f"https://{ip}/restconf/data/ietf-interfaces:interfaces", auth=("admin", "pw"))',
  '    print(ip, r.json()["ietf-interfaces:interfaces"])  # read the list',
  '',
].join('\n');

const FILES: StoredFileMeta[] = [
  { fs: 'files', path: 'inventory.py', size: 420, modifiedAt: 50 * SEC },
  { fs: 'files', path: 'loop.py', size: 1_536, modifiedAt: 60 * SEC },
];

function hostView(): ScriptHostStateView {
  return {
    runs: [
      {
        run: 'r2',
        token: 'r_7',
        file: 'inventory.py',
        argv: ['--all', 'two words'],
        state: 'failed',
        startedAt: 200 * SEC,
        endedAt: 200 * SEC + 300_000_000,
        output: '10.0.99.11 [3 interfaces]\n',
        error: {
          type: 'KeyError',
          message: "'ietf-interfaces:interfaces'",
          traceback: 'Traceback (most recent call last):\n  File "inventory.py", line 6, in <module>\nKeyError: \'ietf-interfaces:interfaces\'',
          last: "KeyError: 'ietf-interfaces:interfaces'",
          line: 6,
        },
        steps: 4_210,
        slices: 3,
        sleptNs: 0,
        requests: [
          { n: 1, method: 'GET', url: 'https://10.0.99.11/restconf/data/ietf-interfaces:interfaces', state: 'done', startedAt: 200 * SEC, endedAt: 200 * SEC + 12_000_000, status: 200, reason: 'OK' },
          { n: 2, method: 'GET', url: 'https://10.0.99.12/restconf/data/ietf-interfaces:interfaces', state: 'done', startedAt: 200 * SEC + 20_000_000, endedAt: 200 * SEC + 30_000_000, status: 401, reason: 'Unauthorized' },
          { n: 3, method: 'PUT', url: 'https://sw3.lab:8443/restconf/data/nf-native:native/vlan/vlan-list=30', state: 'failed', startedAt: 200 * SEC + 40_000_000, endedAt: 200 * SEC + 290_000_000, error: 'timeout' },
        ],
      },
      {
        run: 'r3',
        token: 'r_9',
        file: 'loop.py',
        argv: [],
        state: 'running',
        startedAt: 300 * SEC,
        waiting: 'http',
        output: '',
        steps: 12,
        slices: 1,
        sleptNs: 0,
        requests: [{ n: 1, method: 'GET', url: 'http://10.0.99.13/', state: 'pending', startedAt: 300 * SEC }],
      },
    ],
    refused: [{ token: 'r_8', file: 'missing.py', reason: '% There is no file named missing.py.', at: 250 * SEC }],
    started: 3,
    completed: 1,
    failed: 1,
    stopped: 0,
  };
}

function runRows(): ScriptRunRow[] {
  return [
    { key: 'r1', run: 'r1', file: 'inventory.py', state: 'completed', startedAt: 100 * SEC, endedAt: 100 * SEC + 500_000_000, requests: 2, updatedAt: 100 * SEC + 500_000_000 },
    { key: 'r3', run: 'r3', file: 'loop.py', state: 'running', startedAt: 300 * SEC, requests: 0, updatedAt: 300 * SEC },
    { key: 'r2', run: 'r2', file: 'inventory.py', state: 'failed', startedAt: 200 * SEC, endedAt: 200 * SEC + 300_000_000, requests: 3, error: "KeyError: 'ietf-interfaces:interfaces'", updatedAt: 200 * SEC + 300_000_000 },
  ];
}

/** DEV1, a programmable host with two scripts, a failed run, a running one, and the history. */
function dev1(extra: Partial<DeviceSnapshot> = {}): DeviceSnapshot {
  return device('dev1', 0, 0, [port('GigabitEthernet0', { l3: { ipv4: { address: '10.0.99.20', prefixLen: 24 } } })], {
    type: 'pc.nfdevhost',
    model: 'NF-DEVHOST',
    capabilities: ['host', 'programmable'],
    gui: ['desktop.ip-config', 'desktop.command-prompt', 'desktop.web-browser', 'desktop.traffic', 'desktop.automation'],
    storage: [{ fs: 'files', files: FILES }],
    processes: [{ process: 'script-host', state: hostView() as unknown as Record<string, unknown> }],
    tables: { cam: [], arp: [], rib: [], extra: [{ name: 'script-runs', title: 'Script runs', columns: [], rows: runRows() as unknown as Record<string, unknown>[] }] },
    ...extra,
  });
}

beforeEach(() => {
  api.hostRequest.mockReset();
  api.hostRequest.mockResolvedValue({ requestId: 'r_12', process: 'script-host' });
  api.exportTopology.mockReset();
  setState({
    snapshot: null,
    snapshotIndex: undefined,
    setNetscope: vi.fn(),
    setDockTab: vi.fn(),
    announce: vi.fn(),
    dockHeight: DOCK_OPEN_HEIGHT,
    setDockHeight: vi.fn(),
  });
});

// ── the highlighter ──────────────────────────────────────────────────────────

describe('editor highlight', () => {
  it('covers the text exactly, in order, without gaps or overlaps', () => {
    for (const src of [INVENTORY, '', 'x', 'if x:\n\tpass\r\ny = "a\nz = $ + 1\n', 'print(f"{a!r:>8} and {b}")']) {
      const segs = highlightPy(src);
      expect(rebuilt(src)).toBe(src);
      let at = 0;
      for (const s of segs) {
        expect(s.from).toBe(at);
        expect(s.to).toBeGreaterThan(s.from);
        at = s.to;
      }
      expect(at).toBe(src.length);
    }
  });

  it('colours what the NF-Py tokenizer reads', () => {
    expect(classAt(INVENTORY, 'import')).toBe('keyword');
    expect(classAt(INVENTORY, 'requests')).toBe('builtin');
    expect(classAt(INVENTORY, 'SWITCHES')).toBe('name');
    expect(classAt(INVENTORY, '"10.0.99.11"')).toBe('string');
    expect(classAt(INVENTORY, 'for')).toBe('keyword');
    expect(classAt(INVENTORY, 'print')).toBe('builtin');
    expect(classAt(INVENTORY, '# read the list')).toBe('comment');
    expect(classAt(INVENTORY, '=')).toBe('op');
    expect(classAt('x = 0x1F + 1.5e3', '0x1F')).toBe('number');
    expect(classAt('x = 0x1F + 1.5e3', '1.5e3')).toBe('number');
    expect(classAt('True and None', 'None')).toBe('keyword');
  });

  it('colours an f-string’s replacement fields as code and its text as a string', () => {
    const src = 'print(f"https://{ip}/data")';
    expect(classAt(src, 'f"https://')).toBe('string');
    expect(classAt(src, 'ip}')).toBe('name');
    expect(classAt(src, '/data')).toBe('string');
    expect(classAt(src, '{')).toBe('string');
  });

  it('marks an unreadable character as an error and colours the rest', () => {
    const src = 'a = 1 $ 2\nb = "x"\n';
    expect(classAt(src, '$')).toBe('error');
    expect(classAt(src, '"x"')).toBe('string');
  });

  it('flags exactly the pieces inside a mark', () => {
    const src = 'print("hi")';
    const segs = highlightPy(src, [{ from: 3, to: 8 }]);
    expect(segs.filter((s) => s.mark === true).map((s) => src.slice(s.from, s.to)).join('')).toBe('nt("h');
    expect(segs.filter((s) => s.mark === true).map((s) => s.cls)).toEqual(['builtin', 'op', 'string']);
    expect(segmentClassName({ cls: 'string', mark: true })).toBe('py-string py-mark');
    expect(segmentClassName({ cls: 'keyword' })).toBe('py-keyword');
    // an empty mark marks nothing
    expect(highlightPy(src, [{ from: 4, to: 4 }]).some((s) => s.mark === true)).toBe(false);
  });

  it('renders spans with the classes, and the text itself unchanged', () => {
    const html = renderToStaticMarkup(createElement(PyHighlight, { source: 'import json # x' }));
    expect(html).toBe('<span class="py-keyword">import</span> <span class="py-builtin">json</span> <span class="py-comment"># x</span>');
    expect(renderToStaticMarkup(createElement(PyHighlight, { source: 'a<b & "c"' }))).toContain('&lt;');
  });
});

// ── the live syntax marks ────────────────────────────────────────────────────

describe('editor error marker', () => {
  it('has no mark for a script that compiles', () => {
    expect(pySyntaxMarks(INVENTORY)).toEqual([]);
    expect(firstSyntaxError(INVENTORY)).toBeUndefined();
    expect(pySyntaxMarks('')).toEqual([]);
  });

  it('marks an unclosed string from its quote to the end of the line, with the error in words', () => {
    const src = 'import json\nname = "SW1\nprint(name)\n';
    const marks = pySyntaxMarks(src);
    expect(marks.length).toBeGreaterThanOrEqual(1);
    const m = marks[0]!;
    expect(m.type).toBe('SyntaxError');
    expect(m.line).toBe(2);
    expect(m.column).toBe(8);
    expect(src.slice(m.from, m.to)).toBe('"SW1');
    expect(m.text).toBe(`Line 2, column 8: SyntaxError: ${m.message}`);
    expect(m.message).toMatch(/never closed/);
    expect(firstSyntaxError(src)?.line).toBe(2);
  });

  it('marks an unclosed bracket, a stray character and a bad dedent where the engine says', () => {
    const paren = pySyntaxMarks('x = (1,\n');
    expect(paren).toHaveLength(1);
    expect(paren[0]!.text).toBe('Line 1, column 5: SyntaxError: This "(" is never closed.');
    expect('x = (1,\n'.slice(paren[0]!.from, paren[0]!.to)).toBe('(');

    const stray = 'a = 1\nb = $\n';
    const s = pySyntaxMarks(stray);
    expect(s.map((m) => [m.line, stray.slice(m.from, m.to)])).toEqual([[2, '$']]);

    const dedent = 'if a:\n        b = 1\n    c = 2\n';
    const d = pySyntaxMarks(dedent);
    expect(d[0]!.type).toBe('IndentationError');
    expect(d[0]!.line).toBe(3);
  });

  it('lists every problem the tokenizer found, one per position, in source order', () => {
    const src = 'a = $\nb = "open\nc = 1\n';
    const marks = pySyntaxMarks(src);
    expect(marks.map((m) => m.line)).toEqual([1, 2]);
    expect(new Set(marks.map((m) => m.from)).size).toBe(marks.length);
    // the first is the one a run would report
    expect(firstSyntaxError(src)?.from).toBe(marks[0]!.from);
  });

  it('marks the last character of a line when the error sits at its end', () => {
    const src = 'if ready\n    pass\n';
    const m = firstSyntaxError(src)!;
    expect(m).toBeDefined();
    expect(m.to).toBeGreaterThan(m.from);
    expect(src.slice(m.from, m.to)).not.toContain('\n');
  });

  it('underlines the mark in the overlay and flags its line in the gutter, with the text as the tooltip', () => {
    const src = 'x = 1\ny = (2,\n';
    const marks = pySyntaxMarks(src);
    const html = renderToStaticMarkup(createElement(CodeEditor, { value: src, onChange: () => undefined, label: 'Script t.py', marks }));
    expect(html).toContain('py-mark');
    expect(html).toContain('aria-invalid="true"');
    expect(html).toContain(`title="${marks[0]!.text.replace(/"/g, '&quot;')}"`);
    expect(gutterLines(src, marks).map((g) => g.glyph)).toEqual(['', '✕', '']);
  });

  it('maps lines and columns to offsets as the tokenizer counts them', () => {
    const src = 'ab\r\ncd\ref\ngh';
    expect(lineStarts(src)).toEqual([0, 4, 7, 10]);
    expect(offsetOf(src, lineStarts(src), 3, 2)).toBe(8);
    expect(offsetOf(src, lineStarts(src), 99, 1)).toBe(10);
  });
});

// ── the editor ───────────────────────────────────────────────────────────────

describe('the editor', () => {
  const run = (t: string, e: TextEdit): { text: string; sel: [number, number] } => ({ text: applyTextEdit(t, e), sel: [e.selStart, e.selEnd] });

  it('Tab indents to the next level at the caret, and every selected line of a selection', () => {
    expect(PY_INDENT).toBe('    ');
    expect(run('x', indentEdit('x', 0, 0))).toEqual({ text: '    x', sel: [4, 4] });
    expect(run('ab', indentEdit('ab', 2, 2))).toEqual({ text: 'ab  ', sel: [4, 4] });
    const block = 'a = 1\n\nb = 2\nc = 3';
    // lines 1–3 selected from inside line 1; the empty line stays empty; line 4 untouched
    expect(run(block, indentEdit(block, 2, 9))).toEqual({ text: '    a = 1\n\n    b = 2\nc = 3', sel: [6, 17] });
    // a selection that ends at the start of a line leaves that line out
    expect(applyTextEdit(block, indentEdit(block, 0, 7))).toBe('    a = 1\n\nb = 2\nc = 3');
  });

  it('Shift+Tab dedents one level (or one tab) on every touched line', () => {
    expect(run('        x', dedentEdit('        x', 8, 8))).toEqual({ text: '    x', sel: [4, 4] });
    expect(run('  x', dedentEdit('  x', 1, 1))).toEqual({ text: 'x', sel: [0, 0] });
    expect(applyTextEdit('\tx\n    y\nz', dedentEdit('\tx\n    y\nz', 0, 8))).toBe('x\ny\nz');
  });

  it('Enter keeps the indentation, adds a level after a colon and drops one after return or pass', () => {
    expect(run('    x = 1', newlineEdit('    x = 1', 9, 9))).toEqual({ text: '    x = 1\n    ', sel: [14, 14] });
    expect(applyTextEdit('for ip in SWITCHES:', newlineEdit('for ip in SWITCHES:', 19, 19))).toBe('for ip in SWITCHES:\n    ');
    expect(applyTextEdit('if ok:  # comment', newlineEdit('if ok:  # comment', 17, 17))).toBe('if ok:  # comment\n    ');
    expect(applyTextEdit('    return r', newlineEdit('    return r', 12, 12))).toBe('    return r\n');
    expect(applyTextEdit('        pass', newlineEdit('        pass', 12, 12))).toBe('        pass\n    ');
    // a selection is replaced
    expect(applyTextEdit('abcdef', newlineEdit('abcdef', 2, 4))).toBe('ab\nef');
  });

  it('numbers the gutter and flags a syntax line before the failing line of a run', () => {
    expect(gutterLines('a\nb\nc', [], 2, "KeyError: 'x'")).toEqual([
      { n: 1, glyph: '' },
      { n: 2, glyph: '!', title: "KeyError: 'x'" },
      { n: 3, glyph: '' },
    ]);
    expect(gutterLines('a\nb', [{ line: 2, text: 'Line 2: SyntaxError' }], 2).map((g) => g.glyph)).toEqual(['', '✕']);
    expect(gutterLines('').length).toBe(1);
  });

  it('renders one labelled textarea over a decorative overlay and gutter', () => {
    const html = renderToStaticMarkup(createElement(CodeEditor, { value: INVENTORY, onChange: () => undefined, label: 'Script inventory.py', describedBy: 'syn', failedLine: 6 }));
    expect(html.match(/<textarea/g)).toHaveLength(1);
    expect(html).toContain('aria-label="Script inventory.py"');
    expect(html).toMatch(/aria-describedby="[^"]+-hint syn"/);
    expect(html).toContain('wrap="off"');
    expect(html).toContain('spellcheck="false"');
    expect(html).toMatch(/<pre[^>]*class="auto-hl"[^>]*aria-hidden="true"/);
    expect(html).toMatch(/class="auto-gutter" aria-hidden="true"/);
    expect(html).toContain('auto-gutter-line is-failed');
    expect(text(html)).toContain(CODE_EDITOR_HINT);
    expect(html).toContain('aria-invalid="false"');
  });
});

// ── the model ────────────────────────────────────────────────────────────────

describe('files', () => {
  it('lists the host’s files from DeviceSnapshot.storage, and finds a file’s text in an export', () => {
    expect(hostFiles(dev1()).map((f) => f.path)).toEqual(['inventory.py', 'loop.py']);
    expect(hostFiles(device('pc1', 0, 0, []))).toEqual([]);
    const topo = { devices: [{ id: 'dev1', files: [{ path: 'inventory.py', content: INVENTORY }] }] } as unknown as Topology;
    expect(fileContentOf(topo, 'dev1', 'inventory.py')).toBe(INVENTORY);
    expect(fileContentOf(topo, 'dev1', 'gone.py')).toBeUndefined();
    expect(fileContentOf(topo, 'sw1', 'inventory.py')).toBeUndefined();
    expect(initialFile(FILES)).toBe('inventory.py');
    expect(initialFile([FILES[1]!])).toBe('loop.py');
    expect(initialFile([])).toBeNull();
  });

  it('words sizes', () => {
    expect([0, 1, 512, 999, 1_000, 1_536, 1_048_576, -1].map(fmtBytes)).toEqual(['0 bytes', '1 byte', '512 bytes', '999 bytes', '1 kB', '1.5 kB', '1 MB', '—']);
  });

  it('refuses the names the store refuses, a taken name and a full store', () => {
    expect(fileNameProblem('  ', FILES, true)).toBe('Give the file a name, for example inventory.py.');
    expect(fileNameProblem('dir/a.py', FILES, true)).toMatch(/one plain name/);
    expect(fileNameProblem('a\\b.py', FILES, true)).toMatch(/one plain name/);
    expect(fileNameProblem('..', FILES, true)).toMatch(/one plain name/);
    expect(fileNameProblem('x'.repeat(256), FILES, true)).toBe('A file name has at most 255 characters.');
    expect(fileNameProblem('inventory.py', FILES, true)).toBe('inventory.py already exists. Pick it in the list to open it.');
    expect(fileNameProblem('inventory.py', FILES, false)).toBeUndefined();
    expect(fileNameProblem('new.py', FILES, true)).toBeUndefined();
    const full = Array.from({ length: 256 }, (_, i) => ({ path: `f${i}.py` }));
    expect(fileNameProblem('new.py', full, true)).toBe('This host already keeps 256 files. Delete one first.');
    expect(contentProblem('print(1)')).toBeUndefined();
    expect(contentProblem('x'.repeat(2_000_000))).toMatch(/^A file holds at most \d+ characters; this one has 2000000\.$/);
    expect(newScriptText(' check.py ')).toBe('# check.py\n');
  });

  it('splits the arguments as the host shell does', () => {
    expect(parseScriptArgs('')).toEqual([]);
    expect(parseScriptArgs('  --all  10.0.99.11 ')).toEqual(['--all', '10.0.99.11']);
    expect(parseScriptArgs('"two words" x"y z"w')).toEqual(['two words', 'xy zw']);
    expect(parseScriptArgs('a "unclosed rest')).toEqual(['a', 'unclosed rest']);
    expect(parseScriptArgs('""')).toEqual(['']);
  });
});

describe('the script host’s runs', () => {
  it('reads the StateView, normalising what it cannot read', () => {
    const v = scriptHostView(dev1())!;
    expect(AUTOMATION_PROCESS).toBe('script-host');
    expect(runsScriptHost(dev1())).toBe(true);
    expect(runsScriptHost(device('pc1', 0, 0, []))).toBe(false);
    expect(scriptHostView(device('pc1', 0, 0, []))).toBeUndefined();
    expect(v.runs.map((r) => [r.run, r.state, r.requests.length])).toEqual([
      ['r2', 'failed', 3],
      ['r3', 'running', 1],
    ]);
    expect(v.runs[0]).toEqual(hostView().runs[0]);
    expect(v.refused).toEqual(hostView().refused);
    const junk = scriptHostView(
      device('x', 0, 0, [], {
        processes: [{ process: 'script-host', state: { runs: [null, 7, { run: '' }, { run: 'r9', state: 'odd', requests: [{ n: 1, state: 'odd' }, 'x'], argv: [1] }], refused: 'no' } }],
      }),
    )!;
    expect(junk.runs).toHaveLength(1);
    expect(junk.runs[0]).toMatchObject({ run: 'r9', state: 'failed', output: '', argv: ['1'], requests: [{ n: 1, state: 'failed', method: 'GET', url: '' }] });
    expect(junk.refused).toEqual([]);
    expect(junk.started).toBe(0);
  });

  it('reads the script-runs table newest first', () => {
    expect(scriptRunRows(dev1()).map((r) => r.run)).toEqual(['r3', 'r2', 'r1']);
    expect(scriptRunRows(device('pc1', 0, 0, []))).toEqual([]);
    expect([runNumber('r12'), runNumber('r2'), runNumber('x')]).toEqual([12, 2, 0]);
  });

  it('chooses the picked run, else the window’s own run, else the open file’s newest', () => {
    const v = hostView();
    expect(chooseRun(v, { run: 'r3', token: 'r_7', file: 'inventory.py' })?.run).toBe('r3');
    expect(chooseRun(v, { token: 'r_7' })?.run).toBe('r2');
    expect(chooseRun(v, { file: 'loop.py' })?.run).toBe('r3');
    expect(chooseRun(v, { file: 'none.py' })).toBeUndefined();
    expect(chooseRun(undefined, { file: 'loop.py' })).toBeUndefined();
    expect(refusalOf(v, 'r_8')?.reason).toBe('% There is no file named missing.py.');
    expect(refusalOf(v, 'r_7')).toBeUndefined();
    expect(refusalOf(v, null)).toBeUndefined();
  });

  it('shows the followed run, its refusal, or that it is starting — and the newest once it is no longer kept', () => {
    const v = hostView();
    expect(runPanelChoice(v, { pinned: null, follow: { token: 'r_7', file: 'inventory.py', seen: false }, file: 'inventory.py' }).run?.run).toBe('r2');
    expect(runPanelChoice(v, { pinned: null, follow: { token: 'r_8', file: 'inventory.py', seen: false }, file: 'inventory.py' })).toEqual({ refusal: v.refused[0], starting: false });
    expect(runPanelChoice(v, { pinned: null, follow: { token: 'r_99', file: 'inventory.py', seen: false }, file: 'inventory.py' })).toEqual({ starting: true });
    expect(runPanelChoice(v, { pinned: null, follow: { token: 'r_99', file: 'inventory.py', seen: true }, file: 'inventory.py' }).run?.run).toBe('r2');
    // a run followed for another file does not hide this file's runs
    expect(runPanelChoice(v, { pinned: null, follow: { token: 'r_9', file: 'loop.py', seen: true }, file: 'inventory.py' }).run?.run).toBe('r2');
    expect(runPanelChoice(v, { pinned: 'r3', follow: null, file: 'inventory.py' }).run?.run).toBe('r3');
    expect(runPanelChoice(v, { pinned: 'r1', follow: null, file: 'inventory.py' }).run?.run).toBe('r2');
    expect(runPanelChoice(undefined, { pinned: null, follow: null, file: 'inventory.py' })).toEqual({ starting: false });
  });

  it('words a run: its state with a glyph, its times, arguments and requests', () => {
    expect(['running', 'completed', 'failed', 'stopped'].map((s) => runStateText(s as ScriptRunRow['state']).text)).toEqual(['▶ running', '✓ completed', '✕ failed', '■ stopped']);
    const [failed, running] = hostView().runs;
    expect(runHeadline(failed!)).toBe('Run r2 of inventory.py: ✕ failed.');
    expect(runDetails(failed!)).toBe('started at 200.000 s, with --all "two words", ended at 200.300 s, 300 ms after it started, 3 requests.');
    expect(runDetails(running!)).toBe('started at 300.000 s, waiting for the answer to request 1, 1 request.');
    expect(runDetails({ ...running!, waiting: 'sleep', requests: [] })).toBe('started at 300.000 s, sleeping, 0 requests.');
    expect([fmtSimSeconds(0), fmtSimSeconds(100_250_000_000), fmtSimSeconds(1_999_999)]).toEqual(['0.000 s', '100.250 s', '0.001 s']);
    expect([fmtTook(10), fmtTook(12_400_000), fmtTook(2_500_000_000)]).toEqual(['under 1 ms', '12 ms', '2.500 s']);
  });

  it('words each request: status, failure in words, waiting, abandoned, and its time', () => {
    const qs = hostView().runs[0]!.requests;
    expect(qs.map((q) => requestResultText(q))).toEqual([
      { glyph: '✓', text: '200 OK' },
      { glyph: '⚠', text: '401 Unauthorized' },
      { glyph: '✕', text: 'failed: no answer in time' },
    ]);
    expect(requestResultText({ state: 'pending' })).toEqual({ glyph: '…', text: 'waiting for the answer' });
    expect(requestResultText({ state: 'abandoned' })).toEqual({ glyph: '■', text: 'abandoned: the run was stopped first' });
    expect(requestResultText({ state: 'failed', error: 'refused' }).text).toBe('failed: the server refused the connection');
    expect(requestResultText({ state: 'failed', error: 'odd-code' }).text).toBe('failed (odd-code)');
    expect(requestResultText({ state: 'done', status: 204 })).toEqual({ glyph: '✓', text: '204' });
    expect(qs.map((q) => requestTook(q))).toEqual(['12 ms', '10 ms', '250 ms']);
    expect(requestTook({ startedAt: 1 })).toBeUndefined();
  });

  it('links each request to NetScope with a filter NetScope parses', () => {
    expect(parseRequestUrl('https://10.0.99.11/restconf/data/x')).toEqual({ scheme: 'https', host: '10.0.99.11', port: 443, path: '/restconf/data/x' });
    expect(parseRequestUrl('HTTP://Web.Lab:8080')).toEqual({ scheme: 'http', host: 'web.lab', port: 8080, path: '/' });
    expect(parseRequestUrl('ftp://10.0.0.1/')).toBeUndefined();
    expect(parseRequestUrl('https://10.0.0.1:70000/')).toBeUndefined();
    expect(parseRequestUrl('not a url')).toBeUndefined();
    const filters = [
      requestCaptureFilter('https://10.0.99.11/restconf/data/ietf-interfaces:interfaces'),
      requestCaptureFilter('http://10.0.99.13/'),
      requestCaptureFilter('https://sw3.lab:8443/restconf/data/nf-native:native/vlan/vlan-list=30'),
    ];
    expect(filters).toEqual(['ip.addr == 10.0.99.11 && tcp.port == 443', 'ip.addr == 10.0.99.13 && tcp.port == 80', 'tcp.port == 8443 && http.host contains "sw3.lab"']);
    for (const f of filters) expect(parseDisplayFilter(f!).ok, f).toBe(true);
    expect(requestCaptureFilter('bad://x')).toBeUndefined();
  });
});

// ── the requests ─────────────────────────────────────────────────────────────

describe('requests', () => {
  it('Save, Delete, Run and Stop each emit exactly one hostRequest', async () => {
    await saveHostFile('dev1', 'inventory.py', INVENTORY);
    expect(api.hostRequest).toHaveBeenLastCalledWith('dev1', { app: 'file.write', path: 'inventory.py', content: INVENTORY });
    await deleteHostFile('dev1', 'loop.py');
    expect(api.hostRequest).toHaveBeenLastCalledWith('dev1', { app: 'file.delete', path: 'loop.py' });
    await expect(runHostScript('dev1', 'inventory.py')).resolves.toBe('r_12');
    expect(api.hostRequest).toHaveBeenLastCalledWith('dev1', { app: 'script.run', file: 'inventory.py' });
    await runHostScript('dev1', 'inventory.py', ['--all']);
    expect(api.hostRequest).toHaveBeenLastCalledWith('dev1', { app: 'script.run', file: 'inventory.py', argv: ['--all'] });
    await stopHostScript('dev1', 'r_7');
    expect(api.hostRequest).toHaveBeenLastCalledWith('dev1', { app: 'script.stop', run: 'r_7' });
    expect(api.hostRequest).toHaveBeenCalledTimes(5);
  });

  it('reads a file’s text from an export of the world', async () => {
    api.exportTopology.mockResolvedValue({ devices: [{ id: 'dev1', files: [{ path: 'inventory.py', content: INVENTORY }] }] });
    await expect(loadHostFile('dev1', 'inventory.py')).resolves.toBe(INVENTORY);
    await expect(loadHostFile('dev1', 'other.py')).resolves.toBeUndefined();
    expect(api.hostRequest).not.toHaveBeenCalled();
  });

  it('opens NetScope on a request’s filter, through the shared filter slice', () => {
    showInNetScope('ip.addr == 10.0.99.11 && tcp.port == 443', 'the packets of request 1');
    const s = state() as Record<string, ReturnType<typeof vi.fn>>;
    expect(s['setNetscope']).toHaveBeenCalledWith({ filterText: 'ip.addr == 10.0.99.11 && tcp.port == 443', applied: 'ip.addr == 10.0.99.11 && tcp.port == 443' });
    expect(s['setDockTab']).toHaveBeenCalledWith('netscope');
    expect(s['announce']).toHaveBeenCalledWith(expect.stringContaining('NetScope shows the packets of request 1.'));
  });

  it('opens a collapsed dock on NetScope, and leaves an open dock’s height alone (review fix #0)', () => {
    const setDockHeight = vi.fn();
    setState({ dockHeight: 0, setDockHeight });
    showInNetScope('ip.addr == 10.0.99.11 && tcp.port == 443', 'the packets of request 1');
    expect(state()['setDockTab']).toHaveBeenCalledWith('netscope');
    expect(setDockHeight).toHaveBeenCalledTimes(1);
    expect(setDockHeight.mock.calls[0]![0]).toBeGreaterThan(DOCK_MIN_HEIGHT);
    expect(setDockHeight).toHaveBeenCalledWith(DOCK_OPEN_HEIGHT);
    // the collapsed strip itself (DOCK_MIN_HEIGHT) counts as collapsed
    setDockHeight.mockClear();
    setState({ dockHeight: DOCK_MIN_HEIGHT });
    showInNetScope('tcp.port == 443', 'the packets');
    expect(setDockHeight).toHaveBeenCalledWith(DOCK_OPEN_HEIGHT);
    setDockHeight.mockClear();
    setState({ dockHeight: 400 });
    showInNetScope('tcp.port == 443', 'the packets');
    expect(setDockHeight).not.toHaveBeenCalled();
    expect(state()['setDockTab']).toHaveBeenLastCalledWith('netscope');
  });
});

// ── the delete confirmation's focus (review fix #1) ──────────────────────────

describe('delete confirmation focus', () => {
  /** A fake element: focusing it makes it the active one (no DOM library is installed). */
  let active: string = 'body';
  const el = (name: string, connected = true): Focusable & { name: string } => ({ name, isConnected: connected, focus: () => void (active = name) });
  beforeEach(() => {
    active = 'body';
  });

  it('opens on Keep, returns to "Delete…" on Keep, and lands on another file after a delete', () => {
    const t = { keep: el('keep'), ask: el('ask'), files: [{ path: 'inventory.py', el: el('inventory.py') }, { path: 'loop.py', el: el('loop.py') }], newFile: el('new') };
    expect(moveDeleteFocus({ step: 'confirm' }, t)).toBe(t.keep);
    expect(active).toBe('keep');
    expect(moveDeleteFocus({ step: 'kept' }, t)).toBe(t.ask);
    expect(active).toBe('ask');
    // the snapshot may still list the deleted file: focus skips it
    moveDeleteFocus({ step: 'deleted', path: 'inventory.py' }, t);
    expect(active).toBe('loop.py');
    moveDeleteFocus({ step: 'deleted', path: 'loop.py' }, t);
    expect(active).toBe('inventory.py');
  });

  it('falls back to the New file field when no other file is left, and never focuses a detached element', () => {
    const only = { files: [{ path: 'inventory.py', el: el('inventory.py') }], newFile: el('new') };
    expect(moveDeleteFocus({ step: 'deleted', path: 'inventory.py' }, only)).toBe(only.newFile);
    expect(active).toBe('new');
    active = 'body';
    expect(moveDeleteFocus({ step: 'deleted', path: 'x.py' }, { files: [{ path: 'a.py', el: el('a.py', false) }], newFile: el('new') })).toMatchObject({ name: 'new' });
    active = 'body';
    expect(moveDeleteFocus({ step: 'confirm' }, { keep: el('keep', false), ask: el('ask') })).toBeUndefined();
    expect(moveDeleteFocus({ step: 'kept' }, { ask: null })).toBeUndefined();
    expect(active).toBe('body');
  });

  it('renders the confirmation as an alert dialog named by its question', () => {
    const html = renderToStaticMarkup(createElement(AutomationWorkspace, { device: dev1(), initialLoaded: { 'inventory.py': INVENTORY }, initialConfirmDelete: true }));
    const dialog = /<span class="auto-confirm" role="alertdialog" aria-labelledby="([^"]+)">/.exec(html);
    expect(dialog).not.toBeNull();
    expect(html).toContain(`<span id="${dialog![1]}">Delete inventory.py?</span>`);
    expect(html).not.toContain('role="group"');
    expect(text(html)).toContain('Delete inventory.py? Delete Keep');
    expect(text(html)).not.toContain('Delete…');
    // the file buttons carry their names, so focus can skip a deleted file the snapshot still lists
    expect(html).toContain('data-path="inventory.py"');
    expect(html).toContain('data-path="loop.py"');
    // without the confirmation: the one "Delete…" button
    expect(text(renderToStaticMarkup(createElement(AutomationWorkspace, { device: dev1(), initialLoaded: { 'inventory.py': INVENTORY } })))).toContain('Delete…');
  });
});

// ── the workspace ────────────────────────────────────────────────────────────

describe('the workspace', () => {
  const render = (d: DeviceSnapshot, opts: { loaded?: Record<string, string>; token?: string } = {}): string =>
    renderToStaticMarkup(
      createElement(AutomationWorkspace, { device: d, ...(opts.loaded !== undefined ? { initialLoaded: opts.loaded } : {}), ...(opts.token !== undefined ? { initialToken: opts.token } : {}) }),
    );

  it('shows the files, the open script, its run’s output, traceback and requests, and the history', () => {
    const html = render(dev1(), { loaded: { 'inventory.py': INVENTORY }, token: 'r_7' });
    const t = text(html);
    expect(t).toContain('Files on DEV1');
    expect(html).toContain('aria-pressed="true" aria-label="inventory.py, 420 bytes"');
    expect(html).toContain('aria-pressed="false" aria-label="loop.py, 1.5 kB"');
    expect(t).toContain('✓ Saved');
    expect(t).toContain('✓ No syntax errors.');
    // the overlay colours the script; the gutter flags the line the run failed on
    expect(html).toContain('<span class="py-keyword">import</span>');
    expect(html).toContain('auto-gutter-line is-failed');
    // the run: a live headline, details, output, traceback and the button to the failing line
    expect(html).toMatch(/role="status">Run r2 of inventory\.py: ✕ failed\.</);
    expect(t).toContain('started at 200.000 s, with --all "two words", ended at 200.300 s, 300 ms after it started, 3 requests.');
    expect(t).toContain('10.0.99.11 [3 interfaces]');
    expect(t).toContain('Traceback (most recent call last):');
    expect(t).toContain('Show line 6 in the editor');
    // the requests, each linked to NetScope
    expect(t).toContain('Requests (3)');
    expect(t).toContain('GET https://10.0.99.11/restconf/data/ietf-interfaces:interfaces');
    expect(t).toContain('✓ 200 OK · 12 ms');
    expect(t).toContain('⚠ 401 Unauthorized · 10 ms');
    expect(t).toContain('✕ failed: no answer in time · 250 ms');
    expect(html.match(/>Show in NetScope</g)).toHaveLength(3);
    expect(html).toContain('aria-label="Show request 1, GET https://10.0.99.11/restconf/data/ietf-interfaces:interfaces in NetScope"');
    expect(html).toContain('title="ip.addr == 10.0.99.11 &amp;&amp; tcp.port == 443"');
    // the history, newest first; r1's output is no longer kept, r2 is the one shown
    const rows = [...html.matchAll(/<th scope="row" class="desk-mono">(r\d+)<\/th>/g)].map((m) => m[1]);
    expect(rows).toEqual(['r3', 'r2', 'r1']);
    expect(t.match(/output no longer kept/g)).toHaveLength(1);
    expect(html).toContain('aria-current="true"');
    expect(t).toContain("✕ failed KeyError: 'ietf-interfaces:interfaces'");
    // Run is enabled (the run shown has ended), Stop is not
    expect(html).toMatch(/<button type="button" class="btn btn-primary"[^>]*><span aria-hidden="true">▶ <\/span>Run<\/button>/);
    expect(html).toMatch(/<button type="button" class="btn" disabled=""[^>]*><span aria-hidden="true">■ <\/span>Stop<\/button>/);
    expect(unlabelledControls(html)).toEqual([]);
  });

  it('marks a syntax error live, in the overlay, the gutter and in words', () => {
    const broken = 'import requests\nr = requests.get("https://10.0.99.11/"\nprint(r)\n';
    const html = render(dev1(), { loaded: { 'inventory.py': broken } });
    const t = text(html);
    const first = firstSyntaxError(broken)!;
    expect(t).toContain(`✕ ${first.text}`);
    expect(html).toContain('py-mark');
    expect(html).toContain('auto-gutter-line is-syntax');
    expect(html).toContain('aria-invalid="true"');
  });

  it('follows a running run with Stop enabled and Run disabled', () => {
    const d = dev1();
    const html = renderToStaticMarkup(createElement(RunView, { run: scriptHostView(d)!.runs[1]!, outputId: 'o' }));
    const t = text(html);
    expect(t).toContain('Run r3 of loop.py: ▶ running.');
    expect(t).toContain('Nothing printed yet.');
    expect(t).toContain('… waiting for the answer');
    expect(html).toContain('title="ip.addr == 10.0.99.13 &amp;&amp; tcp.port == 80"');
    // in the workspace, with loop.py open
    const ws = renderToStaticMarkup(createElement(AutomationWorkspace, { device: dev1({ storage: [{ fs: 'files', files: [FILES[1]!] }] }), initialLoaded: { 'loop.py': 'while True:\n    pass\n' } }));
    expect(ws).toMatch(/<button type="button" class="btn btn-primary" disabled=""[^>]*><span aria-hidden="true">▶ <\/span>Run<\/button>/);
    expect(ws).toMatch(/<button type="button" class="btn"[^>]*><span aria-hidden="true">■ <\/span>Stop<\/button>/);
    expect(ws).not.toMatch(/class="btn" disabled=""[^>]*><span aria-hidden="true">■ /);
  });

  it('says why a start was refused, and that a start is on its way', () => {
    expect(text(render(dev1(), { loaded: { 'inventory.py': INVENTORY }, token: 'r_8' }))).toContain('DEV1 did not start missing.py: There is no file named missing.py.');
    expect(text(render(dev1(), { loaded: { 'inventory.py': INVENTORY }, token: 'r_99' }))).toContain('Starting the run…');
  });

  it('says when the host keeps no file, has run nothing, is off, or runs no script host', () => {
    const empty = dev1({ storage: undefined, processes: [{ process: 'script-host', state: { runs: [], refused: [], started: 0, completed: 0, failed: 0, stopped: 0 } }], tables: { cam: [], arp: [], rib: [] } });
    const t = text(render(empty));
    expect(t).toContain('DEV1 keeps no file yet. Create one below.');
    expect(t).toContain('Open a file to run it.');
    expect(t).toContain('No script has run on DEV1 yet.');
    expect(t).not.toContain('Arguments');
    const off = text(render(dev1({ power: false, processes: [] })));
    expect(off).toContain('The device is switched off. Turn it on to change settings.');
    const none = text(render(dev1({ processes: [] })));
    expect(none).toContain('DEV1 does not run the script host, so it cannot save or run scripts.');
    // a file not read yet: the editor waits
    expect(text(render(dev1()))).toContain('Reading…');
  });

  it('shows the device-gone note for a window whose device left the canvas', () => {
    setState({ snapshot: snapshot([]) });
    expect(text(renderToStaticMarkup(createElement(AutomationApp, { deviceId: 'nope', windowId: 1 })))).toContain('This device is no longer on the canvas.');
    setState({ snapshot: snapshot([dev1()]) });
    expect(text(renderToStaticMarkup(createElement(AutomationApp, { deviceId: 'dev1', windowId: 1 })))).toContain('Files on DEV1');
  });
});

// ── registration ─────────────────────────────────────────────────────────────

describe('registration', () => {
  it('is a desktop app of programmable hosts, opened as a lazy window', () => {
    expect(desktopAppAvailability('desktop.automation')).toEqual({ ok: true });
    expect(desktopWindowApp('desktop.automation')).toBe(AutomationWindow);
    expect(desktopAppsFor(dev1())).toEqual(['desktop.ip-config', 'desktop.command-prompt', 'desktop.web-browser', 'desktop.traffic', 'desktop.automation']);
    expect(desktopAppsFor({ gui: ['desktop.ip-config'] })).toEqual(['desktop.ip-config']);
    expect(text(renderToStaticMarkup(createElement(AutomationWindow, { deviceId: 'dev1', windowId: 1 })))).toContain('Loading the automation workspace…');
    // its own launcher glyph, not the placeholder square
    const glyph = renderToStaticMarkup(createElement('div', null, DesktopAppGlyph({ app: 'desktop.automation' })));
    expect(glyph).toContain('<path d="M10 11 L6 16 L10 21"');
  });
});
