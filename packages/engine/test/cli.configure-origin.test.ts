/**
 * The origin of a headless configure run (ARCHITECTURE-P3 D21, §2.11 `ConfigureOptions.origin`, §2.9
 * `DeviceRuntime.applyConfigLine(context, line, negate, origin?)`; §7 W1 cli).
 *
 * `configure(device, lines, {origin})` keeps the origin on its headless session and passes it as the fourth argument
 * of `applyConfigLine` for every line that session applies — the atomic revert included — so the runtime can stamp it
 * on `configChange`. Without an origin, and in every console session, the call keeps its three P2 arguments.
 */
import { describe, expect, it } from 'vitest';
import type { ConfigOrigin } from '../src/contracts/process.js';
import type { DeviceId } from '../src/contracts/ids.js';
import type { CommandHandler } from '../src/contracts/cli.js';
import { createCliRuntime } from '../src/cli/runtime.js';
import { HANDLER_REGISTRY } from '../src/cli/handlers/index.js';
import { FakeDevice, harness } from './cli.runtime.fake.js';
import { UNSET_CLOCK_VIEW } from './port.fixtures.js';
import { createStagedSimulation } from './staged.world.js';
import { SEC } from '../src/contracts/time.js';
import type { TraceEvent } from '../src/contracts/trace.js';

type ConfigChange = Extract<TraceEvent, { kind: 'configChange' }>;

/** A FakeDevice that records the arguments count and the origin of every applyConfigLine call. */
class OriginDevice extends FakeDevice {
  readonly calls: { line: string; negate: boolean; arity: number; origin: ConfigOrigin | undefined }[] = [];
  override applyConfigLine(context: string[][], line: string[], negate: boolean, ...rest: [ConfigOrigin?]): { ok: boolean; error?: string } {
    this.calls.push({ line: line.join(' '), negate, arity: 3 + rest.length, origin: rest[0] });
    return super.applyConfigLine(context, line, negate);
  }
}

const ORIGIN: ConfigOrigin = { via: 'restconf', user: 'admin', address: '192.168.1.10' };

function world() {
  const h = harness();
  const dev = new OriginDevice('d_r1' as DeviceId, 'router', 'R1');
  h.devices.set('d_r1', dev);
  const cli = createCliRuntime(h.deps);
  return { h, dev, cli };
}

describe('ConfigureOptions.origin reaches applyConfigLine', () => {
  it('passes the origin as the fourth argument of every line the headless session applies', () => {
    const { dev, cli } = world();
    const r = cli.configure('d_r1', ['hostname Core1', 'interface g0/0', 'description uplink', 'no shutdown'], { origin: ORIGIN });
    expect(r.ok).toBe(true);
    expect(dev.calls).toEqual([
      { line: 'hostname Core1', negate: false, arity: 4, origin: ORIGIN },
      { line: 'interface GigabitEthernet0/0', negate: false, arity: 4, origin: ORIGIN },
      { line: 'description uplink', negate: false, arity: 4, origin: ORIGIN },
      { line: 'shutdown', negate: true, arity: 4, origin: ORIGIN },
    ]);
    // the origin is the caller's object, passed through unchanged
    expect(dev.calls[0]?.origin).toBe(ORIGIN);
  });

  it('keeps the three-argument call without an origin, in a later run and in a console session', () => {
    const { dev, cli } = world();
    cli.configure('d_r1', ['hostname A'], { origin: ORIGIN });
    cli.configure('d_r1', ['hostname B']);
    const s = cli.open('d_r1', 'console');
    cli.exec(s, 'enable');
    cli.exec(s, 'configure terminal');
    cli.exec(s, 'hostname C');
    expect(dev.calls.map((c) => [c.line, c.arity, c.origin])).toEqual([
      ['hostname A', 4, ORIGIN],
      ['hostname B', 3, undefined],
      ['hostname C', 3, undefined],
    ]);
  });

  it('stamps the atomic revert with the same origin', () => {
    const { dev, cli } = world();
    const r = cli.configure('d_r1', ['hostname Edge', 'interface g0/1', 'description lan', 'no such command'], { origin: ORIGIN, atomic: true });
    expect(r.ok).toBe(false);
    expect(r.reverted).toBe(true);
    expect(dev.running.render()).not.toContain('hostname Edge');
    expect(dev.running.render()).not.toContain('description lan');
    // three lines applied, then their inverse changes: every call carries the origin
    expect(dev.calls.length).toBeGreaterThan(3);
    expect(dev.calls.every((c) => c.arity === 4 && c.origin === ORIGIN)).toBe(true);
    expect(dev.calls.slice(0, 3).map((c) => c.line)).toEqual(['hostname Edge', 'interface GigabitEthernet0/1', 'description lan']);
  });

  it('stamps every configChange of a `no interface N` removal with the origin; without one the P2 events are unchanged', () => {
    const sim = createStagedSimulation({ seed: 3, stage: 'P3' });
    const r1 = sim.addDevice({ type: 'router.nf2911', name: 'R1' });
    sim.runFor(60 * SEC);
    const changes = (from: number): [string, boolean, ConfigOrigin | undefined][] =>
      sim
        .trace(from)
        .events.filter((e): e is ConfigChange => e.kind === 'configChange')
        .map((e) => [e.line, e.negate, e.origin]);
    const loopback = ['interface Loopback1', ' ip address 10.9.9.9 255.255.255.255'];
    expect(sim.configure(r1, loopback, { indentation: true }).ok).toBe(true);
    let from = sim.trace(0).next;
    expect(sim.configure(r1, ['no interface Loopback1'], { origin: ORIGIN }).ok).toBe(true);
    expect(changes(from)).toEqual([
      ['ip address 10.9.9.9 255.255.255.255', true, ORIGIN],
      ['interface Loopback1', true, ORIGIN],
    ]);
    expect(sim.device(r1)!.ports.has('Loopback1')).toBe(false);
    // without an origin: the same events, without the key
    expect(sim.configure(r1, loopback, { indentation: true }).ok).toBe(true);
    from = sim.trace(0).next;
    expect(sim.configure(r1, ['no interface Loopback1']).ok).toBe(true);
    expect(changes(from)).toEqual([
      ['ip address 10.9.9.9 255.255.255.255', true, undefined],
      ['interface Loopback1', true, undefined],
    ]);
    for (const e of sim.trace(from).events) if (e.kind === 'configChange') expect(e).not.toHaveProperty('origin');
  });

  it('CommandCtx.clock() is the device clock at the command time (§9.2 item 19)', () => {
    const h = harness();
    const dev = new OriginDevice('d_r1' as DeviceId, 'router', 'R1');
    h.devices.set('d_r1', dev);
    let seen: unknown;
    const probe: CommandHandler = (ctx) => {
      seen = ctx.clock();
      return {};
    };
    const cli = createCliRuntime(h.deps, { ...HANDLER_REGISTRY, 'show.version': probe });
    h.clock.now = 7_000;
    const s = cli.open('d_r1', 'console');
    cli.exec(s, 'show version');
    expect(seen).toEqual(UNSET_CLOCK_VIEW);
    expect((dev as unknown as { clockViewCalls: { now: number }[] }).clockViewCalls).toEqual([{ now: 7_000 }]);
  });

  it('carries the origin into a run that starts in a context', () => {
    const { dev, cli } = world();
    const r = cli.configure('d_r1', ['description core', 'shutdown'], { origin: ORIGIN, startContext: [['interface', 'GigabitEthernet0/0']] });
    expect(r).toMatchObject({ ok: true, finalMode: 'config-if' });
    // entering an existing interface writes nothing; both lines carry the origin
    expect(dev.calls).toEqual([
      { line: 'description core', negate: false, arity: 4, origin: ORIGIN },
      { line: 'shutdown', negate: false, arity: 4, origin: ORIGIN },
    ]);
  });
});
