/**
 * Worker delta batches (ARCHITECTURE-P1 §3.14 "Worker", §8.1 W6 web-shell, §12 item 24; protocol.ts header).
 *
 * The worker module is imported with Comlink mocked and wall timers faked. The pure pieces (dirty tracker, delta
 * assembly, clock policy) are tested directly.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InflightFrame, PduSummary, PortRef, TraceEvent } from '@netforge/engine';
import type { EngineApi, EngineBatch } from '../src/bridge/protocol';
import { createWorkerClock } from '../src/bridge/worker/clock';
import { createDirtyTracker, preferFullSnapshot, toDelta } from '../src/bridge/worker/delta';

let exposed: EngineApi | undefined;

vi.mock('comlink', () => ({
  expose: (api: EngineApi) => {
    exposed = api;
  },
  proxy: <T>(x: T) => x,
}));

const WORKER = '../src/bridge/worker/index.ts';
const SEC = 1_000_000_000;

async function freshWorker(opts: { maxEventsPerBatch?: number } = {}): Promise<{ api: EngineApi; batches: EngineBatch[] }> {
  vi.resetModules();
  exposed = undefined;
  await import(WORKER);
  const api = exposed as unknown as EngineApi;
  const batches: EngineBatch[] = [];
  await api.subscribe((b) => {
    batches.push(b);
  }, opts);
  await api.init({ seed: 7 });
  return { api, batches };
}

async function booted(scenario: string, opts: { maxEventsPerBatch?: number } = {}): Promise<{ api: EngineApi; batches: EngineBatch[] }> {
  const w = await freshWorker(opts);
  await w.api.loadScenario(scenario);
  await w.api.runToIdle();
  w.batches.length = 0;
  return w;
}

/** Add idle PCs so a handful of dirty devices stays under the 60 % full-snapshot threshold. */
async function pad(api: EngineApi, batches: EngineBatch[], n: number): Promise<void> {
  for (let i = 0; i < n; i++) await api.addDevice({ type: 'pc.nfpc', power: false, position: { x: 900 + i * 40, y: 900 } });
  batches.length = 0;
}

function last(batches: readonly EngineBatch[]): EngineBatch {
  const b = batches[batches.length - 1];
  if (b === undefined) throw new Error('no batch was posted');
  return b;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'performance'] });
});
afterEach(() => {
  vi.useRealTimers();
});

describe('worker: always-post rule while paused (§12 item 24)', () => {
  it('setDeviceUi and then setImpairments each post a batch; the first delta holds the device, the second the links', async () => {
    const { api, batches } = await booted('two-pcs-and-switch');
    await pad(api, batches, 3);

    await api.setDeviceUi('pc1', { note: 'bench A' });
    expect(batches).toHaveLength(1);
    const ui = last(batches);
    expect(ui.playing).toBe(false);
    expect(ui.snapshot).toBeUndefined();
    expect(ui.delta).toBeDefined();
    expect(ui.delta!.devices.map((d) => d.id)).toEqual(['pc1']);
    expect(ui.delta!.devices[0]!.ui).toEqual({ note: 'bench A' });
    expect(ui.delta!.links).toBeUndefined();

    await api.setImpairments('l_pc1_sw1', { lossPct: 10 });
    expect(batches).toHaveLength(2);
    const imp = last(batches);
    expect(imp.snapshot).toBeUndefined();
    expect(imp.delta).toBeDefined();
    expect(imp.delta!.links).toBeDefined();
    const link = imp.delta!.links!.find((l) => l.id === 'l_pc1_sw1');
    expect(link?.impairments.lossPct).toBe(10);
    expect(imp.delta!.devices.map((d) => d.id).sort()).toEqual(['pc1', 'sw1']);
  });

  it('renameDevice, moveDevice and setPower post deltas for the device', async () => {
    const { api, batches } = await booted('two-pcs-and-switch');
    await pad(api, batches, 3);

    await api.renameDevice('pc2', 'BenchPC');
    expect(last(batches).delta?.devices.find((d) => d.id === 'pc2')?.name).toBe('BenchPC');

    await api.moveDevice('pc2', { x: 612.4, y: 301.6 });
    const moved = last(batches);
    expect(moved.delta?.devices.find((d) => d.id === 'pc2')?.position).toEqual({ x: 612, y: 302 });
    expect(batches).toHaveLength(2);

    await api.setPower('pc2', false);
    const off = last(batches);
    expect(off.delta?.devices.find((d) => d.id === 'pc2')?.power).toBe(false);
    // Power-off takes the cable down: the delta carries the link list and the switch at the other end.
    expect(off.delta?.links?.find((l) => l.id === 'l_pc2_sw1')?.up).toBe(false);
    expect(off.delta?.devices.some((d) => d.id === 'sw1')).toBe(true);
    expect(batches).toHaveLength(3);
  });

  it('configure posts a delta whose device shows the new running-config', async () => {
    const { api, batches } = await booted('pc-router-pc');
    const result = await api.configure('r1', ['hostname EDGE']);
    expect(result.lines[0]?.ok).toBe(true);
    const b = last(batches);
    expect(b.snapshot).toBeUndefined();
    const r1 = b.delta?.devices.find((d) => d.id === 'r1');
    expect(r1?.runningConfig).toContain('hostname EDGE');
    expect(b.events.some((e) => e.kind === 'configChange')).toBe(true);
  });

  it('setCanvasScale marks the links and every radio device dirty', async () => {
    const { api, batches } = await booted('home-wifi');
    await pad(api, batches, 4);
    const before = await api.snapshot();
    const radios = before.devices.filter((d) => d.ports.some((p) => p.kind === 'wlan' || p.kind === 'radio' || p.kind === 'cellular')).map((d) => d.id);
    expect(radios.length).toBeGreaterThan(0);

    await api.setCanvasScale(0.5);
    const b = last(batches);
    expect(b.delta).toBeDefined();
    expect(b.delta!.links).toBeDefined();
    const ids = b.delta!.devices.map((d) => d.id);
    for (const id of radios) expect(ids).toContain(id);
    expect(b.delta!.media?.metresPerUnit).toBe(0.5);
  });

  it('structural calls post a full snapshot with the new topologyVersion', async () => {
    const { api, batches } = await booted('two-pcs-and-switch');
    const version = (await api.snapshot()).topologyVersion;

    const id = await api.addDevice({ type: 'router.nf1941', name: 'R9', power: false, position: { x: 50, y: 50 } });
    const added = last(batches);
    expect(added.snapshot?.topologyVersion).toBe(version + 1);
    expect(added.delta).toBeUndefined();

    const slot = added.snapshot!.devices.find((d) => d.id === id)?.slots?.[0]?.id;
    expect(slot).toBeDefined();
    const res = await api.insertModule(id, slot!, 'mod.ehwic-2t');
    expect(res.ok).toBe(true);
    expect(last(batches).snapshot?.topologyVersion).toBe(version + 2);

    const bad = await api.insertModule(id, slot!, 'mod.ehwic-2t');
    expect(bad.ok).toBe(false);
    expect(last(batches).snapshot).toBeDefined();
  });

  it('a mutation with nothing dirty still posts a batch', async () => {
    const { api, batches } = await booted('two-pcs-and-switch');
    await api.setWatchedDevices([]);
    const before = batches.length;
    await api.setDeviceUi('sw1', {});
    expect(batches.length).toBe(before + 1);
  });
});

describe('worker: failed loads', () => {
  it('a topology with an unknown device type rejects with problems and keeps the epoch and world', async () => {
    const { api, batches } = await booted('two-pcs-and-switch');
    await api.setDeviceUi('pc2', {});
    const epoch = last(batches).epoch;
    const good = await api.exportTopology();
    const bad = {
      ...good,
      devices: [...good.devices, { id: 'x1', type: 'nope.missing', name: 'X1', position: { logical: [10, 10] as [number, number] } }],
    };
    await expect(api.loadTopology(bad)).rejects.toMatchObject({ name: 'TopologyLoadError' });
    const snap = await api.snapshot();
    expect(snap.devices.map((d) => d.id)).toEqual(['pc1', 'sw1', 'pc2']);
    await api.setDeviceUi('pc1', {});
    const after = last(batches);
    expect(after.epoch).toBe(epoch);
    expect(after.delta).toBeDefined();
  });

  it('a successful load bumps the epoch and carries a full snapshot', async () => {
    const { api, batches } = await booted('two-pcs-and-switch');
    await api.setDeviceUi('pc1', {});
    const epoch = last(batches).epoch;
    await api.loadScenario('pc-router-pc');
    const b = last(batches);
    expect(b.epoch).toBe(epoch + 1);
    expect(b.snapshot).toBeDefined();
    expect(b.delta).toBeUndefined();
  });
});

describe('worker: playing cadence', () => {
  it('posts deltas while playing and a full snapshot at least every 2 s', async () => {
    const { api, batches } = await booted('two-pcs-and-switch');
    await api.setWatchedDevices(['pc1']);
    await api.setRate(1);
    await api.play();
    batches.length = 0;
    vi.advanceTimersByTime(4_100);
    const withDelta = batches.filter((b) => b.delta !== undefined);
    const withFull = batches.filter((b) => b.snapshot !== undefined);
    expect(withDelta.length).toBeGreaterThan(5);
    expect(withFull.length).toBeGreaterThanOrEqual(1);
    // A watched device is refreshed in every delta even without trace activity.
    for (const b of withDelta) expect(b.delta!.devices.some((d) => d.id === 'pc1')).toBe(true);
    for (const b of batches) expect(b.snapshot !== undefined && b.delta !== undefined).toBe(false);
    await api.pause();
  });

  it('caps the events of a batch and counts the rest', async () => {
    const { api, batches } = await booted('two-pcs-and-switch', { maxEventsPerBatch: 3 });
    const view = await api.cliOpen('pc1', 'console');
    batches.length = 0;
    await api.cliExec(view.id, 'ping 10.0.0.2');
    await api.runToIdle();
    const capped = batches.filter((b) => (b.eventsTruncated ?? 0) > 0);
    expect(capped.length).toBeGreaterThan(0);
    for (const b of batches) expect(b.events.length).toBeLessThanOrEqual(3);
  });
});

// ── pure pieces ──────────────────────────────────────────────────────────────

const ref = (device: string, port = 'p0'): PortRef => ({ device, port });
const pdu = (id: number): PduSummary => ({ id, size: 64, proto: 'ethernet', summary: 'x' }) as unknown as PduSummary;

describe('dirty tracker', () => {
  const ends = (link: string): readonly [string, string] | undefined => (link === 'l1' ? ['a', 'b'] : undefined);

  it('marks devices from the device fields of events', () => {
    const d = createDirtyTracker(ends);
    const evs = [
      { t: 1, kind: 'frameTx', pdu: pdu(1), link: 'l1', from: ref('a'), to: ref('b'), txStart: 1, txEnd: 2, arrive: 3 },
      { t: 1, kind: 'tableWrite', device: 'c', table: 'arp', key: 'k', row: {} },
      { t: 1, kind: 'assocState', tech: 'wifi', medium: 'air:1', station: ref('sta'), ap: ref('ap'), state: 'associated', prev: 'handshake' },
      { t: 1, kind: 'backoff', device: 'e', port: 'p0', pdu: 1, attempt: 1, slots: 2, until: 5 },
      { t: 1, kind: 'topologyChanged', what: 'device', id: 'm', op: 'move' },
      { t: 1, kind: 'cliOutput', session: 's_1', text: 'x' },
    ] as unknown as TraceEvent[];
    for (const ev of evs) d.observe(ev);
    expect(d.devices()).toEqual(['a', 'b', 'c', 'sta', 'ap', 'e', 'm']);
    expect(d.linksDirty).toBe(false);
  });

  it('link-level events mark links changed plus the devices involved', () => {
    const d = createDirtyTracker(ends);
    d.observe({ t: 1, kind: 'linkState', link: 'l1', up: false } as TraceEvent);
    expect(d.linksDirty).toBe(true);
    expect(d.devices()).toEqual(['a', 'b']);
    d.clear();
    expect(d.empty).toBe(true);

    d.observe({ t: 1, kind: 'rfState', port: ref('x'), peer: ref('y'), rssiDbm: -60, snrDb: 30, rateBps: 1, bars: 3 } as TraceEvent);
    expect(d.linksDirty).toBe(true);
    expect(d.devices()).toEqual(['x', 'y']);
    d.clear();

    d.observe({ t: 1, kind: 'segmentChanged', segment: 'seg:l1', members: [ref('h'), ref('s1'), ref('s2')], op: 'formed' } as TraceEvent);
    expect(d.linksDirty).toBe(true);
    expect(d.devices()).toEqual(['h', 's1', 's2']);
    d.clear();

    d.observe({ t: 1, kind: 'collision', segment: 'seg:l1', stations: [ref('s1'), ref('s2')], pdus: [1, 2], detectAt: 1, jamUntil: 2, late: false } as TraceEvent);
    expect(d.linksDirty).toBe(false);
    expect(d.devices()).toEqual(['s1', 's2']);
  });

  it('adds watched devices after the dirty ones, without duplicates', () => {
    const d = createDirtyTracker(ends);
    d.markDevices(['b', 'a']);
    expect(d.devices(['a', 'z'])).toEqual(['b', 'a', 'z']);
  });

  it('prefers a full snapshot above 60 % dirty and keeps links only when changed', () => {
    expect(preferFullSnapshot(6, 10)).toBe(false);
    expect(preferFullSnapshot(7, 10)).toBe(true);
    expect(preferFullSnapshot(0, 0)).toBe(false);
    const subset = { now: 1, seed: 1, topologyVersion: 3, devices: [], links: [], inflight: [], sessions: [], pduCount: 0, pendingEvents: 0 };
    expect('links' in toDelta(subset, false)).toBe(false);
    expect(toDelta(subset, true).links).toEqual([]);
  });
});

describe('worker clock policy', () => {
  const frame = (id: number, background: boolean, arrive = 1_000): TraceEvent =>
    ({ t: 0, kind: 'frameTx', pdu: pdu(id), link: 'l1', from: ref('a'), to: ref('b'), txStart: 0, txEnd: 500, arrive, background }) as unknown as TraceEvent;

  const fakeSim = () => {
    let now = 0;
    return {
      get now() {
        return now;
      },
      nextEventTime: () => undefined,
      runUntil: (t: number) => {
        now = Math.max(now, t);
        return { events: 0, from: now, to: now };
      },
    };
  };

  it('background frames never clamp while ignoreBackground is set', () => {
    const clock = createWorkerClock({ minTransitWallMs: 400 });
    clock.setPlaying(true);
    clock.observe(frame(1, true));
    expect(clock.clampingFlights).toBe(0);
    expect(clock.currentRate(0)).toBe(1_000_000);
    clock.setPolicy({ ignoreBackground: false });
    expect(clock.clampingFlights).toBe(1);
    expect(clock.currentRate(0)).toBe(1_000 / 400);
  });

  it('background frames clamp the clock when ignoreBackground is off (View > Background frames)', () => {
    const clock = createWorkerClock({ minTransitWallMs: 400 });
    clock.setPlaying(true);
    const rate = clock.rate;
    clock.setPolicy({ ignoreBackground: false });
    clock.observe(frame(5, true));
    expect(clock.clampingFlights).toBe(1);
    expect(clock.currentRate(0)).toBeLessThan(rate * 1_000_000);
    expect(clock.currentRate(0)).toBe(1_000 / 400);
  });

  it('a foreground frame slows the slice to the transit floor and stops at its arrival', () => {
    const clock = createWorkerClock({ minTransitWallMs: 400 });
    clock.setPlaying(true);
    clock.observe(frame(2, false));
    const sim = fakeSim();
    const advanced = clock.runSlice(sim, 100);
    expect(advanced).toBe(250);
    expect(clock.clampingFlights).toBe(1);
  });

  it('frameAbort shortens a leg and resync keys legs by (pdu, link, to)', () => {
    const clock = createWorkerClock({ minTransitWallMs: 400 });
    clock.observe(frame(3, false, 10_000));
    clock.observe({ t: 0, kind: 'frameAbort', pdu: pdu(3), link: 'l1', from: ref('a'), to: ref('b'), abortAt: 200, arrive: 10_000, reason: 'collision' } as unknown as TraceEvent);
    clock.prune(200);
    expect(clock.clampingFlights).toBe(0);

    const legs = [ref('b'), ref('c')].map(
      (to): InflightFrame => ({ pdu: pdu(4), link: 'seg:l1', from: ref('a'), to, txStart: 0, txEnd: 10, arrive: 50 }),
    );
    clock.resync(legs);
    expect(clock.clampingFlights).toBe(2);
  });

  it('rejects invalid policies and rates', () => {
    const clock = createWorkerClock();
    expect(clock.policy).toEqual({ minTransitWallMs: 400, ignoreBackground: true });
    expect(() => clock.setPolicy({ minTransitWallMs: -1 })).toThrow(RangeError);
    expect(() => clock.setRate(0)).toThrow(RangeError);
  });
});

describe('protocol constants', () => {
  it('pins the cadence', async () => {
    const p = await import('../src/bridge/protocol');
    expect(p.SNAPSHOT_EVERY_MS).toBe(250);
    expect(p.FULL_SNAPSHOT_EVERY_MS).toBe(2000);
    expect(p.MAX_EVENTS_PER_BATCH).toBe(20_000);
    expect(SEC).toBe(1e9);
  });
});
