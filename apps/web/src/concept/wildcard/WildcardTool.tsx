/**
 * [S9] Wildcard visualizer (ARCHITECTURE-P3 §6 "Wildcard visualizer"; W3 web-concept): the concept tool over
 * `concept/wildcard/model.ts`.
 *
 * Three panes, one at a time:
 *  - **Bits and matches** — an address and its wildcard laid out as three 32-bit rows (Address, Wildcard, Result).
 *    A 0 in the wildcard is a bit that must match: its column is drawn solid and the Result row repeats the address
 *    bit. A 1 is a bit that may be anything: its column is hatched and the Result row shows `*`. Below come the count
 *    of addresses matched, the lowest and highest, whether they form one block (and its prefix), the access-list form
 *    and a sentence per octet. An address can be tested against the pair: the verdict is the engine's own matcher
 *    (through the model), and the must-match bits it gets wrong are marked ✗ in their columns.
 *  - **Build a wildcard** — from a prefix (`10.1.0.0/16`), from a range of addresses (the fewest address/wildcard
 *    pairs whose union is exactly the range, as a device's access-list builder computes them) or from a bit pattern of
 *    `0`, `1` and `*`; each result opens in the bit view.
 *  - **Practice** — the seeded question generator: the same question set always asks the same questions.
 *
 * Solid and hatched are a second channel only: the `*` in the Result row, the column marks and the sentences carry
 * the meaning in text. Every figure comes from the model; nothing is computed here. Wording is original.
 */
import { useId, useMemo, useState, type CSSProperties } from 'react';
import { parseIpv4 } from '@netforge/engine/pure';
import {
  checkWildcardAnswer,
  parseWildcardInput,
  testWildcard,
  wildcardFromPattern,
  wildcardFromPrefix,
  wildcardPractice,
  wildcardView,
  wildcardsFromRange,
  type WildcardCheck,
  type WildcardPair,
  type WildcardTest,
  type WildcardView,
} from './model';

/** Panes of the visualizer. */
export type WildcardPane = 'bits' | 'build' | 'practice';

/** Pane names in display order. */
export const WILDCARD_PANES: readonly { readonly id: WildcardPane; readonly label: string }[] = Object.freeze([
  { id: 'bits', label: 'Bits and matches' },
  { id: 'build', label: 'Build a wildcard' },
  { id: 'practice', label: 'Practice' },
]);

/** The pair the bit view opens on: a /20 block, so the wildcard ends inside the third octet. */
export const DEFAULT_WILDCARD_INPUT = '172.16.32.0 0.0.15.255';
/** The address the test box opens with (inside the default block). */
export const DEFAULT_WILDCARD_TEST = '172.16.40.7';

/** Solid: a must-match column. Hatched: an any-bit column (the `*` says the same in text). */
const SOLID: CSSProperties = { background: 'var(--accent)', color: 'var(--accent-ink)', textAlign: 'center', padding: '1px 2px' };
const HATCHED: CSSProperties = {
  backgroundImage: 'repeating-linear-gradient(135deg, var(--border-strong) 0 2px, transparent 2px 6px)',
  color: 'var(--text)',
  textAlign: 'center',
  padding: '1px 2px',
};
const PLAIN: CSSProperties = { textAlign: 'center', padding: '1px 2px' };
const DOT: CSSProperties = { padding: '1px 1px', color: 'var(--text-faint)' };

/** The pair `text` names, or the model's reason for refusing it. */
export function readWildcard(text: string): { readonly view: WildcardView } | { readonly error: string } {
  const parsed = parseWildcardInput(text);
  if (!parsed.ok) return { error: parsed.error };
  return { view: wildcardView(parsed.value.address, parsed.value.wildcard) };
}

/** The bit view's input text of a pair (`A W`, as an access list writes it before the `host`/`any` shorthand). */
export function pairInput(pair: WildcardPair): string {
  return `${pair.address} ${pair.wildcard}`;
}

/** Reads `A.B.C.D/N` into a pair, or says why it cannot. */
export function readPrefix(text: string): { readonly pair: WildcardPair; readonly prefixLen: number } | { readonly error: string } {
  const m = /^\s*(\S+?)\s*\/\s*(\d{1,2})\s*$/.exec(text);
  if (m === null) return { error: 'Write a network and its prefix length, for example 10.1.0.0/16.' };
  if (parseIpv4(m[1]!) === null) return { error: `"${m[1]!}" is not a valid IPv4 address.` };
  const len = Number(m[2]);
  if (len > 32) return { error: 'A prefix length runs from 0 to 32.' };
  return { pair: wildcardFromPrefix(m[1]!, len), prefixLen: len };
}

/** The verdict of testing `candidate` (null while the box is empty), or why the text is not an address. */
export function readTest(pair: WildcardPair, candidate: string): { readonly test: WildcardTest } | { readonly error: string } | null {
  const t = candidate.trim();
  if (t === '') return null;
  if (parseIpv4(t) === null) return { error: `"${t}" is not a valid IPv4 address.` };
  return { test: testWildcard(pair, t) };
}

/** The 32 bits of a dotted address, leftmost first. */
function bitsOf(address: string): string {
  const v = parseIpv4(address);
  return v === null ? '' : (v >>> 0).toString(2).padStart(32, '0');
}

export function WildcardTool() {
  const uid = useId();
  const [pane, setPane] = useState<WildcardPane>('bits');
  const [input, setInput] = useState(DEFAULT_WILDCARD_INPUT);
  const open = (pair: WildcardPair): void => {
    setInput(pairInput(pair));
    setPane('bits');
  };
  return (
    <div className="dock-panel">
      <div className="dock-toolbar" role="group" aria-label="Wildcard panes">
        {WILDCARD_PANES.map((p) => (
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
        {pane === 'bits' && <BitsView input={input} onInput={setInput} />}
        {pane === 'build' && <BuildPane onOpen={open} />}
        {pane === 'practice' && <WildcardPracticePane />}
      </div>
    </div>
  );
}

// ── bits and matches ────────────────────────────────────────────────────────

export function BitsView({ input, onInput }: { input: string; onInput: (text: string) => void }) {
  const uid = useId();
  const [candidate, setCandidate] = useState(DEFAULT_WILDCARD_TEST);
  const read = useMemo(() => readWildcard(input), [input]);
  return (
    <>
      <div className="desk-field">
        <label htmlFor={`${uid}-pair`}>Address and wildcard</label>
        <input
          id={`${uid}-pair`}
          className="input mono"
          value={input}
          spellCheck={false}
          autoComplete="off"
          aria-invalid={'error' in read}
          aria-describedby={'error' in read ? `${uid}-pair-err` : undefined}
          onChange={(e) => onInput(e.target.value)}
        />
        <span className="dim">As an access list writes it: 192.168.1.0 0.0.0.255, host 10.0.0.5 or any.</span>
      </div>
      {'error' in read ? (
        <p id={`${uid}-pair-err`} className="insp-note" role="alert">
          <span aria-hidden="true">⚠ </span>
          {read.error}
        </p>
      ) : (
        <WildcardReport view={read.view} candidate={candidate} onCandidate={setCandidate} />
      )}
    </>
  );
}

function WildcardReport({ view, candidate, onCandidate }: { view: WildcardView; candidate: string; onCandidate: (text: string) => void }) {
  const uid = useId();
  const pair: WildcardPair = { address: view.address, wildcard: view.wildcard };
  const tested = readTest(pair, candidate);
  const figures: readonly (readonly [string, string])[] = [
    ['Addresses matched', `${view.count} (2 to the power ${view.anyBits})`],
    ['Lowest address', view.first],
    ['Highest address', view.last],
    ['One block?', view.contiguous ? `yes: ${view.first}/${view.prefixLen ?? 0}` : 'no: there are gaps between the matches'],
    ['Access-list form', view.aceText],
  ];
  return (
    <>
      {view.normalised && (
        <p className="insp-note">
          <span aria-hidden="true">⚑ </span>
          Some address bits sit under 1s in the wildcard, so they are ignored: a device stores {view.base} {view.wildcard}.
        </p>
      )}
      <BitGrid view={view} test={tested !== null && 'test' in tested ? tested.test : undefined} />
      <p className="dim">
        In the Result row, <span aria-hidden="true">■ </span>a solid bit must match and <span aria-hidden="true">▨ </span>a hatched bit, shown as *, may be
        anything.
      </p>
      <table className="table">
        <caption className="dim">The three rows as text.</caption>
        <tbody>
          <tr>
            <th scope="row">Address</th>
            <td className="mono">{view.rows.address}</td>
          </tr>
          <tr>
            <th scope="row">Wildcard</th>
            <td className="mono">{view.rows.wildcard}</td>
          </tr>
          <tr>
            <th scope="row">Result</th>
            <td className="mono">{view.rows.result}</td>
          </tr>
        </tbody>
      </table>

      <div className="panel-title">What it matches</div>
      <p>{view.sentence}</p>
      <table className="table">
        <tbody>
          {figures.map(([label, value]) => (
            <tr key={label}>
              <th scope="row">{label}</th>
              <td className="mono">{value}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <ul>
        {view.octets.map((o) => (
          <li key={o}>{o}</li>
        ))}
      </ul>

      <div className="panel-title">Test an address</div>
      <div className="desk-field">
        <label htmlFor={`${uid}-test`}>Address to test</label>
        <input
          id={`${uid}-test`}
          className="input mono"
          value={candidate}
          spellCheck={false}
          autoComplete="off"
          aria-invalid={tested !== null && 'error' in tested}
          onChange={(e) => onCandidate(e.target.value)}
        />
      </div>
      <div role="status" aria-live="polite">
        {tested !== null &&
          ('error' in tested ? (
            <p className="insp-note">
              <span aria-hidden="true">⚠ </span>
              {tested.error}
            </p>
          ) : (
            <p>
              <span aria-hidden="true">{tested.test.matches ? '✓ ' : '✗ '}</span>
              {tested.test.text}
            </p>
          ))}
      </div>
    </>
  );
}

/** The 32 columns, bit 31 first, with a dot between octets. */
export function BitGrid({ view, test }: { view: WildcardView; test?: WildcardTest | undefined }) {
  const tested = test === undefined ? '' : bitsOf(test.candidate);
  const wrong = new Set(test?.wrongBits ?? []);
  const cells = (render: (i: number) => { text: string; style: CSSProperties; kind?: string }) =>
    view.bits.flatMap((b) => {
      const c = render(b.index);
      const cell = (
        <td key={b.index} className="mono" style={c.style} data-bit={c.kind}>
          {c.text}
        </td>
      );
      return b.index > 0 && b.index % 8 === 0
        ? [
            <td key={`dot-${b.index}`} style={DOT} aria-hidden="true">
              .
            </td>,
            cell,
          ]
        : [cell];
    });
  const column = (i: number): CSSProperties => (view.bits[i]!.mustMatch ? SOLID : HATCHED);
  return (
    <table className="table" style={{ width: 'auto' }}>
      <caption className="dim">
        {view.address} {view.wildcard}, bit by bit: {32 - view.anyBits} bit{32 - view.anyBits === 1 ? '' : 's'} must match, {view.anyBits} may be anything.
      </caption>
      <tbody>
        <tr>
          <th scope="row">Address</th>
          {cells((i) => ({ text: view.bits[i]!.address, style: PLAIN }))}
        </tr>
        <tr>
          <th scope="row">Wildcard</th>
          {cells((i) => ({ text: view.bits[i]!.wildcard, style: PLAIN }))}
        </tr>
        <tr>
          <th scope="row">Result</th>
          {cells((i) => ({ text: view.bits[i]!.result, style: column(i), kind: view.bits[i]!.mustMatch ? 'must' : 'any' }))}
        </tr>
        {test !== undefined && (
          <>
            <tr>
              <th scope="row">Tested</th>
              {cells((i) => ({ text: tested[i] ?? '', style: PLAIN }))}
            </tr>
            <tr>
              <th scope="row">Check</th>
              {cells((i) => ({ text: !view.bits[i]!.mustMatch ? '·' : wrong.has(i) ? '✗' : '✓', style: PLAIN, kind: wrong.has(i) ? 'wrong' : undefined }))}
            </tr>
          </>
        )}
      </tbody>
    </table>
  );
}

// ── build ───────────────────────────────────────────────────────────────────

export function BuildPane({ onOpen }: { onOpen: (pair: WildcardPair) => void }) {
  const uid = useId();
  const [prefix, setPrefix] = useState('10.20.0.0/14');
  const [first, setFirst] = useState('192.168.1.10');
  const [last, setLast] = useState('192.168.1.40');
  const [pattern, setPattern] = useState('11000000.10101000.000*0001.********');
  const fromPrefix = useMemo(() => readPrefix(prefix), [prefix]);
  const fromRange = useMemo(() => {
    if (parseIpv4(first) === null) return { error: `"${first.trim()}" is not a valid IPv4 address.` };
    if (parseIpv4(last) === null) return { error: `"${last.trim()}" is not a valid IPv4 address.` };
    const entries = wildcardsFromRange(first.trim(), last.trim());
    return entries.length === 0 ? { error: 'The first address must not come after the last one.' } : { entries };
  }, [first, last]);
  const fromPattern = useMemo(() => wildcardFromPattern(pattern), [pattern]);
  return (
    <>
      <section aria-labelledby={`${uid}-h-prefix`}>
        <div className="panel-title" id={`${uid}-h-prefix`}>
          From a prefix
        </div>
        <div className="desk-field">
          <label htmlFor={`${uid}-prefix`}>Network and prefix length</label>
          <input id={`${uid}-prefix`} className="input mono" value={prefix} spellCheck={false} autoComplete="off" onChange={(e) => setPrefix(e.target.value)} />
        </div>
        {'error' in fromPrefix ? (
          <p className="insp-note" role="alert">
            <span aria-hidden="true">⚠ </span>
            {fromPrefix.error}
          </p>
        ) : (
          <p>
            The wildcard is the mask inverted: <span className="mono">{pairInput(fromPrefix.pair)}</span>{' '}
            <button type="button" className="btn" onClick={() => onOpen(fromPrefix.pair)}>
              Show its bits
            </button>
          </p>
        )}
      </section>

      <section aria-labelledby={`${uid}-h-range`}>
        <div className="panel-title" id={`${uid}-h-range`}>
          From a range of addresses
        </div>
        <div className="dock-toolbar">
          <div className="desk-field">
            <label htmlFor={`${uid}-first`}>First address</label>
            <input id={`${uid}-first`} className="input mono" value={first} spellCheck={false} autoComplete="off" onChange={(e) => setFirst(e.target.value)} />
          </div>
          <div className="desk-field">
            <label htmlFor={`${uid}-last`}>Last address</label>
            <input id={`${uid}-last`} className="input mono" value={last} spellCheck={false} autoComplete="off" onChange={(e) => setLast(e.target.value)} />
          </div>
        </div>
        {'error' in fromRange ? (
          <p className="insp-note" role="alert">
            <span aria-hidden="true">⚠ </span>
            {fromRange.error}
          </p>
        ) : (
          <>
            <p>
              {fromRange.entries.length === 1
                ? 'One entry matches exactly this range.'
                : `No single wildcard matches exactly this range; these ${fromRange.entries.length} entries together do, with nothing outside it.`}
            </p>
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">Entry</th>
                  <th scope="col">Addresses</th>
                  <th scope="col">Bits</th>
                </tr>
              </thead>
              <tbody>
                {fromRange.entries.map((e) => (
                  <tr key={e.aceText}>
                    <td className="mono">{e.aceText}</td>
                    <td className="mono">{e.count}</td>
                    <td>
                      <button type="button" className="btn" aria-label={`Show the bits of ${e.aceText}`} onClick={() => onOpen(e)}>
                        Show
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
      </section>

      <section aria-labelledby={`${uid}-h-pattern`}>
        <div className="panel-title" id={`${uid}-h-pattern`}>
          From a bit pattern
        </div>
        <div className="desk-field">
          <label htmlFor={`${uid}-pattern`}>32 symbols: 0 or 1 must match, * may be anything</label>
          <input id={`${uid}-pattern`} className="input mono" value={pattern} spellCheck={false} autoComplete="off" onChange={(e) => setPattern(e.target.value)} />
        </div>
        {fromPattern.ok ? (
          <p>
            That pattern is <span className="mono">{pairInput(fromPattern.value)}</span>{' '}
            <button type="button" className="btn" onClick={() => onOpen(fromPattern.value)}>
              Show its bits
            </button>
          </p>
        ) : (
          <p className="insp-note" role="alert">
            <span aria-hidden="true">⚠ </span>
            {fromPattern.error}
          </p>
        )}
      </section>
    </>
  );
}

// ── practice ────────────────────────────────────────────────────────────────

export function WildcardPracticePane() {
  const uid = useId();
  const [seed, setSeed] = useState(1);
  const [index, setIndex] = useState(0);
  const [answer, setAnswer] = useState('');
  const [checked, setChecked] = useState<WildcardCheck | null>(null);
  const problem = useMemo(() => wildcardPractice(seed, index), [seed, index]);
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
          setChecked(checkWildcardAnswer(problem, answer));
        }}
      >
        <p>{problem.prompt}</p>
        <div className="desk-field">
          <label htmlFor={`${uid}-answer`}>Your answer</label>
          <input id={`${uid}-answer`} className="input mono" value={answer} spellCheck={false} autoComplete="off" onChange={(e) => setAnswer(e.target.value)} />
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
              {!checked.correct && checked.given === null && ' That answer could not be read.'}
            </p>
            <p className="dim">{checked.explanation}</p>
          </>
        )}
      </div>
    </>
  );
}
