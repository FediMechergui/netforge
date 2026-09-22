// protocols/stp/{vector,cost,ids} (ARCHITECTURE-P2 §3.6 "Identities and costs", §3.7 step 7, §4.5, §5.1 the root
// macro): priority-vector order, the cost tables including the Port-channel recompute, bridge and port id text,
// and the configured-priority helper the root macro uses.
import { describe, expect, it } from 'vitest';
import { deviceMacBase, portMac } from '../src/contracts/addr.js';
import { SPEED_100M, SPEED_10G, SPEED_10M, SPEED_1G, SPEED_40G } from '../src/contracts/port.js';
import type { StpBridgeRow } from '../src/contracts/tables.js';
import { SEC } from '../src/contracts/time.js';
import {
  STP_CHANNEL_COSTS,
  STP_PORT_COSTS,
  channelPathCost,
  effectivePathCost,
  isStpCost,
  portPathCost,
} from '../src/protocols/stp/cost.js';
import {
  STP_BRIDGE_PRIORITY_MAX,
  STP_CHANNEL_PORT_BASE,
  STP_DEFAULT_BRIDGE_PRIORITY,
  STP_DEFAULT_PORT_PRIORITY,
  STP_ROOT_PRIMARY_PRIORITY,
  STP_ROOT_SECONDARY_PRIORITY,
  bridgeIdOf,
  bridgeIdText,
  configuredPriorityOf,
  extendedBridgePriority,
  isBridgePriority,
  isPortPriority,
  parseBridgeIdText,
  parsePortIdText,
  portIdParts,
  portIdText,
  portIdValue,
  rootMacroPriority,
  stpPortNumber,
  type BridgeId,
} from '../src/protocols/stp/ids.js';
import {
  STP_DEFAULT_TIMERS,
  STP_TIME_UNIT_NS,
  compareBridgeIds,
  comparePriorityVectors,
  designatedVector,
  isBetterVector,
  isSuperiorMessage,
  nsToStpUnits,
  secondsToStpUnits,
  stpUnitsToNs,
  type PriorityVector,
} from '../src/protocols/stp/vector.js';

const MAC_A = '02:00:00:00:00:0a';
const MAC_B = '02:00:00:00:00:0b';
const MAC_C = '02:00:00:00:01:00';
const bid = (priority: number, mac: string): BridgeId => ({ priority, mac });
const P = (n: number): number => portIdValue(STP_DEFAULT_PORT_PRIORITY, n);

describe('stp/ids: bridge ids', () => {
  it('priority = configured + VLAN (extended system id); text is `${priority}/${mac}`', () => {
    expect(STP_DEFAULT_BRIDGE_PRIORITY).toBe(32768);
    expect(extendedBridgePriority(32768, 1)).toBe(32769);
    expect(extendedBridgePriority(32768, 10)).toBe(32778);
    expect(extendedBridgePriority(4096, 1)).toBe(4097);
    expect(extendedBridgePriority(0, 4094)).toBe(4094);
    const base = portMac(deviceMacBase('d_0001'), 0);
    const id = bridgeIdOf(32768, 10, base);
    expect(id).toEqual({ priority: 32778, mac: base });
    expect(bridgeIdText(id)).toBe(`32778/${base}`);
    // the §2.6 example form
    expect(bridgeIdText(bridgeIdOf(32768, 10, '00:1F:00:0A:00:00'))).toBe('32778/00:1f:00:0a:00:00');
  });

  it('refuses priorities that are not multiples of 4096 in 0..61440 and VLANs outside the extension', () => {
    expect([0, 4096, 24576, 32768, 61440].map(isBridgePriority)).toEqual([true, true, true, true, true]);
    expect([1, 4095, 65536, 61441, -4096, 4096.5].map(isBridgePriority)).toEqual([false, false, false, false, false, false]);
    expect(STP_BRIDGE_PRIORITY_MAX).toBe(61440);
    expect(() => extendedBridgePriority(100, 1)).toThrow(RangeError);
    expect(() => extendedBridgePriority(32768, 4096)).toThrow(RangeError);
    expect(() => bridgeIdOf(32768, 1, 'not-a-mac')).toThrow(RangeError);
  });

  it('parses bridge id text back, canonicalising the MAC', () => {
    expect(parseBridgeIdText('32778/00:1f:00:0a:00:00')).toEqual({ priority: 32778, mac: '00:1f:00:0a:00:00' });
    expect(parseBridgeIdText('4097/001f.000a.0000')).toEqual({ priority: 4097, mac: '00:1f:00:0a:00:00' });
    for (const bad of ['', '32778', '32778/', '/00:1f:00:0a:00:00', '65536/00:1f:00:0a:00:00', 'x/00:1f:00:0a:00:00', '1/zz']) {
      expect(parseBridgeIdText(bad), bad).toBeUndefined();
    }
  });

  it('configured priority = bridge-id priority minus the VLAN (the root-macro comparison)', () => {
    expect(configuredPriorityOf('32778/00:1f:00:0a:00:00', 10)).toBe(32768);
    expect(configuredPriorityOf(bid(4097, MAC_A), 1)).toBe(4096);
    expect(configuredPriorityOf(bid(24586, MAC_A), 10)).toBe(24576);
    // an id carrying another VLAN (a native-VLAN mismatch): the top 4 bits of the field
    expect(configuredPriorityOf(bid(32769, MAC_A), 99)).toBe(32768);
    expect(() => configuredPriorityOf('garbage', 1)).toThrow(RangeError);
  });
});

describe('stp/ids: the root macro (§5.1)', () => {
  const row = (vlan: number, bridge: string, root: string, isRoot: boolean): Pick<StpBridgeRow, 'vlan' | 'bridgeId' | 'rootId' | 'isRoot'> => ({ vlan, bridgeId: bridge, rootId: root, isRoot });

  it('secondary always stores 28672', () => {
    expect(STP_ROOT_SECONDARY_PRIORITY).toBe(28672);
    expect(rootMacroPriority('secondary', row(10, `32778/${MAC_B}`, `32778/${MAC_A}`, false))).toEqual({ kind: 'store', priority: 28672 });
    expect(rootMacroPriority('secondary', row(10, `32778/${MAC_A}`, `32778/${MAC_A}`, true))).toEqual({ kind: 'store', priority: 28672 });
  });

  it('primary stores 24576 when the root is configured above it', () => {
    expect(STP_ROOT_PRIMARY_PRIORITY).toBe(24576);
    expect(rootMacroPriority('primary', row(10, `32778/${MAC_B}`, `32778/${MAC_A}`, false))).toEqual({ kind: 'store', priority: 24576 });
    expect(rootMacroPriority('primary', row(1, `32769/${MAC_B}`, `28673/${MAC_A}`, false))).toEqual({ kind: 'store', priority: 24576 });
  });

  it('primary undercuts a root at 24576 or below by 4096, breaking a tie with a lower-MAC root', () => {
    // the tie case: the root is already at 24576 (+ VLAN) with a lower MAC than ours
    expect(rootMacroPriority('primary', row(10, `32778/${MAC_B}`, `24586/${MAC_A}`, false))).toEqual({ kind: 'store', priority: 20480 });
    expect(rootMacroPriority('primary', row(1, `32769/${MAC_B}`, `4097/${MAC_A}`, false))).toEqual({ kind: 'store', priority: 0 });
  });

  it('primary refuses when it would need a priority below 0', () => {
    expect(rootMacroPriority('primary', row(1, `32769/${MAC_B}`, `1/${MAC_A}`, false))).toEqual({ kind: 'exhausted' });
  });

  it('primary on the root stores 24576 unless its own priority is already lower', () => {
    expect(rootMacroPriority('primary', row(10, `32778/${MAC_A}`, `32778/${MAC_A}`, true))).toEqual({ kind: 'store', priority: 24576 });
    expect(rootMacroPriority('primary', row(10, `24586/${MAC_A}`, `24586/${MAC_A}`, true))).toEqual({ kind: 'store', priority: 24576 });
    expect(rootMacroPriority('primary', row(10, `4106/${MAC_A}`, `4106/${MAC_A}`, true))).toEqual({ kind: 'keep' });
  });
});

describe('stp/ids: port ids', () => {
  it('port number = ordinal, or 1024 + n for Port-channel n', () => {
    expect(STP_CHANNEL_PORT_BASE).toBe(1024);
    expect(stpPortNumber('FastEthernet0/1', 1)).toBe(1);
    expect(stpPortNumber('GigabitEthernet0/2', 26)).toBe(26);
    expect(stpPortNumber('Port-channel1', 0)).toBe(1025);
    expect(stpPortNumber('Port-channel48', 0)).toBe(1072);
    expect(() => stpPortNumber('Vlan1', 0)).toThrow(RangeError);
  });

  it('value = priority in the top 4 bits, number in the low 12; text `${priority}.${number}`', () => {
    expect(portIdValue(128, 1)).toBe(0x8001);
    expect(portIdValue(0, 1025)).toBe(0x0401);
    expect(portIdValue(240, 4095)).toBe(0xffff);
    expect(portIdParts(0x8001)).toEqual({ priority: 128, number: 1 });
    expect(portIdParts(0x1401)).toEqual({ priority: 16, number: 1025 });
    expect(portIdText(128, 1)).toBe('128.1');
    expect(portIdText(64, 1025)).toBe('64.1025');
    expect(parsePortIdText('128.1')).toBe(0x8001);
    expect(parsePortIdText('64.1025')).toBe(portIdValue(64, 1025));
    for (const bad of ['', '128', '128.', '127.1', '256.1', '128.4096', 'a.1', '128.1.1']) expect(parsePortIdText(bad), bad).toBeUndefined();
    expect([0, 16, 128, 240].map(isPortPriority)).toEqual([true, true, true, true]);
    expect([8, 256, -16, 129].map(isPortPriority)).toEqual([false, false, false, false]);
    expect(() => portIdValue(100, 1)).toThrow(RangeError);
    expect(() => portIdValue(128, 4096)).toThrow(RangeError);
    expect(() => portIdText(128, -1)).toThrow(RangeError);
  });

  it('a lower port priority beats a lower port number; equal priority falls back to the number', () => {
    expect(portIdValue(64, 24)).toBeLessThan(portIdValue(128, 1));
    expect(portIdValue(128, 1)).toBeLessThan(portIdValue(128, 2));
    expect(portIdValue(128, 26)).toBeLessThan(portIdValue(128, 1025));
  });
});

describe('stp/cost: path costs', () => {
  it('short method by negotiated speed (§3.6)', () => {
    expect(portPathCost(SPEED_40G)).toBe(2);
    expect(portPathCost(SPEED_10G)).toBe(2);
    expect(portPathCost(SPEED_1G)).toBe(4);
    expect(portPathCost(SPEED_100M)).toBe(19);
    expect(portPathCost(SPEED_10M)).toBe(100);
    expect(portPathCost(undefined)).toBe(100);
    expect(portPathCost(0)).toBe(100);
    expect(STP_PORT_COSTS.map((r) => r.cost)).toEqual([2, 4, 19, 100]);
  });

  it('a Port-channel costs by the aggregate bandwidth of its bundled members, recomputed as members change', () => {
    expect(channelPathCost([SPEED_1G, SPEED_1G])).toBe(3);
    // one member lost: 3 -> 4 (§3.6, §3.7 step 7)
    expect(channelPathCost([SPEED_1G])).toBe(4);
    expect(channelPathCost([SPEED_100M, SPEED_100M])).toBe(12);
    expect(channelPathCost([SPEED_100M, SPEED_100M, SPEED_100M])).toBe(9);
    expect(channelPathCost([SPEED_100M, SPEED_100M, SPEED_100M, SPEED_100M])).toBe(8);
    expect(channelPathCost(Array(8).fill(SPEED_1G))).toBe(3);
    expect(channelPathCost([SPEED_10G, SPEED_10G])).toBe(2);
    expect(channelPathCost([SPEED_10M, SPEED_10M])).toBe(56);
    expect(channelPathCost([SPEED_10M, SPEED_10M, SPEED_10M, SPEED_10M])).toBe(39);
    expect(channelPathCost([])).toBeUndefined();
  });

  it('a single bundled member costs what the same port costs alone, at every NF speed', () => {
    for (const s of [SPEED_10M, SPEED_100M, SPEED_1G, SPEED_10G, SPEED_40G]) expect(channelPathCost([s])).toBe(portPathCost(s));
  });

  it('the channel table falls monotonically and a bundle never costs more than one of its members', () => {
    for (let i = 1; i < STP_CHANNEL_COSTS.length; i++) {
      expect(STP_CHANNEL_COSTS[i]!.minBps).toBeLessThan(STP_CHANNEL_COSTS[i - 1]!.minBps);
      expect(STP_CHANNEL_COSTS[i]!.cost).toBeGreaterThan(STP_CHANNEL_COSTS[i - 1]!.cost);
    }
    for (const s of [SPEED_10M, SPEED_100M, SPEED_1G, SPEED_10G]) {
      for (let n = 2; n <= 8; n++) expect(channelPathCost(Array(n).fill(s))!).toBeLessThanOrEqual(portPathCost(s));
    }
  });

  it('overrides: per-VLAN over interface over computed', () => {
    expect(effectivePathCost(19)).toBe(19);
    expect(effectivePathCost(19, { port: 5 })).toBe(5);
    expect(effectivePathCost(19, { port: 5, vlan: 7 })).toBe(7);
    expect(effectivePathCost(19, { vlan: 7 })).toBe(7);
    expect([1, 19, 200_000_000].map(isStpCost)).toEqual([true, true, true]);
    expect([0, 200_000_001, 1.5].map(isStpCost)).toEqual([false, false, false]);
  });
});

describe('stp/vector: priority-vector order (802.1D)', () => {
  const v = (root: BridgeId, cost: number, bridge: BridgeId, port: number, recv?: number): PriorityVector =>
    recv === undefined ? designatedVector(root, cost, bridge, port) : { ...designatedVector(root, cost, bridge, port), receivingPortId: recv };

  it('bridge ids compare by priority, then by MAC as a number', () => {
    expect(compareBridgeIds(bid(4097, MAC_B), bid(32769, MAC_A))).toBeLessThan(0);
    expect(compareBridgeIds(bid(32769, MAC_A), bid(32769, MAC_B))).toBeLessThan(0);
    expect(compareBridgeIds(bid(32769, MAC_C), bid(32769, MAC_B))).toBeGreaterThan(0);
    expect(compareBridgeIds(bid(32769, MAC_A), bid(32769, MAC_A))).toBe(0);
  });

  it('compares root id, then root cost, then designated bridge, then designated port, then receiving port', () => {
    const root1 = bid(4097, MAC_C);
    const root2 = bid(32769, MAC_A);
    // root id first, whatever the cost
    expect(comparePriorityVectors(v(root1, 100, root2, P(1)), v(root2, 0, root2, P(1)))).toBeLessThan(0);
    // then root path cost
    expect(comparePriorityVectors(v(root1, 4, bid(32769, MAC_B), P(9)), v(root1, 8, bid(32769, MAC_A), P(1)))).toBeLessThan(0);
    // then designated bridge id
    expect(comparePriorityVectors(v(root1, 4, bid(32769, MAC_A), P(9)), v(root1, 4, bid(32769, MAC_B), P(1)))).toBeLessThan(0);
    // then designated port id
    expect(comparePriorityVectors(v(root1, 4, bid(32769, MAC_A), P(1)), v(root1, 4, bid(32769, MAC_A), P(2)))).toBeLessThan(0);
    expect(comparePriorityVectors(v(root1, 4, bid(32769, MAC_A), portIdValue(64, 2)), v(root1, 4, bid(32769, MAC_A), P(1)))).toBeLessThan(0);
    // then the receiving port (two ports of one bridge hearing one designated port)
    expect(comparePriorityVectors(v(root1, 4, bid(32769, MAC_A), P(1), P(3)), v(root1, 4, bid(32769, MAC_A), P(1), P(5)))).toBeLessThan(0);
    // a vector without a receiving port compares equal on it
    expect(comparePriorityVectors(v(root1, 4, bid(32769, MAC_A), P(1)), v(root1, 4, bid(32769, MAC_A), P(1), P(5)))).toBe(0);
    expect(isBetterVector(v(root1, 4, bid(32769, MAC_A), P(1)), v(root1, 4, bid(32769, MAC_A), P(1)))).toBe(false);
  });

  it('the §3.6 triangle: SW1 (priority 4096) is root; on SW2–SW3 the lower bridge id is designated', () => {
    const sw1 = bridgeIdOf(4096, 1, '02:00:00:00:00:03');
    const sw2 = bridgeIdOf(32768, 1, '02:00:00:00:00:01');
    const sw3 = bridgeIdOf(32768, 1, '02:00:00:00:00:02');
    // every bridge first claims root; SW1's claim is superior everywhere
    expect(isBetterVector(designatedVector(sw1, 0, sw1, P(1)), designatedVector(sw2, 0, sw2, P(1)))).toBe(true);
    expect(isBetterVector(designatedVector(sw1, 0, sw1, P(2)), designatedVector(sw3, 0, sw3, P(1)))).toBe(true);
    // on the SW2–SW3 link both offer root SW1 at cost 4; SW2 (lower MAC) wins the designated role
    const fromSw2 = designatedVector(sw1, 4, sw2, P(2));
    const fromSw3 = designatedVector(sw1, 4, sw3, P(2));
    expect(comparePriorityVectors(fromSw2, fromSw3)).toBeLessThan(0);
    // SW3's root port is its link to SW1 (cost 0 + 4 beats cost 4 + 4 via SW2)
    expect(isBetterVector(designatedVector(sw1, 0, sw1, P(2)), fromSw2)).toBe(true);
  });

  it('a superior message replaces stored information: better, or from the same designated bridge and port', () => {
    const root = bid(4097, MAC_A);
    const stored = designatedVector(root, 4, bid(32769, MAC_B), P(2));
    expect(isSuperiorMessage(designatedVector(root, 0, bid(32769, MAC_C), P(9)), stored)).toBe(true);
    // worse, but from the same transmitter (same MAC and port number): accepted (§17.6)
    const worse = designatedVector(bid(32769, MAC_B), 0, bid(32769, MAC_B), P(2));
    expect(isSuperiorMessage(worse, stored)).toBe(true);
    // same transmitter even with another port priority or bridge priority
    expect(isSuperiorMessage(designatedVector(root, 8, bid(28673, MAC_B), portIdValue(64, 2)), stored)).toBe(true);
    // worse and from another port or another bridge: rejected
    expect(isSuperiorMessage(designatedVector(root, 8, bid(32769, MAC_B), P(3)), stored)).toBe(false);
    expect(isSuperiorMessage(designatedVector(root, 8, bid(32769, MAC_C), P(2)), stored)).toBe(false);
    // equal is not superior unless it is the same transmitter
    expect(isSuperiorMessage(stored, stored)).toBe(true);
    // no stored information: anything is accepted
    expect(isSuperiorMessage(worse, undefined)).toBe(true);
  });
});

describe('stp/vector: BPDU time units (§4.5)', () => {
  it('converts 1/256 s units exactly', () => {
    expect(STP_TIME_UNIT_NS * 256).toBe(SEC);
    expect(secondsToStpUnits(15)).toBe(3840);
    expect(secondsToStpUnits(20)).toBe(5120);
    expect(secondsToStpUnits(2)).toBe(512);
    expect(stpUnitsToNs(3840)).toBe(15 * SEC);
    expect(nsToStpUnits(15 * SEC)).toBe(3840);
    expect(nsToStpUnits(stpUnitsToNs(1))).toBe(1);
    expect(nsToStpUnits(STP_TIME_UNIT_NS - 1)).toBe(0);
    expect(nsToStpUnits(10_000 * SEC)).toBe(0xffff);
    expect(STP_DEFAULT_TIMERS).toEqual({ helloS: 2, maxAgeS: 20, forwardDelayS: 15 });
    for (let u = 0; u <= 0xffff; u += 257) expect(nsToStpUnits(stpUnitsToNs(u))).toBe(u);
  });

  it('refuses out-of-range or fractional times', () => {
    expect(() => stpUnitsToNs(-1)).toThrow(RangeError);
    expect(() => stpUnitsToNs(0x10000)).toThrow(RangeError);
    expect(() => stpUnitsToNs(1.5)).toThrow(RangeError);
    expect(() => nsToStpUnits(-1)).toThrow(RangeError);
    expect(() => secondsToStpUnits(256)).toThrow(RangeError);
  });
});
