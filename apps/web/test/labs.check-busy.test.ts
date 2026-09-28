// W6 fix (review finding #10; ARCHITECTURE-P2 §9.2 item 22c): a lab check shows ONE busy state whichever control
// started it. Simulate → "Check the lab now" sets the store's `lab.checking` for as long as the worker grades (it
// posts nothing meanwhile, so without it a long check looks like a hang), announces the start once, runs one check at
// a time and clears the flag however the check ends; the status bar and the Labs panel read the same flag.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { LabStatus, ScenarioMeta } from '@netforge/engine';

const api = vi.hoisted(() => ({ checkLab: vi.fn(), listScenarios: vi.fn(), loadScenario: vi.fn() }));
vi.mock('../src/bridge/client', async (importOriginal) => ({ ...(await importOriginal<Record<string, unknown>>()), engine: api }));
vi.mock('../src/store/store', () => {
  const state: Record<string, unknown> = {};
  const useStore = Object.assign((selector: (s: Record<string, unknown>) => unknown) => selector(state), {
    getState: () => state,
    setState: (patch: Record<string, unknown>) => Object.assign(state, patch),
    subscribe: () => () => undefined,
  });
  return { useStore, store: useStore };
});

import { store } from '../src/store/store';
import { checkLabNow } from '../src/app/TopBar';
import { LAB_CHECKING_STATUS, StatusBar } from '../src/app/StatusBar';
import { LAB_CHECK_ANNOUNCEMENT } from '../src/labs/LabBrowser';
import { LabPanel } from '../src/labs/LabPanel';

type Loose = Record<string, unknown>;
const state = (): Loose => (store as unknown as { getState(): Loose }).getState();
const lab = (): Loose => state()['lab'] as Loose;

function text(html: string): string {
  return html.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ');
}

function deferred<T>(): { promise: Promise<T>; resolve(v: T): void; reject(e: unknown): void } {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
}

const meta = { name: 'ccna2-etherchannel-lacp', title: 'Bundle two links', description: 'A lab.', category: 'ccna2-lab', topic: 'EtherChannel' } as unknown as ScenarioMeta;
const status: LabStatus = { lab: 'ccna2-etherchannel-lacp', checkedAt: 0, score: 40, total: 100, results: [] };
const toasts: [string, string | undefined][] = [];

beforeEach(() => {
  const s = state();
  for (const k of Object.keys(s)) delete s[k];
  for (const f of Object.values(api)) f.mockReset();
  toasts.length = 0;
  Object.assign(s, {
    ready: true,
    snapshot: null,
    snapshotIndex: undefined,
    inflight: [],
    droppedEvents: 0,
    tool: 'select',
    addDeviceType: null,
    pendingCable: null,
    camera: { zoom: 1 },
    selection: null,
    eventsTruncated: false,
    lab: { active: meta, status: null, browserOpen: false },
    toast: (t: string, kind?: string) => toasts.push([t, kind]),
    setLab: (p: Loose) => Object.assign(s, { lab: { ...(s['lab'] as Loose), ...p } }),
  });
});

describe('Simulate → "Check the lab now" (finding #10)', () => {
  it('holds lab.checking while the worker grades, announces the start once, and clears it with the result', async () => {
    const answer = deferred<LabStatus | null>();
    api.checkLab.mockImplementation(() => answer.promise);
    const running = checkLabNow();
    expect(lab()['checking']).toBe(true);
    expect(toasts).toEqual([[LAB_CHECK_ANNOUNCEMENT, undefined]]);
    // one check at a time: a second request while it runs asks nothing
    await checkLabNow();
    expect(api.checkLab).toHaveBeenCalledTimes(1);
    // meanwhile the status bar and the Labs panel say a check is running
    expect(text(renderToStaticMarkup(createElement(StatusBar)))).toContain(LAB_CHECKING_STATUS);
    const panel = text(renderToStaticMarkup(createElement(LabPanel)));
    expect(panel).toContain('Checking…');
    expect(panel).toContain('Checking your work');
    answer.resolve(status);
    await running;
    expect(lab()['checking']).toBe(false);
    expect(toasts.at(-1)).toEqual(['Lab check: 40 of 100 points.', undefined]);
    expect(text(renderToStaticMarkup(createElement(StatusBar)))).not.toContain(LAB_CHECKING_STATUS);
    expect(text(renderToStaticMarkup(createElement(LabPanel)))).toContain('Check my work');
  });

  it('clears the flag when the check fails', async () => {
    api.checkLab.mockRejectedValue(new Error('the worker is busy'));
    await checkLabNow();
    expect(lab()['checking']).toBe(false);
    expect(api.checkLab).toHaveBeenCalledTimes(1);
  });
});
