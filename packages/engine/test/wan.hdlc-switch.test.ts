/**
 * wan.hdlc-switch [S19] — the encapsulation switch in hdlc's `onConfig` (ARCHITECTURE-P3 D17, §3.9 step 2, §9.1 "hdlc
 * StateView and debug pins"; §7 W3 wan, a reviewed edit of l2l3's protocols/hdlc.ts):
 *  - a STRICT no-op when the effective encapsulation does not change: `encapsulation hdlc` or `no encapsulation` on an
 *    HDLC port, `encapsulation ppp` on a port that already is PPP, any line before `init`, a non-serial port — no
 *    action, no debug line, the same StateView; in a P2-stage world typing the line changes no trace event but its own
 *    `configChange` (the P0.5 hdlc pins of serial.hdlc.test.ts and accept.p05.serial-clock run unchanged);
 *  - leaving HDLC (`encapsulation ppp`): `ka:<port>` is cancelled with one debug line, this end's own keepalive latch is
 *    released, the port is forgotten (the StateView lists HDLC ports only), and later ticks, carrier events and
 *    keepalive lines on the PPP port do nothing;
 *  - back to HDLC: keepalives re-armed with the configured period when the carrier is up, else waiting for it.
 */
import { describe, expect, it } from 'vitest';
import type { PortPhy } from '../src/contracts/link.js';
import type { Action, Process } from '../src/contracts/process.js';
import type { Simulation } from '../src/contracts/simulation.js';
import { HDLC_KEEPALIVE_DEFAULT_NS, HDLC_KEEPALIVE_MISSES } from '../src/contracts/services.js';
import { SEC } from '../src/contracts/time.js';
import type { TraceEvent } from '../src/contracts/trace.js';
import { createHdlc, keepaliveTimerKey } from '../src/protocols/hdlc.js';
import { makeHarness, type Harness } from './arp.harness.js';
import { createStagedSimulation } from './staged.world.js';

const SE = 'Serial0/0/0';
const SE1 = 'Serial0/0/1';
const GI = 'GigabitEthernet0/0';
const CLOCKED: PortPhy = { carrier: true, lineProtocol: true, dce: true };

function router(phy: PortPhy | undefined = CLOCKED, encap: 'hdlc' | 'ppp' = 'hdlc'): Harness {
  return makeHarness({
    deviceId: 'd_r1',
    kind: 'router',
    ports: [
      { id: GI, mac: '02:4e:00:01:00:01', address: '192.168.1.1', prefixLen: 24 },
      { id: SE, mac: '02:4e:00:01:00:03', kind: 'serial', address: '10.0.0.1', prefixLen: 30, encap, ...(phy === undefined ? {} : { phy }) },
      { id: SE1, mac: '02:4e:00:01:00:04', kind: 'serial', address: '10.0.1.1', prefixLen: 30, ...(phy === undefined ? {} : { phy }) },
    ],
  });
}

const encapDelta = (port: string, op: 'set' | 'unset', value?: string) => ({ op, context: [['interface', port]], line: value === undefined ? ['encapsulation'] : ['encapsulation', value] });

/** Change the effective encapsulation of `port` as the runtime does (before the fan-out), then deliver the delta. */
function setEncap(h: Harness, hdlc: Process, port: string, value: 'hdlc' | 'ppp', op: 'set' | 'unset' = 'set'): Action[] {
  h.ports.get(port)!.encap = value;
  return hdlc.onConfig(h.ctx, encapDelta(port, op, op === 'set' ? value : undefined));
}

/** Run the daemon past `misses` keepalive ticks without receiving anything (latches this end down at 3). */
function starve(h: Harness, hdlc: Process, misses: number): Action[] {
  const all: Action[] = [];
  for (let i = 0; i < misses; i++) all.push(...hdlc.onTimer(h.ctx, keepaliveTimerKey(SE)));
  return all;
}

describe('wan.hdlc-switch [S19]: a strict no-op when the effective encapsulation does not change', () => {
  it('encapsulation hdlc, then no encapsulation, on an armed HDLC port: no action, no debug line, the same StateView', () => {
    const h = router();
    const hdlc = createHdlc();
    hdlc.init!(h.ctx);
    const view = structuredClone(hdlc.stateSnapshot());
    const debugCount = h.debug.length;
    const ring = hdlc.debugEvents().length;
    expect(hdlc.onConfig(h.ctx, encapDelta(SE, 'set', 'hdlc'))).toEqual([]);
    expect(hdlc.onConfig(h.ctx, encapDelta(SE, 'unset'))).toEqual([]);
    expect(setEncap(h, hdlc, SE1, 'hdlc')).toEqual([]);
    expect(hdlc.stateSnapshot()).toEqual(view);
    expect(h.debug).toHaveLength(debugCount);
    expect(hdlc.debugEvents()).toHaveLength(ring);
    // the port still ticks exactly as before
    expect(hdlc.onTimer(h.ctx, keepaliveTimerKey(SE)).filter((a) => a.type === 'timer')).toEqual([{ type: 'timer', key: keepaliveTimerKey(SE), delay: 10 * SEC, periodic: true }]);
  });

  it('a port that is PPP at init and stays PPP: nothing at all; it never had a line', () => {
    const h = router(CLOCKED, 'ppp');
    const hdlc = createHdlc();
    // only Se0/0/1 (HDLC) is armed at init
    expect(hdlc.init!(h.ctx)).toEqual([{ type: 'timer', key: keepaliveTimerKey(SE1), delay: HDLC_KEEPALIVE_DEFAULT_NS, periodic: true }]);
    const debugCount = h.debug.length;
    expect(hdlc.onConfig(h.ctx, encapDelta(SE, 'set', 'ppp'))).toEqual([]);
    expect(h.debug).toHaveLength(debugCount);
    expect((hdlc.stateSnapshot().state.lines as { port: string }[]).map((l) => l.port)).toEqual([SE1]);
  });

  it('before init the line is ignored (init reads the effective encapsulation); a non-serial port and other lines are not touched', () => {
    const h = router();
    const hdlc = createHdlc();
    expect(setEncap(h, hdlc, SE, 'ppp')).toEqual([]);
    expect(h.debug).toEqual([]);
    expect(hdlc.init!(h.ctx)).toEqual([{ type: 'timer', key: keepaliveTimerKey(SE1), delay: HDLC_KEEPALIVE_DEFAULT_NS, periodic: true }]);
    const debugCount = h.debug.length;
    expect(hdlc.onConfig(h.ctx, encapDelta(GI, 'set', 'hdlc'))).toEqual([]);
    expect(hdlc.onConfig(h.ctx, { op: 'set', context: [['interface', 'GigabitEthernet0/0.10']], line: ['encapsulation', 'dot1Q', '10'] })).toEqual([]);
    expect(hdlc.onConfig(h.ctx, { op: 'set', context: [], line: ['encapsulation', 'ppp'] })).toEqual([]);
    expect(h.debug).toHaveLength(debugCount);
  });
});

describe('wan.hdlc-switch [S19]: leaving HDLC', () => {
  it('encapsulation ppp: ka:<port> cancelled with one debug line, the port forgotten; later ticks, carrier and keepalive lines do nothing', () => {
    const h = router();
    const hdlc = createHdlc();
    hdlc.init!(h.ctx);
    const before = h.debug.length;
    expect(setEncap(h, hdlc, SE, 'ppp')).toEqual([{ type: 'cancelTimer', key: keepaliveTimerKey(SE) }]);
    expect(h.debug.slice(before).map((d) => [d.category, d.message])).toEqual([['serial', `keepalives on ${SE} stopped: the interface left HDLC (encapsulation ppp)`]]);
    expect(hdlc.stateSnapshot().state).toEqual({
      lines: [{ port: SE1, intervalNs: 10 * SEC, carrier: true, armed: true, misses: 0, lineProtocolDown: false, mySeq: 0, yourSeq: 0, sent: 0, received: 0 }],
      sent: 0,
      received: 0,
    });
    expect(hdlc.onTimer(h.ctx, keepaliveTimerKey(SE))).toEqual([]);
    expect(hdlc.onMediumEvent!(h.ctx, SE, { kind: 'carrier', up: true })).toEqual([]);
    expect(hdlc.onMediumEvent!(h.ctx, SE, { kind: 'serial-line', ready: true })).toEqual([]);
    expect(hdlc.onConfig(h.ctx, { op: 'set', context: [['interface', SE]], line: ['keepalive', '5'] })).toEqual([]);
    expect((hdlc.stateSnapshot().state.lines as { port: string }[]).map((l) => l.port)).toEqual([SE1]);
  });

  it('an end latched down by missed keepalives releases its own latch when it leaves HDLC', () => {
    const h = router();
    const hdlc = createHdlc();
    hdlc.init!(h.ctx);
    const starved = starve(h, hdlc, HDLC_KEEPALIVE_MISSES);
    expect(starved.filter((a) => a.type === 'medium')).toEqual([{ type: 'medium', port: SE, op: { op: 'line-protocol', up: false, reason: 'keepalive-missed' } }]);
    expect(setEncap(h, hdlc, SE, 'ppp')).toEqual([
      { type: 'cancelTimer', key: keepaliveTimerKey(SE) },
      { type: 'medium', port: SE, op: { op: 'line-protocol', up: true } },
    ]);
  });
});

describe('wan.hdlc-switch [S19]: back to HDLC', () => {
  it('encapsulation hdlc (or no encapsulation) after PPP: a fresh line, armed with the configured period when the carrier is up', () => {
    const h = router();
    const hdlc = createHdlc();
    hdlc.init!(h.ctx);
    setEncap(h, hdlc, SE, 'ppp');
    h.ctx.config.set([['interface', SE]], ['keepalive', '4']);
    const before = h.debug.length;
    expect(setEncap(h, hdlc, SE, 'hdlc', 'unset')).toEqual([{ type: 'timer', key: keepaliveTimerKey(SE), delay: 4 * SEC, periodic: true }]);
    expect(h.debug.slice(before).map((d) => d.message)).toEqual([`keepalives on ${SE} every 4 s`]);
    expect((hdlc.stateSnapshot().state.lines as { port: string; armed: boolean; intervalNs: number }[]).map((l) => [l.port, l.armed, l.intervalNs])).toEqual([
      [SE1, true, 10 * SEC],
      [SE, true, 4 * SEC],
    ]);
  });

  it('without carrier the line waits for it (the next carrier event arms it)', () => {
    const h = router({ carrier: false, lineProtocol: false });
    const hdlc = createHdlc();
    expect(hdlc.init!(h.ctx)).toEqual([]);
    setEncap(h, hdlc, SE, 'ppp');
    expect(setEncap(h, hdlc, SE, 'hdlc')).toEqual([]);
    expect(h.debug.at(-1)!.message).toBe(`${SE} uses HDLC again; keepalives wait for carrier`);
    expect(hdlc.onMediumEvent!(h.ctx, SE, { kind: 'carrier', up: true })).toEqual([{ type: 'timer', key: keepaliveTimerKey(SE), delay: 10 * SEC, periodic: true }]);
  });
});

describe('wan.hdlc-switch [S19]: worlds', () => {
  /** Two P2-stage routers on a clocked serial cable, run to idle (HDLC, keepalives every 10 s). */
  function hdlcWorld(): Simulation {
    const sim = createStagedSimulation({ seed: 5, stage: 'P2' });
    const cfg = (name: string, addr: string, dce: boolean): string =>
      [`hostname ${name}`, '!', `interface ${SE}`, ` ip address ${addr} 255.255.255.252`, ...(dce ? [' clock rate 64000'] : []), ' no shutdown', '!', 'end', ''].join('\n');
    sim.addDevice({ id: 'r1', type: 'router.nf2911', name: 'R1', startupConfig: cfg('R1', '10.0.0.1', true) });
    sim.addDevice({ id: 'r2', type: 'router.nf2911', name: 'R2', startupConfig: cfg('R2', '10.0.0.2', false) });
    sim.addLink({ a: { device: 'r1', port: SE }, b: { device: 'r2', port: SE }, media: 'serial-dce' });
    sim.runToIdle();
    return sim;
  }
  const json = (evs: readonly TraceEvent[]): string => JSON.stringify(evs.filter((e) => e.kind !== 'configChange'), (_k, v: unknown) => (v instanceof Uint8Array ? Array.from(v) : v));

  it('typing encapsulation hdlc and no encapsulation changes no trace event but their configChange, and the same StateViews', () => {
    const plain = hdlcWorld();
    const typed = hdlcWorld();
    const d = typed.device('r1')!;
    d.applyActions('sim', [], typed.now);
    expect(d.applyConfigLine([['interface', SE]], ['encapsulation', 'hdlc'], false)).toEqual({ ok: true });
    typed.runFor(15 * SEC);
    d.applyActions('sim', [], typed.now);
    expect(d.applyConfigLine([['interface', SE]], ['encapsulation'], true)).toEqual({ ok: true });
    typed.runFor(25 * SEC);
    plain.runFor(40 * SEC);
    const typedEvs = typed.trace(0).events;
    expect(typedEvs.filter((e) => e.kind === 'configChange').length).toBeGreaterThan(0);
    expect(json(typedEvs)).toBe(json(plain.trace(0).events));
    for (const id of ['r1', 'r2']) expect(typed.device(id)!.stateSnapshots()).toEqual(plain.device(id)!.stateSnapshots());
    expect(typed.device('r1')!.port(SE)!.operUp).toBe(true);
  });
});
