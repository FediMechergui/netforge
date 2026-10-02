/**
 * cli/grammar/devhost.ts — [S32] the developer host's shell: `python|python3 <file> [<args>]`, `type <file>`,
 * `del <file>` and `dir` over the host's flat `files:` store (ARCHITECTURE-P3 §5.7, §5.9, D21; §7 W2 cli, approved
 * items). `rest … -f <file>` (the body read from a file of the same store) is an option of the MUST `rest` job.
 *
 * `python` is a job of the `script-host` daemon (`script.run`; Ctrl+C sends `script.stop`); `type` and `dir` read the
 * store; `del` removes a file through the `storage` action. A file name is one token or a quoted name, with or without
 * the `files:` prefix. Scope: the `programmable` capability (NF-DEVHOST). Help strings are original wording (spec §1.6).
 */
import type { ArgSpec, CommandSpec } from '../../contracts/cli.js';
import type { Capability } from '../../contracts/catalog.js';
import { HOST_ONLY } from './core-exec.js';

/** @since P3 [S32] Handler ids of the developer host's shell. Never rename. */
export const DEVHOST_HANDLERS = {
  hostPython: 'host.python',
  hostType: 'host.type',
  hostDel: 'host.del',
  hostDir: 'host.dir',
} as const;

/** @since P3 [S32] The daemon that runs scripts. */
export const SCRIPT_HOST_PROCESS = 'script-host';
/** @since P3 [S32] Capabilities whose host shell has the scripting commands. */
export const DEVHOST_CAPABILITIES: readonly Capability[] = Object.freeze(['programmable'] as Capability[]);
/** @since P3 [S32] Longest file name (the io limit, ruling R20). */
export const FILE_NAME_MAX = 255;
/** @since P3 [S32] Optional prefix naming the store (`type files:inventory.py`). */
export const FILES_PREFIX = 'files:';

const H = DEVHOST_HANDLERS;

const FILE_ARG: ArgSpec = { type: 'quoted', help: 'File name in this host\'s files (quote a name with spaces)', maxLength: FILE_NAME_MAX + FILES_PREFIX.length };
const SCRIPT_ARGS: ArgSpec = { type: 'rest', help: 'Arguments passed to the script (sys.argv)', optional: true, maxLength: 1000 };

const SHELL_LINE = {
  mode: 'user-exec',
  privilege: 15,
  grammars: HOST_ONLY,
  requiresAny: DEVHOST_CAPABILITIES,
  since: 'P3',
  objectives: ['CCNA3.automation.7'],
} as const;

/** @since P3 [S32] The developer host's shell command table. */
export const DEVHOST_GRAMMAR: readonly CommandSpec[] = Object.freeze<CommandSpec[]>([
  {
    ...SHELL_LINE,
    path: ['python', '<file>', '<args>'],
    help: 'Run a Python script from this host\'s files',
    args: { file: FILE_ARG, args: SCRIPT_ARGS },
    handler: H.hostPython,
    job: true,
  },
  {
    ...SHELL_LINE,
    path: ['python3', '<file>', '<args>'],
    help: 'Run a Python script from this host\'s files (same as python)',
    args: { file: FILE_ARG, args: SCRIPT_ARGS },
    handler: H.hostPython,
    job: true,
  },
  {
    ...SHELL_LINE,
    path: ['type', '<file>'],
    help: 'Print a file of this host',
    args: { file: FILE_ARG },
    handler: H.hostType,
  },
  {
    ...SHELL_LINE,
    path: ['del', '<file>'],
    help: 'Delete a file of this host',
    args: { file: FILE_ARG },
    handler: H.hostDel,
  },
  {
    ...SHELL_LINE,
    path: ['dir'],
    help: 'List the files of this host',
    handler: H.hostDir,
    filterable: true,
  },
]);
