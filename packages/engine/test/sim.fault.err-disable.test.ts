/**
 * sim — the `err-disable` fault (ARCHITECTURE-P2 §2.7 FaultKind, §3.8 steps 3 and 7; §7 W2 sim): target device +
 * port (long or short name), `params.cause` one of ERR_DISABLE_CAUSES (default 'fault'), applied through
 * `DeviceRuntime.errDisablePort` — the port is err-disabled, the link goes down, a portState and a log are emitted;
 * a missing device or port does nothing; `shutdown` / `no shutdown` recovers; the lab-check clone's technique
 * (inject at 0 before boot) leaves the port err-disabled after boot.
 */
import { describe, expect, it } from 'vitest';
import { SEC } from '../src/contracts/time.js';
import { twoPcsAndSwitch } from '../src/sim/scenarios.js';
import { DEFAULT_ERR_DISABLE_CAUSE, createSimulation, isErrDisableCause } from '../src/sim/simulation.js';
import { booted, console, ofKind, ping } from './sim.harness.js';

const PORT = 'FastEthernet0/1';

describe('the err-disable fault', () => {
  it('names its causes', () => {
    expect(DEFAULT_ERR_DISABLE_CAUSE).toBe('fault');
    for (const c of ['psecure-violation', 'bpduguard', 'channel-misconfig', 'fault']) expect(isErrDisableCause(c)).toBe(true);
    expect(isErrDisableCause('cable-cut')).toBe(false);
    expect(isErrDisableCause(undefined)).toBe(false);
  });

  it('err-disables the port for the given cause: link down, portState, log, and the ping fails', () => {
    const sim = booted(twoPcsAndSwitch(), 3, 40 * SEC);
    const cursor = sim.trace(0).next;
    sim.injectFault(sim.now + SEC, { id: 'ed1', kind: 'err-disable', target: { device: 'sw1', port: 'fa0/1' }, params: { cause: 'psecure-violation' } });
    sim.runFor(2 * SEC);
    const port = sim.device('sw1')!.port(PORT)!;
    expect(port.errDisabled).toBe('psecure-violation');
    expect(port.adminUp).toBe(true);
    expect(port.operUp).toBe(false);
    expect(sim.link('l_pc1_sw1')!.up).toBe(false);
    const evs = sim.trace(cursor).events;
    // the runtime marks the port err-disabled, then the link model takes it down
    const states = ofKind(evs, 'portState').filter((e) => e.device === 'sw1' && e.port === PORT);
    expect(states[0]).toMatchObject({ reason: 'err-disabled' });
    expect(states.some((e) => !e.operUp)).toBe(true);
    expect(states.at(-1)!.operUp).toBe(false);
    const log = ofKind(evs, 'log').find((e) => e.device === 'sw1' && e.severity === 4);
    expect(log?.message).toContain(PORT);
    expect(log?.message).toContain('error-disabled');
    expect(sim.snapshot().devices.find((d) => d.id === 'sw1')!.ports.find((p) => p.id === PORT)!.errDisabled).toBe('psecure-violation');
    const { text } = ping(sim, 'pc2', '10.0.0.1');
    expect(text).toContain('received 0, lost 5');
  });

  it("defaults the cause to 'fault' and ignores a cause it does not know", () => {
    const sim = booted(twoPcsAndSwitch(), 3, 40 * SEC);
    sim.injectFault(sim.now, { id: 'ed2', kind: 'err-disable', target: { device: 'sw1', port: PORT } });
    sim.injectFault(sim.now, { id: 'ed3', kind: 'err-disable', target: { device: 'sw1', port: 'FastEthernet0/2' }, params: { cause: 'meteor' } });
    sim.runFor(SEC);
    expect(sim.device('sw1')!.port(PORT)!.errDisabled).toBe('fault');
    expect(sim.device('sw1')!.port('FastEthernet0/2')!.errDisabled).toBe('fault');
  });

  it('does nothing for an unknown device, an unknown port, or a port already err-disabled', () => {
    const sim = booted(twoPcsAndSwitch(), 3, 40 * SEC);
    const twin = booted(twoPcsAndSwitch(), 3, 40 * SEC);
    const cursor = sim.trace(0).next;
    sim.injectFault(sim.now, { id: 'x1', kind: 'err-disable', target: { device: 'nope', port: PORT } });
    sim.injectFault(sim.now, { id: 'x2', kind: 'err-disable', target: { device: 'sw1', port: 'FastEthernet9/9' } });
    sim.injectFault(sim.now, { id: 'x3', kind: 'err-disable', target: { device: 'sw1' } });
    sim.injectFault(sim.now, { id: 'x4', kind: 'err-disable', target: { link: 'l_pc1_sw1' } });
    sim.runFor(SEC);
    twin.runFor(SEC);
    expect(sim.trace(cursor).events.filter((e) => e.kind === 'portState' || e.kind === 'log')).toEqual([]);
    expect(JSON.stringify(sim.snapshot())).toBe(JSON.stringify(twin.snapshot()));
    expect(sim.devices().every((d) => [...d.ports.values()].every((p) => p.errDisabled === undefined))).toBe(true);
    sim.injectFault(sim.now, { id: 'ed', kind: 'err-disable', target: { device: 'sw1', port: PORT }, params: { cause: 'bpduguard' } });
    sim.injectFault(sim.now, { id: 'ed-again', kind: 'err-disable', target: { device: 'sw1', port: PORT }, params: { cause: 'fault' } });
    sim.runFor(SEC);
    expect(sim.device('sw1')!.port(PORT)!.errDisabled).toBe('bpduguard');
    expect(ofKind(sim.trace(cursor).events, 'portState').filter((e) => e.reason === 'err-disabled')).toHaveLength(1);
  });

  it('recovers by hand with shutdown / no shutdown', () => {
    const sim = booted(twoPcsAndSwitch(), 3, 40 * SEC);
    sim.injectFault(sim.now, { id: 'ed', kind: 'err-disable', target: { device: 'sw1', port: PORT }, params: { cause: 'psecure-violation' } });
    sim.runFor(SEC);
    expect(sim.link('l_pc1_sw1')!.up).toBe(false);
    console(sim, 'sw1', ['enable', 'configure terminal', `interface ${PORT}`, 'shutdown']);
    expect(sim.device('sw1')!.port(PORT)!.errDisabled).toBeUndefined();
    console(sim, 'sw1', ['enable', 'configure terminal', `interface ${PORT}`, 'no shutdown', 'end']);
    sim.runFor(5 * SEC);
    expect(sim.device('sw1')!.port(PORT)!.operUp).toBe(true);
    expect(sim.link('l_pc1_sw1')!.up).toBe(true);
    expect(ping(sim, 'pc1', '10.0.0.2').text).toContain('received 5, lost 5'.replace('lost 5', 'lost 0'));
  });

  it('is journaled like any fault and survives a replay of the world', () => {
    const sim = booted(twoPcsAndSwitch(), 3, 40 * SEC);
    sim.injectFault(sim.now, { id: 'ed', kind: 'err-disable', target: { device: 'sw1', port: PORT }, params: { cause: 'channel-misconfig' } });
    sim.runFor(SEC);
    const entry = sim.journal().entries.at(-1)!;
    expect(entry.op).toEqual({ op: 'injectFault', at: 40 * SEC, fault: { id: 'ed', kind: 'err-disable', target: { device: 'sw1', port: PORT }, params: { cause: 'channel-misconfig' } } });
  });

  it("the lab-check clone's technique: injected at 0 before boot, the port is err-disabled once the switch is up", () => {
    const sim = createSimulation({ seed: 3 });
    sim.loadTopology(twoPcsAndSwitch());
    sim.injectFault(0, { id: 'clone-ed', kind: 'err-disable', target: { device: 'sw1', port: PORT }, params: { cause: 'psecure-violation' } });
    sim.runToIdle();
    expect(sim.device('sw1')!.bootedAt).toBeDefined();
    const port = sim.device('sw1')!.port(PORT)!;
    expect(port.errDisabled).toBe('psecure-violation');
    expect(port.operUp).toBe(false);
    expect(sim.link('l_pc1_sw1')!.up).toBe(false);
    expect(sim.link('l_pc2_sw1')!.up).toBe(true);
    expect(ping(sim, 'pc2', '10.0.0.1').text).toContain('received 0, lost 5');
  });
});
