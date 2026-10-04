/**
 * routing/LinkStatePanel.tsx — [S2]/[S3] the `routing` dock tab, "Link state" (ARCHITECTURE-P3 §6, §2.14; spec §9.7).
 *
 * Router and area pickers over the W2 `routingUi` slice, then one of three views of the chosen router's link-state
 * database: the LSA list with the selected LSA's detail, the LSDB graph, and the SPF stepper (whose frame the canvas
 * `spf` layer draws). Everything is read from the snapshot's tables through the pure models (`lsdb-model.ts`,
 * `canvas/overlays/spf-model.ts`); the list's ages are live (the panel ticks once a second).
 *
 * The dock wiring is web-shell's W4 item: `app/Dock.tsx` maps `routing` to this module lazily (the default export).
 */
import { useMemo, useState } from 'react';
import type { DeviceId } from '@netforge/engine';
import { areaLabel } from '../canvas/overlays/ospf-model';
import { useTickNow } from '../inspector/TablesView';
import { store, useStore } from '../store/store';
import { LsaDetail } from './LsaDetail';
import { LsaList } from './LsaList';
import { LsdbGraph } from './LsdbGraph';
import { buildLsdbGraph, buildLsdbView, lsaDetail } from './lsdb-model';
import { SpfStepper } from './SpfStepper';
import './routing.css';

/** The panel's three views. */
export type LinkStateView = 'database' | 'graph' | 'spf';

const VIEWS: readonly { id: LinkStateView; label: string }[] = [
  { id: 'database', label: 'Database' },
  { id: 'graph', label: 'Graph' },
  { id: 'spf', label: 'SPF steps' },
];

/** The empty-state text of the panel. */
export const LINK_STATE_EMPTY =
  'No router runs OSPF yet. Configure "router ospf 1" with a network line on a router, and its link-state database appears here.';

/** Open NetScope on the packets that carried an LSA: the filter goes to the NetScope slice and the clipboard. */
function showPackets(filter: string): void {
  const s = store.getState();
  s.setNetscope({ filterText: filter, applied: filter });
  try {
    void navigator.clipboard?.writeText(filter).catch(() => undefined);
  } catch {
    // no clipboard (insecure context, tests): the filter is still shown in the detail
  }
  s.setDockTab('netscope');
}

export function LinkStatePanel() {
  const snapshot = useStore((s) => s.snapshot);
  const sel = useStore((s) => s.routingUi);
  const setRoutingUi = useStore((s) => s.setRoutingUi);
  const now = useTickNow(1000);
  const [view, setView] = useState<LinkStateView>('database');

  const lsdb = useMemo(() => buildLsdbView(snapshot, sel, now), [snapshot, sel, now]);
  const router = lsdb.router;
  const area = lsdb.area;
  const detail = useMemo(
    () => (snapshot !== null && router !== undefined && lsdb.selected !== undefined ? lsaDetail(snapshot, router.device, lsdb.selected, now) : undefined),
    [snapshot, router, lsdb.selected, now],
  );
  const graph = useMemo(
    () => (view === 'graph' && snapshot !== null && router !== undefined && area !== undefined ? buildLsdbGraph(snapshot, router.device, area, now) : undefined),
    [view, snapshot, router, area, now],
  );

  if (router === undefined) {
    return <div className="ls-panel ls-empty-panel">{LINK_STATE_EMPTY}</div>;
  }

  const pickRouter = (device: DeviceId): void => setRoutingUi({ device, area: null, lsa: null, spf: { step: 0, playing: false } });
  const pickArea = (a: string): void => setRoutingUi({ device: router.device, area: a, lsa: null, spf: { step: 0, playing: false } });
  const pickLsa = (key: string): void => setRoutingUi({ device: router.device, lsa: key });

  return (
    <div className="ls-panel">
      <div className="ls-toolbar">
        <label>
          Router{' '}
          <select className="select" value={router.device} onChange={(e) => pickRouter(e.target.value as DeviceId)}>
            {lsdb.routers.map((r) => (
              <option key={r.device} value={r.device}>
                {r.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          Area{' '}
          <select className="select" value={area ?? ''} disabled={lsdb.areas.length === 0} onChange={(e) => pickArea(e.target.value)}>
            {lsdb.areas.map((a) => (
              <option key={a} value={a}>
                {areaLabel(a)} ({a})
              </option>
            ))}
          </select>
        </label>
        <div className="ls-views" role="group" aria-label="View">
          {VIEWS.map((v) => (
            <button key={v.id} type="button" className={`btn${view === v.id ? ' is-active' : ''}`} aria-pressed={view === v.id} onClick={() => setView(v.id)}>
              {v.label}
            </button>
          ))}
        </div>
        <span className="ls-count">
          {lsdb.lsas.length} {lsdb.lsas.length === 1 ? 'LSA' : 'LSAs'}
        </span>
        {lsdb.duplicates.length > 0 && (
          <span className="chip err" role="note">
            ! duplicate router id {lsdb.duplicates.join(', ')}
          </span>
        )}
      </div>
      {view !== 'spf' && (
        <div className="ls-split">
          <div className={view === 'graph' ? 'ls-graph-pane' : 'ls-list-pane'}>
            {view === 'database' ? (
              <LsaList entries={lsdb.lsas} {...(lsdb.selected === undefined ? {} : { selected: lsdb.selected })} onSelect={pickLsa} />
            ) : graph !== undefined ? (
              <LsdbGraph
                graph={graph}
                {...(lsdb.selected === undefined ? {} : { selected: lsdb.selected })}
                onSelect={pickLsa}
                label={`Link-state database of ${router.label}${area === undefined ? '' : `, ${areaLabel(area)}`}`}
              />
            ) : null}
          </div>
          <div className="ls-detail-pane">
            {detail === undefined ? (
              <p className="ls-empty">Choose an LSA to see what it says and whether every router holds the same copy.</p>
            ) : (
              <LsaDetail detail={detail} onShowPackets={showPackets} />
            )}
          </div>
        </div>
      )}
      {view === 'spf' && (
        <div className="ls-spf-pane">
          <SpfStepper now={now} />
        </div>
      )}
    </div>
  );
}

export default LinkStatePanel;
