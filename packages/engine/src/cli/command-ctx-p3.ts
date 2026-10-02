/**
 * cli/command-ctx-p3.ts — what the CLI runtime gives the approved items' handlers beyond the `CommandCtx` contract
 * (ARCHITECTURE-P3 §7 W2 cli, approved items). Owned by the cli item; the runtime (cli/runtime.ts) fills every member.
 *
 * The W2 fix added the three members to the contract `CommandCtx` (contracts/cli.ts, optional by meaning: [S25]
 * `terminal monitor`'s `setMonitor`, [S32] the hosts' `files:` store's `files` / `readFile`). This view keeps the
 * handlers' `ctxP3` reads unchanged; every member stays optional (a hand-built test context without them still works:
 * the handler answers with a clear message).
 */
import type { CommandCtx } from '../contracts/cli.js';
import type { FileSystemId, StoredFile, StoredFileMeta } from '../contracts/storage.js';

/** @since P3 The command context the runtime builds (contract members plus the approved items' extras). */
export interface CommandCtxP3 extends CommandCtx {
  /** @since P3 [S25] Switch log printing on this session on or off (`terminal monitor` / `terminal no monitor`). */
  setMonitor?(on: boolean): void;
  /** @since P3 [S32] The files of the device's store (hosts' `files:` only; empty elsewhere). */
  files?(fs: FileSystemId): readonly StoredFileMeta[];
  /** @since P3 [S32] One file of the device's store, or undefined. */
  readFile?(fs: FileSystemId, path: string): StoredFile | undefined;
}

/** @since P3 The extension view of a command context (members may be absent on a hand-built context). */
export function ctxP3(ctx: CommandCtx): CommandCtxP3 {
  return ctx as CommandCtxP3;
}
