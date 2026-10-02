/**
 * sim.snapshot-storage — [S32] `DeviceSnapshot.storage` and the automation workspace's `hostRequest` rows
 * (ARCHITECTURE-P3 D21, §2.8, §2.9, ruling R5 and R20; §7 W2 sim; sim/snapshot-cache.ts `deviceStorageOf`,
 * sim/simulation.ts `HOST_APP_PROCESS`).
 *
 * Pinned on `staged.world` at stage P3 (the test-only NF-DEVHOST until the W6 flip; a stand-in `script-host` daemon,
 * since the real one is W2 auto's and registered at W6):
 *   • `storage` is ABSENT on every device without user files — a fresh host, a router (no store), a P1 world — so no
 *     golden moves; with files it lists `files:` as `[{fs: 'files', files}]` in path order, metadata only (never the
 *     text), and goes away again when the last file is deleted;
 *   • `script.run` / `script.stop` / `file.write` / `file.delete` map to `script-host` (the run's token is the ticket);
 *     the rows of the Traffic app are in `sim.snapshot-txqueue.test.ts` (the load behind the congestion view);
 *   • a `file.write` within the io limits reaches the daemon; one beyond them (a name that is not a plain file name or
 *     is longer than 255 characters, text longer than the store keeps, a 257th file) is refused with an original
 *     message, spends no ticket and changes nothing (replacing a file of a full store is allowed).
 */
import { describe, expect, it } from 'vitest';
import type { DeviceId } from '../src/contracts/ids.js';
import type { Action, Process, ProcessRequest } from '../src/contracts/process.js';
import type { DeviceSnapshot } from '../src/contracts/snapshot.js';
import type { HostAppRequest, Simulation } from '../src/contracts/simulation.js';
import { SEC } from '../src/contracts/time.js';
import { MAX_TOPOLOGY_FILE_CHARS, MAX_TOPOLOGY_FILE_NAME_CHARS, MAX_TOPOLOGY_FILES_PER_DEVICE } from '../src/io/schema.js';
import { deviceStorageOf, storedFilesOf } from '../src/sim/snapshot-cache.js';
import { HOST_APP_PROCESS, createSimulation } from '../src/sim/simulation.js';
import { NF_DEVHOST_TYPE, createStagedSimulation } from './staged.world.js';

/** A stand-in script-host: records requests; writes and deletes files through the `storage` action, as the real one. */
function scriptHost(seen: ProcessRequest[]): Process {
  return {
    name: 'script-host',
    onPdu: () => [],
    onTimer: () => [],
    onConfig: () => [],
    onRequest: (_ctx, req): Action[] => {
      seen.push(req);
      if (req.kind === 'file.write') return [{ type: 'storage', op: 'write', fs: 'files', path: req.path, file: { content: req.content } }];
      if (req.kind === 'file.delete') return [{ type: 'storage', op: 'delete', fs: 'files', path: req.path }];
      return [];
    },
    stateSnapshot: () => ({ process: 'script-host', state: {} }),
    debugEvents: () => [],
  };
}

function world(): { sim: Simulation; seen: ProcessRequest[] } {
  const seen: ProcessRequest[] = [];
  const sim = createStagedSimulation({ seed: 17, stage: 'P3', factories: { 'script-host': () => scriptHost(seen) } });
  sim.addDevice({ id: 'dev1', type: NF_DEVHOST_TYPE, name: 'DEV1' });
  sim.addDevice({ id: 'pc1', type: 'pc.nfpc', name: 'PC1' });
  sim.addDevice({ id: 'r1', type: 'router.nf2911', name: 'R1' });
  sim.runFor(60 * SEC);
  return { sim, seen };
}

const deviceOf = (sim: Simulation, id: DeviceId): DeviceSnapshot => sim.snapshot().devices.find((d) => d.id === id)!;

/** Write `path` on `device` through the runtime's `storage` action (the way script-host does). */
function store(sim: Simulation, device: DeviceId, path: string, content: string): void {
  sim.device(device)!.applyActions('script-host', [{ type: 'storage', op: 'write', fs: 'files', path, file: { content } }], sim.now);
}

/** Run `req` and return the error message, or '' when it was accepted. */
function refusal(sim: Simulation, device: DeviceId, req: HostAppRequest): string {
  try {
    sim.hostRequest(device, req);
    return '';
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

describe('DeviceSnapshot.storage', () => {
  it('is absent without user files: a fresh host, a router, and every device of a P1 world', () => {
    const { sim } = world();
    for (const d of sim.snapshot().devices) expect(d, d.id).not.toHaveProperty('storage');
    store(sim, 'r1', 'x.py', 'print(1)\n'); // a router keeps no files: the action is refused
    expect(deviceOf(sim, 'r1')).not.toHaveProperty('storage');
    const p1 = createSimulation({ seed: 2 });
    p1.addDevice({ id: 'pc1', type: 'pc.nfpc', name: 'PC1' });
    p1.runFor(60 * SEC);
    for (const d of p1.snapshot().devices) expect(d).not.toHaveProperty('storage');
  });

  it('lists the files in path order, metadata only, and disappears with the last file', () => {
    const { sim } = world();
    store(sim, 'dev1', 'inventory.py', 'import json\nprint("hi")\n');
    sim.runFor(SEC);
    store(sim, 'dev1', 'a.json', '{"vlans": [10, 20]}');
    store(sim, 'pc1', 'notes.txt', 'é'); // every host has a store
    const dev1 = deviceOf(sim, 'dev1');
    expect(dev1.storage).toEqual([
      {
        fs: 'files',
        files: [
          { fs: 'files', path: 'a.json', size: 19, modifiedAt: sim.now },
          { fs: 'files', path: 'inventory.py', size: 24, modifiedAt: sim.now - SEC },
        ],
      },
    ]);
    expect(JSON.stringify(dev1.storage)).not.toContain('import json');
    expect(Object.keys(dev1).at(-1)).toBe('storage');
    expect(deviceOf(sim, 'pc1').storage).toEqual([{ fs: 'files', files: [{ fs: 'files', path: 'notes.txt', size: 2, modifiedAt: sim.now }] }]);
    // a structured-clone copy: changing the snapshot changes nothing in the device
    (dev1.storage![0]!.files as unknown as { path: string }[])[0]!.path = 'changed';
    expect(storedFilesOf(sim.device('dev1')!).map((f) => f.path)).toEqual(['a.json', 'inventory.py']);

    for (const path of ['a.json', 'inventory.py']) sim.device('dev1')!.applyActions('script-host', [{ type: 'storage', op: 'delete', fs: 'files', path }], sim.now);
    expect(deviceOf(sim, 'dev1')).not.toHaveProperty('storage');
  });

  it('deviceStorageOf: a runtime without a reader, or with an empty store, has none', () => {
    expect(deviceStorageOf({})).toBeUndefined();
    expect(deviceStorageOf({ files: () => [] })).toBeUndefined();
    expect(storedFilesOf({ files: 7 })).toEqual([]);
  });
});

describe('hostRequest: the automation workspace ([S32])', () => {
  it('maps the four apps to script-host; the run token is the ticket', () => {
    expect(HOST_APP_PROCESS['script.run']).toBe('script-host');
    expect(HOST_APP_PROCESS['script.stop']).toBe('script-host');
    expect(HOST_APP_PROCESS['file.write']).toBe('script-host');
    expect(HOST_APP_PROCESS['file.delete']).toBe('script-host');
    const { sim, seen } = world();
    expect(sim.hostRequest('dev1', { app: 'file.write', path: 'inventory.py', content: 'print(1)\n' })).toEqual({ requestId: 'r_1', process: 'script-host' });
    expect(sim.hostRequest('dev1', { app: 'script.run', file: 'inventory.py', argv: ['-v'] })).toEqual({ requestId: 'r_2', process: 'script-host' });
    expect(sim.hostRequest('dev1', { app: 'script.stop', run: 'r_2' })).toEqual({ requestId: 'r_3', process: 'script-host' });
    expect(sim.hostRequest('dev1', { app: 'file.delete', path: 'inventory.py' })).toEqual({ requestId: 'r_4', process: 'script-host' });
    expect(seen).toEqual([
      { kind: 'file.write', path: 'inventory.py', content: 'print(1)\n' },
      { kind: 'script.run', token: 'r_2', file: 'inventory.py', argv: ['-v'] },
      { kind: 'script.stop', token: 'r_2' },
      { kind: 'file.delete', path: 'inventory.py' },
    ]);
    expect(deviceOf(sim, 'dev1')).not.toHaveProperty('storage');
    // a device that does not run script-host refuses, naming the service
    expect(refusal(sim, 'pc1', { app: 'script.run', file: 'x.py' })).toMatch(/script-host/);
  });

  it('refuses a malformed request or a file beyond the io limits, spending no ticket and changing nothing', () => {
    const { sim, seen } = world();
    const bad = [
      { app: 'file.write', path: '', content: 'x' },
      { app: 'file.write', path: 'dir/x.py', content: 'x' },
      { app: 'file.write', path: '..', content: 'x' },
      { app: 'file.write', path: 'a'.repeat(MAX_TOPOLOGY_FILE_NAME_CHARS + 1), content: 'x' },
      { app: 'file.write', path: 'x.py' },
      { app: 'file.write', path: 'x.py', content: 'y'.repeat(MAX_TOPOLOGY_FILE_CHARS + 1) },
      { app: 'file.delete', path: '  ' },
      { app: 'script.run', file: 7 },
      { app: 'script.run', file: 'x.py', argv: ['ok', 3] },
      { app: 'script.stop' },
    ] as unknown as HostAppRequest[];
    for (const req of bad) {
      const message = refusal(sim, 'dev1', req);
      expect(message, JSON.stringify(req).slice(0, 80)).not.toBe('');
      expect(message).not.toMatch(/TypeError|undefined|is not a function/);
    }
    expect(seen).toEqual([]);
    // the longest allowed name and text are accepted
    expect(sim.hostRequest('dev1', { app: 'file.write', path: 'a'.repeat(MAX_TOPOLOGY_FILE_NAME_CHARS), content: 'z'.repeat(MAX_TOPOLOGY_FILE_CHARS) }).requestId).toBe('r_1');
  });

  it('a full store refuses a new file but lets one be replaced', () => {
    const { sim, seen } = world();
    for (let i = 0; i < MAX_TOPOLOGY_FILES_PER_DEVICE; i++) store(sim, 'dev1', `f${String(i).padStart(3, '0')}.py`, '#');
    expect(storedFilesOf(sim.device('dev1')!)).toHaveLength(MAX_TOPOLOGY_FILES_PER_DEVICE);
    expect(refusal(sim, 'dev1', { app: 'file.write', path: 'new.py', content: 'x' })).toBe(
      `DEV1 already keeps ${MAX_TOPOLOGY_FILES_PER_DEVICE} files. Delete one before saving new.py.`,
    );
    expect(seen).toEqual([]);
    expect(sim.hostRequest('dev1', { app: 'file.write', path: 'f000.py', content: 'print(2)\n' }).requestId).toBe('r_1');
    expect(storedFilesOf(sim.device('dev1')!)).toHaveLength(MAX_TOPOLOGY_FILES_PER_DEVICE);
    expect(deviceOf(sim, 'dev1').storage![0]!.files[0]).toMatchObject({ path: 'f000.py', size: 9 });
  });
});
