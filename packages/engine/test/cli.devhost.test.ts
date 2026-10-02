/**
 * cli.devhost — [S32] the developer host's shell (ARCHITECTURE-P3 §5.7, §5.9, D21; §7 W2 cli, approved items):
 * `python|python3 <file> [<args>]` as a `script-host` job (`script.run`, ^C → `script.stop`), `type`, `del` (the
 * `storage` action) and `dir` over the host's `files:` store as the runtime exposes it, and `restBodyFromFile` for
 * `rest … -f <file>`. Scope: the `programmable` capability (the test-only NF-DEVHOST of staged.world).
 */
import { describe, expect, it } from 'vitest';
import type { DeviceModel } from '../src/contracts/device.js';
import type { Action } from '../src/contracts/process.js';
import type { FileSystemId, StoredFile, StoredFileMeta } from '../src/contracts/storage.js';
import { DEVHOST_HANDLERS as H } from '../src/cli/grammar/devhost.js';
import {
  fileNameOf,
  MSG_NO_FILE_STORE,
  MSG_NO_FILES,
  MSG_NO_SCRIPT_HOST,
  MSG_REST_FILE_AND_BODY,
  msgNoSuchFile,
  restBodyFromFile,
  restBodyOf,
} from '../src/cli/handlers/devhost.js';
import { matchCommand } from '../src/cli/parser.js';
import { defineStagedModel, nfDevhostTestInput } from './staged.world.js';
import { APPROVED_GRAMMAR, APPROVED_HANDLERS, approvedHarness, withProcesses } from './cli.p3-approved.fixture.js';
import { catalogModel, commandCtxFor, matchContextFor, type RecordingCtx } from './cli.p05.fixture.js';

const INVENTORY = 'import requests\nprint("ok")\n';

/** The test-only NF-DEVHOST with the script host among its daemons (its factory arrives with the W6 flip). */
function devhostModel(): DeviceModel {
  const m = defineStagedModel(nfDevhostTestInput(), 'P3');
  return { ...m, processes: [...m.processes, 'script-host'] };
}

/** A small in-memory store with the runtime's reader shape. */
function store(files: Record<string, string>): { files(fs: FileSystemId): readonly StoredFileMeta[]; readFile(fs: FileSystemId, path: string): StoredFile | undefined } {
  return {
    files: (fs) => Object.keys(files).sort().map((path) => ({ fs, path, size: (files[path] ?? '').length, modifiedAt: 0 })),
    readFile: (fs, path) => {
      const content = files[path];
      return content === undefined ? undefined : { fs, path, size: content.length, modifiedAt: 0, content };
    },
  };
}

/** A recording context on the developer host with a file store and a recording `act`. */
function devCtx(files: Record<string, string>, model = devhostModel()): RecordingCtx & { acts: Action[] } {
  const rec = commandCtxFor(model, { mode: 'user-exec' });
  const acts: Action[] = [];
  Object.assign(rec.ctx, store(files), { act: (a: Action[]) => acts.push(...a) });
  return { ...rec, acts };
}

function run(rec: RecordingCtx, id: string, args: Record<string, string> = {}) {
  const h = APPROVED_HANDLERS[id];
  if (h === undefined) throw new Error(`no handler ${id}`);
  return h(rec.ctx, args, false);
}

describe('cli.devhost grammar', () => {
  it('offers the scripting shell on a programmable host only', () => {
    const dev = matchContextFor(devhostModel(), 'user-exec');
    const handler = (line: string): string => {
      const m = matchCommand(APPROVED_GRAMMAR, dev, line);
      if (!m.ok) throw new Error(`${line}: ${m.error.message}`);
      return m.spec.handler;
    };
    expect(handler('python inventory.py')).toBe(H.hostPython);
    expect(handler('python3 "my script.py" R1 R2')).toBe(H.hostPython);
    expect(handler('type files:inventory.py')).toBe(H.hostType);
    expect(handler('del inventory.py')).toBe(H.hostDel);
    expect(handler('dir')).toBe(H.hostDir);
    const m = matchCommand(APPROVED_GRAMMAR, dev, 'python inventory.py --all');
    expect(m.ok && m.args).toMatchObject({ file: 'inventory.py', args: '--all' });
    expect(m.ok && m.spec.job).toBe(true);
    expect(matchCommand(APPROVED_GRAMMAR, matchContextFor(catalogModel('pc.nfpc'), 'user-exec'), 'dir').ok).toBe(false);
  });
});

describe('cli.devhost handlers', () => {
  it('python starts a script-host job for an existing file', () => {
    const rec = devCtx({ 'inventory.py': INVENTORY });
    expect(run(rec, H.hostPython, { file: 'files:inventory.py', args: 'R1  R2' })).toEqual({});
    expect(rec.deviceCalls).toContain('block');
    expect(rec.requests).toEqual([
      { to: 'script-host', req: { kind: 'script.run', token: 'py:s_1@0', file: 'inventory.py', argv: ['R1', 'R2'], session: 's_1' } },
    ]);
    expect(run(devCtx({}), H.hostPython, { file: 'missing.py' })).toEqual({ error: msgNoSuchFile('missing.py') });
    const noHost = devCtx({ 'inventory.py': INVENTORY }, defineStagedModel(nfDevhostTestInput(), 'P3'));
    expect(run(noHost, H.hostPython, { file: 'inventory.py' })).toEqual({ error: MSG_NO_SCRIPT_HOST });
  });

  it('type prints a file, del removes it through the storage action, dir lists the store', () => {
    const rec = devCtx({ 'inventory.py': INVENTORY, 'b.json': '{}' });
    expect(run(rec, H.hostType, { file: '"inventory.py"' })).toEqual({ output: 'import requests\nprint("ok")' });
    expect(run(rec, H.hostType, { file: 'nope.txt' })).toEqual({ error: msgNoSuchFile('nope.txt') });
    expect(run(rec, H.hostDel, { file: 'b.json' })).toEqual({ output: 'Deleted b.json.' });
    expect(rec.acts).toEqual([{ type: 'storage', op: 'delete', fs: 'files', path: 'b.json' }]);
    expect(run(rec, H.hostDir)).toEqual({
      output: ['Contents of files:', '', 'Bytes  Name', '    2  b.json', `   ${INVENTORY.length}  inventory.py`, '', '2 files, 30 bytes'].join('\n'),
    });
    expect(run(devCtx({}), H.hostDir)).toEqual({ output: MSG_NO_FILES });
    // a hand-built context without the runtime's store
    const bare = commandCtxFor(devhostModel(), { mode: 'user-exec' });
    expect(run(bare, H.hostDir)).toEqual({ error: MSG_NO_FILE_STORE });
  });

  it('rest -f reads the body from the store', () => {
    const rec = devCtx({ 'body.json': '{"name": "R1"}' });
    expect(restBodyFromFile(rec.ctx, 'files:body.json')).toEqual({ body: '{"name": "R1"}' });
    expect(restBodyFromFile(rec.ctx, 'x.json')).toEqual({ error: msgNoSuchFile('x.json') });
    expect(fileNameOf('"files:a b.py"')).toBe('a b.py');
    // the body of a rest request from its split options: -d as typed, or the -f file; both is refused
    expect(restBodyOf(rec.ctx, { file: 'body.json' })).toEqual({ body: '{"name": "R1"}' });
    expect(restBodyOf(rec.ctx, { body: '{"a": [1, 2]}' })).toEqual({ body: '{"a": [1, 2]}' });
    expect(restBodyOf(rec.ctx, {})).toEqual({});
    expect(restBodyOf(rec.ctx, { body: 'x', file: 'body.json' })).toEqual({ error: MSG_REST_FILE_AND_BODY });
    expect(restBodyOf(rec.ctx, { file: 'missing.json' })).toEqual({ error: msgNoSuchFile('missing.json') });
    expect(restBodyOf(commandCtxFor(devhostModel(), { mode: 'user-exec' }).ctx, { file: 'body.json' })).toEqual({ error: MSG_NO_FILE_STORE });
  });
});

describe('cli.devhost through the runtime', () => {
  it('reads the device store, and ^C stops the script with its token', () => {
    const h = approvedHarness();
    const pc = withProcesses(h.add('d_dev', 'pc', 'DEV1'), 'script-host');
    // the hand-built device carries the store the way the device runtime does (files / readFile)
    Object.assign(pc, store({ 'inventory.py': INVENTORY }));
    // the fake's model is a plain PC: give it `programmable` so the shell offers the commands
    Object.defineProperty(pc, 'capabilities', { value: [...pc.capabilities, 'programmable'] });
    const s = h.cli.open('d_dev', 'console');
    h.clock.now = 42;
    expect(h.cli.exec(s, 'type inventory.py').output).toBe('import requests\nprint("ok")');
    expect(h.cli.exec(s, 'python inventory.py')).toMatchObject({ busy: true });
    expect(h.cli.session(s)?.job).toEqual({ process: 'script-host', label: 'python' });
    h.cli.interrupt(s);
    const reqs = pc.actionCalls.flatMap((c) => c.actions).flatMap((a) => (a.type === 'request' ? [a.req] : []));
    expect(reqs).toEqual([
      { kind: 'script.run', token: `py:${s}@42`, file: 'inventory.py', argv: [], session: s },
      { kind: 'script.stop', token: `py:${s}@42` },
    ]);
  });
});
