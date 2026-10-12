/**
 * automation/AutomationWorkspace.tsx — [S32] the automation workspace, the `desktop.automation` app of a programmable
 * host (ARCHITECTURE-P3 §6 "Automation workspace", §3.8 step 8, §5.9, D21, D24; §7 W6 web-desktop).
 *
 * A learner keeps NF-Py scripts in the host's `files:` store, edits one, runs it on the host's script host, and reads
 * what it did:
 *  - **Files** — the store's list from `DeviceSnapshot.storage` (name and size; `●` marks a file with unsaved edits);
 *    a new file is created with one comment line; a file is deleted after a confirmation step (an alert dialog that
 *    opens on its Keep button; `moveDeleteFocus` keeps keyboard focus off the page at every step).
 *  - **Editor** — `CodeEditor` (textarea, gutter, overlay highlighter from the pure NF-Py tokenizer) with the live
 *    syntax marks of `pySyntaxMarks` and, under it, the first error in words (the one a run would stop on). Edits are
 *    kept per file while the window is open; Save writes the file (`hostRequest file.write`).
 *  - **Run / Stop** — Run saves unsaved edits first, then asks `hostRequest script.run {file, argv}`; the ticket is the
 *    run's token, so the workspace follows exactly that run in the script host's StateView. Stop asks
 *    `hostRequest script.stop {run: token}`. A start the host refuses (no such file, too many runs) shows its reason.
 *  - **Output, traceback and requests** — from the run's StateView entry: everything the script printed, the traceback
 *    of a failure (with a button that selects the failing line), and its HTTP requests in order (method, URL, status
 *    or failure, time taken), each with a "Show in NetScope" link that opens NetScope's Frames view filtered on the
 *    conversation with that server.
 *  - **Runs** — the `script-runs` table (one row per run: state, requests, times, the last traceback line), newest
 *    first; "Show" brings a run's output back while the host still keeps it.
 *
 * The world is never touched except through those `hostRequest`s (journaled and replayed like every GUI action), and a
 * file's text is read with `exportTopology()` when it is opened. Nothing here branches on device kind. Marks are glyphs
 * and words, never colour alone. Wording is original.
 */
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import type { DeviceSnapshot, ScriptHostStateView, ScriptRefusalView, ScriptRunRow, ScriptRunView, StoredFileMeta } from '@netforge/engine';
import { DESKTOP_WINDOW_DEFAULT, store, useStore } from '../store/store';
import { DeviceGone, deviceBusyReason, errorText, useDeviceById } from '../desktop/shared.js';
import type { DesktopAppProps } from '../desktop/shared.js';
import { clampWindowRect } from '../desktop/WindowLayer';
import { CodeEditor, type CodeEditorHandle } from './CodeEditor';
import { pySyntaxMarks } from './py-highlight';
import {
  chooseRun,
  contentProblem,
  deleteHostFile,
  fileNameProblem,
  fmtBytes,
  fmtSimSeconds,
  hostFiles,
  loadHostFile,
  newScriptText,
  parseScriptArgs,
  refusalOf,
  requestCaptureFilter,
  requestResultText,
  requestTook,
  runDetails,
  runHeadline,
  runHostScript,
  runStateText,
  runsScriptHost,
  saveHostFile,
  scriptHostView,
  scriptRunRows,
  showInNetScope,
  stopHostScript,
} from './workspace-model';
import './automation.css';

/** The size the workspace's window grows to when it opens at the default size (it needs room for the editor). */
export const AUTOMATION_WINDOW_SIZE = Object.freeze({ w: 760, h: 600 });

/** The file the workspace opens first: `inventory.py` when the host keeps one, else the first file. */
export function initialFile(files: readonly Pick<StoredFileMeta, 'path'>[]): string | null {
  if (files.length === 0) return null;
  return files.find((f) => f.path === 'inventory.py')?.path ?? (files[0] as Pick<StoredFileMeta, 'path'>).path;
}

/** A file's text as read, with the store time it was read at. */
interface LoadedFile {
  readonly content: string;
  readonly modifiedAt: number;
}

/** What the workspace is doing right now (one thing at a time). */
type Busy = 'load' | 'save' | 'run' | 'stop' | 'delete' | 'create' | null;

/** The run started from this window: its token and file, and whether the StateView has listed it yet. */
interface Follow {
  readonly token: string;
  readonly file: string;
  readonly seen: boolean;
}

/** `modifiedAt` of a file this window has just created and the snapshot does not list yet. */
const JUST_CREATED = -1;

/** What the run panel shows: a run, the refusal of the followed start, or that the start is on its way. */
export interface RunPanelChoice {
  readonly run?: ScriptRunView;
  readonly refusal?: ScriptRefusalView;
  readonly starting: boolean;
}

/**
 * The run panel's content: a run picked in the history (while the host keeps it); else the run started from this
 * window for the open file — or its refusal, or "starting" until the StateView lists it; else the open file's newest
 * run (also once a followed run is no longer kept).
 */
export function runPanelChoice(
  view: Pick<ScriptHostStateView, 'runs' | 'refused'> | undefined,
  opts: { readonly pinned: string | null; readonly follow: Follow | null; readonly file: string | null },
): RunPanelChoice {
  const newest = (): ScriptRunView | undefined => chooseRun(view, { file: opts.file });
  if (opts.pinned !== null) {
    const run = chooseRun(view, { run: opts.pinned }) ?? newest();
    return run === undefined ? { starting: false } : { run, starting: false };
  }
  const follow = opts.follow !== null && opts.follow.file === opts.file ? opts.follow : null;
  if (follow !== null) {
    const run = chooseRun(view, { token: follow.token });
    if (run !== undefined) return { run, starting: false };
    const refusal = refusalOf(view, follow.token);
    if (refusal !== undefined) return { refusal, starting: false };
    if (!follow.seen) return { starting: true };
  }
  const run = newest();
  return run === undefined ? { starting: false } : { run, starting: false };
}

/** An element keyboard focus can be moved to (a DOM element; tests pass fakes). */
export interface Focusable {
  readonly isConnected: boolean;
  focus(): void;
}

/** A step of the delete confirmation that unmounts (or disables) the focused control; `deleted` names the file. */
export type DeleteFocusStep = { readonly step: 'confirm' } | { readonly step: 'kept' } | { readonly step: 'deleted'; readonly path: string };

/** The controls focus can land on around the delete confirmation. */
export interface DeleteFocusTargets {
  /** The confirmation's Keep button. */
  readonly keep?: Focusable | null;
  /** The toolbar's "Delete…" button. */
  readonly ask?: Focusable | null;
  /** The file list's buttons, in list order, with their file names. */
  readonly files?: readonly { readonly path: string; readonly el: Focusable }[];
  /** The "New file" name field. */
  readonly newFile?: Focusable | null;
}

/**
 * Move keyboard focus after a step of the delete confirmation, so it never falls back to the page: the confirmation
 * opens on Keep (the safe answer; a refused delete comes back there too); Keep returns to "Delete…"; after a delete,
 * the list's first other file (the snapshot may still list the deleted one for a moment), else the "New file" field.
 * Returns the element focused, if any is still in the document.
 */
export function moveDeleteFocus(at: DeleteFocusStep, t: DeleteFocusTargets): Focusable | undefined {
  const order: readonly (Focusable | null | undefined)[] =
    at.step === 'confirm' ? [t.keep] : at.step === 'kept' ? [t.ask] : [...(t.files ?? []).filter((f) => f.path !== at.path).map((f) => f.el), t.newFile];
  const target = order.find((el): el is Focusable => el !== null && el !== undefined && el.isConnected);
  target?.focus();
  return target;
}

/** The window content: the workspace for the window's device. */
export function AutomationApp({ deviceId, windowId }: DesktopAppProps) {
  const device = useDeviceById(deviceId);
  useGrowWindow(windowId);
  if (device === undefined) return <DeviceGone />;
  return <AutomationWorkspace device={device} />;
}

/** Grow a window that opened at the default size to AUTOMATION_WINDOW_SIZE, within the window layer (once). */
function useGrowWindow(windowId: number): void {
  useEffect(() => {
    if (typeof document === 'undefined') return;
    const st = store.getState();
    const win = st.desktopWindows.find((w) => w.id === windowId);
    if (win === undefined || win.w !== DESKTOP_WINDOW_DEFAULT.w || win.h !== DESKTOP_WINDOW_DEFAULT.h) return;
    const layer = document.querySelector<HTMLElement>('.desk-layer');
    const bounds = { w: layer?.clientWidth ?? 0, h: layer?.clientHeight ?? 0 };
    st.moveDesktopWindow(windowId, clampWindowRect({ x: win.x, y: win.y, w: AUTOMATION_WINDOW_SIZE.w, h: AUTOMATION_WINDOW_SIZE.h }, bounds));
  }, [windowId]);
}

export interface AutomationWorkspaceProps {
  readonly device: DeviceSnapshot;
  /** Tests: texts already read, by file name (the workspace otherwise reads them with `exportTopology`). */
  readonly initialLoaded?: Readonly<Record<string, string>>;
  /** Tests: the token of a run started from this window. */
  readonly initialToken?: string;
  /** Tests: open with the delete confirmation showing. */
  readonly initialConfirmDelete?: boolean;
}

export function AutomationWorkspace({ device, initialLoaded, initialToken, initialConfirmDelete }: AutomationWorkspaceProps) {
  const uid = useId();
  const files = hostFiles(device);
  const view = scriptHostView(device);
  const history = scriptRunRows(device);
  const blocked = deviceBusyReason(device);
  const hasHost = runsScriptHost(device);

  const [selected, setSelected] = useState<string | null>(() => initialFile(files));
  const [loaded, setLoaded] = useState<Readonly<Record<string, LoadedFile>>>(() => {
    const out: Record<string, LoadedFile> = {};
    for (const [path, content] of Object.entries(initialLoaded ?? {})) out[path] = { content, modifiedAt: files.find((f) => f.path === path)?.modifiedAt ?? 0 };
    return out;
  });
  const [drafts, setDrafts] = useState<Readonly<Record<string, string>>>({});
  const [busy, setBusy] = useState<Busy>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [follow, setFollow] = useState<Follow | null>(() => (initialToken !== undefined && selected !== null ? { token: initialToken, file: selected, seen: false } : null));
  const [pinned, setPinned] = useState<string | null>(null);
  const [args, setArgs] = useState('');
  const [newName, setNewName] = useState('');
  const [newNameError, setNewNameError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(initialConfirmDelete === true);
  const editor = useRef<CodeEditorHandle | null>(null);
  const reading = useRef<string | null>(null);
  const setEditor = useCallback((h: CodeEditorHandle | null) => {
    editor.current = h;
  }, []);

  // each step of the delete confirmation unmounts the focused control: move focus once the next one is mounted
  const focusAfter = useRef<DeleteFocusStep | null>(null);
  const keepButton = useRef<HTMLButtonElement | null>(null);
  const askButton = useRef<HTMLButtonElement | null>(null);
  const fileList = useRef<HTMLUListElement | null>(null);
  const newNameInput = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    const at = focusAfter.current;
    if (at === null) return;
    focusAfter.current = null;
    const buttons = fileList.current === null ? [] : [...fileList.current.querySelectorAll<HTMLButtonElement>('button[data-path]')];
    moveDeleteFocus(at, {
      keep: keepButton.current,
      ask: askButton.current,
      files: buttons.map((el) => ({ path: el.getAttribute('data-path') ?? '', el })),
      newFile: newNameInput.current,
    });
  });
  const askDelete = (): void => {
    focusAfter.current = { step: 'confirm' };
    setConfirmDelete(true);
  };
  const keepFile = (): void => {
    focusAfter.current = { step: 'kept' };
    setConfirmDelete(false);
  };

  // keep the selection on a file the store holds (or one this window has just created and the snapshot will list)
  const selectedMeta = selected === null ? undefined : files.find((f) => f.path === selected);
  const justCreated = selected !== null && selectedMeta === undefined && loaded[selected]?.modifiedAt === JUST_CREATED;
  useEffect(() => {
    if (selected !== null && (selectedMeta !== undefined || justCreated)) return;
    const next = initialFile(files);
    if (next !== selected) setSelected(next);
  }, [selected, selectedMeta, justCreated, files]);

  // read the open file's text when it is opened, and again when the store says it changed
  const wanted = selectedMeta === undefined ? null : `${selectedMeta.path}@${selectedMeta.modifiedAt}`;
  useEffect(() => {
    if (selectedMeta === undefined || wanted === null) return;
    const have = loaded[selectedMeta.path];
    if (have !== undefined && have.modifiedAt === selectedMeta.modifiedAt) return;
    if (reading.current === wanted) return;
    reading.current = wanted;
    const path = selectedMeta.path;
    const at = selectedMeta.modifiedAt;
    setBusy((b) => b ?? 'load');
    loadHostFile(device.id, path)
      .then((content) => {
        if (content !== undefined) setLoaded((l) => ({ ...l, [path]: { content, modifiedAt: at } }));
        else setProblem(`${path} could not be read from ${device.name}.`);
      })
      .catch((err: unknown) => setProblem(`${path} could not be read: ${errorText(err)}`))
      .finally(() => {
        if (reading.current === wanted) reading.current = null;
        setBusy((b) => (b === 'load' ? null : b));
      });
  }, [device.id, device.name, selectedMeta, wanted, loaded]);

  const saved = selected === null ? undefined : loaded[selected]?.content;
  const draft = selected === null ? undefined : drafts[selected];
  const text = draft ?? saved ?? '';
  const dirty = draft !== undefined && draft !== saved;
  const marks = useMemo(() => pySyntaxMarks(text), [text]);

  const { run, refusal, starting } = runPanelChoice(view, { pinned, follow, file: selected });
  // once the StateView has listed the followed run, its later absence means the host no longer keeps it
  const followedSeen = follow !== null && !follow.seen && run !== undefined && run.token === follow.token;
  useEffect(() => {
    if (followedSeen) setFollow((f) => (f === null ? f : { ...f, seen: true }));
  }, [followedSeen]);
  const failedHere = run !== undefined && run.file === selected && run.state === 'failed' ? run.error : undefined;
  const canAct = blocked === undefined && hasHost && busy === null;

  const say = (ok: string | null, bad: string | null = null): void => {
    setStatus(ok);
    setProblem(bad);
  };

  const pick = (path: string): void => {
    setSelected(path);
    setPinned(null);
    setConfirmDelete(false);
    say(null);
  };

  const edit = (value: string): void => {
    if (selected === null) return;
    const path = selected;
    setDrafts((d) => ({ ...d, [path]: value }));
  };

  /** Save the open file; true when it is saved (or had nothing to save). */
  const save = async (): Promise<boolean> => {
    if (selected === null || draft === undefined || !dirty) return true;
    const tooBig = contentProblem(draft);
    if (tooBig !== undefined) {
      say(null, tooBig);
      return false;
    }
    const path = selected;
    const content = draft;
    try {
      await saveHostFile(device.id, path, content);
      setLoaded((l) => ({ ...l, [path]: { content, modifiedAt: l[path]?.modifiedAt ?? 0 } }));
      setDrafts((d) => {
        const next = { ...d };
        if (next[path] === content) delete next[path];
        return next;
      });
      return true;
    } catch (err) {
      say(null, `${path} was not saved: ${errorText(err)}`);
      return false;
    }
  };

  const onSave = async (): Promise<void> => {
    if (!canAct || selected === null) return;
    if (!dirty) {
      say(`${selected} has no unsaved changes.`);
      return;
    }
    setBusy('save');
    say(null);
    if (await save()) say(`Saved ${selected} on ${device.name}.`);
    setBusy(null);
  };

  const onRun = async (): Promise<void> => {
    if (!canAct || selected === null || run?.state === 'running') return;
    const path = selected;
    setBusy('run');
    say(null);
    try {
      if (!(await save())) return;
      const token = await runHostScript(device.id, path, parseScriptArgs(args));
      setFollow({ token, file: path, seen: false });
      setPinned(null);
      say(dirty ? `Saved ${path} and asked ${device.name} to run it.` : `Asked ${device.name} to run ${path}.`);
    } catch (err) {
      say(null, `${path} did not start: ${errorText(err)}`);
    } finally {
      setBusy(null);
    }
  };

  const onStop = async (): Promise<void> => {
    if (run === undefined || run.state !== 'running' || blocked !== undefined) return;
    setBusy('stop');
    try {
      await stopHostScript(device.id, run.token);
      say(`Asked ${device.name} to stop run ${run.run}.`);
    } catch (err) {
      say(null, `Run ${run.run} was not stopped: ${errorText(err)}`);
    } finally {
      setBusy(null);
    }
  };

  const onDelete = async (): Promise<void> => {
    if (!canAct || selected === null) return;
    const path = selected;
    setBusy('delete');
    try {
      await deleteHostFile(device.id, path);
      setDrafts((d) => {
        const next = { ...d };
        delete next[path];
        return next;
      });
      setLoaded((l) => {
        const next = { ...l };
        delete next[path];
        return next;
      });
      focusAfter.current = { step: 'deleted', path };
      setConfirmDelete(false);
      say(`Deleted ${path} from ${device.name}.`);
    } catch (err) {
      // the confirmation stays open; its Delete button was disabled while the request ran
      focusAfter.current = { step: 'confirm' };
      say(null, `${path} was not deleted: ${errorText(err)}`);
    } finally {
      setBusy(null);
    }
  };

  const onCreate = async (): Promise<void> => {
    if (!canAct) return;
    const name = newName.trim();
    const bad = fileNameProblem(name, files, true);
    if (bad !== undefined) {
      setNewNameError(bad);
      return;
    }
    setBusy('create');
    try {
      const content = newScriptText(name);
      await saveHostFile(device.id, name, content);
      setLoaded((l) => ({ ...l, [name]: { content, modifiedAt: JUST_CREATED } }));
      setSelected(name);
      setPinned(null);
      setNewName('');
      setNewNameError(null);
      say(`Created ${name} on ${device.name}.`);
    } catch (err) {
      setNewNameError(`${name} was not created: ${errorText(err)}`);
    } finally {
      setBusy(null);
    }
  };

  const showRun = (row: ScriptRunRow): void => {
    setPinned(row.run);
    if (files.some((f) => f.path === row.file)) setSelected(row.file);
    setConfirmDelete(false);
    say(null);
  };

  const ids = {
    files: `${uid}-files`,
    editor: `${uid}-editor`,
    syntax: `${uid}-syntax`,
    args: `${uid}-args`,
    newName: `${uid}-new`,
    newErr: `${uid}-new-err`,
    confirm: `${uid}-confirm`,
    run: `${uid}-run`,
    output: `${uid}-output`,
    history: `${uid}-history`,
  };
  const firstMark = marks[0];

  return (
    <div className="desk-app auto-ws">
      {blocked !== undefined && (
        <p className="desk-note" role="status">
          <span aria-hidden="true">⊘ </span>
          {blocked}
        </p>
      )}
      {blocked === undefined && !hasHost && (
        <p className="desk-note" role="status">
          <span aria-hidden="true">⊘ </span>
          {device.name} does not run the script host, so it cannot save or run scripts.
        </p>
      )}

      <section className="auto-files" aria-labelledby={ids.files}>
        <h3 id={ids.files} className="desk-heading">
          Files on {device.name}
        </h3>
        {files.length === 0 ? (
          <p className="desk-empty">{device.name} keeps no file yet. Create one below.</p>
        ) : (
          <ul className="auto-file-list" ref={fileList}>
            {files.map((f) => {
              const unsaved = drafts[f.path] !== undefined && drafts[f.path] !== loaded[f.path]?.content;
              return (
                <li key={f.path}>
                  <button
                    type="button"
                    data-path={f.path}
                    className={`auto-file ${f.path === selected ? 'is-open' : ''}`}
                    aria-pressed={f.path === selected}
                    aria-label={`${f.path}, ${fmtBytes(f.size)}${unsaved ? ', unsaved changes' : ''}`}
                    onClick={() => pick(f.path)}
                  >
                    <span className="desk-mono">{f.path}</span>
                    <span className="desk-sub"> {fmtBytes(f.size)}</span>
                    {unsaved && <span className="auto-unsaved"> ● unsaved</span>}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
        <form
          className="auto-new"
          onSubmit={(e) => {
            e.preventDefault();
            void onCreate();
          }}
        >
          <label htmlFor={ids.newName}>New file</label>
          <input
            id={ids.newName}
            ref={newNameInput}
            className="input desk-mono"
            value={newName}
            placeholder="inventory.py"
            spellCheck={false}
            autoComplete="off"
            aria-invalid={newNameError !== null}
            aria-describedby={newNameError !== null ? ids.newErr : undefined}
            onChange={(e) => {
              setNewName(e.target.value);
              setNewNameError(null);
            }}
          />
          <button type="submit" className="btn" disabled={!canAct}>
            Create
          </button>
          {newNameError !== null && (
            <span id={ids.newErr} className="desk-error">
              <span aria-hidden="true">⚠ </span>
              {newNameError}
            </span>
          )}
        </form>
      </section>

      {selected !== null && (
        <section className="auto-edit" aria-labelledby={ids.editor}>
          <div className="auto-toolbar">
            <h3 id={ids.editor} className="desk-heading desk-mono">
              {selected}
            </h3>
            <span className="desk-sub">{saved === undefined ? 'Reading…' : dirty ? '● Unsaved changes' : '✓ Saved'}</span>
            <span className="auto-spacer" />
            <button type="button" className="btn" disabled={!canAct || !dirty} onClick={() => void onSave()} title="Ctrl+S in the editor">
              Save
            </button>
            <button type="button" className="btn btn-primary" disabled={!canAct || saved === undefined || run?.state === 'running'} onClick={() => void onRun()} title="Ctrl+Enter in the editor">
              <span aria-hidden="true">▶ </span>
              {dirty ? 'Save and run' : 'Run'}
            </button>
            <button type="button" className="btn" disabled={run?.state !== 'running' || blocked !== undefined || busy === 'stop'} onClick={() => void onStop()}>
              <span aria-hidden="true">■ </span>Stop
            </button>
            {!confirmDelete ? (
              <button type="button" className="btn" ref={askButton} disabled={!canAct} onClick={askDelete}>
                Delete…
              </button>
            ) : (
              <span className="auto-confirm" role="alertdialog" aria-labelledby={ids.confirm}>
                <span id={ids.confirm}>Delete {selected}?</span>
                <button type="button" className="btn" disabled={!canAct} onClick={() => void onDelete()}>
                  Delete
                </button>
                <button type="button" className="btn" ref={keepButton} onClick={keepFile}>
                  Keep
                </button>
              </span>
            )}
          </div>
          <div className="auto-args">
            <label htmlFor={ids.args}>Arguments</label>
            <input
              id={ids.args}
              className="input desk-mono"
              value={args}
              placeholder="none"
              spellCheck={false}
              autoComplete="off"
              aria-describedby={`${ids.args}-hint`}
              onChange={(e) => setArgs(e.target.value)}
            />
            <span id={`${ids.args}-hint`} className="desk-hint">
              What the script finds in sys.argv after its own name; double quotes keep words together.
            </span>
          </div>
          <CodeEditor
            value={text}
            onChange={edit}
            label={`Script ${selected}`}
            describedBy={ids.syntax}
            marks={marks}
            readOnly={saved === undefined}
            {...(failedHere?.line !== undefined ? { failedLine: failedHere.line, failedText: failedHere.last } : {})}
            onSave={() => void onSave()}
            onRun={() => void onRun()}
            handleRef={setEditor}
          />
          <p id={ids.syntax} className={`auto-syntax ${firstMark !== undefined ? 'is-error' : 'is-ok'}`}>
            {firstMark === undefined ? (
              <>
                <span aria-hidden="true">✓ </span>No syntax errors.
              </>
            ) : (
              <>
                <span aria-hidden="true">✕ </span>
                {firstMark.text}
                {marks.length > 1 && ` (and ${marks.length - 1} more ${marks.length === 2 ? 'mark' : 'marks'} in the margin)`}
              </>
            )}
          </p>
          {problem !== null && (
            <p className="desk-error" role="alert">
              <span aria-hidden="true">⚠ </span>
              {problem}
            </p>
          )}
          {status !== null && (
            <p className="desk-status is-ok" role="status">
              <span aria-hidden="true">✓ </span>
              {status}
            </p>
          )}
        </section>
      )}
      {selected === null && problem !== null && (
        <p className="desk-error" role="alert">
          <span aria-hidden="true">⚠ </span>
          {problem}
        </p>
      )}

      <section className="auto-run" aria-labelledby={ids.run}>
        <h3 id={ids.run} className="desk-heading">
          {run === undefined ? 'Last run' : `Run ${run.run}`}
        </h3>
        {run === undefined ? (
          <p className="desk-empty" role="status">
            {refusal !== undefined
              ? `${device.name} did not start ${refusal.file}: ${refusal.reason.replace(/^%\s*/, '')}`
              : starting
                ? 'Starting the run…'
                : selected === null
                  ? 'Open a file to run it.'
                  : `${selected} has not been run yet. Run sends its requests from ${device.name} like any other program on the network.`}
          </p>
        ) : (
          <RunView run={run} outputId={ids.output} onShowLine={(n) => editor.current?.revealLine(n)} showLine={run.file === selected} />
        )}
      </section>

      <section className="auto-history" aria-labelledby={ids.history}>
        <h3 id={ids.history} className="desk-heading">
          Runs on {device.name}
        </h3>
        {history.length === 0 ? (
          <p className="desk-empty">No script has run on {device.name} yet.</p>
        ) : (
          <table className="desk-table">
            <thead>
              <tr>
                <th scope="col">Run</th>
                <th scope="col">File</th>
                <th scope="col">State</th>
                <th scope="col">Requests</th>
                <th scope="col">Started</th>
                <th scope="col">Ended</th>
                <th scope="col" aria-label="Output" />
              </tr>
            </thead>
            <tbody>
              {history.map((row) => {
                const kept = view?.runs.some((r) => r.run === row.run) === true;
                const current = run?.run === row.run;
                return (
                  <tr key={row.run} className={current ? 'is-current' : ''} aria-current={current ? 'true' : undefined}>
                    <th scope="row" className="desk-mono">
                      {row.run}
                    </th>
                    <td className="desk-mono">{row.file}</td>
                    <td>
                      {runStateText(row.state).text}
                      {row.error !== undefined && <span className="desk-sub desk-mono"> {row.error}</span>}
                    </td>
                    <td className="desk-mono">{row.requests}</td>
                    <td className="desk-mono">{fmtSimSeconds(row.startedAt)}</td>
                    <td className="desk-mono">{row.endedAt === undefined ? '—' : fmtSimSeconds(row.endedAt)}</td>
                    <td>
                      {kept ? (
                        <button type="button" className="btn" aria-label={`Show the output of run ${row.run}`} disabled={current} onClick={() => showRun(row)}>
                          Show
                        </button>
                      ) : (
                        <span className="desk-sub">output no longer kept</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}

/** One run: its state (a live region), details, output, traceback and requests. */
export function RunView({ run, outputId, onShowLine, showLine }: { run: ScriptRunView; outputId: string; onShowLine?: (n: number) => void; showLine?: boolean }) {
  const failure = run.state === 'failed' ? run.error : undefined;
  return (
    <div className="auto-run-body">
      <p className={`auto-run-state is-${run.state}`} role="status">
        {runHeadline(run)}
      </p>
      <p className="desk-sub">{runDetails(run)}</p>

      <h4 className="auto-subheading" id={`${outputId}-label`}>
        Output
      </h4>
      {run.output === '' ? (
        <p className="desk-empty">{run.state === 'running' ? 'Nothing printed yet.' : 'The script printed nothing.'}</p>
      ) : (
        <pre id={outputId} className="auto-output" tabIndex={0} aria-labelledby={`${outputId}-label`}>
          {run.output}
        </pre>
      )}

      {failure !== undefined && (
        <>
          <h4 className="auto-subheading" id={`${outputId}-tb`}>
            Traceback
          </h4>
          <pre className="auto-output auto-traceback" tabIndex={0} aria-labelledby={`${outputId}-tb`}>
            {failure.traceback}
          </pre>
          {failure.line !== undefined && showLine === true && onShowLine !== undefined && (
            <div className="desk-actions">
              <button type="button" className="btn" onClick={() => onShowLine(failure.line as number)}>
                Show line {failure.line} in the editor
              </button>
            </div>
          )}
        </>
      )}

      <h4 className="auto-subheading">Requests ({run.requests.length})</h4>
      {run.requests.length === 0 ? (
        <p className="desk-empty">{run.state === 'running' ? 'No request sent yet.' : 'This run sent no request.'}</p>
      ) : (
        <ol className="auto-requests">
          {run.requests.map((q) => {
            const result = requestResultText(q);
            const took = requestTook(q);
            const filter = requestCaptureFilter(q.url);
            const what = `request ${q.n}, ${q.method} ${q.url}`;
            return (
              <li key={q.n} className={`auto-request is-${q.state}`}>
                <span className="auto-request-n desk-mono">{q.n}.</span>
                <span className="auto-request-line desk-mono">
                  {q.method} {q.url}
                </span>
                <span className="auto-request-result">
                  <span aria-hidden="true">{result.glyph} </span>
                  {result.text}
                  {took !== undefined && <span className="desk-sub"> · {took}</span>}
                </span>
                {filter !== undefined && (
                  <button type="button" className="btn" aria-label={`Show ${what} in NetScope`} title={filter} onClick={() => showInNetScope(filter, `the packets of ${what}`)}>
                    Show in NetScope
                  </button>
                )}
              </li>
            );
          })}
        </ol>
      )}
      {run.requests.length > 0 && (
        <p className="desk-sub">
          “Show in NetScope” filters NetScope on the conversation with that server. Its packets are listed when a capture was running on a port they
          crossed (NetScope → Captures).
        </p>
      )}
    </div>
  );
}
