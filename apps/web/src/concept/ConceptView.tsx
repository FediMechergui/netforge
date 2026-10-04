/**
 * Concept view host (ARCHITECTURE-P1 §4.13, §7 "Concept views"): the full-workspace tool a student opens from
 * the View menu or from a `concept:` link in lab instructions. It picks the tool by its id and gives every tool a
 * heading and a way back to the topology.
 *
 * The workspace keeps the canvas mounted and hidden behind this view (§4.13), so nothing here unmounts it.
 * The chosen tool comes from the store (`conceptTool`) when the shell offers the P1 view state and from this
 * component otherwise, so the view works either way; `tool` overrides both, for a host that already knows.
 *
 * P3 (ARCHITECTURE-P3 D24; W2 web-shell): routing by `ConceptToolId`. `CONCEPT_TOOL_VIEWS` is exhaustive over the
 * engine's one list of concept tools, so a new id is a compile error here until it has an entry. An entry renders its
 * tool when called (rule 12: nothing of another module is read at module scope); `null` is a tool this build does not
 * have yet, which shows a short "not available" note instead of falling back to the subnetting workbench. New tools
 * are lazy chunks (D24): a web-concept item registers `lazy(() => import('./<tool>/<Tool>'))` here and adds its
 * `CONCEPT_TOOLS` row (R9: `concept.views.test.ts:171` gains its id), and the View menu lists it from these two
 * (`app/TopBar.tsx` `conceptMenuEntries`). The tool renders inside a Suspense boundary, so a lazy one shows a
 * loading line while its chunk arrives.
 */
import { Suspense, lazy, useState, type ReactElement } from 'react';
import { useStore } from '../store/store';
import type { ConceptTool } from '../store/types';
import { Ipv6Explorer } from './ipv6/Ipv6Explorer';
import { SubnetWorkbench } from './subnetting/SubnetWorkbench';

// P3 (D24; W3 web-concept): the new tools are lazy chunks, loaded the first time one is opened.
const QueueingTool = lazy(() => import('./queueing/QueueingTool').then((m) => ({ default: m.QueueingTool })));
const DataFormatsTool = lazy(() => import('./data-formats/DataFormatsTool').then((m) => ({ default: m.DataFormatsTool })));
const WildcardTool = lazy(() => import('./wildcard/WildcardTool').then((m) => ({ default: m.WildcardTool })));

/** The concept tools, in display order, with what each one is for. */
export const CONCEPT_TOOLS: readonly { readonly id: ConceptTool; readonly label: string; readonly hint: string }[] = Object.freeze([
  { id: 'subnetting', label: 'Subnetting', hint: 'Split blocks, read masks and practise the arithmetic.' },
  { id: 'ipv6', label: 'IPv6', hint: 'Shorten addresses, build interface ids and name address types.' },
  // P3 (W3 web-concept; R9: each tool joins this list with its item)
  { id: 'queueing', label: 'Queueing', hint: 'Watch FIFO, WFQ, CBWFQ and LLQ share a busy link, packet by packet.' },
  { id: 'data-formats', label: 'Data formats', hint: 'Read JSON, YAML and XML, find key paths and convert between them.' },
  { id: 'wildcard', label: 'Wildcards', hint: 'See which address bits a wildcard checks, count the matches and build one.' },
]);

/** @since P3 How a registered tool is drawn: called at render time; null = not built in this build. */
export type ConceptToolView = (() => ReactElement) | null;

/**
 * @since P3 (D24) The concept registry: one entry per `ConceptToolId`. The P3 tools ('queueing', 'data-formats', [S9]
 * 'wildcard') landed with their W3 web-concept items, as lazy chunks.
 */
export const CONCEPT_TOOL_VIEWS: Readonly<Record<ConceptTool, ConceptToolView>> = Object.freeze({
  subnetting: () => <SubnetWorkbench />,
  ipv6: () => <Ipv6Explorer />,
  queueing: () => <QueueingTool />,
  'data-formats': () => <DataFormatsTool />,
  wildcard: () => <WildcardTool />,
});

/** @since P3 Whether this build has the tool (a registered view and a `CONCEPT_TOOLS` row to name it). */
export function isConceptToolBuilt(tool: ConceptTool): boolean {
  return CONCEPT_TOOL_VIEWS[tool] != null && CONCEPT_TOOLS.some((t) => t.id === tool);
}

/** Label of a tool (falls back to the id for a tool this build does not know). */
export function conceptToolLabel(tool: ConceptTool): string {
  return CONCEPT_TOOLS.find((t) => t.id === tool)?.label ?? tool;
}

export interface ConceptViewProps {
  /** Tool to show; without it the store's `conceptTool`, and without that the first tool. */
  readonly tool?: ConceptTool;
}

export function ConceptView({ tool }: ConceptViewProps = {}) {
  const stored = useStore((s) => s.conceptTool);
  const setView = useStore((s) => s.setView);
  const [fallback, setFallback] = useState<ConceptTool>('subnetting');
  const current = tool ?? stored ?? fallback;
  // An id from outside the contract (an old saved link) has no entry at all: treat it as not built.
  const view = Object.prototype.hasOwnProperty.call(CONCEPT_TOOL_VIEWS, current) ? CONCEPT_TOOL_VIEWS[current] : null;

  const choose = (next: ConceptTool): void => {
    setFallback(next);
    setView?.('concept', next);
  };

  return (
    <div className="dock-panel" aria-label="Concept tools">
      <div className="dock-toolbar">
        <h2 className="panel-title">{conceptToolLabel(current)}</h2>
        <div role="group" aria-label="Concept tool">
          {CONCEPT_TOOLS.map((t) => (
            <button
              key={t.id}
              type="button"
              className={`tab${t.id === current ? ' is-active' : ''}`}
              aria-pressed={t.id === current}
              title={t.hint}
              onClick={() => choose(t.id)}
            >
              {t.label}
            </button>
          ))}
        </div>
        {setView !== undefined && (
          <button type="button" className="btn" onClick={() => setView('topology')}>
            Back to the topology
          </button>
        )}
      </div>
      {view === null ? (
        <p className="dim">This concept tool is not available in this build.</p>
      ) : (
        <Suspense fallback={<p className="dim">Loading the tool…</p>}>{view()}</Suspense>
      )}
    </div>
  );
}
