// NetScope paging/caching client (ARCHITECTURE-P1 §4.12, §7 "NetScope", §10.2 "Web P1" netscope-client):
// the pager, the decoded-record cache, the bridge adapter and the pure text helpers, driven over a REAL engine
// capture store (createCaptureStore) filled with hand-built Ethernet/ARP frames, so the row, filter, statistics
// and export shapes are the engine's own.
import { describe, expect, it, vi } from 'vitest';
import { CAPTURE_QUERY_SCAN_BUDGET, createCaptureStore, readCapture } from '@netforge/engine';
import type { CaptureInterface, CaptureRecord, CaptureStore } from '@netforge/engine';
import {
  NETSCOPE_NO_API,
  applyCompletion,
  captureFileName,
  captureIdOf,
  capturePortOf,
  caretLine,
  createDetailCache,
  createRowPager,
  describeFilterError,
  directionOf,
  hierarchyTree,
  rowSummary,
  runningBadge,
  shareBar,
  type CapturePort,
} from '../src/netscope/netscope-client';

const IFACE: CaptureInterface = { index: 0, name: 'PC1 Gi0', linkType: 'ethernet', fcsLen: 4 };

/** Ethernet + ARP request frame, padded to 60 bytes with a 4-byte trailer, as the live tap records it. */
function arpFrame(n: number): Uint8Array {
  const b = new Uint8Array(64);
  b.set([0xff, 0xff, 0xff, 0xff, 0xff, 0xff], 0); // broadcast destination
  b.set([0x02, 0x00, 0x00, 0x00, 0x00, n & 0xff], 6); // sender MAC, one per frame
  b.set([0x08, 0x06], 12); // ethertype ARP
  b.set([0x00, 0x01, 0x08, 0x00, 6, 4, 0x00, 0x01], 14); // ethernet/ipv4, request
  b.set([0x02, 0x00, 0x00, 0x00, 0x00, n & 0xff], 22); // sender hardware address
  b.set([192, 168, 1, n & 0xff], 28); // sender protocol address
  b.set([192, 168, 1, 254], 38); // target protocol address
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

/** The capture half of the bridge, backed by one store (every call async, like the worker). */
function portOf(store: CaptureStore, spy?: { records: number }): CapturePort {
  return {
    startCapture: async () => 'c_1',
    stopCapture: async () => undefined,
    removeCapture: async () => undefined,
    captures: async () => [store.info()],
    queryCapture: async (_id, q) => store.query(q),
    captureRecord: async (_id, index) => {
      if (spy) spy.records++;
      return store.record(index);
    },
    followStream: async (_id, key) => store.follow(key),
    captureStats: async (_id, filter) => store.stats(filter),
    exportCapture: async (_id, opts) => store.export(opts),
    importCapture: async () => 'i_1',
  };
}

describe('netscope row pager', () => {
  it('pages one window at a time and walks forward and back', async () => {
    const store = filledStore(60);
    const pager = createRowPager(portOf(store), 'c_1', { pageSize: 10, maxRows: 25 });

    let s = await pager.fill();
    expect(s.rows).toHaveLength(25);
    expect(s.rows[0]?.index).toBe(0);
    expect(s.rows[0]?.proto).toBe('arp');
    expect(s.full).toBe(true);
    expect(s.done).toBe(false);
    expect(s.depth).toBe(0);
    expect(s.loading).toBe(false);

    s = await pager.nextWindow();
    expect(s.rows[0]?.index).toBe(25);
    expect(s.rows).toHaveLength(25);
    expect(s.depth).toBe(1);

    s = await pager.nextWindow();
    expect(s.rows[0]?.index).toBe(50);
    expect(s.rows).toHaveLength(10);
    expect(s.done).toBe(true);
    expect(s.full).toBe(false);
    expect(s.depth).toBe(2);

    // The end of the capture has no window after it.
    s = await pager.nextWindow();
    expect(s.rows[0]?.index).toBe(50);
    expect(s.depth).toBe(2);

    s = await pager.prevWindow();
    expect(s.rows[0]?.index).toBe(25);
    expect(s.depth).toBe(1);

    s = await pager.jumpTo(58);
    expect(s.rows.map((r) => r.index)).toEqual([58, 59]);
    expect(s.depth).toBe(0);
    expect(s.done).toBe(true);
  });

  it('never holds more than its window and keeps the engine cursor', async () => {
    const store = filledStore(400);
    const pager = createRowPager(portOf(store), 'c_1', { pageSize: 50, maxRows: 100 });
    const s = await pager.fill();
    expect(s.rows).toHaveLength(100);
    expect(s.next).toBe(100);
    expect(s.scanned).toBe(100);
    expect(s.matched).toBe(100);
    expect(store.info().head).toBe(400);
  });

  it('applies a display filter and restarts at the first record', async () => {
    const store = filledStore(30);
    const pager = createRowPager(portOf(store), 'c_1', { pageSize: 10, maxRows: 50 });
    await pager.fill();

    let s = await pager.setFilter('eth.src == 02:00:00:00:00:05');
    expect(s.rows.map((r) => r.index)).toEqual([4]);
    expect(pager.filter).toBe('eth.src == 02:00:00:00:00:05');
    expect(s.error).toBeUndefined();

    s = await pager.setFilter('arp');
    expect(s.rows).toHaveLength(30);

    s = await pager.setFilter('frame.number > 28');
    expect(s.rows.map((r) => r.index)).toEqual([28, 29]);

    s = await pager.setFilter('');
    expect(s.rows).toHaveLength(30);
  });

  it('reports an invalid filter with its column instead of swallowing it', async () => {
    const store = filledStore(5);
    const pager = createRowPager(portOf(store), 'c_1', {});
    const s = await pager.setFilter('ip.addr ==');
    expect(s.rows).toHaveLength(0);
    expect(s.error).toBeDefined();
    expect(s.error?.column).toBeGreaterThanOrEqual(0);
    expect(describeFilterError(s.error!)).toBe(`Column ${s.error!.column + 1}: ${s.error!.message}`);
    expect(caretLine(s.error!).trimEnd().endsWith('^')).toBe(true);
    expect(caretLine(s.error!).indexOf('^')).toBe(s.error!.column);
    // A good filter clears it.
    const ok = await pager.setFilter('arp');
    expect(ok.error).toBeUndefined();
    expect(ok.rows).toHaveLength(5);
  });

  it('refreshes the open window when a live capture grows', async () => {
    const store = filledStore(4);
    const pager = createRowPager(portOf(store), 'c_1', { pageSize: 10, maxRows: 10 });
    let s = await pager.fill();
    expect(s.rows).toHaveLength(4);
    expect(s.done).toBe(true);
    for (let i = 4; i < 8; i++) store.append(record(i));
    s = await pager.refresh();
    expect(s.rows).toHaveLength(8);
    expect(s.rows[7]?.index).toBe(7);
  });

  // Following a live capture runs on every batch the worker posts, so it must add the tail rather than
  // re-fetch the window the reader already has.
  it('follows a growing capture by appending only what is new', async () => {
    const store = filledStore(4);
    const calls = { n: 0 };
    const base = portOf(store);
    const port: CapturePort = {
      ...base,
      queryCapture: async (id, q) => {
        calls.n++;
        return base.queryCapture(id, q);
      },
    };
    const pager = createRowPager(port, 'c_1', { pageSize: 10, maxRows: 10 });
    let s = await pager.fill();
    expect(s.rows).toHaveLength(4);
    expect(s.done).toBe(true);
    const afterFill = calls.n;

    for (let i = 4; i < 8; i++) store.append(record(i));
    s = await pager.follow();
    expect(s.rows.map((r) => r.index)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    // The scan resumed at the engine's cursor: the four rows already held were not asked for again.
    expect(calls.n - afterFill).toBeLessThanOrEqual(2);
    const scannedTail = s.scanned;
    // Nothing new: following again adds nothing and leaves the window where it is.
    s = await pager.follow();
    expect(s.rows).toHaveLength(8);
    expect(s.scanned).toBeGreaterThanOrEqual(scannedTail);
  });

  it('serialises overlapping calls so one window is never interleaved', async () => {
    const store = filledStore(40);
    const pager = createRowPager(portOf(store), 'c_1', { pageSize: 5, maxRows: 40 });
    const [a, b] = await Promise.all([pager.fill(), pager.setFilter('frame.number <= 3')]);
    expect(a.rows.length).toBeGreaterThan(0);
    expect(b.rows.map((r) => r.index)).toEqual([0, 1, 2]);
    expect(pager.state().rows.map((r) => r.index)).toEqual([0, 1, 2]);
  });

  it('knows the engine scan budget it pages against', () => {
    expect(CAPTURE_QUERY_SCAN_BUDGET).toBeGreaterThan(0);
  });
});

describe('netscope detail cache', () => {
  it('fetches a record once, keeps the newest and forgets the oldest', async () => {
    const spy = { records: 0 };
    const store = filledStore(10);
    const cache = createDetailCache(portOf(store, spy), 3);

    const first = await cache.get('c_1', 0);
    expect(first?.row.index).toBe(0);
    expect(first?.bytes.length).toBe(64);
    expect(first?.layers.map((l) => l.proto)).toContain('arp');
    await cache.get('c_1', 0);
    expect(spy.records).toBe(1);
    expect(cache.peek('c_1', 0)?.row.index).toBe(0);

    for (const i of [1, 2, 3]) await cache.get('c_1', i);
    expect(cache.size()).toBe(3);
    expect(cache.peek('c_1', 0)).toBeUndefined();

    cache.clear('c_1');
    expect(cache.size()).toBe(0);
    expect(await cache.get('c_1', 99)).toBeUndefined();
  });

  // Live ids restart at c_1 with every new world, so a decode must never survive the generation that made it.
  it('drops every decode when it is cleared without an id, and fetches again afterwards', async () => {
    const spy = { records: 0 };
    const cache = createDetailCache(portOf(filledStore(4), spy));
    await cache.get('c_1', 0);
    expect(spy.records).toBe(1);
    cache.clear();
    expect(cache.size()).toBe(0);
    expect(cache.peek('c_1', 0)).toBeUndefined();
    await cache.get('c_1', 0);
    expect(spy.records).toBe(2);
  });

  it('shares one flight between callers asking at the same moment', async () => {
    const spy = { records: 0 };
    const cache = createDetailCache(portOf(filledStore(4), spy));
    const [a, b] = await Promise.all([cache.get('c_1', 2), cache.get('c_1', 2)]);
    expect(a?.row.index).toBe(2);
    expect(b).toBe(a);
    expect(spy.records).toBe(1);
  });
});

describe('netscope bridge adapter', () => {
  it('normalises the id a start or import returns', () => {
    expect(captureIdOf('c_7')).toBe('c_7');
    expect(captureIdOf({ id: 'i_2', name: 'file' })).toBe('i_2');
    expect(() => captureIdOf(undefined)).toThrow();
  });

  it('accepts either spelling of the capture list and remembers the winner', async () => {
    const listCaptures = vi.fn(async () => [{ id: 'c_1' }]);
    const api = { listCaptures };
    const port = capturePortOf(api);
    expect(await port.captures()).toEqual([{ id: 'c_1' }]);
    expect(await port.captures()).toEqual([{ id: 'c_1' }]);
    expect(listCaptures).toHaveBeenCalledTimes(2);

    const captures = vi.fn(async () => []);
    expect(await capturePortOf({ captures, listCaptures }).captures()).toEqual([]);
    expect(captures).toHaveBeenCalledTimes(1);
  });

  it('says so in plain words when this build has no capture methods', async () => {
    const port = capturePortOf({});
    await expect(port.captures()).rejects.toThrow(NETSCOPE_NO_API);
    await expect(port.queryCapture('c_1', { from: 0, limit: 10 })).rejects.toThrow(NETSCOPE_NO_API);
    await expect(capturePortOf(null).startCapture({})).rejects.toThrow(NETSCOPE_NO_API);
  });

  it('carries a real query, follow, statistics and export through the port', async () => {
    const store = filledStore(6);
    const port = portOf(store);
    const res = await port.queryCapture('c_1', { from: 0, limit: 3 });
    expect(res.rows).toHaveLength(3);
    const stats = await port.captureStats('c_1');
    expect(stats.total).toBe(6);
    expect(stats.hierarchy.some((h) => h.path.startsWith('ethernet'))).toBe(true);
    const bytes = await port.exportCapture('c_1', { format: 'pcapng' });
    const back = readCapture(bytes);
    expect(back.records).toHaveLength(6);
    expect(back.interfaces[0]?.linkType).toBe('ethernet');
  });
});

describe('netscope presentation helpers', () => {
  it('indents the protocol hierarchy and doubles every share with text', () => {
    const nodes = hierarchyTree({
      total: 10,
      hierarchy: [
        { path: 'ethernet', frames: 10, bytes: 640 },
        { path: 'ethernet/ipv4', frames: 6, bytes: 400 },
        { path: 'ethernet/ipv4/tcp', frames: 4, bytes: 300 },
      ],
    });
    expect(nodes.map((n) => [n.label, n.depth])).toEqual([
      ['ethernet', 0],
      ['ipv4', 1],
      ['tcp', 2],
    ]);
    expect(nodes[1]?.share).toBeCloseTo(0.6);
    expect(hierarchyTree({ total: 0, hierarchy: [{ path: 'ethernet', frames: 0, bytes: 0 }] })[0]?.share).toBe(0);

    const bar = shareBar(0.6, 10);
    expect(bar.bar).toBe('▮▮▮▮▮▮▯▯▯▯');
    expect(bar.text).toBe('60%');
    expect(shareBar(0, 4).bar).toBe('▯▯▯▯');
    expect(shareBar(1, 4).bar).toBe('▮▮▮▮');
    expect(shareBar(0.012, 10).text).toBe('1.2%');
  });

  it('reads a row aloud with direction, addresses and damage', async () => {
    const store = filledStore(2);
    const rows = (await portOf(store).queryCapture('c_1', { from: 0, limit: 2 })).rows;
    const text = rowSummary(rows[0]!, 'PC1 Gi0');
    expect(text).toContain('Frame 1');
    expect(text).toContain('on PC1 Gi0');
    expect(text).toContain('sent');
    expect(rowSummary({ ...rows[1]!, corrupted: true })).toContain('damaged on the wire');
    expect(directionOf('tx')).toEqual({ glyph: '→', text: 'sent' });
    expect(directionOf('rx').text).toBe('received');
    expect(directionOf('unknown').text).toBe('direction unknown');
  });

  it('completes filter text in place', () => {
    expect(applyCompletion('tcp.fl', { from: 0, to: 6 }, 'tcp.flags')).toEqual({ text: 'tcp.flags', cursor: 9 });
    expect(applyCompletion('arp && tcp.fl', { from: 7, to: 13 }, 'tcp.flags.syn')).toEqual({ text: 'arp && tcp.flags.syn', cursor: 20 });
    expect(applyCompletion('', { from: 0, to: 0 }, 'ip.addr')).toEqual({ text: 'ip.addr', cursor: 7 });
    expect(applyCompletion('abc', { from: 9, to: 20 }, 'x')).toEqual({ text: 'abcx', cursor: 4 });
  });

  it('names the saved file after the capture and marks live or imported without colour', () => {
    expect(captureFileName({ id: 'c_1', name: 'PC1 Gi0 browse' }, 'pcapng')).toBe('PC1-Gi0-browse.pcapng');
    expect(captureFileName({ id: 'c_2', name: '' }, 'pcap')).toBe('c_2.pcap');
    expect(captureFileName({ id: 'c_3', name: '///' }, 'pcap')).toBe('capture.pcap');
    expect(runningBadge({ running: true, source: 'live' })).toEqual({ glyph: '●', text: 'recording' });
    expect(runningBadge({ running: false, source: 'live' }).text).toBe('stopped');
    expect(runningBadge({ running: false, source: 'import' }).text).toBe('file');
  });
});
