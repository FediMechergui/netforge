/**
 * routing/SpfStepper.tsx — [S3] the SPF stepper (ARCHITECTURE-P3 §6, D10; spec §9.7 "SPF animation").
 *
 * Steps Dijkstra over the chosen router's own database, one frame per settled vertex (`spf-model.ts` `spfFrame`,
 * over `spfSteps` of `core/ospf-spf.ts`): first / back / step / play / last, the tentative-list table (cost, the vertex
 * it is reached through, and what this step changed: new, cheaper, equal-cost), the tree settled so far, and one
 * sentence per step in a polite live region. The last frame is the router's own tree; the stepper says whether it
 * equals the tree of the router's last SPF run (its StateView).
 *
 * `SpfStepper` reads and writes the W2 `routingUi` slice (`spf.step`, `spf.playing`) — so the canvas `spf` layer
 * (`canvas/spf.ts`) shows the same frame — and plays by advancing one frame every `SPF_PLAY_MS` of wall time until the
 * last. `SpfStepperView` is the store-free view the tests render.
 */
import { useEffect } from 'react';
import type { SimTime } from '@netforge/engine';
import { matchesRouter, spfFrame, spfRunOf, type SpfCandidateChange, type SpfFrame, type SpfRun } from '../canvas/overlays/spf-model';
import { useTickNow } from '../inspector/TablesView';
import { store, useStore } from '../store/store';
import { routerDevices } from './lsdb-model';

/** Wall time between two frames while playing. */
export const SPF_PLAY_MS = 1200;

const CHANGE_WORD: Readonly<Record<SpfCandidateChange, string>> = Object.freeze({ new: 'new', cheaper: 'cheaper', 'equal-cost': 'equal-cost path' });

export interface SpfStepperViewProps {
  readonly run: SpfRun;
  readonly frame: SpfFrame;
  readonly playing: boolean;
  onStep(step: number): void;
  onPlay(playing: boolean): void;
}

/** The sentence comparing the stepper's last frame with the router's own last run. */
export function routerTreeSentence(run: SpfRun): string {
  const m = matchesRouter(run);
  if (m === null) return `${run.name} has not run SPF on this area yet.`;
  return m
    ? `The last step is the tree ${run.name} computed in its last SPF run.`
    : `${run.name}'s last SPF run computed a different tree: its database changed since, and it runs SPF again shortly.`;
}

export function SpfStepperView({ run, frame, playing, onStep, onPlay }: SpfStepperViewProps) {
  const last = frame.count - 1;
  const atFirst = frame.index <= 0;
  const atLast = frame.index >= last;
  return (
    <section className="ls-spf" aria-label={`Shortest-path tree from ${run.name}`}>
      <div className="ls-spf-controls" role="toolbar" aria-label="SPF steps">
        <button type="button" className="btn" disabled={atFirst} onClick={() => onStep(0)}>
          « First
        </button>
        <button type="button" className="btn" disabled={atFirst} onClick={() => onStep(frame.index - 1)}>
          ‹ Back
        </button>
        <button type="button" className="btn" disabled={atLast} onClick={() => onStep(frame.index + 1)}>
          Step ›
        </button>
        <button type="button" className={`btn${playing ? ' is-active' : ''}`} aria-pressed={playing} onClick={() => onPlay(!playing)}>
          {playing ? 'Pause' : 'Play'}
        </button>
        <button type="button" className="btn" disabled={atLast} onClick={() => onStep(last)}>
          Last »
        </button>
        <span className="ls-spf-pos mono">
          Step {frame.index + 1} of {frame.count}
        </span>
      </div>
      <p className="ls-spf-sentence" role="status" aria-live="polite">
        {frame.sentence}
      </p>
      <div className="ls-spf-tables">
        <table className="table ls-tentative" aria-label="Tentative list">
          <caption>Tentative list</caption>
          <thead>
            <tr>
              <th scope="col">Vertex</th>
              <th scope="col">Cost</th>
              <th scope="col">Through</th>
              <th scope="col">This step</th>
            </tr>
          </thead>
          <tbody>
            {frame.candidates.length === 0 ? (
              <tr>
                <td colSpan={4} className="ls-empty">
                  Empty: every reachable vertex is settled.
                </td>
              </tr>
            ) : (
              frame.candidates.map((c, i) => (
                <tr key={c.key} className={i === 0 ? 'ls-next' : undefined}>
                  <td>
                    {c.name}
                    {i === 0 && <span className="chip accent">next</span>}
                  </td>
                  <td className="num">{c.cost}</td>
                  <td>{c.parentName ?? ''}</td>
                  <td>{c.change === undefined ? '' : CHANGE_WORD[c.change]}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
        <div className="ls-settled">
          <h4>Settled ({frame.tree.length})</h4>
          <ol>
            {frame.tree.map((v, i) => (
              <li key={v.key} className={i === frame.index ? 'is-current' : undefined}>
                <span className="mono ls-cost-cell">{v.cost}</span>{' '}
                {i === frame.index ? (
                  <>
                    <strong>{frame.treeNames[i]}</strong> <span className="chip accent">this step</span>
                  </>
                ) : (
                  frame.treeNames[i]
                )}
              </li>
            ))}
          </ol>
        </div>
      </div>
      <p className="ls-spf-router">{routerTreeSentence(run)}</p>
    </section>
  );
}

export interface SpfStepperProps {
  /** The sim time to compute at (the panel's ticking clock); the stepper ticks its own when absent. */
  readonly now?: SimTime;
}

/** The store-connected stepper: the router and area of `routingUi`, its `spf.step` and `spf.playing`. */
export function SpfStepper({ now: givenNow }: SpfStepperProps) {
  const snapshot = useStore((s) => s.snapshot);
  const sel = useStore((s) => s.routingUi);
  const setRoutingUi = useStore((s) => s.setRoutingUi);
  const ticking = useTickNow(1000, givenNow === undefined);
  const now = givenNow ?? ticking;
  const run = spfRunOf(snapshot, sel, now);
  const last = run === undefined ? 0 : Math.max(0, run.steps.length - 1);
  const playing = sel.spf.playing && run !== undefined;

  useEffect(() => {
    if (!playing) return;
    const id = setInterval(() => {
      const cur = store.getState().routingUi.spf;
      const next = cur.step + 1;
      if (next >= last) store.getState().setRoutingUi({ spf: { step: last, playing: false } });
      else store.getState().setRoutingUi({ spf: { step: next, playing: true } });
    }, SPF_PLAY_MS);
    return () => clearInterval(id);
  }, [playing, last]);

  if (run === undefined) {
    return <p className="ls-empty">Choose a router that runs OSPF to step through its shortest-path computation.</p>;
  }
  const frame = spfFrame(run, sel.spf.step, routerDevices(snapshot));
  return (
    <SpfStepperView
      run={run}
      frame={frame}
      playing={playing}
      onStep={(step) => setRoutingUi({ spf: { step: Math.min(last, Math.max(0, step)), playing: false } })}
      onPlay={(play) => {
        if (!play) setRoutingUi({ spf: { step: frame.index, playing: false } });
        else setRoutingUi({ spf: { step: frame.index >= last ? 0 : frame.index, playing: last > 0 } });
      }}
    />
  );
}
