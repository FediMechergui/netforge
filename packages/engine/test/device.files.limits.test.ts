/**
 * device.files.limits — ruling R20 (ARCHITECTURE-P3 §9.2, W1 rulings; [S32] D21): the device `storage` action enforces
 * the io limits of a host's `files:` store — at most `MAX_TOPOLOGY_FILES_PER_DEVICE` (256) files, names of at most
 * `MAX_TOPOLOGY_FILE_NAME_CHARS` (255) characters, contents of at most `MAX_TOPOLOGY_FILE_CHARS` (1 MiB) characters —
 * so every file a host holds survives export and reload (io/schema.ts). A write beyond a limit changes nothing and
 * leaves one runtime debug line naming the limit; replacing an existing file never counts against the file limit, and
 * a delete frees a place. `storageWriteProblem` is the pure rule (the [S32] writers may ask it first).
 */
import { describe, expect, it } from 'vitest';
import type { Action, DebugEvent } from '../src/contracts/process.js';
import { SEC } from '../src/contracts/time.js';
import { storageWriteProblem } from '../src/device/device.js';
import type { ProcessHost } from '../src/device/process-ctx.js';
import { MAX_CONFIG_CHARS, MAX_TOPOLOGY_FILES_PER_DEVICE, MAX_TOPOLOGY_FILE_CHARS, MAX_TOPOLOGY_FILE_NAME_CHARS } from '../src/io/schema.js';
import { boot, fakeProcess, harness, type Harness } from './device.harness.js';

const store = (h: Harness): Required<Pick<ProcessHost, 'files' | 'readFile'>> => h.device as unknown as Required<Pick<ProcessHost, 'files' | 'readFile'>>;
const write = (path: string, content: string): Action => ({ type: 'storage', op: 'write', fs: 'files', path, file: { content } });
const del = (path: string): Action => ({ type: 'storage', op: 'delete', fs: 'files', path });
const runtimeDebug = (h: Harness): string[] =>
  h.events.filter((e) => e.kind === 'debug').map((e) => (e as unknown as { event: DebugEvent }).event).filter((d) => d.category === 'runtime').map((d) => d.message);

function host(): Harness {
  const h = harness({ type: 'pc.nfpc', name: 'DEV1', processes: { host: fakeProcess('host').factory } });
  boot(h);
  return h;
}

describe('the io limits (R20)', () => {
  it('are the schema limits: 256 files, 255-character names, 1 MiB of text per file', () => {
    expect(MAX_TOPOLOGY_FILES_PER_DEVICE).toBe(256);
    expect(MAX_TOPOLOGY_FILE_NAME_CHARS).toBe(255);
    expect(MAX_TOPOLOGY_FILE_CHARS).toBe(1024 * 1024);
    expect(MAX_TOPOLOGY_FILE_CHARS).toBe(MAX_CONFIG_CHARS);
  });

  it('storageWriteProblem: the pure rule, in original wording', () => {
    expect(storageWriteProblem([], 'a.py', 'x')).toBeUndefined();
    expect(storageWriteProblem([], 'n'.repeat(255), '')).toBeUndefined();
    expect(storageWriteProblem([], 'n'.repeat(256), '')).toBe('the name is longer than 255 characters');
    expect(storageWriteProblem([], 'big.txt', 'x'.repeat(MAX_TOPOLOGY_FILE_CHARS))).toBeUndefined();
    expect(storageWriteProblem([], 'big.txt', 'x'.repeat(MAX_TOPOLOGY_FILE_CHARS + 1))).toBe('the file is longer than 1048576 characters');
    const full = Array.from({ length: 256 }, (_, i) => `f${i}.py`);
    expect(storageWriteProblem(full, 'new.py', '')).toBe('the store already holds 256 files');
    expect(storageWriteProblem(full, 'f7.py', 'replaced')).toBeUndefined();
    expect(storageWriteProblem(new Set(full), 'new.py', '')).toBe('the store already holds 256 files');
    expect(storageWriteProblem(new Set(full.slice(1)), 'new.py', '')).toBeUndefined();
    // the name rule is checked first, then the size, then the count
    expect(storageWriteProblem(full, 'n'.repeat(300), 'x'.repeat(MAX_TOPOLOGY_FILE_CHARS + 1))).toBe('the name is longer than 255 characters');
  });
});

describe('the storage action enforces them (R20)', () => {
  it('a 255-character name is stored; a 256-character one is refused with a runtime debug line', () => {
    const h = host();
    const t = 10 * SEC;
    h.device.applyActions('script-host', [write('n'.repeat(255), 'ok'), write('m'.repeat(256), 'no')], t);
    expect(store(h).files('files').map((f) => f.path.length)).toEqual([255]);
    const lines = runtimeDebug(h);
    expect(lines).toEqual([`storage write of ${'m'.repeat(64)}… ignored: the name is longer than 255 characters`]);
  });

  it('a 1 MiB file is stored; one character more is refused, and an existing file keeps its content', () => {
    const h = host();
    const t = 10 * SEC;
    const mib = 'x'.repeat(MAX_TOPOLOGY_FILE_CHARS);
    h.device.applyActions('script-host', [write('big.txt', mib)], t);
    expect(store(h).readFile('files', 'big.txt')?.size).toBe(MAX_TOPOLOGY_FILE_CHARS);
    h.device.applyActions('script-host', [write('big.txt', `${mib}y`), write('other.txt', `${mib}y`)], t + 1);
    expect(store(h).readFile('files', 'big.txt')?.content).toBe(mib);
    expect(store(h).readFile('files', 'big.txt')?.modifiedAt).toBe(t);
    expect(store(h).readFile('files', 'other.txt')).toBeUndefined();
    expect(runtimeDebug(h)).toEqual([
      'storage write of big.txt ignored: the file is longer than 1048576 characters',
      'storage write of other.txt ignored: the file is longer than 1048576 characters',
    ]);
  });

  it('256 files fit; the 257th new file is refused; a replace still works; a delete frees a place', () => {
    const h = host();
    const t = 10 * SEC;
    h.device.applyActions('script-host', Array.from({ length: 256 }, (_, i) => write(`f${String(i).padStart(3, '0')}.py`, `n = ${i}\n`)), t);
    expect(store(h).files('files')).toHaveLength(256);
    expect(runtimeDebug(h)).toEqual([]);
    h.device.applyActions('script-host', [write('extra.py', 'x\n')], t + 1);
    expect(store(h).readFile('files', 'extra.py')).toBeUndefined();
    expect(runtimeDebug(h)).toEqual(['storage write of extra.py ignored: the store already holds 256 files']);
    h.device.applyActions('script-host', [write('f007.py', 'n = 700\n')], t + 2);
    expect(store(h).readFile('files', 'f007.py')).toMatchObject({ content: 'n = 700\n', modifiedAt: t + 2 });
    h.device.applyActions('script-host', [del('f000.py'), write('extra.py', 'x\n')], t + 3);
    expect(store(h).files('files')).toHaveLength(256);
    expect(store(h).readFile('files', 'extra.py')).toMatchObject({ content: 'x\n', modifiedAt: t + 3 });
    expect(runtimeDebug(h)).toHaveLength(1);
  });
});
