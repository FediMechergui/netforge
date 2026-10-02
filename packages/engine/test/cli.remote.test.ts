/**
 * cli.remote — [S13] remote sessions in the CLI runtime and the `telnet` / `ssh` client jobs (ARCHITECTURE-P3 D14,
 * §2.11, §3.14; §7 W2 cli, approved items), against FakeDevices and a fake vty-client (the recording device runtime):
 *   - the client jobs on routers, switches and hosts (`vty.connect`, abort `vty.interrupt`), refused without the daemon;
 *   - the relay: `setRemote` (prompt, masked input, the chip), lines sent as `vty.input` through `exec` (the journaled
 *     facade op) and never into the local history, ^C as `vty.interrupt`, `cliDone` ending it;
 *   - the server side: `openRemote` / `execRemote` / `closeRemote`, every output delivered as `vty.output` (never a
 *     `cliOutput` / `cliPrompt` trace event), job output and debug lines included; `FacadeCounters.remote` and resume;
 *   - the nesting cap of 4, matched through the client's address and its connect target.
 */
import { describe, expect, it } from 'vitest';
import type { DeviceId, SessionId } from '../src/contracts/ids.js';
import type { Action, Process, RemoteCliAction, StateView } from '../src/contracts/process.js';
import type { Simulation } from '../src/contracts/simulation.js';
import { replayJournal } from '../src/sim/replay.js';
import { createStagedCatalog, createStagedSimulation } from './staged.world.js';
import type { VtyOutputEvent } from '../src/contracts/transport.js';
import { REMOTE_DEPTH_CAP, REMOTE_HANDLERS } from '../src/cli/grammar/remote.js';
import { MSG_NO_VTY_CLIENT } from '../src/cli/handlers/remote.js';
import { MSG_REMOTE_DEPTH, REMOTE_SESSION_PREFIX } from '../src/cli/runtime.js';
import { approvedHarness, handlerOf, parse, withProcesses, type ApprovedHarness } from './cli.p3-approved.fixture.js';
import type { FakeDevice } from './cli.runtime.fake.js';

const OPEN = (conn: string, peer?: string, user?: string): RemoteCliAction => ({
  type: 'remoteCli',
  op: 'open',
  conn,
  proto: 'ssh',
  ...(peer === undefined ? {} : { peer }),
  ...(user === undefined ? {} : { user }),
});
const LINE = (conn: string, text: string): RemoteCliAction => ({ type: 'remoteCli', op: 'line', conn, text });

/** The requests the CLI applied on a fake device, in order. */
function requests(d: FakeDevice): Extract<Action, { type: 'request' }>['req'][] {
  return d.actionCalls.flatMap((c) => c.actions).flatMap((a) => (a.type === 'request' ? [a.req] : []));
}

/** The `vty.output` events the CLI delivered as `event` actions on a fake device. */
function vtyEvents(d: FakeDevice): VtyOutputEvent[] {
  return d.actionCalls
    .flatMap((c) => c.actions)
    .flatMap((a) => (a.type === 'event' && a.to === 'vty' && a.ev.kind === 'vty.output' ? [a.ev] : []));
}

/** Give a fake device's first port an IPv4 address. */
function address(d: FakeDevice, ip: string): FakeDevice {
  const port = [...d.ports.values()][0];
  if (port === undefined) throw new Error('no port');
  port.l3 = { ipv4: { address: ip, prefixLen: 24 } };
  return d;
}

describe('cli.remote grammar', () => {
  it('offers telnet and ssh on routers, switches and host shells, as jobs', () => {
    expect(handlerOf('router.nf2911', 'user-exec', 'telnet 10.0.0.1', { privilege: 1 })).toBe(REMOTE_HANDLERS.execTelnet);
    expect(handlerOf('router.nf2911', 'priv-exec', 'telnet 10.0.0.1 2323')).toBe(REMOTE_HANDLERS.execTelnet);
    expect(handlerOf('switch.nfc2960', 'user-exec', 'ssh -l admin 10.0.0.1', { privilege: 1 })).toBe(REMOTE_HANDLERS.execSsh);
    expect(handlerOf('pc.nfpc', 'user-exec', 'ssh -l admin -v 2 192.168.10.1')).toBe(REMOTE_HANDLERS.execSsh);
    expect(handlerOf('pc.nfpc', 'user-exec', 'telnet 192.168.10.1')).toBe(REMOTE_HANDLERS.execTelnet);
    const m = parse('router.nf2911', 'user-exec', 'ssh -l admin 10.0.0.1', { privilege: 1 });
    expect(m.ok && m.spec.job).toBe(true);
    expect(parse('router.nf2911', 'user-exec', 'ssh 10.0.0.1', { privilege: 1 }).ok).toBe(false);
    expect(parse('router.nf2911', 'user-exec', 'ssh -l admin -v 1 10.0.0.1', { privilege: 1 }).ok).toBe(false);
  });
});

describe('cli.remote client jobs and the relay', () => {
  function client(): { h: ApprovedHarness; pc: FakeDevice; s: SessionId } {
    const h = approvedHarness();
    const pc = withProcesses(h.add('d_pc', 'pc', 'PC1'), 'vty-client');
    const s = h.cli.open('d_pc', 'console');
    return { h, pc, s };
  }

  it('a device without the vty-client answers at once', () => {
    const h = approvedHarness();
    h.add('d_pc', 'pc', 'PC1');
    const s = h.cli.open('d_pc', 'console');
    expect(h.cli.exec(s, 'telnet 10.0.0.1')).toMatchObject({ output: MSG_NO_VTY_CLIENT, busy: false });
  });

  it('ssh blocks the session with a vty-client job and asks for the connection', () => {
    const { h, pc, s } = client();
    const r = h.cli.exec(s, 'ssh -l admin 192.168.10.1');
    expect(r).toMatchObject({ output: '', busy: true });
    expect(requests(pc)).toEqual([{ kind: 'vty.connect', session: s, target: '192.168.10.1', proto: 'ssh', user: 'admin' }]);
    expect(h.cli.session(s)?.job).toEqual({ process: 'vty-client', label: 'ssh' });
    h.cli.exec(s, 'show version'); // dropped while connecting
    expect(requests(pc)).toHaveLength(1);
    h.cli.exec(s, ''); // likewise
    pc.actionCalls.length = 0;
    const t = client();
    t.h.cli.exec(t.s, 'telnet 192.168.10.1 2323');
    expect(requests(t.pc)).toEqual([{ kind: 'vty.connect', session: t.s, target: '192.168.10.1', proto: 'telnet', port: 2323 }]);
  });

  it('relays the session: masked password, the chip and prompt, lines as vty.input, never in the local history', () => {
    const { h, pc, s } = client();
    h.cli.exec(s, 'ssh -l admin 192.168.10.1');
    pc.actionCalls.length = 0;
    h.trace.clear();
    // the vty-client asks for the password locally
    h.cli.setRemote({ type: 'cliRemote', session: s, prompt: 'Password: ', input: 'secret' }, 5);
    expect(h.cli.session(s)).toMatchObject({ busy: false, prompt: 'Password: ', input: { kind: 'secret', prompt: 'Password: ' } });
    expect(h.trace.of('cliPrompt')).toEqual([{ t: 5, kind: 'cliPrompt', session: s, prompt: 'Password: ', busy: false, input: { kind: 'secret', prompt: 'Password: ' } }]);
    const r = h.cli.exec(s, 'lab pass\r\n');
    expect(r).toMatchObject({ output: '', busy: true });
    expect(requests(pc)).toEqual([{ kind: 'vty.input', session: s, line: 'lab pass' }]);
    // logged in: the chip and the remote prompt
    h.cli.setRemote({ type: 'cliRemote', session: s, prompt: 'R1>', remote: 'R1 via SSH' }, 9);
    const v = h.cli.session(s);
    expect(v).toMatchObject({ busy: false, prompt: 'R1>', remote: 'R1 via SSH' });
    expect(v?.input).toBeUndefined();
    expect(h.cli.exec(s, '  show ip interface brief')).toMatchObject({ prompt: 'R1>', busy: true });
    expect(requests(pc).at(-1)).toEqual({ kind: 'vty.input', session: s, line: '  show ip interface brief' });
    expect(h.cli.session(s)?.history).toEqual(['ssh -l admin 192.168.10.1']);
    // ^C goes to the far end; the session stays relayed
    h.cli.interrupt(s);
    expect(requests(pc).at(-1)).toEqual({ kind: 'vty.interrupt', session: s });
    expect(h.cli.session(s)?.remote).toBe('R1 via SSH');
    // the vty-client's cliDone ends the relay: local prompt, no chip
    h.cli.onDone(s, 20);
    const after = h.cli.session(s);
    expect(after).toMatchObject({ busy: false, prompt: 'PC1>' });
    expect(after?.remote).toBeUndefined();
    expect(after?.job).toBeUndefined();
    expect(h.cli.exec(s, 'exit').closed).toBe(true);
  });

  it('a managed switch opens a client session from its own CLI even with no service line (ruling R17, the CLI half)', () => {
    const h = approvedHarness();
    const sw = withProcesses(h.add('d_sw', 'switch', 'SW1'), 'vty-client');
    // the fake switch is a P1 `switching` model: give it the P3 managed-switch capability that runs the vty-client
    Object.defineProperty(sw, 'capabilities', { value: [...sw.capabilities, 'managed-switch'] });
    expect(sw.running.root.children.some((c) => c.key === 'line' || c.key === 'transport')).toBe(false);
    const s = h.cli.open('d_sw', 'console');
    expect(h.cli.exec(s, 'telnet 192.168.1.1')).toMatchObject({ output: '', busy: true });
    expect(requests(sw)).toEqual([{ kind: 'vty.connect', session: s, target: '192.168.1.1', proto: 'telnet' }]);
    expect(h.cli.session(s)?.job).toEqual({ process: 'vty-client', label: 'telnet' });
  });

  it('a stale cliRemote (no vty-client job) changes nothing', () => {
    const { h, s } = client();
    h.cli.setRemote({ type: 'cliRemote', session: s, prompt: 'R9>', remote: 'R9 via SSH' }, 1);
    expect(h.cli.session(s)).toMatchObject({ prompt: 'PC1>' });
    expect(h.cli.session(s)?.remote).toBeUndefined();
  });

  it('closing a relayed console session ends the client job', () => {
    const { h, pc, s } = client();
    h.cli.exec(s, 'ssh -l admin 192.168.10.1');
    h.cli.setRemote({ type: 'cliRemote', session: s, prompt: 'R1>', remote: 'R1 via SSH' }, 9);
    h.cli.close(s);
    expect(requests(pc).at(-1)).toEqual({ kind: 'vty.interrupt', session: s });
    expect(h.cli.session(s)).toBeUndefined();
  });
});

describe('cli.remote server side', () => {
  it('opens a via-vty session per connection and delivers every output as vty.output, never as a trace event', () => {
    const h = approvedHarness();
    const r1 = withProcesses(h.add('d_r1', 'router', 'R1'), 'vty');
    r1.running.set([], ['banner', 'motd', 'Authorised staff only']);
    h.trace.clear();
    const id = h.cli.openRemote('d_r1', OPEN('c1', '192.168.10.10', 'admin'), 100);
    expect(id).toBe(`${REMOTE_SESSION_PREFIX}1`);
    expect(h.cli.openRemote('d_r1', OPEN('c1'), 100)).toBe(id); // idempotent per connection
    expect(h.cli.session(id)).toMatchObject({ via: 'vty', mode: 'user-exec', privilege: 1, prompt: 'R1>' });
    expect(vtyEvents(r1)).toEqual([{ kind: 'vty.output', conn: 'c1', text: 'Authorised staff only', prompt: 'R1>' }]);
    h.cli.execRemote('d_r1', LINE('c1', 'enable'), 110);
    h.cli.execRemote('d_r1', LINE('c1', ''), 111);
    h.cli.execRemote('d_r1', LINE('c1', 'show nonsense'), 112);
    const ev = vtyEvents(r1);
    expect(ev[1]).toEqual({ kind: 'vty.output', conn: 'c1', text: '', prompt: 'R1#' });
    expect(ev[2]).toEqual({ kind: 'vty.output', conn: 'c1', text: '', prompt: 'R1#' });
    expect(ev[3]?.prompt).toBe('R1#');
    expect(ev[3]?.text).toMatch(/\^/);
    // a job: the prompt waits for the end; job output and debug lines go back over the connection
    h.cli.execRemote('d_r1', LINE('c1', 'ping 10.0.0.2'), 120);
    expect(vtyEvents(r1)).toHaveLength(4);
    expect(h.cli.session(id)?.busy).toBe(true);
    h.cli.onOutput(id, '!!!!!', 121);
    h.cli.onDone(id, 122);
    expect(vtyEvents(r1).slice(4)).toEqual([
      { kind: 'vty.output', conn: 'c1', text: '!!!!!' },
      { kind: 'vty.output', conn: 'c1', text: '', prompt: 'R1#' },
    ]);
    h.cli.execRemote('d_r1', LINE('c1', 'debug ip icmp'), 130);
    h.cli.onDebugEvent({ at: 131, device: 'd_r1', process: 'icmpv4', category: 'ip icmp', message: 'echo reply sent' });
    expect(vtyEvents(r1).at(-1)).toEqual({ kind: 'vty.output', conn: 'c1', text: '*00:00:00.000000: ip icmp: echo reply sent' });
    // the far end logs out: closed, and the session is gone
    h.cli.execRemote('d_r1', LINE('c1', 'exit'), 140);
    expect(vtyEvents(r1).at(-1)).toMatchObject({ conn: 'c1', closed: true });
    expect(h.cli.session(id)).toBeUndefined();
    expect(h.trace.of('cliOutput')).toEqual([]);
    expect(h.trace.of('cliPrompt')).toEqual([]);
  });

  it('a privilege-15 user starts in privileged EXEC; a question asks for masked input', () => {
    const h = approvedHarness();
    const r1 = withProcesses(h.add('d_r1', 'router', 'R1'), 'vty');
    r1.running.set([], ['username', 'admin', 'privilege', '15', 'secret', 'nf1', 'x']);
    const id = h.cli.openRemote('d_r1', OPEN('c1', undefined, 'admin'), 0);
    expect(h.cli.session(id)).toMatchObject({ mode: 'priv-exec', privilege: 15, prompt: 'R1#' });
    const guest = h.cli.openRemote('d_r1', OPEN('c2', undefined, 'guest'), 0);
    r1.running.set([], ['enable', 'secret', 'lab']);
    h.cli.execRemote('d_r1', LINE('c2', 'enable'), 1);
    expect(vtyEvents(r1).at(-1)).toEqual({ kind: 'vty.output', conn: 'c2', text: '', prompt: 'Password: ', input: 'secret' });
    expect(h.cli.session(guest)?.input).toEqual({ kind: 'secret', prompt: 'Password: ' });
  });

  it('closeRemote drops the session and aborts its job; the Simulation may take the delivery over', () => {
    const delivered: [DeviceId, VtyOutputEvent][] = [];
    const h = approvedHarness({ remoteOutput: (device, ev) => delivered.push([device, ev]) });
    const r1 = withProcesses(h.add('d_r1', 'router', 'R1'), 'vty');
    const id = h.cli.openRemote('d_r1', OPEN('c1'), 0);
    h.cli.execRemote('d_r1', LINE('c1', 'ping 10.0.0.2'), 1);
    h.cli.closeRemote('d_r1', { type: 'remoteCli', op: 'close', conn: 'c1' }, 2);
    expect(h.cli.session(id)).toBeUndefined();
    expect(requests(r1).at(-1)).toEqual({ kind: 'icmp.abort', session: id });
    expect(vtyEvents(r1)).toEqual([]); // the injected delivery replaced the event action
    expect(delivered).toEqual([['d_r1', { kind: 'vty.output', conn: 'c1', text: '', prompt: 'R1>' }]]);
    h.cli.execRemote('d_r1', LINE('c1', 'enable'), 3); // a closed connection is ignored
    expect(delivered).toHaveLength(1);
  });

  it('delivers nothing to a device that does not run vty or is powered off', () => {
    const h = approvedHarness();
    const plain = h.add('d_r1', 'router', 'R1');
    h.cli.openRemote('d_r1', OPEN('c1'), 0);
    expect(plain.actionCalls).toEqual([]);
    const r2 = withProcesses(h.add('d_r2', 'router', 'R2'), 'vty');
    h.cli.openRemote('d_r2', OPEN('c1'), 0);
    expect(vtyEvents(r2)).toHaveLength(1);
    r2.power = false;
    h.cli.execRemote('d_r2', LINE('c1', 'enable'), 1);
    expect(vtyEvents(r2)).toHaveLength(1);
  });

  it('counts remote sessions apart (FacadeCounters.remote) and resumes the count', () => {
    const h = approvedHarness();
    h.add('d_r1', 'router', 'R1');
    expect(h.cli.counters()).toEqual({ sessions: 0, headless: 0 }); // absent until a remote session opens
    h.cli.open('d_r1', 'console');
    h.cli.openRemote('d_r1', OPEN('c1'), 0);
    h.cli.openRemote('d_r1', OPEN('c2'), 0);
    expect(h.cli.counters()).toEqual({ sessions: 1, headless: 0, remote: 2 });
    const resumed = approvedHarness({ resume: { sessions: 1, headless: 0, remote: 5 } });
    resumed.add('d_r1', 'router', 'R1');
    expect(resumed.cli.openRemote('d_r1', OPEN('c9'), 0)).toBe(`${REMOTE_SESSION_PREFIX}6`);
    expect(resumed.cli.open('d_r1', 'console')).toBe('s_2');
  });
});

describe('cli.remote nesting cap', () => {
  it(`stops at depth ${REMOTE_DEPTH_CAP}: a session that deep cannot open another`, () => {
    const h = approvedHarness();
    const pc = address(withProcesses(h.add('d_0', 'pc', 'PC0'), 'vty-client'), '10.0.0.100');
    const routers = [1, 2, 3, 4, 5].map((n) => address(withProcesses(h.add(`d_${n}`, 'router', `R${n}`), 'vty-client', 'vty'), `10.0.0.${n}`));
    const s = h.cli.open('d_0', 'console');
    // PC0 → R1
    h.cli.exec(s, 'ssh -l admin 10.0.0.1');
    let session = h.cli.openRemote('d_1', OPEN('c1', '10.0.0.100'), 0);
    // R1 → R2 → R3 → R4, each typed in the previous remote session
    for (let n = 2; n <= REMOTE_DEPTH_CAP; n++) {
      h.cli.execRemote(`d_${n - 1}`, LINE(`c${n - 1}`, `ssh -l admin 10.0.0.${n}`), n);
      expect(requests(routers[n - 2] as FakeDevice).at(-1)).toMatchObject({ kind: 'vty.connect', target: `10.0.0.${n}` });
      session = h.cli.openRemote(`d_${n}`, OPEN(`c${n}`, `10.0.0.${n - 1}`), n);
    }
    expect(session).toBe(`${REMOTE_SESSION_PREFIX}${REMOTE_DEPTH_CAP}`);
    // the fourth remote session may not nest a fifth
    h.cli.execRemote(`d_${REMOTE_DEPTH_CAP}`, LINE(`c${REMOTE_DEPTH_CAP}`, 'ssh -l admin 10.0.0.5'), 10);
    const last = vtyEvents(routers[REMOTE_DEPTH_CAP - 1] as FakeDevice).at(-1);
    expect(last?.text).toBe(MSG_REMOTE_DEPTH);
    expect(last?.prompt).toBe(`R${REMOTE_DEPTH_CAP}>`);
    expect(requests(routers[REMOTE_DEPTH_CAP - 1] as FakeDevice).some((r) => r.kind === 'vty.connect')).toBe(false);
    expect(h.cli.session(session)?.busy).toBe(false);
    // a session opened from an address no client claims counts as depth 1
    expect(h.cli.openRemote('d_5', OPEN('cx', '192.0.2.9'), 11)).toBe(`${REMOTE_SESSION_PREFIX}${REMOTE_DEPTH_CAP + 1}`);
    h.cli.execRemote('d_5', LINE('cx', 'ssh -l admin 10.0.0.1'), 12);
    expect(requests(routers[4] as FakeDevice).at(-1)).toMatchObject({ kind: 'vty.connect', target: '10.0.0.1' });
    expect(pc).toBeDefined();
  });
});

// ── journaling, on a real staged world: the client lines are the user's journaled `cliExec` ops; the relay they
// drive is a consequence of replayed events (the `remoteCli` SimEvent and its dispatch, W2 sim) ──

/** A stand-in vty-client: answers a connect and every line with the remote prompt, ends on an interrupt. */
function stubVtyClient(): Process {
  const inputs: string[] = [];
  return {
    name: 'vty-client',
    onPdu: () => [],
    onTimer: () => [],
    onConfig: () => [],
    onRequest: (_ctx, req): Action[] => {
      if (req.kind === 'vty.connect') return [{ type: 'cliRemote', session: req.session, prompt: 'R1>', remote: 'R1 via SSH' }];
      if (req.kind === 'vty.input') {
        inputs.push(req.line);
        return [{ type: 'cliRemote', session: req.session, prompt: 'R1>' }];
      }
      if (req.kind === 'vty.interrupt') return [{ type: 'cliDone', session: req.session }];
      return [];
    },
    stateSnapshot: (): StateView => ({ process: 'vty-client', state: { inputs: [...inputs] } }),
    debugEvents: () => [],
  };
}

const STUB = { 'vty-client': stubVtyClient } as const;
const inputsOf = (sim: Simulation): unknown => sim.device('pc1')?.processes.get('vty-client')?.stateSnapshot().state['inputs'];

describe('cli.remote journaling', () => {
  it('journals the client lines as cliExec and replays the same relay', () => {
    const sim = createStagedSimulation({ seed: 7, stage: 'P3', factories: STUB });
    sim.addDevice({ id: 'pc1', type: 'pc.nfpc', name: 'PC1' });
    sim.runToIdle();
    const s = sim.cli.open('pc1', 'console');
    expect(sim.cli.exec(s, 'ssh -l admin 192.168.10.1').busy).toBe(true);
    sim.runToIdle(); // the `remoteCli` event: setRemote
    expect(sim.cli.session(s)).toMatchObject({ prompt: 'R1>', remote: 'R1 via SSH', busy: false });
    sim.cli.exec(s, 'show version');
    sim.runToIdle();
    sim.cli.exec(s, 'show running-config');
    sim.runToIdle();
    sim.cli.interrupt(s);
    sim.runToIdle();
    expect(sim.cli.session(s)?.remote).toBeUndefined();
    expect(inputsOf(sim)).toEqual(['show version', 'show running-config']);
    const ops = sim.journal().entries.map((e) => e.op);
    expect(ops.filter((o) => o.op === 'cliExec')).toEqual([
      { op: 'cliExec', session: s, line: 'ssh -l admin 192.168.10.1' },
      { op: 'cliExec', session: s, line: 'show version' },
      { op: 'cliExec', session: s, line: 'show running-config' },
    ]);
    expect(ops.some((o) => o.op === 'cliInterrupt')).toBe(true);
    // the replay repeats the relay from the journal alone
    const replay = replayJournal(sim.journal(), undefined, { catalog: createStagedCatalog({ stage: 'P3', factories: STUB }) });
    replay.runToIdle();
    expect(inputsOf(replay)).toEqual(['show version', 'show running-config']);
    expect(replay.cli.session(s)?.history).toEqual(sim.cli.session(s)?.history);
  });
});
