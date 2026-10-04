/**
 * cli.users-show — `show users` and `show ssh` (M10, D14) with the [S13] remote sessions: the typing console line and
 * the inbound connections of the vty StateView, the SSH connections in and out (the vty-client StateView), and the
 * `ip ssh` / `telnet` debug categories (ARCHITECTURE-P3 §3.14, §5.8; §7 W3 cli, approved items) — against fake vty and
 * vty-client StateViews (protocols/vty.ts `connections`, protocols/vty-client.ts `sessions`).
 */
import { describe, expect, it } from 'vitest';
import type { CommandCtx } from '../src/contracts/cli.js';
import { REMOTE_DEBUG_CATEGORIES, REMOTE_GRAMMAR, REMOTE_HANDLERS as H } from '../src/cli/grammar/remote.js';
import { MSG_NO_REMOTE_SESSION, MSG_NO_SSH_SESSION, sessionPhaseText, vtyClientSessions, vtyConnections } from '../src/cli/handlers/remote.js';
import { approvedCtx, handlerOf, parse, showCtx, showLines } from './cli.p3-approved.fixture.js';

const R = 'router.nf2911';

/** §3.14 at R1: PC1 logged in over SSH as admin; PC2's telnet still at the password. */
const VTY = {
  listening: ['telnet', 'ssh'],
  connections: [
    { id: 'c1', proto: 'ssh', peer: '192.168.10.10', phase: 'open', user: 'admin' },
    { id: 'c2', proto: 'telnet', peer: '192.168.10.11', phase: 'password' },
  ],
  logins: 1,
  failures: 0,
  refusals: 1,
};

/** R1's own outbound SSH session to R2 (a nested hop of §3.14 step 5). */
const CLIENT = {
  sessions: [
    { session: 'v_1', proto: 'ssh', target: '10.0.0.2', port: 22, phase: 'open', remote: 'R2 via SSH' },
    { session: 's_9', proto: 'telnet', target: '10.0.0.3', port: 23, phase: 'connecting' },
  ],
  results: [],
};

function ctxOf(via: 'console' | 'vty', states: Record<string, Record<string, unknown>>): CommandCtx {
  const base = showCtx(approvedCtx(R, { mode: 'priv-exec' }), { states });
  return { ...base, session: { ...base.session, via } };
}

describe('cli.users-show grammar', () => {
  it('parses show users and show ssh on routers and managed switches, not on hosts', () => {
    expect(handlerOf(R, 'user-exec', 'show users')).toBe(H.showUsers);
    expect(handlerOf(R, 'priv-exec', 'show ssh')).toBe(H.showSsh);
    expect(handlerOf('switch.nfc2960', 'user-exec', 'show users')).toBe(H.showUsers);
    expect(parse('pc.nfpc', 'user-exec', 'show users').ok).toBe(false);
  });

  it('registers ip ssh and telnet, offered on routers and managed switches (the vty rows of §2.1)', () => {
    expect(REMOTE_DEBUG_CATEGORIES.map((d) => [d.category, d.requiresAny])).toEqual([['ip ssh', ['routing', 'managed-switch']], ['telnet', ['routing', 'managed-switch']]]);
    expect(REMOTE_GRAMMAR.filter((s) => s.path[0] === 'debug').map((s) => s.path.join(' '))).toEqual(['debug ip ssh', 'debug telnet']);
    expect(handlerOf(R, 'priv-exec', 'debug telnet')).toBe('exec.debug');
    expect(handlerOf('switch.nfc2960', 'priv-exec', 'debug ip ssh')).toBe('exec.debug');
    expect(parse('pc.nfpc', 'user-exec', 'debug telnet').ok).toBe(false);
  });
});

describe('show users', () => {
  it('the console line starred, then one vty line per inbound connection', () => {
    expect(showLines(ctxOf('console', { vty: VTY }), H.showUsers)).toEqual([
      '   Line   User   Protocol  From           State',
      '*  con 0  -      console   -              session open',
      '   vty 0  admin  ssh       192.168.10.10  session open',
      '   vty 1  -      telnet    192.168.10.11  logging in',
    ]);
  });

  it('a remote session stars its own line when it is the only open connection', () => {
    expect(showLines(ctxOf('vty', { vty: VTY }), H.showUsers)).toEqual([
      '   Line   User   Protocol  From           State',
      '*  vty 0  admin  ssh       192.168.10.10  session open',
      '   vty 1  -      telnet    192.168.10.11  logging in',
    ]);
    const two = { connections: [VTY.connections[0], { ...VTY.connections[0], id: 'c3', peer: '192.168.10.12' }] };
    expect(showLines(ctxOf('vty', { vty: two }), H.showUsers).filter((l) => l.startsWith('*'))).toEqual([]);
  });

  it('says so when no remote session is open (no vty daemon, or a malformed view)', () => {
    expect(showLines(ctxOf('console', {}), H.showUsers)).toEqual([
      '   Line   User  Protocol  From  State',
      '*  con 0  -     console   -     session open',
      MSG_NO_REMOTE_SESSION,
    ]);
    expect(vtyConnections(ctxOf('console', { vty: { connections: [{ id: 'x' }, 'junk', { proto: 'ftp', peer: '1.1.1.1' }] } }))).toEqual([]);
  });
});

describe('show ssh', () => {
  it('lists the inbound SSH connections, then the outbound ones', () => {
    expect(showLines(ctxOf('console', { vty: VTY, 'vty-client': CLIENT }), H.showSsh)).toEqual([
      'Connection  Version  Direction  User   Peer           State',
      '0           2.0      in         admin  192.168.10.10  session open',
      '1           2.0      out        -      10.0.0.2       session open',
    ]);
    expect(vtyClientSessions(ctxOf('console', { 'vty-client': CLIENT })).map((s) => [s.session, s.proto, s.target, s.phase])).toEqual([
      ['v_1', 'ssh', '10.0.0.2', 'open'],
      ['s_9', 'telnet', '10.0.0.3', 'connecting'],
    ]);
  });

  it('says so without an SSH connection (telnet connections are not SSH)', () => {
    expect(showLines(ctxOf('console', {}), H.showSsh)).toEqual([MSG_NO_SSH_SESSION]);
    expect(showLines(ctxOf('console', { vty: { connections: [VTY.connections[1]] } }), H.showSsh)).toEqual([MSG_NO_SSH_SESSION]);
  });

  it('names the phases of both daemons', () => {
    expect(['open', 'connecting', 'closing', 'check', 'version', 'auth', 'user', 'password', 'retry'].map(sessionPhaseText)).toEqual([
      'session open', 'connecting', 'closing', 'logging in', 'logging in', 'logging in', 'logging in', 'logging in', 'logging in',
    ]);
  });
});
