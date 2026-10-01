/**
 * device.files — [S32] the hosts' `files:` store (ARCHITECTURE-P3 D21, §2.4, §2.9; §7 W1 device): the `storage`
 * action writes (create or replace, `modifiedAt` = now) and deletes files of a host's flat store; `files(fs)` lists
 * them by path with their UTF-8 size, `readFile` returns one with its content, and `ctx.files` / `ctx.readFile` read
 * the same store; a device without `host` keeps no files; malformed requests are runtime debug lines; the store
 * survives power-off and reload (a disk, not RAM).
 */
import { describe, expect, it } from 'vitest';
import type { Action, DebugEvent } from '../src/contracts/process.js';
import type { FileSystemId } from '../src/contracts/storage.js';
import { SEC } from '../src/contracts/time.js';
import { HOST_STORE_FS, isStoredFileName, storedFileSize } from '../src/device/device.js';
import type { ProcessHost } from '../src/device/process-ctx.js';
import { boot, fakeProcess, harness, type Harness } from './device.harness.js';

/**
 * The runtime's store readers (`files`, `readFile`: the `ProcessHost` members `ctx.files` / `ctx.readFile` use). The
 * `DeviceRuntime` contract does not declare them yet (a gap reported by W1 device: the snapshot cache and the export
 * need a read path), so the test reads them through the host shape the runtime implements.
 */
const store = (h: Harness): Required<Pick<ProcessHost, 'files' | 'readFile'>> => h.device as unknown as Required<Pick<ProcessHost, 'files' | 'readFile'>>;

const write = (path: string, content: string): Action => ({ type: 'storage', op: 'write', fs: 'files', path, file: { content } });
const del = (path: string): Action => ({ type: 'storage', op: 'delete', fs: 'files', path });
const runtimeDebug = (events: readonly { kind: string }[]): DebugEvent[] =>
  events.filter((e) => e.kind === 'debug').map((e) => (e as unknown as { event: DebugEvent }).event).filter((d) => d.category === 'runtime');

describe('helpers', () => {
  it('UTF-8 sizes and flat names', () => {
    expect(storedFileSize('')).toBe(0);
    expect(storedFileSize('print("hi")\n')).toBe(12);
    expect(storedFileSize('é')).toBe(2);
    expect(storedFileSize('€')).toBe(3);
    expect(storedFileSize('😀')).toBe(4);
    expect(storedFileSize('a\ud800b')).toBe(5); // a lone surrogate counts as 3, like an encoder's replacement character
    for (const ok of ['inventory.py', 'a', 'my script.py', 'v1.2.json', '...x']) expect(isStoredFileName(ok), ok).toBe(true);
    for (const bad of ['', '.', '..', 'dir/file.py', 'dir\\file.py', 'tab\tname', 'nul\u0000', 'del\u007f']) expect(isStoredFileName(bad), JSON.stringify(bad)).toBe(false);
    expect(HOST_STORE_FS).toBe('files');
  });
});

describe('the hosts’ files: store ([S32], D21)', () => {
  it('write, replace, list by path, read, delete; ctx.files and ctx.readFile read the same store', () => {
    const host = fakeProcess('host');
    const h = harness({ type: 'pc.nfpc', name: 'DEV1', processes: { host: host.factory } });
    boot(h);
    const t = 10 * SEC;
    expect(store(h).files('files')).toEqual([]);
    h.device.applyActions('script-host', [write('zeta.py', 'z = 1\n'), write('alpha.py', 'print("é")\n')], t);
    h.device.applyActions('script-host', [write('mid.json', '{}')], t + 5);
    expect(store(h).files('files')).toEqual([
      { fs: 'files', path: 'alpha.py', size: 12, modifiedAt: t },
      { fs: 'files', path: 'mid.json', size: 2, modifiedAt: t + 5 },
      { fs: 'files', path: 'zeta.py', size: 6, modifiedAt: t },
    ]);
    expect(Object.keys(store(h).files('files')[0]!)).toEqual(['fs', 'path', 'size', 'modifiedAt']);
    expect(store(h).readFile('files', 'alpha.py')).toEqual({ fs: 'files', path: 'alpha.py', size: 12, modifiedAt: t, content: 'print("é")\n' });
    expect(store(h).readFile('files', 'missing.py')).toBeUndefined();
    // replace: new content, size and time
    h.device.applyActions('script-host', [write('zeta.py', 'z = 22\n')], t + 9);
    expect(store(h).readFile('files', 'zeta.py')).toEqual({ fs: 'files', path: 'zeta.py', size: 7, modifiedAt: t + 9, content: 'z = 22\n' });
    // the process ctx reads the same store
    const ctx = host.ctx!;
    expect(ctx.files('files')).toEqual(store(h).files('files'));
    expect(ctx.readFile('files', 'mid.json')).toEqual(store(h).readFile('files', 'mid.json'));
    // delete (and deleting a missing file changes nothing, silently)
    h.device.applyActions('script-host', [del('mid.json'), del('never.py')], t + 10);
    expect(store(h).files('files').map((f) => f.path)).toEqual(['alpha.py', 'zeta.py']);
    expect(runtimeDebug(h.events)).toEqual([]);
    // the returned objects are copies the caller cannot change the store through
    expect(Object.isFrozen(store(h).files('files'))).toBe(true);
    expect(Object.isFrozen(store(h).readFile('files', 'alpha.py'))).toBe(true);
    // nothing in the trace: a storage action emits no event
    expect(h.events.filter((e) => (e as { t?: number }).t !== undefined && (e as { t: number }).t >= t)).toEqual([]);
  });

  it('malformed requests are runtime debug lines and change nothing', () => {
    const h = harness({ type: 'pc.nfpc', name: 'DEV1', processes: {} });
    boot(h);
    const t = 20 * SEC;
    h.device.applyActions('script-host', [
      write('dir/x.py', 'no'),
      write('', 'no'),
      { type: 'storage', op: 'write', fs: 'flash' as unknown as FileSystemId, path: 'x.py', file: { content: 'no' } },
      { type: 'storage', op: 'write', fs: 'files', path: 'x.py' },
    ], t);
    expect(store(h).files('files')).toEqual([]);
    const d = runtimeDebug(h.events);
    expect(d).toHaveLength(4);
    for (const e of d) expect(e).toMatchObject({ at: t, process: 'script-host', category: 'runtime' });
    expect(store(h).files('flash' as unknown as FileSystemId)).toEqual([]);
    expect(store(h).readFile('flash' as unknown as FileSystemId, 'x.py')).toBeUndefined();
  });

  it('a device without host keeps no files; its ctx lists none', () => {
    const ipv4 = fakeProcess('ipv4');
    const h = harness({ type: 'router.nf2911', name: 'R1', processes: { ipv4: ipv4.factory } });
    boot(h);
    h.device.applyActions('script-host', [write('a.py', 'x')], 50 * SEC);
    expect(store(h).files('files')).toEqual([]);
    expect(store(h).readFile('files', 'a.py')).toBeUndefined();
    expect(ipv4.ctx!.files('files')).toEqual([]);
    expect(ipv4.ctx!.readFile('files', 'a.py')).toBeUndefined();
    expect(runtimeDebug(h.events)).toHaveLength(1);
  });

  it('the store survives power-off and reload, like a disk', () => {
    const h = harness({ type: 'pc.nfpc', name: 'DEV1', processes: {} });
    boot(h);
    h.device.applyActions('script-host', [write('keep.py', 'print(1)\n')], 3 * SEC);
    h.device.setPower(false, 4 * SEC);
    expect(store(h).readFile('files', 'keep.py')?.content).toBe('print(1)\n');
    h.device.setPower(true, 5 * SEC);
    h.run();
    h.device.reload(20 * SEC);
    h.run();
    expect(store(h).files('files')).toEqual([{ fs: 'files', path: 'keep.py', size: 9, modifiedAt: 3 * SEC }]);
  });
});
