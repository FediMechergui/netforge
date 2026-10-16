/**
 * [S32] The hosts' file store (ARCHITECTURE-P3 §2.9, D21). @since P3
 *
 * NF-Py scripts live in a flat `files:` file system on hosts (every `host` model has one, empty by default; no model
 * member is needed). Files change only through the `storage` action (script-host, the automation workspace through
 * `file.write` / `file.delete`), persist in `TopologyDevice.files` (schema 1.3, so scripts survive export and reach lab
 * clones) and are listed in `DeviceSnapshot.storage`. Text only; structured-clone safe.
 *
 * [S29] (not approved in P3a) would widen `FileSystemId` with 'flash' | 'nvram' and add the image constants
 * (IMAGE_TRANSFER_SCALE, DEFAULT_CONFIG_REGISTER); nothing of it is added in P3a.
 *
 * @since P3c [S29] [S30] [S31] (ARCHITECTURE-P3C §2.9, D10): routers and switches get `flash:` and `nvram:` from
 * `DeviceModel.storage`; the model image is virtual (rendered by `dir`, never stored), so `DeviceSnapshot.storage` stays
 * absent unless a user file exists. W0 adds the types and constants only.
 */
import type { SimTime } from './time.js';

/**
 * @since P3 [S32] The file systems a device has: hosts' `files:` only in P3a. 'flash' and 'nvram' @since P3c [S29]
 * (routers' and switches' stores; `nvram:` holds only a virtual `startup-config`).
 */
export type FileSystemId = 'files' | 'flash' | 'nvram';

/** @since P3c [S30] An image copy moves `ceil(nominalBytes / IMAGE_TRANSFER_SCALE)` wire bytes. */
export const IMAGE_TRANSFER_SCALE = 1024;
/** @since P3c [S30] The image header: 'NFIMG1' followed by the nominal size as 10 decimal digits. */
export const IMAGE_HEADER_BYTES = 16;
/** @since P3c [S31] The configuration register a device boots with when none was written (`TopologyDevice.nvram`). */
export const DEFAULT_CONFIG_REGISTER = 0x2102;

/** @since P3 [S32] One file of a store, without its content (listings, `dir`). */
export interface StoredFileMeta {
  readonly fs: FileSystemId;
  /** Flat name, e.g. 'inventory.py' (no directories). */
  readonly path: string;
  /** Content length in bytes (UTF-8). */
  readonly size: number;
  /** SimTime of the last write. */
  readonly modifiedAt: SimTime;
  /**
   * @since P3c (optional by meaning) [S30] The nominal size of an image file, set when the content starts with a valid
   * image header (`IMAGE_HEADER_BYTES`); `dir`, the capacity check and the 1.4 export read it. Absent on every other file.
   */
  readonly nominalBytes?: number;
}

/** @since P3 [S32] One file with its text content (`ProcessCtx.readFile`, `type`). */
export interface StoredFile extends StoredFileMeta {
  readonly content: string;
}

/** @since P3 [S32] What a `storage` write carries. */
export interface StoredFileInput {
  readonly content: string;
  /**
   * @since P3c (optional by meaning) [S30] The runtime slot `dir`, the capacity check and the export read; the
   * `{type: 'storage'}` action carries it. Absent for every file that is not an image.
   */
  readonly nominalBytes?: number;
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
  /** @since P3c (optional by meaning) [S29] The file system of a router's or switch's file; absent = 'files'. Schema 1.4 only. */
  readonly fs?: 'flash';
  /** @since P3c (optional by meaning) [S30] An image file's nominal size. Schema 1.4 only. */
  readonly nominalBytes?: number;
}
