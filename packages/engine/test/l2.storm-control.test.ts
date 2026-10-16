/**
 * W1a l2 (ARCHITECTURE-P3C [S16], §3.7, §4.1, §4.2): the pure storm-control ingress check.
 *  - the reader: classes, percent in hundredths, `pps` / `bps` with k/m/g, fall defaulting to rise, actions;
 *  - units: the percent threshold of the operational speed, frame bits with FCS, pps frames;
 *  - lazy one-second windows, exact to the ns, aligned to SimTime 0;
 *  - rising / falling hysteresis, an empty window in between, the err-disable and trap paths;
 *  - rows: written at store / port-up, then only on a state change or a closed window with drops (rule 20).
 */
import { describe, expect, it } from 'vitest';
import { configAstFromJson } from '../src/cli/config-ast.js';
import type { ConfigAst, ConfigNode } from '../src/contracts/config.js';
import type { StormControlRow } from '../src/contracts/tables.js';
import { SEC } from '../src/contracts/time.js';
import {
  STORM_CONTROL_LOG_FACILITY,
  formatStormLevel,
  parseStormLevelLine,
  parseStormPercent,
  parseStormRate,
  readStormControl,
  stormAmount,
  stormClassOf,
  stormControlArrive,
  stormControlKey,
  stormControlRows,
  stormLevelFor,
  stormLevelOf,
  stormThreshold,
  stormWindowStart,
} from '../src/protocols/l2/storm-control.js';
import type { StormControlPortConfig, StormControlStep, StormWindowState } from '../src/protocols/l2/storm-control.js';

const FA1 = 'FastEthernet0/1';
const GI1 = 'GigabitEthernet0/1';
const MBPS10 = 10_000_000;
const MBPS100 = 100_000_000;

function lineNode(text: string): ConfigNode {
  const t = text.split(' ');
  return t[0] === 'no' ? { key: 'no', args: t.slice(1), children: [] } : { key: t[0] as string, args: t.slice(1), children: [] };
}
function cfg(sections: Readonly<Record<string, readonly string[]>>, globals: readonly string[] = []): ConfigAst {
  const root: ConfigNode = { key: '', args: [], children: globals.map(lineNode) };
  for (const [port, lines] of Object.entries(sections)) root.children.push({ key: 'interface', args: [port], children: lines.map(lineNode) });
  return configAstFromJson(root);
}
function port(lines: readonly string[]): StormControlPortConfig {
  const pc = readStormControl(cfg({ [FA1]: lines })).get(FA1);
  if (pc === undefined) throw new Error('no storm-control on the port');
  return pc;
}

/** Drives one (port, class) as eth-switch will: keeps the state and the last written row; records every write. */
function driver(pc: StormControlPortConfig, speedBps: number, kind: 'broadcast' | 'multicast' | 'unicast' = 'broadcast', now0 = 0) {
  const level = stormLevelFor(pc, kind);
  if (level === undefined) throw new Error('class not configured');
  const initial = stormControlRows(pc, now0).find((r) => r.kind === kind) as StormControlRow;
  let row = initial;
  let state: StormWindowState | undefined;
  const writes: StormControlRow[] = [];
  const steps: StormControlStep[] = [];
  return {
    initial,
    writes,
    steps,
    get state() { return state; },
    get row() { return row; },
    frame(now: number, bytes = 64): StormControlStep {
      const s = stormControlArrive({ config: pc, level, speedBps, frameBytes: bytes, now, row, ...(state === undefined ? {} : { state }) });
      state = s.state;
      if (s.row !== undefined) {
        row = s.row;
        writes.push(s.row);
      }
      steps.push(s);
      return s;
    },
  };
}
const dropped = (s: StormControlStep): boolean => s.drop !== undefined;

describe('readStormControl', () => {
  it('reads the three classes, percent in hundredths with fall defaulting to rise, and the action', () => {
    const c = readStormControl(cfg({
      [FA1]: ['storm-control unicast level 50', 'storm-control broadcast level 1.00', 'storm-control multicast level 2.5 1.25', 'storm-control action trap'],
      [GI1]: ['storm-control action shutdown'],
    }));
    const pc = c.get(FA1);
    expect(pc?.levels.map((l) => [l.kind, l.unit, l.rise, l.fall])).toEqual([
      ['broadcast', 'percent', 100, 100],
      ['multicast', 'percent', 250, 125],
      ['unicast', 'percent', 5000, 5000],
    ]);
    expect(pc).toMatchObject({ shutdown: false, trap: true, action: 'trap' });
    expect(pc?.levels[0]?.line).toEqual(['storm-control', 'broadcast', 'level', '1.00']);
    // an action alone does not turn storm control on (§4.3)
    expect(c.has(GI1)).toBe(false);
    expect(readStormControl(cfg({})).size).toBe(0);
  });
  it('pps and bps levels with k, m and g; a later line of a class replaces the earlier one; shutdown wins the row action', () => {
    const pc = port(['storm-control broadcast level pps 100', 'storm-control broadcast level pps 1k 500', 'storm-control multicast level bps 1.5m 2', 'storm-control action trap', 'storm-control action shutdown']);
    expect(pc.levels.map((l) => [l.kind, l.unit, l.rise, l.fall])).toEqual([
      ['broadcast', 'pps', 1000, 500],
      ['multicast', 'bps', 1_500_000, 2],
    ]);
    expect(pc).toMatchObject({ shutdown: true, trap: true, action: 'shutdown' });
    expect(port(['storm-control broadcast level 1']).action).toBe('drop');
  });
  it('ignores negations and lines that do not parse (fall above rise, above 100 %, bad words)', () => {
    const c = readStormControl(cfg({ [FA1]: [
      'no storm-control broadcast level 1.00',
      'storm-control broadcast level 1.00 2.00',
      'storm-control multicast level 100.01',
      'storm-control unicast level pps',
      'storm-control anycast level 1',
      'storm-control broadcast level 1 1 1',
    ] }));
    expect(c.size).toBe(0);
  });
  it('parsers: percent hundredths, rates with suffixes, whole values only', () => {
    expect([parseStormPercent('0'), parseStormPercent('0.01'), parseStormPercent('1.5'), parseStormPercent('100'), parseStormPercent('100.00')]).toEqual([0, 1, 150, 10_000, 10_000]);
    expect([parseStormPercent('1.001'), parseStormPercent('101'), parseStormPercent('x'), parseStormPercent(undefined)]).toEqual([undefined, undefined, undefined, undefined]);
    expect([parseStormRate('500'), parseStormRate('1k'), parseStormRate('1.5k'), parseStormRate('2M'), parseStormRate('10g'), parseStormRate('0.000000001g')]).toEqual([500, 1000, 1500, 2_000_000, 10_000_000_000, 1]);
    expect([parseStormRate('1.5'), parseStormRate('1.0005k'), parseStormRate('11g'), parseStormRate('-1')]).toEqual([undefined, undefined, undefined, undefined]);
    expect(parseStormLevelLine(['storm-control', 'broadcast', 'level', 'bps', '1m'])).toMatchObject({ unit: 'bps', rise: 1_000_000, fall: 1_000_000 });
  });
});

describe('classes and units', () => {
  it('broadcast, multicast (the group bit) and every other frame unicast', () => {
    expect(stormClassOf('ff:ff:ff:ff:ff:ff')).toBe('broadcast');
    expect(stormClassOf('01:00:5e:00:00:05')).toBe('multicast');
    expect(stormClassOf('01:80:c2:00:00:00')).toBe('multicast');
    expect(stormClassOf('00:50:79:66:68:00')).toBe('unicast');
    expect(stormClassOf('FFFF.FFFF.FFFF')).toBe('broadcast');
  });
  it('thresholds: ⌊speed × hundredths / 10 000⌋ bits of the operational speed; pps frames; bps bits', () => {
    expect(stormThreshold('percent', 100, MBPS100)).toBe(1_000_000);
    expect(stormThreshold('percent', 100, MBPS10)).toBe(100_000);
    expect(stormThreshold('percent', 1, 33_333)).toBe(3); // floor
    expect(stormThreshold('percent', 100, 0)).toBe(0);
    expect(stormThreshold('pps', 100, MBPS10)).toBe(100);
    expect(stormThreshold('bps', 1000, MBPS10)).toBe(1000);
    expect(stormAmount('pps', 1518)).toBe(1);
    expect(stormAmount('percent', 64)).toBe(512);
    expect(stormAmount('bps', 1518)).toBe(12_144);
    expect(stormLevelOf('percent', 2048, MBPS10)).toBe(2);
    expect(stormLevelOf('percent', 2048, 0)).toBe(0);
    expect(stormLevelOf('pps', 7, MBPS10)).toBe(7);
    expect([formatStormLevel('percent', 100), formatStormLevel('percent', 5), formatStormLevel('percent', 10_000), formatStormLevel('pps', 10), formatStormLevel('bps', 1000)])
      .toEqual(['1.00%', '0.05%', '100.00%', '10 pps', '1000 bps']);
  });
});

describe('stormControlArrive: window edges to the ns', () => {
  it('windows are [k s, (k+1) s) aligned to SimTime 0', () => {
    expect(stormWindowStart(0)).toBe(0);
    expect(stormWindowStart(SEC - 1)).toBe(0);
    expect(stormWindowStart(SEC)).toBe(SEC);
    expect(stormWindowStart(3 * SEC + 7)).toBe(3 * SEC);
  });
  it('the frame that would exceed rise drops, later frames of the window drop; at the boundary ns the new window decides', () => {
    const d = driver(port(['storm-control broadcast level pps 2 1']), MBPS10);
    expect(dropped(d.frame(0))).toBe(false);
    expect(dropped(d.frame(SEC - 2))).toBe(false);
    const third = d.frame(SEC - 1);
    expect(third.drop?.reason).toBe('storm-control');
    expect(third.drop?.detail).toBe(`broadcast traffic on ${FA1} went above the storm-control rising level of 2 pps in this second`);
    expect(third.drop?.rule).toEqual(expect.objectContaining({ kind: 'storm-control', table: 'storm-control', key: `${FA1}|broadcast`, iface: FA1, config: { context: [['interface', FA1]], line: ['storm-control', 'broadcast', 'level', 'pps', '2', '1'] } }));
    expect(d.state).toMatchObject({ start: 0, offered: 3, dropped: 1, blocking: true });
    // exactly at 1 s: the previous window offered 3 > fall 1, so the whole new window drops
    const edge = d.frame(SEC);
    expect(edge.drop?.detail).toContain('is blocked by storm control');
    expect(d.state).toMatchObject({ start: SEC, offered: 1, dropped: 1, blocking: true });
    // at 2 s - 1 ns still the same window
    expect(dropped(d.frame(2 * SEC - 1))).toBe(true);
    expect(d.state).toMatchObject({ start: SEC, offered: 2 });
    // at 2 s: the window before offered 2 > 1 — still blocking
    expect(dropped(d.frame(2 * SEC))).toBe(true);
    // at 3 s: the window [2 s, 3 s) offered 1 ≤ fall 1 → forwarding again
    expect(dropped(d.frame(3 * SEC))).toBe(false);
    expect(d.state).toMatchObject({ start: 3 * SEC, offered: 1, blocking: false });
  });
  it('a frame at the boundary ns counts in the new window only (a fresh count while forwarding)', () => {
    const d = driver(port(['storm-control broadcast level pps 2']), MBPS10);
    d.frame(SEC - 1);
    d.frame(SEC - 1);
    expect(dropped(d.frame(SEC))).toBe(false);
    expect(dropped(d.frame(SEC))).toBe(false);
    expect(dropped(d.frame(2 * SEC - 1))).toBe(true);
  });
});

describe('stormControlArrive: hysteresis', () => {
  it('rise 3 fall 1: stays blocking while a whole window offers more than fall; one window at fall releases it', () => {
    const d = driver(port(['storm-control broadcast level pps 3 1']), MBPS10);
    for (let i = 0; i < 4; i++) d.frame(i);
    expect(d.state?.blocking).toBe(true);
    // window 1: 2 frames offered (both dropped), 2 > 1
    expect([d.frame(SEC), d.frame(SEC + 1)].map(dropped)).toEqual([true, true]);
    // window 2: blocked whole; 1 frame offered
    expect(dropped(d.frame(2 * SEC))).toBe(true);
    // window 3: the window before offered 1 ≤ 1 → forwarding; three frames pass, the fourth exceeds again
    expect([3, 3, 3, 3].map((s, i) => dropped(d.frame(s * SEC + i)))).toEqual([false, false, false, true]);
  });
  it('an empty window in between releases a blocked class (it offered 0 ≤ fall)', () => {
    const d = driver(port(['storm-control broadcast level pps 1 0']), MBPS10);
    d.frame(0);
    expect(dropped(d.frame(1))).toBe(true);
    expect(dropped(d.frame(2 * SEC))).toBe(false); // [1 s, 2 s) was empty
  });
  it('fall 0 with traffic every second never releases: dropped frames count as offered', () => {
    const d = driver(port(['storm-control broadcast level pps 1 0']), MBPS10);
    d.frame(0);
    d.frame(1);
    for (let s = 1; s <= 5; s++) expect(dropped(d.frame(s * SEC))).toBe(true);
  });
  it('level 0 drops every frame of the class', () => {
    const d = driver(port(['storm-control broadcast level 0']), MBPS100);
    expect(dropped(d.frame(0))).toBe(true);
  });
});

describe('stormControlArrive: percent and bps units', () => {
  it('level 0.02 of 10 Mbps is 2000 bits a second: three 64-byte frames pass, the fourth drops; current in hundredths', () => {
    const d = driver(port(['storm-control broadcast level 0.02']), MBPS10);
    expect([0, 1, 2, 3].map((t) => dropped(d.frame(t)))).toEqual([false, false, false, true]);
    // the row written at the exceedance keeps the last closed window's level (none yet: 0)
    expect(d.writes).toHaveLength(1);
    expect(d.writes[0]).toMatchObject({ state: 'blocking', current: 0, dropped: 1, windowStart: 0 });
    // closing [0, 1 s) (2048 bits = 0.02 %), which had drops; 2048 > fall 2000 keeps blocking
    d.frame(SEC);
    expect(d.writes).toHaveLength(2);
    expect(d.writes[1]).toMatchObject({ state: 'blocking', current: 2, dropped: 2, windowStart: SEC, unit: 'percent', rise: 2, fall: 2 });
  });
  it('the threshold follows the operational speed passed in', () => {
    const pc = port(['storm-control broadcast level 0.02']);
    const slow = driver(pc, 5_000_000); // 1000 bits: one 64-byte frame passes
    expect([0, 1].map((t) => dropped(slow.frame(t)))).toEqual([false, true]);
  });
  it('bps counts wire bits of the frame size (FCS included)', () => {
    const d = driver(port(['storm-control unicast level bps 12144']), MBPS100, 'unicast');
    expect(dropped(d.frame(0, 1518))).toBe(false);
    expect(dropped(d.frame(1, 64))).toBe(true);
  });
});

describe('stormControlArrive: actions', () => {
  it('action shutdown err-disables on the first exceedance with cause storm-control; the row says err-disabled', () => {
    const d = driver(port(['storm-control broadcast level pps 1', 'storm-control action shutdown']), MBPS10);
    expect(d.frame(0).errDisable).toBeUndefined();
    const s = d.frame(1);
    expect(s.errDisable).toEqual({ cause: 'storm-control', detail: 'broadcast traffic went above the storm-control rising level of 1 pps' });
    expect(s.row).toMatchObject({ state: 'err-disabled', action: 'shutdown', dropped: 1 });
    expect(s.log).toBeUndefined();
  });
  it('action trap logs once per exceedance (severity 3, STORM_CONTROL), never for later drops', () => {
    const d = driver(port(['storm-control broadcast level pps 1 1', 'storm-control action trap']), MBPS10);
    d.frame(0);
    const first = d.frame(1);
    expect(first.log).toEqual({ severity: 3, facility: STORM_CONTROL_LOG_FACILITY, message: `A broadcast storm was detected on ${FA1}: traffic went above 1 pps, and storm control is filtering the class.` });
    expect(first.errDisable).toBeUndefined();
    expect(d.frame(2).log).toBeUndefined();
    expect(d.frame(SEC).log).toBeUndefined(); // still blocking: no new exceedance
    d.frame(3 * SEC); // released after the empty window [2 s, 3 s)
    expect(d.frame(3 * SEC + 1).log).toBeDefined(); // a second exceedance logs again
    expect(d.steps.filter((s) => s.log !== undefined)).toHaveLength(2);
  });
  it('the plain drop action neither logs nor err-disables', () => {
    const d = driver(port(['storm-control broadcast level pps 1']), MBPS10);
    d.frame(0);
    const s = d.frame(1);
    expect(s.drop).toBeDefined();
    expect(s.log).toBeUndefined();
    expect(s.errDisable).toBeUndefined();
  });
});

describe('rows (rule 20)', () => {
  it('the row written at store or port-up: forwarding, current 0, dropped 0, windowStart = now (not aligned)', () => {
    const pc = port(['storm-control unicast level 50', 'storm-control broadcast level 1.00', 'storm-control action trap']);
    const now = 12 * SEC + 345;
    expect(stormControlRows(pc, now)).toEqual([
      { key: stormControlKey(FA1, 'broadcast'), port: FA1, kind: 'broadcast', unit: 'percent', rise: 100, fall: 100, current: 0, state: 'forwarding', action: 'trap', dropped: 0, windowStart: now, updatedAt: now },
      { key: `${FA1}|unicast`, port: FA1, kind: 'unicast', unit: 'percent', rise: 5000, fall: 5000, current: 0, state: 'forwarding', action: 'trap', dropped: 0, windowStart: now, updatedAt: now },
    ]);
  });
  it('no write for forwarded frames, nor for a closed window without drops or a state change', () => {
    const d = driver(port(['storm-control broadcast level pps 5']), MBPS10);
    for (let s = 0; s < 4; s++) for (let i = 0; i < 5; i++) d.frame(s * SEC + i);
    expect(d.writes).toHaveLength(0);
    expect(d.row).toBe(d.initial);
  });
  it('writes: the exceedance, each closed window with drops, and the release — never per frame', () => {
    const d = driver(port(['storm-control broadcast level pps 2 1']), MBPS10);
    for (let i = 0; i < 10; i++) d.frame(i); // 8 drops in window 0: one write (the state change)
    expect(d.writes.map((w) => [w.state, w.dropped, w.windowStart])).toEqual([['blocking', 1, 0]]);
    d.frame(SEC); // closes window 0 (had drops); still blocking
    for (let i = 1; i < 5; i++) d.frame(SEC + i);
    d.frame(3 * SEC); // closes window 1 (had drops) and releases ([2 s, 3 s) was empty): one write
    expect(d.writes.map((w) => [w.state, w.current, w.dropped, w.windowStart])).toEqual([
      ['blocking', 0, 1, 0],
      ['blocking', 10, 9, SEC],
      ['forwarding', 5, 13, 3 * SEC],
    ]);
    d.frame(4 * SEC); // window 3 had no drops: nothing written
    expect(d.writes).toHaveLength(3);
  });
  it('after traffic stops the row keeps its last values (lazy windows: no timer closes a window)', () => {
    const d = driver(port(['storm-control broadcast level pps 1']), MBPS10);
    d.frame(0);
    d.frame(1);
    const last = d.row;
    expect(last).toMatchObject({ state: 'blocking', dropped: 1 });
    // nothing else happens: the caller holds `last` until the next frame of the class
    expect(d.writes.at(-1)).toBe(last);
  });
  it('a fresh state after port-up starts from the re-written initial row', () => {
    const pc = port(['storm-control broadcast level pps 1', 'storm-control action shutdown']);
    const level = stormLevelFor(pc, 'broadcast')!;
    const row = stormControlRows(pc, 400 * SEC)[0]!;
    const s = stormControlArrive({ config: pc, level, speedBps: MBPS10, frameBytes: 64, now: 400 * SEC + 5, row });
    expect(s.drop).toBeUndefined();
    expect(s.row).toBeUndefined();
    expect(s.state).toEqual({ start: 400 * SEC, offered: 1, dropped: 0, blocking: false, total: 0, current: 0 });
  });
});
