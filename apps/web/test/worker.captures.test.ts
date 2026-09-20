/**
 * Capture calls across the bridge (ARCHITECTURE-P1 §4.12, §8.2 W7 web-shell; protocol.ts capture section).
 *
 * What this file guards is the WIRING, not the analyser (the engine's own capture tests own that): every call
 * round-trips as structured-clone-safe data, live and imported captures answer the same calls through one id
 * space, heads that advance reach the UI on a batch, and an imported capture outlives the world a live one dies
 * with.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PCAPNG_SHB_TYPE } from '@netforge/engine';
import type { EngineApi, EngineBatch } from '../src/bridge/protocol';
import { IMPORT_ID_PREFIX, isImportedCaptureId } from '../src/bridge/worker/captures';

let exposed: EngineApi | undefined;

vi.mock('comlink', () => ({
  expose: (api: EngineApi) => {
    exposed = api;
  },
  proxy: <T>(x: T) => x,
  transfer: <T>(x: T) => x,
}));

const WORKER = '../src/bridge/worker/index.ts';

async function booted(scenario: string): Promise<{ api: EngineApi; batches: EngineBatch[] }> {
  vi.resetModules();
  exposed = undefined;
  await import(WORKER);
  const api = exposed as unknown as EngineApi;
  const batches: EngineBatch[] = [];
  await api.subscribe((b) => {
    batches.push(b);
  });
  await api.init({ seed: 7 });
  await api.loadScenario(scenario);
  await api.runToIdle();
  batches.length = 0;
  return { api, batches };
}

/** Ping PC1 → PC2 and let it finish, so the capture holds ARP and ICMP frames. */
async function traffic(api: EngineApi): Promise<void> {
  const view = await api.cliOpen('pc1', 'console');
  await api.cliExec(view.id, 'ping 10.0.0.2');
  await api.runToIdle();
}

const magicOf = (bytes: Uint8Array): number => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0, true);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'performance'] });
});
afterEach(() => {
  vi.useRealTimers();
});

describe('capture ids', () => {
  it('tells an imported capture from a live one by its id', () => {
    expect(IMPORT_ID_PREFIX).toBe('i_');
    expect(isImportedCaptureId('i_1')).toBe(true);
    expect(isImportedCaptureId('c_1')).toBe(false);
  });
});

describe('worker: live captures', () => {
  it('starts, records and lists a capture of the whole lab', async () => {
    const { api, batches } = await booted('two-pcs-and-switch');
    const info = await api.startCapture({});
    expect(info.id.startsWith('c_')).toBe(true);
    expect(info.source).toBe('live');
    expect(info.running).toBe(true);
    expect(info.interfaces.length).toBeGreaterThan(0);
    expect(batches.length).toBeGreaterThan(0);

    await traffic(api);
    const listed = (await api.captures()).find((c) => c.id === info.id);
    expect(listed?.head).toBeGreaterThan(0);
    expect(await api.listCaptures()).toEqual(await api.captures());
  });

  it('reports the heads that advanced on a batch, so the UI repages only what moved', async () => {
    const { api, batches } = await booted('two-pcs-and-switch');
    const info = await api.startCapture({});
    batches.length = 0;

    await traffic(api);
    const heads = batches.flatMap((b) => (b.captureHeads === undefined ? [] : [b.captureHeads]));
    expect(heads.length).toBeGreaterThan(0);
    const highest = Math.max(...heads.map((h) => h[info.id] ?? 0));
    expect(highest).toBeGreaterThan(0);
  });

  it('answers rows, one record and statistics over the same id', async () => {
    const { api } = await booted('two-pcs-and-switch');
    const { id } = await api.startCapture({});
    await traffic(api);

    const page = await api.queryCapture(id, { from: 0, limit: 5 });
    expect(page.rows.length).toBeGreaterThan(0);
    expect(page.rows.length).toBeLessThanOrEqual(5);
    expect(page.matched).toBeGreaterThan(0);
    const first = page.rows[0]!;
    expect(first.layers.length).toBeGreaterThan(0);
    expect(first.info.length).toBeGreaterThan(0);

    const detail = await api.captureRecord(id, first.index);
    expect(detail?.bytes.length).toBe(first.len);
    expect(detail?.layers.length).toBeGreaterThan(0);
    expect(await api.captureRecord(id, 1_000_000)).toBeUndefined();

    const stats = await api.captureStats(id);
    expect(stats.total).toBeGreaterThan(0);
    expect(stats.hierarchy.some((h) => h.path.startsWith('ethernet'))).toBe(true);

    // A filter that matches nothing still answers, with a page of no rows.
    const empty = await api.queryCapture(id, { from: 0, limit: 5, filter: 'tcp' });
    expect(empty.rows).toEqual([]);
  });

  it('reports a filter the user mistyped instead of throwing', async () => {
    const { api } = await booted('two-pcs-and-switch');
    const { id } = await api.startCapture({});
    await traffic(api);

    const bad = await api.queryCapture(id, { from: 0, limit: 5, filter: 'ip.addr ===' });
    expect(bad.filterError).toBeDefined();
    expect(bad.filterError!.message.length).toBeGreaterThan(0);
    expect(bad.rows).toEqual([]);
  });

  it('stops and removes a capture', async () => {
    const { api } = await booted('two-pcs-and-switch');
    const { id } = await api.startCapture({});

    await api.stopCapture(id);
    expect((await api.captures()).find((c) => c.id === id)?.running).toBe(false);

    await api.removeCapture(id);
    expect((await api.captures()).some((c) => c.id === id)).toBe(false);
    await expect(api.queryCapture(id, { from: 0, limit: 1 })).rejects.toThrow();
  });
});

describe('worker: export and import', () => {
  it('exports pcapng bytes the UI can save, and reads them back as an imported capture', async () => {
    const { api, batches } = await booted('two-pcs-and-switch');
    const { id } = await api.startCapture({});
    await traffic(api);
    const live = (await api.captures()).find((c) => c.id === id)!;

    const bytes = await api.exportCapture(id, { format: 'pcapng', baseWallNs: 0n });
    expect(bytes.length).toBeGreaterThan(0);
    expect(magicOf(bytes)).toBe(PCAPNG_SHB_TYPE);

    batches.length = 0;
    const imported = await api.importCapture(bytes, 'bench.pcapng');
    expect(isImportedCaptureId(imported.id)).toBe(true);
    expect(imported.source).toBe('import');
    expect(imported.name).toBe('bench.pcapng');
    expect(imported.head).toBe(live.head);
    expect(batches.length).toBeGreaterThan(0);

    // The same analyser answers for both, so the rows agree except for the live PDU links.
    const liveRows = (await api.queryCapture(id, { from: 0, limit: 10 })).rows;
    const fileRows = (await api.queryCapture(imported.id, { from: 0, limit: 10 })).rows;
    expect(fileRows.map((r) => [r.index, r.t, r.len, r.proto, r.info])).toEqual(liveRows.map((r) => [r.index, r.t, r.len, r.proto, r.info]));
  });

  it('exports the same bytes every time for the same base time', async () => {
    const { api } = await booted('two-pcs-and-switch');
    const { id } = await api.startCapture({});
    await traffic(api);

    const a = await api.exportCapture(id, { format: 'pcapng', baseWallNs: 0n });
    const b = await api.exportCapture(id, { format: 'pcapng', baseWallNs: 0n });
    expect([...b]).toEqual([...a]);
  });

  it('refuses a file that is not a capture, with wording the UI can show', async () => {
    const { api } = await booted('two-pcs-and-switch');
    await expect(api.importCapture(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]), 'notes.txt')).rejects.toThrow(/capture|file/i);
  });

  it('an imported capture outlives the world a live one dies with', async () => {
    const { api } = await booted('two-pcs-and-switch');
    const { id } = await api.startCapture({});
    await traffic(api);
    const bytes = await api.exportCapture(id, { format: 'pcapng', baseWallNs: 0n });
    const imported = await api.importCapture(bytes, 'kept.pcapng');

    await api.reset(3);

    const after = await api.captures();
    expect(after.map((c) => c.id)).toEqual([imported.id]);
    expect((await api.queryCapture(imported.id, { from: 0, limit: 3 })).rows.length).toBeGreaterThan(0);

    await api.removeCapture(imported.id);
    expect(await api.captures()).toEqual([]);
  });
});
