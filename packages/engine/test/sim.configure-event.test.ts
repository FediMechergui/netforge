/**
 * sim — the `deviceConfigure` event handler, the one caller of the CLI core's headless configure for a daemon
 * (ARCHITECTURE-P3 D21, §3.0 (c), §2.4, §2.7; §7 W1 sim; sim/configure.ts `dispatchDeviceConfigure`, wired into the
 * Simulation's dispatch).
 *
 * The real runtime's `configure` action is the W1 device item's (it schedules the event through `deps.scheduler`), so
 * these cases run against a FAKE runtime that issues the action exactly as §3.0 (c) step 2 says: at `now`, zero delay,
 * non-periodic. The real run loop (`createRunControl` over a `TrackedScheduler`) pops the events, as the Simulation
 * does. They pin that the handler runs in its own dispatch (never inside the issuer's action application, never
 * nested), with its own action budget (the result is delivered by a fresh top-level `applyActions` of the facade),
 * passes `{atomic, indentation, origin}` through, invalidates the rendered configs and delivers `config.result` with
 * the issuer's token; that a device that is gone, powered off or booting gets nothing; and, on a real device with the
 * real CLI, that an atomic run that fails reverts every line and still answers. The real runtime's action through the
 * Simulation is W2's `sim.device-configure.test.ts`.
 */
import { describe, expect, it } from 'vitest';
import type { ConfigureOptions, ConfigureResult } from '../src/contracts/cli.js';
import type { DeviceRuntime } from '../src/contracts/device.js';
import type { SimEvent } from '../src/contracts/events.js';
import type { DeviceId, ProcessName } from '../src/contracts/ids.js';
import type { Action, ConfigOrigin, Process } from '../src/contracts/process.js';
import { SEC, type SimTime } from '../src/contracts/time.js';
import type { ProcessEvent } from '../src/contracts/transport.js';
import { dispatchDeviceConfigure, deviceConfigureOptions, type DeviceConfigureEnv, type DeviceConfigureEvent } from '../src/sim/configure.js';
import { createRunControl, createTrackedScheduler, isPeriodicEvent, type TrackedScheduler } from '../src/sim/run-control.js';
import { SIM_PROCESS_NAME } from '../src/sim/simulation.js';
import { createTraceRing } from '../src/trace/ring.js';
import { createStagedSimulation } from './staged.world.js';

const ORIGIN: ConfigOrigin = { via: 'restconf', user: 'admin', address: '192.168.1.10' };
/** The action budget of one top-level `applyActions` call (device.ts ACTION_BUDGET). */
const BUDGET = 1000;

/** One top-level `applyActions` call the fake runtime received. */
interface ApplyCall {
  readonly process: ProcessName;
  readonly actions: readonly Action[];
  readonly now: SimTime;
}

/** A fake runtime that issues the configure action as the W1 device item does (§3.0 (c) step 2). */
function fakeRuntime(sched: TrackedScheduler, id: DeviceId = 'd1') {
  const calls: ApplyCall[] = [];
  const delivered: { to: ProcessName; ev: ProcessEvent; now: SimTime }[] = [];
  let depth = 0;
  const dev = {
    id,
    power: true,
    bootedAt: 0 as SimTime | undefined,
    spec: { id, type: 'router.fake', name: 'R1' },
    /** True while a top-level call is being applied (the issuer's action application). */
    get applying(): boolean {
      return depth > 0;
    },
    applyActions(process: ProcessName, actions: Action[], now: SimTime): void {
      calls.push({ process, actions: [...actions], now });
      depth++;
      try {
        let budget = BUDGET;
        for (const a of actions) {
          if (budget-- === 0) throw new Error('action budget exhausted');
          if (a.type === 'configure') {
            const opts: DeviceConfigureEvent['opts'] = { origin: a.origin };
            if (a.atomic !== undefined) opts.atomic = a.atomic;
            if (a.indentation !== undefined) opts.indentation = a.indentation;
            sched.schedule(now, { kind: 'deviceConfigure', device: id, from: process, token: a.token, lines: a.lines, opts });
          } else if (a.type === 'event') {
            delivered.push({ to: a.to, ev: a.ev, now });
          }
        }
      } finally {
        depth--;
      }
    },
  };
  return { dev, calls, delivered };
}

/** A run loop over `sched` whose dispatch is the Simulation's for the two kinds these cases use. */
function loop(sched: TrackedScheduler, env: DeviceConfigureEnv, onTimer: (at: SimTime) => void) {
  const ring = createTraceRing(16);
  const dispatch = (ev: SimEvent): void => {
    if (ev.kind === 'deviceConfigure') dispatchDeviceConfigure(env, ev);
    else if (ev.kind === 'timer') onTimer(ev.at);
  };
  return createRunControl({ scheduler: () => sched, dispatch, trace: ring, tap: () => () => undefined });
}

function okResult(n: number): ConfigureResult {
  return { ok: true, lines: [], applied: n, finalMode: 'config' };
}

describe('deviceConfigure (against a fake runtime that issues the action)', () => {
  function world(result: ConfigureResult = okResult(3)) {
    const sched = createTrackedScheduler();
    const rt = fakeRuntime(sched);
    const configured: { device: DeviceId; commands: readonly string[]; opts: ConfigureOptions; inIssuer: boolean; at: SimTime }[] = [];
    const invalidated: DeviceId[] = [];
    const synced: SimTime[] = [];
    const env: DeviceConfigureEnv = {
      device: (id) => (id === rt.dev.id ? (rt.dev as unknown as DeviceRuntime) : undefined),
      configure: (device, commands, opts) => {
        configured.push({ device, commands: [...commands], opts, inIssuer: rt.dev.applying, at: sched.now });
        return result;
      },
      syncClock: () => synced.push(sched.now),
      invalidate: (id) => invalidated.push(id),
      caller: SIM_PROCESS_NAME,
    };
    return { sched, rt, configured, invalidated, synced, env };
  }

  const issue = (lines: readonly string[], extra: { atomic?: boolean; indentation?: boolean } = {}): Action => ({
    type: 'configure',
    token: 'api-7',
    lines,
    origin: ORIGIN,
    ...extra,
  });

  it('is scheduled at now as live work and runs in its own dispatch, never inside the issuer', () => {
    const w = world();
    const at = 5 * SEC;
    const run = loop(w.sched, w.env, (t) => w.rt.dev.applyActions('restconf', [issue(['vlan 30', ' name API'], { atomic: true, indentation: true })], t));
    w.sched.schedule(at, { kind: 'timer', device: 'd1', process: 'restconf', key: 'k' });

    // the issuer's dispatch: the action is applied, the lines are not
    run.step();
    expect(w.configured).toEqual([]);
    expect(w.rt.delivered).toEqual([]);
    expect(w.sched.size).toBe(1);
    expect(w.sched.nonPeriodic).toBe(1);

    // the event's own dispatch, at the same instant
    const before = w.sched.dispatched;
    run.step();
    expect(w.sched.dispatched).toBe(before + 1);
    expect(w.sched.now).toBe(at);
    expect(w.configured).toEqual([
      { device: 'd1', commands: ['vlan 30', ' name API'], opts: { origin: ORIGIN, atomic: true, indentation: true }, inIssuer: false, at },
    ]);
    expect(w.synced).toEqual([at]);
    expect(w.invalidated).toEqual(['d1']);
  });

  it('delivers config.result with the token to the issuer, from a fresh top-level call of the facade', () => {
    const result = okResult(2);
    const w = world(result);
    const run = loop(w.sched, w.env, (t) => w.rt.dev.applyActions('restconf', [issue(['hostname R9'])], t));
    w.sched.schedule(SEC, { kind: 'timer', device: 'd1', process: 'restconf', key: 'k' });
    const stats = run.runToIdle(100);
    expect(stats.events).toBe(2);
    expect(w.rt.delivered).toEqual([{ to: 'restconf', ev: { kind: 'config.result', token: 'api-7', result }, now: SEC }]);
    // two top-level calls: the issuer's (its action), then the facade's delivery with its own budget
    expect(w.rt.calls.map((c) => [c.process, c.actions.map((a) => a.type), c.now])).toEqual([
      ['restconf', ['configure'], SEC],
      [SIM_PROCESS_NAME, ['event'], SEC],
    ]);
  });

  it('keeps each issue apart: two actions in one dispatch give two events, run in order, each answered', () => {
    const w = world();
    const run = loop(w.sched, w.env, (t) =>
      w.rt.dev.applyActions('restconf', [{ ...issue(['vlan 10']), token: 'a' } as Action, { ...issue(['vlan 20']), token: 'b' } as Action], t),
    );
    w.sched.schedule(SEC, { kind: 'timer', device: 'd1', process: 'restconf', key: 'k' });
    run.runToIdle(100);
    expect(w.configured.map((c) => c.commands)).toEqual([['vlan 10'], ['vlan 20']]);
    expect(w.rt.delivered.map((d) => (d.ev as { token: string }).token)).toEqual(['a', 'b']);
  });

  it('a configure issued while answering is a new event, never a nested run', () => {
    const sched = createTrackedScheduler();
    const rt = fakeRuntime(sched);
    let depth = 0;
    let maxDepth = 0;
    const env: DeviceConfigureEnv = {
      device: () => rt.dev as unknown as DeviceRuntime,
      configure: (_d, commands) => {
        depth++;
        maxDepth = Math.max(maxDepth, depth);
        // the "daemon" reacts to its own change by issuing one more configure (the runtime schedules it)
        if (commands[0] === 'vlan 1') rt.dev.applyActions('restconf', [issue(['vlan 2'])], sched.now);
        depth--;
        return okResult(1);
      },
      syncClock: () => undefined,
      invalidate: () => undefined,
      caller: SIM_PROCESS_NAME,
    };
    const run = loop(sched, env, (t) => rt.dev.applyActions('restconf', [issue(['vlan 1'])], t));
    sched.schedule(SEC, { kind: 'timer', device: 'd1', process: 'restconf', key: 'k' });
    const stats = run.runToIdle(100);
    expect(stats.events).toBe(3);
    expect(maxDepth).toBe(1);
    expect(rt.delivered).toHaveLength(2);
  });

  it('is live work, not a periodic timer, so runToIdle waits for it', () => {
    const body: DeviceConfigureEvent = {
      kind: 'deviceConfigure',
      device: 'd1',
      from: 'restconf',
      token: 't',
      lines: [],
      opts: { origin: ORIGIN },
      at: 0,
      seq: 0,
    };
    expect(isPeriodicEvent(body)).toBe(false);
  });

  it('gives a device that is gone, powered off or booting nothing: no run, no answer', () => {
    for (const state of ['gone', 'off', 'booting'] as const) {
      const w = world();
      if (state === 'off') w.rt.dev.power = false;
      if (state === 'booting') w.rt.dev.bootedAt = undefined;
      const env: DeviceConfigureEnv = state === 'gone' ? { ...w.env, device: () => undefined } : w.env;
      const ev: DeviceConfigureEvent = { kind: 'deviceConfigure', device: 'd1', from: 'restconf', token: 't', lines: ['vlan 5'], opts: { origin: ORIGIN }, at: SEC, seq: 1 };
      dispatchDeviceConfigure(env, ev);
      expect(w.configured, state).toEqual([]);
      expect(w.invalidated, state).toEqual([]);
      expect(w.rt.delivered, state).toEqual([]);
    }
  });

  it('builds the headless options from the event: origin always, atomic and indentation only when given', () => {
    expect(deviceConfigureOptions({ origin: ORIGIN })).toEqual({ origin: ORIGIN });
    expect('atomic' in deviceConfigureOptions({ origin: ORIGIN })).toBe(false);
    expect(deviceConfigureOptions({ origin: ORIGIN, atomic: false, indentation: true })).toEqual({ origin: ORIGIN, atomic: false, indentation: true });
  });

  it('invalidates the rendered configs even when the run throws', () => {
    const w = world();
    const env: DeviceConfigureEnv = {
      ...w.env,
      configure: () => {
        throw new Error('broken');
      },
    };
    const ev: DeviceConfigureEvent = { kind: 'deviceConfigure', device: 'd1', from: 'restconf', token: 't', lines: ['x'], opts: { origin: ORIGIN }, at: 0, seq: 1 };
    expect(() => dispatchDeviceConfigure(env, ev)).toThrow('broken');
    expect(w.invalidated).toEqual(['d1']);
    expect(w.rt.delivered).toEqual([]);
  });
});

describe('deviceConfigure on a real device with the real CLI', () => {
  /** A stand-in for the issuing daemon (it replaces `hsrp` on the router), recording the events it receives. */
  function recorder(seen: ProcessEvent[]): Process {
    return {
      name: 'hsrp',
      onPdu: () => [],
      onTimer: () => [],
      onConfig: () => [],
      onEvent: (_ctx, ev) => {
        seen.push(ev);
        return [];
      },
      stateSnapshot: () => ({ process: 'hsrp', state: {} }),
      debugEvents: () => [],
    };
  }

  it('applies the lines through the CLI, answers the issuer, and an atomic failure reverts every line', () => {
    const seen: ProcessEvent[] = [];
    const sim = createStagedSimulation({ seed: 3, stage: 'P2', factories: { hsrp: () => recorder(seen) } });
    const r1 = sim.addDevice({ type: 'router.nf2911', name: 'R1' });
    sim.runFor(60 * SEC);
    const dev = sim.device(r1)!;
    expect(dev.processes.has('hsrp')).toBe(true);
    const env: DeviceConfigureEnv = {
      device: (id) => sim.device(id),
      configure: (device, commands, opts) => sim.cli.configure(device, commands, opts),
      syncClock: (d) => d.applyActions(SIM_PROCESS_NAME, [], sim.now),
      invalidate: () => undefined,
      caller: SIM_PROCESS_NAME,
    };
    const ev = (token: string, lines: readonly string[]): DeviceConfigureEvent => ({
      kind: 'deviceConfigure',
      device: r1,
      from: 'hsrp',
      token,
      lines,
      opts: { atomic: true, indentation: true, origin: ORIGIN },
      at: sim.now,
      seq: 0,
    });

    dispatchDeviceConfigure(env, ev('ok', ['hostname EDGE', 'interface GigabitEthernet0/0', ' description to the API']));
    expect(dev.running.query('hostname').map((n) => n.args.join(' '))).toEqual(['EDGE']);
    expect(seen).toHaveLength(1);
    const first = seen[0] as Extract<ProcessEvent, { kind: 'config.result' }>;
    expect(first.kind).toBe('config.result');
    expect(first.token).toBe('ok');
    expect(first.result.ok).toBe(true);
    expect(first.result.lines.map((l) => l.ok)).toEqual([true, true, true]);

    dispatchDeviceConfigure(env, ev('bad', ['hostname OTHER', 'interface NoSuchPort9/9', ' description x']));
    expect(dev.running.query('hostname').map((n) => n.args.join(' '))).toEqual(['EDGE']);
    expect(seen).toHaveLength(2);
    const second = seen[1] as Extract<ProcessEvent, { kind: 'config.result' }>;
    expect(second.token).toBe('bad');
    expect(second.result.ok).toBe(false);
    expect(second.result.reverted).toBe(true);
  });
});
