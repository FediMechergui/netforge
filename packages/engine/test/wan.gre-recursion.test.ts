/**
 * wan.gre-recursion [S36a] — the recursive-routing hold of the tunnel owner (ARCHITECTURE-P3C §3.9, §4.2, §4.3; §7 W2a
 * wan; P3a §3.10 step 6). Going down `recursive-routing` arms the periodic `recursion-hold:<port>` timer (10 s); while it
 * is armed RIB changes skip the tunnel; at expiry the tunnel is evaluated once (up, or down again with the hold
 * re-armed); a configuration change that resolves the recursion stops the hold. One log per down transition. The
 * flap is periodic and bounded under `runFor`, and `runToIdle` returns.
 *
 * The world is test/tunnel.world.ts's §3.10 world in GRE mode (static routes through the tunnel, or OSPF over it).
 */
import { describe, expect, it } from 'vitest';
import { SEC } from '../src/contracts/time.js';
import type { TraceEvent } from '../src/contracts/trace.js';
import { GRE_LOG_FACILITY, GRE_RECURSION_HOLD_NS } from '../src/protocols/gre.js';
import { ping } from './sim.harness.js';
import { MASK30, PC2_ADDR, R1_GRE_TUNNEL, R2_WAN, SE0, TU0, line, tunnelRow, tunnelUp, tunnelWorld } from './tunnel.world.js';

const TU1 = 'Tunnel1';
const recursiveLog = (port: string, dest: string): string => `${port} is down: its destination ${dest} is routed through a tunnel (recursive routing)`;
const portStates = (evs: readonly TraceEvent[], port: string, t0: number): [number, boolean][] =>
  evs.filter((e) => e.kind === 'portState' && e.device === 'r1' && e.port === port).map((e) => [e.t - t0, (e as { operUp: boolean }).operUp]);
const tunnelLogs = (evs: readonly TraceEvent[], t0: number): [number, string][] =>
  evs.filter((e) => e.kind === 'log' && e.device === 'r1' && e.facility === GRE_LOG_FACILITY).map((e) => [e.t - t0, (e as { message: string }).message]);

describe('wan.gre-recursion [S36a]: the hold', () => {
  it('is 10 s, fixed', () => {
    expect(GRE_RECURSION_HOLD_NS).toBe(10 * SEC);
  });

  it('an up tunnel arms no hold: its row has no holdUntil (silence, §4.3)', () => {
    const sim = tunnelWorld({ mode: 'gre' });
    expect(tunnelRow(sim, 'r1')).toMatchObject({ state: 'up' });
    expect(tunnelRow(sim, 'r1')!.holdUntil).toBeUndefined();
    expect(tunnelRow(sim, 'r2')!.holdUntil).toBeUndefined();
  });

  it('a static through the tunnel: down at T, then up and down again every 10 s; one log per down; a static fix stops the hold', () => {
    const sim = tunnelWorld({ mode: 'gre' });
    const t0 = sim.now;
    const evs = line(sim, 'r1', [], ['ip', 'route', R2_WAN, '255.255.255.255', TU0]);
    expect(portStates(evs, TU0, t0)).toEqual([[0, false]]);
    expect(tunnelLogs(evs, t0)).toEqual([[0, recursiveLog(TU0, R2_WAN)]]);
    expect(tunnelRow(sim, 'r1')).toMatchObject({ state: 'down', reason: 'recursive-routing', holdUntil: t0 + 10 * SEC, since: t0 });
    // the flap, bounded and periodic under runFor
    const cursor = sim.trace(0).next;
    sim.runFor(45 * SEC);
    const flap = sim.trace(cursor).events;
    const expected: [number, boolean][] = [];
    for (const k of [1, 2, 3, 4]) expected.push([k * 10 * SEC, true], [k * 10 * SEC, false]);
    expect(portStates(flap, TU0, t0)).toEqual(expected);
    expect(tunnelLogs(flap, t0)).toEqual([1, 2, 3, 4].map((k) => [k * 10 * SEC, recursiveLog(TU0, R2_WAN)]));
    expect(tunnelRow(sim, 'r1')).toMatchObject({ state: 'down', reason: 'recursive-routing', holdUntil: t0 + 50 * SEC, since: t0 + 40 * SEC });
    // runToIdle returns in the flapping world (the hold is periodic, D10)
    expect(sim.runToIdle().stopped).toBeUndefined();
    // the fix: the static removed, the tunnel up at once, the hold stopped, nothing moves any more
    const t1 = sim.now;
    const fix = line(sim, 'r1', [], ['ip', 'route', R2_WAN, '255.255.255.255', TU0], true);
    expect(portStates(fix, TU0, t1)).toEqual([[0, true]]);
    expect(tunnelRow(sim, 'r1')).toMatchObject({ state: 'up', since: t1 });
    expect(tunnelRow(sim, 'r1')!.holdUntil).toBeUndefined();
    const c2 = sim.trace(0).next;
    sim.runFor(30 * SEC);
    const after = sim.trace(c2).events;
    expect(portStates(after, TU0, t1)).toEqual([]);
    expect(after.filter((e) => e.kind === 'tableWrite' && e.device === 'r1' && e.table === 'tunnels')).toEqual([]);
    expect(ping(sim, 'pc1', PC2_ADDR).text).toContain('!!!!!');
  });

  it('a destination routed through another up tunnel: the hold re-arms at each expiry, with no transition and no new log', () => {
    // Tunnel1 is up through the provider; Tunnel0's destination is a host route through Tunnel1
    const tu1 = [` ip address 172.16.1.1 ${MASK30}`, ` tunnel source ${SE0}`, ` tunnel destination ${R2_WAN}`];
    const sim = tunnelWorld({ mode: 'gre' });
    line(sim, 'r1', [['interface', TU1]], tu1[0]!.trim().split(' '));
    line(sim, 'r1', [['interface', TU1]], tu1[1]!.trim().split(' '));
    line(sim, 'r1', [['interface', TU1]], tu1[2]!.trim().split(' '));
    expect(sim.device('r1')!.port(TU1)!.operUp).toBe(true);
    line(sim, 'r1', [], ['ip', 'route', '10.9.9.9', '255.255.255.255', TU1]);
    const t0 = sim.now;
    const evs = line(sim, 'r1', [['interface', TU0]], ['tunnel', 'destination', '10.9.9.9']);
    expect(portStates(evs, TU0, t0)).toEqual([[0, false]]);
    expect(tunnelLogs(evs, t0)).toEqual([[0, recursiveLog(TU0, '10.9.9.9')]]);
    const cursor = sim.trace(0).next;
    sim.runFor(35 * SEC);
    const held = sim.trace(cursor).events;
    expect(portStates(held, TU0, t0)).toEqual([]);
    expect(tunnelLogs(held, t0)).toEqual([]);
    // the row is rewritten once per expiry (holdUntil moves on), its state and since unchanged
    const writes = held.filter((e) => e.kind === 'tableWrite' && e.device === 'r1' && e.table === 'tunnels');
    expect(writes.map((e) => e.t - t0)).toEqual([10 * SEC, 20 * SEC, 30 * SEC]);
    expect(tunnelRow(sim, 'r1')).toMatchObject({ state: 'down', reason: 'recursive-routing', since: t0, holdUntil: t0 + 40 * SEC });
    // Tunnel1 is untouched
    expect(sim.device('r1')!.tables.get('tunnels')!.get(TU1)).toMatchObject({ state: 'up' });
    expect(sim.device('r1')!.tables.get('tunnels')!.get(TU1)).not.toHaveProperty('holdUntil');
    // a configuration change that resolves it (the destination back to R2) stops the hold
    line(sim, 'r1', [['interface', TU0]], ['tunnel', 'destination', R2_WAN]);
    expect(tunnelRow(sim, 'r1')).toMatchObject({ state: 'up', destination: R2_WAN });
    expect(tunnelRow(sim, 'r1')!.holdUntil).toBeUndefined();
    const c2 = sim.trace(0).next;
    sim.runFor(20 * SEC);
    expect(sim.trace(c2).events.filter((e) => e.kind === 'tableWrite' && e.device === 'r1' && e.table === 'tunnels')).toEqual([]);
  });

  it('removing the tunnel while the hold is armed drops the row and the hold', () => {
    const sim = tunnelWorld({ mode: 'gre' });
    line(sim, 'r1', [], ['ip', 'route', R2_WAN, '255.255.255.255', TU0]);
    expect(tunnelRow(sim, 'r1')).toMatchObject({ reason: 'recursive-routing' });
    line(sim, 'r1', [], ['interface', TU0], true);
    expect(tunnelRow(sim, 'r1')).toBeUndefined();
    const cursor = sim.trace(0).next;
    sim.runFor(25 * SEC);
    const evs = sim.trace(cursor).events;
    expect(evs.filter((e) => e.kind === 'tableWrite' && e.device === 'r1' && e.table === 'tunnels')).toEqual([]);
    expect(evs.filter((e) => e.kind === 'debug' && e.event.device === 'r1' && e.event.process === 'gre')).toEqual([]);
  });

  it('OSPF over the tunnel learning the destination through it: each down is followed by an up 10 s later; runToIdle returns', () => {
    const sim = tunnelWorld({ mode: 'gre', ospf: true, r1Tunnel: R1_GRE_TUNNEL });
    expect(tunnelUp(sim, 'r1')).toBe(true);
    // R2 advertises its provider link into OSPF: R1 learns 209.165.200.228/30 through Tunnel0, the classic recursion
    const t0 = sim.now;
    line(sim, 'r2', [['router', 'ospf', '1']], ['network', '209.165.200.228', '0.0.0.3', 'area', '0']);
    sim.runFor(120 * SEC);
    const states = portStates(sim.trace(0).events.filter((e) => e.t >= t0), TU0, t0);
    const downs = states.filter(([, up]) => !up).map(([at]) => at);
    const ups = states.filter(([, up]) => up).map(([at]) => at);
    expect(downs.length).toBeGreaterThanOrEqual(2);
    // every up comes exactly one hold after the down before it
    expect(ups.length).toBeGreaterThanOrEqual(1);
    for (const u of ups) expect(u - Math.max(...downs.filter((d) => d < u))).toBe(GRE_RECURSION_HOLD_NS);
    // one log per down
    expect(tunnelLogs(sim.trace(0).events.filter((e) => e.t >= t0), t0).map(([at]) => at)).toEqual(downs);
    expect(sim.runToIdle().stopped).toBeUndefined();
  });
});
