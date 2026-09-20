// NetScope panes (ARCHITECTURE-P1 §4.12, §7 "NetScope", §16 keyboard operation): the pure helpers each pane
// exports, plus server-rendered smoke tests over a mocked bridge and store. Frames, decodes and statistics come
// from a real engine capture store, so what the panes render is what the worker would send.
import { describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createCaptureStore, createSimulation } from '@netforge/engine';
import type { CaptureInfo, CaptureInterface, CaptureRecord, CaptureRow, CaptureStore, FollowStreamResult } from '@netforge/engine';

vi.mock('../src/bridge/client', () => ({ engine: {}, fmtSimTime: (t: number) => String(t) }));
vi.mock('../src/store/store', () => {
  const state: Record<string, unknown> = { snapshot: null, epoch: 0 };
  const useStore = Object.assign((selector: (s: Record<string, unknown>) => unknown) => selector(state), {
    getState: () => state,
    setState: (patch: Record<string, unknown>) => Object.assign(state, patch),
    subscribe: () => () => undefined,
  });
  return { useStore, store: useStore };
});

import { useStore } from '../src/store/store';
import { NS_ROW_HEIGHT, PacketList, movedPosition, scrollToRow, visibleRange } from '../src/netscope/PacketList';
import { DetailTree, rangeOf } from '../src/netscope/DetailTree';
import { HexPane, rangeText } from '../src/netscope/HexPane';
import { FilterBar, nextHighlight, suggestionsFor, typingError } from '../src/netscope/FilterBar';
import { FollowStream, sideLabel } from '../src/netscope/FollowStream';
import { Statistics, indentFor } from '../src/netscope/Statistics';
import { CaptureControls, buildSpec, capturePointsOf } from '../src/netscope/CaptureControls';
import { NetScope, problemText, statusText } from '../src/netscope/NetScope';
import type { PagerState } from '../src/netscope/netscope-client';

const setState = (useStore as unknown as { setState(p: Record<string, unknown>): void }).setState;

const IFACE: CaptureInterface = { index: 0, name: 'PC1 Gi0', linkType: 'ethernet', fcsLen: 4 };

/** Ethernet + ARP request, padded and with a trailer, as the live tap records it. */
function arpFrame(n: number): Uint8Array {
  const b = new Uint8Array(64);
  b.set([0xff, 0xff, 0xff, 0xff, 0xff, 0xff], 0);
  b.set([0x02, 0x00, 0x00, 0x00, 0x00, n & 0xff], 6);
  b.set([0x08, 0x06], 12);
  b.set([0x00, 0x01, 0x08, 0x00, 6, 4, 0x00, 0x01], 14);
  b.set([0x02, 0x00, 0x00, 0x00, 0x00, n & 0xff], 22);
  b.set([192, 168, 1, n & 0xff], 28);
  b.set([192, 168, 1, 254], 38);
  return b;
}

function record(index: number): CaptureRecord {
  const bytes = arpFrame(index + 1);
  return { index, t: index * 1_000_000, iface: 0, dir: index % 2 === 0 ? 'tx' : 'rx', bytes, origLen: bytes.length };
}

function filledStore(count: number): CaptureStore {
  const store = createCaptureStore({ id: 'c_1', name: 'PC1 capture', source: 'live', interfaces: [IFACE] });
  for (let i = 0; i < count; i++) store.append(record(i));
  return store;
}

function pagerState(rows: readonly CaptureRow[], over: Partial<PagerState> = {}): PagerState {
  return { rows, from: 0, next: rows.length, done: true, full: false, scanned: rows.length, matched: rows.length, loading: false, depth: 0, revision: 1, ...over };
}

const render = (el: Parameters<typeof renderToStaticMarkup>[0]): string => renderToStaticMarkup(el);

/** Text content of markup (tags removed, entities decoded). */
function text(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;|&#160;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const rowsOf = (store: CaptureStore, limit = 50): CaptureRow[] => store.query({ from: 0, limit }).rows;

describe('packet list', () => {
  it('draws only the rows in view', () => {
    expect(visibleRange(0, 220, 1000)).toEqual({ start: 0, end: 16 });
    expect(visibleRange(NS_ROW_HEIGHT * 100, 220, 1000).start).toBe(94);
    expect(visibleRange(NS_ROW_HEIGHT * 990, 220, 1000).end).toBe(1000);
    expect(visibleRange(0, 220, 0)).toEqual({ start: 0, end: 0 });
    expect(visibleRange(-50, 220, 10).start).toBe(0);
  });

  it('moves the selection with the keys §16 asks for', () => {
    expect(movedPosition(-1, 'ArrowDown', 10, 5)).toBe(0);
    expect(movedPosition(-1, 'ArrowUp', 10, 5)).toBe(9);
    expect(movedPosition(3, 'ArrowDown', 10, 5)).toBe(4);
    expect(movedPosition(0, 'ArrowUp', 10, 5)).toBe(0);
    expect(movedPosition(9, 'ArrowDown', 10, 5)).toBe(9);
    expect(movedPosition(2, 'PageDown', 10, 5)).toBe(7);
    expect(movedPosition(9, 'PageUp', 10, 5)).toBe(4);
    expect(movedPosition(4, 'Home', 10, 5)).toBe(0);
    expect(movedPosition(4, 'End', 10, 5)).toBe(9);
    expect(movedPosition(4, 'a', 10, 5)).toBe(-1);
    expect(movedPosition(0, 'ArrowDown', 0, 5)).toBe(-1);
  });

  it('scrolls a row into view only when it is outside', () => {
    expect(scrollToRow(0, 0, 220)).toBeNull();
    expect(scrollToRow(2, 0, 220)).toBeNull();
    expect(scrollToRow(20, 0, 220)).toBe(20 * NS_ROW_HEIGHT + NS_ROW_HEIGHT - 220);
    expect(scrollToRow(1, 100, 220)).toBe(NS_ROW_HEIGHT);
  });

  it('renders a frame with its number, direction glyph, protocol letter and spoken summary', () => {
    const rows = rowsOf(filledStore(3));
    const html = render(
      createElement(PacketList, {
        rows,
        state: pagerState(rows),
        ifaceName: () => 'PC1 Gi0',
        selected: rows[1]!.index,
        onSelect: () => undefined,
        onOpen: () => undefined,
        onNeedMore: () => undefined,
        onNextWindow: () => undefined,
        onPrevWindow: () => undefined,
        emptyNote: 'nothing',
      }),
    );
    expect(html).toContain('aria-label="Frame 2 on PC1 Gi0, received, ');
    expect(html).toContain('id="ns-row-1"');
    expect(html).toContain('aria-activedescendant="ns-row-1"');
    expect(html).toContain('aria-selected="true"');
    expect(html).toContain('role="grid"');
    expect(html).toContain('tabindex="0"');
    const body = text(html);
    expect(body).toContain('→');
    expect(body).toContain('←');
    expect(body).toContain('ARP');
    expect(body).toContain('192.168.1.254');
  });

  it('keeps a long capture out of the DOM', () => {
    const rows = rowsOf(filledStore(600), 600);
    const html = render(
      createElement(PacketList, {
        rows,
        state: pagerState(rows, { done: false, full: true }),
        ifaceName: () => 'PC1 Gi0',
        selected: null,
        onSelect: () => undefined,
        onOpen: () => undefined,
        onNeedMore: () => undefined,
        onNextWindow: () => undefined,
        onPrevWindow: () => undefined,
        emptyNote: 'nothing',
      }),
    );
    const drawn = html.match(/id="ns-row-/g)?.length ?? 0;
    expect(drawn).toBeGreaterThan(0);
    expect(drawn).toBeLessThan(40);
    expect(html).toContain(`height:${rows.length * NS_ROW_HEIGHT}px`);
    expect(text(html)).toContain('window full');
  });

  it('shows the note instead of rows when nothing matched', () => {
    const html = render(
      createElement(PacketList, {
        rows: [],
        state: pagerState([]),
        ifaceName: () => 'x',
        selected: null,
        onSelect: () => undefined,
        onOpen: () => undefined,
        onNeedMore: () => undefined,
        onNextWindow: () => undefined,
        onPrevWindow: () => undefined,
        emptyNote: 'No frame in this capture matches the filter.',
      }),
    );
    expect(text(html)).toContain('No frame in this capture matches the filter.');
  });
});

describe('filter bar', () => {
  it('reports a parse error with its column and a caret, and offers completions', () => {
    const err = typingError('ip.addr ==');
    expect(err).toBeDefined();
    expect(typingError('')).toBeUndefined();
    expect(typingError('arp')).toBeUndefined();

    const html = render(
      createElement(FilterBar, { text: 'ip.addr ==', onText: () => undefined, onApply: () => undefined, status: '0 frames shown of 12 captured' }),
    );
    const body = text(html);
    expect(body).toContain(`Column ${err!.column + 1}:`);
    expect(body).toContain(err!.message);
    expect(body).toContain('^');
    expect(html).toContain('aria-invalid="true"');
    expect(html).toContain('role="combobox"');
    expect(body).toContain('0 frames shown of 12 captured');
  });

  it('names the engine when the error came back with the rows', () => {
    const html = render(
      createElement(FilterBar, {
        text: 'arp',
        onText: () => undefined,
        onApply: () => undefined,
        engineError: { message: 'Unknown field name.', column: 0, length: 3 },
      }),
    );
    expect(text(html)).toContain('Column 1: Unknown field name. (from the engine)');
  });

  it('offers the tcp.flags family and walks the highlight', () => {
    const c = suggestionsFor('tcp.fl', 6);
    expect(c).not.toBeNull();
    expect(c!.items.some((i) => i.label.startsWith('tcp.flags'))).toBe(true);
    expect(nextHighlight(-1, 1, 3)).toBe(0);
    expect(nextHighlight(-1, -1, 3)).toBe(2);
    expect(nextHighlight(2, 1, 3)).toBe(0);
    expect(nextHighlight(0, -1, 3)).toBe(2);
    expect(nextHighlight(0, 1, 0)).toBe(-1);
  });
});

describe('detail tree and hex pane', () => {
  it('decodes the selected frame and links its bytes', () => {
    const detail = filledStore(2).record(0)!;
    const html = render(
      createElement(DetailTree, {
        detail,
        selectedLayer: 0,
        onSelectLayer: () => undefined,
        hot: null,
        onHot: () => undefined,
        note: 'pick one',
      }),
    );
    const body = text(html);
    expect(body).toContain('Ethernet');
    expect(body).toContain('bytes 0–');
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain('tabindex="0"'); // fields are reachable from the keyboard
    expect(body).toContain('dst');

    expect(rangeOf(detail.layers, 0, null).selected).toEqual([detail.layers[0]!.offset, detail.layers[0]!.length]);
    const field = Object.keys(detail.layers[0]!.fieldRanges)[0]!;
    expect(rangeOf(detail.layers, 0, { layer: 0, field })).toMatchObject({ hot: detail.layers[0]!.fieldRanges[field] });
    expect(rangeOf(detail.layers, null, null)).toEqual({ selected: null, hot: null });
  });

  it('shows the note when nothing is selected', () => {
    expect(text(render(createElement(DetailTree, { detail: undefined, selectedLayer: null, onSelectLayer: () => undefined, hot: null, onHot: () => undefined, note: 'Select a frame to decode it.' })))).toContain(
      'Select a frame to decode it.',
    );
  });

  it('draws the bytes with the highlighted range named in words', () => {
    const detail = filledStore(1).record(0)!;
    const html = render(createElement(HexPane, { detail, selected: [0, 14], hot: null, note: 'none' }));
    const body = text(html);
    expect(body).toContain('bytes 0–13 (14 of 64)');
    expect(body).toContain('ff ff ff ff ff ff');
    expect(body).toContain('underlined = inside a layer');
    expect(rangeText(null, 64)).toBe('64 bytes in the frame');
    expect(rangeText([6, 6], 64)).toBe('bytes 6–11 (6 of 64)');
    expect(text(render(createElement(HexPane, { detail: undefined, selected: null, hot: null, note: 'Select a frame to see its bytes.' })))).toContain('Select a frame to see its bytes.');
  });

  // While the worker is fetching a frame the panes must not claim it was never selected, or is gone (§16).
  it('says the frame is on its way instead of contradicting the row that is selected', () => {
    const gone = 'That frame is no longer in the capture.';
    const tree = text(render(createElement(DetailTree, { detail: undefined, loading: true, selectedLayer: null, onSelectLayer: () => undefined, hot: null, onHot: () => undefined, note: gone })));
    expect(tree).toContain('Decoding the frame…');
    expect(tree).not.toContain(gone);
    const bytes = text(render(createElement(HexPane, { detail: undefined, loading: true, selected: null, hot: null, note: 'Select a frame to see its bytes.' })));
    expect(bytes).toContain('Reading the bytes…');
    expect(bytes).not.toContain('Select a frame');
  });
});

describe('statistics and follow stream', () => {
  it('writes every share as blocks and as a percentage', () => {
    const stats = filledStore(4).stats();
    const html = render(createElement(Statistics, { stats, filter: '', note: 'none', onClose: () => undefined }));
    const body = text(html);
    expect(body).toContain('4 frames');
    expect(body).toContain('Protocol hierarchy');
    expect(body).toContain('Ethernet');
    expect(body).toContain('100%');
    expect(body).toContain('▮');
    expect(body).toContain('Endpoints');
    expect(indentFor(0)).toBe('');
    expect(indentFor(1)).toBe('└─ ');
    expect(indentFor(2)).toBe('   └─ ');
  });

  it('names the filter that narrowed the numbers', () => {
    const stats = filledStore(2).stats();
    expect(text(render(createElement(Statistics, { stats, filter: 'arp', note: 'none', onClose: () => undefined })))).toContain('filtered by arp');
  });

  // A refused query must say so: the numbers of the capture before it would otherwise stand unchallenged.
  it('shows the engine refusal over the numbers instead of leaving them unexplained', () => {
    const html = render(createElement(Statistics, { stats: undefined, error: 'There is no capture "c_2".', filter: '', note: 'none', onClose: () => undefined }));
    expect(html).toContain('role="alert"');
    expect(text(html)).toContain('There is no capture "c_2".');
  });

  it('says a query is running rather than showing the note for an empty pane', () => {
    const counting = text(render(createElement(Statistics, { stats: undefined, loading: true, filter: '', note: 'none', onClose: () => undefined })));
    expect(counting).toContain('Counting the frames…');
    expect(counting).not.toContain('none');
  });

  it('labels each side of a stream and lists the HTTP messages', () => {
    const result: FollowStreamResult = {
      key: 'tcp:192.168.1.80:49152-192.168.1.1:80',
      proto: 'tcp',
      endpoints: ['192.168.1.80:49152', '192.168.1.1:80'],
      chunks: [
        { from: 0, index: 4, text: 'GET / HTTP/1.1\r\n\r\n', bytes: 18 },
        { from: 1, index: 6, text: 'HTTP/1.1 200 OK\r\n\r\nhello', bytes: 24 },
      ],
      retransmissions: 1,
      http: [
        { kind: 'request', startLine: 'GET / HTTP/1.1', headers: 'Host: www.lab.nf', body: '', index: 4 },
        { kind: 'response', startLine: 'HTTP/1.1 200 OK', headers: 'Content-Length: 5', body: 'hello', index: 6 },
      ],
    };
    const body = text(render(createElement(FollowStream, { result, note: 'none', onClose: () => undefined })));
    expect(body).toContain('A → B');
    expect(body).toContain('B → A');
    expect(body).toContain('GET / HTTP/1.1');
    expect(body).toContain('HTTP/1.1 200 OK');
    expect(body).toContain('1 repeated segment');
    expect(sideLabel(0, ['a', 'b'])).toContain('A → B');
    expect(sideLabel(1, ['a', 'b'])).toContain('B → A');
    expect(text(render(createElement(FollowStream, { result: undefined, note: 'Select a TCP or UDP frame.', onClose: () => undefined })))).toContain('Select a TCP or UDP frame.');
  });
});

describe('capture controls', () => {
  it('offers every real port as a capture point', () => {
    const sim = createSimulation({ seed: 3 });
    sim.addDevice({ id: 'pc1', type: 'pc.nfpc', name: 'PC1', position: { x: 0, y: 0 } });
    sim.addDevice({ id: 'sw1', type: 'switch.nfc2960', name: 'SW1', position: { x: 100, y: 0 } });
    const points = capturePointsOf(sim.snapshot());
    expect(points.length).toBeGreaterThan(0);
    expect(points[0]?.label.startsWith('PC1 ')).toBe(true);
    expect(points.every((p) => !p.key.includes('Console'))).toBe(true);
    expect(capturePointsOf(null)).toEqual([]);
  });

  it('builds the spec the form describes', () => {
    const point = { key: 'pc1/Gi0', label: 'PC1 Gi0', ref: { device: 'pc1', port: 'Gi0' } };
    expect(buildSpec(point, 'both', false, '')).toEqual({ ports: [point.ref], dir: 'both', includeBackground: false, name: 'PC1 Gi0' });
    expect(buildSpec(undefined, 'tx', true, ' Lab run ')).toEqual({ dir: 'tx', includeBackground: true, name: 'Lab run' });
    expect(buildSpec(undefined, 'rx', false, '').name).toBe('Every port');
  });

  it('marks live and imported captures with a letter and a word', () => {
    const captures: CaptureInfo[] = [
      { id: 'c_1', name: 'PC1 Gi0', source: 'live', running: true, interfaces: [IFACE], head: 12, oldest: 0, dropped: 0 },
      { id: 'i_1', name: 'from-class.pcapng', source: 'import', running: false, interfaces: [IFACE], head: 90, oldest: 0, dropped: 3 },
    ];
    const html = render(
      createElement(CaptureControls, {
        captures,
        activeId: 'c_1',
        points: [],
        onSelect: () => undefined,
        onStart: () => undefined,
        onStop: () => undefined,
        onRemove: () => undefined,
        onExport: () => undefined,
        onImport: () => undefined,
      }),
    );
    const body = text(html);
    expect(body).toContain('recording');
    expect(body).toContain('live capture');
    expect(body).toContain('from a file');
    expect(body).toContain('12 frames');
    expect(body).toContain('3 dropped from the start');
    expect(body).toContain('Every port (promiscuous)');
    expect(body).toContain('pcapng (every link type)');
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain('type="file"');
  });

  it('shows a refusal in the engine’s own words', () => {
    const html = render(
      createElement(CaptureControls, {
        captures: [],
        activeId: null,
        points: [],
        problem: 'This capture mixes link types; save it as pcapng instead.',
        onSelect: () => undefined,
        onStart: () => undefined,
        onStop: () => undefined,
        onRemove: () => undefined,
        onExport: () => undefined,
        onImport: () => undefined,
      }),
    );
    expect(text(html)).toContain('This capture mixes link types; save it as pcapng instead.');
    expect(html).toContain('role="alert"');
  });
});

describe('the NetScope panel', () => {
  it('opens on the capture controls while nothing is captured', () => {
    setState({ snapshot: null, epoch: 0 });
    const html = render(createElement(NetScope));
    const body = text(html);
    expect(html).toContain('aria-label="Display filter"');
    expect(body).toContain('Frames');
    expect(body).toContain('Follow stream');
    expect(body).toContain('Statistics');
    expect(body).toContain('No capture yet.');
    // The strip also holds the stream button and the follow checkbox, which a tablist may not contain, so
    // the four views are plain toggles in a group (§16).
    expect(html).toContain('role="group" aria-label="NetScope views"');
    expect(html).not.toContain('role="tab"');
    expect((html.match(/aria-pressed="/g) ?? []).length).toBe(4);
    // Each view button is addressable, so a pane that closes itself can hand focus back to the frames list.
    expect(html).toContain('id="ns-view-packets"');
  });

  it('lists the ports of the loaded topology as capture points', () => {
    const sim = createSimulation({ seed: 4 });
    sim.addDevice({ id: 'pc1', type: 'pc.nfpc', name: 'PC1', position: { x: 0, y: 0 } });
    setState({ snapshot: sim.snapshot(), epoch: 1 });
    const body = text(render(createElement(NetScope)));
    expect(body).toContain('PC1 ');
    expect(body).toContain('Start capture');
  });

  it('says what it is showing and what went wrong', () => {
    const info: CaptureInfo = { id: 'c_1', name: 'PC1', source: 'live', running: true, interfaces: [IFACE], head: 40, oldest: 0, dropped: 0 };
    const rows = rowsOf(filledStore(3));
    expect(statusText(pagerState(rows), info)).toBe('3 frames shown of 40 captured');
    expect(statusText(pagerState(rows, { error: { message: 'bad', column: 1, length: 1 } }), info)).toContain('the filter did not compile');
    expect(statusText(pagerState([]), undefined)).toBe('no capture selected');
    expect(problemText(new Error('No such capture.'))).toBe('No such capture.');
    expect(problemText(null)).toContain('refused');
  });
});
