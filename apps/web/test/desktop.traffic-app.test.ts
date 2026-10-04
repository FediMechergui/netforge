/**
 * The traffic generator desktop app (ARCHITECTURE-P3 §5.9 `desktop.traffic`, M13, D16, §10.2 "desktop.traffic"; W3
 * web-desktop).
 *
 * Under test: the presets fill 50 packets per second / 60 B / DSCP 46 (and 200 B for the uncompressed call); the form
 * reads into exactly the flow it shows; Start emits exactly `hostRequest {app: 'traffic.start', flow}` with the form's
 * values and Stop `hostRequest {app: 'traffic.stop', id}`; the engine's own caps refuse what the daemon would; the
 * flows list comes from the sender's `traffic` StateView and its live delay, jitter and loss from the receiver's
 * `flows` row; the app is registered as a lazy window of the Desktop tab.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { DeviceSnapshot, FlowRow, SimSnapshot } from '@netforge/engine';

const api = vi.hoisted(() => ({
  hostRequest: vi.fn(),
}));
vi.mock('../src/bridge/client', () => ({ engine: api }));
// the window layer's command prompt draws a terminal, which needs a browser; it only has to be present here
vi.mock('../src/terminal/TerminalTab', () => ({
  TerminalTab: ({ tab }: { tab: { session: string } }) => createElement('div', { 'data-terminal': tab.session }),
}));
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
  DEFAULT_TRAFFIC_FORM,
  TrafficApp,
  TrafficPanel,
  applyTrafficPreset,
  checkTrafficFlow,
  flowRateText,
  flowStatsText,
  ownIpv4Addresses,
  receivedFlowOf,
  runningFlowIds,
  senderFlows,
  startTrafficFlow,
  stopTrafficFlow,
  trafficFlowOf,
  trafficPresets,
  type TrafficForm,
} from '../src/desktop/apps/TrafficApp';
import { TrafficWindow, desktopAppAvailability, desktopAppsFor } from '../src/desktop/DesktopTab';
import { desktopWindowApp } from '../src/desktop/WindowLayer';
import { device, port, snapshot } from './canvas-fixtures';

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

/** Every input in `html` is named by a `<label for>` or an aria-label. */
function unlabelledControls(html: string): string[] {
  const labelled = new Set([...html.matchAll(/<label[^>]*for="([^"]+)"/g)].map((m) => m[1] as string));
  const out: string[] = [];
  for (const m of html.matchAll(/<(input|select|textarea)\b[^>]*>/g)) {
    const tag = m[0];
    if (/aria-label="/.test(tag)) continue;
    const id = /\bid="([^"]+)"/.exec(tag)?.[1];
    if (id === undefined || !labelled.has(id)) out.push(tag);
  }
  return out;
}

const setState = (useStore as unknown as { setState(p: Record<string, unknown>): void }).setState;

function withAddress(id: string, address: string) {
  return port(id, { l3: { ipv4: { address, prefixLen: 24 } } });
}

/** PC1 (10.0.0.1) sends f1 (running) and f2 (finished); SRV1 (10.0.1.10) measured f1. */
function world(): { pc1: DeviceSnapshot; srv1: DeviceSnapshot; snap: SimSnapshot } {
  const pc1 = device('pc1', 0, 0, [withAddress('eth0', '10.0.0.1')], {
    gui: ['desktop.ip-config', 'desktop.command-prompt', 'desktop.traffic'],
    processes: [
      {
        process: 'traffic',
        state: {
          flows: [
            { id: 'f1', dst: '10.0.1.10', dstPort: 9, sizeBytes: 60, dscp: 46, paceNs: 20_000_000, mode: 'duration', limit: 500, sent: 120, errors: 0, state: 'running', startedAt: 0 },
            { id: 'f2', dst: '10.0.1.10', dstPort: 9, sizeBytes: 500, dscp: 0, paceNs: 62_500_000, mode: 'count', limit: 10, sent: 10, errors: 0, state: 'ended', startedAt: 0, endedAt: 1 },
          ],
          receiving: 0,
          received: 0,
        },
      },
    ],
  });
  const row: FlowRow = {
    key: '10.0.0.1|f1',
    flow: 'f1',
    src: '10.0.0.1',
    dst: '10.0.1.10',
    dstPort: 9,
    dscp: 46,
    received: 117,
    lost: 3,
    delayMinNs: 4_100_000,
    delayMaxNs: 41_250_000,
    delayAvgNs: 12_340_000,
    jitterNs: 850_000,
    firstAt: 0,
    lastAt: 2_400_000_000,
    ended: false,
    updatedAt: 2_400_000_000,
  };
  const srv1 = device('srv1', 100, 0, [withAddress('eth0', '10.0.1.10')], {
    tables: { cam: [], arp: [], rib: [], extra: [{ name: 'flows', title: 'Flows', columns: [], rows: [row as unknown as Record<string, unknown>] }] },
  });
  return { pc1, srv1, snap: snapshot([pc1, srv1]) };
}

beforeEach(() => {
  api.hostRequest.mockReset();
  api.hostRequest.mockResolvedValue({ requestId: 'r_1', process: 'traffic' });
  setState({ snapshot: null, snapshotIndex: undefined });
});

describe('the form', () => {
  it('presets fill 50 packets per second, 60 B and DSCP 46 (and 200 B uncompressed), keeping the rest', () => {
    const form: TrafficForm = { ...DEFAULT_TRAFFIC_FORM, dst: '10.0.1.10', durationS: '30' };
    expect(applyTrafficPreset(form, 'voice-g729')).toEqual({ ...form, rateKind: 'pps', rate: '50', sizeBytes: '60', dscp: '46' });
    expect(applyTrafficPreset(form, 'voice-g711')).toEqual({ ...form, rateKind: 'pps', rate: '50', sizeBytes: '200', dscp: '46' });
    expect(trafficPresets().map((p) => [p.id, p.pps, p.sizeBytes, p.dscp])).toEqual([
      ['voice-g729', 50, 60, 46],
      ['voice-g711', 50, 200, 46],
    ]);
  });

  it('reads into exactly the flow it shows, for each way of ending', () => {
    const base: TrafficForm = { ...DEFAULT_TRAFFIC_FORM, dst: ' 10.0.1.10 ' };
    expect(trafficFlowOf(base)).toEqual({ ok: true, flow: { dst: '10.0.1.10', dstPort: 9, sizeBytes: 500, dscp: 0, rateKbps: 64, durationMs: 10_000 } });
    expect(trafficFlowOf({ ...applyTrafficPreset(base, 'voice-g729'), length: 'count', count: '250', name: 'call1' })).toEqual({
      ok: true,
      flow: { id: 'call1', dst: '10.0.1.10', dstPort: 9, sizeBytes: 60, dscp: 46, pps: 50, count: 250 },
    });
    expect(trafficFlowOf({ ...base, length: 'continuous' })).toEqual({ ok: true, flow: { dst: '10.0.1.10', dstPort: 9, sizeBytes: 500, dscp: 0, rateKbps: 64 } });
    expect(trafficFlowOf({ ...base, durationS: '2.5' })).toMatchObject({ ok: true, flow: { durationMs: 2500 } });
  });

  it('names the field that cannot be read', () => {
    expect(trafficFlowOf(DEFAULT_TRAFFIC_FORM)).toEqual({ ok: false, field: 'dst', error: 'Enter the address of the device that receives the flow.' });
    const base: TrafficForm = { ...DEFAULT_TRAFFIC_FORM, dst: '10.0.1.10' };
    expect(trafficFlowOf({ ...base, rate: '0' })).toMatchObject({ ok: false, field: 'rate' });
    expect(trafficFlowOf({ ...base, sizeBytes: 'big' })).toMatchObject({ ok: false, field: 'sizeBytes' });
    expect(trafficFlowOf({ ...base, dscp: '-1' })).toMatchObject({ ok: false, field: 'dscp' });
    expect(trafficFlowOf({ ...base, durationS: '1.2345' })).toMatchObject({ ok: false, field: 'durationS' });
    expect(trafficFlowOf({ ...base, length: 'count', count: '0' })).toMatchObject({ ok: false, field: 'count' });
  });

  it('refuses what the daemon would, in its words without the console prefix', () => {
    const ok = { dst: '10.0.1.10', dstPort: 9, sizeBytes: 500, dscp: 0, rateKbps: 64, durationMs: 10_000 };
    expect(checkTrafficFlow(ok, [])).toBeNull();
    expect(checkTrafficFlow({ ...ok, rateKbps: 5000 }, [])).toBe('A flow sends at most 2000 kb/s and 1000 packets per second.');
    expect(checkTrafficFlow({ ...ok, sizeBytes: 20 }, [])).toBe("A flow's packets are 60 to 1500 bytes long.");
    expect(checkTrafficFlow({ ...ok, durationMs: 600_000 }, [])).toBe('A flow lasts at most 5 minutes; give a smaller count or duration.');
    expect(checkTrafficFlow(ok, ['f1', 'f2', 'f3', 'f4', 'f5', 'f6', 'f7', 'f8'])).toBe('This device already sends 8 flows. Stop one first.');
    expect(checkTrafficFlow({ ...ok, dst: '255.255.255.255' }, [])).toBe('A flow needs a unicast IPv4 destination; 255.255.255.255 is not one.');
    expect(checkTrafficFlow(ok, [], ['10.0.1.10'])).toBe('10.0.1.10 is this device; a flow goes to another device.');
  });
});

describe('requests', () => {
  it('Start emits exactly hostRequest {app: "traffic.start", flow} with the form’s values', async () => {
    const read = trafficFlowOf(applyTrafficPreset({ ...DEFAULT_TRAFFIC_FORM, dst: '10.0.1.10' }, 'voice-g729'));
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    await expect(startTrafficFlow('pc1', read.flow)).resolves.toBe('r_1');
    expect(api.hostRequest).toHaveBeenCalledTimes(1);
    expect(api.hostRequest).toHaveBeenCalledWith('pc1', {
      app: 'traffic.start',
      flow: { dst: '10.0.1.10', dstPort: 9, sizeBytes: 60, dscp: 46, pps: 50, durationMs: 10_000 },
    });
  });

  it('Stop emits exactly hostRequest {app: "traffic.stop", id}', async () => {
    await stopTrafficFlow('pc1', 'f1');
    expect(api.hostRequest).toHaveBeenCalledTimes(1);
    expect(api.hostRequest).toHaveBeenCalledWith('pc1', { app: 'traffic.stop', id: 'f1' });
  });
});

describe('flows and their live figures', () => {
  it('reads the sender’s flows from its traffic StateView, running ones counted against the cap', () => {
    const { pc1 } = world();
    const flows = senderFlows(pc1);
    expect(flows.map((f) => [f.id, f.state, f.sent, f.limit])).toEqual([
      ['f1', 'running', 120, 500],
      ['f2', 'ended', 10, 10],
    ]);
    expect(runningFlowIds(flows)).toEqual(['f1']);
    expect(senderFlows(device('x', 0, 0, []))).toEqual([]);
    expect(ownIpv4Addresses(pc1)).toEqual(['10.0.0.1']);
    expect(flowRateText(flows[0]!)).toBe('50 packets/s (24 kb/s)');
  });

  it('finds the receiver’s row by the flow name and the sender’s address, and words its delay, jitter and loss', () => {
    const { pc1, snap } = world();
    const f1 = senderFlows(pc1)[0]!;
    const rx = receivedFlowOf(snap, pc1, f1);
    expect(rx?.device).toBe('SRV1');
    expect(rx?.row.key).toBe('10.0.0.1|f1');
    expect(receivedFlowOf(snap, pc1, senderFlows(pc1)[1]!)).toBeUndefined();
    const s = flowStatsText(rx!);
    expect(s.delay).toBe('12.3 ms average (4.10 ms to 41.3 ms)');
    expect(s.jitter).toBe('0.85 ms');
    expect(s.loss).toBe('3 of 120 (2.5 %)');
    expect(s.sentence).toContain('SRV1 measured: delay 12.3 ms average');
  });

  it('accepts a translated source only when one row matches the flow, destination and port', () => {
    const { pc1, snap } = world();
    const natted = structuredClone(snap);
    const row = natted.devices[1]!.tables.extra![0]!.rows[0]!;
    row['src'] = '203.0.113.5';
    expect(receivedFlowOf(natted, pc1, senderFlows(pc1)[0]!)?.row.src).toBe('203.0.113.5');
    natted.devices[1]!.tables.extra![0]!.rows.push({ ...row, src: '203.0.113.6' });
    expect(receivedFlowOf(natted, pc1, senderFlows(pc1)[0]!)).toBeUndefined();
  });

  it('renders the list with the live figures, a Stop button for the running flow only, and labelled controls', () => {
    const { pc1, snap } = world();
    setState({ snapshot: snap });
    const html = renderToStaticMarkup(createElement(TrafficPanel, { device: pc1 }));
    const t = text(html);
    expect(t).toContain('Flows from PC1');
    expect(t).toContain('12.3 ms average (4.10 ms to 41.3 ms)');
    expect(t).toContain('0.85 ms');
    expect(t).toContain('3 of 120 (2.5 %)');
    expect(t).toContain('▶ sending');
    expect(t).toContain('✓ finished');
    expect(t).toContain('no report yet');
    expect((html.match(/aria-label="Stop flow /g) ?? []).length).toBe(1);
    expect(html).toContain('aria-label="Stop flow f1"');
    expect(t).toContain('Voice call, compressed (50 pps × 60 B, DSCP 46)');
    expect(t).toContain('Voice call, uncompressed (50 pps × 200 B, DSCP 46)');
    expect(unlabelledControls(html)).toEqual([]);
  });

  it('says so when no flow has been started, and when the device is gone', () => {
    const quiet = device('pc2', 0, 0, [], { gui: ['desktop.traffic'] });
    expect(text(renderToStaticMarkup(createElement(TrafficPanel, { device: quiet })))).toContain('No flow has been started yet.');
    setState({ snapshot: snapshot([]) });
    expect(text(renderToStaticMarkup(createElement(TrafficApp, { deviceId: 'nope', windowId: 1 })))).toContain('This device is no longer on the canvas.');
  });
});

describe('registration', () => {
  it('is a desktop app of the Desktop tab, opened as a lazy window', () => {
    expect(desktopAppAvailability('desktop.traffic')).toEqual({ ok: true });
    expect(desktopWindowApp('desktop.traffic')).toBe(TrafficWindow);
    expect(desktopAppsFor({ gui: ['desktop.traffic', 'desktop.ip-config'] })).toEqual(['desktop.ip-config', 'desktop.traffic']);
    // a server render of the lazy window shows its loading line
    expect(text(renderToStaticMarkup(createElement(TrafficWindow, { deviceId: 'pc1', windowId: 1 })))).toContain('Loading the traffic generator…');
  });
});
