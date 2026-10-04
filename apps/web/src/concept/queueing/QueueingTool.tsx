/**
 * Queueing sandbox (ARCHITECTURE-P3 D16, §3.5 step 7, §6 "Queueing sandbox"; W3 web-concept): the concept tool over
 * `concept/queueing/model.ts`.
 *
 * One link, two synthetic flows (the walk-through's voice and data pair, together more than the link carries), and
 * the four disciplines — FIFO, WFQ (scheduled as deficit round robin over conversations, the model's listed
 * deviation), CBWFQ and LLQ. The learner picks a discipline and walks its run step by step (first / back / step /
 * play / last): each step is the model's own sentence, the queues as they stand after it (one row per class, every
 * waiting packet named by a letter and its number) and the packet on the wire. Below, every packet's fate is a
 * sentence ("waited 41.2 ms and was sent from … to …"), and a table compares the four disciplines over the same
 * arrivals. Nothing is told by colour alone: packets carry `V`/`D` letters and the step text says everything.
 *
 * Every figure comes from `runQueueing` (which the parity case of `concept.queueing.test.ts` pins against the
 * engine's `core/queueing.ts`); nothing is recomputed here. Wording is original.
 *
 * ponytail: the flows stay the walk-through's pair; the learner changes the link and the queues (rate, queue limit,
 * class shares), which is what the lesson varies.
 */
import { useEffect, useId, useMemo, useState } from 'react';
import {
  QUEUEING_DEFAULT_SCENARIO,
  QUEUEING_DISCIPLINES,
  compareQueueing,
  msText,
  packetFateText,
  type QueueingDiscipline,
  type QueueingPacketInfo,
  type QueueingRun,
  type QueueingScenario,
} from './model';

/** Wall time between two steps while playing. */
export const QUEUEING_PLAY_INTERVAL_MS = 450;

/** Link rates the learner may choose, in kb/s (the default scenario's 128 kb/s serial line among them). */
export const QUEUEING_LINK_RATES_KBPS: readonly number[] = Object.freeze([64, 128, 256, 512]);

/** Bounds of the editable figures. */
export const QUEUEING_LIMITS = Object.freeze({ queueMin: 1, queueMax: 200, shareMin: 1, shareMax: 10_000 });

/** The editable settings, as typed. */
export interface QueueingForm {
  readonly rateKbps: string;
  readonly queueLimit: string;
  readonly voiceKbps: string;
  readonly dataKbps: string;
  readonly defaultKbps: string;
}

/** The form of the default scenario (read when asked: rule 12). */
export function defaultQueueingForm(): QueueingForm {
  const d = QUEUEING_DEFAULT_SCENARIO;
  return {
    rateKbps: String(d.rateBps / 1000),
    queueLimit: String(d.queueLimit),
    voiceKbps: String(d.voiceKbps),
    dataKbps: String(d.dataKbps),
    defaultKbps: String(d.defaultKbps),
  };
}

function wholeIn(text: string, min: number, max: number): number | null {
  const t = text.trim();
  if (!/^\d+$/.test(t)) return null;
  const n = Number(t);
  return n >= min && n <= max ? n : null;
}

/** The scenario the form describes (the default scenario's flows), or why it cannot be run. */
export function queueingScenarioOf(form: QueueingForm): { readonly ok: true; readonly scenario: QueueingScenario } | { readonly ok: false; readonly error: string } {
  const rate = wholeIn(form.rateKbps, 1, 100_000);
  if (rate === null || !QUEUEING_LINK_RATES_KBPS.includes(rate)) return { ok: false, error: `Choose a link rate of ${QUEUEING_LINK_RATES_KBPS.join(', ')} kb/s.` };
  const limit = wholeIn(form.queueLimit, QUEUEING_LIMITS.queueMin, QUEUEING_LIMITS.queueMax);
  if (limit === null) return { ok: false, error: `A queue holds ${QUEUEING_LIMITS.queueMin} to ${QUEUEING_LIMITS.queueMax} packets.` };
  const share = (text: string, name: string): number | string => {
    const v = wholeIn(text, QUEUEING_LIMITS.shareMin, QUEUEING_LIMITS.shareMax);
    return v ?? `The ${name} share is a whole number of kb/s from ${QUEUEING_LIMITS.shareMin} to ${QUEUEING_LIMITS.shareMax}.`;
  };
  const voice = share(form.voiceKbps, 'VOICE');
  if (typeof voice === 'string') return { ok: false, error: voice };
  const data = share(form.dataKbps, 'DATA');
  if (typeof data === 'string') return { ok: false, error: data };
  const def = share(form.defaultKbps, 'class-default');
  if (typeof def === 'string') return { ok: false, error: def };
  return {
    ok: true,
    scenario: { ...QUEUEING_DEFAULT_SCENARIO, rateBps: rate * 1000, queueLimit: limit, voiceKbps: voice, dataKbps: data, defaultKbps: def },
  };
}

/** A packet's short name in a queue row: `V3` for voice packet 3, `D2` for data packet 2. */
export function packetToken(p: Pick<QueueingPacketInfo, 'kind' | 'seq'>): string {
  return `${p.kind === 'voice' ? 'V' : 'D'}${p.seq}`;
}

/** A packet's long name: `voice packet 3 (80 B)`. */
export function packetLongName(p: Pick<QueueingPacketInfo, 'kind' | 'seq' | 'bytes'>): string {
  return `${p.kind} packet ${p.seq} (${p.bytes} B)`;
}

/** One class row of a step: its name and the packets waiting in it, oldest first. */
export interface QueueingQueueRow {
  readonly name: string;
  readonly priority: boolean;
  readonly tokens: readonly string[];
  /** The row as a sentence (`VOICE (priority): V3, V4 waiting` / `DATA: empty`). */
  readonly text: string;
}

/** What the tool shows for one step of a run. */
export interface QueueingStepView {
  /** 0-based step shown, and how many steps the run has. */
  readonly index: number;
  readonly total: number;
  /** `Step 4 of 76 at 20.0 ms`. */
  readonly heading: string;
  /** The model's sentence for the step. */
  readonly text: string;
  readonly queues: readonly QueueingQueueRow[];
  /** The packet on the wire after the step, as a sentence. */
  readonly wire: string;
}

/** The view of step `index` of `run` (clamped to the run's steps). */
export function queueingStepView(run: QueueingRun, index: number): QueueingStepView {
  const total = run.steps.length;
  if (total === 0) {
    return { index: 0, total: 0, heading: 'No steps', text: 'Nothing arrives, so nothing happens.', queues: [], wire: 'The link is idle.' };
  }
  const at = Math.max(0, Math.min(total - 1, Math.trunc(index)));
  const step = run.steps[at]!;
  const queues = run.spec.classes.map((cls, i): QueueingQueueRow => {
    const waiting = step.queues[i] ?? [];
    const tokens = waiting.map((n) => packetToken(run.packets[n]!));
    const priority = cls.kind === 'priority';
    const name = run.discipline === 'fifo' || run.discipline === 'wfq' ? 'Queue' : cls.name;
    const label = priority ? `${name} (priority)` : name;
    return { name: label, priority, tokens, text: `${label}: ${tokens.length === 0 ? 'empty' : `${tokens.join(', ')} waiting`}` };
  });
  const w = step.onWire;
  const wire =
    w === null
      ? 'The link is idle.'
      : `On the wire: ${packetLongName(run.packets[w.packet]!)}, from ${msText(w.start)} to ${msText(w.end)}.`;
  return { index: at, total, heading: `Step ${at + 1} of ${total} at ${msText(step.at)}`, text: step.text, queues, wire };
}

export function QueueingTool() {
  const uid = useId();
  const [discipline, setDiscipline] = useState<QueueingDiscipline>('fifo');
  const [form, setForm] = useState<QueueingForm>(defaultQueueingForm);
  const [step, setStep] = useState(0);
  const [playing, setPlaying] = useState(false);
  const read = useMemo(() => queueingScenarioOf(form), [form]);
  const runs = useMemo(() => (read.ok ? compareQueueing(read.scenario) : null), [read]);
  const run = useMemo(() => runs?.find((r) => r.discipline === discipline) ?? null, [runs, discipline]);
  const total = run?.steps.length ?? 0;
  const last = Math.max(0, total - 1);
  const at = Math.min(step, last);

  // Play: one step per interval until the last step (a wall-clock timer in the page; the model itself is pure).
  useEffect(() => {
    if (!playing) return undefined;
    if (at >= last) {
      setPlaying(false);
      return undefined;
    }
    const timer = setInterval(() => setStep((s) => Math.min(s + 1, last)), QUEUEING_PLAY_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [playing, at, last]);

  const edit = (patch: Partial<QueueingForm>): void => {
    setForm((f) => ({ ...f, ...patch }));
    setStep(0);
    setPlaying(false);
  };
  const choose = (d: QueueingDiscipline): void => {
    setDiscipline(d);
    setStep(0);
    setPlaying(false);
  };
  const shares = discipline === 'cbwfq' || discipline === 'llq';

  return (
    <div className="dock-panel">
      <div className="dock-toolbar" role="group" aria-label="Queueing discipline">
        {QUEUEING_DISCIPLINES.map((d) => (
          <button
            key={d.id}
            type="button"
            className={`tab${discipline === d.id ? ' is-active' : ''}`}
            aria-pressed={discipline === d.id}
            title={d.hint}
            onClick={() => choose(d.id)}
          >
            {d.label}
          </button>
        ))}
      </div>
      <div className="dock-scroll">
        <p className="dim">{QUEUEING_DISCIPLINES.find((d) => d.id === discipline)?.hint}</p>
        <p className="dim">
          Two flows share one link: voice, {QUEUEING_DEFAULT_SCENARIO.flows[0]!.count} packets of {QUEUEING_DEFAULT_SCENARIO.flows[0]!.bytes} bytes every{' '}
          {msText(QUEUEING_DEFAULT_SCENARIO.flows[0]!.intervalNs)}, and data, {QUEUEING_DEFAULT_SCENARIO.flows[1]!.count} packets of{' '}
          {QUEUEING_DEFAULT_SCENARIO.flows[1]!.bytes} bytes every {msText(QUEUEING_DEFAULT_SCENARIO.flows[1]!.intervalNs)}. Together they ask for more than the
          link can send, so a queue builds.
        </p>

        <div className="dock-toolbar">
          <div className="desk-field">
            <label htmlFor={`${uid}-rate`}>Link rate</label>
            <select id={`${uid}-rate`} className="select" value={form.rateKbps} onChange={(e) => edit({ rateKbps: e.target.value })}>
              {QUEUEING_LINK_RATES_KBPS.map((r) => (
                <option key={r} value={String(r)}>
                  {r} kb/s
                </option>
              ))}
            </select>
          </div>
          <div className="desk-field">
            <label htmlFor={`${uid}-limit`}>Queue limit (packets)</label>
            <input
              id={`${uid}-limit`}
              className="input mono"
              inputMode="numeric"
              value={form.queueLimit}
              autoComplete="off"
              onChange={(e) => edit({ queueLimit: e.target.value })}
            />
          </div>
          {shares && (
            <>
              <div className="desk-field">
                <label htmlFor={`${uid}-voice`}>{discipline === 'llq' ? 'VOICE priority rate (kb/s)' : 'VOICE bandwidth (kb/s)'}</label>
                <input id={`${uid}-voice`} className="input mono" inputMode="numeric" value={form.voiceKbps} autoComplete="off" onChange={(e) => edit({ voiceKbps: e.target.value })} />
              </div>
              <div className="desk-field">
                <label htmlFor={`${uid}-data`}>DATA bandwidth (kb/s)</label>
                <input id={`${uid}-data`} className="input mono" inputMode="numeric" value={form.dataKbps} autoComplete="off" onChange={(e) => edit({ dataKbps: e.target.value })} />
              </div>
              <div className="desk-field">
                <label htmlFor={`${uid}-default`}>class-default bandwidth (kb/s)</label>
                <input
                  id={`${uid}-default`}
                  className="input mono"
                  inputMode="numeric"
                  value={form.defaultKbps}
                  autoComplete="off"
                  onChange={(e) => edit({ defaultKbps: e.target.value })}
                />
              </div>
            </>
          )}
        </div>

        {!read.ok || run === null || runs === null ? (
          <p className="insp-note" role="alert">
            <span aria-hidden="true">⚠ </span>
            {read.ok ? 'The run could not be built.' : read.error}
          </p>
        ) : (
          <>
            <StepPane
              run={run}
              at={at}
              playing={playing}
              onStep={(to) => {
                setPlaying(false);
                setStep((s) => Math.max(0, Math.min(to(Math.min(s, last)), last)));
              }}
              onPlay={() => {
                if (at >= last) setStep(0);
                setPlaying((p) => !p);
              }}
            />
            <PacketFates run={run} />
            <Comparison runs={runs} current={discipline} />
          </>
        )}
      </div>
    </div>
  );
}

/** `onStep` takes the move as a function of the current step, so two quick presses make two steps. */
function StepPane({ run, at, playing, onStep, onPlay }: { run: QueueingRun; at: number; playing: boolean; onStep: (to: (current: number) => number) => void; onPlay: () => void }) {
  const view = queueingStepView(run, at);
  const last = Math.max(0, view.total - 1);
  const label = QUEUEING_DISCIPLINES.find((d) => d.id === run.discipline)?.label ?? run.discipline;
  return (
    <section aria-label={`${label}, step by step`}>
      <div className="panel-title">{label}, step by step</div>
      <div className="dock-toolbar" role="group" aria-label="Step controls">
        <button type="button" className="btn" disabled={at === 0} onClick={() => onStep(() => 0)}>
          First
        </button>
        <button type="button" className="btn" disabled={at === 0} onClick={() => onStep((c) => c - 1)}>
          Back
        </button>
        <button type="button" className="btn btn-primary" disabled={at >= last} onClick={() => onStep((c) => c + 1)}>
          Step
        </button>
        <button type="button" className="btn" aria-pressed={playing} onClick={onPlay}>
          {playing ? 'Pause' : 'Play'}
        </button>
        <button type="button" className="btn" disabled={at >= last} onClick={() => onStep(() => last)}>
          Last
        </button>
        <span className="dim">{view.heading}</span>
      </div>
      {/* The step's sentence is the whole story; a screen reader hears it at each step. */}
      <p role="status" aria-live="polite">
        {view.text}
      </p>
      <table className="table">
        <caption className="dim">Queues after this step. V is a voice packet and D a data packet, with its number in its flow.</caption>
        <tbody>
          {view.queues.map((q) => (
            <tr key={q.name}>
              <th scope="row">
                {q.priority && <span aria-hidden="true">P </span>}
                {q.name}
              </th>
              <td className="mono" aria-label={q.text}>
                {q.tokens.length === 0 ? (
                  <span className="dim">empty</span>
                ) : (
                  q.tokens.map((t, i) => (
                    <span key={`${t}-${i}`} className="chip" style={{ marginRight: 4 }}>
                      {t}
                    </span>
                  ))
                )}
              </td>
            </tr>
          ))}
          <tr>
            <th scope="row">Link</th>
            <td>{view.wire}</td>
          </tr>
        </tbody>
      </table>
    </section>
  );
}

function PacketFates({ run }: { run: QueueingRun }) {
  return (
    <section aria-label="Every packet">
      <div className="panel-title">Every packet and its wait</div>
      <ol className="mono" style={{ maxHeight: 220, overflow: 'auto', margin: 0 }}>
        {run.packets.map((p) => (
          <li key={p.index}>{packetFateText(run, p.index)}</li>
        ))}
      </ol>
    </section>
  );
}

function Comparison({ runs, current }: { runs: readonly QueueingRun[]; current: QueueingDiscipline }) {
  return (
    <section aria-label="The four disciplines compared">
      <div className="panel-title">The same arrivals under each discipline</div>
      <table className="table">
        <thead>
          <tr>
            <th scope="col">Discipline</th>
            <th scope="col">Voice</th>
            <th scope="col">Data</th>
          </tr>
        </thead>
        <tbody>
          {runs.map((r) => {
            const label = QUEUEING_DISCIPLINES.find((d) => d.id === r.discipline)?.label ?? r.discipline;
            const voice = r.summary.find((s) => s.kind === 'voice');
            const data = r.summary.find((s) => s.kind === 'data');
            return (
              <tr key={r.discipline} className={r.discipline === current ? 'is-selected' : undefined}>
                <th scope="row">
                  {r.discipline === current && <span aria-hidden="true">▶ </span>}
                  {label}
                  {r.discipline === current && <span className="dim"> (shown above)</span>}
                </th>
                <td>{voice?.text}</td>
                <td>{data?.text}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </section>
  );
}
