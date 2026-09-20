/**
 * Faults (spec §4.11): cable cut mid-ping, admin shutdown on a router, routing loop → TTL expiry.
 */
import { describe, expect, it } from 'vitest';
import { SEC } from '../src/contracts/time.js';
import { pcRouterPc, threeRouters, twoPcsAndSwitch } from '../src/sim/scenarios.js';
import { booted, console, createdId, ofKind, output, ping } from './sim.harness.js';

describe('sim/faults', () => {
  it('a cable cut in the middle of a ping makes the remaining echoes time out', () => {
    const sim = booted(twoPcsAndSwitch(), 11, 40 * SEC);
    const cursor = sim.trace(0).next;
    const session = sim.cli.open('pc1', 'console');
    sim.cli.exec(session, 'ping 10.0.0.2');
    // step until two replies have been printed, then cut PC2's cable
    let guard = 0;
    while (output(sim.trace(cursor).events, session).split('!').length - 1 < 2) {
      expect(sim.step()).toBeDefined();
      if (++guard > 100_000) throw new Error('ping never progressed');
    }
    sim.injectFault(sim.now, { id: 'cut-1', kind: 'cable-cut', target: { link: 'l_pc2_sw1' } });
    sim.runToIdle();
    const evs = sim.trace(cursor).events;
    const text = output(evs, session);
    expect(text).toContain('!!...');
    expect(text).toContain('Sent 5, received 2, lost 3');
    expect(ofKind(evs, 'linkState').some((e) => e.link === 'l_pc2_sw1' && !e.up && e.reason === 'cable-cut')).toBe(true);
    const ports = ofKind(evs, 'portState').filter((e) => !e.operUp && e.reason === 'cable-cut');
    expect(ports.map((e) => e.device).sort()).toEqual(['pc2', 'sw1']);
    expect(sim.link('l_pc2_sw1')!.up).toBe(false);
    expect(sim.link('l_pc2_sw1')!.downReason).toBe('cut');
  });

  it('shutting a router interface removes its routes and the ping fails', () => {
    const sim = booted(pcRouterPc(), 5);
    const { results } = console(sim, 'r1', ['enable', 'configure terminal', 'interface g0/1', 'shutdown', 'end', 'show ip route']);
    const routes = results[5]!.output;
    expect(routes).not.toContain('10.0.1.0/24');
    expect(routes).not.toContain('10.0.1.254/32');
    expect(routes).toContain('10.0.0.0/24');
    expect(sim.device('r1')!.port('GigabitEthernet0/1')!.adminUp).toBe(false);
    expect(sim.link('l_r1_pc2')!.up).toBe(false);

    const { text, evs } = ping(sim, 'pc1', '10.0.1.1');
    expect(text).toMatch(/[U.]{5}/);
    expect(text).toContain('received 0, lost 5');
    expect(ofKind(evs, 'drop').some((e) => e.device === 'r1' && e.reason === 'no-route')).toBe(true);
  });

  it('a static route loop expires the TTL and returns time-exceeded to the source', () => {
    const topo = threeRouters();
    const sim = booted(topo, 9);
    // sanity: the chain works before it is broken
    const ok = ping(sim, 'pc1', '10.3.0.10');
    expect(ok.text).toContain('Sent 5, received 5, lost 0');

    console(sim, 'r2', ['enable', 'configure terminal', 'no ip route 10.3.0.0 255.255.255.0 10.0.23.3', 'ip route 10.3.0.0 255.255.255.0 10.0.12.1', 'end']);
    const { text, evs } = ping(sim, 'pc1', '10.3.0.10');
    expect(text).toContain('TTTTT');
    expect(text).toContain('received 0, lost 5');
    const expired = ofKind(evs, 'drop').filter((e) => e.reason === 'ttl-expired');
    expect(expired.length).toBe(5);
    expect(expired.every((e) => e.device === 'r1' || e.device === 'r2')).toBe(true);
    const errId = ofKind(evs, 'pduCreated').find((e) => e.pdu.tag === 'ttl-exceeded')!.pdu.id;
    expect(ofKind(evs, 'pduConsumed').some((e) => e.device === 'pc1' && e.pdu.id === errId)).toBe(true);
    // the looping echo was decremented 127 times before it died
    const echo = sim.pdu(createdId(evs, 'pc1', 'ping#1'))!;
    expect(echo.provenance.filter((m) => m.reason === 'TtlDecrement')).toHaveLength(127);
  });

  it('power-loss and port-flap faults are scheduled, applied and restored', () => {
    const sim = booted(twoPcsAndSwitch(), 2, 40 * SEC);
    const t0 = sim.now;
    sim.injectFault(t0 + SEC, { id: 'pl', kind: 'power-loss', target: { device: 'pc2' }, params: { durationNs: 5 * SEC } });
    sim.runFor(2 * SEC);
    expect(sim.device('pc2')!.power).toBe(false);
    expect(sim.link('l_pc2_sw1')!.up).toBe(false);
    sim.runFor(10 * SEC);
    expect(sim.device('pc2')!.power).toBe(true);
    expect(sim.device('pc2')!.bootedAt).toBeDefined();
    expect(sim.link('l_pc2_sw1')!.up).toBe(true);

    const t1 = sim.now;
    sim.injectFault(t1, { id: 'flap', kind: 'port-flap', target: { device: 'sw1', port: 'Fa0/1' }, params: { count: 2, periodNs: SEC } });
    sim.runFor(SEC / 2);
    expect(sim.link('l_pc1_sw1')!.up).toBe(false);
    sim.runFor(SEC);
    expect(sim.link('l_pc1_sw1')!.up).toBe(true);
    const after = ping(sim, 'pc1', '10.0.0.2');
    expect(after.text).toContain('Sent 5, received 5, lost 0');
  });
});
