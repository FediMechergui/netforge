/**
 * cli/runtime.ts P1 input channel, login stage and secrets (ARCHITECTURE-P1 §4.10): `CommandOutcome.ask` →
 * `CliResult.input` / `cliPrompt.input` / `CliSessionView.input`; answers are not parsed and never enter history;
 * three failed answers end the command with a denial; `interrupt` drops the question; headless configure refuses;
 * console and vty login with banners; `login local`; nf1 hashes (FNV-1a-64), nf7 reversible values, and secret args
 * masked in history.
 */
import { describe, expect, it } from 'vitest';
import type { CliInputRequest, CliRuntime, CommandHandler, CommandOutcome, CommandSpec } from '../src/contracts/cli.js';
import { CLI_MESSAGES } from '../src/contracts/cli.js';
import type { DeviceId } from '../src/contracts/ids.js';
import type { TraceEvent } from '../src/contracts/trace.js';
import { CONFIG_SECRET_MASK } from '../src/cli/config-rules.js';
import {
  bannerOf,
  createCliRuntime,
  decodeReversibleSecret,
  encodeReversibleSecret,
  fnv1a64Hex,
  hashSecret,
  lineAuthOf,
  maskSpans,
  MAX_INPUT_ATTEMPTS,
  MSG_INPUT_DENIED,
  MSG_LOGIN_DENIED,
  MSG_LOGIN_DENIED_CLOSED,
  MSG_LOGIN_FAILED,
  PASSWORD_PROMPT,
  secretsFor,
  USERNAME_PROMPT,
  verifySecret,
} from '../src/cli/runtime.js';
import { ArrayTrace, fakeCatalog, INERT_RF_VIEWS } from './cli.runtime.fake.js';
import { catalogModel, P05Device } from './cli.runtime.p05.fixture.js';

const ROUTER = 'router.nf2911';
const CONFIRM: CliInputRequest = { kind: 'confirm', prompt: 'Continue? [y/n] ' };

/** Attempts seen by the test `enable` resume, per call. */
const attemptsSeen: number[] = [];

/** `enable`: asks for the enable secret when one is stored; wrong answers ask the same question again. */
const enableHandler: CommandHandler = (ctx) => {
  const stored = ctx.running.get('enable.secret')?.slice(1).join(' ');
  const grant = (): CommandOutcome => {
    ctx.setPrivilege(15);
    ctx.setMode('priv-exec');
    return {};
  };
  if (stored === undefined) return grant();
  const resume = (rctx: typeof ctx, answer: string, attempt: number): CommandOutcome => {
    attemptsSeen.push(attempt);
    if (rctx.secrets.verify(stored, answer)) {
      rctx.setPrivilege(15);
      rctx.setMode('priv-exec');
      return {};
    }
    return { ask: { request: { ...PASSWORD_PROMPT }, resume } };
  };
  return { ask: { request: { ...PASSWORD_PROMPT }, resume } };
};

/** `wizard`: a confirm question, then a secret question; success reports the attempt number it arrived on. */
const wizardHandler: CommandHandler = () => {
  const secretStep = (_c: unknown, answer: string, attempt: number): CommandOutcome =>
    answer === 'right' ? { output: `accepted on attempt ${attempt}` } : { ask: { request: { ...PASSWORD_PROMPT }, resume: secretStep } };
  return {
    output: 'Starting the wizard.',
    ask: {
      request: CONFIRM,
      resume: (_c, answer) => (answer === 'y' ? { ask: { request: { ...PASSWORD_PROMPT }, resume: secretStep } } : { output: 'Cancelled.' }),
    },
  };
};

const SPECS: CommandSpec[] = [
  { path: ['enable'], mode: 'user-exec', privilege: 0, help: 'Raise privilege', handler: 'i.enable', grammars: ['nfos'], sessionEffect: 'privilege', interactive: true },
  { path: ['configure', 'terminal'], mode: 'priv-exec', privilege: 15, help: 'Configure', handler: 'i.conf', entersMode: 'config', grammars: ['nfos'] },
  { path: ['end'], mode: '@config', privilege: 15, help: 'Back', handler: 'i.end', entersMode: 'priv-exec', grammars: ['nfos'] },
  {
    path: ['enable', 'secret', '<secret>'], mode: 'config', privilege: 15, help: 'Set the enable secret', handler: 'i.enable-secret',
    args: { secret: { type: 'secret', help: 'The secret', maxLength: 63 } }, grammars: ['nfos'],
  },
  { path: ['wizard'], mode: '@exec', privilege: 0, help: 'Two questions', handler: 'i.wizard', interactive: true },
  { path: ['whoami'], mode: '@exec', privilege: 0, help: 'Session state', handler: 'i.whoami' },
];

const HANDLERS: Record<string, CommandHandler> = {
  'i.enable': enableHandler,
  'i.conf': (ctx) => {
    ctx.setMode('config');
    return {};
  },
  'i.end': (ctx) => {
    ctx.setMode('priv-exec');
    return {};
  },
  'i.enable-secret': (ctx, args) => {
    const err = ctx.config(['enable', 'secret', ctx.secrets.hash(args['secret'] ?? '')], false);
    return err === undefined ? {} : { error: err };
  },
  'i.wizard': wizardHandler,
  'i.whoami': (ctx) => ({ output: `${ctx.session.mode} ${ctx.session.privilege}` }),
};

interface H {
  cli: CliRuntime;
  trace: ArrayTrace;
  dev: P05Device;
}

function harness(): H {
  const devices = new Map<DeviceId, P05Device>();
  const trace = new ArrayTrace();
  const cli = createCliRuntime(
    { device: (id) => devices.get(id), catalog: fakeCatalog, trace, now: () => 5, grammar: SPECS, ...INERT_RF_VIEWS },
    HANDLERS,
  );
  const dev = new P05Device('d_r1', catalogModel(ROUTER), 'R1');
  devices.set(dev.id, dev);
  return { cli, trace, dev };
}

function prompts(h: H): Extract<TraceEvent, { kind: 'cliPrompt' }>[] {
  return h.trace.of('cliPrompt') as Extract<TraceEvent, { kind: 'cliPrompt' }>[];
}

function outputs(h: H): string[] {
  return (h.trace.of('cliOutput') as Extract<TraceEvent, { kind: 'cliOutput' }>[]).map((e) => e.text);
}

/** A router with `enable secret <plain>` set through the CLI, back at user EXEC. */
function withEnableSecret(plain: string): { h: H; id: string } {
  const h = harness();
  const id = h.cli.open('d_r1', 'console');
  h.cli.exec(id, 'enable');
  h.cli.exec(id, 'configure terminal');
  h.cli.exec(id, `enable secret ${plain}`);
  h.cli.close(id);
  const fresh = h.cli.open('d_r1', 'console');
  return { h, id: fresh };
}

describe('secrets', () => {
  it('FNV-1a 64 matches the published test vectors', () => {
    const enc = new TextEncoder();
    expect(fnv1a64Hex(enc.encode(''))).toBe('cbf29ce484222325');
    expect(fnv1a64Hex(enc.encode('a'))).toBe('af63dc4c8601ec8c');
    expect(fnv1a64Hex(enc.encode('foobar'))).toBe('85944171f73967e8');
  });

  it('nf1 hashes are salted by the device id and deterministic', () => {
    const a = hashSecret('d_r1', 'class');
    expect(a).toMatch(/^nf1\$[0-9a-f]{16}$/);
    expect(a).toBe(`nf1$${fnv1a64Hex(new TextEncoder().encode('d_r1class'))}`);
    expect(hashSecret('d_r1', 'class')).toBe(a);
    expect(hashSecret('d_r2', 'class')).not.toBe(a);
    expect(verifySecret('d_r1', a, 'class')).toBe(true);
    expect(verifySecret('d_r1', a.replace('$', ' '), 'class')).toBe(true);
    expect(verifySecret('d_r1', a, 'Class')).toBe(false);
    expect(verifySecret('d_r2', a, 'class')).toBe(false);
    const s = secretsFor('d_r1');
    expect(s.hash('class')).toBe(a);
    expect(s.verify(a, 'class')).toBe(true);
  });

  it('nf7 values are reversible; plain stored values compare exactly', () => {
    const enc = encodeReversibleSecret('line pw é');
    expect(enc).toMatch(/^nf7\$[0-9a-f]+$/);
    expect(decodeReversibleSecret(enc)).toBe('line pw é');
    expect(decodeReversibleSecret(enc.replace('$', ' '))).toBe('line pw é');
    expect(decodeReversibleSecret('nf7$abc')).toBeNull();
    expect(verifySecret('any', enc, 'line pw é')).toBe(true);
    expect(verifySecret('any', 'letmein', 'letmein')).toBe(true);
    expect(verifySecret('any', 'letmein', 'letmein ')).toBe(false);
  });

  it('maskSpans replaces each span with the config mask', () => {
    expect(maskSpans('key abc level 3', [{ column: 4, end: 7 }])).toBe(`key ${CONFIG_SECRET_MASK} level 3`);
    expect(maskSpans('a b c', [{ column: 0, end: 1 }, { column: 4, end: 5 }])).toBe(`${CONFIG_SECRET_MASK} b ${CONFIG_SECRET_MASK}`);
  });
});

describe('input requests', () => {
  it('enable with a secret asks for it, masks nothing into history and verifies the answer', () => {
    const { h, id } = withEnableSecret('topsecret');
    expect(h.dev.running.get('enable.secret')?.[1]).toBe(hashSecret('d_r1', 'topsecret'));
    h.trace.events.length = 0;
    attemptsSeen.length = 0;

    const r = h.cli.exec(id, 'enable');
    expect(r).toEqual({ output: '', mode: 'user-exec', prompt: 'R1>', busy: false, input: { kind: 'secret', prompt: 'Password: ' } });
    expect(h.cli.session(id)!.input).toEqual({ kind: 'secret', prompt: 'Password: ' });
    expect(prompts(h).at(-1)).toEqual({ t: 5, kind: 'cliPrompt', session: id, prompt: 'R1>', busy: false, input: { kind: 'secret', prompt: 'Password: ' } });
    // help and completion are silent while a question is pending
    expect(h.cli.help(id, '')).toEqual({ items: [] });
    expect(h.cli.complete(id, 'en')).toEqual({ items: [] });

    const wrong = h.cli.exec(id, 'guess');
    expect(wrong.input).toEqual({ kind: 'secret', prompt: 'Password: ' });
    expect(wrong.mode).toBe('user-exec');

    const right = h.cli.exec(id, 'topsecret');
    expect(right.input).toBeUndefined();
    expect(right.mode).toBe('priv-exec');
    expect(right.prompt).toBe('R1#');
    expect(h.cli.session(id)!.input).toBeUndefined();
    expect(h.cli.session(id)!.privilege).toBe(15);
    expect(attemptsSeen).toEqual([1, 2]);
    expect(prompts(h).at(-1)).toEqual({ t: 5, kind: 'cliPrompt', session: id, prompt: 'R1#', busy: false });
    expect(h.cli.session(id)!.history).toEqual(['enable']);
  });

  it('three wrong answers end the command with the denial', () => {
    const { h, id } = withEnableSecret('topsecret');
    attemptsSeen.length = 0;
    h.cli.exec(id, 'enable');
    expect(h.cli.exec(id, 'one').input).toBeDefined();
    expect(h.cli.exec(id, 'two').input).toBeDefined();
    const last = h.cli.exec(id, 'three');
    expect(MAX_INPUT_ATTEMPTS).toBe(3);
    expect(last).toEqual({ output: MSG_INPUT_DENIED, error: { message: MSG_INPUT_DENIED }, mode: 'user-exec', prompt: 'R1>', busy: false });
    expect(attemptsSeen).toEqual([1, 2, 3]);
    expect(h.cli.session(id)!.input).toBeUndefined();
    // the next line is a command again
    expect(h.cli.exec(id, 'whoami').output).toBe('user-exec 1');
  });

  it('answers are taken verbatim (only the line ending goes); an empty answer counts', () => {
    const { h, id } = withEnableSecret('topsecret');
    h.cli.exec(id, 'enable');
    expect(h.cli.exec(id, '').input).toEqual(PASSWORD_PROMPT);
    expect(h.cli.exec(id, ' topsecret').input).toEqual(PASSWORD_PROMPT);
    expect(h.cli.exec(id, 'topsecret\r\n').mode).toBe('priv-exec');
  });

  it('a different question starts again at attempt 1; handler output precedes the question', () => {
    const h = harness();
    const id = h.cli.open('d_r1', 'console');
    const first = h.cli.exec(id, 'wizard');
    expect(first.output).toBe('Starting the wizard.');
    expect(first.input).toEqual(CONFIRM);
    expect(h.cli.exec(id, 'y').input).toEqual(PASSWORD_PROMPT);
    expect(h.cli.exec(id, 'nope').input).toEqual(PASSWORD_PROMPT);
    const done = h.cli.exec(id, 'right');
    expect(done.output).toBe('accepted on attempt 2');
    expect(done.input).toBeUndefined();
    expect(h.cli.session(id)!.history).toEqual(['wizard']);
  });

  it('interrupt drops the pending question', () => {
    const h = harness();
    const id = h.cli.open('d_r1', 'console');
    h.cli.exec(id, 'wizard');
    h.trace.events.length = 0;
    h.cli.interrupt(id);
    expect(h.cli.session(id)!.input).toBeUndefined();
    expect(prompts(h)).toEqual([{ t: 5, kind: 'cliPrompt', session: id, prompt: 'R1>', busy: false }]);
    expect(h.cli.exec(id, 'whoami').output).toBe('user-exec 1');
  });

  it('headless configure refuses a command that asks', () => {
    const { h } = withEnableSecret('topsecret');
    const r = h.cli.configure('d_r1', ['wizard'], { startMode: 'priv-exec' });
    expect(r.ok).toBe(false);
    expect(r.lines[0]!.error).toEqual({ message: CLI_MESSAGES.notHeadless });
  });

  it('a secret typed on a command line is masked in history', () => {
    const h = harness();
    const id = h.cli.open('d_r1', 'console');
    h.cli.exec(id, 'enable');
    h.cli.exec(id, 'configure terminal');
    h.cli.exec(id, 'enable secret  two words ');
    expect(h.cli.session(id)!.history).toEqual(['enable', 'configure terminal', `enable secret  ${CONFIG_SECRET_MASK}`]);
    expect(verifySecret('d_r1', h.dev.running.get('enable.secret')!.slice(1).join(' '), 'two words')).toBe(true);
  });

  it('a secret is masked in history even when the line does not parse', () => {
    const h = harness();
    const id = h.cli.open('d_r1', 'console');
    h.cli.exec(id, 'enable');
    // the wrong mode: `enable secret` only exists in configuration, so the line never matches
    // the wrong mode: `enable secret` only exists in configuration, so the line never matches
    expect(h.cli.exec(id, 'enable secret hunter2').error).toBeDefined();
    h.cli.exec(id, 'configure terminal');
    // and a value the parser refuses was typed in the clear all the same
    // and a value the parser refuses was typed in the clear all the same
    expect(h.cli.exec(id, `enable secret ${'x'.repeat(70)}`).error).toBeDefined();
    expect(h.cli.session(id)!.history).toEqual([
      'enable',
      `enable secret ${CONFIG_SECRET_MASK}`,
      'configure terminal',
      `enable secret ${CONFIG_SECRET_MASK}`,
    ]);
  });
});

describe('login stage', () => {
  function withLine(h: H, type: string[], lines: string[][]): void {
    h.dev.running.set([], ['line', ...type]);
    for (const l of lines) h.dev.running.set([['line', ...type]], l);
  }

  it('reads the line section, the user table and the banners from the running config', () => {
    const h = harness();
    expect(lineAuthOf(h.dev.running, 'console')).toBeUndefined();
    withLine(h, ['con', '0'], [['password', 'letmein']]);
    expect(lineAuthOf(h.dev.running, 'console')).toBeUndefined();
    h.dev.running.set([['line', 'con', '0']], ['login']);
    expect(lineAuthOf(h.dev.running, 'console')).toEqual({ local: false, password: 'letmein' });
    expect(lineAuthOf(h.dev.running, 'vty')).toBeUndefined();
    h.dev.running.set([], ['banner', 'exec', 'Welcome']);
    expect(bannerOf(h.dev.running, 'exec')).toBe('Welcome');
    expect(bannerOf(h.dev.running, 'motd')).toBeUndefined();
  });

  it('console login: banners, secret prompt, failures, then user EXEC with the exec banner', () => {
    const h = harness();
    withLine(h, ['con', '0'], [['password', 'letmein'], ['login']]);
    h.dev.running.set([], ['banner', 'motd', 'Lab equipment']);
    h.dev.running.set([], ['banner', 'login', 'Authorised staff only']);
    h.dev.running.set([], ['banner', 'exec', 'Session started']);
    const id = h.cli.open('d_r1', 'console');
    expect(outputs(h)).toEqual(['Lab equipment', 'Authorised staff only']);
    expect(prompts(h)).toEqual([{ t: 5, kind: 'cliPrompt', session: id, prompt: 'R1>', busy: false, input: PASSWORD_PROMPT }]);
    const view = h.cli.session(id)!;
    expect(view.mode).toBe('login');
    expect(view.privilege).toBe(0);
    expect(view.input).toEqual(PASSWORD_PROMPT);

    expect(h.cli.exec(id, 'wrong').input).toEqual(PASSWORD_PROMPT);
    const ok = h.cli.exec(id, 'letmein');
    expect(ok).toEqual({ output: 'Session started', mode: 'user-exec', prompt: 'R1>', busy: false });
    expect(h.cli.session(id)!.privilege).toBe(1);
    expect(h.cli.session(id)!.history).toEqual([]);
  });

  it('three wrong console passwords deny; the console waits and any line starts over', () => {
    const h = harness();
    withLine(h, ['con', '0'], [['password', 'letmein'], ['login']]);
    const id = h.cli.open('d_r1', 'console');
    h.cli.exec(id, 'a');
    h.cli.exec(id, 'b');
    const denied = h.cli.exec(id, 'c');
    expect(denied).toEqual({ output: MSG_LOGIN_DENIED, error: { message: MSG_LOGIN_DENIED }, mode: 'login', prompt: 'R1>', busy: false });
    expect(h.cli.session(id)!.input).toBeUndefined();
    expect(h.cli.help(id, '')).toEqual({ items: [] });
    const again = h.cli.exec(id, '');
    expect(again.input).toEqual(PASSWORD_PROMPT);
    expect(again.mode).toBe('login');
    expect(h.cli.exec(id, 'letmein').mode).toBe('user-exec');
  });

  it('three wrong vty passwords close the session', () => {
    const h = harness();
    withLine(h, ['vty', '0', '4'], [['password', 'remote'], ['login']]);
    const con = h.cli.open('d_r1', 'console');
    expect(h.cli.session(con)!.mode).toBe('user-exec');
    const id = h.cli.open('d_r1', 'vty');
    expect(h.cli.session(id)!.mode).toBe('login');
    h.cli.exec(id, 'x');
    h.cli.exec(id, 'y');
    const r = h.cli.exec(id, 'z');
    expect(r).toEqual({ output: MSG_LOGIN_DENIED_CLOSED, error: { message: MSG_LOGIN_DENIED_CLOSED }, mode: 'login', prompt: 'R1>', busy: false, closed: true });
    expect(h.cli.session(id)).toBeUndefined();
  });

  it('a reversibly encoded line password is accepted', () => {
    const h = harness();
    const enc = encodeReversibleSecret('letmein');
    withLine(h, ['con', '0'], [['password', ...enc.split('$')], ['login']]);
    const id = h.cli.open('d_r1', 'console');
    expect(h.cli.exec(id, 'letmein').mode).toBe('user-exec');
  });

  it('login local asks for a user name then its password', () => {
    const h = harness();
    withLine(h, ['con', '0'], [['login', 'local']]);
    h.dev.running.set([], ['username', 'ana', 'secret', hashSecret('d_r1', 'pw1')]);
    const id = h.cli.open('d_r1', 'console');
    expect(h.cli.session(id)!.input).toEqual(USERNAME_PROMPT);
    expect(h.cli.exec(id, 'ana').input).toEqual(PASSWORD_PROMPT);
    const bad = h.cli.exec(id, 'nope');
    expect(bad.output).toBe(MSG_LOGIN_FAILED);
    expect(bad.input).toEqual(USERNAME_PROMPT);
    h.cli.exec(id, 'bob');
    h.cli.exec(id, 'pw1');
    h.cli.exec(id, 'ana');
    const denied = h.cli.exec(id, 'still wrong');
    expect(denied.output).toBe(`${MSG_LOGIN_FAILED}\n${MSG_LOGIN_DENIED}`);
    expect(denied.input).toBeUndefined();
    h.cli.exec(id, '');
    h.cli.exec(id, 'ana');
    expect(h.cli.exec(id, 'pw1').mode).toBe('user-exec');
  });

  it('interrupt during login drops the question but keeps the login stage', () => {
    const h = harness();
    withLine(h, ['con', '0'], [['password', 'letmein'], ['login']]);
    const id = h.cli.open('d_r1', 'console');
    h.cli.interrupt(id);
    expect(h.cli.session(id)!.mode).toBe('login');
    expect(h.cli.session(id)!.input).toBeUndefined();
    expect(h.cli.exec(id, 'whoami').input).toEqual(PASSWORD_PROMPT);
  });

  it('a session opens straight into user EXEC without a login line, showing motd then exec banners', () => {
    const h = harness();
    h.dev.running.set([], ['banner', 'exec', 'Hello']);
    h.dev.running.set([], ['banner', 'motd', 'Notice']);
    const id = h.cli.open('d_r1', 'console');
    expect(outputs(h)).toEqual(['Notice', 'Hello']);
    expect(h.cli.session(id)!.mode).toBe('user-exec');
    expect(h.cli.session(id)!.input).toBeUndefined();
  });
});
