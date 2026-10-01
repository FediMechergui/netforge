/**
 * device.clock — the device clock of the runtime (ARCHITECTURE-P3 D19, §2.4, §2.9, §3.7; §7 W1 device): the pure
 * helpers of device/process-ctx.ts (`bootClockBase`, `clockViewAt`, `rebaseClockBase`, `clockTimezoneOf`), and the
 * runtime's `clockView(now)`, `ctx.clock()`, the `clock` action and `setClock`: network devices boot unset
 * (2020-01-01 plus uptime, not authoritative), hosts keep true time, a step or set rebases the clock, exactly one
 * `ntp` transition debug event (category `ntp events`) marks a change of the synchronised state, a malformed action
 * changes nothing, the `clock timezone` line sets the zone, and power-off forgets the clock.
 */
import { describe, expect, it } from 'vitest';
import { NF_CLOCK_UNSET_UNIX_MS, NF_WORLD_EPOCH_UNIX_MS } from '../src/contracts/clock.js';
import type { ClockAction, DebugEvent } from '../src/contracts/process.js';
import { SEC } from '../src/contracts/time.js';
import {
  CLOCK_TRANSITION_NO_REFERENCE,
  CLOCK_TRANSITION_CATEGORY,
  clockSynchronisedMessage,
  clockUnsynchronisedMessage,
  isSynchronisedClockSource,
} from '../src/device/device.js';
import {
  DEVICE_CLOCK_UTC,
  bootClockBase,
  clockTimezoneOf,
  clockViewAt,
  isHostClock,
  rebaseClockBase,
  type DeviceClockBase,
} from '../src/device/process-ctx.js';
import { boot, fakeProcess, harness } from './device.harness.js';

const step = (offsetNs: string, extra: Partial<ClockAction> = {}): ClockAction => ({ type: 'clock', op: 'step', offsetNs, source: 'ntp', ...extra });

describe('clock helpers (pure)', () => {
  it('a host keeps true time from SimTime 0; a network device boots unset plus uptime', () => {
    expect(isHostClock(['host'])).toBe(true);
    expect(isHostClock(['host', 'server'])).toBe(true);
    expect(isHostClock(['host', 'routing'])).toBe(false);
    expect(isHostClock(['switching', 'routing', 'layer3-switch'])).toBe(false);
    expect(bootClockBase(['host'], 45 * SEC, 99 * SEC)).toEqual({ unixMs: NF_WORLD_EPOCH_UNIX_MS, subMsNs: 0, at: 0, source: 'host' });
    expect(bootClockBase(['routing'], 45 * SEC, 99 * SEC)).toEqual({ unixMs: NF_CLOCK_UNSET_UNIX_MS, subMsNs: 0, at: 45 * SEC, source: 'unset' });
    // not booted: uptime 0
    expect(bootClockBase(['routing'], undefined, 7 * SEC)).toEqual({ unixMs: NF_CLOCK_UNSET_UNIX_MS, subMsNs: 0, at: 7 * SEC, source: 'unset' });
  });

  it('clockViewAt is base + (now − at) in integer ms and a sub-millisecond remainder', () => {
    const base: DeviceClockBase = { unixMs: 1000, subMsNs: 999_999, at: 10, source: 'ntp', stratum: 2, reference: '10.0.0.10' };
    expect(clockViewAt(base, 10)).toEqual({ source: 'ntp', authoritative: true, unixMs: 1000, subMsNs: 999_999, stratum: 2, reference: '10.0.0.10', tz: DEVICE_CLOCK_UTC });
    expect(clockViewAt(base, 11)).toMatchObject({ unixMs: 1001, subMsNs: 0 });
    expect(clockViewAt(base, 10 + 12_345_678_901)).toMatchObject({ unixMs: 1000 + 12_346, subMsNs: 678_900 });
    // a large elapsed time (≈ 104 days, just below 2^53 ns) stays exact
    const far = 8_999_999_999_999_999;
    expect(Number.isSafeInteger(far)).toBe(true);
    expect(clockViewAt({ unixMs: 0, subMsNs: 0, at: 0, source: 'host' }, far)).toMatchObject({ unixMs: 8_999_999_999, subMsNs: 999_999 });
    // a view before the base (never produced by the runtime) still splits correctly
    expect(clockViewAt({ unixMs: 1000, subMsNs: 0, at: 5, source: 'user' }, 4)).toMatchObject({ unixMs: 999, subMsNs: 999_999 });
    // only 'unset' is not authoritative; no stratum/reference keys unless set
    const unset = clockViewAt({ unixMs: 5, subMsNs: 0, at: 0, source: 'unset' }, 0);
    expect(unset.authoritative).toBe(false);
    expect(Object.keys(unset)).toEqual(['source', 'authoritative', 'unixMs', 'subMsNs', 'tz']);
    expect(clockViewAt({ unixMs: 5, subMsNs: 0, at: 0, source: 'user' }, 0, { name: 'CET', offsetMin: 60 }).tz).toEqual({ name: 'CET', offsetMin: 60 });
  });

  it('rebaseClockBase steps by a decimal offset beyond 2^53 ns without converting it whole', () => {
    const cur = { unixMs: NF_CLOCK_UNSET_UNIX_MS + 12_500, subMsNs: 250 };
    // true time − unset clock ≈ 1.58e17 ns: 158 313 600 000 ms and 123 456 ns
    const r = rebaseClockBase(cur, step('158313599987500123456', { stratum: 2, reference: '10.0.0.10' }), 777);
    expect(r).toEqual({ unixMs: NF_CLOCK_UNSET_UNIX_MS + 12_500 + 158_313_599_987_500, subMsNs: 123_706, at: 777, source: 'ntp', stratum: 2, reference: '10.0.0.10' });
    // negative offsets borrow from the milliseconds
    expect(rebaseClockBase({ unixMs: 1000, subMsNs: 100 }, step('-200'), 0)).toMatchObject({ unixMs: 999, subMsNs: 999_900 });
    expect(rebaseClockBase({ unixMs: 1000, subMsNs: 100 }, step('-1000000'), 0)).toMatchObject({ unixMs: 999, subMsNs: 100 });
    expect(rebaseClockBase({ unixMs: 1000, subMsNs: 0 }, step('000001000001'), 0)).toMatchObject({ unixMs: 1001, subMsNs: 1 });
    // a step without an offset is a zero step (the source still changes)
    expect(rebaseClockBase({ unixMs: 1000, subMsNs: 7 }, { type: 'clock', op: 'step', source: 'master', stratum: 8 }, 3)).toEqual({ unixMs: 1000, subMsNs: 7, at: 3, source: 'master', stratum: 8 });
  });

  it('rebaseClockBase sets exact milliseconds, keeps the value without unixMs, and refuses malformed actions', () => {
    expect(rebaseClockBase({ unixMs: 1, subMsNs: 5 }, { type: 'clock', op: 'set', unixMs: 1_736_150_400_123, source: 'user' }, 9)).toEqual({ unixMs: 1_736_150_400_123, subMsNs: 0, at: 9, source: 'user' });
    expect(rebaseClockBase({ unixMs: 1, subMsNs: 5 }, { type: 'clock', op: 'set', source: 'master', stratum: 1 }, 9)).toEqual({ unixMs: 1, subMsNs: 5, at: 9, source: 'master', stratum: 1 });
    for (const bad of ['', '1.5', '+3', '1e9', ' 5', '--1', '99999999999999999999999999']) expect(rebaseClockBase({ unixMs: 0, subMsNs: 0 }, step(bad), 0), bad).toBeUndefined();
    expect(rebaseClockBase({ unixMs: 0, subMsNs: 0 }, { type: 'clock', op: 'set', unixMs: 1.5, source: 'user' }, 0)).toBeUndefined();
    expect(rebaseClockBase({ unixMs: 0, subMsNs: 0 }, step('5', { stratum: 17 }), 0)).toBeUndefined();
    expect(rebaseClockBase({ unixMs: 0, subMsNs: 0 }, step('5', { stratum: 2.5 }), 0)).toBeUndefined();
  });

  it('clockTimezoneOf reads `clock timezone` flat or folded; anything malformed is UTC', () => {
    const flat = (args: string[]) => ({ children: [{ key: 'clock', args: ['timezone', ...args], children: [] }] });
    const folded = (args: string[]) => ({ children: [{ key: 'clock', args: [], children: [{ key: 'timezone', args, children: [] }] }] });
    expect(clockTimezoneOf({ children: [] })).toEqual(DEVICE_CLOCK_UTC);
    expect(clockTimezoneOf(flat(['CET', '1']))).toEqual({ name: 'CET', offsetMin: 60 });
    expect(clockTimezoneOf(folded(['EST', '-5']))).toEqual({ name: 'EST', offsetMin: -300 });
    expect(clockTimezoneOf(flat(['IST', '+5', '30']))).toEqual({ name: 'IST', offsetMin: 330 });
    expect(clockTimezoneOf(flat(['NST', '-3', '30']))).toEqual({ name: 'NST', offsetMin: -210 });
    expect(clockTimezoneOf(flat(['X', '-0', '45']))).toEqual({ name: 'X', offsetMin: -45 });
    for (const bad of [['CET'], ['CET', 'one'], ['CET', '24'], ['CET', '1', '60'], ['CET', '1', '0', 'x'], ['CET', '1', '-5']]) {
      expect(clockTimezoneOf(flat(bad)), bad.join(' ')).toEqual(DEVICE_CLOCK_UTC);
    }
    // an interface-level `clock rate` is never read (only root nodes are)
    expect(clockTimezoneOf({ children: [{ key: 'interface', args: ['Serial0/0/0'], children: [{ key: 'clock', args: ['rate', '64000'], children: [] }] }] })).toEqual(DEVICE_CLOCK_UTC);
  });
});

describe('the runtime clock (D19)', () => {
  it('a router boots unset: 2020-01-01 plus uptime, not authoritative; ctx.clock() is the same view', () => {
    const ipv4 = fakeProcess('ipv4');
    const h = harness({ type: 'router.nf2911', name: 'R1', processes: { ipv4: ipv4.factory } });
    expect(h.device.clockView(0)).toEqual({ source: 'unset', authoritative: false, unixMs: NF_CLOCK_UNSET_UNIX_MS, subMsNs: 0, tz: DEVICE_CLOCK_UTC });
    boot(h);
    const booted = h.device.bootedAt as number;
    expect(booted).toBe(45 * SEC);
    const at = booted + 12_500_000_123;
    expect(h.device.clockView(at)).toEqual({ source: 'unset', authoritative: false, unixMs: NF_CLOCK_UNSET_UNIX_MS + 12_500, subMsNs: 123, tz: DEVICE_CLOCK_UTC });
    const ctx = ipv4.ctx!;
    expect(ctx.clock()).toEqual(h.device.clockView(ctx.now));
  });

  it('a host keeps true time from SimTime 0 (source host, authoritative)', () => {
    const h = harness({ type: 'pc.nfpc', name: 'PC1' });
    boot(h);
    expect(h.device.clockView(90 * SEC + 7)).toEqual({ source: 'host', authoritative: true, unixMs: NF_WORLD_EPOCH_UNIX_MS + 90_000, subMsNs: 7, tz: DEVICE_CLOCK_UTC });
  });

  it('the clock action steps the clock and emits exactly one ntp transition when it becomes synchronised', () => {
    const h = harness({ type: 'router.nf2911', name: 'R1' });
    boot(h);
    const t1 = 100 * SEC;
    const before = h.device.clockView(t1);
    const debugBefore = h.kinds('debug').length;
    h.device.applyActions('ntp', [step('158313600000000000', { stratum: 2, reference: '10.0.0.10' })], t1);
    const after = h.device.clockView(t1);
    expect(after).toEqual({ source: 'ntp', authoritative: true, unixMs: before.unixMs + 158_313_600_000, subMsNs: 0, stratum: 2, reference: '10.0.0.10', tz: DEVICE_CLOCK_UTC });
    expect(h.device.clockView(t1 + 5 * SEC).unixMs).toBe(after.unixMs + 5000);
    const debug = h.kinds('debug').slice(debugBefore).map((e) => (e as { event: DebugEvent }).event);
    expect(debug).toEqual([
      {
        at: t1,
        device: 'd_1',
        process: 'ntp',
        category: CLOCK_TRANSITION_CATEGORY,
        message: clockSynchronisedMessage('10.0.0.10', 2),
        fsm: { machine: 'ntp', subject: '10.0.0.10', from: 'unsynchronised', to: 'synchronised' },
      },
    ]);
    expect(h.device.recentDebug(1)).toEqual(debug);
    // a second sync (still synchronised) emits nothing
    h.device.applyActions('ntp', [step('-2000000', { stratum: 2, reference: '10.0.0.10' })], t1 + SEC);
    expect(h.kinds('debug').length).toBe(debugBefore + 1);
    expect(h.device.clockView(t1 + SEC).unixMs).toBe(after.unixMs + 1000 - 2);
  });

  it('`clock set` (source user) sets exact milliseconds and leaves synchronised state; master counts as synchronised', () => {
    const h = harness({ type: 'router.nf2911', name: 'R1' });
    boot(h);
    const t = 60 * SEC;
    h.device.applyActions('ntp', [{ type: 'clock', op: 'set', unixMs: 1_736_150_400_000, source: 'user' }], t);
    expect(h.device.clockView(t + 1_500_000)).toEqual({ source: 'user', authoritative: true, unixMs: 1_736_150_400_001, subMsNs: 500_000, tz: DEVICE_CLOCK_UTC });
    expect(h.kinds('debug')).toEqual([]); // unset → user: never synchronised, no transition
    h.device.setClock({ type: 'clock', op: 'step', source: 'master', stratum: 8 }, t + SEC);
    expect(h.device.clockView(t + SEC)).toMatchObject({ source: 'master', stratum: 8, unixMs: 1_736_150_401_000 });
    expect(h.kinds('debug').map((e) => (e as { event: DebugEvent }).event.fsm)).toEqual([
      { machine: 'ntp', subject: CLOCK_TRANSITION_NO_REFERENCE, from: 'unsynchronised', to: 'synchronised' },
    ]);
    h.device.applyActions('ntp', [{ type: 'clock', op: 'set', unixMs: 1_800_000_000_000, source: 'user' }], t + 2 * SEC);
    const last = h.kinds('debug').map((e) => (e as { event: DebugEvent }).event).at(-1)!;
    expect(last.message).toBe(clockUnsynchronisedMessage(CLOCK_TRANSITION_NO_REFERENCE));
    expect(last.fsm).toEqual({ machine: 'ntp', subject: CLOCK_TRANSITION_NO_REFERENCE, from: 'synchronised', to: 'unsynchronised' });
    expect(isSynchronisedClockSource('ntp') && isSynchronisedClockSource('master')).toBe(true);
    expect(['unset', 'user', 'host'].some((s) => isSynchronisedClockSource(s as 'unset'))).toBe(false);
  });

  it('a malformed clock action is a runtime debug line and changes nothing', () => {
    const h = harness({ type: 'router.nf2911', name: 'R1' });
    boot(h);
    const t = 50 * SEC;
    const before = h.device.clockView(t);
    h.device.applyActions('ntp', [step('12.5')], t);
    expect(h.device.clockView(t)).toEqual(before);
    const d = h.kinds('debug').map((e) => (e as { event: DebugEvent }).event);
    expect(d).toHaveLength(1);
    expect(d[0]).toMatchObject({ process: 'ntp', category: 'runtime' });
    expect(d[0]!.fsm).toBeUndefined();
  });

  it('`clock timezone` sets the zone of the view; power-off forgets a synchronised clock', () => {
    const h = harness({ type: 'router.nf2911', name: 'R1' });
    boot(h);
    expect(h.device.applyConfigLine([], ['clock', 'timezone', 'CET', '1'], false).ok).toBe(true);
    expect(h.device.clockView(50 * SEC).tz).toEqual({ name: 'CET', offsetMin: 60 });
    h.device.applyActions('ntp', [step('1000000000', { reference: '10.0.0.10', stratum: 3 })], 50 * SEC);
    expect(h.device.clockView(50 * SEC).source).toBe('ntp');
    h.device.reload(60 * SEC);
    // RAM is lost: unset again (uptime 0 while booting), and the zone line is gone with the running configuration
    expect(h.device.clockView(61 * SEC)).toEqual({ source: 'unset', authoritative: false, unixMs: NF_CLOCK_UNSET_UNIX_MS, subMsNs: 0, tz: DEVICE_CLOCK_UTC });
    h.run(60 * SEC + 45 * SEC);
    expect(h.device.clockView(110 * SEC)).toMatchObject({ source: 'unset', unixMs: NF_CLOCK_UNSET_UNIX_MS + 5000 });
  });
});
