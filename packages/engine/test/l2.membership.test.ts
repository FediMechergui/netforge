/**
 * W1 l2 (ARCHITECTURE-P2 D5, §3.0 steps 4, 11, 12; §3.1, §3.2): VLAN membership of bridged ports.
 *  - the `carries` table (access, trunk, native, allowed list, existence, the controller tunnel, dynamic oper modes);
 *  - the `classify` table with every drop detail, including the native VLAN outside the allowed list (#17);
 *  - tag normalisation toward ports and toward the SVI target (always untagged, cause `interface Vlan<V>`, #16).
 */
import { describe, expect, it } from 'vitest';
import type { FieldValue, LayerView, PduView } from '../src/contracts/pdu.js';
import { CONTROLLER_PORT_SWITCHPORT, DEFAULT_SWITCHPORT } from '../src/contracts/port.js';
import type { SwitchportConfig } from '../src/contracts/port.js';
import type { PortId } from '../src/contracts/ids.js';
import { vlanKey } from '../src/contracts/tables.js';
import {
  CAUSE_CONTROLLER_TUNNEL,
  CAUSE_NEGOTIATED_TRUNK,
  carries,
  carryCause,
  channelOperOf,
  classify,
  frameVlanTag,
  isImplicitVlan,
  isTaggedFrame,
  normaliseForPort,
  normaliseForSvi,
  operOf,
  sviName,
  vlanOfSviName,
  tagChange,
  vlanExistsIn,
} from '../src/protocols/l2/membership.js';
import type { L2PortView, VlanExistsFn } from '../src/protocols/l2/membership.js';

function layer(proto: string, fields: Record<string, FieldValue>): LayerView {
  return { proto, offset: 0, length: 0, headerLength: 0, fields, fieldRanges: {} };
}
function frame(...layers: LayerView[]): Pick<PduView, 'layers'> {
  return { layers };
}

/** VLANs 1, 1002–1005 implicitly, plus 10, 20, 99 (the §3.2 setup). */
const EXISTS: VlanExistsFn = vlanExistsIn({ has: (k: string) => ['10', '20', '99'].includes(k) });

function sw(port: PortId, config: Partial<SwitchportConfig>, oper: 'access' | 'trunk'): L2PortView {
  return { port, config: { ...DEFAULT_SWITCHPORT, ...config }, oper };
}

const ACCESS10 = sw('FastEthernet0/1', { mode: 'access', accessVlan: 10 }, 'access');
const ACCESS1 = sw('FastEthernet0/3', {}, 'access');
const TRUNK = sw('GigabitEthernet0/1', { mode: 'trunk', nativeVlan: 99, allowed: '1,10,20,99' }, 'trunk');
const TRUNK_NATIVE_OUT = sw('GigabitEthernet0/1', { mode: 'trunk', nativeVlan: 99, allowed: '10,20' }, 'trunk');
const TUNNEL: L2PortView = { port: 'Capwap0', config: CONTROLLER_PORT_SWITCHPORT, oper: 'trunk', role: 'wlan-tunnel' };

describe('VLAN existence', () => {
  it('VLAN 1 and 1002–1005 exist implicitly; others need a vlans row', () => {
    expect([1, 2, 1001, 1002, 1005, 1006, 4094].map(isImplicitVlan)).toEqual([true, false, false, true, true, false, false]);
    const exists = vlanExistsIn(undefined);
    expect([1, 10, 1003].map(exists)).toEqual([true, false, true]);
    expect([1, 10, 20, 30, 99].map(EXISTS)).toEqual([true, true, true, false, true]);
    expect(vlanKey(10)).toBe('10');
  });
});

describe('carries (§3.0)', () => {
  it('access: untagged in its access VLAN only', () => {
    expect(carries(ACCESS10, 10, EXISTS)).toBe('untagged');
    expect(carries(ACCESS10, 1, EXISTS)).toBeUndefined();
    expect(carries(ACCESS10, 20, EXISTS)).toBeUndefined();
    expect(carries(ACCESS1, 1, EXISTS)).toBe('untagged');
  });

  it('trunk: allowed and existing VLANs, native untagged, the rest tagged', () => {
    expect([1, 10, 20, 99, 30, 2].map((v) => carries(TRUNK, v, EXISTS))).toEqual(['tagged', 'tagged', 'tagged', 'untagged', undefined, undefined]);
    // allowed but missing → not carried
    const all = sw('GigabitEthernet0/2', { mode: 'trunk' }, 'trunk');
    expect(carries(all, 30, EXISTS)).toBeUndefined();
    expect(carries(all, 1, EXISTS)).toBe('untagged');
    expect(carries(all, 1002, EXISTS)).toBe('tagged');
  });

  it('a native VLAN that is not allowed is not carried at all (#17)', () => {
    expect(carries(TRUNK_NATIVE_OUT, 99, EXISTS)).toBeUndefined();
    expect(carries(TRUNK_NATIVE_OUT, 10, EXISTS)).toBe('tagged');
    expect(carries(TRUNK_NATIVE_OUT, 1, EXISTS)).toBeUndefined();
  });

  it('the oper mode decides, not the admin mode: a dynamic port is access until negotiated', () => {
    const auto = { port: 'GigabitEthernet0/3', config: DEFAULT_SWITCHPORT } as const;
    expect(carries({ ...auto, oper: operOf(DEFAULT_SWITCHPORT) }, 1, EXISTS)).toBe('untagged');
    expect(carries({ ...auto, oper: operOf(DEFAULT_SWITCHPORT) }, 10, EXISTS)).toBeUndefined();
    expect(carries({ ...auto, oper: operOf(DEFAULT_SWITCHPORT, { oper: 'trunk' }) }, 10, EXISTS)).toBe('tagged');
  });

  it('the controller tunnel (Capwap0) carries every existing VLAN tagged; a distribution port is an all-VLAN trunk', () => {
    expect([1, 10, 99, 30].map((v) => carries(TUNNEL, v, EXISTS))).toEqual(['tagged', 'tagged', 'tagged', undefined]);
    const dist: L2PortView = { port: 'GigabitEthernet0/1', config: CONTROLLER_PORT_SWITCHPORT, oper: operOf(CONTROLLER_PORT_SWITCHPORT) };
    expect([1, 10, 30].map((v) => carries(dist, v, EXISTS))).toEqual(['untagged', 'tagged', undefined]);
  });
});

describe('classify (§3.0 step 4)', () => {
  it('untagged or VID 0 on an access port → its access VLAN', () => {
    expect(classify(ACCESS10, undefined, EXISTS)).toEqual({ ok: true, vlan: 10 });
    expect(classify(ACCESS10, 0, EXISTS)).toEqual({ ok: true, vlan: 10 });
  });

  it('a tagged frame on an access port is filtered (§3.1 step 5)', () => {
    expect(classify(ACCESS10, 20, EXISTS)).toEqual({
      ok: false, reason: 'vlan-filtered', detail: 'tagged frame for VLAN 20 on an access port (access VLAN 10)',
    });
    expect(classify(ACCESS10, 10, EXISTS)).toEqual({
      ok: false, reason: 'vlan-filtered', detail: 'tagged frame for VLAN 10 on an access port (access VLAN 10)',
    });
  });

  it('trunk: untagged → the native VLAN; tagged allowed → its VLAN; a tagged native VLAN is accepted', () => {
    expect(classify(TRUNK, undefined, EXISTS)).toEqual({ ok: true, vlan: 99 });
    expect(classify(TRUNK, 0, EXISTS)).toEqual({ ok: true, vlan: 99 });
    expect(classify(TRUNK, 10, EXISTS)).toEqual({ ok: true, vlan: 10 });
    expect(classify(TRUNK, 99, EXISTS)).toEqual({ ok: true, vlan: 99 });
    expect(classify(TRUNK, 1, EXISTS)).toEqual({ ok: true, vlan: 1 });
  });

  it('trunk: a VLAN outside the allowed list is filtered (§3.2 step 5)', () => {
    expect(classify(TRUNK, 30, EXISTS)).toEqual({
      ok: false, reason: 'vlan-filtered', detail: 'VLAN 30 is not allowed on GigabitEthernet0/1',
    });
  });

  it('trunk: with the native VLAN outside the allowed list untagged frames are filtered (§3.2 step 4, #17)', () => {
    expect(classify(TRUNK_NATIVE_OUT, undefined, EXISTS)).toEqual({
      ok: false, reason: 'vlan-filtered', detail: 'native VLAN 99 is not allowed on GigabitEthernet0/1',
    });
    expect(classify(TRUNK_NATIVE_OUT, 99, EXISTS)).toEqual({
      ok: false, reason: 'vlan-filtered', detail: 'VLAN 99 is not allowed on GigabitEthernet0/1',
    });
    expect(classify(TRUNK_NATIVE_OUT, 20, EXISTS)).toEqual({ ok: true, vlan: 20 });
  });

  it('a VLAN that does not exist is filtered after membership (§3.1 step 6)', () => {
    const access30 = sw('FastEthernet0/1', { mode: 'access', accessVlan: 30 }, 'access');
    expect(classify(access30, undefined, EXISTS)).toEqual({ ok: false, reason: 'vlan-filtered', detail: 'VLAN 30 does not exist' });
    const all = sw('GigabitEthernet0/2', { mode: 'trunk' }, 'trunk');
    expect(classify(all, 30, EXISTS)).toEqual({ ok: false, reason: 'vlan-filtered', detail: 'VLAN 30 does not exist' });
    expect(classify(all, 4094, EXISTS)).toEqual({ ok: false, reason: 'vlan-filtered', detail: 'VLAN 4094 does not exist' });
  });

  it('the controller tunnel accepts only tagged frames of existing VLANs', () => {
    expect(classify(TUNNEL, 20, EXISTS)).toEqual({ ok: true, vlan: 20 });
    expect(classify(TUNNEL, 30, EXISTS)).toEqual({ ok: false, reason: 'vlan-filtered', detail: 'VLAN 30 does not exist' });
    expect(classify(TUNNEL, undefined, EXISTS)).toEqual({
      ok: false, reason: 'vlan-filtered', detail: 'untagged frame on Capwap0, which carries tagged VLANs only',
    });
  });

  it('classify then carries: an accepted VLAN is carried by the ingress port', () => {
    for (const view of [ACCESS10, ACCESS1, TRUNK]) {
      for (const tag of [undefined, 0, 1, 10, 20, 99]) {
        const r = classify(view, tag, EXISTS);
        if (r.ok) expect(carries(view, r.vlan, EXISTS)).toBeDefined();
      }
    }
  });
});

describe('oper modes', () => {
  it('operOf: static modes as configured, dynamic modes from the dtp row (access until negotiated)', () => {
    const c = (mode: SwitchportConfig['mode']): SwitchportConfig => ({ ...DEFAULT_SWITCHPORT, mode });
    expect(operOf(c('access'), { oper: 'trunk' })).toBe('access');
    expect(operOf(c('trunk'))).toBe('trunk');
    expect(operOf(c('dynamic-auto'))).toBe('access');
    expect(operOf(c('dynamic-desirable'), { oper: 'access' })).toBe('access');
    expect(operOf(c('dynamic-desirable'), { oper: 'trunk' })).toBe('trunk');
  });

  it('channelOperOf: the common oper mode of the bundled members (§3.0 step 4, #32)', () => {
    const dyn: SwitchportConfig = { ...DEFAULT_SWITCHPORT, mode: 'dynamic-desirable' };
    expect(channelOperOf(dyn, [{ oper: 'trunk' }, { oper: 'trunk' }])).toBe('trunk');
    expect(channelOperOf(dyn, [{ oper: 'trunk' }, { oper: 'access' }])).toBe('access');
    expect(channelOperOf(dyn, [{ oper: 'trunk' }, undefined])).toBe('access');
    expect(channelOperOf(dyn, [])).toBe('access');
    expect(channelOperOf({ ...DEFAULT_SWITCHPORT, mode: 'trunk' }, [])).toBe('trunk');
    expect(channelOperOf({ ...DEFAULT_SWITCHPORT, mode: 'access' }, [{ oper: 'trunk' }])).toBe('access');
  });
});

describe('tag normalisation (§3.0 step 12)', () => {
  it('tagChange covers the four cases', () => {
    expect(tagChange(false, 'tagged')).toBe('push');
    expect(tagChange(true, 'tagged')).toBe('none');
    expect(tagChange(true, 'untagged')).toBe('pop');
    expect(tagChange(false, 'untagged')).toBe('none');
  });

  it('toward a trunk: push with the cause of the line that makes it carry the VLAN (§3.2 step 2)', () => {
    expect(normaliseForPort(TRUNK, 10, false, EXISTS)).toEqual({ want: 'tagged', change: 'push', cause: 'switchport mode trunk' });
    expect(normaliseForPort(TRUNK, 10, true, EXISTS)).toEqual({ want: 'tagged', change: 'none', cause: 'switchport mode trunk' });
    expect(normaliseForPort(TRUNK, 99, true, EXISTS)).toEqual({ want: 'untagged', change: 'pop', cause: 'switchport trunk native vlan 99' });
    const negotiated = sw('GigabitEthernet0/2', { mode: 'dynamic-desirable' }, 'trunk');
    expect(normaliseForPort(negotiated, 10, false, EXISTS)).toEqual({ want: 'tagged', change: 'push', cause: CAUSE_NEGOTIATED_TRUNK });
    expect(CAUSE_NEGOTIATED_TRUNK).toBe('negotiated trunk');
  });

  it('toward an access port: pop with `switchport access vlan <V>` (§3.2 step 3); not carried → undefined', () => {
    expect(normaliseForPort(ACCESS10, 10, true, EXISTS)).toEqual({ want: 'untagged', change: 'pop', cause: 'switchport access vlan 10' });
    expect(normaliseForPort(ACCESS10, 10, false, EXISTS)).toEqual({ want: 'untagged', change: 'none', cause: 'switchport access vlan 10' });
    expect(normaliseForPort(ACCESS10, 20, false, EXISTS)).toBeUndefined();
    expect(normaliseForPort(ACCESS1, 1, false, EXISTS)?.cause).toBe('switchport access vlan 1');
  });

  it('toward the controller tunnel: tagged, cause `controller tunnel`', () => {
    expect(normaliseForPort(TUNNEL, 20, false, EXISTS)).toEqual({ want: 'tagged', change: 'push', cause: CAUSE_CONTROLLER_TUNNEL });
    expect(carryCause(TUNNEL, 20, 'tagged')).toBe('controller tunnel');
  });

  it('the SVI target always wants untagged, cause `interface Vlan<V>` (#16)', () => {
    expect(normaliseForSvi(10, true)).toEqual({ want: 'untagged', change: 'pop', cause: 'interface Vlan10' });
    expect(normaliseForSvi(10, false)).toEqual({ want: 'untagged', change: 'none', cause: 'interface Vlan10' });
    // a broadcast arriving tagged on a trunk is classified, then handed to Vlan<V> popped
    const f = frame(layer('ethernet', { dst: 'ff:ff:ff:ff:ff:ff', type: 0x8100 }), layer('dot1q', { vid: 10, type: 0x0806 }));
    const r = classify(TRUNK, frameVlanTag(f), EXISTS);
    expect(r).toEqual({ ok: true, vlan: 10 });
    expect(normaliseForSvi(10, isTaggedFrame(f)).change).toBe('pop');
  });
});

describe('frames and SVI names', () => {
  it('frameVlanTag reads layers[1] only', () => {
    expect(frameVlanTag(frame(layer('ethernet', { type: 0x0800 }), layer('ipv4', {})))).toBeUndefined();
    expect(frameVlanTag(frame(layer('ethernet', { type: 0x8100 }), layer('dot1q', { vid: 20 })))).toBe(20);
    expect(frameVlanTag(frame(layer('ethernet', { type: 0x8100 }), layer('dot1q', { vid: 0 })))).toBe(0);
    expect(isTaggedFrame(frame(layer('ethernet', { type: 0x8100 }), layer('dot1q', { vid: 0 })))).toBe(true);
    expect(isTaggedFrame(frame(layer('ethernet', { type: 0x0806 }), layer('arp', {})))).toBe(false);
  });

  it('sviName and vlanOfSviName are inverse', () => {
    expect(sviName(10)).toBe('Vlan10');
    expect(vlanOfSviName('Vlan10')).toBe(10);
    expect(vlanOfSviName('Vlan4094')).toBe(4094);
    expect(vlanOfSviName('Vlan0')).toBeUndefined();
    expect(vlanOfSviName('Vlan4095')).toBeUndefined();
    expect(vlanOfSviName('Loopback0')).toBeUndefined();
    expect(vlanOfSviName('GigabitEthernet0/1')).toBeUndefined();
  });
});
