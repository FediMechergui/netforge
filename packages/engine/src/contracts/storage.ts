/**
 * [S32] The hosts' file store (ARCHITECTURE-P3 §2.9, D21). @since P3
 *
 * NF-Py scripts live in a flat `files:` file system on hosts (every `host` model has one, empty by default; no model
 * member is needed). Files change only through the `storage` action (script-host, the automation workspace through
 * `file.write` / `file.delete`), persist in `TopologyDevice.files` (schema 1.3, so scripts survive export and reach lab
 * clones) and are listed in `DeviceSnapshot.storage`. Text only; structured-clone safe.
 *
 * [S29] (not approved) would widen `FileSystemId` with 'flash' | 'nvram' and add the image constants
 * (IMAGE_TRANSFER_SCALE, DEFAULT_CONFIG_REGISTER); nothing of it is added in P3a.
 */
import type { SimTime } from './time.js';

/** @since P3 [S32] The file systems a device has: hosts' `files:` only in P3a. */
export type FileSystemId = 'files';

/** @since P3 [S32] One file of a store, without its content (listings, `dir`). */
export interface StoredFileMeta {
  readonly fs: FileSystemId;
  /** Flat name, e.g. 'inventory.py' (no directories). */
  readonly path: string;
  /** Content length in bytes (UTF-8). */
  readonly size: number;
  /** SimTime of the last write. */
  readonly modifiedAt: SimTime;
}

/** @since P3 [S32] One file with its text content (`ProcessCtx.readFile`, `type`). */
export interface StoredFile extends StoredFileMeta {
  readonly content: string;
}

/** @since P3 [S32] What a `storage` write carries. */
export interface StoredFileInput {
  readonly content: string;
}

/** @since P3 [S32] One file system of a device as the snapshot lists it (`DeviceSnapshot.storage`). */
export interface DeviceStorageView {
  readonly fs: FileSystemId;
  readonly files: readonly StoredFileMeta[];
}

/** @since P3 [S32] A persisted file of a host's `files:` store (`TopologyDevice.files`, schema 1.3). */
export interface TopologyFile {
  readonly path: string;
  readonly content: string;
}
