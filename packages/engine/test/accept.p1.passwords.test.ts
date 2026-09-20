/**
 * P1 acceptance — passwords and the login stage (ARCHITECTURE-P1 §10.2 `accept.p1.passwords`; §4.10).
 *
 * One router on its own console. The secret is set the way a student sets it, and everything afterwards is read
 * back from the engine: the tokens the running config renders, the input request the runtime hands the terminal,
 * the session view while the question is pending, and the privilege the right answer grants.
 *
 * ponytail: one booted router per case; the console login case opens a second session, because the login stage is
 * entered when a session starts.
 */
import { describe, expect, it } from 'vitest';
import type { Simulation } from '../src/contracts/simulation.js';
import { SEC } from '../src/contracts/time.js';
import { hashSecret, MAX_INPUT_ATTEMPTS, MSG_INPUT_DENIED, MSG_LOGIN_DENIED, PASSWORD_PROMPT, verifySecret } from '../src/cli/runtime.js';
import { createSimulation } from '../src/sim/simulation.js';
import { ofKind } from './sim.harness.js';

const BOOT = 60 * SEC;
const DEVICE = 'r1';
const SECRET = 'lab-secret-7';
const CONSOLE_PASSWORD = 'front-panel-3';

/** A booted router with nothing configured. */
function router(seed = 51): Simulation {
  const sim = createSimulation({ seed });
  sim.addDevice({ id: DEVICE, type: 'router.nf2911', name: 'R1' });
  sim.runFor(BOOT);
  return sim;
}

/** The `enable secret` line of the running config, as its tokens. */
function secretLine(sim: Simulation): string[] {
  const line = sim
    .device(DEVICE)!
    .running.render()
    .split('\n')
    .find((l) => l.startsWith('enable secret '));
  return line === undefined ? [] : line.split(' ');
}

describe('accept P1: passwords and login', () => {
  it('stores the enable secret hashed, so the running config never shows the text that was typed', () => {
    const sim = router();
    const session = sim.cli.open(DEVICE, 'console');
    expect(sim.cli.exec(session, 'enable').error).toBeUndefined();
    expect(sim.cli.exec(session, 'configure terminal').error).toBeUndefined();
    expect(sim.cli.exec(session, `enable secret ${SECRET}`).error).toBeUndefined();
    expect(sim.cli.exec(session, 'end').error).toBeUndefined();

    const tokens = secretLine(sim);
    expect(tokens.slice(0, 3)).toEqual(['enable', 'secret', 'nf1']);
    expect(tokens[3]).toBe(hashSecret(DEVICE, SECRET).split('$')[1]);
    const text = sim.device(DEVICE)!.running.render();
    expect(text).not.toContain(SECRET);
    // The stored form still verifies the password it was made from, and nothing else.
    expect(verifySecret(DEVICE, tokens.slice(2).join(' '), SECRET)).toBe(true);
    expect(verifySecret(DEVICE, tokens.slice(2).join(' '), 'something else')).toBe(false);
    // The typed line never enters the session history in the clear either.
    expect(sim.cli.session(session)!.history.join('\n')).not.toContain(SECRET);
  });

  it('asks for the secret with a masked question and grants privilege when it is answered', () => {
    const sim = router();
    const setup = sim.cli.open(DEVICE, 'console');
    for (const line of ['enable', 'configure terminal', `enable secret ${SECRET}`, 'end', 'disable']) {
      expect(sim.cli.exec(setup, line).error).toBeUndefined();
    }

    const session = sim.cli.open(DEVICE, 'console');
    const cursor = sim.trace(0).next;
    const asked = sim.cli.exec(session, 'enable');
    expect(asked.input).toEqual(PASSWORD_PROMPT);
    expect(asked.input!.kind).toBe('secret');
    expect(asked.input!.prompt).toBe('Password: ');
    expect(sim.cli.session(session)!.input).toEqual(PASSWORD_PROMPT);
    expect(sim.cli.session(session)!.privilege).toBeLessThan(15);
    // The terminal is told to mask the next line through the prompt event.
    const prompts = ofKind(sim.trace(cursor).events, 'cliPrompt').filter((e) => e.session === session);
    expect(prompts.some((p) => p.input?.kind === 'secret')).toBe(true);

    const granted = sim.cli.exec(session, SECRET);
    expect(granted.error).toBeUndefined();
    expect(granted.input).toBeUndefined();
    expect(sim.cli.session(session)!.privilege).toBe(15);
    expect(sim.cli.session(session)!.mode).toBe('priv-exec');
    // The answer is not a command and never enters the history.
    expect(sim.cli.session(session)!.history).not.toContain(SECRET);
  });

  it('asks again after a wrong answer and denies the command after three of them', () => {
    const sim = router();
    const setup = sim.cli.open(DEVICE, 'console');
    for (const line of ['enable', 'configure terminal', `enable secret ${SECRET}`, 'end', 'disable']) {
      expect(sim.cli.exec(setup, line).error).toBeUndefined();
    }

    const session = sim.cli.open(DEVICE, 'console');
    expect(sim.cli.exec(session, 'enable').input).toEqual(PASSWORD_PROMPT);
    for (let i = 1; i < MAX_INPUT_ATTEMPTS; i++) {
      const again = sim.cli.exec(session, `wrong-${i}`);
      expect(again.input).toEqual(PASSWORD_PROMPT);
      expect(again.error).toBeUndefined();
    }
    const denied = sim.cli.exec(session, 'wrong-last');
    expect(denied.error?.message).toBe(MSG_INPUT_DENIED);
    expect(denied.output).toContain(MSG_INPUT_DENIED);
    expect(denied.input).toBeUndefined();

    // Nothing was granted, and the session takes commands again.
    const view = sim.cli.session(session)!;
    expect(view.privilege).toBeLessThan(15);
    expect(view.mode).toBe('user-exec');
    expect(view.input).toBeUndefined();
    expect(sim.cli.exec(session, 'enable').input).toEqual(PASSWORD_PROMPT);
  });

  it('puts a new console session through the login stage when the line asks for a password', () => {
    const sim = router();
    const setup = sim.cli.open(DEVICE, 'console');
    for (const line of ['enable', 'configure terminal', 'line con 0', `password ${CONSOLE_PASSWORD}`, 'login', 'end']) {
      expect(sim.cli.exec(setup, line).error).toBeUndefined();
    }
    expect(sim.device(DEVICE)!.running.render()).toContain('line con 0');
    expect(sim.device(DEVICE)!.running.render()).toContain('login');

    const session = sim.cli.open(DEVICE, 'console');
    const view = sim.cli.session(session)!;
    expect(view.mode).toBe('login');
    expect(view.privilege).toBe(0);
    expect(view.input).toEqual(PASSWORD_PROMPT);

    const wrong = sim.cli.exec(session, 'not-it');
    expect(wrong.input).toEqual(PASSWORD_PROMPT);
    expect(sim.cli.session(session)!.mode).toBe('login');
    const right = sim.cli.exec(session, CONSOLE_PASSWORD);
    expect(right.error).toBeUndefined();
    expect(sim.cli.session(session)!.mode).toBe('user-exec');
    expect(sim.cli.session(session)!.input).toBeUndefined();

    // A console that answers wrongly three times is refused and left waiting in the login stage.
    const other = sim.cli.open(DEVICE, 'console');
    for (let i = 1; i < MAX_INPUT_ATTEMPTS; i++) expect(sim.cli.exec(other, `no-${i}`).input).toEqual(PASSWORD_PROMPT);
    const refused = sim.cli.exec(other, 'no-last');
    expect(refused.error?.message).toBe(MSG_LOGIN_DENIED);
    expect(sim.cli.session(other)!.mode).toBe('login');
    expect(sim.cli.session(other)!.privilege).toBe(0);
  });
});
