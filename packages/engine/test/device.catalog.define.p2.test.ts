/**
 * W1 catalog (ARCHITECTURE-P2 §7 W1, D2, D10, D11, D17): the P2 derivations of device/catalog/define.ts —
 * `subinterfaces`, the managed-switch Vlan and Port-channel families, `stpDefaultMode`, `profileConfig` and the two
 * new egress owners. They are made at build stage P2 ONLY, so every model and fixture defined at P0.5 or P1 is
 * byte-for-byte what it was (§9.1: `device.catalog.define.test.ts:136-152` stays green). No model data changes here:
 * the capabilities that switch the derivations on reach the catalog in W4 (wired) and W6 (wireless).
 */
import { describe, expect, it } from 'vitest';
import type { DeviceModel } from '../src/contracts/device.js';
import { SPEED_1G } from '../src/contracts/port.js';
import {
  DEFAULT_STP_MODE,
  MANAGED_SWITCH_VLAN_FAMILY,
  PORT_CHANNEL_FAMILY,
  ROLE_EGRESS_OWNER,
  SUBINTERFACE_MAX,
  defineModel,
  derivePortOwners,
  deriveProfileConfig,
  deriveStpDefaultMode,
  deriveSubinterfaces,
  withManagedSwitchFamilies,
  L3_SWITCH_VLAN_FAMILY,
  LOOPBACK_FAMILY,
  MANAGEMENT_VLAN_FAMILY,
  type ModelInput,
} from '../src/device/catalog/define.js';
import { ALL_MODEL_INPUTS, CATALOG_STAGE } from '../src/device/catalog/index.js';
import { NF_2911_INPUT, NF_C2960_INPUT, ethInput } from './device.catalog.p0-inputs.js';

/** The L2 access switch as W4 will declare it (capabilities only; the data edit belongs to W4). */
const MANAGED_SWITCH_INPUT: ModelInput = { ...NF_C2960_INPUT, capabilities: ['switching', 'managed-switch'], virtualFamilies: [MANAGEMENT_VLAN_FAMILY] };
const MULTILAYER_INPUT: ModelInput = {
  type: 'mlswitch.nft3650',
  model: 'NF-T3650',
  description: 'Multilayer switch of the P2 define tests',
  category: 'multilayer-switches',
  icon: 'mlswitch',
  capabilities: ['layer3-switch', 'managed-switch'],
  ports: [ethInput('GigabitEthernet1/0/1', SPEED_1G, true)],
};
/** The lightweight access point as W6 will declare it. */
const LIGHTWEIGHT_AP_INPUT: ModelInput = {
  type: 'ap.nftap-lw',
  model: 'NF-TAP-LW',
  description: 'Lightweight access point of the P2 define tests',
  category: 'wireless',
  icon: 'ap',
  capabilities: ['wifi-ap', 'lightweight-ap'],
  ports: [ethInput('GigabitEthernet0', SPEED_1G, true)],
};

const familiesOf = (m: DeviceModel): string[] => (m.virtualFamilies ?? []).map((f) => `${f.family}:${f.min}-${f.max}`);

describe('the P2 derivations are made at stage P2 only', () => {
  it('a model defined at P0.5 or P1 gains no P2 member', () => {
    for (const stage of ['P0.5', 'P1'] as const) {
      const sw = defineModel(MANAGED_SWITCH_INPUT, stage);
      const rt = defineModel(NF_2911_INPUT, stage);
      for (const m of [sw, rt]) {
        expect(m.subinterfaces).toBeUndefined();
        expect(m.profileConfig).toBeUndefined();
        expect(m.stpDefaultMode).toBeUndefined();
      }
      expect(familiesOf(sw)).toEqual(['Vlan:1-1']);
      expect(rt.virtualFamilies).toEqual([LOOPBACK_FAMILY]);
      expect(Object.keys(sw)).not.toContain('profileConfig');
    }
  });

  it('the live catalog (stage P1 until the W4 flip) carries no P2 member on any model', () => {
    expect(CATALOG_STAGE).toBe('P1');
    for (const input of ALL_MODEL_INPUTS) {
      const model = defineModel(input, CATALOG_STAGE);
      expect([model.type, model.subinterfaces, model.profileConfig, model.stpDefaultMode]).toEqual([model.type, undefined, undefined, undefined]);
    }
  });
});

describe('subinterfaces (D11)', () => {
  it('a routing model gets routed subinterfaces up to 65535', () => {
    expect(deriveSubinterfaces(['routing'])).toEqual({ roles: ['routed'], max: SUBINTERFACE_MAX });
    expect(deriveSubinterfaces(['switching'])).toBeUndefined();
    expect(defineModel(NF_2911_INPUT, 'P2').subinterfaces).toEqual({ roles: ['routed'], max: 65535 });
    expect(defineModel(MULTILAYER_INPUT, 'P2').subinterfaces).toEqual({ roles: ['routed'], max: 65535 });
    expect(defineModel(MANAGED_SWITCH_INPUT, 'P2').subinterfaces).toBeUndefined();
    // input wins
    expect(defineModel({ ...NF_2911_INPUT, subinterfaces: { roles: ['routed'], max: 100 } }, 'P2').subinterfaces).toEqual({ roles: ['routed'], max: 100 });
  });
});

describe('managed-switch families (D10, §9.2 W4 item 15)', () => {
  it('widens the Vlan family to 1–4094 and adds Port-channel right after it', () => {
    const sw = defineModel(MANAGED_SWITCH_INPUT, 'P2');
    expect(familiesOf(sw)).toEqual(['Vlan:1-4094', 'Port-channel:1-48']);
    expect(sw.virtualFamilies?.[0]).toMatchObject({ family: 'Vlan', short: 'Vl', role: 'svi', defaultAdminUp: false, auto: [1] });
    expect(sw.virtualFamilies?.[1]).toEqual(PORT_CHANNEL_FAMILY);
    expect(MANAGED_SWITCH_VLAN_FAMILY.max).toBe(4094);

    // a multilayer switch already has the wide Vlan family; Port-channel goes between Vlan and Loopback
    expect(familiesOf(defineModel(MULTILAYER_INPUT, 'P2'))).toEqual(['Vlan:1-4094', 'Port-channel:1-48', 'Loopback:0-2147483647']);
    // models without the capability are untouched, in every stage
    expect(familiesOf(defineModel(NF_2911_INPUT, 'P2'))).toEqual(['Loopback:0-2147483647']);
    expect(familiesOf(defineModel(NF_C2960_INPUT, 'P2'))).toEqual([]);
  });

  it('withManagedSwitchFamilies is idempotent and keeps the other members of the Vlan family', () => {
    const once = withManagedSwitchFamilies(['managed-switch'], [MANAGEMENT_VLAN_FAMILY, LOOPBACK_FAMILY]);
    expect(withManagedSwitchFamilies(['managed-switch'], once)).toEqual(once);
    expect(once[0]).toEqual({ ...MANAGEMENT_VLAN_FAMILY, max: 4094 });
    expect(withManagedSwitchFamilies(['managed-switch'], [])).toEqual([MANAGED_SWITCH_VLAN_FAMILY, PORT_CHANNEL_FAMILY]);
    expect(withManagedSwitchFamilies(['switching'], [MANAGEMENT_VLAN_FAMILY])).toEqual([MANAGEMENT_VLAN_FAMILY]);
    expect(withManagedSwitchFamilies(['managed-switch'], [L3_SWITCH_VLAN_FAMILY])[0]).toEqual(L3_SWITCH_VLAN_FAMILY);
  });
});

describe('profileConfig and stpDefaultMode (D2, §4.4)', () => {
  it('a managed switch replays its spanning-tree lines in a P2 world, a multilayer switch also `no ip routing`', () => {
    const sw = defineModel(MANAGED_SWITCH_INPUT, 'P2');
    expect(sw.stpDefaultMode).toBe('pvst');
    expect(sw.profileConfig).toEqual({ P2: ['spanning-tree mode pvst', 'spanning-tree extend system-id'] });
    const ml = defineModel(MULTILAYER_INPUT, 'P2');
    expect(ml.profileConfig).toEqual({ P2: ['spanning-tree mode pvst', 'spanning-tree extend system-id', 'no ip routing'] });
    // the model data may name another default mode (NF-C9300: rapid-pvst)
    const rapid = defineModel({ ...MANAGED_SWITCH_INPUT, stpDefaultMode: 'rapid-pvst' }, 'P2');
    expect(rapid.stpDefaultMode).toBe('rapid-pvst');
    expect(rapid.profileConfig?.P2?.[0]).toBe('spanning-tree mode rapid-pvst');
    expect(DEFAULT_STP_MODE).toBe('pvst');
    expect(deriveStpDefaultMode(['switching'])).toBeUndefined();
  });

  it('a lightweight access point joins its controller in a P2 world only', () => {
    const ap = defineModel(LIGHTWEIGHT_AP_INPUT, 'P2');
    expect(ap.profileConfig).toEqual({ P2: ['capwap enable', 'interface Vlan1', ' ip address dhcp', ' no shutdown'] });
    expect(ap.stpDefaultMode).toBeUndefined();
    expect(defineModel(LIGHTWEIGHT_AP_INPUT, 'P1').profileConfig).toBeUndefined();
    // an autonomous access point keeps nothing
    expect(defineModel({ ...LIGHTWEIGHT_AP_INPUT, capabilities: ['wifi-ap'] }, 'P2').profileConfig).toBeUndefined();
  });

  it('deriveProfileConfig is pure and the input may replace it', () => {
    expect(deriveProfileConfig(['routing'], undefined)).toBeUndefined();
    expect(deriveProfileConfig(['managed-switch'], 'rapid-pvst')).toEqual({ P2: ['spanning-tree mode rapid-pvst', 'spanning-tree extend system-id'] });
    const custom = defineModel({ ...MANAGED_SWITCH_INPUT, profileConfig: { P2: ['spanning-tree mode pvst'] } }, 'P2');
    expect(custom.profileConfig).toEqual({ P2: ['spanning-tree mode pvst'] });
    // the stored lists are copies of the input (deep-frozen output, structured-clone safe)
    expect(Object.isFrozen(custom.profileConfig?.P2)).toBe(true);
  });
});

describe('egress owners of the new roles (D10, D17)', () => {
  it('ROLE_EGRESS_OWNER names etherchannel for a Port-channel and capwap-ac for the controller tunnel', () => {
    expect(ROLE_EGRESS_OWNER).toEqual({ svi: 'eth-switch', channel: 'etherchannel', 'wlan-tunnel': 'capwap-ac' });
  });

  it('a Port-channel family takes its owner once the model runs etherchannel (W4)', () => {
    const sw = defineModel(MANAGED_SWITCH_INPUT, 'P2');
    // before the W4 CAPABILITY_PROCESSES rows exist the daemon is not in `processes`, so no owner is derived
    expect(sw.portOwners).toEqual({ svi: 'eth-switch' });
    expect(derivePortOwners(sw.ports, sw.virtualFamilies ?? [], ['eth-switch', 'vlan', 'dtp', 'etherchannel', 'stp'])).toEqual({
      svi: 'eth-switch',
      channel: 'etherchannel',
    });
  });
});
