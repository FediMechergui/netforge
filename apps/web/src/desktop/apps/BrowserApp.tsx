/**
 * Desktop "Web browser" app (ARCHITECTURE-P1 §4.4 step 0, §4.5, §7 "Browser and Services").
 *
 * Typing an address and pressing Go calls `EngineApi.hostRequest(device, {app:'http.get', url})`. The facade
 * answers with the ticket `r_<n>`, which IS the http-client tab token, so the app then simply renders
 * `processState(device, 'http-client').tabs[token]` out of every snapshot: the phase ladder
 * resolving → connecting → waiting → receiving → done, the status line, the headers and the body. Nothing here
 * talks to the network stack itself, and nothing polls.
 *
 * The body is shown as TEXT, always: the page a lab serves is data from the simulation, never markup for this
 * document. Failures show the wording the engine produced (the https message, a refused connection, a name that
 * did not resolve), because that wording is what the lab teaches. The current address and the recent ones are
 * kept on the device through `setDeviceUi`, so they survive a save and a reload.
 *
 * ponytail: one tab per window and no rendering of links inside the page — a fetch is the lesson, a browser
 * engine is not; the phase ladder is marks plus words, never colour.
 */
import { useId, useState } from 'react';
import type { DeviceId, DeviceSnapshot, HttpTabPhase, TopologyDeviceUi } from '@netforge/engine';
import { engine } from '../../bridge/client';
import { DeviceGone, deviceBusyReason, errorText, processState, useDeviceById } from '../shared.js';
import type { DesktopAppProps } from '../shared.js';

/** Address a new browser window offers (the name the service labs publish). */
export const DEFAULT_BROWSER_URL = 'http://www.lab.nf/';
/** Addresses remembered per device (contracts/topology.ts `TopologyDeviceUi`). */
export const BROWSER_HISTORY_MAX = 20;
/** Longest address remembered (contracts/topology.ts). */
export const BROWSER_URL_MAX = 512;

/** One http-client tab, read out of the daemon's StateView. */
export interface BrowserTabView {
  readonly url: string;
  readonly phase: HttpTabPhase;
  readonly host: string;
  readonly address?: string;
  readonly status?: number;
  readonly reason?: string;
  readonly headers?: string;
  readonly body?: string;
  readonly error?: string;
}

const PHASES: readonly HttpTabPhase[] = Object.freeze(['resolving', 'connecting', 'waiting', 'receiving', 'done']);

/** What each phase means, in words (the ladder's text channel). */
export const PHASE_TEXT: Readonly<Record<HttpTabPhase, string>> = Object.freeze({
  resolving: 'looking up the name',
  connecting: 'opening the connection',
  waiting: 'request sent, waiting for the answer',
  receiving: 'reading the page',
  done: 'page loaded',
  error: 'the page did not load',
});

function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

/** The tab `token` of a device's http-client, or undefined while the daemon has not recorded it (yet). */
export function httpTabOf(device: Pick<DeviceSnapshot, 'processes'>, token: string | null): BrowserTabView | undefined {
  if (token === null) return undefined;
  const tabs = processState(device, 'http-client')?.['tabs'];
  if (tabs === null || typeof tabs !== 'object') return undefined;
  const raw = (tabs as Record<string, unknown>)[token];
  if (raw === null || typeof raw !== 'object') return undefined;
  const t = raw as Record<string, unknown>;
  const phase = str(t['phase']);
  if (phase === undefined) return undefined;
  const status = typeof t['status'] === 'number' ? t['status'] : undefined;
  return {
    url: str(t['url']) ?? '',
    phase: phase as HttpTabPhase,
    host: str(t['host']) ?? '',
    ...(str(t['address']) !== undefined ? { address: str(t['address']) as string } : {}),
    ...(status !== undefined ? { status } : {}),
    ...(str(t['reason']) !== undefined ? { reason: str(t['reason']) as string } : {}),
    ...(str(t['headers']) !== undefined ? { headers: str(t['headers']) as string } : {}),
    ...(str(t['body']) !== undefined ? { body: str(t['body']) as string } : {}),
    ...(str(t['error']) !== undefined ? { error: str(t['error']) as string } : {}),
  };
}

/** One step of the phase ladder. `mark` is the non-colour channel. */
export interface PhaseStep {
  readonly phase: HttpTabPhase;
  readonly status: 'done' | 'current' | 'todo';
  readonly mark: '✓' | '▶' | '·';
}

/**
 * The ladder for a tab: every phase before the current one is done, the current one is marked, later ones are
 * pending. A failed tab marks nothing as current — the error line says what happened instead.
 */
export function phaseSteps(phase: HttpTabPhase | undefined): readonly PhaseStep[] {
  const at = phase === undefined ? -1 : PHASES.indexOf(phase);
  return PHASES.map((p, i) => {
    if (at < 0 || i > at) return { phase: p, status: 'todo', mark: '·' };
    if (i < at || p === 'done') return { phase: p, status: 'done', mark: '✓' };
    return { phase: p, status: 'current', mark: '▶' };
  });
}

/** The history after visiting `url`: newest first, no repeats, at most BROWSER_HISTORY_MAX entries. */
export function historyWith(history: readonly string[] | undefined, url: string): string[] {
  const value = url.trim().slice(0, BROWSER_URL_MAX);
  if (value === '') return [...(history ?? [])].slice(0, BROWSER_HISTORY_MAX);
  return [value, ...(history ?? []).filter((h) => h !== value)].slice(0, BROWSER_HISTORY_MAX);
}

/** The device UI record after visiting `url` (other stored GUI state is kept). */
export function uiWithVisit(ui: TopologyDeviceUi | undefined, url: string): TopologyDeviceUi {
  const desktop = ui?.desktop ?? {};
  return { ...ui, desktop: { ...desktop, browserUrl: url.trim().slice(0, BROWSER_URL_MAX), browserHistory: historyWith(desktop.browserHistory, url) } };
}

/** Ask the device to fetch `url`; the ticket is the http-client tab token. */
export async function fetchPage(device: DeviceId, url: string): Promise<string> {
  const ticket = await engine.hostRequest(device, { app: 'http.get', url });
  return ticket.requestId;
}

/**
 * What one tab reached: the phase ladder, who answered, the reply line, the page as text and the failure the
 * engine reported. The page is a `<pre>` of characters — this window never draws the markup it was sent.
 */
export function BrowserResult({ tab }: { tab: BrowserTabView | undefined }) {
  const uid = useId();
  const steps = phaseSteps(tab?.phase);
  return (
    <>
      <section aria-labelledby={`${uid}-progress`}>
        <h3 id={`${uid}-progress`} className="desk-heading">
          What the device is doing
        </h3>
        {tab === undefined ? (
          <p className="desk-empty">Nothing has been asked for yet.</p>
        ) : (
          <>
            <ul className="desk-list">
              {steps.map((s) => (
                <li key={s.phase}>
                  <span aria-hidden="true">{s.mark} </span>
                  {PHASE_TEXT[s.phase]}
                  {s.status === 'current' && <span className="desk-sub"> — now</span>}
                </li>
              ))}
            </ul>
            <dl className="desk-info">
              <div className="desk-info-row">
                <dt>Name asked for</dt>
                <dd className="desk-mono">{tab.host === '' ? '—' : tab.host}</dd>
              </div>
              {tab.address !== undefined && (
                <div className="desk-info-row">
                  <dt>Answered by</dt>
                  <dd className="desk-mono">{tab.address}</dd>
                </div>
              )}
              {tab.status !== undefined && (
                <div className="desk-info-row">
                  <dt>Reply</dt>
                  <dd className="desk-mono">
                    {tab.status} {tab.reason ?? ''}
                  </dd>
                </div>
              )}
            </dl>
          </>
        )}
        {tab?.error !== undefined && (
          <p className="desk-error" role="alert">
            <span aria-hidden="true">⚠ </span>
            {tab.error}
          </p>
        )}
      </section>

      {tab?.body !== undefined && (
        <section aria-labelledby={`${uid}-page`}>
          <h3 id={`${uid}-page`} className="desk-heading">
            The page, as it arrived
          </h3>
          <p className="desk-sub">This window shows what the server sent, character for character; it does not draw the page.</p>
          <pre className="desk-mono">{tab.body}</pre>
          {tab.headers !== undefined && (
            <>
              <h3 className="desk-heading">Headers</h3>
              <pre className="desk-mono">{tab.headers}</pre>
            </>
          )}
        </section>
      )}
    </>
  );
}

export function BrowserApp({ deviceId }: DesktopAppProps) {
  const device = useDeviceById(deviceId);
  if (device === undefined) return <DeviceGone />;
  return <BrowserPanel device={device} />;
}

function BrowserPanel({ device }: { device: DeviceSnapshot }) {
  const uid = useId();
  const stored = device.ui?.desktop;
  const [url, setUrl] = useState(stored?.browserUrl ?? DEFAULT_BROWSER_URL);
  const [token, setToken] = useState<string | null>(null);
  const [refused, setRefused] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const tab = httpTabOf(device, token);
  const blocked = deviceBusyReason(device);
  const history = stored?.browserHistory ?? [];

  const go = async (target: string): Promise<void> => {
    const value = target.trim();
    if (value === '') return;
    setBusy(true);
    setRefused(null);
    setUrl(value);
    try {
      setToken(await fetchPage(device.id, value));
      void engine.setDeviceUi(device.id, uiWithVisit(device.ui, value)).catch(() => undefined);
    } catch (err) {
      setToken(null);
      setRefused(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="desk-app">
      <form
        className="desk-form"
        aria-labelledby={`${uid}-title`}
        onSubmit={(e) => {
          e.preventDefault();
          if (!busy && blocked === undefined) void go(url);
        }}
      >
        <h3 id={`${uid}-title`} className="desk-heading">
          Web address
        </h3>
        <div className="desk-field">
          <label htmlFor={`${uid}-url`}>Address</label>
          <input
            id={`${uid}-url`}
            className="input desk-mono"
            value={url}
            spellCheck={false}
            autoComplete="off"
            placeholder={DEFAULT_BROWSER_URL}
            onChange={(e) => setUrl(e.target.value)}
          />
        </div>
        {blocked !== undefined && <p className="desk-note">{blocked}</p>}
        <div className="desk-actions">
          <button type="submit" className="btn btn-primary" disabled={busy || blocked !== undefined}>
            {busy ? 'Asking…' : 'Go'}
          </button>
        </div>
        {refused !== null && (
          <p className="desk-error" role="alert">
            <span aria-hidden="true">⚠ </span>
            {refused}
          </p>
        )}
      </form>

      <BrowserResult tab={tab} />

      {history.length > 0 && (
        <section aria-labelledby={`${uid}-history`}>
          <h3 id={`${uid}-history`} className="desk-heading">
            Recently opened
          </h3>
          <ul className="desk-list">
            {history.map((h) => (
              <li key={h} className="desk-open-row">
                <span className="desk-mono desk-open-title">{h}</span>
                <button type="button" className="btn" disabled={busy || blocked !== undefined} onClick={() => void go(h)} aria-label={`Open ${h} again`}>
                  Open
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
