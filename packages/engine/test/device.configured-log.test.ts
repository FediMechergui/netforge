/**
 * device.configured-log — ruling R47 (ARCHITECTURE-P3 §9.2, W5 svc/device/cli item): the [S25] configuration log
 * (`SYS`, severity 5, mnemonic `CONFIGURED`) of a typed change fires ONCE, when the session leaves configuration mode —
 * `end`, `exit` from global configuration (Ctrl-Z is the terminal's `end`), the end of a headless `configure` run, or
 * the session closing while in it — and never at the first changed line. The CLI runtime reports each session entering
 * and leaving a configuration mode (cli/runtime.ts `syncConfigSession`); the device keeps the log pending meanwhile
 * (device/device.ts `configSession`).
 *
 * Unchanged by the ruling: a session that changed nothing logs nothing; a configure-seam line with an origin and a
 * line applied outside any session log at once, once per source and instant; P1 and P2 worlds never log it.
 */
import { describe, expect, it } from 'vitest';
import type { DefaultsProfile } from '../src/contracts/catalog.js';
import type { DeviceId, SessionId } from '../src/contracts/ids.js';
import type { Simulation } from '../src/contracts/simulation.js';
import { SEC } from '../src/contracts/time.js';
import type { TraceEvent } from '../src/contracts/trace.js';
import { LOG_MNEMONIC_CONFIGURED } from '../src/device/device.js';
import { createSimulation } from '../src/sim/simulation.js';

type Log = Extract<TraceEvent, { kind: 'log' }>;

function startup(sections: readonly (readonly string[])[]): string {
  const out: string[] = [];
  for (const s of sections) out.push(...s, '!');
  out.push('end', '');
  return out.join('\n');
}

/** R1 (NF-2911) Gi0/0 ↔ SW1 (NF-C2960) Gi0/1, booted and settled; `logs()` drains the log events since the last call. */
function world(profile: DefaultsProfile = 'P3'): { sim: Simulation; logs: () => Log[] } {
  const sim = createSimulation({ seed: 47, profile });
  sim.addDevice({ id: 'r1', type: 'router.nf2911', name: 'R1', startupConfig: startup([['hostname R1'], ['interface GigabitEthernet0/0', ' ip address 10.0.0.1 255.255.255.0', ' no shutdown']]) });
  sim.addDevice({ id: 'sw1', type: 'switch.nfc2960', name: 'SW1', startupConfig: startup([['hostname SW1']]) });
  sim.addLink({ a: { device: 'r1', port: 'GigabitEthernet0/0' }, b: { device: 'sw1', port: 'GigabitEthernet0/1' } });
  sim.runFor(70 * SEC);
  let cursor = sim.trace(0).next;
  const logs = (): Log[] => {
    const r = sim.trace(cursor);
    cursor = r.next;
    return r.events.filter((e): e is Log => e.kind === 'log');
  };
  return { sim, logs };
}

const of = (logs: readonly Log[], device: DeviceId): Log[] => logs.filter((l) => l.device === device);
const configured = (logs: readonly Log[], device: DeviceId = 'r1'): Log[] => of(logs, device).filter((l) => l.mnemonic === LOG_MNEMONIC_CONFIGURED);
const shape = (l: Log): string => (l.mnemonic === undefined ? `${l.facility}-${l.severity}: ${l.message}` : `${l.facility}-${l.severity}-${l.mnemonic}: ${l.message}`);

/** A privileged console session on `dev`. */
function privileged(sim: Simulation, dev: DeviceId): SessionId {
  const s = sim.cli.open(dev, 'console');
  expect(sim.cli.exec(s, 'enable').error).toBeUndefined();
  return s;
}

/** Type `line`; it must be accepted. */
function type(sim: Simulation, s: SessionId, line: string): void {
  expect(sim.cli.exec(s, line).error, line).toBeUndefined();
}

describe('ruling R47: the configuration log fires when the session leaves configuration mode', () => {
  it('end: nothing at the changed lines, one log at end, after every effect of the session', () => {
    const { sim, logs } = world();
    const s = privileged(sim, 'r1');
    logs();
    type(sim, s, 'configure terminal');
    type(sim, s, 'interface GigabitEthernet0/1');
    type(sim, s, 'description spare');
    expect(configured(logs())).toEqual([]);
    type(sim, s, 'interface GigabitEthernet0/0');
    type(sim, s, 'shutdown');
    // the shutdown's own logs are there at once; the configuration log still waits
    const during = of(logs(), 'r1');
    expect(during.map(shape)).toEqual([
      'LINK-3: Interface GigabitEthernet0/0 administratively down',
      'LINEPROTO-5-UPDOWN: Interface GigabitEthernet0/0: line protocol is down',
    ]);
    type(sim, s, 'end');
    const after = logs();
    expect(configured(after).map(shape)).toEqual(['SYS-5-CONFIGURED: Configuration changed from the console.']);
    expect(configured(after)[0]!.t).toBe(sim.now);
    // nothing more later
    sim.runFor(5 * SEC);
    expect(configured(logs())).toEqual([]);
  });

  it('exit from global configuration logs once; exit from an interface back to global configuration does not', () => {
    const { sim, logs } = world();
    const s = privileged(sim, 'r1');
    logs();
    type(sim, s, 'configure terminal');
    type(sim, s, 'interface GigabitEthernet0/1');
    type(sim, s, 'description spare');
    type(sim, s, 'exit');
    expect(sim.cli.exec(s, 'hostname EDGE').mode).toBe('config');
    expect(configured(logs())).toEqual([]);
    expect(sim.cli.exec(s, 'exit').mode).toBe('priv-exec');
    expect(configured(logs()).map(shape)).toEqual(['SYS-5-CONFIGURED: Configuration changed from the console.']);
  });

  it('a configuration session that changes nothing logs nothing; the next one that changes something logs again', () => {
    const { sim, logs } = world();
    const s = privileged(sim, 'r1');
    type(sim, s, 'configure terminal');
    type(sim, s, 'interface GigabitEthernet0/1');
    type(sim, s, 'description spare');
    type(sim, s, 'end');
    expect(configured(logs())).toHaveLength(1);
    sim.runFor(SEC);
    // the same line again changes nothing
    type(sim, s, 'configure terminal');
    type(sim, s, 'interface GigabitEthernet0/1');
    type(sim, s, 'description spare');
    type(sim, s, 'end');
    expect(configured(logs())).toEqual([]);
    sim.runFor(SEC);
    type(sim, s, 'configure terminal');
    type(sim, s, 'interface GigabitEthernet0/1');
    type(sim, s, 'description reserved');
    type(sim, s, 'end');
    expect(configured(logs())).toHaveLength(1);
  });

  it('closing a session that is still in configuration mode logs its pending change', () => {
    const { sim, logs } = world();
    const s = privileged(sim, 'r1');
    type(sim, s, 'configure terminal');
    type(sim, s, 'ip domain-name example.test');
    expect(configured(logs())).toEqual([]);
    sim.cli.close(s);
    expect(configured(logs()).map(shape)).toEqual(['SYS-5-CONFIGURED: Configuration changed from the console.']);
  });

  it('a headless configure run logs once at its end, after the effects of all its lines', () => {
    const { sim, logs } = world();
    const r = sim.configure('r1', ['interface GigabitEthernet0/1', 'description spare', 'interface GigabitEthernet0/0', 'shutdown']);
    expect(r.ok).toBe(true);
    expect(of(logs(), 'r1').map(shape)).toEqual([
      'LINK-3: Interface GigabitEthernet0/0 administratively down',
      'LINEPROTO-5-UPDOWN: Interface GigabitEthernet0/0: line protocol is down',
      'SYS-5-CONFIGURED: Configuration changed from the console.',
    ]);
    // a run with `end` inside it logs at the `end` (the run leaves configuration mode there), and only once
    sim.runFor(SEC);
    const r2 = sim.configure('r1', ['interface GigabitEthernet0/1', 'description reserved', 'end', 'show clock']);
    expect(r2.ok).toBe(true);
    expect(r2.finalMode).toBe('priv-exec');
    expect(configured(logs())).toHaveLength(1);
  });

  it('two sessions: the change waits while the other session is still configuring and is logged once', () => {
    const { sim, logs } = world();
    const a = privileged(sim, 'r1');
    const b = sim.cli.open('r1', 'console');
    type(sim, b, 'enable');
    type(sim, a, 'configure terminal');
    type(sim, b, 'configure terminal');
    type(sim, a, 'ip domain-name example.test');
    type(sim, a, 'end');
    expect(configured(logs())).toHaveLength(1);
    type(sim, b, 'end');
    expect(configured(logs())).toEqual([]);
  });

  it('a change lost with a power cycle is never logged', () => {
    const { sim, logs } = world();
    const s = privileged(sim, 'r1');
    type(sim, s, 'configure terminal');
    type(sim, s, 'ip domain-name example.test');
    sim.setPower('r1', false);
    sim.runFor(SEC);
    sim.setPower('r1', true);
    sim.runFor(60 * SEC);
    logs();
    expect(sim.cli.exec(s, 'end').mode).toBe('priv-exec');
    expect(configured(logs())).toEqual([]);
  });
});

describe('ruling R47: what does not change', () => {
  it('a line applied outside any session, and a configure-seam line with an origin, log at once (once per source and instant)', () => {
    const { sim, logs } = world();
    const r1 = sim.device('r1')!;
    expect(r1.applyConfigLine([['interface', 'GigabitEthernet0/1']], ['description', 'direct'], false)).toEqual({ ok: true });
    expect(configured(logs()).map(shape)).toEqual(['SYS-5-CONFIGURED: Configuration changed from the console.']);
    const origin = { via: 'restconf' as const, user: 'admin', address: '10.0.0.10' };
    const r = sim.configure('r1', ['interface GigabitEthernet0/1', 'description api'], { origin });
    expect(r.ok).toBe(true);
    expect(configured(logs()).map(shape)).toEqual(['SYS-5-CONFIGURED: Configuration changed over RESTCONF by admin from 10.0.0.10.']);
  });

  it('P1 and P2 worlds never log it, and their logs are the same whatever the session does', () => {
    for (const profile of ['P1', 'P2'] as const) {
      const { sim, logs } = world(profile);
      const s = privileged(sim, 'r1');
      logs();
      type(sim, s, 'configure terminal');
      type(sim, s, 'interface GigabitEthernet0/0');
      type(sim, s, 'shutdown');
      type(sim, s, 'end');
      sim.configure('r1', ['interface GigabitEthernet0/1', 'description spare']);
      const got = logs();
      expect(got.filter((l) => l.mnemonic !== undefined), profile).toEqual([]);
      expect(of(got, 'r1').map(shape), profile).toEqual(['LINK-3: Interface GigabitEthernet0/0 administratively down']);
    }
  });
});
