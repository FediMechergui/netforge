/**
 * cli/handlers/devhost.ts — [S32] the developer host's shell over its `files:` store (ARCHITECTURE-P3 §5.7, §5.9,
 * D21; §7 W2 cli, approved items).
 *
 *   host.python   `python|python3 <file> [<args>]`: a `script-host` job (`script.run {token, file, argv, session}`;
 *                 Ctrl+C sends `script.stop {token}`); the script's output arrives as `cliOutput` and its end as `cliDone`
 *   host.type     `type <file>`: the file's text
 *   host.del      `del <file>`: the `storage` delete action (the runtime applies it; R20's limits are the writer's)
 *   host.dir      `dir`: the store's files, by name
 *
 * `rest … -f <file>` (the body of a request read from the same store): `restBodyOf` below gives the body from the split
 * options (the `-d` text, or the `-f` file through `restBodyFromFile`; both is refused). The MUST `rest` job
 * (cli/handlers/api.ts, another owner) calls it once its splitter reads `-f <file>` (reported in the W2 wave report).
 *
 * A file name may carry the `files:` prefix and may be quoted. The store is read through the runtime's extension
 * members (`ctxP3(ctx).files` / `readFile`, cli/command-ctx-p3.ts). The run token is `py:<session>@<now>`, unique
 * because a session runs one job at a time. Messages are original wording (spec §1.6).
 */
import type { CommandCtx, CommandHandler } from '../../contracts/cli.js';
import type { StoredFile } from '../../contracts/storage.js';
import { DEVHOST_HANDLERS, FILES_PREFIX, SCRIPT_HOST_PROCESS } from '../grammar/devhost.js';
import { ctxP3 } from '../command-ctx-p3.js';

/** @since P3 [S32] The one file system of a host. */
export const HOST_FILES_FS = 'files' as const;
/** @since P3 [S32] A host that runs no script host. */
export const MSG_NO_SCRIPT_HOST = '% This host cannot run scripts.';
/** @since P3 [S32] A device whose file store cannot be read here. */
export const MSG_NO_FILE_STORE = '% This device keeps no files.';
/** @since P3 [S32] `dir` on an empty store. */
export const MSG_NO_FILES = 'No files.';
/** @since P3 [S32] The label of the script job (the terminal's status line). */
export const PYTHON_JOB_LABEL = 'python';

/** @since P3 [S32] `% There is no file named <name>.` */
export function msgNoSuchFile(name: string): string {
  return `% There is no file named ${name}.`;
}

/** @since P3 [S32] A typed file name without its quotes and its `files:` prefix. */
export function fileNameOf(typed: string | undefined): string {
  let name = (typed ?? '').trim();
  if (name.length >= 2 && name.startsWith('"') && name.endsWith('"')) name = name.slice(1, -1);
  if (name.toLowerCase().startsWith(FILES_PREFIX)) name = name.slice(FILES_PREFIX.length);
  return name;
}

/** @since P3 [S32] One file of the device's store through the runtime's extension, or an error message. */
export function readStoredFile(ctx: CommandCtx, typed: string | undefined): StoredFile | { error: string } {
  const read = ctxP3(ctx).readFile;
  if (read === undefined) return { error: MSG_NO_FILE_STORE };
  const name = fileNameOf(typed);
  if (name === '') return { error: '% Give the file name.' };
  return read(HOST_FILES_FS, name) ?? { error: msgNoSuchFile(name) };
}

/** @since P3 [S32] `rest … -f <file>`: the request body read from the host's store, or an error message. */
export function restBodyFromFile(ctx: CommandCtx, typed: string | undefined): { body: string } | { error: string } {
  const file = readStoredFile(ctx, typed);
  return 'error' in file ? file : { body: file.content };
}

/** @since P3 [S32] The `rest` option that names a body file (one token, quoted or bare, like `-H` and `-u`). */
export const REST_FILE_OPTION = '-f';
/** @since P3 [S32] `rest` with both a typed body (`-d`) and a body file (`-f`). */
export const MSG_REST_FILE_AND_BODY = '% Give the body either after -d or as a file with -f, not both.';

/**
 * @since P3 [S32] The body of a `rest` request from its split options: the `-d` text as typed, or the content of the
 * `-f` file of the host's store; both is refused (`MSG_REST_FILE_AND_BODY`), neither is no body. The MUST `rest` job
 * (cli/handlers/api.ts) calls it once its option splitter has read `-f <file>` into `file`.
 */
export function restBodyOf(ctx: CommandCtx, opts: { readonly body?: string; readonly file?: string }): { body?: string } | { error: string } {
  if (opts.file === undefined) return opts.body === undefined ? {} : { body: opts.body };
  if (opts.body !== undefined) return { error: MSG_REST_FILE_AND_BODY };
  return restBodyFromFile(ctx, opts.file);
}

/** `python <file> [<args>]`. */
const python: CommandHandler = (ctx, args) => {
  if (!ctx.model.processes.includes(SCRIPT_HOST_PROCESS)) return { error: MSG_NO_SCRIPT_HOST };
  const name = fileNameOf(args['file']);
  if (name === '') return { error: '% Give the script file name.' };
  // a store the runtime can read is checked here, so a typo answers at once; the script host checks again
  const read = ctxP3(ctx).readFile;
  if (read !== undefined && read(HOST_FILES_FS, name) === undefined) return { error: msgNoSuchFile(name) };
  const tail = (args['args'] ?? '').trim();
  const argv = tail === '' ? [] : tail.split(/\s+/);
  const token = `py:${ctx.session.id}@${ctx.now}`;
  ctx.block({ process: SCRIPT_HOST_PROCESS, abort: { kind: 'script.stop', token }, label: PYTHON_JOB_LABEL });
  ctx.request(SCRIPT_HOST_PROCESS, { kind: 'script.run', token, file: name, argv, session: ctx.session.id });
  return {};
};

/** `type <file>`. */
const type: CommandHandler = (ctx, args) => {
  const file = readStoredFile(ctx, args['file']);
  if ('error' in file) return file;
  return { output: file.content.endsWith('\n') ? file.content.slice(0, -1) : file.content };
};

/** `del <file>`. */
const del: CommandHandler = (ctx, args) => {
  const file = readStoredFile(ctx, args['file']);
  if ('error' in file) return file;
  ctx.act([{ type: 'storage', op: 'delete', fs: HOST_FILES_FS, path: file.path }]);
  return { output: `Deleted ${file.path}.` };
};

/** `dir`. */
const dir: CommandHandler = (ctx) => {
  const list = ctxP3(ctx).files;
  if (list === undefined) return { error: MSG_NO_FILE_STORE };
  const files = list(HOST_FILES_FS);
  if (files.length === 0) return { output: MSG_NO_FILES };
  const width = Math.max(5, ...files.map((f) => String(f.size).length));
  const total = files.reduce((n, f) => n + f.size, 0);
  const lines = [`Contents of ${FILES_PREFIX}`, '', `${'Bytes'.padStart(width)}  Name`];
  for (const f of files) lines.push(`${String(f.size).padStart(width)}  ${f.path}`);
  lines.push('', `${files.length} file${files.length === 1 ? '' : 's'}, ${total} byte${total === 1 ? '' : 's'}`);
  return { output: lines.join('\n') };
};

/** @since P3 [S32] Registry fragment: developer-host shell handler id → handler. */
export const devhostHandlers: Readonly<Record<string, CommandHandler>> = {
  [DEVHOST_HANDLERS.hostPython]: python,
  [DEVHOST_HANDLERS.hostType]: type,
  [DEVHOST_HANDLERS.hostDel]: del,
  [DEVHOST_HANDLERS.hostDir]: dir,
};
