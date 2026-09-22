// Packet colour by VLAN and the tagged-frame badge (ARCHITECTURE-P2 §6; W3 web-canvas): a tagged leg takes its
// outer VID, an untagged leg the from-port's access or native VLAN; "colour by flow" keeps precedence; the `Q` badge
// is the non-colour channel of "tagged".
import { describe, expect, it } from 'vitest';
import type { PduSummary } from '@netforge/engine';
import { vlanColor } from '../src/canvas/l2.js';
import { TAG_BADGE, flowColor, isTaggedLeg, legColor, legVlan, protoColor, tagBadgeOffset, vlanPacketColor } from '../src/canvas/packets.js';
import { PROTOCOL_VOCAB } from '../src/vocab/protocols.js';
import { TEST_THEME } from './canvas-fixtures.js';

const tagged: PduSummary = { id: 1, proto: 'icmpv4', size: 102, summary: 'echo', layers: ['ethernet', 'dot1q', 'ipv4', 'icmpv4'], vlan: 10 };
const untagged: PduSummary = { id: 2, proto: 'icmpv4', size: 98, summary: 'echo', layers: ['ethernet', 'ipv4', 'icmpv4'] };
const from = { device: 'sw1', port: 'Gi0/2' };

describe('the VLAN of a leg', () => {
  it('is the outer tag of a tagged frame, whatever the from-port sends untagged', () => {
    expect(legVlan(tagged, from, () => 99)).toBe(10);
    expect(legVlan(tagged, from)).toBe(10);
  });

  it('is the from-port untagged VLAN of an untagged frame, or nothing', () => {
    expect(legVlan(untagged, from, (f) => (f.port === 'Gi0/2' ? 20 : undefined))).toBe(20);
    expect(legVlan(untagged, { device: 'pc1', port: 'eth0' }, (f) => (f.port === 'Gi0/2' ? 20 : undefined))).toBeUndefined();
    expect(legVlan(untagged, from)).toBeUndefined();
  });

  it('tells a tagged leg from an untagged one', () => {
    expect(isTaggedLeg(tagged)).toBe(true);
    expect(isTaggedLeg(untagged)).toBe(false);
    expect(isTaggedLeg({ vlan: 1 })).toBe(true);
  });
});

describe('leg colour', () => {
  it('uses the VLAN tint while the overlay is on and the leg has a VLAN (capsule and chip agree)', () => {
    const c = legColor(tagged, 'icmpv4', TEST_THEME, { colourByFlow: false, vlan: 10, vlanColours: true });
    expect(c).toBe(vlanColor(10, TEST_THEME));
    expect(vlanPacketColor(10, TEST_THEME)).toBe(vlanColor(10, TEST_THEME));
    expect(c).not.toBe(protoColor('icmpv4', TEST_THEME));
  });

  it('falls back to the protocol colour with the overlay off or no VLAN known', () => {
    expect(legColor(tagged, 'icmpv4', TEST_THEME, { colourByFlow: false, vlan: 10, vlanColours: false })).toBe(protoColor('icmpv4', TEST_THEME));
    expect(legColor(untagged, 'icmpv4', TEST_THEME, { colourByFlow: false, vlan: undefined, vlanColours: true })).toBe(protoColor('icmpv4', TEST_THEME));
    expect(protoColor('icmpv4', TEST_THEME)).toBe(TEST_THEME[PROTOCOL_VOCAB.icmpv4.color]);
  });

  it('lets an explicit "colour by flow" beat the overlay tint', () => {
    const flow: PduSummary = { ...tagged, flow: 'icmp:1' };
    expect(legColor(flow, 'icmpv4', TEST_THEME, { colourByFlow: true, vlan: 10, vlanColours: true })).toBe(flowColor(flow, TEST_THEME));
  });
});

describe('the tag badge', () => {
  it('is the 802.1Q letter of the vocabulary, top-right of the capsule, outside the body', () => {
    expect(TAG_BADGE).toBe(PROTOCOL_VOCAB.dot1q.letter);
    const off = tagBadgeOffset(5, 1);
    expect(off.x).toBeGreaterThan(5);
    expect(off.y).toBeLessThan(-5);
    const far = tagBadgeOffset(5, 3);
    expect(far.y).toBeLessThan(off.y);
  });
});
