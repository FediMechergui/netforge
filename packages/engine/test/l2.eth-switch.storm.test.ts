/**
 * W2a l2 [S16] (ARCHITECTURE-P3C §3.7, §4.2, §4.3, §2.6 `StormControlRow`, RC5 (g); §7 W2a l2): eth-switch's
 * storm-control ingress check on real worlds (`staged.world` at stage P3c, every P3 daemon removed, the injector as
 * a flooding host on Fa0/5, PC1 on Fa0/1). SW1 is configured through `startupConfig` and `applyConfigLine` (rule 13).
 *  - rows: written when the line is stored and when the port comes up (state `forwarding`, `current` 0, `dropped` 0,
 *    `windowStart` = now), then only on a state change or a closed window that had drops — never per frame;
 *  - `pps`: the frame that would go above the rising level and the rest of its second drop `storm-control` with the
 *    exact detail and rule; the next second drops whole while the previous one offered more than the falling level;
 *    a quiet second returns to forwarding (hysteresis);
 *  - window edges exact to the ns (a frame at k s − 1 ns belongs to the earlier second);
 *  - `bps` and percent levels count wire bits (frame size with FCS × 8; percent of the operational speed);
 *  - only the configured class is counted (a broadcast line leaves unicast alone);
 *  - `action shutdown` err-disables (cause `storm-control`) and `errdisable recovery cause storm-control` recovers it,
 *    the rows starting afresh at port-up; `action trap` logs once per exceedance; both together do both (RC5 (g));
 *  - removing the line removes the row and the limit;
 *  - with no line nothing is counted, written or logged.
 */
import { describe, expect, it } from 'vitest';
import type { LayerSpec } from '../src/contracts/pdu.js';
import type { ProcessFactory } from '../src/contracts/process.js';
import type { Simulation } from '../src/contracts/simulation.js';
import type { StormControlRow } from '../src/contracts/tables.js';
import { MS, SEC } from '../src/contracts/time.js';
import type { SimTime } from '../src/contracts/time.js';
import type { TraceEvent } from '../src/contracts/trace.js';
import { STORM_CONTROL_DEBUG_CATEGORY } from '../src/protocols/l2/storm-control.js';
import { INJECTED_TAG, INJECTOR_HOST_TYPE, arpFrame, injectFrames, withInjector } from './inject.js';
import { ofKind } from './sim.harness.js';
import { P3_DAEMONS, createStagedSimulation, type StagedFactoryOverlay } from './staged.world.js';

const FA1 = 'FastEthernet0/1';
const FA5 = 'FastEthernet0/5';
const PC_PORT = 'GigabitEthernet0';
const INJ_PORT = 'GigabitEthernet0';
const A = '02:4e:66:00:00:05';
const BOOT = 120 * SEC;

function noP3(): StagedFactoryOverlay {
  const out: Record<string, ProcessFactory | undefined> = {};
  for (const p of P3_DAEMONS) out[p] = undefined;
  return out;
}

function configText(sections: readonly (readonly string[])[]): string {
  return [...sections.flatMap((s) => [...s, '!']), 'end', ''].join('\n');
}

/** SW1 with `fa5` on Fa0/5 and `global` lines. */
function sw1Config(fa5: readonly string[], global: readonly string[] = []): string {
  return configText([
    ['hostname SW1'],
    [`interface ${FA1}`, ' spanning-tree portfast'],
    [`interface ${FA5}`, ' spanning-tree portfast', ...fa5.map((l) => ` ${l}`)],
    ...(global.length === 0 ? [] : [global]),
  ]);
}

function world(sw: string, seed = 5): Simulation {
  const sim = createStagedSimulation({ seed, stage: 'P3c', factories: withInjector(noP3()) });
  sim.addDevice({ id: 'sw1', type: 'switch.nfc2960', name: 'SW1', startupConfig: sw });
  sim.addDevice({ id: 'pc1', type: 'pc.nfpc', name: 'PC1' });
  sim.addDevice({ id: 'attacker', type: INJECTOR_HOST_TYPE, name: 'FLOODER' });
  sim.addLink({ id: 'l_pc1', a: { device: 'pc1', port: PC_PORT }, b: { device: 'sw1', port: FA1 } });
  sim.addLink({ id: 'l_att', a: { device: 'attacker', port: INJ_PORT }, b: { device: 'sw1', port: FA5 } });
  sim.runFor(BOOT);
  return sim;
}

/** A broadcast frame of 64 bytes on the wire (a gratuitous ARP, padded, with FCS). */
const BCAST: readonly LayerSpec[] = arpFrame({ sha: A, spa: '192.168.10.99' });
/** A unicast frame of 64 bytes for a station SW1 does not know (flooded as unknown unicast). */
const UNICAST: readonly LayerSpec[] = arpFrame({ sha: A, spa: '192.168.10.99', dstMac: '02:00:00:00:00:99' });

const stormDrops = (evs: readonly TraceEvent[]): Extract<TraceEvent, { kind: 'drop' }>[] => ofKind(evs, 'drop').filter((e) => e.reason === 'storm-control');
const stormWrites = (evs: readonly TraceEvent[]): Extract<TraceEvent, { kind: 'tableWrite' }>[] => ofKind(evs, 'tableWrite').filter((e) => e.table === 'storm-control');
const stormDebug = (evs: readonly TraceEvent[]): string[] =>
  ofKind(evs, 'debug').filter((e) => e.event.category === STORM_CONTROL_DEBUG_CATEGORY).map((e) => e.event.message);
const stormLogs = (evs: readonly TraceEvent[]): Extract<TraceEvent, { kind: 'log' }>[] => ofKind(evs, 'log').filter((e) => e.facility === 'STORM_CONTROL');
const swRx = (evs: readonly TraceEvent[]): Extract<TraceEvent, { kind: 'frameRx' }>[] =>
  ofKind(evs, 'frameRx').filter((e) => e.device === 'sw1' && e.port === FA5 && e.pdu.tag === INJECTED_TAG);
const pcRx = (evs: readonly TraceEvent[]): number => ofKind(evs, 'frameRx').filter((e) => e.device === 'pc1' && e.pdu.tag === INJECTED_TAG).length;
const row = (sim: Simulation, kind = 'broadcast'): StormControlRow | undefined =>
  sim.device('sw1')!.tables.get<StormControlRow>('storm-control')!.get(`${FA5}|${kind}`);

/** The delay from the injector's send to the frame's arrival on SW1 Fa0/5 (one idle frame). */
function arrivalDelay(sim: Simulation): SimTime {
  const t0 = sim.trace(0).next;
  const sentAt = sim.now;
  injectFrames(sim, { from: 'attacker', port: INJ_PORT, frames: [BCAST], spacingNs: 0 });
  sim.runToIdle();
  const rx = swRx(sim.trace(t0).events);
  expect(rx).toHaveLength(1);
  return rx[0]!.t - sentAt;
}

/** Inject `count` frames `spacingNs` apart whose first one ARRIVES at SW1 at `at`; runs to idle; returns the events. */
function arriveAt(sim: Simulation, at: SimTime, d: SimTime, frames: readonly (readonly LayerSpec[])[], count: number, spacingNs: SimTime): TraceEvent[] {
  const t0 = sim.trace(0).next;
  injectFrames(sim, { from: 'attacker', port: INJ_PORT, frames, count, spacingNs, startNs: at - d - sim.now });
  sim.runToIdle();
  return sim.trace(t0).events;
}

/** The first whole second at least 2 s after now. */
const nextSecond = (sim: Simulation): SimTime => sim.now - (sim.now % SEC) + 2 * SEC;

describe('storm-control rows (§3.7, A-16)', () => {
  it('are written when the line is stored and when the port comes up, with their first values', () => {
    const sim = world(sw1Config(['storm-control broadcast level pps 10 5']));
    const writes = stormWrites(sim.trace(0).events);
    const up = ofKind(sim.trace(0).events, 'portState').filter((e) => e.device === 'sw1' && e.port === FA5 && e.operUp);
    expect(up.length).toBeGreaterThan(0);
    // once at the configuration replay (boot, before any port is up) and once when Fa0/5 came up
    expect(writes.map((w) => w.key)).toEqual([`${FA5}|broadcast`, `${FA5}|broadcast`]);
    expect(writes[1]!.t).toBe(up[up.length - 1]!.t);
    expect(row(sim)).toEqual({
      key: `${FA5}|broadcast`, port: FA5, kind: 'broadcast', unit: 'pps', rise: 10, fall: 5,
      current: 0, state: 'forwarding', action: 'drop', dropped: 0, windowStart: writes[1]!.t, updatedAt: writes[1]!.t,
    });
    // no traffic: a minute later the row keeps its first values (windows are lazy, no timer)
    sim.runFor(60 * SEC);
    expect(stormWrites(sim.trace(0).events)).toHaveLength(2);
    expect(row(sim)).toMatchObject({ state: 'forwarding', current: 0, dropped: 0 });
  });
});

describe('the ingress check (pps, hysteresis, window edges)', () => {
  it('drops the frame above the rising level and the rest of its second, then whole seconds until one stays at or below the falling level', () => {
    const sim = world(sw1Config(['storm-control broadcast level pps 10 5']));
    const d = arrivalDelay(sim); // one frame offered in its own (earlier) second
    const k = nextSecond(sim);
    const before = stormWrites(sim.trace(0).events).length;

    // second k: 15 frames 50 ms apart → 10 pass, the 11th exceeds, 12–15 are blocked
    const s1 = arriveAt(sim, k, d, [BCAST], 15, 50 * MS);
    const drops1 = stormDrops(s1);
    expect(drops1).toHaveLength(5);
    expect(drops1.every((e) => e.device === 'sw1' && e.port === FA5 && e.t >= k && e.t < k + SEC)).toBe(true);
    expect(drops1[0]!.detail).toBe(`broadcast traffic on ${FA5} went above the storm-control rising level of 10 pps in this second`);
    expect(drops1[1]!.detail).toBe(`broadcast traffic on ${FA5} is blocked by storm control for this second (the class is above its levels)`);
    expect(drops1[0]!.rule).toEqual({
      kind: 'storm-control',
      text: `storm control on ${FA5} lets at most 10 pps of broadcast traffic through per second; above it the rest of the second is dropped, and the class stays blocked until a second stays at or below 5 pps`,
      table: 'storm-control',
      key: `${FA5}|broadcast`,
      iface: FA5,
      config: { context: [['interface', FA5]], line: ['storm-control', 'broadcast', 'level', 'pps', '10', '5'] },
    });
    expect(pcRx(s1)).toBe(10);
    expect(stormDebug(s1)).toEqual([
      `${FA5}: broadcast storm detected (above 10 pps); blocking the class`,
      ...Array(4).fill(`${FA5}: broadcast frame dropped while the class is blocked`),
    ]);
    // one row write for the whole second (at the exceedance), never per frame
    const w1 = stormWrites(s1);
    expect(w1).toHaveLength(1);
    expect(w1[0]!.t).toBe(drops1[0]!.t);
    expect(row(sim)).toMatchObject({ state: 'blocking', dropped: 1, windowStart: k });
    expect(stormWrites(sim.trace(0).events)).toHaveLength(before + 1);

    // second k+1: the previous second offered 15 > 5, so three frames all drop; the closed second is written once
    const s2 = arriveAt(sim, k + SEC, d, [BCAST], 3, 100 * MS);
    expect(stormDrops(s2)).toHaveLength(3);
    expect(pcRx(s2)).toBe(0);
    const w2 = stormWrites(s2);
    expect(w2).toHaveLength(1);
    // written at the first frame of the second, which is itself dropped (5 + 1); the later drops do not write
    expect(w2[0]!.row).toMatchObject({ state: 'blocking', current: 15, dropped: 6, windowStart: k + SEC });
    expect(row(sim)).toMatchObject({ state: 'blocking', dropped: 6 });

    // second k+2: the previous offered 3 ≤ 5 → forwarding again; the frames pass
    const s3 = arriveAt(sim, k + 2 * SEC, d, [BCAST], 4, 100 * MS);
    expect(stormDrops(s3)).toEqual([]);
    expect(pcRx(s3)).toBe(4);
    const w3 = stormWrites(s3);
    expect(w3).toHaveLength(1);
    expect(w3[0]!.row).toMatchObject({ state: 'forwarding', current: 3, dropped: 8, windowStart: k + 2 * SEC });
  });

  it('a frame at k s − 1 ns belongs to the earlier second, one at k s to the next (window edges exact to the ns)', () => {
    const sim = world(sw1Config(['storm-control broadcast level pps 2']));
    const d = arrivalDelay(sim);
    const k = nextSecond(sim);
    const t0 = sim.trace(0).next;
    const at = (when: SimTime, count: number, spacingNs: SimTime): void => {
      injectFrames(sim, { from: 'attacker', port: INJ_PORT, frames: [BCAST], count, spacingNs, startNs: when - d - sim.now });
    };
    // (a) second k − 1 is full (two frames, at the rising level, not above); a frame at exactly k s starts second k and
    //     passes; one more in second k passes too (two in second k)
    at(k - 20 * MS, 2, 10 * MS);
    at(k, 1, 0);
    at(k + 10 * MS, 1, 0);
    // (b) second k + 1 is filled early; a frame at its last nanosecond (k + 2 s − 1 ns) still belongs to it and drops
    at(k + SEC + 10 * MS, 2, 10 * MS);
    at(k + 2 * SEC - 1, 1, 0);
    sim.runToIdle();
    const evs = sim.trace(t0).events;
    expect(swRx(evs).map((e) => e.t)).toEqual([
      k - 20 * MS, k - 10 * MS, k, k + 10 * MS, k + SEC + 10 * MS, k + SEC + 20 * MS, k + 2 * SEC - 1,
    ]);
    expect(stormDrops(evs).map((e) => e.t)).toEqual([k + 2 * SEC - 1]);
  });

  it('counts only the configured class: a broadcast line leaves unicast frames alone', () => {
    const sim = world(sw1Config(['storm-control broadcast level pps 1']));
    const d = arrivalDelay(sim);
    const evs = arriveAt(sim, nextSecond(sim), d, [UNICAST], 5, 10 * MS);
    expect(stormDrops(evs)).toEqual([]);
    expect(stormWrites(evs)).toEqual([]);
  });
});

describe('bps and percent levels count wire bits', () => {
  it('bps: ten 64-byte frames fit 5120 bps, the eleventh exceeds', () => {
    const sim = world(sw1Config(['storm-control broadcast level bps 5120']));
    const d = arrivalDelay(sim);
    const evs = arriveAt(sim, nextSecond(sim), d, [BCAST], 11, 10 * MS);
    expect(swRx(evs).every((e) => e.pdu.size === 64)).toBe(true);
    expect(stormDrops(evs)).toHaveLength(1);
    expect(stormDrops(evs)[0]!.detail).toBe(`broadcast traffic on ${FA5} went above the storm-control rising level of 5120 bps in this second`);
  });

  it('percent: level 0.01 is ⌊speed × 1 / 10 000⌋ bits of the operational speed per second', () => {
    const sim = world(sw1Config(['storm-control broadcast level 0.01']));
    const speed = sim.device('sw1')!.port(FA5)!.speedBps!;
    const fit = Math.floor(Math.floor(speed / 10_000) / 512); // 64-byte frames within the threshold
    expect(fit).toBeGreaterThan(1);
    const d = arrivalDelay(sim);
    const evs = arriveAt(sim, nextSecond(sim), d, [BCAST], fit + 1, 1 * MS);
    const drops = stormDrops(evs);
    expect(drops).toHaveLength(1);
    expect(drops[0]!.detail).toBe(`broadcast traffic on ${FA5} went above the storm-control rising level of 0.01% in this second`);
    expect(swRx(evs).findIndex((e) => e.t === drops[0]!.t)).toBe(fit);
  });
});

describe('actions: shutdown, trap, both (RC5 (g))', () => {
  it('action shutdown err-disables the port with cause storm-control; recovery brings it back with fresh rows', () => {
    const sim = world(sw1Config(['storm-control broadcast level pps 3', 'storm-control action shutdown'], ['errdisable recovery cause storm-control', 'errdisable recovery interval 30']));
    expect(row(sim)).toMatchObject({ action: 'shutdown', state: 'forwarding' });
    const d = arrivalDelay(sim);
    const evs = arriveAt(sim, nextSecond(sim), d, [BCAST], 5, 10 * MS);
    expect(sim.device('sw1')!.port(FA5)!.errDisabled).toBe('storm-control');
    const drops = stormDrops(evs);
    expect(drops.length).toBeGreaterThanOrEqual(1);
    const disabled = ofKind(evs, 'portState').find((e) => e.port === FA5 && e.reason === 'err-disabled')!;
    expect(disabled.t).toBe(drops[0]!.t);
    expect(ofKind(evs, 'log').filter((e) => e.device === 'sw1').map((e) => [e.severity, e.message])).toContainEqual([
      4, `Interface ${FA5} is error-disabled by storm control: broadcast traffic went above the storm-control rising level of 3 pps.`,
    ]);
    expect(stormLogs(evs)).toEqual([]);
    expect(row(sim)).toMatchObject({ state: 'err-disabled', dropped: 1 });
    expect(stormDebug(evs)).toContain(`${FA5} recovers from err-disable in 30 s`);

    const t1 = sim.trace(0).next;
    sim.runFor(40 * SEC);
    const rec = sim.trace(t1).events;
    expect(sim.device('sw1')!.port(FA5)!.errDisabled).toBeUndefined();
    expect(ofKind(rec, 'portState').find((e) => e.port === FA5 && e.reason === 'err-recovered')!.t).toBe(disabled.t + 30 * SEC);
    expect(stormDebug(rec)).toContain(`recovering ${FA5} from err-disable`);
    expect(row(sim)).toMatchObject({ state: 'forwarding', current: 0, dropped: 0 });
  });

  it('action trap logs once per exceedance (severity 3, STORM_CONTROL) and keeps the port up', () => {
    const sim = world(sw1Config(['storm-control broadcast level pps 3', 'storm-control action trap']));
    const d = arrivalDelay(sim);
    const k = nextSecond(sim);
    const first = arriveAt(sim, k, d, [BCAST], 6, 10 * MS);
    expect(stormDrops(first)).toHaveLength(3);
    expect(stormLogs(first).map((e) => [e.device, e.severity, e.message])).toEqual([
      ['sw1', 3, `A broadcast storm was detected on ${FA5}: traffic went above 3 pps, and storm control is filtering the class.`],
    ]);
    expect(sim.device('sw1')!.port(FA5)!.errDisabled).toBeUndefined();
    // a quiet second, then a second storm: one more log
    const second = arriveAt(sim, k + 3 * SEC, d, [BCAST], 6, 10 * MS);
    expect(stormLogs(second)).toHaveLength(1);
    expect(row(sim)).toMatchObject({ action: 'trap', state: 'blocking' });
  });

  it('both actions: the port err-disables and the trap log is emitted too', () => {
    const sim = world(sw1Config(['storm-control broadcast level pps 3', 'storm-control action shutdown', 'storm-control action trap']));
    const d = arrivalDelay(sim);
    const evs = arriveAt(sim, nextSecond(sim), d, [BCAST], 5, 10 * MS);
    expect(sim.device('sw1')!.port(FA5)!.errDisabled).toBe('storm-control');
    expect(stormLogs(evs)).toHaveLength(1);
    expect(row(sim)).toMatchObject({ action: 'shutdown', state: 'err-disabled' });
  });
});

describe('configuration changes and silence', () => {
  it('removing the level line removes the row and the limit', () => {
    const sim = world(sw1Config(['storm-control broadcast level pps 1']));
    expect(row(sim)).toBeDefined();
    expect(sim.device('sw1')!.applyConfigLine([['interface', FA5]], ['storm-control', 'broadcast', 'level'], true).ok).toBe(true);
    expect(row(sim)).toBeUndefined();
    const d = arrivalDelay(sim);
    const evs = arriveAt(sim, nextSecond(sim), d, [BCAST], 5, 10 * MS);
    expect(stormDrops(evs)).toEqual([]);
    expect(stormWrites(evs)).toEqual([]);
  });

  it('a level line stored at run time writes the row at once', () => {
    const sim = world(sw1Config([]));
    const t0 = sim.trace(0).next;
    expect(sim.device('sw1')!.applyConfigLine([['interface', FA5]], ['storm-control', 'unicast', 'level', 'pps', '2'], false).ok).toBe(true);
    const w = stormWrites(sim.trace(t0).events);
    expect(w.map((e) => [e.t, e.key])).toEqual([[sim.now, `${FA5}|unicast`]]);
    expect(row(sim, 'unicast')).toMatchObject({ unit: 'pps', rise: 2, fall: 2, state: 'forwarding', windowStart: sim.now });
    const d = arrivalDelay(sim); // its probe is a broadcast, which the unicast line does not count
    const evs = arriveAt(sim, nextSecond(sim), d, [UNICAST], 3, 10 * MS);
    expect(stormDrops(evs)).toHaveLength(1);
  });

  it('with no line nothing is counted, written, logged or debugged', () => {
    const sim = world(sw1Config([]));
    const d = arrivalDelay(sim);
    arriveAt(sim, nextSecond(sim), d, [BCAST], 50, 1 * MS);
    const evs = sim.trace(0).events;
    expect(stormDrops(evs)).toEqual([]);
    expect(stormWrites(evs)).toEqual([]);
    expect(stormLogs(evs)).toEqual([]);
    expect(stormDebug(evs)).toEqual([]);
  });
});

describe('determinism', () => {
  it('two runs with one seed (a storm, a block, a recovery to forwarding) are byte-identical', () => {
    const run = (): string => {
      const sim = world(sw1Config(['storm-control broadcast level pps 5 2', 'storm-control action trap']), 13);
      const d = arrivalDelay(sim);
      arriveAt(sim, nextSecond(sim), d, [BCAST], 30, 100 * MS);
      return JSON.stringify([sim.trace(0).events, sim.snapshot()]);
    };
    expect(run()).toBe(run());
  });
});
