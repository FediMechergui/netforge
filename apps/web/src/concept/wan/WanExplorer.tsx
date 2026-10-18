/**
 * [S22] WAN and VPN explorer (ARCHITECTURE-P3C §7 W1b web-concept (a), §8.1 S22; lessons 21 and 23): the concept tool
 * over `concept/wan/model.ts`. A lazy chunk, opened from the View menu or a `concept:wan` link.
 *
 * Four panes, one at a time:
 *  - **WAN kinds** — any two or three kinds side by side, with the rows where they differ marked in text.
 *  - **VPN kinds** — what each VPN kind is, and the layers that wrap one inner packet, outermost first, with their
 *    sizes; the encrypted ones are marked in text, and the largest packet that fits a 1500-byte link is given.
 *  - **Label stacks** — a packet walked across a provider core hop by hop (with or without penultimate-hop popping),
 *    and a sandbox where push, swap and pop are applied by hand and refusals are explained.
 *  - **Quiz** — the seeded quiz, scored by the model.
 *
 * Every figure comes from the model; nothing is computed here. Wording is original.
 */
import { useId, useMemo, useState } from 'react';
import {
  VPN_KINDS,
  WAN_KINDS,
  applyLabelOp,
  compareWanKinds,
  encapsulate,
  labelOpText,
  maxInnerPacket,
  scoreWanQuiz,
  stackHex,
  stackText,
  vpnKind,
  walkLsp,
  wanQuiz,
  type LabelState,
  type LspScenarioId,
  type QuizScore,
  type VpnKindId,
  type WanKindId,
} from './model';

/** Panes of the explorer. */
export type WanPane = 'kinds' | 'vpn' | 'labels' | 'quiz';

/** Pane names in display order. */
export const WAN_PANES: readonly { readonly id: WanPane; readonly label: string }[] = Object.freeze([
  { id: 'kinds', label: 'WAN kinds' },
  { id: 'vpn', label: 'VPN kinds' },
  { id: 'labels', label: 'Label stacks' },
  { id: 'quiz', label: 'Quiz' },
]);

/** The kinds the comparison opens with. */
export const DEFAULT_WAN_COMPARE: readonly WanKindId[] = Object.freeze(['mpls', 'dsl', 'cellular']);

export function WanExplorer() {
  const uid = useId();
  const [pane, setPane] = useState<WanPane>('kinds');
  return (
    <div className="dock-panel">
      <div className="dock-toolbar" role="group" aria-label="WAN explorer panes">
        {WAN_PANES.map((p) => (
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
        {pane === 'kinds' && <WanKindsPane />}
        {pane === 'vpn' && <VpnPane />}
        {pane === 'labels' && <LabelsPane />}
        {pane === 'quiz' && <WanQuizPane />}
      </div>
    </div>
  );
}

// ── WAN kinds ───────────────────────────────────────────────────────────────

export function WanKindsPane() {
  const uid = useId();
  const [picked, setPicked] = useState<readonly WanKindId[]>(DEFAULT_WAN_COMPARE);
  const rows = useMemo(() => compareWanKinds(picked), [picked]);
  const set = (i: number, id: WanKindId): void => setPicked(picked.map((p, j) => (j === i ? id : p)));
  return (
    <>
      <p>
        Private WAN services promise their bandwidth in a contract; internet access is cheaper and quicker to install, and a VPN on top keeps it private.
        Pick kinds to compare.
      </p>
      <div className="dock-toolbar">
        {picked.map((id, i) => (
          <div className="desk-field" key={i}>
            <label htmlFor={`${uid}-k${i}`}>Kind {i + 1}</label>
            <select id={`${uid}-k${i}`} className="input" value={id} onChange={(e) => set(i, e.target.value as WanKindId)}>
              {WAN_KINDS.map((k) => (
                <option key={k.id} value={k.id}>
                  {k.label}
                </option>
              ))}
            </select>
          </div>
        ))}
      </div>
      <table className="table">
        <caption className="dim">Rows marked ≠ differ between the kinds chosen.</caption>
        <thead>
          <tr>
            <th scope="col">Property</th>
            {picked.map((id, i) => (
              <th scope="col" key={i}>
                {WAN_KINDS.find((k) => k.id === id)?.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.property} data-differs={r.differs}>
              <th scope="row">
                {r.differs && <span aria-label="differs">≠ </span>}
                {r.property}
              </th>
              {r.values.map((v, i) => (
                <td key={i}>{v}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      <p className="dim">
        Topologies: point-to-point joins two sites, hub-and-spoke joins branches through one centre, a full mesh joins every pair. A dual-homed site has two
        links to one provider; a multihomed site has links to two.
      </p>
    </>
  );
}

// ── VPN kinds ───────────────────────────────────────────────────────────────

export function VpnPane() {
  const uid = useId();
  const [kind, setKind] = useState<VpnKindId>('gre-over-ipsec');
  const [innerText, setInnerText] = useState('1000');
  const inner = Math.trunc(Number(innerText));
  const valid = Number.isFinite(inner) && inner >= 20 && inner <= 9000;
  const k = vpnKind(kind);
  const enc = useMemo(() => (valid ? encapsulate(kind, inner) : null), [kind, inner, valid]);
  const fits = maxInnerPacket(kind, 1500);
  return (
    <>
      <div className="dock-toolbar">
        <div className="desk-field">
          <label htmlFor={`${uid}-kind`}>VPN kind</label>
          <select id={`${uid}-kind`} className="input" value={kind} onChange={(e) => setKind(e.target.value as VpnKindId)}>
            {VPN_KINDS.map((v) => (
              <option key={v.id} value={v.id}>
                {v.label}
              </option>
            ))}
          </select>
        </div>
        <div className="desk-field">
          <label htmlFor={`${uid}-inner`}>Inner packet (bytes)</label>
          <input id={`${uid}-inner`} className="input mono" type="number" value={innerText} aria-invalid={!valid} onChange={(e) => setInnerText(e.target.value)} />
        </div>
      </div>
      <p>{k.summary}</p>
      <table className="table">
        <tbody>
          <tr>
            <th scope="row">Reach</th>
            <td>{k.scope}</td>
          </tr>
          <tr>
            <th scope="row">Built and run by</th>
            <td>{k.builtBy === 'provider' ? 'the provider' : 'the customer'}</td>
          </tr>
          <tr>
            <th scope="row">Encrypts</th>
            <td>{k.encrypts ? 'yes' : 'no: anyone on the path can read the inner packet'}</td>
          </tr>
          <tr>
            <th scope="row">Routing protocols across it</th>
            <td>{k.routing}</td>
          </tr>
          <tr>
            <th scope="row">Largest inner packet on a 1500-byte link</th>
            <td className="mono">{fits} bytes</td>
          </tr>
        </tbody>
      </table>
      {enc === null ? (
        <p className="insp-note" role="alert">
          <span aria-hidden="true">⚠ </span>
          An inner IPv4 packet is a whole number of bytes from 20 to 9000.
        </p>
      ) : (
        <>
          <div className="panel-title">The packet on the wire, outermost first</div>
          <table className="table">
            <thead>
              <tr>
                <th scope="col">Layer</th>
                <th scope="col">Bytes</th>
                <th scope="col">Seen on the path</th>
              </tr>
            </thead>
            <tbody>
              {enc.layers.map((l, i) => (
                <tr key={i} data-inner={l.inner === true}>
                  <td>{l.name}</td>
                  <td className="mono">{l.bytes}</td>
                  <td>{l.encrypted === true ? 'encrypted' : 'in clear'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p>
            {enc.inner} bytes of the customer become {enc.total} bytes on the provider&apos;s link: {enc.overhead} bytes of overhead.
            {enc.total > 1500 ? ' That is more than a 1500-byte link carries, so it would have to be fragmented or dropped.' : ''}
          </p>
        </>
      )}
    </>
  );
}

// ── label stacks ────────────────────────────────────────────────────────────

const START: LabelState = Object.freeze({ stack: Object.freeze([]), ipTtl: 64 });

export function LabelsPane() {
  const uid = useId();
  const [scenario, setScenario] = useState<LspScenarioId>('l3vpn');
  const [php, setPhp] = useState(true);
  const walk = useMemo(() => walkLsp(scenario, php), [scenario, php]);
  return (
    <>
      <p>
        Inside a provider core, routers forward by short labels rather than by IP address. Each label stack entry is 4 bytes: a 20-bit label, a 3-bit traffic
        class, a bottom-of-stack bit and a TTL. The canvas draws the provider as one cloud; here is what happens inside it.
      </p>
      <div className="dock-toolbar">
        <div className="desk-field">
          <label htmlFor={`${uid}-scn`}>Path</label>
          <select id={`${uid}-scn`} className="input" value={scenario} onChange={(e) => setScenario(e.target.value as LspScenarioId)}>
            <option value="l3vpn">Layer 3 VPN: a VPN label under a transport label</option>
            <option value="transport">Transport only: one label</option>
          </select>
        </div>
        <div className="desk-field">
          <label htmlFor={`${uid}-php`}>
            <input id={`${uid}-php`} type="checkbox" checked={php} onChange={(e) => setPhp(e.target.checked)} /> Penultimate-hop popping
          </label>
        </div>
      </div>
      <table className="table">
        <caption className="dim">The packet as it leaves each router; stacks are written top first.</caption>
        <thead>
          <tr>
            <th scope="col">Router</th>
            <th scope="col">Operations</th>
            <th scope="col">Stack</th>
            <th scope="col">On the wire</th>
            <th scope="col">TTL</th>
          </tr>
        </thead>
        <tbody>
          {walk.hops.map((h) => (
            <tr key={h.router}>
              <th scope="row">
                {h.router} <span className="dim">({h.role})</span>
              </th>
              <td className="mono">{h.ops.length === 0 ? '—' : h.ops.map(labelOpText).join(', ')}</td>
              <td className="mono">{stackText(h.state.stack)}</td>
              <td className="mono">{h.state.stack.length === 0 ? '—' : stackHex(h.state.stack)}</td>
              <td className="mono">{h.state.stack[0]?.ttl ?? h.state.ipTtl}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <ol>
        {walk.hops.map((h) => (
          <li key={h.router}>{h.text}</li>
        ))}
      </ol>
      {walk.error !== undefined && (
        <p className="insp-note" role="alert">
          {walk.error}
        </p>
      )}
      <LabelSandbox />
    </>
  );
}

export function LabelSandbox() {
  const uid = useId();
  const [state, setState] = useState<LabelState>(START);
  const [labelText, setLabelText] = useState('100');
  const [message, setMessage] = useState<string>('The stack is empty: an ordinary IP packet with TTL 64.');
  const run = (op: 'push' | 'swap' | 'pop'): void => {
    const label = Math.trunc(Number(labelText));
    const res = applyLabelOp(state, op === 'pop' ? { op } : { op, label });
    if (!res.ok) {
      setMessage(`Refused: ${res.error}`);
      return;
    }
    setState(res.state);
    setMessage(`${op === 'pop' ? 'Popped' : op === 'push' ? `Pushed ${label}` : `Swapped the top label for ${label}`}. The stack is now ${stackText(res.state.stack)}.`);
  };
  return (
    <section aria-labelledby={`${uid}-h`}>
      <div className="panel-title" id={`${uid}-h`}>
        Try it by hand
      </div>
      <div className="dock-toolbar">
        <div className="desk-field">
          <label htmlFor={`${uid}-label`}>Label</label>
          <input id={`${uid}-label`} className="input mono" type="number" value={labelText} onChange={(e) => setLabelText(e.target.value)} />
        </div>
        <div className="desk-actions">
          <button type="button" className="btn" onClick={() => run('push')}>
            Push
          </button>
          <button type="button" className="btn" onClick={() => run('swap')}>
            Swap
          </button>
          <button type="button" className="btn" onClick={() => run('pop')}>
            Pop
          </button>
          <button
            type="button"
            className="btn"
            onClick={() => {
              setState(START);
              setMessage('Cleared: an ordinary IP packet with TTL 64.');
            }}
          >
            Clear
          </button>
        </div>
      </div>
      <table className="table">
        <thead>
          <tr>
            <th scope="col">Position</th>
            <th scope="col">Label</th>
            <th scope="col">Traffic class</th>
            <th scope="col">Bottom</th>
            <th scope="col">TTL</th>
          </tr>
        </thead>
        <tbody>
          {state.stack.map((e, i) => (
            <tr key={i}>
              <th scope="row">{i === 0 ? 'top' : i + 1}</th>
              <td className="mono">{e.label}</td>
              <td className="mono">{e.tc}</td>
              <td>{e.bottom ? 'yes' : 'no'}</td>
              <td className="mono">{e.ttl}</td>
            </tr>
          ))}
          <tr>
            <th scope="row">IP header</th>
            <td colSpan={3} className="dim">
              under the labels
            </td>
            <td className="mono">{state.ipTtl}</td>
          </tr>
        </tbody>
      </table>
      <p role="status" aria-live="polite">
        {message}
      </p>
    </section>
  );
}

// ── quiz ────────────────────────────────────────────────────────────────────

export function WanQuizPane() {
  const uid = useId();
  const [seed, setSeed] = useState(1);
  const quiz = useMemo(() => wanQuiz(seed), [seed]);
  const [answers, setAnswers] = useState<readonly (number | null)[]>([]);
  const [score, setScore] = useState<QuizScore | null>(null);
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
          setScore(scoreWanQuiz(quiz, answers));
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
      {/* Mounted before there is a score, so a screen reader hears it when it arrives. */}
      <div className={`insp-note${score === null ? ' is-empty' : ''}`} role="status" aria-live="polite">
        {score !== null && <p>{score.summary}</p>}
      </div>
    </>
  );
}
