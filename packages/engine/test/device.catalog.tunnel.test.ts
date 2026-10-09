/**
 * device.catalog.tunnel — [S18] the tunnel family and its owner in the catalog (ARCHITECTURE-P3 D17, §2.1; §7 W1
 * catalog): at stage P3 every routing model that is not a home router derives `TUNNEL_FAMILY` (last among its
 * families), home routers and non-routing models do not, and no model does at an earlier stage; the `tunnel` role's
 * egress owner is `gre` (`roleEgressOwner`), derived onto a model only when it runs `gre`; validation knows the family.
 */
import { describe, expect, it } from 'vitest';
import { BUILD_STAGES, ROLE_TRAITS, ROLE_KINDS } from '../src/contracts/catalog.js';
import { ALL_MODEL_INPUTS, ALL_MODULES } from '../src/device/catalog.js';
import {
  LOOPBACK_FAMILY,
  P3_ROLE_EGRESS_OWNER,
  ROLE_EGRESS_OWNER,
  TUNNEL_FAMILY,
  defineModel,
  derivePortOwners,
  deriveTables,
  roleEgressOwner,
  withTunnelFamily,
  type ModelInput,
} from '../src/device/catalog/define.js';
import { resolvePortName } from '../src/device/catalog/names.js';
import { validateCatalog } from '../src/device/catalog/validate.js';

const input = (type: string): ModelInput => {
  const found = ALL_MODEL_INPUTS.find((i) => i.type === type);
  if (found === undefined) throw new Error(`no input ${type}`);
  return found;
};

describe('TUNNEL_FAMILY ([S18])', () => {
  it('is the Tunnel family: short Tu, role tunnel, encapsulation tunnel, created up, no automatic instance', () => {
    expect(TUNNEL_FAMILY).toEqual({ family: 'Tunnel', short: 'Tu', role: 'tunnel', min: 0, max: 2147483647, defaultAdminUp: true, encap: 'tunnel' });
    expect(Object.isFrozen(TUNNEL_FAMILY)).toBe(true);
    // the role traits the family relies on (the W0 contract)
    expect(ROLE_TRAITS.tunnel).toEqual({ frames: true, bridged: false, hairpin: false, l3: true, linkable: false, configurable: true, virtual: true, egress: 'owner', wiring: null, label: 'Tunnel interface' });
    expect(ROLE_KINDS.tunnel).toEqual(['virtual']);
  });

  it('routing models derive it at stage P3, last; home routers and non-routing models do not', () => {
    const nf2911 = defineModel(input('router.nf2911'), 'P3');
    expect(nf2911.virtualFamilies).toEqual([LOOPBACK_FAMILY, TUNNEL_FAMILY]);
    const ml = defineModel(input('mlswitch.nfc3650-24'), 'P3');
    expect(ml.virtualFamilies.map((f) => f.family)).toEqual(['Vlan', 'Port-channel', 'Loopback', 'Tunnel']);
    for (const i of ALL_MODEL_INPUTS) {
      const m = defineModel(i, 'P3');
      const routes = m.capabilities.includes('routing') && !m.capabilities.includes('nat-gateway');
      expect([i.type, m.virtualFamilies.filter((f) => f.family === 'Tunnel').length]).toEqual([i.type, routes ? 1 : 0]);
      if (routes) expect([i.type, m.virtualFamilies.at(-1)]).toEqual([i.type, TUNNEL_FAMILY]);
    }
    for (const type of ['wrouter.nfhome', 'wrouter.nfhome-ax', 'switch.nfc2960', 'pc.nfpc', 'wlc.nfwlc9800']) {
      expect([type, defineModel(input(type), 'P3').virtualFamilies.some((f) => f.family === 'Tunnel')]).toEqual([type, false]);
    }
  });

  it('no model derives it before stage P3 (every earlier-stage family list is unchanged)', () => {
    for (const i of ALL_MODEL_INPUTS) {
      for (const stage of BUILD_STAGES.filter((s) => s !== 'P3')) {
        const fams = defineModel(i, stage).virtualFamilies.map((f) => f.family);
        expect([i.type, stage, fams.includes('Tunnel')]).toEqual([i.type, stage, false]);
      }
      // at P3 the families are the P2 list plus, for routing models, the Tunnel family
      const p2 = defineModel(i, 'P2').virtualFamilies;
      const p3 = defineModel(i, 'P3').virtualFamilies;
      expect([i.type, p3.filter((f) => f.family !== 'Tunnel')]).toEqual([i.type, p2]);
    }
  });

  it('withTunnelFamily is idempotent and leaves other models alone', () => {
    const once = withTunnelFamily(['routing'], [LOOPBACK_FAMILY]);
    expect(once).toEqual([LOOPBACK_FAMILY, TUNNEL_FAMILY]);
    expect(withTunnelFamily(['routing'], once)).toBe(once);
    const home: readonly (typeof LOOPBACK_FAMILY)[] = [];
    expect(withTunnelFamily(['routing', 'nat-gateway'], home)).toBe(home);
    expect(withTunnelFamily(['switching'], home)).toBe(home);
  });

  it('a typed Tunnel name resolves against the family as a creatable virtual interface', () => {
    const m = defineModel(input('router.nf2911'), 'P3');
    const source = { model: m, ports: new Map() };
    expect(resolvePortName(source, 'tunnel 0')).toEqual({ kind: 'virtual', port: 'Tunnel0', family: 'Tunnel' });
    expect(resolvePortName(source, 'Tu12')).toEqual({ kind: 'virtual', port: 'Tunnel12', family: 'Tunnel' });
    expect(resolvePortName({ model: defineModel(input('router.nf2911'), 'P2'), ports: new Map() }, 'tunnel 0')).toEqual({ kind: 'unknown' });
  });
});

describe("the tunnel role's egress owner ([S18])", () => {
  it('is gre; the P2 record is unchanged', () => {
    expect(roleEgressOwner('tunnel')).toBe('gre');
    expect(P3_ROLE_EGRESS_OWNER).toEqual({ tunnel: 'gre' });
    expect(ROLE_EGRESS_OWNER).toEqual({ svi: 'eth-switch', channel: 'etherchannel', 'wlan-tunnel': 'capwap-ac' });
    expect(roleEgressOwner('svi')).toBe('eth-switch');
    expect(roleEgressOwner('channel')).toBe('etherchannel');
    expect(roleEgressOwner('wlan-tunnel')).toBe('capwap-ac');
    expect(roleEgressOwner('routed')).toBeUndefined();
  });

  it('a model derives the owner only when it runs gre', () => {
    const m = defineModel(input('router.nf2911'), 'P3');
    // ARCHITECTURE-P3 §9.2 W4 (the catalog flip; before it no capability row brought gre and the real derivation had
    // no tunnel owner): the routing row brings gre since the flip, so the derivation has the owner; a daemon list
    // without gre still derives none
    expect(m.processes).toContain('gre');
    expect(m.portOwners.tunnel).toBe('gre');
    const withoutGre = m.processes.filter((p) => p !== 'gre');
    expect(derivePortOwners(m.ports, m.virtualFamilies, withoutGre).tunnel).toBeUndefined();
    expect(derivePortOwners(m.ports, m.virtualFamilies, withoutGre, ['gre']).tunnel).toBe('gre');
    expect(derivePortOwners(m.ports, m.virtualFamilies, [...m.processes, 'gre']).tunnel).toBe('gre');
    expect(derivePortOwners(m.ports, m.virtualFamilies, m.processes, ['gre']).tunnel).toBe('gre');
    // the P2-stage model has no tunnel role, so no owner either way
    const p2 = defineModel(input('router.nf2911'), 'P2');
    expect(derivePortOwners(p2.ports, p2.virtualFamilies, [...p2.processes, 'gre'])).not.toHaveProperty('tunnel');
  });

  it('validation accepts the Tunnel family (without gre only the missing gre owner remains; since the flip the model derives it)', () => {
    const m = defineModel(input('router.nf2911'), 'P3');
    // ARCHITECTURE-P3 §9.2 W4 (the catalog flip): the real P3 model derives gre and its owner, so it validates
    expect(validateCatalog([m], ALL_MODULES, { stage: 'P3' })).toEqual([]);
    // the pre-flip daemon list (no gre; its tables and owners derived from it): only the missing gre owner remains
    const processes = m.processes.filter((p) => p !== 'gre');
    const noGre = { ...m, processes, tables: deriveTables(processes, m.capabilities, 'P3'), portOwners: derivePortOwners(m.ports, m.virtualFamilies, processes) };
    const issues = validateCatalog([noGre], ALL_MODULES);
    expect(issues.filter((i) => i.code === 'bad-virtual-family')).toEqual([]);
    expect(issues.map((i) => [i.code, i.path])).toEqual([['bad-port-owner', 'portOwners.tunnel']]);
    // with gre on the model (as the W4 flip will derive it), the model validates
    const withGre = { ...m, processes: [...m.processes, 'gre'], portOwners: derivePortOwners(m.ports, m.virtualFamilies, [...m.processes, 'gre']) };
    expect(validateCatalog([withGre], ALL_MODULES, { stage: 'P3' }).filter((i) => i.code === 'bad-virtual-family' || i.code === 'bad-port-owner')).toEqual([]);
  });
});
