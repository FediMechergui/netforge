/**
 * Data-formats playground (ARCHITECTURE-P3 D21 "Data formats", §6; lesson 37's concept tool; W3 web-concept): the
 * concept tool over `concept/data-formats/model.ts`.
 *
 * Three panes, one at a time:
 *  - **Read and convert** — a JSON, YAML or XML editor (a plain text area). The document is read with the engine's own
 *    parsers on every change: a broken one shows the parser's message with its line and column, and the offending
 *    line with a caret under the column; a good one shows its tree, one row per node with the key path in both forms
 *    (dotted, and the one a script indexes with), the type, a short value and where the value starts. "Show it as"
 *    writes the same data in either other format (XML in the RESTCONF encoding, so an XML document is read against
 *    the RESTCONF path it answers, when there is one).
 *  - **Device answers** — the sample library: the JSON a device returns to each RESTCONF GET, with the request that
 *    asks for it; any sample opens in the editor.
 *  - **Practice** — the seeded "which type / which key" generator: the same question set always asks the same
 *    questions, and a wrong answer shows the model's explanation.
 *
 * Every figure comes from the model; nothing is parsed or converted here. Marks are glyphs and words (✓, ⚠, ✗), never
 * colour alone. The documents are shown as text, never as markup. Wording is original.
 */
import { useId, useMemo, useState } from 'react';
import {
  DATA_FORMATS,
  checkDataAnswer,
  convertDataDocument,
  dataPractice,
  dataSample,
  dataSamples,
  parseDataDocument,
  type DataCheck,
  type DataFormat,
  type DataTreeRow,
} from './model';

/** Panes of the playground. */
export type DataPane = 'edit' | 'samples' | 'practice';

/** Pane names in display order. */
export const DATA_PANES: readonly { readonly id: DataPane; readonly label: string }[] = Object.freeze([
  { id: 'edit', label: 'Read and convert' },
  { id: 'samples', label: 'Device answers' },
  { id: 'practice', label: 'Practice' },
]);

/** The sample the editor opens on: one interface named by its key (short enough to read at a glance). */
export const DEFAULT_DATA_SAMPLE = 'one-interface';

/** What the editor holds: the format, the text, and (XML) the RESTCONF path the document answers. */
export interface DataEditorState {
  readonly format: DataFormat;
  readonly text: string;
  /** The RESTCONF path an XML document answers ('' = none: its root is a top-level node). */
  readonly context: string;
}

/** The editor's first content: the default sample's JSON. */
export function defaultDataEditor(): DataEditorState {
  const s = dataSample(DEFAULT_DATA_SAMPLE) ?? dataSamples()[0];
  return { format: 'json', text: s?.json ?? '{}\n', context: s?.path ?? '' };
}

/** The label of a format (`JSON`). */
export function formatLabel(f: DataFormat): string {
  return DATA_FORMATS.find((x) => x.id === f)?.label ?? f;
}

/** The line a parse error points at, and a caret line under its column (both 1-based), or null when out of range. */
export function errorContext(text: string, line: number, column: number): { readonly number: string; readonly lineText: string; readonly caret: string } | null {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const l = lines[line - 1];
  if (l === undefined || line < 1) return null;
  const number = String(line);
  const lineText = `${number} | ${l}`;
  const caret = `${' '.repeat(number.length)} | ${' '.repeat(Math.max(0, Math.min(column - 1, l.length)))}^`;
  return { number, lineText, caret };
}

/** The tree row's name: `(the whole document)` for the root, else its dotted key path. */
export function treeRowName(row: Pick<DataTreeRow, 'depth' | 'dotPath'>): string {
  return row.depth === 0 ? '(the whole document)' : row.dotPath;
}

export function DataFormatsTool() {
  const uid = useId();
  const [pane, setPane] = useState<DataPane>('edit');
  const [editor, setEditor] = useState<DataEditorState>(defaultDataEditor);
  return (
    <div className="dock-panel">
      <div className="dock-toolbar" role="group" aria-label="Data-format panes">
        {DATA_PANES.map((p) => (
          <button
            key={p.id}
            type="button"
            id={`${uid}-tab-${p.id}`}
            aria-pressed={pane === p.id}
            aria-controls={`${uid}-pane`}
            className={`tab${pane === p.id ? ' is-active' : ''}`}
            onClick={() => setPane(p.id)}
          >
            {p.label}
          </button>
        ))}
      </div>
      <div className="dock-scroll" id={`${uid}-pane`} aria-labelledby={`${uid}-tab-${pane}`}>
        {pane === 'edit' && <EditorPane state={editor} onChange={setEditor} />}
        {pane === 'samples' && (
          <SamplesPane
            onOpen={(next) => {
              setEditor(next);
              setPane('edit');
            }}
          />
        )}
        {pane === 'practice' && <DataPracticePane />}
      </div>
    </div>
  );
}

// ── read and convert ────────────────────────────────────────────────────────

export function EditorPane({ state, onChange }: { state: DataEditorState; onChange: (next: DataEditorState) => void }) {
  const uid = useId();
  const [target, setTarget] = useState<DataFormat | null>(null);
  const context = state.format === 'xml' && state.context.trim() !== '' ? state.context.trim() : undefined;
  const parsed = useMemo(() => parseDataDocument(state.format, state.text, context), [state.format, state.text, context]);
  const converted = useMemo(
    () => (target === null || target === state.format ? null : convertDataDocument(state.text, state.format, target, context)),
    [target, state.format, state.text, context],
  );
  const label = formatLabel(state.format);
  const where = parsed.ok ? null : errorContext(state.text, parsed.error.line, parsed.error.column);

  return (
    <>
      <div className="dock-toolbar" role="group" aria-label="Format of the document">
        {DATA_FORMATS.map((f) => (
          <button
            key={f.id}
            type="button"
            className={`tab${state.format === f.id ? ' is-active' : ''}`}
            aria-pressed={state.format === f.id}
            title={f.hint}
            onClick={() => {
              setTarget(null);
              onChange({ ...state, format: f.id });
            }}
          >
            {f.label}
          </button>
        ))}
      </div>
      <p className="dim">{DATA_FORMATS.find((f) => f.id === state.format)?.hint} Changing the format reads the same text another way; use “Show it as” to rewrite it.</p>
      <div className="desk-field">
        <label htmlFor={`${uid}-doc`}>Document ({label})</label>
        <textarea
          id={`${uid}-doc`}
          className="input mono"
          rows={14}
          value={state.text}
          spellCheck={false}
          autoComplete="off"
          aria-invalid={!parsed.ok}
          aria-describedby={`${uid}-verdict`}
          style={{ width: '100%', resize: 'vertical', whiteSpace: 'pre' }}
          onChange={(e) => onChange({ ...state, text: e.target.value })}
        />
      </div>
      {state.format === 'xml' && (
        <div className="desk-field">
          <label htmlFor={`${uid}-ctx`}>RESTCONF path this XML answers (optional)</label>
          <input
            id={`${uid}-ctx`}
            className="input mono"
            value={state.context}
            spellCheck={false}
            autoComplete="off"
            placeholder="/restconf/data/ietf-interfaces:interfaces"
            onChange={(e) => onChange({ ...state, context: e.target.value })}
          />
          <span className="dim">XML has no lists or numbers of its own; the path tells the reader which elements repeat and which values are numbers.</span>
        </div>
      )}

      <div id={`${uid}-verdict`} role="status" aria-live="polite">
        {parsed.ok ? (
          <p>
            <span aria-hidden="true">✓ </span>A valid {label} document: {parsed.rows.length} node{parsed.rows.length === 1 ? '' : 's'}.
          </p>
        ) : (
          <div className="insp-note" role="alert">
            <p>
              <span aria-hidden="true">⚠ </span>
              The {label} document cannot be read. {parsed.text}
            </p>
            {where !== null && (
              <pre className="mono" aria-label={`Line ${where.number}, with a caret under column ${parsed.error.column}`}>
                {`${where.lineText}\n${where.caret}`}
              </pre>
            )}
          </div>
        )}
      </div>

      {parsed.ok && (
        <>
          <div className="panel-title">The tree</div>
          <table className="table">
            <caption className="dim">One row per value. The key path is written with dots, and as a script indexes it.</caption>
            <thead>
              <tr>
                <th scope="col">Key path</th>
                <th scope="col">Type</th>
                <th scope="col">Value</th>
                <th scope="col">In a script</th>
                {state.format !== 'xml' && <th scope="col">Starts at</th>}
              </tr>
            </thead>
            <tbody>
              {parsed.rows.map((r) => (
                <tr key={r.indexPath === '' ? '(root)' : r.indexPath}>
                  <th scope="row" className="mono" style={{ paddingLeft: 6 + r.depth * 12 }}>
                    {treeRowName(r)}
                  </th>
                  <td>{r.type}</td>
                  <td className="mono">{r.preview}</td>
                  <td className="mono">{r.indexPath === '' ? '—' : r.indexPath}</td>
                  {state.format !== 'xml' && <td className="mono">{r.line === undefined ? '—' : `line ${r.line}, column ${r.column ?? 1}`}</td>}
                </tr>
              ))}
            </tbody>
          </table>

          <div className="panel-title">Show it as</div>
          <div className="dock-toolbar" role="group" aria-label="Convert to">
            {DATA_FORMATS.filter((f) => f.id !== state.format).map((f) => (
              <button key={f.id} type="button" className="btn" aria-pressed={target === f.id} onClick={() => setTarget(f.id)}>
                {f.label}
              </button>
            ))}
          </div>
          {converted !== null && target !== null && (
            <div aria-label={`The same data as ${formatLabel(target)}`}>
              {converted.ok ? (
                <>
                  <pre className="mono">{converted.text}</pre>
                  <div className="desk-actions">
                    <button
                      type="button"
                      className="btn"
                      onClick={() => {
                        onChange({ format: target, text: converted.text, context: state.context });
                        setTarget(null);
                      }}
                    >
                      Edit the {formatLabel(target)} version
                    </button>
                  </div>
                </>
              ) : (
                <p className="insp-note" role="alert">
                  <span aria-hidden="true">⚠ </span>
                  {converted.message}
                </p>
              )}
            </div>
          )}
        </>
      )}
    </>
  );
}

// ── device answers ──────────────────────────────────────────────────────────

export function SamplesPane({ onOpen }: { onOpen: (next: DataEditorState) => void }) {
  return (
    <>
      <p className="dim">What a device sends back when a program asks it for data over RESTCONF. Open any answer in the editor to read its tree or rewrite it.</p>
      {dataSamples().map((s) => (
        <section key={s.id} aria-label={s.title}>
          <div className="panel-title">
            {s.title} <span className="dim">({s.device})</span>
          </div>
          <p className="mono">{s.request}</p>
          <pre className="mono">{s.json}</pre>
          <div className="desk-actions">
            <button type="button" className="btn" aria-label={`Open “${s.title}” in the editor`} onClick={() => onOpen({ format: 'json', text: s.json, context: s.path })}>
              Open in the editor
            </button>
          </div>
        </section>
      ))}
    </>
  );
}

// ── practice ────────────────────────────────────────────────────────────────

export function DataPracticePane() {
  const uid = useId();
  const [seed, setSeed] = useState(1);
  const [index, setIndex] = useState(0);
  const [answer, setAnswer] = useState('');
  const [checked, setChecked] = useState<DataCheck | null>(null);
  const problem = useMemo(() => dataPractice(seed, index), [seed, index]);
  const move = (nextIndex: number, nextSeed = seed): void => {
    setSeed(nextSeed);
    setIndex(nextIndex);
    setAnswer('');
    setChecked(null);
  };
  return (
    <>
      <div className="dock-toolbar">
        <div className="desk-field">
          <label htmlFor={`${uid}-seed`}>Question set</label>
          <input id={`${uid}-seed`} className="input mono" type="number" value={seed} onChange={(e) => move(0, Math.trunc(Number(e.target.value)) || 0)} />
        </div>
        <span className="dim">Question {index + 1}. The same set number always asks the same questions.</span>
      </div>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          setChecked(checkDataAnswer(problem, answer));
        }}
      >
        <p>{problem.prompt}</p>
        <pre className="mono" aria-label={`The ${formatLabel(problem.format)} document`}>
          {problem.document}
        </pre>
        <div className="desk-field">
          <label htmlFor={`${uid}-answer`}>Your answer</label>
          <input id={`${uid}-answer`} className="input mono" value={answer} spellCheck={false} autoComplete="off" onChange={(e) => setAnswer(e.target.value)} />
          <span className="dim">{problem.kind === 'type' ? 'A type: object, array, string, number, boolean or null.' : 'A key path such as interfaces.interface[0].name.'}</span>
        </div>
        <div className="desk-actions">
          <button type="submit" className="btn btn-primary">
            Check
          </button>
          <button type="button" className="btn" onClick={() => move(index + 1)}>
            Next question
          </button>
        </div>
      </form>
      {/* Mounted before there is an answer, so a screen reader hears the verdict when it arrives. */}
      <div className={`insp-note${checked === null ? ' is-empty' : ''}`} role="status" aria-live="polite">
        {checked !== null && (
          <>
            <p>
              <span aria-hidden="true">{checked.correct ? '✓ ' : '✗ '}</span>
              {checked.correct ? 'That is right.' : `Not yet — the answer is ${checked.expected}.`}
              {!checked.correct && checked.given === null && (problem.kind === 'type' ? ' That answer is not the name of a type.' : ' That answer could not be read as a key path.')}
            </p>
            <p className="dim">{checked.explanation}</p>
          </>
        )}
      </div>
    </>
  );
}
