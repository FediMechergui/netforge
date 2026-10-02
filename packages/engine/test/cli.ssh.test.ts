/**
 * cli/grammar/ssh.ts and cli/handlers/ssh.ts (ARCHITECTURE-P3 §5.2, D14, D22, M10; §7 W2 cli part 1): the SSH
 * configuration lines on a router and on a switch — the key's prerequisites and messages (a non-default hostname, a
 * domain name, the size question, the version-2 size note), `crypto key zeroize rsa`, `ip ssh version|time-out|
 * authentication-retries`, `username <u> privilege <p> secret <s>` (`userSecretOf` reads it, §9.2 W2 item 26),
 * `transport input` and `access-class` on vty lines, `ip domain-name` widened to managed switches (D14), and `login
 * local` with a privilege-15 user on a real console.
 */
import { describe, expect, it } from 'vitest';
import { CLI_MESSAGES, type CommandHandler, type CommandOutcome } from '../src/contracts/cli.js';
import { SEC } from '../src/contracts/time.js';
import { createConfigAst } from '../src/cli/config-ast.js';
import { GRAMMAR, HANDLERS } from '../src/cli/grammar/index.js';
import { HANDLER_REGISTRY } from '../src/cli/handlers/index.js';
import {
  domainNameOf,
  isDefaultHostname,
  MSG_NO_LINE,
  MSG_NO_RSA_KEY,
  MSG_VTY_ONLY,
  RSA_SIZE_PROMPT,
  rsaModulus,
} from '../src/cli/handlers/ssh.js';
import { userSecretOf } from '../src/cli/runtime.js';
import { USERNAME_PROMPT } from '../src/cli/secrets.js';
import { matchCommand } from '../src/cli/parser.js';
import { catalogModel, commandCtxFor, matchContextFor, type CommandCtxOptions, type RecordingCtx } from './cli.p05.fixture.js';
import { createStagedSimulation } from './staged.world.js';

const ROUTER = catalogModel('router.nf2911');
const SWITCH = catalogModel('switch.nfc2960');
const PC = catalogModel('pc.nfpc');
const VTY = [['line', 'vty', '0', '4']];

function run(rec: RecordingCtx, id: string, args: Record<string, string> = {}, negate = false): CommandOutcome {
  const h: CommandHandler | undefined = HANDLER_REGISTRY[id];
  if (h === undefined) throw new Error(`no handler ${id}`);
  return h(rec.ctx, args, negate);
}

const ok = (ctx: ReturnType<typeof matchContextFor>, line: string) => matchCommand(GRAMMAR, ctx, line);

function typed(rec: RecordingCtx, mode: Parameters<typeof matchContextFor>[1], line: string): CommandOutcome {
  const m = ok(matchContextFor(rec.ctx.model, mode), line);
  if (!m.ok) throw new Error(`${line}: ${m.error.message}`);
  return run(rec, m.spec.handler, { ...m.args }, m.negated);
}

/** A device context with a non-default hostname and (unless `domain` is false) a domain name. */
function ready(model = ROUTER, opts: CommandCtxOptions & { domain?: boolean } = {}): RecordingCtx {
  const r = commandCtxFor(model, { mode: 'config', hostname: model === ROUTER ? 'R1' : 'SW1', ...opts });
  if (opts.domain !== false) r.running.set([], ['ip', 'domain-name', 'lab.nf']);
  return r;
}

describe('parsing and scope', () => {
  it('parses every §5.2 device-access line on a router and on a switch (D14)', () => {
    for (const model of [ROUTER, SWITCH]) {
      const cfg = matchContextFor(model, 'config');
      expect(ok(cfg, 'ip domain-name lab.nf')).toMatchObject({ ok: true, args: { name: 'lab.nf' } });
      expect(ok(cfg, 'crypto key generate rsa')).toMatchObject({ ok: true, spec: { handler: HANDLERS.configCryptoKeyGenerate, interactive: true } });
      expect(ok(cfg, 'crypto key generate rsa general-keys')).toMatchObject({ ok: true, spec: { interactive: true } });
      expect(ok(cfg, 'crypto key generate rsa modulus 1024')).toMatchObject({ ok: true, args: { bits: '1024' } });
      expect(ok(cfg, 'crypto key generate rsa general-keys modulus 2048')).toMatchObject({ ok: true, args: { bits: '2048' } });
      expect(ok(cfg, 'crypto key generate rsa modulus 300')).toMatchObject({ ok: false, kind: 'invalid-arg' });
      expect(ok(cfg, 'crypto key zeroize rsa')).toMatchObject({ ok: true, spec: { handler: HANDLERS.configCryptoKeyZeroize } });
      expect(ok(cfg, 'ip ssh version 2')).toMatchObject({ ok: true, spec: { handler: HANDLERS.configIpSsh }, args: { form: 'version', version: '2' } });
      expect(ok(cfg, 'ip ssh time-out 60')).toMatchObject({ ok: true, args: { form: 'time-out', seconds: '60' } });
      expect(ok(cfg, 'ip ssh authentication-retries 2')).toMatchObject({ ok: true, args: { form: 'authentication-retries', count: '2' } });
      expect(ok(cfg, 'username admin privilege 15 secret Lab-Pass 1')).toMatchObject({ ok: true, spec: { handler: HANDLERS.configUsernamePrivilege }, args: { name: 'admin', level: '15', secret: 'Lab-Pass 1' } });
      expect(ok(cfg, 'username admin secret Lab-Pass')).toMatchObject({ ok: true, spec: { handler: HANDLERS.configUsername } });
      const line = matchContextFor(model, 'config-line');
      expect(ok(line, 'transport input ssh')).toMatchObject({ ok: true, spec: { handler: HANDLERS.lineTransportInput }, args: { protocol: 'ssh' } });
      expect(ok(line, 'transport input telnet ssh')).toMatchObject({ ok: true, args: { first: 'telnet', second: 'ssh' } });
      expect(ok(line, 'transport input none')).toMatchObject({ ok: true, args: { protocol: 'none' } });
      expect(ok(line, 'transport input all')).toMatchObject({ ok: true });
      expect(ok(line, 'access-class 10 in')).toMatchObject({ ok: true, spec: { handler: HANDLERS.lineAccessClass }, args: { list: '10', direction: 'in' } });
      expect(ok(line, 'login local')).toMatchObject({ ok: true });
    }
    expect(ok(matchContextFor(PC, 'user-exec'), 'crypto key generate rsa').ok).toBe(false);
  });
});

describe('crypto key generate rsa: prerequisites and messages', () => {
  it('needs a hostname other than the default, on a router and on a switch', () => {
    for (const [model, name] of [[ROUTER, 'Router'], [ROUTER, 'Router3'], [SWITCH, 'Switch'], [SWITCH, 'Switch12']] as const) {
      const r = ready(model, { hostname: name });
      expect(isDefaultHostname(r.ctx), name).toBe(true);
      expect(typed(r, 'config', 'crypto key generate rsa modulus 1024'), name).toEqual({ error: CLI_MESSAGES.sshNeedsHostname });
      expect(r.running.render()).not.toContain('crypto');
    }
    expect(isDefaultHostname(ready(ROUTER, { hostname: 'RouterA' }).ctx)).toBe(false);
  });

  it('needs ip domain-name', () => {
    for (const model of [ROUTER, SWITCH]) {
      const r = ready(model, { domain: false });
      expect(typed(r, 'config', 'crypto key generate rsa')).toEqual({ error: CLI_MESSAGES.sshNeedsDomain });
      expect(typed(r, 'config', 'ip domain-name lab.nf')).toEqual({});
      expect(domainNameOf(r.ctx)).toBe('lab.nf');
      expect(typed(r, 'config', 'crypto key generate rsa modulus 1024').output).toMatch(/^The RSA key pair (R1|SW1)\.lab\.nf was created \(1024 bits\)\. SSH can now be used\.$/);
      expect(r.running.render()).toContain('\ncrypto key generate rsa modulus 1024\n');
    }
  });

  it('asks for the size when none is given: empty = 1024, out of range asks again', () => {
    const r = ready();
    const asked = typed(r, 'config', 'crypto key generate rsa');
    expect(asked.output).toBe('The key pair will be named R1.lab.nf.');
    expect(asked.ask?.request).toEqual(RSA_SIZE_PROMPT);
    const again = asked.ask!.resume(r.ctx, '200', 1);
    expect(again.ask?.request).toEqual(RSA_SIZE_PROMPT);
    expect(r.running.render()).not.toContain('crypto');
    expect(again.ask!.resume(r.ctx, '', 2).output).toContain('(1024 bits)');
    expect(rsaModulus(r.ctx)).toBe(1024);
    // a second key replaces the first, and a small key notes version 2's minimum
    const small = typed(r, 'config', 'crypto key generate rsa general-keys');
    expect(small.ask!.resume(r.ctx, '512', 1).output).toBe(
      'The RSA key pair R1.lab.nf was created (512 bits); it replaces the previous key. SSH can now be used.\nNote: SSH version 2 needs a key of at least 768 bits.',
    );
    expect(r.running.render().match(/crypto key generate rsa/g)).toHaveLength(1);
    expect(rsaModulus(r.ctx)).toBe(512);
  });

  it('ip ssh version 2 needs a key of 768 bits or more; zeroize removes the key', () => {
    const r = ready();
    expect(typed(r, 'config', 'ip ssh version 2')).toEqual({ error: CLI_MESSAGES.sshVersionNeedsKey });
    typed(r, 'config', 'crypto key generate rsa modulus 512');
    expect(typed(r, 'config', 'ip ssh version 2')).toEqual({ error: CLI_MESSAGES.sshVersionNeedsKey });
    expect(typed(r, 'config', 'ip ssh version 1')).toEqual({});
    typed(r, 'config', 'crypto key generate rsa modulus 2048');
    expect(typed(r, 'config', 'ip ssh version 2')).toEqual({});
    expect(typed(r, 'config', 'ip ssh time-out 60')).toEqual({});
    expect(typed(r, 'config', 'ip ssh authentication-retries 2')).toEqual({});
    const text = r.running.render();
    expect(text).toContain('ip ssh version 2\n');
    expect(text).not.toContain('ip ssh version 1');
    expect(text).toContain('ip ssh time-out 60\n');
    expect(text).toContain('ip ssh authentication-retries 2\n');
    expect(typed(r, 'config', 'crypto key zeroize rsa').output).toBe('The RSA key pair was deleted; SSH stays off until a new key is created.');
    expect(rsaModulus(r.ctx)).toBeUndefined();
    expect(typed(r, 'config', 'crypto key zeroize rsa')).toEqual({ error: MSG_NO_RSA_KEY });
    for (const l of ['no ip ssh version', 'no ip ssh time-out', 'no ip ssh authentication-retries']) typed(r, 'config', l);
    expect(r.running.render()).not.toContain('ip ssh');
  });
});

describe('username with a privilege', () => {
  it('stores the hashed secret in one slot per user; userSecretOf reads both forms (§9.2 W2 item 26)', () => {
    const r = ready();
    expect(typed(r, 'config', 'username admin privilege 15 secret Lab-Pass')).toEqual({});
    const stored = userSecretOf(r.running, 'admin');
    expect(stored).toBe(r.ctx.secrets.hash('Lab-Pass').replace('$', ' '));
    expect(r.ctx.secrets.verify(stored!, 'Lab-Pass')).toBe(true);
    expect(r.running.render()).toMatch(/\nusername admin privilege 15 secret nf1 [0-9a-f]{16}\n/);
    // the same user again (another form) replaces the line
    typed(r, 'config', 'username admin secret Other');
    expect(r.running.render().match(/username admin/g)).toHaveLength(1);
    expect(r.ctx.secrets.verify(userSecretOf(r.running, 'admin')!, 'Other')).toBe(true);
    typed(r, 'config', 'username admin privilege 5 secret Third');
    expect(r.running.render()).toMatch(/\nusername admin privilege 5 secret nf1 /);
    expect(typed(r, 'config', 'no username admin privilege 5 secret x')).toEqual({});
    expect(r.running.render()).not.toContain('username');
  });

  it('userSecretOf: exact cases of the privilege form; the P1 forms are unchanged', () => {
    const ast = createConfigAst();
    ast.set([], ['username', 'a', 'secret', 'nf1', '0123456789abcdef']);
    ast.set([], ['username', 'b', 'password', 'plain']);
    ast.set([], ['username', 'c', 'privilege', '15', 'secret', 'nf1', 'fedcba9876543210']);
    ast.set([], ['username', 'd', 'privilege', '1', 'password', 'clear']);
    expect(userSecretOf(ast, 'a')).toBe('nf1 0123456789abcdef');
    expect(userSecretOf(ast, 'b')).toBe('plain');
    expect(userSecretOf(ast, 'c')).toBe('nf1 fedcba9876543210');
    expect(userSecretOf(ast, 'd')).toBe('clear');
    expect(userSecretOf(ast, 'e')).toBeUndefined();
  });
});

describe('vty lines', () => {
  it('transport input stores one value (ssh telnet in that order); access-class stores the list', () => {
    const r = ready(SWITCH, { context: VTY });
    r.running.set([], ['line', 'vty', '0', '4']);
    expect(typed(r, 'config-line', 'transport input telnet ssh')).toEqual({});
    expect(r.running.render()).toContain('line vty 0 4\n transport input ssh telnet\n');
    expect(typed(r, 'config-line', 'transport input ssh')).toEqual({});
    expect(typed(r, 'config-line', 'access-class 010 in')).toEqual({});
    expect(r.running.render()).toContain('line vty 0 4\n access-class 10 in\n transport input ssh\n');
    expect(typed(r, 'config-line', 'access-class 100 in')).toEqual({});
    expect(typed(r, 'config-line', 'access-class 200 in')).toEqual({ error: CLI_MESSAGES.aclNumberRange });
    expect(typed(r, 'config-line', 'access-class MGMT in')).toEqual({});
    expect(r.running.render()).toContain(' access-class MGMT in\n');
    expect(typed(r, 'config-line', 'no access-class')).toEqual({});
    expect(typed(r, 'config-line', 'no transport input')).toEqual({});
    expect(r.running.render()).not.toMatch(/access-class|transport/);
  });

  it('are refused on the console line and outside a line', () => {
    const con = ready(ROUTER, { context: [['line', 'con', '0']] });
    expect(typed(con, 'config-line', 'transport input ssh')).toEqual({ error: MSG_VTY_ONLY });
    expect(typed(con, 'config-line', 'access-class 10 in')).toEqual({ error: MSG_VTY_ONLY });
    expect(run(ready(), HANDLERS.lineTransportInput, { protocol: 'ssh' })).toEqual({ error: MSG_NO_LINE });
  });
});

describe('console sessions on P3-stage devices', () => {
  it('a switch: the prerequisites in order, the size question, then the stored key', () => {
    const sim = createStagedSimulation({ seed: 7, stage: 'P3' });
    const sw = sim.addDevice({ type: 'switch.nfc2960', name: 'Switch1' });
    sim.runFor(60 * SEC);
    const s = sim.cli.open(sw, 'console');
    for (const line of ['enable', 'configure terminal']) expect(sim.cli.exec(s, line).error).toBeUndefined();
    expect(sim.cli.exec(s, 'crypto key generate rsa').output).toContain(CLI_MESSAGES.sshNeedsHostname);
    sim.cli.exec(s, 'hostname SW1');
    expect(sim.cli.exec(s, 'crypto key generate rsa').output).toContain(CLI_MESSAGES.sshNeedsDomain);
    expect(sim.cli.exec(s, 'ip domain-name lab.nf').error).toBeUndefined();
    const asked = sim.cli.exec(s, 'crypto key generate rsa');
    expect(asked.output).toContain('The key pair will be named SW1.lab.nf.');
    expect(asked.input?.prompt).toBe(RSA_SIZE_PROMPT.prompt);
    expect(sim.cli.exec(s, '1024').output).toContain('was created (1024 bits)');
    for (const line of ['ip ssh version 2', 'line vty 0 4', 'transport input ssh', 'login local', 'end']) {
      expect(sim.cli.exec(s, line).error, line).toBeUndefined();
    }
    const text = sim.cli.exec(s, 'show running-config').output;
    expect(text).toContain('ip domain-name lab.nf\n');
    expect(text).toContain('crypto key generate rsa modulus 1024\n');
    expect(text).toContain('ip ssh version 2\n');
    expect(text).toMatch(/line vty 0 4\n login local\n transport input ssh\n/);
  });

  it('a router: login local admits a privilege-15 user straight into privileged EXEC', () => {
    const sim = createStagedSimulation({ seed: 7, stage: 'P3' });
    const r1 = sim.addDevice({ type: 'router.nf2911', name: 'R1' });
    sim.runFor(60 * SEC);
    const s = sim.cli.open(r1, 'console');
    for (const line of ['enable', 'configure terminal', 'username admin privilege 15 secret Lab-Pass', 'username guest secret Guest-Pass', 'line con 0', 'login local', 'end']) {
      expect(sim.cli.exec(s, line).error, line).toBeUndefined();
    }
    sim.cli.close(s);
    const login = (user: string, password: string) => {
      const session = sim.cli.open(r1, 'console');
      expect(sim.cli.session(session)?.input).toEqual(USERNAME_PROMPT);
      sim.cli.exec(session, user);
      const result = sim.cli.exec(session, password);
      sim.cli.close(session);
      return result;
    };
    const asAdmin = login('admin', 'Lab-Pass');
    expect(asAdmin.error).toBeUndefined();
    expect(asAdmin.mode).toBe('priv-exec');
    expect(asAdmin.prompt).toBe('R1#');
    const asGuest = login('guest', 'Guest-Pass');
    expect(asGuest.mode).toBe('user-exec');
    expect(asGuest.prompt).toBe('R1>');
    expect(login('admin', 'nope').mode).toBe('login');
  });
});
