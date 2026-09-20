/**
 * Bottom dock: tab strip + resizable body. The tabs come from the one registry (dock/registry.ts `DOCK_TABS`);
 * this file only maps each id to its panel. Panes flagged `keepMounted` (the terminal: xterm instances must
 * survive tab switches) stay mounted while hidden; the others mount on demand.
 *
 * Keyboard: the strip is a tablist with roving focus (Left/Right/Home/End move and activate).
 */
import { useEffect, useRef, type ComponentType, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { DOCK_COLLAPSED_HEIGHT, DOCK_MIN_HEIGHT, DOCK_OPEN_HEIGHT, DOCK_TABS } from '../dock/registry';
import { EventsPanel, PacketsPanel, ProvenancePanel, TablesPanel } from '../inspector/DockPanels';
// The Labs tab mounts the store-connected panel; `LabBrowser` is the catalogue it shows inside itself.
import { LabPanel } from '../labs/LabPanel';
import { NetScope } from '../netscope/NetScope';
import { SimEventsPanel } from '../simmode/SimEventsPanel';
import { TerminalPanel } from '../terminal/TerminalPanel';
import { useStore } from '../store/store';
import type { DockTab } from '../store/types';
import { ResizeHandle } from './ResizeHandle';

export { DOCK_COLLAPSED_HEIGHT, DOCK_MIN_HEIGHT } from '../dock/registry';

/** Panels of the tabs this build ships (tabs of later stages are not in DOCK_TABS). */
const DOCK_PANELS: Partial<Record<DockTab, ComponentType>> = {
  terminal: TerminalPanel,
  packets: PacketsPanel,
  events: EventsPanel,
  tables: TablesPanel,
  provenance: ProvenancePanel,
  netscope: NetScope,
  'sim-events': SimEventsPanel,
  labs: LabPanel,
};

const tabDomId = (id: DockTab): string => `dock-tab-${id}`;
const paneDomId = (id: DockTab): string => `dock-pane-${id}`;

function countText(n: number): string {
  return n >= 1000 ? `${Math.floor(n / 1000)}k` : String(n);
}

export function Dock() {
  const dockTab = useStore((s) => s.dockTab);
  const setDockTab = useStore((s) => s.setDockTab);
  const dockHeight = useStore((s) => s.dockHeight);
  const setDockHeight = useStore((s) => s.setDockHeight);
  const terminals = useStore((s) => s.terminals.length);
  const events = useStore((s) => s.events.length);
  const dropped = useStore((s) => s.droppedEvents);
  const truncated = useStore((s) => s.eventsTruncated);
  const rootRef = useRef<HTMLDivElement>(null);
  const stripRef = useRef<HTMLDivElement>(null);
  const lastOpenHeight = useRef(dockHeight > DOCK_MIN_HEIGHT ? dockHeight : DOCK_OPEN_HEIGHT);

  useEffect(() => {
    if (dockHeight > DOCK_MIN_HEIGHT) lastOpenHeight.current = dockHeight;
  }, [dockHeight]);

  const collapsed = dockHeight <= DOCK_MIN_HEIGHT;
  const tabs = DOCK_TABS.filter((t) => DOCK_PANELS[t.id] !== undefined);
  const activeTab = tabs.some((t) => t.id === dockTab) ? dockTab : (tabs[0]?.id ?? dockTab);

  const onDrag = (clientY: number): void => {
    const el = rootRef.current;
    if (!el) return;
    const bottom = el.getBoundingClientRect().bottom;
    const max = Math.max(120, window.innerHeight * 0.8);
    setDockHeight(Math.min(max, Math.max(DOCK_COLLAPSED_HEIGHT, bottom - clientY)));
  };

  const toggleCollapsed = (): void => {
    setDockHeight(collapsed ? lastOpenHeight.current : DOCK_COLLAPSED_HEIGHT);
  };

  const activate = (id: DockTab): void => {
    setDockTab(id);
    if (collapsed) setDockHeight(lastOpenHeight.current);
  };

  const onStripKey = (e: ReactKeyboardEvent<HTMLDivElement>): void => {
    const i = tabs.findIndex((t) => t.id === activeTab);
    let next = -1;
    if (e.key === 'ArrowRight') next = (i + 1) % tabs.length;
    else if (e.key === 'ArrowLeft') next = (i - 1 + tabs.length) % tabs.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = tabs.length - 1;
    const target = tabs[next];
    if (target === undefined) return;
    e.preventDefault();
    activate(target.id);
    stripRef.current?.querySelector<HTMLButtonElement>(`#${tabDomId(target.id)}`)?.focus();
  };

  const badge = (id: DockTab): JSX.Element | null => {
    if (id === 'terminal' && terminals > 0) {
      return (
        <span className="badge" aria-label={`${terminals} open`}>
          {terminals}
        </span>
      );
    }
    if (id === 'events' && events > 0) {
      const lost = dropped + truncated;
      return (
        <span
          className={`badge ${lost > 0 ? 'warn' : ''}`}
          aria-label={lost > 0 ? `${events} events, some were left out` : `${events} events`}
        >
          {lost > 0 ? '⚠ ' : ''}
          {countText(events)}
        </span>
      );
    }
    return null;
  };

  return (
    <div className="dock" ref={rootRef}>
      <ResizeHandle orientation="horizontal" onDrag={onDrag} label="Resize the bottom dock" />
      <div className="dock-tabs" role="tablist" aria-label="Bottom dock" ref={stripRef} onKeyDown={onStripKey}>
        {tabs.map((t) => {
          const active = activeTab === t.id;
          return (
            <button
              key={t.id}
              id={tabDomId(t.id)}
              type="button"
              role="tab"
              className={`tab ${active ? 'is-active' : ''}`}
              aria-selected={active}
              aria-controls={paneDomId(t.id)}
              tabIndex={active ? 0 : -1}
              title={t.hotkey !== undefined ? `${t.label} (${t.hotkey}): ${t.description}` : `${t.label}: ${t.description}`}
              onClick={() => activate(t.id)}
            >
              {t.label}
              {badge(t.id)}
            </button>
          );
        })}
        <span className="spacer" />
        <button
          type="button"
          className="btn btn-ghost btn-icon"
          title={collapsed ? 'Expand the dock' : 'Collapse the dock'}
          aria-label={collapsed ? 'Expand the dock' : 'Collapse the dock'}
          aria-expanded={!collapsed}
          onClick={toggleCollapsed}
        >
          {collapsed ? '▴' : '▾'}
        </button>
      </div>
      <div className="dock-body" hidden={collapsed}>
        {tabs.map((t) => {
          const Panel = DOCK_PANELS[t.id];
          const active = activeTab === t.id;
          if (Panel === undefined || (!active && !t.keepMounted)) return null;
          return (
            <div key={t.id} id={paneDomId(t.id)} className="dock-pane" role="tabpanel" aria-labelledby={tabDomId(t.id)} hidden={!active}>
              <Panel />
            </div>
          );
        })}
      </div>
    </div>
  );
}
