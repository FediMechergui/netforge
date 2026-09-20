/**
 * Device inspector (spec §8.4; ARCHITECTURE-P1 §7, D2, §9.3): editable header with power and console actions, then
 * the tabs this device offers. Tabs come from `DeviceModel.gui` and the effective capabilities (`inspectorTabsFor`),
 * and the selected tab is clamped to 'overview' when the device does not offer it, so switching between a PC and a
 * home router never shows an empty page. The selected tab lives in the store (`inspectorTab`); a tiny module store
 * carries the config-line highlight so other panels (the provenance timeline) can jump to "Config" with a line
 * highlighted.
 *
 * Tab bodies: Overview, Ports, Config, Tables (generic extra tables), Processes, Physical (hardware and module
 * slots), Desktop (end-device apps), the device's settings panels (Wi-Fi access point, home router, radio link,
 * tower, modem status) and Services. Nothing here branches on the device kind; the header shows the category.
 */
import { Fragment, memo, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { KeyboardEvent } from 'react';
import type { DeviceModel, DeviceSnapshot, GuiPanelId, PortSnapshot, StateView } from '@netforge/engine';
import { engine } from '../bridge/client';
import { DesktopTab } from '../desktop/DesktopTab';
import { store, useStore } from '../store/store';
import type { InspectorTab } from '../store/types';
import { CAPABILITY_VOCAB, GUI_PANEL_VOCAB, categoryLabel, portRoleLabel } from '../vocab/categories';
import { CellTowerPanel } from './CellTowerPanel';
import { ConfigView } from './ConfigView';
import { HomeRouterPanel } from './HomeRouterPanel';
import { ModulesPanel } from './ModulesPanel';
import { revealDockTab, toastError } from './PacketInspector';
import { fmtBps, portAddress, PortLed, portStatus } from './PortInspector';
import { RadioLinkPanel } from './RadioLinkPanel';
import { ServicesPanel } from './ServicesPanel';
import { TablesView, useTickNow } from './TablesView';
import { WirelessPanel } from './WirelessPanel';
import {
  associationsOfDevice,
  catalogModel,
  clampInspectorTab,
  consoleAvailability,
  deviceTablePresence,
  inspectorTabLabel,
  inspectorTabsFor,
  isDataPort,
  panelsForTab,
  stepInspectorTab,
} from './tabs';
import './inspector.css';

// ── tab state ───────────────────────────────────────────────────────────────

/** Kept for callers of the P0 name; every inspector tab is valid. */
export type DeviceTab = InspectorTab;

interface TabState {
  /** Used only while the store has no `inspectorTab` slice. */
  tab: InspectorTab;
  highlight: string | null;
  nonce: number;
}

let tabState: TabState = { tab: 'overview', highlight: null, nonce: 0 };
const tabListeners = new Set<() => void>();

/** Switch the device inspector to `tab`, optionally highlighting a config line. */
export function openDeviceTab(tab: InspectorTab, highlight?: string): void {
  tabState = { tab, highlight: highlight ?? null, nonce: tabState.nonce + 1 };
  store.getState().setInspectorTab?.(tab);
  for (const l of tabListeners) l();
}

function subscribeTab(listener: () => void): () => void {
  tabListeners.add(listener);
  return () => {
    tabListeners.delete(listener);
  };
}

const getTab = (): TabState => tabState;

// ── actions ─────────────────────────────────────────────────────────────────

/** Open a console session on the device and show it in the terminal dock (an open console tab is reused). */
export async function openConsole(device: Pick<DeviceSnapshot, 'id' | 'name'>): Promise<void> {
  const st = store.getState();
  const existing = st.terminals.find((t) => t.device === device.id);
  if (existing !== undefined) {
    st.setActiveTerminal(existing.session);
    revealDockTab('terminal');
    return;
  }
  try {
    const view = await engine.cliOpen(device.id, 'console');
    store.getState().addTerminal({ session: view.id, device: device.id, title: device.name });
    revealDockTab('terminal');
  } catch (err) {
    toastError(err);
  }
}

export function fmtUptime(ns: number): string {
  const total = Math.max(0, Math.floor(ns / 1_000_000_000));
  const d = Math.floor(total / 86_400);
  const h = Math.floor((total % 86_400) / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (d > 0) return `${d} d ${h} h ${m} min`;
  if (h > 0) return `${h} h ${m} min ${s} s`;
  if (m > 0) return `${m} min ${s} s`;
  return `${s} s`;
}

// ── component ───────────────────────────────────────────────────────────────

export function DeviceInspector({ device }: { device: DeviceSnapshot }) {
  const local = useSyncExternalStore(subscribeTab, getTab);
  const storeTab = useStore((s) => s.inspectorTab);
  const model = useStore((s) => catalogModel(s.catalog, device.type));
  const tabs = useMemo(() => inspectorTabsFor(device, model), [device, model]);
  const tab = clampInspectorTab(storeTab ?? local.tab, tabs);
  const tabRefs = useRef(new Map<InspectorTab, HTMLButtonElement>());
  const baseId = `insp-${device.id}`;

  const onTabKey = useCallback(
    (e: KeyboardEvent<HTMLDivElement>): void => {
      const key =
        e.key === 'ArrowRight' ? 'next' : e.key === 'ArrowLeft' ? 'prev' : e.key === 'Home' ? 'first' : e.key === 'End' ? 'last' : undefined;
      if (key === undefined) return;
      e.preventDefault();
      const next = stepInspectorTab(tabs, tab, key);
      openDeviceTab(next);
      tabRefs.current.get(next)?.focus();
    },
    [tabs, tab],
  );

  return (
    <div className="insp fill">
      <DeviceHeader device={device} description={model?.description} />
      <div className="insp-tabs" role="tablist" aria-label={`${device.name} details`} onKeyDown={onTabKey}>
        {tabs.map((t) => (
          <button
            key={t}
            ref={(el) => {
              if (el) tabRefs.current.set(t, el);
              else tabRefs.current.delete(t);
            }}
            id={`${baseId}-tab-${t}`}
            type="button"
            role="tab"
            aria-selected={tab === t}
            aria-controls={`${baseId}-panel`}
            tabIndex={tab === t ? 0 : -1}
            className={`tab${tab === t ? ' is-active' : ''}`}
            onClick={() => openDeviceTab(t)}
          >
            {inspectorTabLabel(t, device)}
          </button>
        ))}
      </div>
      <div className="insp-body" role="tabpanel" id={`${baseId}-panel`} aria-labelledby={`${baseId}-tab-${tab}`}>
        {tab === 'overview' && <OverviewTab device={device} model={model} />}
        {tab === 'ports' && <PortsTab device={device} />}
        {tab === 'config' && <ConfigTab device={device} highlight={local.highlight} nonce={local.nonce} />}
        {tab === 'tables' && <TablesView device={device} />}
        {tab === 'processes' && <ProcessesTab processes={device.processes} booted={device.booted} />}
        {tab === 'physical' && <ModulesPanel device={device} />}
        {tab === 'desktop' && <DesktopTab device={device} />}
        {tab === 'wireless' && <SettingsTab device={device} />}
        {tab === 'services' && <ServicesPanel device={device} />}
      </div>
    </div>
  );
}

function powerText(device: DeviceSnapshot): { cls: string; glyph: string; text: string } {
  if (!device.power) return { cls: 'off', glyph: '○', text: 'powered off' };
  if (!device.booted) return { cls: 'down', glyph: '▲', text: 'booting…' };
  return { cls: 'up', glyph: '●', text: 'running' };
}

function DeviceHeader({ device, description }: { device: DeviceSnapshot; description: string | undefined }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(device.name);
  const [powerBusy, setPowerBusy] = useState(false);
  const cancelled = useRef(false);

  useEffect(() => {
    if (!editing) setDraft(device.name);
  }, [device.name, editing]);

  useEffect(() => {
    setEditing(false);
  }, [device.id]);

  const commit = async (): Promise<void> => {
    setEditing(false);
    if (cancelled.current) {
      cancelled.current = false;
      setDraft(device.name);
      return;
    }
    const name = draft.trim();
    if (!name || name === device.name) {
      setDraft(device.name);
      return;
    }
    try {
      await engine.renameDevice(device.id, name);
    } catch (err) {
      setDraft(device.name);
      toastError(err);
    }
  };

  const togglePower = async (): Promise<void> => {
    setPowerBusy(true);
    try {
      await engine.setPower(device.id, !device.power);
    } catch (err) {
      toastError(err);
    } finally {
      setPowerBusy(false);
    }
  };

  const power = powerText(device);
  const consoleGate = consoleAvailability(device);
  const whyId = `insp-${device.id}-console-why`;

  return (
    <div className="insp-head">
      <div className="insp-title-row">
        {editing ? (
          <input
            className="insp-name-input"
            aria-label="Device name"
            value={draft}
            autoFocus
            maxLength={63}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={() => void commit()}
            onKeyDown={(e) => {
              if (e.key === 'Enter') e.currentTarget.blur();
              else if (e.key === 'Escape') {
                cancelled.current = true;
                e.currentTarget.blur();
              }
            }}
          />
        ) : (
          <button
            type="button"
            className="insp-title-btn"
            title="Rename this device"
            aria-label={`Rename ${device.name}`}
            onClick={() => {
              cancelled.current = false;
              setEditing(true);
            }}
          >
            {device.name} <span className="dim" aria-hidden="true">✎</span>
          </button>
        )}
      </div>
      <div className="insp-sub">
        <span className="mono" title={description}>
          {device.model}
        </span>
        <span>{categoryLabel(device.category)}</span>
        {device.variant !== undefined && <span className="dim">{device.variant}</span>}
        <span className={`led ${power.cls}`}>
          <span className="dot" aria-hidden="true">
            {power.glyph}
          </span>
          {power.text}
        </span>
      </div>
      <div className="insp-actions">
        <button
          type="button"
          className={`btn${device.power ? ' is-active' : ''}`}
          disabled={powerBusy}
          aria-pressed={device.power}
          onClick={() => void togglePower()}
          title={device.power ? 'Cut power (unsaved configuration is lost)' : 'Power on and boot'}
        >
          ⏻ {device.power ? 'Power off' : 'Power on'}
        </button>
        <button
          type="button"
          className="btn"
          disabled={!consoleGate.ok}
          aria-describedby={consoleGate.ok ? undefined : whyId}
          onClick={() => void openConsole(device)}
          title={consoleGate.ok ? 'Open a console session' : consoleGate.reason}
        >
          ▭ Open console
        </button>
      </div>
      {!consoleGate.ok && (
        <div id={whyId} className="insp-note">
          {consoleGate.reason}
        </div>
      )}
    </div>
  );
}

// ── overview ────────────────────────────────────────────────────────────────

function OverviewTab({ device, model }: { device: DeviceSnapshot; model: DeviceModel | undefined }) {
  const now = useTickNow();
  const snapshotNow = useStore((s) => s.snapshot?.now ?? 0);
  const wirelessCount = useStore((s) => associationsOfDevice(s.snapshot, device.id).length);
  const uptime = device.booted ? device.uptimeNs + Math.max(0, now - snapshotNow) : 0;
  const physical = device.ports.filter((p) => isDataPort(p) && p.virtual !== true);
  const up = physical.filter((p) => p.operUp).length;
  const addressed = device.ports.filter((p) => p.l3.ipv4 !== undefined);
  const presence = deviceTablePresence(device, model);
  const caps = device.capabilities ?? [];
  const tableParts: string[] = [];
  if (presence.cam) tableParts.push(`MAC ${device.tables.cam.length}`);
  if (presence.arp) tableParts.push(`ARP ${device.tables.arp.length}`);
  if (presence.rib) tableParts.push(`routes ${device.tables.rib.length}`);
  for (const t of device.tables.extra ?? []) tableParts.push(`${t.title.toLowerCase()} ${t.rows.length}`);

  return (
    <>
      <section className="insp-section">
        <dl className="kv">
          <dt>Category</dt>
          <dd>{categoryLabel(device.category)}</dd>
          <dt>Model</dt>
          <dd>
            <span className="mono">{device.model}</span> <span className="dim mono">({device.type})</span>
            {model !== undefined && <div className="dim">{model.description}</div>}
          </dd>
          {caps.length > 0 && (
            <>
              <dt>Can do</dt>
              <dd>
                {caps.map((c) => (
                  <span key={c} className="chip" style={{ marginRight: 4, marginBottom: 2, display: 'inline-block' }}>
                    {CAPABILITY_VOCAB[c].label}
                  </span>
                ))}
              </dd>
            </>
          )}
          <dt>Status</dt>
          <dd>{device.power ? (device.booted ? 'booted' : 'booting') : 'powered off'}</dd>
          <dt>Uptime</dt>
          <dd className="mono">{device.booted ? fmtUptime(uptime) : '—'}</dd>
          <dt>Ports up</dt>
          <dd className="mono">
            {up} / {physical.length}
          </dd>
          <dt>Addresses</dt>
          <dd className="mono">
            {addressed.length === 0
              ? 'none'
              : addressed.map((p) => (
                  <div key={p.id}>
                    {portAddress(p)} <span className="dim">on {p.short}</span>
                  </div>
                ))}
          </dd>
          {wirelessCount > 0 && (
            <>
              <dt>Wireless</dt>
              <dd>
                {wirelessCount} connection{wirelessCount === 1 ? '' : 's'}
              </dd>
            </>
          )}
          {tableParts.length > 0 && (
            <>
              <dt>Tables</dt>
              <dd className="mono">{tableParts.join(' · ')}</dd>
            </>
          )}
          {device.baseMac !== undefined && (
            <>
              <dt>Base MAC</dt>
              <dd className="mono">{device.baseMac}</dd>
            </>
          )}
          <dt>Startup config</dt>
          <dd>{device.hasStartupConfig ? 'saved' : 'not saved'}</dd>
        </dl>
      </section>
      <section className="insp-section">
        <div className="panel-title">Processes</div>
        {device.processes.length === 0 ? (
          <div className="insp-note">
            {!device.booted && (model === undefined || model.processes.length > 0)
              ? 'Daemons start once booting completes.'
              : 'No daemons on this model.'}
          </div>
        ) : (
          <dl className="kv">
            {device.processes.map((p) => (
              <Fragment key={p.process}>
                <dt>{p.process}</dt>
                <dd className="mono">{summarizeState(p.state)}</dd>
              </Fragment>
            ))}
          </dl>
        )}
      </section>
    </>
  );
}

function summarizeState(state: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(state)) {
    if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'string') parts.push(`${k} ${String(v)}`);
    else if (Array.isArray(v)) parts.push(`${k} ${v.length}`);
    if (parts.length >= 4) break;
  }
  return parts.join(' · ') || '—';
}

// ── ports ───────────────────────────────────────────────────────────────────

function PortsTab({ device }: { device: DeviceSnapshot }) {
  const selectedPort = useStore((s) =>
    s.selection?.kind === 'port' && s.selection.ref.device === device.id ? s.selection.ref.port : null,
  );
  const onSelect = useCallback(
    (port: string): void => store.getState().select({ kind: 'port', ref: { device: device.id, port } }),
    [device.id],
  );
  return (
    <table className="table compact">
      <thead>
        <tr>
          <th>Port</th>
          <th>Role</th>
          <th>Status</th>
          <th>Speed</th>
          <th>Address</th>
          <th className="num">In</th>
          <th className="num">Out</th>
          <th className="num">Err</th>
          <th className="num">Drops</th>
        </tr>
      </thead>
      <tbody>
        {device.ports.map((p) => (
          <PortRow
            key={p.id}
            port={p}
            roleText={p.role !== undefined ? portRoleLabel(p.role, device.capabilities) : ''}
            power={device.power}
            booted={device.booted}
            selected={selectedPort === p.id}
            onSelect={onSelect}
          />
        ))}
      </tbody>
    </table>
  );
}

const PortRow = memo(function PortRow({
  port,
  roleText,
  power,
  booted,
  selected,
  onSelect,
}: {
  port: PortSnapshot;
  roleText: string;
  power: boolean;
  booted: boolean;
  selected: boolean;
  onSelect(port: string): void;
}) {
  const c = port.counters;
  const speed = port.radio?.rateBps ?? port.speedBps;
  return (
    <tr
      className={`is-clickable${selected ? ' is-selected' : ''}`}
      onClick={() => onSelect(port.id)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onSelect(port.id);
        }
      }}
      tabIndex={0}
      aria-selected={selected}
      aria-label={`${port.id}, open port details`}
      title={`${port.id} — click to inspect`}
    >
      <td className="mono">{port.short}</td>
      <td className="dim">{roleText}</td>
      <td>
        <PortLed status={portStatus(port, { power, booted })} />
      </td>
      <td>{speed ? `${fmtBps(speed)} ${port.radio !== undefined ? 'radio' : (port.duplex ?? '')}` : '—'}</td>
      <td className="mono">{portAddress(port) ?? ''}</td>
      <td className="num">{c.inPackets}</td>
      <td className="num">{c.outPackets}</td>
      <td className="num">{c.inErrors}</td>
      <td className="num">{c.inDrops + c.outDrops}</td>
    </tr>
  );
});

// ── config ──────────────────────────────────────────────────────────────────

function ConfigTab({ device, highlight, nonce }: { device: DeviceSnapshot; highlight: string | null; nonce: number }) {
  const guiOnly = device.cli?.shell === 'none';
  const settings = panelsForTab(device, 'wireless')[0];
  return (
    <>
      {guiOnly && (
        <div className="insp-note">
          This device has no command line. The text below is what its settings panel
          {settings !== undefined ? ` (${GUI_PANEL_VOCAB[settings].label})` : ''} has stored.
        </div>
      )}
      <ConfigView
        key={device.id}
        running={device.runningConfig}
        startup={device.hasStartupConfig ? device.startupConfig : undefined}
        highlight={highlight}
        highlightNonce={nonce}
      />
    </>
  );
}

// ── processes ───────────────────────────────────────────────────────────────

function renderStateValue(v: unknown): JSX.Element | string {
  if (v === null || v === undefined) return '—';
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (Array.isArray(v) && v.length === 0) return 'none';
  return <pre>{JSON.stringify(v, null, 2)}</pre>;
}

function ProcessesTab({ processes, booted }: { processes: readonly StateView[]; booted: boolean }) {
  if (processes.length === 0) {
    return (
      <div className="empty-hint">
        {booted ? 'This model runs no protocol daemons.' : 'Protocol daemons start when the device finishes booting.'}
      </div>
    );
  }
  return (
    <>
      {processes.map((p) => {
        const entries = Object.entries(p.state);
        return (
          <section key={p.process} className="insp-section">
            <div className="panel-title">{p.process}</div>
            {entries.length === 0 ? (
              <div className="insp-note">No state reported.</div>
            ) : (
              <dl className="kv">
                {entries.map(([k, v]) => (
                  <Fragment key={k}>
                    <dt>{k}</dt>
                    <dd className="mono">{renderStateValue(v)}</dd>
                  </Fragment>
                ))}
              </dl>
            )}
          </section>
        );
      })}
    </>
  );
}

// ── settings panels ─────────────────────────────────────────────────────────

function SettingsPanel({ device, panel }: { device: DeviceSnapshot; panel: GuiPanelId }) {
  switch (panel) {
    case 'wireless.ap':
      return <WirelessPanel device={device} />;
    case 'home-router.setup':
      return <HomeRouterPanel device={device} />;
    case 'radio.link':
      return <RadioLinkPanel device={device} />;
    case 'cell.tower':
      return <CellTowerPanel device={device} />;
    case 'modem.status':
      return <ModemStatusPanel device={device} />;
    default:
      return null;
  }
}

function SettingsTab({ device }: { device: DeviceSnapshot }) {
  const panels = panelsForTab(device, 'wireless');
  return (
    <>
      {panels.map((panel) => (
        <section key={panel} className="insp-section" aria-label={GUI_PANEL_VOCAB[panel].label}>
          {panels.length > 1 && <div className="panel-title">{GUI_PANEL_VOCAB[panel].label}</div>}
          <SettingsPanel device={device} panel={panel} />
        </section>
      ))}
    </>
  );
}

/** Read-only status of a modem or line unit: its line side and its local side. */
export function ModemStatusPanel({ device }: { device: DeviceSnapshot }) {
  const line = device.ports.filter((p) => p.role === 'wan' || p.role === 'access-line');
  const local = device.ports.filter((p) => isDataPort(p) && p.virtual !== true && !line.includes(p));
  const select = (port: string): void => store.getState().select({ kind: 'port', ref: { device: device.id, port } });
  const rows = (ports: readonly PortSnapshot[]): JSX.Element =>
    ports.length === 0 ? (
      <div className="insp-note">none</div>
    ) : (
      <dl className="kv">
        {ports.map((p) => (
          <Fragment key={p.id}>
            <dt>
              <button type="button" className="link-btn mono" onClick={() => select(p.id)}>
                {p.short}
              </button>
            </dt>
            <dd>
              <PortLed status={portStatus(p, device)} />
              {p.speedBps !== undefined && <span className="dim mono"> {fmtBps(p.speedBps)}</span>}
            </dd>
          </Fragment>
        ))}
      </dl>
    );
  return (
    <>
      <div className="insp-note">
        A modem only passes traffic between its line and its local ports; it has no settings of its own in this release.
      </div>
      <div className="panel-title">Line side</div>
      {rows(line)}
      <div className="panel-title">Local side</div>
      {rows(local)}
    </>
  );
}
