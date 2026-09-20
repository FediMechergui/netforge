/**
 * protocols/ip-upper.ts — the static L3 → L4 table (ARCHITECTURE-P1 §2 Demux, §4.2): IPv4 1/6/17, IPv6 58 (ND types
 * 133–137 per RFC 4861 go to nd), 6, 17; delivery only to daemons the model runs; ICMP fan-back by quoted protocol.
 */
import { describe, expect, it } from 'vitest';
import { defineModel } from '../src/device/catalog/define.js';
import {
  IPV4_UPPER,
  IPV6_UPPER,
  icmpErrorTarget,
  ipv4UpperEntry,
  ipv4UpperProcess,
  ipv6UpperProcess,
  runsProcess,
} from '../src/protocols/ip-upper.js';
import { NF_PC_INPUT } from './device.catalog.p0-inputs.js';

const p05 = defineModel(NF_PC_INPUT, 'P0.5');
const p1 = defineModel(NF_PC_INPUT, 'P1');
const all = { processes: ['icmpv4', 'icmpv6', 'nd', 'udp', 'tcp'] };

describe('ip-upper table', () => {
  it('maps IPv4 protocols 1, 6 and 17', () => {
    expect(IPV4_UPPER.map((e) => [e.protocol, e.process])).toEqual([[1, 'icmpv4'], [6, 'tcp'], [17, 'udp']]);
    expect(IPV6_UPPER.map((e) => [e.protocol, e.process])).toEqual([[6, 'tcp'], [17, 'udp'], [58, 'icmpv6']]);
    expect(ipv4UpperEntry(17)).toEqual({ protocol: 17, process: 'udp', label: 'udp' });
    expect(ipv4UpperEntry(89)).toBeUndefined();
    expect(Object.isFrozen(IPV4_UPPER)).toBe(true);
  });

  it('delivers only to daemons the device runs', () => {
    expect(runsProcess(p05, 'udp')).toBe(false);
    expect(ipv4UpperProcess(p05, 1)).toBe('icmpv4');
    expect(ipv4UpperProcess(p05, 17)).toBeUndefined();
    expect(ipv4UpperProcess(p05, 6)).toBeUndefined();
    expect(ipv4UpperProcess(p1, 17)).toBe('udp');
    expect(ipv4UpperProcess(p1, 6)).toBe('tcp');
    expect(ipv4UpperProcess(p1, 253)).toBeUndefined();
  });

  it('splits ICMPv6: types 133-137 go to nd, everything else to icmpv6', () => {
    expect(ipv6UpperProcess(all, 58, 128)).toBe('icmpv6');
    expect(ipv6UpperProcess(all, 58, 1)).toBe('icmpv6');
    for (const t of [133, 134, 135, 136, 137]) expect(ipv6UpperProcess(all, 58, t)).toBe('nd');
    expect(ipv6UpperProcess(all, 58, 138)).toBe('icmpv6');
    expect(ipv6UpperProcess(all, 17)).toBe('udp');
    expect(ipv6UpperProcess(all, 6)).toBe('tcp');
    expect(ipv6UpperProcess(all, 59)).toBeUndefined();
    expect(ipv6UpperProcess({ processes: ['icmpv6'] }, 58, 135)).toBeUndefined();
  });

  it('fans ICMP errors back by the quoted protocol', () => {
    expect(icmpErrorTarget(all, 17)).toBe('udp');
    expect(icmpErrorTarget(all, 6)).toBe('tcp');
    expect(icmpErrorTarget(all, 1)).toBeUndefined();
    expect(icmpErrorTarget(p05, 17)).toBeUndefined();
  });
});
