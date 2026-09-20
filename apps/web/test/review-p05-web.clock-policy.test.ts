/**
 * Review regression test for apps/web/src/bridge/client.ts: the View menu's "Background frames" overlay must reach the
 * worker clock (ClockPolicy.ignoreBackground = !backgroundFrames), once after init and on every toggle.
 */
import { beforeAll, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({
  subscribe: vi.fn(async () => undefined),
  init: vi.fn(async () => ({ catalog: [], modules: [], media: [] })),
  setClockPolicy: vi.fn(async () => undefined),
  setWatchedDevices: vi.fn(async () => undefined),
  snapshot: vi.fn(async () => undefined),
}));

vi.mock('comlink', () => ({
  wrap: () => api,
  proxy: <T>(v: T) => v,
}));

import { store } from '../src/store/store';
import { initEngine } from '../src/bridge/client';

class FakeWorker {
  addEventListener(): void {}
}

describe('client clock policy wiring', () => {
  beforeAll(() => {
    vi.stubGlobal('Worker', FakeWorker);
    // A persisted "on" value must be sent after init.
    store.getState().setOverlay('backgroundFrames', true);
  });

  it('sends the persisted backgroundFrames value once after init, then follows toggles', async () => {
    await initEngine(1);
    expect(api.init).toHaveBeenCalledTimes(1);
    expect(api.setClockPolicy).toHaveBeenCalledTimes(1);
    expect(api.setClockPolicy).toHaveBeenLastCalledWith({ ignoreBackground: false });
    expect(api.setClockPolicy.mock.invocationCallOrder[0]).toBeGreaterThan(api.init.mock.invocationCallOrder[0]!);

    // A store update that leaves the overlay unchanged does not resend the policy.
    store.getState().setOverlay('rangeRings', !store.getState().overlays.rangeRings);
    expect(api.setClockPolicy).toHaveBeenCalledTimes(1);

    store.getState().setOverlay('backgroundFrames', false);
    expect(api.setClockPolicy).toHaveBeenCalledTimes(2);
    expect(api.setClockPolicy).toHaveBeenLastCalledWith({ ignoreBackground: true });

    store.getState().setOverlay('backgroundFrames', true);
    expect(api.setClockPolicy).toHaveBeenCalledTimes(3);
    expect(api.setClockPolicy).toHaveBeenLastCalledWith({ ignoreBackground: false });
  });
});
