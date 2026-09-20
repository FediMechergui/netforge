// Desktop web browser (ARCHITECTURE-P1 §4.4 step 0, §4.5, §7 "Browser and Services", §8.2 W7 web-learn): the
// ticket → http-client tab reading, the phase ladder, the remembered addresses, and the rendered window over a
// REAL fetch — the `ccna1-web-server` lab solved, then `hostRequest(PC1, http.get …)` walked to `done`.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { SCENARIOS, SEC, createSimulation } from '@netforge/engine';
import type { DeviceSnapshot, ScenarioInfo, SimSnapshot } from '@netforge/engine';

const api = vi.hoisted(() => ({ hostRequest: vi.fn(), setDeviceUi: vi.fn() }));
vi.mock('../src/bridge/client', () => ({ engine: api }));
vi.mock('../src/store/store', () => {
  const state: Record<string, unknown> = {};
  const useStore = Object.assign((selector: (s: Record<string, unknown>) => unknown) => selector(state), {
    getState: () => state,
    setState: (patch: Record<string, unknown>) => Object.assign(state, patch),
    subscribe: () => () => undefined,
  });
  return { useStore, store: useStore };
});

import { useStore } from '../src/store/store';
import {
  BROWSER_HISTORY_MAX,
  BROWSER_URL_MAX,
  BrowserApp,
  BrowserResult,
  DEFAULT_BROWSER_URL,
  PHASE_TEXT,
  fetchPage,
  historyWith,
  httpTabOf,
  phaseSteps,
  uiWithVisit,
} from '../src/desktop/apps/BrowserApp';

const setState = (useStore as unknown as { setState(p: Record<string, unknown>): void }).setState;

function indexOf(snapshot: SimSnapshot) {
  return {
    topologyVersion: snapshot.topologyVersion,
    devices: Object.fromEntries(snapshot.devices.map((d, i) => [d.id, i])),
    links: Object.fromEntries(snapshot.links.map((l, i) => [l.id, i])),
  };
}

function text(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ');
}

const webLab = SCENARIOS.find((s) => s.name === 'ccna1-web-server') as ScenarioInfo;

/** The web-server lab, solved, with PC1 asked for `url`; returns the snapshot and the ticket. */
function fetched(url: string): { snapshot: SimSnapshot; ticket: string } {
  const sim = createSimulation({ seed: webLab.seed ?? 1 });
  sim.loadTopology(webLab.build());
  sim.runFor(40 * SEC); // every device booted and every link up (the switch takes the longest)
  for (const [name, lines] of Object.entries(webLab.solution ?? {})) {
    const device = sim.snapshot().devices.find((d) => d.name === name);
    if (device === undefined) throw new Error(`no device ${name}`);
    const result = sim.configure(device.id, [...lines], { stopOnError: true });
    if (!result.ok) throw new Error(`${name}: ${result.lines.map((l) => l.output).join(' / ')}`);
  }
  sim.runFor(2 * SEC);
  const ticket = sim.hostRequest('pc1', { app: 'http.get', url });
  sim.runFor(20 * SEC);
  return { snapshot: sim.snapshot(), ticket: ticket.requestId };
}

function device(snapshot: SimSnapshot, id: string): DeviceSnapshot {
  const d = snapshot.devices.find((x) => x.id === id);
  if (d === undefined) throw new Error(`no device ${id}`);
  return d;
}

beforeEach(() => {
  const s = (useStore as unknown as { getState(): Record<string, unknown> }).getState();
  for (const k of Object.keys(s)) delete s[k];
  for (const f of Object.values(api)) f.mockReset();
});

describe('tab reading', () => {
  it('reads the http-client tab keyed by the ticket, and nothing else', () => {
    const { snapshot, ticket } = fetched('http://www.lab.nf/index.html');
    const pc1 = device(snapshot, 'pc1');
    expect(ticket).toBe('r_1');
    const tab = httpTabOf(pc1, ticket);
    expect(tab).toBeDefined();
    expect(tab!.phase).toBe('done');
    expect(tab!.status).toBe(200);
    expect(tab!.host).toBe('www.lab.nf');
    expect(tab!.address).toBe('192.168.26.80');
    expect(tab!.body).toContain('This page is served by the practice web server.');
    expect(httpTabOf(pc1, 'r_99')).toBeUndefined();
    expect(httpTabOf(pc1, null)).toBeUndefined();
    expect(httpTabOf({ processes: [] }, 'r_1')).toBeUndefined();
    expect(httpTabOf({ processes: [{ process: 'http-client', state: { tabs: { r_1: 7 } } }] }, 'r_1')).toBeUndefined();
  });

  it('keeps the wording the engine produced for a page it will not fetch', () => {
    const { snapshot, ticket } = fetched('https://www.lab.nf/index.html');
    const tab = httpTabOf(device(snapshot, 'pc1'), ticket);
    expect(tab!.phase).toBe('error');
    expect(tab!.error).toBe('Secure pages are not simulated in this release.');
  });
});

describe('phase ladder', () => {
  it('marks the phases walked, the one running and the ones still to come', () => {
    expect(phaseSteps('resolving').map((s) => s.mark)).toEqual(['▶', '·', '·', '·', '·']);
    expect(phaseSteps('waiting').map((s) => s.mark)).toEqual(['✓', '✓', '▶', '·', '·']);
    expect(phaseSteps('done').map((s) => s.mark)).toEqual(['✓', '✓', '✓', '✓', '✓']);
    // A failed fetch marks nothing as running: the error line says what happened.
    expect(phaseSteps('error').every((s) => s.mark === '·')).toBe(true);
    expect(phaseSteps(undefined).every((s) => s.mark === '·')).toBe(true);
    expect(PHASE_TEXT.resolving).toBe('looking up the name');
  });
});

describe('remembered addresses', () => {
  it('keeps the newest first, without repeats, within the stored limits', () => {
    expect(historyWith(undefined, 'http://a/')).toEqual(['http://a/']);
    expect(historyWith(['http://a/', 'http://b/'], 'http://b/')).toEqual(['http://b/', 'http://a/']);
    expect(historyWith(['http://a/'], '   ')).toEqual(['http://a/']);
    const many = Array.from({ length: BROWSER_HISTORY_MAX + 5 }, (_, i) => `http://h${i}/`);
    expect(historyWith(many, 'http://new/').length).toBe(BROWSER_HISTORY_MAX);
    expect(historyWith(many, 'http://new/')[0]).toBe('http://new/');
    expect(historyWith([], 'x'.repeat(BROWSER_URL_MAX + 10))[0]!.length).toBe(BROWSER_URL_MAX);
  });

  it('writes the address into the device UI record without losing the rest of it', () => {
    const ui = uiWithVisit({ note: 'lab pc', desktop: { pinnedApps: ['desktop.web-browser'], browserHistory: ['http://old/'] } }, 'http://new/');
    expect(ui.note).toBe('lab pc');
    expect(ui.desktop!.pinnedApps).toEqual(['desktop.web-browser']);
    expect(ui.desktop!.browserUrl).toBe('http://new/');
    expect(ui.desktop!.browserHistory).toEqual(['http://new/', 'http://old/']);
    expect(uiWithVisit(undefined, 'http://a/').desktop!.browserHistory).toEqual(['http://a/']);
  });
});

describe('asking for a page', () => {
  it('sends one http.get request and returns the ticket it is keyed by', async () => {
    api.hostRequest.mockResolvedValueOnce({ requestId: 'r_4', process: 'http-client' });
    expect(await fetchPage('pc1', 'http://www.lab.nf/')).toBe('r_4');
    expect(api.hostRequest).toHaveBeenCalledWith('pc1', { app: 'http.get', url: 'http://www.lab.nf/' });
  });
});

describe('the window', () => {
  it('opens on the remembered address and lists what was opened before', () => {
    const { snapshot } = fetched('http://www.lab.nf/index.html');
    const pc1: DeviceSnapshot = { ...device(snapshot, 'pc1'), ui: { desktop: { browserUrl: 'http://www.lab.nf/index.html', browserHistory: ['http://www.lab.nf/index.html', 'http://192.168.26.80/'] } } };
    setState({ snapshot: { ...snapshot, devices: snapshot.devices.map((d) => (d.id === 'pc1' ? pc1 : d)) }, snapshotIndex: indexOf(snapshot) });
    const html = renderToStaticMarkup(createElement(BrowserApp, { deviceId: 'pc1', windowId: 1 }));
    const t = text(html);
    expect(html).toContain('value="http://www.lab.nf/index.html"');
    expect(t).toContain('Recently opened');
    expect(t).toContain('http://192.168.26.80/');
    expect(t).toContain('Nothing has been asked for yet.'); // no fetch from THIS window yet
    expect(html).toContain('<label for=');
  });

  it('falls back to the lab address on a device that has browsed nothing', () => {
    const { snapshot } = fetched('http://www.lab.nf/index.html');
    setState({ snapshot, snapshotIndex: indexOf(snapshot) });
    const html = renderToStaticMarkup(createElement(BrowserApp, { deviceId: 'pc1', windowId: 1 }));
    expect(html).toContain(`value="${DEFAULT_BROWSER_URL}"`);
    expect(text(html)).not.toContain('Recently opened');
  });

  it('shows the ladder, who answered and the page as text, never as markup', () => {
    const { snapshot, ticket } = fetched('http://www.lab.nf/index.html');
    const tab = httpTabOf(device(snapshot, 'pc1'), ticket);
    const html = renderToStaticMarkup(createElement(BrowserResult, { tab }));
    const t = text(html);
    expect(t).toContain('looking up the name');
    expect(t).toContain('page loaded');
    expect((html.match(/✓/g) ?? []).length).toBe(5); // every phase walked
    expect(t).toContain('www.lab.nf');
    expect(t).toContain('192.168.26.80');
    expect(t).toContain('200 OK');
    expect(t).toContain('This page is served by the practice web server.');
    // The body arrives as html from the server and stays inside one <pre> as characters.
    expect(html).toContain('<pre class="desk-mono">');
    expect(html).not.toMatch(/<pre class="desk-mono">[^<]*<[a-z]/);
    expect(html).toContain('it does not draw the page');
  });

  it('shows the failure the engine reported, with nothing marked as running', () => {
    const { snapshot, ticket } = fetched('https://www.lab.nf/index.html');
    const html = renderToStaticMarkup(createElement(BrowserResult, { tab: httpTabOf(device(snapshot, 'pc1'), ticket) }));
    expect(html).toContain('role="alert"');
    expect(text(html)).toContain('Secure pages are not simulated in this release.');
    expect(html).not.toContain('▶');
  });

  it('says so when the device is gone or switched off', () => {
    const { snapshot } = fetched('http://www.lab.nf/index.html');
    setState({ snapshot, snapshotIndex: indexOf(snapshot) });
    expect(text(renderToStaticMarkup(createElement(BrowserApp, { deviceId: 'nope', windowId: 1 })))).toContain('no longer on the canvas');
    const off = { ...device(snapshot, 'pc1'), power: false };
    setState({ snapshot: { ...snapshot, devices: snapshot.devices.map((d) => (d.id === 'pc1' ? off : d)) }, snapshotIndex: indexOf(snapshot) });
    expect(text(renderToStaticMarkup(createElement(BrowserApp, { deviceId: 'pc1', windowId: 1 })))).toContain('switched off');
  });
});
