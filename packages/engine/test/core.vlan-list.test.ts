// core/vlan-list (ARCHITECTURE-P2 §2.2 SwitchportConfig.allowed, §3.2 step 5, §5.1 the allowed-list forms): one
// canonical text per VLAN set; parse, format, contains, add, remove, except (and intersect for PortL2View.active).
import { describe, expect, it } from 'vitest';
import { DEFAULT_SWITCHPORT, CONTROLLER_PORT_SWITCHPORT } from '../src/contracts/port.js';
import {
  VLAN_ID_MAX,
  VLAN_ID_MIN,
  VLAN_LIST_ALL,
  VLAN_LIST_NONE,
  canonicalVlanList,
  formatVlanList,
  formatVlanRanges,
  isVlanId,
  parseVlanList,
  parseVlanRanges,
  vlanListAdd,
  vlanListContains,
  vlanListExcept,
  vlanListIntersect,
  vlanListRemove,
  vlanListSize,
} from '../src/core/vlan-list.js';

describe('core/vlan-list: constants and ids', () => {
  it('pins the id range, the all/none texts and the contract defaults that use them', () => {
    expect([VLAN_ID_MIN, VLAN_ID_MAX]).toEqual([1, 4094]);
    expect(VLAN_LIST_ALL).toBe('1-4094');
    expect(VLAN_LIST_NONE).toBe('');
    // the switchport defaults carry the canonical "all" text
    expect(DEFAULT_SWITCHPORT.allowed).toBe(VLAN_LIST_ALL);
    expect(CONTROLLER_PORT_SWITCHPORT.allowed).toBe(VLAN_LIST_ALL);
    expect(canonicalVlanList(DEFAULT_SWITCHPORT.allowed)).toBe(DEFAULT_SWITCHPORT.allowed);
  });

  it('isVlanId accepts integers 1..4094 only', () => {
    expect([1, 99, 1002, 4094].map(isVlanId)).toEqual([true, true, true, true]);
    expect([0, 4095, -1, 10.5, Number.NaN].map(isVlanId)).toEqual([false, false, false, false, false]);
  });
});

describe('core/vlan-list: parse', () => {
  it('parses ids and ranges into ascending merged ranges', () => {
    expect(parseVlanRanges('10,20,30-35')).toEqual([[10, 10], [20, 20], [30, 35]]);
    expect(parseVlanRanges('30-35,10,20')).toEqual([[10, 10], [20, 20], [30, 35]]);
    // overlapping and adjacent items merge; duplicates vanish
    expect(parseVlanRanges('5-10,8-12,13,20,20')).toEqual([[5, 13], [20, 20]]);
    expect(parseVlanRanges('1-4094')).toEqual([[1, 4094]]);
    expect(parseVlanRanges(' 10 , 20 ')).toEqual([[10, 10], [20, 20]]);
    expect(parseVlanRanges('0010')).toEqual([[10, 10]]);
  });

  it('the empty text is the valid empty list', () => {
    expect(parseVlanRanges('')).toEqual([]);
    expect(parseVlanRanges('   ')).toEqual([]);
    expect(parseVlanList('')).toEqual([]);
  });

  it('rejects out-of-range ids, reversed ranges, empty items and stray characters', () => {
    for (const bad of ['0', '4095', '1-4095', '0-10', '20-10', '10,,20', '10,', ',10', 'a', '10-', '-10', '10 20', '10;20', '1.5', '10--20', '12345', 'all']) {
      expect(parseVlanRanges(bad), bad).toBeUndefined();
      expect(parseVlanList(bad), bad).toBeUndefined();
      expect(canonicalVlanList(bad), bad).toBeUndefined();
    }
  });

  it('parseVlanList expands to the ascending ids', () => {
    expect(parseVlanList('20,3-5,1')).toEqual([1, 3, 4, 5, 20]);
    expect(parseVlanList(VLAN_LIST_ALL)).toHaveLength(4094);
  });
});

describe('core/vlan-list: canonical format', () => {
  it('writes runs of three or more as a range and a run of two as two ids', () => {
    expect(formatVlanList([10, 11])).toBe('10,11');
    expect(formatVlanList([10, 11, 12])).toBe('10-12');
    expect(formatVlanList([1, 10, 20, 30, 99])).toBe('1,10,20,30,99');
    expect(formatVlanList([99, 1, 20, 10, 20])).toBe('1,10,20,99');
    expect(formatVlanList([])).toBe('');
    expect(formatVlanRanges([[30, 35], [10, 10], [20, 20]])).toBe('10,20,30-35');
    expect(formatVlanRanges([[1, 2], [3, 3], [7, 8]])).toBe('1-3,7,8');
  });

  it('canonical text round-trips and equal sets give equal text', () => {
    expect(canonicalVlanList('10,11,12,13')).toBe('10-13');
    expect(canonicalVlanList('13,12-13,10,11')).toBe('10-13');
    expect(canonicalVlanList('1,2')).toBe('1,2');
    expect(canonicalVlanList('1-2')).toBe('1,2');
    expect(canonicalVlanList('1-4094')).toBe(VLAN_LIST_ALL);
    for (const c of ['1,10,20,99', '10-12,14', '1,2,4-6', '4094', '']) expect(canonicalVlanList(c)).toBe(c);
  });

  it('refuses non-VLAN ids and bad ranges', () => {
    expect(() => formatVlanList([0])).toThrow(RangeError);
    expect(() => formatVlanList([4095])).toThrow(RangeError);
    expect(() => formatVlanList([1.5])).toThrow(RangeError);
    expect(() => formatVlanRanges([[5, 4]])).toThrow(RangeError);
  });
});

describe('core/vlan-list: contains', () => {
  it('answers membership for canonical and non-canonical text', () => {
    expect(vlanListContains('1,10,20,99', 10)).toBe(true);
    expect(vlanListContains('1,10,20,99', 30)).toBe(false);
    expect(vlanListContains('10-20', 10)).toBe(true);
    expect(vlanListContains('10-20', 20)).toBe(true);
    expect(vlanListContains('10-20', 21)).toBe(false);
    expect(vlanListContains('20,1-5', 3)).toBe(true);
    expect(vlanListContains(VLAN_LIST_ALL, 4094)).toBe(true);
    expect(vlanListContains(VLAN_LIST_NONE, 1)).toBe(false);
  });

  it('is total: false for a non-VLAN id or text that does not parse', () => {
    expect(vlanListContains(VLAN_LIST_ALL, 0)).toBe(false);
    expect(vlanListContains(VLAN_LIST_ALL, 4095)).toBe(false);
    expect(vlanListContains('garbage', 10)).toBe(false);
    expect(vlanListContains('10,,20', 10)).toBe(false);
  });
});

describe('core/vlan-list: the allowed-list keyword forms (§5.1)', () => {
  it('add resolves §3.2 step 5 to the canonical stored line', () => {
    expect(vlanListAdd('1,10,20,99', '30')).toBe('1,10,20,30,99');
    expect(vlanListAdd('10-12', '13-20')).toBe('10-20');
    expect(vlanListAdd('', '5')).toBe('5');
    expect(vlanListAdd(VLAN_LIST_ALL, '10')).toBe(VLAN_LIST_ALL);
  });

  it('remove takes VLANs out, splitting ranges', () => {
    expect(vlanListRemove(VLAN_LIST_ALL, '10')).toBe('1-9,11-4094');
    expect(vlanListRemove('1,10,20,30,99', '30')).toBe('1,10,20,99');
    expect(vlanListRemove('10-20', '10,20')).toBe('11-19');
    expect(vlanListRemove('10-20', '12-18')).toBe('10,11,19,20');
    expect(vlanListRemove('10,20', '30')).toBe('10,20');
    expect(vlanListRemove('10,20', '1-4094')).toBe('');
  });

  it('except is every VLAN but the given ones', () => {
    expect(vlanListExcept('10')).toBe('1-9,11-4094');
    expect(vlanListExcept('1')).toBe('2-4094');
    expect(vlanListExcept('4094')).toBe('1-4093');
    expect(vlanListExcept('1,2,4094')).toBe('3-4093');
    expect(vlanListExcept('')).toBe(VLAN_LIST_ALL);
    expect(vlanListExcept(VLAN_LIST_ALL)).toBe('');
  });

  it('intersect gives the VLANs allowed AND existing', () => {
    expect(vlanListIntersect(VLAN_LIST_ALL, '1,10,20')).toBe('1,10,20');
    expect(vlanListIntersect('1,10,20,99', '1,10,30')).toBe('1,10');
    expect(vlanListIntersect('5-15', '10-20')).toBe('10-15');
    expect(vlanListIntersect('5-15', '')).toBe('');
  });

  it('size counts VLANs', () => {
    expect(vlanListSize(VLAN_LIST_ALL)).toBe(4094);
    expect(vlanListSize('1,10-12')).toBe(4);
    expect(vlanListSize('')).toBe(0);
  });

  it('set operations refuse text that does not parse', () => {
    expect(() => vlanListAdd('10', 'x')).toThrow(RangeError);
    expect(() => vlanListRemove('0', '10')).toThrow(RangeError);
    expect(() => vlanListExcept('5000')).toThrow(RangeError);
    expect(() => vlanListIntersect('1', '2-1')).toThrow(RangeError);
    expect(() => vlanListSize('a')).toThrow(RangeError);
  });

  it('every result is canonical and agrees with a set model', () => {
    const lists = ['', '1', '1,2', '1-3', '10,20,30-35', '4090-4094', '2-4093', VLAN_LIST_ALL, '7,9,11-13,100-200'];
    const set = (t: string): Set<number> => new Set(parseVlanList(t)!);
    for (const a of lists) {
      for (const b of lists) {
        const sa = set(a);
        const sb = set(b);
        const add = vlanListAdd(a, b);
        const rem = vlanListRemove(a, b);
        const int = vlanListIntersect(a, b);
        expect(canonicalVlanList(add)).toBe(add);
        expect(canonicalVlanList(rem)).toBe(rem);
        expect(canonicalVlanList(int)).toBe(int);
        expect(add).toBe(formatVlanList([...sa, ...sb]));
        expect(rem).toBe(formatVlanList([...sa].filter((v) => !sb.has(v))));
        expect(int).toBe(formatVlanList([...sa].filter((v) => sb.has(v))));
      }
      const ex = vlanListExcept(a);
      expect(ex).toBe(vlanListRemove(VLAN_LIST_ALL, a));
      for (const v of [1, 2, 3, 7, 12, 150, 4093, 4094]) expect(vlanListContains(ex, v)).toBe(!vlanListContains(a, v));
    }
  });
});
