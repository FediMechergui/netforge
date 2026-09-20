/**
 * Concept view host (ARCHITECTURE-P1 §4.13, §7 "Concept views"): the full-workspace tool a student opens from
 * the View menu or from a `concept:` link in lab instructions. It picks between the subnetting workbench and
 * the IPv6 explorer and gives both a heading and a way back to the topology.
 *
 * The workspace keeps the canvas mounted and hidden behind this view (§4.13), so nothing here unmounts it.
 * The chosen tool comes from the store (`conceptTool`) when the shell offers the P1 view state and from this
 * component otherwise, so the view works either way; `tool` overrides both, for a host that already knows.
 *
 * ponytail: two tools, listed in one place (CONCEPT_TOOLS) so adding a third is one entry plus one case.
 */
import { useState } from 'react';
import { useStore } from '../store/store';
import type { ConceptTool } from '../store/types';
import { Ipv6Explorer } from './ipv6/Ipv6Explorer';
import { SubnetWorkbench } from './subnetting/SubnetWorkbench';

/** The concept tools, in display order, with what each one is for. */
export const CONCEPT_TOOLS: readonly { readonly id: ConceptTool; readonly label: string; readonly hint: string }[] = Object.freeze([
  { id: 'subnetting', label: 'Subnetting', hint: 'Split blocks, read masks and practise the arithmetic.' },
  { id: 'ipv6', label: 'IPv6', hint: 'Shorten addresses, build interface ids and name address types.' },
]);

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
      {current === 'ipv6' ? <Ipv6Explorer /> : <SubnetWorkbench />}
    </div>
  );
}
