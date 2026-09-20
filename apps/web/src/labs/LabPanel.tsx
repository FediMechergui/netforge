/**
 * Labs dock tab (ARCHITECTURE-P1 §4.13, §7 "Labs browser"): the catalogue, the instructions of the lab that is
 * loaded and the state of its tasks.
 *
 * Instructions are parsed by labs/markdown.ts and rendered as React elements, so lab text can never become
 * markup; a `concept:` link opens the matching concept view through the store's `setView`. Tasks come from
 * `ScenarioMeta.tasks` and are marked from the `LabStatus` the worker posts (and from `checkLab()` when the
 * student asks now): a glyph, a word and the points, so the state never depends on colour. Loading a lab goes
 * through `EngineApi.loadScenario`, which rebuilds the world at the lab's seed.
 *
 * The worker owns which lab is active: a lab loaded from the File menu or carried by a reopened project posts
 * its `LabStatus` on a batch, and this panel adopts the matching `ScenarioMeta` from the catalogue it already
 * read (§4.13 "Reopening a saved file"). A status that names another lab is never graded against these tasks.
 *
 * ponytail: the panel keeps its own copy of the lab UI state and mirrors it into the store when the store
 * offers the P1 `lab` slice, so it works before and after the shell wave lands; nothing here polls — the status
 * arrives with the worker's batches and the Check button asks once. Wording is original (§1.6).
 */
import { createElement, useCallback, useEffect, useState, type ReactNode } from 'react';
import type { LabStatus, LabTaskMeta, ScenarioMeta } from '@netforge/engine';
import { engine } from '../bridge/client';
import { errorText } from '../desktop/shared';
import { useStore } from '../store/store';
import type { LabUiState } from '../store/types';
import { LabBrowser } from './LabBrowser';
import { inlineText, parseMarkdown, type ConceptLinkTool, type MdBlock, type MdInline } from './markdown';

// ── markdown rendering ───────────────────────────────────────────────────────

/** Inline pieces as React children. Text and code carry literal characters; React escapes them. */
export function renderInline(nodes: readonly MdInline[], onConcept?: (tool: ConceptLinkTool) => void): ReactNode[] {
  return nodes.map((node, i) => {
    switch (node.kind) {
      case 'text':
        return node.text;
      case 'code':
        return (
          <code key={i} className="mono">
            {node.text}
          </code>
        );
      case 'em':
        return <em key={i}>{renderInline(node.children, onConcept)}</em>;
      case 'strong':
        return <strong key={i}>{renderInline(node.children, onConcept)}</strong>;
      case 'link': {
        const label = renderInline(node.children, onConcept);
        if (node.target.kind === 'concept') {
          const tool = node.target.tool;
          return (
            <button key={i} type="button" className="link-btn" onClick={() => onConcept?.(tool)}>
              {label}
            </button>
          );
        }
        return (
          <a key={i} href={node.target.href} target="_blank" rel="noopener noreferrer" title="Opens in a new tab">
            {label}
          </a>
        );
      }
    }
  });
}

/** Instruction blocks as React elements. Headings start at `baseLevel` so they nest under the panel heading. */
export function Markdown({ blocks, onConcept, baseLevel = 4 }: { blocks: readonly MdBlock[]; onConcept?: (tool: ConceptLinkTool) => void; baseLevel?: number }) {
  return (
    <>
      {blocks.map((block, i) => {
        switch (block.kind) {
          case 'heading':
            return createElement(`h${Math.min(6, baseLevel + block.level - 1)}`, { key: i, className: 'panel-title' }, renderInline(block.children, onConcept));
          case 'paragraph':
            return <p key={i}>{renderInline(block.children, onConcept)}</p>;
          case 'code':
            return (
              <pre key={i} className="mono">
                {block.text}
              </pre>
            );
          case 'list':
            return block.ordered ? (
              <ol key={i} className="help-list">
                {block.items.map((item, j) => (
                  <li key={j}>{renderInline(item, onConcept)}</li>
                ))}
              </ol>
            ) : (
              <ul key={i} className="help-list">
                {block.items.map((item, j) => (
                  <li key={j}>{renderInline(item, onConcept)}</li>
                ))}
              </ul>
            );
        }
      })}
    </>
  );
}

// ── task state ───────────────────────────────────────────────────────────────

/** One task row: what the lab asks and how it stands. `mark` and `state` are the non-colour channels. */
export interface LabTaskRow {
  readonly task: LabTaskMeta;
  readonly mark: '✓' | '✗' | '·';
  readonly state: 'passed' | 'not yet' | 'not checked';
  readonly points: number;
  /** Details of the parts that did not pass, in assertion order. */
  readonly details: readonly string[];
}

/** Task rows of a lab against a status (every task is listed, checked or not). */
export function labTaskRows(meta: ScenarioMeta | null, status: LabStatus | null): readonly LabTaskRow[] {
  const tasks = meta?.tasks ?? [];
  return tasks.map((task) => {
    const result = status?.results.find((r) => r.task === task.id);
    if (result === undefined) return { task, mark: '·', state: 'not checked', points: 0, details: [] };
    const details = result.assertions.filter((a) => !a.pass && a.detail !== undefined).map((a) => a.detail as string);
    return {
      task,
      mark: result.pass ? '✓' : '✗',
      state: result.pass ? 'passed' : 'not yet',
      points: result.points,
      details,
    };
  });
}

/** "30 of 55 points" — the score line of a status. */
export function labScoreText(status: LabStatus | null): string {
  if (status === null) return 'Not checked yet.';
  return `${status.score} of ${status.total} points`;
}

// ── engine round trips ───────────────────────────────────────────────────────

/** Load a lab: `loadScenario` rebuilds the world at the lab's seed. A refusal keeps its own wording. */
export async function loadLab(meta: ScenarioMeta): Promise<{ readonly ok: boolean; readonly message: string }> {
  try {
    await engine.loadScenario(meta.name);
    return { ok: true, message: `${meta.title} is loaded. Read the instructions, then check your work.` };
  } catch (err) {
    return { ok: false, message: `${meta.title} could not be loaded: ${errorText(err)}` };
  }
}

/** Grade the active lab now (`checkLab`); without a lab, or without the call, there is nothing to grade. */
export async function checkLabNow(): Promise<{ readonly ok: boolean; readonly status: LabStatus | null; readonly message: string }> {
  try {
    const status = (await engine.checkLab?.()) ?? null;
    return { ok: status !== null, status, message: status === null ? 'No lab is loaded, so there is nothing to check.' : `Checked: ${labScoreText(status)}.` };
  } catch (err) {
    return { ok: false, status: null, message: `The tasks could not be checked: ${errorText(err)}` };
  }
}

// ── panel ────────────────────────────────────────────────────────────────────

const EMPTY_LAB: LabUiState = { active: null, status: null, browserOpen: true };

export function LabPanel() {
  const stored = useStore((s) => s.lab);
  const setLab = useStore((s) => s.setLab);
  const setView = useStore((s) => s.setView);
  const workspace = useStore((s) => s.view);
  const [local, setLocal] = useState<LabUiState>(EMPTY_LAB);
  const [scenarios, setScenarios] = useState<readonly ScenarioMeta[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const state = stored ?? local;

  const update = useCallback(
    (patch: Partial<LabUiState>): void => {
      setLocal((s) => ({ ...s, ...patch }));
      setLab?.(patch);
    },
    [setLab],
  );

  useEffect(() => {
    let alive = true;
    engine
      .listScenarios()
      .then((list) => {
        if (alive) setScenarios(list);
      })
      .catch((err: unknown) => {
        if (alive) setMessage(`The lab catalogue could not be read: ${err instanceof Error ? err.message : String(err)}`);
      });
    return () => {
      alive = false;
    };
  }, []);

  // The worker decides which lab is active; adopt its metadata when a lab this panel did not load turns up
  // (File ▸ New from a template, or a reopened project carrying a `lab` section — §4.13).
  useEffect(() => {
    const name = stored?.status?.lab;
    if (name === undefined || stored?.active?.name === name) return;
    const meta = scenarios.find((s) => s.name === name);
    if (meta !== undefined) update({ active: meta, browserOpen: false });
  }, [stored?.status?.lab, stored?.active?.name, scenarios, update]);

  const open = async (meta: ScenarioMeta): Promise<void> => {
    setBusy(true);
    setMessage(null);
    const result = await loadLab(meta);
    // The status of the world the lab just built arrives on the worker's batch; only the choice is ours.
    if (result.ok) {
      update({ active: meta, browserOpen: false });
      // ScenarioMeta.concept names the tool the lab works with: open it without leaving the workspace.
      if (meta.concept !== undefined) setView?.(workspace ?? 'topology', meta.concept);
    }
    setMessage(result.message);
    setBusy(false);
  };

  const check = async (): Promise<void> => {
    setBusy(true);
    const result = await checkLabNow();
    update({ status: result.status });
    setMessage(result.message);
    setBusy(false);
  };

  const active = state.active;
  // A status of another lab grades other task ids: never show it against these tasks.
  const status = active !== null && state.status?.lab === active.name ? state.status : null;
  const showBrowser = active === null || state.browserOpen;
  const blocks = active?.instructions === undefined ? [] : parseMarkdown(active.instructions);
  const rows = labTaskRows(active, status);

  return (
    <div className="dock-panel">
      <div className="dock-toolbar">
        <h3 className="panel-title">{active === null ? 'Labs' : active.title}</h3>
        {active !== null && (
          <button type="button" className="btn" onClick={() => update({ browserOpen: !state.browserOpen })}>
            {state.browserOpen ? 'Back to the lab' : 'All labs'}
          </button>
        )}
        {active !== null && (
          <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void check()}>
            {busy ? 'Working…' : 'Check my work'}
          </button>
        )}
        <span className="dim">{active === null ? 'Pick a lab to load it.' : labScoreText(status)}</span>
      </div>

      {/* Mounted before there is a message, so a screen reader hears the answer to "Check my work" (§16). */}
      <p className={`insp-note${message === null ? ' is-empty' : ''}`} role="status" aria-live="polite">
        {message}
      </p>

      {showBrowser ? (
        <LabBrowser scenarios={scenarios} activeName={active?.name} busy={busy} onOpen={(meta) => void open(meta)} />
      ) : (
        <div className="dock-scroll">
          <p className="dim">{active.description}</p>
          {active.objectives !== undefined && active.objectives.length > 0 && (
            <section aria-label="What you practise here">
              <div className="panel-title">What you practise here</div>
              <ul className="help-list">
                {active.objectives.map((o) => (
                  <li key={o}>{o}</li>
                ))}
              </ul>
            </section>
          )}
          <section aria-label="Instructions">
            <div className="panel-title">Instructions</div>
            {blocks.length === 0 ? <p className="empty-hint">This lab has no written instructions.</p> : <Markdown blocks={blocks} onConcept={(tool) => setView?.('concept', tool)} />}
          </section>
          <section aria-label="Tasks">
            <div className="panel-title">Tasks</div>
            {rows.length === 0 ? (
              <p className="empty-hint">This lab has no tasks to check.</p>
            ) : (
              <ul className="help-list">
                {rows.map((row) => (
                  <li key={row.task.id}>
                    <span aria-hidden="true">{row.mark} </span>
                    <strong>{row.task.title}</strong>
                    <span className="dim">
                      {' '}
                      — {row.state}, {row.points} of {row.task.points} point{row.task.points === 1 ? '' : 's'}
                    </span>
                    <div className="dim">{row.task.description}</div>
                    {row.task.hint !== undefined && row.state !== 'passed' && <div className="dim">Hint: {row.task.hint}</div>}
                    {row.details.map((d, i) => (
                      <div key={i} className="insp-note">
                        {d}
                      </div>
                    ))}
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      )}
    </div>
  );
}

