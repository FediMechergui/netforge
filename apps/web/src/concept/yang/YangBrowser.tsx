/**
 * [S28] YANG browser (ARCHITECTURE-P3C D10 "[S28]", §6, §7 W1b web-concept (b)): the concept tool `concept:yang`, a
 * lazy chunk over `concept/yang/model.ts`, which reads the devices' own YANG model (`automation/yang/model.ts`).
 *
 * Two panes:
 *  - **Browse** — the model as a tree (the data nodes, then the operations), with a search box. Every node with
 *    children opens and closes; choosing a node shows its module, kind, type facts, whether it is configuration or
 *    state, the RESTCONF request that reads it, the CLI lines that store, remove or run it, and a sample value.
 *  - **Tree diagram** — the whole model in the RFC 8340 notation, as text.
 *
 * Configuration and state are told apart in text (`rw` / `ro` / `x` and the access line), not by colour alone.
 * Every figure comes from the model; nothing is computed here. Wording is original.
 */
import { useId, useMemo, useState } from 'react';
import { visibleYangRows, yangBranchPaths, yangBrowserRoots, yangNodeDetail, yangTreeDiagram, type YangAccess, type YangTreeRow } from './model';

/** Panes of the browser. */
export type YangPane = 'browse' | 'diagram';

/** Pane names in display order. */
export const YANG_PANES: readonly { readonly id: YangPane; readonly label: string }[] = Object.freeze([
  { id: 'browse', label: 'Browse' },
  { id: 'diagram', label: 'Tree diagram' },
]);

/** The node the browser opens on: a VLAN name, a leaf with CLI lines in a keyed list. */
export const DEFAULT_YANG_NODE = 'nf-native:native/vlan/vlan-list/name';

/** The nodes open at start: the roots and the way down to the default node. */
export function defaultOpenYangNodes(): Set<string> {
  const open = new Set(yangBrowserRoots().map((n) => n.path));
  for (const p of ['nf-native:native/vlan', 'nf-native:native/vlan/vlan-list']) open.add(p);
  return open;
}

/** The short access mark of a row, as the tree diagram writes it. */
export const ACCESS_MARK: Readonly<Record<YangAccess, string>> = Object.freeze({ config: 'rw', state: 'ro', operation: 'x' });

export interface YangBrowserProps {
  /** The node chosen at start (default `DEFAULT_YANG_NODE`). */
  readonly initialNode?: string;
  /** Open every node at start (tests and "open all"). */
  readonly allOpen?: boolean;
}

export function YangBrowser({ initialNode, allOpen }: YangBrowserProps = {}) {
  const uid = useId();
  const [pane, setPane] = useState<YangPane>('browse');
  return (
    <div className="dock-panel">
      <div className="dock-toolbar" role="group" aria-label="YANG browser panes">
        {YANG_PANES.map((p) => (
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
        {pane === 'browse' && <BrowsePane initialNode={initialNode ?? DEFAULT_YANG_NODE} allOpen={allOpen === true} />}
        {pane === 'diagram' && <TreeDiagramPane />}
      </div>
    </div>
  );
}

// ── browse ──────────────────────────────────────────────────────────────────

export function BrowsePane({ initialNode = DEFAULT_YANG_NODE, allOpen = false }: { initialNode?: string; allOpen?: boolean }) {
  const uid = useId();
  const [open, setOpen] = useState<Set<string>>(() => (allOpen ? new Set(yangBranchPaths()) : defaultOpenYangNodes()));
  const [query, setQuery] = useState('');
  const [chosen, setChosen] = useState(initialNode);
  const rows = useMemo(() => visibleYangRows(open, query), [open, query]);
  const toggle = (path: string): void => {
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };
  const choose = (path: string): void => {
    setChosen(path);
    // opening a node from the detail pane (a child or the breadcrumb) also shows it in the tree
    setOpen((prev) => {
      const detail = yangNodeDetail(path);
      if (detail === undefined) return prev;
      const next = new Set(prev);
      for (const b of detail.breadcrumb.slice(0, -1)) next.add(b.path);
      return next;
    });
  };
  return (
    <>
      <p className="dim">
        The data model a NetForge device serves over RESTCONF. Each node shows where it lives, what it holds and the CLI lines that store it, so a
        program and a person at the console change the same setting.
      </p>
      <div className="dock-toolbar">
        <div className="desk-field">
          <label htmlFor={`${uid}-search`}>Find a node</label>
          <input
            id={`${uid}-search`}
            className="input mono"
            value={query}
            spellCheck={false}
            autoComplete="off"
            placeholder="vlan, enabled, counters…"
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <button type="button" className="btn" onClick={() => setOpen(new Set(yangBranchPaths()))}>
          Open all
        </button>
        <button type="button" className="btn" onClick={() => setOpen(new Set())}>
          Close all
        </button>
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'flex-start' }}>
        <ul role="tree" aria-label="YANG model" className="mono" style={{ listStyle: 'none', margin: 0, padding: 0, flex: '1 1 260px', minWidth: 0 }}>
          {rows.length === 0 && <li className="dim">No node matches “{query.trim()}”.</li>}
          {rows.map((r) => (
            <TreeRow key={r.path} row={r} chosen={r.path === chosen} searching={query.trim() !== ''} onToggle={toggle} onChoose={choose} />
          ))}
        </ul>
        <div style={{ flex: '2 1 320px', minWidth: 0 }}>
          <NodeDetail path={chosen} onChoose={choose} />
        </div>
      </div>
    </>
  );
}

function TreeRow({
  row,
  chosen,
  searching,
  onToggle,
  onChoose,
}: {
  row: YangTreeRow;
  chosen: boolean;
  searching: boolean;
  onToggle: (path: string) => void;
  onChoose: (path: string) => void;
}) {
  return (
    <li role="treeitem" aria-level={row.depth + 1} aria-selected={chosen} aria-expanded={row.hasChildren ? row.open : undefined} style={{ paddingLeft: row.depth * 14 }}>
      {row.hasChildren ? (
        <button
          type="button"
          className="btn"
          aria-label={`${row.open ? 'Close' : 'Open'} ${row.label}`}
          disabled={searching}
          onClick={() => onToggle(row.path)}
          style={{ padding: '0 4px', minWidth: 22 }}
        >
          {row.open ? '▾' : '▸'}
        </button>
      ) : (
        <span aria-hidden="true" style={{ display: 'inline-block', minWidth: 22 }} />
      )}{' '}
      <button
        type="button"
        className={`tab${chosen ? ' is-active' : ''}`}
        aria-pressed={chosen}
        data-yang-path={row.path}
        onClick={() => onChoose(row.path)}
        style={{ fontWeight: row.match ? undefined : 'normal', opacity: row.match ? 1 : 0.7 }}
      >
        {row.label}
        {row.kind === 'list' ? '*' : ''}
      </button>{' '}
      <span className="dim">
        {ACCESS_MARK[row.access]}
        {row.summary !== '' ? ` ${row.summary}` : ''}
      </span>
    </li>
  );
}

export function NodeDetail({ path, onChoose }: { path: string; onChoose: (path: string) => void }) {
  const d = yangNodeDetail(path);
  if (d === undefined) return <p className="dim">Choose a node in the tree to read about it.</p>;
  return (
    <section aria-label={`The node ${d.label}`}>
      <nav aria-label="Where the node sits" className="mono">
        {d.breadcrumb.map((b, i) => (
          <span key={b.path}>
            {i > 0 && <span aria-hidden="true"> / </span>}
            {i === d.breadcrumb.length - 1 ? (
              <strong>{b.label}</strong>
            ) : (
              <button type="button" className="btn" style={{ padding: '0 4px' }} onClick={() => onChoose(b.path)}>
                {b.label}
              </button>
            )}
          </span>
        ))}
      </nav>
      <p>{d.description}</p>
      <table className="table">
        <caption className="dim">What the model says about it.</caption>
        <tbody>
          <tr>
            <th scope="row">Kind</th>
            <td>{d.kindText}</td>
          </tr>
          <tr>
            <th scope="row">Access</th>
            <td>
              <span className="mono">{ACCESS_MARK[d.access]}</span> {d.accessText}
            </td>
          </tr>
          <tr>
            <th scope="row">Module</th>
            <td>
              <span className="mono">{d.module.name}</span> (prefix <span className="mono">{d.module.prefix}</span>, revision {d.module.revision}):{' '}
              {d.module.description}
            </td>
          </tr>
          {d.facts.map(([k, v]) => (
            <tr key={k}>
              <th scope="row">{k}</th>
              <td className="mono">{v}</td>
            </tr>
          ))}
          <tr>
            <th scope="row">Schema path</th>
            <td className="mono">{d.path}</td>
          </tr>
        </tbody>
      </table>

      <div className="panel-title">{d.request.method === 'GET' ? 'Read it over RESTCONF' : 'Run it over RESTCONF'}</div>
      <pre className="mono" aria-label="The RESTCONF request">{`${d.request.method} ${d.request.url}`}</pre>
      {d.sampleJson !== undefined && (
        <>
          <div className="panel-title">A sample value (JSON)</div>
          <pre className="mono" aria-label="A sample value">{d.sampleJson}</pre>
        </>
      )}

      <div className="panel-title">The CLI lines behind it</div>
      {d.samples.length === 0 ? (
        <p className="dim">
          {d.access === 'state'
            ? 'None: state data is reported by the device, not configured.'
            : d.kind === 'container'
              ? 'None of its own: open a node inside it.'
              : 'None: this value is set by its list key or by the hardware.'}
        </p>
      ) : (
        d.samples.map((s, i) => (
          <div key={`${s.op}-${s.when ?? ''}-${i}`}>
            <p className="dim">{s.caption}, in configuration mode:</p>
            <pre className="mono" aria-label={`CLI lines: ${s.caption}`}>{s.lines.join('\n')}</pre>
          </div>
        ))
      )}

      {d.children.length > 0 && (
        <>
          <div className="panel-title">Inside it</div>
          <ul>
            {d.children.map((c) => (
              <li key={c.path}>
                <button type="button" className="btn mono" style={{ padding: '0 4px' }} onClick={() => onChoose(c.path)}>
                  {c.label}
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

// ── tree diagram ────────────────────────────────────────────────────────────

export function TreeDiagramPane() {
  const text = useMemo(() => yangTreeDiagram(), []);
  return (
    <>
      <p className="dim">
        The same model in the standard tree-diagram notation: <span className="mono">rw</span> is configuration, <span className="mono">ro</span> is state,{' '}
        <span className="mono">-x</span> is an operation, <span className="mono">*</span> marks a list with its keys in brackets and{' '}
        <span className="mono">?</span> a leaf that may be left out.
      </p>
      <pre className="mono" aria-label="The YANG tree diagram">{text}</pre>
    </>
  );
}
