/**
 * [C26] Controller explorer (ARCHITECTURE-P3C §7 W1b web-concept (a), §8.2 C26; lesson 36, CCNA3.automation.8): the
 * concept tool over `concept/sdn/model.ts`. A lazy chunk, opened from the View menu or a `concept:sdn` link.
 *
 * Five panes, one at a time:
 *  - **Planes** — the three planes, and a set of device jobs to sort into them, scored by the model.
 *  - **Controller** — the northbound and southbound interfaces, and one change counted box by box against a controller.
 *  - **Underlay and overlay** — a spine-and-leaf fabric: take underlay links down and watch which overlay tunnels
 *    survive, with the path each one now takes.
 *  - **Intent** — an outcome turned into per-device lines; edit a device by hand and assurance names the drift; push
 *    the intent again to repair it.
 *  - **Quiz** — the seeded quiz, scored by the model.
 *
 * Every figure comes from the model; nothing is computed here. Wording is original; no product is named.
 */
import { useId, useMemo, useState } from 'react';
import {
  CONTROLLER_INTERFACES,
  PLANES,
  PLANE_TASKS,
  SDN_FABRIC,
  SDN_INTENTS,
  assureIntent,
  changeEffort,
  compileIntent,
  driftConfig,
  overlayStatus,
  scorePlanes,
  scoreSdnQuiz,
  sdnQuiz,
  type IntentId,
  type Plane,
  type PlaneScore,
  type SdnQuizScore,
} from './model';

/** Panes of the explorer. */
export type SdnPane = 'planes' | 'controller' | 'fabric' | 'intent' | 'quiz';

/** Pane names in display order. */
export const SDN_PANES: readonly { readonly id: SdnPane; readonly label: string }[] = Object.freeze([
  { id: 'planes', label: 'Planes' },
  { id: 'controller', label: 'Controller' },
  { id: 'fabric', label: 'Underlay and overlay' },
  { id: 'intent', label: 'Intent' },
  { id: 'quiz', label: 'Quiz' },
]);

export function SdnExplorer() {
  const uid = useId();
  const [pane, setPane] = useState<SdnPane>('planes');
  return (
    <div className="dock-panel">
      <div className="dock-toolbar" role="group" aria-label="Controller explorer panes">
        {SDN_PANES.map((p) => (
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
        {pane === 'planes' && <PlanesPane />}
        {pane === 'controller' && <ControllerPane />}
        {pane === 'fabric' && <FabricPane />}
        {pane === 'intent' && <IntentPane />}
        {pane === 'quiz' && <SdnQuizPane />}
      </div>
    </div>
  );
}

// ── planes ──────────────────────────────────────────────────────────────────

export function PlanesPane() {
  const uid = useId();
  const [answers, setAnswers] = useState<Readonly<Partial<Record<string, Plane>>>>({});
  const [score, setScore] = useState<PlaneScore | null>(null);
  return (
    <>
      <table className="table">
        <thead>
          <tr>
            <th scope="col">Plane</th>
            <th scope="col">What it does</th>
            <th scope="col">With a controller</th>
          </tr>
        </thead>
        <tbody>
          {PLANES.map((p) => (
            <tr key={p.id}>
              <th scope="row">{p.label}</th>
              <td>{p.does}</td>
              <td>{p.withController}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="panel-title">Sort the jobs</div>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          setScore(scorePlanes(answers));
        }}
      >
        <table className="table">
          <tbody>
            {PLANE_TASKS.map((t, i) => (
              <tr key={t.id}>
                <th scope="row">
                  <label htmlFor={`${uid}-t${i}`}>{t.text}</label>
                </th>
                <td>
                  <select
                    id={`${uid}-t${i}`}
                    className="input"
                    value={answers[t.id] ?? ''}
                    onChange={(e) => setAnswers({ ...answers, [t.id]: e.target.value === '' ? undefined : (e.target.value as Plane) })}
                  >
                    <option value="">Choose a plane</option>
                    {PLANES.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.label}
                      </option>
                    ))}
                  </select>
                </td>
                <td>
                  {score !== null && (
                    <>
                      <span aria-hidden="true">{score.results[i]!.correct ? '✓ ' : '✗ '}</span>
                      <span className="dim">{score.results[i]!.text}</span>
                    </>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="desk-actions">
          <button type="submit" className="btn btn-primary">
            Check my sorting
          </button>
        </div>
      </form>
      <div className={`insp-note${score === null ? ' is-empty' : ''}`} role="status" aria-live="polite">
        {score !== null && <p>{score.summary}</p>}
      </div>
    </>
  );
}

// ── controller ──────────────────────────────────────────────────────────────

export function ControllerPane() {
  const uid = useId();
  const [devices, setDevices] = useState('120');
  const [lines, setLines] = useState('6');
  const effort = useMemo(() => changeEffort(Number(devices) || 0, Number(lines) || 0), [devices, lines]);
  return (
    <>
      <p>
        North is up toward applications and scripts; south is down toward the devices. The controller sits between them, sees the whole network and programs
        each device.
      </p>
      <table className="table">
        <thead>
          <tr>
            <th scope="col">Interface</th>
            <th scope="col">Faces</th>
            <th scope="col">What crosses it</th>
          </tr>
        </thead>
        <tbody>
          {CONTROLLER_INTERFACES.map((f) => (
            <tr key={f.name}>
              <th scope="row">{f.name}</th>
              <td>{f.direction === 'northbound' ? '↑ northbound, toward applications' : '↓ southbound, toward devices'}</td>
              <td>{f.carries}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="panel-title">One change, two ways</div>
      <div className="dock-toolbar">
        <div className="desk-field">
          <label htmlFor={`${uid}-dev`}>Devices that need it</label>
          <input id={`${uid}-dev`} className="input mono" type="number" min={0} value={devices} onChange={(e) => setDevices(e.target.value)} />
        </div>
        <div className="desk-field">
          <label htmlFor={`${uid}-lines`}>Lines per device</label>
          <input id={`${uid}-lines`} className="input mono" type="number" min={0} value={lines} onChange={(e) => setLines(e.target.value)} />
        </div>
      </div>
      <table className="table">
        <tbody>
          <tr>
            <th scope="row">Box by box</th>
            <td className="mono">
              {effort.boxByBox.sessions} logins, {effort.boxByBox.lines} lines
            </td>
          </tr>
          <tr>
            <th scope="row">With a controller</th>
            <td className="mono">
              {effort.controller.intents} intent, {effort.controller.pushes} pushes
            </td>
          </tr>
        </tbody>
      </table>
      <p>{effort.text}</p>
    </>
  );
}

// ── underlay and overlay ────────────────────────────────────────────────────

export function FabricPane() {
  const uid = useId();
  const [failed, setFailed] = useState<readonly string[]>([]);
  const status = useMemo(() => overlayStatus(SDN_FABRIC, failed), [failed]);
  const toggle = (id: string): void => setFailed(failed.includes(id) ? failed.filter((f) => f !== id) : [...failed, id]);
  return (
    <>
      <p>
        The underlay is the physical network and its routing: two spines, with every leaf (border B1, edges E1–E3) linked to both. The overlay is the
        tunnels between leaves. Take underlay links down and see which tunnels survive.
      </p>
      <fieldset>
        <legend>Underlay links (checked = down)</legend>
        {SDN_FABRIC.links.map((l) => (
          <span key={l.id} style={{ marginRight: '1em', whiteSpace: 'nowrap' }}>
            <input type="checkbox" id={`${uid}-${l.id}`} checked={failed.includes(l.id)} onChange={() => toggle(l.id)} />{' '}
            <label htmlFor={`${uid}-${l.id}`} className="mono">
              {l.a}–{l.b}
            </label>
          </span>
        ))}
      </fieldset>
      <table className="table">
        <thead>
          <tr>
            <th scope="col">Overlay tunnel</th>
            <th scope="col">State</th>
            <th scope="col">Underlay path</th>
          </tr>
        </thead>
        <tbody>
          {status.map((t) => (
            <tr key={t.id} data-up={t.up}>
              <th scope="row" className="mono">
                {t.id.replace('~', '–')}
              </th>
              <td>{t.up ? '▲ up' : '▼ down'}</td>
              <td className="mono">{t.path === null ? 'none' : t.path.join(' → ')}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <ul role="status" aria-live="polite">
        {status.map((t) => (
          <li key={t.id}>{t.text}</li>
        ))}
      </ul>
    </>
  );
}

// ── intent ──────────────────────────────────────────────────────────────────

export function IntentPane() {
  const uid = useId();
  const [id, setId] = useState<IntentId>('guest-internet');
  const [drifted, setDrifted] = useState<readonly string[]>([]);
  const compiled = useMemo(() => compileIntent(id), [id]);
  const actual = useMemo(() => Object.fromEntries(compiled.map((c) => [c.device, drifted.includes(c.device) ? driftConfig(c.lines) : c.lines])), [compiled, drifted]);
  const assurance = useMemo(() => assureIntent(id, actual), [id, actual]);
  return (
    <>
      <div className="desk-field">
        <label htmlFor={`${uid}-intent`}>Intent</label>
        <select
          id={`${uid}-intent`}
          className="input"
          value={id}
          onChange={(e) => {
            setId(e.target.value as IntentId);
            setDrifted([]);
          }}
        >
          {SDN_INTENTS.map((i) => (
            <option key={i.id} value={i.id}>
              {i.outcome}
            </option>
          ))}
        </select>
      </div>
      <p>
        You state the outcome once. The controller turns it into the lines below, pushes them to {compiled.length} device{compiled.length === 1 ? '' : 's'}, and
        keeps checking that each one still holds them.
      </p>
      {compiled.map((c) => {
        const a = assurance.devices.find((d) => d.device === c.device)!;
        return (
          <section key={c.device} aria-labelledby={`${uid}-${c.device}`}>
            <div className="panel-title" id={`${uid}-${c.device}`}>
              {c.device} — {a.delivered ? '✓ delivered' : '✗ drifted'}
            </div>
            <pre className="mono">{c.lines.join('\n')}</pre>
            <label htmlFor={`${uid}-${c.device}-drift`}>
              <input
                type="checkbox"
                id={`${uid}-${c.device}-drift`}
                checked={drifted.includes(c.device)}
                onChange={() => setDrifted(drifted.includes(c.device) ? drifted.filter((d) => d !== c.device) : [...drifted, c.device])}
              />{' '}
              Someone removed a line on {c.device} by hand
            </label>
            {!a.delivered && <p className="dim">Missing: {a.missing.map((l) => l.trim()).join('; ')}</p>}
          </section>
        );
      })}
      <div className="insp-note" role="status" aria-live="polite">
        <p>{assurance.text}</p>
      </div>
      <div className="desk-actions">
        <button type="button" className="btn" disabled={assurance.compliant} onClick={() => setDrifted([])}>
          Push the intent again
        </button>
      </div>
    </>
  );
}

// ── quiz ────────────────────────────────────────────────────────────────────

export function SdnQuizPane() {
  const uid = useId();
  const [seed, setSeed] = useState(1);
  const quiz = useMemo(() => sdnQuiz(seed), [seed]);
  const [answers, setAnswers] = useState<readonly (number | null)[]>([]);
  const [score, setScore] = useState<SdnQuizScore | null>(null);
  const restart = (next: number): void => {
    setSeed(next);
    setAnswers([]);
    setScore(null);
  };
  return (
    <>
      <div className="dock-toolbar">
        <div className="desk-field">
          <label htmlFor={`${uid}-seed`}>Question set</label>
          <input id={`${uid}-seed`} className="input mono" type="number" value={seed} onChange={(e) => restart(Math.trunc(Number(e.target.value)) || 0)} />
        </div>
        <span className="dim">The same set number always asks the same questions.</span>
      </div>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          setScore(scoreSdnQuiz(quiz, answers));
        }}
      >
        <ol>
          {quiz.map((q, qi) => (
            <li key={q.id}>
              <fieldset>
                <legend>{q.prompt}</legend>
                {q.options.map((o, oi) => (
                  <div key={oi}>
                    <input
                      type="radio"
                      id={`${uid}-q${qi}-o${oi}`}
                      name={`${uid}-q${qi}`}
                      checked={answers[qi] === oi}
                      onChange={() => {
                        const next = quiz.map((_, j) => answers[j] ?? null);
                        next[qi] = oi;
                        setAnswers(next);
                      }}
                    />{' '}
                    <label htmlFor={`${uid}-q${qi}-o${oi}`}>{o}</label>
                  </div>
                ))}
                {score !== null && (
                  <p className="dim">
                    <span aria-hidden="true">{score.results[qi]!.correct ? '✓ ' : '✗ '}</span>
                    {score.results[qi]!.text}
                  </p>
                )}
              </fieldset>
            </li>
          ))}
        </ol>
        <div className="desk-actions">
          <button type="submit" className="btn btn-primary">
            Score my answers
          </button>
          <button type="button" className="btn" onClick={() => restart(seed + 1)}>
            New questions
          </button>
        </div>
      </form>
      <div className={`insp-note${score === null ? ' is-empty' : ''}`} role="status" aria-live="polite">
        {score !== null && <p>{score.summary}</p>}
      </div>
    </>
  );
}
