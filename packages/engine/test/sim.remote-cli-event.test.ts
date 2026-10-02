/**
 * sim.remote-cli-event — [S13] the `remoteCli` SimEvent handler and the delivery of a remote session's output
 * (ARCHITECTURE-P3 D14, §2.4, §2.7, §3.14 steps 3–5; §7 W2 sim; sim/configure.ts `dispatchRemoteCli`,
 * `deliverVtyOutput`, wired into the Simulation's dispatch).
 *
 * The CLI runtime's remote sessions are the W2 cli item's, so the handler is pinned against a FAKE CliRuntime and a
 * fake device runtime that issues the vty / vty-client actions exactly as the W1 device item does (it schedules
 * `SimEvent remoteCli` at now, zero delay, non-periodic), popped by the real run loop. Pinned:
 *   • each act reaches the CLI core in the event's OWN dispatch (never inside the daemon's action application, never
 *     nested), at the event's time, with the device clock synced: `open` → openRemote, `line` → execRemote, `close`
 *     → closeRemote, `cliRemote` → setRemote;
 *   • a via-'vty' session's output reaches the device's vty daemon as ProcessEvent `vty.output` through a fresh
 *     top-level call of the facade, never as trace; a device that is gone, off, booting or not running vty gets none;
 *   • a CLI core without remote sessions answers `open` and `line` with REMOTE_CLI_UNAVAILABLE_TEXT and `closed`;
 *   • a device that is gone, off or booting gets no call at all;
 *   • on a real world (`staged.world`, a stand-in vty daemon), the runtime's action becomes one live `remoteCli` event
 *     the Simulation dispatches, and `deliverVtyOutput` reaches the real daemon;
 *   • with the real CLI core (the W2 cli item's remote sessions), the facade's `remoteOutput` hands the session's prompt
 *     and output to vty as `vty.output` (never `cliOutput` / `cliPrompt`, never journaled), and `FacadeCounters.remote`
 *     is counted, carried by a journal origin, and resumed (absent from a P2-shaped resume);
 *   • (W2 fix, verified finding 5) that output is never applied where the CLI core produces it: each piece is its own
 *     zero-delay `remoteOutput` event, so a debug line raised in the middle of a daemon's handler reaches vty from a
 *     fresh top-level call, and a vty that answers every output with a packet never nests the device runtime.
 */
import { describe, expect, it } from 'vitest';
import type { CliRuntime } from '../src/contracts/cli.js';
import type { DeviceRuntime } from '../src/contracts/device.js';
import type { SimEvent } from '../src/contracts/events.js';
import type { DeviceId, ProcessName } from '../src/contracts/ids.js';
import type { Action, CliRemoteAction, Process, RemoteCliAction } from '../src/contracts/process.js';
import { SEC, type SimTime } from '../src/contracts/time.js';
import type { ProcessEvent, VtyOutputEvent } from '../src/contracts/transport.js';
import { REMOTE_CLI_UNAVAILABLE_TEXT, VTY_PROCESS, deliverVtyOutput, dispatchRemoteCli, type RemoteCliEnv, type RemoteCliEvent } from '../src/sim/configure.js';
import { createRunControl, createTrackedScheduler, isPeriodicEvent, type TrackedScheduler } from '../src/sim/run-control.js';
import { SIM_PROCESS_NAME } from '../src/sim/simulation.js';
import { createTraceRing } from '../src/trace/ring.js';
import { createStagedSimulation } from './staged.world.js';

/** One top-level `applyActions` call the fake runtime received. */
interface ApplyCall {
  readonly process: ProcessName;
  readonly actions: readonly Action[];
  readonly now: SimTime;
}

/** A fake runtime that schedules `remoteCli` for the two [S13] actions, as the W1 device item does. */
function fakeRuntime(sched: TrackedScheduler, id: DeviceId = 'd1', runsVty = true) {
  const calls: ApplyCall[] = [];
  const delivered: { to: ProcessName; ev: ProcessEvent; now: SimTime }[] = [];
  let depth = 0;
  const dev = {
    id,
    power: true,
    bootedAt: 0 as SimTime | undefined,
    processes: new Map<ProcessName, unknown>(runsVty ? [[VTY_PROCESS, {}]] : []),
    get applying(): boolean {
      return depth > 0;
    },
    applyActions(process: ProcessName, actions: Action[], now: SimTime): void {
      calls.push({ process, actions: [...actions], now });
      depth++;
      try {
        for (const a of actions) {
          if (a.type === 'remoteCli' || a.type === 'cliRemote') sched.schedule(now, { kind: 'remoteCli', device: id, from: process, act: { ...a } });
          else if (a.type === 'event') delivered.push({ to: a.to, ev: a.ev, now });
        }
      } finally {
        depth--;
      }
    },
  };
  return { dev, calls, delivered };
}

/** A fake CLI core: records its calls (and whether they ran inside the daemon's application); `open` prints a prompt. */
function fakeCli(env: () => RemoteCliEnv, inIssuer: () => boolean) {
  const calls: { method: string; device?: DeviceId; act: RemoteCliAction | CliRemoteAction; at: SimTime; inIssuer: boolean }[] = [];
  const cli: Required<Pick<CliRuntime, 'openRemote' | 'execRemote' | 'closeRemote' | 'setRemote'>> = {
    openRemote(device, act, now) {
      calls.push({ method: 'openRemote', device, act, at: now, inIssuer: inIssuer() });
      // the session's first output: its prompt, delivered to the vty daemon (the CLI core's output path)
      deliverVtyOutput(env(), device, { kind: 'vty.output', conn: act.conn, text: '\r\n', prompt: 'R1>' }, now);
      return 's_9';
    },
    execRemote(device, act, now) {
      calls.push({ method: 'execRemote', device, act, at: now, inIssuer: inIssuer() });
      deliverVtyOutput(env(), device, { kind: 'vty.output', conn: act.conn, text: `ran ${act.text ?? ''}\r\n`, prompt: 'R1>' }, now);
    },
    closeRemote(device, act, now) {
      calls.push({ method: 'closeRemote', device, act, at: now, inIssuer: inIssuer() });
    },
    setRemote(act, now) {
      calls.push({ method: 'setRemote', act, at: now, inIssuer: inIssuer() });
    },
  };
  return { cli, calls };
}

/** A run loop over `sched` whose dispatch is the Simulation's for the kinds these cases use. */
function loop(sched: TrackedScheduler, env: RemoteCliEnv, onTimer: (at: SimTime) => void) {
  const ring = createTraceRing(16);
  const dispatch = (ev: SimEvent): void => {
    if (ev.kind === 'remoteCli') dispatchRemoteCli(env, ev);
    else if (ev.kind === 'timer') onTimer(ev.at);
  };
  return createRunControl({ scheduler: () => sched, dispatch, trace: ring, tap: () => () => undefined });
}

function world(opts: { runsVty?: boolean; cli?: RemoteCliEnv['cli'] } = {}) {
  const sched = createTrackedScheduler();
  const rt = fakeRuntime(sched, 'd1', opts.runsVty ?? true);
  const synced: SimTime[] = [];
  let env: RemoteCliEnv | undefined;
  const fake = fakeCli(() => env!, () => rt.dev.applying);
  env = {
    device: (id) => (id === rt.dev.id ? (rt.dev as unknown as DeviceRuntime) : undefined),
    cli: opts.cli ?? fake.cli,
    syncClock: () => synced.push(sched.now),
    caller: SIM_PROCESS_NAME,
  };
  return { sched, rt, fake, synced, env };
}

const OPEN: RemoteCliAction = { type: 'remoteCli', op: 'open', conn: 'c1', peer: '192.168.10.10', proto: 'ssh', user: 'admin' };
const LINE: RemoteCliAction = { type: 'remoteCli', op: 'line', conn: 'c1', text: 'show clock' };
const CLOSE: RemoteCliAction = { type: 'remoteCli', op: 'close', conn: 'c1' };
const CLIENT: CliRemoteAction = { type: 'cliRemote', session: 's_1', prompt: 'R1>', input: 'plain', remote: 'R1 via SSH' };

describe('remoteCli: the dispatch (fake CLI core, fake runtime)', () => {
  it('open runs in its own dispatch at now; the prompt reaches vty as vty.output from a fresh facade call', () => {
    const w = world();
    const at = 3 * SEC;
    const run = loop(w.sched, w.env, (t) => w.rt.dev.applyActions(VTY_PROCESS, [OPEN], t));
    w.sched.schedule(at, { kind: 'timer', device: 'd1', process: VTY_PROCESS, key: 'k' });

    run.step(); // the daemon's dispatch: the action is scheduled, nothing else
    expect(w.fake.calls).toEqual([]);
    expect(w.sched.size).toBe(1);
    expect(w.sched.nonPeriodic).toBe(1);

    run.step(); // the event's own dispatch
    expect(w.sched.now).toBe(at);
    expect(w.fake.calls).toEqual([{ method: 'openRemote', device: 'd1', act: OPEN, at, inIssuer: false }]);
    expect(w.synced).toEqual([at]);
    const out: VtyOutputEvent = { kind: 'vty.output', conn: 'c1', text: '\r\n', prompt: 'R1>' };
    expect(w.rt.delivered).toEqual([{ to: VTY_PROCESS, ev: out, now: at }]);
    expect(w.rt.calls.map((c) => [c.process, c.actions.map((a) => a.type), c.now])).toEqual([
      [VTY_PROCESS, ['remoteCli'], at],
      [SIM_PROCESS_NAME, ['event'], at],
    ]);
  });

  it('line, close and the client view go to execRemote, closeRemote and setRemote, in order', () => {
    const w = world();
    const run = loop(w.sched, w.env, (t) => {
      w.rt.dev.applyActions(VTY_PROCESS, [OPEN, LINE, CLOSE], t);
      w.rt.dev.applyActions('vty-client', [CLIENT], t);
    });
    w.sched.schedule(SEC, { kind: 'timer', device: 'd1', process: VTY_PROCESS, key: 'k' });
    const stats = run.runToIdle(100);
    expect(stats.events).toBe(5);
    expect(w.fake.calls.map((c) => [c.method, c.act.type === 'remoteCli' ? c.act.op : 'client', c.inIssuer])).toEqual([
      ['openRemote', 'open', false],
      ['execRemote', 'line', false],
      ['closeRemote', 'close', false],
      ['setRemote', 'client', false],
    ]);
    expect(w.fake.calls[3]!.act).toEqual(CLIENT);
    expect(w.rt.delivered.map((d) => (d.ev as VtyOutputEvent).text)).toEqual(['\r\n', 'ran show clock\r\n']);
  });

  it('a remote act issued while one is being applied is a new event, never a nested call', () => {
    const sched = createTrackedScheduler();
    const rt = fakeRuntime(sched);
    let depth = 0;
    let maxDepth = 0;
    const cli: RemoteCliEnv['cli'] = {
      openRemote: (_d, act) => {
        depth++;
        maxDepth = Math.max(maxDepth, depth);
        // a nested session: the CLI core makes the device's vty-client act (the runtime schedules it)
        rt.dev.applyActions('vty-client', [{ ...CLIENT, session: `for-${act.conn}` }], sched.now);
        depth--;
        return 's_2';
      },
      setRemote: () => {
        depth++;
        maxDepth = Math.max(maxDepth, depth);
        depth--;
      },
    };
    const env: RemoteCliEnv = { device: () => rt.dev as unknown as DeviceRuntime, cli, syncClock: () => undefined, caller: SIM_PROCESS_NAME };
    const run = loop(sched, env, (t) => rt.dev.applyActions(VTY_PROCESS, [OPEN], t));
    sched.schedule(SEC, { kind: 'timer', device: 'd1', process: VTY_PROCESS, key: 'k' });
    expect(run.runToIdle(100).events).toBe(3);
    expect(maxDepth).toBe(1);
  });

  it('a CLI core without remote sessions answers open and line with the unavailable text and closes', () => {
    const w = world({ cli: {} });
    const ev = (act: RemoteCliAction | CliRemoteAction): RemoteCliEvent => ({ kind: 'remoteCli', device: 'd1', from: VTY_PROCESS, act, at: 7, seq: 0 });
    dispatchRemoteCli(w.env, ev(OPEN));
    dispatchRemoteCli(w.env, ev(LINE));
    dispatchRemoteCli(w.env, ev(CLOSE));
    dispatchRemoteCli(w.env, ev(CLIENT));
    const closed: VtyOutputEvent = { kind: 'vty.output', conn: 'c1', text: REMOTE_CLI_UNAVAILABLE_TEXT, closed: true };
    expect(w.rt.delivered).toEqual([
      { to: VTY_PROCESS, ev: closed, now: 7 },
      { to: VTY_PROCESS, ev: closed, now: 7 },
    ]);
    expect(REMOTE_CLI_UNAVAILABLE_TEXT).toMatch(/^% Remote sessions are not available/);
  });

  it('a device that is gone, off or booting gets no call and no output', () => {
    for (const state of ['gone', 'off', 'booting'] as const) {
      const w = world();
      if (state === 'off') w.rt.dev.power = false;
      if (state === 'booting') w.rt.dev.bootedAt = undefined;
      const env: RemoteCliEnv = state === 'gone' ? { ...w.env, device: () => undefined } : w.env;
      for (const act of [OPEN, LINE, CLOSE, CLIENT]) dispatchRemoteCli(env, { kind: 'remoteCli', device: 'd1', from: VTY_PROCESS, act, at: 1, seq: 1 });
      expect(w.fake.calls, state).toEqual([]);
      expect(w.rt.delivered, state).toEqual([]);
      expect(w.synced, state).toEqual([]);
    }
  });

  it('is live work, not a periodic timer, so runToIdle waits for it', () => {
    const body: RemoteCliEvent = { kind: 'remoteCli', device: 'd1', from: VTY_PROCESS, act: OPEN, at: 0, seq: 0 };
    expect(isPeriodicEvent(body)).toBe(false);
  });
});

describe('deliverVtyOutput', () => {
  it('copies only the members that are set, and reaches only a booted device that runs vty', () => {
    const w = world();
    expect(deliverVtyOutput(w.env, 'd1', { kind: 'vty.output', conn: 'c2', text: 'Password: ', input: 'secret' }, 4)).toBe(true);
    expect(deliverVtyOutput(w.env, 'd1', { kind: 'vty.output', conn: 'c2', text: 'bye\r\n', closed: true }, 5)).toBe(true);
    expect(w.rt.delivered).toEqual([
      { to: VTY_PROCESS, ev: { kind: 'vty.output', conn: 'c2', text: 'Password: ', input: 'secret' }, now: 4 },
      { to: VTY_PROCESS, ev: { kind: 'vty.output', conn: 'c2', text: 'bye\r\n', closed: true }, now: 5 },
    ]);
    expect(deliverVtyOutput(w.env, 'd9', { kind: 'vty.output', conn: 'c2', text: 'x' }, 6)).toBe(false);
    const noVty = world({ runsVty: false });
    expect(deliverVtyOutput(noVty.env, 'd1', { kind: 'vty.output', conn: 'c2', text: 'x' }, 6)).toBe(false);
    expect(noVty.rt.delivered).toEqual([]);
  });
});

describe('remoteCli on a real world (staged.world, a stand-in vty daemon)', () => {
  /** A stand-in vty daemon that records the events it receives. */
  function vty(seen: ProcessEvent[]): Process {
    return {
      name: VTY_PROCESS,
      onPdu: () => [],
      onTimer: () => [],
      onConfig: () => [],
      onEvent: (_ctx, ev) => {
        seen.push(ev);
        return [];
      },
      stateSnapshot: () => ({ process: VTY_PROCESS, state: {} }),
      debugEvents: () => [],
    };
  }

  it("the runtime's action is one live remoteCli event that the Simulation dispatches, and output reaches the daemon", () => {
    const seen: ProcessEvent[] = [];
    const sim = createStagedSimulation({ seed: 6, stage: 'P3', factories: { vty: () => vty(seen) } });
    sim.addDevice({ id: 'r1', type: 'router.nf2911', name: 'R1' });
    sim.runFor(60 * SEC);
    sim.runToIdle();
    const dev = sim.device('r1')!;
    expect(dev.processes.has(VTY_PROCESS)).toBe(true);

    const pending = sim.snapshot().pendingEvents;
    const trace: string[] = [];
    sim.onTrace((ev) => trace.push(ev.kind));
    dev.applyActions(VTY_PROCESS, [CLOSE], sim.now); // a close produces no output whatever the CLI core supports
    expect(sim.snapshot().pendingEvents).toBe(pending + 1);
    const ev = sim.step();
    expect(ev?.kind).toBe('remoteCli');
    expect(ev).toMatchObject({ kind: 'remoteCli', device: 'r1', from: VTY_PROCESS, act: CLOSE });
    expect(trace.filter((k) => k === 'cliOutput')).toEqual([]);

    const env = { device: (id: DeviceId) => sim.device(id), caller: SIM_PROCESS_NAME };
    expect(deliverVtyOutput(env, 'r1', { kind: 'vty.output', conn: 'c7', text: 'R1>', prompt: 'R1>' }, sim.now)).toBe(true);
    expect(seen).toEqual([{ kind: 'vty.output', conn: 'c7', text: 'R1>', prompt: 'R1>' }]);
    expect(trace.filter((k) => k === 'cliOutput')).toEqual([]);

    // a powered-off device: the scheduled act is dropped with the device's daemons
    dev.applyActions(VTY_PROCESS, [OPEN], sim.now);
    sim.setPower('r1', false);
    sim.runToIdle();
    expect(seen).toHaveLength(1);
  });

  it("with the real CLI core: a session's prompt and output reach vty as vty.output, never as trace; remote is counted", () => {
    const seen: ProcessEvent[] = [];
    const sim = createStagedSimulation({ seed: 6, stage: 'P3', factories: { vty: () => vty(seen) } });
    sim.addDevice({ id: 'r1', type: 'router.nf2911', name: 'R1' });
    sim.runFor(60 * SEC);
    sim.runToIdle();
    const dev = sim.device('r1')!;
    const kinds: string[] = [];
    sim.onTrace((ev) => kinds.push(ev.kind));
    const journaled = sim.journal().entries.length;
    const consoles = sim.cli.sessions().length;

    dev.applyActions(VTY_PROCESS, [OPEN], sim.now);
    expect(seen).toEqual([]); // nothing inline: the act waits for its own event
    expect(sim.step()?.kind).toBe('remoteCli');
    // W2 fix: the session's output is its own event too (zero delay, at the same instant), never applied inside another
    expect(seen).toEqual([]);
    const at = sim.now;
    expect(sim.step()).toMatchObject({ kind: 'remoteOutput', device: 'r1', at, out: { kind: 'vty.output', conn: 'c1', prompt: 'R1>' } });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ kind: 'vty.output', conn: 'c1', prompt: 'R1>' });
    expect(seen[0]).not.toHaveProperty('closed');

    dev.applyActions(VTY_PROCESS, [{ type: 'remoteCli', op: 'line', conn: 'c1', text: 'exit' }], sim.now);
    expect(sim.step()?.kind).toBe('remoteCli');
    expect(sim.step()?.kind).toBe('remoteOutput');
    expect(seen).toHaveLength(2);
    expect(seen[1]).toMatchObject({ kind: 'vty.output', conn: 'c1', closed: true });

    // the server side never prints to the trace and is never journaled (a consequence of replayed events)
    expect(kinds.filter((k) => k === 'cliOutput' || k === 'cliPrompt')).toEqual([]);
    expect(sim.journal().entries).toHaveLength(journaled);
    expect(sim.cli.sessions()).toHaveLength(consoles);

    // FacadeCounters.remote: a journal origin taken after the session counts it; a P2-shaped resume has none
    sim.loadTopology(sim.exportTopology());
    expect(sim.journal().origin.counters.remote).toBe(1);
  });

  it('resumes the remote counter, so a replay numbers the server side as the live world did', () => {
    const fresh = createStagedSimulation({ seed: 6, stage: 'P3' });
    expect(fresh.journal().origin.counters).not.toHaveProperty('remote');
    const resumed = createStagedSimulation({
      seed: 6,
      stage: 'P3',
      resume: { traceHead: 0, sessions: 0, headless: 0, requests: 0, topologyVersion: 0, remote: 4 },
    });
    expect(resumed.journal().origin.counters.remote).toBe(4);
    expect(() =>
      createStagedSimulation({ seed: 6, stage: 'P3', resume: { traceHead: 0, sessions: 0, headless: 0, requests: 0, topologyVersion: 0, remote: -1 } }),
    ).toThrow(/resume\.remote must be a non-negative integer/);
  });
});

describe('remote output is never applied where it is produced (W2 fix, verified finding 5)', () => {
  it('a vty that answers every output with a packet, with `debug ip packet` on: each vty.output is a top-level call, and the run ends', () => {
    const seen: { readonly ev: VtyOutputEvent; readonly depth: number }[] = [];
    let depth = 0;
    let sent = 0;
    const SENDS = 40;
    const vty = (): Process => ({
      name: VTY_PROCESS,
      onPdu: () => [],
      onTimer: () => [],
      onConfig: () => [],
      onEvent: (ctx, ev) => {
        if (ev.kind !== 'vty.output') return [];
        seen.push({ ev, depth });
        if (sent >= SENDS) return []; // the stand-in's own bound; the engine imposes none
        sent++;
        // as the W3 daemon's TCP data would: one packet per output, whose 'ip packet' debug line is more output
        const pdu = ctx.newPdu([
          { proto: 'ipv4', fields: { src: '10.0.0.1', dst: '10.0.0.2', protocol: 17, ttl: 64 } },
          { proto: 'udp', fields: { srcPort: 49152, dstPort: 9 } },
          { proto: 'payload', fields: { data: new Uint8Array(4) } },
        ]);
        return [{ type: 'request', to: 'ipv4', req: { kind: 'ipv4.send', pdu } }];
      },
      stateSnapshot: () => ({ process: VTY_PROCESS, state: {} }),
      debugEvents: () => [],
    });
    const sim = createStagedSimulation({ seed: 6, stage: 'P3', factories: { vty } });
    sim.addDevice({ id: 'r1', type: 'router.nf2911', name: 'R1', startupConfig: 'hostname R1\ninterface GigabitEthernet0/0\n ip address 10.0.0.1 255.255.255.0\n no shutdown\n' });
    sim.addDevice({ id: 'pc1', type: 'pc.nfpc', name: 'PC1', startupConfig: 'interface GigabitEthernet0\n ip address 10.0.0.2 255.255.255.0\n' });
    sim.addLink({ a: { device: 'r1', port: 'GigabitEthernet0/0' }, b: { device: 'pc1', port: 'GigabitEthernet0' } });
    sim.runFor(60 * SEC);
    sim.runToIdle();
    const dev = sim.device('r1')!;
    // count how deep the device runtime is when vty sees each output (1 = a fresh top-level call)
    const apply = dev.applyActions.bind(dev);
    (dev as { applyActions: DeviceRuntime['applyActions'] }).applyActions = (process, actions, now) => {
      depth++;
      try {
        apply(process, actions, now);
      } finally {
        depth--;
      }
    };
    const console = sim.cli.open('r1', 'console');
    for (const line of ['enable', 'debug ip packet']) sim.cli.exec(console, line);
    dev.applyActions(VTY_PROCESS, [OPEN], sim.now);
    const stats = sim.runToIdle(100_000);
    expect(stats.stopped).not.toBe('maxEvents');
    expect(sent).toBe(SENDS);
    expect(seen.length).toBeGreaterThan(SENDS);
    expect(seen.some((s) => s.ev.text.includes('ip packet:'))).toBe(true);
    expect([...new Set(seen.map((s) => s.depth))]).toEqual([1]);
  });
});
