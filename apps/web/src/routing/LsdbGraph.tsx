/**
 * routing/LsdbGraph.tsx — [S2] the graph of one router's link-state database (ARCHITECTURE-P3 §6; spec §9.7).
 *
 * Routers at their canvas positions, transit networks at the centroid of their routers (`buildLsdbGraph`), fitted
 * into the panel (`fitGraph`). Each edge carries the cost its side advertises next to that side; an edge only one
 * side lists is drawn thin and labelled `one-way` (the SPF would not use it) — a word, never a dash pattern (P2 D20).
 * Routers are boxes, networks are circles (shape, not colour, tells them apart). Every vertex is a focusable button
 * that selects the LSA behind it; the selected one is drawn heavier and says so to assistive technology.
 */
import type { KeyboardEvent } from 'react';
import { fitGraph, type LsdbGraphModel } from './lsdb-model';

export interface LsdbGraphProps {
  readonly graph: LsdbGraphModel;
  /** The key of the LSA shown in detail. */
  readonly selected?: string;
  onSelect?(lsaKey: string): void;
  /** Accessible name of the drawing. */
  readonly label: string;
}

/** The drawing's coordinate box. */
export const GRAPH_W = 640;
export const GRAPH_H = 260;
const PAD = 44;
const ROUTER_W = 74;
const ROUTER_H = 30;
const NET_R = 9;

/** The point at `t` of the way from a to b. */
function along(a: { x: number; y: number }, b: { x: number; y: number }, t: number): { x: number; y: number } {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}

export function LsdbGraph({ graph, selected, onSelect, label }: LsdbGraphProps) {
  if (graph.nodes.length === 0) {
    return <p className="ls-empty">No router LSA in this area yet, so there is nothing to draw.</p>;
  }
  const pos = fitGraph(graph, GRAPH_W, GRAPH_H, PAD);
  const onKey = (e: KeyboardEvent<SVGGElement>, key: string): void => {
    if (onSelect !== undefined && (e.key === 'Enter' || e.key === ' ')) {
      e.preventDefault();
      onSelect(key);
    }
  };
  return (
    <svg className="ls-graph" viewBox={`0 0 ${GRAPH_W} ${GRAPH_H}`} role="group" aria-label={label}>
      <g className="ls-graph-edges">
        {graph.edges.map((e) => {
          const a = pos.get(e.from);
          const b = pos.get(e.to);
          if (a === undefined || b === undefined) return null;
          const mid = along(a, b, 0.5);
          const nearA = along(a, b, 0.3);
          const nearB = along(a, b, 0.7);
          return (
            <g key={e.key} className={e.twoWay ? 'ls-edge' : 'ls-edge ls-edge-oneway'}>
              <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} />
              {e.costFrom !== undefined && (
                <text x={nearA.x} y={nearA.y - 4} className="ls-cost">
                  {e.costFrom}
                </text>
              )}
              {e.kind === 'p2p' && e.costTo !== undefined && (
                <text x={nearB.x} y={nearB.y - 4} className="ls-cost">
                  {e.costTo}
                </text>
              )}
              {!e.twoWay && (
                <text x={mid.x} y={mid.y + 12} className="ls-oneway">
                  one-way
                </text>
              )}
            </g>
          );
        })}
      </g>
      <g className="ls-graph-nodes">
        {graph.nodes.map((n) => {
          const p = pos.get(n.key);
          if (p === undefined) return null;
          const isSel = n.lsaKey === selected;
          const name = n.kind === 'router' ? `router ${n.label}, ${n.sub}` : `network ${n.label}, ${n.sub}`;
          return (
            <g
              key={n.key}
              className={`ls-node ls-node-${n.kind}${isSel ? ' is-selected' : ''}${n.placed ? '' : ' ls-unplaced'}`}
              role={onSelect === undefined ? undefined : 'button'}
              tabIndex={onSelect === undefined ? undefined : 0}
              aria-label={`${name}${n.stubs > 0 ? `, ${n.stubs} stub ${n.stubs === 1 ? 'network' : 'networks'}` : ''}${n.placed ? '' : ', not on the canvas'}${isSel ? ', selected' : ''}`}
              aria-pressed={onSelect === undefined ? undefined : isSel}
              onClick={onSelect === undefined ? undefined : () => onSelect(n.lsaKey)}
              onKeyDown={onSelect === undefined ? undefined : (e) => onKey(e, n.lsaKey)}
            >
              {n.kind === 'router' ? (
                <>
                  <rect x={p.x - ROUTER_W / 2} y={p.y - ROUTER_H / 2} width={ROUTER_W} height={ROUTER_H} rx={5} />
                  <text x={p.x} y={p.y - 2} className="ls-node-name">
                    {n.label}
                  </text>
                  <text x={p.x} y={p.y + 10} className="ls-node-sub">
                    {n.sub}
                  </text>
                  {n.stubs > 0 && (
                    <text x={p.x} y={p.y + ROUTER_H / 2 + 11} className="ls-node-sub">
                      +{n.stubs} stub
                    </text>
                  )}
                </>
              ) : (
                <>
                  <circle cx={p.x} cy={p.y} r={NET_R} />
                  <text x={p.x} y={p.y + NET_R + 12} className="ls-node-name">
                    {n.label}
                  </text>
                  <text x={p.x} y={p.y + NET_R + 23} className="ls-node-sub">
                    {n.sub}
                  </text>
                </>
              )}
            </g>
          );
        })}
      </g>
    </svg>
  );
}
