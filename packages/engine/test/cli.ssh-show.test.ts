/**
 * cli/handlers/ssh.ts, `show ip ssh` (ARCHITECTURE-P3 §5.2, §5.8, D14, M10; §7 W3 cli part 2): SSH is on exactly while
 * an RSA key line is stored; the version in force (the `ip ssh version` line, else 2 with a key of at least 768 bits
 * and 1 below), the key size and name, the login time-out and retries (defaults 120 s and 3, as the help says), and
 * what each `line vty` section accepts (`telnet ssh` without a `transport input` line, §5.2), its access class and
 * login rule. On a router and on a switch (D14); never on a host.
 */
import { describe, expect, it } from 'vitest';
import type { CommandHandler, CommandOutcome } from '../src/contracts/cli.js';
import { GRAMMAR, HANDLERS } from '../src/cli/grammar/index.js';
import { SSH_RETRIES_DEFAULT, SSH_TIMEOUT_DEFAULT_S } from '../src/cli/grammar/ssh.js';
import { HANDLER_REGISTRY } from '../src/cli/handlers/index.js';
import { sshVersionInForce } from '../src/cli/handlers/ssh.js';
import { matchCommand } from '../src/cli/parser.js';
import { catalogModel, commandCtxFor, matchContextFor, type RecordingCtx } from './cli.p05.fixture.js';
import { createStagedSimulation } from './staged.world.js';

const ROUTER = catalogModel('router.nf2911');
const SWITCH = catalogModel('switch.nfc2960');
const PC = catalogModel('pc.nfpc');

function run(rec: RecordingCtx): CommandOutcome {
  const h: CommandHandler | undefined = HANDLER_REGISTRY[HANDLERS.showIpSsh];
  if (h === undefined) throw new Error('no show.ip-ssh handler');
  return h(rec.ctx, {}, false);
}

const lines = (o: CommandOutcome): string[] => (o.output ?? '').split('\n');

/** A device with a domain name and, when `bits` is given, a stored key of that size. */
function device(model = ROUTER, bits?: number): RecordingCtx {
  const r = commandCtxFor(model, { mode: 'priv-exec', hostname: model === ROUTER ? 'R1' : 'SW1' });
  r.running.set([], ['ip', 'domain-name', 'lab.local']);
  if (bits !== undefined) r.running.set([], ['crypto', 'key', 'generate', 'rsa', 'modulus', String(bits)]);
  return r;
}

describe('show ip ssh', () => {
  it('is offered on routers and managed switches at user level, never on a host (D14)', () => {
    for (const model of [ROUTER, SWITCH]) {
      const m = matchCommand(GRAMMAR, matchContextFor(model, 'user-exec'), 'show ip ssh');
      expect(m.ok && m.spec.handler, model.type).toBe(HANDLERS.showIpSsh);
    }
    expect(matchCommand(GRAMMAR, matchContextFor(PC, 'user-exec'), 'show ip ssh').ok).toBe(false);
  });

  it('off without a key: says how to make one, with the defaults', () => {
    expect([SSH_TIMEOUT_DEFAULT_S, SSH_RETRIES_DEFAULT]).toEqual([120, 3]);
    expect(lines(run(device()))).toEqual([
      'SSH: off (there is no RSA key; "crypto key generate rsa" creates one)',
      '  Version 2 (no "ip ssh version" line)',
      '  RSA key: none',
      '  Login time-out 120 s; failed logins allowed 3',
      '  No line vty section: remote logins are not offered',
    ]);
  });

  it('on with a key: the key size and name; version 2 by default from 768 bits, 1 below', () => {
    expect(lines(run(device(ROUTER, 1024))).slice(0, 3)).toEqual(['SSH: on', '  Version 2 (no "ip ssh version" line)', '  RSA key: 1024 bits, named R1.lab.local']);
    expect(lines(run(device(SWITCH, 512))).slice(0, 3)).toEqual(['SSH: on', '  Version 1 (no "ip ssh version" line)', '  RSA key: 512 bits, named SW1.lab.local']);
    expect(sshVersionInForce(device(ROUTER, 768))).toEqual({ version: '2', configured: false });
  });

  it('the configured version, time-out and retries; one line per vty section', () => {
    const r = device(ROUTER, 2048);
    r.running.set([], ['ip', 'ssh', 'version', '2']);
    r.running.set([], ['ip', 'ssh', 'time-out', '60']);
    r.running.set([], ['ip', 'ssh', 'authentication-retries', '2']);
    r.running.set([['line', 'vty', '0', '4']], ['transport', 'input', 'ssh']);
    r.running.set([['line', 'vty', '0', '4']], ['access-class', '10', 'in']);
    r.running.set([['line', 'vty', '0', '4']], ['login', 'local']);
    r.running.set([['line', 'vty', '5', '15']], ['login']);
    expect(lines(run(r))).toEqual([
      'SSH: on',
      '  Version 2',
      '  RSA key: 2048 bits, named R1.lab.local',
      '  Login time-out 60 s; failed logins allowed 2',
      '  line vty 0 4: accepts ssh; access class 10 in; login local',
      '  line vty 5 15: accepts telnet ssh (no transport input line); no access class; login with the line password',
    ]);
  });

  it('reads the lines the real handlers store (a console session on a P3-stage switch)', () => {
    const sim = createStagedSimulation({ seed: 3, stage: 'P3' });
    sim.addDevice({ id: 'sw1', type: 'switch.nfc2960', name: 'SW1' });
    sim.runFor(60_000_000_000);
    const s = sim.cli.open('sw1', 'console');
    for (const line of ['enable', 'configure terminal', 'hostname SW1', 'ip domain-name lab.local', 'crypto key generate rsa modulus 1024', 'ip ssh version 2', 'line vty 0 15', 'transport input ssh', 'login local', 'end']) {
      const out = sim.cli.exec(s, line);
      expect(out.error, line).toBeUndefined();
    }
    const out = (sim.cli.exec(s, 'show ip ssh').output ?? '').split('\n');
    expect(out.slice(0, 3)).toEqual(['SSH: on', '  Version 2', '  RSA key: 1024 bits, named SW1.lab.local']);
    expect(out[4]).toBe('  line vty 0 15: accepts ssh; no access class; login local');
  });
});
