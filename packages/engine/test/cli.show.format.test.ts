/**
 * cli/format.ts — column tables, padding, uptime/duration/speed/byte renderings.
 */
import { describe, expect, it } from 'vitest';
import { fmtBps, fmtBytes, fmtDuration, fmtSince, fmtUptime, minutesBetween, padLeft, padRight, table } from '../src/cli/format.js';

const SEC = 1_000_000_000;

describe('cli/format', () => {
  it('padRight / padLeft pad but never truncate', () => {
    expect(padRight('ab', 4)).toBe('ab  ');
    expect(padRight('abcdef', 4)).toBe('abcdef');
    expect(padLeft('7', 3)).toBe('  7');
    expect(padLeft('1234', 3)).toBe('1234');
  });

  it('table aligns columns left with a 2-space gap and trims trailing blanks', () => {
    const out = table([
      ['Interface', 'IP address', 'Status'],
      ['GigabitEthernet0/0', '10.0.0.1', 'up'],
      ['Gi0/1', 'unassigned', 'admin down'],
    ]);
    expect(out.split('\n')).toEqual([
      'Interface           IP address  Status',
      'GigabitEthernet0/0  10.0.0.1    up',
      'Gi0/1               unassigned  admin down',
    ]);
    for (const line of out.split('\n')) expect(line).not.toMatch(/\s$/);
  });

  it('table honours gap, indent, right alignment, minWidths and ragged rows', () => {
    const out = table([['1', 'enable'], ['10', 'show ip route'], ['2']], { gap: 1, indent: '> ', align: ['right'], minWidths: [3] });
    expect(out.split('\n')).toEqual(['>   1 enable', '>  10 show ip route', '>   2']);
    expect(table([])).toBe('');
  });

  it('fmtUptime renders days/hours/minutes with singular forms and omits zeros', () => {
    const ns = (2 * 24 * 3600 + 3 * 3600 + 4 * 60) * SEC;
    expect(fmtUptime(ns)).toBe('2 days, 3 hours, 4 minutes');
    expect(fmtUptime((24 * 3600 + 3600 + 60) * SEC)).toBe('1 day, 1 hour, 1 minute');
    expect(fmtUptime(5 * 3600 * SEC)).toBe('5 hours');
    expect(fmtUptime(30 * SEC)).toBe('0 minutes');
    expect(fmtUptime(0)).toBe('0 minutes');
  });

  it('fmtDuration / fmtSince render HH:MM:SS and never', () => {
    expect(fmtDuration(0)).toBe('00:00:00');
    expect(fmtDuration(3 * SEC + 999_999_999)).toBe('00:00:03');
    expect(fmtDuration((25 * 3600 + 61) * SEC)).toBe('25:01:01');
    expect(fmtSince(undefined, 10 * SEC)).toBe('never');
    expect(fmtSince(4 * SEC, 10 * SEC)).toBe('00:00:06');
    expect(fmtSince(20 * SEC, 10 * SEC)).toBe('00:00:00');
  });

  it('fmtBps renders conventional link speeds', () => {
    expect(fmtBps(10_000_000)).toBe('10 Mb/s');
    expect(fmtBps(100_000_000)).toBe('100 Mb/s');
    expect(fmtBps(1_000_000_000)).toBe('1 Gb/s');
    expect(fmtBps(10_000_000_000)).toBe('10 Gb/s');
    expect(fmtBps(2_500_000_000)).toBe('2.5 Gb/s');
    expect(fmtBps(1_544_000)).toBe('1.5 Mb/s');
    expect(fmtBps(9600)).toBe('9.6 kb/s');
    expect(fmtBps(300)).toBe('300 b/s');
  });

  it('fmtBytes scales by 1024', () => {
    expect(fmtBytes(0)).toBe('0 bytes');
    expect(fmtBytes(512)).toBe('512 bytes');
    expect(fmtBytes(1536)).toBe('1.5 KB');
    expect(fmtBytes(2 * 1024 * 1024)).toBe('2.0 MB');
    expect(fmtBytes(3 * 1024 ** 3)).toBe('3.0 GB');
  });

  it('minutesBetween floors and clamps at zero', () => {
    expect(minutesBetween(0, 59 * SEC)).toBe(0);
    expect(minutesBetween(0, 60 * SEC)).toBe(1);
    expect(minutesBetween(0, 150 * SEC)).toBe(2);
    expect(minutesBetween(100 * SEC, 0)).toBe(0);
  });
});
