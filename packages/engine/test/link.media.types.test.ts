import { describe, expect, it } from 'vitest';
import { bssId, cellId, compareOrdinal, routeMedium, segmentId } from '../src/link/media/types.js';

describe('link/media/types routing and medium ids', () => {
  it('routes air and cell radios first, then radio links, segments and cables', () => {
    expect(routeMedium({ kind: 'wlan', role: 'wireless-bss' })).toBe('air');
    expect(routeMedium({ kind: 'wlan', role: 'wireless-client' })).toBe('air');
    expect(routeMedium({ kind: 'cellular', role: 'wireless-bss' })).toBe('cell');
    expect(routeMedium({ kind: 'cellular', role: 'cellular' })).toBe('cell');
    expect(routeMedium({ kind: 'radio', role: 'radio-ptp', linkKind: 'radio' })).toBe('radio');
    expect(routeMedium({ kind: 'ethernet', role: 'routed', linkKind: 'cable', inSegment: true })).toBe('segment');
    expect(routeMedium({ kind: 'ethernet', role: 'repeater', linkKind: 'cable', inSegment: true })).toBe('segment');
    expect(routeMedium({ kind: 'ethernet', role: 'routed', linkKind: 'cable' })).toBe('cable');
    expect(routeMedium({ kind: 'serial', role: 'wan' })).toBe('cable');
    // radio link wins over a segment flag
    expect(routeMedium({ kind: 'radio', role: 'radio-ptp', linkKind: 'radio', inSegment: true })).toBe('radio');
  });

  it('medium ids are deterministic', () => {
    expect(segmentId(['l_9', 'l_10', 'l_2'])).toBe('seg:l_10');
    expect(segmentId(['l_b'])).toBe('seg:l_b');
    expect(() => segmentId([])).toThrow(RangeError);
    expect(bssId({ device: 'd_ap', port: 'Wlan0' })).toBe('bss:d_ap/Wlan0');
    expect(cellId({ device: 'd_t', port: 'Cellular0' })).toBe('cell:d_t/Cellular0');
    expect(['b', 'a', 'B', 'aa'].sort(compareOrdinal)).toEqual(['B', 'a', 'aa', 'b']);
    expect(compareOrdinal('x', 'x')).toBe(0);
  });
});
