/**
 * device.storage.flash — [S29] [S30] [S31] the device store keyed by (file system, path) (ARCHITECTURE-P3C D10, §2.9,
 * §3.4 steps 5–8; §7 W1a device):
 *   • `hasFileStore(fs)`: `files:` on hosts, `flash:` and `nvram:` on a model with `DeviceModel.storage`. The real
 *     catalog has no storage until the W4b flip, so every real router keeps no store and nothing changes; the test
 *     builds its routers from `test/staged.world.ts` at stage 'P3c' (`P3C_STORAGE`, ruling RC2 (b));
 *   • `dir(fs)`: the virtual image first on `flash:` (never stored, so never in `files`, a snapshot or an export), the
 *     virtual `startup-config` on `nvram:`, the capacity and the free bytes;
 *   • the flash capacity check (`flashWriteProblem`), files counted at their image header's nominal size;
 *   • `StoredFileMeta.nominalBytes` read from the image header (any file system), absent for any other file;
 *   • the persistent configuration register: written for the next power-on, kept across power-off.
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG_REGISTER, IMAGE_HEADER_BYTES, IMAGE_TRANSFER_SCALE, type FileSystemId, type StoredFile, type StoredFileMeta } from '../src/contracts/storage.js';
import type { DeviceCatalog, DeviceRuntime, DeviceSpec } from '../src/contracts/device.js';
import type { Action, DebugEvent } from '../src/contracts/process.js';
import { SEC } from '../src/contracts/time.js';
import type { TraceEvent } from '../src/contracts/trace.js';
import { createRng } from '../src/core/prng.js';
import { createScheduler } from '../src/core/scheduler.js';
import type { Scheduler } from '../src/contracts/events.js';
import { createTable } from '../src/core/table.js';
import { createCatalog } from '../src/device/catalog.js';
import {
  NVRAM_STARTUP_CONFIG,
  createDevice,
  flashUsedBytes,
  flashWriteProblem,
  storedFileBytes,
  storedFileSize,
  type FileSystemListing,
} from '../src/device/device.js';
import type { IfIndexSource } from '../src/device/if-index.js';
import { PROCESS_FACTORIES } from '../src/protocols/index.js';
import { imageHeader } from '../src/io/schema.js';
import { createPduFactory } from '../src/pdu/factory.js';
import { deviceStorageOf } from '../src/sim/snapshot-cache.js';
import { P3C_STORAGE, createStagedCatalog } from './staged.world.js';

/** The P3c runtime members this item adds (not on the `DeviceRuntime` contract yet: a reported gap). */
interface StoreRuntime {
  hasFileStore(fs: FileSystemId): boolean;
  files(fs: FileSystemId): readonly StoredFileMeta[];
  readFile(fs: FileSystemId, path: string): StoredFile | undefined;
  dir(fs: FileSystemId): FileSystemListing | undefined;
  configRegister(): { readonly current: number; readonly next: number } | undefined;
  setConfigRegister(value: number): boolean;
  ifIndexSource(): IfIndexSource;
}

interface Rig {
  readonly device: DeviceRuntime;
  readonly store: StoreRuntime;
  readonly events: TraceEvent[];
  readonly scheduler: Scheduler;
}

const MIB = 1024 * 1024;

function rig(type: string, catalog: DeviceCatalog, opts: { power?: boolean; startupConfig?: string } = {}): Rig {
  const events: TraceEvent[] = [];
  const scheduler = createScheduler();
  const spec: DeviceSpec = {
    id: 'd_1',
    type,
    name: 'R1',
    position: { x: 0, y: 0 },
    power: opts.power ?? false,
    ...(opts.startupConfig !== undefined ? { startupConfig: opts.startupConfig } : {}),
    modules: [],
    macSalt: 0,
  };
  const device = createDevice(
    spec,
    {
      scheduler,
      trace: { emit: (ev) => events.push(ev) },
      rng: createRng(42).split(`device:${spec.id}`),
      pdus: createPduFactory(),
      catalog,
      tables: createTable,
      transmit: (_f, _p, now) => ({ ok: true, link: 'l_1', txStart: now, txEnd: now + 1000, arrive: now + 2000 }),
      onPortAdmin: () => undefined,
      onPortPhyConfig: () => undefined,
      mediumOp: () => undefined,
      airView: () => ({ visibleBss: () => [], link: () => undefined }),
      cliSink: { output: () => undefined, done: () => undefined },
    },
    0,
  );
  return {
    device,
    store: device as unknown as StoreRuntime,
    events,
    scheduler,
  };
}

const p3c = (): DeviceCatalog => createStagedCatalog({ stage: 'P3c' });
const real = (): DeviceCatalog => createCatalog(PROCESS_FACTORIES);

const write = (fs: FileSystemId, path: string, content: string): Action => ({ type: 'storage', op: 'write', fs, path, file: { content } });
const del = (fs: FileSystemId, path: string): Action => ({ type: 'storage', op: 'delete', fs, path });
const runtimeDebug = (events: readonly TraceEvent[]): DebugEvent[] =>
  events.filter((e) => e.kind === 'debug').map((e) => (e as unknown as { event: DebugEvent }).event).filter((d) => d.category === 'runtime');

/** An image file's content (§3.4 step 7): the header, then a fixed filler, ⌈nominal / IMAGE_TRANSFER_SCALE⌉ bytes long. */
function imageContent(nominalBytes: number): string {
  const length = Math.ceil(nominalBytes / IMAGE_TRANSFER_SCALE);
  return imageHeader(nominalBytes) + '.'.repeat(length - IMAGE_HEADER_BYTES);
}

const NF2911 = 'router.nf2911';

describe('hasFileStore(fs) and the real catalog (nothing changes before the W4b flip)', () => {
  it('a real router keeps no store; a host keeps files: only; no real model has storage yet', () => {
    const catalog = real();
    for (const m of catalog.list()) expect(m.storage, m.type).toBeUndefined();
    const r = rig(NF2911, catalog);
    for (const fs of ['files', 'flash', 'nvram'] as const) {
      expect(r.store.hasFileStore(fs)).toBe(false);
      expect(r.store.dir(fs)).toBeUndefined();
      expect(r.store.files(fs)).toEqual([]);
    }
    expect(r.store.configRegister()).toBeUndefined();
    expect(r.store.setConfigRegister(0x2142)).toBe(false);
    const pc = rig('pc.nfpc', catalog);
    expect([pc.store.hasFileStore('files'), pc.store.hasFileStore('flash'), pc.store.hasFileStore('nvram')]).toEqual([true, false, false]);
    expect(pc.store.dir('files')).toEqual({ fs: 'files', virtual: [], files: [], capacity: undefined, used: 0, free: undefined });
  });

  it('a staged P3c router has flash: and nvram: from P3C_STORAGE, and no files: store', () => {
    const r = rig(NF2911, p3c());
    expect([r.store.hasFileStore('files'), r.store.hasFileStore('flash'), r.store.hasFileStore('nvram')]).toEqual([false, true, true]);
    // the firewalls get no storage in P3c (ruling RC2 (b))
    expect(rig('firewall.nfasa5506', p3c()).store.hasFileStore('flash')).toBe(false);
  });
});

describe('flash: — the virtual image, user files and the capacity check ([S29] [S30])', () => {
  const storage = P3C_STORAGE[NF2911]!;

  it('dir lists the virtual image first at its nominal size; it is never stored, listed, read or in a snapshot', () => {
    const r = rig(NF2911, p3c());
    const image = storage.image;
    expect(image).toEqual({ file: 'nf2900-15.7.bin', version: '15.7', nominalBytes: 38 * MIB });
    expect(r.store.dir('flash')).toEqual({
      fs: 'flash',
      virtual: [{ fs: 'flash', path: image.file, size: image.nominalBytes, modifiedAt: 0, nominalBytes: image.nominalBytes }],
      files: [],
      capacity: storage.flashBytes,
      used: image.nominalBytes,
      free: storage.flashBytes - image.nominalBytes,
    });
    expect(r.store.files('flash')).toEqual([]);
    expect(r.store.readFile('flash', image.file)).toBeUndefined();
    // DeviceSnapshot.storage (the snapshot cache's reader) stays absent: no P1/P2/P3 router snapshot moves
    expect(deviceStorageOf(r.device)).toBeUndefined();
  });

  it('a user file is stored, listed by path, read, counted at its size, deleted; nothing in the trace', () => {
    const r = rig(NF2911, p3c());
    const t = 10 * SEC;
    const text = 'hostname R1\n!\nend\n';
    r.device.applyActions('tftp', [write('flash', 'r1-confg', text), write('flash', 'a.txt', 'x')], t);
    expect(r.store.files('flash')).toEqual([
      { fs: 'flash', path: 'a.txt', size: 1, modifiedAt: t },
      { fs: 'flash', path: 'r1-confg', size: storedFileSize(text), modifiedAt: t },
    ]);
    expect(r.store.readFile('flash', 'r1-confg')).toEqual({ fs: 'flash', path: 'r1-confg', size: storedFileSize(text), modifiedAt: t, content: text });
    expect(r.store.dir('flash')!.used).toBe(storage.image.nominalBytes + 1 + storedFileSize(text));
    r.device.applyActions('tftp', [del('flash', 'a.txt')], t + 1);
    expect(r.store.files('flash').map((f) => f.path)).toEqual(['r1-confg']);
    expect(runtimeDebug(r.events)).toEqual([]);
    expect(r.events).toEqual([]);
  });

  it('an image file carries nominalBytes from its header and is counted at it (lab 31: 40 MB fits beside 38 MB)', () => {
    const r = rig(NF2911, p3c());
    const nominal = 40 * MIB;
    const content = imageContent(nominal);
    expect(content.length).toBe(Math.ceil(nominal / IMAGE_TRANSFER_SCALE)); // 40 960 bytes on the wire
    r.device.applyActions('tftp', [write('flash', 'nf2900-15.9.bin', content)], 5 * SEC);
    const meta = r.store.files('flash')[0]!;
    expect(meta).toEqual({ fs: 'flash', path: 'nf2900-15.9.bin', size: content.length, modifiedAt: 5 * SEC, nominalBytes: nominal });
    expect(r.store.readFile('flash', 'nf2900-15.9.bin')?.nominalBytes).toBe(nominal);
    expect(r.store.dir('flash')!.used).toBe(storage.image.nominalBytes + nominal);
    expect(r.store.dir('flash')!.free).toBe(storage.flashBytes - storage.image.nominalBytes - nominal);
    // a near-miss header is no image: no nominalBytes
    r.device.applyActions('tftp', [write('flash', 'fake.bin', `NFIMG2${'0'.repeat(10)}x`)], 6 * SEC);
    expect('nominalBytes' in r.store.files('flash').find((f) => f.path === 'fake.bin')!).toBe(false);
  });

  it('a write beyond the capacity is refused with a runtime debug line; exactly full fits; a replace frees its old bytes', () => {
    const r = rig(NF2911, p3c());
    const free = storage.flashBytes - storage.image.nominalBytes;
    r.device.applyActions('tftp', [write('flash', 'big.bin', imageContent(free + 1))], 1 * SEC);
    expect(r.store.files('flash')).toEqual([]);
    const d = runtimeDebug(r.events);
    expect(d).toHaveLength(1);
    expect(d[0]!.message).toContain(`not enough space on flash: (${free} bytes free, ${free + 1} needed)`);
    r.device.applyActions('tftp', [write('flash', 'big.bin', imageContent(free))], 2 * SEC);
    expect(r.store.dir('flash')!.free).toBe(0);
    // a 1-byte file no longer fits; replacing big.bin by a smaller image does
    r.device.applyActions('tftp', [write('flash', 'one', 'x')], 3 * SEC);
    expect(r.store.files('flash').map((f) => f.path)).toEqual(['big.bin']);
    r.device.applyActions('tftp', [write('flash', 'big.bin', imageContent(free - 10))], 4 * SEC);
    expect(r.store.dir('flash')!.free).toBe(10);
    expect(runtimeDebug(r.events)).toHaveLength(2);
  });

  it('the running image name, nvram:, files: on a router and a bad name are refused', () => {
    const r = rig(NF2911, p3c());
    r.device.applyActions('tftp', [
      write('flash', storage.image.file, 'x'),
      write('nvram', 'startup-config', 'hostname X\n'),
      write('files', 'a.py', 'x'),
      write('flash', 'dir/x', 'x'),
    ], 1 * SEC);
    expect(r.store.files('flash')).toEqual([]);
    expect(r.store.files('nvram')).toEqual([]);
    expect(r.store.files('files')).toEqual([]);
    expect(runtimeDebug(r.events)).toHaveLength(4);
  });

  it('the store survives power-off and reload, like a disk', () => {
    const r = rig(NF2911, p3c(), { power: true });
    r.device.applyActions('tftp', [write('flash', 'keep.cfg', 'end\n')], 30 * SEC);
    r.device.setPower(false, 31 * SEC);
    r.device.setPower(true, 32 * SEC);
    expect(r.store.files('flash')).toEqual([{ fs: 'flash', path: 'keep.cfg', size: 4, modifiedAt: 30 * SEC }]);
  });

  it('pure rules: storedFileBytes, flashUsedBytes, flashWriteProblem', () => {
    expect(storedFileBytes({ size: 5 })).toBe(5);
    expect(storedFileBytes({ size: 5, nominalBytes: 9 })).toBe(9);
    const files = [{ path: 'a', size: 10 }, { path: 'b', size: 16, nominalBytes: 1000 }];
    expect(flashUsedBytes(storage, files)).toBe(storage.image.nominalBytes + 1010);
    const free = storage.flashBytes - storage.image.nominalBytes - 1010;
    expect(flashWriteProblem(storage, files, 'c', free)).toBeUndefined();
    expect(flashWriteProblem(storage, files, 'c', free + 1)).toBe(`not enough space on flash: (${free} bytes free, ${free + 1} needed)`);
    expect(flashWriteProblem(storage, files, 'b', free + 1000)).toBeUndefined(); // b's old bytes are freed first
    expect(flashWriteProblem(storage, files, storage.image.file, 1)).toBe(`${storage.image.file} is the running image`);
  });
});

describe('a host keeps its files: store; an image header there carries nominalBytes too', () => {
  it('a P3a host file keeps the P3a metadata keys; an image on a host has nominalBytes', () => {
    const r = rig('server.nfserver', real());
    r.device.applyActions('script-host', [write('files', 'a.py', 'x'), write('files', 'nf2900-15.9.bin', imageContent(40 * MIB))], 1 * SEC);
    const [a, img] = r.store.files('files');
    expect(Object.keys(a!)).toEqual(['fs', 'path', 'size', 'modifiedAt']);
    expect(img).toMatchObject({ path: 'nf2900-15.9.bin', nominalBytes: 40 * MIB });
    expect(r.store.dir('files')!.used).toBe(1 + imageContent(40 * MIB).length);
    expect(r.store.hasFileStore('flash')).toBe(false);
  });
});

describe('nvram: — the virtual startup-config', () => {
  it('lists startup-config only once a configuration is saved, at its rendered size', () => {
    const r = rig(NF2911, p3c());
    const s = P3C_STORAGE[NF2911]!;
    expect(r.store.dir('nvram')).toEqual({ fs: 'nvram', virtual: [], files: [], capacity: s.nvramBytes, used: 0, free: s.nvramBytes });
    const saved = rig(NF2911, p3c(), { startupConfig: 'hostname R9\n' });
    const listing = saved.store.dir('nvram')!;
    expect(listing.virtual).toHaveLength(1);
    expect(listing.virtual[0]).toMatchObject({ fs: 'nvram', path: NVRAM_STARTUP_CONFIG, modifiedAt: 0 });
    expect(listing.virtual[0]!.size).toBeGreaterThan(0);
    expect(listing.used).toBe(listing.virtual[0]!.size);
    expect(saved.store.files('nvram')).toEqual([]);
  });
});

describe('the persistent configuration register ([S31])', () => {
  it('is 0x2102 until written; a write takes effect at the next power-on and survives power-off', () => {
    const r = rig(NF2911, p3c(), { power: true });
    expect(r.store.configRegister()).toEqual({ current: DEFAULT_CONFIG_REGISTER, next: DEFAULT_CONFIG_REGISTER });
    expect(r.store.setConfigRegister(0x2142)).toBe(true);
    expect(r.store.configRegister()).toEqual({ current: 0x2102, next: 0x2142 });
    r.device.setPower(false, 40 * SEC);
    expect(r.store.configRegister()).toEqual({ current: 0x2102, next: 0x2142 });
    r.device.setPower(true, 41 * SEC);
    expect(r.store.configRegister()).toEqual({ current: 0x2142, next: 0x2142 });
    expect(r.store.setConfigRegister(0x2102)).toBe(true);
    r.device.reload(60 * SEC);
    expect(r.store.configRegister()).toEqual({ current: 0x2102, next: 0x2102 });
  });

  it('refuses a value outside 0x0000–0xFFFF and changes nothing', () => {
    const r = rig(NF2911, p3c());
    for (const bad of [-1, 0x10000, 1.5, Number.NaN]) expect(r.store.setConfigRegister(bad), String(bad)).toBe(false);
    expect(r.store.setConfigRegister(0)).toBe(true);
    expect(r.store.setConfigRegister(0xffff)).toBe(true);
    expect(r.store.configRegister()!.next).toBe(0xffff);
  });
});
