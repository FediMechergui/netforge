/**
 * Review regression test for apps/web/src/bridge/engine.worker.ts: CLI commands executed while
 * paused must post a batch carrying a fresh snapshot, so the inspector (running-config, names,
 * port state) is not stale during step-debugging.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyApi = any;
let exposed: AnyApi | undefined;

vi.mock('comlink', () => ({
  expose: (api: AnyApi) => {
    exposed = api;
  },
  proxy: <T>(x: T) => x,
}));

const WORKER = '../../../apps/web/src/bridge/engine.worker.ts';

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'performance'] });
});
afterEach(() => {
  vi.useRealTimers();
});

describe('review: worker CLI snapshot while paused', () => {
  it('cliExec while paused posts a snapshot reflecting the config change', async () => {
    vi.resetModules();
    exposed = undefined;
    await import(WORKER);
    const api = exposed!;
    const batches: any[] = [];
    await api.subscribe((b: any) => batches.push(b));
    await api.init({ seed: 7 });
    await api.loadScenario('pc-router-pc');
    await api.runToIdle(); // boot, stays paused

    const view = await api.cliOpen('r1', 'console');
    await api.cliExec(view.id, 'enable');
    await api.cliExec(view.id, 'configure terminal');
    batches.length = 0;
    await api.cliExec(view.id, 'hostname R9');

    const last = batches[batches.length - 1];
    expect(last).toBeDefined();
    expect(last.playing).toBe(false);
    expect(last.snapshot).toBeDefined();
    const r1 = last.snapshot.devices.find((d: any) => d.id === 'r1');
    // DeviceSnapshot.name is the canvas/topology name (renameDevice), not the hostname; the
    // hostname change is visible in the snapshot's running-config.
    expect(r1.runningConfig).toContain('hostname R9');
    expect(r1.runningConfig).not.toContain('hostname R1');

    batches.length = 0;
    await api.cliInterrupt(view.id);
    expect(batches[batches.length - 1]?.snapshot).toBeDefined();
  });
});
