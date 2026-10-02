/**
 * The host-shell `rest` job and the device API lines (ARCHITECTURE-P3 §5.6, D21, §3.8; §7 W2 cli part 1, cli/grammar/
 * api.ts and cli/handlers/api.ts): the option splitting (`-H "Name: value"` repeatable, `-u user:password`, and `-d`,
 * which comes last and takes the rest of the line verbatim, so a JSON body with quotes, brackets and spaces arrives
 * byte for byte), the headers sent (Accept by default, Basic authentication), the `http.request {owner: 'cli'}` job,
 * the refusals, and the `ip http secure-server`, `ip http authentication local` and `restconf` lines.
 */
import { describe, expect, it } from 'vitest';
import { CLI_MESSAGES, type CliJob, type CommandHandler, type CommandOutcome } from '../src/contracts/cli.js';
import type { ProcessRequest } from '../src/contracts/process.js';
import { SEC } from '../src/contracts/time.js';
import { GRAMMAR, HANDLERS } from '../src/cli/grammar/index.js';
import { HANDLER_REGISTRY } from '../src/cli/handlers/index.js';
import {
  base64,
  MSG_REST_BODY,
  MSG_REST_HEADER,
  MSG_REST_OPTION,
  MSG_REST_USER,
  MSG_REST_VALUE,
  REST_DEFAULT_ACCEPT,
  restHeaders,
  splitRestOptions,
} from '../src/cli/handlers/api.js';
import { matchCommand, MSG_STRAY_QUOTE, MSG_UNCLOSED_QUOTE } from '../src/cli/parser.js';
import { catalogModel, commandCtxFor, matchContextFor, type RecordingCtx } from './cli.p05.fixture.js';
import { createStagedSimulation } from './staged.world.js';

const PC = catalogModel('pc.nfpc');
const SERVER = catalogModel('server.nfserver');
const ROUTER = catalogModel('router.nf2911');
const SWITCH = catalogModel('switch.nfc2960');
const URL = 'https://10.0.99.11/restconf/data/ietf-interfaces:interfaces';
/** A JSON body with quotes, brackets, a pipe and runs of spaces, typed unquoted after -d. */
const BODY = '{"ietf-interfaces:interface": [{"name": "Loopback1",  "description": "lab  [one] | two", "enabled": true}]}';

function run(rec: RecordingCtx, id: string, args: Record<string, string> = {}, negate = false): CommandOutcome {
  const h: CommandHandler | undefined = HANDLER_REGISTRY[id];
  if (h === undefined) throw new Error(`no handler ${id}`);
  return h(rec.ctx, args, negate);
}

/** A host command context that records the jobs it blocks on. */
function host(model = PC): { rec: RecordingCtx; jobs: (CliJob | undefined)[] } {
  const rec = commandCtxFor(model, { mode: 'user-exec' });
  const jobs: (CliJob | undefined)[] = [];
  (rec.ctx as { block: (job?: CliJob) => void }).block = (job) => { jobs.push(job); };
  return { rec, jobs };
}

/** The line typed, parsed on a host and run through its handler. */
function typed(rec: RecordingCtx, line: string): CommandOutcome {
  const m = matchCommand(GRAMMAR, matchContextFor(rec.ctx.model, 'user-exec'), line);
  if (!m.ok) throw new Error(`${line}: ${m.error.message}`);
  return run(rec, m.spec.handler, { ...m.args }, m.negated);
}

const decode = (bytes: Uint8Array | undefined): string | undefined => (bytes === undefined ? undefined : new TextDecoder().decode(bytes));

describe('splitRestOptions', () => {
  it('reads -H (repeatable, quoted or bare), -u and -d', () => {
    expect(splitRestOptions('')).toEqual({ headers: [] });
    expect(splitRestOptions('-H "Content-Type: application/yang-data+json" -H X-Lab:one -u admin:Lab-Pass')).toEqual({
      headers: [['Content-Type', 'application/yang-data+json'], ['X-Lab', 'one']],
      user: { name: 'admin', password: 'Lab-Pass' },
    });
    expect(splitRestOptions('-u "admin:pass with spaces"')).toEqual({ headers: [], user: { name: 'admin', password: 'pass with spaces' } });
  });

  it('-d takes the rest of the line verbatim: quotes, brackets, pipes and spaces', () => {
    expect(splitRestOptions(`-d ${BODY}`)).toEqual({ headers: [], body: BODY });
    expect(splitRestOptions(`-u a:b -d    ${BODY}`)).toEqual({ headers: [], user: { name: 'a', password: 'b' }, body: BODY });
    expect(splitRestOptions('-d "quoted"  stays "as typed"')).toEqual({ headers: [], body: '"quoted"  stays "as typed"' });
  });

  it('-d must be last: whatever follows it is body, not options', () => {
    expect(splitRestOptions('-d {"a": 1} -H "X: y" -u a:b')).toEqual({ headers: [], body: '{"a": 1} -H "X: y" -u a:b' });
    expect(splitRestOptions('-H "X: y" -d [1, 2]')).toEqual({ headers: [['X', 'y']], body: '[1, 2]' });
  });

  it('refuses what does not read, with original messages', () => {
    expect(splitRestOptions('-d')).toBe(MSG_REST_BODY);
    expect(splitRestOptions('-d   ')).toBe(MSG_REST_BODY);
    expect(splitRestOptions('-X PUT')).toBe(MSG_REST_OPTION('-X'));
    expect(splitRestOptions('{"a":1}')).toBe(MSG_STRAY_QUOTE);
    expect(splitRestOptions('-H')).toBe(MSG_REST_VALUE('-H'));
    expect(splitRestOptions('-u')).toBe(MSG_REST_VALUE('-u'));
    expect(splitRestOptions('-H "Content-Type: x')).toBe(MSG_UNCLOSED_QUOTE);
    expect(splitRestOptions('-H "A: b"c')).toBe(MSG_STRAY_QUOTE);
    expect(splitRestOptions('-H novalue')).toBe(MSG_REST_HEADER);
    expect(splitRestOptions('-H ": x"')).toBe(MSG_REST_HEADER);
    expect(splitRestOptions('-u nocolon')).toBe(MSG_REST_USER);
  });
});

describe('headers', () => {
  it('adds Accept unless typed, and Basic authentication from -u (RFC 7617)', () => {
    expect(base64(new TextEncoder().encode('Aladdin:open sesame'))).toBe('QWxhZGRpbjpvcGVuIHNlc2FtZQ==');
    expect(base64(new TextEncoder().encode('ab'))).toBe('YWI=');
    expect(restHeaders({ headers: [] })).toEqual([['Accept', REST_DEFAULT_ACCEPT]]);
    expect(restHeaders({ headers: [['accept', 'application/json']], user: { name: 'admin', password: 'Lab-Pass' } })).toEqual([
      ['accept', 'application/json'],
      ['Authorization', `Basic ${base64(new TextEncoder().encode('admin:Lab-Pass'))}`],
    ]);
    expect(restHeaders({ headers: [['Authorization', 'Bearer x']], user: { name: 'a', password: 'b' } })).toEqual([
      ['Authorization', 'Bearer x'],
      ['Accept', REST_DEFAULT_ACCEPT],
    ]);
  });
});

describe('the rest job', () => {
  it('parses on every host, with the options as one verbatim argument', () => {
    for (const model of [PC, SERVER]) {
      const m = matchCommand(GRAMMAR, matchContextFor(model, 'user-exec'), `rest PUT ${URL} -H "Content-Type: application/yang-data+json" -d ${BODY}`);
      expect(m).toMatchObject({ ok: true, spec: { handler: HANDLERS.hostRest, job: true }, args: { method: 'PUT', url: URL } });
      if (m.ok) expect(m.args['options']).toBe(`-H "Content-Type: application/yang-data+json" -d ${BODY}`);
    }
    expect(matchCommand(GRAMMAR, matchContextFor(PC, 'user-exec'), `rest GET ${URL}`)).toMatchObject({ ok: true });
    expect(matchCommand(GRAMMAR, matchContextFor(PC, 'user-exec'), `rest FETCH ${URL}`)).toMatchObject({ ok: false, kind: 'invalid-arg' });
    expect(matchCommand(GRAMMAR, matchContextFor(ROUTER, 'priv-exec'), `rest GET ${URL}`).ok).toBe(false);
  });

  it('blocks on http-client, then sends http.request {owner: cli} with the body byte for byte', () => {
    const { rec, jobs } = host();
    expect(typed(rec, `rest PUT ${URL} -H "Content-Type: application/yang-data+json" -u admin:Lab-Pass -d ${BODY}`)).toEqual({});
    expect(jobs).toEqual([{ process: 'http-client', abort: { kind: 'job.abort', session: 's_1' }, label: 'rest' }]);
    expect(rec.requests).toHaveLength(1);
    const { to, req } = rec.requests[0] as { to: string; req: Extract<ProcessRequest, { kind: 'http.request' }> };
    expect(to).toBe('http-client');
    expect(req).toMatchObject({ kind: 'http.request', owner: 'cli', method: 'PUT', url: URL, session: 's_1' });
    expect(req.headers).toEqual([
      ['Content-Type', 'application/yang-data+json'],
      ['Accept', REST_DEFAULT_ACCEPT],
      ['Authorization', `Basic ${base64(new TextEncoder().encode('admin:Lab-Pass'))}`],
    ]);
    expect(decode(req.body)).toBe(BODY);
    expect(req.token).toBe('rest:s_1:0');
  });

  it('sends no body without -d, and refuses bad options before any job starts', () => {
    const { rec, jobs } = host();
    expect(typed(rec, `rest GET ${URL}`)).toEqual({});
    const req = rec.requests[0]?.req as Extract<ProcessRequest, { kind: 'http.request' }>;
    expect(req.body).toBeUndefined();
    expect(req.headers).toEqual([['Accept', REST_DEFAULT_ACCEPT]]);
    const bad = host();
    expect(typed(bad.rec, `rest POST ${URL} -X PUT`)).toEqual({ error: MSG_REST_OPTION('-X') });
    expect(typed(bad.rec, `rest POST ${URL} -d`)).toEqual({ error: MSG_REST_BODY });
    expect(bad.jobs).toEqual([]);
    expect(bad.rec.requests).toEqual([]);
    expect(jobs).toHaveLength(1);
  });

  it('on a real P3-stage PC: the line runs as typed; without arguments it is incomplete', () => {
    const sim = createStagedSimulation({ seed: 7, stage: 'P3' });
    const pc = sim.addDevice({ type: 'pc.nfpc', name: 'PC1' });
    sim.runFor(30 * SEC);
    const s = sim.cli.open(pc, 'console');
    const bare = sim.cli.exec(s, 'rest');
    expect(bare.error).toBeDefined();
    expect(bare.busy).toBe(false);
    const started = sim.cli.exec(s, `rest PUT ${URL} -d ${BODY}`);
    expect(started.error).toBeUndefined();
    // http-client owns the job from here (it answers this unaddressed PC at once); the line was kept verbatim
    expect(sim.cli.session(s)?.history.at(-1)).toBe(`rest PUT ${URL} -d ${BODY}`);
  });
});

describe('device API lines', () => {
  it('parse on routers and managed switches and store as global lines', () => {
    for (const model of [ROUTER, SWITCH]) {
      const cfg = matchContextFor(model, 'config');
      expect(matchCommand(GRAMMAR, cfg, 'ip http secure-server')).toMatchObject({ ok: true, spec: { handler: HANDLERS.configIpHttpSecureServer } });
      expect(matchCommand(GRAMMAR, cfg, 'ip http authentication local')).toMatchObject({ ok: true, args: { method: 'local' } });
      expect(matchCommand(GRAMMAR, cfg, 'restconf')).toMatchObject({ ok: true, spec: { handler: HANDLERS.configRestconf } });
    }
    const r = commandCtxFor(ROUTER, { mode: 'config' });
    expect(run(r, HANDLERS.configRestconf)).toEqual({ output: CLI_MESSAGES.restconfNeedsSecureServer });
    expect(run(r, HANDLERS.configIpHttpSecureServer)).toEqual({});
    expect(run(r, HANDLERS.configIpHttpAuthentication, { method: 'local' })).toEqual({});
    expect(run(r, HANDLERS.configRestconf)).toEqual({});
    const text = r.running.render();
    expect(text).toContain('ip http secure-server\n');
    expect(text).toContain('ip http authentication local\n');
    expect(text).toContain('\nrestconf\n');
    for (const id of [HANDLERS.configRestconf, HANDLERS.configIpHttpSecureServer, HANDLERS.configIpHttpAuthentication]) expect(run(r, id, {}, true)).toEqual({});
    expect(r.running.render()).not.toMatch(/restconf|ip http/);
  });
});
